/* What Uber itself says about a window we already hold.
   ─────────────────────────────────────────────────────────────────────────
   Every completeness number in this product is computed from our own rows.
   /api/coverage/calendar reports 239,236 Uber trips across 376 days with
   gaps: [] and missing_days: 0, and that is an honest answer to the question
   it asks — did anything land on this day. It cannot answer the question
   actually being asked, because a day we collected a tenth of has rows on it
   too and therefore is not a gap.

   The measurement that made this table necessary: trips per active driver per
   day fall from 10.0 in February 2026 to 3.4 in March, and the fall lands in
   the same month, at the same three quarters, in BOTH fleets — Ecosine
   17,385 -> 4,203, Egari 8,052 -> 1,862, two separate businesses holding two
   separate Uber orgs. Two unrelated companies do not lose three quarters of
   their work on the same Sunday. Our own calendar called that year complete.

   So the verdict is Uber's, not ours. A row here is one window, for one
   fleet, regenerated from the same REPORT_TYPE_TRIP_ACTIVITY the backfill
   collects from, with Uber's Trip UUIDs compared against the ones we stored
   for the same Dubai days.

   Why a table rather than an endpoint that recomputes: an Uber report costs
   minutes at the provider and one of an org's three in-flight report slots,
   so the answer cannot be produced inside a page load, and a verification
   nobody can afford to run is a verification nobody runs. Kept, it also
   becomes a history — a month that agreed in September and disagrees in
   November is a fact about collection that a single live check could never
   see.

   The window is part of the key, not just the fleet, because the whole point
   is per-window coverage; and verified_at is a column rather than the key so
   that re-verifying the same window updates the verdict instead of growing a
   row per attempt. */
CREATE TABLE IF NOT EXISTS uber_trip_audit (
  fleet_id      TEXT NOT NULL,
  window_from   DATE NOT NULL,
  window_to     DATE NOT NULL,
  /* month | week. Two grains, and the difference is not cosmetic: a week
     window sits INSIDE a month window, so a total that sums both counts every
     trip in that week twice and reports an agreement percentage over a
     doubled denominator — the one number the whole panel asks to be trusted
     on. Totals are taken over months alone; the weeks exist so the recent
     past gets a check without waiting for a month to end. */
  kind          TEXT NOT NULL DEFAULT 'month',
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Uber's answer, and ours, for the same Dubai days.
  uber_rows     INTEGER,      -- rows in the report dated inside the window
  our_rows      INTEGER,      -- rows we hold for those Dubai days, this fleet
  in_both       INTEGER,
  uber_only     INTEGER,      -- trips Uber served that we never stored, anywhere
  /* Trips Uber served for THIS fleet that we hold under the other one. Not
     loss, and counting them as loss would be the panel's worst possible
     failure: trip's key is (platform, external_id) with fleet_id an ordinary
     column the upsert overwrites, so a trip both orgs can see is filed under
     whichever collected it last and is invisible to a fleet-filtered query.
     NULL means the second query could not be run — unknown, not none. */
  misfiled      INTEGER,
  ours_only     INTEGER,      -- trips we hold that this report does not list
  agreement_pct NUMERIC(5,1), -- in_both / uber_rows, NULL when Uber served none
  -- A report that returns rows dated outside the window it was asked for is
  -- telling us the window means something other than we assumed, and that is
  -- worth keeping rather than filtering away.
  outside_window INTEGER,
  -- An error is a DIFFERENT answer from zero rows, and the difference decides
  -- whether a backfill is worth running: "Uber will not serve this window any
  -- more" and "Uber served it and it was empty" have opposite consequences.
  error         TEXT,
  past_retention BOOLEAN NOT NULL DEFAULT false,
  took_ms       INTEGER,
  -- A handful of the missing Trip UUIDs, so a finding can be checked against
  -- the supplier portal by hand rather than believed. Never the whole list:
  -- this is evidence, not a second copy of the trip table.
  sample_missing JSONB,
  /* Which days disagreed, not just how many. Without this a month short by
     12,899 trips can be seen and not opened: the reader is told a quarter of
     March is missing and has no way to tell four dead days from thirty-one
     thin ones — on a page whose entire grain is the day, and where those two
     shapes point at completely different causes. */
  days          JSONB,
  PRIMARY KEY (fleet_id, window_from, window_to)
);

CREATE INDEX IF NOT EXISTS uber_trip_audit_stale_idx
  ON uber_trip_audit (verified_at);

COMMENT ON TABLE uber_trip_audit IS
  'Uber own answer for a window we already hold, compared against our stored Trip UUIDs. The only completeness figure in this product that is not computed from our own rows.';

/* The columns added to this file after it first existed, restated as ALTERs.
   ─────────────────────────────────────────────────────────────────────────
   CREATE TABLE IF NOT EXISTS does nothing on a database that already has the
   table, so a column added by editing the CREATE above would never reach one.
   This file has not been applied anywhere yet, so today these are no-ops — and
   they are here so that stays true if it ever is applied twice, because the
   failure they prevent is silent: analytics_routes.js filters totals on `kind`
   and a missing column would make every week window count twice in the one
   figure the panel asks to be trusted on. */
ALTER TABLE uber_trip_audit ADD COLUMN IF NOT EXISTS kind     TEXT NOT NULL DEFAULT 'month';
ALTER TABLE uber_trip_audit ADD COLUMN IF NOT EXISTS misfiled INTEGER;
ALTER TABLE uber_trip_audit ADD COLUMN IF NOT EXISTS days     JSONB;
