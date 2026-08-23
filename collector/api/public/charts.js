// Minimal SVG chart kit — thin marks, recessive grid, hover tooltips, click-to-drill.
// Colours come from CSS custom properties (the validated categorical palette).
const tt = () => document.getElementById('tt');
/* Every token here must exist in app.css. `--s7`/`--s8` were referenced and
   never defined: as an SVG fill an undefined var resolves to BLACK, and as a
   CSS background to TRANSPARENT — so the seventh slice of a donut went black
   and a bar coloured `--s8` disappeared entirely. Both are now defined; this
   list and the palette must stay in step. */
import { TZ } from './tz.js';
export const CAT = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
export const SEQ = ['--b100', '--b200', '--b300', '--b400', '--b500', '--b600', '--b700'];

export function showTip(html, e) {
  const t = tt(); t.innerHTML = html; t.style.opacity = 1;
  t.style.left = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 12) + 'px';
  t.style.top = Math.max(e.clientY - 36, 8) + 'px';
}
export function hideTip() { tt().style.opacity = 0; }
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
/* `isNaN(Infinity)` is false and `Number('') === 0`, so the old guards let a
   division by zero through as "∞" — and, where a tile colours by threshold,
   Infinity clears every "good" bar and gets painted green. An empty string
   rendered as a confident "0". Anything that is not a finite number is not a
   number, and says so. */
export const fmt = (n, d = 0) => (n == null || n === '' || !Number.isFinite(Number(n))
  ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));

function interactive(el, label, onClick) {
  el.style.cursor = onClick ? 'pointer' : 'crosshair';
  el.addEventListener('mousemove', (e) => showTip(label, e));
  el.addEventListener('mouseleave', hideTip);
  if (onClick) el.addEventListener('click', (e) => { hideTip(); onClick(e); });
}

/* ── vertical bars (magnitude over time / category) ── */
/* Gridline values for an axis. With a small integer maximum (a count of 0–3,
   say) four evenly-spaced ticks round to the same number twice — "1, 1, 0, 0"
   down the side, which reads as a broken chart. Fall back to integer steps
   whenever the range is small enough for that to be exact. */
function ticks(max, n = 3) {
  if (max <= n) {
    const out = [];
    for (let v = 0; v <= Math.ceil(max); v++) out.push(v);
    return out;
  }
  return Array.from({ length: n + 1 }, (_, i) => (max * i) / n);
}

/* `colorFor` picks a colour per bar. It exists so a series can mark ONE bar as
   the subject — the day page draws the fortnight around a date and the date
   itself was indistinguishable from its neighbours, which is the one thing the
   chart is there to show. */
export function barChart(host, data, { x, y, label, color = '--b400', colorFor, onClick, valueFmt = (v) => fmt(v) } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 240, pl = 46, pr = 12, pt = 18, pb = 34;
  const raw = Math.max(...data.map((d) => +d[y] || 0)) || 1;
  const marks = ticks(raw <= 3 ? raw : raw * 1.12);
  const max = marks[marks.length - 1] || 1;
  const iw = W - pl - pr, ih = H - pt - pb, step = iw / data.length, bw = Math.min(step * 0.62, 44);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  marks.forEach((v) => {
    const gy = pt + ih - ih * (v / max);
    svg.append(mk('line', { class: 'gl', x1: pl, y1: gy, x2: W - pr, y2: gy }),
      txt(pl - 7, gy + 3, valueFmt(v >= 10 ? Math.round(v) : +v.toFixed(1)), 'axis', 'end'));
  });
  data.forEach((d, i) => {
    const h = ih * (+d[y]) / max, bx = pl + step * i + (step - bw) / 2, by = pt + ih - h;
    const fill = (colorFor && colorFor(d, i)) || color;
    const r = mk('rect', { x: bx, y: by, width: bw, height: Math.max(h, 1), rx: 3, fill: `var(${fill})`, 'data-rise': '' });
    interactive(r, `${esc(d[x])} — <b>${valueFmt(d[y])}</b>${label ? ' ' + label : ''}`, onClick && (() => onClick(d)));
    svg.append(r);
    // Past ~16 bars the labels used to be dropped entirely, so the default
    // 30-day range showed a chart with no dates at all under a caption inviting
    // you to click a specific day. Thin them instead, the way areaChart does.
    const every = Math.max(1, Math.ceil(data.length / 12));
    if (i % every === 0 || i === data.length - 1) {
      svg.append(txt(bx + bw / 2, H - 10, shortLabel(d[x]), 'axis', 'middle'));
    }
  });
  host.append(svg);
}

