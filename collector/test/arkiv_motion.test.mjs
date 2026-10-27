/* ── the Arkiv skin's motion layer (motion.css, motion.js) ──────────────────
   The operator, 2026-10-27: "within the arkiv skin little micro animations,
   highlights, sticking to the theme, but sprinkling in", and "ensuring page
   load is also engaging". docs/FIX-STATUS.md MOTION has the ruling and what
   it reverses (arkiv.css §14).

   What has to hold, and why each one is here:

   1 · THE SHEET keeps the skin's own contract: tokens only, every selector
       behind [data-motion="on"] under the skin, and everything that MOVES
       behind prefers-reduced-motion — the only animation allowed outside it
       is the 1ms reveal of the boot sheet's words, which is not motion.
   2 · THE SWITCH. Off under automation unless asked for, so every screenshot
       and every other browser test in this suite sees the still page it was
       written against; on when asked (?motion=on, remembered); never on the
       Classic skin (held byte-frozen) or the phone build. motion.css goes in
       BEFORE arkiv.css — the skin must stay the last stylesheet.
   3 · THE BOOT SHEET stands where the masthead will: same top and gutter as
       the real wordmark, the label under it after a beat, the sentence after
       four seconds, "stopped" when a module fails — and gone on the frame
       the shell lands.
   4 · A PAGE ARRIVING gets the entrance; a REDRAW of the same page (what a
       background refresh does) does not, and no class is left behind.
   5 · CONTENT AFTER A WAIT comes up (fx-arrive); the busy hairline is on
       while a request is out and off after.
   6 · A FIGURE THAT MOVED between two drawings of the same page gets the
       wash, through the real path — a background refresh that finds the
       data moved — and a figure that did not move does not; nor does a
       count-up (app.js countUp) passing through values on its way.
   7 · REDUCED MOTION: nothing of this layer runs, the words still show.
   8 · BOUNDED on a big page: no table cell ever animates.

   Renders against mockapi.mjs — synthetic fixtures only. */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const css = strip(read('motion.css'));
const html = read('index.html');
const PREFIX = ':root[data-skin="arkiv"][data-motion="on"]';

