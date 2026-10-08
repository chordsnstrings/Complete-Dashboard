/* THE MONTH TARGET PAGE — every day against its target, where the month lands,
   and the drivers behind.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-08: "next to target there should be a page for monthly
   view of the target, per day … daily targets, gross revenue from all
   platforms, how much was missed every day on one graph … At the bottom, let's
   keep drivers who didn't earn target gross fare, or trip numbers, 30 of them,
   downloadable as an excel … each driver has a target based on the month's
   target, and we should know who is achieving that and who's not. In the same
   page, we should also focus on what our current trajectory would mean for the
   end of the month and how short or more we would be from the target."

   Nothing here re-derives the month: the days, their targets and verdicts are
   api/revenue_target.js computeMonth over the same span (monthSpan), so this
   page and the Target page cannot disagree about a day.

   ── A DRIVER'S TARGET, and why it is this rule ───────────────────────────────
   The month's target is already spread over its days (each day's PLAN: AED a
   car a day × the cars that earned in the week before it), and the trips
   minimum already asks every ACTIVE driver for 12 a day — active meaning a
   completed trip in the 8 Dubai days up to and including the day, the 08:00
   email's rule (driversActiveOn). A driver's targets follow the same two rules
   and nothing new:

     money   each counted day's plan, shared equally among that day's active
             drivers. A driver's target is the sum of their shares; their gross
             is their fares on every platform, before any commission, on the
             same days.
     trips   the minimum (12) for every counted day they were active.

   So the drivers' money targets ADD UP to the fleet's plan for those days —
   every active driver reaching theirs is the fleet reaching its plan, which is
   what "a target based on the month's target" has to mean. The plan and not
   the re-spread "needed": a shortfall raises the fleet's remaining days, and
   charging it to drivers as well would count it twice.

   COUNTED DAYS are the month's past days that are SETTLED (every channel
   delivered, 99% priced). A day Uber has not finished pricing would make every
   driver look short by fares that have not been published; it is left out and
   named instead, with its reason.

   Fares on a booking that names no driver belong to nobody's row. They are
   counted and printed, so the drivers' total and the fleet's total reconcile
   instead of silently disagreeing.

   ── THE TRAJECTORY ──────────────────────────────────────────────────────────
   Two paces, each said in AED short of or over the target:
     · the average day so far × the days in the month — exactly the Target
       page's "At this pace the month ends at" (summary.month_end_pace), so
       the two pages agree;
     · the last 7 settled days' average, carried over the days left — the
       "current trajectory", which a slow start or a recent change moves.
   And what every day left must bring to land the target (per_day_left). */
import {
  computeMonth, loadFacts, targetRows, monthSpan, tripsMin, driversActiveOn, monthOf, validMonth,
} from './revenue_target.js';
import { personKeyStored } from './custody_sql.js';
import { dubaiDay } from './window.js';
import { Workbook } from '../src/xlsx_write.js';

/* The operator's number: the drivers furthest behind, on the page and in each
   behind sheet of the file. */
export const SHOW_BEHIND = 30;
/* "The current trajectory": the last week's settled days. */
export const RECENT_DAYS = 7;

const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/* ── what the database holds, per person per day ─────────────────────────── */
/** Completed trips and gross fares per person per day, and who each person
    is. The person is the stored fold every other driver count uses
    (revenue_target loadFacts' personDays, the 08:00 email, #day), and the
    trips filter is personDays' own — completed, a named driver — so a
    driver's trips here are the trips the active rule was counted from. Gross
    is every priced booking the driver is named on, a charged cancellation
    included: it is money the fleet earned through them. */
