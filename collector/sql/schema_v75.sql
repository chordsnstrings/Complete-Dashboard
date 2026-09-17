/* WHAT WE ASKED UBER, AND WHAT CAME BACK — SO A DEAD DAY IS ASKED ONCE.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT THIS EXISTS FOR, AND IT ONLY APPEARS AT SCALE.
   missingDays() returns the days with no row in platform_account_day. That is
   the right question while every day asked produces a statement, and it is the
   wrong question the moment one does not: a day Uber has nothing for stores
   nothing, so it comes back in the next run's list, and the next, for ever.

   Today that is invisible — the walk has only ever worked inside the month
   Uber does hold. It becomes fatal the moment the window widens to backfill
   the record, which is what this batch does: uber/ecosine has 390 unasked days
   and uber/egari 378, and any of them that predate the org, or fall in a gap,
   would be re-asked every run until somebody noticed a walk that never
   finished. One Uber report costs ten to forty seconds against a limiter that
   shuts after three, so a handful of dead days is enough to consume a night's
   budget and leave the live days uncollected.

   THE THREE ANSWERS ARE NOT ONE ANSWER, which is the second reason this table
   is not simply a "done" flag:

     stored      the report came back with a statement and it is in
                 platform_account_day. Never ask again.
     empty       the report generated and carried no rows. Uber has nothing for
                 this day — the org did not exist yet, or the day is a gap in
                 the provider's own record. Never ask again, and DO NOT render
                 it as a day with no transfer: it is a day with no statement,
                 which is a different sentence.
     refused     the limiter shut, the report timed out, or the shape was not
                 the one this module reads. Nothing was learned. ASK AGAIN.

   Only 'refused' is retried, and the page can finally tell an operator which
   of the three a day is instead of the honest but blunt "either nobody asked,
   or the ask was refused" it has to say today.

   KEYED ON THE DAY AND NOT APPEND-ONLY. A day asked again overwrites its own
   row: the useful fact is the LAST thing the provider said about it, and a
   history of attempts is a different table nobody has asked for. asked_at is
   part of the value rather than the key for the same reason.

   detail CARRIES THE PROVIDER'S OWN WORDS where there are any — a refusal that
   says "Payment report generation limit reached" and a refusal that says the
   session expired need different actions from a human, and collapsing both to
   'refused' would throw away the only thing that distinguishes them. */
CREATE TABLE IF NOT EXISTS payout_ask (
  platform   TEXT NOT NULL,
  fleet_id   TEXT NOT NULL,
  day        DATE NOT NULL,
  outcome    TEXT NOT NULL,            -- stored | empty | refused
  detail     TEXT,
  /* Whether a person asked or the nightly walk did. The same distinction
     sql/schema_v74.sql draws with checked_at, carried here so a refusal can be
     read as "the walk hit the limiter at 3am" or "somebody pressed the button
     and it was refused", which are different stories. */
  live       BOOLEAN NOT NULL DEFAULT false,
  asked_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, fleet_id, day)
);

/* The walk's own question: "which days of this fleet have I already settled?"
   Partial on the two settled outcomes, because the rows it must NOT skip are
   exactly the ones left out of this index. */
CREATE INDEX IF NOT EXISTS payout_ask_settled_idx
  ON payout_ask (platform, fleet_id, day)
  WHERE outcome IN ('stored', 'empty');
