/* THE MONTHLY REPORT EMAIL — a month against the month before and a year ago.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-09-30: "a monthly performance email … comparison for the
   following: with the same month last year, vehicle wise, driver wise, no of
   active vehicles, average earning per vehicle, average earning per active
   driver, average trips per driver, total revenue, total revenue by company,
   total bank payout by company, total cash to driver by company. Comparison
   with last year same month, and previous month. After this use GLM 5.2 to
   analyze the data and give summary." Arkiv-styled; the list of addresses is
   MONTHLY_REPORT_RECIPIENTS on the Settings page.

   ── THE ONE THING THIS EMAIL MUST NOT DO: COMPARE TWO DIFFERENT MEASURES ───
   Measured on production 2026-09-30, /api/revenue per month and company:

     Aug 2025  Ecosine  uber basis FARES      fares 470,625.43  no payout, no statement
     Aug 2026  Ecosine  uber basis STATEMENT  fares 451,386.96  statement 338,359.93

   A year ago Uber's money exists only as FARES — what riders paid — because
   the earnings surface that files statements and payouts reaches back about
   192 days (docs/COVERAGE.md "Where each Uber figure comes from"). This
   year the dashboard counts Uber on its STATEMENT, net of Uber's 25%
   commission. Put the dashboard's "money in" for the two Augusts side by side
   and the fleet reads a quarter down on a year in which fares moved 4%.

   So the email carries two money lines and says which is which:
     fares      what riders paid, on every platform, priced trip by trip —
                present in all three months, so it is the line every
                year-on-year comparison is made on (vehicles and drivers too);
     earned     after the platforms' commission: api/income_sql.js
                fleetIncome().accounted, assembled exactly as /api/kpis
                assembles it (the Overview's "money in"), open-week fill
                included. Compared only where both months count every platform
                on the same basis; otherwise the email says why not.
   Uber's commission is a fixed 25% of the fare (measured on every priced
   trip), so the fares line moves with the earned one wherever both exist.

   THE REST, and where each comes from:
     paid into the bank   fleetIncome().reported_payouts — driver_payout_day,
                          Uber's netOutstanding and Yango's payout; the
                          platforms it covers are named. Bolt and the hotel
                          channel file no payout on this surface.
     cash to drivers      trip_cash (sql/schema_v80.sql): the cash drivers
                          took from riders — Uber's own cash-collected figure,
                          the fare on the other channels — the figure the
                          05:00 SMS asks each driver to deposit.
     active vehicles      plates with at least one completed trip that month
     active drivers       people (api/custody_sql.js personKey()) with at
                          least one completed trip that month
     averages             fares ÷ active vehicles, fares ÷ active drivers,
                          completed trips ÷ active drivers

   A FIGURE THAT CANNOT BE MEASURED IS ABSENT WITH ITS REASON, and so is a
   comparison that cannot be made: a month whose trips are under 95% priced,
   a month with no payout collected, two months on different money bases.

   A LANGUAGE MODEL MAY NAME AN EVENT AND MAY NOT MOVE A NUMBER. GLM 5.2 is
   given the figures with every percentage already worked out and asked not to
   compute; every number in what it writes must be one it was given, or its
   text is dropped, the email says so, and a summary built from the figures
   alone stands in. */
import { platformFares, platformPayouts, platformStatements, fleetIncome } from '../api/income_sql.js';
import { resolveOpenFill, applyFillToPlatforms } from '../api/statement_fill_sql.js';
import { personKey } from '../api/custody_sql.js';
import { http as realHttp } from './http.js';
import { config } from './config.js';
import { get } from './settings.js';
import { log } from './log.js';
import { dubaiIso } from './util.js';
import { resendSend, channelsCollected, numbersIn, EMAIL, T, SERIF, SANS, esc, aed, int } from './daily_report.js';

const SRC = 'monthly-report';
const FLEETS = ['ecosine', 'egari'];
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };
const PLATFORM = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel', careem: 'Careem' };
const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const round1 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const num = (v) => (v == null ? null : Number(v));
/* A comparison is made on fares only where both months price this share of
   the trips that could carry a fare. Uber reaches 99.9–100% on every month
   its payments walk has covered (docs/COVERAGE.md); below 95% a month is
   missing real money and a percentage against it would be a percentage of a
   hole. */
export const FARE_COVERAGE_MIN = 95;
/* The month is complete enough to send when the fares are this priced… */
export const READY_COVERAGE = 99;

