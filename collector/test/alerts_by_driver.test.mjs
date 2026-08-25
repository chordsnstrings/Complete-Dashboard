/* The safety page's per-driver table, before and after it stopped doing the
   work twice.
   ─────────────────────────────────────────────────────────────────────────
   /api/alerts/by-driver answers "who is triggering these events, and how often
   per hundred kilometres they actually drove". It was the slowest thing on the
   Safety page, and two of the reasons were work nobody had asked for:

     the three figures printed under the table — people, events, unattributed —
     were a SECOND query that replayed the whole alert scan and the whole
     windowed custody fold to arrive at three numbers;

     and the distance denominator was summed for every driver in the fleet, to
     decorate a hundred rows ranked by a number distance has no part in.

   Neither is a question of what the endpoint returns, so the only thing worth
   testing is that it returns the same thing. The old SQL is written out below;
   the new SQL is read out of api/server.js, because a copy of it here would
   drift and stop testing anything.

   The cap is lifted on both sides for the row comparison. ORDER BY alerts DESC
   has no tiebreak, so on the wide fleet — where hundreds of people carry one
   event each — WHICH hundred come back is the planner's choice and always was;
   comparing the full set asks the question that actually matters. The capped
   form is exercised separately, through the endpoint. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { seedFleet, DAY0, DAY1 } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll } from './mount.mjs';
import { JOIN_TRIP } from '../api/custody_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

// The server's own window predicate, which the route interpolates.
const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;

/* The shipped query, evaluated rather than pattern-matched: the route is one
   template literal, and reading it this way means a change to the SQL is a
   change to what this test compares. It also holds the house rule that a
   backtick may not appear inside it — a stray one would move the closing
   delimiter and this extraction would fail loudly. */
const src = readFileSync('api/server.js', 'utf8');
const route = src.slice(src.indexOf("app.get('/api/alerts/by-driver'"),
  src.indexOf('// Who was driving this plate'));
if (!route || route.length < 500) throw new Error('could not find the by-driver route in api/server.js');
const lit = route.slice(route.indexOf('`'), route.lastIndexOf('`') + 1);
// eslint-disable-next-line no-new-func
const NEW = new Function('DAYWIN', 'JOIN_TRIP', `return ${lit};`)(DAYWIN, JOIN_TRIP);

/* What shipped before: the list, and the population underneath it, as two
   separate round trips to the database. */
const OLD_ROWS = `WITH ev AS (
       SELECT plate, alert_type, (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day
       FROM alert WHERE ${DAYWIN('occurred_at')}
     ),
     custody AS (
       SELECT DISTINCT ON (plate, day) plate, day, driver_name, driver_ext_id, person_key
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
       ORDER BY plate, day, trips DESC NULLS LAST, driver_name
     ),
     km AS (
       SELECT t.person_key AS person, sum(n.distance_km) AS km
       FROM trip_norm n ${JOIN_TRIP}
       WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.has_distance
         AND n.driver_name IS NOT NULL AND btrim(n.driver_name) <> ''
       GROUP BY 1
     )
     SELECT coalesce(c.driver_name, '(unattributed)') AS driver_name,
            max(c.driver_ext_id) AS driver_ext_id,
            count(*)::int alerts,
            sum((ev.alert_type ILIKE '%brake%')::int)::int harsh_brake,
            sum((ev.alert_type ILIKE '%accel%')::int)::int harsh_accel,
            sum((ev.alert_type ILIKE '%turn%')::int)::int sharp_turn,
            sum((ev.alert_type ILIKE '%speed%')::int)::int overspeed,
            count(DISTINCT ev.plate)::int plates,
            (array_agg(DISTINCT ev.plate ORDER BY ev.plate))[1:3] AS plate_list,
            round(max(km.km)::numeric, 0) AS booked_km,
            round((count(*) * 100.0 / nullif(max(km.km), 0))::numeric, 2) AS per_100km
     FROM ev
     LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day
     LEFT JOIN km ON km.person = c.person_key
     GROUP BY 1 ORDER BY alerts DESC LIMIT 100`;

