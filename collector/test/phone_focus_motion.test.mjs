/* FOCUS and MOTION on the phone (m/focus-m.js, m/motion-m.js, m/motion-m.css).
   ─────────────────────────────────────────────────────────────────────────
   The Arkiv skin's two desktop layers — the explanations folded under ⓘ
   (FIX-STATUS FOCUS, the operator's "it's a manuscript") and the motion layer
   (FIX-STATUS MOTION) — brought to the phone build, which had neither
   (HANDOFF 0.9 and 0.11; the front-end audit of 2026-11-12). FIX-STATUS MOB
   has the rows. What has to hold, and why each one is here:

     1 · THE SHEET keeps the skin's contract: tokens only, every selector
         behind [data-motion="on"] on the phone under the skin, everything that
         MOVES behind prefers-reduced-motion, and m/arkiv-m.css still free of
         the layer's keyframes.
     2 · THE SWITCH. index.html stamps the phone by the desktop's rules (off
         under automation unless asked), APPENDS the phone's sheet so it never
         holds the first paint, and never gives the phone the desktop's
         motion.css; the service worker precaches what a cold offline open
         needs; m/app.js starts both layers before the first screen.
     3 · FOCUS, on every screen: only the phone's prose is ever marked — never
         a row, a tile's figure or label, a control; every row is as tall with
         the pass on as off ("a row is not a paragraph", COVERAGE trap); every
         toggle is a 44px target; opening every toggle shows every word the
         pass-off screen shows; nothing that says a figure is absent, or why,
         is ever folded away; the desktop's own pass runs on the fallback's
         desktop tab. The old skin's phone is never marked.
     4 · NO LAYOUT SHIFT: no prose block is ever painted before it is marked
         (watched frame by frame), and the layout shift with the pass on is
         the layout shift with it off.
     5 · NO LOOP: a settled screen is still — no mutation from either layer,
         and the toggles' labels are not rewritten (the desktop's were, eight
         times a second, until this change).
     6 · THE SWITCH, ON THE PHONE: More → This app turns the folding off and
         on again, remembered; off, nothing is hidden.
     7 · THE BOOT SHEET stands where the shell will: the mark on the
         wordmark's own box, the rule on the control bar's, the sentence after
         four seconds for each wait, "stopped" when a module fails, and gone on
         the first screen.
     8 · A SCREEN ARRIVING gets the entrance and the old 14px slide is gone; a
         REDRAW (the refresh button) gets nothing; content after a watched
         skeleton comes up; nothing is left behind.
     9 · A FIGURE THAT MOVED is washed — on Today's minute refresh and on a
         redraw that brings new figures — and one that did not move is not;
         switching a segment (its lists are rows; no tile changes value on
         any screen, measured) washes nothing.
    10 · REDUCED MOTION: nothing of the layer runs, the words still show, and
         the phone's own sheet no longer slides.
    11 · TOUCH: the press is felt — a colour that arrives and lifts, a button
         that gives 1px — and every control stays at least 44px with both
         layers on.
    12 · FIRST PAINT: the phone's sheet does not hold the first paint, and the
         layer's layout is the still page's to the pixel.

   Hermetic: test/phone_harness.mjs answers every request from the recorded
   fixture with the clock fixed — no port, no network, no mock server. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUB, ORIGIN, launch, phonePage, loadFixture, SCREENS, DESKTOP_TABS, keyOf } from './phone_harness.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
/* ONLY=3,5 runs those browser sections alone (the source checks always run):
   how each revert in FIX-STATUS MOB was proved without the whole file. */
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const run = (n) => !ONLY || ONLY.has(String(n));
const read = (f) => readFileSync(join(PUB, f), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ');
const PFX = ':root[data-skin="arkiv"][data-ui="phone"][data-motion="on"]';

/* ══ 1 · the sheet ════════════════════════════════════════════════════════ */
console.log('\n1 · m/motion-m.css keeps the skin’s contract');
const css = strip(read('m/motion-m.css'));
check('no hex', !/#[0-9a-f]{3,8}\b/i.test(css.replace(/#(m|akBusy)\b/g, '')));
check('no rgb()/hsl() literal', !/\b(?:rgba?|hsla?)\(/i.test(css));
const MQ = '@media (prefers-reduced-motion:no-preference){';
const at = css.indexOf(MQ);
let end = at + MQ.length, depth = 1;
while (depth && end < css.length) { if (css[end] === '{') depth++; else if (css[end] === '}') depth--; end++; }
const inside = css.slice(at + MQ.length, end - 1);
const outside = css.slice(0, at) + css.slice(end);
check('one reduced-motion block, and it is the only @media', at > 0 && (css.match(/@media/g) || []).length === 1);
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
const unscoped = sels.filter((s) => !s.startsWith(PFX));
check(`every selector is behind ${PFX} (${sels.length})`, sels.length > 40 && unscoped.length === 0, unscoped.slice(0, 4).join(' | '));
const looseAnim = rulesOf(outside).flatMap(([s, b]) => b.split(';').map((d) => d.trim())
  .filter((d) => /^animation\s*:/.test(d) && !/^animation\s*:\s*(none|akm-show 1ms linear [\d.]+s forwards)$/.test(d))
  .map((d) => `${s.slice(-40)} { ${d} }`));
check('outside it, nothing animates but the 1ms reveal of the boot words', looseAnim.length === 0, looseAnim.join(' | '));
const looseMove = rulesOf(outside).filter(([, b]) => /(?:^|;)\s*(translate|transform)\s*:\s*(?!none|scaleX\(0\)|translateX\(-100%\))/.test(b));
check('…and nothing outside it moves', looseMove.length === 0, looseMove.map(([s]) => s.slice(-50)).join(' | '));
const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
const used = new Set([...css.matchAll(/animation\s*:\s*([^;}]+)/g)].flatMap((m) => split(m[1]))
  .map((x) => x.trim().split(/\s+/)[0]).filter((n) => n && n !== 'none'));
const undef = [...used].filter((n) => !defined.has(n));
check('every animation used is defined here, and named akm-* (never the desktop’s ak-*)',
  undef.length === 0 && defined.size > 5 && [...defined].every((n) => n.startsWith('akm-')), `${undef.join(' ')} / ${[...defined].join(' ')}`);
const decls = [...css.matchAll(/\{([^{}]*)\}/g)].flatMap((m) => m[1].split(';')).map((d) => d.trim()).filter(Boolean);
const sizes = decls.filter((d) => /^font-size\s*:/.test(d));
check('every font-size is a step of app.css’s scale', sizes.length > 0 && sizes.every((d) => /^font-size\s*:\s*var\(--[td]\d\)$/.test(d)),
  sizes.filter((d) => !/var\(--[td]\d\)/.test(d)).join(' | '));
{
  const all = [read('app.css'), read('arkiv.css'), read('m/m.css'), read('m/arkiv-m.css'), read('m/motion-m.css')].map(strip).join('\n');
  const declared = new Set([...all.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  declared.add('--akm-pen');                     // its own @property
  const asked = [...new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1]))];
  const undeclared = asked.filter((n) => !declared.has(n));
  check('every var() it asks for is declared somewhere', undeclared.length === 0, undeclared.join(' '));
}
check('m/arkiv-m.css still carries no @keyframes (the layer is a file of its own)', !/@keyframes/.test(strip(read('m/arkiv-m.css'))));
check('m/arkiv-m.css stills the deck’s smooth scroll for reduced motion — the one movement app.css’s reset cannot reach',
  /@media \(prefers-reduced-motion:reduce\)\{\s*:root\[data-skin="arkiv"\]\[data-ui="phone"\] \.m-deck\{scroll-behavior:auto\}/.test(strip(read('m/arkiv-m.css')))
  && /@media \(prefers-reduced-motion: reduce\)\{\s*\*,\*::before,\*::after\{animation-duration:\.001ms !important;[^}]*transition-duration:\.001ms !important\}/.test(read('app.css')));

/* ══ 2 · the switch, in the source ═══════════════════════════════════════ */
console.log('\n2 · index.html, the service worker, m/app.js');
const html = read('index.html');
check('the stamp is the Arkiv skin on BOTH builds now, off under automation unless asked',
  /if \(r\.dataset\.skin === 'arkiv'\) \{\s*\n\s*var mo = /.test(html) && !/r\.dataset\.skin === 'arkiv' && !phone/.test(html)
  && /mo === 'on' \|\| \(mo !== 'off' && !navigator\.webdriver\)/.test(html));
check('the desktop’s motion.css is written in for the desktop build only',
  /dataset\.motion === 'on' && document\.documentElement\.dataset\.ui !== 'phone'\)\s*\n\s*document\.write\('<link rel="stylesheet" href="\/motion\.css">'\)/.test(html));
check('the phone’s sheet is APPENDED beside m.css — never parser-written — and only with the layer on',
  /if \(phone\) \{[\s\S]{0,500}if \(r\.dataset\.motion === 'on'\) \{[\s\S]{0,240}mcss\.href = '\/m\/motion-m\.css';[\s\S]{0,80}document\.head\.appendChild\(mcss\)/.test(html)
  && !/document\.write\([^)]*motion-m\.css/.test(html));
check('a failed opening is no longer watched once the phone’s first screen is up',
  /document\.querySelector\('#app\.ak-shell'\) \|\| r\.dataset\.boot === 'up'\) return;/.test(html));
{
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL_FILES'), sw.indexOf('self.addEventListener')).replace(/\/\*[\s\S]*?\*\//g, ' ');
  const need = ['/m/focus-m.js', '/m/motion-m.js', '/focus.js', '/m/motion-m.css'];
  check('the service worker precaches the two modules, the desktop rules they import, and the sheet',
    need.every((f) => shell.includes(`'${f}'`)), need.filter((f) => !shell.includes(`'${f}'`)).join(' '));
}
{
  const app = read('m/app.js');
  check('m/app.js imports both layers', /import \{ startFocusM \} from '\.\/focus-m\.js'/.test(app)
    && /import \{ startMotionM, motionScreen \} from '\.\/motion-m\.js'/.test(app));
  check('…starts them with the shell, before the first screen',
    app.indexOf('startFocusM(deck)') > 0 && app.indexOf('startMotionM(deck)') > 0
    && app.indexOf('startMotionM(deck)') < app.indexOf('async function render()'));
  const r = app.slice(app.indexOf('async function render()'));
  check('…and asks arrival-or-redraw before the deck is emptied for each screen',
    r.indexOf('motionScreen()') > 0 && r.indexOf('motionScreen()') < r.indexOf("deck.innerHTML = ''"));
  check('…and moves the boot sheet on: "who" once its code runs, "up" at the first screen',
    /dataset\.boot === 'code'\) document\.documentElement\.dataset\.boot = 'who'/.test(app)
    && /if \(document\.documentElement\.dataset\.boot\) document\.documentElement\.dataset\.boot = 'up'/.test(r));
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  check('neither new module reads the skin attribute (the token decides)',
    ['m/focus-m.js', 'm/motion-m.js'].every((f) => !/dataset\.skin|data-skin|fleet\.skin/.test(code(read(f)))));
}

/* ══ the browser half ═════════════════════════════════════════════════════ */
const fixture = loadFixture();
check('the recorded API answers are on disk', !!fixture);
const browser = await launch();
const PROSE = 'p.m-cap, .m-lede p, p.hp-lede, .tg-sub, p.absb-why, .pf-inline p';
const ALL = [...SCREENS, ...DESKTOP_TABS.map((route) => ({ route }))];
/* What a screen says and how it is laid out, for one state of the pass. */
const MEASURE = (PROSE_) => {
  const deck = document.querySelector('#m .m-deck');
  const LAYOUT = 'div, section, article, ul, ol, dl, table, figure, header, footer, nav, aside, form, fieldset';
  const marks = [...deck.querySelectorAll('[data-fx]:not([data-fx="keep"])')];
  const name = (e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]}`;
  /* The toggles and the switch are the pass's own words, and the switch says
     the opposite thing in each state ("Show every word" / "Fold the
     explanations again"); everything else must be the same text. */
  const clone = deck.cloneNode(true);
  clone.querySelectorAll('.fx-more, .ak-focus').forEach((b) => b.remove());
  return {
    stray: marks.filter((m) => !m.closest('.m-fallback') && !m.matches(PROSE_) && !m.matches('.m-stat .s')).map(name),
    inRow: [...deck.querySelectorAll('.m-row [data-fx]:not([data-fx="keep"]), .m-row[data-fx]:not([data-fx="keep"]), '
      + '.m-rows[data-fx]:not([data-fx="keep"]), .m-stat .n[data-fx], .m-stat .l[data-fx], button[data-fx], a[data-fx]:not([data-fx="keep"])')].map(name),
    layout: marks.filter((m) => [...m.children].some((c) => c.matches(LAYOUT))).map(name),
    rows: [...deck.querySelectorAll('.m-row')].map((r) => Math.round(r.getBoundingClientRect().height)),
    toggles: [...document.querySelectorAll('#m .fx-more')].map((b) => ({ h: b.getBoundingClientRect().height, t: b.textContent })),
    hiddenAbsent: [...deck.querySelectorAll('[data-absent], .m-empty, .m-err, .tg-absent, .m-stale, p.absb-why')]
      .filter((e) => !e.checkVisibility() || e.dataset.fx === 'fold').map(name),
    folds: deck.querySelectorAll('[data-fx="fold"]').length,
    /* A toggle the desktop pass hung on the fallback container itself, a
       screenful below the line it opens (../focus.js focusIn looseHost). */
    loose: deck.querySelectorAll('.m-fallback > .fx-more').length,
    text: clone.textContent.replace(/\s+/g, ' ').trim(),
    height: deck.scrollHeight,
  };
};
const squash = (s) => s.replace(/\s+/g, '');
const VISIBLE = () => {
  const deck = document.querySelector('#m .m-deck');
  return [...deck.querySelectorAll(':scope > :not(.ak-applies)')].map((e) => e.innerText).join('\n')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !/^(Hide (notes|sources)|ⓘ .*|show every word|fold the explanations again)$/i.test(l));
};

console.log('\n3 · FOCUS on every screen: only prose, never a row, 44px toggles, every word one tap away');
if (run(3)) {
  const on = await phonePage(browser, { skin: 'arkiv', fixture });
  const off = await phonePage(browser, { skin: 'arkiv', fixture });
  await off.ctx.addInitScript(() => { try { localStorage.setItem('fleet.focus', 'off'); } catch { /* */ } });
  const bad = { stray: [], inRow: [], layout: [], rows: [], small: [], hidden: [], text: [], lost: [], loose: [], taller: [] };
  let folds = 0, toggles = 0, hOn = 0, hOff = 0, foldedScreens = 0;
  for (const s of ALL) {
    const name = s.as || s.route;
    const got = {};
    for (const [k, p] of [['on', on], ['off', off]]) {
      await p.open(s.route);
      if (s.tap) { await p.page.click(s.tap); await p.settle(); }
      got[k] = await p.page.evaluate(MEASURE, PROSE);
    }
    const a = got.on, b = got.off;
    if (a.stray.length) bad.stray.push(`${name}: ${a.stray.slice(0, 3).join(' ')}`);
    if (a.inRow.length) bad.inRow.push(`${name}: ${a.inRow.slice(0, 3).join(' ')}`);
    if (a.layout.length) bad.layout.push(`${name}: ${a.layout.slice(0, 3).join(' ')}`);
    if (JSON.stringify(a.rows) !== JSON.stringify(b.rows)) {
      const i = a.rows.findIndex((h, j) => h !== b.rows[j]);
      bad.rows.push(`${name}: row ${i} ${b.rows[i]}px → ${a.rows[i]}px (${a.rows.length} rows)`);
    }
    const small = a.toggles.filter((t) => t.h < 44);
    if (small.length) bad.small.push(`${name}: ${small.map((t) => `${t.t}:${Math.round(t.h)}`).join(' ')}`);
    if (a.hiddenAbsent.length) bad.hidden.push(`${name}: ${a.hiddenAbsent.slice(0, 3).join(' ')}`);
    if (a.text !== b.text) bad.text.push(name);
    if (a.loose) bad.loose.push(`${name}: ${a.loose}`);
    /* A fold pays for its 56px toggle: no screen is taller with the pass on. */
    if (a.height > b.height) bad.taller.push(`${name}: ${b.height} → ${a.height}px`);
    folds += a.folds; toggles += a.toggles.length; hOn += a.height; hOff += b.height;
    if (a.folds) foldedScreens += 1;
    /* Every word the pass-off screen shows, shown once every toggle is open. */
    const visOff = await off.page.evaluate(VISIBLE);
    await on.page.$$eval('#m .fx-more[aria-expanded="false"]', (bs) => bs.forEach((x) => x.click()));
    const visOn = squash((await on.page.evaluate(VISIBLE)).join(''));
    /* …and shut again: the next entry may be this same address with a tap
       (people → people+money), which the browser opens as a fragment
       navigation in the same document, open toggles and all. */
    await on.page.$$eval('#m .fx-more[aria-expanded="true"]', (bs) => bs.forEach((x) => x.click()));
    const lost = visOff.filter((l) => !visOn.includes(squash(l)));
    if (lost.length) bad.lost.push(`${name}: ${lost.slice(0, 2).map((l) => JSON.stringify(l.slice(0, 50))).join(', ')}`);
  }
  check(`the pass folds on most screens (${folds} folds on ${foldedScreens} of ${ALL.length}; ${toggles} toggles)`,
    folds > 40 && foldedScreens >= 20, `${folds} / ${foldedScreens}`);
  check(`…and the screens are shorter for it (${hOff} → ${hOn} px of deck over all screens)`, hOn < hOff * 0.95, `${hOn} vs ${hOff}`);
  check('no screen is taller with the pass on than off — a fold pays for its 44px toggle', !bad.taller.length, bad.taller.join(' | '));
  check('only the phone’s prose is ever marked (outside the fallback’s desktop tab)', !bad.stray.length, bad.stray.join(' | '));
  check('never a row, a list, a tile’s figure or label, a button or a link', !bad.inRow.length, bad.inRow.join(' | '));
  check('no marked element holds a block — a row is not a paragraph', !bad.layout.length, bad.layout.join(' | '));
  check('every row is exactly as tall with the pass on as off, on every screen', !bad.rows.length, bad.rows.join(' | '));
  check('every ⓘ toggle is a 44px target', toggles > 30 && !bad.small.length, bad.small.join(' | '));
  check('nothing that says a figure is absent, or why, is ever folded or hidden', !bad.hidden.length, bad.hidden.join(' | '));
  check('the pass removes no word (the deck’s text is the pass-off text)', !bad.text.length, bad.text.join(' '));
  check('every line the pass-off screen shows is shown once its toggles are open', !bad.lost.length, bad.lost.join(' | '));
  check('the fallback’s desktop tab is judged by the desktop’s pass, but no toggle hangs off the container itself',
    !bad.loose.length, bad.loose.join(' | '));
  check('no screen threw, and every call was answered from the recording', !on.errors.length && !on.misses.size && !off.errors.length,
    `${on.errors.slice(0, 2).join(' | ')} ${[...on.misses].slice(0, 3).join(' ')}`);
  await on.close(); await off.close();
}
if (run(3)) {
  /* The specific promises, read off one screen each. */
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('today');
  const t = await p.page.evaluate(() => {
    const vis = (e) => e && e.checkVisibility();
    const lead = document.querySelector('.m-card > h2 + p.m-cap[data-fx="lead"]');
    const ab = [...document.querySelectorAll('section.absence p.absb-why')];
    const foot = document.querySelector('.m-deck > .pf-inline');
    return {
      lead: lead ? { vis: vis(lead), clamp: getComputedStyle(lead).webkitLineClamp, h: lead.getBoundingClientRect().height } : null,
      absent: ab.map((e) => ({ fx: e.dataset.fx, vis: vis(e) })),
      foot: foot ? { basis: foot.querySelector('.pf-basis p')?.dataset.fx, principle: foot.querySelector('.pf-principle')?.dataset.fx,
        btn: foot.querySelector(':scope > .fx-more')?.textContent, shown: vis(foot.querySelector('.pf-principle')) } : null,
      applies: document.querySelector('.m-deck > .ak-applies') ? vis(document.querySelector('.m-deck > .ak-applies')) : 'none',
      statement: [...document.querySelectorAll('.m-deck > .m-lede p')].map((e) => ({ fx: e.dataset.fx, vis: e.checkVisibility() })),
    };
  });
  check('a section’s first caption stays on the face, cut to one line', t.lead && t.lead.vis && t.lead.clamp === '1' && t.lead.h < 30, JSON.stringify(t.lead));
  check('a statement’s sentence that carries figures stays whole (Today: "2,043 across 56 drivers and 52 vehicles…")',
    t.statement.length > 0 && t.statement.every((s) => s.fx === 'keep' && s.vis), JSON.stringify(t.statement));
  check('every reason in the absence band stays on the face (cut, never folded)', t.absent.length >= 2
    && t.absent.every((x) => x.fx !== 'fold' && x.vis), JSON.stringify(t.absent));
  check('the footer’s basis and principle fold under "ⓘ sources", as the desktop’s do',
    t.foot && t.foot.basis === 'fold' && t.foot.principle === 'fold' && t.foot.btn === 'ⓘ sources' && !t.foot.shown, JSON.stringify(t.foot));
  await p.open('live');
  const ap = await p.page.evaluate(() => ({ deck: document.querySelector('.m-deck > .ak-applies')?.checkVisibility() ?? null,
    text: document.querySelector('.m-deck > .ak-applies')?.textContent || '' }));
  await p.page.click('.ak-ctl');
  await p.page.waitForTimeout(400);
  const sheet = await p.page.evaluate(() => document.querySelector('.m-sheet .ak-applies')?.textContent || '');
  check('the sentence naming the ignored controls leaves the deck — and heads the sheet the control bar opens, word for word',
    ap.deck === false && ap.text.length > 20 && sheet === ap.text, JSON.stringify({ ap, sheet }));
  await p.open('safety');
  const why = await p.page.evaluate(() => [...document.querySelectorAll('.m-deck > .m-lede p')].map((e) => ({ fx: e.dataset.fx,
    vis: e.checkVisibility(), words: e.textContent.trim().split(/\s+/).length,
    btn: e.closest('.m-lede').querySelector(':scope > .fx-more')?.textContent || null })));
  check('…and one that only explains but is shorter than its toggle would be stays whole, with no toggle (Safety, 23 words)',
    why.length === 1 && why[0].fx === 'keep' && why[0].vis && why[0].btn === null && why[0].words < 25, JSON.stringify(why));
  await p.open('corporate');
  const band = await p.page.evaluate(() => ({ toggles: document.querySelectorAll('.m-deck > .m-stats > .fx-more').length,
    cut: [...document.querySelectorAll('.m-stat .s')].filter((s) => s.dataset.fx === 'clamp').length }));
  check('…nor does a tile band whose cuts would hide a handful of words (Corporate: no toggle row, no cut)',
    band.toggles === 0 && band.cut === 0, JSON.stringify(band));
  await p.open('payouts');
  const wire = await p.page.evaluate(() => (document.querySelector('.m-lede') || {}).innerText || '');
  check('To the bank’s statement keeps its comparison on the face, to the fils (test/payout_mobile reads the same)',
    /Our own figure for the week it settles/.test(wire) && /AED 217\.57/.test(wire), wire.slice(0, 140));
  await p.open('online-time');
  const dense = await p.page.evaluate(() => [...document.querySelectorAll('.m-stat .s')]
    .filter((s) => (s.textContent.match(/\d[\d,]*(?:\.\d+)?/g) || []).length >= 5)
    .map((s) => ({ fx: s.dataset.fx, text: s.textContent.slice(0, 40) })));
  check('a tile line that is mostly figures stays whole (Online time: "1 already on · 1 not in yet · …")',
    dense.length > 0 && dense.every((d) => d.fx === 'keep'), JSON.stringify(dense));
  await p.close();

  const old = await phonePage(browser, { skin: 'classic', fixture });
  await old.open('today');
  const o = await old.page.evaluate(() => ({ marks: document.querySelectorAll('#m [data-fx]').length,
    toggles: document.querySelectorAll('#m .fx-more').length }));
  check('the old skin’s phone is never marked: no mark, no toggle', o.marks === 0 && o.toggles === 0, JSON.stringify(o));
  await old.close();
}

console.log('\n4 · no layout shift: nothing painted before it is marked, and the shift with the pass on is the shift with it off');
if (run(4)) {
  /* Watched frame by frame: every node added to the deck is held, and at the
     next animation frame — which runs before that frame is painted — every
     prose block among them must already carry its mark. A pass that marked
     after a paint (the desktop's 120ms debounce) would show the block once
     unfolded and then fold it under the reader. */
  const WATCH = (PROSE_) => {
    window.__unmarked = 0; window.__seen = 0;
    const fresh = new Set();
    new MutationObserver((l) => {
      for (const r of l) for (const n of r.addedNodes) if (n.nodeType === 1 && n.closest?.('#m .m-deck')) fresh.add(n);
      if (fresh.size) requestAnimationFrame(() => {
        for (const n of fresh) {
          const blocks = [...(n.matches(PROSE_) ? [n] : []), ...n.querySelectorAll(PROSE_)]
            .filter((b) => !b.closest('.m-fallback') && document.contains(b));
          window.__seen += blocks.length;
          window.__unmarked += blocks.filter((b) => !b.dataset.fx).length;
        }
        fresh.clear();
      });
    }).observe(document, { childList: true, subtree: true });
  };
  const cls = () => {
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  };
  const runs = {};
  for (const focus of ['on', 'off']) {
    const p = await phonePage(browser, { skin: 'arkiv', fixture });
    await p.ctx.addInitScript(WATCH, PROSE);
    await p.ctx.addInitScript(cls);
    await p.ctx.addInitScript((f) => { try { localStorage.setItem('fleet.focus', f); } catch { /* */ } }, focus);
    /* Every answer half a second late, so the skeleton is up and the screen
       lands in front of the reader, as it does on a phone network. */
    await p.page.route('**/api/**', async (r) => { await new Promise((ok) => setTimeout(ok, 500)); await r.fallback(); });
    runs[focus] = {};
    for (const route of ['today', 'payouts', 'online-time']) {
      await p.open(route);
      await p.page.waitForTimeout(700);
      runs[focus][route] = await p.page.evaluate(() => ({ unmarked: window.__unmarked, seen: window.__seen, cls: +window.__cls.toFixed(4) }));
    }
    await p.close();
  }
  const on = Object.values(runs.on);
  check(`no prose block was ever on screen for a frame before its mark (${on.reduce((s, x) => s + x.seen, 0)} watched on 3 screens)`,
    on.every((x) => x.unmarked === 0) && on.reduce((s, x) => s + x.seen, 0) > 30, JSON.stringify(runs.on));
  /* Compared on the two screens that land in one piece. Online time lands in
     stages and its OWN shifts move with the deck's length (0.07 with the pass
     on, 0.07–0.37 off, run to run: m/app.js prepends the sentence naming the
     ignored controls after the screen has drawn, which the pass hides —
     docs/AUDIT.md "Focus and motion on the phone"), so a score there says
     nothing about the pass; the frame-by-frame watch above does. */
  check('the layout shift with the pass on is the layout shift with it off (Today, To the bank)',
    ['today', 'payouts'].every((r) => runs.on[r].cls <= runs.off[r].cls + 0.001), JSON.stringify({ on: runs.on, off: runs.off }));
}

console.log('\n5 · no loop: a settled screen is still');
if (run(5)) {
  const QUIET = () => new Promise((ok) => {
    let n = 0, labels = 0;
    const mo = new MutationObserver((l) => { for (const r of l) { n++; if (r.target.closest?.('.fx-more')) labels++; } });
    mo.observe(document.getElementById('m'), { childList: true, subtree: true, characterData: true });
    setTimeout(() => { mo.disconnect(); ok({ n, labels }); }, 3000);
  });
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'domcontentloaded' });
  await p.settle();
  await p.page.waitForTimeout(800);
  const q = await p.page.evaluate(QUIET);
  check('Today, both layers on, 3 s at rest: no mutation at all — no pass re-running, no label rewritten', q.n === 0, JSON.stringify(q));
  await p.open('payouts');
  await p.page.waitForTimeout(800);
  const q2 = await p.page.evaluate(QUIET);
  check('…nor on To the bank (six toggles)', q2.n === 0, JSON.stringify(q2));
  await p.close();
  /* The desktop's pass shares the label writer: before this change it rewrote
     every toggle every 120ms for as long as a page was open. */
  const d = await phonePage(browser, { skin: 'arkiv', fixture, width: 1440, height: 900 });
  await d.page.goto(`${ORIGIN}/?ui=desktop&skin=arkiv#target`, { waitUntil: 'domcontentloaded' });
  await d.settle();
  await d.page.waitForTimeout(1500);
  const dq = await d.page.evaluate(() => new Promise((ok) => {
    let labels = 0;
    const mo = new MutationObserver((l) => { for (const r of l) if (r.target.closest?.('.fx-more')) labels++; });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { mo.disconnect(); ok({ labels, toggles: document.querySelectorAll('.fx-more').length }); }, 3000);
  }));
  check('the DESKTOP’s toggles are not rewritten at rest either (was 144 rewrites in 3 s on #target)',
    dq.toggles > 0 && dq.labels === 0, JSON.stringify(dq));
  await d.close();
}

