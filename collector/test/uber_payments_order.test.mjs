/* The per-trip fare, and the two ways this parser could quietly lie.
   ─────────────────────────────────────────────────────────────────────────
   Uber's REPORT_TYPE_PAYMENTS_ORDER is one row per TRANSACTION, and the fleet
   spent a day concluding no per-trip fare existed because api/probe.js asked
   about sixteen invented report names instead of Uber's published sixteen.
   It exists, it is valid for this org, and it carries a Trip UUID that joins
   straight onto trip.external_id.

   Two properties matter more than the parsing:

     1. A settlement row is NOT a trip. 'so.payout' carries no Trip UUID and
        its amount is the week's whole wire — the sample's only non-zero
        Transferred To Bank Account is -66863.51, which is exactly the credit
        on the Ecosine ENBD statement for 24 August. Written as a trip price
        that would put a week's bank transfer on one ride.

     2. The column names are a flattened tree AND the provider is inconsistent
        about the separator inside one header row: 'Paid to you : Your earnings'
        with spaces sits beside 'Paid to you:Your earnings:Fare:Fare' without.
        A mapper keyed on either literal reads null for the other, and a null
        fare is indistinguishable from a trip nobody priced. */
import { readFileSync } from 'node:fs';
import { csvToPayments, deriveFare } from '../src/sources/uber.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

/* The header spellings are copied from the live probe of the Ecosine org,
   week of 24-30 August 2026 — including the inconsistent separators. */
const HEAD = [
  'transaction UUID', 'Driver UUID', 'Trip UUID', 'Description',
  'Paid to you', 'Paid to you : Your earnings',
  /* The BRANCH and the LEAF, in the order the live report writes them. They
     carry different numbers whenever a ride was more than base fare, and the
     branch is the fare. */
  'Paid to you : Your earnings : Fare',
  'Paid to you:Your earnings:Fare:Fare',
  'Paid to you:Your earnings:Service fee',
  'Paid to you : Trip balance : Payouts : Cash collected',
  'Paid to you:Your earnings:Tip',
  'Paid to you:Trip balance:Payouts:Transferred To Bank Account',
].join(',');

/* `fare` is the branch; `base` the leaf beneath it. A row that does not say
   otherwise has them equal, which is the ordinary ride. */
const row = (o) => [o.txn, o.drv, o.trip, o.what, o.paid, o.earn,
  o.fare, o.base ?? o.fare,
  o.fee, o.cash, o.tip, o.bank].map((v) => (v == null ? '' : `"${v}"`)).join(',');

const CSV = [HEAD,
  row({ txn: 't1', drv: 'd1', trip: 'TRIP-A', what: 'trip completed order',
    paid: '45.20', earn: '45.20', fare: '60.00', fee: '-14.80', cash: '0', tip: '0', bank: '0' }),
  row({ txn: 't2', drv: 'd1', trip: 'TRIP-B', what: 'Business Order for: marketplace: PERSONAL_TRANSPORT',
    paid: '30.00', earn: '30.00', fare: '40.00', fee: '-10.00', cash: '0', tip: '0', bank: '0' }),
  /* A cash ride: the driver already holds the money. */
  row({ txn: 't3', drv: 'd2', trip: 'TRIP-C', what: 'trip completed order',
    paid: '22.50', earn: '22.50', fare: '30.00', fee: '-7.50', cash: '-30.00', tip: '0', bank: '0' }),
  /* An adjustment DAYS LATER against a ride already priced above. */
  row({ txn: 't4', drv: 'd1', trip: 'TRIP-A', what: 'trip fare adjust order',
    paid: '5.00', earn: '5.00', fare: '0', fee: '0', cash: '0', tip: '0', bank: '0' }),
  /* A tip, also against TRIP-A. */
  row({ txn: 't5', drv: 'd1', trip: 'TRIP-A', what: 'trip completed order',
    paid: '3.00', earn: '3.00', fare: '0', fee: '0', cash: '0', tip: '3.00', bank: '0' }),
  /* THE WIRE. No Trip UUID, and its amount is the whole week's bank credit. */
  row({ txn: 't6', drv: '', trip: '', what: 'so.payout',
    paid: '-66863.51', earn: '0', fare: '0', fee: '0', cash: '0', tip: '0', bank: '-66863.51' }),
].join('\n');

