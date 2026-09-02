/* A row's date is not the first ten characters of anything.
   ─────────────────────────────────────────────────────────────────────────
   node-postgres hands back a JavaScript Date for both DATE and TIMESTAMPTZ,
   and the two need OPPOSITE treatment:

     DATE      → a Date at LOCAL midnight. Its local components are the date
                 the column holds. toISOString() converts it as an instant, so
                 east of UTC it names the day before.
     TIMESTAMPTZ → a Date at the instant. toISOString() converts it correctly
                 and gives the UTC day, which is the wrong QUESTION: the fleet
                 works Asia/Dubai and every calendar key in this product is
                 `AT TIME ZONE 'Asia/Dubai'`.

   api/server.js had one of each, and one of them was live wrong. Measured on
   production 2026-09-02:

     GET /api/coverage      trips[]         uber from_ts "2025-04-04T23:12:38.000Z"
     GET /api/coverage      earnings_gaps[] uber trips_from   "2025-04-04"
     GET /api/performer/weeks               first_booking     "2025-04-05"

   23:12:38Z is 03:12 on the 5th in Dubai. One trip, two endpoints, two
   different first days — and the one that was right reads trip_norm.local_day,
   which is `(requested_at AT TIME ZONE 'Asia/Dubai')::date`.

   test/timezone.test.mjs guards the SQL side and the browser side. This guards
   the third: what the server does to a Date AFTER the driver has parsed it.

   Why this file exists at all rather than a shared import: test/mount.mjs
   mounts api/server.js by slicing its source between the section markers and
   evaluating that with `new Function`, so a name bound by a module-level
   import is not in scope inside the slice. Measured — importing isoDay and
   calling it in /api/trend/monthly answered
   `500 {"error":"internal","detail":"ReferenceError: isoDay is not defined"}`
   in the harness while production was fine. So server.js carries its own
   copies, inside the slice, and section 1 below pins them to the originals so
   the copies cannot drift from what they are copies of. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { readFileSync } from 'node:fs';
import { isoDay as ledgerIsoDay } from '../src/sources/ledger.js';
import { dubaiIso as utilDubaiIso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync('api/server.js', 'utf8');

/* ── 1. the copies in server.js ARE the originals ──────────────────────── */
/* Lifted out of the file rather than reimplemented here, for the same reason
   test/aggregates.test.mjs lifts its SQL: a second hand-written copy in the
   test would drift in exactly the way this section exists to prevent. */
const helperSrc = src.slice(
  src.indexOf('const isoDay = (v) => {'),
  src.indexOf("app.get('/api/kpis'"));
if (!helperSrc || !/const dubaiIso =/.test(helperSrc)) {
  throw new Error('could not find the isoDay/dubaiIso helpers in api/server.js — '
    + 'if they moved or were renamed, this guard is checking nothing');
}
// eslint-disable-next-line no-new-func
const { isoDay, dubaiIso } = new Function(`${helperSrc}; return { isoDay, dubaiIso };`)();

/* /api/trend/monthly spells its month key out inline instead of calling the
   isoDay above it, because test/trend_gaps.test.mjs mounts that route ALONE —
   it slices from `app.get('/api/trend/monthly'`, so nothing declared earlier
   in the file is in scope and the route answered
   `500 ReferenceError: isoDay is not defined` in that harness. Measured. That
   makes it a third copy, so it is pinned here like the other two.

   Reported as a failed check rather than thrown, unlike the helpers above: the
   likeliest regression here is somebody putting toISOString back, and a file
   that dies on the way in names the file instead of naming the line. */
const keyAt = src.indexOf('  const key = (d) => {');
const keySrc = keyAt < 0 ? '' : src.slice(keyAt, src.indexOf('  const byMonth = new Map('));
check('the month key in /api/trend/monthly reads the Date’s own calendar fields',
  /getFullYear\(\)/.test(keySrc) && !/toISOString/.test(keySrc),
  keySrc.replace(/\s+/g, ' ').slice(0, 120));
