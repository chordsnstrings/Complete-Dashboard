/* The page phase, section "Money" — the ledger pages under the contract.
   ═══════════════════════════════════════════════════════════════════════════
   #import-sheet, #opening, #salary, #advances, #charging, #policy and
   #deposits: forms and registers first. The plan keeps every form, grid and
   register where the operator works it; the contract adds a 00 band, charts
   drawn from what the page already fetched, and a † band. Each page is
   checked for the contract's shape, its figures against the answer the page
   itself received, its absences with their true reasons, and the old skin
   still building the old page (byte for byte is
   test/arkiv_classic_frozen.test.mjs's job).

   Its own file, not test/arkiv_money.test.mjs, so a revert proof on one
   ledger page runs this and not every Money page. ONLY=<page> narrows it.

   Synthetic data only: the mock, and fixtures built here. */
import { harness, shape } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Arkiv page phase — the ledger pages');
await start();
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const want = (k) => !ONLY || ONLY.includes(k);

/* money() as the pages print it: two decimals, separators, always. */
const aed = (n) => `${Number(n) < 0 ? '−' : ''}AED ${Math.abs(Number(n)).toLocaleString('en-US',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, ' ').trim() || '', sel);

/* ══ #import-sheet ═══════════════════════════════════════════════════════ */
if (want('import-sheet')) {
  console.log('\n#import-sheet');
  const { ctx, page } = await open('arkiv', 'import-sheet');
  const idle = await txt(page, '[data-panel="import-review"] .import-idle');
  check('the empty "What it matched" says why it is empty', /^Nothing is read until a file is chosen/.test(idle), idle);
  await page.setInputFiles('[data-panel="import"] input[type="file"]',
    { name: 'sheet.csv', mimeType: 'text/csv', buffer: Buffer.from('name,type,amount,date\nNadia Omar Hassan,salik,120.00,2026-09-01\n') });
  await page.waitForTimeout(1200);
  check('…and the line goes the moment a file is chosen', !(await page.$('[data-panel="import-review"] .import-idle')));
  await ctx.close();
  const c = await open('classic', 'import-sheet');
  check('old skin: no such line', !(await c.page.$('.import-idle')));
  await c.ctx.close();
}

/* ══ #opening ════════════════════════════════════════════════════════════ */
const dubaiToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
if (want('opening')) {
  console.log('\n#opening');
  const { ctx, page, answer } = await open('arkiv', 'opening');
  const s = await shape(page);
  const ppl = answer('/api/ledger/people').people.filter((p) => p.name);
  const ex = answer('/api/ledger/exposure').people;
  const n = ppl.length;
  const stated = ex.filter((p) => p.owes?.cash_basis?.opening_on).length;
  const first = ex.map((p) => p.owes?.cash_taken_from).filter(Boolean).sort()[0];
  const r = await page.evaluate(() => ({
    head: [...document.querySelectorAll('[data-panel="opening-grid"] thead th')].map((t) => t.textContent.trim()),
    rows: [...document.querySelectorAll('[data-panel="opening-grid"] tbody tr')].map((tr) => tr.textContent.replace(/\s+/g, ' ').trim()),
    /* ONE ROW: every tile's top the same, and the form straight after the
       band. (Absolute "above the fold" depends on the credential banner the
       shell draws above every page — 332px on the mock — not on this page.) */
    tileTops: [...new Set([...document.querySelectorAll('#view .kpis.glance > .kpi')].map((k) => Math.round(k.getBoundingClientRect().top)))].length,
    gap: document.querySelector('[data-panel="opening"]').getBoundingClientRect().top
      - document.querySelector('#view .cband').getBoundingClientRect().bottom,
    charts: ['opening-first', 'opening-run', 'opening-exposure'].map((k) => !!document.querySelector(`[data-panel="${k}"] svg, [data-panel="${k}"] .hb`)),
  }));
  check('00 leads with ONE row of five tiles, and the form follows it directly',
    s.first === 'cband' && s.glance === 5 && r.tileTops === 1 && r.gap < 40, `${s.first} ${s.glance} ${r.tileTops} ${r.gap}`);
  check('Opening balances stated is the hero, counted from the exposure read over everyone the form offers',
    s.hero === 'Opening balances stated' && s.values['Opening balances stated'] === `${stated} of ${n}`, JSON.stringify(s.values));
  check('How far back a count reaches: from the first cash fare on record to today',
    s.values['How far back a count reaches'] === `${daysBetween(first, dubaiToday())} days` && s.subs['How far back a count reaches'].startsWith(`from ${first}`),
    JSON.stringify([s.values['How far back a count reaches'], first]));
  check('with no cash fare among the people still to count, the ceiling tile is ABSENT and says who is not on the read',
    /not on it, so no cash fare has been measured for them/.test(s.na['Unstated, at its ceiling'] || ''), JSON.stringify(s.na));
  const tariq = ex.find((p) => p.owes?.cash_taken != null);
  check('the grid gains the cash-fare ceiling, beside what was stated', r.head.includes('Cash fares on record (ceiling)')
    && r.rows.some((t) => t.includes(aed(tariq.owes.cash_taken)) && t.includes(`since ${tariq.owes.cash_taken_from}`)), JSON.stringify(r.head));
  check('after the grid: first cash fare by month, how long cash has run, what exposure could judge', r.charts.every(Boolean), JSON.stringify(r.charts));
  const books = ex.filter((p) => p.owes && (p.owes.books_recorded ?? (p.owes.advance != null || p.owes.deduction != null))).length;
  check('the † band: the opening position, what each driver owes (as recorded, not as nought), the date per row',
    s.abs.length === 3 && s.abs[0].label === 'Opening positions unknown' && s.abs[0].fig === `${n - stated} of ${n}` && s.abs[1].fig === `${books} of ${n} recorded`
    && /nothing on the advance or deduction books/.test(s.abs[1].why) && s.abs[2].fig === 'Per row', JSON.stringify(s.abs));
  check('no sideways scroll at 1440', s.overflowX <= 0, String(s.overflowX));
  await ctx.close();
  const c = await open('classic', 'opening');
  const head = await c.page.evaluate(() => [...document.querySelectorAll('#view thead th')].map((t) => t.textContent.trim()));
  check('old skin: no 00 band, and the grid without the ceiling column', !(await c.page.$('#view .cband'))
    && !head.includes('Cash fares on record (ceiling)'), JSON.stringify(head));
  await c.ctx.close();
}

await done();