console.log('\n6 · the switch on the phone: More → This app');
if (run(6)) {
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.open('more');
  const sw = () => p.page.evaluate(() => {
    const b = document.querySelector('.ak-focus');
    return b && { text: b.textContent, pressed: b.getAttribute('aria-pressed'), h: Math.round(b.getBoundingClientRect().height),
      focus: document.documentElement.dataset.focus, stored: localStorage.getItem('fleet.focus'),
      first: [...document.querySelectorAll('.m-card')].find((c) => c.querySelector(':scope > h2')?.textContent === 'This app')
        ?.querySelector('button')?.textContent };
  });
  const a = await sw();
  check('This app carries the switch, a 48px button after the desktop one (still the card’s first)',
    a && a.text === 'Show every word' && a.pressed === 'false' && a.h >= 44 && a.first === 'Open the desktop version', JSON.stringify(a));
  if (a) {
  await p.page.click('.ak-focus');
  const b = await sw();
  await p.open('payouts');
  const shown = await p.page.evaluate(() => ({
    hidden: [...document.querySelectorAll('#m .m-deck [data-fx]')].filter((e) => !e.checkVisibility()).length,
    cut: [...document.querySelectorAll('#m .m-deck [data-fx]')].filter((e) => getComputedStyle(e).webkitLineClamp === '1').length,
    toggles: [...document.querySelectorAll('#m .fx-more')].filter((x) => x.checkVisibility()).length,
    applies: document.querySelector('.m-deck > .ak-applies')?.checkVisibility() }));
  check('tapped: every word is shown, remembered under the desktop’s key', b.focus === 'off' && b.stored === 'off'
    && b.text === 'Fold the explanations again' && b.pressed === 'true', JSON.stringify(b));
  check('…and on the next screen nothing is folded, cut or toggled, the control sentence back',
    shown.hidden === 0 && shown.cut === 0 && shown.toggles === 0 && shown.applies === true, JSON.stringify(shown));
  await p.open('more');
  await p.page.click('.ak-focus');
  const c = await sw();
  check('…and tapped again, folded again', c.focus === 'on' && c.stored === 'on' && c.text === 'Show every word', JSON.stringify(c));
  }
  await p.close();
}

