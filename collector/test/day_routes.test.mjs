/* One day, and the sentence that has to come before its numbers.
   ──────────────────────────────────────────────────────────────────────────
   A day page is where the collection-gap problem bites hardest: a quiet
   Tuesday and a Tuesday nobody fetched produce identical charts, and every
   figure on the page is computed over whatever landed. So the first thing this
   endpoint must get right is not a total — it is whether each source that
   normally reports actually reported.

   The rest is the shape that has broken every other page in this product:
   telematics twins added to bookings, money divided by rows that carry no
   money, and a Dubai day that is not a UTC day. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { dayRoutes } from '../api/day_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,
     distance_km,status,product,payment_type,price,pickup_addr,dropoff_addr)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [o.platform, `d${n++}`, o.plate ?? null, o.drv ?? null, o.name ?? null, o.at,
   o.km ?? null, o.status ?? 'completed', o.product ?? null, o.pay ?? null, o.price ?? null,
   '12 Cluster E - Al Thanyah Fifth - Dubai - UAE', 'T3 - Dubai Airport - Dubai - UAE']);

const DAY = '2026-08-14';
// 40 Uber bookings on the Dubai day, including two that straddle midnight in
// UTC terms — 00:30 and 23:30 Dubai are 20:30 the previous UTC day and 19:30
// the same UTC day, and a UTC grouping puts them on different days.
for (let i = 0; i < 38; i++) {
  await trip({ platform: 'uber', plate: `L${100 + (i % 4)}`, drv: `u${i % 5}`, name: `Driver ${i % 5}`,
    at: `${DAY}T${String(6 + (i % 14)).padStart(2, '0')}:10:00+04:00`, km: 12,
    pay: ['braintree', 'cash'][i % 2], product: ['UberX', 'Black'][i % 2] });
}
await trip({ platform: 'uber', plate: 'L100', drv: 'u0', name: 'Driver 0',
  at: `${DAY}T00:30:00+04:00`, km: 9, pay: 'cash', product: 'UberX' });
await trip({ platform: 'uber', plate: 'L100', drv: 'u0', name: 'Driver 0',
  at: `${DAY}T23:30:00+04:00`, km: 9, pay: 'cash', product: 'UberX' });
// One cancelled.
await trip({ platform: 'uber', plate: 'L101', drv: 'u1', name: 'Driver 1',
  at: `${DAY}T10:00:00+04:00`, km: 0, status: 'rider_cancelled', product: 'UberX' });
// 40 FMS telematics twins of the same journeys.
for (let i = 0; i < 40; i++) {
  await trip({ platform: 'fms', plate: `L${100 + (i % 4)}`, at: `${DAY}T${String(6 + (i % 14)).padStart(2, '0')}:14:00+04:00`, km: 13 });
}
// 5 hotel bookings, the only ones with a fare.
for (let i = 0; i < 5; i++) {
  await trip({ platform: 'hotel', plate: 'L102', drv: 'h1', name: 'Hotel Driver',
    at: `${DAY}T${String(9 + i).padStart(2, '0')}:00:00+04:00`, km: 20, price: 100, pay: 'room-charge',
    product: 'pick_and_drop' });
}
// A trip the day BEFORE and the day after, which must not appear.
await trip({ platform: 'uber', plate: 'L100', drv: 'u0', name: 'Driver 0', at: '2026-08-13T23:00:00+04:00', km: 5 });
await trip({ platform: 'uber', plate: 'L100', drv: 'u0', name: 'Driver 0', at: '2026-08-15T00:30:00+04:00', km: 5 });

await q(`INSERT INTO alert (platform, external_id, plate, fleet_id, alert_type, occurred_at)
         VALUES ('fms','a1','L100','ecosine','Harsh Brake', $1),
                ('fms','a2','L100','ecosine','Harsh Brake', $2),
                ('fms','a3','L101','ecosine','Harsh Acceleration', $3),
                ('fms','a4','L101','ecosine','Harsh Brake', '2026-08-13T12:00:00+04:00')`,
  [`${DAY}T08:00:00+04:00`, `${DAY}T09:00:00+04:00`, `${DAY}T23:50:00+04:00`]);

await q(`INSERT INTO occupancy_segment (plate, fleet_id, started_at, ended_at, duration_min,
           distance_km, verdict, verdict_reason)
         VALUES ('L103','ecosine',$1,$2,26,18.4,'unauthorized','no completed booking overlaps'),
                ('L102','ecosine',$3,$4,17,6.1,'stationary','the vehicle did not travel far enough')`,
  [`${DAY}T05:38:00+04:00`, `${DAY}T06:04:00+04:00`, `${DAY}T11:02:00+04:00`, `${DAY}T11:19:00+04:00`]);

await q(`INSERT INTO weather_daily (day, temp_max, temp_min, precipitation) VALUES ($1, 41.2, 32.8, 0)`, [DAY]);
await q(`INSERT INTO calendar_day (day, hijri_month, is_ramadan, is_holiday) VALUES ($1,'Safar',false,false)`, [DAY]);

// Neighbouring days, so the comparison has something to compare against.
for (let d = 7; d <= 21; d++) {
  if (d === 14) continue;
  for (let i = 0; i < 50; i++) {
    await trip({ platform: 'uber', plate: 'L100', drv: 'u0', name: 'Driver 0',
      at: `2026-08-${String(d).padStart(2, '0')}T12:00:00+04:00`, km: 10 });
  }
}

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
dayRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

const d = await get(`/api/day?day=${DAY}`);

/* ── the Dubai day ────────────────────────────────────────────────────── */
check('a 00:30 Dubai booking belongs to this day, not the previous one',
  d.headline.bookings === 46, `${d.headline.bookings} bookings`);   // 38+2+1 uber + 5 hotel
