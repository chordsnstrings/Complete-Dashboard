/* The dates an insight PRINTS are the fleet's dates.
   ─────────────────────────────────────────────────────────────────────────
   src/insights.js writes sentences a person reads and acts on, and it had one
   helper serving two different kinds of column:

     const day    = (v) => new Date(v).toISOString().slice(0, 10);
     const minute = (v) => new Date(v).toISOString().slice(0, 16).replace('T', ' ');

   minute() was LIVE WRONG. Read off production /api/insights on 2026-09-02:
   all 41 fix times it had written ran four hours behind the fleet's clock, and
   four of them named the wrong DAY outright —

     L91248  "Last fix from FMS telematics at 2026-08-25 20:09"  (Dubai 26th 00:09)
     L70851  "Last fix from CABMAN at 2026-08-29 21:15"          (Dubai 30th 01:15)
     L45249  "Last fix from FMS telematics at 2026-08-28 21:07"  (Dubai 29th 01:07)
     L24522  "Last fix from CABMAN at 2026-08-30 22:46"          (Dubai 31st 02:46)

   — on the same board whose browser half test/timezone.test.mjs already pins
   to Dubai (timeStr('2026-09-02T13:00:01.603Z') === '17:00'). One screen, one
   instant, two answers, and the sentence sends somebody to the wrong date in a
   tracker log.

   day() was the other half of the same class and was latent: it is applied to
   DATE columns — driver_compliance.licence_expires, weather_daily.day,
   platform_recommendation.period_start/period_end — and node-postgres parses a
   DATE into a Date at LOCAL midnight, so toISOString() on it names the day
   before under any zone east of UTC. It read correctly on production only
   because the container runs UTC.

   Those are two things a page can be wrong about independently — the CLOCK an
   instant is printed on, and the DAY a bare DATE is read as — so they are
   checked separately, each under a process timezone that can tell the right
   answer from the lucky one. */

/* ── 1. the DATE arm, against the parser production actually uses ─────────
   Not PGlite. Measured while writing this: PGlite hands a pg DATE back as a
   Date at UTC midnight and node-postgres hands it back at LOCAL midnight, so
   under Asia/Dubai the same column arrives as 04:00 from one driver and 00:00
   from the other — and only the second is misread by toISOString(). An
   in-memory database therefore cannot reproduce this bug at all, and a test
   that used one would report clean against the code it exists to check. So the
   production parser is driven directly: pg-types, oid 1082. */
process.env.TZ = 'Asia/Dubai';

