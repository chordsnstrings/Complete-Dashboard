// Read/settings API + static dashboard host.
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, migrate } from '../src/db.js';
import { config } from '../src/config.js';
import { describeSettings, setSetting, deleteSetting, loadSettings, recordCredentialVisibility } from '../src/settings.js';
import { win, winDays } from './window.js';
import { rollupGrainSql, rollupState, refreshRollups } from '../src/rollup.js';
import { responseCache } from './cache.js';
import { platformFares, platformPayouts, platformStatements, fleetIncome } from './income_sql.js';
import { startWarmer } from './warm.js';
import { log } from '../src/log.js';
import { driverRoutes } from './driver_routes.js';
import { vehicleRoutes } from './vehicle_routes.js';
import { analyticsRoutes, analystRoutes } from './analytics_routes.js';
import { rosterRoutes } from './roster_routes.js';
import { dayRoutes } from './day_routes.js';
import { segmentRoutes, slotRoutes } from './segment_routes.js';
import { forecastRoutes } from './forecast_routes.js';
import { playbookRoutes } from './playbook_routes.js';
import { retentionRoutes } from './retention_routes.js';
import { capacityRoutes } from './capacity_routes.js';
import { revenueRoutes } from './revenue_routes.js';
import { reconcileRoutes } from './reconcile_routes.js';
import { probeRoutes } from './probe.js';

process.on('unhandledRejection', (e) => log.error('api', 'unhandledRejection', { err: String(e) }));

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();

/* Nothing was compressed. The front end is 528kb of JavaScript and CSS on disk
   and 528kb was what went down the wire — app.js alone is 137kb, and it is on
   the critical path of every view. Gzipped the same bundle is 152kb. On a phone
   that difference is most of the wait before anything is drawn, and the API's
   JSON answers compress harder still: a directory response is mostly repeated
   column names.

   Mounted first so it wraps everything after it, cached API answers included.
   The default filter already skips what must not be recompressed — woff2, the
   marker PNGs — and skips bodies under 1kb, where the header costs more than
   the saving. Nothing here streams, so there is no response left half-written
   waiting on a flush. */
app.use(compression({
  /* The warmer and the stale-revalidate path fetch their own endpoints over
     loopback to fill the cache. Nobody reads those bytes — the body is parsed
     and dropped — so compressing them is CPU spent on the same box that is
     meant to be answering readers. Twenty paths across four windows, every few
     minutes. */
  filter: (req, res) => req.get('x-warm') !== '1' && compression.filter(req, res),
}));
app.use(express.json({ limit: '256kb' }));

/* Not ready is a state, not a failure — and it must not look like either a
   healthy answer or a dead process.

   Boot used to be migrate().then(listen): nothing bound the port until every
   migration had applied. Correct against the failure it was written for (a
   broken schema serving 500s behind a green check), and fatal against a slower
   one: with the database busy — a collection run, a rollup, a cache-warm sweep
   — idempotent no-op migrations took over a minute, the platform's readiness
   probe found a closed port eleven times, declared the deploy failed, and
   rolled the app back to the previous commit. The deploy did not fail; it was
   not finished being measured.

   So the port binds immediately and this gate answers 503 (with Retry-After)
   on every /api route except /api/health until migrate() resolves. Health
   answers 200 from the moment the process is up — it means "the process is
   alive", and says migrating:true while that is the whole truth. A failed
   migration still exits the process: fail-closed is unchanged, only fail-slow
   stopped being read as failure. */
let migrationsDone = false;
app.use((req, res, next) => {
  if (migrationsDone || !req.path.startsWith('/api/') || req.path === '/api/health') return next();
  res.set('retry-after', '5');
  return res.status(503).json({ error: 'starting', detail: 'migrations are still applying — retry shortly' });
});

/* Read responses are cached against a data version, not a clock — see
   api/cache.js. Registered before the routes so a hit never reaches one, and
   after the body parser so a POST is still parsed normally on its way past.

   Set CACHE=off to serve everything live; the numbers are identical either
   way, so this is a lever for diagnosing a stale-looking page rather than a
   behaviour switch. */
const cache = responseCache({
  pool,
  enabled: String(process.env.CACHE || '').toLowerCase() !== 'off',
});
app.use('/api', cache);

const q = (text, params) => pool.query(text, params).then((r) => r.rows);
/* A 500 body used to carry the driver's own message, which names the storage
   engine, the column and the type ("invalid input syntax for type timestamp
   with time zone"). The full error is logged; the caller gets a reference to
   quote. The real fix for this class of bug is test/route_smoke.test.mjs,
   which executes every route rather than grepping for it. */
import { custodyOverWindow, custodyCountOverWindow, vehicleLatest, peopleCount, peopleCountStored, JOIN_TRIP, personFold } from './custody_sql.js';
let errSeq = 0;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  const ref = `e${Date.now().toString(36)}-${(++errSeq).toString(36)}`;
  log.error('api', req.path, { ref, query: req.query, err: String(e) });
  res.status(500).json({ error: 'internal', ref });
});

// Writes (credential changes) require ADMIN_TOKEN via x-admin-token header.
// When ADMIN_TOKEN is set, writes require it. When it is unset the API runs OPEN —
// convenient during setup, but it means anyone who reaches this URL can read and
// change stored credentials. Set ADMIN_TOKEN before treating this as production.
let warnedOpen = false;
const requireAdmin = (req, res, next) => {
  const want = process.env.ADMIN_TOKEN;
  if (!want) {
    if (!warnedOpen) { log.warn('api', 'ADMIN_TOKEN unset — write endpoints are UNAUTHENTICATED'); warnedOpen = true; }
    return next();
  }
  if (req.get('x-admin-token') !== want) return res.status(401).json({ error: 'unauthorized' });
  next();
};

/* filters: ?from=&to=&platform=&fleet=
   Bounds are Dubai-local calendar dates, matched against trip_norm.local_day.
   Binding a bare date string against a timestamptz made it UTC, so every range
   lost the Dubai day's 00:00-04:00 trips at one end and gained a phantom
   partial day at the other — which for a fleet whose airport work starts at
   03:00 is a material slice. `endOfDay` existed only to paper over that in UTC
   and is no longer needed here; it is still exported for the detail routes,
   which bind against raw timestamps. */
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);

/* A date that is not a date must not reach Postgres as one. The shape check
   alone was not enough: `2026-13-45` matches ten digits and two dashes, passes
   straight through, and 500s inside Postgres with "date/time field value out of
   range". The round-trip through Date is what actually distinguishes a
   well-formed string from a real day. */
/* Platform names come from our own `trip.platform` column, but they are being
   interpolated into SQL rather than bound, so they are quoted explicitly. A
   value that is not a plain identifier is rejected rather than escaped. */
const quote = (v) => {
  if (!/^[a-z0-9_]{1,32}$/i.test(String(v))) throw new Error(`unexpected platform name: ${v}`);
  return `'${v}'`;
};

const asDate = (v, fallback) => {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return fallback;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? fallback : s;
};
const range = (req) => {
  /* `days` too, not only from/to — see api/window.js. The hash router carries
     ?days=30 and the front end turns it into from/to before every fetch, so a
     caller reading the API directly got `days` silently ignored and every trip
     the fleet has ever taken, under a thirty-day label. */
  const [from, to] = winDays(req);
  return [from, to, req.query.platform || null, req.query.fleet || null];
};
/* The window predicate, optionally table-qualified. It was a bare string, and
   the moment a query joined a second table that also has `platform` and
   `fleet_id` — vehicle_current_driver does — Postgres rejected the whole
   statement as ambiguous at parse time. /api/vehicles was returning a 500 on
   every single call in production because of it, which the front end turned
   into "Could not load this view" over the entire Vehicles page. */
const W = (alias = '') => {
  const c = alias ? `${alias}.` : '';
  return `${c}local_day BETWEEN $1::date AND $2::date`
    + ` AND ($3::text IS NULL OR ${c}platform=$3)`
    + ` AND ($4::text IS NULL OR ${c}fleet_id=$4)`;
};
const F = W();

/* A Dubai-local day window for the tables that are keyed on a raw timestamp
   rather than on trip_norm's local_day: alert, occupancy_segment,
   telemetry_snapshot, ledger_entry.

   These bound `col BETWEEN $1 AND $2` with bare calendar strings, so
   to='2026-08-21' meant 2026-08-21T00:00:00Z — 04:00 Dubai — and everything
   after 4am on the last requested day was silently dropped. Since the front
   end's default window ends on today, the live Unauthorized page was rendering
   all zeros for the current day, every day. */
const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;

/* Collapse a driver name to one key per person: lower-cased, whitespace
   normalised, and with a repeated surname folded ("Asad Khan Khan" is one
   human). No provider shares a driver id with another, so the name is the only
   key that spans platforms — and grouping on the raw string split people
   across their own spellings on three separate pages. */
/* The one definition, imported rather than repeated. This was a second copy of
   personFold, character for character, and sql/schema_v20.sql now stores a
   third as a generated column. Three copies of "what makes two records the same
   human" is how one person quietly becomes two on a page nobody was looking at,
   so there are two left — the JS one here and the stored one — and
   test/person_key.test.mjs asserts they agree on the names that made the fold
   necessary. */
const CANON = personFold;
// Bookings only. A telematics row is a GPS-derived journey, and the same
// physical trip is recorded by BOTH the ride platform and the tracker — summing
// them counts it twice. See sql/schema_v7.sql.
const FB = `${F} AND is_booking`;

/* Liveness: the process is up and the event loop is turning. Nothing more —
   a liveness probe that touches the database restarts a healthy container
   every time the database hiccups. */
app.get('/api/health', (_, res) => res.json({ ok: true, migrating: !migrationsDone }));

/* Readiness: can this instance actually answer? A green health check in front
   of a missing view is worse than a red one, because it routes users to it. */
/* Readiness must not queue behind the data.
   ─────────────────────────────────────────────────────────────────────────
   The pool holds eight connections. Eight concurrent heavy queries — a cold
   cache after a deploy, or a wide window nobody has warmed — take all of them,
   and this check then waits its turn. Measured during a sweep of the API at a
   ninety-day window: 81 seconds, against 0.27 when asked on its own.

   That is a feedback loop, not just a slow endpoint. The platform's health
   check times out, the app is restarted, the restart empties the response
   cache, and the next wave of traffic is entirely cold — which is how a busy
   minute becomes an outage. It matches the 521s and 522s seen from the edge
   earlier today.

   The answer it gives changes only when a migration runs, so it is remembered.
   A ready process answers from memory and never touches the pool; a process
   that is NOT ready re-checks almost immediately, because that is the state
   worth being impatient about. */
let readyMemo = null;
app.get('/api/ready', wrap(async (_, res) => {
  const need = ['trip_norm', 'trip_ext', 'source_day_coverage'];
  const TTL_OK = 30000, TTL_BAD = 2000;
  if (readyMemo && Date.now() - readyMemo.at < (readyMemo.body.ready ? TTL_OK : TTL_BAD)) {
    return res.status(readyMemo.status).json(readyMemo.body);
  }
  const answer = (status, body) => {
    readyMemo = { at: Date.now(), status, body };
    return res.status(status).json(body);
  };
  try {
    const [row] = await q(
      `SELECT ${need.map((v, i) => `to_regclass('${v}') IS NOT NULL AS v${i}`).join(', ')}`);
    const missing = need.filter((_, i) => !row[`v${i}`]);
    if (missing.length) return answer(503, { ready: false, reason: 'schema incomplete', missing });
    return answer(200, { ready: true, views: need });
  } catch (e) {
    /* Not remembered as long: "the database was unreachable a moment ago" is
       exactly the claim that should expire quickly. */
    return answer(503, { ready: false, reason: 'database unreachable' });
  }
}));

/* ───────────────────────── overview ───────────────────────── */
app.get('/api/kpis', wrap(async (req, res) => {
  const p = range(req);
  /* Three populations live in the `trip` table and they must not be added
     together. See sql/schema_v7.sql for the evidence.

     - BOOKINGS (uber, yango, bolt, hotel): a rider asked for a ride.
     - TELEMATICS JOURNEYS (fms): the tracker saw the car move. The same
       physical trip appears in BOTH, so `count(*)` across them double-counts.
     - PRICED rows: the subset carrying a fare. The Uber trip export has no
       fare column at all, so money describes roughly a fifth of the bookings.

     Every ratio below names the base it was computed over, and the response
     carries that base so the view can say so rather than imply the number
     covers everything. */
  const [t] = await q(
    `SELECT
       -- bookings: the number a fleet manager means by "trips"
       count(*) FILTER (WHERE n.is_booking)::int trips,
       count(*) FILTER (WHERE n.outcome = 'completed')::int completed_trips,
       count(*) FILTER (WHERE n.outcome = 'not_completed')::int cancelled_trips,
       count(*) FILTER (WHERE n.outcome IS NOT NULL)::int bookable_trips,
       round(100.0*count(*) FILTER (WHERE n.outcome = 'completed')
             / nullif(count(*) FILTER (WHERE n.outcome IS NOT NULL),0),1) completion_pct,
       round(100.0*count(*) FILTER (WHERE n.outcome = 'not_completed')
             / nullif(count(*) FILTER (WHERE n.outcome IS NOT NULL),0),1) cancel_pct,

       -- telematics, reported separately: this is movement, not demand
       count(*) FILTER (WHERE NOT n.is_booking)::int telematics_journeys,
       round(sum(n.distance_km) FILTER (WHERE NOT n.is_booking AND n.has_distance)::numeric,0) telematics_km,

       -- distance over bookings only, and only where it is plausible
       round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) km,
       round(avg(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,2) avg_km,
       count(*) FILTER (WHERE n.is_booking AND n.has_distance)::int trips_with_distance,

       /* Money, and the rows it actually covers. Every filter here carries
          n.is_booking as well as n.has_fare: a telematics row is the same physical
          journey a ride n.platform already reported, and if one ever arrives
          carrying a n.price it would be counted a second time. */
       round(sum(n.price) FILTER (WHERE n.is_booking AND n.has_fare)::numeric,0) revenue,
       count(*) FILTER (WHERE n.is_booking AND n.has_fare)::int priced_trips,
       round(avg(n.price) FILTER (WHERE n.is_booking AND n.has_fare)::numeric,2) avg_fare,
       round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_fare AND n.has_distance)::numeric,0) priced_km,
       /* The numerator of revenue_per_km, reported so the ratio can be checked.
          The revenue column covers every trip with a FARE; priced_km covers
          those that also report a DISTANCE. Dividing the first by the second is
          a ratio between two populations: live it came out 3.93 where
          revenue/priced_km is 5.28, and neither figure was derivable from the
          two printed beside it. */
       round(sum(n.price) FILTER (WHERE n.is_booking AND n.has_fare AND n.has_distance)::numeric,0) priced_measured_revenue,
       count(*) FILTER (WHERE n.is_booking AND n.has_fare AND n.has_distance)::int priced_measured_trips,
       round((sum(n.price) FILTER (WHERE n.is_booking AND n.has_fare AND n.has_distance)
              / nullif(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_fare AND n.has_distance),0))::numeric,2) revenue_per_km,

       -- who and what
       ${peopleCountStored()}::int drivers,
       count(*) FILTER (WHERE n.driver_ext_id IS NOT NULL)::int attributed_trips,
       count(DISTINCT n.plate) FILTER (WHERE n.plate IS NOT NULL AND n.plate <> '')::int vehicles,
       /* Bookings with no vehicle recorded against them. They appear on no
          vehicle page and in no per-vehicle total, so the vehicle directory
          sums to fifteen fewer trips than the fleet does — a difference that
          previously had no home and read as one of the two numbers being
          wrong. Reported, so the two reconcile. */
       count(*) FILTER (WHERE n.is_booking AND coalesce(btrim(n.plate), '') = '')::int trips_without_vehicle,
       count(DISTINCT n.platform) FILTER (WHERE n.is_booking)::int platforms
     FROM trip_norm n ${JOIN_TRIP} WHERE ${W('n')}`, p);

  const [v] = await q(`SELECT count(*)::int live_vehicles,
      count(*) FILTER (WHERE now()-polled_at < interval '11 minutes')::int fresh
      FROM (SELECT DISTINCT ON (plate) plate, polled_at FROM telemetry_snapshot ORDER BY plate, polled_at DESC) s`);
  // Alerts take the same fleet filter as the trips beside them; without it a
  // single-fleet view showed one fleet's trips next to both fleets' alerts.
  const [a] = await q(
    `SELECT count(*)::int alerts FROM alert
     WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR fleet_id = $3)`, [p[0], p[1], p[3]]);

  /* The money the ride platforms say they PAID, which for this fleet is nearly
     all of it. `revenue` above is sum(price) over the trip table and the Uber
     trip export carries no fare column, so on a normal month it describes 651
     of 7,356 trips — 8.8% — and the headline every page leads with was the
     hotel channel alone. The Revenue page has combined the two since it was
     built; the KPI it sits above did not, which is how a fleet turning over
     AED 257,000 in July read as AED 58,185 everywhere else.

     Kept as its own field rather than folded into revenue. A fare is what a
     rider paid for one trip; a payout is a weekly net statement after the
     platform's commission. They are both money the fleet received and they add
     up to what it took in, but they are not the same measurement and a page
     that prints one number has to be able to say which parts it is made of. */
  /* Per PLATFORM, because the two kinds of money cannot be added for the same
     one: a payout is what is left of those same fares after the platform's
     commission, so a channel reporting both would be counted nearly twice.
     api/income_sql.js picks one figure per platform and sums those — the same
     rule, the same code, as the Revenue page, which is the only way the two
     pages can be relied on to agree. */
  const [fareRows, payRows, stmtRows] = await Promise.all([
    q(platformFares(F), p),
    q(platformPayouts(), p),
    q(platformStatements(), p),
  ]);
  const num = (v) => (v == null ? null : Number(v));
  const byPlat = new Map();
  const plat = (name) => {
    if (!byPlat.has(name)) {
      byPlat.set(name, { platform: name, bookings: 0, priced_bookings: 0,
        fares: null, payouts: null, payout_days: 0 });
    }
    return byPlat.get(name);
  };
  for (const f of fareRows) Object.assign(plat(f.platform), {
    bookings: f.bookings, priced_bookings: f.priced_bookings, fares: num(f.fares) });
  for (const y of payRows) Object.assign(plat(y.platform), {
    payouts: num(y.payouts), payout_days: y.payout_days ?? 0,
    payout_drivers: y.drivers, payout_cash: num(y.cash) });
  for (const t of stmtRows) Object.assign(plat(t.platform), {
    statement_net: num(t.statement_net), statement_gross: num(t.statement_gross),
    statement_cash: num(t.statement_cash), statement_bank: num(t.statement_bank),
    statement_tips: num(t.statement_tips), statement_salik: num(t.statement_salik),
    statement_days: t.statement_days });
  const windowDays = Math.round((Date.parse(p[1]) - Date.parse(p[0])) / 86400000) + 1;
  const income = fleetIncome([...byPlat.values()], windowDays);

  const share = (n, d) => (d ? +((n / d) * 100).toFixed(1) : null);
  const payoutDays = Math.max(0, ...payRows.map((r) => r.payout_days || 0));
  const workedDays = Math.max(0, ...fareRows.map((r) => r.booking_days || 0));
  res.json({
    ...t, ...v, ...a,
    /* What the fleet took in, and the two kinds of money it is made of.
       `revenue` above is sum(price) over the trip table and the Uber export
       carries no fare column, so on a normal month it describes 651 of 7,356
       trips — the hotel channel alone, and the headline every page led with. */
    ...income,
    payouts: payRows.reduce((acc, r) => acc + Number(r.payouts || 0), 0) || null,
    payout_days: payoutDays,
    payout_drivers: payRows.reduce((acc, r) => acc + Number(r.drivers || 0), 0) || null,
    payout_platforms: payRows.map((r) => r.platform).sort(),
    /* How much of the fleet's working days the payout statements actually span.
       Three days of payout on thirty days of work is not a thirty-day figure,
       and without this the combined total reads as complete when it is a tenth
       covered. Against the days WORKED, not the calendar window: the all-time
       window is a 36,526-day sentinel, and dividing by that reported a complete
       record as 0.1% covered. Same rule as api/income_sql.js coverage(). */
    payout_coverage_pct: share(Math.min(payoutDays, workedDays || windowDays),
      workedDays || windowDays),
    priced_pct: share(t.priced_trips, t.trips),
    attributed_pct: share(t.attributed_trips, t.trips),
  });
}));

