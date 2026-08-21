/* Loads every route in a real browser against the local mock API and fails if
   any view throws or renders its error state.

   This exists because `node --check` passes on a missing import and the view
   then dies at runtime with "note is not defined" — a whole page blank, caught
   only by looking at it. Not part of `npm test`: it needs Chromium and the mock
   API. Run it before shipping UI changes:

     node mockapi.mjs &                 # port 8099
     node test/smoke_views.mjs

   Set PW_CHROME to point at a Chromium binary if Playwright cannot find one. */
import { chromium } from 'playwright';

const ROUTES = [
  'overview', 'demand', 'day/2026-08-14', 'day/not-a-date', 'drivers',
  'driver/drv-0', 'driver/drv-0/activity', 'driver/drv-0/territory',
  'driver/drv-0/earnings', 'driver/drv-0/quality', 'driver/drv-0/trips',
  'roster', 'roster/pipeline', 'roster/idle', 'roster/blocked', 'roster/states',
  'vehicles', 'vehicle/L45235', 'vehicle/L45235/drivers', 'vehicle/L45235/movement',
  'vehicle/L45235/safety', 'vehicle/L45235/compliance', 'vehicle/L45235/trips',
  'platforms', 'platforms/tiers', 'platforms/funnel',
  'corridors', 'finance', 'settlement', 'settlement/cash', 'settlement/receivables',
  'corporate', 'corporate/properties', 'corporate/guests',
  'corporate/leakage', 'corporate/leakage/complimentary',
  'corporate/approach', 'corporate/approach/daypart',
  'property/h-palm', 'property/h-palm/guests', 'property/h-palm/drivers',
  'causes', 'insights',
  'analyst', 'analyst/refuted', 'analyst/immaterial', 'analyst/unsupported', 'analyst/rules',
  'compliance', 'unauthorized',
  'safety', 'live', 'map', 'sources', 'coverage', 'providers', 'settings',
];
const BASE = process.env.SMOKE_BASE || 'http://localhost:8099';

const browser = await chromium.launch(
  process.env.PW_CHROME ? { executablePath: process.env.PW_CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let bad = 0;

for (const route of ROUTES) {
  const errs = [];
  const onErr = (e) => errs.push(String(e.message || e));
  page.on('pageerror', onErr);
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  // The view's own catch-all renders "Could not load this view" — an empty
  // panel from missing fixture data is fine, a dead view is not.
  const err = await page.$('#view .empty b');
  const msg = err ? (await err.textContent()) || '' : '';
  const broke = /could not load/i.test(msg) || errs.length > 0;
  if (broke) { bad++; console.log(`  ✗ #${route}  ${msg} ${errs.slice(0, 2).join('; ')}`); }
  else console.log(`  ✓ #${route}`);
  page.off('pageerror', onErr);
}

console.log(`\n${ROUTES.length - bad}/${ROUTES.length} views rendered`);
await browser.close();
process.exit(bad ? 1 : 0);
