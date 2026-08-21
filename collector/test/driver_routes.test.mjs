/* Per-driver detail API, end to end: a real express app, a real Postgres, real
   HTTP. The awkward part these endpoints exist to handle is that one person is
   several records — an Uber UUID, a Yango id, a name spelled two ways — so the
   fixture below deliberately contains that mess and the assertions check that
   the page adds up to one human rather than three. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { driverRoutes } from '../api/driver_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
  'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql', 'schema_v10.sql',
  'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql', 'schema_v14.sql', 'schema_v15.sql', 'schema_v16.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

/* ── fixture ──────────────────────────────────────────────────────────────
   Amina drives on Uber as `u-amina` and on Yango as `y-amina`, and Yango
   spells her name with the surname doubled. Bilal is a separate person with a
   similar workload, present so percentile ranks have something to rank against. */
const UBER = 'u-amina', YANGO = 'y-amina', OTHER = 'u-bilal';

const trip = (platform, ext, drv, name, plate, dayISO, hour, opts = {}) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,ended_at,
                     distance_km,duration_s,status,product,payment_type,price,
                     pickup_lat,pickup_lng,pickup_addr,dropoff_lat,dropoff_lng)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [platform, ext, plate, drv, name,
   `${dayISO}T${String(hour).padStart(2, '0')}:00:00+04:00`,
   `${dayISO}T${String(hour).padStart(2, '0')}:24:00+04:00`,
   opts.km ?? 9, opts.dur ?? 1440, opts.status ?? 'completed',
   opts.product ?? 'UberX', opts.pay ?? 'card', opts.price ?? 38,
   opts.lat ?? 25.204, opts.lng ?? 55.271, opts.addr ?? 'Dubai Marina - Marina Walk',
   opts.dlat ?? 25.118, opts.dlng ?? 55.200]);

