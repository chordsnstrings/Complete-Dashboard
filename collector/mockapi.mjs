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
  status: i % 3 === 0 ? 'Engaged' : 'Active',
  // Tri-state: only the CABMAN feed carries a seat sensor.
  seat_occupied: i % 4 === 3 ? null : i % 3 === 0, stale: i === 7,
  fix_age_min: i === 7 ? 581000 : i, poll_age_min: 1,
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
  res.json({
    occupancy_reported: true, occupancy_measured_km: 78.4, occupancy_reported_fixes: 44, plate: req.query.plate, day: req.query.day, fixes: pts.length,
    segments: [{ points: pts.slice(0, 22), occupied: false }, { points: pts.slice(24), occupied: true }],
    driver: 'Ahmed Tarig Mohamed', driver_trips: 7,
    distance_km: 83.4, moving_km: 78.1, occupied_km: 31.2 });
});

app.get('/api/status', (_, r) => r.json([
  { source: 'cabman', mode: 'realtime', status: 'ok', finished_at: new Date().toISOString(),
    rows_written: 48, chunks_total: null, chunks_failed: null, failed_windows: [], windows: [] },
  // The shape that hid a 299-day hole: rows written, and most windows missing.
  { source: 'uber', mode: 'backfill', status: 'partial', finished_at: new Date().toISOString(),
    rows_written: 1129, chunks_total: 12, chunks_failed: 9,
    failed_windows: [
      { from: '2025-10-23', to: '2025-11-22', error: 'download timed out after 600s for report 9f2c…' },
      { from: '2025-11-23', to: '2025-12-23', error: 'generate: {"code":"CONCURRENT_REPORT_LIMIT"}' },
      { from: '2025-12-24', to: '2026-01-23', error: 'download timed out after 600s for report 41ab…' },
    ],
    windows: [{ from: '2026-07-22', to: '2026-08-21', rows: 1129, ok: true },
      { from: '2025-10-23', to: '2025-11-22', rows: 0, ok: false }] },
  { source: 'hotel', mode: 'incremental', status: 'ok', finished_at: new Date().toISOString(),
    rows_written: 135, chunks_total: 1, chunks_failed: 0, failed_windows: [], windows: [] },
  { source: 'fms', mode: 'incremental', status: 'ok', finished_at: new Date().toISOString(),
    rows_written: 416, chunks_total: 1, chunks_failed: 0, failed_windows: [], windows: [] },
]));
app.get('/api/kpis', (_, r) => r.json({ trips: 2043, km: 23120, avg_km: 12.03, completion_pct: 89,
  cancel_pct: 10.7, drivers: 56, vehicles: 52, revenue: 41188, live_vehicles: 48, fresh: 44, alerts: 8863,
  // The two fields that stop the Trips and Revenue tiles overstating themselves.
  telematics_journeys: 2657, telematics_km: 31840, priced_trips: 187, avg_fare: 220.3,
  bookable_trips: 2043, priced_km: 3990, revenue_per_km: 10.32 }));
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
app.get('/api/insights', (req, r) => {
  const rows = req.query.category ? insights.filter((i) => i.category === req.query.category) : insights;
  r.json({ insights: rows, truncated: false, limit: 200 });
});
app.get('/api/insights/summary', (_, r) => r.json({
  // Measured and modelled are separate numbers: the modelled one is a constant
  // multiplied by a count, and folding it into a fleet-wide money total once
  // produced a headline of AED 1,424,592.
  total: { n: insights.length, measured_impact: null, modelled_impact: '5040', idle_vehicles: 3 },
  modelled: { idle_vehicles: 3, aed: '5040',
    assumption: '120 AED per vehicle per day of holding cost, over a 14-day lookback' },
  stored_rows: insights.length, duplicates_suppressed: 0,
  by_severity: [{ severity: 'critical', n: 4 }, { severity: 'warning', n: 2 }, { severity: 'info', n: 1 }],
  by_category: [{ category: 'utilisation', n: 2 }, { category: 'compliance', n: 1 },
    { category: 'demand', n: 2 }, { category: 'safety', n: 1 }, { category: 'data', n: 1 }],
}));
const mkDoc=(plate,make,model,days,drv)=>({plate,make,model,year:2023,doc_type:'Vehicle Registration Form',
  status:'ACTIVE', expires_at:new Date(Date.now()+days*864e5).toISOString(), days_left:days, driver_name:drv});
app.get('/api/compliance/vehicles', (_, r) => r.json([
  mkDoc('L40924','Tesla','Model Y',5,'Ahmed Tarig Mohamed'), mkDoc('L37810','Tesla','Model Y',5,'Aliyan Khalil'),
  mkDoc('L20048','Tesla','Model Y',5,'Najeeb Ullah Khan'), mkDoc('L41452','BYD','Han EV',5,'Asad Khan Khan'),
  mkDoc('L40959','BYD','Han EV',5,null), mkDoc('L39421','Tesla','Model Y',13,'Roy Ocdol'),
  mkDoc('L40547','Tesla','Model Y',13,null), mkDoc('L44259','Lexus','ES 300h',33,'Muhammad Khalid Gul'),
]));
app.get('/api/compliance/drivers', (_, r) => r.json({
  drivers: [
    // Six rows carrying the identical placeholder the source writes when the
    // field was never filled in, plus two real dates.
    ...Array.from({ length: 6 }, (_, i) => ({ platform: 'hotel', driver_ext_id: `d${10 + i}`,
      full_name: drivers[i], licence_no: '123456', licence_expires: '2026-01-01',
      days_left: -232, state: 'active' })),
    { platform: 'bolt', driver_ext_id: 'd2', full_name: 'Abdelmohsen Said', licence_no: 'AE1802580',
      licence_expires: '2026-09-20', days_left: 30, state: 'suspended' },
    { platform: 'hotel', driver_ext_id: 'd3', full_name: 'Aliyan Khalil', licence_no: 'AE9911',
      licence_expires: '2026-08-01', days_left: -20, state: 'active' },
  ],
  placeholder_date: '2026-01-01', placeholder_rows: 6, rows_with_a_date: 8,
  caveat: '6 of 8 licence dates are the identical value 2026-01-01, which is what this source writes '
    + 'when the field was never filled in. They are a data-quality problem, not expired licences, and '
    + 'are counted separately below rather than as people who must stand down.',
}));


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

app.get('/api/drivers/directory', (_, r) => r.json([
  ...drivers.map((name, i) => ({
    driver_ext_id: `drv-${i}`, ids: [`drv-${i}`], driver_name: name, fleet_id: i % 3 ? 'ecosine' : 'egari',
    trips: 420 - i * 37, completed: 400 - i * 36, bookable: 420 - i * 37,
    days: 26 - i, km: 5400 - i * 380, revenue: 14200 - i * 900, priced_trips: 60 - i * 5,
    last_trip: new Date(Date.now() - i * 36e5).toISOString(),
    last_ever: new Date(Date.now() - i * 36e5).toISOString(), lifetime_trips: 900 - i * 60,
    first_trip: dayISO(DAYS), completion_pct: 97 - i, platforms: i % 3 === 0 ? ['uber', 'yango'] : ['uber'],
    plate: plates[i % plates.length], state: i === 3 ? 'suspended' : 'active',
    licence_expires: '2026-11-30', licence_days_left: i === 1 ? -12 : 40 + i * 9, rating: 4.9 - i * 0.06,
    active_in_window: true, ever_driven: true,
  })),
  /* The two rows the directory used to omit entirely: somebody who did not
     drive in this window, and somebody who has never driven. One of them has an
     expired licence, which is exactly who this page is opened to find. */
  { driver_ext_id: 'drv-idle', ids: ['drv-idle'], driver_name: 'Saeed Al Mansoori',
    fleet_id: 'ecosine', trips: 0, completed: 0, bookable: 0, days: 0, km: null, revenue: null,
    priced_trips: 0, last_trip: null, last_ever: dayISO(96), lifetime_trips: 311,
    first_trip: null, completion_pct: null, platforms: [], plate: null, state: 'active',
    licence_expires: '2026-06-01', licence_days_left: -81, rating: null,
    active_in_window: false, ever_driven: true },
  { driver_ext_id: 'drv-new', ids: ['drv-new'], driver_name: 'Faisal Rahman',
    fleet_id: 'ecosine', trips: 0, completed: 0, bookable: 0, days: 0, km: null, revenue: null,
    priced_trips: 0, last_trip: null, last_ever: null, lifetime_trips: 0,
    first_trip: null, completion_pct: null, platforms: [], plate: null, state: 'active',
    licence_expires: null, licence_days_left: null, rating: null,
    active_in_window: false, ever_driven: false },
]));

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


/* ── per-vehicle detail fixtures ─────────────────────────────────────────── */
const vehSpec = [['Tesla','Model Y',2023,'White'],['BYD','Han EV',2024,'Black'],['Tesla','Model 3',2022,'Blue'],
  ['Lexus','ES 300h',2023,'Silver'],['Tesla','Model Y',2023,'Grey'],['BYD','Han EV',2024,'White'],
  ['Tesla','Model Y',2024,'Black'],['Toyota','Camry',2022,'White']];
const pIndex = (pl) => Math.max(0, plates.indexOf(String(pl || '').toUpperCase().replace(/[\s-]+/g, '')));

const vDaily = (plate) => {
  const i = pIndex(plate), out = [];
  for (let b = DAYS; b >= 0; b--) {
    const idle = (b + i) % 9 === 0;                      // reports a fix, earns nothing
    const trips = idle ? 0 : 8 + Math.round(rnd(0, 10));
    const km = trips * rnd(8, 15);
    out.push({ day: dayISO(b), trips, cancelled: trips && b % 6 === 0 ? 1 : 0,
      km: trips ? +km.toFixed(1) : null, revenue: trips ? +(km * rnd(2.2, 3.2)).toFixed(2) : null,
      drivers: trips ? 1 : 0, fixes: 200 + Math.round(rnd(0, 80)),
      top_speed: Math.round(rnd(88, 132)), fuel_level: Math.round(rnd(35, 98)),
      alerts: Math.round(rnd(0, 6)), drivers_named: drivers[(i + b) % drivers.length],
      temp_max: +rnd(33, 44).toFixed(1), is_holiday: false, holiday_name: null });
  }
  return out;
};

app.get('/api/vehicles/directory', (_, r) => r.json(plates.map((pl, i) => ({
  plate: pl, trips: i === 6 ? 0 : 470 - i * 44, days: i === 6 ? 0 : 27 - i,
  // A car that drove and took no booking — the bucket that used to be hidden
  // inside "Earning".
  telematics_journeys: i === 6 ? 38 : Math.round((470 - i * 44) * 1.3),
  telematics_km: i === 6 ? 512 : Math.round((6100 - i * 420) * 1.25),
  days_moved: i === 6 ? 12 : 27 - i, priced_trips: i === 6 ? 0 : 40 - i * 3,
  last_movement: new Date(Date.now() - i * 72e5).toISOString(),
  current_driver_id: i === 6 ? null : `drv-${i}`,
  km: i === 6 ? null : 6100 - i * 420, revenue: i === 6 ? null : 15800 - i * 1100,
  drivers: i === 6 ? 0 : 1 + (i % 3), platforms: 1 + (i % 2),
  last_trip: i === 6 ? null : new Date(Date.now() - i * 72e5).toISOString(),
  fleet_id: i % 3 ? 'ecosine' : 'egari',
  make: vehSpec[i][0], model: vehSpec[i][1], year: vehSpec[i][2],
  last_fix: i === 7 ? new Date(Date.now() - 38 * 36e5).toISOString() : new Date(Date.now() - i * 6e4).toISOString(),
  status: i % 3 === 0 ? 'Engaged' : 'Active', speed: i % 3 ? Math.round(rnd(0, 70)) : 0, stale: i === 7,
  soonest_expiry: new Date(Date.now() + (i === 1 ? -12 : 5 + i * 14) * 864e5).toISOString(),
  doc_days_left: i === 1 ? -12 : 5 + i * 14,
  alerts: 120 - i * 11, current_driver: i === 6 ? null : drivers[i],
  driver_as_of: new Date().toISOString(),
}))));

