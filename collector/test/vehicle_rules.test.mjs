/* The two car rules behind the To-do and Action lists, held to what is true.
   ───────────────────────────────────────────────────────────────────────
   FIXLIST V7 and V8, found by the vehicle audit of 2026-10-14 and measured on
   production:

     idle_vehicle flagged 7 cars and missed 15 of the 21 Uber-active cars that
     took no booking in thirty days — it demanded a tracker fix in the last 48
     hours, so a car laid up with its tracker asleep or dead was never idle —
     and it flagged L74169, driven 26 of 30 days without a booking (CABMAN
     movement writes no journey row), with workshop advice. Its population was
     every plate a tracker ever sent, not the cars.

     vehicle_dormant grouped by (plate, fleet_id), so rows once filed under
     egari made Ecosine cars working 22–30 of 30 days read "no signal for
     34–46 days"; and it counted the Uber collector's driver-status rows — no
     coordinates — as signal, and printed them as a "last position".

   Each case below is one of those, built small. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
const { computeInsights } = await import('../src/insights.js');

const at = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
let n = 0;
const car = (plate, fleet = 'ecosine') => q(
  `INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, fleet_id, make, model, vin)
   VALUES ('uber', $1, $2, $3, 'Tesla', 'Model Y', $4)`, [`v-${plate}`, plate, fleet, `VIN${plate}`]);
const booking = (plate, daysAgo) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, status)
   VALUES ('uber', $1, 'ecosine', $2, 'd1', 'A Driver', $3::timestamptz, 'completed')`, [`t${n++}`, plate, at(daysAgo)]);
const fix = (plate, daysAgo, { source = 'cabman', fleet = 'ecosine', speed = 0, lat = 25.2, lng = 55.3, status = 'Active' } = {}) => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz, $5, $6, $7, $8)`,
  [source, fleet, plate, at(daysAgo), lat, lng, speed, status]);

/* ── idle_vehicle ──────────────────────────────────────────────────────── */
// Laid up 40 days, tracker asleep for ten: idle — the old 48-hour rule missed it.
await car('C-ASLEEP'); await booking('C-ASLEEP', 40); await fix('C-ASLEEP', 10);
// Laid up, never tracked: idle.
await car('C-NOTRACK'); await booking('C-NOTRACK', 60);
// No booking for 20 days, but CABMAN saw it driven on three of the last few days: not idle.
await car('C-DRIVEN'); await booking('C-DRIVEN', 20);
for (const d of [1, 2, 3]) await fix('C-DRIVEN', d, { speed: 35, status: 'Engaged' });
await fix('C-DRIVEN', 0.1);
// Working: a booking yesterday.
await car('C-WORKING'); await booking('C-WORKING', 1); await fix('C-WORKING', 0.1);
// A tracker plate with no VIN — not one of the cars.
await fix('PHANTOM1', 0.1);

/* ── vehicle_dormant ───────────────────────────────────────────────────── */
// Old fixes filed under egari, current ones under ecosine: one car, reporting.
await car('D-REFILED');
await fix('D-REFILED', 40, { fleet: 'egari' }); await fix('D-REFILED', 0.2);
// The tracker silent 40 days; Uber's driver status, with no position, yesterday.
await car('D-UBERROW');
await fix('D-UBERROW', 40);
await fix('D-UBERROW', 1, { source: 'uber', lat: null, lng: null, speed: null, status: 'ONTRIP' });
// A tracker that never had a satellite lock, silent 35 days.
await car('D-NOLOCK');
await fix('D-NOLOCK', 35, { lat: null, lng: null });

await computeInsights({});
const got = await q(`SELECT code, entity_id, title, detail, metric FROM insight
                      WHERE code IN ('idle_vehicle', 'vehicle_dormant') ORDER BY code, entity_id`);
const idle = got.filter((r) => r.code === 'idle_vehicle');
const dorm = got.filter((r) => r.code === 'vehicle_dormant');
const ids = (xs) => xs.map((r) => r.entity_id).sort();

console.log('\nidle_vehicle: the cars that neither earned nor moved');
check('a laid-up car whose tracker is asleep is idle', ids(idle).includes('C-ASLEEP'), JSON.stringify(ids(idle)));
check('a laid-up car with no tracker is idle', ids(idle).includes('C-NOTRACK'), JSON.stringify(ids(idle)));
check('a car CABMAN saw driven without a booking is not idle', !ids(idle).includes('C-DRIVEN'), JSON.stringify(ids(idle)));
check('a working car is not idle', !ids(idle).includes('C-WORKING'));
check('a tracker plate with no VIN is not a car, so not idle', !ids(idle).includes('PHANTOM1'), JSON.stringify(ids(idle)));
{
  const a = idle.find((r) => r.entity_id === 'C-ASLEEP');
  check('it does not claim a car with a ten-day-old fix is "present and powered"',
    a && !/present and powered/.test(a.detail) && /cannot be said/.test(a.detail), a?.detail);
  const t = idle.find((r) => r.entity_id === 'C-NOTRACK');
  check('and says plainly when no tracker has ever reported the car', t && /No tracker has ever reported/.test(t.detail), t?.detail);
}

console.log('\nvehicle_dormant: one car, its trackers, its positions');
check('old rows under another fleet do not make a reporting car dormant', !ids(dorm).includes('D-REFILED'), JSON.stringify(ids(dorm)));
{
  const u = dorm.find((r) => r.entity_id === 'D-UBERROW');
  check('an Uber driver-status row is not the tracker\'s signal', !!u && u.metric === 40, JSON.stringify(u && [u.metric]));
  const nl = dorm.find((r) => r.entity_id === 'D-NOLOCK');
  check('a tracker with no position never prints a "last position"',
    !!nl && !/Last position/.test(nl.detail) && /No fix from it ever carried a position/.test(nl.detail), nl?.detail);
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
