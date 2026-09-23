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
   2. gapBars — THE SWAP (SPEC §5). Not measured is an OUTLINE (1px grey-2, no
      fill, the same data end, the full height); an unfinished period (today,
      a clipped week) is a HATCH in its own colour; a second measure behind
      the bar is a WASH, because under Arkiv an outline means "not measured".
      The old skin keeps the hatched void, the hollow dashed bar and the
      outline behind. And every sentence that names a treatment — gapBars'
      own three, #overview's two, #demand's three, #causes', the driver
      Record's four — prints the word for what is drawn, in either skin.

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
  const today = (await import('/tz.js')).dubaiDay();
  c[fn](host, data.map((d) => (d.d === 'TODAY' ? { ...d, d: today } : d)), o);
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
  const attrs = (m) => Object.fromEntries([...m.attributes].map((a) => [a.name, a.value]));
  const absent = [...host.querySelectorAll('svg > [data-absent], svg > rect[fill^="url(#gh"]')].map((m) => {
    const b = m.getBBox(); return { tag: m.tagName, w: b.width, h: b.height, ...attrs(m) }; });
  const behind = [...host.querySelectorAll('svg > [data-behind], svg > rect[fill="none"][stroke="var(--rule-strong)"]')]
    .map((m) => { const b = m.getBBox(); return { tag: m.tagName, w: b.width, h: b.height, ...attrs(m) }; });
  const all = marks.map((m, i) => ({ ...m, ...attrs(host.querySelectorAll('svg > rect[data-rise], svg > path[data-rise]')[i]) }));
  const plot = (() => { const g = [...host.querySelectorAll('line.gl')]; if (!g.length) return null;
    const ys = g.map((l) => +l.getAttribute('y1')); return { top: Math.min(...ys), base: Math.max(...ys) }; })();
  return { form: c.markForm(), words: { projected: c.drawnAs('projected'), absent: c.drawnAs('absent'),
    unfinished: c.drawnAs('unfinished'), behind: c.drawnNoun('behind') },
    vb: svg?.getAttribute('viewBox'), marks, all, pats, absent, behind, plot,
    caps: [...host.querySelectorAll('p.cap')].map((p) => p.textContent) };
};

const nine = Array.from({ length: 9 }, (_, i) => ({ d: `2026-08-${String(i + 1).padStart(2, '0')}`, n: 40 + i * 7 }));
const dense = Array.from({ length: 90 }, (_, i) => ({ d: `2026-06-${i}`, n: 10 + (i % 13) }));
const fc = [...nine.slice(0, 6), ...[{ d: 'Oct', n: 90, proj: 1, lo: 70, hi: 110 }, { d: 'Nov', n: 95, proj: 1, lo: 72, hi: 118 }]];

/* A month of days: one nobody collected, one with a silent source, a second
   measure behind every bar, and the last bar TODAY (still being collected). */
const month = Array.from({ length: 14 }, (_, i) => ({ d: `2026-08-${String(i + 10).padStart(2, '0')}`,
  trips: 30 + (i % 5) * 9, tj: 60 + (i % 4) * 11 }));
month[5] = { d: '2026-08-15', uncollected: true };
month[8].sources_silent = 1;
month.push({ d: 'TODAY', trips: 12, tj: 20 });
const weeks = [{ w: '2026-07-06', n: 50, m: 40 }, { w: '2026-07-13', n: 60, m: 45 },
  { w: '2026-07-20', n: 20, m: 30, partial: true, days: 3, of_days: 7 }];
const GAP = { x: 'd', y: 'trips', label: 'bookings', secondary: 'tj', secondaryLabel: 'telematics journeys' };

