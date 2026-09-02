/* The safety rate must not improve because you looked at more time.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production 2026-09-02, /api/kpis:

       days=7    trips  3,872   alerts  40,286   km  47,590   ->  84.7
       days=16   trips  8,022   alerts  69,338   km  99,538   ->  69.7
       days=30   trips 13,437   alerts  69,338   km 166,923   ->  41.5
       days=90   trips 33,432   alerts 373,951   km 401,880   ->  93.1

   Identical alerts at 16 and 30 days, 68% more distance, half the rate. The
   alert feed has a 73-day hole (2026-06-06 → 2026-08-17) and days 17–30 back
   from today land inside it, so they contribute distance and no alerts.

   This file seeds that exact shape — a hole with covered days on BOTH sides of
   it, so the covered days are not a contiguous range — and asserts the one
   property the production numbers violate: widening a window across dark days
   does not move the rate, because distance from a day the feed was dark
   belongs in neither half of the ratio.

   Before the fix, on this fixture, /api/kpis reported 60.0 over the covered
   window and 21.4 over the same window widened across the hole. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { alertCoverageOf, alertRate, alertRateReason } from '../api/alert_coverage_sql.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* ── the fixture ──────────────────────────────────────────────────────────
   One plate, one driver, one trip a day of a constant distance, every day from
   20 June to 31 July. The alert feed covers 20–30 June and 21–31 July and is
   DARK for the twenty days between, which puts the hole in the middle exactly
   as production has it.

   A constant distance per day and a constant alert count per covered day makes
   the true rate arithmetic rather than incidental: 3 alerts over 5 km is
   60 per 100 km on every covered day, and so over any set of them. */
const PLATE = 'L45240';
const DRIVER = 'u-safe';
const NAME = 'Imran Safe';
const KM_PER_DAY = 5;
const ALERTS_PER_DAY = 3;

const DARK_FROM = '2026-07-01', DARK_TO = '2026-07-20';
const LATE_FROM = '2026-07-21', LATE_TO = '2026-07-31';   // covered, 11 days
const EARLY_FROM = '2026-06-20', EARLY_TO = '2026-06-30'; // covered, 11 days

const dayList = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 864e5) {
    // toISOString, never String(date): String(new Date(...)) is "Thu Aug 07 2026".
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
const ALL_DAYS = dayList(EARLY_FROM, LATE_TO);
const COVERED = [...dayList(EARLY_FROM, EARLY_TO), ...dayList(LATE_FROM, LATE_TO)];

await q(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO vehicle (plate, fleet_id, make, model, year)
         VALUES ($1, 'ecosine', 'Toyota', 'Corolla', 2023) ON CONFLICT DO NOTHING`, [PLATE]);

for (const day of ALL_DAYS) {
  // 09:00 Dubai = 05:00Z, safely inside the Dubai day at both ends.
  const at = `${day}T05:00:00Z`;
  await q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                       requested_at, status, distance_km, price, payment_type)
     VALUES ('uber', $1, 'ecosine', $2, $3, $4, $5::timestamptz, 'completed', $6, 40, 'card')`,
    [`t-${day}`, PLATE, DRIVER, NAME, at, KM_PER_DAY]);
  await q(
    `INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
                                     fleet_id, trips, km, is_primary)
     VALUES ($1, $2::date, $3, 'uber', $4, 'ecosine', 1, $5, true)`,
    [PLATE, day, DRIVER, NAME, KM_PER_DAY]);
}

for (const day of COVERED) {
  for (let i = 0; i < ALERTS_PER_DAY; i++) {
    await q(
      `INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
       VALUES ('fms', $1, 'ecosine', $2, 'Harsh Brake', $3::timestamptz)`,
      [`a-${day}-${i}`, PLATE, `${day}T06:0${i}:00Z`]);
  }
}

const app = await mountAll(db);
const W = (from, to) => `from=${from}&to=${to}`;
/* The three windows the bug lives between. */
const COVERED_ONLY = W(LATE_FROM, LATE_TO);          // 11 days, all covered
const WIDENED = W(DARK_FROM, LATE_TO);               // 31 days, the same 11 covered
const SPANS_HOLE = W(EARLY_FROM, LATE_TO);           // 42 days, 22 covered, hole in the middle
const ALL_DARK = W(DARK_FROM, DARK_TO);              // 20 days, none covered

