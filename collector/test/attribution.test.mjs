/* ── whose money is it, and which car earned it ────────────────────────────
   Uber is 90% of this fleet's bookings and its trip export carries no fare at
   all. Its money lands in driver_performance, one row per driver per payout
   period, so every page keyed on a VEHICLE saw the work and none of the money:
   one car showed 266 trips, 3,586 km and AED 525 over thirty days, the 525
   being ten hotel bookings — the only trips in the set that carry a price.

   Attribution spreads a payout across the vehicle-days its driver actually
   worked. That is an inference, and an inference is only worth showing if it
   is arithmetically honest, so these tests are mostly about conservation:
   what goes in comes out, and what cannot be placed is named rather than lost.

   The fixture is deliberately small enough to check by hand.  */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { attributedEarnings, unattributedEarnings } from '../api/attribution_sql.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const near = (a, b, eps = 0.01) => Math.abs(Number(a) - Number(b)) < eps;

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const day = (plate, d, drv, trips, km = trips * 10) => q(
  `INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, km)
   VALUES ($1,$2,$3,'uber',$4,'ecosine',$5,$6)`, [plate, d, drv, `Name ${drv}`, trips, km]);
const pay = (drv, from, to, amount) => q(
  `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end, earnings)
   VALUES ('uber','ecosine',$1,$2,$3,$4,$5)`, [drv, `Name ${drv}`, from, to, amount]);

/* Ali: paid 1000 for the week. He drove CAR-A on 30 trips and CAR-B on 10, so
   three quarters of that week's pay belongs to A. Checkable by hand: 750/250. */
await pay('d-ali', '2026-08-10', '2026-08-16', 1000);
await day('CARA', '2026-08-10', 'd-ali', 20);
await day('CARA', '2026-08-11', 'd-ali', 10);
await day('CARB', '2026-08-12', 'd-ali', 10);

/* Sara: paid 400, drove one car on two days but the day rows record no trips.
   There is no basis to prefer either day, so it splits evenly — and says so. */
await pay('d-sara', '2026-08-10', '2026-08-16', 400);
await day('CARC', '2026-08-10', 'd-sara', 0, 0);
await day('CARC', '2026-08-11', 'd-sara', 0, 0);

/* Omar: paid 500 and never appears in vehicle_driver_day at all — no custody
   record inside the period. His pay belongs to no car, and must be reported
   rather than dropped or smeared over the fleet. */
await pay('d-omar', '2026-08-10', '2026-08-16', 500);

const W = ['2026-08-10', '2026-08-16'];
const rows = await q(attributedEarnings(), W);
const byPlate = {};
for (const r of rows) byPlate[r.plate] = (byPlate[r.plate] || 0) + Number(r.attributed);

console.log('\nattribution: the split follows the work');

check('a driver\'s payout follows the trips, not the calendar',
  near(byPlate.CARA, 750) && near(byPlate.CARB, 250),
  `CARA=${byPlate.CARA} CARB=${byPlate.CARB}`);
check('and is marked as trip-weighted where trips exist',
  rows.filter((r) => r.plate === 'CARA').every((r) => r.basis === 'trips'));
check('a period with no trips recorded splits evenly rather than vanishing',
  near(byPlate.CARC, 400), `CARC=${byPlate.CARC}`);
check('and says the split was even, not measured',
  rows.filter((r) => r.plate === 'CARC').every((r) => r.basis === 'even'));

console.log('\nattribution: conservation');

/* The identity that makes this worth showing at all. If attributed + unplaced
   does not equal what the platform actually paid, then the vehicle pages and
   the Revenue page disagree and neither can be reconciled against the other. */
const attributedTotal = rows.reduce((a, r) => a + Number(r.attributed), 0);
const [un] = await q(unattributedEarnings(), W);
const [{ total }] = await q(
  `SELECT sum(earnings) total FROM driver_performance
   WHERE period_end >= $1::date AND period_start <= $2::date`, W);

check('every share of a period sums to exactly the whole period',
  near(attributedTotal, 1400), String(attributedTotal));
check('the payout that could be placed, plus the payout that could not, is what was paid',
  near(attributedTotal + Number(un.earnings), Number(total)),
  `${attributedTotal} + ${un?.earnings} vs ${total}`);
check('and the unplaceable payout is named, with its driver count, not silently dropped',
  near(un.earnings, 500) && un.drivers === 1 && un.periods === 1);
/* Smearing it over the fleet would make every car's figure wrong by an
   invisible amount, which is worse than a number the page admits to missing. */
check('unplaced pay is never spread across cars the driver did not drive',
  !rows.some((r) => r.driver_ext_id === 'd-omar'));

console.log('\nattribution: the window is applied to the day, not the period');

/* A weekly period straddling the window edge must contribute only the days
   inside it, and at the weight it had over the whole week — otherwise a period
   half outside gets its inside half scaled up to 100%, and the car reads as
   having earned a full week's pay in three days. */
const narrow = await q(attributedEarnings(), ['2026-08-10', '2026-08-11']);
const narrowByPlate = {};
for (const r of narrow) narrowByPlate[r.plate] = (narrowByPlate[r.plate] || 0) + Number(r.attributed);
check('a window covering part of a period takes only that part of the pay',
  near(narrowByPlate.CARA, 750), `CARA=${narrowByPlate.CARA}`);
check('and the day outside the window contributes nothing',
  narrowByPlate.CARB === undefined, `CARB=${narrowByPlate.CARB}`);
/* Four rows fall inside this narrow window: Ali on CARA twice (20/40 and
   10/40 of his week) and Sara on CARC twice (half her week each). If the
   weights were rescaled to the window they would sum to 2 — one whole period
   per driver — instead of 1.75. */
