/* ── the banner that re-added the months the tile beneath it excluded ──────
   #reconcile opens with a verdict band and, about 150 pixels below it, a Gap
   tile. Both name the same quantity: how far the money the platforms wired
   sits from what their own statements say they owed. On production 2026-09-05
   they disagreed by 3.4x.

     banner   "8 months of 24 can be reconciled at all" / AED 400,594
              / MORE WIRED THAN OWED
     Gap tile "+AED 117,564 · 7.0% — AED 1,805,453 banked against
              AED 1,687,889 expected, on those driver-days alone"
     endpoint totals.delta 117563.54, totals.reconciled_rows 6,
              totals.not_comparable_rows 2

   The endpoint agrees with the tile. The banner was re-deriving its own gap
   over every row carrying both halves, which is not the predicate
   api/reconcile_routes.js:594 reconciles on — that one also requires
   !statement_partial && !period_cut, because a month Uber will no longer
   serve a statement for, and a month still inside an open report period, both
   carry two halves that are not comparable. The page greys exactly those rows
   in the table below and the banner added them back, so the largest number on
   the page reported this product's own collection horizon as platform
   variance.

   These tests pin the PROPERTY — the band's figure is the endpoint's delta and
   its count is the endpoint's reconciled_rows — rather than any sentence, so a
   later rewording cannot make them pass while the arithmetic drifts again. */
import { headlineVerdict } from '../api/public/reconcile.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Digits only, so the assertion survives a change of currency prefix, of
   thousands separator or of the sign glyph. */
const digits = (s) => String(s).replace(/[^\d]/g, '');

/* ── production's own shape, /api/reconcile on 2026-09-05 ─────────────────
   Six reconcilable months, two the endpoint marked not comparable — February
   is retention-limited (statement_partial) and September is mid-report-period
   (period_cut) — and sixteen months with nothing on one side or the other.
   The two excluded rows carry both covered halves, which is precisely why the
   old local filter swept them in. */
const row = (m, over) => ({ m, expected_payout: 100, bank_payout: 100,
  expected_covered: 100, bank_covered: 120, delta: 20, delta_pct: 20,
  statement_partial: false, period_cut: false, accrual: false, ...over });

const ROWS = [
  ...Array.from({ length: 16 }, (_, i) => row(`2025-${String(i % 12 + 1).padStart(2, '0')}`,
    { expected_payout: null, expected_covered: null, bank_covered: null, delta: null })),
  ...Array.from({ length: 6 }, (_, i) => row(`2026-0${i + 1}`,
    { expected_covered: 281314.86, bank_covered: 300908.79, delta: 19593.92 })),
  // February: Uber no longer serves part of the month's statement.
  row('2026-02', { expected_covered: 120000, bank_covered: 260000, delta: 140000,
    statement_partial: true }),
  // September: the compared span cuts an open weekly report period.
  row('2026-09', { expected_covered: 14775, bank_covered: 158805, delta: 143030,
    period_cut: true }),
];

const TOTALS = {
  trips: 100000, expected_payout: 1856354, bank_payout: 2380282,
  expected_covered: 1687889.18, bank_covered: 1805452.72,
  matched_pairs: 48470,
  reconciled_rows: 6,
  not_comparable_rows: 2,
  not_comparable_reasons: ['part of the month is outside Uber’s statement window',
    'the month is still inside an open report period'],
  accrual_rows: 0,
  delta: 117563.54, delta_pct: 7,
};

const PAYLOAD = { grain: 'month', month: null, rows: ROWS, totals: TOTALS };

console.log('the banner is the endpoint’s arithmetic, not its own');
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
    Math.round((TOTALS.bank_covered - TOTALS.expected_covered) * 100) / 100 === v.gap,
    `${TOTALS.bank_covered - TOTALS.expected_covered} vs ${v.gap}`);

  /* Absent with a reason: excluding two months is right, dropping them in
     silence is the same failure pointing the other way. */
  check('the two excluded months are named in the sub-line',
    v.excluded === TOTALS.not_comparable_rows && /2 months/.test(v.sub),
    `${v.excluded} · ${v.sub}`);
  for (const why of TOTALS.not_comparable_reasons) {
    check(`…with the reason "${why.slice(0, 34)}…" stated`, v.sub.includes(why), v.sub);
  }
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
}

/* ── an endpoint that has not been redeployed yet ─────────────────────────
   The page and the API ship together, but a cached body from before
   not_comparable_rows existed must not throw or invent a sub-clause. */
console.log('\nan older payload degrades quietly');
{
  const v = headlineVerdict({ rows: ROWS,
    totals: { reconciled_rows: 6, delta: 117563.54 } }, null);
  check('no excluded clause is written when the endpoint sends no count',
    v.excluded === 0 && !/A further/.test(v.sub), v.sub);
  check('and the gap still comes from delta', v.gap === 117563.54, String(v.gap));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
