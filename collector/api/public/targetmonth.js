/* THE MONTH TARGET PAGE — every day of the month against its target, where
   the month lands, and the drivers behind.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-08, beside the Target page: "next to target there
   should be a page for monthly view of the target, per day. I understand you
   can see it on top with red or green, but ops team can get a better view.
   That should have daily targets, gross revenue from all platforms, how much
   was missed every day on one graph … At the bottom, let's keep drivers who
   didn't earn target gross fare, or trip numbers, 30 of them, downloadable as
   an excel … In the same page, we should also focus on what our current
   trajectory would mean for the end of the month and how short or more we
   would be from the target."

   So, top to bottom:
     00  THE MONTH — the target, what is earned, and where the month lands:
         at the average day so far (the Target page's "At this pace") and at
         the last 7 settled days' pace, each said as AED short of or over the
         target; and what every day left must bring.
     01  DAY BY DAY — one chart: each day's target as an outline, its gross
         as a bar (green over, red under, grey while it waits for fares), and
         the amount over or missed printed above it. Under it, the same days
         in figures, each finished day a link to its day page.
     02  WHERE THE MONTH LANDS — the month added up day by day: the target's
         path, what was earned, and both paces carried to the month's end.
     03  DRIVERS BEHIND TARGET — the 30 furthest below their money target or
         their trips, a switch between the two lists, and every driver in the
         Excel file.

   Every figure is the server's (api/target_month.js). The days, their
   targets and their verdicts are computeMonth's, so this page and the Target
   page cannot disagree about a day. A driver's money target is each settled
   day's plan shared among the drivers active that day; their trips target is
   the minimum for every such day.

   Green and red follow ./target.js: only a finished, settled day is
   coloured, and every coloured figure carries ▲ or ▼ and a word, for the one
   reader in twelve who cannot tell the two colours apart and for a printout.
   Absent, never zero: no target, a class withheld from the reader's role, a
   day still waiting for fares — each is said in words where its figure would
   have been. */
import { api, alive, currentGen, href } from './data.js';
import { el, esc, money, countOf, sourceLabel, panel, secHead, loading, contract } from './ui.js';
import { fmt } from './charts.js';
import { withheldSentence } from './access_model.js';
import { downloadFile } from './target.js';

/* The operator's number, and the server's (api/target_month.js SHOW_BEHIND). */
export const SHOW_BEHIND = 30;
/* The month moves when fares arrive — hourly at most — not by the minute
   like the Target page's hours. */
export const REFRESH_MS = 5 * 60000;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isMonth = (m) => MONTH_RE.test(String(m || ''));

/** /api/target/month for `month` (null: this Dubai month), live — a target
    saved on the Access page shows at once; the server never caches it. */
export async function monthTargetLive(month = null) {
  const minute = Math.floor(Date.now() / 60000);
  return api(`/api/target/month?${isMonth(month) ? `month=${month}&` : ''}t=${minute}`, { cache: 'no-store' });
}

/** The workbook of the month on screen. */
export const workbookUrl = (month = null) => `/api/export/target-month.xlsx${isMonth(month) ? `?month=${month}` : ''}`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const monthWord = (m) => MONTHS[Number(String(m).slice(5, 7)) - 1] || m;
/** The month `k` months from `m`, 'YYYY-MM'. */
export const shiftMonth = (m, k) => {
  const [y, mo] = String(m).split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1 + k, 15)).toISOString().slice(0, 7);
};

const aed = (v) => (v == null ? '—' : money(v));
const n0 = (v) => (v == null ? '—' : fmt(v));
const pc = (v) => (v == null ? '—' : `${fmt(v, 1)}%`);
const tone = (v) => (v == null ? null : v >= 0 ? 'over' : 'under');
const said = (cls, lvl) => withheldSentence(cls, { level: lvl === 'A' || lvl === 'M' ? lvl : '' });
/* The chart's own figures, in thousands: 12,400 → 12.4k, 9,960 → 10k. The
   key says the unit; the table under the chart has every figure to the fils. */
export const kilo = (v) => {
  const a = Math.abs(Number(v) || 0);
  return a >= 9950 ? `${Math.round(a / 1000)}k` : a >= 1000 ? `${(a / 1000).toFixed(1)}k` : `${Math.round(a)}`;
};
/* Whole thousands, for a column too narrow for a decimal: 1,900 → 2k. */
const kilo0 = (v) => { const a = Math.abs(Number(v) || 0); return a >= 1000 ? `${Math.round(a / 1000)}k` : `${Math.round(a)}`; };
const big = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : kilo(v));
/* Gridlines at round figures: about `lines` of them up to `hi`. */
const niceStep = (hi, lines = 4) => {
  const raw = Math.max(1, hi) / lines;
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].find((x) => x * p >= raw) * p;
};
/** The over-or-missed words every coloured figure here carries. */
export const gapWords = (v, { over = 'over', short = 'short' } = {}) => (v == null ? '—'
  : v >= 0 ? `▲ ${money(v)} ${over}` : `▼ ${money(-v)} ${short}`);

