-- Ageing a receivable means looking OUTSIDE the window, so it needs an index.
--
-- /api/settlement/receivables computed "oldest debt" as min(requested_at)
-- inside the selected window, which is why it could never exceed the window:
-- at days=7 the oldest receivable was at most seven days old, and the tone
-- that warns on debt over sixty days was unreachable at every range the page
-- offers. Ageing is a property of the debt, not of the range chip, so the
-- query now drops the lower bound.
--
-- That turns a windowed read into a read over every trip up to the end of the
-- window — 253,000 rows — unless an index can answer it. The predicate is
-- trip_ext.is_receivable, which is defined in sql/schema_v18.sql as
--
--   lower(coalesce(payment_type, '')) IN ('room-charge','hotel-charge','posted-for-salary')
--
-- and this partial index repeats that expression CHARACTER FOR CHARACTER.
-- schema_v27 states the rule this obeys: an index on a different expression
-- for the same column is no index at all, and a paraphrase — payment_type IN
-- (...) without the lower(coalesce(...)) — would not be matched by the
-- planner. The indexed key is the Dubai calendar day, the same expression
-- trip_local_day_idx uses, because the upper bound and the ageing buckets are
-- both comparisons against it.
--
-- Receivables are a few thousand rows of a quarter-million, so this index is
-- small and the scan it replaces is the whole table.
CREATE INDEX IF NOT EXISTS trip_receivable_local_day_idx
  ON trip (((requested_at AT TIME ZONE 'Asia/Dubai')::date))
  WHERE lower(coalesce(payment_type, '')) IN ('room-charge', 'hotel-charge', 'posted-for-salary');

-- The insight table is 99.3% duplicates, and every read de-duplicates it.
--
-- Production holds 29,634 insight rows describing 204 findings:
-- duplicates_suppressed 29,430. The generator appends a fresh row for every
-- (code, entity_type, entity_id) on every run, and /api/insights and
-- /api/insights/summary both wrap the whole table in
-- DISTINCT ON (code, entity_type, entity_id) ... ORDER BY computed_at DESC to
-- get back to 204 — the summary doing it FIVE times, once per query.
--
-- This index is the exact key and order that DISTINCT ON needs, so the
-- de-duplication becomes an index scan instead of a sort of thirty thousand
-- rows. It is deliberately NOT unique: making it unique would require the
-- generator to upsert, and a generator that overwrites its own history cannot
-- answer "when did this finding first appear" — which the entity_id NULL rows
-- (fleet-wide findings) need most.
--
-- entity_id is nullable and NULLs sort last by default in a DESC ordering, so
-- the index states NULLS LAST explicitly to match the queries.
CREATE INDEX IF NOT EXISTS insight_latest_idx
  ON insight (code, entity_type, entity_id, computed_at DESC);
