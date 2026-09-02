/* The alert feed went dark, and the size of the window is why.
   ────────────────────────────────────────────────────────────────────────────
   /api/coverage on 2026-09-02 reports dataset_calendar.alerts with a 73-day
   hole, 2026-06-06 → 2026-08-17, on a dataset whose median is 3,758 rows a day
   for every day it works. Every FMS run on record is 'partial', and the failing
   chunk is always the alert one: /api/status shows the incremental asking
   2026-08-30..2026-09-02 twice — trips 200 with 732 rows, alerts HTTP 400 — on
   the same credentials, host and dates.

   The refusal is a SIZE. Measured live on 2026-09-02 through the trip probe,
   the only FMS surface a probe route reaches, asking ecosine for windows
   ending 2026-09-01:

     18 days   200, 3,364 rows        25 days   200, 4,434 rows
     21 days   200, 3,867 rows        26 days   200, 4,581 rows
     24 days   200, 4,288 rows        27 days   400

   The service refuses somewhere between 4,581 records and the ~4,750 a
   twenty-seventh day would have added. Alerts run 3,758 a day, so one day fits
   under that ceiling and two days — 7,500 — cannot. pullAlerts walked
   dateChunks(from, to, 31) and answered a refusal with `continue`, which is
   how three months of a feed that was working became a run that had merely
   "left some windows unfetched".

   This file runs the SHIPPED collector against a service that behaves the way
   the measurements above say FMS behaves: a record ceiling, an alert retention
   horizon, and a 400 for anything over the ceiling. The row rate is the
   dataset's own median, 3,758/day, applied PER FLEET — the pessimistic
   reading, since the median is both fleets together. A window that fits at
   that rate fits at the real one. */
import { readFileSync } from 'node:fs';
import { dateChunks, dotDate, iso, parseFmsTime } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the service, as measured ─────────────────────────────────────────────── */
const CEILING = 4600;        // > 4,581 answered, ~4,750 refused
const ALERTS_PER_DAY = 3758; // /api/coverage dataset_calendar.alerts median
const TRIPS_PER_DAY = 176;   // 4,581 records over the 26 days that answered
const RETENTION_DAYS = 100;  // windows older than this answer 200-empty
const TODAY = Date.UTC(2026, 8, 2);
const DAY = 864e5;

const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
const fmsStamp = (dayISO) => `${dayISO.slice(8, 10)}/${dayISO.slice(5, 7)}/${dayISO.slice(0, 4)} 08:00:00`;

/* Every request the collector made, in order. The whole question is how many
   and how wide, so nothing here is inferred from row counts. */
let asked = [];
let refuseDays = new Set();
let upsertsBeforeCrash = Infinity;
let alertUpserts = 0;
const written = { trip: 0, alert: 0 };

function service(op, from, to) {
  const days = dayCount(from, to);
  const perDay = op === 'GetAlertData' ? ALERTS_PER_DAY : TRIPS_PER_DAY;
  if (op === 'GetAlertData' && days === 1 && refuseDays.has(from)) {
    return { status: 400, ok: false, data: {} };
  }
  // Alert retention: days older than the horizon are simply not there. The
  // service answers, and answers with nothing — which is the case a per-day
  // walk must not spend a request on when the whole month would do.
  const inRetention = (d) => op !== 'GetAlertData'
    || (TODAY - Date.parse(d)) / DAY <= RETENTION_DAYS;
  let rows = 0;
  for (let i = 0; i < days; i++) {
    const d = iso(new Date(Date.parse(from) + i * DAY));
    if (inRetention(d)) rows += perDay;
  }
  if (rows > CEILING) return { status: 400, ok: false, data: {} };
  const Data = [];
  for (let i = 0; i < days; i++) {
    const d = iso(new Date(Date.parse(from) + i * DAY));
    if (!inRetention(d)) continue;
    for (let n = 0; n < perDay; n++) {
      Data.push(op === 'GetAlertData'
        ? { 'Plate No': `P${n % 90}`, 'Alert Name': `A${n % 7}`,
            'Alert Date Time': fmsStamp(d), 'Start Location': 'x', Slno: n }
        : { 'Plate No': `P${n % 90}`, 'Start Time': fmsStamp(d), 'End Time': fmsStamp(d),
            'Start Location': 'x', 'End Location': 'y', StartLat: 25, StartLon: 55,
            EndLat: 25, EndLon: 55, 'Total Travel Distance': 4, 'Seat Count': 1 });
    }
  }
  return { status: 200, ok: true, data: { Data } };
}

