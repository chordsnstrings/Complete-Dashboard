/* THE ACTION LIST'S OWN QUERY — what /api/insights serves, as one function.
   ─────────────────────────────────────────────────────────────────────────
   Moved here verbatim from the route in api/server.js (2026-10-02) so the
   Today workbook (api/today_workbook.js) lists exactly the findings the page
   lists: two copies of "which findings are still live" is the drift this
   codebase keeps paying for. Seven parameters, in this order: severity,
   category, code, entity_id, fleet, from, to — each NULL for "any".

   ONLY WHAT THE LAST RUN OF EACH RULE STILL FINDS.
   ─────────────────────────────────────────────────────────────────────
   src/insights.js prunes to one row per (code, entity, window) and keeps
   the newest, so a finding that was true once and has not been true since
   survives forever — and this endpoint served it as a live to-do. On
   production, 163 of the 200 rows on the action list were last recomputed
   before Aug 30, some as far back as Aug 21: 74 idle-vehicle findings the
   rule had already stopped emitting sat beside the 1 it still did, and
   "L37810: Vehicle Registration Form expires in 1 days", computed on the
   25th, was still on the list on the 1st — six days after the document it
   describes expired.

   A rule's most recent write is the moment it last evaluated. Anything it
   did not re-emit then, it no longer finds. Ten minutes of tolerance
   because a pass writes over some seconds; the incremental that drives it
   runs every thirty, so the window cannot reach the previous pass.

   What this deliberately does NOT do is drop findings from a rule that has
   not run at all — its own last write is its last run, so every row it
   wrote is still current by this test. That is the honest answer: a rule
   that never re-evaluated has not cleared anything. The remaining gap is a
   rule that ran and emitted nothing at all, whose last write stays old;
   closing that needs a per-rule run marker rather than an inference from
   the rows.
*/
export const insightListSql = (limit) => `WITH run AS (
       /* When each rule last EVALUATED. insight_run is stamped by
          src/insights.js after a job succeeds, which is the only way to know a
          rule ran and found nothing — the rows alone cannot say it, and a rule
          that ran clean left its whole previous set standing as live work.
          The greatest() keeps the inference as a floor for any code with no
          marker yet (a database that has not run the new collector), so this
          can never show LESS than it did before the marker existed. */
       SELECT i.code,
              greatest(max(i.computed_at), max(r.ran_at)) AS last_run
       FROM insight i
       LEFT JOIN insight_run r ON r.code = i.code
       GROUP BY 1
     ),
     scoped AS (
       SELECT i.code, i.severity, i.category, i.entity_type, i.entity_id, i.title, i.detail,
              i.action, i.impact_aed, i.metric, i.fleet_id, i.refs,
              i.window_start, i.window_end, i.computed_at,
              (i.computed_at >= r.last_run - interval '10 minutes') AS still_found
       FROM insight i
       JOIN run r ON r.code = i.code
       WHERE ($1::text IS NULL OR i.severity=$1) AND ($2::text IS NULL OR i.category=$2)
         AND ($3::text IS NULL OR i.code=$3) AND ($4::text IS NULL OR i.entity_id=$4)
         AND ($5::text IS NULL OR i.fleet_id=$5)
         AND (i.window_start IS NULL
              OR (($6::date IS NULL OR i.window_start >= $6::date)
                  AND ($7::date IS NULL OR i.window_end <= $7::date)))
     ),
     deduped AS (
       SELECT DISTINCT ON (code, entity_type, entity_id) *
       FROM scoped
       ORDER BY code, entity_type, entity_id, computed_at DESC
     ),
     latest AS (
       SELECT *, count(*) FILTER (WHERE NOT still_found) OVER ()::int AS cleared
       FROM deduped
     )
     SELECT *,
            /* Whether the AED beside a finding was MEASURED or assumed. 75 of
               the 204 live findings are idle_vehicle, whose impact is a
               hardcoded holding-cost constant, and nothing on the row said so
               — so a modelled number sorted and totalled beside measured
               ones. */
            CASE WHEN impact_aed IS NULL THEN NULL
                 WHEN code = 'idle_vehicle' THEN 'modelled' ELSE 'measured' END AS impact_kind
       FROM latest
      WHERE still_found
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
              computed_at DESC, impact_aed DESC NULLS LAST
     LIMIT ${Number(limit) + 1}`;