/* ── a bar chart that can say "we did not look" ──────────────────────────
   A bar chart plots by array index, so a series that omits uncollected days
   draws a 124-day hole as two touching bars, and a series that returns 0 for
   them draws a collapse that never happened. Live, the Overview showed 45 of
   91 days at zero on days the fleet ran 9,712 telematics journeys, and the
   default 30-day view showed a 10x growth step that was only the Uber export
   resuming after a gap.

   `gapKey` marks a datum as uncollected. Those days are drawn as a hatched
   void across the full height of the plot — an absence, not a low value — and
   the caption states how many there were. */
export function gapBars(host, data, { x, y, label, color = '--b400', gapKey = 'uncollected',
  onClick, valueFmt = (v) => fmt(v), secondary,
  // What the background bar IS. It was hardcoded as "telematics journeys" in the
  // tooltip, which is true on the one page that first used it and a lie on any
  // other — the unauthorized page draws total occupancy intervals there.
  secondaryLabel = 'telematics journeys',
  // What a hatched day MEANS. "nothing was collected" is right for a trip
  // series and wrong for a seat sensor, where the honest statement is narrower.
  gapLabel = 'nothing was collected' } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 240, pl = 46, pr = 12, pt = 18, pb = 34;
  const vals = data.filter((d) => !d[gapKey]).map((d) => +d[y] || 0);
  const raw = Math.max(...vals, secondary ? Math.max(...data.map((d) => +d[secondary] || 0)) : 0) || 1;
  const marks = ticks(raw <= 3 ? raw : raw * 1.12);
  const max = marks[marks.length - 1] || 1;
  const iw = W - pl - pr, ih = H - pt - pb, step = iw / data.length, bw = Math.min(step * 0.62, 44);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });

  // One hatch pattern, reused by every void band.
  const defs = mk('defs');
  const pat = mk('pattern', { id: 'gapHatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse',
    patternTransform: 'rotate(45)' });
  pat.append(mk('rect', { width: 6, height: 6, fill: 'var(--surface-2)' }),
    mk('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--rule-strong)', 'stroke-width': 2 }));
  defs.append(pat); svg.append(defs);

  marks.forEach((v) => {
    const gy = pt + ih - ih * (v / max);
    svg.append(mk('line', { class: 'gl', x1: pl, y1: gy, x2: W - pr, y2: gy }),
      txt(pl - 7, gy + 3, valueFmt(v >= 10 ? Math.round(v) : +v.toFixed(1)), 'axis', 'end'));
  });

  data.forEach((d, i) => {
    const bx = pl + step * i;
    if (d[gapKey]) {
      const band = mk('rect', { x: bx, y: pt, width: Math.max(step, 1), height: ih, fill: 'url(#gapHatch)' });
      interactive(band, `${esc(d[x])} — <b>${esc(gapLabel)}</b>${
        d.silent_sources ? `<br>silent: ${esc([].concat(d.silent_sources).join(', '))}` : ''}`);
      svg.append(band);
      return;
    }
    if (secondary && +d[secondary] > 0) {
      const sh = ih * (+d[secondary]) / max;
      svg.append(mk('rect', { x: bx + (step - bw) / 2 - 2, y: pt + ih - sh, width: bw + 4,
        height: Math.max(sh, 1), rx: 3, fill: 'var(--surface-3)' }));
    }
    const h = ih * (+d[y]) / max, cx = bx + (step - bw) / 2, by = pt + ih - h;
    const r = mk('rect', { x: cx, y: by, width: bw, height: Math.max(h, 1), rx: 3,
      fill: `var(${color})`, 'data-rise': '' });
    interactive(r, `${esc(d[x])} — <b>${valueFmt(d[y])}</b>${label ? ' ' + label : ''}${
      secondary && +d[secondary] ? `<br>${fmt(d[secondary])} ${esc(secondaryLabel)}` : ''}`,
    onClick && (() => onClick(d)));
    svg.append(r);
    const every = Math.max(1, Math.ceil(data.length / 12));
    if (i % every === 0 || i === data.length - 1) {
      svg.append(txt(bx + step / 2, H - 10, shortLabel(d[x]), 'axis', 'middle'));
    }
  });
  host.append(svg);

  const gaps = data.filter((d) => d[gapKey]).length;
  const partial = data.filter((d) => !d[gapKey] && d.sources_silent > 0).length;
  if (gaps || partial) {
    const c = document.createElement('p'); c.className = 'cap';
    c.innerHTML = [
      gaps ? `<b>${fmt(gaps)} of ${fmt(data.length)} days: ${esc(gapLabel)}</b> — drawn as a hatched band, not as zero.` : '',
      partial ? `${fmt(partial)} more had at least one source silent, so their bars are understated.` : '',
    ].filter(Boolean).join(' ');
    host.append(c);
  }
}

