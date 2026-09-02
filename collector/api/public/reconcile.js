/* Reconciliation: does what the platforms wired match what they said we earned?
   ─────────────────────────────────────────────────────────────────────────
   One row per month, with both sides of the identity the July 2026 ledger
   reconciliation proved to 0.7%:

       bank payout  ≈  on-trip net + tips + salik − cash collected

   The point of the page is the delta column: within a couple of percent the
   platform's numbers check out; beyond that, somebody has a question to ask.
   A month a statement surface no longer reaches shows a dash, never a zero —
   an expected payout of AED 0 would accuse the platform of not paying for
   work it simply never reported on.

   Two things every figure on this page depends on, and the page says both out
   loud rather than leaving them to be inferred.

   The SCOPE is the whole record. These rows are months; a thirty-day window
   spans two partial ones, and reconciling six days of July against July's bank
   payout is the very mismatch the delta column exists to catch. So the range
   selector is hidden here (see setHeader in app.js) and the span the numbers
   cover is printed where it used to sit — every tile and every row describes
   that same span.

   The COMPARISON is over driver-days, not months. The statement surface names
   some of the fleet's drivers and the bank figure names all of them, so the
   two figures the delta is made of are printed beside it rather than left to
   be assumed from the columns further left.

   Clicking a month opens the same table at day grain, because "August is 9%
   off" is only actionable once you can see WHICH days carry the gap — cash
   timing shows up as paired over/under days, a missing statement week as a
   run of dashes. */
import { empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money, fmt, pct,
  countOf, plural, verdict } from './ui.js';
import { qChan, href } from './data.js';

/* Why a money column can be empty for a whole year of months.
   ─────────────────────────────────────────────────────────────────────────
   The first version of this sentence said "the ledger only carries money from
   6 February 2026", which is true of the BANK side and wrong for these four
   columns. Measured on the live database:

     bank payout          6 Feb 2026 → 30 Aug 2026, 206 days, AED 2,105,263
     earnings components  August 2026 only — 0 rows for Feb–Jul

   driver_statement_day, which every on-trip figure here reads, is built by
   src/rollup.js from driver_earnings_component. So on-trip net, tips, Salik
   and cash collected exist for exactly the months whose payout BREAKDOWN was
   pulled, and that is one of thirteen. The bank column beside them is filled
   for seven, which is why the two sides disagree about how much history this
   page has — and why saying "the ledger starts in February" over a column
   that starts in August was worse than saying nothing. */
/* Two absences, opposite actions — and this sentence named the wrong one.
   ─────────────────────────────────────────────────────────────────────────
   It said a blank was "a month whose statement was never pulled", which reads
   as a backfill somebody forgot to run. It is not: Uber's earnings surface
   serves a ROLLING window of about 192 days that moves forward daily, so the
   months before it can never be fetched again by anyone. The page already says
   so correctly two hundred pixels further down; this sentence sat directly
   under the table and contradicted it, and proximity wins.

   It was also stale on its own terms — "collected for August 2026" while eight
   months carry a statement. Written from the record's own edge instead, so it
   cannot go out of date again. */
const MONEY_FROM = 'these figures come from Uber\u2019s payout breakdown, and that surface serves a '
  + 'rolling window of about 192 days which moves forward every day — so a blank here is a month '
  + 'the platform can no longer be asked about, not one whose statement nobody pulled. Earlier '
  + 'months are unknowable rather than zero.';

/* Counted here rather than inline so the rule can be checked directly: a
   caption that under-fires is invisible in a rendered page and obvious in a
   list of rows. `same` requires both values to exist — two days that are both
   blank repeat nothing, they are two absences. */
export function spreadRuns(rows) {
  const same = (a, b) => a != null && b != null && Number(a) === Number(b);
  let expected = 0; let bank = 0; let either = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const e = same(rows[i].expected_payout, rows[i - 1].expected_payout);
    const b = same(rows[i].bank_payout, rows[i - 1].bank_payout);
    if (e) expected += 1;
    if (b) bank += 1;
    if (e || b) either += 1;
  }
  return { expected, bank, either };
}

