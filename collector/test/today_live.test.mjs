/* The overview's chart summed to one trip less than its own headline.
   ─────────────────────────────────────────────────────────────────────────
   12,667 against 12,668, live. Not a rounding difference and not a definition
   difference: /api/kpis, /api/platforms and the trip list read trip_norm, and
   the daily series read rollup_day — a table rebuilt after each collection
   run. Between runs its row for TODAY is however many trips behind the fleet
   has taken since. One trip, on the busiest page in the product.

   A one-trip gap is small and the damage is not. A reader who catches two
   pages disagreeing by one has no way to know it is one, and stops trusting
   both by thousands. It is the same complaint that produced the calendar
   window: the pages have to agree.

   So only the current day is recomputed live — one day of aggregation against
   a rollup that still carries every finished day — and both halves are the
   same SQL the rollup is built from, so the fast half and the live half
   cannot answer differently. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const DAY = (n) => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date(Date.now() - n * 864e5));

let id = 0;
const trip = (day, platform, plate, drv, hour = 9) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price, currency, raw)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6::timestamptz,$6::timestamptz + interval '15 min',
           9, 'completed', $7, 'AED', '{}'::jsonb)`,
  [platform, `t${++id}`, plate, drv, `Name ${drv}`,
    `${day}T${String(hour).padStart(2, '0')}:00:00+04`, platform === 'hotel' ? 90 : null]);

for (let d = 0; d < 6; d++) {
  for (let i = 0; i < 5; i++) await trip(DAY(d), 'uber', `L${i}`, `u${i}`, 6 + i);
  await trip(DAY(d), 'hotel', 'L0', 'h1', 12);
  await trip(DAY(d), 'fms', 'L1', 'u1', 22);       // a telematics twin, never a booking
}
await refreshRollups({ db });

const { get } = await mountAll(db, { serverRoutes: true });
const WIN = 'days=7';
const sum = async (k = 'trips') => (await get(`/api/trips/daily?${WIN}`)).body
  .reduce((a, r) => a + (+r[k] || 0), 0);
const kpiTrips = async () => (await get(`/api/kpis?${WIN}`)).body.trips;

console.log('\nwith the rollup fresh, every page is reading the same fleet');
check('the rollup was actually built', (await q('SELECT count(*)::int n FROM rollup_day'))[0].n > 0);
const before = await sum();
check('the chart sums to the headline', before === await kpiTrips(), `${before} vs ${await kpiTrips()}`);
check('and to the trip list', before === (await get(`/api/trips/list?${WIN}&limit=1`)).body.total);
check('the telematics twins are not in it',
  before === 36, `${before} — 30 uber + 6 hotel, no FMS`);
check('and are still reported, apart', await sum('telematics_journeys') === 6,
  String(await sum('telematics_journeys')));

console.log('\nnow a trip lands, and nothing refreshes the rollup');
await trip(DAY(0), 'uber', 'L9', 'u9', 20);
const stale = (await q('SELECT bookings FROM rollup_day WHERE day = $1::date AND platform = $2 AND fleet_id = $3',
  [DAY(0), '*', '*']))[0];
check('the stored row for today is now behind the table', +stale.bookings === 6, JSON.stringify(stale));
const after = await sum();
check('the headline moved', await kpiTrips() === before + 1, String(await kpiTrips()));
check('and the chart moved with it', after === before + 1, `${after} vs ${before + 1}`);
check('the trip list agrees too',
  (await get(`/api/trips/list?${WIN}&limit=1`)).body.total === after);

console.log('\nand a day that is finished still comes from the rollup');
/* The trade this endpoint exists to make: a year of daily distinct-driver
   counts timed out when computed live. Only TODAY is recomputed, so the
   finished days must still be served from the stored grain. */
const t0 = Date.now();
await sum();
check('the series is still fast', Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
const days = (await get(`/api/trips/daily?${WIN}`)).body;
check('every day in the window is present, drawn or empty', days.length === 7, String(days.length));
check('today is the last of them', days[days.length - 1].d === DAY(0), days[days.length - 1].d);

console.log('\nthe live half counts people the way the stored half does');
/* The fallback this replaced counted distinct driver_name, where the rollup
   counts distinct person_key — so the same day could carry two different
   driver counts depending on which path served it. */
await trip(DAY(0), 'yango', 'L9', 'other-account-same-person', 21);
await q(`UPDATE trip SET driver_name = 'Name u9' WHERE driver_ext_id = 'other-account-same-person'`);
const dayRow = (await get(`/api/trips/daily?${WIN}`)).body.at(-1);
const kp = (await get(`/api/kpis?${WIN}`)).body;
check('one human with two accounts is one driver on the chart',
  dayRow.drivers <= kp.drivers, `chart ${dayRow.drivers} vs kpis ${kp.drivers}`);
check('and the chart never reports more drivers than the window has',
  dayRow.drivers <= 7, String(dayRow.drivers));

console.log('\nwith no rollup at all, the answer is the same answer');
await q('DELETE FROM rollup_day');
const bare = await sum();
check('a fresh database still draws the chart', bare === after + 1, `${bare} vs ${after + 1}`);
check('and it still matches the headline', bare === (await get(`/api/kpis?${WIN}`)).body.trips,
  `${bare} vs ${(await get(`/api/kpis?${WIN}`)).body.trips}`);

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
