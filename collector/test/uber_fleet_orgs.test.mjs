/* ── the second fleet exists ───────────────────────────────────────────────
   uber_fleet.js collects four surfaces: the vehicle master and its compliance
   documents, Uber's own recommendations, and the earnings COMPONENT tree —
   which is where tips live and where #reconcile's "expected payout" comes
   from. Every one of them was addressed with `config.uber.orgUuid`, the
   unsuffixed key, and stamped `fleet_id: 'ecosine'`, a module constant.

   Egari is a configured org with its own uuid, its own encrypted id and its
   own web session, and none of this ever ran for it. Measured on production
   before the fix: Egari carried a bank payout for 7 of 13 months and an
   expected payout for 0 of 13, because expected is built from a component
   tree that was only ever fetched for the other fleet.

   These are source-shape assertions, which is what a collector whose inputs
   are live credentials can be held to without them. */
import { readFileSync } from 'node:fs';

/* Comments stripped first. These assertions are about what the code DOES, and
   the comment above the fix quotes the old shape verbatim — testing the raw
   file would fail on the explanation of the very bug it describes. */
const raw = readFileSync('src/sources/uber_fleet.js', 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nno surface is pinned to one fleet');

check('the hard-coded fleet constant is gone',
  !/const FLEET\s*=/.test(src), 'FLEET is still declared');
check('and nothing stamps a literal fleet id on a row',
  !/fleet_id: '(ecosine|egari)'/.test(src),
  (src.match(/fleet_id: '[a-z]+'/g) || []).join(' '));
check('every row is stamped with the org being collected',
  (src.match(/fleet_id: o\.fleet/g) || []).length >= 4,
  `${(src.match(/fleet_id: o\.fleet/g) || []).length} stamps`);

check('no surface reaches for the unsuffixed org uuid any more',
  !/config\.uber\.orgUuid/.test(src));
check('the GraphQL surfaces address the org they were handed',
  (src.match(/orgUUID: o\.orgUuid|orgUuid: o\.orgUuid/g) || []).length >= 2);
check('the web session is the org own, not the legacy fallback',
  /uberWebHeaders\(o\)/.test(src) && !/uberWebHeaders\(\)/.test(src));
check('the earnings REST call uses the org own encrypted id',
  /org_id: o\.org/.test(src) && !/org_id: config\.uber\.org/.test(src));

console.log('\ncollect iterates the configured orgs');

check('it asks uberOrgs which fleets are configured', /uberOrgs\(\)/.test(src));
check('and runs a pass per org', /for \(const o of orgs\)/.test(src));
/* An org with no credentials pasted yet is a gap, not a failure — reporting it
   as an error would put a permanent red row on the Sources page for a fleet
   nobody has onboarded. */
check('an org with no uuid or session is skipped, not failed',
  /if \(!o\.orgUuid \|\| !o\.webCookie\)/.test(src));
/* One run row per fleet: a shared row would report Egari's failure as
   Ecosine's, or hide it behind Ecosine's success — which is how this stayed
   broken. */
check('each fleet writes its own run row',
  /logRun\(\{ source: SRC, fleet_id: o\.fleet/.test(src));
check('and a failed surface names the fleet it failed for',
  /log\.warn\(SRC, `\$\{name\} failed`, \{ fleet: o\.fleet/.test(src));

/* The component tree stays WEEKLY on purpose. Measured against the live
   endpoint: sliced into days the components lose 2-3% of fare and 9-16% of
   tips, because Uber attributes items to the period they settle in. Trips and
   net outstanding are exactly additive and are collected daily in uber.js;
   the components are not, and are collected on the grid they are true on. */
check('the component tree is still asked for a week at a time',
  /weekChunks\(from, to\)/.test(src), 'components must not go daily');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
