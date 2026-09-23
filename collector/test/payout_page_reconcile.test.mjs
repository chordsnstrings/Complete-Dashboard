/* WHAT THE PAYOUTS PAGE IS ALLOWED TO SAY ABOUT A DIFFERENCE IT CANNOT MAKE.
   ═══════════════════════════════════════════════════════════════════════════
   The panel this file guards exists because of a false comparison, so the
   assertions are mostly about the shapes a false comparison takes.

   The retracted claim, which this page printed in its own header: "measured on
   Ecosine's closed week of Mon 7 to Sun 13 September 2026, the dashboard says
   AED 110,962.09 and Uber's own books say the transfer was AED 103,567.54.
   7.1% apart." The arithmetic is sound and the two figures are different
   weeks. 103,567.54 was wired on Monday 2026-09-07 and a Monday wire settles
   the week that ENDED THE DAY BEFORE, 31 Aug – 6 Sep. The wire that settles
   7–13 Sep is 111,179.66, paid Monday 2026-09-14, and against it our own
   110,962.09 is out by 217.57 — 0.20%, not 7.1%.

   That is one comparison, made by hand, in a comment, once. The panel makes it
   per transfer, from the server, against the week each transfer itself names.
   Which raises the failure this file is really here for: the panel now has a
   Difference column with a row in it for every transfer, INCLUDING the 175
   Bolt transfers that state no period and can never be compared at all. A
   Difference column has exactly one tempting wrong answer for those rows, and
   it is 0 — a number that sorts, sums, colours green and reads as agreement,
   over a comparison nobody made.

   FOUR THINGS ARE ASSERTED, and each one is the page's half of the house rule
   that a figure which cannot be measured renders absent WITH A REASON:

     1. a row with no comparison prints WHY, and prints no zero, and takes no
        verdict colour — an absence painted green is a lie with a tick beside
        it.
     2. the unchecked band states HOW MANY days nobody has asked Uber about
        and says, in the page's own words, that such a day is not a day with
        no transfer. This is the whole reason the register can be trusted:
        Uber's statement is a per-day document and on 2026-09-17 uber/ecosine
        held 4 statement days out of a record running to hundreds.
     3. a day the live ask could not learn anything about prints the provider's
        reason VERBATIM. "The limiter is shut" is a fact about this minute and
        "Uber has no statement for this day" is a fact about the day, and a row
        of dashes says neither.
     4. "an ask is already running" is a refusal, not a failure, and is toned
        as one — the correct response to it is to wait a minute, and a red box
        tells an operator something is broken.

   Run in a real browser against the shipped module, for the reason
   test/unauthorized_attribution_page.test.mjs gives: tableFrom builds elements
   and sets innerHTML, foldChildren reads localStorage, and a hand-rolled
   document shim would be testing the shim. No server and no database are
   involved — window.fetch is replaced and the fixtures below are this file's
   own, taken from the production measurements of 2026-09-17.

   Each assertion was proved by REVERSION rather than by passing; the reversion
   that proves it is written beside it. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the fixtures ────────────────────────────────────────────────────────
   Field for field the shape api/payout_routes.js serves. The figures are the
   ones measured live on production on 2026-09-17. */

/* Bolt's reason, which is the one that must never become a zero: Bolt files
   175 transfers and states the period of none of them. */
const BOLT_WHY = 'bolt does not state which period a transfer settles, so there is no window '
  + 'to sum our own figure over. Nothing is compared here, and that is not a difference of zero.';

const UBER_WHY = 'sum of driver_payout_day.earnings for uber/ecosine over 2026-09-07 to '
  + '2026-09-13 — 7 of 7 days carrying rows, 1,204 driver-days. This is the same quantity Bank '
  + 'reconciliation calls "bank payout"; it is what the drivers earned, not a transfer.';

/* 2026-08-23 .. 2026-09-16 inclusive is 25 days, and four of them are Mondays
   (24 Aug, 31 Aug, 7 Sep, 14 Sep). 2026-09-14 is the day that carries the
   111,179.66 wire and was the 25th missing day in ecosine's queue — one past
   the nightly budget of 24, which is why it had never been asked for. */
