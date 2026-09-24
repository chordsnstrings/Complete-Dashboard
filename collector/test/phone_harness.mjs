/* The phone build, served hermetically: no mock server, no network, no clock.
   ─────────────────────────────────────────────────────────────────────────
   The phone redesign has to prove two things about the SAME data: that the old
   skin's DOM did not move by one byte, and that the Arkiv screens print every
   figure and every reason the old ones did. Neither can be proved against
   mockapi.mjs as it stands — it answers from Math.random() and the server's
   clock, so two renders a second apart disagree before any front-end code is
   involved — and neither can be proved against production, which moves every
   half hour.

   So every request the page makes is answered HERE, by Playwright's router:
   the static files straight off disk (the working tree, or any other tree a
   caller names — the oracle is built from the commit before the redesign),
   and every /api/ call from one recorded fixture, test/fixtures/phone_api.json
   (bin/phone-fixture.mjs records it from the mock). The page's clock is fixed
   at the instant the fixture was recorded, so windowDates(), todayLive()'s
   minute stamp and splitToday() ask for exactly the URLs that were recorded
   and read "today" the way the recording did. A request the fixture does not
   hold is answered 404 and REPORTED, never silently — a screen that quietly
   rendered its error state would pass a structure check for the wrong reason.

   No port is opened, so this cannot collide with the mock another agent's
   suite is running, and nothing here depends on the hour: the evening trap in
   docs/COVERAGE.md (the mock's today being UTC's) does not reach it. */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { launchChromium } from './browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PUB = join(HERE, '..', 'api', 'public');
export const ORIGIN = 'http://phone.test';
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

/* Every phone screen, and the few states a thumb reaches with one tap that
   draw a different list. `tap` is a CSS selector clicked after the screen
   settles; its snapshot is taken under the same name with `+tap`. The
   desktop modules the fallback renders (a driver's or a vehicle's TAB) are
   the desktop agent's DOM, not the phone's, so they are measured for
   overflow under the skin but kept out of the old-skin oracle. */