/* A cell, in the Target page's shape (app.css / arkiv.css .targetnow .tg-*). */
const cell = (key, label, value, subs, t2 = null) => `<div class="tg-cell${t2 ? ` tg-${t2}` : ''}" data-mt="${esc(key)}">`
  + `<span class="tg-l">${esc(label)}</span><b class="tg-v">${esc(value)}</b>`
  + subs.filter(Boolean).map((x) => `<span class="tg-sub${x.tone ? ` tg-${x.tone}` : ''}">${esc(x.text ?? x)}</span>`).join('')
  + '</div>';

/* ── 00 · the month ─────────────────────────────────────────────────────── */
/** The month's five cells — target, earned, the two paces, what every day
    left must bring — then the trips and any day still waiting, in words. */
export function monthHtml(v) {
  const wh = v._withheld || {};
  const s = v.summary;
  const tj = v.trajectory;
  if (!s) return `<p class="tg-absent">${esc(v.why || `No target is set for ${v.month_name}.`)}</p>`;
  if (s.month_target == null) return `<p class="tg-absent">${esc(wh.REV != null ? said('REV', wh.REV) : 'The month’s target could not be read.')}</p>`;
  const past = v.days.filter((d) => d.state === 'past');
  const lastPast = past.length ? past[past.length - 1].label : null;
  const over = s.days_left === 0 && past.length > 0;
  const cells = [];
  /* The cars the rate is spread over: this month's are the cars earning now
     (the Target page's figure); a month that is over was set over the cars
     of its own save — today's fleet says nothing about August. */
  cells.push(cell('target', 'Month target', aed(s.month_target), [
    over ? `${money(s.rate)} a car a day, set over ${countOf(s.cars_at_set, 'car')}`
      : `${money(s.rate)} a car a day over ${countOf(s.cars_now, 'car')}`,
    `${countOf(v.days_in_month, 'day')} · gross fares, before commission`]));
  cells.push(cell('earned', lastPast ? `Earned to ${lastPast}` : 'Earned so far', past.length ? aed(s.earned) : '—', [
    past.length ? `of ${money(s.planned)} planned to then` : 'Nothing of the month has finished yet.',
    past.length ? { text: s.ahead >= 0 ? `▲ ${money(s.ahead)} ahead of plan` : `▼ ${money(-s.ahead)} behind plan`,
      tone: s.ahead >= 0 ? 'over' : (s.unsettled ? 'wait' : 'under') } : null]));
  if (over) {
    /* A month that is over has no pace to carry and no day left to ask of:
       what it came to, how many of its days made their target, and its best
       and worst day, instead. */
    const end = s.earned - s.month_target;
    cells.push(cell('ended', 'The month ended', end >= 0 ? '▲ Target met' : '▼ Target missed', [
      { text: gapWords(end), tone: tone(end) },
      `${money(s.earned)} — ${pc((100 * s.earned) / s.month_target)} of the target`], tone(end)));
    cells.push(cell('days', 'Days on target', `${n0(s.over)} of ${n0(s.days_gone)}`, [
      `${countOf(s.under, 'day')} under${s.unsettled ? ` · ${countOf(s.unsettled, 'day')} not settled yet` : ''}`,
      `${money(s.avg_day)} a day on average`]));
    cells.push(cell('best', 'Best day, worst day', s.best ? `${s.best.label}` : '—', [
      s.best ? `${money(s.best.earned)} on the best` : null,
      s.worst ? `${s.worst.label}: ${money(s.worst.earned)} on the worst` : null]));
    return `<div class="targetnow tg-page"><div class="tg-cells tg-cells5">${cells.join('')}</div></div>`
      + monthNotes(v, lastPast, wh).map((x) => `<p class="mt-note">${esc(x)}</p>`).join('');
  }
  /* Each pace: the headline is the gap — "how short or more we would be" —
     and the month's end and the pace behind it are its subs. */
  const pace = (key, label, p, none, how) => (p
    ? cell(key, label, gapWords(p.vs_target), [`the month ends at ${money(p.month_end)} — ${pc(p.pct)} of the target`, how(p)],
      tone(p.vs_target))
    : cell(key, label, '—', [none]));
  cells.push(pace('avg', 'At the average day so far', tj?.avg, 'Nothing of the month has finished yet.',
    (p) => `${money(p.per_day)} a day over ${countOf(p.days, 'day')} — the Target page’s “at this pace”`));
  const rn = tj?.recent?.days || 7;
  const dayOf = (d) => v.days.find((x) => x.day === d)?.label || d;
  cells.push(pace('recent', `At the last ${rn} settled ${rn === 1 ? 'day' : 'days'}`, tj?.recent, 'No day of the month has settled yet.',
    (p) => `${money(p.per_day)} a day, ${dayOf(p.from)} to ${dayOf(p.to)}, carried over the ${countOf(s.days_left, 'day')} left`));
  if (s.days_left > 0) {
    const r = tj?.recent;
    const enough = r && s.per_day_left != null ? r.per_day - s.per_day_left : null;
    cells.push(cell('left', 'Every day left must bring', aed(s.per_day_left), [
      `${countOf(s.days_left, 'day')} left, today included · ${money(s.to_go)} still to earn`,
      enough == null ? null : { text: enough >= 0
        ? `▲ the last ${countOf(r.days, 'settled day')} averaged ${money(r.per_day)} — enough`
        : `▼ the last ${countOf(r.days, 'settled day')} averaged ${money(r.per_day)} — ${money(-enough)} a day short`, tone: tone(enough) }]));
  } else {
    cells.push(cell('left', 'Every day left must bring', '—', ['No day of the month is left to ask of.']));
  }
  return `<div class="targetnow tg-page"><div class="tg-cells tg-cells5">${cells.join('')}</div></div>`
    + monthNotes(v, lastPast, wh).map((x) => `<p class="mt-note">${esc(x)}</p>`).join('');
}

