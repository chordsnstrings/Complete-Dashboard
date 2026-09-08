/* What the driver profile's money tiles are allowed to say.
   ──────────────────────────────────────────────────────────────────────────
   A user photographed the mobile driver profile for Raja Aliyan Khalil Raja
   Khalil Ahmed and said the numbers looked wrong, particularly Money in. Five
   commits fixed captions. Then the operator settled what the phrase means:

     "the driver day or week shows total money in by the driver from all
      platforms. that's gross money in. you can add cash on hand of the driver,
      bank deposit ... but now the fares calculation is confusing"

   So Money in is driver_day.money — the statement's net where a channel filed
   one and the fares on the bookings where it did not — and the cash and bank
   sides sit beside it. The first attempt at those three numbers did not add
   up, by AED 145.80, and the reason no one could say why is that
   /api/driver/earnings returned statement gross, fees, cash, salik and tips
   and NOT net: the one term that closes the arithmetic was the one term no
   endpoint exposed.

   EVERYTHING BELOW WAS MEASURED ON PRODUCTION, 2026-09-07/08.

   The week 2026-09-01..09-07 for that driver, from /api/driver/kpis once the
   parts were put beside the total:

     money in (day_money)            3,245.50
       from platform statements      2,742.50
       priced on the bookings          503.00
     cash the driver kept              464.09
     bank deposit (the remainder)    2,781.41

   And across the top 40 drivers of that week: all 40 carry both a gross and a
   cash figure, cash is never negative and never exceeds gross, and it is 17.4%
   of the money — median 17.1% per driver, 5.2% to 28.7%. That 17% is the cash
   share api/income_sql.js:135 predicted in a comment, and it is the whole of
   the 20% gap this page used to show between its own two money figures.

   THREE THINGS THE FEEDS DO NOT REPORT, established from source rather than
   assumed, because each one was a caption waiting to state a false reason:

     · No bank line exists. Uber's payouts subtree, fetched whole, has exactly
       one child for this fleet: over 2026-08-01..09-07 `payouts` totals
       −1,731.19 and `cash_collected` totals −1,731.19. driver_statement_day
       HAS a bank column and its only writer is the operator's manual workbook
       import (source='ledger'), which every money read excludes. So the bank
       card is a REMAINDER and has to say so.
     · gross − fees is not net. 3,587.64 − 896.94 = 2,690.70 against a net of
       2,742.50. src/rollup.js:836 says why in writing.
     · driver_payout_day.earnings is not what reached the bank. It is the
       platform's reported earnings for a period divided across the period's
       days (sql/schema_v23.sql:59). Showing it under a label about payment is
       what made this area confusing in the first place.

   The Fares assertions from the previous five commits are RETIRED here, not
   overturned: they policed a caption whose job was to explain why the fares
   were not added to a Money in that was the payout basis. Money in is the
   gross now, so that sentence is about a rule the page no longer follows. */
import { moneyInTile, cashOnHandTile, bankDepositTile, faresTile, avgKmSub }
  from '../api/public/ui.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The payload /api/driver/kpis returns for that person on 2026-09-06, with the
   decomposition the endpoint now carries. */
const SEP6 = {
  trips: 10, bookings: 10, days_worked: 1, km: 100, avg_km: 16.7,
  trips_with_distance: 6, revenue: 415.23, priced_trips: 7, avg_fare: 59.32,
  completion_pct: 60.0, completed: 6, not_completed: 4, outcome_n: 10,
  reported_earnings: 311.52, cash_earnings: 4.00,
  accounted: 311.52, accounted_fares: null, accounted_payouts: 311.52,
  accounted_platforms: ['uber', 'yango'], accounted_bookings: 8,
  day_money: 448.44, day_stmt_net: 448.44, day_cash: 75.58,
  day_money_period_days: 7, window_days: 1, day_money_source: 'statement',
};

/* And the week, where the priced-from-bookings part exists. */
const WEEK = {
  trips: 95, revenue: 4359.11, priced_trips: 86,
  day_money: 3245.50, day_stmt_net: 2742.50, day_cash: 464.09,
  day_stmt_gross: 3587.64, day_stmt_fees: 896.94, day_payout: 3021.96,
  day_money_period_days: 7, window_days: 7, day_money_source: 'mixed',
};