/* Volume series. All three group in Dubai time and count BOOKINGS only.
   Previously they grouped in UTC, which put the 19:00 Dubai peak at 15:00 and
   pushed every trip between midnight and 04:00 onto the previous day; and they
   counted telematics journeys alongside bookings, which double-counts the same
   physical trip. Telematics volume is returned as its own series so movement
   is still visible without being added to demand. */
/* More than twice the longest window the range picker offers, so no question a
   person can ask through the product is ever truncated by it. */
const DAILY_MAX_DAYS = 800;

app.get('/api/trips/daily', wrap(async (req, res) => {
  const p = range(req);
  /* Every day in the window, whether or not anything landed on it — and, per
     day, whether each source that normally reports actually did.

     This used to emit one row per day that had ANY row. barChart plots by
     array index, so a 124-day collection hole was drawn as two touching bars,
     and days where only the FMS collector ran came back as trips:0 and were
     drawn as a collapse to zero. Live, 45 of 91 days showed "0 trips" on days
     the fleet ran 9,712 telematics journeys, and the default 30-day view showed
     a 10x growth step that was only the Uber export resuming.

     A day nobody collected and a day nobody drove are different facts and this
     is where they stop looking the same. */
  /* The day grain, precomputed.
     ─────────────────────────────────────────────────────────────────────────
     The aggregate below groups every trip in the window by day, and one of its
     measures is a COUNT DISTINCT of drivers — which over a year is two hundred
     thousand rows hashed into three hundred and sixty-five buckets, each
     carrying its own distinct set. It timed out at a year, on the endpoint the
     overview's chart is built from.

     rollup_day holds exactly this, at exactly this grain, refreshed after every
     collection — the same trade /api/trend/monthly already makes, with the same
     fallback: when the rollup has nothing for the window (a fresh database, or
     a deploy that lands before the first collection) the live grain is computed
     from the SAME SQL the rollup is built from, rather than a second copy that
     would drift.

     One measure genuinely changes, and for the better: the rollup counts
     distinct PEOPLE, folding a person's several platform accounts into one,
     while this counted distinct driver_name. Every other page in the product
     counts people, so the overview chart and the monthly trend could report
     different driver counts for the same day. They now agree. */
  const rollupReady = (await q(
    `SELECT 1 FROM rollup_day
      WHERE day BETWEEN $1::date AND $2::date
        AND platform = coalesce($3, '*') AND fleet_id = coalesce($4, '*') LIMIT 1`, p)).length > 0;
  const aggSql = rollupReady
    ? `SELECT day AS d, bookings AS trips, completed, not_completed AS cancelled,
              telematics AS telematics_journeys, round(km, 0) AS km,
              round(revenue, 0) AS revenue, priced_trips, drivers
         FROM rollup_day
        WHERE day BETWEEN $1::date AND $2::date
          AND platform = coalesce($3, '*') AND fleet_id = coalesce($4, '*')`
    : `SELECT local_day AS d,
              count(*) FILTER (WHERE is_booking)::int trips,
              count(*) FILTER (WHERE outcome = 'completed')::int completed,
              count(*) FILTER (WHERE outcome = 'not_completed')::int cancelled,
              count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
              round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
              round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
              count(*) FILTER (WHERE has_fare)::int priced_trips,
              count(DISTINCT driver_name) FILTER (WHERE driver_name IS NOT NULL)::int drivers
       FROM trip_norm WHERE ${F} GROUP BY 1`;

  const rows = await q(
    /* The calendar is filled across the window, and the window is bounded.
       Filling the requested window is the whole point: a day nobody collected
       and a day nobody drove are different facts, and the trailing days of a
       thirty-day view showing "nothing recorded" is how a collector that
       stopped three days ago becomes visible. Clamping this to the days that
       have data would hide exactly that, which was the first attempt and was
       wrong.

       What is not a fact about anything is 2000-01-01. Asked from 2000 to 2100
       this answered with 36,526 rows — 368 of which had any trips — and 7.9MB
       of zeros, enough to stall the browser drawing it. So the SPAN is capped
       rather than the content: 800 days is more than twice the longest window
       the range picker offers, and the response says when it has been cut. */
    `WITH cal AS (
       SELECT generate_series(
         greatest($1::date, $2::date - ${DAILY_MAX_DAYS}), $2::date, interval '1 day')::date AS d
     ),
     agg AS (${aggSql}),
     -- What each source normally does, so "nothing today" can be judged.
     norm AS (
       SELECT source, percentile_cont(0.5) WITHIN GROUP (ORDER BY rows) AS median_rows,
              min(day) AS first_day, max(day) AS last_day
       FROM source_day_coverage GROUP BY source
     ),
     silent AS (
       SELECT cal.d,
              count(*) FILTER (WHERE coalesce(c.rows, 0) = 0)::int sources_silent,
              count(*)::int sources_expected,
              array_agg(n.source ORDER BY n.source) FILTER (WHERE coalesce(c.rows, 0) = 0) AS silent_sources
       FROM cal
       JOIN norm n ON cal.d BETWEEN n.first_day AND n.last_day AND n.median_rows > 0
       LEFT JOIN source_day_coverage c ON c.source = n.source AND c.day = cal.d
       GROUP BY cal.d
     )
     SELECT to_char(cal.d, 'YYYY-MM-DD') AS d,
            coalesce(agg.trips, 0) AS trips,
            coalesce(agg.completed, 0) AS completed,
            coalesce(agg.cancelled, 0) AS cancelled,
            coalesce(agg.telematics_journeys, 0) AS telematics_journeys,
            agg.km, agg.revenue, coalesce(agg.priced_trips, 0) AS priced_trips,
            coalesce(agg.drivers, 0) AS drivers,
            coalesce(silent.sources_silent, 0)::int AS sources_silent,
            coalesce(silent.sources_expected, 0)::int AS sources_expected,
            silent.silent_sources,
            -- true when NO source that normally reports reported anything.
            (silent.sources_expected IS NOT NULL
             AND silent.sources_silent = silent.sources_expected) AS uncollected
     FROM cal
     LEFT JOIN agg ON agg.d = cal.d
     LEFT JOIN silent ON silent.d = cal.d
     ORDER BY cal.d`, p);
  res.json(rows);
}));

app.get('/api/trips/hourly', wrap(async (req, res) => res.json(await q(
  `SELECT local_hour AS h, count(*)::int trips
   FROM trip_norm WHERE ${FB} GROUP BY 1 ORDER BY 1`, range(req)))));

// weekday x hour heatmap, in Dubai time
app.get('/api/trips/heatmap', wrap(async (req, res) => res.json(await q(
  `SELECT local_dow AS dow, local_hour AS h, count(*)::int trips
   FROM trip_norm WHERE ${FB} GROUP BY 1,2 ORDER BY 1,2`, range(req)))));

/* Breakdown by one dimension.
   `product` is the trap: Uber's tiers (UberX, Black, Comfort, Electric) and the
   hotel channel's booking types (pick_and_drop, drop_off, hourly) live in the
   same column and mean nothing to each other. Grouping them together produced
   a "service tier economics" table that compared an hourly hotel charter with
   an Uber drop-off and concluded one earned 4.3x the other. So `product` is
   returned qualified by platform, and the caller is told the dimension is
   platform-specific and must not be read across platforms. */
const MIX_DIMS = {
  payment: { col: 'payment_type', per_platform: false },
  status: { col: 'status', per_platform: false },
  platform: { col: 'platform', per_platform: false },
  fleet: { col: 'fleet_id', per_platform: false },
  service: { col: 'service_type', per_platform: false },
  product: { col: 'product', per_platform: true },
};

app.get('/api/mix', wrap(async (req, res) => {
  const dim = MIX_DIMS[req.query.by] || MIX_DIMS.product;
  const p = range(req);

  const rows = await q(
    `SELECT platform, ${dim.col} AS label, count(*)::int n,
            round(sum(price)::numeric,0) revenue,
            count(*) FILTER (WHERE price IS NOT NULL)::int priced_n,
            round(sum(distance_km) FILTER (WHERE price IS NOT NULL)::numeric,0) priced_km,
            round(avg(distance_km)::numeric,1) avg_km
     -- FB, not F, for EVERY dimension including platform. The exception used
     -- to be here so the platform donut could show FMS as a slice — but FMS
     -- rows are telematics twins of journeys uber and hotel already report, so
     -- the ring's centre total became the fleet's trips plus a second copy of
     -- most of them. Live, that donut printed "7,167 total" six inches under a
     -- Trips KPI reading 1,768 on the identical window. Telematics volume is
     -- returned as its own field below rather than as a slice of the same ring.
     FROM trip_norm WHERE ${FB}
     GROUP BY platform, ${dim.col}
     ORDER BY n DESC`, p);

  const [tele] = await q(
    `SELECT count(*)::int n, round(sum(distance_km) FILTER (WHERE has_distance)::numeric, 0) km
     FROM trip_norm WHERE ${F} AND NOT is_booking`, p);

  // Rows the provider never labelled are dropped from the breakdown rather than
  // charted as a category called "unknown": every telematics trip has a NULL
  // payment type, which made an 80%-unknown donut that said nothing. The count
  // is still available from /api/mix/detail so a view can caption the coverage.
  const labelled = rows.filter((r) => r.label != null && r.label !== '');

  const fold = (list, keyOf) => {
    const m = new Map();
    for (const r of list) {
      const k = keyOf(r);
      const cur = m.get(k) || { label: k, platform: dim.per_platform ? r.platform : null,
        n: 0, revenue: 0, priced_n: 0, priced_km: 0, _kmw: 0, _km: 0 };
      cur.n += r.n;
      cur.revenue += +r.revenue || 0;
      cur.priced_n += r.priced_n;
      cur.priced_km += +r.priced_km || 0;
      if (r.avg_km != null) { cur._km += +r.avg_km * r.n; cur._kmw += r.n; }
      m.set(k, cur);
    }
    return [...m.values()].map((c) => ({
      label: c.label, platform: c.platform, n: c.n,
      revenue: c.priced_n ? c.revenue : null,
      priced_n: c.priced_n, priced_km: c.priced_km || null,
      avg_km: c._kmw ? +(c._km / c._kmw).toFixed(1) : null,
      // Per-trip money is only meaningful over the priced rows.
      revenue_per_trip: c.priced_n ? +(c.revenue / c.priced_n).toFixed(2) : null,
      revenue_per_km: c.priced_km > 0 ? +(c.revenue / c.priced_km).toFixed(2) : null,
    })).sort((a, b) => b.n - a.n);
  };

  const out = dim.per_platform
    ? fold(labelled, (r) => `${r.platform}: ${r.label}`)
    : fold(labelled, (r) => r.label);

  // The bare array is what several views already consume. The telematics count
  // rides along as a non-enumerable-ish extra property so a caller that wants
  // to caption the coverage can, without it becoming a slice.
  Object.defineProperty(out, 'telematics_journeys', { value: tele?.n ?? 0, enumerable: false });
  res.set('x-telematics-journeys', String(tele?.n ?? 0));
  res.json(out);
}));

/* The same breakdown with its metadata — what the dimension means, how much of
   it is unlabelled, and whether it is safe to compare across platforms. The
   bare array above is kept because several views already consume it. */
app.get('/api/mix/detail', wrap(async (req, res) => {
  const key = MIX_DIMS[req.query.by] ? req.query.by : 'product';
  const dim = MIX_DIMS[key];
  const p = range(req);
  const rows = await q(
    `SELECT platform, ${dim.col} AS label, count(*)::int n,
            round(sum(price)::numeric,0) revenue,
            count(*) FILTER (WHERE price IS NOT NULL)::int priced_n,
            round(sum(distance_km) FILTER (WHERE price IS NOT NULL)::numeric,0) priced_km
     FROM trip_norm WHERE ${dim.col === 'platform' ? F : FB} GROUP BY platform, ${dim.col} ORDER BY n DESC`, p);
  const unlabelled = rows.filter((r) => r.label == null || r.label === '');
  const labelled = rows.filter((r) => r.label != null && r.label !== '');
  const total = rows.reduce((a, r) => a + r.n, 0);
  res.json({
    dimension: key,
    per_platform: dim.per_platform,
    total_trips: total,
    unlabelled_trips: unlabelled.reduce((a, r) => a + r.n, 0),
    unlabelled_platforms: [...new Set(unlabelled.map((r) => r.platform))],
    groups: labelled.map((r) => ({
      platform: r.platform, label: r.label, n: r.n,
      revenue: r.priced_n ? +r.revenue : null,
      priced_n: r.priced_n,
      revenue_per_trip: r.priced_n ? +(r.revenue / r.priced_n).toFixed(2) : null,
      revenue_per_km: r.priced_km > 0 ? +(r.revenue / r.priced_km).toFixed(2) : null,
    })),
  });
}));

/* ───────────────────────── drivers ───────────────────────── */
/* One row per PERSON, ranked.
   ─────────────────────────────────────────────────────────────────────────
   This grouped by (driver_name, driver_ext_id, platform) — one row per
   ACCOUNT. A ranking is a comparison, and comparing accounts ranks the fleet
   wrongly in a specific direction: somebody working Uber and Bolt appeared
   twice, each row carrying a fraction of their work, so they placed BELOW a
   single-platform driver who did less in total. The same fold used everywhere
   else puts each human on one row carrying all of it.

   Still capped, so the response says how many people there are and how many of
   them are shown; the page prints that rather than implying the list is the
   roster. */
