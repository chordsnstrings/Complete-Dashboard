/* Was the driver ONLINE and waiting, or just offline?
   ─────────────────────────────────────────────────────────────────────────
   "How the day was spent" on a driver page reports, over 28 days, 97.7 h on
   job against 426.9 h "waiting between jobs" — 81% of the working span. That
   band is the biggest thing on the page and it says nothing, because it
   cannot distinguish a driver sitting at a rank with the app on from one who
   logged out and went home. The first is supply the fleet is paying for and
   not selling; the second is time off. Same colour, opposite meaning.

   supplier.uber.com/chronicle/graphql GetTimelineInfo answers it: ONLINE and
   OFFLINE transitions per driver, plus — unasked for — the sub-states of each
   job. DJ_ASSIGNED, DJ_PICKUP_ARRIVED, DJ_PICKUP, DJ_COMPLETED, each with its
   own timestamp. That is the boundary the same panel's footnote says it does
   not have: "the ride cannot be separated from the approach on any booking
   channel". It can now, on Uber.

   EVENTS, not spans. The API emits transitions and a span is a pair of them,
   so storing spans would mean deciding at write time what a dangling ONLINE
   at the end of a window means — and re-deciding it on the next run when the
   matching OFFLINE arrives. Spans are derived where they are read.

   One table with a discriminator rather than two, because it is one event
   stream from one call and splitting it would mean two upserts that must
   agree about a driver's window. */
CREATE TABLE IF NOT EXISTS driver_timeline_event (
  platform        text        NOT NULL,
  fleet_id        text        NOT NULL,
  driver_ext_id   text        NOT NULL,
  at              timestamptz NOT NULL,
  kind            text        NOT NULL,          -- 'status' | 'job'
  /* '' rather than NULL, and that is not laziness.
     ─────────────────────────────────────────────────────────────────────
     A driver can have two rows at one instant — a status flip and a job
     state change — so both discriminators belong in the key. But a NULL
     does not collide with itself in a unique index, so a nullable column in
     the key means every re-run inserts the row again; and Postgres will not
     take `coalesce(...)` in a PRIMARY KEY at all ("syntax error at or
     near ("). An expression UNIQUE INDEX would work but then ON CONFLICT has
     to restate the expression, which every caller would have to get right.
     Empty string is the absent value, declared once, and the key is plain. */
  status          text        NOT NULL DEFAULT '',   -- ONLINE | OFFLINE  (kind='status')
  state           text        NOT NULL DEFAULT '',   -- DJ_ASSIGNED | DJ_PICKUP | … (kind='job')
  offline_reason  text,
  job_ext_id      text,                              -- the trip uuid
  lat             double precision,
  lon             double precision,
  raw             jsonb,
  collected_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id, at, kind, status, state)
);

/* The read pattern is one driver over a window, and the panel draws a Dubai
   day, so the day key is indexed the same way every other calendar key here
   is (sql/schema_v7.sql). */
CREATE INDEX IF NOT EXISTS dte_driver_at_idx
  ON driver_timeline_event (driver_ext_id, at);
CREATE INDEX IF NOT EXISTS dte_fleet_day_idx
  ON driver_timeline_event (fleet_id, ((at AT TIME ZONE 'Asia/Dubai')::date));
CREATE INDEX IF NOT EXISTS dte_job_idx
  ON driver_timeline_event (job_ext_id) WHERE job_ext_id IS NOT NULL;