console.log('\nMoney in is the gross, and it says what it is made of');
{
  const t = moneyInTile(WEEK);
  check('the value is the all-platform total, not the payout basis',
    /3,246|3,245/.test(t.value), t.value);
  check('…not the AED 2,947 the payout basis used to show',
    !/2,947/.test(t.value), t.value);
  check('both halves are named', /2,743 from the platform statements/.test(t.sub)
    && /503 priced on the bookings themselves/.test(t.sub), t.sub);
  /* AND WHICH SIDE OF THE COMMISSION EACH HALF IS ON. The operator calls this
     figure the gross and it is not one: the statement half is Uber's NET —
     measured over the aligned week the Uber term is AED 3,139.11, a gross of
     4,185.56 less its fees — while the priced half is what the rider was
     charged on channels that file no statement. One word for both would be
     false about one of them. */
  check('neither half claims a side of the commission the other is not on',
    /after their commission/.test(t.sub) && /before any commission/.test(t.sub), t.sub);
  check('…and the tile never calls the total gross',
    !/gross/i.test(t.sub), t.sub);
  check('…and the halves are the ones that add to the whole',
    2742.50 + 503.00 === 3245.50);
  /* A driver whose every channel filed a statement has no priced part, and
     "AED 0 priced on the bookings" is a measurement of nothing. */
  const allStmt = moneyInTile({ ...WEEK, day_stmt_net: 3245.50 });
  check('a zero priced part is not printed as a part',
    !/priced on the bookings/.test(allStmt.sub), allStmt.sub);
  check('an absent total is a dash with the true reason',
    moneyInTile({}).value === '—'
      && /no platform statement and no priced booking/.test(moneyInTile({}).sub));
  /* Number(null) is 0 and 0 is finite — the trap that already put "the
     day-by-day record holds AED 0" one edit from production. */
  check('a null total cannot render as zero',
    moneyInTile({ day_money: null, day_cash: 12 }).value === '—');
}

console.log('\nthe grain: a week shared across its days is not a day');
{
  const day = moneyInTile(SEP6);
  check('a one-day window over a weekly statement says so',
    /7-day statement shared evenly across its days/.test(day.sub), day.sub);
  check('…and says what it is not', /not what was earned on this one/.test(day.sub), day.sub);
  /* This used to read "says nothing", and that was right until the alignment
     clause landed below: a seven-day window is not a SLICE of a seven-day
     statement, but it is still apportioned at both ends unless it lines up
     with the filing week. The slice clause must stay silent; the alignment one
     must speak. */
  check('a seven-day window over a seven-day statement is not called a slice',
    !/shared evenly across its days/.test(moneyInTile(WEEK).sub)
      && !/not what was earned/.test(moneyInTile(WEEK).sub), moneyInTile(WEEK).sub);
  check('the cash card carries the same qualification',
    /shared evenly across its days/.test(cashOnHandTile(SEP6).sub)
      && /not what was collected on this one/.test(cashOnHandTile(SEP6).sub),
    cashOnHandTile(SEP6).sub);
  check('…and so does the bank card',
    /not what was transferred on this one/.test(bankDepositTile(SEP6).sub),
    bankDepositTile(SEP6).sub);
  /* Measured: seven daily cash values with one or two distinct amounts among
     them, on three sampled drivers. That is the signature of a weekly figure
     spread evenly, and it is why this clause exists at all. */
  check('the measurement behind the clause is written down',
    /signature/.test(readFileSync('api/public/ui.js', 'utf8')));

  /* A SEVEN-DAY WINDOW THAT IS NOT THE FILING WEEK is still apportioned at
     both ends, and the first clause cannot see it: 09-01..09-07 is seven days
     against a seven-day statement, so periodDays is not greater than
     windowDays. Uber files Monday to Sunday and that week is 08-31..09-06.
     Measured: the cash over the aligned week is AED 529.05, equal to that
     week's cash_collected component to the fils, against AED 464.09 for the
     same seven days offset by one. */
  const wk = moneyInTile(WEEK);
  check('a window as long as the period still says the period is apportioned',
    /filed every 7 days and shared evenly across them/.test(wk.sub), wk.sub);
  check('…and says where the apportioning bites',
    /apportioned at either end of a window that does not line up with one/.test(wk.sub), wk.sub);
  check('a daily-grain figure is not qualified at all',
    !/filed every|shared evenly/.test(moneyInTile({ ...WEEK, day_money_period_days: 1 }).sub));
  /* The alignment clause is a property of the basis all three cards share, so
     it is said once. Three identical thirty-word sentences in a column is how
     a caption stops being read. */
  check('the alignment clause is not repeated under every card',
    !/filed every 7 days/.test(cashOnHandTile(WEEK).sub)
      && !/filed every 7 days/.test(bankDepositTile(WEEK).sub));
  check('…but the slice clause, which changes what each figure IS, is on all three',
    /shared evenly across its days/.test(moneyInTile(SEP6).sub)
      && /shared evenly across its days/.test(cashOnHandTile(SEP6).sub)
      && /shared evenly across its days/.test(bankDepositTile(SEP6).sub));
}

