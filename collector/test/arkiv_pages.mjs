/* Shared by the page phase's browser tests (test/arkiv_*.test.mjs).
   ─────────────────────────────────────────────────────────────────────────
   Each converted page is checked the same three ways: the contract's shape
   under the skin (00 leads, one hero, the † band, the colophon), its figures
   against the answer the page itself received (captured off the wire, so the
   test asserts on the same bytes the page drew from rather than on a second
   request that could differ), and its absences with their reasons. The old
   skin is held byte for byte by test/arkiv_classic_frozen.test.mjs; the
   per-page files only confirm it still builds the old page.

   Not a *.test.mjs, so run-all does not run it on its own. Synthetic data
   only: every page renders against mockapi.mjs. */
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

export function harness(title) {
  let pass = 0, fail = 0;
  const errors = [];
  const check = (n, ok, x = '') => {
    if (ok) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x}`); }
  };
  let srv = null, browser = null, base = null;
  const start = async () => {
    srv = mock.listen(0);
    await new Promise((r) => srv.once('listening', r));
    base = `http://127.0.0.1:${srv.address().port}`;
    browser = await launchChromium();
    console.log(`\n${title}`);
  };
  /* A page in a skin, with every JSON answer under /api/ kept by path so a
     check can compare a figure with what the page was actually sent. */
  /* `fixtures`: { '/api/path': body | (query, realBody) => body } — an answer
     served in place of the mock's (by exact path), for a case the mock does
     not hold. A function receives the request's query and the mock's own
     answer, so a test can take the mock's and change one field. */
  const open = async (skin, hash, { width = 1440, hold = null, scheme = 'light', fixtures = null } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block',
      reducedMotion: 'reduce', colorScheme: scheme, timezoneId: 'Asia/Dubai', locale: 'en-GB' });
    const page = await ctx.newPage();
    const answers = [];
    page.on('pageerror', (e) => errors.push(`${skin} ${hash}: ${String(e.message).slice(0, 200)}`));
    page.on('response', async (r) => {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/api/')) return;
      try { answers.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), body: await r.json() }); } catch { /* not JSON */ }
    });
    if (hold) await page.route(hold.url, async (route) => { await hold.gate; await route.continue(); });
    if (fixtures) {
      await page.route((u) => Object.hasOwn(fixtures, new URL(u).pathname), async (route) => {
        const u = new URL(route.request().url());
        const f = fixtures[u.pathname];
        let body = f;
        if (typeof f === 'function') {
          const real = await (await route.fetch()).json().catch(() => null);
          body = f(Object.fromEntries(u.searchParams), real);
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      });
    }
    await page.goto(`${base}/?ui=desktop&skin=${skin}#${hash}`, { waitUntil: 'load' });
    await page.waitForSelector('#nav a', { state: 'attached' });
    await settle(page);
    /* The last answer from a path (optionally narrowed by a query predicate). */
    const answer = (path, pred = null) => [...answers].reverse()
      .find((a) => a.path === path && (!pred || pred(a.query)))?.body;
    return { ctx, page, answers, answer };
  };
  const done = async () => {
    check('no page error anywhere in this file', errors.length === 0, errors.join(' | '));
    await browser?.close();
    srv?.close();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  };
  return { check, start, open, done, errors, get base() { return base; } };
}

export async function settle(page) {
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(200);
    if (!(await page.$('#view .skel'))) break;
  }
  await page.waitForTimeout(600);
}

/* What the contract promises, read off the rendered page. */
export const shape = (page) => page.evaluate(() => {
  const view = document.querySelector('#view');
  const txt = (n) => (n ? n.textContent.replace(/\s+/g, ' ').trim() : '');
  const tiles = [...view.querySelectorAll('.kpis.glance > .kpi')];
  return {
    first: view.firstElementChild?.className || '',
    heads: [...view.querySelectorAll('.panel>h3, .sechd-name')].map(txt),
    glance: tiles.length,
    glanceBands: view.querySelectorAll('.kpis.glance').length,
    hero: txt(view.querySelector('.kpis.glance .is-hero .l')),
    labels: tiles.map((t) => txt(t.querySelector('.l'))),
    values: Object.fromEntries(tiles.map((t) => [txt(t.querySelector('.l')), txt(t.querySelector('.n'))])),
    subs: Object.fromEntries(tiles.map((t) => [txt(t.querySelector('.l')), txt(t.querySelector('.s'))])),
    hrefs: Object.fromEntries(tiles.map((t) => [txt(t.querySelector('.l')), t.getAttribute('href')])),
    na: Object.fromEntries(tiles.filter((t) => t.querySelector('.t-na'))
      .map((t) => [txt(t.querySelector('.l')), txt(t.querySelector('.t-na'))])),
    /* A tile value that is a bare dash or a bare nought is the lie the house
       principle forbids (a figure that could not be measured, printed as
       one). A measured zero is legal, so pages opt a label out by name. */
    bare: tiles.map((t) => [txt(t.querySelector('.l')), txt(t.querySelector('.n'))])
      .filter(([, v]) => v === '—' || v === '-' || v === ''),
    vdctIn00: !!view.querySelector('.cband .vdct'),
    kpiRows: view.querySelectorAll('.kpis:not(.glance)').length,
    abs: [...view.querySelectorAll('.absband .absb-cell')].map((c) => ({
      label: txt(c.querySelector('.absb-lab')), fig: txt(c.querySelector('.absb-fig')),
      none: !!c.querySelector('.absb-none'), why: txt(c.querySelector('.absb-why')) })),
    hl: document.querySelectorAll('#view .hl, #pageFoot .hl').length,
    colophon: txt(document.querySelector('#pageFoot .pf-colophon')),
    srcInFoot: !!document.querySelector('#pageFoot .srcline'),
    rings: view.querySelectorAll('svg.donut').length,
    overflowX: document.documentElement.scrollWidth - window.innerWidth,
  };
});
