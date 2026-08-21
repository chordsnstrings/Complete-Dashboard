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
import { config, loadSettings } from './config.js';
import { monthsAgo, daysAgo } from './util.js';
import { setState } from './db.js';
import { log } from './log.js';

const HISTORICAL = { fms, uber, uberFleet, yango, bolt, hotel, external, events };

export async function runWindow(mode, from, to) {
  await loadSettings(true);   // pick up Settings-page credential changes without a redeploy
  log.info('run', `${mode} ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
  for (const [name, mod] of Object.entries(HISTORICAL)) {
    try { await mod.collect({ from, to, mode }); }
    catch (e) { log.error('run', `${name} threw`, { err: String(e) }); }
  }
  // CABMAN is not part of the historical window — it runs on its own 5-minute schedule.
  // Once bookings are in, reconcile seat-sensor occupancy against them (unauthorized trips).
  try { await reconcile({ from, to }); } catch (e) { log.error('run', 'reconcile', { err: String(e) }); }
  // Derive who was driving which vehicle each day, so vehicle facts can name a person.
  try {
    await rebuildCustody({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  } catch (e) { log.error('run', 'custody', { err: String(e) }); }
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

export const backfill = () => runWindow('backfill', monthsAgo(config.backfillMonths), new Date());
export const incremental = () => runWindow('incremental', daysAgo(config.incrementalDays), new Date());

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
