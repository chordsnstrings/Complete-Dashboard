/* What a day's unpriced bookings will be worth — one rule, three pages.
   ──────────────────────────────────────────────────────────────────────────
   Lifted out of api/day_routes.js buildDay on 2026-10-16, when #compare was
   asked for revenue hour by hour (the operator: "#compare should have hourly
   active driver, and hourly revenue as well"). The day page's live strip, the
   Target page's revenue by hour (api/target_hours.js) and #compare's hours
   now value the same bookings with the same function: three copies of a rule
   this product has already got wrong twice — once by projecting cancellations,
   once by reading a share as a signal — would be three places to get it wrong
   a third time, and three figures for one day that could disagree.

   WHY IT HAS TO BE ESTIMATED.
   At 20:07 Dubai on 2026-09-08 /api/day answered revenue 2874 over 664
   bookings, and for 2026-09-07 it answered 35,965 over 675. The fleet had not
   collapsed by 92%: 0 of the day's 596 Uber bookings carried a price, because
   Uber publishes no fare on its trip export at all and the price arrives on a
   separate weekly PAYMENTS report walked on the nightly catch-up
   (src/sources/uber.js UPDATEs trip.price to the RIDER FARE). The split by
   channel that evening was uber 0 of 596 priced, hotel 34 of 34, bolt 10 of
   31, yango 3 of 3 — every priced booking on the screen came from a channel
   that is not most of the fleet.

   So the measured figure is right and useless: it answers "what have we been
   told a price for" when the operator is asking "what did the fleet do today".
   Both are worth having and they are different questions, so every page
   reports both and never lets the second impersonate the first.

   THE RATE IS PER BOOKING, NOT PER PRICED BOOKING. About a tenth of bookings
   never carry a fare — 89.9% of 2026-09-07 was priced, against 87.6%
   completed, so the unpriced remainder is very nearly the cancellations that
   took no fee. Dividing the settled days' revenue by their PRICED bookings and
   multiplying by every unpriced booking would therefore bill the fleet for its
   cancellations: AED 59.25 a priced booking against AED 53.28 a booking on
   2026-09-07, an 11% overstatement. Per booking already averages the fee-less
   cancellations in.

   Measured against the day it is projecting: valuing 2026-09-08's 596
   unpriced Uber bookings at the fourteen settled days behind it gives about
   AED 35,600 for the day, and 2026-09-07 settled at AED 35,965.

   An estimate, and it says so in every field it fills. Nothing here is ever
   added into a measured figure. */

/* How far back to look for what a booking on a channel is worth. Fourteen
   days rather than seven: Uber files Monday-to-Sunday and the fares of the
   running week are rewritten every night, so a seven-day window is one bad
   night away from resting on a single settled week. */
export const PRICING_LOOKBACK_DAYS = 14;

/* What a booking on each channel was worth over the SETTLED days behind $1,
   looking back $2 days. Used only to value the bookings a day holds that carry
   no price yet.

   A day joins the rate only once at least half that channel's bookings on it
   carry a fare. Without the guard the day being projected would drag its own
   rate down through the window as soon as it aged one day: 2026-09-08 would
   enter the 2026-09-09 rate at 0 of 596 Uber bookings priced and halve it.

   $3 is a fleet, or NULL for the whole fleet (the day page). A page filtered
   to one fleet values that fleet's bookings at that fleet's own rate: the two
   fleets do not run the same mix on a channel, and a reader whose access
   covers one fleet must not be handed a rate built from the other's fares —
   the access gate rewrites ?fleet= for exactly that reader. */
export const PRICING_RATE_SQL = `WITH byday AS (
           SELECT platform, local_day,
                  count(*)::int bookings,
                  count(*) FILTER (WHERE price IS NOT NULL
                                     AND NOT is_complimentary)::int priced,
                  sum(price) FILTER (WHERE NOT is_complimentary) revenue
             FROM trip_ext
            WHERE is_booking AND local_day >= $1::date - $2::int
              AND local_day < $1::date
              AND ($3::text IS NULL OR fleet_id = $3)
            GROUP BY 1, 2)
         SELECT platform, sum(bookings)::int rate_bookings,
                sum(revenue) rate_revenue, count(*)::int rate_days
           FROM byday
          WHERE priced > 0 AND priced::numeric / bookings >= 0.5
          GROUP BY 1`;

const round = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? null
  : Math.round(Number(v) * 10 ** d) / 10 ** d);

/* One day's projection, channel by channel.

   `platforms` is the day's rows per channel over the whole fleet —
   { platform, bookings, priced, completed, complimentary, revenue } with
   `priced` the count of rows carrying a fare, `complimentary` the completed
   rides given away, and `revenue` the fares on record; `rateRows`
   is what PRICING_RATE_SQL returned for that day. Returns the parts that were
   projected and the channels that could not be valued. */