export async function loadDriverDays(q, from, to) {
  const pk = personKeyStored('t');
  const [days, who] = await Promise.all([
    q(`SELECT to_char(n.local_day, 'YYYY-MM-DD') AS day, ${pk} AS pk,
              count(*) FILTER (WHERE n.outcome = 'completed')::int AS trips,
              coalesce(round(sum(n.price) FILTER (WHERE n.has_fare)::numeric, 2), 0)::float AS gross
         FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.driver_name IS NOT NULL
        GROUP BY 1, 2`, [from, to]),
    q(`SELECT ${pk} AS pk,
              coalesce(mode() WITHIN GROUP (ORDER BY n.driver_name), '(unnamed)') AS name,
              mode() WITHIN GROUP (ORDER BY t.driver_ext_id) AS driver_ext_id,
              mode() WITHIN GROUP (ORDER BY n.fleet_id) AS fleet,
              array_agg(DISTINCT n.platform ORDER BY n.platform) AS platforms
         FROM trip_norm n JOIN trip t ON t.platform = n.platform AND t.external_id = n.external_id
        WHERE n.local_day BETWEEN $1::date AND $2::date AND n.is_booking AND n.driver_name IS NOT NULL
        GROUP BY 1`, [from, to]),
  ]);
  const byDay = new Map();
  for (const r of days) {
    if (!byDay.has(r.day)) byDay.set(r.day, new Map());
    byDay.get(r.day).set(r.pk, { trips: Number(r.trips) || 0, gross: Number(r.gross) || 0 });
  }
  return { byDay, who: new Map(who.map((w) => [w.pk, w])) };
}

/* ── a driver's target, day by day ───────────────────────────────────────── */
/** Pure. `t` is computeMonth's answer, `facts` the loadFacts it was computed
    from (the active rule reads its personDays), `dd` loadDriverDays over the
    same span, `min` the trips a day. */
export function driverTargets({ t, facts, dd, min }) {
  const past = t.days.filter((d) => d.state === 'past');
  const counted = past.filter((d) => d.settled);
  const leftOut = past.filter((d) => !d.settled).map((d) => ({ day: d.day, label: d.label, why: d.why }));
  const hasTarget = !!t.target;
  const acc = new Map();
  const get = (pk) => {
    if (!acc.has(pk)) {
      acc.set(pk, { pk, days_active: 0, days_driven: 0, trips: 0, trips_target: 0,
        gross: 0, gross_target: hasTarget ? 0 : null });
    }
    return acc.get(pk);
  };
  let fleetGross = 0, planCounted = 0;
  const shares = [];
  for (const d of counted) {
    const active = driversActiveOn(facts, d.day);
    const share = hasTarget && d.plan != null && active.size ? d.plan / active.size : null;
    if (share != null) planCounted += d.plan;
    shares.push({ day: d.day, label: d.label, plan: d.plan, active: active.size, share: r2(share) });
    for (const pk of active) {
      const a = get(pk);
      a.days_active += 1;
      a.trips_target += min;
      if (share != null) a.gross_target += share;
    }
    for (const [pk, x] of dd.byDay.get(d.day) || []) {
      const a = get(pk);
      a.trips += x.trips;
      a.gross += x.gross;
      if (x.trips > 0) a.days_driven += 1;
    }
    fleetGross += Number(facts.days.get(d.day)?.fares || 0);
  }
  const rows = [...acc.values()].map((a) => {
    const w = dd.who.get(a.pk) || {};
    const grossTarget = a.gross_target == null ? null : r2(a.gross_target);
    const gross = r2(a.gross);
    return {
      pk: a.pk, name: w.name || '(unnamed)', driver_ext_id: w.driver_ext_id || null, fleet: w.fleet || null,
      platforms: w.platforms || [],
      days_active: a.days_active, days_driven: a.days_driven,
      gross, gross_target: grossTarget,
      gross_short: grossTarget == null ? null : r2(Math.max(0, grossTarget - gross)),
      gross_pct: grossTarget ? r1((100 * gross) / grossTarget) : null,
      money_on: grossTarget == null ? null : gross >= grossTarget - 0.005,
      trips: a.trips, trips_target: a.trips_target,
      trips_short: Math.max(0, a.trips_target - a.trips),
      trips_pct: a.trips_target ? r1((100 * a.trips) / a.trips_target) : null,
      trips_on: a.trips >= a.trips_target,
    };
  });
  /* Furthest behind first, money then trips — the order the page and the
     file's "behind on money" sheet both read. */
  rows.sort((a, b) => (b.gross_short ?? -1) - (a.gross_short ?? -1) || b.trips_short - a.trips_short
    || a.name.localeCompare(b.name));
  const driversGross = rows.reduce((s, r) => s + (r.gross || 0), 0);
  const n = (f) => rows.filter(f).length;
  return {
    min,
    through: counted.length ? counted[counted.length - 1].day : null,
    from: counted.length ? counted[0].day : null,
    counted_days: counted.length,
    left_out: leftOut,
    why: !past.length ? `Nothing of ${t.month_name} has finished yet — the first day is judged the morning after it.`
      : !counted.length ? 'No day of the month has settled yet, so no driver can be measured without counting fares that have not arrived.'
        : null,
    money_why: hasTarget ? null : t.why,
    shares,
    totals: {
      drivers: rows.length,
      money_on: hasTarget ? n((r) => r.money_on === true) : null,
      money_behind: hasTarget ? n((r) => r.money_on === false) : null,
      trips_on: n((r) => r.trips_on),
      trips_behind: n((r) => !r.trips_on),
      either_behind: n((r) => r.money_on === false || !r.trips_on),
      both_on: n((r) => (r.money_on !== false) && r.trips_on),
      plan: hasTarget ? r2(planCounted) : null,
      targets: hasTarget ? r2(rows.reduce((s, r) => s + (r.gross_target || 0), 0)) : null,
      fleet_gross: r2(fleetGross),
      drivers_gross: r2(driversGross),
      unattributed: r2(fleetGross - driversGross),
    },
    rows,
  };
}