/* ══ 1 · the sheet ════════════════════════════════════════════════════════ */
console.log('\n1 · motion.css keeps the skin’s contract');
check('no hex', !/#[0-9a-f]{3,8}\b/i.test(css.replace(/#(app|view|nav|secRow|sectabs|filters|todayNow|settingsLink|akBusy)\b/g, '')));
check('no rgb()/hsl() literal', !/\b(?:rgba?|hsla?)\(/i.test(css));
/* The one media block that may animate, found by brace matching. */
const MQ = '@media (prefers-reduced-motion:no-preference){';
const at = css.indexOf(MQ);
let end = at + MQ.length, depth = 1;
while (depth && end < css.length) { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; end++; }
const inside = css.slice(at + MQ.length, end - 1);
const outside = css.slice(0, at) + css.slice(end);
check('one reduced-motion block, and it is the only @media', at > 0 && (css.match(/@media/g) || []).length === 1);
/* Commas inside parentheses — :has(.a,.b), var(--x,0ms) — are not list commas. */
const split = (s) => {
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') d++; else if (ch === ')') d--;
    if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur].map((x) => x.trim()).filter(Boolean);
};
const rulesOf = (s) => [...s.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  .replace(/@property[^{]*\{[^{}]*\}/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
const sels = [...rulesOf(outside), ...rulesOf(inside)].flatMap(([s]) => split(s));
const unscoped = sels.filter((s) => !s.startsWith(PREFIX));
check(`every selector is behind ${PREFIX} (${sels.length})`, sels.length > 40 && unscoped.length === 0, unscoped.slice(0, 4).join(' | '));
const looseAnim = rulesOf(outside).flatMap(([s, b]) => b.split(';').map((d) => d.trim())
  .filter((d) => /^animation\s*:/.test(d) && !/^animation\s*:\s*(none|ak-show 1ms linear [\d.]+s forwards)$/.test(d))
  .map((d) => `${s.slice(-40)} { ${d} }`));
check('outside it, nothing animates but the 1ms reveal of the boot words', looseAnim.length === 0, looseAnim.join(' | '));
const looseMove = rulesOf(outside).filter(([, b]) => /(?:^|;)\s*(translate|transform)\s*:\s*(?!none|scaleX\(0\)|translateX\(-100%\))/.test(b));
check('…and nothing outside it moves', looseMove.length === 0, looseMove.map(([s]) => s.slice(-50)).join(' | '));
const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const used = new Set([...css.matchAll(/animation\s*:\s*([^;}]+)/g)].flatMap((m) => split(m[1]))
  .map((x) => x.trim().split(/\s+/)[0]).filter((n) => n && n !== 'none'));
const undef = [...used].filter((n) => !defined.has(n));
check('every animation used is defined here, and named ak-*', undef.length === 0 && [...defined].every((n) => n.startsWith('ak-')),
  `${undef.join(' ')} / ${[...defined].join(' ')}`);
check('arkiv.css still carries no @keyframes', !/@keyframes/.test(strip(read('arkiv.css'))));

console.log('\n2 · index.html');
const mw = html.indexOf("href=\"/motion.css\"");
const aw = html.indexOf('<link rel="stylesheet" href="/arkiv.css">');
check('motion.css is written in before arkiv.css, only when data-motion is on', mw > 0 && aw > mw
  && /dataset\.motion === 'on'\)\s*\n\s*document\.write\('<link rel="stylesheet" href="\/motion\.css">'\)/.test(html));
check('the stamp is Arkiv and desktop only, and off under automation unless asked',
  /r\.dataset\.skin === 'arkiv' && !phone/.test(html) && /mo === 'on' \|\| \(mo !== 'off' && !navigator\.webdriver\)/.test(html));
check('app.js starts the layer and hands it each fresh #view',
  /import \{ startMotion, motionView \} from '\.\/motion\.js'/.test(read('app.js'))
  && /startMotion\(\);\s*\n\s*const root = freshView\(\);[\s\S]{0,260}const arriving = motionView\(root\);/.test(read('app.js')));
check('…and replays its entrance (count-ups, lines) only when the page arrives',
  /if \(arriving !== false\) animateView\(root\);/.test(read('app.js')));

/* ══ the browser half ═════════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const fresh = (o = {}) => browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', ...o });
/* Every fx-* class that goes on, with when and on what. */
const LOG = () => {
  window.__fx = [];
  const t0 = performance.now();
  new MutationObserver((l) => {
    for (const r of l) {
      const c = r.target.getAttribute?.('class') || '';
      for (const k of ['fx-enter', 'fx-arrive', 'fx-tick', 'fx-unfold']) {
        if (c.split(/\s+/).includes(k) && !(r.oldValue || '').split(/\s+/).includes(k)) {
          window.__fx.push({ k, t: Math.round(performance.now() - t0), tag: r.target.tagName.toLowerCase(),
            text: (r.target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) });
        }
      }
    }
  }).observe(document, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['class'] });
};
const settle = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForFunction(() => !document.querySelector('#view .skel'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1900);
};
const akAnims = (page) => page.evaluate(() => document.getAnimations()
  .filter((a) => /^ak-/.test(a.animationName || '')).map((a) => a.animationName));

