-- ===========================================================================
-- Bolt's balance ledger: the payout that has left, before Bolt lists it.
-- ===========================================================================
-- THE DEFECT. The operator reported a Bolt payout to both fleets on Monday
-- 21 September 2026. platform_payout held none: its Bolt rows come from the
-- portal's getPayouts, and getPayouts is a LAGGING register. Measured: the
-- 14 September payout was absent from it on Wednesday the 16th and present by
-- Monday the 21st, so a payout that has already reached the bank is invisible
-- to it for most of a week.
--
-- Bolt's balance ledger is not late. getFleetBalanceDetails over a single day
-- returns that day's statement, and on 2026-09-23 it returned, per fleet:
--
--     day          Ecosine "Weekly payout"   Egari "Weekly payout"
--     2026-09-14       2,490.95                  832.25     <- equals getPayouts, to the fils
--     2026-09-20        (none)                   (none)
--     2026-09-21       1,275.14                  619.18     <- the payout the register lacked
--     2026-09-22        (none)                   (none)
--
-- and the statement balances: starting + earnings - expenses = ending, to the
-- fils, on both fleets over 15-23 September.
--
-- WHY A SEPARATE TABLE AND NOT platform_payout. platform_payout is keyed on
-- Bolt's payout id, which the ledger does not carry. Writing a ledger payout
-- there under a synthetic id would put the 21st in TWICE the moment getPayouts
-- catches up and lists it under its real id — the same money summed twice in
-- the one table whose whole claim is "this reached the bank". So the ledger
-- lives here, one row per fleet per day, and the API shows a ledger payout
-- ONLY for a date the register does not yet hold. When the register catches
-- up, the ledger row stops being shown without anything being deleted.

CREATE TABLE IF NOT EXISTS platform_balance_day (
  platform          TEXT NOT NULL,            -- bolt
  fleet_id          TEXT NOT NULL,            -- ecosine | egari
  /* THE FLEET'S DAY. The ledger is asked for one Dubai calendar day at a time,
     so this is the day the collector asked about, not a conversion of a stamp. */
  day               DATE NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'AED',
  /* What left the fleet's balance for its OWN bank that day: Bolt's "Weekly
     payout" plus "Instant cashout". NOT "Tax authority payout", which goes to
     a tax authority and never reaches the fleet's account. NULL when the day
     carried no such line, which is a measured "none", distinct from a day
     nobody asked about — that day simply has no row. */
  payout            NUMERIC(14,2),
  /* Which ledger lines made up `payout`, by Bolt's own titles, so the figure
     can be re-derived and a new kind of bank payout is visible rather than
     silently absent. */
  payout_lines      JSONB,
  starting_balance  NUMERIC(14,2),
  ending_balance    NUMERIC(14,2),
  cash_in_hand      NUMERIC(14,2),
  earnings          JSONB,
  expenses          JSONB,
  /* Whether starting + earnings - expenses = ending held, within a fil. A
     statement that does not balance is still stored, and says so. */
  balances          BOOLEAN,
  /* First time this day was stored, never overwritten — the measure of how
     early the ledger showed a payout the register did not. */
  collected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, fleet_id, day)
);

CREATE INDEX IF NOT EXISTS platform_balance_day_payout_idx
  ON platform_balance_day (platform, fleet_id, day) WHERE payout IS NOT NULL;

-- Bolt's own statement of where the balance stands and when it pays next,
-- from getFleetBalanceSummary. One row per fleet, overwritten each check.
-- The Finance page said "Bolt publishes no cadence"; Bolt publishes a date.
CREATE TABLE IF NOT EXISTS platform_balance_now (
  platform          TEXT NOT NULL,
  fleet_id          TEXT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'AED',
  current_balance   NUMERIC(14,2),
  /* next_payout_date is a unix SECOND; this is its Dubai calendar day. */
  next_payout_on    DATE,
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, fleet_id)
);
