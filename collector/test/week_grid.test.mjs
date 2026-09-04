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
import { weekChunks, closedWeeks, dateChunks, iso } from '../src/util.js';

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

console.log('\na day is a DUBAI day, not a UTC one');

/* The fleet works Asia/Dubai and every other day figure in this product is
   `AT TIME ZONE 'Asia/Dubai'`. A UTC-aligned day would begin at 04:00 local
   and file four hours of each morning under the day before — which would show
   up immediately as a payout day that disagrees with the trip day beside it. */
import { dubaiDayChunks } from '../src/util.js';
const dd = [...dubaiDayChunks(D('2026-08-19T09:00:00Z'), D('2026-08-21T15:00:00Z'))];
check('one chunk per calendar day in the span, inclusive',
  dd.length === 3 && dd.map((x) => x.day).join() === '2026-08-19,2026-08-20,2026-08-21',
  dd.map((x) => x.day).join());
/* The distinction itself: 23:30Z on the 21st is already the 22nd in Dubai, so
   the span reaches a day a UTC-aligned chunker would never have asked for. */
check('an instant late in the UTC day belongs to the NEXT Dubai day',
  [...dubaiDayChunks(D('2026-08-19T09:00:00Z'), D('2026-08-21T23:30:00Z'))]
    .map((x) => x.day).join() === '2026-08-19,2026-08-20,2026-08-21,2026-08-22');
check('each starts at Dubai midnight, which is 20:00Z the day before',
  dd.every((x) => x.start.getUTCHours() === 20), dd.map((x) => x.start.toISOString()).join(' '));
check('each spans exactly 24 hours', dd.every((x) => x.until - x.start === 864e5));
check('and they are contiguous', dd.every((x, i) => i === 0 || +x.start === +dd[i - 1].until));
/* The stamp is the date the window COVERS in Dubai, not iso(start) — which
   would name the previous day and put every payout one day early. */
check('the stamped date is the Dubai date, not the UTC date of its start',
  dd.every((x) => x.day !== iso(x.start)) && dd[0].day === '2026-08-19',
  `${dd[0].day} vs iso(start) ${iso(dd[0].start)}`);
/* A run that starts and ends inside one Dubai day still asks for that day. */
check('a sub-day span still yields the day it falls in',
  [...dubaiDayChunks(D('2026-08-20T06:00:00Z'), D('2026-08-20T07:00:00Z'))]
    .map((x) => x.day).join() === '2026-08-20');

console.log('\nthe collector uses it');

/* A helper nothing calls fixes nothing, and this one replaced a call that
   still type-checks — dateChunks(from, to, 7) returns pairs, weekChunks returns
   objects, but a destructure of the wrong shape is a runtime undefined, not a
   parse error. */
import { readFileSync } from 'node:fs';
const uber = readFileSync('src/sources/uber.js', 'utf8');
const fn = uber.slice(uber.indexOf('async function pullEarnerBreakdowns'));
const body = fn.slice(0, fn.indexOf('\nasync function ') > 0 ? fn.indexOf('\nasync function ') : fn.length);
/* closedWeeks wraps weekChunks and drops only the week that has not finished:
   an open week ends on the coming Sunday, and Uber refuses that outright with
   "endDate is too late" — measured on production, every mid-week run. The
   calendar grid, which is what these assertions are about, is unchanged. */
check('the earnings pull builds its windows on the week grid',
  /closedWeeks\(from, to\)/.test(body));
