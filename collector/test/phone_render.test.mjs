/* Every phone screen, as a thumb meets it.
   ─────────────────────────────────────────────────────────────────────────
   test/phone.test.mjs checks the shapes and the wiring without a browser.
   This checks the two things only a browser knows: that each screen paints
   something, and that nothing about it is unreachable at 390px.

   The three failures it is built around all happened on the first build and
   none of them threw:

     the deck is a flex column, so a twenty-row list was SHRUNK into one row
     with the rest clipped inside a box the right shape;
     a wide element pushes the page sideways, and on a phone there is no
     scrollbar to reveal it — the reader just finds the right edge cut off;
     the fixed tab bar sits over the last row of content unless the deck
     reserves room for it.

   Run it the way the other browser tests are run:

     node mockapi.mjs &
     node test/phone_render.test.mjs
*/
import { launchChromium } from './browser.mjs';

const BASE = process.env.PHONE_BASE || process.env.SMOKE_BASE || 'http://localhost:8099';
const ROUTES = ['today', 'money', 'people', 'fleet', 'more', 'live', 'safety',
  'unauthorized', 'sources', 'corporate', 'analyst',
  'driver/drv-0', 'vehicle/L45235',
  /* A sub-page goes to the fallback, which renders a real desktop module —
     the one place the two applications touch. */
  'driver/drv-0/earnings',
  /* And an address no screen claims must still resolve to something. */
  'nonsense'];

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const browser = await launchChromium();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true,
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${page.url().split('#')[1] || '/'}: ${e.message}`.slice(0, 140)));

const bad = { empty: [], overflow: [], squashed: [], hidden: [], small: [] };
let seen = 0;

for (const route of ROUTES) {
  try {
    await page.goto(`${BASE}/?ui=phone#${route}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2200);
  } catch { continue; }
  const m = await page.evaluate(() => {
    const deck = document.querySelector('.m-deck');
    const tabs = document.querySelector('.m-tabs');
    if (!deck || !tabs) return { fatal: 'no shell' };
    const kids = [...deck.children].filter((k) => k.getBoundingClientRect().height > 2);
    return {
      ui: document.documentElement.dataset.ui,
      /* Something to read: a card, a row, a stat, an explained empty state —
         or, on a fallback route, whatever the desktop module painted, which
         wears desktop class names and none of the ones above. */
      content: deck.querySelectorAll('.m-card,.m-lede,.m-stat,.m-row,.m-empty,.m-rows').length
        + deck.querySelectorAll('.m-fallback > * > *').length,
      /* Sideways. documentElement, because the deck is allowed to scroll a
         table inside its own overflow-x container but the PAGE is not. */
      overflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
      /* A child whose rendered height is smaller than its content wanted is a
         child that was compressed to make the column fit. */
      squashed: kids.filter((k) => k.scrollHeight - k.getBoundingClientRect().height > 3)
        .map((k) => k.className || k.tagName).slice(0, 3),
      /* The bar is fixed at the foot; the deck must reserve room for it. */
      tabsVisible: tabs.getBoundingClientRect().bottom <= innerHeight + 1
        && tabs.getBoundingClientRect().height > 30,
      /* A target a thumb cannot hit is a control that is not there. Hidden
         controls are skipped: the back button is display:none at the top of
         a stack, and a zero-height box is not a small target. */
      small: [...document.querySelectorAll('.m-tab,.m-ico,.m-row,.m-seg button')]
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.height > 0 && r.width > 0 && r.height < 40;
        })
        .map((b) => `${b.tagName.toLowerCase()}.${b.className || '?'}`).slice(0, 3),
    };
  });
  if (m.fatal) { bad.empty.push(`${route} (${m.fatal})`); continue; }
  seen += 1;
  if (!m.content) bad.empty.push(route);
  if (m.overflow > 1) bad.overflow.push(`${route} +${m.overflow}px`);
  if (m.squashed.length) bad.squashed.push(`${route}: ${m.squashed.join(', ')}`);
  if (!m.tabsVisible) bad.hidden.push(route);
  if (m.small.length) bad.small.push(`${route}: ${m.small.join(', ')}`);
}

/* The desktop build must still be what a desktop gets, from the same URL. */
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/?ui=desktop#unit`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2500);
const desk = await page.evaluate(() => ({
  ui: document.documentElement.dataset.ui,
  app: document.querySelector('#app') && getComputedStyle(document.querySelector('#app')).display,
  phoneShell: document.querySelector('#m')?.children.length ?? -1,
  painted: document.querySelectorAll('#view .panel,#view .kpi,#view table').length,
}));

await browser.close();

check('every phone screen paints something', !bad.empty.length, bad.empty.join(' | '));
check('nothing pushes the page sideways at 390px', !bad.overflow.length, bad.overflow.join(' | '));
check('no section is compressed to make the column fit', !bad.squashed.length, bad.squashed.join(' | '));
check('the tab bar is on screen on every route', !bad.hidden.length, bad.hidden.join(' | '));
check('every control is big enough to hit', !bad.small.length, bad.small.join(' | '));
check('no screen threw', !errors.length, [...new Set(errors)].slice(0, 4).join(' | '));
check('enough routes were measured to mean something', seen >= ROUTES.length - 1, `${seen} of ${ROUTES.length}`);
check('the same URL still serves the desktop application to a desktop',
  desk.ui === 'desktop' && desk.app === 'grid' && desk.phoneShell === 0 && desk.painted > 0,
  JSON.stringify(desk));

console.log(`\n  ${seen} phone routes measured at 390×844 against ${BASE}`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
