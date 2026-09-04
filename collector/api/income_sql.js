/* What the fleet took in, and which of the two kinds of money it is.
   ─────────────────────────────────────────────────────────────────────────
   Two channels report, and they do not report the same thing.

   FARES are per trip, from the trip feed: what a rider was charged. The hotel
   channel reports them for everything; Yango reports them for some of its
   work; the Uber trip export has no fare column at all.

   PAYOUTS are per driver per week, from driver_payout_day: a statement of what
   the platform actually paid the fleet, net of its commission. Uber's money
   exists only here, and Uber is roughly 90% of this fleet's bookings.

   They must never be added for the SAME platform. A payout is what is left of
   those same fares after commission, so a channel reporting both would be
   counted nearly twice. One figure is chosen per platform, and the choice is
   stated rather than blended, because a reader who cannot tell a gross fare
   from a net payout cannot check either number.

   Across platforms they do add: Uber's payout and the hotel channel's fares
   are money from different rides.

   This lived inside /api/revenue. /api/kpis then grew its own combined figure
   as `sum(fares) + sum(payouts)` over everything, which double-counts any
   platform reporting both — and the Overview and the Revenue page printed
   different totals for the same month. One rule, in one place, called by both.
   test/consistency.test.mjs is what caught the drift and now requires they
   agree. */

/* Per-platform fares from the trip feed. `$1..$2` are the window bounds and
   `$3` an optional platform filter; the caller supplies the window predicate
   because trip_norm's is a Dubai-local day expression, not a bare column. */
export const platformFares = (windowPredicate) => `
  SELECT platform,
         count(*)::int bookings,
         count(*) FILTER (WHERE has_fare)::int priced_bookings,
         /* The bookings that COULD carry a fare, which is not all of them.
            ─────────────────────────────────────────────────────────────────
            A ride nobody took has no fare and never will. Counting it as
            missing coverage is how Bolt came to read 63.8% covered on a month
            where it priced 312 of its 313 completed rides — 99.7% — and was
            filed under partial_fares beside a channel that reports no money
            at all. Measured on production 2026-08: hotel 100.0% of completed,
            yango 100.0%, bolt 99.7%, and Uber 100.0% on any week its payments
            walk has reached.

            A cancellation that DID charge a fee is a booking that could carry
            a fare and did, so it counts in both halves — the filter is on the
            fare existing, not on the outcome. */
         count(*) FILTER (WHERE outcome = 'completed' OR has_fare)::int chargeable_bookings,
         /* And the rides that were cancelled and charged nothing, reported as
            their own number rather than folded into a coverage shortfall. */
         count(*) FILTER (WHERE outcome <> 'completed' AND NOT has_fare)::int uncharged_bookings,
         round(sum(price) FILTER (WHERE has_fare)::numeric,2) fares,
         /* The days this channel actually worked inside the window. This is the
            denominator payout coverage needs — see coverage() below. */
         count(DISTINCT local_day)::int booking_days
  FROM trip_norm
  WHERE ${windowPredicate} AND is_booking
  GROUP BY 1`;

/* Per-platform payouts, from the view that resolves overlapping report
   windows — never from driver_performance directly. See sql/schema_v23.sql.

   Takes the same four parameters as the fare query beside it, in the same
   order, so one `[from, to, platform, fleet]` serves both. */
export const platformPayouts = () => `
  SELECT platform,
         round(sum(earnings)::numeric,2) payouts,
         round(sum(cash_earnings)::numeric,2) cash,
         count(DISTINCT day)::int payout_days,
         count(DISTINCT driver_ext_id)::int drivers,
         count(DISTINCT (period_start, period_end))::int periods
  FROM driver_payout_day
  WHERE day BETWEEN $1::date AND $2::date
    AND ($3::text IS NULL OR platform=$3)
    AND ($4::text IS NULL OR fleet_id=$4)
  GROUP BY 1`;

/* The coverage a figure was measured over. A fare covers BOOKINGS and a payout
   covers DAYS, and both have to be stated against the window or a number drawn
   from three of its thirty days reads as the whole month.

   The payout denominator is the days the channel actually WORKED in the window,
   not the calendar length of the window. Two reasons, and the second is not an
   edge case:

     An open window — no `days`, no from/to — resolves to 2000-01-01..2100-01-01,
     a sentinel spanning 36,526 days. Against that every channel reported "net
     payout covering only 205 of the window's 36,526 days (0.6%)" and every one
     of them fell to partial_payout. Nothing was wrong with the data.

     And a channel that started mid-window, or ran three days a week, is not
     half-covered because the calendar says thirty days. "Of the days this
     channel worked, how many does a statement cover" is the question the
     number is trying to answer.

   Falls back to the window length when the channel reported no bookings at all,
   where there is nothing better and nothing to be wrong about. */
