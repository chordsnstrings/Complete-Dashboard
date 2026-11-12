/* The data-retention pass (src/data_retention.js), on a real Postgres (PGlite).
   ═════════════════════════════════════════════════════════════════════════
   What has to be true for a pass that DELETES rows to be safe to schedule:

     1. by default it removes nothing — dry_run counts, and says what it would
        remove, to the row;
     2. thinning keeps exactly the fixes the rules name — the first of each
        15-minute bucket, every change of ignition / seat / seat count /
        status / moving, each day's last fix — and nothing else goes;
     3. it never reaches inside the weekly backfill's window, whatever the
        setting says (reconcile re-derives occupancy segments from those
        fixes), never touches uber status rows, never touches alerts unless
        the operator opted in, and then never inside 365 days;
     4. it works in short statements (LIMIT per DELETE), resumes from its own
        boundary, and a second pass over finished days does nothing;
     5. every pass is recorded per table, and only a pass that removed rows
        for real moves the boundary pages read.

   REVERSION (each proved by hand on 2026-11-12, see FIX-STATUS RET):
     · drop `OR lead(id) OVER w IS NULL` from KEEP_SQL — "steady FMS at 30 s
       keeps … its last (13 of 360)" fails (12), and the would-remove count
       with it (P1's last fix survives anyway: it opens the 09:00 bucket);
     · drop the seat_count line — "a change of seat count is kept" fails;
     · make telemetryCutoff use `asked` instead of the earlier day — "asking
       for 1 day is held back" and "nothing inside the weekly backfill
       window" fail;
     · let the boundary be written in dry_run — "a dry run moves no
       boundary" fails. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { dataRetentionPass, retentionSettings, telemetryCutoff, alertCutoff, KEEP_SQL }
  from '../src/data_retention.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const NOW = new Date('2026-11-12T03:00:00Z');
const db = new PGlite();
await applySchema(db);
const rows = async (s, p) => (await db.query(s, p)).rows;
const one = async (s, p) => (await rows(s, p))[0];
const settings = (over = {}) => (k, d) => (k in over ? over[k] : d);

console.log('\n1. the settings and the horizon');
{
  const s = retentionSettings(settings());
  check('defaults: dry_run, positions past 400 days, alerts kept, 5,000 rows a statement',
    s.mode === 'dry_run' && s.telemetry_days === 400 && s.alert_days === 0 && s.batch === 5000, JSON.stringify(s));
  const odd = retentionSettings(settings({ RETENTION_MODE: 'yes please' }));
  check('an unknown mode reads as dry_run and keeps what was asked', odd.mode === 'dry_run' && odd.mode_asked === 'yes please');
  const al = retentionSettings(settings({ RETENTION_ALERT_DAYS: '30' }));
  check('alerts can never be asked below 365 days', al.alert_days === 365 && al.alert_days_asked === 30);
  check('RETENTION_TELEMETRY_DAYS 0 means never thin', telemetryCutoff({ now: NOW, telemetry_days: 0, backfill_months: 12 }) === null);
  const def = telemetryCutoff({ now: NOW, telemetry_days: 400, backfill_months: 12 });
  check('400 days back from 2026-11-12 (Dubai) is 2025-10-08, already past the backfill floor',
    def.day === '2025-10-08' && !def.floored && def.floor === '2025-11-05', JSON.stringify(def));
  check('the boundary is a Dubai midnight', def.cutoff.toISOString() === '2025-10-07T20:00:00.000Z');
  const tight = telemetryCutoff({ now: NOW, telemetry_days: 1, backfill_months: 12 });
  check('asking for 1 day is held back to a week before the 12-month backfill window',
    tight.day === '2025-11-05' && tight.floored, JSON.stringify(tight));
  check('alerts kept for ever by default: no alert horizon', alertCutoff({ now: NOW, alert_days: 0 }) === null);
}

/* ── the fixture ─────────────────────────────────────────────────────────
   P1 (fms), 2025-09-01 08:00-09:00 Dubai, a fix every 2 minutes, k = 0..30:
   moving (40 km/h) for k 6..20, one passenger (seat_count 1) for k 10..20.
   The rules keep exactly k = 0 (first), 6 (starts moving), 8 (first of the
   08:15 bucket), 10 (passenger aboard), 15 (08:30 bucket), 21 (stops, seat
   empties), 23 (08:45 bucket), 30 (09:00 bucket and the day's last). */
