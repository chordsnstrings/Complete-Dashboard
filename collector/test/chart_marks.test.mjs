/* The chart marks, under both skins — STEP 2 of the reskin.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §3 "Charts" and SPEC §4-§5, and the operator's
   ground rule for every reskin step: production keeps today's look until the
   flip, so the old skin must draw exactly what it drew, and Arkiv must draw
   the spec. One charts.js serves both.

   HOW ONE FILE DRAWS TWO SKINS, and what this file holds down:

   0. THE FORM IS A TOKEN. app.css declares the old skin's --mk-* (today's
      forms, value for value); the Arkiv block declares SPEC's, generated from
      tokens.js MARK; charts.js markForm() reads whichever is in force, and
      reads a token, never the skin. With no stylesheet it falls back to the
      old skin's forms, which is what production draws.
   1. barChart — SPEC §4: at most 24px thick, the DATA end rounded 4px and the
      baseline square (a path; a rect's rx rounds all four corners), a 2px gap
      between touching bars. A projection is a HATCH in its own colour (§5),
      and #forecast's caption, which said "Hatched bars are forecast" over
      solid bars, now names what is drawn in either skin. The old skin: the
      <rect> with rx ≤ 3 it always drew, solid forecast bars.

   Synthetic data only. The browser half renders against mockapi.mjs. */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const T = await import('../api/public/tokens.js');
const app = read('app.css');
const charts = read('charts.js');

/* ══ 0 · the form is a token ══════════════════════════════════════════════ */
console.log('\n0 · the chart form is a token, in both skins');
const oldRoot = (() => {
  const s = strip(app);
  return s.slice(s.indexOf(':root{'), s.indexOf('@media (prefers-color-scheme: dark)'));
})();
const valueIn = (css, name) => (css.match(new RegExp(`(?:^|[;{\\s])${name}:([^;]+);`)) || [])[1]?.trim();
const OLD = { '--mk-fit': '0', '--mk-max': '96', '--mk-end': '3', '--mk-base': '3', '--mk-gap': '0',
  '--mk-steps': '7', '--mk-absent': 'hatch', '--mk-unfinished': 'hollow', '--mk-projected': 'solid' };
for (const [k, v] of Object.entries(OLD))
  check(`the old skin declares ${k}:${v} — today's form`, valueIn(oldRoot, k) === v, String(valueIn(oldRoot, k)));
const genLight = (() => {
  const b = app.indexOf('/* ═══ BEGIN GENERATED TOKENS ═══ */');
  const s = strip(app.slice(b));
  return s.slice(s.indexOf(':root[data-skin="arkiv"]{'), s.indexOf('}', s.indexOf(':root[data-skin="arkiv"]{')));
})();
const SPEC = { '--mk-fit': '1', '--mk-max': '24', '--mk-end': '4', '--mk-base': '0', '--mk-gap': '2',
  '--mk-steps': '6', '--mk-absent': 'outline', '--mk-unfinished': 'hatch', '--mk-projected': 'hatch',
  '--mk-hatch-pitch': '4', '--mk-hatch-angle': '45' };
for (const [k, v] of Object.entries(SPEC))
  check(`the Arkiv block declares ${k}:${v} — SPEC §4-§5`, valueIn(genLight, k) === v, String(valueIn(genLight, k)));
check('the generated values come from tokens.js MARK',
  T.markDeclarations().every((d) => genLight.includes(d + ';')), T.markDeclarations().join(' '));
check('six graphite steps, the length of SEQUENTIAL', T.MARK.steps === String(T.SEQUENTIAL.length));
check('charts.js reads the form from the tokens, never from the skin',
  /getPropertyValue\(k\)/.test(charts) && !/dataset\.skin|data-skin|fleet\.skin/.test(strip(charts)));
