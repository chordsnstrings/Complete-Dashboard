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

/* And what the note may claim once a marketplace reaches this branch. Bolt
   got here the moment coverage was measured properly, taking AED 647,558 of
   365-day fares with it — under a sentence saying nothing takes a commission
   out of the money, about a channel whose commission this fleet has no surface
   for. What the product knows is which KIND of channel it is. */
check('a marketplace on a fares basis is not told it keeps the whole fare',
  /GROSS the rider was charged/.test(bolt.basis_note)
  && /not published to us/.test(bolt.basis_note), bolt.basis_note);
check('…while the channel that invoices and keeps it still says so',
  /nothing takes a commission/.test(hotel.basis_note), hotel.basis_note);
check('and the note counts over the chargeable bookings, not every offer',
  /312 of 313 bookings/.test(bolt.basis_note), bolt.basis_note);


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

console.log('\na channel that reports both, where the payout covers only part of the window');

/* THE defect this section exists for. The 'fares' branch had no
   `payouts == null` guard, so a channel holding a real payout was reported on
   its GROSS fares the moment payout coverage slipped under 80% — and said in
   words that it reports no payout at all.

   Production, the same uber row read at two window lengths, re-measured at
   2026-09-05T18:51Z — the Uber fare backfill is live, so both sides of this
   move and the numbers below are a snapshot rather than constants (the payout
   drifted AED 2,193 and the 365-day fares 5.3% between the first reading of
   this paragraph and this one). /api/revenue?days=240: basis payout, best AED
   2,305,171.07, payout coverage 88.3%, fleet accounted AED 2,772,248.29.
   /api/revenue?days=300: basis fares, best AED 8,220,967.15, payout coverage
   70.7%, fleet accounted AED 8,896,989.27, accounted_payouts down to yango's
   AED 17,744.50 alone — with payouts AED 2,305,171.07 still sitting on the
   row. Dragging one control from 240 days to 300 raised fleet income 3.2x by
   changing what the figure MEANT.

   The row below is that production row, field for field, at 18:51Z. */
const uberPart = chooseBasis(row({ platform: 'uber', bookings: 165803,
  chargeable_bookings: 147780, uncharged_bookings: 18023, priced_bookings: 139499,
  fares: 8220967.15, payouts: 2305171.07, payout_days: 212, booking_days: 300 }), 300);
check('fare coverage 94.4% and payout coverage 70.7%, as production reads them',
  uberPart.fare_coverage_pct === 94.4 && uberPart.payout_coverage_pct === 70.7,
  `${uberPart.fare_coverage_pct} / ${uberPart.payout_coverage_pct}`);
check('a real payout is not thrown away for the gross fare when coverage dips',
  uberPart.basis === 'partial_payout' && uberPart.best === 2305171.07,
  `${uberPart.basis} ${uberPart.best}`);
check('…so the window does not multiply the channel by 3.6x on its own',
  uberPart.best !== 8220967.15, String(uberPart.best));
/* The ordering half of the same defect: 'fares' is tested BEFORE
   partial_payout, which is how a row holding AED 2.3M reached it. The guard is
   what settles it — a row with a payout can now only reach the payout branch
   or partial_payout, whichever order those sit in. Pinned as the property
   rather than as a branch order, because the property is what matters. */
check('no row that holds a payout can land on the fares basis at all',
  [uber, yango, partial, uberPart].every((r) => !(r.payouts != null && r.basis === 'fares')),
  [uber, yango, partial, uberPart].map((r) => `${r.platform}:${r.basis}`).join(' '));

console.log('\nand the note is true of the row it is printed about');

check('the part-covered row is not told it reports no payout',
  !/no payout covering the window/.test(uberPart.basis_note), uberPart.basis_note);
check('it states the days the payout actually covers, and they are the row’s',
  /covering only 212 of the 300 day\(s\)/.test(uberPart.basis_note)
  && /\(70\.7%\)/.test(uberPart.basis_note), uberPart.basis_note);
/* "the rest of this channel's money has not been collected yet" beside a fares
   column of AED 8,220,967.15 reads as though that AED 8.2M were the missing
   part of this payout. It is the other kind of money — gross of a commission
   measured at 25% — over the whole window, not the uncovered end of it. */
check('…and names the fares beside it as the gross they are, not the remainder',
  /139499 of 165803 bookings are the gross/.test(uberPart.basis_note)
  && /not the uncollected remainder/.test(uberPart.basis_note), uberPart.basis_note);
/* And where there are no fares to say it about, it says nothing about them —
   production's 365-day uber row before the fare backfill reached it. */
