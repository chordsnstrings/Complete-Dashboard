/* The register grew from three pairs to ninety-three, and this is the guard on
   the ninety it now applies and on the five it still refuses to.
   ──────────────────────────────────────────────────────────────────────────
   Three sweeps built it, and they are believable for three different reasons,
   so the list keeps them apart rather than blending them into one number:

     ·  3 checked by hand against production, one pair at a time.
     · 45 from the shared-history sweep — two records on the same cars, on the
       same days, with their trips interleaving INSIDE the day rather than
       following one another. Five more came out of that sweep carrying a
       CONTRADICTION, a day with both records in different cars at overlapping
       times, and those five are held back in PENDING and applied to nothing.
     · 45 from src/identity_link.js, on a phone number the roster filed against
       both records.

   Three things are asserted, and the first two are about the same product
   defect: /api/kpis, /api/roster and /api/drivers/directory each reported 173
   working drivers over 2026-08-07..2026-09-05 where the people are 123,
   because fifty of those rows are a man's second account under his full legal
   name.

   FIRST, the shape of a provider id. Every Bolt id is a decimal numeral —
   8361571, 6598721, 7416305 — and api/identity_map.js accepted only a dashed
   UUID, a 24-hex ObjectId and 32 hex without dashes. assertRegister() runs at
   IMPORT, so the first Bolt id written into the register threw while the
   module was still loading and took every route that imports it with it. That
   is asserted here by the register carrying forty-odd of them and loading.

   SECOND, that the ninety fold and that the near-misses do not. The pairs that
   must NOT fold are the ones that make this dangerous: two men who share a car
   look exactly like one man with two accounts until you ask whether they were
   ever in DIFFERENT cars at the same time. L36397 carries both — "Aliyan
   khalil" and "Raja Nouman Ahmed" are two humans who interleave on that car on
   145 days, and each has his own Bolt account under his own longer name. The
   register has to fold four records onto two people and not onto one.

   THIRD, that what the database carries is what the register says. identityCase
   emits one WHEN per ALIAS id and there are more alias ids than entries, three
   people being on the list twice and many aliases being two provider records;
   a count of entries would have passed while the SQL carried a different list.

   Nothing here needs a database: the register is a list, and what is checked
   is the list and the guard that refuses to load a bad one. The guard is
   checked by building a variant of the real module with one entry changed and
   asserting it does not import — the module has no imports of its own, so it
   loads from a data: URL as itself. */
import { readFileSync } from 'node:fs';
import { MERGES, PENDING, PENDING_ALIAS_KEY, ALIAS_KEY, REFUSED, foldName, identityCase }
  from '../api/identity_map.js';
import { render } from '../bin/gen-schema-v53.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SRC = readFileSync(new URL('../api/identity_map.js', import.meta.url), 'utf8');
/* The real module, with one substitution, imported as a module. Returns the
   error if it refuses to load, or null if it loaded — a guard that cannot be
   made to fire is not a guard. */
const loadsWith = async (from, to) => {
  const src = SRC.replace(from, to);
  if (src === SRC) return new Error(`the test's own edit did not apply: ${String(from).slice(0, 60)}`);
  try {
    await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
    return null;
  } catch (e) { return e; }
};

const ids = (m) => m.merge.ids || [m.merge.id];
const ALL = [...MERGES, ...PENDING];
const keyOf = (id) => ALL.find((m) => m.keep.id === id || ids(m).includes(id))?.key ?? null;
/* The three sweeps, told apart by the date each ran, because the shape of the
   evidence differs and each shape has its own assertions below. */
const HAND  = MERGES.filter((m) => m.verified === '2026-09-03');
const SWEPT = ALL.filter((m) => m.verified === '2026-09-05');
const PHONE = MERGES.filter((m) => m.verified === '2026-09-07');

/* ══ 1. the id shape that was in the way ═══════════════════════════════ */
console.log('\nthe shape of a provider id: four, not three');