/* Per-platform STATEMENT sums — the third view of the money, beside fares and
   payouts, and never mixed into either. A payout is what the platform wires to
   the bank (net of the cash drivers already collected, plus tips and tolls);
   the statement net is gross minus commission, the figure an operator means by
   "what did we earn". Reconciled against the operator's ledger they differ by
   the cash share — 13% in a heavy-cash month — and showing one where a reader
   expects the other is how that difference gets reported as a bug.

   Sourced from driver_statement_day, API sources only: the operator's imported
   workbook (source='ledger') is REFERENCE data — it taught the reconciliation
   and it verifies our numbers in tests, but the platform displays only what a
   connected API returned. Same four parameters as the two queries beside it. */
export const platformStatements = () => `
  SELECT platform,
         round(sum(net)::numeric,2) statement_net,
         round(sum(gross)::numeric,2) statement_gross,
         round(sum(fees)::numeric,2) statement_fees,
         round(sum(tips)::numeric,2) statement_tips,
         round(sum(salik)::numeric,2) statement_salik,
         round(sum(cash)::numeric,2) statement_cash,
         round(sum(bank)::numeric,2) statement_bank,
         count(DISTINCT day)::int statement_days,
         count(DISTINCT name_key) FILTER (WHERE NOT pseudo)::int statement_drivers
  FROM driver_statement_day
  WHERE source <> 'ledger'
    AND day BETWEEN $1::date AND $2::date
    AND ($3::text IS NULL OR platform=$3)
    AND ($4::text IS NULL OR fleet_id=$4)
  GROUP BY 1`;

export function coverage(r, windowDays) {
  const base = r.booking_days > 0 ? r.booking_days : windowDays;
  /* Over the bookings that could carry a fare, not over every offer. See
     platformFares. Falls back to `bookings` for a caller that has not been
     taught the finer denominator yet, so an old row reads as it always did
     rather than dividing by undefined. */
  const chargeable = r.chargeable_bookings ?? r.bookings;
  return {
    fare_coverage_pct: chargeable
      ? Math.round((r.priced_bookings / chargeable) * 1000) / 10 : null,
    /* Stated beside the percentage, because a reader who sees 99.7% is owed
       the count it was taken over and the count that was left out of it. */
    chargeable_bookings: chargeable,
    uncharged_bookings: r.uncharged_bookings ?? null,
    payout_coverage_pct: r.payout_days
      ? Math.round((Math.min(r.payout_days, base) / base) * 1000) / 10 : null,
    payout_coverage_days: r.payout_days ? Math.min(r.payout_days, base) : null,
    payout_coverage_base: r.payout_days ? base : null,
  };
}

/* Which figure to believe for one platform, and why.
   ──────────────────────────────────────────────────────────────────────────
   THE PAYOUT WINS. A fare is what a rider was charged; a payout is what
   reached the operator. On a commission channel they are the same money at
   two different points and the difference is the platform's cut, so summing
   fares as income states money the fleet never receives.

   This rule used to run the other way — fares first, on the reasoning that a
   payout is what is left of the same fares and the fuller figure is the better
   one. Two measurements say otherwise, and both were taken on production.

     UBER. Across 29 priced Ecosine trips of 25-28 August 2026, the service fee
     is 25.00% of the fare on every single row: the fare is the payout divided
     by three quarters, never an independent figure. And it is the PAYOUT that
     reconciles — the daily-grain payouts over 27 July to 30 August come to
     AED 440,726.21 against AED 440,445.31 actually credited across ten Uber
     transfers into the operator's ENBD and ADCB accounts, +0.06%. The fares
     over the same window do not, and cannot: they are gross of a quarter.

     This was days away from landing on its own. Uber's per-trip fares are
     being backfilled, fare coverage was 44.4% and climbing, and at 80% the
     old rule would have flipped Uber's August from AED 428,083 to roughly
     AED 640,000 with nothing on the page to mark the change.

     YANGO, already wrong today. Fare coverage 100%, fares AED 1,566, payout
     AED 5,846.06 for the same August window. The old rule read the 100% and
     printed the smaller number, so the product stated a quarter of what Yango
     says it paid.

   A fare is still the right answer where a channel reports no payout at all —
   the hotel channel invoices the fare and keeps it, and there is no commission
   between the two. That is now the second branch rather than the first.

   Mutates the row, because both callers want the reasoning on it. */