// Amina, Uber: 8 trips/day across 2026-08-10..14, starting at 07:00
let n = 0;
for (const day of ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'])
  for (let i = 0; i < 8; i++)
    await trip('uber', `u${n++}`, UBER, 'Amina Rashid', 'L46174', day, 7 + i,
      { km: 6 + i, price: 25 + i * 4 });
// …one cancelled, and one long airport run so the distance buckets have spread
await trip('uber', 'u-cx', UBER, 'Amina Rashid', 'L46174', '2026-08-12', 16, { status: 'rider_cancelled', km: 0, price: 0 });
await trip('uber', 'u-air', UBER, 'Amina Rashid', 'L46174', '2026-08-13', 17,
  { km: 42, price: 160, addr: 'Dubai International Airport - Terminal 3', lat: 25.253, lng: 55.365 });
// Amina, Yango: same person, doubled surname, different vehicle
for (let i = 0; i < 5; i++)
  await trip('yango', `y${i}`, YANGO, 'Amina Rashid Rashid', 'L36397', '2026-08-15', 18 + (i % 5),
    { km: 12, price: 55, product: 'Comfort', pay: 'cash' });
// Bilal: the peer
for (let i = 0; i < 12; i++)
  await trip('uber', `o${i}`, OTHER, 'Bilal Noor', 'L41435', '2026-08-11', 8 + (i % 10), { km: 5, price: 20 });

await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,phone,licence_no,licence_expires,state)
         VALUES ('yango',$1,'ecosine','Amina Rashid Rashid','+9715000','DL-77','2026-11-30','active')`, [YANGO]);
await q(`INSERT INTO driver_performance (platform,fleet_id,driver_ext_id,driver_name,plate,period_start,period_end,
           trips,hours_online,hours_on_trip,acceptance_rate,cancellation_rate,earnings,cash_earnings,rating)
         VALUES ('uber','ecosine',$1,'Amina Rashid','L46174','2026-08-13','2026-08-13',8,9.5,6.4,0.91,0.04,410,0,4.87)`,
  [UBER]);
await q(`INSERT INTO driver_earnings_component (platform,driver_ext_id,period_start,period_end,category,parent,amount,driver_name)
         VALUES ('uber',$1,'2026-08-10','2026-08-16','net_fare','earnings',1200,'Amina Rashid'),
                ('uber',$1,'2026-08-10','2026-08-16','tip','earnings',96,'Amina Rashid')`, [UBER]);

// custody + alerts so the quality tab has vehicle-linked events to attribute
// Two custody rows for L46174 on the 13th — one per platform. Alert and
// telemetry joins must not multiply by that row count.
await q(`INSERT INTO vehicle_driver_day (plate,day,driver_ext_id,platform,driver_name,trips,km,revenue,is_primary)
         VALUES ('L46174','2026-08-13',$1,'uber','Amina Rashid',9,120,400,true),
                ('L46174','2026-08-13',$2,'yango','Amina Rashid Rashid',1,10,45,false),
                ('L36397','2026-08-15',$2,'yango','Amina Rashid Rashid',5,60,275,true)`, [UBER, YANGO]);
await q(`INSERT INTO alert (platform,external_id,plate,alert_type,occurred_at)
         VALUES ('fms','a1','L46174','Harsh Braking','2026-08-13T09:00:00+04:00'),
                ('fms','a2','L46174','Overspeed','2026-08-13T10:00:00+04:00'),
                ('fms','a3','L41435','Overspeed','2026-08-13T10:00:00+04:00')`);
await q(`INSERT INTO telemetry_snapshot (source,plate,captured_at,lat,lng,speed)
         VALUES ('cabman','L46174','2026-08-13T12:00:00+04:00',25.10,55.18,0),
                ('cabman','L46174','2026-08-13T12:05:00+04:00',25.10,55.18,0),
                ('cabman','L46174','2026-08-13T12:10:00+04:00',25.10,55.18,1)`);

/* ── app under test ─────────────────────────────────────────────────────── */
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
driverRoutes(app, { q, wrap, endOfDay });
const server = app.listen(0);
const port = server.address().port;
const W = 'from=2026-08-01&to=2026-08-31';
const get = async (p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.json() };
};

/* ── identity resolution ────────────────────────────────────────────────── */
const prof = await get(`/api/driver/profile?id=${UBER}&${W}`);
check('profile resolves', prof.status === 200, JSON.stringify(prof.body).slice(0, 120));
check('the two platform ids fold into one person', prof.body.ids?.length === 2, String(prof.body.ids));
check('display name prefers the fuller spelling', prof.body.name === 'Amina Rashid Rashid', prof.body.name);
check('both platforms listed', ['uber', 'yango'].every((p) => prof.body.platforms.includes(p)), String(prof.body.platforms));
check('trip span covers both accounts', prof.body.span.trips === 47, String(prof.body.span?.trips));
check('vehicles from custody', prof.body.vehicles.length === 2, String(prof.body.vehicles.length));
check('compliance record attached', prof.body.compliance[0]?.licence_no === 'DL-77');
check('accounts break down per platform', prof.body.accounts.length === 2, String(prof.body.accounts.length));

const other = await get(`/api/driver/profile?id=${OTHER}&${W}`);
check('a different person is NOT merged in', other.body.ids?.length === 1 && other.body.name === 'Bilal Noor', other.body.name);
check('unknown id 404s', (await get('/api/driver/profile?id=nope')).status === 404);

/* ── kpis and shift shape ───────────────────────────────────────────────── */
const k = (await get(`/api/driver/kpis?id=${UBER}&${W}`)).body;
check('kpi trips match', k.trips === 47, String(k.trips));
check('days worked counted in Dubai time', k.days_worked === 6, String(k.days_worked));
// five Uber days start at 07:00 and the Yango day at 18:00 → median 7, not the 9.8 mean
check('typical start is the median first-trip hour, not the mean', Math.round(k.median_start_h) === 7, String(k.median_start_h));
check('trips per day derived', k.trips_per_day > 0);
check('platform hours carried through', +k.hours_online === 9.5, String(k.hours_online));
check('utilisation = on-trip / online', k.utilisation_pct === 67.4, String(k.utilisation_pct));
check('cancellation percentage counted', +k.cancel_pct > 0, String(k.cancel_pct));

/* ── daily spine ────────────────────────────────────────────────────────── */
const daily = (await get(`/api/driver/daily?id=${UBER}&${W}`)).body;
check('one row per working day', daily.length === 6, String(daily.length));
const d13 = daily.find((r) => r.day.startsWith('2026-08-13'));
check('the airport day carries the long trip', +d13.km > 80, String(d13?.km));
check('first hour recorded for the day', Math.round(d13.first_hour) === 7, String(d13?.first_hour));
check('platform hours joined onto the day', +d13.hours_online === 9.5, String(d13?.hours_online));
check('plates listed per day', d13.plates === 'L46174', d13?.plates);

/* ── heatmap ────────────────────────────────────────────────────────────── */
const hm = (await get(`/api/driver/heatmap?id=${UBER}&${W}`)).body;
check('heatmap has weekday/hour cells', hm.length > 5 && hm[0].dow != null && hm[0].h != null);
check('heatmap hours are Dubai local', hm.every((c) => c.h >= 0 && c.h <= 23));

/* ── standing vs fleet ──────────────────────────────────────────────────── */
const st = (await get(`/api/driver/standing?id=${UBER}&${W}`)).body;
check('peer population folds ids to people', st.n_peers === 2, String(st.n_peers));
const trips = st.metrics.find((m) => m.key === 'trips');
check('own trips counted across both platforms', trips.value === 47, String(trips?.value));
check('higher trips → higher percentile', trips.percentile === 100, String(trips?.percentile));
const cancel = st.metrics.find((m) => m.key === 'cancel');
check('cancellation is inverted (lower is better)', cancel.percentile < 100, String(cancel?.percentile));

/* ── territory ──────────────────────────────────────────────────────────── */
const terr = (await get(`/api/driver/territory?id=${UBER}&${W}`)).body;
check('pickup clusters returned', terr.pickups.length >= 2, String(terr.pickups.length));
check('busiest pickup first', terr.pickups[0].n >= terr.pickups[terr.pickups.length - 1].n);
check('named areas extracted from the address', terr.areas.some((a) => a.area === 'Dubai Marina'), JSON.stringify(terr.areas.slice(0, 2)));
check('waiting spots come from stationary fixes', terr.idle.length === 1, String(terr.idle.length));
// Three fixes at that spot, and two custody rows for the day — still three.
check('a stationary fix is counted once per custody day', terr.idle[0]?.fixes === 3, String(terr.idle[0]?.fixes));

/* ── mix ────────────────────────────────────────────────────────────────── */
const mix = (await get(`/api/driver/mix?id=${UBER}&${W}`)).body;
check('distance buckets ordered short→long', mix.distance[0].label === '0–3 km' || mix.distance[0].label === '3–7 km', mix.distance[0]?.label);
check('the 42km airport run lands in 30–60 km', mix.distance.some((b) => b.label === '30–60 km' && b.n === 1));
check('product mix spans both platforms', mix.product.length === 2, String(mix.product.length));
check('payment mix includes cash from Yango', mix.payment.some((p) => p.label === 'cash'));

/* ── earnings ───────────────────────────────────────────────────────────── */
const e = (await get(`/api/driver/earnings?id=${UBER}&${W}`)).body;
check('earnings components returned', e.components.length === 2, String(e.components.length));
check('tip rate computed against fare', e.tip_pct === 8, String(e.tip_pct));
check('platform periods listed', e.periods.length === 1);

/* ── quality ────────────────────────────────────────────────────────────── */
const qy = (await get(`/api/driver/quality?id=${UBER}&${W}`)).body;
check('cancellations broken out', qy.cancels.some((c) => c.status === 'rider_cancelled'));
// L46174 has two alerts on the 13th and two custody rows for that day; L41435's
// alert belongs to someone else. Two events, counted once each.
check('only alerts for vehicles they held that day', qy.alerts.reduce((a, r) => a + r.n, 0) === 2, JSON.stringify(qy.alerts));
check('harsh events normalised per 100km', qy.alerts_per_100km > 0, String(qy.alerts_per_100km));

/* ── raw records ────────────────────────────────────────────────────────── */
const tr = (await get(`/api/driver/trips?id=${UBER}&${W}&limit=10`)).body;
check('trip list honours the limit', tr.length === 10, String(tr.length));
check('trips come back newest first', new Date(tr[0].requested_at) >= new Date(tr[1].requested_at));
const cust = (await get(`/api/driver/custody?id=${UBER}&${W}`)).body;
// Three rows for two vehicles: L46174 twice on the 13th (uber + yango), L36397 once.
check('custody lists every platform row', cust.length === 3, String(cust.length));
check('custody covers both vehicles', new Set(cust.map((c) => c.plate)).size === 2,
  [...new Set(cust.map((c) => c.plate))].join(','));

/* ── directory ──────────────────────────────────────────────────────────── */
const dir = (await get(`/api/drivers/directory?${W}`)).body;
check('directory lists people, not accounts', dir.length === 2, String(dir.length));
const amina = dir.find((r) => /Amina/.test(r.driver_name));
check('directory folds cross-platform trips', amina.trips === 47, String(amina?.trips));
check('directory carries every id for the person', amina.ids.length === 2, String(amina?.ids?.length));
check('directory sorted by trips', dir[0].trips >= dir[1].trips);
check('licence state surfaced in the directory', amina.state === 'active' || amina.licence_expires != null);

/* ── the directory must not hide the people worth finding ────────────────
   It was built FROM the trip table, so a driver who took nothing in the window
   had no row at all — under a panel headed "All drivers". Sixty-four of the
   people missing that way had an expired licence, which is precisely who an
   operator opens this page to find. */
{
  await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, licence_no,
             licence_expires, state)
           VALUES ('hotel','ghost-1','Never Drove Here','AE777','2026-01-01','active')`);
  const all = (await get(`/api/drivers/directory?${W}`)).body;
  const ghost = all.find((r) => r.driver_name === 'Never Drove Here');
  check('a driver with no trip in the window still has a row', !!ghost,
    all.map((r) => r.driver_name).join(' | '));
  check('and is marked as not active in it rather than shown as a zero',
    ghost.active_in_window === false && ghost.trips === 0);
  check('their expired licence is still visible', ghost.licence_expires != null);
  check('"no trip this window" and "never driven" are different facts',
    ghost.ever_driven === false && amina.ever_driven === true,
    `${ghost.ever_driven} / ${amina.ever_driven}`);
}

