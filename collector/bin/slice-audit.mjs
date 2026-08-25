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
*/
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public');
const files = readdirSync(PUB).filter((f) => f.endsWith('.js'));

/* Words a caption uses when it is owning up to a cut. `capped:` is tableFrom's
   own option, which renders a "show all" control and a count. */
const DISCLOSES = /capped\s*:|truncated|\bshowing\b|\bof \$\{|busiest first|highest of|largest of|\.length\)/i;
/* How far to look for the disclosure. The caption is appended right after the
   table it explains — but "right after" is on the far side of the column list,
   and a column list is as long as the table is wide. The cross-platform table
   is nine columns with four multi-line renders between the slice and its
   sentence, which put them 34 lines apart; at 26 this reported a table that
   discloses. Sixty is still local: it cannot reach past the next panel. */
const WINDOW = 60;

let cuts = 0, silent = 0;
const report = [];

for (const f of files) {
  const src = readFileSync(join(PUB, f), 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    const m = line.match(/tableFrom\(\s*([A-Za-z_$][\w.$]*)\s*\.slice\(0,\s*(\d+)\)/);
    if (!m) return;
    cuts += 1;
    const [, list, n] = m;
    /* The whole table call plus what follows it: the disclosure is usually the
       caption appended to the same panel body a few lines below the closing
       bracket of the column array. */
    const near = lines.slice(Math.max(0, i - 6), i + WINDOW).join('\n');
    if (DISCLOSES.test(near)) return;
    silent += 1;
    report.push(`${f}:${i + 1}  ${list}.slice(0, ${n})  — ${line.trim().slice(0, 62)}`);
  });
}

console.log(`\n${cuts} table(s) render a cut list; ${silent} say nothing about it\n`);
report.forEach((r) => console.log(`  ✗ ${r}`));
if (!silent) console.log('  every cut list names its own total');
console.log();
process.exit(silent ? 1 : 0);
