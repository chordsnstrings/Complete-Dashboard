/* FOCUS — the explanations fold, the figures stay (api/public/focus.js).
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-22: "It's not a dashboard, it's a manuscript … the
   same information … should be the same." focus.js marks each long
   explanation and arkiv.css hides it until its panel's "ⓘ notes" opens it in
   place. What this file holds down, on mockapi's synthetic data:

   0. The wiring: the rules are in arkiv.css under the skin and the focus
      mark; index.html stamps data-focus before the first paint; app.js
      starts focus.js from the render loop.
   1. Per page, folded: no folded block holds a table, a chart or a tile; no
      folded block is visible; every marked block's panel carries exactly one
      toggle; a warning stays on screen as one line; and the visible prose is
      shorter than with folding off.
   2. Opening every toggle shows exactly what folding off shows: the same
      blocks, and every number a reader can see with folding off. The page
      holds the same numbers in all three states (marks never touch text).
   3. The control bar's ⓘ button turns it off, and the choice survives a
      reload (fleet.focus).
   4. A re-render (the refresh button) neither duplicates a toggle nor loses
      the marks.
   5. The Classic skin is never touched: no mark, no toggle, no button
      (it is held byte-frozen by arkiv_classic_frozen).

   Proven against the change itself: with the startFocus() call taken out of
   app.js, §1 fails on every page (no folds, no button) — see FIX-STATUS FOCUS. */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('0 · the wiring');
const PUB = new URL('../api/public/', import.meta.url);
const ark = readFileSync(new URL('arkiv.css', PUB), 'utf8');
const idx = readFileSync(new URL('index.html', PUB), 'utf8');
const appjs = readFileSync(new URL('app.js', PUB), 'utf8');
check('arkiv.css hides a folded block only under the skin and the focus mark, and not inside an opened panel',
  /:root\[data-skin="arkiv"\]\[data-focus="on"\] \[data-fx="fold"\]:not\(\.fx-open \[data-fx="fold"\]\)\{display:none\}/.test(ark));
check('index.html stamps data-focus before the first paint, from fleet.focus',
  /r\.dataset\.focus = localStorage\.getItem\('fleet\.focus'\) === 'off' \? 'off' : 'on'/.test(idx));
check('app.js imports focus.js and starts it from render()',
  /import \{ startFocus \} from '\.\/focus\.js'/.test(appjs) && /startFocus\(\{ section:/.test(appjs));

const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const open = async (route, { skin = 'arkiv', focus = null } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai' });
  if (focus) await ctx.addInitScript((m) => { try { localStorage.setItem('fleet.focus', m); } catch { /* */ } }, focus);
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${base}/?ui=desktop&skin=${skin}#${route}`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(700);           // the observer's 120 ms debounce, and late panels
  return { ctx, page, errs };
};

/* In the page: what a reader sees, and every number the page holds. */
const MEASURE = () => {
  const view = document.querySelector('#view');
  const words = (s) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’.,%+−\-/:]*/g) || []).length;
  const numsOf = (root, seenOnly = false) => {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode());) {
      if (n.parentElement.closest('.fx-more') || (seenOnly && !n.parentElement.checkVisibility())) continue;
      out.push(...(n.nodeValue.match(/\d[\d,]*(?:\.\d+)?/g) || []));
    }
    return out.sort();
  };
  const NOT = 'svg, td, th, button, select, option, input, label, h1, h2, h3, h4, summary, .kpi';
  let prose = 0;
  const w = document.createTreeWalker(view, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const el = n.parentElement;
    if (!n.nodeValue.trim() || el.closest(NOT) || !el.checkVisibility()) continue;
    prose += words(n.nodeValue);
  }
  const HOST = '.panel, section.cband, section, form, fieldset';
  const hostOf = (e) => { const h = e.parentElement.closest(HOST); return h && h !== view && view.contains(h) ? h : view; };
  const marked = [...view.querySelectorAll('[data-fx]:not([data-fx="keep"])')];
  const folds = [...view.querySelectorAll('[data-fx="fold"]')];
  const hosts = new Set(marked.map(hostOf));
  const lh = (e) => parseFloat(getComputedStyle(e).lineHeight) || 20;
  return {
    nums: numsOf(view), prose, seen: numsOf(view, true),
    folds: folds.length, foldsShown: folds.filter((f) => f.checkVisibility()).length,
    foldsWithData: folds.filter((f) => f.querySelector('table, svg, canvas, .kpi')).length,
    hostsWithoutToggle: [...hosts].filter((h) => ![...h.children].some((c) => c.classList.contains('fx-more'))).length,
    hostsWithTwo: [...hosts].filter((h) => [...h.children].filter((c) => c.classList.contains('fx-more')).length > 1).length,
    flags: [...view.querySelectorAll('[data-fx="flag"]')].map((f) => ({ shown: f.checkVisibility(), tall: f.getBoundingClientRect().height / lh(f) })),
    btn: !!document.querySelector('#filters #focusBtn'), focus: document.documentElement.dataset.focus,
    footFold: !!document.querySelector('#pageFoot [data-fx="fold"]') && [...document.querySelectorAll('#pageFoot > .fx-more')].length === 1,
  };
};