/* A Dubai wall-clock instant; minutes may run past 59 (k = 30 is 08:60). */
const at = (day, hh, mm, ss = 0) => new Date(Date.parse(`${day}T00:00:00+04:00`) + ((hh * 60 + mm) * 60 + ss) * 1000);
const ins = async (r) => db.query(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, lat, lng, speed, ignition, seat_occupied, seat_count, status)
   VALUES ($1, 'ecosine', $2, $3, 25.2, 55.3, $4, $5, $6, $7, $8)`,
  [r.source || 'fms', r.plate, r.at, r.speed ?? 0, r.ignition ?? true, r.seat ?? null, r.seat_count ?? null, r.status ?? null]);
const P1_KEEP = [0, 6, 8, 10, 15, 21, 23, 30];
for (let k = 0; k <= 30; k++) {
  await ins({ plate: 'P1', at: at('2025-09-01', 8, 2 * k), speed: k >= 6 && k <= 20 ? 40 : 0,
    seat_count: k >= 10 && k <= 20 ? 1 : 0 });
}
// P2 (cabman), same day, steady state, every 5 min 10:00-11:00: bucket firsts 10:00 10:15 10:30 10:45 11:00
for (let k = 0; k <= 12; k++) await ins({ source: 'cabman', plate: 'P2', at: at('2025-09-01', 10, 5 * k), seat: false });
// P1 again on 2025-09-02: one fix, which is its day's first and last
await ins({ plate: 'P1', at: at('2025-09-02', 12, 0) });
// P4 (fms), 2025-09-03, every 30 s for three hours, steady: 12 bucket firsts + the last = 13 kept of 360
for (let k = 0; k < 360; k++) await ins({ plate: 'P4', at: new Date(at('2025-09-03', 12, 0).getTime() + k * 30e3) });
// a dormant CABMAN unit's last fix from 2024 — the plate's only position
await ins({ source: 'cabman', plate: 'P3', at: at('2024-04-16', 15, 4) });
// uber status rows on a thinnable day: events, never thinned
for (let k = 0; k < 10; k++) await ins({ source: 'uber', plate: 'P1', at: at('2025-09-01', 8, 1 + 2 * k), status: k % 2 ? 'ONLINE' : 'OFFLINE' });
// between the 400-day horizon (2025-10-08) and the backfill floor (2025-11-05)
for (let k = 0; k <= 12; k++) await ins({ source: 'cabman', plate: 'P2', at: at('2025-10-20', 10, 5 * k), seat: false });
// inside the backfill window, and recent
for (let k = 0; k <= 12; k++) await ins({ source: 'cabman', plate: 'P2', at: at('2026-01-15', 10, 5 * k), seat: false });
for (let k = 0; k <= 30; k++) await ins({ plate: 'P1', at: at('2026-11-01', 8, 2 * k) });
const TOTAL = Number((await one('SELECT count(*)::int AS n FROM telemetry_snapshot')).n);
await db.query(`INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status)
  VALUES ('uber', 'ecosine', 'd1', '2026-08-16T05:00:00Z', 'status', 'ONLINE')`);

console.log('\n2. a dry run (the default) counts to the row and removes nothing');
{
  const r = await dataRetentionPass({ db, now: NOW, read: settings() });
  const t = r.tables.find((x) => x.tbl === 'telemetry_snapshot');
  check('the pass is recorded as a dry run that finished', r.mode === 'dry_run' && r.status === 'ok', JSON.stringify({ s: r.status, e: r.error }));
  /* 31 + 13 (09-01) + 1 (09-02) + 360 (09-03) + 1 (2024): uber rows are not tracker rows. */
  check('considered: every tracker fix past the horizon, and nothing else', t.considered === 406, String(t.considered));
  check('would remove: 23 + 8 on 09-01 and 347 on 09-03', t.would_delete === 23 + 8 + 347, String(t.would_delete));
  check('removed: nothing', t.deleted === 0 && Number((await one('SELECT count(*)::int AS n FROM telemetry_snapshot')).n) === TOTAL);
  check('a dry run moves no boundary', !(await one(`SELECT 1 AS x FROM retention_state`)));
  const rec = await rows('SELECT tbl, policy, considered, would_delete, deleted FROM retention_run_table WHERE run_id = $1 ORDER BY tbl', [r.run_id]);
  check('one record per table: telemetry, alert, timeline, trip, collection_run',
    rec.map((x) => x.tbl).join(',') === 'alert,collection_run,driver_timeline_event,telemetry_snapshot,trip', rec.map((x) => x.tbl).join(','));
  check('alerts are kept by default and the record says so',
    rec.find((x) => x.tbl === 'alert').policy === 'keep' && Number(rec.find((x) => x.tbl === 'alert').deleted) === 0);
  const tl = r.tables.find((x) => x.tbl === 'driver_timeline_event');
  check('the timeline is measured and kept, with the reason', tl.policy === 'keep' && /full rollup/.test(tl.notes.join(' '))
    && tl.oldest && new Date(tl.oldest).toISOString() === '2026-08-16T05:00:00.000Z');
}

console.log('\n3. "on": exactly the fixes the rules name survive, in short statements');
{
  let deletes = 0;
  const counting = { query: (s, p) => { if (/DELETE FROM telemetry_snapshot/.test(s)) deletes += 1; return db.query(s, p); } };
  const r = await dataRetentionPass({ db: counting, now: NOW, read: settings({ RETENTION_MODE: 'on', RETENTION_BATCH: '100' }) });
  const t = r.tables.find((x) => x.tbl === 'telemetry_snapshot');
  check('removed exactly what the dry run said it would', t.deleted === 378 && t.would_delete === 378, `${t.deleted}/${t.would_delete}`);
  check('at most RETENTION_BATCH rows per statement: 347 doomed on 09-03 took four, 31 on 09-01 one', deletes === 5, String(deletes));
  const p1 = (await rows(`SELECT captured_at FROM telemetry_snapshot WHERE plate = 'P1' AND source = 'fms'
      AND captured_at >= $1 AND captured_at < $2 ORDER BY captured_at`, [at('2025-09-01', 0, 0), at('2025-09-02', 0, 0)]))
    .map((x) => Math.round((new Date(x.captured_at) - at('2025-09-01', 8, 0)) / 120e3));
  check('P1 keeps the first fix of each 15-minute bucket, every change, and its last', p1.join() === P1_KEEP.join(), p1.join());
  check('a change of seat count is kept (k = 10, the passenger boards mid-bucket)', p1.includes(10));
  check('a change of moving is kept (k = 6 and 21)', p1.includes(6) && p1.includes(21));
  check('each day\'s last fix is kept (k = 30)', p1.includes(30));
  const p2 = (await one(`SELECT count(*)::int AS n FROM telemetry_snapshot WHERE plate = 'P2'
      AND captured_at >= $1 AND captured_at < $2`, [at('2025-09-01', 0, 0), at('2025-09-02', 0, 0)])).n;
  check('steady CABMAN keeps one fix per quarter hour (5 of 13)', Number(p2) === 5, String(p2));
  const p4 = (await one(`SELECT count(*)::int AS n FROM telemetry_snapshot WHERE plate = 'P4'`)).n;
  check('steady FMS at 30 s keeps 12 quarter-hour firsts and its last (13 of 360)', Number(p4) === 13, String(p4));
  check('a lone fix and a dormant unit\'s only position are kept',
    Number((await one(`SELECT count(*)::int AS n FROM telemetry_snapshot WHERE plate IN ('P3') OR (plate = 'P1' AND captured_at = $1)`,
      [at('2025-09-02', 12, 0)])).n) === 2);
  check('uber status rows on a thinned day are untouched (10 of 10)',
    Number((await one(`SELECT count(*)::int AS n FROM telemetry_snapshot WHERE source = 'uber'`)).n) === 10);
  check('nothing inside the 400-day horizon is touched (2025-10-20, 2026-01-15, 2026-11-01)',
    Number((await one(`SELECT count(*)::int AS n FROM telemetry_snapshot WHERE captured_at >= $1`, [at('2025-10-08', 0, 0)])).n) === 13 + 13 + 31);
  const st = await one(`SELECT action, done_before, bucket_min FROM retention_state WHERE tbl = 'telemetry_snapshot'`);
  check('the boundary moves to the end of the last day finished (2025-09-04, Dubai)',
    st && st.action === 'thinned' && new Date(st.done_before).toISOString() === at('2025-09-04', 0, 0).toISOString() && st.bucket_min === 15,
    JSON.stringify(st));
  const again = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_MODE: 'on', RETENTION_BATCH: '100' }) });
  const t2 = again.tables.find((x) => x.tbl === 'telemetry_snapshot');
  check('a second pass resumes past its boundary and does nothing', t2.considered === 0 && t2.deleted === 0, JSON.stringify(t2));
  /* The keep rule, recomputed over what survived, dooms nothing: the
     survivors are a fixed point, which is what makes LIMIT-batching safe. */
  const fixed = await one(`WITH f AS (${KEEP_SQL()}) SELECT count(*) FILTER (WHERE NOT keep)::int AS n FROM f`,
    [at('2025-09-01', 0, 0), at('2025-09-04', 0, 0), ['cabman', 'fms']]);
  check('the survivors are a fixed point of the rule', Number(fixed.n) === 0, String(fixed.n));
}

console.log('\n4. the floor holds whatever the setting says');
{
  const r = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_MODE: 'on', RETENTION_TELEMETRY_DAYS: '1' }) });
  const t = r.tables.find((x) => x.tbl === 'telemetry_snapshot');
  check('asking for 1 day thins 2025-10-20 (past the floor) and says it was held back',
    t.deleted === 8 && /floored to 2025-11-05/.test(t.notes.join(' ')), JSON.stringify({ d: t.deleted, n: t.notes }));
  check('and nothing inside the weekly backfill window: 2026-01-15 and 2026-11-01 keep every fix',
    Number((await one(`SELECT count(*)::int AS n FROM telemetry_snapshot WHERE captured_at >= $1`, [at('2025-11-05', 0, 0)])).n) === 13 + 31);
  const w = await dataRetentionPass({ db, now: NOW, read: settings({ BACKFILL_MONTHS: '36' }) });
  const tw = w.tables.find((x) => x.tbl === 'telemetry_snapshot');
  check('raising BACKFILL_MONTHS past thinned days is said on the record, every pass',
    /WARNING: telemetry before 2025-10-21 is already thinned/.test(tw.notes.join(' ')), tw.notes.join(' | '));
}

console.log('\n5. alerts: kept unless opted in, and then never inside 365 days');
{
  const a = (id, t) => db.query(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
    VALUES ('fms', $1, 'ecosine', 'P1', 'Harsh Brake', $2)`, [id, t]);
  await a('old1', '2025-06-01T10:00:00Z'); await a('old2', '2025-06-02T10:00:00Z'); await a('old3', '2025-11-01T10:00:00Z');
  await a('new1', '2026-10-01T10:00:00Z'); await a('new2', '2026-10-02T10:00:00Z');
  await db.query(`INSERT INTO alert (platform, external_id, plate, alert_type) VALUES ('fms', 'undated', 'P1', 'OverSpeed')`);
  const keep = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_MODE: 'on' }) });
  check('with RETENTION_ALERT_DAYS unset an "on" pass removes no alert',
    keep.tables.find((x) => x.tbl === 'alert').deleted === 0 && Number((await one('SELECT count(*)::int AS n FROM alert')).n) === 6);
  const dry = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_ALERT_DAYS: '30' }) });
  const ta = dry.tables.find((x) => x.tbl === 'alert');
  check('asked for 30 days, a dry run counts the alerts older than 365 (three) and removes none',
    ta.policy === 'remove' && ta.would_delete === 3 && ta.deleted === 0 && /floored to 365/.test(ta.notes.join(' ')),
    JSON.stringify({ w: ta.would_delete, n: ta.notes }));
  const on = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_MODE: 'on', RETENTION_ALERT_DAYS: '30' }) });
  check('"on" removes those three and keeps the newer and the undated',
    on.tables.find((x) => x.tbl === 'alert').deleted === 3
    && (await rows('SELECT external_id FROM alert ORDER BY 1')).map((x) => x.external_id).join() === 'new1,new2,undated');
  const st = await one(`SELECT action, done_before FROM retention_state WHERE tbl = 'alert'`);
  check('and the alert boundary is the 365-day cutoff (2025-11-12 Dubai)',
    st?.action === 'removed' && new Date(st.done_before).toISOString() === at('2025-11-12', 0, 0).toISOString(), JSON.stringify(st));
}

console.log('\n6. off, and a pass cut short');
{
  const off = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_MODE: 'off' }) });
  const rec = await one('SELECT status, error FROM retention_run WHERE id = $1', [off.run_id]);
  check('"off" is recorded as skipped, with the reason', off.status === 'skipped' && rec.status === 'skipped' && /off/.test(rec.error));
  await ins({ plate: 'P9', at: at('2025-08-01', 9, 0) }); await ins({ plate: 'P9', at: at('2025-08-01', 9, 1) });
  await db.query(`DELETE FROM retention_state WHERE tbl = 'telemetry_snapshot'`);
  const cut = await dataRetentionPass({ db, now: NOW, read: settings({ RETENTION_MODE: 'on' }), budgetMs: -1 });
  const tc = cut.tables.find((x) => x.tbl === 'telemetry_snapshot');
  check('out of time before the first day: partial, nothing removed, the days left are counted',
    cut.status === 'partial' && tc.complete === false && tc.deleted === 0 && tc.days_pending >= 1, JSON.stringify(tc));
  check('and the boundary did not move', !(await one(`SELECT 1 AS x FROM retention_state WHERE tbl = 'telemetry_snapshot'`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
