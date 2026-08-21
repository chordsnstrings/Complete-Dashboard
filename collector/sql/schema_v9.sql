-- Money has a counterparty, and the counterparty is what makes it actionable.
--
-- Every trip in this fleet is already labelled with how it was paid, but the
-- label is the payment processor's word, not the operator's. `braintree`,
-- `zaakpay`, `kcp_pg` and `alipay2` are four names for "the rider's card
-- cleared"; `room-charge` and `hotel-charge` are two names for "the hotel owes
-- us"; `posted-for-salary` means an employee owes us; `foc-complimentary`
-- means nobody does and the ride still cost us a driver-hour and fuel.
--
-- Charted raw, that is a fourteen-slice donut in which the largest slice is a
-- Braintree integration nobody in the business has heard of. Grouped by who
-- settles and when, it answers three questions an operator actually has:
--
--   How much cash are drivers holding tonight?     -> settlement_class='cash'
--   How much is outstanding, and from whom?        -> 'on_account','salary'
--   What did we give away?                         -> 'complimentary'
--
-- Two of those numbers were not obtainable from this dashboard at all, and the
-- third was wrong: the finance page counted complimentary rides in the average
-- fare, which pulled it down with zeroes that are not prices.
--
-- `off_platform` is deliberately its own class rather than being folded into
-- card or cash. On the Uber supplier export it is 20-29% of trips depending on
-- the month, and the export carries no other clue about them: `Service type` is
-- `personal_transport` on all 30,330 rows. Off-platform settlement is the only
-- signal in the data that a trip may have been billed to an account rather than
-- charged to a rider, and it is labelled as exactly that much — a settlement
-- route — and not as "business trips", which the export does not tell us.

/* trip_ext IS DEFINED IN schema_v18.sql, NOT HERE.
   ──────────────────────────────────────────────────────────────────────────
   It used to be defined here. v18 added the return-deadhead leg to it, and
   every schema file is replayed on every boot in filename order — so this file
   ran first with the old column list and CREATE OR REPLACE VIEW refused it:
   "cannot drop columns from view". A migration that fails on every boot is
   noise that trains everyone to ignore migration errors.

   One definition, in the newest file that changes it. The columns this file
   introduced (settlement_class, driver_holds_cash, is_receivable, uber_tier,
   the hotel raw extractions, deadhead_pct, daypart) all live there, with their
   original reasoning intact. */

CREATE INDEX IF NOT EXISTS trip_payment_requested_idx ON trip (payment_type, requested_at)
  WHERE payment_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_partner_requested_idx  ON trip (partner_id, requested_at)
  WHERE partner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_product_requested_idx  ON trip (product, requested_at)
  WHERE product IS NOT NULL;
CREATE INDEX IF NOT EXISTS trip_guest_idx ON trip (((raw ->> 'client'))) WHERE raw ? 'client';

-- Collection holes are the failure mode that looks exactly like a quiet week.
-- One row per source per day, so "we had no trips" and "we collected nothing"
-- stop being the same picture.
CREATE OR REPLACE VIEW source_day_coverage AS
SELECT platform AS source,
       (requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
       count(*)::int rows,
       min(requested_at) first_at, max(requested_at) last_at,
       count(DISTINCT plate)::int plates,
       count(DISTINCT driver_ext_id)::int drivers
FROM trip
WHERE requested_at IS NOT NULL
GROUP BY 1, 2;

COMMENT ON VIEW source_day_coverage IS
  'Rows collected per source per Dubai-local day. A missing day here is a collection gap, not a quiet day, and every rate computed across it is wrong.';