check('the previous evening and the next morning are excluded',
  d.headline.bookings === 46);
check('the first and last booking span the Dubai day',
  new Date(d.headline.first_at).getTime() < new Date(d.headline.last_at).getTime());

/* ── the populations that must not be added ───────────────────────────── */
check('telematics journeys are reported separately from bookings',
  d.headline.telematics === 40 && d.headline.bookings === 46,
  `${d.headline.bookings} / ${d.headline.telematics}`);
check('their distance is separate too',
  d.headline.booked_km !== d.headline.telematics_km
  && d.headline.telematics_km === 520, String(d.headline.telematics_km));

/* ── money over the rows that carry money ─────────────────────────────── */
check('revenue is the fares that exist', d.headline.revenue === 500, String(d.headline.revenue));
check('the average fare divides by priced bookings, not by all of them',
  d.headline.avg_fare === 100, String(d.headline.avg_fare));
check('completion is over bookable rows only',
  d.headline.completion_pct === 97.8, String(d.headline.completion_pct));

/* ── the sentence before the numbers ──────────────────────────────────── */
{
  /* Yango reports on both sides of the 14th and nothing on the day itself.
     Both halves matter: a source with history only BEFORE the day has no
     history there, and saying it "collected nothing" would be a false
     accusation — which is why the endpoint checks the day is inside the
     source's own span first. */
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,requested_at,status,price)
           SELECT 'yango','y'||g,'ecosine','L104',
                  ('2026-08-' || lpad((CASE WHEN g <= 15 THEN 10 + (g % 3)
                                            ELSE 17 + (g % 3) END)::text,2,'0')
                   || 'T12:00:00+04:00')::timestamptz,
                  'completed', 30 FROM generate_series(1,30) g`);
  const d2 = await get(`/api/day?day=${DAY}`);
  const silent = d2.collection.silent.map((s) => s.source);
  check('a source that normally reports and reported nothing is named',
    silent.includes('yango'), JSON.stringify(d2.collection.silent));
  check('the warning says every figure on the page is understated',
    /understated/.test(d2.collection.warning || ''), d2.collection.warning);
  check('a source that DID report is not accused of silence',
    !silent.includes('uber') && !silent.includes('fms'), silent.join(','));
  check('coverage says whether the day is even inside a source’s history',
    d2.coverage.every((c) => typeof c.inside_span === 'boolean'));

  /* And the other half of that rule: a source whose history does not reach
     this day is NOT accused of having collected nothing. */
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,requested_at,status)
           SELECT 'bolt','b'||g,'ecosine','L105',
                  ('2026-08-' || lpad((19 + (g % 3))::text,2,'0') || 'T12:00:00+04:00')::timestamptz,
                  'finished' FROM generate_series(1,30) g`);
  const d3 = await get(`/api/day?day=${DAY}`);
  check('a source whose history starts after this day is not accused of silence',
    !d3.collection.silent.map((s2) => s2.source).includes('bolt'),
    JSON.stringify(d3.collection.silent));
  check('but it is still listed, marked as having no history here',
    d3.coverage.some((c) => c.source === 'bolt' && c.inside_span === false),
    JSON.stringify(d3.coverage.map((c) => [c.source, c.inside_span])));
}

