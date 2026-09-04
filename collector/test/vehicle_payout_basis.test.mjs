/* The Payout column on #vehicles must be the CHOSEN payout, not the raw one.
   ─────────────────────────────────────────────────────────────────────────
   Two views of one money, and this product states the rule everywhere: a fare
   is what a rider was charged for a trip, a payout is what is left of those
   same fares after the platform's commission, and for the SAME platform they
   must never be added. api/income_sql.js picks one per channel and drops the
   other. /api/economics/assets obeys it per plate — its `payouts` is the
   chosen figure and its `attributed` is the raw one beside it.

   /api/vehicles/directory did not. Its Payout column was
   sum(attributed) over every channel, INCLUDING the channels whose money the
   Fares column beside it already carries. Measured on production
   2026-09-02, /api/vehicles/directory?days=2 against
   /api/economics/assets?days=2 for the same plate in the same window:

     L36397   directory payout 1899.58
              economics payouts 1823.58, attributed 1899.58, fares 66
     L46174   directory payout 1074.08
              economics payouts  886.08, attributed 1074.08

   and fleet-wide the directory's payout column summed to 60,157.28 — the
   economics `attributed` total to the cent — against 59,893.28 of chosen
   payout. AED 264 of Yango money appearing in both columns of the same row.
   Small only because Yango is 7 of 1,003 bookings; the rule it breaks is not
   small.

   The fixture has the same shape: yango and bolt each price 100% of their
   trips AND pay out weekly, uber prices nothing and pays out.

   ── what the corrected basis rule did to this test ───────────────────────
   api/income_sql.js used to prefer fares wherever they covered 80% of
   bookings, so yango and bolt were counted on their fares and their payouts
   sat in `attributed` alone — which is the divergence the assertions below
   were built to catch. The rule now prefers the PAYOUT wherever one covers
   the window, because a fare is gross of the platform's commission and a
   payout is what reached the bank (see chooseBasis, and the AED 440,445.31
   of Uber credits it is measured against).

   That makes this class of bug structurally impossible rather than merely
   absent: a channel that reports a payout is never counted on its fares, so
   nothing can appear in both columns of one row. The first check below is
   inverted to say exactly that, and the assertions that the directory agrees
   with /api/economics/assets are unchanged — they are the guard that matters
   and they would still catch a directory summing the wrong column. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { refreshPayouts } from '../src/rollup.js';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const WIN = 'from=2026-08-01&to=2026-08-31';
const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });

const { server, get: rawGet } = await mountAll(db);
const get = async (p) => {
  const r = await rawGet(p);
  if (r.body == null) throw new Error(`${p} → ${r.status} ${r.raw || '(no body)'}`);
  return r.body;
};

const dir = await get(`/api/vehicles/directory?${WIN}`);
const eco = await get(`/api/economics/assets?${WIN}`);
const econ = new Map(eco.rows.map((r) => [r.plate, r]));
const num = (v) => (v == null ? null : Number(v));
const near = (a, b) => (a == null && b == null) || Math.abs(Number(a || 0) - Number(b || 0)) < 0.01;

/* The fixture still has the production shape — channels that both price and
   pay — and under the corrected rule that no longer produces a divergence.
   Every channel with a payout is counted on it, so the raw attribution and the
   chosen payout are the same figure on every plate. Asserted rather than
   assumed: if a channel ever fell back to fares while still carrying a payout,
   its money would be in both columns of one row again. */
const overlap = eco.rows.filter((r) => !near(r.attributed, r.payouts));
check('a channel that pays is counted on what it paid, so nothing lands in both columns',
  overlap.length === 0,
  JSON.stringify(overlap.map((r) => [r.plate, r.attributed, r.payouts])));

console.log('\nthe Payout column is the chosen payout, not the raw attribution');

const wrong = [];
for (const r of dir) {
  const a = econ.get(r.plate);
  if (!a) continue;
  if (!near(num(r.payout), a.payouts)) {
    wrong.push(`${r.plate}: directory ${r.payout} vs economics payouts ${a.payouts}`
      + ` (raw attributed ${a.attributed})`);
  }
}
check('every plate’s Payout matches the payout /api/economics/assets chose for it',
  wrong.length === 0, wrong.slice(0, 4).join(' | '));

/* And the raw figure is not thrown away — it is the reconciliation total, the
   one that sums to what the platforms actually paid. It keeps its own name. */
check('the raw attribution survives under its own name',
  dir.every((r) => 'attributed' in r)
    && dir.every((r) => near(num(r.attributed), econ.get(r.plate)?.attributed)),
  JSON.stringify(dir.slice(0, 3).map((r) => [r.plate, r.attributed, r.payout])));

console.log('\nand the Fares column beside it obeys the same rule');

const fareWrong = dir.filter((r) => econ.has(r.plate)
  && !near(num(r.revenue), econ.get(r.plate).fares));
check('every plate’s Fares matches the fares /api/economics/assets chose for it',
  fareWrong.length === 0,
  JSON.stringify(fareWrong.slice(0, 4).map((r) => [r.plate, r.revenue, econ.get(r.plate).fares])));

/* The whole point: the two columns on one row are now disjoint, so a reader
   who adds them gets the money the asset made rather than some of it twice. */
