#!/usr/bin/env node
/* Every page of production, full-height, in one archive.
   ─────────────────────────────────────────────────────────────────────────
   bin/prod-shot.mjs shoots the routes you name and prints what each one says;
   it is the tool for checking a fix. This is the tool for handing somebody the
   whole product: it walks every destination the dashboard has, shoots each at
   full page height, and packs the lot into a single zip with a contact sheet.

   It shoots through bin/prod-mirror.mjs, so the markup, the scripts, the
   stylesheet and the data are production's own bytes (that file explains why a
   browser here cannot reach the origin directly). Start the mirror first:

       node bin/prod-mirror.mjs &
       node bin/prod-shot-all.mjs

   Three things it does that a for-loop over prod-shot.mjs would not:

   1. Real entity ids, resolved at run time. A third of these pages are ABOUT
      something — a driver, a vehicle, a hotel, a booking, one GPS segment. The
      route list carries placeholders and this asks production which entities it
      actually has, because `driver/drv-0` renders a tidy "not found" page and a
      "not found" page is not a screenshot of the Drivers detail view.

   2. A basemap. #live, #map and a driver's territory tab pull tiles straight
      from openstreetmap.org, which Chromium in this sandbox cannot reach —
      leaving a grey square where the map goes. Node CAN reach it, so tile
      requests are fulfilled through Node the same way the rest of the page is.

   3. It waits for the page, not for the clock. Every panel renders a skeleton
      and fills when its fetch returns; this blocks until the last skeleton is
      gone, so a slow page is shot full rather than shot empty, and a fast one
      does not cost nine seconds.

   Each shot is checked before it is kept — a page still on its skeleton, one
   showing the view's own "could not load", or one that printed NaN/undefined
   into the markup is listed at the end and counted as a failure, so an archive
   of ninety screenshots cannot quietly contain six broken ones.

       WIDTH=412 node bin/prod-shot-all.mjs      # shoot it as a phone
       ONLY=roster,vehicles node bin/prod-shot-all.mjs
       OUT=/tmp/shots node bin/prod-shot-all.mjs
       QUANT=1 node bin/prod-shot-all.mjs        # an archive you can send
*/
import { launchChromium } from '../test/browser.mjs';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const BASE = process.env.BASE || 'http://127.0.0.1:8200';
const WIDTH = Number(process.env.WIDTH || 1440);
const OUT = resolve(process.env.OUT || `docs/audit/shots/all-${WIDTH}`);
const ZIP = process.env.ZIP || `${OUT}.zip`;
const READY_MS = Number(process.env.READY_MS || 30000);
const SETTLE = Number(process.env.SETTLE || 600);
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
/* Full-height shots of a product with forty-thousand-pixel tables run to eighty
   megabytes, and PNG is already deflate so the zip takes off about a tenth —
   past what most places accept as an attachment. QUANT=1 palettes them through
   pngquant, which is a third of the size for a screenshot of a UI: flat fills,
   one typeface and a handful of chart colours quantise to 256 without a visible
   difference, checked against the map page as the only one carrying anything
   photographic. Off by default, because this doubles as the render audit's
   evidence and that wants the pixels it shot. */
const QUANT = process.env.QUANT === '1';

/* ─────────── the pages ───────────
   In sidebar order, so the archive reads like the product. A `:name` is a
   placeholder filled from the live API below. Deliberately NOT here: the
   not-a-date / nonsense / no-such-category routes test/routes_list.mjs carries
   to prove the error states render. Those are fixtures for a test, not pages
   of the product, and a reader handed "Unauthorized trips (nonsense filter)"
   would reasonably wonder what went wrong. */