app.get('/api/drivers/leaderboard', wrap(async (req, res) => {
  const p = range(req);
  /* Grouped on the stored fold, and counted in the same pass.
     ─────────────────────────────────────────────────────────────────────────
     Two faults, both of which this page's sibling panels had already had
     fixed. The fold that turns a person's several platform accounts into one
     row is two nested regexes, and running it as the GROUP BY key costs
     nineteen twentieths of the query (schema_v20 measured 2,434ms against
     129ms); trip.person_key is that expression, stored and indexed. And the
     population underneath the table — "N of M people", which has to count
     everybody rather than the hundred rows shown, or the sentence understates
     the fleet — was a second full aggregation of the same window at the same
     grain. It rides on the first one now.

     The filter still tests driver_name. Matching the partial index's own
     predicate is what took the driver directory from 4.3 seconds to 41. */
  const rows = await q(
    `WITH people AS (
       SELECT t.person_key AS person,
            max(n.driver_name) AS driver_name,
            (array_agg(DISTINCT n.driver_ext_id) FILTER (WHERE n.driver_ext_id IS NOT NULL))[1] AS driver_ext_id,
            array_remove(array_agg(DISTINCT n.platform), NULL) AS platforms,
            count(DISTINCT n.driver_ext_id)::int accounts,
            mode() WITHIN GROUP (ORDER BY n.plate) AS plate,
            count(*)::int trips,
            round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric,0) km,
            round(avg(n.distance_km) FILTER (WHERE n.has_distance)::numeric,1) avg_km,
            round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
            -- Testing status = 'completed' scored every completed Bolt trip as a
            -- failure (Bolt says 'finished'), and FMS telematics rows, which
            -- hardcode 'completed' and cannot be cancelled at all, padded the
            -- denominator. outcome is NULL on telematics, so FILTER drops them
            -- from both sides rather than counting them as successes.
            round(100.0*count(*) FILTER (WHERE n.outcome='completed')
                  /nullif(count(*) FILTER (WHERE n.outcome IS NOT NULL),0)) completion_pct,
            count(*) FILTER (WHERE n.outcome IS NOT NULL)::int outcome_n
       FROM trip_norm n ${JOIN_TRIP}
       WHERE ${W('n')} AND coalesce(btrim(n.driver_name), '') <> ''
       GROUP BY t.person_key)
     SELECT *, count(*) OVER ()::int AS _people
       FROM people ORDER BY trips DESC LIMIT 100`, p);
  const people = rows.length ? rows[0]._people : 0;
  for (const r of rows) delete r._people;
  res.json({ rows, people: people || rows.length, shown: rows.length,
    truncated: people > rows.length });
}));

/* One row per PERSON, with a column per platform that actually has data.
   Three things were wrong here at once and they compounded:
     - the hard-coded column list had no `hotel`, which is one of only three
       platforms with trip data, so a driver working Uber and the hotel channel
       scored one platform and the panel printed the flat denial "No driver in
       this window has trips on more than one platform" — on a page whose own
       directory had already listed five of them;
     - total_trips was count(*) over ALL platforms while the columns covered
       four, so a row could show four zeros beside a three-digit total;
     - the grouping key was the raw name string, so "Kashif Ali Ayyub khan" and
       "KASHIF ALI AYYUB KHAN" were two people, neither of whom looked
       cross-platform.
   The fold is the same one the driver directory uses. */
app.get('/api/drivers/cross-platform', wrap(async (req, res) => {
  const p = range(req);
  const platforms = (await q(
    `SELECT DISTINCT platform FROM trip_norm WHERE ${F} AND driver_name IS NOT NULL ORDER BY 1`, p))
    .map((r) => r.platform);
  const cols = platforms.map((pl) =>
    `count(*) FILTER (WHERE n.platform = ${quote(pl)})::int "${pl}_trips"`).join(',\n          ');
  /* Grouped on the STORED fold, and aggregated once.
     ─────────────────────────────────────────────────────────────────────────
     A person can hold several platform accounts, so this table folds them by
     name — and it did that by running the fold's two nested regexes over every
     row, as the GROUP BY key. schema_v20 added `trip.person_key` as a stored
     generated column carrying exactly that expression, with an index, and
     recorded the measurement in its own header: the same aggregate costs
     2,434ms with the regex and 129ms without it. This route was the one site
     that never moved to it.

     It also aggregated the same rows TWICE — once for the hundred and fifty
     rows the page shows, and again in full for the two population counts
     underneath it ("N of M people work more than one channel", which must be
     counted over everybody rather than over the page). One CTE now serves
     both.

     The join is 1:1 — `trip` is PRIMARY KEY (platform, external_id), which is
     the join key — so nothing fans out and no count inflates. And the WHERE
     deliberately still tests driver_name rather than person_key: making the
     predicate match the partial index's definition is what took the driver
     directory from 4.3 seconds to 41, because the planner then chose that
     index and walked most of the table with it. person_key is the grouping
     key here, never the filter. */
  const rows = await q(
    `WITH people AS (
       SELECT t.person_key AS person, max(n.driver_name) driver_name,
            ${cols}${cols ? ',' : ''}
            count(*) FILTER (WHERE n.is_booking)::int booking_trips,
            count(*) FILTER (WHERE NOT n.is_booking)::int telematics_journeys,
            count(*)::int total_trips,
            count(DISTINCT n.platform)::int platform_count,
            count(DISTINCT n.driver_ext_id)::int accounts,
            -- Any one of the person's platform ids. /api/driver/* resolves an
            -- id to the whole folded person, so one is enough to make the name
            -- a link; without it the row named somebody you could not open.
            (array_agg(DISTINCT n.driver_ext_id) FILTER (WHERE n.driver_ext_id IS NOT NULL))[1] AS driver_ext_id,
            round(sum(n.distance_km) FILTER (WHERE n.has_distance)::numeric,0) km,
            round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
            count(*) FILTER (WHERE n.has_fare)::int priced_trips,
            /* What they drove. A person working three platforms is usually
               working them from ONE car, and that was the fact this table
               could not show: the row folded four accounts into one human and
               then made you open them to find out which asset it was. Taken
               from the trips in this window rather than from custody, because
               the fold here is by name and custody is keyed per id. */
            (array_agg(DISTINCT n.plate) FILTER (WHERE n.plate IS NOT NULL))[1:3] AS plates,
            count(DISTINCT n.plate) FILTER (WHERE n.plate IS NOT NULL)::int plate_n,
            mode() WITHIN GROUP (ORDER BY n.plate) AS main_plate
       FROM trip_norm n ${JOIN_TRIP}
       WHERE ${W('n')} AND coalesce(btrim(n.driver_name), '') <> ''
       GROUP BY t.person_key)
     SELECT *,
            /* The population, carried on every row rather than counted by a
               second pass over the same grain. */
            count(*) OVER ()::int AS _people,
            count(*) FILTER (WHERE platform_count > 1) OVER ()::int AS _multi
       FROM people ORDER BY total_trips DESC LIMIT 150`, p);
  /* Counted over every person, not over the 150 rows this page happened to
     receive. The panel prints "N of M people work more than one channel", and
     with more than 150 drivers in the window M was the cap — so the sentence
     understated the fleet and the share it implies was wrong. */
  const pop = rows.length
    ? { people: rows[0]._people, multi: rows[0]._multi }
    : { people: 0, multi: 0 };
  for (const r of rows) { delete r._people; delete r._multi; }
  res.json({ platforms, drivers: rows,
    people: pop?.people ?? rows.length,
    multi_platform: pop?.multi ?? 0,
    shown: rows.length,
    truncated: (pop?.people ?? 0) > rows.length,
    note: 'One row per person: platform accounts are folded by name, and the columns cover every '
      + 'platform with data in this window, so the total is the sum of what is shown.' });
}));

/* Platform-reported performance records, most recent period first.
   ─────────────────────────────────────────────────────────────────────────
   Capped, and it started to bite the moment the Uber collector was fixed: a
   weekly period used to hold ten drivers because the collector could only see
   ten, and now holds a hundred and fifty, so 300 rows is two periods rather
   than a year of them. The list looked identical before and after — no error,
   no gap, just fourteen periods that quietly stopped being in it.

   The totals are counted over the whole window so the page can say what it is
   showing, and the periods are listed in full: a reader choosing a period from
   a menu built out of a truncated list cannot see the ones that were cut. */
app.get('/api/drivers/performance', wrap(async (req, res) => {
  const p = range(req);
  /* Every figure here reads driver_payout / driver_payout_day rather than
     driver_performance. The raw table is a log of REPORT WINDOWS, and the same
     payout week arrives under two keys whenever a backfill and a catch-up use
     different grids — so `sum(earnings)` over it counted the money two and
     three times. The window is also matched on overlap now, not containment:
     `period_start >= from AND period_end <= to` means "periods wholly inside",
     which drops the weeks straddling both edges of every 30-day view.
     See sql/schema_v23.sql. */
  const rows = await q(
    `SELECT platform, driver_name, driver_ext_id, period_start, period_end,
            period_days, days_used,
            round(trips::numeric,0)::int AS trips,
            round(hours_online::numeric,2) AS hours_online,
            round(hours_on_trip::numeric,2) AS hours_on_trip,
            round(distance_km::numeric,1) AS distance_km,
            round(period_earnings::numeric,2) AS earnings,
            round(earnings::numeric,2) AS counted,
            round(cash_earnings::numeric,2) AS cash_earnings
     FROM driver_payout WHERE period_end >= $1 AND period_start <= $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     ORDER BY period_start DESC, trips DESC NULLS LAST LIMIT 300`, p);
  const [t] = await q(
    /* `total` counts payout ROWS, because that is what `rows` above lists and
       what `truncated` compares against — a day count here would report the
       list as truncated on a window that fits entirely. */
    `SELECT count(DISTINCT (platform, driver_ext_id, period_start, period_end))::int total,
            count(DISTINCT (platform, period_start, period_end))::int periods,
            count(DISTINCT day)::int payout_days,
            ${peopleCount('driver_ext_id', 'driver_name')}::int people,
            round(sum(earnings)::numeric, 2) AS earnings,
            round(sum(cash_earnings)::numeric, 2) AS cash_earnings,
            array_remove(array_agg(DISTINCT platform), NULL) AS platforms
     FROM driver_payout_day WHERE day BETWEEN $1 AND $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`, p);
  const periods = await q(
    `SELECT platform, to_char(period_start,'YYYY-MM-DD') AS period_start,
            to_char(period_end,'YYYY-MM-DD') AS period_end,
            count(DISTINCT driver_ext_id)::int drivers,
            round(sum(earnings)::numeric,2) AS earnings
     FROM driver_payout_day WHERE day BETWEEN $1 AND $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     GROUP BY 1,2,3 ORDER BY 2 DESC, 1`, p);
  res.json({ rows, periods, totals: t, shown: rows.length,
    truncated: (t?.total ?? 0) > rows.length });
}));

/* ───────────────────────── vehicles / fleet ───────────────────────── */
app.get('/api/vehicles', wrap(async (req, res) => {
  const rows = await q(
  /* Bookings and telematics journeys are counted separately and never summed:
     an FMS row is the same physical journey the ride platform already reported,
     so adding them showed a 2–3.5x overcount as "trips". Distance is guarded by
     has_distance for the same reason the schema documents — one odometer-derived
     FMS row carries 193,027 km and put 1.6 million km against a single car. */
  `SELECT t.plate,
          count(*) FILTER (WHERE t.is_booking)::int trips,
          count(*) FILTER (WHERE NOT t.is_booking)::int telematics_journeys,
          round(sum(t.distance_km) FILTER (WHERE t.is_booking AND t.has_distance)::numeric,0) km,
          round(sum(t.distance_km) FILTER (WHERE NOT t.is_booking AND t.has_distance)::numeric,0) telematics_km,
          round(sum(t.price) FILTER (WHERE t.has_fare)::numeric,0) revenue,
          count(*) FILTER (WHERE t.has_fare)::int priced_trips,
          ${peopleCount('t.driver_ext_id', 't.driver_name')}::int drivers,
          count(distinct t.platform)::int platforms, max(t.requested_at) last_trip,
          cd.driver_name AS current_driver, cd.driver_ext_id AS current_driver_id,
          cd.as_of AS driver_as_of
   FROM trip_norm t
   LEFT JOIN vehicle_current_driver cd ON cd.plate = t.plate
   WHERE ${W('t')} AND t.plate IS NOT NULL AND t.plate<>''
   GROUP BY t.plate, cd.driver_name, cd.driver_ext_id, cd.as_of
   ORDER BY trips DESC, telematics_journeys DESC LIMIT 200`, range(req));
  /* How many vehicles there ARE, so the busiest 200 cannot be read as the
     fleet. /api/vehicles/directory is the complete register; this endpoint is
     the ranked slice, and a slice that does not say so is a wrong total. */
  const [t] = await q(
    `SELECT count(DISTINCT t.plate)::int vehicles FROM trip_norm t
     WHERE ${W('t')} AND t.plate IS NOT NULL AND t.plate<>''`, range(req));
  res.json({ rows, total: t?.vehicles ?? rows.length, shown: rows.length,
    truncated: (t?.vehicles ?? 0) > rows.length });
}));

app.get('/api/live', wrap(async (_, res) => res.json(await q(
  `SELECT s.plate, s.fleet_id, s.source, s.captured_at, s.polled_at, s.lat, s.lng, s.speed, s.status,
          s.seat_occupied, s.fuel_level, s.ac_on, s.odometer,
          /* Staleness is a property of the FIX, not of our poll. CABMAN returns
             the last known position of every vehicle on every cycle, so a
             tracker that died in April 2024 still gets a fresh polled_at every
             five minutes — and 55 of 130 vehicles were being shown as live with
             no actual fix in over eleven minutes. The poll age is returned
             separately so "our collector is down" and "this tracker stopped
             reporting" stay two different states. */
          (now() - s.captured_at > interval '11 minutes') AS stale,
          round(extract(epoch FROM now() - s.captured_at) / 60)::int AS fix_age_min,
          round(extract(epoch FROM now() - s.polled_at) / 60)::int AS poll_age_min,
          cd.driver_name AS current_driver, cd.as_of AS driver_as_of
   FROM (SELECT DISTINCT ON (plate) * FROM telemetry_snapshot ORDER BY plate, polled_at DESC) s
   LEFT JOIN vehicle_current_driver cd ON cd.plate = s.plate
   ORDER BY s.plate`))));

// Breadcrumb trail. Only GPS-bearing sources: Uber writes driver-status rows into
// the same table with no coordinates, and those would otherwise punch holes in a path.
app.get('/api/track', wrap(async (req, res) => {
  if (!req.query.plate) return res.status(400).json({ error: 'plate required' });
  res.json(await q(
    `SELECT captured_at, lat, lng, speed, status, seat_occupied, ignition, source
     FROM telemetry_snapshot
     WHERE plate=$1 AND lat IS NOT NULL AND lng IS NOT NULL
       AND captured_at BETWEEN $2 AND $3
     ORDER BY captured_at`,
    [req.query.plate.toUpperCase().replace(/[\s-]+/g, ''), ...win(req)]));
}));

/* ───────────────────── map: where was the fleet, when ───────────────────── */
// Which plates have a replayable trail on a given day, and who was driving.
app.get('/api/map/days', wrap(async (req, res) => {
  res.json(await q(
    /* The driver named against a day must be the driver who held the car ON
       THAT DAY. This joined vehicle_current_driver — a view that is DISTINCT ON
       (plate) ORDER BY day DESC, i.e. whoever holds the car NOW — so every
       replayable day in the list, however far back, was labelled with today's
       custodian. Picking a day in March and reading a name off it named
       somebody who may not have driven the vehicle in months.

       vehicle_driver_day is keyed on the Dubai-local day, which is the same key
       this query groups by, so the correct answer is a join rather than a
       lookup. as_of_today is kept so the map can still say who has it now, but
       it is a separate, separately-labelled fact. */
    `WITH d AS (
       SELECT (t.captured_at AT TIME ZONE 'Asia/Dubai')::date AS day,
              t.plate, t.fleet_id, count(*)::int fixes,
              min(t.captured_at) first_fix, max(t.captured_at) last_fix,
              round(max(t.speed)::numeric,0) max_speed,
              sum((t.seat_occupied)::int)::int occupied_fixes
       FROM telemetry_snapshot t
       WHERE t.lat IS NOT NULL
         AND ($1::text IS NULL OR t.plate = $1)
         AND t.captured_at BETWEEN $2 AND $3
       GROUP BY 1,2,3
       HAVING count(*) >= 2)
     SELECT d.*,
            vdd.driver_name, vdd.driver_ext_id, vdd.trips AS driver_trips,
            cd.driver_name AS current_driver_name
     FROM d
     LEFT JOIN LATERAL (
       SELECT driver_name, driver_ext_id, trips FROM vehicle_driver_day v
       WHERE v.plate = d.plate AND v.day = d.day
       ORDER BY v.is_primary DESC, v.trips DESC NULLS LAST LIMIT 1) vdd ON true
     LEFT JOIN vehicle_current_driver cd ON cd.plate = d.plate
     ORDER BY d.day DESC, d.fixes DESC LIMIT 400`,
    [req.query.plate ? req.query.plate.toUpperCase().replace(/[\s-]+/g, '') : null,
     ...win(req)]));
}));