check('a part-covered row with no fares says nothing about fares',
  !/gross/.test(partial.basis_note) && /covering only 209 of the 365/.test(partial.basis_note),
  partial.basis_note);

/* The other side of the guard: a channel that genuinely reports no payout is
   still counted on its fares, and the sentence claiming so is now true of
   every row that can reach it. */
check('a channel with no payout row at all is still counted on its fares',
  hotel.payouts == null && hotel.basis === 'fares' && hotel.best === 130218.92,
  `${hotel.basis} ${hotel.best}`);
check('…and only such a row is ever told the channel reports no payout',
  [uber, hotel, yango, partial, thin, bolt, uberPart]
    .every((r) => !/reports no payout covering the window/.test(r.basis_note || '')
      || r.payouts == null),
  [uber, hotel, yango, partial, thin, bolt, uberPart]
    .filter((r) => /reports no payout/.test(r.basis_note || ''))
    .map((r) => `${r.platform}:${r.payouts}`).join(' '));

console.log('\nthe fleet total over the window that used to triple it');

/* Production's four channels at days=300, every field as /api/revenue served
   them at 2026-09-05T18:51Z. The old rule made the fleet AED 8,896,989.27 of
   which AED 8,879,244.77 was gross fare; the payout half was yango's AED
   17,744.50 on its own. Both sides move with the backfill, so the assertions
   below are written from these rows rather than quoting a remembered total. */
const rows300 = [
  row({ platform: 'uber', bookings: 165803, chargeable_bookings: 147780,
    uncharged_bookings: 18023, priced_bookings: 139499, fares: 8220967.15,
    payouts: 2305171.07, payout_days: 212, booking_days: 300 }),
  row({ platform: 'bolt', bookings: 22180, chargeable_bookings: 8697,
    uncharged_bookings: 13483, priced_bookings: 8686, fares: 519818.7,
    booking_days: 300 }),
  row({ platform: 'hotel', bookings: 1735, chargeable_bookings: 1735,
    uncharged_bookings: 0, priced_bookings: 1719, fares: 138458.92, booking_days: 61 }),
  row({ platform: 'yango', bookings: 36, chargeable_bookings: 36,
    uncharged_bookings: 0, priced_bookings: 36, fares: 1812, payouts: 17744.5,
    payout_days: 118, booking_days: 14 }),
];
const at300 = fleetIncome(rows300, 300);
check('the fleet counts uber on its payout, not on AED 8.2M of gross fare',
  at300.accounted === 2981193.19, String(at300.accounted));
check('…which is not the AED 8,896,989.27 production printed',
  at300.accounted !== 8896989.27, String(at300.accounted));
check('the payout half is no longer yango alone',
  at300.accounted_payouts === 2322915.57, String(at300.accounted_payouts));
check('the fare half is the two channels that report no payout',
  at300.accounted_fares === 658277.62, String(at300.accounted_fares));
/* A part-covered payout is present money over a stated fraction of the days,
   so uber's bookings belong in undercovered, never in dark. */
check('uber’s bookings are reported as under-covered, not as dark',
  at300.undercovered_bookings === 165803 && at300.undercovered_payouts === 2305171.07
  && at300.undercovered_platforms.join() === 'uber',
  `${at300.undercovered_bookings} / ${at300.undercovered_payouts}`);
check('and the two halves still add to the whole',
  Math.round((at300.accounted_fares + at300.accounted_payouts) * 100) / 100 === at300.accounted,
  `${at300.accounted_fares} + ${at300.accounted_payouts} vs ${at300.accounted}`);

console.log('\nthe claim about the fares is the comparison, not a habit');

/* "a larger and different figure" was printed by both payout branches with
   nothing comparing the fares to the payout — the clause was gated on
   priced_bookings alone. It is false on production today, and has been for
   every window yango appears in. Measured 2026-09-05T18:51Z on /api/revenue:
   yango is basis payout at days=7 with fares AED 357 against a payout of AED
   433.29, at days=14 with AED 1,328 against AED 1,482.94, and at days=300 with
   AED 1,812 against AED 17,744.50. Uber at days=300 is the row the sentence
   was written for and there it holds: AED 8,220,967.15 against AED
   2,305,171.07.

   Pinned as the rule rather than as the wording: a note may claim the fares
   are larger only on a row where they are, and may say they fall short only
   where they do. Reverting the gate turns the three yango rows red. */
const claimAgreesWithFigures = (r) => {
  const note = r.basis_note || '';
  const f = r.fares == null ? null : Number(r.fares);
  const p = r.payouts == null ? null : Number(r.payouts);
  if (/larger and different figure/.test(note)) return f != null && p != null && f > p;
  if (/come to less than this payout/.test(note)) return f != null && p != null && f < p;
  if (/come to exactly this payout/.test(note)) return f != null && p != null && f === p;
  return true;
};

