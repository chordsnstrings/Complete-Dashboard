/* THE WAGE-SHEET CLASSIFIER, wired in as a preview that keeps nothing (WIRE).
   ═════════════════════════════════════════════════════════════════════════
   src/salary/sheet.js decides which of five wage-sheet families a workbook
   tab is, finds its header row, period and company line, and refuses where
   the fleet signals disagree. It was written 2026-09-22 and imported by
   nothing. POST /api/wage-sheet/preview (api/wage_sheet_routes.js) runs it
   over an uploaded .xlsx and keeps nothing; the payslip import waits on the
   operator.

   What this holds:
     1. the classifier through the preview: a clean Ecosine payslip, a portal
        export, the Egari-named sheet with an Ecosine company row (refused, the
        measured case), a tab with no header, a hidden tab;
     2. the route: the answer, and that it carries no person — no name, no id,
        no amount — and that nothing is stored: mounted beside a query function
        and a transaction runner that record every call, it makes none;
     3. what one hostile file may cost: no body, not a workbook, over 4 MB
        (413), a zip bomb (refused by the unpacking cap while inflating), and a
        tab built to make the reader's regular expressions quadratic — stopped
        by the clock (504) while the API keeps answering, with a second upload
        refused (429) rather than queued behind it;
     4. the unpacking cap in the reader itself;
     5. the memory budget (review, 2026-11-12): the worker's heap plus the
        unpacking cap inside the ~93 MB the API leaves of 512 MB at its peak,
        and a tab ten times a real wage sheet still read inside them.

   FIXTURES ARE SYNTHESISED HERE (src/xlsx_write.js and hand-built zips):
   the real corpus is driver payroll and none of it may enter the repository.

   REVERSION, each proved 2026-11-12 by copying the file, undoing the change
   and restoring it byte for byte:
     · api/server.js without the mount       → §2 "mounts it" fails
     · src/salary/xlsx.js without maxBytes   → §3 "zip bomb" and §4 fail
     · the route reading in-thread, no worker → §3 "still answering",
       "429" and "clock" fail
     · src/salary/preview.js without the hidden-tab refusal → §1 fails
     · (review) LIMITS back to 160 + 32 MB and MAX_UNPACKED to 24 MB → §5's
       budget check fails */
import express from 'express';
import { readFileSync } from 'node:fs';
import { Workbook, zip } from '../src/xlsx_write.js';
import { readWorkbook } from '../src/salary/xlsx.js';
import { previewWorkbook } from '../src/salary/preview.js';
import { wageSheetRoutes, readInWorker, LIMITS } from '../api/wage_sheet_routes.js';
import { MAX_UNPACKED } from '../src/salary/preview.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── synthetic workbooks ─────────────────────────────────────────────────── */
const payslip = () => {
  const wb = new Workbook({ created: new Date('2026-11-12T08:00:00Z') });
  const s = wb.sheet('Payslips');
  s.text('Ecosine Transports LLC', 'title');
  s.text('Salary for the month of November 2025');
  for (let i = 0; i < 5; i++) s.blank();
  s.header(['Emp. ID', 'Name', 'Net Pay']);
  s.row(['D001', 'Driver Alpha', 1234.5]);
  s.row(['D002', 'Driver Bravo', 2345.5]);
  s.row(['TBA', 'Driver Charlie', 3456.5]);
  return wb.toBuffer();
};
/* The portal export: no company row, "Period" in row 3 with the range beside
   it, the header on row 7. */
