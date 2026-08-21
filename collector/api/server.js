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
app.get('/api/trips/daily', wrap(async (req, res) => res.json(await q(
  `SELECT local_day AS d,
          count(*) FILTER (WHERE is_booking)::int trips,
          count(*) FILTER (WHERE outcome = 'completed')::int completed,
          count(*) FILTER (WHERE outcome = 'not_completed')::int cancelled,
          count(*) FILTER (WHERE NOT is_booking)::int telematics_journeys,
          round(sum(distance_km) FILTER (WHERE is_booking AND has_distance)::numeric,0) km,
          round(sum(price) FILTER (WHERE has_fare)::numeric,0) revenue,
          count(*) FILTER (WHERE has_fare)::int priced_trips
   FROM trip_norm WHERE ${F} GROUP BY 1 ORDER BY 1`, range(req)))));

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
     FROM trip_norm WHERE ${dim.col === 'platform' ? F : FB}
     GROUP BY platform, ${dim.col}
     ORDER BY n DESC`, p);

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
          round(100.0*sum((status='completed')::int)/nullif(count(*),0)) completion_pct
   FROM trip_norm WHERE ${F} AND driver_name IS NOT NULL
   GROUP BY driver_name, driver_ext_id, platform ORDER BY trips DESC LIMIT 100`, range(req)))));

// cross-platform view: one row per driver name, columns per platform
app.get('/api/drivers/cross-platform', wrap(async (req, res) => res.json(await q(
  `SELECT driver_name,
          sum((platform='uber')::int)::int uber_trips,
          sum((platform='yango')::int)::int yango_trips,
          sum((platform='bolt')::int)::int bolt_trips,
          sum((platform='fms')::int)::int fms_trips,
          count(*)::int total_trips, round(sum(distance_km)::numeric,0) km,
          round(sum(price)::numeric,0) revenue
   FROM trip_norm WHERE ${F} AND driver_name IS NOT NULL
   GROUP BY driver_name ORDER BY total_trips DESC LIMIT 100`, range(req)))));

app.get('/api/drivers/performance', wrap(async (req, res) => res.json(await q(
  `SELECT platform, driver_name, plate, period_start, period_end, trips, hours_online, hours_on_trip,
          acceptance_rate, cancellation_rate, distance_km, earnings, cash_earnings, rating
   FROM driver_performance WHERE period_start >= $1 AND period_end <= $2
     AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
   ORDER BY period_start DESC, trips DESC NULLS LAST LIMIT 300`, range(req)))));

/* ───────────────────────── vehicles / fleet ───────────────────────── */
app.get('/api/vehicles', wrap(async (req, res) => res.json(await q(
  `SELECT t.plate, count(*)::int trips, round(sum(t.distance_km)::numeric,0) km,
          round(sum(t.price)::numeric,0) revenue, count(distinct t.driver_ext_id)::int drivers,
          count(distinct t.platform)::int platforms, max(t.requested_at) last_trip,
          cd.driver_name AS current_driver, cd.as_of AS driver_as_of
   FROM trip_norm t
   LEFT JOIN vehicle_current_driver cd ON cd.plate = t.plate
   WHERE ${W('t')} AND t.plate IS NOT NULL AND t.plate<>''
   GROUP BY t.plate, cd.driver_name, cd.as_of ORDER BY trips DESC LIMIT 200`, range(req)))));