/* ── the calendar ─────────────────────────────────────────────────────────── */
export const shiftMonth = (m, n) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
};
export const monthEnd = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
};
export const lastCompleteMonth = (now = new Date()) => shiftMonth(dubaiIso(now).slice(0, 7), -1);
export const monthName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortName = (m) => new Date(`${m}-15T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });
/* The last try: the 3rd of the next month at 10:00 Dubai (06:00 UTC). */
export const lastCall = (m) => new Date(`${shiftMonth(m, 1)}-03T06:00:00Z`);

/* ── one company (or both, fleet null) over one month ─────────────────────── */
const W = 'local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)';

export async function companyMonth(q, m, fleet = null) {
  const from = `${m}-01`;
  const to = monthEnd(m);
  const days = Number(to.slice(8));
  const p = [from, to, null, fleet];
  const pk = personKey();
  const [fareRows, payRows, stmtRows, [act], [cash]] = await Promise.all([
    q(platformFares(W), p),
    q(platformPayouts(), p),
    q(platformStatements(), p),
    q(`SELECT count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
              count(DISTINCT ${pk}) FILTER (WHERE outcome = 'completed')::int AS drivers,
              count(DISTINCT plate) FILTER (WHERE outcome = 'completed' AND nullif(btrim(plate), '') IS NOT NULL)::int AS vehicles
         FROM trip_norm WHERE ${W} AND is_booking`, p),
    q(`SELECT count(*)::int AS trips, round(sum(cash_amount)::numeric, 2) AS amount,
              count(*) FILTER (WHERE cash_basis = 'unvalued')::int AS unvalued
         FROM trip_cash
        WHERE (requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date
          AND ($3::text IS NULL OR platform=$3) AND ($4::text IS NULL OR fleet_id=$4)`, p),
  ]);
  /* Assembled field for field as /api/kpis assembles it (api/server.js), so
     `earned` is the Overview's "money in" for the same month and company. */
  const byPlat = new Map();
  const plat = (name) => {
    if (!byPlat.has(name)) byPlat.set(name, { platform: name, bookings: 0, priced_bookings: 0, fares: null, payouts: null, payout_days: 0 });
    return byPlat.get(name);
  };
  for (const f of fareRows) Object.assign(plat(f.platform), {
    bookings: f.bookings, priced_bookings: f.priced_bookings, fares: num(f.fares),
    chargeable_bookings: f.chargeable_bookings, uncharged_bookings: f.uncharged_bookings, booking_days: f.booking_days });
  for (const y of payRows) Object.assign(plat(y.platform), {
    payouts: num(y.payouts), payout_days: y.payout_days ?? 0, payout_drivers: y.drivers, payout_cash: num(y.cash) });
  for (const t of stmtRows) Object.assign(plat(t.platform), {
    statement_net: num(t.statement_net), statement_gross: num(t.statement_gross), statement_cash: num(t.statement_cash),
    statement_bank: num(t.statement_bank), statement_tips: num(t.statement_tips), statement_salik: num(t.statement_salik),
    statement_days: t.statement_days });
  const fill = await resolveOpenFill({ q, from, to, platform: null, fleet });
  applyFillToPlatforms(byPlat, fill.fill);
  const rows = [...byPlat.values()];
  const income = fleetIncome(rows, days);
  const priced = fareRows.reduce((a, r) => a + Number(r.priced_bookings || 0), 0);
  const chargeable = fareRows.reduce((a, r) => a + Number(r.chargeable_bookings || 0), 0);
  const fares = fareRows.some((r) => r.fares != null) ? round2(fareRows.reduce((a, r) => a + Number(r.fares || 0), 0)) : null;
  const d = act || {};
  return {
    month: m, fleet,
    fares, priced, chargeable, fare_coverage_pct: chargeable ? round1((priced / chargeable) * 100) : null,
    earned: round2(income.accounted),
    /* Which basis each platform's money was counted on — the test of
       whether two months' `earned` measure the same thing. */
    earned_basis: Object.fromEntries(rows.filter((r) => r.best != null).map((r) => [r.platform, r.basis.replace(/^partial_/, '')])),
    earned_partial: rows.filter((r) => /^partial_/.test(r.basis)).map((r) => r.platform).sort(),
    bank: round2(income.reported_payouts), bank_platforms: income.reported_payout_platforms || [],
    cash: cash?.trips ? round2(cash.amount) : 0, cash_trips: cash?.trips ?? 0, cash_unvalued: cash?.unvalued ?? 0,
    completed: d.completed ?? 0, drivers: d.drivers ?? 0, vehicles: d.vehicles ?? 0,
    per_vehicle: fares != null && d.vehicles ? round2(fares / d.vehicles) : null,
    per_driver: fares != null && d.drivers ? round2(fares / d.drivers) : null,
    trips_per_driver: d.drivers ? round1(d.completed / d.drivers) : null,
  };
}

/* ── the comparisons, each with its reason when it cannot be made ─────────── */
const BASIS_WORD = { statement: 'its statement (after commission)', payout: 'its payout', fares: 'fares (before commission)' };
const pct = (cur, base) => (cur == null || base == null || Number(base) === 0 ? null : round1(((cur - base) / Math.abs(base)) * 100));

const fareOk = (x) => x.fare_coverage_pct != null && x.fare_coverage_pct >= FARE_COVERAGE_MIN;
/** Both months price enough of their trips for their fares to be compared. */
export const faresComparable = (a, b) => fareOk(a) && fareOk(b);

export function compare(key, cur, base, { now = new Date() } = {}) {
  const other = monthName(base.month);
  const noFares = (x) => `${monthName(x.month)} has fares on only ${x.fare_coverage_pct ?? 0}% of its trips`;
  const on = (why) => ({ pct: null, why });
  switch (key) {
    case 'fares': case 'per_vehicle': case 'per_driver':
      if (!fareOk(cur)) return on(noFares(cur));
      if (!fareOk(base)) return on(noFares(base));
      return { pct: pct(cur[key], base[key]), why: null };
    case 'earned': {
      if (base.earned == null) return on(`nothing was counted for ${other}`);
      const a = cur.earned_basis; const b = base.earned_basis;
      const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
        .find((pl) => a[pl] && b[pl] && a[pl] !== b[pl]);
      if (diff) {
        return on(`${other} counts ${PLATFORM[diff] || diff} on ${BASIS_WORD[b[diff]] || b[diff]}, `
          + `${monthName(cur.month)} on ${BASIS_WORD[a[diff]] || a[diff]} — not the same measure`);
      }
      return { pct: pct(cur.earned, base.earned), why: null };
    }
    case 'bank': {
      if (base.bank == null) {
        const old = (now.getTime() - Date.parse(`${monthEnd(base.month)}T00:00:00Z`)) / 864e5 > 192;
        return on(old ? `no payout was collected for ${other}: Uber's earnings reach back about 192 days`
          : `no payout was collected for ${other}`);
      }
      if (cur.bank == null) return on(`no payout was collected for ${monthName(cur.month)}`);
      const same = [...cur.bank_platforms].sort().join() === [...base.bank_platforms].sort().join();
      return same ? { pct: pct(cur.bank, base.bank), why: null }
        : on(`${other} covers ${base.bank_platforms.map((x) => PLATFORM[x] || x).join(', ')}, `
          + `${monthName(cur.month)} ${cur.bank_platforms.map((x) => PLATFORM[x] || x).join(', ')}`);
    }
    case 'cash': {
      /* A cash trip with no amount (an Uber cash trip the payments report has
         not priced) is cash nobody can count; past 5% of a month's cash trips
         the total is short by more than a rounding. */
      const thin = (x) => x.cash_trips && x.cash_unvalued / x.cash_trips > 0.05;
      if (thin(base)) return on(`${int(base.cash_unvalued)} of ${other}'s ${int(base.cash_trips)} cash trips have no amount`);
      if (thin(cur)) return on(`${int(cur.cash_unvalued)} of ${monthName(cur.month)}'s ${int(cur.cash_trips)} cash trips have no amount`);
      return { pct: pct(cur.cash, base.cash), why: null };
    }
    default:
      return { pct: pct(cur[key], base[key]), why: null };
  }
}