const MONTH_LABEL = (m) => {
  const [y, mm] = String(m).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y}`;
};

/* A figure that was not reported is an em-dash with the reason dimmed beside
   it, never 0 — absence and zero are different facts, and on a money page the
   difference is an accusation. */
const orDash = (v, why) => (v == null
  ? `<span class="dim">— ${esc(why)}</span>`
  : money(v));

/* The delta toned by how far the two sides sit apart: within ±2% is the
   agreement the July reconciliation achieved, ±10% is worth a look (usually
   cash banked in a different month), beyond that something is actually wrong
   or missing. */
const deltaPill = (r) => {
  if (r.delta == null) return '<span class="dim">—</span>';
  const off = r.delta_pct == null ? null : Math.abs(r.delta_pct);
  const sign = r.delta > 0 ? '+' : r.delta < 0 ? '−' : '±';
  const body = `${sign}AED ${fmt(Math.abs(r.delta))}${off == null ? '' : ` · ${pct(off, 1)}`}`;
  /* A row Uber will no longer answer about in full is not a row with a
     discrepancy — it is a row with half a measurement, and colouring it red
     tells an operator to go and investigate a month that was fine.
     ─────────────────────────────────────────────────────────────────────
     The earner-payments surface serves a rolling ~192-day window. Measured on
     production 2026-09-02, where that edge falls on 22 February, the expected
     side steps at exactly that date: 3,687/day before the 15th, 8,894 for
     16–22, 19,571 from the 23rd — against a bank side flat at ~25,000 and the
     SAME 216 drivers throughout. February read +81.4% beside settled months
     at +13%, and nothing said why. Nothing can re-fetch those statements, so
     the only honest thing the page can do is stop calling it a discrepancy. */
  if (r.statement_partial) {
    return pill(body, 'dim', `${r.days_in_horizon} of ${r.days_total} days here are still inside `
      + 'Uber\u2019s rolling statement window, so the expected side is part of a month measured '
      + 'against a whole one — not a gap to investigate');
  }
  const tone = off == null ? 'warn' : off <= 2 ? 'ok' : off <= 10 ? 'warn' : 'bad';
  return pill(body, tone);
};

/* The report window the money on this side was measured over.
   ─────────────────────────────────────────────────────────────────────────
   Both money tables spread a provider's report evenly across its days and
   record the divisor (sql/schema_v23.sql, sql/schema_v44.sql), and until now
   the page printed the quotient with nothing to say it was one. February 2026
   is what that hides: the payout column there is a WEEKLY report over 9-14
   February — AED 3,799.61 on each of six days — and then AED 25,998.71 on the
   15th, because the collector asks day by day only as far back as
   EARNER_DAY_HORIZON (src/sources/uber.js) and 2026-09-02 less 200 days is
   2026-02-14. The seam is the collection grid, to the day, and the row that
   straddles it was reading as a 194% overpayment.

   So a row says which basis it used: one report spread across its days, or —
   the case that matters — a column that mixes a measured day with a seventh
   of a week and cannot be added up as if it were either. */
const basis = (min, max, side) => {
  if (max == null || max <= 1) return '';
  const what = min !== max && min != null
    ? `${fmt(min)}- and ${fmt(max)}-day reports mixed`
    : `a ${fmt(max)}-day report spread`;
  return `<span class="dim" title="The provider filed this ${side} money on a report `
    + `window of ${min === max ? `${fmt(max)} days` : `${fmt(min)} to ${fmt(max)} days`}, `
    + 'and the table spreads a report evenly across the days it covers, so a figure at this '
    + 'grain is an allocation rather than a measurement of the row it sits on."> '
    + `· ${what}</span>`;
};

/* A full-period figure, with the part of it the comparison actually used shown
   beside it when the two differ. Without the second number a partly-matched
   row reads as a wild discrepancy instead of a partial answer. */
const withCompared = (full, compared, why) => {
  if (full == null) return orDash(null, why);
  const show = compared != null && Math.abs(compared - full) > 1;
  return `${money(full)}${show ? `<span class="dim"> · ${money(compared)} compared</span>` : ''}`;
};

/* Why nothing could be compared in this row. Three different absences, and
   they call for three different actions — chase the statement, chase the
   payout, or look at who is missing from one of them. */
const noMatchReason = (r) => {
  if (r.ontrip_net == null) return 'no statement';
  if (r.bank_payout == null) return 'no payout reported';
  return 'no driver-day on both sides';
};

