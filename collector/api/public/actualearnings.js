/* ACTUAL EARNINGS — the tile after Platform earnings on a driver's Earnings tab.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-11-16, over a screenshot of that row (00 AT A GLANCE,
   October 2026 — Booked revenue AED 23,238.20, Average fare, Platform earnings
   AED 15,200.73, Tips, Cash collected, Revenue per km): "also add another
   modal for actual earning just after platform share as well."

   WHAT THE WORD HAS TO MEAN, read off what each neighbour already holds:

     · Booked revenue is the gross the riders were charged — trip.price, or the
       statement's own fare line — before any commission.
     · Platform earnings is k.reported_earnings, sum(driver_payout_day.earnings).
       For Uber that column is netOutstanding, the amount Uber WIRES TO THE
       BANK, net of its commission AND of the cash the driver already took
       (src/sources/uber.js, docs/COVERAGE.md "driver_payout_day.earnings IS THE
       BANK SIDE"). It is the transfer: one of the two places the money lands.
     · Cash collected is the other place — trip_cash, the cash in hand.

   So what actually came in for the work is neither of them alone, and the
   product already has ONE figure for it: driver_day.money — the platform
   statement's net where a channel filed one, the bookings' own fares where it
   did not — "what the work earned, before it is split into cash in hand and a
   bank transfer" (api/register_routes.js), "the column to sum at any grain"
   (sql/schema_v41.sql), and the basis api/income_sql.js chooseBasis() was moved
   onto on 2026-09-08 for exactly this reason. /api/driver/kpis returns it as
   `day_money`; the Overview prints it as Money in (ui.js moneyInTile) and the
   Money tab as Income. This tile prints THAT figure, read off the same field
   of the same response the Earnings tab already fetches, so the three cannot
   disagree and no fourth definition of money enters the product. The API is
   unchanged.

   ALTERNATIVES REJECTED, each for a reason that is a measurement:

     · Counted, the window-clamped total under "What each platform paid". It is
       the same driver_payout_day rows summed by day — the caption under that
       table already says it and Platform earnings are "one number checked two
       ways". A re-labelled Platform earnings.
     · Platform earnings + Cash collected. A sum this product refuses on
       evidence: across 260 driver-windows the identity closed on ONE, and bank
       plus cash exceeded the statement on 81 of 89 drivers (COVERAGE.md). On
       the three drivers below it overshoots by AED 422.48, 621.21 and 421.13.
       A fifth number nobody could check.
     · The Overview's Bank deposit (money in less the statement's cash). The
       bank side alone, defined by subtraction — short of what came in by
       exactly the cash the driver holds, which is the part the operator is
       asking to see counted.
     · The statement net alone (/api/driver/earnings `fare`, the "AED n net"
       sentence under the payout table). Uber's half only: a driver who also
       took Bolt or hotel work reads short by every dirham those channels
       priced — AED 573.00 to 954.00 a month on the drivers below.
     · fleetIncome's `accounted`. Statement-first as well, and within AED 0.04
       of day_money on all three drivers below; but it counts Yango on its
       payout where day_money counts Yango's fares, and no tile on this page
       has ever printed it. Reading it here is the competing definition this
       tile was asked not to add.

   MEASURED on production 2026-11-16, /api/driver/kpis?from=2026-10-01&
   to=2026-10-31, three of the busiest drivers in /api/drivers/directory:

                    booked      platform    ACTUAL      statements  priced
                    revenue     earnings    EARNINGS    (net)       (no stmt)
       driver 1     28,184.56   18,177.30   21,699.83   20,951.83   748.00
       driver 2     28,510.79   19,181.28   21,680.86   20,726.86   954.00
       driver 3     21,194.60   13,758.13   15,570.80   14,997.80   573.00

   WHAT IT IS MADE OF, said in the sub-line rather than left to be inferred:

     · AFTER the platform's commission on the statement half, BEFORE it on the
       priced half (no statement, so no commission has come off it) — each half
       named with its amount, the same split Money in names;
     · the cash the driver already holds is IN it, not netted off: Uber's net
       is the whole of what the work earned and cash_collected sits beneath it
       in the tree, as a payout line (src/rollup.js, the block above
       refreshStatements); the fare on a booking is the fare whoever paid it;
     · the statements' tips are NOT in it: NET_FARE_SQL takes the tip off
       your_earnings, and the tile after this one carries them. Said of the
       statement half only — whether a priced fare on another channel carries
       a tip inside it is nothing this product has measured;
     · the weekly grain, in the words Money in uses (ui.js grainClause).

   PARTIAL, AND WHY THIS "at least" IS NOT moneyInTile's.
   moneyInTile writes "at least" whenever k.trips > k.priced_trips. That is not
   a floor on this figure: an unpriced booking on a day an Uber statement
   covers is INSIDE that statement's net, and a ride nobody took has no fare
   and never will. Measured on driver 1 above: 30 of 502 bookings unpriced, 43
   not completed, the statement on 31 of 31 days, and fleetIncome's
   dark_bookings 0 — so "this is a floor rather than the total" would be a
   false reason on this tile. The floor here is gated on dark_bookings, the
   bookings on a channel that reports no money for them at all
   (api/income_sql.js darkOf): money absent from this figure by construction.
   And where the statements reach fewer of the window's days than it has, the
   sub-line says the other days count only where a booking carries a fare —
   true by the definition of driver_day.money whatever the cause (a week not
   yet filed, an account that began mid-window).

   ABSENT, never nought: day_money null means no statement and no priced
   booking reached these dates, and the reason says so — with the Platform
   earnings figure named where one exists, because a payout with no earnings
   beside it reads as the earnings. A published nought (Uber filing 0.00
   statements) stays a number, through moneyInTile's own branch for it. */
