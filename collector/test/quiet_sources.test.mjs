/* Three feeds stopped and every one of them said "ok / healthy".
   ─────────────────────────────────────────────────────────────────────────
   Read off production /api/status on 2026-09-02 11:30 UTC:

     ledger        ecosine import   ok  39,797 rows  finished 2026-08-24 09:00  (218.5 h)
     uber_timeline ecosine roster   ok  79,680 rows  finished 2026-08-27 07:31  (148.0 h)
     uber_timeline egari   roster   ok  52,358 rows  finished 2026-08-27 07:32  (148.0 h)
     uber_profile  ecosine profile  ok     113 rows  finished 2026-08-31 13:30  ( 46.0 h)
     uber_profile  egari   profile  ok      43 rows  finished 2026-08-31 13:31  ( 46.0 h)

   None of the three is on a broken schedule. /api/settings/jobs shows jobs
   18/19/20 `timeline-roster` finishing 07:11–07:32 on 27 Aug and job 34
   `profile` finishing 13:31:51 on 31 Aug — the exact timestamps above — so
   every one of those five rows was produced by a hand-queued job, and the
   collector's cron never wrote any of them. The ledger has no schedule at all:
   it is a CSV an operator pushes through bin/import-ledger.mjs.

   What is broken is that none of them can SAY any of that, and worse, that
   when they do fail they fail into somebody else's record. Measured on
   /api/auth the same minute:

     uber ecosine UBER_WEB_COOKIE  ok  surface="supplier graphql"  run_age 0.6h

   credential_state is keyed (provider, fleet_id, credential) — sql/schema_v33
   — and three surfaces write that one row: src/sources/uber.js as "supplier
   graphql", uber_timeline.js as "supplier chronicle timeline", uber_profile.js
   as "supplier graphql GetDriver". The half-hourly one wins, which is why the
   live row reads "supplier graphql". A chronicle session that died on Thursday
   is reset to green thirty minutes later by a surface that never called it,
   and /api/auth then measures its staleness against source `uber` (0.6 h old)
   rather than against `uber_timeline` (148 h old). src/sources/uber_fleet.js
   already does the right thing with the same cookie — it writes under provider
   `uber_fleet`, which is why /api/auth carries a separate row for it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* One fleet, so the assertions are about one run rather than about which of
   two ran last. */
process.env.UBER_ORG_UUID = '11111111-2222-3333-4444-555555555555';
process.env.UBER_WEB_COOKIE = 'sid=x; csid=y';
delete process.env.UBER_ORG_UUID_EGARI;
delete process.env.UBER_WEB_COOKIE_EGARI;

/* Everything the collector writes is captured where it actually goes through —
   pool.query — so what the checks read is what the module passed, not a stub
   standing in for it. */
const runs = [];
const notes = [];
let drivers = [];
const { pool } = await import('../src/db.js');
const route = async (text, params = []) => {
  const t = String(text);
  if (/INSERT INTO collection_run/i.test(t)) {
    runs.push({ source: params[0], fleet: params[1], mode: params[2], status: params[5],
      rows: params[6], error: params[7], chunks_total: params[8], chunks_failed: params[9] });
    return { rows: [{ id: runs.length }], rowCount: 1 };
  }
  if (/INSERT INTO credential_state/i.test(t)) {
    notes.push({ provider: params[0], fleet: params[1], credential: params[2],
      state: params[3], detail: params[4], surface: params[5] });
    return { rows: [], rowCount: 1 };
  }
  if (/driver_ext_id/i.test(t) && /^\s*SELECT/i.test(t)) {
    return { rows: drivers.map((d) => ({ driver_ext_id: d })), rowCount: drivers.length };
  }
  return { rows: [], rowCount: 0 };
};
pool.query = route;
/* upsertMany takes a client out of the pool and runs BEGIN/INSERT/COMMIT on
   it, so the fake pool needs a fake client too or every write throws. */
pool.connect = async () => ({ query: route, release() {} });

/* The provider, answering per driver. `fetch` rather than http(), because
   http() is imported by value into each collector and cannot be replaced from
   here — and driving the real http() also keeps its redirect/refusal handling
   in the test rather than around it. */
