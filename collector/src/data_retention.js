/* DATA RETENTION — the nightly pass, safe by default.
   ═════════════════════════════════════════════════════════════════════════════
   THE DEFECT. Nothing in this product was ever pruned. Measured on production
   on 2026-11-12 (/api/coverage, one request):

     telemetry_snapshot   1,448,880 rows — cabman 281,758 · fms 1,010,548 ·
                          uber 156,574 — a median 17.8k new rows a day, every
                          one of them collected since 2026-08-21
     alert                  905,818 rows from 2026-05-22, a median 5,136 a day
     driver_timeline_event  633,225 rows from 2026-08-16
     trip                 ~ 705,000 rows

   /api/coverage, which aggregates those tables whole, answered in 16.5 s (the
   audit timed 17-33 s), and the newest daily backup was 5.95 GB.

   WHAT EACH READER NEEDS — found before any rule was chosen, because a rule
   chosen first is how a page ends up showing a thinned range as complete.

   telemetry_snapshot, by window needed:
     · the LATEST fix only (unaffected by anything old being thinned):
       /api/live and /api/kpis (api/telemetry_sql.js LATEST_FIX), /api/feeds,
       /api/economics/assets' "last seen", /api/cohort/vehicles, the vehicle
       page's position and odometer (api/vehicle_routes.js:904-924),
       /api/where's "last fix", src/insights.js dormancy (max per plate),
       src/sources/cabman.js and discovery.js (recent rows by id).
     · a USER-CHOSEN window (any day the reader picks, up to 3,660 days):
       /api/where and /api/where/fleet (a car's fixes on a day, the nearest
       fix to an instant), /api/track, /api/map/days, /api/map/journey,
       /api/sensor-health (fix counts per plate), /api/vehicle/kpis,
       /api/vehicle/daily, /api/vehicle/movement (fix counts, days with fixes,
       parked spots stepped at 5 min), /api/economics/assets (days moved,
       CABMAN_MOVE_DAYS), /api/driver/day and /api/driver/territory (places
       and stops: >= 3 slow fixes), /api/online-time (the fix nearest each
       timeline event, +-30 min), /api/segment and /api/trip (the track along
       one journey, +-5/10 min), /api/coverage (every row, per day), and
       /api/schema/raw-fields (a sample). Every one of these reads fewer, more
       widely spaced fixes from a thinned range, so every one of them is in
       api/data_retention_notes.js READERS and the page says so.
     · a RE-DERIVATION that is stored: src/reconcile.js reads every CABMAN fix
       and every FMS seat-count fix in its window, DELETES the window's
       occupancy segments and writes them again (writeWindow). Its windows are
       the incremental (3 days), the catch-up (30) and the weekly backfill —
       BACKFILL_MONTHS, 12. This is the reader that sets the floor below.
     · source 'uber' rows are driver status changes keyed on the plate
       (src/sources/uber.js:1928, read by /api/driver/day and
       /api/performers): events, not samples. Never thinned.

   alert: /api/kpis, /api/alerts/summary, /api/alerts/by-vehicle and
     by-driver, /api/vehicles/directory, /api/vehicle/kpis, /daily, /safety,
     /api/driver/quality, /api/economics/assets and /drivers,
     /api/cohort/drivers and /vehicles, /api/day (buildDay), /api/coverage —
     all over user windows — plus src/insights.js unsafeDriving and
     src/report_findings.js over recent days. alertCoverage
     (api/alert_coverage_sql.js) decides which days the feed covered. FMS keeps
     alerts about 100 days (docs/COVERAGE.md), so ours are the only long-term
     record.

   driver_timeline_event: /api/online-time, /api/supply, /api/driver/day,
     /api/driver/territory, /api/coverage, insight people — and the FULL
     rollup, src/rollup.js refreshOnlineHours and refreshDriverDays with
     since = null, daily at 22:40 UTC and at every boot, which re-derives every
     online hour from every event and DELETES the hours it did not recompute.
     Uber serves 31 days of it.

   trip and collection_run: the record itself; and reconcile's channel guard
   reads run history across the whole backfill window.

   THE RULES THAT FOLLOW.
     1. telemetry_snapshot, tracker sources (cabman, fms): THINNED, never
        emptied — per car, the first fix of every 15-minute bucket, every fix
        where ignition, seat, seat count, status or moving/stopped changed, and
        each Dubai day's last fix. A track keeps its shape, every journey keeps
        its start and end, a day keeps its first and last odometer, and
        nothing that happened is lost — only the samples between changes.
        Only past max(RETENTION_TELEMETRY_DAYS, the weekly backfill's window
        plus a week): reconcile never reads a thinned fix, so the
        unauthorized-journey record is never re-derived from coarser data.
        That floor is enforced here, not left to the setting.
     2. alert: KEPT by default (RETENTION_ALERT_DAYS 0 = for ever). An
        operator may opt in to removing alerts older than N days, never fewer
        than 365; the pages then say "removed by retention before <date>" and
        alertCoverage stops calling those days "the feed was dark".
     3. driver_timeline_event: KEPT, no setting. Removing events would let the
        next full rollup erase the online hours derived from them.
     4. trip, collection_run: KEPT and measured.

   SAFE BY DEFAULT. RETENTION_MODE is dry_run unless the operator says "on":
   the pass counts what it WOULD remove and removes nothing, and only a pass in
   "on" mode moves retention_state. Pages read its CLAIM — [removed_from,
   removed_before), the range rows were really removed from — to say "thinned
   by retention before <date>", never its cursor (done_before), so a policy
   that ran and removed nothing claims nothing (review of 2026-11-12: the
   first draft let an alert pass that removed nothing announce a removal). So
   nothing is ever announced as thinned that was not, and nothing is thinned
   that was not first visible as a count.

   NO LONG LOCKS. One Dubai day of fixes per statement, at most RETENTION_BATCH
   rows deleted per statement (LIMIT), each statement its own short
   transaction, lock_timeout 3 s and statement_timeout 120 s on the session,
   at most 31 days and 15 minutes per pass. A backlog is worked off across
   nights, oldest first; the cursor is retention_state.done_before, so a pass
   cut short resumes where it stopped and never re-reads a finished day. */
