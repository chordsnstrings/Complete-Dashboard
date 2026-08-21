-- v18: the other half of the unpaid distance.
--
-- deadhead_km measures the APPROACH leg: where the driver set off from, to
-- where the passenger got in. The corporate page reports it per property and
-- one of them runs at 14.5% of paid distance.
--
-- The hotel API also returns driverEndLat/driverEndLon — where the driver
-- actually was when the job closed — on 961 of 1,258 bookings. Between the
-- drop-off point and that position is the RETURN leg, and it is unpaid too.
-- Reporting only the approach understates a limousine fleet's real empty
-- running, and understates it worst exactly where it matters: a job that ends
-- somewhere with no return work is the expensive kind, and approach distance
-- alone cannot see that.
ALTER TABLE trip ADD COLUMN IF NOT EXISTS return_deadhead_km DOUBLE PRECISION;
COMMENT ON COLUMN trip.return_deadhead_km IS
  'Straight-line km from the drop-off point to where the driver actually ended the job. The unpaid return leg. Understates road distance, so it is a floor. NULL where the channel does not report a driver end position.';

/* A VIEW'S `SELECT t.*` IS FROZEN AT CREATION.
   ──────────────────────────────────────────────────────────────────────────
   trip_norm is `SELECT t.* ... FROM trip t` and was created in v7. Postgres
   expands that star ONCE, when the view is defined, and stores the resulting
   column list. Adding a column to `trip` afterwards does not appear in the
   view, and CREATE OR REPLACE VIEW cannot add one either — it refuses to
   change the output column list of an existing view. So the ALTER TABLE above
   is invisible to trip_norm, and therefore to trip_ext, and therefore to every
   page in this product.

   This will happen again to the next person who adds a column to `trip`, and
   it fails in the most misleading way available: the column exists, the ALTER
   succeeds, and the query against the view says "column does not exist".

   Both views are dropped and rebuilt here so the star re-expands. Order
   matters: trip_ext depends on trip_norm, so trip_norm goes first with
   CASCADE, and both are recreated below.

   These two views are also redefined here rather than edited in v7 and v9,
   because every schema file is replayed on every boot in filename order — an
   edit to v7 would be overwritten by nothing, but a definition left only in v7
   would be recreated by v7 and then need this file's version anyway. Keeping
   the authoritative body here means one file to read. */
DROP VIEW IF EXISTS trip_ext CASCADE;
DROP VIEW IF EXISTS trip_norm CASCADE;

CREATE VIEW trip_norm AS
SELECT
  t.*,

  -- Is this a booking on a ride-hailing or corporate channel, or a journey
  -- inferred from a GPS trace?
  (t.platform <> 'fms') AS is_booking,

  -- Normalised outcome. NULL where the question does not apply.
  CASE
    WHEN t.platform = 'fms' THEN NULL
    WHEN t.status IS NULL THEN NULL
    WHEN lower(btrim(t.status)) IN ('completed', 'finished', 'complete', 'closed', 'delivered')
      THEN 'completed'
    WHEN t.status ILIKE '%cancel%'
      OR lower(btrim(t.status)) IN ('client_did_not_show', 'driver_did_not_respond',
                                    'driver_rejected', 'rejected', 'expired', 'failed', 'no_show')
      THEN 'not_completed'
    ELSE 'other'
  END AS outcome,

  -- Dubai-local calendar keys. Every grouping and every window bound should
  -- use these rather than re-deriving them.
  (t.requested_at AT TIME ZONE 'Asia/Dubai')::date            AS local_day,
  extract(hour  FROM t.requested_at AT TIME ZONE 'Asia/Dubai')::int AS local_hour,
  extract(dow   FROM t.requested_at AT TIME ZONE 'Asia/Dubai')::int AS local_dow,
  date_trunc('month', (t.requested_at AT TIME ZONE 'Asia/Dubai'))::date AS local_month,

  -- Does this row carry money, and is its distance usable as a trip distance?
  -- The Uber trip export has no fare column at all, so `price` is NULL on every
  -- Uber row; a revenue figure describes only the hotel, Yango and Bolt rows.
  (t.price IS NOT NULL) AS has_fare,
  -- FMS distances are odometer-derived and occasionally implausible. A trip
  -- distance is only comparable within a sane range.
  (t.distance_km IS NOT NULL AND t.distance_km > 0 AND t.distance_km < 500) AS has_distance
FROM trip t;

COMMENT ON VIEW trip_norm IS
  'trip, with the platform differences resolved: is_booking separates bookings from telematics journeys, outcome normalises status across platforms, local_* are Dubai-local calendar keys, has_fare/has_distance mark which rows a money or distance ratio may be computed over. Rebuilt in v18 so that columns added to trip after v7 are actually visible.';


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
  END AS daypart,

  /* The two figures that only exist once both legs do. `return_deadhead_km`
     itself arrives through `t.*` above — naming it again here is a duplicate
     column and Postgres rejects the view outright.

     A deadhead percentage built on the approach alone describes half the empty
     running, and the more forgivable half: sending a driver 5 km to a pickup
     is normal; leaving them 30 km from the next job is what costs money. */
  CASE WHEN t.deadhead_km IS NOT NULL OR t.return_deadhead_km IS NOT NULL
       THEN coalesce(t.deadhead_km, 0) + coalesce(t.return_deadhead_km, 0) END AS total_deadhead_km,
  -- Only where BOTH legs were measured. Adding a measured approach to an
  -- unmeasured return and calling the result a total is how a partial figure
  -- becomes a confident wrong one.
  CASE WHEN t.deadhead_km IS NOT NULL AND t.return_deadhead_km IS NOT NULL
        AND t.distance_km > 0
       THEN round(((t.deadhead_km + t.return_deadhead_km) / t.distance_km * 100)::numeric, 1)
       END AS total_deadhead_pct,
  (t.deadhead_km IS NOT NULL AND t.return_deadhead_km IS NOT NULL) AS both_legs_measured
FROM trip_norm t;

COMMENT ON VIEW trip_ext IS
  'trip_norm plus the commercial dimensions: who settles the fare and when, whether the fare is a real price, Uber tier, the hotel-channel fields that only exist in the raw payload, and BOTH unpaid legs — the approach to the pickup and the return from the drop-off.';
