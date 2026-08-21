/* The adjudicator, which is the only reason the analyst layer is allowed to exist.
   ──────────────────────────────────────────────────────────────────────────
   A language model asked what is interesting about a fleet will always answer,
   and the answer will always read well. Every assertion below is one way that
   fluency could reach an operator as if it were a finding:

     - a claim that points the wrong way, backed by a large difference;
     - a claim that is true about nine trips;
     - a claim that is true, large, and entirely within what the sample size
       would produce by chance;
     - a metric or a dimension the model invented;
     - a segment value that does not exist;
     - and a segment value shaped like an injection.

   None of these may become a confirmed finding. The verdicts that reject them
   carry the numbers that did the rejecting, because "the model said X and the
   data says otherwise" is worth being able to read. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { adjudicate, parseProposals, twoProportionP, welchP, METRICS, DIMENSIONS, MATERIALITY }
  from '../src/analyst.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── direction ────────────────────────────────────────────────────────── */
{
  const p = { metric: 'completion_pct', dimension: 'settlement', segment: 'cash', direction: 'lower' };
  const wrongWay = adjudicate(p, { measured_value: 96, baseline_value: 80, segment_n: 900, baseline_n: 900, p_value: 0.0001 });
  check('a claim that points the wrong way is refuted however big the gap',
    wrongWay.verdict === 'refuted', JSON.stringify(wrongWay));
  check('the refutation states both numbers',
    /96.*80|80.*96/.test(wrongWay.verdict_reason), wrongWay.verdict_reason);
  const rightWay = adjudicate(p, { measured_value: 70, baseline_value: 92, segment_n: 900, baseline_n: 900, p_value: 0.0001 });
  check('a claim that points the right way and clears the floors is confirmed',
    rightWay.verdict === 'confirmed', JSON.stringify(rightWay));
}

/* ── size ─────────────────────────────────────────────────────────────── */
{
  const p = { metric: 'completion_pct', dimension: 'driver', segment: 'A Driver', direction: 'lower' };
  const tiny = adjudicate(p, { measured_value: 40, baseline_value: 92, segment_n: 9, baseline_n: 4000, p_value: 0.001 });
  check('a true claim about nine trips is immaterial, not confirmed',
    tiny.verdict === 'immaterial', JSON.stringify(tiny));
  check('the immateriality is explained with the row counts', /9 rows/.test(tiny.verdict_reason), tiny.verdict_reason);
  const noBase = adjudicate(p, { measured_value: 40, baseline_value: 92, segment_n: 900, baseline_n: 4, p_value: 0.001 });
  check('a segment with nothing to compare against is immaterial too', noBase.verdict === 'immaterial');
}

/* ── effect ───────────────────────────────────────────────────────────── */
{
  const p = { metric: 'completion_pct', dimension: 'daypart', segment: 'night', direction: 'lower' };
  const small = adjudicate(p, { measured_value: 91, baseline_value: 92, segment_n: 5000, baseline_n: 5000, p_value: 0.0001 });
  check('a one-point difference is immaterial even at n = 5,000 and p < 0.001',
    small.verdict === 'immaterial', JSON.stringify(small));
  check('the floor that rejected it is named in the reason',
    /below the floor/.test(small.verdict_reason), small.verdict_reason);
  const money = adjudicate({ metric: 'avg_fare', dimension: 'property', segment: 'Palm Grand', direction: 'lower' },
    { measured_value: 108, baseline_value: 111, segment_n: 700, baseline_n: 550, p_value: 0.01 });
  check('a three-dirham difference in average fare is below the money floor',
    money.verdict === 'immaterial', JSON.stringify(money));
}

/* ── chance ───────────────────────────────────────────────────────────── */
{
  const p = { metric: 'cancel_pct', dimension: 'weekday', segment: 'Friday', direction: 'higher' };
  const noisy = adjudicate(p, { measured_value: 14, baseline_value: 8, segment_n: 40, baseline_n: 40, p_value: 0.4 });
  check('a large difference that the sample size explains is immaterial',
    noisy.verdict === 'immaterial', JSON.stringify(noisy));
  check('the p-value that rejected it is quoted', /p = 0\.4/.test(noisy.verdict_reason), noisy.verdict_reason);
  const real = adjudicate(p, { measured_value: 14, baseline_value: 8, segment_n: 4000, baseline_n: 9000, p_value: 0.0001 });
  check('the same difference at scale is confirmed', real.verdict === 'confirmed', JSON.stringify(real));
  check('a confirmed finding quotes its own p-value', /p = /.test(real.verdict_reason), real.verdict_reason);
}

