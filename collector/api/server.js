// Read/settings API + static dashboard host.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, migrate } from '../src/db.js';
import { describeSettings, setSetting, deleteSetting, loadSettings } from '../src/settings.js';
import { log } from '../src/log.js';
import { driverRoutes } from './driver_routes.js';
import { vehicleRoutes } from './vehicle_routes.js';
import { analyticsRoutes, analystRoutes } from './analytics_routes.js';
import { rosterRoutes } from './roster_routes.js';
import { dayRoutes } from './day_routes.js';
import { segmentRoutes, slotRoutes } from './segment_routes.js';
import { probeRoutes } from './probe.js';

process.on('unhandledRejection', (e) => log.error('api', 'unhandledRejection', { err: String(e) }));

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));

const q = (text, params) => pool.query(text, params).then((r) => r.rows);
/* A 500 body used to carry the driver's own message, which names the storage
   engine, the column and the type ("invalid input syntax for type timestamp
   with time zone"). The full error is logged; the caller gets a reference to
   quote. The real fix for this class of bug is test/route_smoke.test.mjs,
   which executes every route rather than grepping for it. */
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
  let from = asDate(req.query.from, '2000-01-01');
  let to = asDate(req.query.to, '2100-01-01');
  if (from > to) [from, to] = [to, from];      // an inverted range is a typo, not an empty set
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
const CANON = (col) => `regexp_replace(
    btrim(regexp_replace(lower(${col}), '\\s+', ' ', 'g')),
    '(\\m\\w+)( \\1)+', '\\1', 'g')`;
// Bookings only. A telematics row is a GPS-derived journey, and the same
// physical trip is recorded by BOTH the ride platform and the tracker — summing
// them counts it twice. See sql/schema_v7.sql.
const FB = `${F} AND is_booking`;

/* Liveness: the process is up and the event loop is turning. Nothing more —
   a liveness probe that touches the database restarts a healthy container
   every time the database hiccups. */
app.get('/api/health', (_, res) => res.json({ ok: true }));

/* Readiness: can this instance actually answer? A green health check in front
   of a missing view is worse than a red one, because it routes users to it. */