import { pool } from './db.js';
import { get } from './settings.js';
import { log } from './log.js';
import { dubaiIso } from './util.js';
import { CABMAN_MOVING_KMH } from '../api/telemetry_sql.js';

export const TRACKER_SOURCES = Object.freeze(['cabman', 'fms']);
export const BUCKET_MIN = 15;
export const ALERT_FLOOR_DAYS = 365;
export const BACKFILL_MARGIN_DAYS = 7;
export const MAX_DAYS_PER_RUN = 31;
export const BUDGET_MS = 15 * 60 * 1000;
export const MODES = Object.freeze(['dry_run', 'on', 'off']);
/* An advisory-lock key of its own (src/db.js holds 72619 for migrations):
   two collectors overlapping during a deploy must not both walk the same day. */
const LOCK_KEY = 72620115;

/* The tables measured and kept, with the column their age is read from. */
export const KEPT = Object.freeze([
  { tbl: 'driver_timeline_event', col: 'at',
    note: 'kept: Uber serves 31 days and the full rollup (src/rollup.js refreshOnlineHours, '
      + 'refreshDriverDays, since = null) re-derives every online hour from these events and deletes the '
      + 'hours it did not recompute, so removing events would erase online-hours history' },
  { tbl: 'trip', col: 'requested_at', note: 'kept: the record' },
  { tbl: 'collection_run', col: 'finished_at',
    note: 'kept: reconcile’s channel guard reads run history across the whole backfill window' },
]);

const DAY_MS = 864e5;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/* The instant a Dubai calendar day begins. Dubai has kept UTC+4 without
   daylight saving since 1990 (src/util.js dubaiIso), so this is a constant
   offset and agrees with Postgres's AT TIME ZONE 'Asia/Dubai'. */
export const dubaiMidnight = (iso) => new Date(`${iso}T00:00:00+04:00`);

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };

/* The settings in effect, read once per pass and recorded with it. An unknown
   mode reads as dry_run — the safe direction — and says so. */