/* ── line / area (trend) ── */
export function areaChart(host, data, { x, y, color = '--b400', valueFmt = (v) => fmt(v), onClick } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 240, pl = 46, pr = 12, pt = 18, pb = 30;
  const vals = data.map((d) => +d[y]); const max = Math.max(...vals) * 1.14 || 1;
  const iw = W - pl - pr, ih = H - pt - pb;
  const X = (i) => pl + (data.length === 1 ? iw / 2 : iw * i / (data.length - 1));
  const Y = (v) => pt + ih - ih * v / max;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let i = 0; i <= 3; i++) {
    const gy = pt + ih - ih * i / 3;
    svg.append(mk('line', { class: 'gl', x1: pl, y1: gy, x2: W - pr, y2: gy }),
      txt(pl - 7, gy + 3, valueFmt(Math.round(max * i / 3)), 'axis', 'end'));
  }
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  const defs = mk('defs'); const lg = mk('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
  lg.append(mk('stop', { offset: 0, 'stop-color': `var(${color})`, 'stop-opacity': .30 }),
    mk('stop', { offset: 1, 'stop-color': `var(${color})`, 'stop-opacity': 0 }));
  defs.append(lg); svg.append(defs);
  let line = '', area = `M ${X(0)} ${pt + ih}`;
  data.forEach((d, i) => { const px = X(i), py = Y(+d[y]); line += (i ? ' L ' : 'M ') + px + ' ' + py; area += ` L ${px} ${py}`; });
  area += ` L ${X(data.length - 1)} ${pt + ih} Z`;
  svg.append(mk('path', { d: area, fill: `url(#${id})`, 'data-fade': '' }),
    mk('path', { d: line, fill: 'none', stroke: `var(${color})`, 'stroke-width': 2, 'stroke-linejoin': 'round', 'data-draw': '' }));
  data.forEach((d, i) => {
    const c = mk('circle', { cx: X(i), cy: Y(+d[y]), r: 9, fill: 'transparent' });
    interactive(c, `${esc(d[x])} — <b>${valueFmt(d[y])}</b>`, onClick && (() => onClick(d)));
    svg.append(c);
  });
  const ticks = data.length <= 8 ? data.map((_, i) => i) : [0, Math.floor(data.length / 3), Math.floor(2 * data.length / 3), data.length - 1];
  ticks.forEach((i) => svg.append(txt(X(i), H - 8, shortLabel(data[i][x]), 'axis', 'middle')));
  host.append(svg);
}

