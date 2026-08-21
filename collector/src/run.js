// Shared runner: fan out a window to every historical source.
import * as fms from './sources/fms.js';
import * as uber from './sources/uber.js';
import * as yango from './sources/yango.js';
import * as bolt from './sources/bolt.js';
import * as cabman from './sources/cabman.js';
import { config } from './config.js';
import { monthsAgo, daysAgo } from './util.js';
import { setState } from './db.js';
import { log } from './log.js';

const HISTORICAL = { fms, uber, yango, bolt };

export async function runWindow(mode, from, to) {
  log.info('run', `${mode} ${from.toISOString().slice(0, 10)}..${to.toISOString().slice(0, 10)}`);
  for (const [name, mod] of Object.entries(HISTORICAL)) {
    try { await mod.collect({ from, to, mode }); }
    catch (e) { log.error('run', `${name} threw`, { err: String(e) }); }
  }
  // CABMAN is realtime-only — capture one snapshot per run too
  try { await cabman.collect({ mode: 'realtime' }); } catch (e) { log.error('run', 'cabman', { err: String(e) }); }
  await setState('collector', '-', 'last_' + mode, new Date().toISOString());
}

export const backfill = () => runWindow('backfill', monthsAgo(config.backfillMonths), new Date());
export const incremental = () => runWindow('incremental', daysAgo(config.incrementalDays), new Date());

// Fast realtime pollers (positions / live status only)
export async function realtimeTick() {
  const jobs = [cabman.pullLive(), uber.pullLive(), ...config.fms.fleets.map((f) => fms.pullLive(f))];
  const res = await Promise.allSettled(jobs);
  const n = res.filter((r) => r.status === 'fulfilled').reduce((a, r) => a + (r.value || 0), 0);
  log.info('realtime', 'tick', { snapshots: n });
}