app.get('/api/live', wrap(async (_, res) => res.json(await q(
  `SELECT s.plate, s.fleet_id, s.source, s.captured_at, s.polled_at, s.lat, s.lng, s.speed, s.status,
          s.seat_occupied, s.fuel_level, s.ac_on, s.odometer,
          (now()-s.polled_at > interval '11 minutes') AS stale,
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
    `SELECT (t.captured_at AT TIME ZONE 'Asia/Dubai')::date AS day,
            t.plate, t.fleet_id, count(*)::int fixes,
            min(t.captured_at) first_fix, max(t.captured_at) last_fix,
            round(max(t.speed)::numeric,0) max_speed,
            sum((t.seat_occupied)::int)::int occupied_fixes,
            cd.driver_name
     FROM telemetry_snapshot t
     LEFT JOIN vehicle_current_driver cd ON cd.plate = t.plate
     WHERE t.lat IS NOT NULL
       AND ($1::text IS NULL OR t.plate = $1)
       AND t.captured_at BETWEEN $2 AND $3
     GROUP BY 1,2,3, cd.driver_name
     HAVING count(*) >= 2
     ORDER BY day DESC, fixes DESC LIMIT 400`,
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
  let cur = null, km = 0, movingKm = 0, occupiedKm = 0;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i], prev = fixes[i - 1];
    const gapMin = prev ? (new Date(f.captured_at) - new Date(prev.captured_at)) / 6e4 : 0;
    const step = prev ? dist(prev, f) : 0;
    if (prev && gapMin <= GAP_MIN && step < 60) {           // 60km in one hop = bad fix
      km += step;
      if ((prev.speed || 0) > 0) movingKm += step;
      if (prev.seat_occupied) occupiedKm += step;
    }
    if (!cur || gapMin > GAP_MIN) { cur = { points: [], occupied: !!f.seat_occupied }; segments.push(cur); }
    cur.points.push({ t: f.captured_at, lat: f.lat, lng: f.lng, speed: f.speed,
                      status: f.status, occupied: !!f.seat_occupied });
  }
  const [drv] = await q(
    `SELECT driver_name, trips FROM vehicle_driver_day
     WHERE plate=$1 AND day=$2 ORDER BY trips DESC LIMIT 1`, [plate, day]);
  res.json({
    plate, day, fixes: fixes.length, segments,
    driver: drv?.driver_name || null, driver_trips: drv?.trips ?? null,
    distance_km: Math.round(km * 10) / 10,
    moving_km: Math.round(movingKm * 10) / 10,
    occupied_km: Math.round(occupiedKm * 10) / 10,
    first_fix: fixes[0]?.captured_at || null,
    last_fix: fixes[fixes.length - 1]?.captured_at || null,
  });
}));

/* ───────────────────────── safety ───────────────────────── */
app.get('/api/alerts/summary', wrap(async (req, res) => res.json(await q(
  `SELECT alert_type, count(*)::int n FROM alert WHERE occurred_at BETWEEN $1 AND $2
   GROUP BY 1 ORDER BY 2 DESC`, [range(req)[0], range(req)[1]]))));

// Harsh-driving is a person's behaviour, not a plate's — name whoever held the car.
app.get('/api/alerts/by-vehicle', wrap(async (req, res) => res.json(await q(
  `SELECT a.plate, cd.driver_name AS current_driver, count(*)::int alerts,
          sum((a.alert_type ILIKE '%brake%')::int)::int harsh_brake,
          sum((a.alert_type ILIKE '%accel%')::int)::int harsh_accel,
          sum((a.alert_type ILIKE '%turn%')::int)::int sharp_turn,
          sum((a.alert_type ILIKE '%speed%')::int)::int overspeed
   FROM alert a
   LEFT JOIN vehicle_current_driver cd ON cd.plate = a.plate
   WHERE a.occurred_at BETWEEN $1 AND $2
   GROUP BY a.plate, cd.driver_name ORDER BY alerts DESC LIMIT 100`,
  [range(req)[0], range(req)[1]]))));

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
   FROM ledger_entry WHERE event_at BETWEEN $1 AND $2 AND ($3::text IS NULL OR platform=$3)
   GROUP BY category, currency ORDER BY abs(sum(amount)) DESC LIMIT 60`,
  [range(req)[0], range(req)[1], range(req)[2]]))));

app.get('/api/finance/daily', wrap(async (req, res) => res.json(await q(
  `SELECT date_trunc('day',event_at)::date d, round(sum(amount)::numeric,2) amount
   FROM ledger_entry WHERE event_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`,
  [range(req)[0], range(req)[1]]))));

