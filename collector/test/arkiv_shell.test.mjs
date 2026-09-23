/* The Arkiv shell — STEP 4 of the reskin.
   ═══════════════════════════════════════════════════════════════════════════
   docs/UI-REDESIGN-PLAN.md §3 "Shell: rail, header, control bar, credential
   banner, freshness". Under ?skin=arkiv the rail, the sticky topbar and the
   band become a sheet: masthead (with the window) → section row (with Set up
   and freshness) → view row → credential banner → the sticky control bar
   (with a sentence naming what does not apply here) → the livebar → the
   title block → #view → the footer. What this file holds down, and why:

   0. WHICH SHELL IS A TOKEN — --pg-shell, 0 in app.css and 1 in arkiv.css —
      and the old skin's shell is exactly index.html's: no masthead, no moved
      node, the rail's three-line freshness, the old banner and band markup.
   1. The sentence: every page on NO_FILTER / NO_RANGE / NO_PLATFORM_FLEET
      has one that names EXACTLY the controls it hides; a reason exists for
      every page but the three that take the shared one, and no reason names
      a page that is on no list (a stale sentence would give a reason that is
      not the true one).
   2. The masthead window says only what the client can vouch for: two Dubai
      days under a rolling window, the name alone for a calendar period, and
      "no window" on a page that takes none.
   3. In a browser, under the skin: the order; every id once, #fRangeLabel
      included; the moved controls still drive the page (platform, zen,
      theme, the range panel); the control bar sticks; the title block is
      the head of the page; Set up is lit on #settings.
   4. The banner as a grid — who with the channel swatch, the key with the
      SURFACE under it, what, when — and "as of" the latest checked_at of the
      rows shown, not the page clock; the pending tone still never red.
   5. The livebar: the scope caption on the face of it, the notes that lived
      only in host.title in a <details> that starts closed, trip value's
      emphasis; and freshness on one line.
   6. Zen hides the masthead, both rows, the strip and the sub-line, and keeps
      the banner and the control bar.
   7. 390px: no sideways scroll, and Today first in the section row.
   8. arkiv.css held back 1.5s: the first render still builds the new shell
      AND the page contract (shell.js whenStyled — the module can run before
      a parser-inserted stylesheet has loaded).

   Synthetic data only: the browser half renders against mockapi.mjs, and
   /api/auth is answered by the test with made-up rows. */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const S = await import('../api/public/shell.js');
const D = await import('../api/public/data.js');

/* ══ 0. the token ═════════════════════════════════════════════════════════ */
console.log('\n0 · which shell is a token');
const app = strip(read('app.css')), ark = strip(read('arkiv.css')), shell = strip(read('shell.js'));
check('app.css declares --pg-shell:0 on the old skin’s :root', /:root\{[^}]*--pg-shell:0;/.test(app));
check('arkiv.css declares --pg-shell:1 under the skin', /:root\[data-skin="arkiv"\]\{[^}]*--pg-shell:1/.test(ark));
check('shell.js asks the token, through getComputedStyle', /getPropertyValue\('--pg-shell'\)/.test(shell));
check('…and never the attribute', !/dataset\.skin|data-skin|fleet\.skin/.test(shell));
check('the new layout rules name #app.ak-shell, which only buildShell() stamps',
  /\.ak-shell \.side\{display:none\}/.test(ark) && /classList\.add\('ak-shell'\)/.test(shell));
