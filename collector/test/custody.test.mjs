// Vehicle→driver custody: every vehicle fact should be able to name a person.
// Tested against real Postgres with a handover scenario (two drivers, one car, one day).
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

const day = '2026-08-20';
const mk = (id, plate, drv, name, hour, km = 10, price = 40) =>
  q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,distance_km,price,status)
     VALUES ('uber',$1,'ecosine',$2,$3,$4,$5,$6,$7,'completed')`,
    [id, plate, drv, name, `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`, km, price]);

// L100: handover — Alice 6 trips (morning), Bob 2 trips (evening)
for (let i = 0; i < 6; i++) await mk(`a${i}`, 'L100', 'drv-alice', 'Alice Ahmed', 7 + i);
for (let i = 0; i < 2; i++) await mk(`b${i}`, 'L100', 'drv-bob', 'Bob Khan', 19 + i);
// L200: single driver, and a plate written with a space (normalisation check)
for (let i = 0; i < 4; i++) await mk(`c${i}`, 'L 200', 'drv-carl', 'Carl Said', 9 + i);

// ── derive custody (mirrors src/custody.js) ──
await q(
  `INSERT INTO vehicle_driver_day
     (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, km, revenue, first_trip_at, last_trip_at)
   SELECT upper(replace(plate,' ','')), (requested_at AT TIME ZONE 'Asia/Dubai')::date,
          driver_ext_id, platform, max(driver_name), max(fleet_id), count(*)::int,
          round(sum(distance_km)::numeric,1)::double precision, round(sum(price)::numeric,2),
          min(requested_at), max(requested_at)
   FROM trip
   WHERE plate IS NOT NULL AND plate <> '' AND driver_ext_id IS NOT NULL
   GROUP BY 1,2,3,4
   ON CONFLICT (plate,day,driver_ext_id,platform) DO UPDATE SET trips=EXCLUDED.trips`);

await q(
  `WITH ranked AS (
     SELECT plate, day, driver_ext_id, platform,
            row_number() OVER (PARTITION BY plate, day ORDER BY trips DESC, first_trip_at ASC) rn
     FROM vehicle_driver_day)
   UPDATE vehicle_driver_day v SET is_primary = (r.rn = 1)
   FROM ranked r WHERE v.plate=r.plate AND v.day=r.day
     AND v.driver_ext_id=r.driver_ext_id AND v.platform=r.platform`);

const all = await q('SELECT plate, driver_name, trips, is_primary FROM vehicle_driver_day ORDER BY plate, trips DESC');
check('custody rows derived', all.length === 3, JSON.stringify(all));
check('plate normalised (L 200 → L200)', all.some((r) => r.plate === 'L200'), JSON.stringify(all.map(r => r.plate)));

const l100 = all.filter((r) => r.plate === 'L100');
check('handover keeps both drivers', l100.length === 2, JSON.stringify(l100));
const primary = l100.find((r) => r.is_primary);
check('primary is the driver with most trips', primary?.driver_name === 'Alice Ahmed', JSON.stringify(primary));
check('secondary driver not marked primary', l100.filter((r) => r.is_primary).length === 1);

// ── the view every vehicle screen reads ──
const cur = await q('SELECT plate, driver_name, trips FROM vehicle_current_driver ORDER BY plate');
check('current-driver view has one row per plate', cur.length === 2, JSON.stringify(cur));
check('L100 current driver is Alice', cur.find((r) => r.plate === 'L100')?.driver_name === 'Alice Ahmed');
check('L200 current driver is Carl', cur.find((r) => r.plate === 'L200')?.driver_name === 'Carl Said');

// ── vehicle facts can now name a person ──
const joined = await q(
  `SELECT t.plate, count(*)::int trips, cd.driver_name AS current_driver
   FROM trip t LEFT JOIN vehicle_current_driver cd ON cd.plate = upper(replace(t.plate,' ',''))
   GROUP BY t.plate, cd.driver_name ORDER BY t.plate`);
check('every vehicle row carries a driver name', joined.every((r) => !!r.current_driver), JSON.stringify(joined));

// ── the mirror: which cars did a driver use ──
const bobCars = await q(
  `SELECT plate, sum(trips)::int trips FROM vehicle_driver_day WHERE driver_ext_id='drv-bob' GROUP BY plate`);
check('driver→vehicle lookup works', bobCars.length === 1 && bobCars[0].plate === 'L100', JSON.stringify(bobCars));

// ── idempotency: rebuilding must not duplicate ──
await q(
  `INSERT INTO vehicle_driver_day
     (plate, day, driver_ext_id, platform, driver_name, trips)
   SELECT upper(replace(plate,' ','')), (requested_at AT TIME ZONE 'Asia/Dubai')::date,
          driver_ext_id, platform, max(driver_name), count(*)::int
   FROM trip WHERE plate IS NOT NULL AND driver_ext_id IS NOT NULL GROUP BY 1,2,3,4
   ON CONFLICT (plate,day,driver_ext_id,platform) DO UPDATE SET trips=EXCLUDED.trips`);
const after = await q('SELECT count(*)::int n FROM vehicle_driver_day');
check('rebuild is idempotent', after[0].n === 3, JSON.stringify(after[0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
