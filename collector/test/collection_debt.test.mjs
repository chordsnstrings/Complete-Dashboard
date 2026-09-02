/* Four panels counting retries and calling them holes.
   ─────────────────────────────────────────────────────────────────────────
   Measured against production /api/status, /api/coverage and
   /api/settings/jobs on 2026-09-02.

   Settings printed "111 windows did not land and are still outstanding". The
   111 is a count of rows in `failed_windows`, and a row there is one ASK that
   was refused, not one hole:

     14 are the same window asked again in a second mode (97 distinct tuples).
      7 are past Uber's retention horizon — uber/backfill/egari, 2024-08-31 →
        2025-04-04, "outside retention: … invalid date range". No backfill will
        ever recover those days, and the Sunday run re-asks and re-counts them.
      8 have a `to` after the run's own finished_at: 2026-08-31..2026-09-06
        against a run that finished 2026-09-01. weekChunks widens to whole
        weeks on purpose (src/util.js:37-55); the provider answers "endDate is
        too late". A future that has not happened is not a hole.
     44 per fleet describe ONE dead Uber web session over 31 distinct days,
        re-asked at 1-day, 7-day and 31-day granularity (1 × 31d, 12 × 7d of
        which half are repeats, 31 × 1d — the exact shape reproduced below).

   And the biggest real outage on the fleet, 113 days of FMS alerts on EACH
   fleet, is six rows out of the 111. So the headline over-counted one dead
   session 44x and under-counted the worst hole 19x. In days — the unit that
   describes missing data — it is 362 owed and a further 217 gone for good.

   The same sentence listed the first six raw rows, which rendered
   "FMS telematics 14 Aug 2026 → 31 Aug 2026" twice in a row: two different
   fleets, and the fleet was never printed.

   Three more sentences in the same two panels, same fault of stating something
   the data contradicts:
     · '"partial" means the run wrote rows AND left windows unfetched', on a
       page showing uber/catchup on both fleets as partial with rows=0 and 44
       of 44 chunks failed.
     · "— is missing 73 days" under a table that had just called that dataset
       "not a daily feed": the alerts calendar is event_driven with src null,
       and sourceLabel(null) is '—'.
     · "never started" beside "Restarts: 5" and "35,829 rows so far" on job 8,
       because the requeue nulls started_at on the rows it abandons.

   Rendered through the real views in a browser: every one of these sentences
   is computed in api/public/app.js and no JSON assertion can see it. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── production's failed_windows, verbatim ─────────────────────────────── */
const E_400 = 'HTTP 400';
const E_LATE = 'generate: "Code: invalid-argument, Message: endDate is too late, Cause: endDate is too late"';
const E_RET = 'outside retention: Error: generate: "Code: invalid-argument, Message: invalid date range, '
  + 'Cause: invalid date range"';
const E_NF = 'Error: generate: "Not Found"';
const E_DEAD = 'web session: redirected to auth.uber.com — the session is no longer signed in';
const E_VEH = 'vehicles/compliance: vehiclesTableVehicles: web session — redirected to auth.uber.com — '
  + 'the session is no longer signed in';
const w = (from, to, error) => ({ from, to, error });
const plus = (d, n) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 864e5)
  .toISOString().slice(0, 10);

/* One dead session, 44 rows: the 31-day ask, six weekly asks made twice over,
   and 31 single days. This is what a retry ladder looks like in the table the
   Settings sentence was counting. */
const deadLadder = () => {
  const out = [w('2026-08-02', '2026-09-01', E_NF)];
  const weeks = ['2026-07-27', '2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'];
  weeks.forEach((s) => out.push(w(s, plus(s, 6), E_DEAD)));
  [...weeks].reverse().forEach((s) => out.push(w(s, plus(s, 6), E_DEAD)));
  for (let i = 0; i < 31; i++) { const d = plus('2026-08-03', i); out.push(w(d, d, E_DEAD)); }
  return out;
};
const FMS_BACKFILL = [w('2026-08-14', '2026-08-31', E_400), w('2026-07-14', '2026-08-13', E_400),
  w('2026-06-13', '2026-07-13', E_400), w('2026-05-13', '2026-06-12', E_400)];
