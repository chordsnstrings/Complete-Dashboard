/* The register's own description of itself, checked against the register.
   ──────────────────────────────────────────────────────────────────────────
   Nothing here is about whether a merge is CORRECT — test/identity_map.test.mjs
   and the hand review own that. This file exists because the prose went stale
   and nothing noticed.

   api/identity_map.js's header said "ninety-three entries over ninety people"
   and listed "45 in FROM_ROSTER" long after the register had grown to 130 over
   124 with 82 from the roster. CLAUDE.md then copied the wrong pair, and
   CLAUDE.md is the first thing read in this repository — so the file every
   session starts from was describing the merge register with numbers that had
   not been true for weeks.

   A count in prose is a measurement like any other, and the house rule for a
   measurement is that it is either checked or it is not believed. These are
   the four numbers both documents state; if a merge is added or held back,
   this fails and says which number moved, which is the whole point.

   2026-09-29, the operator's ruling on Ali Abbas Ahmed: 131 → 132 entries,
   125 → 126 people, 5 → 4 held back, HAND_MERGES 4 → 5, CANDIDATES 50 → 49.
   And one of these checks had been passing on a FALSE header for a week. The
   header check was `/a hundred and thirty entries over a hundred and
   twenty-four people/ || /hundred and thirty…hundred and twenty-four/`, while
   the register itself was 131 over 125 from the Sana ruling on 2026-09-22 —
   so it pinned the stale words rather than the size, and the counts above it
   were right while the prose below them was not. It now names the one true
   sentence and nothing else, and the held-back count and the CANDIDATES size
   are checked in the header's words too, since both moved with this ruling.
   2026-10-08, the operator's review ("go through it together"): 132 → 460
   entries, 126 → 237 people, 4 → 0 held back, HAND_MERGES 5 → 10 (the four
   held back, ruled, and Amshid Khan re-keyed), CANDIDATES 49 → 45,
   FROM_ROSTER 82 → 81 (the Amshid entry moved), and a fourth list,
   FROM_REVIEW, of 324. Keys carrying more than one entry: 6 → 160.

   Proved by revert, 15 checks: with only the header's words put back to "a
   hundred and thirty-one … a hundred and twenty-five" (what it should have
   said before today), the header check fails, 1 of 15; with
   api/identity_map.js at the previous commit, 8 of 15 fail — the four sizes,
   the sweep split, and all four of the header's own sentences. */
import { readFileSync } from 'node:fs';
import { MERGES, PENDING } from '../api/identity_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync(new URL('../api/identity_map.js', import.meta.url), 'utf8');
const claude = readFileSync(new URL('../../CLAUDE.md', import.meta.url), 'utf8');

/* The three sweeps, counted out of the source rather than imported: they are
   module-private by design — only the union is exported — and the header's
   claim is about the sweeps, so the sweeps are what has to be counted. */
const keysIn = (name) => {
  const re = new RegExp(`(?:const|export const) ${name} = Object\\.freeze\\(\\[`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} is not declared in api/identity_map.js`);
  let depth = 1, i = m.index + m[0].length;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') { depth--; if (!depth) break; }
  }
  return [...src.slice(start, i).matchAll(/key:\s*'([^']+)'/g)].map((x) => x[1]);
};

const hand = keysIn('HAND_MERGES');
const cand = keysIn('CANDIDATES');
const roster = keysIn('FROM_ROSTER');
const review = keysIn('FROM_REVIEW');
const people = new Set(MERGES.map((m) => m.key)).size;

console.log('\nthe register is the size both documents say it is');
check('MERGES is 460 entries', MERGES.length === 460, String(MERGES.length));
check('…over 237 people', people === 237, String(people));
check('…and none is held back any more', PENDING.length === 0, String(PENDING.length));
check('the three sweeps add up to the applied total',
  hand.length + (cand.length - PENDING.length) + roster.length + review.length === MERGES.length,
  `${hand.length} + ${cand.length - PENDING.length} + ${roster.length} + ${review.length}`);
check('and each sweep is the size the header states',
  hand.length === 10 && cand.length === 45 && roster.length === 81 && review.length === 324,
  `${hand.length} / ${cand.length} / ${roster.length} / ${review.length}`);
{
  const per = {};
  for (const m of MERGES) per[m.key] = (per[m.key] || 0) + 1;
  const multi = Object.values(per).filter((n) => n > 1).length;
  check('160 keys carry more than one entry, which mergedIds() unions', multi === 160, String(multi));
}

console.log('\nand both documents say those numbers, in words');
check('the register header states the applied total',
  /four hundred and sixty\s+entries\s+over two hundred and thirty-seven people/.test(src),
  'api/identity_map.js');
check('…and the held-back count', /PENDING is VERIFIED AND\s+DELIBERATELY NOT APPLIED: none since 2026-10-08/.test(src));
check('…and the roster sweep size', /·\s*81 in FROM_ROSTER/.test(src));
check('…and the hand-merge size', /·\s*10 in HAND_MERGES/.test(src));
check('…and the shared-history sweep size', /·\s*45 in CANDIDATES/.test(src));
check('…and the review size', /·\s*324 in FROM_REVIEW/.test(src));
check('CLAUDE.md states the same pair',
  /applies 460 entries over 237 people/.test(claude), 'CLAUDE.md');
check('…the same sweep split', /10 hand-checked or hand-ruled, 45 from a shared-custody sweep, 81 on a phone\s+number the roster filed against both records, 324 from the operator's review/.test(claude));
check('…the same held-back count', /and holds back none/.test(claude));
check('…and the same duplicate count', /160 people\s*\n?carry more than one entry/.test(claude));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
