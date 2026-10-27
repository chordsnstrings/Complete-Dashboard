/* ── pages load when they are opened (app.js PAGE_OF, FIX-STATUS LAZY) ──────
   The operator, 2026-10-27: "sometimes loading the page takes longer so
   perhps lazy loading", then "start the lazy loading". Measured that day:
   the first screen waited for 76 modules, 1,185,372 bytes on the wire from
   production, of which #overview ran 24%. Each page's module is now imported
   by its own handler when the page opens; what the header must know before
   then is in pagemeta.js.

   What has to hold:

   1 · THE FIRST SCREEN STAYS SMALL. No page module is a static import of
       app.js, pagemeta.js imports nothing, and the static graph from app.js
       stays under 20 modules and 1.3 MB — so one import added back at the top
       of app.js, which would quietly put a page (and everything it pulls in)
       back in every first screen, fails here.
   2 · THE MAP IS TRUE. Every page('x') a handler asks for is in PAGE_OF, every
       PAGE_OF entry is asked for, and every file it names exists.
   3 · NOTHING RUNS AT LOAD in a module that left the first screen: it would
       now run only when its page opens. A top-level call there fails here.
   4 · EVERY PAGE STILL DRAWS, in a browser against the mock — every route of
       routes_list.mjs whose page is now loaded on demand, plus the fifteen
       pages that list does not reach — with no script error and no "Could
       not load this view", and its module is fetched only then.
   5 · THE ADDRESSED PAGE IS FETCHED EARLY, while the shell still waits for
       /api/auth/me.
   6 · A MODULE THAT WILL NOT RUN says why in words, and reloads only where a
       reload helps: a transient failure is retried under a fresh address
       (the browser remembers a failed fetch), a link error or a deploy in
       between reloads once, a silent server does not (a reload there is the
       browser's error page) — and never a loop.
   7 · WHILE A MODULE IS ON ITS WAY the view shows a skeleton, not a blank
       page, and it is gone when the page draws; a module already in hand
       shows none.
   8 · A PAGE LEFT BEFORE ITS MODULE ARRIVED is dropped when it does — it
       must not draw into the next page, nor ask for its own data.
   (The review of 2026-10-27 found 6–8; FIX-STATUS LAZY7–9.)

   Renders against mockapi.mjs — synthetic fixtures only. */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';
import { ROUTES } from './routes_list.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = 'api/public';
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, '');
/* Static imports and re-exports, as the browser follows them before any code
   runs. A dynamic import() is not one, and is not counted. */
