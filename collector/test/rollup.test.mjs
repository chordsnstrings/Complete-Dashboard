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

console.log('\nrollup: incremental equals full');

/* A full rebuild reads every trip ever collected — about eighty seconds on this
   fleet — and running it every fifteen minutes on the database the API reads
   from was measurable at the other end: /api/playbook went from 9.3s to 11.1s
   while a refresh was in flight. Making pages faster by starving them is not
   making them faster, so the frequent pass only recomputes recent buckets.

   That is only safe if a narrow pass agrees with a wide one about the buckets
   it touches, and leaves the rest exactly as they were. */
{
  // A day inside the narrow window, and one well outside it.
  await trip({ at: '2026-08-20T09:00:00+04:00', plate: 'L600', drv: 'd-20', name: 'Recent Person' });
  await trip({ at: '2026-01-05T09:00:00+04:00', plate: 'L700', drv: 'd-21', name: 'Ancient Person' });
  await refreshRollups({ db });                       // full, so both land

  const fullSnapshot = await q(
    `SELECT month, platform, fleet_id, trips, drivers, revenue FROM rollup_month ORDER BY 1,2,3`);

  /* Now change history on both sides of the window and refresh narrowly. The
     recent change must appear; the ancient one must not — because a narrow
     pass that silently rewrote old buckets from a partial scan would zero
     them, which is the worst possible failure here. */
  await trip({ at: '2026-08-21T09:00:00+04:00', plate: 'L601', drv: 'd-22', name: 'Newer Person' });
  const daysBack = Math.ceil((Date.now() - Date.parse('2026-08-01')) / 864e5) + 1;
  await refreshRollups({ db, days: daysBack });

  const jan = (await q(
    `SELECT trips FROM rollup_month WHERE month='2026-01-01' AND platform='*' AND fleet_id='*'`))[0];
  const janBefore = fullSnapshot.find((r) => ym(r.month) === '2026-01' && r.platform === '*' && r.fleet_id === '*');
  check('a bucket outside the window is left exactly as it was, not rebuilt from a partial scan',
    N(jan?.trips) === N(janBefore?.trips), `${janBefore?.trips} -> ${jan?.trips}`);

  const augNarrow = (await q(
    `SELECT trips, drivers FROM rollup_month WHERE month='2026-08-01' AND platform='*' AND fleet_id='*'`))[0];
  await refreshRollups({ db });   // full
  const augFull = (await q(
    `SELECT trips, drivers FROM rollup_month WHERE month='2026-08-01' AND platform='*' AND fleet_id='*'`))[0];
  check('and a bucket inside the window gets the same answer either way',
    N(augNarrow.trips) === N(augFull.trips) && N(augNarrow.drivers) === N(augFull.drivers),
    `narrow trips=${augNarrow.trips}/drivers=${augNarrow.drivers} full trips=${augFull.trips}/drivers=${augFull.drivers}`);

  /* The distinct count is the one that a narrow pass could get wrong in a way
     a sum would not: it must be recomputed over the whole bucket, not over the
     window's slice of it. */
  /* The trap this nearly shipped with. The narrow pass filters on local_day,
     but the MONTH grain groups by month — so a window starting mid-month
     rebuilds the whole August bucket from the fortnight inside the window and
     silently halves it. The window above happened to cover all of August,
     which is exactly why it passed and proved nothing. */
  await refreshRollups({ db, days: 5 });
  const augPartial = (await q(
    `SELECT trips FROM rollup_month WHERE month='2026-08-01' AND platform='*' AND fleet_id='*'`))[0];
  check('a window starting mid-month still rebuilds the whole month, not its tail',
    N(augPartial.trips) === N(augFull.trips),
    `5-day window gave ${augPartial.trips}, whole month is ${augFull.trips}`);

  /* And the person grain, which is month-keyed too: a person's August row
     rebuilt from five days of August is a person who worked five days. */
  const aliAug = (await q(
    `SELECT bookings FROM rollup_person_month WHERE person_key='ali rahman' AND month='2026-08-01'`))[0];
  await refreshRollups({ db });
  const aliFull = (await q(
    `SELECT bookings FROM rollup_person_month WHERE person_key='ali rahman' AND month='2026-08-01'`))[0];
  check('a person-month row survives a narrow pass with its whole month intact',
    N(aliAug?.bookings) === N(aliFull?.bookings),
    `narrow=${aliAug?.bookings} full=${aliFull?.bookings}`);

  const [liveAug] = await q(
    `SELECT count(DISTINCT t.person_key)::int drivers
     FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
     WHERE n.is_booking AND date_trunc('month', n.local_day)::date = '2026-08-01'
       AND t.person_key IS NOT NULL AND t.person_key <> ''`);
  check('the folded driver count is over the whole bucket, not the window\'s slice of it',
    N(augNarrow.drivers) === N(liveAug.drivers),
    `narrow=${augNarrow.drivers} live=${liveAug.drivers}`);
}

