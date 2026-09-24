/* The redesigned phone PWA, under the Arkiv skin.
   ─────────────────────────────────────────────────────────────────────────
   The operator's ruling of 2026-09-24: "Phone will have a redesigned pwa
   app" — with the standing instruction that every figure, every screen's
   purpose and every operational flow the phone has today survives
   (docs/UI-REDESIGN-PLAN.md, "Phone PWA — redesign"). The old skin's half is
   test/phone_classic.test.mjs, which holds the old screens byte-identical.
   This file holds the new ones, section by section as each lands:

     0. WHICH PHONE IS A TOKEN — --pg-phone, 0 in app.css and 1 in
        m/arkiv-m.css — and no module reads the skin attribute.
     1. THE SHEET — m/arkiv-m.css: scoped, hex-free, on the scale, every
        var() it asks for declared; written by the parser for a phone under
        the skin and for nobody else; precached by the service worker.

   Static checks run on the source; the browser checks use the hermetic
   harness (test/phone_harness.mjs): the recorded API answers and a frozen
   clock, so a figure on screen can be compared with the answer it came from
   and with what the old screen printed from the same answer. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUB, launch, phonePage, loadFixture } from './phone_harness.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');

console.log('\n0 · which phone is a token');
const app = strip(read('app.css'));
/* The FIRST :root block is the old skin's light root; the theme blocks and
   the generated Arkiv block come later and must not move it. */
const firstRoot = app.slice(app.indexOf(':root{'), app.indexOf('}', app.indexOf(':root{')));
check('app.css declares --pg-phone:0 in the old skin’s :root', /--pg-phone:0;/.test(firstRoot));
check('…and nothing else in app.css declares it (no theme block moves it)',
  (app.match(/--pg-phone\s*:/g) || []).length === 1, String((app.match(/--pg-phone\s*:/g) || []).length));
const PREFIX = ':root[data-skin="arkiv"][data-ui="phone"]';
const mk = strip(read('m/arkiv-m.css'));
check('m/arkiv-m.css declares --pg-phone:1, under the skin, on the phone',
  new RegExp(`${PREFIX.replace(/[[\]()"]/g, '\\$&')}\\{[^}]*--pg-phone:1`).test(mk));
check('arkiv.css does not declare it (the 1 travels with the phone’s own rules)',
  !/--pg-phone/.test(strip(read('arkiv.css'))));
/* Code, not prose — the comments explain the attribute. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const mjs = ['m/app.js', 'm/ui.js', 'm/screens.js'].map((f) => [f, code(read(f))]);
check('no phone module reads the skin attribute',
  mjs.every(([, s]) => !/dataset\.skin|data-skin|fleet\.skin/.test(s)),
  mjs.filter(([, s]) => /dataset\.skin|data-skin|fleet\.skin/.test(s)).map(([f]) => f).join(' '));
check('m/ui.js phoneContract() reads --pg-phone and nothing else',
  /export function phoneContract\(\)[\s\S]{0,420}getPropertyValue\('--pg-phone'\)\)\.trim\(\) === '1'/.test(read('m/ui.js')));

console.log('\n1 · the sheet: scoped, hex-free, on the scale, and loaded for the phone under the skin only');
{
  const hexes = mk.match(/#[0-9a-f]{3,8}\b/gi) || [];
  check('no hex', hexes.length === 0, hexes.join(' '));
  check('no rgb()/rgba()/hsl() literal', !/\b(?:rgba?|hsla?)\(/i.test(mk));
  const NAMED = /(?<![-\w"'])(?:white|black|red|green|blue|yellow|orange|purple|pink|gr[ae]y|silver|navy|teal|maroon|olive|lime|aqua|fuchsia)(?![-\w"'])/i;
  const decls = [...mk.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1].split(';')).map((d) => d.trim()).filter(Boolean);
  const named = decls.filter((d) => NAMED.test(d.split(':').slice(1).join(':')));
  check('no named colour', named.length === 0, named.join(' | '));
  const selectors = [];
  const body = mk.replace(/@media[^{]*\{/g, '').replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  for (const m of body.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const s of m[1].split(',').map((x) => x.trim()).filter(Boolean)) selectors.push(s);
  }
  const unscoped = selectors.filter((s) => !s.startsWith(PREFIX));
  check(`every selector is scoped to ${PREFIX} (${selectors.length})`, selectors.length > 0 && unscoped.length === 0,
    unscoped.slice(0, 6).join(' | '));
  check('no @import', !/@import/i.test(mk));
  const sizes = decls.filter((d) => /^font-size\s*:/.test(d));
  check('every font-size is a step of app.css’s scale', sizes.every((d) => /^font-size\s*:\s*var\(--[td]\d\)$/.test(d)),
    sizes.filter((d) => !/var\(--[td]\d\)/.test(d)).join(' | '));
  /* A var() nobody declares renders the initial value with no error — the
     money form's --card/--line lesson (FIX-STATUS T5). */
  const all = [read('app.css'), read('arkiv.css'), read('m/m.css'), read('m/arkiv-m.css')].map(strip).join('\n');
  const declared = new Set([...all.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  ['--hl-wash', '--hl-rule'].forEach((n) => declared.add(n));      // ui.js highlight() sets these inline
  const asked = [...new Set([...mk.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]))];
  const undeclared = asked.filter((n) => !declared.has(n));
  check('every var() it asks for is declared somewhere', undeclared.length === 0, undeclared.join(' '));
}
{
  const html = read('index.html');
  const appAt = html.indexOf('href="/app.css"');
  const arkAt = html.indexOf('/arkiv.css');
  const mAt = html.indexOf('/m/arkiv-m.css');
  check('index.html writes /m/arkiv-m.css after app.css and arkiv.css', appAt > 0 && arkAt > appAt && mAt > arkAt);
  check('…by document.write, so the parser inserts it',
    /document\.write\('<link rel="stylesheet" href="\/m\/arkiv-m\.css">'\)/.test(html));
  check('…only under the skin AND on the phone build',
    /if \(document\.documentElement\.dataset\.skin === 'arkiv' && document\.documentElement\.dataset\.ui === 'phone'\)\s*\n\s*document\.write\('<link rel="stylesheet" href="\/m\/arkiv-m\.css">'\)/.test(html));
  check('no static <link> loads it for everybody',
    !/<link[^>]+arkiv-m\.css/.test(html.replace(/document\.write\([^)]*\)/g, '')));
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL_FILES'), sw.indexOf('self.addEventListener')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  check('the service worker precaches /m/arkiv-m.css', /'\/m\/arkiv-m\.css'/.test(shell));
}

