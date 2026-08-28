/* The phone application, checked without a browser.
   ─────────────────────────────────────────────────────────────────────────
   /m is a second application at the same address, and the failure mode that
   matters most for it is silent: a screen that renders an empty state because
   the endpoint answered an envelope it did not expect looks exactly like a
   quiet week. Both People and Fleet did that on the first run against the real
   API, and nothing failed — the pages just said "nobody drove".

   So the shape adapters, the disclosure rules and the route table are checked
   here as plain functions. What needs a browser — that each screen paints, and
   that nothing overflows a 390px viewport — is test/phone_render.mjs.

   The PWA files are checked too, because a manifest with an icon that is not
   on disk installs an app with no icon, and a service worker precaching a
   module that has been renamed installs an app that cannot open offline.
*/
import { readFileSync, existsSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = 'api/public';

/* ── the shape adapters ─────────────────────────────────────────────────
   Imported as source rather than executed: m/ui.js pulls in ../ui.js, which
   reaches for `document`. The two functions under test are pure, so they are
   lifted out and run — the alternative is a DOM shim that tests itself. */
const uiSrc = readFileSync(`${PUB}/m/ui.js`, 'utf8');
const lift = (name) => {
  const at = uiSrc.indexOf(`export const ${name} = `);
  if (at === -1) throw new Error(`${name} is not exported from m/ui.js`);
  const from = uiSrc.slice(at + `export const `.length);
  const end = from.search(/\n};\n/);
  // eslint-disable-next-line no-new-func
  return new Function(`const ${from.slice(0, end + 2)}\nreturn ${name};`)();
};
const unwrap = lift('unwrap');

check('an envelope gives up its rows', unwrap({ rows: [1, 2, 3] }).rows.length === 3);
check('a bare array is an envelope with three rows', unwrap([1, 2, 3]).rows.length === 3);
check('…and reports itself untruncated', unwrap([1, 2]).truncated === false);
/* The defect this exists for: .rows off an array is undefined, and a screen
   reading `.length` on that throws or paints an empty state. */
check('an array never yields undefined rows', Array.isArray(unwrap([1]).rows));
check('null is an empty envelope, not a crash', unwrap(null).rows.length === 0);
check('a string is an empty envelope, not a crash', unwrap('nope').rows.length === 0);
check('the total comes from the envelope, not the page',
  unwrap({ rows: [1], people: 74 }).total === 74);
check('…from `total` as well', unwrap({ rows: [1], total: 12 }).total === 12);
check('…and from the nested totals the alert feed uses',
  unwrap({ rows: [1], totals: { vehicles: 118 } }).total === 118);
check('a cut list is marked cut', unwrap({ rows: [1], total: 9, truncated: true }).truncated === true);

/* ── the route table ────────────────────────────────────────────────────── */
const screensSrc = readFileSync(`${PUB}/m/screens.js`, 'utf8');
/* Comments out first: these files explain themselves in prose, and a word
   inside a comment is not a route name or a line of code. */
const bare = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const appSrc = readFileSync(`${PUB}/m/app.js`, 'utf8');

const tabIds = [...screensSrc.matchAll(/\{ id: '([a-z]+)', route: '([a-z]+)'/g)].map((m) => m[2]);
check('there are five destinations', tabIds.length === 5, tabIds.join(','));
const routed = screensSrc.slice(screensSrc.indexOf('export const SCREENS = {'));
for (const t of tabIds) {
  check(`the ${t} tab has a screen behind it`, new RegExp(`\\b${t}\\b`).test(routed));
}
/* Every `owns` entry claims a route for a tab, and a route claimed by no tab
   leaves the bar with nothing lit — which reads as "you are nowhere". */
const owned = [...screensSrc.matchAll(/owns: \[([^\]]+)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]));
check('every tab route is owned by its own tab', tabIds.every((t) => owned.includes(t)));
check('the detail pages are owned', ['driver', 'vehicle'].every((v) => owned.includes(v)));
check('so are the screens behind More',
  ['corporate', 'analyst', 'live', 'safety', 'unauthorized', 'sources'].every((v) => owned.includes(v)));

/* A detail page has a phone screen; its tabs go to the fallback. Both halves
   of that rule have to be present or `#driver/x/earnings` renders the person
   again under the wrong title. */
check('a sub-page of a detail page goes to the fallback',
  /sub && \(id === 'driver' \|\| id === 'vehicle'\)[\s\S]{0,60}SCREENS\.fallback/.test(appSrc));

