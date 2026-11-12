-- v116: Bolt's fleet-integration orders (getFleetOrders), kept as Bolt wrote
-- them, beside what the collector did with each one.
-- ---------------------------------------------------------------------------
-- WHY A SECOND BOLT TRIP SOURCE AT ALL. Bolt's trips have come from one
-- surface, the fleet-owner portal's orderHistory, and the portal is signed
-- into with a refresh token that lives exactly seven days and that a newer
-- portal sign-in kills early (docs/COVERAGE.md, "BOLT IS TWO CREDENTIALS").
-- Every lapse is a hole in the trip table until somebody pastes a new token;
-- both live tokens expire 2026-11-14 15:06Z. The fleet-integration client
-- (BOLT_CLIENT_ID / BOLT_CLIENT_SECRET) has no expiry, and its getFleetOrders
-- answered the nightly probe with 24 Egari orders on 2026-11-11 22:20Z
-- (/api/probe/results) while no collector read them.
--
-- WHY A TABLE OF ITS OWN AND NOT ONLY trip ROWS. The two feeds describe the
-- same rides and must never both be counted. A trip row is ONE order whoever
-- wrote it, so most fleet-integration orders land on a row the portal already
-- wrote (they fill what the portal leaves empty: coordinates, the ride's
-- duration, whether it was scheduled) and only the orders the portal has not
-- answered for become rows of their own. What decided each order, and where
-- it went, has to be on the record somewhere a reader can count — "Bolt
-- trips came from the second source on these days" is a claim that needs
-- rows behind it — and the order itself has to survive when the portal later
-- answers for its day and the stand-in trip row is removed. This is that
-- record. src/sources/bolt_orders.js is its only writer.
--
-- disposition, per order, as of the last pass that saw it:
--   enriched    matched one portal trip row (same fleet, same creation second,
--               same car or same driver) and filled what that row lacked;
--               trip_external_id is the portal row's key.
--   inserted    the portal had not answered for the moment the order was
--               created, so the order is a trip row of its own;
--               trip_external_id is that row's key.
--   held        the portal HAD answered for that moment and returned no row
--               this order matches. Not counted as a trip: the portal's
--               answer for a day it served is the record, and an order that
--               cannot be matched is exactly the one that could be a
--               duplicate. Kept here so the disagreement is countable.
--   ambiguous   more than one portal row fits, or another order claims the
--               same row — nothing is written on a guess.
--   superseded  had a row of its own until the portal answered for its day;
--               the stand-in was removed. The next pass re-decides it.
--
-- Personal data: driver_phone is dropped before the order is stored (nothing
-- reads it, and the portal row already carries the driver's contact). The
-- name and the addresses are what trip rows already hold.
CREATE TABLE IF NOT EXISTS bolt_fi_order (
  fleet_id          TEXT NOT NULL REFERENCES fleet(id),
  order_reference   TEXT NOT NULL,           -- Bolt's own order id; unique per order
  created_at        TIMESTAMPTZ NOT NULL,    -- order_created_timestamp (unix s)
  status            TEXT,                    -- order_status, Bolt's own vocabulary
  driver_uuid       TEXT,                    -- the fleet-integration driver id (the roster's)
  partner_uuid      TEXT,
  plate             TEXT,                    -- normalised like every other plate
  /* Per-ride money as Bolt states it on this feed. As reported: Bolt writes
     null here for a ride that carried none (50% fill on the probe's 24 rows,
     all on finished rides), so a 0 is a stated zero, not an absence. The
     portal has never published commission or net earnings per ride. */
  ride_price        NUMERIC(12,2),
  commission        NUMERIC(12,2),
  net_earnings      NUMERIC(12,2),
  disposition       TEXT NOT NULL
    CHECK (disposition IN ('enriched', 'inserted', 'held', 'ambiguous', 'superseded')),
  trip_external_id  TEXT,                    -- trip(platform='bolt', external_id) it is on, if any
  /* The portal's numeric driver id for this order's driver, learned when the
     order matched a portal row. It is what lets an order the portal has not
     answered for be keyed and attributed exactly as the portal will key it,
     so the portal's own row lands on the same trip row when it comes. */
  portal_driver_id  TEXT,
  raw               JSONB NOT NULL,
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fleet_id, order_reference)
);
CREATE INDEX IF NOT EXISTS bolt_fi_order_created ON bolt_fi_order (fleet_id, created_at);
CREATE INDEX IF NOT EXISTS bolt_fi_order_trip ON bolt_fi_order (fleet_id, trip_external_id)
  WHERE trip_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS bolt_fi_order_driver ON bolt_fi_order (fleet_id, driver_uuid)
  WHERE portal_driver_id IS NOT NULL;
COMMENT ON TABLE bolt_fi_order IS
  'Bolt fleet-integration getFleetOrders, one row per order, with what the collector did with it '
  '(enriched a portal trip row / inserted a trip row of its own / held / ambiguous / superseded). '
  'Written only by src/sources/bolt_orders.js; see sql/schema_v116.sql.';
