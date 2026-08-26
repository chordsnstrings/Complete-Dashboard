/* Occupancy segments as evidence, not as an opinion.
   ──────────────────────────────────────────────────────────────────────────
   The claim "this vehicle carried a passenger with no booking behind it" is
   the most serious thing this product says about anyone, and for months the
   only thing behind it on screen was a hardcoded English sentence keyed on the
   verdict. Everything here pins the shape that makes the claim checkable:

     - the verdict facets describe the WINDOW, not the current filter, so
       picking a verdict does not make the other verdicts vanish;
     - the driver named against a segment is the one who held the car ON THAT
       DAY, never whoever holds it now;
     - the evidence page returns the NEIGHBOURS of the nearest booking, because
       a constant offset across all of them is a clock skew, not a theft;
     - and it asks the same question of the person as of the car.

   The slot endpoint is here too: it replaced a modal that showed the driver
   ranking for the whole selected range, identically for every heatmap cell. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { segmentRoutes, slotRoutes } from '../api/segment_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

/* ── fixtures ─────────────────────────────────────────────────────────────
   Three days of segments on two plates. Custody changes hands on the middle
   day, which is the case that used to name the wrong person. */
const seg = (o) => q(
  `INSERT INTO occupancy_segment (plate,started_at,ended_at,fleet_id,duration_min,distance_km,
     top_speed,fixes,max_gap_min,ignition_ratio,verdict,matched_platform,matched_trip_id,
     low_confidence,unavailable_sources,verdict_reason,nearest_platform,nearest_trip_id,
     nearest_gap_min,channels_checked,boundary_gap_min,start_lat,start_lng,end_lat,end_lng)
   VALUES ($1,$2,$3,'ecosine',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
           25.1,55.2,25.2,55.3)`,
  [o.plate, o.at, o.end ?? null, o.min ?? 20, o.km ?? 8, o.top ?? 70, o.fixes ?? 5,
   o.gap ?? 5, o.ign ?? 0.8, o.verdict, o.mp ?? null, o.mt ?? null, !!o.blind,
   o.unavail ?? null, o.reason ?? null, o.np ?? null, o.nt ?? null, o.ngap ?? null,
   o.channels ?? 'uber, yango, bolt, hotel, fms', o.bgap ?? null]);

let tn = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,
     ended_at,distance_km,status,product,payment_type,price,pickup_addr,dropoff_addr)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
  [o.platform, `t${tn++}`, o.plate ?? null, o.drv ?? null, o.name ?? null, o.at, o.end ?? null,
   o.km ?? 10, o.status ?? 'completed', o.product ?? null, o.pay ?? null, o.price ?? null,
   o.from ?? 'Dubai Marina - Dubai - UAE', o.to ?? 'DXB T3 - Dubai - UAE']);

const custody = (day, plate, drv, name, trips = 5) => q(
  `INSERT INTO vehicle_driver_day (plate,day,driver_ext_id,driver_name,platform,trips,km,revenue,is_primary)
   VALUES ($1,$2::date,$3,$4,'uber',$5,120,0,true)`, [plate, day, drv, name, trips]);

// L100: Alice holds it on the 10th, Bob takes it over on the 11th.
await custody('2026-08-10', 'L100', 'a1', 'Alice Ahmed');
await custody('2026-08-11', 'L100', 'b1', 'Bob Bakr');
await custody('2026-08-12', 'L100', 'b1', 'Bob Bakr');
await custody('2026-08-10', 'L200', 'c1', 'Carla Chen');

// Alice's flagged segment on the 10th, at 22:00 Dubai — 18:00 UTC.
const A_AT = '2026-08-10T22:00:00+04:00';
await seg({ plate: 'L100', at: A_AT, end: '2026-08-10T22:35:00+04:00', verdict: 'unauthorized',
  min: 35, km: 22, reason: 'no booking within 15 min on any of 5 channels',
  np: 'uber', nt: 'u-999', ngap: 240 });
// Bob's, on the 11th, matched.
await seg({ plate: 'L100', at: '2026-08-11T09:00:00+04:00', end: '2026-08-11T09:20:00+04:00',
  verdict: 'authorized', mp: 'uber', mt: 'u-1', reason: 'matched a uber booking 2 min away' });
// Another of Bob's on the 11th — same day, so the evidence page shows context.
await seg({ plate: 'L100', at: '2026-08-11T14:00:00+04:00', verdict: 'sensor_suspect',
  ign: 0.02, reason: 'occupied with ignition off for 3h' });
