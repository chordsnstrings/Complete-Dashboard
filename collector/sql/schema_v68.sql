-- ---------------------------------------------------------------------------
-- place_area(): the two things the first version got wrong, measured on the
-- production gazetteer it built.
-- ---------------------------------------------------------------------------
-- sql/schema_v67.sql shipped, the collector built 4,855 cells over 709 names
-- from 410,627 observations, and the driver day named 221 of 222 tracker fixes
-- on the first person looked at. Most of the names were right — Jumeirah Lake
-- Towers, The Greens, Dubai Internet City, Downtown Dubai, The Palm Jumeirah.
--
-- Some were not names at all:
--
--   "9"        1,506 of 1,614 votes in its cell
--   "1"        69 of one driver's 222 fixes
--   "4762VVF", "57VWG8", "3583+3W3"
--   "D71", "D67", "D61"
--
-- Reading the addresses behind them gives two separate defects.
--
-- ── 1. empty segments shift the count ──────────────────────────────────────
-- FMS emits runs of blank segments:
--
--   45HMWX6 - Madinat Jumeirah -  1 -  - United Arab Emirates,
--
-- Counting three from the end over the raw split lands on "1". The community
-- is right there in the string — Madinat Jumeirah — and the rule walked past
-- it because two of the segments it counted were empty. Blank segments are
-- punctuation, not places, so they are dropped before anything is counted.
--
-- ── 2. the most specific segment is not always a place ─────────────────────
-- Where the reverse geocode has nothing but a road or a plus code, the address
-- is three segments long and the first is not a name:
--
--   57VWG8 - Dubai - United Arab Emirates,      a Google plus code
--   D71 - Dubai - United Arab Emirates,         a road designation
--   3583+3W3 - Dubai - United Arab Emirates,    a plus code
--
-- Third-from-the-end is structurally correct on all three and still returns
-- something nobody can picture. A candidate carrying a digit, no lowercase
-- letter and no space is a code, not a community; so is a bare number, with or
-- without a road letter in front of it. Those return NULL, which means the
-- observation is dropped from the gazetteer entirely — so the SECOND most
-- voted name in that cell, which is usually a real one, wins it instead. Where
-- a cell has no nameable candidate at all it stays unnamed, and the page says
-- the ground has never been named rather than printing "D71".
--
-- The test is deliberately loose about what it keeps. "Sheikh Zayed Rd" is a
-- street rather than a community, but it is a place a person can picture, and
-- the house rule is that a true coarse answer beats no answer. It is only
-- codes and bare numbers that are refused.
--
-- Kept IMMUTABLE and PARALLEL SAFE: still a pure function of its argument.
CREATE OR REPLACE FUNCTION place_area(addr text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  WITH seg AS (
    SELECT array_agg(btrim(raw) ORDER BY ord) AS a
      FROM unnest(string_to_array(btrim(coalesce(addr, ''), ' ,'), ' - '))
             WITH ORDINALITY AS t(raw, ord)
     WHERE btrim(raw) <> ''
  ), pick AS (
    SELECT a[array_length(a, 1) - 2] AS c FROM seg WHERE array_length(a, 1) >= 3
  )
  SELECT c FROM pick
   WHERE (c ~ '[a-z]' OR c !~ '[0-9]' OR c ~ '\s')
     AND c !~ '^[A-Z]{0,2} ?[0-9]+$'
$fn$;

COMMENT ON FUNCTION place_area(text) IS
  'The community in a dash-separated address: the third NON-EMPTY segment from the end, which is the one before city and country. NULL when the string carries fewer than three, or when the candidate is a code rather than a name — a plus code, a road designation, or a bare number. An address with no place in it is unnamed, never guessed.';

-- The gazetteer was built by the old rule, and the freshness guard in
-- src/places.js would leave it that way for six hours. Emptying it is how a
-- change to the RULE forces a rebuild: refreshPlaceCells() always builds an
-- empty table, whatever its age.
DELETE FROM place_cell;