const realFetch = globalThis.fetch;
let answer = () => ({ data: {} });
globalThis.fetch = async (url, opts = {}) => {
  const body = JSON.parse(opts.body || '{}');
  const payload = answer(body);
  const text = JSON.stringify(payload);
  return { status: 200, ok: true, url: String(url), redirected: false,
    headers: new Map(), text: async () => text };
};

const EVENT = (ts) => ({ timestamp: String(ts), jobuuid: null, partnerUuid: null,
  activeVehicleUuid: null, status: 'ONLINE', offlineReason: null,
  rootLocation: { latitude: 25.2, longitude: 55.3 }, stateChange: [] });

console.log('\nthe driver-availability sweep, when the provider refuses some of the drivers');

{
  /* Four drivers; the first answers, the other three are refused. This is the
     ordinary shape of a session going stale — the portal keeps answering for
     whatever it has warm and refuses the rest — and it is the shape that must
     never read as a clean run. */
  runs.length = 0; notes.length = 0;
  drivers = ['d1', 'd2', 'd3', 'd4'];
  answer = (b) => (b.variables.driverUuid === 'd1'
    ? { data: { GetTimelineInfo: { timelineInfo: [EVENT(1756880000000)] } } }
    : { errors: [{ message: 'INTERNAL_SERVER_ERROR' }] });
  const { collect } = await import('../src/sources/uber_timeline.js');
  await collect({ from: new Date('2026-08-31'), to: new Date('2026-09-02'), mode: 'timeline' });

  const r = runs.find((x) => x.source === 'uber_timeline');
  check('a sweep that was refused for three drivers in four is not "ok"',
    r && r.status === 'partial', `status=${r?.status} rows=${r?.rows}`);
  check('…and it says how many were refused, because the Data-sources page '
    + 'prints the error column and nothing else',
    /3\b/.test(String(r?.error || '')) && /4\b/.test(String(r?.error || '')),
    String(r?.error));
}

{
  /* Every driver refused. logRun's own rule (src/db.js) is that a pass which
     failed everything is 'error' — "there is no part" — and the Data-sources
     page's TAG map knows exactly ok/partial/error. */
  runs.length = 0; notes.length = 0;
  drivers = ['d1', 'd2'];
  answer = () => ({ errors: [{ message: 'INTERNAL_SERVER_ERROR' }] });
  const { collect } = await import('../src/sources/uber_timeline.js');
  await collect({ from: new Date('2026-08-31'), to: new Date('2026-09-02'), mode: 'timeline' });

  const r = runs.find((x) => x.source === 'uber_timeline');
  check('a sweep refused for every driver is an error, in the vocabulary the '
    + 'page colours (ok | partial | error)',
    r && r.status === 'error', `status=${r?.status}`);
  const n = notes.at(-1);
  check('the refusal is recorded against the timeline surface, not against the '
    + 'half-hourly supplier-graphql row that would overwrite it',
    n && n.provider === 'uber_timeline',
    `provider=${n?.provider} surface=${n?.surface}`);
  check('…still naming the cookie a person would actually replace',
    n && n.credential === 'UBER_WEB_COOKIE', String(n?.credential));
}

{
  /* And the green half: a working sweep has to be able to clear the row it
     reddened, or the banner can only ever go red once. */
  runs.length = 0; notes.length = 0;
  drivers = ['d1'];
  answer = () => ({ data: { GetTimelineInfo: { timelineInfo: [EVENT(1756880000000)] } } });
  const { collect } = await import('../src/sources/uber_timeline.js');
  await collect({ from: new Date('2026-08-31'), to: new Date('2026-09-02'), mode: 'timeline' });
  const n = notes.at(-1);
  check('a sweep that worked clears the timeline row it would have reddened',
    n && n.provider === 'uber_timeline' && n.state === 'ok',
    `provider=${n?.provider} state=${n?.state}`);
}

console.log('\nthe weekly profile pull');

{
  /* No roster at all. This is not a fleet of unrated drivers; it is a pass
     that could not start. It returned {drivers:0} with no `failed` key, and
     `r.failed ? 'partial' : 'ok'` on an absent key is 'ok'. */
  runs.length = 0; notes.length = 0;
  drivers = [];
  const { collect } = await import('../src/sources/uber_profile.js');
  await collect({ mode: 'profile' });
  const r = runs.find((x) => x.source === 'uber_profile');
  check('a pull with no roster to pull is not a successful pull',
    r && r.status === 'error', `status=${r?.status} rows=${r?.rows} error=${r?.error}`);
  check('…and says so, rather than leaving the Detail column reading "healthy"',
    /roster/i.test(String(r?.error || '')), String(r?.error));
}