const TRUE_RATE = (ALERTS_PER_DAY * 100) / KM_PER_DAY;   // 60.0
const near = (a, b) => a != null && b != null && Math.abs(Number(a) - Number(b)) < 0.05;

/* ── the pure rule, before any endpoint uses it ───────────────────────── */
console.log('\nthe covered-day rule');
{
  const cov = alertCoverageOf(COVERED, EARLY_FROM, LATE_TO);
  check('counts only the days the feed produced rows on',
    cov.covered_days === 22 && cov.window_days === 42, JSON.stringify([cov.covered_days, cov.window_days]));
  check('finds the hole in the MIDDLE, as a run of dark days',
    cov.gaps[0]?.from === DARK_FROM && cov.gaps[0]?.to === DARK_TO && cov.gaps[0]?.days === 20,
    JSON.stringify(cov.gaps));
  check('the covered days are a SET, not a narrowed range',
    cov.days.includes('2026-06-25') && cov.days.includes('2026-07-25')
      && !cov.days.includes('2026-07-10'), String(cov.days.length));
  check('says what it measured over, in words a page can print',
    cov.basis === 'measured over 22 of the 42 days in this window', cov.basis);
  check('and names the assumption it made', /at least one row/.test(cov.rule || ''), cov.rule);

  const dark = alertCoverageOf([], DARK_FROM, DARK_TO);
  check('a window the feed never covered is NOT MEASURED', dark.measured === false, JSON.stringify(dark.measured));
  check('…and its rate is null rather than 0', alertRate(0, 1000, dark) === null,
    String(alertRate(0, 1000, dark)));
  check('…with a reason, not a silent null',
    /not measured/.test(alertRateReason(1000, dark) || ''), String(alertRateReason(1000, dark)));
}

/* ── the five call sites ──────────────────────────────────────────────── */
const rateOf = async (path) => (await app.get(path)).body;

