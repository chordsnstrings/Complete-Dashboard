-- v40 — why a pass came back empty.
--
-- analyst_run records that a pass proposed nothing and how many proposals it
-- dropped, and stops there. On production that read "proposed 0, dropped 1"
-- and the page said "the model proposed nothing worth checking" — which was
-- wrong in the way that matters: the model had proposed twelve good claims and
-- the PARSER had thrown them away, because the model emitted an array, changed
-- its mind in prose, and emitted a corrected one.
--
-- "The model had nothing to say" and "we could not read what it said" are
-- different facts about different problems, and only one of them is the
-- operator's. The reasons are stored so the page can tell them apart.
ALTER TABLE analyst_run ADD COLUMN IF NOT EXISTS dropped_reasons TEXT;

COMMENT ON COLUMN analyst_run.dropped_reasons IS
  'Distinct reasons proposals were refused before measurement, joined with "; ". A run with proposed = 0 and a reason here was not a quiet night: it is a prompt or a parser that needs fixing.';
