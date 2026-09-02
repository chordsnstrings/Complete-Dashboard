// Local stand-in API so the UI can be reviewed without the production database.
// Not shipped — used only to render and screenshot the dashboard during development.
import express from 'express';
import { foldGrain, grainOf, previousWindow, PERIODS } from './api/window.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const app = express();
const plates = ['L45235', 'L12615', 'L46174', 'L40971', 'L94178', 'L36397', 'L76098', 'L82923'];
/* One person's category, in one place. The roster fixture and the cohort
   drill-down fixture both read it, so a mock driver who is "stopped
   everywhere" on one screen is not "active, 60 bookings" on the next — which
   is the exact contradiction the drill-down exists to make impossible, and a
   fixture that fakes it teaches the smoke test to accept it. */
const ROSTER_CATS = ['working', 'working', 'working', 'idle_this_window',
  'never_started', 'in_pipeline', 'blocked', 'working'];
const catOf = (id) => {
  const i = /^drv-(\d+)$/.test(String(id)) ? Number(String(id).slice(4)) : -1;
  return i < 0 ? 'working' : ROSTER_CATS[i % ROSTER_CATS.length];
};
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
  fuel_level: i % 3 === 2 ? null : 40 + i * 5, ac_on: i % 2 === 0, odometer: 190000 + i * 1400,
  current_driver: drivers[i], driver_as_of: '2026-08-21',
}))));

/* The replay day picker reached exactly 400 rows in production, which is what
   a cap looks like when it has bitten and nothing says so: the day a reader is
   looking for is simply not in the menu. */
app.get('/api/map/days', (_, r) => {
  const rows = plates.map((p, i) => ({
    day: '2026-08-21', plate: p, fixes: 40 - i, driver_name: drivers[i], fleet_id: 'ecosine',
    first_fix: '2026-08-21T02:10:00Z', last_fix: '2026-08-21T19:40:00Z',
    max_speed: 90 - i * 3, occupied_fixes: 20 - i,
    // The id, so the day list can open the person rather than only name them.
    driver_ext_id: `drv-${i}`, driver_trips: 12 - i, current_driver_name: drivers[i],
  }));
  /* A bare array: the map's day picker has no front-end item pairing with this
     change, so the three facts ride on the row rather than reshaping it.

     Truncated ON PURPOSE, so the note that says the picker was cut is reachable
     from the fixture. Production reached exactly 400 rows, which is what a cap
     looks like when it has bitten, and a mock that always returns everything
     cannot exercise the branch that says so. */
  r.json(rows.map((x) => ({ ...x, total: rows.length + 63, shown: rows.length, truncated: true })));
});

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
    driver: 'Ahmed Tarig Mohamed', driver_id: 'drv-0', driver_trips: 7,
    // Bounds of the track, so the page can say what window it is showing.
    first_fix: pts[0].t, last_fix: pts[pts.length - 1].t,
    distance_km: 83.4, moving_km: 78.1, occupied_km: 31.2 });
});

/* Deliberately not all-green: one rollup late, so the Sources page's stale
   branch is exercised by the browser smoke test rather than only existing. */
app.get('/api/cache-stats', (_q, r) => r.json(
  { hit: 1840, stale: 310, miss: 260, skip: 92, entries: 214,
    bytes: 18_400_000, bytes_cap: 67_108_864,
    version: '2026-08-22T13:30:00.000Z|2026-08-22T13:31:00.000Z' }));

app.get('/api/rollups', (_q, r) => r.json([
  { name: 'rollup_day', status: 'ok', finished_at: new Date(Date.now() - 6 * 60000).toISOString(),
    rows_written: 4210, duration_ms: 1840, covers_from: '2025-08-21', covers_to: '2026-08-22',
    error: null, age_min: 6 },
  { name: 'rollup_month', status: 'ok', finished_at: new Date(Date.now() - 6 * 60000).toISOString(),
    rows_written: 168, duration_ms: 910, covers_from: '2025-08-21', covers_to: '2026-08-22',
    error: null, age_min: 6 },
  { name: 'rollup_person_month', status: 'ok', finished_at: new Date(Date.now() - 52 * 60000).toISOString(),
    rows_written: 1904, duration_ms: 2260, covers_from: '2025-08-21', covers_to: '2026-08-22',
    error: null, age_min: 52 },
]));

app.get('/api/status', (_, r) => r.json([
  { source: 'cabman', mode: 'realtime', status: 'ok', fleet_id: 'ecosine',
    finished_at: new Date().toISOString(),
    rows_written: 48, chunks_total: null, chunks_failed: null, failed_windows: [], windows: [],
    window_start: null, window_end: null, error: null },
  /* Two fleets, same source and mode. Keyed on (source, mode) alone one of
     these rows won and the other vanished, so a fleet that never collected at
     all read as whatever the other fleet did. */
  { source: 'uber_fleet', mode: 'incremental', status: 'ok', fleet_id: 'ecosine',
    finished_at: new Date().toISOString(), rows_written: 557, chunks_total: null,
    chunks_failed: null, failed_windows: [], windows: [], window_start: null,
    window_end: null, error: null },
  { source: 'uber_fleet', mode: 'incremental', status: 'error', fleet_id: 'egari',
    finished_at: new Date().toISOString(), rows_written: 0, chunks_total: null,
    chunks_failed: null, failed_windows: [], windows: [], window_start: null,
    window_end: null, error: 'earnings components: no earners in any of 2 week(s)' },
  // The shape that hid a 299-day hole: rows written, and most windows missing.
  { source: 'uber', mode: 'backfill', status: 'partial', fleet_id: 'ecosine',
    finished_at: new Date().toISOString(),
    rows_written: 1129, chunks_total: 12, chunks_failed: 9,
    failed_windows: [
      { from: '2025-10-23', to: '2025-11-22', error: 'download timed out after 600s for report 9f2c…' },
      { from: '2025-11-23', to: '2025-12-23', error: 'generate: {"code":"CONCURRENT_REPORT_LIMIT"}' },
      { from: '2025-12-24', to: '2026-01-23', error: 'download timed out after 600s for report 41ab…' },
    ],
    windows: [{ from: '2026-07-22', to: '2026-08-21', rows: 1129, ok: true },
      { from: '2025-10-23', to: '2025-11-22', rows: 0, ok: false }],
    window_start: '2025-08-21', window_end: '2026-08-21', error: null },
  { source: 'hotel', mode: 'incremental', status: 'ok', finished_at: new Date().toISOString(),
    rows_written: 135, chunks_total: 1, chunks_failed: 0, failed_windows: [], windows: [],
    window_start: '2026-08-14', window_end: '2026-08-21', error: null },
  { source: 'fms', mode: 'incremental', status: 'ok', finished_at: new Date().toISOString(),
    rows_written: 416, chunks_total: 1, chunks_failed: 0, failed_windows: [], windows: [],
    window_start: '2026-08-14', window_end: '2026-08-21', error: null },
  // A source that failed outright, with the driver message the page shows.
  { source: 'bolt', mode: 'incremental', status: 'error', finished_at: new Date().toISOString(),
    rows_written: 0, chunks_total: 1, chunks_failed: 1, failed_windows: [], windows: [],
    window_start: '2026-08-14', window_end: '2026-08-21',
    error: 'bolt: refresh token rejected (401) — re-paste from the fleet portal' },
]));
app.get('/api/kpis', (req, r) => r.json({ trips: 2043, km: 23120, avg_km: 12.03, completion_pct: 89,
  cancel_pct: 10.7, drivers: 56, drivers_seen: 58, vehicles: 52, vehicles_seen: 55, revenue: 41188, live_vehicles: 48, fresh: 44,
  /* Liveness is measured on the FIX, so a fleet always has trackers listed
     that have stopped answering — the mock carries some, or a page that
     renders them would never be exercised. */
  silent_vehicles: 6, tracked_vehicles: 61, alerts: 8863,
  // The two fields that stop the Trips and Revenue tiles overstating themselves.
  telematics_journeys: 2657, telematics_km: 31840, priced_trips: 187, avg_fare: 220.3,
  bookable_trips: 2043, priced_km: 3990, revenue_per_km: 10.32,
  // Coverage: how much of the headline each figure was actually measured over.
  completed_trips: 1818, cancelled_trips: 225, trips_with_distance: 1996, attributed_trips: 1930,
  platforms: 4, priced_pct: 9.2, attributed_pct: 94.5,
  // The numerator revenue_per_km is actually over, and the bookings that
  // belong to no vehicle at all — without which the vehicle table sums to
  // fewer trips than the fleet and nothing says why.
  priced_measured_revenue: 39200, priced_measured_trips: 178, trips_without_vehicle: 15,
  /* Platform payouts, and the two channels together. Revenue is sum(price) over
     the trip table and covers 9% of trips on this fleet, so the headline was
     the hotel channel presented as the whole business. */
  payouts: 196178, payout_cash: 834.44, payout_days: 28, payout_drivers: 148,
  payout_platforms: ['uber', 'yango'], payout_coverage_pct: 93.3,
  /* accounted is the best figure PER PLATFORM summed, so it is not fares plus
     payouts: yango reports both here and is counted on its payout only. */
  accounted: 237366, accounted_fares: 41188, accounted_payouts: 196178,
    statement_net: 96480, statement_platforms: ['bolt', 'hotel', 'uber', 'yango'],
  accounted_bookings: 2043, accounted_platforms: ['hotel', 'uber', 'yango'],
  dark_bookings: 0, dark_pct: 0,
  window: { from: '2026-07-31', to: '2026-08-29', days: 30,
    period: PERIODS.includes(String(req.query.period || '')) ? String(req.query.period) : null,
    grain: grainOf(req),
    partial: ['today', 'week', 'month', 'quarter', 'year'].includes(String(req.query.period || '')) },
}));
app.get('/api/compare/period', (req, r) => {
  const from = req.query.from || '2026-07-31', to = req.query.to || '2026-08-29';
  const [pf, pt] = previousWindow([from, to]);
  const now = { drivers: 56, trips: 2043, completed: 1824, cancelled: 219, km: 23120,
    money: 237366, stmt_net: 96480, fares: 41188, tips: 1204, cash: 8930, payout: 196178,
    online_min: 331200, on_job_min: 66600, money_days: 1580, driver_days: 1640 };
  const before = { drivers: 48, trips: 1688, completed: 1502, cancelled: 186, km: 19040,
    money: 196020, stmt_net: 79700, fares: 34010, tips: 990, cash: 7420, payout: 162100,
    online_min: 287400, on_job_min: 55100, money_days: 1310, driver_days: 1370 };
  const pct = (k) => (before[k] ? Math.round(((now[k] - before[k]) / before[k]) * 1000) / 10 : null);
  r.json({ window: { from, to, grain: grainOf(req), period: req.query.period || null },
    previous: { from: pf, to: pt }, now, before,
    change_pct: Object.fromEntries(Object.keys(now).map((k) => [k, pct(k)])),
    basis: 'Summed from driver_day — one row per driver per day carrying both the work and the money.' });
});
app.get('/api/insights/summary', (_, r) => r.json({ total: { n: 93, total_impact: '19800' },
  by_severity: [{ severity: 'critical', n: 85, impact: '19800' }, { severity: 'warning', n: 8, impact: null }],
  by_category: [{ category: 'utilisation', n: 55 }, { category: 'compliance', n: 35 }],
  // Modelled vs stored: the page must not present a projection as a record.
  modelled: false, stored_rows: 93, resolved_since_last_run: 6, duplicates_suppressed: 4,
  filter: { fleet: null, platform: null }, platform_applies: false }));

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
  /* The filter the answer was narrowed by. #action/<code>/<id> used to fetch
     the whole 200-row list and search it in the browser, so the four findings
     the cap cut answered "no longer open" on their own pages while appearing
     in the category chips. */
  /* Findings the rules have stopped emitting since they last wrote them. The
     list only carries what the latest run of each rule still finds, so a to-do
     list that shortens overnight can say why. */
  r.json({ insights: rows, truncated: false, limit: 200, cleared: 6,
    filter: { severity: req.query.severity || null, category: req.query.category || null,
      code: req.query.code || null, entity_id: req.query.entity_id || null,
      fleet: req.query.fleet || null, from: null, to: null } });
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
  /* Platform is accepted and NOT applied, and says so: an insight is about a
     vehicle, a driver or the fleet, and the generator never records which
     booking channel it came from. */
  filter: { fleet: null, platform: null },
  platform_applies: false,
}));
let _doc = 0;
const mkDoc = (plate, make, model, days, drv) => ({
  plate, make, model, year: 2023, doc_type: 'Vehicle Registration Form',
  status: 'ACTIVE', expires_at: new Date(Date.now() + days * 864e5).toISOString(),
  days_left: days, driver_name: drv,
  // The id, so a document about to expire names somebody you can open rather
  // than only somebody you can read; and the day that custody is drawn from,
  // because "held by X" means something different if it is eleven weeks old.
  driver_ext_id: drv ? `drv-${_doc++ % 8}` : null,
  driver_as_of: drv ? '2026-08-21' : null,
  vin: `VIN${String(1000 + _doc)}`, image_url: null,
});
app.get('/api/compliance/vehicles', (_, r) => {
  const rows = [
  mkDoc('L40924','Tesla','Model Y',5,'Ahmed Tarig Mohamed'), mkDoc('L37810','Tesla','Model Y',5,'Aliyan Khalil'),
  mkDoc('L20048','Tesla','Model Y',5,'Najeeb Ullah Khan'), mkDoc('L41452','BYD','Han EV',5,'Asad Khan Khan'),
  mkDoc('L40959','BYD','Han EV',5,null), mkDoc('L39421','Tesla','Model Y',13,'Roy Ocdol'),
  mkDoc('L40547','Tesla','Model Y',13,null), mkDoc('L44259','Lexus','ES 300h',33,'Muhammad Khalid Gul'),
];
  // Totals come from the database in production, not from the list —
  // the page's legal claims must not be a filter over a capped array.
  const dl = (x) => Number(x.days_left);
  r.json({ rows,
    totals: { total: rows.length + 40, vehicles: 96, doc_types: 1,
      expired: rows.filter((x) => dl(x) < 0).length,
      within_7: rows.filter((x) => dl(x) >= 0 && dl(x) <= 7).length,
      within_45: rows.filter((x) => dl(x) > 7 && dl(x) <= 45).length },
    doc_types: [{ doc_type: 'registration', n: rows.length + 40 }],
    // Which fleet was asked for. Both chips reached this page and neither
    // narrowed it, so a two-fleet operator read one list under either heading.
    fleet: null,
    shown: rows.length, truncated: true });
});
app.get('/api/compliance/drivers', (_, r) => r.json({
  totals: { total: 148, with_date: 96, expired: 2, within_45: 5, no_date_at_all: 52 },
  shown: 8, truncated: false,
  drivers: [
    // Six rows carrying the identical placeholder the source writes when the
    // field was never filled in, plus two real dates.
    ...Array.from({ length: 6 }, (_, i) => ({ platform: 'hotel', driver_ext_id: `d${10 + i}`,
      full_name: drivers[i], phone: '+9715000000', licence_no: '123456', fleet_id: 'ecosine',
      licence_expires: '2026-01-01', days_left: -232, state: 'active',
      /* Not expired — never entered. The directory counted all 77 of these into
         "77 with an expired licence" and painted red pills, while this endpoint
         reported expired: 0 about the same people. */
      licence_placeholder: true,
      suspension_reason: null, rating: 4.8 - i * 0.05,
      /* Whether the expiry matters. Three shapes, because the column renders
         three: somebody who drove this week, somebody idle for months, and
         somebody who has never driven at all. The middle one is matched by
         NAME rather than by platform id, which is how most of these rows
         resolve on production. */
      last_ever: i === 5 ? null : new Date(Date.now() - (i === 0 ? 2 : 40 + i * 30) * 864e5).toISOString(),
      lifetime_trips: i === 5 ? 0 : 1400 - i * 120,
      days_since_last_trip: i === 5 ? null : (i === 0 ? 2 : 40 + i * 30),
      activity_by_name: i === 1 || i === 2,
      // A licence expiring is a CAR that stops earning. The row names it.
      vehicle: { plate: plates[i % plates.length], day: '2026-08-21' } })),
    { platform: 'bolt', driver_ext_id: 'd2', full_name: 'Abdelmohsen Said', phone: '+9715000001',
      licence_no: 'AE1802580', licence_expires: '2026-09-20', days_left: 30, state: 'suspended',
      fleet_id: 'egari', licence_placeholder: false,
      suspension_reason: 'documents under review', rating: 4.71,
      vehicle: { plate: plates[2], day: '2026-08-19' } },
    { platform: 'hotel', driver_ext_id: 'd3', full_name: 'Aliyan Khalil', phone: null,
      licence_no: 'AE9911', licence_expires: '2026-08-01', days_left: -20, state: 'active',
      fleet_id: 'ecosine', licence_placeholder: false,
      suspension_reason: null, rating: null,
      // Nobody has held this person's car in the window we have custody for.
      vehicle: null },
  ],
  fleet: null, placeholder_date: '2026-01-01', placeholder_rows: 6, rows_with_a_date: 8,
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
      // The denominator the day's completion rate is over — the trips whose
      // platform reported an outcome at all, which excludes telematics rows.
      outcome_n: trips,
      km: +km.toFixed(1), revenue: +(km * rnd(2.1, 3.4)).toFixed(2),
      first_trip_at: `${dayISO(b)}T0${Math.floor(first)}:00:00Z`,
      last_trip_at: `${dayISO(b)}T18:00:00Z`,
      first_hour: +first.toFixed(2), last_hour: +(first + rnd(8, 12)).toFixed(2),
      span_h: +rnd(8, 12).toFixed(2), plates: plates[seed % plates.length],
      platforms: 'uber', hours_online: +rnd(8, 12).toFixed(2),
      /* The basis, because the endpoint reports one per day: the platform's own
         daily figure where a channel files one, and the availability feed's
         ONLINE spans where it does not. On this fleet it is availability for
         every day, so the fixture makes that the common case and keeps one
         platform day so a page cannot assume a single basis. */
      hours_online_basis: b % 11 === 0 ? 'platform' : 'availability',
      hours_on_job: +rnd(4, 8).toFixed(2),
      hours_idle_online: +rnd(1, 4).toFixed(2),
      platform_earnings: b % 11 === 0 ? +rnd(250, 620).toFixed(2) : null,
      /* What the day was worth from whichever feed measured it, and what that
         feed was. Fares are null on an Uber day — the export carries no fare
         column — so a fixture whose money came only from `revenue` would let a
         page that shows fares alone still look populated. */
      money: +(km * rnd(2.4, 3.9)).toFixed(2),
      money_source: b % 4 === 0 ? 'mixed' : 'statement',
      /* The window that money was measured over. Uber files this fleet weekly,
         so most of these are a seventh of a week rather than a day somebody
         measured — a fixture where every day looked measured would let a page
         that states an allocation as a fact still look right. */
      money_period_days: b % 4 === 0 ? 1 : 7,
      temp_max: +rnd(33, 44).toFixed(1), precipitation: 0, is_ramadan: false,
    });
  }
  return out;
};

/* The performer pages. Shapes chosen to exercise what the real data does:
   most bookings carry an end time and some do not, one channel prices its
   trips and the other pays a statement, and the Uber status rows exist for
   one org only — so the "no status for this person" branch is reachable. */
/* Three weeks, not one, and one of them far enough back that a picker which
   silently pins itself to the newest is visible as a bug rather than as a
   coincidence. `first_booking` is what the control quotes as its reach. */
app.get('/api/performer/weeks', (_, r) => r.json({
  weeks: [{ week: '2026-08-17', to: '2026-08-23' }, { week: '2026-08-10', to: '2026-08-16' },
    { week: '2025-11-03', to: '2025-11-09' }],
  latest_complete: '2026-08-17',
  first_booking: '2025-11-03',
  last_booking: '2026-08-23',
}));
app.get('/api/performer', (req, r) => {
  const solo = String(req.query.id || '').endsWith('9');
  /* The week the caller asked for, echoed. The mock answered for one fixed
     week whatever it was handed, so a page that dropped the week on the way to
     the endpoint looked identical to one that carried it. */
  const wk = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.week || ''))
    ? String(req.query.week) : '2026-08-17';
  const end = new Date(new Date(`${wk}T12:00:00Z`).getTime() + 6 * 864e5).toISOString().slice(0, 10);
  return r.json({
    week: [wk, end],
    driver_ext_id: String(req.query.id || 'drv-0'),
    name: solo ? 'Roy Vellespen Ocdol' : 'Ahmed Tarig Mohamed',
    /* Days OF THE ASKED-FOR WEEK. They were five fixed dates in August, so a
       November week came back headed November and filled with August. */
    days: [0, 1, 2, 3, 4].map((i) => {
      const day = new Date(new Date(`${wk}T12:00:00Z`).getTime() + i * 864e5)
        .toISOString().slice(0, 10);
      return {
      day, bookings: 12 - i, completed: 11 - i, cancelled: i % 2,
      km: 140 - i * 9, fares: i === 0 ? 320 : null,
      first_trip: `${day}T04:${10 + i}:00.000Z`,
      last_trip: `${day}T16:${20 + i}:00.000Z`,
      plates: ['L44251'], platforms: ['uber'],
      on_trip_min: 300 - i * 20, elapsed_min: 720,
      /* The gaps between bookings. Day 3 deliberately reports none — a day
         with one booking has no gap to measure — and day 1 reports an
         overlap, because on this fleet a next request often precedes the
         previous dropoff and the waiting column must not go negative. */
      wait_min: i === 3 ? null : 300 + i * 15,
      longest_wait_min: i === 3 ? null : 90 + i * 10,
      median_wait_min: i === 3 ? null : 18 + i,
      gaps: i === 3 ? 0 : 11 - i, overlaps: i === 1 ? 2 : 0,
    }; }),
    areas: [{ area: 'Business Bay', picked_up: 22, stayed: 6 },
      { area: 'Downtown Dubai', picked_up: 14, stayed: 3 },
      { area: '(unrecorded)', picked_up: 2, stayed: 0 }],
    platform_status: solo ? [] : [
      { day: '2026-08-18', status: 'ONTRIP', n: 9, first_seen: '2026-08-18T08:40:00.000Z', last_seen: '2026-08-18T15:10:00.000Z' },
      { day: '2026-08-18', status: 'ONLINE', n: 14, first_seen: '2026-08-18T08:05:00.000Z', last_seen: '2026-08-18T16:02:00.000Z' },
    ],
    platforms: [{ platform: 'uber', bookings: 48, km: 600, fares: null, priced: 0 },
      { platform: 'hotel', bookings: 6, km: 90, fares: 1320, priced: 6 }],
    payouts: [{ platform: 'uber', driver_ext_id: 'drv-0', payout: 1840.25, payout_days: 7,
      period_start: '2026-08-17', period_end: '2026-08-23' }],
    on_trip_min: 1240, timed_bookings: 50, bookings: 54, duration_coverage_pct: 93,
    wait_min: 1290, overlaps: 2,
    note: '4 of 54 bookings carry no end time, so on-trip minutes are measured over the rest.',
  });
});

/* Two days beside each other. The fixture is built so the page's awkward
   branches are all reachable: one driver worked the earlier day and has not
   appeared on the later one, one is new on the later day, one channel reports
   a fare and the other reports none, and the cut is partial so the
   "still running" caption and the whole-day footnote both render. */
