/* A refusal is not an empty day.
   ─────────────────────────────────────────────────────────────────────────
   Found on production by the credential check, not by anything that was
   watching: the Yango session had expired, the trips endpoint was answering
   403, and `data?.orders || []` turned that into zero orders. The loop ended,
   the run logged `ok` with the rows the other two pulls had written off the
   API key, and the last Yango trip on record was three days older than the
   source's own healthy status.

   Two different facts — "this park had no trips" and "this park would not
   tell us" — reduced to the same row. The distinction is somebody's job to
   act on, and only one of them is.

   fms.js already carries this fix, with its own comment saying the same
   thing. This asserts both collectors keep it, because the shape is easy to
   reintroduce the next time a helper is written.
*/
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const yango = readFileSync('src/sources/yango.js', 'utf8');
const fms = readFileSync('src/sources/fms.js', 'utf8');

check('the Yango helper inspects the status before returning',
  /r\.status >= 400/.test(yango));
check('…and raises rather than returning an empty body',
  /throw new Error\(`yango \$\{path\} refused/.test(yango));
check('…naming the credential an operator has to replace',
  /YANGO_COOKIE/.test(yango));
/* The run wrapper catches, so raising is what turns a refusal into a run
   marked `error` instead of one marked `ok` with nothing in it. */
/* Each surface is caught on its own now, so a refusal no longer unwinds the
   whole run — but it must still REACH the run as an error rather than an 'ok'
   with nothing in it, which is the thing this file is about. Two paths carry
   that: the status computed from `fails`, and the outer catch. */
check('a raised refusal reaches the run log as an error',
  /fails\.length === 0 \? 'ok'[\s\S]{0,80}?'partial' : 'error'/.test(yango)
  /* Comments blanked: the catch now carries a paragraph explaining why it is
     still there, and a character window measured over prose is a window that
     fails when somebody documents their code. */
  && /catch \(e\)[\s\S]{0,200}status: 'error'/.test(
    yango.replace(/\/\*[\s\S]*?\*\//g, '')));
check('…and a refused surface does not take the other two with it',
  /const surface = async \(name, fn\)/.test(yango));

check('FMS still checks its own responses', /if \(!r\.ok\)/.test(fms));
check('…and still says why it does', /asked and refused|indistinguishable from a quiet/.test(fms));

/* The check the operator runs and the call the collector makes have to be the
   same endpoint, or the check tests its own choice.
   ─────────────────────────────────────────────────────────────────────────
   This pinned the literal '/api/reports-api/v1/orders/list' in both files, and
   passed for as long as both spelled it. The collector's orders moved to
   fleet-api.yango.tech on 2026-09-07 and the console path stayed behind in
   credcheck.js — two files agreeing about a string neither of them uses for
   the same thing. So the assertion is now that they SHARE A DEFINITION:
   src/sources/yango.js exports YANGO_SURFACES and credcheck imports it, which
   is a property no amount of re-spelling can fake. */
const chk = readFileSync('src/credcheck.js', 'utf8');
const { YANGO_SURFACES } = await import('../src/sources/yango.js');
check('the collector names its endpoints in one exported place',
  Object.keys(YANGO_SURFACES).sort().join() === 'console,key'
  && Object.values(YANGO_SURFACES).every((h) => Object.values(h).every((v) => v.startsWith('/'))),
  JSON.stringify(YANGO_SURFACES));
check('the credential check reads that place rather than spelling a path of its own',
  /import \{[^}]*YANGO_SURFACES[^}]*\} from '\.\/sources\/yango\.js'/.test(chk));
check('…and spells no Yango path of its own',
  !/['"`]\/(api\/reports-api|api\/v1\/reports|v1\/parks)\//.test(chk),
  (chk.match(/['"`]\/(api\/reports-api|api\/v1\/reports|v1\/parks)\/[^'"`]*/g) || []).join('; '));
/* And every path it asks is one the collector asks. Derived from the export on
   both sides, so a fourth surface added to the collector is covered without
   this file being edited. */
const ALL_PATHS = Object.values(YANGO_SURFACES).flatMap((h) => Object.values(h));
check('every endpoint the check reaches for is one the collector reads',
  [...chk.matchAll(/YANGO_SURFACES\.(\w+)\.(\w+)/g)]
    .every(([, host, name]) => ALL_PATHS.includes(YANGO_SURFACES[host]?.[name])),
  [...chk.matchAll(/YANGO_SURFACES\.(\w+)\.(\w+)/g)].map((m) => m[0]).join(', '));
check('and the collector really asks them',
  ALL_PATHS.every((path) => yango.includes(path)) === false
    ? false
    : /keyPost\(YANGO_SURFACES\.key\./.test(yango) && /post\(YANGO_SURFACES\.console\./.test(yango),
  'the pulls must call through the export, not through a literal');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