app.get('/api/vehicle/profile', (req, r) => {
  const i = pIndex(req.query.plate), [make, model, year, colour] = vehSpec[i];
  r.json({
    plate: plates[i],
    spec: { make, model, year, colour, vin: '5YJYGDEE' + (100000 + i), fuel_type: 'electric',
      image_url: null, colour_hex: null, compliance_status: 'ACTIVE',
      platform: 'uber', vehicle_ext_id: 'veh-' + i, fleet_id: i % 3 ? 'ecosine' : 'egari' },
    span: { first_trip: dayISO(DAYS), last_trip: new Date().toISOString(), trips: 470 - i * 44,
      days_worked: 27 - i, drivers: 1 + (i % 3) },
    telemetry: { last_fix: new Date(Date.now() - i * 6e4).toISOString(), polled_at: new Date().toISOString(),
      lat: 25.2 + i * 0.01, lng: 55.27 - i * 0.01, speed: i % 3 ? 41 : 0,
      status: i % 3 === 0 ? 'Engaged' : 'Active', seat_occupied: i % 3 === 0,
      odometer: 68000 + i * 2100, fuel_level: 74 - i * 3, ignition: true, source: 'cabman', stale: i === 7 },
    documents: [
      { platform: 'uber', doc_type: 'Vehicle Registration Form', status: 'ACTIVE',
        expires_at: new Date(Date.now() + (i === 1 ? -12 : 5 + i * 14) * 864e5).toISOString(),
        days_left: i === 1 ? -12 : 5 + i * 14 },
      { platform: 'uber', doc_type: 'Insurance', status: 'ACTIVE',
        expires_at: new Date(Date.now() + 220 * 864e5).toISOString(), days_left: 220 },
      { platform: 'uber', doc_type: 'Vehicle Inspection', status: 'ACTIVE',
        expires_at: new Date(Date.now() + 96 * 864e5).toISOString(), days_left: 96 },
    ],
    current_driver: { driver_name: drivers[i], driver_ext_id: `drv-${i}`, as_of: dayISO(0) },
  });
});

app.get('/api/vehicle/kpis', (req, r) => {
  const i = pIndex(req.query.plate), d = vDaily(req.query.plate);
  const trips = d.reduce((a, x) => a + x.trips, 0);
  const km = Math.round(d.reduce((a, x) => a + (x.km || 0), 0));
  const alerts = d.reduce((a, x) => a + x.alerts, 0);
  r.json({ trips, days_worked: d.filter((x) => x.trips).length, km, avg_km: 11.8,
    revenue: Math.round(d.reduce((a, x) => a + (x.revenue || 0), 0)), avg_fare: 36.4,
    completion_pct: 96.1, cancel_pct: 3.4, drivers: 1 + (i % 3), platforms: 1 + (i % 2),
    utilisation: 0.58 - i * 0.04, hours_online: 512.4, hours_on_trip: 297.2,
    earnings_per_hour: 21.4, trips_per_online_hour: 0.41,
    alerts, hours_since_fix: i === 7 ? 38.2 : 0.3, fixes: d.reduce((a, x) => a + x.fixes, 0),
    idle_days: d.filter((x) => !x.trips).length,
    alerts_per_100km: +((alerts / km) * 100).toFixed(1),
    revenue_per_km: 2.7 });
});

app.get('/api/vehicle/daily', (req, r) => r.json(vDaily(req.query.plate)));

app.get('/api/vehicle/drivers-detail', (req, r) => {
  const i = pIndex(req.query.plate);
  const who = [drivers[i], drivers[(i + 4) % drivers.length]];
  const days = vDaily(req.query.plate).filter((d) => d.trips).slice().reverse().map((d, n) => ({
    day: d.day, driver_ext_id: `drv-${n % 2 ? (i + 4) % drivers.length : i}`,
    driver_name: who[n % 2], platform: 'uber', trips: d.trips, km: d.km, revenue: d.revenue,
    first_trip_at: `${d.day}T06:30:00Z`, last_trip_at: `${d.day}T18:10:00Z`, is_primary: true,
  }));
  const totals = who.map((name, n) => {
    const mine = days.filter((x) => x.driver_name === name);
    return { driver_ext_id: `drv-${n ? (i + 4) % drivers.length : i}`, driver_name: name,
      days: mine.length, trips: mine.reduce((a, x) => a + x.trips, 0),
      km: Math.round(mine.reduce((a, x) => a + x.km, 0)),
      revenue: Math.round(mine.reduce((a, x) => a + x.revenue, 0)),
      first_day: mine[mine.length - 1]?.day, last_day: mine[0]?.day, primary_days: mine.length };
  }).sort((a, b) => b.trips - a.trips);
  r.json({ days, totals });
});

app.get('/api/vehicle/movement', (req, r) => {
  const i = pIndex(req.query.plate);
  r.json({
    segments: Array.from({ length: 14 }, (_, n) => ({
      started_at: new Date(Date.now() - n * 79e5).toISOString(),
      ended_at: new Date(Date.now() - n * 79e5 + 24e5).toISOString(),
      duration_min: 20 + Math.round(rnd(5, 50)), distance_km: +rnd(4, 32).toFixed(1),
      top_speed: Math.round(rnd(60, 128)), fixes: Math.round(rnd(5, 20)),
      verdict: n % 7 === 0 ? 'unauthorized' : n % 5 === 0 ? 'sensor_suspect' : 'authorized',
      matched_platform: n % 7 === 0 ? null : 'uber', low_confidence: n % 5 === 0,
      start_lat: 25.2, start_lng: 55.27, end_lat: 25.1, end_lng: 55.19,
    })),
    by_verdict: [{ verdict: 'authorized', n: 11, km: 214, minutes: 640 },
      { verdict: 'unauthorized', n: 2, km: 41, minutes: 96 },
      { verdict: 'sensor_suspect', n: 1, km: 12, minutes: 28 }],
    days: Array.from({ length: 12 }, (_, n) => ({ day: dayISO(n), fixes: 220 - n * 6 })),
    parked: [{ lat: 25.253, lng: 55.365, fixes: 142 }, { lat: 25.078, lng: 55.139, fixes: 71 },
      { lat: 25.196, lng: 55.276, fixes: 44 }, { lat: 25.118, lng: 55.200, fixes: 21 }],
  });
});

app.get('/api/vehicle/safety', (req, r) => {
  const i = pIndex(req.query.plate);
  r.json({
    by_type: [{ alert_type: 'Overspeed', n: 61 - i * 4, latest: new Date().toISOString() },
      { alert_type: 'Harsh Braking', n: 44 - i * 3, latest: new Date().toISOString() },
      { alert_type: 'Harsh Acceleration', n: 18, latest: new Date().toISOString() },
      { alert_type: 'Sharp Turn', n: 9, latest: new Date().toISOString() }],
    by_driver: [{ driver_name: drivers[i], n: 78, km: 3400 },
      { driver_name: drivers[(i + 4) % drivers.length], n: 41, km: 2100 },
      { driver_name: 'unattributed', n: 13, km: null }],
    daily: vDaily(req.query.plate).map((d) => ({ day: d.day, alerts: d.alerts })),
    recent: Array.from({ length: 40 }, (_, n) => ({
      alert_type: ['Overspeed', 'Harsh Braking', 'Harsh Acceleration', 'Sharp Turn'][n % 4],
      occurred_at: new Date(Date.now() - n * 41e5).toISOString(),
      location: ['Sheikh Zayed Road', 'Al Khail Road', 'Emirates Road', 'Jumeirah Beach Road'][n % 4],
      lat: 25.1 + (n % 9) * 0.02, lng: 55.18 + (n % 7) * 0.02, video_url: n % 6 === 0 ? 'https://example.com/clip' : null,
    })),
  });
});

app.get('/api/vehicle/mix', (req, r) => r.json({
  product: [{ label: 'UberX', n: 268, revenue: 8400, avg_km: 10.2 },
    { label: 'Comfort', n: 92, revenue: 4600, avg_km: 14.1 },
    { label: 'Uber Black', n: 24, revenue: 2800, avg_km: 22.4 }],
  payment: [{ label: 'card', n: 320, revenue: 12800 }, { label: 'cash', n: 52, revenue: 2200 },
    { label: 'corporate', n: 12, revenue: 800 }],
  platform: [{ label: 'uber', n: 336, revenue: 13100 }, { label: 'yango', n: 34, revenue: 1400 },
    { label: 'hotel', n: 14, revenue: 1300 }],
  status: [{ label: 'completed', n: 371, revenue: 15800 }, { label: 'rider_cancelled', n: 13, revenue: 0 }],
  hours: Array.from({ length: 19 }, (_, n) => ({ h: n + 5, trips: Math.round(rnd(4, 26)) })),
}));

app.get('/api/vehicle/trips', (req, r) => {
  const i = pIndex(req.query.plate);
  r.json(Array.from({ length: 140 }, (_, n) => ({
    platform: n % 11 === 0 ? 'yango' : 'uber', external_id: `vt-${i}-${n}`,
    requested_at: new Date(Date.now() - n * 24e5).toISOString(),
    ended_at: new Date(Date.now() - n * 24e5 + 11e5).toISOString(),
    driver_name: drivers[n % 2 ? i : (i + 4) % drivers.length],
    driver_ext_id: `drv-${n % 2 ? i : (i + 4) % drivers.length}`,
    pickup_addr: ['Dubai Marina - Marina Walk', 'Downtown Dubai - Burj Park', 'Deira - Al Rigga'][n % 3],
    dropoff_addr: ['Business Bay - Bay Square', 'DXB Terminal 3', 'Al Barsha - MoE'][n % 3],
    distance_km: +rnd(2, 34).toFixed(1), duration_s: Math.round(rnd(400, 2600)),
    status: n % 19 === 0 ? 'rider_cancelled' : 'completed',
    product: ['UberX', 'Comfort', 'Uber Black'][n % 3], payment_type: n % 5 === 0 ? 'cash' : 'card',
    price: +rnd(18, 140).toFixed(2), currency: 'AED',
  })));
});


/* ── "why it moved" fixtures ──────────────────────────────────────────────
   Deliberately mirrors the production shape, hole and all: Uber busy Aug–Oct
   2025, nothing collected Nov–Jan, telematics-only (no driver ids) Feb–Jun,
   Uber back in Aug. */