check('…and #app is not shown under the skin until it has', /#app:not\(\.ak-shell\)\{visibility:hidden\}/.test(ark));

/* ══ 1. the sentence ══════════════════════════════════════════════════════ */
console.log('\n1 · which controls do not apply, and why');
const listed = [...new Set([...D.NO_FILTER, ...D.NO_RANGE, ...D.NO_PLATFORM_FLEET])];
const why = Object.keys(S.APPLIES_WHY);
check('no reason is written for a page that is on no list', why.every((v) => listed.includes(v)),
  why.filter((v) => !listed.includes(v)).join(' '));
const shared = listed.filter((v) => !why.includes(v)).sort();
check('every listed page has its own reason except the three that take the shared one',
  JSON.stringify(shared) === JSON.stringify(['compliance', 'insights', 'retention']), shared.join(' '));
const wrong = [];
for (const v of listed) {
  const s = S.appliesSentence(v);
  const lead = s.split(' — ')[0];
  const range = D.hidesRange(v), chan = D.hidesChannel(v);
  if (/date range/.test(lead) !== range || /grouping/.test(lead) !== range
    || /platform/i.test(lead) !== chan || /fleet/i.test(lead) !== chan
    || !/ do not apply here — .+\.$/.test(s)) wrong.push(`${v}: ${s}`);
}
check(`each of the ${listed.length} sentences names exactly the controls its page hides`, wrong.length === 0,
  wrong.slice(0, 3).join(' | '));
check('a page that hides nothing says nothing', S.appliesSentence('overview') === '' && S.appliesSentence('unit') === '');
check('the sentence reads as a sentence',
  S.appliesSentence('payouts') === 'The date range and grouping do not apply here — it is the register of every '
    + 'transfer that ever reached the bank.'
  && S.appliesSentence('driver') === 'Platform and fleet do not apply here — it answers for this person on every channel.'
  && /^The date range, grouping, platform and fleet do not apply here — none of them changes what it shows\.$/
    .test(S.appliesSentence('insights')), S.appliesSentence('payouts'));
check('an address that names no page says so', /names no page/.test(S.appliesSentence('notfound')));

/* ══ 2. the window ════════════════════════════════════════════════════════ */
console.log('\n2 · the masthead names the window it can vouch for');
check('two Dubai days, compact where they share a month or a year',
  S.spanLabel('2026-09-01', '2026-09-23') === '1 – 23 Sep 2026'
  && S.spanLabel('2026-08-25', '2026-09-23') === '25 Aug – 23 Sep 2026'
  && S.spanLabel('2025-12-28', '2026-01-03') === '28 Dec 2025 – 3 Jan 2026'
  && S.spanLabel('2026-09-23', '2026-09-23') === '23 Sep 2026');
Object.assign(D.state, { view: 'overview', period: '', from: '', to: '', days: 30 });
const rolling = S.windowWords();
const [f0, t0] = D.windowDates();
check('a rolling window prints the two days it was computed over',
  rolling.main === 'Last 30 days' && rolling.sub === S.spanLabel(f0, t0) && rolling.sub.length > 0, JSON.stringify(rolling));
Object.assign(D.state, { period: 'month' });
check('a calendar period prints its name and NO dates (the server resolves them)',
  S.windowWords().main === 'This month' && S.windowWords().sub === '', JSON.stringify(S.windowWords()));
Object.assign(D.state, { period: '', from: '2026-08-03', to: '2026-08-19' });
check('two dates off the calendar are the label', S.windowWords().main === '3 Aug 2026 – 19 Aug 2026'
  && S.windowWords().sub === '', JSON.stringify(S.windowWords()));
check('a page that takes no window says so', S.windowWords('settings').main === 'No window applies here'
  && S.windowWords('payouts').main === 'No window applies here' && S.windowWords('notfound').main === 'No window applies here');

/* ══ the browser half ═════════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const fresh = (o = {}) => browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block',
  timezoneId: 'Asia/Dubai', ...o });
const settle = async (page) => {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(300);
};
const SHELL_IDS = ['nav', 'sectabs', 'authBanner', 'filters', 'fRange', 'fRangeLabel', 'fGrain', 'fPlatform',
  'fFleet', 'refreshBtn', 'zenBtn', 'tzNote', 'themeBtn', 'settingsLink', 'freshness', 'todayNow', 'crumb',
  'viewTitle', 'viewSub', 'view', 'tt', 'm', 'pageFoot'];
const SYNTH = (o) => ({ fleet_id: 'egari', surface: 'synthetic surface', last_ok_at: null,
  checked_at: '2026-09-23T08:30:00Z', last_ok_age_h: 3, run_age_h: 9, stall_limit_h: 6, still_collecting: true,
  saved_at: null, superseded: false, ...o });
const authBody = (rows) => JSON.stringify({ rows, observed: true,
  stopped: rows.filter((r) => r.severity === 'stopped').length, at_risk: 0, degraded: 0,
  pending: rows.filter((r) => r.severity === 'pending').length });
const ROWS = [
  SYNTH({ provider: 'uber', credential: 'SYNTH_COOKIE', state: 'invalid', severity: 'stopped',
    detail: 'refused — a synthetic reason', checked_at: '2026-09-23T07:10:00Z' }),
  SYNTH({ provider: 'bolt', fleet_id: 'ecosine', credential: 'SYNTH_TOKEN', state: 'invalid', severity: 'stopped',
    surface: 'synthetic roster', detail: 'refused — another synthetic reason', checked_at: '2026-09-23T08:30:00Z' }),
];

console.log('\n0 · the old skin keeps index.html’s shell, untouched');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: authBody(ROWS) }));
  await page.goto(`${base}/?ui=desktop&skin=classic#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#authBanner.stopped', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#todayNow:not([hidden])', { timeout: 15000 }).catch(() => {});
  await settle(page);
  const o = await page.evaluate(() => ({
    mast: !!document.querySelector('#mast, .mast, #secRow, #fApplies'),
    cls: document.querySelector('#app').className,
    nav: document.querySelector('#nav').parentElement.className,
    filters: document.querySelector('#filters').parentElement.className,
    theme: document.querySelector('#themeBtn').parentElement.className,
    setup: document.querySelector('#settingsLink').textContent,
    fresh: document.querySelector('#freshness').innerHTML,
    li: document.querySelector('#authBanner li')?.innerHTML || '',
    band: document.querySelector('#todayNow').innerHTML,
    order: [...document.querySelector('.main').children].map((n) => n.id || n.className),
  }));
  check('no masthead, no section row, no sentence, no class on #app', !o.mast && o.cls === '', JSON.stringify(o.cls));
  check('#nav in the rail, #filters in the topbar, #themeBtn in the rail’s foot',
    o.nav === 'side' && o.filters === 'topbar' && o.theme === 'side-foot', `${o.nav} ${o.filters} ${o.theme}`);
  check('…and the main column in index.html’s order',
    o.order.join(' ') === 'authBanner topbar sectabs todayNow view pageFoot',
    o.order.join(' '));
  check('settings is still "⚙ settings"', /⚙ settings/.test(o.setup), o.setup);
  check('freshness is still three lines', (o.fresh.match(/<br>/g) || []).length === 2 && !/fr-sep/.test(o.fresh), o.fresh);
  check('the banner row is still one line of prose', /^<strong>/.test(o.li) && / — /.test(o.li) && !/ab-who|ab-meta/.test(o.li),
    o.li.slice(0, 80));
  check('the band is still one run', !/lb-top|lb-figs|lb-notes|lb-scope/.test(o.band) && /tn-now/.test(o.band), o.band.slice(0, 80));
  await ctx.close();
}

/* ══ 3. the shell, in a browser ═══════════════════════════════════════════ */
console.log('\n3 · the sheet, under the skin');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: authBody(ROWS) }));
  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#app.ak-shell', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#authBanner.stopped', { timeout: 15000 }).catch(() => {});
  await settle(page);
  const o = await page.evaluate((ids) => {
    const main = document.querySelector('.main');
    const pos = (s) => getComputedStyle(document.querySelector(s)).position;
    return {
      order: [...main.children].map((n) => n.id || n.className.split(' ')[0]),
      ids: ids.map((id) => [id, document.querySelectorAll(`#${id}`).length]).filter(([, n]) => n !== 1),
      secrow: [...document.querySelector('#secRow').querySelectorAll('#nav, #settingsLink, #freshness')].map((n) => n.id),
      setup: { text: document.querySelector('#settingsLink').textContent, href: document.querySelector('#settingsLink').getAttribute('href') },
      ctl: [...document.querySelector('#filters').children].map((n) => n.id || n.className),
      sticky: pos('#filters'), top: getComputedStyle(document.querySelector('#filters')).top,
      titleSticky: pos('.topbar'), tabsSticky: pos('#sectabs'),
      side: getComputedStyle(document.querySelector('.side')).display,
      vis: getComputedStyle(document.querySelector('#app')).visibility,
      word: getComputedStyle(document.querySelector('.mast-word')).fontFamily,
      win: document.querySelector('#mastWin').textContent,
      title: document.querySelector('#viewTitle').textContent,
      on: document.querySelector('#nav a.on .lb')?.textContent,
    };
  }, SHELL_IDS);
  check('the order: masthead, section row, view row, banner, controls, strip, title, page, footer',
    o.order.join(' ') === 'mast secRow sectabs authBanner filters todayNow topbar view pageFoot', o.order.join(' '));
  check('every shell id is in the document exactly once, #fRangeLabel and #pageFoot included', o.ids.length === 0,
    JSON.stringify(o.ids));
  check('the section row holds the sections, then Set up, then freshness',
    o.secrow.join(' ') === 'nav settingsLink freshness', o.secrow.join(' '));
  check('…Set up being the same link, relabelled', o.setup.text === 'Set up' && o.setup.href === '#settings',
    JSON.stringify(o.setup));
  check('the control bar holds the six controls, then the theme, the sentence and the clock note',
    o.ctl.join(' ') === 'fRange fGrain fPlatform fFleet refreshBtn zenBtn themeBtn fApplies tzNote', o.ctl.join(' '));
  check('…and it is the one thing that sticks', o.sticky === 'sticky' && o.top === '0px'
    && o.titleSticky === 'static' && o.tabsSticky === 'static', `${o.sticky} ${o.top} ${o.titleSticky} ${o.tabsSticky}`);
  check('the rail is gone and the sheet is shown', o.side === 'none' && o.vis === 'visible', `${o.side} ${o.vis}`);
  check('the wordmark is Fraunces, the one serif', /^"?Fraunces/.test(o.word), o.word);
  check('the window is named in the masthead', o.win === 'This month · Dubai time', o.win);
  check('the page is titled and its section lit', o.title === 'Fleet activity' && o.on === 'Today', `${o.title} ${o.on}`);

  /* The moved controls still drive the page: the listeners were bound to the
     nodes, and the nodes moved. */
  await page.selectOption('#fPlatform', 'uber');
  await page.waitForFunction(() => /platform=uber/.test(location.hash), null, { timeout: 5000 }).catch(() => {});
  check('the platform select, moved, still writes the address', /platform=uber/.test(await page.evaluate(() => location.hash)),
    await page.evaluate(() => location.hash));
  await settle(page);
  await page.click('#fRange');
  check('the range button, moved, still opens the calendar',
    await page.waitForSelector('.rangepanel', { timeout: 5000 }).then(() => true).catch(() => false));
  await page.keyboard.press('Escape');
  const t0 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  await page.click('#themeBtn');
  const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('the theme cycle, moved into the bar, still cycles system → light', t0 === null && t1 === 'light', `${t0} → ${t1}`);
  await page.click('#themeBtn'); await page.click('#themeBtn');
  check('…→ dark → system', await page.evaluate(() => document.documentElement.getAttribute('data-theme')) === null);
  check('no page error', errs.length === 0, errs.join(' | '));

  /* The sentence and the window on pages that hide controls. */
  const on = async (hash) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForFunction((h) => document.querySelector('#viewTitle')?.textContent && location.hash === h, `#${hash.replace(/^#/, '')}`,
      { timeout: 8000 }).catch(() => {});
    await settle(page);
    return page.evaluate(() => ({
      applies: document.querySelector('#fApplies').textContent, hidden: document.querySelector('#fApplies').hidden,
      win: document.querySelector('#mastWin').textContent, sub: document.querySelector('#mastWinSub').textContent,
      subHidden: document.querySelector('#mastWinSub').hidden,
      setupOn: document.querySelector('#settingsLink').classList.contains('on'),
      navOn: document.querySelector('#nav a.on .lb')?.textContent || null,
      grain: getComputedStyle(document.querySelector('#fGrain')).display,
      platform: getComputedStyle(document.querySelector('#fPlatform')).display,
    }));
  };
  const pay = await on('#payouts');
  check('#payouts: the range and grouping are gone and the sentence says why',
    pay.grain === 'none' && pay.platform !== 'none' && !pay.hidden
    && pay.applies === 'The date range and grouping do not apply here — it is the register of every transfer that '
      + 'ever reached the bank.', JSON.stringify(pay));
  check('…and the masthead does not name a window the page is not using', pay.win === 'No window applies here · Dubai time'
    && pay.subHidden, JSON.stringify(pay));
  const set = await on('#settings');
  check('#settings: all four named, Set up lit, no section lit', /^The date range, grouping, platform and fleet do not apply/.test(set.applies)
    && set.setupOn && set.navOn === null, JSON.stringify(set));
  const roll = await on('#overview?days=30');
  check('a rolling window: the sentence is gone, and the two days are printed',
    roll.hidden && roll.applies === '' && roll.win === 'Last 30 days · Dubai time' && !roll.subHidden
    && /^\d{1,2} [A-Z][a-z]{2}( \d{4})? – \d{1,2} [A-Z][a-z]{2} \d{4}$/.test(roll.sub) && !roll.setupOn, JSON.stringify(roll));

  /* A new page starts at its top, title included. */
  await page.setViewportSize({ width: 390, height: 844 });
  await on('#drivers');
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(100);
  const y = await on('#overview');
  const scrolled = await page.evaluate(() => ({ y: window.scrollY,
    title: document.querySelector('#viewTitle').getBoundingClientRect().top }));
  check('navigating lands on the top of the sheet, not past the title', scrolled.y === 0, JSON.stringify(scrolled));
  void y;
  await ctx.close();
}