const { trips, settlements } = csvToPayments(CSV);
const byId = Object.fromEntries(trips.map((t) => [t.external_id, t]));

console.log('\nthe fare, from a report that has one');
check('every trip in the report is returned', trips.length === 3,
  `${trips.length}: ${trips.map((t) => t.external_id).join(', ')}`);
check('the fare is the rider-facing fare, not the fleet’s share',
  byId['TRIP-A']?.fare === 60, String(byId['TRIP-A']?.fare));
check('a U4B business order is a ride like any other',
  byId['TRIP-B']?.fare === 40, String(byId['TRIP-B']?.fare));
check('the service fee rides along, negative as the provider writes it',
  byId['TRIP-A']?.service_fee === -14.8, String(byId['TRIP-A']?.service_fee));
check('cash the driver kept is carried, not netted into the fare',
  byId['TRIP-C']?.fare === 30 && byId['TRIP-C']?.cash === -30,
  `${byId['TRIP-C']?.fare} / ${byId['TRIP-C']?.cash}`);

console.log('\nthe settlement row is not a ride');
check('so.payout does not become a trip',
  !trips.some((t) => t.fare === -66863.51 || t.external_id === ''), JSON.stringify(trips.map((t) => t.external_id)));
check('it is returned separately', settlements.length === 1, String(settlements.length));
check('and carries the bank transfer that reconciles to the statement',
  settlements[0]?.bank === -66863.51, String(settlements[0]?.bank));
check('classified as a payout rather than a trip', settlements[0]?.kind === 'payout',
  String(settlements[0]?.kind));

console.log('\nseveral transactions, one ride');
check('a fare adjustment folds onto the trip it corrects',
  byId['TRIP-A']?.adjustment === 5, String(byId['TRIP-A']?.adjustment));
check('and stays OUT of the fare, which is what the rider was charged',
  byId['TRIP-A']?.fare === 60, String(byId['TRIP-A']?.fare));
check('a tip folds on too', byId['TRIP-A']?.tip === 3, String(byId['TRIP-A']?.tip));
check('and the transaction count says how many rows made this row',
  byId['TRIP-A']?.txns === 3, String(byId['TRIP-A']?.txns));
/* Three transactions summed rather than three upserts, the last of which wins:
   45.20 + 5.00 + 3.00. Upserting one after another on (platform, external_id)
   would have left 3.00 as the trip's earnings. */
check('earnings across the three transactions are summed, not overwritten',
  byId['TRIP-A']?.earnings === 53.2, String(byId['TRIP-A']?.earnings));

console.log('\nthe separator the provider is inconsistent about');
/* The live header carries 'Paid to you : Your earnings' AND
   'Paid to you:Your earnings:Fare:Fare'. Both were read above, which is the
   proof; this asserts the normaliser rather than the sample. */
const SPACED = [HEAD.replace(/Paid to you:/g, 'Paid to you : ')
  .replace(/earnings:/g, 'earnings : ').replace(/Fare:/g, 'Fare : '),
row({ txn: 't7', drv: 'd9', trip: 'TRIP-Z', what: 'trip completed order',
  paid: '10', earn: '10', fare: '12.34', fee: '-2', cash: '0', tip: '0', bank: '0' })].join('\n');
const spaced = csvToPayments(SPACED);
check('a header respelled with spaces round every colon still finds the fare',
  spaced.trips[0]?.fare === 12.34, JSON.stringify(spaced.trips[0]));

console.log('\nthe fare is the branch, not the leaf beneath it');

/* MEASURED, 29 priced Ecosine trips of 25-28 August 2026: Uber's service fee
   is 25.00% of the fare BRANCH on every one of them, and the leaf agreed on 19
   and was short on 10. These four are the shapes that differed, with the live
   arithmetic — earnings = branch + fee + 5% VAT on the fee + tip — carried
   into the fixture so the numbers can be checked rather than trusted. */
