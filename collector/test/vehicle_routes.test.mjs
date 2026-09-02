/* Per-vehicle detail API, end to end.
   The thing worth testing here is that the four systems describing one car are
   actually joined: trips say it earned, telematics says where it was, the fleet
   portal says whether its papers are current, and the custody table says who
   was holding it. The fixture gives the same plate a different story in each. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { vehicleRoutes } from '../api/vehicle_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

const PLATE = 'L46174', OTHER = 'L41435';
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO vehicle (plate, fleet_id, make, model, year, fuel_type)
         VALUES ($1,'ecosine','Tesla','Model Y',2023,'electric')`, [PLATE]);
await q(`INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, make, model, year, colour, vin)
         VALUES ('uber','veh-1',$1,'Tesla','Model Y',2023,'White','5YJ0000')`, [PLATE]);

const trip = (ext, day, hour, opts = {}) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,
                     distance_km,status,product,payment_type,price)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [opts.platform || 'uber', ext, opts.plate || PLATE, opts.drv || 'd-ali', opts.name || 'Ali Rahman',
   `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`, opts.km ?? 11,
   opts.status || 'completed', opts.product || 'UberX', opts.pay || 'card', opts.price ?? 42]);

// Two drivers share the car: Ali most days, Sara on the 12th (a handover).
let n = 0;
for (const day of ['2026-08-10', '2026-08-11', '2026-08-13'])
  for (let i = 0; i < 6; i++) await trip(`t${n++}`, day, 8 + i);
for (let i = 0; i < 4; i++) await trip(`s${i}`, '2026-08-12', 9 + i, { drv: 'd-sara', name: 'Sara Iqbal' });
await trip('cx', '2026-08-13', 20, { status: 'rider_cancelled', km: 0, price: 0 });
await trip('yg', '2026-08-13', 21, { platform: 'yango', product: 'Comfort', pay: 'cash', price: 60 });
// a trip on a different plate, which must never leak into this vehicle's page
await trip('x1', '2026-08-13', 10, { plate: OTHER, drv: 'd-omar', name: 'Omar Nasser' });
/* An FMS telematics twin: the tracker's own record of a journey the ride
   platform already reported. is_booking is false for it (sql/schema_v7.sql),
   and on 2026-08-14 it is the ONLY trip row — so a query that reads raw `trip`
   calls the 14th a day this car earned, and the idle-day tile then contradicts
   the caption printed directly beneath it. */