app.get('/api/compare', (req, r) => {
  const a = /^\d{4}-\d{2}-\d{2}$/.test(req.query.a || '') ? req.query.a : '2026-08-25';
  const b = /^\d{4}-\d{2}-\d{2}$/.test(req.query.b || '') ? req.query.b : '2026-08-24';
  const full = String(req.query.cut || '') === 'full';
  const cut = full ? 1440 : 795;
  const at = (day, h, m) => `${day}T${String(h - 4).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
  const side = (day, n, k) => ({
    bookings: n, completed: n - 1, cancelled: 1, km: k, fares: n > 6 ? 210 : null,
    first_trip: at(day, 6, 12), last_trip: at(day, 12, 40),
    on_trip_min: n * 21, wait_min: n * 12, longest_wait_min: 55, overlaps: n > 8 ? 1 : 0,
    platforms: ['uber'], plates: ['L44251'],
  });
  const person = (i, name, onA, onB) => ({
    pk: `drv-${i}`, driver_ext_id: `drv-${i}`, driver_name: name, fleet_id: 'ecosine',
    a: onA ? side(a, 11 - i, 120 - i * 8) : { bookings: 0, completed: 0, cancelled: 0, km: null,
      fares: null, first_trip: null, last_trip: null, on_trip_min: null, wait_min: null,
      longest_wait_min: null, overlaps: 0, platforms: [], plates: [] },
    b: onB ? side(b, 8 - i, 96 - i * 6) : { bookings: 0, completed: 0, cancelled: 0, km: null,
      fares: null, first_trip: null, last_trip: null, on_trip_min: null, wait_min: null,
      longest_wait_min: null, overlaps: 0, platforms: [], plates: [] },
    worked_a: onA, worked_b: onB,
    plates: ['L44251'], platforms: ['uber'],
    d_bookings: (onA ? 11 - i : 0) - (onB ? 8 - i : 0),
    d_km: 0, d_on_trip_min: 0, d_wait_min: 0,
  });
  const roster = [person(0, drivers[0], true, true), person(1, drivers[1], true, true),
    person(2, drivers[2], false, true), person(3, drivers[3], true, false)];
  return r.json({
    days: [a, b],
    is_today: { a: true, b: false },
    cut_minutes: cut, cut_label: full ? '24:00' : '13:15',
    cut_mode: full ? 'full' : 'now',
    cut_note: full ? 'Both days counted in full.'
      : 'Both days counted up to 13:15 Dubai, so a fall means less work done by the same hour '
        + '— not a day that has not finished yet.',
    totals: {
      a: { bookings: 34, completed: 31, cancelled: 3, telematics: 12, km: 410, fares: 640,
        priced: 4, drivers: 3, vehicles: 4, first_at: at(a, 5, 2), last_at: at(a, 13, 1),
        on_trip_min: 690, timed: 30 },
      b: { bookings: 41, completed: 38, cancelled: 3, telematics: 15, km: 505, fares: 820,
        priced: 6, drivers: 3, vehicles: 4, first_at: at(b, 4, 51), last_at: at(b, 13, 8),
        on_trip_min: 810, timed: 37 },
    },
    full_day: { a: { day: a, bookings: 34, km: 410, fares: 640, drivers: 3 },
      b: { day: b, bookings: 58, km: 720, fares: 1180, drivers: 4 } },
    hours: [...Array(24).keys()].map((h) => ({
      hour: h, a: h < 13 ? (h % 5) + 1 : 0, b: (h % 6) + 1,
      a_cancelled: h === 9 ? 1 : 0, b_cancelled: 0, past_cut: h * 60 >= cut })),
    /* Uber prices nothing and is paid; the hotel channel prices everything and
       has no statement; and one day of the Uber row falls outside the payout
       horizon, so its money comes from the operator's ledger instead. All
       three branches of the Paid column are reachable from here. */
    platforms: [
      { platform: 'uber',
        a: { n: 28, completed: 26, cancelled: 2, km: 340, fares: null, paid: 2140, statement_net: null },
        b: { n: 33, completed: 31, cancelled: 2, km: 400, fares: null, paid: null, statement_net: 2510 },
        d: -5 },
      { platform: 'hotel',
        a: { n: 6, completed: 5, cancelled: 1, km: 70, fares: 640, paid: null, statement_net: null },
        b: { n: 8, completed: 7, cancelled: 1, km: 105, fares: 820, paid: null, statement_net: null },
        d: -2 },
    ],
    drivers: roster,
    stopped: [{ driver_ext_id: 'drv-2', driver_name: drivers[2], bookings: 6, plates: ['L44251'] }],
    started: [{ driver_ext_id: 'drv-3', driver_name: drivers[3], bookings: 8, plates: ['L45235'] }],
    collectors: [
      { source: 'uber', last_run: new Date(Date.now() - 6e5).toISOString(),
        last_ok: new Date(Date.now() - 6e5).toISOString(), rows_24h: 412 },
      /* Deliberately stale, so the warning branch and the pill both render. */
      { source: 'bolt', last_run: new Date(Date.now() - 5 * 864e5).toISOString(),
        last_ok: null, rows_24h: 0 },
    ],
    fleet: req.query.fleet || null, platform: req.query.platform || null,
  });
});

/* The provenance record: one row per API surface, per channel, per kind.
   Deliberately shaped like production — a channel whose fares win and whose
   payout is therefore held out, a weekly payout beside a daily one, the park
   ledger nothing has ever counted, and an operator import. */
app.get('/api/money/sources', (_, r) => r.json({
  window: { from: dayISO(DAYS), to: dayISO(0) },
  rows: [
    /* The shape production actually has: a provider serving the same
       driver-week weekly AND daily, so most of what it returned restates days
       another figure already covers. */
    { source: 'uber_graphql_breakdown', platform: 'uber', fleet_id: 'ecosine', kind: 'payout',
      rows_seen: 412, reported_days: 96, period_rows: 316, restated_rows: 188, categories: 0,
      amount: 196178, restated_amount: 74738, amount_not_restated: 121440,
      first_period: dayISO(DAYS), last_period: dayISO(0), max_period_days: 7,
      drivers: 88, last_seen: new Date().toISOString() },
    { source: 'hotel_trip_report', platform: 'hotel', fleet_id: 'egari', kind: 'fare',
      rows_seen: 867, reported_days: 867, period_rows: 0, restated_rows: 0, categories: 0, amount: 39892, restated_amount: 0, amount_not_restated: 39892,
      first_period: dayISO(DAYS), last_period: dayISO(0), max_period_days: 1,
      drivers: 21, last_seen: new Date().toISOString() },
    { source: 'yango_orders', platform: 'yango', fleet_id: 'ecosine', kind: 'fare',
      rows_seen: 19, reported_days: 19, period_rows: 0, restated_rows: 0, categories: 0, amount: 1296, restated_amount: 0, amount_not_restated: 1296,
      first_period: dayISO(DAYS), last_period: dayISO(0), max_period_days: 1,
      drivers: 4, last_seen: new Date().toISOString() },
    { source: 'yango_driver_summary', platform: 'yango', fleet_id: 'ecosine', kind: 'payout',
      rows_seen: 6, reported_days: 0, period_rows: 6, restated_rows: 0, categories: 0, amount: 5612, restated_amount: 0, amount_not_restated: 5612,
      first_period: dayISO(DAYS), last_period: dayISO(0), min_overlap_days: 2, max_period_days: 7,
      drivers: 4, last_seen: new Date().toISOString() },
    { source: 'uber_rest_payments', platform: 'uber', fleet_id: 'ecosine', kind: 'component',
      rows_seen: 1204, reported_days: 0, period_rows: 1204, restated_rows: 0, categories: 6, amount: 188422, restated_amount: 0, amount_not_restated: 188422,
      first_period: dayISO(DAYS), last_period: dayISO(0), max_period_days: 7,
      drivers: 88, last_seen: new Date().toISOString() },
    { source: 'yango_park_ledger', platform: 'yango', fleet_id: 'ecosine', kind: 'ledger',
      rows_seen: 143, reported_days: 143, period_rows: 0, restated_rows: 0, categories: 4, amount: -2260, restated_amount: 0, amount_not_restated: -2260,
      first_period: dayISO(DAYS), last_period: dayISO(0), max_period_days: 1,
      drivers: 4, last_seen: new Date().toISOString() },
    { source: 'statement_import', platform: 'uber', fleet_id: 'ecosine', kind: 'statement',
      rows_seen: 58, reported_days: 58, period_rows: 0, restated_rows: 0, categories: 0, amount: 41207, restated_amount: 0, amount_not_restated: 41207,
      first_period: dayISO(DAYS), last_period: dayISO(0), max_period_days: 1,
      drivers: 31, last_seen: new Date().toISOString() },
  ],
  categories: [
    { source: 'uber_rest_payments', platform: 'uber', category: 'net_fare', rows_seen: 402, amount: 171204 },
    { source: 'uber_rest_payments', platform: 'uber', category: 'tip', rows_seen: 288, amount: 3958 },
    { source: 'uber_rest_payments', platform: 'uber', category: 'toll', rows_seen: 396, amount: 11290 },
    { source: 'uber_rest_payments', platform: 'uber', category: 'cash_collected', rows_seen: 118, amount: 1970 },
    { source: 'yango_park_ledger', platform: 'yango', category: 'commission', rows_seen: 96, amount: -3110 },
    { source: 'yango_park_ledger', platform: 'yango', category: 'top_up', rows_seen: 47, amount: 850 },
  ],
  note: 'Every figure here is a sum of amounts a provider itself sent, grouped by the API call '
    + 'that sent them. Nothing is allocated, spread or estimated: a weekly statement appears as '
    + 'one period row covering seven days, never as seven daily figures.',
  caveats: {
    restatements: 'A provider may report the same days more than once. `amount` is everything '
      + 'the call RETURNED and is not a total. Where `restated_rows` is zero the call reported '
      + 'each day once and its amount may be added.',
    categories: 'The categories are a TREE in the provider\'s own shape, so their sum is not a '
      + 'total of anything.',
  },
}));

app.get('/api/drivers/directory', (_, r) => r.json([
  ...drivers.map((name, i) => ({
    driver_ext_id: `drv-${i}`, ids: [`drv-${i}`], driver_name: name,
    // The stored fold the directory groups on — the same key the overview counts.
    person_key: name.toLowerCase(), fleet_id: i % 3 ? 'ecosine' : 'egari',
    trips: 420 - i * 37, completed: 400 - i * 36, bookable: 420 - i * 37,
    days: 26 - i, km: 5400 - i * 380, revenue: i === 7 ? null : 14200 - i * 900, priced_trips: i === 7 ? 0 : 60 - i * 5,
    /* Most drivers have a payout and no fare — the production shape, where
       Uber is most of the work and publishes no fare per trip. Two of them
       carry a fare and no payout, and one carries neither, so the table's
       three distinct empty states are all reachable from the mock. */
    payout: i === 1 || i === 4 ? null : 11800 - i * 700,
    payout_days: i === 1 || i === 4 ? 0 : Math.max(1, 26 - i),
    /* The one column that answers for everybody: the statement's net where a
       channel filed one and its fares where it did not, resolved per platform.
       Its grain travels with it — most of this fleet's money is a weekly Uber
       statement divided across seven days, so a fixture where every row looked
       measured would let a page stating an allocation as a fact still pass. */
    money: i === 7 ? null : 12400 - i * 780,
    money_days: i === 7 ? 0 : Math.max(1, 26 - i),
    money_period_days: i % 5 === 0 ? 1 : i === 6 ? null : 7,
    money_source: i % 5 === 0 ? 'fares' : i === 2 ? 'mixed' : 'statement',
    last_trip: new Date(Date.now() - i * 36e5).toISOString(),
    last_ever: new Date(Date.now() - i * 36e5).toISOString(), lifetime_trips: 900 - i * 60,
    first_trip: dayISO(DAYS), completion_pct: 97 - i, platforms: i % 3 === 0 ? ['uber', 'yango'] : ['uber'],
    // What the PROVIDER says about them, which is not the same as whether they
    // drove: somebody can be waitlisted and still have last month's trips.
    platform_state: i === 3 ? 'suspended' : 'active', can_earn: i !== 3,
    /* Not expired — never entered: the identical placeholder date this source
       writes for an unset field. The toolbar counted 77 of them as expired
       licences while /api/compliance/drivers reported expired: 0. */
    licence_placeholder: false,
    /* WHICH platform said it. 241 of the people in the live directory have
       never driven — the panel exists for them — and every column describing
       them was blank because the source platform was dropped on the way out. */
    compliance_platform: 'uber', state_platform: i % 3 === 0 ? 'yango' : 'uber',
    state_plate: plates[i % plates.length],
    plate: plates[i % plates.length], state: i === 3 ? 'suspended' : 'active',
    licence_expires: '2026-11-30', licence_days_left: i === 1 ? -12 : 40 + i * 9, rating: 4.9 - i * 0.06,
    /* What the PLATFORM says about the person, from Uber's GetDriver. The
       column used to read driver_compliance.rating, which never carries one,
       so it was dashes on the whole roster. One driver is left unrated and one
       barred, so both empty states and the Barred column are reachable. */
    platform_rating: i === 6 ? null : +(4.97 - i * 0.07).toFixed(2),
    platform_lifetime_trips: i === 6 ? null : 9000 - i * 640,
    is_banned: i === 3 ? true : false,
    platform_compliance: i === 3 ? 'SUSPENDED' : 'ACTIVE',
    active_in_window: true, ever_driven: true,
    // The window measured these, so they are not history-derived.
    identity_from_history: false,
  })),
  /* The two rows the directory used to omit entirely: somebody who did not
     drive in this window, and somebody who has never driven. One of them has an
     expired licence, which is exactly who this page is opened to find. */
  { driver_ext_id: 'drv-idle', ids: ['drv-idle'], driver_name: 'Saeed Al Mansoori',
    fleet_id: 'ecosine', trips: 0, completed: 0, bookable: 0, days: 0, km: null, revenue: null,
    priced_trips: 0, last_trip: null, last_ever: dayISO(96), lifetime_trips: 311,
    /* Fleet, channels and vehicle from the WHOLE HISTORY, because this window
       holds no work for them — the case that used to print a name and three
       blanks for 244 of 361 people on production. The flag is what lets the
       page draw them quieter than a measured value. */
    first_trip: null, completion_pct: null, platforms: ['uber', 'yango'],
    plate: plates[2], state: 'active', identity_from_history: true,
    licence_expires: '2026-06-01', licence_days_left: -81, rating: null,
    active_in_window: false, ever_driven: true },
  { driver_ext_id: 'drv-new', ids: ['drv-new'], driver_name: 'Faisal Rahman',
    fleet_id: 'ecosine', trips: 0, completed: 0, bookable: 0, days: 0, km: null, revenue: null,
    priced_trips: 0, last_trip: null, last_ever: null, lifetime_trips: 0,
    /* Never driven, so there is no history to fall back on either — the row
       that must stay blank, and the reason the flag is not just "is it empty". */
    first_trip: null, completion_pct: null, platforms: [], plate: null, state: 'active',
    licence_expires: null, licence_days_left: null, rating: null,
    identity_from_history: false, active_in_window: false, ever_driven: false },
]));

app.get('/api/driver/profile', (req, r) => {
  const i = idIndex(req.query.id);
  r.json({
    id: req.query.id, name: drivers[i], ids: [req.query.id],
    /* `ids` is the ACCOUNTS this person holds — what a reader is shown. `keys`
       is the superset their rows can be matched by, which includes the
       synthesised name key for the channels that name them without an id. */
    keys: [req.query.id, `name:${drivers[i].toLowerCase()}`],
    platforms: i % 3 === 0 ? ['uber', 'yango'] : ['uber'],
    span: { first_trip: dayISO(DAYS), last_trip: new Date().toISOString(), trips: 420 - i * 37,
      days_worked: 26 - i, vehicles: 2, fleet_id: i % 3 ? 'ecosine' : 'egari' },
    compliance: [{ platform: 'hotel', driver_ext_id: req.query.id, full_name: drivers[i],
      phone: '+9715012345' + i, emirates_id: '784-1990-000000' + i, licence_no: 'AE18025' + i,
      licence_expires: '2026-11-30', licence_days_left: i === 1 ? -12 : 40 + i * 9,
      state: i === 3 ? 'suspended' : 'active',
      suspension_reason: i === 3 ? 'documents under review' : null,
      rating: 4.9 - i * 0.06, updated_at: new Date().toISOString(),
      device_brand: 'Samsung', device_model: 'SM-A536E' }],
    vehicles: [
      { plate: plates[i % plates.length], days: 21, trips: 310, km: 4100, revenue: 11200,
        first_day: dayISO(DAYS), last_day: dayISO(0), ever_primary: true },
      { plate: plates[(i + 3) % plates.length], days: 5, trips: 42, km: 610, revenue: 1800,
        first_day: dayISO(18), last_day: dayISO(12), ever_primary: false },
    ],
    accounts: [{ platform: 'uber', driver_ext_id: req.query.id, trips: 380, first_trip: dayISO(DAYS), last_trip: dayISO(0) },
      ...(i % 3 === 0 ? [{ platform: 'yango', driver_ext_id: `y-${i}`, trips: 40, first_trip: dayISO(20), last_trip: dayISO(1) }] : [])],
    /* What each platform says about this person's standing. The route never
       touched driver_platform_state, so a suspended driver's own page could
       not show that they were suspended, why, or the plate they still hold —
       all of which #roster/blocked shows about the same person. */
    standing: [{ platform: 'uber', fleet_id: 'ecosine',
      state: i === 3 ? 'suspended' : 'active', state_raw: i === 3 ? 'BLOCKED' : 'ONBOARDING_STATUS_ACTIVE',
      state_reason: i === 3 ? 'documents under review' : null,
      plate: plates[i % plates.length], vehicle_ext_id: `veh-${i}`,
      score: i === 3 ? null : 88 - i, can_earn: i !== 3, observed_at: new Date().toISOString(),
      /* Uber's own word on the person, from GetDriver. Deliberately beside
         `score` rather than in it: Bolt writes a standing score there, a
         different quantity on a different scale. */
      rating: +(4.97 - i * 0.07).toFixed(2), lifetime_trips: 9000 - i * 640,
      is_banned: i === 3, compliance_status: i === 3 ? 'SUSPENDED' : 'ACTIVE',
      profile_at: new Date(Date.now() - 6 * 36e5).toISOString() }],
    /* Resolved for the header, so it does not have to fold `standing` itself.
       Not averaged across platforms — see api/driver_routes.js. */
    rating: +(4.97 - i * 0.07).toFixed(2), rating_platform: 'uber',
    rating_at: new Date(Date.now() - 6 * 36e5).toISOString(), rating_platforms: 1,
    platform_lifetime_trips: 9000 - i * 640,
    banned_on: i === 3 ? ['uber'] : [],
    platform_compliance: [{ platform: 'uber', status: i === 3 ? 'SUSPENDED' : 'ACTIVE' }],
    /* Two readings for most drivers so the direction renders, and ONE for a
       couple so the "first reading" state is reachable — a single reading must
       show that, not a change of zero. */
    rating_readings: i % 5 === 0 ? 1 : 4,
    /* The readings behind the sparkline, oldest first. One driver gets a single
       reading so the "first reading" state — which must NOT draw a flat line —
       is reachable from the mock. */
    rating_series: i % 5 === 0
      ? [{ on: dayISO(0), rating: +(4.97 - i * 0.07).toFixed(2), trips: 9000 - i * 640 }]
      : [0, 1, 2, 3].map((w) => ({
        on: dayISO(21 - w * 7),
        rating: +(4.97 - i * 0.07 - (i % 2 ? 1 : -1) * (0.02 + (i % 3) * 0.02) * (3 - w) / 3).toFixed(3),
        trips: 9000 - i * 640 - (3 - w) * 40 })),
    rating_change: i % 5 === 0 ? null : {
      change: +((i % 2 ? 1 : -1) * (0.02 + (i % 3) * 0.02)).toFixed(3), over_days: 7,
      over_trips: 120 - i * 6,
      from: +(4.97 - i * 0.07 - ((i % 3) - 1) * 0.04).toFixed(2), to: +(4.97 - i * 0.07).toFixed(2) },
  });
});

app.get('/api/driver/kpis', (req, r) => {
  const i = idIndex(req.query.id), d = dailyFor(req.query.id);
  const trips = d.reduce((a, x) => a + x.trips, 0);
  r.json({
    trips, days_worked: d.length, km: Math.round(d.reduce((a, x) => a + x.km, 0)),
    // avg() skips NULLs on the real endpoint, so avg_km has its own denominator.
    avg_km: 11.4, trips_with_distance: trips,
    revenue: Math.round(d.reduce((a, x) => a + x.revenue, 0)), avg_fare: 34.2,
    completion_pct: 96.4 - i * 0.4, cancel_pct: 3.1 + i * 0.3, avg_minutes: 17.4,
    /* The numerators beside the rates, and the denominators the money and
       distance figures are actually over. A rate with only its base under it is
       a figure the reader has to take on trust. */
    outcome_n: trips, completed: Math.round(trips * (96.4 - i * 0.4) / 100),
    not_completed: trips - Math.round(trips * (96.4 - i * 0.4) / 100),
    bookings: trips, priced_trips: Math.round(trips * 0.4),
    trips_with_distance: trips,
    // The distance of the PRICED trips, which is the only denominator revenue
    // per km can honestly have.
    priced_km: Math.round(d.reduce((a, x) => a + x.km, 0) * 0.4),
    priced_measured_revenue: Math.round(d.reduce((a, x) => a + x.revenue, 0) * 0.4),
    priced_measured_trips: Math.round(trips * 0.38),
    vehicles: 2, platforms: i % 3 === 0 ? 2 : 1,
    median_start_h: 6.5 + (i % 3), median_end_h: 18.4, avg_span_h: 10.6, start_consistency_h: 0.8 + i * 0.15,
    hours_online: +d.reduce((a, x) => a + x.hours_online, 0).toFixed(1),
    /* on_job, not on_trip: request to dropoff, which contains the approach and
       the rider's wait. Nothing this fleet collects separates the ride out of
       it, and the tile no longer claims otherwise. */
    hours_on_job: +d.reduce((a, x) => a + x.hours_on_job, 0).toFixed(1),
    /* Every day of work, beside the days a basis measured. The ratio uses the
       first; the panels that ask how long somebody was on jobs use this. They
       are returned apart so nothing can divide one by the other's denominator
       — production read 437% when they were one field. */
    hours_on_job_all_days: +d.reduce((a, x) => a + x.hours_on_job, 0).toFixed(1),
    hours_on_job_days: d.length,
    hours_idle_online: +d.reduce((a, x) => a + x.hours_idle_online, 0).toFixed(1),
    hours_basis: 'availability',
    hours_days: d.length,
    acceptance_rate: 0.91 - i * 0.02, cancellation_rate: 0.04,
    /* Uber's own rating, with the platform and the count behind it: the tile
       names whose opinion it is, because two platforms rating one human are
       two opinions on two scales. */
    rating: +(4.97 - i * 0.07).toFixed(2), rating_platform: 'uber',
    rating_at: new Date(Date.now() - 6 * 36e5).toISOString(),
    platform_lifetime_trips: 9000 - i * 640,
    banned_on: i === 3 ? ['uber'] : [],
    platform_compliance: [{ platform: 'uber', status: i === 3 ? 'SUSPENDED' : 'ACTIVE' }],
    /* Two readings for most drivers so the direction renders, and ONE for a
       couple so the "first reading" state is reachable — a single reading must
       show that, not a change of zero. */
    rating_readings: i % 5 === 0 ? 1 : 4,
    /* The readings behind the sparkline, oldest first. One driver gets a single
       reading so the "first reading" state — which must NOT draw a flat line —
       is reachable from the mock. */
    rating_series: i % 5 === 0
      ? [{ on: dayISO(0), rating: +(4.97 - i * 0.07).toFixed(2), trips: 9000 - i * 640 }]
      : [0, 1, 2, 3].map((w) => ({
        on: dayISO(21 - w * 7),
        rating: +(4.97 - i * 0.07 - (i % 2 ? 1 : -1) * (0.02 + (i % 3) * 0.02) * (3 - w) / 3).toFixed(3),
        trips: 9000 - i * 640 - (3 - w) * 40 })),
    rating_change: i % 5 === 0 ? null : {
      change: +((i % 2 ? 1 : -1) * (0.02 + (i % 3) * 0.02)).toFixed(3), over_days: 7,
      over_trips: 120 - i * 6,
      from: +(4.97 - i * 0.07 - ((i % 3) - 1) * 0.04).toFixed(2), to: +(4.97 - i * 0.07).toFixed(2) },
    reported_earnings: 9800 - i * 500, cash_earnings: 1200,
    /* Money in, and the two halves it is made of. Deliberately dominated by the
       payout: on this fleet a driver's fares are the few hotel bookings they
       happened to take, so a fixture where the halves are comparable would let
       a page that quietly showed only one still look right. */
    statement_net: null, statement_platforms: [],
    accounted: 9800 - i * 500 + Math.round(d.reduce((a, x) => a + x.revenue, 0)),
    accounted_fares: Math.round(d.reduce((a, x) => a + x.revenue, 0)),
    accounted_payouts: 9800 - i * 500,
    accounted_platforms: ['hotel', 'uber'], accounted_bookings: trips,
    /* The statement's own fare line, beside the accounted money rather than
       inside it — the gross the rider was charged, which already contains the
       payout above. Present on every driver here so the Fares tile's
       fall-back branch is reachable from the mock; a driver whose trips carry
       fares still shows those, which is the branch that must not change. */
    statement_fares: 4200 - i * 150, statement_fare_periods: 3 - (i % 2),
    statement_fare_from: '2026-08-03', statement_fare_to: '2026-08-23',
    dark_bookings: 0, dark_pct: 0,
    trips_per_day: +(trips / d.length).toFixed(1), utilisation_pct: 58.2 - i * 2.4,
  });
});

app.get('/api/driver/daily', (req, r) => r.json(dailyFor(req.query.id)));

/* The day as it was actually spent. The fixture makes all three states
   reachable: normal jobs with gaps between them, one booking with no dropoff
   (hatched), one that runs past midnight (clamped to the end of the day), and
   one overlapping pair — which is what a real dispatch looks like when the
   next rider is assigned before the current one is dropped. */
app.get('/api/driver/shift', (req, r) => {
  const solo = String(req.query.id || '').endsWith('9');
  const days = [];
  for (let i = 0; i < 14; i++) {
    const day = dayISO(13 - i);
    const jobs = [];
    let t = 300 + (i % 5) * 45;                       // first request, 05:00-08:00
    const n = 4 + (i % 4);
    for (let k = 0; k < n; k++) {
      const len = 25 + ((i + k) % 4) * 12;
      jobs.push({ s: t, e: t + len, over: false, platform: k % 3 ? 'uber' : 'hotel',
        plate: 'L44251', outcome: 'completed' });
      t += len + 30 + ((i + k) % 5) * 22;             // then a gap
    }
    // One booking whose dropoff the channel never sent.
    if (i % 4 === 1) jobs.push({ s: t, e: null, over: false, platform: 'uber', plate: 'L44251', outcome: 'completed' });
    // One overlapping dispatch: assigned before the previous job ended.
    if (i % 5 === 2 && jobs.length > 1) {
      const prev = jobs[jobs.length - 1];
      jobs.push({ s: prev.s + 10, e: prev.s + 55, over: false, platform: 'uber', plate: 'L44251', outcome: 'completed' });
    }
    // One night job that runs past midnight and is clamped to the day's end.
    if (i % 6 === 3) jobs.push({ s: 1390, e: 1440, over: true, platform: 'uber', plate: 'L44251', outcome: 'completed' });
    const known = jobs.filter((j) => j.e != null);
    let onJob = 0, wait = 0, longest = 0, overlaps = 0, cursor = null;
    [...jobs].sort((a, b) => a.s - b.s).forEach((j) => {
      if (j.e == null) return;
      onJob += j.e - j.s;
      if (cursor != null) {
        const gap = j.s - cursor;
        if (gap < 0) overlaps += 1; else { wait += gap; longest = Math.max(longest, gap); }
      }
      cursor = Math.max(cursor ?? j.e, j.e);
    });
    const first = Math.min(...jobs.map((j) => j.s));
    const last = known.length ? Math.max(...known.map((j) => j.e)) : first;
    days.push({ day, jobs, bookings: jobs.length, on_job_min: onJob, wait_min: wait,
      longest_wait_min: longest, overlaps, unknown_end: jobs.length - known.length,
      first_min: first, last_min: last, span_min: last - first });
  }
  return r.json({
    days: solo ? days.slice(-3) : days,
    basis: 'A job runs from the request to the dropoff, so it contains the drive to the rider '
      + 'and the wait for them as well as the ride itself. Uber\'s export carries two timestamps '
      + 'and no pickup time, and the hotel channel the same, so the ride cannot be separated '
      + 'from the approach on any booking channel.',
    unknown_end: days.reduce((a, x) => a + x.unknown_end, 0),
  });
});

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
    /* One cluster on a map beside a table of 139 pickups across 25 areas is not
       a contradiction — most channels report no coordinate — but the page could
       not say so, and its "no positioned trips" note fired only at zero. */
    coverage: { bookings: 420 - seed * 37, positioned: Math.round((420 - seed * 37) * 0.31),
      addressed: Math.round((420 - seed * 37) * 0.62), positioned_pct: 31,
      unpositioned_platforms: ['uber'] },
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
      earnings: 2350 - w * 120, cash_earnings: 400, acceptance_rate: .91, cancellation_rate: .04, rating: 4.88,
      // See /api/drivers/performance above: whole weeks, none displaced.
      period_days: 7, days_used: 7, counted: 2350 - w * 120, clipped: false,
      first_day_used: dayISO(7 * (w + 1)), last_day_used: dayISO(7 * w) })),
    /* The caption's own total, computed where the rows are. It used to be added
       up on the page from periods whose `counted` covered the WHOLE payout
       period, so the tile read reported_earnings 5,053.67 beside a caption
       saying "AED 6,592 counted across 11 statement(s)". */
    counted_total: [0, 1, 2, 3].reduce((a, w) => a + (2350 - w * 120), 0),
    counted_periods: 4, counted_clipped: 0,
    tips: 286 - i * 20, fare: 8420 - i * 400, tip_pct: +(((286 - i * 20) / (8420 - i * 400)) * 100).toFixed(2),
    /* The statement's own split, per day rather than per payout period. The
       endpoint read this table for tips alone and joined it on driver_ext_id,
       which the table leaves null — its identity is the name — so every one of
       these came back empty on the real API until the join was fixed. */
    statement_days: 24, statement_cash: 1840 - i * 60, statement_gross: 9600 - i * 420,
    statement_fees: -1180 + i * 40, statement_salik: 214 - i * 8,
  });
});

app.get('/api/driver/quality', (req, r) => {
  const i = idIndex(req.query.id);
  r.json({
    // Which platform said it: the four channels do not share a status
    // vocabulary, so a bare status with no platform beside it is ambiguous.
    cancels: [{ platform: 'uber', status: 'rider_cancelled', n: 7, pct: 70 },
      { platform: 'bolt', status: 'client_did_not_show', n: 3, pct: 30 }],
    cancel_daily: dailyFor(req.query.id).map((d) => ({ day: d.day, cancelled: d.cancelled, trips: d.trips })),
    alerts: [{ alert_type: 'Harsh Braking', n: 41 + i * 3, latest: new Date().toISOString() },
      { alert_type: 'Overspeed', n: 26 + i * 2, latest: new Date().toISOString() },
      { alert_type: 'Harsh Acceleration', n: 14, latest: new Date().toISOString() },
      { alert_type: 'Harsh Cornering', n: 6, latest: new Date().toISOString() }],
    alert_km: 3410 - i * 240, alerts_per_100km: +(((87 + i * 5) / (3410 - i * 240)) * 100).toFixed(1),
    /* What the fleet does, so a rate has something to be high AGAINST. The page
       painted this critical from a hardcoded 5/15 scale under a sub-label
       reading "comparable across drivers" — comparable to a constant. */
    fleet_alerts_per_100km: 2.6, fleet_alert_km: 184200, fleet_alerts: 4790,
  });
});

/* Paged, like the real one. 640 trips behind a 500-row page, so the "load the
   next N" control and the "500 of 640 loaded" caption are both reachable from
   the fixture — a mock that always returns everything cannot exercise the one
   branch this endpoint exists to have. */
app.get('/api/driver/trips', (req, r) => {
  const seed = idIndex(req.query.id);
  const TOTAL = 640;
  const limit = Math.min(+req.query.limit || 200, 1000);
  const offset = Math.max(0, +req.query.offset || 0);
  const all = Array.from({ length: TOTAL }, (_, n) => ({
    platform: n % 9 === 0 ? 'yango' : 'uber', external_id: `t-${seed}-${n}`,
    requested_at: new Date(Date.now() - n * 27e5).toISOString(),
    ended_at: new Date(Date.now() - n * 27e5 + 12e5).toISOString(),
    plate: plates[seed % plates.length],
    pickup_addr: ['Dubai Marina - Marina Walk', 'Downtown Dubai - Burj Park', 'Deira - Al Rigga'][n % 3],
    dropoff_addr: ['Business Bay - Bay Square', 'DXB Terminal 3', 'Al Barsha - MoE'][n % 3],
    distance_km: +rnd(2, 34).toFixed(1), duration_s: Math.round(rnd(400, 2600)),
    status: n % 17 === 0 ? 'rider_cancelled' : 'completed',
    /* The normalised columns the table actually reads. `status` is each
       provider's own word — Bolt says 'finished' for a success — and a row
       carrying only that forces the render layer to re-derive the meaning. */
    outcome: n % 17 === 0 ? 'not_completed' : 'completed',
    is_booking: true, has_fare: n % 5 !== 1,
    product: ['UberX', 'Comfort', 'Uber Black'][n % 3], payment_type: n % 5 === 0 ? 'cash' : 'card',
    price: n % 5 === 1 ? null : +rnd(18, 140).toFixed(2), currency: 'AED',
  }));
  const rows = all.slice(offset, offset + limit);
  r.json({ rows, total: TOTAL, shown: rows.length, offset, limit,
    truncated: offset + rows.length < TOTAL });
});

app.get('/api/driver/custody', (req, r) => {
  // 60 of 256 rows reached the Activity tab with nothing saying so.
  const rows = dailyFor(req.query.id).slice().reverse().map((d) => ({
    day: d.day, plate: d.plates, platform: 'uber', trips: d.trips, km: d.km, revenue: d.revenue,
    first_trip_at: d.first_trip_at, last_trip_at: d.last_trip_at, is_primary: true,
  }));
  r.json({ rows, total: rows.length, shown: rows.length, truncated: false });
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
  // How stale the last fix is, so "no movement" and "no tracker" read apart.
  fix_age_min: i === 6 ? 41000 : i * 7,
  /* Most cars have a payout and no fare — the production shape, where Uber is
     most of the work and publishes no fare per trip. Two carry a fare too, and
     the idle one carries neither, so all three empty states are reachable. */
  km: i === 6 ? null : 6100 - i * 420,
  revenue: i === 1 || i === 4 ? 15800 - i * 1100 : null,
  payout: i === 6 ? null : 12400 - i * 900,
  payout_days: i === 6 ? 0 : Math.max(1, 27 - i),
  payout_even_split: i === 3,
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

/* Handover gaps. Shaped like the real one: a few cars with several
   change-overs, one that only ever has one driver (absent from the list), and
   a fixture where the drop-off time is missing on some rows so the page's
   "measured from the request instead" note is reachable. */
app.get('/api/vehicles/handover', (_, r) => {
  const rows = plates.slice(0, 6).map((pl, i) => ({
    plate: pl,
    handovers: 6 - i,
    idle_h: +(28 - i * 4.1).toFixed(1),
    median_h: +(4.4 - i * 0.3).toFixed(1),
    worst_h: +(11.2 - i * 0.8).toFixed(1),
    worst_from: drivers[i % drivers.length],
    worst_to: drivers[(i + 3) % drivers.length],
    worst_at: new Date(Date.now() - (i + 1) * 86400e3).toISOString(),
    driver_refs: [{ name: drivers[i % drivers.length], id: `drv-${i}` },
                  { name: drivers[(i + 3) % drivers.length], id: `drv-${(i + 3) % drivers.length}` }],
  }));
  const handovers = rows.reduce((a, x) => a + x.handovers, 0);
  const handover_h = +rows.reduce((a, x) => a + x.idle_h, 0).toFixed(1);
  r.json({
    window: [dayISO(DAYS).slice(0, 10), dayISO(0).slice(0, 10)],
    max_gap_h: 24,
    totals: {
      handovers, plates: rows.length, handover_h,
      handover_days: +(handover_h / 24).toFixed(1),
      median_h: 3.6, quick_h: 1.4, p90_h: 9.8,
      parked: 3, parked_days: 7.4,
      recoverable_h: +(handover_h - 1.4 * handovers).toFixed(1),
      timed_rows: 412, custody_rows: 460,
    },
    plates: rows,
  });
});

/* The all-source join behind a cohort. Shaped so every branch of the card
   renderer is reachable: one member with every source answering, one with a
   silent tracker, one nobody holds. */
const idsOf = (req) => String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);

app.get('/api/cohort/drivers', (req, r) => {
  const ids = idsOf(req);
  r.json({
    window: [dayISO(DAYS).slice(0, 10), dayISO(0).slice(0, 10)],
    ids,
    rows: ids.map((id, i) => {
      /* Consistent with /api/roster for the same person — see ROSTER_CATS. */
      const cat = catOf(id);
      const works = cat === 'working';
      const stopped = cat === 'blocked';
      return {
      id,
      work: !works ? [] : [
        { platform: 'uber', bookings: 60 - i * 3, completed: 55 - i * 3, bookable: 60 - i * 3,
          days: 22 - i, km: 900 - i * 40, fares: i % 2 ? 1200 - i * 50 : null, priced: i % 2 ? 12 : 0,
          first_trip: dayISO(DAYS), last_trip: dayISO(1) },
      ],
      pay: !works ? [] : [
        { platform: 'uber', payout: 4200 - i * 120, cash: 300, payout_days: 20 - i,
          first_day: dayISO(DAYS).slice(0, 10), last_day: dayISO(1).slice(0, 10) },
      ],
      availability: works && i % 2 ? { days: 21, online_min: 18000 - i * 300, idle_min: 15000 - i * 250,
        on_job_min: 3000, avg_first_min: 430, avg_last_min: 1310, longest_wait_min: 240 } : null,
      standing: [{ platform: 'uber', state: stopped ? 'deactivated' : cat === 'in_pipeline' ? 'waitlist' : 'active',
        state_reason: stopped ? 'document expired' : null, can_earn: !stopped && cat !== 'in_pipeline',
        plate: plates[i % plates.length],
        observed_at: new Date().toISOString(), fleet_id: 'ecosine' }],
      compliance: [{ platform: 'uber', licence_expires: dayISO(-40 + i * 10).slice(0, 10),
        state: 'ACTIVE', rating: 4.7, licence_days_left: 40 - i * 10,
        updated_at: new Date().toISOString() }],
      cars: (!works && !stopped) ? [] : [
        { plate: plates[i % plates.length], days: 18 - i, trips: 90 - i * 5, last_day: dayISO(1).slice(0, 10) },
      ],
      alerts: works && i % 2 ? [{ alert_type: 'Overspeed', n: 9 - i }, { alert_type: 'Harsh Braking', n: 3 }] : [],
      performance: !works ? [] : [{ platform: 'uber', hours_online: 180 - i * 6, hours_on_trip: 40,
        acceptance: 0.91, cancellation: 0.04, rating: 4.72 }],
      not_completed: !works ? [] : [
        { platform: 'uber', status: 'rider_cancelled', outcome: 'not_completed', n: 7 - i },
        { platform: 'uber', status: 'driver_cancelled', outcome: 'not_completed', n: 2 }],
      }; }),
  });
});

app.get('/api/cohort/vehicles', (req, r) => {
  const ids = idsOf(req);
  r.json({
    window: [dayISO(DAYS).slice(0, 10), dayISO(0).slice(0, 10)],
    ids,
    rows: ids.map((plate, i) => ({
      plate,
      spec: { plate, make: vehSpec[i % vehSpec.length][0], model: vehSpec[i % vehSpec.length][1],
        year: vehSpec[i % vehSpec.length][2], colour: 'White', vin: '5YJ' + (100000 + i),
        fuel_type: 'electric', fleet_id: i % 3 ? 'ecosine' : 'egari' },
      /* Mirrors /api/vehicles/directory for the same plate. A fixture whose
         detail contradicts its own directory renders a drill-down claiming 120
         bookings under a table row that says 0, which is exactly the bug this
         page exists to make impossible — so the mock must not fake it. */
      work: (() => {
        const j = plates.indexOf(plate);
        const k = j < 0 ? i : j;
        const trips = k === 6 ? 0 : 470 - k * 44;
        const journeys = k === 6 ? 38 : Math.round(trips * 1.3);
        return trips || journeys ? [{ platform: 'uber', bookings: trips, journeys,
          days: k === 6 ? 0 : 27 - k, km: k === 6 ? null : 6100 - k * 420,
          journey_km: k === 6 ? 512 : Math.round((6100 - k * 420) * 1.25),
          fares: k === 1 || k === 4 ? 15800 - k * 1100 : null,
          last_trip: trips ? dayISO(1) : null, last_movement: dayISO(0) }] : [];
      })(),
      custody: i % 5 === 4 ? [] : [
        { plate, driver_ext_id: `drv-${i}`, driver_name: drivers[i % drivers.length],
          days: 19 - i, trips: 110 - i * 8, last_day: dayISO(1).slice(0, 10) },
      ],
      documents: [
        { plate, platform: 'uber', doc_type: 'Vehicle Registration Form', status: 'ACTIVE',
          expires_at: dayISO(-20 + i * 12), days_left: 20 - i * 12 },
        { plate, platform: 'uber', doc_type: 'Insurance', status: 'ACTIVE',
          expires_at: dayISO(-200), days_left: 200 },
      ],
      telematics: i % 6 === 5 ? null : { plate, source: 'cabman', last_fix: dayISO(i ? 1 : 0),
        status: 'Idle', speed: 0, odometer: 91000 + i * 900, ignition: false,
        fix_age_min: i * 90 },
      alerts: i % 2 ? [{ plate, alert_type: 'Overspeed', n: 12 - i, last_at: dayISO(1) }] : [],
      segments: [{ plate, verdict: 'partial', n: 14, km: 190, minutes: 620 },
        ...(i % 3 === 0 ? [{ plate, verdict: 'unauthorized', n: 3, km: 41, minutes: 96 }] : [])],
      utilisation: [{ plate, platform: 'uber', hours_online: 210 - i * 7, hours_on_trip: 88,
        utilisation: 0.42, earnings: 5400 - i * 110 }],
    })),
  });
});

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
    /* Deliberately far larger than `revenue`. On the real fleet the fares
       cover a tenth of the bookings and the attributed driver pay is the rest,
       so a fixture where the two are comparable would let a page that quietly
       swapped or summed them still look right. */
    attributed_earnings: 5082.65, attributed_platforms: 1, attributed_drivers: 2,
    any_even_split: true,
    /* And the two together, per platform — hotel counted on its fares, uber on
       its payout, so accounted is their sum and not fares + every payout. */
    statement_net: null, statement_platforms: [],
    accounted: 5082.65 + Math.round(d.reduce((a, x) => a + (x.revenue || 0), 0)),
    accounted_fares: Math.round(d.reduce((a, x) => a + (x.revenue || 0), 0)),
    accounted_payouts: 5082.65, accounted_platforms: ['hotel', 'uber'],
    accounted_bookings: trips, dark_bookings: 0, dark_pct: 0,
    /* Bookings and telematics journeys are separate counts and never summed —
       an FMS row is the same physical journey a ride platform already reported.
       measured_trips and priced_trips are the denominators the distance and
       money averages are actually over, and completed/outcome_n are the two
       numbers the completion rate is made of. */
    telematics_journeys: Math.round(trips * 1.2), days_earning: d.filter((x) => x.trips).length,
    measured_trips: trips, priced_trips: Math.round(trips * 0.42),
    priced_km: Math.round(km * 0.42),
    priced_measured_revenue: Math.round(d.reduce((a, x) => a + (x.revenue || 0), 0) * 0.42),
    priced_measured_trips: Math.round(trips * 0.4),
    outcome_n: trips, completed: Math.round(trips * 0.961),
    not_completed: trips - Math.round(trips * 0.961),
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
    const id = `drv-${n ? (i + 4) % drivers.length : i}`;
    /* Grouped by PERSON, not by platform account: one human with an Uber id and
       a Bolt id used to be two rows side by side with their work split between
       them. Every id they hold comes back so both spellings stay openable. */
    return { person: name.toLowerCase(), driver_ext_id: id, driver_ids: [id],
      driver_name: name, platforms: ['uber'],
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
      /* The two fields that make a verdict readable. /api/segments returns
         both and this per-vehicle table did not, so the same rows were
         strictly poorer here than on the segments page: "assessed blind"
         means nothing without naming the channel that could not be checked. */
      verdict_reason: n % 7 === 0 ? 'no booking on any channel within 15 min'
        : n % 5 === 0 ? 'telemetry clock is behind wall time' : 'matched uber trip',
      unavailable_sources: n % 7 === 0 ? ['bolt'] : [],
      max_gap_min: 4 + (n % 6), ignition_ratio: +(0.6 + (n % 4) * 0.1).toFixed(2),
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

/* The shape the browser smoke test renders against. Two money columns that
   must never be added: `fares` is measured per trip, `attributed` is a share
   of a driver payout. The fixture deliberately gives a channel with bookings
   and no fares — that is the real fleet's dominant case and the one the page
   exists for. */
app.get('/api/vehicle/earnings', (req, r) => {
  const i = pIndex(req.query.plate);
  const byPlatform = [
    { platform: 'uber', bookings: 240 + i, priced_bookings: 0, fares: null, km: 3400 },
    { platform: 'hotel', bookings: 12, priced_bookings: 11, fares: 612.5, km: 190 },
  ];
  const attributed = [
    { platform: 'uber', driver_ext_id: `drv-${i}`, driver_name: drivers[i],
      attributed: 4180.25, attributed_cash: 320, trips: 190, km: 2600, days: 22,
      any_even_split: false, first_period: '2026-07-24', last_period: '2026-08-22' },
    { platform: 'uber', driver_ext_id: `drv-${(i + 3) % drivers.length}`,
      driver_name: drivers[(i + 3) % drivers.length],
      attributed: 902.4, attributed_cash: null, trips: 50, km: 800, days: 6,
      any_even_split: true, first_period: '2026-08-03', last_period: '2026-08-09' },
  ];
  r.json({
    plate: req.query.plate,
    by_platform: byPlatform,
    attributed,
    daily: vDaily(req.query.plate).map((d, n) => ({
      day: d.day, fares: n % 5 === 0 ? 62.5 : 0, bookings: d.trips ?? 0,
      attributed: 120 + (n % 7) * 30,
    })),
    totals: {
      fares: 612.5, attributed: 5082.65, bookings: 252 + i, priced_bookings: 11,
      fare_coverage_pct: 4.4, platforms: 2, priced_platforms: 1,
    },
    caveat: 'Fares are reported on 11 of 252 bookings. The rest are channels that price '
      + 'nothing per trip and pay the driver instead — their share is the attributed column, '
      + 'inferred from who was holding this vehicle.',
  });
});

app.get('/api/vehicle/safety', (req, r) => {
  const i = pIndex(req.query.plate);
  r.json({
    by_type: [{ alert_type: 'Overspeed', n: 61 - i * 4, latest: new Date().toISOString() },
      { alert_type: 'Harsh Braking', n: 44 - i * 3, latest: new Date().toISOString() },
      { alert_type: 'Harsh Acceleration', n: 18, latest: new Date().toISOString() },
      { alert_type: 'Sharp Turn', n: 9, latest: new Date().toISOString() }],
    // With the id, because a harsh-driving count against a name you cannot
    // open is a statistic rather than a conversation.
    /* km is the driver's distance ON THIS PLATE over the WHOLE window. It used
       to be summed inside the alert-day join, so the denominator was the
       distance driven on the days they triggered something — 322 events over
       459 km, printed as 215.3 per 100 km beside a vehicle rate of 34, while
       /api/vehicle/drivers-detail gave 2,459 km for the same person. */
    by_driver: [{ driver_name: drivers[i], driver_ext_id: `drv-${i}`, n: 78,
      km: 3400, booked_km: 3400, days_held: 21, per_100km: +((78 * 100) / 3400).toFixed(2) },
      { driver_name: drivers[(i + 4) % drivers.length],
        driver_ext_id: `drv-${(i + 4) % drivers.length}`, n: 41,
        km: 2100, booked_km: 2100, days_held: 9, per_100km: +((41 * 100) / 2100).toFixed(2) },
      { driver_name: 'unattributed', driver_ext_id: null, n: 13,
        km: null, booked_km: null, days_held: null, per_100km: null }],
    by_driver_total: 3, by_driver_shown: 3, by_driver_truncated: false, by_driver_alerts: 132,
    recent_total: 40, recent_shown: 40, recent_truncated: false,
    daily: vDaily(req.query.plate).map((d) => ({ day: d.day, alerts: d.alerts })),
    recent: Array.from({ length: 40 }, (_, n) => ({
      alert_type: ['Overspeed', 'Harsh Braking', 'Harsh Acceleration', 'Sharp Turn'][n % 4],
      occurred_at: new Date(Date.now() - n * 41e5).toISOString(),
      location: ['Sheikh Zayed Road', 'Al Khail Road', 'Emirates Road', 'Jumeirah Beach Road'][n % 4],
      lat: 25.1 + (n % 9) * 0.02, lng: 55.18 + (n % 7) * 0.02, video_url: n % 6 === 0 ? 'https://example.com/clip' : null,
    })),
  });
});

/* Every slice carries `bookings` (the count excluding telematics twins),
   `measured` (how many of them reported a distance) and `avg_km` over that
   measured subset — the three numbers the panel divides by. A fixture with only
   `n` and `revenue` renders the per-trip figures as em-dashes and looks fine. */
const vMix = (label, n, revenue, avgKm) => ({
  label, n, bookings: n, measured: Math.round(n * 0.9), revenue, avg_km: avgKm,
});
app.get('/api/vehicle/mix', (req, r) => r.json({
  product: [vMix('UberX', 268, 8400, 10.2), vMix('Comfort', 92, 4600, 14.1),
    vMix('Uber Black', 24, 2800, 22.4)],
  payment: [vMix('card', 320, 12800, 11.6), vMix('cash', 52, 2200, 9.8),
    vMix('corporate', 12, 800, 18.2)],
  platform: [vMix('uber', 336, 13100, 11.2), vMix('yango', 34, 1400, 12.9),
    vMix('hotel', 14, 1300, 21.4)],
  status: [vMix('completed', 371, 15800, 11.8), vMix('rider_cancelled', 13, 0, 4.1)],
  hours: Array.from({ length: 19 }, (_, n) => ({ h: n + 5, trips: Math.round(rnd(4, 26)) })),
}));

app.get('/api/vehicle/trips', (req, r) => {
  const i = pIndex(req.query.plate);
  const TOTAL = 720;
  const limit = Math.min(+req.query.limit || 200, 1000);
  const offset = Math.max(0, +req.query.offset || 0);
  const all = Array.from({ length: TOTAL }, (_, n) => ({
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
  }));
  const rows = all.slice(offset, offset + limit);
  r.json({ rows, total: TOTAL, shown: rows.length, offset, limit,
    truncated: offset + rows.length < TOTAL });
});


/* ── "why it moved" fixtures ──────────────────────────────────────────────
   Deliberately mirrors the production shape, hole and all: Uber busy Aug–Oct
   2025, nothing collected Nov–Jan, telematics-only (no driver ids) Feb–Jun,
   Uber back in Aug. */
/* Thirteen unbroken months, which is what the record looks like now that the
   Uber backfill finally landed a full year. The shape is the live one and it
   is the point of the causes page: bookings roughly halve, the driver count
   roughly halves with them, and the vehicle count does not move. A fleet that
   kept its cars and lost its people.

   `trips` is bookings only. Telematics journeys are the same physical trips
   seen by the tracker and are carried separately, because summing them made a
   month with FMS running look 2-3x busier than the same month without it. */
const TREND = [
  { m: '2025-08', trips: 5801,  telematics_journeys: 4102, drivers: 80,  vehicles: 71, earning_vehicles: 68, revenue: 41200,  platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 5801,  measured_trips: 5600 },
  { m: '2025-09', trips: 22902, telematics_journeys: 3980, drivers: 102, vehicles: 82, earning_vehicles: 79, revenue: 118400, platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 22902, measured_trips: 22100 },
  { m: '2025-10', trips: 23898, telematics_journeys: 0,    drivers: 110, vehicles: 81, earning_vehicles: 80, revenue: 89300,  platforms: ['uber'], booking_platforms: ['uber'], attributed_trips: 23898, measured_trips: 23000 },
  { m: '2025-11', trips: 24943, telematics_journeys: 0,    drivers: 108, vehicles: 87, earning_vehicles: 84, revenue: 91200,  platforms: ['uber'], booking_platforms: ['uber'], attributed_trips: 24943, measured_trips: 24100 },
  { m: '2025-12', trips: 19229, telematics_journeys: 0,    drivers: 93,  vehicles: 83, earning_vehicles: 81, revenue: 74800,  platforms: ['uber'], booking_platforms: ['uber'], attributed_trips: 19229, measured_trips: 18600 },
  { m: '2026-01', trips: 21890, telematics_journeys: 0,    drivers: 88,  vehicles: 78, earning_vehicles: 77, revenue: 82100,  platforms: ['uber'], booking_platforms: ['uber'], attributed_trips: 21890, measured_trips: 21200 },
  { m: '2026-02', trips: 19511, telematics_journeys: 2164, drivers: 83,  vehicles: 97, earning_vehicles: 76, revenue: 79400,  platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 19511, measured_trips: 18900 },
  { m: '2026-03', trips: 8641,  telematics_journeys: 4449, drivers: 70,  vehicles: 94, earning_vehicles: 68, revenue: 36200,  platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 8641,  measured_trips: 8400 },
  { m: '2026-04', trips: 10204, telematics_journeys: 5638, drivers: 64,  vehicles: 91, earning_vehicles: 66, revenue: 41800,  platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 10204, measured_trips: 9900 },
  { m: '2026-05', trips: 10042, telematics_journeys: 3576, drivers: 57,  vehicles: 77, earning_vehicles: 61, revenue: 40100,  platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 10042, measured_trips: 9700 },
  { m: '2026-06', trips: 14033, telematics_journeys: 7444, drivers: 50,  vehicles: 79, earning_vehicles: 63, revenue: 55600,  platforms: ['uber', 'fms'], booking_platforms: ['uber'], attributed_trips: 14033, measured_trips: 13600 },
  { m: '2026-07', trips: 13537, telematics_journeys: 6817, drivers: 86,  vehicles: 91, earning_vehicles: 74, revenue: 61300,  platforms: ['uber', 'fms', 'hotel'], booking_platforms: ['uber', 'hotel'], attributed_trips: 13537, measured_trips: 13100 },
  { m: '2026-08', trips: 11278, telematics_journeys: 5901, drivers: 88,  vehicles: 89, earning_vehicles: 76, revenue: 52900,  platforms: ['uber', 'fms', 'hotel'], booking_platforms: ['uber', 'hotel'], attributed_trips: 11278, measured_trips: 10900 },
];
const MONTH_KEYS = ['2025-08','2025-09','2025-10','2025-11','2025-12','2026-01',
  '2026-02','2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'];

app.get('/api/trend/monthly', (_, r) => {
  const months = MONTH_KEYS.map((k, i) => {
    const row = TREND[i];
    return row
      // km over MEASURED bookings only. Summing distance_km unguarded pulled in
      // FMS odometer rows and reported 12,681,536 km in one month.
      ? { ...row, m: k, cancel_pct: 3.2, km: Math.round(row.measured_trips * 11.8),
          priced_trips: Math.round(row.trips * 0.35), no_data: false,
          // Collection starts on 21 August 2025, so that month holds 11 days.
          partial_month: k === '2025-08', days_in_record: k === '2025-08' ? 11 : null,
          /* Money per month, both channels — and the months no statement can
             ever cover. Uber's earnings API serves roughly the last six, so the
             older half of this record has work and no recoverable money, which
             is a fact the page has to state rather than draw as a flat line. */
          accounted_fares: Math.round(row.trips * 0.35 * 96),
          statement_net: 96480, statement_cash: 18200, statement_bank: 74100, statement_platforms: ['uber'], accounted_payouts: i >= MONTH_KEYS.length - 6 ? Math.round(row.trips * 26) : null,
          accounted: Math.round(row.trips * 0.35 * 96)
            + (i >= MONTH_KEYS.length - 6 ? Math.round(row.trips * 26) : 0),
          accounted_platforms: i >= MONTH_KEYS.length - 6 ? ['hotel', 'uber'] : ['hotel'],
          income_missing: i < MONTH_KEYS.length - 6,
          /* The bookings the money above actually covers, and the share it does
             not. On a month before the earnings API's retention horizon that is
             most of them. */
          accounted_bookings: i >= MONTH_KEYS.length - 6 ? row.trips : Math.round(row.trips * 0.35),
          dark_bookings: i >= MONTH_KEYS.length - 6 ? 0 : row.trips - Math.round(row.trips * 0.35),
          dark_pct: i >= MONTH_KEYS.length - 6 ? 0 : 65,
          drivers_known: row.attributed_trips > 0 }
      : { m: k, trips: 0, telematics_journeys: 0, drivers: null, vehicles: 0, earning_vehicles: 0,
          km: null, measured_trips: 0, revenue: null, priced_trips: 0, cancel_pct: null,
          accounted: null, accounted_fares: null, statement_net: 96480, statement_cash: 18200, statement_bank: 74100, statement_platforms: ['uber'], accounted_payouts: null,
          accounted_platforms: [], income_missing: false,
          platforms: [], booking_platforms: [], no_data: true, drivers_known: false,
          partial_month: false, days_in_record: null };
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
      boundary_artifact: !!(a.partial_month || b.partial_month),
      partial_side: a.partial_month ? a.m : b.partial_month ? b.m : null,
      vehicles_from: a.earning_vehicles, vehicles_to: b.earning_vehicles,
      km_per_trip_from: a.measured_trips ? +(a.km / a.measured_trips).toFixed(1) : null,
      km_per_trip_to: b.measured_trips ? +(b.km / b.measured_trips).toFixed(1) : null,
      platform_shift: JSON.stringify([...a.booking_platforms].sort()) !== JSON.stringify([...b.booking_platforms].sort())
        ? { from: a.booking_platforms, to: b.booking_platforms } : null });
  }
  // No gaps any more: the Uber backfill closed the 299-day hole, so every
  // month between the first and last trip on record has data.
  r.json({ source: 'rollup', months, breaks, gaps: [] });
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
  /* Every mix row carries the coverage fields, because the page divides by
     them: revenue over priced_n, not over n. A fixture missing priced_n makes
     the per-trip figures render as em-dashes in the smoke run and look fine. */
  if (by === 'payment') return r.json([
    { label: 'card', platform: null, n: 1642, revenue: 61200, priced_n: 1642, priced_km: 19800,
      avg_km: 12.1, revenue_per_trip: 37.3, revenue_per_km: 3.09 },
    { label: 'cash', platform: null, n: 318, revenue: 14800, priced_n: 318, priced_km: 3900,
      avg_km: 12.3, revenue_per_trip: 46.5, revenue_per_km: 3.79 },
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

/* Aggregated to the fleet, like the real endpoint: one row per
   (category, parent), with the roots present so the tree can nest and net.
   The per-driver shape this used to return was never read — componentTree()
   folds on (parent, category) the moment it arrives. */
app.get('/api/earnings/components', (_, r) => r.json({
  /* One shape whether or not a period fits the window: the span is what tells a
     reader which range to ask for, and it is present either way. */
  overlapping: 0, first_period: '2026-08-24', last_period: '2026-08-30', rows: [
  { category: 'earnings', parent: null, amount: 57232, currency: 'AED', drivers: 41 },
  { category: 'payouts', parent: null, amount: -23920, currency: 'AED', drivers: 38 },
  { category: 'reimbursements', parent: null, amount: 980, currency: 'AED', drivers: 12 },
  { category: 'net_fare', parent: 'earnings', amount: 52180, currency: 'AED', drivers: 41 },
  { category: 'tip', parent: 'earnings', amount: 1642, currency: 'AED', drivers: 22 },
  { category: 'promotion', parent: 'earnings', amount: 3410, currency: 'AED', drivers: 9 },
  { category: 'toll_reimbursement', parent: 'reimbursements', amount: 980, currency: 'AED', drivers: 12 },
  { category: 'cash_collected', parent: 'payouts', amount: -14800, currency: 'AED', drivers: 38 },
  { category: 'service_fee', parent: 'payouts', amount: -9120, currency: 'AED', drivers: 38 },
] }));

/* Ranked by tip RATE, so the ranking needs a fare base worth dividing by: the
   real endpoint has a 300-dirham floor and reports how many drivers it left
   unranked, because the top row used to be whoever had the smallest fare. */
app.get('/api/earnings/tips', (_, r) => {
  const rows = drivers.map((name, i) => ({
    driver_ext_id: `drv-${i}`, driver_name: name,
    tips: +(420 - i * 44).toFixed(2), fare: 12800 - i * 900,
    tip_pct: +(((420 - i * 44) / (12800 - i * 900)) * 100).toFixed(2),
  }));
  r.json({ rows, fare_floor: 300, excluded_n: 11, total: rows.length,
    shown: rows.length, truncated: false });
});

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

app.get('/api/trips/daily', (req, r) => {
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
  r.json(foldGrain(out, grainOf(req)));
});

/* The CSV export, fixtured so the header row can be compared against the real
   one. A download is the one response in this API that nothing JSON-shaped
   guards: JSON.parse fails on it, so the shape check would have skipped it and
   the columns could drift for months without a test noticing. Comparing the
   header line is the CSV equivalent of "fixture rows lack X", so the columns
   here MUST track api/export_routes.js. */
const EXPORT_COLS = {
  day: ['day', 'fleet', 'channel', 'bookings', 'completed', 'drivers', 'vehicles',
    'km', 'priced_bookings', 'fares', 'currency'],
  trip: ['day', 'fleet', 'channel', 'trip_id', 'requested_at', 'ended_at', 'driver_name',
    'driver_ext_id', 'plate', 'pickup_addr', 'dropoff_addr', 'distance_km',
    'product', 'payment_type', 'status', 'outcome', 'price', 'currency'],
};
/* One driver, one day. The shape matters more than the values: the renderer
   joins three feeds on one clock and each of them can legitimately be empty —
   a day with no availability collected, a gap the tracker did not cover. The
   fixture carries all three so the smoke test compares a full shape. */
/* The KEPT per-day record. Distinct from /api/driver/day, which is one day in
   detail — this is the stored row per day, which is what answers a window the
   provider no longer serves. online_min is deliberately NULL on one of them:
   a day nobody collected availability for is not a day the driver was offline,
   and the renderer has to keep being able to tell those apart. */
/* Supply against demand, every hour of the week. The fixture deliberately
   leaves some hours with NO availability, because that is the shape the real
   data has — Uber serves 31 days and nothing older, and an hour nobody
   collected must not draw as an hour with no drivers. */
/* The optimiser: two areas that are the SAME place under different names, so
   the page's own warning about that is exercised rather than described. */
app.get('/api/optimise', (req, r) => {
  const AREAS = ["Dubai Int'l Airport", 'Al Garhoud', 'Downtown Dubai', 'Dubai Marina',
    'Business Bay', 'Deira', 'Al Barsha', 'Nakhlat Jumeira'];
  const slots = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const [i, area] of AREAS.entries()) {
      for (const h of [7, 9, 13, 17, 18, 21]) {
        const pickups = Math.max(0, Math.round(6 + Math.sin((h + i) / 2) * 5 + (h > 16 ? 6 : 0)));
        const arrivals = Math.max(0, Math.round(pickups * (i === 0 ? 1.8 : i === 1 ? 0.1 : 0.7)));
        if (pickups + arrivals < 3) continue;
        /* Most bookings carry no price — Uber publishes none — so the
           average is over a MINORITY of the pickups, and one area in the
           fixture has none at all. That is the shape the page has to render
           without printing "AED 0" as though the place earned nothing. */
        const pricedPickups = i === 3 ? 0 : Math.max(1, Math.round(pickups * 0.12));
        slots.push({ area, dow, h, occurrences: 4, pickups, arrivals,
          gap: pickups - arrivals, per_occurrence: Math.round((pickups / 4) * 100) / 100,
          priced_pickups: pricedPickups,
          avg_fare: pricedPickups ? 40 + i * 9 : null });
      }
    }
  }
  const movesAll = slots.filter((s) => s.gap > 0 && s.pickups >= 4)
    .map((s) => ({ ...s, gap_per_occurrence: Math.round((s.gap / s.occurrences) * 100) / 100,
      weekly: Math.round((s.gap / s.occurrences) * 100) / 100 }))
    .sort((a, b) => b.gap_per_occurrence - a.gap_per_occurrence);
  const moves = movesAll.slice(0, 40);
  const surplusAll = slots.filter((s) => s.gap < 0 && s.arrivals >= 4)
    .map((s) => ({ ...s, idle_per_occurrence: Math.round((-s.gap / s.occurrences) * 100) / 100 }))
    .sort((a, b) => b.idle_per_occurrence - a.idle_per_occurrence);
  const surplus = surplusAll.slice(0, 20);
  /* Two of the mock's own areas, so the charging caveat is exercised. */
  const SITES = [
    { label: 'Al Garhoud', names: ['Al Garhoud', "Dubai Int'l Airport"] },
    { label: 'Dubai Production City', names: ['Dubai Production City'] },
  ];
  const waits = [];
  for (let dow = 0; dow < 7; dow++) {
    for (const [i, area] of AREAS.entries()) {
      for (const h of [6, 7, 13, 16, 18]) {
        waits.push({ area, dow, h,
          handovers: 3 + ((dow + i + h) % 9),
          median_wait_min: 35 + ((i * 13 + h * 7) % 110),
          charging_site: SITES.find((x) => x.names
            .some((nm) => area.toLowerCase() === nm.toLowerCase()))?.label || null,
          idle_h: Math.round((4 + ((dow * 3 + i * 5 + h) % 13)) * 10) / 10 });
      }
    }
  }
  waits.sort((a, b) => b.idle_h - a.idle_h);
  const placed = slots.reduce((a, s) => a + s.pickups, 0);
  const gap = moves.reduce((a, s) => a + Math.max(0, s.gap), 0);
  r.json({
    window: [req.query.from || '2026-07-30', req.query.to || '2026-08-29'],
    areas_seen: AREAS.length, slots_seen: slots.length,
    placed_bookings: placed, empty_arrivals: gap,
    empty_arrival_pct: placed ? Math.round((gap / placed) * 1000) / 10 : null,
    idle_h_between_jobs: Math.round(waits.reduce((a, w) => a + w.idle_h, 0) * 10) / 10,
    charging_sites: SITES.map((x) => x.label),
    charging_aliases: SITES.filter((x) => x.names.length > 1)
      .map((x) => ({ site: x.label, written: x.names })),
    idle_h_at_charging_sites: Math.round(waits.filter((w) => w.charging_site)
      .reduce((a, w) => a + w.idle_h, 0) * 10) / 10,
    idle_h_charging_pct: Math.round((waits.filter((w) => w.charging_site)
      .reduce((a, w) => a + w.idle_h, 0) / waits.reduce((a, w) => a + w.idle_h, 0)) * 1000) / 10,
    handovers: waits.reduce((a, w) => a + w.handovers, 0),
    median_wait_overall: 52,
    waits: waits.slice(0, 40), moves, surplus, slots,
    totals: { waits: waits.length, moves: movesAll.length, surplus: surplusAll.length, slots: slots.length },
    shown: { waits: Math.min(waits.length, 40), moves: moves.length, surplus: surplus.length, slots: slots.length },
    note: 'An area is the second dash-separated segment of the address text, not a polygon, and '
      + "two providers can write one place two ways — Terminal 3 is addressed both as Dubai Int'l "
      + 'Airport and as Al Garhoud. `waits` follows each VEHICLE instead. Gaps over four hours are '
      + 'excluded as shift ends rather than waiting.',
  });
});

app.get('/api/supply/balance', (req, r) => {
  const cells = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      if (h < 5 && dow % 3 === 0) continue;                 // uncollected
      const online = Math.round((4 + Math.sin(h / 3) * 3 + (h > 16 ? 6 : 0)) * 10) / 10;
      const jobs = Math.max(0, Math.round(online * (h > 6 && h < 23 ? 0.9 : 0.1)));
      const onJob = Math.round(jobs * 0.35 * 10) / 10;
      /* Per OCCURRENCE of the weekday, exactly as the real route answers: a
         30-day window holds five of two weekdays and four of the rest. The
         fixture used to omit this, so a page that summed the 168 cells and
         called the result the window's total looked correct here and was
         wrong by a factor of four against production. */
      const occurrences = dow < 2 ? 5 : 4;
      cells.push({ dow, h, occurrences, online_h: online, drivers: Math.max(1, Math.round(online / 2)),
        on_job_h: onJob, idle_h: Math.round((online - onJob) * 10) / 10, jobs,
        total_online_h: Math.round(online * occurrences * 10) / 10,
        total_jobs: jobs * occurrences,
        jobs_per_online_h: online ? Math.round((jobs / online) * 100) / 100 : null });
    }
  }
  const s = (k) => cells.reduce((a, c) => a + (c[k] || 0) * c.occurrences, 0);
  r.json({
    cells,
    totals: { online_h: Math.round(s('online_h')), on_job_h: Math.round(s('on_job_h')),
      idle_h: Math.round(s('idle_h')), jobs: s('jobs'),
      idle_pct: Math.round((s('idle_h') / s('online_h')) * 100),
      jobs_per_online_h: Math.round((s('jobs') / s('online_h')) * 100) / 100 },
    covered: true,
    /* The span the availability feed actually covers inside the window, which
       is what every hour figure above is over. Uber serves about 31 days of
       it and nothing older. */
    measured: { from: '2026-08-03', to: '2026-09-02', days: 31, narrower_than_window: false },
    basis: 'Online hours are split across the hours they were actually online in.',
  });
});

app.get('/api/supply/areas', (_, r) => r.json({
  areas: [
    { area: 'Al Garhoud', waits: 412, median_wait_min: 34, mean_wait_min: 51, waiting_h: 350.2 },
    { area: 'Business Bay', waits: 288, median_wait_min: 41, mean_wait_min: 58, waiting_h: 278.4 },
    { area: 'Dubai Marina', waits: 190, median_wait_min: 28, mean_wait_min: 39, waiting_h: 123.5 },
    { area: '(unrecorded)', waits: 96, median_wait_min: 46, mean_wait_min: 62, waiting_h: 99.2 },
  ],
  basis: 'Measured from a dropoff to that driver’s next request.',
}));

app.get('/api/driver/days', (req, r) => {
  const days = Array.from({ length: 6 }, (_, i) => {
    const day = dayISO(6 - i).slice(0, 10);
    const known = i > 1;
    const onJob = 120 + i * 7;
    return {
      day, fleet_id: 'ecosine', trips: 8 + i, completed: 7 + i, cancelled: 1,
      km: 96.4 + i, fares: null,
      first_min: 8 * 60 + 30, last_min: 21 * 60 + 10,
      on_job_min: onJob, wait_min: 430 - i * 5, longest_wait_min: 96,
      online_min: known ? 690 : null,
      idle_online_min: known ? 690 - onJob : null,
      computed_at: new Date(Date.now() - 3600e3).toISOString(),
    };
  });
  const covered = days.filter((d) => d.online_min != null);
  /* When the record was written. The live figures beside it come from the trip
     feed, which moves between collections, so today can differ by a trip or
     two — and a page that cannot date the record cannot tell a lag from a
     discrepancy. */
  const computedAt = days.reduce(
    (a, d) => (d.computed_at && (a == null || d.computed_at > a) ? d.computed_at : a), null);
  r.json({
    days,
    computed_at: computedAt,
    basis: 'One row per day, written after every collection and kept.',
    online_days: covered.length,
    totals: {
      computed_at: computedAt,
      days: days.length,
      trips: days.reduce((a, d) => a + d.trips, 0),
      on_job_min: days.reduce((a, d) => a + d.on_job_min, 0),
      wait_min: days.reduce((a, d) => a + d.wait_min, 0),
      online_min: covered.reduce((a, d) => a + d.online_min, 0),
      idle_online_min: covered.reduce((a, d) => a + d.idle_online_min, 0),
    },
  });
});

app.get('/api/driver/day', (req, r) => {
  const day = String(req.query.day || dayISO(1)).slice(0, 10);
  const mins = (h, m) => h * 60 + m;
  const trip = (i, s, e, extra = {}) => ({
    external_id: `uber-day-${i}`, platform: 'uber', fleet_id: 'ecosine', plate: 'A 12345',
    requested_at: `${day}T0${Math.floor(s / 60)}:00:00.000Z`,
    ended_at: `${day}T0${Math.floor(e / 60)}:00:00.000Z`,
    status: 'completed', outcome: 'completed',
    distance_km: 8.4, price: null, currency: 'AED', product: 'UberX', payment_type: 'cash',
    pickup_addr: 'Dubai Marina - Dubai - United Arab Emirates',
    dropoff_addr: 'DXB Terminal 3 - Dubai - United Arab Emirates',
    s, e, past_midnight: false, ...extra,
  });
  r.json({
    day,
    driver: { id: req.query.id || 'u-khalid', name: 'Khalid A', keys: [req.query.id || 'u-khalid'] },
    trips: [
      trip(1, mins(9, 43), mins(9, 54)),
      trip(2, mins(12, 38), mins(12, 47), { product: 'Comfort', payment_type: 'apple_pay' }),
      trip(3, mins(13, 7), mins(13, 23)),
    ],
    online: [{ s: mins(9, 20), e: mins(19, 35) }],
    fixes: [
      { plate: 'A 12345', m: mins(10, 10), lat: 25.247, lng: 55.347, speed: 0 },
      { plate: 'A 12345', m: mins(11, 10), lat: 25.247, lng: 55.347, speed: 0 },
      { plate: 'A 12345', m: mins(12, 10), lat: 25.251, lng: 55.352, speed: 14 },
    ],
    basis: 'A job runs from the request to the dropoff, so it contains the drive to the rider.',
    online_known: true,
  });
});

app.get('/api/export/trips.csv', (req, r) => {
  const grain = req.query.grain === 'trip' ? 'trip' : 'day';
  const cols = EXPORT_COLS[grain];
  const day = dayISO(1).slice(0, 10);
  /* Both fleets in one file, which is the property the page's link exists for:
     with no fleet chip set the export covers both organisations and each row
     names its own. A single-fleet fixture would let that regress unseen. */
  const row = (fleet) => (grain === 'day'
    ? [day, fleet, 'uber', 120, 113, 31, 28, 1480.5, 18, 4210.75, 'AED']
    : [day, fleet, 'uber', `uber-1-1-${fleet}`, `${day}T09:12:00.000Z`, `${day}T09:41:00.000Z`,
      'Khalid A', 'u-khalid', 'A 12345', 'Dubai Marina', 'DXB T3', 24.4,
      'UberX', 'card', 'completed', 'completed', 78.5, 'AED']);
  const body = [cols.join(','), row('ecosine').join(','), row('egari').join(',')].join('\n') + '\n';
  r.setHeader('content-type', 'text/csv; charset=utf-8');
  r.setHeader('content-disposition', `attachment; filename="trips-${grain}.csv"`);
  r.setHeader('x-export-rows', '2');
  r.send(body);
});

/* {rows, shown, history} — the endpoint returns the CURRENT target per platform
   and type, not a page of history. The mock returned a bare array, which is the
   shape the browser smoke test would then be validating against something the
   server no longer sends. */
/* Revenue by channel. The shape that matters is the DARK row: a channel with
   thousands of bookings and no money at all, which is what Uber is until its
   earnings surfaces are collected. A fixture where every channel reports a fare
   would make the page look finished. */
app.get('/api/revenue', (_, r) => {
  /* Every configured channel appears, whether or not it delivered anything —
     including the one that delivered nothing, which this page's own docstring
     calls the most useful row on it and which used never to be returned at
     all. Each row carries the collector's last verdict, so an empty channel
     says WHY it is empty. */
  const health = {
    uber: { collection_status: 'ok', collection_error: null, collection_at: dayISO(0) },
    hotel: { collection_status: 'ok', collection_error: null, collection_at: dayISO(0) },
    yango: { collection_status: 'ok', collection_error: null, collection_at: dayISO(0) },
    bolt: { collection_status: 'partial', collection_at: dayISO(0),
      collection_error: 'FI roster ecosine: code=503 NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED' },
  };
  const platforms = [
    { platform: 'uber', bookings: 6142, priced_bookings: 0, fares: null, priced_km: null,
      km: 78400, drivers: 61, vehicles: 74, payouts: null, cash: null, payout_periods: 0,
      components: null, tips: null, fare_coverage_pct: 0, revenue_per_km: null,
      per_km_basis: null, per_km_km: null,
      first_at: dayISO(30), last_at: dayISO(0), best: null, payout_drivers: 0,
      first_period: null, last_period: null, payout_days: 0, payout_coverage_pct: null,
      booking_days: 31, payout_coverage_days: null, payout_coverage_base: null,
      basis: 'none', basis_note: 'no fare on any booking and no payout reported — this channel’s money is dark',
      statement_net: 61200, statement_gross: 78400, statement_fees: 17200, statement_tips: 610,
      statement_salik: 2400, statement_cash: 12400, statement_bank: 46200, statement_days: 31,
      statement_drivers: 58 },
    { platform: 'hotel', bookings: 1267, priced_bookings: 1267, fares: 61400, priced_km: 15600,
      km: 15600, drivers: 22, vehicles: 31, payouts: null, cash: null, payout_periods: 0,
      components: null, tips: null, fare_coverage_pct: 100, revenue_per_km: 3.94,
      per_km_basis: 'fares', per_km_km: 15600,
      first_at: dayISO(30), last_at: dayISO(0), best: 61400, payout_drivers: 0,
      first_period: null, last_period: null, payout_days: 0, payout_coverage_pct: null,
      booking_days: 31, payout_coverage_days: null, payout_coverage_base: null,
      basis: 'fares', basis_note: 'fares reported on 1267 of 1267 bookings',
      statement_net: 14200, statement_gross: 15800, statement_fees: 1600, statement_tips: 0,
      statement_salik: 0, statement_cash: 0, statement_bank: 14200, statement_days: 31,
      statement_drivers: 21 },
    { platform: 'yango', bookings: 214, priced_bookings: 96, fares: 4180, priced_km: 1180,
      km: 2640, drivers: 9, vehicles: 11, payouts: 3210, cash: 640, payout_periods: 12,
      components: null, tips: null, fare_coverage_pct: 44.9, revenue_per_km: 1.22,
      per_km_basis: 'payout', per_km_km: 2640,
      first_at: dayISO(30), last_at: dayISO(0), best: 3210, payout_drivers: 9,
      first_period: dayISO(28).slice(0, 10), last_period: dayISO(0).slice(0, 10),
      payout_days: 29, payout_coverage_pct: 93.5,
      /* Coverage is measured against the days the channel WORKED (booking_days),
         not the calendar window — see api/income_sql.js coverage(). */
      booking_days: 31, payout_coverage_days: 29, payout_coverage_base: 31,
      basis: 'payout', basis_note: 'net payout — only 44.9% of bookings report a fare',
      statement_net: 980, statement_gross: 1220, statement_fees: 240, statement_tips: 0,
      statement_salik: 40, statement_cash: 520, statement_bank: 460, statement_days: 29,
      statement_drivers: 9 },
    { platform: 'bolt', bookings: 618, priced_bookings: 121, fares: 5100, priced_km: 1490,
      km: 7300, drivers: 14, vehicles: 18, payouts: null, cash: null, payout_periods: 0,
      components: null, tips: null, fare_coverage_pct: 19.6, revenue_per_km: 3.42,
      first_at: dayISO(30), last_at: dayISO(0), best: 5100, payout_drivers: 0,
      first_period: null, last_period: null, payout_days: 0, payout_coverage_pct: null,
      basis: 'partial_fares',
      basis_note: 'fares on only 121 of 618 bookings (19.6%) — the rest of this channel’s money is not collected' },
  ].map((x) => ({ ...x, ...health[x.platform] }));
  const components = [
    { platform: 'uber', category: 'net_fare', parent: null, amount: 41200, drivers: 58 },
    { platform: 'uber', category: 'tip', parent: 'net_fare', amount: 1840, drivers: 34 },
    { platform: 'uber', category: 'toll', parent: 'net_fare', amount: 610, drivers: 41 },
    { platform: 'uber', category: 'cash_collected', parent: null, amount: -8300, drivers: 44 },
  ];
  r.json({
    window: [dayISO(30).slice(0, 10), dayISO(0).slice(0, 10)], window_days: 31,
    platforms, components,
    totals: { bookings: 8241, priced_bookings: 1484, fares: 70680, payouts: 3210, cash: 640,
      statement_net: 76380, statement_cash: 12920, statement_bank: 60860,
      tips: 1840, accounted: 69790, accounted_bookings: 1481, dark_bookings: 6760, dark_pct: 82 },
    caveat: 'uber, bolt account for 6760 of 8241 bookings in this window and report little or no money. '
      + 'Every fleet-wide revenue figure in this product is over what did land, so all of them understate '
      + 'what the fleet took.',
    measured_platforms: ['hotel'],
    silent_platforms: [],
  });
});

/* Reconciliation: bank payout against on-trip net + tips + salik − cash, per
   month or per day of one month. The shapes that matter: a month with work and
   NO statement (expected null, never 0 — the surface does not reach that far
   back), a month whose statement names only some of the drivers the bank paid
   (so the row shows what was actually compared beside what was reported), and
   deltas landing in each tone band so the smoke run exercises the green, warn
   and critical pills rather than only one of them. */
app.get('/api/reconcile', (req, r) => {
  const note = 'Bank payout ≈ on-trip net + tips + salik − cash collected: what the '
    + 'platform wires is what the fleet earned on-trip, plus tips and toll reimbursements, '
    + 'minus the cash its drivers already hold — proven to 0.7% on July 2026. The gap is '
    + 'measured over the driver-days BOTH sides describe, never over a whole month against '
    + 'a fraction of one.';
  const round2 = (v) => Math.round(v * 100) / 100;
  /* The delta is the difference of the two COVERED figures — the money on the
     (driver, day) pairs both sides describe — not of the two full columns. A
     fixture that subtracted the full ones would let the page ship the very bug
     it was built to show. */
  const finish = (row) => {
    const expected = row.ontrip_net == null ? null
      : round2(row.ontrip_net + (row.tips || 0) + (row.salik || 0) - (row.cash_collected || 0));
    const matched = row.matched_pairs || 0;
    const expectedCovered = !matched ? null
      : round2(row.expected_covered != null ? row.expected_covered : expected);
    const bankCovered = !matched ? null
      : round2(row.bank_covered != null ? row.bank_covered : row.bank_payout);
    const delta = expectedCovered == null || bankCovered == null ? null
      : round2(bankCovered - expectedCovered);
    return { platform: req.query.platform || '*', accrual: false, ...row,
      expected_payout: expected, expected_covered: expectedCovered, bank_covered: bankCovered,
      matched_pairs: matched, matched_drivers: row.matched_drivers || 0,
      matched_days: row.matched_days || 0, bank_drivers: row.bank_drivers || 0,
      ontrip_drivers: row.ontrip_drivers || 0, delta,
      delta_pct: delta == null || !expectedCovered
        ? null : Math.round((delta / Math.abs(expectedCovered)) * 1000) / 10 };
  };
  const totalsOf = (rows) => {
    const sum = (k) => {
      const xs = rows.map((x) => x[k]).filter((v) => v != null);
      return xs.length ? round2(xs.reduce((a, b) => a + b, 0)) : null;
    };
    const rec = rows.filter((x) => x.delta != null);
    const recExpected = rec.reduce((a, x) => a + x.expected_covered, 0);
    const delta = rec.length ? round2(rec.reduce((a, x) => a + x.delta, 0)) : null;
    return { trips: sum('trips'), ontrip_net: sum('ontrip_net'), tips: sum('tips'),
      salik: sum('salik'), cash_collected: sum('cash_collected'),
      expected_payout: sum('expected_payout'), bank_payout: sum('bank_payout'),
      expected_covered: sum('expected_covered'), bank_covered: sum('bank_covered'),
      matched_pairs: rows.reduce((a, x) => a + (x.matched_pairs || 0), 0),
      reconciled_rows: rec.length, delta,
      delta_pct: delta != null && recExpected ? Math.round((delta / Math.abs(recExpected)) * 1000) / 10 : null };
  };
  const lastDayOf = (ym) => {
    const [y, mo] = ym.split('-').map(Number);
    return `${ym}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
  };

  const month = req.query.month || null;
  if (month) {
    const [y, mo] = month.split('-').map(Number);
    const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const rows = Array.from({ length: daysIn }, (_, i) => {
      const d = `${month}-${String(i + 1).padStart(2, '0')}`;
      // Beyond the 22nd nothing has landed yet; day 5 has no statement and
      // day 9 no payout, so the drill shows dashes where a source is silent.
      if (i >= 22) return finish({ d, trips: null, ontrip_net: null, tips: null, salik: null,
        cash_collected: null, ontrip_days: 0, bank_payout: null, payout_days: 0 });
      const net = 5800 + (i % 7) * 240;
      const stmt = i !== 4;
      const paid = i !== 8;
      const bank = paid ? round2(net * 0.82 + 120 + (i % 5) * 60) : null;
      const expected = stmt
        ? round2(net + (60 + (i % 3) * 10) + (170 + (i % 4) * 12) - (1150 + (i % 6) * 90)) : null;
      // Of the 52 drivers the bank paid that day, the statement names some.
      const matchedDrivers = stmt && paid ? 34 + (i % 7) : 0;
      // Three tone bands, so the pills are all exercised by one drill.
      const band = [0.9, 5.5, 22][i % 3];
      const expectedCovered = matchedDrivers ? round2(expected * (matchedDrivers / 52)) : null;
      return finish({ d, trips: 220 + (i % 5) * 14,
        ontrip_net: stmt ? net : null, tips: stmt ? 60 + (i % 3) * 10 : null,
        salik: stmt ? 170 + (i % 4) * 12 : null, cash_collected: stmt ? 1150 + (i % 6) * 90 : null,
        ontrip_days: stmt ? 1 : 0, ontrip_drivers: stmt ? 46 + (i % 5) : 0,
        bank_payout: bank, payout_days: paid ? 1 : 0,
        expected_covered: expectedCovered,
        bank_covered: expectedCovered == null ? null : round2(expectedCovered * (1 + band / 100)),
        matched_pairs: matchedDrivers, matched_drivers: matchedDrivers,
        matched_days: matchedDrivers ? 1 : 0, bank_drivers: paid ? 52 : 0 });
    });
    return r.json({ grain: 'day', month,
      scope: { kind: 'month', label: month, from: `${month}-01`, to: lastDayOf(month),
        rows: rows.length },
      trips_source: 'rollup', rows, totals: totalsOf(rows), note });
  }

  const rows = [
    // Work with no statement behind it: the surface does not reach March.
    { m: '2026-03', trips: 5820, ontrip_net: null, tips: null, salik: null, cash_collected: null,
      ontrip_days: 0, ontrip_drivers: 0, bank_payout: 148200, payout_days: 31 },
    // A statement covering twelve days and two thirds of the drivers on them:
    // the shape that used to print as a 130% discrepancy.
    { m: '2026-04', trips: 6240, ontrip_net: 171400, tips: 2110, salik: 5230, cash_collected: 34600,
      ontrip_days: 12, ontrip_drivers: 41, bank_payout: 143210, payout_days: 30,
      expected_covered: 38100, bank_covered: 40260, matched_pairs: 468, matched_drivers: 39,
      matched_days: 12, bank_drivers: 58 },
    { m: '2026-05', trips: 6105, ontrip_net: 168300, tips: 1980, salik: 5010, cash_collected: 33800,
      ontrip_days: 31, ontrip_drivers: 55, bank_payout: 132600, payout_days: 31,
      expected_covered: 128400, bank_covered: 132600, matched_pairs: 1612, matched_drivers: 52,
      matched_days: 31, bank_drivers: 57 },
    { m: '2026-06', trips: 5570, ontrip_net: 152800, tips: 1720, salik: 4620, cash_collected: 30900,
      ontrip_days: 30, ontrip_drivers: 51, bank_payout: 109300, payout_days: 28,
      expected_covered: 118600, bank_covered: 109300, matched_pairs: 1400, matched_drivers: 50,
      matched_days: 28, bank_drivers: 54 },
    // The proven month: the identity holds to 0.7%.
    { m: '2026-07', trips: 7356, ontrip_net: 199930, tips: 2410, salik: 6110, cash_collected: 41800,
      ontrip_days: 31, ontrip_drivers: 58, bank_payout: 167820, payout_days: 31,
      expected_covered: 166650, bank_covered: 167820, matched_pairs: 1798, matched_drivers: 58,
      matched_days: 31, bank_drivers: 58 },
    { m: '2026-08', trips: 4820, ontrip_net: 132400, tips: 1610, salik: 4030, cash_collected: 27400,
      ontrip_days: 22, ontrip_drivers: 49, bank_payout: 104300, payout_days: 21,
      expected_covered: 98300, bank_covered: 104300, matched_pairs: 1029, matched_drivers: 49,
      matched_days: 21, bank_drivers: 53 },
  ].map(finish);
  r.json({ grain: 'month', month: null,
    scope: { kind: 'all-time', label: 'every month on record',
      from: `${rows[0].m}-01`, to: lastDayOf(rows[rows.length - 1].m), rows: rows.length },
    trips_source: 'rollup', rows, totals: totalsOf(rows), note });
});

