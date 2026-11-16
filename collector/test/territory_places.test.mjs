/* The driver Territory tab's "Busiest pickup areas", after PLC.
   ──────────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16, on a driver whose second-largest row was
   "(unparsed)" (35 of ~230 pickups): "we need to find a way to find the
   actual location", then "so that unparsed doesn't exist". This drives
   GET /api/driver/territory over a real Postgres (PGlite) after a real
   resolver pass, and pins:

     · no row is ever "(unparsed)" — a pickup the ladder placed is in its
       area, and what it could not place is a row named by its reason;
     · each area says how its pickups were placed (by_basis), and the totals
       the caption is built from cover every pickup, in ladder order, in the
       words src/place_resolve.js owns;
     · pickups with NO address are counted now (they were silently outside the
       list's denominator) — the tracker places one, the other is the residual;
     · a booking the pass has not reached falls back to place_area() for a
       dash-form address and is otherwise "not placed yet", never guessed. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { driverRoutes } from '../api/driver_routes.js';
import { resolveTripPlaces } from '../src/trip_places.js';
import { CELL } from '../src/places.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const DRV = 'u-noor';
let n = 0;
const trip = (pickup, hour, minute = 0) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at,
                     distance_km, status, price, pickup_addr, dropoff_addr)
   VALUES ('uber', $1, 'ecosine', 'L47001', $2, 'Noor Test', $3, $4, 8, 'completed', 30, $5, '')`,
  [`t${n++}`, DRV, `2026-11-12T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+04:00`,
    `2026-11-12T${String(hour).padStart(2, '0')}:${String(minute + 20).padStart(2, '0')}:00+04:00`, pickup]);
const BB = 'Bay Square - Business Bay - Dubai - United Arab Emirates';
for (let i = 0; i < 3; i++) await trip(BB, 8 + i);                              // 3 from the address
for (let i = 0; i < 2; i++) await trip('Ahad Residences Marasi Drive Business Bay AE', 12 + i); // 2 from the text
await trip('', 15);   // no address; the tracker was in Business Bay two minutes later
await trip('', 17);   // no address, no fix
/* The tracker, and a gazetteer that names its cell. */
await q(`INSERT INTO telemetry_snapshot (source, plate, captured_at, lat, lng)
         VALUES ('fms', 'L47001', '2026-11-12T15:02:00+04:00', 25.185, 55.27)`);
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations, built_at)
         VALUES ($1, $2, 'Business Bay', 5, 1, 5, now())`, [Math.round(25.185 / CELL), Math.round(55.27 / CELL)]);
/* The resolver's fresh window is relative to now(); these bookings are from
   a fixed November day, so let the sweep (which has no window) reach them. */
await resolveTripPlaces(db, { budgetMs: 60_000 });

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
driverRoutes(app, { q, wrap, endOfDay });
const server = app.listen(0);
const get = async (p) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`)).json();
const W = 'from=2026-11-01&to=2026-11-30';

console.log('\nthe busiest pickup areas, placed');
{
  const t = await get(`/api/driver/territory?id=${DRV}&${W}`);
  check('the route answers', Array.isArray(t.areas), JSON.stringify(t).slice(0, 200));
  check('no row is "(unparsed)"', !t.areas.some((a) => a.area === '(unparsed)'), JSON.stringify(t.areas));
  const bb = t.areas.find((a) => a.area === 'Business Bay');
  check('Business Bay holds the address, the text and the tracker pickups: 6', bb?.n === 6, JSON.stringify(bb));
  check('…and says how: 3 from the address, 2 named from the text, 1 by the tracker',
    bb?.by_basis?.address === 3 && bb?.by_basis?.address_name === 2 && bb?.by_basis?.tracker === 1, JSON.stringify(bb?.by_basis));
  const rest = t.areas.filter((a) => !a.area);
  check('the one pickup nothing could place is a row named by its reason',
    rest.length === 1 && rest[0].unplaced === true && rest[0].reason === 'no_address+no_fix'
      && rest[0].label === 'Not placed — no address, and no tracker fix within 5 minutes' && rest[0].n === 1,
    JSON.stringify(rest));
  const pl = t.placement;
  check('the caption totals cover every pickup in the window (7), the empty-address ones included',
    pl.total === 7 && pl.placed === 6 && t.areas.reduce((s, a) => s + a.n, 0) === 7, JSON.stringify(pl));
  check('…in ladder order, in the words the resolver owns',
    JSON.stringify(pl.by_basis) === JSON.stringify([
      { basis: 'address', label: 'from the address', n: 3 },
      { basis: 'address_name', label: 'named from the address text', n: 2 },
      { basis: 'tracker', label: "placed by the car's tracker at the request time", n: 1 }]),
    JSON.stringify(pl.by_basis));
  check('…and the residual by reason', JSON.stringify(pl.unplaced) === JSON.stringify([
    { reason: 'no_address+no_fix', label: 'no address, and no tracker fix within 5 minutes', n: 1 }]), JSON.stringify(pl.unplaced));
}