/* Every fx-* class that goes on, once per element and kind. */
const LOG = () => {
  window.__fx = [];
  /* What an arriving block is animated with, read on the next frame — the
     fade is 340ms, shorter than a test's round trip to ask. */
  window.__arriveAnims = [];
  const t0 = performance.now();
  const seen = new WeakMap();
  new MutationObserver((l) => {
    for (const r of l) {
      const el = r.target;
      const now = new Set((el.getAttribute?.('class') || '').split(/\s+/));
      const was = new Set((r.oldValue || '').split(/\s+/));
      for (const k of ['fx-enter', 'fx-arrive', 'fx-tick', 'fx-unfold']) {
        if (now.has(k) && !was.has(k)) {
          const s = seen.get(el) || new Set();
          if (s.has(k)) continue;
          s.add(k); seen.set(el, s);
          setTimeout(() => s.delete(k), 50);
          window.__fx.push({ k, t: Math.round(performance.now() - t0), cls: String(el.className).split(' ')[0],
            text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) });
          if (k === 'fx-arrive') requestAnimationFrame(() => window.__arriveAnims.push(...el.getAnimations().map((a) => a.animationName)));
        }
      }
    }
  }).observe(document, { attributes: true, attributeOldValue: true, subtree: true, attributeFilter: ['class'] });
};
const anims = (page, re = /^akm-/) => page.evaluate((src) => document.getAnimations()
  .map((a) => a.animationName || '').filter((n) => new RegExp(src).test(n)), re.source);
