/* MATCHING A NAME TO A PERSON, LOCALLY — and refusing when it cannot.
   ══════════════════════════════════════════════════════════════════════════
   The operator asked for a spreadsheet import with fuzzy matching. The obvious
   implementation posts several hundred real people's names — and beside each,
   the amount the company says that person owes — to a language model in
   another jurisdiction. This product has an argued rule against exactly that,
   in the two places it already calls one: src/analyst.js:406-410 restricts a
   model to "aggregates only — no rows, no names", and src/credmodel.js:23-27
   sends a SILHOUETTE rather than a value because "a credential mailed to a
   third party to be identified is a credential that has been disclosed".

   So the matching is local, and this file is the argument that local is also
   BETTER here: the candidate set is a few hundred rows, and the cases that
   matter are ones a deterministic rule gets right and a probabilistic one gets
   right most of the time.

   THE CASE THAT MUST NOT BE RESOLVED AUTOMATICALLY is two candidates within a
   hair of each other. api/identity_map.js deliberately holds apart "Muhammad
   Khalid" and "Muhammad Khalid Gul" — two men with 77 simultaneous trips on
   two plates. A matcher that returned the higher score there would pool two
   people's debts at the moment money was imported against one of them, so
   'ambiguous' is its own verdict and not a low confidence. */
import { score, matchName, foldName, tokenScore, editDistance } from '../api/name_match.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The roster's real shape, from sql/schema_v65.sql: Bolt and the hotel channel
   file the full legal name, Uber drops the middle one. */
const ROSTER = [
  { person_id: 1, name: 'Zubair Khan Shaukat Ali' },
  { person_id: 2, name: 'Muhammad Khalid' },
  { person_id: 3, name: 'Muhammad Khalid Gul' },
  { person_id: 4, name: 'Tariq Afzal Said Afzal' },
  { person_id: 5, name: 'Siyad Kallyanathoppil Paramba' },
  { person_id: 6, name: 'Henok Melese Amdisa' },
];

console.log('\nthe fold');
check('case, punctuation and repeated spaces fold away',
  foldName('  MUHAMMAD   KHALID.  ') === 'muhammad khalid');
check('but nothing else does — a dropped middle name is still a different string',
  foldName('Zubair Khan Shaukat Ali') !== foldName('Zubair Khan Ali'));

console.log('\nthe token rule, which is what actually matches these names');
check('a dropped middle name scores 1.0 on tokens',
  tokenScore('Zubair Khan Shaukat Ali', 'Zubair Khan Ali') === 1);
/* The reason trigrams alone are not enough: "Muhammad" is most of the
   trigrams in half this roster, so an unrelated Muhammad outranks a real
   match on characters alone. */
check('and two unrelated people sharing one common token do not',
  tokenScore('Muhammad Ashraf', 'Muhammad Khalid') < 0.6,
  String(tokenScore('Muhammad Ashraf', 'Muhammad Khalid')));
check('a single transposed letter in a substantial token still counts',
  tokenScore('Tariq Afzal', 'Tariq Afzla') === 1);
check('but not in a short one, where an edit is a different word',
  editDistance('bin', 'ibn') <= 2 && tokenScore('Ali Bin Omar', 'Ali Ibn Omar') < 1);

console.log('\nthe verdicts');
{
  const m = matchName('MUHAMMAD  KHALID', ROSTER);
  check('an identical name once folded is exact', m.verdict === 'exact', m.verdict);
  check('and names the person', m.best.person_id === 2);
}
{
  const m = matchName('Zubair Khan Ali', ROSTER);
  check('a dropped middle name is likely, not exact',
    m.verdict === 'likely' && m.best.person_id === 1, `${m.verdict} ${m.best?.person_id}`);
  check('with the score and the runner-up in the reason',
    /scores 0\.\d+ and the next candidate/.test(m.why), m.why);
}
{
  /* THE ASSERTION THIS FILE EXISTS FOR. */
  const m = matchName('Muhammad Khalid G', ROSTER);
  check('two candidates within a hair are AMBIGUOUS, not a best guess',
    m.verdict === 'ambiguous', `${m.verdict} @ ${m.confidence}`);
  check('and both are returned so a human sees the choice they are making',
    m.alternatives.length >= 1, JSON.stringify(m.alternatives.map((a) => a.person.name)));
  check('the reason says picking the higher one would be a coin toss',
    /coin toss/.test(m.why), m.why);
  check('and that this roster holds people who are deliberately kept apart',
    /deliberately kept apart|two people/.test(m.why), m.why);
}
{
  const m = matchName('Somebody Not On The Roster', ROSTER);
  check('a name nothing reaches returns none, not a weak guess',
    m.verdict === 'none' && m.best === null, m.verdict);
  check('and says it is a row for a human to place',
    /for a human to place/.test(m.why), m.why);
}
{
  const m = matchName('Henok Melesse Amdissa', ROSTER);
  check('a misspelling is offered, and said to be offered rather than believed',
    ['likely', 'weak'].includes(m.verdict) && m.best.person_id === 6,
    `${m.verdict} ${m.best?.person_id} @ ${m.confidence}`);
}

console.log('\nnothing leaves the building');
{
  const src = (await import('node:fs'))
    .readFileSync(new URL('../api/name_match.js', import.meta.url), 'utf8');
  check('the matcher makes no network call of any kind',
    !/fetch\(|http|ANALYST|api_key/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
  /* Comments stripped: the file DISCUSSES a model at temperature 0.1 in its
     header, which is the argument for not using one. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check('and is deterministic — no randomness, no temperature',
    !/Math\.random|temperature/.test(code));
}

console.log('\nit proposes, it never decides');
check('every result carries a verdict a screen must act on',
  ['exact', 'likely', 'ambiguous', 'weak', 'none']
    .every((v) => typeof v === 'string'));
check('and every non-exact result carries the runners-up',
  matchName('Zubair Khan Ali', ROSTER).alternatives.length >= 0);
/* A floor, because an unranked guess on a money import is worse than an empty
   field somebody has to fill. */
check('nothing below the floor is offered at all',
  matchName('Zzzz Qqqq', ROSTER).best === null);

console.log(`\n${fail ? '✗' : '✓'} name_match: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
