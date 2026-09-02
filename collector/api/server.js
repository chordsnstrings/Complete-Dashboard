// Read/settings API + static dashboard host.
import express from 'express';
import compression from 'compression';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, migrate } from '../src/db.js';
import { config } from '../src/config.js';
import { describeSettings, setSetting, deleteSetting, loadSettings, recordCredentialVisibility } from '../src/settings.js';
import { recognise, unrecognised } from '../src/credkit.js';
import { checkAll } from '../src/credcheck.js';
import { proposeKeys } from '../src/credmodel.js';
import { SETTING_DEFS } from '../src/settings.js';
import { win, winDays, grainOf, previousWindow, foldGrain, GRAINS, PERIODS,
  isPeriod, periodPartial } from './window.js';
import { rollupGrainSql, rollupState, refreshRollups } from '../src/rollup.js';
import { responseCache } from './cache.js';
import { platformFares, platformPayouts, platformStatements, fleetIncome } from './income_sql.js';
import { startWarmer } from './warm.js';
import { log } from '../src/log.js';
/* The operator ledger's own module. The import route below is the only thing
   that writes this source, and until now it recorded the run inline — a
   count(*) over the whole table under a hard-coded fleet. src/sources/ledger.js
   holds what a ledger run means; see its header. */
import { recordImport, spanOf, tallyBatch, takeTally,
  CADENCE as LEDGER_CADENCE, silence as ledgerSilence } from '../src/sources/ledger.js';
import { economicsRoutes } from './economics_routes.js';
import { driverRoutes } from './driver_routes.js';
import { vehicleRoutes } from './vehicle_routes.js';
import { cohortRoutes } from './cohort_routes.js';
import { analyticsRoutes, analystRoutes } from './analytics_routes.js';
import { rosterRoutes } from './roster_routes.js';
import { dayRoutes } from './day_routes.js';
import { segmentRoutes, slotRoutes } from './segment_routes.js';
import { forecastRoutes } from './forecast_routes.js';
import { playbookRoutes } from './playbook_routes.js';
import { retentionRoutes } from './retention_routes.js';
import { tripRoutes } from './trip_routes.js';
import { authRoutes } from './auth_routes.js';
import { exportRoutes } from './export_routes.js';
import { supplyRoutes } from './supply_routes.js';
import { capacityRoutes } from './capacity_routes.js';
import { revenueRoutes } from './revenue_routes.js';
import { reconcileRoutes } from './reconcile_routes.js';
import { performerRoutes } from './performer_routes.js';
import { compareRoutes } from './compare_routes.js';
import { probeRoutes } from './probe.js';
import { adminGate, isAdmin, redactSettings } from './admin_gate.js';
import { BOOKING_CHANNELS, channelHealthSql, channelHealth } from './channels_sql.js';
import { RAW_ALIASES } from '../src/probe.js';

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

/* A slow query is the most common reason a panel renders as a skeleton, and
   until now nothing on the server said WHICH one. bin/render-audit.mjs can see
   that #reconcile did not fill inside its settle window; it cannot see that
   one of the four statements behind it cost ten seconds while the other three
   cost forty milliseconds, and neither could anyone reading the logs. The
   answer took a deploy per guess.

   So a statement slower than SLOW_QUERY_MS says so, once, with its own opening
   line — enough to identify it in the file it came from. The threshold is
   deliberately well above a normal page: this is for finding the panel that
   times out, not for narrating the working ones. */
const SLOW_MS = Number(process.env.SLOW_QUERY_MS || 2500);
const q = async (text, params) => {
  const t0 = Date.now();
  try {
    return (await pool.query(text, params)).rows;
  } finally {
    const ms = Date.now() - t0;
    if (ms >= SLOW_MS) log.warn('api', 'slow query', { ms, sql: String(text).replace(/\s+/g, ' ').trim().slice(0, 150) });
  }
};
/* A 500 body used to carry the driver's own message, which names the storage
   engine, the column and the type ("invalid input syntax for type timestamp
   with time zone"). The full error is logged; the caller gets a reference to
   quote. The real fix for this class of bug is test/route_smoke.test.mjs,
   which executes every route rather than grepping for it. */
import { custodyOverWindow, custodyCountOverWindow, vehicleLatest, peopleCount, peopleCountStored, JOIN_TRIP, personFold } from './custody_sql.js';
import { spanGaps } from './coverage_gaps.js';
/* The one place the alerts-per-distance rule lives. Every page that prints a
   safety rate reads it from here, so the fleet headline and the per-vehicle
   and per-driver tables cannot disagree about which days they measured. */
import { alertCoverage, alertRate, alertRateReason } from './alert_coverage_sql.js';
import { makeWrap } from './wrap.js';
/* Moved to api/wrap.js so the late-failure branch can be exercised by a test
   rather than reasoned about — see the comment there. */
const wrap = makeWrap({ log });

// Writes (credential changes) require ADMIN_TOKEN via the x-admin-token header,
// and an API with no ADMIN_TOKEN refuses every write rather than running open.
// See api/admin_gate.js for why, and for the deploy ordering that fix demands.
const requireAdmin = adminGate({ warn: (m) => log.warn('api', m) });

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

/* When a tracker counts as reporting.
   ─────────────────────────────────────────────────────────────────────────
   Written once because it was about to be written twice: /api/live measured
   staleness on the FIX and /api/kpis measured it on the POLL, and two
   endpoints disagreeing about which vehicles are live is worse than either
   being slightly wrong.

   Thirty minutes, and the number is measured rather than reasoned. Eleven was
   the first answer — two missed cycles of a five-minute poll — and it was
   argued from the poll interval instead of from what the fixes actually do.
   Against the live fleet it counted 13 vehicles of 130 as reporting, while 58
   had fixes inside a quarter of an hour and 85 inside half of one: these
   trackers routinely answer eleven to fifteen minutes behind, so the tight
   threshold called forty-five working vehicles dead.

   Half an hour is six poll cycles. It is comfortably past the cadence the
   fleet actually reports at and nowhere near the dormant trackers, which are
   silent for days — twenty-five of them are, and they are counted separately
   because "has stopped reporting" is a different fact from "is late". */
const FIX_FRESH = "interval '30 minutes'";


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

/* Two ways to get a date out of a row, and which one you need depends on what
   the column IS. Both of them, because getting this wrong is silent.
   ─────────────────────────────────────────────────────────────────────────
   node-postgres parses a DATE into a Date at LOCAL midnight and a TIMESTAMPTZ
   into a Date at the instant, and neither of those survives
   `.toISOString().slice(0, 10)`:

   • A DATE. Measured with the parser production actually runs
     (`types.getTypeParser(1082)` from pg-types, which src/db.js's `pg` pulls
     in) under TZ=Asia/Dubai: '2026-02-06' becomes `Fri Feb 06 2026 00:00:00
     GMT+0400`, and .toISOString().slice(0, 10) is "2026-02-05" — the day
     before. '2026-03-01' .slice(0, 7) is "2026-02" — the month before. The
     local components ARE the date the column holds, whatever zone the process
     runs in, so read those. Production has been right about this only by
     accident: its container is UTC, which is visible in the responses —
     /api/coverage returns from_day "2026-02-06T00:00:00.000Z", exact midnight
     Z, the signature of a DATE parsed in a UTC process. One `TZ=` in the app
     spec moves every one of these by a day.

   • An INSTANT (TIMESTAMPTZ, or any real clock). Here toISOString() converts
     correctly and gives the UTC day — which is the wrong QUESTION. The fleet
     works Asia/Dubai and every other day figure in this product is
     `AT TIME ZONE 'Asia/Dubai'`, so between 20:00 and midnight Dubai the UTC
     day is yesterday's. Measured on production 2026-09-02: /api/coverage said
     the Uber trip feed starts 2025-04-04 (from the instant 23:12:38Z) while
     /api/performer/weeks, reading trip_norm.local_day, said the first booking
     is 2025-04-05. One trip, two endpoints, two different days.

   Local twins rather than imports, and NOT because of a cycle: test/mount.mjs
   mounts this file by slicing the source between the section markers and
   evaluating it with `new Function`, so a name bound by an import at the top
   of the module is simply not in scope inside the slice. Measured — importing
   isoDay and calling it in /api/trend/monthly made the route answer
   `500 {"error":"internal","detail":"ReferenceError: isoDay is not defined"}`
   in the harness while production was fine, which is the worst of both. These
   sit INSIDE the slice, where both readers can see them.
   test/server_day_keys.test.mjs pins them to the exported originals —
   isoDay in src/sources/ledger.js, dubaiIso in src/util.js — so the copies
   cannot drift from what they are copies of. */
