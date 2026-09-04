/* Which figure is the money, when a channel reports two.
   ─────────────────────────────────────────────────────────────────────────
   A fare is what a rider was charged. A payout is what reached the operator.
   On a commission channel they are the same money at two points, and the
   difference is the platform's cut — so summing fares as income states money
   the fleet never receives.

   chooseBasis used to prefer fares wherever coverage allowed, on the
   reasoning that a payout is what is left of the same fares and the fuller
   figure is the better one. Two production measurements say otherwise.

     UBER. Across 29 priced Ecosine trips of 25-28 August 2026 the service fee
     is 25.00% of the fare on every row: the fare is the payout over three
     quarters, not an independent measurement. And the PAYOUT is what
     reconciles — daily-grain payouts of AED 440,726.21 over 27 July to 30
     August against AED 440,445.31 credited across ten Uber transfers into the
     operator's ENBD and ADCB accounts, +0.06%.

     This was days from landing by itself. Uber's per-trip fares are being
     backfilled; on 2026-09-04 fare coverage stood at 44.4% and Ecosine's most
     recent priced week was already at 91%. At 80% the old rule would have
     flipped Uber's August from AED 428,083 to about AED 640,000 with nothing
     on the page marking the change.

     YANGO, wrong on production the day this was written. Fare coverage 100%,
     fares AED 1,566, payout AED 5,846.06 over the same August window. The old
     rule read the 100% and printed a quarter of what Yango says it paid.

   A fare remains right where a channel reports no payout at all: the hotel
   channel invoices the fare and keeps it, and nothing takes a commission out
   between the booking and the bank. */
import { chooseBasis, fleetIncome } from '../api/income_sql.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const row = (o) => ({ bookings: 0, priced_bookings: 0, fares: null, payouts: null,
  payout_days: 0, booking_days: 0, ...o });

console.log('\na channel that reports both');

/* Uber as it will be once the fare backfill finishes: a fare on nearly every
   booking AND a payout covering every day. The fare is 4/3 of the payout,
   because the service fee is a quarter of it. */
const uber = chooseBasis(row({ platform: 'uber', bookings: 3321, priced_bookings: 3100,
  fares: 570778.19, payouts: 428083.64, payout_days: 31, booking_days: 31 }), 31);
check('is counted on the payout, which is the money that arrived',
  uber.basis === 'payout' && uber.best === 428083.64, `${uber.basis} ${uber.best}`);
check('…even though it prices 93.3% of its bookings',
  uber.fare_coverage_pct >= 80, String(uber.fare_coverage_pct));
check('…and the note says the fare is a larger and different figure',
  /gross the riders paid, which is a larger and different figure/.test(uber.basis_note),
  uber.basis_note);

console.log('\na channel that reports only fares');

const hotel = chooseBasis(row({ platform: 'hotel', bookings: 1631, priced_bookings: 1616,
  fares: 130218.92, payouts: null, payout_days: 0, booking_days: 58 }), 58);
check('is counted on its fares, and keeps them',
  hotel.basis === 'fares' && hotel.best === 130218.92, `${hotel.basis} ${hotel.best}`);
check('…and the note says nothing takes a commission out of them',
  /no payout covering the window/.test(hotel.basis_note), hotel.basis_note);

console.log('\nthe channel this was already wrong for');

/* Production's Yango row, August 2026: every booking priced, and a payout
   nearly four times the fares. */
const yango = chooseBasis(row({ platform: 'yango', bookings: 36, priced_bookings: 36,
  fares: 1566, payouts: 5846.06, payout_days: 115, booking_days: 14 }), 31);
check('takes the AED 5,846 that arrived, not the AED 1,566 of fares',
  yango.basis === 'payout' && yango.best === 5846.06, `${yango.basis} ${yango.best}`);

console.log('\nwhat did not change');

const partial = chooseBasis(row({ platform: 'uber', bookings: 232832, priced_bookings: 0,
  fares: null, payouts: 2401822.21, payout_days: 209, booking_days: 365 }), 365);
check('a payout covering part of the window is still partial_payout',
  partial.basis === 'partial_payout', partial.basis);

const thin = chooseBasis(row({ platform: 'bolt', bookings: 500, priced_bookings: 319,
  fares: 21340.4, payouts: null, payout_days: 0, booking_days: 30 }), 30);
