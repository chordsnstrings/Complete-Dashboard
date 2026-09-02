-- The ledger's own run row, repaired from what the table can actually show.
-- ---------------------------------------------------------------------------
-- Until this deploy, POST /api/import/statement-days recorded its run as
--
--   INSERT INTO collection_run (...)
--   SELECT $1, 'ecosine', 'import', 'ok', count(*), now()
--     FROM driver_statement_day WHERE source = $1
--
-- so `rows_written` was a count of the WHOLE table and `fleet_id` a hard-coded
-- literal. Read off production /api/status on 2026-09-02:
--
--   ledger  ecosine  import  ok  39,797 rows  finished 2026-08-24 09:00 UTC
--
-- 39,797 is how many statement-days are held in total, not how many the
-- 24 August import wrote, and it is attributed to Ecosine whatever companies
-- the workbook actually named. api/server.js writes the honest shape now — one
-- run per fleet, the rows THIS import wrote, the span of days it covered — but
-- the row already on the table goes on saying the old thing until somebody
-- imports a new workbook, and nothing schedules that.
--
-- WHAT MAKES THE REPAIR DERIVABLE rather than a guess.
-- driver_statement_day.ingested_at is set on insert and reset on every upsert
-- (sql/schema_v25.sql:51, and the ON CONFLICT clause in the import handler), so
-- for the MOST RECENT import the rows carrying an ingested_at at or before its
-- finish, and after the previous import's finish, are exactly the rows it
-- wrote. Older imports are not repaired: their rows have since been overwritten
-- and the attribution is genuinely gone — and /api/status is DISTINCT ON
-- (source, mode, fleet_id), so no reader ever sees them.
--
-- If the derivation finds nothing, nothing is inserted and the DELETE below
-- finds no replacement to stand in for, so the old row stays exactly as it is.
-- Running this file twice is a no-op: the row it repairs no longer matches.

WITH old AS (
  SELECT id, started_at, finished_at
    FROM collection_run
   WHERE source = 'ledger' AND mode = 'import' AND window_start IS NULL
     AND finished_at IS NOT NULL
   ORDER BY finished_at DESC
   LIMIT 1
), prev AS (
  SELECT max(c.finished_at) AS at
    FROM collection_run c, old o
   WHERE c.source = 'ledger' AND c.mode = 'import' AND c.id <> o.id
     AND c.finished_at < o.finished_at
), wrote AS (
  SELECT d.fleet_id, count(*)::int AS n, min(d.day) AS first_day, max(d.day) AS last_day
    FROM driver_statement_day d, old o, prev p
   WHERE d.source = 'ledger'
     AND d.ingested_at IS NOT NULL
     AND d.ingested_at <= o.finished_at
     AND (p.at IS NULL OR d.ingested_at > p.at)
   GROUP BY d.fleet_id
)
INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end,
                            started_at, finished_at, status, rows_written, error)
SELECT 'ledger', w.fleet_id, 'import', w.first_day, w.last_day,
       o.started_at, o.finished_at, 'ok', w.n, NULL
  FROM wrote w, old o;

-- Only where a replacement carrying the same finish now exists, so a run whose
-- rows could not be attributed is left alone rather than deleted.
DELETE FROM collection_run c
 WHERE c.source = 'ledger' AND c.mode = 'import' AND c.window_start IS NULL
   AND EXISTS (SELECT 1 FROM collection_run r
                WHERE r.source = 'ledger' AND r.mode = 'import'
                  AND r.window_start IS NOT NULL
                  AND r.finished_at = c.finished_at);
