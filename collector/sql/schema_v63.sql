-- Driver photographs, stored as bytes rather than as a borrowed key.
-- ---------------------------------------------------------------------------
-- driver_compliance.picture_url (sql/schema_v57.sql) holds what Uber's GraphQL
-- returns for pictureUrl, verbatim. That is not a picture and not even a
-- durable address: it is a pre-signed CloudFront URL carrying Expires,
-- Key-Pair-Id and Signature, and it authorises for exactly twelve hours.
-- Measured on production 2026-09-06: two profile runs finished at
-- 02:01:58.698Z and 02:03:05.617Z on 4 September, and the 156 URLs they wrote
-- expired between 13:59:00Z and 14:03:04Z — 11.999528 h and 11.999551 h after
-- their own runs, two independent batches agreeing to a tenth of a second.
-- Every one of them now answers 403 AccessDenied.
--
-- The collector that would refresh them is scheduled weekly (src/index.js), so
-- even in the best case the steady state is twelve hours of working photographs
-- against a hundred and fifty-six of dead ones — 7.1% of each week. The real
-- case is worse: that cron has never once fired, because the module landed on a
-- Monday twelve and a half hours after its own 00:20 slot, and both runs that
-- have ever happened were queued by hand minutes after a deploy.
--
-- So the bytes are kept. The collector holds a URL that WORKS at the moment it
-- writes the row, which is the only moment anybody ever will, and it fetches
-- the image then.
--
-- A SEPARATE TABLE, not a column on driver_compliance, for a measured reason:
-- api/driver_routes.js and api/server.js both name picture_url explicitly in
-- their SELECT lists, so a bytea sitting beside it would ride along on every
-- contact read and into the WAL behind them. Nothing selects this table except
-- the one route that serves an image.
--
-- Sizing, so nobody has to guess later: 153 real photographs today at Uber's
-- canonical 300x300 is about 3 MB, and the whole 434-row directory would be
-- about 8.5 MB — 0.022% of this instance's volume. Storage is not the cost.
CREATE TABLE IF NOT EXISTS driver_photo (
  platform       TEXT NOT NULL,
  driver_ext_id  TEXT NOT NULL,
  bytes          BYTEA NOT NULL,
  content_type   TEXT NOT NULL,
  byte_len       INTEGER NOT NULL,
  -- The digest is how a re-run avoids rewriting an unchanged photograph. A
  -- weekly pass over 157 drivers that rewrote every row would put 3 MB through
  -- the WAL to store nothing new.
  sha256         TEXT NOT NULL,
  -- Where it came from, for provenance only. Dead within twelve hours of being
  -- written, and deliberately kept so a reader can tell which run fetched this
  -- copy. Never served to anybody.
  source_url     TEXT,
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, driver_ext_id)
);

-- The one lookup the serving route makes, and the one the directory makes to
-- find out WHICH drivers have a photograph without reading any bytes.
CREATE INDEX IF NOT EXISTS driver_photo_ext_idx ON driver_photo (driver_ext_id);