/* ── donut (composition, few slices) ── */
export function donut(host, data, { label = 'label', value = 'n', onClick, max = 8 } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  /* The tail is FOLDED, never dropped. This used to render the first eight
     slices and print the total of ALL of them in the ring's centre, so a
     nineteen-category payment mix showed eight slices whose visible values
     could not add up to the number between them — and every hotel payment
     route but one was invisible while its revenue stayed inside the total. */
  const sorted = [...data].sort((a, b) => (+b[value] || 0) - (+a[value] || 0));
  const shown = sorted.slice(0, max);
  const tail = sorted.slice(max);
  if (tail.length) {
    shown.push({ [label]: `Other (${tail.length})`, [value]: tail.reduce((a, d) => a + (+d[value] || 0), 0),
      _tail: tail.map((d) => `${d[label]} ${fmt(d[value])}`) });
  }
  const tot = shown.reduce((a, d) => a + +d[value], 0) || 1;
  const S = 190, r = 74, ir = 47, cx = S / 2, cy = S / 2;
  const svg = mk('svg', { viewBox: `0 0 ${S} ${S}`, role: 'img', class: 'donut', style: 'margin:0 auto;display:block' });
  let a0 = -Math.PI / 2;
  shown.forEach((d, i) => {
    const frac = +d[value] / tot, a1 = a0 + frac * Math.PI * 2, gap = 0.016;
    const p = arc(cx, cy, r, ir, a0 + gap, Math.max(a1 - gap, a0 + gap));
    const path = mk('path', { d: p, fill: `var(${CAT[i % CAT.length]})`, 'data-fade': '' });
    interactive(path, `${esc(d[label])} — <b>${fmt(d[value])}</b> (${(frac * 100).toFixed(1)}%)${
      d._tail ? `<br><span style="opacity:.8">${esc(d._tail.slice(0, 10).join(' · '))}</span>` : ''}`,
    onClick && !d._tail && (() => onClick(d)));
    svg.append(path); a0 = a1;
  });
  svg.append(txt(cx, cy - 2, fmt(tot), 'vlab', 'middle', 'font-size:19px;font-weight:600;fill:var(--ink)'),
    txt(cx, cy + 14, 'total', 'axis', 'middle'));
  host.append(svg);
  const leg = document.createElement('div'); leg.className = 'legend';
  leg.innerHTML = shown.map((d, i) =>
    `<span><i class="sw" style="background:var(${CAT[i % CAT.length]})"></i>${esc(d[label])} · <b class="num">${fmt(d[value])}</b></span>`).join('');
  host.append(leg);
}

/* ── horizontal bars (ranking) ── */
export function hbars(host, data, { label = 'label', value = 'n', color, seq = false, onClick, valueFmt = (v) => fmt(v) } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const max = Math.max(...data.map((d) => +d[value])) || 1;
  const wrap = document.createElement('div'); wrap.className = 'hbars';
  data.forEach((d, i) => {
    const row = document.createElement('div'); row.className = 'hb';
    const c = color ? `var(${color})` : seq ? `var(${SEQ[Math.max(6 - i, 2)]})` : `var(${CAT[i % CAT.length]})`;
    row.innerHTML = `<div class="k" title="${esc(d[label])}">${esc(d[label])}</div>
      <div class="track"><div class="fill" style="width:${(+d[value] / max * 100).toFixed(1)}%;background:${c}"></div></div>
      <div class="v num">${valueFmt(d[value])}</div>`;
    interactive(row, `${esc(d[label])} — <b>${valueFmt(d[value])}</b>`, onClick && (() => onClick(d)));
    wrap.append(row);
  });
  host.append(wrap);
}

/* ── heatmap (day-of-week × hour) ── */
export function heatmap(host, rows, { onClick } = {}) {
  host.innerHTML = '';
  if (!rows.length) return empty(host);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const grid = {}; let max = 0;
  rows.forEach((r) => { grid[`${r.dow}-${r.h}`] = r.trips; max = Math.max(max, r.trips); });
  const W = 760, cell = 26, lw = 40, H = 7 * cell + 26;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let d = 0; d < 7; d++) {
    svg.append(txt(lw - 8, d * cell + 17, DOW[d], 'axis', 'end'));
    for (let h = 0; h < 24; h++) {
      const v = grid[`${d}-${h}`] || 0, w = (W - lw - 8) / 24;
      const idx = v === 0 ? -1 : Math.min(6, Math.floor(v / max * 6.99));
      const rect = mk('rect', {
        x: lw + h * w, y: d * cell + 3, width: w - 2, height: cell - 4, rx: 2,
        fill: idx < 0 ? 'var(--surface-2)' : `var(${SEQ[idx]})`,
      });
      interactive(rect, `${DOW[d]} ${String(h).padStart(2, '0')}:00 — <b>${fmt(v)}</b> trips`,
        onClick && (() => onClick({ dow: d, h, trips: v })));
      svg.append(rect);
    }
  }
  [0, 4, 8, 12, 16, 20, 23].forEach((h) => svg.append(txt(lw + h * ((W - lw - 8) / 24) + 6, H - 6, String(h).padStart(2, '0'), 'axis', 'middle')));
  host.append(svg);
}