app.get('/api/ready', wrap(async (_, res) => {
  const need = ['trip_norm', 'trip_ext', 'source_day_coverage'];
  try {
    const [row] = await q(
      `SELECT ${need.map((v, i) => `to_regclass('${v}') IS NOT NULL AS v${i}`).join(', ')}`);
    const missing = need.filter((_, i) => !row[`v${i}`]);
    if (missing.length) {
      return res.status(503).json({ ready: false, reason: 'schema incomplete', missing });
    }
    res.json({ ready: true, views: need });
  } catch (e) {
    res.status(503).json({ ready: false, reason: 'database unreachable' });
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
       count(*) FILTER (WHERE is_booking)::int trips,
       count(*) FILTER (WHERE outcome = 'completed')::int completed_trips,
       count(*) FILTER (WHERE outcome = 'not_completed')::int cancelled_trips,
       count(*) FILTER (WHERE outcome IS NOT NULL)::int bookable_trips,
       round(100.0*count(*) FILTER (WHERE outcome = 'completed')
             / nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) completion_pct,
       round(100.0*count(*) FILTER (WHERE outcome = 'not_completed')
             / nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) cancel_pct,

       -- telematics, reported separately: this is movement, not demand
       count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
       round(sum(distance_km) FILTER (WHERE NOT is_booking AND has_distance)::numeric,0) telematics_km,

       -- distance over bookings only, and only where it is plausible
       round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
       round(avg(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,2) avg_km,
       count(*) FILTER (WHERE is_booking AND has_distance)::int trips_with_distance,

       -- money, and the rows it actually covers
       round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
       count(*) FILTER (WHERE has_fare)::int priced_trips,
       round(avg(price) FILTER (WHERE has_fare)::numeric,2) avg_fare,
       round(sum(distance_km) FILTER (WHERE has_fare AND has_distance)::numeric,0) priced_km,
       round((sum(price) FILTER (WHERE has_fare AND has_distance)
              / nullif(sum(distance_km) FILTER (WHERE has_fare AND has_distance),0))::numeric,2) revenue_per_km,

       -- who and what
       count(DISTINCT driver_ext_id)::int drivers,
       count(*) FILTER (WHERE driver_ext_id IS NOT NULL)::int attributed_trips,
       count(DISTINCT plate) FILTER (WHERE plate IS NOT NULL AND plate <> '')::int vehicles,
       count(DISTINCT platform) FILTER (WHERE is_booking)::int platforms
     FROM trip_norm WHERE ${F}`, p);

  const [v] = await q(`SELECT count(*)::int live_vehicles,
      count(*) FILTER (WHERE now()-polled_at < interval '11 minutes')::int fresh
      FROM (SELECT DISTINCT ON (plate) plate, polled_at FROM telemetry_snapshot ORDER BY plate, polled_at DESC) s`);
  // Alerts take the same fleet filter as the trips beside them; without it a
  // single-fleet view showed one fleet's trips next to both fleets' alerts.
  const [a] = await q(
    `SELECT count(*)::int alerts FROM alert
     WHERE (occurred_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
       AND ($3::text IS NULL OR fleet_id = $3)`, [p[0], p[1], p[3]]);

  const share = (n, d) => (d ? +((n / d) * 100).toFixed(1) : null);
  res.json({
    ...t, ...v, ...a,
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
  const rows = await q(
    `WITH cal AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d),
     agg AS (
       SELECT local_day AS d,
              count(*) FILTER (WHERE is_booking)::int trips,
              count(*) FILTER (WHERE outcome = 'completed')::int completed,
              count(*) FILTER (WHERE outcome = 'not_completed')::int cancelled,
              count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
              round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
              round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
              count(*) FILTER (WHERE has_fare)::int priced_trips,
              count(DISTINCT driver_name) FILTER (WHERE driver_name IS NOT NULL)::int drivers
       FROM trip_norm WHERE ${F} GROUP BY 1
     ),
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
app.get('/api/drivers/leaderboard', wrap(async (req, res) => res.json(await q(
  `SELECT driver_name, driver_ext_id, platform, max(plate) plate, count(*)::int trips,
          round(sum(distance_km)::numeric,0) km, round(avg(distance_km)::numeric,1) avg_km,
          round(sum(price)::numeric,0) revenue,
          -- Testing status = 'completed' scored every completed Bolt trip as a
          -- failure (Bolt says 'finished'), and FMS telematics rows, which
          -- hardcode 'completed' and cannot be cancelled at all, padded the
          -- denominator. outcome is NULL on telematics, so FILTER drops them
          -- from both sides rather than counting them as successes.
          round(100.0*count(*) FILTER (WHERE outcome='completed')
                /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0)) completion_pct,
          count(*) FILTER (WHERE outcome IS NOT NULL)::int outcome_n
   FROM trip_norm WHERE ${F} AND driver_name IS NOT NULL
   GROUP BY driver_name, driver_ext_id, platform ORDER BY trips DESC LIMIT 100`, range(req)))));

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
    `count(*) FILTER (WHERE platform = ${quote(pl)})::int "${pl}_trips"`).join(',\n          ');
  const rows = await q(
    `SELECT ${CANON('driver_name')} AS person, max(driver_name) driver_name,
            ${cols}${cols ? ',' : ''}
            count(*) FILTER (WHERE is_booking)::int booking_trips,
            count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
            count(*)::int total_trips,
            count(DISTINCT platform)::int platform_count,
            count(DISTINCT driver_ext_id)::int accounts,
            -- Any one of the person's platform ids. /api/driver/* resolves an
            -- id to the whole folded person, so one is enough to make the name
            -- a link; without it the row named somebody you could not open.
            (array_agg(DISTINCT driver_ext_id) FILTER (WHERE driver_ext_id IS NOT NULL))[1] AS driver_ext_id,
            round(sum(distance_km) FILTER (WHERE has_distance)::numeric,0) km,
            round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
            count(*) FILTER (WHERE has_fare)::int priced_trips
     FROM trip_norm WHERE ${F} AND coalesce(btrim(driver_name), '') <> ''
     GROUP BY 1 ORDER BY total_trips DESC LIMIT 150`, p);
  res.json({ platforms, drivers: rows,
    multi_platform: rows.filter((r) => r.platform_count > 1).length,
    note: 'One row per person: platform accounts are folded by name, and the columns cover every '
      + 'platform with data in this window, so the total is the sum of what is shown.' });
}));

app.get('/api/drivers/performance', wrap(async (req, res) => res.json(await q(
  `SELECT platform, driver_name, driver_ext_id, plate, period_start, period_end, trips,
          hours_online, hours_on_trip,
          acceptance_rate, cancellation_rate, distance_km, earnings, cash_earnings, rating
   FROM driver_performance WHERE period_start >= $1 AND period_end <= $2
     AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
   ORDER BY period_start DESC, trips DESC NULLS LAST LIMIT 300`, range(req)))));

/* ───────────────────────── vehicles / fleet ───────────────────────── */
app.get('/api/vehicles', wrap(async (req, res) => res.json(await q(
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
          count(distinct t.driver_ext_id)::int drivers,
          count(distinct t.platform)::int platforms, max(t.requested_at) last_trip,
          cd.driver_name AS current_driver, cd.as_of AS driver_as_of
   FROM trip_norm t
   LEFT JOIN vehicle_current_driver cd ON cd.plate = t.plate
   WHERE ${W('t')} AND t.plate IS NOT NULL AND t.plate<>''
   GROUP BY t.plate, cd.driver_name, cd.as_of
   ORDER BY trips DESC, telematics_journeys DESC LIMIT 200`, range(req)))));

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
    [req.query.plate.toUpperCase().replace(/[\s-]+/g, ''), req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01')]));
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
     req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01')]));
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
    `SELECT driver_name, trips FROM vehicle_driver_day
     WHERE plate=$1 AND day=$2 ORDER BY trips DESC LIMIT 1`, [plate, day]);
  res.json({
    plate, day, fixes: fixes.length, segments,
    driver: drv?.driver_name || null, driver_trips: drv?.trips ?? null,
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
       SELECT DISTINCT ON (plate, day) plate, day, driver_name, driver_ext_id
       FROM vehicle_driver_day
       WHERE day BETWEEN $1::date AND $2::date AND driver_name IS NOT NULL
       ORDER BY plate, day, trips DESC NULLS LAST, driver_name
     ),
     /* Distance driven by that PERSON on those days, so a rate can be computed
        over bookings rather than over bookings plus their telematics twins.

        Grouped on the folded name, not the raw one. Grouping on the raw string
        split one human across their platform spellings and gave the rate a
        denominator covering only one of their accounts — 240 km for somebody
        who drove 340. This is the same fold the driver directory uses. */
     km AS (
       SELECT ${CANON('driver_name')} AS person, sum(distance_km) AS km
       FROM trip_norm
       WHERE local_day BETWEEN $1::date AND $2::date AND is_booking AND has_distance
         AND coalesce(btrim(driver_name), '') <> ''
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
            round(max(km.km)::numeric, 0) AS booked_km,
            round((count(*) * 100.0 / nullif(max(km.km), 0))::numeric, 2) AS per_100km
     FROM ev
     LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day
     LEFT JOIN km ON km.person = ${CANON('c.driver_name')}
     GROUP BY 1 ORDER BY alerts DESC LIMIT 100`, [from, to]);
  /* Named drivers, counted over the whole window rather than over the returned
     rows, and counted the way the list groups: by custody name, excluding the
     "(unattributed)" bucket, which is not a person. */
  const [t] = await q(
    `WITH ev AS (
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
     FROM ev LEFT JOIN custody c ON c.plate = ev.plate AND c.day = ev.day`, [from, to]);
  res.json({ rows, totals: t, shown: rows.length,
    truncated: (t?.drivers ?? 0) > rows.filter((r) => r.driver_name !== '(unattributed)').length });
}));

// Who was driving this plate, day by day (handovers included).
app.get('/api/vehicle/drivers', wrap(async (req, res) => {
  if (!req.query.plate) return res.status(400).json({ error: 'plate required' });
  const plate = req.query.plate.toUpperCase().replace(/[\s-]+/g, '');
  res.json(await q(
    `SELECT day, driver_ext_id, driver_name, platform, trips, km, revenue,
            first_trip_at, last_trip_at, is_primary
     FROM vehicle_driver_day
     WHERE plate = $1 AND day BETWEEN $2 AND $3
     ORDER BY day DESC, trips DESC`,
    [plate, req.query.from || '2000-01-01', req.query.to || '2100-01-01']));
}));

// The mirror view: which vehicles has this driver used?
app.get('/api/driver/vehicles', wrap(async (req, res) => {
  if (!req.query.driver_id) return res.status(400).json({ error: 'driver_id required' });
  res.json(await q(
    `SELECT plate, count(*)::int days, sum(trips)::int trips, round(sum(km)::numeric,0) km,
            min(day) first_day, max(day) last_day
     FROM vehicle_driver_day WHERE driver_ext_id = $1
     GROUP BY plate ORDER BY days DESC`, [req.query.driver_id]));
}));

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
            count(*) FILTER (WHERE low_confidence)::int needs_a_human
     FROM occupancy_segment WHERE ${DAYWIN('started_at')}`, [from, to]);
  const byVerdict = Object.fromEntries(rows.map((r) => [r.verdict, r.n]));
  res.json({
    byVerdict: rows,
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
            -- the driver who held the car that day, not whoever has it now
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
  res.json(await q(
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
     ORDER BY seg.unauthorized DESC LIMIT 100`, [from, to]));
}));

