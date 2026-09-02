/* Background rollups: the aggregates that cost seconds, computed once.
   ─────────────────────────────────────────────────────────────────────────
   Four endpoints took between six and twenty-one seconds and they share a
   shape: they aggregate the ENTIRE trip history, with no window. /api/trend/
   monthly groups every trip ever collected by month, /api/forecast does that
   and then again by day, /api/retention groups every booking by person and
   month. No index helps, because the answer really does depend on every row.

   It is also the same answer for every viewer, and it only changes when the
   collector writes. So it is computed here, after each run, and the pages read
   the result.

   Three things this must not get wrong:

   1. A COUNT DISTINCT cannot be summed. Rolling days up into a month would
      report a driver who worked twenty days as twenty drivers, and summing
      per-platform rows would count one human on Uber and Yango as two — the
      exact bug the person fold exists to prevent. So every grain a page asks
      for is computed at that grain, including the '*' rows that mean "all
      platforms", which are computed and not derived.

   2. It must be verifiable. A precomputed number that quietly disagrees with
      the live query is worse than a slow page, because nothing about it looks
      wrong. test/rollup.test.mjs runs both and asserts they match.

   3. It must say how old it is. rollup_state records every run, and the API
      exposes it, so a page reading a cached answer can date it.  */
import { pool } from './db.js';
import { personKey } from '../api/custody_sql.js';
import { log } from './log.js';
import { dubaiIso } from './util.js';

const SRC = 'rollup';

/* The measures, written once and reused at both grains. `trip_norm` already
   resolves the traps these depend on — is_booking separates a platform booking
   from its telematics twin, has_distance rejects the odometer rows that read
   193,027 km, has_fare excludes complimentary rides — so the rollup inherits
   them rather than restating them and drifting. */
const MEASURES = `
  count(*)::int                                                            AS trips,
  count(*) FILTER (WHERE n.is_booking)::int                                AS bookings,
  count(*) FILTER (WHERE NOT n.is_booking)::int                            AS telematics,
  count(DISTINCT t.person_key) FILTER (WHERE n.is_booking
    AND t.person_key IS NOT NULL AND t.person_key <> '')::int              AS drivers,
  count(DISTINCT n.plate)::int                                             AS vehicles,
  count(DISTINCT n.plate) FILTER (WHERE n.is_booking)::int                 AS earning_vehicles,
  count(*) FILTER (WHERE n.driver_ext_id IS NOT NULL AND n.is_booking)::int AS attributed_trips,
  round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2)                AS revenue,
  count(*) FILTER (WHERE n.has_fare)::int                                  AS priced_trips,
  round(sum(n.distance_km) FILTER (WHERE n.has_distance AND n.is_booking)::numeric, 1) AS km,
  count(*) FILTER (WHERE n.has_distance AND n.is_booking)::int             AS measured_trips,
  count(*) FILTER (WHERE n.outcome = 'completed')::int                     AS completed,
  count(*) FILTER (WHERE n.outcome = 'not_completed')::int                 AS not_completed,
  count(*) FILTER (WHERE n.outcome IS NOT NULL)::int                       AS outcome_n`;

/* Every column qualified. trip_norm is SELECT t.* over trip, so the join puts
   two of every base column in scope and an unqualified `plate` is ambiguous —
   Postgres rejects the statement rather than picking one, which is the good
   outcome. The measures read from the view (n) because that is where the
   resolved columns live; only person_key comes from the base table. */

/* person_key lives on `trip`, not on trip_norm — the view is SELECT t.* and
   Postgres froze its column list at creation (see schema_v18/v20). Joining the
   base table back on is what makes the folded distinct count available without
   rebuilding two long view bodies in a third file. */
const FROM_TRIPS = `FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id`;

/* GROUPING SETS leaves NULL in the columns a set did not group by, and NULL is
   also a legitimate fleet_id on a row we could not attribute. coalesce alone
   cannot tell the two apart, so the sets are labelled with GROUPING() and the
   '*' is applied from the label. */
/* Every (platform, fleet) combination a page can ask for, including the '*'
   rows, computed in one pass by GROUPING SETS rather than four queries — and,
   the part that matters, each distinct count computed at its own grain instead
   of summed from the others.

   GROUPING SETS leaves NULL in the columns a set did not group by, and NULL is
   also a legitimate fleet_id on a row we could not attribute. coalesce alone
   cannot tell those apart — it would file every unattributed trip under "all
   fleets" and double the totals — so the sets are labelled with GROUPING() and
   '*' is applied from the label, leaving the real NULLs as 'unknown'. */
const grainSql = (bucketExpr, bucketName, sinceParam = '') => `
  SELECT ${bucketExpr} AS ${bucketName},
         CASE WHEN GROUPING(n.platform) = 1 THEN '*' ELSE coalesce(n.platform, 'unknown') END AS platform,
         CASE WHEN GROUPING(n.fleet_id) = 1 THEN '*' ELSE coalesce(n.fleet_id, 'unknown') END AS fleet_id,
         ${MEASURES}
  ${FROM_TRIPS}
  WHERE n.requested_at IS NOT NULL ${sinceParam}
  GROUP BY GROUPING SETS (
    (${bucketExpr}, n.platform, n.fleet_id),
    (${bucketExpr}, n.platform),
    (${bucketExpr}, n.fleet_id),
    (${bucketExpr}))`;

/* The same SQL, exported so a reader can compute a grain directly when the
   stored one is not there yet — a fresh database, a deploy before the first
   collection, or a rollup that failed. The alternative was a second copy of
   each aggregate living in the route as a "fallback", which is how the two
   quietly stop agreeing: the fast path and the slow path would then be
   different answers to the same question, and only one of them ever gets
   fixed. One definition, two ways to execute it.

   `bucket` is 'day', 'week' or 'month'. Week is ISO — Postgres date_trunc
   starts it on Monday — and is keyed on that Monday, so a bucket is either a
   whole week or the partial one at the edge of the window, never a silent
   mixture of the two. */
const BUCKET_EXPR = {
  day: 'n.local_day',
  week: "date_trunc('week', n.local_day)::date",
  month: "date_trunc('month', n.local_day)::date",
};
export const BUCKETS = Object.keys(BUCKET_EXPR);
export const rollupGrainSql = (bucket, where = '') =>
  grainSql(BUCKET_EXPR[bucket] || BUCKET_EXPR.day, bucket, where);

const COLS = ['trips', 'bookings', 'telematics', 'drivers', 'vehicles', 'earning_vehicles',
  'attributed_trips', 'revenue', 'priced_trips', 'km', 'measured_trips',
  'completed', 'not_completed', 'outcome_n'];

/* A partial pass must never rebuild a bucket from part of it.
   The narrow refresh filters on local_day, but the month grain GROUPS by
   month — so a window starting mid-month rebuilt the whole August row from the
   fortnight inside the window and halved it. Measured: a five-day window
   reported August as 2 trips against 18. The chart would simply have been
   wrong, with nothing failing and nothing to notice.

   So the cutoff is snapped back to the start of the bucket that contains it.
   The pass then reads a few more days than asked and every bucket it writes is
   whole. */
