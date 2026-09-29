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
const people = new Set(MERGES.map((m) => m.key)).size;

console.log('\nthe register is the size both documents say it is');
check('MERGES is 132 entries', MERGES.length === 132, String(MERGES.length));
check('…over 126 people', people === 126, String(people));
check('…and 4 are deliberately held back', PENDING.length === 4, String(PENDING.length));
check('the three sweeps add up to the applied total',
  hand.length + (cand.length - PENDING.length) + roster.length === MERGES.length,
  `${hand.length} + ${cand.length - PENDING.length} + ${roster.length}`);
check('and each sweep is the size the header states',
  hand.length === 5 && cand.length === 49 && roster.length === 82,
  `${hand.length} / ${cand.length} / ${roster.length}`);
check('six keys carry more than one entry, which mergedIds() unions',
  MERGES.length - people === 6, String(MERGES.length - people));

console.log('\nand both documents say those numbers, in words');
check('the register header states the applied total',
  /a hundred and thirty-two\s+entries\s+over a hundred and twenty-six people/.test(src),
  'api/identity_map.js');
check('…and the held-back count', /PENDING is VERIFIED AND\s+DELIBERATELY NOT APPLIED: four pairs/.test(src));
check('…and the roster sweep size', /·\s*82 in FROM_ROSTER/.test(src));
check('…and the hand-merge size', /·\s*5 in HAND_MERGES/.test(src));
check('…and the shared-history sweep size', /·\s*49 in CANDIDATES/.test(src));
check('CLAUDE.md states the same pair',
  /applies 132 entries over 126 people/.test(claude), 'CLAUDE.md');
check('…the same sweep split', /5 hand-checked, 45 from a shared-custody sweep, 82 on a phone/.test(claude));
check('…the same held-back count', /holds back 4 that carry a\s*\n?simultaneous trip/.test(claude));
check('…and the same duplicate count', /six people are\s*\n?on the list twice/.test(claude));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
