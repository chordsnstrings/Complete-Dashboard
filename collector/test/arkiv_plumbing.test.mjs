/* ARK — the Arkiv leftovers: channel chips, desktop row marks, theme colours
   and font preloads, and the page contract on the five pages that had none.
   ═══════════════════════════════════════════════════════════════════════════
   HANDOFF §4.5 listed them as not built. What this file holds down:

   1. chanChip() (ui.js): under the old skin it is byte for byte the pill the
      call site drew (the Classic skin is frozen); under the page contract a
      platform pill that knows its channel carries that channel's swatch and
      data-ch, and a name that is not one of the six (a fleet, a fuel) gets no
      swatch (SPEC L1). Drawn in the browser on #driver (header and account
      pills), on the phone through the desktop driver page, and absent in
      Classic.
   2. tableFrom's rowMark: under the contract each marked row carries data-ch
      and its first cell a 3px rule in the channel's identity (a card's edge
      at 390px); an unexplained journey and a feed that is no channel carry
      none; Classic carries no attribute. #trips, #driver/<id>/trips,
      #corporate/properties, #day, #drivers' performance records.
   3. index.html: the theme-color metas are Arkiv's paper (tokens.js), the
      browser bar follows a CHOSEN theme from the first paint, follows the
      theme button, and is Classic's linen under Classic; the preloads are the
      faces Arkiv draws first (Karla, Plex Mono 400), every one used.
   4. The page contract on #messages, #approvals, #access, #fleet-names and
      the sign-in page: 00 first (after a tab bar), one hero, no bare dash, a
      † band with its reasons, the colophon — and the old page in Classic.

   REVERSIONS that prove it (each was made, run, and seen to fail the named
   check, 2026-11-12):
     · ui.js chanChip: drop the `contract() ?` gate (always the chip) → "1 ·
       under the old skin it is the pill the call site drew" fails.
     · ui.js tableFrom: `trOpen` returns '<tr>' always → every "2 · … rows
       carry data-ch" check fails.
     · arkiv.css: delete the tr[data-ch]>td:first-child rule → "2 · …the
       first cell draws a 3px rule in Uber's colour" fails.
     · index.html: put back #f4f2ed / #14171a → "3 · the light meta is
       Arkiv's paper" fails; drop the pre-paint collapse → "…a chosen dark
       theme on a light OS: the bar is dark from the first paint" fails.
     · messages.js: `const ak = false` → "4 · #messages: 00 leads" fails.

   Synthetic data only (mockapi.mjs, plus fixtures for a signed-in reader). */
import { readFileSync } from 'node:fs';
import { app as mock } from '../mockapi.mjs';
import { launchChromium } from './browser.mjs';
import { settle, shape } from './arkiv_pages.mjs';
import { CLASSES } from '../api/public/access_model.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const PUB = new URL('../api/public/', import.meta.url);
const read = (f) => readFileSync(new URL(f, PUB), 'utf8');
const errors = [];

/* ══ 1 · chanChip, in node ═══════════════════════════════════════════════ */
console.log('\n1 · chanChip(): the old pill under Classic, a channel chip under the contract');
const ui = await import('../api/public/ui.js');
const { NEUTRAL, NEUTRAL_DARK } = await import('../api/public/tokens.js');
check('under the old skin it is the pill the call site drew (driver header, unit economics)',
  ui.chanChip('uber') === ui.pill(ui.sourceLabel('uber'), 'plat')
  && ui.chanChip('bolt') === ui.pill('Bolt', 'plat'), ui.chanChip('uber'));
check('…the HR roster accounts column (a title)', ui.chanChip('yango', { title: 'ext-9' }) === ui.pill('Yango', 'plat', 'ext-9'));
check('…the driver header account pills: "plat" only on the account the address named',
  ui.chanChip('uber', { label: 'Uber 12345678…', tone: null, title: 't' }) === ui.pill('Uber 12345678…', null, 't')
  && ui.chanChip('uber', { label: 'Uber 1', tone: 'plat' }) === ui.pill('Uber 1', 'plat'));