const numeral = [...ALIAS_KEY.keys(), ...PENDING_ALIAS_KEY.keys()].filter((i) => /^[0-9]+$/.test(i));
check('the register carries Bolt ids, which are decimal numerals', numeral.length >= 40,
  `${numeral.length} numeric ids, e.g. ${numeral.slice(0, 3).join(', ')}`);
/* The pattern as it stood: a 24-hex ObjectId, 32 hex, a dashed UUID. Written
   out here because the point is that none of the three reaches a numeral, so
   the module could not have loaded carrying one. */
const OLD_ID = /^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
check('…and not one of them is a shape the register used to accept',
  numeral.every((i) => !OLD_ID.test(i)));
check('the module imports anyway — the guard runs at import, so this is the assertion',
  MERGES.length === 93 && PENDING.length === 5, `${MERGES.length} applied, ${PENDING.length} pending`);
check('and the three sweeps are all still in it, each at the size it came in at',
  HAND.length === 3 && SWEPT.length === 50 && PHONE.length === 45,
  `${HAND.length} hand / ${SWEPT.length} swept / ${PHONE.length} phone`);
check('every id on either list is one of the four shapes production issues',
  ALL.every((m) => [m.keep.id, ...ids(m)].every(
    (i) => /^[0-9]{4,12}$|^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f-]{36}$/.test(i))));
check('and a shape no provider issues still refuses to load',
  (await loadsWith("ids: ['7842555'", "ids: ['7842555; DROP TABLE trip'")) instanceof Error);

/* ══ 2. what is applied and what is held back ═════════════════════════ */
console.log('\nthe five with a contradiction, and why they are not in the ninety');

/* A contradiction is a day on which both records took a trip at the same time
   in different cars, which is the one observation a shared car, a shared route
   and a shared phone cannot explain away. Five of the fifty carry one or two
   against two hundred and more shared days, and two of those five also share a
   phone. When a shared phone and a simultaneous trip disagree, the honest
   answer is to leave the records apart — merging two humans' work and money is
   the mistake no page can help a reader notice. */
check('PENDING is exactly the swept entries that contradict themselves',
  PENDING.length === SWEPT.filter((m) => m.contradictions.length > 0).length
  && PENDING.every((m) => m.contradictions.length > 0),
  PENDING.map((m) => `${m.key} (${m.contradictions.join(' ')})`).join('; '));
check('…and nothing applied carries one',
  MERGES.every((m) => !(m.contradictions || []).length),
  MERGES.filter((m) => (m.contradictions || []).length).map((m) => m.key).join(', '));
check('the held-back five are wired to nothing a route calls',
  [...PENDING_ALIAS_KEY.keys()].every((i) => !ALIAS_KEY.has(i)),
  [...PENDING_ALIAS_KEY.keys()].filter((i) => ALIAS_KEY.has(i)).join(', '));
/* Holding them back costs something, and the cost is written down rather than
   waved at: each of the five names the trips its alias record carries, and
   those trips stay on a second row on every page until the contradiction is
   explained. A held-back entry with nothing to hold back would make this list
   a formality; none of them is. */
check('…and each of the five says how much work it is leaving on a second row',
  PENDING.every((m) => m.trips.alias > 0 && m.days.alias > 0),
  PENDING.map((m) => `${m.key} ${m.trips.alias} trips`).join('; '));
/* And the phone sweep may not quietly put back what the custody sweep held
   back: two of the five share a phone number as well as a car, so the second
   list had to be filtered against the first rather than concatenated to it. */
check('…and nothing the phone sweep found re-joins a pair held back here',
  PENDING.every((m) => !ALIAS_KEY.has(m.keep.id)
    && ids(m).every((i) => !ALIAS_KEY.has(i))),
  PENDING.filter((m) => ids(m).some((i) => ALIAS_KEY.has(i))).map((m) => m.key).join(', '));

/* ══ 3. the ninety fold ═══════════════════════════════════════════════ */
console.log('\nthe pairs, and the man each of them gives his work back to');