const STATUS = [
  { source: 'fms', mode: 'backfill', fleet_id: 'ecosine', status: 'partial', rows_written: 132529,
    chunks_total: 64, chunks_failed: 4, finished_at: '2026-08-31T19:25:50.889Z', failed_windows: FMS_BACKFILL },
  { source: 'fms', mode: 'backfill', fleet_id: 'egari', status: 'partial', rows_written: 82812,
    chunks_total: 52, chunks_failed: 4, finished_at: '2026-08-31T19:33:39.489Z', failed_windows: FMS_BACKFILL },
  { source: 'fms', mode: 'catchup', fleet_id: 'ecosine', status: 'partial', rows_written: 5102,
    chunks_total: 3, chunks_failed: 1, finished_at: '2026-09-01T21:09:40.390Z',
    failed_windows: [w('2026-08-02', '2026-09-01', E_400)] },
  { source: 'fms', mode: 'catchup', fleet_id: 'egari', status: 'partial', rows_written: 3726,
    chunks_total: 2, chunks_failed: 1, finished_at: '2026-09-01T21:09:52.629Z',
    failed_windows: [w('2026-08-02', '2026-09-01', E_400)] },
  { source: 'fms', mode: 'incremental', fleet_id: 'ecosine', status: 'partial', rows_written: 736,
    chunks_total: 2, chunks_failed: 1, finished_at: '2026-09-02T08:09:47.321Z',
    failed_windows: [w('2026-08-30', '2026-09-02', E_400)] },
  { source: 'fms', mode: 'incremental', fleet_id: 'egari', status: 'partial', rows_written: 617,
    chunks_total: 2, chunks_failed: 1, finished_at: '2026-09-02T08:09:49.602Z',
    failed_windows: [w('2026-08-30', '2026-09-02', E_400)] },
  { source: 'uber', mode: 'backfill', fleet_id: 'ecosine', status: 'partial', rows_written: 1029,
    chunks_total: 50, chunks_failed: 1, finished_at: '2026-08-31T17:43:56.942Z',
    failed_windows: [w('2026-08-31', '2026-09-06', E_LATE)] },
  { source: 'uber', mode: 'backfill', fleet_id: 'egari', status: 'partial', rows_written: 107437,
    chunks_total: 156, chunks_failed: 8, finished_at: '2026-08-31T19:08:34.488Z',
    failed_windows: [w('2025-03-05', '2025-04-04', E_RET), w('2025-02-02', '2025-03-04', E_RET),
      w('2025-01-02', '2025-02-01', E_RET), w('2024-12-02', '2025-01-01', E_RET),
      w('2024-11-01', '2024-12-01', E_RET), w('2024-10-01', '2024-10-31', E_RET),
      w('2024-08-31', '2024-09-30', E_RET), w('2026-08-31', '2026-09-06', E_LATE)] },
  /* The two runs the "partial means rows were written" caption was false for. */
  { source: 'uber', mode: 'catchup', fleet_id: 'ecosine', status: 'partial', rows_written: 0,
    chunks_total: 44, chunks_failed: 44, finished_at: '2026-09-01T21:05:47.209Z', failed_windows: deadLadder() },
  { source: 'uber', mode: 'catchup', fleet_id: 'egari', status: 'partial', rows_written: 0,
    chunks_total: 44, chunks_failed: 44, finished_at: '2026-09-01T21:06:51.599Z', failed_windows: deadLadder() },
  { source: 'uber_fleet', mode: 'catchup', fleet_id: 'ecosine', status: 'partial', rows_written: 392,
    chunks_total: 1, chunks_failed: 1, finished_at: '2026-09-01T21:06:54.462Z',
    failed_windows: [w('2026-08-02', '2026-09-01', E_VEH)] },
  { source: 'uber_fleet', mode: 'catchup', fleet_id: 'egari', status: 'partial', rows_written: 189,
    chunks_total: 1, chunks_failed: 1, finished_at: '2026-09-01T21:06:56.838Z',
    failed_windows: [w('2026-08-02', '2026-09-01', E_VEH)] },
  // A clean run, so the page is not uniformly broken.
  { source: 'hotel', mode: 'incremental', fleet_id: 'ecosine', status: 'ok', rows_written: 41,
    chunks_total: 1, chunks_failed: 0, finished_at: '2026-09-02T08:10:01.000Z', failed_windows: [] },
];
check('the fixture is production’s 111 failed windows',
  STATUS.reduce((s, r) => s + r.failed_windows.length, 0) === 111,
  String(STATUS.reduce((s, r) => s + r.failed_windows.length, 0)));

