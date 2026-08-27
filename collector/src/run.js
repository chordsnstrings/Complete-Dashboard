// Shared runner: fan out a window to every historical source.
import * as fms from './sources/fms.js';
import * as uber from './sources/uber.js';
import * as uberFleet from './sources/uber_fleet.js';
import * as uberTimeline from './sources/uber_timeline.js';
import * as yango from './sources/yango.js';
import * as bolt from './sources/bolt.js';
import * as cabman from './sources/cabman.js';
import * as hotel from './sources/hotel.js';
import * as external from './sources/external.js';
import * as events from './sources/events.js';
import { reconcile } from './reconcile.js';
import { computeInsights } from './insights.js';
import { runAnalyst } from './analyst.js';
import { probeAll } from './probe.js';
import { rebuildCustody } from './custody.js';
import { refreshRollups } from './rollup.js';
import { config, loadSettings } from './config.js';
import { monthsAgo, daysAgo } from './util.js';
import { setState, pool } from './db.js';
import { log } from './log.js';

/* Order matters, and it took a live diagnosis to see why.
   ──────────────────────────────────────────────────────────────────────────
   FMS was first in this object, and an FMS year backfill takes four and a half
   hours — it walks 130 vehicles through twelve monthly windows of five-minute
   telematics. Uber came second. This deployment restarts the container on every
   push, and a restart requeues the running job from the top, so in practice the
   backfill re-ran four hours of FMS on every deploy and reached Uber on none of
   them. The 299-day Uber hole the backfill exists to fill survived weeks of
   attempts, each of which reported no failure at all, because the step that
   would have filled it was never reached.

   So the order is by outstanding need and cost, cheapest and most-broken first:
   Uber has the largest hole and its windows are report-pull requests that cost
   minutes; FMS has the most rows already and by far the longest run, so it goes
   last where being cut short costs the least. */
const HISTORICAL = { uber, uberFleet, yango, bolt, hotel, external, events, fms };

/* Only one historical collection at a time.
   The scheduler runs an incremental every thirty minutes and an on-demand
   backfill can be queued at any point, so the two overlapped routinely — and
   both call the Uber report pipeline, which the provider caps at three reports
   in flight per org. A backfill working through twelve monthly windows was
   competing with an incremental for the same three slots, and an abandoned
   report keeps its slot, so the long job lost windows to the short one.

   A queued run waits rather than being dropped: skipping it silently is how a
   collection gap opens without anything saying so. */
let inFlight = null;
export async function runWindow(mode, from, to, onProgress, fleet = null) {
  if (inFlight) {
    log.info('run', `${mode} waiting — another collection is in flight`);
    await inFlight.catch(() => {});
  }
  let release;
  inFlight = new Promise((r) => { release = r; });
  try { return await runWindowInner(mode, from, to, onProgress, fleet); }
  finally { release(); inFlight = null; }
}

