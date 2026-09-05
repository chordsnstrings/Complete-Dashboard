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

/* ── the car's own page and the car's row must state the same money ───────
   /api/vehicle/kpis built its per-channel rows from a SELECT that never asked
   for booking_days, and coverage() in api/income_sql.js reads
   booking_days > 0 ? booking_days : windowDays — so every channel on this
   endpoint had its payout's day count divided by the length of the CALENDAR
   window rather than by the days the channel actually worked. A car that
   worked 23 of August's 31 days and holds a payout covering all 23 read 74.2%
   instead of 100%, and the page then either dropped the channel to its gross
   fares or filed money that had already arrived as not yet collected.

   Measured on production 2026-09-05 across all 98 earning plates for
   2026-08-01..2026-08-31: the sum of this endpoint's accounted came to AED
   567,258.53 against AED 502,709.89 from /api/economics/assets and from
   /api/vehicles/directory, which agree with each other to the cent — an
   excess of AED 64,548.64 on exactly 45 plates, every one of them with
   accounted_payouts null and undercovered_bookings 0. L46185's page printed
   "AED 11,986.98 in fares · AED 0 attributed from platform payouts" while its
   own earnings panel three sections down showed AED 6,355.12 attributed from
   Uber, and the directory row for the same car and window said 1,842.00 +
   6,355.12 = 8,197.12. The page contradicted itself by 46.2%.

   Pinned as AGREEMENTS and not as numbers: the two surfaces answer the same
   question about the same car over the same window through the same
   chooseBasis, so whatever either one says the other has to say too. A fixture
   figure would go stale the next time the seed changes; these cannot.

   The FARES half is compared on the mixed-basis fixture below rather than
   here, for a reason that is worth writing down because it looks like a
   failure of this fix and is not. The two surfaces read different windows: the
   directory asks trip_norm for local_day BETWEEN from AND to, the Dubai
   calendar day, while every query in /api/vehicle/* asks for requested_at
   BETWEEN two bare timestamps, which Postgres reads in the session's zone. On
   this fixture that is one hotel booking of AED 56.29 on L45240 — inside the
   Dubai window, outside the UTC one. It is a real defect and a separate one,
   it predates this change, it is a whole class spanning every TW query in
   api/vehicle_routes.js and api/driver_routes.js, and it is not this brief's
   to fix; noted here so the next reader does not mistake it for this one. */
console.log('\nthe vehicle page and the vehicle row report one number, not two');

const kpiByPlate = new Map();
for (const r of dir) {
  if (!r.trips) continue;
  kpiByPlate.set(r.plate, await get(`/api/vehicle/kpis?plate=${r.plate}&${WIN}`));
}

/* The half that C4 rewrote. A channel whose payout coverage is measured
   against the calendar instead of against the days it worked falls out of the
   payout branch, and its money reappears on the page as the GROSS fare the
   riders paid — which is what production served for 45 of 98 plates. */
const payDisagree = [...kpiByPlate].filter(([plate, k]) =>
  !near(k.accounted_payouts, num(dir.find((r) => r.plate === plate).payout)));
check('every plate’s payout half is the same figure on its page as on its row',
  payDisagree.length === 0,
  JSON.stringify(payDisagree.map(([plate, k]) =>
    [plate, k.accounted_payouts, dir.find((r) => r.plate === plate).payout])));

/* And the same defect seen from the other side, which is the half that
   survives whichever way chooseBasis is ordered. Every paying channel in this
   fixture pays over every day it worked — the payouts are built from
   driver_performance periods that span the trips — so measured against the
   days worked there is no shortfall to report at all. Measured against the
   31-day calendar instead, every one of those channels reads under 80%, falls
   to partial_payout, and the page files 42 to 50 of the plate's bookings as
   money that has not been collected while the money sits in the same
   response's accounted_payouts. A car cannot have been both paid and not paid
   for the same days, and the directory row for it says paid. */
const stillUncovered = [...kpiByPlate].filter(([, k]) => k.undercovered_bookings !== 0);
check('and money the row counts as paid is not reported as uncollected on the page',
  stillUncovered.length === 0,
  JSON.stringify(stillUncovered.map(([plate, k]) =>
    [plate, k.undercovered_bookings, k.undercovered_platforms])));

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

/* And the same agreement on the mixed-basis plate, which is where the missing
   denominator bites hardest: uber worked 7 of these 14 days and was paid for
   all 7, bolt likewise. Against the days they WORKED both are 100% covered and
   are counted on their payouts; against the 14-day calendar window both read
   50%, fall to partial_payout, and the page then reports as "not yet
   collected" money that was collected in full. The two numbers below are the
   two halves of that: the money must match the row, and none of it may be
   filed as under-covered when every day the channel worked was paid for. */
const mKpi = (await mixApi.get(`/api/vehicle/kpis?plate=M100&${mixWin}`)).body;
check('the mixed plate’s page states the same money as its directory row',
  near(mKpi.accounted, Math.round(((Number(mRow?.revenue) || 0)
    + (Number(mRow?.payout) || 0)) * 100) / 100),
  `${mKpi.accounted} vs ${mRow?.revenue} + ${mRow?.payout}`);
check('and a payout covering every day its channel worked is not reported as under-covered',
  mKpi.undercovered_bookings === 0 && mKpi.undercovered_payouts == null,
  JSON.stringify([mKpi.undercovered_bookings, mKpi.undercovered_payouts,
    mKpi.undercovered_platforms]));

mixApi.server.close(); await mix.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