const TREND = [
  { m: '2025-08', trips: 5801, drivers: 80, vehicles: 71, revenue: 41200, platforms: ['uber'], attributed_trips: 5801 },
  { m: '2025-09', trips: 15777, drivers: 101, vehicles: 82, revenue: 118400, platforms: ['uber', 'fms'], attributed_trips: 12886 },
  { m: '2025-10', trips: 11800, drivers: 102, vehicles: 77, revenue: 89300, platforms: ['uber'], attributed_trips: 11800 },
  null, null, null,                                     // 2025-11 .. 2026-01: no data
  { m: '2026-02', trips: 2164, drivers: 0, vehicles: 43, revenue: null, platforms: ['fms'], attributed_trips: 0 },
  { m: '2026-03', trips: 4449, drivers: 0, vehicles: 57, revenue: null, platforms: ['fms'], attributed_trips: 0 },
  { m: '2026-04', trips: 5638, drivers: 0, vehicles: 58, revenue: null, platforms: ['fms'], attributed_trips: 0 },
  { m: '2026-05', trips: 3576, drivers: 0, vehicles: 45, revenue: null, platforms: ['fms'], attributed_trips: 0 },
  { m: '2026-06', trips: 7444, drivers: 0, vehicles: 59, revenue: null, platforms: ['fms'], attributed_trips: 0 },
  { m: '2026-07', trips: 6817, drivers: 29, vehicles: 81, revenue: 9100, platforms: ['fms', 'hotel'], attributed_trips: 1250 },
  { m: '2026-08', trips: 6975, drivers: 80, vehicles: 84, revenue: 102400, platforms: ['uber', 'fms', 'hotel'], attributed_trips: 2300 },
];
const MONTH_KEYS = ['2025-08','2025-09','2025-10','2025-11','2025-12','2026-01',
  '2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];

app.get('/api/trend/monthly', (_, r) => {
  const months = MONTH_KEYS.map((k, i) => {
    const row = TREND[i];
    return row
      ? { ...row, m: k, cancel_pct: 3.2, km: row.trips * 12, no_data: false, drivers_known: row.attributed_trips > 0 }
      : { m: k, trips: 0, drivers: null, vehicles: 0, km: null, revenue: null, cancel_pct: null,
          platforms: [], no_data: true, drivers_known: false };
  });
  const breaks = [];
  for (let i = 1; i < months.length; i++) {
    const a = months[i - 1], b = months[i];
    if (a.no_data || b.no_data || !a.trips) continue;
    const d = (b.trips - a.trips) / a.trips;
    if (Math.abs(d) < 0.3) continue;
    breaks.push({ from: a.m, to: b.m, change_pct: Math.round(d * 100),
      trips_from: a.trips, trips_to: b.trips,
      drivers_from: a.drivers_known ? a.drivers : null,
      drivers_to: b.drivers_known ? b.drivers : null,
      platform_shift: JSON.stringify([...a.platforms].sort()) !== JSON.stringify([...b.platforms].sort())
        ? { from: a.platforms, to: b.platforms } : null });
  }
  r.json({ months, breaks, gaps: [{ from: '2025-11', to: '2026-01', months: 3 }] });
});

const EV = [
  { title: 'Ramadan 1447', category: 'holiday', scope: 'uae', starts_on: '2026-02-18', ends_on: '2026-03-19',
    expected_effect: 'demand_down', confidence: 0.85,
    summary: 'Daytime demand collapses and shifts to the hours after iftar; total volume typically falls.' },
  { title: 'Eid al-Fitr 1447', category: 'holiday', scope: 'uae', starts_on: '2026-03-19', ends_on: '2026-03-22',
    expected_effect: 'demand_up', confidence: 0.7, summary: 'Sharp short spike in evening and late-night trips.' },
  { title: 'Dubai summer 2026', category: 'seasonal', scope: 'dubai', starts_on: '2026-06-15', ends_on: '2026-09-15',
    expected_effect: 'demand_down', confidence: 0.75,
    summary: 'Residents leave the country and outdoor activity stops; EV range also falls under continuous AC load.' },
  { title: 'UAE school summer break 2026', category: 'seasonal', scope: 'uae', starts_on: '2026-07-01', ends_on: '2026-08-31',
    expected_effect: 'demand_down', confidence: 0.6, summary: 'School-run and family trips disappear for two months.' },
  { title: 'Dubai high season 2025-26', category: 'seasonal', scope: 'dubai', starts_on: '2025-11-01', ends_on: '2026-04-15',
    expected_effect: 'demand_up', confidence: 0.8, summary: 'Tourist arrivals peak; airport and hotel transfers rise.' },
  { title: 'Regional tension, Strait of Hormuz', category: 'geopolitical', scope: 'gulf', starts_on: '2026-05-02', ends_on: '2026-06-10',
    expected_effect: 'demand_down', confidence: 0.45,
    summary: 'Reduced inbound travel and cautious discretionary spend; effect on ride demand is indirect.' },
  { title: 'UAE fuel price revision', category: 'economic', scope: 'uae', starts_on: '2026-08-01', ends_on: '2026-08-01',
    expected_effect: 'cost_up', confidence: 0.5, summary: 'Affects the ICE portion of the fleet only; the EV fleet is unaffected.' },
];
app.get('/api/events', (_, r) => r.json(EV));

app.get('/api/breaks', (_, r) => r.json([
  { metric: 'trips', grain: 'month', platform: 'uber', period_from: '2025-09-01', period_to: '2025-10-01',
    value_from: 15777, value_to: 11800, change_pct: -0.252, drivers_from: 101, drivers_to: 102,
    driver_change_pct: 0.0099, productivity_change_pct: -0.2596, attribution: 'demand',
    candidate_events: JSON.stringify([EV[4]]) },
  { metric: 'trips', grain: 'month', platform: 'uber', period_from: '2025-08-01', period_to: '2025-09-01',
    value_from: 5801, value_to: 15777, change_pct: 1.72, drivers_from: 80, drivers_to: 101,
    driver_change_pct: 0.2625, productivity_change_pct: 1.155, attribution: 'demand',
    candidate_events: JSON.stringify([]) },
  { metric: 'trips', grain: 'month', platform: 'fms', period_from: '2026-02-01', period_to: '2026-03-01',
    value_from: 2164, value_to: 4449, change_pct: 1.056, drivers_from: null, drivers_to: null,
    driver_change_pct: null, productivity_change_pct: null, attribution: 'unattributable',
    candidate_events: JSON.stringify([EV[0], EV[1]]) },
  { metric: 'trips', grain: 'month', platform: 'fms', period_from: '2026-04-01', period_to: '2026-05-01',
    value_from: 5638, value_to: 3576, change_pct: -0.366, drivers_from: null, drivers_to: null,
    driver_change_pct: null, productivity_change_pct: null, attribution: 'unattributable',
    candidate_events: JSON.stringify([EV[5]]) },
]));


/* ── finance & context fixtures ───────────────────────────────────────────── */
app.get('/api/mix', (req, r) => {
  const by = req.query.by;
  // The hotel channel's booking types are not Uber tiers, and a fixture that
  // ignores ?platform= renders a caption saying so directly above a chart of
  // Uber tiers.
  if (req.query.platform === 'hotel') return r.json([
    { label: 'hotel: pick_and_drop', platform: 'hotel', n: 708, revenue: 78600, priced_n: 708, revenue_per_trip: 111.0 },
    { label: 'hotel: drop_off', platform: 'hotel', n: 492, revenue: 51200, revenue_per_trip: 104.1, priced_n: 492 },
    { label: 'hotel: hourly', platform: 'hotel', n: 53, revenue: 8600, revenue_per_trip: 162.3, priced_n: 53 }]);
  if (by === 'payment') return r.json([
    { label: 'card', n: 1642, revenue: 61200 }, { label: 'cash', n: 318, revenue: 14800 },
    { label: 'uber_wallet', n: 83, revenue: 2900 }, { label: 'corporate', n: 41, revenue: 3400 }]);
  // Bookings only: fms rows are telematics twins of these same journeys and are
  // reported as their own figure, never as a slice of this ring.
  if (by === 'platform') return r.json([
    { label: 'uber', n: 1508, revenue: null, priced_n: 0 },
    { label: 'hotel', n: 131, revenue: 9073, priced_n: 131 },
    { label: 'yango', n: 43, revenue: 1900, priced_n: 43 }]);
  if (by === 'status') return r.json([
    { label: 'completed', n: 1962, revenue: 78400 }, { label: 'rider_cancelled', n: 91, revenue: 0 },
    { label: 'driver_cancelled', n: 31, revenue: 0 }]);
  if (by === 'fleet') return r.json([
    { label: 'ecosine', n: 1701, revenue: 68200 }, { label: 'egari', n: 383, revenue: 14100 }]);
  // product tiers — the point is that share of trips and share of revenue differ
  return r.json([
    { label: 'UberX', n: 1204, revenue: 34900 },
    { label: 'Comfort', n: 486, revenue: 24300 },
    { label: 'Uber Black', n: 112, revenue: 18600 },
    { label: 'hotel', n: 131, revenue: 9073 },
    { label: 'Electric', n: 151, revenue: 4400 }]);
});

app.get('/api/earnings/components', (_, r) => r.json([
  { driver_ext_id: 'drv-0', driver_name: 'Ahmed Tarig Mohamed', category: 'net_fare', parent: 'earnings', amount: 52180, currency: 'AED' },
  { driver_ext_id: 'drv-0', driver_name: 'Ahmed Tarig Mohamed', category: 'tip', parent: 'earnings', amount: 1642, currency: 'AED' },
  { driver_ext_id: 'drv-1', driver_name: 'Muhammad Ashraf Bakhsh', category: 'promotion', parent: 'earnings', amount: 3410, currency: 'AED' },
  { driver_ext_id: 'drv-1', driver_name: 'Muhammad Ashraf Bakhsh', category: 'toll_reimbursement', parent: 'reimbursements', amount: 980, currency: 'AED' },
  { driver_ext_id: 'drv-2', driver_name: 'Najeeb Ullah Khan', category: 'cash_collected', parent: 'payouts', amount: -14800, currency: 'AED' },
  { driver_ext_id: 'drv-2', driver_name: 'Najeeb Ullah Khan', category: 'service_fee', parent: 'payouts', amount: -9120, currency: 'AED' },
]));

app.get('/api/earnings/tips', (_, r) => r.json(drivers.map((name, i) => ({
  driver_ext_id: `drv-${i}`, driver_name: name,
  tips: +(420 - i * 44).toFixed(2), fare: 12800 - i * 900,
  tip_pct: +(((420 - i * 44) / (12800 - i * 900)) * 100).toFixed(2),
}))));

app.get('/api/context', (_, r) => {
  const out = [];
  for (let b = 30; b >= -3; b--) {
    const d = new Date(Date.now() - b * 864e5);
    const iso = d.toISOString().slice(0, 10);
    out.push({ day: iso + 'T00:00:00.000Z',
      temp_max: +(38 + Math.sin(b / 4) * 4 + rnd(-1, 2)).toFixed(1),
      precipitation: b === 9 ? 4.2 : 0, wind_max: +rnd(12, 26).toFixed(1),
      is_forecast: b < 0, hijri_month: 'Safar',
      is_ramadan: false, is_holiday: b === 14, holiday_name: b === 14 ? 'Islamic New Year' : null });
  }
  r.json(out);
});

app.get('/api/trips/daily', (_, r) => {
  /* Deliberately includes a collection hole and a partially-silent stretch:
     the whole point of this series is that a day nobody collected must not be
     drawn as a day nobody drove. */
  const out = [];
  for (let b = 30; b >= 0; b--) {
    const d = dayISO(b).slice(0, 10);
    const uncollected = b >= 12 && b <= 17;
    const partial = !uncollected && b >= 18 && b <= 21;
    const trips = uncollected ? 0 : Math.round(60 + Math.sin(b / 3) * 18 + rnd(0, 22) - (partial ? 30 : 0));
    out.push({ d, trips, completed: Math.round(trips * 0.94), cancelled: Math.round(trips * 0.06),
      telematics_journeys: uncollected ? 0 : Math.round(trips * 1.3),
      km: uncollected ? null : Math.round(trips * rnd(9, 14)),
      revenue: uncollected ? null : Math.round(trips * rnd(28, 42)),
      priced_trips: uncollected ? 0 : Math.round(trips * 0.15),
      drivers: uncollected ? 0 : 30 + Math.round(rnd(0, 8)),
      sources_silent: uncollected ? 4 : partial ? 1 : 0,
      sources_expected: 4,
      silent_sources: uncollected ? ['uber', 'fms', 'hotel', 'yango'] : partial ? ['uber'] : null,
      uncollected });
  }
  r.json(out);
});

app.get('/api/recommendations', (_, r) => r.json([
  { platform: 'uber', rec_type: 'acceptance_rate', period_start: dayISO(28), period_end: dayISO(0),
    org_value: 0.79, target_value: 0.85, flagged_count: 14, flagged: true, updated_at: new Date().toISOString() },
  { platform: 'uber', rec_type: 'cancellation_rate', period_start: dayISO(28), period_end: dayISO(0),
    org_value: 0.11, target_value: 0.06, flagged_count: 9, flagged: true, updated_at: new Date().toISOString() },
  { platform: 'uber', rec_type: 'driver_rating', period_start: dayISO(28), period_end: dayISO(0),
    org_value: 4.82, target_value: 4.7, flagged_count: 2, flagged: false, updated_at: new Date().toISOString() },
]));


/* ── commercial analytics fixtures ───────────────────────────────────────
   Shaped like the real responses, including the parts that are awkward: a
   settlement class whose revenue is null because the channel reports no fare,
   a source with a hole in the middle of its collecting span, and a vehicle
   whose premium shortfall is measured against its own model. */
const hotels = [
  { id: 'h-palm', name: 'Palm Grand' }, { id: 'h-marina', name: 'Marina Bay' },
  { id: 'h-creek', name: 'Creek View' }, { id: 'h-jbr', name: 'JBR Residences' },
];
app.get('/api/settlement/mix', (_, r) => r.json({
  total_trips: 2140, unlabelled_trips: 96, unlabelled_platforms: ['bolt'],
  classes: [
    { settlement_class: 'card', label: 'Card', meaning: 'Cleared through a card processor at the end of the ride.',
      trips: 820, trip_share_pct: 38.3, priced_trips: 210, revenue: 24800, avg_fare: 118.1, km: 9800, foc_trips: 0, platforms: ['uber', 'hotel'], last_at: new Date().toISOString() },
    { settlement_class: 'off_platform', label: 'Settled off-platform', meaning: 'Uber records the fare as settled outside the app. The export gives no further detail, so this is a settlement route and not, on this evidence, a business-account label.',
      trips: 470, trip_share_pct: 22.0, priced_trips: 0, revenue: null, avg_fare: null, km: 6100, foc_trips: 0, platforms: ['uber'], last_at: new Date().toISOString() },
    { settlement_class: 'cash', label: 'Cash', meaning: 'The driver was handed money and is holding it until it is banked.',
      trips: 430, trip_share_pct: 20.1, priced_trips: 88, revenue: 7300, avg_fare: 83.0, km: 5200, foc_trips: 0, platforms: ['uber', 'hotel'], last_at: new Date().toISOString() },
    { settlement_class: 'wallet', label: 'Wallet', meaning: 'Apple Pay, Google Pay, PayPal and equivalents — cleared, no cash risk.',
      trips: 210, trip_share_pct: 9.8, priced_trips: 0, revenue: null, avg_fare: null, km: 2600, foc_trips: 0, platforms: ['uber'], last_at: new Date().toISOString() },
    { settlement_class: 'on_account', label: 'On account', meaning: 'Charged to the room or the property. Outstanding until the hotel settles.',
      trips: 84, trip_share_pct: 3.9, priced_trips: 84, revenue: 9200, avg_fare: 109.5, km: 1500, foc_trips: 0, platforms: ['hotel'], last_at: new Date().toISOString() },
    { settlement_class: 'salary', label: 'Salary deduction', meaning: 'Posted against an employee’s salary. Outstanding until payroll runs.',
      trips: 22, trip_share_pct: 1.0, priced_trips: 22, revenue: 1900, avg_fare: 86.4, km: 380, foc_trips: 0, platforms: ['hotel'], last_at: new Date().toISOString() },
    { settlement_class: 'complimentary', label: 'Complimentary', meaning: 'Given away. Costs a driver-hour and fuel, earns nothing.',
      trips: 8, trip_share_pct: 0.4, priced_trips: 0, revenue: null, avg_fare: null, km: 120, foc_trips: 8, platforms: ['hotel'], last_at: new Date().toISOString() },
  ],
}));
app.get('/api/settlement/cash-exposure', (_, r) => r.json({
  drivers: drivers.map((d, i) => ({ driver_name: d, driver_ext_id: `drv-${i}`, cash_trips: 60 - i * 6,
    priced_cash_trips: Math.max(0, 14 - i * 2), cash_value: Math.max(0, 14 - i * 2) * 95,
    value_known_pct: Math.round((Math.max(0, 14 - i * 2) / (60 - i * 6)) * 100),
    platforms: ['uber', 'hotel'], plates: [plates[i], plates[(i + 1) % plates.length]],
    last_cash_trip: new Date(Date.now() - i * 36e5).toISOString() })),
  total_cash_trips: 430, total_cash_value_known: 7300, value_known_pct: 20,
  caveat: '342 of 430 cash trips come from a channel that does not report a fare, so the value column is a floor, not the total.',
}));
app.get('/api/settlement/receivables', (_, r) => r.json({
  rows: hotels.map((h, i) => ({ settlement_class: 'on_account', label: 'On account', counterparty: h.name,
    partner_id: h.id, driver_ext_id: null, trips: 30 - i * 6, priced_trips: 30 - i * 6,
    amount: (30 - i * 6) * 110, oldest: dayISO(70 - i * 10), newest: dayISO(i),
    age_days: 70 - i * 10 })).concat([{ settlement_class: 'salary', label: 'Salary deduction',
      counterparty: drivers[0], partner_id: null, driver_ext_id: 'drv-0', trips: 12, priced_trips: 12,
      amount: 980, oldest: dayISO(41), newest: dayISO(3), age_days: 41 }]),
  total: 8250, total_trips: 84,
}));
app.get('/api/corporate/summary', (_, r) => r.json({
  bookings: 1253, priced: 1245, revenue: 138400, cost: 96200, has_cost: true, avg_fare: 111.2, km: 18600,
  revenue_per_km: 7.44, deadhead_km: 3120, deadhead_measured: 1140, deadhead_measured_pct: 91,
  deadhead_ratio_pct: 16.8, foc_trips: 10, overrun_trips: 7, scheduled_trips: 604, scheduled_pct: 48.2,
  authorized_trips: 155, authorized_pct: 12.4, missing_trips: 0, guests: 812, properties: 4,
  drivers: 35, vehicles: 35, outside_dubai: 9, zoned: 707, outside_dubai_pct: 1.3,
  concentration_hhi: 3480, top_property: 'Palm Grand', top_property_share_pct: 55.5,
}));
app.get('/api/corporate/properties', (_, r) => r.json(hotels.map((h, i) => ({
  partner_id: h.id, name: h.name, bookings: 696 - i * 180, priced: 690 - i * 180,
  revenue: (696 - i * 180) * 110, cost: (696 - i * 180) * 76, avg_fare: 110 + i * 4,
  km: (696 - i * 180) * 14, revenue_per_km: 7.8 - i * 0.3, avg_deadhead_km: 2.4 + i * 0.8,
  foc: Math.max(0, 6 - i * 2), overrun: Math.max(0, 4 - i), scheduled: Math.round((696 - i * 180) * 0.48),
  scheduled_pct: 48, hourly: 20 - i * 4, pick_and_drop: 400 - i * 100, drop_off: 260 - i * 70,
  guests: 420 - i * 110, drivers: 30 - i * 5, bookings_per_guest: 1.66 - i * 0.1,
  first_at: dayISO(300), last_at: dayISO(i),
})).filter((h) => h.bookings > 0)));
app.get('/api/corporate/property', (req, res) => {
  const h = hotels.find((x) => x.id === req.query.id) || hotels[0];
  res.json({
    profile: { name: h.name, partner_id: h.id, bookings: 696, first_at: dayISO(300), last_at: dayISO(0),
      guests: 420, drivers: 30, vehicles: 28, revenue: 76560, priced: 690, avg_fare: 110.9 },
    daily: Array.from({ length: 24 }, (_, i) => ({ day: dayISO(23 - i).slice(0, 10),
      bookings: Math.round(20 + Math.sin(i / 3) * 8), revenue: Math.round(2200 + Math.cos(i / 4) * 500) })),
    types: [{ label: 'pick_and_drop', n: 400, revenue: 46000, avg_km: 15.2 },
      { label: 'drop_off', n: 260, revenue: 24800, avg_km: 12.1 },
      { label: 'hourly', n: 36, revenue: 5760, avg_km: 41.0 }],
    payments: [{ label: 'cash-driver', settlement_class: 'cash', label_class: 'Cash', n: 220, revenue: 23000 },
      { label: 'room-charge', settlement_class: 'on_account', label_class: 'On account', n: 166, revenue: 19200 },
      { label: 'pos-driver', settlement_class: 'card', label_class: 'Card', n: 190, revenue: 21400 },
      { label: 'posted-for-salary', settlement_class: 'salary', label_class: 'Salary deduction', n: 120, revenue: 12960 }],
    guests: Array.from({ length: 18 }, (_, i) => ({ guest_id: `guest-${1000 + i}`, bookings: 9 - (i % 8),
      revenue: (9 - (i % 8)) * 112, room_no: String(1200 + i), first_at: dayISO(60 - i), last_at: dayISO(i) })),
    drivers: drivers.map((d, i) => ({ driver_name: d, driver_ext_id: `drv-${i}`, bookings: 60 - i * 6,
      avg_deadhead_km: 1.8 + i * 0.4, revenue: (60 - i * 6) * 110 })),
    dayparts: [{ label: 'night', n: 90 }, { label: 'morning', n: 210 }, { label: 'midday', n: 160 },
      { label: 'evening', n: 180 }, { label: 'late', n: 56 }],
  });
});
app.get('/api/corporate/guests', (_, r) => r.json({
  guests: Array.from({ length: 40 }, (_, i) => ({ guest_id: `guest-${2000 + i}`, bookings: 8 - (i % 7),
    revenue: (8 - (i % 7)) * 108, priced: 8 - (i % 7), properties: 1 + (i % 2),
    property: hotels[i % hotels.length].name, room_no: String(900 + i),
    purpose: i % 5 === 0 ? 'AIRPORT TRANSFER' : null, first_at: dayISO(90 - i), last_at: dayISO(i % 30),
    km: (8 - (i % 7)) * 14, span_days: 90 - i - (i % 30) })),
  total_guests: 812, total_bookings: 1253, repeat_guests: 214, repeat_rate_pct: 26.4,
  bookings_from_repeat_pct: 48.1, bookings_with_room: 168, distinct_rooms: 139,
  id_is_per_booking: false, caveat: null,
  rooms: Array.from({ length: 10 }, (_, i) => ({ room_no: String(1200 + i), bookings: 6 - (i % 5),
    properties: 1, property: hotels[i % hotels.length].name, revenue: (6 - (i % 5)) * 110,
    first_at: dayISO(50 - i), last_at: dayISO(i) })),
}));
app.get('/api/corporate/leakage', (req, r) => {
  const kinds = [
    { kind: 'complimentary', label: 'Given away', why: 'A driver-hour and the fuel were spent; nothing was billed.', n: 10 },
    { kind: 'overrun', label: 'Ran past the booked hours', why: 'An hourly charter that ran over its booked hours.', n: 7 },
    { kind: 'unpriced', label: 'No fare recorded', why: 'The booking closed without a fare.', n: 8 },
    { kind: 'zero_priced', label: 'Priced at zero', why: 'A completed booking with a fare of exactly zero.', n: 3 },
    { kind: 'unauthorized', label: 'Charged with no authorisation on file', why: 'A billed booking with no authorisation object attached, at a property whose own workflow requires one.', n: 12 },
    { kind: 'deadhead_exceeds_fare', label: 'Drove further to reach the job than the job itself', why: 'The unpaid approach leg was longer than the paid ride.', n: 46 },
    { kind: 'missing', label: 'Flagged as a missing trip by the booking system', why: 'The booking system itself flagged this record as incomplete.', n: 0 },
  ];
  const rows = req.query.kind ? Array.from({ length: 12 }, (_, i) => ({
    external_id: `bk-${i}`, requested_at: new Date(Date.now() - i * 72e5).toISOString(),
    ended_at: new Date(Date.now() - i * 72e5 + 18e5).toISOString(), driver_name: drivers[i % drivers.length],
    driver_ext_id: `drv-${i % drivers.length}`, plate: plates[i % plates.length],
    property: hotels[i % hotels.length].name, partner_id: hotels[i % hotels.length].id,
    product: ['pick_and_drop', 'hourly', 'drop_off'][i % 3], payment_type: 'room-charge',
    settlement_class: 'on_account', price: 120 - i * 4, cost: 80 - i * 3, distance_km: 3 + i,
    deadhead_km: 12 - i * 0.4, hours: null, room_no: String(1100 + i), trip_purpose: null,
    over_run: false, has_authorization: i % 3 === 0, guest_id: `guest-${3000 + i}`,
  })) : [];
  r.json({ kinds: kinds.map((k) => ({ ...k, disabled: null })),
    summary: { total: 1253, overrun_value: 1840, foc_cost: null, foc_km: 148.2, foc_hours: 6.4,
      wasted_km: 386.4, properties_requiring_approval: 2, properties: 6 },
    kind: req.query.kind || null, rows });
});
app.get('/api/corporate/approach', (req, r) => {
  const by = req.query.by || 'property';
  const labels = by === 'daypart' ? ['night', 'morning', 'midday', 'evening', 'late']
    : by === 'driver' ? drivers : by === 'type' ? ['pick_and_drop', 'drop_off', 'hourly']
      : by === 'zone' ? ['inside-dubai', 'outside-dubai'] : hotels.map((h) => h.name);
  r.json(labels.map((label, i) => {
    const bookings = 300 - i * 40, measured = Math.round((300 - i * 40) * 0.9);
    const deadhead = Math.round((2.4 + i * 0.7) * measured * 10) / 10;
    const paid = Math.round(bookings * 14.2 * 10) / 10;
    return { label, bookings, measured, deadhead_km: deadhead, avg_deadhead_km: 2.4 + i * 0.7,
      paid_km: paid, ratio_pct: Math.round((deadhead / paid) * 1000) / 10 };
  }).filter((x) => x.bookings > 0));
});
app.get('/api/tiers/by-vehicle', (_, r) => r.json({
  fleet_premium_pct: 12.1,
  vehicles: plates.map((p, i) => {
    const trips = 400 - i * 40, black = i % 3 === 0 ? 0 : 30 - i * 3, comfort = i % 4 === 0 ? 2 : 20 - i * 2;
    const premium = black + comfort;
    return { plate: p, trips, black, comfort, electric: Math.round(trips * 0.44),
      uberx: trips - premium - Math.round(trips * 0.44), premium, km: trips * 12,
      avg_km: 12 + i * 0.3, make: i % 2 ? 'Lexus' : 'BYD', model: i % 2 ? 'ES' : 'Han EV',
      year: 2024, colour: i % 2 ? 'black' : 'white',
      premium_pct: Math.round((premium / trips) * 1000) / 10,
      model_key: i % 2 ? 'Lexus ES' : 'BYD Han EV', model_premium_pct: i % 2 ? 11.2 : 8.4,
      model_best_pct: i % 2 ? 14.2 : 10.1,
      // The shortfall is against the same MODEL's best, never the fleet's — a
      // BYD compared against a Lexus is a spec sheet, not a finding.
      premium_gap_pct: (() => {
        const best = i % 2 ? 14.2 : 10.1, mine = (premium / trips) * 100;
        return best - mine > 5 ? Math.round((best - mine) * 10) / 10 : null;
      })() };
  }),
}));
app.get('/api/tiers/mix', (_, r) => r.json(
  ['night', 'morning', 'midday', 'evening', 'late'].flatMap((label, i) =>
    ['UberX', 'Electric', 'Comfort', 'Black'].map((tier, j) => ({
      label, tier, n: Math.round(300 / (j + 1) - i * 12), avg_km: 11 + j * 3 })))
    .filter((x) => x.n > 0)));
app.get('/api/coverage/calendar', (_, r) => {
  const src = (source, holeFrom, holeDays, perDay) => {
    const days = [];
    for (let b = 90; b >= 0; b--) {
      const day = dayISO(b).slice(0, 10);
      if (holeFrom != null && b <= holeFrom && b > holeFrom - holeDays) continue;
      days.push({ day, rows: Math.round(perDay * (0.7 + Math.random() * 0.6)),
        plates: 30 + Math.round(Math.random() * 10), drivers: 25 + Math.round(Math.random() * 8) });
    }
    const gaps = holeFrom == null ? [] : [{ from: dayISO(holeFrom).slice(0, 10),
      to: dayISO(holeFrom - holeDays + 1).slice(0, 10), days: holeDays }];
    return { source, total_rows: days.reduce((a, d) => a + d.rows, 0), days_with_data: days.length,
      first_day: days[0].day, last_day: days[days.length - 1].day, median_rows_per_day: perDay,
      gaps, missing_days: holeDays || 0, days };
  };
  r.json({ window: [dayISO(90).slice(0, 10), dayISO(0).slice(0, 10)],
    sources: [src('uber', 36, 18, 430), src('fms', null, 0, 260), src('hotel', null, 0, 14),
      src('yango', 70, 40, 6)] });
});
app.get('/api/geo/corridors', (_, r) => {
  const areas = ['Al Thanyah Fifth', 'Business Bay', 'Dubai Airport', 'Palm Jumeirah', 'Al Barsha 1',
    'Marsa Dubai', 'Downtown Dubai', 'Al Nahda First', 'Jumeirah 1', 'Deira'];
  r.json({
    note: 'Areas are parsed from the address text each provider returns, not from a place id.',
    corridors: areas.flatMap((a, i) => areas.slice(0, 4).map((b, j) => ({
      from_area: a, to_area: b, trips: Math.max(3, 90 - i * 6 - j * 9),
      avg_km: 8 + j * 4, avg_min: 18 + j * 7, priced: (i + j) % 3 ? 0 : 20,
      avg_fare: (i + j) % 3 ? null : 96 + j * 12, platforms: ['uber', 'fms'] }))).filter((c) => c.from_area !== c.to_area),
    origins: areas.map((area, i) => ({ area, trips: 420 - i * 34, morning: 200 - i * 18,
      evening: 180 - i * 12, avg_km: 11 + i * 0.5 })),
  });
});
app.get('/api/funnel/drivers', (_, r) => r.json(drivers.map((d, i) => ({
  platform: i % 2 ? 'yango' : 'bolt', driver_name: d, driver_ext_id: `drv-${i}`,
  period_start: dayISO(28), period_end: dayISO(0),
  offered: 200 - i * 14, accepted: 150 - i * 12, completed: 120 - i * 10,
  cancelled_driver: 4 + i, cancelled_client: 8 + i, work_time_seconds: 360000 - i * 20000,
  price_cash: 3000 - i * 200, price_cashless: 1000 - i * 60, commission: -(800 - i * 50),
  driver_score: 90 - i * 3, state: i === 6 ? 'suspended' : 'active',
  accept_pct: Math.round(((150 - i * 12) / (200 - i * 14)) * 1000) / 10,
  complete_pct: Math.round(((120 - i * 10) / (150 - i * 12)) * 1000) / 10,
  commission_cost: 800 - i * 50, gross: 4000 - i * 260, hours: Math.round((360000 - i * 20000) / 360) / 10,
  cash_pct: Math.round(((3000 - i * 200) / (4000 - i * 260)) * 1000) / 10,
}))));


/* ── analyst fixtures ────────────────────────────────────────────────────
   Deliberately includes the three verdicts that are NOT findings, because the
   page exists as much to show what the model got wrong as what it got right. */
app.get('/api/analyst/findings', (req, r) => {
  const all = [
    { verdict: 'confirmed', claim: 'Cash-settled trips complete far less often than every other settlement route',
      verdict_reason: 'completion rate for cash is 70.2% against 95.1% across the other 4,140 trips (p < 0.001)',
      metric: 'completion_pct', segment: 'cash', measured_value: 70.2, baseline_value: 95.1,
      segment_n: 430, baseline_n: 4140, effect: -24.9, effect_pct: -26.2, p_value: 0.0000004,
      claimed_value: 72, why: 'A cancelled cash job costs the approach fuel and the slot with no fare at all.',
      action: 'Pull the twenty worst cash cancellations and check whether the rider or the driver ended them.' },
    { verdict: 'confirmed', claim: 'The Palm Grand account produces a much longer unpaid approach leg than other properties',
      verdict_reason: 'unpaid approach distance for Palm Grand is 5.9 km against 2.1 km across the other 557 records',
      metric: 'avg_deadhead_km', segment: 'Palm Grand', measured_value: 5.9, baseline_value: 2.1,
      segment_n: 696, baseline_n: 557, effect: 3.8, effect_pct: 181.0, p_value: null,
      claimed_value: null, why: 'Every approach kilometre is driven with nobody paying.',
      action: 'Stage two cars at the property between 07:00 and 10:00 rather than dispatching from Business Bay.' },
    { verdict: 'refuted', claim: 'Night trips are cancelled more often than the rest of the day',
      verdict_reason: 'cancellation rate for night is 4.1%, lower than the 7.2% elsewhere — the claim says higher',
      metric: 'cancel_pct', segment: 'night', measured_value: 4.1, baseline_value: 7.2,
      segment_n: 880, baseline_n: 3690, effect: -3.1, effect_pct: -43.1, p_value: 0.0002,
      claimed_value: 12, why: 'Night cancellations would point at driver availability after midnight.', action: null },
    { verdict: 'immaterial', claim: 'Friday has a higher cancellation rate than other weekdays',
      verdict_reason: 'the 1.4% difference is within what 620 and 3,950 rows would produce by chance (p = 0.214)',
      metric: 'cancel_pct', segment: 'Friday', measured_value: 8.3, baseline_value: 6.9,
      segment_n: 620, baseline_n: 3950, effect: 1.4, effect_pct: 20.3, p_value: 0.214,
      claimed_value: 15, why: 'A weekday effect would be worth rostering around.', action: null },
    { verdict: 'unsupported', claim: 'Uber Black trips earn a higher average fare than UberX',
      verdict_reason: 'no rows for tier = Black where average fare is defined',
      metric: 'avg_fare', segment: 'Black', measured_value: null, baseline_value: null,
      segment_n: 0, baseline_n: 1245, effect: null, effect_pct: null, p_value: null,
      claimed_value: 180, why: 'Tier pricing would be the clearest lever on revenue per kilometre.', action: null },
  ].map((f, i) => ({ ...f, id: i + 1, run_id: 'an-20260821', dimension: 'settlement',
    unit: f.metric === 'avg_deadhead_km' ? 'km' : f.metric === 'avg_fare' ? 'AED' : '%',
    metric_label: f.metric,
    direction: f.effect != null && f.effect < 0 ? 'lower' : 'higher', check_kind: 'rate_gap',
    model: 'glm-5-2-260617', created_at: new Date().toISOString(),
    window_start: dayISO(30), window_end: dayISO(0) }));
  const want = String(req.query.verdict || 'confirmed').split(',');
  r.json({ confirmed: 2, refuted: 1, immaterial: 1, unsupported: 1, runs: 3,
    last_run: new Date().toISOString(), model: 'glm-5-2-260617',
    findings: all.filter((f) => want.includes(f.verdict)) });
});
app.get('/api/analyst/rules', (_, r) => r.json({
  metrics: [
    { metric: 'completion_pct', label: 'completion rate', kind: 'rate', unit: '%', defined_over: 'is_booking AND outcome IS NOT NULL' },
    { metric: 'cancel_pct', label: 'cancellation rate', kind: 'rate', unit: '%', defined_over: 'is_booking AND outcome IS NOT NULL' },
    { metric: 'cash_pct', label: 'share settled in cash', kind: 'rate', unit: '%', defined_over: 'is_booking AND settlement_class IS NOT NULL' },
    { metric: 'premium_pct', label: 'share on a premium Uber tier', kind: 'rate', unit: '%', defined_over: "platform = 'uber' AND is_premium_tier IS NOT NULL" },
    { metric: 'avg_fare', label: 'average fare', kind: 'mean', unit: 'AED', defined_over: 'is_booking AND price IS NOT NULL AND NOT is_complimentary' },
    { metric: 'avg_deadhead_km', label: 'unpaid approach distance', kind: 'mean', unit: 'km', defined_over: 'deadhead_km IS NOT NULL' },
  ],
  dimensions: ['platform', 'fleet', 'settlement', 'tier', 'daypart', 'weekday', 'hour', 'property', 'zone', 'booking_type', 'vehicle', 'driver'],
  materiality: { minSegmentN: 30, minBaselineN: 30, minRelEffect: 0.15,
    minAbsEffect: { '%': 3, AED: 5, km: 0.5, min: 2 }, maxP: 0.05 },
  note: 'The model chooses a metric, a dimension and a segment from these lists. It never writes a query.',
}));


app.get('/api/probe/results', (_, r) => {
  const f = (key, fill, distinct, values, type = 'string') => ({ key, type, fill_pct: fill, distinct_seen: distinct, values });
  const surfaces = [
    { provider: 'uber', surface: 'drivers', ok: true, http_status: 200, record_count: 50,
      top_keys: ['driverInformation', 'paginationResult'], note: 'OAuth REST',
      fields: [f('driverId', 100, 50, null), f('email', 100, 50, null), f('firstName', 100, 48, null),
        f('phoneNumber.countryCode', 100, 1, ['+971']), f('status', 100, 3, ['ACTIVE', 'WAITLIST', 'INACTIVE'])],
      unmapped: ['driverIdEncrypted', 'phoneNumber.countryCode'] },
    { provider: 'uber', surface: 'driver-actions', ok: true, http_status: 200, record_count: 50,
      top_keys: ['driverStatusOverviews'], note: 'OAuth REST',
      fields: [f('onboardingStatus', 100, 4, ['ONBOARDING_STATUS_ACTIVE', 'ONBOARDING_STATUS_WAITLIST', 'ONBOARDING_STATUS_INACTIVE', 'ONBOARDING_STATUS_PENDING']),
        f('vehicleInfo.licensePlate', 100, 40, null), f('statusEntries', 52, 1, [null])],
      unmapped: ['onboardingStatus', 'statusEntries'] },
    { provider: 'uber', surface: 'trip-report-session', ok: false, http_status: null, record_count: null,
      top_keys: null, fields: null, unmapped: null,
      note: 'The trip export needs a supplier.uber.com session cookie, which expires and has to be re-pasted',
      error: 'Error: UBER_WEB_COOKIE not set (session expired?)' },
    { provider: 'hotel', surface: 'trip-report', ok: true, http_status: 200, record_count: 135,
      top_keys: ['data'], note: 'the bookings themselves',
      fields: [f('paymentMethod', 100, 8, ['cash-driver', 'pos-driver', 'room-charge', 'posted-for-salary', 'hotel-charge', 'cash-supervisor', 'pos-supervisor', 'foc-complimentary']),
        f('tripZone', 56, 2, ['inside-dubai', 'outside-dubai']), f('type', 100, 3, ['pick_and_drop', 'drop_off', 'hourly']),
        f('overRun', 100, 2, ['false', 'true']), f('driverStartLat', 97, 654, null), f('roomNumber', 13, 139, null)],
      unmapped: ['roomNumber', 'tripPurpose', 'stops', 'hotelOperator'] },
    { provider: 'fms', surface: 'ecosine:GetAlertData', ok: true, http_status: 200, record_count: 220,
      top_keys: ['Data'], note: 'harsh-driving and power events',
      fields: [f('Alert Name', 100, 5, ['Harsh Acceleration', 'Harsh Brake', 'Main Power Lost', 'Overspeed', 'Idle']),
        f('Start Location', 98, 573, null), f('Plate No', 100, 52, null)],
      unmapped: ['Start Location'] },
    { provider: 'yango', surface: 'transactions/park/list', ok: true, http_status: 200, record_count: 50,
      top_keys: ['transactions', 'cursor'], note: 'the park ledger',
      fields: [f('category_id', 100, 6, ['platform_commission', 'cash_collected', 'partner_service_manual', 'tip', 'fee', 'bonus']),
        f('amount', 100, 44, null), f('event_at', 100, 50, null)],
      unmapped: ['category_id', 'event_at'] },
  ].map((s) => ({ ...s, unmapped_n: s.unmapped ? s.unmapped.length : null,
    probed_at: new Date(Date.now() - 3600e3).toISOString(), error: s.error || null }));
  r.json({ surfaces, last_probe: new Date(Date.now() - 3600e3).toISOString(),
    failing: surfaces.filter((s) => !s.ok).map((s) => ({ provider: s.provider, surface: s.surface, error: s.error })),
    note: 'Each surface here is one the collectors already call, with the same credentials and the same read-only verb.' });
});


app.get('/api/roster', (_, r) => {
  const cats = ['working', 'working', 'working', 'idle_this_window', 'never_started', 'in_pipeline', 'blocked', 'working'];
  const people = drivers.map((name, i) => {
    const category = cats[i % cats.length];
    const blocked = category === 'blocked';
    const pipeline = category === 'in_pipeline' || category === 'never_started';
    return { person: name.toLowerCase(), name, driver_ext_id: `drv-${i}`, accounts: 1 + (i % 3),
      platforms: i % 3 === 0 ? ['uber', 'bolt'] : i % 3 === 1 ? ['uber'] : ['uber', 'yango', 'bolt'],
      states: blocked ? ['suspended'] : pipeline ? ['waitlist'] : ['active'],
      can_earn_anywhere: !blocked && !pipeline, blocked_everywhere: blocked,
      score: 90 - i * 4, plates: blocked || i % 4 ? [plates[i % plates.length]] : [],
      observed_at: new Date().toISOString(),
      reason: blocked ? 'You can no longer take trips because your document expired.' : null,
      trips: category === 'working' ? 120 - i * 9 : 0,
      completed: category === 'working' ? 110 - i * 9 : 0,
      revenue: category === 'working' ? (120 - i * 9) * 74 : null,
      km: category === 'working' ? (120 - i * 9) * 12 : null,
      last_trip: category === 'working' ? dayISO(i % 5) : null,
      lifetime_trips: category === 'never_started' ? 0 : 900 - i * 60,
      first_trip: category === 'never_started' ? null : dayISO(300),
      last_ever: category === 'never_started' ? null : dayISO(category === 'working' ? i % 5 : 40 + i),
      category, holding_vehicle_while_blocked: blocked,
      days_since_last_trip: category === 'never_started' ? null : (category === 'working' ? i % 5 : 40 + i) };
  });
  const c = (k) => people.filter((x) => x.category === k).length;
  r.json({ window: [dayISO(30), dayISO(0)], people,
    totals: { people: people.length, working: c('working'), idle_this_window: c('idle_this_window'),
      never_started: c('never_started'), in_pipeline: c('in_pipeline'), blocked: c('blocked'),
      holding_vehicle_while_blocked: people.filter((x) => x.holding_vehicle_while_blocked).length,
      multi_platform: people.filter((x) => x.platforms.length > 1).length },
    caveat: 'Platform accounts are folded into one person by name, because no provider shares an id with another.' });
});
app.get('/api/roster/states', (_, r) => r.json({
  by_state: [
    { platform: 'uber', state: 'active', state_raw: 'ONBOARDING_STATUS_ACTIVE', n: 106, with_vehicle: 98 },
    { platform: 'uber', state: 'waitlist', state_raw: 'ONBOARDING_STATUS_WAITLIST', n: 14, with_vehicle: 2 },
    { platform: 'uber', state: 'onboarding', state_raw: 'ONBOARDING_STATUS_PENDING', n: 6, with_vehicle: 0 },
    { platform: 'bolt', state: 'active', state_raw: 'active', n: 61, with_vehicle: 55 },
    { platform: 'bolt', state: 'suspended', state_raw: 'suspended', n: 4, with_vehicle: 4 },
    { platform: 'bolt', state: 'deactivated', state_raw: 'deactivated', n: 2, with_vehicle: 0 },
    { platform: 'hotel', state: 'active', state_raw: 'active', n: 35, with_vehicle: 0 },
    { platform: 'yango', state: 'unknown', state_raw: 'on_order', n: 3, with_vehicle: 1 },
  ],
  oldest_observation: new Date(Date.now() - 26 * 3600e3).toISOString(),
  newest_observation: new Date().toISOString(), rows: 231,
  unrecognised_words: [{ platform: 'yango', word: 'on_order', n: 3 }],
  no_state_reported: [{ platform: 'yango', n: 14 }],
}));


app.get('/api/settings/jobs', (_, r) => r.json({
  jobs: [
    { id: 7, mode: 'backfill', status: 'running', requested_by: 'admin',
      requested_at: new Date(Date.now() - 20 * 60000).toISOString(),
      started_at: new Date(Date.now() - 19 * 60000).toISOString(), finished_at: null, error: null, seconds: null,
      attempts: 3, running_seconds: 19 * 60,
      progress: { current: 'hotel', done: 4, total: 8, remaining: ['external', 'events', 'fms'] } },
    { id: 6, mode: 'probe', status: 'done', requested_by: 'admin',
      requested_at: new Date(Date.now() - 62 * 60000).toISOString(),
      started_at: new Date(Date.now() - 62 * 60000).toISOString(),
      finished_at: new Date(Date.now() - 61 * 60000).toISOString(), error: null, seconds: 44 },
    { id: 5, mode: 'analyst', status: 'failed', requested_by: 'admin',
      requested_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
      started_at: new Date(Date.now() - 26 * 3600e3).toISOString(),
      finished_at: new Date(Date.now() - 26 * 3600e3 + 9000).toISOString(),
      error: 'Error: 401 from the model endpoint — ARK_API_KEY rejected', seconds: 9 },
  ],
  pending: 0, running: 1,
}));


app.get('/api/day', (req, r) => {
  const day = req.query.day || dayISO(1).slice(0, 10);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h,
    bookings: Math.max(0, Math.round(30 * Math.exp(-((h - 19) ** 2) / 26) + 18 * Math.exp(-((h - 7) ** 2) / 9))),
    telematics: Math.max(0, Math.round(20 * Math.exp(-((h - 19) ** 2) / 30))),
    cancelled: h % 7 === 0 ? 2 : 0 }));
  const bookings = hours.reduce((a, x) => a + x.bookings, 0);
  r.json({
    day,
    // Kept internally consistent on purpose: a fixture whose headline and its
    // own breakdowns disagree makes every review of the page harder than the
    // real data would.
    headline: { bookings: 215, telematics: 240, completed: 201, not_completed: 14,
      bookable: 215, priced: 41, revenue: 4180, avg_fare: 101.95, booked_km: 3120,
      telematics_km: 4210, drivers: 34, vehicles: 41, completion_pct: 93.5,
      first_at: `${day}T02:14:00Z`, last_at: `${day}T20:41:00Z` },
    versus_neighbours: { median_bookings: 241, delta_pct: -10.8,
      series: Array.from({ length: 15 }, (_, i) => {
        const dd = dayISO(14 - i).slice(0, 10);
        return { day: dd, bookings: dd === day ? 215 : 210 + Math.round(Math.sin(i) * 40) };
      }) },
    hours: hours.map((x) => ({ ...x, bookings: Math.round(x.bookings * 215 / (bookings || 1)) })),
    platforms: [
      { platform: 'uber', n: 168, completed: 160, bookable: 168, revenue: null, km: 2100, completion_pct: 95.2 },
      { platform: 'hotel', n: 41, completed: 41, bookable: 41, revenue: 4180, km: 690, completion_pct: 100 },
      { platform: 'yango', n: 6, completed: 5, bookable: 6, revenue: 210, km: 90, completion_pct: 83.3 },
    ],
    drivers: drivers.map((name, i) => ({ driver_name: name, driver_ext_id: `drv-${i}`,
      trips: 22 - i * 2, cancelled: i % 3, revenue: i % 2 ? (22 - i * 2) * 96 : null,
      km: (22 - i * 2) * 13, platforms: i % 2 ? ['uber'] : ['uber', 'hotel'],
      plates: [plates[i % plates.length]],
      first_trip: `${day}T03:0${i}:00Z`, last_trip: `${day}T19:1${i}:00Z` })),
    vehicles: plates.map((p2, i) => ({ plate: p2, bookings: 30 - i * 3, telematics: 34 - i * 3,
      km: (30 - i * 3) * 14, drivers: 1 + (i % 2), revenue: i % 2 ? (30 - i * 3) * 88 : null })),
    tiers: [{ tier: 'Electric', n: 78 }, { tier: 'UberX', n: 64 }, { tier: 'Comfort', n: 15 }, { tier: 'Black', n: 11 }],
    settlement: [{ settlement_class: 'card', n: 96, revenue: 1180 }, { settlement_class: 'cash', n: 52, revenue: 900 },
      { settlement_class: 'off_platform', n: 44, revenue: null }, { settlement_class: 'on_account', n: 12, revenue: 1310 }],
    alerts: [{ alert_type: 'Harsh Brake', n: 14, plates: 9, on_plates: plates.slice(0, 9) },
      { alert_type: 'Harsh Acceleration', n: 8, plates: 6, on_plates: plates.slice(0, 6) },
      { alert_type: 'Main Power Lost', n: 1, plates: 1, on_plates: [plates[0]] }],
    segments: [
      { plate: plates[0], started_at: `${day}T05:38:00Z`, ended_at: `${day}T06:04:00Z`, duration_min: 26,
        distance_km: 18.4, verdict: 'unauthorized', nearest_platform: 'uber', nearest_gap_min: 96,
        verdict_reason: 'no completed booking overlaps; nearest is a uber trip 96 min away' },
      { plate: plates[2], started_at: `${day}T11:02:00Z`, ended_at: `${day}T11:19:00Z`, duration_min: 17,
        distance_km: 6.1, verdict: 'unverifiable', nearest_platform: null, nearest_gap_min: null,
        verdict_reason: 'no bookings collected from bolt in this window, so a booking there cannot be ruled out' },
    ],
    corridors: [
      { from_area: 'Al Thanyah Fifth', to_area: 'Dubai Airport', trips: 14 },
      { from_area: 'Business Bay', to_area: 'Palm Jumeirah', trips: 11 },
      { from_area: 'Marsa Dubai', to_area: 'Downtown Dubai', trips: 8 },
    ],
    coverage: [
      { source: 'uber', rows: 168, median_rows: 430, first_day: dayISO(300).slice(0, 10), last_day: dayISO(0).slice(0, 10), inside_span: true },
      { source: 'fms', rows: 240, median_rows: 260, first_day: dayISO(300).slice(0, 10), last_day: dayISO(0).slice(0, 10), inside_span: true },
      { source: 'hotel', rows: 41, median_rows: 28, first_day: dayISO(45).slice(0, 10), last_day: dayISO(0).slice(0, 10), inside_span: true },
      { source: 'bolt', rows: 0, median_rows: 40, first_day: dayISO(300).slice(0, 10), last_day: dayISO(0).slice(0, 10), inside_span: true },
    ],
    collection: { silent: [{ source: 'bolt', normally: 40 }], thin: [],
      warning: 'bolt collected nothing on this day and normally report around 40 rows. Every figure on this page is over what did land, so all of them are understated.' },
    context: { temp_max: 41.2, temp_min: 32.8, precipitation: 0, wind_max: 22,
      hijri_date: '17 Safar 1448', hijri_month: 'Safar', is_ramadan: false, is_holiday: false,
      holiday_name: null, sunrise: `${day}T01:53:00Z`, sunset: `${day}T14:52:00Z` },
  });
});


