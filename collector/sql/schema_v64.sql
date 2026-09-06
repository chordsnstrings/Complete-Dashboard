/* Why a photograph is not on the page.
   ─────────────────────────────────────────────────────────────────────────
   driver_photo answers one question — do we hold this person's bytes — and
   every reader of it collapses two very different situations into one answer.
   A driver Uber has no picture for, and a driver whose picture Uber holds and
   this product could not fetch, both come back as picture_url null and both
   render as a plain initials tile. They are not the same thing. The first is
   the whole truth about that person's record; the second is a failure of ours,
   and saying nothing about it is the exact confusion this dashboard exists to
   remove — a figure that cannot be shown must be absent WITH A REASON, never
   silently and never with a false one.

   src/sources/uber_profile.js already counts four distinct ways a download
   fails: the CDN refuses (the signature has expired), the type is not one we
   will serve, the body is empty or absurd, or the request throws. All four
   incremented `failed`, put the count in a log line and wrote nothing, so the
   knowledge died in the worker's stdout.

   So the failure is recorded where the boundary can read it. Not as a row in
   driver_photo — a row there means "the bytes are here", and a row that means
   the opposite would have every reader of that table check a second column
   before trusting the first. Its own small table, keyed the same way, holding
   what was tried, when, and why it did not work.

   The reason is free text on purpose. It is shown to an operator, not switched
   on, and the useful thing to tell somebody is "403 from the CDN — the signed
   url had expired by the time we asked", which no enum will ever hold. */
CREATE TABLE IF NOT EXISTS driver_photo_miss (
  platform      TEXT NOT NULL,
  driver_ext_id TEXT NOT NULL,
  reason        TEXT NOT NULL,
  source_host   TEXT,
  tried_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id)
);

/* Read by driver_ext_id alone, the same way driver_photo is: a person is
   addressed by an account id and the channel is what comes back, not what is
   asked for. */
CREATE INDEX IF NOT EXISTS driver_photo_miss_ext_idx
  ON driver_photo_miss (driver_ext_id);
