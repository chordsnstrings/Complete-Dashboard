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
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { custodyOverWindow, custodyCountOverWindow } from '../api/custody_sql.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

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
   when the shipped SQL drifts. The helper injection comes from test/mount.mjs
   for the same reason: this file used to name its own six helpers, and broke
   the day a route it slices started using a seventh — with a ReferenceError
   from inside an eval, a long way from the line that caused it. */
const src = readFileSync('api/server.js', 'utf8');
const slice = (from, to) => src.slice(src.indexOf(from), src.indexOf(to));
const { mountSource, server, get: rawGet } = await mountAll(db, { serverRoutes: false });
mountSource(slice("app.get('/api/kpis'", "app.get('/api/trips/daily'")
  + slice('/* Breakdown by one dimension.', '/* ───────────────────────── drivers ───────────────────────── */'));
const get = async (p) => (await rawGet(p)).body;

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
console.log('\nproduct-by-vehicle resolves custody once per plate');

/* Both custody columns were correlated subqueries in the select list, so they
   ran once per output ROW — up to six hundred rows, twice, each grouping
   vehicle_driver_day again. At a ninety-day window that stopped being slow and
   became a 500: the statement hit the pool timeout and the page showed nothing.

   The rewrite has to return exactly what the subqueries did, so the check is
   the old form against the new one on the same fixture, rather than a
   restatement of what the new one is supposed to produce. The new SQL is read
   from the shipped source; a copy in this file would drift and stop testing
   anything. */
{
  const F2 = "t.local_day BETWEEN $1::date AND $2::date"
    + " AND ($3::text IS NULL OR t.platform=$3) AND ($4::text IS NULL OR t.fleet_id=$4)";
  const oldSql = `SELECT t.plate, t.product, count(*)::int trips,
        round(sum(t.distance_km)::numeric,0) km, round(avg(t.distance_km)::numeric,1) avg_km,
        ${custodyOverWindow('t.plate')} AS driver_refs,
        ${custodyCountOverWindow('t.plate')} AS driver_n
   FROM trip_norm t WHERE ${F2} AND t.plate IS NOT NULL AND t.product IS NOT NULL
   GROUP BY t.plate, t.product ORDER BY t.plate, trips DESC LIMIT 600`;

  const serverSrc = readFileSync('api/server.js', 'utf8');
  const at = serverSrc.indexOf("app.get('/api/product/by-vehicle'");
  let newSql = serverSrc.slice(serverSrc.indexOf('`WITH agg AS (', at) + 1);
  newSql = newSql.slice(0, newSql.indexOf('`, range(req)')).replace('${F}', F2);

  const P = ['2026-08-01', '2026-08-31', null, null];
  const before = (await db.query(oldSql, P)).rows;
  const after = (await db.query(newSql, P)).rows;
  check('the rewrite returns the same number of rows',
    before.length === after.length && before.length > 0, `${before.length} vs ${after.length}`);
  check('and the same values in the same order',
    JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify(after.slice(0, 1)));
  check('custody is resolved in one pass, not per row',
    !/custodyOverWindow|custodyCountOverWindow/.test(
      serverSrc.slice(at, serverSrc.indexOf('range(req)', at))),
    'a correlated subquery is back in the select list');
}

console.log('\ncash exposure aggregates the window once');