/** The drivers furthest behind, by money or by trips. */
export function behind(rows, by = 'money', limit = SHOW_BEHIND) {
  const pool = by === 'trips' ? rows.filter((r) => !r.trips_on) : rows.filter((r) => r.money_on === false);
  const sorted = [...pool].sort(by === 'trips'
    ? (a, b) => b.trips_short - a.trips_short || (b.gross_short ?? 0) - (a.gross_short ?? 0) || a.name.localeCompare(b.name)
    : (a, b) => (b.gross_short ?? 0) - (a.gross_short ?? 0) || b.trips_short - a.trips_short || a.name.localeCompare(b.name));
  return sorted.slice(0, limit);
}

/* ── where the month lands ──────────────────────────────────────────────── */
/** Pure: the two paces, the gap each leaves, and the cumulative series the
    trajectory chart draws. Null when no target is set. */
export function trajectory(t) {
  const s = t.summary;
  if (!s) return null;
  const past = t.days.filter((d) => d.state === 'past');
  const recent = past.filter((d) => d.settled).slice(-RECENT_DAYS);
  const recentAvg = recent.length ? recent.reduce((x, d) => x + (d.earned || 0), 0) / recent.length : null;
  const left = s.days_left;   // today included
  const target = s.month_target;
  const gap = (v) => (v == null || target == null ? null : r2(v - target));
  const pct = (v) => (v == null || !target ? null : r1((100 * v) / target));
  const recentEnd = recentAvg == null ? null : s.earned + recentAvg * left;
  /* The chart: the target path (the plans added up), what was earned (past
     days only — today is not judged), and both paces from the last day
     gone to the month's end. */
  let cumPlan = 0, cumEarned = 0;
  const lastPast = past.length ? past[past.length - 1].day : null;
  const series = t.days.map((d, i) => {
    cumPlan += d.plan || 0;
    if (d.state === 'past') cumEarned += d.earned || 0;
    const ahead = lastPast && d.day > lastPast ? i + 1 - past.length : 0;
    return {
      day: d.day, label: d.label, state: d.state,
      plan_to_date: r2(cumPlan),
      earned_to_date: d.state === 'past' ? r2(cumEarned) : null,
      at_avg: lastPast && d.day >= lastPast && s.avg_day != null ? r2(s.earned + s.avg_day * ahead) : null,
      at_recent: lastPast && d.day >= lastPast && recentAvg != null ? r2(s.earned + recentAvg * ahead) : null,
    };
  });
  return {
    target,
    earned: s.earned,
    planned: s.planned,
    ahead: s.ahead,
    days_gone: s.days_gone,
    days_left: left,
    per_day_left: s.per_day_left,
    avg: s.avg_day == null ? null : {
      per_day: s.avg_day, days: s.days_gone, month_end: s.month_end_pace,
      vs_target: gap(s.month_end_pace), pct: s.pace_pct,
    },
    recent: recentAvg == null ? null : {
      per_day: r2(recentAvg), days: recent.length, from: recent[0].day, to: recent[recent.length - 1].day,
      month_end: r2(recentEnd), vs_target: gap(recentEnd), pct: pct(recentEnd),
    },
    /* A past day not settled yet counts at what is on record, the way the
       Target page counts it — so both paces may read low until it settles,
       and the page says so with the day's own reason (a channel still to
       deliver it, or Uber's fares still arriving), never a guessed one. */
    unsettled: past.filter((d) => !d.settled).map((d) => ({ day: d.day, label: d.label, coverage: d.coverage, why: d.why })),
    series,
  };
}