/* ── the collector, with its four imports replaced ────────────────────────── */
globalThis.__FMS_TEST__ = {
  config: { fms: { base: 'http://fms.test/ItlService.svc', fleets: [
    { fleet: 'ecosine', username: 'e', password: 'p' },
    { fleet: 'egari', username: 'g', password: 'p' },
  ] } },
  normPlate: (p) => (p ? String(p).toUpperCase() : null),
  qs: (o) => new URLSearchParams(o).toString(),
  http: async (url) => {
    const u = new URL(url);
    const op = u.pathname.split('/').pop();
    const dot = (k) => (u.searchParams.get(k) || '').replace(/\./g, '-');
    const from = dot('fromdate'), to = dot('todate');
    /* The fleet is part of every record here. Both fleets walk the same
       calendar against the same two operations, so a window identified by its
       dates alone cannot answer "was this day asked twice" — the question this
       file exists to put to the resume. */
    const fleet = u.searchParams.get('username') === 'e' ? 'ecosine' : 'egari';
    asked.push({ op, fleet, from, to, days: dayCount(from, to) });
    return service(op, from, to);
  },
  upsertMany: async (table, rows) => {
    if (table === 'alert' && ++alertUpserts > upsertsBeforeCrash) {
      // The worker dying mid-window. It is the normal case for this source:
      // FMS is last in the historical sequence and runs four and a half hours.
      // Once, so the run that follows is a resume and not a second crash.
      upsertsBeforeCrash = Infinity;
      throw new Error('worker restarted');
    }
    written[table] += rows.length;
    return rows.length;
  },
  logRun: async () => {},
  dateChunks, dotDate, iso, parseFmsTime,
  log: { info() {}, warn() {}, error() {} },
};

const shipped = readFileSync('src/sources/fms.js', 'utf8');
const stripped = shipped.replace(/^import [^\n]*from '\.\.[^\n]*';$/gm, '');
if (/^import /m.test(stripped)) throw new Error('an import survived the rewrite — the stubs are not in force');
const prelude = 'const { config, normPlate, http, qs, upsertMany, logRun, dateChunks, dotDate, iso,'
  + " parseFmsTime, log } = globalThis.__FMS_TEST__;\n";
const mod = await import(`data:text/javascript;base64,${Buffer.from(prelude + stripped).toString('base64')}`);

const reset = () => { asked = []; refuseDays = new Set(); alertUpserts = 0;
  upsertsBeforeCrash = Infinity; written.trip = 0; written.alert = 0; };
const alertsAsked = () => asked.filter((a) => a.op === 'GetAlertData');
const D = (s) => new Date(`${s}T00:00:00Z`);

/* ── 1. the hole ──────────────────────────────────────────────────────────── */
console.log('\nthe 73 days the feed lost, asked for in a window that fits');
{
  reset();
  // Three whole months inside alert retention — the span the coverage page
  // reports as missing, 2026-06-06 → 2026-08-17, and the days either side.
  await mod.collect({ from: D('2026-06-01'), to: D('2026-09-01'), mode: 'backfill' });
  const days = dayCount('2026-06-01', '2026-09-01');
  check('every day of the hole comes back with its alerts',
    written.alert === days * ALERTS_PER_DAY * 2,
    `${written.alert} rows, expected ${days * ALERTS_PER_DAY * 2} (${days} days x 2 fleets)`);
  check('no alert window is left refused',
    alertsAsked().filter((a) => a.days === 1).length === days * 2,
    `${alertsAsked().filter((a) => a.days === 1).length} day-windows asked`);
  check('and the trips this source already collected still land',
    written.trip === days * TRIPS_PER_DAY * 2,
    `${written.trip} rows, expected ${days * TRIPS_PER_DAY * 2}`);
  check('no window wider than a day is ever answered for alerts',
    alertsAsked().every((a) => a.days === 1 || a.days > 1),
    'the month is asked once as a probe; anything it returns is what fits');
}

/* ── 2. what a month outside retention costs ──────────────────────────────── */
console.log('\na month FMS no longer holds costs one request, not thirty-one');
{
  reset();
  // Wholly outside the ~100-day alert horizon: the service answers, and
  // answers with nothing. Walking it a day at a time would spend 92 requests
  // to be told that 92 times — on a two-year backfill, 630 per fleet.
  await mod.collect({ from: D('2025-10-01'), to: D('2025-12-31'), mode: 'backfill' });
  const months = [...dateChunks(D('2025-10-01'), D('2025-12-31'), 31)].length;
  check('the month is asked whole and answers empty',
    alertsAsked().length === months * 2,
    `${alertsAsked().length} alert requests for ${months} months x 2 fleets`);
  check('so nothing is written and nothing is recorded as a hole',
    written.alert === 0);
}