/* /api/coverage as production answers it: the alerts calendar is event-driven
   with a 73-day quiet stretch and no `src`, the ledger likewise, and FMS trips
   carry a genuine hole. */
const COVERAGE = {
  trips: [{ platform: 'uber', n: 168000, from_ts: '2026-02-06T00:00:00Z', to_ts: '2026-09-02T00:00:00Z' },
    { platform: 'fms', n: 30176, from_ts: '2026-05-13T00:00:00Z', to_ts: '2026-09-02T00:00:00Z' }],
  telemetry: [], earnings: [], earnings_gaps: [],
  alerts: [{ n: 262000, from_ts: '2026-05-23T00:00:00Z', latest: '2026-09-02T09:00:00Z' }],
  ledger: [{ n: 216, from_ts: '2026-08-14T00:00:00Z', latest: '2026-09-02T09:00:00Z' }],
  dataset_calendar: {
    alerts: { days_with_data: 30, first_day: '2026-05-23', last_day: '2026-09-02', median_rows_per_day: 3758,
      gaps: [{ from: '2026-06-06', to: '2026-08-17', days: 73 }], missing_days: 73, event_driven: true },
    ledger: { days_with_data: 18, first_day: '2026-08-14', last_day: '2026-09-02', median_rows_per_day: 12,
      gaps: [{ from: '2026-08-19', to: '2026-08-19', days: 1 }], missing_days: 2, event_driven: true },
  },
};
const CALENDAR = { sources: [
  { source: 'uber', days_with_data: 209, missing_days: 0, gaps: [], event_driven: false },
  { source: 'fms', days_with_data: 100, missing_days: 13, event_driven: false,
    gaps: [{ from: '2026-06-06', to: '2026-06-18', days: 13 }] },
] };
/* Jobs 8 and 1 as production holds them: abandoned by the requeue, which nulls
   started_at on the way past, and still carrying the progress they made. */
const JOBS = { jobs: [
  { id: '38', mode: 'incremental', status: 'done', requested_by: 'admin',
    requested_at: '2026-09-02T05:56:02.590Z', started_at: '2026-09-02T05:56:15.956Z',
    finished_at: '2026-09-02T06:03:35.391Z', error: null, attempts: 1, seconds: 439, progress: null },
  { id: '9', mode: 'backfill', status: 'queued', requested_by: 'admin',
    requested_at: new Date(Date.now() - 12 * 60000).toISOString(), started_at: null, finished_at: null,
    error: null, attempts: 1, seconds: null, progress: null },
  { id: '8', mode: 'backfill', status: 'failed', requested_by: 'unauthenticated',
    requested_at: '2026-08-24T07:10:05.211Z', started_at: null, finished_at: null,
    error: 'abandoned: restarted three times without completing a single source or collection window, '
      + 'so the job itself may be killing the collector',
    attempts: 5, seconds: null, running_seconds: null,
    progress: { done: 0, total: 8, steps: 7, current: 'uber', remaining: ['uberFleet', 'yango'],
      step: { of: 12, index: 6, window: '2026-01-26..2026-02-25', rows_so_far: 35829 } } },
  /* Never claimed by anything, no attempts, no progress: this one really did
     never start, and must keep saying so. */
  { id: '2', mode: 'probe', status: 'failed', requested_by: 'admin',
    requested_at: '2026-08-21T17:30:28.399Z', started_at: null, finished_at: null,
    error: 'no collector claimed it', attempts: 1, seconds: null, progress: null },
] };

const stub = {
  '/api/status': STATUS,
  '/api/coverage': COVERAGE,
  '/api/coverage/calendar': CALENDAR,
  '/api/rollups': [],
  '/api/cache-stats': null,
  '/api/settings/jobs': JOBS,
  '/api/settings': [{ key: 'UBER_WEB_COOKIE', label: 'Uber web session', group: 'Uber', value: '',
    configured: false, secret: true, seen_by: [] }],
  '/api/schema/raw-fields': { fields: [] },
};
const app = express();
app.use(express.static('api/public'));
app.use('/api', (req, res) => {
  const path = `/api${req.path}`;
  res.json(path in stub ? stub[path] : []);
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1500, height: 1400 } });
const open = async (hash) => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop#${hash}`, { waitUntil: 'domcontentloaded' });
};
const settle = async (needle) => {
  for (let i = 0; i < 60; i++) {
    const t = await page.evaluate(() => document.body.innerText);
    if (new RegExp(needle).test(t)) return t;
    await page.waitForTimeout(250);
  }
  return page.evaluate(() => document.body.innerText);
};
const flat = (s) => String(s).replace(/\s+/g, ' ');

