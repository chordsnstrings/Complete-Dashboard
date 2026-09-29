/* WHAT THE DAILY REPORT FINDS — measured here, written up by GLM 5.2.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-09-29: "we need to give a report and actionable items
   according to GLM 5.2 — check every day's performance against last week's
   same day, action points, not just a preliminary report".

   The split is the house rule: a language model may name an event and may
   not move a number. Everything below is SQL and arithmetic — every figure,
   every comparison, every threshold — and each finding carries its evidence,
   who acts on it and how much it matters. GLM 5.2 is then given the findings
   (with drivers and cars as tokens, never names or plates) and asked which
   matter most and what to do about them; src/daily_report.js holds it to the
   numbers it was given and falls back to these findings' own sentences if it
   strays. The email is useful on the day the model is down.

   THE COMPARISON. Yesterday against the same weekday a week before, and
   against the usual range of the four same weekdays before it — one Monday
   can be odd, and a figure is only called unusual when it is outside all
   four AND at least 10% from their median. A prior day with no bookings at
   all is a collection gap, not a quiet day, and is left out of the norm.

   WHAT CANNOT BE MEASURED, AND IS THEREFORE NOT CLAIMED: online time exists
   for Uber only (the driver timeline), so the hourly check is Uber's; cash
   "to hand in" is cash from trips + advances − hand-ins RECORDED in
   FleetMirror (the operator's definition, 2026-09-22, api/money_workbook.js
   cashToCollect) and the email says how many hand-ins were recorded, because
   an empty hand-in book makes every cash driver look as if they owe it all. */
import { personKey } from '../api/custody_sql.js';
import { cashToCollect } from '../api/money_workbook.js';

export const THRESHOLDS = Object.freeze({
  unusualPct: 10,        // a figure this far from its 4-week median, and outside the range, is unusual
  idleDays: 2,           // a car with no booking this many days running
  idleLookbackDays: 14,  // …that did have a booking within this many days
  driverDropPct: 50,     // a regular earning this much below their own usual
  driverMinUsual: 200,   // …whose usual same-weekday fares are at least this (AED)
  regularOf4: 3,         // a regular drove on at least this many of the last 4 same weekdays
  nonCompleteMin: 5,     // a driver with at least this many bookings…
  nonCompletePct: 30,    // …of which this share did not complete
  channelDropPts: 15,    // a channel's completion this many points below its usual
  channelMin: 10,        // …on at least this many bookings
  onlineMinHours: 4,     // an Uber driver online at least this long…
  hourlyShare: 0.5,      // …earning under this share of the fleet's median per online hour
  cashToHandIn: 500,     // AED to hand in over the last 7 days
  hourMinDiff: 15,       // a 3-hour window this many bookings off its usual
  alertsMin: 3,          // a car with at least this many safety alerts in the day
});

const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const median = (xs) => {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const WEEKDAY = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });

/* Drivers and cars as tokens. The model is shown "D4" and "C2"; the email
   shows the name and the plate. */
function tokens() {
  const d = new Map(); const c = new Map();
  return {
    driver(key, name) { if (!d.has(key)) d.set(key, { token: `D${d.size + 1}`, name }); return d.get(key).token; },
    car(plate) { if (!c.has(plate)) c.set(plate, { token: `C${c.size + 1}`, plate }); return c.get(plate).token; },
    names() {
      const m = new Map();
      for (const v of d.values()) m.set(v.token, v.name);
      for (const v of c.values()) m.set(v.token, v.plate);
      return m;
    },
  };
}