await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,requested_at,distance_km,status)
         VALUES ('fms','fm1','ecosine',$1,'2026-08-14T07:00:00+04:00',190000,'completed')`, [PLATE]);

// 2026-08-14: the tracker reports but nothing earned — an idle day
await q(`INSERT INTO telemetry_snapshot (source,plate,captured_at,lat,lng,speed,status,fuel_level)
         VALUES ('cabman',$1,'2026-08-14T09:00:00+04:00',25.10,55.18,0,'Idle',88),
                ('cabman',$1,'2026-08-14T09:05:00+04:00',25.10,55.18,0,'Idle',88),
                ('cabman',$1,'2026-08-14T09:10:00+04:00',25.10,55.18,0,'Idle',87),
                ('cabman',$1,'2026-08-13T09:00:00+04:00',25.20,55.27,54,'Active',90)`, [PLATE]);
/* Three polls on the 15th that came back with no satellite lock. They are
   fixes, they are not positions: /api/map/journey draws only rows with a
   latitude, so counting these in the replay picker promised a route that could
   not be drawn — the live picker offered "Aug 25 · 119 fixes" against a replay
   of 108. */
await q(`INSERT INTO telemetry_snapshot (source,plate,captured_at,lat,lng,speed,status)
         VALUES ('cabman',$1,'2026-08-15T09:00:00+04:00',NULL,NULL,0,'Idle'),
                ('cabman',$1,'2026-08-15T09:05:00+04:00',NULL,NULL,0,'Idle'),
                ('cabman',$1,'2026-08-15T09:10:00+04:00',NULL,NULL,0,'Idle')`, [PLATE]);

// Note the 13th: Ali holds the car on Uber AND Yango that day, so custody has
// TWO rows for one (plate, day). Joining alerts straight to this table would
// count each of that day's events twice — which is exactly what production did
// before this fixture existed.
await q(`INSERT INTO vehicle_driver_day (plate,day,driver_ext_id,platform,driver_name,trips,km,revenue,is_primary)
         VALUES ($1,'2026-08-10','d-ali','uber','Ali Rahman',6,66,252,true),
                ($1,'2026-08-11','d-ali','uber','Ali Rahman',6,66,252,true),
                ($1,'2026-08-12','d-sara','uber','Sara Iqbal',4,44,168,true),
                ($1,'2026-08-13','d-ali','uber','Ali Rahman',8,88,354,true),
                ($1,'2026-08-13','d-ali','yango','Ali Rahman',1,12,60,false)`, [PLATE]);

await q(`INSERT INTO alert (platform,external_id,plate,alert_type,occurred_at,location)
         VALUES ('fms','a1',$1,'Harsh Braking','2026-08-13T09:30:00+04:00','Sheikh Zayed Rd'),
                ('fms','a2',$1,'Overspeed','2026-08-13T10:00:00+04:00','E11'),
                ('fms','a3',$1,'Overspeed','2026-08-12T10:00:00+04:00','E11'),
                ('fms','a4',$2,'Overspeed','2026-08-13T10:00:00+04:00','E11')`, [PLATE, OTHER]);

await q(`INSERT INTO vehicle_document (platform,vehicle_ext_id,doc_type,plate,status,expires_at)
         VALUES ('uber','veh-1','Vehicle Registration Form',$1,'ACTIVE','2026-09-05'),
                ('uber','veh-1','Insurance',$1,'ACTIVE','2027-03-01')`, [PLATE]);

await q(`INSERT INTO vehicle_utilisation (platform,vehicle_ext_id,plate,period_start,period_end,
           trips,hours_online,hours_on_trip,utilisation,earnings,earnings_per_hour,trips_per_online_hour)
         VALUES ('uber','veh-1',$1,'2026-08-10','2026-08-16',22,58.0,31.9,0.55,1200,20.69,0.38)`, [PLATE]);

await q(`INSERT INTO occupancy_segment (plate,started_at,ended_at,duration_min,distance_km,verdict,fixes)
         VALUES ($1,'2026-08-13T22:00:00+04:00','2026-08-13T22:40:00+04:00',40,18,'unauthorized',9),
                ($1,'2026-08-13T08:00:00+04:00','2026-08-13T08:30:00+04:00',30,12,'authorized',7)`, [PLATE]);

/* ── app under test ─────────────────────────────────────────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
vehicleRoutes(app, { q, wrap, endOfDay });
const server = app.listen(0);
const port = server.address().port;
const W = 'from=2026-08-01&to=2026-08-31';
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

/* ── plate handling ─────────────────────────────────────────────────────── */
check('a plate typed with a space still resolves', (await get(`/api/vehicle/profile?plate=L%2046174&${W}`)).status === 200);
check('a plate typed lowercase with a dash still resolves', (await get(`/api/vehicle/profile?plate=l-46174&${W}`)).status === 200);
check('an unknown plate 404s', (await get(`/api/vehicle/profile?plate=L99999&${W}`)).status === 404);
check('a missing plate is a 400, not a 404', (await get('/api/vehicle/profile')).status === 400);

/* ── profile ────────────────────────────────────────────────────────────── */
const prof = (await get(`/api/vehicle/profile?plate=${PLATE}&${W}`)).body;
check('spec merges the fleet table and the platform profile', prof.spec.make === 'Tesla' && prof.spec.vin === '5YJ0000', JSON.stringify(prof.spec));
/* 24 bookings, and the FMS twin is not one of them. This counted raw `trip`,
   so L36397 reported span.trips 547 where the car took 325 bookings and the
   tracker logged 222 twins of the same journeys. */
check('trip span counts bookings, not telematics twins', prof.span.trips === 24, String(prof.span?.trips));
check('and the twins are reported beside them rather than deleted',
  prof.span.telematics_journeys === 1, String(prof.span?.telematics_journeys));
check('both drivers counted', prof.span.drivers === 2, String(prof.span?.drivers));
/* The span's ENDS had the defect its counts were already fixed for.
   ─────────────────────────────────────────────────────────────────────────
   min/max(requested_at) were unfiltered, so the last thing the TRACKER saw
   was served as the last thing a RIDER paid for. The fixture's last booking is
   the Yango job at 21:00 on the 13th; the FMS twin at 07:00 on the 14th is a
   GPS trace of a journey nobody was carried on, and it is 10 hours later.

   Measured on production over 365 days: 46 of 227 plates carry a telematics
   row after their last booking — L36395 last earned 05:07 and this endpoint
   said 05:12, L44251 04:32 against 04:49 — so the vehicle page's "last trip"
   disagreed with the idle and utilisation figures beside it, which count
   is_booking. /api/vehicles/directory has answered both questions in two
   columns since it shipped; this one had only the wrong one. */
const ISO = (v) => (v == null ? null : new Date(v).toISOString());
check('the span ends at the last BOOKING, not the last telematics twin',
  ISO(prof.span.last_trip) === '2026-08-13T17:00:00.000Z', String(ISO(prof.span?.last_trip)));
check('and starts at the first booking',
  ISO(prof.span.first_trip) === '2026-08-10T04:00:00.000Z', String(ISO(prof.span?.first_trip)));
/* Not deleted — moved to a column that says what it is, under the name
   /api/vehicles/directory already gives it, so the two pages describing one
   car use one word for one fact. It is the last time the car MOVED, from
   either feed, which is why it is the FMS row here. */
check('the tracker\'s own last sighting survives as last_movement',
  ISO(prof.span.last_movement) === '2026-08-14T03:00:00.000Z', String(ISO(prof.span?.last_movement)));
check('and last_movement is never earlier than last_trip',
  prof.span.last_movement >= prof.span.last_trip,
  `${ISO(prof.span?.last_movement)} < ${ISO(prof.span?.last_trip)}`);
check('latest telemetry fix attached', prof.telemetry?.status === 'Idle', prof.telemetry?.status);
check('documents sorted soonest-expiry first', prof.documents[0]?.doc_type === 'Vehicle Registration Form', prof.documents[0]?.doc_type);
check('document days-left computed', typeof prof.documents[0]?.days_left === 'number');

/* ── kpis ───────────────────────────────────────────────────────────────── */
const k = (await get(`/api/vehicle/kpis?plate=${PLATE}&${W}`)).body;
check('kpi trips exclude other plates', k.trips === 24, String(k.trips));
check('utilisation carried from the platform record', +k.utilisation === 0.55, String(k.utilisation));
check('alerts counted for this plate only', k.alerts === 3, String(k.alerts));
check('alerts normalised per 100km', k.alerts_per_100km > 0, String(k.alerts_per_100km));
/* Two idle days: the 14th, where the tracker logged a journey and no booking
   was taken, and the 15th, where it polled three times without a lock. The
   four earning days do not count. This read raw `trip` and so counted the
   14th's FMS twin as earning — the live tile said "Idle days 2" over its own
   caption saying "5 day(s) with a tracker fix and no trip". */
check('a telematics twin is not a day the car earned', k.idle_days === 2, String(k.idle_days));
check('revenue per km derived', k.revenue_per_km > 0, String(k.revenue_per_km));

/* ── an odometer row on this plate must not become this vehicle's distance ──
   `plate` is the join key on every query on this page, and FMS telematics rows
   carry plates. Their distances are odometer-derived: one row can read 193,027
   km. Unguarded, the Distance tile on a vehicle whose tracker is reporting
   becomes a number nobody can reconcile with anything — and `trips` had the
   mirror problem, counting the telematics twin of a booking the ride platform
   already reported, so the same car looked two to three times busier when its
   tracker happened to be on. */
{
  const before = { trips: k.trips, km: Number(k.km) };
  await q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, distance_km, status)
     VALUES ('fms','odo-v','ecosine',$1,'2026-08-13T09:00:00+04:00',193027,'completed')`, [PLATE]);
  const k2 = (await get(`/api/vehicle/kpis?plate=${PLATE}&${W}`)).body;
  check('a 193,027 km odometer row leaves the vehicle’s distance unchanged',
    Number(k2.km) === before.km, `${k2.km} vs ${before.km}`);
  check('and it is not counted as a booking',
    k2.trips === before.trips, `${k2.trips} vs ${before.trips}`);
  check('but it is reported as the tracked journey it is, not discarded',
    k2.telematics_journeys >= 1, String(k2.telematics_journeys));
  check('the average distance says how many bookings it was measured over',
    k2.measured_trips > 0 && k2.measured_trips <= k2.trips,
    `${k2.measured_trips} of ${k2.trips}`);

  const d2 = (await get(`/api/vehicle/daily?plate=${PLATE}&${W}`)).body;
  const odoDay = d2.find((r) => String(r.day).slice(0, 10) === '2026-08-13');
  check('nor does it put a six-figure km on a single day of the chart',
    !odoDay || Number(odoDay.km || 0) < 1000, JSON.stringify(odoDay));

  const mix = (await get(`/api/vehicle/mix?plate=${PLATE}&${W}`)).body;
  const fmsRow = (mix.platform || []).find((r) => r.label === 'fms');
  check('and the platform mix does not print the odometer as an average trip length',
    !fmsRow || fmsRow.avg_km == null || Number(fmsRow.avg_km) < 500,
    JSON.stringify(fmsRow));
  await q(`DELETE FROM trip WHERE external_id = 'odo-v'`);
}