const ECOSINE_UNASKED = [];
for (let t = Date.UTC(2026, 7, 23); t <= Date.UTC(2026, 8, 16); t += 864e5) {
  ECOSINE_UNASKED.push(new Date(t).toISOString().slice(0, 10));
}
const EGARI_UNASKED = ['2026-09-14', '2026-09-15', '2026-09-16'];
const UNASKED_TOTAL = ECOSINE_UNASKED.length + EGARI_UNASKED.length;   // 28

const UNCHECKED_WHY = 'Uber publishes a one-day organisation statement for ecosine and no '
  + 'statement row is stored for these 25 days, so nobody has asked. The nightly walk fills '
  + 'them oldest first, Mondays ahead of the rest, bounded per run.';

const REC = {
  window: ['2026-08-19', '2026-09-17'],
  rows: [
    /* The row the whole panel was built for. */
    { platform: 'uber', fleet_id: 'ecosine', paid_on: '2026-09-14',
      wire: 111179.66, period_start: '2026-09-07', period_end: '2026-09-13',
      calculated: 110962.09, calculated_basis: UBER_WHY,
      delta: 217.57, delta_pct: 0.2,
      opening_balance: 111279.92, balance_delta: -100.26,
      checked_at: null, source: 'uber_payments_org' },
    /* The row that can never be compared. */
    { platform: 'bolt', fleet_id: 'ecosine', paid_on: '2026-09-07',
      wire: 3184.22, period_start: null, period_end: null,
      calculated: null, calculated_basis: BOLT_WHY,
      delta: null, delta_pct: null,
      opening_balance: null, balance_delta: null,
      checked_at: null, source: 'bolt_payouts' },
  ],
  totals: { wire: 114363.88, calculated: 110962.09, delta: 217.57,
    wire_comparable: 111179.66, rows: 2, comparable_rows: 1,
    basis: 'wire totals all 2 transfers in this window. calculated and delta cover only the 1 '
      + 'that names a period AND has driver-day rows stored for it.' },
  unchecked: [
    { platform: 'uber', fleet_id: 'ecosine', days: ECOSINE_UNASKED,
      count: ECOSINE_UNASKED.length, why: UNCHECKED_WHY },
    { platform: 'uber', fleet_id: 'egari', days: EGARI_UNASKED,
      count: EGARI_UNASKED.length,
      why: 'Uber publishes a one-day organisation statement for egari and no statement row is '
        + 'stored for these 3 days, so nobody has asked.' },
  ],
  note: 'Each row is one transfer that reached the bank, beside our own figure for the week '
    + 'that transfer settles. On the one week where both sides are known, Ecosine 7–13 Sep '
    + '2026: ours 110,962.09, wire 111,179.66 paid on Monday 14 Sep, delta +217.57 — 0.20%.',
};

/* The register endpoint the page already read before this pass. Deliberately
   EMPTY of transfers: empty() begins host.innerHTML = '' and this branch used
   to hand it `root`, which wiped the tiles and would have wiped the panel this
   file asserts on. An empty register is therefore also the case that proves
   the new panel survives it. */
const REGISTER = {
  payouts: [],
  coverage: [
    { platform: 'uber', publishes_payouts: true, how: 'one-day organisation statement',
      in_window: [], record_span: [], cadence: 'Monday', absent: null },
  ],
  days: [],
  note: 'Bank reconciliation and this page count different events.',
};

/* A live ask that learned nothing. The limiter refusal is the important one:
   it is a fact about this minute, not about 2026-09-16. */
const LIMITER_WHY = 'Uber’s payment-report limiter is shut — it refuses new reports for '
  + 'several minutes once about three are in flight. This is a fact about right now and not '
  + 'about 2026-09-16; nothing was learned and nothing was stored. Uber said: Payment report '
  + 'generation limit reached';
const REFUSED_WHY = 'the Dubai day 2026-09-17 is not finished (today is 2026-09-17). Uber '
  + 'would answer with a partial statement, and storing a partial as a final one would make '
  + 'the nightly walk skip this day for ever.';