{
  /* Every driver refused by the provider — not an auth refusal, so the pass
     runs to the end and reports itself. rows_written 0 with status 'partial'
     is the exact shape src/db.js calls out as unsayable. */
  runs.length = 0; notes.length = 0;
  drivers = ['d1', 'd2', 'd3'];
  answer = () => ({ errors: [{ message: 'INTERNAL_SERVER_ERROR' }] });
  const { collect } = await import('../src/sources/uber_profile.js');
  await collect({ mode: 'profile' });
  const r = runs.find((x) => x.source === 'uber_profile');
  check('a profile pass refused for every driver is an error, not a partial '
    + 'that wrote nothing', r && r.status === 'error' && !r.rows,
    `status=${r?.status} rows=${r?.rows}`);
}

{
  /* A pass that worked. uber_profile has only ever written a credential row on
     failure, so once it goes red nothing it can do makes it green again —
     "a banner that can only ever go red never goes green again", which is the
     rule src/auth_state.js states for the REST surfaces. */
  runs.length = 0; notes.length = 0;
  drivers = ['d1', 'd2'];
  answer = () => ({ data: { getDriver: { driver: {
    uuid: 'd1',
    member: { user: { uuid: 'u1', driverInfo: { completedTripsCount: 8998, recognitionRating: 4.97 }, isBanned: false } },
    associatedVehicles: [], complianceInfo: { status: 'ACTIVE' } } } } });
  const { collect } = await import('../src/sources/uber_profile.js');
  await collect({ mode: 'profile' });
  const r = runs.find((x) => x.source === 'uber_profile');
  check('a profile pass that worked is ok', r && r.status === 'ok' && r.rows === 2,
    `status=${r?.status} rows=${r?.rows}`);
  const n = notes.at(-1);
  check('…and records the working session, so the row can go green again',
    n && n.state === 'ok', `state=${n?.state}`);
  check('under its own provider, so it neither erases nor is erased by the '
    + 'half-hourly supplier-graphql row',
    n && n.provider === 'uber_profile', `provider=${n?.provider}`);
}

console.log('\nthe operator ledger, which is an import and not a poll');

