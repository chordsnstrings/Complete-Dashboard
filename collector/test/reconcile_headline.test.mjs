/* ── the banner that re-added the months the tile beneath it excluded ──────
   #reconcile opens with a verdict band and, about 150 pixels below it, a Gap
   tile. Both name the same quantity: how far the money the platforms wired
   sits from what their own statements say they owed. The band derived its own
   answer from the rows and the tile read the endpoint's, and on production
   they disagreed by 3.4x.

   Re-measured against /api/reconcile over every month on record on 2026-09-05
   — the backfill is live, so these are today's figures and not the round-one
   ones, which have already drifted by AED 54:

     endpoint   totals.delta 117,617.20 over totals.reconciled_rows 6,
                totals.not_comparable_rows 2, totals.accrual_rows 0
     band as it was derived locally  402,922.24 over the 8 rows carrying both
                covered halves — 3.4x the endpoint's answer

   The endpoint agrees with the tile. The banner was re-deriving its own gap
   over every row carrying both halves, which is not the predicate
   api/reconcile_routes.js:594 reconciles on — that one also requires
   !statement_partial && !period_cut, because a month Uber will no longer
   serve a statement for, and a month still inside an open report period, both
   carry two halves that are not comparable. The page greys exactly those rows
   in the table below and the banner added them back, so the largest number on
   the page reported this product's own collection horizon as platform
   variance.

   These tests pin the PROPERTY — the band's figure is the endpoint's delta,
   its count is the endpoint's reconciled_rows, and every period the endpoint
   set aside is named in the sub-line — rather than any sentence, so a later
   rewording cannot make them pass while the arithmetic drifts again. */
import { headlineVerdict } from '../api/public/reconcile.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Digits only, so the assertion survives a change of currency prefix, of
   thousands separator or of the sign glyph. */
const digits = (s) => String(s).replace(/[^\d]/g, '');
const r2 = (n) => Math.round(n * 100) / 100;

/* ── production's own shape, /api/reconcile on 2026-09-05 ─────────────────
   Six reconcilable months, two the endpoint marked not comparable — February
   is retention-limited (statement_partial) and September is mid-report-period
   (period_cut) — and sixteen months with nothing on either side.  The two
   excluded rows carry both covered halves, which is precisely why the old
   local filter swept them in.

   The six reconcilable rows carry the endpoint's real month-by-month figures
   rather than one repeated round number, because the rows have to ADD UP to
   the totals beside them. The previous fixture put a delta of 19,593.92 on
   each of six rows — 117,563.52 — under a totals.delta of 117,563.54, and
   per-row halves that differed by 19,593.93. Two cents, harmless to every
   assertion here, and a payload this server could not have produced: a
   fixture that cannot exist is a fixture that can hide a real disagreement
   between the rows and the totals, which is the exact disagreement this file
   was written to catch. The sums are asserted below rather than trusted. */
const row = (m, over) => ({ m, expected_payout: 100, bank_payout: 100,
  expected_covered: 100, bank_covered: 120, delta: 20, delta_pct: 20,
  statement_partial: false, period_cut: false, accrual: false, ...over });

const RECONCILED = [
  ['2026-03', 164552.23, 160523.05, -4029.18],
  ['2026-04', 212377.26, 218729.95, 6352.69],
  ['2026-05', 319007.84, 334810.51, 15802.67],
  ['2026-06', 340519.39, 357371.70, 16852.31],
  ['2026-07', 311329.05, 329220.42, 17891.37],
  ['2026-08', 340049.75, 404797.09, 64747.34],
];

const ROWS = [
  /* Oct 2024 → Jan 2026: outside Uber's 192-day statement window and before
     the bank side starts, so both money columns are dashes. */
  ...Array.from({ length: 16 }, (_, i) => row(
    `${2024 + Math.floor((9 + i) / 12)}-${String((9 + i) % 12 + 1).padStart(2, '0')}`,
    { expected_payout: null, bank_payout: null, expected_covered: null,
      bank_covered: null, delta: null, delta_pct: null, statement_partial: true })),
  // February: Uber no longer serves part of the month's statement.
  row('2026-02', { expected_covered: 123060.85, bank_covered: 362683.38, delta: 239622.53,
    statement_partial: true }),
  ...RECONCILED.map(([m, ec, bc, dl]) => row(m,
    { expected_covered: ec, bank_covered: bc, delta: dl })),
  // September: the compared span cuts an open weekly report period.
  row('2026-09', { expected_covered: 70308.90, bank_covered: 115991.41, delta: 45682.51,
    period_cut: true }),
];

