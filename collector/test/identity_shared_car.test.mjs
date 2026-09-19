/* TWO ACCOUNTS ON ONE CHANNEL, AND THE CAR THAT SAYS THEY ARE ONE MAN.
   ═══════════════════════════════════════════════════════════════════════════
   nameCandidates() is cross-channel only and says why: same-channel name
   matches "are also what a fleet of forty Muhammads looks like, and proposing
   those would bury the pairs worth looking at". Sound, and it left the larger
   half of this fleet's duplication unproposed.

   MEASURED on the per-trip export for 1 Jul – 19 Sep 2026: 260 platform
   accounts; the register resolves 86; this queue's cross-channel rule holds
   247 proposals — and the operator puts the roster at about ninety people. The
   gap is one driver holding two accounts on ONE channel with the name spelled
   as each clerk heard it: "Hammad Ahmad Ahmad" / "Hammad Ahmad Aftab Ahmad",
   "Ali Rahman Karim" / "ALI REHMAN RIAZ KARIM".

   What makes those proposable where a bare name is not is the evidence the
   forty-Muhammads argument is missing: THEY DROVE THE SAME CAR. And what makes
   the proposal refusable is the guard nothing in this file had — two accounts
   whose trips overlap IN DIFFERENT CARS are two people. On that same export it
   separates two men both filed as "Nizam Wazir Zada", and a "Muhammad Khalid"
   from a "MUHAMMAD KHALID YOUNAS GUL" in L90721 and L94178 at 08:49 on 30 Aug.

   Nothing here merges anybody. Every row lands in driver_identity_link
   unconfirmed, which is the review queue #same-person renders. */
import { sharedCarShapes, carVerdict, spellingFolder } from '../src/identity_link.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const acc = (id, name, platform = 'uber') => ({ driver_ext_id: id, full_name: name, platform });
const trip = (id, plate, from, mins = 20) =>
  ({ driver_ext_id: id, plate, started: Date.parse(from), ended: Date.parse(from) + mins * 60000 });

/* ══ 1. the shape half — names only, no verdict yet ═══════════════════════ */
console.log('\nthe name shapes it proposes, and the ones it refuses to');
{
  const roster = [
    acc('A', 'Hammad Ahmad Ahmad'), acc('B', 'Hammad Ahmad Aftab Ahmad'),
    acc('C', 'Ali Rahman Karim'),   acc('D', 'ALI REHMAN RIAZ KARIM'),
    acc('E', 'Muhammad Nazir Khan'), acc('F', 'Muhammad Ahmad khan'),
    acc('G', 'Bakht Zada Sharif'),  acc('H', 'Bakht Zada Bakht Sharif'),
  ];
  const shapes = sharedCarShapes(roster);
  const has = (x, y) => shapes.some((s) =>
    (s.a.driver_ext_id === x && s.b.driver_ext_id === y)
    || (s.a.driver_ext_id === y && s.b.driver_ext_id === x));
  check('a subset name on the same channel is a shape', has('A', 'B'));
  check('…and so is one that needs a spelling allowance (Rahman / REHMAN)', has('C', 'D'));
  /* Same words, one of them repeated — sameSet on the raw tokens misses it and
     the subset test skips it for having an identical set. */
  check('…and the same words with one repeated (Bakht Zada Bakht Sharif)', has('G', 'H'));
  /* THE PAIR THAT MUST NOT BE PROPOSED ON NAME. Same first and last name, both
     ~120 trips on the live fleet, two different men. Nazir and Ahmad are four
     edits apart, so the spelling fold must not reach across them. */
  check('two men sharing a first and last name are NOT a shape',
    !has('E', 'F'), 'Muhammad Nazir Khan was paired with Muhammad Ahmad khan');
  check('an already-linked pair is skipped',
    !sharedCarShapes(roster, { skipPairs: new Set(['A|B']) })
      .some((s) => [s.a.driver_ext_id, s.b.driver_ext_id].sort().join('') === 'AB'));
}

