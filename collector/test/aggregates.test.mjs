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
import { seedFleet } from './fixture.mjs';
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
  /* The window aggregates ride on the rows, and so does the statement-cash
     join added beside the booking figure — neither belongs in a comparison
     with the query that had neither. */
  const strip = (rs) => rs.map(({ _drivers, _cash_trips, _priced, _value, _stmt_cash,
    _stmt_drivers, _nk, _name_rows, _name_rn, statement_cash, statement_days, ...r }) => r);
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

/* ── the two endpoints that read a whole year to answer one question ───────
   /api/geo/corridors declared three awaits and ran five aggregations of the
   same window, each one splitting the same address strings apart again to
   build its group key; /api/tiers/mix grouped on two view expressions the
   planner keeps no statistics for and sorted every Uber trip in the window
   through a temp file to produce twenty rows.

   Both rewrites have to answer exactly what the originals answered, so the
   check is the old SQL against the live endpoint rather than a restatement of
   what the new one is supposed to produce. The old side is written out here
   because it is frozen; the new side is reached over HTTP through the handler
   that ships, so no copy of it can drift.

   Three fleets, because the two default fixtures work one corridor between two
   areas and would hide every folding question this endpoint has: an address
   with no community segment in it, a trip that names a drop-off and no pickup,
   a corridor seen twice rather than three times, and a fleet working more
   corridors than the page is allowed to show. */
{
  const AREA = (c) => `nullif(btrim(split_part(${c}, ' - ', 2)), '')`;
  /* is_booking, because the endpoint counts DEMAND. It used to count raw
     trips, so FMS telematics rows — the tracker's own record of journeys the
     ride platforms already reported — were charted as corridors: at days=7 on
     the live fleet, FMS alone supplied 187 of the 302 "corridors seen 3+
     times". The snapshot carries the predicate so this stays a check on the
     rewrite rather than on the predicate. */
  const FW = 'local_day BETWEEN $1::date AND $2::date AND is_booking'
    + ' AND ($3::text IS NULL OR platform=$3)'
    + ' AND ($4::text IS NULL OR fleet_id=$4)';
  const P = ['2026-08-01', '2026-08-31', null, null];
  const W = 'from=2026-08-01&to=2026-08-31';

  /* The five passes and the JS that assembled them, as they stood. */
  const corridorsBefore = async (d) => {
    const qq = (t) => d.query(t, P).then((r) => r.rows);
    const rows = await qq(
      `SELECT coalesce(${AREA('pickup_addr')}, '(unrecorded)') AS from_area,
              coalesce(${AREA('dropoff_addr')}, '(unrecorded)') AS to_area,
              count(*)::int trips,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km,
              round(avg(duration_s)::numeric / 60, 1) avg_min,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced,
              round(avg(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::numeric, 2) avg_fare,
              array_agg(DISTINCT platform) platforms
       FROM trip_ext
       WHERE ${FW} AND (pickup_addr IS NOT NULL OR dropoff_addr IS NOT NULL)
       GROUP BY 1, 2 HAVING count(*) >= 3
       ORDER BY trips DESC LIMIT 120`);
    const origins = await qq(
      `SELECT coalesce(${AREA('pickup_addr')}, '(unrecorded)') AS area,
              count(*)::int trips,
              count(*) FILTER (WHERE local_hour BETWEEN 5 AND 9)::int morning,
              count(*) FILTER (WHERE local_hour BETWEEN 16 AND 21)::int evening,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km
       FROM trip_ext WHERE ${FW} AND pickup_addr IS NOT NULL
       GROUP BY 1 ORDER BY trips DESC LIMIT 60`);
    const [t] = await qq(
      `SELECT (SELECT count(*)::int FROM (
                 SELECT 1 FROM trip_ext WHERE ${FW} AND pickup_addr IS NOT NULL
                 GROUP BY ${AREA('pickup_addr')}, ${AREA('dropoff_addr')}
                 HAVING count(*) >= 3) g) AS corridors_3plus,
              (SELECT count(*)::int FROM (
                 SELECT 1 FROM trip_ext WHERE ${FW} AND pickup_addr IS NOT NULL
                 GROUP BY ${AREA('pickup_addr')}, ${AREA('dropoff_addr')}) g) AS corridors_all,
              (SELECT count(DISTINCT ${AREA('pickup_addr')})::int
                 FROM trip_ext WHERE ${FW} AND pickup_addr IS NOT NULL) AS origins_all`);
    const shown = rows.filter((r) => r.from_area !== '(unrecorded)' || r.to_area !== '(unrecorded)');
    return { corridors: shown, origins, totals: t, shown: shown.length,
      truncated: (t?.corridors_all ?? 0) > shown.length,
      origins_shown: origins.length,
      origins_truncated: (t?.origins_all ?? 0) > origins.length };
  };

  const DIM = { day: 'ext_local_day', daypart: 'daypart', dow: 'local_dow', hour: 'local_hour' };
  const mixBefore = (dim) => `SELECT ${dim} AS label, uber_tier AS tier, count(*)::int n,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km
       FROM trip_ext WHERE ${FW} AND platform = 'uber' AND uber_tier IS NOT NULL
       GROUP BY 1, 2 ORDER BY 1, n DESC`;

  /* ORDER BY trips DESC does not decide anything between two corridors of the
     same size, and never did — so the lists are compared as sets, and the
     order they came back in is checked separately as the sequence the sort key
     actually determines. */
  /* Fields the endpoint gained after this snapshot was frozen, projected out
     so the comparison stays about the rewrite. `complimentary` is the count
     the average fare excludes and `priced` did not, so the printed denominator
     was not the one the AED was divided by; `min_n` says how many rows carried
     a duration at all, which on the live fleet is zero on every corridor. */
  const ADDED = ['complimentary', 'min_n'];
  const trim = (r) => { const c = { ...r }; for (const k of ADDED) delete c[k]; return c; };
  const sorted = (a) => JSON.stringify([...a].map(trim)
    .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
  const bykey = (a, k) => JSON.stringify(a.map((r) => k.map((f) => r[f])));

  /* Addresses the seeded fleets do not carry. */
  const shapes = async (d) => {
    const A = ['01 Cluster E - Al Thanyah Fifth - Dubai - UAE', 'Marina Walk - Dubai Marina - Dubai - UAE',
      'Gate 4 - Al Barsha First - Dubai - UAE', 'Terminal 3 - Dubai Airport - Dubai - UAE',
      'PlainAddressNoDash', 'Villa - Jumeirah Second - Dubai - UAE'];
    const B = ['Office - Business Bay - Dubai - UAE', 'Mall - Al Wasl - Dubai - UAE',
      'NoDashHere', 'Tower - Dubai Airport - Dubai - UAE'];
    let i = 0;
    const add = (pickup, dropoff, o = {}) => d.query(
      `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
         requested_at, ended_at, distance_km, duration_s, status, product, payment_type, price,
         pickup_addr, dropoff_addr)
       VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING`,
      [o.platform ?? 'uber', `geo-${i++}`, 'L45240', 'u-khalid', 'Muhammad Khalid',
        `2026-08-12T${String(o.hour ?? 7).padStart(2, '0')}:15:00+04:00`,
        `2026-08-12T${String((o.hour ?? 7) + 1).padStart(2, '0')}:00:00+04:00`,
        o.km === undefined ? 12.5 : o.km, o.dur === undefined ? 1800 : o.dur,
        o.product ?? 'Comfort', o.pay ?? 'card', o.price === undefined ? 60 : o.price, pickup, dropoff]);
    for (let n = 0; n < 5; n++) await add(A[0], B[0], { hour: 6 + n, km: 10 + n, price: 40 + n });
    // no distance and no fare at all
    for (let n = 0; n < 4; n++) await add(A[1], B[1], { hour: 17, km: null, price: null, platform: 'yango' });
    // a distance too large to be a trip distance, and no duration
    for (let n = 0; n < 3; n++) await add(A[2], B[0], { hour: 20, km: 900, dur: null, platform: 'bolt' });
    // seen twice, which is under the cut the corridor list makes
    for (let n = 0; n < 2; n++) await add(A[3], B[3], { hour: 5, km: 0, price: 0, pay: 'foc-complimentary' });
    // neither address carries a community segment
    for (let n = 0; n < 4; n++) await add(A[4], B[2], { hour: 16, km: 7.25, platform: 'hotel', pay: 'room-charge' });
    // a drop-off with no pickup: a corridor out of nowhere, and no origin
    for (let n = 0; n < 3; n++) await add(null, B[1], { hour: 9, km: 3.5 });
    for (let n = 0; n < 3; n++) await add(A[5], null, { hour: 21, km: 30, price: null });
    for (let n = 0; n < 6; n++) await add(A[1], B[3], { hour: 8 + n, km: 22.4, price: 130, platform: 'hotel' });
  };

  /* More corridors and more pickup areas than the page may show, each a
     different size, so which rows survive the cap is decided rather than
     arbitrary. */
  const overflowing = (d) => d.exec(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, distance_km,
       duration_s, status, product, payment_type, price, pickup_addr, dropoff_addr)
     SELECT 'uber', 'many-' || i || '-' || j, 'ecosine', 'L45240',
            timestamptz '2026-08-10 04:00:00+04' + ((j % 18) * interval '1 hour'),
            timestamptz '2026-08-10 05:00:00+04' + ((j % 18) * interval '1 hour'),
            5 + (j % 20), 900 + j, 'completed', 'Comfort', 'card', 30 + j,
            'Plot - Origin ' || i || ' - Dubai - UAE',
            'Unit - Dest ' || (i % 9) || ' - Dubai - UAE'
     FROM generate_series(1, 130) i, generate_series(1, 9 + i) j`);

  const fleets = [
    ['the seeded fleet', async (d) => { await seedFleet(d); await shapes(d); }],
    ['the wide fleet', async (d) => { await seedFleet(d, { wide: true }); await shapes(d); }],
    ['a fleet working more corridors than the page shows', async (d) => { await seedFleet(d); await overflowing(d); }],
  ];

  for (const [name, build] of fleets) {
    console.log(`\ncorridors and tier mix are unchanged over ${name}`);
    const d = new PGlite();
    await applySchema(d);
    await build(d);
    const { get: gg, server: srv } = await mountAll(d, { serverRoutes: false });

    const before = await corridorsBefore(d);
    const after = (await gg(`/api/geo/corridors?${W}`)).body;
    check('the same corridors, whatever order the ties fell in',
      sorted(before.corridors) === sorted(after.corridors),
      `${before.corridors.length} vs ${after.corridors.length}`);
    check('in the same order by size',
      bykey(before.corridors, ['trips']) === bykey(after.corridors, ['trips']));
    check('the same pickup areas', sorted(before.origins) === sorted(after.origins),
      `${before.origins.length} vs ${after.origins.length}`);
    check('in the same order by size',
      bykey(before.origins, ['trips']) === bykey(after.origins, ['trips']));
    /* The tiles the SPLIT was about, compared key by key rather than as a
       whole object. This was JSON.stringify equality, and it failed the moment
       the endpoint gained pickups_all / pickups_named — two fields the split
       does not touch and the page needed so its four shares could stop using
       three different denominators. A test that pins the exact SHAPE of a
       response forbids adding a field to it, which is not what this check is
       about: it is about the three counts being computed over every corridor
       rather than over the truncated list. */
    const tileKeys = ['corridors_3plus', 'corridors_all', 'origins_all'];
    const tiles = (o) => JSON.stringify(Object.fromEntries(tileKeys.map((k) => [k, o[k]])));
    check('the same tiles, counted over every corridor rather than the list',
      tiles(before.totals) === tiles(after.totals),
      `${tiles(before.totals)} vs ${tiles(after.totals)}`);
    /* And the new pair is present and sane wherever it is measured: every
       pickup is at least the pickups that carry an area. */
    check('the pickup denominators are returned and consistent',
      Number.isInteger(after.totals.pickups_all) && Number.isInteger(after.totals.pickups_named)
      && after.totals.pickups_all >= after.totals.pickups_named,
      JSON.stringify(after.totals));
    check('and the same answer about whether either list was cut',
      before.shown === after.shown && before.truncated === after.truncated
      && before.origins_shown === after.origins_shown
      && before.origins_truncated === after.origins_truncated,
      `${JSON.stringify([before.shown, before.truncated, before.origins_shown, before.origins_truncated])}`
      + ` vs ${JSON.stringify([after.shown, after.truncated, after.origins_shown, after.origins_truncated])}`);

    for (const by of ['daypart', 'day', 'dow', 'hour']) {
      const was = await d.query(mixBefore(DIM[by]), P).then((r) => r.rows);
      const is = (await gg(`/api/tiers/mix?${W}&by=${by}`)).body;
      check(`the tier mix by ${by} is the same rows in the same order by size`,
        sorted(was) === sorted(is) && bykey(was, ['label', 'n']) === bykey(is, ['label', 'n']),
        `${was.length} vs ${is.length}`);
    }
    srv.close();
    await d.close();
  }

  /* The point of the rewrite, stated where it can fail. */
  console.log('\nneither endpoint reads the trip table more than once');
  const routes = readFileSync('api/analytics_routes.js', 'utf8');
  const bodyOf = (route) => {
    const at = routes.indexOf(`app.get('${route}'`);
    return routes.slice(at, routes.indexOf("\n  app.get('", at + 10));
  };
  /* The SQL rather than the whole handler: the prose above each of these names
     the expression it stopped using, and a check that reads the comment is a
     check that fails on its own explanation. */
  const sqlOf = (route) => {
    const body = bodyOf(route);
    return body.slice(body.indexOf('`WITH'), body.lastIndexOf('`'));
  };
  const corridorSql = sqlOf('/api/geo/corridors');
  check('the corridors page names trip_ext once',
    (corridorSql.match(/FROM trip_ext/g) || []).length === 1,
    `${(corridorSql.match(/FROM trip_ext/g) || []).length} scans`);
  check('and asks the database for it once',
    (bodyOf('/api/geo/corridors').match(/await q\(/g) || []).length === 1,
    `${(bodyOf('/api/geo/corridors').match(/await q\(/g) || []).length} statements`);
  const mixSql = sqlOf('/api/tiers/mix');
  check('the tier mix groups on the column rather than the view expression',
    !/uber_tier/.test(mixSql) && /product AS tier/.test(mixSql),
    'uber_tier is back as a grouping key, and the planner cannot cost it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