const motionOn = async (p, route) => {
  await p.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#${route}`, { waitUntil: 'domcontentloaded' });
  await p.settle();
};

console.log('\n7 · the switch in a browser, and the boot sheet');
if (run(7)) {
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  const asked = [];
  p.page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await p.open('today');
  const off = await p.page.evaluate(() => ({ m: document.documentElement.dataset.motion || null, boot: document.documentElement.dataset.boot || null,
    busy: !!document.querySelector('#akBusy'), push: document.querySelector('.m-deck').classList.contains('push') }));
  check('under automation, nothing asked: no data-motion, no boot stamp, no busy element, the old slide as it was',
    off.m === null && off.boot === null && !off.busy && off.push, JSON.stringify(off));
  check('…and the phone’s sheet is not even requested', !asked.includes('/m/motion-m.css'));
  await motionOn(p, 'today');
  const on = await p.page.evaluate(() => ({ m: document.documentElement.dataset.motion, boot: document.documentElement.dataset.boot,
    busy: !!document.querySelector('#akBusy'), stored: localStorage.getItem('fleet.motion'),
    links: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href')) }));
  check('?motion=on: stamped, remembered, the busy element up, and the first screen ends the boot ("up")',
    on.m === 'on' && on.stored === 'on' && on.busy && on.boot === 'up', JSON.stringify(on));
  check('…the phone’s sheet is in, and m/arkiv-m.css is still the last stylesheet',
    on.links.includes('/m/motion-m.css') && on.links.at(-1) === '/m/arkiv-m.css', on.links.join(' '));
  check('…and the desktop’s motion.css is never requested on the phone', !asked.includes('/motion.css'));
  const gone = await p.page.evaluate(() => ['::before', '::after'].map((w) => getComputedStyle(document.getElementById('m'), w).content)
    .concat(getComputedStyle(document.body, '::before').content, getComputedStyle(document.body, '::after').content));
  check('…and on the first screen the boot sheet is gone: no mark, no rule, no words', gone.every((c) => c === 'none' || c === 'normal'), gone.join(' '));
  /* A promise that fails AFTER the first screen is the screen's business, not
     an opening that stopped: the watch index.html keeps for a failed boot
     ends at "up", or "The dashboard stopped opening" would be laid over a
     screen that opened. */
  await p.page.evaluate(() => { Promise.reject(new Error('late, after the first screen')); });
  await p.page.waitForTimeout(300);
  const late = await p.page.evaluate(() => ({ boot: document.documentElement.dataset.boot,
    label: getComputedStyle(document.getElementById('m'), '::before').content }));
  check('…and a failure after it does not say the opening stopped', late.boot === 'up' && (late.label === 'none' || late.label === 'normal'),
    JSON.stringify(late));
  const real = await p.page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    return { logo: r('.ak-word .logo'), ctl: r('.ak-ctl') };
  });
  await p.close();

  for (const theme of ['light', 'dark']) {
    const b = await phonePage(browser, { skin: 'arkiv', fixture, theme, frozen: false, hold: { '/m/app.js': 60000 } });
    await b.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'commit' });
    await b.page.waitForTimeout(900);
    const ps = (s, w) => b.page.evaluate(([s2, w2]) => {
      const c = getComputedStyle(document.querySelector(s2), w2);
      return { content: c.content, top: parseFloat(c.top), left: parseFloat(c.left), w: parseFloat(c.width), h: parseFloat(c.height),
        opacity: +c.opacity, bg: c.backgroundImage };
    }, [s, w]);
    const mark = await ps('body', '::before');
    const label = await ps('#m', '::before');
    const early = await ps('#m', '::after');
    check(`${theme}: the mark stands on the wordmark’s own box (within 0.5px), in this theme’s artwork`,
      Math.abs(mark.top - real.logo.y) < 0.5 && Math.abs(mark.left - real.logo.x) < 0.5
      && Math.abs(mark.w - real.logo.w) < 0.5 && Math.abs(mark.h - real.logo.h) < 0.5
      && (theme === 'dark' ? /mark-dark\.png/.test(mark.bg) : /mark\.png/.test(mark.bg) && !/mark-dark/.test(mark.bg)),
      JSON.stringify({ mark, logo: real.logo }));
    check(`${theme}: the label is up after its beat, on the control bar’s rule and in its 44px`,
      /Opening the dashboard/.test(label.content) && label.opacity === 1 && Math.abs(label.top - real.ctl.y) < 0.5 && label.h === 44,
      JSON.stringify(label));
    await b.page.waitForTimeout(3500);
    const late = await ps('#m', '::after');
    check(`${theme}: the sentence waits four seconds, then says what it waits for — the code`,
      early.opacity === 0 && late.opacity === 1 && /the dashboard’s code is still arriving/.test(late.content), `${early.opacity} → ${late.opacity} ${late.content}`);
    await b.close();
  }
  {
    const b = await phonePage(browser, { skin: 'arkiv', fixture });
    await b.page.route('**/api/auth/me*', () => { /* held: the server never says who */ });
    await b.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'domcontentloaded' });
    await b.page.waitForFunction(() => document.documentElement.dataset.boot === 'who', null, { timeout: 15000 }).catch(() => {});
    await b.page.waitForTimeout(4400);
    const w = await b.page.evaluate(() => ({ boot: document.documentElement.dataset.boot, shell: !!document.querySelector('#m .m-head'),
      label: getComputedStyle(document.getElementById('m'), '::before').content,
      line: getComputedStyle(document.getElementById('m'), '::after').content }));
    check('once the code runs the shell is up and the wait is the server’s — said over the empty bar and deck',
      w.boot === 'who' && w.shell && /Opening the dashboard/.test(w.label) && /waiting for the server to answer/.test(w.line), JSON.stringify(w));
    await b.close();
  }
  {
    const b = await phonePage(browser, { skin: 'arkiv', fixture });
    await b.page.route('**/m/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'throw new Error("boot")' }));
    await b.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'domcontentloaded' });
    await b.page.waitForTimeout(1200);
    const f = await b.page.evaluate(() => ({ boot: document.documentElement.dataset.boot,
      label: getComputedStyle(document.getElementById('m'), '::before').content,
      line: getComputedStyle(document.getElementById('m'), '::after').content,
      pen: getComputedStyle(document.body, '::after').content }));
    check('an opening that STOPPED says so, and the pen stops', f.boot === 'failed' && /stopped opening/.test(f.label)
      && /Reload the page/.test(f.line) && (f.pen === 'none' || f.pen === 'normal'), JSON.stringify(f));
    await b.close();
  }
}

