/* #salary: "Read a wage sheet" — the classifier's preview, on the page (WIRE).
   ═════════════════════════════════════════════════════════════════════════
   POST /api/wage-sheet/preview runs src/salary/sheet.js over an uploaded
   workbook and keeps nothing (test/wage_sheet_preview.test.mjs holds the
   route). This holds the panel that sends it: choose a file, press the
   button, and every tab is drawn as what the classifier recognised — family,
   where the table starts, period, company line, fleet, rows — or refused with
   its reason; a request refused outright (too large, not a workbook) shows
   that reason rather than an empty table; the reply's own "nothing was
   stored" sentence is on the page; and the old skin, held byte for byte by
   arkiv_classic_frozen, does not grow the panel.

   The answer the panel draws is the REAL classifier's: built here by running
   src/salary/preview.js over the same synthetic workbook the page uploads,
   wrapped as the route wraps it, and served at the route's address — so the
   shapes cannot drift from what the server sends. Synthetic data only.

   REVERSION, proved 2026-11-12: api/public/salary.js without the panel
   (the base file swapped in, restored byte for byte) — every check but the
   old-skin one fails. */
import { harness } from './arkiv_pages.mjs';
import { Workbook } from '../src/xlsx_write.js';
import { previewWorkbook } from '../src/salary/preview.js';

const { check, start, open, done } = harness('#salary — read a wage sheet');
await start();

const wb = new Workbook({ created: new Date('2026-11-12T08:00:00Z') });
const s = wb.sheet('Payslips');
s.text('Ecosine Transports LLC', 'title');
s.text('Salary for the month of November 2025');
for (let i = 0; i < 5; i++) s.blank();
s.header(['Emp. ID', 'Name', 'Net Pay']);
s.row(['D001', 'Driver Alpha', 1234.5]);
s.row(['TBA', 'Driver Bravo', 2345.5]);
const bytes = wb.toBuffer();
const NAME = "Egari Driver's Salary Sheet November 2025.xlsx";
/* As the route answers: the classifier's reading plus what it says about
   itself. The Egari-named file over an Ecosine company row is the measured
   conflict, so the one tab is refused. */
const answer = { written: false, stored: false, filename: NAME, byte_len: bytes.length, sha256: 'f'.repeat(64),
  note: 'Nothing was stored: this is the classifier alone. The workbook was read in memory and discarded, '
    + 'and no wage, person or verdict was written anywhere.',
  ...previewWorkbook(bytes, { filename: NAME }) };

const PANEL = '[data-panel="salary-sheet"]';
/* A page with no panel is a set of failed checks below, not a crash that
   hides them. */
const upload = async (page) => {
  try {
    await page.setInputFiles(`${PANEL} input[type=file]`, { name: NAME,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes }, { timeout: 5000 });
    await page.click(`${PANEL} button`, { timeout: 5000 });
    await page.waitForSelector(`${PANEL} table, ${PANEL} .note.bad`, { timeout: 20000 });
    return true;
  } catch { return false; }
};
const panelText = (page) => page.evaluate((sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ') || '', PANEL);

{
  const { ctx, page } = await open('arkiv', 'salary', { fixtures: { '/api/wage-sheet/preview': answer } });
  check('the panel is on #salary, its button waiting for a file', await page.$(PANEL) !== null
    && await page.$eval(`${PANEL} button`, (b) => b.disabled).catch(() => false));
  let sent = null;
  page.on('request', (r) => { if (r.url().includes('/api/wage-sheet/preview')) sent = { method: r.method(), url: r.url(), type: r.headers()['content-type'] }; });
  await upload(page);
  check('it sends the workbook raw, as xlsx, with the filename as evidence', sent?.method === 'POST'
    && /spreadsheetml\.sheet/.test(sent?.type || '') && new URL(sent.url).searchParams.get('filename') === NAME, JSON.stringify(sent));
  const t = await panelText(page);
  check('the tab, as the classifier read it: family, where the table starts, period, company',
    t.includes('Payslips') && t.includes('Ecosine payslip') && t.includes('row 8, “Emp. ID” in A')
    && t.includes('2025-11-01 to 2025-11-30') && t.includes('Ecosine Transports LLC'), t.slice(0, 400));
  check('the refusal is named, with the classifier’s reason', t.includes('the fleet signals disagree')
    && t.includes('refused'), t.slice(0, 600));
  check('the reply’s own sentence: nothing was stored', t.includes('Nothing was stored'));
  check('rows counted, the placeholder counted apart', /2 · 1 with no id/.test(t), t.match(/\d+ · \d+ with no id/)?.[0]);
  await ctx.close();
}
{
  const refused = { written: false, stored: false, ok: false, readable: false, sheets: [],
    refusals: ['this file could not be read as an .xlsx workbook: not a zip archive'] };
  const { ctx, page } = await open('arkiv', 'salary', { fixtures: { '/api/wage-sheet/preview': refused } });
  await upload(page);
  check('a file refused outright shows the reason, not an empty table',
    (await panelText(page)).includes('could not be read as an .xlsx workbook') && !(await page.$(`${PANEL} table`)));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'salary');
  check('the old skin does not grow the panel (held byte for byte)', !(await page.$(PANEL)));
  await ctx.close();
}

await done();