app.get('/api/recommendations', (_, r) => r.json({ shown: 3, truncated: false, history: 42, rows: [
  { platform: 'uber', rec_type: 'acceptance_rate', period_start: dayISO(28), period_end: dayISO(0),
    org_value: 0.79, target_value: 0.85, flagged_count: 14, flagged: true, updated_at: new Date().toISOString() },
  { platform: 'uber', rec_type: 'cancellation_rate', period_start: dayISO(28), period_end: dayISO(0),
    org_value: 0.11, target_value: 0.06, flagged_count: 9, flagged: true, updated_at: new Date().toISOString() },
  { platform: 'uber', rec_type: 'driver_rating', period_start: dayISO(28), period_end: dayISO(0),
    org_value: 4.82, target_value: 4.7, flagged_count: 2, flagged: false, updated_at: new Date().toISOString() },
] }));


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
  driver_count: 63, shown: 8, truncated: true,
  drivers: drivers.map((d, i) => ({ driver_name: d, driver_ext_id: `drv-${i}`, cash_trips: 60 - i * 6,
    priced_cash_trips: Math.max(0, 14 - i * 2), cash_value: Math.max(0, 14 - i * 2) * 95,
    value_known_pct: Math.round((Math.max(0, 14 - i * 2) / (60 - i * 6)) * 100),
    /* The platform's own cash figure per person, which is what the Value known
       column cannot see: most of these people have one and no priced booking,
       which is the production shape. One has neither, so the "—" branch stays
       reachable. */
    statement_cash: i === 3 ? null : (60 - i * 6) * 47,
    statement_days: i === 3 ? 0 : 21 - i,
    /* One name spelled two ways is the production shape; both rows carry the
       same money and say so, so the dagger branch is reachable. */
    statement_name_rows: i === 1 || i === 2 ? 2 : 1,
    platforms: ['uber', 'hotel'], plates: [plates[i], plates[(i + 1) % plates.length]],
    last_cash_trip: new Date(Date.now() - i * 36e5).toISOString() })),
  total_cash_trips: 430, total_cash_value_known: 7300, value_known_pct: 20,
  total_statement_cash: 12034, statement_cash_drivers: 6,
  caveat: '342 of 430 cash trips come from a channel that does not report a fare, so the value column is a floor, not the total.',
}));
/* One row per counterparty — the group key used to carry driver_ext_id, which
   split one hotel into eight rows — and an ageing measured over the debt
   rather than over the selected window, which is why oldest_days here exceeds
   any range the page offers. */