/* ── daily spine ────────────────────────────────────────────────────────── */
const daily = (await get(`/api/vehicle/daily?plate=${PLATE}&${W}`)).body;
/* Six days now, not five: the 14th is a day the tracker logged a journey and
   nothing was booked, which the daily spine already reports correctly as
   trips 0 / telematics_journeys 1. */
check('daily includes the day with no trips', daily.length === 6, String(daily.length));
check('and the telematics-only day carries no bookings',
  daily.find((d) => String(d.day).slice(0, 10) === '2026-08-14')?.trips === 0,
  JSON.stringify(daily.find((d) => String(d.day).slice(0, 10) === '2026-08-14')));
const idleDay = daily.find((d) => d.day.startsWith('2026-08-14'));
check('the idle day shows fixes but zero trips', idleDay?.trips === 0 && idleDay?.fixes === 3, JSON.stringify(idleDay));
const busy = daily.find((d) => d.day.startsWith('2026-08-13'));
check('the busy day names its driver', busy?.drivers_named === 'Ali Rahman', busy?.drivers_named);
check('alerts join onto the day', busy?.alerts === 2, String(busy?.alerts));

/* ── custody ────────────────────────────────────────────────────────────── */
const dd = (await get(`/api/vehicle/drivers-detail?plate=${PLATE}&${W}`)).body;
check('custody covers every row, including the second platform', dd.days.length === 5, String(dd.days.length));
check('a day on two platforms counts as one day worked',
  dd.totals.find((t) => t.driver_name === 'Ali Rahman')?.days === 3,
  String(dd.totals.find((t) => t.driver_name === 'Ali Rahman')?.days));
