/* THE DAILY REPORT EMAIL — yesterday's fleet, at 07:00 Dubai.
   ═══════════════════════════════════════════════════════════════════════════
   The operator, 2026-09-29: every morning at 7, for yesterday — drivers'
   performance, cash trips, total revenue, total active cars, cars that
   actually earned, drivers who earned, and the average earning per driver and
   per car — styled as Arkiv, to three addresses, and admins may add more
   after signing in. GLM 5.2 (ModelArk) writes the commentary; Resend sends.

   WHERE EVERY NUMBER COMES FROM, so the email and the dashboard cannot say
   two things about one day:
     fares, bookings,     api/day_routes.js buildDay() — the #day/<date> page's
     channels, versus     own computation, called, not copied
     cash trips, cash     trip_cash (sql/schema_v80.sql): Uber's own
       per driver         cash-collected where the payments report has it, the
                          fare elsewhere — the figure the 05:00 SMS asks each
                          driver to deposit
     active cars          plates with any booking or telematics journey that
                          Dubai day (trip_ext.local_day)
     cars / drivers       a plate / a person with at least one priced booking;
       that earned        a person is api/custody_sql.js personKey(), as on
                          the day page
     averages             fares ÷ drivers that earned, fares ÷ cars that earned

   A FIGURE THAT CANNOT BE MEASURED IS ABSENT WITH ITS REASON. Bookings with no
   fare yet are counted and named, never valued at nought; a channel that did
   not collect for the day is named at the top of the email, because a quiet
   Bolt and an unfetched Bolt draw the same zero.

   A LANGUAGE MODEL MAY NAME AN EVENT AND MAY NOT MOVE A NUMBER (docs/
   COVERAGE.md). GLM is given the figures and the findings with drivers by
   name and cars by plate (the operator, 2026-09-29: "GLM 5.2 always sees a
   person"; phone numbers are not sent), and every number and person in what
   it writes must be one it was given for that finding. One that is not, and
   its text is dropped and the email says so; the figures never depend on it. */
import { buildDay } from '../api/day_routes.js';
import { personKey } from '../api/custody_sql.js';
import { http as realHttp } from './http.js';
import { config } from './config.js';
import { get } from './settings.js';
import { dubaiIso } from './util.js';
import { log } from './log.js';
import { reportFindings, findingsForModel, fmt, WEEKDAY } from './report_findings.js';

const SRC = 'report';
const round2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const yesterdayDubai = (now = new Date()) => addDays(dubaiIso(now), -1);

const CHANNEL = { uber: 'Uber', bolt: 'Bolt', yango: 'Yango', hotel: 'Hotel', fms: 'Telematics' };
const FLEET = { ecosine: 'Ecosine', egari: 'Egari' };

/* ── the figures ─────────────────────────────────────────────────────────── */
export async function reportFacts(q, day) {
  const d = await buildDay(q, day);
  const h = d.headline || {};
  const [cars] = await q(
    `SELECT count(DISTINCT plate)::int AS active,
            count(DISTINCT plate) FILTER (WHERE is_booking AND price > 0 AND NOT is_complimentary)::int AS earned
       FROM trip_ext WHERE local_day = $1::date AND plate IS NOT NULL`, [day]);
  const people = await q(
    `SELECT ${personKey()} AS pk,
            coalesce(mode() WITHIN GROUP (ORDER BY driver_name), '(unnamed)') AS name,
            count(*)::int AS bookings,
            count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
            sum(price) FILTER (WHERE NOT is_complimentary AND price IS NOT NULL)::float8 AS fares,
            count(*) FILTER (WHERE price IS NULL AND NOT is_complimentary)::int AS unpriced,
            array_agg(DISTINCT platform) AS platforms,
            array_remove(array_agg(DISTINCT plate), NULL) AS plates
       FROM trip_ext WHERE local_day = $1::date AND is_booking AND driver_name IS NOT NULL
      GROUP BY 1`, [day]);
  const cash = await q(
    `SELECT ${personKey()} AS pk, count(*)::int AS trips,
            sum(cash_amount)::float8 AS amount,
            count(*) FILTER (WHERE cash_basis = 'unvalued')::int AS unvalued
       FROM trip_cash WHERE (requested_at AT TIME ZONE 'Asia/Dubai')::date = $1::date
      GROUP BY 1`, [day]);
  const cashBy = new Map(cash.map((c) => [c.pk, c]));
  const drivers = people.map((p) => {
    const c = cashBy.get(p.pk);
    return { name: p.name, bookings: p.bookings, completed: p.completed,
      fares: round2(p.fares), unpriced: p.unpriced,
      cash: c ? round2(c.amount) : 0, cash_trips: c ? c.trips : 0,
      platforms: (p.platforms || []).filter(Boolean).sort(), plates: (p.plates || []).sort() };
  }).sort((a, b) => (b.fares ?? 0) - (a.fares ?? 0) || b.bookings - a.bookings || a.name.localeCompare(b.name));
  const earners = drivers.filter((p) => p.fares > 0);
  const fares = h.priced ? round2(h.revenue) : null;
  const cashTotal = cash.reduce((a, c) => ({ trips: a.trips + c.trips, amount: a.amount + (Number(c.amount) || 0),
    unvalued: a.unvalued + c.unvalued }), { trips: 0, amount: 0, unvalued: 0 });
  const collection = await channelsCollected(q, day);
  return {
    day,
    bookings: h.bookings ?? 0,
    completed: h.completed ?? 0,
    priced: h.priced ?? 0,
    unpriced: Math.max(0, (h.bookings ?? 0) - (h.priced ?? 0)),
    fares,
    cash: { trips: cashTotal.trips, amount: round2(cashTotal.amount), unvalued: cashTotal.unvalued },
    cars: { active: cars?.active ?? 0, earned: cars?.earned ?? 0 },
    drivers_drove: drivers.length,
    drivers_earned: earners.length,
    avg_per_driver: fares != null && earners.length ? round2(fares / earners.length) : null,
    avg_per_car: fares != null && cars?.earned ? round2(fares / cars.earned) : null,
    channels: (d.platforms || []).filter((p) => p.bookings > 0).map((p) => ({
      platform: p.platform, bookings: p.bookings, completed: p.completed,
      fares: p.revenue == null ? null : round2(p.revenue), completion_pct: p.completion_pct })),
    versus: { median_bookings: d.versus_neighbours?.median_bookings ?? null,
      delta_pct: d.versus_neighbours?.delta_pct ?? null },
    collection,
    drivers,
  };
}

