/* THE SERVICE WORKER ON THE DESKTOP BUILD, and the bound on its data cache.
   ═══════════════════════════════════════════════════════════════════════════
   HANDOFF §4.5 "a desktop service worker"; the front-end audit of 2026-11-12
   found the worker's data cache kept every /api answer with no limit until
   the next deploy. Driven in Chromium with service workers ALLOWED, against
   the mock wrapped in a server that does what api/server.js does for the
   worker: /sw.js with VERSION written as 'fleet-<fingerprint>', and every
   piece of code stamped X-FM-Build with the same fingerprint. What it holds:

   1. THE SAME POLICY AS THE PHONE. The desktop registers /sw.js at scope '/',
      after load; the first worker to claim the page does NOT reload it (its
      code is already current); a NEW worker taking over DOES, once. Read off
      both shells' code too: the same script, the same scope, the takeover
      reload in each.
   2. THE DATA CACHE IS BOUNDED. 160 distinct answers leave 150, the oldest
      gone and the newest kept; answers past 24 MB evict the oldest until the
      total fits; one answer over 4 MB is never kept.
   3. THE DEPLOY CHECK STILL SEES WHAT THE TAB RUNS. A HEAD for a module the
      worker holds is answered with the headers of the copy it serves (so
      app.js deployOf compares this tab's code, not the server's), and a
      module from another deploy is served but never enters the shell cache.
   4. STALE SAYS STALE. With the server unreachable, a kept answer carries
      x-sw-cache: hit and the page prints one line above #view, in Dubai
      time; the line goes when the page is redrawn. An answer with no kept
      copy is not retried and is not called "the server took too long".
   The fingerprint versioning is untouched: VERSION is still the one line the
   server rewrites (checked against api/server.js's own expression).

   REVERSIONS that prove it (each made, run, and seen to fail, 2026-11-12):
     · sw.js keepOne: drop the eviction loop → "160 answers leave 150" fails.
     · sw.js: let HEAD through (remove the HEAD branch) → "a HEAD … is
       answered with the copy this tab runs" fails.
     · sw.js: drop `&& sameBuild(fresh)` from the shell put → "a module from
       another deploy is served, never kept" fails.
     · swreg.js: drop the first-claim branch (`if (!controlled) …`) → "the
       first worker to claim the page does not reload it" fails; read the
       flag once at load instead of tracking it → "a NEW worker taking over
       reloads the page, once" fails (the defect this file first found).
     · data.js: drop `|| swOffline(r)` and the swOffline branch in failure()
       → "…not retried, and not called a slow server" fails.

   5. AN OFFLINE OPEN (added by the ARK review, 2026-11-12). The four checks
      above all ran on a page that was already open and listening; none
      opened the page with the server gone, which is what offline is. Done
      that way, two faults showed: after ONE online visit the offline open
      was a blank white page (the desktop's app.js and five modules only it
      imports were never in the worker's cache: the phone puts its first
      screen there by reloading on the first claim, which the desktop skips),
      and with the answers kept, the page painted them with NO offline line
      (#overview: 6 opens of 6), because they all came back before swreg.js
      was listening. Reversions, each run and seen to fail:
     · swreg.js: drop `warmShell(win);` from the first-claim branch → "after
       ONE online visit, an offline open draws the page" fails (blank page).
     · app.js: hand swreg.js nothing (`registerWorker()` without `held`) →
       "every offline open … says so (3 of 3)" fails.
   2b. WHOSE ANSWER WHEN THE KEEP RUNS (the same review). Keeps are queued,
      so one can run after the next reader's first answer has emptied the
      cache for that reader. Reversion: sw.js keepOne without its two scope
      checks → "none of the earlier reader's answers is kept in the next
      reader's cache" fails.

   Synthetic data only (mockapi.mjs and generated JSON). */
import { readFileSync } from 'node:fs';
import express from 'express';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');

/* ── 1a · the policy, read off both shells ─────────────────────────────── */
console.log('\n1 · the same worker, the same scope, the same takeover reload');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const phone = strip(read('m/app.js'));
const desk = strip(read('swreg.js'));
const appJs = strip(read('app.js'));
check('both register /sw.js at scope "/"', /register\('\/sw\.js', \{ scope: '\/' \}\)/.test(phone)
  && /register\('\/sw\.js', \{ scope: '\/' \}\)/.test(desk));
