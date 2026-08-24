/* ── the grid a report is asked for is the key it is stored under ──────────
   driver_performance is keyed on (platform, driver, period_start, period_end),
   which makes the WINDOW the identity of the row. The Uber collector built its
   windows with dateChunks, which anchors its grid to whatever `from` happens to
   be — so a backfill starting on a Saturday and a catch-up starting on a
   Thursday asked for the same payout week six days apart, and stored it twice
   under two keys. Live, one driver's twenty-eight weeks were held as sixty-seven
   rows summing to AED 128,357 against AED 57,110 on a single grid.

   The second bug in the same call was quieter. Uber's timeRange takes two
   INSTANTS, and the collector passed the last DAY of the window as the end
   bound — so it asked for midnight-to-midnight, six days, and stored it as
   seven. Measured against the trip feed across three grids and twenty-eight
   weeks, every window reported 85.5% of the trips the same span holds. 6/7 is
   0.857.

   sql/schema_v23.sql cleans up after both on the read side. This is about not
   creating them. */
import { weekChunks, dateChunks, iso } from '../src/util.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const D = (s) => new Date(s);

console.log('\nthe grid does not move with the run');

/* The actual failure: three runs over the same span, each starting on a
   different weekday, because a backfill runs from a year ago and a catch-up
   from a month ago and an incremental from three days ago. */
const spans = [
  ['2025-08-23T22:36:00Z', '2026-08-23T22:36:00Z'],
  ['2026-07-24T11:50:00Z', '2026-08-23T11:50:00Z'],
  ['2026-08-21T02:58:00Z', '2026-08-24T02:58:00Z'],
];
const grids = spans.map(([a, b]) => [...weekChunks(D(a), D(b))].map((w) => `${iso(w.start)}..${iso(w.end)}`));
const overlapKeys = grids.flat();
const bad = [...new Set(overlapKeys)].filter((k) => {
  const [s] = k.split('..');
  return grids.some((g) => g.some((o) => o !== k && o.split('..')[0] < k.split('..')[1] && o.split('..')[1] > s));
});
check('three runs over the same span produce windows that never partly overlap',
  bad.length === 0, bad.slice(0, 4).join(' '));

/* And the ones they share are IDENTICAL, which is what makes the upsert
   replace instead of insert. */
const shared = grids[0].filter((k) => grids[1].includes(k));
check('the windows two runs share are the same key', shared.length >= 4, `${shared.length} shared`);

/* dateChunks, which is still right for trips, is shown failing the same test —
   so this file records WHY the earnings path needed a different helper rather
   than implying dateChunks was broken. A trip upserts to the same row whichever
   window carries it; a report window IS the row. */
const legacy = spans.map(([a, b]) => [...dateChunks(D(a), D(b), 7)].map(([s]) => iso(s)));
check('dateChunks would have produced three different grids (this is the bug)',
  new Set(legacy.map((g) => g[0])).size === 3, legacy.map((g) => g[0]).join(' '));

console.log('\nevery window is a whole calendar week');

const w = [...weekChunks(D('2026-02-04T13:22:00Z'), D('2026-02-25T01:00:00Z'))];
check('every window starts on a Monday', w.every((x) => x.start.getUTCDay() === 1),
  w.map((x) => `${iso(x.start)}:${x.start.getUTCDay()}`).join(' '));
check('every window ends on a Sunday', w.every((x) => x.end.getUTCDay() === 0));
check('and spans exactly seven days',
  w.every((x) => (x.end - x.start) / 86400000 === 6));
check('windows are contiguous, with no day between them',
  w.every((x, i) => i === 0 || (x.start - w[i - 1].end) / 86400000 === 1));

/* Both edges widen to whole weeks rather than clipping. A clipped week is a
   different key, which is the whole bug this exists to prevent. */
check('the first window starts on or before the requested start',
  w[0].start <= D('2026-02-04T00:00:00Z'));
check('the last window ends on or after the requested end',
  w[w.length - 1].end >= D('2026-02-25T00:00:00Z'));
check('a request inside a single week still yields that whole week',
  [...weekChunks(D('2026-02-11T09:00:00Z'), D('2026-02-12T09:00:00Z'))].length === 1);

/* Time of day must not leak into the boundary: the run's wall clock is what
   moved the old grid, and a window carrying 22:36 stores as a different
   instant even when it stores as the same date. */
check('the boundaries carry no time of day',
  w.every((x) => x.start.getUTCHours() === 0 && x.start.getUTCMinutes() === 0
                 && x.until.getUTCHours() === 0));

console.log('\nthe end bound is the instant the week ends, not its last day');

/* This is the 6/7. `end` is the last day COVERED and is what gets stored;
   `until` is the exclusive bound handed to a provider that takes instants. */
check('until is the day after the last day covered',
  w.every((x) => (x.until - x.end) / 86400000 === 1));