check('fares on two thirds of bookings, with no payout, are still partial_fares',
  thin.basis === 'partial_fares' && thin.best === 21340.4, `${thin.basis} ${thin.best}`);

const nothing = chooseBasis(row({ platform: 'bolt', bookings: 0, booking_days: 0,
  collection_error: 'BOLT_CLIENT_ID is not entitled to company_id 142868 — code=503' }), 30);
check('a channel with no bookings still blames the credential, not the money',
  nothing.basis === 'none' && /not entitled/.test(nothing.basis_note), nothing.basis_note);

console.log('\ncoverage is over the bookings that could carry a fare');

/* A ride nobody took has no fare and never will, so counting it as missing
   coverage describes a collection hole that does not exist. Measured on
   production for August 2026: Bolt priced 312 of its 313 COMPLETED rides —
   99.7% — and the product reported 63.8% and filed the channel under
   partial_fares, the same bucket as a channel reporting no money at all. */
const bolt = chooseBasis(row({ platform: 'bolt', bookings: 560, chargeable_bookings: 313,
  uncharged_bookings: 247, priced_bookings: 312, fares: 21340.4, booking_days: 31 }), 31);
check('a channel that prices every ride it completed reads as covered',
  bolt.fare_coverage_pct === 99.7, String(bolt.fare_coverage_pct));
check('…and is counted on its fares rather than filed as partial',
  bolt.basis === 'fares', `${bolt.basis} — 99.7% is not a partial channel`);
check('the rides that were cancelled and charged nothing get their own count',
  bolt.uncharged_bookings === 247 && bolt.chargeable_bookings === 313,
  `${bolt.uncharged_bookings} / ${bolt.chargeable_bookings}`);

/* A cancellation that DID charge a fee is chargeable and priced, so it counts
   in both halves — the rule is about the fare existing, not the outcome. */
const withFees = chooseBasis(row({ platform: 'bolt', bookings: 100, chargeable_bookings: 60,
  uncharged_bookings: 40, priced_bookings: 60, fares: 3000, booking_days: 30 }), 30);
check('a cancellation fee counts on both sides of the ratio, not one',
  withFees.fare_coverage_pct === 100, String(withFees.fare_coverage_pct));

/* And a row from a caller that has not been taught the finer denominator
   divides the way it always did, rather than by undefined. */
const old = chooseBasis(row({ platform: 'careem', bookings: 400, priced_bookings: 80,
  fares: 5100, booking_days: 31 }), 31);
check('a row with no chargeable count falls back to every booking',
  old.fare_coverage_pct === 20 && old.basis === 'partial_fares',
  `${old.fare_coverage_pct} / ${old.basis}`);

console.log('\nthe fleet total, and the halves it names');

const rows = [
  row({ platform: 'uber', bookings: 3321, priced_bookings: 3100, fares: 570778.19,
    payouts: 428083.64, payout_days: 31, booking_days: 31 }),
  row({ platform: 'hotel', bookings: 1631, priced_bookings: 1616, fares: 130218.92,
    booking_days: 58 }),
  row({ platform: 'yango', bookings: 36, priced_bookings: 36, fares: 1566,
    payouts: 5846.06, payout_days: 115, booking_days: 14 }),
];
const t = fleetIncome(rows, 31);

/* THE assertion. 428,083.64 + 5,846.06 + 130,218.92 = 564,148.62. The old
   rule made it 570,778.19 + 1,566 + 130,218.92 = 702,563.11 — AED 138,414
   the operator was never paid. */
check('the total is the money that arrived, not the money riders were charged',
  t.accounted === 564148.62, String(t.accounted));
check('…and it is NOT the sum the old rule produced',
  t.accounted !== 702563.11, String(t.accounted));
check('the payout half names both commission channels',
  t.accounted_payouts === 433929.7, String(t.accounted_payouts));
check('the fare half is the hotel channel alone',
  t.accounted_fares === 130218.92, String(t.accounted_fares));
/* A denominator that names bookings whose money is in the other half is a
   caption describing a different measurement from the figure above it. */
check('…over its own bookings, not the fleet’s 4,752 priced ones',
  t.accounted_fare_bookings === 1616, String(t.accounted_fare_bookings));
check('and no platform contributes to both halves',
  Math.round((t.accounted_fares + t.accounted_payouts) * 100) / 100 === t.accounted,
  `${t.accounted_fares} + ${t.accounted_payouts} vs ${t.accounted}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
