/* Bolt's balance ledger, read as values without letting a person or an
   account out.
   ─────────────────────────────────────────────────────────────────────────
   The operator reported a Bolt payout on Monday 21 September 2026 that
   production did not hold. getPayouts is a lagging register — a Monday-dated
   payout appears in it days later — so the week's payout is looked for in
   Bolt's balance ledger instead, which the probe had only ever reported as key
   names. src/sources/bolt_balance.js turns it into values.

   The values leave the collector through an operator route whose standing
   promise is "no driver and no account number". That promise is what this file
   is mostly about: it must hold whatever shape Bolt sends, including shapes it
   has not sent yet. */
import { balanceValues, balanceSummary, BALANCE_WINDOW_DAYS } from '../src/sources/bolt_balance.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe window the ledger will actually answer');
check('the default is well inside the measured limit — 90 days is refused, 9 and 1 are accepted',
  BALANCE_WINDOW_DAYS >= 1 && BALANCE_WINDOW_DAYS <= 9, String(BALANCE_WINDOW_DAYS));

console.log('\nthe summary: five scalars and nothing else');
{
  const s = balanceSummary({ currency: 'AED', current_balance: 1234.5, next_payout_date: '2026-09-28',
    next_payout_date_text: 'Mon, Sep 28', title: 'Balance', bank_account_number: 'AE070331234567890123456' });
  check('it carries the balance and the next payout date', s.current_balance === 1234.5
    && s.next_payout_date === '2026-09-28' && s.next_payout_date_text === 'Mon, Sep 28', JSON.stringify(s));
  check('it carries nothing it was not asked for — the account number does not ride along',
    !('bank_account_number' in s) && Object.keys(s).length === 5, JSON.stringify(Object.keys(s)));
  check('a field Bolt omitted is null, not undefined and not zero',
    balanceSummary({ currency: 'AED' }).current_balance === null);
  check('no body is no summary, not an empty one', balanceSummary(null) === null);
}

console.log('\nthe ledger lines keep their money');
{
  const stats = { dropped_keys: 0, redacted_values: 0 };
  const v = balanceValues({
    currency: 'AED',
    starting_balance_item: { title: 'Starting balance', amount: 5000.25 },
    ending_balance_item: { title: 'Ending balance', amount: 812.4 },
    earnings_items: [{ title: 'Ride earnings', amount: 9100 }, { title: 'Tips', amount: 40 }],
    expenses_items: [{ title: 'Payout to bank', amount: -12500.1, date: '2026-09-21' }],
  }, 0, stats);
  check('a balance line survives with its title and amount',
    v.starting_balance_item.amount === 5000.25 && v.starting_balance_item.title === 'Starting balance');
  check('an expense line — where a payout to the bank would sit — survives with its date',
    v.expenses_items[0].amount === -12500.1 && v.expenses_items[0].date === '2026-09-21',
    JSON.stringify(v.expenses_items));
  check('a negative amount keeps its sign — money leaving is not money arriving',
    v.expenses_items[0].amount < 0);
  check('nothing was withheld from a clean ledger', stats.dropped_keys === 0 && stats.redacted_values === 0,
    JSON.stringify(stats));
}

console.log('\nthe promise: no driver and no account number, whatever Bolt sends');
{
  const stats = { dropped_keys: 0, redacted_values: 0 };
  const v = balanceValues({
    expenses_items: [
      { title: 'Payout to bank', amount: -100, iban: 'AE070331234567890123456', account_holder: 'Ecosine LLC' },
      { title: 'Adjustment', driver_name: 'Somebody Real', driver_id: 123, amount: -5 },
      { title: 'Payout', amount: -1, note: 'sent to AE07 0331 2345 6789 0123 456' },
      { title: 'Contact', amount: 0, contact: 'finance@example.com' },
      { title: 'Phone', amount: 0, contact: '+971 50 123 4567' },
    ],
  }, 0, stats);
  const flat = JSON.stringify(v);
  check('a key named iban is dropped', !flat.includes('0331234567890123456') && !('iban' in v.expenses_items[0]));
  check('a key naming the account holder is dropped', !('account_holder' in v.expenses_items[0]));
  check('keys naming a driver are dropped', !('driver_name' in v.expenses_items[1]) && !('driver_id' in v.expenses_items[1]),
    JSON.stringify(v.expenses_items[1]));
  check('an IBAN inside free text is redacted even under an innocent key',
    v.expenses_items[2].note === '[redacted]', JSON.stringify(v.expenses_items[2]));
  check('an e-mail address is redacted', v.expenses_items[3].contact === '[redacted]');
  check('a phone number is redacted', v.expenses_items[4].contact === '[redacted]');
  check('what was withheld is COUNTED, so a reader sees something was held back',
    stats.dropped_keys === 4 && stats.redacted_values === 3, JSON.stringify(stats));
  check('the money on those lines still comes through', v.expenses_items[0].amount === -100
    && v.expenses_items[1].amount === -5);
  check('a category title is not mistaken for a person', v.expenses_items[0].title === 'Payout to bank');
}

console.log('\na date is not a phone number');
{
  const st = { dropped_keys: 0, redacted_values: 0 };
  const v = balanceValues({ d: '2026-09-21', dt: '2026-09-21T02:15:00Z', dz: '2026-09-21 06:15:00+04:00',
    text: 'Payout on 2026-09-21', amount: '12500.10' }, 0, st);
  check('an ISO date survives', v.d === '2026-09-21', JSON.stringify(v.d));
  check('an ISO datetime survives, UTC or offset', v.dt === '2026-09-21T02:15:00Z' && v.dz === '2026-09-21 06:15:00+04:00');
  check('a date inside a sentence survives — eight digits is not nine', v.text === 'Payout on 2026-09-21');
  check('an amount written as a string survives', v.amount === '12500.10');
  check('none of that counted as withheld', st.redacted_values === 0, JSON.stringify(st));
}

console.log('\nbounded, so an unexpected shape cannot flood the route');
{
  const big = balanceValues({ items: Array.from({ length: 200 }, (_, i) => ({ amount: i })) });
  check('a long list is capped and says how much it did not show',
    big.items.length === 81 && /120 more not shown/.test(big.items[80]), String(big.items.at(-1)));
  check('a long string is truncated', balanceValues('x'.repeat(500)).length <= 161);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
