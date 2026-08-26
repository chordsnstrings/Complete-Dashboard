/* The analyst: a model proposes, the database adjudicates.
   ──────────────────────────────────────────────────────────────────────────
   Asked "what is interesting about this fleet", a language model always
   answers, and the answer is always fluent. That is the failure mode, not the
   feature. Three constraints turn it into something an operator can act on:

   1. THE MODEL NEVER WRITES A QUERY. It picks a metric, a dimension and a
      segment from the fixed allowlists below. The measurement is composed from
      those by code, so a proposal is a hypothesis in a form the database can
      settle — not prose that has to be believed.

   2. EVERY CLAIM IS MEASURED AGAINST ITS OWN COMPLEMENT. "Cash trips complete
      less often" is checked as: cash trips complete at X%, every other trip in
      the same window completes at Y%, n on each side, and a two-proportion
      z-test between them. The numbers are stored beside the claim.

   3. TRUE IS NOT ENOUGH. A statement about eleven trips is not a finding, and
      a two-percent difference on a metric that swings ten points a week is not
      either. `immaterial` is a verdict in its own right and is recorded, not
      discarded, so the same claim does not come back next run looking new.

   What survives is a small number of statements that are true, large, and
   attached to the numbers that make them true. What does not survive is kept
   with the reason it failed, because "the model said X and the data says
   otherwise" is itself worth being able to read. */

import { pool } from './db.js';
import { config } from './config.js';
import { http } from './http.js';
import { log } from './log.js';

const SRC = 'analyst';

/* ── the allowlists ───────────────────────────────────────────────────────
   A rate metric is two PREDICATES — which rows count toward the numerator and
   which toward the denominator. Not two aggregate expressions: the measurement
   has to add a segment predicate to each one, and `count(*) FILTER (...)
   FILTER (...)` is not valid SQL. A mean metric is a value expression.

   `where` names the population the metric is defined over. Asking for an
   average fare across telematics rows is not a hard question, it is a
   meaningless one, and the segment measurement must not answer it with a
   number. */
export const METRICS = {
  completion_pct: {
    kind: 'rate', label: 'completion rate',
    num: `outcome = 'completed'`,
    den: `outcome IS NOT NULL`,
    where: 'is_booking AND outcome IS NOT NULL',
    unit: '%',
  },
  cancel_pct: {
    kind: 'rate', label: 'cancellation rate',
    num: `outcome = 'not_completed'`,
    den: `outcome IS NOT NULL`,
    where: 'is_booking AND outcome IS NOT NULL',
    unit: '%',
  },
  cash_pct: {
    kind: 'rate', label: 'share settled in cash',
    num: `settlement_class = 'cash'`,
    den: `settlement_class IS NOT NULL`,
    where: 'is_booking AND settlement_class IS NOT NULL',
    unit: '%',
  },
  premium_pct: {
    kind: 'rate', label: 'share on a premium Uber tier',
    num: `is_premium_tier`,
    den: `is_premium_tier IS NOT NULL`,
    where: `platform = 'uber' AND is_premium_tier IS NOT NULL`,
    unit: '%',
  },
  scheduled_pct: {
    kind: 'rate', label: 'share booked in advance',
    num: `is_scheduled`,
    den: `is_scheduled IS NOT NULL`,
    where: 'is_scheduled IS NOT NULL',
    unit: '%',
  },
  avg_fare: {
    kind: 'mean', label: 'average fare',
    val: 'price',
    where: 'is_booking AND price IS NOT NULL AND NOT is_complimentary',
    unit: 'AED',
  },
  avg_km: {
    kind: 'mean', label: 'average trip distance',
    val: 'distance_km',
    where: 'has_distance',
    unit: 'km',
  },
  avg_minutes: {
    kind: 'mean', label: 'average trip duration',
    val: 'duration_s / 60.0',
    where: 'duration_s IS NOT NULL AND duration_s BETWEEN 60 AND 43200',
    unit: 'min',
  },
  avg_deadhead_km: {
    kind: 'mean', label: 'unpaid approach distance',
    val: 'deadhead_km',
    where: 'deadhead_km IS NOT NULL',
    unit: 'km',
  },
};