check('per-driver totals rank by trips', dd.totals[0]?.driver_name === 'Ali Rahman', dd.totals[0]?.driver_name);
check('the handover driver appears too', dd.totals.some((t) => t.driver_name === 'Sara Iqbal'));
check('primary days counted once per day', dd.totals[0]?.primary_days === 3, String(dd.totals[0]?.primary_days));

/* ── movement ───────────────────────────────────────────────────────────── */
const mv = (await get(`/api/vehicle/movement?plate=${PLATE}&${W}`)).body;
check('occupancy segments returned newest first', mv.segments.length === 2 &&
  new Date(mv.segments[0].started_at) > new Date(mv.segments[1].started_at));
check('segments summarised by verdict', mv.by_verdict.some((v) => v.verdict === 'unauthorized'));
/* The 15th has three fixes and no coordinate on any of them. /api/map/journey
   requires lat IS NOT NULL, so offering it here promised a replay that would
   draw nothing — the live picker said "Aug 25 · 119 fixes" against a journey
   of 108. A replayable day is a day with positions. */
check('replayable days need at least three fixes', mv.days.length === 1 && mv.days[0].fixes === 3, JSON.stringify(mv.days));
check('and a day of polls with no satellite lock is not replayable',
  !mv.days.some((d) => String(d.day).slice(0, 10) === '2026-08-15'), JSON.stringify(mv.days));
check('a movement segment carries the reason for its verdict and what could not be checked',
  mv.segments.every((x) => 'verdict_reason' in x && 'unavailable_sources' in x),
  JSON.stringify(Object.keys(mv.segments[0] || {})));
check('parking clusters come from stationary fixes', mv.parked.length === 1 && mv.parked[0].fixes === 3, JSON.stringify(mv.parked));

/* ── safety ─────────────────────────────────────────────────────────────── */
const sf = (await get(`/api/vehicle/safety?plate=${PLATE}&${W}`)).body;
check('alert types ranked', sf.by_type[0]?.alert_type === 'Overspeed', sf.by_type[0]?.alert_type);
check('alerts attributed to the driver holding the car that day',
  sf.by_driver.find((d) => d.driver_name === 'Ali Rahman')?.n === 2, JSON.stringify(sf.by_driver));
check('the handover day\'s alert goes to the other driver',
  sf.by_driver.find((d) => d.driver_name === 'Sara Iqbal')?.n === 1, JSON.stringify(sf.by_driver));