/* Three the audit asked about by name, one from each sweep. */
for (const [who, alias, keep, list] of [
  ['fahad ali',        '6610649', 'ec17d708-7879-42fc-90ec-6d19f01677fb', 'applied'],
  ['hammad ahmad',     '7523458', 'd454e6b8-6d69-469e-91a5-37c174dac8fd', 'held back'],
  ['soaieed alom ali', '6639200', 'fb7c2c86-4ba0-41d6-b73f-6e9dd77b08ff', 'held back'],
  ['zubair khan shaukat ali', 'a83f63fc-88bb-4bbd-9ee3-55d5aeb00e8c',
   '67483c64055e070d791000e4', 'applied'],
]) {
  const entry = ALL.find((m) => ids(m).includes(alias));
  const map = list === 'applied' ? ALIAS_KEY : PENDING_ALIAS_KEY;
  check(`${who}: his second account resolves to him (${list})`,
    !!entry && entry.keep.id === keep && map.get(alias) === entry.key
    && entry.key === foldName(entry.keep.name), JSON.stringify(entry?.key));
  check(`${who}: …and the merge moves the alias record's key, not his`,
    !!entry && !PENDING_ALIAS_KEY.has(keep) && !ALIAS_KEY.has(keep));
}
/* An alias is often two provider records already — a Bolt numeral and a hotel
   ObjectId filed under the same long name. Mapping one and not the other would
   split the man a third way instead of a second. */
check('every id of a multi-record alias resolves to the same person',
  MERGES.every((m) => ids(m).every((i) => ALIAS_KEY.get(i) === m.key))
  && PENDING.every((m) => ids(m).every((i) => PENDING_ALIAS_KEY.get(i) === m.key)));
/* The phone sweep's entries do not carry custody figures, because a phone is
   not a custody observation. What they carry instead is the basis, and the
   property that makes the basis safe, stated in the entry rather than in a
   header the reader of one entry never sees. */
check('every pair the roster found says so, and says what makes a phone safe to join on',
  PHONE.every((m) => m.basis === 'shared_phone'
    && m.evidence.includes('no phone appears on more than two records')
    && m.evidence.includes('none appears twice within one channel')),
  PHONE.filter((m) => m.basis !== 'shared_phone').map((m) => m.key).join(', '));
check('…and none of them claims a custody measurement it never made',
  PHONE.every((m) => !m.days && !m.trips && !m.plates));
/* The clause that was wrong on twelve of the forty-five. It read "the two
   names do not fold together, so no name rule could have joined them" on every
   entry, including "Abidullah Safi" against "Abidullah Safi". Computed from
   the names now, so it cannot go stale, and asserted here in both directions
   so a helper that always says one of them fails. */
{
  const REACHES = (m) => foldName(m.keep.name) === foldName(m.merge.name);
  const folds = PHONE.filter(REACHES);
  check('a pair whose names already fold says so rather than claiming the phone was needed',
    folds.length === 12 && folds.every((m) => m.evidence.includes('already fold together')),
    `${folds.length} such pairs: ${folds.map((m) => m.key).slice(0, 3).join(', ')}`);
  check('…and a pair whose names do not fold says that instead',
    PHONE.filter((m) => !REACHES(m)).every((m) => m.evidence.includes('do not fold together')
      && !m.evidence.includes('already fold together')));
}

/* ══ 4. and the pairs that must not ═══════════════════════════════════ */
console.log('\ntwo men who share a car are still two men');

const ALIYAN = '5f16534e-68be-451b-b057-3e3d948e868b';      // uber, L36397
const NOUMAN = '37723dc3-b5f7-49ce-9c80-495bf5a2b49b';      // uber, the same car
check('both men on L36397 are in the register, each with his own Bolt account',
  SWEPT.some((m) => m.keep.id === ALIYAN && m.plates.includes('L36397'))
  && SWEPT.some((m) => m.keep.id === NOUMAN && m.plates.includes('L36397')));