// A day's journey for one vehicle, split into segments wherever the car stopped
// or the gap between fixes is too long to draw a straight line through honestly.
app.get('/api/map/journey', wrap(async (req, res) => {
  if (!req.query.plate) return res.status(400).json({ error: 'plate required' });
  const plate = req.query.plate.toUpperCase().replace(/[\s-]+/g, '');
  const day = req.query.day || new Date().toISOString().slice(0, 10);
  const fixes = await q(
    `SELECT captured_at, lat, lng, speed, status, seat_occupied, ignition
     FROM telemetry_snapshot
     WHERE plate=$1 AND lat IS NOT NULL
       AND captured_at >= ($2::date)::timestamptz - interval '4 hours'
       AND captured_at <  ($2::date + 1)::timestamptz - interval '4 hours'
     ORDER BY captured_at`, [plate, day]);

  // haversine, km
  const R = 6371, rad = (d) => d * Math.PI / 180;
  const dist = (a, b) => {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  };

  const GAP_MIN = 20;          // a longer silence than this is not a straight line
  const segments = [];
  let cur = null, km = 0, movingKm = 0, occupiedKm = 0, measuredKm = 0, occupiedFixes = 0;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i], prev = fixes[i - 1];
    const gapMin = prev ? (new Date(f.captured_at) - new Date(prev.captured_at)) / 6e4 : 0;
    const step = prev ? dist(prev, f) : 0;
    if (prev && gapMin <= GAP_MIN && step < 60) {           // 60km in one hop = bad fix
      km += step;
      if ((prev.speed || 0) > 0) movingKm += step;
      /* A NULL seat sensor is NOT an empty seat. FMS never reports occupancy at
         all, so treating NULL as false gave every FMS-tracked vehicle a hard
         "With passenger 0 km · 0% of distance" — including one that ran fifteen
         bookings and 101.9 km that day — and drew its whole trail dashed in the
         "Running empty" colour, which is a positive claim rather than an
         absence. Only fixes that actually reported are measured. */
      if (prev.seat_occupied !== null && prev.seat_occupied !== undefined) {
        measuredKm += step;
        if (prev.seat_occupied) occupiedKm += step;
      }
    }
    if (f.seat_occupied !== null && f.seat_occupied !== undefined) occupiedFixes++;
    // `occupied` is tri-state on the wire: true, false, or null for "this feed
    // does not report it". The map colours the third case neutrally.
    const occ = f.seat_occupied === null || f.seat_occupied === undefined ? null : !!f.seat_occupied;
    if (!cur || gapMin > GAP_MIN) { cur = { points: [], occupied: occ }; segments.push(cur); }
    cur.points.push({ t: f.captured_at, lat: f.lat, lng: f.lng, speed: f.speed,
                      status: f.status, occupied: occ });
  }
  const [drv] = await q(
    // The id too. The map's KPI row printed this person's name and linked
    // nowhere, on the page most likely to raise a question about them.
    `SELECT driver_name, driver_ext_id, trips FROM vehicle_driver_day
     WHERE plate=$1 AND day=$2 ORDER BY trips DESC LIMIT 1`, [plate, day]);
  res.json({
    plate, day, fixes: fixes.length, segments,
    driver: drv?.driver_name || null, driver_id: drv?.driver_ext_id || null,
    driver_trips: drv?.trips ?? null,
    distance_km: Math.round(km * 10) / 10,
    moving_km: Math.round(movingKm * 10) / 10,
    // null, not 0, when no fix on this day reported occupancy at all.
    occupied_km: occupiedFixes ? Math.round(occupiedKm * 10) / 10 : null,
    occupancy_measured_km: occupiedFixes ? Math.round(measuredKm * 10) / 10 : 0,
    occupancy_reported_fixes: occupiedFixes,
    occupancy_reported: occupiedFixes > 0,
    first_fix: fixes[0]?.captured_at || null,
    last_fix: fixes[fixes.length - 1]?.captured_at || null,
  });
}));

/* ───────────────────────── safety ───────────────────────── */
app.get('/api/alerts/summary', wrap(async (req, res) => res.json(await q(
  `SELECT alert_type, count(*)::int n FROM alert WHERE ${DAYWIN('occurred_at')}
   GROUP BY 1 ORDER BY 2 DESC`, [range(req)[0], range(req)[1]]))));

/* Harsh driving is a person's behaviour, not a plate's — so name whoever held
   the car ON THE DAY OF THE EVENT.

   This used to join `vehicle_current_driver`, which is DISTINCT ON (plate)
   ORDER BY day DESC — today's holder. Every alert from every earlier day was
   therefore attributed to whoever has the car now, which on a fleet with
   handovers means coaching the wrong person from a year-old event.

   vehicle_driver_day has ONE ROW PER PLATFORM per plate per day, so it is
   collapsed with DISTINCT ON (plate, day) before the join. Joining it directly
   multiplied alert counts by the number of platforms a driver worked — the
   same fan-out that once showed 584 events twice under two spellings of one
   name. Unattributed events are counted and reported as such rather than being
   folded into somebody's total. */
app.get('/api/alerts/by-vehicle', wrap(async (req, res) => {
  const [from, to] = range(req);
  const rows = await q(
    `WITH ev AS (
       SELECT plate, alert_type,
              (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day
       FROM alert WHERE ${DAYWIN('occurred_at')}
     ),
     custody AS (
       SELECT DISTINCT ON (plate, day) plate, day, driver_name, driver_ext_id
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
       ORDER BY plate, day, trips DESC NULLS LAST, driver_name
     )
     SELECT ev.plate,
            count(*)::int alerts,
            sum((ev.alert_type ILIKE '%brake%')::int)::int harsh_brake,
            sum((ev.alert_type ILIKE '%accel%')::int)::int harsh_accel,
            sum((ev.alert_type ILIKE '%turn%')::int)::int sharp_turn,
            sum((ev.alert_type ILIKE '%speed%')::int)::int overspeed,
            -- Everything the four buckets above do not catch, so the columns
            -- and the total can be reconciled instead of silently disagreeing.
            count(*) FILTER (WHERE ev.alert_type NOT ILIKE '%brake%'
                               AND ev.alert_type NOT ILIKE '%accel%'
                               AND ev.alert_type NOT ILIKE '%turn%'
                               AND ev.alert_type NOT ILIKE '%speed%')::int other,
            count(*) FILTER (WHERE c.driver_name IS NULL)::int unattributed,
            count(DISTINCT c.driver_name)::int drivers,
            (array_agg(c.driver_name ORDER BY c.driver_name)
               FILTER (WHERE c.driver_name IS NOT NULL))[1] AS top_driver,
            (array_agg(c.driver_ext_id ORDER BY c.driver_name)
               FILTER (WHERE c.driver_ext_id IS NOT NULL))[1] AS top_driver_id
     FROM ev LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day
     GROUP BY ev.plate ORDER BY alerts DESC LIMIT 100`, [from, to]);
  /* The page's "Vehicles involved" tile was the length of this list. The fleet
     runs about 130 vehicles against a cap of 100 — under the cap today, over it
     on any month where most of the fleet triggers something, and the tile would
     read exactly 100 with nothing to say it had been cut. */
  const [t] = await q(
    `SELECT count(DISTINCT plate)::int vehicles, count(*)::int alerts
     FROM alert WHERE ${DAYWIN('occurred_at')}`, [from, to]);
  res.json({ rows, totals: t, shown: rows.length,
    truncated: (t?.vehicles ?? 0) > rows.length });
}));

/* The same events, attributed to people rather than to plates. The safety page
   named nobody at all: it fetched a driver column and rendered only the plate. */
app.get('/api/alerts/by-driver', wrap(async (req, res) => {
  const [from, to] = range(req);
  const rows = await q(
    `WITH ev AS (
       SELECT plate, alert_type, (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day
       FROM alert WHERE ${DAYWIN('occurred_at')}
     ),
     custody AS (
       SELECT DISTINCT ON (plate, day) plate, day, driver_name, driver_ext_id, person_key
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
       ORDER BY plate, day, trips DESC NULLS LAST, driver_name
     ),
     people AS (
       SELECT coalesce(c.driver_name, '(unattributed)') AS driver_name,
              max(c.driver_ext_id) AS driver_ext_id,
              /* Who this row is about, carried down so the distance below can be
                 asked for them and nobody else. It is a function of the grouping
                 key — vehicle_driver_day generates person_key out of the same
                 driver_name — so every row in a group agrees on it and max() is
                 choosing between identical values. */
              max(c.person_key) AS person,
              count(*)::int alerts,
              sum((ev.alert_type ILIKE '%brake%')::int)::int harsh_brake,
              sum((ev.alert_type ILIKE '%accel%')::int)::int harsh_accel,
              sum((ev.alert_type ILIKE '%turn%')::int)::int sharp_turn,
              sum((ev.alert_type ILIKE '%speed%')::int)::int overspeed,
              count(DISTINCT ev.plate)::int plates,
              /* Which cars, not just how many. A row saying somebody has 18
                 harsh-braking events across 4 plates is not something anybody
                 can look into until they know which 4 — and "plates: 4" is a
                 number you cannot click. Capped at three with the count kept
                 beside it, so a truncated list admits that it is one. */
              (array_agg(DISTINCT ev.plate ORDER BY ev.plate))[1:3] AS plate_list,
              bool_or(c.driver_name IS NOT NULL) AS named,
              count(*) FILTER (WHERE c.driver_name IS NULL)::int nameless
       FROM ev LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day
       GROUP BY 1
     ),
     /* The hundred rows the page prints, and the three figures printed under
        them. Those figures used to be a second request to the database, and a
        second request here is not a cheap one: it replayed the whole alert scan
        and the whole windowed custody fold — the two most expensive things this
        endpoint does — to arrive at three numbers. They ride on the list now,
        the way the driver directory's population count already does.

        They count over every group rather than over the hundred, which is the
        whole point of them, so the window runs before the cap does. */
     shown AS (
       SELECT *,
              count(*) FILTER (WHERE named) OVER ()::int AS _drivers,
              sum(alerts) OVER ()::int AS _alerts,
              sum(nameless) OVER ()::int AS _unattributed
       FROM people ORDER BY alerts DESC LIMIT 100
     ),
     /* Distance driven by that PERSON over the window, so a rate can be computed
        over bookings rather than over bookings plus their telematics twins.

        Grouped on the folded name, not the raw one. Grouping on the raw string
        split one human across their platform spellings and gave the rate a
        denominator covering only one of their accounts — 240 km for somebody
        who drove 340. This is the same fold the driver directory uses. */
     km AS (
       /* person_key on both sides, not the fold. This grouped 175,000 trip rows
          through two nested regexp_replace calls, and the join below then
          computed the same fold again for every custody row it matched. Over a
          window covering the whole record the endpoint took 93 seconds, while
          /api/kpis scans the same trips in 0.67 — the difference was entirely
          the regex. sql/schema_v20.sql stores the identical expression on both
          trip and vehicle_driver_day, so this is the same answer as an index
          lookup rather than a computation.

          The join is load-bearing and cannot go: local_day, is_booking and
          has_distance are trip_norm's, and person_key is the base table's,
          because a view's star is frozen at creation — sql/schema_v18.sql says
          so at length. What could go is the work. Both restrictions below are
          on t, and neither changes a row of the answer.

          One is the window, which t did not have. Every predicate here was on
          n, so the planner had nothing to narrow t by and read all 215,000 trip
          rows for it whatever the window said — at a week that is the entire
          cost of this endpoint. t and n are the SAME ROW: the join key is
          trip's primary key, so a window true of one is true of the other, and
          saying it twice lets both sides use trip_local_day_idx.

          The other is the hundred people. This aggregated every driver in the
          fleet to decorate a list ordered by something distance has no part in,
          so seven of every eight sums it computed were for somebody the page
          was never going to name. */
       SELECT t.person_key AS person, sum(n.distance_km) AS km
       FROM trip_norm n ${JOIN_TRIP}
       WHERE t.person_key IN (SELECT person FROM shown WHERE person IS NOT NULL)
         AND ${DAYWIN('t.requested_at')}
         AND n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.has_distance
         AND n.driver_name IS NOT NULL AND btrim(n.driver_name) <> ''
       GROUP BY 1
     )
     SELECT s.driver_name, s.driver_ext_id, s.alerts,
            s.harsh_brake, s.harsh_accel, s.sharp_turn, s.overspeed,
            s.plates, s.plate_list,
            round(km.km::numeric, 0) AS booked_km,
            round((s.alerts * 100.0 / nullif(km.km, 0))::numeric, 2) AS per_100km,
            s._drivers, s._alerts, s._unattributed
     FROM shown s LEFT JOIN km ON km.person = s.person
     ORDER BY s.alerts DESC`, [from, to]);
  /* Named drivers, counted over the whole window rather than over the returned
     rows, and counted the way the list groups: by custody name, excluding the
     "(unattributed)" bucket, which is not a person. */
  const totals = rows.length
    ? { drivers: rows[0]._drivers, alerts: rows[0]._alerts, unattributed: rows[0]._unattributed }
    : { drivers: 0, alerts: 0, unattributed: 0 };
  for (const r of rows) { delete r._drivers; delete r._alerts; delete r._unattributed; }
  res.json({ rows, totals, shown: rows.length,
    truncated: totals.drivers > rows.filter((r) => r.driver_name !== '(unattributed)').length });
}));

// Who was driving this plate, day by day (handovers included).
/* /api/vehicle/drivers and /api/driver/vehicles used to be declared here, and
   both predated the per-entity route modules. Being declared first, they won
   the Express match — so the whole product's two "who drove what" endpoints
   were the two oldest implementations of it:

     - /api/driver/vehicles took `driver_id` while its eleven siblings take
       `id`, so a link built the way every other link is built answered 400.
       It also took ONE raw id, so a person with an Uber account and a Bolt
       account saw one of their cars; and it ignored the window entirely, so it
       answered about all of history under a page filtered to a month.

     - /api/vehicle/drivers answered 200 for a plate that does not exist, while
       every other vehicle route 404s. A page that renders empty for a typo,
       instead of saying the vehicle is unknown, reads as "this car did
       nothing".

   They live in the route modules now, where withDriver/withVehicle already
   resolve the entity, apply the Dubai window and refuse an unknown id.
*/

/* ───────────────────────── finance ───────────────────────── */
app.get('/api/finance/ledger', wrap(async (req, res) => res.json(await q(
  `SELECT category, count(*)::int n, round(sum(amount)::numeric,2) amount, currency
   FROM ledger_entry WHERE ${DAYWIN('event_at')} AND ($3::text IS NULL OR platform=$3)
   GROUP BY category, currency ORDER BY abs(sum(amount)) DESC LIMIT 60`,
  [range(req)[0], range(req)[1], range(req)[2]]))));

/* One row per calendar day, with null — not zero — where nothing was recorded.
   areaChart positions points by array index, so days absent from the response
   were not gaps: the line was drawn straight from the last collected day to the
   next as if they were adjacent, compressing a 123-day hole into one segment.
   And a null amount coerced to 0, so 186 days on which no fare was ever
   collected were drawn as AED 0 of revenue. */
app.get('/api/finance/daily', wrap(async (req, res) => {
  const [from, to] = range(req);
  res.json(await q(
    `WITH cal AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d),
     led AS (
       SELECT (event_at AT TIME ZONE 'Asia/Dubai')::date AS d,
              round(sum(amount)::numeric,2) amount, count(*)::int entries
       FROM ledger_entry WHERE ${DAYWIN('event_at')} GROUP BY 1
     ),
     fare AS (
       SELECT local_day AS d, round(sum(price)::numeric,2) revenue,
              count(*) FILTER (WHERE has_fare)::int priced_trips
       FROM trip_norm WHERE local_day BETWEEN $1::date AND $2::date AND has_fare GROUP BY 1
     )
     SELECT to_char(cal.d, 'YYYY-MM-DD') AS d, led.amount, led.entries,
            fare.revenue, coalesce(fare.priced_trips, 0) AS priced_trips,
            (led.d IS NULL AND fare.d IS NULL) AS nothing_recorded
     FROM cal LEFT JOIN led ON led.d = cal.d LEFT JOIN fare ON fare.d = cal.d
     ORDER BY cal.d`, [from, to]));
}));

