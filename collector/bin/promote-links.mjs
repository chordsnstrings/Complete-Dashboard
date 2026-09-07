#!/usr/bin/env node
/* Turn the links a roster proved into register entries, and land them.
   ═══════════════════════════════════════════════════════════════════════════
   src/identity_link.js discovers who is one person and api/identity_links.js
   applies it at the boundary, which folds the driver directory and the driver
   pages on the next request. It deliberately does NOT move person_key: that is
   a stored generated column over 364,015 rows, built from api/identity_map.js,
   and every rollup, statement fold and money surface groups by it. Until a link
   is promoted into the register those still count the two records apart — and a
   page that is right while a total is wrong is the worse of the two states,
   because only one of them is visible.

   Measured on production 2026-09-07, minutes after the Yango roster first
   landed: the driver pages folded 800 accounts into 440 people while /api/kpis,
   which groups by the stored key, reported 399 drivers. Two rules, one fleet.

   ── what is automatic here, and what deliberately is not ───────────────────
   Promotion is a person's decision and stays one. What was manual and should
   never have been is the TYPING: reading sixty rows off a page, working out
   which are already held, writing them out in the register's shape without a
   typo, remembering that three of them attach to an existing entry rather than
   opening a new one, and remembering which of the two records the register
   already keeps. That is not judgement, it is transcription, and every round of
   it is a chance to move a key that a quarter of a million stored rows carry.

   So this does all of it and stops at the decision:

       node bin/promote-links.mjs            # print the entries, change nothing
       node bin/promote-links.mjs --count    # just how many are waiting
       node bin/promote-links.mjs --write    # append them and regenerate the SQL

   --write is the same edit a person would make by hand, applied exactly: it
   appends to FROM_ROSTER and runs bin/gen-schema-v53.mjs. The register's own
   guard runs at import, so a batch that would merge a refused pair, move a
   key, or map one record onto two people fails there and nothing is written.
   Read the printed entries first; that is the part a machine must not do.  */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pool } from '../src/db.js';
import { MERGES, PENDING, REFUSED, foldName } from '../api/identity_map.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* EVERY id the register holds, not `m.merge.id`.
   ─────────────────────────────────────────────────────────────────────────
   An entry's alias is often two provider records — a Bolt numeral and a hotel
   ObjectId filed under one long name — so `merge.ids` is the commoner shape
   and `m.merge.id` is undefined on those entries. Reading the singular field
   put `undefined` in this set instead of eighty-five real ids, and this tool
   would then have printed, as new, links the register already holds. */
const mergeIdsOf = (m) => (m.merge?.ids || [m.merge?.id]).filter(Boolean);
/* Indexed by id rather than a bare Set, because "the register already holds
   one side of this pair" is not a reason to skip it — it is a reason to ATTACH
   the other side to the entry that exists instead of opening a second one. */
const entryOf = new Map();
for (const m of MERGES) for (const id of [m.keep.id, ...mergeIdsOf(m)]) entryOf.set(id, m);
const refused = new Set(REFUSED.flatMap((r) => [r.a.id, r.b.id]));
/* PENDING is not "not looked at yet". It is verified and deliberately not
   applied — a day on which both records took a trip at the same time in two
   different cars, which a shared phone cannot explain away. src/identity_link.js
   now declines to propose these at all; this is the second net, because a link
   written before that fix is still sitting in the table. */
const heldBack = new Set(PENDING.flatMap((m) => [m.keep.id, ...mergeIdsOf(m)]));

const q = (t, p = []) => pool.query(t, p).then((r) => r.rows);

const rows = await q(
  `SELECT * FROM driver_identity_link WHERE NOT rejected
    ORDER BY canonical_name NULLS LAST, alias_name NULLS LAST`).catch(() => []);

/* Four reasons a link is not a candidate, counted rather than silently
   dropped: the count of what was skipped is how a reader knows this list is
   shorter than the page's for a reason. */