/* ── the arithmetic, on its own ────────────────────────────────────────── */
console.log('\ncollection debt is counted in days, not in retries');
await open('sources');
const debt = await page.evaluate(async (rows) => {
  const m = await import('/app.js');
  return typeof m.collectionDebt === 'function' ? m.collectionDebt(rows) : null;
}, STATUS);
check('app.js exports the count so it can be checked', !!debt);
check('the raw retry rows are still reported as 111', debt?.entries === 111, String(debt?.entries));
check('…but the debt itself is 362 distinct source/fleet/days', debt?.days === 362, String(debt?.days));
check('the seven windows past Uber retention are held out of the count',
  debt?.unservable === 7 && debt?.unservableDays === 217,
  `${debt?.unservable} windows / ${debt?.unservableDays} days`);
check('…and none of them is attributed to a live feed',
  !(debt?.groups || []).some((g) => g.from < '2026-01-01'),
  JSON.stringify((debt?.groups || []).map((g) => g.from)));
check('the eight windows ending after their own run finished are dropped',
  debt?.invented === 8, String(debt?.invented));
check('the repeat asks are counted as repeats, not as more missing data',
  debt?.duplicates === 10, String(debt?.duplicates));
check('the biggest hole leads: FMS on each fleet, 113 days, not six rows',
  debt?.groups?.[0]?.days === 113 && debt?.groups?.[1]?.days === 113
    && debt.groups[0].source === 'fms' && debt.groups[0].fleet !== debt.groups[1].fleet,
  JSON.stringify(debt?.groups?.slice(0, 2)));
check('…and the dead Uber session is one entry per fleet at 37 days, not 44 rows',
  (debt?.groups || []).filter((g) => g.source === 'uber' && g.days === 37).length === 2,
  JSON.stringify((debt?.groups || []).filter((g) => g.source === 'uber')));
check('every group names its fleet', (debt?.groups || []).every((g) => g.fleet),
  JSON.stringify((debt?.groups || []).map((g) => g.fleet)));

/* ── Settings: what a backfill would recover ───────────────────────────── */
console.log('\nSettings says how much is owed, from whom, and what is gone for good');
await open('settings');
const setTxt = flat(await settle('outstanding across|Every collection window'));
check('the sentence no longer calls 111 retries 111 outstanding windows',
  !/111 windows did not land/.test(setTxt), setTxt.slice(0, 200));
check('it states the debt in days', /362 days of collection are outstanding/.test(setTxt),
  (setTxt.match(/[^.]*outstanding[^.]*/) || [''])[0].slice(0, 220));
check('…and still says how many times they were asked for', /refused 111 times/.test(setTxt),
  (setTxt.match(/[^.]*refused[^.]*/) || [''])[0].slice(0, 160));
check('the fleet is printed, so the two FMS entries are distinguishable',
  /FMS telematics · Ecosine/.test(setTxt) && /FMS telematics · Egari/.test(setTxt), setTxt.slice(0, 400));
check('…and the two are no longer the identical string twice over',
  !/(FMS telematics 1?4? ?[A-Za-z]* 2026 → 31 Aug 2026,? ?){2}/.test(setTxt));
check('no collector is named at the reader by its database key',
  !/uber_fleet/.test(setTxt), (setTxt.match(/[^:]*uber_fleet[^,]*/) || [''])[0]);
check('the permanently unservable days are separated out and named as such',
  /past the provider’s retention horizon/.test(setTxt)
    && /cannot serve these again/.test(setTxt), (setTxt.match(/A further[^.]*\./) || [''])[0].slice(0, 220));
check('…with their size, so the reader knows what pressing the button will not fix',
  /A further 217 days/.test(setTxt), (setTxt.match(/A further[^.]*/) || [''])[0].slice(0, 120));

/* ── Settings: a row with progress never claims it never started ───────── */
console.log('\na job that made progress does not say it never started');
// Wait for the job ROW, not for the panel heading: the jobs table is a second
// fetch and the heading is on the page before it lands.
const jobTxt = flat(await settle('35,829 rows so far'));
check('job 8 no longer says "never started" beside its five restarts and 35,829 rows',
  !/never started/.test(jobTxt.split('probe')[0]), jobTxt.slice(0, 300));
