-- The statement view of the money, beside the bank view of it.
--
-- Reconciling against the operator's ledger settled what our Uber payout
-- figure IS: netOutstanding, the amount Uber wires to the bank — statement net
-- MINUS the cash drivers already collected, PLUS tips and Salik tolls. Both
-- numbers are real and neither substitutes for the other: "what did the fleet
-- earn" is the statement net; "what arrived in the account" is the payout.
-- Shown alone, each is routinely misread as the other — a 13% "gap" that was
-- drivers taking a fifth of fares in cash.
--
-- This table holds the statement/treasury view at day grain, per driver and
-- fleet: gross, platform fees, net (= gross - fees), tips, Salik, and where
-- the money physically sits (cash in the driver's hand, bank transfer,
-- network-remitted cash, still-unremitted balance). Sources:
--   'ledger'    — the operator's own daily ledger (one row per driver-day,
--                 imported; the ONLY machine-readable source for months the
--                 provider APIs no longer serve)
--   'uber_rest' — Uber's earner-payments components, where that surface
--                 still answers
-- Kept OUT of driver_performance and the payout resolution on purpose: the
-- resolution takes the finest window per day across all rows, and daily
-- statement rows would win every day they touch, silently replacing the bank
-- figure with the statement figure. Two measures, two tables, no winner.
--
-- Identity is the ledger's: driver NAME (normalised) plus fleet. driver_ext_id
-- is filled where a platform id can be matched, but the name is the key — the
-- ledger predates our ids and its people must not vanish for want of a match.
CREATE TABLE IF NOT EXISTS driver_statement_day (
  platform      TEXT NOT NULL,
  fleet_id      TEXT NOT NULL,
  driver_name   TEXT NOT NULL,
  name_key      TEXT GENERATED ALWAYS AS (lower(regexp_replace(driver_name, '\s+', ' ', 'g'))) STORED,
  driver_ext_id TEXT,
  day           DATE NOT NULL,
  gross         NUMERIC,
  fees          NUMERIC,
  net           NUMERIC,
  tips          NUMERIC,
  salik         NUMERIC,
  cash          NUMERIC,
  bank          NUMERIC,
  network_cash  NUMERIC,
  unremitted    NUMERIC,
  trips         INT,
  currency      TEXT DEFAULT 'AED',
  source        TEXT NOT NULL,
  /* Statement lines the operator could not tie to a person ("Not Match") and
     the org-level fee rows. Real money — fleet totals include it — but not a
     driver, so driver listings and per-person figures filter it out. */
  pseudo        BOOLEAN NOT NULL DEFAULT false,
  ingested_at   TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (platform, fleet_id, name_key, day, source)
);
CREATE INDEX IF NOT EXISTS statement_day_day_idx  ON driver_statement_day (day);
CREATE INDEX IF NOT EXISTS statement_day_name_idx ON driver_statement_day (name_key, day);
