/* #forecast — the page where a dishonest number is easiest to draw.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT, measured on production 2026-09-22 against the month in progress,
   which is the only out-of-sample evidence this page has:

     September 2026, forecast by the straight line   14,700 (11,100–18,300)
     September 2026, first 21 whole days             16,095
     the same 21 days of September 2025              19,867
     September 2026 completing on last year's shape  ~23,975

   The page was publishing an interval for a month that was already outside it,
   and `in_progress.within_interval` already said `false` in the response
   nobody was reading it from. The straight line has no seasonal term and the
   regime it is fitted to has never contained an October, so it cannot have
   one.

   What this file holds down, in the rendered DOM rather than in the model:

   1. EVERY COMPARISON IS WITH THE SAME MONTH A YEAR EARLIER. Not with last
      month, anywhere the page makes a comparison.
   2. ACTIVE VEHICLES THEN AND NOW, AND WORK PER VEHICLE, ARE BOTH ON SCREEN
      AND CANNOT READ THE SAME. A fleet that shrank 14% while each car sped up
      15% must not render as "bookings flat".
   3. A PAIR THAT IS NOT A COMPARISON IS SHOWN AS REFUSED, WITH THE REASON.
      Absent with a reason, never as a 481% rise.
   4. THE TOURISM REGRESSOR CARRIES ITS r², AND ITS GAPS CARRY THEIR REASON.
   5. THE LOSING SCORE IS PRINTED. The new model does not currently win, and
      the page says so in words.
   6. THE MODEL-WRITTEN CALENDAR IS LABELLED AS SUCH, everywhere it appears.
   7. THE INTERVAL IS DRAWN. Every forecast bar carries a whisker.

   THIS FILE FOUND A REAL RENDERING BUG ON ITS FIRST RUN, which is the reason
   to write the assertion rather than the panel. The comparable table filtered
   on `r.ratio != null` alone — and a REFUSED pair still carries its ratio,
   because the route computes it before deciding the pair is not a comparison
   and serves it so the refusal can quote the number it declined to publish. So
   January and February 2026 rendered in the comparable table at +601% and
   +559%, immediately above a note explaining that those months cannot be
   compared. Every other assertion on that panel was green with both months in
   it; only "a refused month is not in the comparable table at all" could see it.

   PROVED BY REVERT — each guard removed, the page reloaded, and the failures
   below are the ones that CAME BACK, transcribed from the output. Baseline 36
   passed, 0 failed.

   i.   The year-on-year panel is not rendered (`if (yoy.length)` → `if (false)`):
        22 passed, 13 FAILED, beginning
          ✗ the year-on-year panel is rendered at all
              ["fc-inprogress","fc-tourism","fc-months","fc-scores","fc-calendar"]
          ✗ every month is compared with the same month a year earlier  []
          ✗ active vehicles then and now are both on screen  []
          ✗ and bookings per active vehicle, both sides  []

        THE FIRST TWO ATTEMPTS AT THIS REVERT PRODUCED NO OUTPUT AT ALL. The
        file waited on `[data-panel="fc-yoy"] table` — the thing under test —
        so removing it timed the wait out after 30s and died on a Playwright
        stack trace with no "N passed, M failed" line, which test/run-all.mjs
        counts as a broken file with nothing naming the cause. Then the row
        extraction dereferenced `ts[0]` on an empty list and did it again. The
        wait is on `fc-months` now, which renders on any successful response,
        and the panel under test is ASSERTED rather than waited for.

   ii.  The comparable table filters on the ratio alone
        (`r.ratio != null && r.comparable !== 'no'` → `r.ratio != null`):
          ✗ a refused month is not in the comparable table at all
              ["Jan 26","Feb 26","May 26","Jun 26","Jul 26 mixed channels",
               "Aug 26 part month mixed channels"]
        34 passed, 1 FAILED. This is the bug above, reproduced.

   iii. The scoreboard stops printing the losing mean error:
          ✗ the page names the most accurate method, even when it is not the
            new one
          ✗ and prints every method's error, including the new model's
          ✗ and refuses to tell the reader which to believe
        32 passed, 3 FAILED.

   iv.  The calendar's provenance warning is dropped:
          ✗ the model-written calendar says it is not a measurement
          ✗ and names the model that wrote it
          ✗ and states that no figure on the page is adjusted by it
        32 passed, 3 FAILED.

   v.   The whiskers are dropped from the forecast bars (`lo`/`hi` removed from
        the barChart options, which is how a point estimate gets drawn as a
        solid bar — this page shipped exactly that once):
          ✗ forecast bars carry a whisker rather than being solid points  0
        34 passed, 1 FAILED. */
import { chromium } from 'playwright';
import { app } from '../mockapi.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const srv = app.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

/* reducedMotion: THE HEADLINE NUMBERS COUNT UP over 620ms (countUp in
   api/public/app.js), and an assertion made mid-animation reads a number that
   was never in the data — measured elsewhere in this suite as 419.72 … 419.99
   for an API answer of exactly 420. Playwright sets the media query the
   product already honours, so the tiles carry their real value from the first
   paint, deterministically, in a state a real reader can be in. */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, reducedMotion: 'reduce' });
