// Shared runner: fan out a window to every historical source.
import * as fms from './sources/fms.js';
import * as uber from './sources/uber.js';
import * as uberFleet from './sources/uber_fleet.js';
import * as uberTimeline from './sources/uber_timeline.js';
import * as uberProfile from './sources/uber_profile.js';
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
import { monthsAgo, daysAgo, iso, dubaiIso } from './util.js';
import { setState, pool } from './db.js';
import { log } from './log.js';
import { loadCheckpoint, NO_CHECKPOINT } from './checkpoint.js';

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
/* A QUEUE, not a one-shot gate.
   ─────────────────────────────────────────────────────────────────────────
   This was a single `inFlight` promise that every waiter awaited. Two of them
   waiting therefore woke TOGETHER when it resolved, each overwrote `inFlight`
   with its own, and each ran — concurrently, which is the one thing this
   barrier exists to prevent. A backfill wedged for hours collects one waiting
   incremental every thirty minutes, so the release did not admit one run: it
   admitted all of them at once, into the provider's three-report cap, which is
   the starvation described above arriving through the mechanism written to
   stop it.

   Chaining instead means each run waits for the one actually before it. The
   tail never rejects, so a failed run does not poison the queue behind it. */
let queued = 0;
let tail = Promise.resolve();
export async function runWindow(mode, from, to, onProgress, fleet = null, jobId = null) {
  if (queued) log.info('run', `${mode} waiting — ${queued} collection(s) ahead of it`);
  queued++;
  const run = async () => {
    try { return await runWindowInner(mode, from, to, onProgress, fleet, jobId); }
    finally { queued--; }
  };
  const mine = tail.then(run, run);
  tail = mine.then(() => {}, () => {});
  return mine;
}

/* A pulse on every progress report: how big this process is, and when.
   ─────────────────────────────────────────────────────────────────────────
   Nothing recorded WHY the collector died. Production job 8 (read from
   /api/settings/jobs on 2026-09-02) is a backfill that reached attempts:5 with
   done:0 of 8, current 'uber', and the same step five times over —
   window 2026-01-26..2026-02-25, index 6 of 12, 35,829 rows already landed.
   Its error is the boot requeue's own inference, "the job itself may be
   killing the collector", because collector_job carries no exit code, no
   signal and no memory reading. The one hypothesis that shape suggests —
   pullTrips holds a whole CSV report in memory and then upserts a raw JSONB
   per row — could be neither confirmed nor refuted from the row.

   RSS because that is what an OOM killer measures, and heapUsed beside it
   because a report held as one string moves them differently: heap climbing
   with RSS is JS objects, RSS climbing without heap is buffers and strings
   outside it. Both in megabytes — a byte count read by a person at 2am is a
   number they have to count the digits of.

   It is the WHOLE process, not this job: this worker also runs the
   five-minute CABMAN tick and the half-hourly incremental. That is the right
   figure anyway, because the container is what gets killed.

   ISO, not String(date), which is "Mon Jan 26 2026" — sorts wrong, and parses
   differently in every reader.

   Cost is one process.memoryUsage() per progress report, which fires per
   collection window, i.e. minutes apart. It adds no query: the scheduler
   merges these keys into the write it was already making. */
export function heartbeat(mem = process.memoryUsage(), at = new Date()) {
  const mb = (b) => Math.round((b || 0) / 1048576);
  return { heartbeat_at: at.toISOString(), rss_mb: mb(mem.rss), heap_mb: mb(mem.heapUsed) };
}

/* ── which DAY a run is happening on ──────────────────────────────────────
   Every window in this file arrives as a pair of CLOCKS, never as day anchors:
   `to` is `new Date()` at all three entry points below, and `from` is
   daysAgo()/monthsAgo(), which src/util.js:80-81 build by offsetting
   `new Date()`. Turning a clock into a day with toISOString().slice(0, 10)
   asks UTC what day it is — and the fleet works Dubai time, so between 20:00
   and 24:00 UTC, which is 00:00-04:00 the NEXT day in Dubai, it answers
   yesterday.

   That is not a rare edge here; it is when this file runs. src/index.js:98
   schedules the nightly catch-up at 21:00 UTC, and production /api/status read
   on 2026-09-02 shows its eleven source rows finishing between 21:05:47.209Z
   and 21:09:52.629Z on 2026-09-01 — 01:05 to 01:09 on the 2nd in Dubai — while
   the bounds this function handed rebuildCustody and computeInsights read
   "2026-09-01". So custody was materialised only up to the previous Dubai day
   on every nightly pass: the day in progress had no vehicle_driver_day rows,
   and its harsh-driving events and unauthorised segments could not name a
   driver until the next run. The insight window has the same shape and is
   PRINTED — api/public/app.js:1623 renders "over <start> → <end>" on the
   finding panel — which is why computeInsights in src/insights.js already
   corrected its own fallback window and named THIS call as the one still to
   fix, since it is the only caller in the product and its bounds always win.

   dubaiIso is src/util.js's shared answer, and it takes a clock, which is what
   these are. isoDay() in src/sources/ledger.js is the reference for the OTHER
   half of this bug class — a pg DATE that node-postgres hands back as a Date at
   LOCAL midnight, where reading UTC components shifts it the other way. Nothing
   here comes out of the database: these are instants this process made, so the
   Dubai-offset reading is the correct one and isoDay would be the wrong tool.

   One named pair for the log line, custody and insights, because they printed
   and computed the same wrong day together and should be right together. */
