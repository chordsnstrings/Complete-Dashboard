/* Asking Uber whether it ranks our drivers, and the three answers that differ.
   ─────────────────────────────────────────────────────────────────────────
   Uber Pro ranks a driver Blue, Gold, Platinum or Diamond. Nothing here had
   ever asked whether that reaches a supplier account, and the report pipeline
   demonstrably does not carry it: REPORT_TYPE_DRIVER_ACTIVITY was probed live
   on 2026-08-31 and returns exactly six columns — Driver UUID, first name,
   surname, Trips completed, Time online, Time on trip.

   So the question is about the GraphQL surface, and what is pinned here is
   that the probe asks it in a way that can distinguish outcomes a single
   "no" would merge:

     a field that does not exist, from one that exists and is null for a driver
     an operation that does not exist, from one that exists and is DENIED
     a guess that missed, from a guess the server corrected with a real name

   The last is the reason to probe at all rather than reason from the docs.
   A GraphQL server answers an unknown field with "Did you mean X?", and X is
   a field name we did not know existed — so a wrong guess is not a wasted
   call, it is the schema leaking one name at a time.
*/
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync('api/probe.js', 'utf8');
const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const body = (() => {
  const i = bare.indexOf("app.get('/api/probe/uber/tier'");
  return i < 0 ? '' : bare.slice(i, bare.indexOf('\n  }));', i) + 7);
})();

console.log('\nthe probe exists and cannot be turned into a proxy');

check('the tier probe is mounted', body.length > 800);
check('every candidate field is written in the file, not taken from the caller',
  /const TIER_FIELDS = \[/.test(bare) && !/req\.query\.(field|parent|op|query)/.test(body),
  'a caller-supplied selection would make this an open GraphQL proxy onto the fleet’s session');
check('every candidate operation is written in the file too',
  /const TIER_OPS = \[/.test(bare) && !/\$\{req\./.test(body));
check('the only thing the caller may choose is which driver to ask about',
  /String\(req\.query\.uuid \|\| ''\)\.trim\(\)/.test(body));
check('and that driver is scoped to the org being asked',
  /WHERE platform = 'uber' AND fleet_id = \$1/.test(body),
  'asking one org about another org’s driver returns an error with an empty message — measured');
check('it writes nothing',
  !/INSERT INTO|UPDATE \w|DELETE FROM|upsertMany/i.test(body));

console.log('\nthe three answers a single "no" would merge');

check('a field that does not exist is told apart from one that is null',
  /exists: !\/Cannot query field\|Unknown field\|FieldUndefined\/i\.test\(err\)/.test(body)
  && /value: value === undefined \? null : value/.test(body),
  'no such field and no tier for this driver lead to completely different next moves');
check('an operation that is DENIED is reported as existing',
  /PERMISSION_DENIED\|UNAUTHENTICATED\|FORBIDDEN/.test(body)
  && /exists — denied to this session/.test(src),
  'denied means the right login would work; absent means no credential ever will');
check('and an operation that is absent says so in those words',
  /no such operation/.test(src));
check('a schema suggestion is captured, because a near miss names a real field',
  /Did you mean \(\[\^\?\]\+\)\\\?/.test(body) || /Did you mean/.test(body),
  'the error is the schema leaking a name we did not guess');
check('and the suggestions are surfaced deduplicated rather than buried per row',
  /suggestions: \[\.\.\.new Set\(fields\.map\(\(f\) => f\.suggests\)\.filter\(Boolean\)\)\]/.test(body));

console.log('\nasking cheaply, and not asking twice');

check('introspection is tried first',
  /__type\(name: \$n\) \{ name fields \{ name \} \}/.test(body),
  'a server that describes itself answers every guess below in one call');
check('and a schema that answers skips the forty guesses entirely',
  /const described = Array\.isArray\(introspection\.DriverInfo\)/.test(body)
  && /\(described \? \[\] : TIER_FIELDS\)/.test(body)
  && /\(described \? \[\] : TIER_OPS\)/.test(body));
check('the probe paces itself',
  /setTimeout\(r, 80\)/.test(body));
check('a GraphQL error is read as a message, never stringified as an object',
  /e\?\.message \|\| JSON\.stringify\(e\)/.test(body),
  'String() of a GraphQL error object is "[object Object]", which has cost this codebase three debugging rounds');

console.log('\nwhat the caller is told');

check('the verdict names which of the outcomes happened',
  /nothing on this surface names a driver tier/.test(src)
  && /fields exist but answered null for this driver/.test(src)
  && /no field, but an operation exists and is denied/.test(src),
  'a bare list of nulls reads as all three at once');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
