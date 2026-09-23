/* The Arkiv skin switch, and the restyle behind it — STEP 1 of the reskin.
   ─────────────────────────────────────────────────────────────────────────
   docs/UI-REDESIGN-PLAN.md §3, "Order of work", STEP 1: arkiv.css loads after
   app.css only under ?skin=arkiv, is remembered and stamped before paint, and
   carries the token values, the typography and every component restyle with
   NO DOM change. Production keeps its look until the operator flips it. What
   is asserted, and why each one exists:

   1. The stylesheet is hex-free and every rule is scoped to the attribute:
      colour lives in tokens.js alone (SPEC L5.1), and a rule without the
      prefix would restyle production the moment anything loaded the file.
   2. Every old-skin name that carries a colour is re-pointed onto an Arkiv
      token, so no old value — least of all an old DARK value — shows through
      the new skin. Checked in the source, and resolved in a browser in all
      three theme states.
   3. The switch: nothing loads arkiv.css unless asked; ?skin=arkiv stamps the
      attribute before the stylesheets, writes the <link> after app.css as a
      render-blocking (parser-inserted) sheet, and is remembered; ?skin=classic
      and ?skin=auto undo it. sw.js precaches the file.
   4. No DOM change: no module reads the skin, and the shared components render
      byte-identical markup under both skins. Every shell id is still there.
   5. The restyle, measured: the ruled panel with its counter, the tile whose
      digits stay ink, ONE warning rule (hollow dot = warning, solid =
      critical, no amber — ruling 1), notes, the verdict band, tables, tabs,
      buttons, the banner, the dominance bar's ink on each fill, and a caption
      that is still a sentence, not the mockups' mono capitals.
   6. At 390px the page does not scroll sideways.

   The browser half renders against mockapi.mjs — synthetic fixtures only. */
