/* WHAT A CASH FARE IS WORTH, DECIDED IN ONE PLACE.
   ══════════════════════════════════════════════════════════════════════════
   The operator's rule, 2026-09-22: "Cash trips are cash to the driver unless
   they give it to the company." So cash in hand is a real running liability —
   it rises when the driver takes the money and falls only on a hand-in. There
   is deliberately no +1 cash type in ledger_type; the increase is a MEASURED
   term, and sql/schema_v80.sql's trip_cash view is where it is measured.

   Two surfaces read it: /api/ledger/exposure's `collected` CTE and the
   per-person register. api/public/settlement.js:203-210 records what happened
   the last time two surfaces each carried their own idea of a cash figure.

   THREE THINGS THIS PINS, all of which were wrong in the CTE it replaces:

   1. A CANCELLED cash trip puts no cash in a hand. The old CTE had no outcome
      filter and counted person 202's cancelled 2026-09-20 trip as an unpriced
      cash collection, inflating its own floor claim.

   2. `price` is what the RIDER was charged; the platform's payments report
      says what the DRIVER took, and they differ. Measured on production:
      fare 29.83 against cash_collected 67.13, and +5.00 on 32 of 51 sampled
      cash trips — a Salik gate the rider paid in cash at the window.

   3. `offline` and `derivative` are NOT cash. Measured over 733 Uber trips in
      two independent samples, 70+ drivers, zero counter-examples: only
      payment_type 'cash' ever carries a non-zero cash_collected. Treating
      `offline` as cash would have overstated one person's holding by 3.7x. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

const trip = (id, o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name,
                     requested_at, status, payment_type, price, currency, raw)
   VALUES ('uber',$1,'ecosine','d1','Driver One','2026-09-15T10:00:00Z',
           $2,$3,$4,'AED',$5::jsonb)`,
  [id, o.status || 'completed', o.pay, o.price ?? null, JSON.stringify(o.raw || {})]);

const pay = (cash) => ({ uber_payments: { cash_collected: cash, service_fee: -7.46 } });

/* The shapes, one per row of the table this view has to get right. */
await trip('t-cash-paid',   { pay: 'cash',       price: 29.83, raw: pay(-67.13) });
await trip('t-cash-nopay',  { pay: 'cash',       price: 113.77 });
await trip('t-cash-cancel', { pay: 'cash',       price: null, status: 'rider_cancelled', raw: pay(-40) });
await trip('t-cash-unval',  { pay: 'cash',       price: null });
await trip('t-hotel',       { pay: 'cash-driver', price: 30.00 });
await trip('t-offline',     { pay: 'offline',    price: 133.64, raw: pay(0) });
await trip('t-derivative',  { pay: 'derivative', price: 70.45, raw: pay(0) });
await trip('t-card',        { pay: 'braintree',  price: 100.53 });
await trip('t-applepay',    { pay: 'apple_pay',  price: 140.43 });

const rows = await q(`SELECT external_id, fare, cash_reported, cash_amount, cash_basis
                        FROM trip_cash ORDER BY external_id`);
const by = Object.fromEntries(rows.map((r) => [r.external_id, r]));

console.log('\nwhich trips put cash in a hand');
check('a cash trip is in', !!by['t-cash-paid']);
check('and the hotel channel\'s cash-driver is too', !!by['t-hotel']);
check('a card trip is NOT — the rider paid the platform',
  !by['t-card'] && !by['t-applepay'], JSON.stringify(Object.keys(by)));

/* THE MEASURED ONES. 733 trips, two samples, zero counter-examples. */
check('OFFLINE is not cash — Uber settles it and pays the fleet on the statement',
  !by['t-offline'], 'offline counted as cash overstates one person 3.7x');
check('and neither is DERIVATIVE', !by['t-derivative']);

/* THE ONE THE OLD CTE GOT WRONG. */
check('a CANCELLED cash trip is excluded — no fare was charged, no cash moved',
  !by['t-cash-cancel'], 'a cancelled trip was being counted as an unpriced collection');

console.log('\nwhat it is worth, and which figure said so');
check('where the payments report survives, the amount is what the DRIVER took',
  Number(by['t-cash-paid'].cash_amount) === 67.13, JSON.stringify(by['t-cash-paid']));
check('not what the rider was charged — the two differ and the fare is the smaller',
  Number(by['t-cash-paid'].fare) === 29.83
  && Number(by['t-cash-paid'].cash_amount) > Number(by['t-cash-paid'].fare),
  JSON.stringify(by['t-cash-paid']));
check('and the row says which figure it used',
  by['t-cash-paid'].cash_basis === 'payments_report', by['t-cash-paid'].cash_basis);

check('where the blob is gone it falls back to the fare',
  Number(by['t-cash-nopay'].cash_amount) === 113.77, JSON.stringify(by['t-cash-nopay']));
check('and SAYS it fell back, because the fare understates what was taken',
  by['t-cash-nopay'].cash_basis === 'fare_only', by['t-cash-nopay'].cash_basis);

/* PRESENT WITH A NULL, NOT ABSENT. A caller must be able to COUNT what it
   cannot value; dropping the row turns a floor into something that looks
   like a total. */
check('a cash trip with neither figure is still listed, with a null amount',
  !!by['t-cash-unval'] && by['t-cash-unval'].cash_amount === null,
  JSON.stringify(by['t-cash-unval']));
check('and is flagged unvalued rather than guessed at',
  by['t-cash-unval'].cash_basis === 'unvalued', by['t-cash-unval'].cash_basis);

console.log('\nthe sign is a claim about a hand, not about a platform ledger');
/* Uber files it negative — money leaving its side. The claim here is "this
   much is in a hand", which is positive, and a view that passed the sign
   through would subtract a driver's cash from what they owe. */
check('the platform files it negative and this view reports it positive',
  Number(by['t-cash-paid'].cash_reported) === 67.13, String(by['t-cash-paid'].cash_reported));

console.log(`\n${fail ? '✗' : '✓'} trip_cash: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
