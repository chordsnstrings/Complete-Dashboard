/* The colour contract: one source, one generated block, and an old skin that
   did not move.
   ─────────────────────────────────────────────────────────────────────────
   STEP 0 of the Arkiv reskin (docs/UI-REDESIGN-PLAN.md §3). api/public/
   tokens.js is the one place a colour is defined (SPEC L5.1), and
   bin/gen-tokens-css.mjs writes it into app.css under :root[data-skin=
   "arkiv"]. What is asserted here, and why each one exists:

   1. tokens.js is the design's file, value for value. Its lint is clean and
      cssTokens() hashes to the block all 65 mockups carry.
   2. The block in app.css is exactly what the generator writes from
      tokens.js — a hand edit, or a tokens.js edit nobody regenerated, fails.
   3. The block is scoped to the skin and sits AFTER the old dark blocks, so
      production is untouched and the skin wins in both themes.
   4. The --ink-2 collision stays resolved. The old --ink-2 was secondary
      TEXT (#5b6165); Arkiv's is near-black EMPHASIS (#2E2E31). Every old use
      was renamed (old --ink-3 → --grey, old --ink-2 → --grey-strong) before
      the new one was declared, and the old skin paints the new names with the
      old values in all three theme states. A branch written before the rename
      (another agent is changing driver.js, day.js and m/screens.js at the
      same time) merges in `var(--ink-3)`, which would be undefined, or
      `var(--ink-2)`, which would silently mean near-black under the skin —
      both fail here, by name.
   5. SOURCE_TOKEN names --c-*, the old skin aliases each to its --ch-*, and
      the dominance bar still derives its ch-* class from the new name.
   6. No stylesheet or module asks for a custom property nobody declares.
      --card, --line, --sunken, --muted and --bad were asked for by 24 rules
      of the money form and declared nowhere, so its inputs had no border.
   7. No literal white where a token exists for the job.
   8. sw.js precaches every module the phone statically imports. */
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const T = await import('../api/public/tokens.js');
const G = await import('../bin/gen-tokens-css.mjs');
const app = read('app.css');
const mcss = read('m/m.css');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

/* Every front-end source file, by path relative to api/public. */
const walk = (dir) => readdirSync(new URL(dir, PUB), { withFileTypes: true }).flatMap((d) => {
  const p = `${dir}${d.name}`;
  if (d.isDirectory()) return ['vendor', 'fonts', 'icons'].includes(d.name) ? [] : walk(`${p}/`);
  return /\.(js|css|html)$/.test(d.name) ? [p] : [];
});
const FILES = walk('');
const SRC = new Map(FILES.map((f) => [f, read(f)]));

console.log('\n1 · tokens.js is the design’s token file, value for value');
check('lintTokens() is clean', T.lintTokens().length === 0, T.lintTokens().join(' | '));
/* The hash of the :root block every one of the 65 mockup pages carries
   inline (44 in arkiv/arkiv-pages, 21 in arkiv-new, measured 2026-09-23 with
   the command in tokens.js's header). Equal means the port changed no value
   and dropped no token. A DELIBERATE token change updates this hash and says
   why in the commit — it is a change to the approved design. */
const md5 = createHash('md5').update(`<style>${T.cssTokens()}</style>\n`).digest('hex');
check('cssTokens() is byte-identical to the mockups’ generated :root',
  md5 === 'b46907d2df65aa93a6011cc73d370a2b', md5);
check('it governs exactly the 43 hexes the 44 pages emit', T.allTokenHexes().size === 43,
  String(T.allTokenHexes().size));
/* Contrast on Arkiv paper. Text tokens must clear 4.5:1; grey-2 must NOT, or
   its rules-and-outlines restriction has stopped meaning anything. */
for (const [name, hex] of [['ink', T.NEUTRAL.ink], ['ink-2', T.NEUTRAL.ink2], ['grey', T.NEUTRAL.grey],
  ['sem-pos', T.SEMANTIC.positive], ['sem-neg', T.SEMANTIC.negative]])
  check(`--${name} ${hex} is text-legible on paper (${T.contrast(hex).toFixed(2)}:1 ≥ 4.5)`, T.contrast(hex) >= 4.5);
