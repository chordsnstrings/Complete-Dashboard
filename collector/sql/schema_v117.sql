-- v117: Uber's live per-trip money — POST /v1/vehicle-suppliers/transactions
-- (src/sources/uber_transactions.js, FIX-STATUS UTX).
--
-- ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
-- Uber's per-trip money reached this product by two routes only: the fare walk
-- (REPORT_TYPE_PAYMENTS_ORDER, hourly, and Uber publishes a ride's fare hours
-- after it — 4 h one night and 15 h the next, measured 2026-10-07/08) and the
-- weekly statements. So the day a reader is looking at is the one day whose
-- Uber bookings carry no price: at 20:07 Dubai on 2026-09-08, 0 of 596.
--
-- Uber documents a live feed of the same money, per transaction, at
-- sub-minute freshness, on the OAuth scope src/config.js already requests.
-- docs/COVERAGE.md "Uber's live per-trip feed WORKS" records the one request
-- shape it answers; every probe here had asked it with GET and recorded the 404
-- as "the provider serves nothing". This table holds what that feed returns.
--
-- ── WHAT A ROW IS ───────────────────────────────────────────────────────────
-- One TRANSACTION, keyed on Uber's transactionUuid — so the overlapping
-- re-walk the collector does every quarter hour (the last six hours, again)
-- rewrites a row rather than adding one. A trip can carry several (the ride,
-- a later adjustment, a tip); `uber_live_trip_money` below folds them per trip.
--
-- Amounts arrive as integer `amountE5` (divide by 100,000 for AED) and are
-- stored to five places so nothing is rounded on the way in. The named columns
-- are the nodes of Uber's own category tree that this product already reads off
-- the payments report and the weekly statement — the SAME tree, measured on
-- production 2026-11-12:
--
--   paid_to_you
--   ├── your_earnings
--   │   ├── fare                 ← `fare`, the BRANCH: what the rider was charged
--   │   │   ├── little_fare      ← `fare_base`, the base-fare leaf
--   │   │   └── wait_time
--   │   ├── service_fee          ← Uber's 25%, negative
--   │   └── taxes_earnings       ← `taxes`, the 5% VAT on that fee
--   │       └── tax_on_service_fee
--   └── trip_balance
--       └── refunds
--           └── toll
--
-- `fare` is the branch and not the leaf for the reason PAY_COLS in
-- src/sources/uber.js records at length: the leaf understates every ride that
-- was not purely base fare, and the branch is the statement's `fare` line.
-- `categories` keeps every node as path → AED, so a figure nobody named today
-- (a toll, a cash collection) is not thrown away.
--
-- No names. Uber sends the driver's first and last name on every row; the
-- roster already holds them, and this table has no reason to keep a second
-- copy of anybody's name. The driver is kept as Uber's own account id.

CREATE TABLE IF NOT EXISTS uber_live_transaction (
  transaction_uuid TEXT PRIMARY KEY,
  trip_uuid        TEXT,                 -- trip.external_id where trip.platform = 'uber'
  fleet_id         TEXT REFERENCES fleet(id),
  driver_ext_id    TEXT,                 -- Uber's driverUuid; never a name
  processed_at     TIMESTAMPTZ NOT NULL, -- Uber's processedAt: what the time-range filter selects on
  description      TEXT,                 -- as sent: TRIP | PERSONAL_TRANSPORT | ...
  kind             TEXT NOT NULL,        -- trip | adjustment | payout | other (src: txnKind)
  currency         TEXT,
  paid_to_you      NUMERIC(14,5),
  your_earnings    NUMERIC(14,5),
  fare             NUMERIC(14,5),
  fare_base        NUMERIC(14,5),
  service_fee      NUMERIC(14,5),
  taxes            NUMERIC(14,5),
  tip              NUMERIC(14,5),
  cash_collected   NUMERIC(14,5),
  categories       JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS uber_live_transaction_trip_idx
  ON uber_live_transaction (trip_uuid);
CREATE INDEX IF NOT EXISTS uber_live_transaction_fleet_time_idx
  ON uber_live_transaction (fleet_id, processed_at);

COMMENT ON TABLE uber_live_transaction IS
  'Uber''s live transactions feed (POST /v1/vehicle-suppliers/transactions), one row per '
  'transaction. A freshness tier: the feed serves 15-minute windows from the last 24 hours '
  'only and can never backfill. Kept 90 days (src/sources/uber_transactions.js KEEP_DAYS).';
COMMENT ON COLUMN uber_live_transaction.fare IS
  'The fare BRANCH of Uber''s tree (paid_to_you > your_earnings > fare): what the rider was '
  'charged, the same node as the payments report''s fare and the statement''s fare line.';

-- ── PER TRIP ────────────────────────────────────────────────────────────────
-- The join to trip is on the trip UUID: trip.external_id IS Uber's Trip UUID
-- for platform 'uber' (src/sources/uber.js csvToTrips). The fare is summed over
-- ride transactions only — an adjustment is real money and kept beside it, but
-- adding it to the fare would make a trip's fare differ from what the rider was
-- charged, the same rule the payments walk follows (csvToPayments).
CREATE OR REPLACE VIEW uber_live_trip_money AS
SELECT trip_uuid,
       fleet_id,
       count(*)::int                                         AS transactions,
       sum(fare)        FILTER (WHERE kind = 'trip')         AS fare,
       sum(fare_base)   FILTER (WHERE kind = 'trip')         AS fare_base,
       sum(your_earnings)                                    AS your_earnings,
       sum(service_fee)                                      AS service_fee,
       sum(taxes)                                            AS taxes,
       sum(tip)                                              AS tip,
       sum(paid_to_you) FILTER (WHERE kind = 'adjustment')   AS adjustment,
       min(processed_at)                                     AS first_processed_at,
       max(processed_at)                                     AS last_processed_at
  FROM uber_live_transaction
 WHERE trip_uuid IS NOT NULL
 GROUP BY trip_uuid, fleet_id;

-- ── WHERE A TRIP'S PRICE CAME FROM ─────────────────────────────────────────
-- The live feed may fill trip.price only where nothing better exists, and it
-- must never overwrite a statement-grade figure. That rule needs the price to
-- say where it came from, beside the figure rather than inferred from blobs:
--
--   'uber_live'      the live transactions feed — provisional; the payments
--                    walk replaces it when Uber's report prices the trip
--   'uber_payments'  Uber's payments report (the fare walk) — statement-grade
--   NULL             written by the channel's own trip row (Bolt, Yango, the
--                    hotel desk), or by the payments walk before this column
--                    existed. Either way the live feed treats it as better than
--                    itself and never touches it.
--
-- No backfill of the NULLs: rewriting ~300,000 Uber rows on boot to say
-- 'uber_payments' would double the table's heap on a basic-xxs database to
-- record something the rule above already handles. ADD COLUMN with no default
-- is a catalogue change, not a rewrite.
ALTER TABLE trip ADD COLUMN IF NOT EXISTS price_source TEXT;
COMMENT ON COLUMN trip.price_source IS
  'Where price came from: uber_live (the live transactions feed, provisional), uber_payments '
  '(Uber''s payments report), or NULL (the channel''s own trip row, or the payments walk '
  'before v117). The live feed fills only a NULL price or its own, never anything else.';