const TREE = [HEAD,
  // a surge ride: 49.41 branch, 41.28 leaf
  row({ txn: 'x1', drv: 'd9', trip: 'SURGE', what: 'trip completed order',
    paid: '36.44', earn: '36.44', fare: '49.41', base: '41.28', fee: '-12.35',
    cash: '0', tip: '0', bank: '0' }),
  // wait time and a reservation fee: 46.37 against 28.97
  row({ txn: 'x2', drv: 'd9', trip: 'WAIT', what: 'trip completed order',
    paid: '34.20', earn: '34.20', fare: '46.37', base: '28.97', fee: '-11.59',
    cash: '0', tip: '0', bank: '0' }),
  /* THE WORST CASE. A cancellation fee is entirely a child of the branch, so
     the leaf is 0 — and a trip that earned AED 15 was on record as costing
     nothing. That is not an absent figure a reader can see; it is a wrong one
     they cannot. */
  row({ txn: 'x3', drv: 'd9', trip: 'CANCEL', what: 'trip completed order',
    paid: '11.06', earn: '11.06', fare: '15.00', base: '0', fee: '-3.75',
    cash: '0', tip: '0', bank: '0' }),
  // and the ordinary ride, where the two agree and nothing may move
  row({ txn: 'x4', drv: 'd9', trip: 'PLAIN', what: 'trip completed order',
    paid: '41.45', earn: '41.45', fare: '56.20', fee: '-14.05',
    cash: '0', tip: '0', bank: '0' }),
].join('\n');

const tree = csvToPayments(TREE);
const t = Object.fromEntries(tree.trips.map((x) => [x.external_id, x]));

check('a surge ride takes the branch, not the base fare under it',
  t.SURGE?.fare === 49.41, String(t.SURGE?.fare));
check('so does a ride carrying wait time and a reservation fee',
  t.WAIT?.fare === 46.37, String(t.WAIT?.fare));
check('a cancellation fee is a fare, not a free ride',
  t.CANCEL?.fare === 15, String(t.CANCEL?.fare));
check('an ordinary ride is unchanged',
  t.PLAIN?.fare === 56.2, String(t.PLAIN?.fare));

/* The leaf is kept beside the branch rather than discarded: comparing the two
   is how the short reading was found, and an auditor should be able to repeat
   that from the record instead of from a report. */
check('the leaf is kept beside it, for the audit that found this',
  t.SURGE?.fare_base === 41.28 && t.CANCEL?.fare_base === 0,
  `${t.SURGE?.fare_base} / ${t.CANCEL?.fare_base}`);

/* The identity that pins the branch without needing the column at all. If a
   future report renames it, this is the check that catches a wrong reading. */
const implied = (x) => x.earnings - x.service_fee * 1.05 - (x.tip || 0);
check('and the branch is what Uber’s own arithmetic implies, to the fils',
  ['SURGE', 'WAIT', 'CANCEL', 'PLAIN'].every((k) => Math.abs(implied(t[k]) - t[k].fare) < 0.01),
  JSON.stringify(['SURGE', 'WAIT', 'CANCEL', 'PLAIN'].map((k) => [k, +implied(t[k]).toFixed(2), t[k].fare])));
check('…which is the same as saying the service fee is a quarter of it',
  ['SURGE', 'WAIT', 'CANCEL', 'PLAIN'].every((k) => Math.abs(Math.abs(t[k].service_fee) / t[k].fare - 0.25) < 0.001),
  JSON.stringify(['SURGE', 'WAIT', 'CANCEL', 'PLAIN'].map((k) => [k, +(Math.abs(t[k].service_fee) / t[k].fare).toFixed(4)])));

console.log('\nabsence');
const EMPTY = [HEAD, row({ txn: 't8', drv: 'd1', trip: 'TRIP-Q', what: 'trip completed order',
  paid: '', earn: '', fare: '', fee: '', cash: '', tip: '', bank: '' })].join('\n');
const empty = csvToPayments(EMPTY);
check('a blank fare is null, never 0 — a ride nobody priced is not a free ride',
  empty.trips[0]?.fare === null, JSON.stringify(empty.trips[0]));
check('but an explicit 0 is a real value',
  byId['TRIP-A']?.service_fee !== null && byId['TRIP-B']?.cash === 0,
  String(byId['TRIP-B']?.cash));

