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

/* ── one day of the ledger, as the columns platform_balance_day stores ──────
   Measured shape, 2026-09-23 (both fleets identical in shape):
     { currency:'AED',
       starting_balance_item:{title:'Starting balance', value},
       ending_balance_item:  {title:'Final balance',    value},
       earnings_items:{ earning_in_app, tips, cancellation_fees, rider_cash_discount, … }
       expenses_items:{ payouts:{title:'Weekly payout', value}, commissions_in_app,
                        commissions_cash, booking_fees, … }
       cash_in_hand_item:{title:'Cash payments to drivers', value},
       glossary_items:[…] }
   Each item is {title, value}. The earnings and expenses are OBJECTS keyed by
   a code, not arrays, and a key is present only on a day that line moved. */

/* WHAT REACHES THE FLEET'S OWN BANK. Matched on Bolt's TITLE, because the
   title is what the glossary defines and the key is not documented anywhere:
     "Weekly payout"        — "Regular weekly payouts to the fleet's bank account"
     "Instant cashout"      — "On-demand payouts to the fleet's bank account"
   and deliberately NOT
     "Tax authority payout" — "Payments made to tax authorities to settle debt
                               or negative balance"
   which leaves the balance without ever reaching the fleet. Counting it would
   report a transfer to the operator's bank that went to the tax office. */
export const BANK_PAYOUT_TITLES = ['weekly payout', 'instant cashout'];

const num = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const itemsOf = (group) => {
  if (!group) return [];
  if (Array.isArray(group)) return group.map((it) => [it?.key ?? null, it]);
  if (typeof group === 'object') return Object.entries(group);
  return [];
};
const r2 = (n) => Math.round(n * 100) / 100;

export function ledgerDay(data) {
  if (!data || typeof data !== 'object') return null;
  const earnings = {};
  let earned = 0;
  for (const [k, it] of itemsOf(data.earnings_items)) {
    const v = num(it?.value);
    if (v === null) continue;
    earnings[k || it?.title || 'unnamed'] = { title: it?.title ?? null, value: v };
    earned += v;
  }
  const expenses = {};
  let spent = 0;
  const payoutLines = [];
  for (const [k, it] of itemsOf(data.expenses_items)) {
    const v = num(it?.value);
    if (v === null) continue;
    expenses[k || it?.title || 'unnamed'] = { title: it?.title ?? null, value: v };
    spent += v;
    const t = String(it?.title || '').trim().toLowerCase();
    if (BANK_PAYOUT_TITLES.includes(t) && v !== 0) {
      payoutLines.push({ key: k, title: it.title, value: v });
    }
  }
  const starting = num(data.starting_balance_item?.value);
  const ending = num(data.ending_balance_item?.value);
  /* The statement's own arithmetic, measured on real days to hold to the fil:
     cash_in_hand is NOT a term — it is cash drivers collected, which never
     passed through the balance. A ledger that does not balance is stored and
     flagged, never silently corrected. */
  const balances = starting === null || ending === null
    ? null
    : Math.abs(r2(starting + earned - spent) - r2(ending)) <= 0.01;
  return {
    currency: String(data.currency || 'AED').toUpperCase(),
    /* Bolt reports a payout as a POSITIVE expense. Stored positive, as
       platform_payout stores every transfer: "this much reached the bank". */
    payout: payoutLines.length ? r2(Math.abs(payoutLines.reduce((a, l) => a + l.value, 0))) : null,
    payout_lines: payoutLines.length ? payoutLines : null,
    starting_balance: starting,
    ending_balance: ending,
    cash_in_hand: num(data.cash_in_hand_item?.value),
    earnings,
    expenses,
    balances,
  };
}

/* THE DATABASE ROW FOR ONE LEDGER DAY, with every JSONB column as a JSON STRING.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT, MEASURED ON PRODUCTION 2026-09-23 05:40 UTC. The first run of
   942f255 wrote the balance summary and then failed every ledger write with
   "invalid input syntax for type json" — for both fleets, so the 21 Sep
   payout this table exists to catch never landed. payout_lines is a JS ARRAY,
   and only on a day that carries a payout. node-postgres binds an array as a
   Postgres ARRAY LITERAL — pg's own prepareValue turns
   [{key:'payouts',...}] into {"{\"key\":...}"} — which a JSONB column
   rejects, and one bad row rolls back the whole eight-day batch. PGlite, which
   every test here runs on, types the parameter from the column and sends JSON,
   so the suite was green over a write production could not do. A plain OBJECT
   is JSON.stringified by node-postgres and was never the problem; all three
   are stringified here anyway, so no column depends on which driver is below.
   test/bolt_ledger_payout.test.mjs runs this row through pg's prepareValue. */
export function ledgerRow(platform, fleet, day, L) {
  const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v));
  return {
    platform, fleet_id: fleet, day, currency: L.currency,
    payout: L.payout, payout_lines: json(L.payout_lines),
    starting_balance: L.starting_balance, ending_balance: L.ending_balance,
    cash_in_hand: L.cash_in_hand, earnings: json(L.earnings), expenses: json(L.expenses),
    balances: L.balances,
  };
}

/* Bolt's next_payout_date is a unix SECOND. Its Dubai calendar day — Dubai is
   UTC+4 all year, and 1790539200 is 2026-09-27T20:00Z, which is MONDAY 28
   September in Dubai and Sunday the 27th in a plain toISOString(). */
export function nextPayoutOn(sec) {
  const s = num(sec);
  if (s === null || s < 1262304000) return null;
  return new Date((s + 4 * 3600) * 1000).toISOString().slice(0, 10);
}

/* How many days back the collector re-reads the ledger each run. Eight covers
   a whole payout week plus a day, so a Monday payout is read on the day it
   leaves and re-read until it is well settled, while the call count stays
   bounded: eight small requests per fleet per run. */
export const LEDGER_DAYS = 8;
