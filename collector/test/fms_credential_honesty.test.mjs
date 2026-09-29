/* FMS could be refused for its CREDENTIAL and say nothing at all.
   ────────────────────────────────────────────────────────────────────────────
   Five sources learned to record which credential was refused — uber, yango,
   bolt, hotel and cabman — so the Settings panel can name what to re-paste.
   `grep -n noteCredential src/sources/fms.js` returned nothing, and FMS is the
   only source with TWO logins (one InfoTrack account per fleet) and the deepest
   history behind them.

   The refusal shape is already measured, in src/probe.js:

     "FMS answers {"error":"Authentication failed"} with a 200, and the probe
      recorded {ok:true, record_count:0, top_keys:["error"]}"

   A 200. So the collector's own `data?.Data || []` turns a rejected password
   into a window that was asked and answered with nothing — the same silence
   that hid six months of 2025 before the status check landed, except this one
   survives the status check because the status is 200.

   And there is a second refusal on the same operations that is NOT a
   credential problem at all: the HTTP 400 the response-size ceiling produces,
   measured at 31/25/21/14 days per fleet in the header of collectTripWindow
   and per-day for alerts in FMS_ALERT_MAX_DAYS. A collector that recorded a
   credential failure for THAT would paint the banner red and tell an operator
   to re-paste a password that is working perfectly — on every busy month of
   every backfill. Telling the two apart is the whole point of this file. */
import { readFileSync } from 'node:fs';
import { dateChunks, dotDate, iso, parseFmsTime } from '../src/util.js';
import { saysAuth } from '../src/auth_state.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const DAY = 864e5;
const D = (s) => new Date(`${s}T00:00:00Z`);
const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY) + 1;
const fmsStamp = (dayISO) => `${dayISO.slice(8, 10)}/${dayISO.slice(5, 7)}/${dayISO.slice(0, 4)} 08:00:00`;

/* ── the service, in the three moods that matter ──────────────────────────── */
const ROWS_PER_DAY = 200;
const CEILING = 4600;          // the measured response-size refusal, as a 400

// 'ok' | 'auth' — per fleet, so one account can be rejected while the other works.
let mood = { ecosine: 'ok', egari: 'ok' };
let asked = [];
const notes = [];
/* Counted per FLEET as well as per table: the whole property under test in
   case 1 is that one dead account costs its own history and nobody else's, and
   a single total cannot say that. */
let written = {};
const wrote = (table, fleet) => written[`${table}:${fleet}`] || 0;

function service(op, fleet, from, to) {
  /* The measured credential refusal: HTTP 200, and a body whose only key is an
     error key. src/probe.js quotes it verbatim. */
  if (mood[fleet] === 'auth') return { status: 200, ok: true, data: { error: 'Authentication failed' } };
  const days = dayCount(from, to);
  // The measured size refusal: a 400, on a window that is simply too wide.
  if (days * ROWS_PER_DAY > CEILING) return { status: 400, ok: false, data: { Message: 'too large' } };
  const Data = [];
  for (let i = 0; i < days; i++) {
    const d = iso(new Date(Date.parse(from) + i * DAY));
    for (let n = 0; n < ROWS_PER_DAY; n++) {
      Data.push(op === 'GetAlertData'
        ? { 'Plate No': `P${n % 90}`, 'Alert Name': `A${n % 7}`,
            'Alert Date Time': fmsStamp(d), 'Start Location': 'x' }
        : { 'Plate No': `P${n % 90}`, 'Start Time': fmsStamp(d), 'End Time': fmsStamp(d),
            'Start Location': 'x', 'End Location': 'y', StartLat: 25, StartLon: 55,
            EndLat: 25, EndLon: 55, 'Total Travel Distance': 4, 'Seat Count': 1 });
    }
  }
  return { status: 200, ok: true, data: { Data } };
}

/* ── the SHIPPED collector, with its imports replaced ─────────────────────── */
/* Mutated in place, never reassigned: the prelude below destructures `config`
   once at module load, so a fresh array would never be seen by the collector. */
