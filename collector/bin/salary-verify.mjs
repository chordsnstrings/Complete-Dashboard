#!/usr/bin/env node
/* Read every workbook under a directory with src/salary/xlsx.js and report.
   ─────────────────────────────────────────────────────────────────────────
   The salary corpus is driver payroll — names, Emirates IDs, wages — so it
   cannot enter the repository and test/salary_xlsx.test.mjs therefore works
   on workbooks it synthesises. Those prove the reader against the traps we
   know about. This proves it against the files we actually have.

   It prints what was READ, not whether it was right: sheets found, rows and
   cells returned, and every file that could not be opened WITH ITS REASON.
   A file that fails here is the point of the exercise — a silent skip is how
   an import loses a month.

     node bin/salary-verify.mjs /path/to/corpus            # summary
     node bin/salary-verify.mjs /path/to/corpus --sheets   # per-tab detail

   NOTHING FROM THE CORPUS IS PRINTED except tab names and counts. Cell
   values are payroll and stay on disk. */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { readWorkbook } from '../src/salary/xlsx.js';

const root = process.argv[2];
const detail = process.argv.includes('--sheets');
if (!root) {
  console.error('usage: node bin/salary-verify.mjs <corpus-directory> [--sheets]');
  process.exit(2);
}

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

/* THE EXTENSION LIES, so the magic bytes decide. The corpus holds at least
   one real .xlsx named .xls ("Driver's Personal Cash Advances.xls"), which an
   extension check would skip and a genuine BIFF8 .xls, which this reader
   cannot open and must say so rather than appear to succeed. */
const KIND = (p) => {
  let head;
  try { const fd = readFileSync(p); head = fd.subarray(0, 4); } catch { return 'unreadable'; }
  if (head.length < 4) return 'other';
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return 'ole2';
  return 'other';
};

const files = walk(root).filter((p) => !p.split('/').pop().startsWith('~$'));
let read = 0; let refused = 0; let skipped = 0;
let sheets = 0; let rows = 0; let cells = 0;
const reasons = [];
const tabs = new Map();

for (const p of files) {
  const rel = relative(root, p);
  const kind = KIND(p);
  if (kind === 'ole2') {
    skipped += 1;
    reasons.push([rel, 'genuine BIFF8 .xls (OLE2) — this reader opens .xlsx only']);
    continue;
  }
  if (kind !== 'zip' || extname(p).toLowerCase() === '.zip') { skipped += 1; continue; }
  try {
    const wb = readWorkbook(p);
    read += 1;
    sheets += wb.sheets.length;
    for (const s of wb.sheets) {
      tabs.set(s.name.trim(), (tabs.get(s.name.trim()) || 0) + 1);
      const r = s.rows;
      rows += r.length;
      for (const row of r) for (const c of row) if (c !== null) cells += 1;
    }
    if (detail) console.log(`  ${rel}\n      ${wb.sheetNames.join(' | ')}`);
  } catch (e) {
    refused += 1;
    reasons.push([rel, e.message.split('\n')[0].slice(0, 160)]);
  }
}

console.log(`\nfiles seen        ${files.length}`);
console.log(`workbooks read    ${read}`);
console.log(`REFUSED           ${refused}   (a reader that cannot open a file says why)`);
console.log(`not a workbook    ${skipped}   (.zip, CSV, PDF, genuine .xls)`);
console.log(`sheets / rows / non-empty cells   ${sheets} / ${rows} / ${cells}`);
if (reasons.length) {
  console.log('\nevery file this reader would not open, and why:');
  for (const [rel, why] of reasons.slice(0, 40)) console.log(`  - ${rel}\n      ${why}`);
  if (reasons.length > 40) console.log(`  … and ${reasons.length - 40} more`);
}
const top = [...tabs].sort((a, b) => b[1] - a[1]).slice(0, 12);
console.log('\nthe tabs these workbooks carry:');
for (const [n, c] of top) console.log(`  ${String(c).padStart(5)}  ${n}`);
process.exit(refused ? 1 : 0);