const VERIFY_FAILED = {
  platform: 'uber', fleet: 'ecosine', asked_at: '2026-09-17T09:00:00.000Z',
  days: [{ day: '2026-09-16', asked: true, uber: null, wire: null, settles: null,
    stored_before: { wire: null, had_statement: false },
    calculated: null, delta: null, balance_check: null, stored: false, why: LIMITER_WHY }],
  refused: [{ day: '2026-09-17', why: REFUSED_WHY }],
  note: 'A day that could not be asked carries its reason and no numbers at all.',
};

const ALREADY_WHY = 'a live ask is already running (ecosine: 2026-09-15 since '
  + '2026-09-17T08:58:00.000Z). Uber’s payment-report limiter shuts for minutes once about '
  + 'three reports are in flight, so this process runs one ask at a time. Nothing was asked '
  + 'of Uber. Try again when it finishes.';
const VERIFY_BUSY = {
  status: 409,
  body: {
    platform: 'uber', fleet: 'ecosine', asked_at: '2026-09-17T09:00:00.000Z',
    days: [],
    refused: [{ day: '2026-09-16', why: 'not asked — another live ask was already running.' }],
    error: ALREADY_WHY,
  },
};

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const port = server.address().port;

const browser = await launchChromium();

/* A FRESH PAGE PER SCENARIO, and localStorage cleared inside it.
   api/public/swr.js stores every GET body in localStorage keyed on the URL and
   serves it immediately on the next read — so a second render with a different
   fixture would paint the FIRST fixture's numbers and the assertions would be
   about a page nobody built. */
