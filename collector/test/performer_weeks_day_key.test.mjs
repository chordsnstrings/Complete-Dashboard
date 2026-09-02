/* The week picker's two ends are DATE columns, and it named them with the
   wrong conversion.
   ─────────────────────────────────────────────────────────────────────────
   GET /api/performer/weeks answers `first_booking` and `last_booking` off

     SELECT min(local_day), max(local_day) FROM trip_norm WHERE is_booking

   and local_day is `(t.requested_at AT TIME ZONE 'Asia/Dubai')::date`
   (sql/schema_v18.sql:67) — a bare DATE. node-postgres parses a DATE into a
   JavaScript Date at LOCAL midnight, so BOTH of the usual ten-character cuts
   are wrong on it:

     String(d).slice(0, 10)   → "Sat Apr 05"   the shape that shipped to
                                production in src/sources/ledger.js and printed
                                "covering days up to Fri Aug 21".
     d.toISOString().slice(0, 10)
                              → the day BEFORE, anywhere east of UTC, because
                                toISOString converts an INSTANT.

   api/performer_routes.js had the second one, and it read correctly on
   production only because the container runs UTC. Measured 2026-09-02:

     GET /api/performer/weeks   first_booking "2025-04-05"  last_booking "2026-09-02"

   and through pg's own DATE parser under TZ=Asia/Dubai, the zone this fleet
   works in, the same helper on the same wire values gave "2025-04-04" and
   "2026-09-01" — the picker's caption ("every complete week back to …",
   api/public/performers.js:154) a day early at both ends.

   WHY THIS FILE AND NOT A ROUTE ASSERTION. PGlite parses a DATE at UTC
   midnight; node-postgres parses it at LOCAL midnight. No route test in this
   suite can reach the bug through PGlite, which is exactly why the suite
   stayed green over it — so section 2 drives the parser production runs,
   directly, under the fleet's zone. Section 1 pins the source so the
   conversion cannot be put back. Section 3 mounts the route and checks the two
   ends against what SQL says about the same column. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { isoDay } from '../src/sources/ledger.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync('api/performer_routes.js', 'utf8');
const lineOf = (i) => src.slice(0, i).split('\n').length;

/* ── 1. the source cannot go back to either wrong cut ───────────────────── */
console.log('\nthe conversion the weeks endpoint uses');

const at = src.indexOf("app.get('/api/performer/weeks'");
if (at < 0) throw new Error('could not find /api/performer/weeks in api/performer_routes.js — '
  + 'if the route moved or was renamed, this guard is checking nothing');
const route = src.slice(at);

check('/api/performer/weeks names its two ends with isoDay',
  /first_booking:\s*isoDay\(/.test(route) && /last_booking:\s*isoDay\(/.test(route),
  route.replace(/\s+/g, ' ').match(/.{0,60}first_booking.{0,60}/)?.[0] || '(not found)');
check('…imported from src/sources/ledger.js, not a private copy that can drift',
  /^import \{[^}]*\bisoDay\b[^}]*\} from '\.\.\/src\/sources\/ledger\.js';$/m.test(src),
  (src.match(/^import .*ledger\.js.*$/m) || ['(no import)'])[0]);

/* The two banned shapes, scanned over the WHOLE module rather than the one
   route, because the next DATE added here will be added somewhere else in it.
   `d.toISOString()` ends in the literal characters `String()`, so the
   lookbehind on the second pattern is load-bearing — without it every correct
   instant conversion in the file reports as a violation. */
const ISOD = /toISOString\(\)\s*\.slice\(\s*0\s*,\s*(?:7|10)\s*\)/g;
const STRINGED = /(?<![\w$.])String\(([^()]*)\)\s*\.slice\(\s*0\s*,\s*(?:7|10)\s*\)/g;
check('the guards can see the shapes they ban',
  new RegExp(ISOD.source).test('v.toISOString().slice(0, 10)')
  && new RegExp(STRINGED.source).test('String(row.day).slice(0, 10)')
  && !new RegExp(STRINGED.source).test('d.toISOString().slice(0, 10)'));

/* Scanned over the CODE, with comments blanked. The comment above the fix
   quotes both banned shapes on purpose — naming the failure is the house
   style — and an unblanked scan reported that prose as a violation. Measured:
   this guard failed on api/performer_routes.js:273, its own explanation.
   Blanked to spaces rather than deleted so every offset, and therefore every
   line number reported below, still points at the real line. */
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:\\])\/\/[^\n]*/gm, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
check('blanking comments keeps the file the same length, so line numbers hold',
  code.length === src.length && code.split('\n').length === src.split('\n').length,
  `${code.length} vs ${src.length}`);
