/* The old skin does not move while the page phase converts every page.
   ═══════════════════════════════════════════════════════════════════════════
   The Arkiv page phase (docs/UI-REDESIGN-PLAN.md "Order of work" STEP 6)
   converts every desktop page to the page contract, gated on ui.js
   contract() — the --pg-contract token — so production, which still draws
   the old skin, keeps today's page byte for byte until the operator flips
   the default. "Byte for byte" was, until this file, a claim each step
   proved once with a scratchpad harness and nothing held afterwards; a page
   converted in commit N could have its classic branch disturbed by commit
   N+7 and nothing would notice.

   What this holds: every route in test/routes_list.mjs, rendered in the OLD
   skin (?skin=classic) at 1440×900 against the mock, with both clocks frozen
   (the Node process serving the mock and the browser) and the mock's
   Math.random pinned, produces a #view — plus the title block setHeader()
   writes — whose normalised HTML hashes to the value recorded from the
   commit the page phase started from (abb79ad). A classic branch that
   changes by one attribute changes its hash.

   Normalised means two things only, both noise rather than product:
     · the ids charts.js draws from Math.random() (`ht…`, `gh…`, `g…`, `sb…`),
       renumbered in order of first appearance;
     · a Leaflet map's tile pane, whose <img> tiles load or fail on a network
       this sandbox does not have.

   RE-RECORDING. The fixture is the BASE's rendering, never the working
   tree's — recording from the tree would bless whatever it now draws. If a
   legitimate change to the old skin lands (a fix the operator wants on
   production before the flip), or mockapi.mjs changes, re-record from a copy
   of the public/ tree the old skin should equal:

       git archive <base> collector/api/public | tar -x -C /tmp/base
       RECORD=1 PUBLIC_DIR=/tmp/base/collector/api/public \
         node test/arkiv_classic_frozen.test.mjs

   and say in the commit which change moved which page. ONLY=<substring>
   narrows a run to the routes whose address contains it. A failing route's
   normalised HTML is written to $TMPDIR (or /tmp) for a diff.

   Synthetic data only (the mock). */
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/* ── both clocks, frozen, BEFORE the mock is imported ─────────────────────
   The mock builds its days from Date.now() (dayISO, HR_TODAY, the payout
   week), so its answers change every day; the page windows its requests from
   the browser's clock. Both are pinned to the instant the STEP 3 and STEP 4
   pixel harnesses used. A dynamic import, because a static one is hoisted
   above this assignment. */
const FIXED = Date.parse('2026-09-23T08:00:00Z');
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
}
globalThis.Date = FrozenDate;
/* The mock's few Math.random() calls (live positions, a leaderboard's jitter,
   the coverage calendar) are answered in whatever order concurrent requests
   arrive, so a seeded sequence would still differ run to run. A constant
   does not. */
Math.random = () => 0.5;
const { app: mock } = await import('../mockapi.mjs');
const { ROUTES } = await import('./routes_list.mjs');
const { launchChromium } = await import('./browser.mjs');
const express = (await import('express')).default;

const FIX = new URL('./fixtures/arkiv_classic_frozen.json', import.meta.url);
const RECORD = process.env.RECORD === '1';
const ONLY = process.env.ONLY || '';
const PUBLIC_DIR = process.env.PUBLIC_DIR || null;
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The front end served from PUBLIC_DIR when recording from a base tree, the
   API always from the (in-process, frozen) mock. */
const web = express();
if (PUBLIC_DIR) web.use(express.static(PUBLIC_DIR));
web.use(mock);
const srv = web.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

/* Routes whose old-skin rendering is not a function of its inputs, each with
   the reason. Empty is the goal; a route is added here only with a measured
   cause, never to make a run green. */
const UNSTABLE = {};

const browser = await launchChromium();
const routes = ROUTES.filter((r) => !UNSTABLE[r] && (!ONLY || r.includes(ONLY)));

async function capture(route) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block',
    reducedMotion: 'reduce', timezoneId: 'Asia/Dubai', locale: 'en-GB' });
  await ctx.clock.setFixedTime(new RealDate(FIXED));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));
  await page.goto(`${base}/?ui=desktop&skin=classic#${route}`, { waitUntil: 'load' });
  await page.waitForSelector('#nav a');
  /* Settled: no skeleton left, fonts in, and two reads a beat apart agree. */
  let prev = null, html = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    if (await page.$('#view .skel')) continue;
    html = await page.evaluate(async () => {
      await document.fonts.ready;
      const v = document.querySelector('#view').cloneNode(true);
      v.querySelectorAll('.leaflet-tile-pane').forEach((n) => { n.innerHTML = ''; });
      const head = ['#crumb', '#viewTitle', '#viewSub']
        .map((s) => `${s}=${document.querySelector(s)?.textContent ?? ''}`).join('\n');
      return `${head}\n${v.outerHTML}`;
    });
    if (html === prev) break;
    prev = html;
  }
  await ctx.close();
  /* charts.js ids, renumbered in order of first appearance. */
  const ids = [...new Set([...html.matchAll(/\bid="((?:ht|gh|g|sb)[0-9a-z]{5})\b[^"]*"/g)].map((m) => m[1]))];
  let norm = html;
  ids.forEach((id, i) => { norm = norm.split(id).join(`__rid${i}__`); });
  return { norm, errors };
}

const want = existsSync(FIX) ? JSON.parse(readFileSync(FIX, 'utf8')) : {};
const got = {};
const out = mkdtempSync(join(tmpdir(), 'arkiv-classic-'));
console.log(`\nThe old skin, ${routes.length} routes at 1440, clocks frozen at 2026-09-23T08:00Z`
  + `${RECORD ? ` — RECORDING from ${PUBLIC_DIR || 'the working tree'}` : ''}`);
const queue = [...routes];
const worker = async () => {
  while (queue.length) {
    const r = queue.shift();
    const { norm, errors } = await capture(r);
    const h = createHash('sha256').update(norm).digest('hex').slice(0, 16);
    got[r] = h;
    if (RECORD) { console.log(`  · ${r} ${h}${errors.length ? ` (page error: ${errors[0]})` : ''}`); continue; }
    if (!want[r]) { check(`${r}: recorded`, false, 'no hash in the fixture — re-record from the base'); continue; }
    const ok = want[r] === h;
    if (!ok) writeFileSync(join(out, `${r.replace(/[^a-z0-9]+/gi, '_')}.html`), norm);
    check(`${r}: the old skin renders what it did`, ok, ok ? '' : `${h} ≠ ${want[r]} (written to ${out})`);
  }
};
await Promise.all([worker(), worker(), worker(), worker()]);

if (RECORD) {
  const merged = ONLY ? { ...want, ...got } : got;
  writeFileSync(FIX, `${JSON.stringify(Object.fromEntries(Object.entries(merged).sort()), null, 1)}\n`);
  console.log(`\nrecorded ${Object.keys(got).length} routes into ${FIX.pathname}`);
} else {
  check('every route in routes_list.mjs is held (or named in UNSTABLE with its reason)',
    ONLY || ROUTES.every((r) => want[r] || UNSTABLE[r]),
    ROUTES.filter((r) => !want[r] && !UNSTABLE[r]).join(' '));
}
await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
