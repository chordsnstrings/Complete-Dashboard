/* The revenue target, on Today — one shape, both shells.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-02: "the first page will show how much every day we
   need to earn and yesterday were we over or under … Put green and red as
   colours to denote success or failures." The arithmetic is the server's
   (api/revenue_target.js); this module turns /api/target into the words both
   shells print, so the desktop and the phone cannot word a verdict
   differently — the reason ./today.js exists, applied again.

   ── GREEN AND RED, AND WHAT CARRIES THEM ───────────────────────────────────
   Green is over, red is under, and only on a day that is FINISHED and
   SETTLED: today is an estimate until Uber publishes its fares (hours after
   the ride, fetched every hour) and is never coloured. Every coloured verdict also carries ▲ or ▼ and the word OVER or
   UNDER, so it still reads for the one man in twelve who cannot tell the two
   colours apart, and on a printout. The colours are the skin's own semantic
   tokens (--good, --critical), already checked in both themes.

   ── ABSENT, NEVER ZERO ───────────────────────────────────────────────────
   No target for the month: the panel says so and where it is set. A day
   still waiting for a channel or for Uber's prices: "not settled yet", with
   what it waits for.

   ── THE TRIPS CHART ──────────────────────────────────────────────────────
   The operator, the same day: "There should also be a minimum 12 trips per
   day per active driver. there should be a similar chart for that too." The
   same four cells and the same strip, under the revenue, for trips: a day is
   over when its completed trips reach its active drivers × the minimum. A
   floor, not a quota, so nothing is carried from one day to the next, and it
   shows whether or not a revenue target is set — the minimum always exists.
   A role that does not hold booking counts reads why, not a zero. */
import { api } from './data.js';
import { money, fils, esc } from './ui.js';
import { withheldSentence } from './access_model.js';

