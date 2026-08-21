/* Aggregate correctness against production's actual data shape.
   ──────────────────────────────────────────────────────────────────────────
   The fixture below is the shape that broke the dashboard, not a tidy one:

     - the Uber trip report carries NO fare column, so `price` is NULL on every
       Uber row;
     - telematics trips have no driver, no fare and no payment type at all;
     - `product` holds Uber's tiers AND the hotel channel's booking types, which
       mean nothing to each other.

   Against that, the Finance page reported an average fare of AED 6.98 (it
   divided hotel revenue by every trip in the fleet), a revenue-per-km of
   AED 0.55, a payment donut that was 80% "unknown", and a "service tier
   economics" table that compared an hourly hotel charter with an Uber drop-off
   and concluded one earned 4.3x the other.

   Every assertion here is one of those numbers. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql', 'schema_v6.sql', 'schema_v7.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

const trip = (o) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,
                     distance_km,status,product,payment_type,price,service_type)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [o.platform, o.id, o.plate, o.drv ?? null, o.drv ? 'Driver ' + o.drv : null,
   `2026-08-${String(o.day).padStart(2, '0')}T10:00:00+04:00`,
   o.km ?? null, o.status ?? 'completed', o.product ?? null, o.pay ?? null, o.price ?? null,
   o.service ?? null]);

let n = 0;
// 60 Uber trips: tiers and payment types, but never a fare — this is the real
// shape of the Uber trip export.
for (let i = 0; i < 60; i++) {
  await trip({ platform: 'uber', id: `u${n++}`, plate: `L${100 + (i % 6)}`, drv: `d${i % 5}`,
    day: 1 + (i % 20), km: 10, product: ['UberX', 'Black', 'Comfort', 'Electric'][i % 4],
    pay: ['card', 'cash', 'apple_pay'][i % 3], service: 'personal_transport' });
}
// 100 telematics trips: no driver, no fare, no payment type, no product.
for (let i = 0; i < 100; i++) {
  await trip({ platform: 'fms', id: `f${n++}`, plate: `L${100 + (i % 6)}`, day: 1 + (i % 20), km: 20 });
}
// 20 hotel trips: these DO carry a fare, and their own booking types.
for (let i = 0; i < 20; i++) {
  await trip({ platform: 'hotel', id: `h${n++}`, plate: `L${100 + (i % 6)}`, drv: `hd${i % 3}`,
    day: 1 + (i % 20), km: 25, product: ['pick_and_drop', 'hourly'][i % 2],
    pay: 'room-charge', price: (i % 2) ? 200 : 50 });
}
// A cancelled trip, so the completion base is not all-completed.
await trip({ platform: 'uber', id: 'ux', plate: 'L100', drv: 'd0', day: 5, km: 0, status: 'rider_cancelled', product: 'UberX', pay: 'card' });
// Bolt: carries a fare but NO driver id, NO distance, NO payment type, and its
// own status vocabulary — 'finished' means completed, and three of its four
// failure states do not contain the word "cancel". Every one of those is a
// place the old code got the wrong answer.
for (let i = 0; i < 3; i++) await trip({ platform: 'bolt', id: `b${i}`, plate: 'L101', day: 7, status: 'finished', price: 80 });
await trip({ platform: 'bolt', id: 'bx', plate: 'L101', day: 7, status: 'client_did_not_show', price: null });

/* ── mount the real handlers ──────────────────────────────────────────────
   Extracted from api/server.js rather than reimplemented, so this test fails
   when the shipped SQL drifts. */
const src = readFileSync('api/server.js', 'utf8');
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
const asDate = (v, fallback) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : fallback);
const range = (req) => {
  let from = asDate(req.query.from, '2000-01-01');
  let to = asDate(req.query.to, '2100-01-01');
  if (from > to) [from, to] = [to, from];
  return [from, to, req.query.platform || null, req.query.fleet || null];
};
const F = `local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`;
const FB = `${F} AND is_booking`;
const body = slice("app.get('/api/kpis'", "app.get('/api/trips/daily'")
  + slice('/* Breakdown by one dimension.', '/* ───────────────────────── drivers ───────────────────────── */');
// eslint-disable-next-line no-new-func
new Function('app', 'q', 'wrap', 'range', 'F', 'FB', body)(app, q, wrap, range, F, FB);
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

const W = 'from=2026-08-01&to=2026-08-31';
const k = await get(`/api/kpis?${W}`);

/* ── bookings versus telematics journeys ─────────────────────────────────
   61 Uber bookings + 20 hotel bookings = 81. The 100 FMS rows are the SAME
   physical journeys seen by the tracker; adding them would count each trip
   twice, which is what produced the fleet's doubled headline figures. */
check('trips counts bookings only', k.trips === 85, String(k.trips));
check('telematics journeys are reported separately', k.telematics_journeys === 100, String(k.telematics_journeys));
check('telematics is never added to the trip count', k.trips !== 185, String(k.trips));

/* ── the money ratios ────────────────────────────────────────────────────
   Only the 20 hotel bookings carry a fare: 10 x 200 + 10 x 50 = AED 2,500
   over 500 km. */
check('revenue is the sum of the fares that exist', +k.revenue === 2740, String(k.revenue));
check('priced trips are counted separately', k.priced_trips === 23, String(k.priced_trips));
// The bug: 2500/181 = 13.81. The truth: 2500/20 = 125.
check('average fare divides by priced trips, not all trips', +k.avg_fare === 119.13, String(k.avg_fare));
check('average fare is NOT revenue over all trips', Math.abs(+k.avg_fare - 2740 / 185) > 1, String(k.avg_fare));
// The bug: 2500 / 2600km (which included telematics km) = 0.96. Truth: 2500/500 = 5.
check('revenue per km uses only the distance of priced trips', +k.revenue_per_km === 5, String(k.revenue_per_km));
check('priced km reported', +k.priced_km === 500, String(k.priced_km));
check('coverage of the money figures is stated', k.priced_pct === 27.1, String(k.priced_pct));

