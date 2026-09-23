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
   8. sw.js precaches every module the phone statically imports.
   9. THE DARK SET (ruling 3). Every dark value clears the threshold the task
      and the design's evidence set — text 4.5:1 and marks 3:1 on the dark
      paper, channels apart under protanopia, deuteranopia and tritanopia,
      the semantic pair apart — measured here with thresholds written as
      literals, so loosening a gate in tokens.js does not loosen this file.
      The ported colour-blindness measure is first calibrated against the
      numbers PALETTE-EVIDENCE.md published from the validator itself. The
      generated block carries the dark values under the theme mechanism
      (OS dark guarded by :not([data-theme="light"]), and [data-theme="dark"]),
      only under the skin, and redeclares every colour the light block does. */
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
/* A brace-aware reading of the block: top-level rules, and the rules inside
   an @media. A regex over "{…}" cannot see the nesting. */
const parse = (css) => {
  const out = []; let depth = 0, start = 0, sel = '';
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') { if (depth === 0) { sel = css.slice(start, i).trim(); start = i + 1; } depth++; }
    else if (css[i] === '}') { depth--; if (depth === 0) { const body = css.slice(start, i);
      out.push(body.includes('{') ? { sel, children: parse(body) }
        : { sel, decls: body.split(';').map((d) => d.trim()).filter(Boolean) }); start = i + 1; } }
  }
  return out;
};
const rules = parse(stripComments(block));
check('the block is three rules: light, OS-dark (in its media query), chosen dark', rules.length === 3,
  rules.map((r) => r.sel).join(' | '));
const want = [...T.cssDeclarations(), ...T.themeDeclarations('light'), ...T.bridgeDeclarations()];
const got = rules[0]?.decls || [];
const sameList = (g, w) => g.length === w.length && g.every((d, i) => d === w[i]);
const diffList = (g, w) => g.filter((d) => !w.includes(d)).concat(w.filter((d) => !g.includes(d))).join(' ');
check(`the light rule declares all ${want.length} tokens and nothing else, in order`, sameList(got, want), diffList(got, want));
/* Built here from tokens.js, not taken from the generator, so a generator
   that dropped a token would not agree with itself. */
const wantDark = ['color-scheme:dark', ...T.cssDeclarations('dark'), ...T.themeDeclarations('dark')];
const media = rules[1], chosen = rules[2];
const sysDark = media?.children?.[0];
check('the OS-dark rule declares the dark set, in order', media?.children?.length === 1
  && sameList(sysDark?.decls || [], wantDark), diffList(sysDark?.decls || [], wantDark));
check('the chosen-dark rule declares the same, in order', sameList(chosen?.decls || [], wantDark),
  diffList(chosen?.decls || [], wantDark));
/* No light value may survive into dark: every COLOUR the light rule sets
   (everything but the form tokens and the bridge), the dark rules set again. */
const nameOf = (d) => d.slice(0, d.indexOf(':'));
const lightColours = got.map(nameOf).filter((n) => !/^--(hl-|mark-row|grey-strong)/.test(n));
const darkNames = new Set((chosen?.decls || []).map(nameOf));
const leaks = lightColours.filter((n) => !darkNames.has(n));
check(`every one of the light rule's ${lightColours.length} colour names is redeclared in dark`,
  lightColours.length >= 57 && leaks.length === 0, leaks.join(' '));