export function retentionSettings(read = get) {
  const rawMode = String(read('RETENTION_MODE', 'dry_run') ?? 'dry_run').trim().toLowerCase();
  const mode = MODES.includes(rawMode) ? rawMode : 'dry_run';
  const telemetryDays = Math.max(0, int(read('RETENTION_TELEMETRY_DAYS', '400'), 400));
  const alertAsked = Math.max(0, int(read('RETENTION_ALERT_DAYS', '0'), 0));
  return {
    mode,
    mode_asked: rawMode === mode ? undefined : rawMode,
    telemetry_days: telemetryDays,                     // 0 = never thin
    alert_days: alertAsked ? Math.max(alertAsked, ALERT_FLOOR_DAYS) : 0,   // 0 = keep for ever
    alert_days_asked: alertAsked,
    batch: Math.min(50000, Math.max(100, int(read('RETENTION_BATCH', '5000'), 5000))),
    backfill_months: Math.max(1, int(read('BACKFILL_MONTHS', '12'), 12)),
    bucket_min: BUCKET_MIN,
  };
}

/* Where telemetry thinning stops, and why there.
   asked  — RETENTION_TELEMETRY_DAYS back from today (Dubai)
   floor  — the weekly backfill's first day (src/run.js backfill: monthsAgo(
            BACKFILL_MONTHS)) less BACKFILL_MARGIN_DAYS, so the Sunday reconcile
            never reaches a thinned fix even as its window slides a week
   cutoff — the earlier of the two, as a Dubai midnight. */
export function telemetryCutoff({ now = new Date(), telemetry_days: days, backfill_months: months }) {
  if (!days) return null;
  const today = dubaiIso(now);
  const asked = addDays(today, -days);
  const b = new Date(now); b.setUTCMonth(b.getUTCMonth() - months);
  const floor = addDays(dubaiIso(b), -BACKFILL_MARGIN_DAYS);
  const day = asked < floor ? asked : floor;
  return { cutoff: dubaiMidnight(day), day, asked, floor, floored: floor < asked };
}

export function alertCutoff({ now = new Date(), alert_days: days }) {
  if (!days) return null;
  const day = addDays(dubaiIso(now), -days);
  return { cutoff: dubaiMidnight(day), day };
}

/* Which fixes a thinned day keeps. One statement's worth of one Dubai day,
   per (source, plate):
     rn = 1        the first fix of each 15-minute bucket (epoch-aligned, so
                   the buckets are Dubai quarter-hours too)
     changed       ignition, seat, seat count, status or moving (speed above
                   CABMAN_MOVING_KMH, the line api/telemetry_sql.js draws)
                   differs from the fix before it
     last_of_day   the day's last fix (the first is rn = 1 of its bucket)
   STABLE UNDER BATCHING, which is what lets each DELETE carry a LIMIT: a
   doomed fix is neither first nor last and has the same state as the fix
   before it, so removing it changes no other fix's bucket rank, last-ness or
   "changed" — the fix after it now compares with the one before it, whose
   state is the same. So batch k+1 recomputes exactly the doomed set batch k
   started from, minus what batch k removed. */
export const KEEP_SQL = (bucketMin = BUCKET_MIN, moving = CABMAN_MOVING_KMH) => `
  SELECT id,
         row_number() OVER (PARTITION BY source, plate,
                            floor(extract(epoch FROM captured_at) / ${bucketMin * 60})
                            ORDER BY captured_at, id) = 1
         OR lead(id) OVER w IS NULL
         OR (lag(id) OVER w IS NOT NULL AND (
                ignition      IS DISTINCT FROM lag(ignition)      OVER w
             OR seat_occupied IS DISTINCT FROM lag(seat_occupied) OVER w
             OR seat_count    IS DISTINCT FROM lag(seat_count)    OVER w
             OR status        IS DISTINCT FROM lag(status)        OVER w
             OR (coalesce(speed, 0) > ${moving}) IS DISTINCT FROM (lag(coalesce(speed, 0)) OVER w > ${moving})))
           AS keep
    FROM telemetry_snapshot
   WHERE source = ANY($3::text[]) AND captured_at >= $1 AND captured_at < $2
  WINDOW w AS (PARTITION BY source, plate ORDER BY captured_at, id)`;

const affected = (r) => Number(r?.rowCount ?? r?.affectedRows ?? 0);
const rowsOf = (r) => r?.rows || [];