const TOTALS = {
  trips: 364566, expected_payout: 1895267.03, bank_payout: 2336110.82,
  expected_covered: 1687835.52, bank_covered: 1805452.72,
  matched_pairs: 48470,
  reconciled_rows: 6,
  not_comparable_rows: 2,
  not_comparable_reasons: ['part of the month is outside Uber’s statement window',
    'the month is still inside an open report period'],
  accrual_rows: 0,
  delta: 117617.20, delta_pct: 7,
};

const PAYLOAD = { grain: 'month', month: null, rows: ROWS, totals: TOTALS };

/* ── the fixture is a payload the server could have produced ──────────────
   Asserted, not asserted-in-a-comment. api/reconcile_routes.js sums the
   reconcilable rows into expected_covered, bank_covered and delta, and
   computes delta as bank_covered − expected_covered over exactly those rows.
   If a later edit changes one of the row figures without changing the totals,
   these three fail here rather than silently weakening every check below. */
console.log('the fixture obeys the arithmetic the endpoint obeys');
{
  const rec = ROWS.filter((r) => r.delta != null && !r.statement_partial && !r.period_cut);
  const sum = (k) => r2(rec.reduce((a, r) => a + r[k], 0));
  check('as many reconcilable rows as totals.reconciled_rows',
    rec.length === TOTALS.reconciled_rows, `${rec.length}`);
  check('their covered halves sum to the totals',
    sum('expected_covered') === TOTALS.expected_covered
    && sum('bank_covered') === TOTALS.bank_covered,
    `${sum('expected_covered')} / ${sum('bank_covered')}`);
  check('and their deltas sum to totals.delta, which is the difference of those halves',
    sum('delta') === TOTALS.delta
    && r2(TOTALS.bank_covered - TOTALS.expected_covered) === TOTALS.delta,
    `${sum('delta')} vs ${TOTALS.delta}`);
}

console.log('\nthe banner is the endpoint’s arithmetic, not its own');
{
  const v = headlineVerdict(PAYLOAD, null);

  /* The defect, as one line: the sum the old code produced over every row with
     both halves. It is 3.4x the endpoint's delta, and the band must not be
     showing it. */
  const reDerived = ROWS
    .filter((r) => r.expected_covered != null && r.bank_covered != null)
    .reduce((a, r) => a + (r.bank_covered - r.expected_covered), 0);

  check('the headline gap is totals.delta exactly',
    v.gap === TOTALS.delta, `${v.gap} vs ${TOTALS.delta}`);
  check('…and the printed figure carries that number, not the re-derived one',
    digits(v.figure) === digits(Math.round(TOTALS.delta).toLocaleString('en-US'))
    && digits(v.figure) !== digits(Math.round(reDerived).toLocaleString('en-US')),
    `${v.figure} · re-derived ${Math.round(reDerived)}`);
  check('the month count is totals.reconciled_rows, not the count of rows with both halves',
    v.comparable === TOTALS.reconciled_rows
    && v.comparable !== ROWS.filter((r) => r.expected_covered != null && r.bank_covered != null).length,
    `${v.comparable} vs ${TOTALS.reconciled_rows}`);
  check('…and the claim states that same count against the months on record',
    v.claim.includes('6 months') && v.claim.includes(String(ROWS.length)), v.claim);
  check('the band and the Gap tile therefore divide the same two halves',
    r2(TOTALS.bank_covered - TOTALS.expected_covered) === v.gap,
    `${TOTALS.bank_covered - TOTALS.expected_covered} vs ${v.gap}`);

  /* Absent with a reason: excluding two months is right, dropping them in
     silence is the same failure pointing the other way. */
  check('the two excluded months are named in the sub-line',
    v.excluded === TOTALS.not_comparable_rows && /2 months/.test(v.sub),
    `${v.excluded} · ${v.sub}`);
  for (const why of TOTALS.not_comparable_reasons) {
    check(`…with the reason "${why.slice(0, 34)}…" stated`, v.sub.includes(why), v.sub);
  }

  /* ── one paragraph, one claim about what "both sides" buys you ───────────
     The sub-line used to say "only where both exist is there anything to
     compare" and then, a clause later, that two months carry both sides and
     still cannot be compared. Both sentences are defensible and together they
     read as a contradiction. The property is that the paragraph states the
     both-sides requirement ONCE, and states it as a requirement rather than
     as a guarantee — so the sufficiency phrasing must be gone while the
     excluded months are still named. */
  check('the both-sides rule is stated as a requirement, not as a guarantee',
    !/anything to compare/.test(v.sub) && /needs both sides/.test(v.sub), v.sub);
  check('…and it is stated once, so the excluded clause does not contradict it',
    v.sub.split('both side').length - 1 === 2
    && /A further 2 months/.test(v.sub), v.sub);
}