app.get('/api/settlement/receivables', (_, r) => r.json({
  counterparties: 41, priced_trips: 180, oldest_days: 96, shown: 8, truncated: true,
  /* RECV_TO_DATE binds only the upper end, so the oldest debt really is the
     oldest on record. The tile has always branched on this and the endpoint
     never sent it, so the page claimed the figure was bounded by the window. */
  ages_over_all_time: true,
  rows: hotels.map((h, i) => ({ settlement_class: 'on_account', label: 'On account', counterparty: h.name,
    partner_id: h.id, driver_ext_id: null, driver_ids: [], drivers: 3 + i,
    trips: 30 - i * 6, priced_trips: 30 - i * 6,
    amount: (30 - i * 6) * 110, oldest: dayISO(70 - i * 10), newest: dayISO(i),
    age_days: 70 - i * 10 })).concat([{ settlement_class: 'salary', label: 'Salary deduction',
      counterparty: drivers[0], partner_id: null, driver_ext_id: 'drv-0', driver_ids: ['drv-0'],
      drivers: 1, trips: 12, priced_trips: 12,
      amount: 980, oldest: dayISO(41), newest: dayISO(3), age_days: 41 }]),
  total: 8250, total_trips: 84,
  ageing: {
    as_at: dayISO(0).slice(0, 10),
    note: 'Nothing in this data records a receivable being settled, so every '
      + 'receivable booking up to the end of the selected window is counted as '
      + 'outstanding. Ageing is measured from the booking date.',
    total_trips: 84,
    buckets: [
      { label: '0-30 days', trips: 41, counterparties: 7, amount: 4180 },
      { label: '31-60 days', trips: 26, counterparties: 5, amount: 2640 },
      { label: '61-90 days', trips: 12, counterparties: 3, amount: 1210 },
      { label: 'over 90 days', trips: 5, counterparties: 2, amount: 220 },
    ],
  },
}));
app.get('/api/corporate/summary', (_, r) => r.json({
  bookings: 1253, priced: 1245, revenue: 138400, cost: 96200, has_cost: true, avg_fare: 111.2, km: 18600,
  revenue_per_km: 7.44, deadhead_km: 3120, deadhead_measured: 1140, deadhead_measured_pct: 91,
  deadhead_ratio_pct: 16.8, foc_trips: 10, overrun_trips: 7, scheduled_trips: 604, scheduled_pct: 48.2,
  authorized_trips: 155, authorized_pct: 12.4, missing_trips: 0, guests: 812, properties: 4,
  drivers: 35, vehicles: 35, outside_dubai: 9, zoned: 707, outside_dubai_pct: 1.3,
  concentration_hhi: 3480, top_property: 'Palm Grand', partner_id: 'h-palm', top_property_share_pct: 55.5,
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
    /* 40 of a property's 478 passengers were listed with nothing saying so. */
    guests_shown: 18, guests_truncated: true,
    drivers: drivers.map((d, i) => ({ driver_name: d, driver_ext_id: `drv-${i}`, bookings: 60 - i * 6,
      avg_deadhead_km: 1.8 + i * 0.4, revenue: (60 - i * 6) * 110 })),
    drivers_shown: drivers.length, drivers_truncated: false,
    dayparts: [{ label: 'night', n: 90 }, { label: 'morning', n: 210 }, { label: 'midday', n: 160 },
      { label: 'evening', n: 180 }, { label: 'late', n: 56 }],
  });
});
app.get('/api/corporate/guests', (_, r) => r.json({
  repeat_rooms: 37, repeat_bookings: 94, rooms_truncated: true,
  guests: Array.from({ length: 40 }, (_, i) => ({ guest_id: `guest-${2000 + i}`, bookings: 8 - (i % 7),
    revenue: (8 - (i % 7)) * 108, priced: 8 - (i % 7), properties: 1 + (i % 2),
    property: hotels[i % hotels.length].name, partner_id: 'h-palm', room_no: String(900 + i),
    purpose: i % 5 === 0 ? 'AIRPORT TRANSFER' : null, first_at: dayISO(90 - i), last_at: dayISO(i % 30),
    km: (8 - (i % 7)) * 14, span_days: 90 - i - (i % 30) })),
  // 300 of 875 guest rows reached the page, with nothing saying so.
  guests_shown: 40, guests_truncated: true,
  total_guests: 812, total_bookings: 1253, repeat_guests: 214, repeat_rate_pct: 26.4,
  bookings_from_repeat_pct: 48.1, bookings_with_room: 168, distinct_rooms: 139,
  id_is_per_booking: false, caveat: null,
  rooms: Array.from({ length: 10 }, (_, i) => ({ room_no: String(1200 + i), bookings: 6 - (i % 5),
    properties: 1, property: hotels[i % hotels.length].name, partner_id: 'h-palm', revenue: (6 - (i % 5)) * 110,
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
    property: hotels[i % hotels.length].name, partner_id: 'h-palm', partner_id: hotels[i % hotels.length].id,
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
    // The return leg is deliberately LARGER than the approach here, because
    // that is what the live data shows and it is the whole point of measuring
    // it: the leg this page used to omit is the bigger one.
    const measuredReturn = Math.round(measured * 0.76);
    const bothN = Math.round(measured * 0.7);
    const ret = Math.round((3.9 + i * 1.1) * measuredReturn * 10) / 10;
    const bothKm = Math.round((2.4 + i * 0.7 + 3.9 + i * 1.1) * bothN * 10) / 10;
    return { label, bookings, measured, measured_return: measuredReturn, measured_both: bothN,
      deadhead_km: deadhead, avg_deadhead_km: 2.4 + i * 0.7,
      return_km: ret, avg_return_km: 3.9 + i * 1.1,
      both_km: bothKm, avg_both_km: Math.round((6.3 + i * 1.8) * 100) / 100,
      paid_km: paid, ratio_pct: Math.round((deadhead / paid) * 1000) / 10,
      both_ratio_pct: Math.round((bothKm / paid) * 1000) / 10,
      stranded_15km: i % 3 === 0 ? 4 + i : 0 };
  }).filter((x) => x.bookings > 0));
});

/* Which drop-off points leave a driver furthest from the next job. Not where
   work happens — where it costs the most to walk away from. */
app.get('/api/corporate/stranding', (_, r) => {
  /* Ranked and capped, and it says so — bin/cap-audit.mjs found the real
     endpoint returning exactly its LIMIT with nothing said, and a mock that
     answered in the old shape would let the page's own disclosure rot. */
  const rows = ['Jebel Ali Free Zone', 'Al Qudra Rd', 'Dubai Investment Park', 'Hatta Rd',
    'Al Maktoum Airport', 'Dubai Marina', 'DXB T3', 'Deira']
    .map((place, i) => ({
      place, drops: 40 - i * 4, measured: 34 - i * 3,
      avg_return_km: Math.round((28 - i * 3.4) * 100) / 100,
      return_km: Math.round((28 - i * 3.4) * (34 - i * 3) * 10) / 10,
      worst_km: Math.round((46 - i * 4) * 10) / 10,
      over_15km: Math.max(0, 12 - i * 2),
      avg_paid_km: Math.round((9 + i * 1.6) * 10) / 10,
    }));
  r.json({ rows, total: rows.length + 5, shown: rows.length, truncated: true });
});
app.get('/api/tiers/by-vehicle', (_, r) => r.json({
  fleet_premium_pct: 12.1,
  /* The trip floor the two comparison columns rest on, and how many cars
     cleared it — returned so the page can name it instead of hardcoding a
     number in a tooltip that can drift from the arithmetic. */
  premium_min_trips: 20, premium_rated_vehicles: plates.length,
  total: plates.length, shown: plates.length, truncated: false,
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
      driver_refs: [{ name: drivers[i % drivers.length], id: `drv-${i % drivers.length}`, days: 24 },
        { name: drivers[(i + 1) % drivers.length], id: `drv-${(i + 1) % drivers.length}`, days: 4 }],
      driver_n: 2 + (i % 2),
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
/* The nightly verification's verdicts, as the coverage page reads them.
   ─────────────────────────────────────────────────────────────────────────
   Three shapes, because the panel renders three differently and a fixture with
   only the happy one proves nothing: a window that agrees exactly, a window
   Uber serves more of than we hold (the March 2026 shape this whole feature
   exists for), and a window past Uber's retention that cannot be asked at all
   and must NOT read as a failure of ours. */
app.get('/api/coverage/verified', (_, r) => {
  const w = (fleet, from, to, uber, ours, err, kind = 'month') => ({
    fleet_id: fleet, kind, window_from: from, window_to: to,
    verified_at: dayISO(1),
    uber_rows: err ? null : uber, our_rows: err ? null : ours,
    in_both: err ? null : ours, uber_only: err ? null : uber - ours, ours_only: 0,
    agreement_pct: err || !uber ? null : Math.round((ours / uber) * 1000) / 10,
    outside_window: err ? null : 3, error: err || null, past_retention: !!err,
    /* Trips this fleet's report lists that we hold under the OTHER fleet's
       name. Not loss — the trip upsert overwrites fleet_id, so a trip both
       orgs can see is filed under whichever collected it last. */
    misfiled: err ? null : Math.max(0, Math.round((uber - ours) * 0.02)),
    took_ms: err ? 900 : 41000, sample_missing: err ? [] : [],
    /* Only the days that disagreed, which is what the collector stores: a
       verified month is 31 rows of "uber 512, ours 512" and would make this
       the largest column in the table for the windows it says least about. */
    days: err || uber === ours ? [] : (() => {
      const out = [];
      for (let d = 1; d <= 31; d++) {
        const day = `${from.slice(0, 8)}${String(d).padStart(2, '0')}`;
        if (day > to) break;
        const u = Math.round(uber / 31), o = d <= 7 ? 0 : Math.round(ours / 24);
        out.push({ day, uber: u, ours: o, missing: u - o });
      }
      return out;
    })(),
  });
  const windows = [
    w('ecosine', '2026-07-01', '2026-07-31', 6703, 6703),
    w('egari', '2026-07-01', '2026-07-31', 2952, 2952),
    w('ecosine', '2026-03-01', '2026-03-31', 17102, 4203),
    w('egari', '2026-03-01', '2026-03-31', 7788, 1862),
    w('ecosine', '2025-08-01', '2025-08-31', 0, 0, 'generate: invalid date range'),
    /* A week window, which sits INSIDE the July month rows above. It must be
       listed and must never be added to the totals — the fixture exists to
       make a regression on that visible rather than plausible. */
    w('ecosine', '2026-07-06', '2026-07-12', 1544, 1544, null, 'week'),
  ];
  const ok = windows.filter((x) => !x.error);
  const months = ok.filter((x) => x.kind !== 'week');
  const sum = (k) => months.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  r.json({
    windows,
    verified_windows: windows.length, measured_windows: ok.length, measured_months: months.length,
    totals_over: 'whole calendar months only; week windows are listed but never added',
    past_retention_windows: windows.filter((x) => x.past_retention).length,
    errored_windows: 0,
    disagreeing_windows: ok.filter((x) => x.uber_only > 0).length,
    uber_rows: sum('uber_rows'), our_rows: sum('our_rows'),
    trips_uber_has_that_we_never_stored: sum('uber_only'),
    trips_filed_under_the_other_fleet: sum('misfiled'),
    agreement_pct: Math.round(((sum('uber_rows') - sum('uber_only')) / sum('uber_rows')) * 1000) / 10,
    last_verified_at: dayISO(1),
    verifies: 'trips only. Uber money is a rolling 192-day window and a rating has no history to check.',
    horizons: {
      money: { from_day: '2026-02-09', to_day: dayISO(1), rows: 4210,
        note: 'rolling window of about 192 days' },
      rating: { from_day: dayISO(0), to_day: dayISO(0), rows: 93,
        note: 'one current number, no history' },
    },
  });
});
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
      // A gap the provider has already answered "nothing" for looks identical
      // to one nobody requested, until the chunk records say which it is.
      gaps: gaps.map((g, gi) => ({ ...g,
        verdict: gi === 0 ? 'asked_and_empty' : gi === 1 ? 'never_asked' : 'window_failed',
        // A partly-requested gap: the middle case, which is the one worth
        // being able to tell apart from an entirely unrequested one.
        days_answered: gi === 0 ? g.days : gi === 1 ? Math.floor(g.days / 3) : 0,
        days_failed: gi === 2 ? g.days : 0,
        days_unrequested: gi === 0 ? 0 : gi === 1 ? g.days - Math.floor(g.days / 3) : 0 })),
      gaps_asked_and_empty: gaps[0]?.days || 0,
      gaps_never_asked: gaps[1]?.days || 0,
      gaps_window_failed: gaps[2]?.days || 0,
      missing_days: holeDays || 0, days };
  };
  r.json({ window: [dayISO(90).slice(0, 10), dayISO(0).slice(0, 10)],
    sources: [src('uber', 36, 18, 430), src('fms', null, 0, 260), src('hotel', null, 0, 14),
      src('yango', 70, 40, 6)],
    // Two independent providers dark over the same window, resuming the same
    // day. The live fleet has exactly this shape across four months.
    shared_silence: [
      { from: dayISO(36).slice(0, 10), to: dayISO(19).slice(0, 10), days: 18, sources: ['fms', 'uber'] },
      { from: dayISO(70).slice(0, 10), to: dayISO(66).slice(0, 10), days: 5, sources: ['uber', 'yango'] },
    ] });
});
app.get('/api/geo/corridors', (_, r) => {
  const areas = ['Al Thanyah Fifth', 'Business Bay', 'Dubai Airport', 'Palm Jumeirah', 'Al Barsha 1',
    'Marsa Dubai', 'Downtown Dubai', 'Al Nahda First', 'Jumeirah 1', 'Deira'];
  r.json({
  totals: { corridors_3plus: 47, corridors_all: 210, origins_all: 63 },
  shown: 60, truncated: true, origins_shown: 40, origins_truncated: true,
    /* The tiles and the origins panel are a roll-up of the same aggregate the
       corridor list needs, so they can be asked for on their own — cold at 365
       days the live endpoint measured 8.45s and the page 7.9-14.4s of one
       skeleton. */
    part: 'all',
    /* No collector writes duration_s, so nothing here is REPORTED — but the
       two timestamps on a booking carry the time and the endpoint derives it,
       which is why duration_measured is large and duration_reported is zero.
       That pair is what makes the page label the column "Request → drop"
       rather than "Avg minutes". */
    duration_measured: 4120,
    duration_reported: 0,
    note: 'Areas are parsed from the address text each provider returns, not from a place id. '
      + 'Bookings only — an FMS row is the tracker\'s own record of a journey a ride platform '
      + 'already reported, and counting it would chart the same trip twice.',
    corridors: areas.flatMap((a, i) => areas.slice(0, 4).map((b, j) => ({
      from_area: a, to_area: b, trips: Math.max(3, 90 - i * 6 - j * 9),
      avg_km: 8 + j * 4, avg_min: 18 + j * 7, min_n: 18 + j, min_reported_n: 0,
      priced: (i + j) % 3 ? 0 : 20, complimentary: (i + j) % 5 === 0 ? 1 : 0,
      avg_fare: (i + j) % 3 ? null : 96 + j * 12, platforms: ['uber', 'fms'] }))).filter((c) => c.from_area !== c.to_area),
    origins: areas.map((area, i) => ({ area, trips: 420 - i * 34, morning: 200 - i * 18,
      evening: 180 - i * 12, avg_km: 11 + i * 0.5 })),
  });
});
/* One row per driver, not one per overlapping report period — and the state
   comes from driver_platform_state, which is the only place it exists. */