const n0 = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
const pct = (v) => (v == null ? null : `${Number(v).toFixed(1)}%`);
const plural = (n, one, many = `${one}s`) => `${n0(n)} ${n === 1 ? one : many}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthWord = (m) => MONTHS[Number(String(m).slice(5, 7)) - 1] || m;

/** The month as the page shows it — live, never a held copy: a save on the
    Access page has to show here at once (the server never caches it either). */
export async function targetLive({ quiet = true } = {}) {
  const minute = Math.floor(Date.now() / 60000);
  return api(`/api/target?t=${minute}`, { cache: 'no-store', ...(quiet ? { quiet: true } : {}) });
}

/* A verdict, in the arrow-and-word form every coloured figure carries. */
const verdictLine = (d) => {
  if (d.verdict === 'over') return { text: `▲ Over by ${money(d.diff)}`, tone: 'over' };
  if (d.verdict === 'under') return { text: `▼ Under by ${money(-d.diff)}`, tone: 'under' };
  if (d.verdict === 'unsettled') return { text: 'Not settled yet', tone: 'wait' };
  return { text: '—', tone: null };
};
const tripsVerdict = (d) => {
  /* Trips are whole numbers, so the minimum is hit to the trip far more
     often than a target in fils — and "over by 0" reads as a mistake. */
  if (d.trips_verdict === 'over' && d.trips_diff === 0) return { text: '▲ Met exactly', tone: 'over' };
  if (d.trips_verdict === 'over') return { text: `▲ Over by ${n0(d.trips_diff)} ${d.trips_diff === 1 ? 'trip' : 'trips'}`, tone: 'over' };
  if (d.trips_verdict === 'under') return { text: `▼ Under by ${n0(-d.trips_diff)} ${d.trips_diff === -1 ? 'trip' : 'trips'}`, tone: 'under' };
  if (d.trips_verdict === 'unsettled') return { text: 'Not settled yet', tone: 'wait' };
  return { text: '—', tone: null };
};
const perDriver = (v) => (v == null ? '—' : Number(v).toFixed(1));
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* "Mon 11, Tue 12, … Sun 10" — api/target_weights.js minimumOn, Monday first. */
const weekdayMinimums = (min, w) => [1, 2, 3, 4, 5, 6, 0]
  .map((i) => `${WEEKDAY[i].slice(0, 3)} ${Math.max(1, Math.round(min * Number(w[i])))}`).join(', ');

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (d) => (d ? `${Number(d.slice(8, 10))} ${MON3[Number(d.slice(5, 7)) - 1]}` : '');

/* ── 00 · the month, by vehicle class ──────────────────────────────────── */
/* The operator, 2026-10-29: "Let me set targets vehicle wise. Make model year
   - per day target, which will reflect everywhere." Each make + model + year:
   the cars it counts today, what a car of it is asked on an average day,
   today's plan, yesterday and the month so far against plan
   (api/revenue_target.js computeMonth classes). Under one rate for every car
   the same table is each class's share of that one target. A car with no
   make or model on file is named, with the figure it is asked and why;
   fares that came with no plate are counted in the month and belong to no
   class, and are shown as that. */
export function classesHtml(t) {
  const fmt = (v, d = 0) => (v == null ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const s = t.summary;
  const rows = (t.classes || []).filter((c) => !c.no_plate);
  const loose = (t.classes || []).find((c) => c.no_plate) || null;
  if (!s || !rows.length) return `<p class="tg-absent">${esc(s ? 'No car has earned in the last 7 days, so no class has a plan yet.' : (t.why || 'No target is set.'))}</p>`;
  const dash = '<span class="hp-dim">—</span>';
  const of = (a, b2) => (a == null && b2 == null ? dash : `${esc(money(a ?? 0))} <span class="hp-dim">${esc(`of ${money(b2 ?? 0)}`)}</span>`);
  const tone = (c) => (c.ahead == null ? '' : c.ahead >= 0 ? 'tg-over' : s.unsettled ? '' : 'tg-under');
  const hasY = rows.some((c) => c.yday_plan != null || c.yday_earned != null);
  const body = rows.map((c) => {
    const name = c.key == null
      ? `${esc(c.label)}<br><span class="hp-dim">${esc(`${(c.plates || []).join(', ')} — asked the figure for every other car`)}</span>`
      : `${esc(c.label)}${c.uses_other ? `<br><span class="hp-dim">${esc('no figure of its own — the figure for every other car')}</span>` : ''}`;
    return `<tr><th scope="row">${name}</th><td>${esc(fmt(c.cars_now))}</td><td>${c.rate == null ? dash : esc(money(c.rate))}</td>`
      + `<td>${c.plan_today == null ? dash : esc(money(c.plan_today))}</td>`
      + (hasY ? `<td>${of(c.yday_earned, c.yday_plan)}</td>` : '')
      + `<td class="${tone(c)}">${of(c.earned, c.planned)}${c.pct != null ? ` <span class="hp-dim">${esc(`${fmt(c.pct, 1)}%`)}</span>` : ''}</td>`
      + `<td>${c.month_plan == null ? dash : esc(money(c.month_plan))}</td></tr>`;
  }).join('');
  const sum = (k) => rows.reduce((n, c) => n + (c[k] || 0), 0);
  const total = `<tr class="tp-cls-sum"><th scope="row">All cars</th><td>${esc(fmt(sum('cars_now')))}</td>`
    + `<td>${esc(money(s.rate))} <span class="hp-dim">on average</span></td><td>${esc(money(sum('plan_today')))}</td>`
    + (hasY ? `<td>${esc(money(sum('yday_earned') + (loose?.yday_earned || 0)))} <span class="hp-dim">${esc(`of ${money(sum('yday_plan'))}`)}</span></td>` : '')
    + `<td>${esc(money(s.earned))} <span class="hp-dim">${esc(`of ${money(s.planned)}`)}</span></td>`
    + `<td>${esc(money(s.month_target))}</td></tr>`;
  const looseRow = loose ? `<tr class="hp-quiet"><th scope="row">${esc(loose.label)}</th><td>${dash}</td><td>${dash}</td><td>${dash}</td>`
    + (hasY ? `<td>${esc(money(loose.yday_earned || 0))}</td>` : '') + `<td>${esc(money(loose.earned))}</td><td>${dash}</td></tr>` : '';
  const how = s.kind === 'class'
    ? `Each car is asked its class’s figure for an average day × the day’s weekday weight; the Owner set the figures on ${dm(s.rates_set_day)} (Set up › Access). A class with no figure of its own, and a car with no make or model on file, is asked the figure for every other car, ${money(s.other_rate)}. The month target is the sum of every car’s plan, so it moves as cars join or drop out.`
    : `This month’s target is one figure for every car — ${money(s.rate)} a car ${s.weighted ? 'on an average day' : 'a day'} — so this is each class’s share of it. Daily targets by vehicle class are set in Set up › Access.`;
  return '<div class="tablewrap"><table class="hp tp-cls"><thead><tr><th scope="col">Make, model, year</th><th scope="col">Cars</th>'
    + `<th scope="col">AED a car, average day</th><th scope="col">Today’s plan</th>${hasY ? '<th scope="col">Yesterday, earned of plan</th>' : ''}`
    + '<th scope="col">Month so far, earned of plan</th><th scope="col">Month plan</th></tr></thead>'
    + `<tbody>${body}${looseRow}${total}</tbody></table></div>`
    + `<p class="cap hp-basis">${esc(`${how} Cars are the ones that earned in the 7 days before; a class’s earnings are its plates’ fares, before commission, on the days gone.${loose ? ' Fares that came with no plate count in the month and belong to no class.' : ''}`)}</p>`;
}

/** The words: { title, scope, meta, cells[{label, value, tone, subs[{text,tone}], bar}], strip[], absent }. */
export function targetView(t, live = null) {
  if (!t || !Array.isArray(t.days)) return null;
  const s = t.summary;
  const vm = {
    title: `${monthWord(t.month)} target`,
    scope: 'Both fleets · gross fares, before platform commission',
    /* Under daily targets by vehicle class (api/revenue_target.js, since
       2026-10-29) each car is asked its own class's figure, so "a car" is
       an average over today's cars, and says so. */
    meta: !s ? null : s.kind === 'class'
      ? `${plural(s.cars_now, 'car')} · targets by vehicle class, ${money(s.rate)} a car on an average day on average`
      : `${plural(s.cars_now, 'car')} · ${money(s.rate)} a car ${s.weighted ? 'on an average day' : 'a day'}`,
    cells: [], strip: [], absent: null,
    trips: tripsView(t),
  };
  if (!s) {
    vm.absent = t.why;
    return vm;
  }

  /* ── yesterday ─────────────────────────────────────────────────────────── */
  const y = t.yesterday || null;
  const yHasTarget = t.yesterday_month ? Boolean(t.yesterday_month.target) : Boolean(t.target);
  if (y && yHasTarget) {
    const v = verdictLine(y);
    const subs = [{ text: y.verdict === 'unsettled'
      ? `${fils(y.earned)} counted of ${fils(y.needed)} needed`
      : `${fils(y.earned)} of ${fils(y.needed)} needed${y.pct != null ? ` · ${pct(y.pct)}` : ''}` }];
    if (y.verdict === 'over' && y.provisional) subs.push({ text: `At least: ${y.why}` });
    if (y.verdict === 'unsettled' && y.why) subs.push({ text: y.why });
    vm.cells.push({ key: 'yesterday', label: `Yesterday · ${y.label}`, value: v.text, tone: v.tone, subs });
  } else if (y) {
    vm.cells.push({ key: 'yesterday', label: `Yesterday · ${y.label}`, value: 'No target',
      subs: [{ text: t.yesterday_month?.why || t.why || 'No target was set for that day.' }] });
  }

  /* ── today ─────────────────────────────────────────────────────────────── */
  const td = t.days.find((d) => d.state === 'today') || null;
  if (td) {
    const subs = [{ text: s.kind === 'class'
      ? `${plural(s.today_cars, 'car')}, each at its class’s target — ${money(s.today_per_car)} a car on average`
      : `${plural(s.today_cars, 'car')} × ${money(s.today_per_car)}` }];
    /* Shared by weekday since 2026-10-11 (api/target_weights.js): what share
       of an average day this weekday is asked for, and why. */
    if (s.weighted && s.today_weight != null) {
      subs.push({ text: `${WEEKDAY[td.dow]}s bring ${Math.round(100 * s.today_weight)}% of an average day, so today is asked that share` });
    }
    let bar = null;
    if (live && live.started) {
      const est = live.expected != null ? live.expected : live.fares;
      if (est != null) {
        subs.push({ text: live.expected != null
          ? `≈ ${money(Math.round(est / 10) * 10)} so far — an estimate until Uber publishes the day’s fares (fetched every hour)`
          : `${money(est)} so far, on record` });
        bar = s.today_needs > 0 ? Math.max(0, Math.min(100, (100 * est) / s.today_needs)) : 100;
      }
    }
    vm.cells.push({ key: 'today', label: `Today · ${td.label}`,
      value: s.met ? 'Month target met' : `${money(s.today_needs)} to earn`, tone: s.met ? 'over' : null, subs, bar });
  }

  /* ── the month so far ──────────────────────────────────────────────────── */
  const past = t.days.filter((d) => d.state === 'past');
  if (past.length) {
    /* Behind with days still unsettled may be a count still filling: said
       in ink, not red, until every day has settled. Ahead is ahead. */
    const tone = s.ahead >= 0 ? 'over' : (s.unsettled ? 'wait' : 'under');
    vm.cells.push({ key: 'month', label: `${monthWord(t.month)} so far`,
      value: s.ahead >= 0 ? `▲ ${money(s.ahead)} ahead` : `▼ ${money(-s.ahead)} behind`, tone,
      subs: [{ text: `${fils(s.earned)} earned of ${fils(s.planned)} planned` },
        { text: `${plural(past.length, 'day')} gone: ${n0(s.over)} over, ${n0(s.under)} under`
          + (s.unsettled ? `, ${n0(s.unsettled)} not settled yet` : '') }] });
  } else {
    vm.cells.push({ key: 'month', label: `${monthWord(t.month)} so far`,
      value: td ? 'First day' : 'Not begun', subs: [{ text: td ? 'Nothing to judge until tomorrow.' : `It begins on ${t.days[0].label}.` }] });
  }

  /* ── the month ─────────────────────────────────────────────────────────── */
  const msubs = [{ text: `${fils(s.to_go)} to go · ${plural(s.days_left, 'day')} left` }];
  if (s.since_set) {
    msubs.push({ text: `Set at ${money(s.gross_set)} over ${plural(s.cars_at_set, 'car')}; `
      + `${s.since_set > 0 ? 'cars have joined' : 'cars have dropped out'} since (${s.cars_at_set} → ${s.cars_now})` });
  } else {
    msubs.push({ text: `Set over ${plural(s.cars_at_set, 'car')} — a car that joins adds its share of the days left` });
  }
  vm.cells.push({ key: 'total', label: 'Month target', value: money(s.month_target), subs: msubs });

  /* ── day by day ────────────────────────────────────────────────────────── */
  vm.strip = t.days.map((d) => {
    const tone = d.state === 'today' ? 'today' : d.state === 'future' ? 'future'
      : d.verdict === 'over' ? 'over' : d.verdict === 'under' ? 'under' : d.verdict === 'unsettled' ? 'wait' : 'none';
    const title = d.state === 'future' ? `${d.label}: needs ${fils(d.needed)} if today is met`
      : d.state === 'today' ? `${d.label}: today — needs ${fils(d.needed)}`
        : d.verdict === 'unsettled' ? `${d.label}: not settled — ${d.why || ''}`.trim()
          : `${d.label}: needed ${fils(d.needed)}, earned ${fils(d.earned)} — ${verdictLine(d).text.replace(/^[▲▼] /, '').toLowerCase()}`
            + (d.provisional ? ' (at least)' : '');
    return { day: d.day, n: Number(d.day.slice(8)), tone, title, past: d.state === 'past' };
  });
  return vm;
}

/** The trips chart's words: { title, scope, meta, cells, strip, absent },
    the revenue's shape, so both shells draw it with the same code. */
export function tripsView(t) {
  if (!t || !Array.isArray(t.days)) return null;
  const min = t.trips_min;
  const ts = t.trips_summary || null;
  const out = {
    title: ts?.weighted ? `Trips · at least ${min} on an average day per active driver, each weekday its share` : `Trips · at least ${min} a day per active driver`,
    scope: 'Both fleets · completed trips; an active driver completed one in the last 8 days',
    meta: null, cells: [], strip: [], absent: null,
  };
  /* Withheld for this role: the trip counts come back null, and the
     sentence says so — never a strip of empty days that reads as no trips. */
  const level = t._withheld?.BK;
  if (!ts || ts.trips == null) {
    out.absent = level != null ? withheldSentence('BK', { level: level === 'A' ? 'A' : '' })
      : 'No trips have been counted for this month yet.';
    return out;
  }
  if (ts.today_active != null) out.meta = `${plural(ts.today_active, 'active driver')} today · ${ts.today_min ?? min} trips each`;

  /* ── yesterday ─────────────────────────────────────────────────────────── */
  const y = t.yesterday || null;
  if (y && y.trips_target) {
    const v = tripsVerdict(y);
    const subs = [{ text: y.trips_verdict === 'unsettled'
      ? `${n0(y.trips)} counted of ${n0(y.trips_target)} needed`
      : `${n0(y.trips)} of ${n0(y.trips_target)} needed${y.trips_pct != null ? ` · ${pct(y.trips_pct)}` : ''}` },
    { text: `${perDriver(y.trips_per_active)} a driver · ${plural(y.active_drivers, 'active driver')} × ${y.trips_min ?? min}` },
    { text: `${n0(y.reached)} of the ${n0(y.drove)} who drove did ${y.trips_min ?? min} or more` }];
    if (y.trips_verdict === 'over' && y.trips_provisional && y.why) subs.push({ text: `At least: ${y.why}` });
    if (y.trips_verdict === 'unsettled' && y.why) subs.push({ text: y.why });
    out.cells.push({ key: 'trips-yesterday', label: `Yesterday · ${y.label}`, value: v.text, tone: v.tone, subs });
  } else if (y) {
    out.cells.push({ key: 'trips-yesterday', label: `Yesterday · ${y.label}`, value: '—',
      subs: [{ text: 'Nobody had completed a trip in the 8 days to it, so it asked for none.' }] });
  }

  /* ── today ─────────────────────────────────────────────────────────────── */
  const td = t.days.find((d) => d.state === 'today') || null;
  if (td && td.trips_target) {
    out.cells.push({ key: 'trips-today', label: `Today · ${td.label}`, value: `${n0(td.trips_target)} trips to complete`,
      tone: null, bar: Math.max(0, Math.min(100, (100 * (td.trips || 0)) / td.trips_target)),
      subs: [{ text: `${plural(td.active_drivers, 'active driver')} × ${td.trips_min ?? min}`
        + (td.trips_weight != null && td.trips_min !== min ? ` — a ${WEEKDAY[td.dow]}’s share of ${min}` : '') },
        { text: `${n0(td.trips)} completed so far, on record` }] });
  } else if (td) {
    out.cells.push({ key: 'trips-today', label: `Today · ${td.label}`, value: '—',
      subs: [{ text: 'Nobody has completed a trip in the last 8 days.' }] });
  }

  /* ── the month so far ──────────────────────────────────────────────────── */
  const past = t.days.filter((d) => d.state === 'past' && d.trips_target);
  if (past.length && ts.per_active != null) {
    /* Against what the days asked — each its weekday's minimum — not
       against the average day's: a month of Sundays asks fewer. */
    const ok = ts.trips >= ts.needed;
    out.cells.push({ key: 'trips-month', label: `${monthWord(t.month)} so far`,
      value: `${ok ? '▲' : '▼'} ${perDriver(ts.per_active)} a driver a day`,
      tone: ok ? 'over' : (ts.unsettled ? 'wait' : 'under'),
      subs: [{ text: `${n0(ts.trips)} trips of ${n0(ts.needed)} needed` },
        { text: `${plural(past.length, 'day')} gone: ${n0(ts.over)} over, ${n0(ts.under)} under`
          + (ts.unsettled ? `, ${n0(ts.unsettled)} not settled yet` : '') }] });
  } else {
    out.cells.push({ key: 'trips-month', label: `${monthWord(t.month)} so far`,
      value: td ? 'First day' : 'Not begun', subs: [{ text: td ? 'Nothing to judge until tomorrow.' : `It begins on ${t.days[0].label}.` }] });
  }

  /* ── the minimum ───────────────────────────────────────────────────────── */
  out.cells.push({ key: 'trips-min', label: 'The minimum', value: ts.weighted ? `${min} trips on an average day` : `${min} trips a day`,
    subs: [{ text: ts.weighted
      ? `Per active driver, by weekday: ${weekdayMinimums(min, ts.weights)}. A day short is not carried over: every day starts at its minimum again.`
      : 'Per active driver. A day short is not carried over: every day starts at the minimum again.' },
    { text: ts.weighted ? 'Set in Set up › Access — the 08:00 email names each driver under the day’s minimum.'
      : 'Set in Set up › Access — the 08:00 email names each driver under it.' }] });

  /* ── day by day ────────────────────────────────────────────────────────── */
  out.strip = t.days.map((d) => {
    const tone = d.state === 'today' ? 'today' : d.state === 'future' ? 'future'
      : d.trips_verdict === 'over' ? 'over' : d.trips_verdict === 'under' ? 'under' : d.trips_verdict === 'unsettled' ? 'wait' : 'none';
    const title = d.state === 'future' ? `${d.label}: to come`
      : d.state === 'today' ? `${d.label}: today — ${n0(d.trips)} of ${n0(d.trips_target)} trips so far`
        : !d.trips_target ? `${d.label}: no active driver`
          : d.trips_verdict === 'unsettled' ? `${d.label}: not settled — ${d.why || ''}`.trim()
            : `${d.label}: ${n0(d.trips)} trips by ${plural(d.active_drivers, 'active driver')} (${perDriver(d.trips_per_active)} each), `
              + `needed ${n0(d.trips_target)} — ${tripsVerdict(d).text.replace(/^[▲▼] /, '').toLowerCase()}`
              + (d.trips_provisional ? ' (at least)' : '');
    return { day: d.day, n: Number(d.day.slice(8)), tone, title, past: d.state === 'past' };
  });
  return out;
}

/* The desktop panel (both skins; arkiv.css and app.css dress it). `link`
   turns a past day into the address of its day page. */
export function targetHtml(vm, { link = null } = {}) {
  if (!vm) return '';
  const top = (b) => `<div class="tg-top"><span class="tg-title">${esc(b.title)}</span>`
    + `<span class="tg-scope">${esc(b.scope)}</span>`
    + (b.meta ? `<span class="tg-meta">${esc(b.meta)}</span>` : '') + '</div>';
  const body = (b) => {
    if (b.absent) return `<p class="tg-absent">${esc(b.absent)}</p>`;
    const cells = b.cells.map((c) => `<div class="tg-cell${c.tone ? ` tg-${c.tone}` : ''}" data-tg="${esc(c.key)}">`
      + `<span class="tg-l">${esc(c.label)}</span><b class="tg-v">${esc(c.value)}</b>`
      + (c.bar != null ? `<span class="tg-bar" role="img" aria-label="${Math.round(c.bar)}% of today’s need so far"><i style="width:${c.bar.toFixed(1)}%"></i></span>` : '')
      + c.subs.map((x) => `<span class="tg-sub${x.tone ? ` tg-${x.tone}` : ''}">${esc(x.text)}</span>`).join('')
      + '</div>').join('');
    const strip = b.strip.map((d) => {
      const tag = d.past && link ? 'a' : 'span';
      return `<${tag} class="tg-d tg-${d.tone}"${tag === 'a' ? ` href="${esc(link(d.day))}"` : ''} title="${esc(d.title)}"`
        + ` aria-label="${esc(d.title)}">${d.n}</${tag}>`;
    }).join('');
    return `<div class="tg-cells">${cells}</div>`
      + `<div class="tg-strip" aria-label="${esc(b.title)}, day by day">${strip}</div>`;
  };
  const trips = vm.trips ? `<div class="tg-band" data-tg-band="trips">${top(vm.trips)}${body(vm.trips)}</div>` : '';
  /* One key for both strips, once either has one to explain. */
  const legend = (!vm.absent || (vm.trips && !vm.trips.absent))
    ? '<p class="tg-legend"><span class="tg-key tg-over"></span>over'
      + '<span class="tg-key tg-under"></span>under<span class="tg-key tg-wait"></span>not settled yet'
      + '<span class="tg-key tg-today"></span>today<span class="tg-key tg-future"></span>to come'
      + ' · a day is judged once every channel has delivered it and Uber has priced it</p>'
    : '';
  return `<div class="tg-band" data-tg-band="revenue">${top(vm)}${body(vm)}</div>${trips}${legend}`;
}

/** The Today workbook, fetched rather than navigated to: a refusal comes back
    as JSON with a reason and is said in words, not opened as a page. */
export const downloadToday = () => downloadFile('/api/export/today.xlsx', 'today.xlsx');

/** Any of the Today section's workbooks (the Month target page's too), the
    same way: fetched, saved from a blob, a refusal thrown as its reason. */
export async function downloadFile(url, fallback) {
  const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) {
    let why = '';
    try { why = (await r.json()).detail || ''; } catch { /* not json */ }
    throw new Error(why || `The file could not be made (HTTP ${r.status}).`);
  }
  const blob = await r.blob();
  const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || fallback;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return name;
}