export function chooseBasis(r, windowDays) {
  Object.assign(r, coverage(r, windowDays));
  if (r.payouts != null && r.payout_coverage_pct >= 80) {
    r.basis = 'payout';
    r.best = r.payouts;
    r.basis_note = r.priced_bookings
      ? `net payout, after the platform’s commission — this is the money that `
        + `arrived; the fares on ${r.priced_bookings} of ${r.bookings} bookings are `
        + `the gross the riders paid, which is a larger and different figure`
      : 'net payout, after the platform’s commission — this channel reports no fare at all';
  } else if (r.priced_bookings && r.fare_coverage_pct >= 80) {
    r.basis = 'fares';
    r.best = r.fares;
    r.basis_note = `fares reported on ${r.priced_bookings} of ${r.bookings} bookings, `
      + 'and this channel reports no payout covering the window — nothing takes a '
      + 'commission out of this money between the booking and the bank';
  } else if (r.payouts != null) {
    /* The payout is real and covers a fraction of the window. Reporting it as
       the channel's revenue would understate the month by however much of it
       was never collected — which is the whole gap, not a rounding. */
    r.basis = 'partial_payout';
    r.best = r.payouts;
    r.basis_note = `net payout covering only ${r.payout_coverage_days} of the `
      + `${r.payout_coverage_base} day(s) this channel worked `
      + `(${r.payout_coverage_pct}%) — the rest of this channel’s money has not been collected yet`;
  } else if (r.priced_bookings) {
    r.basis = 'partial_fares';
    r.best = r.fares;
    r.basis_note = `fares on only ${r.priced_bookings} of ${r.bookings} bookings `
      + `(${r.fare_coverage_pct}%) — the rest of this channel’s money is not collected`;
  } else if (!r.bookings) {
    /* Nothing arrived at all — which is a different fact from "money is dark",
       and the difference is what makes it fixable. A channel with bookings and
       no fares has a money problem; a channel with no bookings has a
       CREDENTIAL problem, and the collection run already knows which. Bolt's
       last run in production says "code=503 NOT_AUTHORIZED
       hint=COMPANIES_NOT_ALLOWED"; printing "this channel's money is dark"
       over that sends a reader looking for a missing fare column. */
    r.basis = 'none';
    r.best = null;
    r.basis_note = r.collection_error
      ? 'no booking has been collected on this channel — the last collection run reported: '
        + r.collection_error
      : r.collection_status
        ? `no booking collected on this channel in this window; the last collection run `
          + `finished ${r.collection_status}, so the channel is configured and simply quiet`
        : 'no booking collected on this channel, and no collection run has ever reported on it';
  } else {
    r.basis = 'none';
    r.best = null;
    r.basis_note = 'no fare on any booking and no payout reported — this channel’s money is dark';
  }
  return r;
}

/* The bookings a channel reports no money for. A `none` channel has no figure
   at all, so every booking of its is dark; a partial_fares channel has priced
   some of them, and only the rest are. See dark_bookings below. */
const darkOf = (rows, n) => rows.reduce(
  (a, r) => a + (r.basis === 'partial_fares'
    ? Math.max(0, n(r.bookings) - n(r.priced_bookings))
    : n(r.bookings)), 0);

/* The fleet's income: the best figure per platform, summed, with the parts it
   is made of named. `rows` are platform rows already carrying bookings,
   priced_bookings, fares, payouts and payout_days. */