app.get('/api/alerts/by-driver', (_, r) => r.json(drivers.map((name, i) => {
  const brake = 22 - i * 2, accel = 12 - i, turn = i % 3, over = i % 2;
  const km = (900 - i * 90);
  return { driver_name: name, driver_ext_id: `drv-${i}`, alerts: brake + accel + turn + over,
    harsh_brake: brake, harsh_accel: accel, sharp_turn: turn, overspeed: over,
    plates: 1 + (i % 2), booked_km: km,
    per_100km: Math.round(((brake + accel + turn + over) * 100 / km) * 100) / 100 };
}).concat([{ driver_name: '(unattributed)', driver_ext_id: null, alerts: 9, harsh_brake: 6,
  harsh_accel: 2, sharp_turn: 1, overspeed: 0, plates: 4, booked_km: null, per_100km: null }])));


app.get('/api/alerts/summary', (_, r) => r.json([
  { alert_type: 'Harsh Brake', n: 148 }, { alert_type: 'Harsh Acceleration', n: 86 },
  { alert_type: 'Overspeed', n: 22 }, { alert_type: 'Sharp Turn', n: 9 },
  { alert_type: 'Main Power Lost', n: 31 },
]));
app.get('/api/alerts/by-vehicle', (_, r) => r.json(plates.map((p2, i) => {
  const brake = 30 - i * 3, accel = 18 - i * 2, turn = i % 3, over = i % 2, other = i % 4 === 0 ? 5 : 0;
  return { plate: p2, alerts: brake + accel + turn + over + other,
    harsh_brake: brake, harsh_accel: accel, sharp_turn: turn, overspeed: over, other,
    unattributed: i === 3 ? 4 : 0, drivers: 1 + (i % 2),
    top_driver: i === 3 ? null : drivers[i % drivers.length],
    top_driver_id: i === 3 ? null : `drv-${i % drivers.length}` };
})));