console.log('\n3 · the switch, in a browser');
{
  const ctx = await fresh();
  const asked = [];
  ctx.on('request', (r) => asked.push(new URL(r.url()).pathname));
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop#overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app.ak-shell');
  const off = await page.evaluate(() => ({ m: document.documentElement.dataset.motion || null, busy: !!document.querySelector('#akBusy') }));
  check('under automation, with nothing asked: no data-motion', off.m === null, JSON.stringify(off));
  check('…motion.css is not even requested, and no element is added', !asked.includes('/motion.css') && !off.busy);

  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'domcontentloaded' });
  const on = await page.evaluate(() => ({ m: document.documentElement.dataset.motion || null, stored: localStorage.getItem('fleet.motion'),
    links: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')) }));
  check('?motion=on stamps it and remembers it', on.m === 'on' && on.stored === 'on', JSON.stringify(on));
  check('…motion.css comes before arkiv.css, which stays last',
    on.links.at(-1) === '/arkiv.css' && on.links.indexOf('/motion.css') > on.links.indexOf('/app.css'), on.links.join(' '));
  await page.goto(`${base}/?ui=desktop#overview`, { waitUntil: 'domcontentloaded' });
  check('a later visit keeps it', await page.evaluate(() => document.documentElement.dataset.motion) === 'on');
  await page.goto(`${base}/?ui=desktop&skin=classic#overview`, { waitUntil: 'domcontentloaded' });
  const cl = await page.evaluate(() => ({ m: document.documentElement.dataset.motion || null,
    n: document.querySelectorAll('link[href="/motion.css"]').length }));
  check('never on the Classic skin', cl.m === null && cl.n === 0, JSON.stringify(cl));
  await page.goto(`${base}/?ui=phone&skin=arkiv#overview`, { waitUntil: 'domcontentloaded' });
  const ph = await page.evaluate(() => ({ m: document.documentElement.dataset.motion || null,
    n: document.querySelectorAll('link[href="/motion.css"]').length }));
  check('never on the phone build', ph.m === null && ph.n === 0, JSON.stringify(ph));
  await page.goto(`${base}/?ui=desktop&skin=auto&motion=off#overview`, { waitUntil: 'domcontentloaded' });
  check('?motion=off turns it off and remembers that', await page.evaluate(() =>
    !document.documentElement.dataset.motion && localStorage.getItem('fleet.motion') === 'off'));
  await page.goto(`${base}/?ui=desktop&motion=auto#overview`, { waitUntil: 'domcontentloaded' });
  check('?motion=auto forgets it (and automation is still)', await page.evaluate(() =>
    !document.documentElement.dataset.motion && localStorage.getItem('fleet.motion') === null));
  await ctx.close();
}

console.log('\n4 · the boot sheet');
for (const focus of ['on', 'off']) {
  const ctx = await fresh();
  await ctx.addInitScript((f) => { try { localStorage.setItem('fleet.focus', f); } catch { /* */ } }, focus);
  const page = await ctx.newPage();
  await page.route('**/app.js', () => { /* held: the opening never finishes */ });
  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'commit' });
  await page.waitForTimeout(900);
  const pseudo = (sel, which) => page.evaluate(([s, w]) => {
    const c = getComputedStyle(document.querySelector(s), w);
    return { content: c.content, top: c.top, left: c.left, opacity: c.opacity, font: c.fontFamily, size: c.fontSize };
  }, [sel, which]);
  const word = await pseudo('body', '::before');
  const label = await pseudo('#app', '::before');
  const shellX = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--shell-x').trim());
  check(`focus ${focus}: the wordmark stands where the masthead's will`, word.content === '"FleetMirror"'
    && word.top === (focus === 'on' ? '12px' : '37px') && /Fraunces/.test(word.font), JSON.stringify(word) + shellX);
  check(`focus ${focus}: the label is up after its beat`, /Opening the dashboard/.test(label.content) && +label.opacity === 1,
    JSON.stringify(label));
  const early = await pseudo('#app', '::after');
  await page.waitForTimeout(3600);
  const late = await pseudo('#app', '::after');
  check(`focus ${focus}: the sentence waits four seconds, then says why`, +early.opacity === 0 && +late.opacity > 0.95
    && /loads most of its pages before it shows the first one/.test(late.content), `${early.opacity} → ${late.opacity}`);
  await ctx.close();
}
{
  /* The real masthead, for the numbers the sheet copies. */
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app.ak-shell');
  const real = await page.evaluate(() => {
    const r = document.querySelector('.mast-word').getBoundingClientRect();
    const sx = parseFloat(getComputedStyle(document.querySelector('#mast')).paddingLeft);
    const after = getComputedStyle(document.body, '::before').content;
    return { x: r.x, y: r.y, sx, after, sec: document.querySelector('#secRow').getBoundingClientRect().top };
  });
  check('the real wordmark is at the gutter and 12px down, the section rule at 47px — the sheet’s numbers',
    Math.abs(real.x - real.sx) < 0.5 && Math.abs(real.y - 12) < 0.5 && Math.abs(real.sec - 47.1) < 1, JSON.stringify(real));
  check('…and the sheet is gone on the frame the shell lands', real.after === 'none', real.after);
  await ctx.close();
}
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.route('**/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("boot")' }));
  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'commit' });
  await page.waitForTimeout(1200);
  const f = await page.evaluate(() => ({ boot: document.documentElement.dataset.boot || null,
    label: getComputedStyle(document.querySelector('#app'), '::before').content,
    line: getComputedStyle(document.querySelector('#app'), '::after').content }));
  check('an opening that STOPPED says so, not "still opening"', f.boot === 'failed'
    && /stopped opening/.test(f.label) && /Reload the page/.test(f.line), JSON.stringify(f));
  await ctx.close();
}

