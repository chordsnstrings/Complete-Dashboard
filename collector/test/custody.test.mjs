/* Vehicle→driver custody: every vehicle fact should be able to name a person.
   Tested against real Postgres with a handover scenario (two drivers, one car,
   one day), plus the two shapes that used to fall out of it.

   This file used to reimplement the fold with a comment saying it "mirrors
   src/custody.js". It did not — the shipped one required driver_ext_id IS NOT
   NULL and so did the copy, and both were wrong in the same way, which is
   exactly what a mirror cannot detect. It now calls the real rebuild against
   the in-process database, so the thing under test is the thing that ships. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';
import { rebuildCustody } from '../src/custody.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

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

// L300: the hotel shape — a named driver the channel never gives an id for.
for (let i = 0; i < 3; i++)
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_name,requested_at,distance_km,price,status)
           VALUES ('hotel',$1,'ecosine','L300',$2,$3,12,90,'completed')`,
    [`h${i}`, 'Dana Noor', `${day}T${String(8 + i).padStart(2, '0')}:00:00+04:00`]);

// ── derive custody: the shipped rebuild, against this database ──
await rebuildCustody({ from: day, to: day, db });

const all = await q('SELECT plate, driver_ext_id, driver_name, trips, is_primary FROM vehicle_driver_day ORDER BY plate, trips DESC');
check('custody rows derived', all.length === 4, JSON.stringify(all));
check('plate normalised (L 200 → L200)', all.some((r) => r.plate === 'L200'), JSON.stringify(all.map(r => r.plate)));

const l100 = all.filter((r) => r.plate === 'L100');
check('handover keeps both drivers', l100.length === 2, JSON.stringify(l100));
const primary = l100.find((r) => r.is_primary);
check('primary is the driver with most trips', primary?.driver_name === 'Alice Ahmed', JSON.stringify(primary));
check('secondary driver not marked primary', l100.filter((r) => r.is_primary).length === 1);

// ── the view every vehicle screen reads ──
const cur = await q('SELECT plate, driver_name, trips FROM vehicle_current_driver ORDER BY plate');
check('current-driver view has one row per plate', cur.length === 3, JSON.stringify(cur));
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

/* ── a driver the provider names but never numbers ──────────────────────
   The hotel channel names a driver on every booking and does not always carry
   an id. Requiring one made those people vanish from custody entirely: absent
   from their vehicle's driver list, unattributable for a harsh-driving event,
   unnameable on an unauthorised segment. They key on a synthesised name: id,
   the same expression api/driver_routes.js uses, so the person their vehicle
   names is the person whose page opens when you click it. */
const dana = all.find((r) => r.driver_name === 'Dana Noor');
check('a named driver with no id still gets a custody row', !!dana, JSON.stringify(all.map((r) => r.driver_name)));
check('and keys on the synthesised name id', dana?.driver_ext_id === 'name:dana noor', String(dana?.driver_ext_id));
check('and is primary on their own vehicle', dana?.is_primary === true, JSON.stringify(dana));
check('L300 current driver is Dana', cur.find((r) => r.plate === 'L300')?.driver_name === 'Dana Noor', JSON.stringify(cur));

/* ── nobody at all is still nobody ──────────────────────────────────────
   An FMS telematics row is a journey with no driver on it in either column.
   The synthesised key must be NULL there, not the string "name:", or every
   telematics journey in the fleet folds into one phantom person who appears to
   drive every vehicle. */
await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,requested_at,distance_km,status)
         VALUES ('fms','f1','ecosine','L100',$1,300,'completed')`, [`${day}T12:00:00+04:00`]);
await rebuildCustody({ from: day, to: day, db });
const phantom = await q(`SELECT count(*)::int n FROM vehicle_driver_day WHERE driver_ext_id = 'name:'`);
check('a journey with no driver at all creates no custody row', phantom[0].n === 0, JSON.stringify(phantom[0]));

// ── idempotency: rebuilding must not duplicate ──
await rebuildCustody({ from: day, to: day, db });
const after = await q('SELECT count(*)::int n FROM vehicle_driver_day');
check('rebuild is idempotent', after[0].n === 4, JSON.stringify(after[0]));

/* ── the table is the view, materialised ────────────────────────────────
   custody_live is the definition; vehicle_driver_day is a window of it kept
   for the fleet-wide queries that cannot afford to re-aggregate trip. If the
   two ever disagree, every page reading the table is reading a stale answer
   while the page reading the view reads a different one. */
const drift = await q(
  `SELECT plate, day, driver_ext_id, platform FROM custody_live WHERE day = $1::date
   EXCEPT SELECT plate, day, driver_ext_id, platform FROM vehicle_driver_day WHERE day = $1::date`, [day]);
check('the materialised table matches its definition exactly', drift.length === 0, JSON.stringify(drift));
const backwards = await q(
  `SELECT plate, day, driver_ext_id, trips FROM vehicle_driver_day WHERE day = $1::date
   EXCEPT SELECT plate, day, driver_ext_id, trips FROM custody_live WHERE day = $1::date`, [day]);
check('and carries no row the definition does not produce', backwards.length === 0, JSON.stringify(backwards));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