async function render(fixtures) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(async (fx) => {
    try { localStorage.clear(); } catch { /* nothing cached, nothing to clear */ }
    const orig = window.fetch.bind(window);
    window.fetch = async (url, opts) => {
      const path = String(url).split('?')[0];
      const hit = fx[path];
      if (!hit) return orig(url, opts);
      window.__sent = window.__sent || [];
      window.__sent.push({ path, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      return new Response(JSON.stringify(hit.body), {
        status: hit.status || 200, headers: { 'content-type': 'application/json' } });
    };
    const host = document.createElement('div');
    host.id = 'probe';
    document.body.append(host);
    const m = await import('/payouts.js');
    window.__mod = m;
    await m.renderPayouts(host);
  }, fixtures);
  return page;
}

const BASE = {
  '/api/finance/payouts': { body: REGISTER },
  '/api/finance/payouts/reconcile': { body: REC },
};

/* ══ 1. A ROW WITH NO COMPARISON PRINTS ITS REASON, NOT A ZERO ════════════ */
console.log('a transfer with no stated period renders an absence with its reason');
{
  const page = await render(BASE);
  const r = await page.evaluate((boltWhy) => {
    const p = document.querySelector('[data-panel="payout-reconcile"]');
    if (!p) return { missing: true };
    const heads = [...p.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    const diff = heads.findIndex((h) => h === 'Difference');
    const ours = heads.findIndex((h) => h === 'Our figure');
    const rows = [...p.querySelectorAll('tbody tr')].map((tr) => ({
      first: tr.children[0].textContent.replace(/\s+/g, ' ').trim(),
      diffText: tr.children[diff].textContent.replace(/\s+/g, ' ').trim(),
      diffClass: tr.children[diff].className,
      diffTitle: (tr.children[diff].querySelector('[title]') || {}).title || '',
      oursText: tr.children[ours].textContent.replace(/\s+/g, ' ').trim(),
      strongTag: (tr.children[diff].querySelector('b.dl') || {}).tagName || null,
    }));
    return {
      heads,
      rows,
      panelText: p.textContent.replace(/\s+/g, ' ').trim(),
      reasonPrinted: p.textContent.includes(boltWhy),
    };
  }, BOLT_WHY);

  check('the panel is on the page at all', !r.missing);
  check('it carries a Difference column', (r.heads || []).includes('Difference'), (r.heads || []).join(' | '));
  /* checked_at is filled only by the live ask, so until somebody presses the
     button every row is null — a whole column of identical absences, and on a
     phone it is the column that pushes Difference off the right-hand edge of a
     table opened to read Difference. tableFrom drops a column that is empty in
     every row and prints the sentence under the table instead.
     REVERSION THAT PROVES THIS: remove `absent:` from the Asked live column.
     The column comes back full of dashes and both of these fail. */
  check('a column no row can fill is dropped rather than filled with dashes',
    !(r.heads || []).includes('Asked live'), (r.heads || []).join(' | '));
  check('…and the reason it is missing is printed under the table',
    /nobody has asked Uber live about any of these days/.test(r.panelText || ''));

  /* dateStr() renders "Sep 14, 2026 · Monday". The Bolt transfer arrived on
     7 Sep and the Uber wire on 14 Sep, and "Sep 7," is not a substring of
     "Sep 14," — so the two rows are told apart by the date they arrived,
     which is the column the whole page is organised on. */
  const bolt = (r.rows || []).find((x) => x.first.startsWith('Sep 7, 2026'));
  const uber = (r.rows || []).find((x) => x.first.startsWith('Sep 14, 2026'));

  /* THE ASSERTION THIS FILE EXISTS FOR.
     REVERSION THAT PROVES IT: in api/public/payouts.js, change the Difference
     column's render to `money(r.delta || 0, 'AED', 2)`. The cell reads
     "AED 0.00", these three go red, and the page reports that Bolt's books
     agree with ours perfectly over a comparison nobody made. */
  check('the uncomparable row shows no figure at all',
    !!bolt && !/\d/.test(bolt.diffText), bolt && bolt.diffText);
  check('…and specifically not a zero',
    !!bolt && !/0(\.00)?/.test(bolt.diffText), bolt && bolt.diffText);
  check('…and not a bare dash either — it names which absence it is',
    !!bolt && /no period stated/.test(bolt.diffText), bolt && bolt.diffText);
  /* REVERSION: drop the `title` from absent(). The cell still reads "no period
     stated" and the provider's sentence is gone from the element. */
  check('the cell carries the provider’s own reason on the element',
    !!bolt && bolt.diffTitle === BOLT_WHY, bolt && bolt.diffTitle.slice(0, 60));
  /* REVERSION: delete the grouped `byReason` loop at the foot of
     drawReconcile(). This fails and the reason survives only as a tooltip,
     which a screenshot, a printout and a phone all lose. */
  check('…and the same reason is printed in full under the table',
    r.reasonPrinted === true);
  /* REVERSION: change cellCls to `(r) => deltaTone(r.delta, r.delta_pct) || 'v-good'`.
     The Bolt cell goes green — an absence with a tick beside it. */
  check('an absence takes no verdict colour',
    !!bolt && !/v-(good|warn|serious|critical)/.test(bolt.diffClass), bolt && bolt.diffClass);

  /* The measured row, for contrast: a real comparison DOES print, does carry
     the sign, and does take the agreeing colour. */
  check('the measured difference prints with its sign and two decimals',
    !!uber && /\+AED 217\.57/.test(uber.diffText), uber && uber.diffText);
  check('…with the percentage beside it',
    !!uber && /\+0\.20%/.test(uber.diffText), uber && uber.diffText);
  /* REVERSION: drop `cellCls` from the Difference column. The strongest number
     in the row loses its colour and its rule, and this fails. */
  check('…and takes the agreeing colour, because 0.20% is agreement',
    !!uber && /v-good/.test(uber.diffClass), uber && uber.diffClass);
  /* REVERSION: render the figure as a bare string instead of <b class="dl">.
     The column loses tabular numerals and weight and stops being the strongest
     number in the row. */
  check('…and is the strongest mark in the row',
    !!uber && uber.strongTag === 'B', String(uber && uber.strongTag));
  check('our own figure prints beside it, to the fils',
    !!uber && /AED 110,962\.09/.test(uber.oursText), uber && uber.oursText);

  /* The bands, asserted against the exported function rather than inferred
     from two rows — 7.14% is the shape of the retracted claim and must stop a
     reader, 0.20% is agreement. */
  const tones = await page.evaluate(() => {
    const m = window.__mod;
    return {
      agree: m.deltaTone(217.57, 0.2),
      wide: m.deltaTone(7394.55, 7.14),
      middling: m.deltaTone(2000, 2),
      none: m.deltaTone(null, null),
      noDenominator: m.deltaTone(500, null),
    };
  });
  check('0.20% is agreement', tones.agree === 'v-good', tones.agree);
  check('2% is worth a look', tones.middling === 'v-warn', tones.middling);
  check('7.14% — the retracted claim’s own figure — stops the reader',
    tones.wide === 'v-critical', tones.wide);
  check('a difference that does not exist gets no tone', tones.none === null, String(tones.none));
  check('a difference against a zero wire is not a small disagreement',
    tones.noDenominator === 'v-critical', tones.noDenominator);

  /* The empty-register branch handed `root` to empty(), which begins
     host.innerHTML = ''. REVERSION: restore `empty(root, …)` — this panel, and
     the four tiles above it, vanish from a window with no transfer. */
  check('an empty register does not wipe the panel off the page',
    !r.missing && (r.panelText || '').includes('217.57'));

  await page.close();
}

/* ══ 2. THE DAYS NOBODY ASKED ABOUT ══════════════════════════════════════ */
console.log('\nthe unchecked band states the count and says what such a day is not');
{
  const page = await render(BASE);
  const r = await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-unchecked"]');
    if (!p) return { missing: true };
    return {
      text: p.textContent.replace(/\s+/g, ' ').trim(),
      chips: p.querySelectorAll('.chips button').length,
      mondayChips: [...p.querySelectorAll('.chips button')]
        .filter((b) => / · Mon$/.test(b.textContent)).length,
      buttons: [...p.querySelectorAll('.btnrow button')].map((b) => b.textContent.trim()),
      goDisabled: [...p.querySelectorAll('.btnrow button')]
        .filter((b) => /^Ask Uber/.test(b.textContent)).map((b) => b.disabled),
    };
  });

  check('the band is on the page', !r.missing);
  /* REVERSION: remove `countOf(total, 'day')` from the sentence in
     drawUnchecked() and write "some days". This fails — and the band stops
     being a measurement. */
  check('it states how many days in total nobody has asked about',
    (r.text || '').includes(`${UNASKED_TOTAL} days`), (r.text || '').slice(0, 160));
  /* REVERSION: delete the sentence. The band becomes a list of dates with a
     button, and the whole reason this page can be trusted goes with it. */
  check('…and says, in the page’s own words, what such a day is NOT',
    (r.text || '').includes('cannot be reported as a day with no transfer'));
  /* Matched on the CLAIM rather than on one phrasing of it. The sentence around
     it changed when "nobody has asked" was corrected to "we hold no statement —
     either nobody asked, or the ask was refused", and an assertion pinned to
     the old wording fails on a copy fix while the property it cares about is
     still true. The property is: the page says these days are not zeros. */
  check('…and that none of them is shown as a zero',
    /shown anywhere on this page as a zero/.test(r.text || ''), (r.text || '').slice(0, 200));
  check('the count is broken down per fleet',
    (r.text || '').includes(`${ECOSINE_UNASKED.length} days`)
    && (r.text || '').includes(`${EGARI_UNASKED.length} days`));
  check('the provider’s own reason is printed too',
    (r.text || '').includes(UNCHECKED_WHY));

  /* Every unasked day gets a button — none is dropped by the fold, which only
     hides them. */
  check('there is a button for every unasked day',
    r.chips === UNASKED_TOTAL, `${r.chips} of ${UNASKED_TOTAL}`);
  /* Uber has only ever been seen to wire on a Monday, so a day picked at
     random is a day almost certain to come back with an empty bank column. */
  check('the Mondays are marked, because that is where a wire is',
    r.mondayChips === 5, String(r.mondayChips));
  check('and there is a Monday shortcut',
    (r.buttons || []).some((b) => /^Pick the newest 4 Mondays$/.test(b)), (r.buttons || []).join(' | '));
  check('the ask button starts disabled, because nothing is picked yet',
    (r.goDisabled || []).every((x) => x === true), JSON.stringify(r.goDisabled));

  /* The cap is refused HERE, with the reason, rather than being sent and
     refused by the route. */
  const capped = await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-unchecked"]');
    const row = p.querySelector('.btnrow');
    const chips = [...row.parentElement.querySelectorAll('.chips button')];
    chips.slice(0, 6).forEach((b) => b.click());
    return {
      picked: row.parentElement.querySelectorAll('.chips button.on').length,
      said: row.querySelector('.cap').textContent.replace(/\s+/g, ' ').trim(),
      label: [...row.querySelectorAll('button')]
        .filter((b) => /^Ask Uber/.test(b.textContent))[0].textContent.trim(),
    };
  });
  /* REVERSION: drop the `sel.size >= MAX_ASK` branch in askControl(). Six days
     are picked, the route refuses the whole request, and the operator is told
     nothing until after they have waited for it. */
  check('a sixth day cannot be picked', capped.picked === 5, String(capped.picked));
  check('…and the page says why, naming the limiter',
    /limiter/.test(capped.said) && /cap for one ask/.test(capped.said), capped.said.slice(0, 120));
  check('the button counts what is picked',
    capped.label === 'Ask Uber about 5 days', capped.label);

  await page.close();
}