/** Everything the report finds about `day`, from the database alone. */
export async function reportFindings(q, day, { facts = null } = {}) {
  const T = THRESHOLDS;
  const prior = [7, 14, 21, 28].map((n) => addDays(day, -n));
  const days = [day, ...prior];
  const IN = `($1::date, $2::date, $3::date, $4::date, $5::date)`;   // no array parameter: see docs/COVERAGE.md
  const tk = tokens();
  const findings = [];
  const add = (f) => { findings.push({ id: `F${findings.length + 1}`, ...f }); };

  const [perDay, perChannel, cashDay, hours, people] = await Promise.all([
    q(`SELECT local_day::text AS d,
              count(*) FILTER (WHERE is_booking)::int AS bookings,
              count(*) FILTER (WHERE is_booking AND outcome = 'completed')::int AS completed,
              coalesce(sum(price) FILTER (WHERE is_booking AND price IS NOT NULL AND NOT is_complimentary), 0)::float8 AS fares,
              count(DISTINCT plate)::int AS active_cars,
              count(DISTINCT plate) FILTER (WHERE is_booking AND price > 0 AND NOT is_complimentary)::int AS earning_cars,
              count(DISTINCT ${personKey()}) FILTER (WHERE is_booking AND price > 0 AND NOT is_complimentary AND driver_name IS NOT NULL)::int AS earning_drivers
         FROM trip_ext WHERE local_day IN ${IN} GROUP BY 1`, days),
    q(`SELECT local_day::text AS d, platform,
              count(*)::int AS bookings, count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
              coalesce(sum(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary), 0)::float8 AS fares
         FROM trip_ext WHERE local_day IN ${IN} AND is_booking GROUP BY 1, 2`, days),
    q(`SELECT (requested_at AT TIME ZONE 'Asia/Dubai')::date::text AS d, count(*)::int AS trips,
              coalesce(sum(cash_amount), 0)::float8 AS amount
         FROM trip_cash WHERE (requested_at AT TIME ZONE 'Asia/Dubai')::date IN ${IN} GROUP BY 1`, days),
    q(`SELECT local_day::text AS d, extract(hour FROM requested_at AT TIME ZONE 'Asia/Dubai')::int AS h, count(*)::int AS n
         FROM trip_ext WHERE local_day IN ${IN} AND is_booking GROUP BY 1, 2`, days),
    q(`SELECT local_day::text AS d, ${personKey()} AS pk,
              coalesce(mode() WITHIN GROUP (ORDER BY driver_name), '(unnamed)') AS name,
              count(*)::int AS bookings,
              count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
              count(*) FILTER (WHERE outcome = 'not_completed')::int AS not_completed,
              coalesce(sum(price) FILTER (WHERE price IS NOT NULL AND NOT is_complimentary), 0)::float8 AS fares,
              array_agg(DISTINCT platform) AS platforms
         FROM trip_ext WHERE local_day IN ${IN} AND is_booking AND driver_name IS NOT NULL GROUP BY 1, 2`, days),
  ]);

  /* ── the comparison table ─────────────────────────────────────────────── */
  const byDay = new Map(perDay.map((r) => [r.d, r]));
  const cashBy = new Map(cashDay.map((r) => [r.d, r]));
  /* A prior day with no bookings at all was not collected, not quiet. */
  const usable = prior.filter((d) => (byDay.get(d)?.bookings || 0) > 0);
  const METRICS = [
    ['bookings', 'Bookings', (d) => byDay.get(d)?.bookings ?? 0, 0],
    ['completed', 'Completed', (d) => byDay.get(d)?.completed ?? 0, 0],
    ['fares', 'Fares (AED)', (d) => r2(byDay.get(d)?.fares ?? 0), 2],
    ['active_cars', 'Active cars', (d) => byDay.get(d)?.active_cars ?? 0, 0],
    ['earning_cars', 'Cars that earned', (d) => byDay.get(d)?.earning_cars ?? 0, 0],
    ['earning_drivers', 'Drivers who earned', (d) => byDay.get(d)?.earning_drivers ?? 0, 0],
    ['cash_trips', 'Cash trips', (d) => cashBy.get(d)?.trips ?? 0, 0],
    ['cash', 'Cash taken (AED)', (d) => r2(cashBy.get(d)?.amount ?? 0), 2],
  ];
  const compare = METRICS.map(([key, label, f, dp]) => {
    const today = f(day);
    const lastWeek = usable.includes(prior[0]) ? f(prior[0]) : null;
    const vals = usable.map(f);
    const med = median(vals);
    const pct = (a, b) => (a == null || !b ? null : r1(((a - b) / b) * 100));
    const unusual = vals.length >= 2 && med
      && (today < Math.min(...vals) || today > Math.max(...vals))
      && Math.abs((today - med) / med) * 100 >= T.unusualPct;
    return { key, label, today, last_week: lastWeek, usual: med == null ? null : Number(med.toFixed(dp)),
      low: vals.length ? Math.min(...vals) : null, high: vals.length ? Math.max(...vals) : null,
      vs_last_week_pct: pct(today, lastWeek), vs_usual_pct: pct(today, med), unusual: !!unusual };
  });
  const cmp = Object.fromEntries(compare.map((c) => [c.key, c]));
  const unusualRows = compare.filter((c) => c.unusual);
  if (unusualRows.length) {
    add({ kind: 'demand', owner: 'Manager', severity: 3,
      title: `${unusualRows.length} of ${compare.length} measures outside the usual ${WEEKDAY(day)} range`,
      labels: unusualRows.map((c) => c.label),
      numbers: Object.fromEntries(unusualRows.flatMap((c) => [[`${c.key}_yesterday`, c.today],
        [`${c.key}_usual`, c.usual], [`${c.key}_last_week`, c.last_week], [`${c.key}_vs_usual_pct`, c.vs_usual_pct]])),
      evidence: unusualRows.map((c) => `${c.label}: ${fmt(c.today)} against a usual ${fmt(c.usual)} (${fmt(c.low)}–${fmt(c.high)}) and ${fmt(c.last_week)} last ${WEEKDAY(day)}`),
      items: [] });
  }

  /* ── channels: completion that fell ───────────────────────────────────── */
  const chan = (d, p) => perChannel.find((r) => r.d === d && r.platform === p);
  for (const p of [...new Set(perChannel.filter((r) => r.d === day).map((r) => r.platform))]) {
    const y = chan(day, p);
    if (!y || y.bookings < T.channelMin) continue;
    const priorPct = usable.map((d) => chan(d, p)).filter((r) => r && r.bookings >= T.channelMin)
      .map((r) => (r.completed / r.bookings) * 100);
    const usual = median(priorPct);
    const today = (y.completed / y.bookings) * 100;
    if (usual == null || usual - today < T.channelDropPts) continue;
    /* Who did not complete them. */
    const who = people.filter((r) => r.d === day && r.platforms.includes(p) && r.not_completed > 0)
      .sort((a, b) => b.not_completed - a.not_completed).slice(0, 5);
    add({ kind: 'channel', owner: 'Supervisors', severity: 3,
      title: `${CH[p] || p} completed ${y.completed} of ${y.bookings} bookings`,
      numbers: { completed: y.completed, bookings: y.bookings, completion_pct: r1(today), usual_completion_pct: r1(usual) },
      evidence: [`${CH[p] || p}: ${y.completed} of ${y.bookings} completed (${r1(today)}%) against a usual ${r1(usual)}%`],
      items: who.map((r) => ({ ref: tk.driver(r.pk, r.name), name: r.name, not_completed: r.not_completed, bookings: r.bookings })) });
  }

  /* ── hours: the 3-hour window furthest from its usual ─────────────────── */
  const hourCount = (d, h) => hours.find((r) => r.d === d && r.h === h)?.n || 0;
  let worst = null; let best = null;
  if (usable.length >= 2) {
    for (let h = 0; h < 24; h++) {
      const win = [h, (h + 1) % 24, (h + 2) % 24];
      const today = win.reduce((a, x) => a + hourCount(day, x), 0);
      const usual = median(usable.map((d) => win.reduce((a, x) => a + hourCount(d, x), 0)));
      const diff = today - usual;
      if (!worst || diff < worst.diff) worst = { h, today, usual, diff };
      if (!best || diff > best.diff) best = { h, today, usual, diff };
    }
  }
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  for (const [w, lost] of [[worst, true], [best, false]]) {
    if (!w || Math.abs(w.diff) < T.hourMinDiff || !w.usual || Math.abs(w.diff) / w.usual < 0.2) continue;
    add({ kind: 'hours', owner: 'Manager', severity: lost ? 2 : 1,
      title: `${hh(w.h)}–${hh((w.h + 3) % 24)} had ${w.today} bookings against a usual ${w.usual}`,
      numbers: { window_start_hour: w.h, window_end_hour: (w.h + 3) % 24, bookings: w.today, usual: w.usual },
      evidence: [`${hh(w.h)}–${hh((w.h + 3) % 24)}: ${w.today} bookings against a usual ${w.usual} on ${WEEKDAY(day)}s — the ${lost ? 'biggest shortfall' : 'biggest gain'} of the day`],
      items: [] });
  }

  /* ── drivers: down against their own usual, and regulars who did not drive ─ */
  const mine = new Map();
  for (const r of people) {
    if (!mine.has(r.pk)) mine.set(r.pk, { pk: r.pk, name: r.name, days: new Map() });
    mine.get(r.pk).days.set(r.d, r);
  }
  const down = []; const absent = []; const nonComplete = [];
  for (const m of mine.values()) {
    const worked = usable.filter((d) => m.days.has(d));
    const y = m.days.get(day);
    if (y && y.bookings >= T.nonCompleteMin && (y.not_completed / y.bookings) * 100 >= T.nonCompletePct) {
      nonComplete.push({ m, y });
    }
    if (worked.length < T.regularOf4) continue;
    const usual = median(worked.map((d) => m.days.get(d).fares));
    if (!y) { absent.push({ m, worked: worked.length, usual }); continue; }
    if (usual >= T.driverMinUsual && y.fares <= usual * (1 - T.driverDropPct / 100)) down.push({ m, y, usual });
  }
  if (down.length) {
    down.sort((a, b) => (a.y.fares - a.usual) - (b.y.fares - b.usual));
    add({ kind: 'driver_down', owner: 'Supervisors', severity: 2,
      title: `${down.length} regular driver${down.length === 1 ? '' : 's'} earned half or less of their usual ${WEEKDAY(day)}`,
      numbers: { drivers: down.length },
      evidence: [],
      items: down.slice(0, 8).map(({ m, y, usual }) => ({ ref: tk.driver(m.pk, m.name), name: m.name,
        fares: r2(y.fares), usual: r2(usual), bookings: y.bookings })) });
  }
  if (absent.length) {
    absent.sort((a, b) => b.usual - a.usual);
    add({ kind: 'driver_absent', owner: 'Supervisors', severity: 2,
      title: `${absent.length} regular${absent.length === 1 ? '' : 's'} did not drive`,
      numbers: { drivers: absent.length },
      evidence: [`Drove on at least ${T.regularOf4} of the last 4 ${WEEKDAY(day)}s, and not yesterday`],
      items: absent.slice(0, 8).map(({ m, worked, usual }) => ({ ref: tk.driver(m.pk, m.name), name: m.name,
        weeks_of_4: worked, usual: r2(usual) })) });
  }
  if (nonComplete.length) {
    nonComplete.sort((a, b) => b.y.not_completed - a.y.not_completed);
    add({ kind: 'noncomplete', owner: 'Supervisors', severity: 2,
      title: `${nonComplete.length} driver${nonComplete.length === 1 ? '' : 's'} left ${T.nonCompletePct}% or more of their bookings uncompleted`,
      numbers: { drivers: nonComplete.length },
      evidence: [],
      items: nonComplete.slice(0, 8).map(({ m, y }) => ({ ref: tk.driver(m.pk, m.name), name: m.name,
        completed: y.completed, bookings: y.bookings })) });
  }

  /* ── cars: idle for days, and moving without a booking ────────────────── */
  const idle = await q(
    `WITH last AS (
       SELECT plate, max(local_day) AS last_day
         FROM trip_ext WHERE is_booking AND plate IS NOT NULL
          AND local_day BETWEEN $1::date - $2::int AND $1::date
        GROUP BY 1)
     SELECT l.plate, l.last_day::text AS last_day, ($1::date - l.last_day)::int AS idle_days,
            (SELECT mode() WITHIN GROUP (ORDER BY t.driver_name) FROM trip_ext t
              WHERE t.plate = l.plate AND t.local_day = l.last_day AND t.is_booking) AS last_driver,
            (SELECT count(*)::int FROM trip_ext t WHERE t.plate = l.plate AND t.local_day = $1::date AND NOT t.is_booking) AS journeys_yesterday
       FROM last l WHERE ($1::date - l.last_day) >= $3::int
      ORDER BY idle_days DESC, l.plate`, [day, T.idleLookbackDays, T.idleDays]);
  if (idle.length) {
    add({ kind: 'cars_idle', owner: 'Fleet', severity: 2,
      title: `${idle.length} car${idle.length === 1 ? '' : 's'} had no booking for ${T.idleDays} days or more`,
      numbers: { cars: idle.length },
      evidence: [`Each had a booking in the ${T.idleLookbackDays} days before and none for at least ${T.idleDays} days`],
      items: idle.slice(0, 10).map((c) => ({ ref: tk.car(c.plate), plate: c.plate, idle_days: c.idle_days,
        last_driver: c.last_driver, moved_without_booking: c.journeys_yesterday })) });
  }

  /* ── Uber: online a long time for little ───────────────────────────────── */
  const hourly = await q(
    `SELECT dd.driver_ext_id AS id, dd.online_min,
            (SELECT coalesce(sum(price), 0)::float8 FROM trip_ext t WHERE t.platform = 'uber' AND t.driver_ext_id = dd.driver_ext_id
              AND t.local_day = $1::date AND t.is_booking AND t.price IS NOT NULL AND NOT t.is_complimentary) AS fares,
            (SELECT mode() WITHIN GROUP (ORDER BY t.driver_name) FROM trip_ext t WHERE t.platform = 'uber'
              AND t.driver_ext_id = dd.driver_ext_id AND t.local_day >= $1::date - 30) AS name
       FROM driver_day dd WHERE dd.day = $1::date AND dd.online_min >= 60`, [day]);
  const rates = hourly.map((r) => ({ ...r, rate: r.fares / (r.online_min / 60) }));
  const fleetRate = median(rates.map((r) => r.rate));
  const slow = fleetRate ? rates.filter((r) => r.online_min >= T.onlineMinHours * 60 && r.rate < fleetRate * T.hourlyShare && r.name)
    .sort((a, b) => a.rate - b.rate) : [];
  if (slow.length) {
    add({ kind: 'hourly', owner: 'Supervisors', severity: 2,
      title: `${slow.length} Uber driver${slow.length === 1 ? ' was' : 's were'} online ${T.onlineMinHours} hours or more for under half the fleet's rate`,
      numbers: { drivers: slow.length, fleet_median_aed_per_online_hour: r2(fleetRate) },
      evidence: [`Fleet median AED ${r2(fleetRate)} per online hour on Uber yesterday`],
      items: slow.slice(0, 8).map((r) => ({ ref: tk.driver(`uber:${r.id}`, r.name), name: r.name,
        online_hours: r1(r.online_min / 60), fares: r2(r.fares), aed_per_hour: r2(r.rate) })) });
  }

  /* ── cash to hand in over the last 7 days ─────────────────────────────── */
  const cash = await cashToCollect({ q, from: addDays(day, -6), to: day });
  const owing = cash.people.filter((e) => e.toHandIn >= T.cashToHandIn).sort((a, b) => b.toHandIn - a.toHandIn);
  if (owing.length) {
    add({ kind: 'cash', owner: 'Cash desk', severity: 3,
      title: `${owing.length} driver${owing.length === 1 ? '' : 's'} hold AED ${T.cashToHandIn} or more to hand in over the last 7 days`,
      numbers: { drivers: owing.length, total: r2(owing.reduce((a, e) => a + e.toHandIn, 0)), hand_ins_recorded: cash.handIns },
      evidence: [`To hand in = cash from trips + advances − hand-ins recorded, ${addDays(day, -6)} to ${day}. `
        + (cash.handIns ? `${cash.handIns} hand-in${cash.handIns === 1 ? ' is' : 's are'} recorded in those days.`
          : 'No hand-in is recorded in FleetMirror in those days: record each on Money → Cash handed in, or this list is all the cash taken.')],
      items: owing.slice(0, 10).map((e) => ({ ref: tk.driver(e.key, e.name), name: e.name,
        to_hand_in: r2(e.toHandIn), cash_trips: e.cashTrips, last_hand_in: e.lastHandIn || null })) });
  }

  /* ── unregistered journeys the 07:00 trip messages were about ─────────── */
  const unreg = await q(
    `SELECT o.person_id::text AS pid, coalesce(d.full_name, '(no name)') AS name, count(*)::int AS journeys,
            coalesce(sum((o.detail->>'km')::numeric), 0)::float8 AS km,
            count(*) FILTER (WHERE o.status = 'held')::int AS held
       FROM sms_outbox o LEFT JOIN driver d ON d.id = o.person_id
      WHERE o.kind = 'trip_register' AND o.person_id IS NOT NULL
        AND (o.trip_start AT TIME ZONE 'Asia/Dubai')::date = $1::date
      GROUP BY 1, 2 ORDER BY journeys DESC, km DESC`, [day]);
  if (unreg.length) {
    add({ kind: 'unregistered', owner: 'Supervisors', severity: unreg.some((u) => u.journeys >= 2) ? 2 : 1,
      title: `${unreg.reduce((a, u) => a + u.journeys, 0)} journeys with no booking, by ${unreg.length} driver${unreg.length === 1 ? '' : 's'}`,
      numbers: { journeys: unreg.reduce((a, u) => a + u.journeys, 0), drivers: unreg.length },
      evidence: ['Journeys of 4 km or more with no booking, found by the unregistered-trip check'],
      items: unreg.slice(0, 8).map((u) => ({ ref: tk.driver(`p${u.pid}`, u.name), name: u.name,
        journeys: u.journeys, km: r1(u.km) })) });
  }

  /* ── safety alerts ─────────────────────────────────────────────────────── */
  const alerts = await q(
    `SELECT plate, count(*)::int AS n, mode() WITHIN GROUP (ORDER BY alert_type) AS most
       FROM alert WHERE plate IS NOT NULL AND (occurred_at AT TIME ZONE 'Asia/Dubai')::date = $1::date
      GROUP BY 1 HAVING count(*) >= $2 ORDER BY n DESC LIMIT 5`, [day, T.alertsMin]).catch(() => []);
  if (alerts.length) {
    add({ kind: 'safety', owner: 'Fleet', severity: 1,
      title: `${alerts.length} car${alerts.length === 1 ? '' : 's'} with ${T.alertsMin} or more safety alerts`,
      numbers: { cars: alerts.length },
      evidence: [],
      items: alerts.map((a) => ({ ref: tk.car(a.plate), plate: a.plate, alerts: a.n, most_often: a.most })) });
  }

  /* ── data that did not arrive ──────────────────────────────────────────── */
  const missing = facts?.collection?.missing || [];
  if (missing.length) {
    add({ kind: 'data', owner: 'Admin', severity: 3,
      title: `${missing.map((m) => `${CH[m.platform] || m.platform} ${FL[m.fleet] || m.fleet}`).join(', ')} did not deliver yesterday`,
      numbers: { channels: missing.length },
      evidence: ['Every figure in this email is short by their work until they collect; the credentials panel says why'],
      items: [] });
  }

  findings.sort((a, b) => b.severity - a.severity);
  findings.forEach((f, i) => { f.id = `F${i + 1}`; });
  return { day, weekday: WEEKDAY(day), compare, cmp, findings, names: tk.names(), thresholds: T,
    usable_prior_days: usable, last_week_day: prior[0] };
}

const CH = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel', fms: 'Telematics' };
const FL = { ecosine: 'Ecosine', egari: 'Egari' };
export const fmt = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** The findings as the model sees them: tokens, never a name or a plate. */
export function findingsForModel(r) {
  return {
    day: r.day, weekday: r.weekday,
    compare: r.compare.map(({ key, label, today, last_week, usual, low, high, vs_last_week_pct, vs_usual_pct, unusual }) =>
      ({ key, label, yesterday: today, last_week, usual, low, high, vs_last_week_pct, vs_usual_pct, unusual })),
    findings: r.findings.map((f) => ({ id: f.id, kind: f.kind, owner: f.owner, severity: f.severity,
      title: f.title, numbers: f.numbers,
      items: f.items.map(({ name, plate, last_driver, ...rest }) => rest) })),
  };
}
