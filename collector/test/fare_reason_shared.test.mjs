/* One sentence about Uber's fare, in one place.
   ─────────────────────────────────────────────────────────────────────────
   Fifteen columns across nine files each carried their own hand-written
   version of "Uber's trip export has no fare column", and every one of them
   stopped there — which reads as "and therefore never will".

   It does now. REPORT_TYPE_PAYMENTS_ORDER prices every ride, src/sources/uber.js
   walks it a week at a time, and Uber rows fill in behind the backfill. So an
   empty Fare cell no longer means what those fifteen sentences said it meant:
   it means that week has not been collected yet. Fifteen copies is fifteen
   chances for the correction to reach fourteen of them.

   ui.js already says why it holds the long form: "Shared here so the sentence
   is the same wherever the gap is." UBER_FARE_WHY is the short form a table
   cell can carry beside its own subject, and this file is what keeps a
   sixteenth copy from being written.

   A pure source check, deliberately. Rendering every one of those cells needs
   fifteen fixtures shaped to make each column empty; the property that matters
   is textual and reading the text is the honest way to check it. */
import { readdirSync, readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const files = readdirSync('api/public').filter((f) => f.endsWith('.js'));
const src = new Map(files.map((f) => [f, readFileSync(`api/public/${f}`, 'utf8')]));

console.log('\nthe sentence lives in ui.js and nowhere else');

const ui = src.get('ui.js');
check('ui.js exports the short reason',
  /export const UBER_FARE_WHY =/.test(ui), 'UBER_FARE_WHY is missing');
check('…and it says the fare comes from the payments report, not that none exists',
  /payments report/.test(ui) && /collected a week at a time/.test(ui),
  'the reason has to say where the fare does come from');
check('…and the long form says a fare shown is GROSS of Uber’s cut',
  /export const UBER_FARE =[\s\S]{0,400}keeps a quarter of it/.test(ui),
  'UBER_FARE must not let a gross fare read as the fleet’s money');

/* The claim, in every spelling it has been written in. Matching the phrases
   rather than one exact string, because the fifteen copies differed. */
const CLAIMS = [
  /no fare column/i,
  /publishes no fare/i,
  /has no fare field/i,
  /reports no fare per trip/i,
];

/* Only what a reader can see. A code comment describing the trip export is
   still accurate about the trip export and is the history of why this code
   exists — stripping those first is what makes this check about user-facing
   text rather than about prose style. */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const offenders = [];
for (const [f, s] of src) {
  if (f === 'ui.js') continue;
  const code = stripComments(s);
  for (const line of code.split('\n')) {
    if (CLAIMS.some((re) => re.test(line))) offenders.push(`${f}: ${line.trim().slice(0, 110)}`);
  }
}
check('no other file states it in its own words',
  offenders.length === 0, `\n      ${offenders.join('\n      ')}`);

console.log('\nand the files that need it import it');

const users = [...src].filter(([f, s]) => f !== 'ui.js' && /UBER_FARE_WHY/.test(stripComments(s)));
check('somebody actually uses it — this is not a constant nothing reads',
  users.length >= 8, `${users.length} files`);
const unimported = users.filter(([, s]) =>
  !/import\s*\{[^}]*UBER_FARE_WHY[^}]*\}\s*from\s*'\.\/ui\.js'/s.test(s));
check('…and every one of them imports it rather than shadowing it',
  unimported.length === 0, unimported.map(([f]) => f).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