/* ══ 2. the spelling fold, on its own ════════════════════════════════════ */
console.log('\nthe spelling fold joins a transliteration and nothing wider');
{
  const fold = spellingFolder(['Ali Rahman Karim', 'ALI REHMAN RIAZ KARIM', 'Muhammad Nazir Khan']);
  check('Rahman and Rehman fold to one word',
    fold('Ali Rahman Karim').filter((w) => fold('ALI REHMAN RIAZ KARIM').includes(w)).length === 3,
    JSON.stringify([fold('Ali Rahman Karim'), fold('ALI REHMAN RIAZ KARIM')]));
  /* Four characters and up: below that one edit is most of the word. The pair
     has to be genuinely ONE edit apart or this proves nothing — the first
     version of this assertion used "ali"/"alam", which are two edits apart and
     stayed separate with the length guard removed. Caught by reverting the
     guard and watching the test stay green. */
  const short = spellingFolder(['Ali Hassan Khan', 'Ala Hassan Khan']);
  check('…but short words one edit apart are still not folded (ali / ala)',
    short('Ali Hassan Khan')[0] !== short('Ala Hassan Khan')[0],
    JSON.stringify([short('Ali Hassan Khan'), short('Ala Hassan Khan')]));
}

/* ══ 3. the custody half — the car decides ═══════════════════════════════ */
console.log('\nthe car is what turns a shape into a proposal');
{
  const a = acc('A', 'Hammad Ahmad Ahmad'), b = acc('B', 'Hammad Ahmad Aftab Ahmad');
  const shape = { a, b, same: false, spelled: false };

  check('no car in common is no proposal',
    carVerdict(shape, [trip('A', 'L111', '2026-09-01T08:00:00Z'),
      trip('B', 'L222', '2026-09-02T08:00:00Z')]).skip === 'no car in common');

  const ok = carVerdict(shape, [
    trip('A', 'L111', '2026-09-01T08:00:00Z'), trip('A', 'L111', '2026-09-03T08:00:00Z'),
    trip('B', 'L111', '2026-09-02T08:00:00Z')]);
  check('a shared car and no clash is a proposal', !!ok.alias_ext_id && !ok.refused);
  check('…it lands as shared_car_name, which is not a conclusive basis',
    ok.basis === 'shared_car_name', ok.basis);
  /* The survivor keeps the record; the other becomes the alias. Both must be
     named in the sentence, because a reviewer who was not here decides on it. */
  check('…and the evidence names both filings and the car',
    /Hammad Ahmad Ahmad/.test(ok.evidence) && /Hammad Ahmad Aftab Ahmad/.test(ok.evidence)
      && /L111/.test(ok.evidence), ok.evidence);
  check('…and says plainly that neither half is proof alone',
    /Neither the name nor the car is proof on its own/.test(ok.evidence));

  /* THE REFUSAL. One man cannot drive two cars at once. */
  const no = carVerdict(shape, [
    trip('A', 'L111', '2026-09-01T08:00:00Z'), trip('B', 'L111', '2026-09-05T08:00:00Z'),
    trip('A', 'L900', '2026-09-02T09:00:00Z', 60),
    trip('B', 'L901', '2026-09-02T09:30:00Z', 60)]);
  check('overlapping trips in DIFFERENT cars refuse the pair', no.refused === true,
    JSON.stringify(no).slice(0, 120));
  check('…and the refusal says when, and in which two cars',
    no.at === '2026-09-02 09:30' && no.cars.includes('L900') && no.cars.includes('L901'),
    JSON.stringify(no));
  /* Overlapping in the SAME car is two accounts of one man double-filing one
     trip, which is evidence FOR the merge rather than against it. */
  const same = carVerdict(shape, [
    trip('A', 'L111', '2026-09-02T09:00:00Z', 60), trip('B', 'L111', '2026-09-02T09:30:00Z', 60)]);
  check('…but overlapping in the same car does not refuse', !same.refused && !!same.alias_ext_id);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