const S = {};
for (const skin of ['classic', 'arkiv']) {
  const { ctx, page } = await open(skin);
  S[skin] = {
    gap: await page.evaluate(RENDER, ['gapBars', 1090, month, GAP]),
    wk: await page.evaluate(RENDER, ['gapBars', 700, weeks, { x: 'w', y: 'n', secondary: 'm', inProgress: false }]),
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

console.log('\n2 · gapBars: not measured is an outline, unfinished is a hatch');
{
  const c = S.classic.gap, a = S.arkiv.gap;
  check('old skin: the fixed 720 × 240 box it always drew', c.vb === '0 0 720 240', c.vb);
  check('Arkiv: drawn at the size it is seen at (the host’s 1,090px)', /^0 0 1090 /.test(a.vb), a.vb);
  check('old skin: the uncollected day is a HATCHED band across its step, the full height',
    c.absent.length === 1 && c.absent[0].tag === 'rect' && /^url\(#gh/.test(c.absent[0].fill)
    && c.absent[0].w > 40 && Math.abs(c.absent[0].h - (c.plot.base - c.plot.top)) < 0.5, JSON.stringify(c.absent));
  const ab = a.absent[0] || {};
  check('Arkiv: the uncollected day is an OUTLINE — 1px abs-outline, no fill, hoverable inside',
    a.absent.length === 1 && ab.tag === 'path' && ab.fill === 'none' && ab.stroke === 'var(--abs-outline)'
    && ab['stroke-width'] === '1' && ab['pointer-events'] === 'all', JSON.stringify(a.absent));
  check('Arkiv: …the width of a bar with the same data end, the full height of the plot',
    ab.w <= 24 && /Q/.test(ab.d || '') && Math.abs(ab.h - (a.plot.base - a.plot.top)) < 1.01,
    JSON.stringify([ab.w, ab.h, a.plot]));
  check('Arkiv: …and the old void pattern is not drawn at all', !a.pats.some((p) => /^gh/.test(p.id)));
  const cLive = c.all[c.all.length - 1], aLive = a.all[a.all.length - 1];
  check('old skin: today’s bar is HOLLOW — paper-2 inside a dashed edge in the series colour',
    cLive.tag === 'rect' && cLive.fill === 'var(--surface-2)' && cLive['stroke-dasharray'] === '3 2'
    && cLive.stroke === 'var(--b400)', JSON.stringify(cLive));
  check('Arkiv: today’s bar is a HATCH in its own colour, with a 1px edge in that colour',
    aLive.tag === 'path' && /^url\(#ht/.test(aLive.fill) && aLive.stroke === 'var(--b400)'
    && aLive['stroke-width'] === '1' && !aLive['stroke-dasharray'], JSON.stringify(aLive));
  const hp = a.pats.find((p) => aLive.fill === `url(#${p.id})`);
  check('Arkiv: …the SPEC hatch: 4px, 45°, the series colour at --hatch-a',
    hp && hp.w === '4' && hp.rot === 'rotate(45)' && hp.line.stroke === 'var(--b400)' && hp.line.op === 'var(--hatch-a)',
    JSON.stringify(hp));
  check('Arkiv: every other bar is solid, a path with its data end rounded',
    a.all.slice(0, -1).every((m) => m.tag === 'path' && m.fill === 'var(--b400)'), JSON.stringify(a.all.map((m) => m.fill)));
  check('old skin: the measure behind is an OUTLINE, 2px wider each side',
    c.behind.length === 14 && c.behind.every((m) => m.tag === 'rect' && m.fill === 'none'), String(c.behind.length));
  check('Arkiv: the measure behind is a WASH (14% of the series colour), never an outline',
    a.behind.length === 14 && a.behind.every((m) => m.tag === 'path' && m.fill === 'var(--b400)'
      && +m['fill-opacity'] === 0.14 && !m.stroke), JSON.stringify(a.behind[0]));
  const cc = c.caps.join(' | '), ac = a.caps.join(' | ');
  check('old skin: the captions are production’s, word for word',
    /It is drawn hollow rather than filled so it is not read as a fall\./.test(cc)
    && /days: nothing was collected — drawn as a hatched band, not as zero\./.test(cc), cc);
  check('Arkiv: the captions name what Arkiv draws',
    /It is drawn hatched rather than solid so it is not read as a fall\./.test(ac)
    && /days: nothing was collected — drawn as an empty outline, not as zero\./.test(ac)
    && !/hollow|hatched band/.test(ac), ac);
  const cw = S.classic.wk, aw = S.arkiv.wk;
  check('a clipped week: hollow in the old skin, hatched under Arkiv, and each caption says which',
    cw.all[2]['stroke-dasharray'] === '3 2' && /^url\(#ht/.test(aw.all[2].fill)
    && /Drawn hollow, because a part-week/.test(cw.caps.join(' ')) && /Drawn hatched, because a part-week/.test(aw.caps.join(' ')),
    JSON.stringify([cw.caps, aw.caps]));
  check('the words: hatch/hollow/outline in the old skin, outline/hatch/pale bar under Arkiv',
    c.words.absent === 'hatched' && c.words.unfinished === 'hollow' && c.words.behind === 'an outline'
    && a.words.absent === 'outlined' && a.words.unfinished === 'hatched' && a.words.behind === 'a pale bar',
    JSON.stringify([c.words, a.words]));
}

/* Every caption the plan and the review listed, as a scan of the page code:
   no string names a chart treatment in a literal any more. Each phrase is
   one the product printed; any of them coming back is a caption that says
   "hatched" under an outline (or "hollow" under a hatch) in one of the skins. */
{
  const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const OLD = [
    ['app.js', /nobody collected is hatched, not zero/], ['app.js', /missing ones are drawn hatched rather/],
    ['app.js', /is '\s*\+\s*'hatched rather than drawn as zero/], ['app.js', /draws its bar hollow/],
    ['app.js', /day is drawn hatched rather than as zero/], ['causes.js', /Hatched columns are months we hold no data/],
    ['driverrecord.js', /drawn as an outline behind each/], ['driverrecord.js', /The outline behind each bar/],
    ['driverrecord.js', /and the outline behind it their position/], ['driverrecord.js', /is drawn hollow and given no verdict/],
    ['charts.js', /Drawn hollow, because a part-week/], ['charts.js', /It is drawn hollow rather than filled/],
    ['charts.js', /drawn as a hatched band, not as zero/], ['forecast.js', /'Hatched bars are forecast\. The months/],
  ];
  const back = OLD.filter(([f, re]) => re.test(code(f))).map(([f, re]) => `${f} ${re}`);
  check(`no caption names a chart treatment in a literal (${OLD.length} phrases, 6 files)`, back.length === 0, back.join(' · '));
}

/* ── 1c · drawn at the size it is seen at, and ticks that fit ─────────────
   #payouts builds its panel, draws the chart, and only then appends the
   panel, so the host measured 0 and the chart was drawn at the 720-unit
   fallback and stretched: ticks at 1.5×, and twelve "23 Dec 2024" labels
   running into each other. Under Arkiv the chart redraws once the host has a
   width, and the tick count follows the width of the labels. */
console.log('\n1c · a chart drawn before its panel is on the page, and ticks that fit');
const DETACHED = async ([fn, width, data, opts]) => {
  const c = await import('/charts.js');
  document.querySelector('#dhost')?.remove();
  const host = document.createElement('div'); host.id = 'dhost';
  c[fn](host, data, opts);                          // drawn while detached
  host.style.cssText = `width:${width}px;position:absolute;left:0;top:0`;
  document.body.append(host);                       // …then put on the page
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))));
  const svg = host.querySelector('svg');
  const boxes = [...svg.querySelectorAll('text.axis')].filter((t) => t.getAttribute('text-anchor') === 'middle')
    .map((t) => t.getBoundingClientRect()).map((b) => [b.left, b.right]).sort((a, b) => a[0] - b[0]);
  const overlaps = boxes.slice(1).filter((b, i) => b[0] < boxes[i][1] - 0.5).length;
  return { vb: svg.getAttribute('viewBox'), labels: boxes.length, overlaps };
};
const payDays = Array.from({ length: 91 }, (_, i) => {
  const t = new Date(Date.UTC(2024, 11, 23) + i * 7 * 864e5);
  return { day: t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }), v: 1000 + (i % 9) * 900 };
});
for (const skin of ['classic', 'arkiv']) {
  const { ctx, page } = await open(skin);
  const r = await page.evaluate(DETACHED, ['barChart', 1090, payDays, { x: 'day', y: 'v' }]);
  const g = await page.evaluate(DETACHED, ['gapBars', 1090, payDays, { x: 'day', y: 'v', inProgress: false }]);
  const narrow = await page.evaluate(DETACHED, ['barChart', 515, payDays, { x: 'day', y: 'v' }]);
  if (skin === 'classic') {
    check('old skin: a chart drawn detached keeps the 720 fallback it has on production',
      r.vb.startsWith('0 0 720 ') && g.vb === '0 0 720 240', JSON.stringify([r.vb, g.vb]));
  } else {
    check('Arkiv: barChart drawn detached is drawn again at the host’s 1,090px once it is on the page',
      r.vb.startsWith('0 0 1090 '), r.vb);
    check('Arkiv: …and so is gapBars', g.vb.startsWith('0 0 1090 '), g.vb);
    check('Arkiv: 91 "23 Dec 2024"-long labels print as many as fit, and none overlaps',
      r.labels >= 6 && r.overlaps === 0 && g.overlaps === 0, JSON.stringify([r, g]));
    /* Twelve fit at 1,090px; at a two-up panel's 515px they do not, and the
       old fixed twelve ran together there. */
    check('Arkiv: …and at a two-up panel’s 515px, fewer labels and still none overlapping',
      narrow.labels < 12 && narrow.labels >= 3 && narrow.overlaps === 0, JSON.stringify(narrow));
  }
  await ctx.close();
}