/* ── everything else the day consisted of ─────────────────────────────── */
check('the hour profile covers only hours with activity',
  d.hours.length > 0 && d.hours.every((h) => h.hour >= 0 && h.hour <= 23));
check('a cancelled booking shows in its own hour', d.hours.some((h) => h.cancelled > 0));
check('platforms are split with their own completion rate',
  d.platforms.find((p) => p.platform === 'hotel').completion_pct === 100);
check('drivers are listed with the vehicles they used',
  d.drivers.length > 0 && d.drivers[0].plates.length > 0);
check('a driver’s first and last trip bound their day',
  d.drivers.every((x) => !x.first_trip || !x.last_trip
    || new Date(x.first_trip) <= new Date(x.last_trip)));
check('vehicles show bookings and telematics side by side, never summed',
  d.vehicles.every((v) => v.bookings + v.telematics >= v.bookings));
check('only alerts inside the Dubai day are counted',
  d.alerts.reduce((a, x) => a + x.n, 0) === 3,
  String(d.alerts.reduce((a, x) => a + x.n, 0)));
check('a 23:50 alert is inside the day, not the next one',
  d.alerts.some((a) => a.alert_type === 'Harsh Acceleration'));
check('unexplained occupancy is shown with the reason, accusation first',
  d.segments[0].verdict === 'unauthorized' && !!d.segments[0].verdict_reason);
check('a stationary segment is included but not ranked as an accusation',
  d.segments.some((s) => s.verdict === 'stationary'));
check('weather and calendar are carried', d.context.temp_max === 41.2 && d.context.hijri_month === 'Safar');
check('corridors are parsed to the community', d.corridors[0].to_area === 'Dubai Airport');

/* ── against its neighbours ───────────────────────────────────────────── */
check('the day is compared against the fortnight around it',
  d.versus_neighbours.median_bookings === 50, String(d.versus_neighbours.median_bookings));
check('the comparison excludes the day itself',
  d.versus_neighbours.series.length >= 14);
check('the delta is signed the way a reader expects',
  d.versus_neighbours.delta_pct < 0 === (d.headline.bookings < d.versus_neighbours.median_bookings));