export const SCREENS = [
  { route: 'today' },
  { route: 'money' },
  { route: 'people' },
  { route: 'people', tap: '.m-seg button[data-id="money"]', as: 'people+money' },
  { route: 'fleet' },
  { route: 'fleet', tap: '.m-seg button[data-id="revenue"]', as: 'fleet+fares' },
  { route: 'more' },
  { route: 'live' },
  { route: 'safety' },
  { route: 'unauthorized' },
  { route: 'sources' },
  { route: 'corporate' },
  { route: 'analyst' },
  { route: 'credentials' },
  { route: 'optimise' },
  { route: 'optimise', tap: '.m-seg button[data-id="places"]', as: 'optimise+where' },
  { route: 'trips' },
  { route: 'online-time' },
  { route: 'online-time', tap: '.m-seg button[data-id="all"]', as: 'online-time+all' },
  { route: 'online-time', tap: '.m-seg button[data-id="grey"]', as: 'online-time+grey' },
  { route: 'payouts' },
  { route: 'deposits' },
  { route: 'driver/drv-0' },
  { route: 'vehicle/L45235' },
  { route: 'nonsense' },
];
export const DESKTOP_TABS = ['driver/drv-0/earnings', 'vehicle/L45235/drivers'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

export function loadFixture(file = join(HERE, 'fixtures', 'phone_api.json.gz')) {
  if (!existsSync(file)) return null;
  const raw = file.endsWith('.gz') ? gunzipSync(readFileSync(file)).toString('utf8') : readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

/* The key a request is recorded under: path and query, exactly as the page
   asked. A pull-to-refresh or a cache-buster would change it, and none of the
   screens under test sends one. */
export const keyOf = (u) => { const x = new URL(u); return x.pathname + x.search; };

export async function launch() { return launchChromium(); }

/* One phone page. `answer(key, route)` may be passed to record instead of
   replay (bin/phone-fixture.mjs); otherwise the fixture answers. */
export async function phonePage(browser, {
  skin = 'classic', theme = 'light', width = 390, height = 844, fixture = null,
  root = PUB, answer = null, at = null,
} = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: 1, isMobile: true, hasTouch: true,
    colorScheme: theme === 'dark' ? 'dark' : 'light', serviceWorkers: 'block',
  });
  const page = await ctx.newPage();
  const misses = new Set();
  const errors = [];
  let inflight = 0;
  let lastActivity = Date.now();
  page.on('pageerror', (e) => errors.push(e.message));
  /* Anything off this origin — a driver's photograph on CloudFront, say — is
     answered at once with a one-pixel image. Left to the network it failed
     whenever the sandbox's connection gave up; refused, it failed only once
     the lazy <img> scrolled near enough to load. Either way an avatar that
     has or has not turned into "could not be loaded" by the time the DOM is
     read is a test that passes on alternate runs (measured: 1 run in 6). A
     photograph that LOADS draws the same DOM whenever it loads, and whether
     it ever does. */
  await page.route((u) => !u.href.startsWith(ORIGIN), async (route) => {
    inflight += 1; lastActivity = Date.now();
    try { await route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }); }
    finally { inflight -= 1; lastActivity = Date.now(); }
  });
  await page.route(`${ORIGIN}/**`, async (route) => {
    inflight += 1; lastActivity = Date.now();
    try {
      const url = route.request().url();
      const key = keyOf(url);
      const path = new URL(url).pathname;
      if (path.startsWith('/api/')) {
        if (answer) { await answer(key, route); return; }
        const hit = fixture?.answers?.[key];
        if (!hit) {
          misses.add(key);
          await route.fulfill({ status: 404, contentType: 'application/json',
            body: JSON.stringify({ error: 'not in the phone fixture' }) });
          return;
        }
        await route.fulfill({ status: hit.status, contentType: hit.type || 'application/json',
          body: hit.b64 ? Buffer.from(hit.b64, 'base64') : hit.body });
        return;
      }
      const rel = path === '/' ? '/index.html' : decodeURIComponent(path);
      const file = join(root, rel);
      if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
        await route.fulfill({ status: 404, body: 'not found' });
        return;
      }
      await route.fulfill({ status: 200, contentType: TYPES[extname(file)] || 'application/octet-stream',
        body: readFileSync(file) });
    } finally { inflight -= 1; lastActivity = Date.now(); }
  });
  const clock = at || fixture?.at;
  if (clock) await page.clock.setFixedTime(new Date(clock));
  /* The theme the reader chose, where one is asked for by name rather than by
     the OS: index.html stamps data-theme from this key before the first
     paint, on the phone as on the desktop. */
  if (theme === 'dark-chosen' || theme === 'light-chosen') {
    await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* none */ } },
      theme.replace('-chosen', ''));
  }
  const settle = async (quiet = 450, cap = 20000) => {
    const end = Date.now() + cap;
    while (Date.now() < end) {
      if (inflight === 0 && Date.now() - lastActivity > quiet) {
        /* …and nothing is still painting a skeleton. */
        const busy = await page.evaluate(() => !!document.querySelector('#m .m-skel'));
        if (!busy) return true;
      }
      await page.waitForTimeout(60);
    }
    return false;
  };
  const open = async (route) => {
    await page.goto(`${ORIGIN}/?ui=phone&skin=${skin}#${route}`, { waitUntil: 'domcontentloaded' });
    await settle();
  };
  return { ctx, page, misses, errors, settle, open, close: () => ctx.close() };
}

/* The phone's DOM, as a string two trees can be compared by. The desktop
   modules draw charts with Math.random() ids, and a photograph's load order
   is the browser's, so both are normalised; nothing else is. */
export const domOf = (page) => page.evaluate(() => {
  const m = document.getElementById('m');
  const sheet = [...document.body.children].filter((c) => /m-(scrim|sheet)/.test(c.className))
    .map((c) => c.outerHTML).join('');
  return (m ? m.outerHTML : '') + sheet;
}).then((h) => h
  .replace(/\b(ht|gh|g|sb)[a-z0-9]{5}\b/g, '$1#####')
  .replace(/ style="animation-delay:[^"]*"/g, ''));

/* The words on the screen, one per text node — what a reader can read. */
export const wordsOf = (page, sel = '#m .m-deck') => page.evaluate((s) => {
  const host = document.querySelector(s);
  if (!host) return [];
  const out = [];
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.textContent.replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}, sel);
