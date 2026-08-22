/* ── a precomputed answer has to be the same answer ────────────────────────
   Four endpoints took six to twenty-one seconds because they aggregate the
   whole trip history with no window. The result is identical for every viewer
   and changes only when the collector writes, so it is now computed once in
   the background and the pages read it.

   That trade is only worth making if the stored number equals the number the
   live query would have produced. A slow page is an annoyance; a fast page
   showing a subtly different total is a bug with nothing about it that looks
   wrong — nobody re-derives a figure that renders instantly.

   So these tests do not check that the rollup is populated. They run both the
   rollup and the query it replaced, over a fixture built to contain every
   trap this codebase has hit, and assert the two agree. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshRollups, rollupState } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const N = (v) => (v == null ? null : Number(v));
/* A Postgres `date` arrives as a JS Date, so String(month) is "Sat Aug 01 2026"
   and every startsWith('2026-08') is false — a trap this codebase has hit
   before, and which here made a correct rollup look broken. */
const ym = (d) => new Date(d).toISOString().slice(0, 7);

await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

/* The fixture carries, on purpose:
     - the same human under two spellings and on two platforms, so a distinct
       driver count that folds correctly differs from one that does not;
     - an FMS telematics row, which is the twin of a booking already counted;
     - an odometer distance of 193,027 km, the real value that broke km sums;
     - a complimentary ride, which has a price and is not revenue;
     - a trip with no fleet_id, which GROUPING SETS must not file under "all". */
let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, distance_km, status, price, payment_type)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [o.platform || 'uber', `x${n++}`, o.fleet === undefined ? 'ecosine' : o.fleet,
   o.plate || 'L100', o.drv || 'd-1', o.name || 'Ali Rahman',
   o.at || '2026-08-10T09:00:00+04:00', o.km ?? 12, o.status || 'completed',
   o.price ?? null, o.pay || 'card']);

for (let i = 0; i < 6; i++) await trip({ at: `2026-08-1${i}T09:00:00+04:00` });
// The same person, other spelling, other platform, other id.
for (let i = 0; i < 4; i++) await trip({ platform: 'yango', drv: 'y-9', name: 'ali  rahman', at: `2026-08-1${i}T14:00:00+04:00` });
// A second, genuinely different person.
for (let i = 0; i < 3; i++) await trip({ drv: 'd-2', name: 'Sara Iqbal', plate: 'L200', at: `2026-07-0${i + 1}T09:00:00+04:00` });
await trip({ platform: 'fms', km: 193027, name: 'Ali Rahman', at: '2026-08-10T09:05:00+04:00' });
await trip({ price: 250, pay: 'foc-complimentary', at: '2026-08-12T11:00:00+04:00' });
await trip({ price: 88, at: '2026-08-12T12:00:00+04:00' });
await trip({ fleet: null, plate: 'L300', drv: 'd-3', name: 'Omar Nadir', at: '2026-08-13T09:00:00+04:00' });
await trip({ fleet: 'egari', plate: 'L400', drv: 'd-4', name: 'Zaid Khan', at: '2026-08-14T09:00:00+04:00' });

await refreshRollups({ db });

console.log('\nrollup: the stored answer equals the live one');

/* The query /api/trend/monthly and /api/forecast actually run, against the
   view, with no rollup involved. */
const live = await q(
  `SELECT date_trunc('month', local_day)::date AS month,
          count(*)::int trips,
          count(*) FILTER (WHERE is_booking)::int bookings,
          count(DISTINCT plate)::int vehicles,
          count(DISTINCT plate) FILTER (WHERE is_booking)::int earning_vehicles,
          count(*) FILTER (WHERE driver_ext_id IS NOT NULL AND is_booking)::int attributed_trips,
          round(sum(price) FILTER (WHERE has_fare)::numeric,2) revenue,
          count(*) FILTER (WHERE has_fare)::int priced_trips,
          round(sum(distance_km) FILTER (WHERE has_distance AND is_booking)::numeric,1) km,
          count(*) FILTER (WHERE outcome='completed')::int completed
   FROM trip_norm GROUP BY 1 ORDER BY 1`);
const stored = await q(
  `SELECT month, trips, bookings, vehicles, earning_vehicles, attributed_trips,
          revenue, priced_trips, km, completed
   FROM rollup_month WHERE platform = '*' AND fleet_id = '*' ORDER BY month`);

check('the rollup has a row for every month the live query returns',
  stored.length === live.length, `${stored.length} vs ${live.length}`);
for (const key of ['trips', 'bookings', 'vehicles', 'earning_vehicles', 'attributed_trips',
  'revenue', 'priced_trips', 'km', 'completed']) {
  const bad = live.filter((l, i) => N(l[key]) !== N(stored[i]?.[key]))
    .map((l, i) => `${ym(l.month)} ${key}: live=${l[key]} stored=${stored[i]?.[key]}`);
  check(`${key} matches the live aggregate in every month`, bad.length === 0, bad.join(' | '));
}

/* The distinct count is the one a rollup gets wrong, in two different ways at
   once: summing per-day rows counts a driver once per day worked, and summing
   per-platform rows counts one human twice for being on two platforms. */