const sum = (xs, k) => Math.round(xs.reduce((a, x) => a + Number(x[k] || 0), 0) * 100) / 100;
const money = Math.round(eco.rows.reduce((a, r) => a + Number(r.money || 0), 0) * 100) / 100;
check('Fares plus Payout across the fleet is the money, counted once',
  Math.abs((sum(dir, 'revenue') + sum(dir, 'payout')) - money) < 0.05,
  `${sum(dir, 'revenue')} + ${sum(dir, 'payout')} vs money ${money}`);

/* A car nobody drove keeps its em-dash. Zero earned and no payout period
   reaching the car are different facts, and the column renders them apart. */
const idle = dir.filter((r) => !r.trips);
check('a car with no work still reports absence rather than a zero',
  idle.every((r) => r.payout == null && r.attributed == null),
  JSON.stringify(idle.map((r) => [r.plate, r.payout, r.attributed])));

server.close(); await db.close();

/* ── payout_days has to describe the figure printed beside it ─────────────
   The column reads "AED 1,899 · 26d", so its day count is the union of the
   days the CHOSEN channels paid over. Neither the sum of their day counts nor
   the raw all-channel count is that union, and this fixture is built so the
   three answers differ: one plate, three channels that all pay, two of them
   believed on their payout and their paid days overlapping.

     uber  pays over 2026-08-01..07, prices nothing     → counted on its payout
     bolt  pays over 2026-08-05..11, prices nothing     → counted on its payout
     yango works 2026-08-12..14, prices every trip and
           reports NO payout at all                     → counted on its fares

   union of the chosen days   = 01..11 = 11
   sum of their day counts    = 7 + 7  = 14
   every day the plate worked = 01..14 = 14

   so a wrong rule cannot read 11 by accident.

   Yango files no payout here, which is the hotel channel's shape and the only
   shape a fares-basis channel can now have: since chooseBasis prefers a payout
   wherever one covers the window, a channel counted on fares is a channel that
   reported none. */
console.log('\nthe day count under the payout is the days that payout covers');

const mix = new PGlite();
await applySchema(mix);
const mq = (t, p = []) => mix.query(t, p).then((r) => r.rows);
let seq = 0;
const trip = (platform, drv, day, price) => mq(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price)
   VALUES ($1,$2,'ecosine','M100',$3,$4,$5,$6,11,'completed',$7)`,
  [platform, `m${seq++}`, drv, `${drv} driver`,
    `2026-08-${String(day).padStart(2, '0')}T09:00:00+04:00`,
    `2026-08-${String(day).padStart(2, '0')}T10:00:00+04:00`, price]);
const perf = (platform, drv, from, to, earnings) => mq(
  `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, plate,
     period_start, period_end, trips, distance_km, earnings, cash_earnings)
   VALUES ($1,'ecosine',$2,$3,'M100',$4,$5,20,220,$6,0)`,
  [platform, drv, `${drv} driver`, from, to, earnings]);

for (let d = 1; d <= 7; d++) { await trip('uber', 'u9', d, null); await trip('uber', 'u9', d, null); }
for (let d = 5; d <= 11; d++) { await trip('bolt', 'b9', d, null); await trip('bolt', 'b9', d, null); }
for (let d = 12; d <= 14; d++) { await trip('yango', 'y9', d, 90); await trip('yango', 'y9', d, 90); }
await perf('uber', 'u9', '2026-08-01', '2026-08-07', 3500);
await perf('bolt', 'b9', '2026-08-05', '2026-08-11', 2100);
/* No perf row for yango, deliberately — see above. */
await refreshPayouts(mix);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-14', db: mix });

const mixApi = await mountAll(mix);
const mixWin = 'from=2026-08-01&to=2026-08-14';
const mRow = ((await mixApi.get(`/api/vehicles/directory?${mixWin}`)).body || [])
  .find((r) => r.plate === 'M100');
const mEco = ((await mixApi.get(`/api/economics/assets?${mixWin}`)).body.rows || [])
  .find((r) => r.plate === 'M100');

check('the mixed-basis plate really is mixed — two channels paid and were counted, one paid and was not',
  mRow?.payout_platforms.join(',') === 'bolt,uber'
    && mRow?.fares_platforms.join(',') === 'yango',
  JSON.stringify([mRow?.payout_platforms, mRow?.fares_platforms]));
check('and its Payout is still the figure /api/economics/assets chose',
  near(Number(mRow?.payout), mEco?.payouts), `${mRow?.payout} vs ${mEco?.payouts}`);
check('the day count is the union of the days those two channels paid over, not the sum',
  mRow?.payout_days === 11, `${mRow?.payout_days} days`);
/* The raw count and the chosen one coincide, and that is the corrected rule
   stated as an identity rather than as a preference: a channel counted on
   fares contributes no payout, so there is no day in the raw attribution that
   the chosen one is missing. It is 11 and not 14 because yango's three days
   carry fares and no payout at all. */
check('and the raw attribution covers the same days, because a fares channel pays nothing',
  mRow?.attributed_days === 11, `${mRow?.attributed_days} attributed days`);

mixApi.server.close(); await mix.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