export const METRICS = [
  ['fares', 'Fares — what riders paid', 'aed'],
  ['earned', 'Earned after platform commission', 'aed'],
  ['bank', 'Paid into the bank', 'aed'],
  ['cash', 'Cash taken by drivers', 'aed'],
  ['completed', 'Completed trips', 'int'],
  ['vehicles', 'Active vehicles', 'int'],
  ['drivers', 'Active drivers', 'int'],
  ['per_vehicle', 'Fares per active vehicle', 'aed'],
  ['per_driver', 'Fares per active driver', 'aed'],
  ['trips_per_driver', 'Trips per active driver', 'dec'],
];

/* ── vehicle by vehicle, driver by driver ─────────────────────────────────── */
async function rowsBy(q, what, m, prev, ly) {
  const key = what === 'vehicle' ? 'plate' : personKey();
  const inM = (x) => `local_day BETWEEN '${x}-01'::date AND '${monthEnd(x)}'::date`;
  const rows = await q(
    `SELECT ${key} AS k,
            ${what === 'vehicle' ? 'plate AS label' : `coalesce(mode() WITHIN GROUP (ORDER BY driver_name), '(unnamed)') AS label`},
            mode() WITHIN GROUP (ORDER BY fleet_id) FILTER (WHERE ${inM(m)}) AS fleet,
            count(*) FILTER (WHERE ${inM(m)} AND outcome = 'completed')::int AS trips,
            round(sum(price) FILTER (WHERE ${inM(m)} AND has_fare)::numeric, 2) AS fares,
            count(*) FILTER (WHERE ${inM(prev)} AND outcome = 'completed')::int AS trips_prev,
            round(sum(price) FILTER (WHERE ${inM(prev)} AND has_fare)::numeric, 2) AS fares_prev,
            count(*) FILTER (WHERE ${inM(ly)} AND outcome = 'completed')::int AS trips_ly,
            round(sum(price) FILTER (WHERE ${inM(ly)} AND has_fare)::numeric, 2) AS fares_ly
       FROM trip_norm
      WHERE is_booking AND (${inM(m)} OR ${inM(prev)} OR ${inM(ly)})
        AND ${what === 'vehicle' ? "nullif(btrim(plate), '') IS NOT NULL" : `${key} IS NOT NULL`}
      GROUP BY 1${what === 'vehicle' ? ', 2' : ''}
     HAVING count(*) FILTER (WHERE ${inM(m)} AND outcome = 'completed') > 0
      ORDER BY fares DESC NULLS LAST, trips DESC, label`);
  return rows.map((r) => ({ label: r.label, fleet: r.fleet, trips: r.trips, fares: num(r.fares),
    trips_prev: r.trips_prev, fares_prev: num(r.fares_prev), trips_ly: r.trips_ly, fares_ly: num(r.fares_ly) }));
}

