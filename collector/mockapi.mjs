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


/* ── per-driver detail fixtures ───────────────────────────────────────────
   Shapes mirror api/driver_routes.js exactly so the pages can be reviewed
   without a database behind them. */
const DAYS = 30;
const dayISO = (back) => new Date(Date.now() - back * 864e5).toISOString().slice(0, 10);
const driverIds = drivers.map((_, i) => `drv-${i}`);
const idIndex = (id) => Math.max(0, driverIds.indexOf(id));

const dailyFor = (id) => {
  const seed = idIndex(id);
  const out = [];
  for (let b = DAYS; b >= 0; b--) {
    if ((b + seed) % 7 === 0) continue;                 // a rest day
    const trips = 6 + Math.round(rnd(0, 9));
    const first = 6.5 + (seed % 3) + rnd(-0.6, 0.9);
    const km = trips * rnd(7, 16);
    out.push({
      day: dayISO(b), trips, completed: trips - (b % 5 === 0 ? 1 : 0),
      cancelled: b % 5 === 0 ? 1 : 0,
      km: +km.toFixed(1), revenue: +(km * rnd(2.1, 3.4)).toFixed(2),
      first_trip_at: `${dayISO(b)}T0${Math.floor(first)}:00:00Z`,
      last_trip_at: `${dayISO(b)}T18:00:00Z`,
      first_hour: +first.toFixed(2), last_hour: +(first + rnd(8, 12)).toFixed(2),
      span_h: +rnd(8, 12).toFixed(2), plates: plates[seed % plates.length],
      platforms: 'uber', hours_online: +rnd(8, 12).toFixed(2),
      hours_on_trip: +rnd(4, 8).toFixed(2), platform_earnings: +rnd(250, 620).toFixed(2),
      temp_max: +rnd(33, 44).toFixed(1), precipitation: 0,
      is_holiday: b === 12, holiday_name: b === 12 ? 'Public holiday' : null, is_ramadan: false,
    });
  }
  return out;
};

app.get('/api/drivers/directory', (_, r) => r.json(drivers.map((name, i) => ({
  driver_ext_id: `drv-${i}`, ids: [`drv-${i}`], driver_name: name, fleet_id: i % 3 ? 'ecosine' : 'egari',
  trips: 420 - i * 37, days: 26 - i, km: 5400 - i * 380, revenue: 14200 - i * 900,
  last_trip: new Date(Date.now() - i * 36e5).toISOString(),
  first_trip: dayISO(DAYS), completion_pct: 97 - i, platforms: i % 3 === 0 ? ['uber', 'yango'] : ['uber'],
  plate: plates[i % plates.length], state: i === 3 ? 'suspended' : 'active',
  licence_expires: '2026-11-30', licence_days_left: i === 1 ? -12 : 40 + i * 9, rating: 4.9 - i * 0.06,
}))));

app.get('/api/driver/profile', (req, r) => {
  const i = idIndex(req.query.id);
  r.json({
    id: req.query.id, name: drivers[i], ids: [req.query.id],
    platforms: i % 3 === 0 ? ['uber', 'yango'] : ['uber'],
    span: { first_trip: dayISO(DAYS), last_trip: new Date().toISOString(), trips: 420 - i * 37,
      days_worked: 26 - i, vehicles: 2, fleet_id: i % 3 ? 'ecosine' : 'egari' },
    compliance: [{ platform: 'hotel', driver_ext_id: req.query.id, full_name: drivers[i],
      phone: '+9715012345' + i, emirates_id: '784-1990-000000' + i, licence_no: 'AE18025' + i,
      licence_expires: '2026-11-30', licence_days_left: i === 1 ? -12 : 40 + i * 9,
      state: i === 3 ? 'suspended' : 'active', rating: 4.9 - i * 0.06,
      device_brand: 'Samsung', device_model: 'SM-A536E' }],
    vehicles: [
      { plate: plates[i % plates.length], days: 21, trips: 310, km: 4100, revenue: 11200,
        first_day: dayISO(DAYS), last_day: dayISO(0), ever_primary: true },
      { plate: plates[(i + 3) % plates.length], days: 5, trips: 42, km: 610, revenue: 1800,
        first_day: dayISO(18), last_day: dayISO(12), ever_primary: false },
    ],
    accounts: [{ platform: 'uber', driver_ext_id: req.query.id, trips: 380, first_trip: dayISO(DAYS), last_trip: dayISO(0) },
      ...(i % 3 === 0 ? [{ platform: 'yango', driver_ext_id: `y-${i}`, trips: 40, first_trip: dayISO(20), last_trip: dayISO(1) }] : [])],
  });
});