console.log('\n8 · a screen arriving, a redraw, content after a wait');
if (run(8)) {
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.ctx.addInitScript(LOG);
  /* The screen's answers 1.8 s late — longer than the entrance (1.6 s), so
     what replaces the skeleton lands after it, as Today's 10 s cold open
     does on production; who-is-signed-in answers at once. */
  let slow = true;
  await p.page.route('**/api/**', async (r) => {
    if (slow && !r.request().url().includes('/api/auth/')) await new Promise((ok) => setTimeout(ok, 1800));
    await r.fallback();
  });
  await p.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'domcontentloaded' });
  await p.page.waitForSelector('#m .m-skel');
  const during = await p.page.evaluate(() => ({ enter: document.querySelector('.m-deck').classList.contains('fx-enter'),
    busy: document.documentElement.hasAttribute('data-busy') }));
  check('a screen arriving: the deck takes the entrance, and the busy line is on while its requests are out', during.enter && during.busy, JSON.stringify(during));
  await p.page.waitForFunction(() => !document.querySelector('#m .m-skel'), null, { timeout: 20000 });
  await p.page.waitForTimeout(120);
  const landing = await p.page.evaluate(() => window.__arriveAnims.slice());
  check('content that replaced the watched skeleton comes up (akm-fade, on the frame it lands)', landing.includes('akm-fade'), [...new Set(landing)].join(' '));
  check('…and the old skin’s 14px slide is gone under the layer', !(await anims(p.page, /^m-(push|pop)$/)).length);
  await p.settle();
  await p.page.waitForTimeout(2000);
  const after = await p.page.evaluate(() => ({ busy: document.documentElement.hasAttribute('data-busy'),
    left: document.querySelectorAll('.fx-enter, .fx-arrive, .fx-tick, .fx-unfold').length, fx: window.__fx.splice(0) }));
  check('content that replaced a watched skeleton was marked as arriving', after.fx.some((e) => e.k === 'fx-arrive'), JSON.stringify(after.fx.map((e) => e.k)));
  check('an arrival washes no figure', !after.fx.some((e) => e.k === 'fx-tick'), JSON.stringify(after.fx.filter((e) => e.k === 'fx-tick')));
  check('no motion class is left behind, and the busy line is off', after.left === 0 && !after.busy, JSON.stringify(after));
  check('at rest, nothing of the layer is running', !(await anims(p.page)).length, (await anims(p.page)).join(' '));

  slow = false;
  await p.page.click('.m-head .m-ico[title="Refresh"]');
  await p.settle();
  await p.page.waitForTimeout(600);
  const redraw = await p.page.evaluate(() => window.__fx.splice(0));
  check('a REDRAW of the same screen (the refresh button) replays no entrance, brings nothing up, washes nothing',
    redraw.length === 0, JSON.stringify(redraw));
  await p.page.evaluate(() => { location.hash = '#money'; });
  await p.page.waitForTimeout(150);
  const running = await anims(p.page);
  await p.settle();
  const nav = await p.page.evaluate(() => window.__fx.splice(0));
  check('a new address is a screen arriving again: blocks settle and rules are drawn (akm-in, akm-pen)',
    nav.some((e) => e.k === 'fx-enter') && running.includes('akm-in') && running.includes('akm-pen'), `${JSON.stringify(nav.map((e) => e.k))} ${[...new Set(running)].join(' ')}`);
  /* Opening folded notes brings them up. */
  await p.page.click('#m .fx-more');
  const unfold = await p.page.evaluate(() => window.__fx.splice(0));
  check('folded notes come up when opened', unfold.some((e) => e.k === 'fx-unfold'), JSON.stringify(unfold));
  check('no page error along the way', !p.errors.length, p.errors.join(' | '));
  await p.close();
}

