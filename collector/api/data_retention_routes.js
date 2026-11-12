/* What the data-retention pass did, for the Settings page (#settings, under
   "Requested runs").
   ─────────────────────────────────────────────────────────────────────────
   A pass that deletes rows nobody can see the record of is a pass nobody can
   trust — the same reason /api/settings/jobs exists. This returns the
   settings the next pass will read, the last pass per table (rows considered,
   would remove, removed), a fortnight of passes, and the boundary each page
   is told about (retention_state). Every absence says why: no pass yet is not
   "nothing to remove", and a missing table is a migration that has not
   applied, not an empty record. Not cached: /api/settings* is on the cache's
   NEVER list (api/cache.js). */
import { retentionSettings, telemetryCutoff, alertCutoff } from '../src/data_retention.js';
import { get, loadSettings } from '../src/settings.js';

export const RETENTION_SCHEDULE = { cron: '53 19 * * *', utc: '19:53', dubai: '23:53' };

export function dataRetentionRoutes(app, { q, wrap }) {
  app.get('/api/settings/retention', wrap(async (_req, res) => {
    await loadSettings().catch(() => {});
    const settings = retentionSettings(get);
    const tele = telemetryCutoff(settings);
    const alert = alertCutoff(settings);
    const next = {
      ...settings,
      schedule: RETENTION_SCHEDULE,
      telemetry_cutoff: tele ? { day: tele.day, asked: tele.asked, floor: tele.floor, floored: tele.floored } : null,
      alert_cutoff: alert ? { day: alert.day } : null,
    };
    let runs;
    try {
      runs = await q(
        `SELECT r.id, r.started_at, r.finished_at, r.mode, r.status, r.error, r.took_ms,
                coalesce(sum(t.considered), 0)::bigint AS considered,
                coalesce(sum(t.would_delete), 0)::bigint AS would_delete,
                coalesce(sum(t.deleted), 0)::bigint AS deleted
           FROM retention_run r LEFT JOIN retention_run_table t ON t.run_id = r.id
          GROUP BY r.id ORDER BY r.started_at DESC LIMIT 14`);
    } catch (e) {
      return res.json({ next, last: null, history: [], state: [],
        absent: 'the retention record does not exist yet: schema v115 has not applied on this database '
          + '(the boot log names the migration that failed)', error: String(e?.message || e).slice(0, 160) });
    }
    const last = runs[0] || null;
    const tables = last ? await q(
      `SELECT tbl, policy, cutoff, considered, would_delete, deleted, days_examined, days_pending,
              complete, total_estimate, oldest, newest, note, took_ms
         FROM retention_run_table WHERE run_id = $1 ORDER BY tbl`, [last.id]) : [];
    const state = await q(
      `SELECT tbl, action, done_before, removed_from, removed_before, bucket_min, updated_at
         FROM retention_state ORDER BY tbl`);
    res.json({
      next,
      last: last ? { ...last, tables } : null,
      history: runs,
      state,
      absent: last ? null
        : `no retention pass has run yet; the first is at ${RETENTION_SCHEDULE.utc} UTC `
          + `(${RETENTION_SCHEDULE.dubai} Dubai), or by hand with \`node src/index.js retention dry-run\``,
    });
  }));
}
