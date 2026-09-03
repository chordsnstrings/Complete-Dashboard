-- ── the Bolt zeros that were never measurements ────────────────────────────
-- ---------------------------------------------------------------------------
-- src/sources/bolt.js now writes NULL where the portal writes 0, because on
-- that feed 0 means "no fare was charged" and "no distance was driven" rather
-- than zero dirhams and zero kilometres. That fixes what arrives from here on.
-- It does not touch the 48,210 rows already collected, and those are the ones
-- distorting every average on the product today.
--
-- has_fare in sql/schema_v18.sql is `price IS NOT NULL`, so a cancellation at
-- price 0 counted as a priced ride. Measured on production over 365 days:
-- Bolt's average fare read AED 23.60 against AED 60.67 across its completed
-- rides — 61% low — because 16,846 of 27,440 rows were cancellations at zero.
--
-- Scoped to bolt and to exact zeros. No other channel writes a zero it does
-- not mean: the Uber trip export carries no fare column at all, and the hotel
-- and Yango feeds report a fare only where one exists. The original response
-- is kept in trip.raw either way, so nothing is lost by this and a future
-- reader can always see what the portal actually said.

UPDATE trip
   SET price = NULL
 WHERE platform = 'bolt' AND price = 0;

UPDATE trip
   SET distance_km = NULL
 WHERE platform = 'bolt' AND distance_km = 0;

-- DELIBERATELY NOT the ledger. ledger_entry.amount can be 0 for reasons this
-- migration has no evidence about — an adjustment that nets out, a fee waived —
-- and the measurement above is about the trip feed's price and distance only.
-- Nulling a figure because a sibling figure was wrong is how the next of these
-- gets written.