/* ── a payload where nothing can be compared ──────────────────────────────
   A gap of zero here would read as "the platforms paid exactly what they
   owed", which is the opposite of what an empty comparison means. */
console.log('\nnothing comparable is said, not scored as agreement');
{
  const v = headlineVerdict({ rows: ROWS.slice(0, 16),
    totals: { ...TOTALS, reconciled_rows: 0, delta: null, delta_pct: null,
      expected_covered: null, bank_covered: null,
      not_comparable_rows: 0, not_comparable_reasons: [] } }, null);
  check('the gap is absent rather than 0', v.gap === null, String(v.gap));
  check('and the band does not read as agreement',
    v.tone === 'warn' && !/more wired than owed/.test(v.unit), `${v.tone} ${v.unit}`);
  check('…nor does it claim any period was reconciled',
    v.comparable === 0 && /Nothing/.test(v.claim), v.claim);
}

/* ── nothing comparable AND periods excluded, the combination ─────────────
   The fixture above sets not_comparable_rows to 0, so the two states were
   never rendered together and the clause that joins them was never read.
   Driven directly it said: "Nothing in this range can be reconciled" over
   "A further 2 months carry both sides and still cannot be compared. They are
   left out of the figure above because …". Two falsehoods in one clause —
   further than nothing, and left out of a figure the band did not print, the
   figure slot reading "0 of 24 comparable". The state, not the sentence:
   whenever the band prints no gap, nothing in the sub-line may count on from
   a comparison or point at a figure above, and the excluded periods must
   still be named with their reasons. */
console.log('\nnothing comparable, and the excluded periods still named');
{
  const v = headlineVerdict({ rows: ROWS,
    totals: { ...TOTALS, reconciled_rows: 0, delta: null, delta_pct: null,
      expected_covered: null, bank_covered: null } }, null);
  check('the gap is absent and no period is claimed reconciled',
    v.gap === null && v.comparable === 0 && /Nothing/.test(v.claim),
    `${v.gap} · ${v.claim}`);
  check('the excluded months are still counted and named',
    v.excluded === TOTALS.not_comparable_rows && /2 months/.test(v.sub)
    && TOTALS.not_comparable_reasons.every((w) => v.sub.includes(w)), v.sub);
  check('nothing is described as further than a comparison that did not happen',
    !/further/i.test(v.sub), v.sub);
  check('…and no reason points the reader at a figure the band never printed',
    !/figure above/.test(v.sub) && v.figure === `0 of ${ROWS.length}`,
    `${v.figure} · ${v.sub}`);
}

/* ── the days that have not happened yet ──────────────────────────────────
   The third exclusion, and the one the band named for nobody.
   api/reconcile_routes.js:544 drops accrual rows before it splits the rest
   into reconciled and not-comparable, so they appear in neither counter and
   only in totals.accrual_rows.

   This fixture is /api/reconcile?month=2026-09 as production served it on
   2026-09-05, verbatim: thirty day rows, five of them settled and reconciled,
   twenty-five dated after today. Six days carry each side — the sixth is
   6 September, AED 14,061.78 expected against AED 12,673.86 bank, an accrual
   whose delta the endpoint nulls — so the band said "5 days of 30" above a
   sentence saying six days carry both, and accounted for neither the sixth
   nor the other twenty-four.

   The property is that every period is accounted for: reconciled, excluded as
   not comparable, or named as not yet happened. */