const OLD_TOTALS = `WITH ev AS (
       SELECT plate, (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day
       FROM alert WHERE ${DAYWIN('occurred_at')}),
     custody AS (
       SELECT DISTINCT ON (plate, day) plate, day, driver_name
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
       ORDER BY plate, day, trips DESC NULLS LAST, driver_name)
     SELECT count(DISTINCT c.driver_name)::int drivers,
            count(*)::int alerts,
            count(*) FILTER (WHERE c.driver_name IS NULL)::int unattributed
     FROM ev LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day`;

const CARRIED = ['_drivers', '_alerts', '_unattributed'];
/* `other` is new, and it is why this list can now be reconciled: six of sixty
   rows in production failed alerts == brake + accel + turn + overspeed, because
   anything the four ILIKE buckets miss was counted in the total and in no
   column — "(unattributed)" showed 1,852 of 2,314 events. by-vehicle has
   carried the residual since it was written. It is projected out of the
   rewrite comparison below, which is about the query rewrite preserving the
   values it already produced, and asserted on its own afterwards. */
const ADDED = ['other'];
const uncap = (s) => s.replace('LIMIT 100', '');
const bare = (r) => { const c = { ...r }; for (const k of [...CARRIED, ...ADDED]) delete c[k]; return c; };
// Order within a tie is the planner's, on both sides. Compare the sets.
const sorted = (rows) => rows.map((r) => JSON.stringify(Object.entries(bare(r)).sort())).sort();