const cell = await page.evaluate(() => {
  const tr = [...document.querySelectorAll('tr')].find((r) => /35,829 rows so far/.test(r.innerText));
  return tr ? tr.innerText.replace(/\s+/g, ' ') : null;
});
check('…the row is found and its progress is on it', cell && /35,829 rows so far/.test(cell), String(cell));
check('…and the waited cell says the start time is not recorded',
  /not recorded/.test(cell || ''), String(cell));
check('a job that genuinely never ran still says so',
  /never started/.test(jobTxt), jobTxt.slice(-400));

/* ── Data sources: "partial" has to be true of both shapes ─────────────── */
console.log('\n"partial" no longer promises that rows were written');
await open('sources');
const srcTxt = flat(await settle('A "partial" run is one'));
check('no caption claims a partial run wrote rows',
  !/"partial" means the run wrote rows AND left windows unfetched/.test(srcTxt)
    && !/A "partial" run is one that wrote rows AND left windows unfetched/.test(srcTxt),
  (srcTxt.match(/[^.]*partial[^.]*/) || [''])[0].slice(0, 220));
check('the caption sends the reader to the column that would show it',
  /read the Rows column/.test(srcTxt), (srcTxt.match(/Last run per source[^]{0,300}/) || [''])[0]);
check('the two runs that wrote nothing at all are counted and named',
  /2 of these wrote nothing whatever/.test(srcTxt),
  (srcTxt.match(/A "partial" run[^]{0,260}/) || [''])[0]);

/* ── Data sources: the holes table and its arithmetic ──────────────────── */
console.log('\nthe windows table says what it is a table of');
const holeTxt = flat(await settle('refusals on record'));
check('the table reports both numbers rather than only the 111',
  /111 refusals on record, describing 362 days still owed/.test(holeTxt),
  (holeTxt.match(/[0-9]+ refusals[^.]*\./) || [''])[0]);
check('…and accounts for the rows that are not debt',
  /7 rows cannot be served again/.test(holeTxt) && /8 rows end after the run/.test(holeTxt),
  (holeTxt.match(/refusals on record[^]{0,300}/) || [''])[0]);
const standing = await page.evaluate(() => {
  // innerText applies the header's text-transform, so the cell reads "STANDING".
  const t = [...document.querySelectorAll('table')].find((x) => /standing/i.test(x.innerText));
  if (!t) return null;
  const rows = [...t.querySelectorAll('tbody tr')].map((r) => r.innerText.replace(/\s+/g, ' '));
  // .tag is upper-cased by the stylesheet, and innerText reports it that way.
  return { gone: rows.filter((r) => /gone for good/i.test(r)).length,
    notdue: rows.filter((r) => /not yet due/i.test(r)).length,
    fleets: [...new Set(rows.map((r) => (/Ecosine/.test(r) ? 'Ecosine' : /Egari/.test(r) ? 'Egari' : '—')))] };
});
check('every unservable row is marked gone for good, and every widened one as not yet due',
  standing && standing.gone === 7 && standing.notdue === 8, JSON.stringify(standing));
check('…and the fleet is a column, so two identical-looking rows are told apart',
  standing && standing.fleets.includes('Ecosine') && standing.fleets.includes('Egari'),
  JSON.stringify(standing));

/* ── Data sources: the coverage footnote agrees with the table above it ── */
console.log('\nthe coverage footnote does not contradict the column above it');
// The coverage table is the slowest panel on the page — /api/coverage groups
// the whole trip history — so wait for a cell of it, not for its heading.
const covTxt = flat(await settle('not a daily feed'));
check('nothing is described as missing days under a dash',
  !/— is missing/.test(covTxt), (covTxt.match(/[^.]*is missing[^.]*/) || [''])[0].slice(0, 200));
check('the event-driven alerts feed is not called a hole',
  !/is missing 73 days/.test(covTxt), (covTxt.match(/[^.]*73 days[^.]*/) || [''])[0].slice(0, 200));
check('…and the table still says of it that it is not a daily feed',
  /not a daily feed/.test(covTxt));
check('a real hole is still named, and by the name the table printed for it',
  /trips · FMS telematics is missing 13 days/.test(covTxt),
  (covTxt.match(/[^.]*is missing[^.]*/) || [''])[0].slice(0, 200));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