export function fleetIncome(rows, windowDays) {
  const n = (v) => (v == null ? 0 : Number(v));
  /* Fares arrive as a NUMERIC string and attributed payouts as the result of a
     division, so summing them in JS produces 3291.9300000000003. It reaches
     the page as a value, not only as text — a caller doing its own arithmetic
     inherits the noise — so it is rounded here, once, where the sum is made. */
  const sum = (xs) => (xs.length ? Math.round(xs.reduce((a, x) => a + n(x), 0) * 100) / 100 : 0);
  for (const r of rows) chooseBasis(r, windowDays);
  const measured = rows.filter((r) => r.best != null);
  const bookings = rows.reduce((a, r) => a + n(r.bookings), 0);
  /* DARK is money that is genuinely absent, and a partial_payout is not that.
     ───────────────────────────────────────────────────────────────────────
     This filter used to carry 'partial_payout' as well, which put the same
     rows in the measured set (accounted_bookings, below) AND in the dark set,
     so #revenue printed two tiles in one row that described the identical
     bookings in opposite terms. Measured on production 2026-09-02T13:16Z,
     /api/revenue?days=365: uber is basis partial_payout with 232,832 bookings
     and a real net payout of AED 2,401,822.21 covering 209 of the 365 days it
     worked. The page read "Accounted for AED 2,533,853 across 234,499 of
     234,499 bookings" beside "Bookings with no money value 232,832 — 99.3% of
     the window", both true of the same 232,832 rows.

     A partial_payout row HAS money — `best` is set, it is inside `accounted`,
     and it is what makes the fleet total what it is. What is wrong with it is
     COVERAGE, and the row already reports that exactly, per channel, as
     payout_coverage_days / payout_coverage_base / payout_coverage_pct. So the
     under-covered bookings get their own pair of fields below rather than
     being folded into a count that means "no money at all".

     'none' and 'partial_fares' stay: a `none` channel has no figure of any
     kind, and a partial_fares channel's unpriced bookings are money nothing
     reports. Both are absent money. A part-window payout is present money
     over a stated fraction of the days. */
  const darkRows = rows.filter((r) => r.basis === 'none' || r.basis === 'partial_fares');
  const underRows = rows.filter((r) => r.basis === 'partial_payout');
  return {
    accounted: sum(measured.map((r) => r.best)) || null,
    /* Both halves of it, so a reader can see which kind of money moved.
       These sum the CHOSEN figure only — a platform counted on its payout does
       not also contribute its fares, or the total would exceed itself. */
    accounted_fares: sum(rows.filter((r) => r.basis === 'fares' || r.basis === 'partial_fares')
      .map((r) => r.fares)) || null,
    accounted_payouts: sum(rows.filter((r) => r.basis === 'payout' || r.basis === 'partial_payout')
      .map((r) => r.payouts)) || null,
    /* The denominator that belongs to accounted_fares, and only to it.
       #revenue printed the fare half over the FLEET's priced_bookings, which
       was the same number until a channel could report a fare on every booking
       and still be counted on its payout. Yango is that channel: 36 priced
       bookings of 36, none of whose money is in accounted_fares. Naming them
       under a figure they contribute nothing to is a caption describing a
       different measurement from the one above it. */
    accounted_fare_bookings: rows
      .filter((r) => r.basis === 'fares' || r.basis === 'partial_fares')
      .reduce((a, r) => a + n(r.priced_bookings), 0) || null,
    accounted_bookings: measured.reduce((a, r) => a + n(r.bookings), 0),
    accounted_platforms: measured.map((r) => r.platform).sort(),
    /* The statement view rides beside the chosen basis, never inside it:
       adding statement net to a platform already counted on fares or payout
       would count the same trips twice. It is its own pair of fields, summed
       over every platform that has statement rows in the window. */
    statement_net: sum(rows.filter((r) => r.statement_net != null)
      .map((r) => r.statement_net)) || null,
    statement_platforms: rows.filter((r) => r.statement_net != null)
      .map((r) => r.platform).sort(),
    /* DARK is the bookings with no money, not the channels with some.
       ─────────────────────────────────────────────────────────────────────
       This counted every booking on a partial_fares channel, including the
       ones that carry a fare — which is the same double-description this file
       already fixed once for partial_payout, and which its own comment above
       already describes the right rule for: "a partial_fares channel's
       UNPRICED bookings are money nothing reports". Measured on production
       over 365 days, /api/revenue: the tile read "Bookings with no money
       value 27,463, 10.5% of the window" in critical tone while 10,751 of
       those same Bolt bookings carried a fare the tile four places to its left
       was counting as income.

       A `none` channel contributes all of its bookings, because it has no
       figure of any kind. A partial_fares channel contributes only the ones
       nothing priced. */
    dark_bookings: darkOf(darkRows, n),
    dark_pct: bookings ? Math.round((darkOf(darkRows, n) / bookings) * 1000) / 10 : null,
    /* The other half of the split: bookings on a channel we DO hold money for,
       where that money covers only part of the days the channel worked. Not
       dark — counted in `accounted` and in accounted_bookings — but not fully
       covered either, and a page that prints the accounted total without this
       is claiming a completeness it does not have. On production's 365-day
       window this is uber's 232,832 bookings against a payout covering 209 of
       365 days; on the same fleet's July window uber clears 80% coverage, goes
       to basis `payout`, and this is 0. */
    undercovered_bookings: underRows.reduce((a, r) => a + n(r.bookings), 0),
    undercovered_pct: bookings
      ? Math.round((underRows.reduce((a, r) => a + n(r.bookings), 0) / bookings) * 1000) / 10 : null,
    undercovered_payouts: sum(underRows.map((r) => r.payouts)) || null,
    undercovered_platforms: underRows.map((r) => r.platform).sort(),
  };
}
