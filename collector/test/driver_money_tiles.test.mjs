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
  check('the statement figure still leads over raw trip revenue',
    /weekly statement/.test(faresTile({ ...SEP6, statement_fares: 12638.71,
      statement_fare_periods: 7 }).sub));
}

console.log('\nMoney in: "paid out" has to mean paid out');
{
  const t = moneyInTile(SEP6);
  check('the figure itself is unchanged', /311\.52|312/.test(String(t.value)), String(t.value));
  check('a one-day window over a seven-day payout does NOT say "paid out"',
    !/paid out/.test(t.sub),
    'driver_payout_day.earnings is period earnings divided by the period\'s days');
  check('…it says the period it was shared out of',
    /7 days? payout period/.test(t.sub), t.sub);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
