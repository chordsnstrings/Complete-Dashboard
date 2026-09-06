-- v62: an authorisation on file is not an authorisation that was granted.
--
-- trip_ext.has_authorization has meant "the provider attached an authorization
-- object to this booking" since sql/schema_v18.sql:182-183, and every reader of
-- it treats it as "this booking was approved". On the hotel channel those are
-- not the same question and have never once had the same answer: the object is
-- attached when the booking is raised. Redefined below as GRANTED, with the
-- state the old column was really reporting split out into its own column so
-- that neither reading is lost.
--
-- This is a new file rather than an edit to v18 because src/db.js replays the
-- schema list on every boot and skips a file whose sha is unchanged: an edit to
-- v18 would re-run v18 on every database in the estate, and a v18 left alone
-- would keep serving the old definition. sql/schema_v18.sql:17-40 says the same
-- thing in its own words.
--
-- trip_ext is dropped and recreated rather than replaced in place because
-- CREATE OR REPLACE VIEW may only append columns, and two of the three columns
-- here are new while the third changes meaning. Nothing in sql/ selects from
-- trip_ext — grep over sql/*.sql finds it named only in v18, which defines it,
-- and in a comment in v20 — so CASCADE has nothing to take down with it. The
-- body below is v18's, verbatim, apart from the authorisation columns.

DROP VIEW IF EXISTS trip_ext CASCADE;

CREATE VIEW trip_ext AS
SELECT
  t.*,

  CASE
    WHEN t.payment_type IS NULL OR btrim(t.payment_type) = '' THEN NULL
    WHEN lower(t.payment_type) IN ('cash', 'cash-driver', 'cash-supervisor') THEN 'cash'
    WHEN lower(t.payment_type) IN ('pos-driver', 'pos-supervisor', 'braintree', 'zaakpay',
                                   'kcp_pg', 'card', 'credit_card') THEN 'card'
    -- `in_app` is Bolt's word for a fare paid inside the app: the rider is
    -- charged by the platform and the fleet is paid on the statement, which is
    -- exactly what every other member of this bucket means. It was in no bucket
    -- at all, so 12,722 of Bolt's 27,450 bookings — 46% with `business` — swept
    -- into the "Everything else" tile on api/public/settlement.js, on the page
    -- whose subject is which money the fleet already holds.
    WHEN lower(t.payment_type) IN ('apple_pay', 'google_pay', 'paypal', 'alipay2', 'digital',
                                   'wallet', 'cashless', 'in_app') THEN 'wallet'
    -- `business` is Bolt Business: a company account settled by invoice, the
    -- same arrangement as a room charge and a corporate booking.
    WHEN lower(t.payment_type) IN ('room-charge', 'hotel-charge', 'company', 'corporate',
                                   'invoice', 'business') THEN 'on_account'
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
  /* AN AUTHORISATION THAT WAS GRANTED, not an authorisation object that exists.
     ────────────────────────────────────────────────────────────────────────
     This column used to be `t.raw -> 'authorization' IS NOT NULL AND <> 'null'`
     — pure object existence. The hotel provider attaches the object when the
     booking is RAISED, not when anybody approves it, so the column answered
     "did the workflow start" while every reader of it — the Overview KPI on
     api/public/corporate.js and the "Charged with no authorisation on file"
     leakage category in api/analytics_routes.js — asked it "was this booking
     approved". On the page whose entire subject is billing control, that is the
     one question it must not get wrong.

     What it cost, measured on production on 2026-09-05 over 2026-01-01 →
     2026-09-05. /api/corporate/summary returns 1,737 hotel bookings and 225
     authorized_trips, and /api/corporate/properties shows those 225 are exactly
     the bookings of one property, "Office" (675d566697467adfe29a32c7) — the
     only one of the six whose partner.approval_required is true, AED 39,198 at
     an average fare of AED 174.21, every one of them priced. The provider
     attached an authorisation object to all 225 and granted none of them, so
     /api/corporate/leakage answered the unauthorized category with n 0 and
     disabled null: a category claiming it had looked and found nothing, on the
     one property in the fleet where every billed booking was charged without an
     approval. Thirteen of the 225 are priced at zero and so are not billed at
     all, which is what the category's own price > 0 qualifier is for — 212
     bookings are charged, and the category should have been reporting 212.
     The rate ran the other way for the same reason — the KPI printed 13% under
     a caption reading "of bookings at properties that require one", which is 225 over all 1,737 channel bookings rather than over
     the 225 the caption names.

     The key names are the provider's, enumerated rather than guessed.
     /api/probe/results lists exactly four members under `authorization` on the
     hotel trip-report surface — _id, authorizationRequired, authorizationStatus
     and authorizationBy — and authorizationStatus carries one distinct value
     across every row that has one, with authorizationBy filled on 0% of them:
     nobody has ever approved anything under that key. The audit read that value as "pending"
     by enumeration on 2026-09-05, before sql/schema_v59.sql's redaction started
     withholding it — api/redact.js's SECRET_KEY matches the bare word `auth`,
     so `authorizationStatus` is now suppressed at the boundary even though the
     stored row still has it, which is why this predicate can read it and the
     schema pages can no longer print it.

     The second key is the one the audit's first pass missed and the reason this
     is not simply `= 'pending'` inverted. The provider ALSO publishes a decided
     approval under `operatorApproval`, whose members are _id, status, approvedAt
     and approvedBy, and whose status really does take more than one value —
     /api/schema/raw-values over 2025-01-01 → 2026-12-31 returns 1,183 JSON-nulls
     and exactly two objects, both "approved" by 69cb9d14b11d90e2dcc28690 on
     2026-09-04, and the probe has seen a "rejected" as well. A predicate reading
     only the first key would report zero approvals across the whole record —
     right as a count today and the same bug wearing the opposite sign the moment
     the operator approves anything.

     Both halves are wrapped in coalesce(..., false) deliberately. `->>` on a
     missing path is NULL, `NULL IN (...)` is NULL, and `NOT NULL` is NULL — so
     an uncoalesced predicate would make this column NULL on the 1,495 bookings
     that carry no authorisation at all, and `NOT has_authorization` in the
     leakage query would drop every one of them instead of accusing them. That
     would have pinned the category at zero a third time, for a third reason. */
  (coalesce(lower(t.raw -> 'authorization' ->> 'authorizationStatus')
              IN ('approved', 'authorized'), false)
   OR coalesce(lower(t.raw -> 'operatorApproval' ->> 'status') = 'approved', false))
    AS has_authorization,

  /* Raised and not granted — the state all 225 Office bookings are actually
     in, and the state the old column called "yes". Kept apart from
     has_authorization rather than folded into its negation, because "nobody
     asked" and "somebody asked and no one answered" are different findings and
     the page prints both. */
  ((    (t.raw -> 'authorization'    IS NOT NULL AND t.raw -> 'authorization'    <> 'null'::jsonb)
     OR (t.raw -> 'operatorApproval' IS NOT NULL AND t.raw -> 'operatorApproval' <> 'null'::jsonb))
   AND NOT (coalesce(lower(t.raw -> 'authorization' ->> 'authorizationStatus')
                       IN ('approved', 'authorized'), false)
            OR coalesce(lower(t.raw -> 'operatorApproval' ->> 'status') = 'approved', false)))
    AS authorization_pending,

  /* The provider's own word for where the approval got to, so a row can print
     it instead of the page inventing one. Two spellings of "not granted" reach
     here — a pending authorisation and a rejected operatorApproval — and a
     table that renders both as "pending" states a reason that is false for the
     second. Whatever a reader sees in this column, the provider wrote. */
  coalesce(nullif(btrim(t.raw -> 'authorization'    ->> 'authorizationStatus'), ''),
           nullif(btrim(t.raw -> 'operatorApproval' ->> 'status'), ''))
    AS authorization_status,
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

COMMENT ON COLUMN trip_ext.has_authorization IS
  'True when an authorisation was GRANTED — authorization.authorizationStatus approved or authorized, or operatorApproval.status approved. Never NULL: a booking with no authorisation at all is false, so NOT has_authorization accuses it rather than dropping it. This is not "an authorization object exists", which is what it meant before v62 and what authorization_pending now carries.';
COMMENT ON COLUMN trip_ext.authorization_pending IS
  'True when an authorisation is on file for this booking and has not been granted — the state every billed booking at the one approval-requiring property was in on 2026-09-05, and the state the pre-v62 has_authorization reported as authorised.';
COMMENT ON COLUMN trip_ext.authorization_status IS
  'The provider''s own word for where the approval got to, from authorization.authorizationStatus or else operatorApproval.status. NULL where no authorisation is on file. Printed verbatim so a page never has to guess between pending and rejected.';
