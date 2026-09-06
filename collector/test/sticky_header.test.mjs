/* A column heading that has never once stayed put.
   ─────────────────────────────────────────────────────────────────────────
   app.css has said `thead th { position:sticky; top:0 }` for as long as there
   have been tables in this product, and it had never engaged. The reason is a
   rule nobody says out loud: .tscroll sets `overflow-x:auto` so a wide table
   can be scrolled sideways, and CSS resolves the other axis of a non-visible
   overflow to `auto` as well — so .tscroll, and not the page, is the scrollport
   a sticky heading sticks inside. Given no height it is exactly as tall as its
   table and never scrolls a pixel, so the heading sat at the top of a box that
   never moved while the PAGE carried the whole thing off screen.

   Measured with a browser on #drivers before the fix: scrollHeight 1568 ===
   clientHeight 1568, and the first `th` travelled from 892px down the viewport
   to −939px. Four hundred and thirty-four rows of driver, and the reader loses
   the names of the columns after about twenty.

   What is asserted here is the BEHAVIOUR, not the declaration. A test that
   greps app.css for `position:sticky` would have passed every day of that
   history. So: build a long table through the product's own tableFrom, and ask
   the browser whether the heading holds its place while the rows move under
   it. Then build a short one and ask that it does NOT get a scrollport, since
   a nested scroll region inside a scrolling page is a real annoyance and most
   tables here are folded to twelve rows. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

const build = (rows) => page.evaluate(async (n) => {
  const ui = await import('/ui.js');
  document.querySelectorAll('.probe').forEach((e) => e.remove());
  const host = document.createElement('div');
  host.className = 'probe';
  document.body.append(host);
  const cols = [{ label: 'Driver', key: 'name' }, { label: 'Trips', key: 'trips', num: true }];
  const data = Array.from({ length: n }, (_, i) => ({ name: `Person ${i + 1}`, trips: i }));
  host.append(ui.tableFrom(data, cols));
  ui.markTallTables(host);
  const box = host.querySelector('.tscroll');
  return { tall: box.classList.contains('tall'), maxH: getComputedStyle(box).maxHeight };
}, rows);

console.log('\na table long enough to lose its headings gets a scrollport');

const long = await build(60);
check('sixty rows is marked tall', long.tall === true, JSON.stringify(long));
check('…and that is a real height, not "none"', long.maxH !== 'none' && /px$/.test(long.maxH), long.maxH);

/* THE ASSERTION THIS FILE EXISTS FOR: the heading holds its own place inside
   the box while the rows scroll under it. Measured as the th's offset from the
   top of its scrollport — sticky means that offset does not change. */
const held = await page.evaluate(async () => {
  const box = document.querySelector('.probe .tscroll');
  const th = box.querySelector('thead th');
  const off = () => Math.round(th.getBoundingClientRect().top - box.getBoundingClientRect().top);
  const before = off();
  box.scrollTop = Math.round(box.scrollHeight * 0.6);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return { before, after: off(), scrolled: box.scrollTop, moved: box.scrollTop > 0 };
});
check('the box actually scrolls', held.moved === true, JSON.stringify(held));
check('and the column heading stays at the top of it while the rows move',
  Math.abs(held.after - held.before) <= 1, JSON.stringify(held));

console.log('\na short table is left alone');

const short = await build(8);
check('eight rows is not marked tall', short.tall === false, JSON.stringify(short));
check('…and keeps no max-height, so there is no scrollbar inside the page',
  short.maxH === 'none', short.maxH);

console.log('\nopening a fold turns the headings on, shutting it turns them off');

const folded = await page.evaluate(async () => {
  const ui = await import('/ui.js');
  document.querySelectorAll('.probe').forEach((e) => e.remove());
  const host = document.createElement('div');
  host.className = 'probe';
  document.body.append(host);
  const cols = [{ label: 'Driver', key: 'name' }];
  const data = Array.from({ length: 80 }, (_, i) => ({ name: `Person ${i + 1}` }));
  /* Through foldRows, because the fold is how every long table in this product
     is actually presented — twelve rows and a control. The heading matters at
     the moment the reader opens the long form, and not before. */
  ui.foldRows(host, ui.tableFrom(data, cols), { shown: 12, total: 80, noun: 'driver' });
  const box = host.querySelector('.tscroll');
  const btn = host.querySelector('button.foldbtn');
  const shut = box.classList.contains('tall');
  btn.click();
  const open = box.classList.contains('tall');
  btn.click();
  return { shut, open, shutAgain: box.classList.contains('tall'), rows: 80 };
});
check('folded to twelve, no scrollport', folded.shut === false, JSON.stringify(folded));
check('opened to eighty, the headings follow the reader', folded.open === true, JSON.stringify(folded));
check('shut again, the scrollport goes away', folded.shutAgain === false, JSON.stringify(folded));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