/* ══ 3. A DAY THE ASK COULD NOT LEARN ANYTHING ABOUT ═════════════════════ */
console.log('\na live ask that learned nothing prints the reason, verbatim');
{
  const page = await render({ ...BASE,
    '/api/finance/payouts/verify': { body: VERIFY_FAILED } });

  await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-unchecked"]');
    const row = p.querySelector('.btnrow');
    row.parentElement.querySelector('.chips button').click();
    [...row.querySelectorAll('button')].filter((b) => /^Ask Uber/.test(b.textContent))[0].click();
  });
  await page.waitForFunction(() => {
    const p = document.querySelector('[data-panel="payout-verify"]');
    return !!p && !!p.querySelector('table');
  }, null, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-verify"]');
    const heads = [...p.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    const wire = heads.findIndex((h) => /wire/i.test(h));
    const tr = p.querySelector('tbody tr');
    return {
      text: p.textContent.replace(/\s+/g, ' ').trim(),
      heads,
      wireCell: tr.children[wire].textContent.replace(/\s+/g, ' ').trim(),
      warnNotes: [...p.querySelectorAll('.note.warn')]
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      sent: (window.__sent || []).filter((s) => s.method === 'POST'),
    };
  });

  check('the ask was a POST to the verify route',
    r.sent.length === 1 && r.sent[0].path === '/api/finance/payouts/verify',
    JSON.stringify(r.sent));
  check('…carrying the fleet and the picked day',
    JSON.parse(r.sent[0].body).fleet === 'ecosine'
    && JSON.parse(r.sent[0].body).days.length === 1, r.sent[0].body);

  /* REVERSION THAT PROVES THIS: delete the
     `for (const r of rows) { if (r && r.why) … }` loop in run(). The day stays
     in the table as a line of absences and the reason vanishes — the page then
     shows a day that was asked about and found empty, which is not what
     happened. */
  check('the day’s reason is printed word for word',
    (r.text || '').includes(LIMITER_WHY), (r.text || '').slice(0, 200));
  /* REVERSION: delete the loop over body.refused. A day the route declined to
     ask about disappears from the page entirely, and an operator who asked
     about it will believe it was checked. */
  check('a refused day is printed word for word too',
    (r.text || '').includes(REFUSED_WHY));
  check('both reasons are toned as findings, not as numbers',
    r.warnNotes.length >= 2, String(r.warnNotes.length));
  /* REVERSION: render the wire as `money(r.wire || 0)`. The cell reads
     "AED 0" for a day Uber never answered about — a wire that never happened,
     printed as a measurement. */
  check('the day carries no figure, and certainly no zero',
    !/\d/.test(r.wireCell), r.wireCell);
  check('…and says instead that nothing was learned',
    /nothing learned/.test(r.wireCell), r.wireCell);

  await page.close();
}