const COLS = (keyCol) => [
  keyCol,
  { label: 'Trips', key: 'trips', num: true,
    render: (r) => (r.trips == null ? '<span class="dim">—</span>' : fmt(r.trips)) },
  { label: 'On-trip net', key: 'ontrip_net', num: true,
    render: (r) => orDash(r.ontrip_net, 'no statement') },
  { label: 'Tips', key: 'tips', num: true, absent: MONEY_FROM, render: (r) => orDash(r.tips, '') },
  { label: 'Salik', key: 'salik', num: true, absent: MONEY_FROM, render: (r) => orDash(r.salik, '') },
  { label: 'Cash collected', key: 'cash_collected', num: true, absent: MONEY_FROM,
    render: (r) => orDash(r.cash_collected, '') },
  { label: 'Expected payout', key: 'expected_payout', num: true,
    /* "needs the statement" read as a task somebody could do. For every month
       before the retention edge there is nothing to do. */
    render: (r) => withCompared(r.expected_payout, r.expected_covered,
      'outside Uber\u2019s 192-day window')
      + basis(r.expected_period_days_min, r.expected_period_days, 'on-trip') },
  { label: 'Bank payout', key: 'bank_payout', num: true,
    /* The part of an open month that has not happened yet, named. Uber writes
       a whole weekly period's rows the moment the period opens, so the current
       month's bank figure carries days still in the future — on production
       AED 26,398 of September's 54,227, which is why clicking the row showed
       half the money. The day view already excludes those days; the month row
       now says how much of itself they are. */
    render: (r) => withCompared(r.bank_payout, r.bank_covered, 'no payout reported')
      + basis(r.bank_period_days_min, r.bank_period_days, 'bank')
      + (r.bank_accrued
        ? `<span class="dim" title="${fmt(r.accrual_days)} payout rows dated after today — Uber `
          + `writes a whole weekly period when it opens, so this much of the month is a forward `
          + `projection rather than money already wired"> · ${money(r.bank_accrued)} not yet paid</span>`
        : '') },
  { label: 'Δ bank − expected', key: 'delta', num: true, absent: MONEY_FROM, render: deltaPill },
  /* The column that explains the one before it. A delta drawn over 53 of the
     189 drivers the bank paid that day is a different claim from one drawn
     over all of them, and the number is the difference between "the platform
     underpaid" and "we hold a third of the statement". */
  { label: 'Compared over', key: 'matched_pairs',
    render: (r) => (r.matched_pairs
      ? `<span class="dim">${fmt(r.matched_drivers)} of ${fmt(r.bank_drivers)} drivers`
        + ` · ${fmt(r.matched_days)} day${r.matched_days === 1 ? '' : 's'}</span>`
      : `<span class="dim">— ${esc(noMatchReason(r))}</span>`) },
];