/* ───────────────────────── unauthorized trips ───────────────────────── */
// Seat-sensor occupancy that no booking explains. See docs/unauthorized-trips.md.
app.get('/api/unauthorized/summary', wrap(async (req, res) => {
  const [from, to] = range(req);
  const rows = await q(
    `SELECT verdict, count(*)::int n, round(sum(distance_km)::numeric,0) km,
            round(sum(duration_min)::numeric,0) minutes
     FROM occupancy_segment WHERE ${DAYWIN('started_at')} GROUP BY verdict ORDER BY n DESC`, [from, to]);
  /* Built FROM the same rows as the donut, not from a second query with its
     own hand-written verdict list. That list named four of the seven verdicts
     schema_v8 documents, so `unverifiable` and `stationary` were counted
     nowhere: the KPI tiles summed to 36 while the donut beneath them showed 52,
     and the eight missing rows were precisely the ones the reconciler flagged
     as needing a human. A strip that cannot drift from the chart under it
     cannot disagree with it. */
  const [extra] = await q(
    `SELECT round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,0) unauth_km,
            count(*) FILTER (WHERE verdict='unauthorized' AND low_confidence)::int low_confidence,
            count(*) FILTER (WHERE low_confidence)::int needs_a_human,
            /* How much of the window this answer actually covers.
               ─────────────────────────────────────────────────────────────
               Seat occupancy comes from CABMAN, which is a five-minute
               realtime poll: it stores what it sees from the moment it starts
               and there is no history behind it. On this fleet that is about
               three days of evidence, and the page was reporting "0 unexplained
               trips" over a thirty-day window on the strength of it.

               The number was never wrong — it was right about three days and
               presented as an answer about thirty. Those are different claims
               and only one of them is true. */
            count(DISTINCT (started_at AT TIME ZONE 'Asia/Dubai')::date)::int days_with_data
     FROM occupancy_segment WHERE ${DAYWIN('started_at')}`, [from, to]);
  const daysInWindow = Math.max(1, Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1);
  const byVerdict = Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
  res.json({
    byVerdict: rows,
    /* Stated beside the verdicts rather than left to be inferred from a chart:
       a reader who does not know the evidence covers three days will read every
       figure here as a month's worth. */
    coverage: {
      days_with_data: extra?.days_with_data || 0,
      days_in_window: daysInWindow,
      complete: (extra?.days_with_data || 0) >= daysInWindow,
    },
    totals: {
      // Every verdict the schema defines, whether or not it occurred, so a
      // category dropping to zero is visible rather than absent.
      unauthorized: byVerdict.unauthorized || 0,
      authorized: byVerdict.authorized || 0,
      unverifiable: byVerdict.unverifiable || 0,
      pending: byVerdict.pending || 0,
      partial: byVerdict.partial || 0,
      sensor_suspect: byVerdict.sensor_suspect || 0,
      stationary: byVerdict.stationary || 0,
      segments: rows.reduce((a, r) => a + r.n, 0),
      unauth_km: extra?.unauth_km ?? null,
      low_confidence: extra?.low_confidence ?? 0,
      needs_a_human: extra?.needs_a_human ?? 0,
    },
  });
}));

app.get('/api/unauthorized/list', wrap(async (req, res) => {
  const [from, to] = range(req);
  const verdict = req.query.verdict || 'unauthorized';
  res.json(await q(
    /* schema_v8 added verdict_reason, nearest_platform, nearest_trip_id,
       nearest_gap_min, channels_checked and boundary_gap_min for one purpose:
       to make a verdict falsifiable. Its own header says nearest_gap_min is
       "the field that makes a clock skew self-evident — thirteen accusations
       each showing a nearest booking exactly 240 minutes away is one bug, not
       thirteen dishonest drivers". None of it was being selected, and the UI
       printed a hardcoded English sentence keyed on the verdict instead — with
       no entry for `unverifiable` or `pending`, so eight of fifty-two segments
       opened a blank "Why this verdict". */
    `SELECT o.plate, o.fleet_id, o.started_at, o.ended_at, o.duration_min, o.distance_km,
            o.top_speed, o.fixes, o.max_gap_min, o.ignition_ratio, o.verdict,
            o.matched_platform, o.matched_trip_id, o.low_confidence, o.unavailable_sources,
            o.verdict_reason, o.nearest_platform, o.nearest_trip_id, o.nearest_gap_min,
            o.channels_checked, o.boundary_gap_min,
            o.start_lat, o.start_lng, o.end_lat, o.end_lng,
            -- The driver who held the car that day, not whoever has it now —
            -- as name-and-id pairs, because a comma-joined string of names is
            -- a dead end by construction and a handover day names two people
            -- who must both be openable.
            (SELECT jsonb_agg(DISTINCT jsonb_build_object(
                      'name', v2.driver_name, 'id', v2.driver_ext_id))
               FROM vehicle_driver_day v2
              WHERE v2.plate = o.plate
                AND v2.day = (o.started_at AT TIME ZONE 'Asia/Dubai')::date
                AND v2.driver_name IS NOT NULL) AS driver_refs,
            (SELECT string_agg(DISTINCT v.driver_name, ', ')
               FROM vehicle_driver_day v
              WHERE v.plate = o.plate
                AND v.day = (o.started_at AT TIME ZONE 'Asia/Dubai')::date
                AND v.driver_name IS NOT NULL) AS drivers
     FROM occupancy_segment o WHERE ${DAYWIN('o.started_at')} AND ($3='all' OR o.verdict=$3)
     ORDER BY o.started_at DESC LIMIT 300`, [from, to, verdict]));
}));

// Names the drivers who actually held the car on the days the flags occurred —
// "L44305 had two unexplained trips" is a fact about a person, not a plate.
app.get('/api/unauthorized/by-vehicle', wrap(async (req, res) => {
  const [from, to] = range(req);
  const rows = await q(
    `WITH seg AS (
       SELECT plate,
              count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
              count(*) FILTER (WHERE verdict='authorized')::int authorized,
              count(*) FILTER (WHERE verdict='sensor_suspect')::int sensor_suspect,
              round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,1) unauth_km
       FROM occupancy_segment WHERE ${DAYWIN('started_at')}
       GROUP BY plate HAVING count(*) FILTER (WHERE verdict='unauthorized') > 0),
     who AS (
       SELECT o.plate, string_agg(DISTINCT v.driver_name, ', ') AS drivers
       FROM occupancy_segment o
       JOIN vehicle_driver_day v
         ON v.plate = o.plate
        AND v.day = (o.started_at AT TIME ZONE 'Asia/Dubai')::date
       WHERE ${DAYWIN('o.started_at')} AND o.verdict='unauthorized'
         AND v.driver_name IS NOT NULL
       GROUP BY o.plate)
     SELECT seg.*, who.drivers
     FROM seg LEFT JOIN who USING (plate)
     ORDER BY seg.unauthorized DESC LIMIT 100`, [from, to]);
  /* How many vehicles are flagged in total. The page's "Vehicles involved" tile
     already prefers a measured figure; this is where it comes from, and without
     it the tile falls back to counting the hundred rows it received. */
  const [t] = await q(
    `SELECT count(DISTINCT plate)::int vehicles,
            count(*) FILTER (WHERE verdict='unauthorized')::int segments
     FROM occupancy_segment
     WHERE ${DAYWIN('started_at')} AND verdict='unauthorized'`, [from, to]);
  res.json({ rows, total: t?.vehicles ?? rows.length, segments: t?.segments ?? null,
    shown: rows.length, truncated: (t?.vehicles ?? 0) > rows.length });
}));

// daily trend of unauthorized vs authorized occupancy
app.get('/api/unauthorized/daily', wrap(async (req, res) => {
  const [from, to] = range(req);
  res.json(await q(
    /* Dubai-local, like every other daily grouping in this product. Bucketing
       by UTC day put segments between midnight and 04:00 on the previous day,
       while the drill that opened from a bar filtered by Dubai day — so a bar
       could open onto an empty list. */
    /* Every verdict, and every day.
       ─────────────────────────────────────────────────────────────────────
       Two things were wrong here and they compounded into a page that read as
       "we looked and there is nothing".

       The named buckets did not sum to the row's own total. `partial` — a
       segment whose telemetry has a hole, so it cannot be judged — was counted
       in none of them, and it is the LARGEST bucket: 68 of 136 over thirty
       days. A row saying 65 segments, 10 authorized, 9 needing a human left 46
       unaccounted for and unmentioned.

       And only days that HAVE a segment came back. Over a thirty-day window
       this returned three rows, because the reconciler has only produced
       segments for three days — which the chart then drew as the fleet's whole
       month. A day with no seat-occupancy data and a day where the sensor saw
       nobody are different facts, and the calendar is filled so the first can
       be drawn as a void rather than as zero. */
    `WITH cal AS (
       SELECT generate_series(
         greatest($1::date, $2::date - 400), $2::date, interval '1 day')::date AS d
     ),
     agg AS (
       SELECT (started_at AT TIME ZONE 'Asia/Dubai')::date AS d,
              count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
              count(*) FILTER (WHERE verdict='authorized')::int authorized,
              count(*) FILTER (WHERE verdict IN ('unverifiable','pending'))::int needs_a_human,
              count(*) FILTER (WHERE verdict='partial')::int partial,
              count(*) FILTER (WHERE verdict='stationary')::int stationary,
              count(*)::int segments
       FROM occupancy_segment WHERE ${DAYWIN('started_at')} GROUP BY 1
     )
     SELECT to_char(cal.d, 'YYYY-MM-DD') AS d,
            coalesce(agg.unauthorized, 0) unauthorized,
            coalesce(agg.authorized, 0) authorized,
            coalesce(agg.needs_a_human, 0) needs_a_human,
            coalesce(agg.partial, 0) partial,
            coalesce(agg.stationary, 0) stationary,
            coalesce(agg.segments, 0) segments,
            -- No segment at all is not "nobody sat in a car": it is a day the
            -- reconciler had nothing to judge, and must not be drawn as zero.
            (agg.d IS NULL) AS uncollected
     FROM cal LEFT JOIN agg ON agg.d = cal.d
     ORDER BY cal.d`, [from, to]));
}));

// sensor health per vehicle — dead/stuck pads make leakage numbers unreliable
/* Sensor health, ordered by how far a pad is from behaving plausibly.
   It used to sort ascending by occupied_fixes and the page showed the first
   twenty — so the list was the QUIETEST pads, and a stuck-on pad, which is the
   failure mode that manufactures false accusations, sorted to the very bottom
   and was cut off. The panel's own caption said "a dead or stuck pad makes the
   numbers above unreliable" while being structurally incapable of showing a
   stuck one.

   The suspect-segment count was also computed over all time, ignoring the
   page's window, and was 0 or NULL for every plate — so the client-side
   "suspect" verdict keyed on it could never fire. */
app.get('/api/sensor-health', wrap(async (req, res) => {
  const [from, to] = range(req);
  res.json(await q(
    `SELECT t.plate,
            count(*) FILTER (WHERE t.seat_occupied)::int occupied_fixes,
            count(*) FILTER (WHERE t.seat_occupied IS NULL)::int unreported_fixes,
            count(*)::int total_fixes,
            round(100.0 * count(*) FILTER (WHERE t.seat_occupied)
                  / nullif(count(*) FILTER (WHERE t.seat_occupied IS NOT NULL), 0), 1) occupied_pct,
            coalesce(max(o.suspect), 0)::int sensor_suspect_segments,
            -- Below this many observations a pad is not being judged at all: a
            -- verdict on two fixes is an accusation about hardware from noise.
            (count(*) FILTER (WHERE t.seat_occupied IS NOT NULL) >= 20) AS judgeable
     FROM telemetry_snapshot t
     LEFT JOIN (SELECT plate, count(*) FILTER (WHERE verdict='sensor_suspect') suspect
                FROM occupancy_segment
                WHERE ${DAYWIN('started_at')} GROUP BY plate) o ON o.plate = t.plate
     WHERE t.source='cabman' AND ${DAYWIN('t.captured_at')}
     GROUP BY t.plate
     -- Distance from a plausible occupancy band, so BOTH tails surface: a pad
     -- that never triggers and a pad that never releases are equally broken.
     ORDER BY abs(coalesce(count(*) FILTER (WHERE t.seat_occupied)::float
                           / nullif(count(*) FILTER (WHERE t.seat_occupied IS NOT NULL), 0), 0.35) - 0.35) DESC,
              total_fixes DESC
     LIMIT 100`, [from, to]));
}));

/* ───────────────────────── ops / meta ───────────────────────── */
app.get('/api/platforms', wrap(async (_, res) => res.json(await q(
  `SELECT platform, fleet_id, count(*)::int trips, min(requested_at) earliest, max(requested_at) latest
   FROM trip GROUP BY platform, fleet_id ORDER BY trips DESC`))));

/* The latest run per source and mode — including which of its windows failed.
   A run that wrote rows while most of its windows failed reported status='ok'
   for months while the Uber trip history had a 299-day hole in it. `status`
   now distinguishes them, and `failed_windows` names the dates, which is what
   makes a hole fixable rather than merely visible. */
app.get('/api/status', wrap(async (_, res) => res.json((await q(
  `SELECT DISTINCT ON (source, mode) source, mode, status, rows_written, window_start, window_end,
          finished_at, error, chunks_total, chunks_failed, detail
   FROM collection_run ORDER BY source, mode, finished_at DESC`)).map((r) => {
  const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
  return {
    ...r,
    detail: undefined,
    failed_windows: (detail || []).filter((c) => c.error)
      .map((c) => ({ from: c.from, to: c.to, error: c.error })),
    windows: (detail || []).map((c) => ({ from: c.from, to: c.to, rows: c.rows, ok: !c.error })),
  };
}))));

app.get('/api/coverage', wrap(async (_, res) => {
  const [trips, telemetry, alerts, ledger, earnings] = await Promise.all([
    q(`SELECT platform, count(*)::int n, min(requested_at) from_ts, max(requested_at) to_ts FROM trip GROUP BY 1`),
    q(`SELECT source, count(*)::int n, max(polled_at) last_poll FROM telemetry_snapshot GROUP BY 1`),
    q(`SELECT count(*)::int n, max(occurred_at) latest FROM alert`),
    q(`SELECT count(*)::int n, max(event_at) latest FROM ledger_entry`),
    /* Money coverage, beside trip coverage, because they are not the same span
       and the difference is the single largest hole in this product.

       Uber's earnings API serves roughly the last six months. The trip feed
       goes back a year — so there is half a year of bookings, distance and
       drivers with no money attached and none that can ever be collected. Every
       backfill asked for those windows, every window returned ok, and every one
       of them returned nothing: a silence indistinguishable from a quiet week
       unless it is stated. This states it. */
    q(`SELECT platform,
              count(*)::int n,
              min(day) from_day, max(day) to_day,
              count(DISTINCT day)::int days,
              round(sum(earnings)::numeric, 0) earnings
       FROM driver_payout_day WHERE earnings IS NOT NULL GROUP BY 1`),
  ]);
  /* Per platform: where the trip feed starts, where the money starts, and how
     much work sits before it. A page can then say "6,231 bookings we hold no
     money for" instead of drawing a flat line. */
  const byPlatform = new Map(earnings.map((e) => [e.platform, e]));
  /* One query for every platform's gap, not one query per platform in series.
     ─────────────────────────────────────────────────────────────────────────
     This loop awaited a count over the whole trip table once per platform, and
     each of those counts was written so it could not use an index: comparing
     `(requested_at AT TIME ZONE 'Asia/Dubai')::date` to a bound is a function
     of the column, so Postgres reads every row to evaluate it. Four platforms
     therefore meant four sequential full scans, and the endpoint took twenty
     seconds on a database doing nothing else — which is why the Data sources
     page answered the platform's gateway with a 504 during a backfill.

     Both halves are fixed: the bounds are pushed into one pass over the table,
     and the predicate compares the TIMESTAMP against a converted bound, which
     trip_platform_requested_idx can serve. The Dubai-day arithmetic is
     unchanged — midnight Dubai is the same instant either way round; only
     which side of the comparison is transformed has moved. */
  const wanted = trips
    .map((t) => {
      const e = byPlatform.get(t.platform);
      if (!e || !t.from_ts || !e.from_day) return null;
      const tripFrom = new Date(t.from_ts).toISOString().slice(0, 10);
      const payFrom = new Date(e.from_day).toISOString().slice(0, 10);
      return payFrom <= tripFrom ? null : { platform: t.platform, tripFrom, payFrom };
    })
    .filter(Boolean);
  let gaps = [];
  if (wanted.length) {
    const counts = await q(
      `SELECT t.platform, count(*)::int unpaid
         FROM trip t
         JOIN unnest($1::text[], $2::date[]) AS b(platform, before)
           ON b.platform = t.platform
        WHERE t.requested_at < (b.before::timestamp AT TIME ZONE 'Asia/Dubai')
        GROUP BY 1`,
      [wanted.map((w) => w.platform), wanted.map((w) => w.payFrom)]);
    const byPl = new Map(counts.map((c) => [c.platform, c.unpaid]));
    gaps = wanted.map((w) => ({
      platform: w.platform, trips_from: w.tripFrom, earnings_from: w.payFrom,
      bookings_before: byPl.get(w.platform) ?? 0,
    }));
  }
  res.json({ trips, telemetry, alerts, ledger, earnings, earnings_gaps: gaps });
}));