/* ══ 4. "ALREADY RUNNING" IS A REFUSAL, NOT A FAILURE ════════════════════ */
console.log('\nan ask that is already running is its own message');
{
  const page = await render({ ...BASE, '/api/finance/payouts/verify': VERIFY_BUSY });

  await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-unchecked"]');
    const row = p.querySelector('.btnrow');
    row.parentElement.querySelector('.chips button').click();
    [...row.querySelectorAll('button')].filter((b) => /^Ask Uber/.test(b.textContent))[0].click();
  });
  await page.waitForFunction(() => {
    const p = document.querySelector('[data-panel="payout-verify"]');
    return !!p && p.querySelectorAll('.note').length > 0
      && !/Asking Uber about/.test(p.textContent);
  }, null, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-verify"]');
    return {
      text: p.textContent.replace(/\s+/g, ' ').trim(),
      errNotes: p.querySelectorAll('.note.err').length,
      warnNotes: [...p.querySelectorAll('.note.warn')]
        .map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
      goDisabled: [...document.querySelectorAll('[data-panel="payout-unchecked"] .btnrow button')]
        .filter((b) => /^Ask Uber/.test(b.textContent))[0].disabled,
    };
  });

  /* REVERSION THAT PROVES THIS: remove the `res.status === 409` branch in
     run(). The message falls through to the `!res.ok` branch, renders red, and
     tells an operator something is broken when the correct move is to wait a
     minute. */
  check('the refusal is toned as a refusal, not as an error', r.errNotes === 0, String(r.errNotes));
  check('…and says what is happening, in the route’s own words',
    (r.text || '').includes(ALREADY_WHY), (r.text || '').slice(0, 200));
  check('…and the days it did not ask about are still named',
    /not asked — another live ask was already running\./.test(r.text || ''));
  /* A refusal is retryable, so the button comes back. REVERSION: leave
     `ui.go.disabled = true` set on this path — the operator can never try
     again without reloading. */
  check('the ask button is usable again', r.goDisabled === false, String(r.goDisabled));

  await page.close();
}

