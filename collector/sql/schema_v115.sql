/* schema_v115 — DATA RETENTION: the record of every nightly pass, the boundary
   readers use to say "thinned by retention before <date>", and one duplicate
   index dropped.
   ═════════════════════════════════════════════════════════════════════════════
   THE NEED, MEASURED. The system audit of 2026-11-12 found nothing pruned
   anywhere. Read off production that morning (/api/coverage):

     telemetry_snapshot   1,448,880 rows   cabman 281,758 · fms 1,010,548 ·
                                           uber 156,574; median 17.8k a day,
                                           all of it collected since 2026-08-21
     alert                  905,818 rows   from 2026-05-22, median 5,136 a day
     driver_timeline_event  633,225 rows   from 2026-08-16
     trip                   705,000 rows

   and /api/coverage itself took 16.5 s (17-33 s in the audit) because it
   aggregates those tables whole. The newest daily backup was 5.95 GB.

   WHAT THE PASS MAY TOUCH, AND WHY SO LITTLE (src/data_retention.js has the
   long version). Every reader of these tables was found and its window written
   down before any rule was chosen:
     · telemetry_snapshot, tracker sources (cabman, fms): THINNED, never
       emptied, and only beyond the weekly backfill's window. src/run.js
       backfill() re-runs reconcile() over BACKFILL_MONTHS (12) every Sunday,
       and reconcile DELETES and re-derives occupancy_segment from the fixes in
       its window — so thinning anything it still reads would rewrite the
       unauthorized-journey record from coarser data. The floor is enforced in
       code, not left to the setting.
     · telemetry_snapshot, source 'uber': KEPT. Each row is a driver status
       change, an event, not a sample.
     · alert: KEPT by default. FMS keeps alerts about 100 days; ours are the
       only long-term record. RETENTION_ALERT_DAYS (0 = for ever) can opt in,
       never below 365 days.
     · driver_timeline_event: KEPT, with no setting. Uber serves 31 days, and
       the full rollup (src/rollup.js refreshOnlineHours / refreshDriverDays,
       since = null, daily at 22:40 UTC and at boot) re-derives every online
       hour from every event and deletes the hours it did not recompute.
       Removing events would erase online-hours history the next night.
     · trip, collection_run: KEPT (the record; and reconcile's channel guard
       reads run history across the whole backfill window).

   THE THREE TABLES.
     retention_run        one row per pass: mode, status, the settings read.
     retention_run_table  one row per pass per table: rows considered, rows the
                          policy would delete, rows deleted (0 in a dry run).
     retention_state      per table, the instant before which the policy has
                          been applied for real, and the instant from which it
                          has actually REMOVED rows (removed_from up to
                          removed_before). That range is what a page reads to
                          say "thinned by retention before <date>" — a dry run
                          never writes it, and a pass that removed nothing
                          leaves it NULL, so nothing is ever announced as
                          thinned that was not. done_before is only the
                          pass's own cursor: where the next pass resumes.

   WHY removed_from (review of 2026-11-12). The first draft kept done_before
   alone and let an "on" pass with RETENTION_ALERT_DAYS set write the alert
   boundary even when it had removed nothing — which, with the alert feed
   starting 2026-05-22 and the 365-day floor, is every pass until 2027-05-22.
   Every alert page whose window began before the cutoff (the default
   all-time window begins 2000-01-01) would then have said "Safety alerts
   before <date> were removed by retention" of alerts that never existed, and
   alertCoverage would have blamed retention for days the feed never ran. A
   boundary that says only where the policy STOPS cannot tell a page whether
   anything was taken from ITS range; one that also says where removal BEGAN
   can: a window that ends before removed_from lost nothing. And the cursor
   cannot be the claim's end either: a day cut short by the time budget has
   lost fixes but must be walked again, so the cursor stays at its start while
   removed_before already covers it. */

CREATE TABLE IF NOT EXISTS retention_run (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  mode         TEXT NOT NULL,                     -- dry_run | on | off
  status       TEXT NOT NULL DEFAULT 'running',   -- running | ok | partial | failed | skipped
  error        TEXT,
  settings     JSONB,
  took_ms      INT
);
CREATE INDEX IF NOT EXISTS retention_run_started_idx ON retention_run (started_at DESC);