/* Which channel-and-fleet pairs delivered this day, measured the way the
   05:00 SMS measures it (src/driver_sms.js collectedPairs): a finished ok or
   partial run whose window reached the day, after the day ended. Expected is
   every pair that has collected at all in the fourteen days before — a pair
   that never collects is not a gap in one morning's email. */
async function channelsCollected(q, day) {
  const rows = await q(
    `WITH expected AS (
       SELECT DISTINCT source, fleet_id FROM collection_run
        WHERE source IN ('uber', 'bolt', 'yango', 'hotel') AND fleet_id IS NOT NULL
          AND status IN ('ok', 'partial') AND finished_at >= $1::date - 14),
     delivered AS (
       SELECT DISTINCT source, fleet_id FROM collection_run
        WHERE source IN ('uber', 'bolt', 'yango', 'hotel') AND fleet_id IS NOT NULL
          AND status IN ('ok', 'partial') AND window_end >= $1::date
          AND finished_at >= (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai'))
     SELECT e.source, e.fleet_id, (d.source IS NOT NULL) AS delivered
       FROM expected e LEFT JOIN delivered d USING (source, fleet_id)
      ORDER BY 1, 2`, [day]);
  return { missing: rows.filter((r) => !r.delivered).map((r) => ({ platform: r.source, fleet: r.fleet_id })),
    delivered: rows.filter((r) => r.delivered).length };
}

/* ── the commentary, and the rule it is held to ──────────────────────────── */
/* Every number the model may use: each figure as given and rounded, and the
   date's own parts. Nothing else. */
export function allowedNumbers(facts, extra = null) {
  const out = new Set();
  const add = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return;
    const n = Number(v);
    for (const d of [0, 1, 2]) out.add((Math.round(n * 10 ** d) / 10 ** d).toString());
    out.add(Math.abs(Math.round(n)).toString());
  };
  const walk = (o) => {
    if (o == null) return;
    if (typeof o === 'number') return add(o);
    /* A number inside a sentence the model was given ("22:00–01:00 had 31
       bookings") is a number it was given. */
    if (typeof o === 'string') return numbersIn(o).forEach(add);
    if (Array.isArray(o)) return o.forEach(walk);
    if (typeof o === 'object') Object.values(o).forEach(walk);
  };
  walk(modelInput(facts));
  if (extra) walk(extra);
  const [y, m, dd] = facts.day.split('-').map(Number);
  [y, m, dd].forEach(add);
  return out;
}
/* Every number in a text, as the model wrote it, in one spelling: thousands
   separators dropped, "00" and "12.50" read as 0 and 12.5. Tokens (D4, C2,
   F3) are names, not numbers, and are taken out first. */
export const numbersIn = (text) => [...String(text).replace(/\b[DCF]\d+\b/g, ' ')
  .matchAll(/\d[\d,]*(?:\.\d+)?/g)]
  .map((m) => String(Number(m[0].replace(/,/g, ''))));
export function guardCommentary(text, facts, extra = null) {
  const allowed = allowedNumbers(facts, extra);
  const stray = numbersIn(text).filter((n) => !allowed.has(n));
  return stray.length ? { ok: false, stray } : { ok: true, stray: [] };
}

/* What the model is shown: the day's figures and the drivers by name.
   The operator, 2026-09-29: "GLM 5.2 always sees a person" — it is given
   drivers' names and cars' plates like anyone reading the dashboard, so it
   can say who. Phone numbers are not sent: nothing in the analysis needs
   them. */
export function modelInput(f) {
  return {
    day: f.day,
    bookings: f.bookings, completed: f.completed, priced: f.priced, unpriced: f.unpriced,
    fares_aed: f.fares, cash_trips: f.cash.trips, cash_aed: f.cash.amount,
    active_cars: f.cars.active, cars_that_earned: f.cars.earned,
    drivers_who_drove: f.drivers_drove, drivers_who_earned: f.drivers_earned,
    average_fares_per_earning_driver_aed: f.avg_per_driver, average_fares_per_earning_car_aed: f.avg_per_car,
    versus_recent_days: f.versus,
    channels: f.channels.map((c) => ({ channel: CHANNEL[c.platform] || c.platform, bookings: c.bookings,
      fares_aed: c.fares, completion_pct: c.completion_pct })),
    channels_not_collected: f.collection.missing.map((m) => `${CHANNEL[m.platform] || m.platform} ${FLEET[m.fleet] || m.fleet}`),
    top_drivers_by_fares: f.drivers.slice(0, 10).map((p, i) => ({ rank: i + 1, name: p.name, bookings: p.bookings,
      fares_aed: p.fares, cash_aed: p.cash, channels: p.platforms.map((x) => CHANNEL[x] || x), cars: p.plates })),
  };
}