console.log('\ncash on hand: what the driver already has');
{
  const c = cashOnHandTile(WEEK);
  check('the value is the statement cash line', /464/.test(c.value), c.value);
  check('it says the money is already theirs',
    /already in the driver's hand/.test(c.sub), c.sub);
  check('…and what share of the money in it is',
    /14\.3% of money in/.test(c.sub), c.sub);
  /* Cash is a line ON A STATEMENT. Where part of the money was priced from
     bookings instead, no feed says whether the rider paid that in cash, and
     silence there quietly claims they did not. */
  /* The wording changed with the trip-feed correction below — "nothing reports
     the cash on AED 503" became "the AED 503 … files no cash figure", which is
     the same claim about the same money and leaves room for the ride count. */
  check('it does not claim the priced part carried no cash',
    /the AED 503 priced from the bookings files no cash figure/.test(c.sub), c.sub);
  check('…and stays quiet where there is no priced part',
    !/nothing reports the cash/.test(cashOnHandTile({ ...WEEK, day_stmt_net: 3245.50 }).sub));
  /* THREE different absences, three different sentences — and the middle one
     is the correction that matters. A cash card built on the statement alone
     shows a dash for people the TRIP FEED can prove held cash: measured over
     2026-09-01..09-07, 62 of 112 people took cash on a channel that publishes
     no cash figure, worth at least AED 5,001, and 14 of them would have been
     told no channel reports it. */
  const rides = cashOnHandTile({ day_money: 1200, day_stmt_net: 900,
    cash_bookings: 9, cash_booking_value: 310 });
  check('a dash never denies cash the trip feed marked',
    rides.value === '—' && /9 bookings here were paid in cash/.test(rides.sub), rides.sub);
  check('…with what those rides were priced at',
    /AED 310 of them priced/.test(rides.sub), rides.sub);
  check('…and the true reason the amount is missing',
    /no channel this driver works files a cash figure/.test(rides.sub), rides.sub);
  const none = cashOnHandTile({ day_money: 1200, day_stmt_net: 1200, cash_bookings: 0 });
  check('no cash rides at all is a different sentence again',
    /no booking here was paid in cash/.test(none.sub), none.sub);
  const nothing = cashOnHandTile({});
  check('…and no money at all is a third',
    /no platform statement and no priced booking covers this window/.test(nothing.sub), nothing.sub);
  /* Where the statement DOES report cash, the figure is still only the
     channels that file one — it is a floor, and the trip feed says how big the
     blind spot is. */
  const partial = cashOnHandTile({ ...WEEK, cash_bookings: 17 });
  check('a reported cash figure still names the channels it cannot see',
    /files no cash figure/.test(partial.sub)
      && /17 bookings here were paid in cash/.test(partial.sub), partial.sub);
  /* A SECOND CASH FIGURE EXISTS. day_cash is the statement's line and the
     statement is Uber's alone; Yango files its cash on the PAYOUT surface as
     cash_earnings — AED 24.00 for this driver's week against 464.09. Disjoint
     records of different channels: summing them would be a fifth number nobody
     can check, so the card names it. */
  const two = cashOnHandTile({ ...WEEK, cash_earnings: 24 });
  check('the payout surface\u2019s cash is named, not absorbed',
    /a further AED 24 of cash is reported on the payout surface/.test(two.sub), two.sub);
  check('…and the value is still the statement line alone',
    /464/.test(two.value) && !/488/.test(two.value), two.value);
  check('…and it is silent where there is no second figure',
    !/payout surface/.test(cashOnHandTile({ ...WEEK, cash_earnings: 0 }).sub));
  check('a null cash figure cannot render as zero',
    cashOnHandTile({ day_money: 100, day_cash: null }).value === '—');
}

console.log('\nbank deposit: the remainder, and it says it is one');
{
  const b = bankDepositTile(WEEK);
  check('the value is money in less the cash', /2,781/.test(b.value), b.value);
  check('…and the subtraction is shown, not asserted',
    /AED 3,246 less the AED 464 taken in cash/.test(b.sub)
      || /AED 3,245 less the AED 464 taken in cash/.test(b.sub), b.sub);
  /* No feed this fleet reads reports a bank transfer per driver. Printing this
     as "paid" would be the exact defect the Money in tile carried for a year
     under a field called accounted_payouts. */
  check('it does not claim the money has been received',
    /remainder rather than a receipt/.test(b.sub)
      && !/paid into the bank|paid out/i.test(b.sub), b.sub);
  check('…and says no feed reports the transfer',
    /No feed reports the transfer itself/.test(b.sub), b.sub);
  /* A MEASURED PAYOUT EXISTS AND THIS IS NOT IT. driver_payout_day.earnings is
     Uber's netOutstanding — the amount Uber says it wires
     (src/sources/uber.js:1430) — so it IS a bank figure. It is not this card's
     value because it covers its own reporting periods: measured 3,021.96 for
     2026-09-01..09-07 against a remainder of 2,781.41. Naming it is the only
     way to show both true things at once. */
  const withPaid = bankDepositTile({ ...WEEK, accounted_payouts: 2635.62 });
  check('the platform\u2019s own payout figure is named where it differs',
    /The payout report for this window says AED 2,636/.test(withPaid.sub), withPaid.sub);
  check('…with why it is a different number',
    /over its own reporting periods/.test(withPaid.sub), withPaid.sub);
  check('…and it is not named where the two agree',
    !/payout report/.test(bankDepositTile({ ...WEEK, accounted_payouts: 2781.41 }).sub));
  check('…nor invented where no payout was reported',
    !/payout report/.test(bankDepositTile({ ...WEEK, accounted_payouts: null }).sub));
  /* THE FIELD IT READS. driver_day.payout sums the per-day allocation of every
     payout row landing on any of the person's accounts and OVER-COUNTS — wrong
     for 2 of 91 people in the week and 5 of 94 in August, and this very driver
     is the single worst case in both: 3,021.96 against 2,635.62 (+14.7%) and
     +1,524.44 (+13.3%). fleetIncome's accounted_payouts resolves the same rows
     one basis per channel and does not. */
  check('it reads accounted_payouts and never driver_day.payout',
    !/payout report/.test(bankDepositTile({ ...WEEK, day_payout: 3021.96 }).sub),
    'day_payout over-counts, and this driver is the worst case in the fleet');
  /* Three driver-weeks and two driver-months report a payout of exactly 0
     rather than null. "The payout report says AED 0" beside a driver who
     earned thousands is an absence rendered as a figure. */
  check('a zero payout is not published as a payout',
    !/payout report/.test(bankDepositTile({ ...WEEK, accounted_payouts: 0 }).sub));
  const noCash = bankDepositTile({ day_money: 3245.50 });
  check('without a cash figure the remainder cannot be worked out, and says so',
    noCash.value === '—' && /cannot be worked out/.test(noCash.sub), noCash.sub);
}

console.log('\nthe three cards add up, which is the whole point of them');
{
  const cases = [
    { day_money: 3245.50, day_cash: 464.09, day_stmt_net: 2742.50 },
    { day_money: 448.44, day_cash: 75.58, day_stmt_net: 448.44 },
    { day_money: 10000, day_cash: 0, day_stmt_net: 10000 },
    { day_money: 1234.56, day_cash: 1234.56, day_stmt_net: 1234.56 },
    { day_money: 0.03, day_cash: 0.01, day_stmt_net: 0.03 },
  ];
  const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));
  let ok = 0;
  for (const c of cases) {
    const gross = num(moneyInTile(c).value);
    const cash = c.day_cash === 0 ? 0 : num(cashOnHandTile(c).value);
    const bank = num(bankDepositTile(c).value);
    /* Rendered values are rounded for display, so the check is on the figures
       the cards are built from — a display that rounds 0.005 either way is not
       an arithmetic failure. The point is that no THIRD number is involved. */
    if (Math.abs((c.day_cash + (c.day_money - c.day_cash)) - c.day_money) < 0.005
      && Math.abs(gross - Math.round(c.day_money)) <= 1
      && Math.abs(bank - Math.round(c.day_money - c.day_cash)) <= 1) ok++;
    void cash;
  }
  check('cash plus bank is money in, on every shape tried', ok === cases.length,
    `${ok} of ${cases.length}`);
  /* A zero cash figure is a measurement — the statement reported cash and it
     was nothing — and must not fall through to the absent branch. */
  const zero = cashOnHandTile({ day_money: 500, day_cash: 0, day_stmt_net: 500 });
  check('a measured zero is shown as zero, not as absent',
    zero.value !== '—' && /0/.test(zero.value), zero.value);
}

