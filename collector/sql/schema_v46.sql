/* A rating over time, because the number alone does not tell you anything.
   ─────────────────────────────────────────────────────────────────────────
   driver_platform_state carries one row per driver per platform and is
   overwritten on every pass, so it answers "what is this driver rated" and
   can never answer "is it going up". Those are different questions and only
   the second is actionable: 4.71 is a fact, 4.71 down from 4.86 over five
   weeks is a conversation, and 4.71 up from 4.55 is the opposite conversation
   with the same person.

   So each reading is kept. One row per driver per platform per day we asked —
   not per day, per ASKING, which is why the key is the observation date and
   not a calendar day: a week with no pull leaves no row rather than a repeated
   one, and a reader can tell "unchanged" from "not measured".

   Weekly, deliberately. Uber's rating is a trailing average over hundreds of
   trips; it moves by hundredths in a week and reading it daily would fill this
   table with seven identical rows for every real movement. The pull is one
   GraphQL call per driver — ~320 across both fleets — so weekly is also the
   difference between 320 calls and 2,240.

   is_banned and compliance_status ride along because they are the two facts on
   the same call that CAN change overnight, and a history of them is the audit
   trail for "when did this driver stop being able to work". */
CREATE TABLE IF NOT EXISTS driver_rating_history (
  platform          TEXT NOT NULL,
  driver_ext_id     TEXT NOT NULL,
  observed_on       DATE NOT NULL,          -- Dubai day of the reading
  fleet_id          TEXT,
  rating            DOUBLE PRECISION,
  lifetime_trips    INT,
  is_banned         BOOLEAN,
  compliance_status TEXT,
  observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, observed_on)
);

CREATE INDEX IF NOT EXISTS drh_driver_idx ON driver_rating_history (driver_ext_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS drh_day_idx    ON driver_rating_history (observed_on DESC);

COMMENT ON TABLE driver_rating_history IS
  'One row per driver per platform per day the platform was asked. A gap means we did not ask, never that the rating was unchanged — those are different facts and a chart must be able to tell them apart.';
COMMENT ON COLUMN driver_rating_history.lifetime_trips IS
  'Carried beside the rating because it is the denominator: a rating that moved 0.02 over 40 trips is a different event from one that moved 0.02 over 900, and without the count neither can be told from noise.';