/* ══ 5. THE WRONG-WEEK CLAIM IS NOT RENDERED ANYWHERE ════════════════════ */
console.log('\nthe retracted 7.1% comparison survives only as a retraction');
{
  /* Asserted against the module's SOURCE with the block comments stripped, so
     the header may — and should — quote the sentence it retracts, while no
     string this page can ever PRINT carries it. A test for the bare substring
     would forbid the retraction from naming what it retracts. */
  const src = await (await fetch(`http://127.0.0.1:${port}/payouts.js`)).text();
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ');

  /* REVERSION THAT PROVES THIS: put `+ '7.1% apart, because they count '` back
     into any rendered string on the page. Both of these fail. */
  check('no rendered string on the page says "7.1%"', !/7\.1\s*%/.test(code),
    (code.match(/.{0,60}7\.1\s*%.{0,60}/) || [''])[0]);
  check('…and none quotes the wrong week’s wire as the comparison',
    !/103,?567\.54/.test(code), (code.match(/.{0,60}103,?567\.54.{0,60}/) || [''])[0]);

  /* The retraction itself, and the measurement that replaces it, are in the
     header where the next person to read this file will find them. */
  check('the header states the corrected difference', /217\.57/.test(src));
  check('…and the corrected percentage', /0\.20%/.test(src));
  /* The second retracted claim: "the transfer equals the previous week's
     closing balance to the fils, proven over two consecutive weeks". It holds
     on one of the three Ecosine Mondays now measurable. */
  check('…and retracts the "to the fils" claim with all three Mondays',
    /to the fils/.test(src) && /57,810\.41/.test(src) && /111,179\.66/.test(src));
  /* WHITESPACE-INSENSITIVE, BECAUSE THE SOURCE-LEVEL GUARD WAS DEFEATED BY A
     LINE BREAK.
     ───────────────────────────────────────────────────────────────────────
     This read `!/to the fils/.test(code)` and the page already contains the
     phrase — "…are not expected to match to the fils; the size of the gap is
     the finding" — split across two concatenated literals as `'…match to '` +
     `'the fils; …'`. The copy is honest (it DENIES the equality) but the guard
     was proving less than its name claimed: a re-introduction that happened to
     wrap would have sailed past it. Matched across the join now, and the
     assertion is about ASSERTING the equality rather than mentioning it — so
     a denial is allowed and a claim is not. */
  const flat = code.replace(/'\s*\+\s*'/g, '').replace(/\s+/g, ' ');
  /* SCOPED TO THE CLAIM, NOT TO THE PHRASE. The retracted sentence is "the
     transfer equals the previous week's CLOSING BALANCE to the fils". "To the
     fils" on its own is this product's idiom for exactness and appears in
     honest sentences about other quantities — the audit band says Uber's two
     REPORTS agree to the fils, which is a measured finding and not the claim
     this guard exists to stop. Requiring the word "balance" nearby is what
     makes the difference; without it the guard fails correct copy, and a check
     that flags correct code is one people learn to ignore. */
  const fils = [...flat.matchAll(/.{0,120}to the fils.{0,80}/g)].map((m) => m[0])
    .filter((h) => /balance/i.test(h));
  check('no rendered string asserts the wire equals the balance, however it wraps',
    fils.every((h) => /not expected|does not|never|retract|used to|not reliably/i.test(h)),
    JSON.stringify(fils));

  /* AND THE SAME CHECK OVER WHAT THE PAGE ACTUALLY RENDERED, not over its
     source. The page prints the SERVER's note verbatim (`note(d.note)`), so a
     source-only guard says nothing about the sentence an operator reads — it
     was true of the file and false of the page for as long as any fixture
     served the old wording. */
  const rendered = await render(BASE);
  const shown = await rendered.evaluate(() => document.body.innerText);
  check('and the rendered page says "7.1%" nowhere', !/7\.1\s*%/.test(shown),
    (shown.match(/.{0,80}7\.1\s*%.{0,80}/) || [''])[0]);
  check('and the rendered page does not assert the wire equals the balance',
    [...shown.matchAll(/.{0,120}to the fils.{0,80}/g)]
      .filter((m) => /balance/i.test(m[0]))
      .every((m) => /not expected|does not|never|retract|used to|not reliably/i.test(m[0])),
    (shown.match(/.{0,140}balance.{0,60}to the fils/) || [''])[0]);
}

