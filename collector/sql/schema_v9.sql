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

CREATE OR REPLACE VIEW trip_ext AS
SELECT
  t.*,

  CASE
    WHEN t.payment_type IS NULL OR btrim(t.payment_type) = '' THEN NULL
    WHEN lower(t.payment_type) IN ('cash', 'cash-driver', 'cash-supervisor') THEN 'cash'
    WHEN lower(t.payment_type) IN ('pos-driver', 'pos-supervisor', 'braintree', 'zaakpay',
                                   'kcp_pg', 'card', 'credit_card') THEN 'card'
    WHEN lower(t.payment_type) IN ('apple_pay', 'google_pay', 'paypal', 'alipay2', 'digital',
                                   'wallet', 'cashless') THEN 'wallet'
    WHEN lower(t.payment_type) IN ('room-charge', 'hotel-charge', 'company', 'corporate',
                                   'invoice') THEN 'on_account'
    WHEN lower(t.payment_type) IN ('posted-for-salary', 'salary') THEN 'salary'
    WHEN lower(t.payment_type) IN ('foc-complimentary', 'foc', 'complimentary') THEN 'complimentary'
    WHEN lower(t.payment_type) IN ('offline') THEN 'off_platform'
    WHEN lower(t.payment_type) IN ('derivative') THEN 'adjustment'
    ELSE 'other'
  END AS settlement_class,

  -- Does a person physically end the shift holding money that belongs to the
  -- company? This is the number that sizes a cash-handling control, and it is
  -- not the same as "paid in cash" on a channel where a supervisor collects.
  (lower(coalesce(t.payment_type, '')) IN ('cash', 'cash-driver')) AS driver_holds_cash,

  -- Is this fare owed to us by somebody after the ride ended?
  (lower(coalesce(t.payment_type, '')) IN ('room-charge', 'hotel-charge', 'posted-for-salary'))
    AS is_receivable,

  -- A complimentary ride has a price of zero that is not a price. Ratios over
  -- money must exclude it or every average fare is pulled toward zero by rides
  -- that were never for sale.
  (lower(coalesce(t.payment_type, '')) IN ('foc-complimentary', 'foc', 'complimentary'))
    AS is_complimentary,

  -- Uber's consumer tier. `product` also holds the hotel channel's booking
  -- types, which are not tiers and must never share an axis with them.
  CASE WHEN t.platform = 'uber' THEN t.product END AS uber_tier,
  -- The premium tiers are the limousine product. Mix between them and UberX is
  -- the single biggest lever on revenue per kilometre that does not require
  -- another trip.
  CASE WHEN t.platform = 'uber' AND t.product IN ('Black', 'Comfort') THEN true
       WHEN t.platform = 'uber' THEN false END AS is_premium_tier,

  -- Hotel-channel fields that are only in the raw payload.
  t.raw ->> 'client'         AS guest_id,
  t.raw ->> 'hotelOperator'  AS operator_id,
  t.raw ->> 'roomNumber'     AS room_no,
  t.raw ->> 'tripPurpose'    AS trip_purpose,
  -- Casting straight out of JSON would take the whole view down the first time
  -- a provider put a word where a flag belongs, and this view is on the path of
  -- every commercial query. Each cast is guarded by its own shape check.
  CASE WHEN t.raw ->> 'overRun' IN ('true', 'false')
       THEN (t.raw ->> 'overRun')::boolean END AS over_run,
  CASE WHEN jsonb_typeof(t.raw -> 'stops') = 'array'
       THEN jsonb_array_length(t.raw -> 'stops') END AS stop_count,
  (t.raw -> 'authorization' IS NOT NULL AND t.raw -> 'authorization' <> 'null'::jsonb)
    AS has_authorization,
  CASE WHEN t.raw ->> 'hourlyTripMargin' ~ '^-?[0-9]+(\.[0-9]+)?$'
       THEN (t.raw ->> 'hourlyTripMargin')::numeric END AS hourly_margin_pct,

  -- The unpaid leg. Only the hotel channel records where the driver set off
  -- from, so this is NULL everywhere else — and a NULL here means "not
  -- measured", never "zero".
  CASE WHEN t.deadhead_km IS NOT NULL AND t.distance_km > 0
       THEN round((t.deadhead_km / t.distance_km * 100)::numeric, 1) END AS deadhead_pct,

  (t.requested_at AT TIME ZONE 'Asia/Dubai')::date AS ext_local_day,
  -- Dubai's operating day, named the way a dispatcher names it. The airport
  -- wave starts before dawn, so 00:00-05:00 is its own band rather than the
  -- tail of the previous evening.
  CASE
    WHEN extract(hour FROM t.requested_at AT TIME ZONE 'Asia/Dubai') < 5  THEN 'night'
    WHEN extract(hour FROM t.requested_at AT TIME ZONE 'Asia/Dubai') < 10 THEN 'morning'
    WHEN extract(hour FROM t.requested_at AT TIME ZONE 'Asia/Dubai') < 15 THEN 'midday'
    WHEN extract(hour FROM t.requested_at AT TIME ZONE 'Asia/Dubai') < 20 THEN 'evening'
    ELSE 'late'
  END AS daypart
FROM trip_norm t;

COMMENT ON VIEW trip_ext IS
  'trip_norm plus the commercial dimensions: who settles the fare and when, whether the fare is a real price, Uber tier, and the hotel-channel fields that only exist in the raw payload.';

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