check('every screen the table names is defined', (() => {
  const body = bare(routed).slice(bare(routed).indexOf('{') + 1);
  const entries = body.slice(0, body.indexOf('};')).split(',')
    .map((x) => x.trim()).filter(Boolean);
  const impls = entries.map((e) => (e.includes(':') ? e.split(':')[1] : e).trim());
  return impls.length >= 12 && impls.every((fnName) =>
    new RegExp(`(async function|function|const) ${fnName}\\b`).test(screensSrc));
})());

/* ── disclosure ─────────────────────────────────────────────────────────
   A phone shows eight rows of seventy-four with no scrollbar to hint at the
   rest, so a cut list that does not say so is a lie of omission. */
check('the cut-list line exists', /export const cut = /.test(uiSrc));
for (const screen of ['people', 'fleet']) {
  const body = screensSrc.slice(screensSrc.indexOf(`async function ${screen}(`),
    screensSrc.indexOf(`async function ${screen}(`) + 2600);
  check(`${screen} discloses that its list was cut`, /\bcut\(/.test(body));
}
/* A share taken over the rows that FITTED read 17% five times and summed to
   84%. The denominator must be everything. */
check('a share is taken over every row, not the visible ones',
  /const all = list\.filter[\s\S]*?const total = all\.reduce/.test(bare(uiSrc))
  && !/const total = rowsIn\.reduce/.test(uiSrc));

/* A percentile is a rank, and the two ends of it are not shares.
   "top 0%" is what the best driver in the fleet scored before this. */
check('the top of the fleet is not called "top 0%"',
  /percentile >= 100 \? 'highest in the fleet'/.test(bare(screensSrc)));
check('…and the bottom is named as a bottom',
  /percentile < 50|`bottom \$\{m\.percentile\}%`/.test(bare(screensSrc)));

/* ── the PWA files ──────────────────────────────────────────────────────── */
const manifest = JSON.parse(readFileSync(`${PUB}/manifest.webmanifest`, 'utf8'));
check('the manifest names the app', !!manifest.name && !!manifest.short_name);
check('it is installable as an app, not a tab', manifest.display === 'standalone');
check('it starts on the phone build', /ui=phone/.test(manifest.start_url));
check('it declares a maskable icon',
  manifest.icons.some((i) => i.purpose === 'maskable'));
for (const icon of manifest.icons) {
  const f = `${PUB}${icon.src}`;
  check(`${icon.src} is on disk`, existsSync(f));
  if (existsSync(f)) {
    const head = readFileSync(f).subarray(0, 8);
    check(`${icon.src} is a real PNG`, head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  }
}
for (const s of manifest.shortcuts || []) {
  check(`the "${s.name}" shortcut points at the phone build`, /ui=phone/.test(s.url));
}

const sw = readFileSync(`${PUB}/sw.js`, 'utf8');
const shell = [...sw.slice(sw.indexOf('const SHELL_FILES'), sw.indexOf('self.addEventListener'))
  .matchAll(/'([^']+)'/g)].map((m) => m[1]);
check('the worker precaches a shell', shell.length >= 6);
for (const f of shell) {
  if (f === '/') continue;
  check(`the shell file ${f} exists`, existsSync(`${PUB}${f}`));
}
/* A cached POST would replay a credential write or a collection trigger. */
check('the worker never answers a POST from a cache',
  /request\.method !== 'GET'\) return;/.test(sw));
check('a failed response is not cached as if it were good', /if \(fresh\.ok\)/.test(sw));
check('a cached answer says when it was stored', /x-sw-cached-at/.test(sw));
check('activate retires every cache that is not this version',
  /caches\.keys\(\)[\s\S]{0,120}caches\.delete/.test(sw));

/* ── the boot switch ────────────────────────────────────────────────────
   The one change to a file the desktop also reads. If this regresses, every
   desktop reader gets the phone build or no build at all. */
const html = readFileSync(`${PUB}/index.html`, 'utf8');
check('the switch needs BOTH a coarse pointer and a narrow viewport',
  /max-width: 760px[\s\S]{0,60}pointer: coarse/.test(html));
check('?ui= overrides it', /ui=phone|getParameter|get\('ui'\)/.test(html));
check('the desktop bundle is still what a desktop loads',
  /phone \? '\/m\/app\.js' : '\/app\.js'/.test(html));
check('the phone stylesheet is only fetched on a phone',
  /if \(phone\)[\s\S]{0,400}m\/m\.css/.test(html));
check('the desktop shell is still in the document', /<aside class="side">/.test(html));
check('the phone mounts in its own element', /<div id="m"><\/div>/.test(html));
check('the manifest is linked', /rel="manifest"/.test(html));
check('iOS is told it is an app', /apple-mobile-web-app-capable/.test(html));
check('the notch is accounted for', /viewport-fit=cover/.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