export const dubaiWindow = (from, to) => ({ from: dubaiIso(from), to: dubaiIso(to) });

async function runWindowInner(mode, from, to, onProgress, fleet = null, jobId = null) {
  await loadSettings(true);   // pick up Settings-page credential changes without a redeploy
  const day = dubaiWindow(from, to);
  log.info('run', `${mode} ${day.from}..${day.to}`);
  const names = Object.keys(HISTORICAL);
  /* What this job already finished, if it is a job that has run before.
     ─────────────────────────────────────────────────────────────────────────
     The worker restarts on every deploy and a backfill takes hours, so a run
     being interrupted is the normal case rather than the exception. Until this
     was read, every attempt began at the first source and the first window —
     so the run died at the same elapsed point each time and the boot requeue,
     comparing one attempt against the last, correctly concluded that it was
     not advancing. Five attempts, window 7 of 12 every time, abandoned. */
  const ckpt = jobId ? await loadCheckpoint(jobId) : NO_CHECKPOINT;
  /* The callback is decorated once, here, rather than at each of the three
     places that report. Every report a run makes then carries a heartbeat —
     including the per-window ones from onStep, which are the frequent ones and
     the grain at which production job 8 kept dying. Attaching it at the call
     sites instead would mean the next report added quietly has none. */
  const beat = onProgress;
  onProgress = (p) => beat?.({ ...p, ...heartbeat() });
  let done = 0;
  for (const [name, mod] of Object.entries(HISTORICAL)) {
    /* A source this job has already finished is skipped whole. `done` still
       counts it, because it IS done — the number a reader sees is how much of
       the run is behind it, not how much this attempt did. */
    if (ckpt.has(name)) {
      done++;
      log.info('run', `${mode} ${name} already finished by this job — skipping`, { job: jobId });
      continue;
    }
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
    /* `steps` counts the units this JOB has finished, across every attempt —
       not the units this attempt walked past. The boot requeue abandons a job
       whose steps did not grow, and a resumed run that skips six windows and
       does two new ones would otherwise report 2 against the 7 it reported
       last time, and read as a job going backwards. */
    let steps = ckpt.count();
    const onStep = (st) => {
      steps = ckpt.count() + 1;
      return onProgress?.({ current: name, done, total: names.length,
        remaining: names.slice(done + 1), step: st, steps });
    };
    /* Handed to the source so it can skip a window it has already collected
       and record one it has just finished. A source that walks no windows
       ignores it, exactly as it ignores onStep. */
    const checkpoint = {
      has: (unit) => ckpt.has(name, unit),
      mark: (unit, rows) => ckpt.mark(name, unit, rows),
    };
    /* `fleet` reaches the sources that serve more than one business — Uber is
       two separate Uber orgs with separate credentials — so a run can be
       narrowed to the fleet whose credential was just replaced instead of
       re-pulling both. A source that serves one fleet ignores the key. */
    let threw = false;
    try { await mod.collect({ from, to, mode, onStep, fleet, checkpoint }); }
    catch (e) { threw = true; log.error('run', `${name} threw`, { err: String(e) }); }
    done++;
    /* Marked only when the source ran to completion. A source that threw may
       have left windows uncollected, and recording it as finished would make
       the next attempt skip the very thing that failed. Its individual windows
       keep their own marks, so the retry still resumes rather than restarting. */
    if (!threw) await ckpt.mark(name);
    log.info('run', `${mode} ${name} finished`, { done, of: names.length });
  }
  await onProgress?.({ current: null, done, total: names.length, remaining: [] });
  // CABMAN is not part of the historical window — it runs on its own 5-minute schedule.
  // Once bookings are in, reconcile seat-sensor occupancy against them (unauthorized trips).
  try { await reconcile({ from, to }); } catch (e) { log.error('run', 'reconcile', { err: String(e) }); }
  // Derive who was driving which vehicle each day, so vehicle facts can name a person.
  try {
    // Dubai days, not the UTC day of the run clock — see the note on
    // dubaiWindow: the 21:00 UTC catch-up is already tomorrow in Dubai.
    await rebuildCustody({ from: day.from, to: day.to });
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
    // The window every insight rule is evaluated over, and the one printed on
    // the finding panel. Dubai days for both reasons — see dubaiWindow.
    await computeInsights({ from: day.from, to: day.to });
  } catch (e) { log.error('run', 'insights', { err: String(e) }); }
  await setState('collector', '-', 'last_' + mode, new Date().toISOString());
}

