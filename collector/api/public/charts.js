// Minimal SVG chart kit — thin marks, recessive grid, hover tooltips, click-to-drill.
// Colours come from CSS custom properties (the validated categorical palette).
const tt = () => document.getElementById('tt');
/* Every token here must exist in app.css. `--s7`/`--s8` were referenced and
   never defined: as an SVG fill an undefined var resolves to BLACK, and as a
   CSS background to TRANSPARENT — so the seventh slice of a donut went black
   and a bar coloured `--s8` disappeared entirely. Both are now defined; this
   list and the palette must stay in step. */
import { TZ, dubaiDay } from './tz.js';
export const CAT = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
export const SEQ = ['--b100', '--b200', '--b300', '--b400', '--b500', '--b600', '--b700'];

/* The class, not an inline opacity.
   ─────────────────────────────────────────────────────────────────────────
   app.css has carried `#tt.on{opacity:1;transform:none}` for as long as the
   tooltip has existed and nothing ever added the class — this set
   `style.opacity` directly instead. An inline opacity beats the rule, so the
   tooltip appeared, and `transform:translateY(3px)` never came off: every
   chart tooltip in the product has rendered three pixels below where it was
   meant to settle, in the position it was supposed to animate out of. */
export function showTip(html, e) {
  const t = tt(); t.innerHTML = html; t.classList.add('on');
  t.style.left = Math.min(e.clientX + 14, innerWidth - t.offsetWidth - 12) + 'px';
  t.style.top = Math.max(e.clientY - 36, 8) + 'px';
}
export function hideTip() { tt().classList.remove('on'); }
const esc = (s) => String(s ?? '').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
/* `isNaN(Infinity)` is false and `Number('') === 0`, so the old guards let a
   division by zero through as "∞" — and, where a tile colours by threshold,
   Infinity clears every "good" bar and gets painted green. An empty string
   rendered as a confident "0". Anything that is not a finite number is not a
   number, and says so. */
export const fmt = (n, d = 0) => (n == null || n === '' || !Number.isFinite(Number(n))
  ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));

/* fmt() drops trailing zeros, which is right for a headline and wrong for a
   column: 11.8 and 20 sat under one heading, one of them with a decimal place
   and one without, and the eye reads that as two different kinds of number.
   dec() pins the decimals so a column lines up. */
export const dec = (n, d = 1) => (n == null || n === '' || !Number.isFinite(Number(n))
  ? '—' : Number(n).toLocaleString(undefined,
    { minimumFractionDigits: d, maximumFractionDigits: d }));

/* A name for a chart, or no role at all.
   ─────────────────────────────────────────────────────────────────────────
   Every svg here was `role="img"` with nothing naming it. That is worse than
   leaving the role off: role="img" PRUNES the subtree, so the <text> axis
   labels a screen reader would otherwise have read are hidden, and all that is
   announced is the word "image". Where a caller can say what the chart shows,
   the role stays and carries the name; where it cannot, the role goes and the
   text inside stays reachable. */
function name(svg, label) {
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.removeAttribute('role');
  return svg;
}

function interactive(el, label, onClick) {
  el.style.cursor = onClick ? 'pointer' : 'crosshair';
  el.addEventListener('mousemove', (e) => showTip(label, e));
  el.addEventListener('mouseleave', hideTip);
  if (onClick) el.addEventListener('click', (e) => { hideTip(); onClick(e); });
}

/* ── the shared axis ───────────────────────────────────────────────────────
   Four charts drew the same gridline loop — barChart, gapBars, areaChart and,
   in a variant, scatter — three of them character for character. The x-label
   thinning rule was written twice and the fix for labels printing on top of
   each other ("22:0023:00") reached only one copy. The integer-tick fallback
   was ported into areaChart by hand and never into scatter, which still
   rounds its axis to integers and so labels a sub-1 AED/km series "0 / 0 / 1
   / 1". One place, one behaviour. */

/* Round numbers a reader can hold.
   ─────────────────────────────────────────────────────────────────────────
   The old ticks() returned max × i / n, and every caller inflated the max
   first (× 1.12, × 1.14), so a series peaking at 999 drew gridlines labelled
   0 / 373 / 746 / 1,119. Arithmetically exact, and not a scale anybody reads.
   Snapping the STEP to 1, 2, 2.5 or 5 times a power of ten gives 0 / 250 /
   500 / 750 / 1,000 and needs no headroom fudge, because rounding the step up
   already clears the peak. */
export function niceTicks(lo, hi, target = 4) {
  if (!(hi > lo)) return [0, 1];
  const span = hi - lo, rough = span / target;
  /* A small integer range gets integer steps. Four evenly spaced ticks over a
     maximum of 3 round onto the same number twice — "1, 1, 0, 0" down the
     side, which reads as a broken chart. */
  if (span <= target && Number.isInteger(hi) && lo === 0) {
    return Array.from({ length: Math.ceil(hi) + 1 }, (_, i) => i);
  }
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= rough) || 10) * mag;
  /* The top mark must be AT OR ABOVE the peak, because the caller scales the
     plot to it. Stopping at the last step below the peak — 0/250/500/750 for a
     series topping out at 999 — puts the tallest bar 33% outside its own plot.
     Rounding the ceiling UP to a step boundary is also what replaces the old
     × 1.12 headroom fudge: the space above the peak is a consequence of using
     round numbers, not an arbitrary margin. */
  const top = Math.ceil(hi / step) * step;
  const out = [];
  for (let v = Math.floor(lo / step) * step; v <= top + step * 1e-9; v += step) {
    // toPrecision kills the float drift that turns a 0.1 step into
    // 0.30000000000000004 and prints it as a gridline label.
    out.push(+v.toPrecision(12));
  }
  return out;
}

/* ── how big to draw, and how much room the labels need ──────────────────
   THE CHART IS DRAWN AT THE SIZE IT WILL BE SEEN AT.
   ─────────────────────────────────────────────────────────────────────────
   Every chart in this product used a fixed `viewBox="0 0 720 240"` and app.css
   stretched it with width:100%. On a 1440px window the day page's "Through the
   day" panel is 1090px wide, so that drawing was scaled by 1.514 — and an SVG
   scales its TEXT along with its geometry. The axis labels are declared at
   --t2, about 10.1px; they painted at 15.3px. Every gridline, every stroke and
   every label on the page was half again the size it was designed at, which is
   most of what "it looks ghastly" was pointing at. A chart in a narrow column
   had the opposite problem and drew everything too small.

   Measuring the host and drawing into that many user units makes the scale
   exactly 1, so a 10px label is 10px wherever the chart lands. The fallback is
   the old 720 for a host that has not been laid out yet — a chart drawn inside
   a display:none panel measures zero, and zero would collapse the drawing. */
