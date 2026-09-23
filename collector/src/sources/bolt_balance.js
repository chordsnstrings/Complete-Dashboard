/* Bolt's own statement of the fleet's balance, read as values.
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS. On 2026-09-23 the operator reported that Bolt paid both
   fleets on Monday 21 September. Production held no such payout: getPayouts
   listed 90 Ecosine and 87 Egari rows, newest Monday 14 September, and that
   was not a parsing loss — the probe's raw list length equalled its count of
   rows with a valid `finished` stamp (87 of 87), so Bolt's own list simply did
   not contain the 21st. Measured the previous week, a Monday-dated payout
   appears in getPayouts DAYS after its date: the 14 September row was absent on
   Wednesday the 16th and present by Monday the 21st.

   So getPayouts is a LAGGING register, and a payout that has already reached
   the bank is invisible to it for most of a week. The money leaving the fleet's
   balance is not. Bolt's portal serves two more paths, found in its published
   bundle and probed on 2026-09-22/23:

     getFleetBalanceSummary  POST, no body   → currency, current_balance,
                                               next_payout_date, next_payout_date_text, title
     getFleetBalanceDetails  POST, a window  → currency, starting_balance_item,
                                               ending_balance_item, earnings_items,
                                               expenses_items, cash_in_hand_item,
                                               glossary_items

   getFleetBalanceDetails REFUSES a 90-day window with code 25810
   DATE_RANGE_TOO_BIG and answers code 0 over nine days and over one. The probe
   defaulted to ninety for its whole life, so every probe run reported the
   ledger as refused and nobody learned what was in it.

   This module turns both answers into VALUES that are safe to leave the
   collector: fleet-level money only. The probe that used it promised "no
   driver and no account number leaves this route", and that promise is kept
   here rather than trusted to the shape Bolt happens to send today — a key
   that names a person or a bank account is dropped, and a string that LOOKS
   like one is redacted whatever key it arrived under. */

const PERSONAL_KEY = /driver|phone|e-?mail|iban|swift|bic|account_?(no|num|number|holder)|bank_?account|card_?(no|num|number)|first_?name|last_?name|full_?name/i;
const LOOKS_PERSONAL = [
  /\bAE\d{2}\s?(\d{3}\s?){6,7}\d{0,3}\b/i,      // a UAE IBAN, spaced or not
  /[^\s@]+@[^\s@]+\.[a-z]{2,}/i,                // an e-mail address
  /(?:\d[\s-]?){9,}/,                            // NINE OR MORE DIGITS, separators aside: a phone or an account
];
/* A DATE IS NOT A PHONE NUMBER. The first version of the digit rule matched
   characters rather than digits — "2026-09-21" is ten characters of digits and
   dashes — so it redacted every date in the ledger, which is precisely the
   field that says which day a payout left. test/bolt_balance.test.mjs caught
   it. The rule now counts digits (a date has eight), and an ISO date or
   datetime is exempt outright as a second guard. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const MAX_ITEMS = 80;
const MAX_STR = 160;

/* A deep, bounded, redacted copy of whatever Bolt sent. Scalars survive;
   strings are truncated and checked; arrays are capped and say so; keys that
   name a person or an account are dropped and counted, so a reader can see
   that something was withheld rather than believe it was never sent. */
export function balanceValues(v, depth = 0, stats = { dropped_keys: 0, redacted_values: 0 }) {
  if (v == null) return v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (!ISO_DATE.test(v) && LOOKS_PERSONAL.some((re) => re.test(v))) {
      stats.redacted_values += 1; return '[redacted]';
    }
    return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…` : v;
  }
  if (depth > 6) return '[depth]';
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_ITEMS).map((x) => balanceValues(x, depth + 1, stats));
    if (v.length > MAX_ITEMS) out.push(`[${v.length - MAX_ITEMS} more not shown]`);
    return out;
  }
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (PERSONAL_KEY.test(k)) { stats.dropped_keys += 1; continue; }
      out[k] = balanceValues(x, depth + 1, stats);
    }
    return out;
  }
  return String(v).slice(0, MAX_STR);
}

/* The five scalars getFleetBalanceSummary carries, and nothing else. */
export function balanceSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const pick = (k) => (data[k] === undefined ? null : data[k]);
  return {
    currency: pick('currency'),
    current_balance: pick('current_balance'),
    next_payout_date: pick('next_payout_date'),
    next_payout_date_text: pick('next_payout_date_text'),
    title: pick('title'),
  };
}

/* The window getFleetBalanceDetails will actually answer. Ninety days is
   refused (25810 DATE_RANGE_TOO_BIG); nine and one are accepted. Seven is
   inside what has been measured to work and covers one full payout week,
   which is the question this ledger exists to answer. */
export const BALANCE_WINDOW_DAYS = 7;