/* Production's yango row at days=7 and at days=14, and the days=300 one, all
   three on the payout branch with fares under the payout. */
const yango7 = chooseBasis(row({ platform: 'yango', bookings: 13, chargeable_bookings: 13,
  priced_bookings: 13, fares: 357, payouts: 433.29, payout_days: 7, booking_days: 4 }), 7);
const yango14 = chooseBasis(row({ platform: 'yango', bookings: 28, chargeable_bookings: 28,
  priced_bookings: 28, fares: 1328, payouts: 1482.94, payout_days: 14, booking_days: 10 }), 14);
const yango300 = chooseBasis(row({ platform: 'yango', bookings: 36, chargeable_bookings: 36,
  priced_bookings: 36, fares: 1812, payouts: 17744.5, payout_days: 118, booking_days: 14 }), 300);
/* And the same shape one branch down: a real payout covering part of the days,
   with fares that do NOT reach it. Nothing on production is here today — yango
   always clears 80% because its payout days exceed its booking days — which is
   exactly why the unguarded sentence had to be gated before a row arrives. */
const smallFarePart = chooseBasis(row({ platform: 'careem', bookings: 900,
  chargeable_bookings: 800, priced_bookings: 700, fares: 40000, payouts: 96000,
  payout_days: 9, booking_days: 30 }), 30);
const equalFare = chooseBasis(row({ platform: 'careem', bookings: 10, chargeable_bookings: 10,
  priced_bookings: 10, fares: 500, payouts: 500, payout_days: 30, booking_days: 30 }), 30);

check('yango at days=7 is on its payout, with fares of 357 under a payout of 433.29',
  yango7.basis === 'payout' && Number(yango7.fares) < Number(yango7.payouts),
  `${yango7.basis} ${yango7.fares} vs ${yango7.payouts}`);
check('…and is NOT told those fares are a larger and different figure',
  !/larger and different figure/.test(yango7.basis_note), yango7.basis_note);
check('…it is told they fall short of the payout, so the pair is not gross and net',
  /come to less than this payout rather than more/.test(yango7.basis_note)
  && /not the gross this net was taken out of/.test(yango7.basis_note), yango7.basis_note);
check('…and the difference is not attributed to a commission that cannot explain it',
  /is not this channel’s commission/.test(yango7.basis_note), yango7.basis_note);
check('the part-covered branch gates the same claim the same way',
  smallFarePart.basis === 'partial_payout'
  && !/larger and different figure/.test(smallFarePart.basis_note)
  && /not the uncollected remainder of it either/.test(smallFarePart.basis_note),
  `${smallFarePart.basis} — ${smallFarePart.basis_note}`);
check('a row whose fares DO exceed its payout still says so, in both branches',
  /larger and different figure/.test(uber.basis_note)
  && /larger and different figure/.test(uberPart.basis_note),
  `${uber.basis_note} || ${uberPart.basis_note}`);
check('and every row built in this file has a claim its own two figures support',
  [uber, hotel, yango, partial, thin, bolt, uberPart, yango7, yango14, yango300,
    smallFarePart, equalFare, ...rows300].every(claimAgreesWithFigures),
  [uber, yango, uberPart, yango7, yango14, yango300, smallFarePart, equalFare]
    .filter((r) => !claimAgreesWithFigures(r))
    .map((r) => `${r.platform} ${r.fares}/${r.payouts}: ${r.basis_note}`).join(' | '));

console.log('\na payout whose day count is missing says which figure is missing');

/* platformPayouts cannot serve this — a non-null sum implies count(DISTINCT
   day) >= 1 — but four callers write `payout_days: ... ?? 0` defensively
   (api/revenue_routes.js:309, api/server.js:607, api/day_routes.js:271,
   api/vehicle_routes.js:367), and before the payouts == null guard such a row
   with good fare coverage went to 'fares' and never printed this note at all.
   Reproduced directly against chooseBasis: "net payout covering only null of
   the null day(s) this channel worked (null%)". */
const noDays = chooseBasis(row({ platform: 'uber', bookings: 100, chargeable_bookings: 100,
  priced_bookings: 95, fares: 5000, payouts: 1234.5, payout_days: 0, booking_days: 30 }), 30);
check('the payout is still real and still what the row is counted on',
  noDays.basis === 'partial_payout' && noDays.best === 1234.5,
  `${noDays.basis} ${noDays.best}`);
check('the note prints no null where a coverage figure should be',
  !/null/.test(noDays.basis_note), noDays.basis_note);
