/* The span a rate is printed over, and the count beside it, on one clock.
   ─────────────────────────────────────────────────────────────────────────
   /api/supply/balance answers `measured` — the days the availability feed
   actually covers inside the requested window — because a fleet-idle rate over
   31 of the 365 days somebody asked for is only honest if it says what it
   divided by. Three fields carry that: `from`, `to`, and `days`.

   `days` has always been Dubai days: count(DISTINCT (at AT TIME ZONE
   'Asia/Dubai')::date). `from` and `to` were min(at)/max(at) — bare timestamptz
   instants, so node-postgres hands back Date objects — reduced to a calendar
   day with toISOString().slice(0, 10), which is the UTC day. Dubai is UTC+4, so
   anything from 20:00 UTC onward is already tomorrow there, and the object
   contradicted itself. Measured on production 2026-09-02:

     GET /api/supply/balance?from=2026-07-28&to=2026-07-29
       → measured {"from":"2026-07-28","to":"2026-07-28","days":2}
     GET /api/supply/balance?from=2026-07-28&to=2026-08-01
       → measured {"from":"2026-07-28","to":"2026-07-31","days":5}

   A span of one day beside a count of two, and a span of four beside a count
   of five. Nothing crashed and no page showed a stack trace; the arithmetic
   was simply wrong by one day at the end of every window whose last
   availability event fell after 20:00 UTC — which is most of them, because the
   feed runs live and the fleet works evenings.

   The same slice sat on the left of `narrower_than_window`, against a Dubai
   calendar date on the right. The UTC day of an instant is never LATER than
   its Dubai day, so that comparison could only bias the flag toward false —
   silencing "Availability is only reported from …" (api/public/supply.js:156)
   in exactly the boundary case the caption exists for.

   Both are pinned here against a real database rather than by reading the
   source, because the shape of the bug is a value that survives every type
   check and prints a plausible date. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const ev = (at, status) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber','ecosine','d1', $1::timestamptz, 'status', $2, '')`, [at, status]);

/* The old expression, kept so the "before" in this file is a measurement of
   the same rows rather than a memory of what production used to say. */
const utcDay = (v) => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);

/* Production's shape: availability on two Dubai days, the later of which is
   reached only after 20:00 UTC. 2026-07-28T20:30Z is 00:30 on the 29th in
   Dubai — the fleet's night shift, not an exotic edge. */
await ev('2026-07-28T09:00:00Z', 'ONLINE');    // Dubai 07-28 13:00
await ev('2026-07-28T11:00:00Z', 'OFFLINE');   // Dubai 07-28 15:00
await ev('2026-07-28T20:30:00Z', 'ONLINE');    // Dubai 07-29 00:30
await ev('2026-07-28T21:30:00Z', 'OFFLINE');   // Dubai 07-29 01:30

const { get, server } = await mountAll(db);

const [raw] = await q(
  `SELECT min(at) AS from_at, max(at) AS to_at,
          count(DISTINCT (at AT TIME ZONE 'Asia/Dubai')::date)::int AS days
     FROM driver_timeline_event
    WHERE kind = 'status' AND status <> ''
      AND at >= $1::timestamptz AND at <= $2::timestamptz`,
  ['2026-07-28', '2026-07-29']);
console.log(`  · the same row, the old way: from ${utcDay(raw.from_at)} to ${utcDay(raw.to_at)}, days ${raw.days}`);

const m = (await get('/api/supply/balance?from=2026-07-28&to=2026-07-29')).body.measured;
console.log(`  · and as the route now answers it: ${JSON.stringify(m)}`);

check('the end of the measured span is the Dubai day of the last event, not the UTC one',
  m.to === '2026-07-29', `${m.to} (max(at) is ${raw.to_at.toISOString?.() || raw.to_at})`);
check('…which is what the old expression got wrong, on these very rows',
  utcDay(raw.to_at) === '2026-07-28' && m.to !== utcDay(raw.to_at));
check('the start is unchanged, because that event is before 20:00 UTC',
  m.from === '2026-07-28', m.from);
/* The invariant the two fields have to satisfy together, and the one the page
   reads: `days` counts Dubai days, so the inclusive span from `from` to `to`
   must hold exactly that many of them. This is what production violated. */
const spanDays = (a, b) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5) + 1;
check('the printed span holds exactly the number of days counted beside it',
  spanDays(m.from, m.to) === m.days, `${m.from}→${m.to} is ${spanDays(m.from, m.to)} day(s), days=${m.days}`);
check('…and the old pair did not, which is the contradiction production printed',
  spanDays(utcDay(raw.from_at), utcDay(raw.to_at)) !== raw.days,
  `${utcDay(raw.from_at)}→${utcDay(raw.to_at)} vs days=${raw.days}`);

/* ── the caption the flag turns on ────────────────────────────────────────
   Now the feed's FIRST event falls in the same 20:00-24:00 UTC band, so the
   availability starts a Dubai day later than the window the reader asked for.
   That is precisely when the Supply and Optimise pages must say "Availability
   is only reported from 2026-07-29" — and the UTC-day comparison said nothing,
   because the left-hand side had been dragged back to the 28th. */
await q(`DELETE FROM driver_timeline_event WHERE at < '2026-07-28T20:00:00Z'`);

const [raw2] = await q(
  `SELECT min(at) AS from_at FROM driver_timeline_event
    WHERE kind = 'status' AND status <> ''
      AND at >= $1::timestamptz AND at <= $2::timestamptz`, ['2026-07-28', '2026-07-29']);
const oldFlag = utcDay(raw2.from_at) > '2026-07-28';
const m2 = (await get('/api/supply/balance?from=2026-07-28&to=2026-07-29')).body.measured;
console.log(`  · window opens 2026-07-28; feed opens ${m2.from}; old flag ${oldFlag}, now ${m2.narrower_than_window}`);

check('a feed that starts after the window did is reported as narrower than it',
  m2.narrower_than_window === true, JSON.stringify(m2));
check('…which the UTC-day comparison answered false, suppressing the caption',
  oldFlag === false);
check('…and the day it names is the Dubai day the availability actually starts',
  m2.from === '2026-07-29' && m2.to === '2026-07-29' && m2.days === 1, JSON.stringify(m2));

/* A window the feed genuinely does not narrow must still read false, or the
   fix would have replaced a silent caption with a permanent one. Daytime
   events, whose UTC and Dubai days coincide, opening the window they are asked
   for. */
await ev('2026-07-29T09:00:00Z', 'ONLINE');    // Dubai 07-29 13:00
await ev('2026-07-29T11:00:00Z', 'OFFLINE');   // Dubai 07-29 15:00
const m3 = (await get('/api/supply/balance?from=2026-07-29&to=2026-07-30')).body.measured;
check('while a window the feed covers from its first day is not flagged',
  m3.narrower_than_window === false, JSON.stringify(m3));

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
