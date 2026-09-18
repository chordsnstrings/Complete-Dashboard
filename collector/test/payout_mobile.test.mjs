/* THE PAYOUTS PAGE ON A PHONE.
   ═══════════════════════════════════════════════════════════════════════════
   Reported in eight words — "that specific page should have a mobile view" —
   after the page was widened to the whole register. It had a desktop layout
   shrunk to fit. MEASURED at 390px on production 2026-09-18:

     table                              columns   table width   its window
     Uber's wire against our own figure      9        1,172px       312px
     the provider's own books, day by day   10        1,007px       312px
     every transfer, by the date it arrived  6          668px       312px
     what each platform publishes            5          637px       312px

     document scrollWidth 413 against a 390 viewport — the whole page slid
     sideways; 724 table rows; the smallest type on screen 10.1px.

   `.tscroll` scrolling a wide table sideways with its first column pinned is
   the right answer for a table that is a LITTLE too wide. 1,172px into 312px
   is not a little: a reader sees a quarter of one column set and scrolls
   sideways through every one of 239 rows to read a row.

   This file is in a real browser because every defect above is a LAYOUT fact.
   A source-reading test can assert that `cards: true` was passed and would
   have passed against all three of the broken attempts this took — flex
   (anonymous flex items cannot take min-width:0; ten cells stuck out by up to
   76px, document 419px), then a two-track grid (the label track takes its
   max-content and "AGAINST THE OPENING BALANCE" is most of a phone; document
   448px), before label-above-value, which has no track to get wrong. Only the
   browser told the difference between those three.

   It serves the MOCK, not production: the fixtures are stable, the assertions
   are about layout rather than figures, and a test that needs the network is a
   test that is red whenever the network is.

   ── AND THE 390px SHELL IS NOT THE PHONE, WHICH THIS FILE FIRST ASSUMED ──
   api/public/index.html picks the phone bundle on
   `max-width:760px` AND `pointer:coarse`, and a Playwright page with a
   viewport and no `hasTouch` fails the second half — so everything §2 measures
   is the DESKTOP shell at 390px. That is a real surface (a narrow window, a
   tablet, and the `?ui=desktop` build the phone's own fallback button opens),
   and it is not what a phone gets.

   What a phone gets is `api/public/m/` — a separate bundle with its own
   screens — and `#payouts` had no screen in it. Verified on production
   2026-09-18 with `devices['iPhone 13']`: the register rendered as
   "Built for a bigger screen. This view is a wide table, and squeezing it onto
   a phone would lose the row you are reading," over a button to the desktop
   build. §4 is that half, and it is the half the request was about. */