export const DIMENSIONS = {
  platform: 'platform',
  fleet: 'fleet_id',
  settlement: 'settlement_class',
  tier: 'uber_tier',
  daypart: 'daypart',
  weekday: `to_char(requested_at AT TIME ZONE 'Asia/Dubai', 'Day')`,
  hour: 'local_hour::text',
  property: 'partner_name',
  zone: 'zone',
  booking_type: 'product',
  vehicle: 'plate',
  driver: 'driver_name',
};

/* ── materiality ──────────────────────────────────────────────────────────
   The rules that decide whether a true statement is worth an operator's
   attention. They are deliberately blunt and deliberately visible: a
   threshold nobody can read is a threshold nobody can argue with. */
export const MATERIALITY = {
  minSegmentN: 30,        // fewer rows than this and the estimate is noise
  minBaselineN: 30,
  minRelEffect: 0.15,     // the segment must differ from the rest by 15%+
  minAbsEffect: { '%': 3, AED: 5, km: 0.5, min: 2 },
  maxP: 0.05,             // where a test applies at all
};

/* Two-proportion z-test. Returns a two-sided p-value. Pure. */
export function twoProportionP(x1, n1, x2, n2) {
  if (!n1 || !n2) return null;
  const p1 = x1 / n1, p2 = x2 / n2;
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  return 2 * (1 - normCdf(Math.abs((p1 - p2) / se)));
}

/* Welch's t, normal-approximated. Exact enough at the sample sizes here, and
   honest about needing a spread: with no standard deviation there is no test,
   and the caller is told that rather than shown a p-value of nothing. */
export function welchP(m1, s1, n1, m2, s2, n2) {
  if (!n1 || !n2 || s1 == null || s2 == null) return null;
  const se = Math.sqrt((s1 * s1) / n1 + (s2 * s2) / n2);
  if (!se) return null;
  return 2 * (1 - normCdf(Math.abs((m1 - m2) / se)));
}

// Abramowitz & Stegun 26.2.17 — plenty of precision for a 0.05 threshold.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  return 1 - p;
}

/* Given a proposal and the two measurements, decide. Pure, so the rules can be
   argued with in a test rather than discovered in production. */
export function adjudicate(proposal, m) {
  const metric = METRICS[proposal.metric];
  if (!metric) return { verdict: 'unsupported', verdict_reason: `no such metric: ${proposal.metric}` };
  if (m.segment_n == null || m.segment_n === 0) {
    return { verdict: 'unsupported',
      verdict_reason: `no rows for ${proposal.dimension} = ${proposal.segment} where ${metric.label} is defined` };
  }
  if (m.segment_n < MATERIALITY.minSegmentN || m.baseline_n < MATERIALITY.minBaselineN) {
    return { verdict: 'immaterial',
      verdict_reason: `${m.segment_n} rows in the segment against ${m.baseline_n} elsewhere — `
        + `below the ${MATERIALITY.minSegmentN}-row floor, so the difference is not distinguishable from noise` };
  }

  const effect = m.measured_value - m.baseline_value;
  const relEffect = m.baseline_value ? Math.abs(effect / m.baseline_value) : null;
  const wanted = proposal.direction === 'lower' ? -1 : 1;

  // Direction first: a claim that points the wrong way is refuted, however
  // large the difference is.
  if (Math.sign(effect) !== wanted && Math.abs(effect) > 1e-9) {
    return { verdict: 'refuted',
      verdict_reason: `${metric.label} for ${proposal.segment} is ${fmt(m.measured_value)}${metric.unit}, `
        + `${effect > 0 ? 'higher' : 'lower'} than the ${fmt(m.baseline_value)}${metric.unit} elsewhere — `
        + `the claim says ${proposal.direction}` };
  }

  const absFloor = MATERIALITY.minAbsEffect[metric.unit] ?? 0;
  if (Math.abs(effect) < absFloor || (relEffect != null && relEffect < MATERIALITY.minRelEffect)) {
    return { verdict: 'immaterial',
      verdict_reason: `${fmt(m.measured_value)}${metric.unit} against ${fmt(m.baseline_value)}${metric.unit} — `
        + `a difference of ${fmt(Math.abs(effect))}${metric.unit}, below the floor of `
        + `${absFloor}${metric.unit} or ${Math.round(MATERIALITY.minRelEffect * 100)}% that makes it worth acting on` };
  }
  if (m.p_value != null && m.p_value > MATERIALITY.maxP) {
    return { verdict: 'immaterial',
      verdict_reason: `the ${fmt(Math.abs(effect))}${metric.unit} difference is within what ${m.segment_n} `
        + `and ${m.baseline_n} rows would produce by chance (p = ${m.p_value.toFixed(3)})` };
  }
  return { verdict: 'confirmed',
    verdict_reason: `${metric.label} for ${proposal.segment} is ${fmt(m.measured_value)}${metric.unit} against `
      + `${fmt(m.baseline_value)}${metric.unit} across the other ${fmt(m.baseline_n, 0)} `
      + `${metric.kind === 'rate' ? 'trips' : 'records'}`
      + (m.p_value != null ? ` (p = ${m.p_value < 0.001 ? '<0.001' : m.p_value.toFixed(3)})` : '') };
}

