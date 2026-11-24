-- schema_v129 — one driver's movement per Dubai day, kept (2026-11-24).
-- ---------------------------------------------------------------------------
-- The operator: "driver page shows pick up drop off territory. but doesn't
-- show where the driver spent time or roamed around … complete view for the
-- duration selected." The day page (/api/driver/day) already works out, for
-- one person and one day, which car was theirs and when (custody), the
-- tracker's fixes inside those hours from one tracker per car, and what the
-- car was doing between each pair of fixes. It costs 2.4–4.4 s per call on
-- production (measured 2026-11-24, four drivers, 22 Nov), so a thirty-day
-- range cannot be built on request. src/movement_rollup.js runs the same
-- functions (api/driver_day_core.js) for every person who worked a day and
-- keeps the answer here.
--
--   driver_move_day   one row per person-day: online minutes, on-job minutes,
--                     what the tracker saw of them, minutes stopped / moving
--                     empty / moving with the seat unreported / with a
--                     passenger, waiting online, km, and why a day has
--                     nothing (absent — the day page's own sentence).
--   driver_move_cell  the same minutes and km per half-kilometre cell (the
--                     place_cell grid, round(lat/0.005)), so a range view can
--                     say where the time went and name the ground.
--   driver_move_point pickups and drop-offs with a position: Uber's own job
--                     stage times (DJ_PICKUP, DJ_COMPLETED) placed by the
--                     car's tracker, the booking's own coordinates where the
--                     platform gave them, and a completed booking's end time
--                     placed by the tracker. `basis` says which; `gap_s` how
--                     far the fix was from the moment.
--
-- Rebuilt per person-day (delete, insert), so a re-run replaces and never
-- adds. person_id is driver.id, the spine (src/persons.js).
CREATE TABLE IF NOT EXISTS driver_move_day (
  person_id              bigint      NOT NULL,
  day                    date        NOT NULL,
  plates                 text[]      NOT NULL DEFAULT '{}',
  sources                text[]      NOT NULL DEFAULT '{}',
  online_min             int         NOT NULL DEFAULT 0,
  ontrip_min             int         NOT NULL DEFAULT 0,
  seen_min               int         NOT NULL DEFAULT 0,
  unseen_online_min      int         NOT NULL DEFAULT 0,
  stopped_min            int         NOT NULL DEFAULT 0,
  parked_quiet_min       int         NOT NULL DEFAULT 0,
  moving_empty_min       int         NOT NULL DEFAULT 0,
  moving_seat_unknown_min int        NOT NULL DEFAULT 0,
  with_passenger_min     int         NOT NULL DEFAULT 0,
  wait_min               int         NOT NULL DEFAULT 0,
  parked_offline_min     int         NOT NULL DEFAULT 0,
  km                     numeric(8,1) NOT NULL DEFAULT 0,
  km_with_passenger      numeric(8,1) NOT NULL DEFAULT 0,
  fixes                  int         NOT NULL DEFAULT 0,
  pickups                int         NOT NULL DEFAULT 0,
  pickups_placed         int         NOT NULL DEFAULT 0,
  dropoffs               int         NOT NULL DEFAULT 0,
  dropoffs_placed        int         NOT NULL DEFAULT 0,
  absent                 text,
  partial                boolean     NOT NULL DEFAULT false,
  built_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (person_id, day)
);
CREATE INDEX IF NOT EXISTS driver_move_day_day_idx ON driver_move_day (day);

CREATE TABLE IF NOT EXISTS driver_move_cell (
  person_id               bigint NOT NULL,
  day                     date   NOT NULL,
  cell_lat                int    NOT NULL,
  cell_lng                int    NOT NULL,
  stopped_min             real   NOT NULL DEFAULT 0,
  moving_empty_min        real   NOT NULL DEFAULT 0,
  moving_seat_unknown_min real   NOT NULL DEFAULT 0,
  with_passenger_min      real   NOT NULL DEFAULT 0,
  online_min              real   NOT NULL DEFAULT 0,
  ontrip_min              real   NOT NULL DEFAULT 0,
  wait_min                real   NOT NULL DEFAULT 0,
  offline_min             real   NOT NULL DEFAULT 0,
  km                      real   NOT NULL DEFAULT 0,
  km_with_passenger       real   NOT NULL DEFAULT 0,
  fixes                   int    NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, day, cell_lat, cell_lng)
);

CREATE TABLE IF NOT EXISTS driver_move_point (
  person_id   bigint      NOT NULL,
  day         date        NOT NULL,
  platform    text        NOT NULL,
  external_id text        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('pickup', 'dropoff')),
  at          timestamptz,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  basis       text        NOT NULL,
  gap_s       int,
  PRIMARY KEY (person_id, day, platform, external_id, kind)
);
