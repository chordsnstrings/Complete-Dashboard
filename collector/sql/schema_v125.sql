-- v125: flights landing at Dubai's two airports, from the OpenSky Network
-- (src/sources/flights.js; the operator, 2026-11-16: "add flight details and
-- flights actually landing, and how that impacts the airport trips. use api -
-- any free api").
--
-- Four tables, none of them fleet data (no fleet_id, so v124's row-level
-- security has nothing to secure here and every reader sees the same sky):
--
--   flight_landing       one row per landing OpenSky's nightly batch confirmed:
--                        GET /api/flights/arrival for one UTC day. landed_at is
--                        OpenSky's lastSeen, the landing to within minutes. The
--                        provider's own row is kept whole in raw. Keyed on
--                        (airport, icao24, landed_at), so collecting a day twice
--                        rewrites the same rows rather than adding any.
--   flight_day_coverage  per airport and UTC day, what happened when we asked:
--                        collected, not_published (OpenSky answers 404 until its
--                        nightly batch has run — measured 2026-11-16, today's
--                        day 404'd while yesterday's held 438 at OMDB), failed
--                        (with the reason), or none_returned (an old day it
--                        answered 404 for). A day with no row was never asked.
--                        The API prints a day absent with this reason, never 0.
--   flight_live_landing  landings INFERRED from live state vectors (/api/states
--                        /all every 2 minutes) by the final-approach rule: an
--                        ESTIMATE, labelled so wherever it is shown, and
--                        superseded (superseded_at, confirmed_id) once the
--                        nightly list for that UTC day arrives.
--   flight_live_hour     how many live polls ran and answered in each clock
--                        hour, so an hour the watch did not run reads "not
--                        watched" rather than "nothing landed".
CREATE TABLE IF NOT EXISTS flight_landing (
  id                  bigserial PRIMARY KEY,
  airport             text NOT NULL,
  icao24              text NOT NULL,
  callsign            text,
  landed_at           timestamptz NOT NULL,
  first_seen          timestamptz,
  origin              text,
  arrival_horiz_m     integer,
  arrival_vert_m      integer,
  utc_day             date NOT NULL,
  raw                 jsonb NOT NULL,
  collected_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (airport, icao24, landed_at)
);
CREATE INDEX IF NOT EXISTS flight_landing_airport_time_idx ON flight_landing (airport, landed_at);

CREATE TABLE IF NOT EXISTS flight_day_coverage (
  airport             text NOT NULL,
  utc_day             date NOT NULL,
  status              text NOT NULL
                        CHECK (status IN ('collected', 'not_published', 'failed', 'none_returned')),
  landings            integer,
  reason              text,
  attempts            integer NOT NULL DEFAULT 0,
  credits_remaining   integer,
  first_tried_at      timestamptz NOT NULL DEFAULT now(),
  last_tried_at       timestamptz NOT NULL DEFAULT now(),
  collected_at        timestamptz,
  PRIMARY KEY (airport, utc_day)
);

CREATE TABLE IF NOT EXISTS flight_live_landing (
  id                  bigserial PRIMARY KEY,
  airport             text NOT NULL,
  icao24              text NOT NULL,
  callsign            text,
  landed_at           timestamptz NOT NULL,
  seen_at             timestamptz NOT NULL,
  runway              text,
  dist_nm             numeric,
  alt_m               numeric,
  track_deg           numeric,
  vrate_ms            numeric,
  speed_ms            numeric,
  confirmed_id        bigint,
  superseded_at       timestamptz,
  raw                 jsonb,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flight_live_airport_time_idx ON flight_live_landing (airport, landed_at);

CREATE TABLE IF NOT EXISTS flight_live_hour (
  hour_start          timestamptz PRIMARY KEY,
  polls               integer NOT NULL DEFAULT 0,
  polls_ok            integer NOT NULL DEFAULT 0,
  aircraft_seen       integer NOT NULL DEFAULT 0,
  last_error          text,
  last_poll_at        timestamptz
);
