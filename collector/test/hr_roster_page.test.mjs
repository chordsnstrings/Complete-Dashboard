/* #hr-roster IN A REAL BROWSER — and the three pages it touches.
   ─────────────────────────────────────────────────────────────────────────
   Against the mock (mockapi.mjs), whose HR fixture dates are offsets from
   today so every status the page draws is present on every run. Checked:

     the roster      one row per person, each document with its expiry, a
                     status and "number on file" — never a number; HR's
                     status labelled as HR's; "off the HR list since"; the
                     matched accounts linking to the existing driver page;
                     the fleet filter and "anything expiring" actually filter
     the import      a synthetic workbook chosen, previewed, committed, and the
                     upload history grows; a wrong workbook is refused with its
                     reason and cannot be committed; a filename with no date
                     asks for one
     #compliance     HR's documents column, HR's date marked where it leads,
                     the platform's date kept beside it as a disagreement
     #same-person    an HR proposal marked as HR's, with the contradiction
     #driver         the Emirates ID number, the licence number and HR's
                     licence expiry — the one page that shows them

   reducedMotion 'reduce', because every .kpi figure counts up over 620ms and
   an assertion made mid-animation reads a number that was never in the data
   (docs/COVERAGE.md). Every workbook is synthetic. */
import { launchChromium } from './browser.mjs';
import { app } from '../mockapi.mjs';
import { hrExport, person } from './hr_workbook.mjs';
import { HR_HEADERS } from '../src/hr_roster.js';
import { dubaiDay } from '../api/window.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
const text = (sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

console.log('\nthe roster');
await page.goto(`${base}/#hr-roster`, { waitUntil: 'networkidle' });
const rendered = await page.waitForSelector('[data-panel="hr-roster"] table', { timeout: 20000 })
  .then(() => true).catch(() => false);
check('#hr-roster renders its roster table', rendered);
if (!rendered) {
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); srv.close(); process.exit(1);
}
{
  const onList = await text('[data-kpi="hr-on-list"]');
  check('the headline counts the people on the latest export', /\b6\b/.test(onList), onList.replace(/\n/g, ' | '));
  const off = await text('[data-kpi="hr-off-list"]');
  check('…and the people a newer export dropped, separately', /\b1\b/.test(off), off.replace(/\n/g, ' | '));
  const roster = await text('[data-panel="hr-roster"]');
  for (const s of ['expired', '≤30 days', '≤45 days', '≤90 days', 'ok', 'missing']) {
    check(`a document can read "${s}"`, roster.toLowerCase().includes(s.toLowerCase()));
  }
  check('each document says whether a number is on file', /number on file/.test(roster));
  check('…and the visa says its number is not kept', /number not kept/.test(roster));
  check('no document NUMBER is on the page', !/PZ9Q|DL55\d|RT77|784-\d{4}-\d{7}-\d/.test(roster));
  check('HR’s status is labelled as HR’s', /HR: Compliant/i.test(roster) && /HR: Pending/i.test(roster));
  check('someone dropped by a newer export reads "off the HR list since"', /off the HR list since/i.test(roster));
  check('a date carried from an earlier export says so', /from the .* export/.test(roster));
  check('an HR id that cannot be matched says so', /id not held/i.test(roster));
  const links = await page.$$eval('[data-panel="hr-roster"] a[href^="#driver/"]', (as) => as.map((a) => a.getAttribute('href')));
  check('matched accounts open the existing driver page, by person', links.some((h) => h.startsWith('#driver/p401')), links.slice(0, 6).join(' '));
  const rows = async () => page.$$eval('[data-hr="roster-table"] tbody tr', (trs) => trs.length);
  const all = await rows();
  check('every person is a row', all === 7, String(all));
  await page.selectOption('[data-panel="hr-roster"] .filters select', 'egari');
  const eg = await rows();
  const egText = await text('[data-hr="roster-table"]');
  check('the fleet filter narrows to one fleet', eg === 3 && !/Ecosine/.test(egText), `${eg} rows`);
  await page.selectOption('[data-panel="hr-roster"] .filters select', '');
  await page.click('[data-panel="hr-roster"] .filters button[data-filter="expiring"]');
  const ex = await rows();
  check('"anything expiring" keeps only people with a document expired or due', ex === 4, String(ex));
  const hist = await page.$$eval('[data-panel="hr-uploads"] tbody tr', (trs) => trs.length);
  check('the upload history lists each export', hist === 2, String(hist));
  check('the expiry table counts the people on the list per document',
    /Documents by how soon they expire/.test(await text('[data-panel="hr-expiry"]')));
}