async function runWindowInner(mode, from, to, onProgress, fleet = null) {
  await loadSettings(true);   // pick up Settings-page credential changes without a redeploy
  log.info('run', `${mode} ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
  const names = Object.keys(HISTORICAL);
  let done = 0;
  for (const [name, mod] of Object.entries(HISTORICAL)) {
    /* Say which source is in flight BEFORE running it. A four-hour step that
       reports only on completion is indistinguishable from a hung process, and
       that ambiguity is exactly what hid this bug: the job sat at 'running' for
       hours and nothing anywhere said which of the eight sources it was on. */
    await onProgress?.({ current: name, done, total: names.length, remaining: names.slice(done + 1) });
    /* Sources that walk many windows report each one. `steps` is what makes a
       long single source distinguishable from a wedged one — and what lets the
       boot requeue tell an advancing job from a stuck one, which per-source
       progress alone could not: Uber and FMS each take hours, so `done` sat at
       the same number across three restarts of a run that was landing tens of
       thousands of rows. Sources that do not walk windows simply ignore the
       extra key. */
    let steps = 0;
    const onStep = (st) => {
      steps++;
      return onProgress?.({ current: name, done, total: names.length,
        remaining: names.slice(done + 1), step: st, steps });
    };
    /* `fleet` reaches the sources that serve more than one business — Uber is
       two separate Uber orgs with separate credentials — so a run can be
       narrowed to the fleet whose credential was just replaced instead of
       re-pulling both. A source that serves one fleet ignores the key. */
    try { await mod.collect({ from, to, mode, onStep, fleet }); }
    catch (e) { log.error('run', `${name} threw`, { err: String(e) }); }
    done++;
    log.info('run', `${mode} ${name} finished`, { done, of: names.length });
  }
  await onProgress?.({ current: null, done, total: names.length, remaining: [] });
  // CABMAN is not part of the historical window — it runs on its own 5-minute schedule.
  // Once bookings are in, reconcile seat-sensor occupancy against them (unauthorized trips).
  try { await reconcile({ from, to }); } catch (e) { log.error('run', 'reconcile', { err: String(e) }); }
  // Derive who was driving which vehicle each day, so vehicle facts can name a person.
  try {
    await rebuildCustody({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  } catch (e) { log.error('run', 'custody', { err: String(e) }); }
  /* Precompute the aggregates that have no window. /api/trend/monthly,
     /api/forecast and /api/retention each group the ENTIRE trip history, so
     nothing about a request can narrow them — but the answer is the same for
     every viewer and only changes here, when new trips land. Rolling them up
     now is what turns those pages from seconds into milliseconds.

     Before insights, because insights reads aggregates too and there is no
     reason for it to recompute what was just materialised. */
  try {
    /* The run's own window, widened. A backfill rewrites a year and must roll
       up a year; an incremental touches days and need only roll up days. */
    const spanDays = Math.ceil((to - from) / 864e5) + 3;
    await refreshRollups({ days: mode === 'backfill' ? null : spanDays });
  } catch (e) { log.error('run', 'rollup', { err: String(e) }); }
  // Turn the freshly-landed data into ranked, actionable findings.
  try {
    await computeInsights({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  } catch (e) { log.error('run', 'insights', { err: String(e) }); }
  await setState('collector', '-', 'last_' + mode, new Date().toISOString());
}

/* One analyst pass: build a brief of aggregates, ask the model for testable
   claims, measure each against the rest of the fleet, keep the verdicts. Runs
   on its own daily schedule rather than inside runWindow, because it costs a
   model call and its input barely moves between two afternoons. */
export async function analystPass({ days = 30 } = {}) {
  await loadSettings(true);
  const to = new Date();
  const from = daysAgo(days);
  const iso = (d) => d.toISOString().slice(0, 10);
  try {
    const r = await runAnalyst({ from: iso(from), to: iso(to) });
    log.info('analyst', 'pass complete', {
      run: r.run_id, proposed: r.proposed,
      confirmed: r.findings.filter((f) => f.verdict === 'confirmed').length,
      refuted: r.findings.filter((f) => f.verdict === 'refuted').length,
      immaterial: r.findings.filter((f) => f.verdict === 'immaterial').length,
    });
    return r;
  } catch (e) {
    /* Recorded, not just logged. This caught, logged and returned null, so a
       pass that could not reach the model left no trace any page could read —
       and production spent its nights in exactly that state while the Action
       list reported the analyst as quiet. The row is best-effort: a pass that
       failed because the database is unreachable cannot write it, and that is
       the one case where the log is all there is. */
    const err = String(e?.message || e).slice(0, 400);
    log.error('analyst', 'pass failed', { err });
    await pool.query(
      `INSERT INTO analyst_run (run_id, window_start, window_end, outcome, error, finished_at)
       VALUES ($1,$2,$3,'failed',$4, now()) ON CONFLICT (run_id) DO UPDATE
         SET outcome='failed', error=EXCLUDED.error, finished_at=now()`,
      [`an-${Date.now()}`, iso(from), iso(to), err])
      .catch(() => {});
    return null;
  }
}

/* Describe every provider surface the collectors call, so "what else could we
   be collecting" is answerable from evidence rather than from memory. Cheap —
   one small request per surface — but it runs on its own schedule rather than
   inside runWindow, because a failing probe must never be able to delay or
   fail a collection. */
export async function probePass() {
  try { return await probeAll({ days: 3 }); }
  catch (e) { log.error('probe', 'pass failed', { err: String(e) }); return null; }
}

/* `fleet` narrows a run to one business. The two fleets are separate accounts
   with separate credentials on the same providers, and the reason to run one
   alone is almost always the same: a credential was just replaced and the
   operator wants to know whether it works, without waiting out a full pass
   over the fleet that was already fine. */
export const backfill = (onProgress, fleet = null) =>
  runWindow('backfill', monthsAgo(config.backfillMonths), new Date(), onProgress, fleet);
export const incremental = (onProgress, fleet = null) =>
  runWindow('incremental', daysAgo(config.incrementalDays), new Date(), onProgress, fleet);

/* ── the catch-up ──────────────────────────────────────────────────────────
   The incremental window is three days and it runs every half hour. Nothing
   else revisits anything, and until now a backfill only ran when a person
   triggered one — so any day that failed to collect, or that a provider
   finalised late, stayed wrong until somebody noticed and asked.

   That is not hypothetical here. Uber settles driver earnings weekly, which is
   longer than the window that would pick them up. FMS is silent on 154 of the
   last 366 days. A collection gap in this product has never been self-healing;
   it has been waiting to be found.

   So the window is re-walked on a schedule. Thirty days nightly is wide enough
   for any provider's settlement lag and cheap enough to run unattended;
   the full history weekly, because a re-collection that only ever looks at the
   last month cannot repair the year behind it.

   Every write is an upsert keyed on the provider's own id, so re-collecting a
   day that is already correct changes nothing — which is what makes running
   this on a timer safe rather than merely convenient. */
export const catchUp = (days = 30, onProgress, fleet = null) =>
  runWindow('catchup', daysAgo(days), new Date(), onProgress, fleet);

// CABMAN realtime GPS — fixed 5-minute refresh, persisted to telemetry_snapshot (via cabman.collect,
// which upserts snapshots and writes a collection_run row). This is the owner of CABMAN data.
export async function cabmanTick() {
  try { await loadSettings(); await cabman.collect({ mode: 'realtime' }); }
  catch (e) { log.error('cabman', 'tick failed', { err: String(e) }); }
}

/* Uber driver availability — its own tick, not a step in the incremental.
   ─────────────────────────────────────────────────────────────────────────
   Deliberately outside HISTORICAL. This costs one request per driver per
   window, and the backfill's whole design note above is about a long step
   starving the ones behind it — putting a 2,600-request source in front of FMS
   would recreate exactly that. It also must not ride the thirty-minute
   incremental: ~74 working drivers a run is ten thousand requests a day at a
   surface nobody has asked for more than a few hundred from.

   The window is deliberately wider than the cadence. A driver's evening
   straddles midnight, a missed tick must cost nothing, and re-asking is
   idempotent — the rows are keyed on (driver, instant, kind, state). */
export async function uberTimelineTick({ roster = false, days = 2 } = {}) {
  await loadSettings();
  try {
    const to = new Date();
    const from = daysAgo(days);
    const n = await uberTimeline.collect({ from, to, mode: roster ? 'roster' : 'timeline', roster });
    log.info('uber', 'timeline tick', { rows: n, days, roster });
    return n;
  } catch (e) {
    log.error('uber', 'timeline tick failed', { err: String(e) });
    return 0;
  }
}

// Other live pollers (Uber online/on-trip status, FMS live telemetry).
export async function liveStatusTick() {
  await loadSettings();
  const jobs = [uber.pullLive().catch(() => 0), ...config.fms.fleets.map((f) => fms.pullLive(f).catch(() => 0))];
  const res = await Promise.allSettled(jobs);
  const n = res.reduce((a, r) => a + (r.status === 'fulfilled' ? (r.value || 0) : 0), 0);
  log.info('live', 'status tick', { snapshots: n });
}