check('the weight is still computed over the whole period, not rescaled to the window',
  near(narrow.reduce((a, r) => a + Number(r.share), 0), (20 / 40) + (10 / 40) + 0.5 + 0.5),
  String(narrow.reduce((a, r) => a + Number(r.share), 0)));

console.log('\nattribution: nothing is invented from nothing');

/* A zero or null payout must not produce a row: a car credited with AED 0.00
   "attributed earnings" reads as measured and is worse than no row at all. */
await pay('d-zero', '2026-08-10', '2026-08-16', 0);
await day('CARD', '2026-08-10', 'd-zero', 5);
const withZero = await q(attributedEarnings(), W);
check('a zero payout produces no attributed row',
  !withZero.some((r) => r.plate === 'CARD'));

await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end, trips)
         VALUES ('uber','ecosine','d-null','2026-08-10','2026-08-16', 9)`);
await day('CARE', '2026-08-10', 'd-null', 5);
const withNull = await q(attributedEarnings(), W);
check('a period reporting trips but no earnings produces no attributed row',
  !withNull.some((r) => r.plate === 'CARE'));
check('and is not counted as unplaced pay either, since there was no pay',
  near((await q(unattributedEarnings(), W))[0].earnings, 500));

/* Two platforms must not cross-attribute: a Yango payout cannot be placed on a
   day the driver spent on Uber, even under the same driver id. */
await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end, earnings)
         VALUES ('yango','ecosine','d-ali','2026-08-10','2026-08-16', 300)`);
const crossed = await q(attributedEarnings(), W);
check('a payout is only placed on days worked on the SAME platform',
  !crossed.some((r) => r.platform === 'yango'));
check('and that unplaceable cross-platform pay is reported instead',
  near((await q(unattributedEarnings(), W)).find((r) => r.platform === 'yango')?.earnings, 300));

console.log('\nthe same week, fetched twice, is not paid twice');

/* The shape that was live. The Uber collector asked for seven-day ranges
   anchored to whenever the run began, so a backfill starting on a Saturday and
   a catch-up starting on a Sunday stored the same payout week under two keys
   six days apart. Neither row is wrong. Adding them is.

   Measured on the production database before this: one driver's twenty-eight
   weeks were held as sixty-seven rows summing to AED 128,357 against AED
   57,110 on a single grid — so every vehicle earnings figure the product had
   ever shown was inflated by roughly that factor. */
const D = ['2026-09-01', '2026-09-30'];
await pay('d-dup', '2026-09-07', '2026-09-13', 700);   // grid A, a full Mon–Sun week
await pay('d-dup', '2026-09-08', '2026-09-14', 700);   // grid B, the same week shifted a day
for (const d of ['2026-09-07', '2026-09-08', '2026-09-09']) await day('CARF', d, 'd-dup', 10);

const dupRows = await q(attributedEarnings(), D);
const dupTotal = dupRows.filter((r) => r.driver_ext_id === 'd-dup')
  .reduce((a, r) => a + Number(r.attributed), 0);

/* 700 for the week, plus the one day grid B covers that grid A does not
   (14 Sep), which is a seventh of B's week. Not 1,400. */
check('two overlapping reports of one week are not added together',
  near(dupTotal, 700 + 100), String(dupTotal));

const perDay = await q(
  `SELECT day::text, count(*)::int n FROM driver_payout_day
   WHERE driver_ext_id = 'd-dup' GROUP BY 1 HAVING count(*) > 1`);
check('no day is counted twice', perDay.length === 0, JSON.stringify(perDay));

/* And nothing is lost either — the union of both windows is 7 Sep to 14 Sep,
   and every one of those eight days must still be represented somewhere. */
const [{ days }] = await q(
  `SELECT count(*)::int days FROM driver_payout_day WHERE driver_ext_id = 'd-dup'`);
check('and no day is dropped', days === 8, String(days));

/* Bolt and Yango overlap differently: a backfill writes one 31-day row and the
   catch-ups write 4-day rows inside it. The finer report must win the days it
   covers, and the coarse one must still supply the days it does not. */
await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end, earnings)
         VALUES ('bolt','ecosine','d-bolt','2026-09-01','2026-09-30', 3000)`);
await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end, earnings)
         VALUES ('bolt','ecosine','d-bolt','2026-09-10','2026-09-13', 500)`);
const bolt = await q(
  `SELECT round(sum(earnings)::numeric,2) e, count(*)::int days
   FROM driver_payout_day WHERE driver_ext_id = 'd-bolt'`);
/* 26 days from the month at 100/day, plus the four-day report's own 500. */
check('a finer report displaces the coarse one for the days it covers',
  near(bolt[0].e, 2600 + 500) && bolt[0].days === 30,
  `${bolt[0].e} over ${bolt[0].days} days`);

/* The choice has to be stable. Two reads of the same unchanged data returning
   different numbers is worse than a number that is merely wrong, because
   nobody can tell which reading to act on. */
const twice = await Promise.all([
  q(`SELECT round(sum(earnings)::numeric,4) e FROM driver_payout_day`),
  q(`SELECT round(sum(earnings)::numeric,4) e FROM driver_payout_day`),
]);
check('the resolution is deterministic', twice[0][0].e === twice[1][0].e,
  `${twice[0][0].e} then ${twice[1][0].e}`);

/* driver_payout is what the pages LIST, and it must reconcile with the day
   grain it is built from — otherwise a page shows periods that add up to one
   number beside a total that is another. */
const [recon] = await q(
  `SELECT round((SELECT sum(earnings) FROM driver_payout)::numeric,4) a,
          round((SELECT sum(earnings) FROM driver_payout_day)::numeric,4) b`);
check('the period view and the day view sum to the same money',
  recon.a === recon.b, `${recon.a} vs ${recon.b}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