console.log('\n5 · a page arriving, a redraw, content after a wait, the busy line');
{
  const ctx = await fresh();
  await ctx.addInitScript(LOG);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  /* One slow answer, so a skeleton is really watched. */
  let slow = true;
  await page.route('**/api/kpis*', async (r) => { if (slow) await new Promise((ok) => setTimeout(ok, 700)); r.continue(); });
  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app.ak-shell');
  const during = await page.evaluate(() => ({ busy: document.documentElement.hasAttribute('data-busy'),
    bar: !!document.querySelector('#akBusy'), enter: document.querySelector('#view').classList.contains('fx-enter') }));
  const running = await akAnims(page);
  check('a page arriving: #view takes the entrance', during.enter, JSON.stringify(during));
  check('…blocks settle and rules are drawn (ak-in, ak-pen running)', running.includes('ak-in') && running.includes('ak-pen'),
    [...new Set(running)].join(' '));
  check('the busy line is there and on while the page’s requests are out', during.bar && during.busy, JSON.stringify(during));
  await settle(page);
  const after = await page.evaluate(() => ({ busy: document.documentElement.hasAttribute('data-busy'),
    left: document.querySelectorAll('.fx-enter, .fx-arrive, .fx-tick, .fx-unfold').length, fx: window.__fx.splice(0) }));
  check('…and off once they are in', !after.busy);
  check('content that replaced a watched skeleton came up', after.fx.some((e) => e.k === 'fx-arrive'),
    JSON.stringify(after.fx.map((e) => e.k)));
  check('an arrival marks no figure as moved — a count-up on its way is not a change',
    !after.fx.some((e) => e.k === 'fx-tick'), JSON.stringify(after.fx.filter((e) => e.k === 'fx-tick').slice(0, 3)));
  check('no motion class is left behind', after.left === 0, String(after.left));
  const rest = await akAnims(page);
  check('at rest, nothing of the layer is running', rest.length === 0, rest.join(' '));

  slow = false;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('data:refreshed', { detail: { path: '/api/kpis' } })));
  /* Every value each tile shows while the page is drawn again. */
  const shown = await page.evaluate(async () => {
    const seen = new Map();
    for (let i = 0; i < 24; i++) {
      document.querySelectorAll('#view .kpi').forEach((k, j) => {
        const v = k.querySelector('.n')?.textContent.trim();
        if (v) seen.set(j, (seen.get(j) || new Set()).add(v));
      });
      await new Promise((ok) => setTimeout(ok, 50));
    }
    return [...seen.values()].map((x) => [...x]);
  });
  check('…and keeps still while it does: no tile counts up again (each shows one value)',
    shown.length > 0 && shown.every((v) => v.length === 1), JSON.stringify(shown.filter((v) => v.length > 1).slice(0, 2)));
  await settle(page);
  const redraw = await page.evaluate(() => window.__fx.splice(0));
  check('a REDRAW of the same page replays no entrance, brings nothing up, washes nothing (data unchanged)',
    redraw.length === 0, JSON.stringify(redraw));

  await page.evaluate(() => { location.hash = '#drivers'; });
  await settle(page);
  const nav = await page.evaluate(() => window.__fx.splice(0));
  check('a new address is a page arriving again', nav.some((e) => e.k === 'fx-enter'), JSON.stringify(nav.map((e) => e.k)));
  check('no page error along the way', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n6 · a figure that moved');
{
  const ctx = await fresh();
  await ctx.addInitScript(LOG);
  const page = await ctx.newPage();
  let bump = 0;
  /* The real refresh path: the page draws from this browser's copy, the
     live answer differs, data.js fires data:refreshed, app.js redraws. */
  await page.route('**/api/kpis*', async (r) => {
    if (!bump) return r.continue();
    const res = await r.fetch();
    const j = await res.json();
    j.trips = (+j.trips || 0) + bump;
    return r.fulfill({ response: res, json: j });
  });
  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'domcontentloaded' });
  await settle(page);
  const tile = (label) => page.evaluate((l) => [...document.querySelectorAll('#view .kpi')]
    .find((k) => (k.querySelector('.l')?.textContent || '').trim().toLowerCase().startsWith(l))?.querySelector('.n')?.textContent.trim(), label);
  const before = await tile('trips');
  await page.evaluate(() => window.__fx.splice(0));
  bump = 7;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('data:refreshed', { detail: { path: '/api/kpis' } })));
  await page.waitForTimeout(600);
  await settle(page);
  const now = await tile('trips');
  const fx = await page.evaluate(() => window.__fx.splice(0));
  const ticks = fx.filter((e) => e.k === 'fx-tick');
  check('the live answer moved the Trips figure', before && now && before !== now, `${before} → ${now}`);
  check('…and the Trips figure, settled, took the wash', ticks.some((e) => e.text === now), JSON.stringify(ticks));
  check('…after the count-up had landed, not on its way (one wash per moved figure)',
    ticks.filter((e) => e.text === now).length === 1 && ticks.every((e) => !/^0\b|^AED 0\.00/.test(e.text)), JSON.stringify(ticks));
  const dist = await tile('distance');
  check('a figure that did not move took none', dist && !ticks.some((e) => e.text === dist), JSON.stringify(ticks.map((e) => e.text)));
  check('no entrance on that redraw', !fx.some((e) => e.k === 'fx-enter'));
  await ctx.close();
}