// eslint-disable-next-line no-new-func
const monthKey = /getFullYear\(\)/.test(keySrc) ? new Function(`${keySrc}; return key;`)() : null;

check('server.js defines both helpers inside the slice test/mount.mjs evaluates',
  src.indexOf('const isoDay = (v) => {') > src.indexOf('overview ─'),
  `${src.indexOf('const isoDay = (v) => {')} vs ${src.indexOf('overview ─')}`);

{
  /* A DATE at local midnight for each, built the way node-postgres builds one
     — new Date(y, m, d) is local, which is the whole point. */
  const dates = [new Date(2026, 1, 6), new Date(2026, 2, 1), new Date(2025, 11, 31),
    new Date(2026, 8, 2)];
  check('server.js isoDay agrees with src/sources/ledger.js on a DATE',
    dates.every((d) => isoDay(d) === ledgerIsoDay(d)),
    JSON.stringify(dates.map((d) => [isoDay(d), ledgerIsoDay(d)])));
  check('…and on a string, which it must pass through untouched',
    isoDay('2026-02-06') === ledgerIsoDay('2026-02-06') && isoDay('2026-02-06') === '2026-02-06',
    isoDay('2026-02-06'));
  check('…and on null, which must not throw',
    isoDay(null) === ledgerIsoDay(null) && isoDay(null) === null, String(isoDay(null)));

  check('the /api/trend/monthly month key agrees with isoDay sliced to a month',
    !!monthKey && dates.every((d) => monthKey(d) === ledgerIsoDay(d).slice(0, 7)),
    JSON.stringify(dates.map((d) => [monthKey?.(d), ledgerIsoDay(d).slice(0, 7)])));
  check('…and passes a string month through, which the statement span hands it',
    monthKey?.('2026-02-06') === '2026-02', String(monthKey?.('2026-02-06')));

  const instants = ['2025-04-04T23:12:38.000Z', '2026-09-02T17:10:59.000Z',
    '2026-08-05T19:59:59.999Z', '2026-08-05T20:00:00.000Z', '2026-01-01T00:00:00.000Z'];
  check('server.js dubaiIso agrees with src/util.js on every instant',
    instants.every((s) => dubaiIso(new Date(s)) === utilDubaiIso(new Date(s))),
    JSON.stringify(instants.map((s) => [dubaiIso(new Date(s)), utilDubaiIso(new Date(s))])));
}

/* ── 2. the exact production failure, with the production parser ────────
   PGlite parses a DATE at UTC MIDNIGHT; node-postgres parses it at LOCAL
   midnight. That difference is why no route test in this suite can reach this
   bug and why the suite stayed green over it — so the parser production runs
   is driven directly here, under the zone the fleet works in. */
{
  process.env.TZ = 'Asia/Dubai';
  const types = (await import('pg-types')).default;
  const parseDate = types.getTypeParser(1082);           // 1082 = DATE

  const d = parseDate('2026-02-06');
  check('the production DATE parser puts a DATE at LOCAL midnight, not UTC',
    d.getHours() === 0 && d.getTimezoneOffset() === -240, String(d));
  check('so toISOString().slice(0, 10) on it names the day BEFORE — the bug',
    d.toISOString().slice(0, 10) === '2026-02-05', d.toISOString().slice(0, 10));
  check('and isoDay names the day the column actually holds',
    isoDay(d) === '2026-02-06', isoDay(d));

  const m = parseDate('2026-03-01');                     // rollup_month.month
  check('a month key through toISOString is the PREVIOUS month — the latent bug',
    m.toISOString().slice(0, 7) === '2026-02', m.toISOString().slice(0, 7));
  check('and through isoDay it is the month the rollup row is for',
    isoDay(m).slice(0, 7) === '2026-03', isoDay(m).slice(0, 7));
  check('and the route’s own month key gives that same month',
    monthKey?.(m) === '2026-03', String(monthKey?.(m)));

  /* The other half of the class: an INSTANT, where toISOString is the right
     conversion and the wrong question. */
  const t = new Date('2025-04-04T23:12:38.000Z');        // trip.requested_at, production
  check('the UTC day of the first Uber booking is the 4th',
    t.toISOString().slice(0, 10) === '2025-04-04', t.toISOString().slice(0, 10));
  check('but its Dubai day — what trip_norm.local_day holds — is the 5th',
    dubaiIso(t) === '2025-04-05', dubaiIso(t));

  process.env.TZ = 'UTC';
}