/* Under the cells: the trips, and each day not settled yet with its OWN
   reason — a channel still to deliver it reads as that, not as Uber's fares
   (the house rule: absent with the true reason or not at all). */
function monthNotes(v, lastPast, wh) {
  const notes = [];
  const ts = v.trips_summary;
  const closed = v.summary && v.summary.days_left === 0;
  if (ts && ts.trips != null && ts.needed) {
    notes.push(`Trips: ${fmt(ts.trips)} completed of ${fmt(ts.needed)} needed to ${lastPast} — ${v.trips_min} a day per active driver; `
      + `${fmt(ts.per_active, 1)} a driver a day ${closed ? 'over the month' : 'so far'}.`);
  } else if (wh.BK != null) notes.push(said('BK', wh.BK));
  const un = v.trajectory?.unsettled || [];
  if (un.length) {
    notes.push(`${un.map((d) => `Not settled yet, ${d.label}: ${d.why || `${pc(d.coverage)} of its bookings priced.`}`).join(' ')} `
      + `${un.length === 1 ? 'It counts' : 'They count'} at what is on record so far, so the earned figure${closed ? '' : ' and both paces'} may read low until ${un.length === 1 ? 'it settles' : 'they settle'}.`);
  }
  return notes;
}

/* ── 01 · day by day ────────────────────────────────────────────────────── */
/* A day's colour: green over and red under only once finished and settled,
   grey while it waits for fares, ink for today, nothing filled to come. */
const dayState = (d) => (d.state === 'today' ? 'now' : d.state === 'future' ? 'future'
  : d.verdict === 'over' ? 'over' : d.verdict === 'under' ? 'under' : 'wait');
const dayTip = (d) => {
  if (d.state === 'future') return `${d.label}: target ${money(d.needed)} if today is met`;
  if (d.state === 'today') return `${d.label}, today: target ${money(d.needed)} · ${money(d.earned)} on record so far`;
  const base = `${d.label}: target ${money(d.needed)} · gross ${money(d.earned)}`;
  if (d.verdict === 'over') return `${base} · over by ${money(d.diff)}${d.provisional ? ' at least — not settled yet' : ''}`;
  if (d.verdict === 'under') return `${base} · missed by ${money(-d.diff)} (${pc(d.pct)} of the target)`;
  return `${base} · not settled yet${d.why ? ` — ${d.why}` : ''}`;
};

/** The month in one chart: each day's target, its gross and the gap. Drawn
    at the width it is shown at, so its figures stay at reading size. */
export function dayChart(v, { W = 1300 } = {}) {
  const days = v.days || [];
  const n = Math.max(1, days.length);
  const H = W < 700 ? 210 : 270;
  const pl = 40, pr = 4, pt = 20, pb = 22;
  const iw = W - pl - pr, ih = H - pt - pb, step = iw / n, bw = step * 0.62;
  const hi = Math.max(1, ...days.map((d) => Math.max(d.needed || 0, d.earned || 0)));
  const st = niceStep(hi);
  const top = Math.ceil(hi / st) * st;
  const y = (val) => pt + ih - (ih * Math.max(0, val || 0)) / top;
  const parts = [];
  for (let g = st; g <= top + 1e-6; g += st) {
    parts.push(`<line class="mc-grid" x1="${pl}" x2="${W - pr}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/>`
      + `<text class="mc-y" x="${pl - 6}" y="${(y(g) + 4).toFixed(1)}" text-anchor="end">${kilo(g)}</text>`);
  }
  /* The gap's figure fits a day's column from ~34px; narrower, it is left
     to the table and the tooltip rather than printed over its neighbour. */
  const labels = step >= 26;
  const compact = step < 36;
  const every = step >= 18 ? 1 : step >= 9 ? 2 : 5;
  days.forEach((d, i) => {
    const k = dayState(d);
    const bx = pl + step * i + (step - bw) / 2;
    const g = [`<g class="mc-d mc-${k}"><title>${esc(dayTip(d))}</title>`];
    if (d.earned != null && d.earned > 0) {
      g.push(`<rect class="mc-done" x="${bx.toFixed(1)}" y="${y(d.earned).toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y(d.earned)).toFixed(1)}"/>`);
    }
    if (d.needed > 0) {
      g.push(`<rect class="mc-need" x="${bx.toFixed(1)}" y="${y(d.needed).toFixed(1)}" width="${bw.toFixed(1)}" height="${(pt + ih - y(d.needed)).toFixed(1)}"/>`);
    }
    if (labels && (d.verdict === 'over' || d.verdict === 'under') && d.diff != null) {
      const ty = Math.min(y(d.needed), y(d.earned)) - 5;
      const txt = `${d.diff >= 0 ? '+' : '−'}${compact ? kilo0(d.diff) : kilo(d.diff)}`;
      g.push(`<text class="mc-lab tg-${d.verdict}" x="${(bx + bw / 2).toFixed(1)}" y="${Math.max(10, ty).toFixed(1)}" text-anchor="middle">${txt}</text>`);
    }
    if (i % every === 0 || d.state === 'today') {
      g.push(`<text class="mc-x${d.state === 'today' ? ' mc-xnow' : ''}" x="${(bx + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${Number(d.day.slice(8))}</text>`);
    }
    g.push('</g>');
    parts.push(g.join(''));
  });
  return `<svg class="mc" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${v.month_name}, day by day: each day’s target, its gross fares, and how much it was over or missed by`)}">`
    + `<line class="mc-base" x1="${pl}" x2="${W - pr}" y1="${pt + ih}" y2="${pt + ih}"/>${parts.join('')}</svg>`;
}

