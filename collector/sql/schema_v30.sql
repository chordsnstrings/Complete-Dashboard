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

-- A finding that names seven people and identifies none of them.
--
-- drivers_online_no_trips is the most severe row on the live list: "Uber
-- flagged 7 driver(s) logged in for about 12.6 hours with zero completed
-- trips". Uber's own payload names them — platform_recommendation.flagged
-- carries {driver_ext_id, value, online_hours} per person — and the finding
-- rendered with no anchors at all, so the one action it proposes ("check
-- whether they were genuinely available") cannot be taken from the page.
--
-- `refs` is the entities a finding is ABOUT when that is more than one thing.
-- entity_id already carries the single subject (a plate, a driver id); this is
-- the list, in the shape the front end's link map already reads:
-- [{driver_ext_id, name, hours_online}] or [{plate, ...}].
ALTER TABLE insight ADD COLUMN IF NOT EXISTS refs JSONB;
COMMENT ON COLUMN insight.refs IS
  'The entities a finding names, when it names more than one: [{driver_ext_id|plate, ...}]. entity_id is the single subject; this is the list, so a fleet-wide finding about seven people can be opened.';

-- And the copies themselves, which no index can make cheap.
--
-- schema_v15 deduplicated the NULL-window and fleet-level rules and gave them
-- unique indexes. It could not touch the WINDOWED ones, because their conflict
-- key includes window_start and window_end and those move on every run: a
-- sliding 30-day window means the same finding about the same vehicle keys
-- differently every thirty minutes, so it INSERTS rather than replacing. That
-- is where the remaining 29,430 duplicates came from, and they are still
-- arriving.
--
-- This keeps exactly the row the read path already serves. Every reader is
--
--   DISTINCT ON (code, entity_type, entity_id) ... ORDER BY computed_at DESC
--
-- so the surviving set is BY CONSTRUCTION the set /api/insights returns today:
-- the delete cannot change a single number on any page, only how many rows
-- have to be sorted to produce them. The tiebreak on equal computed_at is
-- a.id < b.id, matching schema_v15's, so the two purges cannot disagree about
-- which copy is the survivor.
--
-- Idempotent, so it needs no run-once guard: on a deduplicated table it
-- deletes nothing. It runs unconditionally and before the index above for the
-- reason schema_v15 records at length — a migration file is one implicit
-- transaction, and guarding a purge behind an index creation means the index
-- failure rolls the purge back with it.
--
-- src/insights.js prunes after every run as well, so this is a one-off
-- catch-up rather than the mechanism.
DELETE FROM insight a USING insight b
WHERE a.code = b.code
  AND a.entity_type IS NOT DISTINCT FROM b.entity_type
  AND a.entity_id   IS NOT DISTINCT FROM b.entity_id
  AND (a.computed_at < b.computed_at
       OR (a.computed_at = b.computed_at AND a.id < b.id));

-- The probe described 300 rows and reported a record count of 10,423.
--
-- describe() reads rows.slice(0, 300) — deliberately, because the question is
-- the SHAPE, not the numbers — while record_count was the full array length.
-- The Providers page printed the two beside each other as though the fill
-- rates and distinct counts covered every record, and on a surface returning
-- ten thousand rows they cover 2.9% of them.
--
-- Nullable: rows written before this column existed carry NULL, which reads as
-- "not recorded" rather than as zero described.
ALTER TABLE provider_probe ADD COLUMN IF NOT EXISTS described_n INT;
COMMENT ON COLUMN provider_probe.described_n IS
  'How many of record_count rows the field description was actually read from. describe() samples the first 300; a fill rate or a distinct count is over this many rows, never over record_count.';
