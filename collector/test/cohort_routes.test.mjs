/* Every source, for a named set, in one request.
   ─────────────────────────────────────────────────────────────────────────
   The drill-down's whole claim is that a reader stops opening one page per
   person. What makes that true is that this endpoint gathers what each system
   said separately — standing from a provider, pay from a statement, hours from
   a supplier session, the car from custody, harsh braking from a telematics
   box, papers from the fleet portal — and hands back one row per member.

   Two things break silently here and both are tested: an id nobody knows must
   come back as an empty row rather than vanish (a page that drops it shows 32
   cards under a heading that says 33), and an id NOT asked for must never
   appear (an unbounded join would hand back the fleet). */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { rebuildCustody } from '../src/custody.js';
import { cohortRoutes } from '../api/cohort_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const D = '2026-08-20', OUT = '2026-05-05';
let n = 0;
const trip = (plate, drv, name, day, hour, o = {}) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
                     requested_at,ended_at,distance_km,price,status)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10)`,
  [o.platform || 'uber', `c${n++}`, plate, drv, name,
   `${day}T${String(hour).padStart(2, '0')}:00:00+04:00`,
   `${day}T${String(hour).padStart(2, '0')}:30:00+04:00`,
   o.km ?? 12, o.price ?? null, o.status || 'completed']);

// Ali: two accounts (Uber and the hotel channel), one car, one harsh event.
for (let i = 0; i < 5; i++) await trip('C1', 'd-ali', 'Ali Rahman', D, 8 + i);
await trip('C1', 'd-ali-h', 'Ali Rahman', D, 19, { platform: 'hotel', price: 120 });
await trip('C1', 'd-ali', 'Ali Rahman', D, 21, { status: 'rider_cancelled', km: 0 });
// Outside the window entirely — nothing below may count it.
await trip('C1', 'd-ali', 'Ali Rahman', OUT, 9);
// Sara: drove, was never paid.
for (let i = 0; i < 3; i++) await trip('C2', 'd-sara', 'Sara Iqbal', D, 10 + i);

await q(`INSERT INTO driver_payout_day (platform,fleet_id,driver_ext_id,driver_name,day,
           period_start,period_end,earnings,cash_earnings,trips)
         VALUES ('uber','ecosine','d-ali','Ali Rahman',$1,$1,$1,410,60,5),
                ('uber','ecosine','d-ali','Ali Rahman',$2,$2,$2,999,0,4)`, [D, OUT]);
await q(`INSERT INTO driver_day (driver_ext_id,day,fleet_id,platforms,plates,trips,completed,
           cancelled,km,online_min,idle_online_min,on_job_min,first_min,last_min,longest_wait_min)
         VALUES ('d-ali',$1,'ecosine',ARRAY['uber'],ARRAY['C1'],6,5,1,72,600,480,120,480,1290,95)`, [D]);
await q(`INSERT INTO driver_platform_state (platform,driver_ext_id,fleet_id,full_name,state,can_earn,plate,observed_at)
         VALUES ('uber','d-ali','ecosine','Ali Rahman','active',true,'C1',now()),
                ('uber','d-sara','ecosine','Sara Iqbal','deactivated',false,'C2',now())`);
await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_expires,state,rating)
         VALUES ('uber','d-ali','ecosine','Ali Rahman','2026-09-10','ACTIVE',4.8)`);
await q(`INSERT INTO driver_performance (platform,fleet_id,driver_ext_id,driver_name,period_start,period_end,
           trips,hours_online,hours_on_trip,acceptance_rate,rating)
         VALUES ('uber','ecosine','d-ali','Ali Rahman','2026-08-01','2026-08-28',120,180,44,0.93,4.8)`);
await q(`INSERT INTO alert (platform,external_id,fleet_id,plate,alert_type,occurred_at,location)
         VALUES ('fms','al1','ecosine','C1','Overspeed',$1,'E11'),
                ('fms','al2','ecosine','C1','Harsh Braking',$1,'SZR'),
                ('fms','al3','ecosine','C1','Overspeed',$2,'E11')`,
  [`${D}T09:30:00+04:00`, `${OUT}T09:30:00+04:00`]);