const DAY_KEY = '<p class="hp-key"><span class="hk hk-done-over"></span>gross, over its target'
  + '<span class="hk hk-done-under"></span>gross, under<span class="hk hk-done-arriving mt-hk-wait"></span>not settled yet'
  + '<span class="hk hk-done-now"></span>today so far, on record<span class="hk hk-need"></span>the day’s target'
  + '<span class="hk hk-catch"></span>target to come · figures over the bars: AED over (+) or missed (−), in thousands</p>';

/** The days in figures: target, gross, over or missed, trips. */
export function daysTable(v) {
  const wh = v._withheld || {};
  const s = v.summary;
  const tripsHidden = wh.BK != null && v.days.every((d) => d.trips == null);
  const rows = v.days.map((d) => {
    const cls = d.state === 'today' ? ' class="mt-today"' : d.state === 'future' ? ' class="mt-future"' : '';
    const day = d.state === 'past' ? `<a href="${esc(href('day', d.day))}">${esc(d.label)}</a>`
      : `${esc(d.label)}${d.state === 'today' ? ' <span class="mt-dim">· today</span>' : ''}`;
    const gross = d.state === 'future' ? '<span class="mt-dim">to come</span>'
      : `${esc(aed(d.earned))}${d.state === 'today' ? ' <span class="mt-dim">so far</span>' : ''}`;
    const gapCell = d.state !== 'past' ? '<span class="mt-dim">—</span>'
      : d.verdict === 'over' ? `<span class="tg-over">▲ Over by ${esc(money(d.diff))}</span>${d.provisional ? ' <span class="mt-dim">at least</span>' : ''}`
        : d.verdict === 'under' ? `<span class="tg-under">▼ Missed by ${esc(money(-d.diff))}</span>`
          /* Its true reason in short — fares still arriving, or a channel
             still to deliver it — and the whole of it on hover. */
          : d.verdict === 'unsettled' ? `<span class="mt-dim"${d.why ? ` title="${esc(d.why)}"` : ''}>Not settled yet · ${d.coverage != null && d.coverage < 99
            ? `${esc(pc(d.coverage))} priced` : 'a channel still to deliver it'}</span>` : '<span class="mt-dim">—</span>';
    const trips = tripsHidden || d.state === 'future' ? '<span class="mt-dim">—</span>'
      : `${esc(n0(d.trips))} <span class="mt-dim">/ ${esc(n0(d.trips_target))}</span>`;
    const tv = d.state !== 'past' || tripsHidden ? '<span class="mt-dim">—</span>'
      : d.trips_verdict === 'over' ? `<span class="tg-over">▲ ${d.trips_diff ? `+${esc(n0(d.trips_diff))}` : 'Met'}</span>`
        : d.trips_verdict === 'under' ? `<span class="tg-under">▼ ${esc(n0(d.trips_diff))}</span>`
          : d.trips_verdict === 'unsettled' ? '<span class="mt-dim">not settled</span>' : '<span class="mt-dim">—</span>';
    return `<tr${cls}><th scope="row" class="l">${day}</th><td>${esc(aed(d.needed))}</td><td>${gross}</td>`
      + `<td class="l">${gapCell}</td><td>${d.state === 'past' ? esc(pc(d.pct)) : '<span class="mt-dim">—</span>'}</td>`
      + `<td>${trips}</td><td class="l">${tv}</td></tr>`;
  }).join('');
  const past = v.days.filter((d) => d.state === 'past');
  const foot = s && past.length
    ? `<tfoot><tr><th scope="row" class="l">To ${esc(past[past.length - 1].label)}</th><td>${esc(aed(s.planned))} <span class="mt-dim">planned</span></td>`
      + `<td>${esc(aed(s.earned))}</td><td class="l"><span class="tg-${s.ahead >= 0 ? 'over' : (s.unsettled ? 'wait' : 'under')}">${esc(gapWords(s.ahead, { over: 'ahead of plan', short: 'behind plan' }))}</span></td>`
      + `<td>${s.planned ? esc(pc((100 * s.earned) / s.planned)) : '—'}</td>`
      + `<td>${tripsHidden || !v.trips_summary ? '—' : `${esc(n0(v.trips_summary.trips))} <span class="mt-dim">/ ${esc(n0(v.trips_summary.needed))}</span>`}</td><td></td></tr></tfoot>`
    : '';
  return '<div class="tablewrap"><table class="mt-t mt-days"><thead><tr><th scope="col" class="l">Day</th><th scope="col">Target</th>'
    + '<th scope="col">Gross, all platforms</th><th scope="col" class="l">Over or missed</th><th scope="col">% of target</th>'
    + `<th scope="col">Trips / needed</th><th scope="col" class="l">Trips</th></tr></thead><tbody>${rows}</tbody>${foot}</table></div>`;
}

