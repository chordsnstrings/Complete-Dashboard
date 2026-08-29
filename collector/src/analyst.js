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
  /* btrim, because to_char's 'Day' pads to nine characters — 'Monday   '.
     Without it `(dim) = 'Monday'` is false for every row in the table, so a
     weekday claim could only ever come back "no rows for weekday = Monday".
     Every weekday proposal the model has ever made was unanswerable, and the
     verdict said so in a way that read like a fact about the fleet. */
  weekday: `btrim(to_char(requested_at AT TIME ZONE 'Asia/Dubai', 'Day'))`,
  hour: 'local_hour::text',
  property: 'partner_name',
  zone: 'zone',
  booking_type: 'product',
  vehicle: 'plate',
  driver: 'driver_name',
};

/* ── claims the definitions already settle ────────────────────────────────
   A metric measured on the dimension it is DERIVED from is a tautology, and a
   tautology confirms with an enormous effect: "Black-tier trips are more often
   on a premium tier" is true, unfalsifiable, and would sit at the top of the
   findings list above everything an operator could act on. is_premium_tier is
   computed from uber_tier (schema_v18), and `product` carries the same values
   for Uber rows, so both dimensions are the metric restated. settlement_class
   = 'cash' IS the numerator of cash_pct.

   Asked not to, the model proposed premium_pct × tier anyway on the first run
   with the rule in the prompt — so it is refused here instead, where a rule
   holds whatever the model does. */
export const TAUTOLOGIES = {
  premium_pct: ['tier', 'booking_type'],
  cash_pct: ['settlement'],
};

/* ── materiality ──────────────────────────────────────────────────────────
   The rules that decide whether a true statement is worth an operator's
   attention. They are deliberately blunt and deliberately visible: a
   threshold nobody can read is a threshold nobody can argue with. */
