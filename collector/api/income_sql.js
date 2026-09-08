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

/* Which channels take a cut, and which invoice and keep it.
   ─────────────────────────────────────────────────────────────────────────
   Not derivable from the rows: a marketplace that does not publish its
   commission looks, in the data, exactly like a channel that takes none. It
   is a fact about the business and it is named rather than inferred.

   Uber's is measured at exactly 25% on every priced trip. Yango's is filed as
   price_platform_commission, around 23%, and is subtracted at collection.
   Bolt's is real and this fleet has no surface that reports it — which is
   precisely why the sentence must not claim otherwise. The hotel channel
   bills the property and keeps the invoice. */
export const COMMISSION_CHANNELS = new Set(['uber', 'bolt', 'yango', 'careem']);

/* "did this ride complete", for a query that reads `trip` rather than the view.
   ─────────────────────────────────────────────────────────────────────────
   trip_norm derives `outcome` (sql/schema_v18.sql) and several hot queries
   deliberately read `trip` directly instead — person_key is a column of trip
   and joining the view for it cost a sequential scan at every window. Those
   queries already re-derive has_fare and has_distance in the same spirit, and
   this is the third of the same kind: the status list is schema_v18's, minus
   Bolt's `optional_ride_` prefix, which marks how an offer was MADE and not
   how it ended.

   Kept here rather than written out four times, and test/completed_sql.test.mjs
   asserts it agrees with trip_norm.outcome on every status spelling in the
   record — a re-derivation nothing checks is a re-derivation that drifts. */
export const COMPLETED_SQL = (col = 'status') =>
  /* Character for character schema_v18's `k.s`: btrim INSIDE the lower, then
     the prefix strip. Written without the btrim first, and the test caught it
     on ' Finished ' — which the view reads as completed and this did not. */
  `regexp_replace(lower(btrim(coalesce(${col}, ''))), '^optional_ride_', '')`
  + ` IN ('completed', 'finished', 'complete', 'closed', 'delivered')`;

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

/* The sentence a payout note prints about the fares sitting beside it, and the
   comparison it is finally gated on.
   ─────────────────────────────────────────────────────────────────────────
   Both payout branches below said the same unconditional thing — the fares are
   "a larger and different figure" — which is a claim about two numbers made
   without reading either of them, gated only on the fares existing. It is
   false on production today. Measured 2026-09-05T18:51Z on /api/revenue: yango
   is on basis payout at every window read — 7, 14, 240, 300 and 365 days — and
   its fares are the SMALLER figure in all of them. At days=7 they are AED 357
   against a payout of AED 433.29; at days=14, AED 1,328 against AED 1,482.94;
   at days=300, AED 1,812 against AED 17,744.50 — and every one of those rows
   carried a note calling the fares larger. Uber is the row the sentence was
   written for and there it is true: AED 8,220,967.15 of 300-day fares against
   AED 2,305,171.07 of payout, the fare gross of a service fee measured at
   exactly 25%.

   So the claim is gated on the comparison. Where the fares are larger the
   sentence is word for word what it was. Where they are not, the two do not
   line up as gross and net at all — a payout also carries days, tips, bonuses
   and adjustments that no trip in the window priced, which is the only shape
   that fits yango's AED 17,744.50 against AED 1,812 of fares over 300 days —
   and the note says that instead of inverting the arithmetic in front of the
   reader. Both sides move with the backfill, which is why this compares them
   per row rather than stating a direction once and for all.

   `whole` picks the partial_payout wording, where the fares span the whole
   window and the payout only part of it, and the extra thing that has to be
   said is that they are not the uncollected remainder either. */