/* ── the page's one answer ───────────────────────────────────────────────── */
export async function monthView(q, { month = null, today = null, now = new Date(), min = null } = {}) {
  const day = today || dubaiDay(now);
  const m = validMonth(month) ? month : monthOf(day);
  const { from, to } = monthSpan(m, day);
  const trips = min ?? await tripsMin(q);
  const [rows, facts, dd] = await Promise.all([targetRows(q, m), loadFacts(q, from, to), loadDriverDays(q, from, to)]);
  return monthViewOf({ month: m, today: day, rows, facts, dd, min: trips });
}

/* ── the file ────────────────────────────────────────────────────────────── */
/* What the page shows, as an .xlsx: the month, the days, the 30 behind on
   money, the 30 behind on trips, and every driver — so ops can sort and
   filter the whole list, not only the 30. Plain numbers (src/xlsx_write.js).
   A class the reader's role does not hold in full is written "(withheld)"
   in every cell of it, the Today workbook's rule: the access layer shapes
   JSON and never sees the inside of a file. */
export const MONTH_FILE_CLASSES = ['ID', 'REV', 'EARN', 'BK', 'VEH'];
const W = '(withheld)';
const VERDICT = { over: 'over', under: 'under', unsettled: 'not settled' };

export async function buildTargetMonthWorkbook({ q, now = new Date(), month = null, hide = new Set() }) {
  return monthWorkbookOf(await monthView(q, { month, now }), { now, hide });
}

/** Pure: the workbook of a month's view already in hand — the route's, the
    mock's (mockapi.mjs) and the tests', so all three write the same file. */