/* The window one pass measures, as Dubai days.
   ─────────────────────────────────────────────────────────────────────────
   Separated from analystPass so the fix can be PROVEN: this is the only part
   of the pass that can be asked a question without a database and a model
   call, and the question is exactly "what window does a pass starting at this
   instant cover". The instants the test uses are the real ones from
   production.

   What it replaces: `const iso = (d) => d.toISOString().slice(0, 10)`, a local
   redefinition of src/util.js's iso() that shadowed the import — which is why
   test/timezone.test.mjs did not catch it. Its ban is on the literal shape
   `iso(new Date())`, and laundering the clock through a variable and a local
   `iso` walked straight past it: the guard reported 17 passed, 0 failed with
   this bug live in production.

   And it WAS live. src/index.js:107 is `cron.schedule('10 23 * * *', () =>
   analystPass())`. 23:10 UTC is 03:10 the next day in Dubai, so every pass ran
   on Dubai day D and recorded — and measured — a window ending on D-1.
   /api/analyst/findings on production says so five nights running: the run
   created at 2026-09-01T23:10:13.008Z carries window 2026-08-02..2026-09-01,
   the one at 2026-08-31T23:10:14.724Z carries 2026-08-01..2026-08-31, and so
   back through 2026-08-30, 2026-08-29 and 2026-08-28. The day in progress
   contributed to no claim, and the cost was paid downstream rather than fixed:
   api/analytics_routes.js:1795 records that `window_start >= from` "hid every
   finding at the exact range the page opens on — five confirmed claims on
   production, invisible on the default view".

   `days` back from the clock in whole days. UTC has no daylight saving, so
   this is the same instant daysAgo(days) returns; it takes `now` because
   daysAgo() cannot be given one. */
export const analystWindow = (days, now = new Date()) =>
  dubaiWindow(new Date(now.getTime() - days * 864e5), now);

/* One analyst pass: build a brief of aggregates, ask the model for testable
   claims, measure each against the rest of the fleet, keep the verdicts. Runs
   on its own daily schedule rather than inside runWindow, because it costs a
   model call and its input barely moves between two afternoons. */
