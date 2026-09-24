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

await done();