/** Panel 01's body: the sentence, the chart, its key, the table. */
export function daysHtml(v, { W = 1300 } = {}) {
  /* No target: nothing to draw a day against — but the trips minimum always
     exists, so the days still list their trips under the reason. */
  if (!v.summary) return `<p class="tg-absent">${esc(v.why || `No target is set for ${v.month_name}.`)}</p>${daysTable(v)}`;
  const wh = v._withheld || {};
  if (v.summary.month_target == null && wh.REV != null) return `<p class="tg-absent">${esc(said('REV', wh.REV))}</p>${daysTable(v)}`;
  const s = v.summary;
  const judged = s.over + s.under;
  const lede = judged || s.unsettled
    ? `${countOf(s.over, 'day')} over target, ${countOf(s.under, 'day')} under${s.unsettled ? `, ${countOf(s.unsettled, 'day')} not settled yet` : ''}. `
      + 'A day’s target is its share of the month (AED a car a day × the cars that earned in the week before it), plus the month’s shortfall so far spread over the days left — the Target page’s figure. Gross is fares on every platform, before any commission.'
    : 'No day of the month has finished yet — a day is judged the morning after it.';
  return `<p class="mt-lede">${esc(lede)}</p>${dayChart(v, { W })}${DAY_KEY}${daysTable(v)}`;
}

/* ── 02 · where the month lands ─────────────────────────────────────────── */
/** The month added up day by day: the target's path, what was earned, and
    the two paces from the last finished day to the month's end. */
export function pathChart(v, { W = 1300 } = {}) {
  const tj = v.trajectory;
  const sr = tj.series;
  const n = Math.max(1, sr.length);
  const H = W < 700 ? 220 : 260;
  const pl = 52, pr = 10, pt = 14, pb = 22;
  const iw = W - pl - pr, ih = H - pt - pb;
  const hi = Math.max(1, tj.target || 0, ...sr.map((p) => Math.max(p.plan_to_date || 0, p.earned_to_date || 0, p.at_avg || 0, p.at_recent || 0)));
  const st = niceStep(hi);
  const top = Math.ceil(hi / st) * st;
  /* A point is the END of its day: day 1's total sits at its right edge and
     the line starts from nothing at the month's first moment. */
  const x = (i) => pl + (iw * (i + 1)) / n;
  const y = (val) => pt + ih - (ih * Math.max(0, val || 0)) / top;
  const parts = [];
  for (let g = st; g <= top + 1e-6; g += st) {
    parts.push(`<line class="mp-grid" x1="${pl}" x2="${W - pr}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}"/>`
      + `<text class="mp-y" x="${pl - 6}" y="${(y(g) + 4).toFixed(1)}" text-anchor="end">${big(g)}</text>`);
  }
  const line = (cls, pts) => (pts.length > 1
    ? `<polyline class="${cls}" points="${pts.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')}"/>` : '');
  const plan = [[pl, y(0)], ...sr.map((p, i) => [x(i), y(p.plan_to_date)])];
  const earned = [[pl, y(0)], ...sr.flatMap((p, i) => (p.earned_to_date == null ? [] : [[x(i), y(p.earned_to_date)]]))];
  const from = sr.findIndex((p) => p.at_avg != null || p.at_recent != null);
  const proj = (k) => sr.flatMap((p, i) => (p[k] == null ? [] : [[x(i), y(p[k])]]));
  if (tj.target) {
    parts.push(`<line class="mp-target" x1="${pl}" x2="${W - pr}" y1="${y(tj.target).toFixed(1)}" y2="${y(tj.target).toFixed(1)}"/>`
      + `<text class="mp-tl" x="${pl + 6}" y="${(y(tj.target) - 5).toFixed(1)}">${esc(`target ${money(tj.target)}`)}</text>`);
  }
  const ti = sr.findIndex((p) => p.state === 'today');
  if (ti >= 0) {
    const tx = pl + (iw * ti) / n;
    parts.push(`<line class="mp-today" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${pt}" y2="${pt + ih}"/>`
      + `<text class="mp-tl" x="${(tx + 4).toFixed(1)}" y="${pt + ih - 6}">today</text>`);
  }
  parts.push(line('mp-plan', plan));
  if (from >= 0) {
    parts.push(line('mp-avg', proj('at_avg')), line('mp-recent', proj('at_recent')));
  }
  parts.push(line('mp-earned', earned));
  const dot = (pts, cls) => {
    const p = pts[pts.length - 1];
    return pts.length > 1 ? `<circle class="${cls}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5"/>` : '';
  };
  parts.push(dot(earned, 'mp-dot'), dot(proj('at_avg'), 'mp-dot mp-dot-avg'), dot(proj('at_recent'), 'mp-dot mp-dot-recent'));
  const every = n > 20 && W < 900 ? 5 : n > 20 ? 2 : 1;
  sr.forEach((p, i) => {
    if ((i + 1) % every === 0 || i === 0) {
      parts.push(`<text class="mp-x" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${Number(p.day.slice(8))}</text>`);
    }
  });
  return `<svg class="mp" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${v.month_name} added up day by day: the target’s path, what was earned, and where the month ends at each pace`)}">`
    + `<line class="mp-base" x1="${pl}" x2="${W - pr}" y1="${pt + ih}" y2="${pt + ih}"/>${parts.join('')}</svg>`;
}

