// Read API the dashboard calls. Serves the analytics aggregates from the collector store.
import express from 'express';
import { pool } from '../src/db.js';
import { log } from '../src/log.js';

const app = express();
const q = (text, params) => pool.query(text, params).then((r) => r.rows);

// filters: ?from=YYYY-MM-DD&to=YYYY-MM-DD&platform=uber&fleet=ecosine
const range = (req) => [req.query.from || '2000-01-01', req.query.to || '2100-01-01',
  req.query.platform || null, req.query.fleet || null];

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/api/kpis', async (req, res) => {
  const [from, to, platform, fleet] = range(req);
  const rows = await q(
    `SELECT count(*)::int trips,
            round(sum(distance_km)::numeric,0) km,
            round(avg(distance_km)::numeric,2) avg_km,
            round(100.0*sum((status='completed')::int)/nullif(count(*),0),1) completion_pct,
            count(distinct driver_ext_id)::int drivers
     FROM trip WHERE requested_at BETWEEN $1 AND $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`,
    [from, to, platform, fleet]);
  res.json(rows[0]);
});

app.get('/api/trips/daily', async (req, res) => {
  const [from, to, platform, fleet] = range(req);
  res.json(await q(
    `SELECT date_trunc('day', requested_at)::date d, count(*)::int trips
     FROM trip WHERE requested_at BETWEEN $1 AND $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     GROUP BY 1 ORDER BY 1`, [from, to, platform, fleet]));
});

app.get('/api/trips/hourly', async (req, res) => {
  const [from, to, platform, fleet] = range(req);
  res.json(await q(
    `SELECT extract(hour from requested_at)::int h, count(*)::int trips
     FROM trip WHERE requested_at BETWEEN $1 AND $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     GROUP BY 1 ORDER BY 1`, [from, to, platform, fleet]));
});

app.get('/api/mix', async (req, res) => {
  const [from, to, platform, fleet] = range(req);
  const dim = req.query.by === 'payment' ? 'payment_type' : 'product';
  res.json(await q(
    `SELECT ${dim} label, count(*)::int n FROM trip
     WHERE requested_at BETWEEN $1 AND $2 AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     GROUP BY 1 ORDER BY 2 DESC`, [from, to, platform, fleet]));
});

app.get('/api/drivers/leaderboard', async (req, res) => {
  const [from, to, platform, fleet] = range(req);
  res.json(await q(
    `SELECT driver_name, plate, count(*)::int trips,
            round(sum(distance_km)::numeric,0) km,
            round(100.0*sum((status='completed')::int)/nullif(count(*),0)) completion_pct
     FROM trip WHERE requested_at BETWEEN $1 AND $2
       AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)
     GROUP BY driver_name, plate ORDER BY trips DESC LIMIT 50`, [from, to, platform, fleet]));
});

app.get('/api/platforms', async (_, res) => {
  res.json(await q(
    `SELECT platform, fleet_id, count(*)::int trips, max(requested_at) latest
     FROM trip GROUP BY platform, fleet_id ORDER BY trips DESC`));
});

// latest realtime position per vehicle
app.get('/api/live', async (_, res) => {
  res.json(await q(
    `SELECT DISTINCT ON (plate) plate, fleet_id, source, captured_at, lat, lng, speed, status, seat_occupied
     FROM telemetry_snapshot ORDER BY plate, captured_at DESC`));
});

const port = process.env.PORT || 8080;
app.listen(port, () => log.info('api', `listening on :${port}`));