app.get('/api/driver/kpis', (req, r) => {
  const i = idIndex(req.query.id), d = dailyFor(req.query.id);
  const trips = d.reduce((a, x) => a + x.trips, 0);
  r.json({
    trips, days_worked: d.length, km: Math.round(d.reduce((a, x) => a + x.km, 0)),
    avg_km: 11.4, revenue: Math.round(d.reduce((a, x) => a + x.revenue, 0)), avg_fare: 34.2,
    completion_pct: 96.4 - i * 0.4, cancel_pct: 3.1 + i * 0.3, avg_minutes: 17.4,
    vehicles: 2, platforms: i % 3 === 0 ? 2 : 1,
    median_start_h: 6.5 + (i % 3), median_end_h: 18.4, avg_span_h: 10.6, start_consistency_h: 0.8 + i * 0.15,
    hours_online: +d.reduce((a, x) => a + x.hours_online, 0).toFixed(1),
    hours_on_trip: +d.reduce((a, x) => a + x.hours_on_trip, 0).toFixed(1),
    acceptance_rate: 0.91 - i * 0.02, cancellation_rate: 0.04, rating: 4.9 - i * 0.06,
    reported_earnings: 9800 - i * 500, cash_earnings: 1200,
    trips_per_day: +(trips / d.length).toFixed(1), utilisation_pct: 58.2 - i * 2.4,
  });
});

app.get('/api/driver/daily', (req, r) => r.json(dailyFor(req.query.id)));

app.get('/api/driver/heatmap', (req, r) => {
  const seed = idIndex(req.query.id), out = [];
  for (let dow = 0; dow < 7; dow++) for (let h = 5; h < 24; h++) {
    const peak = (h >= 7 && h <= 9) || (h >= 17 && h <= 20);
    out.push({ dow, h, trips: Math.max(0, Math.round((peak ? 9 : 3) * rnd(.3, 1.4) - (dow === 5 ? 2 : 0) + seed % 2)), revenue: 0 });
  }
  r.json(out);
});

app.get('/api/driver/standing', (req, r) => {
  const i = idIndex(req.query.id);
  const mk = (key, label, value, percentile, median) => ({ key, label, value, percentile, median });
  r.json({ n_peers: 56, metrics: [
    mk('trips', 'Trips completed', 268 - i * 20, Math.max(4, 96 - i * 12), 141),
    mk('trips_per_day', 'Trips per working day', 10.3 - i * .6, Math.max(6, 88 - i * 11), 7.2),
    mk('km', 'Distance driven', 3410 - i * 240, Math.max(5, 84 - i * 10), 1980),
    mk('avg_km', 'Average trip length', 11.4, 46, 12.1),
    mk('days', 'Days worked', 26 - i, Math.max(8, 92 - i * 9), 19),
    mk('completion', 'Completion rate', 96.4 - i * .4, Math.max(10, 78 - i * 8), 94.1),
    mk('cancel', 'Cancellation rate', 3.1 + i * .3, Math.max(12, 72 - i * 9), 5.4),
    mk('revenue', 'Revenue booked', 9120 - i * 700, Math.max(6, 90 - i * 11), 5400),
  ] });
});

app.get('/api/driver/territory', (req, r) => {
  const seed = idIndex(req.query.id);
  const spots = [['Dubai Marina - Marina Walk', 25.077, 55.140], ['Downtown Dubai - Burj Park', 25.195, 55.274],
    ['Dubai International Airport - Terminal 3', 25.248, 55.353], ['Business Bay - Bay Square', 25.185, 55.271],
    ['Deira - Al Rigga', 25.266, 55.320], ['Jumeirah - Beach Road', 25.213, 55.245],
    ['Al Barsha - Mall of the Emirates', 25.118, 55.200], ['JLT - Cluster D', 25.070, 55.142]];
  r.json({
    pickups: spots.map(([addr, lat, lng], i) => ({ lat, lng, n: Math.round((60 - i * 6) * (1 + (seed % 3) * .2)),
      addr, avg_km: +rnd(6, 22).toFixed(1), avg_fare: +rnd(22, 88).toFixed(2) })),
    dropoffs: spots.slice().reverse().map(([addr, lat, lng], i) => ({ lat: lat + .01, lng: lng + .012, n: 40 - i * 4, addr })),
    areas: spots.map(([addr], i) => ({ area: addr.split(' - ')[0], n: Math.round(60 - i * 6),
      avg_km: +rnd(6, 22).toFixed(1), avg_fare: +rnd(22, 88).toFixed(2) })),
    idle: [{ lat: 25.253, lng: 55.365, fixes: 88 }, { lat: 25.078, lng: 55.139, fixes: 41 },
      { lat: 25.196, lng: 55.276, fixes: 22 }],
  });
});