console.log('\n/api/kpis — the fleet headline');
{
  const a = await rateOf(`/api/kpis?${COVERED_ONLY}`);
  const b = await rateOf(`/api/kpis?${WIDENED}`);
  const c = await rateOf(`/api/kpis?${SPANS_HOLE}`);
  const d = await rateOf(`/api/kpis?${ALL_DARK}`);
  check(`the covered window reads the true rate (${TRUE_RATE})`,
    near(a.alerts_per_100km, TRUE_RATE), String(a.alerts_per_100km));
  check('widening across 20 dark days does not move it',
    near(b.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${b.alerts_per_100km}`);
  check('nor does widening across a hole with covered days on both sides',
    near(c.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${c.alerts_per_100km}`);
  check('a window the feed was dark for is not measured',
    d.alerts_per_100km === null && d.alert_coverage?.measured === false,
    JSON.stringify([d.alerts_per_100km, d.alert_coverage?.measured]));
  check('the response says how many of the window\'s days it measured',
    b.alert_coverage?.covered_days === 11 && b.alert_coverage?.window_days === 31,
    JSON.stringify(b.alert_coverage && [b.alert_coverage.covered_days, b.alert_coverage.window_days]));
  check('and carries the distance the rate was actually taken over',
    near(b.alert_km, 11 * KM_PER_DAY), `${b.alert_km} of ${b.km}`);
}

console.log('\n/api/economics/assets — per vehicle');
{
  const row = (b) => b.rows.find((r) => r.plate === PLATE);
  const a = row(await rateOf(`/api/economics/assets?${COVERED_ONLY}`));
  const b = row(await rateOf(`/api/economics/assets?${WIDENED}`));
  const c = row(await rateOf(`/api/economics/assets?${SPANS_HOLE}`));
  const d = row(await rateOf(`/api/economics/assets?${ALL_DARK}`));
  check(`the covered window reads the true rate (${TRUE_RATE})`,
    near(a.alerts_per_100km, TRUE_RATE), String(a.alerts_per_100km));
  check('widening across dark days does not move it',
    near(b.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${b.alerts_per_100km}`);
  check('nor across a hole in the middle',
    near(c.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${c.alerts_per_100km}`);
  check('a dark window is not measured', d.alerts_per_100km === null, String(d.alerts_per_100km));
}

console.log('\n/api/economics/drivers — per driver');
{
  const row = (b) => b.rows.find((r) => r.driver_name === NAME);
  const a = row(await rateOf(`/api/economics/drivers?${COVERED_ONLY}`));
  const b = row(await rateOf(`/api/economics/drivers?${WIDENED}`));
  const c = row(await rateOf(`/api/economics/drivers?${SPANS_HOLE}`));
  check(`the covered window reads the true rate (${TRUE_RATE})`,
    near(a?.alerts_per_100km, TRUE_RATE), String(a?.alerts_per_100km));
  check('widening across dark days does not move it',
    near(b?.alerts_per_100km, a?.alerts_per_100km),
    `${a?.alerts_per_100km} -> ${b?.alerts_per_100km}`);
  check('nor across a hole in the middle',
    near(c?.alerts_per_100km, a?.alerts_per_100km),
    `${a?.alerts_per_100km} -> ${c?.alerts_per_100km}`);
}

console.log('\n/api/driver/quality — the driver detail page');
{
  const P = `id=${encodeURIComponent(DRIVER)}`;
  const a = await rateOf(`/api/driver/quality?${P}&${COVERED_ONLY}`);
  const b = await rateOf(`/api/driver/quality?${P}&${WIDENED}`);
  const c = await rateOf(`/api/driver/quality?${P}&${SPANS_HOLE}`);
  const d = await rateOf(`/api/driver/quality?${P}&${ALL_DARK}`);
  check(`the covered window reads the true rate (${TRUE_RATE})`,
    near(a.alerts_per_100km, TRUE_RATE), String(a.alerts_per_100km));
  check('widening across dark days does not move it',
    near(b.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${b.alerts_per_100km}`);
  check('nor across a hole in the middle',
    near(c.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${c.alerts_per_100km}`);
  check('the FLEET baseline it is painted against moves with it',
    near(b.fleet_alerts_per_100km, a.fleet_alerts_per_100km),
    `${a.fleet_alerts_per_100km} -> ${b.fleet_alerts_per_100km}`);
  check('a dark window is not measured, on both figures',
    d.alerts_per_100km === null && d.fleet_alerts_per_100km === null
      && d.alert_coverage?.measured === false,
    JSON.stringify([d.alerts_per_100km, d.fleet_alerts_per_100km]));
  check('and it says which days it measured over',
    c.alert_coverage?.covered_days === 22, JSON.stringify(c.alert_coverage?.covered_days));
}

console.log('\n/api/vehicle/kpis — the vehicle detail page');
{
  const P = `plate=${PLATE}`;
  const a = await rateOf(`/api/vehicle/kpis?${P}&${COVERED_ONLY}`);
  const b = await rateOf(`/api/vehicle/kpis?${P}&${WIDENED}`);
  const c = await rateOf(`/api/vehicle/kpis?${P}&${SPANS_HOLE}`);
  const d = await rateOf(`/api/vehicle/kpis?${P}&${ALL_DARK}`);
  check(`the covered window reads the true rate (${TRUE_RATE})`,
    near(a.alerts_per_100km, TRUE_RATE), String(a.alerts_per_100km));
  check('widening across dark days does not move it',
    near(b.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${b.alerts_per_100km}`);
  check('nor across a hole in the middle',
    near(c.alerts_per_100km, a.alerts_per_100km),
    `${a.alerts_per_100km} -> ${c.alerts_per_100km}`);
  check('a dark window is not measured',
    d.alerts_per_100km === null && d.alert_coverage?.measured === false,
    JSON.stringify([d.alerts_per_100km, d.alert_coverage?.measured]));
  check('and the response says what it measured over',
    b.alert_coverage?.basis === 'measured over 11 of the 31 days in this window',
    String(b.alert_coverage?.basis));
}

/* ── the property the production numbers violated ─────────────────────── */
console.log('\nthe rate is monotone-free: widening never improves safety');
{
  const rates = [];
  for (const [f, t] of [[LATE_FROM, LATE_TO], ['2026-07-11', LATE_TO],
    [DARK_FROM, LATE_TO], [EARLY_TO, LATE_TO]]) {
    rates.push((await rateOf(`/api/kpis?${W(f, t)}`)).alerts_per_100km);
  }
  /* Every one of these windows contains the same eleven covered days and
     differing amounts of dark distance. On production the equivalent four
     readings were 84.7, 69.7, 41.5 and 93.1. */
  check('four widening windows over one covered stretch all agree',
    rates.every((r) => near(r, rates[0])), JSON.stringify(rates));
}

app.server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
