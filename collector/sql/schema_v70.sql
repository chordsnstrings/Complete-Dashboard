/* THE DRIVER'S OWN STATUS, WHICH WAS ARRIVING EVERY TWO MINUTES AND BEING
   THROWN AWAY.
   ─────────────────────────────────────────────────────────────────────────
   The operator asked why a driver Uber shows as online for 5.16 hours does not
   read as online on this product. The answer was that our online times come
   from supplier.uber.com/chronicle, one request per driver, on a three-hourly
   cron — so the page is up to three hours behind a screen that is live.

   That was the wrong thing to fix. `pullLiveOrg` in src/sources/uber.js has
   been calling /v1/vehicle-suppliers/drivers/actions every LIVE_STATUS_SECONDS
   — 120 by default — since the live map was built. That response carries, per
   driver:

     statusEntries   [{status: DRIVER_STATUS_ONLINE|OFFLINE|ONTRIP,
                       timestamp: 2026-09-04T17:07:17.859Z}]
     driverInfo      {email, phone, driverUuid, firstName, lastName}
     onboardingStatus

   Every one of those was being discarded. The rows it wrote were
   telemetry_snapshot keyed on PLATE, and filtered `plate !== 'UNKNOWN'` — so
   the driver's own status survived only for the drivers who happened to have a
   vehicle attached, attached to the car rather than to the person. Measured on
   production 2026-09-14 through /api/live: 11 rows carried an Uber status
   (ONLINE 5, ONTRIP 4, OFFLINE 2) out of a roster of 152.

   So the feed was never the problem and neither was the cadence. The status
   was already here, twice a minute, with the provider's own timestamp on it —
   which is better than the chronicle timeline in every dimension that matters:
   it is live rather than three-hourly, it covers every driver rather than
   every driver with a car, and it carries the instant the status CHANGED
   rather than the instant we asked.

   Two tables, because "what is true now" and "what happened" are different
   questions and one table answers them both badly:

     driver_status_now     one row per platform account, overwritten
     driver_status_event   append-only, keyed on the provider's own timestamp

   The second is what lets this product say when somebody came online without
   asking anybody: the first ONLINE event of a Dubai day IS the answer the
   Online time page has been approximating from a three-hourly pull. */

CREATE TABLE IF NOT EXISTS driver_status_now (
  platform       TEXT NOT NULL,
  driver_ext_id  TEXT NOT NULL,
  fleet_id       TEXT,
  /* Normalised, because the page says "online" and the provider says
     DRIVER_STATUS_ONLINE, and a page that prints the provider's constant is a
     page that has not decided what it means. The raw word is kept beside it
     for the case the normaliser meets something new. */
  status         TEXT,                 -- online | ontrip | offline
  status_raw     TEXT,
  /* WHEN THE PROVIDER SAYS IT CHANGED, not when we asked. The difference is
     the whole value of this column: polling at 120s would otherwise quantise
     every answer to two minutes, and this is exact. */
  status_at      TIMESTAMPTZ,
  onboarding     TEXT,
  plate          TEXT,
  /* …and when we asked, kept apart from it, because a status_at of 06:14 read
     from a feed that last answered yesterday is not a claim about this morning
     and a page has to be able to tell. */
  observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id)
);

CREATE INDEX IF NOT EXISTS dsn_fleet_status_idx ON driver_status_now (fleet_id, status);
CREATE INDEX IF NOT EXISTS dsn_working_idx ON driver_status_now (status)
  WHERE status IN ('online', 'ontrip');

CREATE TABLE IF NOT EXISTS driver_status_event (
  platform       TEXT NOT NULL,
  driver_ext_id  TEXT NOT NULL,
  at             TIMESTAMPTZ NOT NULL,
  status         TEXT NOT NULL,
  status_raw     TEXT,
  fleet_id       TEXT,
  /* The Dubai calendar day, generated rather than derived at every call site —
     the same rule sql/schema_v18.sql applies to trip_norm.local_day, and for
     the same reason: this fleet's day starts at Dubai midnight and every page
     that has ever bound on a UTC day has been four hours wrong. */
  local_day      DATE GENERATED ALWAYS AS (((at AT TIME ZONE 'Asia/Dubai')::date)) STORED,
  PRIMARY KEY (platform, driver_ext_id, at)
);

/* The two questions asked of this table. "Who came online on this day", which
   the Online time page asks once per render over every driver; and "what did
   this person do", which a driver page asks for one person over a window. */
CREATE INDEX IF NOT EXISTS dse_day_idx ON driver_status_event (local_day, status);
CREATE INDEX IF NOT EXISTS dse_driver_idx ON driver_status_event (driver_ext_id, at DESC);

COMMENT ON TABLE driver_status_now IS
  'The live standing of one platform account: online, on a trip, or offline, with the instant the provider says it changed. Written by the live tick in src/sources/uber.js every LIVE_STATUS_SECONDS.';
COMMENT ON TABLE driver_status_event IS
  'Every driver status change the provider has reported, keyed on ITS timestamp rather than on when we asked. The first online event of a Dubai day is when that driver came online.';
COMMENT ON COLUMN driver_status_now.observed_at IS
  'When this fleet last heard from the feed. A status_at without it cannot be read: an online from this morning means nothing if the feed stopped answering at noon.';
