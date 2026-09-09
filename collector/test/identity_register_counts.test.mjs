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
   this fails and says which number moved, which is the whole point. */
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
check('MERGES is 130 entries', MERGES.length === 130, String(MERGES.length));
check('…over 124 people', people === 124, String(people));
check('…and 5 are deliberately held back', PENDING.length === 5, String(PENDING.length));
check('the three sweeps add up to the applied total',
  hand.length + (cand.length - PENDING.length) + roster.length === MERGES.length,
  `${hand.length} + ${cand.length - PENDING.length} + ${roster.length}`);
check('and each sweep is the size the header states',
  hand.length === 3 && cand.length === 50 && roster.length === 82,
  `${hand.length} / ${cand.length} / ${roster.length}`);
check('six keys carry more than one entry, which mergedIds() unions',
  MERGES.length - people === 6, String(MERGES.length - people));

console.log('\nand both documents say those numbers, in words');
check('the register header states the applied total',
  /a hundred and thirty\s+entries\s+over a hundred and twenty-four people/.test(src)
  || /hundred and thirty[\s\S]{0,80}hundred and twenty-four/.test(src), 'api/identity_map.js');
check('…and the roster sweep size', /·\s*82 in FROM_ROSTER/.test(src));
check('CLAUDE.md states the same pair',
  /applies 130 entries over 124 people/.test(claude), 'CLAUDE.md');
check('…the same sweep split', /3 hand-checked, 45 from a shared-custody sweep, 82 on a phone/.test(claude));
check('…the same held-back count', /holds back 5 that carry a\s*\n?simultaneous trip/.test(claude));
check('…and the same duplicate count', /six people are\s*\n?on the list twice/.test(claude));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