/* ── 3. the routes, mounted the way production mounts them ─────────────── */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

/* The production trip, to the second, and a payout span that starts ten months
   after it — which is the shape of the real hole: Uber's earnings API serves
   about six months, the trip feed goes back a year. */
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
     requested_at,distance_km,status,price)
   VALUES ('uber','first','ecosine','L100','d1','Driver One',
           '2025-04-04T23:12:38Z',12,'completed',40),
          ('uber','later','ecosine','L100','d1','Driver One',
           '2026-03-10T09:00:00Z',12,'completed',40)`);
await q(
  `INSERT INTO driver_payout_day (platform,fleet_id,driver_ext_id,driver_name,day,
     period_start,period_end,earnings,trips)
   VALUES ('uber','ecosine','d1','Driver One','2026-02-06'::date,
           '2026-02-06'::date,'2026-02-12'::date,410,5)`);

const { get, server } = await mountAll(db);

{
  const cov = (await get('/api/coverage')).body;
  const gap = (cov?.earnings_gaps || []).find((g) => g.platform === 'uber');
  check('/api/coverage reports the Uber earnings gap at all', !!gap, JSON.stringify(cov?.earnings_gaps));

  /* The assertion that would have caught production: the day this endpoint
     prints must be the day trip_norm computes in SQL for the same trip. */
  const [{ local_day: sqlDay }] = await q(
    `SELECT to_char((requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') local_day
       FROM trip WHERE external_id = 'first'`);
  check('SQL puts the 23:12:38Z booking on the Dubai 5th', sqlDay === '2025-04-05', sqlDay);
  check('and "Trips from" on the Data-sources page says the same day, not the UTC 4th',
    gap?.trips_from === sqlDay, `${gap?.trips_from} vs ${sqlDay}`);

  check('"Money from" is the DATE the payout column holds',
    gap?.earnings_from === '2026-02-06', String(gap?.earnings_from));
  /* Not decoration: earnings_from is bound as $2::date[] into the
     bookings_before count, so a day of drift moves the boundary silently. Both
     trips are before 2026-02-06 Dubai. */
  check('and the unpaid-bookings count is taken from that boundary',
    gap?.bookings_before === 1, String(gap?.bookings_before));
}

{
  /* rollup_month is empty here, so the route takes its documented fallback and
     computes the grain from trip_norm — a DATE either way, which is what the
     month key has to survive. PGlite cannot reproduce the local-midnight parse
     (section 2 does that), so what this pins is that the key is right for the
     rows the route actually returns and that the calendar is filled between
     the right ends. */
  const t = (await get('/api/trend/monthly')).body;
  const ms = (t?.months || []).map((x) => x.m);
  check('/api/trend/monthly keys the first month on the booking’s own month',
    ms[0] === '2025-04', JSON.stringify(ms.slice(0, 3)));
  check('and the last on the later one, with no month shifted back',
    ms[ms.length - 1] === '2026-03', JSON.stringify(ms.slice(-3)));
  check('every month key is YYYY-MM', ms.every((x) => /^\d{4}-\d{2}$/.test(x)),
    JSON.stringify(ms.filter((x) => !/^\d{4}-\d{2}$/.test(x))));
  check('the gap between the two observed months is filled, not skipped',
    ms.length === 12, String(ms.length));
}

{
  /* The vehicle map's default day. The handler's own SQL is Dubai-framed —
     `captured_at >= ($2::date)::timestamptz - interval '4 hours'` — so a UTC
     default disagreed with it between midnight and 04:00 Dubai and the map
     opened on yesterday's journey. The response echoes the day it used. */
  const j = (await get('/api/map/journey?plate=L100')).body;
  check('/api/map/journey defaults to today in DUBAI, not today in UTC',
    j?.day === utilDubaiIso(), `${j?.day} vs ${utilDubaiIso()} (UTC ${new Date().toISOString().slice(0, 10)})`);
  const asked = (await get('/api/map/journey?plate=L100&day=2026-08-05')).body;
  check('and an explicit ?day= is still passed through untouched, being a string',
    asked?.day === '2026-08-05', String(asked?.day));
}

/* ── 4. the shape cannot come back ─────────────────────────────────────── */
{
  /* Comments blanked, length-preserving so line numbers survive — this file's
     neighbours document the trap in prose and a lint that reads its own
     documentation as a violation is a lint people switch off. */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));
  const lineOf = (i) => code.slice(0, i).split('\n').length;

  const monthKeys = [...code.matchAll(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*7\s*\)/g)]
    .map((m) => `api/server.js:${lineOf(m.index)}`);
  check('no month key in api/server.js is cut out of a toISOString',
    monthKeys.length === 0, monthKeys.join(' '));

  /* Day keys, inside the slice test/mount.mjs mounts. Two forms outside it are
     legitimate and deliberately out of reach: asDate() round-trips a
     YYYY-MM-DD string it has already anchored at Z, and dubaiIso is the
     correct conversion itself — recognised by the constant shift, the way
     test/timezone.test.mjs recognises the T12:00:00Z anchor. */
  /* Both boundaries are read out of the UNBLANKED source: the end marker is
     itself a comment, so looking for it in `code` returned -1 and the filter
     `m.index < sliceEnd` was false for every match — the guard reported clean
     while the reverted call sites sat inside it. Blanking is
     length-preserving, so an index from `src` addresses the same character in
     `code`, and a marker that moves must fail loudly rather than silently
     empty the rule. */
  const sliceStart = src.indexOf('const isoDay = (v) => {');
  const sliceEnd = src.indexOf('/* ───────────────── per-driver detail pages');
  if (sliceStart < 0 || sliceEnd <= sliceStart) {
    throw new Error(`api/server.js slice markers not found (${sliceStart}, ${sliceEnd}) — `
      + 'this guard would check nothing');
  }
  const dayKeys = [...code.matchAll(/toISOString\(\)\s*\.slice\(\s*0\s*,\s*10\s*\)/g)]
    .filter((m) => m.index > sliceStart && m.index < sliceEnd)
    .filter((m) => !/4 \* 3600e3/.test(code.slice(Math.max(0, m.index - 120), m.index)))
    .map((m) => `api/server.js:${lineOf(m.index)}`);
  check('no day key in the mounted routes is cut out of a toISOString',
    dayKeys.length === 0, dayKeys.join(' '));

  /* The other half of the class, the one test/timezone.test.mjs does not
     cover: String() on a Date gives "Fri Aug 21". Only flagged where the value
     is not already known to be a string — a req.body/req.query field is. */
  /* The lookbehind is load-bearing: without it `toISOString()` ends in the
     literal characters `String()` and every correct conversion in the file
     reported as a violation — measured, two of them. */
  const STRINGED = /(?<![\w$.])String\(([^()]*)\)\s*\.slice\(\s*0\s*,\s*(?:7|10)\s*\)/g;
  check('…and this guard can actually see the shape it bans',
    STRINGED.test('const day = String(row.day).slice(0, 10);')
    && !new RegExp(STRINGED.source).test('d.toISOString().slice(0, 10)'));
  const stringed = [...code.matchAll(new RegExp(STRINGED.source, 'g'))]
    .filter((m) => !/req\.(query|body|params)|\|\|\s*''/.test(m[1]))
    .map((m) => `api/server.js:${lineOf(m.index)}  ${m[0]}`);
  check('no day or month key in api/server.js is the first characters of String(aDate)',
    stringed.length === 0, stringed.join(' '));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
