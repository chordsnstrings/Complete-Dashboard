// Read/settings API + static dashboard host.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, migrate } from '../src/db.js';
import { describeSettings, setSetting, deleteSetting, loadSettings } from '../src/settings.js';
import { log } from '../src/log.js';

process.on('unhandledRejection', (e) => log.error('api', 'unhandledRejection', { err: String(e) }));

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '256kb' }));

const q = (text, params) => pool.query(text, params).then((r) => r.rows);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  log.error('api', req.path, { err: String(e) });
  res.status(500).json({ error: 'internal', detail: String(e).slice(0, 200) });
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

// filters: ?from=&to=&platform=&fleet=
// A bare `to=YYYY-MM-DD` parses as midnight, which silently drops that day's trips.
// Extend a date-only bound to the end of the day so ranges are inclusive as users expect.
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
const range = (req) => [req.query.from || '2000-01-01', endOfDay(req.query.to || '2100-01-01'),
  req.query.platform || null, req.query.fleet || null];
const F = `requested_at BETWEEN $1 AND $2 AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`;

app.get('/api/health', (_, res) => res.json({ ok: true }));

/* ───────────────────────── overview ───────────────────────── */
app.get('/api/kpis', wrap(async (req, res) => {
  const p = range(req);
  const [t] = await q(
    `SELECT count(*)::int trips, round(sum(distance_km)::numeric,0) km,
            round(avg(distance_km)::numeric,2) avg_km,
            round(100.0*sum((status='completed')::int)/nullif(count(*),0),1) completion_pct,
            round(100.0*sum((status ILIKE '%cancel%')::int)/nullif(count(*),0),1) cancel_pct,
            count(distinct driver_ext_id)::int drivers, count(distinct plate)::int vehicles,
            round(sum(price)::numeric,0) revenue
     FROM trip WHERE ${F}`, p);
  const [v] = await q(`SELECT count(*)::int live_vehicles,
      sum((now()-polled_at < interval '11 minutes')::int)::int fresh
      FROM (SELECT DISTINCT ON (plate) plate, polled_at FROM telemetry_snapshot ORDER BY plate, polled_at DESC) s`);
  const [a] = await q(`SELECT count(*)::int alerts FROM alert WHERE occurred_at BETWEEN $1 AND $2`, [p[0], p[1]]);
  res.json({ ...t, ...v, ...a });
}));

app.get('/api/trips/daily', wrap(async (req, res) => res.json(await q(
  `SELECT date_trunc('day',requested_at)::date d, count(*)::int trips,
          round(sum(distance_km)::numeric,0) km, round(sum(price)::numeric,0) revenue
   FROM trip WHERE ${F} GROUP BY 1 ORDER BY 1`, range(req)))));

app.get('/api/trips/hourly', wrap(async (req, res) => res.json(await q(
  `SELECT extract(hour from requested_at)::int h, count(*)::int trips
   FROM trip WHERE ${F} GROUP BY 1 ORDER BY 1`, range(req)))));

// day-of-week × hour heatmap
app.get('/api/trips/heatmap', wrap(async (req, res) => res.json(await q(
  `SELECT extract(dow from requested_at)::int dow, extract(hour from requested_at)::int h, count(*)::int trips
   FROM trip WHERE ${F} GROUP BY 1,2 ORDER BY 1,2`, range(req)))));

app.get('/api/mix', wrap(async (req, res) => {
  const dim = { payment: 'payment_type', status: 'status', platform: 'platform', fleet: 'fleet_id' }[req.query.by] || 'product';
  res.json(await q(`SELECT coalesce(${dim},'unknown') label, count(*)::int n,
      round(sum(price)::numeric,0) revenue FROM trip WHERE ${F} GROUP BY 1 ORDER BY 2 DESC`, range(req)));
}));

/* ───────────────────────── drivers ───────────────────────── */
app.get('/api/drivers/leaderboard', wrap(async (req, res) => res.json(await q(
  `SELECT driver_name, driver_ext_id, platform, max(plate) plate, count(*)::int trips,
          round(sum(distance_km)::numeric,0) km, round(avg(distance_km)::numeric,1) avg_km,
          round(sum(price)::numeric,0) revenue,
          round(100.0*sum((status='completed')::int)/nullif(count(*),0)) completion_pct
   FROM trip WHERE ${F} AND driver_name IS NOT NULL
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
   FROM trip WHERE ${F} AND driver_name IS NOT NULL
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
   FROM trip t
   LEFT JOIN vehicle_current_driver cd ON cd.plate = upper(replace(t.plate,' ',''))
   WHERE ${F} AND t.plate IS NOT NULL AND t.plate<>''
   GROUP BY t.plate, cd.driver_name, cd.as_of ORDER BY trips DESC LIMIT 200`, range(req)))));