const fmt = (v, d = 1) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));

/* Keep only the proposals the code can actually check, and normalise them.
   A model that invents a metric name gets its proposal dropped here with a
   reason, rather than producing an unsupported row for every run. */
export function parseProposals(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return { proposals: [], rejected: [{ reason: 'no JSON array in the response' }] };
  let arr;
  try { arr = JSON.parse(m[0]); } catch (e) { return { proposals: [], rejected: [{ reason: 'unparseable JSON' }] }; }
  const proposals = [], rejected = [];
  for (const p of Array.isArray(arr) ? arr : []) {
    const claim = String(p.claim || '').trim();
    if (!claim) { rejected.push({ raw: p, reason: 'no claim' }); continue; }
    if (!METRICS[p.metric]) { rejected.push({ raw: p, reason: `metric not in the allowlist: ${p.metric}` }); continue; }
    if (!DIMENSIONS[p.dimension]) { rejected.push({ raw: p, reason: `dimension not in the allowlist: ${p.dimension}` }); continue; }
    if (!String(p.segment || '').trim()) { rejected.push({ raw: p, reason: 'no segment named' }); continue; }
    if (!['higher', 'lower'].includes(p.direction)) { rejected.push({ raw: p, reason: `direction must be higher or lower` }); continue; }
    proposals.push({
      claim: claim.slice(0, 400),
      why: String(p.why || '').slice(0, 400) || null,
      action: String(p.action || '').slice(0, 400) || null,
      metric: p.metric, dimension: p.dimension,
      segment: String(p.segment).slice(0, 120), direction: p.direction,
      claimed_value: Number.isFinite(Number(p.claimed_value)) ? Number(p.claimed_value) : null,
    });
  }
  return { proposals, rejected };
}

/* ── measurement ─────────────────────────────────────────────────────────
   One query per proposal, composed from the allowlists. The segment value is
   the only caller-influenced part and it is bound, never interpolated. */
