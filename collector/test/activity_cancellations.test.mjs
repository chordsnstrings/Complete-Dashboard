/* A cancelled booking on the Activity bars is a CANCELLATION, said by whom.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16, on a driver's 1–15 November: "the specific rider
   cancelled or driver cancelled on the activity doesn't show properly, it
   shows as red bar. we need to fix it and give users better information."

   Measured on that driver: all twenty of "122 jobs · 20 with no dropoff
   reported" were cancellations (16 Uber, 4 Bolt). Each was drawn as the
   hatched "no dropoff reported" marker — a claim about the channel's record
   that is not true of a ride nobody took — and counted as a job; and the one
   red bar that overlapped a rider-cancelled request on the same car (1 Nov
   18:32–21:13, the request at 20:56) said nothing about it, so the bar read
   as the cancellation.

   Held here, in a real browser against the mock, with /api/driver/shift and
   /api/driver/unauthorized answered by fixtures written for this test:

     1. each cancellation is drawn in its own form by who ended it — rider,
        driver after accepting, an offer declined, not said by whom — and none
        of them as the hatched "no dropoff reported";
     2. a completed booking whose dropoff is genuinely missing still is;
     3. the words: each mark's title, the legend (only the forms drawn), the
        day's jobs column, the Jobs tile and the caption under the bars;
     4. a red bar names a cancellation on THE SAME CAR inside it, and is drawn
        beneath it; a cancellation on another car is not named;
     5. an older response with outcome 'not_completed' and no party is still
        drawn as a cancellation ("not said by whom"), never as a missing
        dropoff.

   REVERSIONS (each run, each failing as named):
     · shiftBars' cancellation branch removed → §1 and §3 fail (the marks fall
       back to the hatch)
     · the `inside` naming in unbookedOnBars removed → §4 "names the
       cancellation" fails
     · cancelOf's outcome fallback removed → §5 fails
     · the z-index on .sh-track>i.c removed from app.css → §4 "drawn above"
       fails

   Synthetic people and places only. */
import { chromium } from 'playwright';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const { app } = await import('../mockapi.mjs');
const srv = app.listen(0); await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const today = new Date(Date.now() + 4 * 3600e3);
const dayISO = (back) => new Date(today.getTime() - back * 864e5).toISOString().slice(0, 10);
const D1 = dayISO(3), D2 = dayISO(2);
const job = (s, e, o = {}) => ({ s, e, over: false, platform: 'uber', plate: 'TST001', outcome: 'completed',
  status: 'completed', cancel_by: null, declined: false, ...o });
const cx = (s, by, status, o = {}) => job(s, null, { outcome: 'not_completed', status, cancel_by: by, ...o });
/* D1: two completed jobs, a rider cancellation at 20:56 (the operator's
   case, inside the red bar below), a driver cancellation after accepting, a
   Bolt offer declined, a Bolt rider no-show, a Yango cancellation with no
   party, and a completed booking whose dropoff is missing. */
const d1jobs = [
  job(600, 640), job(700, 745),
  cx(1256, 'rider', 'rider_cancelled'),
  cx(800, 'driver', 'driver_cancelled'),
  cx(860, 'driver', 'driver_rejected', { platform: 'bolt', declined: true }),
  cx(900, 'rider', 'client_did_not_show', { platform: 'bolt' }),
  cx(960, 'unattributed', 'cancelled', { platform: 'yango' }),
  job(1000, null),
];
/* D2: an OLDER response — outcome 'not_completed' and nothing else, as a
   cached copy from before the server named the party would be — plus a rider
   cancellation on ANOTHER car inside the second red bar. */