console.log('\n9 · a figure that moved');
if (run(9)) {
  /* Today's minute refresh, shortened: the hour cards are redrawn in place
     from /api/target/hours, and the second answer has more revenue done. */
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.ctx.addInitScript(LOG);
  await p.ctx.addInitScript(() => {
    const si = window.setInterval;
    window.setInterval = (fn, ms, ...a) => si(fn, ms === 60000 ? 1500 : ms, ...a);
  });
  let calls = 0;
  await p.page.route('**/api/target/hours*', async (r) => {
    const hit = fixture.answers[keyOf(r.request().url())];
    if (!hit) return r.fallback();
    calls += 1;
    const j = JSON.parse(hit.body);
    if (calls > 1) j.revenue.done = +j.revenue.done + 100;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
  });
  await motionOn(p, 'today');
  const done = () => p.page.evaluate(() => [...document.querySelectorAll('.m-hours .tg-cell')]
    .find((c) => /Done so far/.test(c.querySelector('.tg-l')?.textContent || ''))?.querySelector('.tg-v')?.textContent.trim());
  const before = await done();
  await p.page.evaluate(() => window.__fx.splice(0));
  await p.page.waitForFunction((b) => {
    const c = [...document.querySelectorAll('.m-hours .tg-cell')].find((x) => /Done so far/.test(x.querySelector('.tg-l')?.textContent || ''));
    return c && c.querySelector('.tg-v').textContent.trim() !== b;
  }, before, { timeout: 10000 }).catch(() => {});
  await p.page.waitForTimeout(300);
  const now = await done();
  const fx = await p.page.evaluate(() => window.__fx.splice(0));
  const ticks = fx.filter((e) => e.k === 'fx-tick');
  check('the minute refresh moved "Done so far"', before && now && before !== now, `${before} → ${now}`);
  check('…and that figure, and only that figure, took the wash', ticks.length === 1 && ticks[0].text === now, JSON.stringify(ticks));
  await p.page.waitForTimeout(1700);
  const again = await p.page.evaluate(() => window.__fx.filter((e) => e.k === 'fx-tick').length);
  check('the next minute brought the same figure, and nothing was washed', again === 0, String(again));
  await p.close();
}
if (run(9)) {
  /* A redraw that brings new figures: the refresh button with this phone's
     copy of /api/kpis gone, and the live answer moved. */
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.ctx.addInitScript(LOG);
  let bump = 0;
  await p.page.route('**/api/kpis?period=*', async (r) => {
    const hit = fixture.answers[keyOf(r.request().url())];
    if (!hit) return r.fallback();
    const j = JSON.parse(hit.body);
    if (bump) j.trips = (+j.trips || 0) + bump;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
  });
  await motionOn(p, 'today');
  const figs = () => p.page.evaluate(() => [...document.querySelectorAll('#m .m-stat .n, #m .tg-v')].map((e) => e.textContent.trim()));
  const f0 = await figs();
  await p.page.evaluate(() => window.__fx.splice(0));
  bump = 7;
  await p.page.evaluate(() => { const s = JSON.parse(localStorage.getItem('fleet.swr.v1') || '{}'); for (const k of Object.keys(s)) if (k.startsWith('/api/kpis?period')) delete s[k]; localStorage.setItem('fleet.swr.v1', JSON.stringify(s)); });
  await p.page.click('.m-head .m-ico[title="Refresh"]');
  await p.settle();
  await p.page.waitForTimeout(300);
  const f1 = await figs();
  const changed = f1.filter((t, i) => t !== f0[i]);
  const ticks = (await p.page.evaluate(() => window.__fx.splice(0))).filter((e) => e.k === 'fx-tick');
  check('the redraw brought moved figures', changed.length > 0, JSON.stringify(changed));
  check('…every one of them was washed, and nothing else', changed.length > 0 && ticks.length === changed.length
    && changed.every((t) => ticks.some((e) => e.text === t)), JSON.stringify({ changed, ticks: ticks.map((e) => e.text) }));
  /* An ARRIVAL forgets: away to Money and back to Today with the figure moved
     again is a screen opened, not a figure that moved under the reader. */
  bump = 14;
  await p.page.evaluate(() => { const s = JSON.parse(localStorage.getItem('fleet.swr.v1') || '{}'); for (const k of Object.keys(s)) if (k.startsWith('/api/kpis?period')) delete s[k]; localStorage.setItem('fleet.swr.v1', JSON.stringify(s)); });
  await p.page.evaluate(() => { location.hash = '#money'; });
  await p.settle();
  await p.page.evaluate(() => { location.hash = '#today'; });
  await p.settle();
  await p.page.waitForTimeout(300);
  const f2 = await figs();
  const back = (await p.page.evaluate(() => window.__fx.splice(0))).filter((e) => e.k === 'fx-tick');
  check('a screen opened again with a moved figure washes nothing — an arrival forgets the last drawing',
    f2.some((t, i) => t !== f1[i]) && back.length === 0, JSON.stringify({ moved: f2.filter((t, i) => t !== f1[i]), back }));
  /* A segment the reader switched is not a figure moving. */
  await p.page.evaluate(() => { location.hash = '#people'; });
  await p.settle();
  await p.page.evaluate(() => window.__fx.splice(0));
  await p.page.click('.m-seg button[data-id="money"]');
  await p.settle();
  await p.page.click('.m-seg button:not([data-id="money"])');
  await p.settle();
  const seg = (await p.page.evaluate(() => window.__fx.splice(0))).filter((e) => e.k === 'fx-tick');
  check('switching People’s segment and back washes nothing', seg.length === 0, JSON.stringify(seg));
  await p.close();
}