console.log('\nthe import: preview, then commit on purpose');
{
  const good = hrExport([person(1), person(2, { fleet: 'egari' })]);
  await page.setInputFiles('[data-panel="hr-import"] input[type=file]',
    { name: `active-drivers-${dubaiDay(new Date())}.xlsx`, mimeType: XLSX, buffer: good });
  check('commit is not offered before a preview', await page.$eval('[data-panel="hr-import"] .btn.primary', (b) => b.disabled));
  await page.click('[data-panel="hr-import"] .btnrow .btn:not(.primary)');
  await page.waitForSelector('[data-kpi="hrp-rows"]', { timeout: 10000 });
  const pv = await text('[data-panel="hr-preview"]');
  check('the preview says how many rows it read', /Rows read\s*\n?\s*2\b/i.test(pv), pv.slice(0, 200).replace(/\n/g, ' | '));
  check('…the fleet split', /Ecosine 1 · Egari 1/.test(pv));
  check('…how they matched, and that nothing matches by name', /never matched by name/.test(pv));
  check('…the document expiry, per document', /Document expiry on this file/.test(pv));
  check('…the proposals, which are not merges', /none is a merge/.test(pv));
  check('…and the contradictions', /Where HR contradicts a link already held/.test(pv));
  check('commit is offered once the preview is clean', !(await page.$eval('[data-panel="hr-import"] .btn.primary', (b) => b.disabled)));
  await page.click('[data-panel="hr-import"] .btn.primary');
  check('committing without saying who is refused on the page', /Say who is uploading/.test(await text('[data-panel="hr-preview"]')));
  await page.fill('[data-panel="hr-import"] input[type=text]', 'Page Tester');
  await page.click('[data-panel="hr-import"] .btn.primary');
  await page.waitForSelector('[data-panel="hr-result"]', { timeout: 10000 });
  check('the commit reports what it wrote', /Written: upload \d+/.test(await text('[data-panel="hr-result"]')));
  await page.waitForFunction(() => document.querySelectorAll('[data-panel="hr-uploads"] tbody tr').length === 3, null, { timeout: 10000 }).catch(() => {});
  const hist = await page.$$eval('[data-panel="hr-uploads"] tbody tr', (trs) => trs.length);
  check('…and the upload history now has it', hist === 3, String(hist));

  const renamed = hrExport([person(3)], { headers: HR_HEADERS.map((h) => (h === 'Visa Expiry' ? 'Visa Expiration' : h)) });
  await page.setInputFiles('[data-panel="hr-import"] input[type=file]',
    { name: 'active-drivers-2026-09-01.xlsx', mimeType: XLSX, buffer: renamed });
  await page.click('[data-panel="hr-import"] .btnrow .btn:not(.primary)');
  await page.waitForSelector('.hr-refusals', { timeout: 10000 });
  const ref = await text('[data-panel="hr-preview"]');
  check('a workbook that is not the export is refused, with the column named',
    /cannot be imported/.test(ref) && /Visa Expiration/.test(ref) && /renamed/.test(ref), ref.slice(0, 300));
  check('…and cannot be committed', await page.$eval('[data-panel="hr-import"] .btn.primary', (b) => b.disabled));

  await page.setInputFiles('[data-panel="hr-import"] input[type=file]',
    { name: 'drivers.xlsx', mimeType: XLSX, buffer: hrExport([person(4)]) });
  check('a filename with no date shows the date field', await page.$eval('[data-panel="hr-import"] input[type=date]',
    (i) => !i.closest('.depfield').hidden));
}

console.log('\n#compliance shows HR’s documents, HR’s date first');
{
  await page.goto(`${base}/#compliance`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="compliance-people"] table', { timeout: 20000 });
  const t = await text('[data-panel="compliance-people"]');
  check('an HR documents column', /HR documents/i.test(t));
  check('…with each document and whether a number is on file', /Passport/i.test(t) && /RTA permit/i.test(t)
    && /number on file/i.test(t));
  check('HR’s date is marked where it leads', /HR’s date/.test(t));
  check('…and the platform’s different date is kept beside it', /Hotel says/i.test(t));
  check('a person on HR’s list with no account is not called an unplaced account', /on HR’s list only/.test(t));
  const body = await page.evaluate(() => document.body.innerText);
  check('the page says HR’s date is the one counted', /that date is the one this page counts/.test(body));
}

console.log('\n#same-person carries HR’s proposals and contradictions');
{
  await page.goto(`${base}/#same-person`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sp-hr', { timeout: 20000 });
  const card = await text('.sp-hr');
  check('an HR proposal is marked as HR’s, with the employee', /HR roster/i.test(card) && /employee\s+D101/i.test(card), card.slice(0, 200));
  check('…says a Yes merges nothing', /it merges nothing/.test(card));
  check('…and carries the contradiction', /HR’s roster contradicts this/.test(card));
  check('the contradictions are listed for the whole queue too', /Where HR’s roster contradicts a link already held/
    .test(await text('[data-panel="sp-hr-contra"]')));
}

console.log('\n#driver shows the Emirates ID, the licence number and HR’s licence expiry');
{
  await page.goto(`${base}/#driver/drv-0`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.idcard', { timeout: 20000 });
  const eid = await text('.idcard [data-hr="emirates_id"]');
  const lic = await text('.idcard [data-hr="licence_no"]');
  const exp = await text('.idcard [data-hr="licence_expires"]');
  check('the Emirates ID number, marked as HR’s', /784-1990-\d{7}-1/.test(eid) && /HR/.test(eid), eid);
  check('the UAE licence number', /DL55\d{5}/.test(lic), lic);
  check('HR’s licence expiry', /Licence expires/i.test(exp), exp);
  const card = await text('.idcard');
  check('the licence pill is HR’s, with the platform’s different date beside it', /· HR/i.test(card) && /Hotel says/i.test(card),
    card.slice(0, 300).replace(/\n/g, ' | '));
}

console.log('\nat phone width');
{
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const mp = await m.newPage();
  mp.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await mp.goto(`${base}/#hr-roster`, { waitUntil: 'networkidle' });
  await mp.waitForSelector('[data-panel="hr-roster"] table', { timeout: 20000 });
  const over = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('the page does not scroll sideways at 390px', over <= 1, `${over}px`);
  await m.close();
}

check('no page error anywhere', errs.length === 0, errs.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
await browser.close();
srv.close();
process.exit(fail ? 1 : 0);