/* ── the analysis: GLM 5.2 over the findings, held to them ───────────────── */
const OWNERS = ['Manager', 'Supervisors', 'Fleet', 'Cash desk', 'Admin'];
const ANALYST = 'You are the operations analyst for a Dubai ride-hailing fleet (Uber, Bolt, a hotel '
  + 'channel, Yango). You are given yesterday’s figures, a comparison with the same weekday last '
  + 'week and the usual range of the four same weekdays before, and a list of findings the system has '
  + 'already measured. Name drivers and cars exactly as they are written in the data, and only the '
  + 'ones in the data. Reply with JSON only, no markdown: {"summary": "2-3 sentences on how yesterday went against '
  + 'last week and the usual, and why", "actions": [{"finding": "F1", "owner": "Manager|Supervisors|'
  + 'Fleet|Cash desk|Admin", "action": "one imperative sentence saying who does what today"}]}. At most 8 '
  + 'actions, most important first, each tied to one finding id from the list. Use ONLY numbers that '
  + 'appear in the data; do not add, subtract, divide or compute percentages yourself. In an action, use '
  + 'only that finding\u2019s own numbers and people, and give a driver or car only the numbers on its own item. '
  + 'Plain English, specific, no filler.';

/* The findings' own sentence for each kind: what the email says when the
   model is down or strays, and the action a reader sees either way if GLM
   leaves a finding out. */