check('…and the register gives them two keys, not one',
  keyOf(ALIYAN) && keyOf(NOUMAN) && keyOf(ALIYAN) !== keyOf(NOUMAN),
  `${keyOf(ALIYAN)} / ${keyOf(NOUMAN)}`);
check('…including their Bolt records, which are also two people',
  ALIAS_KEY.get('6598721') === keyOf(ALIYAN)
  && ALIAS_KEY.get('7633809') === keyOf(NOUMAN));

const KHALID = '76ede4ae-768b-4126-804b-0b5c88043682';      // "Muhammad Khalid", L90721
const KHALID_GUL = '4d4eb2c1-f64c-48c2-8167-32d887cecfd2'; // "Muhammad Khalid Gul", L94178
check('"Muhammad Khalid Gul" takes his own long-name Bolt record',
  ALL.some((m) => m.keep.id === KHALID_GUL && m.merge.name.toLowerCase().includes('younas')));
/* This read "and Muhammad Khalid is left alone by all of it", which was true
   while the register was the custody sweep and is the wrong statement now. He
   is not left alone: the roster files one phone number against his Uber record
   and against the hotel record "MUHAMMAD KHALIFA AFZAL KHALID", and that is the
   very pair the operator opened this work with — 4,461 Uber trips and AED
   38,380 that his page showed as 822 trips and AED 15,636. A refusal is a
   statement about a PAIR. He is refused against "Muhammad Khalid Gul" and
   joined to the hotel record, and both are true at once. */
check('"Muhammad Khalid" is joined to the hotel record that carries his phone',
  keyOf(KHALID) === 'muhammad khalifa afzal khalid'
  && ALIAS_KEY.get(KHALID) === 'muhammad khalifa afzal khalid', String(keyOf(KHALID)));
check('…and is still not the same man as "Muhammad Khalid Gul"',
  keyOf(KHALID_GUL) === 'muhammad khalid gul' && keyOf(KHALID) !== keyOf(KHALID_GUL),
  `${keyOf(KHALID)} / ${keyOf(KHALID_GUL)}`);
check('no pair the register refuses ever comes out with one key',
  REFUSED.every((r) => keyOf(r.a.id) === null || keyOf(r.a.id) !== keyOf(r.b.id)));
check('…and an entry that would join a refused pair does not load',
  (await loadsWith('const CANDIDATES = Object.freeze([',
    `const CANDIDATES = Object.freeze([pending({
      key: 'muhammad khalid gul',
      keep:  { id: '${KHALID_GUL}', name: 'Muhammad Khalid Gul', channel: 'uber' },
      merge: { ids: ['${KHALID}'], name: 'Muhammad Khalid', channel: 'bolt' },
      plates: ['L94178'], days: { shared: 90, interleaved: 80, alias: 100, keep: 100 },
      trips: { alias: 100, onSharedCars: 100 }, contradictions: [],
    }),`)) instanceof Error);
/* And the same shape one level up: two entries may share a KEY — three people
   are on the list twice, found by two sweeps independently — but they must
   name the same surviving record, or the key has quietly merged two men whose
   folded names happen to match. */
check('a key may carry two entries, and three of them do',
  new Set(MERGES.map((m) => m.key)).size === 90,
  `${new Set(MERGES.map((m) => m.key)).size} keys over ${MERGES.length} entries`);
check('…but two entries claiming one key for two different survivors do not load',
  (await loadsWith("  {\n    key: 'abidullah safi',\n    keep:  { id: 'dae09063-88a3-432e-b39f-969d8de7992b'",
    "  {\n    key: 'aliyan khalil',\n    keep:  { id: 'dae09063-88a3-432e-b39f-969d8de7992b'"))
    instanceof Error);

/* ══ 5. the four tests every swept entry was accepted on ══════════════ */
console.log('\nthe evidence each entry carries, re-checked rather than read');

check('the two records never file trips on a channel in common',
  SWEPT.every((m) => !m.keep.channel.split(',').some((c) => m.merge.channel.split(',').includes(c))));