/* ── 3 · areaChart ───────────────────────────────────────────────────── */
console.log('\n3 · areaChart: a 10% wash, a gap that is a gap, the endpoint labelled');
const AREA = async ([width, data]) => {
  const c = await import('/charts.js');
  document.querySelector('#ahost')?.remove();
  const host = document.createElement('div'); host.id = 'ahost'; host.className = 'panel';
  host.style.cssText = `width:${width}px;position:absolute;left:0;top:0`;
  document.body.append(host);
  c.areaChart(host, data, { x: 'd', y: 'v', valueFmt: (v) => `${v} trips` });
  const svg = host.querySelector('svg'), cs = (e) => getComputedStyle(e);
  const end = svg.querySelector('.ar-end');
  const vbw = +svg.getAttribute('viewBox').split(' ')[2];
  return { vb: svg.getAttribute('viewBox'),
    stops: [...svg.querySelectorAll('.ar-wash stop')].map((e) => +cs(e).stopOpacity),
    bridge: [...svg.querySelectorAll('.ar-bridge')].map((e) => cs(e).display),
    dots: [...svg.querySelectorAll('.ar-dot')].map((e) => cs(e).r),
    end: end && { shown: cs(end).display !== 'none', text: end.textContent,
      inside: end.getBBox().x >= 0 && end.getBBox().x + end.getBBox().width <= vbw + 0.5 },
    line: [...svg.querySelectorAll('path[stroke]')].map((p) => [p.getAttribute('stroke-width'), p.getAttribute('stroke-linejoin')]) };
};
const series = [{ d: 'a', v: 10 }, { d: 'b', v: 14 }, { d: 'c', v: null }, { d: 'd', v: 12 }, { d: 'e', v: 19 }];
for (const skin of ['classic', 'arkiv']) {
  const { ctx, page } = await open(skin);
  const r = await page.evaluate(AREA, [800, series]);
  if (skin === 'classic') {
    check('old skin: the 720 box, the 30% → 0 gradient, the dashed bridge, r 3.5, no endpoint label',
      r.vb === '0 0 720 240' && Math.abs(r.stops[0] - 0.3) < 1e-6 && r.stops[1] === 0
      && r.bridge.length === 1 && r.bridge[0] !== 'none' && r.dots.every((x) => x === '3.5px') && r.end && !r.end.shown,
      JSON.stringify(r));
  } else {
    check('Arkiv: drawn at the host’s width', r.vb.startsWith('0 0 800 '), r.vb);
    check('Arkiv: the area is a flat 10% wash', r.stops.length === 2 && r.stops.every((o) => Math.abs(o - 0.1) < 1e-6),
      JSON.stringify(r.stops));
    check('Arkiv: a gap is a gap — no bridge across the hole', r.bridge.length === 1 && r.bridge[0] === 'none',
      JSON.stringify(r.bridge));
    check('Arkiv: markers are r 4', r.dots.length >= 1 && r.dots.every((x) => x === '4px'), JSON.stringify(r.dots));
    check('Arkiv: the endpoint carries its value, inside the drawing', r.end && r.end.shown && r.end.text === '19 trips'
      && r.end.inside, JSON.stringify(r.end));
  }
  check(`${skin}: lines stay 2px with round joins`, r.line.length === 2 && r.line.every(([w, j]) => w === '2' && j === 'round'),
    JSON.stringify(r.line));
  await ctx.close();
}