app.get('/api/drivers/leaderboard', (_, r) => r.json(drivers.map((name, i) => ({
  driver_name: name, driver_ext_id: `drv-${i}`, platform: i % 3 ? 'uber' : 'hotel',
  plate: plates[i % plates.length], trips: 180 - i * 14, km: (180 - i * 14) * 12,
  avg_km: 12 + i * 0.3, revenue: i % 3 ? null : (180 - i * 14) * 96,
  completion_pct: 96 - i }))));
app.get('/api/mix/detail', (req, r) => {
  if (req.query.by === 'payment') {
    return r.json({ dimension: 'payment', per_platform: false, total_trips: 2043,
      unlabelled_trips: 402, unlabelled_platforms: ['fms'],
      groups: [
        { platform: null, label: 'braintree', n: 620, revenue: null, priced_n: 0 },
        { platform: null, label: 'apple_pay', n: 402, revenue: null, priced_n: 0 },
        { platform: null, label: 'offline', n: 349, revenue: null, priced_n: 0 },
        { platform: null, label: 'cash', n: 270, revenue: null, priced_n: 0 },
        { platform: null, label: 'room-charge', n: 96, revenue: 9600, priced_n: 96, revenue_per_trip: 100 },
        { platform: null, label: 'cash-driver', n: 58, revenue: 5220, priced_n: 58, revenue_per_trip: 90 },
        { platform: null, label: 'posted-for-salary', n: 33, revenue: 6270, priced_n: 33, revenue_per_trip: 190 },
        { platform: null, label: 'pos-driver', n: 29, revenue: 2610, priced_n: 29, revenue_per_trip: 90 },
        { platform: null, label: 'paypal', n: 12, revenue: null, priced_n: 0 },
        { platform: null, label: 'zaakpay', n: 9, revenue: null, priced_n: 0 },
        { platform: null, label: 'foc-complimentary', n: 3, revenue: null, priced_n: 0 },
      ] });
  }
  r.json({ dimension: req.query.by || 'product', per_platform: true, total_trips: 2043,
    unlabelled_trips: 0, unlabelled_platforms: [], groups: [] });
});