/* ───────────────────────── settings ───────────────────────── */
app.get('/api/settings', wrap(async (_, res) => res.json(await describeSettings())));

app.put('/api/settings', requireAdmin, wrap(async (req, res) => {
  const updates = req.body && typeof req.body === 'object' ? req.body : {};
  const done = [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === '') { await deleteSetting(k); done.push(`${k}:cleared`); }
    else { await setSetting(k, v); done.push(`${k}:set`); }
  }
  await loadSettings(true);
  res.json({ ok: true, updated: done });
}));

// trigger a collector run on demand (backfill/incremental) — the worker owns scheduling,
// this just records intent the worker picks up on its next tick.
/* Queue an on-demand collector run.
   This used to write a single source_state key, so requesting two things
   seconds apart discarded the first — while answering {ok: true} to the
   request it was about to throw away. A row per request, and a duplicate of
   something already pending is REFUSED rather than merged, because "queued"
   for a job that will never run is the same lie in a different shape. */
const JOB_MODES = ['backfill', 'incremental', 'analyst', 'probe'];
/* The fleets a run can be narrowed to. Taken from the configured Uber orgs
   rather than written down twice: a third fleet is a credential the operator
   pastes, not a code change, and a list that has to be edited alongside is a
   list that will not be. */
const FLEETS = [...new Set((config.uber.orgs || []).map((o) => o.fleet))];
/* Statement-day import — the operator's daily ledger, batched.
   ─────────────────────────────────────────────────────────────────────────
   The ledger is the only machine-readable source for months the provider APIs
   no longer serve (Uber earnings before 2026-02-09), and the only source at
   all for the statement/treasury view of the money — gross, commission, cash
   in hand, bank transfer — that the reconciliation showed a reader needs
   BESIDE the bank payout, not instead of it. Rows land in
   driver_statement_day (sql/schema_v25.sql), never in driver_performance:
   daily rows would win every day in the payout resolution and silently
   replace the bank figure with the statement figure.

   Batched because the body parser caps at 256kb; the importer sends ~400 rows
   per call. Each batch is one multi-row upsert. The final batch should carry
   done:true, which records the import as a collection run — that is what
   moves the data version and invalidates the response cache. */
app.post('/api/import/statement-days', requireAdmin, wrap(async (req, res) => {
  const { rows = [], source = 'ledger', done = false } = req.body || {};
  if (!Array.isArray(rows) || rows.length > 500) {
    return res.status(400).json({ error: 'rows must be an array of at most 500' });
  }
  const bad = [];
  const clean = [];
  const num = (v) => (v === '' || v == null ? null : Number(v));
  for (const [i, r] of rows.entries()) {
    const day = String(r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !r.driver || !r.platform || !r.company) {
      bad.push(i); continue;
    }
    clean.push([String(r.platform).toLowerCase(), String(r.company).toLowerCase(),
      String(r.driver).trim(), day, num(r.gross), num(r.fees), num(r.net), num(r.tips),
      num(r.salik), num(r.cash), num(r.bank), num(r.network_cash), num(r.unremitted),
      r.trips === '' || r.trips == null ? null : parseInt(r.trips, 10),
      source, Boolean(r.pseudo)]);
  }
  let written = 0;
  if (clean.length) {
    const vals = clean.map((_, i) => `($${i * 16 + 1},$${i * 16 + 2},$${i * 16 + 3},$${i * 16 + 4}::date,`
      + `$${i * 16 + 5},$${i * 16 + 6},$${i * 16 + 7},$${i * 16 + 8},$${i * 16 + 9},$${i * 16 + 10},`
      + `$${i * 16 + 11},$${i * 16 + 12},$${i * 16 + 13},$${i * 16 + 14},$${i * 16 + 15},$${i * 16 + 16})`).join(',');
    const r2 = await pool.query(
      `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, day, gross, fees, net,
         tips, salik, cash, bank, network_cash, unremitted, trips, source, pseudo)
       VALUES ${vals}
       ON CONFLICT (platform, fleet_id, name_key, day, source) DO UPDATE SET
         gross = EXCLUDED.gross, fees = EXCLUDED.fees, net = EXCLUDED.net,
         tips = EXCLUDED.tips, salik = EXCLUDED.salik, cash = EXCLUDED.cash,
         bank = EXCLUDED.bank, network_cash = EXCLUDED.network_cash,
         unremitted = EXCLUDED.unremitted, trips = EXCLUDED.trips,
         driver_name = EXCLUDED.driver_name, pseudo = EXCLUDED.pseudo,
         ingested_at = now()`, clean.flat());
    written = r2.rowCount ?? clean.length;
  }
  if (done) {
    await pool.query(
      `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at)
       SELECT $1, 'ecosine', 'import', 'ok', count(*), now() FROM driver_statement_day WHERE source = $1`,
      [source]);
  }
  res.json({ ok: true, written, rejected: bad.length, rejected_indexes: bad.slice(0, 10) });
}));

app.post('/api/settings/trigger', requireAdmin, wrap(async (req, res) => {
  const mode = JOB_MODES.includes(req.body?.mode) ? req.body.mode : 'incremental';
  /* One fleet, or both. Ecosine and Egari are separate businesses with
     separate credentials on the same providers, and they fail separately —
     so when a credential is replaced, the question is whether THAT fleet
     collects now. Asking it should not mean waiting out a full pass over the
     fleet that was already working. Absent means both, which is what every
     schedule asks for and what every job before this one meant. */
  const fleet = FLEETS.includes(req.body?.fleet) ? req.body.fleet : null;
  const [existing] = await q(
    `SELECT id, status, requested_at, fleet FROM collector_job
      WHERE mode = $1 AND fleet IS NOT DISTINCT FROM $2
        AND status IN ('queued', 'running') ORDER BY requested_at LIMIT 1`, [mode, fleet]);
  if (existing) {
    const scope = fleet ? `${mode} for ${fleet}` : mode;
    return res.status(409).json({
      ok: false, mode, fleet, already: existing.status, job_id: existing.id,
      requested_at: existing.requested_at,
      detail: `a ${scope} is already ${existing.status}; queuing another would do the same work twice`,
    });
  }
  const [job] = await q(
    `INSERT INTO collector_job (mode, fleet, requested_by) VALUES ($1, $2, $3)
     RETURNING id, mode, fleet, status, requested_at`,
    [mode, fleet, (req.get('x-admin-token') ? 'admin' : 'unauthenticated')]);
  res.json({ ok: true, queued: mode, fleet, job_id: job.id, job });
}));

/* What has been asked for, what is running, and what happened to it. A queue
   nobody can see is a queue nobody can trust. */
/* How fresh the precomputed answers are.
   Four pages read rollups rather than aggregating the whole history on every
   request. That is only an acceptable trade while the rollups are actually
   running: a stale number served instantly is worse than a slow one, because
   nothing about it looks wrong. This is what lets a page say when it was last
   computed — and what makes a rollup that has quietly stopped visible. */
app.get('/api/rollups', wrap(async (_req, res) => res.json(await rollupState())));

/* Whether the cache is doing anything. A cache nobody can see the hit rate of
   is a cache nobody can tell has silently stopped working — the symptom being
   pages that are merely slow again, which reads as the database having a bad
   day. Never cached itself, for the same reason /api/rollups is not. */
app.get('/api/cache-stats', wrap(async (_req, res) => res.json(cache.stats())));

app.get('/api/settings/jobs', wrap(async (_req, res) => {
  const jobs = await q(
    /* attempts and progress are both here for the same reason: a job that says
       'running' tells you nothing. attempts counts how many times a container
       restart requeued it — three means something about the job is killing the
       collector. progress names the source it is on right now, because a
       backfill runs eight sources in sequence and one of them takes four and a
       half hours, during which a working run and a wedged one look identical.
       elapsed lets a watcher say how long that has been true. */
    `SELECT id, mode, status, requested_by, requested_at, started_at, finished_at, error,
            coalesce(attempts, 0)::int AS attempts, progress,
            CASE WHEN finished_at IS NOT NULL AND started_at IS NOT NULL
                 THEN round(extract(epoch FROM finished_at - started_at))::int END AS seconds,
            CASE WHEN finished_at IS NULL AND started_at IS NOT NULL
                 THEN round(extract(epoch FROM now() - started_at))::int END AS running_seconds
     FROM collector_job ORDER BY requested_at DESC LIMIT 40`);
  res.json({
    jobs,
    pending: jobs.filter((j) => j.status === 'queued').length,
    running: jobs.filter((j) => j.status === 'running').length,
  });
}));

/* ───────────────────────── static dashboard ───────────────────────── */


/* ───────────────────────── actionable insights ───────────────────────── */
/* The ranked action list.
   Two problems compounded here. The table had accumulated forty-eight copies of
   every NULL-window finding per day (schema_v15 fixes the cause and purges the
   copies), and the ordering put impact_aed first — which only one rule sets, to
   a hardcoded constant — so all 200 slots were consumed by copies of that one
   rule before any other critical finding was reached. The category chips were
   then built from those same 200 rows, offering the operator two buttons.

   Deduplicated at read time as well, so a stale duplicate cannot resurface, and
   the response says how many rows the limit cut. */
const INSIGHT_LIMIT = 200;
app.get('/api/insights', wrap(async (req, res) => {
  const sev = req.query.severity || null;
  const cat = req.query.category || null;
  const rows = await q(
    `WITH latest AS (
       SELECT DISTINCT ON (code, entity_type, entity_id)
              code, severity, category, entity_type, entity_id, title, detail, action,
              impact_aed, metric, fleet_id, window_start, window_end, computed_at
       FROM insight
       WHERE ($1::text IS NULL OR severity=$1) AND ($2::text IS NULL OR category=$2)
       ORDER BY code, entity_type, entity_id, computed_at DESC
     )
     SELECT * FROM latest
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
              computed_at DESC, impact_aed DESC NULLS LAST
     LIMIT ${INSIGHT_LIMIT + 1}`, [sev, cat]);
  const truncated = rows.length > INSIGHT_LIMIT;
  res.json({ insights: rows.slice(0, INSIGHT_LIMIT), truncated, limit: INSIGHT_LIMIT });
}));

/* Counts over the DEDUPLICATED set, and the money kept apart from it.
   The "quantified cost" tile summed impact_aed across the whole table. Only one
   rule sets that field, and it sets it to a constant — fourteen days at an
   assumed AED 120 holding cost — so the headline was (number of runs) x (number
   of idle vehicles) x 1,680. It read AED 1,424,592.

   A modelled figure and a measured one do not belong in the same total, so the
   assumption is returned with it and the tile can say so. */
const IDLE_DAY_COST = Number(process.env.VEHICLE_DAY_COST_AED || 120);
app.get('/api/insights/summary', wrap(async (_, res) => {
  const base = `WITH latest AS (
      SELECT DISTINCT ON (code, entity_type, entity_id) *
      FROM insight ORDER BY code, entity_type, entity_id, computed_at DESC)`;
  const bySev = await q(`${base} SELECT severity, count(*)::int n FROM latest GROUP BY 1`);
  const byCat = await q(`${base} SELECT category, count(*)::int n FROM latest GROUP BY 1 ORDER BY 2 DESC`);
  const [tot] = await q(
    `${base}
     SELECT count(*)::int n,
            round(sum(impact_aed) FILTER (WHERE code <> 'idle_vehicle')::numeric, 0) AS measured_impact,
            round(sum(impact_aed) FILTER (WHERE code = 'idle_vehicle')::numeric, 0) AS modelled_impact,
            count(*) FILTER (WHERE code = 'idle_vehicle')::int AS idle_vehicles
     FROM latest`);
  const [raw] = await q(`SELECT count(*)::int n FROM insight`);
  res.json({
    total: tot, by_severity: bySev, by_category: byCat,
    modelled: {
      idle_vehicles: tot?.idle_vehicles ?? 0,
      aed: tot?.modelled_impact ?? null,
      assumption: `${IDLE_DAY_COST} AED per vehicle per day of holding cost, over a 14-day lookback`,
    },
    // Visible so a duplicate explosion cannot be silent again.
    stored_rows: raw?.n ?? 0,
    duplicates_suppressed: Math.max(0, (raw?.n ?? 0) - (tot?.n ?? 0)),
  });
}));

