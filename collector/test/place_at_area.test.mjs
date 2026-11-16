/* A tracker fix named in the bookings' words first (2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   On production the car's "Where it was" stays (and so the overnight table)
   read "397 D90", "S-02, Mayfair Residence Tower Opp. Empower" — place_cell,
   FMS's reverse geocoder, names roads and buildings. placeAtArea
   (api/place_sql.js) names a fix by booking_cell — the area drop-off
   addresses give the cell — and falls back to place_cell. Held on PGlite:

     1. a cell both name → booking_cell's area, by 'bookings', its votes;
     2. a cell only place_cell names → that name, by 'tracker';
     3. a cell neither names → NULL (absent, never the nearest name);
     4. the name is folded to one per area ("Marsa Dubai" → Dubai Marina);
     5. GET /api/vehicle/whereabouts names a stay by it.

   REVERSIONS (each run, each failing as named):
     · WHERE_FIX_COLS back on placeAt → §5 fails
     · the coalesce order swapped (place_cell first) → §1 fails
     · canonAreaSql dropped → §4 fails */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { placeAtArea } from '../api/place_sql.js';
import { CELL } from '../src/places.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

const cell = (lat, lng) => [Math.round(lat / CELL), Math.round(lng / CELL)];
const A = [25.185, 55.27], B = [25.08, 55.14], C = [25.30, 55.40], D = [25.20, 55.30];
await q(`INSERT INTO booking_cell (cell_lat, cell_lng, area, n, distinct_names, observations) VALUES ($1,$2,'Business Bay',41,2,44)`, cell(...A));
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations, built_at) VALUES ($1,$2,'Marasi Dr',9,3,12,now())`, cell(...A));
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations, built_at) VALUES ($1,$2,'397 D90',5,1,5,now())`, cell(...B));
await q(`INSERT INTO booking_cell (cell_lat, cell_lng, area, n, distinct_names, observations) VALUES ($1,$2,'Marsa Dubai',30,1,30)`, cell(...D));
const at = async ([lat, lng]) => (await q(`SELECT ${placeAtArea('$1::float8', '$2::float8')} AS p`, [lat, lng]))[0].p;

const a = await at(A), b = await at(B), c = await at(C), d = await at(D);
check('1. both name the cell → the bookings\' area, by bookings, its votes',
  a?.area === 'Business Bay' && a.by === 'bookings' && a.votes === 41, JSON.stringify(a));
check('2. only place_cell names it → that name, by tracker', b?.area === '397 D90' && b.by === 'tracker', JSON.stringify(b));
check('3. neither names it → NULL', c === null, JSON.stringify(c));
check('4. folded to one name per area: "Marsa Dubai" → Dubai Marina', d?.area === 'Dubai Marina', JSON.stringify(d));

/* 5. the route: a CABMAN car parked in cell A all morning. */
for (let m = 0; m <= 240; m += 60) {
  await q(`INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, lat, lng, speed)
           VALUES ('cabman', 'L47003', 'ecosine', $1, $2, $3, 0)`,
  [new Date(Date.parse('2026-11-12T06:00:00+04:00') + m * 60e3).toISOString(), A[0], A[1]]);
}
const { server, get } = await mountAll(db, { serverRoutes: false });
const r = await get('/api/vehicle/whereabouts?plate=L47003&day=2026-11-12');
const stays = r.body?.days?.[0]?.stays || [];
check('5. the whereabouts stay is named Business Bay, not the road', stays.length > 0 && stays.every((s) => s.area === 'Business Bay'),
  JSON.stringify(stays.map((s) => s.area)) + ' ' + JSON.stringify(r.body).slice(0, 160));
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