/* ══ 4. the banner ════════════════════════════════════════════════════════ */
console.log('\n4 · the credential banner as a grid');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  let rows = ROWS;
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: authBody(rows) }));
  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#authBanner.stopped .ab-meta', { timeout: 15000 }).catch(() => {});
  const b = await page.evaluate(() => {
    const e = document.querySelector('#authBanner');
    const li = [...e.querySelectorAll('li')];
    return {
      cells: li.map((l) => [...l.children].map((c) => c.className)),
      sw: li.map((l) => l.querySelector('.ab-who .sw')?.className || null),
      who: li.map((l) => l.querySelector('.ab-who').textContent),
      key: li.map((l) => l.querySelector('.ab-key code').textContent),
      surface: li.map((l) => l.querySelector('.ab-key small')?.textContent || null),
      what: li.map((l) => l.querySelector('.ab-what').textContent),
      when: li.map((l) => l.querySelector('.ab-when').textContent),
      cols: getComputedStyle(li[0]).gridTemplateColumns.split(' ').length,
      meta: e.querySelector('.ab-meta')?.textContent || '',
      link: e.querySelector('.ab-meta a')?.getAttribute('href'),
      head: e.querySelector('.ab-head').textContent,
    };
  });
  check('each row is four cells: who, key, what, when',
    b.cells.length === 2 && b.cells.every((c) => c.join(' ') === 'ab-who ab-key ab-what ab-when') && b.cols === 4,
    JSON.stringify(b.cells) + ` cols ${b.cols}`);
  check('who carries the channel’s swatch beside the word', b.sw[0] === 'sw ch-uber' && b.sw[1] === 'sw ch-bolt'
    && /^Uber · Egari$/.test(b.who[0]) && /^Bolt · Ecosine$/.test(b.who[1]), JSON.stringify([b.sw, b.who]));
  check('the key has the surface it feeds under it', b.key[0] === 'SYNTH_COOKIE' && b.surface[0] === 'synthetic surface'
    && b.surface[1] === 'synthetic roster', JSON.stringify([b.key, b.surface]));
  check('what was said and when, in their own cells', /a synthetic reason/.test(b.what[0]) && /^last worked 3h ago$/.test(b.when[0]),
    JSON.stringify([b.what[0], b.when[0]]));
  check('the errand sentence is unchanged', /^2 credentials stopped working/.test(b.head), b.head);
  check('"as of" is the LATEST checked_at of the rows shown, in Dubai time (08:30Z = 12:30)',
    /^as of (\d{1,2} [A-Z][a-z]{2} )?12:30 Dubai/.test(b.meta), b.meta);
  check('…and the meta cell links to where credentials are fixed', b.link === '#settings' && /Set up → credentials/.test(b.meta),
    b.meta);
  /* No row carries a checked_at: no time is printed rather than the page's
     own minute — a clock reading "now" would claim a check nobody made. */
  rows = [SYNTH({ provider: 'fms', credential: 'SYNTH_PASS', state: 'saved', severity: 'pending', checked_at: null,
    saved_at: '2026-09-23T08:30:00Z', detail: 'saved, not tested' })];
  await page.evaluate(() => { location.hash = '#drivers'; });
  await page.waitForSelector('#authBanner.pending', { timeout: 15000 }).catch(() => {});
  const p = await page.evaluate(() => {
    const e = document.querySelector('#authBanner');
    const d = document.createElement('div'); d.className = 'authbanner stopped'; document.body.append(d);
    const stopBg = getComputedStyle(d).backgroundColor; d.remove();
    return { cls: e.className, meta: e.querySelector('.ab-meta')?.textContent || '', bg: getComputedStyle(e).backgroundColor,
      stopBg, when: e.querySelector('.ab-when')?.textContent, sw: e.querySelector('.ab-who .sw')?.className };
  });
  check('pending: the quiet tone, never the stopped ground', /\bpending\b/.test(p.cls) && p.bg !== p.stopBg, JSON.stringify(p));
  check('…saying when it was saved, with its swatch', /^saved (\d{1,2} [A-Z][a-z]{2} )?12:30$/.test(p.when) && p.sw === 'sw ch-fms',
    JSON.stringify(p));
  check('…and no "as of" when no row says when it was checked', !/as of/.test(p.meta) && /Set up → credentials/.test(p.meta),
    p.meta);
  await ctx.close();
}