check('and no longer with the run-anchored dateChunks', !/dateChunks\(/.test(body));
/* Every call site hands over `until`, the exclusive bound — never `e`, the
   last day covered. There are three now: driver-list mode for a week, page
   mode for a day, and the page-mode fallback when the server rejects the list. */
const callSites = body.match(/earner(Call|Pages)\(s, [a-z]+/g) || [];
check('the provider is handed the exclusive bound, not the last day',
  callSites.length === 3 && callSites.every((c) => /, until$/.test(c)),
  callSites.join(' | '));
/* The row still records the last day COVERED — storing `until` would label a
   Mon–Sun week as Mon–Mon and overlap the next one by a day. The stamp moved
   off `iso(s)`/`iso(e)` when the daily grid arrived, because a Dubai day
   begins at 20:00Z the day before and iso(start) would name the wrong date;
   the weekly grid still stamps start..end, which is what this is about. */
check('but the row stores the last day covered',
  /ps: iso\(w\.start\), pe: iso\(w\.end\)/.test(body), 'weekly stamp');
check('and the write uses those stamps rather than the exclusive bound',
  /period_start: ps, period_end: pe/.test(uber) && !/period_end: iso\(until\)/.test(uber));

/* The daily grid: same question, one Dubai day at a time. Verified against the
   live endpoint before it was written — seven daily calls and one weekly call
   over the identical span agreed to the cent on trips and netOutstanding. */
check('a Dubai-aligned daily grid is asked for as well',
  /dubaiDayChunks\(dayFrom, to\)/.test(body), 'daily grid');
check('a day row is stamped with the Dubai date, start and end the same day',
  /ps: d\.day, pe: d\.day/.test(body));
/* Asserted on the BINDING, not on a literal. This required
   `EARNER_DAY_HORIZON = <number>` — and that literal is now banned in
   test/earner_horizon.test.mjs, because the same provider edge was written
   down in this file and in api/reconcile_routes.js and the two had drifted
   eight days apart. Two tests in direct opposition is worse than either fault:
   whichever one a future reader satisfies, the other fails, and the usual
   resolution is to weaken one of them. What this check is actually about is
   that the daily grid stops where the endpoint stops answering. */
check('the daily grid is bounded by the endpoint rolling horizon',
  /EARNER_DAY_HORIZON/.test(body)
  && /const EARNER_DAY_HORIZON = UBER_EARNER_HORIZON_DAYS \+ UBER_EARNER_ASK_MARGIN_DAYS/.test(uber));
check('the daily grid never starts before the window the run was given',
  /Math\.max\(new Date\(from\)\.getTime\(\), dayHorizon\.getTime\(\)\)/.test(body));
/* Page mode pages now. The old comment said the response carried no token this
   query could select; it does, and without it a page-mode window returned the
   first ten drivers and stopped. It is also what makes a 200-day grid
   affordable: one call per ten drivers who EARNED, against 21 for a
   driver-list window whatever happened in it. */
check('the earner query selects a pagination token',
  /pageInfo \{ nextPageToken \}/.test(uber));
check('and page mode follows it to the end of the list',
  /async function earnerPages/.test(uber) && /pageToken: token/.test(uber));
check('a day is asked for in page mode, not by naming every driver',
  /if \(isDay\) \{[\s\S]{0,200}earnerPages\(s, until\)/.test(body));
check('a week still names every driver, so an absent one is a fact about them',
  /\} else if \(listMode\) \{/.test(body));

/* The earnings TREE, from the surface that serves both fleets.
   ─────────────────────────────────────────────────────────────────────────
   driver_earnings_component is where tips live and where #reconcile's
   "expected payout" is built from, and it was filled only by uber_fleet.js
   reading a REST surface on api.uber.com. That surface answers for Ecosine
   and returns nothing for Egari — on production, after a full backfill,
   "earner payments returned no earners in any of 53 week(s)". This GraphQL
   surface serves both, with the session this file already holds, and the
   components reconcile: checked live, fare + tip + promotion - service fee -
   taxes equals your_earnings to the cent on Egari (34,220.54) and on Ecosine
   (78,779.03). */
check('the earner query selects the earnings and payouts trees',
  /earnings \{ localizedCategoryLabel categoryName amount/.test(uber)
  && /payouts \{ localizedCategoryLabel categoryName amount/.test(uber));
check('and walks their children, where wait time and surge live',
  (uber.match(/children \{ localizedCategoryLabel/g) || []).length >= 3);
check('components are flattened into the table the reconciliation reads',
  /upsertMany\('driver_earnings_component'/.test(body));
check('keyed so a re-collection replaces rather than duplicates',
  /\['platform', 'driver_ext_id', 'period_start', 'period_end', 'category'\]/.test(body));
/* WEEKLY only. Sliced into days the components lose 2-3% of fare and 9-16%
   of tips, because Uber attributes an item to the period it settles in. */
check('components are written for a week and never for a day',
  (body.match(/comps \+= await writeComponents\(/g) || []).length === 2
  && !/isDay[\s\S]{0,400}writeComponents/.test(body.slice(body.indexOf('if (isDay) {'),
    body.indexOf('} else if (listMode)'))),
  'a day window must not write components');
check('and the rows they wrote are counted into the run, not silently dropped',
  /total: total \+ comps/.test(uber));

/* Two hundred green day rows per fleet would bury the week rows the Sources
   page is read for; a day that FAILED is the one an operator needs. */
check('a successful day is not recorded as its own chunk, a failed one is',
  /if \(!isDay \|\| err\)/.test(body));
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
check('the yango summary is asked per calendar week', /closedWeeks\(from, to\)/.test(ybody));
/* The grid itself, once, so the wrapper cannot quietly change which weeks it
   yields. closedWeeks must be weekChunks minus exactly the unfinished week. */
{
  const now = new Date('2026-09-03T18:49:00Z');
  const f = (w) => `${iso(w.start)}..${iso(w.end)}`;
  const all = [...weekChunks(D('2026-08-10'), D('2026-09-03'))].map(f);
  const closed = [...closedWeeks(D('2026-08-10'), D('2026-09-03'), now)].map(f);
  check('closedWeeks is the same grid, minus the week that has not finished',
    closed.length === all.length - 1 && all.slice(0, -1).join() === closed.join(),
    `${all.length} weeks -> ${closed.length}`);
  check('and the week it drops is the one ending in the future',
    all.at(-1) === '2026-08-31..2026-09-06' && !closed.includes(all.at(-1)),
    'Uber answers "endDate is too late" for exactly this window');
}
check('and each row is stamped with the week, not the run',
  /period_start: iso\(start\), period_end: iso\(end\)/.test(ybody));
check('a driver with no work that week writes no row',
  /r\.trips \|\| 0\) > 0 \|\| \(r\.earnings \|\| 0\) > 0 \|\| \(r\.hours_online \|\| 0\) > 0/.test(ybody),
  'idle drivers would expand seven rows of zeros per week');

console.log('\nthe payments components ask in weeks too');

/* Same surface family as Yango's summary: it aggregates whatever range it is
   asked, and it was asked with the run's window — so a backfill's year became
   one period per driver and an incremental's three days another, on grids
   that can never reconcile. */
const fleetSrc = readFileSync('src/sources/uber_fleet.js', 'utf8');
check('the earner-payments pull iterates calendar weeks',
  /for \(const wk of weekChunks\(from, to\)\)/.test(fleetSrc));
check('and no code path still stamps the run window on a component row',
  !/start_time: new Date\(from\)/.test(fleetSrc.slice(0, fleetSrc.indexOf('pullEarningsWeek'))));

/* And the smears already stored are deleted, not merely outgrown: the fixed
   collectors write NEW rows beside the old ones (the window is the key), and
   the resolution keeps giving the smear every day nothing honest covers. */
const v24 = readFileSync('sql/schema_v24.sql', 'utf8');
check('the migration removes windows no provider legitimately issues',
  /DELETE FROM driver_performance\s+WHERE period_end - period_start > 62/.test(v24));
check('components older than a week die the same death (schema_v26)',
  /DELETE FROM driver_earnings_component\s+WHERE period_end - period_start > 6/.test(
    readFileSync('sql/schema_v26.sql', 'utf8')));
check('from the materialised day table as well, not only the source',
  /DELETE FROM driver_payout_day\s+WHERE period_end - period_start > 62/.test(v24),
  'a half-purge serves the smear for up to a quarter hour after claiming it fixed it');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