const d2jobs = [
  job(500, 560),
  { s: 620, e: null, over: false, platform: 'uber', plate: 'TST001', outcome: 'not_completed' },
  cx(700, 'rider', 'rider_cancelled', { plate: 'OTHER9' }),
];
const dayOf = (day, jobs) => {
  const known = jobs.filter((j) => j.e != null);
  return { day, jobs, bookings: jobs.length, on_job_min: known.reduce((a, j) => a + (j.e - j.s), 0),
    wait_min: 60, longest_wait_min: 60, overlaps: 0, unknown_end: 1,
    first_min: Math.min(...jobs.map((j) => j.s)), last_min: Math.max(...known.map((j) => j.e)), span_min: 300 };
};
const SHIFT = { days: [dayOf(D1, d1jobs), dayOf(D2, d2jobs)], basis: 'test basis', online_days: 0, unknown_end: 1 };

const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+04:00`).toISOString();
const seg = (o) => ({ verdict: 'unauthorized', fleet_id: 'ecosine', plate: 'TST001', counts_once: true,
  source: 'fms_trip', source_label: 'FMS trip seat count', distance_km: 130, passengers: 1,
  verdict_reason: 'no completed booking overlaps', channels_checked: 'bolt,hotel,uber,yango',
  attribution_tier: 'last_trip', attribution_evidence: 'The last Uber trip on the car was theirs.',
  start_place: { area: 'Test Origin' }, end_place: { area: 'Test Destination' }, ...o });
const UZ = {
  driver: { id: 'drv-0' },
  attributed: { rows: [
    seg({ started_at: at(D1, '18:32'), ended_at: at(D1, '21:13') }),          // the rider cancellation at 20:56 is inside
    seg({ started_at: at(D2, '11:30'), ended_at: at(D2, '12:10') }),          // a cancellation on OTHER9 at 11:40 is not this car's
  ], total: 2, shown: 2 },
  also_a_candidate: { rows: [], total: 0, shown: 0 },
  coverage: { days_with_data: 14, days_in_window: 14, scope: 'the 1 car(s) this person held in this window' },
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const open = async (width) => {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.route('**/api/driver/shift**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SHIFT) }));
  await page.route('**/api/driver/unauthorized**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(UZ) }));
  await page.goto(`${base}/#driver/drv-0/activity`, { waitUntil: 'networkidle' });
  await page.waitForSelector(`.shift[data-day="${D1}"] .sh-track i.c`, { timeout: 20000 }).catch(() => {});
  await page.waitForSelector(`.shift[data-day="${D1}"] .sh-track i.x`, { timeout: 20000 }).catch(() => {});
  return { page, errs, close: () => ctx.close() };
};

const p = await open(1280);
const got = await p.page.evaluate(([d1, d2]) => {
  const marks = (d) => [...document.querySelectorAll(`.shift[data-day="${d}"] .sh-track > i`)]
    .map((i) => ({ cls: i.className, s: i.dataset.s ? Number(i.dataset.s) : null, title: i.title, z: getComputedStyle(i).zIndex }));
  const row = (d) => document.querySelector(`.shift[data-day="${d}"]`);
  const jobsTile = [...document.querySelectorAll('.kpis.glance > *')].find((t) => /^\s*jobs/i.test(t.innerText || ''));
  return {
    m1: marks(d1), m2: marks(d2),
    legend: (document.querySelector('.lgnd')?.innerText || ''),
    col1: row(d1)?.querySelector('.sh-t')?.innerText || '',
    rowTitle1: row(d1)?.title || '',
    jobsTile: jobsTile ? jobsTile.innerText.replace(/\s+/g, ' ') : null,
    caps: [...document.querySelectorAll('.cap')].map((c) => c.innerText).join(' | '),
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
  };
}, [D1, D2]);