const fleets = [];
globalThis.__FMS_CRED_TEST__ = {
  config: { fms: { base: 'http://fms.test/ItlService.svc', fleets } },
  normPlate: (p) => (p ? String(p).toUpperCase() : null),
  qs: (o) => new URLSearchParams(o).toString(),
  http: async (url) => {
    const u = new URL(url);
    const op = u.pathname.split('/').pop();
    const dot = (k) => (u.searchParams.get(k) || '').replace(/\./g, '-');
    const fleet = u.searchParams.get('username') === 'e' ? 'ecosine' : 'egari';
    const from = dot('fromdate'), to = dot('todate');
    asked.push({ op, fleet, from, to, days: dayCount(from, to) });
    return service(op, fleet, from, to);
  },
  upsertMany: async (table, rows) => {
    for (const r of rows) {
      const k = `${table}:${r.fleet_id}`;
      written[k] = (written[k] || 0) + 1;
    }
    return rows.length;
  },
  logRun: async () => {},
  // The real pool is never reached; what matters is that the collector hands
  // noteCredential a db handle and the row it would have written.
  pool: { query: async () => ({ rows: [] }) },
  noteCredential: async (_db, note) => { notes.push(note); },
  saysAuth,
  dateChunks, dotDate, iso, parseFmsTime,
  log: { info() {}, warn() {}, error() {} },
};

const shipped = readFileSync('src/sources/fms.js', 'utf8');
const stripped = shipped.replace(/^import [^\n]*from '\.\.[^\n]*';$/gm, '');
if (/^import /m.test(stripped)) throw new Error('an import survived the rewrite — the stubs are not in force');
const prelude = 'const { config, normPlate, http, qs, upsertMany, logRun, pool, noteCredential,'
  + " saysAuth, dateChunks, dotDate, iso, parseFmsTime, log } = globalThis.__FMS_CRED_TEST__;\n";
const mod = await import(`data:text/javascript;base64,${Buffer.from(prelude + stripped).toString('base64')}`);

const reset = () => {
  asked = []; notes.length = 0; written = {};
  mood = { ecosine: 'ok', egari: 'ok' };
  fleets.splice(0, fleets.length,
    { fleet: 'ecosine', username: 'e', password: 'p' },
    { fleet: 'egari', username: 'g', password: 'p' });
};

/* ── 1. a rejected password is not a quiet month ──────────────────────────── */
console.log('\na refused FMS login names the credential rather than reading as an empty window');
{
  reset();
  mood.ecosine = 'auth';
  await mod.collect({ from: D('2026-08-01'), to: D('2026-08-05'), mode: 'incremental' });
  const mine = notes.filter((n) => n.provider === 'fms' && n.fleet === 'ecosine');
  check('the refused fleet has a credential note at all',
    mine.length > 0, JSON.stringify(notes));
  check('…recorded as invalid, not missing — a password was supplied and rejected',
    mine.length > 0 && mine.every((n) => n.state === 'invalid'),
    JSON.stringify(mine.map((n) => n.state)));
  check('…against the settings key an operator would actually re-paste',
    mine.length > 0 && mine.every((n) => n.credential === 'FMS_ECOSINE_PASS'),
    JSON.stringify(mine.map((n) => n.credential)));
  check('…quoting what FMS said, because "Authentication failed" is the whole diagnosis',
    mine.some((n) => /Authentication failed/i.test(String(n.detail || ''))),
    JSON.stringify(mine.map((n) => n.detail)));
  check('…and naming the operation it was refused on',
    mine.some((n) => /GetTripPassenger|GetAlertData/.test(String(n.surface || ''))),
    JSON.stringify(mine.map((n) => n.surface)));
  check('the refused fleet writes no rows, rather than zero rows that look like an answer',
    wrote('trip', 'ecosine') === 0 && wrote('alert', 'ecosine') === 0,
    `trip ${wrote('trip', 'ecosine')} alert ${wrote('alert', 'ecosine')}`);
  /* One account being dead must not cost the other its history — the same
     property bolt.js holds for its two refresh tokens. */
  check('the other fleet is untouched by it, and still collects',
    !notes.some((n) => n.fleet === 'egari') && wrote('trip', 'egari') > 0,
    `${wrote('trip', 'egari')} egari trips; ${JSON.stringify(notes.filter((n) => n.fleet === 'egari'))}`);
}