/* ── a folded person carries their own numbers, not one account's ──────── */
{
  const dir2 = (await get(`/api/drivers/directory?${W}`)).body;
  const a = dir2.find((r) => /Amina/.test(r.driver_name));
  check('completion is recomputed over the whole person, not copied from one account',
    a.completion_pct === (a.bookable ? Math.round((a.completed / a.bookable) * 100) : null),
    `${a.completed}/${a.bookable} -> ${a.completion_pct}`);
  check('the counts behind it are carried through the fold',
    a.completed <= a.bookable && a.bookable > 0, `${a.completed}/${a.bookable}`);
  // Days worked on one platform and not another must not be discarded.
  check('days are the union across a person\'s accounts, not the max of them',
    a.days >= Math.max(...dir2.filter((r) => r.ids.length === 1).map((r) => r.days), 0)
    || a.ids.length === 1, String(a.days));
}

/* ── the window is Dubai days, like every other endpoint ───────────────── */
{
  // A trip at 01:00 Dubai on the 15th is 21:00 UTC on the 14th. Bound as a raw
  // timestamptz it falls outside a window that starts on the 15th.
  await q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
       requested_at, status, distance_km)
     VALUES ('uber','tz-1','ecosine','L1',$1,
             (SELECT max(driver_name) FROM trip WHERE driver_ext_id = $1),
             '2026-08-15T01:00:00+04:00','completed',9)`,
    [UBER]);
  const narrowDir = (await get('/api/drivers/directory?from=2026-08-15&to=2026-08-15')).body;
  const a = narrowDir.find((r) => /Amina/.test(r.driver_name));
  check('a 01:00 Dubai trip is inside a window that starts that day',
    !!a && a.trips > 0, JSON.stringify(narrowDir.map((r) => [r.driver_name, r.trips])));
}

/* ── window filtering actually filters ──────────────────────────────────── */
const narrow = (await get(`/api/driver/kpis?id=${UBER}&from=2026-08-15&to=2026-08-15`)).body;

check('a one-day window returns only that day', narrow.trips === 5, String(narrow.trips));
check('date-only `to` includes the whole day', narrow.days_worked === 1, String(narrow.days_worked));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