export const MATERIALITY = {
  minSegmentN: 30,        // fewer rows than this and the estimate is noise
  minBaselineN: 30,
  /* Applied to unbounded units only — see adjudicate(). A percentage point is
     already an absolute scale, and requiring 15% OF a rate that sits near 100
     makes a ten-point gap immaterial by arithmetic. */
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
  /* A rate near the ceiling can never clear a RELATIVE floor.
     ─────────────────────────────────────────────────────────────────────────
     Uber completes 88.3% of its bookings against 99.2% everywhere else, over
     11,645 trips, p < 0.0001 — and the first real pass filed it immaterial,
     because 10.9 points is only 11% of 99.2 and the rule wanted 15%. The same
     rule buried the hotel channel's 99.7% against 88.3%. Both are the largest
     quality facts on this fleet.

     Relative change is the right test for an unbounded quantity, where 3 AED
     on a 500 AED base is noise. It is the wrong test for something measured in
     percentage points and living near 100, where the absolute floor already
     says what matters: three points of completion is three points whether the
     base is 12% or 99%. So percentage metrics are judged on the absolute floor
     alone, and everything else on both. */
  const relApplies = metric.unit !== '%';
  if (Math.abs(effect) < absFloor
      || (relApplies && relEffect != null && relEffect < MATERIALITY.minRelEffect)) {
    return { verdict: 'immaterial',
      verdict_reason: `${fmt(m.measured_value)}${metric.unit} against ${fmt(m.baseline_value)}${metric.unit} — `
        + `a difference of ${fmt(Math.abs(effect))}${metric.unit}, below the floor of `
        + `${absFloor}${metric.unit}${relApplies ? ` or ${Math.round(MATERIALITY.minRelEffect * 100)}%` : ''} `
        + 'that makes it worth acting on' };
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
/* Every top-level [...] in the text, by bracket matching rather than by a
   greedy regex.
   ─────────────────────────────────────────────────────────────────────────
   `text.match(/\[[\s\S]*\]/)` spans the FIRST open bracket to the LAST close
   one, which is a single array only when the model emits a single array.
   MiniMax-M3, asked for twelve proposals against the real brief, emitted a
   complete array, then wrote "Wait — I should drop the two inert entries",
   then emitted a corrected one. The greedy match swallowed the prose between
   them and the whole run parsed to nothing: a model that checks its own work
   produced zero findings and the page reported a quiet night.

   Brackets inside strings do not count, so the scan tracks quoting and
   escapes. The LAST array that parses wins, because a model that revises
   itself puts its answer last. */
export function jsonArrays(text) {
  const s = String(text || '');
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '[') { if (depth === 0) start = i; depth++; continue; }
    if (c === ']') {
      depth--;
      if (depth === 0 && start >= 0) { out.push(s.slice(start, i + 1)); start = -1; }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

export function parseProposals(text) {
  /* Reasoning models may interleave a think block; it is not the answer. */
  const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const blocks = jsonArrays(clean);
  if (!blocks.length) return { proposals: [], rejected: [{ reason: 'no JSON array in the response' }] };
  let arr = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(blocks[i]);
      if (Array.isArray(v)) { arr = v; break; }
    } catch { /* try the one before it */ }
  }
  if (!arr) return { proposals: [], rejected: [{ reason: 'unparseable JSON' }] };
  const proposals = [], rejected = [];
  for (const p of arr) {
    const claim = String(p.claim || '').trim();
    if (!claim) { rejected.push({ raw: p, reason: 'no claim' }); continue; }
    if (!METRICS[p.metric]) { rejected.push({ raw: p, reason: `metric not in the allowlist: ${p.metric}` }); continue; }
    if (!DIMENSIONS[p.dimension]) { rejected.push({ raw: p, reason: `dimension not in the allowlist: ${p.dimension}` }); continue; }
    if ((TAUTOLOGIES[p.metric] || []).includes(p.dimension)) {
      rejected.push({ raw: p, reason: `${p.metric} is derived from ${p.dimension} — the claim is true by definition` });
      continue;
    }
    if (!String(p.segment || '').trim()) { rejected.push({ raw: p, reason: 'no segment named' }); continue; }
    if (!['higher', 'lower'].includes(p.direction)) { rejected.push({ raw: p, reason: `direction must be higher or lower` }); continue; }
    proposals.push({
      claim: claim.slice(0, 400),
      why: String(p.why || '').slice(0, 400) || null,
      action: String(p.action || '').slice(0, 400) || null,
      metric: p.metric, dimension: p.dimension,
      segment: String(p.segment).slice(0, 120), direction: p.direction,
      /* An exact zero is the model's placeholder, not an estimate.
         ─────────────────────────────────────────────────────────────────────
         Asked for "a number or null", MiniMax-M3 writes 0 when it is not
         estimating — four of eleven proposals in one production pass — and the
         finding card prints the field beside the measurement, so every one of
         them read "the model said 0 AED; the measurement says 156.8 AED": a
         prediction it never made, shown as one it got badly wrong. Told not
         to in the prompt, it still did.

         A genuine estimate of exactly zero is not worth protecting here. The
         segment has rows or the claim would not have been proposed, so a real
         zero would be a claim that a live segment completes none of its trips
         or earns nothing at all — and that claim survives as the CLAIM, which
         is what the reader acts on. The estimate is decoration beside a
         measurement; a decoration that lies is worse than an absent one. */
      claimed_value: Number.isFinite(Number(p.claimed_value)) && Number(p.claimed_value) !== 0
        ? Number(p.claimed_value) : null,
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
  /* The baseline is `IS DISTINCT FROM`, not `NOT (= )`.
     ─────────────────────────────────────────────────────────────────────────
     `NOT (dim = $4)` is NULL wherever the dimension is NULL, so those rows
     count toward neither side. On any dimension that only some rows carry —
     partner_name is set on hotel bookings alone, uber_tier on Uber alone —
     that silently changes the question: "this property completes worse than
     the rest of the fleet" was measured as "…than the other hotel bookings",
     while the verdict sentence beneath it said "across the other N trips".
     The claim and the measurement have to be the same claim. */
  const outSeg = `(${dim}) IS DISTINCT FROM $4`;

  if (metric.kind === 'rate') {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE (${metric.num}) AND ${inSeg})::int       AS seg_x,
         count(*) FILTER (WHERE (${metric.den}) AND ${inSeg})::int       AS seg_n,
         count(*) FILTER (WHERE (${metric.num}) AND ${outSeg})::int      AS base_x,
         count(*) FILTER (WHERE (${metric.den}) AND ${outSeg})::int      AS base_n
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
       avg(${metric.val}) FILTER (WHERE ${outSeg})            AS base_m,
       stddev_samp(${metric.val}) FILTER (WHERE ${outSeg})    AS base_s,
       count(${metric.val}) FILTER (WHERE ${outSeg})::int     AS base_n
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
/* `db` is injectable for the same reason rebuildCustody's is: the brief is
   read-only aggregate SQL, and a route or a test that already holds a
   connection should not have to reach for the module-level pool to see what
   the model was shown. */
export async function buildBrief([from, to, fleet], { db = pool } = {}) {
  const p = [from, to, fleet];
  const W = `local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR fleet_id = $3)`;
  const q = (t) => db.query(t, p).then((r) => r.rows);
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
    db.query(
      `SELECT source, count(*)::int days, sum(rows)::int rows
       FROM source_day_coverage WHERE day BETWEEN $1::date AND $2::date GROUP BY 1`, [from, to])
      .then((r) => r.rows),
  ]);
  /* The segments that can actually be proposed on.
     ─────────────────────────────────────────────────────────────────────────
     The prompt told the model to pick a dimension from a list of twelve and a
     segment "spelled exactly as it appears in the brief" — and the brief
     enumerated values for five of them. For the other seven the model had to
     invent a spelling, and an invented spelling measures zero rows and comes
     back "unsupported": a run that looks like the fleet has nothing to say
     when it is really the prompt that could not be followed.

     So the brief now carries the candidate list itself, straight out of the
     same DIMENSIONS map the measurement composes from — every value with at
     least the materiality floor of rows behind it, capped per dimension so a
     high-cardinality one cannot crowd out the rest. A proposal against this
     list can be wrong about the fleet, which is the point, but it cannot be
     wrong about what the fleet contains. */
  /* Where each metric is defined at all.
     ─────────────────────────────────────────────────────────────────────────
     A metric's population is not the window. avg_deadhead_km exists only on
     rows that carry an approach leg, and on this fleet that is the hotel
     channel — so "hotel trips deadhead less than the rest" has an EMPTY
     complement and cannot be settled by anything. The model proposed exactly
     that on the first run against real figures. It is not a wrong claim, it
     is an unanswerable one, and the brief now says so before it is made. */
  const metricCoverage = Object.fromEntries((await Promise.all(
    Object.entries(METRICS).map(async ([name, m]) => {
      const [row] = await q(
        `SELECT count(*)::int AS n,
                array_agg(DISTINCT platform ORDER BY platform) AS platforms
           FROM trip_ext WHERE ${W} AND ${m.where}`).catch(() => [null]);
      return [name, row ? { rows: row.n, platforms: row.platforms || [], unit: m.unit } : null];
    }))).filter(([, v]) => v && v.rows));

  const candidates = await Promise.all(Object.entries(DIMENSIONS).map(async ([name, expr]) => {
    const rows = await q(
      `SELECT (${expr})::text AS segment, count(*)::int AS n
         FROM trip_ext WHERE ${W} AND (${expr}) IS NOT NULL
        GROUP BY 1 HAVING count(*) >= ${MATERIALITY.minSegmentN}
        ORDER BY 2 DESC LIMIT ${CANDIDATES_PER_DIMENSION}`).catch(() => []);
    return [name, rows];
  }));

  return { window: [from, to], fleet: fleet || 'both', headline: headline[0], by_platform: byDim,
    uber_tier_by_daypart: tiers, settlement: settle, properties: hotels, by_daypart: dayparts,
    coverage,
    metric_coverage: metricCoverage,
    candidates: Object.fromEntries(candidates.filter(([, rows]) => rows.length)) };
}

/* Enough for a model to find the interesting one, few enough that two hundred
   plates do not become most of the prompt. */
const CANDIDATES_PER_DIMENSION = 12;

const SYSTEM = `You are a fleet analyst for a Dubai limousine and ride-hailing operator.
You will be given aggregate figures for one window, and a list of the segments that can be
measured. Propose specific, testable claims about where this fleet is losing money or leaving
it on the table.

Each claim is settled by a query the operator's code composes — you never write SQL, and the
numbers you guess at are not what gets stored. What gets stored is the measurement and whether
it agreed with you, so a confident claim that the data refutes costs more than a cautious one
that holds.

Rules you must follow exactly:
- Every claim must be a comparison between ONE named segment and every other record in the
  window — not against a hand-picked comparison group. "Cash trips cancel more" is checked as
  cash trips against all non-cash trips where the metric is defined.
- metric MUST be one of: {METRICS}
- dimension and segment MUST be one of the pairs listed under "candidates" in the brief,
  copied exactly — same dimension key, same segment string, character for character. The
  candidate list is generated from the same query the measurement runs, so anything not on it
  measures zero rows and is thrown away unmeasured.
- direction is "higher" or "lower" — how the segment compares to everything else.
- Every candidate already clears the 30-record floor. Prefer segments with more rows behind
  them: a claim about 34 trips survives measurement far less often than one about 3,400.
- Do not propose anything the brief does not contain the numbers for. In particular, the Uber
  trip export has NO fare, so no claim about Uber money is checkable.
- The fleet is largely electric and has charging stations in these areas: {CHARGING_SITES}. Idle
  or dwell time in one of those areas is NOT evidence of a car waiting for work — it mixes
  waiting with refuelling, and the data cannot separate the two because it matches an address
  string, not a plug event. Do not claim those areas are over-supplied, and do not propose
  moving cars out of them. A claim about time spent in a charging area is only useful if it is
  about something other than idleness.
- A candidate's record count is over the WHOLE window. Inside a metric's own population it can
  be far smaller — settlement=wallet has thousands of trips and thirteen with a fare on them,
  because Uber publishes no fare. Check metric_coverage before pairing a metric with a segment
  that mostly lives outside it.
- "metric_coverage" says where each metric is defined and which platforms carry it. A claim is
  only settleable if BOTH sides exist inside that population: if a metric is carried by one
  platform alone, a claim about that platform has no complement to compare against and is
  discarded unmeasured. Use such a metric on a dimension that varies WITHIN its population
  instead — by property or by daypart, not by platform.
- Prefer claims an operator could act on this week over interesting-but-inert observations.
- A claim is only worth making if it would still be worth acting on when true. The measurement
  discards anything under a 15% relative difference, so do not propose one you expect to be
  marginal — spend the twelve slots on the segments the brief makes look most extreme.
- Do not propose the same segment twice on the same metric, and never propose one the metric's
  own definition guarantees: premium_pct is computed FROM the tier, and cash_pct FROM the
  settlement class, so a claim pairing them is true whatever the fleet does. Those pairs are
  refused before they are measured.

- Spread the twelve slots: at most three claims on any one metric and at most three on any one
  dimension. Five variations on one channel's fares is one finding wearing five hats, and the
  dimensions with the most operational leverage — vehicle, driver, hour, weekday — are the ones
  a summary table never shows.

Output the JSON array and nothing else: no prose before it, no commentary after it, and no
second revised array. If you reconsider, edit the array before you emit it.

Return ONLY a JSON array, at most 12 items:
[{"claim":"...","metric":"...","dimension":"...","segment":"...","direction":"higher|lower",
  "claimed_value":<number or null>,"why":"one sentence on the consequence","action":"one sentence on what to do"}]

claimed_value is your estimate of the segment's own value in the metric's unit, and null when
you are not estimating one. Write null rather than 0: the finding prints your number beside the
measured one, and a placeholder zero reads as a prediction that the segment earns nothing.`;

export async function propose(brief) {
  if (!config.analystModel?.apiKey) {
    log.warn(SRC, 'no analyst model key — the analyst cannot propose, only measure');
    return { proposals: [], rejected: [{ reason: 'no model configured' }],
      model: null, outcome: 'no_model', error: 'no ANALYST_API_KEY is set for the component that runs the analyst' };
  }
  /* A fact about the fleet the numbers cannot carry. Without it the model
     reads a charging session as an over-supplied area and proposes moving the
     cars away from the only place they can refuel — which the measurement
     would then confirm, because the dwell time is real. */
  const sites = config.chargingSites;
  const prompt = SYSTEM
    .replace('{METRICS}', Object.keys(METRICS).join(', '))
    .replace('{DIMENSIONS}', Object.keys(DIMENSIONS).join(', '))
    .replace('{CHARGING_SITES}', sites.length ? sites.join(', ') : 'none recorded');
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
    ({ data } = await http(`${config.analystModel.baseUrl}/chat/completions`, {
      method: 'POST', timeoutMs: 120000, retries: 1,
      headers: { authorization: `Bearer ${config.analystModel.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.analystModel.model,
        messages: [{ role: 'system', content: prompt },
          { role: 'user', content: JSON.stringify(brief) }],
        max_tokens: 3000, temperature: 0.4,
        /* MiniMax's M-series reasons by default on the OpenAI-compatible
           surface, which spends the token budget on a think block this caller
           throws away and pushes a 36-second call toward the 120-second
           timeout. Sent only where it is understood: an unknown field is a
           400 on a stricter server, and the analyst has already spent one
           production outage on a request that never returned. */
        ...(/minimax/i.test(config.analystModel.baseUrl || '')
          ? { thinking: { type: 'disabled' } } : {}),
      }),
    }));
  } catch (e) {
    const err = String(e?.message || e).slice(0, 200);
    log.error(SRC, 'model call failed', { err, model: config.analystModel.model });
    return { proposals: [], rejected: [{ reason: err }],
      model: config.analystModel.model, outcome: 'failed', error: err };
  }
  /* A body that is not the shape asked for is a failure too. A 429 answers
     with an error object and no choices, and reading that as "no proposals"
     is how a rate limit became a quiet night. */
  if (!data?.choices?.length) {
    const err = String(data?.error?.message || data?.message
      || (typeof data === 'string' ? data.slice(0, 160) : JSON.stringify(data || {}).slice(0, 160)))
      || 'the model returned no choices';
    log.error(SRC, 'model returned nothing usable', { err, model: config.analystModel.model });
    return { proposals: [], rejected: [{ reason: err }],
      model: config.analystModel.model, outcome: 'failed', error: err };
  }
  const txt = data?.choices?.[0]?.message?.content || '';
  return { ...parseProposals(txt), model: config.analystModel.model, outcome: null, error: null };
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
       proposed, dropped, confirmed, model, error, duration_ms, started_at, finished_at,
       dropped_reasons)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now(), $13)
     ON CONFLICT (run_id) DO UPDATE SET outcome = EXCLUDED.outcome,
       proposed = EXCLUDED.proposed, dropped = EXCLUDED.dropped,
       confirmed = EXCLUDED.confirmed, model = EXCLUDED.model, error = EXCLUDED.error,
       duration_ms = EXCLUDED.duration_ms, finished_at = now(),
       dropped_reasons = EXCLUDED.dropped_reasons`,
    [runId, from, to, fleet,
      outcome || (proposals.length ? 'ok' : 'empty'),
      proposals.length, rejected.length, kept, model,
      error ? String(error).slice(0, 400) : null,
      Date.now() - startedAt.getTime(), startedAt,
      /* Distinct, because twelve proposals refused for one reason is one
         problem and reads as twelve. */
      rejected.length
        ? [...new Set(rejected.map((r) => String(r.reason || 'unknown')))].join('; ').slice(0, 600)
        : null])
    .catch((e) => log.warn(SRC, 'could not record the run', { err: String(e).slice(0, 120) }));
  log.info(SRC, 'run complete', { run: runId, proposed: proposals.length, confirmed: kept });
  return { run_id: runId, brief, proposed: proposals.length, dropped: rejected,
    findings: out, outcome: outcome || (proposals.length ? 'ok' : 'empty'), error: error || null };
}
