/* A window refused for its size, recorded as history that is gone.
   ─────────────────────────────────────────────────────────────────────────
   The Collection gaps page reported 93 missing FMS days across two windows —
   63 in Sep–Nov 2025 and 30 in Jan 2026 — with the verdict `window_failed`,
   and the source file concluded from the same evidence that "the two fleets
   have different reach into the history".

   That conclusion was wrong, and one afternoon of probing disproves it. Asked
   on 2026-08-31 for October 2025, inside the 63-day hole, FMS answers:

     31 days   ecosine 400          egari 400
     25 days   ecosine 400          egari 200, 4,631 rows
     21 days   ecosine 400          egari 200, 3,836 rows
     14 days   ecosine 200, 3,476   egari 200, 2,412 rows
      7 days   ecosine 200, 1,724   egari 200, 1,158 rows

   Egari succeeds at 25 days and 4,631 rows where Ecosine fails at 21 with an
   estimated 5,200. One response-size ceiling around five thousand records —
   not two fleets with different reach. Ecosine hits it sooner because Ecosine
   is busier.

   So a refusal is now retried in halves. What this file pins is the arithmetic
   of that split and the two ways it could go wrong: splitting for ever, and
   recording a window nobody actually asked for.
*/
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync('src/sources/fms.js', 'utf8');
const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const body = bare.slice(bare.indexOf('async function collectTripWindow'),
  bare.indexOf('\nasync function pullTrips'));

console.log('\na refusal is a size, not a verdict about the history');

check('a refused window is asked again in halves',
  /if \(days > FMS_MIN_SPLIT_DAYS\)/.test(body)
  && /collectTripWindow\(fleet, s, mid, chunks, depth \+ 1\)/.test(body)
  && /collectTripWindow\(fleet, next, e, chunks, depth \+ 1\)/.test(body),
  'the same month that is refused whole answers in halves — measured, not assumed');
check('the halves are counted in whole days, and do not overlap',
  /const half = Math\.floor\(days \/ 2\)/.test(body)
  && /const mid = new Date\(s\.getTime\(\) \+ \(half - 1\) \* 864e5\)/.test(body)
  && /const next = new Date\(s\.getTime\(\) \+ half \* 864e5\)/.test(body),
  'halving the millisecond span puts mid on a half-day whenever the window has an odd number of '
  + 'days, and every date this source sends is a bare date');
check('and the split stops, rather than halving to nothing',
  /const FMS_MIN_SPLIT_DAYS = 2/.test(bare),
  'below a couple of days a refusal is the provider’s answer, and splitting only spends requests');
check('a window that was split is not also recorded as a hole',
  /chunks\.pop\(\)/.test(body),
  'a coverage page saying a month was refused, when its two halves answered, describes a request nobody made');
check('but the halves ARE recorded, each as the window actually asked for',
  /chunks\.push\(chunk\)/.test(body));
check('and a split half is marked as one, so the record shows what happened',
  /split_from_refusal/.test(body));

console.log('\nwhat did not change');

check('a refusal is still told apart from an empty month',
  /if \(!r\.ok\)/.test(body) && /chunk\.error = `HTTP \$\{r\.status\}/.test(body),
  'http() resolves for any status, so a 400 once fell through as a month with no trips');
check('a transport failure is still one window’s problem, not the fleet’s',
  /catch \(err\) \{/.test(body) && /return 0;/.test(body));
check('the row mapping is shared, not copied, between the whole and its halves',
  /function fmsTripRows\(data, fleet\)/.test(bare)
  && (bare.match(/fmsTripRows\(/g) || []).length >= 2);
check('the journey key still tolerates a plate that would not normalise',
  /external_id: `\$\{plate \?\? ''\}\|\$\{start\}`/.test(bare),
  'interpolating null rewrites the key and re-inserts every such journey as new');
check('windows are still walked newest first',
  /\[\.\.\.dateChunks\(from, to, 31\)\]\.reverse\(\)/.test(bare),
  'a backfill that dies partway should have landed the months anybody is looking at');

console.log('\nthe arithmetic of halving a window');

{
  /* The same split the collector does, run over the window that actually
     failed, to prove it terminates and covers the range exactly once. */
  const D = 864e5;
  const split = (s, e, out = [], depth = 0) => {
    const days = Math.round((e - s) / D) + 1;
    if (depth >= 8) { out.push([s, e]); return out; }
    if (days > 2) {
      const half = Math.floor(days / 2);
      const mid = new Date(s.getTime() + (half - 1) * D);
      split(s, mid, out, depth + 1);
      split(new Date(s.getTime() + half * D), e, out, depth + 1);
      return out;
    }
    out.push([s, e]);
    return out;
  };
  const s = new Date('2025-10-01T00:00:00Z'), e = new Date('2025-10-31T00:00:00Z');
  const parts = split(s, e);
  const covered = parts.reduce((a, [a1, b1]) => a + Math.round((b1 - a1) / D) + 1, 0);
  check('halving terminates', parts.length > 0 && parts.length < 64, String(parts.length));
  check('and every day of the month is covered exactly once',
    covered === 31, `${covered} of 31`);
  check('with no half starting before the previous one ends',
    parts.every(([a1], i) => i === 0 || a1 > parts[i - 1][1]),
    JSON.stringify(parts.map(([a1, b1]) => `${a1.toISOString().slice(0, 10)}..${b1.toISOString().slice(0, 10)}`)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