check('…and says which figure is absent rather than implying a coverage of none',
  /reports no day for it in this window/.test(noDays.basis_note)
  && /cannot be stated/.test(noDays.basis_note), noDays.basis_note);
check('…and the coverage fields are absent rather than zero',
  noDays.payout_coverage_pct === null && noDays.payout_coverage_days === null
  && noDays.payout_coverage_base === null,
  `${noDays.payout_coverage_pct} / ${noDays.payout_coverage_days} / ${noDays.payout_coverage_base}`);
/* And the row that DOES have them still prints them, so the branch above is
   not quietly swallowing the coverage sentence for everybody. */
check('a payout that reports its days still states them',
  /covering only 212 of the 300 day\(s\)/.test(uberPart.basis_note), uberPart.basis_note);

console.log('\na payout of exactly zero beside real fares');

/* Watched directly against fleetIncome before the fix: basis partial_payout,
   best 0, and accounted / accounted_fares / accounted_payouts /
   undercovered_payouts all null — AED 500,000 of charged fares left the
   product with no figure and no sentence anywhere. A zero payout is not a
   measurement of nothing: the payout says nothing arrived and the trips say
   something was charged, the rows settle neither, so no figure is taken and
   the fares are named as set aside. */
const zeroPay = row({ platform: 'uber', bookings: 10000, chargeable_bookings: 9000,
  uncharged_bookings: 1000, priced_bookings: 8500, fares: 500000, payouts: 0,
  payout_days: 10, booking_days: 30 });
const tZero = fleetIncome([zeroPay], 30);
check('a zero payout is not taken as the channel’s income',
  zeroPay.basis === 'zero_payout' && zeroPay.best === null,
  `${zeroPay.basis} ${zeroPay.best}`);
check('…and the reason is on the row, in the row’s own terms',
  /sum to exactly zero across the 10 day\(s\) they cover/.test(zeroPay.basis_note)
  && /no net figure to take from them/.test(zeroPay.basis_note), zeroPay.basis_note);
check('…and it is left unstated rather than stated as nothing',
  /left unstated rather than stated as nothing/.test(zeroPay.basis_note), zeroPay.basis_note);
check('the fares are not silently dropped: the note says they were set aside, and why',
  /the fares on 8500 of 10000 bookings are set aside, not counted as income/
    .test(zeroPay.basis_note)
  && /a payout of zero is no evidence/.test(zeroPay.basis_note), zeroPay.basis_note);
/* THE assertion the old shape failed: AED 500,000 was in no field the function
   returns. It is in one now, and it is not in the income halves — a gross fare
   on a commission channel is not income, which is the whole doctrine of
   chooseBasis. */
check('the AED 500,000 reaches a field of its own rather than vanishing',
  tZero.set_aside_fares === 500000 && tZero.set_aside_fare_bookings === 8500
  && tZero.set_aside_bookings === 10000 && tZero.set_aside_platforms.join() === 'uber',
  JSON.stringify([tZero.set_aside_fares, tZero.set_aside_fare_bookings,
    tZero.set_aside_bookings, tZero.set_aside_platforms]));
check('…and is counted in neither half of the income, nor as a green zero',
  tZero.accounted === null && tZero.accounted_fares === null
  && tZero.accounted_payouts === null && tZero.accounted_bookings === 0,
  `${tZero.accounted} / ${tZero.accounted_fares} / ${tZero.accounted_bookings}`);
/* Nor is it dark — the fares exist and were measured; what is missing is which
   of the two figures is the money. Counting it as dark would be the same
   double-description this file already fixed for partial_payout. */
check('…and is not filed as bookings with no money value either',
  tZero.dark_bookings === 0 && tZero.undercovered_bookings === 0,
  `dark=${tZero.dark_bookings} under=${tZero.undercovered_bookings}`);
/* Beside channels that do report money, the zero-payout channel stays out of
   the totals and the totals stay right about themselves. */
const mixed = fleetIncome([
  row({ platform: 'uber', bookings: 10000, chargeable_bookings: 9000, priced_bookings: 8500,
    fares: 500000, payouts: 0, payout_days: 10, booking_days: 30 }),
  row({ platform: 'hotel', bookings: 1631, chargeable_bookings: 1631, priced_bookings: 1616,
    fares: 130218.92, booking_days: 30 }),
], 30);
check('a zero-payout channel does not move the fleet total it is not in',
  mixed.accounted === 130218.92 && mixed.accounted_fares === 130218.92
  && mixed.set_aside_fares === 500000,
  `${mixed.accounted} / ${mixed.accounted_fares} / ${mixed.set_aside_fares}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
