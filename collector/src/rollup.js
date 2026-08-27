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
import { log } from './log.js';

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

   `bucket` is 'day' or 'month'. */
export const rollupGrainSql = (bucket) => grainSql(
  bucket === 'month' ? "date_trunc('month', n.local_day)::date" : 'n.local_day', bucket);

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
const snapToBucket = (since, bucket) =>
  (bucket === 'month' ? `${since.slice(0, 7)}-01` : since);

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

async function refreshRollupsInner({ db = pool, days = null } = {}) {
  const t0 = Date.now();
  const since = days
    ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
    : null;
  const out = [];
  out.push(await runOne(db, 'rollup_day', () =>
    refreshGrain(db, { table: 'rollup_day', bucket: 'day', expr: 'n.local_day', since })));
  out.push(await runOne(db, 'rollup_month', async () => {
    const n = await refreshGrain(db, {
      table: 'rollup_month', bucket: 'month', expr: "date_trunc('month', n.local_day)::date", since });
    await refreshMonthExtras(db, since);
    return n;
  }));
  out.push(await runOne(db, 'rollup_person_month', () => refreshPersonMonth(db, since)));
  out.push(await runOne(db, 'driver_payout_day', () => refreshPayouts(db)));
  /* After the payouts, before the lifetime fold: driver_day reads trip_norm and
     driver_timeline_event and nothing either of those two writes, so its only
     ordering requirement is that the collection that produced them has
     finished — which is what being in this list at all means. */
  out.push(await runOne(db, 'driver_day', () => refreshDriverDays(db, { since }))); 
  out.push(await runOne(db, 'driver_statement_day', () => refreshStatements(db)));
  out.push(await runOne(db, 'driver_lifetime', () => refreshLifetime(db)));
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
    await db.query('ANALYZE trip, rollup_day, rollup_month, rollup_person_month, driver_payout_day, driver_lifetime');
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
export const NET_FARE_SQL = `coalesce(
    sum(amount) FILTER (WHERE category = 'net_fare'),
    sum(amount) FILTER (WHERE category = 'your_earnings')
      - coalesce(sum(amount) FILTER (WHERE category = 'tip'
                                       AND parent = 'your_earnings'), 0)
      - coalesce(sum(amount) FILTER (WHERE category = 'taxes_earnings'
                                       AND parent = 'your_earnings'), 0))`;

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
               -sum(amount) FILTER (WHERE category = 'cash_collected') AS cash
        FROM driver_earnings_component
        WHERE category IN ('net_fare', 'your_earnings', 'taxes_earnings',
                           'tip', 'toll', 'cash_collected')
        GROUP BY platform, fleet_id, driver_ext_id, period_start, period_end
        HAVING ${NET_FARE_SQL} IS NOT NULL
      ),
      resolved AS (
        SELECT DISTINCT ON (p.platform, p.fleet_id, p.driver_ext_id, d.day)
               p.platform, p.fleet_id,
               coalesce(p.driver_name, p.driver_ext_id) AS driver_name,
               p.driver_ext_id, d.day::date AS day,
               p.net / p.days AS net, p.tips / p.days AS tips,
               p.salik / p.days AS salik, p.cash / p.days AS cash
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
               sum(net) AS net, sum(tips) AS tips, sum(salik) AS salik, sum(cash) AS cash
        FROM resolved
        GROUP BY platform, fleet_id, lower(regexp_replace(driver_name, '\\s+', ' ', 'g')), day
      )
      INSERT INTO driver_statement_day
        (platform, fleet_id, driver_name, driver_ext_id, day,
         net, tips, salik, cash, source, pseudo)
      SELECT platform, fleet_id, driver_name, driver_ext_id, day,
             net, tips, salik, cash, 'uber_rest', false
      FROM folded
      ON CONFLICT (platform, fleet_id, name_key, day, source) DO UPDATE SET
        net = EXCLUDED.net, tips = EXCLUDED.tips, salik = EXCLUDED.salik,
        cash = EXCLUDED.cash, driver_ext_id = EXCLUDED.driver_ext_id,
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

  await db.query(
    `WITH jobs AS (
       SELECT n.driver_ext_id, n.local_day AS day, n.fleet_id, n.platform, n.plate,
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
     online AS (
       SELECT driver_ext_id, d AS day,
              sum(greatest(0, extract(epoch FROM (
                least(e AT TIME ZONE 'Asia/Dubai', d::timestamp + interval '1 day')
                - greatest(s AT TIME ZONE 'Asia/Dubai', d::timestamp)))/60))::int AS online_min
         FROM spans,
              LATERAL generate_series((s AT TIME ZONE 'Asia/Dubai')::date,
                                      (e AT TIME ZONE 'Asia/Dubai')::date, interval '1 day') AS g(d)
        GROUP BY 1, 2)
     INSERT INTO driver_day (driver_ext_id, day, fleet_id, platforms, plates, trips, completed,
                             cancelled, km, fares, unknown_end, first_min, last_min, span_min,
                             on_job_min, wait_min, longest_wait_min, online_min, idle_online_min,
                             computed_at)
     SELECT a.driver_ext_id, a.day, a.fleet_id, a.platforms, a.plates, a.trips, a.completed,
            a.cancelled, a.km, a.fares, a.unknown_end, a.first_min, a.last_min,
            CASE WHEN a.first_min IS NULL OR a.last_min IS NULL THEN NULL
                 ELSE greatest(0, a.last_min - a.first_min) END,
            a.on_job_min, a.wait_min, a.longest_wait_min,
            o.online_min,
            /* NULL, not zero, where availability was never collected — a day
               nobody asked about is not a day the driver was offline. Floored
               at zero where it was: the two series come from different
               providers' clocks and a job can overhang its own online span by
               seconds, which must not be stored as negative idle time. */
            CASE WHEN o.online_min IS NULL THEN NULL
                 ELSE greatest(0, o.online_min - a.on_job_min) END,
            now()
       FROM agg a
       LEFT JOIN online o ON o.driver_ext_id = a.driver_ext_id AND o.day = a.day
     ON CONFLICT (driver_ext_id, day) DO UPDATE SET
       fleet_id = EXCLUDED.fleet_id, platforms = EXCLUDED.platforms, plates = EXCLUDED.plates,
       trips = EXCLUDED.trips, completed = EXCLUDED.completed, cancelled = EXCLUDED.cancelled,
       km = EXCLUDED.km, fares = EXCLUDED.fares, unknown_end = EXCLUDED.unknown_end,
       first_min = EXCLUDED.first_min, last_min = EXCLUDED.last_min, span_min = EXCLUDED.span_min,
       on_job_min = EXCLUDED.on_job_min, wait_min = EXCLUDED.wait_min,
       longest_wait_min = EXCLUDED.longest_wait_min,
       online_min = EXCLUDED.online_min, idle_online_min = EXCLUDED.idle_online_min,
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
