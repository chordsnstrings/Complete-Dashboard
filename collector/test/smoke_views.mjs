/* Loads every route in a real browser against the local mock API and fails if
   any view throws or renders its error state.

   This exists because `node --check` passes on a missing import and the view
   then dies at runtime with "note is not defined" — a whole page blank, caught
   only by looking at it. Not part of `npm test`: it needs Chromium and the mock
   API. Run it before shipping UI changes:

     node mockapi.mjs &                 # port 8099
     node test/smoke_views.mjs

   Chromium is found by test/browser.mjs even when Playwright's own registry
   misses (a version drift against the preinstalled build); PW_CHROME overrides.

   Three targets, in increasing order of what they prove:

     node mockapi.mjs &                             tidy fixtures
     node test/preview.mjs &                        the real handlers and real
                                                    SQL over a seeded Postgres
     node bin/live-ui.mjs &                         the real handlers over the
     SMOKE_BASE=http://localhost:8100 …             PRODUCTION database

   The last is the one worth running before shipping a UI change. Fixture data
   is tidy by construction; production has the nulls, the numeric strings, the
   name collisions and the 89%-Uber shape that actually break a render. */
import { launchChromium } from './browser.mjs';

import { ROUTES } from './routes_list.mjs';

const BASE = process.env.SMOKE_BASE || 'http://localhost:8099';

/* The entity ids above are the mock's. Pointed at anything else — the preview
   server, or production — they 404, and a "not found" page renders cleanly, so
   every per-entity route passed while proving nothing about the pages that
   actually carry data. Ask the API which entities it has and substitute them.

   This is the difference between a smoke test that checks the mock renders and
   one that checks the PRODUCT renders: the mock's fixtures are tidy by
   construction, and the shapes that break a view — a null where a number was
   assumed, a name with no id, a driver with two accounts — only exist in real
   data. */