async function compare(label, { wide }) {
  console.log(`\n${label}`);
  const db = new PGlite();
  await applySchema(db);
  await seedFleet(db, { wide });
  await rebuildCustody({ from: DAY0, to: DAY1, db });
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  /* Three binds now, not two: the route narrows alerts and custody by fleet.
     The Safety page carried a fleet chip that changed nothing —
     /api/alerts/summary with &fleet=egari was byte-identical to unfiltered on
     a two-fleet operator — and /api/kpis has always narrowed its own alert
     count by alert.fleet_id, so the tile and the page disagreed under a
     filter. NULL here means "every fleet", which is what this fixture is. */
  const P = [DAY0, DAY1, null];

  /* Events on a plate nobody was recorded driving. Every plate in both fixtures
     carries trips on every day, so without this the "(unattributed)" bucket —
     the one row whose person is unknown and whose distance therefore has no
     denominator — never appears, and the half of this query that handles a
     custody miss goes untested. */
  for (const i of [1, 2, 3])
    await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
             VALUES ('fms', $1, 'ecosine', 'NOBODY', 'Harsh Brake', $2)`,
    [`orphan-${i}`, `2026-08-0${i}T09:00:00+04:00`]);

  // The snapshots of what shipped before predate the fleet predicate, so they
  // take the two binds they were written with.
  const P2 = P.slice(0, 2);
  const before = await q(uncap(OLD_ROWS), P2);
  const after = await q(uncap(NEW), P);
  check('there are rows to compare at all', before.length > 0, String(before.length));
  check('the rewrite returns the same number of rows',
    before.length === after.length, `${before.length} vs ${after.length}`);
  check('and the same values, row for row',
    JSON.stringify(sorted(before)) === JSON.stringify(sorted(after)),
    JSON.stringify(sorted(after).filter((r) => !sorted(before).includes(r)).slice(0, 2)));

  /* The population figures the page prints underneath the table. They used to
     be their own query; they ride on the list now, and they must still be
     counted over everybody rather than over the rows that came back. */
  const [oldT] = await q(OLD_TOTALS, P2);
  const capped = await q(NEW, P);
  const newT = capped.length
    ? { drivers: capped[0]._drivers, alerts: capped[0]._alerts, unattributed: capped[0]._unattributed }
    : { drivers: 0, alerts: 0, unattributed: 0 };
  check('the population figures are what the second query used to say',
    JSON.stringify(oldT) === JSON.stringify(newT),
    `${JSON.stringify(oldT)} vs ${JSON.stringify(newT)}`);

  /* The residual, asserted on its own: every row must reconcile against its own
     total, which is the check six of sixty production rows failed. */
  check('every row\'s buckets sum to its own alert count',
    after.every((r) => r.harsh_brake + r.harsh_accel + r.sharp_turn + r.overspeed
      + r.other === r.alerts),
    JSON.stringify(after.filter((r) => r.harsh_brake + r.harsh_accel + r.sharp_turn
      + r.overspeed + r.other !== r.alerts).slice(0, 2)));
  check('and they are counted over every person, not over the capped list',
    newT.drivers >= capped.filter((r) => r.driver_name !== '(unattributed)').length,
    `${newT.drivers} vs ${capped.length}`);

  /* Through the endpoint, which is what the page receives. */
  const { get, server } = await mountAll(db);
  const res = await get(`/api/alerts/by-driver?from=${DAY0}&to=${DAY1}`);
  check('the endpoint answers 200', res.status === 200, String(res.status));
  const body = res.body || {};
  check('the figures it carried down the query are not in the rows',
    (body.rows || []).every((r) => CARRIED.every((k) => !(k in r))),
    JSON.stringify(Object.keys(body.rows?.[0] || {})));
  check('the response still reports totals, shown and truncated',
    body.totals && typeof body.shown === 'number' && typeof body.truncated === 'boolean',
    JSON.stringify({ totals: body.totals, shown: body.shown, truncated: body.truncated }));
  check('the totals it reports are the old two-query answer',
    JSON.stringify(body.totals) === JSON.stringify(oldT),
    `${JSON.stringify(body.totals)} vs ${JSON.stringify(oldT)}`);
  check('the list never exceeds its cap', body.rows.length <= 100, String(body.rows.length));
  check('a list at its cap says the fleet is bigger than the list',
    body.rows.length < 100 || body.truncated === true, String(body.truncated));
  /* Absence is an em-dash and a reason on the page, which needs a null here.
     Nobody holds the car on an unattributed event, so there is no person whose
     distance could be the denominator — and 0 km would read as a driver who
     did not move rather than as an event nobody can be named for. */
  const loose = body.rows.find((r) => r.driver_name === '(unattributed)');
  check('the events nobody was holding the car for are their own row', !!loose);
  check('an unattributed row has no booked distance rather than zero',
    loose && loose.booked_km === null && loose.per_100km === null, JSON.stringify(loose));
  check('and it is not counted as a person in the population',
    newT.drivers === capped.filter((r) => r.driver_name !== '(unattributed)').length
      || body.truncated, `${newT.drivers} named, ${capped.length} shown`);
  server.close();
  await db.close();
}

await compare('the fleet as seeded', { wide: false });
await compare('a fleet wider than the cap', { wide: true });

/* The join in the km CTE is not decoration and must not be "simplified" away:
   local_day, is_booking and has_distance live on trip_norm, person_key lives on
   trip, and a view's star is frozen at creation (sql/schema_v18.sql). Removing
   it means either losing the fold or copying the view's rules into the route. */
{
  const db = new PGlite();
  await applySchema(db);
  const cols = (await db.query(
    `SELECT attname FROM pg_attribute WHERE attrelid = 'trip_norm'::regclass AND attnum > 0`))
    .rows.map((r) => r.attname);
  check('trip_norm cannot supply person_key', !cols.includes('person_key'));
  check('and trip_norm is the only source of the columns the CTE filters on',
    ['local_day', 'is_booking', 'has_distance'].every((c) => cols.includes(c)));
  check('so the km CTE still joins the base table for the stored fold',
    /FROM trip_norm n \$\{JOIN_TRIP\}/.test(route) && /t\.person_key/.test(route));
  await db.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
