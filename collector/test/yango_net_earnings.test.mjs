/* driver_payout_day.earnings is one column, and it held two quantities.
   ─────────────────────────────────────────────────────────────────────────
   api/income_sql.js prints one sentence over that column: "net payout, after
   the platform's commission — this is the money that arrived". Uber's side of
   it is netOutstanding, which is net. Yango's was price_cash + price_cashless,
   which is what the RIDERS paid — so a quarter of Yango's line was Yango's own
   commission, described to a reader as money that had arrived.

   Measured on production for August 2026, from /api/funnel/drivers, which has
   been reading the commission out of the same rows all along:

       Aliyan Khalil            gross 3,069.00   commission  -749.58   24.4%
       Tariq Afzal Said Afzal   gross 1,722.00   commission  -411.37   23.9%
       Abidullah Safi           gross   294.00   commission   -61.22   20.8%

   Across the fleet's Yango line for that month, roughly AED 1,320-1,590 of
   the 5,846.06 the product reported had never reached the operator.

   Yango files the commission NEGATIVE, so the mapping adds it. A row that
   omits the field falls back to the gross rather than to nothing, because a
   missing commission is unknown and not zero — and the alternative, dropping
   the row's money entirely, would be worse than stating it gross. */
import { rowsFromPerformance } from './yango_helpers.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe mapping, on the shapes Yango actually files');

const map = await rowsFromPerformance();

/* The three production rows quoted above. */
const aliyan = map({ driver: { id: 'y-1', first_name: 'Aliyan', last_name: 'Khalil' },
  count_orders_completed: 40, price_cash: 0, price_cashless: 3069,
  price_platform_commission: -749.58, work_time_seconds: 3600 });
check('a Yango row is stored net of the platform commission',
  Math.abs(aliyan.earnings - 2319.42) < 0.01, String(aliyan.earnings));
check('…which is the gross less 24.4%, not the gross',
  aliyan.earnings !== 3069, `${aliyan.earnings} — 3069 is what the riders paid`);

/* Cash is what the driver was handed. It is a fact about custody, not about
   commission, and must not move. */
const cashy = map({ driver: { id: 'y-2', first_name: 'Tariq', last_name: 'Afzal' },
  count_orders_completed: 20, price_cash: 900, price_cashless: 822,
  price_platform_commission: -411.37, work_time_seconds: 3600 });
check('cash collected is untouched — it is custody, not commission',
  Number(cashy.cash_earnings) === 900, String(cashy.cash_earnings));
check('…while the earnings beside it are net of the fee',
  Math.abs(cashy.earnings - 1310.63) < 0.01, String(cashy.earnings));

/* A missing commission is unknown, not zero. Falling back to the gross states
   a figure that is too high and says so nowhere — but dropping the row's money
   would state nothing at all for a driver who was paid, which is worse. */
const noComm = map({ driver: { id: 'y-3', first_name: 'A', last_name: 'B' },
  count_orders_completed: 5, price_cash: 100, price_cashless: 50,
  work_time_seconds: 600 });
check('a row with no commission field falls back to the gross rather than to nothing',
  Number(noComm.earnings) === 150, String(noComm.earnings));

/* And the row that must not be stored at all: a driver who did nothing comes
   back as a row of zeros, and a zero would claim the week's days in the
   payout resolution. */
const idle = map({ driver: { id: 'y-4', first_name: 'C', last_name: 'D' },
  count_orders_completed: 0, price_cash: 0, price_cashless: 0,
  price_platform_commission: 0, work_time_seconds: 0 });
check('a week with no work is still no row', idle === null, JSON.stringify(idle));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