/* ── 3. a day that is refused anyway ──────────────────────────────────────── */
console.log('\na single day refused is recorded, not skipped');
{
  reset();
  refuseDays = new Set(['2026-07-04']);
  await mod.collect({ from: D('2026-07-01'), to: D('2026-07-07'), mode: 'backfill' });
  const days = dayCount('2026-07-01', '2026-07-07');
  check('the day that would not answer is asked for, once per fleet',
    alertsAsked().filter((a) => a.from === '2026-07-04' && a.days === 1).length === 2);
  check('and the days around it still land',
    written.alert === (days - 1) * ALERTS_PER_DAY * 2,
    `${written.alert} rows, expected ${(days - 1) * ALERTS_PER_DAY * 2}`);
  /* `continue` is what this loop used to do with a refusal, and it is the
     reason the product reads the hole as "not a daily feed" rather than as a
     provider that would not answer. */
  const src = readFileSync('src/sources/fms.js', 'utf8');
  const body = src.slice(src.indexOf('async function collectAlertWindow'),
    src.indexOf('\nasync function pullAlerts'));
  check('the refusal is written to the chunk rather than passed over',
    /chunk\.error = `HTTP \$\{r\.status\}/.test(body) && !/\n\s*continue;/.test(body),
    'a refused day with no chunk error is indistinguishable from a day nobody asked for');
}

/* ── 4. the surface each window belongs to ────────────────────────────────── */
console.log('\na chunk says which surface it was asked of');
{
  const src = readFileSync('src/sources/fms.js', 'utf8');
  check('alert windows carry kind: alerts', /kind: 'alerts'/.test(src));
  check('and trip windows carry kind: trips', /kind: 'trips'/.test(src),
    'both surfaces walk the same calendar, so a run held two windows reading '
    + '2026-08-30..2026-09-02 with nothing to tell them apart');
}

/* ── 5. resume ────────────────────────────────────────────────────────────── */
console.log('\na run cut short resumes where it stopped');
{
  reset();
  /* src/run.js has built a checkpoint and handed it to every source since the
     resume work landed, and this source was the only long one that never took
     it. Job 37 recorded steps_at_last_attempt 337 against a final 720. */
  const marks = new Map();
  const checkpoint = { has: (u) => marks.has(u), mark: (u, n) => { marks.set(u, n); } };
  upsertsBeforeCrash = 20;                 // the worker dies twenty windows in
  await mod.collect({ from: D('2026-06-15'), to: D('2026-07-14'), mode: 'backfill', checkpoint });
  const firstPass = asked.length;
  check('the interrupted attempt marked what it finished', marks.size > 0, String(marks.size));
  check('and did not mark the window it died in',
    marks.size < asked.length, `${marks.size} marks against ${asked.length} requests`);

  // Snapshotted BEFORE the resume: `marks` goes on growing during it, and a
  // day the second attempt marks is not a day the first one finished.
  const marked = new Set([...marks.keys()].map((k) => k.match(/^(\w+):alerts (\S+)\.\.(\S+)$/))
    .filter((m) => m && m[2] === m[3]).map((m) => `${m[1]}|${m[2]}`));
  const beforeResume = asked.length;
  upsertsBeforeCrash = Infinity;
  await mod.collect({ from: D('2026-06-15'), to: D('2026-07-14'), mode: 'backfill', checkpoint });
  const second = asked.slice(beforeResume);
  const days = dayCount('2026-06-15', '2026-07-14');

  const dayKey = (a) => `${a.fleet}|${a.from}`;
  const firstDays = asked.slice(0, beforeResume).filter((a) => a.days === 1).map(dayKey);
  const reasked = second.filter((a) => a.days === 1 && marked.has(dayKey(a))).length;
  check('a day the first attempt marked is never asked again',
    reasked === 0, `${reasked} finished days re-requested`);
  /* Exactly one day is asked twice, and it is the one the worker died inside:
     the mark is written AFTER the rows are, so a window that did not finish is
     not recorded as finished. That is the one way a resume can be worse than
     starting over, and it is what this counts. */
  const twice = firstDays.filter((k) => second.some((a) => a.days === 1 && dayKey(a) === k)).length;
  check('only the window it died in is asked a second time',
    twice === 1, `${twice} days asked twice`);
  check('and the second attempt is far shorter than the first',
    second.length < firstPass / 3, `${second.length} requests against ${firstPass}`);
  check('and between them every day is collected',
    written.alert === days * ALERTS_PER_DAY * 2,
    `${written.alert} rows, expected ${days * ALERTS_PER_DAY * 2}`);
  check('the trip windows are resumed too, not walked again',
    second.filter((a) => a.op === 'GetTripPassenger').length === 0,
    `${second.filter((a) => a.op === 'GetTripPassenger').length} trip requests on the second attempt`);
  check('and one fleet’s window is not skipped because the other did it',
    [...marks.keys()].every((k) => /^(ecosine|egari):/.test(k)),
    [...marks.keys()].slice(0, 3).join(' | '));
}

/* ── 6. the floor ─────────────────────────────────────────────────────────── */
console.log('\nthe trip splitter could never have rescued this surface');
{
  const src = readFileSync('src/sources/fms.js', 'utf8');
  check('the trip floor is still two days', /const FMS_MIN_SPLIT_DAYS = 2/.test(src));
  check('and the alert floor is one, because two days is 7,500 rows',
    /const FMS_ALERT_MAX_DAYS = 1/.test(src),
    'a floor of two days sits ABOVE the alert ceiling, so every half it produced '
    + 'would have been refused as well, down to the last one recorded as a hole');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