/* ── and the neighbour labels are days, not Date.toString() prefixes ──────
   The series came back as `String(local_day).slice(0, 10)` over a bare DATE
   column, which node-postgres parses into a JS Date — so every label was
   "Sun Aug 16", not "2026-08-16". Measured on production 2026-09-02, that cost
   three things at once, and each is checked below: the self-exclusion at the
   median silently matched nothing (2026-06-15 published a median of 325 and
   -25.8% against a true 354 and -31.9%, which is the difference between an
   amber Bookings tile and a red one at api/public/day.js's -30 threshold); the
   subject bar could never be highlighted, under a caption saying it was; and
   every bar linked to #day/Sun%20Aug%2016, which this same endpoint answers
   400 for.

   The fortnight above cannot catch the median half — its neighbours are all
   50, so including the day or not gives 50 either way, which is exactly why it
   read clean. This fixture is built so the two answers differ: seven days at
   10, the subject day at 1, seven days at 20. Over the fourteen true
   neighbours the median is 20; let the day itself back in and it is 10. */
{
  const S = '2026-03-15';
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, status)
           SELECT 'uber', 'nb' || d || '-' || i, 'ecosine', 'L100',
                  ('2026-03-' || lpad(d::text, 2, '0') || 'T12:00:00+04:00')::timestamptz,
                  'completed'
           FROM generate_series(8, 22) d,
                generate_series(1, CASE WHEN d = 15 THEN 1
                                        WHEN d < 15 THEN 10 ELSE 20 END) i`);
  const sub = await get(`/api/day?day=${S}`);
  const vs = sub.versus_neighbours;

  check('every neighbour day is an ISO day, not a weekday label',
    vs.series.length === 15 && vs.series.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.day)),
    JSON.stringify(vs.series.map((r) => r.day)));
  check('the fortnight is the fortnight around the day, in order',
    vs.series[0].day === '2026-03-08' && vs.series[14].day === '2026-03-22',
    `${vs.series[0].day}..${vs.series[14].day}`);

  /* api/public/day.js colours the bar with `r.day === day` and links it with
     href('day', r.day). Both compare against the ISO day this endpoint echoes
     back, so if no bar matches it, the chart has no highlight and the caption
     under it is false. */
  check('the day under inspection is findable among its own neighbours',
    vs.series.filter((r) => r.day === sub.day).length === 1,
    `no bar equals ${sub.day}`);

  check('the median excludes the day itself: 20 over fourteen, not 10 over fifteen',
    vs.median_bookings === 20, String(vs.median_bookings));
  check('so the delta is measured against the neighbours alone',
    sub.headline.bookings === 1 && vs.delta_pct === -95, `${sub.headline.bookings} / ${vs.delta_pct}`);

  /* Every bar is a link. #day/Sun%20Aug%2016 reached this endpoint as
     ?day=Sun%20Aug%2016 and got a 400 — fifteen dead links per page. */
  const codes = await Promise.all(vs.series.map(async (r) =>
    (await fetch(`http://127.0.0.1:${port}/api/day?day=${encodeURIComponent(r.day)}`)).status));
  check('every bar in the chart is an address this endpoint accepts',
    codes.every((c) => c === 200), JSON.stringify(codes));

  /* The form itself, so it cannot come back by a different route. A DATE
     column reaching String() is the whole bug; api/public is exempt because
     values arrive there as JSON strings, but nothing on the server side here
     may do it. */
  const code = readFileSync('api/day_routes.js', 'utf8')
    // Comments only, so the note that QUOTES the broken expression in order to
    // explain it does not read as the expression coming back.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('no Date is turned into a day by String().slice() in this route',
    !/String\([^)]*\)\s*\.slice\(\s*0\s*,\s*10\s*\)/.test(code),
    'a pg DATE through String() is "Sun Aug 16"; use isoDay() or to_char in the SELECT');
}

/* ── a day that is not a day ──────────────────────────────────────────── */
for (const bad of ['banana', '2026-13-45', '', '2026-8-1', "2026-08-14'; DROP TABLE trip; --"]) {
  const r = await fetch(`http://127.0.0.1:${port}/api/day?day=${encodeURIComponent(bad)}`);
  check(`"${bad.slice(0, 20)}" is refused with a 400, not a 500`, r.status === 400, String(r.status));
}
check('the trip table survived', (await q('SELECT count(*)::int n FROM trip'))[0].n > 0);

/* ── an empty day is empty, not broken ────────────────────────────────── */
{
  const q1 = await get('/api/day?day=2026-01-01');
  check('a day with nothing in it returns zeroes rather than failing',
    q1.headline.bookings === 0 && q1.headline.telematics === 0);
  check('and does not invent an average fare', q1.headline.avg_fare === null);
  check('and does not invent a completion rate', q1.headline.completion_pct === null);
}

/* A day the platforms no longer answer for is not a day the fleet earned zero.
   ─────────────────────────────────────────────────────────────────────────
   driver_payout_day is built from the Uber earner breakdown, which reaches
   back about 192 days. Before that this page reported "no fare and no payout
   statement reaches this day" over days the operator had imported a statement
   for: /api/day?day=2025-09-01 answered accounted null and revenue null on
   production while driver_statement_day held AED 31,510.86 for that date
   across 138 rows. */
{
  const D = '2025-09-01';
  await q(`INSERT INTO driver_statement_day
             (platform, fleet_id, driver_name, day, source, net)
           VALUES ('uber','ecosine','Ann Ahmed','${D}','ledger', 500.25),
                  ('hotel','ecosine','Ann Ahmed','${D}','ledger', 120.00)`);
  const s = (await get(`/api/day?day=${D}`)).headline;
  /* THE FIELD MOVED, AND WHY IT MOVED IS THE POINT OF THE THIRD CHECK.
     ───────────────────────────────────────────────────────────────────────
     This route used to read the operator's workbook into `statement_net` on
     the stated grounds that the field "rides BESIDE the chosen basis and is
     never added into accounted". That held only while fleetIncome ignored the
     field. api/income_sql.js now counts a channel on its statement net, so the
     workbook would have BECOME the fleet's money on this page — and this test
     is what caught it, as "accounted 620.25 vs statement 620.25", the two
     numbers having quietly become one.

     The workbook keeps its job and gets its own name. What it must never be is
     the basis, and that is now structural rather than hoped for: the countable
     query reads source <> 'ledger'. */
  check('a day outside the payout horizon reports the imported statement',
    Number(s.ledger_net) === 620.25, JSON.stringify(s.ledger_net));
  check('and the countable statement excludes it entirely',
    s.statement_net == null || Number(s.statement_net) !== 620.25,
    `statement_net ${s.statement_net} — the workbook is reference data, never a basis`);
  check('so it is never folded into the platform figure',
    s.accounted == null || Number(s.accounted) !== Number(s.ledger_net),
    `accounted ${s.accounted} vs imported ${s.ledger_net}`);
  const routes = readFileSync('api/day_routes.js', 'utf8');
  check('…and the query that feeds the basis says so in SQL',
    /source <> 'ledger' AND net IS NOT NULL/.test(routes)
      && /source = 'ledger' AND net IS NOT NULL/.test(routes),
    'two queries, and only one of them may reach fleetIncome');
  const page = readFileSync('api/public/day.js', 'utf8');
  check('and the page shows it as its own labelled figure',
    /label: 'Imported statement'/.test(page),
    'a reader who cannot tell an operator import from a platform payout cannot reconcile either');
}

