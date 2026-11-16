/* The driver Territory tab, drawn: every pickup placed, the rest named by
   reason (FIX-STATUS PLC, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   Chromium against mockapi.mjs (synthetic data only), at 1280 and 390, in
   both skins, service workers blocked so a cached shell cannot answer for
   the working tree. What the reader must see on "Busiest pickup areas":

     · no "(unparsed)" anywhere — the row the operator complained about;
     · the residual row named by its reason, "Not placed — no address, and no
       tracker fix within 5 minutes";
     · the caption that says how every pickup was placed, in the resolver's
       words, the tracker named as the car's and not the platform's;
     · the subtitle no longer claiming every area came from the address;
     · at 390, nothing scrolls sideways.
   Screenshots go to $SHOTS when it is set, for a human look. */
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PORT = Number(process.env.PORT || 8324);
const srv = mock.listen(PORT);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;
const browser = await launchChromium();

const READ = () => {
  const view = document.querySelector('#view');
  const txt = (e) => (e ? e.textContent.replace(/\s+/g, ' ').trim() : '');
  const heads = [...view.querySelectorAll('h2, h3, h4, .ph, .panel-title')];
  const head = heads.find((h) => /Busiest pickup areas/.test(h.textContent));
  let panel = head;
  while (panel && panel !== view && !panel.querySelector('table')) panel = panel.parentElement;
  const rows = panel ? [...panel.querySelectorAll('tbody tr')].map((tr) => txt(tr.querySelector('td'))) : [];
  const caps = panel ? [...panel.querySelectorAll('p.cap')].map(txt) : [];
  return {
    found: !!head,
    rows,
    caps,
    all: txt(view),
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
};

for (const skin of ['arkiv', 'classic']) {
  for (const width of [1280, 390]) {
    console.log(`\n${skin} at ${width}`);
    const c = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block',
      timezoneId: 'Asia/Dubai', reducedMotion: 'reduce' });
    const page = await c.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
    await page.goto(`${base}/?ui=desktop&skin=${skin}#driver/drv-0/territory`, { waitUntil: 'load' });
    await page.waitForFunction(() => /How the [\d,]+ pickups were placed/.test(document.querySelector('#view')?.textContent || ''),
      null, { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate(READ);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/territory-${skin}-${width}.png`, fullPage: true });
    check('the "Busiest pickup areas" panel is drawn', r.found && r.rows.length > 0, JSON.stringify(r.rows));
    check('no "(unparsed)" anywhere on the page', !/\(unparsed\)/.test(r.all));
    check('the residual row is named by its reason',
      r.rows.includes('Not placed — no address, and no tracker fix within 5 minutes'), JSON.stringify(r.rows));
    const cap = r.caps.find((x) => /^How the/.test(x)) || '';
    check('the caption says how every pickup was placed, tracker as the car\'s',
      cap === 'How the 317 pickups were placed: 297 from the address, 7 named from the address text, '
        + "8 placed by the car's tracker at the request time, 5 not placed: no address, and no tracker fix within 5 minutes.",
      cap);
    check('the subtitle no longer claims every area came from the address',
      /From the address the platform recorded, or the car's tracker where it named no area/.test(r.all));
    if (width === 390) check('nothing scrolls sideways at 390', r.overflowX <= 0, String(r.overflowX));
    check('no page error', errs.length === 0, errs.join(' | '));
    await c.close();
  }
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