CREATE TABLE IF NOT EXISTS retention_run_table (
  run_id          BIGINT NOT NULL REFERENCES retention_run(id) ON DELETE CASCADE,
  tbl             TEXT NOT NULL,
  policy          TEXT NOT NULL,          -- thin | remove | keep
  cutoff          TIMESTAMPTZ,            -- rows older than this are past the table's horizon
  considered      BIGINT,                 -- rows the policy examined this pass
  would_delete    BIGINT,                 -- rows the policy would remove
  deleted         BIGINT NOT NULL DEFAULT 0,
  days_examined   INT,
  days_pending    INT,                    -- days past the horizon left for a later pass
  complete        BOOLEAN,
  total_estimate  BIGINT,                 -- pg_class.reltuples when the pass began; NULL = never analysed
  oldest          TIMESTAMPTZ,
  newest          TIMESTAMPTZ,
  note            TEXT,
  took_ms         INT,
  PRIMARY KEY (run_id, tbl)
);

CREATE TABLE IF NOT EXISTS retention_state (
  tbl          TEXT PRIMARY KEY,
  action       TEXT NOT NULL,             -- thinned | removed
  done_before  TIMESTAMPTZ NOT NULL,      -- every row older than this has been through the policy
  removed_from TIMESTAMPTZ,               -- the earliest instant a pass really removed rows from; NULL = nothing removed yet
  removed_before TIMESTAMPTZ,             -- and the end of the last day it removed rows from (a day cut short included)
  bucket_min   INT,                       -- thinned: one fix per car per this many minutes
  run_id       BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE retention_state IS
  'Per table, the instant before which the retention pass has applied its policy FOR REAL (mode on), and the range it actually removed rows from ([removed_from, removed_before); NULL = nothing removed yet). Read by api/data_retention_notes.js to put "thinned by retention before <date>" on every page whose window overlaps that range. done_before is only where the next pass resumes. A dry run never writes here.';

/* ── THE DUPLICATE INDEX ─────────────────────────────────────────────────────
   telemetry_snapshot carries (plate, captured_at DESC) twice:
   telem_plate_time_idx (sql/schema.sql:173) and telemetry_plate_captured_idx
   (sql/schema_v7.sql:64). Same table, same columns, same order, no predicate.
   Every fix the pollers write or re-stamp (polled_at moves on every poll, and
   polled_at is indexed, so no update here is HOT) writes BOTH.

   WHICH ONE THE PLANNER USES — measured on the database being migrated where
   it can be, not assumed. pg_stat_user_indexes.idx_scan counts the scans each
   index has served since statistics began; a twin at ZERO beside one that has
   served scans is one the planner never chose, and it is the one dropped.
   Two non-zero counts prove nothing about today (telem_plate_time_idx served
   every scan alone until v7 created its twin), so then — and on a fresh
   database where both are zero — the function applies the planner's own
   rule: for one definition, more pages cost more, so the bigger twin is the
   one passed over and the one dropped; on an exact tie keep the NEWER,
   because that is the twin the planner picked when this was measured
   (PGlite's Postgres; an earlier draft of this comment said "the older", and
   the EXPLAIN in test/data_retention_schema.test.mjs said otherwise). On an
   exact tie the choice cannot change any plan's cost: the survivor is the
   same index under another name.

   NOT RECREATED LATER. schema.sql and schema_v7.sql are skipped by the ledger
   once applied (src/db.js runMigrations), and the generated schema_v53.sql
   never names a telemetry index (it rebuilds person_key and trip_econ_day_idx
   only), so regenerating it cannot bring this back.

   NOT DROPPED: the trip Dubai-day pair the audit named. trip_local_day_idx
   (v7) is NOT a duplicate of trip_econ_day_idx (v30, rebuilt by v53): the
   latter is a covering index that INCLUDEs eleven columns, many times larger,
   and the planner picks the small one for every day-range scan that needs only
   the key (proved in the same test). Dropping the small one would make those
   scans read the big one. And every regeneration of v53 drops person_key, which
   CASCADE-drops trip_econ_day_idx until it is rebuilt — for that minute or two
   trip_local_day_idx is the only Dubai-day index trip has.

   A LOCK, NOT A HANG. DROP INDEX takes ACCESS EXCLUSIVE on the table, and a
   deploy migrates while the old API instance is still serving a 17-33 s
   /api/coverage that reads this table. Waiting for it would queue every
   telemetry read behind the DROP. So the wait is capped at five seconds and a
   lock that is not free DEFERS the drop rather than failing this file: the
   nightly retention pass calls the same function again (src/data_retention.js)
   and records what it answered. */
CREATE OR REPLACE FUNCTION retention_drop_duplicate_index(a_name text, b_name text)
RETURNS text LANGUAGE plpgsql AS $fn$
DECLARE
  a regclass := to_regclass(a_name);
  b regclass := to_regclass(b_name);
  a_def text; b_def text; a_ok boolean; b_ok boolean; doomed text;
  a_scans bigint; b_scans bigint;
BEGIN
  IF a IS NULL OR b IS NULL THEN
    RETURN 'nothing to do: ' || coalesce(CASE WHEN a IS NULL THEN a_name END, b_name) || ' does not exist';
  END IF;
  -- The proof that they are twins is taken from the catalogue, not from the
  -- files: the definition with the index's own name cut out must match.
  a_def := regexp_replace(pg_get_indexdef(a), '^CREATE (UNIQUE )?INDEX \S+ ', 'CREATE \1INDEX _ ');
  b_def := regexp_replace(pg_get_indexdef(b), '^CREATE (UNIQUE )?INDEX \S+ ', 'CREATE \1INDEX _ ');
  IF a_def IS DISTINCT FROM b_def THEN
    RETURN 'kept both: not the same definition';
  END IF;
  SELECT indisvalid INTO a_ok FROM pg_index WHERE indexrelid = a;
  SELECT indisvalid INTO b_ok FROM pg_index WHERE indexrelid = b;
  SELECT coalesce(idx_scan, 0) INTO a_scans FROM pg_stat_user_indexes WHERE indexrelid = a;
  SELECT coalesce(idx_scan, 0) INTO b_scans FROM pg_stat_user_indexes WHERE indexrelid = b;
  a_scans := coalesce(a_scans, 0);
  b_scans := coalesce(b_scans, 0);
  doomed := CASE
    WHEN a_ok AND NOT b_ok THEN b_name          -- an invalid index serves nothing
    WHEN b_ok AND NOT a_ok THEN a_name
    /* The database's own counters: a twin that has never served a scan while
       the other has is the one the planner does not choose. Only a ZERO is
       read as proof — two non-zero counts are history (schema.sql's index
       served every scan alone until v7 existed), not today's preference. */
    WHEN a_scans = 0 AND b_scans > 0 THEN a_name
    WHEN b_scans = 0 AND a_scans > 0 THEN b_name
    /* Otherwise the planner's own rule for one definition: fewer pages cost
       less, so the bigger twin is the one it passes over. */
    WHEN pg_relation_size(a) > pg_relation_size(b) THEN a_name
    WHEN pg_relation_size(b) > pg_relation_size(a) THEN b_name
    WHEN a::oid < b::oid THEN a_name            -- an exact tie: keep the newer, as the planner does
    ELSE b_name END;
  PERFORM set_config('lock_timeout', '5s', true);
  BEGIN
    EXECUTE format('DROP INDEX IF EXISTS %I', doomed);
  EXCEPTION WHEN lock_not_available THEN
    RETURN 'deferred: ' || doomed || ' is in use (lock not free within 5 s); the nightly retention pass retries';
  END;
  RETURN 'dropped ' || doomed || ', kept ' || CASE WHEN doomed = a_name THEN b_name ELSE a_name END;
END
$fn$;

SELECT retention_drop_duplicate_index('telem_plate_time_idx', 'telemetry_plate_captured_idx');