/** Panel 02's body: the two paces in words, the chart, its key. */
export function pathHtml(v, { W = 1300 } = {}) {
  const tj = v.trajectory;
  const wh = v._withheld || {};
  if (!tj) return `<p class="tg-absent">${esc(v.why || `No target is set for ${v.month_name}.`)}</p>`;
  if (tj.target == null && wh.REV != null) return `<p class="tg-absent">${esc(said('REV', wh.REV))}</p>`;
  const last = [...tj.series].reverse().find((p) => p.earned_to_date != null);
  const lines = [];
  if (tj.days_left === 0 && tj.avg) {
    /* A month that is over has landed: one sentence, no pace. */
    const end = tj.earned - tj.target;
    lines.push(`<b class="tg-${tone(end)}">${esc(gapWords(end, { over: 'over the target', short: 'short of the target' }))}</b> ${esc(`— the month ended at ${money(tj.earned)}, ${pc((100 * tj.earned) / tj.target)} of it.`)}`);
  }
  if (tj.days_left > 0 && tj.avg) {
    lines.push(`<b class="tg-${tone(tj.avg.vs_target)}">${esc(gapWords(tj.avg.vs_target))}</b> ${esc(`at the average day so far (${money(tj.avg.per_day)} over ${countOf(tj.avg.days, 'day')}): the month ends at ${money(tj.avg.month_end)}.`)}`);
  }
  if (tj.days_left > 0 && tj.recent) {
    lines.push(`<b class="tg-${tone(tj.recent.vs_target)}">${esc(gapWords(tj.recent.vs_target))}</b> ${esc(`at the last ${countOf(tj.recent.days, 'settled day')}${tj.recent.days === 1 ? '’s' : '’'} pace (${money(tj.recent.per_day)} a day): the month ends at ${money(tj.recent.month_end)}.`)}`);
  }
  if (tj.days_left > 0 && tj.per_day_left != null) {
    lines.push(esc(`To land the target, every day left — ${countOf(tj.days_left, 'day')}, today included — must bring ${money(tj.per_day_left)} on average.`));
  }
  if (!lines.length) lines.push(esc('Nothing of the month has finished yet, so there is no pace to carry forward.'));
  const key = '<p class="hp-key"><span class="hk mt-hk-plan"></span>the target’s path, day by day'
    + `<span class="hk mt-hk-earned"></span>earned${last ? `, ${money(last.earned_to_date)} to ${last.label}` : ''}`
    + (tj.avg && tj.days_left > 0 ? `<span class="hk mt-hk-avg"></span>at the average day → ${money(tj.avg.month_end)}` : '')
    + (tj.recent && tj.days_left > 0 ? `<span class="hk mt-hk-recent"></span>at the last ${tj.recent.days} days → ${money(tj.recent.month_end)}` : '')
    + '</p>';
  return `<div class="mt-paces">${lines.map((l) => `<p>${l}</p>`).join('')}</div>${pathChart(v, { W })}${key}`;
}

/* ── 03 · drivers behind target ─────────────────────────────────────────── */
/** The drivers furthest behind, by money or by trips — api/target_month.js
    behind(), in the same order (test/target_month.test.mjs holds the two
    to the same answer). */
export function behindList(rows, by = 'money', limit = SHOW_BEHIND) {
  const pool = by === 'trips' ? rows.filter((r) => !r.trips_on) : rows.filter((r) => r.money_on === false);
  const sorted = [...pool].sort(by === 'trips'
    ? (a, b) => b.trips_short - a.trips_short || (b.gross_short ?? 0) - (a.gross_short ?? 0) || a.name.localeCompare(b.name)
    : (a, b) => (b.gross_short ?? 0) - (a.gross_short ?? 0) || b.trips_short - a.trips_short || a.name.localeCompare(b.name));
  return sorted.slice(0, limit);
}