/* ───────────────────────── unauthorized trips ───────────────────────── */
// Seat-sensor occupancy that no booking explains. See docs/unauthorized-trips.md.
app.get('/api/unauthorized/summary', wrap(async (req, res) => {
  const [from, to] = range(req);
  const rows = await q(
    `SELECT verdict, count(*)::int n, round(sum(distance_km)::numeric,0) km,
            round(sum(duration_min)::numeric,0) minutes
     FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 GROUP BY verdict ORDER BY n DESC`, [from, to]);
  const [tot] = await q(
    `SELECT count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
            count(*) FILTER (WHERE verdict='authorized')::int authorized,
            count(*) FILTER (WHERE verdict='sensor_suspect')::int sensor_suspect,
            count(*) FILTER (WHERE verdict='partial')::int partial,
            round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,0) unauth_km,
            count(*) FILTER (WHERE verdict='unauthorized' AND low_confidence)::int low_confidence
     FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2`, [from, to]);
  res.json({ byVerdict: rows, totals: tot });
}));

app.get('/api/unauthorized/list', wrap(async (req, res) => {
  const [from, to] = range(req);
  const verdict = req.query.verdict || 'unauthorized';
  res.json(await q(
    `SELECT o.plate, o.fleet_id, o.started_at, o.ended_at, o.duration_min, o.distance_km,
            o.top_speed, o.fixes, o.max_gap_min, o.ignition_ratio, o.verdict,
            o.matched_platform, o.matched_trip_id, o.low_confidence, o.unavailable_sources,
            o.start_lat, o.start_lng, o.end_lat, o.end_lng,
            -- the driver who held the car that day, not whoever has it now
            (SELECT string_agg(DISTINCT v.driver_name, ', ')
               FROM vehicle_driver_day v
              WHERE v.plate = o.plate
                AND v.day = (o.started_at AT TIME ZONE 'Asia/Dubai')::date
                AND v.driver_name IS NOT NULL) AS drivers
     FROM occupancy_segment o WHERE o.started_at BETWEEN $1 AND $2 AND ($3='all' OR o.verdict=$3)
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
       FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2
       GROUP BY plate HAVING count(*) FILTER (WHERE verdict='unauthorized') > 0),
     who AS (
       SELECT o.plate, string_agg(DISTINCT v.driver_name, ', ') AS drivers
       FROM occupancy_segment o
       JOIN vehicle_driver_day v
         ON v.plate = o.plate
        AND v.day = (o.started_at AT TIME ZONE 'Asia/Dubai')::date
       WHERE o.started_at BETWEEN $1 AND $2 AND o.verdict='unauthorized'
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
    `SELECT date_trunc('day',started_at)::date d,
            count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
            count(*) FILTER (WHERE verdict='authorized')::int authorized
     FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [from, to]));
}));