app.get('/api/live', wrap(async (_, res) => res.json(await q(
  `SELECT s.plate, s.fleet_id, s.source, s.captured_at, s.polled_at, s.lat, s.lng, s.speed, s.status,
          s.seat_occupied, s.fuel_level, s.ac_on, s.odometer,
          (now()-s.polled_at > interval '11 minutes') AS stale,
          cd.driver_name AS current_driver, cd.as_of AS driver_as_of
   FROM (SELECT DISTINCT ON (plate) * FROM telemetry_snapshot ORDER BY plate, polled_at DESC) s
   LEFT JOIN vehicle_current_driver cd ON cd.plate = s.plate
   ORDER BY s.plate`))));

app.get('/api/track', wrap(async (req, res) => {
  if (!req.query.plate) return res.status(400).json({ error: 'plate required' });
  res.json(await q(
    `SELECT captured_at, lat, lng, speed, status, seat_occupied FROM telemetry_snapshot
     WHERE plate=$1 AND captured_at BETWEEN $2 AND $3 ORDER BY captured_at`,
    [req.query.plate.toUpperCase().replace(/[\s-]+/g, ''), req.query.from || '2000-01-01', req.query.to || '2100-01-01']));
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
    `SELECT plate, fleet_id, started_at, ended_at, duration_min, distance_km, top_speed, fixes,
            max_gap_min, ignition_ratio, verdict, matched_platform, matched_trip_id,
            low_confidence, unavailable_sources, start_lat, start_lng, end_lat, end_lng
     FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2 AND ($3='all' OR verdict=$3)
     ORDER BY started_at DESC LIMIT 300`, [from, to, verdict]));
}));

app.get('/api/unauthorized/by-vehicle', wrap(async (req, res) => {
  const [from, to] = range(req);
  res.json(await q(
    `SELECT plate,
            count(*) FILTER (WHERE verdict='unauthorized')::int unauthorized,
            count(*) FILTER (WHERE verdict='authorized')::int authorized,
            count(*) FILTER (WHERE verdict='sensor_suspect')::int sensor_suspect,
            round(sum(distance_km) FILTER (WHERE verdict='unauthorized')::numeric,1) unauth_km
     FROM occupancy_segment WHERE started_at BETWEEN $1 AND $2
     GROUP BY plate HAVING count(*) FILTER (WHERE verdict='unauthorized') > 0
     ORDER BY unauthorized DESC LIMIT 100`, [from, to]));
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

app.get('/api/status', wrap(async (_, res) => res.json(await q(
  `SELECT DISTINCT ON (source, mode) source, mode, status, rows_written, window_start, window_end, finished_at, error
   FROM collection_run ORDER BY source, mode, finished_at DESC`))));

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
  const mode = req.body?.mode === 'backfill' ? 'backfill' : 'incremental';
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
  const rows = await q(
    `SELECT date_trunc('month', requested_at)::date m,
            count(*)::int trips,
            count(distinct driver_ext_id)::int drivers,
            count(distinct plate)::int vehicles,
            round(sum(distance_km)::numeric,0) km,
            round(sum(price)::numeric,0) revenue,
            round(100.0*sum((status ILIKE '%cancel%')::int)/nullif(count(*),0),1) cancel_pct
     FROM trip WHERE ($1::text IS NULL OR platform=$1)
     GROUP BY 1 ORDER BY 1`, [req.query.platform || null]);
  // flag month-over-month breaks > 30%
  const breaks = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const d = a.trips ? (b.trips - a.trips) / a.trips : 0;
    if (Math.abs(d) >= 0.3) breaks.push({ from: a.m, to: b.m, change_pct: Math.round(d * 100),
      trips_from: a.trips, trips_to: b.trips, drivers_from: a.drivers, drivers_to: b.drivers });
  }
  res.json({ months: rows, breaks });
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

// Static dashboard LAST: app.get('*') would otherwise shadow any API route
// registered after it (this silently broke /api/insights once already).
app.use(express.static(join(__dir, 'public'), { maxAge: '5m' }));
app.get('*', (_, res) => res.sendFile(join(__dir, 'public', 'index.html')));

const port = process.env.PORT || 8080;
migrate().catch((e) => log.error('api', 'migrate failed', { err: String(e) }))
  .finally(() => app.listen(port, () => log.info('api', `listening on :${port}`)));