/* ── distance is over bookings, and only where it is plausible ───────────── */
check('distance covers bookings only', +k.km === 1100, String(k.km));
check('telematics distance is reported separately', +k.telematics_km === 2000, String(k.telematics_km));
// The cancelled trip has distance 0, which is not a distance.
check('a zero-distance trip is excluded from the distance average',
  k.trips_with_distance === 80, String(k.trips_with_distance));

/* ── driver attribution ──────────────────────────────────────────────────
   Telematics rows have no driver. "0 drivers" must never be implied for them. */
check('distinct drivers counted across the sources that name them', k.drivers === 8, String(k.drivers));
check('attributed trips counted', k.attributed_trips === 81, String(k.attributed_trips));
// Bolt writes a driver name but no driver id, so four bookings are unattributable.
check('unattributed bookings are visible in the coverage', k.attributed_pct === 95.3, String(k.attributed_pct));

/* ── completion over bookable trips only ─────────────────────────────────
   Telematics rows are hardcoded 'completed' by the collector and cannot be
   cancelled; including them padded both sides of the ratio. */
check('bookable trips exclude telematics', k.bookable_trips === 85, String(k.bookable_trips));
// 83 completed of 85: Bolt's 'finished' counts as completed, which the old
// literal `status = 'completed'` scored as a failure.
check('completion is over bookable trips', +k.completion_pct === 97.6, String(k.completion_pct));
// 2 of 85: Bolt's 'client_did_not_show' is a non-completion the old
// `ILIKE '%cancel%'` test missed entirely.
check('cancellation is over bookable trips', +k.cancel_pct === 2.4, String(k.cancel_pct));
check('completion and cancellation sum to 100', Math.abs(+k.completion_pct + +k.cancel_pct - 100) < 0.05);

/* ── the product dimension is platform-qualified ─────────────────────────── */
const prod = await get(`/api/mix?by=product&${W}`);
check('product labels carry their platform', prod.every((r) => /^(uber|hotel): /.test(r.label)),
  JSON.stringify(prod.map((r) => r.label)));
check('uber tiers and hotel booking types never share a label',
  !prod.some((r) => r.label === 'UberX' || r.label === 'hourly'), JSON.stringify(prod.map((r) => r.label)));
check('every product group names its platform', prod.every((r) => r.platform));
// The bug: hotel "hourly" (AED 200/trip) sat beside Uber "UberX" (no fare at
// all, so AED 0) and the view concluded one earned several times the other.
const uberTiers = prod.filter((r) => r.platform === 'uber');
check('uber tiers report no revenue, because the report carries no fare',
  uberTiers.every((r) => r.revenue === null && r.revenue_per_trip === null),
  JSON.stringify(uberTiers.map((r) => [r.label, r.revenue])));
const hourly = prod.find((r) => r.label === 'hotel: hourly');
check('hotel per-trip revenue is over its own priced trips', hourly && hourly.revenue_per_trip === 200,
  JSON.stringify(hourly));
check('hotel revenue per km is over its own priced distance', hourly && hourly.revenue_per_km === 8,
  JSON.stringify(hourly));

/* ── unlabelled rows are not a category ──────────────────────────────────── */
const pay = await get(`/api/mix?by=payment&${W}`);
check('payment mix has no "unknown" bucket', !pay.some((r) => r.label == null || r.label === 'unknown'),
  JSON.stringify(pay.map((r) => r.label)));
check('payment mix counts only trips the provider labelled',
  pay.reduce((a, r) => a + r.n, 0) === 81, String(pay.reduce((a, r) => a + r.n, 0)));

const detail = await get(`/api/mix/detail?by=payment&${W}`);
check('the unlabelled count is still reported', detail.unlabelled_trips === 4, String(detail.unlabelled_trips));
check('the sources responsible for unlabelled rows are named',
  detail.unlabelled_platforms.includes('bolt'), JSON.stringify(detail.unlabelled_platforms));
check('the dimension says whether it may be read across platforms',
  detail.per_platform === false, String(detail.per_platform));
const pdetail = await get(`/api/mix/detail?by=product&${W}`);
check('product declares itself platform-specific', pdetail.per_platform === true, String(pdetail.per_platform));

/* ── no ratio can be Infinity or NaN ─────────────────────────────────────── */
const finite = (v) => v === null || (typeof v === 'number' ? Number.isFinite(v) : Number.isFinite(+v));
check('no kpi value is NaN or Infinity', Object.values(k).every((v) => typeof v !== 'number' || Number.isFinite(v)),
  JSON.stringify(Object.entries(k).filter(([, v]) => typeof v === 'number' && !Number.isFinite(v))));
check('no mix ratio is NaN or Infinity',
  prod.every((r) => finite(r.revenue_per_trip) && finite(r.revenue_per_km)));

/* ── an empty window must not fabricate ratios ───────────────────────────── */
const empty = await get('/api/kpis?from=2025-01-01&to=2025-01-31');
check('an empty window reports zero trips', empty.trips === 0, String(empty.trips));
check('an empty window has no average fare rather than zero', empty.avg_fare === null, String(empty.avg_fare));
check('an empty window has no completion percentage', empty.completion_pct === null, String(empty.completion_pct));
check('an empty window has no coverage percentage', empty.priced_pct === null, String(empty.priced_pct));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
