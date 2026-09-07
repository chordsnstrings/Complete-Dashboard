/* What the Money in, Fares and Distance tiles are allowed to say.
   ──────────────────────────────────────────────────────────────────────────
   A user photographed the mobile driver profile for Raja Aliyan Khalil Raja
   Khalil Ahmed and said the numbers looked wrong, particularly Money in. The
   page turned out to be rendering /api/driver/kpis faithfully — the window was
   2026-09-06 and every figure matched the endpoint — so the defect was not
   arithmetic. It was three captions, each describing a different measurement
   from the one above it.

   Everything asserted here was measured on production on 2026-09-07, over the
   87 drivers who worked 2026-09-06:

     · 70 of 87 were told "no trip carries a fare and no statement reports one"
       while their own response carried AED 24,731.32 of fares across 415
       priced bookings.
     · 39 of 87 had a distance denominator smaller than their booking count,
       overstating "km a booking" by 26% at the median and 197% at the worst.
     · The payout figure on a one-day window is a share of a longer payout
       period, divided evenly across its days, and read "paid out".

   The money itself is NOT wrong and none of these fixes changes a number: the
   seven daily payouts of that week sum to AED 2,635.64 against the week's
   AED 2,635.62. What changes is that each figure now names what it is. */
import { moneyInTile, faresTile, avgKmSub } from '../api/public/ui.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The exact payload /api/driver/kpis returned for that person on that day. */
const SEP6 = {
  trips: 10, bookings: 10, days_worked: 1, km: 100, avg_km: 16.7,
  trips_with_distance: 6, revenue: 415.23, priced_trips: 7, avg_fare: 59.32,
  completion_pct: 60.0, completed: 6, not_completed: 4, outcome_n: 10,
  reported_earnings: 311.52, cash_earnings: 4.00,
  accounted: 311.52, accounted_fares: null, accounted_payouts: 311.52,
  accounted_platforms: ['uber', 'yango'], accounted_bookings: 8,
  accounted_fare_bookings: null, statement_fares: null, statement_fare_periods: 0,
  dark_bookings: 2, dark_pct: 20,
  payout_period_days: 7, payout_periods: 2, window_days: 1,
};

