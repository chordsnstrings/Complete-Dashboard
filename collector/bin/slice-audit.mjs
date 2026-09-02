#!/usr/bin/env node
/* A list the SERVER sent whole and the PAGE cut.
   ─────────────────────────────────────────────────────────────────────────
   bin/cap-audit.mjs asks the database whether a handler's LIMIT is biting, and
   it reported zero silent caps. It cannot see this class at all: a page that
   receives every row and renders `rows.slice(0, 30)`.

   #finance was doing exactly that — 30 of 46 tipped drivers, with nothing on
   the page saying so — beside a server-side floor that had removed seven more.
   A table that ends on a round number is a table somebody cut, and the reader
   has no way to tell "these are the tipped drivers" from "these are the first
   thirty of them".

   So: every `.slice(0, N)` handed to tableFrom, checked for a disclosure. What
   counts as one is deliberately loose — a `capped:` option, the count in a
   nearby caption, `truncated`, "showing", "of" — because the point is to find
   the tables that say NOTHING, not to police the wording. A cut that is
   obviously not a cut (the caller sliced a list it just built, or N is larger
   than any real result) still gets reported; reading a listed line and deciding
   it is fine costs seconds, and a silent cut costs a wrong conclusion.

       node bin/slice-audit.mjs
       PUB=/some/copy/of/api/public node bin/slice-audit.mjs
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* PUB, so the tool can be pointed at a copy. A detector nobody can aim at a
   deliberately broken page is a detector nobody can prove still works. */
const PUB = process.env.PUB
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public');
const files = readdirSync(PUB).filter((f) => f.endsWith('.js'));

/* Words a caption uses when it is owning up to a cut. `capped:` is tableFrom's
   own option, which renders a "show all" control and a count.

   `\.length\)` used to be on this list and was a rubber stamp. Nearly every
   panel begins `if (!rows.length) empty(...)` — an emptiness guard, which says
   nothing whatever about a cut — and that alone marked a table as disclosing.
   Measured: it was the ONLY pattern matching the driver-licence table in
   app.js, whose real caption ("Showing 120 of …") sits 78 lines below the cut
   and was outside the window entirely. The tool passed that table for a reason
   that had nothing to do with it. */
/* `the worst` earns its place the same way `busiest first` did: the idle-time
   table in optimise.js counts its own rows against opt.totals.waits and ends
   "…had a measurable wait; these are the worst", which is a disclosure in
   every sense except the words this list happened to know. */
const DISCLOSES = /capped\s*:|truncated|\bshowing\b|\bof \$\{|busiest first|highest of|largest of|\bthe worst\b/i;
/* How far to look for the disclosure. The caption is appended right after the
   table it explains — but "right after" is on the far side of the column list,
   and a column list is as long as the table is wide: nine columns with
   multi-line renders put the cross-platform table 34 lines from its sentence,
   and the driver-licence table 78.

   So the window is the PANEL rather than a line count: from the table call
   forward to whatever comes first — the next tableFrom, the next panel — with
   200 lines as a backstop. That reaches a caption however wide the table is
   and still cannot borrow the sentence belonging to the next one. */
const MAX = 200;

let cuts = 0, silent = 0;
const report = [];

for (const f of files) {
  const src = readFileSync(join(PUB, f), 'utf8');
  const lines = src.split('\n');
  /* The end of the panel this table sits in: the next table, the next panel,
     or 200 lines, whichever comes first. */
  const endOfPanel = (from) => {
    for (let j = from + 1; j < Math.min(lines.length, from + MAX); j += 1) {
      if (/tableFrom\(/.test(lines[j]) || /=\s*panel\(/.test(lines[j])) return j;
    }
    return Math.min(lines.length, from + MAX);
  };
  lines.forEach((line, i) => {
    /* Both shapes of cut, and a size that is a NAME as well as a number.
       ───────────────────────────────────────────────────────────────────
       The old pattern was `tableFrom(list.slice(0, 30)` and nothing else, so
       two whole classes were invisible on every run:

         a cut assigned first —  const top = rows.slice(0, 12); … tableFrom(top
         a cut sized by a constant — list.slice(0, DRAW), DRAW = 400

       Measured against the product: 18 cuts matched the old pattern, 7 more
       are assigned first, and 2 more are sized by a constant. A quarter of the
       cut tables in this dashboard were never examined, and the run said "18
       tables render a cut list" as though that were all of them. */
    const inline = line.match(/tableFrom\(\s*([A-Za-z_$][\w.$]*)\s*\.slice\(0,\s*([A-Za-z0-9_$]+)\s*\)/);
    const assigned = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w.$]*)\s*\.slice\(0,\s*([A-Za-z0-9_$]+)\s*\)/);
    let cut = null;
    if (inline) cut = { at: i, list: inline[1], n: inline[2] };
    else if (assigned) {
      /* Only a cut that reaches a TABLE. A list sliced for a chart or a
         sentence is a different question and this tool does not ask it. */
      const drawn = lines.findIndex((l, j) => j > i
        && new RegExp(`tableFrom\\(\\s*${assigned[1]}\\b`).test(l));
      if (drawn !== -1) cut = { at: drawn, list: `${assigned[2]} → ${assigned[1]}`, n: assigned[3] };
    }
    if (!cut) return;
    cuts += 1;
    const near = lines.slice(Math.max(0, Math.min(i, cut.at) - 6), endOfPanel(cut.at)).join('\n');
    if (DISCLOSES.test(near)) return;
    silent += 1;
    report.push(`${f}:${i + 1}  ${cut.list}.slice(0, ${cut.n})  — ${line.trim().slice(0, 62)}`);
  });
}

console.log(`\n${cuts} table(s) render a cut list; ${silent} of them `
  + `${silent === 1 ? 'says' : 'say'} nothing about it\n`);
report.forEach((r) => console.log(`  ✗ ${r}`));
if (!silent) console.log('  every cut list names its own total');
console.log();
process.exit(silent ? 1 : 0);
