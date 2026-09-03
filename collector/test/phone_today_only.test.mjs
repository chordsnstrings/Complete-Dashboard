/* ── "0 bookings a day" over 523 bookings ──────────────────────────────────
   An operator sent a screenshot of the phone Today screen:

     0 bookings a day
     523 across 98 drivers and 85 vehicles. 0 a day over the 0 days that are
     complete. Today has 523 so far and is still being collected.
     BOOKINGS 523 · 0 a day
     Bookings a day — 0 complete days, today excluded — it is still filling

   On a TODAY-ONLY window there are no COMPLETE days by construction: today is
   excluded because it is still filling. So the per-day rate has no denominator
   — and api/public/m/screens.js read `days ? … : 0` and printed that 0 as a
   measurement, three times, above a tile saying 523.

   The desktop has been right about this since api/public/app.js: when today is
   the only day in the window it is not dropped, because then it is the entire
   question — the figure becomes what today has taken so far and names the
   Dubai minute it stopped at. The phone was ported without the rule.

   These assertions are the rule, on the phone, in both directions: a window
   with whole days still gets a daily rate, and a window without one says so
   instead of saying zero. */
import { launchChromium } from './browser.mjs';

const BASE = process.env.PHONE_BASE || process.env.SMOKE_BASE || 'http://localhost:8099';
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nphone: a today-only window has no daily rate to give');

/* The Dubai day, not the runner's: this test asserts about a window the
   product computes on the Dubai clock, and west of Dubai the UTC date is
   yesterday for four hours every day. */
const dubaiDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA',
  { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const browser = await launchChromium();
const read = async (hash) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(`${BASE}/?ui=phone#${hash}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => {
      const d = document.querySelector('.m-lede b');
      return d && d.textContent.trim().length > 0;
    }, { timeout: 25000 }).catch(() => {});
    /* AWAITED before the finally closes the page. `return page.evaluate(...)`
       returns the promise, the finally runs immediately, and the evaluate then
       resolves against a closed target. */
    const got = await page.evaluate(() => {
      const t = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
      const all = [...document.querySelectorAll('.m-stat')].map((s) => ({
        label: s.querySelector('.l')?.textContent?.trim() || '',
        value: s.querySelector('.n')?.textContent?.trim() || '',
        sub: s.querySelector('.s')?.textContent?.trim() || '',
      }));
      const cards = [...document.querySelectorAll('.m-card')].map((c) => ({
        title: c.querySelector('h2')?.textContent?.trim() || '',
        cap: c.querySelector('.m-cap')?.textContent?.trim() || '',
        hasChart: !!c.querySelector('svg, canvas'),
      }));
      return { claim: t('.m-lede b'), sub: t('.m-lede p'), stats: all, cards,
        body: document.body.innerText };
    });
    return got;
  } finally { await page.close(); }
};

const today = dubaiDay();
const todayOnly = await read(`today?from=${today}&to=${today}`);

/* ── the reported bug ────────────────────────────────────────────────────── */
check('the claim is not a rate of zero',
  !/^0 bookings a day/.test(todayOnly.claim), JSON.stringify(todayOnly.claim));
check('the claim says what the figure actually is',
  /so far today|bookings$/.test(todayOnly.claim), JSON.stringify(todayOnly.claim));
check('the figure in the claim is not zero',
  !/^0\b/.test(todayOnly.claim), JSON.stringify(todayOnly.claim));
check('"0 a day over the 0 days that are complete" is unreachable',
  !/0 a day over the 0 day/.test(todayOnly.sub), JSON.stringify(todayOnly.sub));
check('and no daily rate is claimed at all',
  !/\ba day\b/.test(todayOnly.sub), JSON.stringify(todayOnly.sub));
check('the reason is given, not left to be inferred',
  /no whole day|no daily rate/.test(todayOnly.sub), JSON.stringify(todayOnly.sub));
/* Which minute it stopped at is what makes a partial figure usable rather
   than merely unexplained — the desktop names it and now so does this. */
check('and the Dubai minute it stopped at is named',
  /\d\d:\d\d Dubai/.test(todayOnly.sub), JSON.stringify(todayOnly.sub));

const bookings = todayOnly.stats.find((s) => /^Bookings$/i.test(s.label));
check('the Bookings tile exists', !!bookings, JSON.stringify(todayOnly.stats.map((s) => s.label)));
check('and its sub-line does not read "0 a day"',
  bookings && !/^0 a day/.test(bookings.sub), JSON.stringify(bookings));
check('the tile value is the real total, unchanged',
  bookings && /\d/.test(bookings.value) && bookings.value !== '0', JSON.stringify(bookings?.value));

const chart = todayOnly.cards.find((c) => /Bookings a day/i.test(c.title));
if (chart) {
  check('the chart does not caption itself "0 complete days"',
    !/^0 complete day/.test(chart.cap), JSON.stringify(chart.cap));
  check('and an empty chart is not drawn as an axis of nothing',
    !chart.hasChart, 'a drawn-but-empty chart reads as a broken panel');
  check('the caption explains why there is nothing to draw',
    /nothing to chart|still being collected/.test(chart.cap), JSON.stringify(chart.cap));
}

/* Nowhere on the screen may a zero stand where a rate was meant. */
check('no "0 a day" anywhere on the screen',
  !/\b0 a day\b/.test(todayOnly.body), (todayOnly.body.match(/.{0,40}0 a day.{0,20}/) || [])[0]);

/* ── and the case that must NOT change ───────────────────────────────────── */
const wide = await read('today?days=30');
check('a window with whole days still gives a daily rate',
  /bookings a day/.test(wide.claim), JSON.stringify(wide.claim));
check('and still says how many days it is over',
  /a day over the/.test(wide.sub), JSON.stringify(wide.sub).slice(0, 160));
const wideChart = wide.cards.find((c) => /Bookings a day/i.test(c.title));
check('and still draws the chart', !wideChart || wideChart.hasChart);
check('and still counts the complete days in the caption',
  !wideChart || /complete day/.test(wideChart.cap), JSON.stringify(wideChart?.cap));

await browser.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
