-- "Has this person ever driven, and when did they last?"
--
-- The driver directory answers that for everybody, and it is the one question
-- on the page with no window: a person who has not driven in the last thirty
-- days and a person who has never driven at all are different rows, and
-- telling them apart means looking at the whole record. So the query grouped
-- every trip the fleet has ever taken, on every request — two hundred and
-- fifteen thousand rows to decorate eight hundred directory entries — and the
-- endpoint took the better part of a minute at a wide window.
--
-- It is also an answer that changes only when the collector writes, which is
-- what rollup_day and rollup_month are for. This is the same trade at the
-- grain the directory actually keys on: the SYNTHESISED key, which is the
-- platform id where there is one and the folded name where there is not, so a
-- driver known only by name still keys identically here, in the directory, and
-- in vehicle_driver_day.
--
-- Not rollup_person_month, which is keyed on person_key alone and carries
-- months: two ids belonging to one person are two directory rows and one
-- rollup row, and "last drove in August" is not "last drove on the 14th".
-- Precomputing the wrong grain would have been faster and wrong.
CREATE TABLE IF NOT EXISTS driver_lifetime (
  driver_ext_id TEXT PRIMARY KEY,   -- the synthesised key, id or name:<fold>
  driver_name   TEXT,
  last_ever     TIMESTAMPTZ,
  lifetime      INT,
  computed_at   TIMESTAMPTZ DEFAULT now()
);