/** Everything the email says about month `m`. */
export async function monthFacts(q, m, { now = new Date() } = {}) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m))) throw new Error(`month must be YYYY-MM, not ${m}`);
  const prev = shiftMonth(m, -1);
  const ly = shiftMonth(m, -12);
  const scopes = [null, ...FLEETS];
  const at = {};
  for (const month of [m, prev, ly]) {
    at[month] = {};
    for (const f of scopes) at[month][f || 'all'] = await companyMonth(q, month, f);
  }
  const table = (scope) => METRICS.map(([key, label, kind]) => {
    const cur = at[m][scope]; const p = at[prev][scope]; const y = at[ly][scope];
    return { key, label, kind, cur: cur[key], prev: p[key], ly: y[key],
      vs_prev: compare(key, cur, p, { now }), vs_ly: compare(key, cur, y, { now }) };
  });
  const [vehicles, drivers] = [await rowsBy(q, 'vehicle', m, prev, ly), await rowsBy(q, 'driver', m, prev, ly)];
  /* A row's change is shown only where the whole month's fares compare —
     one vehicle's percentage against a month that is half unpriced is noise. */
  const okPrev = faresComparable(at[m].all, at[prev].all);
  const okLy = faresComparable(at[m].all, at[ly].all);
  const withChange = (r) => ({ ...r,
    vs_prev: okPrev ? pct(r.fares, r.fares_prev) : null, vs_ly: okLy ? pct(r.fares, r.fares_ly) : null });
  const lastDay = monthEnd(m);
  const collection = await channelsCollected(q, lastDay);
  return {
    month: m, prev, ly, at,
    total: table('all'), companies: FLEETS.map((f) => ({ fleet: f, name: FLEET[f], rows: table(f) })),
    vehicles: vehicles.map(withChange), drivers: drivers.map(withChange),
    rows_comparable: { prev: okPrev, ly: okLy },
    collection,
    ready: collection.missing.length === 0 && (at[m].all.fare_coverage_pct ?? 0) >= READY_COVERAGE,
  };
}

/* ── the analysis ─────────────────────────────────────────────────────────── */
export function modelInput(f) {
  const t = (rows) => Object.fromEntries(rows.map((r) => [r.key, {
    this_month: r.cur, previous_month: r.prev, same_month_last_year: r.ly,
    change_vs_previous_pct: r.vs_prev.pct, change_vs_last_year_pct: r.vs_ly.pct,
    ...(r.vs_prev.why ? { not_comparable_with_previous: r.vs_prev.why } : {}),
    ...(r.vs_ly.why ? { not_comparable_with_last_year: r.vs_ly.why } : {}),
  }]));
  const mover = (r) => ({ name: r.label, company: FLEET[r.fleet] || r.fleet, trips: r.trips, fares_aed: r.fares,
    fares_previous_month_aed: r.fares_prev, change_vs_previous_pct: r.vs_prev, change_vs_last_year_pct: r.vs_ly });
  const falls = (rows) => rows.filter((r) => r.vs_prev != null).sort((a, b) => a.vs_prev - b.vs_prev).slice(0, 5).map(mover);
  const rises = (rows) => rows.filter((r) => r.vs_prev != null).sort((a, b) => b.vs_prev - a.vs_prev).slice(0, 5).map(mover);
  return {
    month: monthName(f.month), previous_month: monthName(f.prev), same_month_last_year: monthName(f.ly),
    both_companies: t(f.total),
    by_company: Object.fromEntries(f.companies.map((c) => [c.name, t(c.rows)])),
    top_vehicles_by_fares: f.vehicles.slice(0, 5).map(mover),
    vehicles_biggest_rises: rises(f.vehicles), vehicles_biggest_falls: falls(f.vehicles),
    top_drivers_by_fares: f.drivers.slice(0, 5).map(mover),
    drivers_biggest_rises: rises(f.drivers), drivers_biggest_falls: falls(f.drivers),
    drivers_new_this_month: f.drivers.filter((r) => !r.trips_prev).length,
    platforms_not_delivered_on_last_day: f.collection.missing.map((x) => `${PLATFORM[x.platform] || x.platform} ${FLEET[x.fleet] || x.fleet}`),
  };
}

/* Every number the model may write: each one it was given, at 0, 1 and 2
   decimals and without its sign ("fell 12.3%" for -12.3), and the calendar. */
export function allowedNumbers(input, f) {
  const out = new Set();
  const add = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return;
    const n = Math.abs(Number(v));
    for (const d of [0, 1, 2]) out.add(String(Math.round(n * 10 ** d) / 10 ** d));
  };
  const walk = (o) => {
    if (o == null) return;
    if (typeof o === 'number') return add(o);
    if (typeof o === 'string') return numbersIn(o).forEach(add);
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(input);
  for (const m of [f.month, f.prev, f.ly]) {
    const [y, mo] = m.split('-').map(Number);
    [y, mo, Number(monthEnd(m).slice(8)), y % 100].forEach(add);
  }
  [0, 1, 2, 3, 4, 5, 100, 192].forEach(add);
  return out;
}
export function guardText(text, allowed) {
  const stray = numbersIn(text).filter((n) => !allowed.has(n));
  return { ok: !stray.length, stray };
}

