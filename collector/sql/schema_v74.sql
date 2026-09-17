/* WHEN A HUMAN LAST ASKED UBER ABOUT THIS DAY — WHICH collected_at DOES NOT
   AND CANNOT ANSWER.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT, AND WHY A SECOND TIMESTAMP IS NOT A DUPLICATE OF THE FIRST.
   platform_account_day (sql/schema_v71.sql) carries collected_at, declared
   NOT NULL DEFAULT now(). Every row in it was written by the nightly walk in
   src/sources/uber_payout.js, and that walk asks a day ONCE: missingDays()
   returns only the days with no statement row, so a day already stored is
   never asked again. collected_at therefore answers exactly one question —
   "when did the backfill first reach this day" — and it is frozen at that
   instant for ever, because nothing ever writes the row a second time.

   That is the right column for the question it answers and it is the wrong
   column for the question the Payouts page now has to answer. An operator
   looking at a wire of AED 111,179.66 beside our own 110,962.09 is about to
   act on the difference, and the thing they need to know is not when a cron
   first filled the row in. It is whether anybody has put that figure to Uber
   since — and if so, when, because Uber restates. Two different facts about
   one row, so two columns.

   MEASURED, 2026-09-17, on production. The table holds 4 statement days for
   uber/ecosine (2026-08-17 .. 08-20) and 19 for uber/egari (08-17 .. 09-09):
   23 rows, every one of them written by the nightly walk, and not one of them
   ever verified against Uber by a person. Under the old schema those 23 rows
   and a row somebody checked five minutes ago are indistinguishable — both
   carry one timestamp and it means "collected". checked_at is how they stop
   looking the same.

   NULLABLE, AND NULL MEANS NOBODY HAS ASKED. It does not mean "checked at the
   epoch" and it does not mean "checked and found to agree". This is the house
   rule the whole product turns on, applied to a timestamp: a figure that has
   not been measured renders ABSENT WITH A REASON, so the page reading this
   column must print "nobody has asked Uber about this day" and never a date.
   That is also why there is no DEFAULT here: a default would quietly assert
   that the nightly walk is a human check, which is the precise claim this
   column exists to be able to deny.

   WHO WRITES IT. Only the live path — POST /api/finance/payouts/verify, which
   calls src/sources/uber_payout.js oneDay() with the live flag set. The
   nightly walk calls the same oneDay() WITHOUT that flag and so omits the
   column from its upsert entirely, which leaves whatever was there: a day a
   human checked in September does not have its check erased in October
   because a backfill happened to re-store it.

   ADD COLUMN IF NOT EXISTS, because the migrations replay from the start on
   every boot and this file must be a no-op on the second pass. No index: the
   only reads of this column are per-row, beside a row already selected by
   (platform, fleet_id, day), which is the primary key. */
ALTER TABLE platform_account_day
  ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;

COMMENT ON COLUMN platform_account_day.checked_at IS
  'The last time a human asked the provider LIVE for this day, via POST /api/finance/payouts/verify. NULL means nobody has asked — it does not mean the day is unverifiable and it does not mean it agreed. Distinct from collected_at, which is when the nightly backfill first stored the row and is never rewritten.';
