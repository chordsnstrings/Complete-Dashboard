/* What Uber will tell a fleet about a driver's quality, which is everything
   except the word for it.
   ─────────────────────────────────────────────────────────────────────────
   driver_performance has carried acceptance_rate, cancellation_rate and
   completion_rate since the first schema, and grep says no collector has ever
   written one of them. That is why the ACCEPTANCE tile on every driver's
   Quality tab is an em-dash, and why "rank the drivers" has never been
   answerable from this database.

   The columns were not missing. The report was never asked for.

   Probed live on 2026-08-31: REPORT_TYPE_DRIVER_QUALITY returns 57 driver
   rows for a single week with seventeen columns — confirmation, cancellation
   and completion rates, ratings over the last four weeks AND over the previous
   five hundred trips, the acceptance and cancellation rates as the DRIVER sees
   them in their own app, and the full disposition of every dispatch: accepted,
   rejected, cancelled, cancelled-at-fault, failed, and total assignments.

   This is the raw material Uber ranks a driver on. It is not the Uber Pro tier
   — that was probed on the same day and is not exposed to a supplier account
   at all, under controls that rule out a dead session, a server that hides its
   schema, and a near-miss error that looks like a hidden field. But a tier is
   four words computed from these numbers, and unlike a tier these need no
   driver opt-in, so they cover the whole roster instead of only the drivers
   who enrolled and consented.

   Added to driver_performance rather than given a table, because the grain is
   identical — one row per driver per period — and a sibling table would be a
   second place to look for the same fact. */

-- The period measure of accepting work, distinct from the rolling figure below.
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS confirmation_rate DOUBLE PRECISION;

/* Two ratings, because Uber reports two and they answer different questions.
   `rating` takes the four-week figure — the one that moves with the period the
   row covers. rating_500 is the trailing average over the previous five
   hundred trips, which barely moves and is the number a driver thinks of as
   theirs. The gap between them IS the trend, available today, without waiting
   for driver_rating_history to accumulate a reading a week. */
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS rating_500 DOUBLE PRECISION;

/* The rates as the DRIVER sees them, which Uber labels that way and which are
   current rather than period figures. Kept apart from the period columns for
   exactly that reason: writing a rolling number into a dated row is how a
   dashboard comes to state something true about today as though it were true
   about March. */
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS acceptance_rate_app DOUBLE PRECISION;
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS cancellation_rate_app DOUBLE PRECISION;

/* Every dispatch, by what became of it. Counts rather than rates, because a
   rate over four trips and a rate over four hundred look identical and mean
   nothing alike — and because a rate cannot be summed across drivers or weeks
   while these can. */
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS trips_accepted        INT;
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS trips_rejected        INT;
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS trips_cancelled       INT;
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS trips_cancelled_driver INT;
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS trips_failed          INT;
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS trip_assignments      INT;

/* Which report a row came from. Three surfaces write this table now — the
   GraphQL earner breakdown, and two CSV reports — and when they disagree about
   a driver-week the first question is which one said what. */
ALTER TABLE driver_performance ADD COLUMN IF NOT EXISTS source_report TEXT;

COMMENT ON COLUMN driver_performance.acceptance_rate IS
  'Period acceptance, from REPORT_TYPE_DRIVER_QUALITY Confirmation rate. Empty on every row written before 2026-08-31, when nothing had ever collected it.';
COMMENT ON COLUMN driver_performance.rating_500 IS
  'Uber driver rating over the previous 500 trips. rating holds the last-4-weeks figure; the pair is a trend that needs no history table.';
