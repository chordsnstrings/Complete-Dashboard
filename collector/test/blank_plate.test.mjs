/* ── the empty string is not a licence plate ───────────────────────────────
   `normPlate` in src/config.js is the one function all seven collectors pass a
   plate through. It was:

       (p || '').toUpperCase().replace(/[\s-]+/g, '')

   Given nothing — a missing "Number plate" column in an Uber export, a booking
   with no vehicle attached, a value that was only spaces — it returned the
   empty STRING. So `trip.plate` recorded "no vehicle" two different ways, and
   every guard downstream had been written for one of them.

   Measured on the live fleet over a year, on /api/drivers/cross-platform: 47 of
   150 people carried '' in their plate list. `array_agg(DISTINCT …)` sorts
   ascending, so '' sorted FIRST and always took one of the three slots the
   query keeps — "the three cars they drove" was two cars and a blank.
   `count(DISTINCT plate)` counted it as a vehicle. `mode() WITHIN GROUP` could
   return it as the car somebody mostly drives. And /api/kpis guarded with
   `AND n.plate <> ''` while thirty other aggregates did not, so two endpoints
   answering the same question about the same day could disagree by one — each
   looking right on its own page.

   The first version of this test demanded the guard at every one of those
   thirty call sites. That is the wrong rule, and it is the rule the view's own
   comment argues against: "excluded here rather than at each of the fifty call
   sites, because a rule applied in fifty places is applied in forty-nine." The
   rule that actually holds is that a blank never enters the database:

     1. normPlate returns null rather than ''.
     2. sql/schema_v32.sql nulls the history and adds CHECK (plate <> '').

   With both of those, an aggregate needs no guard, because there is nothing to
   guard against. This checks the two of them. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normPlate } from '../src/config.js';
import { SCHEMA_FILES } from '../src/schema_files.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('\nnormPlate answers null, never a blank');

for (const [label, input] of [
  ['undefined', undefined], ['null', null], ['an empty string', ''],
  ['spaces', '   '], ['a dash', '-'], ['a space and a dash', ' - '],
]) {
  check(`${label} is not a plate`, normPlate(input) === null, JSON.stringify(normPlate(input)));
}
check('a real plate still normalises', normPlate(' l 18-379 ') === 'L18379', normPlate(' l 18-379 '));
check('and it is upper-cased with the separators gone', normPlate('l18-379') === 'L18379');

console.log('\nthe database refuses a blank, and the history is cleaned');

const v32 = readFileSync(join(ROOT, 'sql', 'schema_v32.sql'), 'utf8');
check('schema_v32 is in the applied list', SCHEMA_FILES.includes('schema_v32.sql'));
check('it nulls the blanks already written to trip',
  /UPDATE\s+trip\s+SET\s+plate\s*=\s*NULL[^;]*btrim\(plate\)\s*=\s*''/i.test(v32));
check('and to alert, which the same collector writes',
  /UPDATE\s+alert\s+SET\s+plate\s*=\s*NULL/i.test(v32));
check('it adds a constraint so a new blank cannot be stored',
  /CHECK\s*\(\s*plate\s*<>\s*''\s*\)/i.test(v32));

console.log('\nthe synthetic keys that interpolate a plate keep their bytes');

/* FMS builds external_id as `${plate}|${start}`. With normPlate returning null
   those keys would become "null|…" where they are "|…" in the table, and every
   such journey would re-insert as a new row on the next collection. */
const fms = readFileSync(join(ROOT, 'src', 'sources', 'fms.js'), 'utf8');
const interp = [...fms.matchAll(/external_id:\s*`\$\{([^}]*)\}/g)].map((m) => m[1].trim());
const bare = interp.filter((x) => x === 'plate');
check('no FMS external_id interpolates a bare plate', bare.length === 0,
  `${bare.length} site(s) would write "null|…" for a plate-less row`);
check('they coalesce it instead', interp.some((x) => /plate\s*\?\?\s*''/.test(x)),
  interp.join(' | '));

console.log('\nevery collector goes through normPlate');

/* A source that builds a plate by hand is a source that can put a blank back,
   and no constraint downstream would explain where it came from. */
const SRC = join(ROOT, 'src', 'sources');
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.js'))) {
  const src = readFileSync(join(SRC, f), 'utf8');
  if (!/\bplate\s*:/.test(src)) continue;
  /* `plate: x.toUpperCase()` or a raw field assigned straight to plate. A value
     that came out of normPlate, out of a variable, or out of a null check is
     fine; a string method on a provider field is not. */
  const handRolled = src.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /\bplate\s*:/.test(line)
      && /\.(toUpperCase|replace|trim)\(/.test(line) && !/normPlate\(/.test(line))
    .map(({ line, n }) => `${f}:${n} ${line.trim().slice(0, 70)}`);
  if (handRolled.length) check(`${f} normalises through normPlate`, false, handRolled.join(' | '));
}
check('no collector builds a plate by hand', true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