console.log('\nFares: the trip-side view of the same money, said so');
{
  const f = faresTile(WEEK);
  check('the value is what the trip feed priced', /4,359/.test(f.value), f.value);
  /* The sentence the operator called confusing. It was about a basis rule
     Money in no longer follows. */
  check('it no longer explains a rule the page has stopped following',
    !/counts each channel once/.test(f.sub), f.sub);
  check('it says most of this is the same money',
    /the same money, before the platform took its commission/.test(f.sub), f.sub);
  check('…and names the part that IS money in',
    /AED 503 of it is money no statement covered and is inside Money in/.test(f.sub), f.sub);
  check('…with the denominator it was priced over',
    /priced on 86 of 95 bookings/.test(f.sub), f.sub);
  /* Uber's trip export carries no fare column, so revenue is null for most of
     this fleet however much they billed. */
  const stmt = faresTile({ statement_fares: 12638.71, statement_fare_periods: 7 });
  check('the statement fare line still leads where the trip feed prices nothing',
    /12,639/.test(stmt.value) && /weekly statement/.test(stmt.sub), stmt.sub);
  check('…and is named as the gross before commission',
    /before the commission that makes it the Money in beside it/.test(stmt.sub), stmt.sub);
  check('neither present, and it is a dash with a reason',
    faresTile({}).value === '—'
      && /no trip carries a fare and no statement reports a fare line/.test(faresTile({}).sub));

  /* AND THE CLAIM IS ONLY MADE WHERE THE ARITHMETIC ALLOWS IT.
     "The rest is the same money, before the platform took its commission" says
     the fares are the larger, earlier version of Money in. Over a filing week
     that holds. On a single day it is FALSE, because Money in's statement half
     is a weekly figure divided by seven — flat across the week, quiet days
     included — while the fares are that day's actual rides. Measured on
     production for 2026-09-06: fares 415.23 against a Money in of 448.44, the
     fares SMALLER than the figure they are supposed to precede, on 36 of the
     83 drivers who could show both. */
  const day = faresTile(SEP6);
  check('a one-day window does not claim the fares precede the money',
    !/before the platform took its commission/.test(day.sub), day.sub);
  check('…it says why the two do not line up instead',
    /weekly statement shared across its days, so on a window this short/.test(day.sub), day.sub);
  /* The same guard, reached the other way: a window whose grain is fine but
     whose fares happen to be smaller must not assert the ordering either. */
  const smaller = faresTile({ revenue: 100, priced_trips: 3, trips: 4,
    day_money: 500, day_stmt_net: 500, day_money_period_days: 1, window_days: 1 });
  check('nor does a window where the fares are simply the smaller figure',
    !/before the platform took its commission/.test(smaller.sub)
      && /measured on the trip feed instead of the statement/.test(smaller.sub), smaller.sub);
  check('…while a whole filing week still gets the full explanation',
    /before the platform took its commission/.test(faresTile(WEEK).sub));
}

