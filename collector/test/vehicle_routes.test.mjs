/* Per-vehicle detail API, end to end.
   The thing worth testing here is that the four systems describing one car are
   actually joined: trips say it earned, telematics says where it was, the fleet
   portal says whether its papers are current, and the custody table says who
   was holding it. The fixture gives the same plate a different story in each. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { vehicleRoutes } from '../api/vehicle_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

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

// 2026-08-14: the tracker reports but nothing earned — an idle day
await q(`INSERT INTO telemetry_snapshot (source,plate,captured_at,lat,lng,speed,status,fuel_level)
         VALUES ('cabman',$1,'2026-08-14T09:00:00+04:00',25.10,55.18,0,'Idle',88),
                ('cabman',$1,'2026-08-14T09:05:00+04:00',25.10,55.18,0,'Idle',88),
                ('cabman',$1,'2026-08-14T09:10:00+04:00',25.10,55.18,0,'Idle',87),
                ('cabman',$1,'2026-08-13T09:00:00+04:00',25.20,55.27,54,'Active',90)`, [PLATE]);

await q(`INSERT INTO vehicle_driver_day (plate,day,driver_ext_id,platform,driver_name,trips,km,revenue,is_primary)
         VALUES ($1,'2026-08-10','d-ali','uber','Ali Rahman',6,66,252,true),
                ($1,'2026-08-11','d-ali','uber','Ali Rahman',6,66,252,true),
                ($1,'2026-08-12','d-sara','uber','Sara Iqbal',4,44,168,true),
                ($1,'2026-08-13','d-ali','uber','Ali Rahman',8,88,354,true)`, [PLATE]);

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
check('trip span counted', prof.span.trips === 24, String(prof.span?.trips));
check('both drivers counted', prof.span.drivers === 2, String(prof.span?.drivers));
check('latest telemetry fix attached', prof.telemetry?.status === 'Idle', prof.telemetry?.status);
check('documents sorted soonest-expiry first', prof.documents[0]?.doc_type === 'Vehicle Registration Form', prof.documents[0]?.doc_type);
check('document days-left computed', typeof prof.documents[0]?.days_left === 'number');

/* ── kpis ───────────────────────────────────────────────────────────────── */
const k = (await get(`/api/vehicle/kpis?plate=${PLATE}&${W}`)).body;
check('kpi trips exclude other plates', k.trips === 24, String(k.trips));
check('utilisation carried from the platform record', +k.utilisation === 0.55, String(k.utilisation));
check('alerts counted for this plate only', k.alerts === 3, String(k.alerts));
check('alerts normalised per 100km', k.alerts_per_100km > 0, String(k.alerts_per_100km));
// 2026-08-14 has fixes but no trips; the four earning days do not count as idle
check('an idle day is a day it reported but did not earn', k.idle_days === 1, String(k.idle_days));
check('revenue per km derived', k.revenue_per_km > 0, String(k.revenue_per_km));

/* ── daily spine ────────────────────────────────────────────────────────── */
const daily = (await get(`/api/vehicle/daily?plate=${PLATE}&${W}`)).body;
check('daily includes the day with no trips', daily.length === 5, String(daily.length));
const idleDay = daily.find((d) => d.day.startsWith('2026-08-14'));
check('the idle day shows fixes but zero trips', idleDay?.trips === 0 && idleDay?.fixes === 3, JSON.stringify(idleDay));
const busy = daily.find((d) => d.day.startsWith('2026-08-13'));
check('the busy day names its driver', busy?.drivers_named === 'Ali Rahman', busy?.drivers_named);
check('alerts join onto the day', busy?.alerts === 2, String(busy?.alerts));

/* ── custody ────────────────────────────────────────────────────────────── */
const dd = (await get(`/api/vehicle/drivers-detail?plate=${PLATE}&${W}`)).body;
check('custody covers every day', dd.days.length === 4, String(dd.days.length));
check('per-driver totals rank by trips', dd.totals[0]?.driver_name === 'Ali Rahman', dd.totals[0]?.driver_name);
check('the handover driver appears too', dd.totals.some((t) => t.driver_name === 'Sara Iqbal'));
check('primary days counted', dd.totals[0]?.primary_days === 3, String(dd.totals[0]?.primary_days));

/* ── movement ───────────────────────────────────────────────────────────── */
const mv = (await get(`/api/vehicle/movement?plate=${PLATE}&${W}`)).body;
check('occupancy segments returned newest first', mv.segments.length === 2 &&
  new Date(mv.segments[0].started_at) > new Date(mv.segments[1].started_at));
check('segments summarised by verdict', mv.by_verdict.some((v) => v.verdict === 'unauthorized'));
check('replayable days need at least three fixes', mv.days.length === 1 && mv.days[0].fixes === 3, JSON.stringify(mv.days));
check('parking clusters come from stationary fixes', mv.parked.length === 1 && mv.parked[0].fixes === 3, JSON.stringify(mv.parked));

/* ── safety ─────────────────────────────────────────────────────────────── */
const sf = (await get(`/api/vehicle/safety?plate=${PLATE}&${W}`)).body;
check('alert types ranked', sf.by_type[0]?.alert_type === 'Overspeed', sf.by_type[0]?.alert_type);
check('alerts attributed to the driver holding the car that day',
  sf.by_driver.find((d) => d.driver_name === 'Ali Rahman')?.n === 2, JSON.stringify(sf.by_driver));
check('the handover day\'s alert goes to the other driver',
  sf.by_driver.find((d) => d.driver_name === 'Sara Iqbal')?.n === 1, JSON.stringify(sf.by_driver));
check('recent alerts carry a location', sf.recent[0]?.location != null);

/* ── mix ────────────────────────────────────────────────────────────────── */
const mix = (await get(`/api/vehicle/mix?plate=${PLATE}&${W}`)).body;
check('platform mix spans uber and yango', mix.platform.length === 2, String(mix.platform.length));
check('product mix includes the Comfort trip', mix.product.some((r) => r.label === 'Comfort'));
check('hourly profile returned', mix.hours.length > 3);

/* ── trips ──────────────────────────────────────────────────────────────── */
const tr = (await get(`/api/vehicle/trips?plate=${PLATE}&${W}&limit=5`)).body;
check('trip list honours the limit', tr.length === 5, String(tr.length));
check('every trip belongs to this plate', tr.every((t) => t.plate === undefined || t.plate === PLATE));
check('trips carry the driver name', tr.every((t) => t.driver_name));

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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