const isoDay = (v) => {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const p = (n) => String(n).padStart(2, '0');
  return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
};
// Dubai is UTC+4 all year and has observed no daylight saving since 1990, so
// the shift is a constant and cannot disagree with Postgres's AT TIME ZONE.
const dubaiIso = (d = new Date()) =>
  new Date(new Date(d).getTime() + 4 * 3600e3).toISOString().slice(0, 10);

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

       /* Who and what — over the BOOKINGS, because that is what the figures
          beside them count.
          ─────────────────────────────────────────────────────────────────
          These two counted every trip row, telematics included, and were then
          printed under a bookings headline: "12,668 bookings — 119 drivers ·
          102 vehicles". The Vehicles page said 97 vehicles took a booking and
          the Drivers page said 118 people drove, and both were right. The
          gap is the five cars and the one person the trackers saw move with
          no channel reporting a job for them — a real and interesting fact,
          and not one that belongs inside a booking count.

          So the headline pair is booking-scoped, and what the trackers saw
          beyond it is returned beside them rather than folded into them. */
       ${peopleCountStored()} FILTER (WHERE n.is_booking)::int drivers,
       ${peopleCountStored()}::int drivers_seen,
       count(*) FILTER (WHERE n.driver_ext_id IS NOT NULL)::int attributed_trips,
       count(DISTINCT n.plate) FILTER (WHERE n.is_booking
         AND n.plate IS NOT NULL AND n.plate <> '')::int vehicles,
       count(DISTINCT n.plate) FILTER (WHERE n.plate IS NOT NULL AND n.plate <> '')::int vehicles_seen,
       /* Bookings with no vehicle recorded against them. They appear on no
          vehicle page and in no per-vehicle total, so the vehicle directory
          sums to fifteen fewer trips than the fleet does — a difference that
          previously had no home and read as one of the two numbers being
          wrong. Reported, so the two reconcile. */
       count(*) FILTER (WHERE n.is_booking AND coalesce(btrim(n.plate), '') = '')::int trips_without_vehicle,
       count(DISTINCT n.platform) FILTER (WHERE n.is_booking)::int platforms
     FROM trip_norm n ${JOIN_TRIP} WHERE ${W('n')}`, p);

  /* How many vehicles are actually reporting, measured on the FIX rather than
     on the poll.
     ─────────────────────────────────────────────────────────────────────────
     Both figures here were about us, not about the fleet. live_vehicles counted
     every plate telemetry has ever held, so a tracker that stopped in April
     2024 was still "live" two years later — four of them are, and sixteen have
     been silent over a month. And `fresh` tested polled_at, the moment WE asked,
     which a dormant vehicle satisfies forever: the provider keeps listing it,
     we keep upserting the same ancient fix with a new poll time, and it reads
     as current on every page carrying the number.

     captured_at is when the tracker says it saw the vehicle, which is the only
     column that can answer the question. Fifteen minutes rather than eleven
     because the CABMAN poll is five-minutely and its fixes routinely arrive a
     couple of cycles behind; reporting is what is being measured, not
     punctuality. The silent count is returned beside them so a page can say
     which vehicles have gone quiet instead of quietly dropping them. */
  const [v] = await q(`SELECT
        count(*) FILTER (WHERE now() - captured_at < ${FIX_FRESH})::int live_vehicles,
        count(*) FILTER (WHERE now() - captured_at < ${FIX_FRESH})::int fresh,
        count(*) FILTER (WHERE now() - captured_at >= interval '1 day')::int silent_vehicles,
        count(*)::int tracked_vehicles
      FROM (SELECT DISTINCT ON (plate) plate, captured_at
              FROM telemetry_snapshot ORDER BY plate, captured_at DESC) s`);
  /* Alerts, and the distance they are allowed to be divided by.
     ─────────────────────────────────────────────────────────────────────────
     Alerts take the same fleet filter as the trips beside them; without it a
     single-fleet view showed one fleet's trips next to both fleets' alerts.

     The rate is measured over the days the ALERT FEED covered, and no others.
     Measured here on 2026-09-02 before that rule existed: days=16 and days=30
     returned the identical 69,338 alerts while km rose from 99,538 to 166,923,
     so the fleet's headline safety figure halved from 69.7 to 41.5 per 100 km
     — and at days=90 it doubled back to 93.1. The feed had a 73-day hole
     (2026-06-06 → 2026-08-17) and days 17–30 back from today sat inside it,
     contributing distance and no alerts. api/alert_coverage_sql.js carries the
     rule and the assumption it rests on; `alert_coverage` below states both on
     the response so a page can say which days the number is about. */
  const cov = await alertCoverage(q, p[0], p[1], { fleet: p[3] });
  const [a] = await q(
    `SELECT count(*)::int alerts FROM alert
     WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date = ANY($1::date[])
       AND ($2::text IS NULL OR fleet_id = $2)`, [cov.days, p[3]]);
  /* The denominator, narrowed to the same days. The BETWEEN in W('n') is
     redundant beside the day set and is kept for the same reason the alert
     join carries one: a day array is not a range the planner can use to narrow
     trip_norm, and the bounded predicate beside it is. */
  const [ak] = await q(
    `SELECT round(sum(n.distance_km)
              FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) alert_km,
            count(*) FILTER (WHERE n.is_booking)::int alert_window_trips
     FROM trip_norm n ${JOIN_TRIP}
     WHERE ${W('n')} AND n.local_day = ANY($5::date[])`, [...p, cov.days]);

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
    ...t, ...v, ...a, ...ak,
    /* The safety headline, computed here rather than left for a page to divide
       `alerts` by `km` — which is how it came to be wrong: those two columns
       describe different sets of days whenever the feed has a hole, and every
       reader who divided them got 41.5 for a fleet running at 69.7.

       Null, never 0, when the feed covered nothing: a window with no feed has
       no safety rate, and a zero reads as a perfect one. */
    alerts_per_100km: alertRate(a.alerts, ak.alert_km, cov),
    alerts_per_100km_absent: alertRateReason(ak.alert_km, cov),
    alert_coverage: cov,
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
    /* The window the answer is FOR, echoed back.
       ─────────────────────────────────────────────────────────────────────
       A caller asking `?period=month` gets month-to-date, and until this was
       returned there was nothing in the response to say so — a figure labelled
       August that is really 1–29 August is the same class of mistake as a
       thirty-day figure labelled "this month". `days` is the span actually
       measured, `period` is what was asked for when a period was named, and
       `partial` says the period is still running. */
    window: { from: p[0], to: p[1], days: windowDays,
      period: isPeriod(req.query.period) ? String(req.query.period) : null,
      grain: grainOf(req),
      /* Still running, so the figure is period-to-date — decided in
         api/window.js, where the span's own end is known before it is capped
         to today. It used to be a list of five relative names, so
         `period=2026-08` came back claiming to be a whole month on the 30th. */
      partial: periodPartial(req.query.period) },
  });
}));

/* ── this period against the one before it ────────────────────────────────
   A period view is only worth having if it compares. "August: 12,347" is a
   number; "12,347, up 21% on the same span of July" is a finding, and the
   difference is one query.

   The comparison span is the same NUMBER OF DAYS immediately before the
   window, never the whole previous period: on the 12th of the month, August
   month-to-date against the WHOLE of July would report a 60% collapse that is
   entirely the calendar. That mistake is easy to make, invisible once made,
   and it is the reason this endpoint exists rather than the two windows being
   fetched separately and divided in a page.

   Everything is summed from driver_day, which since schema_v41 carries the
   money beside the work — so trips and revenue come from ONE row per driver
   per day and cannot disagree about which days they cover. */
app.get('/api/compare/period', wrap(async (req, res) => {
  const [from, to, platform, fleet] = range(req);
  const [pFrom, pTo] = previousWindow([from, to]);

  /* PEOPLE, not platform accounts. driver_day is keyed on driver_ext_id, and
     one human holds several of those — counting distinct ids reported more
     drivers than the fleet employs, which reads as growth. person_key is the
     stored fold (sql/schema_v41.sql), so this is a count and not a join. */
  /* Who DROVE, and who was merely PAID, counted apart.
     ─────────────────────────────────────────────────────────────────────
     driver_day carries a row for every driver-day any source knows about,
     including days where a payout landed and no trip did — a payout period
     usually covers work from before the window. Counting every row's person
     answered 258 for a month in which 119 people actually drove, which reads
     as a fleet twice its size.

     So `drivers` is people with work in the window, matching what /api/kpis
     answers for the same window, and the people who only appear through money
     are counted beside it rather than folded in or dropped. */
  const PERSON = 'coalesce(person_key, driver_ext_id)';
  const SUMS = `count(DISTINCT ${PERSON}) FILTER (WHERE trips > 0)::int AS drivers,
                count(DISTINCT driver_ext_id) FILTER (WHERE trips > 0)::int AS driver_accounts,
                count(DISTINCT ${PERSON}) FILTER (WHERE trips = 0 AND money IS NOT NULL)::int
                  AS paid_not_driving,
                coalesce(sum(trips), 0)::int        AS trips,
                coalesce(sum(completed), 0)::int    AS completed,
                coalesce(sum(cancelled), 0)::int    AS cancelled,
                round(sum(km)::numeric, 0)          AS km,
                round(sum(money)::numeric, 2)       AS money,
                round(sum(stmt_net)::numeric, 2)    AS stmt_net,
                round(sum(fares)::numeric, 2)       AS fares,
                round(sum(stmt_tips)::numeric, 2)   AS tips,
                round(sum(stmt_cash)::numeric, 2)   AS cash,
                round(sum(payout)::numeric, 2)      AS payout,
                coalesce(sum(online_min), 0)::int   AS online_min,
                coalesce(sum(on_job_min), 0)::int   AS on_job_min,
                count(*) FILTER (WHERE money IS NOT NULL)::int AS money_days,
                count(*)::int                       AS driver_days`;
  /* driver_day carries no platform column — a day is one row per PERSON, and a
     person works several platforms in it. So a platform filter cannot be
     answered from this table without splitting the day, which would defeat the
     point of having one row. Asked for a platform, the endpoint says so rather
     than quietly answering for the whole fleet. */
  if (platform) {
    return res.status(400).json({
      error: 'this comparison is per driver-day, and a driver-day spans platforms',
      hint: 'drop ?platform= — /api/kpis answers a platform-filtered window',
    });
  }
  const span = async (a, b) => (await q(
    `SELECT ${SUMS} FROM driver_day
      WHERE day BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR fleet_id = $3)`, [a, b, fleet]))[0];

  const [now, before] = await Promise.all([span(from, to), span(pFrom, pTo)]);
  /* A change is only reportable when BOTH sides carry the measure. Against a
     zero or a null it is not "+100%", it is "there is nothing to compare
     against", and printing infinity as a percentage is how a page claims a
     collector outage was growth. */
  const delta = (k) => {
    const a = Number(now?.[k]), b = Number(before?.[k]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return Math.round(((a - b) / b) * 1000) / 10;
  };
  const KEYS = ['drivers', 'trips', 'completed', 'cancelled', 'km', 'money', 'stmt_net',
    'fares', 'tips', 'cash', 'payout', 'online_min', 'on_job_min'];
  res.json({
    window: { from, to, grain: grainOf(req),
      period: isPeriod(req.query.period) ? String(req.query.period) : null },
    previous: { from: pFrom, to: pTo },
    now, before,
    change_pct: Object.fromEntries(KEYS.map((k) => [k, delta(k)])),
    basis: 'Summed from driver_day — one row per driver per day carrying both the work and the '
      + 'money — so every measure here covers exactly the same days. The comparison span is the '
      + 'same number of days immediately before the window, not the whole previous calendar '
      + 'period, so a month-to-date is compared against the same slice of the month before it. '
      + '`drivers` counts PEOPLE who drove, folded across their platform accounts; '
      + '`paid_not_driving` counts people who appear only through money, which a payout period '
      + 'reaching back before the window will produce.',
  });
}));

/* ── every trip, fleet-wide ───────────────────────────────────────────────
   The record existed and was not browsable. Trips could be reached only
   THROUGH something else — a driver's page, a vehicle's page, a single day —
   or downloaded as a CSV nobody opens to answer a question. There was no
   "show me the work" in a product whose whole subject is the work.

   One row per booking, newest first, with the channel it came from on the row
   rather than inferred from a filter chip. Paged rather than capped: an
   operator scrolling for the trip they remember needs to reach it, and a
   thirty-day window is twelve thousand rows.

   `is_booking` is the population, as everywhere else here: an FMS telematics
   row is the same physical car moving and adding it would double every trip
   it shadows. The telematics view is its own filter rather than a silent
   inclusion. */
app.get('/api/trips/list', wrap(async (req, res) => {
  const p = range(req);
  const limit = Math.min(Math.max(+req.query.limit || 100, 1), 500);
  const offset = Math.max(0, +req.query.offset || 0);

  /* What a reader actually searches by: a plate, a person, or a place. One
     box, matched against all four, because asking which field they mean is a
     question the product can answer itself. */
  const term = String(req.query.q || '').trim().toLowerCase();
  const search = term
    ? `AND (lower(plate) LIKE $5 OR lower(driver_name) LIKE $5
            OR lower(pickup_addr) LIKE $5 OR lower(dropoff_addr) LIKE $5
            OR lower(external_id) LIKE $5)` : '';
  const args = term ? [...p, `%${term}%`] : p;

  /* Telematics is a different population and gets asked for explicitly. */
  const kind = req.query.kind === 'telematics' ? 'NOT is_booking'
    : req.query.kind === 'all' ? 'TRUE' : 'is_booking';
  const outcome = ['completed', 'not_completed'].includes(req.query.outcome)
    ? `AND outcome = '${req.query.outcome}'` : '';

  const where = `${F} AND ${kind} ${outcome} ${search}`;
  const [rows, [t]] = await Promise.all([
    q(`SELECT platform, fleet_id, external_id, requested_at, ended_at, local_day,
              driver_name, driver_ext_id, plate, pickup_addr, dropoff_addr,
              distance_km, duration_s, status, outcome, product, payment_type,
              price, currency, has_fare, is_booking
         FROM trip_norm WHERE ${where}
        ORDER BY requested_at DESC
        LIMIT ${limit} OFFSET ${offset}`, args),
    q(`SELECT count(*)::int n FROM trip_norm WHERE ${where}`, args),
  ]);
  const total = t?.n ?? rows.length;
  res.json({
    rows, total, shown: rows.length, offset, limit,
    truncated: offset + rows.length < total,
    window: { from: p[0], to: p[1] },
    /* The fare column is empty for most of this fleet and the reason is not
       the fleet's: Uber publishes no per-trip price. Said here so a page
       rendering a column of dashes can explain itself. */
    priced: rows.filter((r) => r.has_fare).length,
    note: 'One row per booking. A price appears only where the channel publishes one — the Uber '
      + 'trip export carries no fare column at all, so most rows here show none and that is the '
      + 'provider, not a gap in collection.',
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

     One measure genuinely changed, and for the better: the rollup counts
     distinct PEOPLE, folding a person's several platform accounts into one,
     where the hand-written fallback this replaced counted distinct
     driver_name. Every other page in the product counts people, so the
     overview chart and the monthly trend could report different driver counts
     for the same day. They now agree, on both paths. */
  /* Today is computed live; the finished days come from the rollup.
     ─────────────────────────────────────────────────────────────────────────
     The rollup is rebuilt after each collection run, so between runs its row
     for TODAY is a few minutes behind trip_norm — and /api/kpis, /api/platforms
     and the trip list all read trip_norm directly. Live, that showed as the
     overview's chart summing to 12,667 bookings under a headline of 12,668:
     one trip that had landed since the last refresh. A one-trip gap is small
     and the damage is not, because a reader who finds the pages disagreeing by
     one stops trusting them by thousands.

     Only the current day can move, so only the current day is recomputed —
     one day of aggregation, against a rollup that still carries the other
     three hundred and sixty-four. Both halves are the SAME SQL the rollup is
     built from, so the fast half and the live half cannot answer differently.

     `to` in the past means the live half matches nothing and costs nothing. */
  const TODAY = "(now() AT TIME ZONE 'Asia/Dubai')::date";
  /* Served at the precision it is stored at, not rounded again here. A page
     that sums thirty daily buckets was summing thirty roundings: the overview
     said 157,709 km and its own chart said 157,712, which is a rounding
     artefact wearing the clothes of a disagreement. Rounding is a display
     decision and the front end already makes it. */
  const pick = (src) => `SELECT g.day AS d, g.bookings AS trips, g.completed,
              g.not_completed AS cancelled, g.telematics AS telematics_journeys,
              g.km, g.revenue, g.priced_trips, g.drivers
         FROM (${src}) g
        WHERE g.day BETWEEN $1::date AND $2::date
          AND g.platform = coalesce($3, '*') AND g.fleet_id = coalesce($4, '*')`;
  const live = pick(rollupGrainSql('day', `AND n.local_day >= ${TODAY}`));
  const rollupReady = (await q(
    `SELECT 1 FROM rollup_day
      WHERE day BETWEEN $1::date AND $2::date
        AND platform = coalesce($3, '*') AND fleet_id = coalesce($4, '*') LIMIT 1`, p)).length > 0;
  const aggSql = rollupReady
    ? `SELECT day AS d, bookings AS trips, completed, not_completed AS cancelled,
              telematics AS telematics_journeys, km, revenue, priced_trips, drivers
         FROM rollup_day
        WHERE day BETWEEN $1::date AND $2::date AND day < ${TODAY}
          AND platform = coalesce($3, '*') AND fleet_id = coalesce($4, '*')
       UNION ALL ${live}`
    /* No rollup yet — a fresh database, or a deploy landing before the first
       collection. The whole window is computed from that same definition
       rather than from a second copy of these aggregates living here, which is
       how a fast path and a slow path quietly stop agreeing. */
    : pick(rollupGrainSql('day', 'AND n.local_day BETWEEN $1::date AND $2::date'));

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
    /* Anchored at TODAY, not at the window's raw upper bound.
       ─────────────────────────────────────────────────────────────────────
       An open window is [2000-01-01, 2100-01-01] — api/window.js — and the
       cap subtracted its 800 days from THAT end, so the calendar generated
       ran 2097-10-23 to 2100-01-01. Every real row fell outside it, the LEFT
       JOIN matched nothing, and all-time answered with 28 empty month buckets
       dated seventy-one years from now.

       Measured on production before the fix: from=2000-01-01&to=2100-01-01
       returned 28 buckets, first 2097-10, last 2100-01, 0 trips and 0 with
       revenue — over a fleet holding 312,762 bookings. The identical query
       bounded at today returned 2024-06 to 2026-09 and all 312,762. Same
       tables, same lower bound; only the calendar's upper anchor differed.

       Today, and not the last day WITH DATA: the trailing empty days of a
       window are how a collector that stopped three days ago becomes visible,
       and clamping to the record was an earlier attempt that hid exactly
       that. Today is always at or after the last day with data, so both
       properties hold at once. */
    `WITH cal AS (
       SELECT generate_series(
         greatest($1::date, least($2::date, ${TODAY}) - ${DAILY_MAX_DAYS}),
         least($2::date, ${TODAY}), interval '1 day')::date AS d
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
  /* Bucketed at the END, not by grouping the query differently.
     ─────────────────────────────────────────────────────────────────────────
     The rows above are a COMPLETE calendar: every day in the window, with the
     collector-silence facts that separate "nobody drove" from "nobody
     collected". Re-grouping the SQL at a week or month grain would either
     throw that away or need a second copy of it, and the two copies would
     answer differently the first time one was edited.

     Folding the finished days instead means a week is the sum of its own seven
     rows by construction, so the three grains cannot disagree — which is the
     property a reader is implicitly relying on when they switch the control
     and expect the total to hold. */
  res.json(foldGrain(rows, grainOf(req)));
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
            /* The rank the caption promises. This table sits under "Top
               drivers" with a completion rate beside every row and was ordered
               by TOTAL bookings, so rank 1 had 271 trips at 84% — 228
               completed — above rank 2's 257 at 89%, which is 229. The list
               was correct about a number it was not sorted by. */
            count(*) FILTER (WHERE n.outcome='completed')::int completed_trips,
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
       FROM people ORDER BY completed_trips DESC, trips DESC LIMIT 100`, p);
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
            /* nullif(btrim(...), '') and not IS NOT NULL.
               ─────────────────────────────────────────────────────────────
               The trip table stores a missing plate as the empty STRING as
               well as as NULL, and only the NULL half was being filtered.
               Measured over a year: 47 of these 150 people carried '' in
               their plate list. array_agg(DISTINCT) sorts ascending so ''
               sorts FIRST and always took one of the three [1:3] slots — the
               "three cars they drove" was two cars and a blank — while
               plate_n counted the blank as a vehicle and mode() could return
               it as the car they mostly drive. */
            (array_agg(DISTINCT nullif(btrim(n.plate), ''))
              FILTER (WHERE nullif(btrim(n.plate), '') IS NOT NULL))[1:3] AS plates,
            count(DISTINCT nullif(btrim(n.plate), ''))
              FILTER (WHERE nullif(btrim(n.plate), '') IS NOT NULL)::int plate_n,
            mode() WITHIN GROUP (ORDER BY nullif(btrim(n.plate), '')) AS main_plate
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
            /* driver_payout_day carries the stored fold since
               sql/schema_v51.sql — the same expression, evaluated once per
               write instead of once per row per request. */
            ${peopleCountStored('person_key', 'driver_ext_id')}::int people,
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
  /* The people count comes from the STORED fold, through the base table.
     ─────────────────────────────────────────────────────────────────────
     peopleCount() evaluates two nested regexes — one with a backreference —
     per row, and this query's row set is every trip in the window. That is the
     same cost sql/schema_v20.sql stored the column to remove, and the same
     reasoning that took /api/alerts/by-driver from 93 seconds; the view cannot
     expose person_key, so JOIN_TRIP fetches it from the row the view is built
     on. The answer is identical by construction — test/person_key.test.mjs
     holds the stored expression to the JS one — and test/consistency.test.mjs
     holds this endpoint's driver count to the pages that state it elsewhere. */
  `SELECT n.plate,
          count(*) FILTER (WHERE n.is_booking)::int trips,
          count(*) FILTER (WHERE NOT n.is_booking)::int telematics_journeys,
          round(sum(n.distance_km) FILTER (WHERE n.is_booking AND n.has_distance)::numeric,0) km,
          round(sum(n.distance_km) FILTER (WHERE NOT n.is_booking AND n.has_distance)::numeric,0) telematics_km,
          round(sum(n.price) FILTER (WHERE n.has_fare)::numeric,0) revenue,
          count(*) FILTER (WHERE n.has_fare)::int priced_trips,
          ${peopleCountStored()}::int drivers,
          count(distinct n.platform)::int platforms,
          /* The same defect /api/vehicle/profile carried: last_trip was a max
             over EVERY row, telematics included, three lines below a trips
             column that already filters on is_booking. So a car that has never
             carried a passenger but whose tracker reported this morning showed
             a last_trip of this morning, and the idle and utilisation views on
             the same page disagreed with the ones fed by trip data. 46 of 227
             production plates are affected. The movement is still shown — it
             is worth knowing — under its own name. */
          max(n.requested_at) FILTER (WHERE n.is_booking) last_trip,
          max(n.requested_at) last_movement,
          cd.driver_name AS current_driver, cd.driver_ext_id AS current_driver_id,
          cd.as_of AS driver_as_of
   FROM trip_norm n ${JOIN_TRIP}
   LEFT JOIN vehicle_current_driver cd ON cd.plate = n.plate
   WHERE ${W('n')} AND n.plate IS NOT NULL AND n.plate<>''
   GROUP BY n.plate, cd.driver_name, cd.driver_ext_id, cd.as_of
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
          s.seat_occupied, s.ac_on, s.odometer,
          /* A zero from FMS is an ABSENT READING, not an empty tank.
             ─────────────────────────────────────────────────────────────
             Measured live: 83 of 130 vehicles carry a fuel_level and every
             single one of them is 0, and all 83 are the FMS feed. The front
             end already knew this and rendered a dash with an explanation —
             which is 130 explained dashes in a column headed "Charge".

             Nulled here instead, at the one place that knows which feed the
             row came from, so the column reads as ABSENT rather than as a
             fleet of flat batteries. CABMAN and Uber report no level at all,
             so their rows were already null. */
          CASE WHEN s.source = 'fms' AND coalesce(s.fuel_level, 0) = 0
               THEN NULL ELSE s.fuel_level END AS fuel_level,
          /* Staleness is a property of the FIX, not of our poll. CABMAN returns
             the last known position of every vehicle on every cycle, so a
             tracker that died in April 2024 still gets a fresh polled_at every
             five minutes — and 55 of 130 vehicles were being shown as live with
             no actual fix in over eleven minutes. The poll age is returned
             separately so "our collector is down" and "this tracker stopped
             reporting" stay two different states. */
          (now() - s.captured_at > ${FIX_FRESH}) AS stale,
          round(extract(epoch FROM now() - s.captured_at) / 60)::int AS fix_age_min,
          round(extract(epoch FROM now() - s.polled_at) / 60)::int AS poll_age_min,
          cd.driver_name AS current_driver, cd.as_of AS driver_as_of
   /* The newest FIX, not the newest poll.
      ─────────────────────────────────────────────────────────────────────
      CABMAN returns the last known position of every vehicle on every cycle,
      so polled_at is fresh for all 130 plates every five minutes whether or
      not the tracker actually reported. Ordering by it means every row in a
      cycle ties, and which one DISTINCT ON keeps is then arbitrary — the map
      could show a position older than one already held, and nothing on the
      page would say so. captured_at is what the tracker says the time was,
      which is the only column that orders positions.

      A fix captured in the FUTURE is a tracker whose clock runs ahead of ours,
      not a newer position, so those sort last rather than winning forever —
      the same distinction api/../src/reconcile.js draws between skew and age.
      polled_at breaks the remaining ties, so the result is deterministic. */
   FROM (SELECT DISTINCT ON (plate) * FROM telemetry_snapshot
          ORDER BY plate, (captured_at <= now()) DESC, captured_at DESC, polled_at DESC) s
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
  const plate = req.query.plate ? req.query.plate.toUpperCase().replace(/[\s-]+/g, '') : null;
  const rows = await q(
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
    [plate, ...win(req)]);
  /* The map's day picker reached exactly 400 rows in production, which is what
     a cap looks like when it has bitten and nothing says so — the day a reader
     is looking for is simply not in the menu, with no hint that it exists. */
  const [t] = await q(
    `SELECT count(*)::int n FROM (
       SELECT 1 FROM telemetry_snapshot t
        WHERE t.lat IS NOT NULL AND ($1::text IS NULL OR t.plate = $1)
          AND t.captured_at BETWEEN $2 AND $3
        GROUP BY (t.captured_at AT TIME ZONE 'Asia/Dubai')::date, t.plate
       HAVING count(*) >= 2) g`, [plate, ...win(req)]);
  /* Still a bare array, deliberately, unlike the other capped lists in this
     commit. Those have a front-end item pairing with them; the map's day
     picker does not, and a page nobody is rewriting must not be handed a shape
     it cannot read. The three facts ride on the row instead — every row in one
     response describes the same list, so repeating them is redundant rather
     than ambiguous. */
  res.json(rows.map((r) => ({
    ...r, total: t?.n ?? rows.length, shown: rows.length,
    truncated: (t?.n ?? 0) > rows.length,
  })));
}));