check('…the HR roster account link: the same <a class="pill plat" href title>',
  ui.chanChip('bolt', { label: 'Bolt · phone', title: 'Bolt account x — matched by phone', href: '#driver/p7' })
    === '<a class="pill plat" href="#driver/p7" title="Bolt account x — matched by phone">Bolt · phone</a>');
check('…the driver ledger, whose label is the raw key', ui.chanChip('uber', { label: 'uber' }) === '<span class="pill plat">uber</span>');
{
  const real = { d: globalThis.document, g: globalThis.getComputedStyle };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === '--pg-contract' ? '1' : '') });
  try {
    const c = ui.chanChip('uber');
    check('under the contract: the chip class, the channel named, its swatch first, the word in the chip',
      c === '<span class="pill plat chan" data-ch="uber"><i class="sw ch-uber" aria-hidden="true"></i>Uber</span>', c);
    check('…a link keeps its href and title, in the same order',
      /^<a class="pill plat chan" href="#d" title="t" data-ch="hotel"><i class="sw ch-hotel"/.test(ui.chanChip('hotel', { href: '#d', title: 't' })));
    check('…a name that is no channel (a fleet, a fuel) gets no swatch and stays the neutral pill',
      ui.chanChip('ecosine', { label: 'Ecosine' }) === '<span class="pill plat">Ecosine</span>'
      && !/class="sw/.test(ui.chanChip('petrol')));
    check('…the label is escaped once', /Smith &amp; &lt;b&gt;/.test(ui.chanChip('uber', { label: 'Smith & <b>' })));
  } finally { globalThis.document = real.d; globalThis.getComputedStyle = real.g; }
}

/* ══ 2-4 · in the browser ═════════════════════════════════════════════════ */
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();

/* A signed-in Owner, for the pages that open only signed in. Every class at
   F, the actions the five pages ask for. Synthetic: @example.test. */
const ALL = Object.fromEntries(CLASSES.map((c) => [c.code, 'F']));
const CAPS = ['access.manage', 'fleets.link', 'cash.import', 'cash.import.commit', 'identity.merge'];
const ME = { signedIn: true, kind: 'user', mode: 'open', loaded: true,
  user: { id: 1, email: 'owner@example.test', name: 'Test Owner' }, owner: true, preview: null, restricted: null,
  roles: ['OWN'], fleets: [{ id: 'ecosine', name: 'Ecosine' }, { id: 'egari', name: 'Egari' }],
  access: { levels: ALL, levelsAny: ALL, caps: CAPS, capsAny: CAPS, byFleet: {}, scope: ['ecosine', 'egari'], allFleets: ['ecosine', 'egari'] } };