console.log('\nrollup: the planner is told what changed');

/* A generated column arrives with NO statistics — Postgres has never seen its
   distribution — so every plan touching person_key was chosen blind, and one
   of them picked an index scan over most of the table and cost
   /api/drivers/directory a tenfold regression. Autovacuum gets there
   eventually; eventually is an hour of slow pages after a deploy. */
{
  const src = (await import('node:fs')).readFileSync('src/rollup.js', 'utf8');
  check('the refresh analyzes the tables it just rewrote, and trip with them',
    /ANALYZE trip, rollup_day, rollup_month, rollup_person_month/.test(src));
  check('and a failed analyze is a warning, not a failed rollup — stale plans are slow, not wrong',
    /analyze failed — plans may be stale/.test(src));
  // It must actually run, not merely be present in a string.
  const [stats] = await q(
    `SELECT count(*)::int n FROM pg_stats WHERE tablename = 'trip' AND attname = 'person_key'`);
  check('and person_key has statistics after a refresh, rather than none at all',
    N(stats.n) > 0, `pg_stats rows for trip.person_key: ${stats.n}`);
}

console.log('\nrollup: two refreshes do not race');

/* Three things start a refresh — the boot pass, the quarter-hourly cron, and
   the end of every collection run — and on the first deploy two overlapped.
   Both do INSERT ... ON CONFLICT DO UPDATE over the same rows, and two such
   passes touching them in different orders deadlock. Production reported
   rollup_month status=error, "deadlock detected": Postgres correctly refusing
   to corrupt anything, and this code wrong to have asked.

   Overlap is not worth propagating as an error, because the second pass would
   compute exactly what the first already is. It joins the first instead. */
{
  const seen = (await q(`SELECT month, trips FROM rollup_month
                         WHERE platform='*' AND fleet_id='*' ORDER BY month`));
  const [a, b, c] = await Promise.all([
    refreshRollups({ db }), refreshRollups({ db }), refreshRollups({ db }),
  ]);
  check('three concurrent refreshes all resolve rather than deadlocking',
    Array.isArray(a) && Array.isArray(b) && Array.isArray(c));
  check('and the overlapping callers get the same result as the one that ran',
    JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(b) === JSON.stringify(c));
  check('none of the three reports a failure',
    [a, b, c].every((r) => r.every((x) => !x.error)),
    JSON.stringify([a, b, c].flat().filter((x) => x.error)));
  const after = (await q(`SELECT month, trips FROM rollup_month
                          WHERE platform='*' AND fleet_id='*' ORDER BY month`));
  check('and the numbers are unchanged, not tripled by three passes',
    JSON.stringify(seen) === JSON.stringify(after));
  /* The guard has to clear, or the first refresh is the only one this process
     ever runs — which would be a far quieter failure than a deadlock. */
  const later = await refreshRollups({ db });
  check('a refresh after the others finish still runs, so the guard is not a latch',
    Array.isArray(later) && later.every((x) => !x.error));
}

console.log('\nrollup: it says how old it is');

const state = await rollupState(db);
// Five passes: the three trip grains, the payout-day materialisation, and the
// on-trip statement derivation.
check('every rollup records a state row', state.length === 5, JSON.stringify(state.map((s) => s.name)));
check('the payout pass is one of them', state.some((r) => r.name === 'driver_payout_day'));
check('and the statement pass beside it', state.some((r) => r.name === 'driver_statement_day'));
check('all three succeeded', state.every((s) => s.status === 'ok'),
  state.filter((s) => s.status !== 'ok').map((s) => `${s.name}: ${s.error}`).join(' | '));
check('each records what it covers, so a page can date the answer it shows',
  state.every((s) => s.covers_from && s.covers_to && s.finished_at));
check('and how long it took, so a rollup that is getting slower is visible',
  state.every((s) => Number.isFinite(Number(s.duration_ms))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