// A day's journey for one vehicle, split into segments wherever the car stopped
// or the gap between fixes is too long to draw a straight line through honestly.
app.get('/api/map/journey', wrap(async (req, res) => {
  if (!req.query.plate) return res.status(400).json({ error: 'plate required' });
  const plate = req.query.plate.toUpperCase().replace(/[\s-]+/g, '');
  /* The default day is TODAY IN DUBAI, not in UTC. The SQL three lines below
     is explicitly Dubai-framed — it shifts the bound by four hours — so a UTC
     default disagreed with the handler's own arithmetic between midnight and
     04:00 Dubai and the vehicle map opened on yesterday's journey during the
     airport wave, which is the shift this page is most used to watch.
     ?day= is a query parameter and therefore already a string; it stays as
     it is, and only the default changes. */
  const day = req.query.day || dubaiIso();
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
/* The fleet chip did nothing here. /api/alerts/summary with &platform=uber and
   &fleet=egari came back byte-identical to unfiltered — 34,547 events — on a
   two-fleet operator, so the Safety page showed one fleet's heading over both
   fleets' events. alert.fleet_id is the same column /api/kpis already narrows
   its own alert count by, so filtering on it here is what makes the safety
   tile and the safety page agree.

   Platform is deliberately NOT applied: a harsh-braking event comes from the
   telematics box in the car, not from a booking channel, so there is no
   channel to narrow it to. The front end says so on the page (F14) rather than
   the endpoint pretending to have filtered. */
app.get('/api/alerts/summary', wrap(async (req, res) => res.json(await q(
  `SELECT alert_type, count(*)::int n FROM alert
   WHERE ${DAYWIN('occurred_at')} AND ($3::text IS NULL OR fleet_id = $3)
   GROUP BY 1 ORDER BY 2 DESC`, [range(req)[0], range(req)[1], range(req)[3]]))));

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
  const [from, to, , fleet] = range(req);
  const rows = await q(
    /* "Most often" was alphabetical.
       ─────────────────────────────────────────────────────────────────────
       top_driver was (array_agg(driver_name ORDER BY driver_name))[1] — the
       first name in the ALPHABET among everyone who held the car, presented in
       a column headed "Most often". On L45255 that named the driver with 322
       events over the one with 702, and somebody reading that column would
       coach the wrong person. Ranked by their own event count now, with the
       count returned so the claim can be checked. */
    `WITH ev AS (
       SELECT plate, alert_type,
              (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day
       FROM alert WHERE ${DAYWIN('occurred_at')} AND ($3::text IS NULL OR fleet_id = $3)
     ),
     custody AS (
       SELECT DISTINCT ON (plate, day) plate, day, driver_name, driver_ext_id
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
         AND ($3::text IS NULL OR fleet_id = $3)
       ORDER BY plate, day, trips DESC NULLS LAST, driver_name
     ),
     joined AS (
       SELECT ev.plate, ev.alert_type, c.driver_name, c.driver_ext_id
       FROM ev LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day
     ),
     per_driver AS (
       SELECT plate, driver_name, max(driver_ext_id) AS driver_ext_id, count(*)::int n
       FROM joined WHERE driver_name IS NOT NULL GROUP BY 1, 2
     ),
     top AS (
       SELECT DISTINCT ON (plate) plate, driver_name, driver_ext_id, n
       FROM per_driver ORDER BY plate, n DESC, driver_name
     )
     SELECT j.plate,
            count(*)::int alerts,
            sum((j.alert_type ILIKE '%brake%')::int)::int harsh_brake,
            sum((j.alert_type ILIKE '%accel%')::int)::int harsh_accel,
            sum((j.alert_type ILIKE '%turn%')::int)::int sharp_turn,
            sum((j.alert_type ILIKE '%speed%')::int)::int overspeed,
            -- Everything the four buckets above do not catch, so the columns
            -- and the total can be reconciled instead of silently disagreeing.
            count(*) FILTER (WHERE j.alert_type NOT ILIKE '%brake%'
                               AND j.alert_type NOT ILIKE '%accel%'
                               AND j.alert_type NOT ILIKE '%turn%'
                               AND j.alert_type NOT ILIKE '%speed%')::int other,
            count(*) FILTER (WHERE j.driver_name IS NULL)::int unattributed,
            count(DISTINCT j.driver_name)::int drivers,
            max(t.driver_name) AS top_driver,
            max(t.driver_ext_id) AS top_driver_id,
            max(t.n)::int AS top_driver_alerts
     FROM joined j LEFT JOIN top t ON t.plate = j.plate
     GROUP BY j.plate ORDER BY alerts DESC LIMIT 100`, [from, to, fleet]);
  /* The page's "Vehicles involved" tile was the length of this list. The fleet
     runs about 130 vehicles against a cap of 100 — under the cap today, over it
     on any month where most of the fleet triggers something, and the tile would
     read exactly 100 with nothing to say it had been cut. */
  const [t] = await q(
    `SELECT count(DISTINCT plate)::int vehicles, count(*)::int alerts
     FROM alert WHERE ${DAYWIN('occurred_at')}
       AND ($3::text IS NULL OR fleet_id = $3)`, [from, to, fleet]);
  res.json({ rows, totals: t, shown: rows.length,
    truncated: (t?.vehicles ?? 0) > rows.length });
}));

/* The same events, attributed to people rather than to plates. The safety page
   named nobody at all: it fetched a driver column and rendered only the plate. */