async function readState(c, tbl) {
  const r = await c.query('SELECT done_before FROM retention_state WHERE tbl = $1', [tbl]);
  return rowsOf(r)[0]?.done_before ? new Date(rowsOf(r)[0].done_before) : null;
}
/* done_before is the CURSOR: every row older than it has been through the
   policy, whether or not anything was removed, and the next pass resumes
   there. [removed_from, removed_before) is the CLAIM: the range rows were
   really removed from (NULL until something is). Pages are told only about
   the claim — see the v115 header for the false "removed by retention" the
   cursor alone produced. least() and greatest() skip NULLs in Postgres, so a
   pass that removed nothing keeps the claim an earlier pass made and never
   invents one. */
async function writeState(c, { tbl, action, doneBefore, removedFrom = null, removedBefore = null,
  bucketMin = null, runId }) {
  await c.query(
    `INSERT INTO retention_state (tbl, action, done_before, removed_from, removed_before, bucket_min, run_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (tbl) DO UPDATE SET action = EXCLUDED.action,
       done_before = greatest(retention_state.done_before, EXCLUDED.done_before),
       removed_from = least(retention_state.removed_from, EXCLUDED.removed_from),
       removed_before = greatest(retention_state.removed_before, EXCLUDED.removed_before),
       bucket_min = EXCLUDED.bucket_min, run_id = EXCLUDED.run_id, updated_at = now()`,
    [tbl, action, doneBefore, removedFrom, removedBefore, bucketMin, runId]);
}

async function measure(c, tbl, col) {
  const est = rowsOf(await c.query(
    `SELECT reltuples::bigint AS n FROM pg_class WHERE oid = to_regclass($1)`, [tbl]))[0]?.n;
  const span = rowsOf(await c.query(`SELECT min(${col}) AS oldest, max(${col}) AS newest FROM ${tbl}`))[0] || {};
  return {
    /* reltuples is -1 on a table never analysed: unknown, not empty. */
    total_estimate: est == null || Number(est) < 0 ? null : Number(est),
    oldest: span.oldest || null,
    newest: span.newest || null,
  };
}

