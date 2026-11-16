-- v126: every pickup and drop-off placed, or absent for a reason that is true
-- (FIX-STATUS PLC; src/place_resolve.js has the ladder, src/trip_places.js the
-- pass that fills these tables). The operator, 2026-11-16, on a driver's
-- Territory tab where "(unparsed)" was the second-largest row: "let's try
-- figuring out how we can get as many data as possible so that unparsed
-- doesn't exist."
--
-- place_area() (v68) is NOT touched: it is IMMUTABLE and sits inside queries
-- this change does not move. The resolved layer is added beside it.
--
--   trip_place    one row per booking (platform <> 'fms'), keyed on the trip's
--                 own key. Per endpoint: the area, the BASIS it came from
--                 (address | address_name | plus_code | coordinates | tracker),
--                 or — when no rung could place it — the REASON, as
--                 '<text failure>+<position failure>' (reasonText() in
--                 src/place_resolve.js turns it into words). named_by says
--                 which gazetteer named a position (booking_cell or
--                 place_cell); detail carries the evidence (the tracker fix's
--                 time, distance in minutes and source; the plus code; the
--                 vote counts). `inputs` is an md5 of every trip column the
--                 answer was built from, so a trip whose address, position,
--                 plate or times change upstream is resolved again.
--                 fleet_id is copied from trip so v124's row-level security
--                 secures this table like every other fleet table.
--   place_vote    one vote per booking: the cell the car's tracker was in at
--                 the drop-off time, and the area the drop-off address reads
--                 as by place_area(). The car is AT the drop-off then, so this
--                 is a position for a Google-vocabulary name — which no
--                 provider gives us directly (Uber: 0 coordinates on 315,505
--                 addresses, COVERAGE "Places").
--   booking_cell  the gazetteer those votes make: per ~0.5 km cell (the same
--                 grid as place_cell, src/places.js CELL), the modal area, its
--                 votes, the votes cast and the distinct names seen. Rebuilt
--                 whole from place_vote, like place_cell and for its reason
--                 (a merge cannot express a name losing a vote).
--
-- Why a second gazetteer: place_cell names cells in FMS's vocabulary, and the
-- bookings speak Google's. Where a booking has both a dash-form address and a
-- tracker fix, the place_cell name equalled the address's area on 29.8% of
-- pickups (160 production driver-days, 9–15 Nov 2026); a booking_cell built
-- from one week of the sample's drop-offs named it on 70.3%.
CREATE TABLE IF NOT EXISTS trip_place (
  platform         TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  fleet_id         TEXT,
  pickup_area      TEXT,
  pickup_basis     TEXT,
  pickup_reason    TEXT,
  pickup_named_by  TEXT,
  pickup_detail    JSONB,
  dropoff_area     TEXT,
  dropoff_basis    TEXT,
  dropoff_reason   TEXT,
  dropoff_named_by TEXT,
  dropoff_detail   JSONB,
  inputs           TEXT NOT NULL,
  resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id),
  FOREIGN KEY (platform, external_id) REFERENCES trip (platform, external_id) ON DELETE CASCADE,
  -- Exactly one of an area and a reason, per endpoint: an answer, or the true
  -- reason there is none. Never both, never neither.
  CONSTRAINT trip_place_pickup_one CHECK ((pickup_area IS NULL) <> (pickup_reason IS NULL)),
  CONSTRAINT trip_place_dropoff_one CHECK ((dropoff_area IS NULL) <> (dropoff_reason IS NULL)),
  CONSTRAINT trip_place_pickup_basis CHECK ((pickup_area IS NULL) = (pickup_basis IS NULL)
    AND (pickup_basis IS NULL OR pickup_basis IN ('address', 'address_name', 'plus_code', 'coordinates', 'tracker'))),
  CONSTRAINT trip_place_dropoff_basis CHECK ((dropoff_area IS NULL) = (dropoff_basis IS NULL)
    AND (dropoff_basis IS NULL OR dropoff_basis IN ('address', 'address_name', 'plus_code', 'coordinates', 'tracker')))
);

-- The rows a later pass may improve: an endpoint with no answer yet, or one a
-- position named through place_cell before booking_cell knew the cell. Small
-- by construction (measured on the sample: ~2% of endpoints end absent), so
-- the retry scan never reads the whole table.
CREATE INDEX IF NOT EXISTS trip_place_retry_idx ON trip_place (resolved_at)
  WHERE pickup_area IS NULL OR dropoff_area IS NULL
     OR pickup_named_by = 'place_cell' OR dropoff_named_by = 'place_cell';

CREATE TABLE IF NOT EXISTS place_vote (
  platform     TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  fleet_id     TEXT,
  cell_lat     INT NOT NULL,
  cell_lng     INT NOT NULL,
  area         TEXT NOT NULL,
  minutes      REAL,
  voted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, external_id),
  FOREIGN KEY (platform, external_id) REFERENCES trip (platform, external_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS booking_cell (
  cell_lat        INT NOT NULL,
  cell_lng        INT NOT NULL,
  area            TEXT NOT NULL,
  n               INT NOT NULL,
  distinct_names  INT NOT NULL,
  observations    INT NOT NULL,
  built_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cell_lat, cell_lng)
);

COMMENT ON TABLE trip_place IS
  'Where each booking''s pickup and drop-off were, resolved up a ladder (src/place_resolve.js): the dash-form address (place_area), a known area name in the address text, a plus code, the booking''s own coordinates, or the car''s tracker fix nearest the request / drop-off time (5 min). Each answer carries its basis; an endpoint no rung could place carries the reason instead. Filled by src/trip_places.js.';
COMMENT ON TABLE place_vote IS
  'One vote per booking for booking_cell: the cell the car''s tracker was in within 5 minutes of the drop-off time, and the area the drop-off address reads as by place_area().';
COMMENT ON TABLE booking_cell IS
  'The gazetteer in the bookings'' own (Google) vocabulary: per ~0.5 km cell, the modal drop-off area among place_vote. Named before place_cell (FMS vocabulary) when a position has to be named. Rebuilt whole by src/trip_places.js.';