import pgTypes from 'pg-types';
import { readFileSync } from 'node:fs';
import { isoDay } from '../src/sources/ledger.js';
import { dubaiIso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const parseDate = pgTypes.getTypeParser(1082);                  // DATE
const wasDay = (v) => new Date(v).toISOString().slice(0, 10);   // the helper that shipped

console.log(`the DATE arm — process clock ${process.env.TZ}, the production DATE parser`);
{
  /* A licence that expires on the 6th of February. Nothing about it is an
     instant: it is the date printed on the card. */
  const col = parseDate('2026-02-06');
  check('node-postgres hands a DATE back at LOCAL midnight, not UTC midnight',
    col.getHours() === 0 && col.toISOString().slice(11, 16) === '20:00', col.toString());
  check('…so the old helper named the day before — the bug, reproduced',
    wasDay(col) === '2026-02-05', wasDay(col));
  check('…and isoDay reads the date the column actually holds',
    isoDay(col) === '2026-02-06', isoDay(col));
  /* String(), the shape test/timezone.test.mjs does not cover and the one that
     shipped in src/sources/ledger.js: not a wrong date — a non-date. */
  check('…where String().slice(0, 10) is not even a date',
    String(col).slice(0, 10) === 'Fri Feb 06', String(col).slice(0, 10));
}
{
  /* The edge where naming the day before also names the wrong YEAR. "94 of 94
     drivers carry the identical expiry 2026-01-01" is a real line off the
     production board, written by this helper from a DATE. */
  const col = parseDate('2026-01-01');
  check('the placeholder-licence sentence keeps its year',
    isoDay(col) === '2026-01-01' && wasDay(col) === '2025-12-31',
    `isoDay ${isoDay(col)} / was ${wasDay(col)}`);
}
{
  /* isoDay must still take the string form, because plenty of this product's
     dates arrive as YYYY-MM-DD text out of to_char or a query parameter. */
  check('isoDay passes a string through unharmed', isoDay('2026-02-06') === '2026-02-06');
  check('…and null stays null', isoDay(null) === null);
}

/* ── 2. the CLOCK arm, end to end, on a process clock that is not Dubai's ──
   Honolulu is fourteen hours from Dubai. A sentence that comes out right here
   is right because the code converts, not because the container agrees. */
process.env.TZ = 'Pacific/Honolulu';

const { PGlite } = await import('@electric-sql/pglite');
const { applySchema } = await import('./schema.mjs');
const { pool } = await import('../src/db.js');

const db = new PGlite();
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
const { computeInsights } = await import('../src/insights.js');
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

/* Anchored to now rather than to a fixed date, so staleTelemetry's own
   24h–30d window keeps holding these whenever this is run. */
const utcAt = (daysAgo, h, m) => {
  const d = new Date(Date.now() - daysAgo * 864e5);
  d.setUTCHours(h, m, 0, 0);
  return d;
};
const utcDay = (d) => d.toISOString().slice(0, 10);
const dubaiClock = (d) => new Date(d.getTime() + 4 * 36e5).toISOString().slice(11, 16);

/* Five fixes across the day, three of them inside the 20:00–24:00Z band where
   the UTC date and the Dubai date disagree — including 19:59, one minute
   before it, which must NOT move. Spaced more than an hour apart so the rule's
   gap-and-island clustering files each as its own stale_tracker rather than
   folding them into one tracker_feed_dark. */
const FIXES = [
  ['L-0330', utcAt(8, 3, 30)],
  ['L-0815', utcAt(8, 8, 15)],
  ['L-1959', utcAt(8, 19, 59)],
  ['L-2103', utcAt(8, 21, 3)],
  ['L-2347', utcAt(8, 23, 47)],
];
const dormantAt = utcAt(200, 21, 15);     // > 30d: vehicle_dormant, dated by day only

const seed = (plate, at, source = 'fms') => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, polled_at, lat, lng, speed, status)
   VALUES ($3,'ecosine',$1,$2::timestamptz,$2::timestamptz,25.2,55.3,0,'Stopped')`,
  [plate, at.toISOString(), source]);

for (const [plate, at] of FIXES) await seed(plate, at);
await seed('L-DORMANT', dormantAt);
/* Two plates still reporting, so the stale ones read as the vehicle rather
   than the feed and nothing here is mistaken for an outage. */
await seed('L-LIVE-1', new Date(Date.now() - 36e5));
await seed('L-LIVE-2', new Date(Date.now() - 2 * 36e5));
await computeInsights({});

const detailOf = async (code, id) => (await q(
  `SELECT detail FROM insight WHERE code = $1 AND entity_id = $2`, [code, id]))[0] || null;

console.log(`\nthe CLOCK arm — process clock ${process.env.TZ}, rules driven over a real database`);
{
  const wrong = [], crossings = [];
  for (const [plate, at] of FIXES) {
    const row = await detailOf('stale_tracker', plate);
    if (!row) { wrong.push(`${plate}: no finding`); continue; }
    const want = `at ${dubaiIso(at)} ${dubaiClock(at)}.`;
    const was = `at ${utcDay(at)} ${at.toISOString().slice(11, 16)}.`;
    if (!row.detail.includes(want)) wrong.push(`${plate}: want "${want}" got "${row.detail.slice(0, 60)}"`);
    if (row.detail.includes(was) && was !== want) wrong.push(`${plate}: still prints the UTC form "${was}"`);
    if (dubaiIso(at) !== utcDay(at)) crossings.push(plate);
  }
  check('every fix time is written on the Dubai clock, whatever hour it fell on',
    wrong.length === 0, `\n      ${wrong.join('\n      ')}`);
  /* The assertion above is only worth anything if some of these instants
     actually change date, which is the whole failure. */
  check('…and two of the five instants land on a different Dubai DAY than UTC',
    crossings.length === 2 && crossings.join() === 'L-2103,L-2347', crossings.join(', '));
  /* 19:59Z is 23:59 in Dubai — one minute the other side of the boundary, and
     the case a fix that simply added a day to everything would get wrong. */
  const edge = await detailOf('stale_tracker', 'L-1959');
  check('…and 19:59Z, one minute short of the band, keeps its date at 23:59',
    edge.detail.includes(`at ${utcDay(FIXES[2][1])} 23:59.`), edge.detail.slice(0, 60));
  const noon = await detailOf('stale_tracker', 'L-0815');
  check('…while a midday fix keeps its date and only shifts four hours',
    noon.detail.includes(`at ${utcDay(FIXES[1][1])} 12:15.`), noon.detail.slice(0, 60));
}
{
  const row = await detailOf('vehicle_dormant', 'L-DORMANT');
  check('a last position at 21:15 UTC is dated on the Dubai day it happened',
    row.detail.startsWith(`Last position ${dubaiIso(dormantAt)}.`), row.detail.slice(0, 60));
  check('…and not on the UTC day before it',
    !row.detail.includes(`Last position ${utcDay(dormantAt)}`), row.detail.slice(0, 60));
}

/* ── 3. and the shape that shipped cannot come back ──────────────────────
   A comment explaining a trap is not a guard. Comments are blanked first,
   length-preserving so line numbers survive, because this module's header now
   quotes the old expression verbatim — and a lint that reads its own
   documentation as a violation is a lint somebody switches off. */
console.log('\nand the shape that shipped is not in the executable source');
{
  const raw = readFileSync('src/insights.js', 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));
  const lineOf = (i) => src.slice(0, i).split('\n').length;
  /* The one legitimate .slice on an ISO string in this file is the CLOCK half
     of dubaiMinute, and it is legitimate precisely because the instant was
     shifted by DUBAI_OFFSET_MS first — so that is what the exemption looks
     for, rather than a line number that drifts. */
  const offenders = [...src.matchAll(/toISOString\(\)\s*\.slice\(\s*(?:0|11),/g)]
    .filter((m) => !/DUBAI_OFFSET_MS\s*\)\s*\.toISOString\(\)\s*$/.test(src.slice(0, m.index + 13)))
    .map((m) => `src/insights.js:${lineOf(m.index)}  ${m[0]}`);
  check('no UTC day and no UTC minute is taken off a value this file prints',
    offenders.length === 0, `\n      ${offenders.join('\n      ')}`);
  check('…and both arms of the split come from the modules that own them',
    /import \{ dubaiIso \} from '\.\/util\.js'/.test(raw)
    && /import \{ isoDay \} from '\.\/sources\/ledger\.js'/.test(raw),
    'the helpers have been redefined locally');
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
