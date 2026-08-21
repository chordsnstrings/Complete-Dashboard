// Shared runner: fan out a window to every historical source.
import * as fms from './sources/fms.js';
import * as uber from './sources/uber.js';
import * as yango from './sources/yango.js';
import * as bolt from './sources/bolt.js';
import * as cabman from './sources/cabman.js';
import * as hotel from './sources/hotel.js';
import * as external from './sources/external.js';
import * as events from './sources/events.js';
import { reconcile } from './reconcile.js';
import { computeInsights } from './insights.js';
import { config, loadSettings } from './config.js';
import { monthsAgo, daysAgo } from './util.js';
import { setState } from './db.js';
import { log } from './log.js';

const HISTORICAL = { fms, uber, yango, bolt, hotel, external, events };

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
  // Turn the freshly-landed data into ranked, actionable findings.
  try {
    await computeInsights({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
  } catch (e) { log.error('run', 'insights', { err: String(e) }); }
  await setState('collector', '-', 'last_' + mode, new Date().toISOString());
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
