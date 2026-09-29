/* The safety-net rollup does not collide with the collection it backs up.
   ─────────────────────────────────────────────────────────────────────────
   src/index.js runs the incremental collection every thirty minutes and a
   14-day rollup on its own schedule. That schedule was every quarter hour, so
   two of its four passes started in the same minute as the collection, rolled
   up half-written data, and were repeated by the run-end refresh four minutes
   later — or, when still running, made refreshRollups() drop the run-end
   refresh altogether. Measured on production 2026-09-29: six passes an hour,
   32% of the hour (docs/AUDIT.md, "Page load times on production").

   What must hold: the safety net never starts in a minute the incremental
   starts, and it still runs at least twice an hour, so a failed collection or
   an operator's import waits at most one gap for a pass.

   REVERSION: put the rollup back on every quarter hour (a step of 15 in the
   minute field) — "never starts in the same minute as a collection" fails
   (run 2026-09-29). */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
/* The minutes-of-the-hour a five-field cron fires on, for the two shapes
   this file uses: a step ('*', a slash, N) and a comma list. Hours are '*'. */
const minutes = (expr) => {
  const [m, h] = expr.trim().split(/\s+/);
  if (h !== '*') return null;
  if (/^\*\/\d+$/.test(m)) { const n = Number(m.slice(2)); return Array.from({ length: 60 / n }, (_, i) => i * n); }
  if (/^\d+(,\d+)*$/.test(m)) return m.split(',').map(Number);
  return null;
};
const cronFor = (re) => (src.match(re) || [])[1];

const collect = cronFor(/cron\.schedule\('([^']+)',\s*\(\)\s*=>\s*incremental\(\)/);
const net = cronFor(/cron\.schedule\('([^']+)',\s*\(\)\s*=>\s*refreshRollups\(\{\s*days:\s*14\s*\}\)/);

console.log('\nthe safety-net rollup and the collection');
check('both schedules are found in src/index.js', Boolean(collect && net), `${collect} / ${net}`);
const c = minutes(collect || ''), r = minutes(net || '');
check('both are hourly-repeating minute lists this test can read', Boolean(c && r), `${c} / ${r}`);
if (c && r) {
  check('the safety net never starts in the same minute as a collection',
    r.every((m) => !c.includes(m)), `rollup ${r} vs collection ${c}`);
  check('and it still runs at least twice an hour', r.length >= 2, String(r));
  /* The longest wait, around the hour, from any minute to the next pass. */
  const sorted = [...r].sort((a, b) => a - b);
  const gaps = sorted.map((m, i) => ((sorted[(i + 1) % sorted.length] - m + 60) % 60) || 60);
  check('no gap between passes is longer than thirty minutes', Math.max(...gaps) <= 30, String(gaps));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