const hexIn = (ds) => new Set(ds.flatMap((d) => d.match(/#[0-9A-F]{6}/gi) || []).map((h) => h.toUpperCase()));
const lightHex = hexIn(got), darkHex = hexIn(chosen?.decls || []);
check('the dark rules carry only dark-set hexes, and every one of them',
  [...darkHex].every((h) => T.allTokenHexes('dark').has(h)) && darkHex.size === T.allTokenHexes('dark').size,
  `${darkHex.size} vs ${T.allTokenHexes('dark').size}`);

console.log('\n3 · it is inert on production and wins under the skin');
/* The literal, not G.SELECTOR: a generator edited to write a bare :root
   would otherwise agree with itself and pass. */
check('the selector is :root[data-skin="arkiv"], never a bare :root',
  rules[0]?.sel === ':root[data-skin="arkiv"]', rules[0]?.sel);
/* The dark rules answer to the SAME three theme states the old skin's dark
   blocks and #themeBtn do. The :not() guard is what lets a reader who chose
   light keep it on a dark OS; without the skin prefix the dark set would
   repaint production. Both are (0,3,0), heavier than every arkiv.css rule. */
check('OS dark: @media (prefers-color-scheme: dark) around :root[data-skin="arkiv"]:not([data-theme="light"])',
  rules[1]?.sel === '@media (prefers-color-scheme: dark)'
  && rules[1]?.children?.[0]?.sel === ':root[data-skin="arkiv"]:not([data-theme="light"])',
  `${rules[1]?.sel} › ${rules[1]?.children?.[0]?.sel}`);
check('chosen dark: :root[data-skin="arkiv"][data-theme="dark"]',
  rules[2]?.sel === ':root[data-skin="arkiv"][data-theme="dark"]', rules[2]?.sel);
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

console.log('\n9 · the dark set clears its thresholds (ruling 3)');
/* First, the ported measure is the validator's measure. These are the numbers
   PALETTE-EVIDENCE.md pasted from validate_palette.js itself (runs A2, A3,
   E1, E5b, F3); the port must give the same to the printed decimal, or every
   colour-blindness gate below is measuring something else. */
const r1 = (x) => Math.round(x * 10) / 10;
for (const [run, a, b, cvdW, normW] of [
  ['A2 Yango × Bolt', '#B4358A', '#0398BA', 8.6, null], ['A2 Bolt × Uber (normal)', '#0398BA', '#2362D3', null, 16.1],
  ['A3 the light pair', '#961111', '#007E44', 8.6, 28.0], ['E1 bronze × negative', '#884800', '#961111', 3.7, 9.8],
  ['E5b matched pair', '#007E44', '#B5352D', 4.2, 26.5], ['F3 old Bolt green × positive', '#1B7A4F', '#007E44', 1.7, 2.4]]) {
  const c = r1(T.cvdSeparation(a, b)), n = r1(T.deltaE(a, b));
  check(`the port reproduces ${run}: CVD ${cvdW ?? '–'} / normal ${normW ?? '–'}`,
    (cvdW == null || c === cvdW) && (normW == null || n === normW), `got CVD ${c} normal ${n}`);
}
/* Then the thresholds, as LITERALS: text 4.5:1 and marks 3:1 on the dark
   paper (the task's), the validator's 8.0 CVD target and 15.0 normal-vision
   floor, and 7.0 for a channel against a semantic on dark — the measured
   ceiling (docs/ARKIV-DARK.md §E), inside the validator's 6–8 band that is
   legal only because every semantic carries its glyph and sign. */
const D = T.THEMES.dark, DP = D.NEUTRAL.paper;
check('the dark paper is #111113, near-black with Arkiv\u2019s cool cast', DP === '#111113' && T.oklch(DP).C < 0.01);
for (const [name, hex] of [['ink', D.NEUTRAL.ink], ['ink-2', D.NEUTRAL.ink2], ['grey', D.NEUTRAL.grey],
  ['sem-pos', D.SEMANTIC.positive], ['sem-neg', D.SEMANTIC.negative]])
  check(`dark --${name} ${hex} is body text on the dark paper (${T.contrast(hex, DP).toFixed(2)}:1 ≥ 4.5)`,
    T.contrast(hex, DP) >= 4.5);
check(`dark --grey is also legible on paper-2, the table head (${T.contrast(D.NEUTRAL.grey, D.NEUTRAL.paper2).toFixed(2)}:1 ≥ 4.5)`,
  T.contrast(D.NEUTRAL.grey, D.NEUTRAL.paper2) >= 4.5);
for (const k of T.CHANNEL_ORDER)
  check(`dark --c-${k} ${D.CHANNEL[k]} is a mark on the dark paper (${T.contrast(D.CHANNEL[k], DP).toFixed(2)}:1 ≥ 3)`,
    T.contrast(D.CHANNEL[k], DP) >= 3);
const g2 = T.contrast(D.NEUTRAL.grey2, DP);
check(`dark --grey-2 / --abs-outline reads as a mark and stays rules-only (${g2.toFixed(2)}:1, 3 ≤ x < 4.5)`,
  g2 >= 3 && g2 < 4.5 && D.NEUTRAL.absOutline === D.NEUTRAL.grey2);
for (const k of T.CHANNEL_ORDER) {
  const h = (x) => T.oklch(x).H, gap = Math.min(Math.abs(h(D.CHANNEL[k]) - h(T.CHANNEL[k])), 360 - Math.abs(h(D.CHANNEL[k]) - h(T.CHANNEL[k])));
  check(`dark --c-${k} is the same channel: ${gap.toFixed(1)}° from its light hue (≤ 3)`, gap <= 3);
}
const pairsOf = (xs) => xs.flatMap((a, i) => xs.slice(i + 1).map((b) => [a, b]));
for (const [theme, collision] of [['light', 8.0], ['dark', 7.0]]) {
  const t = T.THEMES[theme];
  const ch = T.CHANNEL_ORDER.map((k) => [k, t.CHANNEL[k]]);
  const worst = (ps, f) => ps.map(([[a, x], [b, y]]) => [`${a} × ${b}`, f(x, y)]).sort((p, q) => p[1] - q[1])[0];
  const pc = worst(pairsOf(ch), T.cvdSeparation), pt = worst(pairsOf(ch), (x, y) => T.deltaE(x, y, 'tritan'));
  check(`${theme}: six channels, all pairs, protan/deutan ΔE ≥ 8.0 (worst ${pc[0]} ${pc[1].toFixed(2)})`, pc[1] >= 8.0);
  check(`${theme}: six channels, all pairs, tritan ΔE ≥ 8.0 (worst ${pt[0]} ${pt[1].toFixed(2)})`, pt[1] >= 8.0);
  const sp = T.cvdSeparation(t.SEMANTIC.positive, t.SEMANTIC.negative);
  check(`${theme}: the semantic pair, CVD ΔE ≥ 8.0 (${sp.toFixed(2)})`, sp >= 8.0);
  const eight = [...ch, ['positive', t.SEMANTIC.positive], ['negative', t.SEMANTIC.negative]];
  const pn = worst(pairsOf(eight), (x, y) => T.deltaE(x, y));
  check(`${theme}: all eight, normal-vision ΔE ≥ 15.0 (worst ${pn[0]} ${pn[1].toFixed(2)})`, pn[1] >= 15.0);
  const sweep = T.CHANNEL_ORDER.flatMap((k) => T.RAMP_STATES.flatMap((st) => ['positive', 'negative']
    .map((m) => [`${k}.${st} × ${m}`, T.cvdSeparation(t.RAMP[k][st], t.SEMANTIC[m]), T.deltaE(t.RAMP[k][st], t.SEMANTIC[m])])))
    .sort((p, q) => p[1] - q[1]);
  check(`${theme}: every ramp step × each semantic, CVD ΔE ≥ ${collision} (worst ${sweep[0][0]} ${sweep[0][1].toFixed(2)})`,
    sweep.length === 36 && sweep[0][1] >= collision);
  check(`${theme}: …and normal-vision ≥ 15.0 (worst ${Math.min(...sweep.map((x) => x[2])).toFixed(2)})`,
    Math.min(...sweep.map((x) => x[2])) >= 15.0);
  for (const k of T.CHANNEL_ORDER) {
    const on = t.NEUTRAL[T.ON_CHANNEL[theme][k]];
    check(`${theme}: the label on a ${k} fill (${T.ON_CHANNEL[theme][k]}) clears 4.5:1 (${T.contrast(on, t.CHANNEL[k]).toFixed(2)})`,
      T.contrast(on, t.CHANNEL[k]) >= 4.5);
  }
}
const sq = D.SEQUENTIAL.map((h) => T.contrast(h, DP));
check(`dark graphite: step 0 clears the 2:1 ordinal floor (${sq[0].toFixed(2)}) and each step is further from the paper`,
  sq[0] >= 2 && sq.every((c, i) => i === 0 || c > sq[i - 1]), sq.map((c) => c.toFixed(2)).join(' '));
const hatch = (theme) => Math.min(...T.CHANNEL_ORDER.map((k) => { const t = T.THEMES[theme];
  return T.contrast(T.mixHex(t.NEUTRAL.paper, t.CHANNEL[k], T.HATCH[theme]), t.NEUTRAL.paper); }));
check(`dark hatch (${T.HATCH.dark}) is no fainter than light's (${hatch('dark').toFixed(3)} ≥ ${hatch('light').toFixed(3)})`,
  hatch('dark') >= hatch('light'));
check('dark washes are 14% of their token on the dark paper, and ink reads on every one (≥ 4.5:1)',
  Object.entries(D.WASH).every(([k, w]) => T.contrast(D.NEUTRAL.ink, w) >= 4.5)
  && D.WASH.uber === T.mixHex(DP, D.CHANNEL.uber, 0.14) && D.WASH.negative === T.mixHex(DP, D.SEMANTIC.negative, 0.14));
check('an unknown feed is the dark grey in dark, not a channel', T.channelOf('no-such-feed', 'dark') === D.NEUTRAL.grey);
check('the light accessors are unchanged by the theme argument', T.channelOf('Uber') === T.CHANNEL.uber
  && T.sequentialOf(1) === T.SEQUENTIAL[5] && T.sequentialOf(1, 'dark') === D.SEQUENTIAL[5]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