/* ══ 5. the livebar and freshness ═════════════════════════════════════════ */
console.log('\n5 · the livebar, and freshness on one line');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#todayNow:not([hidden]) .lb-top', { timeout: 15000 }).catch(() => {});
  await page.waitForSelector('#freshness .fr-sep', { timeout: 15000 }).catch(() => {});
  const l = await page.evaluate(() => {
    const h = document.querySelector('#todayNow');
    const figs = [...h.querySelectorAll('.lb-figs > .tn-f')];
    const det = h.querySelector('details.lb-notes');
    return {
      top: [...(h.querySelector('.lb-top')?.children || [])].map((n) => n.className),
      scope: h.querySelector('.lb-scope')?.textContent || '',
      figs: figs.map((f) => ({ v: !!f.querySelector('.lb-line > b'), l: f.querySelector('.lb-l')?.textContent })),
      hl: h.querySelector('.lb-hl .lb-l')?.textContent || null,
      hlRule: h.querySelector('.lb-hl b') ? getComputedStyle(h.querySelector('.lb-hl b')).borderBottomWidth : null,
      hlBg: h.querySelector('.lb-hl b') ? getComputedStyle(h.querySelector('.lb-hl b')).backgroundColor : null,
      open: det ? det.open : null, summary: det?.querySelector('summary')?.textContent || '',
      notes: det ? [...det.querySelectorAll('.lb-note')].map((p) => p.textContent) : [],
      title: h.title,
      fresh: document.querySelector('#freshness').innerHTML,
      freshLines: (() => { const e = document.querySelector('#freshness'); const c = getComputedStyle(e);
        return Math.round((e.getBoundingClientRect().height - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom))
          / parseFloat(c.lineHeight)); })(),
    };
  });
  check('the lede, the scope caption and the links on the first line',
    l.top.join(' ') === 'tn-now lb-scope tn-links', l.top.join(' '));
  check('the scope is said on the face of the strip, not only in a title',
    l.scope === 'Both fleets, every channel — this strip does not follow the filters above.', l.scope);
  check('every figure is a cell: the value, and its label as an element', l.figs.length >= 5
    && l.figs.every((f) => f.v && f.l), JSON.stringify(l.figs));
  check('trip value carries the chrome emphasis — a rule, no wash', l.hl === 'trip value' && l.hlRule === '3px'
    && /rgba\(0, 0, 0, 0\)|transparent/.test(l.hlBg), `${l.hl} ${l.hlRule} ${l.hlBg}`);
  check('the notes that lived only in host.title are on the page, in a <details> that starts closed',
    l.open === false && l.notes.length >= 1 && /^\d+ notes? on these figures$/.test(l.summary)
    && l.notes.every((n) => l.title.includes(n)), JSON.stringify({ open: l.open, s: l.summary, n: l.notes }));
  check('…and host.title is still built', /does not follow the filters above it/.test(l.title));
  check('freshness is one line in three parts', !/<br>/.test(l.fresh) && (l.fresh.match(/fr-sep/g) || []).length === 2
    && l.freshLines === 1, `${l.freshLines} lines ${l.fresh.slice(0, 120)}`);
  await ctx.close();
}

