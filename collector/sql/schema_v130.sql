-- schema_v130 — a driver's movement, granular (2026-11-24).
-- ---------------------------------------------------------------------------
-- The operator: "in territory let's focus on granular view. we need to see
-- territory where they move around, where they park everything." The
-- movement rollup (sql/schema_v129.sql) keeps a day summed into half-km
-- cells; these two tables keep what the cells summed away, from the same
-- pass (src/movement_rollup.js) over the same reading (api/day_movement.js):
--
--   driver_move_segment  the day as a log — every stop, drive and silence in
--                        order, with where (a stop's spot; a drive's two
--                        ends), how long, the km, the seat, and for a stop
--                        what the driver was doing while the car stood
--                        (waiting online / on a job / no working status).
--   driver_move_window   which car was the driver's and when (the day page's
--                        custody), with the one tracker kept for it. The
--                        route reads the tracker's own fixes for these hours
--                        to draw the path, so positions are never stored
--                        twice.
--
-- Rebuilt per person-day with the rest of the rollup (replaced in one
-- transaction).
CREATE TABLE IF NOT EXISTS driver_move_segment (
  person_id         bigint  NOT NULL,
  day               date    NOT NULL,
  seq               int     NOT NULL,
  kind              text    NOT NULL CHECK (kind IN ('stop', 'drive', 'silence')),
  s_min             int     NOT NULL,
  e_min             int     NOT NULL,
  minutes           int     NOT NULL,
  plate             text,
  source            text,
  lat               double precision,
  lng               double precision,
  area              text,
  to_lat            double precision,
  to_lng            double precision,
  to_area           text,
  km                real,
  km_with_passenger real,
  passenger         text,
  passenger_min     int,
  wait_min          int,
  ontrip_min        int,
  offline_min       int,
  inferred          boolean NOT NULL DEFAULT false,
  PRIMARY KEY (person_id, day, seq)
);

-- A day built before this file has its cells and day row but no log and no
-- car-hours, and the backfill's cursor only walks backward — so a day it had
-- already passed would never be rebuilt (review, 2026-11-24). The cursor is
-- cleared once, here: the next small-hours pass walks back from yesterday
-- again and rebuilds every day with both. Today is rebuilt every hour anyway.
-- The migration ledger runs this file once, so the reset happens once.
DELETE FROM source_state WHERE source = 'movement_rollup' AND fleet_id = '-' AND key = 'backfilled_to';

CREATE TABLE IF NOT EXISTS driver_move_window (
  person_id bigint NOT NULL,
  day       date   NOT NULL,
  plate     text   NOT NULL,
  source    text,
  from_min  int    NOT NULL,
  to_min    int    NOT NULL,
  PRIMARY KEY (person_id, day, plate, from_min)
);