/* ── no measurement is not a pass ─────────────────────────────────────── */
{
  const p = { metric: 'avg_fare', dimension: 'platform', segment: 'uber', direction: 'lower' };
  const none = adjudicate(p, { segment_n: 0, baseline_n: 900 });
  check('a segment the metric is undefined over is unsupported, never confirmed',
    none.verdict === 'unsupported', JSON.stringify(none));
  check('the reason says which metric could not be measured where',
    /average fare/.test(none.verdict_reason) && /uber/.test(none.verdict_reason), none.verdict_reason);
  check('an unknown metric is unsupported rather than crashing',
    adjudicate({ metric: 'vibes', dimension: 'platform', segment: 'uber', direction: 'lower' }, {}).verdict === 'unsupported');
  // A missing p-value means "no test was possible", and must never read as
  // "the test passed".
  const noP = adjudicate({ metric: 'avg_deadhead_km', dimension: 'property', segment: 'Palm Grand', direction: 'higher' },
    { measured_value: 6, baseline_value: 2, segment_n: 500, baseline_n: 500, p_value: null });
  check('a claim with no applicable test is judged on size alone, not waved through on p',
    noP.verdict === 'confirmed' && !/p = /.test(noP.verdict_reason), noP.verdict_reason);
}

/* ── what the model is allowed to say ─────────────────────────────────── */
{
  const { proposals, rejected } = parseProposals(JSON.stringify([
    { claim: 'Cash trips complete less often', metric: 'completion_pct', dimension: 'settlement',
      segment: 'cash', direction: 'lower', claimed_value: 78, why: 'w', action: 'a' },
    { claim: 'Uber earns more per trip', metric: 'profit_margin', dimension: 'platform', segment: 'uber', direction: 'higher' },
    { claim: 'Something about the moon', metric: 'avg_km', dimension: 'lunar_phase', segment: 'waxing', direction: 'higher' },
    { claim: 'No segment', metric: 'avg_km', dimension: 'platform', segment: '', direction: 'higher' },
    { claim: 'Sideways', metric: 'avg_km', dimension: 'platform', segment: 'uber', direction: 'sideways' },
    { metric: 'avg_km', dimension: 'platform', segment: 'uber', direction: 'higher' },
  ]));
  check('a well-formed proposal survives', proposals.length === 1, String(proposals.length));
  check('an invented metric is dropped with a reason',
    rejected.some((r) => /metric not in the allowlist: profit_margin/.test(r.reason)));
  check('an invented dimension is dropped with a reason',
    rejected.some((r) => /dimension not in the allowlist: lunar_phase/.test(r.reason)));
  check('a proposal with no segment is dropped', rejected.some((r) => /no segment/.test(r.reason)));
  check('a direction other than higher or lower is dropped', rejected.some((r) => /higher or lower/.test(r.reason)));
  check('a proposal with no claim is dropped', rejected.some((r) => /no claim/.test(r.reason)));
  check('prose instead of JSON yields nothing rather than throwing',
    parseProposals('I think the fleet is doing great!').proposals.length === 0);
  check('malformed JSON yields nothing rather than throwing',
    parseProposals('[{"claim": ').proposals.length === 0);
}

/* ── the statistics ───────────────────────────────────────────────────── */
{
  check('an identical pair of proportions is not significant',
    twoProportionP(50, 100, 50, 100) > 0.9, String(twoProportionP(50, 100, 50, 100)));
  check('a large, well-sampled difference is significant',
    twoProportionP(300, 1000, 500, 1000) < 0.001, String(twoProportionP(300, 1000, 500, 1000)));
  check('the same difference at n = 10 is not', twoProportionP(3, 10, 5, 10) > 0.05,
    String(twoProportionP(3, 10, 5, 10)));
  check('a proportion test with an empty side returns no p-value, not zero',
    twoProportionP(0, 0, 5, 10) === null);
  check('a mean comparison with no spread returns no p-value',
    welchP(10, null, 100, 12, 2, 100) === null);
  check('two clearly separated means are significant',
    welchP(10, 1, 200, 14, 1, 200) < 0.001, String(welchP(10, 1, 200, 14, 1, 200)));
  check('two overlapping means are not', welchP(10, 6, 30, 11, 6, 30) > 0.05,
    String(welchP(10, 6, 30, 11, 6, 30)));
}

