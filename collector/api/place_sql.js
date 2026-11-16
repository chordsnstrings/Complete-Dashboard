/* Where a coordinate is, in words the operator uses.
   ──────────────────────────────────────────────────────────────────────────
   Every claim this product makes about an occupancy segment was made without
   saying where it happened. The unauthorised list printed a plate, a clock
   time, a distance and a verdict — "L46706, 23:53, 62 km, unauthorized" — and
   an operator reading that cannot tell a car repositioning to the airport from
   a car taken home to Sharjah. The table below the accusation held
   `start_lat 25.24687004, start_lng 55.3535881` and rendered neither.

   The names come from the fleet's own history rather than a geocoder, and
   src/places.js says why: no provider gives us both a fix and a name — Uber
   has 315,505 addresses and no coordinates, FMS has 222,543 coordinates each
   with an address beside it — so `place_cell` (sql/schema_v67.sql) folds the
   second set into ~0.5 km cells holding the modal area name.

   TWO RULES, both inherited from that module and both load-bearing.

   The cell size is imported, never retyped. `api/driver_routes.js:2299` writes
   `round(s.lat / 0.005)` as a literal, and a second literal is a second place
   to get it wrong: change CELL in src/places.js and that query silently starts
   reading a gazetteer built on a different grid, returning names for the wrong
   ground rather than no names at all.

   The vote counts travel with the name. A cell one trip named is not the same
   claim as a cell four hundred trips agree on, and a page that cannot tell
   them apart will print a single stray FMS reverse-geocode as though it were
   the neighbourhood. A cell nothing has ever named returns NULL, and the
   caller renders that absent with a reason rather than reaching for the
   nearest thing it has. */
import { CELL } from '../src/places.js';
import { canonAreaSql } from '../src/area_alias.js';

/* A correlated scalar subquery rather than a join, for the reason
   custody_sql.js gives about its own: dropped into an existing SELECT it
   cannot multiply the row count of the query that carries it, and
   place_cell's primary key is exactly the pair it looks up.

   One jsonb object rather than three columns, because the name and the
   evidence for the name have to arrive together or a caller will use the first
   without the second. */
export const placeAt = (latCol, lngCol) => `(
  SELECT jsonb_build_object('area', pc.area, 'votes', pc.n, 'seen', pc.observations)
    FROM place_cell pc
   WHERE pc.cell_lat = round(${latCol} / ${CELL})::int
     AND pc.cell_lng = round(${lngCol} / ${CELL})::int)`;

/* Where a TRACKER FIX is, in the bookings' own words first (2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   placeAt above reads place_cell, the modal name FMS's own reverse geocoder
   gave a cell. PLC measured that vocabulary against the bookings: it agrees
   with the area a booking's address names on only 29.8% of pickups, because
   it names the ROAD or the BUILDING ("397 D90", "S-02, Mayfair Residence
   Tower Opp. Empower", "4 Airport Rd") — exactly what the car's "Where it
   was" stays and overnight table printed on production. booking_cell
   (sql/schema_v126.sql, src/trip_places.js) is the modal area the drop-off
   ADDRESSES give a cell where the car's tracker stood at a drop-off — 70.3%
   agreement — and 2,422 cells on production after the first passes.

   So a fix is named by booking_cell where that cell has one, and by
   place_cell otherwise; `by` says which ('bookings' | 'tracker'), the votes
   travel with the name as before, and the name is folded to one per area
   (src/area_alias.js). A cell neither has named stays NULL and is printed
   absent with its reason, never the nearest name. Only the stays and the
   overnight table read this; placeAt and every page on it are unchanged. */
export const placeAtArea = (latCol, lngCol) => `(
  SELECT CASE WHEN x.area IS NULL THEN NULL
              ELSE jsonb_build_object('area', ${canonAreaSql('x.area')}, 'votes', x.n, 'seen', x.observations, 'by', x.by) END
    FROM (SELECT coalesce(bc.area, pc.area) AS area,
                 CASE WHEN bc.area IS NOT NULL THEN bc.n ELSE pc.n END AS n,
                 CASE WHEN bc.area IS NOT NULL THEN bc.observations ELSE pc.observations END AS observations,
                 CASE WHEN bc.area IS NOT NULL THEN 'bookings' WHEN pc.area IS NOT NULL THEN 'tracker' END AS by
            FROM (SELECT round(${latCol} / ${CELL})::int AS la, round(${lngCol} / ${CELL})::int AS lo) k
            LEFT JOIN booking_cell bc ON bc.cell_lat = k.la AND bc.cell_lng = k.lo
            LEFT JOIN place_cell pc ON pc.cell_lat = k.la AND pc.cell_lng = k.lo) x)`;

/* The two ends of a segment, named. Both, because they answer different
   questions: where a car was taken FROM is the shift it left, where it ended
   is where the person went. */
export const placeEnds = (alias = 'o') => `
  ${placeAt(`${alias}.start_lat`, `${alias}.start_lng`)} AS start_place,
  ${placeAt(`${alias}.end_lat`, `${alias}.end_lng`)} AS end_place`;

/* WHAT THE DISTANCE WAS WORTH, AND WHY THAT IS NOT A COST.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked for "how much that costed the company", as average AED/km
   times distance. That product is worth having and it is not a cost: it is the
   revenue those kilometres would have earned had they been sold, and the fuel
   and wear behind them are a different, smaller number this product cannot
   measure. So it is named for what it is — revenue forgone — and every surface
   that prints it says the rate it used.

   The rate is the SAME definition /api/kpis publishes as `revenue_per_km`
   (api/server.js:456), numerator and denominator over one population: bookings
   that carry BOTH a fare and a distance. The comment there records what
   happens otherwise — "live it came out 3.93 where revenue/priced_km is 5.28",
   a ratio between two different populations. Reusing the definition is what
   stops the unauthorised page quoting a rate the money pages do not recognise.

   Measured over the same window and the same fleet as the segments it values,
   because a September segment priced at an annual average is a figure nobody
   can reconcile against the month they are looking at. */
export const RATE_SQL = `
  SELECT round((sum(price) FILTER (WHERE is_booking AND has_fare AND has_distance)
                / nullif(sum(distance_km) FILTER (WHERE is_booking AND has_fare
                                                    AND has_distance), 0))::numeric, 2) AS aed_per_km,
         round(sum(distance_km) FILTER (WHERE is_booking AND has_fare
                                          AND has_distance)::numeric, 0) AS rate_km,
         count(*) FILTER (WHERE is_booking AND has_fare AND has_distance)::int AS rate_trips
    FROM trip_norm`;

/* Absent with a reason, never a zero: a segment with no measured distance did
   not travel nothing, it was not measured, and a window with no priced-and
   -measured booking behind it has no rate to value anything at. */
export const forgone = (distanceKm, rate) => (
  distanceKm == null || rate == null || !(rate > 0)
    ? null
    : Math.round(Number(distanceKm) * Number(rate) * 100) / 100);
