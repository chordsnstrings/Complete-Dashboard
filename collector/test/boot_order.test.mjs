/* The boot order: the application module runs only once <body> exists.
   ═══════════════════════════════════════════════════════════════════════════
   index.html picks the build (phone or desktop) in a script at the top of
   <head> and then loads /m/app.js or /app.js. It used to APPEND that module
   (document.head.appendChild), which makes it async: it runs the moment it
   has arrived, whether or not the parser has reached <body> yet. That was
   harmless while nothing held the parser in <head>. The Arkiv skin's STEP 1
   added an inline script after the stylesheets (it document.writes arkiv.css
   so the parser inserts it), and an inline script waits for every
   stylesheet above it — so a slow app.css held <body> back while the module
   ran without it.

   Measured (found by the reskin's STEP 4 full run, where charging_page's
   phone half failed once under load, and reproduced here with app.css held
   back 2s): the phone build threw "Cannot read properties of null (reading
   'append')" at m/app.js's `root.append` (#m did not exist yet) and the
   desktop build "Cannot set properties of null (setting 'onclick')" at
   app.js's `$('#fRange').onclick` — a blank page on both builds, in both
   skins. The commit before STEP 1 (d00202f) rendered both under the same
   delay.

   The fix is in index.html: the parser writes the module in, which makes it
   deferred — its download still starts at the top of <head>, and it runs
   after the document is parsed and after every stylesheet the parser
   inserted has loaded. This file holds that down:
     0. index.html writes the module through the parser and appends none;
     1. with app.css held back 2s, the desktop build renders a page with no
        error in the old skin and under Arkiv (whose shell and page contract
        are built on the first render), and the phone build renders its
        screens with no error.
   Synthetic data only: the browser half renders against mockapi.mjs. */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const html = readFileSync(new URL('../api/public/index.html', import.meta.url), 'utf8');
const code = html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

console.log('\n0 · index.html');
check('the application module is written in by the parser, for either build',
  /document\.write\('<script type="module" src="' \+ \(phone \? '\/m\/app\.js' : '\/app\.js'\) \+ '"><\\\/script>'\)/.test(code));
check('…and no script element is created and appended', !/createElement\(\s*'script'\s*\)/.test(code));

console.log('\n1 · a slow app.css');
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const HOLD = 2000;

const boot = async (url, ctxOpts, probe) => {
  const ctx = await browser.newContext({ serviceWorkers: 'block', timezoneId: 'Asia/Dubai', ...ctxOpts });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)));
  await page.route('**/app.css', async (r) => { await new Promise((ok) => setTimeout(ok, HOLD)); await r.continue(); });
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(500);
  const out = await page.evaluate(probe);
  await ctx.close();
  return { ...out, errs };
};

const desk = () => ({
  title: document.querySelector('#viewTitle')?.textContent || '',
  view: document.querySelector('#view')?.childElementCount || 0,
  shell: document.querySelector('#app')?.classList.contains('ak-shell') || false,
  glance: !!document.querySelector('#view .glance'),
});
const classic = await boot(`${base}/?ui=desktop&skin=classic#overview`, { viewport: { width: 1440, height: 900 } }, desk);
check('desktop, old skin: the page renders, with no error', classic.errs.length === 0 && classic.title === 'Fleet activity'
  && classic.view > 0 && !classic.shell, JSON.stringify(classic));
const arkiv = await boot(`${base}/?ui=desktop&skin=arkiv#overview`, { viewport: { width: 1440, height: 900 } }, desk);
check('desktop, Arkiv: the page renders in the new shell and the page contract, with no error',
  arkiv.errs.length === 0 && arkiv.title === 'Fleet activity' && arkiv.shell && arkiv.glance, JSON.stringify(arkiv));
const phone = await boot(`${base}/?ui=phone#today`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  () => ({ m: document.querySelector('#m')?.childElementCount || 0, text: document.body.innerText.trim().length }));
check('phone: the screens render, with no error', phone.errs.length === 0 && phone.m > 0 && phone.text > 0,
  JSON.stringify(phone));

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