app.get('/api/driver/mix', (req, r) => r.json({
  distance: [{ label: '0–3 km', ord: 1, n: 44, revenue: 900, avg_fare: 20.4 },
    { label: '3–7 km', ord: 2, n: 96, revenue: 2600, avg_fare: 27.1 },
    { label: '7–15 km', ord: 3, n: 78, revenue: 3100, avg_fare: 39.7 },
    { label: '15–30 km', ord: 4, n: 36, revenue: 2400, avg_fare: 66.6 },
    { label: '30–60 km', ord: 5, n: 12, revenue: 1500, avg_fare: 125.0 },
    { label: '60 km+', ord: 6, n: 2, revenue: 420, avg_fare: 210.0 }],
  product: [{ label: 'UberX', n: 198, revenue: 6100 }, { label: 'Comfort', n: 52, revenue: 2900 },
    { label: 'Uber Black', n: 18, revenue: 1900 }],
  payment: [{ label: 'card', n: 214, revenue: 8200 }, { label: 'cash', n: 44, revenue: 1600 },
    { label: 'uber_wallet', n: 10, revenue: 380 }],
  status: [{ label: 'completed', n: 258, revenue: 9800 }, { label: 'rider_cancelled', n: 7, revenue: 0 },
    { label: 'driver_cancelled', n: 3, revenue: 0 }],
  platform: [{ label: 'uber', n: 250, revenue: 9200 }, { label: 'yango', n: 18, revenue: 700 }],
}));

app.get('/api/driver/earnings', (req, r) => {
  const i = idIndex(req.query.id);
  r.json({
    components: [{ category: 'net_fare', parent: 'earnings', amount: 8420 - i * 400, currency: 'AED' },
      { category: 'tip', parent: 'earnings', amount: 286 - i * 20, currency: 'AED' },
      { category: 'promotion', parent: 'earnings', amount: 410, currency: 'AED' },
      { category: 'toll_reimbursement', parent: 'reimbursements', amount: 132, currency: 'AED' },
      { category: 'cash_collected', parent: 'payouts', amount: -1600, currency: 'AED' }],
    periods: Array.from({ length: 4 }, (_, w) => ({ platform: 'uber',
      period_start: dayISO(7 * (w + 1)), period_end: dayISO(7 * w),
      trips: 62 - w * 4, hours_online: 58.2 - w, hours_on_trip: 33.4 - w,
      earnings: 2350 - w * 120, cash_earnings: 400, acceptance_rate: .91, cancellation_rate: .04, rating: 4.88 })),
    tips: 286 - i * 20, fare: 8420 - i * 400, tip_pct: +(((286 - i * 20) / (8420 - i * 400)) * 100).toFixed(2),
  });
});

app.get('/api/driver/quality', (req, r) => {
  const i = idIndex(req.query.id);
  r.json({
    cancels: [{ status: 'rider_cancelled', n: 7, pct: 70 }, { status: 'driver_cancelled', n: 3, pct: 30 }],
    cancel_daily: dailyFor(req.query.id).map((d) => ({ day: d.day, cancelled: d.cancelled, trips: d.trips })),
    alerts: [{ alert_type: 'Harsh Braking', n: 41 + i * 3, latest: new Date().toISOString() },
      { alert_type: 'Overspeed', n: 26 + i * 2, latest: new Date().toISOString() },
      { alert_type: 'Harsh Acceleration', n: 14, latest: new Date().toISOString() },
      { alert_type: 'Harsh Cornering', n: 6, latest: new Date().toISOString() }],
    alert_km: 3410 - i * 240, alerts_per_100km: +(((87 + i * 5) / (3410 - i * 240)) * 100).toFixed(1),
  });
});

app.get('/api/driver/trips', (req, r) => {
  const seed = idIndex(req.query.id);
  r.json(Array.from({ length: 120 }, (_, n) => ({
    platform: n % 9 === 0 ? 'yango' : 'uber', external_id: `t-${seed}-${n}`,
    requested_at: new Date(Date.now() - n * 27e5).toISOString(),
    ended_at: new Date(Date.now() - n * 27e5 + 12e5).toISOString(),
    plate: plates[seed % plates.length],
    pickup_addr: ['Dubai Marina - Marina Walk', 'Downtown Dubai - Burj Park', 'Deira - Al Rigga'][n % 3],
    dropoff_addr: ['Business Bay - Bay Square', 'DXB Terminal 3', 'Al Barsha - MoE'][n % 3],
    distance_km: +rnd(2, 34).toFixed(1), duration_s: Math.round(rnd(400, 2600)),
    status: n % 17 === 0 ? 'rider_cancelled' : 'completed',
    product: ['UberX', 'Comfort', 'Uber Black'][n % 3], payment_type: n % 5 === 0 ? 'cash' : 'card',
    price: +rnd(18, 140).toFixed(2), currency: 'AED',
  })));
});

app.get('/api/driver/custody', (req, r) => {
  const seed = idIndex(req.query.id);
  r.json(dailyFor(req.query.id).slice().reverse().map((d) => ({
    day: d.day, plate: d.plates, platform: 'uber', trips: d.trips, km: d.km, revenue: d.revenue,
    first_trip_at: d.first_trip_at, last_trip_at: d.last_trip_at, is_primary: true,
  })));
});

app.get(/^\/api\//, (_, r) => r.json([]));

app.use(express.static(join(__dir, 'api', 'public')));
app.get('*', (_, r) => r.sendFile(join(__dir, 'api', 'public', 'index.html')));
app.listen(8099, () => console.log('mock api on http://localhost:8099'));
