/* The register grew from three pairs to fifty-three, and this is the guard on
   the new fifty and on the id shape that was in their way.
   ──────────────────────────────────────────────────────────────────────────
   Two things are asserted, and both are about the same product defect:
   /api/kpis, /api/roster and /api/drivers/directory each report 173 working
   drivers over 2026-08-07..2026-09-05 where the people are 123, because fifty
   of those rows are a man's second account under his full legal name.

   FIRST, the shape of a provider id. Every Bolt id is a decimal numeral —
   8361571, 6598721, 7416305 — and api/identity_map.js accepted only a dashed
   UUID, a 24-hex ObjectId and 32 hex without dashes. assertRegister() runs at
   IMPORT, so the first Bolt id written into the register threw while the
   module was still loading and took every route that imports it with it. That
   is asserted here by the register carrying forty-eight of them and loading.

   SECOND, that the fifty fold and that the near-misses do not. The pairs that
   must NOT fold are the ones that make this dangerous: two men who share a car
   look exactly like one man with two accounts until you ask whether they were
   ever in DIFFERENT cars at the same time. L36397 carries both — "Aliyan
   khalil" and "Raja Nouman Ahmed" are two humans who interleave on that car on
   145 days, and each has his own Bolt account under his own longer name. The
   register has to fold four records onto two people and not onto one.

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

/* ══ 1. the id shape that was in the way ═══════════════════════════════ */
console.log('\nthe shape of a provider id: four, not three');

const numeral = [...PENDING_ALIAS_KEY.keys()].filter((i) => /^[0-9]+$/.test(i));
check('the register carries Bolt ids, which are decimal numerals', numeral.length >= 40,
  `${numeral.length} numeric ids, e.g. ${numeral.slice(0, 3).join(', ')}`);
/* The pattern as it stood: a 24-hex ObjectId, 32 hex, a dashed UUID. Written
   out here because the point is that none of the three reaches a numeral, so
   the module could not have loaded carrying one. */
const OLD_ID = /^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
check('…and not one of them is a shape the register used to accept',
  numeral.every((i) => !OLD_ID.test(i)));
check('the module imports anyway — the guard runs at import, so this is the assertion',
  MERGES.length + PENDING.length === 53, `${MERGES.length} applied, ${PENDING.length} pending`);
check('every id on either list is one of the four shapes production issues',
  ALL.every((m) => [m.keep.id, ...ids(m)].every(
    (i) => /^[0-9]{4,12}$|^[0-9a-f]{24}$|^[0-9a-f]{32}$|^[0-9a-f-]{36}$/.test(i))));
check('and a shape no provider issues still refuses to load',
  (await loadsWith("ids: ['7842555'", "ids: ['7842555; DROP TABLE trip'")) instanceof Error);

/* ══ 2. the fifty fold ════════════════════════════════════════════════ */
console.log('\nthe fifty pairs, and the man each of them gives his work back to');

/* The three the audit asked about by name: each held two plates on one day,
   which is the only shape in the fifty where a single row contradicts the
   merge. What resolves them is that the contradicting row is one trip, never a
   shift — checked as a property of every entry further down. */
for (const [who, alias, keep] of [
  ['fahad ali',        '6610649', 'ec17d708-7879-42fc-90ec-6d19f01677fb'],
  ['hammad ahmad',     '7523458', 'd454e6b8-6d69-469e-91a5-37c174dac8fd'],
  ['soaieed alom ali', '6639200', 'fb7c2c86-4ba0-41d6-b73f-6e9dd77b08ff'],
]) {
  const entry = PENDING.find((m) => ids(m).includes(alias));
  check(`${who}: his second account resolves to him`,
    !!entry && entry.keep.id === keep && PENDING_ALIAS_KEY.get(alias) === entry.key
    && entry.key === foldName(entry.keep.name), JSON.stringify(entry?.key));
  check(`${who}: …and the merge moves the alias record's key, not his`,
    !!entry && !PENDING_ALIAS_KEY.has(keep) && !ALIAS_KEY.has(keep));
}
/* An alias is often two provider records already — a Bolt numeral and a hotel
   ObjectId filed under the same long name. Mapping one and not the other would
   split the man a third way instead of a second. */
check('every id of a multi-record alias resolves to the same person',
  PENDING.every((m) => ids(m).every((i) => PENDING_ALIAS_KEY.get(i) === m.key)));

/* ══ 3. and the pairs that must not ═══════════════════════════════════ */
console.log('\ntwo men who share a car are still two men');

const ALIYAN = '5f16534e-68be-451b-b057-3e3d948e868b';      // uber, L36397
const NOUMAN = '37723dc3-b5f7-49ce-9c80-495bf5a2b49b';      // uber, the same car
check('both men on L36397 are in the register, each with his own Bolt account',
  PENDING.some((m) => m.keep.id === ALIYAN && m.plates.includes('L36397'))
  && PENDING.some((m) => m.keep.id === NOUMAN && m.plates.includes('L36397')));
