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
export function coverage(r, windowDays) {
  const base = r.booking_days > 0 ? r.booking_days : windowDays;
  return {
    fare_coverage_pct: r.bookings
      ? Math.round((r.priced_bookings / r.bookings) * 1000) / 10 : null,
    payout_coverage_pct: r.payout_days
      ? Math.round((Math.min(r.payout_days, base) / base) * 1000) / 10 : null,
    payout_coverage_days: r.payout_days ? Math.min(r.payout_days, base) : null,
    payout_coverage_base: r.payout_days ? base : null,
  };
}

/* Which figure to believe for one platform, and why.
   Mutates the row, because both callers want the reasoning on it. */
export function chooseBasis(r, windowDays) {
  Object.assign(r, coverage(r, windowDays));
  if (r.priced_bookings && r.fare_coverage_pct >= 80) {
    r.basis = 'fares';
    r.best = r.fares;
    r.basis_note = `fares reported on ${r.priced_bookings} of ${r.bookings} bookings`;
  } else if (r.payouts != null && r.payout_coverage_pct >= 80) {
    r.basis = 'payout';
    r.best = r.payouts;
    r.basis_note = r.priced_bookings
      ? `net payout — only ${r.fare_coverage_pct}% of bookings report a fare`
      : 'net payout, after the platform’s commission — this channel reports no fare at all';
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
  } else {
    r.basis = 'none';
    r.best = null;
    r.basis_note = 'no fare on any booking and no payout reported — this channel’s money is dark';
  }
  return r;
}

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
  const darkRows = rows.filter((r) => r.basis === 'none' || r.basis === 'partial_fares'
    || r.basis === 'partial_payout');
  return {
    accounted: sum(measured.map((r) => r.best)) || null,
    /* Both halves of it, so a reader can see which kind of money moved.
       These sum the CHOSEN figure only — a platform counted on its payout does
       not also contribute its fares, or the total would exceed itself. */
    accounted_fares: sum(rows.filter((r) => r.basis === 'fares' || r.basis === 'partial_fares')
      .map((r) => r.fares)) || null,
    accounted_payouts: sum(rows.filter((r) => r.basis === 'payout' || r.basis === 'partial_payout')
      .map((r) => r.payouts)) || null,
    accounted_bookings: measured.reduce((a, r) => a + n(r.bookings), 0),
    accounted_platforms: measured.map((r) => r.platform).sort(),
    dark_bookings: darkRows.reduce((a, r) => a + n(r.bookings), 0),
    dark_pct: bookings
      ? Math.round((darkRows.reduce((a, r) => a + n(r.bookings), 0) / bookings) * 1000) / 10 : null,
  };
}