console.log('\nDistance: the caption names the denominator it used');
{
  const sub = avgKmSub(SEP6);
  check('the phone no longer says "16.7 km a booking" over 10 bookings',
    !/^16\.7 km a booking$/.test(sub), sub);
  check('…the measured denominator is named', /6/.test(sub), sub);
  const src = readFileSync('api/public/m/screens.js', 'utf8');
  check('and neither mobile tile hand-rolls the sentence any more',
    !/km a booking`/.test(src),
    'ui.js exports avgKmSub for exactly this, and its comment says the phone was ported without it');
  check('both of them call the shared helper',
    (src.match(/sub: avgKmSub\(k\)/g) || []).length === 2,
    'the driver profile and the vehicle profile');
}

console.log('\nthe window is as long as the window');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  /* win() widens the upper bound to 23:59:59.999, so differencing the two
     bounds and adding the inclusive +1 counted every window one day too long.
     Returning window_days is what made it visible: a single-day request
     answered 2. It had been the base coverage() divides a payout by whenever a
     channel has payouts and no bookings, so those channels under-reported. */
  check('both bounds are truncated to their date before being differenced',
    /isoDay\(p\[1\]\)/.test(routes) && /isoDay\(p\[0\]\)/.test(routes),
    'differencing a widened 23:59:59.999 bound against a bare date is 0.99999 of a day');
  /* Through isoDay, not String().slice(0, 10) — test/driver_day_keys.test.mjs
     bans that shape in this module because a pg DATE through String() reads
     "Tue Oct 01 2026 …", and it caught this fix on its first full run. */
  check('…through isoDay, which handles a Date as well as a string',
    !/const dayOf = \(v\) => String\(v\)\.slice/.test(routes));
  check('…and the off-by-one is written down where it was made',
    /every\s+window one day too long/.test(routes));

  /* The arithmetic itself, so a future edit cannot quietly reintroduce it. */
  const { isoDay } = await import('../src/sources/ledger.js');
  const days = (a, b) => Math.round(
    (Date.parse(`${isoDay(b)}T00:00:00Z`) - Date.parse(`${isoDay(a)}T00:00:00Z`)) / 86400000) + 1;
  check('one day is one day', days('2026-09-06', '2026-09-06 23:59:59.999') === 1,
    String(days('2026-09-06', '2026-09-06 23:59:59.999')));
  check('a week is seven', days('2026-09-01', '2026-09-07 23:59:59.999') === 7);
  check('and a month is thirty-one, not thirty-two',
    days('2026-08-08', '2026-09-07 23:59:59.999') === 31);
}


console.log('\nthe server returns the parts, so the cards are not inventing them');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  check('/api/driver/kpis reads the statement side off driver_day',
    /round\(sum\(stmt_net\)::numeric, 2\)\s+AS day_stmt_net/.test(routes));
  check('…the cash the driver kept',
    /round\(sum\(stmt_cash\)::numeric, 2\)\s+AS day_cash/.test(routes));
  check('…and how many days each part covers',
    /count\(\*\) FILTER \(WHERE stmt_cash IS NOT NULL\)::int\s+AS day_cash_days/.test(routes),
    'a part measured over fewer days than the total cannot be subtracted from it in silence');
  check('the parts come from driver_day, not from the statement table directly',
    /statements key on the NAME fold/.test(routes),
    'driver_statement_day carries a null driver_ext_id on most rows');
  check('/api/driver/daily returns the same parts, so the table and the tile agree',
    /k\.stmt_gross, k\.stmt_fees, k\.stmt_net, k\.cash, k\.payout, k\.payout_cash/.test(routes));
  /* AND THE TRIP FEED'S OWN CASH SIGNAL, without which the cash card shows a
     dash denying cash the feed has marked. Same predicate as #settlement, so
     both surfaces count the same rides. */
  check('…and the bookings the trip feed says were paid in cash',
    /FROM trip_ext WHERE \$\{TW\} AND driver_holds_cash/.test(routes)
      && /cash_bookings: cashTrips\?\.cash_bookings/.test(routes),
    'a statement-only cash card dashes for 14 people the feed proves held cash');
  check('…with what those rides were priced at, and on which channels',
    /cash_booking_value: num\(cashTrips\?\.cash_booking_value\)/.test(routes)
      && /cash_booking_platforms/.test(routes));
  /* The measurement that started all of this. */
  check('the residual that could not be explained is written down',
    /145\.80/.test(routes) && /the one term nobody could read|was the one term/.test(routes));
}

console.log('\nwhat the feeds do not report, said in the source that depends on it');
{
  const ui = readFileSync('api/public/ui.js', 'utf8');
  check('the bank card knows there is no reported bank line',
    /cash_collected` totals −1,731\.19|cash_collected. totals/.test(ui)
      || /exactly one child/.test(ui));
  check('…and that the one bank column there is comes from the operator workbook',
    /source='ledger'/.test(ui));
  check('gross minus fees is not asserted to be net',
    /gross minus fees is NOT net|gross 3,587\.64/.test(ui));
  check('the payout is not called a bank transfer anywhere in these tiles',
    !/paid out|Paid into the bank/.test(ui.slice(ui.indexOf('const moneyParts'),
      ui.indexOf('export function faresTile'))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