const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const OVERVIEW = {
  users: [
    { id: 1, email: 'owner@example.test', name: 'Test Owner', status: 'active', totp_enabled: true, lastLoginAt: iso(2) },
    { id: 2, email: 'two@example.test', name: 'Test Two', status: 'active', totp_enabled: false, lastLoginAt: iso(30) },
    { id: 3, email: 'three@example.test', name: 'Test Three', status: 'invited', totp_enabled: false, lastLoginAt: null },
  ],
  teams: [], requests: [{ id: 5, user_id: 2, role_code: 'DSP', created_at: iso(3), reason: 'Test' }],
  grants: [{ id: 9, user_id: 2, role_code: 'DSP', status: 'pending', fleets: [], expires_at: null, effective_at: null }],
  devices: [{ id: 1, name: 'Test wall', role_code: 'WALL', fleets: [], created_at: iso(48), last_seen_at: iso(1), revoked_at: null }],
  fleets: [{ id: 'ecosine', name: 'Ecosine' }, { id: 'egari', name: 'Egari' }], owners: [1], roles: [],
  config: { mode: 'open', mfa: 'optional' }, me: { id: 1, owner: true, caps: CAPS, levels: ALL, scope: ['ecosine', 'egari'] },
};
const PROPOSALS = { proposals: [
  { id: 1, kind: 'POST /api/ledger/import/commit', summary: 'Import 2 cash rows', view: 'rows', status: 'open',
    payload: { batch: 'b-1', rows: [{ day: '2026-11-01', amount: 10 }, { day: '2026-11-02', amount: 12 }] },
    prepared_by: 2, prepared_name: 'Test Two', prepared_at: iso(5), canCommit: true, mine: false },
  { id: 2, kind: 'POST /api/ledger/import/commit', summary: 'Import 1 cash row', view: 'rows', status: 'committed',
    payload: { rows: [] }, prepared_by: 2, prepared_at: iso(50), decided_email: 'owner@example.test', canCommit: false, mine: false },
  { id: 3, kind: 'POST /api/persons/merge', summary: 'Merge two records', view: 'merge', status: 'declined', result: { withdrawn: true },
    payload: { keep: 1, drop: 2, why: 'Test' }, prepared_by: 1, prepared_at: iso(70), decided_email: 'owner@example.test', canCommit: false, mine: true },
] };
const ACCOUNTS = { accounts: [], changes: [{ id: 1, status: 'pending' }], me: { linkFleets: [] } };
const SIGNED = { '/api/auth/me': ME, '/api/access/overview': OVERVIEW, '/api/access/proposals': PROPOSALS, '/api/fleets/accounts': ACCOUNTS };

async function open(skin, hash, { ui: build = 'desktop', width = 1280, scheme = 'light', fixtures = null, theme = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce',
    colorScheme: scheme, timezoneId: 'Asia/Dubai', locale: 'en-GB',
    ...(build === 'phone' ? { isMobile: true, hasTouch: true } : {}) });
  if (theme) await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  const warnings = [];
  page.on('pageerror', (e) => errors.push(`${skin} ${hash}: ${String(e.message).slice(0, 200)}`));
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
  const fonts = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/fonts/')) fonts.push(u.pathname.slice(7)); });
  if (fixtures) {
    await page.route((u) => Object.hasOwn(fixtures, new URL(u).pathname), (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(fixtures[new URL(route.request().url()).pathname]) }));
  }
  await page.goto(`${base}/?ui=${build}&skin=${skin}&motion=off#${hash}`, { waitUntil: 'load' });
  if (build === 'desktop') await page.waitForSelector('#nav a', { state: 'attached' });
  await settle(page);
  return { ctx, page, warnings, fonts };
}
const metas = (page) => page.evaluate(() => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.content));
const INSET3 = /3px 0px 0px( 0px)? inset|inset 3px 0px 0px/;