await q(`INSERT INTO vehicle (plate, fleet_id, make, model, year, fuel_type)
         VALUES ('C1','ecosine','Tesla','Model Y',2023,'electric')`);
await q(`INSERT INTO vehicle_document (platform,vehicle_ext_id,doc_type,plate,status,expires_at)
         VALUES ('uber','v1','Insurance','C1','ACTIVE','2027-01-01'),
                ('uber','v1','Vehicle Registration Form','C1','ACTIVE','2026-09-04')`);
await q(`INSERT INTO telemetry_snapshot (source,plate,captured_at,lat,lng,speed,status,odometer)
         VALUES ('cabman','C1','2026-08-27T09:00:00+04:00',25.1,55.2,0,'Idle',91000),
                ('cabman','C1','2026-08-28T02:00:00+04:00',25.1,55.2,0,'Idle',91120)`);
await q(`INSERT INTO occupancy_segment (plate,started_at,ended_at,duration_min,distance_km,verdict,fixes)
         VALUES ('C1',$1,$1,40,18,'unauthorized',9),
                ('C1',$2,$2,30,12,'partial',7),
                ('C1',$3,$3,30,12,'unauthorized',7)`,
  [`${D}T22:00:00+04:00`, `${D}T23:00:00+04:00`, `${OUT}T22:00:00+04:00`]);
await q(`INSERT INTO vehicle_utilisation (platform,vehicle_ext_id,plate,period_start,period_end,
           trips,hours_online,hours_on_trip,utilisation,earnings)
         VALUES ('uber','v1','C1','2026-08-01','2026-08-28',60,210,88,0.42,5400)`);

await rebuildCustody({ from: '2026-05-01', to: '2026-08-31', db });

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
cohortRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };
const W = 'from=2026-08-01&to=2026-08-31';

/* ── people ──────────────────────────────────────────────────────────────── */
const d = (await get(`/api/cohort/drivers?${W}&ids=d-ali,d-ali-h,d-sara,d-nobody`)).body;
const byId = new Map((d.rows || []).map((r) => [r.id, r]));
check('one row per id asked for', d.rows.length === 4, `${d.rows.length}`);
check('an id nothing knows still comes back, empty',
  byId.get('d-nobody') && byId.get('d-nobody').work.length === 0
  && byId.get('d-nobody').standing.length === 0, JSON.stringify(byId.get('d-nobody')));

const ali = byId.get('d-ali');
check('work is per channel', ali.work.length === 1 && ali.work[0].platform === 'uber',
  JSON.stringify(ali.work));
check('bookings count the window only, not the whole record',
  ali.work[0].bookings === 6, `${ali.work[0].bookings}`);
/* The channel's own word, not the three-value fold: "not completed" is what
   the count already says, and a card that prints it as the reason is a card
   that tells the reader nothing. */
check('a booking that did not complete carries the channel\'s own reason',
  ali.work[0].completed === 5 && ali.not_completed.length === 1
  && ali.not_completed[0].status === 'rider_cancelled'
  && ali.not_completed[0].outcome === 'not_completed', JSON.stringify(ali.not_completed));
check('the hotel channel is its own account, with its own fare',
  byId.get('d-ali-h')?.work?.[0]?.fares === '120.00' || Number(byId.get('d-ali-h')?.work?.[0]?.fares) === 120,
  JSON.stringify(byId.get('d-ali-h')?.work));
check('pay is the window, not every statement ever',
  Number(ali.pay[0]?.payout) === 410, JSON.stringify(ali.pay));
check('availability comes back as one summed row',
  ali.availability && Number(ali.availability.online_min) === 600
  && Number(ali.availability.idle_min) === 480, JSON.stringify(ali.availability));
check('standing is read even though it carries no date in the window',
  ali.standing[0]?.state === 'active' && ali.standing[0]?.can_earn === true);
