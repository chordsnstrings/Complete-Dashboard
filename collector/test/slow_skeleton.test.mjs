/* ── a skeleton that has been a skeleton for eleven seconds ────────────────
   `.skel` is a 13px shimmer bar. That is right for the ordinary wait — under a
   second, and a label would be noise — and wrong for the two panels on
   #sources that are not ordinary. /api/coverage groups the entire trip history
   with no window at all; its own warmer comment calls it a twenty-second query
   and names it as the cause of a 504 on that page. Eleven seconds of an
   anonymous grey bar is indistinguishable from a panel that will never fill,
   and the render audit could not tell them apart either — it reported
   `stuck-loading` on a page that was merely slow.

   #sources had already hand-rolled the fix for its field inventory: a
   setTimeout that swapped in an explanation after 1.2 seconds. It set `.skel`
   without any class that gives the box a height, so the sentence went into a
   13px bar and no reader has ever seen it. That is the whole reason this moved
   into `loading()` — a pattern implemented once in a view is a pattern the
   other views do not have, and this one did not work where it was.

   Three things have to hold, and only a real browser can show them: the plain
   bar goes up FIRST (so a warm load never flashes a paragraph), the sentence
   replaces it only if the wait continues, and a panel that filled in the
   meantime is not overwritten by its own loading state. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;

const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });

const run = (fn, arg) => page.evaluate(async ({ src, a }) => {
  const ui = await import('/ui.js');
  // eslint-disable-next-line no-new-func
  return new Function('ui', 'a', `return (${src})(ui, a);`)(ui, a);
}, { src: fn.toString(), a: arg });

console.log('\nthe bar goes up first, whatever else is coming');

const immediate = await run((ui) => {
  const host = document.createElement('div');
  document.body.append(host);
  ui.loading(host, 'this panel reads the whole record and takes about ten seconds');
  const s = host.querySelector('.skel');
  return { has: !!s, says: s?.classList.contains('says'), txt: s?.textContent.trim() };
});
check('a skeleton appears at once', immediate.has);
check('and it is the plain bar, not the sentence — a warm load must not flash a paragraph',
  immediate.says === false, JSON.stringify(immediate));
check('the plain bar says Loading…', immediate.txt === 'Loading…', immediate.txt);

console.log('\nthe sentence arrives only if the wait does');

const later = await run(async (ui) => {
  const host = document.createElement('div');
  document.body.append(host);
  ui.loading(host, 'reading the whole record — about ten seconds');
  await new Promise((r) => setTimeout(r, 1500));
  const s = host.querySelector('.skel');
  return {
    says: s?.classList.contains('says'),
    txt: s?.textContent.trim(),
    /* The height is the point: a 13px bar cannot show a sentence, which is why
       the hand-rolled version on #sources was invisible. */
    h: Math.round(s?.getBoundingClientRect().height || 0),
  };
});
check('after the beat it carries the class that gives it room', later.says === true, JSON.stringify(later));
check('and the sentence itself', /reading the whole record/.test(later.txt || ''), later.txt);
check('in a box tall enough to read — the bug that made the old one invisible',
  later.h >= 30, `${later.h}px`);

console.log('\na panel that filled is not overwritten by its own loading state');

const filled = await run(async (ui) => {
  const host = document.createElement('div');
  document.body.append(host);
  ui.loading(host, 'this should never appear');
  host.innerHTML = '<p id="real">the answer</p>';     // the fetch came back fast
  await new Promise((r) => setTimeout(r, 1500));
  return { html: host.innerHTML.trim(), stillReal: !!host.querySelector('#real') };
});
check('the real content survives the deferred swap', filled.stillReal, filled.html);
check('and no skeleton comes back', !/skel/.test(filled.html), filled.html);

console.log('\nwithout a message it is exactly what it always was');

const plain = await run((ui) => {
  const host = document.createElement('div');
  document.body.append(host);
  ui.loading(host);
  return host.innerHTML.trim();
});
check('one bar, no class, no sentence', plain === '<div class="skel">Loading…</div>', plain);

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
