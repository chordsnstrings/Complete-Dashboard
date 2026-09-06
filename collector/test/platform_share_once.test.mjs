/* One fact, drawn once, and the picture is the control.
   ─────────────────────────────────────────────────────────────────────────
   #platforms opened with a dominance bar and, a hand's width below it, a
   donut — both over the same byPlat, in the same window, on the same screen.
   Two pictures of one number is not redundancy a reader can ignore: they have
   to look at both to discover they say the same thing.

   The bar is the better telling. This fleet is about 91% one channel, which a
   full-width bar shows at a glance and a donut turns into a comparison of arc
   lengths. But the DONUT was the only one that could be clicked, and the bar's
   own caption read "click a slice below" — pointing the reader past the better
   picture at the one that happened to work. So the duplicate could not simply
   be deleted; the bar had to become the control first.

   What is asserted here is the whole of that: the split is drawn once, the
   thing that draws it is operable by mouse and by keyboard, and using it
   actually filters the dashboard. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const { app: mockApp } = await import('../mockapi.mjs');
const shell = express();
shell.use(express.static('api/public'));
shell.use(mockApp);
const server = shell.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 140)));

const open = async (hash) => {
  await page.goto(`${base}/?ui=desktop`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch { /* private mode */ } });
  await page.goto(`${base}/?ui=desktop${hash}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    /* eslint-disable no-await-in-loop */
    if (await page.evaluate(() => !!document.querySelector('.domb-bar'))) break;
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(700);
};

await open('#platforms');

console.log('\nthe channel split is drawn once');

const drawn = await page.evaluate(() => {
  const bars = document.querySelectorAll('.domb-bar').length;
  /* Every donut on the page, with the labels it draws, so "is one of these the
     channel split again" is answered by what is in it rather than by counting
     charts — the fleet donut beside it is a different question and must stay. */
  const donuts = [...document.querySelectorAll('svg.donut')].map((d) => ({
    aria: d.getAttribute('aria-label') || '',
    near: d.closest('.panel')?.querySelector('h3')?.textContent || '',
  }));
  return { bars, donuts };
});
check('the dominance bar is there', drawn.bars === 1, JSON.stringify(drawn));
/* By what it is ABOUT, not by how many charts there are. A donut of the two
   FLEETS answers a different question and belongs on this page. */
const channelDonut = drawn.donuts.filter((d) => /channel|platform/i.test(d.aria + d.near));
check('and no chart on the page draws the channel split a second time',
  channelDonut.length === 0, JSON.stringify(drawn.donuts));

console.log('\nthe picture is the control');

const control = await page.evaluate(() => {
  const segs = [...document.querySelectorAll('.domb-seg')];
  const keys = [...document.querySelectorAll('.domb-key')];
  return {
    segs: segs.map((s) => s.tagName),
    keys: keys.map((k) => k.tagName),
    /* A span with a click handler is not reachable by keyboard; a button is.
       This is the half of "clickable" that is usually skipped. */
    focusable: segs.filter((s) => s.tabIndex >= 0).length,
    caption: document.querySelector('.domb-total')?.textContent || '',
  };
});
check('every segment is a real button', control.segs.length > 0
  && control.segs.every((t) => t === 'BUTTON'), JSON.stringify(control.segs));
check('…so every segment is reachable from the keyboard',
  control.focusable === control.segs.length, `${control.focusable} of ${control.segs.length}`);
/* The key list matters more than the bar on this fleet: at 91% on one channel
   every other segment is a sliver a few pixels wide. */
check('the key beside each channel is a button too', control.keys.length > 0
  && control.keys.every((t) => t === 'BUTTON'), JSON.stringify(control.keys));
check('and the caption no longer sends the reader somewhere else',
  !/below/i.test(control.caption), control.caption);

console.log('\nand using it filters the dashboard');

const before = await page.evaluate(() => location.hash);
await page.evaluate(() => document.querySelectorAll('.domb-seg')[0].click());
await page.waitForTimeout(1200);
const after = await page.evaluate(() => location.hash);
check('choosing a channel narrows the whole dashboard to it',
  /platform=/.test(after) && after !== before, `${before} → ${after}`);

check('the page raised no errors doing any of it', errors.length === 0, errors.join(' | '));

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