check('so the range handed over is a full seven days',
  w.every((x) => (x.until - x.start) / 86400000 === 7));
check('and the next window begins exactly where the last one ended',
  w.every((x, i) => i === 0 || +x.start === +w[i - 1].until));

console.log('\nthe collector uses it');

/* A helper nothing calls fixes nothing, and this one replaced a call that
   still type-checks — dateChunks(from, to, 7) returns pairs, weekChunks returns
   objects, but a destructure of the wrong shape is a runtime undefined, not a
   parse error. */
import { readFileSync } from 'node:fs';
const uber = readFileSync('src/sources/uber.js', 'utf8');
const fn = uber.slice(uber.indexOf('async function pullEarnerBreakdowns'));
const body = fn.slice(0, fn.indexOf('\nasync function ') > 0 ? fn.indexOf('\nasync function ') : fn.length);
check('the earnings pull builds its windows with weekChunks',
  /weekChunks\(from, to\)/.test(body));
check('and no longer with the run-anchored dateChunks', !/dateChunks\(/.test(body));
check('the provider is handed the exclusive bound, not the last day',
  (body.match(/earnerCall\(s, until,/g) || []).length === 2,
  `${(body.match(/earnerCall\(/g) || []).length} calls, ${(body.match(/earnerCall\(s, until,/g) || []).length} exclusive`);
/* The row still records the last day COVERED — storing `until` would label a
   Mon–Sun week as Mon–Mon and overlap the next one by a day. */
check('but the row stores the last day covered',
  /period_start: iso\(s\), period_end: iso\(e\)/.test(uber));
/* total was declared, never added to, and returned as 0, so every run in the
   record says the earnings phase wrote nothing. */
check('the rows written are counted', /total \+= got;/.test(body));

console.log('\nthe Bolt roster fits inside the range its gateway allows');

/* Every backfill run failed here and said so in a message nobody read as a
   limit: "code=498806 INVALID_DATE_RANGE, maximum allowed date range is 31
   days". A backfill asks for a year. One fleet's roster was therefore never
   collected by a backfill, ever, and the run was recorded as an error whose
   other three sub-sources had worked. */
import { rosterWindow } from '../src/sources/bolt.js';

const days = ([a, b]) => Math.round((b - a) / 86400000) + 1;
const year = rosterWindow(D('2025-08-23T22:36:00Z'), D('2026-08-23T22:36:00Z'));
check('a year-long backfill is clamped to 31 days', days(year) === 31, String(days(year)));
check('and clamped to the RECENT end — a roster is a snapshot, not a history',
  +year[1] === +D('2026-08-23T22:36:00Z'), iso(year[1]));

const short = rosterWindow(D('2026-08-21T02:58:00Z'), D('2026-08-24T02:58:00Z'));
check('a window already inside the limit is left alone', days(short) === 4, String(days(short)));
check('and keeps the start it was given', +short[0] === +D('2026-08-21T02:58:00Z'));

const exact = rosterWindow(D('2026-07-25T00:00:00Z'), D('2026-08-24T00:00:00Z'));
check('a window exactly at the limit is not clamped further', days(exact) === 31, String(days(exact)));

console.log('\nyango asks in weeks too');

/* Yango's summary endpoint aggregates whatever range it is asked. Asked for a
   backfill's year it answered with one 366-day totals row per driver, which
   sql/schema_v23.sql then spread at a flat rate across every month on record —
   months before Yango carried a single trip included. Same law as Uber: the
   window a report is asked for is the key it is stored under, so the ask has
   to be a fixed calendar week, not the run's own bounds. */
const yango = readFileSync('src/sources/yango.js', 'utf8');
const yfn = yango.slice(yango.indexOf('async function pullDrivers'));
const ybody = yfn.slice(0, yfn.indexOf('\nasync function ', 1) > 0 ? yfn.indexOf('\nasync function ', 1) : yfn.length);
check('the yango summary is asked per calendar week', /weekChunks\(from, to\)/.test(ybody));
check('and each row is stamped with the week, not the run',
  /period_start: iso\(start\), period_end: iso\(end\)/.test(ybody));
check('a driver with no work that week writes no row',
  /r\.trips \|\| 0\) > 0 \|\| \(r\.earnings \|\| 0\) > 0 \|\| \(r\.hours_online \|\| 0\) > 0/.test(ybody),
  'idle drivers would expand seven rows of zeros per week');

/* And the smears already stored are deleted, not merely outgrown: the fixed
   collectors write NEW rows beside the old ones (the window is the key), and
   the resolution keeps giving the smear every day nothing honest covers. */
const v24 = readFileSync('sql/schema_v24.sql', 'utf8');
check('the migration removes windows no provider legitimately issues',
  /DELETE FROM driver_performance\s+WHERE period_end - period_start > 62/.test(v24));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