const portal = () => {
  const wb = new Workbook({ created: new Date('2026-11-12T08:00:00Z') });
  const s = wb.sheet('Wages');
  s.blank(); s.blank();
  s.pair('Period', '01 November 2025 to 15 November 2025');
  s.blank(); s.blank(); s.blank();
  s.header(['Employee ID', 'Employee Name', 'Amount']);
  s.row(['EG018', 'Driver Delta', 900]);
  return wb.toBuffer();
};
const WB = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
const rels = (n) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
  Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`;
const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
/* Two tabs: a visible one with no id header at all, and a HIDDEN copy of a
   payslip tab — last month left in place. */
const tabs = () => zip([
  ['xl/workbook.xml', `${WB}<sheet name="Notes" sheetId="1" r:id="rId1"/><sheet name="October" sheetId="2" r:id="rId2" state="hidden"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', rels(2)],
  ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1">${cell('A1', 'Read me first')}</row></sheetData></worksheet>`],
  ['xl/worksheets/sheet2.xml', `<worksheet><sheetData><row r="1">${cell('A1', 'Ecosine Transports LLC')}</row>`
    + `<row r="2">${cell('A2', 'Salary for the month of October 2025')}</row>`
    + `<row r="9">${cell('A9', 'Emp. ID')}${cell('B9', 'Name')}</row><row r="10">${cell('A10', 'D001')}${cell('B10', 'Driver Echo')}</row>`
    + '</sheetData></worksheet>'],
]);
/* Thirty megabytes of zeros as one member: it deflates to about thirty KB. */
const bomb = () => zip([
  ['xl/workbook.xml', `${WB}<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', rels(1)],
  ['xl/worksheets/sheet1.xml', '<worksheet><sheetData/></worksheet>'],
  ['xl/media/big.bin', Buffer.alloc(30 * 1048576)],
]);
/* A tab of unclosed cell tags: the reader's cell pattern scans to the end of
   the document from every one of them. Forty thousand of them take seconds;
   the file is under 2 KB. */
const slow = (n = 40000) => zip([
  ['xl/workbook.xml', `${WB}<sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`],
  ['xl/_rels/workbook.xml.rels', rels(1)],
  ['xl/worksheets/sheet1.xml', `<worksheet><sheetData><row r="1">${'<c r="A1" '.repeat(n)}</row></sheetData></worksheet>`],
]);

console.log('\n1. the classifier, through the preview');
{
  const p = previewWorkbook(payslip(), { filename: 'Ecosine wages November 2025.xlsx' });
  const s = p.sheets?.[0] || {};
  check('a clean Ecosine payslip reads cleanly', p.readable && p.ok && s.ok, JSON.stringify(s.refusals));
  check('family, and the header row as Excel numbers it (row 8, the id in column A)',
    s.family === 'ecosine-payslip' && s.header_row === 8 && s.id_column === 'A' && s.name_column === 'B', JSON.stringify(s));
  check('the period, parsed: the whole of November 2025',
    s.period?.from === '2025-11-01' && s.period?.to === '2025-11-30' && s.period?.month === '2025-11' && s.period?.kind === 'month',
    JSON.stringify(s.period));
  check('the company line and the fleet, with every signal that said so',
    s.company === 'Ecosine Transports LLC' && s.fleet === 'ecosine' && s.fleet_basis === 'filename+company-row'
    && s.fleet_signals.length === 2, JSON.stringify([s.fleet, s.fleet_basis, s.fleet_signals]));
  check('rows counted, and the placeholder id ("TBA") counted apart, not named', s.rows === 3 && s.placeholder_rows === 1,
    JSON.stringify([s.rows, s.placeholder_rows]));
}
{
  const s = previewWorkbook(portal(), { filename: 'wages export.xlsx' }).sheets?.[0] || {};
  check('the portal export: no company row, header found on row 7, period from the cell beside "Period"',
    s.family === 'portal-wages' && s.header_row === 7 && s.period?.kind === 'range'
    && s.period?.from === '2025-11-01' && s.period?.to === '2025-11-15',
    JSON.stringify([s.family, s.header_row, s.period]));
  check('an EG id prefix is a fleet signal on its own', s.fleet === 'egari' && s.fleet_basis === 'id-prefix', JSON.stringify([s.fleet, s.fleet_basis]));
}
{
  const s = previewWorkbook(payslip(), { filename: "Egari Driver's Salary Sheet November 2025.xlsx" }).sheets?.[0] || {};
  check('the measured case: an "Egari" filename over an Ecosine company row is REFUSED, no fleet guessed',
    !s.ok && s.fleet === null && s.refusals.some((r) => /fleet signals disagree/.test(r)), JSON.stringify(s.refusals));
}
{
  const p = previewWorkbook(tabs(), { filename: 'Ecosine.xlsx' });
  const [notes, oct] = p.sheets || [];
  check('a tab with no id header is refused with the classifier\u2019s reason', notes && !notes.ok
    && /no header row/.test(notes.refusals[0] || ''), JSON.stringify(notes));
  check('a HIDDEN tab is refused, however cleanly it reads — last month left in place',
    oct && oct.state === 'hidden' && !oct.ok && oct.family === 'ecosine-payslip'
    && oct.refusals.some((r) => /tab is hidden/.test(r)), JSON.stringify(oct));
  check('one tab refused is not the workbook refused', p.readable === true && p.sheets.length === 2);
}

/* ── the route, on a bare app with spies for everything that could store ── */
const calls = [];
const spyQ = async (sql) => { calls.push(sql); return []; };
const spyTx = async (fn) => { calls.push('tx'); return fn(spyQ); };
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);
const mount = (opts = {}) => {
  const app = express();
  /* Exactly the dependency set test/mount.mjs hands every *_routes.js module,
     so a route that reached for q or tx would find one — and be caught. */
  wageSheetRoutes(app, { q: spyQ, tx: spyTx, wrap, ...opts });
  app.get('/ping', (_, res) => res.json({ ok: true }));
  /* The real server's refusal for an oversized body (api/server.js), so a
     413 is a JSON reason rather than Express's HTML. */
  app.use((err, _req, res, _next) => res.status(err?.status || 500).json({
    error: err?.type === 'entity.too.large' ? 'that file is larger than this route accepts' : 'internal' }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (bytes, qs = '', type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') => {
    const r = await fetch(`${base}/api/wage-sheet/preview${qs}`, { method: 'POST', headers: { 'content-type': type }, body: bytes });
    let body = null;
    try { body = await r.json(); } catch { /* not json */ }
    return { status: r.status, body };
  };
  return { srv, base, post };
};

console.log('\n2. the route: the answer, no person in it, nothing stored');
{
  /* Wired in production, and handed nothing that could write. */
  const src = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
  check('api/server.js imports the route module and mounts it', /import \{ wageSheetRoutes \} from '\.\/wage_sheet_routes\.js';/.test(src)
    && /^wageSheetRoutes\(app, /m.test(src));
  check('…handing it wrap and nothing else — no query function, no transaction runner',
    /^wageSheetRoutes\(app, \{ wrap \}\);$/m.test(src), (src.match(/^wageSheetRoutes\(.*$/m) || ['(not mounted)'])[0]);
}
{
  const { srv, post } = mount();
  const r = await post(payslip(), '?filename=' + encodeURIComponent('C:\\payroll\\Ecosine wages November 2025.xlsx'));
  check('200, read, and said to be neither written nor stored', r.status === 200 && r.body?.ok === true
    && r.body.written === false && r.body.stored === false && /Nothing was stored/.test(r.body.note || ''), JSON.stringify(r.body).slice(0, 200));
  check('the classifier\u2019s reading of the tab arrives', r.body?.sheets?.[0]?.family === 'ecosine-payslip'
    && r.body.sheets[0].header_row === 8);
  check('the filename is evidence only — its last segment, never a path', r.body?.filename === 'Ecosine wages November 2025.xlsx',
    r.body?.filename);
  check('the bytes are identified (sha256, length) so a later import can say it is the same file',
    /^[0-9a-f]{64}$/.test(r.body?.sha256 || '') && r.body.byte_len > 0);
  const text = JSON.stringify(r.body);
  check('NO PERSON in the answer: no name, no driver id, no amount',
    !/Driver Alpha|Driver Bravo|Driver Charlie|D001|D002|1234\.5|2345\.5|3456\.5/.test(text), text.slice(0, 300));
  check('and nothing touched a database: no query, no transaction, across every request above', calls.length === 0,
    JSON.stringify(calls).slice(0, 200));
  srv.close();
}

console.log('\n3. what one hostile file may cost');
{
  const { srv, post } = mount();
  const empty = await post(Buffer.alloc(0));
  check('no body: 400, with what to send', empty.status === 400 && /no workbook arrived/.test(empty.body?.refusals?.[0] || ''),
    JSON.stringify(empty.body));
  const notZip = await post(Buffer.from('Emp. ID,Name\nD001,Someone\n'));
  check('not a workbook (a CSV renamed): 400, the reader\u2019s reason, readable false',
    notZip.status === 400 && notZip.body?.readable === false && /could not be read as an \.xlsx workbook/.test(notZip.body?.refusals?.[0] || ''),
    JSON.stringify(notZip.body).slice(0, 200));
  const big = await post(Buffer.alloc(5 * 1048576, 1));
  check('over 4 MB: 413, before anything is read', big.status === 413, String(big.status));
  const b = bomb();
  const zb = await post(b);
  check(`a zip bomb (${Math.round(b.length / 1024)} KB that unpacks to 30 MB) is refused by the unpacking cap`,
    zb.status === 400 && /unpacks to more than 8 MB/.test(zb.body?.refusals?.[0] || ''), JSON.stringify(zb.body).slice(0, 240));
  check('and nothing touched a database here either', calls.length === 0);
  srv.close();
}
{
  /* The clock, at 1.5 s so the suite does not wait 15. */
  const { srv, base, post } = mount({ timeoutMs: 1500 });
  const t0 = Date.now();
  const running = post(slow());
  await new Promise((r) => setTimeout(r, 300));
  const ping = await (await fetch(`${base}/ping`)).json();
  /* Measured from the START of the hostile upload: the server and this
     client share one event loop, so a read that blocked it would hold the
     ping (and this timer) until it finished — seconds, not 300 ms. */
  const pingAt = Date.now() - t0;
  const second = await post(payslip());
  const r = await running;
  const took = Date.now() - t0;
  check(`the API still answers while the hostile tab is being read (${pingAt} ms after it arrived)`,
    ping.ok === true && pingAt < 1400, String(pingAt));
  check('a second upload meanwhile is refused (429), not queued behind it', second.status === 429
    && /one at a time/.test(second.body?.refusals?.[0] || ''), JSON.stringify(second.body));
  check(`the clock stops it: 504 with the reason (${took} ms)`, r.status === 504 && /took longer than 2 seconds/.test(r.body?.refusals?.[0] || '')
    && r.body.written === false, JSON.stringify(r.body).slice(0, 200));
  const after = await post(payslip());
  check('and the next upload is read as usual', after.status === 200 && after.body?.ok === true, String(after.status));
  srv.close();
}

console.log('\n4. the unpacking cap, in the reader');
{
  let threw = null;
  try { readWorkbook(bomb(), { maxBytes: 1048576 }); } catch (e) { threw = e.message; }
  check('readWorkbook refuses past maxBytes, while inflating', /unpacks to more than 1 MB/.test(threw || ''), threw);
  let fine = null;
  try { fine = readWorkbook(payslip(), { maxBytes: 1048576 }).sheets.length; } catch (e) { fine = e.message; }
  check('a real workbook under the cap reads as before', fine === 1, String(fine));
  let open = null;
  try { open = readWorkbook(bomb()).sheets.length; } catch (e) { open = e.message; }
  check('and with no cap (the corpus tools, the HR import) nothing changes', open === 1, String(open));
}

/* §5 THE MEMORY BUDGET (review, 2026-11-12). The worker lives in the API's
   container, and the API alone peaked at 81.9% of 512 MB over 14 days — 93 MB
   of headroom. The first draft allowed 160 MB of old generation, 32 of young
   and a 24 MB unpacking cap, so one upload (anonymous, while sign-in is
   optional) could take the container past its limit and restart the API.
   Reverted to those numbers, the first check fails; the second proves the
   tighter limits still read ten times a real wage sheet. */
console.log('\n5. the memory budget, against what the API leaves of 512 MB');
{
  const heapMb = LIMITS.maxOldGenerationSizeMb + LIMITS.maxYoungGenerationSizeMb;
  const unpackMb = MAX_UNPACKED / 1048576;
  check(`the worker's heap plus the unpacking cap stays inside the API's 93 MB of headroom (${heapMb} + ${unpackMb} MB)`,
    heapMb + unpackMb <= 70, JSON.stringify({ LIMITS, unpackMb }));
  /* A tab of 5,000 rows × 30 columns — ten times a real wage sheet — under
     the real limits, through the real worker. */
  const wb = new Workbook({ created: new Date('2026-11-12T08:00:00Z') });
  const s = wb.sheet('Payslips');
  s.text('Ecosine Transports LLC', 'title');
  s.text('Salary for the month of November 2025');
  for (let i = 0; i < 5; i++) s.blank();
  s.header(['Emp. ID', 'Name', ...Array.from({ length: 28 }, (_, i) => `Col ${i}`)]);
  for (let r = 0; r < 5000; r++) {
    s.row([`D${r}`, `Driver number ${r}`, ...Array.from({ length: 28 }, (_, i) => (i % 3 ? r * i + 0.5 : `text ${r} ${i}`))]);
  }
  const out = await readInWorker(wb.toBuffer(), { filename: 'Ecosine wages November 2025.xlsx' });
  check('…and a 5,000-row tab, ten times a real one, still reads inside them', out.result?.ok === true
    && out.result.sheets?.[0]?.rows === 5000,
  JSON.stringify(out.timedOut ? 'timed out' : out.error ? String(out.error.code || out.error.message) : out.result?.refusals));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