const ANALYST = 'You are the analyst for a Dubai ride-hailing fleet of two companies, Ecosine and Egari, '
  + 'working on Uber, Bolt, Yango and a hotel channel. You are given one month beside the month before and '
  + 'the same month last year, for both companies together and for each, with every percentage change '
  + 'already worked out, the vehicles and drivers that moved most, and the comparisons that cannot be made '
  + 'and why. Write for the owners. Reply with JSON only, no markdown: {"summary": "4-6 sentences: how the '
  + 'month went against the month before and a year ago, where the two companies differ, and what drove '
  + 'it", "points": ["up to 5 one-sentence observations the owners should know or act on, most important '
  + 'first"]}. Use ONLY numbers that appear in the data, written as they appear there; do not add, subtract, '
  + 'divide or work out any percentage yourself. Where a comparison is marked not comparable, do not make '
  + 'it. Fares are what riders paid, before the platforms’ commission. Name drivers and vehicles exactly '
  + 'as written. Plain English, specific, no filler.';

/* The summary built from the figures alone: what the email says when the
   model is not set, fails, or strays. */
export function ruleSummary(f) {
  const r = Object.fromEntries(f.total.map((x) => [x.key, x]));
  const chg = (x, which) => {
    const c = x[which];
    return c.pct == null ? null : `${c.pct > 0 ? '+' : c.pct < 0 ? '−' : ''}${Math.abs(c.pct)}% on ${monthName(which === 'vs_prev' ? f.prev : f.ly)}`;
  };
  const both = (x) => [chg(x, 'vs_prev'), chg(x, 'vs_ly')].filter(Boolean).join(' and ');
  const lines = [];
  if (r.fares.cur != null) lines.push(`Riders paid AED ${aed(r.fares.cur)} in fares in ${monthName(f.month)}${both(r.fares) ? ` — ${both(r.fares)}` : ''}.`);
  lines.push(`${int(r.completed.cur)} completed trips by ${int(r.drivers.cur)} drivers in ${int(r.vehicles.cur)} vehicles${both(r.completed) ? ` (trips ${both(r.completed)})` : ''}.`);
  for (const c of f.companies) {
    const x = c.rows.find((y) => y.key === 'fares');
    if (x.cur != null) lines.push(`${c.name}: AED ${aed(x.cur)} in fares${both(x) ? `, ${both(x)}` : ''}.`);
  }
  return lines.join(' ');
}

export async function analyseMonth(f, { http = realHttp } = {}) {
  const m = config.reportModel;
  const fallback = (why, outcome) => ({ outcome, why, model: m.model, summary: ruleSummary(f), points: [], by: 'rule' });
  if (!m.apiKey) return fallback('no model key is set (REPORT_MODEL_API_KEY)', 'no_model');
  const input = modelInput(f);
  let raw; let finish = null;
  try {
    const { status, data } = await http(`${m.baseUrl}/chat/completions`, {
      method: 'POST', timeoutMs: 120000, retries: 1,
      headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: m.model, max_tokens: 3000, temperature: 0.2, thinking: { type: 'disabled' },
        messages: [{ role: 'system', content: ANALYST }, { role: 'user', content: JSON.stringify(input) }] }),
    });
    if (status >= 400) throw new Error(`HTTP ${status}: ${JSON.stringify(data).slice(0, 160)}`);
    raw = String(data?.choices?.[0]?.message?.content || '').trim();
    finish = data?.choices?.[0]?.finish_reason || null;
  } catch (e) {
    return fallback(String(e.message || e).slice(0, 200), 'failed');
  }
  const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  const bare = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  let out = parse(bare);
  if (out === undefined && bare.indexOf('{') >= 0) out = parse(bare.slice(bare.indexOf('{'), bare.lastIndexOf('}') + 1));
  if (!out || typeof out !== 'object') {
    log.warn(SRC, 'analysis dropped: the reply was not the agreed JSON', { finish, chars: raw.length });
    return fallback(finish === 'length' ? 'the model’s answer was cut off before it finished'
      : 'the model did not answer in the agreed form', 'dropped');
  }
  const allowed = allowedNumbers(input, f);
  const clean = (s, n) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const summary = clean(out.summary, 1200);
  const points = (Array.isArray(out.points) ? out.points : []).slice(0, 5).map((p) => clean(p, 400)).filter(Boolean);
  const stray = [summary, ...points].flatMap((s) => guardText(s, allowed).stray);
  if (!summary) return fallback('the model wrote no summary', 'dropped');
  if (stray.length) {
    log.warn(SRC, 'analysis dropped: it stated numbers it was not given', { stray: stray.slice(0, 5) });
    return fallback(`it stated ${[...new Set(stray)].slice(0, 3).join(', ')}, which ${stray.length === 1 ? 'is' : 'are'} not in the figures`, 'dropped');
  }
  return { outcome: 'ok', why: null, model: m.model, summary, points, by: 'model' };
}