// sensor health per vehicle — dead/stuck pads make leakage numbers unreliable
app.get('/api/sensor-health', wrap(async (req, res) => {
  const [from, to] = range(req);
  res.json(await q(
    `SELECT t.plate,
            count(*) FILTER (WHERE t.seat_occupied)::int occupied_fixes,
            count(*)::int total_fixes,
            max(o.suspect)::int sensor_suspect_segments
     FROM telemetry_snapshot t
     LEFT JOIN (SELECT plate, count(*) FILTER (WHERE verdict='sensor_suspect') suspect
                FROM occupancy_segment GROUP BY plate) o ON o.plate=t.plate
     WHERE t.source='cabman' AND t.captured_at BETWEEN $1 AND $2
     GROUP BY t.plate ORDER BY occupied_fixes ASC LIMIT 100`, [from, to]));
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
app.post('/api/settings/trigger', requireAdmin, wrap(async (req, res) => {
  // An allowlist, not a pass-through: the value is written to source_state and
  // read back by the collector as an instruction.
  const mode = ['backfill', 'analyst', 'probe'].includes(req.body?.mode) ? req.body.mode : 'incremental';
  await pool.query(
    `INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ('collector','-','trigger',$1, now())
     ON CONFLICT (source, fleet_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [mode]);
  res.json({ ok: true, queued: mode });
}));

/* ───────────────────────── static dashboard ───────────────────────── */


/* ───────────────────────── actionable insights ───────────────────────── */
app.get('/api/insights', wrap(async (req, res) => {
  const sev = req.query.severity || null;
  const cat = req.query.category || null;
  res.json(await q(
    `SELECT code, severity, category, entity_type, entity_id, title, detail, action,
            impact_aed, metric, fleet_id, window_start, window_end, computed_at
     FROM insight
     WHERE ($1::text IS NULL OR severity=$1) AND ($2::text IS NULL OR category=$2)
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
              impact_aed DESC NULLS LAST, computed_at DESC
     LIMIT 200`, [sev, cat]));
}));

app.get('/api/insights/summary', wrap(async (_, res) => {
  const bySev = await q(`SELECT severity, count(*)::int n, round(sum(impact_aed)::numeric,0) impact FROM insight GROUP BY 1`);
  const byCat = await q(`SELECT category, count(*)::int n, round(sum(impact_aed)::numeric,0) impact FROM insight GROUP BY 1 ORDER BY 2 DESC`);
  const [tot] = await q(`SELECT count(*)::int n, round(sum(impact_aed)::numeric,0) total_impact FROM insight`);
  res.json({ total: tot, by_severity: bySev, by_category: byCat });
}));

// monthly trend + automatic structural-break detection (what changed, and when)
app.get('/api/trend/monthly', wrap(async (req, res) => {
  const observed = await q(
    `SELECT date_trunc('month', requested_at)::date AS m,
            count(*)::int trips,
            count(distinct driver_ext_id)::int drivers,
            count(*) FILTER (WHERE driver_ext_id IS NOT NULL)::int attributed_trips,
            count(distinct plate)::int vehicles,
            round(sum(distance_km)::numeric,0) km,
            round(sum(price)::numeric,0) revenue,
            round(100.0*sum((status ILIKE '%cancel%')::int)/nullif(count(*),0),1) cancel_pct,
            array_agg(DISTINCT platform) platforms
     FROM trip WHERE ($1::text IS NULL OR platform=$1)
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
      : { m: k, trips: 0, drivers: null, vehicles: 0, km: null, revenue: null,
          cancel_pct: null, platforms: [], no_data: true, drivers_known: false });
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
      // A swing that coincides with a platform appearing or disappearing is a
      // change in what we collect, not necessarily in what the fleet did.
      platform_shift: JSON.stringify([...(a.platforms || [])].sort()) !== JSON.stringify([...(b.platforms || [])].sort())
        ? { from: a.platforms, to: b.platforms } : null,
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
app.get('/api/compliance/vehicles', wrap(async (req, res) => res.json(await q(
  `SELECT d.plate, d.doc_type, d.status, d.expires_at,
          (d.expires_at::date - now()::date) AS days_left,
          p.make, p.model, p.year, p.vin, p.image_url, cd.driver_name
   FROM vehicle_document d
   LEFT JOIN vehicle_profile p ON p.platform=d.platform AND p.vehicle_ext_id=d.vehicle_ext_id
   LEFT JOIN vehicle_current_driver cd ON cd.plate = d.plate
   WHERE d.expires_at IS NOT NULL
   ORDER BY d.expires_at ASC LIMIT 300`))));

app.get('/api/compliance/drivers', wrap(async (_, res) => res.json(await q(
  `SELECT platform, driver_ext_id, full_name, phone, licence_no, licence_expires,
          (licence_expires - now()::date) AS days_left, state, suspension_reason, rating
   FROM driver_compliance ORDER BY licence_expires ASC NULLS LAST LIMIT 300`))));

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
       WHERE raw IS NOT NULL AND ($1::text IS NULL OR platform = $1)
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
     WHERE raw IS NOT NULL AND ($1::text IS NULL OR platform = $1) AND ${tcol} BETWEEN $2 AND $3`,
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
     WHERE raw ? $2 AND ($1::text IS NULL OR platform = $1) AND ${tcol} BETWEEN $3 AND $4
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