await (async () => {
  /* ── 2 · row marks ── */
  console.log('\n2 · tableFrom rowMark: a 3px rule in the row’s channel, desktop');
  {
    const { ctx, page } = await open('arkiv', 'trips');
    const r = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#view table tbody tr')];
      const ch = rows.map((t) => t.dataset.ch || '');
      const uber = rows.find((t) => t.dataset.ch === 'uber');
      const td = uber?.querySelector('td');
      const probe = document.createElement('i'); probe.style.color = 'var(--c-uber)'; document.body.append(probe);
      const uberRgb = getComputedStyle(probe).color; probe.remove();
      const word = uber ? [...uber.querySelectorAll('td')][1] : null;
      return { n: rows.length, ch, shadow: td ? getComputedStyle(td).boxShadow : '', uberRgb,
        pad: td ? parseFloat(getComputedStyle(td).paddingLeft) : 0, wordColor: word ? getComputedStyle(word).color : '',
        ink: getComputedStyle(document.documentElement).getPropertyValue('--ink').trim(),
        bg: uber ? getComputedStyle(uber).backgroundColor : '' };
    });
    check('#trips: every row names its channel in data-ch', r.n > 0 && r.ch.every((c) => ['uber', 'bolt', 'yango', 'hotel'].includes(c)), r.ch.join(','));
    /* Chromium serialises an inset shadow colour-first: "rgb(…) 3px 0px 0px 0px inset". */
    check('…the first cell draws a 3px rule in Uber’s colour, beside the pinned rule',
      r.shadow.startsWith(r.uberRgb) && INSET3.test(r.shadow) && /, rgb\([^)]*\) 1px 0px 0px/.test(r.shadow), `${r.shadow} / ${r.uberRgb}`);
    /* #trips is a compact table (10px of cell padding); a regular one has 14. */
    check('…the first word clears the rule (at least 5px of air past it)', r.pad - 3 >= 5, String(r.pad));
    check('…and the row is not tinted (L5.6)', r.bg === 'rgba(0, 0, 0, 0)' || r.bg === 'transparent', r.bg);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'trips');
    const n = await page.evaluate(() => document.querySelectorAll('#view tr[data-ch]').length);
    check('#trips in Classic: no row carries data-ch (the old DOM)', n === 0, String(n));
    await ctx.close();
  }
  {
    /* None of the tables the plan marks is a card table today, so the card
       rule is proved on a table tableFrom builds in the page itself — the
       real module, the real stylesheet, at 390px. */
    const { ctx, page } = await open('arkiv', 'trips', { width: 390 });
    const r = await page.evaluate(async () => {
      const m = await import('/ui.js');
      const t = m.tableFrom([{ p: 'uber', n: 1 }, { p: 'fleet-x', n: 2 }],
        [{ label: 'Channel', key: 'p' }, { label: 'N', key: 'n', num: true }], { cards: true, rowMark: (x) => x.p });
      t.id = 'probe'; document.querySelector('#view').prepend(t);
      const [a, b] = t.querySelectorAll('tbody tr');
      return { shadow: getComputedStyle(a).boxShadow, pad: parseFloat(getComputedStyle(a).paddingLeft),
        cell: getComputedStyle(a.querySelector('td')).boxShadow, other: b.dataset.ch || '', otherShadow: getComputedStyle(b).boxShadow,
        over: document.documentElement.scrollWidth - innerWidth };
    });
    check('a card table at 390px: the rule runs down the marked card’s edge and the card steps in',
      INSET3.test(r.shadow) && r.pad >= 10 && r.cell === 'none', JSON.stringify(r));
    check('…a row whose name is no channel carries no mark', r.other === '' && !/inset/.test(r.otherShadow), JSON.stringify(r));
    check('…and #trips at 390px does not scroll sideways', r.over <= 0, String(r.over));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0/trips');
    const r = await page.evaluate(() => [...document.querySelectorAll('#view table tbody tr')].map((t) => ({
      ch: t.dataset.ch || '', un: /no booking|unauthori/i.test(t.textContent) })));
    const booked = r.filter((x) => !x.un);
    check('#driver/<id>/trips: each booking names its channel', booked.length > 0 && booked.every((x) => x.ch), JSON.stringify(r.slice(0, 6)));
    check('…a journey no platform booked names none', r.filter((x) => x.un).every((x) => !x.ch), JSON.stringify(r.filter((x) => x.un)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'corporate/properties');
    const ch = await page.evaluate(() => [...document.querySelectorAll('#view table tbody tr')].map((t) => t.dataset.ch || ''));
    check('#corporate/properties: every row carries the hotel mark (plan §4)', ch.length > 0 && ch.every((c) => c === 'hotel'), ch.join(','));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'day/2026-08-14');
    const r = await page.evaluate(() => [...document.querySelectorAll('#view table tbody tr')].map((t) => ({
      ch: t.dataset.ch || '', first: (t.querySelector('td')?.textContent || '').trim() })));
    check('#day: rows that are one channel are marked, others are not', r.some((x) => x.ch) && r.some((x) => !x.ch), JSON.stringify(r.slice(0, 10)));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'drivers');
    const ch = await page.evaluate(() => {
      const p = [...document.querySelectorAll('#view .panel')].find((x) => /Platform performance records/.test(x.querySelector('h3')?.textContent || ''));
      return p ? [...p.querySelectorAll('tbody tr')].map((t) => t.dataset.ch || '') : null;
    });
    check('#drivers §06 performance records: each record names its platform', ch && ch.length > 0 && ch.every(Boolean), JSON.stringify(ch));
    await ctx.close();
  }

  /* ── 1b · channel chips, drawn ── */
  console.log('\n1b · channel chips in the browser: desktop, phone, Classic');
  {
    const { ctx, page } = await open('arkiv', 'driver/drv-0');
    const r = await page.evaluate(() => [...document.querySelectorAll('#view .idsub .pill.chan, #view .pill.chan')].map((p) => ({
      ch: p.dataset.ch, sw: !!p.querySelector(`.sw.ch-${p.dataset.ch}`), word: p.textContent.trim(),
      swW: p.querySelector('.sw') ? p.querySelector('.sw').getBoundingClientRect().width : 0,
      color: getComputedStyle(p).color })));
    const ink2 = await page.evaluate(() => { const i = document.createElement('i'); i.style.color = 'var(--ink-2)'; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; });
    check('#driver: each platform pill is a channel chip with its own swatch', r.length > 0 && r.every((x) => x.ch && x.sw && x.word), JSON.stringify(r));
    check('…the swatch is 8px, inside the chip', r.every((x) => Math.round(x.swW) === 8), JSON.stringify(r.map((x) => x.swW)));
    check('…and the word stays ink, never the channel colour (L5.6)', r.every((x) => x.color === ink2), `${JSON.stringify(r.map((x) => x.color))} vs ${ink2}`);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'driver/drv-0');
    const r = await page.evaluate(() => ({ chan: document.querySelectorAll('#view .pill.chan').length,
      plat: document.querySelectorAll('#view .idsub .pill.plat').length, sw: document.querySelectorAll('#view .idsub .pill .sw').length }));
    check('#driver in Classic: the old platform pills, no chip, no swatch', r.chan === 0 && r.plat > 0 && r.sw === 0, JSON.stringify(r));
    await ctx.close();
  }
  {
    /* A driver's TAB on the phone is the desktop module, drawn inside #m by
       m/screens.js fallback() — the phone's own driver screen has no pill. */
    const { ctx, page } = await open('arkiv', 'driver/drv-0/overview', { ui: 'phone', width: 390 });
    const r = await page.evaluate(() => ({ chips: [...document.querySelectorAll('#m .pill.chan')].map((p) => p.dataset.ch),
      over: document.documentElement.scrollWidth - innerWidth }));
    check('the phone (the desktop driver page in #m): the same channel chips', r.chips.length > 0, JSON.stringify(r));
    check('…with no sideways scroll at 390px', r.over <= 0, String(r.over));
    await ctx.close();
  }

  /* ── 3 · theme colours and preloads ── */
  console.log('\n3 · the browser bar in Arkiv’s paper; the preloads Arkiv draws first');
  const html = read('index.html');
  const metaOf = (media) => (html.match(new RegExp(`<meta name="theme-color" content="([^"]+)" media="\\(prefers-color-scheme: ${media}\\)">`)) || [])[1];
  check('the light meta is Arkiv’s paper (tokens.js NEUTRAL.paper)', metaOf('light') === NEUTRAL.paper, metaOf('light'));
  check('the dark meta is Arkiv’s dark paper (tokens.js NEUTRAL_DARK.paper)', metaOf('dark') === NEUTRAL_DARK.paper, metaOf('dark'));
  const pre = [...html.matchAll(/<link rel="preload" href="\/fonts\/([^"]+)"/g)].map((m) => m[1]);
  check('the preloads are Karla and Plex Mono 400 — what Arkiv draws first, measured', pre.join(' ') === 'karla-latin.woff2 ibm-plex-mono-400-latin.woff2', pre.join(' '));
  {
    const { ctx, page, warnings, fonts } = await open('arkiv', 'overview');
    check('Arkiv, light OS: the bar is the white paper', (await metas(page)).every((c) => c.toUpperCase() === '#FFFFFF'), (await metas(page)).join(' '));
    check('…both preloaded faces are fetched first', fonts.slice(0, 2).sort().join(' ') === 'ibm-plex-mono-400-latin.woff2 karla-latin.woff2', fonts.join(' '));
    check('…and neither is reported preloaded-but-unused', !warnings.some((w) => /preload/i.test(w)), warnings.filter((w) => /preload/i.test(w)).join(' | '));
    await page.click('#themeBtn');                       // system → light
    await page.click('#themeBtn');                       // light → dark
    await page.waitForTimeout(300);
    check('…the theme button to dark moves the bar to the dark paper', (await metas(page)).every((c) => c.toUpperCase() === '#1E1F22'), (await metas(page)).join(' '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'overview', { scheme: 'dark' });
    check('Arkiv, dark OS: the bar is the grey paper', (await metas(page)).every((c) => c.toUpperCase() === '#1E1F22'), (await metas(page)).join(' '));
    await ctx.close();
  }
  {
    /* The pre-paint collapse alone: themecolor.js held back, so only
       index.html's own script can have moved the metas. */
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', colorScheme: 'light', timezoneId: 'Asia/Dubai' });
    await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark'); } catch { /* none */ } });
    const page = await ctx.newPage();
    await page.route('**/themecolor.js', (r) => r.abort());
    await page.goto(`${base}/?ui=desktop&skin=arkiv&motion=off#overview`, { waitUntil: 'domcontentloaded' });
    check('a chosen dark theme on a light OS: the bar is dark from the first paint', (await metas(page)).every((c) => c.toUpperCase() === '#1E1F22'), (await metas(page)).join(' '));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'overview');
    check('Classic, light: the bar is Classic’s own paper, from the resolved --paper', (await metas(page)).every((c) => c.toLowerCase() === '#f4f2ed'), (await metas(page)).join(' '));
    await ctx.close();
  }

  /* ── 4 · the page contract on the five pages ── */
  console.log('\n4 · the page contract on #messages, #approvals, #access, #fleet-names and sign-in');
  const bandAfterTabs = (page) => page.evaluate(() => {
    const kids = [...document.querySelector('#view').querySelectorAll(':scope > *, :scope > div > *')];
    const band = document.querySelector('#view .cband');
    const tabs = document.querySelector('#view .tabs');
    return { band: !!band, after: !tabs || (band && (tabs.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING) > 0),
      firstPanelAfter: (() => { const p = document.querySelector('#view .panel'); return !p || (band && (band.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) > 0); })(),
      n: kids.length };
  });
  const contractChecks = async (name, page, { hero, tiles, abs, colophon }) => {
    const s = await shape(page);
    const b = await bandAfterTabs(page);
    check(`${name}: 00 leads — after the tab bar, before every panel`, b.band && b.after && b.firstPanelAfter, JSON.stringify(b));
    check(`${name}: ${tiles} tiles, the hero "${hero}"`, s.glance === tiles && s.hero === hero, `${s.glance} / ${s.hero} / ${s.labels.join(' | ')}`);
    check(`${name}: no tile prints a bare dash or a blank`, s.bare.length === 0, JSON.stringify(s.bare));
    check(`${name}: no tone on a level (no t-good/t-critical fill)`, await page.evaluate(() => !document.querySelector('#view .kpis.glance .t-good, #view .kpis.glance .t-critical, #view .kpis.glance .t-warn')));
    check(`${name}: the † band names ${abs.length} gaps, each with its reason`,
      abs.every((l) => s.abs.some((c) => c.label === l && c.why.length > 20)), JSON.stringify(s.abs.map((c) => c.label)));
    check(`${name}: the colophon is the page's`, colophon.test(s.colophon), s.colophon);
    check(`${name}: no sideways scroll`, s.overflowX <= 0, String(s.overflowX));
    return s;
  };
  {
    const { ctx, page } = await open('arkiv', 'messages', { fixtures: SIGNED });
    const s = await contractChecks('#messages', page, { hero: 'Texted to drivers', tiles: 5,
      abs: ['Older messages', 'Delivered to the phone', 'The charge’s currency', 'What a staff code said'], colophon: /The SMS outbox/i });
    check('#messages: the gateway charge is a figure when the gateway reported one', /0\.190/.test(s.values['Gateway charge'] || ''), JSON.stringify(s.values));
    check('#messages: "Older messages" counts what the list counts — 4 messages, not the 05:00 run’s line',
      /listed above — 4 messages\./.test(s.abs.find((c) => c.label === 'Older messages')?.why || ''), JSON.stringify(s.abs[0]));
    check('…the rules stay this page’s source line, so the shell stamps no "Built from"', await page.evaluate(() =>
      document.querySelectorAll('#view .srcline').length === 1 && !/Built from/.test(document.querySelector('#pageFoot .pf-basis')?.textContent || '')));
    await ctx.close();
  }
  {
    const fx = { ...SIGNED, '/api/sms/log': { rows: [], last7days: { sent: 0, held: 0, queued: 0, failed: 0, cost: 0 }, switches: {}, hold_why: {} } };
    const { ctx, page } = await open('arkiv', 'messages', { fixtures: fx });
    const s = await shape(page);
    check('#messages, nothing charged: the charge is ABSENT with its reason, never 0', /no text went to a driver/.test(s.na['Gateway charge'] || ''), JSON.stringify(s.na));
    check('…and a measured nought on a count is a figure', s.values['Texted to drivers'] === '0', JSON.stringify(s.values));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'messages/next', { fixtures: SIGNED });
    const s = await shape(page);
    check('#messages/next: the dry run says what it cannot know, and has its colophon',
      s.abs.some((c) => c.label === 'Whether the real run will do this') && /A dry run/i.test(s.colophon), JSON.stringify({ abs: s.abs, col: s.colophon }));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'messages', { fixtures: SIGNED });
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband, #view .absband'),
      tiles: document.querySelectorAll('#view .kpis .kpi').length }));
    check('#messages in Classic: the old tile row, no 00, no †', !r.band && r.tiles === 5, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'approvals', { fixtures: SIGNED });
    const s = await contractChecks('#approvals', page, { hero: 'Waiting for a second person', tiles: 4,
      abs: ['Decided more than 30 days ago', 'Proposals your role may not see'], colophon: /Four-eyes/i });
    check('#approvals: the counts are the proposals sent — 1 waiting, 1 yours, 2 decided (1 committed, 1 withdrawn)',
      s.values['Waiting for a second person'] === '1' && s.values['Yours to commit'] === '1' && s.values['Decided in the last 30 days'] === '2'
      && /1 committed/.test(s.subs['Decided in the last 30 days']) && /1 withdrawn/.test(s.subs['Decided in the last 30 days']), JSON.stringify({ v: s.values, s: s.subs }));
    check('#approvals: the two lists are numbered sections', s.heads.includes('Waiting for a second person') && s.heads.includes('Decided in the last 30 days'), s.heads.join(' | '));
    check('…and the waiting card still offers Commit', await page.locator('#view .ap-card .ap-commit').count() === 1);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'approvals', { fixtures: SIGNED });
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), h3: [...document.querySelectorAll('#view .ap-page > h3')].map((h) => h.textContent) }));
    check('#approvals in Classic: the old headings with their counts', !r.band && r.h3.join('|') === 'Waiting (1)|Decided in the last 30 days (2)', JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'access', { fixtures: SIGNED });
    const s = await contractChecks('#access', page, { hero: 'People with an account', tiles: 6,
      abs: ['Who reads without an account', 'Who stands at a wall screen', 'The platforms’ own logins'], colophon: /Access/ });
    check('#access: 3 people (2 active, 1 invited), two-step 1 of 2, 1 grant waiting, sign-in optional',
      s.values['People with an account'] === '3' && /2 active · 1 invited/.test(s.subs['People with an account'])
      && s.values['Two-step on'] === '1 of 2' && s.values['Waiting for an Owner'] === '1' && s.values['Sign-in'] === 'Optional', JSON.stringify(s.values));
    check('#access: the People tab’s own tile row is folded into 00 (no figure twice)', s.kpiRows === 0, String(s.kpiRows));
    check('#access: the people table is still there', await page.locator('[data-panel="acx-people"]').count() === 1);
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'access', { fixtures: SIGNED });
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#view .cband'), tiles: document.querySelectorAll('#view .kpis .kpi').length }));
    check('#access in Classic: the People tab’s tile row as it was', !r.band && r.tiles === 5, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'fleet-names', { fixtures: SIGNED });
    const s = await contractChecks('#fleet-names', page, { hero: 'Fleets', tiles: 6,
      abs: ['An account no platform has reported', 'A rename between two reads', 'Linked accounts that send no name'], colophon: /Fleet names/ });
    check('#fleet-names signed in: 2 fleets, 4 linked accounts, 1 link waiting', s.values.Fleets === '2' && s.values['Accounts linked to them'] === '4'
      && s.values['Links waiting for an Owner'] === '1', JSON.stringify(s.values));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'fleet-names');
    const s = await shape(page);
    check('#fleet-names signed out: the accounts’ counts are ABSENT with the true reason, never 0',
      /sign in/i.test(s.na['New accounts'] || '') && /sign in/i.test(s.na['Links waiting for an Owner'] || ''), JSON.stringify(s.na));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('arkiv', 'fleet-names', { ui: 'phone', width: 390, fixtures: SIGNED });
    const r = await page.evaluate(() => ({ band: !!document.querySelector('#m .cband'), foot: document.querySelector('#m .pf-inline .pf-colophon')?.textContent || '',
      over: document.documentElement.scrollWidth - innerWidth }));
    check('#fleet-names on the phone: 00 and its own footer inside the screen, no sideways scroll',
      r.band && /Fleet names/i.test(r.foot) && r.over <= 0, JSON.stringify(r));
    await ctx.close();
  }
  {
    const { ctx, page } = await open('classic', 'fleet-names', { fixtures: SIGNED });
    check('#fleet-names in Classic: no 00, no †', await page.evaluate(() => !document.querySelector('#view .cband, #view .absband')));
    await ctx.close();
  }
  const PRINCIPLE = 'A figure that cannot be measured is shown absent, with the reason — never as zero.';
  for (const [w, scheme] of [[1280, 'light'], [390, 'dark']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 844 }, serviceWorkers: 'block', colorScheme: scheme, timezoneId: 'Asia/Dubai' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`signin: ${String(e.message).slice(0, 200)}`));
    await page.goto(`${base}/signin.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('.si-foot.pagefoot'), null, { timeout: 8000 }).catch(() => {});
    const r = await page.evaluate(() => ({ cls: document.querySelector('.si-foot')?.className,
      basis: document.querySelector('.si-foot .pf-p')?.textContent, principle: document.querySelector('.si-foot .pf-principle')?.textContent,
      col: [...document.querySelectorAll('.si-foot .pf-colophon span')].map((s) => s.textContent),
      ink: getComputedStyle(document.querySelector('.si-foot .pf-principle') || document.body).color,
      over: document.documentElement.scrollWidth - innerWidth }));
    check(`sign-in ${w}px ${scheme}: the footer is the contract's — basis, the principle verbatim, the colophon`,
      /pagefoot/.test(r.cls) && r.basis === 'Every sign-in is recorded in the audit log.' && r.principle === PRINCIPLE
      && r.col.join(' | ') === 'FleetMirror | Sign-in', JSON.stringify(r));
    check(`…no sideways scroll at ${w}px`, r.over <= 0, String(r.over));
    await ctx.close();
  }
})().catch((e) => { fail++; console.log(`  ✗ the browser half threw: ${e.stack || e}`); });

check('no page error anywhere in this file', errors.length === 0, errors.join(' | '));
await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
