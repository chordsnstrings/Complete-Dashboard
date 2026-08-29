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
check('a raised refusal reaches the run log as an error',
  /catch \(e\)[\s\S]{0,200}status: 'error'/.test(yango));

check('FMS still checks its own responses', /if \(!r\.ok\)/.test(fms));
check('…and still says why it does', /asked and refused|indistinguishable from a quiet/.test(fms));

/* The check the operator runs and the call the collector makes have to be the
   same endpoint, or the check tests its own choice. */
const chk = readFileSync('src/credcheck.js', 'utf8');
const PATH = '/api/reports-api/v1/orders/list';
check('the credential check asks the endpoint the collector asks', chk.includes(PATH));
check('…and the collector really asks it', yango.includes(PATH));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