app.get('/api/funnel/drivers', (_, r) => {
  const rows = drivers.map((d, i) => ({
  platform: i % 2 ? 'yango' : 'bolt', driver_name: d, driver_ext_id: `drv-${i}`,
  person_key: `drv-${i}`,
  period_start: dayISO(28), period_end: dayISO(0), period_days: 29, periods_seen: 1 + (i % 3),
  can_earn: i !== 6, state_raw: i === 6 ? 'BLOCKED' : 'ACTIVE',
  offered: 200 - i * 14, accepted: 150 - i * 12, completed: 120 - i * 10,
  cancelled_driver: 4 + i, cancelled_client: 8 + i, work_time_seconds: 360000 - i * 20000,
  price_cash: 3000 - i * 200, price_cashless: 1000 - i * 60, commission: -(800 - i * 50),
  driver_score: 90 - i * 3, state: i === 6 ? 'suspended' : 'active',
  accept_pct: Math.round(((150 - i * 12) / (200 - i * 14)) * 1000) / 10,
  complete_pct: Math.round(((120 - i * 10) / (150 - i * 12)) * 1000) / 10,
  commission_cost: 800 - i * 50, gross: 4000 - i * 260, hours: Math.round((360000 - i * 20000) / 360) / 10,
  cash_pct: Math.round(((3000 - i * 200) / (4000 - i * 260)) * 1000) / 10,
  }));
  r.json({ rows, total: rows.length, shown: rows.length, truncated: false });
});


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
    findings: all.filter((f) => want.includes(f.verdict)),
    fleet: null,
    /* Whether the model that writes these is configured at all. An empty list
       means "no finding" only when the generator can run; with ARK_API_KEY
       unset it means the pass has never happened, and the page described that
       as a scheduling delay. */
    configured: true,
    /* What the last pass actually did, so an empty list can say which of the
       three nothings it is. See sql/schema_v35.sql — production ran nightly
       into a 429 and a timeout while every page reported the analyst quiet. */
    last_pass: { run_id: 'an-20260821', outcome: 'ok', proposed: 5, dropped: 2,
      confirmed: 2, model: 'glm-5-2-260617', error: null, duration_ms: 41200,
      finished_at: new Date().toISOString() },
    empty_reason: null,
    platform_applies: false });
});
app.post('/api/analyst/run', (_, r) => r.json({ ok: true, queued: 'analyst', fleet: null, job_id: '42' }));