export async function analystPass({ days = 30, now = new Date() } = {}) {
  await loadSettings(true);
  const { from, to } = analystWindow(days, now);
  try {
    const r = await runAnalyst({ from, to });
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
      [`an-${Date.now()}`, from, to, err])
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
export const backfill = (onProgress, fleet = null, jobId = null) =>
  runWindow('backfill', monthsAgo(config.backfillMonths), new Date(), onProgress, fleet, jobId);
export const incremental = (onProgress, fleet = null, jobId = null) =>
  runWindow('incremental', daysAgo(config.incrementalDays), new Date(), onProgress, fleet, jobId);

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
export const catchUp = (days = 30, onProgress, fleet = null, jobId = null) =>
  runWindow('catchup', daysAgo(days), new Date(), onProgress, fleet, jobId);

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

/* Uber's own word on each driver: rating, lifetime trips, banned, compliance,
   and the car they are attached to.
   ─────────────────────────────────────────────────────────────────────────
   Its own tick, not folded into a collection pass, because it is one call per
   driver — ~320 across both fleets — and everything else in this file asks a
   handful of questions about a window. Daily is the right cadence: a rating
   moves over months and a ban is caught within a day, which is faster than a
   ban currently reaches anyone here at all.

   Given a job id it checkpoints per driver, so a container replaced mid-pass
   resumes at the driver it had reached rather than at the top. */
export async function uberProfileTick({ fleet = null, jobId = null } = {}) {
  await loadSettings();
  try {
    const ckpt = await loadCheckpoint(jobId);
    const n = await uberProfile.collect({ mode: 'profile', fleet, checkpoint: ckpt });
    log.info('uber', 'profile tick', { drivers: n, fleet });
    return n;
  } catch (e) {
    log.error('uber', 'profile tick failed', { err: String(e).slice(0, 200) });
    return 0;
  }
}

/* Verify a slice of the past against Uber itself, a few windows per run.
   ─────────────────────────────────────────────────────────────────────────
   Everything else in this file COLLECTS. This one checks the collecting, and
   it is here rather than in an endpoint for a plain reason: an Uber report
   takes minutes at the provider and the gateway in front of the API waits
   seventy-five seconds. A verification that cannot finish inside a page load
   either lives in the worker or does not exist.

   Windows, not a sweep. Thirteen whole calendar months reach Uber's retention
   edge, and four whole Mon-Sun weeks give the recent past a check that does
   not wait for a month to end. Both are FIXED dates, which is what lets a
   re-verification update its row instead of growing one per attempt — a
   window ending "yesterday" would leave a new row every day and a history of
   nothing.

   Never-verified windows first and newest first among them, so the first runs
   answer for the past anyone is actually looking at; then the ones verified
   longest ago, so a month that agreed in September and stops agreeing in
   November is caught rather than assumed. At three windows per fleet per
   daily run the whole retention window is covered inside a week and then
   re-covered continuously.

   It writes only to uber_trip_audit — never to `trip`. A verification that
   repairs what it measures can never report a failure, and the value of this
   table is entirely in its ability to say no. */
const AUDIT_SETTLE_DAYS = 2;

export function auditWindows(now = new Date(), months = 13, weeks = 4) {
  const out = [];
  for (let i = 1; i <= months; i++) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    // Day 0 of the next month is the last day of this one, leap years included.
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
    out.push({ kind: 'month', from, to });
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Monday = 0, because a week that starts on Sunday is not a week anyone here
  // works to.
  const monday = new Date(today);
  monday.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  for (let i = 1; i <= weeks; i++) {
    const from = new Date(monday); from.setUTCDate(monday.getUTCDate() - 7 * i);
    const to = new Date(from); to.setUTCDate(from.getUTCDate() + 6);
    out.push({ kind: 'week', from, to });
  }
  /* Nothing that ended in the last two days. A window still settling would
     have Uber listing trips the incremental has not reached yet, and this
     would report that as trips we never stored — lag printed with the
     confidence of a loss, which is the one failure mode that would make the
     whole panel worth ignoring. Whole months are already old enough; the last
     complete week usually is not. */
  const cutoff = new Date(today); cutoff.setUTCDate(today.getUTCDate() - AUDIT_SETTLE_DAYS);
  return out.filter((w) => w.to <= cutoff);
}

const auditKey = (w) => `${iso(w.from)}..${iso(w.to)}`;

/** The windows this fleet should verify next, worst-known first. */
export function nextAuditWindows(candidates, verifiedAt, limit) {
  const fresh = candidates.filter((w) => !verifiedAt.has(auditKey(w)));
  const stale = candidates.filter((w) => verifiedAt.has(auditKey(w)))
    .sort((a, b) => verifiedAt.get(auditKey(a)) - verifiedAt.get(auditKey(b)));
  return [...fresh, ...stale].slice(0, limit);
}

export async function uberAuditTick({ fleet = null, jobId = null, limit = 3 } = {}) {
  await loadSettings();
  const ckpt = await loadCheckpoint(jobId);
  const candidates = auditWindows();
  let checked = 0, disagreed = 0;

  for (const o of uber.uberOrgs(fleet)) {
    let verifiedAt = new Map();
    try {
      /* to_char, not the DATE. The driver hands a DATE back as a JS Date at
         local midnight, so on any container not running in UTC iso() would
         shift the key by a day — every window would read as never verified,
         the job would re-verify the same three windows every night, and the
         other ten would never be asked about at all. A silent one-day skew is
         the difference between a standing check and a loop. */
      const { rows } = await pool.query(
        `SELECT to_char(window_from, 'YYYY-MM-DD') AS window_from,
                to_char(window_to, 'YYYY-MM-DD') AS window_to, verified_at
           FROM uber_trip_audit WHERE fleet_id = $1`, [o.fleet]);
      verifiedAt = new Map(rows.map((r) => [
        `${r.window_from}..${r.window_to}`, new Date(r.verified_at).getTime()]));
    } catch (e) {
      log.warn('uber', 'could not read past audits — this run will re-verify from the top',
        { fleet: o.fleet, err: String(e).slice(0, 160) });
    }

    /* A week that has rolled out of the four-week grid is never offered again,
       and nothing else would ever remove it: its row would sit in the table
       for ever showing a "Checked" date that stops moving, which reads as a
       week still being watched when it is not. The month containing it is
       audited on its own rotation, so the week row has no information left in
       it once it ages out. */
    const live = new Set(candidates.map(auditKey));
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM uber_trip_audit
          WHERE fleet_id = $1 AND kind = 'week'
            AND to_char(window_from, 'YYYY-MM-DD') || '..' || to_char(window_to, 'YYYY-MM-DD') <> ALL($2)`,
        [o.fleet, [...live]]);
      if (rowCount) log.info('uber', 'retired audited weeks that left the grid',
        { fleet: o.fleet, rows: rowCount });
    } catch (e) {
      log.warn('uber', 'could not retire old audited weeks', { fleet: o.fleet, err: String(e).slice(0, 120) });
    }

    for (const w of nextAuditWindows(candidates, verifiedAt, limit)) {
      const unit = `audit ${o.fleet} ${auditKey(w)}`;
      if (ckpt.has(unit)) continue;
      const [r] = await uber.auditTripWindow({ from: w.from, to: w.to, fleet: o.fleet });
      if (!r) continue;
      try {
        await pool.query(
          `INSERT INTO uber_trip_audit (fleet_id, window_from, window_to, kind, verified_at,
             uber_rows, our_rows, in_both, uber_only, ours_only, agreement_pct,
             outside_window, error, past_retention, took_ms, sample_missing, days, misfiled)
           VALUES ($1, $2, $3, $16, now(), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $17)
           ON CONFLICT (fleet_id, window_from, window_to) DO UPDATE SET
             kind = EXCLUDED.kind,
             verified_at = now(), uber_rows = EXCLUDED.uber_rows, our_rows = EXCLUDED.our_rows,
             in_both = EXCLUDED.in_both, uber_only = EXCLUDED.uber_only,
             ours_only = EXCLUDED.ours_only, agreement_pct = EXCLUDED.agreement_pct,
             outside_window = EXCLUDED.outside_window, error = EXCLUDED.error,
             past_retention = EXCLUDED.past_retention, took_ms = EXCLUDED.took_ms,
             sample_missing = EXCLUDED.sample_missing, days = EXCLUDED.days,
             misfiled = EXCLUDED.misfiled`,
          [o.fleet, iso(w.from), iso(w.to),
            r.uber_rows_in_window ?? null, r.ours ?? null, r.in_both ?? null,
            r.uber_only ?? null, r.ours_only ?? null, r.agreement_pct ?? null,
            r.uber_rows_outside_window ?? null, r.error || null, !!r.past_retention,
            r.took_ms ?? null, JSON.stringify(r.sample_missing || []),
            /* Only the days that disagreed. A verified month is 31 rows of
               "uber 512, ours 512", which is 31 rows of nothing and would make
               this column the largest thing in the table for the windows it
               says least about. */
            JSON.stringify((r.days || []).filter((d) => d.missing > 0 || d.uber !== d.ours)),
            w.kind, r.misfiled ?? null]);
      } catch (e) {
        log.error('uber', 'could not record an audit', { fleet: o.fleet, window: auditKey(w),
          err: String(e).slice(0, 200) });
      }
      /* Marked after the verdict is stored, and marked even when the verdict
         is an error: a window Uber refuses will be refused again, and retrying
         it inside the same job spends the run on a question already answered. */
      await ckpt.mark(unit, r.uber_only ?? null);
      checked++;
      if ((r.uber_only || 0) > 0) disagreed++;
      log[(r.uber_only || 0) > 0 ? 'warn' : 'info']('uber', `audit ${o.fleet} ${auditKey(w)}`, {
        uber: r.uber_rows_in_window, ours: r.ours, missing: r.uber_only,
        misfiled: r.misfiled || undefined,
        agreement: r.agreement_pct, err: r.error || undefined });
    }
  }
  log.info('uber', 'audit tick', { windows: checked, disagreeing: disagreed, fleet });
  return checked;
}

// Other live pollers (Uber online/on-trip status, FMS live telemetry).
export async function liveStatusTick() {
  await loadSettings();
  const jobs = [uber.pullLive().catch(() => 0), ...config.fms.fleets.map((f) => fms.pullLive(f).catch(() => 0))];
  const res = await Promise.allSettled(jobs);
  const n = res.reduce((a, r) => a + (r.status === 'fulfilled' ? (r.value || 0) : 0), 0);
  log.info('live', 'status tick', { snapshots: n });
}
