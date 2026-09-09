/* A short rail, and nothing outside it.
   ─────────────────────────────────────────────────────────────────────────
   The rail used to hold thirty-six destinations in seven collapsible groups,
   and a detail page was lit through a PARENT map that named the top-level page
   it sat within. PARENT had entries for driver, vehicle, property, day,
   performer, action, slot, segments and segment — and NONE for `trip` or
   `cohort`, so #trip/<id> and #cohort/<key> lit nothing in the rail and forced
   no group open. The comment three lines above it described that exact defect
   as having been fixed for the other three.

   That is a hole a map develops silently: it is not wrong when it is written,
   it becomes wrong when somebody adds a view and does not think about the
   rail. So the map is checked against the two places views are declared — the
   VIEWS array and the V handler table — rather than against a list somebody
   maintains by hand, and a view added without a section fails here.

   Read as source rather than imported: app.js is a browser module with a
   top-level `document` and cannot be loaded in node. The shapes below are the
   ones the file actually uses, and each regex is anchored to a declaration
   rather than to prose. */
import { readFileSync, readdirSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');

/* ── what the file declares ──────────────────────────────────────────────── */
const SECTIONS = [...src.matchAll(/\{ id: '([A-Z][a-z]+)', ic: '[^']*', to: '([a-z-]+)' \}/g)]
  .map((m) => ({ id: m[1], to: m[2] }));
const VIEWS = [...src.matchAll(
  /\{ id: '([a-z-]+)', label: '([^']*)', ic: '[^']*', sec: '([A-Z][a-z]+)'(?:, sub: '([^']*)')?/g)]
  .map((m) => ({ id: m[1], label: m[2], sec: m[3], sub: m[4] || null }));
/* Every V.<name> handler, which is the real list of addresses the router can
   reach — VIEWS is only the ones that also want a rail row. */
const HANDLERS = [...new Set([...src.matchAll(/^V\.([a-zA-Z]+) = /gm)].map((m) => m[1]))];
const drillBlock = src.match(/const DRILL_SECTION = \{([\s\S]*?)\};/);
const DRILL = drillBlock
  ? Object.fromEntries([...drillBlock[1].matchAll(/([a-z]+): '([A-Z][a-z]+)'/g)].map((m) => [m[1], m[2]]))
  : {};

/* A RANGE, not a literal count — and the range is the invariant, which the
   literal never was.
   ─────────────────────────────────────────────────────────────────────────
   This read `SECTIONS.length === 6` and failed the day Finance was split back
   out of Money, which is a change the rail was supposed to be able to absorb.
   A test pinned to a number turns every deliberate navigation decision into a
   test failure and teaches whoever hits it to edit the number, which is the
   same as having no assertion at all.

   What actually matters is that the rail stays scannable. It held thirty-six
   destinations in seven collapsible groups and that is the failure this file
   was written about; below four the grouping is doing no work, above eight the
   rail is a menu again. Every other assertion here — each section lands on a
   real page inside itself, no section holds one page, no handler is orphaned —
   is the part that catches a mistake, and none of them cares how many there
   are. */
const RAIL_MIN = 4, RAIL_MAX = 8;
console.log('\nthe rail is a handful of sections and every one of them goes somewhere');
check('the rail is small enough to scan without a menu',
  SECTIONS.length >= RAIL_MIN && SECTIONS.length <= RAIL_MAX,
  `${SECTIONS.length} sections, expected ${RAIL_MIN}–${RAIL_MAX}`);
/* The regex above is the only thing that finds them, so an empty match reads
   as "nothing declared" rather than as a pass. */
check('…and the declarations were actually found', SECTIONS.length > 0, String(SECTIONS.length));
check('and each lands on a real page',
  SECTIONS.every((s) => VIEWS.some((v) => v.id === s.to)),
  JSON.stringify(SECTIONS.filter((s) => !VIEWS.some((v) => v.id === s.to))));
check('…on a page that is inside the section it lands from',
  SECTIONS.every((s) => (VIEWS.find((v) => v.id === s.to) || {}).sec === s.id),
  JSON.stringify(SECTIONS.filter((s) => (VIEWS.find((v) => v.id === s.to) || {}).sec !== s.id)));

console.log('\nevery page names a section, and no page names one that does not exist');
const names = new Set(SECTIONS.map((s) => s.id));
check('every VIEWS row carries a section', VIEWS.length >= 35, String(VIEWS.length));
const strays = VIEWS.filter((v) => !names.has(v.sec)).map((v) => `${v.id}→${v.sec}`);
check('and every one of them is a section that exists', strays.length === 0, strays.join(', '));
/* A section with one page needs no strip and reads as a category invented to
   hold one thing — which is what "Set up" was. */
const thin = SECTIONS.filter((s) => VIEWS.filter((v) => v.sec === s.id).length < 2);
check('no section holds fewer than two pages',
  thin.length === 0, thin.map((s) => s.id).join(', '));

console.log('\nand every address the router can reach lights something');
/* This is the assertion PARENT failed. `trip` and `cohort` had handlers and no
   entry, so two real addresses lit nothing at all. */
const IGNORE = new Set(['notfound', 'settings']);
const orphans = HANDLERS.filter((h) => !IGNORE.has(h)
  && !VIEWS.some((v) => v.id === h) && !DRILL[h]);
check('no V handler is missing from both VIEWS and DRILL_SECTION',
  orphans.length === 0, orphans.join(', '));
check('…including trip and cohort, which is the pair PARENT never covered',
  !!DRILL.trip && !!DRILL.cohort, JSON.stringify([DRILL.trip, DRILL.cohort]));
const badDrill = Object.entries(DRILL).filter(([, sec]) => !names.has(sec));
check('and every drill-down points at a section that exists',
  badDrill.length === 0, JSON.stringify(badDrill));

console.log('\nSettings left the rail rather than being a group of one');
check('it is not in any section', !VIEWS.some((v) => v.id === 'settings'),
  JSON.stringify(VIEWS.filter((v) => v.id === 'settings')));
const html = readFileSync(new URL('../api/public/index.html', import.meta.url), 'utf8');
check('…and is reachable from the footer instead',
  /id="settingsLink"[^>]*href="#settings"/.test(html));

/* ── the shell says the page's name; the page must not say it again ─────────
   The rail's own register already prints each view's label as the <h1> and its
   `sub` as the sentence under it, before the view's module runs at all. A page
   that then opens with panel('<its own label>', '<its own sub>') puts the same
   heading and the same sentence on the screen twice, a few hundred pixels
   apart — which is the defect the platforms page was fixed for, hand-fixed,
   with nothing stopping the next page from doing it.

   The Online time page did it the day it was written, and rendered against the
   fixtures before anybody noticed. So the rule is checked rather than
   remembered, and it is checked on the SUB rather than only on the label: a
   sub is a whole sentence, so a module containing one verbatim is repeating
   the shell and not coincidentally agreeing with it. The label is checked too,
   but only in the panel-title position, because short labels like "Money" or
   "Work" appear as ordinary words all over these files. */
console.log('\nno page reprints the heading the shell already gave it');
const pages = readdirSync(new URL('../api/public/', import.meta.url))
  .filter((f) => f.endsWith('.js') && f !== 'app.js');
const echoes = [];
for (const f of pages) {
  const body = readFileSync(new URL(`../api/public/${f}`, import.meta.url), 'utf8');
  for (const v of VIEWS) {
    if (v.sub && body.includes(v.sub)) echoes.push(`${f} repeats the sub of #${v.id}`);
    if (body.includes(`panel('${v.label}'`)) echoes.push(`${f} panels the label of #${v.id}`);
  }
}
check('no view module reprints its own label or its own one-liner',
  echoes.length === 0, echoes.join('; '));

/* ── a control that governs nothing is not shown ────────────────────────
   Every control in the toolbar has a rule saying which pages it applies to,
   and the reason is written at api/public/data.js:330 — "an address that
   carries a filter the destination page hides is a filter nobody can see,
   change or undo". The grain select had no rule at all and so appeared on all
   sixteen windowless pages, bucketing a window they do not have and riding
   along into every link leaving them. It buckets a window, so it applies
   exactly where a window does. */
console.log('\nthe grain select follows the window it buckets');
check('grain is hidden wherever the range is',
  /setDisp\('#fGrain', lost \|\| hidesRange\(state\.view\)\);/.test(src),
  'setDisp(\'#fGrain\', lost) showed it on #live, #sources, #day, #trip, '
  + '#segment, #map, #compliance, #online-time and eight more');
check('…and still set both ways, so it is not lost for the rest of the session',
  /Still set BOTH ways rather than only hidden/.test(src));

console.log('\nthe collapsing-group machinery is gone, not merely unused');
check('no group heading is rendered', !/el\('button', `grp/.test(src));
check('and the stylesheet no longer styles one',
  !/#nav \.grp\{/.test(readFileSync(new URL('../api/public/app.css', import.meta.url), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