/* ── the email ────────────────────────────────────────────────────────────── */
/* Gmail clips a message past about 102 KB. Every vehicle and every driver
   fits on this fleet's month (about 100 and 150); past these the rest are
   counted and left to the dashboard rather than clipped out of sight. */
export const MAX_ROWS = { vehicles: 150, drivers: 200 };

export function renderMonthlyEmail(f, note, { dashboard = null } = {}) {
  const fmt = (v, kind) => (v == null ? '—' : kind === 'aed' ? aed(v) : kind === 'dec' ? Number(v).toFixed(1) : int(v));
  const chg = (c) => (c.pct == null ? `<span class="n">${c.why ? 'n/c' : '—'}</span>`
    : `<span class="${c.pct < 0 ? 'neg' : c.pct > 0 ? 'pos' : 'n'}">${c.pct > 0 ? '+' : c.pct < 0 ? '−' : ''}${Math.abs(c.pct)}%</span>`);
  /* Each reason once: the same refusal holds for both companies and for
     each, and printing it three times buried the one that differs. */
  const reasons = [];
  const mark = (c, which, label) => {
    if (c.pct == null && c.why) reasons.push(`${label}, against ${which}: ${c.why}.`);
  };
  const head = `<tr><th align="left" class="th">&nbsp;</th><th align="right" class="th r">${esc(shortName(f.month))}</th>`
    + `<th align="right" class="th r">${esc(shortName(f.prev))}</th><th align="right" class="th r">±</th>`
    + `<th align="right" class="th r">${esc(shortName(f.ly))}</th><th align="right" class="th r">±</th></tr>`;
  const metricTable = (rows) => {
    for (const r of rows) { mark(r.vs_prev, monthName(f.prev), r.label); mark(r.vs_ly, monthName(f.ly), r.label); }
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${head}${rows.map((r) => `<tr>
      <td class="td">${esc(r.label)}</td><td class="td r b">${fmt(r.cur, r.kind)}</td><td class="td r">${fmt(r.prev, r.kind)}</td>
      <td class="td r">${chg(r.vs_prev)}</td><td class="td r">${fmt(r.ly, r.kind)}</td><td class="td r">${chg(r.vs_ly)}</td></tr>`).join('')}</table>`;
  };
  const section = (title, sub, body) => `
<tr><td class="pad" style="padding:28px 36px 8px 36px">
  <div style="font:400 20px/1.3 ${SERIF};color:${T.ink};padding-bottom:4px">${title}</div>
  ${sub ? `<div style="font:400 13px/1.5 ${SANS};color:${T.grey};padding-bottom:12px">${sub}</div>` : ''}
  ${body}
</td></tr>`;
  const listTable = (rows, cap, first) => {
    const shown = rows.slice(0, cap);
    const pctCell = (v, ok) => (v == null ? `<span class="n">${ok ? 'new' : '—'}</span>`
      : `<span class="${v < 0 ? 'neg' : v > 0 ? 'pos' : 'n'}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%</span>`);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><th align="left" class="th">${first}</th><th align="right" class="th r">Trips</th><th align="right" class="th r">Fares AED</th>
      <th align="right" class="th r">vs ${esc(shortName(f.prev))}</th><th align="right" class="th r">vs ${esc(shortName(f.ly))}</th></tr>
      ${shown.map((r) => `<tr><td class="td">${esc(r.label)}<span class="n"> · ${esc(FLEET[r.fleet] || r.fleet || '')}</span></td>`
        + `<td class="td r">${int(r.trips)}</td><td class="td r b">${fmt(r.fares, 'aed')}</td>`
        + `<td class="td r">${pctCell(r.vs_prev, f.rows_comparable.prev && !r.trips_prev)}</td>`
        + `<td class="td r">${pctCell(r.vs_ly, f.rows_comparable.ly && !r.trips_ly)}</td></tr>`).join('')}
    </table>${rows.length > cap ? `<div class="note">And ${int(rows.length - cap)} more on the dashboard.</div>` : ''}`;
  };
  const totalTable = metricTable(f.total);
  const companyTables = f.companies.map((c) => `<div style="font:500 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey};padding:18px 0 6px 0">${esc(c.name)}</div>${metricTable(c.rows)}`).join('');
  const missing = f.collection.missing;
  const cur = f.at[f.month].all;
  const warn = [
    missing.length ? `${missing.map((x) => `${PLATFORM[x.platform] || x.platform} · ${FLEET[x.fleet] || x.fleet}`).join(', ')} had not delivered the month’s last day when this was sent, so its figures are short by that day.` : null,
    cur.fare_coverage_pct != null && cur.fare_coverage_pct < READY_COVERAGE ? `Only ${cur.fare_coverage_pct}% of ${monthName(f.month)}’s trips carry a fare yet; the fares are short by the rest.` : null,
  ].filter(Boolean);
  const warning = warn.length ? `<tr><td style="padding:0 0 20px 0"><div style="font:400 14px/1.55 ${SANS};color:${T.ink};border-left:2px solid ${T.neg};padding:2px 0 2px 12px">${warn.map(esc).join('<br>')}</div></td></tr>` : '';
  const summaryRow = `<tr><td style="padding:0 0 8px 0;font:400 17px/1.6 ${SERIF};color:${T.ink2}">${esc(note.summary)}</td></tr>`
    + (note.points?.length ? `<tr><td style="padding:4px 0 8px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${note.points.map((p) => `<tr><td valign="top" style="width:18px;font:400 15px/1.5 ${SANS};color:${T.grey}">·</td><td style="font:400 15px/1.5 ${SANS};color:${T.ink};padding-bottom:6px">${esc(p)}</td></tr>`).join('')}</table></td></tr>` : '')
    + `<tr><td style="padding:4px 0 24px 0;font:400 12px/1.5 ${SANS};color:${T.grey}">${note.by === 'model'
      ? `Written by ${esc(note.model)} from the figures below; every number in it was checked against them.`
      : `Built from the figures alone — ${esc(note.why || 'the model was not used')}.`}</td></tr>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>Fleet — ${esc(monthName(f.month))}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400&family=Karla:wght@400;500;600&display=swap" rel="stylesheet">
<style>
.th{font:500 10px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey};padding:0 0 8px 0;border-bottom:1px solid ${T.ink}}
.td{font:400 13px/1.45 ${SANS};color:${T.ink};padding:7px 0;border-bottom:1px solid ${T.hair};font-variant-numeric:tabular-nums}
.r{padding-left:10px;white-space:nowrap;text-align:right}.b{font-weight:600}.n{color:${T.grey}}.neg{color:${T.neg}}.pos{color:${T.pos}}
.note{font:400 12px/1.5 ${SANS};color:${T.grey};padding-top:8px}
@media (max-width:480px){.pad{padding-left:16px!important;padding-right:16px!important}.td,.th{font-size:11px!important}.r{padding-left:6px!important}}
</style></head>
<body style="margin:0;padding:0;background:${T.paper2}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.paper2}"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:${T.paper}">
<tr><td class="pad" style="padding:36px 36px 8px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="font:500 11px/1.4 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${T.grey};padding-bottom:10px">Ecosine &amp; Egari · monthly report</td></tr>
    <tr><td style="font:400 34px/1.15 ${SERIF};color:${T.ink};padding-bottom:6px">${esc(monthName(f.month))}</td></tr>
    <tr><td style="font:400 14px/1.5 ${SANS};color:${T.grey};padding-bottom:22px">Against ${esc(monthName(f.prev))} and ${esc(monthName(f.ly))}</td></tr>
    ${warning}
    ${summaryRow}
  </table>
</td></tr>
${section('Both companies', 'n/c: the two months do not measure the same thing — the reason is under the tables.', totalTable)}
${section('By company', null, companyTables)}
${reasons.length ? `<tr><td class="pad" style="padding:12px 36px 0 36px"><div class="note">${[...new Set(reasons)].map(esc).join('<br>')}</div></td></tr>` : ''}
${section('Vehicles', `Every vehicle with a completed trip in ${esc(monthName(f.month))}, by fares. “new” had no trip in the month compared.`, listTable(f.vehicles, MAX_ROWS.vehicles, 'Vehicle'))}
${section('Drivers', `Every driver with a completed trip in ${esc(monthName(f.month))}, by fares; one person across platforms is one row.`, listTable(f.drivers, MAX_ROWS.drivers, 'Driver'))}
<tr><td class="pad" style="padding:28px 36px 36px 36px;font:400 12px/1.6 ${SANS};color:${T.grey}">
  Fares are what riders paid on priced trips, before the platforms’ commission; they are the only money every month here carries, so every year-on-year comparison is made on them.
  Earned after commission is the dashboard’s money in: each platform counted once, on its statement where one is filed, its payout or its fares otherwise.
  Paid into the bank is what Uber and Yango say they paid; Bolt and the hotel channel file no payout there.
  Cash taken by drivers is the cash riders handed over — Uber’s own figure, the fare elsewhere.
  Active vehicles and drivers had at least one completed trip in the month. Months are Dubai calendar months.
  ${dashboard ? `<br><a href="${esc(dashboard)}/#revenue" style="color:${T.ink}">Open the dashboard</a>` : ''}
</td></tr>
</table></td></tr></table></body></html>`;
  const line = (r) => `${r.label}: ${fmt(r.cur, r.kind)} · ${monthName(f.prev)} ${fmt(r.prev, r.kind)} (${r.vs_prev.pct == null ? 'n/c' : `${r.vs_prev.pct}%`}) · ${monthName(f.ly)} ${fmt(r.ly, r.kind)} (${r.vs_ly.pct == null ? 'n/c' : `${r.vs_ly.pct}%`})`;
  const text = [
    `Ecosine & Egari — monthly report — ${monthName(f.month)}`, `Against ${monthName(f.prev)} and ${monthName(f.ly)}`, '',
    ...warn, warn.length ? '' : null,
    note.summary, ...(note.points || []).map((p) => `· ${p}`), '',
    'Both companies:', ...f.total.map(line), '',
    ...f.companies.flatMap((c) => [`${c.name}:`, ...c.rows.map(line), '']),
    ...[...new Set(reasons)],
    '', 'Vehicles by fares:', ...f.vehicles.slice(0, MAX_ROWS.vehicles).map((r) => `${r.label} (${FLEET[r.fleet] || r.fleet}) — ${r.trips} trips, AED ${fmt(r.fares, 'aed')}`),
    '', 'Drivers by fares:', ...f.drivers.slice(0, MAX_ROWS.drivers).map((r) => `${r.label} (${FLEET[r.fleet] || r.fleet}) — ${r.trips} trips, AED ${fmt(r.fares, 'aed')}`),
  ].filter((l) => l != null).join('\n');
  const faresRow = f.total.find((r) => r.key === 'fares');
  const subject = `${monthName(f.month)} — fares AED ${fmt(faresRow.cur, 'aed')}`
    + `${faresRow.vs_prev.pct == null ? '' : ` · ${faresRow.vs_prev.pct > 0 ? '+' : ''}${faresRow.vs_prev.pct}% on ${shortName(f.prev)}`}`
    + `${faresRow.vs_ly.pct == null ? '' : ` · ${faresRow.vs_ly.pct > 0 ? '+' : ''}${faresRow.vs_ly.pct}% on ${shortName(f.ly)}`}`;
  return { html, text, subject };
}

/* ── recipients and sending ───────────────────────────────────────────────── */
export const monthlyRecipients = (raw = get('MONTHLY_REPORT_RECIPIENTS', '')) =>
  [...new Set(String(raw || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s)))];