/* ── 2. a credential that was never supplied ──────────────────────────────── */
console.log('\nand a password that was never configured is a different message');
{
  reset();
  fleets.splice(0, fleets.length,
    { fleet: 'ecosine', username: 'e', password: 'p' },
    { fleet: 'egari', username: 'g', password: null });
  await mod.collect({ from: D('2026-08-01'), to: D('2026-08-03'), mode: 'incremental' });
  const eg = notes.filter((n) => n.fleet === 'egari');
  check('the unconfigured fleet is recorded as missing, not as a refusal',
    eg.length > 0 && eg.every((n) => n.state === 'missing'),
    JSON.stringify(eg));
  check('…naming its own key rather than the other fleet\'s',
    eg.length > 0 && eg.every((n) => n.credential === 'FMS_EGARI_PASS'),
    JSON.stringify(eg.map((n) => n.credential)));
  check('…and it is not asked for anyway',
    !asked.some((a) => a.fleet === 'egari'), JSON.stringify(asked.slice(0, 2)));
}

/* ── 3. the 400 that is NOT a credential problem ──────────────────────────── */
console.log('\nbut an oversized window is a size, and must never be blamed on the password');
{
  reset();
  // Thirty-one days at 200 rows a day is 6,200 records — over the ceiling, so
  // the first ask of every month is a 400. This is the ordinary shape of a
  // backfill, not a fault: collectTripWindow halves it and collectAlertWindow
  // walks its days, and both then answer.
  await mod.collect({ from: D('2026-07-01'), to: D('2026-08-31'), mode: 'backfill' });
  check('the oversized ask really happened, or this test proves nothing',
    asked.some((a) => a.days > 20), JSON.stringify(asked.slice(0, 3)));
  check('a size refusal records NO credential note',
    notes.length === 0,
    `a red banner on every busy month of every backfill: ${JSON.stringify(notes.slice(0, 3))}`);
  check('…and the rows still land, because the split is what a 400 means here',
    wrote('trip', 'ecosine') > 0 && wrote('alert', 'ecosine') > 0,
    `trip ${wrote('trip', 'ecosine')} alert ${wrote('alert', 'ecosine')}`);
}

/* ── 4. the two refusals arriving in the same run ─────────────────────────── */
console.log('\nand the two are told apart when both happen at once');
{
  reset();
  mood.egari = 'auth';
  await mod.collect({ from: D('2026-07-01'), to: D('2026-08-31'), mode: 'backfill' });
  check('only the fleet whose login was rejected is named',
    notes.length > 0 && notes.every((n) => n.fleet === 'egari' && n.state === 'invalid'),
    JSON.stringify(notes.map((n) => `${n.fleet}:${n.state}`)));
  check('…and the fleet that merely hit the size ceiling collected normally',
    wrote('trip', 'ecosine') > 0 && wrote('alert', 'ecosine') > 0,
    `trip ${wrote('trip', 'ecosine')} alert ${wrote('alert', 'ecosine')}`);
}

/* ── 5. a refusal is not retried in halves ────────────────────────────────── */
console.log('\na rejected login is not answered by asking sixty-two more times');
{
  reset();
  mood.ecosine = 'auth';
  const before = asked.length;
  await mod.collect({ from: D('2026-07-01'), to: D('2026-07-31'), mode: 'backfill' });
  const eco = asked.slice(before).filter((a) => a.fleet === 'ecosine');
  /* One month, two surfaces. If the auth refusal fell through to the size
     splitter the month would be halved and re-halved, and the alert month
     would be walked day by day — thirty-odd requests to be told the same
     thing by a service that has already said the password is wrong. */
  check('the refused fleet is asked at most twice for a single month',
    eco.length <= 2, `${eco.length} requests: ${JSON.stringify(eco.map((a) => a.days))}`);
}

/* ── a credential that can only ever go red is not a state ────────────────
   This file wrote 'invalid' and 'missing' and never once 'ok', on purpose: the
   comment above noteFmsRefusal argued that a provider answering 200 on a
   refusal cannot prove itself by answering 200. True of the STATUS, and false
   of the userid — FMS hands one back only when the password was accepted, so
   it is the evidence a refusal cannot manufacture.

   What the omission cost, measured on production 2026-09-03: both FMS
   passwords were replaced, the collector immediately pulled 13,344 rows for
   Ecosine and 16,269 for Egari and recorded ok on both runs — while /api/auth
   went on reporting FMS_ECOSINE_PASS and FMS_EGARI_PASS invalid from the
   previous day, and the banner counted two working credentials among five that
   had "stopped working". */
{
  const src = readFileSync('src/sources/fms.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('a working FMS login is recorded, not only a refused one',
    /state: 'ok'/.test(code) && /surface: 'Login'/.test(code),
    'nothing else ever cleared the red, so a fixed password stayed invalid for ever');
  check('…and it is gated on the userid, not on the status',
    /const userid = login\.data\?\.userid;[\s\S]{0,80}if \(!userid\) return 0;[\s\S]{0,600}state: 'ok'/.test(code),
    'this provider answers 200 when it refuses, so a 200 proves nothing and a userid proves it');
  check('the refusal path still records invalid',
    /state: 'invalid'/.test(code) && /the InfoTrack login for this fleet was refused/.test(src));
}

