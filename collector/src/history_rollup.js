/* The two day roll-ups the hero sparklines need, and nothing else.
   ─────────────────────────────────────────────────────────────────────────
   sql/schema_v119.sql says what each table holds and why the existing ones
   could not answer. This module writes them; api/history_routes.js reads them.
   Kept out of src/rollup.js's body because that file is the trip grains and
   the money tables, each with its own ordering argument, and neither of these
   depends on any of them: they read collector-written tables only
   (driver_timeline_event, and trip through the trip_cash view), so they can
   sit anywhere in the pass. refreshRollupsInner calls them through runOne,
   which records a state row per pass and catches a failure so it can never
   take the other passes down with it.

   Both follow the shape refreshOnlineHours already proved on production:
     · upsert every row the bound reaches (ON CONFLICT DO UPDATE);
     · then delete, inside the same bound only, the rows this pass did not
       rewrite — a timeline event withdrawn, a trip that stopped being a
       completed cash trip — so the table never keeps a row its source no
       longer supports;
     · then record when the pass READ the source and how far back the table
       is built, in history_rollup_build, so the reader can tell "not built
       yet" from "nobody". Written last, so a pass that fails half way leaves
       the previous build's claim standing rather than a claim about rows it
       never finished writing. */
import { pool } from './db.js';

const TZ = 'Asia/Dubai';

/* `since` is a Dubai day (YYYY-MM-DD) or null for everything. */
async function recordBuild(db, name, t0, since) {
  await db.query(
    `INSERT INTO history_rollup_build (name, read_at, built_from, finished_at)
     VALUES ($1, $2::timestamptz, $3::date, now())
     ON CONFLICT (name) DO UPDATE SET read_at = EXCLUDED.read_at,
       built_from = least(history_rollup_build.built_from, EXCLUDED.built_from),
       finished_at = EXCLUDED.finished_at`,
    [name, t0, since || '1900-01-01']);
}

/* THE FIRST ONLINE INSTANT OF EACH UBER ACCOUNT, EACH DUBAI DAY.
   ─────────────────────────────────────────────────────────────────────────
   /api/online-time computes, for the one day it is asked about, the earliest
   ONLINE status event per account inside that day (api/online_routes.js,
   STAGE TWO: `min(span_start) FILTER (WHERE span_start >= D0 AND span_start
   < D1)` over events with kind 'status', status <> '', status = 'ONLINE').
   A span starts at an ONLINE event, so that min is the min of the ONLINE
   events' own instants; lead() only matters to its other column
   (covered_midnight), which Late never reads. Stored here per account per
   day, Late for any start time and any span of days is one comparison at
   read time.

   The bound is on the event's own Dubai day, written as the expression
   sql/schema_v37.sql indexes (with fleet_id leading, which this cannot use —
   the same full read of the narrow table refreshOnlineHours makes). */
export async function refreshFirstOnline(db = pool, { since = null } = {}) {
  const [{ t0 }] = (await db.query('SELECT now() AS t0')).rows;
  const bound = since ? `AND (e.at AT TIME ZONE '${TZ}')::date >= $1::date` : '';
  const p = since ? [since] : [];
  await db.query(
    `INSERT INTO driver_first_online (platform, driver_ext_id, day, fleet_id, first_online_at, computed_at)
     SELECT e.platform, e.driver_ext_id, (e.at AT TIME ZONE '${TZ}')::date AS day,
            (array_agg(e.fleet_id ORDER BY e.at))[1], min(e.at), now()
       FROM driver_timeline_event e
      WHERE e.platform = 'uber' AND e.kind = 'status' AND e.status = 'ONLINE'
        AND coalesce(btrim(e.driver_ext_id), '') <> '' ${bound}
      GROUP BY 1, 2, 3
     ON CONFLICT (platform, driver_ext_id, day) DO UPDATE SET
       fleet_id = EXCLUDED.fleet_id, first_online_at = EXCLUDED.first_online_at,
       computed_at = EXCLUDED.computed_at`, p);
  await db.query(
    `DELETE FROM driver_first_online WHERE computed_at < $1::timestamptz
       ${since ? 'AND day >= $2::date' : ''}`, since ? [t0, since] : [t0]);
  await recordBuild(db, 'driver_first_online', t0, since);
  const { rows } = await db.query('SELECT count(*)::int n FROM driver_first_online');
  return rows[0].n;
}

/* CASH FARES BY ACCOUNT, CHANNEL AND DUBAI DAY.
   ─────────────────────────────────────────────────────────────────────────
   From the trip_cash view and nothing else, because /api/ledger/exposure's
   owes.cash_taken is sum(trip_cash.cash_amount) over a person's attached
   accounts (api/ledger_routes.js, the `taken` CTE) and a second definition of
   "a cash fare" is how the ceiling and its history would come to disagree —
   the view's own comment tells that story about the route.

   A trip with no driver id is left out: the exposure read joins on the
   account id, so such a trip can never reach anybody's ceiling either. */
export async function refreshCashFareDay(db = pool, { since = null } = {}) {
  const [{ t0 }] = (await db.query('SELECT now() AS t0')).rows;
  const bound = since ? `AND (t.requested_at AT TIME ZONE '${TZ}')::date >= $1::date` : '';
  const p = since ? [since] : [];
  await db.query(
    `INSERT INTO cash_fare_day (platform, driver_ext_id, day, fleet_id, trips, valued, value, computed_at)
     SELECT t.platform, t.driver_ext_id, (t.requested_at AT TIME ZONE '${TZ}')::date AS day,
            min(t.fleet_id), count(*)::int, count(t.cash_amount)::int, sum(t.cash_amount), now()
       FROM trip_cash t
      WHERE coalesce(btrim(t.driver_ext_id), '') <> '' AND t.requested_at IS NOT NULL ${bound}
      GROUP BY 1, 2, 3
     ON CONFLICT (platform, driver_ext_id, day) DO UPDATE SET
       fleet_id = EXCLUDED.fleet_id, trips = EXCLUDED.trips, valued = EXCLUDED.valued,
       value = EXCLUDED.value, computed_at = EXCLUDED.computed_at`, p);
  await db.query(
    `DELETE FROM cash_fare_day WHERE computed_at < $1::timestamptz
       ${since ? 'AND day >= $2::date' : ''}`, since ? [t0, since] : [t0]);
  await recordBuild(db, 'cash_fare_day', t0, since);
  const { rows } = await db.query('SELECT count(*)::int n FROM cash_fare_day');
  return rows[0].n;
}