const snapToBucket = (since, bucket) => {
  if (bucket === 'month') return `${since.slice(0, 7)}-01`;
  /* A week is snapped back to its own Monday for the same reason a month is
     snapped to the 1st: a window opening on a Wednesday would otherwise
     rebuild that whole week from its last five days. */
  if (bucket === 'week') {
    const d = new Date(`${since}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }
  return since;
};

async function refreshGrain(db, { table, bucket, expr, since }) {
  const set = COLS.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const from = since ? snapToBucket(since, bucket) : null;
  const where = from ? 'AND n.local_day >= $1::date' : '';
  const { rowCount } = await db.query(
    `INSERT INTO ${table} (${bucket}, platform, fleet_id, ${COLS.join(', ')}, computed_at)
     SELECT ${bucket}, platform, fleet_id, ${COLS.join(', ')}, now()
     FROM (${grainSql(expr, bucket, where)}) g
     ON CONFLICT (${bucket}, platform, fleet_id) DO UPDATE
       SET ${set}, computed_at = now()`, from ? [from] : []);
  return rowCount || 0;
}

/* Month bounds and the platform list, which the month grain also carries. Kept
   out of MEASURES because array_agg of a column the set is grouping by is
   meaningless in the sets that do not group by it. */
async function refreshMonthExtras(db, since) {
  const from = since ? snapToBucket(since, 'month') : null;
  await db.query(
    `UPDATE rollup_month m SET first_day = x.a, last_day = x.b,
            platforms = x.p, booking_platforms = x.bp
     FROM (
       SELECT date_trunc('month', n.local_day)::date AS month,
              min(n.local_day) a, max(n.local_day) b,
              array_agg(DISTINCT n.platform) p,
              array_agg(DISTINCT n.platform) FILTER (WHERE n.is_booking) bp
       FROM trip_norm n ${from ? 'WHERE n.local_day >= $1::date' : ''} GROUP BY 1
     ) x
     WHERE m.month = x.month AND m.platform = '*' AND m.fleet_id = '*'`, from ? [from] : []);
}

async function refreshPersonMonth(db, since) {
  // Month-grained as well, so the same snap applies: a person's August row
  // rebuilt from five days of August is a person who worked five days.
  const from = since ? snapToBucket(since, 'month') : null;
  const { rowCount } = await db.query(
    /* fleets, beside the platforms already stored.
       ─────────────────────────────────────────────────────────────────────
       #retention could not be narrowed to a fleet, because this rollup carried
       no fleet at all — the page described both businesses under either
       heading on a two-fleet operator. An ARRAY rather than a key column: the
       primary key is (person_key, month) and a person who drove for both
       fleets in a month is ONE person, so splitting the row would fold them
       into two humans on the one page whose subject is whether people stay. */
    `INSERT INTO rollup_person_month (person_key, month, name, driver_ext_id, bookings, revenue, km, platforms, fleets, computed_at)
     SELECT t.person_key,
            date_trunc('month', n.local_day)::date AS month,
            max(n.driver_name),
            (array_agg(DISTINCT n.driver_ext_id) FILTER (WHERE n.driver_ext_id IS NOT NULL))[1],
            count(*)::int,
            round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2),
            round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric, 1),
            array_agg(DISTINCT n.platform),
            array_remove(array_agg(DISTINCT n.fleet_id), NULL),
            now()
     ${FROM_TRIPS}
     /* Not a person_key IS NOT NULL predicate here: that matches the partial
        index's own predicate exactly and tips the planner into an index
        scan with a heap fetch per row. It cost /api/drivers/directory a
        tenfold regression when written that way. Same set of rows, read the
        way this query is reading them anyway. */
     WHERE n.is_booking AND t.driver_name IS NOT NULL AND btrim(t.driver_name) <> ''
       ${from ? 'AND n.local_day >= $1::date' : ''}
     GROUP BY 1, 2
     ON CONFLICT (person_key, month) DO UPDATE
       SET name = EXCLUDED.name, driver_ext_id = EXCLUDED.driver_ext_id,
           bookings = EXCLUDED.bookings, revenue = EXCLUDED.revenue, km = EXCLUDED.km,
           platforms = EXCLUDED.platforms, fleets = EXCLUDED.fleets, computed_at = now()`,
    from ? [from] : []);
  return rowCount || 0;
}

/* One named rollup, with its own state row. Named separately so a failure in
   one does not read as a failure of all three — and so a page can tell which
   of its numbers is stale. */
async function runOne(db, name, fn) {
  const t0 = Date.now();
  await db.query(
    `INSERT INTO rollup_state (name, started_at, status) VALUES ($1, now(), 'running')
     ON CONFLICT (name) DO UPDATE SET started_at = now(), status = 'running', error = NULL`, [name]);
  try {
    const rows = await fn();
    const [{ a, b } = {}] = (await db.query(
      `SELECT min(local_day) a, max(local_day) b FROM trip_norm`)).rows;
    await db.query(
      `UPDATE rollup_state SET finished_at = now(), rows_written = $2, duration_ms = $3,
              covers_from = $4, covers_to = $5, status = 'ok', error = NULL
       WHERE name = $1`, [name, rows, Date.now() - t0, a || null, b || null]);
    return { name, rows, ms: Date.now() - t0 };
  } catch (e) {
    /* Recorded, not swallowed. A rollup that fails silently leaves the pages
       reading whatever it wrote last time, with no way to tell. */
    await db.query(
      `UPDATE rollup_state SET finished_at = now(), duration_ms = $2, status = 'error', error = $3
       WHERE name = $1`, [name, Date.now() - t0, String(e).slice(0, 400)]);
    log.error(SRC, `${name} failed`, { err: String(e).slice(0, 300) });
    return { name, error: String(e).slice(0, 200) };
  }
}

/* A full rebuild reads every trip ever collected, and on this fleet that is
   about eighty seconds of database work across the three rollups. Running it
   every fifteen minutes on the same managed Postgres the API reads from was
   measurable at the other end: /api/playbook went from 9.3s to 11.1s and
   /api/capacity from 2.4s to 5.9s while a refresh was in flight. Making the
   pages faster by starving them is not making them faster.

   So the frequent refresh only recomputes recent buckets. Yesterday's numbers
   do not change when today's trips land; only a backfill rewrites history, and
   the daily full rebuild is what catches that.

   `days` is how far back to recompute. Deliberately wider than the collector's
   incremental window: a late-arriving trip, a corrected fare, or a run that
   fell behind all land days after the fact, and a rollup that only looked at
   today would miss every one of them. */
/* Only one refresh at a time.
   Three things start one — the boot pass, the quarter-hourly cron, and the end
   of every collection run — and on the first deploy two of them overlapped.
   Both do INSERT ... ON CONFLICT DO UPDATE over the same rows, and two such
   passes touching those rows in different orders deadlock: production reported
   rollup_month status=error, "deadlock detected", which is Postgres correctly
   refusing to corrupt anything and this code being wrong to ask.

   Overlap is not an error worth propagating — the second pass would compute
   exactly what the first is already computing. It is skipped and said so. */
let inFlight = null;

/* And across processes, where the in-process guard cannot see. Only the
   collector refreshes today, so this is belt and braces — but a scaled worker
   is one platform setting away, and the failure it would cause is the one that
   just happened. pg_try_advisory_lock returns false rather than waiting, which
   is what "skip, do not queue" needs. Skipped on PGlite, which has no pool. */
const LOCK_KEY = 4711;
async function withDbLock(db, fn) {
  if (typeof db.connect !== 'function') return fn();
  const client = await db.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [LOCK_KEY]);
    if (!rows[0]?.got) {
      log.info(SRC, 'another process holds the rollup lock — skipped');
      return null;
    }
    try { return await fn(); }
    finally { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); }
  } finally { client.release(); }
}

export async function refreshRollups(opts = {}) {
  if (inFlight) {
    log.info(SRC, 'refresh already running — skipped');
    return inFlight;
  }
  inFlight = withDbLock(opts.db || pool, () => refreshRollupsInner(opts))
    .finally(() => { inFlight = null; });
  return inFlight;
}


/* ── money_event: every provider figure, in one shape, keeping its source ──
   Appended from the tables the collectors already write. This makes no API
   call and invents no value — it is the same numbers, in one place, with the
   call that produced each one still attached to it.

   Which is the point. A fleet total meant knowing which of five tables to
   trust for which channel over which window, and the answer lived in one
   function that picks a winner per platform and discards the rest. That is
   the right rule for a total and the wrong place for it to be the only
   record: a figure nobody can trace back to the call that produced it is a
   figure nobody can check.

   Two rules hold this table honest:

   DERIVED TABLES ARE NOT SOURCES. driver_statement_day and driver_payout_day
   are computed FROM driver_earnings_component and driver_performance, so
   appending them too would count the same money twice under two names. Only
   the tables a collector writes directly are read here.

   A PERIOD IS NOT A DAY. `day` is set only where the provider reported a
   single day. A weekly statement lands as one row spanning seven days with a
   NULL day, because it is one measurement of seven days and not seven
   measurements. Spreading it is a modelling choice, and modelling choices
   belong somewhere a reader can see them. */
/* fleet_id is coalesced on every source below because it is part of the key
   now, and a key cannot hold NULL. Two fleets' money is not the same money:
   Ecosine and Egari share drivers, so one person on one day is two events, and
   a key without the fleet collapsed them and killed the whole statement
   import on every rollup — silently, because the refresh catches per source so
   one broken table cannot cost the other seven. See sql/schema_v49.sql. */
const MONEY_SOURCES = [
  /* Every trip that carries a price. Uber's export has no price column at all,
     so this is Yango, the hotel channel and Bolt — and the row keys on the
     provider's own trip id, so a re-collection updates rather than doubles. */
  { name: 'trip_price', sql: `
    INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
      driver_name, plate, period_start, period_end, day, amount, currency, external_ref)
    SELECT CASE platform WHEN 'yango' THEN 'yango_orders'
                         WHEN 'hotel' THEN 'hotel_trip_report'
                         WHEN 'bolt'  THEN 'bolt_order_history'
                         ELSE platform || '_trips' END,
           platform, coalesce(fleet_id, ''), 'fare', '', coalesce(driver_ext_id, ''),
           driver_name, plate,
           local_day, local_day, local_day,
           price, coalesce(currency, 'AED'), external_id
      FROM trip_norm
     WHERE price IS NOT NULL AND is_booking AND local_day IS NOT NULL
       AND has_fare` },

  /* What the platform says it PAID, at the grain it said it — Uber's weekly
     (and daily, where the breakdown serves one) netOutstanding, and Yango's
     weekly driver summary. Nothing is spread: a weekly row keeps its week. */
  { name: 'payout', sql: `
    INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
      driver_name, plate, period_start, period_end, day, amount, currency, external_ref)
    SELECT CASE platform WHEN 'uber' THEN 'uber_graphql_breakdown'
                         WHEN 'yango' THEN 'yango_driver_summary'
                         ELSE platform || '_performance' END,
           platform, coalesce(fleet_id, ''), 'payout', 'net_outstanding', driver_ext_id,
           driver_name, plate, period_start, period_end,
           CASE WHEN period_start = period_end THEN period_start END,
           earnings, coalesce(currency, 'AED'), ''
      FROM driver_performance
     WHERE earnings IS NOT NULL` },

  /* The named lines inside a payout, in the provider's own words. Two APIs
     write this table with two vocabularies — the GraphQL breakdown says
     `your_earnings`, the OAuth REST endpoint says `net_fare` — and the source
     column is what lets a reader tell which call a line came from. */
  { name: 'component', sql: `
    INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
      driver_name, plate, period_start, period_end, day, amount, currency, external_ref)
    SELECT CASE WHEN c.platform = 'uber' AND c.category IN ('net_fare','reimbursements','expenses')
                  THEN 'uber_rest_payments' ELSE c.platform || '_components' END,
           c.platform, coalesce(c.fleet_id, ''), 'component', c.category, c.driver_ext_id,
           c.driver_name, NULL, c.period_start, c.period_end,
           CASE WHEN c.period_start = c.period_end THEN c.period_start END,
           c.amount, coalesce(c.currency, 'AED'), coalesce(c.parent, '')
      FROM driver_earnings_component c
     WHERE c.amount IS NOT NULL` },

  /* Yango's park ledger — commissions, penalties, top-ups. Real money moving
     between the fleet and the platform, collected on every run since the
     collector was written, and reaching no figure in the product. It is not a
     fare and not a payout, so it is neither added to nor hidden from them: it
     is its own kind, and the page that shows it says what it is. */
  { name: 'ledger', sql: `
    INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
      driver_name, plate, period_start, period_end, day, amount, currency, external_ref)
    SELECT 'yango_park_ledger', platform, coalesce(fleet_id, ''), 'ledger', coalesce(category, ''),
           coalesce(driver_ext_id, ''), driver_name, NULL,
           (event_at AT TIME ZONE 'Asia/Dubai')::date,
           (event_at AT TIME ZONE 'Asia/Dubai')::date,
           (event_at AT TIME ZONE 'Asia/Dubai')::date,
           amount, coalesce(currency, 'AED'), external_id
      FROM ledger_entry
     WHERE amount IS NOT NULL AND event_at IS NOT NULL` },

  /* The operator's own statement import — the months the APIs no longer
     serve. Uber's earnings endpoint keeps roughly the last six, so before
     that date the imported ledger is the ONLY record there is. Every read in
     the product filters it out (`source <> 'ledger'`), which is right for a
     figure that must not double-count an API that also covers the day, and
     wrong as a reason for the money to be invisible. Here it is a source like
     any other, marked as what it is. */
  { name: 'import', sql: `
    INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
      driver_name, plate, period_start, period_end, day, amount, currency, external_ref)
    SELECT 'statement_import', platform, coalesce(fleet_id, ''), 'statement', 'net',
           coalesce(driver_ext_id, ''), driver_name, NULL, day, day, day,
           net, coalesce(currency, 'AED'), name_key
      FROM driver_statement_day
     WHERE source = 'ledger' AND net IS NOT NULL` },
];

/* Rebuilt whole rather than merged. Every row is derived from a table this
   pass has just refreshed, so a partial write would leave the two disagreeing
   in a way no reader could see — and the table is small enough that whole is
   also the simplest thing that is correct. */
async function refreshMoneyEvents(db) {
  await db.query('DELETE FROM money_event');
  let n = 0;
  for (const s of MONEY_SOURCES) {
    try {
      const r = await db.query(s.sql);
      n += r.rowCount || 0;
    } catch (e) {
      /* One provider's table missing or malformed must not cost the other
         four their rows: this is a provenance record, and a partial one that
         says which part is missing beats none. */
      log.warn(SRC, `money_event ${s.name} failed`, { err: String(e).slice(0, 160) });
    }
  }
  return n;
}

async function refreshRollupsInner({ db = pool, days = null } = {}) {
  const t0 = Date.now();
  /* The Dubai day, because every column this bound is compared against is a
     Dubai day: rollup_day buckets n.local_day, which sql/schema_v18.sql builds
     as (requested_at AT TIME ZONE 'Asia/Dubai')::date. Read as the UTC day it
     was a day short between 20:00 and midnight Dubai — the four hours when the
     collector is most likely to be running a nightly rebuild. */
  const since = days ? dubaiIso(new Date(Date.now() - days * 864e5)) : null;
  const out = [];
  out.push(await runOne(db, 'rollup_day', () =>
    refreshGrain(db, { table: 'rollup_day', bucket: 'day', expr: 'n.local_day', since })));
  out.push(await runOne(db, 'rollup_month', async () => {
    const n = await refreshGrain(db, {
      table: 'rollup_month', bucket: 'month', expr: "date_trunc('month', n.local_day)::date", since });
    await refreshMonthExtras(db, since);
    return n;
  }));
  out.push(await runOne(db, 'rollup_week', () =>
    refreshGrain(db, {
      table: 'rollup_week', bucket: 'week', expr: "date_trunc('week', n.local_day)::date", since })));
  out.push(await runOne(db, 'rollup_person_month', () => refreshPersonMonth(db, since)));

  /* ── order matters here, and it did not use to ─────────────────────────
     driver_day now folds the platform statement and the bank payout in beside
     the work they paid for, so it READS driver_statement_day and
     driver_payout_day. Both must therefore be written first.

     Before the money moved onto the day row, driver_day read only trip_norm
     and driver_timeline_event and could sit anywhere in this list — and it sat
     above refreshStatements. Left there, every refresh would have written a
     day row carrying the PREVIOUS pass's money: correct-looking, one cycle
     stale, and wrong in exactly the way nothing alerts on. */
  out.push(await runOne(db, 'driver_payout_day', () => refreshPayouts(db)));
  out.push(await runOne(db, 'driver_statement_day', () => refreshStatements(db)));
  out.push(await runOne(db, 'driver_day', () => refreshDriverDays(db, { since })));
  out.push(await runOne(db, 'driver_lifetime', () => refreshLifetime(db)));
  /* Last, and deliberately: it reads the collector-written tables, not the
     rollups, so it does not depend on this order — but running it here means
     a pass that fails halfway leaves the provenance record describing the
     same collection the totals above describe. */
  out.push(await runOne(db, 'money_event', () => refreshMoneyEvents(db)));
  /* Refresh the planner's statistics on the tables this just rewrote, and on
     trip itself. A generated column arrives with NO statistics — Postgres has
     never seen its distribution — so every plan touching person_key was being
     chosen blind, and one of them chose an index scan over most of the table.
     Autovacuum gets there eventually; "eventually" is a page that is slow for
     an hour after a deploy.

     ANALYZE takes a light lock and reads a sample, not the table, so it is
     cheap next to the rollup that just ran. Failure is not fatal: stale
     statistics are a slow query, not a wrong one. */
  try {
    await db.query('ANALYZE trip, rollup_day, rollup_week, rollup_month, rollup_person_month, driver_payout_day, driver_day, driver_lifetime');
  } catch (e) { log.warn(SRC, 'analyze failed — plans may be stale', { err: String(e).slice(0, 120) }); }

  const failed = out.filter((o) => o.error);
  log[failed.length ? 'warn' : 'info'](SRC, since ? `refreshed since ${since}` : 'refreshed in full', {
    ms: Date.now() - t0,
    rows: out.reduce((a, o) => a + (o.rows || 0), 0),
    failed: failed.length || undefined,
  });
  return out;
}

/* Materialise the payout-day resolution — see sql/schema_v23.sql.
   ─────────────────────────────────────────────────────────────────────────
   driver_payout_day_live expands every report window into its days and picks a
   winner per (platform, driver, day). Computing that on demand cost a one-vCPU
   database twenty seconds and more per query, and every page's money passes
   through it — so it runs here, once per collection cycle, and everything else
   reads the table it fills.

   Always in full, never incrementally. The winner for a day can change when a
   FINER report arrives for a week already covered by a coarse one, and which
   days that dethrones is exactly the question the view answers — an
   incremental refresh would have to answer it twice. The whole expansion is
   one INSERT..SELECT on the server; measured at production shape it is the
   cost of one of the queries it replaces.

   DELETE, not TRUNCATE: TRUNCATE takes ACCESS EXCLUSIVE and blocks every
   reader for the duration of the rebuild, while DELETE inside the transaction
   lets a concurrent reader see the previous complete answer until the commit
   swaps it. The dead rows are the price; autovacuum collects them, and the
   ANALYZE below keeps the planner current meanwhile. */
export async function refreshPayouts(db = pool) {
  await db.query('BEGIN');
  try {
    /* The pool caps every statement at two minutes so a runaway page query
       cannot hold a connection hostage — the right default for readers, and
       the wrong one here: this rebuild is the one deliberately-heavy statement
       in the system, and it shares the database with the backfills that make
       it necessary. Under that load it was cancelled mid-rebuild; the
       transaction rolled back cleanly, readers kept the previous table, and
       the pass reported an error every cycle until the load passed. SET LOCAL
       scopes the longer allowance to this transaction alone. */
    await db.query("SET LOCAL statement_timeout = '600000'").catch(() => {});
    await db.query('DELETE FROM driver_payout_day');
    const r = await db.query(`
      INSERT INTO driver_payout_day
        (platform, fleet_id, driver_ext_id, driver_name, day,
         period_start, period_end, period_days, period_earnings,
         earnings, cash_earnings, trips, distance_km, hours_online, hours_on_trip,
         acceptance_rate, cancellation_rate, completion_rate, rating, currency, ingested_at)
      SELECT platform, fleet_id, driver_ext_id, driver_name, day,
             period_start, period_end, period_days, period_earnings,
             earnings, cash_earnings, trips, distance_km, hours_online, hours_on_trip,
             acceptance_rate, cancellation_rate, completion_rate, rating, currency, ingested_at
      FROM driver_payout_day_live`);
    await db.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/* Two surfaces, two vocabularies for the same money.
   ─────────────────────────────────────────────────────────────────
   The OAuth REST payments surface roots its tree at earnings and
   names the fare-net-of-commission net_fare. The supplier GraphQL
   surface — the only one that answers for Egari at all, and the only
   one with history for either fleet — roots at your_earnings and
   names its children fare and service_fee instead. Same money,
   different words, and this query knew only the first set. Egari's
   components arrived, none of them said net_fare, the HAVING
   dropped every one, and the reconciliation showed a fleet that had
   been paid AED 107,233 in August against a null expectation.

   Measured on production, both trees hold the same identity:

     REST     earnings      = net_fare            + tip + taxes
     GraphQL  your_earnings = fare + service_fee  + tip + taxes

   so your_earnings − tip − taxes IS net_fare. Checked on driver
   64686123: 3386.90 − 846.78 − 42.38 + 35.00 = 2532.74, the root
   Uber itself reports, to the fils.

   Subtracting from Uber's own root rather than adding fare and
   service_fee is deliberate: the root already contains every child,
   including ones this mapping has never seen. Egari's fleet-wide
   residual against fare+service_fee is exactly its AED 3.00
   promotion — a category an additive reading would have silently
   dropped, and the next new one would go the same way.

   taxes_earnings and tip hang under BOTH roots, so the GraphQL
   subtraction names its parent. The other three read without one:
   the table's key is (platform, driver, period_start, period_end,
   category), so one period holds one row per category whichever
   surface wrote it, and there is nothing to double count. */
/* WHICH ROOT WINS, AND WHY IT IS NOT THE ONE THAT ARRIVES FIRST.
   ─────────────────────────────────────────────────────────────────────────
   The identity above is real, and it holds — on a period BOTH surfaces have
   finished describing. The coalesce below preferred net_fare, and net_fare is
   the REST one: the OAuth payments surface answers for the CURRENT payment
   period and only for it. So on every period that surface has touched but not
   completed, a partial figure displaced a complete one, and the coalesce could
   not tell — it tested non-null, not finished.

   Measured on production 2026-09-02, on the week of 24–30 August:

     day        on-trip net   cash collected   expected payout   bank paid
     2026-08-25      555.21          3947.42          -3146.51    16993.04
     2026-08-26      555.21          3947.42          -3146.51    15322.07
       … identical for six days, the signature of one week spread evenly …

   A fleet does not earn AED 555 on-trip in a day while its drivers bank 3,947
   in cash and Uber wires 17,000. The expected side had collapsed to the REST
   week's 3,886 while the GraphQL root for the same week carried 130,396 over
   234 drivers against net_fare's 3,747 over 81. Six days published a NEGATIVE
   expectation — the page suppressed the percentage, which is why it read as a
   missing number rather than a wrong one — and the days either side read
   +1555% and +641%.

   So the arms are swapped: Uber's own root wins where it exists, and net_fare
   is the fallback for the open period the GraphQL surface has not yet
   described. The subtraction is unchanged and its reasoning is above — the
   root already contains every child, including ones this mapping has never
   seen, which is why it subtracts rather than adding fare and service_fee.

   Single-driver check, 5f16534e over 2026-08-30..09-06: your_earnings 1583.26
   against net_fare 802.45, with fare 2143.84 + service_fee -536.00 = 1607.84
   confirming the GraphQL root is the one describing the whole period. */
export const NET_FARE_SQL = `coalesce(
    sum(amount) FILTER (WHERE category = 'your_earnings')
      - coalesce(sum(amount) FILTER (WHERE category = 'tip'
                                       AND parent = 'your_earnings'), 0)
      - coalesce(sum(amount) FILTER (WHERE category = 'taxes_earnings'
                                       AND parent = 'your_earnings'), 0),
    sum(amount) FILTER (WHERE category = 'net_fare'))`;

/* Derive the ON-TRIP statement days from the earnings components.
   ─────────────────────────────────────────────────────────────────────────
   Two Uber surfaces carry the statement view — net fares, tips, tolls, cash
   collected. The OAuth REST payments surface answers for Ecosine and only for
   the current payment period; the supplier GraphQL breakdown answers for both
   fleets and for as far back as Uber retains. Both land in
   driver_earnings_component per driver-period, in different vocabularies the
   query below reconciles. This turns those periods into
   driver_statement_day rows (source='uber_rest'), the table every on-trip
   figure reads, spreading each week evenly over its days the same way the
   payout resolution spreads its periods.

   Component semantics, read from the tree itself: net_fare is the fare income
   net of commission (the on-trip net, excluding tips), tip and toll (Salik)
   ride separately, cash_collected arrives NEGATIVE — it is money already in
   the driver's hand. Categories the mapping does not name (taxes, surcharges,
   promos) are deliberately left out rather than guessed at: an unmapped
   dirham is invisible here but still present in the payout, and inventing a
   column for it would be the exact sin the ledger reconciliation exists to
   catch.

   Delete-and-rebuild of the uber_rest slice only: the ledger slice (reference
   data) and any future source are other writers' rows. */
export async function refreshStatements(db = pool) {
  await db.query('BEGIN');
  try {
    // Same allowance as refreshPayouts, for the same reason.
    await db.query("SET LOCAL statement_timeout = '600000'").catch(() => {});
    await db.query(`DELETE FROM driver_statement_day WHERE source = 'uber_rest'`);
    /* Same resolution as the payout view: periods first, then one winner per
       day — the FINEST period covering it. The table holds report windows on
       several grids (weekly now; three-day and longer run-stamps from before
       the weekly fix), and two grids covering one day must not both spread
       into it, nor an arbitrary one win. */
    const r = await db.query(`
      WITH per AS (
        SELECT platform, coalesce(fleet_id, 'ecosine') AS fleet_id, driver_ext_id,
               max(driver_name) AS driver_name, period_start, period_end,
               (period_end - period_start + 1)::numeric AS days,
               ${NET_FARE_SQL}                                        AS net,
               sum(amount) FILTER (WHERE category = 'tip')             AS tips,
               sum(amount) FILTER (WHERE category = 'toll')            AS salik,
               -sum(amount) FILTER (WHERE category = 'cash_collected') AS cash,
               /* THE TWO LINES THIS FOLD NEVER READ.
                  ───────────────────────────────────────────────────────
                  driver_statement_day has carried gross and fees columns
                  since sql/schema_v25.sql and nothing has ever written them,
                  so /api/revenue reported statement_gross and statement_fees
                  as null on every platform, on every window — beside a
                  statement_net of AED 1,038,040 that came out of this same
                  tree.

                  They are both in it. The fare line is the gross the rider was
                  charged and service_fee is the platform's commission out of
                  it; your_earnings, the root, is what is left. Negated like
                  cash above, so every column in this table is a magnitude and
                  a reader does not have to know which of them arrive signed.

                  NOT asserted to reconcile: gross minus fees is not net. The
                  tree carries taxes, surcharges and promotions this fold
                  deliberately does not name, and on one production driver the
                  two sides differ by AED 124.87. Each column is the line the
                  statement itself files, which is all any of them claims. */
               sum(amount) FILTER (WHERE category = 'fare')            AS gross,
               -sum(amount) FILTER (WHERE category = 'service_fee')    AS fees
        FROM driver_earnings_component
        WHERE category IN ('net_fare', 'your_earnings', 'taxes_earnings',
                           'tip', 'toll', 'cash_collected', 'fare', 'service_fee')
        GROUP BY platform, fleet_id, driver_ext_id, period_start, period_end
        HAVING ${NET_FARE_SQL} IS NOT NULL
      ),
      resolved AS (
        SELECT DISTINCT ON (p.platform, p.fleet_id, p.driver_ext_id, d.day)
               p.platform, p.fleet_id,
               coalesce(p.driver_name, p.driver_ext_id) AS driver_name,
               p.driver_ext_id, d.day::date AS day,
               /* Divided by the days the report covered — and the divisor is
                  kept beside the quotient. Uber files this fleet weekly, so
                  seven consecutive rows carry a seventh of one number each,
                  and without period_days a reader has no way to tell that from
                  seven days that were each measured. See sql/schema_v44.sql. */
               p.days::int AS period_days,
               p.net / p.days AS net, p.tips / p.days AS tips,
               p.salik / p.days AS salik, p.cash / p.days AS cash,
               p.gross / p.days AS gross, p.fees / p.days AS fees
        FROM per p
        CROSS JOIN LATERAL generate_series(p.period_start, p.period_end, interval '1 day') AS d(day)
        ORDER BY p.platform, p.fleet_id, p.driver_ext_id, d.day,
                 (p.period_end - p.period_start) ASC, p.period_start ASC
      ),
      /* One person can hold two platform accounts (a real case in this fleet:
         the same driver as "…Ghulam Qadir" and "…khan"). Their names may fold
         to one key, and the table is keyed per person-day — so account rows
         folding together are SUMMED, never last-write-wins. */
      folded AS (
        SELECT platform, fleet_id, max(driver_name) AS driver_name,
               max(driver_ext_id) AS driver_ext_id, day,
               -- The COARSEST window behind the folded figure: it is what
               -- limits what can be claimed about the day.
               max(period_days) AS period_days,
               sum(net) AS net, sum(tips) AS tips, sum(salik) AS salik, sum(cash) AS cash,
               sum(gross) AS gross, sum(fees) AS fees
        FROM resolved
        GROUP BY platform, fleet_id, lower(regexp_replace(driver_name, '\\s+', ' ', 'g')), day
      )
      INSERT INTO driver_statement_day
        (platform, fleet_id, driver_name, driver_ext_id, day,
         net, tips, salik, cash, gross, fees, period_days, source, pseudo)
      SELECT platform, fleet_id, driver_name, driver_ext_id, day,
             net, tips, salik, cash, gross, fees, period_days, 'uber_rest', false
      FROM folded
      ON CONFLICT (platform, fleet_id, name_key, day, source) DO UPDATE SET
        net = EXCLUDED.net, tips = EXCLUDED.tips, salik = EXCLUDED.salik,
        cash = EXCLUDED.cash, gross = EXCLUDED.gross, fees = EXCLUDED.fees,
        period_days = EXCLUDED.period_days,
        driver_ext_id = EXCLUDED.driver_ext_id,
        ingested_at = now()`);
    await db.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/* Who has ever driven, and when they last did — see sql/schema_v29.sql.
   ─────────────────────────────────────────────────────────────────────────
   The one question on the driver directory with no window, so the only way to
   answer it live is to group the entire trip history on every request. The SQL
   here is the directory's own, unchanged, so the precomputed answer cannot
   drift from the live one: the same synthesised key, the same predicate, the
   same aggregates. test/rollup.test.mjs runs both and requires them to match.

   Rebuilt whole rather than incrementally. The measures are max() and count()
   over all time, so a narrow pass cannot update them without reading the rows
   it excluded — the cheap-looking version is the wrong one. */
/* ── one row per driver per Dubai day ──────────────────────────────────────
   The derived record, kept. See sql/schema_v38.sql for why a derivation that
   lives only in a query is not good enough — the short version is that the
   providers forget (Uber serves 31 days of availability and about 192 of
   earnings), a query that changes changes the past with it, and
   /api/driver/shift was running a lead() over the timeline plus a fold over
   every trip, per driver, per request.

   Pure SQL, like every other rollup here. The gap arithmetic looks sequential
   and is not: "the waiting before this job" is its start minus the furthest
   any EARLIER job ran to, which is a running max over the preceding rows.
   Written as a fold in JS first — that version needed a second query, a
   200-row chunked upsert and its own ordering, which is three more things that
   can disagree with the endpoint than one statement has. */
/* The same person fold every money surface in this product resolves by. Not a
   copy of the string: imported, so a change to the rule cannot leave the daily
   record disagreeing with the reconciliation about who a person is. */
const PERSON = (nameCol, idCol) => personKey(idCol, nameCol);

export async function refreshDriverDays(db = pool, { since = null } = {}) {
  const MIN_OF = (c) => `(extract(hour FROM ${c} AT TIME ZONE 'Asia/Dubai') * 60`
    + ` + extract(minute FROM ${c} AT TIME ZONE 'Asia/Dubai'))::int`;
  /* A dropoff on a LATER Dubai day is minute 1440 of this one, not minute 20 —
     as a raw number it would sit before its own request and make the job
     negative. Clamped, the same way api/driver_routes.js clamps it. */
  const END_MIN = `CASE WHEN n.ended_at IS NULL THEN NULL
                        WHEN (n.ended_at AT TIME ZONE 'Asia/Dubai') >= (n.local_day + 1) THEN 1440
                        ELSE greatest(${MIN_OF('n.ended_at')}, ${MIN_OF('n.requested_at')}) END`;
  const p = since ? [since] : [];
  const bound = since ? 'AND n.local_day >= $1::date' : '';
  /* The money tables key on their own `day`, not on trip_norm's local_day, so
     the narrow-refresh bound has to be spelled against each of them. */
  const dayBound = since ? 'AND day >= $1::date' : '';

  await db.query(
    `WITH jobs AS (
       SELECT n.driver_ext_id, n.driver_name, n.local_day AS day, n.fleet_id, n.platform, n.plate,
              n.outcome, n.distance_km, n.has_distance, n.price, n.has_fare, n.ended_at,
              ${MIN_OF('n.requested_at')} AS s,
              ${END_MIN} AS e
         FROM trip_norm n
        WHERE n.is_booking AND coalesce(btrim(n.driver_ext_id), '') <> '' ${bound}),
     gapped AS (
       /* The furthest any earlier job in this driver-day ran to. A job with no
          dropoff contributes nothing to it — its end is unknown, not "now" —
          so it cannot close a gap, which is what a NULL end already does
          inside max(). */
       SELECT j.*,
              max(j.e) OVER (PARTITION BY j.driver_ext_id, j.day ORDER BY j.s
                             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_end
         FROM jobs j),
     agg AS (
       SELECT driver_ext_id, day,
              min(fleet_id) AS fleet_id,
              min(driver_name) AS driver_name,
              array_agg(DISTINCT platform) FILTER (WHERE platform IS NOT NULL) AS platforms,
              array_agg(DISTINCT plate) FILTER (WHERE plate IS NOT NULL) AS plates,
              count(*)::int AS trips,
              count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
              count(*) FILTER (WHERE outcome = 'not_completed')::int AS cancelled,
              round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 2) AS km,
              round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS fares,
              count(*) FILTER (WHERE ended_at IS NULL)::int AS unknown_end,
              min(s) AS first_min,
              max(e) AS last_min,
              coalesce(sum(greatest(0, e - s)) FILTER (WHERE e IS NOT NULL), 0)::int AS on_job_min,
              coalesce(sum(greatest(0, s - prev_end))
                       FILTER (WHERE prev_end IS NOT NULL AND e IS NOT NULL), 0)::int AS wait_min,
              coalesce(max(greatest(0, s - prev_end))
                       FILTER (WHERE prev_end IS NOT NULL AND e IS NOT NULL), 0)::int AS longest_wait_min
         FROM gapped GROUP BY 1, 2),
     ev AS (
       SELECT driver_ext_id, at, status,
              lead(at) OVER (PARTITION BY driver_ext_id ORDER BY at) AS next_at
         FROM driver_timeline_event WHERE kind = 'status' AND status <> ''),
     spans AS (
       SELECT driver_ext_id, at AS s, next_at AS e FROM ev
        WHERE next_at IS NOT NULL AND status = 'ONLINE'),
     /* ── the money, combined PER PLATFORM ──────────────────────────────
        Statement net and per-trip fares are complementary, not alternatives:
        Uber publishes a daily statement and no fare, the hotel channel
        publishes a fare and no statement. A driver working both on one day
        earns the sum of the two.

        But they are only complementary per PLATFORM. Yango publishes both —
        a statement AND a price on the trip — so adding the two totals would
        count that channel twice. So each platform contributes its statement
        where it filed one and its fares where it did not, and only then are
        the platforms added together.

        source <> 'ledger' throughout: the operator's imported workbook is
        reference data that taught the reconciliation, and folding it in here
        would have the fleet's own daily record quoting itself back. */
     /* Matched on the PERSON, not on driver_ext_id.
        ─────────────────────────────────────────────────────────────────
        The first version of this joined the statement to the day on
        driver_ext_id and found nothing on production: 2,375 driver-days, zero
        with money on them, while the same window's statements totalled
        AED 330,343. The statements are not keyed the way the trips are, which
        is exactly why this codebase has a person fold at all — one human holds
        several platform account ids, and personKey is the rule every other
        money surface here already resolves them by: the folded NAME where
        there is one, the id where there is not.

        So the fold is used here too. Anything else would have this table
        disagreeing with the reconciliation about who earned what. */
     fare_pf AS (
       SELECT ${PERSON('driver_name', 'driver_ext_id')} AS person, day, platform,
              round(sum(price) FILTER (WHERE has_fare)::numeric, 2) AS fares
         FROM jobs GROUP BY person, day, platform),
     /* Which ext_id a person's day belongs to. driver_day is keyed on
        driver_ext_id, so a person working two platform accounts in one day has
        two rows and the money must land on ONE of them — the busiest, chosen
        deterministically — rather than being duplicated onto both, which would
        double the fleet's revenue at every grain above the day. */
     owner AS (
       SELECT DISTINCT ON (person, day) ${PERSON('driver_name', 'driver_ext_id')} AS person,
              day, driver_ext_id, count(*) AS n
         FROM jobs GROUP BY person, day, driver_ext_id
        ORDER BY person, day, count(*) DESC, driver_ext_id),
     stmt_pf AS (
       SELECT ${PERSON('driver_name', 'driver_ext_id')} AS person,
              max(driver_ext_id) FILTER (WHERE coalesce(btrim(driver_ext_id), '') <> '') AS own_id,
              max(driver_name) AS driver_name,
              day, platform,
              round(sum(gross)::numeric, 2) AS gross,
              round(sum(fees)::numeric, 2)  AS fees,
              round(sum(net)::numeric, 2)   AS net,
              round(sum(tips)::numeric, 2)  AS tips,
              round(sum(salik)::numeric, 2) AS salik,
              round(sum(cash)::numeric, 2)  AS cash,
              sum(trips)::int               AS trips,
              /* The coarsest report window behind this platform's money for
                 the day. A statement filed weekly is a seventh of a week on
                 each of its days (sql/schema_v44.sql), and a page showing the
                 figure has to be able to say so. */
              max(period_days)              AS period_days
         FROM driver_statement_day
        WHERE source <> 'ledger' ${dayBound}
        /* Named, not positional. This was GROUP BY 1, 3, 4 and adding a column
           in the middle silently shifted an ordinal onto an aggregate. */
        GROUP BY person, day, platform),
     money AS (
       SELECT coalesce(o.driver_ext_id, max(s2.own_id), coalesce(f.person, s2.person)) AS driver_ext_id,
              coalesce(f.day, s2.day) AS day,
              round(sum(s2.gross)::numeric, 2) AS stmt_gross,
              round(sum(s2.fees)::numeric, 2)  AS stmt_fees,
              round(sum(s2.net)::numeric, 2)   AS stmt_net,
              round(sum(s2.tips)::numeric, 2)  AS stmt_tips,
              round(sum(s2.salik)::numeric, 2) AS stmt_salik,
              round(sum(s2.cash)::numeric, 2)  AS stmt_cash,
              sum(s2.trips)::int               AS stmt_trips,
              /* One term per platform, then summed. NULL only when no platform
                 on the day reported either kind of money. */
              round(sum(coalesce(s2.net, f.fares))::numeric, 2) AS money,
              /* And the grain that figure was measured at, taken the same way
                 round: a fare is priced on the booking, so its window is the
                 day itself; a statement carries whatever window it was filed
                 on. The COARSEST term across the platforms on the day, since
                 that is what limits the claim.

                 NULL where any contributing statement does not record its
                 window — an operator import, or a row written before
                 sql/schema_v44.sql. Deliberately not defaulted to 7: guessing
                 the grain is the same class of mistake as guessing the money,
                 and max() alone would have silently dropped the unknown term
                 and reported the day as measured. */
              CASE WHEN bool_or(CASE WHEN s2.net IS NOT NULL THEN s2.period_days IS NULL
                                     WHEN f.fares IS NOT NULL THEN false END) THEN NULL
                   ELSE max(CASE WHEN s2.net IS NOT NULL THEN s2.period_days
                                 WHEN f.fares IS NOT NULL THEN 1 END) END AS money_period_days,
              /* The name the STATEMENT filed under, kept so a day with money
                 and no trips can still be attributed to a person. Without it
                 the fold falls back to the account id on exactly those days,
                 and one human becomes two the moment they are paid for a day
                 the trip feed missed. */
              max(s2.driver_name) AS driver_name,
              count(*) FILTER (WHERE s2.net IS NOT NULL)::int AS pf_statement,
              count(*) FILTER (WHERE s2.net IS NULL AND f.fares IS NOT NULL)::int AS pf_fares
         FROM fare_pf f
         FULL OUTER JOIN stmt_pf s2
           ON s2.person = f.person AND s2.day = f.day AND s2.platform = f.platform
         LEFT JOIN owner o
           ON o.person = coalesce(f.person, s2.person) AND o.day = coalesce(f.day, s2.day)
        GROUP BY o.driver_ext_id, coalesce(f.day, s2.day), coalesce(f.person, s2.person)),
     pay AS (
       SELECT coalesce(o.driver_ext_id, max(p2.driver_ext_id), p2.person) AS driver_ext_id, p2.day,
              round(sum(p2.earnings)::numeric, 2)      AS payout,
              round(sum(p2.cash_earnings)::numeric, 2) AS payout_cash
         FROM (SELECT ${PERSON('driver_name', 'driver_ext_id')} AS person, driver_ext_id, day,
                      earnings, cash_earnings
                 FROM driver_payout_day WHERE TRUE ${dayBound}) p2
         LEFT JOIN owner o ON o.person = p2.person AND o.day = p2.day
        GROUP BY o.driver_ext_id, p2.day, p2.person),
     online AS (
       SELECT driver_ext_id, d AS day,
              sum(greatest(0, extract(epoch FROM (
                least(e AT TIME ZONE 'Asia/Dubai', d::timestamp + interval '1 day')
                - greatest(s AT TIME ZONE 'Asia/Dubai', d::timestamp)))/60))::int AS online_min
         FROM spans,
              LATERAL generate_series((s AT TIME ZONE 'Asia/Dubai')::date,
                                      (e AT TIME ZONE 'Asia/Dubai')::date, interval '1 day') AS g(d)
        GROUP BY 1, 2),
     /* Every driver-day ANY source knows about, not only the ones with trips.
        A statement or a payout that lands on a day the trip feed missed is
        exactly the kind of day worth having a row for — it says the money
        arrived and the work did not reach us — and building the insert from
        the trip aggregate alone would silently drop it. */
     /* What we know about the ACCOUNT rather than about one of its days.
        ─────────────────────────────────────────────────────────────────────
        Two columns were read from the trip aggregate alone, so a day reached
        only through a statement, a payout or (now) an availability span
        carried neither:

          fleet_id  NULL, and every fleet-filtered reader of this table drops
                    a NULL fleet silently (api/server.js, api/economics_routes.js)
                    — a day with money on it vanishing from the fleet that
                    earned it. Not an approximation to fill it in: driver_ext_id
                    is a platform account and an account belongs to one fleet.

          driver_name  NULL, so person_key fell back to the raw account id and
                    the same human keyed two different ways depending on which
                    feed reached the day. That is the exact split the person
                    fold exists to prevent. */
     account AS (
       SELECT driver_ext_id,
              min(fleet_id)    FILTER (WHERE fleet_id IS NOT NULL)    AS fleet_id,
              min(driver_name) FILTER (WHERE driver_name IS NOT NULL) AS driver_name
         FROM agg GROUP BY 1),
     days AS (
       SELECT driver_ext_id, day FROM agg
       UNION SELECT driver_ext_id, day FROM money
       UNION SELECT driver_ext_id, day FROM pay
       /* And the days that only availability knows about.
          ─────────────────────────────────────────────────────────────────
          A driver logged in all evening who was never dispatched, filed no
          statement and drew no payout produced NO ROW AT ALL — the one shape
          of day this table is best placed to record, and the only source that
          can prove somebody was working when nothing came of it. Every panel
          that asks "how much availability earned nothing" was answering over
          a population that excluded the clearest cases.

          The other three unions are left-joined to below, so a day arriving
          only through this one lands with trips 0 and money NULL, which is
          exactly what it was: online, and nothing happened.

          Bounded by the same since as the other three, and that bound is not
          cosmetic: the online CTE has no time bound of its own, so an unbounded
          union here would add a row for every day of availability history on
          every incremental refresh — and because agg, money and pay ARE bounded,
          each of those older days would then be rewritten with trips 0 and no
          money at all. The insert would erase the record it exists to keep. */
       UNION SELECT driver_ext_id, day FROM online WHERE TRUE ${dayBound})
     INSERT INTO driver_day (driver_ext_id, day, fleet_id, platforms, plates, trips, completed,
                             cancelled, km, fares, unknown_end, first_min, last_min, span_min,
                             on_job_min, wait_min, longest_wait_min, online_min, idle_online_min,
                             stmt_gross, stmt_fees, stmt_net, stmt_tips, stmt_salik, stmt_cash,
                             stmt_trips, payout, payout_cash, money, money_source,
                             money_period_days, person_key, computed_at)
     SELECT d.driver_ext_id, d.day, coalesce(a.fleet_id, acc.fleet_id) AS fleet_id,
            a.platforms, a.plates,
            coalesce(a.trips, 0), coalesce(a.completed, 0), coalesce(a.cancelled, 0),
            a.km, a.fares, coalesce(a.unknown_end, 0), a.first_min, a.last_min,
            CASE WHEN a.first_min IS NULL OR a.last_min IS NULL THEN NULL
                 ELSE greatest(0, a.last_min - a.first_min) END,
            coalesce(a.on_job_min, 0), coalesce(a.wait_min, 0), coalesce(a.longest_wait_min, 0),
            o.online_min,
            /* NULL, not zero, where availability was never collected — a day
               nobody asked about is not a day the driver was offline. Floored
               at zero where it was: the two series come from different
               providers' clocks and a job can overhang its own online span by
               seconds, which must not be stored as negative idle time. */
            CASE WHEN o.online_min IS NULL THEN NULL
                 ELSE greatest(0, o.online_min - coalesce(a.on_job_min, 0)) END,
            m.stmt_gross, m.stmt_fees, m.stmt_net, m.stmt_tips, m.stmt_salik, m.stmt_cash,
            m.stmt_trips, py.payout, py.payout_cash, m.money,
            /* Named for what the money column was actually built from, so a
               page can show its own coverage instead of the reader assuming
               it. A mixed day is real and common here — one driver, one day,
               an Uber statement and a hotel fare. */
            CASE WHEN m.money IS NULL THEN 'none'
                 WHEN m.pf_statement > 0 AND m.pf_fares > 0 THEN 'mixed'
                 WHEN m.pf_statement > 0 THEN 'statement'
                 ELSE 'fares' END,
            m.money_period_days,
            /* The same fold the money was matched on, stored so a reader can
               count people at any grain without joining back to the trips. */
            ${PERSON("coalesce(a.driver_name, m.driver_name, acc.driver_name)", 'd.driver_ext_id')},
            now()
       FROM days d
       LEFT JOIN agg a    ON a.driver_ext_id  = d.driver_ext_id AND a.day  = d.day
       LEFT JOIN money m  ON m.driver_ext_id  = d.driver_ext_id AND m.day  = d.day
       LEFT JOIN pay py   ON py.driver_ext_id = d.driver_ext_id AND py.day = d.day
       LEFT JOIN online o ON o.driver_ext_id  = d.driver_ext_id AND o.day  = d.day
       LEFT JOIN account acc ON acc.driver_ext_id = d.driver_ext_id
     ON CONFLICT (driver_ext_id, day) DO UPDATE SET
       fleet_id = EXCLUDED.fleet_id, platforms = EXCLUDED.platforms, plates = EXCLUDED.plates,
       trips = EXCLUDED.trips, completed = EXCLUDED.completed, cancelled = EXCLUDED.cancelled,
       km = EXCLUDED.km, fares = EXCLUDED.fares, unknown_end = EXCLUDED.unknown_end,
       first_min = EXCLUDED.first_min, last_min = EXCLUDED.last_min, span_min = EXCLUDED.span_min,
       on_job_min = EXCLUDED.on_job_min, wait_min = EXCLUDED.wait_min,
       longest_wait_min = EXCLUDED.longest_wait_min,
       online_min = EXCLUDED.online_min, idle_online_min = EXCLUDED.idle_online_min,
       stmt_gross = EXCLUDED.stmt_gross, stmt_fees = EXCLUDED.stmt_fees,
       stmt_net = EXCLUDED.stmt_net, stmt_tips = EXCLUDED.stmt_tips,
       stmt_salik = EXCLUDED.stmt_salik, stmt_cash = EXCLUDED.stmt_cash,
       stmt_trips = EXCLUDED.stmt_trips, payout = EXCLUDED.payout,
       payout_cash = EXCLUDED.payout_cash, money = EXCLUDED.money,
       money_source = EXCLUDED.money_source,
       money_period_days = EXCLUDED.money_period_days, person_key = EXCLUDED.person_key,
       computed_at = now()`, p);

  const { rows } = await db.query('SELECT count(*)::int n FROM driver_day');
  return rows[0].n;
}

export async function refreshLifetime(db = pool) {
  await db.query('BEGIN');
  try {
    await db.query("SET LOCAL statement_timeout = '600000'").catch(() => {});
    await db.query('DELETE FROM driver_lifetime');
    /* Identity as well as counts — see sql/schema_v34.sql. The directory lists
       everyone the fleet has ever known, and for the 244 of 361 people with no
       work inside a thirty-day window it was printing a name and four blanks,
       including for a driver with 2,393 trips on record. Fleet, channels and
       vehicle are not window facts and are answered here, once, over the whole
       history.

       DISTINCT ON for the two "last" columns rather than max(): max(plate)
       is the alphabetically largest plate this person ever held, which is not
       a fact about anything. The subquery orders by requested_at DESC so both
       come from the SAME booking — the most recent one. */
    const r = await db.query(`
      WITH keyed AS (
        SELECT coalesce(nullif(btrim(driver_ext_id), ''), 'name:' || person_key) AS k,
               driver_name, requested_at, fleet_id, platform, plate
          FROM trip
         WHERE driver_name IS NOT NULL AND btrim(driver_name) <> ''
      ),
      last_trip AS (
        SELECT DISTINCT ON (k) k, fleet_id AS last_fleet, plate AS last_plate
          FROM keyed ORDER BY k, requested_at DESC NULLS LAST
      )
      INSERT INTO driver_lifetime
        (driver_ext_id, driver_name, last_ever, lifetime, last_fleet, platforms, last_plate)
      SELECT g.k, g.driver_name, g.last_ever, g.lifetime,
             l.last_fleet, g.platforms, nullif(btrim(coalesce(l.last_plate, '')), '')
        FROM (
          SELECT k, max(driver_name) AS driver_name, max(requested_at) AS last_ever,
                 count(*)::int AS lifetime,
                 array_agg(DISTINCT platform) FILTER (
                   WHERE platform IS NOT NULL AND platform <> '') AS platforms
            FROM keyed GROUP BY k
        ) g
        LEFT JOIN last_trip l ON l.k = g.k`);
    await db.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/* How fresh each rollup is, for the API to hand to a page. */
export async function rollupState(db = pool) {
  const { rows } = await db.query(
    `SELECT name, status, finished_at, rows_written, duration_ms, covers_from, covers_to, error,
            round(extract(epoch from (now() - finished_at))/60)::int AS age_min
     FROM rollup_state ORDER BY name`);
  return rows;
}