console.log('\nthe days that have not happened yet are named, not dropped');
{
  const day = (d, over) => ({ d, expected_payout: null, bank_payout: null,
    expected_covered: null, bank_covered: null, delta: null, delta_pct: null,
    statement_partial: false, period_cut: false, accrual: false, ...over });
  const SETTLED = [
    ['2026-09-01', 14061.78, 19429.74, 5367.96],
    ['2026-09-02', 14061.78, 24283.98, 10222.20],
    ['2026-09-03', 14061.78, 24546.77, 10484.99],
    ['2026-09-04', 14061.78, 25913.23, 11851.45],
    ['2026-09-05', 14061.78, 21817.69, 7755.91],
  ];
  const DAYS = [
    ...SETTLED.map(([d, ec, bc, dl]) => day(d, { expected_payout: ec, bank_payout: bc,
      expected_covered: ec, bank_covered: bc, delta: dl })),
    // 6 September: both halves present, delta nulled, dropped before the split.
    day('2026-09-06', { accrual: true, expected_payout: 14061.78, bank_payout: 12718.29,
      expected_covered: 14061.78, bank_covered: 12673.86 }),
    ...Array.from({ length: 24 }, (_, i) => day(`2026-09-${String(i + 7).padStart(2, '0')}`,
      { accrual: true })),
  ];
  const DAY_TOTALS = { trips: 3715, expected_payout: 70308.90, bank_payout: 116213.56,
    expected_covered: 70308.90, bank_covered: 115991.41, matched_pairs: 1374,
    reconciled_rows: 5, not_comparable_rows: 0, not_comparable_reasons: [],
    accrual_rows: 25, delta: 45682.51, delta_pct: 65 };

  check('the fixture is the payload the endpoint would serve',
    DAYS.length === 30 && DAYS.filter((x) => x.accrual).length === DAY_TOTALS.accrual_rows
    && r2(SETTLED.reduce((a, x) => a + x[3], 0)) === DAY_TOTALS.delta
    && r2(SETTLED.reduce((a, x) => a + x[2], 0)) === DAY_TOTALS.bank_covered,
    `${DAYS.length} rows`);

  const v = headlineVerdict({ grain: 'day', month: '2026-09', rows: DAYS,
    totals: DAY_TOTALS }, '2026-09');

  check('the accrual rows are read off the endpoint, not inferred',
    v.accrued === DAY_TOTALS.accrual_rows, String(v.accrued));
  check('…and counted in the sub-line, in the grain’s own unit',
    /25 days/.test(v.sub) && !/25 months/.test(v.sub), v.sub);
  check('…with the reason stated rather than left as a silent drop',
    /not happened yet/.test(v.sub) && /forward projection/.test(v.sub), v.sub);
  /* The whole point of the fix, as arithmetic a reader can do on the band
     alone: five reconciled, none excluded as not comparable, twenty-five not
     yet happened, thirty rows. Nothing is dropped without being named. */
  check('every one of the 30 days is accounted for by the band’s own numbers',
    v.comparable + v.excluded + v.accrued === DAYS.length,
    `${v.comparable} + ${v.excluded} + ${v.accrued} vs ${DAYS.length}`);
  check('and the gap is still only over the five settled days',
    v.gap === DAY_TOTALS.delta && /5 days of 30/.test(v.claim),
    `${v.gap} · ${v.claim}`);
}

/* ── one excluded period, and the day grain ───────────────────────────────
   The same band renders inside a month, where the periods are days. The
   sub-line has to agree with itself about number. */
console.log('\nthe sentence agrees with its own counts at day grain');
{
  const v = headlineVerdict({
    rows: Array.from({ length: 30 }, (_, i) => row(`2026-08-${String(i + 1).padStart(2, '0')}`)),
    totals: { ...TOTALS, reconciled_rows: 1, delta: -250.5,
      not_comparable_rows: 1,
      not_comparable_reasons: ['the month is still inside an open report period'] },
  }, '2026-08');
  check('one comparable day is called a day, not a month',
    /1 day of 30/.test(v.claim), v.claim);
  check('one excluded day too, in the singular',
    /A further 1 day carries both sides/.test(v.sub), v.sub);
  check('a negative gap is described as less wired than owed',
    v.gap === -250.5 && v.unit === 'less wired than owed', `${v.gap} ${v.unit}`);
  /* One reason, so the tail cannot say "neither" — the endpoint sends one
     entry per distinct cause and a month can have only one. */
  check('…and a single reason is written in the singular',
    /which is not a discrepancy/.test(v.sub) && !/none of which/.test(v.sub), v.sub);
  check('…and a settled month says nothing about days that have not happened',
    v.accrued === 0 && !/not happened yet/.test(v.sub), v.sub);
}

/* ── an endpoint that has not been redeployed yet ─────────────────────────
   The page and the API ship together, but a cached body from before
   not_comparable_rows and accrual_rows existed must not throw or invent a
   sub-clause. */
console.log('\nan older payload degrades quietly');
{
  const v = headlineVerdict({ rows: ROWS,
    totals: { reconciled_rows: 6, delta: 117617.20 } }, null);
  check('no excluded clause is written when the endpoint sends no count',
    v.excluded === 0 && !/A further/.test(v.sub), v.sub);
  check('and no accrual clause either',
    v.accrued === 0 && !/not happened yet/.test(v.sub), v.sub);
  check('and the gap still comes from delta', v.gap === 117617.20, String(v.gap));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
