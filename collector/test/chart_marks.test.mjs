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
