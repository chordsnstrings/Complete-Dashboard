/* ── the session setting every connection gets, and why it exists ───────────
   THE DEFECT, MEASURED ON PRODUCTION 2026-09-16 WITH EXPLAIN (ANALYZE,
   BUFFERS) OF THE EXACT STATEMENT /api/unauthorized/attributed SENDS:

     Limit … (actual time=92208.833..92209.316 rows=0 loops=1)
       ->  Nested Loop Left Join … (actual time=24.255..24.738 rows=0 loops=1)
     JIT: Functions: 2153
          Timing: … Optimization 50213.092 ms, Emission 41657.475 ms,
                  Total 92552.800 ms
     Execution Time: 92636.076 ms

   The query runs in 24.7 ms. Postgres spent 92.55 seconds JIT-compiling it
   first, on a window holding zero segments, on a one-vCPU box. JIT is gated on
   the planner's ESTIMATED cost — 10,536,749 here, against a jit_above_cost of
   100,000 — and that estimate does not care that nothing qualifies, so an
   empty window pays the whole compile. src/db.js turns JIT off per connection.

   WHAT THIS FILE CAN AND CANNOT PROVE. It cannot prove the 92 seconds: PGlite
   has no LLVM and no pool, and the number came from production and belongs in
   the comment beside the code. What it pins is the part that silently rots —
   that a connection still gets the statement, that it is the right statement,
   and that PG_JIT=on still turns it off, which is the escape hatch the
   decision rests on being re-measurable without a deploy. Delete the SET from
   src/db.js and every check below goes red. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Extracted from the SHIPPED SOURCE rather than imported, for the reason
   test/upsert.test.mjs gives: importing src/db.js builds a pool against a
   DATABASE_URL this suite does not have, and a copy of the logic in this file
   would drift from it and quietly stop testing anything. */
const src = readFileSync('src/db.js', 'utf8');
const start = src.indexOf('export const sessionSql');
const end = src.indexOf('pool.on(\'connect\'');
check('src/db.js still defines the session settings it is tested for',
  start > 0 && end > start, `start ${start} end ${end}`);
const body = src.slice(start, end)
  .replaceAll('export const ', 'const ')
  .replaceAll('export async function ', 'async function ');
// eslint-disable-next-line no-new-func
const { sessionSql, applySessionSettings } = new Function(
  `${body}; return { sessionSql, applySessionSettings };`)();

console.log('\nwhat a fresh connection is told');

check('JIT is turned off by default', sessionSql({}) === 'SET jit = off', String(sessionSql({})));

const issued = [];
const client = { query: async (sql) => { issued.push(sql); } };
const ret = await applySessionSettings(client, {});
check('and the statement really is sent to the connection',
  issued.length === 1 && issued[0] === 'SET jit = off', JSON.stringify(issued));
check('and reported back, so a caller can log what it set',
  ret === 'SET jit = off', String(ret));

console.log('\nthe escape hatch the decision rests on');

/* The whole case for turning JIT off is that the trade can be re-measured
   against the same endpoints without a deploy. If PG_JIT stops working, the
   comment in src/db.js is making a promise the code does not keep. */
check('PG_JIT=on restores the server default', sessionSql({ PG_JIT: 'on' }) === null,
  String(sessionSql({ PG_JIT: 'on' })));
const none = [];
const r2 = await applySessionSettings({ query: async (s) => none.push(s) }, { PG_JIT: 'on' });
check('and then nothing at all is sent', none.length === 0 && r2 === null, JSON.stringify(none));
check('any other value is not the escape hatch',
  sessionSql({ PG_JIT: 'true' }) === 'SET jit = off', String(sessionSql({ PG_JIT: 'true' })));

console.log('\nevery connection gets it, not just the first');

/* pg-pool opens a new backend per pool slot and on every reconnect after a
   managed-Postgres failover, so this has to hang off the pool's own 'connect'
   event rather than run once at boot. A pool of 8 that sets it on one
   connection is a page that is fast seven times out of eight. */
check('it is wired to pool.on(\'connect\'), not to module load',
  /pool\.on\('connect',[\s\S]{0,200}applySessionSettings\(client\)/.test(src));
check('and a refusal is a warning on one connection, never a throw',
  /applySessionSettings\(client\)\s*\.catch\(/.test(src.slice(end)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