/* The Settlement page's cash panel asked the same question of the same window
   twice: one statement for the two hundred drivers it lists, and a second one
   for the totals underneath them — which scanned trip_ext for the sums and
   grouped it a third time, nested inside itself, for the driver count. Cold at
   a wide window that pair took about thirty-five seconds.

   The rewrite has to answer exactly what those two statements answered, so the
   check is the OLD pair against the NEW single statement over the same rows,
   rather than a restatement of what the new one is supposed to produce. The
   new SQL is read from the shipped source; a copy in this file would drift and
   stop testing anything.

   On its own database, because "the same rows in the same order" only means
   something when the order is a total one. The fixture above ties five cash
   drivers on four trips each, and two statements that reach the same rows by
   different plans are free to break a tie differently — so every holder here
   holds a different number of trips. */
{
  const cdb = new PGlite();
  await applySchema(cdb);
  const cq = (t, prm = []) => cdb.query(t, prm).then((r) => r.rows);
  let cn = 0;
  const cash = (o) => cq(
    `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
                       requested_at,status,payment_type,price)
     VALUES ($1,$2,'ecosine',$3,$4,$5,$6,'completed',$7,$8)`,
    [o.platform, `c${cn++}`, o.plate ?? null, o.ext ?? null, o.name ?? null,
     `2026-${o.month ?? '08'}-${String(o.day).padStart(2, '0')}T10:00:00+04:00`,
     o.pay, o.price ?? null]);

  /* Seven holders, seven different trip counts, and between them every shape
     the panel has to survive: a channel that prices its cash rides and one
     that does not, a driver with no name at all, and one human appearing both
     with a platform id and without one — which is two rows on the page and
     therefore has to be two in the count above it. */
  const holders = [
    { name: 'Cash Nine', ext: 'h9', platform: 'hotel', pay: 'cash-driver', price: 90, n: 9 },
    { name: 'Cash Eight', ext: 'h8', platform: 'hotel', pay: 'cash', price: 40, n: 8 },
    { name: 'Cash Seven', ext: 'u7', platform: 'uber', pay: 'cash-driver', price: null, n: 7 },
    { name: 'Cash Six', ext: null, platform: 'yango', pay: 'cash', price: 25, n: 6 },
    { name: 'Cash Six', ext: 'y6', platform: 'yango', pay: 'cash', price: null, n: 5 },
    { name: null, ext: 'u4', platform: 'uber', pay: 'cash-driver', price: 12.5, n: 4 },
    { name: 'Cash Three', ext: 'u3', platform: 'uber', pay: 'cash', price: null, n: 3 },
  ];
  for (const h of holders) {
    for (let i = 0; i < h.n; i++) {
      await cash({ ...h, plate: `P${h.n}`, day: 1 + (i % 20) });
    }
  }
  /* Rows the panel must not count, one for each way it could: a supervisor
     took the money so no driver is holding it, a card fare, a telematics
     journey of the same trip, and a cash ride outside the window. */
  await cash({ name: 'Not Holding', ext: 's1', platform: 'hotel', pay: 'cash-supervisor', price: 70, day: 4 });
  await cash({ name: 'Not Holding', ext: 's1', platform: 'hotel', pay: 'card', price: 70, day: 4 });
  await cash({ name: 'Tracker', ext: 't1', platform: 'fms', pay: 'cash', price: null, day: 4 });
  await cash({ name: 'Cash Nine', ext: 'h9', platform: 'hotel', pay: 'cash-driver', price: 90, day: 4, month: '07' });

  const FB2 = 'local_day BETWEEN $1::date AND $2::date'
    + ' AND ($3::text IS NULL OR platform=$3)'
    + ' AND ($4::text IS NULL OR fleet_id=$4) AND is_booking';
  /* The retired pair, spelled out here because it no longer exists anywhere
     to be read from. */
  const oldRows = `SELECT coalesce(driver_name, '(unnamed)') driver_name, driver_ext_id,
              count(*)::int cash_trips,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced_cash_trips,
              sum(price) AS cash_value,
              array_agg(DISTINCT platform) platforms,
              array_remove(array_agg(DISTINCT plate), NULL) plates,
              max(requested_at) last_cash_trip
       FROM trip_ext
       WHERE ${FB2} AND driver_holds_cash
       GROUP BY 1, 2 ORDER BY cash_trips DESC LIMIT 200`;
  const oldTotals = `SELECT (SELECT count(*)::int FROM (
                 SELECT 1 FROM trip_ext WHERE ${FB2} AND driver_holds_cash
                 GROUP BY coalesce(driver_name, '(unnamed)'), driver_ext_id) g) AS drivers,
              count(*)::int cash_trips,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced,
              sum(price) AS value
       FROM trip_ext WHERE ${FB2} AND driver_holds_cash`;

  const analyticsSrc = readFileSync('api/analytics_routes.js', 'utf8');
  const cashAt = analyticsSrc.indexOf("app.get('/api/settlement/cash-exposure'");
  let newSql = analyticsSrc.slice(analyticsSrc.indexOf('`WITH holders AS (', cashAt) + 1);
  newSql = newSql.slice(0, newSql.indexOf('`, p)')).replace('${FB}', FB2);

  const P = ['2026-08-01', '2026-08-31', null, null];
  const strip = (rs) => rs.map(({ _drivers, _cash_trips, _priced, _value, ...r }) => r);
  const before = await cq(oldRows, P);
  const [beforeT] = await cq(oldTotals, P);
  const after = await cq(newSql, P);

  check('the rewrite returns the same number of holders',
    before.length === after.length && before.length === 7, `${before.length} vs ${after.length}`);
  check('and the same values in the same order',
    JSON.stringify(before) === JSON.stringify(strip(after)),
    JSON.stringify(strip(after).slice(0, 1)));
  check('a supervisor-collected fare is still not a driver holding cash',
    !JSON.stringify(after).includes('Not Holding'));
  check('a telematics journey is still not a booking',
    !JSON.stringify(after).includes('Tracker'));
  check('one human with two ids is two rows and two holders',
    after.filter((r) => r.driver_name === 'Cash Six').length === 2
      && after[0]._drivers === 7, String(after[0]?._drivers));
  check('the totals the second statement used to fetch now ride on the rows',
    after[0]._cash_trips === beforeT.cash_trips && after[0]._priced === beforeT.priced
      && Number(after[0]._value) === Number(beforeT.value),
    `${after[0]._cash_trips}/${after[0]._priced}/${after[0]._value} vs `
      + `${beforeT.cash_trips}/${beforeT.priced}/${beforeT.value}`);

  /* And the reason the totals are worth carrying at all: past two hundred
     holders the page is a truncation of the fleet, and a cash figure summed
     over what it happens to show understates the money by exactly the tail. */
  await cdb.exec(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,
                                    driver_name,requested_at,status,payment_type,price)
    SELECT 'uber', 'tail' || i, 'ecosine', 'L900', 'tail' || i, 'Tail Driver ' || i,
           '2026-08-15T10:00:00+04:00'::timestamptz, 'completed', 'cash-driver',
           CASE WHEN i % 7 = 0 THEN 33.00 END
      FROM generate_series(1, 210) i`);
  const [wideT] = await cq(oldTotals, P);
  const wide = await cq(newSql, P);
  const pageTrips = wide.reduce((a, r) => a + r.cash_trips, 0);

  check('the page is capped at two hundred holders', wide.length === 200, String(wide.length));
  check('the holder count is the whole population, not the page',
    wide[0]._drivers === 217 && wide[0]._drivers === wideT.drivers,
    `${wide[0]._drivers} vs ${wideT.drivers}`);
  check('the cash total is the whole population, not the page',
    wide[0]._cash_trips === wideT.cash_trips && wide[0]._cash_trips > pageTrips,
    `${wide[0]._cash_trips} vs ${wideT.cash_trips}, page ${pageTrips}`);
  check('and so is the money the fleet is holding',
    Number(wide[0]._value) === Number(wideT.value),
    `${wide[0]._value} vs ${wideT.value}`);
  check('the window is aggregated once, not three times',
    (analyticsSrc.slice(cashAt, analyticsSrc.indexOf('res.json(', cashAt)).match(/await q\(/g) || []).length === 1,
    'a second pass over the same window is back');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