/* ── scatter (two measures per entity) ── */
export function scatter(host, data, { x, y, label, xLabel, yLabel, onClick } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 280, pl = 52, pr = 16, pt = 16, pb = 40;
  const xs = data.map((d) => +d[x]), ys = data.map((d) => +d[y]);
  const xmax = Math.max(...xs) * 1.1 || 1, ymax = Math.max(...ys) * 1.1 || 1;
  const iw = W - pl - pr, ih = H - pt - pb;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  for (let i = 0; i <= 3; i++) {
    const gy = pt + ih - ih * i / 3;
    svg.append(mk('line', { class: 'gl', x1: pl, y1: gy, x2: W - pr, y2: gy }),
      txt(pl - 7, gy + 3, fmt(Math.round(ymax * i / 3)), 'axis', 'end'));
  }
  data.forEach((d) => {
    const cx = pl + iw * (+d[x]) / xmax, cy = pt + ih - ih * (+d[y]) / ymax;
    const c = mk('circle', { cx, cy, r: 5, fill: 'var(--s1)', 'fill-opacity': .75, stroke: 'var(--surface)', 'stroke-width': 1.5 });
    interactive(c, `${esc(d[label])} — ${xLabel}: <b>${fmt(d[x])}</b>, ${yLabel}: <b>${fmt(d[y])}</b>`, onClick && (() => onClick(d)));
    svg.append(c);
  });
  svg.append(txt(pl + iw / 2, H - 8, xLabel, 'axis', 'middle'));
  [0, 1, 2, 3].forEach((i) => svg.append(txt(pl + iw * i / 3, H - 22, fmt(Math.round(xmax * i / 3)), 'axis', 'middle')));
  host.append(svg);
}

/* ── stacked bar (one row, composition) ── */
export function stackedBar(host, data, { label = 'label', value = 'n' } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const tot = data.reduce((a, d) => a + +d[value], 0) || 1;
  const W = 400, H = 26; let x = 0;
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img' });
  data.forEach((d, i) => {
    const w = +d[value] / tot * W;
    const r = mk('rect', { x: x + (x ? 1 : 0), y: 0, width: Math.max(w - 1, 1), height: H, rx: 2, fill: `var(${CAT[i % CAT.length]})`, 'data-fade': '' });
    interactive(r, `${esc(d[label])} — <b>${fmt(d[value])}</b> (${(+d[value] / tot * 100).toFixed(1)}%)`);
    svg.append(r); x += w;
  });
  host.append(svg);
  const leg = document.createElement('div'); leg.className = 'legend';
  leg.innerHTML = data.map((d, i) => `<span><i class="sw" style="background:var(${CAT[i % CAT.length]})"></i>${esc(d[label])} · <b class="num">${(+d[value] / tot * 100).toFixed(1)}%</b></span>`).join('');
  host.append(leg);
}

/* helpers */
function mk(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function txt(x, y, s, cls, anchor = 'start', style = '') {
  const t = mk('text', { x, y, class: cls, 'text-anchor': anchor }); t.textContent = s;
  if (style) t.setAttribute('style', style);
  return t;
}
function arc(cx, cy, r, ir, a0, a1) {
  const p = (rad, a) => [cx + rad * Math.cos(a), cy + rad * Math.sin(a)];
  const [x0, y0] = p(r, a0), [x1, y1] = p(r, a1), [x2, y2] = p(ir, a1), [x3, y3] = p(ir, a0);
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${big} 1 ${x1} ${y1} L ${x2} ${y2} A ${ir} ${ir} 0 ${big} 0 ${x3} ${y3} Z`;
}
function shortLabel(v) {
  const s = String(v ?? '');
  // Dubai, like every other date in this product: a UTC-midnight date string
  // rendered in a western zone is the previous day on the axis.
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: TZ });
  }
  return s.length > 11 ? s.slice(0, 10) + '…' : s;
}
export function empty(host, msg = 'No data for this range yet') {
  // Callers reach here after loading() has filled the host with a skeleton.
  // Appending without clearing left a forever-shimmering "Loading…" bar sitting
  // on top of the empty state.
  host.innerHTML = '';
  const d = document.createElement('div'); d.className = 'empty';
  d.innerHTML = `<b>Nothing to show</b>${msg}`;
  host.append(d); return d;
}