const staticDeps = (f) => [...strip(read(f)).matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+'([^']+)';/gms)]
  .map((m) => normalize(join(dirname(f), m[1])).replace(/^\.?\//, ''));
const walk = (root) => {
  const seen = new Set(); const q = [root];
  while (q.length) { const f = q.shift(); if (seen.has(f)) continue; seen.add(f); q.push(...staticDeps(f)); }
  return seen;
};

const app = read('app.js');
const PAGE_OF = Object.fromEntries([...app.match(/const PAGE_OF = \{([\s\S]*?)\n\};/)[1]
  .matchAll(/^\s+'?([\w-]+)'?: '\.\/([\w-]+\.js)',$/gm)].map((m) => [m[1], m[2]]));
const pageFiles = new Set(Object.values(PAGE_OF));

console.log('\n1 · the first screen stays small');
const boot = walk('app.js');
const bytes = [...boot].reduce((s, f) => s + statSync(join(PUB, f)).size, 0);
check(`no page module is a static import of app.js (${pageFiles.size} modules behind ${Object.keys(PAGE_OF).length} pages)`,
  pageFiles.size >= 45 && staticDeps('app.js').every((f) => !pageFiles.has(f)),
  staticDeps('app.js').filter((f) => pageFiles.has(f)).join(' '));
check('…nor reached from the first screen any other way', [...boot].every((f) => !pageFiles.has(f)),
  [...boot].filter((f) => pageFiles.has(f)).join(' '));
check(`the first screen is ${boot.size} modules, ${Math.round(bytes / 1024)} KB (under 20 and 1.3 MB; it was 76 and 3.5 MB)`,
  boot.size < 20 && bytes < 1.3e6, [...boot].sort().join(' '));
check('pagemeta.js, which the header reads, imports nothing', staticDeps('pagemeta.js').length === 0);

console.log('\n2 · the map is true');
const asked = new Set([...app.matchAll(/\bpage\('([\w-]+)'\)/g)].map((m) => m[1]));
const notMapped = [...asked].filter((k) => !PAGE_OF[k]);
const notAsked = Object.keys(PAGE_OF).filter((k) => !asked.has(k));
check(`every page('…') a handler asks for is in PAGE_OF (${asked.size})`, notMapped.length === 0, notMapped.join(' '));
check('every PAGE_OF entry is asked for by its handler', notAsked.length === 0, notAsked.join(' '));
check('every file it names exists', [...pageFiles].every((f) => existsSync(join(PUB, f))));
const handlers = [...app.matchAll(/^V(?:\.([\w]+)|\['([\w-]+)'\]) = /gm)].map((m) => m[1] || m[2]);
check('every key in PAGE_OF is a page app.js answers', Object.keys(PAGE_OF).every((k) => handlers.includes(k)),
  Object.keys(PAGE_OF).filter((k) => !handlers.includes(k)).join(' '));
/* Every name a handler takes from its module, exported by that module —
   which imports_resolve.test.mjs cannot see, these not being imports. */
const exportsOf = (f) => {
  const src = strip(read(f));
  const out = new Set([...src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm)].map((m) => m[1]));
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((x) => out.add(x));
  return out;
};
const taken = [];
for (const m of app.matchAll(/\(await page\('([\w-]+)'\)\)\.([\w$]+)/g)) taken.push([m[1], m[2]]);
for (const m of app.matchAll(/const \{ ([^}]+) \} = await page\('([\w-]+)'\)/g)) m[1].split(',').map((x) => x.trim().split(':')[0].trim()).forEach((n) => taken.push([m[2], n]));
const missing = taken.filter(([v, n]) => PAGE_OF[v] && !exportsOf(PAGE_OF[v]).has(n)).map(([v, n]) => `${PAGE_OF[v]}:${n}`);
check(`every name a handler takes from its module is exported by it (${taken.length})`, taken.length >= 60 && missing.length === 0, missing.join(' '));

console.log('\n3 · nothing runs at load in a module that left the first screen');
const behind = new Set();
for (const f of pageFiles) for (const g of walk(f)) if (!boot.has(g)) behind.add(g);
/* A statement at column 0 that is not a declaration, an import or export, a
   comment or a closing bracket: a call, an assignment to a global, an IIFE. */
const AT_LOAD = /^(?!import\b|export\b|const\b|let\b|var\b|function\b|async function\b|class\b|\/\*|\/\/|\*|\s|[}\])]|$)/m;
const runs = [...behind].filter((f) => AT_LOAD.test(strip(read(f))));
check(`none of the ${behind.size} modules behind the pages does anything at load`, behind.size > 45 && runs.length === 0,
  runs.map((f) => `${f}: ${strip(read(f)).match(AT_LOAD)?.input?.split('\n').find((l) => AT_LOAD.test(l))?.slice(0, 60)}`).join(' | '));

/* ══ the browser half ═════════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const fresh = () => browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
const jsOf = (ctx) => { const seen = []; ctx.on('request', (r) => { const p = new URL(r.url()).pathname; if (p.endsWith('.js')) seen.push(p.slice(1)); }); return seen; };
const drawn = (page) => page.waitForFunction(() => document.querySelector('#app.ak-shell')
  && !document.querySelector('#view .skel') && document.querySelector('#view')?.childElementCount > 0, null, { timeout: 15000 }).catch(() => 'timeout');

console.log('\n4 · every page still draws, and fetches its module only then');
{
  const ctx = await fresh();
  const js = jsOf(ctx);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${page.url().split('#')[1]}: ${e.message}`));
  await page.goto(`${base}/?ui=desktop#overview`, { waitUntil: 'domcontentloaded' });
  await drawn(page);
  const first = [...new Set(js)];
  check(`#overview fetched ${first.length} modules and none of the pages’`, first.every((f) => !pageFiles.has(f)) && first.length < 22,
    first.filter((f) => pageFiles.has(f)).join(' ') || first.join(' '));
  /* The fifteen pages routes_list.mjs does not reach, at their plain address. */
  const EXTRA = ['hr-roster', 'import-sheet', 'same-person', 'advances', 'cancellations', 'charging', 'deposits', 'messages',
    'opening', 'payouts', 'policy', 'salary', 'supply', 'target', 'trip'];
  const routes = [...ROUTES.filter((r) => PAGE_OF[r.split(/[/?]/)[0]]), ...EXTRA];
  const broke = [], late = [], slow = [];
  for (const r of routes) {
    const view = r.split(/[/?]/)[0];
    const had = js.includes(PAGE_OF[view]);
    await page.evaluate((h) => { location.hash = h; }, `#${r}`);
    if (await drawn(page) === 'timeout') slow.push(r);
    const t = await page.evaluate(() => document.querySelector('#view')?.textContent || '');
    if (/Could not load this view/.test(t)) broke.push(`${r}: ${t.slice(t.indexOf('Could not load'), t.indexOf('Could not load') + 120)}`);
    if (!had && !js.includes(PAGE_OF[view])) late.push(r);
  }
  check(`${routes.length} addresses over ${new Set(routes.map((r) => r.split(/[/?]/)[0])).size} pages draw without "Could not load this view"`,
    broke.length === 0, broke.slice(0, 4).join(' | '));
  check('…with no script error', errs.length === 0, errs.slice(0, 4).join(' | '));
  check('…each page fetching its module when first opened', late.length === 0, late.join(' '));
  check('…and none still drawing after 15 s', slow.length === 0, slow.join(' '));
  await ctx.close();
}