check('…and falls back to the old skin’s form when no stylesheet answers',
  /CLASSIC_FORM = Object\.freeze\(\{ fit: false, max: 96, end: 3, base: 3, gap: 0, steps: 7,\s*absent: 'hatch', unfinished: 'hollow', projected: 'solid'/.test(charts));
check('sequentialOf and sequentialIndex are one pick',
  [0, 0.1, 0.33, 0.5, 0.51, 0.9, 1].every((t) => T.sequentialOf(t) === T.SEQUENTIAL[T.sequentialIndex(t)]));
check('…and absence is not step 0 in either', T.sequentialIndex(null) === null && T.sequentialOf(null) === null);
check('a label a reader sees finds its channel: FMS telematics, Uber fleet',
  T.channelKey('FMS telematics') === 'fms' && T.channelKey('Uber fleet') === 'uber' && T.channelKey('uber_fleet') === 'uber');

/* ══ the browser half ═════════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const errors = [];
/* One page per skin, on a quiet route, with charts.js imported into it. The
   skin is the real switch: ?skin=arkiv stamps the attribute and loads
   arkiv.css before first paint; ?skin=classic stores the old skin. */
async function open(skin, { scheme = 'light', width = 1440 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme,
    serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${skin}: ${String(e.message).slice(0, 160)}`));
  await page.goto(`${base}/?ui=desktop&skin=${skin}#settings`, { waitUntil: 'load' });
  await page.waitForSelector('#nav a');
  return { ctx, page };
}
/* Render with the real charts.js into a host of a known width. */
const RENDER = async ([fn, width, data, opts]) => {
  const c = await import('/charts.js');
  document.querySelector('#chost')?.remove();
  const host = document.createElement('div');
  host.id = 'chost'; host.className = 'panel';
  host.style.cssText = `width:${width}px;position:absolute;left:0;top:0;background:var(--surface)`;
  document.body.append(host);
  const o = { ...opts };
  if (o.projectedKey) { const k = o.projectedKey; o.projected = (d) => !!d[k]; delete o.projectedKey; }
  c[fn](host, data, o);
  const svg = host.querySelector('svg');
  const marks = [...host.querySelectorAll('svg > rect[data-rise], svg > path[data-rise]')].map((m) => {
    const b = m.getBBox(), cs = getComputedStyle(m);
    return { tag: m.tagName, x: b.x, w: b.width, h: b.height, rx: m.getAttribute('rx'),
      d: m.getAttribute('d') || '', fill: m.getAttribute('fill'), stroke: m.getAttribute('stroke'),
      paintFill: cs.fill };
  });
  const pats = [...host.querySelectorAll('pattern')].map((p) => ({ id: p.id, w: p.getAttribute('width'),
    rot: p.getAttribute('patternTransform'),
    line: (() => { const l = p.querySelector('line'); return l && { stroke: l.getAttribute('stroke'),
      op: l.getAttribute('stroke-opacity'), sw: l.getAttribute('stroke-width'),
      opNow: getComputedStyle(l).strokeOpacity }; })() }));
  return { form: c.markForm(), words: { projected: c.drawnAs('projected') },
    vb: svg?.getAttribute('viewBox'), marks, pats };
};

const nine = Array.from({ length: 9 }, (_, i) => ({ d: `2026-08-${String(i + 1).padStart(2, '0')}`, n: 40 + i * 7 }));
const dense = Array.from({ length: 90 }, (_, i) => ({ d: `2026-06-${i}`, n: 10 + (i % 13) }));
const fc = [...nine.slice(0, 6), ...[{ d: 'Oct', n: 90, proj: 1, lo: 70, hi: 110 }, { d: 'Nov', n: 95, proj: 1, lo: 72, hi: 118 }]];

const S = {};
for (const skin of ['classic', 'arkiv']) {
  const { ctx, page } = await open(skin);
  S[skin] = {
    nine: await page.evaluate(RENDER, ['barChart', 1090, nine, { x: 'd', y: 'n' }]),
    dense: await page.evaluate(RENDER, ['barChart', 515, dense, { x: 'd', y: 'n' }]),
    fc: await page.evaluate(RENDER, ['barChart', 900, fc, { x: 'd', y: 'n', lo: 'lo', hi: 'hi', projectedKey: 'proj' }]),
  };
  await ctx.close();
}

console.log('\n1 · barChart');
const C = S.classic, A = S.arkiv;
check('the old skin reads the old form', C.nine.form.fit === false && C.nine.form.max === 96
  && C.nine.form.absent === 'hatch' && C.nine.form.projected === 'solid', JSON.stringify(C.nine.form));
check('Arkiv reads SPEC’s', A.nine.form.fit === true && A.nine.form.max === 24 && A.nine.form.end === 4
  && A.nine.form.base === 0 && A.nine.form.gap === 2 && A.nine.form.absent === 'outline'
  && A.nine.form.unfinished === 'hatch' && A.nine.form.projected === 'hatch', JSON.stringify(A.nine.form));
check('old skin: every bar is the <rect> it always was, rx ≤ 3',
  C.nine.marks.length === 9 && C.nine.marks.every((m) => m.tag === 'rect' && +m.rx <= 3 && +m.rx > 0),
  JSON.stringify(C.nine.marks.map((m) => [m.tag, m.rx])));
check('old skin: a nine-bar chart 1,090px wide keeps its wide bars (the 96px ceiling)',
  C.nine.marks.every((m) => m.w > 60), JSON.stringify(C.nine.marks.map((m) => Math.round(m.w))));
check('Arkiv: every bar is a path with its data end rounded', A.nine.marks.length === 9
  && A.nine.marks.every((m) => m.tag === 'path' && /Q/.test(m.d)), JSON.stringify(A.nine.marks.map((m) => m.tag)));
/* Square at the baseline: the path leaves the baseline straight up, and the
   only curves are the two at the top. */
check('Arkiv: …and square at the baseline (exactly two curves, both at the top)', A.nine.marks.every((m) => {
  const q = [...m.d.matchAll(/Q([\d.]+) ([\d.]+)/g)].map((x) => +x[2]);
  const top = Math.min(...[...m.d.matchAll(/[MVQH ]([\d.]+) ([\d.]+)/g)].map((x) => +x[2]));
  return q.length === 2 && q.every((y) => Math.abs(y - top) < 0.01);
}), A.nine.marks[0]?.d);
check('Arkiv: no bar is thicker than 24px', A.nine.marks.every((m) => m.w <= 24.001),
  JSON.stringify(A.nine.marks.map((m) => +m.w.toFixed(1))));
const gaps = (ms) => ms.slice(1).map((m, i) => m.x - (ms[i].x + ms[i].w));
check('Arkiv: ninety bars in 515px keep a 2px surface gap between touching marks',
  gaps(A.dense.marks).every((g) => g >= 1.999 || A.dense.marks.every((m) => m.w <= 1.5)),
  JSON.stringify(gaps(A.dense.marks).slice(0, 5).map((g) => +g.toFixed(2))));
check('old skin: the same ninety bars keep the old spacing', C.dense.marks.length === 90
  && gaps(C.dense.marks).some((g) => g < 2), JSON.stringify(gaps(C.dense.marks).slice(0, 3).map((g) => +g.toFixed(2))));
check('Arkiv: a data end on the axis still reads as the value (the path spans the bar’s height)',
  A.nine.marks.every((m, i) => i === 0 || m.h >= A.nine.marks[i - 1].h - 0.01));

const cProj = C.fc.marks.slice(6), aProj = A.fc.marks.slice(6);
check('old skin: a forecast bar stays solid, as production draws it',
  cProj.length === 2 && cProj.every((m) => /^var\(--/.test(m.fill)) && C.fc.pats.length === 0,
  JSON.stringify(cProj.map((m) => m.fill)));
check('Arkiv: a forecast bar is HATCHED, in its own colour, with a 1px edge in that colour',
  aProj.length === 2 && aProj.every((m) => /^url\(#/.test(m.fill) && m.stroke === 'var(--b400)'),
  JSON.stringify(aProj.map((m) => [m.fill, m.stroke])));
check('Arkiv: …and an observed bar beside it is not', A.fc.marks.slice(0, 6).every((m) => m.fill === 'var(--b400)'));
const pat = A.fc.pats[0];
check('the hatch is SPEC §5: 4px pitch, 45°, a 1px line in the series colour at --hatch-a',
  A.fc.pats.length === 1 && pat.w === '4' && pat.rot === 'rotate(45)' && pat.line.stroke === 'var(--b400)'
  && pat.line.op === 'var(--hatch-a)' && pat.line.sw === '1' && Math.abs(+pat.line.opNow - 0.45) < 0.001,
  JSON.stringify(A.fc.pats));
check('the words follow the form: solid in the old skin, hatched in Arkiv',
  C.fc.words.projected === 'solid' && A.fc.words.projected === 'hatched',
  JSON.stringify([C.fc.words, A.fc.words]));
{
  const { ctx, page } = await open('arkiv', { scheme: 'dark' });
  const dk = await page.evaluate(RENDER, ['barChart', 900, fc, { x: 'd', y: 'n', projectedKey: 'proj' }]);
  check('dark: the hatch line takes the dark opacity (0.53)', Math.abs(+dk.pats[0]?.line.opNow - 0.53) < 0.001,
    JSON.stringify(dk.pats[0]));
  await ctx.close();
}

/* #forecast itself: the caption names the treatment the chart draws. */
console.log('\n1b · #forecast says what it draws');
for (const skin of ['classic', 'arkiv']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${skin} #forecast: ${String(e.message).slice(0, 160)}`));
  await page.goto(`${base}/?ui=desktop&skin=${skin}#forecast`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view [data-panel="fc-months"] table', { timeout: 30000 });
  const got = await page.evaluate(() => {
    const p = [...document.querySelectorAll('#view .panel')]
      .find((x) => /observed and forecast/.test(x.querySelector('h3')?.textContent || ''));
    if (!p) return null;
    const bars = [...p.querySelectorAll('svg > rect[data-rise], svg > path[data-rise]')];
    return { cap: p.querySelector('.cap')?.textContent || '',
      hatched: bars.filter((b) => /^url\(#/.test(b.getAttribute('fill') || '')).length, bars: bars.length,
      swProj: p.querySelectorAll('.legend .sw-proj').length };
  });
  if (!got) { check(`${skin}: the observed-and-forecast panel is on the page`, false); continue; }
  if (skin === 'classic') {
    check('old skin: nothing is hatched, and the caption no longer says it is',
      got.hatched === 0 && !/hatch/i.test(got.cap) && /forecast, in the colours the key names/.test(got.cap), got.cap);
  } else {
    check('Arkiv: the forecast bars are hatched, and the caption says so',
      got.hatched > 0 && got.hatched < got.bars && /^Hatched bars are forecast\./.test(got.cap),
      `${got.hatched} of ${got.bars} · ${got.cap}`);
  }
  check(`${skin}: the key marks the projected series`, got.swProj === 2, String(got.swProj));
  await ctx.close();
}

check('no page error in either skin', errors.length === 0, errors.join(' | '));
await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
