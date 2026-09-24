/* Ruling 2 — money to the fils, everywhere — read off the RENDERED page.
   ═══════════════════════════════════════════════════════════════════════════
   The production check of the first desktop batch (564d636) found two
   whole-dirham amounts on #finance in both skins — a worked example in a
   caption, "a 15% rate on AED 63 outranks a 6% rate on AED 506". The source
   had been read for money() calls; the caption was a string literal, so no
   source-level check could see it. A scan of the rendered text for "AED" and
   a number with no fils is what found it, and the same scan over every
   converted page found three more: #analyst printed an AED metric as
   fmt(v, 1) + " AED" ("116 AED" beside "59.8 AED"), and #unit's histogram
   captions said "in AED 50 bands" and "AED 250–300".

   So this is the scan, as a test: every page the page phase has converted,
   under the contract, against the mock — the visible text of #view and the
   page foot, every title attribute (a tooltip is page text) and every SVG
   <title> a chart carries. A match is "AED" followed by a number with no
   decimal part, or a compact k/M figure. #finance is also read in the old
   skin, because the caption is shared and the lead's ruling moved it there.

   Synthetic data only: the mock. ONLY=<route> narrows a run. */
import { harness } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Ruling 2 — money to the fils in the rendered text');
await start();
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

/* Every route the page phase has converted, in the plan's section order. */
const ROUTES = [
  // Today
  'action/idle_vehicle/L45235', 'insights', 'playbook', 'analyst', 'compare',
  // Money
  'revenue', 'unit', 'unit/assets', 'unit/drivers', 'corporate', 'charging', 'policy', 'deposits', 'salary', 'advances',
  'opening', 'import-sheet',
  // Finance
  'finance', 'receipts', 'payouts', 'reconcile', 'reconcile/2026-08', 'settlement', 'settlement/cash',
  'settlement/receivables', 'provenance',
  // Work
  'demand', 'trips', 'supply', 'platforms', 'platforms/tiers', 'platforms/funnel', 'corridors', 'causes',
  'forecast', 'optimise', 'capacity', 'day/2026-08-14', 'slot/2/19', 'trip/hotel/h-mock-1', 'trip/uber/u-mock-1',
  // People
  'drivers', 'driver/drv-0', 'driver/drv-0/activity', 'driver/drv-0/day?on=2026-09-20',
  'driver/drv-0/territory', 'driver/drv-0/earnings', 'driver/drv-0/quality', 'driver/drv-0/record',
  'driver/U-TARIQ/money', 'driver/drv-0/trips', 'driver/drv-0/unauthorized',
  'online-time', 'performer/drv-0', 'cohort/unit-licence-due', 'cohort/roster-blocked',
  'cancellations', 'roster', 'roster/pipeline', 'roster/idle', 'roster/blocked',
  'top-performers', 'low-performers',
  // Fleet and Sources
  'vehicles', 'vehicle/L45235', 'vehicle/L45235/drivers', 'vehicle/L45235/movement',
  'vehicle/L45235/earnings', 'vehicle/L45235/safety', 'vehicle/L45235/trips',
  'unauthorized', 'segments', 'segment/L45235/2026-08-03T04:00:00.000Z',
  'safety', 'safety/vehicles', 'safety/events',
];

const scan = (page) => page.evaluate(() => {
  const parts = [document.querySelector('#view')?.innerText || '', document.querySelector('#pageFoot')?.innerText || ''];
  for (const n of document.querySelectorAll('#view [title]')) parts.push(n.getAttribute('title'));
  for (const n of document.querySelectorAll('#view svg title')) parts.push(n.textContent);
  const txt = parts.join('\n');
  const out = [];
  const re = /AED[\s ]?[−-]?(\d[\d,]*)(\.\d+)?([kKmM]\b)?/g;
  let m;
  while ((m = re.exec(txt))) {
    if (!m[2] || m[3]) out.push(txt.slice(Math.max(0, m.index - 30), m.index + m[0].length + 15).replace(/\s+/g, ' '));
  }
  return [...new Set(out)];
});

for (const r of ROUTES.filter((x) => !ONLY || ONLY.includes(x))) {
  const { ctx, page } = await open('arkiv', r);
  const hits = await scan(page);
  check(`#${r}: every AED amount carries its fils`, hits.length === 0, JSON.stringify(hits.slice(0, 4)));
  await ctx.close();
}
/* The mock's only AED finding is the unsupported one, with nothing measured,
   so the scan above cannot see #analyst's money cards. A fixture gives the
   confirmed findings an AED metric (synthetic figures) and reads them. */
if (!ONLY || ONLY.includes('analyst')) {
  const aedF = (q, real) => ({ ...real, findings: (real.findings || []).map((f) => ({ ...f, unit: 'AED',
    measured_value: 116, baseline_value: 59.8, effect: 56.2 })) });
  const { ctx, page } = await open('arkiv', 'analyst', { fixtures: { '/api/analyst/findings': aedF } });
  const hits = await scan(page);
  const txt = await page.evaluate(() => document.querySelector('#view').innerText);
  check('#analyst: an AED metric\'s card prints money to the fils — "AED 116.00", "+AED 56.20"', hits.length === 0
    && txt.includes('AED 116.00') && txt.includes('AED 59.80') && txt.includes('+AED 56.20'), JSON.stringify(hits.slice(0, 4)));
  await ctx.close();
}
if (!ONLY || ONLY.includes('finance')) {
  const { ctx, page } = await open('classic', 'finance');
  const hits = await scan(page);
  check('#finance in the old skin: the shared worked example carries its fils too', hits.length === 0
    && (await page.evaluate(() => document.querySelector('#view').innerText)).includes('AED 63.00'), JSON.stringify(hits.slice(0, 4)));
  await ctx.close();
}
await done();
