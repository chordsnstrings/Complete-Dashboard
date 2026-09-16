/* THE INDEX THE OPERATOR'S LAST-TRIP RULE READS ON, AND WHY IT IS ON ended_at.
   ─────────────────────────────────────────────────────────────────────────
   Every index this table has ever carried is keyed on requested_at:
   sql/schema.sql:75-77 gives (requested_at), (plate) and (fleet_id,
   requested_at); sql/schema_v7.sql:58 gives a partial (plate, requested_at).
   Nothing keys on ended_at, and api/unauthorized_sql.js's own header declined
   to add one, reasoning that the bracket's scan is bounded on requested_at and
   that a missed long trip could only make the module more conservative.

   THE OPERATOR'S RULE CHANGED THAT REASONING RATHER THAN INHERITING IT. The
   rule asks a question about the END of a trip — "whoever did the last trip on
   uber" — over a lookback of STALE_CAP_MIN, 21.97 days, and it added three
   further per-plate reads that the old reasoning never covered: `ever` (the
   whole plate's Uber history, ordered by ended_at), `hist` (the whole plate's
   history across every channel, including a count(DISTINCT person)) and
   later_other (the whole gap between the last Uber trip and the journey, on
   every other channel). attributionJoin() is materialised THREE times in the
   one Promise.all behind /api/unauthorized/attributed — the rows query, the
   total and the distribution — so on production's 120 unexplained segments
   those reads run 360 times per request over a trip table that
   api/driver_routes.js's own header measures at 175,000 rows. Both services
   are basic-xxs. The symptom of getting this wrong is not a wrong answer: it
   is a timeout or an OOM kill on the one page the operator was promised.

   WHY IT IS NOT A LOOKBACK BOUND INSTEAD. The obvious alternative is to stop
   `ever` and `hist` at a fixed date. That was rejected: the module's own
   fixture 10 exists because "this plate has Uber trips but none before the
   journey" was measured at 1 of 120 under a lookback bounded at 2026-06-01 and
   0 of 120 once it reached 2025-10-01 — i.e. a lookback artefact printed as a
   fact about the car. A date hard-coded in SQL rots into exactly that defect,
   and the sentences these CTEs feed are statements about a VEHICLE. The index
   makes the unbounded read cheap instead, which is the answer that does not
   trade a performance fix for an honesty one.

   DESC on ended_at because every reader of it takes the most recent row first.
   Partial on plate IS NOT NULL to match trip_plate_requested_idx's shape and
   because a trip with no plate can never be attributed to a car.

   NOT a replacement for trip_plate_requested_idx: the bracket's `near` CTE is
   still bounded on requested_at and still wants that one. */
CREATE INDEX IF NOT EXISTS trip_plate_ended_idx
  ON trip (plate, ended_at DESC) WHERE plate IS NOT NULL;