/* ══ 5. THE PANEL AND ITS NOTES NAME WHAT THEY HOLD ══════════════════════
   Measured on production 2026-09-23, the morning Bolt's 21 Sep payout first
   reached this page: the first row of a panel titled "Uber’s wire against our
   own figure" was Bolt · Ecosine AED 1,275.14. Bolt rows had sat under that
   Uber title since the register began holding them. And the two notes under
   it read "No comparison is made for 91 transfers (Bolt)" and "…88 transfers
   (Bolt)" — split by fleet, as the grouping key is, and printed without the
   fleet, so nobody could tell which number was Ecosine's. The rows here carry
   calculated_absent, as production's do, so the notes split the same way. */
console.log('\nthe panel and its notes name what they hold');
{
  const noPeriod = { calculated_absent: 'provider_states_no_period' };
  const REC2 = { ...REC, rows: [
    ...REC.rows.map((r) => (r.platform === 'bolt' ? { ...r, ...noPeriod } : r)),
    { platform: 'bolt', fleet_id: 'egari', paid_on: '2026-09-07',
      wire: 1290.15, period_start: null, period_end: null,
      calculated: null, calculated_basis: BOLT_WHY, ...noPeriod,
      delta: null, delta_pct: null, opening_balance: null, balance_delta: null,
      checked_at: null, source: 'bolt_payouts' },
  ] };
  const page = await render({ ...BASE, '/api/finance/payouts/reconcile': { body: REC2 } });
  const r = await page.evaluate(() => {
    const p = document.querySelector('[data-panel="payout-reconcile"]');
    if (!p) return { missing: true };
    return {
      title: (p.querySelector('h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
      notes: [...p.querySelectorAll('.note')].map((n) => n.textContent.replace(/\s+/g, ' ').trim())
        .filter((t) => t.startsWith('No comparison is made')),
    };
  });
  /* REVERSION: restore the title 'Uber’s wire against our own figure'. */
  check('the panel holds Bolt transfers too, so its title names no one provider',
    !r.missing && !!r.title && !/^Uber/.test(r.title), r.title);
  /* REVERSION: print `(${who})` again. Both notes read "(Bolt)". */
  check('one note per fleet, and each names its fleet',
    (r.notes || []).length === 2 && r.notes.some((t) => /\(Bolt · Ecosine\)/.test(t))
    && r.notes.some((t) => /\(Bolt · Egari\)/.test(t)), JSON.stringify(r.notes));
  await page.close();
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