// monthly trend + automatic structural-break detection (what changed, and when)
app.get('/api/trend/monthly', wrap(async (req, res) => {
  /* Every trap trip_norm exists to resolve, all three of them live in this one
     query, on the page whose entire job is explaining why the numbers moved.
     With a full year of Uber finally collected they became visible at once:

       km  — sum(distance_km) with no has_distance guard. FMS distances are
             odometer-derived and one row can read 193,027 km. April 2026
             reported 12,681,536 km across 91 vehicles: 4,600 km per car per
             day, every day. The months that looked sane were exactly the
             months FMS was dark.

       trips — count(*) over bookings AND telematics twins of the same
             journeys, so a month with FMS running counts the same physical
             trip twice and a month without it does not. That alone produces a
             "structural break" on the date the telematics boxes came online.

       month — date_trunc on a UTC timestamp. The fleet works Dubai hours and
             its airport wave starts before dawn, so every trip between
             midnight and 04:00 landed in the previous month at the boundary.

     Bookings and telematics are counted separately and never summed, distance
     is guarded, and the month is the Dubai-local one. */
  /* Read from rollup_month rather than recomputing. This grouped every trip
     ever collected, by month, with no window — there is nothing in a request
     that can narrow it and no index that helps, so it cost 13.6 seconds and
     cost it identically for every viewer on every load. The answer changes
     only when the collector writes, so src/rollup.js computes it there.

     The rollup carries the same guarded measures because it is built over
     trip_norm, which is where the three traps above are resolved — it does not
     restate them and cannot drift from them.

     '*' is the stored "every platform" row, computed at that grain rather than
     summed from the per-platform ones: a driver on Uber and Yango is one human
     and summing would report two. */
  const SHAPE = `month AS m, bookings AS trips, telematics AS telematics_journeys,
            drivers, attributed_trips, vehicles, earning_vehicles,
            round(km, 0) AS km, measured_trips,
            round(revenue, 0) AS revenue, priced_trips,
            round(100.0 * not_completed / nullif(outcome_n, 0), 1) AS cancel_pct`;
  let observed = await q(
    `SELECT ${SHAPE}, platforms, booking_platforms
     FROM rollup_month
     WHERE platform = coalesce($1, '*') AND fleet_id = '*'
     ORDER BY month`, [req.query.platform || null]);

  /* Before the first rollup has run — a fresh database, a deploy that lands
     ahead of a collection, a rollup that failed — the table is empty and this
     page would show nothing at all, which is a worse failure than being slow.
     So it falls back to computing the grain, using the SAME SQL the rollup is
     built from rather than a second copy that would drift from it. Slow, and
     only until the next quarter hour. */
  const fromRollup = observed.length > 0;
  if (!observed.length) {
    observed = await q(
      `SELECT ${SHAPE}, NULL::text[] AS platforms, NULL::text[] AS booking_platforms
       FROM (${rollupGrainSql('month')}) g
       WHERE platform = coalesce($1, '*') AND fleet_id = '*'
       ORDER BY month`, [req.query.platform || null]);
  }
  // Said in the response rather than only in a log: a reader deserves to know
  // whether the figures were precomputed or derived on the spot.
  const trendSource = fromRollup ? 'rollup' : 'live';
  /* Months that exist only in the imported ledger — the pre-API history the
     import exists to recover — have no trip rows, so the calendar cannot be
     built from trips alone. The statement months extend it. */
  const stmtSpan = await q(
    `SELECT to_char(min(day), 'YYYY-MM') a, to_char(max(day), 'YYYY-MM') b
     FROM driver_statement_day WHERE source <> 'ledger' AND ($1::text IS NULL OR platform = $1)`,
    [req.query.platform || null]);
  if (!observed.length && !stmtSpan[0]?.a) {
    return res.json({ months: [], breaks: [], gaps: [], source: trendSource });
  }

  /* A month with no rows is ambiguous: the fleet may have stood still, or we
     may simply hold no data for it. Treating the two the same produced a
     headline "-82%, drivers 102 → 0" for a stretch where nothing had been
     collected at all. Fill the calendar so the gap is visible as a gap. */
  const key = (d) => new Date(d).toISOString().slice(0, 7);
  const byMonth = new Map(observed.map((r) => [key(r.m), r]));
  const bounds = [...(observed.length ? [key(observed[0].m), key(observed[observed.length - 1].m)] : []),
    ...(stmtSpan[0]?.a ? [stmtSpan[0].a, stmtSpan[0].b] : [])].sort();
  const first = new Date(bounds[0]), last = new Date(bounds[bounds.length - 1]);
  /* The first and last months of any record are partial by construction: the
     data starts and ends mid-month. Collection here begins on 21 August, so
     that month holds eleven days and September reads as +344% against it —
     which is a fact about when we started collecting, not about the fleet. Any
     comparison that averages the ends of the record is dragged by them, so
     they are flagged and the analyses that average can exclude them.

     Marked from the RECORD's span, never from trip density: a month with
     genuinely quiet days is a quiet month, and excluding it would hide exactly
     the thing worth seeing. */
  const [span = {}] = await q(
    `SELECT to_char(min(local_day),'YYYY-MM-DD') a, to_char(max(local_day),'YYYY-MM-DD') b
     FROM trip_norm WHERE ($1::text IS NULL OR platform=$1)`, [req.query.platform || null]);
  const spanFrom = span.a || null, spanTo = span.b || null;
  const lastOf = (ym) => {
    const [y, mo] = ym.split('-').map(Number);
    return `${ym}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
  };
  const dayDiff = (a2, b2) => Math.round((Date.parse(b2) - Date.parse(a2)) / 864e5) + 1;

  /* Money, per month, both channels — the trend line on the page whose job is
     explaining why the numbers moved was the fares alone, so it plotted the
     hotel channel and called it revenue. Uber prices nothing per trip and pays
     weekly, so for most of this record the line was near zero while the fleet
     was working.

     Per platform per month, using the same rule as every other page
     (api/income_sql.js): a payout is what is left of a channel's own fares
     after commission, so a channel reporting both contributes one of them. The
     per-platform rollup rows carry the fares; driver_payout_day carries the
     payouts, resolved for the overlapping report windows. */
  /* From the rollup when there is one, and from the same grain SQL the rollup
     is built from when there is not — exactly as `observed` above does, and for
     the same reason. Reading rollup_month unconditionally here meant that on a
     fresh database every month reported its payouts and none of its fares,
     because the fallback covered one of the two queries. */
  const platMonthSql = fromRollup
    ? `SELECT to_char(month, 'YYYY-MM') AS m, platform, bookings, priced_trips, revenue
       FROM rollup_month
       WHERE fleet_id = '*' AND platform <> '*'
         AND ($1::text IS NULL OR platform = $1)`
    : `SELECT to_char(month, 'YYYY-MM') AS m, platform, bookings, priced_trips, revenue
       FROM (${rollupGrainSql('month')}) g
       WHERE fleet_id = '*' AND platform <> '*'
         AND ($1::text IS NULL OR platform = $1)`;
  const [platMonths, payMonths, stmtMonths] = await Promise.all([
    q(platMonthSql, [req.query.platform || null]),
    q(`SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS m, platform,
              round(sum(earnings)::numeric, 2) AS payouts,
              count(DISTINCT day)::int AS payout_days
       FROM driver_payout_day
       WHERE ($1::text IS NULL OR platform = $1)
       GROUP BY 1, 2`, [req.query.platform || null]),
    /* The statement view per month — the operator's ledger. Rides beside the
       payout, never inside it; see api/income_sql.js. */
    q(`SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS m, platform,
              round(sum(net)::numeric, 2) AS statement_net,
              round(sum(cash)::numeric, 2) AS statement_cash,
              round(sum(bank)::numeric, 2) AS statement_bank
       FROM driver_statement_day
       WHERE source <> 'ledger' AND ($1::text IS NULL OR platform = $1)
       GROUP BY 1, 2`, [req.query.platform || null]),
  ]);
  const incomeByMonth = new Map();
  {
    const acc = new Map();
    const cell = (m, pl) => {
      if (!acc.has(m)) acc.set(m, new Map());
      const inner = acc.get(m);
      if (!inner.has(pl)) {
        inner.set(pl, { platform: pl, bookings: 0, priced_bookings: 0,
          fares: null, payouts: null, payout_days: 0 });
      }
      return inner.get(pl);
    };
    for (const r of platMonths) Object.assign(cell(r.m, r.platform), {
      bookings: r.bookings, priced_bookings: r.priced_trips,
      fares: r.revenue == null ? null : Number(r.revenue) });
    for (const r of payMonths) Object.assign(cell(r.m, r.platform), {
      payouts: r.payouts == null ? null : Number(r.payouts),
      payout_days: r.payout_days ?? 0 });
    for (const r of stmtMonths) Object.assign(cell(r.m, r.platform), {
      statement_net: r.statement_net == null ? null : Number(r.statement_net),
      statement_cash: r.statement_cash == null ? null : Number(r.statement_cash),
      statement_bank: r.statement_bank == null ? null : Number(r.statement_bank) });
    for (const [m, inner] of acc) {
      const [y, mo] = m.split('-').map(Number);
      const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      incomeByMonth.set(m, fleetIncome([...inner.values()], daysInMonth));
    }
  }

  const months = [];
  for (const d = new Date(first); d <= last; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const k = key(d);
    const row = byMonth.get(k);
    const inc = incomeByMonth.get(k) || {};
    const partial = !!row && ((spanFrom && spanFrom > `${k}-01`) || (spanTo && spanTo < lastOf(k)));
    months.push(row
      ? { ...row, m: k, no_data: false,
          // True where the record itself starts or ends inside this month, so
          // the month holds fewer days than it appears to.
          partial_month: partial,
          days_in_record: partial
            ? Math.max(1, dayDiff(spanFrom > `${k}-01` ? spanFrom : `${k}-01`,
              spanTo < lastOf(k) ? spanTo : lastOf(k)))
            : null,
          ...inc,
          /* A month with work and no statement is not a month the fleet earned
             nothing. Uber's earnings API serves roughly the last six months, so
             every month before that has bookings, distance and drivers, and no
             money that can ever be collected for it. Said here, once, so no page
             has to infer it from a null. */
          income_missing: !!(row.trips > 0 && inc.accounted_payouts == null
            && (row.priced_trips || 0) < row.trips),
          // FMS-derived trips carry no driver id, so "0 drivers" on a month
          // that has trips means unattributable, not idle.
          drivers_known: row.attributed_trips > 0 }
      : { m: k, trips: 0, telematics_journeys: 0, drivers: null, vehicles: 0,
          earning_vehicles: 0, km: null, measured_trips: 0, revenue: null, priced_trips: 0,
          cancel_pct: null, platforms: [], booking_platforms: [],
          accounted: null, accounted_fares: null, accounted_payouts: null,
          accounted_platforms: [], income_missing: false,
          /* The income spread comes AFTER the nulls: a month with no collected
             trips can still hold imported statement money — the pre-API ledger
             months are exactly that — and dropping it here made the history
             the import exists to recover invisible on the one chart that
             shows history. */
          ...inc,
          no_data: true, drivers_known: false, partial_month: false, days_in_record: null });
  }

  // Month-over-month breaks, computed only between months we actually observed.
  const breaks = [];
  for (let i = 1; i < months.length; i++) {
    const a = months[i - 1], b = months[i];
    if (a.no_data || b.no_data || !a.trips) continue;   // never step across a hole
    const d = (b.trips - a.trips) / a.trips;
    if (Math.abs(d) < 0.3) continue;
    breaks.push({
      from: a.m, to: b.m, change_pct: Math.round(d * 100),
      /* A move into or out of a month the record only partly covers is not a
         business event. Collection here starts on 21 August, so August holds
         eleven days and September reads as +344% against it. Reported rather
         than dropped — a break that silently disappears is its own kind of
         lie — but flagged so nothing downstream treats it as a thing that
         happened. */
      boundary_artifact: !!(a.partial_month || b.partial_month),
      partial_side: a.partial_month ? a.m : b.partial_month ? b.m : null,
      trips_from: a.trips, trips_to: b.trips,
      drivers_from: a.drivers_known ? a.drivers : null,
      drivers_to: b.drivers_known ? b.drivers : null,
      /* A swing that coincides with a platform appearing or disappearing is a
         change in what we collect, not necessarily in what the fleet did.
         Compared over BOOKING platforms only: `trips` no longer counts
         telematics journeys, so a telematics feed coming online cannot move
         this number and flagging it as the explanation would be wrong. It is
         still reported separately below. */
      platform_shift: JSON.stringify([...(a.booking_platforms || [])].sort())
        !== JSON.stringify([...(b.booking_platforms || [])].sort())
        ? { from: a.booking_platforms, to: b.booking_platforms } : null,
      // The supply side of the same swing. A fleet that kept its vehicles and
      // lost its drivers is a different problem from one that lost both.
      vehicles_from: a.earning_vehicles, vehicles_to: b.earning_vehicles,
      km_per_trip_from: a.measured_trips ? +(a.km / a.measured_trips).toFixed(1) : null,
      km_per_trip_to: b.measured_trips ? +(b.km / b.measured_trips).toFixed(1) : null,
    });
  }

  // Contiguous runs of missing months, reported so the UI can draw them.
  const gaps = [];
  let run = null;
  for (const mth of months) {
    if (mth.no_data) { run = run || { from: mth.m, to: mth.m, months: 0 }; run.to = mth.m; run.months++; }
    else if (run) { gaps.push(run); run = null; }
  }
  if (run) gaps.push(run);

  res.json({ months, breaks, gaps, source: trendSource });
}));

// external context joined to the day (weather + calendar) for causality overlays
app.get('/api/context', wrap(async (req, res) => {
  const [from, to] = winDays(req);
  res.json(await q(
    `SELECT w.day, w.temp_max, w.precipitation, w.wind_max, w.is_forecast,
            c.hijri_month, c.is_ramadan, c.is_holiday, c.holiday_name
     FROM weather_daily w LEFT JOIN calendar_day c USING (day)
     WHERE w.day BETWEEN $1 AND $2 ORDER BY w.day`, [from, to]));
}));



/* ────────────────── compliance & platform verdicts ────────────────── */
/* The counts come from the database, not from the returned list.
   The page built "Vehicle docs expired — cannot legally work" by filtering the
   array it had just fetched, which is capped at 300 rows ordered by expiry.
   Every document past its date sorts to the front, so today the two numbers
   agree — and the day the fleet crosses 300 documents on file they stop
   agreeing, silently, on a tile that makes a legal claim. A total is a count,
   not a length. */
app.get('/api/compliance/vehicles', wrap(async (req, res) => {
  const rows = await q(
    `SELECT d.plate, d.doc_type, d.status, d.expires_at,
            (d.expires_at::date - now()::date) AS days_left,
            p.make, p.model, p.year, p.vin, p.image_url,
            -- Whoever holds the car NOW, which is the right person for a
            -- document expiring next week — with the id, so the name can be a
            -- link rather than a name somebody has to go and look up.
            cd.driver_name, cd.driver_ext_id, cd.as_of AS driver_as_of
     FROM vehicle_document d
     LEFT JOIN vehicle_profile p ON p.platform=d.platform AND p.vehicle_ext_id=d.vehicle_ext_id
     LEFT JOIN vehicle_current_driver cd ON cd.plate = d.plate
     WHERE d.expires_at IS NOT NULL
     ORDER BY d.expires_at ASC LIMIT 300`);
  const [t] = await q(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE expires_at::date < now()::date)::int expired,
            count(*) FILTER (WHERE expires_at::date >= now()::date
                               AND expires_at::date <= now()::date + 7)::int within_7,
            count(*) FILTER (WHERE expires_at::date > now()::date + 7
                               AND expires_at::date <= now()::date + 45)::int within_45,
            count(DISTINCT plate)::int vehicles,
            count(DISTINCT doc_type)::int doc_types
     FROM vehicle_document WHERE expires_at IS NOT NULL`);
  const types = await q(
    `SELECT doc_type, count(*)::int n FROM vehicle_document
     WHERE expires_at IS NOT NULL AND doc_type IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  res.json({ rows, totals: t, doc_types: types,
    shown: rows.length, truncated: (t?.total ?? 0) > rows.length });
}));

/* Driver licences, with the placeholder check the insight engine already does.
   The page counted every row with a past expiry date and captioned it "stand
   down until renewed" — 77 of them. Every one carried the SAME date and the
   SAME licence number, because the source system fills an unset field with a
   default. licenceRisk() in src/insights.js detects exactly that pattern and
   refuses to accuse anybody; this page had no equivalent guard, so the two
   halves of the product disagreed about whether 77 people could legally drive.

   A repeated date is a data-quality problem, not a compliance one, and it is
   returned as such. */
app.get('/api/compliance/drivers', wrap(async (_, res) => {
  const rows = await q(
    `SELECT platform, c.driver_ext_id, full_name, phone, licence_no, licence_expires,
            (licence_expires - now()::date) AS days_left, state, suspension_reason, rating,
            -- A licence expiring in six days is a CAR that stops earning in six
            -- days. The row named the person and left the asset to be worked
            -- out by hand, which is the difference between a list and a plan.
            ${vehicleLatest('c.driver_ext_id')} AS vehicle
     FROM driver_compliance c ORDER BY licence_expires ASC NULLS LAST LIMIT 300`);
  const [mode] = await q(
    /* to_char, not the raw date. node-postgres hands a DATE back as a JS Date,
       and String(thatDate).slice(0, 10) is "Thu Jan 01" — which then fails to
       match the row's own value and reads as a weekday to a human. This is the
       third place in this codebase the same slice has been wrong. */
    `SELECT to_char(licence_expires, 'YYYY-MM-DD') AS licence_expires, count(*)::int n,
            (SELECT count(*)::int FROM driver_compliance WHERE licence_expires IS NOT NULL) AS with_date,
            count(DISTINCT licence_no)::int distinct_numbers
     FROM driver_compliance WHERE licence_expires IS NOT NULL
     GROUP BY licence_expires ORDER BY n DESC LIMIT 1`);
  // One date on more than half the rows is a default, not a coincidence.
  const share = mode && mode.with_date ? mode.n / mode.with_date : 0;
  const placeholder = share >= 0.5 && mode.n >= 5;
  /* Counted in the database, excluding the placeholder date, rather than by
     filtering the 300 rows the page happened to receive. "Driver licences
     expired — stand down until renewed" is the single most consequential
     sentence this product prints, and it was a .filter().length over a capped
     list. */
  const [t] = await q(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE licence_expires IS NOT NULL)::int with_date,
            count(*) FILTER (WHERE licence_expires IS NOT NULL
                               AND ($1::text IS NULL OR to_char(licence_expires,'YYYY-MM-DD') <> $1)
                               AND licence_expires < now()::date)::int expired,
            count(*) FILTER (WHERE licence_expires IS NOT NULL
                               AND ($1::text IS NULL OR to_char(licence_expires,'YYYY-MM-DD') <> $1)
                               AND licence_expires >= now()::date
                               AND licence_expires <= now()::date + 45)::int within_45,
            count(*) FILTER (WHERE licence_expires IS NULL)::int no_date_at_all
     FROM driver_compliance`, [placeholder ? mode.licence_expires : null]);
  res.json({
    drivers: rows,
    totals: t,
    shown: rows.length,
    truncated: (t?.total ?? 0) > rows.length,
    placeholder_date: placeholder ? mode.licence_expires : null,
    placeholder_rows: placeholder ? mode.n : 0,
    rows_with_a_date: mode?.with_date ?? 0,
    caveat: placeholder
      ? `${mode.n} of ${mode.with_date} licence dates are the identical value `
        + `${mode.licence_expires}, which is what this source writes when the field `
        + 'was never filled in. They are a data-quality problem, not expired licences, and are counted '
        + 'separately below rather than as people who must stand down.'
      : null,
  });
}));

/* The CURRENT target per platform and type, not the most recent thirty rows.
   Providers republish a recommendation every period, so a flat list ordered by
   period_end is a mixture of platforms at different depths of history — and the
   page prints "N of M targets are not being met" over it. With four platforms
   and three types republished monthly, thirty rows is under a year: M was the
   cap, the share it implies was wrong, and the same platform could appear
   several times with contradicting verdicts.

   DISTINCT ON gives exactly one row per (platform, type) — the live one — so
   the list IS the population and the sentence over it cannot be truncated.
   History is still in the table for anyone who wants it; this endpoint answers
   "what are we being asked for now". */
app.get('/api/recommendations', wrap(async (_, res) => {
  const rows = await q(
    `SELECT DISTINCT ON (platform, rec_type)
            platform, rec_type, period_start, period_end, org_value, target_value,
            flagged_count, flagged, updated_at
     FROM platform_recommendation
     ORDER BY platform, rec_type, period_end DESC NULLS LAST`);
  const [n] = await q('SELECT count(*)::int history FROM platform_recommendation');
  res.json({ rows, shown: rows.length, truncated: false, history: n?.history ?? rows.length });
}));

// earnings components — tips are the interesting one; they never appear in the trip feed
app.get('/api/earnings/components', wrap(async (req, res) => res.json(await q(
  `SELECT driver_ext_id, driver_name, category, parent,
          round(sum(amount)::numeric,2) amount, currency
   FROM driver_earnings_component
   WHERE period_start >= $1 AND period_end <= $2
   GROUP BY 1,2,3,4,6 ORDER BY abs(sum(amount)) DESC LIMIT 400`,
  winDays(req)))));