/* ── and the Yango advice must not contradict its own finding ─────────────
   This group began as "a 401 with no cookie and a 403 with one is proof the
   session AUTHENTICATES, so do not tell anybody to re-paste it". The first
   half turned out to be false (2026-09-29): the 403 is Yandex's edge and the
   401 is Yango's API — two different machines — so the pair never proved the
   session was read, and the cookie was painted green on it for three weeks.
   The cookie-free comparison is gone and each answer is read for what it is
   (src/sources/yango.js readConsoleAnswer).

   The second half stands and is what this group still guards: a refusal that
   is not about a credential must not send an operator to replace one — not
   the cookie, not the park id, not the API key — and a state's errand must
   match what was refused. Driven through readConsoleAnswer rather than
   matched against a slice of source, which is how the old version of this
   group went stale. */
{
  const y = readFileSync('src/sources/yango.js', 'utf8');
  const { readConsoleAnswer } = await import('../src/sources/yango.js');
  const edge = readConsoleAnswer({ status: 403, data: '<!DOCTYPE html><html><title>403</title></html>' });
  const park = readConsoleAnswer({ status: 403, data: { code: 'forbidden', message: 'park' } });
  check('nothing in the collector prescribes a re-paste for a refusal the session is not in',
    !/re-paste YANGO_COOKIE from a logged-in/.test(y));
  check('an edge refusal names this server as what is refused, and no credential',
    /refusing this server/.test(edge.why) && !/YANGO_(COOKIE|PARK_ID|API_KEY)/.test(edge.why), edge.why);
  check('…and the panel is told plainly that re-pasting cannot change it',
    /[Rr]e-pasting cannot change that/.test(y));
  check('the account is read from the cookie so "sign in again as …" is actionable',
    /yandex_login=\(\[\^;\]\+\)/.test(y) && /const yangoAccount = /.test(y));
  /* The cookie is 'ok' only on an answer. The asymmetry that used to earn it
     was not evidence; see the head of this group. */
  const answers = [
    [{ status: 200, data: { items: [] } }, 'ok'],
    [{ status: 403, data: '<html>edge</html>' }, 'unknown'],
    [{ status: 403, data: { code: 'forbidden' } }, 'unknown'],
    [{ status: 401, data: { code: 'unauthorized' } }, 'expired'],
    [{ status: 502, data: {} }, 'unknown'],
  ];
  check('the cookie is recorded as working only when the console answered',
    answers.every(([r, want]) => readConsoleAnswer(r).cookie === want),
    JSON.stringify(answers.map(([r]) => readConsoleAnswer(r).cookie)));
  /* The credential blamed is not the park id, which fleet-api.yango.tech
     proves on every run: two writers on one row means the last decides the
     colour, and the console runs last. */
  const consoleRow = /credential: 'YANGO_CONSOLE'/.test(y);
  check('and the credential blamed is never the park id, which the key host proves every run',
    consoleRow && !/credential: 'YANGO_PARK_ID'[\s\S]{0,80}state: v\./.test(y),
    'a red row against a working credential sends somebody to replace it');
  check('…and the park id is proven by the host that serves the collector, not by this one',
    /credential,\s*\n?\s*state: 'ok'/.test(y) || /for \(const credential of \['YANGO_API_KEY', 'YANGO_PARK_ID'\]\)/.test(y),
    'nothing else would ever turn those rows green again');
  check('…in a state whose errand is not "replace it": the edge is blocked, the park unentitled',
    edge.console === 'blocked' && park.console === 'unentitled', JSON.stringify([edge.console, park.console]));
  check('…and an API refusal of the park is not described as the edge, because it is not one',
    park.kind !== 'edge' && !/edge/i.test(park.why), park.why);
  {
    const { ERRANDS } = await import('../api/auth_routes.js');
    check('…which the banner has a written errand for', !!ERRANDS.blocked,
      Object.keys(ERRANDS).join(', '));
    check('…and that errand no longer claims the credential authenticates',
      !/authenticat/.test(ERRANDS.blocked.whole(1)), ERRANDS.blocked.whole(1));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
