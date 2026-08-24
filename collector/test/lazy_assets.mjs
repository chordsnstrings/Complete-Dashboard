/* What a cold visit actually downloads — in a browser, counting real requests.
   ─────────────────────────────────────────────────────────────────────────
   smoke_views.mjs asks whether a page renders. This asks what it cost. They are
   different questions and the second one has no other check: a re-added
   <script src="/vendor/leaflet.js"> in index.html breaks nothing, renders
   identically, and quietly puts 159kb back in front of every first paint.

   test/assets.test.mjs guards the same thing by reading the source, which is
   fast and runs in CI. This proves the behaviour the source is supposed to
   produce: that Leaflet really is fetched on the three views that draw a map,
   really is not fetched on the ones that do not, and that the map still works
   when it arrives late. Source-reading cannot tell you the last one.

   Needs Chromium and a server. Same three targets as smoke_views:

     node mockapi.mjs &                 node test/lazy_assets.mjs
     node test/preview.mjs &            SMOKE_BASE=http://localhost:8100 …
     node bin/live-ui.mjs &             SMOKE_BASE=http://localhost:8100 … */
import { launchChromium } from './browser.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8099';
const MAPLESS = ['overview', 'vehicles', 'finance', 'roster'];
const MAPPED = ['map', 'vehicle/L45235/movement', 'driver/drv-0/territory'];

const browser = await launchChromium();

/* A fresh context per route, because the point is what a COLD visit pays. Share
   one page and the second map view fetches nothing — Leaflet is already on the
   window — which would make a map-less view look clean for the wrong reason. */
async function visit(route) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const seen = [], errs = [];
  page.on('request', (r) => seen.push(r.url()));
  page.on('pageerror', (e) => errs.push(String(e.message || e)));
  /* Map tiles come from openstreetmap.org. In a sandbox whose egress is a
     TLS-intercepting proxy Chromium rejects the certificate — that is the
     environment, not the page, and the map draws regardless. */
  page.on('console', (m) => {
    if (m.type() === 'error' && !/ERR_CERT_AUTHORITY_INVALID|tile\.openstreetmap/.test(m.text())) {
      errs.push(`console: ${m.text()}`);
    }
  });
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !document.querySelector('#view .skel'), null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const dom = await page.evaluate(() => ({
    hasL: typeof window.L === 'object',
    panes: document.querySelectorAll('.leaflet-pane').length,
    err: document.querySelector('#view .empty b')?.textContent || '',
  }));
  await ctx.close();
  return {
    dom, errs,
    leaflet: seen.filter((u) => /\/vendor\/leaflet\./.test(u)),
    thirdPartyFonts: seen.filter((u) => /fonts\.(googleapis|gstatic)\.com/.test(u)),
    localFonts: seen.filter((u) => /\.woff2(\?|$)/.test(u)),
  };
}

let bad = 0;
const note = (ok, line) => { if (!ok) bad++; console.log(`  ${ok ? '✓' : '✗'} ${line}`); };

console.log(`\nviews with no map (${BASE})`);
for (const route of MAPLESS) {
  const r = await visit(route);
  note(!r.dom.err && !r.errs.length, `#${route} rendered ${r.dom.err} ${r.errs.slice(0, 2).join('; ')}`);
  note(r.leaflet.length === 0, `#${route} fetched no leaflet ${r.leaflet.join(', ')}`);
  note(r.thirdPartyFonts.length === 0, `#${route} fetched no third-party fonts ${r.thirdPartyFonts.join(', ')}`);
  /* Self-hosting only helps if the files are reached. Zero woff2 requests on a
     text-heavy page means the @font-face rules are not matching anything and
     the page is silently in a system font. */
  note(r.localFonts.length > 0, `#${route} used the self-hosted fonts (${r.localFonts.length} woff2)`);
}

console.log('\nviews that draw a map');
for (const route of MAPPED) {
  const r = await visit(route);
  note(!r.dom.err && !r.errs.length, `#${route} rendered ${r.dom.err} ${r.errs.slice(0, 2).join('; ')}`);
  // Script and stylesheet, once each. Two panels on one page must not fetch twice.
  note(r.leaflet.length === 2, `#${route} fetched leaflet exactly once (${r.leaflet.length} requests)`);
  note(r.dom.hasL && r.dom.panes > 0, `#${route} drew the map (${r.dom.panes} panes)`);
  note(r.thirdPartyFonts.length === 0, `#${route} fetched no third-party fonts`);
}

await browser.close();
console.log(bad ? `\n${bad} check(s) failed` : '\nall checks passed');
process.exit(bad ? 1 : 0);