// daily trend of unauthorized vs authorized occupancy
app.get('/api/unauthorized/daily', wrap(async (req, res) => {
  const [from, to] = range(req);
  res.json(await q(
    /* Dubai-local, like every other daily grouping in this product. Bucketing
       by UTC day put segments between midnight and 04:00 on the previous day,
       while the drill that opened from a bar filtered by Dubai day — so a bar
       could open onto an empty list. */
    `SELECT (started_at AT TIME ZONE 'Asia/Dubai')::date AS d,
            count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
            count(*) FILTER (WHERE verdict='authorized')::int authorized,
            count(*) FILTER (WHERE verdict IN ('unverifiable','pending'))::int needs_a_human,
            count(*)::int segments
     FROM occupancy_segment WHERE ${DAYWIN('started_at')} GROUP BY 1 ORDER BY 1`, [from, to]));
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

app.get('/api/coverage', wrap(async (_, res) => res.json({
  trips: await q(`SELECT platform, count(*)::int n, min(requested_at) from_ts, max(requested_at) to_ts FROM trip GROUP BY 1`),
  telemetry: await q(`SELECT source, count(*)::int n, max(polled_at) last_poll FROM telemetry_snapshot GROUP BY 1`),
  alerts: await q(`SELECT count(*)::int n, max(occurred_at) latest FROM alert`),
  ledger: await q(`SELECT count(*)::int n, max(event_at) latest FROM ledger_entry`),
}) ));

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
app.post('/api/settings/trigger', requireAdmin, wrap(async (req, res) => {
  const mode = JOB_MODES.includes(req.body?.mode) ? req.body.mode : 'incremental';
  const [existing] = await q(
    `SELECT id, status, requested_at FROM collector_job
     WHERE mode = $1 AND status IN ('queued', 'running') ORDER BY requested_at LIMIT 1`, [mode]);
  if (existing) {
    return res.status(409).json({
      ok: false, mode, already: existing.status, job_id: existing.id,
      requested_at: existing.requested_at,
      detail: `a ${mode} is already ${existing.status}; queuing another would do the same work twice`,
    });
  }
  const [job] = await q(
    `INSERT INTO collector_job (mode, requested_by) VALUES ($1, $2)
     RETURNING id, mode, status, requested_at`,
    [mode, (req.get('x-admin-token') ? 'admin' : 'unauthenticated')]);
  res.json({ ok: true, queued: mode, job_id: job.id, job });
}));

/* What has been asked for, what is running, and what happened to it. A queue
   nobody can see is a queue nobody can trust. */
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
  const observed = await q(
    `SELECT local_month AS m,
            count(*) FILTER (WHERE is_booking)::int trips,
            count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
            count(distinct driver_ext_id)::int drivers,
            count(*) FILTER (WHERE driver_ext_id IS NOT NULL AND is_booking)::int attributed_trips,
            count(distinct plate)::int vehicles,
            count(distinct plate) FILTER (WHERE is_booking)::int earning_vehicles,
            round(sum(distance_km) FILTER (WHERE has_distance AND is_booking)::numeric,0) km,
            count(*) FILTER (WHERE has_distance AND is_booking)::int measured_trips,
            round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
            count(*) FILTER (WHERE has_fare)::int priced_trips,
            round(100.0*count(*) FILTER (WHERE outcome='not_completed')
                  /nullif(count(*) FILTER (WHERE outcome IS NOT NULL),0),1) cancel_pct,
            array_agg(DISTINCT platform) platforms,
            array_agg(DISTINCT platform) FILTER (WHERE is_booking) AS booking_platforms
     FROM trip_norm WHERE ($1::text IS NULL OR platform=$1)
     GROUP BY 1 ORDER BY 1`, [req.query.platform || null]);
  if (!observed.length) return res.json({ months: [], breaks: [], gaps: [] });

  /* A month with no rows is ambiguous: the fleet may have stood still, or we
     may simply hold no data for it. Treating the two the same produced a
     headline "-82%, drivers 102 → 0" for a stretch where nothing had been
     collected at all. Fill the calendar so the gap is visible as a gap. */
  const key = (d) => new Date(d).toISOString().slice(0, 7);
  const byMonth = new Map(observed.map((r) => [key(r.m), r]));
  const first = new Date(observed[0].m), last = new Date(observed[observed.length - 1].m);
  const months = [];
  for (const d = new Date(first); d <= last; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const k = key(d);
    const row = byMonth.get(k);
    months.push(row
      ? { ...row, m: k, no_data: false,
          // FMS-derived trips carry no driver id, so "0 drivers" on a month
          // that has trips means unattributable, not idle.
          drivers_known: row.attributed_trips > 0 }
      : { m: k, trips: 0, telematics_journeys: 0, drivers: null, vehicles: 0,
          earning_vehicles: 0, km: null, measured_trips: 0, revenue: null, priced_trips: 0,
          cancel_pct: null, platforms: [], booking_platforms: [],
          no_data: true, drivers_known: false });
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

  res.json({ months, breaks, gaps });
}));

// external context joined to the day (weather + calendar) for causality overlays
app.get('/api/context', wrap(async (req, res) => {
  const [from, to] = [req.query.from || '2000-01-01', req.query.to || '2100-01-01'];
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
    `SELECT platform, driver_ext_id, full_name, phone, licence_no, licence_expires,
            (licence_expires - now()::date) AS days_left, state, suspension_reason, rating
     FROM driver_compliance ORDER BY licence_expires ASC NULLS LAST LIMIT 300`);
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

app.get('/api/recommendations', wrap(async (_, res) => res.json(await q(
  `SELECT platform, rec_type, period_start, period_end, org_value, target_value,
          flagged_count, flagged, updated_at
   FROM platform_recommendation ORDER BY period_end DESC NULLS LAST LIMIT 30`))));

// earnings components — tips are the interesting one; they never appear in the trip feed
app.get('/api/earnings/components', wrap(async (req, res) => res.json(await q(
  `SELECT driver_ext_id, driver_name, category, parent,
          round(sum(amount)::numeric,2) amount, currency
   FROM driver_earnings_component
   WHERE period_start >= $1 AND period_end <= $2
   GROUP BY 1,2,3,4,6 ORDER BY abs(sum(amount)) DESC LIMIT 400`,
  [req.query.from || '2000-01-01', req.query.to || '2100-01-01']))));

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
  [req.query.from || '2000-01-01', req.query.to || '2100-01-01']))));

