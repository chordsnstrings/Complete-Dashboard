/* Asking Uber for something it will never serve, for hours, every week.
   ─────────────────────────────────────────────────────────────────────────
   pullEarnerBreakdowns builds two grids over the same span: whole calendar
   weeks, and — for as far back as Uber will answer — single Dubai days. The
   daily grid has been bounded by the endpoint's rolling horizon since it was
   written, and its comment says why: "Asking past the edge costs calls and
   returns empty." The weekly grid three lines above it was not bounded at all.

   Measured against the live endpoint on 2026-09-02, one week per probe:

     2026-08-10..08-16   10 rows,  4 with money
     2026-03-02..03-08   10 rows,  7 with money
     2026-02-16..02-22   10 rows,  7 with money   <- 192 days back, the edge
     2026-02-09..02-15    0 rows
     2026-02-02..02-08    0 rows
     2025-12-15..12-21    0 rows
     2025-06-16..06-22    0 rows

   Over a two-year backfill that is 73 of 100 weekly windows per fleet, and at
   the 72 seconds a window measured on backfill job 41 it is about three and a
   half hours of every backfill spent being told nothing — while FMS, last in
   the source order and holding a 73-day alert hole, waits behind it. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const src = readFileSync('src/sources/uber.js', 'utf8');

console.log('\nboth grids stop where the provider stops answering');

check('the weekly grid is filtered by a horizon at all',
/* closedWeeks wraps weekChunks and drops only the week that has not finished:
   an open week ends on the coming Sunday, and Uber refuses that outright with
   "endDate is too late" — measured on production, every mid-week run. The
   calendar grid, which is what these assertions are about, is unchanged. */
  /closedWeeks\(from, to\)\]\s*\n?\s*\.filter\(\(w\) => w\.end >= weekHorizon\)/.test(src),
  'an unbounded walk asks for every week of the backfill span');
/* The invariant is about the END DATE, not about the open week.
   ─────────────────────────────────────────────────────────────────────────
   This read "the open week is not asked for at all" and enforced it by
   forbidding weekChunks anywhere in the file. That is one step too strong,
   and the step it takes past the evidence costs a reader the days they look
   at most: on Friday 4 September 2026 the running week held 3,252 Uber
   bookings against 3,321 in the week before it, and not one could carry a
   per-trip fare until Sunday.

   What Uber actually refuses is a FUTURE end date — "endDate is too late",
   measured on production on every mid-week run. An open week's chunk ends on
   the coming Sunday, which is why closedWeeks drops it. A range of Monday to
   TODAY is not that: it is the same shape pullTrips asks for every half hour
   and Uber serves, which is why this product holds Uber trips for this
   morning.

   So the rule enforced here is the measured one. The earner grid still walks
   closed weeks only; the fare walk may reach the running week, and where it
   does it must clamp the end to the window's own `to`. */
check('the earner weekly grid still asks only for weeks that have closed',
  /const weekly = \[\.\.\.closedWeeks\(from, to\)\]\s*\n?\s*\.filter\(\(w\) => w\.end >= weekHorizon\)/.test(src),
  'the earner grid must not reach a week whose end is in the future');
/* Every weekChunks caller in this file, checked for the clamp rather than
   forbidden. A new one that forgets it reintroduces "endDate is too late". */
const unclamped = [...src.matchAll(/weekChunks\(from, to\)([\s\S]{0,400})/g)]
  .filter((m) => !/w\.end > end \? end : w\.end/.test(m[1]));
check('and any walk that DOES reach the running week clamps its end to the window',
  unclamped.length === 0,
  `${unclamped.length} weekChunks caller(s) ask Uber for a window ending in the future`);

/* The SAME constant as the daily grid, not a second number that can drift
   away from it. Two horizons for one endpoint is how they stop agreeing. */
const uses = [...src.matchAll(/EARNER_DAY_HORIZON \* 864e5/g)].length;
check('…using the same constant the daily grid uses, not a copy of the number',
  uses === 2 && /const weekHorizon = new Date\(Date\.now\(\) - EARNER_DAY_HORIZON \* 864e5\)/.test(src),
  `EARNER_DAY_HORIZON used in ${uses} horizon expressions`);

check('…and the daily grid is still bounded, which was never the fault',
  /const dayFrom = new Date\(Math\.max\(new Date\(from\)\.getTime\(\), dayHorizon\.getTime\(\)\)\)/.test(src));

/* The margin has to point the same way as the daily grid's: a week kept
   needlessly costs one empty call, a week skipped wrongly loses data that
   cannot be re-fetched once it falls out of the rolling window. So the test is
   that the filter keeps a week ANY PART of which reaches the horizon —
   w.end >= horizon — rather than requiring the whole week to be inside it. */
check('a week is kept if any part of it reaches the horizon, not only if all of it does',
  /w\.end >= weekHorizon/.test(src) && !/w\.start >= weekHorizon/.test(src),
  'w.start would drop the straddling week, which is the one that still answers');