/* Two matched hotel segments whose ids differ. A hotel trip id is a 24-hex
   Mongo ObjectId with no dashes, not the 32-hex UUID the other channels issue,
   and it used to escape the id-shaping rule and get mangled digit-by-digit
   into "matched hotel trip NaNdbNbNbaNdbfNccN" — a different string per id,
   so one reason became one facet row each. Both must collapse to one. */
await seg({ plate: 'L200', at: '2026-08-11T08:00:00+04:00', verdict: 'authorized',
  mp: 'hotel', mt: '6a8db4b47ba7dbf44436cc83',
  reason: 'matched hotel trip 6a8db4b47ba7dbf44436cc83' });
await seg({ plate: 'L200', at: '2026-08-11T10:00:00+04:00', verdict: 'authorized',
  mp: 'hotel', mt: '675d566697467adfe29a32c7',
  reason: 'matched hotel trip 675d566697467adfe29a32c7' });
// And one carrying a dashed UUID, so the older shape stays covered.
await seg({ plate: 'L200', at: '2026-08-11T12:00:00+04:00', verdict: 'authorized',
  mp: 'uber', mt: 'fa66c89c-1111-2222-3333-444455556666',
  reason: 'matched uber trip fa66c89c-1111-2222-3333-444455556666' });
// A blind one, and one with no reason at all.
await seg({ plate: 'L200', at: '2026-08-10T11:00:00+04:00', verdict: 'unverifiable',
  blind: true, unavail: 'bolt, yango' });
await seg({ plate: 'L200', at: '2026-08-12T11:00:00+04:00', verdict: 'unauthorized', km: 14 });

/* Three bookings on L100 around Alice's segment, ALL at roughly +240 minutes.
   This is the clock-skew signature the page has to be able to show. */
for (let i = 0; i < 3; i++) {
  await trip({ platform: ['uber', 'bolt', 'yango'][i], plate: 'L100', drv: 'a1', name: 'Alice Ahmed',
    at: `2026-08-11T02:0${i}:00+04:00`, status: ['completed', 'finished', 'complete'][i], price: 40 });
}
// And one booking by Alice in a DIFFERENT vehicle 30 min into her segment.
await trip({ platform: 'uber', plate: 'L900', drv: 'a1', name: 'Alice Ahmed',
  at: '2026-08-10T22:30:00+04:00', status: 'completed', price: 55 });

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const range = (req) => [req.query.from || '2026-08-01', req.query.to || '2026-08-31'];
const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;
segmentRoutes(app, { q, wrap, range, DAYWIN });
slotRoutes(app, { q, wrap, range });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json() }; };

/* ── the list ─────────────────────────────────────────────────────────────── */
const all = (await get('/api/segments')).body;
check('every segment in the window is listed', all.rows.length === 8, String(all.rows.length));
check('rows carry the recorded reason, not a sentence written in the UI',
  all.rows.some((r) => /no booking within 15 min/.test(r.verdict_reason || '')));
check('every segment with no recorded reason is counted, not hidden',
  all.unreasoned === 2, String(all.unreasoned));
check('a segment assessed while a channel was down is counted separately',
  all.low_confidence === 1, String(all.low_confidence));
check('the local day is a plain YYYY-MM-DD, not a Date stringified',
  all.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.local_day)),
  JSON.stringify(all.rows.map((r) => r.local_day)));

/* The 22:00 Dubai segment is 18:00 UTC on the same day, but a segment at 01:00
   Dubai would be the PREVIOUS UTC day. The window must be Dubai-local. */
const aliceRow = all.rows.find((r) => r.started_at && new Date(r.started_at).toISOString().startsWith('2026-08-10T18'));
check('a late-evening Dubai segment keeps its Dubai date',
  aliceRow?.local_day === '2026-08-10', aliceRow?.local_day);

/* ── who is named ─────────────────────────────────────────────────────────── */
check('the segment is attributed to whoever held the car THAT day',
  aliceRow?.drivers === 'Alice Ahmed', String(aliceRow?.drivers));
// By plate as well as verdict: L200 also carries authorized rows now, and
// "the first authorized row" was only Bob's by accident of the fixture.
const bobRow = all.rows.find((r) => r.verdict === 'authorized' && r.plate === 'L100');
check('the next day names the driver who took over, not the previous one',
  bobRow?.drivers === 'Bob Bakr', String(bobRow?.drivers));