/* ── what today will be worth, and when we may not say ──────────────────────
   The defect this answers, measured on production: at 20:07 Dubai on
   2026-09-08 the day endpoint answered AED 2,874 of trip value over 664
   bookings, and AED 35,965 over 675 for the day before. 0 of the day's 596
   Uber bookings carried a price, because Uber publishes no fare on its trip
   export and the price lands on a weekly report walked overnight. The measured
   figure is correct and it is not an answer to "what did the fleet do today".

   Two things have to be true of the estimate that fills that gap: it may not
   exist when nothing settled backs it, and it must be per BOOKING rather than
   per priced booking, or it bills the fleet for its cancellations. */
{
  const before = await get(`/api/day?day=${DAY}`);
  /* 41 Uber bookings on the day carry no price, and every Uber day behind it
     in this fixture is unpriced too — so there is no rate, and the honest
     output is no estimate at all plus the count that could not be valued. */
  check('with no settled day behind it there is no estimate, and the bookings are named',
    before.headline.expected_revenue == null
      && before.headline.unrated_bookings === 41
      && (before.headline.unrated_platforms || []).includes('uber'),
    `expected ${before.headline.expected_revenue} · unrated ${before.headline.unrated_bookings}`);
  check('and the measured trip value is untouched by the absence',
    before.headline.revenue === 500, String(before.headline.revenue));

  /* Six settled Uber days inside the fourteen-day lookback: 100 bookings each,
     90 of them priced at AED 100. Per booking that is AED 90; per PRICED
     booking it is AED 100. The ten unpriced a day stand for the cancellations
     that take no fee, which is why the two differ and why only one of them is
     the right multiplier for a booking whose outcome is not known yet. */
  for (let d = 1; d <= 6; d++) {
    await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
               requested_at,distance_km,status,product,payment_type,price)
             SELECT 'uber','s${d}_'||g,'ecosine','L100','u0','Driver 0',
                    '2026-08-${String(d).padStart(2, '0')}T12:00:00+04:00'::timestamptz,
                    10,'completed','UberX','braintree',
                    CASE WHEN g <= 90 THEN 100 ELSE NULL END
               FROM generate_series(1,100) g`);
  }
  const after = await get(`/api/day?day=${DAY}`);
  const h = after.headline;
  const uber = (h.projection_parts || []).find((r) => r.platform === 'uber');

  check('the rate is what a BOOKING was worth, not what a priced booking was worth',
    uber && uber.per_booking === 90,
    `${uber && uber.per_booking} a booking — 100 is the priced-only rate, and it would `
    + 'bill the fleet for its cancellations');
  /* A HALF-COLLECTED DAY IS THE ONE THAT DOES THE DAMAGE, not an empty one.
     Days 7–13 hold 50 Uber bookings each with no price at all, and `priced > 0`
     alone is enough to keep those out. The dangerous shape is a day whose
     weekly report has begun to land and has not finished: 2026-08-13 is given
     150 Uber bookings with 10 of them priced, which is exactly what a day looks
     like the morning after a partial walk. Let into the rate it drops it from
     AED 90 to AED 73.24 a booking and every projection built on it is 19% low
     — so the rate takes a day only once half of that channel's bookings on it
     carry a fare. */
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
             requested_at,distance_km,status,product,payment_type,price)
           SELECT 'uber','half'||g,'ecosine','L100','u0','Driver 0',
                  '2026-08-13T12:00:00+04:00'::timestamptz,10,'completed','UberX','braintree',
                  CASE WHEN g <= 10 THEN 100 ELSE NULL END
             FROM generate_series(1,100) g`);
  const guarded = (await get(`/api/day?day=${DAY}`)).headline;
  const gUber = (guarded.projection_parts || []).find((r) => r.platform === 'uber');
  check('a half-collected day cannot enter the rate that values the next one',
    gUber && gUber.per_booking === 90 && gUber.days === 6,
    `${gUber && gUber.per_booking} a booking over ${gUber && gUber.days} days `
    + '— 73.24 over 7 is the figure a partly walked 13 August would produce');

  check('the 41 unpriced bookings are projected at that rate',
    h.projected_bookings === 41 && h.projected_revenue === 3690,
    `${h.projected_bookings} bookings · ${h.projected_revenue}`);
  check('expected trip value is the measured fares plus the projection',
    h.expected_revenue === 4190 && h.expected_revenue === h.revenue + h.projected_revenue,
    `${h.revenue} + ${h.projected_revenue} = ${h.expected_revenue}`);
  check('nothing that could be valued is left in the unrated count',
    h.unrated_bookings == null, String(h.unrated_bookings));

  /* The estimate rides beside the measurement and never becomes it. */
  check('the measured trip value is still only the fares on record',
    h.revenue === 500, String(h.revenue));
  check('and the estimate is never added into money in',
    h.accounted == null || Number(h.accounted) !== Number(h.expected_revenue),
    `accounted ${h.accounted} vs expected ${h.expected_revenue}`);
  check('every estimated figure carries the sentence that says it is one',
    /estimate/.test(h.projection_basis || '') && /settled/.test(h.projection_basis || ''),
    h.projection_basis);

  /* A channel with a rate and a channel without must not be confused: hotel is
     fully priced on the day, so it is neither projected nor unrated. */
  check('a fully priced channel is neither projected nor unrated',
    !(h.projection_parts || []).some((r) => r.platform === 'hotel')
      && !(h.unrated_platforms || []).includes('hotel'));
}

