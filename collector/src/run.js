// Shared runner: fan out a window to every historical source.
import * as fms from './sources/fms.js';
import * as uber from './sources/uber.js';
import * as uberFleet from './sources/uber_fleet.js';
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
import { setState } from './db.js';
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
export async function runWindow(mode, from, to, onProgress) {
  if (inFlight) {
    log.info('run', `${mode} waiting — another collection is in flight`);
    await inFlight.catch(() => {});
  }
  let release;
  inFlight = new Promise((r) => { release = r; });
  try { return await runWindowInner(mode, from, to, onProgress); }
  finally { release(); inFlight = null; }
}

async function runWindowInner(mode, from, to, onProgress) {
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
    try { await mod.collect({ from, to, mode, onStep }); }
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
  } catch (e) { log.error('analyst', 'pass failed', { err: String(e) }); return null; }
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

export const backfill = (onProgress) =>
  runWindow('backfill', monthsAgo(config.backfillMonths), new Date(), onProgress);
export const incremental = (onProgress) =>
  runWindow('incremental', daysAgo(config.incrementalDays), new Date(), onProgress);

// CABMAN realtime GPS — fixed 5-minute refresh, persisted to telemetry_snapshot (via cabman.collect,
// which upserts snapshots and writes a collection_run row). This is the owner of CABMAN data.
export async function cabmanTick() {
  try { await loadSettings(); await cabman.collect({ mode: 'realtime' }); }
  catch (e) { log.error('cabman', 'tick failed', { err: String(e) }); }
}

// Other live pollers (Uber online/on-trip status, FMS live telemetry).
export async function liveStatusTick() {
  await loadSettings();
  const jobs = [uber.pullLive().catch(() => 0), ...config.fms.fleets.map((f) => fms.pullLive(f).catch(() => 0))];
  const res = await Promise.allSettled(jobs);
  const n = res.reduce((a, r) => a + (r.status === 'fulfilled' ? (r.value || 0) : 0), 0);
  log.info('live', 'status tick', { snapshots: n });
}
