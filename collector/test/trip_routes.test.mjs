/* ── one booking, as an address ────────────────────────────────────────────
   The driver and vehicle pages both end in a table of trip records and every
   row was a dead end. A trip carries roughly twice what that table shows —
   coordinates, seat count, the fleet it was booked under, the provider's own
   record — and none of it was reachable.

   The awkward part is the money, and it is why this endpoint returns context
   rather than a row. Uber's export has no fare column at all and its money
   arrives weekly as a payout for a DAY; the hotel channel prices every
   booking. Both fleets run both kinds. So the page has to carry the day's
   payout beside the trip's fare and be explicit that only one of them is a
   measurement of this trip — which means the endpoint has to say which. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { tripRoutes } from '../api/trip_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);
await q(`INSERT INTO vehicle (plate, fleet_id, make, model, year, color)
         VALUES ('L100','ecosine','BYD','Han EV',2025,'White')`);

/* An Uber booking: no price, because the export has none. */
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
     requested_at,ended_at,pickup_addr,pickup_lat,pickup_lng,dropoff_addr,dropoff_lat,dropoff_lng,
     distance_km,duration_s,status,product,payment_type,seat_count,price,currency,raw)
   VALUES ('uber','u-1','ecosine','L100','d-1','Ali Khan',
     '2026-08-20T06:00:00+04','2026-08-20T06:40:00+04','Al Garhoud',25.24,55.35,'DXB T3',25.25,55.36,
     18.2,2400,'completed','Comfort','offline',4,NULL,'AED','{"tier":"comfort"}')`);
/* A hotel booking the same day, same driver — this one carries a fare. */
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
     requested_at,ended_at,distance_km,status,price,currency)
   VALUES ('hotel','h-9','ecosine','L100','d-1','Ali Khan',
     '2026-08-20T09:00:00+04','2026-08-20T09:30:00+04',12.0,'completed',88.50,'AED')`);
/* And an Egari booking, so the fleet is not assumed. */
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,requested_at,status)
   VALUES ('uber','e-7','egari','L200','d-9','2026-08-20T11:00:00+04','completed')`);

await q(`INSERT INTO vehicle_driver_day (plate,day,driver_ext_id,platform,driver_name,fleet_id,trips,km,is_primary)
         VALUES ('L100','2026-08-20','d-1','uber','Ali Khan','ecosine',2,30.2,true)`);
await q(`INSERT INTO telemetry_snapshot (plate,captured_at,lat,lng,speed,status,seat_occupied,ignition,source)
         VALUES ('L100','2026-08-20T06:10:00+04',25.24,55.35,42,'moving',true,true,'fms'),
                ('L100','2026-08-20T06:30:00+04',25.25,55.36,18,'moving',true,true,'fms'),
                ('L100','2026-08-21T06:30:00+04',25.25,55.36,18,'moving',true,true,'fms')`);
await q(`INSERT INTO occupancy_segment (plate,started_at,ended_at,fleet_id,duration_min,distance_km,
           verdict,matched_platform,matched_trip_id,verdict_reason)
         VALUES ('L100','2026-08-20T06:02:00+04','2026-08-20T06:38:00+04','ecosine',36,18.0,
           'authorized','uber','u-1','matched uber trip u-1')`);
await q(`INSERT INTO driver_performance (platform,fleet_id,driver_ext_id,driver_name,
           period_start,period_end,earnings,trips,ingested_at)
         VALUES ('uber','ecosine','d-1','Ali Khan','2026-08-20','2026-08-20',412.75,9, now())`);
const { refreshPayouts } = await import('../src/rollup.js');
await refreshPayouts(db);

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
tripRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

console.log('\na trip is addressed by the provider own id');

check('platform and id are both required',
  (await get('/api/trip?platform=uber')).status === 400
  && (await get('/api/trip?id=u-1')).status === 400);
check('an id nothing matches is a 404, not an empty page',
  (await get('/api/trip?platform=uber&id=nope')).status === 404);
/* The same external id can exist on two platforms; the key is the pair. */
check('the platform is part of the key, not a filter',
  (await get('/api/trip?platform=hotel&id=u-1')).status === 404);

const r = (await get('/api/trip?platform=uber&id=u-1')).body;

console.log('\nit carries the columns the table could not show');

check('the coordinates the row has and the table never drew',
  Number(r.trip.pickup_lat) === 25.24 && Number(r.trip.dropoff_lng) === 55.36);
check('the seat count', Number(r.trip.seat_count) === 4);
check('the fleet it was booked under', r.trip.fleet_id === 'ecosine');
check('the provider own record', r.trip.raw && r.trip.raw.tier === 'comfort');
check('and the vehicle it names, resolved',
  r.vehicle?.make === 'BYD' && r.vehicle?.colour === 'White');

console.log('\nand the context a row cannot have');

check('who held the car that day',
  r.custody.length === 1 && r.custody[0].driver_name === 'Ali Khan');
check('what the trackers saw while it ran — and only while it ran',
  r.telemetry.length === 2, `${r.telemetry.length} fixes`);
check('whether the occupancy analysis matched it',
  r.segments.length === 1 && r.segments[0].matched_trip_id === 'u-1');
check('the rest of that driver day, both channels',
  r.same_day.length === 2 && r.same_day.map((x) => x.platform).sort().join() === 'hotel,uber');

console.log('\nthe money says which figure measures THIS trip');

check('an Uber booking reports no fare, because the export has none',
  r.trip.price === null && r.notes.fare_reported === false);
check('and the page is told this channel does not price trips at all',
  r.notes.platform_prices_trips === false);
/* The payout is for the DAY. Printed next to a trip without that said, it
   reads as what the trip earned — which for a nine-trip day is nine times
   what it was. */
check('the day payout is returned, with the period it was measured over',
  Number(r.payout_day.earnings) === 412.75 && Number(r.payout_day.period_days) === 1,
  JSON.stringify(r.payout_day));

const h = (await get('/api/trip?platform=hotel&id=h-9')).body;
check('a channel that prices its trips reports the fare on the trip',
  Number(h.trip.price) === 88.5 && h.notes.fare_reported === true
  && h.notes.platform_prices_trips === true);

const e = (await get('/api/trip?platform=uber&id=e-7')).body;
check('a trip on the other fleet resolves too, and names its own fleet',
  e.trip.fleet_id === 'egari');
/* A plate nobody tracked and a day nobody held is a real trip, not an error. */
check('missing context is empty rather than fatal',
  e.custody.length === 0 && e.telemetry.length === 0 && e.payout_day === null);

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