const PAGES = [
  ['Money', 'Unit economics', 'unit'],
  ['Money', 'Unit economics — every vehicle', 'unit/assets'],
  ['Money', 'Unit economics — every driver', 'unit/drivers'],
  ['Money', 'Revenue by channel', 'revenue'],
  ['Money', 'Reconciliation', 'reconcile'],
  ['Money', 'Reconciliation — one month', 'reconcile/:month'],
  ['Money', 'Finance', 'finance'],
  ['Money', 'Settlement', 'settlement'],
  ['Money', 'Settlement — cash in hand', 'settlement/cash'],
  ['Money', 'Settlement — outstanding', 'settlement/receivables'],
  ['Money', 'Corporate & hotels', 'corporate'],
  ['Money', 'Corporate — properties', 'corporate/properties'],
  ['Money', 'Corporate — guests', 'corporate/guests'],
  ['Money', 'Corporate — leakage', 'corporate/leakage'],
  ['Money', 'Corporate — leakage, complimentary', 'corporate/leakage/complimentary'],
  ['Money', 'Corporate — approach', 'corporate/approach'],
  ['Money', 'Corporate — approach by daypart', 'corporate/approach/daypart'],
  ['Money', 'One property', 'property/:property'],
  ['Money', 'One property — guests', 'property/:property/guests'],
  ['Money', 'One property — drivers', 'property/:property/drivers'],

  ['Work', 'Fleet activity', 'overview'],
  ['Work', 'Demand', 'demand'],
  ['Work', 'One day', 'day/:day'],
  ['Work', 'Today vs yesterday', 'compare'],
  ['Work', 'Compare — one day', 'compare/:day'],
  ['Work', 'Compare — two days', 'compare/:day/:prevDay'],
  ['Work', 'Platforms', 'platforms'],
  ['Work', 'Platforms — product tiers', 'platforms/tiers'],
  ['Work', 'Platforms — acceptance funnel', 'platforms/funnel'],
  ['Work', 'Corridors', 'corridors'],

  ['People', 'Top performers', 'top-performers'],
  ['People', 'Low performers', 'low-performers'],
  ['People', 'One person’s week', 'performer/:driver'],
  ['People', 'Drivers', 'drivers'],
  ['People', 'One driver', 'driver/:driver'],
  ['People', 'One driver — activity', 'driver/:driver/activity'],
  ['People', 'One driver — territory', 'driver/:driver/territory'],
  ['People', 'One driver — earnings', 'driver/:driver/earnings'],
  ['People', 'One driver — quality', 'driver/:driver/quality'],
  ['People', 'One driver — trips', 'driver/:driver/trips'],
  ['People', 'One booking', 'trip/:tripPlatform/:tripId'],
  ['People', 'Roster & supply', 'roster'],
  ['People', 'Roster — pipeline', 'roster/pipeline'],
  ['People', 'Roster — idle', 'roster/idle'],
  ['People', 'Roster — blocked', 'roster/blocked'],
  ['People', 'Roster — states', 'roster/states'],
  ['People', 'Joiners & leavers', 'retention'],
  ['People', 'Compliance', 'compliance'],

  ['Assets', 'Vehicles', 'vehicles'],
  ['Assets', 'One vehicle', 'vehicle/:vehicle'],
  ['Assets', 'One vehicle — drivers', 'vehicle/:vehicle/drivers'],
  ['Assets', 'One vehicle — movement', 'vehicle/:vehicle/movement'],
  ['Assets', 'One vehicle — earnings', 'vehicle/:vehicle/earnings'],
  ['Assets', 'One vehicle — safety', 'vehicle/:vehicle/safety'],
  ['Assets', 'One vehicle — compliance', 'vehicle/:vehicle/compliance'],
  ['Assets', 'One vehicle — trips', 'vehicle/:vehicle/trips'],
  ['Assets', 'Unauthorized trips', 'unauthorized'],
  ['Assets', 'Segments', 'segments'],
  ['Assets', 'Segments — unauthorized only', 'segments/verdict/unauthorized'],
  ['Assets', 'Segments — authorized only', 'segments/verdict/authorized'],
  ['Assets', 'Segments — one vehicle', 'segments/plate/:vehicle'],
  ['Assets', 'Segments — one day', 'segments/day/:day'],
  ['Assets', 'Segments — one driver', 'segments/driver/:driverName'],
  ['Assets', 'One segment', 'segment/:segPlate/:segAt'],
  ['Assets', 'Safety', 'safety'],
  ['Assets', 'Safety — by vehicle', 'safety/vehicles'],
  ['Assets', 'Safety — events', 'safety/events'],
  ['Assets', 'Live fleet', 'live'],
  ['Assets', 'Map & replay', 'map'],
  ['Assets', 'Map — replay one vehicle', 'map/replay/:vehicle'],

  ['Decide', 'Why it moved', 'causes'],
  ['Decide', 'Forecast', 'forecast'],
  ['Decide', 'To-do list', 'playbook'],
  ['Decide', 'Rota gaps', 'capacity'],
  ['Decide', 'Rota gaps — one slot', 'slot/2/19'],
  ['Decide', 'Action list', 'insights'],
  ['Decide', 'Action list — critical only', 'insights/severity/critical'],
  ['Decide', 'Action list — safety only', 'insights/safety'],
  ['Decide', 'One action', 'action/:actionCode/:actionEntity'],
  ['Decide', 'Analyst', 'analyst'],
  ['Decide', 'Analyst — refuted', 'analyst/refuted'],
  ['Decide', 'Analyst — immaterial', 'analyst/immaterial'],
  ['Decide', 'Analyst — unsupported', 'analyst/unsupported'],
  ['Decide', 'Analyst — rules', 'analyst/rules'],

  ['Trust', 'Data sources', 'sources'],
  ['Trust', 'Collection gaps', 'coverage'],
  ['Trust', 'What each API offers', 'providers'],
  ['Trust', 'Providers — one field’s values', 'providers/uber/trips/:rawField'],

  ['Set up', 'Settings', 'settings'],
];

