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
   delete the ones they disagree with, paste the rest into FROM_ROSTER, and run
   `node bin/gen-schema-v53.mjs` — which is the step that rewrites the stored
   column and is exactly where a review belongs.

       node bin/promote-links.mjs            # entries for every unpromoted link
       node bin/promote-links.mjs --count    # just how many are waiting

   It prints to stdout and writes nothing. A tool that edited the register
   would be a rule editing the list of things a rule may not decide. */
import { pool } from '../src/db.js';
import { MERGES, REFUSED, foldName } from '../api/identity_map.js';

/* EVERY id the register holds, not `m.merge.id`.
   ─────────────────────────────────────────────────────────────────────────
   An entry's alias is often two provider records — a Bolt numeral and a hotel
   ObjectId filed under one long name — so `merge.ids` is the commoner shape
   and `m.merge.id` is undefined on those entries. Reading the singular field
   put `undefined` in this set instead of eighty-five real ids, and this tool
   would then have printed, as new, links the register already holds. */
const mergeIdsOf = (m) => (m.merge?.ids || [m.merge?.id]).filter(Boolean);
const held = new Set(MERGES.flatMap((m) => [m.keep.id, ...mergeIdsOf(m)]));
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
console.log('   into FROM_ROSTER in api/identity_map.js, then run bin/gen-schema-v53.mjs.');
console.log(`   Skipped: ${skip.already_in_register} already in the register, `
  + `${skip.refused_by_hand} refused by hand, ${skip.names_already_fold} whose names the fold`);
console.log('   already covers. */');
/* The register's own shape for a roster-found pair: fromRoster() builds the
   evidence, the verification date and the basis, so what is pasted in is the
   two records and four digits and nothing a later reader has to check twice.
   `day` is printed in the header rather than per entry, because the helper
   stamps the date the whole batch was verified. */
for (const r of out) {
  console.log(`  fromRoster({
    key: '${esc(r.canonical_key)}',
    keep:  { id: '${esc(r.canonical_ext_id)}', name: '${esc(r.canonical_name)}', channel: '${esc(r.canonical_platform)}' },
    merge: { id: '${esc(r.alias_ext_id)}', name: '${esc(r.alias_name)}', channel: '${esc(r.alias_platform)}' },
    phoneTail: '${esc(r.phone_tail)}',
  }),`);
}
if (out.length) {
  console.log(`/* fromRoster() stamps verified '2026-09-07'. These were seen on ${day} — change`);
  console.log('   the date in the helper, or give this batch its own, before pasting. */');
}
await pool.end();