app.get('/api/analyst/brief', (_, r) => r.json({
  window: [dayISO(30), dayISO(0)], fleet: 'both',
  headline: { bookings: 2043, telematics: 1500, completed: 1820, bookable: 2043,
    avg_fare: '76.98', priced: 904, vehicles: 8, drivers: 9 },
  by_platform: [{ platform: 'uber', n: 1600, completion_pct: '88.3', avg_km: '13.7' }],
  uber_tier_by_daypart: [], settlement: [], properties: [], by_daypart: [], coverage: [],
  /* One metric carried by a single platform, so the "no complement" line is
     reachable in the smoke test. */
  metric_coverage: {
    completion_pct: { rows: 2043, platforms: ['hotel', 'uber'], unit: '%' },
    avg_deadhead_km: { rows: 874, platforms: ['hotel'], unit: 'km' },
  },
  candidates: {
    platform: [{ segment: 'uber', n: 1600 }, { segment: 'hotel', n: 443 }],
    daypart: [{ segment: 'evening', n: 700 }, { segment: 'night', n: 240 }],
    weekday: [{ segment: 'Thursday', n: 420 }],
  },
}));

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
  const cats = ROSTER_CATS;
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
      /* Most people have a payout and no fare — the production shape, where
         Uber is most of the work and publishes no fare per trip. */
      revenue: category === 'working' && i % 3 === 0 ? (120 - i * 9) * 74 : null,
      /* …and the statement's own fare line for the two thirds who have no
         per-trip fare, which is where the Fares column used to read "—". */
      statement_fares: category === 'working' && i % 3 !== 0 ? (120 - i * 9) * 88 : null,
      statement_fare_periods: category === 'working' && i % 3 !== 0 ? 3 : 0,
      fleets_worked: category === 'working' ? [i % 2 ? 'ecosine' : 'egari'] : null,
      payout: category === 'working' ? (120 - i * 9) * 61 : null,
      payout_days: category === 'working' ? Math.max(1, 26 - i) : 0,
      km: category === 'working' ? (120 - i * 9) * 12 : null,
      last_trip: category === 'working' ? dayISO(i % 5) : null,
      /* Three states, because the page renders three: a real count, a zero for
         somebody we looked for and found nothing, and null for somebody whose
         only platform we collect no trips for. */
      lifetime_trips: category === 'never_started' ? 0
        : category === 'activity_unknown' ? null : 900 - i * 60,
      first_trip: category === 'never_started' ? null : dayISO(300),
      last_ever: category === 'never_started' ? null : dayISO(category === 'working' ? i % 5 : 40 + i),
      category, holding_vehicle_while_blocked: blocked,
      days_since_last_trip: category === 'never_started' ? null : (category === 'working' ? i % 5 : 40 + i) };
  });
  const c = (k) => people.filter((x) => x.category === k).length;
  r.json({ window: [dayISO(30), dayISO(0)], people,
    // Which channels actually had trips in this window, so "idle" can mean
    // "did not work" rather than "the channel they work was not collected".
    platforms_with_trips: ['uber', 'yango', 'bolt', 'hotel'],
    /* driver_platform_state.fleet_id is the credential set that collected a
       standing, not the fleet somebody drives for — treating the two as one
       returned the whole Bolt roster for &fleet=egari. */
    fleet_basis: null,
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
      progress: { current: 'hotel', done: 4, total: 8, remaining: ['external', 'events', 'fms'],
        steps: 7, step: { window: '2026-03-01..2026-03-31', index: 6, of: 12, rows_so_far: 18420 } } },
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
      /* The day's income: fares from the hotel channel plus a share of the
         weekly Uber statements covering this day. payout_basis is what stops
         that share reading as something measured on the day itself. */
      accounted: 10430, accounted_fares: 4180, accounted_payouts: 6250,
      accounted_platforms: ['hotel', 'uber'], accounted_bookings: 215,
      dark_bookings: 0, dark_pct: 0,
      payout_basis: 'a share of each weekly platform statement, spread evenly across the days it covers',
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
      km: (30 - i * 3) * 14, drivers: 1 + (i % 2), revenue: i % 2 ? (30 - i * 3) * 88 : null,
      // Named, not counted — the plate alone is not somebody you can ring.
      driver_names: i % 2 ? drivers[i % drivers.length] : `${drivers[i % drivers.length]}, ${drivers[(i + 1) % drivers.length]}`,
      driver_refs: (i % 2 ? [i] : [i, i + 1]).map((j) => ({
        name: drivers[j % drivers.length], id: `drv-${j % drivers.length}` })) })),
    tiers: [{ tier: 'Electric', n: 78 }, { tier: 'UberX', n: 64 }, { tier: 'Comfort', n: 15 }, { tier: 'Black', n: 11 }],
    settlement: [{ settlement_class: 'card', n: 96, revenue: 1180 }, { settlement_class: 'cash', n: 52, revenue: 900 },
      { settlement_class: 'off_platform', n: 44, revenue: null }, { settlement_class: 'on_account', n: 12, revenue: 1310 }],
    alerts: [{ alert_type: 'Harsh Brake', n: 14, plates: 9, on_plates: plates.slice(0, 9) },
      { alert_type: 'Harsh Acceleration', n: 8, plates: 6, on_plates: plates.slice(0, 6) },
      { alert_type: 'Main Power Lost', n: 1, plates: 1, on_plates: [plates[0]] }],
    /* The same events against the person driving. Grouped by type it is the
       shape of the day; grouped by vehicle with custody attached it is a list
       of conversations to have tomorrow. */
    /* Real sizes beside the capped lists, so the "showing 6 of 41" captions on
       #day are reachable from the fixture. A mock that always returns
       everything cannot exercise a truncation notice. */
    capped: { alerts_by_vehicle: 41, segments: 88 },
    alertsByVehicle: plates.slice(0, 6).map((p2, i) => ({
      plate: p2, n: 14 - i * 2, harsh_brake: 6 - i, harsh_accel: 4 - i,
      sharp_turn: 3, overspeed: 1 + i,
      drivers: drivers[i % drivers.length],
      driver_refs: [{ name: drivers[i % drivers.length], id: `drv-${i % drivers.length}` }] })),
    segments: [
      { plate: plates[0], started_at: `${day}T05:38:00Z`, ended_at: `${day}T06:04:00Z`, duration_min: 26,
        distance_km: 18.4, verdict: 'unauthorized', nearest_platform: 'uber', nearest_gap_min: 96,
        drivers: drivers[0], driver_refs: [{ name: drivers[0], id: 'drv-0' }],
        verdict_reason: 'no completed booking overlaps; nearest is a uber trip 96 min away' },
      { plate: plates[2], started_at: `${day}T11:02:00Z`, ended_at: `${day}T11:19:00Z`, duration_min: 17,
        distance_km: 6.1, verdict: 'unverifiable', nearest_platform: null, nearest_gap_min: null,
        // A handover day: both people must be openable, which is why the pairs
        // form exists at all.
        drivers: `${drivers[1]}, ${drivers[2]}`,
        driver_refs: [{ name: drivers[1], id: 'drv-1' }, { name: drivers[2], id: 'drv-2' }],
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


app.get('/api/alerts/by-driver', (_, r) => r.json({ totals: { drivers: 74, alerts: 1904, unattributed: 212 }, shown: 8, truncated: true, rows: drivers.map((name, i) => {
  const brake = 22 - i * 2, accel = 12 - i, turn = i % 3, over = i % 2;
  const km = (900 - i * 90);
  return { driver_name: name, driver_ext_id: `drv-${i}`, alerts: brake + accel + turn + over,
    harsh_brake: brake, harsh_accel: accel, sharp_turn: turn, overspeed: over,
    /* The residual: everything the four buckets do not catch. Without it the
       columns did not sum to the total on six of sixty live rows. */
    other: 0,
    // WHICH cars, not just how many — "4 plates" is not something you can open.
    plates: 1 + (i % 2), plate_list: [plates[i % plates.length]].concat(
      i % 2 ? [plates[(i + 1) % plates.length]] : []),
    booked_km: km,
    per_100km: Math.round(((brake + accel + turn + over) * 100 / km) * 100) / 100 };
}).concat([{ driver_name: '(unattributed)', driver_ext_id: null, alerts: 9, harsh_brake: 6,
  harsh_accel: 2, sharp_turn: 1, overspeed: 0, other: 0, plates: 4,
  plate_list: plates.slice(0, 3), booked_km: null, per_100km: null }]) }));


app.get('/api/alerts/summary', (_, r) => r.json([
  { alert_type: 'Harsh Brake', n: 148 }, { alert_type: 'Harsh Acceleration', n: 86 },
  { alert_type: 'Overspeed', n: 22 }, { alert_type: 'Sharp Turn', n: 9 },
  { alert_type: 'Main Power Lost', n: 31 },
]));
app.get('/api/alerts/by-vehicle', (_, r) => r.json({ totals: { vehicles: 118, alerts: 1904 }, shown: 8, truncated: true, rows: plates.map((p2, i) => {
  const brake = 30 - i * 3, accel = 18 - i * 2, turn = i % 3, over = i % 2, other = i % 4 === 0 ? 5 : 0;
  return { plate: p2, alerts: brake + accel + turn + over + other,
    harsh_brake: brake, harsh_accel: accel, sharp_turn: turn, overspeed: over, other,
    unattributed: i === 3 ? 4 : 0, drivers: 1 + (i % 2),
    /* Ranked by their OWN event count, not alphabetically — the column is
       headed "Most often" and used to return whichever custodian's name came
       first in the alphabet, which on L45255 named the 322-event driver over
       the 702-event one. */
    top_driver: i === 3 ? null : drivers[i % drivers.length],
    top_driver_id: i === 3 ? null : `drv-${i % drivers.length}`,
    top_driver_alerts: i === 3 ? null : Math.max(1, brake + accel - i) };
}) }));


/* {rows, people, shown, truncated} — one row per PERSON. It used to be a bare
   array of one row per platform ACCOUNT, which ranked a two-app driver below a
   one-app driver who did less. */
app.get('/api/drivers/leaderboard', (_, r) => r.json({
  people: 74, shown: drivers.length, truncated: true,
  rows: drivers.map((name, i) => ({
    person: name.toLowerCase(), driver_name: name, driver_ext_id: `drv-${i}`,
    platforms: i % 3 ? ['uber'] : ['uber', 'hotel'], accounts: i % 3 ? 1 : 2,
    plate: plates[i % plates.length], trips: 180 - i * 14, km: (180 - i * 14) * 12,
    /* The column the ranking is actually over. This list is captioned with a
       completion rate and was ordered by TOTAL bookings, so rank 1 could be
       271 trips at 84% above rank 2's 257 at 89% — 228 completed against
       229. */
    completed_trips: Math.round((180 - i * 14) * (96 - i) / 100),
    avg_km: 12 + i * 0.3, revenue: i % 3 ? null : (180 - i * 14) * 96,
    // The denominator the completion rate is over — a percentage whose base is
    // missing cannot be checked, and Bolt's four failure states make it matter.
    outcome_n: 180 - i * 14,
    completion_pct: 96 - i })) }));
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
  clock_skew_min: null,
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
  // Name-and-id pairs: a handover day names two people and both must open.
  driver_refs: i % 6 === 0 ? null
    : i % 5 === 4
      ? [{ name: drivers[i % drivers.length], id: `drv-${i % drivers.length}` },
        { name: drivers[(i + 1) % drivers.length], id: `drv-${(i + 1) % drivers.length}` }]
      : [{ name: drivers[i % drivers.length], id: `drv-${i % drivers.length}` }],
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
      /* Grouped on the SHAPE of a reason, not on its text. Keyed on the raw
         string, every matched segment was its own "reason": production offered
         109 filters of which 20 could be shown, and the rows were
         "matched uber trip fa66c89c-…" and four separate
         "telemetry clock is {2339,2903,2439,2438} min behind wall time". */
      reason: [
        { key: 'no booking within N min on any of N channels', n: 21, verdict: 'unauthorized',
          max_skew_min: null, skewed: 0 },
        { key: 'matched a uber booking N min away', n: 14, verdict: 'authorized',
          max_skew_min: null, skewed: 0 },
        { key: 'telemetry clock is N min behind wall time', n: 4, verdict: 'unverifiable',
          max_skew_min: 2903, skewed: 4 },
        { key: '(no reason recorded)', n: 7, verdict: 'partial', max_skew_min: null, skewed: 0 },
      ],
    },
    /* Facet lists are capped at 40 plates and 20 reasons. A truncated facet is
       not a shorter menu — the vehicle you want is simply absent from it — so
       the page needs to know how many there really are. */
    facet_totals: { plate: 23, plate_shown: by('plate').length, reason: 4, reason_shown: 4 },
    known_verdicts: SEG_VERDICTS,
    /* A tracker two days out cannot be compared against a booking at all, and
       37 live segments were exactly that — discoverable only by reading four
       rows of a facet list. */
    clock_skew: { segments: 0, plates: [], max_min: null },
  });
});

/* One booking, with the context the trip tables cannot hold.
   The awkward shape here is the money: Uber prices no trip and its money is a
   figure for the whole DAY, so the fixture carries both a priced channel and
   an unpriced one — the page is mostly about telling them apart. */
/* Credential health, for the banner every page carries.
   Two rows that are fine and one that is not, because a fixture in which
   nothing is wrong exercises exactly the branch that renders nothing. */
app.get('/api/auth', (_, r) => {
  const rows = [
    { provider: 'uber', fleet_id: 'ecosine', credential: 'UBER_WEB_COOKIE', state: 'ok',
      detail: null, surface: 'supplier graphql', last_ok_at: dayISO(0), checked_at: dayISO(0),
      last_ok_age_h: 0.2, run_age_h: 0.4, stall_limit_h: 6, severity: 'ok' },
    { provider: 'uber', fleet_id: 'egari', credential: 'UBER_WEB_COOKIE_EGARI', state: 'expired',
      detail: 'redirected to auth.uber.com — the session is no longer signed in',
      surface: 'supplier graphql', last_ok_at: dayISO(1), checked_at: dayISO(0),
      last_ok_age_h: 19.5, run_age_h: 19.5, stall_limit_h: 6, severity: 'stopped' },
    { provider: 'yango', fleet_id: 'ecosine', credential: 'YANGO_API_KEY', state: 'ok',
      detail: null, surface: 'fleet api', last_ok_at: dayISO(2), checked_at: dayISO(0),
      last_ok_age_h: 41, run_age_h: 41, stall_limit_h: 12, severity: 'at-risk' },
  ];
  r.json({ rows, stopped: 1, at_risk: 1, missing: 0, observed: true,
    headline: 'A credential has stopped working: uber · Egari (UBER_WEB_COOKIE_EGARI) '
      + '— redirected to auth.uber.com — the session is no longer signed in' });
});

app.get('/api/trip', (req, r) => {
  const platform = String(req.query.platform || 'uber');
  const id = String(req.query.id || 'u-mock-1');
  const priced = platform !== 'uber' && platform !== 'fms';
  const day = '2026-08-20';
  const at = (t) => `${day}T${t}:00+04:00`;
  const trip = {
    platform, external_id: id, fleet_id: 'ecosine', plate: plates[0],
    driver_ext_id: 'drv-1', driver_name: drivers[0],
    requested_at: at('06:50'), ended_at: at('07:31'),
    pickup_addr: 'Al Garhoud - Dubai', pickup_lat: 25.2419, pickup_lng: 55.3521,
    dropoff_addr: "Terminal 3 - Dubai Int'l Airport", dropoff_lat: 25.2532, dropoff_lng: 55.3657,
    distance_km: 17.5, duration_s: null, status: 'completed', product: priced ? 'pick_and_drop' : 'Comfort',
    payment_type: priced ? 'on_account' : 'offline', seat_count: priced ? null : 4,
    price: priced ? 88.5 : null, currency: 'AED',
    ingested_at: at('08:02'), raw: { tripUUID: id, productName: 'Comfort', surge: 1 },
    is_booking: true, outcome: 'completed', has_fare: priced, has_distance: true, local_day: day,
  };
  r.json({
    trip,
    vehicle: { plate: plates[0], make: 'BYD', model: 'Han EV', year: 2025, colour: 'White', fleet_id: 'ecosine' },
    custody: [{ driver_ext_id: 'drv-1', driver_name: drivers[0], platform: 'uber', trips: 5,
      km: 124, is_primary: true, first_trip_at: at('01:00'), last_trip_at: at('10:44') }],
    telemetry: [
      { captured_at: at('06:52'), lat: 25.24, lng: 55.35, speed: 44, status: 'moving',
        seat_occupied: true, ignition: true, source: 'fms' },
      { captured_at: at('07:20'), lat: 25.25, lng: 55.36, speed: 31, status: 'moving',
        seat_occupied: true, ignition: true, source: 'fms' },
    ],
    segments: [{ plate: plates[0], started_at: at('06:51'), ended_at: at('07:30'), duration_min: 39,
      distance_km: 17.2, verdict: 'authorized', verdict_reason: 'matched uber trip <trip id>',
      matched_platform: 'uber', matched_trip_id: id }],
    /* cash_earnings is null on purpose. driver_payout_day is built from the
       performance feed and Uber's reports no cash at all, so a mock that
       invents a figure there hides the very gap the statement block fills. */
    payout_day: { day, platform: 'uber', earnings: 389.4, cash_earnings: null, trips: 5,
      period_start: day, period_end: day, period_days: 1, period_earnings: 389.4 },
    // The day as the channel breaks it down — the surface that does carry cash.
    statement_day: { net: 352.4, tips: 25, salik: 12, cash: 140, source: 'uber_rest' },
    same_day: [
      { platform, external_id: id, requested_at: at('06:50'), ended_at: at('07:31'),
        plate: plates[0], distance_km: 17.5, status: 'completed', outcome: 'completed',
        price: priced ? 88.5 : null, currency: 'AED', product: 'Comfort' },
      { platform: 'hotel', external_id: 'h-mock-2', requested_at: at('10:15'), ended_at: at('10:44'),
        plate: plates[0], distance_km: 9.4, status: 'completed', outcome: 'completed',
        price: 88.5, currency: 'AED', product: 'pick_and_drop' },
    ],
    notes: { fare_reported: priced, platform_prices_trips: priced, is_telematics_journey: false },
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
    /* 40 of a slot's 62 drivers were listed with nothing saying so, on a page
       whose subject is how few people cover an hour. */
    drivers_total: 6, drivers_shown: 6, drivers_truncated: false,
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
    /* What they drove. Somebody working three platforms is usually working
       them from ONE car, and that is the fact this table could not show. */
    plates: [plates[i % plates.length], plates[(i + 2) % plates.length]].slice(0, 1 + (i % 2)),
    plate_n: 1 + (i % 2), main_plate: plates[i % plates.length],
  })),
  multi_platform: 6,
  // Counted over every person in the window, not over the rows returned — the
  // panel prints "N of M work more than one channel" from these two.
  people: 14,
  shown: 10,
  truncated: true,
  note: 'One row per person: platform accounts are folded by name.',
}));