/** The monthly run: hourly on the 1st to 3rd of each month. Sends last
    month's report to each address not yet sent it, once the month is
    complete — every platform delivered its last day and 99% of its trips
    priced — or on the 3rd at 10:00 whatever the state, saying what is short.
    The report is composed once (figures and the model's summary) and kept,
    so every address gets the same email. `only` (by hand, or the one-shot
    test) sends to one address now, composed fresh; `force` sends it again. */
export async function monthlyReportRun({ q, now = new Date(), http = realHttp, month = lastCompleteMonth(now),
  only = null, force = false, dashboard = get('PUBLIC_URL', '') || null } = {}) {
  const list = only ? monthlyRecipients(only) : monthlyRecipients();
  if (!list.length) return { month, due: 0, why: only ? 'not an email address' : 'MONTHLY_REPORT_RECIPIENTS is empty' };
  const sent = new Set((await q(
    `SELECT recipient FROM monthly_report_send WHERE month = $1::date AND status = 'sent'`, [`${month}-01`])).map((r) => r.recipient));
  const due = only && force ? list : list.filter((e) => !sent.has(e));
  if (!due.length) return { month, due: 0, sent: 0, failed: 0 };
  const [kept] = only ? [] : await q(
    `SELECT detail FROM monthly_report_send WHERE month = $1::date AND detail->>'scheduled' = 'true'
      ORDER BY created_at LIMIT 1`, [`${month}-01`]);
  let facts; let note;
  if (kept) ({ facts, note } = kept.detail);
  else {
    facts = await monthFacts(q, month, { now });
    if (!only && !facts.ready && now < lastCall(month)) return { month, due: due.length, waiting: true };
    note = await analyseMonth(facts, { http });
  }
  const key = get('RESEND_API_KEY', '');
  const from = get('REPORT_FROM', 'Ecosine Fleet <reports@ecosine.ae>');
  const { html, text, subject } = renderMonthlyEmail(facts, note, { dashboard });
  const detail = JSON.stringify({ scheduled: !only, facts, note });
  let ok = 0, bad = 0;
  for (const to of due) {
    const idem = `monthly-report/${month}/${to}${force ? `/manual-${now.getTime()}` : ''}`;
    const r = key
      ? await resendSend({ http, key, from, to, subject, html, text, idem })
        .catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }))
      : { ok: false, error: 'RESEND_API_KEY is not set for the collector' };
    await q(`INSERT INTO monthly_report_send (month, recipient, status, provider_id, error, detail)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (month, recipient) DO UPDATE SET status = EXCLUDED.status,
               provider_id = EXCLUDED.provider_id, error = EXCLUDED.error, detail = EXCLUDED.detail,
               attempts = monthly_report_send.attempts + 1, updated_at = now()`,
    [`${month}-01`, to, r.ok ? 'sent' : 'failed', r.id || null, r.ok ? null : r.error, detail]);
    r.ok ? ok++ : bad++;
  }
  log[bad ? 'warn' : 'info'](SRC, 'monthly report', { month, sent: ok, failed: bad, commentary: note.outcome,
    ready: facts.ready, bytes: Buffer.byteLength(html) });
  return { month, due: due.length, sent: ok, failed: bad, commentary: note.outcome, ready: facts.ready };
}
