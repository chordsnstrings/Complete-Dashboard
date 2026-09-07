/* A chart is drawn at the size it will be seen at, and nothing paints outside it.
   ─────────────────────────────────────────────────────────────────────────
   Every chart in this product used a fixed viewBox of "0 0 720 240" and
   app.css stretched it with width:100%. On a 1440px window the day page's
   panel is 1090px wide, so the drawing was scaled by 1.514 — and an SVG scales
   its TEXT with its geometry. Axis labels declared at --t2 (about 10.1px)
   painted at 15.3px. Every gridline, stroke and label on the page was half
   again the size it was designed at, and in a narrow column the same rule made
   everything too small. That is most of what "the charts look ghastly" meant.

   The second half was the gutter. yAxis draws its label anchored `end` at
   pl - 7, and pl was the constant 46, so any tick string wider than 39 units
   began at a negative x. api/public/day.js passed one formatter for both the
   tooltip and the axis — `(v) => `${fmt(v)} bookings`` — so the gridlines read
   "10 bookings", about 70 units wide, starting at x = -31. app.css sets
   overflow:visible on chart svgs, so instead of being clipped it painted over
   the panel's edge: four labels spilling 12-21px past the panel at 1440, and
   again at 1024.

   Both are geometry, so both are asserted by measuring a real browser rather
   than by reading the source. A test that greps charts.js for `chartBox` would
   pass on a chart that still stretched. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();

/* Three widths, because the defect is a RATIO and a single width cannot show
   one: a chart that happens to be drawn at its host's width once may still be
   stretched everywhere else. */
for (const hostPx of [1090, 685, 320]) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(async (w) => {
    const charts = await import('/charts.js');
    document.querySelectorAll('.probe').forEach((e) => e.remove());
    const host = document.createElement('div');
    host.className = 'probe';
    host.style.width = `${w}px`;
    document.body.append(host);

    /* A unit-bearing formatter, which is what the day page passes and what put
       "10 bookings" up the side of the chart. */
    charts.barChart(host, [
      { hour: 0, bookings: 12 }, { hour: 1, bookings: 8 }, { hour: 2, bookings: 25 },
      { hour: 3, bookings: 3 }, { hour: 4, bookings: 0 }, { hour: 5, bookings: 19 },
    ], { x: 'hour', y: 'bookings', valueFmt: (v) => `${v} bookings` });

    const svg = host.querySelector('svg');
    const box = svg.getBoundingClientRect();
    const vb = (svg.getAttribute('viewBox') || '').split(/\s+/).map(Number);
    const hostBox = host.getBoundingClientRect();
    const ticks = [...svg.querySelectorAll('text.axis')];
    /* The widest label's left edge against the chart's own left edge. */
    let worst = 0;
    ticks.forEach((t) => {
      const r = t.getBoundingClientRect();
      worst = Math.max(worst, box.left - r.left, r.right - box.right);
    });
    return {
      host: Math.round(hostBox.width),
      rendered: Math.round(box.width),
      viewBoxW: vb[2], viewBoxH: vb[3],
      scale: +(box.width / (vb[2] || 1)).toFixed(3),
      renderedH: Math.round(box.height),
      tickText: ticks.map((t) => t.textContent),
      worstOverflow: Math.round(worst),
    };
  }, hostPx);

  console.log(`\n── a ${hostPx}px column ──`);
  /* THE ASSERTION THIS FILE EXISTS FOR. Scale 1 means a 10px label is 10px. */
  check('the chart is drawn at the width it is shown at',
    Math.abs(out.scale - 1) < 0.02, JSON.stringify(out));
  check('…so its viewBox matches its host rather than a fixed 720',
    Math.abs(out.viewBoxW - out.host) <= 2, `viewBox ${out.viewBoxW} against host ${out.host}`);
  /* Height follows width, so a chart in a third of a row is not as tall as one
     across the whole page. */
  check('…and the height follows the width instead of being fixed',
    out.viewBoxH >= 190 && out.viewBoxH <= 340, String(out.viewBoxH));
  check('no axis label paints outside the chart',
    out.worstOverflow <= 1, `${out.worstOverflow}px  ${JSON.stringify(out.tickText)}`);
  /* The unit belongs on the tooltip, once, not on four gridlines. */
  check('the axis says the number, not the number and the unit four times',
    out.tickText.every((t) => !/bookings/.test(t)), JSON.stringify(out.tickText));
  await page.close();
}

console.log('\n── a formatter whose labels are genuinely wide still fits ──');
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  const out = await page.evaluate(async () => {
    const charts = await import('/charts.js');
    const host = document.createElement('div');
    host.style.width = '900px';
    document.body.append(host);
    /* Money on the axis is legitimate — "1,240" and "AED 1,240" are different
       claims — so the gutter has to grow for it rather than the label being
       cut or the caller being told not to. */
    charts.barChart(host, [{ d: 'a', v: 128000 }, { d: 'b', v: 64000 }],
      { x: 'd', y: 'v', axisFmt: (v) => `AED ${v.toLocaleString()}` });
    const svg = host.querySelector('svg');
    const box = svg.getBoundingClientRect();
    let worst = 0;
    const ticks = [...svg.querySelectorAll('text.axis')];
    ticks.forEach((t) => { const r = t.getBoundingClientRect();
      worst = Math.max(worst, box.left - r.left); });
    return { labels: ticks.map((t) => t.textContent), worst: Math.round(worst) };
  });
  check('a money axis keeps its currency', out.labels.some((t) => /AED/.test(t)),
    JSON.stringify(out.labels));
  check('…and still fits inside the chart', out.worst <= 1, `${out.worst}px`);
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
