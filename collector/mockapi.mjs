// Local stand-in API so the UI can be reviewed without the production database.
// Not shipped — used only to render and screenshot the dashboard during development.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
const plates = ['L45235', 'L12615', 'L46174', 'L40971', 'L94178', 'L36397', 'L76098', 'L82923'];
const drivers = ['Ahmed Tarig Mohamed', 'Muhammad Ashraf Bakhsh', 'Najeeb Ullah Khan', 'Roy Vellespen Ocdol',
  'Muhammad Khalid Gul', 'Aliyan Khalil', 'Asad Khan Khan', 'Mohammed Alsous'];
const rnd = (a, b) => a + Math.random() * (b - a);

app.get('/api/live', (_, r) => r.json(plates.map((p, i) => ({
  plate: p, fleet_id: i % 3 ? 'ecosine' : 'egari', source: 'cabman',
  captured_at: new Date(Date.now() - i * 6e4).toISOString(), polled_at: new Date().toISOString(),
  lat: rnd(25.05, 25.30), lng: rnd(55.10, 55.42), speed: i % 3 ? Math.round(rnd(0, 70)) : 0,
  status: i % 3 === 0 ? 'Engaged' : 'Active', seat_occupied: i % 3 === 0, stale: i === 7,
  current_driver: drivers[i],
}))));

app.get('/api/map/days', (_, r) => r.json(plates.map((p, i) => ({
  day: '2026-08-21', plate: p, fixes: 40 - i, driver_name: drivers[i], fleet_id: 'ecosine',
}))));

app.get('/api/map/journey', (req, res) => {
  const pts = []; let lat = 25.11, lng = 55.20;
  for (let i = 0; i < 44; i++) {
    lat += rnd(-0.006, 0.009); lng += rnd(-0.008, 0.010);
    pts.push({ t: new Date(Date.parse('2026-08-21T06:00:00Z') + i * 3e5).toISOString(),
      lat, lng, speed: Math.round(rnd(0, 80)), status: 'Active', occupied: i > 10 && i < 26 });
  }
  res.json({ plate: req.query.plate, day: req.query.day, fixes: pts.length,
    segments: [{ points: pts.slice(0, 22), occupied: false }, { points: pts.slice(24), occupied: true }],
    driver: 'Ahmed Tarig Mohamed', driver_trips: 7,
    distance_km: 83.4, moving_km: 78.1, occupied_km: 31.2 });
});

app.get('/api/status', (_, r) => r.json([
  { source: 'cabman', status: 'ok', finished_at: new Date().toISOString(), rows_written: 48 },
  { source: 'uber', status: 'ok', finished_at: new Date().toISOString(), rows_written: 999 },
]));
app.get('/api/kpis', (_, r) => r.json({ trips: 2043, km: 23120, avg_km: 12.03, completion_pct: 89,
  cancel_pct: 10.7, drivers: 56, vehicles: 52, revenue: 41188, live_vehicles: 48, fresh: 44, alerts: 8863 }));
app.get('/api/insights/summary', (_, r) => r.json({ total: { n: 93, total_impact: '19800' },
  by_severity: [{ severity: 'critical', n: 85, impact: '19800' }, { severity: 'warning', n: 8, impact: null }],
  by_category: [{ category: 'utilisation', n: 55 }, { category: 'compliance', n: 35 }] }));
app.get(/^\/api\//, (_, r) => r.json([]));

app.use(express.static(join(__dir, 'api', 'public')));
app.get('*', (_, r) => r.sendFile(join(__dir, 'api', 'public', 'index.html')));
app.listen(8099, () => console.log('mock api on http://localhost:8099'));