/** Panel 03's body. `by` is 'money' or 'trips'. */
export function driversHtml(v, by = 'money') {
  const dr = v.drivers;
  const wh = v._withheld || {};
  if (!dr) return '<p class="tg-absent">The drivers could not be read.</p>';
  if (dr.why) return `<p class="tg-absent">${esc(dr.why)}</p>`;
  const rows = (dr.rows || []).map((r) => ({ ...r, name: r.name ?? '' }));
  const dayOf = (d) => v.days.find((x) => x.day === d)?.label || d;
  const N = rows.length;
  /* Counted from the rows this reader was sent, so a reader shown one fleet
     reads that fleet's drivers, not a total the list under it cannot add up to. */
  const moneyKnown = rows.some((r) => r.money_on != null);
  const mOn = rows.filter((r) => r.money_on === true).length;
  const mOff = rows.filter((r) => r.money_on === false).length;
  const tKnown = rows.some((r) => r.trips_on != null);
  const tOn = rows.filter((r) => r.trips_on === true).length;
  const tOff = rows.filter((r) => r.trips_on === false).length;
  const tt = dr.totals || {};
  /* No money target to be behind (none set, or withheld): the trips list,
     which always has one. */
  if (by === 'money' && !moneyKnown && tKnown) by = 'trips';
  const cells = [
    cell('active', 'Active drivers', n0(N), [`a completed trip in the 8 days to a counted day`,
      `${countOf(dr.counted_days, 'day')} counted: ${dayOf(dr.from)} to ${dayOf(dr.through)}`]),
    cell('money', 'On target for money', moneyKnown ? `${n0(mOn)} of ${n0(N)}` : '—', [
      moneyKnown ? { text: `▼ ${countOf(mOff, 'driver')} behind`, tone: mOff ? 'under' : null }
        : (dr.money_why || (wh.EARN != null ? said('EARN', wh.EARN) : 'Not measured.')),
      tt.targets != null ? `their targets add up to ${money(tt.targets)} — the plan for the counted days` : null]),
    cell('trips', `On target for trips · ${dr.min} a day`, tKnown ? `${n0(tOn)} of ${n0(N)}` : '—', [
      tKnown ? { text: `▼ ${countOf(tOff, 'driver')} behind`, tone: tOff ? 'under' : null }
        : (wh.BK != null ? said('BK', wh.BK) : 'Not measured.')]),
    cell('none', 'Fares on no named driver', aed(tt.unattributed), [
      'bookings that name no driver: in the fleet’s total, in nobody’s row',
      tt.fleet_gross != null ? `of ${money(tt.fleet_gross)} on the counted days` : null]),
  ];
  const list = behindList(rows, by);
  const pool = by === 'trips' ? tOff : mOff;
  const pick = '<div class="chips mt-pick" role="group" aria-label="Which list">'
    + ['money', 'trips'].map((k) => `<button type="button" class="chip${by === k ? ' on' : ''}" data-by="${k}" aria-pressed="${by === k}">`
      + `${k === 'money' ? 'Behind on money' : 'Behind on trips'} (${n0(k === 'money' ? mOff : tOff)})</button>`).join('')
    + '<button type="button" class="btn sec mt-xlsx" data-xlsx="1">Excel ⤓ every driver</button>'
    + '<span class="mt-xmsg" role="status" hidden></span></div>';
  const head = !pool ? '' : `<p class="mt-lede">${esc(by === 'trips'
    ? `The ${pool > SHOW_BEHIND ? `${SHOW_BEHIND} drivers furthest` : `${countOf(pool, 'driver')}`} below ${dr.min} trips for every counted day they were active, most trips short first.`
    : `The ${pool > SHOW_BEHIND ? `${SHOW_BEHIND} drivers furthest` : `${countOf(pool, 'driver')}`} below their money target, most AED short first.`)}`
    + `${pool > SHOW_BEHIND ? esc(` ${countOf(pool - SHOW_BEHIND, 'more driver')} ${pool - SHOW_BEHIND === 1 ? 'is' : 'are'} behind as well — every driver is in the Excel file.`) : ''}</p>`;
  const notes = [];
  if (dr.left_out?.length) {
    notes.push(`Not counted yet — a driver is measured only on settled days: ${dr.left_out.map((d) => `${d.label}${d.why ? ` (${d.why.replace(/\.$/, '')})` : ''}`).join('; ')}.`);
  }
  if (wh.FLEET) notes.push(`${countOf(Number(wh.FLEET), 'driver')} of a fleet your role does not see ${Number(wh.FLEET) === 1 ? 'is' : 'are'} not listed.`);
  if (wh.ID != null) notes.push(said('ID', wh.ID));
  if (wh.EARN != null && moneyKnown) notes.push(said('EARN', wh.EARN));
  const table = !list.length
    ? `<p class="tg-absent">${esc(by === 'trips' ? (tKnown ? `Every active driver reached ${dr.min} trips for each counted day they were active.` : 'Trips are not measured for your role.')
      : (moneyKnown ? 'Every active driver reached their money target.' : (dr.money_why || 'Money targets are not measured for your role.')))}</p>`
    : '<div class="tablewrap"><table class="mt-t mt-drv"><thead><tr><th scope="col">#</th><th scope="col" class="l">Driver</th>'
      + '<th scope="col" class="l">Fleet</th><th scope="col">Days active</th><th scope="col">Gross</th><th scope="col">Money target</th>'
      + '<th scope="col">Short by</th><th scope="col">% of target</th><th scope="col">Trips / target</th><th scope="col">Trips short</th></tr></thead><tbody>'
      + list.map((r, i) => {
        const who = r.name ? (r.driver_ext_id ? `<a href="${esc(href('driver', r.driver_ext_id))}">${esc(r.name)}</a>` : esc(r.name))
          : '<span class="mt-dim">(withheld)</span>';
        const plat = (r.platforms || []).map(sourceLabel).join(', ');
        return `<tr><td class="mt-dim">${i + 1}</td><th scope="row" class="l">${who}${plat ? ` <span class="mt-dim">· ${esc(plat)}</span>` : ''}</th>`
          + `<td class="l">${esc(r.fleet ? sourceLabel(r.fleet) : '—')}</td>`
          + `<td>${esc(n0(r.days_active))} <span class="mt-dim">· drove ${esc(n0(r.days_driven))}</span></td>`
          + `<td>${esc(aed(r.gross))}</td><td>${esc(aed(r.gross_target))}</td>`
          + `<td>${r.gross_short ? `<span class="tg-under">▼ ${esc(money(r.gross_short))}</span>` : (r.money_on ? '<span class="tg-over">▲ on target</span>' : '—')}</td>`
          + `<td>${esc(pc(r.gross_pct))}</td>`
          + `<td>${esc(n0(r.trips))} <span class="mt-dim">/ ${esc(n0(r.trips_target))}</span></td>`
          + `<td>${r.trips_short ? `<span class="tg-under">▼ ${esc(n0(r.trips_short))}</span>` : (r.trips_on ? '<span class="tg-over">▲ on target</span>' : '—')}</td></tr>`;
      }).join('')
      + '</tbody></table></div>';
  const rule = `<p class="cap mt-rule">${esc(`How a driver’s target is set. Money: each counted day’s plan — its share of the month’s target — is divided equally among the drivers active that day (a completed trip in the 8 days to it); a driver’s target is the sum of their shares, so every driver reaching theirs is the fleet reaching its plan. Gross is their fares on every platform, before commission, on the same days. Trips: ${dr.min} for every counted day they were active. A counted day is a finished day whose fares are all in — every channel delivered and 99% of its bookings priced.`)}</p>`;
  return `<div class="targetnow tg-page"><div class="tg-cells">${cells.join('')}</div></div>`
    + `${pick}${head}${notes.map((x) => `<p class="mt-note">${esc(x)}</p>`).join('')}${table}${rule}`;
}