/* ── occupancy segments as pages ─────────────────────────────────────────── */
const SEG_VERDICTS = ['unauthorized', 'authorized', 'sensor_suspect', 'partial', 'unverifiable'];
const segAt = (i) => new Date(Date.UTC(2026, 7, 3 + (i % 16), 4 + (i % 14), (i * 7) % 60)).toISOString();
const mkSeg = (i) => ({
  plate: plates[i % plates.length], fleet_id: i % 3 ? 'ecosine' : 'egari',
  started_at: segAt(i),
  ended_at: new Date(Date.parse(segAt(i)) + (12 + (i % 40)) * 6e4).toISOString(),
  duration_min: 12 + (i % 40), distance_km: +(2 + (i % 17) * 1.4).toFixed(1),
  top_speed: 40 + (i % 60), fixes: 4 + (i % 12), max_gap_min: i % 5 === 0 ? 25 : 5,
  ignition_ratio: +(0.4 + (i % 6) / 10).toFixed(2),
  verdict: SEG_VERDICTS[i % SEG_VERDICTS.length],
  matched_platform: i % SEG_VERDICTS.length === 1 ? 'uber' : null,
  matched_trip_id: i % SEG_VERDICTS.length === 1 ? `t-${i}` : null,
  low_confidence: i % 7 === 0, unavailable_sources: i % 7 === 0 ? 'bolt, yango' : null,
  verdict_reason: i % 9 === 0 ? null
    : `no booking within 15 min on any of 5 channels; nearest was ${20 + (i % 200)} min away`,
  nearest_platform: 'uber', nearest_trip_id: `n-${i}`, nearest_gap_min: 20 + (i % 200),
  channels_checked: 'uber, yango, bolt, hotel, fms', boundary_gap_min: i % 11,
  start_lat: rnd(25.05, 25.3), start_lng: rnd(55.1, 55.42),
  end_lat: rnd(25.05, 25.3), end_lng: rnd(55.1, 55.42),
  local_day: segAt(i).slice(0, 10),
  drivers: i % 6 === 0 ? null : drivers[i % drivers.length],
});
const ALL_SEGS = Array.from({ length: 64 }, (_, i) => mkSeg(i));