// The 13th has two custody rows and two alerts. Attribution must total three
// events, not five: no alert may be counted once per platform row.
check('an alert is counted once even with two custody rows that day',
  sf.by_driver.reduce((a, r) => a + r.n, 0) === 3, JSON.stringify(sf.by_driver));
check('attributed events never exceed the events that exist',
  sf.by_driver.reduce((a, r) => a + r.n, 0) === sf.by_type.reduce((a, r) => a + r.n, 0),
  `${sf.by_driver.reduce((a, r) => a + r.n, 0)} vs ${sf.by_type.reduce((a, r) => a + r.n, 0)}`);
/* The denominator is the driver's distance ON THIS PLATE over the whole
   window, not over the days they happened to trigger an alert. It summed
   custody km inside the alert-day join, so Ali's rate was 2 events over the
   88 km of one bad day rather than over the 220 km he actually drove
   (66 + 66 + 88, the yango row on the 13th being the non-primary duplicate
   custody collapses away). On the live fleet that printed 215.3 per 100 km for
   a driver beside a vehicle rate of 34, and /api/vehicle/drivers-detail gave
   2,459 km where this gave 459 for the same person on the same car. */
check('the per-driver denominator is their whole window, not their alert days',
  +sf.by_driver.find((d) => d.driver_name === 'Ali Rahman').booked_km === 220,
  JSON.stringify(sf.by_driver));
check('and km still names the same figure, so nothing reads two denominators',
  +sf.by_driver.find((d) => d.driver_name === 'Ali Rahman').km === 220);
check('the rate is computed from that denominator rather than left to the page',
  +sf.by_driver.find((d) => d.driver_name === 'Ali Rahman').per_100km
    === Math.round((2 * 100 / 220) * 100) / 100,
  String(sf.by_driver.find((d) => d.driver_name === 'Ali Rahman').per_100km));
check('the driver list says how many drivers there are and whether it was cut',
  sf.by_driver_total === sf.by_driver.length && sf.by_driver_truncated === false
  && sf.by_driver_alerts === sf.by_type.reduce((a, r) => a + r.n, 0),
  JSON.stringify([sf.by_driver_total, sf.by_driver_truncated, sf.by_driver_alerts]));
check('and so does the recent-alert list, which is capped at a hundred',
  sf.recent_total === sf.recent.length && sf.recent_truncated === false,
  JSON.stringify([sf.recent_total, sf.recent_shown]));
check('recent alerts carry a location', sf.recent[0]?.location != null);

/* ── mix ────────────────────────────────────────────────────────────────── */
const mix = (await get(`/api/vehicle/mix?plate=${PLATE}&${W}`)).body;
check('platform mix spans uber, yango and the telematics feed',
  mix.platform.length === 3, JSON.stringify(mix.platform.map((x) => x.label)));
check('and the telematics feed contributes no bookings to it',
  mix.platform.find((x) => x.label === 'fms')?.bookings === 0,
  JSON.stringify(mix.platform.find((x) => x.label === 'fms')));
check('product mix includes the Comfort trip', mix.product.some((r) => r.label === 'Comfort'));
check('hourly profile returned', mix.hours.length > 3);

/* ── trips ──────────────────────────────────────────────────────────────── */
/* Paged, not capped — the twin of the driver trip ledger. */
const page = (await get(`/api/vehicle/trips?plate=${PLATE}&${W}&limit=5`)).body;
const tr = page.rows;
check('trip list honours the limit', tr.length === 5, String(tr.length));
check('and reports the window\'s real total beside it',
  page.total >= tr.length, JSON.stringify({ total: page.total, shown: page.shown }));
check('an offset returns the next page',
  ((await get(`/api/vehicle/trips?plate=${PLATE}&${W}&limit=5&offset=5`)).body).offset === 5);
check('every trip belongs to this plate', tr.every((t) => t.plate === undefined || t.plate === PLATE));
/* Every BOOKING carries a driver. A telematics journey does not: it is the
   tracker's own record of a trip, with a plate and no person. */
check('trips carry the driver name', tr.every((t) => t.driver_name || t.platform === 'fms'));

/* ── directory ──────────────────────────────────────────────────────────── */
const dir = (await get(`/api/vehicles/directory?${W}`)).body;
check('directory lists every known plate', dir.length === 2, String(dir.length));
const row = dir.find((r) => r.plate === PLATE);
check('directory carries make and model', row?.make === 'Tesla' && row?.model === 'Model Y');
check('directory carries the soonest document expiry', row?.soonest_expiry != null);
check('directory carries last telemetry status', row?.status === 'Idle', row?.status);
check('directory sorted by trips', dir[0].trips >= dir[1].trips);