console.log('\n10 · reduced motion');
if (run(10)) {
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await p.page.emulateMedia({ reducedMotion: 'reduce' });
  await p.ctx.addInitScript(LOG);
  await p.page.route('**/api/**', async (r) => { await new Promise((ok) => setTimeout(ok, 400)); await r.fallback(); });
  await p.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'domcontentloaded' });
  await p.page.waitForTimeout(250);
  /* The boot words' 1ms reveal (akm-show) is the one animation allowed for
     this reader: it is how words appear after a beat, not motion. */
  const running = (await anims(p.page)).filter((n) => n !== 'akm-show');
  await p.settle();
  await p.page.evaluate(() => { location.hash = '#money'; });
  await p.settle();
  const fx = await p.page.evaluate(() => window.__fx.splice(0));
  check('no class of the layer goes on, through an arrival, a wait and a new screen', fx.length === 0, JSON.stringify(fx));
  check('…and nothing of it moves', running.length === 0, running.join(' '));
  const sb = await p.page.evaluate(() => getComputedStyle(document.querySelector('.m-deck')).scrollBehavior);
  check('the deck jumps back to the top instead of scrolling there (m/arkiv-m.css §23)', sb === 'auto', sb);
  await p.close();
  const n = await phonePage(browser, { skin: 'arkiv', fixture });
  await n.open('today');
  const sbn = await n.page.evaluate(() => getComputedStyle(document.querySelector('.m-deck')).scrollBehavior);
  check('…while for every other reader it still scrolls smoothly', sbn === 'smooth', sbn);
  await n.close();
  const b = await phonePage(browser, { skin: 'arkiv', fixture, frozen: false, hold: { '/m/app.js': 60000 } });
  await b.page.emulateMedia({ reducedMotion: 'reduce' });
  await b.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'commit' });
  await b.page.waitForTimeout(900);
  const words = await b.page.evaluate(() => ({ content: getComputedStyle(document.getElementById('m'), '::before').content,
    opacity: +getComputedStyle(document.getElementById('m'), '::before').opacity,
    pen: document.getAnimations().map((a) => a.animationName).filter((n) => n === 'akm-boot-pen').length }));
  check('the boot sheet’s words still show, and its pen does not move', /Opening the dashboard/.test(words.content)
    && words.opacity === 1 && words.pen === 0, JSON.stringify(words));
  await b.close();
}