/* ── telemetry: thin, oldest day first ─────────────────────────────────── */
async function thinTelemetry(c, s, { runId, now, deadline }) {
  const out = { tbl: 'telemetry_snapshot', policy: 'thin', considered: 0, would_delete: 0, deleted: 0,
    days_examined: 0, days_pending: 0, complete: true, cutoff: null, notes: [] };
  Object.assign(out, await measure(c, 'telemetry_snapshot', 'captured_at'));
  const cut = telemetryCutoff({ now, ...s });
  if (!cut) {
    out.policy = 'keep';
    out.notes.push('RETENTION_TELEMETRY_DAYS is 0: telemetry is never thinned');
    return out;
  }
  out.cutoff = cut.cutoff;
  out.notes.push(`thinned past ${cut.day}: one fix per car per ${s.bucket_min} min, every change of `
    + 'ignition, seat, status or moving, and each day’s last fix; uber status rows are never thinned');
  if (cut.floored) {
    out.notes.push(`RETENTION_TELEMETRY_DAYS asks for ${cut.asked}; floored to ${cut.day}, a week before the `
      + `weekly backfill's window (BACKFILL_MONTHS ${s.backfill_months}), which reconcile re-derives from`);
  }
  const done = await readState(c, 'telemetry_snapshot');
  /* Raising BACKFILL_MONTHS after a thinning pass moves reconcile back into
     fixes that were thinned under the old floor. Nothing here can undo that;
     it is said on every pass until it stops being true. */
  if (done && done > dubaiMidnight(cut.floor)) {
    out.notes.push(`WARNING: telemetry before ${dubaiIso(done)} is already thinned, and the weekly backfill now `
      + `reaches back to ${cut.floor}: its reconcile re-derives occupancy segments from thinned fixes there`);
  }
  let cursor = done && done > new Date(0) ? done : new Date(0);
  const keep = KEEP_SQL(s.bucket_min);
  /* The first day this pass really removed fixes from — where the claim
     pages are told about begins. A day the rule left whole (nothing doomed)
     moves the cursor but claims nothing. */
  let removedFrom = null;
  while (cursor < cut.cutoff) {
    if (out.days_examined >= MAX_DAYS_PER_RUN || Date.now() > deadline) { out.complete = false; break; }
    const next = rowsOf(await c.query(
      `SELECT min(captured_at) AS t FROM telemetry_snapshot
        WHERE source = ANY($3::text[]) AND captured_at >= $1 AND captured_at < $2`,
      [cursor, cut.cutoff, TRACKER_SOURCES]))[0]?.t;
    if (!next) { cursor = cut.cutoff; break; }
    const day = dubaiIso(new Date(next));
    const from = dubaiMidnight(day);
    const to = dubaiMidnight(addDays(day, 1));
    const [tally] = rowsOf(await c.query(
      `WITH f AS (${keep}) SELECT count(*)::bigint AS n, count(*) FILTER (WHERE NOT keep)::bigint AS doomed FROM f`,
      [from, to, TRACKER_SOURCES]));
    out.considered += Number(tally?.n || 0);
    out.would_delete += Number(tally?.doomed || 0);
    let removedToday = 0;
    if (s.mode === 'on' && Number(tally?.doomed || 0) > 0) {
      for (;;) {
        const r = await c.query(
          `WITH f AS (${keep}), d AS (SELECT id FROM f WHERE NOT keep LIMIT ${s.batch})
           DELETE FROM telemetry_snapshot t USING d WHERE t.id = d.id`,
          [from, to, TRACKER_SOURCES]);
        const n = affected(r);
        out.deleted += n;
        removedToday += n;
        if (n < s.batch) break;
        if (Date.now() > deadline) break;
      }
    }
    if (removedToday > 0 && !removedFrom) removedFrom = from;
    out.days_examined += 1;
    cursor = to;
    /* The cursor moves only on a day finished for real, and only an "on"
       pass writes anything: a dry run never makes a page say a range was
       thinned that was not. The claim moves only over a day fixes were
       really removed from — including a day cut short, whose cursor stays at
       its start so the next pass finishes it, but whose readers are already
       looking at fewer fixes. */
    if (s.mode === 'on') {
      const left = Number(rowsOf(await c.query(`WITH f AS (${keep}) SELECT count(*) FILTER (WHERE NOT keep)::bigint AS n FROM f`,
        [from, to, TRACKER_SOURCES]))[0]?.n || 0);
      const claim = removedToday > 0 ? { removedFrom, removedBefore: to } : {};
      if (left > 0) {
        out.complete = false;
        cursor = from;                       // counted below as a day still pending
        if (removedToday > 0) {
          await writeState(c, { tbl: 'telemetry_snapshot', action: 'thinned', doneBefore: from,
            ...claim, bucketMin: s.bucket_min, runId });
        }
        break;
      }
      await writeState(c, { tbl: 'telemetry_snapshot', action: 'thinned', doneBefore: to,
        ...claim, bucketMin: s.bucket_min, runId });
    }
  }
  const pending = rowsOf(await c.query(
    `SELECT count(DISTINCT (captured_at AT TIME ZONE 'Asia/Dubai')::date)::int AS n FROM telemetry_snapshot
      WHERE source = ANY($3::text[]) AND captured_at >= $1 AND captured_at < $2`,
    [cursor, cut.cutoff, TRACKER_SOURCES]))[0]?.n || 0;
  out.days_pending = Number(pending);
  if (out.days_pending > 0) out.complete = false;
  return out;
}