export async function measure(proposal, [from, to, fleet]) {
  const metric = METRICS[proposal.metric];
  const dim = DIMENSIONS[proposal.dimension];
  const base = `FROM trip_ext
    WHERE local_day BETWEEN $1::date AND $2::date
      AND ($3::text IS NULL OR fleet_id = $3)
      AND ${metric.where}`;
  const inSeg = `(${dim}) = $4`;

  if (metric.kind === 'rate') {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE (${metric.num}) AND ${inSeg})::int       AS seg_x,
         count(*) FILTER (WHERE (${metric.den}) AND ${inSeg})::int       AS seg_n,
         count(*) FILTER (WHERE (${metric.num}) AND NOT (${inSeg}))::int AS base_x,
         count(*) FILTER (WHERE (${metric.den}) AND NOT (${inSeg}))::int AS base_n
       ${base}`, [from, to, fleet, proposal.segment]);
    const r = rows[0] || {};
    if (!r.seg_n || !r.base_n) return { segment_n: r.seg_n || 0, baseline_n: r.base_n || 0 };
    return {
      measured_value: (r.seg_x / r.seg_n) * 100,
      baseline_value: (r.base_x / r.base_n) * 100,
      segment_n: r.seg_n, baseline_n: r.base_n,
      p_value: twoProportionP(r.seg_x, r.seg_n, r.base_x, r.base_n),
    };
  }

  const { rows } = await pool.query(
    `SELECT
       avg(${metric.val}) FILTER (WHERE ${inSeg})            AS seg_m,
       stddev_samp(${metric.val}) FILTER (WHERE ${inSeg})    AS seg_s,
       count(${metric.val}) FILTER (WHERE ${inSeg})::int     AS seg_n,
       avg(${metric.val}) FILTER (WHERE NOT (${inSeg}))         AS base_m,
       stddev_samp(${metric.val}) FILTER (WHERE NOT (${inSeg})) AS base_s,
       count(${metric.val}) FILTER (WHERE NOT (${inSeg}))::int  AS base_n
     ${base}`, [from, to, fleet, proposal.segment]);
  const r = rows[0] || {};
  if (!r.seg_n || !r.base_n) return { segment_n: r.seg_n || 0, baseline_n: r.base_n || 0 };
  return {
    measured_value: +r.seg_m, baseline_value: +r.base_m,
    segment_n: r.seg_n, baseline_n: r.base_n,
    p_value: welchP(+r.seg_m, r.seg_s == null ? null : +r.seg_s, r.seg_n,
      +r.base_m, r.base_s == null ? null : +r.base_s, r.base_n),
  };
}

/* ── the brief ───────────────────────────────────────────────────────────
   What the model is allowed to see. Aggregates only — no rows, no names of
   guests, no addresses, no phone numbers — and every figure already correct
   by the rules in schema_v7/v9, so the model is reasoning about the same
   numbers the dashboard shows rather than a second, worse version of them. */
export async function buildBrief([from, to, fleet]) {
  const p = [from, to, fleet];
  const W = `local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR fleet_id = $3)`;
  const q = (t) => pool.query(t, p).then((r) => r.rows);
  const [headline, byDim, tiers, settle, hotels, dayparts, coverage] = await Promise.all([
    q(`SELECT count(*) FILTER (WHERE is_booking)::int bookings,
              count(*) FILTER (WHERE NOT is_booking)::int telematics,
              count(*) FILTER (WHERE outcome = 'completed')::int completed,
              count(*) FILTER (WHERE outcome IS NOT NULL)::int bookable,
              round(avg(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::numeric, 2) avg_fare,
              count(*) FILTER (WHERE price IS NOT NULL)::int priced,
              count(DISTINCT plate)::int vehicles, count(DISTINCT driver_name)::int drivers
       FROM trip_ext WHERE ${W}`),
    q(`SELECT platform, count(*)::int n,
              round(100.0 * count(*) FILTER (WHERE outcome = 'completed')
                    / nullif(count(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) completion_pct,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km
       FROM trip_ext WHERE ${W} GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT uber_tier AS tier, daypart, count(*)::int n
       FROM trip_ext WHERE ${W} AND uber_tier IS NOT NULL GROUP BY 1, 2 ORDER BY n DESC LIMIT 25`),
    q(`SELECT settlement_class, count(*)::int n,
              round(avg(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::numeric, 2) avg_fare
       FROM trip_ext WHERE ${W} AND settlement_class IS NOT NULL GROUP BY 1 ORDER BY n DESC`),
    q(`SELECT partner_name, count(*)::int n,
              round(avg(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary)::numeric, 2) avg_fare,
              round(avg(deadhead_km)::numeric, 2) avg_deadhead_km,
              round(100.0 * count(*) FILTER (WHERE is_scheduled) / nullif(count(*), 0), 1) scheduled_pct
       FROM trip_ext WHERE ${W} AND partner_name IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 12`),
    q(`SELECT daypart, count(*)::int n,
              round(100.0 * count(*) FILTER (WHERE outcome = 'not_completed')
                    / nullif(count(*) FILTER (WHERE outcome IS NOT NULL), 0), 1) cancel_pct,
              round(avg(distance_km) FILTER (WHERE has_distance)::numeric, 1) avg_km
       FROM trip_ext WHERE ${W} GROUP BY 1 ORDER BY n DESC`),
    pool.query(
      `SELECT source, count(*)::int days, sum(rows)::int rows
       FROM source_day_coverage WHERE day BETWEEN $1::date AND $2::date GROUP BY 1`, [from, to])
      .then((r) => r.rows),
  ]);
  return { window: [from, to], fleet: fleet || 'both', headline: headline[0], by_platform: byDim,
    uber_tier_by_daypart: tiers, settlement: settle, properties: hotels, by_daypart: dayparts,
    coverage };
}

const SYSTEM = `You are a fleet analyst for a Dubai limousine and ride-hailing operator.
You will be given aggregate figures for one window. Propose specific, testable claims about
where this fleet is losing money or leaving it on the table.

Rules you must follow exactly:
- Every claim must be a comparison between ONE named segment and the rest of the fleet.
- metric MUST be one of: {METRICS}
- dimension MUST be one of: {DIMENSIONS}
- segment MUST be a value that appears in the brief for that dimension, spelled exactly as it appears.
- direction is "higher" or "lower" — how the segment compares to everything else.
- Do not propose a claim about a segment with fewer than 30 records in the brief.
- Do not propose anything the brief does not contain the numbers for. In particular, the Uber
  trip export has NO fare, so no claim about Uber money is checkable.
- Prefer claims an operator could act on this week over interesting-but-inert observations.

Return ONLY a JSON array, at most 12 items:
[{"claim":"...","metric":"...","dimension":"...","segment":"...","direction":"higher|lower",
  "claimed_value":<number or null>,"why":"one sentence on the consequence","action":"one sentence on what to do"}]`;

export async function propose(brief) {
  if (!config.modelark?.apiKey) {
    log.warn(SRC, 'no ARK_API_KEY — the analyst cannot propose, only measure');
    return { proposals: [], rejected: [{ reason: 'no model configured' }],
      model: null, outcome: 'no_model', error: 'no ARK_API_KEY is set for the component that runs the analyst' };
  }
  const prompt = SYSTEM
    .replace('{METRICS}', Object.keys(METRICS).join(', '))
    .replace('{DIMENSIONS}', Object.keys(DIMENSIONS).join(', '));
  /* The call is allowed to fail, and saying so is the whole point.
     ─────────────────────────────────────────────────────────────────────────
     This threw, analystPass caught it, logged it and returned null, and the
     Action list then reported the analyst as quiet. Production spent an
     unknown number of nights in that state: the collector log for
     2026-08-26 shows a 429 from the model endpoint followed by a 120-second
     abort on the retry, while every page said the analyst simply had nothing
     to add. A generator that cannot run is a different fact from a generator
     with no findings, and only one of them is somebody's job to fix. */
  let data;
  try {
    ({ data } = await http(`${config.modelark.baseUrl}/chat/completions`, {
      method: 'POST', timeoutMs: 120000, retries: 1,
      headers: { authorization: `Bearer ${config.modelark.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.modelark.model,
        messages: [{ role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(brief) }],
        max_tokens: 3000, temperature: 0.4,
      }),
    }));
  } catch (e) {
    const err = String(e?.message || e).slice(0, 200);
    log.error(SRC, 'model call failed', { err, model: config.modelark.model });
    return { proposals: [], rejected: [{ reason: err }],
      model: config.modelark.model, outcome: 'failed', error: err };
  }
  /* A body that is not the shape asked for is a failure too. A 429 answers
     with an error object and no choices, and reading that as "no proposals"
     is how a rate limit became a quiet night. */
  if (!data?.choices?.length) {
    const err = String(data?.error?.message || data?.message
      || (typeof data === 'string' ? data.slice(0, 160) : JSON.stringify(data || {}).slice(0, 160)))
      || 'the model returned no choices';
    log.error(SRC, 'model returned nothing usable', { err, model: config.modelark.model });
    return { proposals: [], rejected: [{ reason: err }],
      model: config.modelark.model, outcome: 'failed', error: err };
  }
  const txt = data?.choices?.[0]?.message?.content || '';
  return { ...parseProposals(txt), model: config.modelark.model, outcome: null, error: null };
}

