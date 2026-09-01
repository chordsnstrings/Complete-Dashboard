/* A caption telling the reader to scroll a table that does not scroll.
   ─────────────────────────────────────────────────────────────────────────
   A wide table gets two cues: a fade at whichever end has content beyond it,
   and a caption NAMING the columns that are cut — which is the part a fade
   cannot do, because "Δ bank − expected" is a number somebody came to the page
   for and a gradient does not tell them it exists.

   The fade was recomputed on scroll and on resize. The caption was written
   once, inside a single requestAnimationFrame, and appended for good. So the
   two disagreed the moment a layout settled after that frame — and on
   production #compare's By channel panel carried

       "Scroll the table sideways for one more column: Money."

   under a table measuring scrollWidth 660 against clientWidth 660. Nothing
   hidden, nothing to scroll, and a sentence telling a reader that a figure
   they could plainly see was out of reach.

   Any table can reach that state: a chart above it finishing layout, a filter
   widening the grid, a window resized, a sibling panel collapsing. The
   assertions below are the two directions of it. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 520, height: 700 } });
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

/* A twelve-column table in a box narrow enough to cut it. Built through the
   real tableFrom so the cue is the product's own, not a copy. */
await page.evaluate(async () => {
  const ui = await import('/ui.js');
  const host = document.createElement('div');
  host.id = 'cuehost';
  host.style.width = '320px';
  document.body.append(host);
  const cols = Array.from({ length: 12 }, (_, i) => ({
    label: `Column number ${i + 1}`, key: `c${i}`, num: true,
  }));
  const rows = Array.from({ length: 6 }, (_, r) =>
    Object.fromEntries(cols.map((c, i) => [c.key, (r + 1) * 1000 + i])));
  host.append(ui.tableFrom(rows, cols));
});
const cue = () => page.evaluate(() =>
  document.querySelector('#cuehost .tcue')?.textContent || null);
const fits = () => page.evaluate(() => {
  const w = document.querySelector('#cuehost .tscroll, #cuehost [class*=scroll]')
    || document.querySelector('#cuehost table')?.parentElement;
  return w ? w.scrollWidth - w.clientWidth <= 2 : null;
});

await page.waitForTimeout(400);
console.log('\nscroll cue: a table too wide for its box says so');
check('the table really is cut at 320px', (await fits()) === false, String(await fits()));
const first = await cue();
check('…and the caption names the columns that are cut', /Scroll the table sideways/.test(first || ''), String(first));

/* Widen the box past the table's natural width. The fade goes; the caption
   used to stay, which is the whole bug. */
console.log('\nscroll cue: and stops saying so when it stops being cut');
await page.evaluate(() => { document.querySelector('#cuehost').style.width = '3000px'; });
await page.waitForTimeout(500);
check('the table now fits', (await fits()) === true, String(await fits()));
check('…and the caption is gone, not left behind', (await cue()) == null, String(await cue()));

/* And back again, because a cue that can never return is the same defect
   pointing the other way. */
console.log('\nscroll cue: and says so again when it is cut again');
await page.evaluate(() => { document.querySelector('#cuehost').style.width = '300px'; });
await page.waitForTimeout(500);
check('the table is cut again', (await fits()) === false, String(await fits()));
check('…and the caption came back', /Scroll the table sideways/.test((await cue()) || ''), String(await cue()));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