import { money, fmt, countOf, plural, moneyInTile, moneyParts, grainClause } from './ui.js';

const LABEL = 'Actual earnings';

/* `worked` and `bookingsN` are the Earnings tab's own reading of whether this
   person worked in the window (api/public/driver.js tabEarnings), passed in
   so the tile's absence says the same thing the tab's other tiles say. */
export function actualEarningsTile(k, { worked = false, bookingsN = 0 } = {}) {
  const p = moneyParts(k);
  const payout = k && k.reported_earnings != null ? Number(k.reported_earnings) : NaN;
  /* Which platforms the payout report covers — Uber's is the bank transfer
     after the cash already taken; another channel's payout is only "a
     different record", because nothing here has established more about it. */
  const uberPays = (k && k.reported_payout_platforms || []).includes('uber');
  const payoutIs = uberPays
    ? 'the payout report, for Uber the bank transfer after the cash already taken'
    : 'the payout report, a different record';
  if (!Number.isFinite(p.gross)) {
    const aside = Number.isFinite(payout)
      ? ` — the ${money(payout)} under Platform earnings is ${payoutIs}, and not what the work earned`
      : '';
    return { label: LABEL, key: 'actual-earnings', value: '—',
      sub: (worked
        ? 'no platform statement and no priced booking covers this window, so what their '
          + `${bookingsN ? countOf(bookingsN, 'booking') : 'work'} earned is not measured`
        : 'no booking of any kind in this window and no platform statement covering it, so '
          + 'there are no earnings to measure') + aside };
  }
  /* A nought the platforms PUBLISHED. moneyInTile's branch for it is the
     page's existing sentence and is true here word for word. */
  if (p.gross === 0) return { ...moneyInTile(k, { label: LABEL }), key: 'actual-earnings' };

  const stmt = Number.isFinite(p.net);
  const priced = stmt ? p.priced : p.gross;
  const parts = stmt && priced > 0
    ? `${money(p.net)} from the platform statements, after their commission, and `
      + `${money(priced)} priced on bookings no statement covers, before any`
    : stmt
      ? 'all of it from the platform statements, after their commission'
      : 'all of it priced on the bookings themselves, before any commission — no platform '
        + 'statement covers these dates';
  /* The same floor as Money in, from the same count — the two tiles are one
     figure, and "at least" on one beside a bare figure on the other would be
     two answers to one question. /api/driver/kpis `unpriced_unstated`:
     completed bookings with no fare that no statement covers (see moneyInTile
     in ui.js). A response from before the field existed falls back to
     dark_bookings, as this tile read first. */
  const unstated = k && k.unpriced_unstated != null ? Number(k.unpriced_unstated) : NaN;
  const dark = Number.isFinite(unstated) ? unstated : (Number(k && k.dark_bookings) || 0);
  const floor = dark
    ? `${countOf(dark, 'completed booking')} with no fare that any statement or booking reports `
      + `${plural(dark, 'is', 'are')} not in it, so this is a floor. `
    : '';
  const stmtDays = Number(k && k.day_stmt_days);
  const win = Number(k && k.window_days);
  const reach = stmt && Number.isFinite(stmtDays) && Number.isFinite(win) && stmtDays < win
    ? ` The statements reach ${fmt(stmtDays)} of the window's ${fmt(win)} days; on the others `
      + 'only a booking’s own fare counts.'
    : '';
  return { label: LABEL, key: 'actual-earnings',
    value: (dark ? 'at least ' : '') + money(p.gross),
    tone: dark ? 'warn' : null,
    sub: `${floor}${floor ? 'What' : 'what'} the work earned, the driver\u2019s cash in hand `
      + `included, not netted off${stmt ? ', the statements\u2019 tips not' : ''}: ${parts}`
      + `${grainClause(p, 'what was earned', { alignment: true })}. `
      + 'It is Money in on the Overview, the same figure'
      + (Number.isFinite(payout) ? `; Platform earnings is ${payoutIs}, so the two are not added` : '')
      + `.${reach}` };
}
