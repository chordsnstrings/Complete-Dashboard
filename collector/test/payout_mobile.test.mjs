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
   test that is red whenever the network is. */
import { chromium } from 'playwright';
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

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