console.log('\n5 · the addressed page is fetched while the shell still waits for who is signed in');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  let whoDone = null, modAsked = null;
  const t0 = Date.now();
  await page.route('**/api/auth/me*', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); whoDone = Date.now() - t0; });
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/payouts.js' && modAsked == null) modAsked = Date.now() - t0; });
  await page.goto(`${base}/?ui=desktop#payouts`, { waitUntil: 'domcontentloaded' });
  await drawn(page);
  check('payouts.js was asked for before /api/auth/me answered', modAsked != null && whoDone != null && modAsked < whoDone,
    `module at ${modAsked} ms, who at ${whoDone} ms`);
  await ctx.close();
}

console.log('\n6 · a module that will not run: the reason in words, and a reload only where it helps');
const visit = async (setup, wait = 4500) => {
  const ctx = await fresh();
  const page = await ctx.newPage();
  let loads = 0, data = 0;
  page.on('load', () => { loads++; });
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/finance/payouts')) data++; });
  await setup(page);
  await page.goto(`${base}/?ui=desktop#payouts`, { waitUntil: 'load' });
  await page.waitForTimeout(wait);
  const r = await page.evaluate(() => ({ text: document.querySelector('#view')?.textContent || '',
    title: document.querySelector('#viewTitle')?.textContent.trim() }));
  await ctx.close();
  return { loads, data, ...r };
};
{
  /* The server silent for this module (the fetch and the HEAD both fail). */
  const v = await visit((page) => page.route('**/payouts.js*', (r) => r.abort()));
  check('a silent server: no reload — the reason says the server did not answer', v.loads === 1
    && /Could not load this view/.test(v.text) && /the server did not answer/.test(v.text) && !/dynamically imported/.test(v.text),
  `${v.loads} loads · ${v.text.slice(0, 160)}`);
}
{
  /* A dropped line, once: the retry under a fresh address gets it. */
  let n = 0;
  const v = await visit((page) => page.route('**/payouts.js*', (r) => (r.request().method() === 'GET' && n++ === 0 ? r.abort() : r.continue())));
  check('a transient failure is retried under a fresh address: the page draws, no reload',
    v.loads === 1 && !/Could not load this view/.test(v.text) && n >= 2, `${v.loads} loads, ${n} GETs · ${v.text.slice(0, 120)}`);
}
{
  /* A module that asks this tab's ui.js for a name it has not got — a
     deploy since the tab opened. */
  const v = await visit((page) => page.route('**/payouts.js*', (r) => (r.request().method() === 'GET'
    ? r.fulfill({ status: 200, contentType: 'text/javascript', body: "import { notInThisDeploy } from './ui.js';\nexport const renderPayouts = () => notInThisDeploy;" })
    : r.continue())));
  check('a link error reloads once, then says the dashboard was updated', v.loads === 2
    && /has been updated since this tab was opened/.test(v.text), `${v.loads} loads · ${v.text.slice(0, 160)}`);
}
{
  /* A deploy between the boot and this page: the module links, and would run
     on top of the old code. X-FM-Build says so. */
  const v = await visit((page) => Promise.all([
    page.route('**/app.js', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, headers: { ...res.headers(), 'x-fm-build': 'deploy-a' } }); }),
    page.route('**/payouts.js*', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, headers: { ...res.headers(), 'x-fm-build': 'deploy-b' } }); }),
  ]));
  check('a module from a later deploy is never run on this tab’s code: one reload, then the reason', v.loads === 2
    && /has been updated since this tab was opened/.test(v.text) && v.data === 0, `${v.loads} loads · ${v.data} data requests · ${v.text.slice(0, 120)}`);
}
{
  const v = await visit((page) => Promise.all([
    page.route('**/app.js', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, headers: { ...res.headers(), 'x-fm-build': 'deploy-a' } }); }),
    page.route('**/payouts.js*', async (r) => { const res = await r.fetch(); r.fulfill({ response: res, headers: { ...res.headers(), 'x-fm-build': 'deploy-a' } }); }),
  ]));
  check('…and one from the same deploy runs as ever', v.loads === 1 && !/Could not load this view/.test(v.text), `${v.loads} loads · ${v.text.slice(0, 120)}`);
}
{
  /* A store that reads but will not write (full, or locked down): the mark
     that stops a second reload cannot be kept, so there is no first one. */
  const v = await visit((page) => Promise.all([
    page.addInitScript(() => { const set = Storage.prototype.setItem; Storage.prototype.setItem = function (k, x) { if (String(k).startsWith('fleet.reload:')) throw new Error('quota'); return set.call(this, k, x); }; }),
    page.route('**/payouts.js*', (r) => (r.request().method() === 'GET'
      ? r.fulfill({ status: 200, contentType: 'text/javascript', body: "import { notInThisDeploy } from './ui.js';\nexport const renderPayouts = () => notInThisDeploy;" })
      : r.continue())),
  ]));
  check('a store that will not keep the mark: no reload at all, never a loop', v.loads === 1
    && /has been updated since this tab was opened/.test(v.text), `${v.loads} loads · ${v.text.slice(0, 120)}`);
}