console.log('\nand the arithmetic it rests on');

{
  /* The filter is one comparison; the thing worth testing is that it selects
     the weeks production measured as answering and drops the ones it measured
     as empty. Re-implemented here against the same rule so the boundary is
     pinned by dates rather than by reading the regex above. */
  const HORIZON_DAYS = 200;
  const now = new Date('2026-09-02T12:00:00Z');
  const horizon = new Date(now.getTime() - HORIZON_DAYS * 864e5);
  const kept = (endISO) => new Date(`${endISO}T12:00:00Z`) >= horizon;

  check('the week production measured as answering is kept', kept('2026-02-22'));
  check('…and every later one', kept('2026-03-08') && kept('2026-08-16'));
  check('the weeks production measured as empty are dropped',
    !kept('2026-02-08') && !kept('2025-12-21') && !kept('2025-06-22'),
    JSON.stringify(['2026-02-08', '2025-12-21', '2025-06-22'].map(kept)));
  /* 2026-02-15 sits between the last answering week and the horizon constant.
     It is kept, and that is the margin working as intended: one empty call is
     the price of not losing a week to a horizon that moves daily. */
  check('…and the week inside the margin is kept, which is the margin working',
    kept('2026-02-15'));

  /* What the change is actually for. */
  const weeks = [];
  for (let d = new Date('2024-10-06T12:00:00Z'); d <= now; d = new Date(d.getTime() + 7 * 864e5)) {
    weeks.push(d.toISOString().slice(0, 10));
  }
  const dropped = weeks.filter((w) => !kept(w)).length;
  check('roughly three quarters of a two-year backfill is dropped',
    dropped / weeks.length > 0.65 && dropped / weeks.length < 0.85,
    `${dropped} of ${weeks.length} = ${Math.round(100 * dropped / weeks.length)}%`);
}

console.log('\nand one edge is described by one number');

{
  /* Two constants described this single provider edge and had already drifted
     eight days apart: EARNER_DAY_HORIZON = 200 decided how far back to ASK,
     HORIZON_DAYS = 192 decided where #reconcile tells a reader Uber stops
     answering. Nothing tied them together, so the banner and the grid could
     disagree about the same day and a reader had no way to tell which was
     wrong — the February payout basis is where that seam is visible.

     They are not the same number by intent, which is why both halves are named
     rather than merged: 192 is measured, 8 is a deliberate overshoot on the
     ASK side only. What must not happen again is either being written down
     twice. */
  const auth = await import('../src/auth/uber.js');
  check('the measured edge is exported once',
    auth.UBER_EARNER_HORIZON_DAYS === 192, String(auth.UBER_EARNER_HORIZON_DAYS));
  check('…and the collector\u2019s overshoot is named as a margin, not as a second edge',
    auth.UBER_EARNER_ASK_MARGIN_DAYS > 0, String(auth.UBER_EARNER_ASK_MARGIN_DAYS));

  const uber = readFileSync('src/sources/uber.js', 'utf8');
  const rec = readFileSync('api/reconcile_routes.js', 'utf8');
  check('the collector derives its ask rather than restating the number',
    /const EARNER_DAY_HORIZON = UBER_EARNER_HORIZON_DAYS \+ UBER_EARNER_ASK_MARGIN_DAYS/.test(uber),
    'a literal here is how the two drifted apart');
  check('and the page derives the edge it prints',
    /const HORIZON_DAYS = UBER_EARNER_HORIZON_DAYS/.test(rec));
  /* The literals themselves, banned in CODE in both files. A future edit that
     writes 192 or 200 back in is the regression, not a wrong value.

     Comments are blanked first, length-preserving. Both files explain this
     history in prose — src/auth/uber.js quotes both old constants by name —
     and a lint that reads its own documentation as a violation is a lint
     somebody switches off. test/timezone.test.mjs learned that already; this
     is the same rule applied on the first attempt rather than the second. */
  const code = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (c, p1) => p1 + ' '.repeat(c.length - p1.length));
  const literal = /HORIZON[A-Z_]*\s*=\s*(192|200)\b/;
  check('neither file carries a bare 192 or 200 as a horizon again',
    !literal.test(code(uber)) && !literal.test(code(rec)),
    'the edge is measured in one place or it is measured in none');
  /* And the check has to be able to fail, or it proves nothing: the one file
     that IS allowed to state the number must still trip the same pattern. */
  check('…and the rule would catch one, because the definition itself trips it',
    literal.test(code(readFileSync('src/auth/uber.js', 'utf8'))),
    'if the definition does not match, the pattern matches nothing anywhere');
  /* And the ask must actually reach past the edge, or the margin is a comment
     rather than a behaviour. */
  check('the ask reaches further back than the edge the page states',
    auth.UBER_EARNER_HORIZON_DAYS + auth.UBER_EARNER_ASK_MARGIN_DAYS > auth.UBER_EARNER_HORIZON_DAYS);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