console.log('\nFares: the tile may not deny fares the same response carries');
{
  const t = faresTile(SEP6);
  check('a window whose channels were all counted on payout still shows its fares',
    t.value !== '—',
    `got ${JSON.stringify(t)}`);
  check('…as the figure the trip feed actually priced',
    /415/.test(String(t.value)), `got ${t.value}`);
  check('the false sentence is gone',
    !/no trip carries a fare/.test(t.sub),
    'AED 415.23 across 7 priced bookings was sitting in the same response');
  check('…and the denominator is named, not implied',
    /7 of 10 bookings/.test(t.sub), t.sub);
  check('…with the reason it is not added to Money in',
    /not added to Money in/.test(t.sub), t.sub);

  console.log('\n  and the honest dash is still reachable');
  const nothing = faresTile({ trips: 4, revenue: null, accounted_fares: null, statement_fares: null });
  check('no fare anywhere really does print a dash', nothing.value === '—');
  check('…with the sentence that is true in that case',
    /no trip carries a fare and no statement reports one/.test(nothing.sub));
  const zero = faresTile({ trips: 4, revenue: 0, accounted_fares: null, statement_fares: null });
  check('a revenue of exactly 0 is absent, not a fare of nothing',
    zero.value === '—', JSON.stringify(zero));

  console.log('\n  the earlier branches still win where they apply');
  check('accounted_fares still leads when a channel was counted on fares',
    faresTile({ ...SEP6, accounted_fares: 139 }).value.includes('139'));

  /* BRANCH 1 had the same defect and was the last one holding it.
     ───────────────────────────────────────────────────────────────────────
     The value sums only the channels counted on their FARES; the caption was
     avg_fare, which averages every priced booking in the window whatever
     channel it belongs to. Measured on production 2026-09-01..09-07 for this
     driver: "AED 311 · avg fare AED 51", where 311 is 5 Bolt bookings at AED
     62 and 51 is 4,359.11 over 86 — a denominator 17x the tile's own. Ten of
     the 58 drivers on this branch printed a total SMALLER than the average
     beneath it, which no count of one or more can produce. */
  const B1 = { trips: 95, accounted_fares: 311, accounted_fare_bookings: 5,
    avg_fare: 50.69, revenue: 4359.11, priced_trips: 86 };
  const b1 = faresTile(B1);
  check('branch 1 no longer captions its own total with every channel\'s average',
    !/avg fare AED 51/.test(b1.sub), b1.sub);
  check('…it divides by the bookings the figure is made of',
    /avg AED 62/.test(b1.sub), b1.sub);
  check('…and names that denominator',
    /over the 5 bookings this counts/.test(b1.sub), b1.sub);
  check('…so the average can never exceed the total it sits under',
    Number(b1.value.replace(/[^0-9.]/g, '')) >= 62,
    '"AED 30 · avg fare AED 84" was on production for ten drivers');
  check('…and the larger figure it did not add is named, as in the branches below',
    /trip feed prices AED 4,359 over 86 bookings/.test(b1.sub), b1.sub);
  check('…with why it is not in the total',
    /counted on its channel's payout/.test(b1.sub), b1.sub);
  /* accounted_fare_bookings is `|| null` in income_sql.js, and 139/null is
     Infinity, which money() renders as a dash. Live data cannot make that
     shape; a hand-made payload in a test or mockapi.mjs can. */
  check('a null denominator falls back rather than dividing by it',
    faresTile({ accounted_fares: 139, accounted_fare_bookings: null }).sub
      === 'where the platform reports fares');
  check('…and zero does too',
    !/Infinity|NaN|—/.test(faresTile({ accounted_fares: 139, accounted_fare_bookings: 0 }).sub));
  /* accounted_platforms is every MEASURED channel, payout-basis ones included
     (income_sql.js:530) — naming it here would print "on Bolt, Uber, Yango"
     under a Bolt-only figure, which is this same defect in a new place. */
  check('the channel is not named from accounted_platforms',
    !/Bolt|Uber|Yango/i.test(faresTile({ ...B1,
      accounted_platforms: ['bolt', 'uber', 'yango'] }).sub),
    'that list includes channels whose money is NOT in this figure');
  const withStmt = faresTile({ ...SEP6, statement_fares: 12638.71, statement_fare_periods: 7 });
  check('the statement figure still leads over raw trip revenue',
    /weekly statement/.test(withStmt.sub));
  /* The branch-2 clause was the SAME falsehood, and the first version of this
     fix landed on branch 3 only — this test blessed it by asserting nothing
     about the sentence. Measured on production: 1,881 priced bookings behind
     the claim that no trip carried a fare. */
  check('…and it no longer claims no trip carries a fare when trips do',
    !/no trip here carries a fare/.test(withStmt.sub), withStmt.sub);
  check('…it names what the trip feed priced instead',
    /trip feed prices/.test(withStmt.sub) && /415/.test(withStmt.sub), withStmt.sub);
  check('…and still says the payout came out of the gross',
    /payout beside it came out of this/.test(withStmt.sub));
  const stmtOnly = faresTile({ trips: 9, revenue: null, accounted_fares: null,
    statement_fares: 5000, statement_fare_periods: 2 });
  check('a statement over trips that really carry no fare keeps the true sentence',
    /no trip here carries a fare/.test(stmtOnly.sub), stmtOnly.sub);
}

console.log('\nMoney in: "paid out" has to mean paid out');
{
  const t = moneyInTile(SEP6);
  check('the figure itself is unchanged', /311\.52|312/.test(String(t.value)), String(t.value));
  check('a one-day window over a seven-day payout does NOT say "paid out"',
    !/paid out/.test(t.sub),
    'driver_payout_day.earnings is period earnings divided by the period\'s days');
  check('…it says the period it was shared out of',
    /7-day payout period/.test(t.sub), t.sub);
  /* payout_periods is DISTINCT (platform, period_start, period_end), so two
     channels filing one week make it 2 — the caption must not print that as a
     number of time periods. */
  check('…without printing a per-channel period count as a number of periods',
    !/2 of them/.test(t.sub), t.sub);
  check('…and that the share was even, not measured',
    /shared evenly across its days/.test(t.sub), t.sub);
  check('…and that it is not what was paid for the day being shown',
    /not what was paid for this one/.test(t.sub), t.sub);
  check('the channels are still named', /Uber/.test(t.sub) && /Yango/.test(t.sub), t.sub);

  console.log('\n  a window that contains whole periods is left alone');
  const whole = moneyInTile({ ...SEP6, window_days: 30, payout_period_days: 7 });
  check('30 days over 7-day periods still reads "paid out"',
    /paid out/.test(whole.sub), whole.sub);
  check('…and carries no share caveat', !/shared evenly/.test(whole.sub), whole.sub);
  const same = moneyInTile({ ...SEP6, window_days: 7, payout_period_days: 7 });
  check('a window exactly as long as the period is not a share either',
    /paid out/.test(same.sub) && !/shared evenly/.test(same.sub), same.sub);

  console.log('\n  and it never invents the qualification');
  const noGrain = moneyInTile({ ...SEP6, payout_period_days: null, window_days: 1 });
  check('an unknown period length does not claim a share',
    /paid out/.test(noGrain.sub) && !/shared evenly/.test(noGrain.sub), noGrain.sub);
  const noMoney = moneyInTile({ accounted: null });
  check('no money at all is still absent with its reason',
    noMoney.value === '—' && /no fare and no payout statement/.test(noMoney.sub));
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

console.log('\nthe server returns the grain, so the tile is not guessing');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  check('/api/driver/kpis returns how long the payout period was',
    /max\(period_days\)::int payout_period_days/.test(routes));
  check('…how many periods covered the window',
    /count\(DISTINCT \(platform, period_start, period_end\)\)::int payout_periods/.test(routes));
  check('…and the window it was asked for',
    /window_days: windowDays/.test(routes),
    'without both halves the tile cannot tell a whole payout from a share of one');
  check('the reasoning is written down where the column is read',
    /a week divided by seven and printed as a measurement/.test(routes)
      && /THE GRAIN THE MONEY WAS FILED AT/.test(routes),
    'this file already refused the same view\'s hours for this reason');
}

console.log('\nMoney in and the other record of the same days');
{
  /* THE PAGE CONTRADICTED ITSELF AND SAID NOTHING.
     ───────────────────────────────────────────────────────────────────────
     `accounted` is per channel the PAYOUT where one exists and the fares
     where it does not; it never reads a statement. driver_day.money — the
     Money column the same profile prints day by day, and the figure the
     People list ranks on — is per channel the STATEMENT'S NET where a channel
     filed one and its fares where it did not; it never reads a payout.

     Measured on production 2026-09-07 for the driver this came in about,
     2026-09-01..09-07: the tile read AED 2,946.62, the seven daily rows of
     the same window summed to AED 3,231.88. Fleet-wide over 2026-08-01..
     08-31, /api/drivers/leaderboard returns both columns on one row and ALL
     91 people carrying both disagreed — AED 513,264 of money against AED
     410,017 of payout, 20% apart, which is the cash share income_sql.js:135
     predicts. Neither figure changes here. */
  const WEEK = { accounted: 2946.62, accounted_fares: 311, accounted_payouts: 2635.62,
    accounted_platforms: ['bolt', 'uber', 'yango'],
    payout_period_days: 7, window_days: 7,
    day_money: 3231.88, day_money_days: 7, day_money_period_days: 7,
    day_money_source: 'mixed' };
  const t = moneyInTile(WEEK);
  check('the tile still shows the figure it is made of', t.value.includes('2,947'), t.value);
  check('…and no longer hides the other record of the same days',
    /3,232/.test(t.sub), t.sub);
  check('…naming where that one came from',
    /statements and fares together/.test(t.sub), t.sub);
  check('…and what separates the two records',
    /gross minus commission/.test(t.sub) && /reached the bank/.test(t.sub), t.sub);
  check('…marked long, or the phone drops the caption it was given',
    t.long === true);

  /* The explanatory half is gated on the two records actually BEING the ones
     the sentence describes. A page that prints "a statement's net is gross
     minus commission" over a figure no statement touched is this same defect
     in a new place. */
  const noStmt = moneyInTile({ ...WEEK, day_money_source: 'fares', day_money: 3231.88 });
  check('a fares-only day record is named as fares',
    /the fares on the bookings/.test(noStmt.sub), noStmt.sub);
  check('…and no commission sentence is printed over it',
    !/gross minus commission/.test(noStmt.sub), noStmt.sub);
  const noPayout = moneyInTile({ ...WEEK, accounted_payouts: null, accounted_fares: 2946.62 });
  check('…nor where this figure took no payout',
    !/reached the bank/.test(noPayout.sub), noPayout.sub);
  check('…though the other record is still named',
    /3,232/.test(noPayout.sub), noPayout.sub);

  /* Silence where they agree: a sentence that fires on every driver whatever
     the data says is decoration, and the reader stops reading it. */
  const same = moneyInTile({ ...WEEK, day_money: 2946.62 });
  check('nothing is said where the two records agree',
    !/day-by-day/.test(same.sub), same.sub);
  check('…and rounding noise is not a disagreement',
    !/day-by-day/.test(moneyInTile({ ...WEEK, day_money: 2946.9 }).sub));
  check('a missing day record says nothing rather than guessing',
    !/day-by-day/.test(moneyInTile({ ...WEEK, day_money: null }).sub));
  check('…and a non-numeric one cannot reach the sentence',
    !/day-by-day/.test(moneyInTile({ ...WEEK, day_money: 'n/a' }).sub));

  /* Both clauses can be true at once — a one-day window over a weekly payout
     that also disagrees with the day record — and the tile owes the reader
     both, in that order: its own grain first, then the other record. */
  const day = moneyInTile({ ...WEEK, window_days: 1, day_money: 448.44, accounted: 311.52 });
  check('the grain clause and the other-record clause both survive together',
    /payout period shared evenly/.test(day.sub) && /day-by-day/.test(day.sub), day.sub);
  check('…the tile’s own grain first',
    day.sub.indexOf('payout period shared') < day.sub.indexOf('day-by-day'), day.sub);
}

console.log('\nthe server returns the other record, so the tile is not recomputing it');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  /* The alias and the predicate in ONE statement. Matching the predicate
     alone passes against the UNCHANGED file — /api/driver/daily's own k CTE
     reads driver_day with exactly these bounds — and an assertion that is
     already true before the fix has proved nothing. Verified by reverting the
     route and watching this line go red. */
  check('/api/driver/kpis reads driver_day for the same person and window',
    /AS day_money,[\s\S]{0,1600}?FROM driver_day\s*\n\s*WHERE driver_ext_id = ANY\(\$3\) AND day BETWEEN \$1::date AND \$2::date/
      .test(routes), 'the same predicate /api/driver/daily uses, inside the kpis query')
  check('…and returns it under its own name',
    /day_money: num\(dday\?\.day_money\)/.test(routes));
  check('…with the source, so the caption can name it',
    /day_money_source: dday\?\.day_money_source/.test(routes));
  check('…and the grain, which is not defaulted to 7',
    /bool_or\(money IS NOT NULL AND money_period_days IS NULL\) THEN NULL/.test(routes),
    'src/rollup.js refuses to guess it and so does this');
  /* The reason this is read from driver_day rather than recomputed: a third
     definition of the money is what the fix is FOR. */
  check('the reasoning is written down where the query is',
    /THE OTHER FIGURE THIS SAME PAGE PRINTS FOR THE SAME DAYS/.test(routes)
      && /no third definition of the money enters the/.test(routes),
    'the phrase wraps in the source; match up to the wrap, not across it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