// per-driver tip rate — service quality expressed in money
app.get('/api/earnings/tips', wrap(async (req, res) => res.json(await q(
  `SELECT driver_ext_id, max(driver_name) driver_name,
          round(sum(amount) FILTER (WHERE category='tip')::numeric,2) tips,
          round(sum(amount) FILTER (WHERE category='net_fare')::numeric,2) fare,
          round((sum(amount) FILTER (WHERE category='tip')
                 / nullif(sum(amount) FILTER (WHERE category='net_fare'),0) * 100)::numeric,2) tip_pct
   FROM driver_earnings_component
   WHERE period_start >= $1 AND period_end <= $2
   GROUP BY driver_ext_id HAVING sum(amount) FILTER (WHERE category='net_fare') > 0
   ORDER BY tip_pct DESC NULLS LAST LIMIT 200`,
  winDays(req)))));

// product-tier economics: which assets serve which tier
/* Custody resolved once per plate, not once per row.
   ─────────────────────────────────────────────────────────────────────────
   "This car does 80% Economy" is a finding about how a vehicle is dispatched,
   and the row named only the car — so each row carries the people who held it.
   Both of those came from correlated subqueries in the select list, which
   means they ran once per output ROW: up to six hundred rows, twice, each one
   grouping vehicle_driver_day again. At a ninety-day window that stopped
   being slow and started being a 500, because the statement hit the pool's
   timeout and the page showed nothing at all.

   The same answer in one pass: aggregate the trips, take the six hundred rows
   the page will show, and resolve custody for exactly those plates once. The
   window function ranks each plate's people so the top three can be selected
   without a second grouping, and the distinct count is taken over all of them
   rather than the three — the original counted every driver, not the ones it
   listed. */
app.get('/api/product/by-vehicle', wrap(async (req, res) => res.json(await q(
  `WITH agg AS (
     SELECT t.plate, t.product, count(*)::int trips,
            round(sum(t.distance_km)::numeric,0) km,
            round(avg(t.distance_km)::numeric,1) avg_km
       FROM trip_norm t
      WHERE ${F} AND t.plate IS NOT NULL AND t.product IS NOT NULL
      GROUP BY t.plate, t.product
      ORDER BY t.plate, trips DESC
      LIMIT 600),
   held AS (
     SELECT v.plate, v.driver_name, v.driver_ext_id, count(DISTINCT v.day)::int days
       FROM vehicle_driver_day v
      WHERE v.plate IN (SELECT plate FROM agg)
        AND v.day BETWEEN $1::date AND $2::date
        AND v.driver_name IS NOT NULL
      GROUP BY v.plate, v.driver_name, v.driver_ext_id),
   ranked AS (
     SELECT h.*, row_number() OVER (PARTITION BY h.plate
                                    ORDER BY h.days DESC, h.driver_name) rn
       FROM held h),
   per_plate AS (
     SELECT r.plate,
            jsonb_agg(jsonb_build_object('name', r.driver_name, 'id', r.driver_ext_id,
                                         'days', r.days)
                      ORDER BY r.days DESC, r.driver_name)
              FILTER (WHERE r.rn <= 3) AS driver_refs,
            count(DISTINCT r.driver_ext_id)::int AS driver_n
       FROM ranked r GROUP BY r.plate)
   SELECT a.plate, a.product, a.trips, a.km, a.avg_km,
          p.driver_refs, coalesce(p.driver_n, 0) AS driver_n
     FROM agg a LEFT JOIN per_plate p ON p.plate = a.plate
    ORDER BY a.plate, a.trips DESC`, range(req)))));

/* ───────────────── world events + causal attribution ───────────────── */
// "What was happening when the numbers moved" — candidates, not proof.
app.get('/api/breaks', wrap(async (req, res) => {
  res.json(await q(
    `SELECT metric, grain, platform, fleet_id, period_from, period_to,
            value_from, value_to, change_pct, drivers_from, drivers_to,
            driver_change_pct, productivity_change_pct, attribution, candidate_events, detected_at
     FROM metric_break
     WHERE ($1::text IS NULL OR platform=$1)
     ORDER BY period_to DESC`, [req.query.platform || null]));
}));

app.get('/api/events', wrap(async (req, res) => {
  const [from, to] = [...win(req)];
  res.json(await q(
    `SELECT source, code, title, category, scope, starts_on, ends_on,
            expected_effect, confidence, url, summary
     FROM world_event
     WHERE starts_on <= $2 AND coalesce(ends_on, starts_on) >= $1
     ORDER BY starts_on DESC LIMIT 300`, [from, to]));
}));

// operator-added context — the people who run the fleet know things the APIs never will
app.post('/api/events', requireAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.starts_on) return res.status(400).json({ error: 'title and starts_on required' });
  await q(
    `INSERT INTO world_event (source,code,title,category,scope,starts_on,ends_on,expected_effect,confidence,summary)
     VALUES ('manual',$1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (source,code,starts_on,title) DO UPDATE SET summary=EXCLUDED.summary, ends_on=EXCLUDED.ends_on`,
    [b.code || null, b.title, b.category || 'local', b.scope || 'dubai', b.starts_on,
     b.ends_on || b.starts_on, b.expected_effect || 'unknown', b.confidence ?? 0.5, b.summary || null]);
  res.json({ ok: true });
}));

/* ───────────────── what the sources actually carry ─────────────────
   Every collector stores the provider's original record in `raw`. That is the
   only honest answer to "what else does this API give us" — the mapped columns
   are what we chose to keep, not what arrived. This reports the keys present
   in `raw`, how often they are filled, and a few example values, so a field
   worth promoting to a real column can be found rather than guessed at. */
/* Which column names the provider, per table.
   telemetry_snapshot calls it `source`; every other table calls it `platform`.
   Both raw-field endpoints hardcoded `platform`, so the raw explorer — whose
   entire purpose is answering "what else could we be collecting" — returned a
   500 for the telemetry table. That is the table carrying the seat-sensor
   feed the whole unauthorized-trips analysis rests on, and CABMAN sends a
   SeatSensorStatus field we do not store; the one tool that would have shown
   it was the one that could not open that table.

   A null entry means the table has no provider column at all and the filter
   becomes a no-op rather than a syntax error. */
const PROVIDER_COL = { trip: 'platform', alert: 'platform', telemetry_snapshot: 'source',
  driver_performance: 'platform', vehicle_profile: 'platform' };
const providerFilter = (table, n) => (PROVIDER_COL[table]
  ? `($${n}::text IS NULL OR ${PROVIDER_COL[table]} = $${n})`
  : `($${n}::text IS NULL OR TRUE)`);

app.get('/api/schema/raw-fields', wrap(async (req, res) => {
  const table = ['trip', 'alert', 'telemetry_snapshot', 'driver_performance', 'vehicle_profile']
    .includes(req.query.table) ? req.query.table : 'trip';
  const platform = req.query.platform || null;
  const sample = Math.min(Math.max(+req.query.sample || 4000, 100), 20000);
  const [from, to] = [...win(req)];

  // A field a provider only started sending recently is diluted to nothing by a
  // year-wide random sample, so the window has to be selectable.
  const tcol = { trip: 'requested_at', alert: 'occurred_at', telemetry_snapshot: 'captured_at',
    driver_performance: 'period_start', vehicle_profile: 'updated_at' }[table];
  const rows = await q(
    `WITH s AS (
       SELECT raw FROM ${table}
       WHERE raw IS NOT NULL AND ${providerFilter(table, 1)}
         AND ${tcol} BETWEEN $2 AND $3
       ORDER BY random() LIMIT ${sample}
     ),
     kv AS (SELECT key, value FROM s, jsonb_each(s.raw))
     SELECT key,
            count(*)::int present,
            count(*) FILTER (WHERE value NOT IN ('null'::jsonb, '""'::jsonb))::int filled,
            count(DISTINCT value)::int distinct_values,
            (array_agg(DISTINCT left(value #>> '{}', 60))
               FILTER (WHERE value NOT IN ('null'::jsonb, '""'::jsonb)))[1:5] examples
     FROM kv GROUP BY key ORDER BY filled DESC, key`, [platform, from, to]);

  const [{ n } = { n: 0 }] = await q(
    `SELECT count(*)::int n FROM ${table}
     WHERE raw IS NOT NULL AND ${providerFilter(table, 1)} AND ${tcol} BETWEEN $2 AND $3`,
    [platform, from, to]);

  // Which of these are already promoted to a real column, so the interesting
  // list is the rest.
  const cols = (await q(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]))
    .map((c) => c.column_name);
  const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapped = new Set(cols.map(norm));

  res.json({
    table, platform, rows_with_raw: n, sampled: Math.min(sample, n),
    fields: rows.map((r) => ({
      key: r.key,
      fill_pct: r.present ? Math.round((r.filled / r.present) * 100) : 0,
      distinct_values: r.distinct_values,
      examples: r.examples || [],
      // A loose match: "Trip request time" against requested_at will not hit,
      // which is fine — a false "unmapped" costs a glance, a false "mapped"
      // hides a field.
      already_a_column: mapped.has(norm(r.key)),
    })),
  });
}));

// Distinct values of one raw field, with counts — for deciding whether a field
// is a dimension worth charting or free text.
app.get('/api/schema/raw-values', wrap(async (req, res) => {
  const table = ['trip', 'alert', 'telemetry_snapshot', 'driver_performance', 'vehicle_profile']
    .includes(req.query.table) ? req.query.table : 'trip';
  if (!req.query.key) return res.status(400).json({ error: 'key required' });
  const tcol = { trip: 'requested_at', alert: 'occurred_at', telemetry_snapshot: 'captured_at',
    driver_performance: 'period_start', vehicle_profile: 'updated_at' }[table];
  res.json(await q(
    `SELECT raw ->> $2 AS value, count(*)::int n
     FROM ${table}
     WHERE raw ? $2 AND ${providerFilter(table, 1)} AND ${tcol} BETWEEN $3 AND $4
     GROUP BY 1 ORDER BY n DESC LIMIT 60`,
    [req.query.platform || null, req.query.key,
     ...win(req)]));
}));

/* ───────────────── per-driver detail pages ───────────────── */
// Registered before the catch-all, like every other /api route.
driverRoutes(app, { q, wrap, endOfDay });

/* ───────────────── per-vehicle detail pages ───────────────── */
vehicleRoutes(app, { q, wrap, endOfDay });

/* ───────────────── commercial analytics ─────────────────
   Settlement, the corporate channel, product tiers, coverage holes and
   corridors — all built on trip_ext, all registered before the catch-all. */
analyticsRoutes(app, { q, wrap, range, F, FB });

/* ───────────────── the analyst ─────────────────
   Read-only. A generation pass costs a model call and runs from the collector
   schedule, not from a page load. */
analystRoutes(app, { q, wrap, range });

/* ───────────────── the roster ─────────────────
   Four providers' idea of a driver's standing, held together and joined
   against what that person actually drove. */
rosterRoutes(app, { q, wrap, range });

/* ───────────────── one day ─────────────────
   Every source that saw a given Dubai-local day, including whether each one
   was collecting at all. */
dayRoutes(app, { q, wrap });

/* Occupancy segments as pages rather than a modal: the list with its own
   facets, and one interval with every booking that stood near it. */
segmentRoutes(app, { q, wrap, range, DAYWIN });

/* One weekday-hour cell of the demand heatmap, as a rostering question rather
   than a colour: who covers it, on what, from where, and how reliably. */
slotRoutes(app, { q, wrap, range });

/* How much work is coming, and what to do this week to get more of it. Kept
   apart because they answer different questions at different certainties: the
   forecast is a projection with an interval; the playbook is a list of things
   a person can go and do, each carrying the arithmetic that sized it. */
forecastRoutes(app, { q, wrap, DAYWIN });
playbookRoutes(app, { q, wrap, range, DAYWIN });

/* Whether a falling driver count is people leaving or nobody arriving. The
   headcount cannot tell those apart and they need opposite remedies. */
retentionRoutes(app, { q, wrap });

/* Where next month's forecast work lands against who currently covers it —
   the join between the forecast and the rota. */
capacityRoutes(app, { q, wrap });
revenueRoutes(app, { q, wrap, range });

/* The month-by-month check that the platform's numbers add up: bank payout
   against on-trip net + tips + salik − cash, the identity the July 2026
   ledger reconciliation proved to 0.7%. */
reconcileRoutes(app, { q, wrap, rollupGrainSql });

/* ───────────────── live provider probes ─────────────────
   Read-only, allowlisted, shape-only. The question these answer — "does this
   provider expose something we are not collecting?" — cannot be settled from
   the columns we happen to have chosen. */
probeRoutes(app, { wrap });

/* An /api path that matches nothing is a 404, not the dashboard.
   The catch-all below serves index.html for anything unrouted, which is right
   for #vehicle/L40965 and wrong for /api/rollups: an undeclared or misspelled
   API path came back 200 with a page of HTML, and the client's r.json() failed
   with "Unexpected token <" — an error that says nothing about the actual
   mistake. This is also how a deploy that has not yet landed looks exactly like
   a deploy that has, which cost real time to see through.

   Before the static handler, so it cannot be shadowed by a file that happens to
   sit at the same path. */
app.use('/api', (req, res) => res.status(404).json({
  error: 'no such endpoint',
  path: req.originalUrl.split('?')[0],
}));

/* Static dashboard LAST: app.get('*') would otherwise shadow any API route
   registered after it (this silently broke /api/insights once already).

   Cached the way the assets actually behave, which is not one rule:

     - /vendor is a pinned copy of Leaflet. It changes when somebody deliberately
       vendors a new version and never otherwise, so it is immutable for a year.
       It was being re-fetched every five minutes like everything else, and it
       is the largest single asset the dashboard loads.

     - app.js and app.css change on every deploy, so they cannot be immutable
       without a content hash and a build step. stale-while-revalidate gets most
       of the benefit without either: the browser paints from its copy
       immediately and checks for a new one behind, so a returning reader waits
       for no round trip and still picks up a deploy within one page load.

     - index.html is the thing that names the others. It revalidates every time,
       because serving a stale document is how a deploy fails to arrive at all. */
const YEAR = 31536000;
/* /vendor is a pinned copy of Leaflet and /fonts are woff2 subsets, both of
   which change only when somebody deliberately vendors different ones. They are
   content rather than code: nothing about a deploy alters them, so they are
   immutable for a year instead of re-fetched every five minutes. */
for (const dir of ['vendor', 'fonts']) {
  app.use(`/${dir}`, express.static(join(__dir, 'public', dir), {
    maxAge: YEAR * 1000, immutable: true,
  }));
}
app.use(express.static(join(__dir, 'public'), {
  etag: true,
  setHeaders(res, path) {
    res.setHeader('Cache-Control', path.endsWith('index.html')
      ? 'public, max-age=0, must-revalidate'
      : 'public, max-age=300, stale-while-revalidate=604800');
  },
}));
app.get('*', (_, res) => {
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.sendFile(join(__dir, 'public', 'index.html'));
});

const port = process.env.PORT || 8080;
/* Listen first; serve data only once the schema is current. The 503 gate above
   holds every data route until migrate() resolves, so the failure this order
   used to invite — a half-built schema behind a green check — cannot recur,
   while the failure the old order caused (a busy database reading as a failed
   deploy) cannot either. A migration that REJECTS still exits: better a dead
   process the platform replaces than a live one lying about its schema. */
const server = app.listen(port, () => log.info('api', `listening on :${port} (migrations pending)`));
migrate()
  .then(() => {
    migrationsDone = true;
    log.info('api', 'migrations complete — serving');
    /* The payout table is filled by the worker's rollup pass. On the deploy
       that transitions it from a view — and on any fresh database — it is
       empty until that pass runs, which is up to a quarter hour of every money
       figure reading zero. Fill it here once, in the background, if the data
       exists and the table does not reflect it; the advisory lock inside
       refreshRollups makes racing the worker harmless. */
    q(`SELECT (SELECT count(*) FROM driver_payout_day) = 0
           AND EXISTS (SELECT 1 FROM driver_performance) AS empty`)
      .then(([r]) => (r?.empty ? refreshRollups() : null))
      .catch((e) => log.warn('api', 'payout boot-fill skipped', { err: String(e).slice(0, 120) }));
    /* Warm the cache in the background as soon as the data moves, so the first
       reader after a collection is not the one who pays for the aggregate.
       See api/warm.js. WARM=off to leave it cold. */
    // The cache needs the real port too, to re-request a stale key on itself.
    cache.setPort(server.address().port);
    // The API's own view, so the Settings page can show both and name the
    // difference rather than presenting one process's environment as the truth.
    recordCredentialVisibility('api')
      .catch((e) => log.warn('api', 'credential visibility', { err: String(e).slice(0, 120) }));
    startWarmer({
      // From the listening socket, not the configured value: with PORT=0 the
      // real one only exists once the server is up, and warming the wrong port
      // fails silently and looks like a cache that never fills.
      port: server.address().port,
      pool,
      enabled: String(process.env.WARM || '').toLowerCase() !== 'off'
        && String(process.env.CACHE || '').toLowerCase() !== 'off',
    });
  })
  .catch((e) => { log.error('api', 'migrate failed — refusing to serve', { err: String(e) }); process.exit(1); });