/* One full pass: brief → propose → measure → adjudicate → store. */
export async function runAnalyst({ from, to, fleet = null } = {}) {
  const runId = `an-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const startedAt = new Date();
  const win = [from, to, fleet];
  const brief = await buildBrief(win);
  const { proposals, rejected, model, outcome, error } = await propose(brief);
  log.info(SRC, 'proposals', { n: proposals.length, dropped: rejected.length });

  const out = [];
  for (const p of proposals) {
    let m, decision;
    try {
      m = await measure(p, win);
      decision = adjudicate(p, m);
    } catch (e) {
      m = {};
      decision = { verdict: 'unsupported', verdict_reason: `the measurement failed: ${String(e).slice(0, 120)}` };
    }
    const effect = m.measured_value != null && m.baseline_value != null
      ? m.measured_value - m.baseline_value : null;
    const row = {
      run_id: runId, window_start: from, window_end: to, fleet_id: fleet,
      claim: p.claim, why: p.why, action: p.action,
      check_kind: METRICS[p.metric].kind === 'rate' ? 'rate_gap' : 'mean_gap',
      metric: p.metric, dimension: p.dimension, segment: p.segment, direction: p.direction,
      claimed_value: p.claimed_value,
      measured_value: m.measured_value ?? null, baseline_value: m.baseline_value ?? null,
      segment_n: m.segment_n ?? null, baseline_n: m.baseline_n ?? null,
      effect, effect_pct: effect != null && m.baseline_value ? (effect / m.baseline_value) * 100 : null,
      p_value: m.p_value ?? null,
      verdict: decision.verdict, verdict_reason: decision.verdict_reason, model,
    };
    const cols = Object.keys(row);
    await pool.query(
      `INSERT INTO analyst_finding (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
      cols.map((c) => row[c]));
    out.push(row);
  }
  const kept = out.filter((r) => r.verdict === 'confirmed').length;
  /* The pass itself is recorded, whether or not it produced a finding — see
     sql/schema_v35.sql. Without this row an empty Action list cannot say
     whether the analyst is quiet, unconfigured or broken, and production sat
     in the third state reporting the first. */
  await pool.query(
    `INSERT INTO analyst_run (run_id, window_start, window_end, fleet_id, outcome,
       proposed, dropped, confirmed, model, error, duration_ms, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (run_id) DO UPDATE SET outcome = EXCLUDED.outcome,
       proposed = EXCLUDED.proposed, dropped = EXCLUDED.dropped,
       confirmed = EXCLUDED.confirmed, model = EXCLUDED.model, error = EXCLUDED.error,
       duration_ms = EXCLUDED.duration_ms, finished_at = now()`,
    [runId, from, to, fleet,
      outcome || (proposals.length ? 'ok' : 'empty'),
      proposals.length, rejected.length, kept, model,
      error ? String(error).slice(0, 400) : null,
      Date.now() - startedAt.getTime(), startedAt])
    .catch((e) => log.warn(SRC, 'could not record the run', { err: String(e).slice(0, 120) }));
  log.info(SRC, 'run complete', { run: runId, proposed: proposals.length, confirmed: kept });
  return { run_id: runId, brief, proposed: proposals.length, dropped: rejected,
    findings: out, outcome: outcome || (proposals.length ? 'ok' : 'empty'), error: error || null };
}