export function projectUnpriced(platforms, rateRows) {
  const rate = new Map();
  for (const r of rateRows) {
    if (!r.rate_bookings || r.rate_revenue == null) continue;
    rate.set(r.platform, { per_booking: Number(r.rate_revenue) / r.rate_bookings,
      days: r.rate_days ?? 0 });
  }
  const projected = [];
  /* Absent with a reason, and the reason has to be the true one: a channel
     we hold no settled day for cannot be valued at another channel's rate,
     and its bookings are named rather than folded in at somebody else's
     price or silently dropped. */
  const unrated = [];
  for (const r of platforms) {
    const bk = r.bookings || 0;
    const short = bk - (r.priced || 0);
    if (bk <= 0 || short <= 0) continue;
    const at = rate.get(r.platform);
    if (!at) { unrated.push({ platform: r.platform, bookings: short }); continue; }
    /* A COMPLETED BOOKING WITH NO PRICE IS PENDING. A CANCELLED ONE IS DONE.
       ─────────────────────────────────────────────────────────────────────
       The first version projected every unpriced booking, and it was wrong on
       the day easiest to check: 2026-09-07 is settled — Uber's report had been
       walked overnight — and it still added AED 3,355 for the 68 bookings
       without a price, reporting an expected 39,320 over a measured 35,965.
       Those 68 are not late. They are cancellations that took no fee, and the
       per-booking rate already spreads them in, so charging for them again is
       a double count by construction.

       The second version asked whether the channel's priced share was short
       of where it settles. Better, and still a proxy: on 2026-09-07 Bolt ran
       21 of 40 priced against a 61.9% settled share, read as "still walking",
       and added AED 133 — on a channel that prices every booking as it lands
       and had simply cancelled more than usual that day. A channel that never
       defers pricing would be projected on every bad day and, because the
       estimate is floored at the measurement, never marked down on a good one.

       The signal is not a share at all. It is a count the caller already
       holds: COMPLETED MINUS PRICED — work that finished and carries no
       money. Measured on production, it separates the two cases outright:

         2026-09-07  uber   completed 541  priced 557  pending 0
                     bolt   completed  21  priced  21  pending 0
         2026-09-08  uber   completed 569  priced   0  pending 569 (100%)
                     bolt   completed  10  priced  10  pending 0

       `priced` exceeds `completed` on a settled Uber day because some
       cancellations do carry a fee, which is why this floors at zero.

       A COMPLIMENTARY RIDE IS NEVER PENDING. It is finished, it carries a
       price that is not a price (has_fare excludes it), and nothing will ever
       price it — so it is taken out of the completed count before the
       subtraction. Found on production 2026-10-16, the day #compare began
       deciding per fleet: Egari's hotel channel on the settled 15 October ran
       6 completed and 4 priced, the other 2 `foc-complimentary`, and "pending"
       read 2 of 6 — 33%, over the threshold — so a settled day was given an
       estimate of AED 26.07. Over the whole fleet the same two were 2 of 28
       and the threshold hid them, which is all the threshold had ever done for
       them. It stays, for what it was also for: the odd ride nobody billed. */
    const done = Math.max(0, (r.completed || 0) - (r.complimentary || 0));
    const pending = Math.max(0, done - (r.priced || 0));
    if (pending <= 0 || pending < done * 0.1) continue;
    /* Never below what is already on record: an estimate may add to a
       measurement, never contradict one. */
    const measured = r.revenue == null ? 0 : Number(r.revenue);
    const whole = Math.max(measured, bk * at.per_booking);
    projected.push({ platform: r.platform, bookings: short,
      /* `bookings` is what the caption names — the channel's bookings with no
         price on them. `pending` is what made the DECISION, reported beside it
         so the row explains itself rather than asserting a total. */
      pending, completed: done, pending_pct: round((pending / done) * 100, 1),
      per_booking: round(at.per_booking, 2), days: at.days,
      measured: round(measured, 2), value: round(whole - measured, 2) });
  }
  return { projected, unrated };
}

/* A day's projection laid over its hours.

   Each channel's projected value is spread over the hours that hold its
   PENDING work — finished, chargeable rides with no price yet — in
   proportion to how many each hour holds, so the hours add up to exactly the
   day's figure and the estimate sits where the unpriced work is.

   It was spread over every booking without a price, and that put money in
   hours that had none coming. Measured on production at 14:30 Dubai on
   2026-10-16: the day's Uber estimate (AED 2,436.90) covered 65 unpriced
   bookings, but the 42 finished ones were all at 13:00–14:00 and the other 23
   were rider cancellations scattered from 00:00 to 12:00 — so 00:00 and 01:00,
   whose only unpriced bookings were cancellations, were drawn hatched with
   revenue on the way. The per-booking rate already averages the fee-less
   cancellations into the VALUE; they are not where it lands.

   `rows` are the day's bookings per hour per channel, the same rows the
   projection was decided on: { h, platform, pending }. The decision
   guarantees pending work exists wherever a channel is projected (a channel's
   pending count is at most its rows' pending — `priced` there also counts
   cancellations that took a fee), so there is deliberately NO fallback: a
   caller whose rows lack `pending` spreads nothing, its hours stop adding up
   to the day, and its own test of that sum fails — which is how
   test/target_hours.test.mjs proves the Target page's query carries the
   column. `keep(row)` picks the rows whose share is returned — the part of
   the day before a cut. Returns 24 numbers. */
export function spreadByHour(parts, rows, keep = () => true) {
  const out = Array(24).fill(0);
  for (const p of parts) {
    const v = Number(p.value) || 0;
    if (!v) continue;
    const mine = rows.filter((r) => r.platform === p.platform);
    const w = (r) => Math.max(0, Number(r.pending) || 0);
    const total = mine.reduce((s, r) => s + w(r), 0);
    if (!total) continue;
    for (const r of mine) {
      if (keep(r)) out[r.h] += (v * w(r)) / total;
    }
  }
  return out;
}