check('they were in the same car on a day, and interleaved there on one of them',
  SWEPT.every((m) => m.plates.length >= 1 && m.days.shared >= 1
    && m.days.interleaved >= 1 && m.days.interleaved <= m.days.shared));
check('a contradiction is rare enough to be a feed row: at most one day in fifty',
  SWEPT.every((m) => m.contradictions.length <= m.days.shared * 0.02),
  SWEPT.filter((m) => m.contradictions.length).map((m) => `${m.key} ${m.contradictions.length}/${m.days.shared}`).join('; '));
check('and the two records met on a car on a quarter of the alias record\'s days or more',
  SWEPT.every((m) => m.days.shared >= m.days.alias * 0.25));
check('…and an entry that fails one of those does not load',
  (await loadsWith('contradictions: [],\n  }),\n  pending({\n    key: \'aliyan khalil\'',
    'contradictions: [\'2026-01-01\', \'2026-01-02\', \'2026-01-03\', \'2026-01-04\', \'2026-01-05\','
    + ' \'2026-01-06\', \'2026-01-07\', \'2026-01-08\'],\n  }),\n  pending({\n    key: \'aliyan khalil\'')) instanceof Error);

check('every swept entry carries its measurement in words as well as figures',
  SWEPT.every((m) => m.evidence.length > 300 && m.caveat.length > 100 && m.verified === '2026-09-05'));
check('the sentence states the contradiction where there is one, and its absence where there is not',
  SWEPT.every((m) => (m.contradictions.length
    ? m.contradictions.every((d) => m.evidence.includes(d))
    : m.evidence.includes('No day has the two records in different cars'))));
check('the key of every entry is the surviving record\'s own folded name, unchanged',
  ALL.every((m) => m.key === foldName(m.keep.name)));
check('no record is merged twice, and nothing is both kept and merged',
  new Set(ALL.flatMap(ids)).size === ALL.flatMap(ids).length
  && !ALL.some((m) => ALL.some((o) => ids(o).includes(m.keep.id))));
/* A keep id may repeat — "Md Anwar Jelany" has two alias records and both fold
   onto him. A merge id may not, anywhere, because that is the rule that keeps
   the answer single-valued. Both halves are checked against the guard, not
   only against today's data. */
check('a keep id is allowed to carry two aliases',
  new Set(ALL.map((m) => m.keep.id)).size < ALL.length);
check('…but the same record merged onto two people does not load',
  (await loadsWith("ids: ['7842555'", "ids: ['7842555', '6598721'")) instanceof Error);

/* ══ 6. the stored column and the computed key still agree ════════════ */
console.log('\nnothing is applied that the database has not been told about');

/* One WHEN per ALIAS ID, not per entry. Counting entries passed while the
   register held one alias each and would have gone on passing at ninety-three
   entries carrying a hundred and thirty aliases — the SQL would have been
   right and the assertion would have been measuring nothing. */
const WHENS = (identityCase('driver_ext_id', 'x').match(/WHEN /g) || []).length;
check('identityCase emits one WHEN per alias id the register applies',
  WHENS === MERGES.flatMap(ids).length && WHENS === 130,
  `${WHENS} WHENs against ${MERGES.flatMap(ids).length} alias ids`);
check('…and not one WHEN for anything held back',
  [...PENDING_ALIAS_KEY.keys()].every((i) => !identityCase('driver_ext_id', 'x').includes(`'${i}'`)),
  'a pending entry in the SQL would count 123 people on one page and 173 on another');
check('every applied alias id is in it, so nothing folds in JS that does not fold in SQL',
  MERGES.flatMap(ids).every((i) => identityCase('driver_ext_id', 'x').includes(`WHEN '${i}' THEN`)));
check('sql/schema_v53.sql is still byte-for-byte what the generator emits',
  readFileSync(new URL('../sql/schema_v53.sql', import.meta.url), 'utf8') === render());
check('no pending id is resolved by anything a route calls',
  [...PENDING_ALIAS_KEY.keys()].every((i) => !ALIAS_KEY.has(i)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