app.get('/api/alerts/by-driver', wrap(async (req, res) => {
  const [from, to, , fleet] = range(req);
  /* Fleet-filtered with the list, so the numerator and the denominator name
     the same days — see api/alert_coverage_sql.js for why coverage is never
     computed per person. */
  const cov = await alertCoverage(q, from, to, { fleet });
  const rows = await q(
    `WITH ev AS (
       SELECT plate, alert_type, (occurred_at AT TIME ZONE 'Asia/Dubai')::date AS day
       FROM alert WHERE ${DAYWIN('occurred_at')} AND ($3::text IS NULL OR fleet_id = $3)
     ),
     custody AS (
       SELECT DISTINCT ON (plate, day) plate, day, driver_name, driver_ext_id, person_key
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
         AND ($3::text IS NULL OR fleet_id = $3)
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
              /* The residual. Six of sixty rows in production failed
                 alerts == brake + accel + turn + overspeed — Wunibie showed 703
                 of 1,201 events and "(unattributed)" 1,852 of 2,314 — because
                 anything the four ILIKE buckets miss was counted in the total
                 and in no column. by-vehicle has carried this since it was
                 written; this list did not, so the same events reconciled on
                 one tab and not on the other. */
              count(*) FILTER (WHERE ev.alert_type NOT ILIKE '%brake%'
                                 AND ev.alert_type NOT ILIKE '%accel%'
                                 AND ev.alert_type NOT ILIKE '%turn%'
                                 AND ev.alert_type NOT ILIKE '%speed%')::int other,
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
       SELECT t.person_key AS person, sum(n.distance_km) AS km,
              /* The same distance again, over the days the ALERT feed covered.
                 booked_km stays whole-window because distance is a question
                 about the window; the RATE is a question about the days the
                 numerator could have come from, and mixing them is what made
                 the fleet rate read 41.5 per 100 km at thirty days and 94.1 at
                 the same thirty days once the feed's 73-day hole was filled.
                 See api/alert_coverage_sql.js. Bound as a parameter rather
                 than interpolated, because test/alerts_by_driver.test.mjs
                 evaluates this literal with new Function and only DAYWIN and
                 JOIN_TRIP are in scope there. */
              sum(n.distance_km) FILTER (WHERE n.local_day = ANY($4::date[])) AS alert_km
       FROM trip_norm n ${JOIN_TRIP}
       WHERE t.person_key IN (SELECT person FROM shown WHERE person IS NOT NULL)
         AND ${DAYWIN('t.requested_at')}
         AND n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.has_distance
         AND n.driver_name IS NOT NULL AND btrim(n.driver_name) <> ''
       GROUP BY 1
     )
     SELECT s.driver_name, s.driver_ext_id, s.alerts,
            s.harsh_brake, s.harsh_accel, s.sharp_turn, s.overspeed, s.other,
            s.plates, s.plate_list,
            round(km.km::numeric, 0) AS booked_km,
            round(km.alert_km::numeric, 0) AS alert_km,
            s._drivers, s._alerts, s._unattributed
     FROM shown s LEFT JOIN km ON km.person = s.person
     ORDER BY s.alerts DESC`, [from, to, fleet, cov.days]);
  /* Named drivers, counted over the whole window rather than over the returned
     rows, and counted the way the list groups: by custody name, excluding the
     "(unattributed)" bucket, which is not a person. */
  const totals = rows.length
    ? { drivers: rows[0]._drivers, alerts: rows[0]._alerts, unattributed: rows[0]._unattributed }
    : { drivers: 0, alerts: 0, unattributed: 0 };
  for (const r of rows) {
    delete r._drivers; delete r._alerts; delete r._unattributed;
    /* Computed here rather than in SQL, so that a window the feed never
       covered renders as "not measured" with a reason — the same words the
       other five call sites use — instead of the 0 that SQL's nullif would
       have produced, which reads as a perfect safety record for a fleet nobody
       was watching. */
    r.per_100km = alertRate(r.alerts, r.alert_km, cov, 2);
    r.per_100km_absent = alertRateReason(r.alert_km, cov);
  }
  res.json({ rows, totals, shown: rows.length,
    alert_coverage: cov,
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
/* The fleet chip narrows these; the platform chip does not, and cannot.
   ──────────────────────────────────────────────────────────────────────────
   An occupancy segment is a seat sensor and a GPS trace. It belongs to a car,
   and a car belongs to a fleet — occupancy_segment.fleet_id, which none of
   these queries read, so #unauthorized answered identically for both
   businesses. It does NOT belong to a booking channel: the whole point of the
   verdict is that no channel explains it. Filtering by platform here would
   return an empty page and call it a clean one, so the predicate is left out
   deliberately and the front end says why. */
const SEG_FLEET = "AND ($3::text IS NULL OR fleet_id = $3)";
app.get('/api/unauthorized/summary', wrap(async (req, res) => {
  const [from, to, , fleet] = range(req);
  const rows = await q(
    `SELECT verdict, count(*)::int n, round(sum(distance_km)::numeric,0) km,
            round(sum(duration_min)::numeric,0) minutes
     FROM occupancy_segment WHERE ${DAYWIN('started_at')} ${SEG_FLEET}
     GROUP BY verdict ORDER BY n DESC`, [from, to, fleet]);
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
     FROM occupancy_segment WHERE ${DAYWIN('started_at')} ${SEG_FLEET}`, [from, to, fleet]);
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

/* The fleet filter, which this endpoint alone was missing.
   ─────────────────────────────────────────────────────────────────────────
   Its three siblings — summary, daily and by-vehicle — all bind SEG_FLEET, so
   an Egari-filtered occupancy page showed every tile at zero and a note saying
   no sensor data covers this fleet, above a table of twenty-six flagged
   segments on ECOSINE plates, each labelled Ecosine in its own Fleet column.
   The page named one fleet and accused another's cars.

   CABMAN DT is configured for Ecosine only (src/config.js says so: Egari's
   credentials have never been supplied), so the honest Egari answer here is an
   empty table under that note, not somebody else's vehicles. */
app.get('/api/unauthorized/list', wrap(async (req, res) => {
  const [from, to, , fleet] = range(req);
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
       AND ($4::text IS NULL OR o.fleet_id = $4)
     ORDER BY o.started_at DESC LIMIT 300`, [from, to, verdict, fleet]));
}));

// Names the drivers who actually held the car on the days the flags occurred —
// "L44305 had two unexplained trips" is a fact about a person, not a plate.
app.get('/api/unauthorized/by-vehicle', wrap(async (req, res) => {
  const [from, to, , fleet] = range(req);
  const rows = await q(
    `WITH seg AS (
       SELECT plate,
              count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
              count(*) FILTER (WHERE verdict='authorized')::int authorized,
              count(*) FILTER (WHERE verdict='sensor_suspect')::int sensor_suspect,
              round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,1) unauth_km
       FROM occupancy_segment WHERE ${DAYWIN('started_at')} ${SEG_FLEET}
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
     ORDER BY seg.unauthorized DESC LIMIT 100`, [from, to, fleet]);
  /* How many vehicles are flagged in total. The page's "Vehicles involved" tile
     already prefers a measured figure; this is where it comes from, and without
     it the tile falls back to counting the hundred rows it received. */
  const [t] = await q(
    `SELECT count(DISTINCT plate)::int vehicles,
            count(*) FILTER (WHERE verdict='unauthorized')::int segments
     FROM occupancy_segment
     WHERE ${DAYWIN('started_at')} AND verdict='unauthorized' ${SEG_FLEET}`, [from, to, fleet]);
  res.json({ rows, total: t?.vehicles ?? rows.length, segments: t?.segments ?? null,
    shown: rows.length, truncated: (t?.vehicles ?? 0) > rows.length });
}));

// daily trend of unauthorized vs authorized occupancy
app.get('/api/unauthorized/daily', wrap(async (req, res) => {
  const [from, to, , fleet] = range(req);
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
       FROM occupancy_segment WHERE ${DAYWIN('started_at')} ${SEG_FLEET} GROUP BY 1
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
     ORDER BY cal.d`, [from, to, fleet]));
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
/* The cap that read as a fleet count.
   ─────────────────────────────────────────────────────────────────────────
   This returned a bare array of exactly 100 rows at every window of a week or
   more — measured 2026-09-02: days=1 → 32, days=3 → 96, days=7 → 100,
   days=30 → 100, days=365 → 100 — against a directory holding 227 vehicles.
   The ORDER BY sorts by distance from a plausible occupancy band, so the 100
   that survive are the most anomalous pads and the tail is invisible. The page
   then printed, in its own caption, "100 trackers reported at all in this
   window" — the LIMIT reported as a fleet count. It only bites once a reader
   widens the window past the default two days, which is exactly when they are
   looking for the tail. The rows are still capped; what changes is that the
   response says so. */
app.get('/api/sensor-health', wrap(async (req, res) => {
  const [from, to, , fleet] = range(req);
  const rows = await q(
    `SELECT t.plate,
            -- A window over the grouped query counts the GROUPS, so the true
            -- total costs no second pass over telemetry_snapshot.
            count(*) OVER ()::int AS _total,
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
                WHERE ${DAYWIN('started_at')} ${SEG_FLEET} GROUP BY plate) o ON o.plate = t.plate
     WHERE t.source='cabman' AND ${DAYWIN('t.captured_at')}
       AND ($3::text IS NULL OR t.fleet_id = $3)
     GROUP BY t.plate
     -- Distance from a plausible occupancy band, so BOTH tails surface: a pad
     -- that never triggers and a pad that never releases are equally broken.
     ORDER BY abs(coalesce(count(*) FILTER (WHERE t.seat_occupied)::float
                           / nullif(count(*) FILTER (WHERE t.seat_occupied IS NOT NULL), 0), 0.35) - 0.35) DESC,
              total_fixes DESC
     LIMIT 100`, [from, to, fleet]);
  const total = rows.length ? rows[0]._total : 0;
  res.json({
    rows: rows.map(({ _total, ...r }) => r),
    total, shown: rows.length, truncated: total > rows.length,
  });
}));

/* ───────────────────────── ops / meta ───────────────────────── */
/* Coverage and history depth per channel, per fleet.
   ─────────────────────────────────────────────────────────────────────────
   Two faults, and they compounded. The count was `count(*)` over raw `trip`,
   which counts FMS telematics rows as bookings — the table showed
   uber/ecosine 166,579 beside fms/ecosine 24,132 and fms/egari 17,677, and
   41,809 of those FMS rows are twins of trips already counted under uber. And
   the count was ALL-TIME with no window at all, so the donut beside it read
   "uber · 11,092" for the selected month while this table read 166,579 in the
   same Share column.

   Both are now stated rather than conflated: `bookings` excludes the twins,
   `rows_seen` keeps the raw count so the telematics volume is still visible,
   and an optional from/to gives the windowed figure the donut is drawn from.

   And every configured channel appears, whether or not it has ever delivered
   a row. Bolt has no trip anywhere in this database — Ecosine is refused with
   COMPANIES_NOT_ALLOWED and Egari's token expired — so it had no row in a
   table whose whole job is to inventory the sources, on the page an operator
   would go to in order to find out. */
app.get('/api/platforms', wrap(async (req, res) => {
  const [from, to] = winDays(req);
  const windowed = !!(req.query.from || req.query.to || req.query.days || req.query.day);
  const [rows, health] = await Promise.all([
    q(`SELECT platform, fleet_id,
              count(*) FILTER (WHERE platform <> 'fms')::int bookings,
              count(*)::int rows_seen,
              count(*) FILTER (WHERE platform <> 'fms'
                AND (requested_at AT TIME ZONE 'Asia/Dubai')::date
                    BETWEEN $1::date AND $2::date)::int window_bookings,
              min(requested_at) earliest, max(requested_at) latest
       FROM trip GROUP BY platform, fleet_id ORDER BY bookings DESC, rows_seen DESC`, [from, to]),
    q(channelHealthSql()),
  ]);
  const byHealth = channelHealth(health);
  const seen = new Set(rows.map((r) => r.platform));
  /* A configured channel with nothing behind it, carrying the collector's own
     words. fleet_id is null because there is no row to take one from — the
     absence is fleet-wide by construction. */
  const missing = BOOKING_CHANNELS.filter((c) => !seen.has(c)).map((platform) => ({
    platform, fleet_id: null, bookings: 0, rows_seen: 0, window_bookings: 0,
    earliest: null, latest: null,
  }));
  /* Still a bare array. The page reads it as one, and the two facts a row
     needs beside its counts — which window the windowed column covers, and
     whether a window was asked for at all — ride on the row rather than
     forcing every caller through a wrapper. `windowed` false means no range
     was supplied, so window_bookings is the open window and identical to the
     all-time figure; a page that drew it as "this month" would be wrong. */
  res.json([...rows, ...missing].map((r) => ({
    ...r,
    window_from: from, window_to: to, windowed,
    ...(byHealth.get(r.platform) || {
      collection_status: null, collection_error: null, collection_at: null,
    }),
  })));
}));

/* The latest run per source and mode — including which of its windows failed.
   A run that wrote rows while most of its windows failed reported status='ok'
   for months while the Uber trip history had a 299-day hole in it. `status`
   now distinguishes them, and `failed_windows` names the dates, which is what
   makes a hole fixable rather than merely visible. */
/* Per FLEET as well as per source and mode.
   ─────────────────────────────────────────────────────────────────────────
   Ecosine and Egari are separate businesses with separate credentials on the
   same providers, and every collector writes its own run row for each. Keyed
   on (source, mode) alone, one fleet's row won and the other vanished — so a
   fleet whose session had expired, or whose surface had never run at all,
   read as whatever the other fleet did. That is the exact shape of the bug
   this page exists to expose, and it was hiding it: uber_fleet never ran for
   Egari for the collector's whole life and #sources showed uber_fleet ok. */
/* A source with no schedule needs to say so on the row.
   ─────────────────────────────────────────────────────────────────────────
   Every reading of this table — the amber on this page, the "stalest source
   last finished N h ago" line, STALL_HOURS in api/auth_routes.js — assumes a
   source has a cadence to fall behind. The operator ledger has none: nothing
   in src/index.js schedules it, and a workbook arrives when the operator
   exports one. Read on production 2026-09-02 it was 218 hours old beside
   incrementals fourteen minutes old, and the page printed "healthy" at it,
   which is the wrong word for both halves — it is neither healthy nor
   unhealthy, it is unscheduled. `cadence` carries that declaration and
   `silence` the sentence to print in place of a verdict nobody can earn. */
const CADENCE_BY_SOURCE = { ledger: LEDGER_CADENCE };
const SILENCE_BY_SOURCE = { ledger: ledgerSilence };
app.get('/api/status', wrap(async (_, res) => res.json((await q(
  `SELECT DISTINCT ON (source, mode, fleet_id) source, mode, fleet_id, status, rows_written,
          window_start, window_end, finished_at, error, chunks_total, chunks_failed, detail
   FROM collection_run ORDER BY source, mode, fleet_id, finished_at DESC`)).map((r) => {
  const detail = typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail;
  const cadence = CADENCE_BY_SOURCE[r.source] || null;
  const say = SILENCE_BY_SOURCE[r.source];
  return {
    ...r,
    detail: undefined,
    cadence,
    silence: say ? say(r) : null,
    failed_windows: (detail || []).filter((c) => c.error)
      .map((c) => ({ from: c.from, to: c.to, error: c.error })),
    windows: (detail || []).map((c) => ({ from: c.from, to: c.to, rows: c.rows, ok: !c.error })),
  };
}))));

/* This route ignored the request object entirely — `(_, res)` — so both filter
   chips above it did nothing, and #coverage?platform=bolt rendered a full page
   of Uber. Every table it reads carries a fleet, and three of the five carry a
   platform or a source; the two that do not (alert, ledger_entry) are narrowed
   by fleet alone and say so.

   No date window: this page is about the whole record by construction — "where
   does each source start and stop" — and the range chip is already hidden for
   it. See F21 for the front-end half. */
app.get('/api/coverage', wrap(async (req, res) => {
  const pl = req.query.platform || null;
  const fl = req.query.fleet || null;
  const P = [pl, fl];
  const [trips, telemetry, alerts, ledger, earnings, telDays, alertDays, ledgerDays,
    earnDays] = await Promise.all([
    q(`SELECT platform, count(*)::int n, min(requested_at) from_ts, max(requested_at) to_ts
       FROM trip WHERE ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR fleet_id=$2)
       GROUP BY 1`, P),
    /* telemetry_snapshot.source is 'cabman' or 'fms' — a tracker, not a booking
       channel — so a platform filter would empty it rather than narrow it. */
    /* min() as well as max(). This table is headed "what has actually landed"
       and its From column was blank on every row but the four trip feeds,
       because only those selected a first timestamp — while telemetry, alerts
       and the ledger obviously have one and the query simply never asked. On
       production that was 7 of 11 rows with no start date on the page whose
       job is to say how far back the record goes. */
    q(`SELECT source, count(*)::int n, min(captured_at) from_ts,
              min(polled_at) collected_from,
              max(polled_at) last_poll FROM telemetry_snapshot
       WHERE ($1::text IS NULL OR fleet_id=$1) GROUP BY 1`, [fl]),
    q(`SELECT count(*)::int n, min(occurred_at) from_ts, max(occurred_at) latest FROM alert
       WHERE ($1::text IS NULL OR fleet_id=$1)`, [fl]),
    q(`SELECT count(*)::int n, min(event_at) from_ts, max(event_at) latest FROM ledger_entry`),

    /* Money coverage, beside trip coverage, because they are not the same span
       and the difference is the single largest hole in this product.

       Uber's earnings API serves roughly the last six months. The trip feed
       goes back a year — so there is half a year of bookings, distance and
       drivers with no money attached and none that can ever be collected. Every
       backfill asked for those windows, every window returned ok, and every one
       of them returned nothing: a silence indistinguishable from a quiet week
       unless it is stated. This states it. */
    /* Days that have HAPPENED, and the accrual named beside them.
       ─────────────────────────────────────────────────────────────────────
       driver_payout_day expands a payout period across period_start..period_end
       and weekChunks runs an OPEN week to the following Sunday, so this table
       legitimately holds rows for days that have not arrived yet. Unbounded,
       max(day) reported them as the record's end: read off production
       2026-09-02, `earnings uber to_day 2026-09-06, days 213` — four days that
       had not happened, on the row of the table headed "what has actually
       landed", on the page an operator opens to find out what is MISSING.
       /api/coverage/calendar was bounded for exactly this reason; this
       inventory is the other half of the same row and was not.

       Not truncated: an accrual is real money and /api/reconcile names it, so
       the future days are counted and labelled rather than dropped. */
    q(`SELECT platform,
              count(*)::int n,
              min(day) from_day, max(day) to_day,
              max(day) FILTER (WHERE day <= (now() AT TIME ZONE 'Asia/Dubai')::date)
                AS to_day_settled,
              count(DISTINCT day) FILTER (WHERE day <= (now() AT TIME ZONE 'Asia/Dubai')::date)::int
                AS days,
              count(DISTINCT day) FILTER (WHERE day > (now() AT TIME ZONE 'Asia/Dubai')::date)::int
                AS accrual_days,
              round(sum(earnings)::numeric, 0) earnings
       FROM driver_payout_day
       WHERE earnings IS NOT NULL
         AND ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR fleet_id=$2)
       GROUP BY 1`, P),
    /* Per-day counts for the datasets source_day_coverage does not cover.
       ─────────────────────────────────────────────────────────────────────
       That view reads the trip table alone, and eight other things read it —
       including the insight engine, which treats every source in it as a
       booking channel — so widening it would put telemetry into places that
       would report it as a channel with collection gaps. The Data coverage
       table needs the same per-day continuity for feeds that are not trips,
       so it is computed here, for this endpoint, and folded through the same
       gap-finder the calendar uses (api/coverage_gaps.js).

       Dubai days, like every other calendar key in this product. */
    /* polled_at, not captured_at — OUR clock, not the tracker's.
       ─────────────────────────────────────────────────────────────────────
       captured_at is when the device says the fix happened, and this fleet
       has trackers that stopped years ago: the collector logs "vehicles
       listed but not reporting, dormant 15 of 48, oldest_days 862". Their
       last surviving fix drags min(captured_at) back to 2024, so a span
       computed from it reported CABMAN as 23 days collected of 863 and 840
       missing — which reads as a catastrophic collection failure and is
       actually fifteen dead units and one fix from April 2024.

       polled_at advances every time the collector observes a vehicle, so a
       day with a poll on it is a day we collected. That is the question this
       column asks. src/reconcile.js draws the same distinction for the same
       reason. */
    q(`SELECT 'telemetry:' || source AS dataset,
              to_char((polled_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
              count(*)::int rows
         FROM telemetry_snapshot WHERE polled_at IS NOT NULL
         GROUP BY 1, 2 ORDER BY 1, 2`),
    q(`SELECT 'alerts' AS dataset,
              to_char((occurred_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
              count(*)::int rows
         FROM alert WHERE occurred_at IS NOT NULL
         GROUP BY 1, 2 ORDER BY 2`),
    q(`SELECT 'ledger' AS dataset,
              to_char((event_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
              count(*)::int rows
         FROM ledger_entry WHERE event_at IS NOT NULL
         GROUP BY 1, 2 ORDER BY 2`),
    /* Earnings too. driver_payout_day already resolves overlapping report
       windows to one row per driver-day, so its days ARE the days the money
       covers — which is the continuity question this table asks. Without it
       the two earnings rows were the last on the page with nothing to say
       about their own gaps, on a product where the money reaching back only
       to February is the single most consequential hole in the record. */
    /* Days that have HAPPENED. driver_payout_day expands a payout period across
       period_start..period_end, and weekChunks runs an open week to the
       following Sunday, so this table legitimately holds rows for days in the
       future — that is what #reconcile reports as an accrual.
       ─────────────────────────────────────────────────────────────────────
       Here it was a contradiction. Read from production on 2026-09-02:

         earnings:uber  first 2026-02-06  last 2026-09-06  213 days  missing 0

       Four days that had not happened, on the page an operator opens
       specifically to find out what is MISSING — while /api/reconcile named
       the same rows honestly (accrual_days 4, period_cut true). One set of
       rows, two pages, two treatments, and the one claiming completeness was
       the one describing days that did not exist yet. */
    q(`SELECT 'earnings:' || platform AS dataset,
              to_char(day, 'YYYY-MM-DD') AS day, count(*)::int rows
         FROM driver_payout_day
        WHERE day <= (now() AT TIME ZONE 'Asia/Dubai')::date
        GROUP BY 1, 2 ORDER BY 1, 2`),
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
      /* Two different columns, so two different readers — see the note above
         the overview section. from_ts is `min(requested_at)` selected bare
         from trip, and requested_at is TIMESTAMPTZ (sql/schema.sql:55), so it
         arrives as an INSTANT and the Dubai day of it is the answer. from_day
         is `min(day)` from driver_payout_day, and day is DATE
         (sql/schema_v23.sql:115), so it arrives as a Date at local midnight
         and its local components are the answer.

         Both were `.toISOString().slice(0, 10)` and the trip half was wrong on
         production the day this was written: the first Uber booking is
         2025-04-04T23:12:38Z, which is 03:12 on the 5th in Dubai, and this
         column read "2025-04-04" beside /api/performer/weeks reporting
         first_booking 2025-04-05 off trip_norm.local_day. The money half was
         right only because the container runs UTC.

         payFrom is not just printed — it is bound as $2::date[] into the
         bookings_before count below, so a day's drift there moves the
         unpaid-bookings boundary with nothing failing. */
      const tripFrom = dubaiIso(t.from_ts);
      const payFrom = isoDay(e.from_day);
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
  /* Continuity for the datasets that are not trips.
     ───────────────────────────────────────────────────────────────────────
     Keyed on a MACHINE value — telemetry:<source>, alerts, ledger — not on
     the label the page prints. Keying it on the label looked tidier and
     matched two rows of nine: the page renders 'telemetry · CABMAN' through
     sourceLabel() while this query knows the source as 'cabman', so every
     telemetry row silently failed to join and went on saying "not a dated
     source" about the longest feed the product holds. */
  const calendars = {};
  for (const rows of [telDays, alertDays, ledgerDays, earnDays]) {
    for (const r of rows) (calendars[r.dataset] ||= []).push({ day: r.day, rows: r.rows });
  }
  /* A quiet day is not a gap on an EVENT-DRIVEN dataset. The ledger arrives
     when somebody imports one, so it promises no row on any particular day and
     "78 days missing" about it would describe a quiet fortnight as a collection
     failure. It keeps its span and its day count and says so instead.

     Safety alerts USED to be in this set, on the same reasoning, and that was
     wrong. /api/coverage measures the dataset at a median 3,758 rows a day for
     every day it works — it is a daily feed by any measure the product has. Its
     73-day hole (2026-06-06 → 2026-08-17) was a collection failure the whole
     time: every FMS run on record refused the alert window with HTTP 400 while
     the trip window beside it answered 200. Calling that a calm quarter turned
     a fixable fault into a decision not to look. */
  const EVENT_DRIVEN = new Set(['ledger']);
  const dataset_calendar = Object.fromEntries(
    Object.entries(calendars).map(([k, days]) => [k,
      { ...spanGaps(days), event_driven: EVENT_DRIVEN.has(k) }]));
  res.json({ trips, telemetry, alerts, ledger, earnings, earnings_gaps: gaps,
    dataset_calendar });
}));

/* ───────────────────────── settings ───────────────────────── */
/* Readable by anyone; legible only to an administrator.
   ─────────────────────────────────────────────────────────────────────────
   This route was wide open and returned every non-secret credential in clear.
   It is not gated outright because the Settings page is also the only place
   that says which credential is missing, which component holds it and how many
   days a session cookie has left — a diagnostic an operator needs when they
   have, by definition, just lost their token. So the shape stays and the
   values go: see redactSettings in api/admin_gate.js. */
app.get('/api/settings', wrap(async (req, res) => {
  const rows = await describeSettings();
  res.json(isAdmin(req) ? rows : redactSettings(rows));
}));

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

/* Paste whatever the provider gave you.
   ─────────────────────────────────────────────────────────────────────────
   The operator's actual workflow is: open the provider's dashboard, open
   devtools, copy, come here. What they hold is a cookie jar, a bare JWT, or a
   curl command — and what this app wants is one of twenty-four named keys,
   half of which come in per-fleet pairs that are indistinguishable by eye.
   Matching one to the other by hand is a step that adds nothing and goes
   wrong silently: the Egari cookie on UBER_WEB_COOKIE points the Ecosine
   collector at another business, and Uber answers happily.

   So the text is read, not interpreted by a person:

     1. recognise()   decodes the identifying field inside each block — Bolt's
                      fleet_owner_id, Uber's supplierOrgUUID, Yango's Yandex
                      markers — and names the key exactly, or declines.
     2. proposeKeys() asks the model about ONLY what was left over, and only
                      ever sees a redacted silhouette. Its answer is a
                      candidate, never a decision.
     3. checkAll()    tries every candidate against its own provider, with the
                      pasted value in hand and nothing written yet.
     4. apply         stores the ones that answered, and nothing else.

   Step 3 before step 4 is the whole point. Writing first and discovering on
   the next tick means the working credential is already gone, fifteen minutes
   pass, and the dashboard stops updating for a reason nothing on screen
   explains. `dry_run` stops after step 3 so the operator sees the verdicts
   before anything moves; it is the default. */
app.post('/api/settings/paste', requireAdmin, wrap(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const apply = req.body?.apply === true;
  if (text.trim().length < 20) {
    return res.status(400).json({ error: 'nothing to read', detail: 'paste the credential, or upload the file you copied it into' });
  }
  await loadSettings();

  const found = recognise(text);
  /* The model is asked about the leftovers only, and its proposals join the
     same queue — same live check, same right to be refused. */
  const leftovers = unrecognised(text);
  let guessed = [];
  try {
    guessed = (await proposeKeys(leftovers)).map((g) => {
      const def = SETTING_DEFS.find((d) => d.key === g.key);
      const fleet = /_EGARI$/.test(g.key) ? 'egari' : /_ECOSINE$/.test(g.key) ? 'ecosine' : null;
      return {
        provider: def?.group || 'unknown', key: g.key, fleet, ok: true,
        value: leftovers[g.index], source: 'model', confidence: g.confidence,
        why: `${g.why} (proposed by the model, not read from the credential)`,
      };
    });
  } catch { /* an absent model is one less step, not an error */ }

  const candidates = [...found.map((f) => ({ ...f, source: 'recognised' })), ...guessed];
  const tested = await checkAll(candidates);

  const applied = [];
  if (apply) {
    for (const t of tested) {
      /* 'pass' is the ordinary route in. 'unknown' is admitted for exactly one
         case: a credential the OPERATOR labelled by name, for which no live
         check exists.
         ─────────────────────────────────────────────────────────────────────
         Refusing it made the labelled-credential route pointless — an API key,
         a park id, an interface password would be read correctly, routed
         correctly, reported as untestable and then silently not written, which
         is the same dead end as not recognising them at all. 'unknown' from a
         SHAPE-recognised credential is still refused: there the product had a
         check and could not reach the provider, and overwriting a working
         credential on that basis is how a good session gets replaced during an
         outage. And 'fail' is never applied, labelled or not. */
      const admit = t.verdict === 'pass' || (t.verdict === 'unknown' && t.labelled === true);
      if (!admit) continue;
      /* One credential, one key — except an OAuth application, which is a
         client id, its secret, and the organisation it turned out to be
         registered under. Writing two of those three leaves the third
         pointing at the previous application, and every REST call answers
         403 exactly as if the paste had not happened. */
      if (t.keys && typeof t.keys === 'object') {
        /* All three, or none. setSetting throws on a key the catalogue does
           not declare, and a throw halfway through leaves an application
           whose id has been replaced and whose secret has not — which
           authenticates as nothing and looks exactly like the credential
           having been wrong. Checked before the first write rather than
           recovered from after it. */
        const bad = Object.keys(t.keys).filter((k) => !SETTING_DEFS.some((d) => d.key === k));
        if (bad.length) {
          t.verdict = 'fail';
          t.detail = `${t.detail || ''} — but this dashboard has no setting called ${bad.join(', ')}, `
            + 'so nothing was written';
          continue;
        }
        for (const [k, v] of Object.entries(t.keys)) {
          await setSetting(k, v);
          applied.push(k);
        }
        continue;
      }
      if (!t.key) continue;
      await setSetting(t.key, t.value);
      applied.push(t.key);
    }
    if (applied.length) await loadSettings(true);
  }

  /* The value never comes back out. A page that echoes a credential is a page
     that puts it in a browser cache, a screenshot and a support ticket. */
  res.json({
    ok: true,
    applied,
    dry_run: !apply,
    unread: leftovers.length - guessed.length,
    proposals: tested.map((t) => ({
      provider: t.provider, key: t.key, fleet: t.fleet || null,
      /* The keys a candidate resolved to, where it resolved to more than one.
         The page lists them; the value of none of them comes back. */
      keys: t.keys ? Object.keys(t.keys) : null,
      source: t.source, confidence: t.confidence || null,
      verdict: t.verdict, detail: t.detail, why: t.why,
      expires_at: t.expires_at || null,
      account: t.account || null, org_uuid: t.org_uuid || null,
      chars: t.value ? String(t.value).length : 0,
      applied: t.keys
        ? Object.keys(t.keys).every((k) => applied.includes(k))
        : applied.includes(t.key),
      /* Written on the operator's word, with nothing confirming it works.
         "Saved" and "saved and proven" are different promises and the page has
         to be able to tell them apart — otherwise a labelled key that turns out
         to be wrong looks exactly like one that was tested. */
      saved_untested: t.verdict === 'unknown' && applied.includes(t.key),
    })),
  });
}));

// trigger a collector run on demand (backfill/incremental) — the worker owns scheduling,
// this just records intent the worker picks up on its next tick.
/* Queue an on-demand collector run.
   This used to write a single source_state key, so requesting two things
   seconds apart discarded the first — while answering {ok: true} to the
   request it was about to throw away. A row per request, and a duplicate of
   something already pending is REFUSED rather than merged, because "queued"
   for a job that will never run is the same lie in a different shape. */
/* `profile` is the weekly per-driver pull — Uber's rating, lifetime count,
   ban and papers. On the list because the first thing anyone wants after
   wiring a new surface is to run it once and look, and because a rating that
   only ever arrives on a Monday cron is a rating nobody can check today. */
const JOB_MODES = ['backfill', 'incremental', 'analyst', 'probe', 'timeline', 'timeline-roster', 'profile', 'audit'];
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
  /* An allow-list, because this writes into driver_statement_day and therefore
     into money_event, and "Where the money came from" lists whatever it finds.
     ─────────────────────────────────────────────────────────────────────────
     platform and company were lowercased and inserted with no check at all,
     though FLEETS is declared eighteen lines above and validated elsewhere in
     this same handler's neighbourhood. Measured on production 2026-09-02: a
     platform called `yay` — 22 rows, AED 881.98, 2026-02-14 to 2026-04-06,
     across both fleets — is in the table now, and a misspelling was being
     offered to a reader as a revenue source. It has done no further harm only
     because every money read filters source='ledger' out, which is a
     coincidence of this importer's other job rather than a defence.

     Rejected rows are REPORTED, not dropped: the response already carries a
     `bad` list of row indices, and an import that silently discards a
     misspelled platform is how somebody spends an afternoon looking for money
     they believe they uploaded. */
  const PLATFORMS = new Set(['uber', 'yango', 'bolt', 'hotel', 'cabman', 'fms', 'careem']);
  for (const [i, r] of rows.entries()) {
    const day = String(r.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !r.driver || !r.platform || !r.company) {
      bad.push(i); continue;
    }
    if (!PLATFORMS.has(String(r.platform).toLowerCase())
        || !FLEETS.includes(String(r.company).toLowerCase())) {
      bad.push(i); continue;
    }
    clean.push([String(r.platform).toLowerCase(), String(r.company).toLowerCase(),
      String(r.driver).trim(), day, num(r.gross), num(r.fees), num(r.net), num(r.tips),
      num(r.salik), num(r.cash), num(r.bank), num(r.network_cash), num(r.unremitted),
      r.trips === '' || r.trips == null ? null : parseInt(r.trips, 10),
      source, Boolean(r.pseudo)]);
  }
  let written = 0;
  const wrote = {};          // fleet_id -> rows THIS batch wrote
  let span = { first: null, last: null };
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
         ingested_at = now()
       RETURNING fleet_id, to_char(day, 'YYYY-MM-DD') AS day`, clean.flat());
    /* RETURNING, not rowCount. The run row needs to know WHICH fleets this
       import wrote for and which days it covered, and a count cannot say
       either — that is half of why the old row was attributed to a hard-coded
       Ecosine. */
    const back = r2.rows || [];
    written = back.length || (r2.rowCount ?? clean.length);
    for (const row of back) wrote[row.fleet_id] = (wrote[row.fleet_id] || 0) + 1;
    span = spanOf(back);
  }
  /* Every batch folds into the tally, including this one; only the last batch
     records the run. See src/sources/ledger.js for why the tally is in the
     database rather than in a variable. */
  const tally = await tallyBatch({ db: pool, source, fleets: wrote, days: span });
  let runs = null;
  if (done) {
    const final = await takeTally({ db: pool, source });
    runs = await recordImport({
      db: pool, source,
      rows: final.fleets,
      days: { first: final.first, last: final.last },
    });
  }
  res.json({ ok: true, written, rejected: bad.length, rejected_indexes: bad.slice(0, 10),
    /* What the import has landed SO FAR, per fleet — so the importer's own
       final line, and anyone reading one batch's answer, sees the same numbers
       the run row will carry rather than a table size. */
    imported: done ? null : tally.fleets,
    ...(done ? { recorded: runs, fleets: tally.fleets, days: { first: tally.first, last: tally.last } } : {}) });
}));

/* Running the analyst needs no credential.
   ─────────────────────────────────────────────────────────────────────────
   /api/settings/trigger is admin-gated because most of what it queues touches
   collection: a backfill re-pulls a provider with stored credentials, and the
   same handler's siblings rewrite those credentials. The analyst does none of
   that. It reads aggregates this API already serves, asks a model for
   hypotheses, measures them against the same database, and writes rows to
   analyst_finding — nothing it can reach is a secret and nothing it does is
   destructive.

   Gating it made "look at the fleet again" the one thing on this product that
   required a token nobody holds, which on a fleet whose last twelve analyst
   passes all failed is the difference between finding that out and not. The
   duplicate guard below is the real protection worth having: a second pass
   while one is queued or running does the same work twice and is refused. */
app.post('/api/analyst/run', wrap(async (req, res) => {
  const fleet = FLEETS.includes(req.body?.fleet) ? req.body.fleet : null;
  const [existing] = await q(
    `SELECT id, status, requested_at FROM collector_job
      WHERE mode = 'analyst' AND fleet IS NOT DISTINCT FROM $1
        AND status IN ('queued', 'running') ORDER BY requested_at LIMIT 1`, [fleet]);
  if (existing) {
    return res.status(409).json({ ok: false, mode: 'analyst', fleet,
      already: existing.status, job_id: existing.id, requested_at: existing.requested_at,
      detail: 'an analyst pass is already queued or running; a second one would do the same work twice' });
  }
  const [job] = await q(
    `INSERT INTO collector_job (mode, fleet, requested_by) VALUES ('analyst', $1, 'analyst-run')
     RETURNING id, mode, fleet, status, requested_at`, [fleet]);
  res.json({ ok: true, queued: 'analyst', fleet, job_id: job.id, job });
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
    /* Always 'admin' now, and that is the point: requireAdmin is the only way
       into this handler and it no longer lets an unauthenticated caller past,
       so the ternary this replaced could only ever have written the truthful
       'unauthenticated' — which is what all ten stored jobs in production say.
       A queue whose every row reads "unauthenticated" is not an audit trail. */
    [mode, fleet, 'admin']);
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
                 THEN round(extract(epoch FROM now() - started_at))::int END AS running_seconds,
            /* The true size of the set, carried on the rows the cap let
               through. A window over the ordered query counts every job
               without a second scan. */
            count(*) OVER ()::int AS _total
     FROM collector_job ORDER BY requested_at DESC LIMIT 40`);
  /* The cap said nothing, and this is the page an operator opens to find out
     whether a job ran. bin/cap-audit.mjs found it returning exactly 40 of a
     larger set with no disclosure — the last silent cap in 49 handlers, the
     other ten all declaring themselves. /api/sensor-health had the same fault
     and printed its LIMIT as a fleet count; here it would read as "these are
     all the jobs there have been", which is how a failure that scrolled off
     the end becomes a failure nobody knows about.

     pending and running stay counts over the WHOLE table rather than over the
     returned page: "2 queued" must not become "2 queued that fit on this
     page". */
  const total = jobs.length ? jobs[0]._total : 0;
  for (const j of jobs) delete j._total;
  const [counts] = await q(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS pending,
            count(*) FILTER (WHERE status = 'running')::int AS running
       FROM collector_job`);
  res.json({
    jobs,
    total, shown: jobs.length, truncated: total > jobs.length,
    pending: counts?.pending ?? 0,
    running: counts?.running ?? 0,
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
  /* A finding page could not find its own finding.
     ─────────────────────────────────────────────────────────────────────────
     #action/<code>/<id> fetched the WHOLE list and searched it in the browser.
     The list is capped at 200 and production holds 204 findings, so the four
     rows the cap cut rendered in the category chips on #insights and then
     answered "That finding is no longer open." on their own page:
     unsafe_driving on L45255, L95161 and L40959, and stale_tracker on L40547 —
     all four open, all four unreachable. Asking for a code returns every row
     under it (29 for unsafe_driving) instead of a slice of everything. */
  const code = req.query.code || null;
  const entity = req.query.entity_id || null;
  /* The fleet a finding is about. 171 of the 200 rows carry one and no page
     could narrow by it, so a two-fleet operator read one list for both. */
  const fleet = req.query.fleet || null;
  /* The window a finding is ABOUT, where the caller states one.
     ─────────────────────────────────────────────────────────────────────────
     The generator runs on whatever window a collection pass used and the table
     keeps every run, so one list held unsafe_driving rows measured over 3, 30
     and 365 days, each carrying its own "fleet median" — seven different
     medians over four different denominators, ranked against each other.
     Filtering to one window makes the list comparable. A NULL-window row
     (idle_vehicle, stale_tracker, the document rules) always passes: it is not
     about a window at all, and dropping it would silently shorten the list. */
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
  const rows = await q(
    /* ONLY WHAT THE LAST RUN OF EACH RULE STILL FINDS.
       ─────────────────────────────────────────────────────────────────────
       src/insights.js prunes to one row per (code, entity, window) and keeps
       the newest, so a finding that was true once and has not been true since
       survives forever — and this endpoint served it as a live to-do. On
       production, 163 of the 200 rows on the action list were last recomputed
       before Aug 30, some as far back as Aug 21: 74 idle-vehicle findings the
       rule had already stopped emitting sat beside the 1 it still did, and
       "L37810: Vehicle Registration Form expires in 1 days", computed on the
       25th, was still on the list on the 1st — six days after the document it
       describes expired.

       A rule's most recent write is the moment it last evaluated. Anything it
       did not re-emit then, it no longer finds. Ten minutes of tolerance
       because a pass writes over some seconds; the incremental that drives it
       runs every thirty, so the window cannot reach the previous pass.

       What this deliberately does NOT do is drop findings from a rule that has
       not run at all — its own last write is its last run, so every row it
       wrote is still current by this test. That is the honest answer: a rule
       that never re-evaluated has not cleared anything. The remaining gap is a
       rule that ran and emitted nothing at all, whose last write stays old;
       closing that needs a per-rule run marker rather than an inference from
       the rows. */
    `WITH run AS (
       /* When each rule last EVALUATED. insight_run is stamped by
          src/insights.js after a job succeeds, which is the only way to know a
          rule ran and found nothing — the rows alone cannot say it, and a rule
          that ran clean left its whole previous set standing as live work.
          The greatest() keeps the inference as a floor for any code with no
          marker yet (a database that has not run the new collector), so this
          can never show LESS than it did before the marker existed. */
       SELECT i.code,
              greatest(max(i.computed_at), max(r.ran_at)) AS last_run
       FROM insight i
       LEFT JOIN insight_run r ON r.code = i.code
       GROUP BY 1
     ),
     scoped AS (
       SELECT i.code, i.severity, i.category, i.entity_type, i.entity_id, i.title, i.detail,
              i.action, i.impact_aed, i.metric, i.fleet_id, i.refs,
              i.window_start, i.window_end, i.computed_at,
              (i.computed_at >= r.last_run - interval '10 minutes') AS still_found
       FROM insight i
       JOIN run r ON r.code = i.code
       WHERE ($1::text IS NULL OR i.severity=$1) AND ($2::text IS NULL OR i.category=$2)
         AND ($3::text IS NULL OR i.code=$3) AND ($4::text IS NULL OR i.entity_id=$4)
         AND ($5::text IS NULL OR i.fleet_id=$5)
         AND (i.window_start IS NULL
              OR (($6::date IS NULL OR i.window_start >= $6::date)
                  AND ($7::date IS NULL OR i.window_end <= $7::date)))
     ),
     deduped AS (
       SELECT DISTINCT ON (code, entity_type, entity_id) *
       FROM scoped
       ORDER BY code, entity_type, entity_id, computed_at DESC
     ),
     latest AS (
       SELECT *, count(*) FILTER (WHERE NOT still_found) OVER ()::int AS cleared
       FROM deduped
     )
     SELECT *,
            /* Whether the AED beside a finding was MEASURED or assumed. 75 of
               the 204 live findings are idle_vehicle, whose impact is a
               hardcoded holding-cost constant, and nothing on the row said so
               — so a modelled number sorted and totalled beside measured
               ones. */
            CASE WHEN impact_aed IS NULL THEN NULL
                 WHEN code = 'idle_vehicle' THEN 'modelled' ELSE 'measured' END AS impact_kind
       FROM latest
      WHERE still_found
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
              computed_at DESC, impact_aed DESC NULLS LAST
     LIMIT ${INSIGHT_LIMIT + 1}`, [sev, cat, code, entity, fleet, from, to]);
  const truncated = rows.length > INSIGHT_LIMIT;
  res.json({
    insights: rows.slice(0, INSIGHT_LIMIT).map(({ still_found, cleared, ...r }) => r),
    truncated, limit: INSIGHT_LIMIT,
    /* How many findings the rules have stopped emitting since they last wrote
       them. Returned rather than silently dropped: a to-do list that shortens
       overnight should be able to say why it did. */
    cleared: rows[0]?.cleared ?? 0,
    filter: { severity: sev, category: cat, code, entity_id: entity, fleet, from, to },
  });
}));

/* Counts over the DEDUPLICATED set, and the money kept apart from it.
   The "quantified cost" tile summed impact_aed across the whole table. Only one
   rule sets that field, and it sets it to a constant — fourteen days at an
   assumed AED 120 holding cost — so the headline was (number of runs) x (number
   of idle vehicles) x 1,680. It read AED 1,424,592.

   A modelled figure and a measured one do not belong in the same total, so the
   assumption is returned with it and the tile can say so. */
const IDLE_DAY_COST = Number(process.env.VEHICLE_DAY_COST_AED || 120);
app.get('/api/insights/summary', wrap(async (req, res) => {
  /* One pass over the table, not five.
     ─────────────────────────────────────────────────────────────────────────
     This ran the same DISTINCT ON over ~30,000 rows four separate times — once
     per severity group, once per category group, once for the totals — plus a
     fifth count(*). The rows are 99.3% duplicates (stored_rows 29,634 against
     total.n 204), so each pass sorted thirty thousand rows to reach two
     hundred. Materialised once and read three times; sql/schema_v30.sql adds
     the index whose key and order are exactly what the DISTINCT ON needs. */
  const fleet = req.query.fleet || null;
  const pl = req.query.platform || null;
  /* The same freshness rule as the list above, and for the reason this
     codebase repeats everywhere: the tiles and the list they head must be
     counted over the same set. Without it the summary said 200 findings over a
     list that now shows 37. */
  const base = `WITH run AS (
      SELECT i.code, greatest(max(i.computed_at), max(r.ran_at)) AS last_run
        FROM insight i LEFT JOIN insight_run r ON r.code = i.code
       GROUP BY 1),
    latest AS MATERIALIZED (
      SELECT DISTINCT ON (i.code, i.entity_type, i.entity_id) i.*
      FROM insight i
      JOIN run r ON r.code = i.code
      WHERE ($1::text IS NULL OR i.fleet_id = $1)
        AND i.computed_at >= r.last_run - interval '10 minutes'
      ORDER BY i.code, i.entity_type, i.entity_id, i.computed_at DESC)`;
  const P = [fleet];
  const [bySev, byCat, [tot], [raw], [deduped]] = await Promise.all([
    q(`${base} SELECT severity, count(*)::int n FROM latest GROUP BY 1`, P),
    q(`${base} SELECT category, count(*)::int n FROM latest GROUP BY 1 ORDER BY 2 DESC`, P),
    q(`${base}
     SELECT count(*)::int n,
            round(sum(impact_aed) FILTER (WHERE code <> 'idle_vehicle')::numeric, 0) AS measured_impact,
            round(sum(impact_aed) FILTER (WHERE code = 'idle_vehicle')::numeric, 0) AS modelled_impact,
            count(*) FILTER (WHERE code = 'idle_vehicle')::int AS idle_vehicles
     FROM latest`, P),
    q(`SELECT count(*)::int n FROM insight WHERE ($1::text IS NULL OR fleet_id = $1)`, P),
    /* The middle number: findings after de-duplication but BEFORE the
       freshness rule. Without it the tile called every suppressed row a
       duplicate — and since fix 20 most of them are not duplicates at all,
       they are findings the rules have stopped emitting. Two different facts
       about the list, and a tile that merges them is telling the reader the
       wrong one. */
    q(`SELECT count(*)::int n FROM (
         SELECT DISTINCT ON (code, entity_type, entity_id) id
           FROM insight WHERE ($1::text IS NULL OR fleet_id = $1)
          ORDER BY code, entity_type, entity_id, computed_at DESC) d`, P),
  ]);
  res.json({
    total: tot, by_severity: bySev, by_category: byCat,
    modelled: {
      idle_vehicles: tot?.idle_vehicles ?? 0,
      aed: tot?.modelled_impact ?? null,
      assumption: `${IDLE_DAY_COST} AED per vehicle per day of holding cost, over a 14-day lookback`,
    },
    // Visible so a duplicate explosion cannot be silent again.
    stored_rows: raw?.n ?? 0,
    /* Copies of a finding that is still current. */
    duplicates_suppressed: Math.max(0, (raw?.n ?? 0) - (deduped?.n ?? 0)),
    /* Findings the rules have stopped emitting. A different fact, and the one
       that answers "why is this list shorter than yesterday". */
    resolved_since_last_run: Math.max(0, (deduped?.n ?? 0) - (tot?.n ?? 0)),
    /* Platform is accepted and NOT applied, and says so rather than pretending.
       An insight is about a vehicle, a driver or the fleet; the generator does
       not record which booking channel it came from, so narrowing by one would
       return an empty list rather than a narrower one. */
    filter: { fleet, platform: pl },
    platform_applies: false,
  });
}));

// monthly trend + automatic structural-break detection (what changed, and when)
app.get('/api/trend/monthly', wrap(async (req, res) => {
  /* The fleet chip was carried in the address and honoured by nothing: every
     query below pinned fleet_id = '*'. On a two-fleet operator that made
     #causes — the page whose subject is why the numbers moved — describe both
     businesses under one fleet's heading. The rollup already carries a row per
     fleet at every grain, so this is a bind rather than an aggregation. */
  const trendFleet = req.query.fleet || null;
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
     WHERE platform = coalesce($1, '*') AND fleet_id = coalesce($2, '*')
     ORDER BY month`, [req.query.platform || null, trendFleet]);

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
       WHERE platform = coalesce($1, '*') AND fleet_id = coalesce($2, '*')
       ORDER BY month`, [req.query.platform || null, trendFleet]);
  }
  // Said in the response rather than only in a log: a reader deserves to know
  // whether the figures were precomputed or derived on the spot.
  const trendSource = fromRollup ? 'rollup' : 'live';
  /* Months that exist only in the imported ledger — the pre-API history the
     import exists to recover — have no trip rows, so the calendar cannot be
     built from trips alone. The statement months extend it. */
  const stmtSpan = await q(
    `SELECT to_char(min(day), 'YYYY-MM') a, to_char(max(day), 'YYYY-MM') b
     FROM driver_statement_day WHERE source <> 'ledger' AND ($1::text IS NULL OR platform = $1)
       AND ($2::text IS NULL OR fleet_id = $2)`,
    [req.query.platform || null, trendFleet]);
  if (!observed.length && !stmtSpan[0]?.a) {
    return res.json({ months: [], breaks: [], gaps: [], source: trendSource });
  }

  /* A month with no rows is ambiguous: the fleet may have stood still, or we
     may simply hold no data for it. Treating the two the same produced a
     headline "-82%, drivers 102 → 0" for a stretch where nothing had been
     collected at all. Fill the calendar so the gap is visible as a gap. */
  /* isoDay, not toISOString: `month` is DATE (sql/schema_v21.sql:26) and the
     SHAPE above selects it bare as `month AS m` — no to_char, no cast — so it
     reaches here as a Date at LOCAL midnight. Under TZ=Asia/Dubai the pg DATE
     '2026-03-01' parses to `Sun Mar 01 2026 00:00:00 GMT+0400` and
     .toISOString().slice(0, 7) is "2026-02", so every key in byMonth and both
     bounds of the gap-filler below would shift a month and the calendar would
     be filled between the wrong ends. Latent only because this container runs
     UTC; no test in this suite can catch it, because PGlite parses a DATE at
     UTC midnight where node-postgres parses it at local midnight.

     Spelled out here rather than calling the isoDay above it, and that is not
     an oversight: test/trend_gaps.test.mjs mounts THIS ROUTE ALONE, slicing
     the source from `app.get('/api/trend/monthly'` — so anything declared
     earlier in the file is out of scope and the route answered
     `500 ReferenceError: isoDay is not defined` in that harness while
     production was fine. test/server_day_keys.test.mjs pins this to the same
     answer isoDay gives, so the two cannot drift. */
  const key = (d) => {
    if (typeof d === 'string') return d.slice(0, 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  };
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
     FROM trip_norm WHERE ($1::text IS NULL OR platform=$1)
       AND ($2::text IS NULL OR fleet_id=$2)`, [req.query.platform || null, trendFleet]);
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
       WHERE fleet_id = coalesce($2, '*') AND platform <> '*'
         AND ($1::text IS NULL OR platform = $1)`
    : `SELECT to_char(month, 'YYYY-MM') AS m, platform, bookings, priced_trips, revenue
       FROM (${rollupGrainSql('month')}) g
       WHERE fleet_id = coalesce($2, '*') AND platform <> '*'
         AND ($1::text IS NULL OR platform = $1)`;
  const [platMonths, payMonths, stmtMonths] = await Promise.all([
    q(platMonthSql, [req.query.platform || null, trendFleet]),
    q(`SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS m, platform,
              round(sum(earnings)::numeric, 2) AS payouts,
              count(DISTINCT day)::int AS payout_days
       FROM driver_payout_day
       WHERE ($1::text IS NULL OR platform = $1) AND ($2::text IS NULL OR fleet_id = $2)
       GROUP BY 1, 2`, [req.query.platform || null, trendFleet]),
    /* The statement view per month — the operator's ledger. Rides beside the
       payout, never inside it; see api/income_sql.js. */
    q(`SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS m, platform,
              round(sum(net)::numeric, 2) AS statement_net,
              round(sum(cash)::numeric, 2) AS statement_cash,
              round(sum(bank)::numeric, 2) AS statement_bank
       FROM driver_statement_day
       WHERE source <> 'ledger' AND ($1::text IS NULL OR platform = $1)
         AND ($2::text IS NULL OR fleet_id = $2)
       GROUP BY 1, 2`, [req.query.platform || null, trendFleet]),
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
  /* Fleet, from the vehicle's profile — this route already joins
     vehicle_profile, so narrowing is a predicate rather than a new join. A
     document belongs to a car and a car belongs to a fleet; it is reported BY
     a source ('fms'), which is not a booking channel, so the platform chip is
     deliberately not applied. */
  const vFleet = req.query.fleet || null;
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
       AND ($1::text IS NULL OR coalesce(d.fleet_id, p.fleet_id) = $1)
     ORDER BY d.expires_at ASC LIMIT 300`, [vFleet]);
  const [t] = await q(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE expires_at::date < now()::date)::int expired,
            count(*) FILTER (WHERE expires_at::date >= now()::date
                               AND expires_at::date <= now()::date + 7)::int within_7,
            count(*) FILTER (WHERE expires_at::date > now()::date + 7
                               AND expires_at::date <= now()::date + 45)::int within_45,
            count(DISTINCT plate)::int vehicles,
            count(DISTINCT doc_type)::int doc_types
     FROM vehicle_document
     WHERE expires_at IS NOT NULL AND ($1::text IS NULL OR fleet_id = $1)`, [vFleet]);
  const types = await q(
    `SELECT doc_type, count(*)::int n FROM vehicle_document
     WHERE expires_at IS NOT NULL AND doc_type IS NOT NULL
       AND ($1::text IS NULL OR fleet_id = $1)
     GROUP BY 1 ORDER BY n DESC`, [vFleet]);
  res.json({ rows, totals: t, doc_types: types, fleet: vFleet,
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
/* The same fold driver_lifetime, driver_statement_day.name_key and every
   person-level join in this product use. Written once here because the
   compliance list needs it on both sides of a join and a copy that drifts by a
   btrim is a join that silently matches nothing. */
const CANON_NAME = (col) => `lower(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`;

app.get('/api/compliance/drivers', wrap(async (req, res) => {
  /* The fleet chip reached this page and was dropped. driver_compliance
     records which fleet's credentials collected the row, and on a two-fleet
     operator the compliance list was both fleets under one heading. */
  const fleet = req.query.fleet || null;
  const [mode] = await q(
    /* to_char, not the raw date. node-postgres hands a DATE back as a JS Date,
       and String(thatDate).slice(0, 10) is "Thu Jan 01" — which then fails to
       match the row's own value and reads as a weekday to a human. This is the
       third place in this codebase the same slice has been wrong. */
    `SELECT to_char(licence_expires, 'YYYY-MM-DD') AS licence_expires, count(*)::int n,
            (SELECT count(*)::int FROM driver_compliance WHERE licence_expires IS NOT NULL) AS with_date,
            count(DISTINCT licence_no)::int distinct_numbers
     FROM driver_compliance
     WHERE licence_expires IS NOT NULL AND ($1::text IS NULL OR fleet_id = $1)
     GROUP BY licence_expires ORDER BY n DESC LIMIT 1`, [fleet]);
  // One date on more than half the rows is a default, not a coincidence.
  const share = mode && mode.with_date ? mode.n / mode.with_date : 0;
  const placeholder = share >= 0.5 && mode.n >= 5;
  const ph = placeholder ? mode.licence_expires : null;
  /* The list, ordered so the placeholder rows are not the first thing a reader
     sees. 77 of the live rows carry the identical never-filled-in date, and
     ordering by licence_expires ASC put every one of them at the top of a page
     whose job is to show whose licence lapses next — 77 rows of a data-quality
     artefact above the driver who actually stops working on Thursday. They are
     still here, at the end, flagged, because a licence nobody has entered is
     its own to-do.

     Each row says whether its own date is the placeholder, so the front end
     can render it as "not filled in" rather than as a red EXPIRED pill — the
     toolbar said "77 with an expired licence" while this endpoint's own
     totals said expired: 0. */
  const rows = await q(
    `WITH life AS (
       /* driver_lifetime folded to one row per NAME, so a person holding three
          platform accounts is one answer rather than three. max() for the last
          day and sum() for the count is what "this person's driving" means when
          the accounts belong to one human. */
       SELECT ${CANON_NAME('driver_name')} AS nk,
              max(last_ever) AS last_ever,
              sum(lifetime)::int AS lifetime
         FROM driver_lifetime
        WHERE coalesce(btrim(driver_name), '') <> ''
        GROUP BY 1
     )
     SELECT platform, c.driver_ext_id, full_name, phone, licence_no, licence_expires,
            c.fleet_id,
            (licence_expires - now()::date) AS days_left, state, suspension_reason, rating,
            /* IS THIS PERSON STILL DRIVING?
               ─────────────────────────────────────────────────────────────
               The single most consequential sentence this product prints is
               "licence expired — stand down until renewed", and this list gave
               a reader no way to tell an expiry that matters from one that does
               not. All 132 rows on production read state 'offline' — the hotel
               channel's own word for every account it holds, whether the person
               drove yesterday or has never driven at all — and 243 days past
               expiry on somebody idle since spring is a filing job, while the
               same row on somebody who worked last night is a car to take off
               the road this morning.

               driver_lifetime is the precomputed answer (sql/schema_v29.sql),
               keyed on the SYNTHESISED key — the platform id where there is
               one, the folded name where there is not — so a hotel account is
               matched by its id when the trips carry it and by the person's
               name when they do not. That second branch is the one that
               matters here: this roster's compliance rows are a hotel
               channel's and much of its work is filed under Uber ids. */
            coalesce(li.last_ever, lf.last_ever) AS last_ever,
            coalesce(li.lifetime, lf.lifetime)   AS lifetime_trips,
            (li.driver_ext_id IS NULL AND lf.nk IS NOT NULL) AS activity_by_name,
            (now()::date - (coalesce(li.last_ever, lf.last_ever)
                              AT TIME ZONE 'Asia/Dubai')::date) AS days_since_last_trip,
            ($1::text IS NOT NULL
             AND to_char(licence_expires,'YYYY-MM-DD') = $1) AS licence_placeholder,
            -- A licence expiring in six days is a CAR that stops earning in six
            -- days. The row named the person and left the asset to be worked
            -- out by hand, which is the difference between a list and a plan.
            ${vehicleLatest('c.driver_ext_id')} AS vehicle
     FROM driver_compliance c
     /* Two joins, not one OR'd join: an OR that can match a row keyed by id
        AND a row keyed by name duplicates the compliance row, which on a page
        headed "whose licence lapses next" would list one person twice.

        The id match is exact and wins. The name fold is the fall-back and is
        the branch that matters on this fleet: these compliance rows come from
        the hotel channel and much of the same people's driving is filed under
        Uber ids, so the id never matches for them. Two different people who
        share a name merge — this roster does that — and the page says so
        rather than letting the number imply otherwise. */
     LEFT JOIN driver_lifetime li ON li.driver_ext_id = nullif(btrim(c.driver_ext_id), '')
     LEFT JOIN life lf ON lf.nk = ${CANON_NAME('c.full_name')}
     WHERE ($2::text IS NULL OR c.fleet_id = $2)
     ORDER BY ($1::text IS NOT NULL
               AND to_char(licence_expires,'YYYY-MM-DD') = $1) ASC,
              licence_expires ASC NULLS LAST LIMIT 300`, [ph, fleet]);
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
            count(*) FILTER (WHERE licence_expires IS NOT NULL
                               AND $1::text IS NOT NULL
                               AND to_char(licence_expires,'YYYY-MM-DD') = $1)::int placeholder,
            count(*) FILTER (WHERE licence_expires IS NULL)::int no_date_at_all
     FROM driver_compliance WHERE ($2::text IS NULL OR fleet_id = $2)`, [ph, fleet]);
  res.json({
    drivers: rows,
    totals: t,
    shown: rows.length,
    truncated: (t?.total ?? 0) > rows.length,
    fleet,
    placeholder_date: ph,
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
/* Both of these read winDays(req), which is from/to and nothing else, so the
   platform and fleet chips the Finance page displays did nothing to either.
   #finance?platform=bolt rendered a tips tile and a components tree over a
   channel with no data at all, and &fleet=egari was byte-identical to
   &fleet=ecosine on a two-fleet operator. driver_earnings_component carries
   both columns (sql/schema_v5.sql:65,74); range(req) supplies both binds.

   The containment window (period_start >= $1 AND period_end <= $2) and the
   LIMIT are deliberately untouched here — both belong to the money-model
   work, and changing a predicate and a window in the same commit makes the
   money it moves impossible to attribute to either. */
/* Aggregated to the FLEET, because that is the only thing that reads it.
   ─────────────────────────────────────────────────────────────────────────
   This returned one row per (driver, category) and kept the four hundred
   largest by absolute value. Three things were wrong with that, and they
   compounded:

     - The cap was BINDING. Production returns exactly 400 rows, which is what
       a cap looks like when it is cutting.
     - It cut by |amount| across every driver at once, so a top-level component
       for one driver could survive while its own children were cut, and a
       child of another could survive without its parent.
     - componentTree() in api/public/app.js then sums the roots and prints "the
       N top-level components above net to AED …" — a confident fleet total
       over an arbitrary truncated subset.

   The consumer aggregates by (parent, category) on arrival and throws the
   driver away, so the per-driver rows were never used for anything. Grouping
   here instead makes the answer EXACT and about twenty rows rather than four
   hundred, and removes the need for a cap at all. */
/* Contained by the window, never merely overlapping it — and the difference
   said out loud when it empties the panel.
   ─────────────────────────────────────────────────────────────────────────
   These amounts are reported per PAYOUT PERIOD, a week at a time, and a period
   is only counted when the window holds all of it: counting a period that
   straddles the edge would report part of a week as if it were the whole of
   one. That is right, and on a seven-day range it is also why the panel is
   empty — bin/page-audit.mjs found it empty at 7 days and full at 30 — while
   the page said "no payout breakdown collected yet", which sent a reader to
   the collector for data that was already in the database.

   So when nothing is contained, the endpoint counts what OVERLAPS and names
   the span it holds. The second query runs only on the empty path, where its
   cost buys the only sentence worth printing. */
app.get('/api/earnings/components', wrap(async (req, res) => {
  const p = range(req);
  /* The span rides on the same grouping. One shape in both answers: when the
     rows are there it is the span they came from, and when they are not it is
     the span the record holds — either way it is what a reader needs to know
     which range to ask for. */
    const raw = await q(
    `SELECT category, parent, round(sum(amount)::numeric,2) amount, currency,
            count(DISTINCT driver_ext_id)::int drivers,
            to_char(min(period_start), 'YYYY-MM-DD') AS _from,
            to_char(max(period_end), 'YYYY-MM-DD') AS _to
     FROM driver_earnings_component
     WHERE period_start >= $1 AND period_end <= $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     GROUP BY 1,2,4 ORDER BY abs(sum(amount)) DESC`, p);
  const rows = raw.map(({ _from, _to, ...r }) => r);
  if (rows.length) {
    return res.json({ rows, overlapping: 0,
      first_period: raw.reduce((a, r) => (a && a < r._from ? a : r._from), null),
      last_period: raw.reduce((a, r) => (a && a > r._to ? a : r._to), null) });
  }
  const [ov] = await q(
    `SELECT count(*)::int AS overlapping,
            to_char(min(period_start), 'YYYY-MM-DD') AS first_period,
            to_char(max(period_end), 'YYYY-MM-DD') AS last_period
     FROM driver_earnings_component
     WHERE period_start <= $2 AND period_end >= $1
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`, p);
  return res.json({ rows, overlapping: ov?.overlapping || 0,
    first_period: ov?.first_period || null, last_period: ov?.last_period || null });
}));

// per-driver tip rate — service quality expressed in money
/* Ranked by RATE, which needs a base worth dividing by.
   ─────────────────────────────────────────────────────────────────────────
   The floor was `> 0`, so the top of this table was whoever had the smallest
   fare. Production's rank 1 was {tips: 10.00, fare: 63.49, tip_pct: 15.75},
   above {tips: 30.00, fare: 506.41, 5.92} — under a caption claiming the
   metric "compares a high-volume driver with a low-volume one fairly". One
   generous rider on one AED 63 week is not a service-quality finding.

   AED 300 of net fare is roughly a driver's day, and it is the smallest base
   at which a single tip cannot dominate the ratio: at 300, one AED 10 tip
   moves the rate 3.3 points rather than 15.8. Everybody below it is COUNTED
   and reported as excluded rather than silently dropped — an unranked driver
   is a fact about the window, not an absence. */
app.get('/api/earnings/tips', wrap(async (req, res) => {
  const FARE_FLOOR = 300;
  const p = range(req);
  /* Read from the resolved statement days, not the raw component tree.
     ───────────────────────────────────────────────────────────────────────
     Uber answers on two surfaces with two vocabularies, and both can describe
     the same days — the REST payments feed on short periods, the supplier
     GraphQL breakdown on weeks. Summing components adds the two readings
     together, which inflates the numerator and the denominator of this ratio
     by different amounts. driver_statement_day holds one row per driver-day
     with that collision already resolved (src/rollup.js), so the rate here is
     over days rather than over overlapping report windows, and the window
     predicate is finally the days the reader asked for. */
  const STMT = `FROM driver_statement_day
     WHERE source <> 'ledger' AND NOT pseudo
       AND day BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`;
  const rows = await q(
    `SELECT max(driver_ext_id) driver_ext_id, max(driver_name) driver_name,
            round(sum(tips)::numeric,2) tips,
            round(sum(net)::numeric,2) fare,
            round((sum(tips) / nullif(sum(net),0) * 100)::numeric,2) tip_pct
     ${STMT}
     GROUP BY name_key
     HAVING sum(net) >= $5
     ORDER BY tip_pct DESC NULLS LAST LIMIT 200`, [...p, FARE_FLOOR]);
  const [t] = await q(
    `SELECT count(*)::int ranked,
            count(*) FILTER (WHERE fare < $5)::int excluded
     FROM (SELECT sum(net) fare ${STMT}
            GROUP BY name_key HAVING sum(net) > 0) d`,
    [...p, FARE_FLOOR]);
  /* The FLEET's tips, over every driver and no floor at all.
     ─────────────────────────────────────────────────────────────────────────
     The #finance Tips tile added up the rows of `rows` — a list that is
     ranked, capped at 200 and filtered to drivers with at least AED 300 of
     fare — and printed the sum as the fleet's tips. The floor bites hardest on
     the window the dashboard OPENS on: measured on production 2026-09-02 at
     ?days=2, 60 of the 85 drivers with a statement fall under AED 300 of fare
     in two days, so the tile read AED 68.96 against a real AED 168.09 — 59% of
     the fleet's tips missing from the tile about tips. Over a year the same
     floor removes 0.2%, which is exactly why nobody caught it: the number is
     wrong when the page is opened and right when it is investigated. A
     ranking's total is not a population's total, and the two must be selected
     separately. */
  const [all] = await q(
    `SELECT round(sum(tips)::numeric,2) tips, round(sum(net)::numeric,2) fare,
            count(DISTINCT name_key)::int drivers,
            count(DISTINCT name_key) FILTER (WHERE tips > 0)::int tipped_drivers
     ${STMT}`, p);
  res.json({
    rows,
    /* Not derived from `rows`: see above. `ranked_tips` is what the table
       below the tile adds up to, kept so the page can say why the two differ
       rather than leaving a reader to find the gap. */
    totals: {
      tips: all?.tips ?? null,
      fare: all?.fare ?? null,
      drivers: all?.drivers ?? 0,
      tipped_drivers: all?.tipped_drivers ?? 0,
      ranked_tips: rows.reduce((a, r) => a + Number(r.tips || 0), 0),
    },
    fare_floor: FARE_FLOOR,
    /* Named so the page can say "11 drivers had less than AED 300 of fare in
       this window and are not ranked" rather than showing a short list with no
       explanation for its shortness. */
    excluded_n: t?.excluded ?? 0,
    total: (t?.ranked ?? 0) - (t?.excluded ?? 0),
    shown: rows.length,
    truncated: ((t?.ranked ?? 0) - (t?.excluded ?? 0)) > rows.length,
  });
}));

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
      /* No LIMIT. It was 600, and production returned exactly 600 — a cap that
         has bitten. The rows are (plate, product) pairs: a hundred and forty
         vehicles across six product tiers is under nine hundred at the very
         most, so the cap saved nothing and cost the tail.

         And it cost it in the worst place. api/public/app.js pivots these into
         one row per plate and computes the fleet's concentration sentence —
         "the top N vehicles take X% of the work" — over EVERY plate, not over
         the thirty it lists. Cutting the input made that sentence wrong in the
         direction that flatters the fleet, over a set nobody could see. Same
         defect as /api/earnings/components, which capped a total at four
         hundred rows and printed it as the fleet's. */
      ORDER BY t.plate, trips DESC),
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
  // metric_break records the fleet it was detected for; the fleet chip on
  // #causes was reaching this route and being ignored.
  res.json(await q(
    `SELECT metric, grain, platform, fleet_id, period_from, period_to,
            value_from, value_to, change_pct, drivers_from, drivers_to,
            driver_change_pct, productivity_change_pct, attribution, candidate_events, detected_at
     FROM metric_break
     WHERE ($1::text IS NULL OR platform=$1) AND ($2::text IS NULL OR fleet_id=$2)
     ORDER BY period_to DESC`, [req.query.platform || null, req.query.fleet || null]));
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
  /* Name-matching alone said the opposite of the truth.
     ─────────────────────────────────────────────────────────────────────────
     norm() strips non-alphanumerics and compares against the column list, so
     "Trip request time" can never match requested_at. Thirteen of Uber's
     fifteen fields therefore rendered "RAW ONLY" — Trip UUID, Number plate,
     Driver UUID, Trip distance, Trip request time, Trip drop-off time, Trip
     status, both addresses, Product type — every one of which the collector
     maps. The single most useful column on this page was inverted.

     src/probe.js solved this for its own report with per-surface alias maps
     and its header explains why at length. The maps are now shared rather than
     copied, so the two answers to the same question cannot drift, and the
     Uber trip export's names were added to them. */
  const normKey = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapped = new Set(cols.map(normKey));
  const aliasSets = RAW_ALIASES[table] || {};
  const aliases = new Set(Object.entries(aliasSets)
    .filter(([pl]) => !platform || pl === platform)
    .flatMap(([, m]) => Object.keys(m))
    .map(normKey));
  /* Which alias table answered, so a reader can tell "we map this" from "we
     have a column with that name". A false "unmapped" costs a glance; a false
     "mapped" hides a field for ever, so a key matched only by an alias says
     so. */
  const aliasFor = (k) => {
    for (const [pl, m] of Object.entries(aliasSets)) {
      if (platform && pl !== platform) continue;
      for (const [name, col] of Object.entries(m)) if (normKey(name) === normKey(k)) return col;
    }
    return null;
  };

  res.json({
    table, platform, rows_with_raw: n, sampled: Math.min(sample, n),
    fields: rows.map((r) => ({
      key: r.key,
      fill_pct: r.present ? Math.round((r.filled / r.present) * 100) : 0,
      distinct_values: r.distinct_values,
      examples: r.examples || [],
      already_a_column: mapped.has(normKey(r.key)) || aliases.has(normKey(r.key)),
      // The column it lands in, where a name alone would not have found it.
      mapped_to: mapped.has(normKey(r.key)) ? r.key : aliasFor(r.key),
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

/* ───────────────── unit economics ─────────────────
   The whole fleet as a ranking rather than one entity at a time: what each
   asset and each person earned per day worked, per km and per booking, and
   which of them earned nothing. The attribution that puts Uber's weekly driver
   payout onto a vehicle already existed with a plate bound into it; these are
   the same arithmetic unbound, which is what makes a table sortable.

   Registered here, below the per-driver marker, and not a line above it: that
   comment is the END boundary test/mount.mjs slices server.js at, so a module
   call placed before it lands inside the slice — where the harness mounts route
   modules by discovery and the imported name does not exist. Every test over
   the whole API then dies with ReferenceError before its first assertion. */
economicsRoutes(app, { q, wrap, range });

/* ───────────────── per-vehicle detail pages ───────────────── */
vehicleRoutes(app, { q, wrap, endOfDay });
cohortRoutes(app, { q, wrap });

/* ───────────────── commercial analytics ─────────────────
   Settlement, the corporate channel, product tiers, coverage holes and
   corridors — all built on trip_ext, all registered before the catch-all. */
analyticsRoutes(app, { q, wrap, range, F, FB });
supplyRoutes(app, { q, wrap, range, FB });

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
/* One booking as an address — reached from every trip table in the product. */
tripRoutes(app, { q, wrap });
authRoutes(app, { q, wrap });
exportRoutes(app, { q, wrap, winDays, log });

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
performerRoutes(app, { q, wrap });

/* Two days against each other, cut at the same Dubai minute. The cut is the
   whole reason this is a route and not a subtraction on the client: comparing
   a seven-hour today against a twenty-four-hour yesterday reports a collapse
   every single morning. */
compareRoutes(app, { q, wrap });

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
for (const dir of ['vendor', 'fonts', 'icons']) {
  app.use(`/${dir}`, express.static(join(__dir, 'public', dir), {
    maxAge: YEAR * 1000, immutable: true,
  }));
}
app.use(express.static(join(__dir, 'public'), {
  etag: true,
  setHeaders(res, path) {
    /* The service worker is the one file that must never be served stale.
       ─────────────────────────────────────────────────────────────────
       It decides what every OTHER file is answered from, so a copy cached
       for five minutes keeps a whole deploy out for five minutes, and a copy
       cached by a proxy for longer strands an installed app on an old shell
       with no way for the reader to tell. Browsers now revalidate sw.js on
       every update check by default; saying so here means nothing between
       here and the phone can decide otherwise. */
    if (path.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate');
      res.setHeader('Service-Worker-Allowed', '/');
      return;
    }
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