check('both wait for the page to load first', /addEventListener\('load'/.test(phone) && /addEventListener\('load', go/.test(desk));
check('both reload once on a takeover, guarded', /controllerchange[\s\S]{0,120}reloading[\s\S]{0,80}location\.reload\(\)/.test(phone)
  && /controllerchange[\s\S]{0,240}reloading[\s\S]{0,120}location\.reload\(\)/.test(desk));
check('the desktop shell registers it, after the first render is under way, without a first-screen import',
  /import\('\.\/swreg\.js'\)\.then\(\(m\) => m\.registerWorker\(\{ held: swHeld \}\)\)/.test(appJs) && !/^import[^;]*swreg/m.test(appJs));
check('…and listens for the worker’s word from before sign-in is asked, handing it over at registration',
  appJs.indexOf("sw.addEventListener('message', keep)") > 0
  && appJs.indexOf("sw.addEventListener('message', keep)") < appJs.indexOf('const whoReady = loadWho()')
  && /if \(!controlled\) \{ controlled = true; warmShell\(win\); return; \}/.test(desk));
const srvJs = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
const sw0 = read('sw.js');
check('VERSION is still the one line the server rewrites, and the first fingerprint-shaped string a reader greps',
  (sw0.match(/const VERSION = '[^']*';/g) || []).length === 1 && /src\.replace\(\/const VERSION = '\[\^'\]\*';\//.test(srvJs)
  && !/fleet-[0-9a-f]{12}/.test(sw0.slice(0, sw0.indexOf('const VERSION'))));

/* ── the server: the mock, wrapped as api/server.js wraps the worker ────── */
const BUILD = '0123456789ab';
let build = BUILD;                  // what the server is "deployed" at now
let refuse = false;                 // /api/test/* unreachable
let down = false;                   // the whole server unreachable (section 5)
const hits = new Map();
const web = express();
web.use((req, _res, next) => { if (down) { req.socket.destroy(); return; } next(); });
web.get('/sw.js', (_q, r) => {
  r.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache, max-age=0, must-revalidate',
    'Service-Worker-Allowed': '/' });
  r.send(read('sw.js').replace(/const VERSION = '[^']*';/, `const VERSION = 'fleet-${build}';`));
});
web.use((req, res, next) => {
  if (req.path === '/' || /\.(?:js|css|html)$/.test(req.path)) res.set('X-FM-Build', build);
  next();
});
web.get('/api/test/:kind/:i', (req, res) => {
  const k = `${req.params.kind}/${req.params.i}`;
  hits.set(k, (hits.get(k) || 0) + 1);
  if (refuse) { req.socket.destroy(); return; }
  /* Whose answer (§2b): the server stamps x-fm-scope for a signed-in reader. */
  if (req.query.scope) res.set('x-fm-scope', String(req.query.scope));
  const pad = req.params.kind === 'big' ? 'x'.repeat(3_900_000) : req.params.kind === 'huge' ? 'x'.repeat(5_000_000)
    : req.params.kind === 'mid' ? 'x'.repeat(400_000) : '';
  res.json({ i: Number(req.params.i), pad });
});
web.use(mock);
const srv = web.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow',
    timezoneId: 'Asia/Dubai', colorScheme: 'light', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  let loads = 0;
  page.on('load', () => { loads += 1; });
  await page.goto(`${base}/?ui=desktop&skin=arkiv&motion=off#overview`, { waitUntil: 'load' });
  await page.evaluate(() => { window.__mark = 'first'; });
  const controlled = await page.evaluate(() => new Promise((resolve) => {
    const done = () => resolve(navigator.serviceWorker.getRegistration().then((r) => ({
      scope: r?.scope, script: r?.active?.scriptURL, ctl: !!navigator.serviceWorker.controller })));
    if (navigator.serviceWorker.controller) return done();
    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
    setTimeout(done, 20000);
  }));
  await page.waitForTimeout(800);
  check('1 · the desktop build registers the worker at scope "/"', controlled.ctl && controlled.scope === `${base}/`
    && /\/sw\.js$/.test(controlled.script || ''), JSON.stringify(controlled));
  check('1 · the first worker to claim the page does not reload it (its code is already current)',
    loads === 1 && await page.evaluate(() => window.__mark === 'first'), `loads ${loads}`);

  /* ── 2 · the bound ── */
  console.log('\n2 · the data cache: at most 150 answers and 24 MB, the oldest out first');
  const DATA = `fleet-${BUILD}-data-2`;
  const SHELL = `fleet-${BUILD}-shell`;
  const held = (prefix) => page.evaluate(async ([name, p]) => {
    const c = await caches.open(name);
    return (await c.keys()).map((r) => new URL(r.url).pathname).filter((u) => u.startsWith(p));
  }, [DATA, prefix]);
  const settleCache = async (prefix, want, ms = 30000) => {
    const t0 = Date.now(); let got = [];
    while (Date.now() - t0 < ms) { got = await held(prefix); if (want(got)) break; await page.waitForTimeout(250); }
    return got;
  };
  await page.evaluate(async () => { for (let i = 0; i < 160; i++) await fetch(`/api/test/n/${i}`); });
  const n = await settleCache('/api/test/n/', (g) => g.length <= 150 && g.includes('/api/test/n/159'));
  check('160 answers leave 150', n.length === 150, String(n.length));
  check('…the oldest are the ones gone (0–9), the newest kept (10–159)',
    !n.includes('/api/test/n/0') && !n.includes('/api/test/n/9') && n.includes('/api/test/n/10') && n.includes('/api/test/n/159'),
    n.slice(0, 5).join(' '));
  await page.evaluate(async () => { await fetch('/api/test/n/10'); });     // stored again: now the newest
  await page.evaluate(async () => { await fetch('/api/test/n/160'); });
  const n2 = await settleCache('/api/test/n/', (g) => g.includes('/api/test/n/160'));
  check('…an answer stored again is the newest again: the next one out is 11, not 10',
    n2.includes('/api/test/n/10') && !n2.includes('/api/test/n/11') && n2.length === 150, `${n2.length} ${n2.includes('/api/test/n/11')}`);
  const ledger = await page.evaluate(async (name) => {
    const r = await (await caches.open(name)).match('/__fm-data-ledger');
    return r ? Object.keys(await r.json()).length : -1;
  }, DATA);
  check('…the ledger in the cache counts exactly what the cache holds', ledger === 150, String(ledger));

  await page.evaluate(async () => { for (let i = 0; i < 7; i++) await fetch(`/api/test/big/${i}`); await fetch('/api/test/huge/0'); });
  const big = await settleCache('/api/test/big/', (g) => g.includes('/api/test/big/6') && g.length <= 6, 60000);
  const bytes = await page.evaluate(async (name) => {
    const r = await (await caches.open(name)).match('/__fm-data-ledger');
    return Object.values(await r.json()).reduce((s, v) => s + v[1], 0);
  }, DATA);
  check('answers past 24 MB evict the oldest until the total fits', bytes <= 24 * 1024 * 1024 && big.includes('/api/test/big/6')
    && !big.includes('/api/test/big/0'), `${(bytes / 1048576).toFixed(1)} MB, held ${big.join(' ')}`);
  check('…and one answer over 4 MB is never kept', (await held('/api/test/huge/')).length === 0);

  /* ── 2b · whose answer, when the keep finally runs (the ARK review) ──
     Keeps queue behind one another, so one can run after the next reader's
     first answer has emptied the cache for them. Thirty answers for reader
     A, then — with their keeps still queued — one for reader B: none of A's
     may be found in B's cache once the queue has drained (B's own answer,
     queued last, is the sign it has). */
  console.log('\n2b · a keep that runs after the scope moved on is dropped');
  const leak = await page.evaluate(async (name) => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`/api/test/mid/${i}?scope=reader-a`)));
    await fetch('/api/test/n/7000?scope=reader-b');
    const c = await caches.open(name);
    let done = false;
    for (let i = 0; i < 300 && !done; i++) {
      done = !!(await c.match('/api/test/n/7000?scope=reader-b'));
      if (!done) await new Promise((r) => setTimeout(r, 100));
    }
    const keys = (await c.keys()).map((r) => new URL(r.url).pathname);
    const scope = await (await c.match('/__fm-data-scope'))?.text();
    return { done, scope, a: keys.filter((k) => k.startsWith('/api/test/mid/')).length, n: keys.length };
  }, DATA);
  check('none of the earlier reader’s answers is kept in the next reader’s cache', leak.done && leak.scope === 'reader-b' && leak.a === 0,
    JSON.stringify(leak));

  /* ── 3 · the deploy check ── */
  console.log('\n3 · HEAD answers for the copy this tab runs; another deploy’s module is never kept');
  /* Through the worker, and held until the shell really has it (the worker
     keeps a module after answering, not before). */
  await page.evaluate(async (name) => {
    await fetch('/app.js');
    for (let i = 0; i < 80 && !(await (await caches.open(name)).match('/app.js')); i++) await new Promise((r) => setTimeout(r, 100));
  }, SHELL);
  build = 'abcdefabcdef';                                  // the server has moved on
  const head = await page.evaluate(async () => {
    const a = await fetch('/app.js', { method: 'HEAD', cache: 'no-store' });
    const b = await fetch('/swr.js?never', { method: 'HEAD', cache: 'no-store' });
    return { cached: a.headers.get('x-fm-build'), uncached: b.headers.get('x-fm-build') };
  });
  check('a HEAD for a module the worker holds is answered with the copy this tab runs (its own deploy)',
    head.cached === BUILD, JSON.stringify(head));
  check('…and one it does not hold goes to the server, as before', head.uncached === 'abcdefabcdef', JSON.stringify(head));
  /* The worker keeps a module AFTER answering, so absence is only evidence
     once a put that should happen has had its chance: a module of this
     worker's own deploy, fetched straight after, must appear (the positive
     control), and only then is the other deploy's module looked for. */
  const r1 = await page.evaluate(async () => { const r = await fetch('/cohort.js'); return { status: r.status, build: r.headers.get('x-fm-build') }; });
  build = BUILD;
  const other = await page.evaluate(async (name) => {
    await fetch('/corridors.js');
    const c = await caches.open(name);
    let control = false;
    for (let i = 0; i < 60 && !control; i++) { control = !!(await c.match('/corridors.js')); if (!control) await new Promise((r) => setTimeout(r, 100)); }
    await new Promise((r) => setTimeout(r, 300));
    return { control, kept: !!(await c.match('/cohort.js')) };
  }, SHELL);
  check('a module from another deploy is served, never kept in this deploy’s shell (a same-deploy one fetched after it is)',
    r1.status === 200 && r1.build === 'abcdefabcdef' && other.control && !other.kept, JSON.stringify({ r1, other }));

  /* ── 4 · offline ── */
  console.log('\n4 · stale figures say they are stale; a missing one is not a slow server');
  /* The 24 MB step above evicted every small answer (they were the oldest),
     which is the bound doing its job — so one is kept afresh first. */
  await page.evaluate(() => fetch('/api/test/n/500'));
  await settleCache('/api/test/n/', (g) => g.includes('/api/test/n/500'));
  refuse = true;
  const hit = await page.evaluate(async () => {
    const r = await fetch('/api/test/n/500');
    return { status: r.status, cache: r.headers.get('x-sw-cache'), at: r.headers.get('x-sw-cached-at') };
  });
  check('with the server unreachable, a kept answer comes back stamped x-sw-cache: hit, with when it was kept',
    hit.status === 200 && hit.cache === 'hit' && !Number.isNaN(Date.parse(hit.at)), JSON.stringify(hit));
  await page.waitForTimeout(400);
  const notice = await page.evaluate(() => {
    const n2 = document.getElementById('swStale');
    return n2 ? { text: n2.textContent, before: n2.nextElementSibling?.id, role: n2.getAttribute('role') } : null;
  });
  check('…and the page says so above #view: offline, a kept copy, its age in Dubai time, not live',
    notice && /^Offline\./.test(notice.text) && /\(Dubai time\)/.test(notice.text) && /not live/.test(notice.text)
    && notice.before === 'view' && notice.role === 'status', JSON.stringify(notice));
  const miss = await page.evaluate(async () => {
    const m = await import('/data.js');
    const t0 = performance.now();
    try { await m.api('/api/test/n/99999'); return { ok: true }; }
    catch (e) { return { msg: e.message, ms: Math.round(performance.now() - t0) }; }
  });
  check('an answer with no kept copy is not retried, and not called a slow server',
    miss.ms < 1100 && /offline/i.test(miss.msg || '') && !/took too long/.test(miss.msg || ''), JSON.stringify(miss));
  refuse = false;
  await page.evaluate(() => { location.hash = '#revenue'; });
  await page.waitForTimeout(2500);
  check('…the line goes when the page is redrawn from live answers', await page.evaluate(() => !document.getElementById('swStale')));

  /* ── 1c · a takeover reloads, once ── */
  build = 'fedcbafedcba';                                  // a deploy: new worker bytes, new shell
  await page.evaluate(() => { window.__mark = 'before-update'; });
  const loadsBefore = loads;
  const reloaded = page.waitForEvent('load', { timeout: 30000 }).then(() => true, () => false);
  await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  const did = await reloaded;
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => ({ mark: window.__mark ?? null, keys: null }));
  const keys = await page.evaluate(() => caches.keys());
  check('1 · a NEW worker taking over reloads the page, once', did && loads === loadsBefore + 1 && after.mark === null,
    `reloaded ${did}, loads ${loads - loadsBefore}, mark ${after.mark}`);
  check('…and its activation retired the old deploy’s caches', keys.every((k) => k.startsWith('fleet-fedcbafedcba')), keys.join(' '));
  await ctx.close();

  /* ── 5 · an offline open ── (a fresh browser profile: no worker yet) */
  console.log('\n5 · an offline open: the page draws from the worker, and says its figures are kept copies');
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'allow',
    timezoneId: 'Asia/Dubai', colorScheme: 'light', reducedMotion: 'reduce' });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(`offline: ${String(e.message).slice(0, 200)}`));
  const SHELL2 = `fleet-${build}-shell`;
  await p2.goto(`${base}/?ui=desktop&skin=arkiv&motion=off#overview`, { waitUntil: 'load' });
  await p2.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 20000 });
  /* The first claim asks the worker for what the page had already loaded;
     held once app.js is in the shell cache (bounded wait, then measured). */
  const warmed = await p2.evaluate(async (name) => {
    for (let i = 0; i < 100; i++) {
      if (await (await caches.open(name)).match('/app.js')) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return false;
  }, SHELL2);
  down = true;
  await p2.reload({ waitUntil: 'load' });
  await p2.waitForTimeout(3500);
  const once = await p2.evaluate(() => ({ nav: document.querySelectorAll('#nav a').length,
    view: (document.getElementById('view')?.innerText || '').trim().length,
    line: document.getElementById('swStale')?.textContent || null }));
  check('after ONE online visit, an offline open draws the page from the worker (it was a blank white page)',
    warmed && once.nav > 0 && once.view > 0, JSON.stringify({ warmed, ...once, line: undefined }));
  check('…and says, above the page, that the server is not answering', /^Offline\./.test(once.line || ''), JSON.stringify(once.line));
  /* Answers kept too (an online visit through the worker), then offline,
     three times over: every open must carry the line. Its first page's
     answers all come back before swreg.js has loaded. */
  const lines = [];
  for (let i = 0; i < 3; i++) {
    down = false;
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForTimeout(2500);
    down = true;
    await p2.reload({ waitUntil: 'load' });
    await p2.waitForTimeout(3500);
    lines.push(await p2.evaluate(() => document.getElementById('swStale')?.textContent || null));
  }
  down = false;
  check('every offline open of a page whose answers were kept says they are kept copies, in Dubai time (3 of 3)',
    lines.every((l) => /^Offline\. The figures on this page are copies this browser kept/.test(l || '') && /\(Dubai time\)/.test(l || '')),
    JSON.stringify(lines));
  const box = await p2.evaluate(() => {
    const n = document.getElementById('swStale');
    const v = document.getElementById('view');
    return n && v ? { line: Math.round(n.getBoundingClientRect().left),
      page: Math.round(v.getBoundingClientRect().left + parseFloat(getComputedStyle(v).paddingLeft)) } : null;
  });
  check('…standing on the page’s own gutter, not on the window’s edge', box && box.line === box.page, JSON.stringify(box));
  await ctx2.close();
} catch (e) {
  fail++; console.log(`  ✗ the browser half threw: ${e.stack || e}`);
}

check('no page error', errors.length === 0, errors.join(' | '));
await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