/* ─────────── real ids ───────────
   Asked of the API rather than pinned in the source, because a pinned id is
   right until that driver leaves. Each lookup falls back to the mock's id, so
   a resolver that fails costs one page rather than the run. */
const api = async (p) => {
  try {
    const r = await fetch(`${BASE}${p}`);
    return r.ok ? await r.json() : null;
  } catch { return null; }
};
const rows = (v) => (Array.isArray(v) ? v : (v?.rows ?? []));
const iso = (d) => d.toISOString().slice(0, 10);

const today = new Date();
const day = iso(new Date(today.getTime() - 864e5));          // yesterday: a full day
const prevDay = iso(new Date(today.getTime() - 2 * 864e5));
const WIN = `from=${iso(new Date(today.getTime() - 30 * 864e5))}&to=${iso(today)}`;

process.stdout.write('resolving live ids … ');
const YEAR = `from=${iso(new Date(today.getTime() - 364 * 864e5))}&to=${iso(today)}`;
const [drv, veh, prop, seg, ins, raw] = await Promise.all([
  api(`/api/drivers/directory?${WIN}`), api(`/api/vehicles/directory?${WIN}`),
  api(`/api/corporate/properties?${WIN}`), api(`/api/segments?${WIN}`),
  api(`/api/insights?${WIN}`), api(`/api/schema/raw-fields?table=trip&platform=uber&${YEAR}`),
]);
const driver = rows(drv)[0] || {};
const vehicle = rows(veh)[0] || {};
const segment = rows(seg)[0] || {};
const driverId = driver.ids?.[0] || driver.driver_ext_id || 'drv-0';
const trip = rows(await api(`/api/driver/trips?id=${encodeURIComponent(driverId)}&${WIN}`))[0] || {};

/* The action page and the raw-field drill-down are ABOUT a thing too, and the
   thing has to be one that exists. `action/idle_vehicle/<busiest vehicle>` and
   a hand-picked field name both rendered correctly — as "that finding is no
   longer open" and "no stored record carries this field", which are true
   sentences and useless screenshots. So: whatever the action list is actually
   raising, and a field with a distribution worth reading (a couple of dozen
   values at most — a UUID column that is 100% distinct says nothing). */
const insight = (ins?.insights ?? [])[0] || {};
const field = (raw?.fields ?? [])
  .filter((f) => f.distinct_values > 1 && f.distinct_values <= 50)
  .sort((a, b) => (b.fill_pct - a.fill_pct) || (b.distinct_values - a.distinct_values))[0];