/* {rows, periods, totals, shown, truncated} — a bare array before. The cap
   started to bite the moment the Uber collector was fixed: a weekly period held
   ten drivers because that was all the collector could see, and now holds a
   hundred and fifty, so 300 rows is two periods rather than a year of them. */
app.get('/api/drivers/performance', (_, r) => {
  const rows = drivers.slice(0, 6).map((name, i) => ({
    platform: ['uber', 'bolt', 'yango'][i % 3], driver_name: name, driver_ext_id: `drv-${i}`,
    plate: plates[i], period_start: '2026-08-14', period_end: '2026-08-20',
    trips: 44 - i * 4, hours_online: 52 - i * 3, hours_on_trip: 31 - i * 2,
    acceptance_rate: 0.92 - i * 0.04, cancellation_rate: 0.03 + i * 0.01,
    distance_km: 900 - i * 60, earnings: 2400 - i * 180, cash_earnings: 800 - i * 60,
    rating: +(4.9 - i * 0.08).toFixed(2),
    /* period_days is the window's length and days_used how much of it this row
       still accounts for once a finer overlapping report has taken the rest —
       equal here, because a tidy fixture has no overlaps. counted is the money
       those days carry. See sql/schema_v23.sql. */
    period_days: 7, days_used: 7, counted: 2400 - i * 180,
  }));
  r.json({
    rows, shown: rows.length, truncated: true,
    periods: [
      { platform: 'uber', period_start: '2026-08-14', period_end: '2026-08-20', drivers: 150, earnings: 31176.79 },
      { platform: 'uber', period_start: '2026-08-07', period_end: '2026-08-13', drivers: 148, earnings: 29840.12 },
      { platform: 'yango', period_start: '2026-08-14', period_end: '2026-08-20', drivers: 9, earnings: 1210.4 },
    ],
    totals: { total: 1840, periods: 16, people: 152, payout_days: 112, earnings: 214880.5,
      cash_earnings: 41200.75, platforms: ['uber', 'yango', 'bolt'] },
  });
});


/* ── the fifteen routes that were falling through to the catch-all ────────
   Every one of these was answered with `[]` by the catch-all below, so the
   browser smoke test rendered these pages against nothing and passed. One of
   them — /api/drivers/cross-platform, fixtured above — actually returns an
   object, and the UI called .filter on it: the Drivers page threw in
   production while the smoke run reported 76/76. A fixture that does not exist
   is not a neutral omission; it is a fixture with the wrong shape. */

app.get('/api/trips/list', (req, r) => {
  /* Three channels on purpose: an Uber row with no price, a hotel row with
     one, and a telematics journey that is not a booking — the three shapes
     the page has to render without pretending they are the same. */
  const kind = req.query.kind || 'bookings';
  const limit = Math.min(+req.query.limit || 100, 500);
  const offset = Math.max(0, +req.query.offset || 0);
  const term = String(req.query.q || '').toLowerCase();
  const AREAS = ['Al Garhoud', 'Downtown Dubai', 'Dubai Marina', 'Business Bay', 'Deira'];
  const all = [];
  for (let i = 0; i < 640; i++) {
    const booking = i % 7 !== 6;
    const hotel = booking && i % 11 === 0;
    all.push({
      platform: hotel ? 'hotel' : booking ? 'uber' : 'fms',
      fleet_id: i % 3 ? 'ecosine' : 'egari',
      external_id: `t-${1000 + i}`,
      requested_at: new Date(Date.now() - i * 37 * 60000).toISOString(),
      ended_at: new Date(Date.now() - i * 37 * 60000 + 19 * 60000).toISOString(),
      local_day: dayISO(Math.floor(i / 30)).slice(0, 10),
      driver_name: ['Ahmed Tariq', 'Nora Said', 'Roy Ocdol', 'Khalid Gul'][i % 4],
      driver_ext_id: `drv-${i % 4}`,
      plate: `L${36000 + (i % 9)}`,
      pickup_addr: `Shop ${i} - ${AREAS[i % 5]} - Dubai - UAE`,
      dropoff_addr: `Villa ${i} - ${AREAS[(i + 2) % 5]} - Dubai - UAE`,
      distance_km: Math.round((4 + (i % 23)) * 10) / 10,
      duration_s: 900 + (i % 40) * 30,
      status: booking ? (i % 9 === 4 ? 'rider_cancelled' : 'completed') : 'completed',
      outcome: booking && i % 9 === 4 ? 'not_completed' : 'completed',
      product: hotel ? 'pick_and_drop' : 'UberX',
      payment_type: hotel ? 'on_account' : 'card',
      price: hotel ? 60 + (i % 90) : null,
      currency: 'AED',
      has_fare: hotel,
      is_booking: booking,
    });
  }
  let rows = all.filter((x) => (kind === 'telematics' ? !x.is_booking
    : kind === 'all' ? true : x.is_booking));
  if (req.query.outcome) rows = rows.filter((x) => x.outcome === req.query.outcome);
  if (term) {
    rows = rows.filter((x) => [x.plate, x.driver_name, x.pickup_addr, x.dropoff_addr, x.external_id]
      .some((v) => String(v).toLowerCase().includes(term)));
  }
  const page = rows.slice(offset, offset + limit);
  r.json({
    rows: page, total: rows.length, shown: page.length, offset, limit,
    truncated: offset + page.length < rows.length,
    window: { from: dayISO(30).slice(0, 10), to: dayISO(0).slice(0, 10) },
    priced: page.filter((x) => x.has_fare).length,
    note: 'One row per booking. A price appears only where the channel publishes one — the Uber '
      + 'trip export carries no fare column at all.',
  });
});

app.get('/api/trips/hourly', (_, r) => r.json(
  Array.from({ length: 24 }, (_, h) => ({
    h, trips: Math.round(20 + 60 * Math.exp(-((h - 19) ** 2) / 18) + 25 * Math.exp(-((h - 8) ** 2) / 8)),
  }))));

app.get('/api/trips/heatmap', (_, r) => r.json(
  Array.from({ length: 7 }, (_, dow) => Array.from({ length: 24 }, (_, h) => ({
    dow, h, trips: Math.round(4 + 22 * Math.exp(-((h - 19) ** 2) / 20) * (dow === 5 || dow === 6 ? 1.5 : 1)),
  }))).flat()));

/* {rows, total, shown, truncated} — the busiest 200, which on a larger fleet
   is a slice and used to be presented as the whole of it. */
app.get('/api/vehicles', (_, r) => r.json({ total: 96, shown: plates.length, truncated: true,
  rows: plates.map((p, i) => ({
  plate: p, fleet_id: i % 3 ? 'ecosine' : 'egari',
  // Never summed: an FMS row is the same physical journey a platform reported.
  bookings: 120 - i * 11, telematics_journeys: 140 - i * 9,
  has_distance_n: 100 - i * 9,
  km: 3200 - i * 260, avg_km: +(14 - i * 0.4).toFixed(1),
  revenue: i % 3 === 2 ? null : 4800 - i * 380,
  priced_n: i % 3 === 2 ? 0 : 90 - i * 8,
  drivers: 1 + (i % 3), platforms: 2 + (i % 2),
  // Bookings and telematics journeys are separate counts and `trips` is the
  // booking one — the table's own column. Priced trips are the denominator the
  // fare figures divide by.
  trips: 120 - i * 11, telematics_km: (140 - i * 9) * 11, priced_trips: i % 3 === 2 ? 0 : 90 - i * 8,
  last_trip: new Date(Date.now() - i * 36e5).toISOString(),
  current_driver: drivers[i], current_driver_id: `drv-${i}`, driver_as_of: '2026-08-21',
  last_fix: new Date(Date.now() - i * 9e5).toISOString(), stale: i === 7,
})) }));

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
  // Partial on purpose: the real fleet has three days of sensor data in a
  // thirty-day window, and the banner that says so must be exercised.
  coverage: { days_with_data: 3, days_in_window: 30, complete: false },
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

/* {rows, total, segments, shown, truncated} — the "Vehicles involved" tile
   reads `total`, not the length of the list, which is the worst hundred. */
app.get('/api/unauthorized/by-vehicle', (_, r) => r.json({
  total: 23, segments: 61, shown: plates.length, truncated: true,
  rows: plates.map((p, i) => ({
    plate: p, unauthorized: Math.max(0, 6 - i), authorized: 20 + i,
    sensor_suspect: i % 3, unauth_km: Math.max(0, 70 - i * 11),
    drivers: i % 5 === 4 ? null : drivers[i],
  })) }));

app.get('/api/unauthorized/daily', (_, r) => r.json(
  /* Twenty-one days, three of which have no seat-occupancy data at all — the
     shape production has, where the reconciler had produced segments for three
     days of a thirty-day window. Those days must draw as a hatched void and not
     as zero, and this fixture is the only place the browser smoke test meets
     that case. */
  Array.from({ length: 21 }, (_, i) => {
    const uncollected = i === 5 || i === 6 || i === 14;
    const segments = uncollected ? 0 : 12 + (i % 6);
    const unauthorized = uncollected ? 0 : (i % 4 === 0 ? 3 : i % 3 === 0 ? 1 : 0);
    const authorized = uncollected ? 0 : Math.min(segments, 8 + (i % 5));
    const needs_a_human = uncollected ? 0 : (i % 5 === 0 ? 2 : 1);
    /* `partial` is the largest bucket on the real fleet — 68 of 136 — and was
       counted in none of the named ones, so the row did not sum to itself. */
    const partial = Math.max(0, segments - unauthorized - authorized - needs_a_human);
    return { d: `2026-08-${String(i + 1).padStart(2, '0')}`,
      unauthorized, authorized, needs_a_human, partial, stationary: 0,
      segments, uncollected };
  })));

app.get('/api/sensor-health', (_, r) => r.json(plates.map((p, i) => ({
  plate: p, occupied_fixes: i === 2 ? 0 : 400 - i * 40,
  unreported_fixes: i % 4 === 3 ? 900 : 0,
  total_fixes: 2400 - i * 90,
  occupied_pct: i === 2 ? 0 : +(18 - i).toFixed(1),
  sensor_suspect_segments: i % 5 === 1 ? 4 : 0,
  // Whether there is enough signal to judge the sensor at all — a car with
  // forty fixes is not evidence of a broken seat sensor.
  judgeable: i !== 5,
}))));

/* Bookings and raw rows are different counts and the coverage table conflated
   them: `trips` was count(*) over the trip table, which counts FMS telematics
   rows — 41,809 twins of trips already counted under uber — as bookings, and
   it was all-time while the donut beside it was windowed. And a channel that
   has never delivered a row had no row at all, on the page whose job is to
   inventory the sources. */
app.get('/api/platforms', (_, r) => {
  const row = (platform, fleet_id, bookings, rows_seen, earliest, latest, health) => ({
    platform, fleet_id, bookings, rows_seen,
    window_bookings: Math.round(bookings * 0.09),
    earliest, latest,
    window_from: dayISO(30).slice(0, 10), window_to: dayISO(0).slice(0, 10), windowed: true,
    collection_status: health?.status ?? 'ok', collection_error: health?.error ?? null,
    collection_at: dayISO(0),
  });
  r.json([
    row('uber', 'ecosine', 30410, 30410, '2025-08-21T04:00:00Z', '2026-08-21T18:00:00Z'),
    row('fms', 'ecosine', 0, 38970, '2025-08-21T02:00:00Z', '2026-08-21T19:00:00Z'),
    row('hotel', 'ecosine', 1256, 1256, '2026-07-07T05:00:00Z', '2026-08-21T16:00:00Z'),
    row('yango', 'egari', 4, 4, '2026-08-18T09:00:00Z', '2026-08-21T12:00:00Z'),
    row('bolt', null, 0, 0, null, null, { status: 'partial',
      error: 'FI roster ecosine: code=503 NOT_AUTHORIZED hint=COMPANIES_NOT_ALLOWED' }),
  ]);
});

app.get('/api/coverage', (_, r) => r.json({
  trips: [
    { platform: 'uber', n: 30410, from_ts: '2025-08-21T04:00:00Z', to_ts: '2026-08-21T18:00:00Z' },
    { platform: 'fms', n: 38970, from_ts: '2025-08-21T02:00:00Z', to_ts: '2026-08-21T19:00:00Z' },
    { platform: 'hotel', n: 1256, from_ts: '2026-07-07T05:00:00Z', to_ts: '2026-08-21T16:00:00Z' },
  ],
  /* from_ts on all three: the endpoint used to select only a last timestamp,
     so seven of eleven rows on the coverage table had no start date. */
  telemetry: [{ source: 'cabman', n: 412880, from_ts: '2025-08-19T00:00:00Z',
    collected_from: '2025-08-19T00:00:00Z', last_poll: new Date().toISOString() }],
  alerts: [{ n: 1904, from_ts: '2025-09-02T06:00:00Z', latest: '2026-08-21T14:20:00Z' }],
  ledger: [{ n: 2399, from_ts: '2026-02-06T00:00:00Z', latest: '2026-08-20T21:00:00Z' }],
  /* Continuity for the datasets source_day_coverage does not cover, keyed by
     the label the table prints. Telemetry carries a real gap so the Missing
     and Largest gap columns have something to render. */
  dataset_calendar: {
    'telemetry:cabman': { days_with_data: 360, first_day: '2025-08-19', last_day: '2026-08-21',
      median_rows_per_day: 1140, missing_days: 8, event_driven: false,
      gaps: [{ from: '2026-03-02', to: '2026-03-07', days: 6 }, { from: '2026-05-11', to: '2026-05-12', days: 2 }] },
    /* Event-driven: a day with no safety event is a quiet day, not a gap. */
    'alerts': { days_with_data: 353, first_day: '2025-09-02', last_day: '2026-08-21',
      median_rows_per_day: 5, missing_days: 12, gaps: [], event_driven: true },
    'ledger': { days_with_data: 196, first_day: '2026-02-06', last_day: '2026-08-20',
      median_rows_per_day: 12, missing_days: 5, gaps: [], event_driven: true },
    'earnings:uber': { days_with_data: 197, first_day: '2026-02-06', last_day: '2026-08-21',
      median_rows_per_day: 58, missing_days: 0, gaps: [], event_driven: false },
  },
  /* Money coverage beside trip coverage. Uber's trip feed reaches back a year
     and its earnings API serves about six months, so half the record has work
     on it and no money — permanently, since the provider will not serve those
     windows however many times they are asked for. */
  earnings: [
    { platform: 'uber', n: 4158, from_day: '2026-02-09', to_day: '2026-08-21', days: 194, earnings: 1275353 },
    { platform: 'yango', n: 62, from_day: '2026-08-01', to_day: '2026-08-21', days: 21, earnings: 8420 },
  ],
  earnings_gaps: [
    { platform: 'uber', trips_from: '2025-08-21', earnings_from: '2026-02-09', bookings_before: 131687 },
  ],
}));

