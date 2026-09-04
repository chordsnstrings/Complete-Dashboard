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
  /named_absent: NAMED\.test\(err\)/.test(body)
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
  /* `wanted` now, not TIER_FIELDS: the route probes one of several FIXED
     lists and the caller picks which by name. The gate is unchanged — an
     answered introspection or a dead session still skips every guess. */
  && /described \|\| !sessionWorks \? \[\] : wanted/.test(body)
  /* The OPERATION loop takes the same gate. Pinned to the property rather than
     to one spelling of it: this assertion used to quote the whole ternary
     including `wanted !== TIER_FIELDS ? [] : TIER_OPS`, so adding a second
     operation list — the per-trip money question, which is not the tier
     question and must not spend its requests — failed a test about a gate that
     had not moved. What must hold is that the ops loop is skipped when the
     schema described itself or the session is dead, and that WHICH list it
     asks about is chosen from the caller's set rather than hardcoded. */
  && /described \|\| !sessionWorks \? \[\] : opsWanted/.test(body)
  && /wanted === TIER_FIELDS \? TIER_OPS/.test(body));
/* The property that keeps this a probe rather than a proxy. */
check('the caller picks a fixed list by name, never a field',
  /const SETS = \{ tier: TIER_FIELDS/.test(body)
  && !/req\.query\.(field|parent|selection)/.test(body),
  'nothing the caller sends may become part of a query against the fleet session');
check('the probe paces itself',
  /setTimeout\(r, 80\)/.test(body));
check('a GraphQL error is read as a message, never stringified as an object',
  /e\?\.message \|\| JSON\.stringify\(e\)/.test(body),
  'String() of a GraphQL error object is "[object Object]", which has cost this codebase three debugging rounds');

console.log('\nwhat the caller is told');

check('the verdict names which of the outcomes happened',
  /nothing on this surface names a driver tier, and the control proves the server would have said so/.test(src)
  && /fields the server would not name/.test(src)
  && /no tier field on GetDriver, but an operation is there/.test(src),
  'a bare list of nulls reads as all of them at once');

console.log('\nthe control, without which a refusal proves nothing');

check('an impossible field name is probed on every parent, before any candidate',
  /const CONTROL_FIELDS = \[/.test(bare) && /zzNotARealFieldQx/.test(bare)
  && /of \(described \|\| !sessionWorks \? \[\] : CONTROL_FIELDS\)\)/.test(body),
  'twenty-nine of thirty-one candidates were NAMED as absent and two were not; without a control, '
  + '"the server would not name this one" is a Rorschach blot');
check('an impossible operation name is probed too',
  /const CONTROL_OP = /.test(bare) && /await probeOp\(CONTROL_OP, true\)/.test(body));
check('and every verdict is read against it rather than asserted',
  /const namesItsAbsences = controls\.length > 0 && controls\.every\(\(c\) => c\.named_absent\)/.test(body)
  && /exists: namesItsAbsences \? !r\.named_absent : null/.test(body));
check('a server that names nothing yields "inconclusive", not "found"',
  /inconclusive: this server does not name the fields it lacks, so a refusal proves nothing/.test(src));
check('the control is returned to the caller, not just used internally',
  /control: \{/.test(body) && /names_its_absent_fields: namesItsAbsences/.test(body),
  'a reader must be able to check the reasoning, not only the conclusion');
check('a field the server would not name is asked again with a sub-selection',
  /retry_with_selection = await probeField\(parent, field, ' \{ __typename \}'\)/.test(body),
  'the likeliest reason a server declines to name a field is an object type asked for as a scalar');
check('and an operation is asked again without arguments, for the same reason',
  /const bare = withArg\.named \? null : await probeOp\(name, false\)/.test(body),
  'getPerformanceReport exists and answers "Unknown argument" — the argument-free shape separates '
  + 'a wrong call from a missing operation');

console.log('\nthe positive control, without which every negative is worthless');

check('a field known to be real is asked first, and gates the whole run',
  /const POSITIVE_CONTROL = \['driverInfo', 'recognitionRating'\]/.test(bare)
  && /const sessionWorks = !!positive && positive\.value != null/.test(body)
  && /described \|\| !sessionWorks \? \[\] : wanted/.test(body),
  'an expired supplier cookie refuses everything, and thirty refusals read exactly like '
  + '"Uber does not publish a tier" when they mean "we did not ask anybody"');
check('and a run against a dead session says VOID rather than "no tier"',
  /VOID: the known-real field recognitionRating did not answer/.test(src));
check('the recognition family is probed, because that is what the real field is called',
  /'recognitionTier'/.test(bare) && /'recognitionStatus'/.test(bare) && /'recognitionLevel'/.test(bare),
  'GetDriver returns recognitionRating; a tier beside a rating is named by the same family');
check('including a deliberate near miss, to farm the server\u2019s own suggestion',
  /'recognitionTie'/.test(bare),
  'Did you mean "recognitionRating"? — and nothing else — says there is no other recognition* sibling');
check('and the recognition operations are probed at the query root',
  /'getDriverRecognition', 'getEarnerRecognition'/.test(bare));

check('an invented name CLOSE to a real one is probed, to explain the generic refusal',
  /const NEAR_MISS_CONTROL = \['driverInfo', 'recognitionRatingg'\]/.test(bare)
  && /const genericMeansNearMiss = !!nearMiss && !nearMiss\.named_absent/.test(body),
  'measured live: zzNotARealFieldQx is refused BY NAME while recognitionTie — a name this file '
  + 'invented — is refused generically, so the generic refusal is about proximity, not existence');
check('and the caller is told what a generic refusal means before reading any',
  /generic_refusal_means: genericMeansNearMiss/.test(body)
  && /proximity, not existence/.test(src));
check('a candidate the server would not name is retried whatever the controls say',
  /if \(!r\.named_absent && !r\.answered && namesItsAbsences\) \{/.test(body),
  'the controls decide how to read a refusal; they cannot decide how to read an answer');
check('and an answered retry is the verdict, on its own authority',
  /found\.some\(\(f\) => f\.retry_with_selection\?\.answered\)/.test(body));
check('a bare known-real OBJECT is probed, to prove the retry branch means anything',
  /const OBJECT_CONTROL = \['driver', 'complianceInfo'\]/.test(bare)
  && /must have a selection of subfields/.test(body),
  'the retry-with-sub-selection branch assumes the server announces bare objects, and nothing else proves it');
check('and the object control is reported rather than only used',
  /signature_fires: objectSignatureFires/.test(body));

console.log('\nthe probe that answered the wrong question confidently');

check('the driver probe asks the org that owns the driver it picked',
  /WHERE platform = 'uber' AND fleet_id = \$1\n\s+AND coalesce\(btrim\(driver_ext_id\), ''\) <> ''/.test(src),
  'unscoped it took either fleet’s newest roster row and asked Ecosine about it — and an Egari driver '
  + 'asked of Ecosine returns an empty-message 500, which reads exactly like a dead cookie');
check('an unknown report type is refused rather than silently swapped for another',
  /if \(req\.query\.type && !CANDIDATE_REPORTS\.includes\(String\(req\.query\.type\)\)\)/.test(src),
  'it fell through to REPORT_TYPE_TRIP_ACTIVITY, answering a question about drivers with trip columns');
check('and the reports that carry a tier\u2019s own inputs are candidates now',
  /'REPORT_TYPE_DRIVER_QUALITY'/.test(src) && /'REPORT_TYPE_DRIVER_PERFORMANCE'/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
