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
  /weekChunks\(from, to\)\]\s*\n?\s*\.filter\(\(w\) => w\.end >= weekHorizon\)/.test(src),
  'an unbounded weekChunks walk asks for every week of the backfill span');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