const orphan = all.rows.find((r) => r.plate === 'L200' && r.local_day === '2026-08-12');
check('a vehicle with no custody that day names nobody rather than guessing',
  orphan?.drivers == null, String(orphan?.drivers));

/* ── filters ──────────────────────────────────────────────────────────────── */
const unauth = (await get('/api/segments?verdict=unauthorized')).body;
check('the verdict filter narrows the rows', unauth.rows.length === 2, String(unauth.rows.length));
check('but the facets still describe the whole window',
  unauth.facets.verdict.length === 4, JSON.stringify(unauth.facets.verdict.map((v) => v.key)));
check('the filter is echoed back so the page can say what it is showing',
  unauth.filter.verdict === 'unauthorized');

const byPlate = (await get('/api/segments?plate=L200')).body;
check('the plate filter narrows the rows', byPlate.rows.length === 5, String(byPlate.rows.length));
const byDay = (await get('/api/segments?day=2026-08-11')).body;
check('the day filter is a Dubai calendar day', byDay.rows.length === 5, String(byDay.rows.length));
const byDrv = (await get('/api/segments?driver=Alice')).body;
check('the driver filter matches on the name custody recorded',
  byDrv.rows.length === 1 && byDrv.rows[0].plate === 'L100', String(byDrv.rows.length));

/* A plate facet must be per PLATE. Grouping by the custody subquery would
   silently return one row per segment wearing a plate label. */
const pf = all.facets.plate;
check('the plate facet has one row per plate, not one per segment',
  pf.length === 2, String(pf.length));
check('the plate facet counts unauthorized separately from the total',
  pf.find((r) => r.key === 'L100')?.unauthorized === 1, JSON.stringify(pf.find((r) => r.key === 'L100')));
check('the day facet is ordered so a strip reads left to right',
  all.facets.day.map((r) => r.key).join() === '2026-08-10,2026-08-11,2026-08-12',
  all.facets.day.map((r) => r.key).join());
check('a segment with no reason is folded under a visible label, not dropped',
  all.facets.reason.some((r) => r.key === '(no reason recorded)'),
  JSON.stringify(all.facets.reason.map((r) => r.key)));
const hotelReason = all.facets.reason.filter((r) => /matched hotel trip/.test(r.key));
check('two hotel matches with different ObjectIds are ONE reason, not two',
  hotelReason.length === 1 && hotelReason[0].n === 2,
  JSON.stringify(all.facets.reason.map((r) => [r.key, r.n])));
check('and the id is replaced rather than mangled into N-and-letters',
  hotelReason.length === 1 && hotelReason[0].key === 'matched hotel trip <trip id>',
  JSON.stringify(hotelReason.map((r) => r.key)));
check('a dashed UUID is still replaced the same way',
  all.facets.reason.some((r) => r.key === 'matched uber trip <trip id>'),
  JSON.stringify(all.facets.reason.map((r) => r.key)));

/* ── the evidence page ────────────────────────────────────────────────────── */
const bad = await get('/api/segment?plate=L100');
check('a segment address without an instant is refused', bad.status === 400, String(bad.status));
const nf = await get('/api/segment?plate=L100&at=2026-01-01T00:00:00Z');
check('an instant no segment starts at 404s rather than returning the nearest',
  nf.status === 404, String(nf.status));

const ev = (await get(`/api/segment?plate=L100&at=${encodeURIComponent('2026-08-10T18:00:00.000Z')}`)).body;
check('the evidence page resolves the segment', ev.segment?.plate === 'L100');
check('it names the driver who held the car that day', ev.segment?.drivers === 'Alice Ahmed', String(ev.segment?.drivers));

/* The whole point: the neighbours, not just the nearest. */
/* Four hours either side, not one: the documented real skew is 240 minutes,
   and a window narrower than the bug cannot show the bug. */
check('every booking on the vehicle around the segment is returned, not just the nearest',
  ev.nearby_vehicle_trips.length === 3, String(ev.nearby_vehicle_trips.length));
const offsets = ev.nearby_vehicle_trips.map((t) => t.gap_min);
check('each neighbour carries its offset from the segment start',
  offsets.every((o) => o >= 239 && o <= 243), JSON.stringify(offsets));