/* ── the fare a charged cancellation arrives WITHOUT ────────────────────────
   A cancellation that billed the rider reaches this report as a row whose
   description says "adjust", and orderKind sends those down a branch that
   never reads the Fare column — Uber does not populate it on them anyway: the
   live probe's own adjustment row above carries Fare "0" beside a real Paid
   to you of 5.00.

   Alone in a week's report — which is what happens whenever the fee settles
   after the ride's own week closes — that trip came back {fare: null,
   earnings: 11.06}, passed the walk's `both null` filter, and was written
   over the ride's price as NULL. Measured on production 2026-09-08: 8 such
   rows in the trailing thirty days and 27 in May 2026, AED 15.00 to AED 90.00
   each, while the product told the reader they charged nothing.

   The fare is not in the report as a number, but it is there as the identity
   this file already pins forty lines above — service fee is a quarter of the
   fare, plus 5% VAT on the fee. Inverted, that recovers it exactly. */
console.log('\nthe fare of a charged cancellation');
const FEE_ONLY = [HEAD, row({ txn: 'a1', drv: 'd9', trip: 'TRIP-CX', what: 'trip fare adjust order',
  paid: '11.06', earn: '11.06', fare: '0', fee: '-3.75', cash: '0', tip: '0', bank: '0' })].join('\n');
const feeOnly = csvToPayments(FEE_ONLY).trips[0];
check('an adjustment row alone no longer comes back with no fare at all',
  feeOnly.fare === 15, JSON.stringify(feeOnly));
check('…and says the figure was derived, not reported',
  feeOnly.fare_derived === true && feeOnly.fare_seen === false,
  'a derived fare presented as a reported one breaks the rule this fix exists to serve');
check('the derivation is this file\u2019s own arithmetic, inverted',
  Math.abs(deriveFare({ earnings: 11.06, service_fee: -3.75, tip: 0 }) - 15) < 0.01
  && Math.abs(deriveFare({ earnings: 13.27, service_fee: -4.50, tip: 0 }) - 18) < 0.01,
  'measured on production over 2026-05-01..09-08: exact on 2,518 of 2,518 priced blobs');
/* The tip is subtracted, and getting that wrong is not hypothetical — the
   first attempt did, and production named the shapes: fare 15 against
   earnings 16.06, which is 11.06 plus a 5.00 tip. 21 trips in one window. */
check('the tip is taken out first, or every tipped ride derives too high',
  Math.abs(deriveFare({ earnings: 16.06, service_fee: -3.75, tip: 5 }) - 15) < 0.01,
  String(deriveFare({ earnings: 16.06, service_fee: -3.75, tip: 5 })));
check('a row with no service fee cannot be derived, and is not guessed at',
  deriveFare({ earnings: 11.06, service_fee: null, tip: 0 }) === null
  && deriveFare({ earnings: 11.06, service_fee: 0, tip: 0 }) === null
  && deriveFare({ earnings: null, service_fee: -3.75, tip: 0 }) === null);

/* And the case that must NOT change: when the ride and its adjustment are in
   the same report, the fare column was read and the fare stands as Uber
   stated it. Derivation is for the absence of a fare, never a second opinion
   about one. */
check('a reported fare is never replaced by a derived one',
  byId['TRIP-A']?.fare === 60 && byId['TRIP-A']?.fare_derived === undefined
  && byId['TRIP-A']?.fare_seen === true, JSON.stringify(byId['TRIP-A']));
check('and a genuinely blank row still derives nothing',
  empty.trips[0]?.fare === null && empty.trips[0]?.fare_derived === undefined);

/* ── the write, read out of the collector so the test cannot drift from it ──
   The statement is pulled from src/sources/uber.js rather than retyped: a
   copy of the SQL would keep passing after somebody changed the original,
   which is the failure mode this whole file exists to prevent. */
console.log('\nthe write');
const walkSrc = readFileSync('src/sources/uber.js', 'utf8');
check('the price write can never put a null over a price already stored',
  /UPDATE trip SET price = coalesce\(\$3, price\)/.test(walkSrc),
  'the idiom was already one column to the left on the same line, on currency');
check('…and a held row is counted as held rather than as priced',
  /if \(t\.fare == null\) held \+= rowCount; else priced \+= rowCount;/.test(walkSrc),
  'a run reporting priced for a row it wrote null over is how this went unnoticed');
check('the raw blob is still merged for a held row, because it is the evidence',
  /raw = coalesce\(raw, '\{\}'::jsonb\) \|\| \$4::jsonb/.test(walkSrc)
  && !/WHERE[\s\S]{0,80}price IS NULL/.test(walkSrc),
  'dropping the write would throw away the only record that the fee existed');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