console.log('\n7 · while a page’s module is on its way, a skeleton — not a blank view');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop#overview`, { waitUntil: 'domcontentloaded' });
  await drawn(page);
  await page.route('**/payouts.js', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); r.continue(); });
  await page.evaluate(() => { location.hash = '#payouts'; });
  await page.waitForTimeout(500);
  const during = await page.evaluate(() => ({ skel: document.querySelectorAll('#view > .skel[data-wait="module"]').length,
    kids: document.querySelector('#view').childElementCount }));
  await drawn(page);
  const after = await page.evaluate(() => ({ placeholder: [...document.querySelectorAll('.skel[data-wait="module"]')].length,
    title: document.querySelector('#viewTitle')?.textContent.trim() }));
  check('the view shows the ordinary skeleton while payouts.js is held', during.skel === 1 && during.kids === 1, JSON.stringify(during));
  check('…and it is gone once the page has drawn', after.placeholder === 0, JSON.stringify(after));
  /* Back to it, its module in hand: no placeholder at all, so a redraw stays
     one task. */
  await page.evaluate(() => { location.hash = '#overview'; });
  await drawn(page);
  await page.evaluate(() => {
    window.__ph = 0;
    new MutationObserver((l) => l.forEach((r) => r.addedNodes.forEach((n) => {
      if (n.nodeType === 1 && n.dataset?.wait === 'module') window.__ph++;
    }))).observe(document.querySelector('#app .main'), { childList: true, subtree: true });
    location.hash = '#payouts';
  });
  await drawn(page);
  check('a module already in hand shows no placeholder', await page.evaluate(() => window.__ph) === 0);
  await ctx.close();
}

console.log('\n8 · a page left before its module arrived is dropped, not drawn');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  const asked = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/finance/payouts')) asked.push(u.pathname); });
  await page.goto(`${base}/?ui=desktop#overview`, { waitUntil: 'domcontentloaded' });
  await drawn(page);
  await page.route('**/payouts.js*', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); r.continue(); });
  await page.evaluate(() => { location.hash = '#payouts'; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { location.hash = '#drivers'; });
  await page.waitForTimeout(2600);
  const v = await page.evaluate(() => ({ title: document.querySelector('#viewTitle')?.textContent.trim(),
    text: (document.querySelector('#view')?.textContent || '').slice(0, 80) }));
  check('the payouts page, left while its code loaded, asked for none of its data', asked.length === 0, asked.join(' '));
  check('…and the page the reader went to is the one on screen', /Drivers/.test(v.title || '') && !/Could not load/.test(v.text), JSON.stringify(v));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
