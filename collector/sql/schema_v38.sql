/* One row per driver per Dubai day — the derived record, kept.
   ─────────────────────────────────────────────────────────────────────────
   Everything the collector fetches is already stored, so nothing raw is lost.
   What was not kept is the DERIVED per-day picture: how long somebody was on a
   job, how long they waited, and — since this morning — how much of that
   waiting they were online for. Those were computed from raw on every page
   load, by window functions over three tables.

   Three reasons that is not good enough:

     · The providers forget. Uber serves 31 days of availability and about 192
       of earnings. The raw events we captured inside those windows are safe,
       but a per-day record is what makes a two-year history answerable without
       every reader re-deriving it from events that were only ever collectable
       for a month.
     · A derivation that lives only in a query changes when the query changes.
       A day's figures should be what they were when the day happened.
     · /api/driver/shift ran a lead() over driver_timeline_event and a fold
       over every trip, per driver, per request.

   Written by src/rollup.js after every collection, and idempotent: the same
   day recomputed lands on the same row. */
CREATE TABLE IF NOT EXISTS driver_day (
  driver_ext_id     text        NOT NULL,
  day               date        NOT NULL,          -- Dubai calendar day
  fleet_id          text,
  platforms         text[],
  plates            text[],

  trips             int         NOT NULL DEFAULT 0,
  completed         int         NOT NULL DEFAULT 0,
  cancelled         int         NOT NULL DEFAULT 0,
  km                numeric,
  fares             numeric,                        -- only where the channel reports one

  /* Minutes from Dubai midnight, so they join to everything else keyed the
     same way and need no timezone maths at read time. */
  first_min         int,
  last_min          int,
  span_min          int,
  on_job_min        int,
  wait_min          int,
  longest_wait_min  int,
  unknown_end       int         NOT NULL DEFAULT 0, -- jobs with no dropoff time

  /* From driver_timeline_event. NULL means availability was never collected
     for this day — which is not the same as a driver who was offline, and the
     column has to be able to say so. */
  online_min        int,
  idle_online_min   int,

  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (driver_ext_id, day)
);

CREATE INDEX IF NOT EXISTS driver_day_day_idx   ON driver_day (day);
CREATE INDEX IF NOT EXISTS driver_day_fleet_idx ON driver_day (fleet_id, day);