app.get('/api/segments', (req, r) => {
  let rows = ALL_SEGS;
  if (req.query.verdict) rows = rows.filter((x) => x.verdict === req.query.verdict);
  if (req.query.plate) rows = rows.filter((x) => x.plate === req.query.plate);
  if (req.query.day) rows = rows.filter((x) => x.local_day === req.query.day);
  if (req.query.driver) rows = rows.filter((x) => (x.drivers || '').includes(req.query.driver));
  const by = (key) => {
    const m = new Map();
    ALL_SEGS.forEach((x) => {
      const k = x[key]; const c = m.get(k) || { key: k, n: 0, unauthorized: 0, unauth_km: 0, km: 0 };
      c.n++; c.km += x.distance_km;
      if (x.verdict === 'unauthorized') { c.unauthorized++; c.unauth_km += x.distance_km; }
      m.set(k, c);
    });
    return [...m.values()].map((c) => ({ ...c, km: +c.km.toFixed(1), unauth_km: +c.unauth_km.toFixed(1) }));
  };
  r.json({
    rows, total: rows.length, truncated: false,
    low_confidence: rows.filter((x) => x.low_confidence).length,
    unreasoned: rows.filter((x) => !x.verdict_reason).length,
    filter: { verdict: req.query.verdict || null, plate: req.query.plate || null,
      day: req.query.day || null, driver: req.query.driver || null },
    facets: {
      verdict: by('verdict').sort((a, b) => b.n - a.n),
      plate: by('plate').sort((a, b) => b.unauthorized - a.unauthorized),
      day: by('local_day').sort((a, b) => String(a.key).localeCompare(String(b.key))),
      reason: [
        { key: 'no booking within 15 min on any of 5 channels', n: 21, verdict: 'unauthorized' },
        { key: 'matched a uber booking 2 min away', n: 14, verdict: 'authorized' },
        { key: '(no reason recorded)', n: 7, verdict: 'partial' },
      ],
    },
    known_verdicts: SEG_VERDICTS,
  });
});

app.get('/api/segment', (req, r) => {
  const seg = ALL_SEGS.find((x) => x.plate === req.query.plate && x.started_at === req.query.at) || ALL_SEGS[0];
  const t0 = Date.parse(seg.started_at);
  const track = Array.from({ length: 14 }, (_, i) => ({
    captured_at: new Date(t0 + i * 3e5).toISOString(),
    lat: +rnd(25.05, 25.3).toFixed(4), lng: +rnd(55.1, 55.42).toFixed(4),
    speed: i < 2 || i > 11 ? 0 : Math.round(rnd(20, 80)),
    seat_occupied: i % 5 === 4 ? null : true, ignition: i > 1, status: 'Engaged',
  }));
  r.json({
    segment: seg, track,
    profile: { fixes: track.length, moving_fixes: 10, moving_pct: 71,
      max_speed: 82, median_speed: 44, observed: seg.max_gap_min <= 11 },
    // Deliberately at the same offset, so the clock-skew warning renders.
    nearby_vehicle_trips: [0, 1, 2].map((i) => ({
      platform: ['uber', 'bolt', 'yango'][i], external_id: `nv-${i}`,
      driver_name: drivers[i], driver_ext_id: `drv-${i}`,
      requested_at: new Date(t0 + 240 * 6e4 + i * 6e4).toISOString(),
      ended_at: new Date(t0 + 260 * 6e4).toISOString(),
      status: ['completed', 'finished', 'complete'][i], outcome: 'completed',
      price: 40 + i * 5, distance_km: 12, pickup_addr: 'Dubai Mall', dropoff_addr: 'DXB T3',
      gap_min: 240 + i,
    })),
    nearby_driver_trips: [{
      platform: 'uber', external_id: 'nd-0', plate: plates[3], driver_name: drivers[0],
      requested_at: new Date(t0 + 30 * 6e4).toISOString(), ended_at: new Date(t0 + 55 * 6e4).toISOString(),
      status: 'completed', outcome: 'completed', gap_min: 30,
    }],
    same_day_segments: ALL_SEGS.filter((x) => x.local_day === seg.local_day).slice(0, 4),
    custody: [-1, 0, 1].map((d) => ({
      day: new Date(t0 + d * 864e5).toISOString().slice(0, 10),
      driver_name: drivers[(d + 3) % drivers.length], driver_ext_id: `drv-${d + 3}`,
      platform: 'uber', trips: 6 + d,
    })),
    channels_that_day: [
      { platform: 'uber', rows_that_day: 812 }, { platform: 'bolt', rows_that_day: 64 },
      { platform: 'hotel', rows_that_day: 18 }, { platform: 'fms', rows_that_day: 190 },
    ],
  });
});

/* ── one weekday-hour slot ───────────────────────────────────────────────── */
app.get('/api/slot', (req, r) => {
  const dow = +req.query.dow || 0, hour = +req.query.hour || 0;
  const trips = 30 + ((dow * 7 + hour) % 60);
  const possible = 4;
  const daysSeen = 3;
  r.json({
    slot: { dow, hour },
    headline: {
      trips, days_seen: daysSeen, drivers: 2 + (hour % 5), vehicles: 3 + (hour % 4),
      platforms: 3, avg_km: 14.2, revenue: trips * 38, priced_n: Math.round(trips * 0.4),
      completion_pct: 91.4, possible_days: possible,
      trips_per_occurrence: +(trips / possible).toFixed(1),
      coverage_pct: Math.round((daysSeen / possible) * 100),
      revenue_per_priced_trip: 38,
    },
    drivers: drivers.slice(0, 5).map((n, i) => ({
      driver_ext_id: `drv-${i}`, driver_name: n, trips: Math.max(1, Math.round(trips * (0.45 - i * 0.09))),
      days: 3 - (i % 3), platforms: ['uber', 'bolt'][i % 2], revenue: 400 - i * 60,
      completion_pct: i === 4 ? null : 96 - i * 6,
    })),
    platforms: [
      { platform: 'uber', trips: Math.round(trips * 0.6), revenue: 0, priced_n: 0 },
      { platform: 'bolt', trips: Math.round(trips * 0.25), revenue: 380, priced_n: 9 },
      { platform: 'hotel', trips: Math.round(trips * 0.15), revenue: 720, priced_n: 6 },
    ],
    corridors: ['Dubai International Airport', 'Dubai Marina', 'Business Bay', 'Deira']
      .map((place, i) => ({ place, trips: 12 - i * 3 })),
    occurrences: Array.from({ length: daysSeen }, (_, i) => ({
      day: `2026-08-${String(3 + i * 7).padStart(2, '0')}`, trips: 8 + i * 9, revenue: 300 + i * 90,
    })),
    peers: Array.from({ length: 7 }, (_, d) => ({ dow: d, trips: 20 + ((d * 11 + hour) % 40), days: 4 })),
    settlement: [
      { settlement_class: 'cash', trips: Math.round(trips * 0.5), revenue: 700 },
      { settlement_class: 'card', trips: Math.round(trips * 0.3), revenue: 420 },
      { settlement_class: 'on_account', trips: Math.round(trips * 0.2), revenue: 260 },
    ],
    outcome: [
      { outcome: 'completed', trips: Math.round(trips * 0.9) },
      { outcome: 'not_completed', trips: Math.round(trips * 0.07) },
      { outcome: '(not reported)', trips: Math.round(trips * 0.03) },
    ],
  });
});