check('…and the register gives them two keys, not one',
  keyOf(ALIYAN) && keyOf(NOUMAN) && keyOf(ALIYAN) !== keyOf(NOUMAN),
  `${keyOf(ALIYAN)} / ${keyOf(NOUMAN)}`);
check('…including their Bolt records, which are also two people',
  PENDING_ALIAS_KEY.get('6598721') === keyOf(ALIYAN)
  && PENDING_ALIAS_KEY.get('7633809') === keyOf(NOUMAN));

const KHALID = '76ede4ae-768b-4126-804b-0b5c88043682';      // "Muhammad Khalid", L90721
const KHALID_GUL = '4d4eb2c1-f64c-48c2-8167-32d887cecfd2'; // "Muhammad Khalid Gul", L94178
check('"Muhammad Khalid Gul" takes his own long-name Bolt record',
  PENDING.some((m) => m.keep.id === KHALID_GUL && m.merge.name.toLowerCase().includes('younas')));
check('…and "Muhammad Khalid" is left alone by all of it',
  keyOf(KHALID) === null && keyOf(KHALID_GUL) !== null);
check('no pair the register refuses ever comes out with one key',
  REFUSED.every((r) => keyOf(r.a.id) === null || keyOf(r.a.id) !== keyOf(r.b.id)));
check('…and an entry that would join a refused pair does not load',
  (await loadsWith('export const PENDING = Object.freeze([',
    `export const PENDING = Object.freeze([pending({
      key: 'muhammad khalid gul',
      keep:  { id: '${KHALID_GUL}', name: 'Muhammad Khalid Gul', channel: 'uber' },
      merge: { ids: ['${KHALID}'], name: 'Muhammad Khalid', channel: 'bolt' },
      plates: ['L94178'], days: { shared: 90, interleaved: 80, alias: 100, keep: 100 },
      trips: { alias: 100, onSharedCars: 100 }, contradictions: [],
    }),`)) instanceof Error);

/* ══ 4. the four tests every entry was accepted on ════════════════════ */
console.log('\nthe evidence each entry carries, re-checked rather than read');

check('the two records never file trips on a channel in common',
  PENDING.every((m) => !m.keep.channel.split(',').some((c) => m.merge.channel.split(',').includes(c))));
check('they were in the same car on a day, and interleaved there on one of them',
  PENDING.every((m) => m.plates.length >= 1 && m.days.shared >= 1
    && m.days.interleaved >= 1 && m.days.interleaved <= m.days.shared));
check('a contradiction is rare enough to be a feed row: at most one day in fifty',
  PENDING.every((m) => m.contradictions.length <= m.days.shared * 0.02),
  PENDING.filter((m) => m.contradictions.length).map((m) => `${m.key} ${m.contradictions.length}/${m.days.shared}`).join('; '));
check('and the two records met on a car on a quarter of the alias record\'s days or more',
  PENDING.every((m) => m.days.shared >= m.days.alias * 0.25));
check('…and an entry that fails one of those does not load',
  (await loadsWith('contradictions: [],\n  }),\n  pending({\n    key: \'aliyan khalil\'',
    'contradictions: [\'2026-01-01\', \'2026-01-02\', \'2026-01-03\', \'2026-01-04\', \'2026-01-05\','
    + ' \'2026-01-06\', \'2026-01-07\', \'2026-01-08\'],\n  }),\n  pending({\n    key: \'aliyan khalil\'')) instanceof Error);

check('every entry carries its measurement in words as well as figures',
  PENDING.every((m) => m.evidence.length > 300 && m.caveat.length > 100 && m.verified === '2026-09-05'));
check('the sentence states the contradiction where there is one, and its absence where there is not',
  PENDING.every((m) => (m.contradictions.length
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
  new Set(PENDING.map((m) => m.keep.id)).size < PENDING.length);
check('…but the same record merged onto two people does not load',
  (await loadsWith("ids: ['7842555'", "ids: ['7842555', '6598721'")) instanceof Error);

/* ══ 5. the stored column and the computed key still agree ════════════ */
console.log('\nnothing is applied that the database has not been told about');

check('identityCase emits the applied three and nothing else',
  (identityCase('driver_ext_id', 'x').match(/WHEN /g) || []).length === MERGES.length,
  'a pending entry in the SQL would count 123 people on one page and 173 on another');
check('sql/schema_v53.sql is still byte-for-byte what the generator emits',
  readFileSync(new URL('../sql/schema_v53.sql', import.meta.url), 'utf8') === render());
check('no pending id is resolved by anything a route calls',
  [...PENDING_ALIAS_KEY.keys()].every((i) => !ALIAS_KEY.has(i)));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
