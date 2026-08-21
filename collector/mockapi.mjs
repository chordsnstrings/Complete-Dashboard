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

const insights = [
  { code:'vehicle_doc_expiring', severity:'critical', category:'compliance', entity_type:'vehicle', entity_id:'L20048',
    title:'L20048: Vehicle Registration Form expires in 5 days',
    detail:'Tesla Model Y — Vehicle Registration Form valid until 2026-08-26. Currently driven by Ahmed Tarig Mohamed. Renewal in the UAE is not same-day; leaving it to the last week risks losing the car from service.',
    action:'Start the renewal now and re-check before the expiry date.', impact_aed:null, computed_at:new Date().toISOString(), window_start:null },
  { code:'idle_vehicle', severity:'critical', category:'utilisation', entity_type:'vehicle', entity_id:'L46207',
    title:'L46207 is reporting but has not earned in 14 days',
    detail:'The tracker reported as recently as 2026-08-21 09:44, so the vehicle is present and powered — but no trip on any platform in the last 14 days.',
    action:'Confirm it is not in workshop or reserve. If roadworthy, assign a driver — otherwise take it off the active cost base.',
    impact_aed:1680, computed_at:new Date().toISOString(), window_start:null },
  { code:'drivers_online_no_trips', severity:'critical', category:'utilisation', entity_type:'fleet', entity_id:'all',
    title:'2 drivers were online but completed no trips',
    detail:'Uber flagged 2 driver(s) logged in for about 2.0 hours in total with zero completed trips (2026-08-19). Paid-for supply that produced nothing.',
    action:'Check whether they were genuinely available, sitting in a dead zone, or logged in without intending to work.',
    impact_aed:null, computed_at:new Date().toISOString(), window_start:'2026-08-19', window_end:'2026-08-19' },
  { code:'volume_trend', severity:'critical', category:'demand', entity_type:'fleet', entity_id:'all',
    title:'Trip volume down 76% since 2026-02',
    detail:'2026-02: 17347 trips with 83 drivers on 77 vehicles → 2026-03: 4192 trips with 70 drivers on 64 vehicles.',
    action:'Separate the two causes before reacting: fewer drivers supplying, or less demand per driver. The fix is different for each.',
    impact_aed:null, computed_at:new Date().toISOString(), window_start:'2026-02-01', window_end:'2026-03-01' },
  { code:'unsafe_driving', severity:'warning', category:'safety', entity_type:'vehicle', entity_id:'L46174',
    title:'L46174: 18.4 harsh events per 100km — 3.1x fleet median',
    detail:'214 events over 1163km (61 overspeed, 88 harsh braking). Sustained harsh driving predicts both collisions and tyre/brake spend.',
    action:'Pull the dashcam clips for the worst events and run a coaching conversation with whoever drove this plate.',
    impact_aed:null, computed_at:new Date().toISOString(), window_start:'2026-07-22', window_end:'2026-08-21' },
  { code:'stale_tracker', severity:'warning', category:'data', entity_type:'vehicle', entity_id:'L82923',
    title:'L82923 has not reported a position for 38h',
    detail:'Last fix from cabman at 2026-08-19 21:10. Either the vehicle is off the road or the tracker has failed.',
    action:'Check the device. A dead tracker also disables unauthorised-use detection for this vehicle.',
    impact_aed:null, computed_at:new Date().toISOString(), window_start:null },
  { code:'weather_heat', severity:'info', category:'demand', entity_type:'fleet', entity_id:'all',
    title:'Extreme heat 2026-08-23 (42.6°C) — EV range and AC load both suffer',
    detail:'Sustained 42.6°C drives continuous AC use, which cuts usable EV range and raises mid-shift charging stops.',
    action:'Plan charging around the afternoon peak; expect lower effective range per charge.',
    impact_aed:null, computed_at:new Date().toISOString(), window_start:'2026-08-23', window_end:'2026-08-23' },
];
app.get('/api/insights', (_, r) => r.json(insights));
app.get('/api/insights/summary', (_, r) => r.json({
  total:{ n: insights.length, total_impact:'1680' },
  by_severity:[{severity:'critical',n:4,impact:'1680'},{severity:'warning',n:2},{severity:'info',n:1}],
  by_category:[{category:'utilisation',n:2},{category:'compliance',n:1},{category:'demand',n:2},{category:'safety',n:1},{category:'data',n:1}],
}));
const mkDoc=(plate,make,model,days,drv)=>({plate,make,model,year:2023,doc_type:'Vehicle Registration Form',
  status:'ACTIVE', expires_at:new Date(Date.now()+days*864e5).toISOString(), days_left:days, driver_name:drv});
app.get('/api/compliance/vehicles', (_, r) => r.json([
  mkDoc('L40924','Tesla','Model Y',5,'Ahmed Tarig Mohamed'), mkDoc('L37810','Tesla','Model Y',5,'Aliyan Khalil'),
  mkDoc('L20048','Tesla','Model Y',5,'Najeeb Ullah Khan'), mkDoc('L41452','BYD','Han EV',5,'Asad Khan Khan'),
  mkDoc('L40959','BYD','Han EV',5,null), mkDoc('L39421','Tesla','Model Y',13,'Roy Ocdol'),
  mkDoc('L40547','Tesla','Model Y',13,null), mkDoc('L44259','Lexus','ES 300h',33,'Muhammad Khalid Gul'),
]));
app.get('/api/compliance/drivers', (_, r) => r.json([
  {platform:'hotel',driver_ext_id:'d1',full_name:'SOAIEED ALOM MIHIN',licence_no:'123456',licence_expires:'2026-01-01',days_left:-232,state:'active'},
  {platform:'bolt',driver_ext_id:'d2',full_name:'Abdelmohsen Said',licence_no:'AE1802580',licence_expires:'2026-09-20',days_left:30,state:'suspended'},
]));

app.get(/^\/api\//, (_, r) => r.json([]));

app.use(express.static(join(__dir, 'api', 'public')));
app.get('*', (_, r) => r.sendFile(join(__dir, 'api', 'public', 'index.html')));
app.listen(8099, () => console.log('mock api on http://localhost:8099'));
