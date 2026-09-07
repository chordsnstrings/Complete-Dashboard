-- ---------------------------------------------------------------------------
-- Place names: turning a coordinate into somewhere a person can picture.
-- ---------------------------------------------------------------------------
-- The driver day printed "25.112, 55.139" against every waiting block and said
-- nothing at all about where a driver went online. Both are questions about an
-- AREA — where does this person choose to wait, where do they start their
-- shift — and neither is answerable from a decimal pair.
--
-- No source gives us both halves:
--
--   trip:uber       315,505 rows, addresses on all of them, coordinates on NONE
--   timeline:uber   197,687 rows, and lat/lon null on every single one, even
--                   though the GraphQL query asks for rootLocation
--   trip:fms        222,543 rows, coordinates on 100%, and an address string
--   trip:bolt        48,382 rows, neither
--   trip:hotel        1,786 rows, coordinates on 69%
--   trip:yango           50 rows, coordinates on 22%
--
-- (measured on production 2026-09-07 via /api/coverage)
--
-- So the fleet's own history is the gazetteer. FMS is the telematics box in
-- the same cars, and it reports a reverse-geocoded address ALONGSIDE the fix
-- that produced it — 222,543 trips with two labelled endpoints each. Those
-- pairs are what name a coordinate that arrived with no name of its own, and
-- they cover exactly the roads this fleet drives rather than a country.

-- ── what counts as the "area" in an address ────────────────────────────────
-- Every provider here returns the same dash-separated shape, most specific
-- first, ending in city then country:
--
--   Cluster T - Al Thanyah Fifth - Jumeirah Lakes Towers - Dubai - United Arab Emirates
--   4538+544 - Al Falak St - Al Safouh Second - Dubai Internet City - Dubai - United Arab Emirates
--   Sheraton Hotel, Mall of The Emirates - Level 2 - Sheikh Zayed Rd - Al Barsha First - Al Barsha - Dubai - UAE
--   60 Al Falak St - Al Sufouh - Dubai Media City - Dubai - United Arab Emirates,
--
-- The read API took the SECOND segment. On those four that yields "Al Thanyah
-- Fifth", "Al Falak St", "Level 2" and "Al Sufouh" — a sub-community, a
-- street, a floor of a hotel, and a sub-community. Three of the four are not
-- areas at all, and they were being rendered on the Territory tab and in the
-- corridor analytics under the heading "area".
--
-- The community a person would actually name is the THIRD FROM THE END: the
-- segment before city and country. On the same four: "Jumeirah Lakes Towers",
-- "Dubai Internet City", "Al Barsha", "Dubai Media City".
--
-- Counting from the end also survives the thing counting from the front does
-- not — the address is not always in English:
--
--   Boulevard Street - برج خليفة - Burj Residence Phase I & II - دبي - 阿拉伯联合酋长国
--
-- A rule that recognises "Dubai" and "United Arab Emirates" by name drops that
-- row. Position does not care what language the city is written in.
--
-- Fewer than three segments means there is no area in the string — "Mall of
-- Emirates Al Barsha 1 AE" arrives with no separators at all — and that is
-- NULL, to be reported as unnamed rather than guessed at.
--
-- IMMUTABLE because it is a pure function of its argument, which is what lets
-- an index be built on it; PARALLEL SAFE so a scan over the trip table can
-- still be split. FMS suffixes its addresses with a comma and sometimes a
-- trailing space, so the string is trimmed of both before it is split.
CREATE OR REPLACE FUNCTION place_area(addr text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT nullif(btrim(a[array_length(a, 1) - 2]), '')
    FROM (SELECT string_to_array(btrim(coalesce(addr, ''), ' ,'), ' - ') AS a) s
   WHERE array_length(a, 1) >= 3
$fn$;

COMMENT ON FUNCTION place_area(text) IS
  'The community in a dash-separated address: the third segment from the end, which is the one before city and country. NULL when the string carries fewer than three segments — an address with no area in it is unnamed, never guessed.';

-- ── the gazetteer ──────────────────────────────────────────────────────────
-- One row per half-kilometre cell, carrying the name the fleet's own history
-- uses for that patch of ground and how many observations stand behind it.
--
-- A cell rather than a point, for two reasons. A point lookup would have to
-- scan for a nearest neighbour, and a name is not a property of a point: the
-- same cell legitimately contains "Rostamani Tower" (a building FMS named,
-- because the address it returned had only three segments) and "Business Bay"
-- (the community around it). Taking the MODE over a cell lets the community
-- outvote the building, which is what a person asking "where were they
-- waiting" wants to hear.
--
-- 0.005 degrees is about 555 m north-south and 503 m east-west at this
-- latitude. Smaller than any Dubai community and larger than any single
-- building, which is exactly the resolution the question has.
CREATE TABLE IF NOT EXISTS place_cell (
  cell_lat   INT  NOT NULL,          -- round(lat / 0.005)
  cell_lng   INT  NOT NULL,
  area       TEXT NOT NULL,          -- the modal name over this cell
  n          INT  NOT NULL,          -- observations backing that name
  distinct_names INT NOT NULL,       -- how many names this cell ever saw
  observations   INT NOT NULL,       -- every observation in the cell, all names
  built_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (cell_lat, cell_lng)
);

COMMENT ON TABLE place_cell IS
  'Coordinate to place name, learned from the fleet''s own trip endpoints: one row per ~0.5 km cell holding the modal area name. n is the votes for that name, observations is every vote cast in the cell, so a caller can tell a name 400 trips agree on from one a single trip supplied.';

CREATE INDEX IF NOT EXISTS place_cell_area_idx ON place_cell (area);