export function chartBox(host, { ratio = 0.3, min = 190, max = 340, fallback = 720 } = {}) {
  const w = Math.round(host?.getBoundingClientRect?.().width || 0);
  const W = w > 240 ? w : fallback;
  /* Height follows width rather than being fixed, so a chart in a third of a
     row is not the same 240 units tall as one across the whole page — which is
     what made narrow charts look like columns of stripes. */
  return { W, H: Math.round(Math.min(max, Math.max(min, W * ratio))) };
}

/* THE GUTTER IS MEASURED FROM THE LABELS, not guessed at once and hoped for.
   ─────────────────────────────────────────────────────────────────────────
   pl was the constant 46 everywhere, and the label is drawn anchored `end` at
   pl - 7, so a tick string wider than 39 units starts at a negative x. The day
   page passed `valueFmt: (v) => `${fmt(v)} bookings`` — one formatter serving
   both the tooltip and the axis — so its gridlines read "10 bookings", about
   70 units wide, beginning at x = -31. app.css sets overflow:visible on chart
   svgs so that painted OUTSIDE the chart and over the panel's edge: measured,
   four labels spilling 12-21px past the panel at 1440px and again at 1024px.

   Reserving the room the widest label actually needs closes that for every
   formatter, including ones nobody has written yet. .axis is IBM Plex Mono, so
   the advance is a constant share of the size and the width is arithmetic
   rather than a guess: no getComputedTextLength, no reflow, no second pass. */
const AXIS_EM = 0.6;          // IBM Plex Mono advance, as a share of font-size
const AXIS_PX = 10.1;         // --t2 at a 16px root
export const axisGutter = (labels, { minimum = 30 } = {}) => Math.ceil(Math.max(
  minimum,
  Math.max(0, ...labels.map((t) => String(t).length)) * AXIS_EM * AXIS_PX + 11));

/* Draws the y axis and RETURNS the scale it drew, so no caller computes a
   maximum twice and then disagrees with its own gridlines.

   `fixedMax` states what the measure's ceiling IS — a share cannot exceed
   100% — and suppresses the headroom, because a gridline above a value the
   series cannot take is a scale that lies about the range. That rule existed
   in areaChart alone; it now covers every chart that asks for it. */
/* The tick VALUES, alone, so the gutter can be measured from the labels before
   anything is drawn. Extracted rather than duplicated: a second copy of this
   rule would be a second answer to "what does this axis say", and the whole
   point of measuring the gutter is that it matches what lands on the page. */
export function yTicks({ hi, fixedMax = null, target = 4 }) {
  if (fixedMax != null && fixedMax > 0) {
    return Array.from({ length: target }, (_, i) => (fixedMax * i) / (target - 1));
  }
  /* An all-zero series gets ONE line at the baseline: repeating "0" four
     times up the side asserts a scale that has no values on it. */
  return !(hi > 0) ? [0] : niceTicks(0, hi, target);
}

export function yAxis(svg, { hi, pl, pr, pt, ih, W, fmt: f = fmt,
  fixedMax = null, target = 4, baseline = true }) {
  const marks = yTicks({ hi, fixedMax, target });
  const max = marks[marks.length - 1] || 1;
  marks.forEach((v) => {
    const gy = pt + ih - ih * (v / max);
    /* Zero is not just another gridline. Drawn at the same weight as the
       others, the bars appear to float above nothing. */
    svg.append(mk('line', { class: baseline && v === 0 ? 'gl gl-base' : 'gl',
      x1: pl, y1: gy, x2: W - pr, y2: gy }),
      txt(pl - 7, gy + 3, f(v), 'axis', 'end'));
  });
  return { max, marks };
}

/* One thinning rule for every time axis, tail guard included.
   ─────────────────────────────────────────────────────────────────────────
   On a 24-bar chart `every` is 2, so 22:00 is drawn by the rule and 23:00 by
   the forced-last-label exception, and the two print on top of each other as
   "22:0023:00". barChart carried the guard; gapBars, which draws the busiest
   charts in the product, did not. */
export function xTickIndices(n, target = 12) {
  const every = Math.max(1, Math.ceil(n / target));
  const lastThinned = Math.floor((n - 1) / every) * every;
  const out = [];
  for (let i = 0; i < n; i++) {
    const isTail = i === n - 1 && (n - 1) - lastThinned >= every;
    if (i % every === 0 || isTail) out.push(i);
  }
  return out;
}

/* ── vertical bars (magnitude over time / category) ── */

/* `colorFor` picks a colour per bar. It exists so a series can mark ONE bar as
   the subject — the day page draws the fortnight around a date and the date
   itself was indistinguishable from its neighbours, which is the one thing the
   chart is there to show. */
/* `lo`/`hi` name per-datum interval keys. A forecast bar drawn solid is a
   point estimate presented as a fact: #forecast's caption promised hatching
   and a range, and drew neither, so "223,400 next year" appeared without the
   126,200–320,500 it actually sits inside. Where a datum carries both, a
   whisker is drawn through the bar and the tooltip states the range. */
/* `max` fixes the top of the scale from outside.
   ─────────────────────────────────────────────────────────────────────────
   Two charts of the same measure drawn one above the other are read as a
   comparison, and two independently scaled axes make that reading wrong: a
   peak of 5 and a peak of 7 both fill their own plot, so the taller day looks
   identical to the shorter one. #compare draws exactly that pair, so it passes
   the larger of the two maxima to both. Everywhere else the default — scale to
   this series — is still what a single chart wants. */