/* ══ the browser half ═════════════════════════════════════════════════════ */
const fixture = loadFixture();
check('the recorded API answers are on disk', !!fixture);
const browser = await launch();

console.log('\n1 · the sheet, in a browser');
{
  const asked = (p) => p.page.evaluate(() => performance.getEntriesByType('resource')
    .filter((e) => /arkiv-m\.css$/.test(e.name)).map((e) => e.renderBlockingStatus));
  const probe = (p) => p.page.evaluate(async () => ({
    links: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')),
    sheets: [...document.styleSheets].map((s) => new URL(s.href || location.href).pathname),
    token: getComputedStyle(document.documentElement).getPropertyValue('--pg-phone').trim(),
  }));
  const on = await phonePage(browser, { skin: 'arkiv', fixture });
  await on.open('today');
  await on.page.waitForLoadState('load');
  const a = await probe(on);
  check('a phone under the skin gets /m/arkiv-m.css as its LAST stylesheet',
    a.links[a.links.length - 1] === '/m/arkiv-m.css' && a.links.indexOf('/arkiv.css') >= 0, a.links.join(' '));
  check('…applied after arkiv.css', a.sheets.indexOf('/m/arkiv-m.css') > a.sheets.indexOf('/arkiv.css')
    && a.sheets.indexOf('/arkiv.css') > a.sheets.indexOf('/app.css'), a.sheets.join(' '));
  check('--pg-phone reads 1', a.token === '1', a.token);
  check('phoneContract() says so', await on.page.evaluate(() => import('/m/ui.js').then((m) => m.phoneContract())));
  await on.close();
  /* Render-blocking, measured by holding the sheet back: a parser-inserted
     sheet holds the first paint until it lands, and one a script appended
     would not (arkiv.css was measured the same way, FIX-STATUS K1). Resource
     timing cannot say it here — the harness answers from the router, and a
     routed response leaves no resource entry. */
  const slow = await phonePage(browser, { skin: 'arkiv', fixture, frozen: false, hold: { '/m/arkiv-m.css': 1500 } });
  await slow.open('today');
  const paint = await slow.page.evaluate(() => {
    const fcp = performance.getEntriesByType('paint').find((e) => e.name === 'first-contentful-paint');
    const nav = performance.getEntriesByType('navigation')[0];
    return { fcp: fcp ? fcp.startTime : null, start: nav ? nav.startTime : 0 };
  });
  check('with the sheet held back 1.5s, nothing paints before it lands',
    paint.fcp != null && paint.fcp - paint.start >= 1400, JSON.stringify(paint));
  await slow.close();

  const desk = await phonePage(browser, { skin: 'arkiv', fixture, width: 1440, height: 900 });
  await desk.open('overview', { ui: 'desktop' });
  await desk.page.waitForLoadState('load');
  const d = await probe(desk);
  check('a DESKTOP reader under the skin never requests it', !d.links.includes('/m/arkiv-m.css')
    && (await asked(desk)).length === 0, d.links.join(' '));
  check('…and reads --pg-phone as 0', d.token === '0', d.token);
  await desk.close();

  const old = await phonePage(browser, { skin: 'classic', fixture });
  await old.open('today');
  await old.page.waitForLoadState('load');
  const o = await probe(old);
  check('a phone on the old skin never requests it', !o.links.includes('/m/arkiv-m.css')
    && (await asked(old)).length === 0, o.links.join(' '));
  check('…reads --pg-phone as 0', o.token === '0', o.token);
  check('…and phoneContract() says so', !(await old.page.evaluate(() => import('/m/ui.js').then((m) => m.phoneContract()))));
  await old.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