/* ── the caption: the month, its scope, the months either side ──────────── */
export function noteHtml(v) {
  const now = String(v.today || '').slice(0, 7);
  const prev = shiftMonth(v.month, -1);
  const next = shiftMonth(v.month, 1);
  const link = (m, text) => `<a href="${esc(m === now ? href('month-target') : href('month-target', m))}">${esc(text)}</a>`;
  return `${esc(`${v.month_name} · both fleets · gross fares before commission · as of ${v.today}`)}`
    + ` <span class="mt-nav">${link(prev, `‹ ${monthWord(prev)}`)}${next <= now ? ` ${link(next, `${monthWord(next)} ›`)}` : ''}</span>`;
}

/* ── the page ──────────────────────────────────────────────────────────── */
/** The Month target page into `root`; `param` a month ('YYYY-MM') or none
    for this one. Redrawn every REFRESH_MS while it is the page open. */
export async function monthTargetPage(root, param = null) {
  const gen = currentGen();
  const ak = contract();
  const month = isMonth(param) ? String(param) : null;
  const note = el('span');
  const head = el('div');
  if (ak) {
    const band = el('section', 'cband mt-month');
    band.append(secHead('00', 'The month', note), head);
    root.append(band);
  } else {
    /* The note in the panel's own caption paragraph, as on #target: a bare
       span between a heading and its body sits off the spacing rule. */
    const p = panel('The month', null, 'mt-month');
    const cap = el('p', 'cap');
    cap.append(note);
    p.panel.querySelector('h3')?.after(cap);
    p.body.append(head);
    root.append(p.panel);
  }
  const days = panel('Day by day: target, gross and the gap', null, 'mt-days');
  const path = panel('Where the month lands', null, 'mt-path');
  const drv = panel('Drivers behind target', null, 'mt-drivers');
  root.append(days.panel, path.panel, drv.panel);
  [head, days.body, path.body, drv.body].forEach((b) => loading(b));

  let by = 'money';
  let last = null;
  const paintDrivers = () => { if (last) drv.body.innerHTML = driversHtml(last, by); };
  drv.body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-by],[data-xlsx]');
    if (!b || b.disabled) return;
    if (b.dataset.by) { by = b.dataset.by === 'trips' ? 'trips' : 'money'; paintDrivers(); return; }
    const msg = drv.body.querySelector('.mt-xmsg');
    const was = b.textContent;
    b.disabled = true; b.textContent = 'Preparing…';
    try {
      await downloadFile(workbookUrl(month), `month-target-${month || 'this-month'}.xlsx`);
      if (msg) { msg.textContent = ''; msg.hidden = true; }
    } catch (err) {
      if (msg) { msg.textContent = err.message; msg.hidden = false; }
    } finally { b.disabled = false; b.textContent = was; }
  });

  const draw = async () => {
    const v = await monthTargetLive(month).catch((e) => ({ _err: e }));
    if (!alive(gen)) return false;
    if (v._err) {
      const msg = `<p class="tg-absent">${esc(`The month could not be read: ${v._err.message || 'no answer'}`)}</p>`;
      head.innerHTML = msg; days.body.innerHTML = msg; path.body.innerHTML = msg; drv.body.innerHTML = msg;
      return true;
    }
    last = v;
    /* Drawn at the panel's own width, so a figure over a bar stays at the
       size the key is printed at — the hourly charts' rule. */
    const W = Math.max(320, Math.round(days.body.getBoundingClientRect().width) || 1300);
    note.innerHTML = noteHtml(v);
    head.innerHTML = monthHtml(v);
    days.body.innerHTML = daysHtml(v, { W });
    path.body.innerHTML = pathHtml(v, { W });
    paintDrivers();
    return true;
  };
  await draw();
  const timer = setInterval(async () => {
    if (!alive(gen) || document.hidden) { if (!alive(gen)) clearInterval(timer); return; }
    await draw().catch(() => {});
  }, REFRESH_MS);
}