/* ── the measurement is composed, never interpolated ──────────────────── */
{
  const src = readFileSync('src/analyst.js', 'utf8');
  // Inside measure() — the only function that builds SQL from a proposal —
  // the segment must reach Postgres as $4 and never as text.
  const measureSrc = src.slice(src.indexOf('export async function measure'),
    src.indexOf('export async function buildBrief'));
  check('the segment value is bound as a parameter, never interpolated into SQL',
    /\(\$\{dim\}\) = \$4/.test(measureSrc)
    && !/\$\{proposal\.segment\}/.test(measureSrc)
    && /proposal\.segment\]/.test(measureSrc));
  check('a rate metric is two predicates, not two aggregates — a doubled FILTER is invalid SQL',
    Object.values(METRICS).filter((m) => m.kind === 'rate').every((m) => !/count\(/.test(m.num)));
  check('the model is told it may not invent a metric', /MUST be one of/.test(src));
  check('the model is told the Uber export has no fare', /Uber\s+trip export has NO fare/.test(src));
  check('the brief carries aggregates only — no rows, no names of passengers',
    !/guest_id/.test(src) && !/pickup_addr/.test(src) && !/room_no/.test(src));
  check('every metric declares the population it is defined over',
    Object.values(METRICS).every((m) => m.where && m.unit && m.label));
  check('the materiality thresholds are visible constants, not buried literals',
    MATERIALITY.minSegmentN > 0 && MATERIALITY.minRelEffect > 0 && MATERIALITY.maxP > 0);
}

/* ── end to end against a real database ───────────────────────────────── */
{
  const db = new PGlite();
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
    'schema_v6.sql', 'schema_v7.sql', 'schema_v9.sql', 'schema_v10.sql'])
    await db.exec(readFileSync(`sql/${f}`, 'utf8'));

  // 400 card trips completing 95% of the time, 400 cash trips completing 70%.
  let n = 0;
  const add = (pay, ok, i) => q(
    `INSERT INTO trip (platform,external_id,fleet_id,plate,requested_at,status,payment_type,distance_km,price)
     VALUES ('uber',$1,'ecosine','L1',$2,$3,$4,10,NULL)`,
    [`t${n++}`, `2026-08-${String(1 + (i % 20)).padStart(2, '0')}T10:00:00+04:00`,
      ok ? 'completed' : 'rider_cancelled', pay]);
  for (let i = 0; i < 400; i++) await add('braintree', i % 20 !== 0, i);
  for (let i = 0; i < 400; i++) await add('cash', i % 10 > 2, i);

  // The real measure() talks to the shared pool, so the composition is
  // exercised here directly against PGlite with the same SQL.
  const metric = METRICS.completion_pct, dim = DIMENSIONS.settlement;
  const rows = await q(
    `SELECT count(*) FILTER (WHERE (${metric.num}) AND (${dim}) = $4)::int seg_x,
            count(*) FILTER (WHERE (${metric.den}) AND (${dim}) = $4)::int seg_n,
            count(*) FILTER (WHERE (${metric.num}) AND NOT ((${dim}) = $4))::int base_x,
            count(*) FILTER (WHERE (${metric.den}) AND NOT ((${dim}) = $4))::int base_n
     FROM trip_ext
     WHERE local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR fleet_id = $3)
       AND ${metric.where}`, ['2026-08-01', '2026-08-31', null, 'cash']);
  const r = rows[0];
  const m = { measured_value: (r.seg_x / r.seg_n) * 100, baseline_value: (r.base_x / r.base_n) * 100,
    segment_n: r.seg_n, baseline_n: r.base_n, p_value: twoProportionP(r.seg_x, r.seg_n, r.base_x, r.base_n) };
  check('the composed measurement finds both sides', r.seg_n === 400 && r.base_n === 400, JSON.stringify(r));
  check('it measures the real difference', Math.round(m.measured_value) === 70 && Math.round(m.baseline_value) === 95,
    `${m.measured_value} / ${m.baseline_value}`);
  const v = adjudicate({ metric: 'completion_pct', dimension: 'settlement', segment: 'cash', direction: 'lower' }, m);
  check('and the whole path confirms a real, large, well-sampled claim', v.verdict === 'confirmed', JSON.stringify(v));

  // A segment shaped like an injection is a value, not code.
  const inj = await q(
    `SELECT count(*)::int n FROM trip_ext WHERE (${dim}) = $1`, [`cash' OR '1'='1`]);
  check('a segment shaped like an injection matches nothing and changes nothing',
    inj[0].n === 0 && (await q('SELECT count(*)::int n FROM trip'))[0].n === 800);

  check('a finding table exists to store the verdict beside the claim',
    (await q(`SELECT to_regclass('analyst_finding') IS NOT NULL AS ok`))[0].ok);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
