/* trip_cash — THE ONE PLACE THAT DECIDES WHAT A CASH FARE IS WORTH.
   ═══════════════════════════════════════════════════════════════════════════
   THE OPERATOR'S RULE, in their words, 2026-09-22:

     "Cash trips are cash to the driver unless they give it to the company."

   So cash in hand is a real running liability: it RISES the moment a driver
   takes a fare in cash, and falls only when a `cash_deposit` is recorded
   against them. There is deliberately no +1 cash type in ledger_type — the
   increase is a MEASURED term, taken from trips, and this view is where that
   measurement is made.

   ── WHY A VIEW AND NOT AN EXPRESSION IN TWO QUERIES ──────────────────────
   Two surfaces need it: /api/ledger/exposure's `collected` CTE, which already
   sizes what a driver is holding, and the per-person register that prints the
   line. api/public/settlement.js:203-210 records what happened the last time
   two surfaces each carried their own idea of a cash figure — they disagreed,
   in production, about one man's hand-in obligation. One definition, one
   place, both readers.

   ── WHICH TRIPS PUT CASH IN A HAND ───────────────────────────────────────
   `trip_ext.driver_holds_cash` already answers this and is already right:
   payment_type IN ('cash','cash-driver'). The two that look like cash and are
   not have been measured, not assumed — 733 Uber trips across two independent
   samples, 70+ drivers, zero counter-examples:

     cash        every trip carries a non-zero cash_collected
     offline     100/100 and 72/72 carry EXACTLY 0 — Uber settles it and pays
                 the fleet on the statement, with its usual 25% taken. It is an
                 offline-SETTLED ride, not money handed to a driver.
     derivative   10/10 and 5/5 carry EXACTLY 0
     braintree / apple_pay / zaakpay / paypal / digital / google_pay / kcp_pg
                 all zero, in every sample

   Counterfactual, person 202 over 2026-07-01..09-22: treating `offline` as
   cash would add 6,303.03 to 2,038.97 of real cash fares — 8,342.00 against
   Uber's own stated 2,251.52, a 3.7x overstatement of what one man is holding.
   `trip_ext.settlement_class` already files them as 'off_platform' and
   'adjustment'; this view simply does not count them.

   ── AND WHAT THE TRIP IS WORTH, WHICH IS THE HARD HALF ───────────────────
   `price` is what the RIDER was charged. `raw->'uber_payments'->>'cash_collected'`
   is what Uber's own payments report says passed to the DRIVER, and the two
   are not the same number. Measured, person 202's September cash trips:

     2026-09-15  fare 113.77   cash_collected 118.77   (+5.00)
     2026-09-14  fare 148.46   cash_collected 153.46   (+5.00)
     2026-09-11  fare  29.83   cash_collected  67.13   (+37.30)

   The +5.00 is a Salik gate on 32 of 51 sampled cash trips. The +37.30 is not
   explained by one gate. Either way the driver walked away holding the larger
   figure, and the operator's rule is about what they are HOLDING — so
   `cash_amount` is the payments figure wherever the payments blob survives.

   WHETHER THEY THEN OWE THE TOLL BACK IS A DIFFERENT QUESTION, and it is not
   answered here. It belongs to the `salik` deduction type, against the person,
   on a date — not to a per-trip cash figure that would quietly net one against
   the other.

   `cash_basis` says which figure was used, per row, because the fallback is a
   materially different claim: `price` UNDERSTATES what the driver took by
   whatever the tolls were, and a page summing it must be able to say so rather
   than presenting a floor as a total.

   ── WHAT IS DELIBERATELY EXCLUDED ────────────────────────────────────────
   A trip that did not complete puts no cash in a hand. Measured: person 202's
   2026-09-20 cash-marked trip is `not_completed` with a null price — it was
   cancelled and no fare was ever charged. api/ledger_routes.js's `collected`
   CTE has no outcome filter and would count it as an unpriced cash collection,
   inflating its own floor claim. This view filters it out and the CTE is
   rewired to this view in the same pass.

   A trip with no price AND no payments figure is present with a NULL amount
   rather than absent, so a caller can count what it cannot value instead of
   silently dropping it. That count is what turns a total into a stated floor. */

CREATE OR REPLACE VIEW trip_cash AS
SELECT
  t.platform,
  t.fleet_id,
  t.external_id,
  t.driver_ext_id,
  t.driver_name,
  t.requested_at,
  t.ended_at,
  t.plate,
  t.price                                   AS fare,
  t.currency,
  /* Uber files it negative — money leaving the platform's side of the ledger.
     The claim here is "this much is in a hand", which is positive. */
  abs((t.raw -> 'uber_payments' ->> 'cash_collected')::numeric)
                                            AS cash_reported,
  coalesce(
    abs((t.raw -> 'uber_payments' ->> 'cash_collected')::numeric),
    t.price
  )                                         AS cash_amount,
  CASE
    WHEN (t.raw -> 'uber_payments' ->> 'cash_collected') IS NOT NULL
      THEN 'payments_report'
    WHEN t.price IS NOT NULL THEN 'fare_only'
    ELSE 'unvalued'
  END                                       AS cash_basis
FROM trip_ext t
WHERE t.driver_holds_cash
  AND t.outcome = 'completed';

COMMENT ON VIEW trip_cash IS
  'One row per completed trip on which a driver physically took cash. '
  'cash_amount is the platform''s own payments figure where it survives and the '
  'fare otherwise; cash_basis says which, because the fare understates what was '
  'taken by whatever tolls the rider paid in cash. Whether the driver owes the '
  'toll back is the salik deduction type''s question, not this view''s.';