export async function renderReconcile(root, month) {
  root.innerHTML = '';
  if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return empty(root, 'A reconciliation address is #reconcile/<YYYY-MM>.');
  }
  const host = el('div', 'stack'); root.append(host); loading(host);

  /* The window selector does not apply here — the whole record is the point of
     a reconciliation — but the platform and fleet filters do, and the endpoint
     answers for one platform when one is chosen. */
  /* Through qChan, which is where the platform and fleet chips already come
     from and — the part that matters here — omits the '?' when there is
     nothing after it. This built its own query string, so with no chip chosen
     it asked for "/api/reconcile?": one character away from the key
     api/warm.js fills, and therefore a guaranteed cache miss on the page's own
     default view, of the heaviest read in the product. api/cache.js keys on
     the whole originalUrl; data.js has had this guard since the same bug cost
     /api/coverage its warm entry. */
  const d = await qChan('/api/reconcile', month ? { month } : {});
  host.innerHTML = '';

  if (month) {
    host.append(el('p', 'cap',
      `<a class="lnk" href="${href('reconcile')}">← All months</a> · ${esc(MONTH_LABEL(month))}, day by day`));
  }
  if (!d.rows.length) {
    return empty(host, month
      ? `Nothing recorded in ${MONTH_LABEL(month)} — no trips, no statement, no payout.`
      : 'Nothing to reconcile yet: no trips, statements or payouts on record.');
  }

  /* The span every figure below covers, said once, in the words the rows are
     keyed in. This is the sentence the range selector used to contradict. */
  const span = month ? MONTH_LABEL(month)
    : d.rows.length === 1 ? MONTH_LABEL(d.rows[0].m)
      : `${MONTH_LABEL(d.rows[0].m)} → ${MONTH_LABEL(d.rows[d.rows.length - 1].m)}`;
  const over = `over ${span}`;

  const t = d.totals;
  /* Each of these two totals covers a different part of the window, and both
     tiles said "over Aug 2025 -> Aug 2026". Expected payout needs a collected
     payout BREAKDOWN and exists for one month of thirteen; Bank payout needs
     only a statement and exists for seven. So AED 24,500 sat beside
     AED 2,108,697 under identical captions, inviting a comparison of one month
     against seven. Each tile now states its own coverage. */
  const periods = d.rows.length;
  const unit = month ? 'day' : 'month';
  const withExpected = d.rows.filter((r) => r.expected_payout != null).length;
  const withBank = d.rows.filter((r) => r.bank_payout != null).length;
  const coverage = (n) => (periods && n < periods
    ? `over the ${countOf(n, unit)} of ${fmt(periods)} that ${plural(n, 'carries', 'carry')} one`
    : over);
  /* Reconciliation compares what the platforms WIRED against what their own
     statements say they owed — and the honest headline is how many of the
     periods can be compared at all. Expected payout needs a collected payout
     breakdown and exists for one month of thirteen; bank payout needs only a
     statement and exists for seven. A page that leads with a variance computed
     over the overlap invites it to be read as the whole year's. */
  {
    /* Over the COVERED pairs, not the raw month columns.
       ─────────────────────────────────────────────────────────────────────
       bank_payout is a whole month; expected_payout only reaches the days the
       statement covers. Subtracting one from the other is the exact failure
       api/reconcile_routes.js:118 exists to prevent — "a whole-month statement
       against a whole-month bank payout … reported the platform overpaying by
       1,449%" — and the table row was fixed while this tile, the first and
       largest number on the page, was not.

       Measured on production: this tile read AED 664,898 against the Gap tile
       a few hundred pixels away reading AED 625,589. The 39,309 difference is
       exactly sum(bank_payout − bank_covered) — money wired on days with no
       statement at all, counted here as "more wired than owed". February alone
       contributed AED 21,520 from 6–8 February, three days the statement never
       reached.

       The endpoint already computes the honest figure over the driver-days
       both sides describe, and the Gap tile already uses it. */
    const both = d.rows.filter((r) => r.expected_covered != null && r.bank_covered != null);
    const gap = both.reduce((a, r) => a + ((+r.bank_covered || 0) - (+r.expected_covered || 0)), 0);
    verdict(host, {
      claim: both.length
        ? `${countOf(both.length, unit)} of ${fmt(periods)} can be reconciled at all`
        : `Nothing in this range can be reconciled`,
      figure: both.length ? money(gap) : `0 of ${fmt(periods)}`,
      unit: both.length ? (gap >= 0 ? 'more wired than owed' : 'less wired than owed') : 'comparable',
      tone: both.length ? (Math.abs(gap) > 1000 ? 'warn' : null) : 'warn',
      meta: `${fmt(periods)} ${plural(periods, unit)} on record`,
      sub: `${fmt(withExpected)} ${plural(withExpected, unit)} carry an expected payout and `
        + `${fmt(withBank)} carry a bank payout — the two are collected from different surfaces `
        + 'and only where both exist is there anything to compare.',
    });
  }

  host.append(kpiRow([
    { label: 'Trips', value: t.trips != null ? fmt(t.trips) : '—',
      sub: `bookings ${over}` },
    { label: 'Expected payout', value: t.expected_payout != null ? money(t.expected_payout) : '—',
      sub: `on-trip net + tips + salik − cash, ${coverage(withExpected)}` },
    { label: 'Bank payout', value: t.bank_payout != null ? money(t.bank_payout) : '—',
      sub: `what the platforms report having paid, ${coverage(withBank)}` },
    /* The two figures the gap is the difference of, and how much of the record
       they cover. The Gap tile used to sit beside a bank total spanning every
       month while measuring one — two scopes in one row of tiles, with nothing
       on screen to tell them apart. */
    { label: 'Compared over', value: t.matched_pairs ? fmt(t.matched_pairs) : '—',
      sub: t.matched_pairs
        ? `${plural(t.matched_pairs, 'driver-day')} both sides describe, in `
          + `${countOf(t.reconciled_rows, month ? 'day' : 'month')}`
        : 'no driver-day is described by both sides' },
    { label: 'Gap', html: t.delta == null ? '<span class="dim">—</span>' : deltaPill(t),
      sub: t.delta == null
        ? 'nothing reconcilable: the two sides never describe the same driver on the same day'
        : `${money(t.bank_covered)} banked against ${money(t.expected_covered)} expected, `
          + 'on those driver-days alone' },
  ]));

  const mp = month
    ? panel(`${MONTH_LABEL(month)}, day by day`,
      'The same identity at day grain. A dash is a day the source in question reported nothing.')
    : panel('Month by month',
      `Every month on record — ${span} — all platforms combined unless the platform filter `
      + 'narrows it. The date range at the top of the page does not apply to a table of months, '
      + 'so it is not offered here. Click a month for its days.');

  const keyCol = month
    ? { label: 'Day', key: 'd',
      render: (r) => `<a class="lnk" href="${href('day', r.d)}" title="Everything recorded on this day">${esc(r.d)}</a>` }
    : { label: 'Month', key: 'm',
      render: (r) => `<a class="lnk" href="${href('reconcile', r.m)}" title="This month, day by day">${esc(MONTH_LABEL(r.m))}</a>` };

  // Newest first for the monthly view — reconciliation starts from the latest
  // statement — and calendar order inside a month, which is how a month reads.
  const rows = month ? d.rows : [...d.rows].reverse();
  mp.body.append(tableFrom(rows, COLS(keyCol),
    { sortable: true, sortId: month ? 'recon-days' : 'recon-months' }));
  /* Why consecutive days are byte-identical, and why this used to say so far
     too rarely.
     ─────────────────────────────────────────────────────────────────────────
     A report period is weekly and the day grain spreads it evenly across its
     days, so seven rows carrying the same figures are ONE report, not seven
     days that happened to match, and a reader reconciling them one at a time
     is checking the same number seven times.

     The test for that demanded the bank column AND the on-trip column repeat
     together — and the two sides are collected on different grids, so the
     moment the payout side gains a daily measurement the statement beside it
     is still a seventh of a week and the caption goes silent on exactly the
     rows that need it. Measured on production 2026-09-02: February 2026
     carries seventeen days whose expected side repeats the day before and six
     whose bank side does, eighteen days in all, and the caption said six;
     September carries five and the caption said three. Either side repeating
     is one report wearing several hats, so each is counted and named. */
  if (month) {
    const runs = spreadRuns(rows);
    if (runs.either) {
      mp.body.append(el('p', 'cap',
        `${countOf(runs.either, 'day')} here `
        + `${plural(runs.either, 'repeats', 'repeat')} the figures of the day before — `
        + `${fmt(runs.expected)} on the expected side, ${fmt(runs.bank)} on the bank side. `
        + 'That is not a coincidence: a platform reports by the WEEK, and a weekly report spread '
        + 'across its days gives every day in the period the same numbers. Reconcile a period, '
        + 'not a day.'));
    }
  }
  host.append(mp.panel);

  host.append(el('p', 'cap', esc(d.note)));
  /* The horizon this note described was the REST feed's, and Uber has two.
     ─────────────────────────────────────────────────────────────────────────
     "answers for the CURRENT payment period and returns an empty list for
     every older window" was true of api.uber.com's earner-payments surface,
     and it is still true of it. It stopped describing this page the day the
     supplier GraphQL breakdown started filling the same table: that surface
     answers for as far back as Uber retains, which is a rolling window of
     about 192 days, and it is why seven months now carry an on-trip figure on
     both fleets where six did not before. A note claiming the column "grows a
     week at a time from here" sat directly beneath thirteen months of it. */
  host.append(note(
    'A gap between bank and expected is usually timing, not theft: cash a driver banked in the '
    + 'neighbouring month, and per-trip surcharges the statement mapping deliberately leaves '
    + 'unguessed. The on-trip side reaches only as far back as the platform statement surfaces '
    + 'do. Uber’s reaches about 192 days — a rolling retention window that moves forward daily, '
    + 'so the oldest month on this table loses its statement a little at a time and can never '
    + 'get it back. Earlier months show “—”, which means unknowable, not zero.'));
}