console.log('\n1. each cancellation in its own form, by who ended it');
const by = (list, s) => list.find((m) => m.s === s && /\bc\b/.test(m.cls)) || {};
check('the rider cancellation at 20:56 is a rider mark', /\bcr\b/.test(by(got.m1, 1256).cls), JSON.stringify(by(got.m1, 1256)));
check('the driver cancellation after accepting is a driver mark', /\bcd\b/.test(by(got.m1, 800).cls), JSON.stringify(by(got.m1, 800)));
check('the Bolt offer declined is its own mark', /\bco\b/.test(by(got.m1, 860).cls));
check('the Bolt no-show is the rider\'s', /\bcr\b/.test(by(got.m1, 900).cls));
check('the Yango cancellation is "not said by whom"', /\bcu\b/.test(by(got.m1, 960).cls));
check('…and not one of the five is drawn as the hatched "no dropoff reported"',
  got.m1.filter((m) => m.cls === 'u').length === 1, JSON.stringify(got.m1.map((m) => m.cls)));

console.log('\n2. a completed booking with no dropoff is still the hatch');
check('one hatch on the day, for the 16:40 completed booking', got.m1.some((m) => m.cls === 'u' && /16:40/.test(m.title)),
  JSON.stringify(got.m1.filter((m) => m.cls === 'u')));

console.log('\n3. the words');
const t = (s) => by(got.m1, s).title || '';
check('each mark\'s title says what happened', /rider cancelled/.test(t(1256)) && /driver cancelled after accepting/.test(t(800))
  && /offer declined by the driver/.test(t(860)) && /the rider did not show/.test(t(900))
  && /does not say by whom/.test(t(960)) && /20:56/.test(t(1256)) && /no ride/.test(t(1256)),
  JSON.stringify([t(1256), t(800), t(860), t(900), t(960)]));
check('the legend names each form drawn, and "no dropoff reported" because one is drawn',
  /cancelled by the rider/i.test(got.legend) && /cancelled by the driver after accepting/i.test(got.legend)
  && /offer the driver declined/i.test(got.legend) && /does not say by whom/i.test(got.legend) && /no dropoff reported/i.test(got.legend),
  got.legend);
check('the day\'s jobs column counts the three jobs and marks the five cancelled apart', /^3\s*\+5✕/.test(got.col1.trim()), got.col1);
check('the row\'s title says the same in words', /3 jobs and 5 cancelled/.test(got.rowTitle1) && /2 by the rider/.test(got.rowTitle1), got.rowTitle1);
check('the Jobs tile counts jobs, and says the cancellations by party — not "with no dropoff"',
  got.jobsTile && /jobs 4\b/i.test(got.jobsTile) && /7 more cancelled/i.test(got.jobsTile) && /by the rider/.test(got.jobsTile)
  && /1 with no dropoff reported/.test(got.jobsTile), got.jobsTile);
check('the caption under the bars says what a cancellation is on this chart',
  /7 bookings in these days were cancelled/.test(got.caps) && /not counted as a job/.test(got.caps), got.caps.slice(0, 300));

console.log('\n4. a red bar names the cancellation on the same car inside it');
const red1 = got.m1.find((m) => m.cls === 'x') || {};
const red2 = got.m2.find((m) => m.cls === 'x') || {};
check('the 18:32–21:13 bar names the 20:56 rider cancellation on this car',
  /on this car during it: 20:56 uber booking, rider cancelled/.test(red1.title || '') && /does not explain this journey/.test(red1.title || ''),
  red1.title);
check('the second bar does not name a cancellation on another car', !/on this car during it/.test(red2.title || ''), red2.title);
check('the cancellation is drawn above the red bar', Number(by(got.m1, 1256).z) > Number(red1.z), `${by(got.m1, 1256).z} vs ${red1.z}`);

console.log('\n5. an older response is still read as a cancellation');
check('outcome not_completed with no party is "not said by whom", never the hatch',
  /\bcu\b/.test(by(got.m2, 620).cls) && !got.m2.some((m) => m.cls === 'u'), JSON.stringify(got.m2.map((m) => [m.s, m.cls])));

check('no script errors and no sideways scroll at 1280', !p.errs.length && !got.overflow, JSON.stringify(p.errs));
await p.close();
const n = await open(390);
const narrow = await n.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('no script errors and no sideways scroll at 390', !n.errs.length && !narrow, JSON.stringify(n.errs));
await n.close();

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