/* ── alerts: kept unless the operator opted in ─────────────────────────── */
async function alertPolicy(c, s, { runId, now, deadline }) {
  const out = { tbl: 'alert', policy: 'keep', considered: 0, would_delete: 0, deleted: 0,
    days_examined: null, days_pending: null, complete: true, cutoff: null, notes: [] };
  Object.assign(out, await measure(c, 'alert', 'occurred_at'));
  const cut = alertCutoff({ now, ...s });
  if (!cut) {
    out.notes.push('kept: FMS keeps alerts about 100 days, so these rows are the only long-term record '
      + '(RETENTION_ALERT_DAYS 0 = keep for ever)');
    return out;
  }
  out.policy = 'remove';
  out.cutoff = cut.cutoff;
  if (s.alert_days_asked && s.alert_days_asked < ALERT_FLOOR_DAYS) {
    out.notes.push(`RETENTION_ALERT_DAYS asks for ${s.alert_days_asked}; floored to ${ALERT_FLOOR_DAYS}`);
  }
  out.notes.push(`alerts before ${cut.day} are ${s.mode === 'on' ? 'removed' : 'what an "on" pass would remove'}`);
  const n = Number(rowsOf(await c.query(
    'SELECT count(*)::bigint AS n FROM alert WHERE occurred_at < $1', [cut.cutoff]))[0]?.n || 0);
  out.considered = n;
  out.would_delete = n;
  if (s.mode !== 'on') return out;
  /* The oldest alert this pass will remove — rows go oldest first — is where
     the claim pages are told about begins. Read before the first DELETE. */
  const oldest = rowsOf(await c.query(
    'SELECT min(occurred_at) AS t FROM alert WHERE occurred_at < $1', [cut.cutoff]))[0]?.t;
  for (;;) {
    if (Date.now() > deadline) { out.complete = false; break; }
    const r = await c.query(
      `DELETE FROM alert WHERE (platform, external_id) IN (
         SELECT platform, external_id FROM alert WHERE occurred_at < $1
          ORDER BY occurred_at LIMIT ${s.batch})`, [cut.cutoff]);
    const k = affected(r);
    out.deleted += k;
    if (k < s.batch) break;
  }
  /* Everything older than the boundary is gone: the cutoff when the pass
     finished, or the oldest alert still standing when it was cut short.
     NOTHING is written when nothing was removed. The first draft wrote the
     cutoff whenever no alert was left before it — on every "on" pass until
     the first alert is 365 days old (2027-05-22), with nothing removed — and
     every alert page whose window began before the cutoff then said "Safety
     alerts before <date> were removed by retention" of alerts that never
     existed: a reason that is not the true one. */
  const left = rowsOf(await c.query(
    'SELECT min(occurred_at) AS t FROM alert WHERE occurred_at < $1', [cut.cutoff]))[0]?.t;
  if (left) out.complete = false;
  const boundary = left ? new Date(left) : cut.cutoff;
  if (out.deleted > 0) {
    await writeState(c, { tbl: 'alert', action: 'removed', doneBefore: boundary,
      removedFrom: oldest ? new Date(oldest) : null, removedBefore: boundary, runId });
  }
  return out;
}

async function keptTable(c, { tbl, col, note }) {
  return { tbl, policy: 'keep', considered: 0, would_delete: 0, deleted: 0, days_examined: null,
    days_pending: null, complete: true, cutoff: null, notes: [note], ...(await measure(c, tbl, col)) };
}

async function recordTable(c, runId, t) {
  await c.query(
    `INSERT INTO retention_run_table (run_id, tbl, policy, cutoff, considered, would_delete, deleted,
       days_examined, days_pending, complete, total_estimate, oldest, newest, note, took_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (run_id, tbl) DO NOTHING`,
    [runId, t.tbl, t.policy, t.cutoff, t.considered, t.would_delete, t.deleted, t.days_examined,
      t.days_pending, t.complete, t.total_estimate, t.oldest, t.newest,
      (t.notes || []).join(' · ') || null, t.took_ms ?? null]);
}

/* One pass. `db` is the pool in production (a client is taken from it, so
   the session settings and the advisory lock live on ONE connection) or a
   PGlite instance in the tests, which is one connection already. */