check('…and it really did remove the prose while leaving the code',
  !/String\(aDate\)/.test(code) && /first_booking: isoDay\(/.test(code),
  code.replace(/\s+/g, ' ').slice(0, 60));

/* toISOString is CORRECT on the week grid: those Dates are built by this file
   at Date.UTC(..., 12) precisely so adding and subtracting days and reading
   the calendar back is exact. Only the values that came out of pg are the
   question, so the allowance is spelled as the noon anchor, the same way
   test/server_day_keys.test.mjs spells its `4 * 3600e3` allowance. */
const isod = [...code.matchAll(new RegExp(ISOD.source, 'g'))]
  .filter((m) => !/, 12\)|864e5|thisMon|\bcur\b|\bmon\b|\bto\b\s*=|Date\.UTC/
    .test(code.slice(Math.max(0, m.index - 260), m.index)))
  .map((m) => `api/performer_routes.js:${lineOf(m.index)}  ${m[0]}`);
check('no pg value in api/performer_routes.js is cut out of a toISOString',
  isod.length === 0, isod.join(' '));

const stringed = [...code.matchAll(new RegExp(STRINGED.source, 'g'))]
  .filter((m) => !/req\.(query|body|params)|\|\|\s*''/.test(m[1]))
  .map((m) => `api/performer_routes.js:${lineOf(m.index)}  ${m[0]}`);
check('and none is the first characters of String(aDate)',
  stringed.length === 0, stringed.join(' '));

/* ── 2. the production parser, in the production zone ───────────────────── */
console.log('\nthe production DATE parser, under Asia/Dubai');

const TZ0 = process.env.TZ;
process.env.TZ = 'Asia/Dubai';
{
  const types = (await import('pg-types')).default;
  const parseDate = types.getTypeParser(1082);            // 1082 = DATE

  /* The two wire values production answered on 2026-09-02. */
  const first = parseDate('2025-04-05');
  const last = parseDate('2026-09-02');

  check('pg puts a DATE at LOCAL midnight, in a zone four hours east of UTC',
    first.getHours() === 0 && first.getTimezoneOffset() === -240, String(first));

  /* The helper that was on the line, reproduced so the failure it caused is
     asserted rather than described. */
  const wasThere = (v) => (v == null ? null
    : (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)));
  check('the conversion that shipped names first_booking a day early — the bug',
    wasThere(first) === '2025-04-04', wasThere(first));
  check('…and last_booking a day early too',
    wasThere(last) === '2026-09-01', wasThere(last));
  check('…while String(aDate) gives no date at all, the other cut in the class',
    String(first).slice(0, 10) === 'Sat Apr 05', String(first).slice(0, 10));

  check('isoDay names the day min(local_day) actually holds',
    isoDay(first) === '2025-04-05', isoDay(first));
  check('…and the day max(local_day) holds',
    isoDay(last) === '2026-09-02', isoDay(last));
  check('…and both agree with what production printed while it ran UTC',
    isoDay(first) === '2025-04-05' && isoDay(last) === '2026-09-02');
  check('…and passes a string through, in case the query ever grows a to_char',
    isoDay('2025-04-05') === '2025-04-05' && isoDay(null) === null);
}
if (TZ0 === undefined) delete process.env.TZ; else process.env.TZ = TZ0;

/* ── 3. the route, mounted the way production mounts it ─────────────────── */
console.log('\nthe endpoint, against what SQL says about the same column');

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

/* The first Uber booking on production, to the second: 23:12:38Z on the 4th is
   03:12 on the 5th in Dubai, which is why the two ends of this picker are the
   Dubai day and not the UTC one. */
await q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
     requested_at,ended_at,distance_km,status,price)
   VALUES ('uber','first','ecosine','L100','d1','Driver One',
           '2025-04-04T23:12:38Z','2025-04-04T23:34:00Z',12,'completed',40),
          ('uber','last','ecosine','L100','d1','Driver One',
           '2026-09-01T20:30:00Z','2026-09-01T20:52:00Z',12,'completed',40)`);

const { get, server } = await mountAll(db);
const wks = (await get('/api/performer/weeks')).body;

const [{ lo, hi }] = await q(
  `SELECT to_char(min(local_day),'YYYY-MM-DD') lo, to_char(max(local_day),'YYYY-MM-DD') hi
     FROM trip_norm WHERE is_booking`);
check('SQL puts the 23:12:38Z booking on the Dubai 5th, not the UTC 4th',
  lo === '2025-04-05', String(lo));
check('and the 20:30Z one on the Dubai 2nd, not the UTC 1st',
  hi === '2026-09-02', String(hi));
check('first_booking is the day the column holds',
  wks.first_booking === lo, `${wks.first_booking} vs ${lo}`);
check('last_booking is the day the column holds',
  wks.last_booking === hi, `${wks.last_booking} vs ${hi}`);
/* Both are printed by api/public/performers.js:154 through dateStr(), which
   parses them — a "Sat Apr 05" would render as Invalid Date. */
check('both are shapes the picker caption can parse',
  /^\d{4}-\d{2}-\d{2}$/.test(wks.first_booking || '')
  && /^\d{4}-\d{2}-\d{2}$/.test(wks.last_booking || ''),
  `${wks.first_booking} / ${wks.last_booking}`);
check('and the oldest week offered is the one the first booking falls in',
  wks.weeks?.[wks.weeks.length - 1]?.week === '2025-03-31',
  String(wks.weeks?.[wks.weeks.length - 1]?.week));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