/* ── 4 · hbars ─────────────────────────────────────────────────────────── */
console.log('\n4 · hbars: ink, grey deductions, no track ground, a channel row’s gutter marker');
const HB = async ([rows, withColor]) => {
  const c = await import('/charts.js');
  document.querySelector('#hhost')?.remove();
  const host = document.createElement('div'); host.id = 'hhost'; host.className = 'panel';
  host.style.cssText = 'width:700px;position:absolute;left:0;top:0';
  document.body.append(host);
  c.hbars(host, rows, withColor ? { colorFor: (d) => (d.plat ? `--c-${d.plat}` : null) } : {});
  const cs = (e) => getComputedStyle(e);
  return {
    rows: [...host.querySelectorAll('.hb')].map((r) => {
      const f = r.querySelector('.fill'), t = r.querySelector('.track'), m = r.querySelector('.hb-mk'), k = r.querySelector('.k');
      return { label: k.textContent, fill: cs(f).backgroundColor, radius: cs(f).borderRadius,
        track: cs(t).backgroundColor, trackH: t.getBoundingClientRect().height, v: r.querySelector('.v').textContent,
        trackBox: [Math.round(t.getBoundingClientRect().left), Math.round(t.getBoundingClientRect().width)],
        mark: m ? { shown: cs(m).display !== 'none', bg: cs(m).backgroundColor, w: m.getBoundingClientRect().width } : null,
        kColor: cs(k).color, kLeft: (() => { const g = document.createRange(); g.selectNodeContents(k);
          return Math.round(g.getBoundingClientRect().left - r.getBoundingClientRect().left); })() };
    }),
    legend: [...host.querySelectorAll('.legend .sw')].map((e) => cs(e).backgroundColor),
  };
};
const hbRows = [{ label: 'Uber', n: 50 }, { label: 'Earnings', n: 30 }, { label: 'Cash already taken', n: -20 },
  { label: 'A long value', n: 123456789.5 }];
