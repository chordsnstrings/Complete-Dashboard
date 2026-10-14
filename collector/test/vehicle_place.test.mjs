/* Where a car is, in words, and never in the sea.
   ───────────────────────────────────────────────────────────────────────
   FIXLIST V9, V10 and V11, found by the vehicle audit of 2026-10-14:

     V9  — the phone's car page had nothing about the car NOW: not where it
           stands, not how long since it last took a booking. The profile
           carried the window's span and the newest tracker row, which can be a
           0,0 "no satellite lock" or carry no position at all.
     V10 — the gazetteer's area name (api/place_sql.js) was computed for
           /api/where and /api/live and printed by no vehicle page; the parked
           table read "25.204811, 55.270783".
     V11 — /api/where, /api/where/fleet, /api/map/days and /api/track passed
           0,0 fixes through: L68713's last position on record was 0,0, and a
           day of nothing but 0,0 was offered as a replayable trail.

   Each case below is one of those, built small. Synthetic plates only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { CELL } from '../src/places.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const LAT = 25.2, LNG = 55.3;
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations)
         VALUES ($1, $2, 'Test Quarter', 40, 1, 40)`, [Math.round(LAT / CELL), Math.round(LNG / CELL)]);
await q(`INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, fleet_id, make, model, vin)
         VALUES ('uber', 'v-pcar', 'PCAR', 'ecosine', 'Tesla', 'Model Y', 'VINPCAR'),
                ('uber', 'v-pnull', 'PNULL', 'ecosine', 'Tesla', 'Model Y', 'VINPNULL')`);
const fix = (plate, at, lat, lng, speed = 0) => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ('cabman', 'ecosine', $1, $2::timestamptz, $2::timestamptz, $3, $4, $5, 'Active')`,
  [plate, at, lat, lng, speed]);
const D = '2026-10-10';
// PCAR stood in Test Quarter on the morning of the 10th…
for (const m of ['10:00', '10:05', '10:10']) await fix('PCAR', `${D}T${m}:00+04:00`, LAT, LNG);
// …then lost its satellite lock, at noon and again an hour ago.
await fix('PCAR', `${D}T12:00:00+04:00`, 0, 0);
await fix('PCAR', new Date(Date.now() - 3600e3).toISOString(), 0, 0);
// PREAL reported a real position at noon, so the fleet at noon has one car on it.
await fix('PREAL', `${D}T12:02:00+04:00`, LAT, LNG);
// PNULL has never had a lock: two 0,0 fixes on the 10th, nothing else.
await fix('PNULL', `${D}T09:00:00+04:00`, 0, 0);
await fix('PNULL', `${D}T09:05:00+04:00`, 0, 0);
// PCAR's last booking was sixty days ago — outside any 30-day window.
const booked = new Date(Date.now() - 60 * 864e5).toISOString();
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, status)
         VALUES ('uber', 'vp1', 'ecosine', 'PCAR', 'd1', 'A Driver', $1::timestamptz, 'completed')`, [booked]);

const { get } = await mountAll(db);

console.log('\nV9 · the car now: where it was last seen, and its last booking ever');
{
  const p = (await get('/api/vehicle/profile?plate=PCAR&days=30')).body;
  const w = p?.last_position;
  check('the last position skips the newer 0,0 fixes for the last real one',
    w && Math.abs(w.lat - LAT) < 1e-6 && +new Date(w.at) === +new Date(`${D}T10:10:00+04:00`), JSON.stringify(w));
  check('…and names its area (V10)', w?.place?.area === 'Test Quarter', JSON.stringify(w?.place));
  check('the last booking ever is there when the window holds none',
    p?.span?.last_trip == null && p?.last_booking_ever && +new Date(p.last_booking_ever) === +new Date(booked),
    JSON.stringify([p?.span?.last_trip, p?.last_booking_ever]));
  const n = (await get('/api/vehicle/profile?plate=PNULL&days=30')).body;
  check('a tracker that never had a lock has no last position, and no booking ever',
    n && n.last_position === null && n.last_booking_ever === null, JSON.stringify([n?.last_position, n?.last_booking_ever]));
}

console.log('\nV10 · the parked spots, named');
{
  const mv = (await get('/api/vehicle/movement?plate=PCAR&from=2026-10-01&to=2026-10-14')).body;
  const spot = (mv?.parked || [])[0];
  check('a parked spot carries the gazetteer’s area', spot?.place?.area === 'Test Quarter', JSON.stringify(spot));
  check('…and no spot is the 0,0 of a lost lock', (mv?.parked || []).every((s) => Math.abs(s.lat) > 1), JSON.stringify(mv?.parked));
}

console.log('\nV11 · a 0,0 is no position, on every route that reads one');
{
  const span = (await get(`/api/where?plate=PCAR&day=${D}&from=11:00&to=13:00`)).body;
  check('/api/where: the noon 0,0 is not a fix in the stretch', span?.fixes === 0, JSON.stringify([span?.fixes, span?.first]));
  const never = (await get(`/api/where?plate=PNULL&day=2026-10-11&at=12:00`)).body;
  check('/api/where: a tracker of only 0,0 has never recorded a position',
    never?.position === null && /no tracker position has ever been recorded/.test(never?.position_why || ''), never?.position_why);
  const fleet = (await get(`/api/where/fleet?day=${D}&at=12:00`)).body;
  const placed = (fleet?.cars || []).map((c) => `${c.plate}@${c.lat},${c.lng}`);
  check('/api/where/fleet: the car whose noon fix was 0,0 is not placed in the sea; the real one is, named',
    placed.length === 1 && fleet.cars[0].plate === 'PREAL' && fleet.cars[0].area === 'Test Quarter', JSON.stringify(placed));
  const days = (await get('/api/map/days?plate=PNULL&from=2026-10-01&to=2026-10-14')).body;
  check('/api/map/days: a day of nothing but 0,0 is not a replayable trail', Array.isArray(days) && days.length === 0, JSON.stringify(days));
  const track = (await get(`/api/track?plate=PCAR&from=${D}&to=${D}`)).body;
  check('/api/track: the trail holds the three real fixes and not the 0,0',
    Array.isArray(track) && track.length === 3 && track.every((f) => Math.abs(f.lat) > 1), JSON.stringify(track?.map((f) => [f.lat, f.lng])));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
