/* ── one complete row per driver, per day ─────────────────────────────────
   driver_day already held the work: trips, distance, the shape of the shift,
   online and idle minutes. It also held a column called `fares`, which is
   sum(trip.price) — and the Uber trip export carries no fare at all. So the
   money column on the fleet's daily driver record is NULL for 93% of its
   bookings, while the real money sits one table away in driver_statement_day
   at exactly the same grain.

   That is not a harmless normalisation. A reader who groups driver_day by
   week or month and sums `fares` gets a revenue figure covering the hotel
   channel and nothing else — AED 65,860 where the fleet received AED 399,857.
   The trap is quiet, it is easy to fall into, and this repository has already
   watched a Finance page open on that number.

   So the day row is completed. The statement money and the bank payout are
   folded in beside the work they paid for, and every grain above this one —
   week, month, the whole window — is then a sum over one honest source rather
   than a join somebody has to remember.

   The columns are NULL, never 0, when the platform reported nothing for that
   driver-day. Zero would say "this driver earned nothing today", which is a
   different and much stronger claim than "no statement covers this day". */

ALTER TABLE driver_day
  /* From driver_statement_day, source <> 'ledger': what the PLATFORM reported.
     The operator's imported workbook is reference data and must never be
     folded in here, or the reconciliation would be checking itself. */
  ADD COLUMN IF NOT EXISTS stmt_gross   NUMERIC,
  ADD COLUMN IF NOT EXISTS stmt_fees    NUMERIC,
  ADD COLUMN IF NOT EXISTS stmt_net     NUMERIC,
  ADD COLUMN IF NOT EXISTS stmt_tips    NUMERIC,
  ADD COLUMN IF NOT EXISTS stmt_salik   NUMERIC,
  ADD COLUMN IF NOT EXISTS stmt_cash    NUMERIC,
  ADD COLUMN IF NOT EXISTS stmt_trips   INT,
  /* From driver_payout_day: what reached the bank. Kept separate from the
     statement because they answer different questions and differ legitimately
     — a payout below the on-trip figure is drivers holding cash, not missing
     money. */
  ADD COLUMN IF NOT EXISTS payout       NUMERIC,
  ADD COLUMN IF NOT EXISTS payout_cash  NUMERIC,

  /* Which of the three money columns is the one to read for this row, decided
     once here so that no page has to work it out again:
       'statement' — the platform reported net for this driver-day
       'fares'     — no statement, but the trips carry per-trip prices
       'none'      — the day earned money that nothing has reported yet
     A page that shows money must show this too, or it is guessing on the
     reader's behalf. */
  ADD COLUMN IF NOT EXISTS money_source TEXT,

  /* The fleet's actual receipts for this driver-day: the statement net where
     there is one, the summed per-trip fares where there is not, NULL where
     neither exists. This is the column to sum at any grain. `fares` stays
     exactly as it was — it is still the honest answer to "what did the trip
     rows price" — but it is no longer the only money on the row, so it can no
     longer be mistaken for the answer to "what did this driver earn". */
  ADD COLUMN IF NOT EXISTS money        NUMERIC;

COMMENT ON COLUMN driver_day.money IS
  'The fleet''s receipts for this driver-day: stmt_net where a platform statement covers it, else the summed per-trip fares, else NULL. Sum THIS at any grain — never `fares`, which is sum(trip.price) and is NULL for every Uber trip.';
COMMENT ON COLUMN driver_day.money_source IS
  'Which column `money` was taken from: statement | fares | none. A surface that shows money must show its coverage, because the three are not equally complete.';
COMMENT ON COLUMN driver_day.fares IS
  'sum(trip.price) over trips that carry one. NULL for Uber, which publishes no per-trip fare. Not the driver''s earnings — see `money`.';

/* Grouping a driver-day by week or month is now the common read, and both
   start by filtering a date range. */
CREATE INDEX IF NOT EXISTS driver_day_day_idx ON driver_day (day);

/* ── the week grain ───────────────────────────────────────────────────────
   rollup_day and rollup_month existed; a week did not, so "how did last week
   compare" had no answer that did not re-scan the trip table. Same columns,
   same refresh, keyed on the Monday that starts the week (date_trunc('week')
   in Postgres is ISO — Monday), so a bucket is a whole week or it is the
   partial one at the edge of the window, and never a silent mixture. */
CREATE TABLE IF NOT EXISTS rollup_week (
  week             DATE NOT NULL,
  platform         TEXT NOT NULL DEFAULT '*',
  fleet_id         TEXT NOT NULL DEFAULT '*',
  trips            INT,
  bookings         INT,
  telematics       INT,
  drivers          INT,
  vehicles         INT,
  earning_vehicles INT,
  attributed_trips INT,
  revenue          NUMERIC,
  priced_trips     INT,
  km               NUMERIC,
  measured_trips   INT,
  completed        INT,
  not_completed    INT,
  outcome_n        INT,
  computed_at      TIMESTAMPTZ,
  PRIMARY KEY (week, platform, fleet_id)
);

COMMENT ON TABLE rollup_week IS
  'Fleet aggregate per ISO week (keyed on the Monday), platform and fleet. Same columns and same definition as rollup_day and rollup_month — one grain SQL builds all three, so they cannot drift apart.';