check('a constant offset across every neighbour is visible in the data',
  Math.max(...offsets) - Math.min(...offsets) < 5, JSON.stringify(offsets));
check('the neighbours carry a normalised outcome, so Bolt’s "finished" is not a failure',
  ev.nearby_vehicle_trips.every((t) => t.outcome === 'completed'),
  JSON.stringify(ev.nearby_vehicle_trips.map((t) => [t.status, t.outcome])));

check('the same question is asked of the person, not only the car',
  ev.nearby_driver_trips.length >= 1, String(ev.nearby_driver_trips.length));
check('a booking that driver took in a DIFFERENT vehicle is surfaced',
  ev.nearby_driver_trips.some((t) => t.plate === 'L900'),
  JSON.stringify(ev.nearby_driver_trips.map((t) => t.plate)));

check('custody either side of the day is returned so a handover is visible',
  ev.custody.length === 3 && ev.custody.some((c) => c.driver_name === 'Bob Bakr')
    && ev.custody.some((c) => c.driver_name === 'Alice Ahmed'),
  JSON.stringify(ev.custody.map((c) => c.driver_name)));
check('which channels wrote rows that day is returned, so "no booking" is checkable',
  Array.isArray(ev.channels_that_day));
check('a gap larger than two poll intervals marks the window as not fully observed',
  ev.profile.observed === true, String(ev.profile.observed));

const suspect = (await get(`/api/segment?plate=L100&at=${encodeURIComponent('2026-08-11T10:00:00.000Z')}`)).body;
check('a same-day sibling segment is returned as context',
  suspect.same_day_segments.length === 2, String(suspect.same_day_segments.length));

/* ── the slot ─────────────────────────────────────────────────────────────── */
const badSlot = await get('/api/slot?dow=9&hour=3');
check('an impossible weekday is refused rather than returning everything',
  badSlot.status === 400, String(badSlot.status));
const badHour = await get('/api/slot?dow=1&hour=99');
check('an impossible hour is refused', badHour.status === 400, String(badHour.status));

// The three neighbour bookings are at 02:00-02:02 Dubai on Tuesday 11 August.
const slot = (await get('/api/slot?dow=2&hour=2')).body;
check('the slot finds the bookings in that Dubai hour', slot.headline.trips === 3, String(slot.headline.trips));
check('it counts how many of that weekday the window even contained',
  slot.headline.possible_days >= 4, String(slot.headline.possible_days));
check('the typical figure is per occurrence of the weekday, not per firing day',
  slot.headline.trips_per_occurrence < slot.headline.trips,
  `${slot.headline.trips_per_occurrence} vs ${slot.headline.trips}`);
check('coverage says on how many of those weekdays anything happened at all',
  slot.headline.coverage_pct != null && slot.headline.coverage_pct <= 100,
  String(slot.headline.coverage_pct));
check('completion in the slot is normalised, so a Bolt "finished" counts',
  Number(slot.headline.completion_pct) === 100, String(slot.headline.completion_pct));
check('the drivers covering the slot are named', slot.drivers.some((d) => d.driver_name === 'Alice Ahmed'),
  JSON.stringify(slot.drivers.map((d) => d.driver_name)));
check('every platform bringing work to the slot is listed',
  slot.platforms.length === 3, JSON.stringify(slot.platforms.map((p) => p.platform)));
check('the origin of the work is rolled up from the pickup address',
  slot.corridors.length >= 1 && slot.corridors[0].place.length > 0, JSON.stringify(slot.corridors));
check('every occurrence of the slot is returned so the average has a spread',
  slot.occurrences.length >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(slot.occurrences[0].day),
  JSON.stringify(slot.occurrences));
check('the same hour on other weekdays is returned for comparison',
  slot.peers.length >= 1, String(slot.peers.length));
check('the settlement class of the slot is returned', Array.isArray(slot.settlement));
check('an empty slot reports zero rather than failing',
  (await get('/api/slot?dow=6&hour=4')).body.headline.trips === 0);

/* A telematics journey has no platform, no fare and no outcome. Folding it in
   would inflate every count on the page with rows that answer none of its
   questions. */
await trip({ platform: 'fms', plate: 'L100', at: '2026-08-11T02:30:00+04:00', status: 'completed' });
const after = (await get('/api/slot?dow=2&hour=2')).body;
check('a telematics journey does not become a trip in the slot',
  after.headline.trips === 3, String(after.headline.trips));

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