const ID = {
  driver: driverId,
  driverName: driver.driver_name || 'Ahmed',
  vehicle: vehicle.plate || 'L45235',
  property: rows(prop)[0]?.partner_id || 'h-palm',
  day,
  prevDay,
  month: day.slice(0, 7),
  tripPlatform: trip.platform || 'uber',
  tripId: trip.external_id || 'none',
  segPlate: segment.plate || vehicle.plate || 'L45235',
  segAt: segment.started_at || `${day}T04:00:00.000Z`,
  actionCode: insight.code || 'idle_vehicle',
  actionEntity: insight.entity_id || vehicle.plate || 'L45235',
  rawField: field?.key || 'Payment type',
};
console.log(Object.entries(ID).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join('  '));

const fill = (r) => r.replace(/:([a-zA-Z]+)/g, (m, k) => (k in ID ? encodeURIComponent(ID[k]) : m));
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'home';

let list = PAGES.map(([grp, label, route]) => ({ grp, label, route: fill(route), raw: route }));
if (ONLY.length) list = list.filter((p) => ONLY.some((o) => p.raw.startsWith(o)));

/* ─────────── shoot ─────────── */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: WIDTH, height: 1000 } });

/* The basemap. Chromium here has no route off the box; Node does. Without this
   #live and #map are a grey rectangle with the fleet's markers floating on
   nothing, which looks like a broken map rather than a working one. */
const tiles = new Map();
await page.route('**://*.tile.openstreetmap.org/**', async (route) => {
  const url = route.request().url();
  if (tiles.has(url)) return route.fulfill({ status: 200, contentType: 'image/png', body: tiles.get(url) });
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'fleet-dashboard-audit/1.0' } });
    const body = Buffer.from(await r.arrayBuffer());
    tiles.set(url, body);
    return route.fulfill({ status: r.status, contentType: 'image/png', body });
  } catch { return route.abort(); }
});

const errs = [];
page.on('pageerror', (e) => errs.push(`js: ${String(e.message).slice(0, 100)}`));
page.on('response', (r) => {
  if (r.url().includes('/api/') && r.status() >= 400) {
    errs.push(`${r.status()} ${r.url().split(/:\d+/)[1]?.slice(0, 60)}`);
  }
});