console.log('\na booking the resolver has not reached');
{
  await trip(BB, 19);                                         // dash form: falls back to place_area
  await trip('Al Zarouni Block A Al Muraqqabat Deira AE', 20); // one-line: not read until the pass runs
  const t = await get(`/api/driver/territory?id=${DRV}&${W}`);
  check('a dash-form address is read by place_area() meanwhile — nothing reads worse than before',
    t.areas.find((a) => a.area === 'Business Bay')?.n === 7);
  const p = t.areas.find((a) => a.reason === 'pending');
  check('the one-line address is "not placed yet", not guessed and not "(unparsed)"',
    p?.n === 1 && /^Not placed yet/.test(p.label) && t.placement.unplaced.some((u) => u.reason === 'pending'),
    JSON.stringify(p));
  /* A second pass: the sweep re-checks this window and the new rows are read. */
  await q(`DELETE FROM source_state WHERE source = 'trip_places'`);
  await resolveTripPlaces(db, { budgetMs: 60_000 });
  const t2 = await get(`/api/driver/territory?id=${DRV}&${W}`);
  check('after the pass the pending row is gone', !t2.areas.some((a) => a.reason === 'pending'), JSON.stringify(t2.areas));
}

console.log('\nthe busiest drop-off areas, the same way, over completed trips');
{
  /* The operator: "also show dropoff areas the same way". The same ladder,
     the other end — and only over trips somebody rode: a cancelled booking
     here carries a drop-off address, and must not be counted where this
     driver ends up. */
  const add = (id, hour, status, dropoff, ended) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at,
                       distance_km, status, price, pickup_addr, dropoff_addr)
     VALUES ('uber', $1, 'ecosine', 'L47001', $2, 'Noor Test', $3, $4, 8, $5, 30, $6, $7)`,
    [id, DRV, `2026-11-12T${hour}:00:00+04:00`, ended ? `2026-11-12T${hour}:20:00+04:00` : null, status, BB, dropoff]);
  await add('d-marina', '21', 'completed', 'Marina Walk - Dubai Marina - Dubai - United Arab Emirates', true);
  await add('d-cancel', '22', 'rider_cancelled', 'Cluster A - Jumeirah Lake Towers - Dubai - United Arab Emirates', false);
  await add('d-track', '23', 'completed', '', true);
  // the car's tracker, a minute after the 23:20 drop-off, in Business Bay
  await q(`INSERT INTO telemetry_snapshot (source, plate, captured_at, lat, lng)
           VALUES ('fms', 'L47001', '2026-11-12T23:21:00+04:00', 25.185, 55.27)`);
  await q(`DELETE FROM source_state WHERE source = 'trip_places'`);
  await resolveTripPlaces(db, { budgetMs: 60_000 });
  const t = await get(`/api/driver/territory?id=${DRV}&${W}`);
  const d = t.dropoff_areas || [];
  check('the route answers with drop-off areas and their placement', Array.isArray(t.dropoff_areas) && t.dropoff_placement,
    JSON.stringify(Object.keys(t)));
  check('a dash-form drop-off is in its area, from the address',
    d.find((a) => a.area === 'Dubai Marina')?.by_basis?.address === 1, JSON.stringify(d));
  check('an empty drop-off the tracker saw a minute later is in Business Bay, by the tracker',
    d.find((a) => a.area === 'Business Bay')?.by_basis?.tracker === 1, JSON.stringify(d));
  check('the cancelled booking\'s drop-off address is not counted — nobody was dropped there',
    !d.some((a) => a.area === 'Jumeirah Lake Towers') && !d.some((a) => a.reason === 'cancelled'), JSON.stringify(d));
  const dp = t.dropoff_placement;
  check('the caption covers every completed trip (11), and only those',
    dp.total === 11 && dp.placed === 2 && d.reduce((s, a) => s + a.n, 0) === 11, JSON.stringify(dp));
  check('…in the drop-off\'s own words: the tracker at the drop-off time',
    dp.by_basis.find((b) => b.basis === 'tracker')?.label === "placed by the car's tracker at the drop-off time", JSON.stringify(dp.by_basis));
  check('no drop-off row is "(unparsed)"; the rest is one row named by its reason',
    !d.some((a) => a.area === '(unparsed)') && d.filter((a) => !a.area).length === 1
      && d.find((a) => !a.area)?.label === 'Not placed — no address, and no tracker fix within 5 minutes', JSON.stringify(d.filter((a) => !a.area)));
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