/* ── a channel that has FINISHED reporting is measured, never estimated ─────
   The first version of the projection valued every unpriced booking, and it was
   wrong on exactly the day easiest to check. 2026-09-07 on production is
   settled: Uber's weekly report had been walked overnight and 607 of the day's
   675 bookings carry a price. The endpoint still added AED 3,355 for the other
   68 and reported an expected 39,320 over a measured 35,965.

   Those 68 are not late — they are cancellations that took no fee. The day ran
   89.9% priced against 87.6% completed, and priced already EXCEEDS completed,
   because some cancellations carry one. And the rate is revenue over all
   bookings including the fee-less ones, so charging for them again on top is a
   double count by construction.

   Bolt below stands for that day: 90 of its 100 bookings priced, against a
   settled share of 90%. It must be measured, not projected, while Uber — 0 of
   41, against the same 90% — must be. */
{
  for (let d = 1; d <= 6; d++) {
    await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
               requested_at,distance_km,status,product,payment_type,price)
             SELECT 'bolt','bs${d}_'||g,'ecosine','L105','b1','Bolt Driver',
                    '2026-08-${String(d).padStart(2, '0')}T12:00:00+04:00'::timestamptz,
                    10,'completed','Bolt','card',
                    CASE WHEN g <= 90 THEN 100 ELSE NULL END
               FROM generate_series(1,100) g`);
  }
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
             requested_at,distance_km,status,product,payment_type,price)
           SELECT 'bolt','bd'||g,'ecosine','L105','b1','Bolt Driver',
                  '${DAY}T13:00:00+04:00'::timestamptz,10,'completed','Bolt','card',
                  CASE WHEN g <= 90 THEN 100 ELSE NULL END
             FROM generate_series(1,100) g`);
  const h = (await get(`/api/day?day=${DAY}`)).headline;
  const parts = h.projection_parts || [];

  check('a channel at its settled priced share is left to its measurement',
    !parts.some((r) => r.platform === 'bolt'),
    'bolt is 90 of 100 priced against a 90% settled share — its 10 unpriced are '
    + 'cancellations that took no fee, and the rate already spreads those in');
  check('…while a channel far below its settled share is still projected',
    parts.length === 1 && parts[0].platform === 'uber' && parts[0].bookings === 41);
  check('the day\u2019s measured trip value now holds both priced channels',
    h.revenue === 9500, String(h.revenue));
  check('and expected adds only the channel that is still walking',
    h.expected_revenue === 13190 && h.projected_revenue === 3690
      && h.projected_bookings === 41,
    `${h.revenue} + ${h.projected_revenue} = ${h.expected_revenue}`);
  /* Had bolt been projected too, its ten unpriced would have added 900 at the
     per-booking rate — on a day where every one of them earned nothing. */
  check('…so the fee-less cancellations are not charged for twice',
    h.expected_revenue !== 14090, 'bolt\u2019s 10 cancellations valued at AED 90 each');
  /* The share each channel was judged against, reported rather than implied, so
     a reader can see why one was estimated and the other was not. */
  check('the settled share that made the decision is on the row',
    parts[0] && parts[0].settled_share === 90, String(parts[0] && parts[0].settled_share));
}

