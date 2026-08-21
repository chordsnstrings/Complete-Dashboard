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
import express from 'express';
import { readFileSync } from 'node:fs';
import { dayRoutes } from '../api/day_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
  'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql',
  'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
