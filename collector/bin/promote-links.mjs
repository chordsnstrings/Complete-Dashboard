#!/usr/bin/env node
/* Turn the links a roster proved into register entries a person can review.
   ═══════════════════════════════════════════════════════════════════════════
   src/identity_link.js discovers who is one person and api/identity_links.js
   applies it at the boundary, which folds the directory and the driver pages
   on the next request. It deliberately does NOT move person_key: that is a
   stored generated column over 364,015 rows, built from api/identity_map.js,
   and every rollup, statement fold and money surface groups by it. Until a link
   is promoted into the register, those still count the two records apart — and
   a page that is right while a total is wrong is the worse of the two states,
   because only one of them is visible.

   Promotion is a human's decision and stays one. This does the typing: it
   reads the live links, drops the ones the register already holds and the ones
   whose names the fold covers anyway, and prints entries in the register's own
   shape with the evidence attached. What a person then does is read them,
   delete the ones they disagree with, paste the rest into MERGES, and run
   `node bin/gen-schema-v53.mjs` — which is the step that rewrites the stored
   column and is exactly where a review belongs.

       node bin/promote-links.mjs            # entries for every unpromoted link
       node bin/promote-links.mjs --count    # just how many are waiting

   It prints to stdout and writes nothing. A tool that edited the register
   would be a rule editing the list of things a rule may not decide. */
import { pool } from '../src/db.js';
import { MERGES, REFUSED, foldName } from '../api/identity_map.js';

const held = new Set(MERGES.flatMap((m) => [m.keep.id, m.merge.id]));
const refused = new Set(REFUSED.flatMap((r) => [r.a.id, r.b.id]));

const q = (t, p = []) => pool.query(t, p).then((r) => r.rows);

const rows = await q(
  `SELECT * FROM driver_identity_link WHERE NOT rejected
    ORDER BY canonical_name NULLS LAST, alias_name NULLS LAST`).catch(() => []);

/* Three reasons a link is not a candidate, counted rather than silently
   dropped: the count of what was skipped is how a reader knows this list is
   shorter than the page's for a reason. */
const skip = { already_in_register: 0, refused_by_hand: 0, names_already_fold: 0 };
const out = [];
for (const r of rows) {
  if (held.has(r.alias_ext_id) || held.has(r.canonical_ext_id)) { skip.already_in_register++; continue; }
  if (refused.has(r.alias_ext_id) || refused.has(r.canonical_ext_id)) { skip.refused_by_hand++; continue; }
  if (foldName(r.alias_name) === foldName(r.canonical_name)) { skip.names_already_fold++; continue; }
  out.push(r);
}

if (process.argv.includes('--count')) {
  console.log(JSON.stringify({ links: rows.length, promotable: out.length, ...skip }));
  await pool.end();
  process.exit(0);
}

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const day = new Date().toISOString().slice(0, 10);

console.log(`/* ${out.length} link${out.length === 1 ? '' : 's'} the roster proved and the register`);
console.log('   does not yet hold. Read each one, delete what you disagree with, paste the rest');
console.log('   into MERGES in api/identity_map.js, then run bin/gen-schema-v53.mjs.');
console.log(`   Skipped: ${skip.already_in_register} already in the register, `
  + `${skip.refused_by_hand} refused by hand, ${skip.names_already_fold} whose names the fold`);
console.log('   already covers. */');
for (const r of out) {
  console.log(`  {
    key: '${esc(r.canonical_key)}',
    keep:  { id: '${esc(r.canonical_ext_id)}', name: '${esc(r.canonical_name)}', channel: '${esc(r.canonical_platform)}' },
    merge: { id: '${esc(r.alias_ext_id)}', name: '${esc(r.alias_name)}', channel: '${esc(r.alias_platform)}' },
    plate: null,
    verified: '${day}',
    evidence:
      '${esc(r.evidence)}. '
      + 'Discovered by src/identity_link.js on ${r.first_seen_at ? String(r.first_seen_at).slice(0, 10) : day} '
      + 'and applied at the API boundary since; promoting it moves person_key, '
      + 'so every rollup counts the two records as one person too.',
  },`);
}
await pool.end();