const skip = { already_whole_pair: 0, held_back_pending: 0, refused_by_hand: 0, names_already_fold: 0 };
const out = [];
for (const r of rows) {
  const a = entryOf.get(r.alias_ext_id);
  const c = entryOf.get(r.canonical_ext_id);
  if (a && c && a === c) { skip.already_whole_pair++; continue; }
  if (heldBack.has(r.alias_ext_id) || heldBack.has(r.canonical_ext_id)) { skip.held_back_pending++; continue; }
  if (refused.has(r.alias_ext_id) && refused.has(r.canonical_ext_id)) { skip.refused_by_hand++; continue; }
  if (foldName(r.alias_name) === foldName(r.canonical_name)) { skip.names_already_fold++; continue; }
  /* THE SURVIVOR IS THE REGISTER'S, NOT THE RULE'S.
     ─────────────────────────────────────────────────────────────────────
     src/identity_link.js picks the fuller name as the survivor, which is right
     when neither record is known. When one of them is already an entry, its
     key is what every stored row carries — so taking the rule's survivor would
     MOVE that key. Measured 2026-09-07: the rule proposed "Raja Khalil Ahmed
     Raja Nouman Khalil" as the survivor of a man the register files as "Raja
     Nouman Ahmed". No key in this database moves except an alias record's. */
  const known = a || c;
  const addSide = a ? 'canonical' : 'alias';
  out.push(known
    ? { attachTo: known.key,
        key: known.key,
        keep: { id: known.keep.id, name: known.keep.name, channel: known.keep.channel },
        merge: {
          id: addSide === 'canonical' ? r.canonical_ext_id : r.alias_ext_id,
          name: addSide === 'canonical' ? r.canonical_name : r.alias_name,
          channel: addSide === 'canonical' ? r.canonical_platform : r.alias_platform,
        },
        tail: r.phone_tail }
    : { attachTo: null,
        key: foldName(r.canonical_name),
        keep: { id: r.canonical_ext_id, name: r.canonical_name, channel: r.canonical_platform },
        merge: { id: r.alias_ext_id, name: r.alias_name, channel: r.alias_platform },
        tail: r.phone_tail });
}
out.sort((x, y) => x.key.localeCompare(y.key));

if (process.argv.includes('--count')) {
  console.log(JSON.stringify({
    links: rows.length, promotable: out.length,
    attaching_to_an_existing_entry: out.filter((e) => e.attachTo).length, ...skip,
  }));
  await pool.end();
  process.exit(0);
}

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const entry = (e) => `  fromRoster({
    key: '${esc(e.key)}',
    keep:  { id: '${esc(e.keep.id)}', name: '${esc(e.keep.name)}', channel: '${esc(e.keep.channel)}' },
    merge: { id: '${esc(e.merge.id)}', name: '${esc(e.merge.name)}', channel: '${esc(e.merge.channel)}' },
    phoneTail: '${esc(e.tail)}',
  }),`;
const block = out.map(entry).join('\n');

const banner = `/* ${out.length} link${out.length === 1 ? '' : 's'} the roster proved and the register does not`
  + ' yet hold.\n'
  + `   ${out.filter((e) => e.attachTo).length} of them attach a record to a person already on the list,`
  + ' keeping that person\'s\n   existing surviving record so no stored key moves.\n'
  + `   Skipped: ${skip.already_whole_pair} already held whole, ${skip.held_back_pending} held back in`
  + ` PENDING, ${skip.refused_by_hand} refused by hand,\n   ${skip.names_already_fold} whose names the fold`
  + ' already covers. */';

if (!process.argv.includes('--write')) {
  console.log(banner);
  console.log(block || '  /* nothing waiting */');
  await pool.end();
  process.exit(0);
}

if (!out.length) { console.log('nothing waiting; register unchanged'); await pool.end(); process.exit(0); }

/* The same edit a person makes by hand: append inside FROM_ROSTER, then
   regenerate the SQL from the register. Anchored on the array's closing
   bracket rather than on a line number, and it refuses rather than guesses if
   the anchor is not exactly where it expects — a tool that writes the wrong
   half of this file is worse than one that does nothing. */
const MAP = join(ROOT, 'api', 'identity_map.js');
const src = readFileSync(MAP, 'utf8');
const open = src.indexOf('const FROM_ROSTER = Object.freeze([');
const close = open >= 0 ? src.indexOf('\n]);\n', open) : -1;
if (close < 0) {
  console.error('api/identity_map.js: could not find the end of FROM_ROSTER — nothing written');
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 10);
writeFileSync(MAP, `${src.slice(0, close)}\n\n  /* ── ${out.length} more the roster proved, added ${stamp} ──\n`
  + `     Written by bin/promote-links.mjs, which reads driver_identity_link and\n`
  + `     emits the register's own shape. Read them; the tool does the typing and\n`
  + `     not the deciding. */\n${block}${src.slice(close)}`);
console.log(`appended ${out.length} entries to api/identity_map.js`);
/* The register's guard runs at import, so this is where a bad batch stops. */
console.log(execFileSync('node', [join(ROOT, 'bin', 'gen-schema-v53.mjs')], { encoding: 'utf8' }).trim());
console.log('now run: npm test, then commit and deploy');
await pool.end();
