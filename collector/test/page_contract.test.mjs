/* The page contract, and the stale-render guard — STEP 3 of the reskin.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §3 "Page contract" and "Also required", SPEC §1
   and §3A, and the operator's rulings (§1). What this file holds down:

   0. THE CONTRACT IS A TOKEN. Which DOM a page builds is asked of
      --pg-contract (app.css 0, arkiv.css 1) by ui.js contract(), the way the
      charts ask their form — never of the skin attribute.
   1. delta(): the colour and the word follow the MEANING (semanticOf, with
      `invert` for a measure where down is good), the glyph and the sign
      follow the ARITHMETIC; every one carries a screen-reader word; a level
      or a gap without its reference throws (ruling 4: always worded, never a
      bare arrow); a value that could not be measured prints its reason.
   2. kpiTile: a tile built by kpiRow renders byte for byte what it did
      before STEP 3 (a frozen copy of the old function is the oracle), and a
      glance tile is the SAME function (kpi_one_tile: one tile builder).
   3. spark(): moved from m/ui.js to charts.js; every series the phone draws
      comes out byte-identical (the old function, frozen, is the oracle); a
      null is a GAP, not a zero.
   4. THE STALE-RENDER GUARD. render() used to hand every page the one #view;
      a render the reader had left wrote into the page they moved to.
   5. glance / highlight / secHead / absenceBand / pageFoot in a browser, in
      both skins, and on the phone build (m/screens.js fallback() renders the
      desktop driver and vehicle tabs inside #m, where the shell footer is
      hidden).
   6. tableFrom `pairs`.
   7. #overview, the pilot: the contract under the skin, today's page under
      the old one.

   Synthetic data only: the browser half renders against mockapi.mjs. */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const ui = await import('../api/public/ui.js');
const appJs = read('app.js'), uiJs = read('ui.js'), css = read('app.css'), ark = read('arkiv.css');
const html = read('index.html');

/* ══ 0 · the contract is a token ══════════════════════════════════════════ */
console.log('\n0 · which page is built is a token each skin declares');
const oldRoot = strip(css).slice(strip(css).indexOf(':root{'), strip(css).indexOf('@media (prefers-color-scheme: dark)'));
check('the old skin declares --pg-contract:0 in its :root', /--pg-contract:0;/.test(oldRoot));
check('arkiv.css declares --pg-contract:1 under the skin', /:root\[data-skin="arkiv"\]\{--pg-contract:1\}/.test(ark));
check('contract() reads the token, and the module never reads the skin',
  /getPropertyValue\('--pg-contract'\)/.test(uiJs) && !/dataset\.skin|data-skin|fleet\.skin/.test(strip(uiJs)));
check('with no stylesheet (node, a detached document) the answer is the old skin', ui.contract() === false);

/* ══ 1 · the delta ════════════════════════════════════════════════════════ */
console.log('\n1 · delta(): meaning picks the colour, arithmetic the arrow');
const up = ui.delta(58.4, { unit: '%', of: 'against 9–31 Aug' });
check('a rise is ▲ + and green, with its word and its reference',
  /dlt-positive/.test(up) && />▲</.test(up) && />\+58\.4%</.test(up) && /class="sr">better</.test(up)
    && /against 9–31 Aug/.test(up), up);
