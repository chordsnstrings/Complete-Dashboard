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
   A 401 with no cookie and a 403 with one is proof the session AUTHENTICATES.
   The message in that branch said exactly that and then told the operator to
   re-paste YANGO_COOKIE — work that cannot change the answer, since a fresh
   cookie for the same account authenticates the same way and is refused the
   same way. Measured on production 2026-09-03 against a cookie captured that
   morning and verified live by src/credcheck.js as a real fleet session. */
{
  const y = readFileSync('src/sources/yango.js', 'utf8');
  const branch = y.slice(y.indexOf('so the session IS'), y.indexOf('so the session IS') + 700);
  check('the session-is-read branch no longer prescribes a re-paste',
    !/re-paste YANGO_COOKIE from a logged-in/.test(branch),
    'it had just proved the session works');
  check('…it names entitlement, and the park it was refused for',
    /entitlement/.test(branch) && /parkId/.test(branch));
  check('…and says plainly that re-pasting will not change it',
    /will not change it/.test(branch));
  check('the account is read from the cookie so "sign in as somebody else" is actionable',
    /yandex_login=\(\[\^;\]\+\)/.test(y) && /const yangoAccount = /.test(y));
  check('and the credential blamed is not the cookie that just authenticated',
    /credential: cookieIsNotIt \|\| bare \? 'YANGO_PARK_ID' : 'YANGO_COOKIE'/.test(y),
    'a red row against a working credential sends somebody to replace it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