const hbPlat = [{ label: 'Bolt · Comfort', plat: 'bolt', n: 9 }, { label: 'Something else', n: 4 }];
const rgb = (h) => `rgb(${[1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ')})`;
for (const skin of ['classic', 'arkiv']) {
  const { ctx, page } = await open(skin);
  const r = await page.evaluate(HB, [hbRows, false]);
  const p = await page.evaluate(HB, [hbPlat, true]);
  const [uber, earn, cash] = r.rows;
  if (skin === 'classic') {
    check('old skin: the default fill is --b400 and a deduction --s2, on the old track, as before',
      earn.fill === rgb('#6699bd') && cash.fill === rgb('#c2683a') && earn.track !== 'rgba(0, 0, 0, 0)'
      && Math.round(earn.trackH) === 15, JSON.stringify([earn, cash]));
    check('old skin: no gutter marker is shown', [...r.rows, ...p.rows].every((x) => !x.mark || !x.mark.shown),
      JSON.stringify(r.rows.map((x) => x.mark)));
    check('old skin: the default legend still matches its bars', r.legend[0] === earn.fill && r.legend[1] === cash.fill,
      JSON.stringify(r.legend));
  } else {
    check('Arkiv: the default fill is INK', earn.fill === rgb(T.NEUTRAL.ink), earn.fill);
    check('Arkiv: a deduction is GREY, with its − sign', cash.fill === rgb(T.NEUTRAL.grey) && /^−/.test(cash.v),
      JSON.stringify(cash));
    check('Arkiv: no track ground, a bar at most 14px', earn.track === 'rgba(0, 0, 0, 0)' && earn.trackH <= 14,
      JSON.stringify([earn.track, earn.trackH]));
    check('Arkiv: the data end is rounded 4px — the right end, or the left for a deduction',
      earn.radius === '0px 4px 4px 0px' && cash.radius === '4px 0px 0px 4px', JSON.stringify([earn.radius, cash.radius]));
    check('Arkiv: a row labelled with a channel carries that channel’s 3px gutter marker',
      uber.mark && uber.mark.shown && uber.mark.bg === rgb(T.CHANNEL.uber) && uber.mark.w === 3 && uber.kLeft >= 10,
      JSON.stringify(uber));
    check('Arkiv: …so does a row coloured by channel, and a row that is no channel has none',
      p.rows[0].mark?.shown && p.rows[0].mark.bg === rgb(T.CHANNEL.bolt) && !p.rows[1].mark && !earn.mark,
      JSON.stringify(p.rows));
    check('Arkiv: the label stays ink — text never wears the channel', uber.kColor === rgb(T.NEUTRAL.ink), uber.kColor);
    check('Arkiv: every row’s track is one width, however wide its value, so bar lengths compare',
      new Set(r.rows.map((x) => x.trackBox.join())).size === 1, JSON.stringify(r.rows.map((x) => x.trackBox)));
    check('Arkiv: the default legend matches its bars (ink added, grey deducted)',
      r.legend[0] === earn.fill && r.legend[1] === cash.fill, JSON.stringify(r.legend));
  }
  await ctx.close();
}
/* Every caller that drew the default bars under its own key named --b400
   and --s2, which the skin now paints differently from the bars: the key
   must name the job tokens the bars are drawn with. */
{
  const keys = ['app.js', 'driver.js', 'revenue.js'].flatMap((f) =>
    [...read(f).matchAll(/legend: \[\['(--[a-z0-9-]+)', '[^']*'\], \['(--[a-z0-9-]+)'/g)].map((m) => `${f} ${m[1]} ${m[2]}`));
  check(`every hbars key over default bars names --mk-fill and --mk-neg (${keys.length})`,
    keys.length === 5 && keys.every((k) => / --mk-fill --mk-neg$/.test(k)), keys.join(' · '));
}

/* ── 5 · donut: colour by name, distinct slots, and the `as` option ─────── */
console.log('\n5 · donut: by name, distinct slots, and ranked bars or a 100% bar on request');
const DN = async ([data, opts]) => {
  const c = await import('/charts.js');
  document.querySelector('#nhost')?.remove();
  const host = document.createElement('div'); host.id = 'nhost'; host.className = 'panel';
  host.style.cssText = 'width:900px;position:absolute;left:0;top:0';
  document.body.append(host);
  const clicked = [];
  const o = { ...opts };
  if (o.clickAll) { delete o.clickAll; o.onClick = (d) => clicked.push(d.label); }
  if (o.nullColor) { delete o.nullColor; o.colorFor = () => null; }
  c.donut(host, data, o);
  const cs = (e) => getComputedStyle(e);
  const arcs = [...host.querySelectorAll('svg.donut path')].map((p) => ({ attr: p.getAttribute('fill'), fill: cs(p).fill }));
  const keys = [...host.querySelectorAll('.dnut-keys .dk')].map((k) => ({
    label: k.querySelector('.dk-l').textContent, sw: cs(k.querySelector('.sw')).backgroundColor }));
  const rows = [...host.querySelectorAll('.hbars .hb')].map((r) => ({ label: r.querySelector('.k').textContent,
    v: r.querySelector('.v').textContent, click: r.hasAttribute('data-click'),
    mark: !!r.querySelector('.hb-mk') && cs(r.querySelector('.hb-mk')).display !== 'none' }));
  for (const r of host.querySelectorAll('.hbars .hb[data-click]')) r.click();
  const segs = [...host.querySelectorAll('svg:not(.donut) rect[data-fade]')].length;
  return { arcs, keys, rows, clicked, segs, ring: !!host.querySelector('svg.donut') };
};
const chans = [{ label: 'FMS telematics', n: 611 }, { label: 'Uber', n: 487 }, { label: 'Bolt', n: 21 },
  { label: 'Hotel', n: 20 }, { label: 'Yango', n: 1 }];
const kinds = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((label, i) => ({ label, n: 60 - i * 8 }));
const nineKinds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((label, i) => ({ label, n: 90 - i * 9 }));
const D = {};
for (const skin of ['classic', 'arkiv']) {
  const { ctx, page } = await open(skin);
  D[skin] = {
    chans: await page.evaluate(DN, [chans, {}]),
    kinds: await page.evaluate(DN, [kinds, {}]),
    nine: await page.evaluate(DN, [nineKinds, {}]),
    unmapped: await page.evaluate(DN, [[{ label: 'Careem', n: 5 }, { label: 'Uber', n: 9 }], { nullColor: true }]),
    bars: await page.evaluate(DN, [[...chans, { label: 'Careem', n: 3 }], { as: 'bars', clickAll: true, max: 5 }]),
    bar100: await page.evaluate(DN, [kinds, { as: 'bar100' }]),
  };
  await ctx.close();
}
{
  const c = D.classic, a = D.arkiv;
  const S_OLD = ['#2f6f9f', '#c2683a', '#2f8f6f', '#4a4e8c', '#8a6a12'].map(rgb);
  check('old skin: a channel donut with no colorFor still paints the five --s slots it painted, by position',
    JSON.stringify(c.chans.arcs.map((x) => x.fill)) === JSON.stringify(S_OLD), JSON.stringify(c.chans.arcs));
  check('old skin: …through the new names (a slot, with the channel asked for by name first)',
    c.chans.arcs[1].attr === 'var(--chan-uber, var(--cat-2))' && c.kinds.arcs[0].attr === 'var(--cat-1)',
    JSON.stringify([c.chans.arcs[1].attr, c.kinds.arcs[0].attr]));
  const CH = ['fms', 'uber', 'bolt', 'hotel', 'yango'].map((k) => rgb(T.CHANNEL[k]));
  check('Arkiv: the same donut paints each channel in its identity, by NAME',
    JSON.stringify(a.chans.arcs.map((x) => x.fill)) === JSON.stringify(CH), JSON.stringify(a.chans.arcs.map((x) => x.fill)));
  const kf = a.kinds.arcs.map((x) => x.fill);
  check('Arkiv: six categories that are not channels are six DISTINCT neutral steps, not one ink',
    new Set(kf).size === 6 && kf.every((f) => [...T.SEQUENTIAL].map(rgb).includes(f)), JSON.stringify(kf));
  const lum = (f) => { const [r, g, b] = f.match(/\d+/g).map(Number); return T.oklch('#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')).L * 100; };
  const kl = kf.map(lum);
  check('Arkiv: …neighbours on the ring at least 20 apart in lightness, and the ring closes at least 10 apart',
    kl.every((l, i) => Math.abs(l - kl[(i + 1) % kl.length]) >= 10) && kl.slice(1).every((l, i) => Math.abs(l - kl[i]) >= 20),
    JSON.stringify(kl.map((x) => x.toFixed(0))));
  check('both skins: nine categories fold the tail into a grey "Other", never a slot colour',
    [c, a].every((x) => x.nine.arcs.length === 8 && x.nine.arcs[7].attr === 'var(--grey)'
      && x.nine.keys[7].label === 'Other (2)'), JSON.stringify(a.nine.keys));
  check('Arkiv: a channel the caller could not map is unidentified grey; the old skin keeps its slot',
    a.unmapped.arcs.find((x, i) => a.unmapped.keys[i].label === 'Careem').fill === rgb(T.NEUTRAL.grey)
    && c.unmapped.arcs.find((x, i) => c.unmapped.keys[i].label === 'Careem').fill === rgb('#c2683a'),
    JSON.stringify([a.unmapped, c.unmapped].map((x) => x.arcs)));
  check('both skins: every key swatch is the colour of its arc', [c, a].every((x) =>
    [x.chans, x.kinds, x.nine].every((d) => d.keys.every((k, i) => k.sw === d.arcs[i].fill))));
  const b = a.bars;
  check('as:"bars" draws ranked bars and no ring', !b.ring && b.rows.length === 6
    && b.rows.map((r) => r.label).join() === 'FMS telematics,Uber,Bolt,Hotel,Careem,Other (1)', JSON.stringify(b.rows));
  check('as:"bars" prints the count AND the share on every row', b.rows.every((r) => /^[\d,]+ (\d+(\.\d)?%|<0\.1%)$/.test(r.v))
    && b.rows[0]?.v === '611 53%' && b.rows[5]?.v === '1 0.1%', JSON.stringify(b.rows.map((r) => r.v)));
  check('as:"bars" keeps the clicks, and the fold never navigates',
    JSON.stringify(b.clicked) === JSON.stringify(['FMS telematics', 'Uber', 'Bolt', 'Hotel', 'Careem']) && b.rows[5] && !b.rows[5].click,
    JSON.stringify(b.clicked));
  check('Arkiv: …a channel row carries its marker, a row that is not a channel has none',
    b.rows.length === 6 && b.rows.slice(0, 4).every((r) => r.mark) && !b.rows[4].mark && !b.rows[5].mark,
    JSON.stringify(b.rows.map((r) => r.mark)));
  check('as:"bar100" draws one 100% bar with its key, and no ring', !a.bar100.ring && a.bar100.segs === 6
    && !c.bar100.ring && c.bar100.segs === 6, JSON.stringify([a.bar100.segs, c.bar100.segs]));
}

/* ── 6 · heatmap ───────────────────────────────────────────────────────── */
console.log('\n6 · heatmap: graphite, the outline for no reading, a strip for a key');
const HM = async ([rows]) => {
  const c = await import('/charts.js');
  document.querySelector('#mhost')?.remove();
  const host = document.createElement('div'); host.id = 'mhost'; host.className = 'panel';
  host.style.cssText = 'width:1000px;position:absolute;left:0;top:0';
  document.body.append(host);
  c.heatmap(host, rows, { unit: 'trips' });
  const cs = (e) => getComputedStyle(e);
  const cells = [...host.querySelectorAll('svg rect')].map((r) => ({ fill: r.getAttribute('fill'), stroke: r.getAttribute('stroke'),
    paint: cs(r).fill }));
  const key = host.querySelector('.legend');
  return { vb: host.querySelector('svg').getAttribute('viewBox'), cells, keyClass: key.className,
    steps: [...key.querySelectorAll('.hm-step')].map((e) => cs(e).backgroundColor),
    ends: [...key.querySelectorAll('.hm-end')].map((e) => e.textContent),
    swatches: key.querySelectorAll('.sw').length, text: key.textContent };
};
/* Monday at 08:00 is the busiest hour; Tuesday runs a gradient; Wednesday
   at 03:00 was measured at nought; nothing else was recorded at all. */
const hmRows = [{ dow: 1, h: 8, trips: 60 }, ...[0, 1, 2, 3, 4, 5].map((k) => ({ dow: 2, h: 10 + k, trips: 1 + k * 10 })),
  { dow: 3, h: 3, trips: 0 }];
const at = (d, h) => d * 24 + h;
const H6 = {};
for (const [skin, scheme] of [['classic', 'light'], ['arkiv', 'light'], ['arkiv', 'dark']]) {
  const { ctx, page } = await open(skin, { scheme });
  H6[`${skin}-${scheme}`] = await page.evaluate(HM, [hmRows]);
  await ctx.close();
}
{
  const c = H6['classic-light'], a = H6['arkiv-light'], k = H6['arkiv-dark'];
  check('old skin: the blue ramp, a zero and an unrecorded hour drawn alike, the old key, the 760 box',
    c.vb === '0 0 760 208' && c.cells[at(1, 8)].fill === 'var(--b700)' && c.cells[at(3, 3)].fill === 'var(--surface-2)'
    && c.cells[at(0, 0)].fill === 'var(--surface-2)' && c.cells[at(0, 0)].stroke === 'var(--rule)'
    && c.swatches === 8 && /none/.test(c.text), JSON.stringify([c.vb, c.cells[at(1, 8)], c.cells[at(3, 3)], c.swatches]));
  check('Arkiv: drawn at the host’s width', a.vb === '0 0 1000 208', a.vb);
  const tue = [0, 1, 2, 3, 4, 5].map((q) => a.cells[at(2, 10 + q)].fill);
  check('Arkiv: graphite, --seq-0 … --seq-5 as sequentialIndex picks, the busiest hour the darkest step',
    a.cells[at(1, 8)].fill === 'var(--seq-5)'
    && JSON.stringify(tue) === JSON.stringify([1, 11, 21, 31, 41, 51].map((v) => `var(--seq-${T.sequentialIndex(v / 60)})`)),
    JSON.stringify([a.cells[at(1, 8)].fill, tue]));
  check('Arkiv: an hour with NO READING is the absence outline, never step 0 and never a fill',
    a.cells[at(0, 0)].fill === 'none' && a.cells[at(0, 0)].stroke === 'var(--abs-outline)', JSON.stringify(a.cells[at(0, 0)]));
  check('Arkiv: an hour measured at nought is a third thing: an empty paper-2 cell',
    a.cells[at(3, 3)].fill === 'var(--paper-2)' && a.cells[at(3, 3)].stroke === 'var(--hair)', JSON.stringify(a.cells[at(3, 3)]));
  check('Arkiv: the key is one strip of the six steps, labelled 0 and 60 at its ends',
    /hm-key/.test(a.keyClass) && a.steps.length === 6
    && JSON.stringify(a.steps) === JSON.stringify(T.SEQUENTIAL.map(rgb)) && a.ends.join() === '0,60', JSON.stringify(a));
  check('Arkiv: …and names the outline and the empty cell in words, because both are on this grid',
    /nothing recorded/.test(a.text) && /none, measured/.test(a.text), a.text);
  check('Arkiv dark: the same steps from the dark graphite ramp',
    JSON.stringify(k.steps) === JSON.stringify(T.SEQUENTIAL_DARK.map(rgb)), JSON.stringify(k.steps));
}
{
  /* The key names what an absent cell MEANS for the measure, where the
     caller says (a rate with no hours under it). */
  const { ctx, page } = await open('arkiv');
  const g = await page.evaluate(async () => {
    const c = await import('/charts.js');
    const host = document.createElement('div'); host.style.width = '900px'; document.body.append(host);
    c.heatmap(host, [{ dow: 1, h: 8, trips: 2.5 }, { dow: 1, h: 9, trips: null }],
      { unit: 'jobs per online hour', gapLabel: 'nobody was online in this hour, so there is no rate' });
    return host.querySelector('.legend').textContent;
  });
  check('a caller’s own reason for an absent cell is the one the key prints',
    /nobody was online in this hour, so there is no rate/.test(g) && !/nothing recorded/.test(g), g);
  await ctx.close();
  /* The callers that handed an absent cell in as a nought, and the captions
     that named a shade that is only darker on a light page. */
  const code = (f) => read(f).replace(/\/\*[\s\S]*?\*\//g, ' ');
  check('no heatmap caller turns an unmeasured cell into 0 (capacity ?? 0, optimise Number(null))',
    !/drivers_needed \?\? 0/.test(code('capacity.js')) && !/trips: Number\(c\.jobs_per_online_h\)/.test(code('optimise.js')));
  const dark = ['app.js', 'capacity.js', 'optimise.js'].filter((f) => /Darker (=|means|is)/.test(code(f)));
  check('no heatmap caption says "darker" — in dark mode the busiest cell is the lightest', dark.length === 0, dark.join(' '));
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

/* The page captions that name gapBars' treatments, rendered on the mock. */
console.log('\n2b · the pages say what gapBars draws');
const capOf = async (page, route, re) => {
  await page.goto(`${base}/?ui=desktop&${route}`, { waitUntil: 'networkidle' });
  await page.waitForFunction((src) => [...document.querySelectorAll('#view .panel h3')]
    .some((h) => new RegExp(src, 'i').test(h.textContent)), re.source, { timeout: 30000 }).catch(() => {});
  return page.evaluate((src) => {
    const p = [...document.querySelectorAll('#view .panel')].find((x) => new RegExp(src, 'i').test(x.querySelector('h3')?.textContent || ''));
    return p ? p.querySelector('.cap')?.textContent || '' : null;
  }, re.source);
};
for (const skin of ['classic', 'arkiv']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${skin} pages: ${String(e.message).slice(0, 160)}`));
  const word = skin === 'classic' ? 'hatched' : 'outlined';
  const ov = await capOf(page, `skin=${skin}#overview`, /^Trips per/);
  check(`${skin}: #overview says a day nobody collected is ${word}`,
    new RegExp(`nobody collected is ${word}, not zero`).test(ov || ''), ov);
  const dm = await capOf(page, `skin=${skin}#demand`, /^Daily volume/);
  check(`${skin}: #demand says the same`, new RegExp(`collected is ${word} rather than drawn as zero`).test(dm || ''), dm);
  const cz = await capOf(page, `skin=${skin}#causes`, /^Trips per month/);
  check(`${skin}: #causes names its outline and its hatch, the marks it draws`,
    /Outlined columns are months we hold no data for; hatched ones are partial months/.test(cz || ''), cz);
  await ctx.close();
}

check('no page error in either skin', errors.length === 0, errors.join(' | '));
await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