export async function dataRetentionPass({ db = pool, now = new Date(), read = get, budgetMs = BUDGET_MS } = {}) {
  const s = retentionSettings(read);
  const t0 = Date.now();
  const deadline = t0 + budgetMs;
  const c = typeof db.connect === 'function' ? await db.connect() : db;
  const release = () => { if (c !== db) c.release?.(); };
  let runId = null;
  let locked = false;
  try {
    /* A pass the process never finished — a deploy or a restart mid-pass —
       would otherwise read "running" on #settings for ever, a status that is
       not the true one. Two hours is far past any pass's budget (15 minutes,
       then at most a few 120 s statements), so a row still running then is
       one nobody is running. */
    await c.query(`UPDATE retention_run SET status = 'failed', finished_at = coalesce(finished_at, now()),
        error = 'interrupted: the process stopped before this pass finished (a deploy or a restart); '
          || 'every day it finished stays finished and the next pass resumes after them'
      WHERE status = 'running' AND started_at < now() - interval '2 hours'`);
    const started = await c.query(
      `INSERT INTO retention_run (mode, settings) VALUES ($1, $2::text::jsonb) RETURNING id`, [s.mode, JSON.stringify(s)]);
    runId = rowsOf(started)[0]?.id;
    if (s.mode === 'off') {
      await c.query(`UPDATE retention_run SET status = 'skipped', finished_at = now(), took_ms = $2,
        error = 'RETENTION_MODE is off' WHERE id = $1`, [runId, Date.now() - t0]);
      return { run_id: runId, mode: s.mode, status: 'skipped', tables: [] };
    }
    locked = Boolean(rowsOf(await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]))[0]?.ok);
    if (!locked) {
      await c.query(`UPDATE retention_run SET status = 'skipped', finished_at = now(), took_ms = $2,
        error = 'another retention pass holds the lock' WHERE id = $1`, [runId, Date.now() - t0]);
      return { run_id: runId, mode: s.mode, status: 'skipped', tables: [] };
    }
    await c.query("SELECT set_config('lock_timeout', '3s', false), set_config('statement_timeout', '120s', false)");

    const tables = [];
    let failed = 0;
    const step = async (name, fn) => {
      const t1 = Date.now();
      try {
        const r = await fn();
        r.took_ms = Date.now() - t1;
        tables.push(r);
      } catch (e) {
        failed += 1;
        tables.push({ tbl: name, policy: 'failed', considered: null, would_delete: null, deleted: 0,
          complete: false, notes: [`failed: ${String(e?.message || e).slice(0, 300)}`], took_ms: Date.now() - t1 });
        log.error('retention', `${name} failed`, { err: String(e?.message || e).slice(0, 200) });
      }
    };
    await step('telemetry_snapshot', async () => {
      const r = await thinTelemetry(c, s, { runId, now, deadline });
      /* The duplicate index v115 could not drop for want of a lock is retried
         here, at a quiet minute. It is the migration's step, not a data
         change, so it runs whatever the mode. */
      const idx = rowsOf(await c.query(
        `SELECT CASE WHEN to_regproc('retention_drop_duplicate_index') IS NULL THEN NULL
                     ELSE retention_drop_duplicate_index('telem_plate_time_idx', 'telemetry_plate_captured_idx') END AS r`))[0]?.r;
      if (idx && !/^nothing to do/.test(idx)) r.notes.push(`duplicate index: ${idx}`);
      return r;
    });
    await step('alert', () => alertPolicy(c, s, { runId, now, deadline }));
    for (const k of KEPT) await step(k.tbl, () => keptTable(c, k));

    for (const t of tables) await recordTable(c, runId, t);
    const partial = tables.some((t) => t.complete === false);
    const status = failed ? (failed === tables.length ? 'failed' : 'partial') : partial ? 'partial' : 'ok';
    await c.query(`UPDATE retention_run SET status = $2, finished_at = now(), took_ms = $3 WHERE id = $1`,
      [runId, status, Date.now() - t0]);
    const sum = (k) => tables.reduce((a, t) => a + (Number(t[k]) || 0), 0);
    log.info('retention', 'pass finished', { run: runId, mode: s.mode, status,
      considered: sum('considered'), would_delete: sum('would_delete'), deleted: sum('deleted'),
      ms: Date.now() - t0 });
    return { run_id: runId, mode: s.mode, status, tables };
  } catch (e) {
    log.error('retention', 'pass failed', { err: String(e?.message || e).slice(0, 200) });
    if (runId) {
      await c.query(`UPDATE retention_run SET status = 'failed', finished_at = now(), took_ms = $2, error = $3
        WHERE id = $1`, [runId, Date.now() - t0, String(e?.message || e).slice(0, 500)]).catch(() => {});
    }
    return { run_id: runId, mode: s.mode, status: 'failed', error: String(e?.message || e), tables: [] };
  } finally {
    await c.query('RESET lock_timeout').catch(() => {});
    await c.query('RESET statement_timeout').catch(() => {});
    if (locked) await c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    release();
  }
}