export function barChart(host, data, { x, y, label, color = '--b400', colorFor, onClick,
  valueFmt = (v) => fmt(v), axisFmt = null, lo = null, hi = null,
  max: fixedMax = null, aria = null } = {}) {
  /* THE AXIS AND THE TOOLTIP ARE NOT THE SAME FORMATTER, and treating them as
     one is what put "10 bookings / 20 bookings / 30 bookings" up the side of
     the day page. A tooltip names a single value and wants its unit; an axis
     is four labels on one scale and needs the unit said once, not four times.
     valueFmt still serves the tooltip; axisFmt defaults to the plain number.
     A caller whose axis genuinely reads better with the unit — money, where
     "1,240" and "AED 1,240" are different claims — passes axisFmt: money. */
  axisFmt = axisFmt || ((v) => fmt(v));
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const { W, H } = chartBox(host);
  const raw = Math.max(...data.map((d) => Math.max(+d[y] || 0, hi ? +d[hi] || 0 : 0))) || 1;
  /* The ticks are worked out BEFORE the gutter, because the gutter is however
     much room the widest of them needs. Same call the axis makes below, so the
     two cannot disagree about what will be drawn. */
  const pl = axisGutter(yTicks({ hi: raw, fixedMax }).map((v) => axisFmt(v)));
  const pr = 14, pt = 18, pb = 34;
  const iw = W - pl - pr, ih = H - pt - pb, step = iw / data.length;
  /* The gap tracks the count. 0.62 was one ratio for every series, which is
     too tight under ten bars and too loose over sixty; and the floor stops a
     ninety-bar chart drawing 4.6px bars with a 3px corner radius, which is an
     ellipse rather than a bar. */
  const pad = data.length <= 12 ? 0.28 : data.length <= 40 ? 0.18 : 0.10;
  const bw = Math.max(Math.min(step * (1 - pad), 44), 1.5);
  const svg = name(mk('svg', { viewBox: `0 0 ${W} ${H}` }), aria);
  const { max } = yAxis(svg, { hi: raw, pl, pr, pt, ih, W, fmt: axisFmt, fixedMax });
  const xAt = new Set(xTickIndices(data.length));
  data.forEach((d, i) => {
    const h = ih * (+d[y]) / max, bx = pl + step * i + (step - bw) / 2, by = pt + ih - h;
    const fill = (colorFor && colorFor(d, i)) || color;
    /* A real zero draws NOTHING, and only a real zero. `Math.max(h, 1)` gave
       every zero a 1px stub indistinguishable from a value too small to see —
       and the same stub to a day nobody measured, which is a different fact. */
    const bh = +d[y] === 0 ? 0 : Math.max(h, 1);
    const r = mk('rect', { x: bx, y: by, width: bw, height: bh,
      // A radius wider than half the bar rounds it into a lozenge.
      rx: Math.min(3, bw / 2, bh / 2), fill: `var(${fill})`, 'data-rise': '' });
    const hasRange = lo && hi && d[lo] != null && d[hi] != null;
    interactive(r, `${esc(d[x])} — <b>${valueFmt(d[y])}</b>${label ? ' ' + label : ''}`
      + (hasRange ? `<br>somewhere between ${valueFmt(d[lo])} and ${valueFmt(d[hi])}` : ''),
      onClick && (() => onClick(d)));
    svg.append(r);
    if (hasRange) {
      const yl = pt + ih - ih * (+d[lo]) / max, yh = pt + ih - ih * (+d[hi]) / max;
      const cxb = bx + bw / 2, cap = Math.min(bw * 0.45, 9);
      svg.append(
        mk('line', { x1: cxb, x2: cxb, y1: yh, y2: yl, stroke: 'var(--ink-2)', 'stroke-width': 1.4, opacity: .75 }),
        mk('line', { x1: cxb - cap, x2: cxb + cap, y1: yh, y2: yh, stroke: 'var(--ink-2)', 'stroke-width': 1.4, opacity: .75 }),
        mk('line', { x1: cxb - cap, x2: cxb + cap, y1: yl, y2: yl, stroke: 'var(--ink-2)', 'stroke-width': 1.4, opacity: .75 }));
    }
    // Past ~16 bars the labels used to be dropped entirely, so the default
    // 30-day range showed a chart with no dates at all under a caption inviting
    // you to click a specific day. Thinned by the shared rule — see
    // xTickIndices, which carries the tail guard gapBars was missing.
    if (xAt.has(i)) svg.append(txt(bx + bw / 2, H - 10, shortLabel(d[x]), 'axis', 'middle'));
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
/* Is this bucket label the Dubai day it is now? The chart is handed day
   strings ("2026-08-26") and Postgres timestamps ("2026-08-26T00:00:00.000Z")
   by different callers, so both are reduced to ten characters before
   comparing. Dubai's day, never the viewer's: this fleet's calendar is
   Dubai's and a reader in London opening it at 21:00 is looking at tomorrow. */
/* Exported: the phone application needs the same answer, and a second copy of
   "is this today in Dubai" is exactly the kind of duplicate that drifts. */
export const isToday = (v) => String(v ?? '').slice(0, 10) === dubaiDay();
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());

export function gapBars(host, data, { x, y, label, color = '--b400', gapKey = 'uncollected',
  onClick, valueFmt = (v) => fmt(v), secondary,
  // What the background bar IS. It was hardcoded as "telematics journeys" in the
  // tooltip, which is true on the one page that first used it and a lie on any
  // other — the unauthorized page draws total occupancy intervals there.
  secondaryLabel = 'telematics journeys',
  // What a hatched day MEANS. "nothing was collected" is right for a trip
  // series and wrong for a seat sensor, where the honest statement is narrower.
  gapLabel = 'nothing was collected',
  /* A day that has not finished yet.
     ─────────────────────────────────────────────────────────────────────
     TODAY is six hours old when somebody opens this at breakfast, and it was
     drawn at full weight beside thirty complete days: 37 bookings against 475
     and 487 the two days before. Nothing on the chart said the bar was still
     filling, so the first thing the dashboard showed every morning was a
     cliff that does not exist.

     The product already knows how to say this everywhere else — #compare cuts
     both days to the same Dubai minute, #causes hatches a partial month and
     names how many of its days are in the record — and the one chart on the
     landing page did not. Drawn hollow, with the hour in the tooltip and a
     sentence under the chart.

     Opt-out rather than opt-in: `inProgress: false` for a series where the
     last bucket is not a day in progress. */
  inProgress = true, aria = null } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 240, pl = 46, pr = 12, pt = 18, pb = 34;
  const vals = data.filter((d) => !d[gapKey]).map((d) => +d[y] || 0);
  const raw = Math.max(...vals, secondary ? Math.max(...data.map((d) => +d[secondary] || 0)) : 0) || 1;
  const iw = W - pl - pr, ih = H - pt - pb, step = iw / data.length;
  const pad = data.length <= 12 ? 0.28 : data.length <= 40 ? 0.18 : 0.10;
  const bw = Math.max(Math.min(step * (1 - pad), 44), 1.5);
  const svg = name(mk('svg', { viewBox: `0 0 ${W} ${H}` }), aria);

  /* One hatch pattern per CHART, not per page.
     The id was the fixed string "gapHatch", and two gapBars on one page — the
     Overview renders an areaChart and a gapBars into the same panel body, and
     two of these can co-exist across a re-render — make two elements with the
     same DOM id. Every `url(#gapHatch)` then resolves to whichever came first,
     so the second chart's voids are drawn with the first chart's pattern, in
     the first chart's coordinate space. areaChart has always namespaced its
     gradient id; this never did. */
  const hid = 'gh' + Math.random().toString(36).slice(2, 7);
  const defs = mk('defs');
  /* Two crossing lines in a 6×6 tile, and no patternTransform. A rotation on a
     userSpaceOnUse pattern turns about the origin, so the hatch phase differed
     with each band's x position and adjacent voids did not line up — which
     reads as noise rather than as one texture. */
  const pat = mk('pattern', { id: hid, width: 6, height: 6, patternUnits: 'userSpaceOnUse' });
  pat.append(mk('rect', { width: 6, height: 6, fill: 'var(--surface-2)' }),
    mk('line', { x1: 0, y1: 0, x2: 6, y2: 6, stroke: 'var(--rule-strong)', 'stroke-width': 1 }),
    mk('line', { x1: 6, y1: 0, x2: 0, y2: 6, stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
  defs.append(pat); svg.append(defs);

  const { max } = yAxis(svg, { hi: raw, pl, pr, pt, ih, W, fmt: valueFmt });
  const xAt = new Set(xTickIndices(data.length));

  data.forEach((d, i) => {
    const bx = pl + step * i;
    if (d[gapKey]) {
      const band = mk('rect', { x: bx, y: pt, width: Math.max(step, 1), height: ih, fill: `url(#${hid})` });
      interactive(band, `${esc(d[x])} — <b>${esc(gapLabel)}</b>${
        d.silent_sources ? `<br>silent: ${esc([].concat(d.silent_sources).join(', '))}` : ''}`);
      svg.append(band);
      return;
    }
    if (secondary && +d[secondary] > 0) {
      const sh = ih * (+d[secondary]) / max;
      /* An OUTLINE, not a paler solid. Drawn as a fill it competes with the
         foreground bar for figure and ground, and on the unauthorised-segments
         chart the foreground is --s8, which had no dark-mode value at all. An
         outline loses that contest by construction, in either theme. */
      svg.append(mk('rect', { x: bx + (step - bw) / 2 - 2, y: pt + ih - sh, width: bw + 4,
        height: Math.max(sh, 1), rx: 3, fill: 'none',
        stroke: 'var(--rule-strong)', 'stroke-width': 1 }));
    }
    const h = ih * (+d[y]) / max, cx = bx + (step - bw) / 2, by = pt + ih - h;
    /* Hollow, not hatched: hatching already means "nobody collected this day",
       and a day in progress is the opposite — it is being collected right now. */
    /* Two different kinds of incomplete bar, drawn the same way because they
       mean the same thing to a reader: this bar covers less time than the ones
       beside it, so its height is not comparable.

         live     the last DAY, still being collected.
         partial  a week or month bucket clipped by the window edge — three
                  days of a week drawn next to whole ones, which reads as a
                  collapse the fleet did not have. The server flags it; before
                  this the chart drew it at full weight.  */
    const clipped = d.partial === true && +d.days > 0 && +d.days < +d.of_days;
    const live = (inProgress && i === data.length - 1 && isToday(d[x])) || clipped;
    const r = mk('rect', { x: cx, y: by, width: bw, height: Math.max(h, 1), rx: 3,
      fill: live ? 'var(--surface-2)' : `var(${color})`,
      ...(live ? { stroke: `var(${color})`, 'stroke-width': 1.5, 'stroke-dasharray': '3 2' } : {}),
      'data-rise': '' });
    interactive(r, `${esc(d[x])} — <b>${valueFmt(d[y])}</b>${label ? ' ' + label : ''}${
      clipped ? ` over <b>${esc(String(d.days))} of ${esc(String(d.of_days))} days</b> — this bucket `
        + 'is cut short by the window, so its height is not comparable'
        : live ? ` <b>so far</b>, at ${esc(nowHHMM())} Dubai — this day is still being collected`
          : ''}${
      secondary && +d[secondary] ? `<br>${fmt(d[secondary])} ${esc(secondaryLabel)}` : ''}`,
    onClick && (() => onClick(d)));
    svg.append(r);
    /* The shared rule, which carries the tail guard this function never had:
       on a 24-bucket chart the thinning drew 22:00 and the forced last label
       drew 23:00, and the two printed on top of each other. */
    if (xAt.has(i)) svg.append(txt(bx + step / 2, H - 10, shortLabel(d[x]), 'axis', 'middle'));
  });
  host.append(svg);

  /* The sentence for the hollow bar, first, because it is about the bar a
     reader is looking at right now rather than about the window as a whole. */
  const clippedBars = data.filter((d) => d.partial === true && +d.days < +d.of_days);
  if (clippedBars.length) {
    const c = document.createElement('p'); c.className = 'cap';
    const which = clippedBars.length === 1 ? 'One bucket is' : `${clippedBars.length} buckets are`;
    c.innerHTML = `${which} cut short by the window — `
      + `${clippedBars.map((d) => `<b>${esc(shortLabel(d[x]))}</b> covers ${esc(String(d.days))} of `
        + `${esc(String(d.of_days))} days`).join(', ')}. Drawn hollow, because a part-week is `
      + 'shorter than a whole one for a reason that is the calendar, not the fleet.';
    host.append(c);
  }

  const last = data[data.length - 1];
  if (inProgress && last && !last[gapKey] && isToday(last[x])) {
    const c = document.createElement('p'); c.className = 'cap';
    c.innerHTML = `The last bar is <b>today, still being collected</b> — ${esc(valueFmt(last[y]))}`
      + `${label ? ` ${esc(label)}` : ''} as of ${esc(nowHHMM())} Dubai, against whole days beside `
      + 'it. It is drawn hollow rather than filled so it is not read as a fall.';
    host.append(c);
  }

  const gaps = data.filter((d) => d[gapKey]).length;
  const partial = data.filter((d) => !d[gapKey] && d.sources_silent > 0).length;
  if (gaps || partial) {
    const c = document.createElement('p'); c.className = 'cap';
    /* "N more" only reads as "more" when something came before it. With no
       uncollected days at all — which is every window on this fleet — the
       caption opened with a dangling "45 more had at least one source silent",
       more than what. */
    c.innerHTML = [
      gaps ? `<b>${fmt(gaps)} of ${fmt(data.length)} days: ${esc(gapLabel)}</b> — drawn as a hatched band, not as zero.` : '',
      partial
        ? `${gaps ? `${fmt(partial)} more` : `${fmt(partial)} of ${fmt(data.length)} days`} had at least `
          + 'one source silent, so their bars are understated.'
        : '',
    ].filter(Boolean).join(' ');
    host.append(c);
  }
}

/* ── line / area (trend) ── */
/* `max` pins the top of the scale. Without it the axis is headroom over the
   largest value — right for a count, wrong for anything with a ceiling: a
   cumulative SHARE topped out at 100% drew a gridline labelled 114%, which is
   a value the series cannot take. Given, the headroom is skipped and the axis
   says what the measure's maximum actually is. */
export function areaChart(host, data, { x, y, color = '--b400', valueFmt = (v) => fmt(v), onClick, max: fixedMax, aria = null } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 240, pl = 46, pr = 12, pt = 18, pb = 30;
  // The scale is set by what was MEASURED. An unmeasured point is not a zero
  // and must not pull the axis, any more than it may pull the line.
  const vals = data.map((d) => Number(d[y])).filter(Number.isFinite);
  const peak = vals.length ? Math.max(...vals) : 0;
  const iw = W - pl - pr, ih = H - pt - pb;
  const X = (i) => pl + (data.length === 1 ? iw / 2 : iw * i / (data.length - 1));
  const svg = name(mk('svg', { viewBox: `0 0 ${W} ${H}` }), aria);
  const { max } = yAxis(svg, { hi: peak, pl, pr, pt, ih, W, fmt: valueFmt, fixedMax });
  const Y = (v) => pt + ih - ih * v / max;
  const id = 'g' + Math.random().toString(36).slice(2, 7);
  const defs = mk('defs'); const lg = mk('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 });
  lg.append(mk('stop', { offset: 0, 'stop-color': `var(${color})`, 'stop-opacity': .30 }),
    mk('stop', { offset: 1, 'stop-color': `var(${color})`, 'stop-opacity': 0 }));
  defs.append(lg); svg.append(defs);

  /* The line BREAKS where nobody measured.
     ─────────────────────────────────────────────────────────────────────────
     This used to read `+d[y] || 0`, so a day with no reading was drawn at the
     baseline with the gradient filled down to it — the visual signature of a
     collapse, for a day on which nothing was known either way. gapBars has
     always refused to do that with a bar; a line has no excuse either. So the
     series is split into runs of consecutive measured points, each run drawn
     as its own line and its own fill, and a dashed connector spans the hole so
     the eye still follows the series without reading the gap as a fall.

     One caller was already compensating for this in its own arguments — the
     Overview passes `r.rate == null ? 0 : r.rate` — and a caller compensating
     for its library is a library with the wrong contract. */
  const measured = (v) => v != null && v !== '' && Number.isFinite(Number(v));
  const runs = [];
  data.forEach((d, i) => {
    if (!measured(d[y])) { runs.push(null); return; }
    const last = runs[runs.length - 1];
    if (Array.isArray(last)) last.push(i); else runs.push([i]);
  });
  const segs = runs.filter(Array.isArray);
  segs.forEach((idx, n) => {
    /* A run of ONE is a dot, not nothing. `M x y` with no following command
       strokes nothing at all, and the area path collapses to zero width — so
       a series with a single measurement drew gridlines, one x label and an
       empty plot. A vehicle with one earning day is reachable from two pages. */
    if (idx.length === 1) {
      const i = idx[0];
      svg.append(mk('circle', { cx: X(i), cy: Y(+data[i][y]), r: 3.5,
        fill: `var(${color})`, stroke: 'var(--surface)', 'stroke-width': 2, 'data-fade': '' }));
      return;
    }
    let line = '', area = `M ${X(idx[0])} ${pt + ih}`;
    idx.forEach((i, k) => {
      const px = X(i), py = Y(+data[i][y]);
      line += (k ? ' L ' : 'M ') + px + ' ' + py; area += ` L ${px} ${py}`;
    });
    area += ` L ${X(idx[idx.length - 1])} ${pt + ih} Z`;
    svg.append(mk('path', { d: area, fill: `url(#${id})`, 'data-fade': '' }),
      mk('path', { d: line, fill: 'none', stroke: `var(${color})`, 'stroke-width': 2,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-draw': '' }));
    // …and the hole before this run, named as a hole rather than drawn as a value.
    const prev = segs[n - 1];
    if (prev) {
      const a = prev[prev.length - 1], b = idx[0];
      svg.append(mk('line', { x1: X(a), y1: Y(+data[a][y]), x2: X(b), y2: Y(+data[b][y]),
        stroke: 'var(--rule-strong)', 'stroke-width': 1.4, 'stroke-dasharray': '4 3' }));
    }
  });
  /* Where the series ENDS, marked. A reader scanning a trend is looking for
     the latest value and it was the one point on the line with nothing on it. */
  const lastSeg = segs[segs.length - 1];
  if (lastSeg && lastSeg.length > 1) {
    const i = lastSeg[lastSeg.length - 1], px = X(i), py = Y(+data[i][y]);
    svg.append(mk('circle', { cx: px, cy: py, r: 3.5, fill: `var(${color})`,
      stroke: 'var(--surface)', 'stroke-width': 2, 'data-fade': '' }));
  }
  data.forEach((d, i) => {
    if (!measured(d[y])) {
      const c0 = mk('rect', { x: X(i) - 5, y: pt, width: 10, height: ih, fill: 'transparent' });
      interactive(c0, `${esc(d[x])} — <b>not measured</b>`);
      svg.append(c0);
      return;
    }
    const c = mk('circle', { cx: X(i), cy: Y(+d[y]), r: 9, fill: 'transparent' });
    interactive(c, `${esc(d[x])} — <b>${valueFmt(d[y])}</b>`, onClick && (() => onClick(d)));
    svg.append(c);
  });
  // The same thinning rule the bars use, so two time axes in one panel column
  // do not disagree about how often a date is worth printing.
  xTickIndices(data.length).forEach((i) =>
    svg.append(txt(X(i), H - 8, shortLabel(data[i][x]), 'axis', 'middle')));
  host.append(svg);
}

/* ── donut (composition, few slices) ── */
/* `clickable` is a per-slice predicate. Every slice used to take the pointer
   cursor whenever the caller passed an onClick, including the ones whose
   handler had no destination for that label — on #roster three of six slices
   navigated and three, covering 51% of the ring, did nothing while inviting
   the click. A slice with nowhere to go keeps the hover tooltip and loses the
   pointer. */
/* `max` defaults to CAT.length − 1, not CAT.length.
   ─────────────────────────────────────────────────────────────────────────
   At 8 the folded tail made a NINTH entry, and CAT[8 % 8] is CAT[0] — so
   "Other (11)" was drawn in exactly the colour of the largest slice, and the
   legend printed the same swatch twice with two different numbers beside it.
   Verified by evaluating the expression. Seven categories plus the fold is
   eight marks, which is what the palette has. */
export function donut(host, data, { label = 'label', value = 'n', onClick,
  max = CAT.length - 1, colorFor = null, clickable = null, aria = null } = {}) {
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
  const svg = name(mk('svg', { viewBox: `0 0 ${S} ${S}`, class: 'donut', style: 'margin:0 auto;display:block' }), aria);
  let a0 = -Math.PI / 2;
  shown.forEach((d, i) => {
    const frac = +d[value] / tot, a1 = a0 + frac * Math.PI * 2;
    /* A separator in PIXELS, not in radians.
       The gap was a constant 0.016 rad trimmed off both ends, which is nothing
       on a large slice and everything on a small one: a 0.4% slice spans about
       0.025 rad and lost 0.032 to the trim, so it collapsed to a zero-width
       sliver — invisible on the ring while still carrying a real number in the
       legend. A hairline stroke in the panel colour separates the arcs without
       taking any of their sweep. */
    const p = arc(cx, cy, r, ir, a0, a1);
    /* The fold is not a category and must not take a category's colour. */
    const fillVar = d._tail ? '--ink-3' : (colorFor && colorFor(d, i)) || CAT[i % CAT.length];
    const path = mk('path', { d: p, fill: `var(${fillVar})`,
      stroke: 'var(--surface)', 'stroke-width': 1.5, 'data-fade': '' });
    interactive(path, `${esc(d[label])} — <b>${fmt(d[value])}</b> (${(frac * 100).toFixed(1)}%)${
      d._tail ? `<br><span style="opacity:.8">${esc(d._tail.slice(0, 10).join(' · '))}</span>` : ''}`,
    onClick && !d._tail && (!clickable || clickable(d)) && (() => onClick(d)));
    svg.append(path); a0 = a1;
  });
  svg.append(txt(cx, cy - 2, fmt(tot), 'vlab', 'middle', 'font-size:19px;font-weight:600;fill:var(--ink)'),
    txt(cx, cy + 14, 'total', 'axis', 'middle'));
  /* The ring beside its own key, rather than above a single line of swatches.
     ─────────────────────────────────────────────────────────────────────────
     A 190px ring centred in a 1,132px panel with one line of text under it
     leaves nine hundred pixels of nothing, and the day page carried two of
     them one under the other. The space was not merely empty, it was
     information the chart already had and did not print: a legend reading
     "Uber · 487" makes the reader divide by the total in their head, and the
     share was only ever available by hovering — which a touch screen cannot
     do at all.

     So the key is a column beside the ring, and each row carries the count,
     the share, and a bar of that share. `flex-wrap` puts it back underneath
     when the host is narrow, which is what happens inside a three-up grid and
     on a phone, so nothing has to know how wide its container is. */
  const wrap = document.createElement('div'); wrap.className = 'dnut';
  wrap.append(svg);
  const leg = document.createElement('div'); leg.className = 'legend dnut-keys';
  // The legend reads the SAME expression the ring did, so a swatch can never
  // name a colour the arc beside it is not drawn in.
  const swatchOf = (d, i) => (d._tail ? '--ink-3' : (colorFor && colorFor(d, i)) || CAT[i % CAT.length]);
  leg.innerHTML = shown.map((d, i) => {
    const share = (+d[value] / tot) * 100;
    /* One decimal below ten per cent, none above: "42.7%" and "3.1%" both read
       at a glance, "42.68%" does not, and a slice under a tenth of a per cent
       reads "<0.1%" rather than rounding to a zero it is not. */
    const pc = share < 0.05 ? '<0.1%' : `${share.toFixed(share < 10 ? 1 : 0)}%`;
    /* The tooltip sits on the LABEL, not on the row: the row is
       `display:contents` so it has no box of its own to hover. */
    const t = d._tail ? ` title="${esc(d._tail.slice(0, 10).join(' · '))}"` : '';
    return '<span class="dk">'
      + `<i class="sw" style="background:var(${swatchOf(d, i)})"></i>`
      + `<span class="dk-l"${t}>${esc(d[label])}</span>`
      + `<span class="dk-t"><span class="dk-f" style="width:${Math.max(share, 0.6).toFixed(1)}%;`
      + `background:var(${swatchOf(d, i)})"></span></span>`
      + `<b class="num dk-n">${fmt(d[value])}</b>`
      + `<span class="num dk-p">${pc}</span></span>`;
  }).join('');
  wrap.append(leg);
  host.append(wrap);
}

/* ── horizontal bars (ranking) ── */
/* Signed, because these series carry deductions.
   ─────────────────────────────────────────────────────────────────────────
   The width was `value / max * 100` with `max` the largest SIGNED value, so a
   negative amount emitted `width:-88.6%` — CSS discards an invalid declaration
   and the `.fill` then filled its whole track. On #revenue the AED −10,248
   cash clawback drew 886px of bar beside the AED +33,905 earnings bar at
   899px: the biggest deduction in the payout rendered as the second-largest
   credit. Scaling against max(|value|) and colouring the negatives separately
   makes the same numbers read as what they are. `signed:false` keeps the old
   magnitude behaviour for series that genuinely cannot go below zero. */
/* One hue, unless a caller says otherwise.
   ─────────────────────────────────────────────────────────────────────────
   This drew a RANKING in eight categorical colours that recycled at row nine,
   so a twelve-row list of corridors had rows 1 and 9 in the same hue while the
   colour itself encoded nothing at all — bar length already carries the
   magnitude, and a second channel that says nothing reads as a grouping that
   is not there. `categorical: true` is the opt-in for the rare series whose
   rows genuinely are unordered kinds. */
export function hbars(host, data, { label = 'label', value = 'n', color, seq = false, onClick,
  valueFmt = (v) => fmt(v), signed = true, negColor = '--s2', legend = null,
  categorical = false,
  /* Per-row colour, for the one case where hue carries a fact rather than
     decoration: a row that IS a channel is drawn in that channel's colour.
     Returns a token name, or nothing to fall through to the rules below. */
  colorFor = null,
  // A row may opt out of navigation individually — see `donut`, same reason.
  clickable = null } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const vals = data.map((d) => +d[value] || 0);
  const anyNeg = signed && vals.some((v) => v < 0);
  const max = Math.max(...vals.map((v) => (anyNeg ? Math.abs(v) : v)), 0) || 1;
  const wrap = document.createElement('div'); wrap.className = 'hbars';
  data.forEach((d, i) => {
    const v = +d[value] || 0;
    const neg = anyNeg && v < 0;
    const row = document.createElement('div'); row.className = 'hb';
    /* The ramp must span the ROWS. `SEQ[Math.max(6 - i, 2)]` walked down four
       steps and then stuck: a fourteen-row list came out b700 b600 b500 b400
       and then ten identical b300s, which is a ramp that stops ramping exactly
       where the reader is still looking. */
    const ramp = SEQ[Math.min(6, Math.max(2,
      Math.round((1 - i / Math.max(data.length - 1, 1)) * 6)))];
    const own = colorFor && colorFor(d, i);
    const c = neg ? `var(${negColor})`
      : own ? `var(${own})`
        : color ? `var(${color})`
          : seq ? `var(${ramp})`
            : categorical ? `var(${CAT[i % CAT.length]})` : 'var(--b400)';
    /* A true zero draws no bar. `min-width:2px` in the stylesheet gave zero the
       same stub as a value too small to see. */
    const w = v === 0 ? 0 : Math.max(Math.min(100, Math.abs(v) / max * 100), 0.6);
    row.innerHTML = `<div class="k" title="${esc(d[label])}">${esc(d[label])}</div>
      <div class="track"><div class="fill${neg ? ' neg' : ''}" style="width:${w.toFixed(1)}%;background:${c}"></div></div>
      <div class="v num">${v === 0 ? '0' : `${neg ? '−' : ''}${valueFmt(Math.abs(v))}`}</div>`;
    const go = onClick && (!clickable || clickable(d)) ? () => onClick(d) : null;
    /* The stylesheet has styled `.hb[data-click]` — cursor, the hover ring on
       the label and track, the active press — since these rows became
       clickable, and nothing ever set the attribute, so four rules matched
       nothing and every clickable row was missing its whole hover state. */
    if (go) { row.setAttribute('data-click', ''); row.tabIndex = 0; row.setAttribute('role', 'button'); }
    interactive(row, `${esc(d[label])} — <b>${neg ? '−' : ''}${valueFmt(Math.abs(v))}</b>`, go);
    wrap.append(row);
  });
  host.append(wrap);
  if (anyNeg || legend) {
    const leg = document.createElement('div'); leg.className = 'legend';
    leg.innerHTML = (legend || [['--b400', 'added'], [negColor, 'deducted']])
      .map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${esc(t)}</span>`).join('');
    host.append(leg);
  }
}

/* ── heatmap (day-of-week × hour) ── */
/* `unit` and `valueFmt`, because this grid is drawn twice with two different
   measures. #capacity plots DRIVERS NEEDED and every tooltip still read
   "— 28.6 trips", contradicting the caption directly beneath it. And the scale
   is stated: the shading is normalised to each window's own maximum, so the
   same cell darkens when the range narrows, and without a legend the reader
   has no way to know the colours are relative rather than absolute. Zero and
   never-seen were shaded identically; they are now a distinct empty cell and
   a legend entry of their own. */
export function heatmap(host, rows, { onClick, unit = 'trips',
  valueFmt = (v) => fmt(v), legend = true, aria = null } = {}) {
  host.innerHTML = '';
  if (!rows.length) return empty(host);
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const grid = {}; let max = 0;
  rows.forEach((r) => { grid[`${r.dow}-${r.h}`] = r.trips; max = Math.max(max, +r.trips || 0); });
  const W = 760, cell = 26, lw = 40, H = 7 * cell + 26;
  const svg = name(mk('svg', { viewBox: `0 0 ${W} ${H}` }), aria);
  for (let d = 0; d < 7; d++) {
    svg.append(txt(lw - 8, d * cell + 17, DOW[d], 'axis', 'end'));
    for (let h = 0; h < 24; h++) {
      const raw = grid[`${d}-${h}`];
      const seen = raw != null;
      const v = +raw || 0, w = (W - lw - 8) / 24;
      const idx = v === 0 ? -1 : Math.min(6, Math.floor(v / (max || 1) * 6.99));
      const rect = mk('rect', {
        x: lw + h * w, y: d * cell + 3, width: w - 2, height: cell - 4, rx: 2,
        fill: idx < 0 ? 'var(--surface-2)' : `var(${SEQ[idx]})`,
        ...(idx < 0 ? { stroke: 'var(--rule)', 'stroke-width': 1 } : {}),
      });
      interactive(rect, `${DOW[d]} ${String(h).padStart(2, '0')}:00 — `
        + (seen ? `<b>${valueFmt(v)}</b> ${esc(unit)}` : `<b>nothing recorded</b> in this hour`),
        onClick && (() => onClick({ dow: d, h, trips: v })));
      svg.append(rect);
    }
  }
  [0, 4, 8, 12, 16, 20, 23].forEach((h) => svg.append(txt(lw + h * ((W - lw - 8) / 24) + 6, H - 6, String(h).padStart(2, '0'), 'axis', 'middle')));
  host.append(svg);
  if (legend) {
    const buckets = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const lo = (max * i) / 7, hi = (max * (i + 1)) / 7;
      return `<span title="${valueFmt(lo)} – ${valueFmt(hi)} ${esc(unit)}">`
        + `<i class="sw" style="background:var(${SEQ[i]})"></i>${i === 6 ? valueFmt(max) : ''}</span>`;
    }).join('');
    const leg = document.createElement('div'); leg.className = 'legend';
    leg.innerHTML = `<span><i class="sw" style="background:var(--surface-2);border:1px solid var(--rule)"></i>none</span>`
      + `<span class="dim">0</span>${buckets}`
      + `<span class="dim">${esc(unit)} — shaded against this window's own busiest hour `
      + `(${valueFmt(max)}), so the colours are relative and not comparable between ranges.</span>`;
    host.append(leg);
  }
}

/* ── scatter (two measures per entity) ── */
/* `yLabel` was accepted, used in the tooltip, and never drawn.
   ─────────────────────────────────────────────────────────────────────────
   #unit passes yLabel 'money in (AED)' and the y axis was a bare column of
   numbers. `refLine` is the other half of the same omission: that page's
   caption tells the reader "a dot well below that line is doing distance that
   is not being paid for", and this function drew no line of any kind. A
   caption that names a mark the chart does not draw is worse than no caption.

   The axes were also rounded to integers — `fmt(Math.round(ymax * i / 3))` —
   which areaChart fixed for itself and nobody carried here, so a fleet with
   sub-1 AED/km rates read "0 / 0 / 1 / 1" up the side. */
export function scatter(host, data, { x, y, label, xLabel, yLabel, onClick,
  xFmt = (v) => fmt(v), yFmt = (v) => fmt(v), refLine = null, aria = null } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const W = 720, H = 280, pl = 52, pr = 16, pt = 16, pb = 40;
  const xs = data.map((d) => +d[x]), ys = data.map((d) => +d[y]);
  /* Guarded against a single non-finite value.
     `Math.max(...xs)` over an array holding one NaN is NaN; NaN * 1.1 is NaN;
     `NaN || 1` is 1 — and every dot then has cx = NaN, so the whole chart
     silently draws nothing at all. Two call sites already work around this in
     their own arguments, which is how a library announces a missing guard. */
  const fin = (a) => a.filter(Number.isFinite);
  const xmax = (Math.max(...fin(xs), 0) || 1) * 1.1;
  const ymax = (Math.max(...fin(ys), 0) || 1) * 1.1;
  const iw = W - pl - pr, ih = H - pt - pb;
  const svg = name(mk('svg', { viewBox: `0 0 ${W} ${H}` }), aria);
  const { max: yTop } = yAxis(svg, { hi: ymax, pl, pr, pt, ih, W, fmt: yFmt });
  /* Vertical gridlines too. The x tick VALUES were printed with nothing above
     them, so reading a dot's x meant tracing across empty space. */
  const xMarks = niceTicks(0, xmax, 4);
  const xTop = xMarks[xMarks.length - 1] || 1;
  xMarks.forEach((v) => {
    const gx = pl + iw * (v / xTop);
    svg.append(mk('line', { class: 'gl', x1: gx, y1: pt, x2: gx, y2: pt + ih }),
      txt(gx, H - 22, xFmt(v), 'axis', 'middle'));
  });
  // The line the caller's own caption promises, when it supplies the slope.
  if (refLine && Number.isFinite(+refLine.slope)) {
    svg.append(mk('line', { x1: pl, y1: pt + ih,
      x2: pl + iw, y2: pt + ih - ih * Math.min(1, (xTop * +refLine.slope) / yTop),
      stroke: 'var(--ink-3)', 'stroke-width': 1, 'stroke-dasharray': '4 3' }));
  }
  data.forEach((d) => {
    if (!Number.isFinite(+d[x]) || !Number.isFinite(+d[y])) return;
    const cx = pl + iw * (+d[x]) / xTop, cy = pt + ih - ih * (+d[y]) / yTop;
    const c = mk('circle', { cx, cy, r: 4.5, fill: 'var(--s1)', 'fill-opacity': .6, stroke: 'var(--surface)', 'stroke-width': 1.5 });
    interactive(c, `${esc(d[label])} — ${xLabel}: <b>${xFmt(d[x])}</b>, ${yLabel}: <b>${yFmt(d[y])}</b>`, onClick && (() => onClick(d)));
    svg.append(c);
  });
  svg.append(txt(pl + iw / 2, H - 8, xLabel, 'axis', 'middle'));
  if (yLabel) {
    const yt = txt(0, 0, yLabel, 'axis', 'middle');
    yt.setAttribute('transform', `translate(13,${pt + ih / 2}) rotate(-90)`);
    svg.append(yt);
  }
  host.append(svg);
}

/* ── stacked bar (one row, composition) ── */
/* One bar divided, not a row of pills.
   ─────────────────────────────────────────────────────────────────────────
   Every segment carried rx:2 and a 1px gap either side, so a composition bar —
   whose whole job is to look like ONE thing cut up — read as a line of
   separate chips. The outer corners are rounded once, by a clip path, and the
   internal boundaries are hairlines in the panel colour.

   Two arithmetic guards, both of which produced a plausible wrong picture. A
   null value made `+d[value] / tot * W` NaN, so the segment vanished with
   width="NaN" while the remaining segments still filled the bar — a class
   silently dropped and the rest renormalised to 100%, which is exactly the
   failure the Overview's own comment describes. And a segment under 1.5% drew
   a hairline nobody can point at while still taking a full legend entry with a
   real number beside it; those fold into a trailing Other, as donut folds its
   tail, and the fold is neutral because it is not a category. */
export function stackedBar(host, data, { label = 'label', value = 'n', onClick,
  clickable = null, valueFmt = (v) => fmt(v), colorFor = null, aria = null } = {}) {
  host.innerHTML = '';
  if (!data.length) return empty(host);
  const num = (d) => (Number.isFinite(+d[value]) ? +d[value] : 0);
  const tot0 = data.reduce((a, d) => a + num(d), 0) || 1;
  const big = data.filter((d) => num(d) / tot0 >= 0.015);
  const small = data.filter((d) => num(d) / tot0 < 0.015 && num(d) > 0);
  const rows = small.length
    ? [...big, { [label]: `Other (${small.length})`, [value]: small.reduce((a, d) => a + num(d), 0),
      _tail: small.map((d) => `${d[label]} ${fmt(num(d))}`) }]
    : big;
  const tot = rows.reduce((a, d) => a + num(d), 0) || 1;
  const W = 400, H = 30, R = 5; let x = 0;
  const svg = name(mk('svg', { viewBox: `0 0 ${W} ${H}` }), aria);
  const cid = 'sb' + Math.random().toString(36).slice(2, 7);
  const defs = mk('defs'), cp = mk('clipPath', { id: cid });
  cp.append(mk('rect', { x: 0, y: 0, width: W, height: H, rx: R }));
  defs.append(cp); svg.append(defs);
  const g = mk('g', { 'clip-path': `url(#${cid})` });
  const swatchOf = (d, i) => (d._tail ? '--ink-3' : (colorFor && colorFor(d, i)) || CAT[i % CAT.length]);
  rows.forEach((d, i) => {
    const w = num(d) / tot * W, pct = num(d) / tot * 100;
    const r = mk('rect', { x, y: 0, width: w, height: H, fill: `var(${swatchOf(d, i)})`,
      stroke: 'var(--surface)', 'stroke-width': 1.5, 'data-fade': '' });
    interactive(r, `${esc(d[label])} — <b>${valueFmt(num(d))}</b> (${pct.toFixed(1)}%)`
      + (d._tail ? `<br><span style="opacity:.8">${esc(d._tail.slice(0, 10).join(' · '))}</span>` : ''),
    onClick && !d._tail && (!clickable || clickable(d)) && (() => onClick(d)));
    g.append(r);
    /* The share, on the bar, where a segment is wide enough to hold it.
       Sized in VIEWBOX units against the panel it will be scaled into: this is
       a 400-unit box drawn at about 310px, so `vlab`'s 10px arrives as 7.75px
       — smaller than any other text on the page and not worth printing. 14
       lands at about 11px. */
    if (pct >= 12) {
      g.append(txt(x + w / 2, H / 2 + 5, `${pct.toFixed(0)}%`, 'vlab', 'middle',
        'fill:var(--surface);font-weight:600;font-size:14px'));
    }
    x += w;
  });
  svg.append(g);
  host.append(svg);
  const leg = document.createElement('div'); leg.className = 'legend';
  leg.innerHTML = rows.map((d, i) => `<span><i class="sw" style="background:var(${swatchOf(d, i)})"></i>${esc(d[label])} · <b class="num">${(num(d) / tot * 100).toFixed(1)}%</b></span>`).join('');
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
    if (Number.isNaN(d.getTime())) return s;
    const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: TZ });
    /* An axis label carries its year when it is not this year. Over a
       twelve-month window the axis read "Aug 25 … Aug 25" — the first and last
       tick identical, a year apart — which makes a trend chart unreadable in
       the one range where the trend is the point. Apostrophised rather than
       spelled out, because a 12-tick axis has about ten characters per label. */
    const y = d.toLocaleDateString('en-CA', { year: 'numeric', timeZone: TZ });
    const now = new Date().toLocaleDateString('en-CA', { year: 'numeric', timeZone: TZ });
    return y === now ? day : `${day} ’${y.slice(2)}`;
  }
  return s.length > 11 ? s.slice(0, 10) + '…' : s;
}
/* `msg` is TEXT. It was interpolated into innerHTML, so #slot/9/99 printed its
   own syntax help with the syntax removed — "A slot address is #slot//." —
   because `<weekday 0-6>` and `<hour 0-23>` parsed as unknown elements. Any
   caller that genuinely needs markup passes `html: true` and owns the escaping. */
export function empty(host, msg = 'No data for this range yet', { html = false } = {}) {
  // Callers reach here after loading() has filled the host with a skeleton.
  // Appending without clearing left a forever-shimmering "Loading…" bar sitting
  // on top of the empty state.
  host.innerHTML = '';
  const d = document.createElement('div'); d.className = 'empty';
  d.innerHTML = `<b>Nothing to show</b>${html ? msg : esc(msg)}`;
  host.append(d); return d;
}
