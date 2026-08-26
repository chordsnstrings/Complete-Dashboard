-- A driver's fleet is not a fact about a date range.
-- ─────────────────────────────────────────────────────────────────────────
-- The driver directory lists everyone the fleet has ever known, which is the
-- point of it: a person who has stopped driving is exactly who an operator
-- opens the page to find. Their window columns are legitimately zero.
--
-- Their IDENTITY columns were blank too, and those are not window facts.
-- Measured on production over thirty days: 361 rows, of which 244 carried no
-- fleet, no platform list and no usual vehicle — including a driver with
-- 2,393 lifetime trips on record. The page could say who they are and did
-- not, because every one of those columns was read from the window's trips or
-- from a compliance row, and a person who drove last quarter has neither.
--
-- driver_lifetime already answers the other question with no window — has
-- this person ever driven, and when last — so it is where these belong. Three
-- columns, each the whole-history answer, filled by refreshLifetime from the
-- same trip table the directory falls back to.
--
-- last_fleet rather than fleet: a driver can move between the two businesses,
-- and the honest answer to "whose driver is this" for somebody who has left is
-- "the last fleet they drove for", not a guess at where they belong now.
ALTER TABLE driver_lifetime ADD COLUMN IF NOT EXISTS last_fleet TEXT;
ALTER TABLE driver_lifetime ADD COLUMN IF NOT EXISTS platforms  TEXT[];
ALTER TABLE driver_lifetime ADD COLUMN IF NOT EXISTS last_plate TEXT;

COMMENT ON COLUMN driver_lifetime.last_fleet IS
  'The fleet of this person''s most recent booking, at any date. The directory '
  'falls back to it for people with no work inside the window, whose fleet is '
  'otherwise blank on a page whose whole job is to list them.';
COMMENT ON COLUMN driver_lifetime.platforms IS
  'Every channel this person has ever taken a booking on, at any date.';
COMMENT ON COLUMN driver_lifetime.last_plate IS
  'The plate on their most recent booking. Their usual vehicle is a window '
  'measure and stays one; this is what to print when the window is empty.';