const page = await ctx.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
await page.goto(`${base}/#forecast`, { waitUntil: 'networkidle' });
/* Scoped to #view. `.tabs` is TWO different bars and the shell's one is on
   screen before the page has fetched anything, so an unscoped wait resolves on
   the first paint and every assertion after it races the page it was meant to
   wait for. Same shape of mistake here: wait for a panel this page owns.

   And it waits for `fc-months`, NOT for `fc-yoy`, although fc-yoy is what most
   of this file is about. fc-months renders on any successful response; fc-yoy
   renders only when the year-on-year data is there. Waiting on the thing under
   test means that removing it makes this file TIME OUT rather than fail — 30
   seconds, a Playwright stack trace, no "N passed, M failed" line, and
   test/run-all.mjs counting a file as broken with nothing naming the cause.
   Proved by doing it: reverting the fc-yoy panel produced no output at all.
   Wait for something that is always there, then ASSERT the thing under test
   exists. */
await page.waitForSelector('#view [data-panel="fc-months"] table', { timeout: 30000 });
const body = await page.evaluate(() => document.body.innerText);

check('the year-on-year panel is rendered at all',
  (await page.$$('#view [data-panel="fc-yoy"] table')).length > 0,
  JSON.stringify(await page.$$eval('#view [data-panel]', (e) => e.map((x) => x.dataset.panel))));

console.log('\nno comparison with last month, anywhere');

/* ── 1 & 2. the year-on-year table ──────────────────────────────────── */
const head = await page.$$eval('[data-panel="fc-yoy"] table thead th',
  (th) => th.map((e) => e.textContent.trim()));
check('every month is compared with the same month a year earlier',
  head.includes('Month') && head.includes('vs') && head.filter((h) => h === 'Then').length >= 2,
  JSON.stringify(head));
check('active vehicles then and now are both on screen',
  head.includes('Vehicles') && head.includes('Fleet'), JSON.stringify(head));
check('and bookings per active vehicle, both sides',
  head.includes('Per vehicle') && head.includes('Each car'), JSON.stringify(head));
check('the page names which of the two moved the number',
  head.includes('What moved it'), JSON.stringify(head));

/* The FIRST table only. This panel holds two: the months that are a
   comparison, and beneath them the months that are refused with their reason.
   An unscoped `[data-panel="fc-yoy"] table tbody tr` returns both, so the
   assertion that a refused month is absent from the comparable table passed
   over a list that contained it.

   Indexed rather than selected. `table:nth-of-type(1)` does NOT narrow this:
   tableFrom wraps every table in its own `div.tscroll`, so each table is the
   only one of its type inside its own parent and both match. `.tscroll:nth-of-type(n)`
   fails the same way in the other direction — nth-of-type counts by element
   type, and the panel body's div children are the two scrollers AND the note
   between them. */
const rows = await page.$$eval('[data-panel="fc-yoy"] table', (ts) =>
  (ts[0] ? [...ts[0].querySelectorAll('tbody tr')] : [])
    .map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent.trim())));
/* THE ROW THE WHOLE DECOMPOSITION EXISTS FOR. June 2026 is 14,033 bookings
   against 13,400 — up 4.7%, which reads as "roughly flat" — over a fleet that
   is 17% SMALLER, each vehicle doing 26% MORE. A page showing only the total
   says nothing about either. */
{
  const jun = rows.find((r) => /Jun 26/.test(r[0]));
  check('a month that looks flat in total shows both halves moving hard',
    jun && /\+4\.7%/.test(jun.join(' ')) && /\u221217\.1%/.test(jun.join(' '))
    && /\+26\.3%/.test(jun.join(' ')), JSON.stringify(jun));
  check('and says which half moved it',
    jun && /work per vehicle/.test(jun.join(' ')), JSON.stringify(jun));
  const may = rows.find((r) => /May 26/.test(r[0]));
  check('a month where the FLEET moved says that instead',
    may && /fleet size/.test(may.join(' ')), JSON.stringify(may));
}
check('the caption says active vehicles are plates that carried a booking',
  /distinct plates that carried a booking that month/.test(body), '');
check('and that the three columns multiply out to the change',
  /multiply out to the Change column/.test(body), '');

/* ── 3. the refusals ────────────────────────────────────────────────── */
check('a pair that is not a comparison is refused, with the reason',
  /cannot be compared with their year-ago month/.test(body)
  || /cannot be compared with its year-ago month/.test(body), body.slice(0, 200));
check('and the refusal names the channel that differs',
  /uber carried 86\.1% of this month and carried nothing in 2025-01/.test(body), '');
check('the page says what the number it refused to print would have been',
  /481% rise that is a fact about the month we started collecting Uber/.test(body), '');