const down = ui.delta(-3.25, { unit: 'points', d: 2 });
check('a fall is ▼ − (U+2212) and red, "worse"', /dlt-negative/.test(down) && />▼</.test(down)
  && />−3\.25</.test(down) && /class="sr">worse</.test(down) && /dlt-u">points</.test(down), down);
const fewer = ui.delta(-1.06, { unit: 'points', d: 2, invert: true });
check('a fall where down is good (cancellations) is a GREEN ▼ − "better" — SPEC L3',
  /dlt-positive/.test(fewer) && />▼</.test(fewer) && />−1\.06</.test(fewer) && /class="sr">better</.test(fewer), fewer);
const more = ui.delta(2, { invert: true });
check('…and a rise in it is a RED ▲ + "worse"', /dlt-negative/.test(more) && />▲</.test(more) && /class="sr">worse</.test(more), more);
const flat = ui.delta(0.04, { d: 1 });
check('a change that rounds to nothing at the printed precision is grey "no change", not a green +0.0',
  /dlt-neutral/.test(flat) && />–</.test(flat) && /no change/.test(flat) && !/\+0\.0/.test(flat), flat);
check('not measured prints the reason, and no arrow and no figure',
  ui.delta(null, { na: 'not compared: this window is not a calendar period' })
    === '<span class="dlt dlt-na">not compared: this window is not a calendar period</span>'
  && ui.delta(undefined) === '<span class="dlt dlt-na">not measured</span>'
  && ui.delta('') === '<span class="dlt dlt-na">not measured</span>');
let threw = null;
try { ui.delta(24, { kind: 'level' }); } catch (e) { threw = e; }
check('ruling 4: a level in the delta slot without "against …" is refused where it is written',
  threw instanceof TypeError && /ruling 4/.test(threw.message));
const lvl = ui.delta(24, { kind: 'gap', of: 'against the fleet median', d: 0 });
check('…and with it, it is worded: "+24 against the fleet median"', /\+24</.test(lvl) && /against the fleet median/.test(lvl), lvl);
check('every semantic delta carries glyph, sign and a screen-reader word',
  [up, down, fewer, more].every((d) => /dlt-g" aria-hidden="true">[▲▼]</.test(d) && /dlt-v">[+−]/.test(d) && /class="sr">/.test(d)));
check('the .sr word is visually hidden but not display:none (app.css, both skins)',
  /\.sr\{position:absolute;width:1px;height:1px;[^}]*clip-path:inset\(50%\)/.test(css) && !/\.sr\{[^}]*display:none/.test(css));

/* ══ 2 · one tile builder ═════════════════════════════════════════════════ */
console.log('\n2 · kpiTile: unchanged for every kpiRow, and the glance is the same function');
/* The function as it was before STEP 3, frozen, verbatim. */
const KPI_ONE_LINE = 12;
const TONES = { ok: 'good', err: 'critical', good: 'good', warn: 'warn', serious: 'serious', critical: 'critical' };
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function oldKpiTile(k) {
  if (!k) return '';
  const plain = String(k.html ? k.html.replace(/<[^>]*>/g, '') : (k.value ?? '—'));
  const long = plain.trim().length > KPI_ONE_LINE ? ' long' : '';
  const to = k.to || (k.cohort ? `#cohort/${k.cohort}` : null);
  const tag = to ? 'a' : 'div';
  const attr = to ? ` href="${to}"` : '';
  const tone = TONES[k.tone] ? ` t-${TONES[k.tone]}` : '';
  const kk = k.key ? ` data-kpi="${esc(k.key)}"` : '';
  return `
    <${tag} class="kpi${tone}${to ? ' clickable kpi-open' : ''}"${attr}${kk}>
      <div class="l">${esc(k.label)}</div>
      <div class="n num${long}">${k.html || esc(k.value ?? '—')}</div>
      ${k.sub ? `<div class="s">${esc(k.sub)}</div>` : ''}
      ${to && k.who !== false ? '<div class="kpi-who">Who exactly? →</div>' : ''}
    </${tag}>`;
}
const CASES = [
  { label: 'Trips', value: '74' }, { label: 'Money in', value: 'AED 37,286.00 · 150.9%' },
  { label: 'Gap', html: '<span class="pill bad">12</span>', tone: 'err', key: 'gap' },
  { label: 'Critical', value: '3', to: '#insights/severity/critical', who: false },
  { label: 'Distance', html: '1,234 km', sub: 'avg 12.1 km <over> "the" 102 trips', tone: 'warn' },
  { label: 'x', value: null }, { label: 'x', value: '1', tone: 'purple', hero: true, na: 'ignored', spark: [1, 2] },
];
check('a tile without `glance` is byte-identical to the pre-STEP-3 tile, for every shape',
  CASES.every((c) => ui.kpiTile(c) === oldKpiTile(c)),
  CASES.filter((c) => ui.kpiTile(c) !== oldKpiTile(c)).map((c) => c.label).join(', '));
check('glance() builds its tiles with kpiTiles — no second tile builder',
  /export function glance\(host, tiles\) \{[\s\S]{0,400}host\.innerHTML = kpiTiles\(items\);/.test(uiJs));
const na = ui.kpiTile({ label: 'Money in', value: '—', glance: true, na: 'no fare and no payout statement in this range' });
check('a glance tile that cannot be measured prints its REASON in the value slot, never a bare —',
  /class="n t-v t-na long">no fare and no payout statement in this range</.test(na) && !/>—</.test(na), na);
check('…with SPEC\'s names beside the ones every test finds (.kpi .l .n)',
  /class="kpi tile"/.test(na) && /class="l t-l"/.test(na));
const withDelta = ui.kpiTile({ label: 'Trips', value: '17,868', glance: true, hero: true, channel: 'Uber',
  delta: { value: 64.5, unit: '%', of: 'against 9–31 Aug' }, spark: 'no series: weekly statements' });
check('a hero tile: is-hero, a channel swatch beside the label, the delta and the reason for no sparkline in SPEC order',
  /class="kpi tile is-hero"/.test(withDelta) && /<i class="sw ch-uber" aria-hidden="true"><\/i>Trips/.test(withDelta)
    && withDelta.indexOf('t-v') < withDelta.indexOf('t-d') && withDelta.indexOf('t-d') < withDelta.indexOf('t-s-na'), withDelta);

/* ══ 3 · spark() moved, and a hole is a gap ═══════════════════════════════ */
console.log('\n3 · spark(): moved to charts.js, the phone\'s lines unchanged');
const mui = read('m/ui.js'), charts = read('charts.js');
check('charts.js exports it and m/ui.js re-exports it', /export const spark = \(/.test(charts)
  && /import \{ fmt, isToday, spark \} from '\.\.\/charts\.js'/.test(mui) && /export \{[^}]*spark[^}]*\}/.test(mui));

/* ══ the browser half ═════════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const errors = [];
async function open(skin, { width = 1440, hash = 'settings', ui: shell = 'desktop', hold = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block',
    reducedMotion: 'reduce', ...(shell === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${skin} ${hash}: ${String(e.message).slice(0, 160)}`));
  if (hold) await page.route(hold.url, async (route) => { await hold.gate; await route.continue(); });
  await page.goto(`${base}/?ui=${shell}&skin=${skin}#${hash}`, { waitUntil: 'load' });
  if (shell === 'desktop') await page.waitForSelector('#nav a');
  return { ctx, page };
}
const settle = async (page) => {
  for (let i = 0; i < 40; i++) { await page.waitForTimeout(250); if (!(await page.$('#view .skel'))) break; }
  await page.waitForTimeout(400);
};

/* ── 3b · spark in the page: the old function is the oracle ─────────────── */
{
  const { ctx, page } = await open('classic');
  const r = await page.evaluate(async () => {
    const { spark } = await import('/charts.js');
    /* The pre-STEP-3 m/ui.js spark, frozen, verbatim. */
    const old = (values, { h = 34, tone = 'var(--accent)', fill = true, zeroBased = true } = {}) => {
      const v = values.map(Number).filter((n) => Number.isFinite(n));
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 100 ${h}`); svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = `display:block;width:100%;height:${h}px;overflow:visible`;
      if (v.length < 2) return svg;
      const lo = zeroBased ? Math.min(0, ...v) : Math.min(...v);
      const hi = Math.max(...v), span = hi - lo || 1; const pad = 2.5;
      const pt = (n, i) => [(i / (v.length - 1)) * 100, h - pad - ((n - lo) / span) * (h - pad * 2)];
      const d = v.map((n, i) => `${i ? 'L' : 'M'}${pt(n, i).map((x) => x.toFixed(2)).join(' ')}`).join('');
      if (fill) { const a = document.createElementNS(ns, 'path'); a.setAttribute('d', `${d}L100 ${h}L0 ${h}Z`);
        a.setAttribute('fill', tone); a.setAttribute('opacity', '.12'); svg.append(a); }
      const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); p.setAttribute('fill', 'none');
      p.setAttribute('stroke', tone); p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(p);
      const [cx, cy] = pt(v[v.length - 1], v.length - 1);
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('cx', cx); dot.setAttribute('cy', cy); dot.setAttribute('r', '2');
      dot.setAttribute('fill', tone); dot.setAttribute('vector-effect', 'non-scaling-stroke'); svg.append(dot);
      return svg;
    };
    /* Every shape the phone's four callers pass: counts, amounts, a single
       day, a flat line, a negative, a custom tone and height. */
    const SERIES = [[[12, 11, 11, 12, 12, 9, 14, 9], {}], [[1200.5, 0, 3.25, 88], { h: 46, tone: 'var(--s3)' }],
      [[5], { h: 44 }], [[3, 3, 3], {}], [[-4, 2, 7], { fill: false }], [[0, 0], {}], [[9, 1, 5, 7], { h: 46 }]];
    const same = SERIES.every(([s, o]) => spark(s, o).outerHTML === old(s, o).outerHTML);
    const gap = spark([4, 5, null, 6, 7], { fill: false });
    const d = gap.querySelector('path').getAttribute('d');
    return { same, runs: (d.match(/M/g) || []).length,
      zeroNot: !/ 3[0-9]\.\d\dL/.test(d) || true, pts: d.split(/[ML]/).filter(Boolean).length,
      last: gap.querySelector('circle').getAttribute('cx') };
  });
  check('every series the phone draws is byte-identical to the old spark', r.same);
  check('a null breaks the line into two runs (SPEC §5 GAP) and is not drawn as 0', r.runs === 2 && r.pts === 4, JSON.stringify(r));
  check('…and every later point keeps its place: the end dot is at x = 100', Number(r.last) === 100, r.last);
  await ctx.close();
}

/* ── 4 · the stale-render guard ──────────────────────────────────────────── */
console.log('\n4 · a render the reader has left cannot write into the page they are on');
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const { ctx, page } = await open('classic', { hash: 'supply', hold: { url: '**/api/supply/balance**', gate } });
  await page.waitForSelector('#view .panel');
  const supplyTitle = await page.evaluate(() => document.querySelector('#viewTitle').textContent);
  const before = await page.evaluate(() => { window.__oldView = document.querySelector('#view'); return true; });
  await page.evaluate(() => { location.hash = '#settings'; });
  await page.waitForFunction((t) => (document.querySelector('#viewTitle')?.textContent || t) !== t, supplyTitle);
  await settle(page);
  release();
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    leaked: /the two of them against each other/.test(document.querySelector('#view').textContent),
    oldDetached: window.__oldView && !window.__oldView.isConnected,
    oldGotIt: window.__oldView && /the two of them against each other/.test(window.__oldView.textContent),
    one: document.querySelectorAll('#view').length,
  }));
  check('#supply, answered after the reader moved to #settings, writes nothing into #settings', before && !r.leaked, JSON.stringify(r));
  check('…because it wrote into its OWN #view, which is no longer on the page', r.oldDetached && r.oldGotIt, JSON.stringify(r));
  check('…and there is still exactly one #view', r.one === 1);
  check('render() replaces #view with a fresh copy and clears the footer, in that order',
    /function freshView\(\) \{\s*const old = \$\('#view'\);\s*const root = old\.cloneNode\(false\);\s*old\.replaceWith\(root\);/.test(appJs)
      && /const root = freshView\(\);\s*\/\*[\s\S]*?\*\/\s*clearPageFoot\(\);/.test(appJs));
  check('coverage.js no longer awaits /api/coverage without asking whether the reader is still there',
    /await q\('\/api\/coverage'\)\.catch\(\(\) => \(\{\}\)\);\s*\/\*[\s\S]*?\*\/\s*if \(!alive\(gen\)\) return;/.test(read('coverage.js')));
  await ctx.close();
}

/* ── 5 · the components, in a browser ────────────────────────────────────── */
console.log('\n5 · glance, highlight, secHead, absenceBand, pageFoot');
const BUILD = async () => {
  const u = await import('/ui.js');
  const tiles0 = (host) => [...host.children];
  const view = document.querySelector('#view');
  view.innerHTML = '';
  /* 900px: an auto-fitted row of 172px tracks would be FIVE columns here, so
     six can only come from the glance's own rule. */
  const g = document.createElement('div'); g.style.width = '900px'; view.append(g);
  u.glance(g, [
    { label: 'Trips', value: '17,868', delta: { value: 64.5, unit: '%', of: 'against 9–31 Aug' }, spark: [5, 6, null, 7, 8] },
    { label: 'Distance', value: '213,474 km', hero: true, delta: { value: null, na: 'not compared: a rolling window' } },
    { label: 'Money in', na: 'no fare and no payout statement in this range' },
    { label: 'Completion', value: '15,790 of 17,868' }, { label: 'Vehicles', value: '103' },
  ]);
  const p = u.panel('Bookings per day', 'cap'); view.append(p.panel);
  const cap = document.createElement('p'); cap.className = 'cap';
  cap.innerHTML = 'busiest <b class="top">994</b> and <b class="second">812</b>'; p.body.append(cap);
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg'); const t = document.createElementNS(svgNs, 'text');
  t.textContent = '994'; svg.append(t); p.body.append(svg);
  const tb = document.createElement('table'); tb.innerHTML = '<tbody><tr><td><b>12</b></td></tr></tbody>'; p.body.append(tb);
  const refused = {
    absent: u.highlight(tiles0(g)[2].querySelector('.n')),
    second: u.highlight(cap.querySelector('.second')),
    first: u.highlight(cap.querySelector('.top')),
    againSameBand: u.highlight(cap.querySelector('.second')),
    svg: u.highlight(t), tbody: u.highlight(tb.querySelector('b')),
  };
  const a = document.createElement('div'); view.append(a);
  u.absenceBand(a, [
    { label: 'Bookings not yet priced', fig: '2,413', hl: true, why: 'Uber prices a week at a time.' },
    { label: 'Money in, day by day', none: 'No series', hl: true, why: 'Statements are weekly.' },
    { label: 'Bookings carrying no distance', fig: '2,084', why: 'Filed with no distance.' },
  ]);
  const b2 = u.panel('A fourth band'); view.append(b2.panel);
  const extra = document.createElement('b'); extra.textContent = '7'; b2.body.append(extra);
  const fourth = u.highlight(extra);
  const hls = [...view.querySelectorAll('.hl')];
  const cs = (n, p) => getComputedStyle(n, p);
  const tiles = [...g.children];
  return {
    cols: cs(g).gridTemplateColumns.split(' ').length,
    heroSpan: cs(tiles[1]).gridColumnStart, heroIsSecond: tiles[1].classList.contains('is-hero') && !tiles[0].classList.contains('is-hero'),
    heroHl: !!tiles[1].querySelector('.n .hl'), naHl: !!tiles[2].querySelector('.hl'),
    naText: tiles[2].querySelector('.n').textContent, naColor: cs(tiles[2].querySelector('.n')).color,
    ink2: cs(document.documentElement).getPropertyValue('--ink-2').trim(),
    sparkRuns: (tiles[0].querySelector('.t-s path')?.getAttribute('d')?.match(/M/g) || []).length,
    deltaColor: cs(tiles[0].querySelector('.dlt')).color, semPos: cs(document.documentElement).getPropertyValue('--sem-pos').trim(),
    deltaNa: tiles[1].querySelector('.dlt-na')?.textContent,
    refused: Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.applied ? 'applied' : v.why])),
    fourth: fourth.applied ? 'applied' : fourth.why,
    hlCount: hls.length,
    hlInk: hls.every((h) => cs(h).color === cs(document.body).color || true),
    hlDigits: cs(hls[0]).color, ink: cs(document.documentElement).getPropertyValue('--ink').trim(),
    absCells: a.querySelectorAll('.absb-cell').length,
    absHl: [...a.querySelectorAll('.absb-fig')].map((f) => !!f.querySelector('.hl')),
    absNone: a.querySelector('.absb-none')?.textContent,
    absFigColor: cs(a.querySelector('.absb-fig')).color,
    secAuto: cs(a.querySelector('.sechd-auto'), '::before').content,
    secInc: cs(a.querySelector('.sechd-auto'), '::before').counterIncrement,
  };
};
const hex = (rgb) => '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
{
  const { ctx, page } = await open('arkiv');
  await settle(page);
  const r = await page.evaluate(BUILD);
  check('00: a six-column grid, so 4, 5 or 6 tiles share one rhythm', r.cols === 6, String(r.cols));
  check('…exactly one hero — the one marked — spanning two columns', r.heroIsSecond && r.heroSpan === 'span 2', r.heroSpan);
  check('…carrying the band\'s one highlight', r.heroHl);
  check('an absent tile prints the reason in the value slot, in ink-2, and is never highlighted',
    r.naText === 'no fare and no payout statement in this range' && !r.naHl && hex(r.naColor) === r.ink2.toUpperCase(),
    JSON.stringify({ t: r.naText, c: r.naColor, i: r.ink2 }));
  check('the tile\'s sparkline breaks at a null (two runs), never a zero', r.sparkRuns === 2, String(r.sparkRuns));
  check('a delta is painted in the positive token; an unmeasured one prints its reason',
    hex(r.deltaColor) === r.semPos.toUpperCase() && r.deltaNa === 'not compared: a rolling window', JSON.stringify([r.deltaColor, r.deltaNa]));
  check('highlight: the 2nd in a band is refused',
    r.refused.second === 'applied' && /already carries its 1/.test(r.refused.first) && /already carries/.test(r.refused.againSameBand),
    JSON.stringify(r.refused));
  check('highlight: never inside a plot area, never in a table body', /plot area/.test(r.refused.svg) && /table body/.test(r.refused.tbody),
    JSON.stringify(r.refused));
  check('highlight: never on an absent figure — refused for THAT reason, before any budget',
    /absent figure is explained, never emphasised/.test(r.refused.absent), JSON.stringify(r.refused));
  const heroNa = await page.evaluate(async () => {
    const u = await import('/ui.js');
    const view = document.querySelector('#view'); view.innerHTML = '';
    const g = document.createElement('div'); view.append(g);
    u.glance(g, [{ label: 'Money in', hero: true, na: 'no fare and no payout statement in this range' },
      { label: 'Trips', value: '12' }]);
    return g.querySelectorAll('.hl').length;
  });
  check('…so a hero that cannot be measured carries no highlight at all', heroNa === 0, String(heroNa));
  check('highlight: the 4th on a page is refused — "a page carrying four carries none"',
    /already carries 3/.test(r.fourth) && r.hlCount === 3, `${r.fourth} · ${r.hlCount}`);
  check('…and the digits under a highlight stay ink', hex(r.hlDigits) === r.ink.toUpperCase(), r.hlDigits);
  check('absenceBand: the cells, the word where there is no figure, and the one highlight on the sized cell only',
    r.absCells === 3 && r.absNone === 'No series' && JSON.stringify(r.absHl) === '[true,false,false]',
    JSON.stringify(r));
  check('…its figures in ink-2, never a semantic hue (L5.9)', hex(r.absFigColor) === r.ink2.toUpperCase(), r.absFigColor);
  check('secHead(null) takes the next number from the counter the panel titles use',
    /counter\(arkiv-sec, decimal-leading-zero\)/.test(r.secAuto) && /arkiv-sec 1/.test(r.secInc), `${r.secAuto} · ${r.secInc}`);
  /* Once more on an empty page: the sized figure takes the band's one
     highlight, and a cell marked `hl` with no figure never does. */
  const r2 = await page.evaluate(async () => {
    const u = await import('/ui.js');
    const view = document.querySelector('#view'); view.innerHTML = '';
    const a = document.createElement('div'); view.append(a);
    u.absenceBand(a, [{ label: 'x', fig: '2,413', hl: true, why: 'y' }, { label: 'z', none: 'None', hl: true, why: 'w' }]);
    return [...a.querySelectorAll('.absb-fig')].map((f) => !!f.querySelector('.hl'));
  });
  check('…and where the page has room, the sized figure takes it and the absent one never does',
    JSON.stringify(r2) === '[true,false]', JSON.stringify(r2));

  /* The footer: the principle, the basis and colophon, cleared per render. */
  const f = await page.evaluate(async () => {
    const u = await import('/ui.js');
    location.hash = '#overview';
    await new Promise((res) => setTimeout(res, 3500));
    const foot = document.querySelector('#pageFoot');
    const before = { display: getComputedStyle(foot).display, principle: foot.querySelector('.pf-principle').textContent,
      src: !!foot.querySelector('.pf-basis .srcline'), srcInView: !!document.querySelector('#view .srcline'),
      colophon: foot.querySelector('.pf-colophon').textContent };
    location.hash = '#settings';
    await new Promise((res) => setTimeout(res, 2500));
    return { before, after: { basis: foot.querySelector('.pf-basis').innerHTML,
      colophon: foot.querySelector('.pf-colophon').innerHTML,
      principle: foot.querySelector('.pf-principle').textContent }, P: u.PRINCIPLE };
  });
  check('the shell footer shows the principle line, verbatim, under the skin',
    f.before.display === 'flex' && f.before.principle === f.P
      && f.P === 'A figure that cannot be measured is shown absent, with the reason — never as zero.', JSON.stringify(f.before));
  check('…the provenance line is its basis (kept as .srcline), not the foot of #view',
    f.before.src && !f.before.srcInView, JSON.stringify(f.before));
  check('…the page\'s colophon is written there', /bookings counted/.test(f.before.colophon), f.before.colophon);
  check('…and the next page does not wear the last one\'s basis or colophon; the principle stays',
    f.after.basis === '' && f.after.colophon === '' && f.after.principle === f.P, JSON.stringify(f.after));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', { hash: 'overview' });
  await settle(page);
  await page.waitForTimeout(2500);
  const r = await page.evaluate(() => ({ display: getComputedStyle(document.querySelector('#pageFoot')).display,
    srcInView: !!document.querySelector('#view .srcline'), srcInFoot: !!document.querySelector('#pageFoot .srcline') }));
  check('the old skin: the footer takes no space, and the provenance line stays at the foot of #view',
    r.display === 'none' && r.srcInView && !r.srcInFoot, JSON.stringify(r));
  await ctx.close();
}
check('index.html: the footer is after #view, inside #app, with the principle line verbatim',
  /<section id="view"><\/section>\s*<!--[\s\S]*?-->\s*<footer id="pageFoot" class="pagefoot">\s*<div class="pf-text"><div class="pf-basis"><\/div><p class="pf-principle">A figure that cannot be measured is shown absent, with the reason — never as zero\.<\/p><\/div>/.test(html)
    && html.indexOf('id="pageFoot"') > html.indexOf('<div id="app">') && html.indexOf('id="pageFoot"') < html.indexOf('<div id="m">'));

/* ── 5b · the phone: pageFoot and the glance inside #m ───────────────────── */
console.log('\n5b · on the phone, where the shell footer is hidden');
{
  const { ctx, page } = await open('arkiv', { width: 390, hash: 'today', ui: 'phone' });
  await page.waitForTimeout(2500);
  const r = await page.evaluate(async () => {
    const u = await import('/ui.js');
    /* What m/screens.js fallback() does: a .m-fallback box inside #m, handed
       to the desktop driver/vehicle renderer as its host. */
    const m = document.querySelector('#m');
    const box = document.createElement('div'); box.className = 'm-fallback'; m.append(box);
    const g = document.createElement('div'); box.append(g);
    u.glance(g, [{ label: 'Trips', value: '312' }, { label: 'Km', value: '3,948' }, { label: 'Days', value: '22' }]);
    const src = document.createElement('p'); src.className = 'cap srcline'; src.textContent = 'Built from Uber 312.';
    u.pageFoot({ basis: src, colophon: ['Last 30 days · Dubai time'] }, box);
    u.pageFoot({ colophon: ['This month · Dubai time'] }, box);
    const inline = box.querySelector(':scope > .pagefoot.pf-inline');
    const rect = inline?.getBoundingClientRect();
    return {
      app: getComputedStyle(document.querySelector('#app')).display,
      shell: document.querySelector('#pageFoot').getBoundingClientRect().height,
      inline: !!inline, n: box.querySelectorAll('.pf-inline').length,
      shown: inline && getComputedStyle(inline).display !== 'none' && rect.height > 20,
      principle: inline?.querySelector('.pf-principle')?.textContent, P: u.PRINCIPLE,
      src: !!inline?.querySelector('.pf-basis .srcline'), col: inline?.querySelector('.pf-colophon')?.textContent,
      heroCol: getComputedStyle(g.querySelector('.is-hero')).gridColumnStart, gcols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
      over: document.documentElement.scrollWidth - innerWidth,
    };
  });
  check('the desktop shell (and its footer) is hidden on the phone', r.app === 'none' && r.shell === 0, JSON.stringify(r));
  check('pageFoot given a host inside #m writes its own footer there, visible, principle included',
    r.inline && r.n === 1 && r.shown && r.principle === r.P && r.src, JSON.stringify(r));
  check('…a second call fills the same footer rather than adding one', r.n === 1 && r.col === 'This month · Dubai time', r.col);
  check('the glance collapses to one column at 390 and nothing scrolls sideways', r.gcols === 1 && r.heroCol === 'auto' && r.over <= 0,
    JSON.stringify(r));
  await ctx.close();
}

/* ── 6 · tableFrom pairs ─────────────────────────────────────────────────── */
console.log('\n6 · tableFrom: paired headers');
{
  const { ctx, page } = await open('arkiv');
  await settle(page);
  const r = await page.evaluate(async () => {
    const u = await import('/ui.js');
    const view = document.querySelector('#view'); view.innerHTML = '';
    const rows = [{ n: 'A', t: 10, te: 300, c: 9, cp: 90 }, { n: 'B', t: 30, te: 100, c: 25, cp: 83.3 },
      { n: 'C', t: 20, te: 200, c: null, cp: null }];
    const cols = [{ label: 'Driver', key: 'n' }, { label: 'Trips', key: 't', num: true },
      { label: 'Trips ever', key: 'te', num: true }, { label: 'Completed', key: 'c', num: true },
      { label: 'Completion', key: 'cp', num: true }];
    const box = u.tableFrom(rows, cols, { sortable: true, sortId: 'pr', cards: true,
      pairs: [['t', 'te'], ['c', 'cp']] });
    view.append(box);
    const ths = [...box.querySelectorAll('thead th')];
    const pair = ths[1];
    const names = () => [...box.querySelectorAll('tbody tr')].map((tr) => tr.children[0].textContent.trim());
    pair.querySelectorAll('button')[1]?.click();         // sort by Trips ever, largest first
    const bySecond = names(); const hash = location.hash;
    box.querySelector('thead th:nth-child(2) button').click();   // by Trips
    const byFirst = names();
    const plain = u.tableFrom([{ a: 1, b: 2 }], [{ label: 'A', key: 'a' }, { label: 'B', key: 'b' }]);
    return {
      ths: ths.length, keys: [pair.dataset.key, pair.dataset.key2], buttons: pair.querySelectorAll('button').length,
      labels: [...pair.querySelectorAll('button')].map((b) => b.textContent),
      cell: [...box.querySelector('tbody tr').children[1].querySelectorAll('span.tdp-a, span.tdp-b')].map((s) => s.textContent),
      cardLabel: box.querySelector('tbody td.tdpair')?.dataset.label,
      bySecond, byFirst, hash, plainPairs: plain.querySelectorAll('.thpair, .tdpair').length,
      plainThs: plain.querySelectorAll('th').length,
    };
  });
  check('two pairs make three headings, each pair carrying both keys', r.ths === 3 && r.keys.join() === 't,te', JSON.stringify(r));
  check('…and BOTH labels as their own sort buttons', r.buttons === 2 && r.labels.join('|') === 'Trips|Trips ever', r.labels.join('|'));
  check('a cell holds both values, first over second', r.cell.length === 2, JSON.stringify(r.cell));
  check('sorting by the SECOND key orders by it, and the sort is in the address',
    r.bySecond.join('') === 'ACB' && /sort=pr\.te\.desc/.test(r.hash), `${r.bySecond.join('')} ${r.hash}`);
  check('…and by the first key, by it', r.byFirst.join('') === 'BCA', r.byFirst.join(''));
  check('a phone card labels a paired cell "A · B"', r.cardLabel === 'Trips · Trips ever', r.cardLabel);
  check('without `pairs` nothing is paired', r.plainPairs === 0 && r.plainThs === 2);
  await ctx.close();
}

/* ── 7 · #overview, the pilot ────────────────────────────────────────────── */
console.log('\n7 · #overview: the contract under the skin, today\'s page under the old one');
const OVR = () => {
  const view = document.querySelector('#view');
  return {
    heads: [...view.querySelectorAll('.panel>h3, .sechd-name')].map((h) => h.textContent),
    first: view.firstElementChild?.className,
    glance: view.querySelectorAll('.kpis.glance > .kpi').length,
    hero: view.querySelector('.kpis.glance .is-hero .l')?.textContent,
    vdctIn00: !!view.querySelector('.cband > div > .vdct'),
    kpis: view.querySelectorAll('.kpis > .kpi').length,
    labels: [...view.querySelectorAll('.kpis > .kpi .l')].map((l) => l.textContent),
    deltas: [...view.querySelectorAll('.kpis.glance .t-d .dlt')].map((d) => d.className.replace('dlt ', '')),
    sparks: view.querySelectorAll('.kpis.glance .t-s svg').length,
    noSpark: view.querySelector('.kpis.glance .t-s-na')?.textContent || '',
    hl: document.querySelectorAll('#view .hl, #pageFoot .hl').length,
    abs: view.querySelectorAll('.absband .absb-cell').length,
    donutRing: view.querySelectorAll('svg.donut').length,
    step: !!view.querySelector('.gb-step'), stepLabel: view.querySelector('.gb-step-lab')?.textContent,
    tiersDrawn: view.querySelector('[data-panel="ov-tiers"] .hbars')?.children.length ?? null,
    swatches: view.querySelectorAll('[data-panel="ov-drivers"] tbody .sw').length,
    perTier: /per km/i.test(view.textContent) && /AED per km per tier|What a kilometre is worth/i.test(view.textContent),
    zero: [...view.querySelectorAll('.kpi .n')].map((n) => n.textContent.trim()).filter((t) => t === '—' || t === '0'),
  };
};
{
  const { ctx, page } = await open('arkiv', { hash: 'overview?period=month' });
  await settle(page); await page.waitForTimeout(1500);
  const r = await page.evaluate(OVR);
  check('the section order is the plan\'s: 00, the hero chart, cancellations, channel, outcome, tiers, settle, drivers, †',
    JSON.stringify(r.heads) === JSON.stringify(['At a glance', 'Bookings per day', 'Cancellations a day',
      'Which channel the work came through', 'How every booking ended', 'What the fleet drove', 'How fares settle',
      'Top drivers', '† What this page does not know']), JSON.stringify(r.heads));
  check('00 leads the page, and the verdict is its statement (ruling 7)', r.first === 'cband' && r.vdctIn00, r.first);
  check('all seven tiles, Trips the hero — Money in, Vehicles and Safety alerts kept (rule 1)',
    r.glance === 7 && r.hero === 'Trips' && ['Money in', 'Vehicles', 'Safety alerts'].every((l) => r.labels.includes(l)),
    JSON.stringify(r.labels));
  check('five deltas on a calendar period, each a real delta', r.deltas.length === 5
    && r.deltas.every((c) => /dlt-(positive|negative|neutral)/.test(c)), JSON.stringify(r.deltas));
  check('four sparklines, and Money in says why it has none', r.sparks === 4 && /weekly/.test(r.noSpark), `${r.sparks} ${r.noSpark}`);
  check('no tile prints a bare — or a 0', r.zero.length === 0, JSON.stringify(r.zero));
  check('three highlights: the hero, the busiest day, the absence band\'s sized figure', r.hl === 3, String(r.hl));
  check('the † band has its four cells', r.abs === 4, String(r.abs));
  check('no donut ring is left on the page (ruling 6: both replaced by bars here)', r.donutRing === 0, String(r.donutRing));
  check('telematics journeys are a step line with its direct label', r.step && r.stepLabel === 'FMS journeys', r.stepLabel);
  check('the Top drivers table names each channel with its swatch', r.swatches > 0, String(r.swatches));
  check('ruling 5: no per-tier AED per km', !r.perTier);
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', { hash: 'overview?days=30' });
  await settle(page); await page.waitForTimeout(1500);
  const r = await page.evaluate(() => [...document.querySelectorAll('#view .kpis.glance .dlt')]
    .map((d) => `${d.className}|${d.textContent}`));
  check('on a rolling window every delta is ABSENT with the page\'s reason, never an arrow',
    r.length === 5 && r.every((x) => /dlt-na\|not compared: this page sets a calendar period/.test(x)), JSON.stringify(r));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', { hash: 'overview?period=month&platform=uber' });
  const asked = [];
  page.on('request', (q) => { if (/\/api\/compare\/period/.test(q.url())) asked.push(q.url()); });
  await page.evaluate(() => { location.hash = '#overview?period=month&platform=uber&_=1'; });
  await settle(page); await page.waitForTimeout(1500);
  const r = await page.evaluate(() => ({
    d: [...document.querySelectorAll('#view .kpis.glance .dlt')].map((d) => d.textContent),
    step: !!document.querySelector('#view .gb-step'),
    tripsSub: document.querySelector('#view .kpis.glance .is-hero .s')?.textContent || '',
  }));
  check('with a channel chosen the deltas say the comparison spans channels (compare/period answers 400)',
    r.d.length === 5 && r.d.every((x) => /driver-day spans every channel/.test(x)), JSON.stringify(r.d));
  check('…and the page does not ask for a comparison it knows will be refused', asked.length === 0, asked.join(' '));
  check('…the trackers\' journeys are not drawn and the hero says why rather than "0 telematics journeys"',
    !r.step && /not a channel's/.test(r.tripsSub) && !/\b0 telematics/.test(r.tripsSub), r.tripsSub);
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', { hash: 'overview?period=month' });
  await settle(page); await page.waitForTimeout(1500);
  const r = await page.evaluate(OVR);
  check('the old skin keeps today\'s page: its six panels in their order',
    JSON.stringify(r.heads) === JSON.stringify(['Trips per day', 'Platform share', 'Product mix', 'How fares settle',
      'Trip outcome', 'Top drivers']), JSON.stringify(r.heads));
  check('…the verdict first, then a kpiRow of seven — no glance, no † band, no highlight',
    r.first === '' && r.glance === 0 && r.kpis === 7 && r.abs === 0 && r.hl === 0, JSON.stringify(r));
  check('…and its donuts are still rings', r.donutRing === 2, String(r.donutRing));
  await ctx.close();
}
check('no page error in any of it', errors.length === 0, errors.join(' | '));

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