{
  /* api/server.js records the import with
       SELECT $1,'ecosine','import','ok', count(*), now()
         FROM driver_statement_day WHERE source = $1
     — a count of the WHOLE table under a hard-coded fleet. That is where the
     39,797 on /api/status comes from: it is how many statement-days are held
     in total, not how many the 24 Aug import wrote, and it is attributed to
     Ecosine whatever companies the workbook actually named. A row count that
     never falls cannot say "this import landed nothing". */
  globalThis.fetch = realFetch;
  const db = new PGlite();
  await applySchema(db);
  pool.query = (t, p) => db.query(t, p);
  const { recordImport, CADENCE, spanOf, silence } = await import('../src/sources/ledger.js');

  const span = spanOf([{ date: '2026-02-08' }, { date: '2025-11-01' }, { date: 'not a date' }]);
  check('the span of an import comes off the rows themselves, as ISO days',
    span.first === '2025-11-01' && span.last === '2026-02-08', JSON.stringify(span));

  const ids = await recordImport({
    db, rows: { ecosine: 300, egari: 112 }, days: span,
  });
  const rows = (await db.query(
    'SELECT * FROM collection_run WHERE source = $1 ORDER BY fleet_id', ['ledger'])).rows;
  check('an import records what THIS import wrote, not the size of the table',
    rows.length === 2 && rows[0].rows_written === 300 && rows[1].rows_written === 112,
    rows.map((r) => `${r.fleet_id}:${r.rows_written}`).join(' '));
  check('one run per fleet the workbook actually named, not a hard-coded ecosine',
    rows.map((r) => r.fleet_id).join(',') === 'ecosine,egari',
    rows.map((r) => r.fleet_id).join(','));
  check('and the run carries the days the import covers, so "nobody has '
    + 'imported one" is distinguishable from "the importer is broken"',
    rows.every((r) => r.window_start && r.window_end
      && r.window_start.toISOString().slice(0, 10) === '2025-11-01'),
    rows.map((r) => String(r.window_start && r.window_start.toISOString().slice(0, 10))).join(' '));
  check('recordImport hands back the run ids it wrote', Array.isArray(ids) && ids.length === 2,
    JSON.stringify(ids));

  /* An import that landed nothing is the case the count(*) form can never
     report: the table still holds 39,797 rows, so the run says 39,797. */
  await recordImport({ db, rows: {}, days: { first: null, last: null } });
  const blank = (await db.query(
    "SELECT status, rows_written, error FROM collection_run WHERE source='ledger' ORDER BY id DESC LIMIT 1")).rows[0];
  check('an import that wrote nothing says so', blank.rows_written === 0 && blank.status === 'error',
    `${blank.status} rows=${blank.rows_written}`);

  check('the ledger declares that it has no schedule, so a reader can tell a '
    + 'quiet importer from a broken one',
    CADENCE && CADENCE.scheduled === false && CADENCE.expect_every_h === null,
    JSON.stringify(CADENCE));

  /* The two sentences that "ok / healthy" collapses into one. */
  const idle = silence({ finished_at: '2026-08-24T09:00:09.118Z', status: 'ok',
    window_end: '2026-02-08' }, Date.parse('2026-09-02T11:30:00Z'));
  check('nine days with no import reads as nobody having imported one',
    idle.state === 'idle' && /9 day/.test(idle.sentence) && /Nothing schedules this/.test(idle.sentence),
    idle.sentence);
  const broke = silence({ finished_at: '2026-09-02T09:00:00Z', status: 'error',
    error: 'every row was rejected' }, Date.parse('2026-09-02T11:30:00Z'));
  check('…and an import that ran and wrote nothing reads as a broken importer',
    broke.state === 'broken' && /rejected/.test(broke.sentence), broke.sentence);
  check('a table nobody has ever imported into is neither', silence(null).state === 'never');

  /* The day, as the date the column holds. A pg DATE arrives as a Date object,
     and `String(aDate).slice(0, 10)` is "Fri Aug 21" — which is what this
     sentence printed on production within the hour of shipping. Driven under a
     zone thirteen hours EAST of UTC, where local midnight is the previous day
     in UTC, so a toISOString() fix would fail here too. */
  {
    const tz = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    const { isoDay: iso2, silence: silence2 } = await import('../src/sources/ledger.js?tzcase');
    const asDate = new Date(2026, 7, 21);   // local midnight on 21 August
    check('a DATE column reads back as the day it holds, not as "Fri Aug 21"',
      iso2(asDate) === '2026-08-21', String(iso2(asDate)));
    check('...and a string day is left alone', iso2('2026-08-21T00:00:00.000Z') === '2026-08-21');
    check('...and null is null, not the string "null"', iso2(null) === null);
    const said = silence2({ finished_at: '2026-08-24T09:00:09.118Z', status: 'ok',
      window_end: asDate }, Date.parse('2026-09-02T11:30:00Z')).sentence;
    check('so the sentence names a date rather than a weekday fragment',
      /covering days up to 2026-08-21\./.test(said), said);
    process.env.TZ = tz;
  }

  await db.close();
}

console.log('\nwhat src/index.js actually schedules');

{
  /* Read, not edited — src/index.js belongs to another agent. This pins the
     diagnosis so that scheduling the roster sweep later has to come with a
     change here. */
  const idx = readFileSync('src/index.js', 'utf8');
  const crons = [...idx.matchAll(/cron\.schedule\(([^;]*?)\)\s*;/gs)].map((m) => m[1]);
  check('nothing schedules the whole-roster timeline sweep — it is a command '
    + 'and an on-demand job only',
    !crons.some((c) => /roster/.test(c)),
    crons.filter((c) => /roster/.test(c)).join(' | '));
  check('nothing schedules a ledger import — it is an operator CSV pushed '
    + 'through bin/import-ledger.mjs',
    !/ledger/i.test(idx));
  check('the profile pull is weekly, on a Monday', /cron\.schedule\('20 0 \* \* 1'/.test(idx));
}

console.log(`\n${pass} passed, ${fail} failed`);
globalThis.fetch = realFetch;
process.exit(fail ? 1 : 0);