/* ══ 6. zen ═══════════════════════════════════════════════════════════════ */
console.log('\n6 · the full page');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: authBody(ROWS) }));
  await page.goto(`${base}/?ui=desktop&skin=arkiv&zen=1#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#authBanner.stopped', { timeout: 15000 }).catch(() => {});
  await settle(page);
  const z = await page.evaluate(() => Object.fromEntries(['#mast', '#secRow', '#sectabs', '#todayNow', '#viewSub',
    '#authBanner', '#filters', '#zenBtn', '#viewTitle'].map((s) => [s, getComputedStyle(document.querySelector(s)).display])));
  check('zen hides the masthead, both rows, the strip and the sub-line',
    ['#mast', '#secRow', '#sectabs', '#todayNow', '#viewSub'].every((s) => z[s] === 'none'), JSON.stringify(z));
  check('…and keeps the banner, the controls with their way out, and the title',
    ['#authBanner', '#filters', '#zenBtn', '#viewTitle'].every((s) => z[s] !== 'none'), JSON.stringify(z));
  await page.goto(`${base}/?ui=desktop&skin=arkiv&zen=0#overview`, { waitUntil: 'load' });
  await settle(page);
  /* Print: the rows, the controls and the strip go, as the old skin's print
     rule says; the masthead stays — on paper it is where the window is named. */
  await page.emulateMedia({ media: 'print' });
  const pr = await page.evaluate(() => Object.fromEntries(['#mast', '#secRow', '#sectabs', '#filters', '#todayNow',
    '#viewTitle'].map((s) => [s, getComputedStyle(document.querySelector(s)).display])));
  check('print drops the rows, the controls and the strip, and keeps the masthead and the title',
    ['#secRow', '#sectabs', '#filters', '#todayNow'].every((s) => pr[s] === 'none') && pr['#mast'] !== 'none'
    && pr['#viewTitle'] !== 'none', JSON.stringify(pr));
  await page.emulateMedia({ media: 'screen' });
  await ctx.close();
}