check('a stopped driver reports so', byId.get('d-sara')?.standing?.[0]?.can_earn === false);
check('compliance carries the days left, computed once',
  ali.compliance[0] && Number(ali.compliance[0].licence_days_left) > 0, JSON.stringify(ali.compliance));
check('the car they held is named with the days', ali.cars[0]?.plate === 'C1' && ali.cars[0]?.days === 1,
  JSON.stringify(ali.cars));
/* An alert names a plate and never a person; it reaches one only through the
   custody row for the day it happened. */
check('harsh driving is attributed through custody',
  ali.alerts.length === 2 && ali.alerts[0].n === 1 && ali.alerts.some((a) => a.alert_type === 'Overspeed'),
  JSON.stringify(ali.alerts));
check('an alert outside the window is not attributed',
  ali.alerts.reduce((a, x) => a + x.n, 0) === 2, JSON.stringify(ali.alerts));
check('the platform scorecard is carried', Number(ali.performance[0]?.hours_online) === 180);
check('nobody who was not asked for appears',
  !d.rows.some((r) => !['d-ali', 'd-ali-h', 'd-sara', 'd-nobody'].includes(r.id)));

/* ── cars ────────────────────────────────────────────────────────────────── */
const v = (await get(`/api/cohort/vehicles?${W}&ids=C1,C2,C9`)).body;
const byPlate = new Map((v.rows || []).map((r) => [r.plate, r]));
check('one row per plate asked for', v.rows.length === 3, `${v.rows.length}`);
const c1 = byPlate.get('C1');
check('the fleet register answers', c1.spec?.make === 'Tesla' && c1.spec?.year === 2023, JSON.stringify(c1.spec));
check('bookings and journeys are counted apart',
  c1.work.reduce((a, x) => a + x.bookings, 0) === 7, JSON.stringify(c1.work));
check('two channels are two rows', c1.work.length === 2, JSON.stringify(c1.work.map((x) => x.platform)));
check('custody names who held it', c1.custody[0]?.driver_name === 'Ali Rahman', JSON.stringify(c1.custody));
check('every document is returned, soonest first',
  c1.documents.length === 2 && c1.documents[0].doc_type === 'Vehicle Registration Form',
  JSON.stringify(c1.documents.map((x) => x.doc_type)));
check('the tracker returns its LAST fix, not its first',
  c1.telematics && String(c1.telematics.last_fix).startsWith('2026-08-27T22'),
  JSON.stringify(c1.telematics?.last_fix));
check('a car with no tracker row says so rather than inventing one',
  byPlate.get('C2')?.telematics === null, JSON.stringify(byPlate.get('C2')?.telematics));
check('seat-sensor verdicts are separated',
  c1.segments.length === 2 && c1.segments.some((x) => x.verdict === 'partial')
  && c1.segments.find((x) => x.verdict === 'unauthorized')?.n === 1,
  JSON.stringify(c1.segments));
check('platform utilisation is carried', Number(c1.utilisation[0]?.hours_online) === 210);
check('a plate nothing knows comes back empty rather than missing',
  byPlate.get('C9') && byPlate.get('C9').work.length === 0 && byPlate.get('C9').spec != null);
check('a plate typed with a space still resolves',
  (await get(`/api/cohort/vehicles?${W}&ids=${encodeURIComponent('C 1')}`)).body.rows[0]?.plate === 'C1');

/* ── the bounds ──────────────────────────────────────────────────────────── */
const none = (await get(`/api/cohort/drivers?${W}`)).body;
check('no ids is an empty answer, not the whole fleet', none.rows.length === 0 && none.ids.length === 0);
const many = (await get(`/api/cohort/vehicles?${W}&ids=${Array.from({ length: 600 }, (_, i) => `X${i}`).join(',')}`)).body;
check('an unbounded id list is capped', many.ids.length === 400, `${many.ids.length}`);
const dup = (await get(`/api/cohort/drivers?${W}&ids=d-ali,d-ali,d-ali`)).body;
check('a repeated id is asked for once', dup.rows.length === 1, `${dup.rows.length}`);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