/* ── a channel caught MID-WALK: the whole of it is valued, not its remainder ─
   Every projected channel above is all-or-nothing — Uber at 0 of 41 priced —
   and against that fixture `measured + unpriced × rate` and
   `max(measured, bookings × rate)` give the same answer, so nothing yet chooses
   between them. Production is not so tidy: at 20:07 Dubai on 2026-09-08 Bolt
   stood at 10 of 31 priced with AED 400 on record.

   The remainder form double counts. The rate is revenue over ALL bookings
   including the tenth that never carry a fare, so applying it to the unpriced
   remainder charges for those a second time on top of the measured part.
   Valuing the WHOLE channel at its per-booking rate — floored at what is
   already on record, because an estimate may add to a measurement and never
   contradict one — counts each booking exactly once.

   CABMAN below is that shape: 20 of 100 priced against a 90% settled share and
   an AED 90 rate. The whole channel is worth 9,000, of which 2,000 is measured,
   so the estimate adds 7,000. The remainder form would add 80 × 90 = 7,200. */
{
  for (let d = 1; d <= 6; d++) {
    await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
               requested_at,distance_km,status,product,payment_type,price)
             SELECT 'cabman','cs${d}_'||g,'ecosine','L106','c1','Cabman Driver',
                    '2026-08-${String(d).padStart(2, '0')}T12:00:00+04:00'::timestamptz,
                    10,'completed','Saloon','card',
                    CASE WHEN g <= 90 THEN 100 ELSE NULL END
               FROM generate_series(1,100) g`);
  }
  await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
             requested_at,distance_km,status,product,payment_type,price)
           SELECT 'cabman','cd'||g,'ecosine','L106','c1','Cabman Driver',
                  '${DAY}T14:00:00+04:00'::timestamptz,10,'completed','Saloon','card',
                  CASE WHEN g <= 20 THEN 100 ELSE NULL END
             FROM generate_series(1,100) g`);
  const h = (await get(`/api/day?day=${DAY}`)).headline;
  const cab = (h.projection_parts || []).find((r) => r.platform === 'cabman');

  check('a channel caught mid-walk is valued whole, not by its remainder',
    cab && cab.value === 7000,
    `${cab && cab.value} added — 7,200 is the remainder form, and it charges twice `
    + 'for the bookings that never carry a fare');
  check('…with the part already on record reported beside it',
    cab && cab.measured === 2000 && cab.bookings === 80,
    `${cab && cab.measured} measured over ${cab && cab.bookings} unpriced`);
  check('the day totals to the measured fares plus both estimates',
    h.revenue === 11500 && h.expected_revenue === 22190
      && h.expected_revenue === h.revenue + h.projected_revenue,
    `${h.revenue} + ${h.projected_revenue} = ${h.expected_revenue}`);
  /* And the floor, which is what stops an estimate contradicting a
     measurement: a channel that has already out-earned its own rate keeps its
     measured figure rather than being marked down to the average. */
  const routes = readFileSync('api/day_routes.js', 'utf8');
  check('an estimate may add to a measurement and never contradict one',
    /Math\.max\(measured, bk \* at\.per_booking\)/.test(routes));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