check(`--grey-2 stays a rules-only token (${T.contrast(T.NEUTRAL.grey2).toFixed(2)}:1 < 4.5)`,
  T.contrast(T.NEUTRAL.grey2) < 4.5);
check('an unknown feed is grey, not the first channel', T.channelOf('no-such-feed') === T.NEUTRAL.grey);
check('there is no amber: no token sits between the two semantics’ hues as a third severity',
  !Object.keys(T.SEMANTIC).some((k) => /warn|amber|serious/i.test(k)));

console.log('\n2 · the block in app.css is the one the generator writes');
const b = app.indexOf(G.BEGIN), e = app.indexOf(G.END);
check('app.css carries the markers, once each, in order',
  b > 0 && e > b && app.indexOf(G.BEGIN, b + 1) < 0 && app.indexOf(G.END, e + 1) < 0);
let applied = null;
try { applied = G.apply(app); } catch (err) { applied = String(err); }
check('re-running bin/gen-tokens-css.mjs would change nothing', applied === app,
  'app.css and tokens.js disagree — run node bin/gen-tokens-css.mjs, never hand-edit the block');
const block = b > 0 && e > b ? app.slice(b + G.BEGIN.length, e) : '';
const rules = [...stripComments(block).matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .map((m) => ({ sel: m[1].trim(), decls: m[2].split(';').map((d) => d.trim()).filter(Boolean) }));
check('the block is one rule', rules.length === 1, String(rules.length));
const want = [...T.cssDeclarations(), ...T.bridgeDeclarations()];
const got = rules[0]?.decls || [];
check(`it declares all ${want.length} tokens and nothing else, in order`,
  got.length === want.length && got.every((d, i) => d === want[i]),
  got.filter((d) => !want.includes(d)).concat(want.filter((d) => !got.includes(d))).join(' '));

console.log('\n3 · it is inert on production and wins under the skin');
/* The literal, not G.SELECTOR: a generator edited to write a bare :root
   would otherwise agree with itself and pass. */
check('the selector is :root[data-skin="arkiv"], never a bare :root',
  rules[0]?.sel === ':root[data-skin="arkiv"]', rules[0]?.sel);
/* Same specificity (0,2,0) as both old dark blocks, so ORDER decides: after
   them, the skin's paper beats the old dark paper, and the old dark palette
   never shows through the new skin. */
const lastDark = Math.max(app.lastIndexOf(':root[data-theme="dark"]{'),
  app.lastIndexOf(':root:not([data-theme="light"]){'));
check('it comes after the old theme blocks', lastDark > 0 && b > lastDark);

console.log('\n4 · the --ink-2 collision stays resolved');
/* The three theme states of the OLD skin, as text: the light :root, the
   system-dark media block and the explicit dark block. */
const oldCss = app.slice(0, b);
const lightRoot = oldCss.slice(oldCss.indexOf(':root{'), oldCss.indexOf('@media (prefers-color-scheme: dark)'));
const mediaDark = oldCss.slice(oldCss.indexOf(':root:not([data-theme="light"]){'), oldCss.indexOf(':root[data-theme="dark"]{'));
const explicitDark = oldCss.slice(oldCss.indexOf(':root[data-theme="dark"]{'));
const valueIn = (css, name) => (stripComments(css).match(new RegExp(`(?:^|[;{\\s])${name}:([^;]+);`)) || [])[1]?.trim();
/* The old values, pinned until the flip: the rename moved no pixel. */
for (const [state, css, grey, strong] of [['light', lightRoot, '#8b9095', '#5b6165'],
  ['system dark', mediaDark, '#7b8288', '#a9afb5'], ['explicit dark', explicitDark, '#7b8288', '#a9afb5']]) {
  check(`old skin, ${state}: --grey is the old --ink-3 (${grey})`, valueIn(css, '--grey') === grey, valueIn(css, '--grey'));
  check(`old skin, ${state}: --grey-strong is the old --ink-2 (${strong})`,
    valueIn(css, '--grey-strong') === strong, valueIn(css, '--grey-strong'));
}
const oldNames = (s) => [...stripComments(s).matchAll(/[\w$-]*\bink-3\b|var\(\s*--ink-2\b|['"`]--ink-2['"`]|['"`]ink-2['"`]|--ink-2\s*:/g)].map((m) => m[0]);
/* Where --ink-2 may legitimately appear: the generated block (Arkiv's
   emphasis) and tokens.js. A module or stylesheet that MEANS Arkiv emphasis
   belongs to the skin; add it here, with a reason, when one exists. */
/* arkiv.css is the skin itself: every rule in it sits under
   :root[data-skin="arkiv"], where --ink-2 IS Arkiv's near-black emphasis, and
   test/arkiv_skin.test.mjs fails any rule of it that is not so scoped. */
const INK2_ALLOWED = new Set(['tokens.js', 'arkiv.css']);
const offenders = [];
for (const [f, s] of SRC) {
  if (INK2_ALLOWED.has(f)) continue;
  const text = f === 'app.css' ? app.slice(0, b) + app.slice(e) : s;
  const hits = oldNames(text);
  if (hits.length) offenders.push(`${f}: ${[...new Set(hits)].join(', ')}`);
}
check('no file asks for --ink-3, and none outside the skin asks for --ink-2', offenders.length === 0,
  `${offenders.join(' · ')} — old secondary text is --grey-strong, old dim text is --grey; --ink-2 is Arkiv emphasis`);

console.log('\n5 · SOURCE_TOKEN names --c-*, and the old skin paints them with --ch-*');
const { SOURCE_TOKEN, sourceToken } = await import('../api/public/ui.js');
for (const k of T.CHANNEL_ORDER) {
  check(`SOURCE_TOKEN.${k} is --c-${k}`, SOURCE_TOKEN[k] === `--c-${k}`, SOURCE_TOKEN[k]);
  check(`the old skin aliases --c-${k} to --ch-${k}`, valueIn(lightRoot, `--c-${k}`) === `var(--ch-${k})`,
    valueIn(lightRoot, `--c-${k}`));
  for (const [state, css] of [['light', lightRoot], ['system dark', mediaDark], ['explicit dark', explicitDark]])
    check(`…and --ch-${k} is declared in the old ${state} state`, !!valueIn(css, `--ch-${k}`));
}
check('uber_fleet is Uber', SOURCE_TOKEN.uber_fleet === '--c-uber');
/* Unchanged until STEP 2 converts the chart callers: today every caller falls
   through to the categorical palette on null, and '--grey' would repaint them. */
check('an unmapped source is still null (STEP 2 makes it --grey)', sourceToken('no-such-feed') === null);
/* The dominance bar turns the token into a class. It stripped only --ch-, so
   --c-uber became `ch---c-uber`, which no rule matches: the fill vanished. */
const ui = read('ui.js');
const strips = [...ui.matchAll(/p\.token\.replace\((\/[^/\n]+\/[a-z]*),\s*''\)/g)]
  .map((m) => new RegExp(m[1].slice(1, m[1].lastIndexOf('/')), m[1].slice(m[1].lastIndexOf('/') + 1)));
check('dominantBar derives its channel class in two places', strips.length === 2, String(strips.length));
check('…and both turn --c-uber AND --ch-uber into ch-uber',
  strips.length > 0 && strips.every((re) => '--c-uber'.replace(re, '') === 'uber' && '--ch-uber'.replace(re, '') === 'uber'));
for (const cls of ['domb-seg', 'sw'])
  for (const k of T.CHANNEL_ORDER)
    check(`.${cls}.ch-${k} fills with var(--c-${k})`, app.includes(`.${cls}.ch-${k}{background:var(--c-${k})}`));

console.log('\n6 · no custom property is asked for and declared nowhere');
/* arkiv.css too, since STEP 1: it declares names of its own (--gut, --sans,
   --disp) and asks for dozens, and a name it asks for that nobody declares
   fails silently exactly as the money form's did. */
const acss = read('arkiv.css');
const cssAll = stripComments(app) + '\n' + stripComments(mcss) + '\n' + stripComments(acss);
const jsAll = [...SRC].filter(([f]) => !f.endsWith('.css')).map(([, s]) => s).join('\n');
const declared = new Set([...(cssAll + '\n' + jsAll).matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
for (const m of jsAll.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)/gi)) declared.add(m[1]);
const asked = new Map();
const note = (name, where) => { if (!asked.has(name)) asked.set(name, new Set()); asked.get(name).add(where); };
for (const [f, s] of [['app.css', stripComments(app)], ['m/m.css', stripComments(mcss)], ['arkiv.css', stripComments(acss)]])
  for (const m of s.matchAll(/var\(\s*(--[a-z0-9-]+)(?!\$\{)/gi)) note(m[1], f);
for (const [f, s] of SRC) {
  if (f.endsWith('.css')) continue;
  for (const m of s.matchAll(/var\(\s*(--[a-z0-9-]+)(?![\w-]*\$\{)/gi)) note(m[1], f);
  for (const m of s.matchAll(/['"`](--[a-z][a-z0-9-]*)['"`]/g)) note(m[1], f);
}
const undeclared = [...asked].filter(([n]) => !declared.has(n));
check('every var() and every token string resolves to a declaration', undeclared.length === 0,
  undeclared.map(([n, w]) => `${n} (${[...w].join(', ')})`).join(' · '));
check('…and that check is looking at something', asked.size > 60, `${asked.size} names`);
for (const t of ['--card', '--line', '--sunken', '--muted', '--bad'])
  check(`${t} is declared in the old :root`, !!valueIn(lightRoot, t), valueIn(lightRoot, t));

console.log('\n7 · no literal white where a token does the job');
const whites = [];
for (const [f, s] of SRC) {
  if (f === 'tokens.js') continue;          // the definition, not a use
  const code = f.endsWith('.css') ? stripComments(s) : s;
  const hit = f.endsWith('.css')
    ? [...code.matchAll(/(?:^|[;{\s])(?:color|background|border-color|stroke|fill)\s*:\s*(?:#fff(?:fff)?|white)\b/gi)]
    : [...code.matchAll(/['"](?:#fff(?:fff)?|white)['"]/gi)];
  if (hit.length) whites.push(`${f} ×${hit.length}`);
}
check('no rule or module paints a literal #fff', whites.length === 0, whites.join(' '));
check('the chosen chip is --on-accent on the accent', /\.depchip\.on\s*\{[^}]*color:\s*var\(--on-accent\)/.test(app));
check('the phone’s primary button is --on-accent', /\.m-btn\.primary\s*\{[^}]*color:\s*var\(--on-accent\)/.test(mcss));
check('map and driver pins ring in --paper',
  /color: css\('--paper'\)/.test(read('map.js')) && /color: css\('--paper'\)/.test(read('driver.js')));

console.log('\n8 · the service worker precaches every module the phone imports');
const sw = read('sw.js');
const shell = new Set([...sw.slice(sw.indexOf('const SHELL_FILES'), sw.indexOf('self.addEventListener'))
  .replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/'([^']+)'/g)].map((m) => m[1]));
const reach = new Set();
const queue = ['/m/app.js'];
while (queue.length) {
  const f = queue.shift();
  if (reach.has(f)) continue;
  reach.add(f);
  const s = read(f.slice(1));
  /* Static imports only — a dynamic import() is fetched when it is used, and
     m/screens.js's driver.js / vehicle.js fallback says so on screen. */
  for (const m of stripComments(s).matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]/gm))
    queue.push(posix.normalize(posix.join(posix.dirname(f), m[1] || m[2])));
}
const missing = [...reach].filter((f) => !shell.has(f));
check(`all ${reach.size} statically reachable phone modules are in SHELL_FILES`, missing.length === 0,
  missing.join(' '));
check('tokens.js is one of them', reach.has('/tokens.js') && shell.has('/tokens.js'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