const names = (f, key = 'name', n = 4) => {
  const xs = f.items.slice(0, n).map((i) => i[key]).filter(Boolean);
  const more = f.items.length - xs.length;
  return `${xs.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};
export function plainAction(f, weekday) {
  switch (f.kind) {
    case 'demand': {
      const list = (f.labels || []).map((l) => l.replace(/ \(AED\)$/, '').toLowerCase());
      const said = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0] || 'yesterday\u2019s figures';
      return `Find out why ${said} ${list.length === 1 ? 'was' : 'were'} outside the usual ${weekday} range — see What changed.`;
    }
    case 'channel': return `Ask ${names(f) || 'the drivers'} why their bookings did not complete: ${f.title}.`;
    case 'hours': return f.numbers.bookings < f.numbers.usual
      ? `Put more cars on the road ${f.title.split(' had ')[0]} on ${weekday}s: ${f.title}.`
      : `Note the extra demand ${f.title.split(' had ')[0]}: ${f.title}.`;
    case 'driver_down': return `Call ${names(f)}: each earned half or less of their usual ${weekday}.`;
    case 'driver_absent': return `Check on ${names(f)}: regulars on ${weekday}s who did not drive yesterday.`;
    case 'noncomplete': return `Ask ${names(f)} why so many of their bookings did not complete.`;
    case 'cars_idle': return `Put a driver in ${names(f, 'plate')}, or find out why ${f.items.length === 1 ? 'it is' : 'they are'} standing.`;
    case 'hourly': return `Talk to ${names(f)}: long hours online on Uber for little fare.`;
    case 'cash': return `Collect cash from ${names(f)}.`;
    case 'unregistered': return `Ask ${names(f)} to register their journeys with no booking.`;
    case 'safety': return `Review the safety alerts on ${names(f, 'plate')}.`;
    case 'data': return `Get the collection working again: ${f.title}.`;
    default: return f.title;
  }
}

/** The findings' own actions, most severe first — the email without the
    model, and the preview on the Access page. */
export const ruleAnalysis = (report, why, outcome = 'rule') => ({ outcome, why, model: config.reportModel.model,
  summary: null,
  actions: report.findings.slice(0, 8).map((f) => ({ finding: f.id, owner: f.owner, text: plainAction(f, report.weekday), by: 'rule' })) });

/** GLM 5.2's summary and ranked actions, checked; or the findings' own. */
export async function analyse(facts, report, { http = realHttp } = {}) {
  const fallback = (why, outcome) => ruleAnalysis(report, why, outcome);
  const m = config.reportModel;
  if (!m.apiKey) return fallback('no model key is set (REPORT_MODEL_API_KEY)', 'no_model');
  const given = findingsForModel(report);
  let raw;
  let finish = null;
  try {
    const { status, data } = await http(`${m.baseUrl}/chat/completions`, {
      method: 'POST', timeoutMs: 90000, retries: 1,
      headers: { authorization: `Bearer ${m.apiKey}`, 'content-type': 'application/json' },
      /* 3000, not 1400. The answer may be a 700-character summary and eight
         400-character actions — about 4,000 characters of JSON, which is
         more than 1,400 tokens can hold once the findings are real. The first
         real run (2026-09-30, the 29th's report) was dropped as "not the
         agreed form", and on the fixture the same prompt answered cleanly in
         408 tokens: the likeliest difference is a longer answer cut off
         mid-JSON. A longer limit costs only what is actually written. */
      body: JSON.stringify({ model: m.model, max_tokens: 3000, temperature: 0.2,
        thinking: { type: 'disabled' },
        messages: [{ role: 'system', content: ANALYST },
          { role: 'user', content: JSON.stringify({ figures: modelInput(facts), ...given }) }] }),
    });
    if (status >= 400) throw new Error(`HTTP ${status}: ${JSON.stringify(data).slice(0, 160)}`);
    raw = String(data?.choices?.[0]?.message?.content || '').trim();
    finish = data?.choices?.[0]?.finish_reason || null;
  } catch (e) {
    return fallback(String(e.message || e).slice(0, 200), 'failed');
  }
  /* THE JSON, WHEREVER IN THE ANSWER IT IS — and when there is none, WHY.
     ─────────────────────────────────────────────────────────────────────
     The first real run was dropped here and said nothing in the log: the
     guard below warns when it refuses a reply, this path did not, so the
     one thing left to read the next morning was "dropped". A reply that
     wraps the object in a sentence ("Here is the analysis: {…}") is read
     from its first "{" to its last "}". One that was cut off at the length
     limit is said to have been, in the email and the log; its words are not
     logged (they name drivers), only its shape. */
  const parse = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  const bare = raw.replace(/^```(?:json)?\s*|\s*```$/g, '');
  let out = parse(bare);
  if (out === undefined && bare.indexOf('{') >= 0) out = parse(bare.slice(bare.indexOf('{'), bare.lastIndexOf('}') + 1));
  if (out === undefined || out === null || typeof out !== 'object') {
    const cut = finish === 'length';
    log.warn(SRC, 'analysis dropped: the reply was not the agreed JSON',
      { finish, chars: raw.length, starts: raw.slice(0, 1), ends: raw.slice(-1) });
    return fallback(cut ? 'the model\u2019s answer was cut off before it finished'
      : 'the model did not answer in the agreed form', 'dropped');
  }
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  /* Who each finding is about, by name and plate. An action that names a
     driver or car belonging only to ANOTHER finding would put one person's
     evidence under another's name — the same failure as a number from
     another finding, checked the same way. */
  const who = (f) => f.items.flatMap((i) => [i.name, i.plate, i.last_driver]).filter((x) => x && String(x).length >= 3);
  const everyone = new Set(report.findings.flatMap(who).map((x) => String(x).toLowerCase()));
  const mentioned = (text) => [...everyone].filter((n) => text.toLowerCase().includes(n));
  /* The summary may use any measured number; an action only its own
     finding's (and the comparison table's). Checked across all findings, an
     action could put one car's "3 days" on another car that has been idle
     for 7 — every number real, the sentence false. */
  const check = (text, finding = null) => guardCommentary(text, facts,
    finding ? { compare: given.compare, finding: given.findings.find((x) => x.id === finding) } : given);
  const summary = typeof out?.summary === 'string' ? out.summary.replace(/\s+/g, ' ').trim().slice(0, 700) : '';
  const bad = [];
  if (summary) {
    const g = check(summary);
    if (!g.ok) bad.push(...g.stray);
  }
  const actions = [];
  for (const a of Array.isArray(out?.actions) ? out.actions.slice(0, 8) : []) {
    const f = byId.get(String(a?.finding || ''));
    const text = typeof a?.action === 'string' ? a.action.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    if (!f || !text) continue;
    const own = new Set(who(f).map((x) => String(x).toLowerCase()));
    const foreign = mentioned(text).filter((n) => !own.has(n)
      /* A name that is a part of this finding's own ("Ali" inside "Ali
         Khan") is not somebody else. */
      && ![...own].some((o) => o.includes(n)));
    if (foreign.length) { bad.push(`${a.finding}: ${foreign[0]}, who is in another finding`); continue; }
    const g = check(text, f.id);
    if (!g.ok) { bad.push(...g.stray); continue; }
    actions.push({ finding: f.id, owner: OWNERS.includes(a.owner) ? a.owner : f.owner, text, by: 'model' });
  }
  if (bad.length) {
    log.warn(SRC, 'analysis dropped: it strayed from the findings', { stray: bad.slice(0, 5) });
    return fallback(`it stated ${bad.slice(0, 3).join('; ')} — not what the findings say`, 'dropped');
  }
  /* A finding the model left out keeps its own sentence, after the model's. */
  const covered = new Set(actions.map((a) => a.finding));
  for (const f of report.findings) {
    if (actions.length >= 8) break;
    if (!covered.has(f.id) && f.severity >= 2) actions.push({ finding: f.id, owner: f.owner, text: plainAction(f, report.weekday), by: 'rule' });
  }
  return { outcome: 'ok', why: null, model: m.model, summary: summary || null, actions };
}

/* ── the email ───────────────────────────────────────────────────────────── */
/* Arkiv, as the dashboard draws it (api/public/tokens.js, light): white
   paper, near-black ink, one grey for secondary text, hairline rules, no
   cards, no colour except the two semantic ones. Fraunces for the display
   figures and Karla for the rest, falling back to Georgia and Helvetica where
   the client will not load a web font (most will not). Tables and inline
   styles only — the one layout every mail client renders the same. */
export const T = { paper: '#FFFFFF', paper2: '#F6F6F7', ink: '#0A0A0B', ink2: '#2E2E31', grey: '#6D6D72',
  hair: '#D6D6D9', neg: '#961111', pos: '#007E44' };
export const SERIF = "Fraunces,'Iowan Old Style',Georgia,serif";
export const SANS = "Karla,'Helvetica Neue',Helvetica,Arial,sans-serif";
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const aed = (v) => (v == null ? null : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
export const int = (v) => Number(v || 0).toLocaleString('en-US');
export const longDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB',
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/* One line per driver or car behind a finding, with the name — the model
   never saw it; the reader needs it. */
const aedx = (v) => (v == null ? '—' : `AED ${aed(v)}`);
export function evidenceLines(f, weekday) {
  const it = f.items || [];
  const line = {
    channel: (i) => `${i.name} — ${i.not_completed} of ${i.bookings} not completed`,
    driver_down: (i) => `${i.name} — ${aedx(i.fares)} against a usual ${aedx(i.usual)} (${i.bookings} bookings)`,
    driver_absent: (i) => `${i.name} — drove ${i.weeks_of_4} of the last 4 ${weekday}s, usually ${aedx(i.usual)}`,
    noncomplete: (i) => `${i.name} — completed ${i.completed} of ${i.bookings}`,
    cars_idle: (i) => `${i.plate} — ${i.idle_days} days without a booking${i.last_driver ? `, last driven by ${i.last_driver}` : ''}`
      + `${i.moved_without_booking ? `; moved ${i.moved_without_booking} time${i.moved_without_booking === 1 ? '' : 's'} yesterday without one` : ''}`,
    hourly: (i) => `${i.name} — online ${i.online_hours} h, ${aedx(i.fares)} (${aedx(i.aed_per_hour)} an hour)`,
    cash: (i) => `${i.name} — ${aedx(i.to_hand_in)} to hand in, ${i.cash_trips} cash trips, ${i.last_hand_in ? `last hand-in ${i.last_hand_in}` : 'no hand-in recorded'}`,
    unregistered: (i) => `${i.name} — ${i.journeys} journey${i.journeys === 1 ? '' : 's'}, ${fmt(i.km)} km`,
    safety: (i) => `${i.plate} — ${i.alerts} alerts, mostly ${String(i.most_often || '').replace(/_/g, ' ')}`,
  }[f.kind];
  return [...(f.evidence || []), ...(line ? it.map(line) : [])];
}

export function renderEmail(f, note, { dashboard = null, report = null } = {}) {
  /* The table cells take their look from the <style> block by class. Inline
     on every cell, a hundred drivers made a 153 KB email, and Gmail clips a
     message past about 102 KB — the drivers the operator asked for would have
     been behind a "View entire message" link. Gmail and Outlook both honour a
     <style> block in the head. */
  const th = (t, right) => `<th align="${right ? 'right' : 'left'}" class="th${right ? ' r' : ''}">${t}</th>`;
  const td = (t, right, strong, gap) => `<td align="${right ? 'right' : 'left'}" class="td${right ? ' r' : ''}${strong ? ' b' : ''}${gap ? ' gap' : ''}">${t}</td>`;
  const thGap = (t) => `<th align="left" class="th gap">${t}</th>`;
  const absent = (why) => `<span style="color:${T.grey};font-size:13px">not measured — ${esc(why)}</span>`;
  const figure = (label, value, sub) => `
      <td valign="top" style="padding:18px 20px 18px 0;border-top:1px solid ${T.hair};width:50%">
        <div style="font:500 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey}">${esc(label)}</div>
        <div class="fv" style="font:400 28px/1.2 ${SERIF};color:${T.ink};padding-top:6px;white-space:nowrap">${value}</div>
        ${sub ? `<div style="font:400 13px/1.5 ${SANS};color:${T.grey};padding-top:4px">${sub}</div>` : ''}
      </td>`;
  const grid = (cells) => cells.reduce((rows, c, i) => (i % 2 ? rows[rows.length - 1].push(c) : rows.push([c]), rows), [])
    .map((r) => `<tr>${r.join('')}${r.length === 1 ? '<td style="border-top:1px solid ' + T.hair + '"></td>' : ''}</tr>`).join('');
  /* "AED" as a small unit before the figure, so an amount stays on one line
     on a phone. */
  const money = (v) => `<span style="font:400 14px ${SANS};color:${T.grey};letter-spacing:.04em">AED</span>&nbsp;${aed(v)}`;
  const faresLine = f.fares == null ? absent('no booking had a fare yet') : money(f.fares);
  const unpricedNote = f.unpriced ? `${int(f.unpriced)} of ${int(f.bookings)} bookings have no fare yet and are not in this` : `${int(f.bookings)} bookings, ${int(f.completed)} completed`;
  const missing = f.collection.missing;
  const warning = missing.length ? `
    <tr><td style="padding:0 0 20px 0">
      <div style="font:400 14px/1.55 ${SANS};color:${T.ink};border-left:2px solid ${T.neg};padding:2px 0 2px 12px">
        Not in these figures: ${esc(missing.map((m) => `${CHANNEL[m.platform] || m.platform} · ${FLEET[m.fleet] || m.fleet}`).join(', '))}
        — ${missing.length === 1 ? 'it has' : 'they have'} not delivered this day yet, so every total below is short by ${missing.length === 1 ? 'its' : 'their'} work.
      </div></td></tr>` : '';
  const opening = note?.summary ?? note?.text ?? null;
  const commentaryRow = opening
    ? `<tr><td style="padding:0 0 28px 0;font:400 17px/1.6 ${SERIF};color:${T.ink2}">${esc(opening)}</td></tr>`
    : `<tr><td style="padding:0 0 28px 0;font:400 13px/1.5 ${SANS};color:${T.grey}">No commentary today — ${esc(note?.why || 'it was not written')}. `
      + `${note?.actions?.length ? 'The actions below are the measured findings’ own.' : 'The figures below do not depend on it.'}</td></tr>`;
  /* What changed: yesterday, the same weekday last week, and the usual range
     of the four before it. An unusual row is marked, in words as well. */
  const wd = report ? WEEKDAY(f.day) : '';
  const changed = report ? `
<tr><td class="pad" style="padding:8px 36px 8px 36px">
  <div style="font:400 20px/1.3 ${SERIF};color:${T.ink};padding-bottom:4px">What changed</div>
  <div style="font:400 13px/1.5 ${SANS};color:${T.grey};padding-bottom:12px">Against last ${esc(wd)} and the usual range of the four ${esc(wd)}s before it${report.usable_prior_days?.length < 4 ? ` (${report.usable_prior_days.length} of them collected)` : ''}.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${th('')}${th('Yesterday', true)}${th(`Last ${esc(wd.slice(0, 3))}`, true)}${th('Usual', true)}${th('vs usual', true)}</tr>
    ${report.compare.map((c) => `<tr>${td(`${esc(c.label)}${c.unusual ? `&nbsp;<span style="color:${T.neg}">● unusual</span>` : ''}`)}${td(fmt(c.today), true, c.unusual)}${td(fmt(c.last_week), true)}${td(c.low == null ? '—' : `${fmt(c.low)}–${fmt(c.high)}`, true)}${td(c.vs_usual_pct == null ? '—' : `${c.vs_usual_pct > 0 ? '+' : ''}${c.vs_usual_pct}%`, true, c.unusual)}</tr>`).join('')}
  </table>
</td></tr>` : '';
  const byId = new Map((report?.findings || []).map((x) => [x.id, x]));
  const acts = (note?.actions || []).filter((a) => byId.has(a.finding));
  const todo = report ? `
<tr><td class="pad" style="padding:28px 36px 8px 36px">
  <div style="font:400 20px/1.3 ${SERIF};color:${T.ink};padding-bottom:12px">Do today</div>
  ${acts.length ? acts.map((a, i) => {
    const fd = byId.get(a.finding);
    const ev = evidenceLines(fd, wd);
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid ${T.hair}"><tr>
      <td valign="top" style="width:28px;padding:14px 0;font:400 20px/1.2 ${SERIF};color:${T.grey}">${i + 1}</td>
      <td valign="top" style="padding:14px 0">
        <div style="font:500 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey}">${esc(a.owner)}</div>
        <div style="font:400 15px/1.5 ${SANS};color:${T.ink};padding-top:3px">${esc(a.text)}</div>
        ${ev.length ? `<div style="font:400 12px/1.6 ${SANS};color:${T.grey};padding-top:6px">${ev.slice(0, 7).map(esc).join('<br>')}${ev.length > 7 ? `<br>and ${ev.length - 7} more` : ''}</div>` : ''}
      </td></tr></table>`;
  }).join('') : `<div style="font:400 14px/1.5 ${SANS};color:${T.grey}">Nothing needs doing: no figure was outside its usual range and no driver, car or cash check tripped.</div>`}
</td></tr>` : '';
  const cells = [
    figure('Revenue — fares', faresLine, esc(unpricedNote)),
    figure('Cash trips', `${int(f.cash.trips)}`, f.cash.trips ? `AED ${esc(aed(f.cash.amount))} in drivers’ hands${f.cash.unvalued ? ` · ${int(f.cash.unvalued)} with no amount yet` : ''}` : 'no cash taken'),
    figure('Active cars', int(f.cars.active), 'a booking or a telematics journey'),
    figure('Cars that earned', int(f.cars.earned), 'at least one priced booking'),
    figure('Drivers who earned', int(f.drivers_earned), `${int(f.drivers_drove)} drove`),
    figure('Average per driver', f.avg_per_driver == null ? absent('no driver earned') : money(f.avg_per_driver), 'fares ÷ drivers who earned'),
    figure('Average per car', f.avg_per_car == null ? absent('no car earned') : money(f.avg_per_car), 'fares ÷ cars that earned'),
    /* With the comparison table above, this cell is last week's fares; the
       day page's neighbouring-days figure only stands in without it. */
    (() => {
      const fc = report?.compare?.find((c) => c.key === 'fares');
      if (fc) {
        return figure(`Fares vs last ${WEEKDAY(f.day)}`, fc.vs_last_week_pct == null ? absent('last week was not collected')
          : `${fc.vs_last_week_pct > 0 ? '+' : ''}${esc(fc.vs_last_week_pct)}%`, fc.last_week == null ? '' : `against AED ${esc(aed(fc.last_week))}`);
      }
      return figure('Versus recent days', f.versus.delta_pct == null ? absent('no recent days to compare')
        : `${f.versus.delta_pct > 0 ? '+' : ''}${esc(f.versus.delta_pct)}%`,
      f.versus.median_bookings == null ? '' : `bookings against a median of ${int(f.versus.median_bookings)}`);
    })(),
  ];
  const channelRows = f.channels.map((c) => `<tr>${td(esc(CHANNEL[c.platform] || c.platform))}${td(int(c.bookings), true)}${td(c.completion_pct == null ? '—' : `${esc(c.completion_pct)}%`, true)}${td(c.fares == null ? '—' : aed(c.fares), true)}</tr>`).join('');
  const driverRows = f.drivers.map((p, i) => `<tr>${td(`<span class="n">${i + 1}</span>&nbsp;&nbsp;${esc(p.name)}`)}${td(`<span class="hide-s">${esc(p.platforms.map((x) => CHANNEL[x] || x).join(', '))}</span>`)}${td(int(p.bookings), true)}${td(p.fares == null ? '—' : aed(p.fares), true, true)}${td(p.cash ? aed(p.cash) : '—', true)}${td(`<span class="hide-s">${esc(p.plates.slice(0, 2).join(', '))}</span>`, false, false, true)}</tr>`).join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><title>Fleet — ${esc(longDay(f.day))}</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400&family=Karla:wght@400;500;600&display=swap" rel="stylesheet">
<style>
.th{font:500 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${T.grey};padding:0 0 8px 0;border-bottom:1px solid ${T.ink}}
.td{font:400 13px/1.45 ${SANS};color:${T.ink};padding:7px 0;border-bottom:1px solid ${T.hair};font-variant-numeric:tabular-nums}
.r{padding-left:12px;white-space:nowrap}.b{font-weight:600}.n{color:${T.grey}}.gap{padding-left:16px}
@media (max-width:480px){.hide-s{display:none}.pad{padding-left:18px!important;padding-right:18px!important}.fv{font-size:22px!important}}
</style></head>
<body style="margin:0;padding:0;background:${T.paper2}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${T.paper2}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:${T.paper}">
<tr><td class="pad" style="padding:36px 36px 8px 36px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr><td style="font:500 11px/1.4 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:${T.grey};padding-bottom:10px">Ecosine &amp; Egari · daily report</td></tr>
    <tr><td style="font:400 34px/1.15 ${SERIF};color:${T.ink};padding-bottom:24px">${esc(longDay(f.day))}</td></tr>
    ${warning}
    ${commentaryRow}
  </table>
</td></tr>
${todo}
${changed}
<tr><td class="pad" style="padding:28px 36px 8px 36px">
  <div style="font:400 20px/1.3 ${SERIF};color:${T.ink};padding-bottom:4px">Yesterday</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${grid(cells)}</table>
</td></tr>
<tr><td class="pad" style="padding:28px 36px 8px 36px">
  <div style="font:400 20px/1.3 ${SERIF};color:${T.ink};padding-bottom:12px">By channel</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${th('Channel')}${th('Bookings', true)}${th('Completion', true)}${th('Fares AED', true)}</tr>${channelRows}
  </table>
</td></tr>
<tr><td class="pad" style="padding:28px 36px 8px 36px">
  <div style="font:400 20px/1.3 ${SERIF};color:${T.ink};padding-bottom:4px">Drivers</div>
  <div style="font:400 13px/1.5 ${SANS};color:${T.grey};padding-bottom:12px">Everyone who drove a booking, by fares. Cash is what the 05:00 text asked each to deposit.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>${th('Driver')}${th('<span class="hide-s">Channels</span>')}${th('Bookings', true)}${th('Fares AED', true)}${th('Cash AED', true)}${thGap('<span class="hide-s">Car</span>')}</tr>${driverRows}
  </table>
</td></tr>
<tr><td class="pad" style="padding:28px 36px 36px 36px;font:400 12px/1.6 ${SANS};color:${T.grey}">
  Fares are what riders paid on priced bookings, before the platforms’ commission, in the Dubai day ${esc(f.day)}.
  Active cars recorded a booking or a telematics journey; cars and drivers that earned had at least one priced booking.
  ${opening ? `The summary and actions were written by ${esc(note.model)} from the measured findings alone; every number and name in them was checked against those findings.` : ''}
  ${dashboard ? `<br><a href="${esc(dashboard)}/#day/${esc(f.day)}" style="color:${T.ink}">Open this day on the dashboard</a>` : ''}
</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    `Ecosine & Egari — daily report — ${longDay(f.day)}`, '',
    missing.length ? `Not in these figures: ${missing.map((m) => `${CHANNEL[m.platform] || m.platform} ${FLEET[m.fleet] || m.fleet}`).join(', ')}.` : null,
    opening || `No commentary today — ${note?.why || 'it was not written'}.`, '',
    ...(report && acts.length ? ['Do today:', ...acts.map((a, i) => `${i + 1}. [${a.owner}] ${a.text}`), ''] : []),
    `Revenue (fares): ${f.fares == null ? 'not measured' : `AED ${aed(f.fares)}`} — ${unpricedNote}`,
    `Cash trips: ${int(f.cash.trips)}${f.cash.trips ? ` (AED ${aed(f.cash.amount)})` : ''}`,
    `Active cars: ${int(f.cars.active)} · cars that earned: ${int(f.cars.earned)}`,
    `Drivers who earned: ${int(f.drivers_earned)} of ${int(f.drivers_drove)} who drove`,
    `Average per driver: ${f.avg_per_driver == null ? 'not measured' : `AED ${aed(f.avg_per_driver)}`} · per car: ${f.avg_per_car == null ? 'not measured' : `AED ${aed(f.avg_per_car)}`}`,
    '', 'Drivers by fares:',
    ...f.drivers.map((p, i) => `${i + 1}. ${p.name} — ${p.bookings} bookings, AED ${p.fares == null ? '—' : aed(p.fares)}${p.cash ? `, cash AED ${aed(p.cash)}` : ''}`),
  ].filter((l) => l != null).join('\n');
  const subject = `Fleet ${f.day} — AED ${f.fares == null ? '—' : aed(f.fares)} fares · ${int(f.drivers_earned)} drivers · ${int(f.cars.earned)} cars earned`;
  return { html, text, subject };
}

/* ── recipients and sending ──────────────────────────────────────────────── */
export const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[A-Za-z]{2,}$/;

/* The addresses on the list, seeding it ONCE from REPORT_RECIPIENTS (the
   environment, never the repository) the first time it is found empty. A list
   an admin has emptied by removing everyone is not re-seeded: removed rows
   stay, marked, so "never seeded" and "emptied" are different. */
export async function recipients(q, { initial = get('REPORT_RECIPIENTS', '') } = {}) {
  const [{ n }] = await q(`SELECT count(*)::int AS n FROM report_recipient`);
  if (!n) {
    const seed = String(initial || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter((s) => EMAIL.test(s));
    for (const email of seed) {
      await q(`INSERT INTO report_recipient (email, added_by) VALUES ($1, 'initial list') ON CONFLICT DO NOTHING`, [email]);
    }
  }
  return (await q(`SELECT email FROM report_recipient WHERE removed_at IS NULL ORDER BY added_at, id`)).map((r) => r.email);
}

export async function resendSend({ http, key, from, to, subject, html, text, idem }) {
  const { status, data } = await http('https://api.resend.com/emails', {
    method: 'POST', timeoutMs: 30000, retries: 1,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'Idempotency-Key': idem },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (status >= 200 && status < 300 && data?.id) return { ok: true, id: data.id };
  const said = data && typeof data === 'object' ? (data.message || data.name || JSON.stringify(data)) : String(data || '');
  return { ok: false, error: `Resend HTTP ${status}: ${String(said).slice(0, 200)}` };
}

/** The morning run. Sends yesterday's report to every recipient not yet sent
    it; called every fifteen minutes from 07:00 to 09:45 Dubai, so a failed
    send (the sending domain unverified, Resend down) is retried and a
    recipient added at 08:00 still gets that day's email. Never sends one
    address the same day twice. */
export async function dailyReportRun({ q, now = new Date(), http = realHttp, day = yesterdayDubai(now),
  only = null, force = false, dashboard = get('PUBLIC_URL', '') || null } = {}) {
  const key = get('RESEND_API_KEY', '');
  const from = get('REPORT_FROM', 'Ecosine Fleet <reports@ecosine.ae>');
  const list = only ? [only] : await recipients(q);
  const sent = new Set((await q(`SELECT recipient FROM report_send WHERE business_day = $1::date AND status = 'sent'`, [day]))
    .map((r) => r.recipient));
  /* `force` (the "send me" button, one address): again, even if sent. */
  const due = only && force ? [only] : list.filter((e) => !sent.has(e));
  if (!due.length) return { day, due: 0, sent: 0, failed: 0 };
  if (!key) {
    await q(`INSERT INTO report_run (business_day, status, detail) VALUES ($1, 'failed', $2::jsonb)
             ON CONFLICT (business_day) DO UPDATE SET status = 'failed', detail = EXCLUDED.detail, updated_at = now()`,
    [day, JSON.stringify({ why: 'RESEND_API_KEY is not set for the collector' })]);
    return { day, due: due.length, sent: 0, failed: due.length, why: 'no RESEND_API_KEY' };
  }
  /* The figures and the commentary once per day, kept, so a retry at 07:15
     sends the email 07:00 composed rather than a second, different one. */
  let [run] = await q(`SELECT detail FROM report_run WHERE business_day = $1::date AND detail ? 'facts'`, [day]);
  let facts, note, report;
  if (run) ({ facts, note, report } = run.detail);
  else {
    facts = await reportFacts(q, day);
    const found = await reportFindings(q, day, { facts });
    note = await analyse(facts, found, { http });
    /* Kept as composed; the internal ref map is not needed to send it. */
    const { names: _names, cmp: _cmp, ...kept } = found;
    report = kept;
    await q(`INSERT INTO report_run (business_day, status, detail) VALUES ($1, 'composed', $2::jsonb)
             ON CONFLICT (business_day) DO UPDATE SET status = 'composed', detail = EXCLUDED.detail, updated_at = now()`,
    [day, JSON.stringify({ facts, note, report })]);
  }
  const { html, text, subject } = renderEmail(facts, note, { dashboard, report });
  let ok = 0, bad = 0;
  for (const to of due) {
    /* A forced resend needs its own key: Resend drops a repeated one for a day. */
    const idem = `daily-report/${day}/${to}${force ? `/manual-${now.getTime()}` : ''}`;
    const r = await resendSend({ http, key, from, to, subject, html, text, idem })
      .catch((e) => ({ ok: false, error: String(e.message || e).slice(0, 200) }));
    await q(`INSERT INTO report_send (business_day, recipient, status, provider_id, error)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (business_day, recipient) DO UPDATE SET status = EXCLUDED.status,
               provider_id = EXCLUDED.provider_id, error = EXCLUDED.error, attempts = report_send.attempts + 1,
               updated_at = now()`,
    [day, to, r.ok ? 'sent' : 'failed', r.id || null, r.ok ? null : r.error]);
    r.ok ? ok++ : bad++;
  }
  await q(`UPDATE report_run SET status = $2, updated_at = now() WHERE business_day = $1::date`,
    [day, bad ? (ok ? 'partial' : 'failed') : 'sent']);
  log[bad ? 'warn' : 'info'](SRC, 'daily report', { day, sent: ok, failed: bad, commentary: note?.outcome });
  return { day, due: due.length, sent: ok, failed: bad, commentary: note?.outcome };
}