/* The refusal must not read as permanent. A channel missing from the earlier
   month can be one we had not started collecting OR a collection gap under
   repair — Bolt's is being fixed separately as this lands — and the verdict is
   recomputed from the mix on every load, so it lifts by itself. A page that
   said "Uber's record starts in April 2025" would be a fixed date that goes
   stale the day the gap closes. */
check('and says the refusal lifts by itself when the earlier month gains the channel',
  /the refusal lifts by itself/.test(body) && /nothing here is a fixed list of dates/.test(body), '');
/* The refused months must NOT appear as a ratio in the comparison table. */
check('a refused month is not in the comparable table at all',
  !rows.some((r) => /Jan 26|Feb 26/.test(r[0])), JSON.stringify(rows.map((r) => r[0])));

/* ── 4. tourism, with its fit and its gaps ──────────────────────────── */
console.log('\ntourism as a regressor, with its fit stated');
const tour = await page.$eval('[data-panel="fc-tourism"]', (e) => e.innerText);
check('the r² leads, rather than the relationship being implied',
  /r² 0\.668/.test(tour), tour.slice(0, 260));
check('the fit that is SUPPOSED to be weak is printed too',
  /r² 0\.281/.test(tour) && /fleet size is a decision, not a season/.test(tour), '');
check('a month Dubai did not publish renders "not published", never a number',
  /not published/.test(tour), '');
check('and the aggregate it WAS published inside is kept as an aggregate',
  /February to July 2026, together/.test(tour)
  && /says nothing about any one of them/.test(tour), '');
check('the hand-transcribed series shows that it reconciles',
  /H1 2025 9,880,000 against 9,880,000 published \(agrees\)/.test(tour), '');
check('and the break has a cause that is the city’s, not the fleet’s',
  /hotel occupancy fell to about 36%/.test(tour), '');

/* ── 5. the losing score is printed ─────────────────────────────────── */
console.log('\nthe scoreboard, printed whichever way it falls');
const sc = await page.$eval('[data-panel="fc-scores"]', (e) => e.innerText);
check('the page names the most accurate method, even when it is not the new one',
  /the straight line is the most accurate/.test(sc), sc.slice(0, 300));
check('and prints every method’s error, including the new model’s',
  /Year on year 13\.8%/.test(sc) && /straight line 12\.7%/.test(sc), sc.slice(0, 400));
check('and refuses to tell the reader which to believe',
  /does not tell you which to believe, because it cannot demonstrate it/.test(sc), '');

/* ── 6. the model-written calendar is labelled ──────────────────────── */
console.log('\na model may name an event and may not move a number');
const cal = await page.$eval('[data-panel="fc-calendar"]', (e) => e.innerText);
check('the model-written calendar says it is not a measurement',
  /This panel is not a measurement/.test(cal), cal.slice(0, 220));
check('and names the model that wrote it', /GLM 5\.2/.test(cal), cal.slice(0, 220));
check('and states that no figure on the page is adjusted by it',
  /none of them is multiplied, shifted or weighted by anything below/.test(cal), '');
check('where it disagrees with the record, the record is said to win',
  /Where the two disagree the measurement wins/.test(cal), '');

/* ── 7. the interval is DRAWN, not mentioned ────────────────────────── */
console.log('\nthe interval is drawn');
/* barChart draws a whisker only where lo and hi are both present. A point
   estimate rendered as a solid bar is the exact failure this page's own header
   says it exists to avoid, and it shipped that way once. */
const whiskers = await page.$$eval('#view svg line',
  (ls) => ls.filter((l) => !l.classList.contains('gl')).length);
check('forecast bars carry a whisker rather than being solid points',
  whiskers > 0, String(whiskers));
check('the month-by-month table carries BOTH models side by side',
  (await page.$$eval('[data-panel="fc-months"] table thead th',
    (th) => th.map((e) => e.textContent.trim())))
    .filter((h) => /Year on year|Straight line|Same month last year/.test(h)).length === 3,
  '');
check('a forecast month with no honest base renders absent, not short',
  /absent/.test(await page.$eval('[data-panel="fc-months"]', (e) => e.innerText)), '');
check('and a base month inside the current regime is flagged',
  /base post-break/.test(await page.$eval('[data-panel="fc-months"]', (e) => e.innerText)), '');

/* ── the month in progress, and the day still being collected ───────── */
const ipTxt = await page.$eval('[data-panel="fc-inprogress"]', (e) => e.innerText);
check('the run rate says it was taken over whole days only',
  /whole days only/.test(ipTxt), ipTxt.slice(0, 400));
check('and the larger, wrong denominator is named rather than hidden',
  /which is the larger number and the wrong denominator/.test(ipTxt), '');
/* Case-insensitive: a .kpi label is uppercased by the stylesheet, and
   innerText reports what the reader sees rather than what the template wrote. */
check('the month in progress is also scored against the same days last year',
  /Against the same 21 days of Aug 25/i.test(ipTxt), ipTxt.slice(0, 500));

/* ── nothing threw ──────────────────────────────────────────────────── */
check('the page rendered with no script error', errs.length === 0, errs.join(' | '));

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
