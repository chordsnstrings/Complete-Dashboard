/* THE .xlsx WRITER — does what it writes open, and say what it was given?
   ═════════════════════════════════════════════════════════════════════════
   src/xlsx_write.js is read back two ways: by src/salary/xlsx.js, the reader
   this product already trusts with payslips, and — where the machine has it —
   by openpyxl, a reader nobody here wrote, so a file that only our own reader
   accepts cannot pass. Every value kind the money workbook writes is checked:
   money as a number with its format, a Dubai datetime as a real Excel date, a
   text "(withheld)" in a money column, markup and control characters in a
   driver's name, a leading "=", and the refusals by name.

   REVERSIONS, run 2026-09-28: drop the BAD_XML strip (the control-character
   check fails and openpyxl then refuses the file outright); count days from
   1900-01-01 instead of Excel's 1899-12-30 (4 fail — every date lands two
   days early); crc32 off by one bit (the CRC check fails and the reader
   refuses the zip). */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workbook, serialOf, colName, crc32 } from '../src/xlsx_write.js';
import { readWorkbook, sheetNamed } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\n1. the pieces');
check('column letters run A…Z, AA…', colName(0) === 'A' && colName(25) === 'Z' && colName(26) === 'AA' && colName(701) === 'ZZ' && colName(702) === 'AAA');
check('a Dubai day is its Excel day number', serialOf('2026-09-28') === 46293 && serialOf('1900-03-01') === 61);
check('…and a time of day is the fraction', serialOf('2026-09-28 18:00') === 46293.75);
check('a malformed date is not a date', serialOf('28/09/2026') === null && serialOf('') === null);
check('CRC-32 is the standard one', crc32(Buffer.from('123456789')) === 0xcbf43926);

console.log('\n2. a workbook, read back by this product’s own reader');
const wb = new Workbook({ created: new Date('2026-09-28T10:00:00Z') });
const r = wb.sheet('Read me', { widths: [30, 90] });
r.text('Cash — Ecosine & Egari — 2026-09-01 to 2026-09-28', 'title');
r.pair('Made', '2026-09-28 14:00', 'datetime');
r.pair('Note', 'A & B <tag> "quoted" — and a line\nbreak');
const t = wb.sheet('Cash to collect', { widths: [28, 12, 14, 14] });
t.text('One row per driver.', 'dim');
t.header(['Driver', 'Cash trips', 'To hand in (AED)', 'Last cash trip'], ['text', 'int', 'money', 'datetime']);
t.row(['Test Driver A', 12, 1234.5, '2026-09-27 23:59']);
t.row(['=HYPERLINK("http://example.test")', 3, '(withheld)', '2026-09-26 08:05']);
t.row(['Bad\u0001Name\u0008 \uD800', 1, 0.1 + 0.2, null]);
t.row([`${'x'.repeat(40000)}`, 0, -5, '2026-09-01']);
const buf = wb.toBuffer();
const back = readWorkbook(buf);
check('both sheets, in order, by name', back.sheetNames.join('|') === 'Read me|Cash to collect');
const rm = sheetNamed(back, 'Read me').rows;
check('prose comes back as written, markup included', rm[2][1] === 'A & B <tag> "quoted" — and a line\nbreak', JSON.stringify(rm[2]));
check('a Dubai datetime comes back as that wall-clock time', rm[1][1] instanceof Date && rm[1][1].toISOString() === '2026-09-28T14:00:00.000Z', String(rm[1][1]));
const rows = sheetNamed(back, 'Cash to collect').rows;
check('the header is row 2, under the note', rows[1].join('|') === 'Driver|Cash trips|To hand in (AED)|Last cash trip');
check('money is a NUMBER, not text', rows[2][2] === 1234.5 && rows[2][1] === 12);
check('a withheld value is text in the money column', rows[3][2] === '(withheld)');
check('a leading "=" is kept as text, never a formula', rows[3][0] === '=HYPERLINK("http://example.test")');
check('characters XML cannot carry are dropped, the rest kept', rows[4][0] === 'BadName ', JSON.stringify(rows[4][0]));
check('an empty value is an empty cell, not a nought', rows[4][3] === null);
check('text over Excel’s cell limit is cut and marked', rows[5][0].length === 32767 && rows[5][0].endsWith('…'));
check('a negative and a zero survive', rows[5][2] === -5 && rows[5][1] === 0);

const files = back.file;
const sheet2 = files.get('xl/worksheets/sheet2.xml').toString('utf8');
check('the header row is frozen on screen', /<pane ySplit="2" topLeftCell="A3"[^>]*state="frozen"/.test(sheet2));
check('the table carries filter arrows over every row', /<autoFilter ref="A2:D6"\/>/.test(sheet2));
check('…declared the way Excel expects', /_xlnm\._FilterDatabase" localSheetId="1" hidden="1">'Cash to collect'!\$A\$2:\$D\$6</.test(files.get('xl/workbook.xml').toString('utf8')));
check('money cells carry the #,##0.00 format', /<c r="C3" s="2"><v>1234.5<\/v>/.test(sheet2) && /formatCode="#,##0\.00"/.test(files.get('xl/styles.xml').toString('utf8')));
check('no formula anywhere in the file', ![...files.values()].some((b) => /<f[ >]/.test(b.toString('utf8'))));

console.log('\n3. the refusals, by name');
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const w2 = new Workbook();
check('a sheet name with a slash is refused', throws(() => w2.sheet('Cash/day'), /not a sheet name/));
check('a sheet name over 31 characters is refused', throws(() => w2.sheet('x'.repeat(32)), /not a sheet name/));
w2.sheet('Trips');
check('two sheets with one name are refused', throws(() => w2.sheet('trips'), /two sheets/));
check('an empty workbook is refused', throws(() => new Workbook().toBuffer(), /at least one sheet/));

console.log('\n4. a reader nobody here wrote');
let py = null;
try { execFileSync('python3', ['-c', 'import openpyxl'], { stdio: 'ignore' }); py = 'python3'; } catch { /* not on this machine */ }
if (!py) {
  console.log('  – openpyxl is not installed here; the second reader is skipped');
} else {
  const dir = mkdtempSync(join(tmpdir(), 'xlsx-'));
  const f = join(dir, 'w.xlsx');
  writeFileSync(f, buf);
  const out = execFileSync(py, ['-c', `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
s = wb['Cash to collect']
print(json.dumps({
  'names': wb.sheetnames,
  'c3': s['C3'].value, 'fmt': s['C3'].number_format,
  'd3': str(s['D3'].value), 'dfmt': s['D3'].number_format,
  'a4': s['A4'].value, 'a4type': s['A4'].data_type,
  'freeze': s.freeze_panes, 'filter': s.auto_filter.ref,
}))`, f], { encoding: 'utf8' });
  const o = JSON.parse(out);
  check('openpyxl opens it, both sheets', o.names.join('|') === 'Read me|Cash to collect');
  check('…reads the money as 1234.5 with its format', o.c3 === 1234.5 && o.fmt === '#,##0.00');
  check('…reads the datetime as a datetime', o.d3 === '2026-09-27 23:59:00' && o.dfmt === 'yyyy-mm-dd hh:mm', o.d3);
  check('…reads the "=" cell as text, not a formula', o.a4 === '=HYPERLINK("http://example.test")' && o.a4type === 's', o.a4type);
  check('…sees the frozen header and the filter', o.freeze === 'A3' && o.filter === 'A2:D6', `${o.freeze} ${o.filter}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