import { chromium, devices } from 'playwright';
import { readFileSync } from 'node:fs';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ══ 1. THE SOURCE HALF — the page asks for cards, and folds what is long ══ */
console.log('\nthe page asks for cards and folds the long tables');
{
  const page = readFileSync(new URL('../api/public/payouts.js', import.meta.url), 'utf8');
  const asks = (page.match(/cards:\s*true/g) || []).length;
  check('all four of its tables ask for cards', asks === 4, `${asks} of 4`);
  /* A lead names the field the card is ABOUT — the same column .tscroll pins
     on the left at desktop width. Without one the first column is used, which
     is right by luck here and not a thing to rely on. */
  check('…and each names the column that heads the card',
    (page.match(/cardLead:\s*'/g) || []).length === 4,
    String((page.match(/cardLead:\s*'/g) || []).length));
  check('the three long tables are folded, never truncated',
    (page.match(/foldRows\(/g) || []).length === 3,
    String((page.match(/foldRows\(/g) || []).length));

  const css = readFileSync(new URL('../api/public/app.css', import.meta.url), 'utf8');
  /* The zebra override lost to `.tscroll table tbody tr:nth-child(even) td` on
     specificity the first time — four type selectors to three — and every even
     card came out shaded. Asserted by SHAPE, because the failure was invisible
     in the rule and obvious in the render. */
  check('the zebra override is written to beat the rule it overrides',
    /\.tcards \.tscroll table tbody tr:nth-child\(even\) td\{background:none\}/.test(css),
    'the short selector is back and even cards will be shaded');
  /* A GUARD, and asserted as one. It did not fix the 419px scroll — that was
     the card cells — and measured with the line removed the document is 390px
     either way today. It is kept because a scroller with a content floor in a
     grid or flex parent is a trap this stylesheet has been caught by twice,
     and a guard nobody asserts is a guard that gets deleted as dead. */
  check('the chart scroller keeps its shrink guard',
    /\.chartscroll\{[^}]*min-width:0/.test(css), 'min-width:0 is missing');
}

/* ══ 2. THE BROWSER HALF ═══════════════════════════════════════════════════ */
const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

const look = async (width, height) => {
  const p = await browser.newPage({ viewport: { width, height } });
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${base}/#payouts`, { waitUntil: 'networkidle' });
  await p.waitForTimeout(1200);
  const out = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const blocks = [...document.querySelectorAll('.tcards')];
    /* A cell whose content sticks out of the card it is in. The three broken
       attempts each produced a handful of these and nothing else looked
       wrong — which is why this is the assertion and not the screenshot. */
    const spill = [];
    for (const b of blocks) {
      for (const e of b.querySelectorAll('td, td *')) {
        if (e.scrollWidth - e.clientWidth > 2 && e.clientWidth > 0) {
          spill.push(`${e.tagName.toLowerCase()} +${e.scrollWidth - e.clientWidth}px `
            + `"${(e.textContent || '').trim().slice(0, 28)}"`);
        }
      }
    }
    const firstRow = (b) => b.querySelector('tbody tr');
    const labelled = blocks.map((b) => {
      const tr = firstRow(b);
      if (!tr) return null;
      const tds = [...tr.children];
      const lead = tds.filter((td) => td.classList.contains('cardlead')).length;
      const withLabel = tds.filter((td) => td.hasAttribute('data-label')).length;
      const heads = [...b.querySelectorAll('thead th')].map((th) => th.textContent.replace(/[↑↓]/g, '').trim());
      const labels = tds.filter((td) => td.hasAttribute('data-label'))
        .map((td) => td.getAttribute('data-label'));
      /* The value's own element. Without it the content is an anonymous flex
         item, which cannot be given min-width:0 — see the block comment in
         ui.js. Counted rather than assumed, because "the span is there" and
         "the span is on every cell" are different claims. */
      const vals = tds.filter((td) => td.querySelector(':scope > .cardval')).length;
      /* A SHORT field must put its label and its value on ONE line. Stacking
         them was the layout before this: correct, and 298–470px per card,
         which made the page 26,559px on production. Measured by baseline, not
         by height: same line means same offsetTop. */
      const shortField = tds.find((td) => /^(fleet|platform)$/i.test(td.getAttribute('data-label') || ''));
      let sameLine = null;
      if (shortField) {
        const v = shortField.querySelector(':scope > .cardval');
        sameLine = v ? Math.abs(v.getBoundingClientRect().top
          - shortField.getBoundingClientRect().top) < 6 : false;
      }
      return { cells: tds.length, lead, withLabel, vals, sameLine,
        /* Every label is one of the table's own column headings — the guard
           against a second list of labels drifting out of step. */
        allFromHeads: labels.every((l) => heads.includes(l)),
        rowW: Math.round(tr.getBoundingClientRect().width),
        display: getComputedStyle(tr).display,
        /* The heading row stays in the DOM: sorting, aria-sort and data-key
           are all still there for a screen reader and for the page tooling. */
        theadInDom: !!b.querySelector('thead'),
        theadVisible: b.querySelector('thead')
          ? b.querySelector('thead').getBoundingClientRect().height > 4 : false };
    }).filter(Boolean);
    const sc = document.querySelector('.chartscroll');
    return {
      vw,
      docScroll: document.documentElement.scrollWidth,
      height: document.body.scrollHeight,
      blocks: blocks.length,
      spill: spill.slice(0, 8),
      labelled,
      chart: sc ? { w: Math.round(sc.getBoundingClientRect().width), scrollW: sc.scrollWidth } : null,
      caption: !!document.querySelector('.phone-only'),
      captionShown: document.querySelector('.phone-only')
        ? getComputedStyle(document.querySelector('.phone-only')).display !== 'none' : false,
    };
  });
  await p.close();
  return { ...out, errs };
};

console.log('\nat 390px the page is a stack of cards and does not slide sideways');
const ph = await look(390, 844);
/* THE HEADLINE ASSERTION. 413px against a 390px viewport was the reader's
   first experience of this page: the whole document slid. */
check('the document does not scroll sideways', ph.docScroll <= ph.vw,
  `scrollWidth ${ph.docScroll} against a ${ph.vw} viewport`);
check('all four tables are in card mode', ph.blocks === 4, String(ph.blocks));
check('every card fits inside the page', ph.labelled.every((b) => b.rowW <= ph.vw),
  JSON.stringify(ph.labelled.map((b) => b.rowW)));
check('the rows are laid out as blocks, not table rows',
  ph.labelled.every((b) => b.display === 'block'),
  JSON.stringify(ph.labelled.map((b) => b.display)));
check('no cell spills out of the card it is in', ph.spill.length === 0,
  ph.spill.join(' | '));
/* A value with no label is exactly what the sideways scroll was destroying. */
check('every cell but the lead carries its own column heading',
  ph.labelled.every((b) => b.withLabel === b.cells - 1 && b.lead === 1),
  JSON.stringify(ph.labelled.map((b) => `${b.withLabel}+${b.lead} of ${b.cells}`)));
check('…and every label is one of that table’s own headings',
  ph.labelled.every((b) => b.allFromHeads), 'a label does not match any column');
check('the heading row is hidden but still in the DOM for a screen reader',
  ph.labelled.every((b) => b.theadInDom && !b.theadVisible),
  JSON.stringify(ph.labelled.map((b) => `${b.theadInDom}/${b.theadVisible}`)));
check('every labelled cell wraps its value in an element that can shrink',
  ph.labelled.every((b) => b.vals === b.cells - 1),
  JSON.stringify(ph.labelled.map((b) => `${b.vals} of ${b.cells - 1}`)));
check('a short field puts its label and value on one line, not two',
  ph.labelled.every((b) => b.sameLine !== false),
  JSON.stringify(ph.labelled.map((b) => b.sameLine)));
check('the chart keeps a bar width and scrolls inside the panel',
  ph.chart && ph.chart.w <= ph.vw && ph.chart.scrollW > ph.chart.w,
  JSON.stringify(ph.chart));
check('…and says so, in a line that only shows where it is true',
  ph.caption && ph.captionShown, `${ph.caption}/${ph.captionShown}`);
check('no JS errors', ph.errs.length === 0, ph.errs.join(' ; '));

/* ══ 3. AND NOTHING CHANGES ON A DESKTOP ══════════════════════════════════
   The whole point of an opt-in that lives in a media query: the table a
   desktop reader has been using is the same table, sortable the same way. */
console.log('\nat 1280px it is the same table it always was');
const dk = await look(1280, 900);
check('the rows are table rows again',
  dk.labelled.every((b) => b.display === 'table-row'),
  JSON.stringify(dk.labelled.map((b) => b.display)));
check('the column headings are visible again',
  dk.labelled.every((b) => b.theadVisible), 'the headings stayed hidden');
check('the chart fills the panel rather than scrolling',
  dk.chart && dk.chart.scrollW <= dk.chart.w + 2, JSON.stringify(dk.chart));
check('…and the narrow-screen caption is not printed', !dk.captionShown, 'it is showing');
check('the page does not scroll sideways there either', dk.docScroll <= dk.vw,
  `${dk.docScroll} against ${dk.vw}`);
check('no JS errors', dk.errs.length === 0, dk.errs.join(' ; '));

/* ══ 4. THE PHONE BUNDLE — the surface a real phone actually loads ═══════
   Not a narrow desktop window. `devices['iPhone 13']` carries hasTouch, which
   is what makes index.html choose /m/app.js, and without it this whole section
   would silently assert the same thing §2 does. */
console.log('\nthe PWA has a payouts screen of its own, not the fallback');
{
  const { SCREENS, TABS, titleFor } = await import('../api/public/m/screens.js');
  check('the phone bundle registers a payouts screen',
    typeof SCREENS.payouts === 'function', String(typeof SCREENS.payouts));
  /* Without this it renders and is unreachable — the router would find it only
     from a typed address. */
  check('…and the Money tab owns the route, so the tab bar lights up on it',
    (TABS.find((t) => t.id === 'money')?.owns || []).includes('payouts'),
    JSON.stringify(TABS.find((t) => t.id === 'money')?.owns));
  /* A header reading "payouts" is the router's word for the page. And not
     "Payouts": everywhere else in this product a payout is a DRIVER's payout,
     and this screen is the wire that reached the company's bank. */
  const t = titleFor('payouts');
  check('…and it is named for the reader, not for the router',
    t.title === 'To the bank' && !/bigger screen/.test(t.sub), JSON.stringify(t));

  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(`${base}/#payouts`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2200);
  const m = await p.evaluate(() => ({
    shell: document.documentElement.dataset.ui,
    coarse: matchMedia('(pointer: coarse)').matches,
    text: document.body.innerText,
    /* The LEDE'S OWN text. Asserting the fils against the whole page passed
       with a rounded lede, because the comparison rows further down print the
       same figures — a test that claimed more than it proved, caught by
       reverting the thing it was supposed to be guarding. */
    lede: (document.querySelector('.m-lede') || {}).innerText || '',
    cards: document.querySelectorAll('.m-card').length,
    ledes: document.querySelectorAll('.m-lede').length,
    stats: document.querySelectorAll('.m-stat').length,
    rows: document.querySelectorAll('.m-row').length,
    doc: document.documentElement.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  await ctx.close();

  /* If this is false the rest of the section is measuring the desktop shell,
     which is exactly the mistake this section exists to stop repeating. */
  check('the phone shell is the one under test', m.shell === 'phone' && m.coarse,
    `${m.shell} / coarse=${m.coarse}`);
  check('it no longer refuses the screen', !/Built for a bigger screen/.test(m.text),
    'the fallback is still rendering');
  check('…it leads with the last wire and what it was compared against',
    /Our own figure for the week it settles/.test(m.text), m.text.slice(0, 120));
  /* THE FILS. The claim is a difference of 217.57 against 111,179.66, and
     money() rounds to whole dirhams unless asked not to — rounded, the
     difference survives and the check a reader could do by hand does not. */
  check('…to the fils, because the difference is the point',
    /AED 111,179\.66/.test(m.lede) && /AED 217\.57/.test(m.lede)
      && /AED 110,962\.09/.test(m.lede),
    (m.lede.match(/AED [\d,]+\.?\d*/g) || []).join(' '));
  check('…and it renders the phone’s own components, not a desktop table',
    m.cards >= 2 && m.ledes === 1 && m.stats >= 2 && m.rows >= 2,
    `cards=${m.cards} ledes=${m.ledes} stats=${m.stats} rows=${m.rows}`);
  check('the phone screen does not scroll sideways either', m.doc <= m.vw,
    `${m.doc} against ${m.vw}`);
  /* A transfer that cannot be compared gets a REASON, and one per kind rather
     than one per row — the desktop printed fifty identical notes before the
     route learned to name the kind. */
  check('…and says why a transfer could not be compared, without a zero',
    /cannot be compared, and that is not a difference of zero/.test(m.text),
    'the absence sentence is missing');
  check('no JS errors', errs.length === 0, errs.join(' ; '));
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