export function monthWorkbookOf(v, { now = new Date(), hide = new Set() } = {}) {
  const hid = (cls, x) => (hide.has(cls) ? W : x);
  const rev = (x) => hid('REV', x);
  const earn = (x) => hid('EARN', x);
  const wb = new Workbook({ created: now });
  const s = v.summary;
  const tj = v.trajectory;
  const dr = v.drivers;

  /* ── Month ── */
  const s1 = wb.sheet('Month', { widths: [40, 20, 86] });
  s1.text(`Month target — ${v.month_name}`, 'title');
  s1.text(`As of ${v.today} (Dubai). Both fleets, every platform. Gross = fares, before any platform commission.`, 'dim');
  s1.blank();
  if (!s) s1.text(v.why, 'wrap');
  else {
    const say = (x) => (x == null ? null : x >= 0 ? `${Math.round(x).toLocaleString('en-US')} over` : `${Math.round(-x).toLocaleString('en-US')} short`);
    const pairs = [
      ['Month target (AED)', rev(s.month_target), 'money', 'The sum of every day’s plan — the Target page’s figure.'],
      ['Earned to yesterday (AED)', rev(s.earned), 'money', 'Fares on every day of the month before today.'],
      ['Planned to yesterday (AED)', rev(s.planned), 'money', null],
      ['Ahead (+) / behind (−) (AED)', rev(s.ahead), 'money', null],
      ['Still to earn (AED)', rev(s.to_go), 'money', `In ${s.days_left} days, today included.`],
      ['Every day left must bring (AED)', rev(s.per_day_left), 'money', 'On average, to land the target.'],
      ['Average day so far (AED)', rev(tj?.avg?.per_day ?? null), 'money', tj?.avg ? `Over ${tj.avg.days} days.` : null],
      ['At that pace the month ends at (AED)', rev(tj?.avg?.month_end ?? null), 'money',
        tj?.avg ? `${rev(say(tj.avg.vs_target))} the target (${tj.avg.pct}%). The Target page’s “At this pace”.` : null],
      [`Last ${RECENT_DAYS} settled days, a day (AED)`, rev(tj?.recent?.per_day ?? null), 'money',
        tj?.recent ? `${tj.recent.from} to ${tj.recent.to}.` : 'No settled day yet.'],
      ['At that pace the month ends at (AED)', rev(tj?.recent?.month_end ?? null), 'money',
        tj?.recent ? `${rev(say(tj.recent.vs_target))} the target (${tj.recent.pct}%).` : null],
    ];
    for (const [label, x, kind, note] of pairs) s1.push([[label, 'bold'], [x, kind], [note, 'dim']]);
    if (tj?.unsettled?.length) {
      s1.text(`Not settled yet: ${tj.unsettled.map((d) => d.label).join(', ')} — counted at the fares on record, so both paces read a little low until it settles.`, 'wrap');
    }
  }
  s1.blank();
  s1.text('Drivers', 'bold');
  if (dr.why) s1.text(dr.why, 'wrap');
  else {
    const tt = dr.totals;
    const pairs = [
      ['Days counted', `${dr.counted_days} (${dr.from} to ${dr.through})`, 'text',
        dr.left_out.length ? `Left out, not settled: ${dr.left_out.map((d) => d.label).join(', ')}.` : 'Every finished day is settled.'],
      ['Active drivers', tt.drivers, 'int', 'A completed trip in the 8 Dubai days to a counted day (the 08:00 email’s rule).'],
      ['On target for money / behind', tt.money_on == null ? '—' : `${tt.money_on} / ${tt.money_behind}`, 'text', dr.money_why],
      [`On target for trips (${v.trips_min} a day) / behind`, `${tt.trips_on} / ${tt.trips_behind}`, 'text', null],
      ['Drivers’ targets, added up (AED)', rev(tt.targets), 'money', 'Equals the fleet’s plan for the counted days: each day’s plan shared over its active drivers.'],
      ['Drivers’ gross, added up (AED)', earn(tt.drivers_gross), 'money', null],
      ['Fares on no named driver (AED)', rev(tt.unattributed), 'money', 'Bookings that name no driver. In the fleet’s total, in nobody’s row.'],
    ];
    for (const [label, x, kind, note] of pairs) s1.push([[label, 'bold'], [x, kind], [note, 'dim']]);
  }
  s1.blank();
  s1.text('How a driver’s target is set', 'bold');
  s1.text('Money: each counted day’s plan (the share of the month target that day was planned at) is divided equally among the drivers active that day; a driver’s target is the sum of their shares, and their gross is their fares on every platform, before commission, on the same days. '
    + `Trips: ${v.trips_min} for every counted day they were active. A counted day is a finished day that has settled — every channel delivered and 99% of its bookings priced.`, 'wrap');

  /* ── Days ── */
  const s2 = wb.sheet('Days', { widths: [11, 9, 9, 13, 13, 13, 14, 10, 12, 10, 46, 9, 12, 13, 12] });
  s2.header(['Day', 'Weekday', 'State', 'Plan (AED)', 'Target (AED)', 'Gross (AED)', 'Over (+) / missed (−)',
    '% of target', 'Verdict', 'Settled', 'Why not settled', 'Trips', 'Trips target', 'Trips over (+) / under (−)', 'Trips verdict'],
  ['date', 'text', 'text', 'money', 'money', 'money', 'money', 'num1', 'text', 'text', 'wrap', 'int', 'int', 'int', 'text']);
  for (const d of v.days) {
    const verdict = d.verdict ? `${VERDICT[d.verdict]}${d.provisional ? ' (at least)' : ''}` : (d.state === 'today' ? 'today — not judged' : null);
    const tv = d.trips_verdict ? `${VERDICT[d.trips_verdict]}${d.trips_provisional ? ' (at least)' : ''}` : null;
    s2.row([d.day, d.label.split(' ')[0], d.state, rev(d.plan), rev(d.needed), rev(d.earned), rev(d.diff), d.pct, verdict,
      d.settled == null ? null : (d.settled ? 'yes' : 'no'), d.why, hid('BK', d.trips), hid('BK', d.trips_target),
      hid('BK', d.trips_diff), tv]);
  }

  /* ── the drivers ── */
  const head = ['Driver', 'Driver id', 'Fleet', 'Platforms', 'Days active', 'Days driven', 'Gross (AED)', 'Target (AED)',
    'Short by (AED)', '% of target', 'Money on target?', 'Trips', 'Trips target', 'Trips short', 'Trips on target?'];
  const kinds = ['text', 'text', 'text', 'text', 'int', 'int', 'money', 'money', 'money', 'num1', 'text', 'int', 'int', 'int', 'text'];
  const widths = [32, 24, 10, 18, 11, 11, 13, 13, 14, 10, 15, 8, 12, 11, 15];
  const yes = (b) => (b == null ? null : b ? 'yes' : 'no');
  const driverRow = (r) => [hid('ID', r.name), hid('ID', r.driver_ext_id), r.fleet, (r.platforms || []).join(', '),
    r.days_active, r.days_driven, earn(r.gross), earn(r.gross_target), earn(r.gross_short), hid('EARN', r.gross_pct),
    hid('EARN', yes(r.money_on)), hid('BK', r.trips), r.trips_target, hid('BK', r.trips_short), hid('BK', yes(r.trips_on))];
  const sheetOf = (name, list, intro) => {
    const sh = wb.sheet(name, { widths });
    sh.text(intro, 'dim');
    if (dr.why) { sh.text(dr.why, 'wrap'); return; }
    sh.header(head, kinds);
    for (const r of list) sh.row(driverRow(r));
  };
  const span = dr.through ? `${dr.from} to ${dr.through}` : 'no settled day yet';
  sheetOf(`Behind on money (${SHOW_BEHIND})`, behind(dr.rows, 'money'),
    `The ${SHOW_BEHIND} drivers furthest below their money target, ${span}.${dr.money_why ? ` ${dr.money_why}` : ''}`);
  sheetOf(`Behind on trips (${SHOW_BEHIND})`, behind(dr.rows, 'trips'),
    `The ${SHOW_BEHIND} drivers furthest below ${v.trips_min} trips a day active, ${span}.`);
  sheetOf('All drivers', dr.rows, `Every driver active on a counted day, ${span}, furthest behind on money first.`);

  const name = `month-target-${v.month}-as-of-${v.today}.xlsx`;
  return { wb, name, month: v.month, drivers: dr.rows.length, days: v.days.length };
}

/** Pure: a month's view from facts already in hand — the route, the file,
    the mock and the tests all assemble it here. */
export function monthViewOf({ month, today, rows, facts, dd, min }) {
  const t = computeMonth({ month, today, rows, facts, min });
  return {
    month: t.month, month_name: t.month_name, today: t.today, first: t.first, last: t.last,
    days_in_month: t.days_in_month, target: t.target, why: t.why, trips_min: t.trips_min,
    summary: t.summary, trips_summary: t.trips_summary, days: t.days,
    trajectory: trajectory(t),
    drivers: driverTargets({ t, facts, dd, min }),
  };
}