/* Cross-platform and platform-reported performance. Both fell through to the
   empty-list catch-all, so the panels that read them rendered their empty state
   and the smoke test never exercised the tables — including the driver links
   that were dead text until the ids were added to the real queries. */
app.get('/api/drivers/cross-platform', (_, r) => r.json({
  platforms: ['uber', 'yango', 'bolt', 'hotel'],
  drivers: drivers.map((name, i) => ({
    person: name.toLowerCase(), driver_name: name, driver_ext_id: `drv-${i}`,
    uber_trips: 40 - i * 3, yango_trips: i % 2 ? 12 - i : 0,
    bolt_trips: i % 3 === 0 ? 9 : 0, hotel_trips: i % 4 === 0 ? 5 : 0,
    fms_trips: 20 + i, booking_trips: 60 - i * 2, telematics_journeys: 20 + i,
    total_trips: 80 - i, platform_count: i % 3 === 0 ? 3 : i % 2 ? 2 : 1,
    accounts: 1 + (i % 2), km: 800 - i * 40, revenue: i % 2 ? 1400 - i * 90 : null,
    priced_trips: i % 2 ? 20 : 0,
  })),
  multi_platform: 6,
  note: 'One row per person: platform accounts are folded by name.',
}));

app.get('/api/drivers/performance', (_, r) => r.json(drivers.slice(0, 6).map((name, i) => ({
  platform: ['uber', 'bolt', 'yango'][i % 3], driver_name: name, driver_ext_id: `drv-${i}`,
  plate: plates[i], period_start: '2026-08-14', period_end: '2026-08-20',
  trips: 44 - i * 4, hours_online: 52 - i * 3, hours_on_trip: 31 - i * 2,
  acceptance_rate: 0.92 - i * 0.04, cancellation_rate: 0.03 + i * 0.01,
  distance_km: 900 - i * 60, earnings: 2400 - i * 180, cash_earnings: 800 - i * 60,
  rating: +(4.9 - i * 0.08).toFixed(2),
}))));


/* ── the fifteen routes that were falling through to the catch-all ────────
   Every one of these was answered with `[]` by the catch-all below, so the
   browser smoke test rendered these pages against nothing and passed. One of
   them — /api/drivers/cross-platform, fixtured above — actually returns an
   object, and the UI called .filter on it: the Drivers page threw in
   production while the smoke run reported 76/76. A fixture that does not exist
   is not a neutral omission; it is a fixture with the wrong shape. */

app.get('/api/trips/hourly', (_, r) => r.json(
  Array.from({ length: 24 }, (_, h) => ({
    h, trips: Math.round(20 + 60 * Math.exp(-((h - 19) ** 2) / 18) + 25 * Math.exp(-((h - 8) ** 2) / 8)),
  }))));

app.get('/api/trips/heatmap', (_, r) => r.json(
  Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, h) => ({
    dow, h, trips: Math.round(4 + 22 * Math.exp(-((h - 19) ** 2) / 20) * (dow === 5 || dow === 6 ? 1.5 : 1)),
  }))).flat()));

app.get('/api/vehicles', (_, r) => r.json(plates.map((p, i) => ({
  plate: p, fleet_id: i % 3 ? 'ecosine' : 'egari',
  // Never summed: an FMS row is the same physical journey a platform reported.
  bookings: 120 - i * 11, telematics_journeys: 140 - i * 9,
  has_distance_n: 100 - i * 9,
  km: 3200 - i * 260, avg_km: +(14 - i * 0.4).toFixed(1),
  revenue: i % 3 === 2 ? null : 4800 - i * 380,
  priced_n: i % 3 === 2 ? 0 : 90 - i * 8,
  drivers: 1 + (i % 3), platforms: 2 + (i % 2),
  current_driver: drivers[i], current_driver_id: `drv-${i}`,
  last_fix: new Date(Date.now() - i * 9e5).toISOString(), stale: i === 7,
}))));

app.get('/api/track', (req, r) => {
  const n = 48; let lat = 25.11, lng = 55.2;
  r.json(Array.from({ length: n }, (_, i) => {
    lat += rnd(-0.004, 0.006); lng += rnd(-0.005, 0.006);
    return { captured_at: new Date(Date.now() - (n - i) * 3e5).toISOString(),
      lat: +lat.toFixed(5), lng: +lng.toFixed(5),
      speed: i % 8 < 2 ? 0 : Math.round(rnd(15, 85)),
      seat_occupied: i % 6 === 5 ? null : i % 3 !== 0,
      ignition: i % 8 >= 1, status: i % 3 === 0 ? 'Engaged' : 'Active', source: 'cabman' };
  }));
});

app.get('/api/finance/ledger', (_, r) => r.json([
  { category: 'trip_fare', n: 812, amount: 96540.5, currency: 'AED' },
  { category: 'commission', n: 812, amount: -21238.9, currency: 'AED' },
  { category: 'tip', n: 96, amount: 1840, currency: 'AED' },
  { category: 'cash_collected', n: 402, amount: -38210.25, currency: 'AED' },
  { category: 'promotion', n: 44, amount: 2610, currency: 'AED' },
  { category: 'toll', n: 233, amount: -932, currency: 'AED' },
]));

const UN_VERDICTS = [
  { verdict: 'unauthorized', n: 21, km: 268, minutes: 640 },
  { verdict: 'authorized', n: 190, km: 2480, minutes: 5120 },
  { verdict: 'sensor_suspect', n: 12, km: 40, minutes: 1900 },
  { verdict: 'partial', n: 9, km: 88, minutes: 210 },
  { verdict: 'unverifiable', n: 6, km: 51, minutes: 130 },
  { verdict: 'stationary', n: 31, km: 2, minutes: 900 },
];
app.get('/api/unauthorized/summary', (_, r) => {
  const by = Object.fromEntries(UN_VERDICTS.map((v) => [v.verdict, v.n]));
  r.json({
    byVerdict: UN_VERDICTS,
    totals: {
      unauthorized: by.unauthorized, authorized: by.authorized,
      unverifiable: by.unverifiable, pending: 0, partial: by.partial,
      sensor_suspect: by.sensor_suspect, stationary: by.stationary,
      unauth_km: 268, low_confidence: 6,
    },
  });
});

app.get('/api/unauthorized/list', (req, r) => {
  const want = req.query.verdict && req.query.verdict !== 'all' ? req.query.verdict : null;
  r.json(ALL_SEGS.filter((x) => !want || x.verdict === want).slice(0, 40));
});

app.get('/api/unauthorized/by-vehicle', (_, r) => r.json(plates.map((p, i) => ({
  plate: p, unauthorized: Math.max(0, 6 - i), authorized: 20 + i,
  sensor_suspect: i % 3, unauth_km: Math.max(0, 70 - i * 11),
  drivers: i % 5 === 4 ? null : drivers[i],
}))));

app.get('/api/unauthorized/daily', (_, r) => r.json(
  Array.from({ length: 21 }, (_, i) => ({
    d: `2026-08-${String(i + 1).padStart(2, '0')}`,
    unauthorized: i % 4 === 0 ? 3 : i % 3 === 0 ? 1 : 0,
    authorized: 8 + (i % 5), total: 12 + (i % 6),
  }))));

app.get('/api/sensor-health', (_, r) => r.json(plates.map((p, i) => ({
  plate: p, occupied_fixes: i === 2 ? 0 : 400 - i * 40,
  unreported_fixes: i % 4 === 3 ? 900 : 0,
  total_fixes: 2400 - i * 90,
  occupied_pct: i === 2 ? 0 : +(18 - i).toFixed(1),
  sensor_suspect_segments: i % 5 === 1 ? 4 : 0,
}))));

app.get('/api/platforms', (_, r) => r.json([
  { platform: 'uber', fleet_id: 'ecosine', trips: 30410, earliest: '2025-08-21T04:00:00Z', latest: '2026-08-21T18:00:00Z' },
  { platform: 'fms', fleet_id: 'ecosine', trips: 38970, earliest: '2025-08-21T02:00:00Z', latest: '2026-08-21T19:00:00Z' },
  { platform: 'hotel', fleet_id: 'ecosine', trips: 1256, earliest: '2026-07-07T05:00:00Z', latest: '2026-08-21T16:00:00Z' },
  { platform: 'bolt', fleet_id: 'egari', trips: 67, earliest: '2026-08-18T06:00:00Z', latest: '2026-08-21T17:00:00Z' },
  { platform: 'yango', fleet_id: 'egari', trips: 4, earliest: '2026-08-18T09:00:00Z', latest: '2026-08-21T12:00:00Z' },
]));

app.get('/api/coverage', (_, r) => r.json({
  trips: [
    { platform: 'uber', n: 30410, from_ts: '2025-08-21T04:00:00Z', to_ts: '2026-08-21T18:00:00Z' },
    { platform: 'fms', n: 38970, from_ts: '2025-08-21T02:00:00Z', to_ts: '2026-08-21T19:00:00Z' },
    { platform: 'hotel', n: 1256, from_ts: '2026-07-07T05:00:00Z', to_ts: '2026-08-21T16:00:00Z' },
  ],
  telemetry: [{ source: 'cabman', n: 412880, last_poll: new Date().toISOString() }],
  alerts: [{ n: 1904, latest: '2026-08-21T14:20:00Z' }],
  ledger: [{ n: 2399, latest: '2026-08-20T21:00:00Z' }],
}));

app.get('/api/product/by-vehicle', (_, r) => r.json(
  plates.flatMap((p, i) => ['UberX', 'Comfort', 'Black'].slice(0, 1 + (i % 3)).map((product, j) => ({
    plate: p, product, trips: 60 - i * 4 - j * 12,
    km: 900 - i * 60 - j * 100, avg_km: +(13 + j * 3).toFixed(1),
  })))));

app.get('/api/schema/raw-fields', (req, r) => r.json({
  table: req.query.table || 'trip', platform: req.query.platform || null,
  rows_with_raw: 30410, sampled: 4000,
  fields: [
    { key: 'Trip UUID', fill_pct: 100, distinct_values: 4000, examples: ['3f2a…'], already_a_column: true },
    { key: 'Surge multiplier', fill_pct: 12, distinct_values: 7, examples: ['1.0', '1.4', '2.1'], already_a_column: false },
    { key: 'Wait time (min)', fill_pct: 88, distinct_values: 40, examples: ['2', '5'], already_a_column: false },
    { key: 'Number plate', fill_pct: 99, distinct_values: 96, examples: ['L46174'], already_a_column: true },
    { key: 'Rider rating given', fill_pct: 61, distinct_values: 5, examples: ['5', '4'], already_a_column: false },
  ],
}));

app.get('/api/settings', (_, r) => r.json([
  { key: 'UBER_WEB_COOKIE', group: 'Uber', label: 'Supplier portal cookie', hint: 'Paste from a logged-in supplier.uber.com session',
    secret: true, source: 'unset', configured: false, value: '', updated_at: null },
  { key: 'CABMAN_PASS', group: 'CABMAN', label: 'Password', hint: null,
    secret: true, source: 'environment', configured: true, value: '••••••••7f2a', updated_at: null },
  { key: 'HOTEL_TOKEN', group: 'Hotel', label: 'Bearer token', hint: null,
    secret: true, source: 'settings', configured: true, value: '••••••••b91c', updated_at: '2026-08-20T09:00:00Z' },
  { key: 'BACKFILL_MONTHS', group: 'Collection', label: 'Months of history', hint: 'How far back a backfill reaches',
    secret: false, source: 'environment', configured: true, value: '12', updated_at: null },
]));

// Anything not fixtured above answers with an empty list rather than a 404,
// so a new page renders its own empty state instead of the view error box.
app.get(/^\/api\//, (_, r) => r.json([]));
app.use(express.static(join(__dir, 'api', 'public')));
app.get('*', (_, r) => r.sendFile(join(__dir, 'api', 'public', 'index.html')));
app.listen(8099, () => console.log('mock api on http://localhost:8099'));
