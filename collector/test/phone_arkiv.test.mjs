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
     2. THE SHELL — the wordmark or the back arrow, the control bar naming
        the window, channel and fleet (and saying which do not apply, in the
        desktop's words), the sheet, the footer with the principle, 44px
        targets, 360px, dark mode, and the browser chrome's colour.
     3. THE COMPONENTS — a card is a ruled, numbered section; the statement
        band; tiles with the hero, the highlight, ink figures, the reason in
        the value slot; the dot (ruling 1) on tiles, statements and rows;
        44px controls with an ink fill for the chosen one; ink share bars.
     9. EVERY SCREEN — every word the old screen printed from the same
        answers is on the new one; nothing sideways at 390 or 360; every
        control at least 44px; no miss, no error.

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

console.log('\n2 · the shell: wordmark or back, the control bar, the sheet, the footer');
{
  const { appliesSentence } = await import('../api/public/shell.js');
  const { PRINCIPLE } = await import('../api/public/ui.js');
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  const shell = () => p.page.evaluate(() => {
    const vis = (e) => !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0;
    const box = (e) => { const r = e.getBoundingClientRect(); return { w: r.width, h: r.height }; };
    const word = document.querySelector('.m-head .ak-word');
    const back = document.querySelector('.m-head .m-ico[title="Back"]');
    const deck = document.querySelector('.m-deck');
    const foot = deck?.querySelector(':scope > .pf-inline');
    return {
      word: vis(word), wordFace: word ? getComputedStyle(word).fontFamily : '', wordHref: word?.getAttribute('href'),
      back: vis(back), dots: !!document.querySelector('.m-head .m-ico[title="Window and channels"]'),
      ctl: [...document.querySelectorAll('.ak-ctl .ak-ctl-p')].map((s) => s.textContent),
      ctlBox: document.querySelector('.ak-ctl') ? box(document.querySelector('.ak-ctl')) : null,
      order: [...document.getElementById('m').children].map((c) => c.className.split(' ')[0]),
      first: deck?.firstElementChild?.className, firstText: deck?.firstElementChild?.textContent,
      last: deck?.lastElementChild === foot, principle: foot?.querySelector('.pf-principle')?.textContent,
      basis: !!foot?.querySelector('.pf-basis .srcline'),
      colophon: [...(foot?.querySelectorAll('.pf-colophon span') || [])].map((s) => s.textContent),
      small: [...document.querySelectorAll('.m-ico, .ak-word, .ak-ctl, .m-tab')].filter(vis)
        .filter((e) => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; })
        .map((e) => `${e.className} ${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content),
      paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
    };
  });
  await p.open('today');
  let s = await shell();
  check('the header, the control bar, the deck and the tabs, in that order',
    s.order.join(' ') === 'm-head ak-ctl m-deck m-tabs', s.order.join(' '));
  check('at a tab’s root the wordmark stands where the back arrow would, and there is no back',
    s.word && !s.back, JSON.stringify({ word: s.word, back: s.back }));
  check('…the wordmark is Fraunces, the one serif left', /Fraunces/.test(s.wordFace), s.wordFace);
  check('…and it leads to Today, keeping the window in the address', /^#today\?/.test(s.wordHref || ''), s.wordHref);
  check('the ⋮ is gone: the control bar replaces it', !s.dots);
  check('the control bar names the window, the channel and the fleet',
    s.ctl.join(' | ') === 'This month | All channels | Both fleets', s.ctl.join(' | '));
  check('…and is a target a thumb can hit', s.ctlBox && s.ctlBox.h >= 44, JSON.stringify(s.ctlBox));
  check('the deck ends with the footer', s.last);
  check('…which prints the house principle verbatim', s.principle === PRINCIPLE, s.principle);
  check('…the phone’s own source line as its basis', s.basis);
  check('…and a colophon naming the window and the clock',
    s.colophon[0] === 'This month · Dubai time' && s.colophon[1] === 'Ecosine & Egari', s.colophon.join(' | '));
  check('every header control, the bar and every tab is at least 44px square', !s.small.length, s.small.join(' · '));
  check('the browser chrome takes the paper the screen is drawn on (no hex written twice)',
    s.meta.length === 2 && s.meta.every((c) => c === s.paper) && s.paper.toLowerCase() === '#ffffff', `${s.meta} / ${s.paper}`);
  check('nothing pushes the page sideways at 390px', s.overflow <= 0, String(s.overflow));

  await p.open('driver/drv-0');
  s = await shell();
  check('deeper, the back arrow comes back and the wordmark steps aside', s.back && !s.word);
  check('…and a person’s screen says the channel and fleet are not applied',
    s.ctl.join(' | ') === 'This month | Channel and fleet not applied', s.ctl.join(' | '));
  check('…with the desktop’s own reason first in the deck',
    s.first === 'ak-applies' && s.firstText === appliesSentence('driver'), `${s.first}: ${s.firstText}`);

  await p.open('live');
  s = await shell();
  check('#live: no window, and the channel and fleet not applied',
    s.ctl.join(' | ') === 'No window applies here | Channel and fleet not applied', s.ctl.join(' | '));
  check('…and the sentence says why, in the desktop’s words',
    s.firstText === appliesSentence('live'), s.firstText);
  await p.open('payouts');
  s = await shell();
  check('#payouts: no window, but the channel chips still govern it',
    s.ctl.join(' | ') === 'No window applies here | All channels | Both fleets', s.ctl.join(' | '));
  check('…and it says the window does not apply, and why', s.firstText === appliesSentence('payouts'), s.firstText);
  await p.open('more');
  s = await shell();
  check('More reads no window and no channel, and the bar says so rather than naming one',
    s.ctl.join(' | ') === 'No window applies here | Channel and fleet not applied', s.ctl.join(' | '));
  check('…and still closes on the principle, with no basis line (it describes no feed)',
    s.principle === PRINCIPLE && !s.basis);

  /* The sheet: opened from the bar, the same three groups, every choice a
     44px target, and a choice made there shows in the bar. */
  await p.open('live');
  await p.page.click('.ak-ctl');
  await p.settle();
  await p.page.waitForTimeout(350);
  const sh = await p.page.evaluate(() => {
    const sheet = document.querySelector('.m-sheet');
    const vis = (e) => e.getBoundingClientRect().height > 0;
    return {
      open: !!sheet, head: sheet?.querySelector('.ak-sheet-h')?.textContent,
      applies: sheet?.querySelector('.ak-applies')?.textContent,
      groups: [...(sheet?.querySelectorAll('h3') || [])].map((h) => h.textContent),
      small: [...(sheet?.querySelectorAll('button, input') || [])].filter(vis)
        .filter((b) => b.getBoundingClientRect().height < 44)
        .map((b) => `${b.className || b.tagName}:${b.textContent.trim().slice(0, 12)} ${Math.round(b.getBoundingClientRect().height)}`),
      radius: sheet ? getComputedStyle(sheet).borderTopLeftRadius : null,
    };
  });
  check('the bar opens the window sheet', sh.open && sh.head === 'Window, channel and fleet', JSON.stringify(sh.head));
  check('…which says first which of its choices this screen ignores', sh.applies === appliesSentence('live'), sh.applies);
  check('…with the same three groups', sh.groups.join(' | ') === 'Window | Channel | Fleet', sh.groups.join(' | '));
  check('…squared off', sh.radius === '0px', sh.radius);
  check('…and every choice in it at least 44px tall', !sh.small.length, sh.small.slice(0, 6).join(' · '));
  await p.page.click('.m-sheet .m-opt:has-text("Uber")');
  await p.settle();
  await p.open('today?platform=uber');
  s = await shell();
  check('a channel chosen is named in the bar on a screen it governs',
    s.ctl.join(' | ') === 'This month | Uber | Both fleets', s.ctl.join(' | '));
  await p.close();

  /* 360px, and dark. */
  const narrow = await phonePage(browser, { skin: 'arkiv', fixture, width: 360, height: 780 });
  await narrow.open('live');
  const n = await narrow.page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    lines: (() => { const parts = [...document.querySelectorAll('.ak-ctl .ak-ctl-p')];
      return parts.map((x) => Math.round(x.getBoundingClientRect().top)); })(),
    firstOnLine2: (() => { const parts = [...document.querySelectorAll('.ak-ctl .ak-ctl-p')];
      const t = parts.map((x) => x.getBoundingClientRect().top);
      const second = parts.find((x, i) => i && t[i] > t[0] + 2);
      return second ? getComputedStyle(second, '::before').content : null; })(),
  }));
  check('at 360px nothing pushes the page sideways', n.overflow <= 0, String(n.overflow));
  check('…and a bar that wraps opens its second line on a word, not on a dot',
    n.firstOnLine2 == null || n.firstOnLine2 === 'none' || n.firstOnLine2 === 'normal', String(n.firstOnLine2));
  await narrow.close();
  for (const theme of ['dark', 'dark-chosen']) {
    const dk = await phonePage(browser, { skin: 'arkiv', fixture, theme });
    await dk.open('today');
    const d = await dk.page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { paper: cs.getPropertyValue('--paper').trim(), ink: cs.getPropertyValue('--ink').trim(),
        body: getComputedStyle(document.body).backgroundColor,
        h1: getComputedStyle(document.querySelector('.m-head h1')).color,
        meta: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content) };
    });
    check(`${theme}: the phone draws on the Arkiv dark paper, in the dark ink`,
      d.paper.toLowerCase() === '#111113' && d.body === 'rgb(17, 17, 19)' && d.h1 === 'rgb(240, 240, 241)',
      JSON.stringify(d));
    check(`${theme}: …and the browser chrome follows it`, d.meta.every((c) => c === d.paper), d.meta.join(' '));
    await dk.close();
  }

  /* Held back: the first render still builds the new shell, because the
     parser holds the deferred module until the sheet is in. */
  const slow = await phonePage(browser, { skin: 'arkiv', fixture, frozen: false, hold: { '/m/arkiv-m.css': 1500 } });
  await slow.open('more');
  check('with the sheet held back 1.5s, the first render is still the new shell',
    await slow.page.evaluate(() => !!document.querySelector('.ak-ctl') && !document.querySelector('.m-head .m-ico[title="Window and channels"]')));
  await slow.close();
}

console.log('\n3 · the components: sections, statement, tiles, the dot, rows, controls, marks');
{
  const T = await import('../api/public/tokens.js');
  const hexOf = (rgb) => {
    const m = String(rgb).match(/\d+(\.\d+)?/g);
    return m ? `#${m.slice(0, 3).map((x) => Math.round(+x).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null;
  };
  const INK = T.NEUTRAL.ink.toUpperCase(), NEG = T.SEMANTIC.negative.toUpperCase(), POS = T.SEMANTIC.positive.toUpperCase();
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('more');
  /* A test host inside the real deck, built with the real components, so
     every rule the screens will meet is met here with known inputs. */
  const m = await p.page.evaluate(async () => {
    const U = await import('/m/ui.js');
    const deck = document.querySelector('.m-deck');
    const host = document.createElement('div');
    host.id = 'akhost';
    deck.prepend(host);
    const { card, lede, stats, stat, row, rows, seg, chips, bars, atGlance } = U;
    const c = card('A section', 'its caption');
    host.append(c.card);
    lede(host, { claim: 'A warning claim', sub: 'why', tone: 'warn' });
    lede(host, { claim: 'A critical claim', sub: 'why', tone: 'bad' });
    lede(host, { claim: 'A good claim', sub: 'why', tone: 'good' });
    const g = atGlance(host, [
      { label: 'Hero', value: '1,234' },
      { label: 'Warned', value: '5', tone: 'warn' },
      { label: 'Bad', value: '6', tone: 'bad' },
      { label: 'Good', value: '7', tone: 'good' },
      { label: 'Linked', value: '8', href: '#live' },
      { label: 'Unmeasured', value: '—', sub: 'no channel reports it' },
    ], { note: 'This month' });
    const absHero = stats(host, [{ label: 'Absent hero', value: '—', sub: 'the feed did not answer' },
      { label: 'Next', value: '2' }], false, { hero: true });
    const rs = rows(host, [
      row({ title: 'plain', value: '1' }),
      row({ title: 'warn', value: '2', tone: 'warn' }),
      row({ title: 'bad', value: '3', tone: 'bad' }),
      row({ title: 'critical', value: '4', tone: 'critical' }),
      row({ title: 'good', value: '5', tone: 'good' }),
      row({ title: 'link', value: '6', note: 'bookings', to: '#live' }),
    ]);
    seg(host, [{ id: 'a', label: 'One' }, { id: 'b', label: 'Two' }], 'a', () => {});
    chips(host, [{ id: 'x', label: 'Chip' }, { id: 'y', label: 'Other' }], 'y', () => {});
    bars(host, [{ label: 'cash', n: 60 }, { label: 'card', n: 30 }, { label: 'x', n: 5 }, { label: 'y', n: 3 },
      { label: 'z', n: 1 }, { label: 'w', n: 1 }, { label: 'v', n: 1 }], { max: 6 });
    const cs = (e, pseudo) => getComputedStyle(e, pseudo);
    const hexOf = (rgb) => {
      const x = String(rgb).match(/\d+(\.\d+)?/g);
      return x ? `#${x.slice(0, 3).map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('').toUpperCase()}` : null;
    };
    const dot = (e) => { const s = cs(e, '::before');
      return { content: s.content, bg: s.backgroundColor, bs: s.borderTopStyle, bw: s.borderTopWidth, bc: s.borderTopColor,
        w: s.width }; };
    const tiles = [...g.children];
    const tn = (i) => tiles[i].querySelector('.n');
    return {
      cardRule: `${cs(c.card).borderTopWidth} ${cs(c.card).borderTopColor}`, cardRadius: cs(c.card).borderTopLeftRadius,
      cardShadow: cs(c.card).boxShadow, h2Font: cs(c.card.querySelector('h2')).fontFamily,
      h2Idx: cs(c.card.querySelector('h2'), '::before').content,
      capSize: cs(c.card.querySelector('.m-cap')).fontSize,
      ledes: [...host.querySelectorAll('.m-lede')].map((l) => ({ rule: `${cs(l).borderTopWidth} ${cs(l).borderTopColor}`,
        dot: dot(l.querySelector('b')), claim: cs(l.querySelector('b')).color, font: cs(l.querySelector('b')).fontFamily })),
      head: host.querySelector('.sechd')?.textContent, band: g.dataset.band,
      hero: tiles[0].classList.contains('hero'), heroSpan: cs(tiles[0]).gridColumnStart + '/' + cs(tiles[0]).gridColumnEnd,
      heroHl: !!tn(0).querySelector('.hl'), heroSize: parseFloat(cs(tn(0)).fontSize),
      heroText: tn(0).textContent,
      digits: [1, 2, 3].map((i) => hexOf(cs(tn(i)).color)),
      tileDots: [1, 2, 3].map((i) => dot(tiles[i].querySelector('.l'))),
      valueFont: cs(tn(1)).fontFamily, numeric: cs(tn(1)).fontVariantNumeric,
      linkChevron: cs(tiles[4].querySelector('.l'), '::after').content,
      absent: { text: tn(5).textContent, na: tn(5).classList.contains('t-na'), marked: tn(5).hasAttribute('data-absent'),
        sub: !!tiles[5].querySelector('.s'), hl: !!tn(5).querySelector('.hl') },
      absHero: { hl: !!absHero.querySelector('.hl'), text: absHero.querySelector('.n').textContent },
      rows: [...rs.children].map((r) => ({ cls: r.className, inline: r.querySelector('.v b')?.style.color || '',
        color: hexOf(cs(r.querySelector('.v b')).color), font: cs(r.querySelector('.v b')).fontFamily,
        dot: dot(r.querySelector('.v b')), h: r.getBoundingClientRect().height })),
      rowsBox: `${cs(rs).borderLeftWidth} ${cs(rs).borderTopLeftRadius}`,
      seg: [...host.querySelectorAll('.m-seg button')].map((b) => ({ h: b.getBoundingClientRect().height,
        bg: hexOf(cs(b).backgroundColor), fg: hexOf(cs(b).color), on: b.classList.contains('on') })),
      chips: [...host.querySelectorAll('.m-chips .m-chip')].map((b) => ({ h: b.getBoundingClientRect().height,
        bg: hexOf(cs(b).backgroundColor), on: b.classList.contains('on') })),
      bars: { inline: [...host.querySelectorAll('[style*="background"]')].length,
        fill: host.querySelector('.ak-bar-t > i') ? hexOf(cs(host.querySelector('.ak-bar-t > i')).backgroundColor) : null,
        shares: [...host.querySelectorAll('.ak-bar-n')].map((e) => e.textContent),
        more: host.querySelector('.ak-bars > .m-cap')?.textContent },
      paper: hexOf(cs(document.body).backgroundColor),
    };
  });
  const is = (rgb, hex) => hexOf(rgb) === hex;
  const solid = (d, hex) => d.content !== 'none' && is(d.bg, hex) && (d.bs === 'none' || d.bw === '0px');
  const hollow = (d) => d.content !== 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(d.bg) && d.bs === 'solid' && is(d.bc, NEG);
  /* 1.5px in the sheet; at a device pixel ratio of 1 Chromium snaps a border
     to whole pixels and reports 1px, so the width is read from the source and
     the colour and the rest from the browser. */
  check('a card is a section: a 1.5px ink rule, no box, no radius, no shadow',
    /\.m-card\{background:none;border:0;border-top:1\.5px solid var\(--ink\)/.test(strip(read('m/arkiv-m.css')))
    && /^1(\.5)?px /.test(m.cardRule) && is(m.cardRule.split(' ').slice(1).join(' '), INK) && m.cardRadius === '0px' && m.cardShadow === 'none',
    `${m.cardRule} ${m.cardRadius} ${m.cardShadow}`);
  check('…its title a mono section head, numbered from the deck’s counter',
    /Plex Mono/.test(m.h2Font) && /counter\(arkiv-sec/.test(m.h2Idx), `${m.h2Font} ${m.h2Idx}`);
  check('…and its caption a sentence at a caption’s size, not the body’s', parseFloat(m.capSize) < 13, m.capSize);
  const [lw, lb, lg] = m.ledes;
  check('the statement: warning is a 3px negative rule and a HOLLOW dot (ruling 1)',
    /^3px/.test(lw.rule) && is(lw.rule.split(' ').slice(1).join(' '), NEG) && hollow(lw.dot), JSON.stringify(lw));
  check('…critical a SOLID red dot', solid(lb.dot, NEG), JSON.stringify(lb.dot));
  check('…good a solid green dot on a green rule', solid(lg.dot, POS) && is(lg.rule.split(' ').slice(1).join(' '), POS),
    JSON.stringify(lg));
  check('…and the claim itself stays ink, in Karla', m.ledes.every((l) => is(l.claim, INK) && /Karla/.test(l.font)));
  check('00 · At a glance heads the tiles, with the window as its note',
    /^00\s*At a glance\s*This month$/.test((m.head || '').replace(/\s+/g, ' ').replace(/^00 /, '00 ')) || /00.*At a glance.*This month/.test(m.head || ''),
    m.head);
  check('…the tiles are one band', m.band === 'glance');
  check('the hero spans the row, at a display size, carrying the one highlight',
    m.hero && m.heroSpan === '1/-1' && m.heroHl && m.heroSize >= 36 && m.heroText === '1,234',
    JSON.stringify({ span: m.heroSpan, hl: m.heroHl, size: m.heroSize, text: m.heroText }));
  check('a toned tile keeps INK figures (L4)', m.digits.every((h) => h === INK), m.digits.join(' '));
  check('…the warning is a hollow dot in its label row', hollow(m.tileDots[0]), JSON.stringify(m.tileDots[0]));
  check('…bad a solid red one, good a solid green one',
    solid(m.tileDots[1], NEG) && solid(m.tileDots[2], POS), JSON.stringify(m.tileDots.slice(1)));
  check('…the figure in Karla with proportional figures',
    /Karla/.test(m.valueFont) && /proportional-nums/.test(m.numeric), `${m.valueFont} ${m.numeric}`);
  check('a tile that is a link says so with a chevron', /›/.test(m.linkChevron), m.linkChevron);
  check('a tile with no figure prints its REASON in the value slot, marked absent, once',
    m.absent.text === 'no channel reports it' && m.absent.na && m.absent.marked && !m.absent.sub,
    JSON.stringify(m.absent));
  check('…and an absent hero is explained, never highlighted (L4, L5.8)',
    !m.absHero.hl && m.absHero.text === 'the feed did not answer', JSON.stringify(m.absHero));
  const [rPlain, rWarn, rBad, rCrit, rGood, rLink] = m.rows;
  check('a row’s tone is a class, not an inline colour', [rWarn, rBad, rCrit, rGood].every((r) => !r.inline)
    && /t-warn/.test(rWarn.cls) && /t-bad/.test(rBad.cls) && /t-critical/.test(rCrit.cls) && /t-good/.test(rGood.cls),
    m.rows.map((r) => `${r.cls}|${r.inline}`).join(' '));
  check('…its figure INK in Plex Mono', m.rows.every((r) => r.color === INK && /Plex Mono/.test(r.font)),
    m.rows.map((r) => `${r.color} ${r.font}`).join(' | '));
  check('…with the dot: hollow for a warning, solid red for bad and critical, solid green for good',
    hollow(rWarn.dot) && solid(rBad.dot, NEG) && solid(rCrit.dot, NEG) && solid(rGood.dot, POS) && rPlain.dot.content === 'none',
    JSON.stringify([rWarn.dot, rBad.dot, rGood.dot, rPlain.dot.content]));
  check('…and every row at least 52px', m.rows.every((r) => r.h >= 52), m.rows.map((r) => r.h).join(' '));
  check('the list has no box around it', m.rowsBox === '0px 0px', m.rowsBox);
  check('the segmented control: 44px, the chosen one an INK FILL with paper words',
    m.seg.every((b) => b.h >= 44) && m.seg[0].on && m.seg[0].bg === INK && m.seg[0].fg === m.paper,
    JSON.stringify(m.seg));
  check('the chips: 44px, the chosen one an ink fill', m.chips.every((c) => c.h >= 44) && m.chips[1].on && m.chips[1].bg === INK,
    JSON.stringify(m.chips));
  check('the share bars are INK, with no colour cycled by position', m.bars.inline === 0 && m.bars.fill === INK,
    JSON.stringify(m.bars));
  check('…each share is of EVERYTHING, and the rest is counted', m.bars.shares[0] === '60 · 59%'
    && m.bars.more === '1 more, 1% between them.', JSON.stringify(m.bars));
  await p.close();
}

/* ══ 4 · the screens, one by one ══════════════════════════════════════════
   Each screen's figures are compared with the recorded answer they came
   from, and its order with the plan's. `ans(path)` is that answer, parsed. */
const ans = (key) => { const a = fixture.answers[key]; return a ? JSON.parse(a.body) : null; };
const f0 = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const KP = ans('/api/kpis?period=month&grain=auto');

console.log('\n4.1 · Today: the livebar, 00 at a glance, the sections, † what it does not know');
{
  const { UBER_FARE_WHY } = await import('../api/public/ui.js');
  const c = await phonePage(browser, { skin: 'classic', fixture });
  await c.open('today');
  const oldLatest = await c.page.evaluate(() => [...document.querySelectorAll('.m-deck .m-cap')]
    .map((p) => p.textContent).find((t) => /^Latest booking /.test(t)) || null);
  await c.close();
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('today');
  const t = await p.page.evaluate(() => {
    const deck = document.querySelector('.m-deck');
    const kids = [...deck.children];
    const at = (pred) => kids.findIndex(pred);
    const live = deck.querySelector('.m-card.ak-live');
    const tile = (grid, label) => [...grid.querySelectorAll('.m-stat')].find((s) => s.querySelector('.l').textContent === label);
    const lt = live && tile(live, 'Latest booking');
    const glance = deck.querySelector('.m-stats[data-band="glance"]');
    const hero = glance?.querySelector('.m-stat.hero');
    const band = deck.querySelector('.absence');
    return {
      order: {
        live: at((k) => k === live), head: at((k) => k.classList.contains('sechd')),
        lede: at((k) => k.classList.contains('m-lede')), tiles: at((k) => k === glance),
        chart: at((k) => k.querySelector?.(':scope > h2')?.textContent === 'Bookings a day'),
        who: at((k) => k.textContent === 'Who called it off'), band: at((k) => k === band),
        foot: at((k) => k.classList.contains('pf-inline')), n: kids.length,
      },
      liveIdx: live ? getComputedStyle(live.querySelector('h2'), '::before').content : null,
      liveCap: live?.querySelector('.m-cap')?.textContent,
      latest: lt ? lt.querySelector('.n').textContent : null,
      tripDeco: live ? getComputedStyle(tile(live, 'Trip value').querySelector('.n')).textDecorationThickness : null,
      head: deck.querySelector('.sechd')?.innerText.replace(/\s+/g, ' '),
      hero: hero ? { label: hero.querySelector('.l').textContent, value: hero.querySelector('.n').textContent,
        hl: !!hero.querySelector('.n .hl') } : null,
      cells: band ? [...band.querySelectorAll('.absb-cell')].map((c) => ({ label: c.querySelector('.absb-lab').textContent,
        fig: c.querySelector('.absb-fig').textContent, why: c.querySelector('.absb-why')?.textContent })) : [],
      bandHead: band?.querySelector('.sechd-name')?.textContent,
      hls: document.querySelectorAll('.hl').length,
    };
  });
  const o = t.order;
  check('the livebar leads, then 00 (its head, the statement, the tiles), then the chart, then the sections',
    o.live === 0 && o.head > o.live && o.lede === o.head + 1 && o.tiles === o.lede + 1 && o.chart > o.tiles
      && o.who > o.chart && o.band > o.who && o.foot === o.n - 1 && o.band === o.n - 2, JSON.stringify(o));
  check('the livebar is unnumbered (an ink dot, not 01)', t.liveIdx === '""', t.liveIdx);
  check('…and says it does not follow the window or the channel in the bar above it',
    /both fleets, every channel — not the window or the channel in the bar above$/.test(t.liveCap || ''), t.liveCap);
  check('Latest booking is one of its figures, the same minute the old caption printed',
    t.latest && oldLatest === `Latest booking ${t.latest}.`, `${t.latest} / ${oldLatest}`);
  check('…and Trip value carries the strip’s own emphasis, a 3px rule', t.tripDeco === '3px', t.tripDeco);
  check('00 · At a glance, over the window the control bar names', /^00 At a glance This month$/i.test(t.head || ''), t.head);
  check(`the hero is the window’s bookings, ${f0(KP.trips)} as /api/kpis answered, highlighted`,
    t.hero && t.hero.label === 'Bookings' && t.hero.value === f0(KP.trips) && t.hero.hl, JSON.stringify(t.hero));
  const unpriced = t.cells.find((c) => c.label === 'Bookings not yet priced');
  const noKm = t.cells.find((c) => c.label === 'Bookings carrying no distance');
  check('† names what the screen does not know', t.bandHead === '† What this screen does not know', t.bandHead);
  check(`…the unpriced bookings, ${f0(KP.trips - KP.priced_trips)} (/api/kpis trips − priced_trips)`,
    unpriced?.fig === f0(KP.trips - KP.priced_trips), JSON.stringify(unpriced));
  check('…with the desktop’s true reason, built on UBER_FARE_WHY',
    (unpriced?.why || '').includes(UBER_FARE_WHY) && (unpriced?.why || '').startsWith(`${f0(KP.priced_trips)} of ${f0(KP.trips)} bookings carry a price`));
  check(`…the bookings with no distance, ${f0(KP.trips - KP.trips_with_distance)}, and the mean they leave out`,
    noKm?.fig === f0(KP.trips - KP.trips_with_distance)
      && (noKm?.why || '').includes(`over the ${f0(KP.trips_with_distance)} that carry one, never over all ${f0(KP.trips)}`),
    JSON.stringify(noKm));
  check('…an unmapped outcome only when there is one (the answer has none)',
    KP.other_outcome ? !!t.cells.find((c) => c.label === 'Outcome not mapped') : !t.cells.find((c) => c.label === 'Outcome not mapped'));
  check('two highlights on the screen — the hero and the figure that sizes the gap — within SPEC L4’s three',
    t.hls === 2, String(t.hls));
  /* The same reasons as the desktop #overview, word for word: the phone
     cannot import app.js, so the phone repeats them, and this is what keeps
     the two from drifting. */
  const appJs = read('app.js');
  const scr = read('m/screens.js');
  for (const s of ['bookings carry a price, and Trip value is over those alone. ',
    ', so the newest Uber bookings are priced only after it; a booking cancelled ',
    'without a fee has no price to carry.',
    'The channel filed these bookings with no distance on them. The Distance tile\'s mean is over the ',
    'that carry one, never over all ', ' name no plate, so they ', 'can appear on no per-car page.']) {
    check(`the phone’s reason is the desktop’s: "${s.trim().slice(0, 48)}…"`, appJs.includes(s) && scr.includes(s));
  }
  await p.close();
}

/* The deck's children as a list of names, for an order check: a section's
   title, a label's text, or the kind of block. */
const outline = (page) => page.evaluate(() => [...document.querySelector('.m-deck').children].map((k) => {
  if (k.classList.contains('sechd')) return `head:${k.querySelector('.sechd-name')?.textContent}`;
  if (k.classList.contains('absence')) return 'absence';
  if (k.classList.contains('pf-inline')) return 'foot';
  if (k.classList.contains('m-lede')) return 'statement';
  if (k.classList.contains('m-stats')) return k.dataset.band === 'glance' ? 'glance' : 'tiles';
  if (k.classList.contains('m-sec')) return `sec:${k.textContent}`;
  if (k.classList.contains('m-card')) return `card:${k.querySelector(':scope > h2')?.textContent || ''}`;
  return k.className.split(' ')[0] || k.tagName.toLowerCase();
}));
const { money: moneyOf } = await import('../api/public/ui.js');

console.log('\n4.2 · Money: 00 at a glance, the day line, how fares settle, by channel with swatches, †');
{
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('money');
  const o = await outline(p.page);
  const want = ['head:At a glance', 'statement', 'glance', 'card:Trip value a day', 'card:How fares settle',
    'sec:By channel', 'm-rows', 'absence', 'foot'];
  check('00 (statement, tiles) above the day line, then the sections, †, the footer',
    JSON.stringify(o.filter((x) => want.includes(x))) === JSON.stringify(want), o.join(' → '));
  const m = await p.page.evaluate(() => {
    const hero = document.querySelector('.m-stats[data-band="glance"] .m-stat.hero');
    const chan = [...document.querySelectorAll('.m-deck > .m-rows')].pop();
    const band = document.querySelector('.absence');
    return {
      hero: hero && { label: hero.querySelector('.l').textContent, value: hero.querySelector('.n').textContent,
        hl: !!hero.querySelector('.hl') },
      chans: [...chan.querySelectorAll('.m-row')].map((r) => ({ name: r.querySelector('.k b').textContent,
        sw: r.querySelector('.k b .sw')?.className || null, ink: getComputedStyle(r.querySelector('.k b')).color })),
      cells: [...(band?.querySelectorAll('.absb-cell') || [])].map((c) => ({ label: c.querySelector('.absb-lab').textContent,
        fig: c.querySelector('.absb-fig').textContent, why: c.querySelector('.absb-why')?.textContent })),
    };
  });
  check(`the hero is Trip value, ${moneyOf(KP.revenue)} as /api/kpis answered, highlighted`,
    m.hero && m.hero.label === 'Trip value' && m.hero.value === moneyOf(KP.revenue) && m.hero.hl, JSON.stringify(m.hero));
  const KEY = { Uber: 'uber', Bolt: 'bolt', Yango: 'yango', Hotel: 'hotel', 'FMS telematics': 'fms', Cabman: 'cabman' };
  check('each channel carries its own swatch beside its name, and the name stays ink',
    m.chans.length > 0 && m.chans.every((c) => c.sw === `sw ch-${KEY[c.name]}` && c.ink === 'rgb(10, 10, 11)'),
    JSON.stringify(m.chans));
  const daily = ans('/api/trips/daily?period=month&grain=auto');
  const pricedSum = (daily || []).reduce((a, d) => a + (Number(d.priced_trips) || 0), 0);
  const np = m.cells.find((c) => c.label === 'Bookings not yet priced');
  check(`† the bookings Trip value is not over: ${f0(KP.trips - pricedSum)} (trips − the priced days’ sum this screen captions)`,
    np?.fig === f0(KP.trips - pricedSum) && (np?.why || '').startsWith(`${f0(pricedSum)} of ${f0(KP.trips)} bookings carry a price`),
    JSON.stringify(np));
  const mi = m.cells.find((c) => c.label === 'Money in, day by day');
  check('† Money in has no day-by-day series, said as "No series" with the desktop’s reason',
    mi?.fig === 'No series' && (KP.accounted_statements
      ? (mi.why || '').startsWith(`${moneyOf(KP.accounted_statements)} of the ${moneyOf(KP.accounted)} is payout statements`)
      : /^Money in has no day-by-day series/.test(mi?.why || '')), JSON.stringify(mi));
  for (const s of ['files a week at a time, so Money in has no day-by-day figure. Trip value is the daily money line: ',
    'what riders paid, booking by booking.']) {
    check(`…the same words as the desktop: "${s.slice(0, 40)}…"`, read('app.js').includes(s) && read('m/screens.js').includes(s));
  }
  await p.close();
  /* The recording holds no booking without a settlement route, so the one
     cell that depends on one is asked of a copy of it that does. */
  const key = '/api/settlement/mix?period=month&grain=auto';
  const mix = { ...ans(key), unlabelled_trips: 12, unlabelled_platforms: ['yango'] };
  const fx = { ...fixture, answers: { ...fixture.answers, [key]: { ...fixture.answers[key], body: JSON.stringify(mix) } } };
  const q2 = await phonePage(browser, { skin: 'arkiv', fixture: fx });
  await q2.open('money');
  const nr = await q2.page.evaluate(() => [...document.querySelectorAll('.absence .absb-cell')]
    .map((c) => `${c.querySelector('.absb-lab').textContent}|${c.querySelector('.absb-fig').textContent}|${c.querySelector('.absb-why')?.textContent}`)
    .find((s) => s.startsWith('Bookings with no settlement route')));
  check('† and the bookings no settlement route describes, when there are any, with the screen’s own reason',
    nr === 'Bookings with no settlement route|12|They record no route at all (yango), so How fares settle can say nothing about them.',
    String(nr));
  await q2.close();
}

/* A copy of the recording with one answer replaced — for the states the
   recording does not hold (an empty list, a missing figure). */
const withAnswer = (key, body) => ({ ...fixture,
  answers: { ...fixture.answers, [key]: { status: 200, type: 'application/json', body: JSON.stringify(body) } } });

console.log('\n4.3 · People: the list under its own section head, and an empty window pointed at the bar');
{
  const lb = ans('/api/drivers/leaderboard?period=month&grain=auto');
  const total = lb.total ?? lb.people ?? (lb.rows || lb).length;
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('people');
  const o = await outline(p.page);
  const h = await p.page.evaluate(() => document.querySelector('.m-deck > .sechd')?.innerText.replace(/\s+/g, ' '));
  check('the search and the sort, then the list under its own numbered head',
    o[0] === 'div' && o[1] === 'head:People who drove' && o[2] === 'div', o.join(' → '));
  check(`…which names how many people the window holds (${f0(total)}, the leaderboard’s own count)`,
    new RegExp(`^People who drove ${f0(total)} people · This month$`, 'i').test(h || ''), h);
  await p.close();
  const e = await phonePage(browser, { skin: 'arkiv', fixture: withAnswer('/api/drivers/leaderboard?period=month&grain=auto', { rows: [] }) });
  await e.open('people');
  const why = await e.page.evaluate(() => document.querySelector('.m-empty')?.textContent);
  check('an empty window says to widen it from the bar above — the redesign has no ⋮ menu',
    why === 'Nobody drove in this windowWiden the window from the bar above.', why);
  await e.close();
  const c = await phonePage(browser, { skin: 'classic', fixture: withAnswer('/api/drivers/leaderboard?period=month&grain=auto', { rows: [] }) });
  await c.open('people');
  check('…while the old phone still points at its ⋮', await c.page.evaluate(() => document.querySelector('.m-empty')?.textContent)
    === 'Nobody drove in this windowWiden the window from the ⋮ menu.');
  await c.close();
}

console.log('\n4.4 · Fleet: the list under its own head, the live state on every row');
{
  const vs = ans('/api/vehicles?period=month&grain=auto');
  const total = vs.total ?? vs.totals?.vehicles ?? (vs.rows || vs).length;
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('fleet');
  const o = await outline(p.page);
  const h = await p.page.evaluate(() => document.querySelector('.m-deck > .sechd')?.innerText.replace(/\s+/g, ' '));
  check('the search and the sort, then the list under its own numbered head',
    o[0] === 'div' && o[1] === 'head:Vehicles that worked' && o[2] === 'div', o.join(' → '));
  check(`…naming the window’s vehicles (${f0(total)}, /api/vehicles’ own count)`,
    new RegExp(`^Vehicles that worked ${f0(total)} vehicles · This month$`, 'i').test(h || ''), h);
  const subs = await p.page.evaluate(() => [...document.querySelectorAll('.m-deck .m-row .k span')].map((s) => s.textContent));
  check('every row still says where the car is now (moving, stopped, stale fix, not reporting)',
    subs.length > 0 && subs.every((s) => /^(moving \d+ km\/h|stopped|stale fix|not reporting)/.test(s)), subs.slice(0, 4).join(' | '));
  await p.close();
}

console.log('\n4.5 · More: numbered sections, the masthead on This app, and a footer that agrees with the bar');
{
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('more');
  const o = await outline(p.page);
  const m = await p.page.evaluate(() => {
    const app = [...document.querySelectorAll('.m-card')].find((c) => c.querySelector(':scope > h2')?.textContent === 'This app');
    const b = app?.querySelector('button');
    return {
      word: app?.querySelector('.ak-mast-word')?.textContent,
      face: app?.querySelector('.ak-mast-word') ? getComputedStyle(app.querySelector('.ak-mast-word')).fontFamily : '',
      org: app?.querySelector('.ak-mast-org')?.textContent,
      btn: b && { cls: b.className, h: b.getBoundingClientRect().height, w: b.getBoundingClientRect().width, text: b.textContent },
      colophon: [...document.querySelectorAll('.pf-inline .pf-colophon span')].map((s) => s.textContent),
      bar: document.querySelector('.ak-ctl .ak-ctl-p')?.textContent,
    };
  });
  check('Analyse, Operate, On the desktop and This app, as numbered sections',
    JSON.stringify(o.filter((x) => /^(sec|card):/.test(x))) === JSON.stringify(['sec:Analyse', 'sec:Operate', 'sec:On the desktop', 'card:This app']),
    o.join(' → '));
  check('This app carries the masthead: the wordmark in Fraunces and whose fleet it is',
    m.word === 'Fleet' && /Fraunces/.test(m.face) && m.org === 'Ecosine & Egari · Dubai', JSON.stringify(m));
  check('…and the way to the desktop is a full-width button, not a chip',
    m.btn && m.btn.cls === 'm-btn' && m.btn.h >= 44 && m.btn.w > 300 && m.btn.text === 'Open the desktop version', JSON.stringify(m.btn));
  check('the footer’s colophon agrees with the bar: no window applies here',
    m.bar === 'No window applies here' && m.colophon[0] === 'No window applies here · Dubai time', JSON.stringify(m));
  await p.close();
}

console.log('\n4.6 · Live: 00 with the feed’s own clock, and each car marked with the feed that saw it');
{
  const feed = ans('/api/live');
  const { timeStr } = await import('../api/public/ui.js');
  const newest = feed.map((v) => v.polled_at).filter(Boolean).sort().pop();
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('live');
  const o = (await outline(p.page)).filter((x) => x !== 'ak-applies');
  const m = await p.page.evaluate(() => ({
    note: document.querySelector('.sechd .sechd-note')?.textContent,
    hero: document.querySelector('.m-stat.hero .l')?.textContent + '|' + document.querySelector('.m-stat.hero .n')?.textContent,
    stale: (() => { const t = [...document.querySelectorAll('.m-stat')].find((s) => s.querySelector('.l').textContent === 'Stale fix');
      return t ? `${t.className}|${getComputedStyle(t.querySelector('.l'), '::before').borderTopStyle}` : null; })(),
    marks: [...document.querySelectorAll('.m-deck > .m-rows .m-row')].map((r) => ({ ch: r.dataset.ch || null,
      src: r.querySelector('.k span').textContent.split(' · ')[0], mark: getComputedStyle(r).boxShadow,
      ink: getComputedStyle(r.querySelector('.k b')).color })),
  }));
  check('00 · At a glance leads, then Every vehicle', o[0] === 'head:At a glance' && o[1] === 'glance' && o[2] === 'sec:Every vehicle',
    o.join(' → '));
  check(`…headed by the feed’s own clock: the newest fix, ${timeStr(newest)} Dubai`,
    m.note === `newest fix ${timeStr(newest)} Dubai`, m.note);
  check(`the hero is the cars reporting, ${feed.length} as /api/live answered`, m.hero === `Reporting|${f0(feed.length)}`, m.hero);
  const staleN = feed.filter((v) => v.stale).length;
  check('Stale fix keeps its tone as a dot: a hollow warning when there is one, green when none',
    staleN ? /warn/.test(m.stale) && /solid$/.test(m.stale) : /good/.test(m.stale), `${staleN} ${m.stale}`);
  check('each car carries the mark of the feed that saw it (its sub-line still names it), its plate in ink',
    m.marks.length === feed.length && m.marks.every((r) => r.ch === r.src && /3px 0px 0px 0px/.test(r.mark) && r.ink === 'rgb(10, 10, 11)'),
    JSON.stringify(m.marks.slice(0, 3)));
  const named = await p.page.evaluate(() => import('/m/ui.js').then(({ rowMark }) => [
    rowMark(document.createElement('div'), 'Uber').dataset.ch || null,
    rowMark(document.createElement('div'), 'FMS telematics').dataset.ch || null,
    rowMark(document.createElement('div'), 'no-such-feed').dataset.ch || null,
    rowMark(document.createElement('div'), null).dataset.ch || null]));
  check('a mark is the channel’s by NAME; a feed that is not one of the six is marked by nothing (L1)',
    JSON.stringify(named) === JSON.stringify(['uber', 'fms', null, null]), JSON.stringify(named));
  await p.close();
}

console.log('\n4.7 · Safety: the statement as 00, ink bars by kind, and a failed fetch that is not a zero');
{
  const sum = ans('/api/alerts/summary?period=month&grain=auto');
  const total = sum.reduce((a, r) => a + (Number(r.n) || 0), 0);
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('safety');
  const o = await outline(p.page);
  const claim = await p.page.evaluate(() => document.querySelector('.m-lede b')?.textContent);
  check('00 heads the statement, then By kind, then By vehicle',
    JSON.stringify(o.slice(0, 5)) === JSON.stringify(['head:At a glance', 'statement', 'card:By kind', 'sec:By vehicle', 'm-rows']),
    o.join(' → '));
  check(`…whose figure is the events /api/alerts/summary sums to (${f0(total)})`, claim === `${f0(total)} harsh-driving events`, claim);
  await p.close();
  /* The summary refused: the old phone said there were no events. */
  const bad = { ...fixture, answers: { ...fixture.answers } };
  delete bad.answers['/api/alerts/summary?period=month&grain=auto'];
  const f = await phonePage(browser, { skin: 'arkiv', fixture: bad });
  await f.open('safety');
  const said = await f.page.evaluate(() => document.querySelector('.m-deck')?.textContent);
  check('a summary that did not load says so — never "No harsh-driving event in this window"',
    /Could not load this/.test(said) && !/No harsh-driving event/.test(said), said.slice(0, 120));
  await f.close();
}

console.log('\n4.8 · Unauthorized: 00, the coverage note under the claim it qualifies, provider marks, a cut that says so');
{
  const key = '/api/unauthorized/list?period=month&grain=auto';
  const list = ans(key);
  const rowsIn = list.rows || list;
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('unauthorized');
  const o = await outline(p.page);
  const m = await p.page.evaluate(() => ({
    hero: !!document.querySelector('.m-stat.hero'),
    marks: [...document.querySelectorAll('.m-deck > .m-rows .m-row')].map((r) => `${r.dataset.ch || '-'}|${r.querySelector('.k span').textContent.split(' · ').pop()}`),
    lede: document.querySelector('.m-lede b')?.textContent,
  }));
  check('00 heads the statement, and the coverage note sits directly under the claim it qualifies',
    o[0] === 'head:At a glance' && o[1] === 'statement' && o[2] === 'm-stale' && o[3] === 'tiles', o.join(' → '));
  check('the verdict tiles carry no hero: the statement’s figure is the headline (ruling 7)', !m.hero);
  const src = { cabman: 'CABMAN DT' };
  check('each row is marked with its provider — CABMAN, or FMS for both of FMS’s counts — and still names it',
    m.marks.length === Math.min(40, rowsIn.length)
      && m.marks.every((x) => { const [ch, label] = x.split('|'); return (/CABMAN/i.test(label) ? ch === 'cabman' : /FMS/i.test(label) ? ch === 'fms' : ch === '-'); }),
    m.marks.slice(0, 4).join(' '));
  check('a list of forty says nothing about being cut (it is not)',
    await p.page.evaluate(() => !/most recent of/.test(document.querySelector('.m-deck').textContent)));
  await p.close();
  const more = Array.from({ length: 55 }, (_, i) => ({ ...rowsIn[i % rowsIn.length] }));
  const q2 = await phonePage(browser, { skin: 'arkiv', fixture: withAnswer(key, more) });
  await q2.open('unauthorized');
  const cutLine = await q2.page.evaluate(() => [...document.querySelectorAll('.m-deck > .m-cap')].map((x) => x.textContent).find((t) => /most recent/.test(t)));
  check('fifty-five rows drawn as forty say which forty, of how many', cutLine === 'The 40 most recent of 55 rows the list returns.', String(cutLine));
  await q2.close();
}

console.log('\n4.9 · Sources: 00, every collector numbered and marked, and every error whole');
{
  const key = '/api/status';
  const st = ans(key);
  const long = 'upstream said 401: the session cookie was refused by the fleet portal after it rotated; '
    + 'paste a new one on Settings → credentials and the next run collects the missed days';
  /* One collector given an error longer than the old row's seventy characters. */
  const withErr = st.map((r, i) => (i === 0 ? { ...r, status: 'error', error: long } : r));
  const p = await phonePage(browser, { skin: 'arkiv', fixture: withAnswer(key, withErr) });
  await p.open('sources');
  const o = (await outline(p.page)).filter((x) => x !== 'ak-applies');
  const m = await p.page.evaluate(() => [...document.querySelectorAll('.m-deck > .m-rows .m-row')].map((r) => ({
    t: r.querySelector('.k b').textContent, sub: r.querySelector('.k span').textContent, ch: r.dataset.ch || null,
    wrap: r.classList.contains('wrapsub'), h: r.querySelector('.k span').scrollWidth <= r.querySelector('.k span').clientWidth + 1 })));
  check('00 heads the statement, then Every collector as a numbered section',
    JSON.stringify(o.slice(0, 4)) === JSON.stringify(['head:At a glance', 'statement', 'head:Every collector', 'm-rows']), o.join(' → '));
  const e = m.find((x) => x.sub.startsWith('upstream said 401'));
  check('an error is printed whole, and wraps rather than being cut', e && e.sub === long && e.wrap && e.h, JSON.stringify(e));
  const { channelKey } = await import('../api/public/tokens.js');
  check('a collector that feeds one of the six channels is marked with it (uber_fleet is Uber); any other by nothing',
    m.length > 3 && m.every((x) => x.ch === channelKey(x.t.split(' · ')[0]))
      && m.some((x) => x.ch === null),
    m.map((x) => `${x.t}:${x.ch}`).join(' '));
  await p.close();
  const c = await phonePage(browser, { skin: 'classic', fixture: withAnswer(key, withErr) });
  await c.open('sources');
  check('…while the old phone keeps its seventy characters', await c.page.evaluate((l) => [...document.querySelectorAll('.m-row .k span')]
    .some((s) => s.textContent === l.slice(0, 70)), long));
  await c.close();
}

console.log('\n4.10 · Corporate: what the channel kept, the cost it filed, reasons in place of dashes');
{
  const key = '/api/corporate/summary?period=month&grain=auto';
  const s = ans(key);
  const tiles = (pg) => pg.page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.m-stat')]
    .map((t) => [t.querySelector('.l').textContent, { v: t.querySelector('.n').textContent,
      s: t.querySelector('.s')?.textContent || null, hero: t.classList.contains('hero'),
      na: t.querySelector('.n').hasAttribute('data-absent') }])));
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('corporate');
  const o = await outline(p.page);
  const t = await tiles(p);
  check('00 heads the statement, then the tiles, then By property',
    JSON.stringify(o.slice(0, 4)) === JSON.stringify(['head:At a glance', 'statement', 'glance', 'sec:By property']), o.join(' → '));
  const margin = Math.round(((s.revenue - s.cost) / s.revenue) * 100);
  check(`the hero is what the channel kept: ${moneyOf(s.revenue - s.cost)}, its fares less its cost, ${margin}%`,
    t['Kept on the channel']?.v === moneyOf(s.revenue - s.cost) && t['Kept on the channel'].hero
      && t['Kept on the channel'].s === `${margin}% of the fares, after what the drivers were paid`, JSON.stringify(t['Kept on the channel']));
  check(`…beside the cost the channel filed, ${moneyOf(s.cost)}`, t['Cost filed']?.v === moneyOf(s.cost), JSON.stringify(t['Cost filed']));
  await p.close();
  /* A channel that files no cost, and a window with no priced distance or
     measured approach: every tile says why, none prints a bare dash. */
  const noCost = { ...s, has_cost: false, cost: null, revenue_per_km: null, deadhead_km: null, deadhead_ratio_pct: null };
  const q2 = await phonePage(browser, { skin: 'arkiv', fixture: withAnswer(key, noCost) });
  await q2.open('corporate');
  const u = await tiles(q2);
  check('no cost filed: Kept is absent WITH the statement’s reason, and is not highlighted',
    u['Kept on the channel']?.v === 'The channel reports a fare but no cost, so no margin can be taken from it.'
      && u['Kept on the channel'].na && !(await q2.page.evaluate(() => !!document.querySelector('.m-stat.hero .hl'))),
    JSON.stringify(u['Kept on the channel']));
  check('…Per km and Unpaid approach say why they have no figure',
    u['Per km']?.v === 'no priced booking in this window carries a distance'
      && u['Unpaid approach']?.v === 'no booking in this window has its approach measured', JSON.stringify([u['Per km'], u['Unpaid approach']]));
  await q2.close();
  const gone = { ...fixture, answers: { ...fixture.answers } };
  delete gone.answers[key];
  const q3 = await phonePage(browser, { skin: 'arkiv', fixture: gone });
  await q3.open('corporate');
  const said = await q3.page.evaluate(() => document.querySelector('.m-deck').textContent);
  check('a summary that did not load says so — never "No hotel booking in this window"',
    /Could not load this/.test(said) && !/No hotel booking/.test(said), said.slice(0, 100));
  await q3.close();
}

console.log('\n4.11 · Analyst: 00, the verdicts as tiles with no hero, and findings whose verdict wears no semantic hue');
{
  const d = ans('/api/analyst/findings?period=month&grain=auto');
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('analyst');
  const o = await outline(p.page);
  const m = await p.page.evaluate(() => ({
    hero: !!document.querySelector('.m-stat.hero'),
    tags: [...document.querySelectorAll('.m-finding .ak-verdict')].map((t) => ({ w: t.textContent,
      c: getComputedStyle(t).color, inline: t.getAttribute('style') })),
    claims: [...document.querySelectorAll('.m-finding .ak-claim')].map((b) => b.textContent),
  }));
  check('00 heads the statement, then the tiles, then What it found',
    JSON.stringify(o.slice(0, 4)) === JSON.stringify(['head:At a glance', 'statement', 'tiles', 'sec:What it found']), o.join(' → '));
  check('the verdict tiles carry no hero: the statement’s figure is the headline (ruling 7)', !m.hero);
  const found = (d.findings || []).slice(0, 12);
  check(`every finding keeps its claim and its verdict word (${found.length})`,
    m.claims.length === found.length && found.every((f, i) => m.claims[i] === (f.claim || '') && m.tags[i].w === (f.verdict || '')),
    JSON.stringify(m.tags.slice(0, 3)));
  check('…and no verdict is painted green or red (a refuted claim is an answer, not bad news)',
    m.tags.every((t) => t.c === 'rgb(10, 10, 11)' && !t.inline), JSON.stringify(m.tags.slice(0, 3)));
  await p.close();
}

console.log('\n9 · every screen: nothing dropped, nothing sideways, nothing too small to hit');
{
  const { wordsOf, SCREENS, DESKTOP_TABS } = await import('./phone_harness.mjs');
  /* The house rule for the redesign, as a check: every string the old screen
     printed from these answers is printed by the new one. A figure, a reason,
     a caption, a row. The em dash is the one thing the redesign may drop: a
     tile with no figure prints its reason in the value slot instead of a dash
     over the reason (m/ui.js stat()), and the reason is checked like any other
     word. */
  const DROPPABLE = new Set(['—']);
  /* Screens whose own markup still sets a control's size inline, which the
     sheet cannot outrank without !important — each converts in its own
     commit and comes off this list there. */
  const SMALL_UNTIL_CONVERTED = new Set(['credentials']);
  const old = {};
  {
    const c = await phonePage(browser, { skin: 'classic', fixture });
    for (const s of SCREENS) {
      await c.open(s.route);
      if (s.tap) { await c.page.click(s.tap); await c.settle(); }
      old[s.as || s.route] = await wordsOf(c.page);
    }
    await c.close();
  }
  for (const width of [390, 360]) {
    const a = await phonePage(browser, { skin: 'arkiv', fixture, width, height: width === 360 ? 780 : 844 });
    const dropped = [], sideways = [], small = [];
    for (const s of SCREENS) {
      await a.open(s.route);
      const tap = s.tapArkiv || s.tap;
      if (tap) { await a.page.click(tap); await a.settle(); }
      const name = s.as || s.route;
      const text = (await a.page.evaluate(() => document.querySelector('#m .m-deck')?.textContent || ''))
        .replace(/\s+/g, ' ');
      if (width === 390) {
        /* Compared with the spaces taken out and a closing full stop dropped:
           a sentence that became a figure and its label ("Latest booking
           04:59." → LATEST BOOKING / 04:59, the desktop livebar's own cell)
           has kept every word and every digit, in order. */
        const squash = (s) => s.replace(/\s+/g, '').replace(/\.$/, '');
        const flat = squash(text);
        const lost = old[name].filter((w) => !DROPPABLE.has(w) && !flat.includes(squash(w)));
        if (lost.length) dropped.push(`${name}: ${lost.slice(0, 3).map((w) => JSON.stringify(w.slice(0, 60))).join(', ')}`);
      }
      const mm = await a.page.evaluate(() => ({
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        small: [...document.querySelectorAll('#m a[href], #m button, #m input:not([type=hidden]), #m select, #m textarea')]
          .filter((e) => !e.closest('.m-fallback'))
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
          .map((e) => `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ')[0]}:${Math.round(e.getBoundingClientRect().height)}`),
      }));
      if (mm.over > 0) sideways.push(`${name} +${mm.over}px`);
      if (mm.small.length && !SMALL_UNTIL_CONVERTED.has(name)) small.push(`${name}: ${[...new Set(mm.small)].slice(0, 3).join(' ')}`);
    }
    for (const route of DESKTOP_TABS) {
      await a.open(route);
      const over = await a.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 0) sideways.push(`${route} +${over}px`);
    }
    if (width === 390) {
      check(`every word the old screens printed is on the new ones (${SCREENS.length} screens)`, !dropped.length,
        dropped.join(' | '));
    }
    check(`nothing pushes the page sideways at ${width}px (the desktop tabs in the fallback included)`,
      !sideways.length, sideways.join(' | '));
    check(`every control a thumb uses is at least 44px tall at ${width}px`, !small.length, small.join(' | '));
    if (width === 390) {
      check('every API call was answered from the recording', !a.misses.size, [...a.misses].join(' '));
      check('no screen threw', !a.errors.length, a.errors.slice(0, 3).join(' | '));
    }
    await a.close();
  }
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