console.log('\n1 · folded, per page — and 2 · opened again');
/* One load per page, then three states of the SAME DOM: folded, every toggle
   opened, and folding switched off with the ⓘ button. (Two separate loads
   cannot be compared: mockapi's figures move between requests.) */
const ROUTES = ['payouts', 'overview', 'low-performers', 'finance', 'sources'];
let foldedPages = 0;
for (const r of ROUTES) {
  const on = await open(r);
  const a = await on.page.evaluate(MEASURE);
  if (a.folds) foldedPages++;
  check(`${r}: no script error, and the ⓘ button sits in the control bar`, !on.errs.length && a.btn && a.focus === 'on', on.errs.join(' | '));
  check(`${r}: no folded block holds a table, a chart or a tile`, a.foldsWithData === 0, String(a.foldsWithData));
  check(`${r}: no folded block is visible (${a.folds} folded)`, a.foldsShown === 0, String(a.foldsShown));
  check(`${r}: every marked panel has exactly one toggle`, a.hostsWithoutToggle === 0 && a.hostsWithTwo === 0,
    `${a.hostsWithoutToggle} without, ${a.hostsWithTwo} with two`);
  check(`${r}: every warning stays on screen, cut to one line`, a.flags.every((f) => f.shown && f.tall < 1.9), JSON.stringify(a.flags));
  await on.page.$$eval('.fx-more', (bs) => bs.forEach((x) => { if (x.getAttribute('aria-expanded') !== 'true') x.click(); }));
  const c = await on.page.evaluate(MEASURE);
  await on.page.click('#focusBtn');
  const d = await on.page.evaluate(MEASURE);
  check(`${r}: opening every toggle shows exactly what folding off shows (${d.foldsShown} of ${d.folds} blocks)`,
    c.foldsShown === d.foldsShown, `${c.foldsShown} vs ${d.foldsShown}`);
  check(`${r}: …and every number a reader sees with folding off is there with the notes open (${d.seen.length})`,
    d.seen.length > 0 && JSON.stringify(c.seen) === JSON.stringify(d.seen),
    `only open: ${c.seen.filter((x) => !d.seen.includes(x)).slice(0, 5)} · only off: ${d.seen.filter((x) => !c.seen.includes(x)).slice(0, 5)}`);
  check(`${r}: the page holds the same numbers in every state (${a.nums.length})`,
    JSON.stringify(a.nums) === JSON.stringify(c.nums) && JSON.stringify(c.nums) === JSON.stringify(d.nums));
  if (a.folds) check(`${r}: the visible prose is shorter folded (${d.prose} → ${a.prose} words)`, a.prose < d.prose);
  await on.ctx.close();
}
check('the folding reaches the pages (at least 3 of 5 have folded notes)', foldedPages >= 3, String(foldedPages));
{
  const p = await open('overview');
  const a = await p.page.evaluate(MEASURE);
  check('the footer’s sources and principle fold behind one "ⓘ sources"', a.footFold);
  await p.ctx.close();
}

console.log('\n3 · the ⓘ button, remembered');
{
  const p = await open('payouts');
  await p.page.click('#focusBtn');
  const after = await p.page.evaluate(() => ({ f: document.documentElement.dataset.focus, s: localStorage.getItem('fleet.focus'),
    pressed: document.getElementById('focusBtn').getAttribute('aria-pressed') }));
  check('one click shows every word, and says so', after.f === 'off' && after.s === 'off' && after.pressed === 'true', JSON.stringify(after));
  await p.page.reload({ waitUntil: 'load' });
  await p.page.waitForTimeout(500);
  check('…and a reload keeps it off', await p.page.evaluate(() => document.documentElement.dataset.focus === 'off'));
  await p.ctx.close();
}

console.log('\n4 · a re-render');
{
  const p = await open('overview');
  const a = await p.page.evaluate(MEASURE);
  await p.page.click('#refreshBtn');
  await p.page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await p.page.waitForTimeout(700);
  const b = await p.page.evaluate(MEASURE);
  check('after a refresh the marks are back and no panel has two toggles', b.folds === a.folds && b.hostsWithTwo === 0
    && b.hostsWithoutToggle === 0, `${a.folds} → ${b.folds}`);
  await p.ctx.close();
}

console.log('\n5 · the Classic skin');
{
  const p = await open('payouts', { skin: 'classic' });
  const c = await p.page.evaluate(() => ({ marks: document.querySelectorAll('[data-fx]').length,
    toggles: document.querySelectorAll('.fx-more').length, btn: !!document.getElementById('focusBtn') }));
  check('no mark, no toggle and no button under the Classic skin', c.marks === 0 && c.toggles === 0 && !c.btn, JSON.stringify(c));
  await p.ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