const shots = [];
let n = 0;
for (const p of list) {
  n += 1;
  errs.length = 0;
  const file = `${String(n).padStart(2, '0')}-${slug(p.grp)}-${slug(p.label)}.png`;
  await page.goto(`${BASE}/#${p.route}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // The page is ready when the last panel has swapped its skeleton for content.
  const settled = await page.waitForFunction(
    () => !document.querySelector('#view .skel'), null, { timeout: READY_MS },
  ).then(() => true).catch(() => false);
  // Charts and the leaflet canvas paint a frame after their data lands.
  await page.waitForTimeout(SETTLE);
  if (p.raw.startsWith('map') || p.raw === 'live' || p.raw.endsWith('/territory')) {
    await page.waitForTimeout(2500);                       // tiles, over a cold cache
  }
  await page.screenshot({ path: join(OUT, file), fullPage: true });

  const seen = await page.evaluate(() => {
    const root = document.querySelector('#view');
    const text = root?.innerText || '';
    return {
      title: (document.querySelector('#viewTitle')?.textContent || '').trim(),
      h: Math.max(document.body.scrollHeight, root?.scrollHeight || 0),
      panels: root?.querySelectorAll('.panel').length || 0,
      dead: /could not load/i.test(root?.querySelector('.empty b')?.textContent || ''),
      garbage: [...new Set((text.match(/\[object Object\]|\bNaN\b|\bundefined\b|Invalid Date/g) || []))],
    };
  });

  const bad = [];
  if (!settled) bad.push('still on the skeleton');
  if (seen.dead) bad.push('view could not load');
  if (seen.garbage.length) bad.push(`rendered ${seen.garbage.join(', ')}`);
  if (errs.length) bad.push([...new Set(errs)].slice(0, 2).join(' · '));
  const bytes = statSync(join(OUT, file)).size;
  shots.push({ ...p, file, bytes, ...seen, bad });
  console.log(`  ${bad.length ? '✗' : '✓'} ${String(n).padStart(2)}/${list.length} ${p.label.padEnd(38)}`
    + `${String(WIDTH)}×${String(seen.h).padStart(5)}  ${(bytes / 1024).toFixed(0).padStart(5)} KB`
    + `${bad.length ? `   ${bad.join(' · ')}` : ''}`);
}
await browser.close();

/* ─────────── the archive ───────────
   A contact sheet, because ninety files named by their route is a directory
   listing and not something anybody looks through. Relative hrefs, so it works
   from wherever it is unzipped and needs nothing to be running. */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const groups = [...new Set(shots.map((s) => s.grp))];
const sheet = `<!doctype html><meta charset="utf-8"><title>Production — every page</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:32px;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
      background:#0f1115;color:#e8eaf0}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8b93a7;margin:0 0 28px;font-size:13px}
 h2{font-size:12px;letter-spacing:.10em;text-transform:uppercase;color:#8b93a7;
    margin:34px 0 12px;padding-bottom:8px;border-bottom:1px solid #232733}
 .g{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px}
 a{display:block;text-decoration:none;color:inherit}
 .t{height:170px;overflow:hidden;border:1px solid #232733;border-radius:7px;background:#171a21}
 .t img{width:100%;display:block}
 a:hover .t{border-color:#4d7cfe}
 .n{margin-top:8px;font-weight:600;font-size:13px}
 .m{color:#8b93a7;font-size:11.5px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 .warn{color:#f0a35e}
</style>
<h1>Production — every page</h1>
<p class="sub">${shots.length} pages · full height at ${WIDTH}px · captured ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC
from <code>${esc(process.env.UPSTREAM || 'https://fleet-dashboard-wpeqb.ondigitalocean.app')}</code></p>
${groups.map((g) => `<h2>${esc(g)}</h2><div class="g">${shots.filter((s) => s.grp === g).map((s) => `
 <a href="${esc(s.file)}"><div class="t"><img loading="lazy" src="${esc(s.file)}" alt=""></div>
  <div class="n">${esc(s.label)}</div>
  <div class="m">#${esc(s.route)}</div>
  ${s.bad.length ? `<div class="m warn">${esc(s.bad.join(' · '))}</div>` : ''}</a>`).join('')}</div>`).join('')}
`;
writeFileSync(join(OUT, 'index.html'), sheet);

const csv = ['file,group,page,route,width,height,bytes,panels,issues',
  ...shots.map((s) => [s.file, s.grp, s.label, `#${s.route}`, WIDTH, s.h, s.bytes, s.panels,
    s.bad.join('; ')].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
writeFileSync(join(OUT, 'manifest.csv'), `${csv}\n`);

if (QUANT) {
  try {
    execFileSync('sh', ['-c', 'ls *.png | xargs -P 8 -I{} pngquant --quality=70-95 --speed 1 '
      + '--force --ext .png {}'], { cwd: OUT, stdio: 'ignore' });
  } catch { /* pngquant exits non-zero for a file it cannot better; that one keeps its original */ }
}

rmSync(ZIP, { force: true });
try {
  execFileSync('zip', ['-r', '-q', '-9', ZIP, '.'], { cwd: OUT });
} catch (e) {
  console.log(`\ncould not zip (${String(e.message).slice(0, 60)}) — the PNGs are in ${OUT}`);
}

const total = shots.reduce((a, s) => a + statSync(join(OUT, s.file)).size, 0);
const broken = shots.filter((s) => s.bad.length);
console.log(`\n${shots.length} pages · ${(total / 1048576).toFixed(1)} MB of PNG`
  + `${statSync(ZIP, { throwIfNoEntry: false }) ? ` · ${(statSync(ZIP).size / 1048576).toFixed(1)} MB zipped → ${ZIP}` : ''}`);
if (broken.length) {
  console.log(`\n${broken.length} page(s) did not render cleanly:`);
  broken.forEach((s) => console.log(`  ✗ #${s.route}  ${s.bad.join(' · ')}`));
}
process.exit(broken.length ? 1 : 0);