// product-tier economics: which assets serve which tier
app.get('/api/product/by-vehicle', wrap(async (req, res) => res.json(await q(
  `SELECT plate, product, count(*)::int trips, round(sum(distance_km)::numeric,0) km,
          round(avg(distance_km)::numeric,1) avg_km
   FROM trip_norm WHERE ${F} AND plate IS NOT NULL AND product IS NOT NULL
   GROUP BY plate, product ORDER BY plate, trips DESC LIMIT 600`, range(req)))));

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
  const [from, to] = [req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01')];
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
  const [from, to] = [req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01')];

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
     req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01')]));
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

/* ───────────────── live provider probes ─────────────────
   Read-only, allowlisted, shape-only. The question these answer — "does this
   provider expose something we are not collecting?" — cannot be settled from
   the columns we happen to have chosen. */
probeRoutes(app, { wrap });

// Static dashboard LAST: app.get('*') would otherwise shadow any API route
// registered after it (this silently broke /api/insights once already).
app.use(express.static(join(__dir, 'public'), { maxAge: '5m' }));
app.get('*', (_, res) => res.sendFile(join(__dir, 'public', 'index.html')));

const port = process.env.PORT || 8080;
/* Fail closed. This used to `.catch(log).finally(listen)`, which served traffic
   on a half-built schema behind a health check that returned ok unconditionally
   — so a failed schema_v7 meant `trip_norm` did not exist and eleven endpoints
   500'd while the platform reported the app healthy and routed users to it. */
migrate()
  .then(() => app.listen(port, () => log.info('api', `listening on :${port}`)))
  .catch((e) => { log.error('api', 'migrate failed — refusing to serve', { err: String(e) }); process.exit(1); });