import { readFileSync, readdirSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const T = await import('../api/public/tokens.js');
const G = await import('../bin/gen-tokens-css.mjs');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const arkiv = read('arkiv.css');
const ark = strip(arkiv);
const app = read('app.css');
const html = read('index.html');
const PREFIX = ':root[data-skin="arkiv"]';

/* ══ 1. the stylesheet ════════════════════════════════════════════════════ */
console.log('\n1 · arkiv.css carries no colour of its own, and touches nothing outside the skin');
const hexes = ark.match(/#[0-9a-f]{3,8}\b/gi) || [];
check('no hex', hexes.length === 0, hexes.join(' '));
check('no rgb()/rgba()/hsl() literal', !/\b(?:rgba?|hsla?)\(/i.test(ark));
const NAMED = /(?<![-\w"'])(?:white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![-\w"'])/i;
const decls = [...ark.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1].split(';')).map((d) => d.trim()).filter(Boolean);
const named = decls.filter((d) => NAMED.test(d.split(':').slice(1).join(':')));
check('no named colour', named.length === 0, named.join(' | '));

/* Selectors, with @media unwrapped: a rule inside a media query is still a
   rule. Keyframes would be the one legitimate exception; there are none. */
const selectors = [];
{
  const body = ark.replace(/@media[^{]*\{/g, '');
  for (const m of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const s of m[1].split(',').map((x) => x.trim()).filter(Boolean)) selectors.push(s);
  }
}
const unscoped = selectors.filter((s) => !s.startsWith(PREFIX));
check(`every selector is scoped to ${PREFIX} (${selectors.length} of them)`,
  selectors.length > 150 && unscoped.length === 0, unscoped.slice(0, 6).join(' | '));
check('no @import — the mockups’ b.css and viz.css are not pulled in', !/@import/i.test(ark));
check('no @keyframes — nothing here animates', !/@keyframes/i.test(ark));
/* NAMESPACE, DON'T PASTE. .cap is a caption SENTENCE on 332 call sites here
   and 9.5px mono capitals in viz.css. The skin must never make it the latter. */
const capRules = [...ark.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').some((s) => /\.cap\s*$/.test(s.trim())));
check('.cap stays a sentence: no rule sets it in mono capitals',
  capRules.every((m) => !/text-transform\s*:\s*uppercase|font-family\s*:\s*var\(--mono\)|letter-spacing/.test(m[2])),
  capRules.map((m) => m[0].trim()).join(' | '));
/* One new step, and it is used. type_scale.test checks the scale itself. */
check('the new display step --d6 is declared in app.css’s scale', /--d6:\s*3\.15rem/.test(app));
check('…and used by the skin', /font-size:\s*var\(--d6\)/.test(ark));
check('no literal font-size', decls.filter((d) => /^font-size\s*:/.test(d))
  .every((d) => /var\(--[td]\d\)|clamp\(/.test(d)));

/* ══ 2. the tokens ════════════════════════════════════════════════════════ */
console.log('\n2 · every old-skin colour name is re-pointed onto an Arkiv token');
const b = app.indexOf(G.BEGIN);
const oldCss = strip(app.slice(0, b));
const genBlock = strip(app.slice(b, app.indexOf(G.END)));
const nameVals = (css) => [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)].map((m) => [m[1], m[2].trim()]);
/* A name the old skin paints with a colour: a literal hex or rgb in any of
   its three theme blocks. */
const coloured = new Set(nameVals(oldCss).filter(([, v]) => /#[0-9a-f]{3,8}\b|rgba?\(/i.test(v)).map(([n]) => n));
const generated = new Set(nameVals(genBlock).map(([n]) => n));
const skinRoot = (ark.match(/:root\[data-skin="arkiv"\]\s*\{([^{}]*)\}/) || [])[1] || '';
const repointed = new Map(nameVals(skinRoot));
/* --ch-* feed nothing but the old --c-* aliases, which the generated block
   redeclares under the skin — asserted here rather than assumed. */
const chUsers = [...readdirSync(PUB).filter((f) => /\.(js|css)$/.test(f)).map((f) => strip(read(f))),
  strip(read('m/m.css')), read('m/app.js'), read('m/screens.js'), read('m/ui.js')]
  .join('\n').match(/var\(--ch-[a-z]+\)/g) || [];
check('--ch-* is read only by the six --c-* aliases', chUsers.length === 6 * 1, String(chUsers.length));
const leak = [...coloured].filter((n) => !generated.has(n) && !repointed.has(n) && !/^--ch-/.test(n));
check(`all ${coloured.size} coloured old names are generated or re-pointed`, coloured.size > 40 && leak.length === 0,
  leak.join(' '));
const ARKIV_NAMES = new Set(T.cssDeclarations().map((d) => d.split(':')[0]));
/* The two shadows are the exception, and a deliberate one: they are rgba()
   in the old skin and `none` here — Arkiv draws no shadow on the sheet. */
const badTargets = [...repointed].filter(([n, v]) => coloured.has(n) && !/^--shadow-/.test(n)
  && !(new RegExp('^var\\((--[a-z0-9-]+)\\)$').test(v) && ARKIV_NAMES.has(v.slice(4, -1))));
check('…and the shadows are none', repointed.get('--shadow-1') === 'none' && repointed.get('--shadow-2') === 'none');
check('…each onto exactly one Arkiv token, by var(), with no value of its own', badTargets.length === 0,
  badTargets.map(([n, v]) => `${n}:${v}`).join(' '));
check('the accent is ink', repointed.get('--accent') === 'var(--ink)');
check('there is no amber: --warn and --serious are the negative semantic',
  repointed.get('--warn') === 'var(--sem-neg)' && repointed.get('--serious') === 'var(--sem-neg)');
/* The blue ramp follows sequentialOf, step for step. */
const seqName = (hex) => `var(--seq-${T.SEQUENTIAL.indexOf(hex)})`;
const bOff = ['b100', 'b200', 'b300', 'b400', 'b500', 'b600', 'b700']
  .filter((k, i) => repointed.get(`--${k}`) !== seqName(T.sequentialOf(i / 6)));
check('--b100..--b700 are the steps sequentialOf(i/6) picks', bOff.length === 0, bOff.join(' '));
check('the page says it is light, so no control draws dark on white paper', /color-scheme\s*:\s*light/.test(skinRoot));

/* ══ 3. the switch ════════════════════════════════════════════════════════ */
console.log('\n3 · the switch in index.html and the service worker');
const prePaint = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
check('the pre-paint script reads ?skin', /get\('skin'\)/.test(prePaint));
check('…remembers it under fleet.skin', /localStorage\.setItem\('fleet\.skin', sk\)/.test(prePaint)
  && /localStorage\.removeItem\('fleet\.skin'\)/.test(prePaint));
check('…and stamps data-skin on <html>', /dataset\.skin = 'arkiv'/.test(prePaint));
const appAt = html.indexOf('href="/app.css"');
const arkAt = html.indexOf('/arkiv.css');
check('arkiv.css is written AFTER the app.css link', appAt > 0 && arkAt > appAt);
check('…by document.write, so the parser inserts it and it blocks the first paint',
  /document\.write\('<link rel="stylesheet" href="\/arkiv\.css">'\)/.test(html));
check('…and only under the attribute', /if \(document\.documentElement\.dataset\.skin === 'arkiv'\)\s*\n\s*document\.write/.test(html));
check('no static <link> loads it for everybody', !/<link[^>]+arkiv\.css/.test(html.replace(/document\.write\([^)]*\)/g, '')));
const sw = read('sw.js');
check('sw.js precaches /arkiv.css', /'\/arkiv\.css'/.test(sw.slice(sw.indexOf('const SHELL_FILES'), sw.indexOf('self.addEventListener'))));

/* ══ 4. no DOM change ═════════════════════════════════════════════════════ */
console.log('\n4 · the markup does not know which skin it is in');
const modules = [];
const walk = (dir) => { for (const d of readdirSync(new URL(dir, PUB), { withFileTypes: true })) {
  if (d.isDirectory()) { if (!['vendor', 'fonts', 'icons'].includes(d.name)) walk(`${dir}${d.name}/`); }
  else if (d.name.endsWith('.js')) modules.push(`${dir}${d.name}`);
} };
walk('');
/* Code, not prose: tokens.js and ui.js both EXPLAIN the attribute in their
   comments, and a sentence about the skin is not a module branching on it. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const readers = modules.filter((f) => /dataset\.skin|data-skin|fleet\.skin/.test(code(read(f))));
check(`no module reads the skin (${modules.length} scanned)`, modules.length > 50 && readers.length === 0, readers.join(' '));
const SHELL_IDS = ['nav', 'sectabs', 'authBanner', 'filters', 'fRange', 'fRangeLabel', 'fGrain', 'fPlatform',
  'fFleet', 'refreshBtn', 'zenBtn', 'tzNote', 'themeBtn', 'settingsLink', 'freshness', 'todayNow', 'crumb',
  'viewTitle', 'viewSub', 'view', 'tt', 'm'];
const missingIds = SHELL_IDS.filter((id) => !html.includes(`id="${id}"`));
check('every shell id is still in index.html, #fRangeLabel included', missingIds.length === 0, missingIds.join(' '));

/* ══ the browser half ═════════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const fresh = (o = {}) => browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...o });
const hexOf = (rgb) => {
  const m = String(rgb).match(/\d+(\.\d+)?/g);
  return m ? `#${m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null;
};
const TOKEN_HEX = new Set([...T.allTokenHexes()].map((h) => h.toUpperCase()));
const INK = T.NEUTRAL.ink.toUpperCase(), NEG = T.SEMANTIC.negative.toUpperCase(), POS = T.SEMANTIC.positive.toUpperCase();

console.log('\n3 · the switch, in a browser');
{
  const ctx = await fresh();
  const asked = [];
  ctx.on('request', (r) => asked.push(new URL(r.url()).pathname));
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop#overview`, { waitUntil: 'domcontentloaded' });
  const plain = await page.evaluate(() => ({ skin: document.documentElement.dataset.skin || null,
    sheets: [...document.styleSheets].map((s) => new URL(s.href || location.href).pathname) }));
  await page.waitForTimeout(400);
  check('with no choice made, there is no skin attribute', plain.skin === null, plain.skin);
  check('…and arkiv.css is never requested', !asked.includes('/arkiv.css'), asked.filter((p) => /css/.test(p)).join(' '));

  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'domcontentloaded' });
  const on = await page.evaluate(() => ({ skin: document.documentElement.dataset.skin || null,
    stored: localStorage.getItem('fleet.skin'),
    links: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')) }));
  check('?skin=arkiv stamps the attribute by DOMContentLoaded', on.skin === 'arkiv', on.skin);
  check('…with the arkiv.css <link> the last stylesheet in the document', on.links[on.links.length - 1] === '/arkiv.css'
    && on.links.indexOf('/app.css') >= 0, on.links.join(' '));
  check('…and remembers the choice', on.stored === 'arkiv', on.stored);
  /* The sheets themselves after 'load', which waits for every stylesheet: at
     DOMContentLoaded a sheet still in flight is not yet in document.styleSheets,
     and a check read there passes or fails on the network's timing. */
  await page.waitForLoadState('load');
  const sheets = await page.evaluate(() => [...document.styleSheets].map((s) => new URL(s.href || location.href).pathname));
  check('…and arkiv.css is applied after app.css', sheets.indexOf('/arkiv.css') > sheets.indexOf('/app.css')
    && sheets.indexOf('/app.css') >= 0, sheets.join(' '));
  const blocking = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => /\/arkiv\.css$/.test(e.name)).map((e) => e.renderBlockingStatus));
  check('…as a render-blocking sheet, so the old skin never paints first',
    blocking.length > 0 && blocking.every((s) => s === 'blocking'), blocking.join(' '));

  await page.goto(`${base}/?ui=desktop#drivers`, { waitUntil: 'domcontentloaded' });
  check('a later visit with no parameter keeps the skin',
    await page.evaluate(() => document.documentElement.dataset.skin) === 'arkiv');
  await page.goto(`${base}/?ui=desktop&skin=classic#drivers`, { waitUntil: 'domcontentloaded' });
  const cl = await page.evaluate(() => ({ skin: document.documentElement.dataset.skin || null,
    stored: localStorage.getItem('fleet.skin'), n: document.querySelectorAll('link[href="/arkiv.css"]').length }));
  check('?skin=classic takes it off, and says so in storage', cl.skin === null && cl.stored === 'classic' && cl.n === 0,
    JSON.stringify(cl));
  await page.goto(`${base}/?ui=desktop&skin=auto#drivers`, { waitUntil: 'domcontentloaded' });
  check('?skin=auto forgets the choice', await page.evaluate(() => localStorage.getItem('fleet.skin')) === null);
  await ctx.close();
}

console.log('\n2 · the old names resolve to Arkiv values in every theme state');
for (const [label, scheme, theme] of [['OS light, theme system', 'light', null],
  ['OS dark, theme system', 'dark', null], ['OS light, theme dark', 'light', 'dark']]) {
  const ctx = await fresh({ colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop&skin=arkiv#settings`, { waitUntil: 'load' });
  const got = await page.evaluate(([names, theme]) => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    const probe = document.createElement('i');
    document.body.append(probe);
    const out = {};
    for (const n of names) {
      probe.style.color = ''; probe.style.color = `var(${n})`;
      out[n] = getComputedStyle(probe).color;
    }
    out['color-scheme'] = getComputedStyle(document.documentElement).colorScheme;
    probe.remove();
    return out;
  }, [[...coloured].filter((n) => !/^--(?:shadow|ch)-/.test(n)), theme]);
  const off = Object.entries(got).filter(([n, v]) => n !== 'color-scheme' && !TOKEN_HEX.has(hexOf(v)));
  check(`${label}: every coloured old name is an Arkiv token value (${Object.keys(got).length - 1} names)`,
    off.length === 0, off.slice(0, 6).map(([n, v]) => `${n}=${v}`).join(' '));
  check(`${label}: color-scheme is light`, got['color-scheme'] === 'light', got['color-scheme']);
  await ctx.close();
}

/* The shared components, rendered by the real ui.js in each skin. */
const RENDER = async () => {
  const ui = await import('/ui.js');
  document.querySelector('#skinhost')?.remove();
  const host = document.createElement('div');
  host.id = 'skinhost';
  host.style.cssText = 'width:1100px';
  document.body.append(host);
  const p = ui.panel('Trips per day', 'A caption, which is a sentence.', 'skin-panel');
  host.append(p.panel);
  p.body.append(ui.kpiRow([
    { label: 'Trips', value: '1,234', sub: 'a synthetic figure', key: 'k-plain' },
    { label: 'Completion', value: '96%', tone: 'good', key: 'k-good' },
    { label: 'Licences due', value: '12', tone: 'warn', key: 'k-warn' },
    { label: 'Expired', value: '3', tone: 'critical', key: 'k-crit' },
    { label: 'Refused', value: '2', tone: 'err', key: 'k-err' },
  ]));
  p.body.append(ui.note('A plain note.'));
  p.body.append(ui.note('A warning note.', 'warn'));
  p.body.append(ui.note('A failing note.', 'err'));
  const pills = document.createElement('p');
  pills.id = 'pills';
  pills.innerHTML = ui.pill('fine', 'ok') + ui.pill('due soon', 'warn') + ui.pill('stopped', 'bad')
    + ui.pill('not measured', 'dim') + '<span class="tag warn">stale</span><span class="tag err">expired</span>';
  p.body.append(pills);
  ui.verdict(host, { claim: 'A synthetic claim about the page.', figure: '42', unit: 'things', tone: 'warn',
    sub: 'Why it is so.', recommend: 'What to do.' });
  ui.verdict(host, { claim: 'A second claim.', figure: '7', tone: 'bad' });
  host.append(ui.tableFrom([{ a: 'Row one', n: 12 }, { a: 'Row two', n: 3 }],
    [{ label: 'Name', key: 'a' }, { label: 'Count', key: 'n', num: true }]));
  const t = host.querySelector('tbody td:last-child');
  if (t) t.classList.add('v-warn');
  host.append(ui.tabBar([{ id: 'one', label: 'One' }, { id: 'two', label: 'Two' }], 'one', (id) => `#x/${id}`));
  const btns = document.createElement('div');
  btns.innerHTML = '<button class="btn">Plain</button><button class="btn primary">Primary</button>';
  host.append(btns);
  const segs = ['uber', 'bolt', 'yango', 'hotel', 'cabman', 'fms'].map((k) => ({ label: k, value: 10, token: `--c-${k}` }));
  ui.dominantBar(host, segs.concat([1, 2, 3, 4, 5, 6].map((i) => ({ label: `n${i}`, value: 10, cls: `c${i}` }))));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return host.outerHTML;
};

console.log('\n4 · the same markup under both skins');
const markup = {};
for (const skin of ['classic', 'arkiv']) {
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop&skin=${skin}#settings`, { waitUntil: 'load' });
  markup[skin] = await page.evaluate(RENDER);
  await ctx.close();
}
check('panel, tiles, notes, pills, verdict, table, tabs, buttons and the dominance bar render identically',
  markup.classic.length > 2000 && markup.classic === markup.arkiv,
  `${markup.classic.length} vs ${markup.arkiv.length}`);

console.log('\n5 · the restyle, measured');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop&skin=arkiv#settings`, { waitUntil: 'load' });
  await page.evaluate(RENDER);
  const m = await page.evaluate(() => {
    const cs = (sel, pseudo) => { const e = document.querySelector(sel); return e ? getComputedStyle(e, pseudo) : null; };
    const dot = (sel) => { const s = cs(sel, '::before'); return s && { content: s.content, bg: s.backgroundColor,
      bw: s.borderTopWidth, bc: s.borderTopColor, bs: s.borderTopStyle, w: s.width }; };
    const q = (sel) => document.querySelector(sel);
    const panel = cs('#skinhost [data-panel="skin-panel"]');
    const h3 = cs('#skinhost [data-panel="skin-panel"] > h3');
    const h3b = cs('#skinhost [data-panel="skin-panel"] > h3', '::before');
    const cap = cs('#skinhost [data-panel="skin-panel"] > .cap');
    const kpi = (k) => q(`#skinhost [data-kpi="${k}"]`);
    const tileN = (k) => getComputedStyle(kpi(k).querySelector('.n'));
    const tileL = (k) => getComputedStyle(kpi(k).querySelector('.l'), '::before');
    const tileAfter = getComputedStyle(kpi('k-crit'), '::after');
    const lDot = (k) => { const s = tileL(k); return { content: s.content, bg: s.backgroundColor, bs: s.borderTopStyle,
      bc: s.borderTopColor, bw: s.borderTopWidth }; };
    const notes = [...document.querySelectorAll('#skinhost .note')];
    const pill = (i) => q(`#pills > :nth-child(${i})`);
    const pdot = (i, pseudo = '::before') => { const s = getComputedStyle(pill(i), pseudo); return { content: s.content,
      bg: s.backgroundColor, bs: s.borderTopStyle, bc: s.borderTopColor, order: s.order }; };
    const v = [...document.querySelectorAll('#skinhost .vdct')];
    const th = cs('#skinhost thead th');
    const on = cs('#skinhost .tabs a.on', '::after');
    const segs = [...document.querySelectorAll('#skinhost .domb-seg')].map((s) => {
      const c = getComputedStyle(s); return { cls: s.className, fg: c.color, bg: c.backgroundColor };
    });
    return {
      panel: { radius: panel.borderTopLeftRadius, shadow: panel.boxShadow, top: panel.borderTopWidth,
        topColor: panel.borderTopColor, left: panel.borderLeftWidth, bg: panel.backgroundColor },
      h3: { font: h3.fontFamily, tt: h3.textTransform, text: q('#skinhost [data-panel="skin-panel"] > h3').textContent,
        before: h3b.content },
      cap: { font: cap.fontFamily, tt: cap.textTransform, ls: cap.letterSpacing, color: cap.color },
      digits: ['k-good', 'k-warn', 'k-crit', 'k-err'].map((k) => tileN(k).color),
      valueFont: tileN('k-plain').fontFamily, valueArrow: getComputedStyle(kpi('k-good').querySelector('.n'), '::before').content,
      rail: tileAfter.display,
      dots: { plain: lDot('k-plain'), good: lDot('k-good'), warn: lDot('k-warn'), crit: lDot('k-crit'), err: lDot('k-err') },
      labelFont: getComputedStyle(kpi('k-plain').querySelector('.l')).fontFamily,
      notes: notes.map((n) => ({ color: getComputedStyle(n).color, bg: getComputedStyle(n).backgroundColor,
        left: getComputedStyle(n).borderLeftWidth, dot: getComputedStyle(n, '::before').content,
        dotBg: getComputedStyle(n, '::before').backgroundColor, dotBs: getComputedStyle(n, '::before').borderTopStyle })),
      pills: { ok: pdot(1), warn: pdot(2), badDot: pdot(3, '::after'), bang: pdot(3), dim: pdot(4),
        okText: getComputedStyle(pill(1)).color, radius: getComputedStyle(pill(1)).borderTopLeftRadius,
        dimShadow: getComputedStyle(pill(4)).boxShadow, tagWarn: pdot(5), tagErr: pdot(6) },
      verdict: v.map((e) => ({ top: getComputedStyle(e).borderTopWidth, topColor: getComputedStyle(e).borderTopColor,
        left: getComputedStyle(e).borderLeftWidth, fig: getComputedStyle(e.querySelector('.vdct-fig>b')).color,
        claimFont: getComputedStyle(e.querySelector('.vdct-claim')).fontFamily,
        dot: getComputedStyle(e.querySelector('.vdct-claim'), '::before').borderTopStyle,
        dotBg: getComputedStyle(e.querySelector('.vdct-claim'), '::before').backgroundColor })),
      table: { collapse: getComputedStyle(q('#skinhost table')).borderCollapse, thFont: th.fontFamily,
        thRule: th.borderBottomColor, thRuleW: th.borderBottomWidth,
        vwarn: getComputedStyle(q('#skinhost td.v-warn')).backgroundImage,
        numFont: getComputedStyle(q('#skinhost td.num')).fontFamily },
      tab: { bg: on.backgroundColor, h: on.height },
      btn: { radius: getComputedStyle(q('#skinhost .btn')).borderTopLeftRadius,
        primary: getComputedStyle(q('#skinhost .btn.primary')).backgroundColor,
        primaryText: getComputedStyle(q('#skinhost .btn.primary')).color },
      segs,
      body: { bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.body).color,
        font: getComputedStyle(document.body).fontFamily },
      brand: { b: getComputedStyle(q('.brand b')).fontFamily, h1: getComputedStyle(q('#viewTitle')).fontFamily },
    };
  });
  const is = (rgb, hex) => hexOf(rgb) === hex;
  check('the sheet is white paper and ink', is(m.body.bg, T.NEUTRAL.paper) && is(m.body.color, INK),
    `${m.body.bg} ${m.body.color}`);
  check('prose is Karla, the wordmark alone is Fraunces', /^"?Karla/.test(m.body.font) && /^"?Karla/.test(m.brand.h1)
    && /^"?Fraunces/.test(m.brand.b), `${m.body.font} · ${m.brand.h1} · ${m.brand.b}`);
  /* The rule is DECLARED 1.5px, as the design draws it; Chromium floors a
     border above 1px to whole CSS pixels at any device scale (measured here:
     1px at a scale of 1 and of 2), so what it computes is 1px. The mockups
     were rendered by the same engine, so that is also what they show. */
  check('a panel is a ruled section: no box, no radius, no shadow, an ink top rule (declared 1.5px)',
    m.panel.radius === '0px' && m.panel.shadow === 'none' && ['1px', '1.5px'].includes(m.panel.top)
    && /\.panel\{[^}]*border-top:1\.5px solid var\(--ink\)/.test(ark) && is(m.panel.topColor, INK)
    && m.panel.left === '0px', JSON.stringify(m.panel));
  check('…its title in mono capitals', /Plex Mono/.test(m.h3.font) && m.h3.tt === 'uppercase', JSON.stringify(m.h3));
  check('…numbered by a counter, so its textContent is still the title',
    /counter\(arkiv-sec/.test(m.h3.before) && m.h3.text === 'Trips per day', `${m.h3.before} · ${m.h3.text}`);
  check('the caption is still a sentence: Karla, no capitals, no tracking',
    /^"?Karla/.test(m.cap.font) && m.cap.tt === 'none' && m.cap.ls === 'normal', JSON.stringify(m.cap));
  check('tile values are Karla, labels Plex Mono', /^"?Karla/.test(m.valueFont) && /Plex Mono/.test(m.labelFont));
  check('a tone never colours the digits: every toned value is ink', m.digits.every((c) => is(c, INK)), m.digits.join(' '));
  check('…and the ▲ printed on a LEVEL is gone', m.valueArrow === 'none', m.valueArrow);
  check('…and so is the coloured side rail', m.rail === 'none', m.rail);
  check('an untoned tile carries no dot', m.dots.plain.content === 'none', m.dots.plain.content);
  const solid = (d, hex) => d.content !== 'none' && is(d.bg, hex) && (d.bs === 'none' || d.bw === '0px');
  const hollow = (d) => d.content !== 'none' && hexOf(d.bg) === '#000000' && /rgba\(0, 0, 0, 0\)|transparent/.test(d.bg)
    && d.bs === 'solid' && is(d.bc, NEG);
  check('good: a solid green dot', solid(m.dots.good, POS), JSON.stringify(m.dots.good));
  check('warning: a HOLLOW red dot (ruling 1)', hollow(m.dots.warn), JSON.stringify(m.dots.warn));
  check('critical: a SOLID red dot', solid(m.dots.crit, NEG), JSON.stringify(m.dots.crit));
  check('…and the hand-rolled err tone the same', solid(m.dots.err, NEG), JSON.stringify(m.dots.err));
  check('the dot carries a word for a screen reader', /warning/.test(m.dots.warn.content)
    && /critical/.test(m.dots.crit.content), `${m.dots.warn.content} · ${m.dots.crit.content}`);
  const [plainNote, warnNote, errNote] = m.notes;
  check('a note is a caption under a hairline: no tinted box, no accent bar',
    m.notes.every((n) => /rgba\(0, 0, 0, 0\)|transparent/.test(n.bg) && n.left === '0px'), JSON.stringify(m.notes));
  check('…a plain one grey, with no dot', is(plainNote.color, T.NEUTRAL.grey) && plainNote.dot === 'none');
  check('…warn and err keep INK text (the review’s correction)', is(warnNote.color, INK) && is(errNote.color, INK));
  check('…warn with the hollow dot, err with the solid one',
    warnNote.dotBs === 'solid' && /rgba\(0, 0, 0, 0\)/.test(warnNote.dotBg) && is(errNote.dotBg, NEG),
    `${warnNote.dotBs} ${warnNote.dotBg} · ${errNote.dotBg}`);
  check('pills are 3px chips with ink text', m.pills.radius === '3px' && is(m.pills.okText, INK),
    `${m.pills.radius} ${m.pills.okText}`);
  check('pill ok: solid green · warn: hollow red · bad: solid red',
    is(m.pills.ok.bg, POS) && m.pills.warn.bs === 'solid' && is(m.pills.warn.bc, NEG)
    && m.pills.badDot.content !== 'none' && is(m.pills.badDot.bg, NEG), JSON.stringify(m.pills));
  check('.pill.bad keeps its "!", after the dot', /"!"/.test(m.pills.bang.content) && +m.pills.badDot.order < 0,
    `${m.pills.bang.content} order ${m.pills.badDot.order}`);
  check('a fact not measured is the absence outline, not a pale fill', m.pills.dim.content === 'none'
    && /inset/.test(m.pills.dimShadow), m.pills.dimShadow);
  check('tags follow the same rule', m.pills.tagWarn.bs === 'solid' && is(m.pills.tagWarn.bc, NEG)
    && is(m.pills.tagErr.bg, NEG), JSON.stringify([m.pills.tagWarn, m.pills.tagErr]));
  check('the verdict band: a 3px negative rule on top, no left rule, ink digits, Karla claim',
    m.verdict.every((v) => v.top === '3px' && is(v.topColor, NEG) && v.left === '0px' && is(v.fig, INK)
      && /^"?Karla/.test(v.claimFont)), JSON.stringify(m.verdict));
  check('…a warning band hollow, a bad one solid',
    m.verdict[0].dot === 'solid' && /rgba\(0, 0, 0, 0\)/.test(m.verdict[0].dotBg) && is(m.verdict[1].dotBg, NEG),
    JSON.stringify(m.verdict.map((v) => [v.dot, v.dotBg])));
  check('tables: separate borders, a mono heading over a 1px ink rule, mono figures',
    m.table.collapse === 'separate' && /Plex Mono/.test(m.table.thFont) && is(m.table.thRule, INK)
    && m.table.thRuleW === '1px' && /Plex Mono/.test(m.table.numFont), JSON.stringify(m.table));
  check('…a verdict cell is a dot at its edge, drawn as a background layer', /radial-gradient/.test(m.table.vwarn));
  check('the current tab is a 1px ink underline', is(m.tab.bg, INK) && m.tab.h === '1px', JSON.stringify(m.tab));
  check('buttons are square; the primary is an ink fill with paper text', m.btn.radius === '0px'
    && is(m.btn.primary, INK) && is(m.btn.primaryText, T.NEUTRAL.paper), JSON.stringify(m.btn));
  const weak = m.segs.filter((s) => T.contrast(hexOf(s.fg), hexOf(s.bg)) < 4.5)
    .map((s) => `${s.cls} ${hexOf(s.fg)} on ${hexOf(s.bg)} ${T.contrast(hexOf(s.fg), hexOf(s.bg)).toFixed(2)}`);
  check(`the dominance bar's label clears 4.5:1 on every fill (${m.segs.length} segments)`,
    m.segs.length === 12 && weak.length === 0, weak.join(' | '));
  check('…and every fill is a token', m.segs.every((s) => TOKEN_HEX.has(hexOf(s.bg))),
    m.segs.map((s) => hexOf(s.bg)).join(' '));
  await ctx.close();
}

console.log('\n5 · the credential banner, from the real authBanner()');
{
  const row = (o) => ({ fleet_id: 'egari', surface: 'x', last_ok_at: null, checked_at: '2026-09-23T08:30:00Z',
    last_ok_age_h: 3, run_age_h: 9, stall_limit_h: 6, still_collecting: true, saved_at: null, superseded: false,
    ...o });
  const body = (rows) => JSON.stringify({ rows, observed: true,
    stopped: rows.filter((r) => r.severity === 'stopped').length,
    at_risk: rows.filter((r) => r.severity === 'at-risk').length, degraded: 0,
    pending: rows.filter((r) => r.severity === 'pending').length });
  const cases = [
    ['stopped', [row({ provider: 'uber', credential: 'SYNTH_COOKIE', state: 'invalid', severity: 'stopped',
      detail: 'refused — a synthetic reason' })]],
    ['at-risk', [row({ provider: 'bolt', credential: 'SYNTH_TOKEN', state: 'ok', severity: 'at-risk' })]],
    ['pending', [row({ provider: 'fms', credential: 'SYNTH_PASS', state: 'saved', severity: 'pending',
      saved_at: '2026-09-23T08:30:00Z', detail: 'saved, not tested' })]],
  ];
  const seen = {};
  for (const [tone, rows] of cases) {
    const ctx = await fresh();
    const page = await ctx.newPage();
    await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: body(rows) }));
    await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load' });
    await page.waitForSelector(`#authBanner.${tone}`, { timeout: 15000 }).catch(() => {});
    seen[tone] = await page.evaluate(() => {
      const e = document.querySelector('#authBanner');
      const d = e.querySelector('.ab-dot');
      const s = getComputedStyle(e), ds = d ? getComputedStyle(d) : null;
      return { cls: e.className, bg: s.backgroundColor, color: s.color, top: s.borderTopWidth, topColor: s.borderTopColor,
        radius: s.borderTopLeftRadius, dotBg: ds?.backgroundColor, dotBs: ds?.borderTopStyle, dotBc: ds?.borderTopColor,
        head: getComputedStyle(e.querySelector('.ab-head')).color };
    });
    await ctx.close();
  }
  const s = seen.stopped, r = seen['at-risk'], p = seen.pending;
  check('stopped: the negative wash, a 3px negative rule, a SOLID dot, ink words',
    /stopped/.test(s.cls) && is2(s.bg, T.WASH.negative) && s.top === '3px' && hexOf(s.topColor) === NEG
    && hexOf(s.dotBg) === NEG && hexOf(s.color) === INK && hexOf(s.head) === INK && s.radius === '0px', JSON.stringify(s));
  check('at-risk: paper, a 3px negative rule, a HOLLOW dot, ink words',
    /at-risk/.test(r.cls) && hexOf(r.bg) === T.NEUTRAL.paper.toUpperCase() && hexOf(r.topColor) === NEG
    && /rgba\(0, 0, 0, 0\)/.test(r.dotBg) && r.dotBs === 'solid' && hexOf(r.dotBc) === NEG && hexOf(r.color) === INK,
    JSON.stringify(r));
  check('pending: the sunken ground, a grey rule and a grey dot — never red',
    /pending/.test(p.cls) && hexOf(p.bg) === T.NEUTRAL.paper2.toUpperCase() && hexOf(p.topColor) !== NEG
    && hexOf(p.dotBg) === T.NEUTRAL.grey.toUpperCase(), JSON.stringify(p));
  check('…on a ground that is not the stopped one', p.bg !== s.bg);
}
function is2(rgb, hex) { return !!hex && hexOf(rgb) === String(hex).toUpperCase(); }

console.log('\n6 · no sideways scroll at 390px');
{
  const ctx = await fresh({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const over = {};
  for (const route of ['overview', 'drivers', 'settings']) {
    await page.goto(`${base}/?ui=desktop&skin=arkiv#${route}`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    over[route] = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  check('#overview, #drivers and #settings fit a 390px window under the skin',
    Object.values(over).every((v) => v <= 0), JSON.stringify(over));
  /* A table that turns into cards at this width, with a verdict cell on
     every row. app.css clears the even cards' backgrounds with a shorthand at
     (0,3,4); a dot drawn at lower weight vanished from every other card
     (#payouts, measured). */
  const dots = await page.evaluate(async () => {
    const ui = await import('/ui.js');
    const host = document.createElement('div');
    document.body.append(host);
    host.append(ui.tableFrom([1, 2, 3, 4].map((i) => ({ a: `Row ${i}`, n: i })),
      [{ label: 'Name', key: 'a' }, { label: 'Gap', key: 'n', num: true, cls: () => 'v-warn' }], { cards: true }));
    host.querySelectorAll('tbody td:last-child').forEach((td) => td.classList.add('v-warn'));
    const out = [...host.querySelectorAll('td.v-warn')].map((td) => ({
      img: getComputedStyle(td).backgroundImage, display: getComputedStyle(td).display }));
    host.remove();
    return out;
  });
  check('a verdict cell keeps its dot on EVERY phone card, even rows included',
    dots.length === 4 && dots.every((d) => /radial-gradient/.test(d.img) && d.display === 'flex'), JSON.stringify(dots));
  /* render-audit's own overflow check, on the page where it fired: #unit's
     car map bled 18px past a panel that no longer has side padding. */
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?ui=desktop&skin=arkiv#unit`, { waitUntil: 'load' });
  await page.waitForSelector('.panel.mapwrap .leaflet-container', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(600);
  const spill = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#view .panel, #view .kpi, #view .grid > *').forEach((n) => {
      if (n.scrollWidth > n.clientWidth + 2 && !n.closest('.tscroll'))
        out.push(`${n.className} +${n.scrollWidth - n.clientWidth}px`);
    });
    return { out, map: !!document.querySelector('.panel.mapwrap .leaflet-container') };
  });
  check('#unit: the car map drew, and nothing sticks out of its panel',
    spill.map && spill.out.length === 0, JSON.stringify(spill));
  await ctx.close();
}

console.log('\n5 · the sidebar\'s "needs attention" line');
{
  /* freshness() writes the count with an INLINE color:var(--warn), which under
     the skin is the negative red: red words with no glyph (L3). The skin
     outranks the inline colour and gives the line its hollow dot. */
  const ctx = await fresh();
  const page = await ctx.newPage();
  const at = new Date().toISOString();
  await page.route('**/api/status**', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify([
    { source: 'uber', status: 'error', finished_at: at, rows_written: 0 },
    { source: 'bolt', status: 'ok', finished_at: at, rows_written: 5 }]) }));
  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#freshness span[style]', { timeout: 15000 }).catch(() => {});
  const f = await page.evaluate(() => {
    const e = document.querySelector('#freshness span[style]');
    if (!e) return null;
    const b = getComputedStyle(e, '::before');
    return { text: e.textContent, color: getComputedStyle(e).color, bg: b.backgroundColor, bs: b.borderTopStyle,
      bc: b.borderTopColor, content: b.content };
  });
  check('the line is ink, with a hollow negative dot', !!f && hexOf(f.color) === INK && f.bs === 'solid'
    && hexOf(f.bc) === NEG && /rgba\(0, 0, 0, 0\)/.test(f.bg) && /need/.test(f.text), JSON.stringify(f));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
