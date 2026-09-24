/* FleetMirror: the name and the mark — the operator, 2026-09-24: "let's
   change the name to FleetMirror and the logo to this", with the artwork in
   three files (on dark, on light, transparent).
   ═══════════════════════════════════════════════════════════════════════════
   What this holds down:
   1. The name, everywhere the product names itself: the tab title, the iOS
      home-screen title, the manifest, the old skin's rail, the Arkiv
      masthead, the phone's wordmark (the mark, with the name for a screen
      reader) and its More masthead, and the phone's per-screen tab titles.
      "Fleet" as a SECTION and a column name is not the brand and stays.
   2. The mark is the operator's artwork, not a redrawing: the icons are the
      on-dark file resized, the light-page mark is the transparent file
      cropped, and the dark-page mark is the same shapes with the black half in
      the artwork's own white — read here pixel by pixel.
   3. The theme picks the mark (--logo), in all four theme states, and the
      service worker precaches both so an offline shell is not a blank box. */
import { readFileSync, existsSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');

console.log('\n1 · the name');
const html = read('index.html');
check('the tab title is FleetMirror', /<title>FleetMirror<\/title>/.test(html));
check('…and so is the iOS home-screen title', /<meta name="apple-mobile-web-app-title" content="FleetMirror">/.test(html));
check('the old skin’s rail: the mark, then the name', /<div class="brand"><span class="logo" aria-hidden="true"><\/span><b>FleetMirror<\/b><\/div>/.test(html));
const manifest = JSON.parse(read('manifest.webmanifest'));
check('the installed app is named FleetMirror', manifest.name === 'FleetMirror' && manifest.short_name === 'FleetMirror',
  `${manifest.name} / ${manifest.short_name}`);
check('…its splash and theme colour are the artwork’s own dark, so the icon sits on its own ground',
  manifest.background_color === '#151513' && manifest.theme_color === '#151513');
check('the Arkiv masthead: the mark, then the name',
  /<span class="mast-word"><span class="logo" aria-hidden="true"><\/span>FleetMirror<\/span>/.test(read('shell.js')));
const mapp = read('m/app.js');
check('the phone’s header: the mark, with the name for a screen reader',
  /el\('a', 'ak-word', '<span class="logo" aria-hidden="true"><\/span><span class="sr">FleetMirror<\/span>'\)/.test(mapp));
check('…and every phone screen’s tab title ends "· FleetMirror"',
  (mapp.match(/· FleetMirror`/g) || []).length === 2 && !/· Fleet`/.test(mapp));
check('the phone’s More masthead names it',
  /el\('span', 'ak-mast-word', '<span class="logo" aria-hidden="true"><\/span>FleetMirror'\)/.test(read('m/screens.js')));
const old = ['index.html', 'shell.js', 'm/app.js', 'm/screens.js', 'manifest.webmanifest']
  .filter((f) => /Fleet Dashboard|<b>Fleet<\/b>Dashboard|'ak-word', 'Fleet'|'ak-mast-word', 'Fleet'/.test(strip(read(f))));
check('the old name is gone from every place it was printed', old.length === 0, old.join(' '));

console.log('\n2 · the theme picks the mark, and the worker keeps both');
const css = strip(read('app.css'));
const lightRoot = css.slice(css.indexOf(':root{'), css.indexOf('@media (prefers-color-scheme: dark)'));
const media = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'), css.indexOf(':root[data-theme="dark"]{'));
const explicit = css.slice(css.indexOf(':root[data-theme="dark"]{'), css.indexOf('}', css.indexOf(':root[data-theme="dark"]{')));
check('the light :root paints the light-page mark', /--logo:url\("\/brand\/mark\.png"\);/.test(lightRoot));
check('…both dark blocks the dark-page one', /--logo:url\("\/brand\/mark-dark\.png"\);/.test(media)
  && /--logo:url\("\/brand\/mark-dark\.png"\);/.test(explicit));
check('.logo paints from the token, never a file of its own', /\.logo\{[^}]*background:var\(--logo\) center\/contain no-repeat;/.test(css));
const files = ['brand/mark.png', 'brand/mark-dark.png', 'brand/fleetmirror-on-dark.png', 'brand/fleetmirror-on-light.png',
  'brand/fleetmirror-transparent.png', 'icons/fleetmirror-192.png', 'icons/fleetmirror-512.png', 'icons/fleetmirror-maskable-192.png',
  'icons/fleetmirror-maskable-512.png', 'icons/fleetmirror-apple-touch.png'];
const missing = files.filter((f) => !existsSync(new URL(f, PUB)));
check('every brand file is in the repository', missing.length === 0, missing.join(' '));
const sw = read('sw.js');
check('the service worker precaches both marks', /'\/brand\/mark\.png', '\/brand\/mark-dark\.png'/.test(sw));
/* /icons is served immutable for a year (server.js), so a new picture needs a
   new address: an icon replaced under its old name stays the old icon in
   every browser that ever fetched it. */
const iconRefs = [...html.matchAll(/href="(\/icons\/[^"]+)"/g), ...sw.matchAll(/'(\/icons\/[^']+)'/g)].map((m) => m[1])
  .concat(manifest.icons.map((i) => i.src), (manifest.shortcuts || []).flatMap((s) => (s.icons || []).map((i) => i.src)));
check('every icon the page, the manifest and the worker name is a FleetMirror file, under a new address',
  iconRefs.length >= 8 && iconRefs.every((u) => /^\/icons\/fleetmirror-/.test(u) && existsSync(new URL(u.slice(1), PUB))),
  iconRefs.join(' '));
check('…and the old names are gone, so nothing can serve an old picture as a new one',
  ['icon-192.png', 'icon-512.png', 'maskable-192.png', 'maskable-512.png', 'apple-touch-icon.png']
    .every((f) => !existsSync(new URL(`icons/${f}`, PUB))));

/* ── in a browser: the pixels, and the mark each theme state paints ─────── */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();

console.log('\n3 · the artwork, read pixel by pixel');
{
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop#settings`, { waitUntil: 'domcontentloaded' });
  const px = await page.evaluate(async (list) => {
    const out = {};
    for (const f of list) {
      const img = new Image(); img.src = `/${f}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      const seen = { dark: 0, light: 0, grey: 0, clear: 0 };
      for (let i = 0; i < d.length; i += 4) {
        const [r, gg, b, a] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
        if (a < 8) { seen.clear++; continue; }
        if (a < 250) continue;                                  // a resized edge
        if (Math.abs(r - 21) < 4 && Math.abs(gg - 21) < 4 && Math.abs(b - 19) < 4) seen.dark++;
        else if (Math.abs(r - 248) < 4 && Math.abs(gg - 248) < 4 && Math.abs(b - 245) < 4) seen.light++;
        else if (Math.abs(r - 191) < 4 && Math.abs(gg - 190) < 4 && Math.abs(b - 185) < 4) seen.grey++;
      }
      const corner = [...g.getImageData(0, 0, 1, 1).data];
      /* The shapes, as the alpha channel: a checksum over every pixel's
         coverage, position-weighted so a moved edge changes it. */
      let alpha = 0;
      for (let i = 3; i < d.length; i += 4) alpha = (alpha * 31 + d[i]) % 1000000007;
      out[f] = { w: c.width, h: c.height, corner, alpha, ...seen };
    }
    return out;
  }, files.filter((f) => f.endsWith('.png')));
  const sq = (f, n) => px[f].w === n && px[f].h === n;
  check('the icons are square at their named sizes',
    sq('icons/fleetmirror-192.png', 192) && sq('icons/fleetmirror-512.png', 512) && sq('icons/fleetmirror-maskable-192.png', 192)
    && sq('icons/fleetmirror-maskable-512.png', 512) && sq('icons/fleetmirror-apple-touch.png', 180),
    JSON.stringify(Object.fromEntries(Object.entries(px).map(([k, v]) => [k, `${v.w}x${v.h}`]))));
  const onDark = ['icons/fleetmirror-192.png', 'icons/fleetmirror-512.png', 'icons/fleetmirror-maskable-192.png', 'icons/fleetmirror-maskable-512.png', 'icons/fleetmirror-apple-touch.png']
    .filter((f) => !(px[f].corner.join() === '21,21,19,255' && px[f].light > 0 && px[f].grey > 0 && px[f].dark > px[f].light));
  check('…each is the on-dark artwork: its dark ground, the light half and the grey half', onDark.length === 0, onDark.join(' '));
  const m = px['brand/mark.png'], md = px['brand/mark-dark.png'];
  check('the light-page mark is the transparent file: black and grey on nothing', m.corner[3] === 0 && m.dark > 0 && m.grey > 0 && m.light === 0,
    JSON.stringify(m));
  /* The same SHAPES is the same alpha channel, exactly. Colour counts are
     not the test: resampling overshoots the dark half toward 0 and the light
     half toward 255, so a tolerance band counts their edges differently
     (4,844 dark against 4,484 light, measured) while the coverage is equal. */
  check('the dark-page mark is the same shapes (identical alpha) with the black half in the artwork’s white',
    md.corner[3] === 0 && md.light > 0 && md.dark === 0 && md.w === m.w && md.h === m.h
    && md.alpha === m.alpha && md.grey === m.grey, JSON.stringify({ m, md }));
  check('the three originals are kept as given (1024 square)', ['brand/fleetmirror-on-dark.png', 'brand/fleetmirror-on-light.png',
    'brand/fleetmirror-transparent.png'].every((f) => sq(f, 1024)));
  await ctx.close();
}

console.log('\n4 · the mark each theme state paints, in both skins');
for (const [label, scheme, theme, want] of [['OS light', 'light', null, 'mark.png'], ['OS dark', 'dark', null, 'mark-dark.png'],
  ['OS light, chose dark', 'light', 'dark', 'mark-dark.png'], ['OS dark, chose light', 'dark', 'light', 'mark.png']]) {
  for (const [skin, sel] of [['classic', '.brand .logo'], ['arkiv', '.mast-word .logo']]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, serviceWorkers: 'block' });
    if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch (e) {} }, theme);
    const page = await ctx.newPage();
    await page.goto(`${base}/?ui=desktop&skin=${skin}#settings`, { waitUntil: 'load' });
    await page.waitForSelector(sel, { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { bg: getComputedStyle(e).backgroundImage, w: Math.round(b.width), h: Math.round(b.height),
        name: e.parentElement.textContent.trim() };
    }, sel);
    check(`${label}, ${skin}: the ${want.replace('.png', '')} beside "FleetMirror"`,
      !!r && r.bg.endsWith(`/brand/${want}")`) && r.w > 10 && r.h > 10 && r.name === 'FleetMirror', JSON.stringify(r));
    await ctx.close();
  }
}
{
  const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=phone#today`, { waitUntil: 'load' });
  await page.waitForSelector('.ak-word .logo', { timeout: 20000 }).catch(() => {});
  const r = await page.evaluate(() => {
    const w = document.querySelector('.ak-word'); const b = w?.getBoundingClientRect();
    return w ? { bg: getComputedStyle(w.querySelector('.logo')).backgroundImage, label: w.textContent.trim(),
      w: Math.round(b.width), h: Math.round(b.height), title: document.title } : null;
  });
  check('the phone (its default skin, 360px): the mark, the name for a screen reader, a 44px target',
    !!r && r.bg.endsWith('/brand/mark.png")') && r.label === 'FleetMirror' && r.w >= 44 && r.h >= 44
    && / · FleetMirror$/.test(r.title), JSON.stringify(r));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