app.get('/api/product/by-vehicle', (_, r) => r.json(
  plates.flatMap((p, i) => ['UberX', 'Comfort', 'Black'].slice(0, 1 + (i % 3)).map((product, j) => ({
    plate: p, product, trips: 60 - i * 4 - j * 12,
    km: 900 - i * 60 - j * 100, avg_km: +(13 + j * 3).toFixed(1),
    // Who ran the car over the window: a tier mix is a finding about
    // dispatch and driving, not only about the asset.
    driver_refs: [{ name: drivers[i % drivers.length], id: `drv-${i % drivers.length}`, days: 21 }],
    driver_n: 1 + (i % 3),
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

/* The drill-down behind "Fields we are not keeping". `#providers` links every
   unkept field to it, so the browser smoke has to be able to render it. */
app.get('/api/schema/raw-values', (req, r) => {
  if (!req.query.key) return r.status(400).json({ error: 'key required' });
  return r.json([
    { value: '1.0', n: 3120 }, { value: '1.4', n: 410 }, { value: '2.1', n: 66 },
    { value: '', n: 12 },
  ]);
});

app.get('/api/settings', (_, r) => r.json([
  /* Unset in the API's own environment but held by the collector — the case
     that made this page tell an operator to re-capture a working session. */
  { key: 'UBER_WEB_COOKIE', group: 'Uber', label: 'Supplier portal cookie', hint: 'Paste from a logged-in supplier.uber.com session',
    secret: true, source: 'unset', configured: false, value: '', updated_at: null,
    seen_by: [{ component: 'collector', source: 'environment', observed_at: new Date().toISOString() }] },
  // And one genuinely missing everywhere, so the two render differently.
  { key: 'YANGO_COOKIE', group: 'Yango', label: 'Yandex session cookie', hint: 'Expires — re-paste from a logged-in fleet.yango.com session',
    secret: true, source: 'unset', configured: false, value: '', updated_at: null, seen_by: [] },
  { key: 'CABMAN_PASS', group: 'CABMAN', label: 'Password', hint: null,
    secret: true, source: 'environment', configured: true, value: '••••••••7f2a', updated_at: null },
  { key: 'HOTEL_TOKEN', group: 'Hotel', label: 'Bearer token', hint: null,
    secret: true, source: 'settings', configured: true, value: '••••••••b91c', updated_at: '2026-08-20T09:00:00Z' },
  { key: 'BACKFILL_MONTHS', group: 'Collection', label: 'Months of history', hint: 'How far back a backfill reaches',
    secret: false, source: 'environment', configured: true, value: '12', updated_at: null },
]));


/* ── forecast and playbook ───────────────────────────────────────────────
   Built from the live shape: bookings collapsed from ~24,000/month to 4,203 in
   March 2026 and are recovering at about +830/month. The fixture keeps that,
   because the whole point of the forecast page is that it refuses to fit
   across the collapse. */
app.get('/api/forecast', (req, r) => {
  const horizon = Math.min(24, Math.max(1, Number(req.query.horizon) || 12));
  const observed = TREND.map((row, i) => ({
    m: MONTH_KEYS[i], trips: row.trips, drivers: row.drivers, vehicles: row.vehicles,
    revenue: row.revenue, priced_trips: Math.round(row.trips * 0.35),
    partial_month: MONTH_KEYS[i] === '2025-08' || MONTH_KEYS[i] === '2026-08',
    no_data: false,
  }));
  const used = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
  const slope = 833, intercept = 4168;
  const fc = [];
  for (let k = 1; k <= horizon; k++) {
    const [y, mo] = '2026-07'.split('-').map(Number);
    const dt = new Date(Date.UTC(y, mo - 1 + k, 1));
    const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    const point = Math.round((intercept + slope * (4 + k)) / 100) * 100;
    const halfWidth = Math.round((1050 + k * 190) / 100) * 100;
    fc.push({ m: ym, point, low: Math.max(0, point - halfWidth), high: point + halfWidth,
      flat: 6800, days: new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate(),
      kind: k <= 3 ? 'forecast' : 'extrapolation' });
  }
  const shares = [
    { dow: 0, mean: 232, share: 0.126, n: 8 }, { dow: 1, mean: 214, share: 0.116, n: 8 },
    { dow: 2, mean: 221, share: 0.120, n: 8 }, { dow: 3, mean: 238, share: 0.129, n: 8 },
    { dow: 4, mean: 266, share: 0.144, n: 8 }, { dow: 5, mean: 316, share: 0.171, n: 8 },
    { dow: 6, mean: 356, share: 0.193, n: 8 },
  ];
  const next = fc[0];
  const nd = new Date(Date.UTC(+next.m.slice(0, 4), +next.m.slice(5, 7), 0)).getUTCDate();
  const dows = []; for (let i = 1; i <= nd; i++) dows.push(new Date(`${next.m}-${String(i).padStart(2, '0')}T00:00:00Z`).getUTCDay());
  const tw = dows.reduce((a, d2) => a + shares[d2].share, 0);
  const daily = dows.map((d2, i) => ({ day: `${next.m}-${String(i + 1).padStart(2, '0')}`, dow: d2,
    expected: Math.round((next.point * shares[d2].share) / tw) }));
  r.json({
    ok: true, metric: 'trips',
    break: { from: '2026-02', to: '2026-03', change_pct: -76 },
    months_used: used,
    months_excluded: ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02'],
    n: 5, slope_per_month: slope, r2: 0.918, typical_error: 454,
    flat_baseline: 6800, beats_flat: true,
    forecast: fc, observed,
    in_progress: { m: '2026-08', days_so_far: 21, days_total: 31, trips_so_far: 5927,
      per_day: 282.2, projected: 8748, forecast: next.point, low: next.low, high: next.high,
      within_interval: 8748 >= next.low && 8748 <= next.high },
    weekday_shares: shares, next_month: next.m, daily,
    year_ahead: { total: fc.slice(0, 12).reduce((a, x) => a + x.point, 0),
      low: fc.slice(0, 12).reduce((a, x) => a + x.low, 0),
      high: fc.slice(0, 12).reduce((a, x) => a + x.high, 0), forecast_months: 3 },
    revenue_note: 'The Uber trip export carries no fare column at all, so every AED figure in this product '
      + 'describes the hotel, Bolt and Yango rows only. A booking forecast is in bookings.',
  });
});

app.get('/api/playbook', (req, r) => {
  const rate = Number(req.query.aed_per_trip) > 0 ? Number(req.query.aed_per_trip) : null;
  const median = 92;
  /* `direction` decides which total an action's ceiling belongs to. Money
     kept and money won are different quantities, and the old reduce matched
     /bookings/ against ceiling_unit — which 'bookings/month protected' also
     matches, so avoided loss was summed into "Modelled upside". */
  const mk = (a) => ({ direction: 'gain', detail_of: null, ...a,
    aed_modelled: rate && a.ceiling && /bookings/.test(a.ceiling_unit || '')
      ? Math.round(a.ceiling * rate) : null });
  const actions = [
    mk({ id: 'renew_documents', group: 'Protect', horizon: 'today',
      title: 'Renew 8 vehicle documents expiring within 7 days',
      why: '8 vehicles stop being able to work legally within the week, and 19 more within 45 days. This is '
        + 'the only item here that avoids a loss rather than chasing a gain.',
      basis: 'vehicle_document rows with an expiry date inside 45 days, counted in the database rather than '
        + 'from a capped list, because this tile makes a claim about whether a car may legally drive.',
      direction: 'protect',
      size: 8, size_unit: 'vehicles', ceiling: 8 * median, ceiling_unit: 'bookings/month protected',
      aed_measured: null, certainty: 'measured', effort: 'low', link: '#compliance',
      detail: plates.slice(0, 6).map((p2, i) => ({ plate: p2, expires_at: `2026-08-${25 + (i % 5)}`, days_left: 3 + i })) }),
    mk({ id: 'collect_receivables', group: 'Collect', horizon: 'this week',
      title: 'Chase AED 58,721 owed across 44 counterparties',
      why: '458 bookings in this window settle on account or against salary rather than at the kerb. The '
        + 'oldest is 45 days old.',
      basis: 'Sum of price over trip_ext rows flagged is_receivable — room charges, company accounts and '
        + 'salary postings. Measured, because these are the channels that report a fare.',
      size: 44, size_unit: 'counterparties', aed_measured: 58721,
      certainty: 'measured', effort: 'low', link: '#settlement/receivables' }),
    mk({ id: 'reconcile_cash', group: 'Collect', horizon: 'this week',
      title: 'Reconcile cash held by 86 drivers across 1,779 bookings',
      why: '1,681 of those bookings come from a channel that reports no fare, so the AED figure is a floor '
        + 'over the 98 that do.',
      basis: 'trip_ext rows where the driver personally holds the money — a supervisor-collected fare is '
        + 'deliberately excluded, because it is not what a cash-handling control is sized on.',
      size: 86, size_unit: 'drivers holding cash', aed_measured: 7972,
      certainty: 'partly measured', effort: 'low', link: '#settlement/cash' }),
    mk({ id: 'recover_blocked_vehicles', group: 'Deploy', horizon: 'this week',
      title: 'Reassign 31 vehicles held by drivers who cannot earn on them',
      why: 'Each of these people is suspended or deactivated on the platform whose vehicle they are holding. '
        + 'The car is the constraint in this business, not the person, so this is the cheapest capacity in it.',
      basis: 'driver_platform_state rows where the provider itself reports the driver stopped AND a plate is '
        + 'attached. This is the provider’s assertion, not an inference from quiet weeks.',
      size: 31, size_unit: 'vehicles', ceiling: 31 * median, ceiling_unit: 'bookings/month',
      aed_measured: null, certainty: 'ceiling', effort: 'low', link: '#roster/blocked',
      detail: plates.slice(0, 6).map((p2, i) => ({ plate: p2, driver: drivers[i], state: 'suspended' })) }),
    mk({ id: 'staff_thin_slots', group: 'Cover', horizon: 'next rota',
      title: 'Roster 14 hours that reliably carry work and have three drivers or fewer',
      why: 'The worst is Saturday at 19:00 — 186 bookings across 12 occurrences, covered by 2. An hour held '
        + 'up by that few people stops working the day one of them is off.',
      basis: 'Weekday-hour cells with at least 20 bookings over at least 3 occurrences and 3 or fewer '
        + 'distinct drivers. Both halves are required: a thin hour with no demand is correctly unstaffed.',
      size: 14, size_unit: 'hours', aed_measured: null,
      certainty: 'observed', effort: 'medium', link: '#slot/6/19',
      detail: [{ slot: 'Saturday 19:00', trips: 186, drivers: 2, per_occurrence: 15.5 },
        { slot: 'Friday 20:00', trips: 154, drivers: 3, per_occurrence: 12.8 },
        { slot: 'Thursday 03:00', trips: 96, drivers: 2, per_occurrence: 8.0 }] }),
    mk({ id: 'redeploy_idle_vehicles', group: 'Deploy', horizon: 'this month',
      title: 'Put 67 vehicles back to work — they took no booking at all this window',
      why: '64 of 131 vehicles earned. 39 of the idle ones did not move either; 28 drove without a booking '
        + 'behind them, which is a different problem with a different fix.',
      basis: 'Every vehicle in vehicle_profile with zero bookings in the window. The ceiling is 67 × the '
        + 'fleet’s MEDIAN earning vehicle (92 bookings), not its mean — a handful of very busy cars would '
        + 'otherwise set the target for every idle one.',
      size: 67, size_unit: 'vehicles', ceiling: 67 * median, ceiling_unit: 'bookings/month',
      aed_measured: null, certainty: 'ceiling', effort: 'high', link: '#vehicles',
      detail: plates.slice(0, 6).map((p2, i) => ({ plate: p2, journeys: i * 3,
        last_booking: i > 3 ? null : '2026-07-1' + i,
        driver_refs: i ? [{ name: drivers[i % drivers.length], id: `drv-${i}`, days: 4 }] : null,
        driver_n: i ? 1 : 0,
        held_by: i ? { name: drivers[i % drivers.length], id: `drv-${i}`, day: '2026-07-14' } : null })) }),
    mk({ id: 'reduce_cancellations', group: 'Improve', horizon: 'this month',
      title: 'Recover some of 412 bookings lost at the door (5.9%)',
      why: 'These were offered and did not complete — a rider no-show, a driver rejection, or a cancellation. '
        + 'Every one is demand the fleet already had.',
      basis: 'trip_norm.outcome, which normalises across platforms: Bolt reports a completed trip as '
        + '"finished" and three of its four failure modes never contain the word "cancel".',
      size: 412, size_unit: 'lost bookings', detail_of: 'platform', ceiling: 103,
      ceiling_unit: 'bookings/month if a quarter are recoverable',
      aed_measured: null, certainty: 'ceiling', effort: 'medium', link: '#platforms/funnel' }),
    mk({ id: 'cut_return_deadhead', group: 'Improve', horizon: 'this month',
      title: 'Cut 3,184 km of unpaid return running from 8 drop-off areas',
      why: 'The worst is Jebel Ali Free Zone: 34 drops averaging 28 km of empty running afterwards. A short '
        + 'paid trip ending somewhere remote costs more than a long one ending on a rank.',
      basis: 'Straight-line distance from the drop-off point to where the driver actually ended the job, '
        + 'which only the hotel channel reports. It understates road distance, so it is a floor.',
      size: 8, size_unit: 'drop-off areas', ceiling: 3184, ceiling_unit: 'unpaid km',
      aed_measured: null, certainty: 'measured', effort: 'medium', link: '#corporate/approach',
      detail: [{ place: 'Jebel Ali Free Zone', drops: 34, avg_return_km: 28 },
        { place: 'Al Qudra Rd', drops: 31, avg_return_km: 24.6 }] }),
  ];
  r.json({
    window: ['2026-07-22', '2026-08-21'], window_days: 31, actions,
    fleet: { vehicles_seen: 131, earning: 64, moved_only: 28, still: 39, median_bookings: median,
      median_bookings_window: median, median_unit: 'bookings per 30 days',
      // What capacity genuinely ADDED produces — about a third of the median
      // on this fleet, which is the live figure and the whole reason it is
      // reported beside the ceiling rather than folded into it.
      new_driver_first_month: 31, new_drivers_measured: 26 },
    totals: (() => {
      const bk = (x) => (/bookings/.test(x.ceiling_unit || '') ? (x.ceiling || 0) : 0);
      const gain = actions.filter((x) => x.direction !== 'protect');
      const protect = actions.filter((x) => x.direction === 'protect');
      const ceilGain = gain.reduce((a, x) => a + bk(x), 0);
      return {
        aed_measured: actions.reduce((a, x) => a + (x.aed_measured || 0), 0),
        aed_modelled: rate ? gain.reduce((a, x) => a + (x.aed_modelled || 0), 0) : null,
        aed_modelled_at_risk: rate ? protect.reduce((a, x) => a + (x.aed_modelled || 0), 0) : null,
        bookings_ceiling: ceilGain,
        bookings_ceiling_gain: ceilGain,
        bookings_at_risk: protect.reduce((a, x) => a + bk(x), 0),
        ceiling_unit: 'bookings per 30 days',
      };
    })(),
    assumption: rate
      ? { aed_per_trip: rate, note: 'Supplied by the caller. Every modelled figure is this rate times a ceiling.' }
      : { aed_per_trip: null, note: 'No revenue-per-booking rate supplied, so nothing is converted to money. '
        + 'The Uber export carries no fare column at all, so this fleet has no measured rate that covers most '
        + 'of its volume — set one above, and read the result as an assumption.' },
  });
});


/* ── driver lifecycle ────────────────────────────────────────────────────
   Shaped like the live fleet: a large starting roster that drains, thin
   intake, and a driver count that recovers late through returners rather than
   through recruitment — which is exactly the distinction the page exists to
   draw. */
app.get('/api/retention', (_, r) => {
  const months = MONTH_KEYS.slice(0, 12);   // the month in progress is excluded
  const sizes = { '2025-08': 80, '2025-09': 26, '2025-10': 14, '2025-11': 9,
    '2025-12': 5, '2026-01': 6, '2026-02': 4, '2026-03': 3, '2026-04': 2,
    '2026-05': 2, '2026-06': 1, '2026-07': 7 };
  const cohorts = months.map((m, ci) => {
    const size = sizes[m] || 1;
    const horizon = months.length - ci;
    const retained = Array.from({ length: horizon }, (_, k) => {
      // Steep first-month drop, then a slow bleed — the usual shape.
      const pct = k === 0 ? 100 : Math.max(4, Math.round(100 * Math.pow(0.72, k) * (ci === 0 ? 1.05 : 0.9)));
      return { offset: k, m: months[ci + k], n: Math.round((size * pct) / 100), pct };
    });
    const still = retained[retained.length - 1];
    return { cohort: m, size, retained, still_active: still.n,
      still_active_pct: still.pct, months_observed: horizon, is_left_censored: ci === 0 };
  });
  const flow = months.map((m, i) => {
    const active = TREND[i]?.drivers ?? 0;
    const joined = sizes[m] || 0;
    const prev = i ? (TREND[i - 1]?.drivers ?? 0) : 0;
    const returning = i && active > prev ? Math.max(0, active - prev - joined) : (i ? 2 : 0);
    const left = i ? Math.max(0, prev + joined + returning - active) : 0;
    return { m, active, joined, returning, left, net: i ? active - prev : null };
  });
  r.json({
    ok: true, months, current_month_excluded: '2026-08',
    cohorts, flow, last_complete_month: months[months.length - 1],
    stopped_last_month: drivers.slice(0, 5).map((name, i) => ({
      name, driver_ext_id: `drv-${i}`, months_active: 9 - i,
      first_month: '2025-09', last_month: '2026-06', lifetime_bookings: 640 - i * 130 })),
    started_last_month: drivers.slice(5, 7).map((name, i) => ({
      name, driver_ext_id: `drv-${5 + i}`, bookings: 41 - i * 12 })),
    tenure: { median_months_leavers: 3, median_months_so_far_stayers: 7, leavers: 121, stayers: 86,
      note: 'Tenure for people still working is a lower bound — they have not finished. Averaging the two '
        + 'together counts an unfinished span as a finished one, so they are reported apart.' },
    people_total: 207,
    caveat: 'A driver counts as active in a month when they took at least one booking in it. Platform '
      + '"active" status is deliberately not used: a platform can keep somebody nominally active for a year '
      + 'after their last trip, and on this fleet it does.',
  });
});


/* ── rota gaps: where next month's work lands against who covers it ────── */
app.get('/api/capacity', (_, r) => {
  const cells = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let h = 0; h < 24; h++) {
      // Evening peak, a pre-dawn airport wave, and busier weekends.
      const base = 4 + 26 * Math.exp(-((h - 19) ** 2) / 18) + 9 * Math.exp(-((h - 4) ** 2) / 6);
      const wk = dow === 5 || dow === 6 ? 1.45 : 1;
      const occ = Math.round(base * wk * 10) / 10;
      const drivers = Math.max(1, Math.round(occ / 3.4 * 10) / 10);
      const perDriver = Math.round((occ / drivers) * 100) / 100;
      // The projection runs a little ahead of the trailing window, so some
      // hours come out short and some spare.
      const expected = Math.round(occ * (1 + (dow === 6 || h === 19 ? 0.34 : h === 3 ? 0.22 : -0.06)) * 10) / 10;
      const needed = Math.round((expected / perDriver) * 10) / 10;
      cells.push({ dow, hour: h,
        observed_bookings: Math.round(occ * 12), occurrences_observed: h < 2 ? 3 : 12,
        bookings_per_occurrence: occ, drivers_per_occurrence: drivers,
        most_drivers_seen: Math.ceil(drivers) + 2, bookings_per_driver: perDriver,
        share_pct: +(occ / 900 * 100).toFixed(2),
        expected_month: Math.round(expected * 4.3), occurrences_next: 4,
        expected_per_occurrence: expected, drivers_needed: needed,
        driver_gap: Math.round((needed - drivers) * 10) / 10,
        thin: h < 2 });
    }
  }
  const short = cells.filter((c) => c.driver_gap >= 0.5 && !c.thin).sort((a, b) => b.driver_gap - a.driver_gap);
  const spare = cells.filter((c) => c.driver_gap <= -0.5 && !c.thin).sort((a, b) => a.driver_gap - b.driver_gap);
  r.json({
    ok: true, target_month: '2026-09', target_bookings: 9200, target_low: 6800, target_high: 11600,
    forecast_kind: 'forecast', window_days: 84,
    observed_bookings: cells.reduce((a, c) => a + c.observed_bookings, 0),
    cells, shortfall: short.slice(0, 20), surplus: spare.slice(0, 20),
    totals: { drivers_needed_peak: Math.max(...cells.map((c) => c.drivers_needed)).toFixed(1),
      cells_short: short.length, cells_spare: spare.length, cells_thin: cells.filter((c) => c.thin).length },
    caveat: 'A driver’s throughput in an hour is a MEASUREMENT of what happened under whatever demand there '
      + 'was, not a capacity. A quiet hour makes its drivers look unproductive and a frantic one makes them '
      + 'look heroic, so "drivers needed" is the division and nothing more.',
  });
});

/* ── unit economics ───────────────────────────────────────────────────────
   The two ledgers the first screen is built from. Deliberately not tidy: the
   shapes that break a render are the ones production has and a fixture usually
   does not, so this carries a car that earned nothing while its papers are
   current, a car the tracker watched drive with no booking behind it, a car
   with no position at all, a driver who drove and was never paid, and a person
   holding two accounts. Every rate with no denominator is null rather than
   zero, which is what the page renders as an em-dash with a reason. */
const uWindowDays = 30;
const uAssets = plates.map((pl, i) => {
  const still = i === 7;                       // never moved, papers current
  const movedUnpaid = i === 6;                 // tracker saw it drive, nothing paid
  const bookings = still || movedUnpaid ? 0 : 470 - i * 44;
  const km = still || movedUnpaid ? null : 6100 - i * 420;
  const daysEarning = still || movedUnpaid ? 0 : 27 - i;
  const daysMoved = still ? 0 : movedUnpaid ? 12 : 27 - i;
  const payouts = still || movedUnpaid ? null : 15800 - i * 1100;
  const fares = i % 3 === 0 && !still && !movedUnpaid ? 900 - i * 40 : null;
  const money = payouts == null && fares == null ? null : (payouts || 0) + (fares || 0);
  const rt = (a, b) => (b > 0 && a != null ? Math.round((a / b) * 100) / 100 : null);
  return {
    plate: pl, fleet_id: i % 3 ? 'ecosine' : 'egari',
    make: vehSpec[i][0], model: vehSpec[i][1], year: vehSpec[i][2],
    bookings, telematics_journeys: movedUnpaid ? 38 : Math.round(bookings * 1.3),
    km, measured_bookings: Math.round(bookings * 0.9),
    days_earning: daysEarning, days_moved: daysMoved,
    idle_days: uWindowDays - daysMoved, window_days: uWindowDays,
    drivers: still || movedUnpaid ? 0 : 1 + (i % 3),
    money, fares, payouts, attributed: payouts,
    money_platforms: money == null ? [] : (fares ? ['hotel', 'uber'] : ['uber']),
    aed_per_earning_day: rt(money, daysEarning),
    aed_per_km: rt(money, km),
    aed_per_booking: rt(money, bookings),
    forgone_at_own_rate: daysEarning && money
      ? Math.round((money / daysEarning) * (uWindowDays - daysMoved)) : null,
    alerts: 120 - i * 11, alerts_per_100km: rt((120 - i * 11) * 100, km),
    any_even_split: i === 2,
    soonest_expiry: new Date(Date.now() + (i === 1 ? -12 : 5 + i * 14) * 864e5).toISOString(),
    doc_days_left: i === 1 ? -12 : 5 + i * 14,
    last_trip: bookings ? new Date(Date.now() - i * 72e5).toISOString() : null,
    /* The whole-record fold, which is the only thing that can tell a car that
       stopped earning from one that never started. The still row (i === 7) has
       never earned; the moved-unpaid row (i === 6) earned before the window
       and stopped, which is the case the panel could not distinguish. */
    last_booking_ever: bookings || still ? null
      : new Date(Date.now() - 240 * 864e5).toISOString(),
    /* null for a car that worked in the window — the fold is only asked of the
       cold plates, so a zero there would be a number nobody took. */
    bookings_ever: bookings ? null : (still ? 0 : 1830),
    days_since_last_booking: bookings || still ? null : 240,
    last_fix: i === 5 ? null : new Date(Date.now() - i * 6e4).toISOString(),
    stale: i === 7, status: i % 3 === 0 ? 'Engaged' : 'Active',
    // One vehicle with no position at all, so the map's own caption is exercised.
    lat: i === 5 ? null : rnd(25.05, 25.30), lng: i === 5 ? null : rnd(55.10, 55.42),
    current_driver: still || movedUnpaid ? null : drivers[i],
    current_driver_id: still || movedUnpaid ? null : 'drv-' + i,
    driver_as_of: new Date().toISOString(),
    band: money ? 'earning' : daysMoved > 0 ? 'moved_unpaid' : 'still',
  };
}).sort((a, b) => (b.money ?? 0) - (a.money ?? 0));

app.get('/api/economics/assets', (_, r) => {
  const sum = (f) => Math.round(uAssets.reduce((a, x) => a + (Number(f(x)) || 0), 0) * 100) / 100;
  const money = sum((x) => x.money);
  const earningDays = uAssets.reduce((a, x) => a + x.days_earning, 0);
  const km = sum((x) => x.km);
  const bookings = uAssets.reduce((a, x) => a + x.bookings, 0);
  r.json({
    window: [dayISO(uWindowDays), dayISO(0)], window_days: uWindowDays,
    rows: uAssets,
    by_platform: [
      { platform: 'uber', bookings: Math.round(bookings * 0.92), priced_bookings: 0, booking_days: 30,
        fares: null, km: Math.round(km * 0.94), payouts: sum((x) => x.payouts), payout_days: 30,
        vehicles: 6, basis: 'payout',
        basis_note: 'net payout, after the platform commission — this channel reports no fare at all',
        money: sum((x) => x.payouts), aed_per_km: 2.74, best: sum((x) => x.payouts),
        fare_coverage_pct: 0, payout_coverage_pct: 100, payout_coverage_days: 30,
        payout_coverage_base: 30 },
      { platform: 'hotel', bookings: Math.round(bookings * 0.08),
        priced_bookings: Math.round(bookings * 0.08), booking_days: 22, fares: sum((x) => x.fares),
        km: Math.round(km * 0.06), payouts: null, payout_days: 0, vehicles: 3, basis: 'fares',
        basis_note: 'fares reported on every booking', money: sum((x) => x.fares), aed_per_km: 9.42,
        best: sum((x) => x.fares), fare_coverage_pct: 100, payout_coverage_pct: null,
        payout_coverage_days: null, payout_coverage_base: null },
    ],
    totals: {
      vehicles: uAssets.length,
      earning: uAssets.filter((x) => x.band === 'earning').length,
      moved_unpaid: uAssets.filter((x) => x.band === 'moved_unpaid').length,
      still: uAssets.filter((x) => x.band === 'still').length,
      idle_but_documented: uAssets.filter((x) => !x.money && x.doc_days_left >= 0).length,
      money, fares: sum((x) => x.fares), payouts: sum((x) => x.payouts),
      attributed: sum((x) => x.attributed),
      km, bookings,
      earning_vehicle_days: earningDays,
      idle_vehicle_days: uAssets.reduce((a, x) => a + x.idle_days, 0),
      aed_per_earning_day: Math.round((money / earningDays) * 100) / 100,
      aed_per_km: Math.round((money / km) * 100) / 100,
      aed_per_booking: Math.round((money / bookings) * 100) / 100,
      forgone_at_own_rate: sum((x) => x.forgone_at_own_rate),
      unplaced_payouts: 9140.22, unplaced_pct: 8.4, unplaced_note: null,
    },
    coverage: {
      first_payout_day: '2026-02-06', last_payout_day: dayISO(0),
      unpayable_bookings: 0, unpayable_days: 0,
      note: 'Bank payouts exist from 2026-02-06. The Uber earnings API serves nothing earlier, so '
        + 'bookings before that date carry no money and never will.',
    },
  });
});

app.get('/api/economics/drivers', (_, r) => {
  const rt = (a, b) => (b > 0 && a != null ? Math.round((a / b) * 100) / 100 : null);
  const rows = [
    ...drivers.map((name, i) => {
      const unpaid = i === 5;                  // drove all month, no statement reaches them
      const bookings = 420 - i * 37;
      const daysWorked = 26 - i;
      const km = 5400 - i * 380;
      const payouts = unpaid ? null : 14200 - i * 900;
      const fares = i % 3 === 0 ? 640 - i * 30 : null;
      const money = payouts == null && fares == null ? null : (payouts || 0) + (fares || 0);
      return {
        driver_ext_id: 'drv-' + i, driver_name: name,
        ids: i % 3 === 0 ? ['drv-' + i, 'y-' + i] : ['drv-' + i],
        accounts: i % 3 === 0 ? 2 : 1,
        platforms: i % 3 === 0 ? ['uber', 'yango'] : ['uber'],
        fleet_id: i % 3 ? 'ecosine' : 'egari',
        money, payouts, fares, cash: i % 2 ? 320 + i * 40 : null,
        bookings, completed: Math.round(bookings * 0.95),
        completion_pct: 97 - i, km, vehicles: 1 + (i % 2),
        plates: [{ plate: plates[i % plates.length], days: daysWorked }]
          .concat(i % 2 ? [{ plate: plates[(i + 3) % plates.length], days: 4 }] : []),
        days_worked: daysWorked, payout_days: unpaid ? 0 : daysWorked,
        idle_days: uWindowDays - daysWorked, window_days: uWindowDays,
        aed_per_day_worked: rt(money, daysWorked),
        aed_per_booking: rt(money, bookings),
        aed_per_km: rt(money, km),
        bookings_per_day: rt(bookings, daysWorked),
        // Uber reports no online hours at all, so this is null for everyone the
        // fleet actually runs on. The column says why rather than showing 0.
        aed_per_hour_online: null, hours_online: null,
        /* Ours, from the supplier session rather than a payout statement. The
           last two rows leave it NULL on purpose: availability is collected
           from a 31-day window, so a fixture where every driver has it would
           stop the renderer ever meeting the case it has to handle. */
        measured_hours_online: i < 4 ? rt(180 - i * 12, 1) : null,
        measured_idle_h: i < 4 ? rt(148 - i * 11, 1) : null,
        availability_days: i < 4 ? 24 : 0,
        aed_per_measured_hour: i < 4 ? rt(money, 180 - i * 12) : null,
        alerts: 40 - i * 3, alerts_per_100km: rt((40 - i * 3) * 100, km),
        state: i === 3 ? 'suspended' : 'active',
        platform_state: i === 3 ? 'suspended' : 'active', can_earn: i !== 3,
        licence_expires: '2026-11-30', licence_days_left: i === 1 ? -12 : 40 + i * 9,
        last_trip: new Date(Date.now() - i * 36e5).toISOString(),
        band: money ? 'earning' : 'drove_unpaid',
      };
    }),
    /* On the books, no trip and no money — the row a ledger built from the trip
       table can never contain. */
    { driver_ext_id: 'drv-idle', driver_name: 'Saeed Al Mansoori', ids: ['drv-idle'], accounts: 1,
      platforms: [], fleet_id: 'ecosine', money: null, payouts: null, fares: null, cash: null,
      bookings: 0, completed: 0, completion_pct: null, km: null, vehicles: 0, plates: [],
      days_worked: 0, payout_days: 0, idle_days: uWindowDays, window_days: uWindowDays,
      aed_per_day_worked: null, aed_per_booking: null, aed_per_km: null, bookings_per_day: null,
      aed_per_hour_online: null, hours_online: null,
      measured_hours_online: null, measured_idle_h: null, availability_days: 0,
      aed_per_measured_hour: null, alerts: 0, alerts_per_100km: null,
      state: 'active', platform_state: 'active', can_earn: true,
      licence_expires: '2026-06-01', licence_days_left: -81, last_trip: null, band: 'idle' },
  ].sort((a, b) => (b.money ?? 0) - (a.money ?? 0));
  const sum = (f) => Math.round(rows.reduce((a, x) => a + (Number(f(x)) || 0), 0) * 100) / 100;
  const money = sum((x) => x.money);
  const worked = rows.reduce((a, x) => a + x.days_worked, 0);
  const bookings = rows.reduce((a, x) => a + x.bookings, 0);
  r.json({
    window: [dayISO(uWindowDays), dayISO(0)], window_days: uWindowDays, rows,
    totals: {
      people: rows.length,
      earning: rows.filter((x) => x.band === 'earning').length,
      drove_unpaid: rows.filter((x) => x.band === 'drove_unpaid').length,
      idle: rows.filter((x) => x.band === 'idle').length,
      money, payouts: sum((x) => x.payouts), fares: sum((x) => x.fares),
      bookings, km: sum((x) => x.km), worked_days: worked,
      aed_per_day_worked: Math.round((money / worked) * 100) / 100,
      aed_per_booking: Math.round((money / bookings) * 100) / 100,
      aed_per_km: Math.round((money / sum((x) => x.km)) * 100) / 100,
      measured_hours_online: sum((x) => x.measured_hours_online || 0),
      measured_idle_h: sum((x) => x.measured_idle_h || 0),
      aed_per_measured_hour: Math.round((money / Math.max(1, sum((x) => x.measured_hours_online || 0))) * 100) / 100,
      people_with_availability: rows.filter((x) => x.measured_hours_online).length,
      people_with_hours: 0,
      hours_note: 'No platform on this fleet reports online hours, so there is no hourly rate to compute.',
    },
    coverage: {
      first_payout_day: '2026-02-06', last_payout_day: dayISO(0),
      unpayable_bookings: 0, unpayable_days: 0,
      note: 'Bank payouts exist from 2026-02-06. The Uber earnings API serves nothing earlier, so '
        + 'bookings before that date carry no money and never will.',
    },
  });
});

// Anything not fixtured above answers with an empty list rather than a 404,
// so a new page renders its own empty state instead of the view error box.
app.get(/^\/api\//, (_, r) => r.json([]));
app.use(express.static(join(__dir, 'api', 'public')));
app.get('*', (_, r) => r.sendFile(join(__dir, 'api', 'public', 'index.html')));
/* Exported so a test can mount it on an ephemeral port and compare its shape
   against the real API, rather than only checking that a fixture exists.
   Started directly when run as a script, which is how the browser smoke test
   uses it. */
export { app };
export const serve = (port = Number(process.env.PORT) || 8099) =>
  app.listen(port, () => console.log(`mock api on http://localhost:${port}`));
if (process.argv[1] && process.argv[1].endsWith('mockapi.mjs')) serve();