console.log('\n11 · touch: the press is felt, and every target stays 44px');
if (run(11)) {
  const p = await phonePage(browser, { skin: 'arkiv', fixture });
  await motionOn(p, 'more');
  /* THE PRESSED STATE, forced. Headless Chromium in a touch context applies
     :active for neither a held mouse button nor a held touch (both tried,
     2026-11-12: the button never matched :active), so the stylesheet's
     pressed rules are read with the state forced through DevTools — what is
     proved is what a pressed control looks like, not the gesture. */
  const cdp = await p.ctx.newCDPSession(p.page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '.m-card .m-btn' });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
  await p.page.waitForTimeout(150);
  const pressed = await p.page.evaluate(() => {
    const b = document.querySelector('.m-card .m-btn');
    const cs = getComputedStyle(b);
    return { translate: cs.translate, bg: cs.backgroundColor, dur: cs.transitionDuration };
  });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  await p.page.waitForTimeout(400);
  const rest = await p.page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('.m-card .m-btn'));
    const row = getComputedStyle(document.querySelector('.m-row'));
    return { translate: cs.translate, bg: cs.backgroundColor, dur: cs.transitionDuration, row: row.transition };
  });
  check('a pressed button gives 1px and takes the press colour in 60ms', pressed.translate === '0px 1px'
    && pressed.bg !== rest.bg && /^0\.06s/.test(pressed.dur), JSON.stringify({ pressed, rest }));
  check('…and lifts back over 280ms; a row’s press colour lifts the same way', rest.translate === 'none'
    && /^0\.28s/.test(rest.dur) && /background-color 0\.28s/.test(rest.row), JSON.stringify(rest));

  const small = [];
  for (const s of SCREENS) {
    await p.open(s.route);
    if (s.tap) { await p.page.click(s.tap); await p.settle(); }
    /* At rest: mid-entrance a block is translated a fraction of a pixel, and
       a 44px box reads 43.99998 or 44.00002 off the transform. */
    await p.page.waitForFunction(() => !document.querySelector('#m .fx-enter'), null, { timeout: 5000 }).catch(() => {});
    const mm = await p.page.evaluate(() => [...document.querySelectorAll('#m a[href], #m button, #m input:not([type=hidden]), #m select, #m textarea')]
      .filter((e) => !e.closest('.m-fallback'))
      .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 44; })
      .map((e) => `${e.tagName.toLowerCase()}.${(e.className || '').toString().split(' ')[0]}:${Math.round(e.getBoundingClientRect().height)}`));
    if (mm.length) small.push(`${s.as || s.route}: ${[...new Set(mm)].slice(0, 3).join(' ')}`);
  }
  check(`with both layers on, every control a thumb uses is at least 44px on every screen (${SCREENS.length})`, !small.length, small.join(' | '));
  check('no screen threw', !p.errors.length, p.errors.slice(0, 3).join(' | '));
  await p.close();
}

console.log('\n12 · first paint, and a layout the layer never touches');
if (run(12)) {
  /* Held back 1.5 s, the phone's sheet must not hold the first paint: it is
     appended, where m/arkiv-m.css — parser-written — holds it (phone_arkiv §1
     measures that one the same way). */
  const slow = await phonePage(browser, { skin: 'arkiv', fixture, frozen: false, hold: { '/m/motion-m.css': 1500 } });
  await slow.page.goto(`${ORIGIN}/?ui=phone&skin=arkiv&motion=on#today`, { waitUntil: 'domcontentloaded' });
  await slow.page.waitForTimeout(1700);
  const paint = await slow.page.evaluate(() => {
    const fcp = performance.getEntriesByType('paint').find((e) => e.name === 'first-paint');
    return { fp: fcp ? Math.round(fcp.startTime) : null };
  });
  check('with m/motion-m.css held back 1.5 s, the first paint does not wait for it', paint.fp != null && paint.fp < 1200, JSON.stringify(paint));
  await slow.close();
  /* The layer moves nothing in the layout: every block of the deck stands
     where it stands with the layer off, to the pixel, once at rest. */
  const boxes = () => [...document.querySelectorAll('#m .m-deck > *, #m .m-head, #m .ak-ctl, #m .m-tabs')]
    .map((e) => { const r = e.getBoundingClientRect(); return `${String(e.className).split(' ')[0]}:${Math.round(r.y)}:${Math.round(r.height)}`; });
  const off = await phonePage(browser, { skin: 'arkiv', fixture });
  const onp = await phonePage(browser, { skin: 'arkiv', fixture });
  const diff = [];
  for (const route of ['today', 'money', 'payouts', 'driver/drv-0', 'more']) {
    await off.open(route);
    await off.page.waitForTimeout(300);
    await motionOn(onp, route);
    await onp.page.waitForTimeout(2000);
    const a = await off.page.evaluate(boxes);
    const b = await onp.page.evaluate(boxes);
    if (JSON.stringify(a) !== JSON.stringify(b)) diff.push(`${route}: ${a.find((x, i) => x !== b[i])} vs ${b.find((x, i) => x !== a[i])}`);
  }
  check('at rest, with the layer on, every block stands where it stands with it off (5 screens)', !diff.length, diff.join(' | '));
  await off.close(); await onp.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