console.log('\n7 · reduced motion');
{
  const ctx = await fresh({ reducedMotion: 'reduce' });
  await ctx.addInitScript(LOG);
  const page = await ctx.newPage();
  await page.route('**/app.js', async (r) => { await new Promise((ok) => setTimeout(ok, 700)); r.continue(); });
  await page.goto(`${base}/?ui=desktop&motion=on#overview`, { waitUntil: 'commit' });
  await page.waitForTimeout(500);
  const sheet = await page.evaluate(() => ({ word: getComputedStyle(document.body, '::before').content,
    anims: document.getAnimations().map((a) => a.animationName) }));
  check('the boot sheet’s words still show', sheet.word === '"FleetMirror"', JSON.stringify(sheet));
  check('…with nothing of it moving: no pen, only the 1ms reveal', sheet.anims.every((n) => n === 'ak-show'), sheet.anims.join(' '));
  await page.waitForSelector('#app.ak-shell');
  const seen = new Set();
  for (let i = 0; i < 8; i++) { (await akAnims(page)).forEach((n) => seen.add(n)); await page.waitForTimeout(120); }
  await settle(page);
  const fx = await page.evaluate(() => window.__fx);
  check('no animation of this layer runs on the page', seen.size === 0, [...seen].join(' '));
  check('…and motion.js puts no class on', fx.length === 0, JSON.stringify(fx.map((e) => e.k)));
  await ctx.close();
}

console.log('\n8 · bounded on a big page');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop&motion=on#drivers`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#app.ak-shell');
  let peak = 0, cells = 0;
  for (let i = 0; i < 12; i++) {
    const a = await page.evaluate(() => {
      const l = document.getAnimations().filter((x) => /^ak-/.test(x.animationName || ''));
      return { n: l.length, cells: l.filter((x) => /^(TD|TR|TH)$/.test(x.effect?.target?.tagName || '')).length };
    });
    peak = Math.max(peak, a.n); cells += a.cells;
    await page.waitForTimeout(100);
  }
  check(`at most a few dozen movements at once (peak ${peak})`, peak > 0 && peak <= 80, String(peak));
  check('no table cell or row ever animates', cells === 0, String(cells));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
