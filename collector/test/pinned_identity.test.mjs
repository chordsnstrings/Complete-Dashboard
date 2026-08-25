/* ── a frozen column of 1, 2, 3 and nobody's name ──────────────────────────
   The drivers directory is fourteen columns wide. On anything narrower than a
   laptop it scrolls sideways inside .tscroll, and app.css pins the FIRST
   column so the reader keeps hold of which row they are reading while the
   numbers slide past.

   Three tables led with `#` — a rank. So on a phone the pinned column was
   1, 2, 3, 4 … and the person each row is about scrolled away behind three
   narrow columns. Every figure on screen, and no way to attach any of it to
   anybody. The user's words for it: "drivers are not showing fares either.
   what did you audit?" — the fares were rendered, four columns to the right of
   a column that had frozen a row counter in front of them.

   The fix is not a wider name column. It is that a rank is not an identity: it
   is a property of the row's POSITION, and it costs the width of the one
   column that survives a scroll to say something the reader can count. So the
   rank moved inside the identity cell as `<span class="rk">`, and the identity
   leads.

   Two rules, checked here against the source rather than a rendered page,
   because this is a rule about how tables are DECLARED and a rendering harness
   only ever sees the routes it thought to visit:

     1. No column may be a bare index. A column whose label is #, No., Rank or
        Idx is a pinned column spent on a row counter.
     2. A rank rendered inside a cell must come from a value stamped on the
        ROW, never from indexOf(). tableFrom re-orders the array it is given IN
        PLACE on every sort, so a number derived from the row's position in
        that array renumbers itself 1..n the moment somebody sorts by Km — and
        then means nothing at all.

   Rule 2 is the one that would have rotted quietly: the page looks right on
   first paint and lies only after a click. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PUB = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public');
const files = readdirSync(PUB).filter((f) => f.endsWith('.js'));
const src = new Map(files.map((f) => [f, readFileSync(join(PUB, f), 'utf8')]));

console.log('\nno table spends its pinned column on a row counter');

check('the public UI is where table columns are declared',
  files.length > 8 && [...src.values()].some((s) => s.includes('tableFrom(')),
  `${files.length} files`);

/* A column label that is only a position. Written as one alternation so a new
   spelling of the same idea (Pos, Place) is caught by adding a word here. */
const INDEX_LABEL = /label:\s*['"](#|No\.?|Rank|Idx|Pos|Place)['"]/gi;

for (const [f, s] of src) {
  const hits = [...s.matchAll(INDEX_LABEL)]
    .map((m) => `${f}:${s.slice(0, m.index).split('\n').length} ${m[0]}`);
  check(`${f} declares no column that is only a row number`, hits.length === 0,
    hits.join(' | '));
}

console.log('\na rank is a property of the row, not of where the row sits');

for (const [f, s] of src) {
  if (!s.includes('class="rk"')) continue;
  /* tableFrom sorts the array it is handed IN PLACE, so a rank read out of
     that array renumbers itself 1..n on every click of a column header. */
  const bad = s.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes('class="rk"') && /\.indexOf\(/.test(line))
    .map(({ line, n }) => `${f}:${n} ${line.trim().slice(0, 80)}`);
  check(`${f} takes its rank from the row, not from indexOf`, bad.length === 0,
    bad.join(' | '));
}

const rankers = [...src].filter(([, s]) => s.includes('class="rk"')).map(([f]) => f);
check('the three tables that rank people all carry the badge',
  rankers.length >= 3, rankers.join(', '));

console.log('\nthe style that makes the badge readable, and the pin it exists for');

const css = readFileSync(join(PUB, 'app.css'), 'utf8');
check('.rk has a rule in app.css', /\.rk\s*\{/.test(css));
check('.rk sets a min-width, or ranks 1 and 12 push their names to different columns',
  /\.rk\s*\{[^}]*min-width/.test(css));
check('app.css pins the first column of a scrolling table — the whole reason '
  + 'the identity has to lead',
  /td:first-child[^}]*position:\s*sticky/.test(css.replace(/\s*,\s*/g, ',')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