// A plate that only ever appears in a document must still be listed — an asset
// with no trips is precisely the one worth finding.
await q(`INSERT INTO vehicle_document (platform,vehicle_ext_id,doc_type,plate,status,expires_at)
         VALUES ('uber','veh-9','Insurance','L00009','ACTIVE','2026-10-01')`);
const dir2 = (await get(`/api/vehicles/directory?${W}`)).body;
check('a vehicle with no trips still appears', dir2.some((r) => r.plate === 'L00009'), String(dir2.length));
check('a vehicle with no trips reports zero, not null', dir2.find((r) => r.plate === 'L00009')?.trips === 0);

/* ── the directory must not add telematics twins to bookings ─────────────
   `trips` included FMS journeys, which carry no driver, no fare and no booking
   — so a car that drove all month with nothing behind it counted as "Earning",
   inverting the exact question that tile exists to answer. */
{
  const dir = (await get(`/api/vehicles/directory?${W}`)).body;
  check('bookings and telematics journeys are separate columns',
    dir.every((r) => 'trips' in r && 'telematics_journeys' in r),
    Object.keys(dir[0] || {}).join(','));
  check('the two are never summed into one number',
    dir.every((r) => r.trips >= 0 && r.telematics_journeys >= 0));
  check('distance is guarded, so an odometer row cannot become the km column',
    dir.every((r) => r.km == null || Number(r.km) < 500000), JSON.stringify(dir.map((r) => r.km)));
  check('the id needed to link the current driver is returned',
    dir.every((r) => 'current_driver_id' in r));
}

/* ── and it must use Dubai days, like every other endpoint ───────────── */
{
  await q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
       requested_at, status, distance_km)
     VALUES ('uber','vtz-1','ecosine',$1,'d1','Someone','2026-08-15T01:00:00+04:00','completed',7)`,
    [PLATE]);
  const narrow = (await get('/api/vehicles/directory?from=2026-08-15&to=2026-08-15')).body;
  const row = narrow.find((r) => r.plate === PLATE);
  check('a 01:00 Dubai trip falls inside a window that starts that day',
    !!row && row.trips > 0, JSON.stringify(narrow.map((r) => [r.plate, r.trips])));
}

console.log('\nwhat the car took in, not what a tenth of it was priced at');

/* The card this page opens on used to be the FARES on the vehicle's trips. On
   a car working mostly Uber that is a handful of hotel bookings, and the rest
   of its work is paid for weekly to the driver — so a car showing 266 trips
   and 3,586 km led with AED 525. Both halves were already on the page; only
   one was in the headline. */
{
  const v = (await get(`/api/vehicle/kpis?plate=${PLATE}&${W}`)).body;
  const n = (x) => (x == null ? 0 : Number(x));
  check('the vehicle KPI states what the car took in',
    'accounted' in v && 'accounted_fares' in v && 'accounted_payouts' in v,
    JSON.stringify({ accounted: v.accounted, revenue: v.revenue }));
  check('and it is the sum of the halves it names',
    Math.abs(n(v.accounted) - (n(v.accounted_fares) + n(v.accounted_payouts))) < 0.5,
    `${v.accounted} vs ${n(v.accounted_fares)} + ${n(v.accounted_payouts)}`);
  /* The whole point: a car whose money is mostly payout must not still lead
     with the fares. Uber prices nothing per trip, so its share can only arrive
     through attribution. */
  check('the combined figure is not just the fares again',
    n(v.accounted) >= n(v.revenue), `${v.accounted} vs ${v.revenue}`);
  /* And never more than both halves reported, which is what adding a channel's
     fares to its own payout would give — a payout is those fares after
     commission, not money beside them. */
  check('and never counts a channel on both its fares and its payout',
    n(v.accounted) <= n(v.revenue) + n(v.attributed_earnings) + 0.5,
    `${v.accounted} vs a naive ${n(v.revenue) + n(v.attributed_earnings)}`);
  check('every platform it counted is named',
    Array.isArray(v.accounted_platforms)
      && v.accounted_platforms.length > 0
      && v.accounted_platforms.every((x) => typeof x === 'string'),
    JSON.stringify(v.accounted_platforms));

  /* A window with no data must not produce a zero that reads as measured. */
  const empty = (await get(`/api/vehicle/kpis?plate=${PLATE}&from=2019-01-01&to=2019-01-31`)).body;
  check('an empty window reports no income rather than AED 0',
    empty.accounted == null, String(empty.accounted));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
