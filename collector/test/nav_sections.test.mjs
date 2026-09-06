/* Six sections, and nothing outside them.
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
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');

/* ── what the file declares ──────────────────────────────────────────────── */
const SECTIONS = [...src.matchAll(/\{ id: '([A-Z][a-z]+)', ic: '[^']*', to: '([a-z-]+)' \}/g)]
  .map((m) => ({ id: m[1], to: m[2] }));
const VIEWS = [...src.matchAll(/\{ id: '([a-z-]+)', label: '[^']*', ic: '[^']*', sec: '([A-Z][a-z]+)'/g)]
  .map((m) => ({ id: m[1], sec: m[2] }));
/* Every V.<name> handler, which is the real list of addresses the router can
   reach — VIEWS is only the ones that also want a rail row. */
const HANDLERS = [...new Set([...src.matchAll(/^V\.([a-zA-Z]+) = /gm)].map((m) => m[1]))];
const drillBlock = src.match(/const DRILL_SECTION = \{([\s\S]*?)\};/);
const DRILL = drillBlock
  ? Object.fromEntries([...drillBlock[1].matchAll(/([a-z]+): '([A-Z][a-z]+)'/g)].map((m) => [m[1], m[2]]))
  : {};

console.log('\nthe rail is six sections and every one of them goes somewhere');
check('six sections are declared', SECTIONS.length === 6, String(SECTIONS.length));
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

console.log('\nthe collapsing-group machinery is gone, not merely unused');
check('no group heading is rendered', !/el\('button', `grp/.test(src));
check('and the stylesheet no longer styles one',
  !/#nav \.grp\{/.test(readFileSync(new URL('../api/public/app.css', import.meta.url), 'utf8')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