/* ══ 7. 390px ═════════════════════════════════════════════════════════════ */
console.log('\n7 · a 390px window');
{
  const ctx = await fresh({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.route('**/api/auth**', (r) => r.fulfill({ contentType: 'application/json', body: authBody(ROWS) }));
  const over = {};
  for (const route of ['overview', 'settings', 'payouts']) {
    await page.goto(`${base}/?ui=desktop&skin=arkiv#${route}`, { waitUntil: 'load' });
    await page.waitForSelector('#app.ak-shell', { timeout: 15000 }).catch(() => {});
    await settle(page);
    over[route] = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  }
  check('#overview, #settings and #payouts do not scroll sideways', Object.values(over).every((v) => v <= 0), JSON.stringify(over));
  const x = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    return { today: r('#nav a:first-child').left, setup: r('#settingsLink').left, first: document.querySelector('#nav a .lb').textContent,
      fresh: r('#freshness').top, links: r('.secrow-links').bottom,
      li: getComputedStyle(document.querySelector('#authBanner li')).gridTemplateColumns.split(' ').length };
  });
  check('the sections come first and Set up after them (app.css gives the rail’s #nav order:3 here)',
    x.first === 'Today' && x.today < x.setup, JSON.stringify(x));
  check('freshness takes its own line under the links', x.fresh >= x.links - 1, JSON.stringify(x));
  check('the banner’s four cells stack inside each row', x.li === 1, JSON.stringify(x));
  /* The lit item is scrolled into its row, sideways: Set up on #settings,
     "Same person?" (the last page of People) in the view row. */
  const seen = async (hash, sel) => {
    await page.goto(`${base}/?ui=desktop&skin=arkiv${hash}`, { waitUntil: 'load' });
    await page.waitForSelector('#app.ak-shell', { timeout: 15000 }).catch(() => {});
    await settle(page);
    return page.evaluate((q) => {
      const [scroller, item] = q.map((s) => document.querySelector(s));
      if (!scroller || !item) return { missing: q };
      const s = scroller.getBoundingClientRect(), r = item.getBoundingClientRect();
      return { inView: r.left >= s.left - 1 && r.right <= s.right + 1, overflows: scroller.scrollWidth > scroller.clientWidth,
        y: window.scrollY };
    }, sel);
  };
  const su = await seen('#settings', ['#secRow .secrow-links', '#settingsLink.on']);
  const sp = await seen('#same-person', ['#sectabs .tabs', '#sectabs .tabs a.on']);
  check('the lit section and the lit page are scrolled into their rows at 390px, and the page is not moved',
    su.overflows && su.inView && sp.overflows && sp.inView && su.y === 0 && sp.y === 0, JSON.stringify([su, sp]));
  await ctx.close();
}
{
  /* The phone build under the skin: m.css hides #app with
     html[data-ui=phone] #app{display:none} at (1,1,1), and a display rule for
     #app under the skin at (1,2,0) would outrank it and draw the whole
     desktop shell above the phone app. */
  const ctx = await fresh({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(`${base}/?ui=phone&skin=arkiv#today`, { waitUntil: 'load' });
  await settle(page);
  const ph = await page.evaluate(() => ({ app: getComputedStyle(document.querySelector('#app')).display,
    m: document.querySelector('#m').childElementCount, mast: document.querySelector('#mast') ? 'built' : 'none' }));
  check('the phone build: the desktop shell stays hidden, and is never built', ph.app === 'none' && ph.m > 0
    && ph.mast === 'none', JSON.stringify(ph));
  await ctx.close();
}

/* ══ 8. a slow stylesheet ═════════════════════════════════════════════════ */
console.log('\n8 · arkiv.css held back: the first render still reads the tokens');
{
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.route('**/arkiv.css', async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load' });
  await page.waitForSelector('#view .glance, #view .kpis', { timeout: 20000 }).catch(() => {});
  await settle(page);
  const s = await page.evaluate(() => ({ shell: document.querySelector('#app').classList.contains('ak-shell'),
    mast: !!document.querySelector('#mast'), glance: !!document.querySelector('#view .glance'),
    kpiRow: !!document.querySelector('#view .kpis:not(.glance)') }));
  check('the new shell is built', s.shell && s.mast, JSON.stringify(s));
  check('…and #overview is the page contract, not the old page under the new stylesheet', s.glance, JSON.stringify(s));
  await ctx.close();
}

{
  /* Slower than the wait's 4s cap: the page renders without the sheet, and
     when the sheet lands the shell is built then — never a page left blank
     (#app is invisible under the skin until the shell exists). */
  const ctx = await fresh();
  const page = await ctx.newPage();
  await page.route('**/arkiv.css', async (r) => { await new Promise((ok) => setTimeout(ok, 5500)); await r.continue(); });
  await page.goto(`${base}/?ui=desktop&skin=arkiv#overview`, { waitUntil: 'load', timeout: 30000 });
  await page.waitForSelector('#app.ak-shell', { timeout: 12000 }).catch(() => {});
  await settle(page);
  const s = await page.evaluate(() => ({ shell: document.querySelector('#app').classList.contains('ak-shell'),
    vis: getComputedStyle(document.querySelector('#app')).visibility, glance: !!document.querySelector('#view .glance'),
    title: document.querySelector('#viewTitle').textContent }));
  check('a sheet slower than the cap: the shell is built when it lands, and the page is shown',
    s.shell && s.vis === 'visible' && s.glance && s.title === 'Fleet activity', JSON.stringify(s));
  await ctx.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