const [liveDrv] = await q(
  `SELECT count(DISTINCT t.person_key)::int drivers
   FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
   WHERE n.is_booking AND date_trunc('month', n.local_day)::date = '2026-08-01'
     AND t.person_key IS NOT NULL AND t.person_key <> ''`);
const [storedDrv] = await q(
  `SELECT drivers FROM rollup_month WHERE month='2026-08-01' AND platform='*' AND fleet_id='*'`);
check('the folded driver count matches, rather than being summed from the parts',
  N(storedDrv.drivers) === N(liveDrv.drivers), `stored=${storedDrv.drivers} live=${liveDrv.drivers}`);
const sumOfPlatforms = (await q(
  `SELECT sum(drivers)::int s FROM rollup_month
   WHERE month='2026-08-01' AND platform <> '*' AND fleet_id='*'`))[0].s;
check('and summing the per-platform rows would have been wrong, which is why it is not done',
  N(sumOfPlatforms) > N(storedDrv.drivers),
  `sum of platforms=${sumOfPlatforms} correct=${storedDrv.drivers}`);

console.log('\nrollup: the traps the fixture carries');

const [aug] = await q(`SELECT * FROM rollup_month WHERE month='2026-08-01' AND platform='*' AND fleet_id='*'`);
check('an odometer row does not reach the km total',
  N(aug.km) < 5000, `km=${aug.km}`);
check('a telematics journey is counted separately from the booking it duplicates',
  N(aug.telematics) === 1 && N(aug.bookings) === N(aug.trips) - 1,
  `trips=${aug.trips} bookings=${aug.bookings} telematics=${aug.telematics}`);
check('a complimentary ride carries a price and is not revenue',
  N(aug.revenue) === 88, `revenue=${aug.revenue}`);

/* GROUPING SETS puts NULL in the columns a set did not group by, and a trip
   with no fleet_id also has NULL there. Filing the second under '*' would count
   it in the totals twice. */
const fleets = await q(
  `SELECT fleet_id, trips FROM rollup_month WHERE month='2026-08-01' AND platform='*' ORDER BY fleet_id`);
check('a trip with no fleet is its own bucket, not folded into "all fleets"',
  fleets.some((r) => r.fleet_id === 'unknown'), fleets.map((r) => `${r.fleet_id}=${r.trips}`).join(' '));
check('and the "all fleets" row still counts it exactly once',
  N(fleets.find((r) => r.fleet_id === '*').trips)
    === fleets.filter((r) => r.fleet_id !== '*').reduce((a, r) => a + N(r.trips), 0),
  fleets.map((r) => `${r.fleet_id}=${r.trips}`).join(' '));

console.log('\nrollup: person-month, and refreshing twice');

const pm = await q(`SELECT person_key, month, bookings, platforms FROM rollup_person_month ORDER BY person_key, month`);
check('the same human on two platforms is one person-month row, not two',
  pm.filter((r) => r.person_key === 'ali rahman' && ym(r.month) === '2026-08').length === 1,
  JSON.stringify(pm.map((r) => `${r.person_key}/${ym(r.month)}`)));
const ali = pm.find((r) => r.person_key === 'ali rahman' && ym(r.month) === '2026-08');
check('and that row carries both platforms\' work',
  (ali.platforms || []).includes('uber') && (ali.platforms || []).includes('yango'),
  JSON.stringify(ali.platforms));

/* A refresh is an upsert, not an append. Run twice with no new trips, the
   numbers must not move — the failure mode being doubled totals that look
   like growth. */
const before = await q(`SELECT month, platform, fleet_id, trips FROM rollup_month ORDER BY 1,2,3`);
await refreshRollups({ db });
const after = await q(`SELECT month, platform, fleet_id, trips FROM rollup_month ORDER BY 1,2,3`);
check('refreshing twice changes nothing and adds no rows',
  JSON.stringify(before) === JSON.stringify(after),
  `${before.length} rows before, ${after.length} after`);

/* New data has to land. A rollup that silently stops updating leaves the pages
   reading last week's numbers with no way to tell. */
await trip({ at: '2026-08-15T09:00:00+04:00', plate: 'L500', drv: 'd-9', name: 'New Person' });
await refreshRollups({ db });
const [grown] = await q(`SELECT trips, drivers FROM rollup_month WHERE month='2026-08-01' AND platform='*' AND fleet_id='*'`);
check('a new trip appears in the rollup after the next refresh',
  N(grown.trips) === N(aug.trips) + 1, `${aug.trips} -> ${grown.trips}`);
check('and a new person raises the folded driver count by exactly one',
  N(grown.drivers) === N(aug.drivers) + 1, `${aug.drivers} -> ${grown.drivers}`);

console.log('\nrollup: it says how old it is');

const state = await rollupState(db);
check('every rollup records a state row', state.length === 3, JSON.stringify(state.map((s) => s.name)));
check('all three succeeded', state.every((s) => s.status === 'ok'),
  state.filter((s) => s.status !== 'ok').map((s) => `${s.name}: ${s.error}`).join(' | '));
check('each records what it covers, so a page can date the answer it shows',
  state.every((s) => s.covers_from && s.covers_to && s.finished_at));
check('and how long it took, so a rollup that is getting slower is visible',
  state.every((s) => Number.isFinite(Number(s.duration_ms))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