const faresBesidePayout = (r, { whole = false } = {}) => {
  if (!r.priced_bookings || r.fares == null || r.payouts == null) return '';
  const over = `the fares on ${r.priced_bookings} of ${r.bookings} bookings`;
  if (Number(r.fares) > Number(r.payouts)) {
    return whole
      ? `; ${over} are the gross the `
        + `riders paid across the whole window — a larger and different figure, not the `
        + `uncollected remainder of this payout`
      : `; ${over} are `
        + `the gross the riders paid, which is a larger and different figure`;
  }
  return `; ${over} ${Number(r.fares) < Number(r.payouts)
    ? 'come to less than this payout rather than more'
    : 'come to exactly this payout, not to more'}, so they are not the gross this net was taken `
    + `out of${whole ? ' and not the uncollected remainder of it either' : ''} — a payout also `
    + `carries days, tips and adjustments that no trip in this window priced, and the gap `
    + `between the two is not this channel’s commission`;
};

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
  /* THE STATEMENT'S NET IS WHAT THE PLATFORM SAYS THE WORK EARNED, and it goes
     first because the figure this function used to prefer is not earnings at
     all.
     ────────────────────────────────────────────────────────────────────────
     driver_payout_day.earnings is Uber's `netOutstanding` — read at
     src/sources/uber.js:1430 and described by Uber as the amount it WIRES TO
     THE BANK. api/public/revenue.js:194 has always labelled it correctly:
     "Paid into the bank — what the platforms wired to the bank, net of
     commission AND of cash already collected." It is the bank side of the
     money. Leading `accounted` with it made every money headline in this
     product answer "what reached the bank" under the words "money in", and
     the two differ by the cash the drivers already hold — 16.9% to 18.8% of
     the money across three measured windows.

     The statement's net is the other side: gross minus the platform's
     commission, before any of it is split into cash-in-hand and a transfer.
     That is what an operator means by what a driver earned, and it is the
     basis the driver profile was moved onto when the operator settled the
     question ("the driver day or week shows total money in by the driver from
     all platforms").

     Measured fleet-wide for 2026-09-01..09-07, from /api/revenue:

       platform  fares        payouts      statement_net   old basis
       uber      242,070.87   155,889.48   158,185.46      payout
       bolt        7,398.60   —            —               fares
       hotel      16,927.75   —            —               fares
       yango         814.00       266.57   —               payout

     accounted was 180,482.40. Under this ordering it is 158,185.46 + 7,398.60
     + 16,927.75 + 266.57 = 182,778.38 — the uber term moving from its payout
     to its statement, worth AED 2,295.98 fleet-wide and 14% on the driver this
     came in about.

     ONE CHANNEL STILL DIFFERS FROM THE DRIVER PAGE, and it is left differing
     on purpose. driver_day.money takes "statement net where a channel filed
     one, that channel's FARES where it did not", so at driver grain Yango
     counts on its fares. Here it keeps its payout, because the branch below
     prefers a payout to fares and that preference is right for a channel that
     takes a commission: Yango's AED 814.00 of fares is the gross the riders
     paid, and the fleet never sees a quarter of it. AED 266.57 is what
     arrived. Counting the gross as income would be the double-count the
     doctrine below exists to prevent.

     So the fleet total is 182,778.38 against a driver_day sum of about
     183,366 — a residual of roughly AED 588, 0.3%, and all of it Yango. That
     is down from AED 2,844 and it is now a difference this file can explain in
     one sentence, which the old one could not. Bolt and the hotel channel file
     no payout at all, so they take their fares under either rule and
     contribute nothing to the gap.

     This is done HERE and not by summing driver_day, for two reasons
     api/server.js:2143 already records: a previous attempt at that lost 92
     people — everybody the statements pay for work the trip record does not
     carry, AED 56,917 against AED 81,385 over 1–3 September — and driver_day's
     money column covers every platform at once, so the platform chip could not
     narrow it. Statements and fares are per platform, so the chip still works.

     Guarded on `> 0`, not on presence. A statement net of exactly zero beside
     real bookings is the same contradiction the zero-payout branch below
     refuses to resolve, and a negative net is not an income figure at all;
     both fall through to the branches that already know what to say. */
  if (r.statement_net != null && Number(r.statement_net) > 0) {
    /* PARTIAL, THE SAME WAY A PAYOUT IS PARTIAL — and the suite caught this
       missing.
       ─────────────────────────────────────────────────────────────────────
       The first version of this branch took the statement whenever one
       existed and reported no coverage at all, which turned a warning the
       #revenue page had been raising for a year into silence: uber over 365
       days went from basis partial_payout, tone amber, "a real payout covering
       only part of the window" to basis statement, tone GOOD, nothing said.

       Measured on production over 365 days: the statement covers 212 of the
       365 days uber worked (58.1%) and the payout covers 215 (58.9%). The
       statement is not better covered than the payout — it is a different
       KIND of figure over almost exactly the same days. Preferring it is right;
       pretending it is complete is not.

       So it splits the way the payout does, and partial_statement joins
       partial_payout in the under-covered set below rather than in the dark
       one: this is present money over a stated fraction of the days, not
       absent money. Coverage unknown (a statement with no day count) takes the
       full basis and says so in the note, because a missing denominator is not
       evidence of poor coverage. */
    r.statement_coverage_days = r.statement_days ?? null;
    r.statement_coverage_base = r.booking_days > 0 ? r.booking_days : windowDays;
    r.statement_coverage_pct = (r.statement_coverage_days != null && r.statement_coverage_base)
      ? Math.round((r.statement_coverage_days / r.statement_coverage_base) * 1000) / 10 : null;
    const thin = r.statement_coverage_pct != null && r.statement_coverage_pct < 80;
    r.basis = thin ? 'partial_statement' : 'statement';
    r.best = r.statement_net;
    r.basis_note = 'the platform’s own net for this window — the gross the riders were charged, '
      + 'less the commission this channel takes out of it'
      + (r.statement_coverage_pct != null && r.statement_coverage_pct < 99.5
        ? `, filed over ${r.statement_coverage_days} of the ${r.statement_coverage_base} `
          + `day(s) this channel worked (${r.statement_coverage_pct}%) — the rest of its money `
          + 'has not been reported yet'
        : '')
      + (r.payouts != null
        ? '. What the platform wired to the bank is reported beside this figure and is not '
          + 'added to it: the transfer is what is left after the cash the drivers already took'
        : '');
    return r;
  }
  /* A payout that sums to exactly zero is not a measurement of nothing.
     ────────────────────────────────────────────────────────────────────────
     Reproduced by calling fleetIncome directly on one row — uber, 10,000
     bookings, 8,500 of them priced, AED 500,000 of fares, payouts 0 over 10 of
     30 days. The row took basis partial_payout with `best` 0, which put it in
     the measured set, and every total the function returns came back null:
     accounted null, accounted_fares null, accounted_payouts null,
     undercovered_payouts null. AED 500,000 of charged fares left the product
     without a figure or a sentence anywhere. The `|| null` on each sum is what
     turns the zero absent, so house rule 2 is not broken at the tile — the
     page prints a dash, not a green zero — but nothing said the fares had been
     dropped, or why.

     What a zero payout beside real fares MEANS is the decision here, and the
     honest answer is that it means the two sources contradict each other. A
     payout summing to exactly zero across days it does cover is either a
     statement whose deductions cancelled its earnings or a set of placeholder
     rows; the trips beside it say money was charged. Nothing in the rows
     settles which, so neither figure is taken: `best` is null with the reason
     on the row, the way api/alert_coverage_sql.js states an unmeasurable
     coverage, and the fares are named as SET ASIDE rather than counted. They
     cannot simply be counted instead — on a commission channel the fare is the
     gross a quarter comes out of, which is the whole doctrine above — and they
     must not vanish silently, so fleetIncome reports them as set_aside_fares
     over set_aside_fare_bookings and api/public/revenue.js prints that clause
     beside the accounted total.

     This is deliberately the same answer for every channel, including one that
     invoices and keeps its fares: a channel that keeps its own fares has no
     payout rows at all, so a zero payout on it is the same contradiction and
     not a reason to believe the fares harder. The shape already existed on the
     payout branch below for a zero payout covering 80% of the days; it is
     answered here for both. */
  if (r.payouts != null && Number(r.payouts) === 0) {
    r.basis = 'zero_payout';
    r.best = null;
    r.basis_note = 'the payout rows for this channel in this window sum to exactly zero'
      + (r.payout_days ? ` across the ${r.payout_days} day(s) they cover` : '')
      + ', so there is no net figure to take from them — this channel’s income is left unstated '
      + 'rather than stated as nothing'
      + (r.priced_bookings && r.fares != null
        ? `; the fares on ${r.priced_bookings} of ${r.bookings} bookings are set aside, not `
          + 'counted as income, because '
          + (COMMISSION_CHANNELS.has(r.platform)
            ? 'this channel takes a commission out of them — they are the gross the rider paid, '
              + 'and a payout of zero is no evidence of what that gross came to at the bank'
            : 'a payout saying nothing arrived beside fares saying something was charged is a '
              + 'contradiction these rows cannot settle, and counting either figure would state '
              + 'it as settled')
        : '');
  } else if (r.payouts != null && r.payout_coverage_pct >= 80) {
    r.basis = 'payout';
    r.best = r.payouts;
    r.basis_note = r.priced_bookings
      ? `net payout, after the platform’s commission — this is the money that `
        + `arrived` + faresBesidePayout(r)
      /* "this channel reports no fare at all" was a claim about the CHANNEL
         made from one window's rows. On any window inside the week Uber's
         payments walk has not reached — "today", "yesterday", the first days
         of "this week" — the money page of a fleet analytics product stated in
         plain English that Uber reports no fare, for a channel that priced
         2,107 bookings of the week before. The sentence says what the window
         shows and stops there. */
      : 'net payout, after the platform’s commission — this is the money that arrived, '
        + 'and no booking in this window carries a fare of its own';
  /* A real payout does not stop being the money because the fares caught up.
     ────────────────────────────────────────────────────────────────────────
     This branch carried no `payouts == null` guard, so a channel holding BOTH
     a real payout and good fare coverage fell out of the payout branch above
     the moment payout coverage dipped under 80% and was reported on its gross
     fares instead — the one thing the doctrine at the head of this function
     says must never happen on a commission channel.

     Measured on production, and RE-measured at 2026-09-05T18:51Z because the
     Uber fare backfill is still running and every figure in this paragraph
     moves with it — the payout drifted AED 2,193 and the 365-day fares 5.3%
     between the first reading and this one, so read these as a snapshot of the
     shape rather than as constants. /api/revenue?days=240 reads uber
     basis=payout, best AED 2,305,171.07, payout coverage 88.3%, and the fleet
     accounts for AED 2,772,248.29. Drag the range to 300 days and the SAME
     uber row — still carrying payouts AED 2,305,171.07 on the row itself —
     reads basis=fares, best AED 8,220,967.15, payout coverage 70.7%, the
     fleet accounts for AED 8,896,989.27, and accounted_payouts collapses to
     AED 17,744.50, which is yango on its own. At 365 days it is AED
     11,545,933.71 of fares at 58.1% payout coverage, against the same AED
     2,305,171.07 payout and a statement net of AED 2,299,035.17. An operator
     dragging one control from 240 to 300 days watches fleet income go up 3.2x
     with nothing marking that the figure changed MEANING, from net payout to
     gross fare.

     Uber's service fee is measured at exactly 25% of the fare on every priced
     row, so the fares are gross of a quarter and cannot be income, while the
     payout is what reconciles to the bank at +0.06%. The right answer for a
     part-covered payout is the one partial_payout below already gives — the
     smaller correct figure, with the fraction of the days it covers stated in
     its own note and in undercovered_bookings / undercovered_payouts — so the
     guard is the whole fix, and the row falls through to it.

     It also settles the complaint that this branch is TESTED before
     partial_payout: with the guard, a row holding a payout can only reach the
     payout branch above or partial_payout below, whichever order they sit in.
     And this branch's own sentence — "this channel reports no payout covering
     the window" — was flatly false of every row that arrived here holding one.
     The guard is what makes it true; the wording did not need softening. */
  } else if (r.payouts == null && r.priced_bookings && r.fare_coverage_pct >= 80) {
    r.basis = 'fares';
    r.best = r.fares;
    /* "nothing takes a commission out of this money" is a claim about the
       CHANNEL, and it was made from the absence of a payout row. It is true of
       the hotel desk, which invoices the property and keeps what it bills. It
       is false of a marketplace that simply does not publish its cut — and
       Bolt reached this branch the moment fare coverage was measured over the
       rides that could carry a fare rather than over every offer, taking AED
       647,558 of 365-day fares with it. What the product knows is which kind
       of channel this is; what it does not know is Bolt's rate. Both are said,
       and neither is guessed. */
    r.basis_note = `fares reported on ${r.priced_bookings} of ${r.chargeable_bookings ?? r.bookings} `
      + `bookings that could `
      + `carry one, and this channel reports no payout covering the window — `
      + (COMMISSION_CHANNELS.has(r.platform)
        ? 'so this is the GROSS the rider was charged, and the commission this channel takes '
          + 'out of it before the fleet is paid is not published to us'
        : 'and nothing takes a commission out of this money between the booking and the bank');
  } else if (r.payouts != null) {
    /* The payout is real and covers a fraction of the window. Reporting it as
       the channel's revenue would understate the month by however much of it
       was never collected — which is the whole gap, not a rounding. */
    r.basis = 'partial_payout';
    r.best = r.payouts;
    /* Three of the four terms in that sentence come from coverage(), and every
       one of them is null when the row carries a payout and no payout_days.
       Reproduced by calling chooseBasis directly on a row holding payouts AED
       1,234.50, payout_days 0 and 95 priced bookings of 100: the note read
       "net payout covering only null of the null day(s) this channel worked
       (null%)". platformPayouts cannot produce that shape — a non-null sum
       implies count(DISTINCT day) >= 1 — but four callers defensively write
       `payout_days: ... ?? 0` (api/revenue_routes.js:309, api/server.js:607,
       api/day_routes.js:271, api/vehicle_routes.js:367), which is what a
       caller writes after seeing the field absent, and before the guard above
       such a row with good fare coverage went to 'fares' and never printed it.
       So the coverage clause is written only where the terms exist, and where
       they do not the note says which figure is missing rather than printing
       the word null three times — the payout itself is still real and is still
       what the row is counted on. */
    r.basis_note = (r.payout_coverage_days != null && r.payout_coverage_base != null
      ? `net payout covering only ${r.payout_coverage_days} of the `
        + `${r.payout_coverage_base} day(s) this channel worked `
        + `(${r.payout_coverage_pct}%) — the rest of this channel’s money has not been collected yet`
      : `net payout, and the payout source reports no day for it in this window — so how much of `
        + `this channel’s work it covers cannot be stated, and this figure is money we hold over `
        + `an unknown share of the window rather than over all of it`)
      /* Reachable for the first time by a row that also prices its bookings.
         Uber over 300 days is 94.4% fare-covered and 70.7% payout-covered, and
         "the rest has not been collected" printed beside a fares column of AED
         8,220,967.15 reads as though that AED 8.2M were the missing part of
         this payout. It is not missing and it is not the remainder — it is the
         other KIND of money, gross of a commission this channel measures at
         25%, over the whole window rather than the uncovered end of it. The
         sentence says so where there are fares to say it about, and stops
         where there are none. */
      + faresBesidePayout(r, { whole: true });
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
  /* partial_statement belongs here and not in darkRows for exactly the reason
     the paragraph above gives about partial_payout: it is present money over a
     stated fraction of the days, not money nothing reports. */
  const underRows = rows.filter((r) => r.basis === 'partial_payout' || r.basis === 'partial_statement');
  /* And the third kind of row: one whose payout sums to exactly zero, which is
     counted nowhere. It is not measured — `best` is null, so it is out of
     `accounted` — and it is not dark either, because it carries fares that the
     trip feed did price. Without this it was out of every field the function
     returns, which is how AED 500,000 of fares left the product with nothing
     said about them. See the zero-payout branch of chooseBasis. */
  const asideRows = rows.filter((r) => r.basis === 'zero_payout');
  return {
    accounted: sum(measured.map((r) => r.best)) || null,
    /* Both halves of it, so a reader can see which kind of money moved.
       These sum the CHOSEN figure only — a platform counted on its payout does
       not also contribute its fares, or the total would exceed itself. */
    accounted_fares: sum(rows.filter((r) => r.basis === 'fares' || r.basis === 'partial_fares')
      .map((r) => r.fares)) || null,
    accounted_payouts: sum(rows.filter((r) => r.basis === 'payout' || r.basis === 'partial_payout')
      .map((r) => r.payouts)) || null,
    /* The third half, now that there is one. Same shape as the two above and
       the same rule: it sums the CHOSEN figure only, so a channel counted on
       its statement contributes nothing to fares or payouts and vice versa,
       and the three add back to `accounted` exactly. */
    accounted_statements: sum(rows.filter((r) => r.basis === 'statement'
      || r.basis === 'partial_statement').map((r) => r.statement_net)) || null,
    accounted_statement_platforms: rows.filter((r) => r.basis === 'statement'
      || r.basis === 'partial_statement').map((r) => r.platform).sort(),
    /* AND THE BANK SIDE, WHICH IS NO LONGER A BASIS AND MUST NOT DISAPPEAR.
       ─────────────────────────────────────────────────────────────────────
       accounted_payouts sums only the rows COUNTED on their payout, and now
       that the statement wins wherever it exists, Uber leaves that set — so
       every caller reading accounted_payouts for "what reached the bank" would
       have started reading null for 86% of the fleet's money. Twelve surfaces
       do exactly that, from api/public/revenue.js:164 to the driver profile's
       bank card.

       The payout is still real and still means what api/public/revenue.js:194
       says it means. It is reported here across EVERY row that has one,
       whatever basis that row was counted on, because it answers a different
       question from `accounted` rather than a competing version of the same
       one. Measured 2026-09-01..09-07: 156,156.05 across uber and yango,
       against an accounted of 183,325.81 — the gap being the cash the drivers
       already hold. */
    reported_payouts: sum(rows.filter((r) => r.payouts != null).map((r) => r.payouts)) || null,
    /* AND THE PART OF IT THIS PRODUCT DOES NOT COUNT AS INCOME, with the
       channels it belongs to and the basis each of them was counted on
       instead. A page that names the gap has to name the RIGHT reason for it,
       and it cannot work that reason out from the totals: a fleet where uber
       is counted on its statement and yango on its fares has two kinds of
       excluded payout at once, and #finance guessed "uber's statement" for
       money that was yango's fares. The server knows; it says. */
    uncounted_payouts: sum(rows.filter((r) => r.payouts != null
      && r.basis !== 'payout' && r.basis !== 'partial_payout').map((r) => r.payouts)) || null,
    uncounted_payout_platforms: rows.filter((r) => r.payouts != null
      && r.basis !== 'payout' && r.basis !== 'partial_payout').map((r) => r.platform).sort(),
    uncounted_payout_bases: [...new Set(rows.filter((r) => r.payouts != null
      && r.basis !== 'payout' && r.basis !== 'partial_payout').map((r) => r.basis))].sort(),
    reported_payout_platforms: rows.filter((r) => r.payouts != null)
      .map((r) => r.platform).sort(),
    reported_payout_days: rows.reduce((a, r) => Math.max(a, Number(r.payout_days) || 0), 0) || null,
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
    /* Still only the PAYOUT rows, because that is what the field is called and
       twelve callers read it as one. The honest total across both kinds of
       under-coverage is beside it under its own name. */
    undercovered_payouts: sum(underRows.filter((r) => r.basis === 'partial_payout')
      .map((r) => r.payouts)) || null,
    undercovered_income: sum(underRows.map((r) => r.best)) || null,
    undercovered_platforms: underRows.map((r) => r.platform).sort(),
    /* Money that was charged and is counted as income nowhere, with the
       channels it belongs to, so the page can say it was set aside and why
       rather than letting it disappear between the totals. */
    set_aside_fares: sum(asideRows.map((r) => r.fares)) || null,
    set_aside_fare_bookings: asideRows.reduce((a, r) => a + n(r.priced_bookings), 0) || null,
    set_aside_bookings: asideRows.reduce((a, r) => a + n(r.bookings), 0),
    set_aside_platforms: asideRows.map((r) => r.platform).sort(),
  };
}