const api = async (p) => {
  try {
    const r = await fetch(`${BASE}${p}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
const WIN = 'from=2026-08-01&to=2026-08-31';
const first = (v) => (Array.isArray(v) ? v[0] : (v?.rows?.[0] ?? null));
const realDriver = first(await api(`/api/drivers/directory?${WIN}`));
const realVehicle = first(await api(`/api/vehicles/directory?${WIN}`));
const realProp = first(await api(`/api/corporate/properties?${WIN}`));
const realSeg = first(await api(`/api/segments?${WIN}`));
const SUB = {
  'drv-0': realDriver?.ids?.[0] || realDriver?.driver_ext_id,
  L45235: realVehicle?.plate,
  'h-palm': realProp?.partner_id,
};
const substituted = ROUTES.map((r) => {
  let out = r;
  for (const [from, to] of Object.entries(SUB)) {
    if (to) out = out.split(from).join(encodeURIComponent(to));
  }
  /* The segment address is (plate, started_at) and the timestamp has to be one
     that exists — a constructed one 404s and the page renders its own honest
     "no segment starts at that instant", which is not what this is testing. */
  if (out.startsWith('segment/') && !out.includes('not-a-time') && realSeg) {
    out = `segment/${encodeURIComponent(realSeg.plate)}/${encodeURIComponent(realSeg.started_at)}`;
  }
  return out;
});
/* SMOKE_ONLY narrows the sweep to the routes whose address contains it.
   ─────────────────────────────────────────────────────────────────────────
   Against the mock the full ninety are free. Against PRODUCTION they are not:
   ninety page loads is around a thousand requests to a one-vCPU database in
   ten minutes, and it falls over part-way through — so a run made to prove one
   new page renders against real data instead reports fifteen unrelated views
   timing out, and says nothing about any of them. Reviewing one page group is
   the common case for the production target; this makes it possible. */
const only = process.env.SMOKE_ONLY;
const routes = only ? substituted.filter((r) => r.includes(only)) : substituted;
if (only && !routes.length) {
  console.log(`  no route matches SMOKE_ONLY=${only}`);
  process.exit(1);
}
if (only) console.log(`  SMOKE_ONLY=${only}: ${routes.length} of ${substituted.length} routes`);
/* Say what is actually answering. Three servers can serve this UI — the mock,
   the preview against a seeded Postgres, and a proxy to production — and they
   all default to the same port. A run that silently hit a leftover process on
   8099 reported "81/81 against the mock" twice while talking to the preview. A
   test that cannot name its own subject is a test you cannot act on. */
const fp = await api(`/api/kpis?${WIN}`);
console.log(`  upstream ${BASE}: ${fp?.trips ?? '?'} trips, ${fp?.vehicles ?? '?'} vehicles, `
  + `${fp?.drivers ?? '?'} drivers`);
console.log(`  substituting driver=${SUB['drv-0'] || '(none found)'} `
  + `vehicle=${SUB.L45235 || '(none)'} property=${SUB['h-palm'] || '(none)'}`);

/* Outbound HTTPS in some environments goes through a local proxy, which the
   Node side picks up from HTTPS_PROXY automatically and Chromium does not —
   pointed at a remote BASE it fails with ERR_CONNECTION_RESET before the first
   page loads. Passed through when it is set and the target is not local. */
const proxy = process.env.HTTPS_PROXY && !/^https?:\/\/(localhost|127\.)/.test(BASE)
  ? { server: process.env.HTTPS_PROXY } : undefined;
// Chromium is resolved by test/browser.mjs — PW_CHROME still wins when set.
const browser = await launchChromium({ ...(proxy ? { proxy } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let bad = 0;

for (const route of routes) {
  const errs = [];
  const onErr = (e) => errs.push(String(e.message || e));
  page.on('pageerror', onErr);
  await page.goto(`${BASE}/#${route}`, { waitUntil: 'domcontentloaded' });
  /* Wait for the view to SETTLE, not for a fixed 900ms.
     Every panel renders a skeleton first and fills in when its fetch returns.
     Against the local mock 900ms was enough; against anything slower — the
     preview server's in-process Postgres, or a proxy to production — the page
     was still all skeletons, so this reported 81 of 81 views rendering while
     checking nothing but that the loaders appear. A fixed sleep is a test that
     passes faster the less it verifies. */
  await page.waitForFunction(
    () => !document.querySelector('#view .skel'),
    null, { timeout: 20000 },
  ).catch(() => {});
  await page.waitForTimeout(250);
  // The view's own catch-all renders "Could not load this view" — an empty
  // panel from missing fixture data is fine, a dead view is not.
  const err = await page.$('#view .empty b');
  const msg = err ? (await err.textContent()) || '' : '';

  /* And what it actually printed. A view that renders is not a view that
     works: "[object Object]" where a name should be, "NaN%" where a rate
     should be, and "undefined" anywhere are all things this product has
     shipped, and every one of them renders without throwing.

     Read from the rendered text, not the source, because these are produced by
     the interaction between real data and a render function — a null the
     fixture never had, a numeric string where a number was assumed, an object
     handed to a formatter expecting a scalar. */
  const text = await page.$eval('#view', (n2) => n2.innerText).catch(() => '');
  // A view still showing a skeleton after twenty seconds has not rendered.
  const stuck = /(^|\n)\s*Loading…\s*(\n|$)/.test(text);
  const garbage = [...new Set((text.match(
    /\[object Object\]|\bNaN\b|\bundefined\b|\bInfinity\b|AED\s*NaN|Invalid Date/g) || []))];

  const broke = /could not load/i.test(msg) || errs.length > 0 || garbage.length > 0 || stuck;
  if (broke) {
    bad++;
    console.log(`  ✗ #${route}  ${msg} ${errs.slice(0, 2).join('; ')}`
      + (stuck ? '  still loading after 20s' : '')
      + (garbage.length ? `  rendered: ${garbage.join(', ')}` : ''));
  } else console.log(`  ✓ #${route}`);
  page.off('pageerror', onErr);
}

console.log(`\n${routes.length - bad}/${routes.length} views rendered against ${BASE}`);
await browser.close();
process.exit(bad ? 1 : 0);
