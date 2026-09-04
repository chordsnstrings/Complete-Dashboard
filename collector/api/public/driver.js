/* Per-driver detail — six pages, not one.
   ──────────────────────────────────────────────────────────────────────────
   A driver is the unit most operational decisions are made about: who to coach,
   who to give the better car to, whose licence is about to lapse. One scrolling
   page can't carry that, so this splits into addressable sub-pages:

     #driver/<id>            overview   — who they are and how they stand
     #driver/<id>/activity   activity   — when they work, and how consistently
     #driver/<id>/territory  territory  — where they work, and where they wait
     #driver/<id>/earnings   earnings   — what the work paid
     #driver/<id>/quality    quality    — completion, cancellations, driving
     #driver/<id>/trips      trips      — the underlying records

   Every panel here answers over *all* of a person's platform accounts, because
   the server folds Uber/Yango/Bolt ids that share a name into one identity. */

import { barChart, gapBars, areaChart, donut, hbars, heatmap, empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note, entity,
  dayStr, dateStr, dtStr, timeStr, hourStr, money, pct, fmt, tripTime,
  sourceLabel, plural, countOf, signed, UBER_FARE, UBER_HOURS, NO_DURATION, noneChosen, verdict, foldRows,
  avatar, moneyInTile, faresTile, alertRateFigure, splitAlerts,
  UBER_FARE_WHY } from './ui.js';
import { qAll, href, currentGen, alive } from './data.js';
import { driversVerdict } from './verdicts.js';
import { renderDriverDay } from './driverday.js';

/* Why a whole column is empty, in the words the page prints under it.
   ─────────────────────────────────────────────────────────────────────────
   Shared constants rather than a sentence per table, because the SAME absence
   shows up on the directory, the daily table, the statement table and the trip
   ledger — and four differently-worded explanations of one missing field read
   as four separate problems. Each was verified against the live database
   before it was written here; none of them says "no data". */
/* Moved to ui.js. Nine tables in five other files render the same columns and
   explained none of them; a sentence that lives in one view is a sentence the
   other views do not say. */
import { dubaiDay } from './tz.js';
import { makeMap, fitTo } from './map.js';

/* `day` is deliberately NOT in this list. It is a destination reached by
   clicking a bar on Activity, not a seventh tab somebody picks cold — a tab
   labelled "Day" with no day chosen has nothing to show. */
export const DRIVER_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'activity', label: 'Activity', ic: '◷' },
  { id: 'territory', label: 'Territory', ic: '◍' },
  { id: 'earnings', label: 'Earnings', ic: '◈' },
  { id: 'quality', label: 'Quality', ic: '△' },
  { id: 'trips', label: 'Trips', ic: '▤' },
];

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ── percentile bars: where this driver sits in the fleet ─────────────────
   A bar is the driver's percentile, and the tick is the fleet median (always
   the 50th percentile — drawn so the bar has something to be read against). */
/* The ordinal suffix was hardcoded "th", so every bar read "72th", "93th",
   "91th". And the tooltip carried a bare number with no unit — "Distance
   driven: 1,963.7" of what — while the cancellation metric is inverted on the
   server (low is good) with nothing on screen to say so, which put "0 —  fleet
   median 11" beside a 100th percentile and read as a contradiction. */
const ordinal = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '';
  const t = v % 100;
  if (t >= 11 && t <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][v % 10] || 'th';
};
const METRIC_UNIT = { km: 'km', distance: 'km', revenue: 'AED', earnings: 'AED',
  fare: 'AED', trips: 'trips', bookings: 'bookings', days: 'days', hours: 'h',
  rate: '%', pct: '%', completion: '%', cancellation: '%', acceptance: '%', rating: '★' };
const unitFor = (m) => {
  if (m.unit) return m.unit;
  const l = String(m.label || '').toLowerCase();
  return Object.entries(METRIC_UNIT).find(([k]) => l.includes(k))?.[1] || '';
};

function percentileBars(host, metrics, opts = {}) {
  host.innerHTML = '';
  if (!metrics.length) return empty(host);
  const wrap = el('div', 'pbars');
  metrics.forEach((m, i) => {
    const p = Math.max(0, Math.min(100, m.percentile));
    const tone = p >= 75 ? '--good' : p >= 40 ? '--s1' : p >= 20 ? '--warn' : '--critical';
    const u = unitFor(m);
    const inverted = m.higher_is_better === false || /cancel|reject|no.?show/i.test(m.label || '');
    const row = el('div', 'pbar');
    row.innerHTML = `
      <div class="pb-l">${esc(m.label)}${u ? `<span class="dim"> (${esc(u)})</span>` : ''}</div>
      <div class="pb-track">
        <i style="width:${p}%;background:var(${tone});animation-delay:${i * 55}ms"></i>
        <span class="pb-mid" title="fleet median"></span>
      </div>
      <div class="pb-v num">${p}<small>${ordinal(p)}</small></div>`;
    row.title = `${m.label}: ${fmt(m.value, 1)}${u ? ' ' + u : ''} — fleet median `
      + `${fmt(m.median, 1)}${u ? ' ' + u : ''}`
      + (inverted ? '. Lower is better here, so a high percentile means FEWER of them.' : '')
      + (opts.note && /revenue|fare|earn/i.test(m.label || '') ? ` ${opts.note}` : '');
    wrap.append(row);
  });
  host.append(wrap);
  if (metrics.some((m) => /cancel|reject|no.?show/i.test(m.label || ''))) {
    host.append(el('p', 'cap', 'On the cancellation bar a HIGH percentile is good: it is ranked so that '
      + 'fewer cancellations sits further right, like every other bar here.'));
  }
}

/* ── first trip of each day, plotted as a clock ───────────────────────────
   The mockup's "first login" scatter. Consistency is the signal: a tight band
   is a driver on a shift, a scattered column is someone working ad hoc. */
function startScatter(host, days) {
  host.innerHTML = '';
  const pts = days.filter((d) => Number.isFinite(+d.first_hour)).map((d) => ({ ...d, first_hour: +d.first_hour }));
  if (pts.length < 2) return empty(host, 'Not enough working days to show a pattern');
  const W = 760, H = 240, P = { l: 46, r: 12, t: 14, b: 26 };
  const xs = pts.map((d) => +new Date(d.day));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  // Scale to the hours actually used, with at least a 4-hour window: a driver
  // who always starts between 06:20 and 07:10 has a real pattern, and plotting
  // it against a full 24-hour axis flattens that into a single line.
  const hs = pts.map((d) => d.first_hour);
  // Clamp to the clock: a driver whose first trip is at 00:20 must not produce
  // a "-1:00" gridline, and one finishing at 23:50 must not produce "25:00".
  let lo = Math.max(0, Math.floor(Math.min(...hs) - 0.6));
  let hi = Math.min(24, Math.ceil(Math.max(...hs) + 0.6));
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.min(20, mid - 2));
    hi = Math.min(24, lo + 4);
  }
  const X = (t) => P.l + ((+new Date(t) - x0) / Math.max(1, x1 - x0)) * (W - P.l - P.r);
  const Y = (h) => P.t + ((h - lo) / (hi - lo)) * (H - P.t - P.b);
  const step = (hi - lo) <= 6 ? 1 : (hi - lo) <= 12 ? 2 : 4;
  const svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">'];
  for (let h = Math.ceil(lo); h <= hi; h += step) {
    svg.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${Y(h)}" y2="${Y(h)}" stroke="var(--rule)" stroke-width="1"/>`);
    svg.push(`<text x="4" y="${Y(h) + 4}" font-size="10" fill="var(--ink-3)">${String(h).padStart(2, '0')}:00</text>`);
  }
  // the band containing the middle half of start times — the "usual" shift start
  const sorted = pts.map((d) => d.first_hour).sort((a, b) => a - b);
  const qa = sorted[Math.floor(sorted.length * 0.25)], qb = sorted[Math.floor(sorted.length * 0.75)];
  svg.push(`<rect x="${P.l}" y="${Y(qa)}" width="${W - P.l - P.r}" height="${Math.max(2, Y(qb) - Y(qa))}"
    fill="var(--accent-soft)" data-fade/>`);
  pts.forEach((d, i) => {
    svg.push(`<circle cx="${X(d.day).toFixed(1)}" cy="${Y(d.first_hour).toFixed(1)}" r="4.5"
      fill="var(--s1)" fill-opacity=".78" stroke="var(--surface)" stroke-width="1.2" data-rise
      style="animation-delay:${i * 16}ms"><title>${dayStr(d.day)} · first trip ${hourStr(d.first_hour)} · ${d.trips} trips</title></circle>`);
  });
  svg.push(`<text x="${P.l}" y="${H - 8}" font-size="10" fill="var(--ink-3)">${dayStr(pts[0].day)}</text>`);
  svg.push(`<text x="${W - P.r}" y="${H - 8}" font-size="10" fill="var(--ink-3)" text-anchor="end">${dayStr(pts[pts.length - 1].day)}</text>`);
  svg.push('</svg>');
  host.innerHTML = svg.join('');
  host.append(el('p', 'cap', `Shaded band = the middle half of start times (${hourStr(qa)}–${hourStr(qb)}). Each dot is one working day.`));
}

/* ── the day as it was actually spent, one row per day ────────────────────
   This was one solid bar per day from the first trip to the last, captioned
   "the working window". A span is not a working window: eight trips spread
   across 05:19–23:10 drew exactly the same bar as eight done back to back,
   and on this fleet the difference is most of the day. Measured live on six
   drivers for 25 August, the share of the span spent NOT carrying anyone ran
   from 51% to 92% — the single largest fact about how a shift is spent, and
   the old bar hid all of it behind one colour.

   Now the bar is the day itself: each job drawn at its real position, the gaps
   between them left as the track behind. Three states, three colours, stated
   in a legend:

     on job     request → dropoff, solid blue
     waiting    between one dropoff and the next request, amber
     no dropoff a booking whose end time the channel never sent, hatched

   The third exists so that missing data is never quietly rendered as idleness.
   Uber reports a dropoff on most trips and none on the others, and folding
   those into the gaps would invent waiting that nobody can verify. */
function shiftBars(host, days, meta = {}, shiftId = null) {
  host.innerHTML = '';
  const all = (days || []).filter((d) => d.first_min != null);
  /* Twenty-eight bars, because a 24-hour axis in half a page gives each hour
     about eight pixels and a month of them is a smear. The cap is fine; the
     cap being SILENT was not. Since the window predicate was fixed, "this
     month" is 31 days, so this drew 28 of them and totalled 405 h online in
     its caption — directly above a chart totalling 449 h over all 31, and a
     line saying 31 days are held as a stored record. Three numbers for one
     driver's August, none of them wrong, and nothing on the page explaining
     why they differ. `dropped` says so now. */
  const rows = all.slice(-28);
  const dropped = all.length - rows.length;
  if (!rows.length) return empty(host);

  /* A header row, because five numeric columns with no labels is a puzzle.
     It uses the same grid as a shift row so the columns cannot drift apart. */
  const wrap = el('div', 'shifts');
  const hd = el('div', 'shift sh-head');
  hd.innerHTML = '<div class="sh-d"></div><div></div><div class="sh-v">first–last</div>'
    + '<div class="sh-j">on job</div><div class="sh-o">online</div>'
    + '<div class="sh-w">waiting</div><div class="sh-t">jobs</div>';
  wrap.append(hd);
  rows.forEach((d, i) => {
    const pctOf = (m) => (m / 1440) * 100;
    /* Drawn in ascending order of start so a later job paints over an earlier
       overlapping one rather than under it. An overlap is real on this fleet —
       the next rider assigned before the current is dropped — and the count is
       shown rather than the geometry being fudged. */
    const segs = [...d.jobs].sort((a, b) => a.s - b.s).map((j) => {
      const known = j.e != null;
      /* A floor, so a two-minute job is still visible — and a wider one for the
         unknowns, which are a MARKER rather than a duration: drawn at their
         real width they were four pixels of hatching that read as an artifact
         of the track rather than as a booking. */
      const w = known ? Math.max(j.e - j.s, 4) : 14;
      return `<i class="${known ? 'j' : 'u'}" style="left:${pctOf(j.s)}%;width:${pctOf(w)}%;`
        + `animation-delay:${i * 18}ms" title="${esc(hhmm(j.s))}–${known ? esc(hhmm(j.e)) : 'no dropoff reported'}`
        + `${j.platform ? ' · ' + esc(j.platform) : ''}"></i>`;
    }).join('');
    /* The span, drawn behind the jobs. What shows through it IS the waiting,
       which is why waiting needs no segments of its own — it is the part of
       the shift nothing else covers. */
    const span = `<i class="w" style="left:${pctOf(d.first_min)}%;`
      + `width:${pctOf(Math.max(4, (d.last_min ?? d.first_min) - d.first_min))}%"></i>`;

    /* ONLINE, drawn between the span and the jobs.
       ─────────────────────────────────────────────────────────────────────
       The waiting band was 81% of this panel and could not tell a driver
       sitting at a rank with the app on from one who logged off and went home.
       One is supply the fleet is paying for and failing to sell.

       Layered the same way waiting already works: what a job does not cover of
       the online band IS the idle-online time, so it needs no arithmetic and
       cannot disagree with the bars above it. It is deliberately NOT clamped
       to first–last: a driver online for two hours before their first job is
       exactly the case worth seeing, and clipping it to the job span would
       hide the only evidence of it. */
    const onlineSegs = (d.online || []).map((o) =>
      `<i class="o" style="left:${pctOf(o.s)}%;width:${pctOf(Math.max(2, o.e - o.s))}%" `
      + `title="online ${esc(hhmm(o.s))}–${esc(hhmm(o.e))}"></i>`).join('');
    const onlineMin = (d.online || []).reduce((a, o) => a + (o.e - o.s), 0);
    /* Idle-online is the online time NOT on a job, and it is the number this
       panel exists to produce. Floored at zero: the two series come from
       different providers' clocks and a job can overhang its own online span
       by a few seconds, which must not render as negative idle time. */
    const idleMin = d.online ? Math.max(0, onlineMin - (d.on_job_min || 0)) : null;

    const share = d.span_min ? Math.round((d.wait_min / d.span_min) * 100) : null;
    /* A row is an address now. The month view could total a day's waiting and
       never say what happened inside it; the day page answers that, and the
       bar for that day is the obvious way in. */
    const dayKeyStr = String(d.day).slice(0, 10);
    const to = shiftId ? href('driver', shiftId, 'day') : null;
    const r = el(to ? 'a' : 'div', `shift${to ? ' clickable' : ''}`);
    if (to) r.href = `${to}${to.includes('?') ? '&' : '?'}on=${encodeURIComponent(dayKeyStr)}`;
    r.innerHTML = `<div class="sh-d">${dayStr(d.day)}</div>
      <div class="sh-track">${span}${onlineSegs}${segs}</div>
      <div class="sh-v num">${hhmm(d.first_min)}–${d.last_min != null ? hhmm(d.last_min) : '—'}</div>
      <div class="sh-j num">${d.on_job_min ? `${fmt(d.on_job_min / 60, 1)}h` : '<span class="dim">—</span>'}</div>
      <div class="sh-o num">${d.online ? `${fmt(onlineMin / 60, 1)}h` : '<span class="dim">—</span>'}</div>
      <div class="sh-w num">${d.wait_min ? `${fmt(d.wait_min / 60, 1)}h${
        share != null ? ` <span class="dim">${share}%</span>` : ''}` : '<span class="dim">—</span>'}</div>
      <div class="sh-t num">${d.bookings}</div>`;
    r.title = `${dayStr(d.day)} · ${d.bookings} bookings · on job ${fmt(d.on_job_min / 60, 1)} h`
      + ` · waiting ${fmt(d.wait_min / 60, 1)} h`
      + (d.online ? ` · online ${fmt(onlineMin / 60, 1)} h, of which ${fmt(idleMin / 60, 1)} h `
        + 'available and not dispatched' : '')
      + (d.overlaps ? ` · ${d.overlaps} overlapping` : '')
      + (d.unknown_end ? ` · ${d.unknown_end} with no dropoff` : '');
    wrap.append(r);
  });

  const anyOnline = rows.some((d) => d.online);
  host.append(legend([
    ['j', 'on job — request to dropoff'],
    /* Only when there is some. A legend entry for a band that is nowhere on
       the chart is an instruction to go looking for something that is not
       there. */
    ...(anyOnline ? [['o', 'online, waiting for a job']] : []),
    ['w', anyOnline ? 'not online' : 'waiting between jobs'],
    ['u', 'no dropoff reported'],
  ]));
  host.append(wrap);

  const onJob = rows.reduce((a, d) => a + (d.on_job_min || 0), 0);
  const waited = rows.reduce((a, d) => a + (d.wait_min || 0), 0);
  const span = rows.reduce((a, d) => a + (d.span_min || 0), 0);
  host.append(el('p', 'cap', esc(
    `Across these ${rows.length} days: ${fmt(onJob / 60, 1)} h on job, ${fmt(waited / 60, 1)} h `
    + `waiting between jobs — ${span ? Math.round((waited / span) * 100) : 0}% of the time between `
    + 'the first request and the last dropoff. '
    + (dropped
      ? `The ${countOf(dropped, 'earlier day')} in this window ${plural(dropped, 'is', 'are')} not `
        + 'drawn — a 24-hour axis needs the width — so every total in this panel is over the 28 '
        + 'days above and the charts below are over the whole window. '
      : '')
    + (meta.basis || ''))));

  /* The split, over the days that HAVE availability — not over all of them.
     ─────────────────────────────────────────────────────────────────────────
     Uber serves 31 days of this and nothing older, so on a 28-day chart some
     days will have a band and some will not for a long time yet. Averaging the
     covered days' online hours across the uncovered ones would report a fleet
     that is offline far more than it is, which is the same class of lie as the
     coverage table that once called fifteen dead trackers "840 missing days". */
  const covered = rows.filter((d) => d.online);
  if (covered.length) {
    const onlineMin = covered.reduce((a, d) =>
      a + d.online.reduce((x, o) => x + (o.e - o.s), 0), 0);
    const jobMin = covered.reduce((a, d) => a + (d.on_job_min || 0), 0);
    const idle = Math.max(0, onlineMin - jobMin);
    host.append(el('p', 'cap', esc(
      `Availability is collected for ${covered.length} of these ${rows.length} days. Over those: `
      + `${fmt(onlineMin / 60, 1)} h online, of which ${fmt(idle / 60, 1)} h `
      + `(${onlineMin ? Math.round((idle / onlineMin) * 100) : 0}%) was spent available and not `
      + 'dispatched — supply the fleet was carrying and not selling. The rest of the waiting was '
      + 'time the driver was not online at all.')));
  }
  if (meta.online_basis) host.append(el('p', 'cap', esc(meta.online_basis)));
  if (meta.unknown_end) {
    host.append(el('p', 'cap', esc(
      `${meta.unknown_end} booking${meta.unknown_end === 1 ? '' : 's'} in this window carry no `
      + 'dropoff time. Those are hatched and left out of both totals rather than counted as waiting.')));
  }
}

/* A legend that uses the SAME classes the bars do, so a colour can never be
   changed in one place and explained in another. */
function legend(items) {
  const l = el('div', 'lgnd');
  l.innerHTML = items.map(([cls, text]) =>
    `<span><i class="sw ${esc(cls)}"></i>${esc(text)}</span>`).join('');
  return l;
}

/* Minutes since Dubai midnight, as a clock. The value is already Dubai-local —
   the API converted it — so this must NOT go through a Date, which would
   reintroduce the viewer's own timezone into the one chart whose entire
   subject is when somebody worked in Dubai. */
function hhmm(min) {
  if (min == null || !Number.isFinite(+min)) return '—';
  const m = Math.max(0, Math.min(1440, Math.round(+min)));
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/* Minutes a job ran, from whichever pair of timestamps the row has.
   duration_s first because it is the provider's own figure where one exists;
   nothing writes it today, but a channel that starts to should win over our
   subtraction. Null rather than zero when the trip has no dropoff: "we do not
   know how long this took" is not "it took no time". */
function tripMinutes(r) {
  if (r.duration_s) return Math.round(r.duration_s / 60);
  if (!r.requested_at || !r.ended_at) return null;
  const ms = Date.parse(r.ended_at) - Date.parse(r.requested_at);
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

/* A rating, its direction, and the readings behind it.
   ─────────────────────────────────────────────────────────────────────────
   A rating on its own is a fact nobody can act on. 4.71 tells an operator
   nothing; 4.71 down from 4.86 over five weeks tells them to have a
   conversation, and 4.71 up from 4.55 tells them to have the opposite one with
   the same person. So the tile carries the number, the direction, and the
   readings it is drawn from.

   Three rules the house style already sets and this obeys:

     COLOUR IS NEVER THE ONLY CARRIER. app.css says so where severity chips are
     defined, and it is right: the direction is in the arrow and in the signed
     number before it is in the hue. A reader who cannot see the green still
     reads "up 0.04 over 7 days".

     MOTION IS DECORATION. The line draws and the chip rises because a change
     that appears fully formed is easy to miss on a page of twelve tiles — but
     the whole thing is legible with animation off, and app.css:630 turns it
     off globally for anyone who asks.

     A SINGLE READING IS NOT A FLAT LINE. One point draws no sparkline and says
     "first reading". Flat and unmeasured must not look the same. */
function ratingTrend(k) {
  const v = Number(k.rating);
  if (!Number.isFinite(v)) return null;
  const c = k.rating_change;
  const pts = (k.rating_series || []).filter((r) => Number.isFinite(+r.rating));
  const dir = c == null ? 'flat' : c.change > 0 ? 'up' : c.change < 0 ? 'down' : 'flat';

  /* The sparkline, scaled to the readings and not to 0–5: a rating lives in
     the top few hundredths of its range and drawn against the full scale every
     driver is a straight line at the ceiling. Padded so a flat run sits in the
     middle rather than on an edge. */
  let spark = '';
  if (pts.length >= 2) {
    const W = 180, H = 14, P = 2;
    const ys = pts.map((r) => +r.rating);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const pad = (hi - lo) < 0.02 ? 0.01 : (hi - lo) * 0.15;
    const y0 = lo - pad, y1 = hi + pad;
    const X = (i) => P + (i / (pts.length - 1)) * (W - P * 2);
    const Y = (y) => H - P - ((y - y0) / Math.max(1e-9, y1 - y0)) * (H - P * 2);
    const d = pts.map((r, i) => `${X(i).toFixed(1)},${Y(+r.rating).toFixed(1)}`).join(' L ');
    const last = pts[pts.length - 1];
    spark = `<svg class="rt-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img"`
      + ` aria-label="${esc(`${pts.length} readings, ${(+pts[0].rating).toFixed(2)} to ${(+last.rating).toFixed(2)}`)}">`
      + `<path d="M ${d}" fill="none" stroke="currentColor" stroke-width="1.5"`
      + ` stroke-linecap="round" stroke-linejoin="round" class="rt-line"/>`
      + `<circle class="rt-dot" cx="${X(pts.length - 1).toFixed(1)}" cy="${Y(+last.rating).toFixed(1)}" r="2.1" fill="currentColor"/>`
      + '</svg>';
  }

  const arrow = dir === 'up' ? '\u25b2' : dir === 'down' ? '\u25bc' : '\u2013';
  const chip = c == null
    ? `<span class="rt-chip rt-first">first reading</span>`
    : `<span class="rt-chip rt-${dir}" title="${esc(`${(+c.from).toFixed(2)} on the previous reading, `
      + `${(+c.to).toFixed(2)} now`)}">${arrow} ${signed(c.change, { d: 2 })}</span>`;

  return {
    label: 'Rating',
    /* Two rows, not one line. Value and chip first, the readings beneath as a
       full-width line: a tile is ~200px and a number, a 68px sparkline and a
       chip do not fit across it — the first version clipped the chip at the
       tile's right edge, which is the one part a reader most needs. Stacked,
       the line also gets the full width to say something with. */
    html: `<span class="rt" data-dir="${dir}"><span class="rt-top">`
      /* toFixed, not fmt: a rating is always two decimals. fmt trims a trailing
         zero, so 4.90 rendered as "4.9" beside 4.83 and the two looked like
         different precisions of the same scale. */
      + `<span class="rt-v" data-count>${v.toFixed(2)}</span>${chip}</span>${spark}</span>`,
    sub: c == null
      ? `${sourceLabel(k.rating_platform)}\u2019s own rating`
        + (k.platform_lifetime_trips ? ` over ${fmt(k.platform_lifetime_trips)} trips` : '')
      : `over ${countOf(c.over_days, 'day')}`
        + (c.over_trips ? ` and ${fmt(c.over_trips)} trips` : '')
        + ` \u00b7 ${sourceLabel(k.rating_platform)}\u2019s own`,
    tone: v >= 4.8 ? 'good' : v >= 4.5 ? 'warn' : 'critical',
  };
}

/* ── online vs on-trip, one chart ─────────────────────────────────────────
   Two areas on the same axis: total hours logged in, and the part of that with
   a passenger aboard. The gap between them is the idle time being paid for. */
function dualSeries(host, days) {
  host.innerHTML = '';
  const W = 760, H = 230, P = { l: 34, r: 10, t: 14, b: 24 };
  const max = Math.max(1, ...days.map((d) => +d.hours_online || 0));
  const X = (i) => P.l + (i / Math.max(1, days.length - 1)) * (W - P.l - P.r);
  const Y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const area = (key) => {
    const top = days.map((d, i) => `${X(i).toFixed(1)},${Y(+d[key] || 0).toFixed(1)}`).join(' L ');
    return `M ${X(0).toFixed(1)},${(H - P.b).toFixed(1)} L ${top} L ${X(days.length - 1).toFixed(1)},${(H - P.b).toFixed(1)} Z`;
  };
  const line = (key) => 'M ' + days.map((d, i) => `${X(i).toFixed(1)},${Y(+d[key] || 0).toFixed(1)}`).join(' L ');
  const svg = [`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">`];
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g;
    svg.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rule)" stroke-width="1"/>`);
    svg.push(`<text x="2" y="${Y(v) + 4}" font-size="10" fill="var(--ink-3)">${v.toFixed(0)}h</text>`);
  }
  svg.push(`<path d="${area('hours_online')}" fill="var(--s1)" fill-opacity=".16" data-fade/>`);
  svg.push(`<path d="${line('hours_online')}" fill="none" stroke="var(--s1)" stroke-width="2" data-draw/>`);
  svg.push(`<path d="${area('hours_on_job')}" fill="var(--s3)" fill-opacity=".26" data-fade/>`);
  svg.push(`<path d="${line('hours_on_job')}" fill="none" stroke="var(--s3)" stroke-width="2" data-draw/>`);
  days.forEach((d, i) => {
    svg.push(`<circle cx="${X(i).toFixed(1)}" cy="${Y(+d.hours_online || 0).toFixed(1)}" r="7" fill="transparent">` +
      `<title>${dayStr(d.day)} · ${fmt(d.hours_online, 1)}h online, ${fmt(d.hours_on_job, 1)}h on job</title></circle>`);
  });
  svg.push('</svg>');
  host.innerHTML = svg.join('');
  const online = days.reduce((a, d) => a + (+d.hours_online || 0), 0);
  const onTrip = days.reduce((a, d) => a + (+d.hours_on_job || 0), 0);
  /* "on job", not "with a passenger". The series is request-to-dropoff, which
     contains the drive to the rider and the wait for them — Uber's export has
     two timestamps and no pickup time, so the ride itself cannot be separated
     out of it. The old label made a claim about passengers that no feed here
     supports, and the gap below it was described as earning nothing when part
     of it was the approach to a job that did. */
  host.append(el('div', 'legend', `
    <span><i style="background:var(--s1)"></i>online ${fmt(online, 0)}h</span>
    <span><i style="background:var(--s3)"></i>on job, request to dropoff ${fmt(onTrip, 0)}h</span>
    <span>the gap is ${fmt(online - onTrip, 0)}h logged in with no job running</span>`));
}

/* ── identity header, shown above every tab ──────────────────────────────── */
/* A licence date shared by most of the roster is what this source writes when
   the field was never filled in — 77 people carry licence number 123456 and
   the same expiry. Counted as an expiry it accuses them of driving illegally,
   which is what the directory toolbar and this pill both did while the
   compliance page, running the same check, reported `expired: 0`. Two halves
   of one product disagreeing about whether 77 people can legally drive.

   Recognised from the row where the endpoint says so, and from the tell-tale
   placeholder licence number until it does, so this reads correctly both
   before and after the server grows the field. */
const isPlaceholderLicence = (c) => !!(c.licence_placeholder
  || (c.placeholder_date && String(c.licence_expires || '').slice(0, 10) === String(c.placeholder_date).slice(0, 10))
  || /^0*123456$/.test(String(c.licence_no || '')));

function identityCard(p) {
  const c = p.compliance?.[0] || {};
  const wrap = el('div', 'idcard');
  const lic = c.licence_days_left;
  const placeholder = isPlaceholderLicence(c);
  const licTone = placeholder ? null : lic == null ? null : lic < 0 ? 'bad' : lic < 30 ? 'warn' : 'ok';
  /* Accounts, counted from the accounts the profile RETURNS. It was the length
     of `p.accounts`, which is derived from trip rows — so a Bolt driver who
     plainly has an account and has taken no trip read "ACCOUNTS 0" on their
     own page, beside a Bolt pill. */
  const accN = (p.accounts || []).length;
  const idN = (p.ids || []).length;
  const platN = (p.platforms || []).length;
  const accounts = Math.max(accN, idN, platN);

  /* Two spans on one card, and they were being read as one.
     ───────────────────────────────────────────────────────────────────────
     /api/driver/profile answers with BOTH: `span` is the selected window and
     `accounts[].trips` is everything on record. Measured on one driver:

       days=7    span.trips    54    first_trip 2026-08-19
       days=30   span.trips   266    first_trip 2026-07-27
       days=365  span.trips  3280    first_trip 2025-08-27
       accounts[0].trips      3295   first_trip 2025-08-24   (unmoved)

     The card printed span.first_trip under the heading "First seen" — so a
     driver who has been on Uber since August 2025 was introduced as first seen
     in July 2026, and moving the range selector changed the date they were
     hired. On the page that identifies a person, that is the wrong fact under
     the right word.

     So the two are separated and both are drawn. First and last trip come from
     the ACCOUNT record, which does not move; trips, days worked and cars held
     are the window's, and say so. Every tab below is a slice of this person,
     and none of those slices meant anything without the whole to divide by. */
  const evTrips = (p.accounts || []).reduce((a, x) => a + (+x.trips || 0), 0) || null;
  const dates = (k) => (p.accounts || []).map((a) => a[k]).filter(Boolean).sort();
  const firstEver = dates('first_trip')[0] || p.span?.first_trip;
  const lastEver = dates('last_trip').pop() || p.span?.last_trip;

  wrap.innerHTML = `
    ${avatar(p.name, c.picture_url)}
    <div class="idmeta">
      <h2>${esc(p.name || 'Unnamed driver')}</h2>
      <div class="idsub">
        ${(p.platforms || []).map((x) => pill(sourceLabel(x), 'plat')).join('')}
        ${p.span?.fleet_id ? pill(p.span.fleet_id, 'plat') : ''}
        ${c.state ? pill(c.state, c.state === 'active' ? 'ok' : 'warn') : ''}
        ${placeholder
    ? '<span class="pill" title="This source writes 2026-01-01 with licence number 123456 when the field was never filled in. It is a gap in the record, not an expiry.">licence date not filled in</span>'
    : lic != null ? pill(`licence ${lic < 0 ? `expired ${Math.abs(lic)}d ago` : `${lic}d left`}`, licTone) : ''}
      </div>
      <div class="idfacts">
        ${c.phone ? `<span><b>Phone</b> <a class="lnk" href="tel:${esc(c.phone)}">${esc(c.phone)}</a></span>` : ''}
        ${c.email ? `<span><b>Email</b> <a class="lnk" href="mailto:${esc(c.email)}">${esc(c.email)}</a></span>` : ''}
        ${c.licence_no ? `<span><b>Licence</b> ${esc(c.licence_no)}</span>` : ''}
        ${c.emirates_id ? `<span><b>Emirates ID</b> ${esc(c.emirates_id)}</span>` : ''}
        ${c.device_brand ? `<span><b>Device</b> ${esc(c.device_brand)} ${esc(c.device_model || '')}</span>` : ''}
        <span><b>First trip</b> ${dateStr(firstEver)}<span class="dim" title="the first trip on record for this person's platform account — it does not move with the range selector"> ever</span></span>
        <span><b>Last trip</b> ${lastEver ? `${dateStr(lastEver)} ${timeStr(lastEver)}` : '—'}</span>
        ${evTrips ? `<span><b>Trips</b> ${fmt(evTrips)}<span class="dim" title="every trip on record for this person, in every window"> ever</span></span>` : ''}
        ${p.span?.trips != null ? `<span><b>In this window</b> ${fmt(p.span.trips)} trip${p.span.trips === 1 ? '' : 's'}${
  p.span.days_worked != null ? ` over ${fmt(p.span.days_worked)} day${p.span.days_worked === 1 ? '' : 's'}` : ''}${
  p.span.vehicles ? ` in ${fmt(p.span.vehicles)} car${p.span.vehicles === 1 ? '' : 's'}` : ''}</span>` : ''}
        <span><b>Accounts</b> ${fmt(accounts)}${accN !== accounts
    ? `<span class="dim" title="${accN} of them have taken a trip we hold"> · ${accN} with trips</span>` : ''}</span>
        ${p.rating != null ? `<span><b>Rating</b> ${fmt(p.rating, 2)}<span class="dim" title="${
  esc(sourceLabel(p.rating_platform))}'s own rating, read ${p.rating_at ? dateStr(p.rating_at) : 'daily'}"> ${
  esc(sourceLabel(p.rating_platform))}</span></span>` : ''}
        ${p.platform_lifetime_trips ? `<span><b>${esc(sourceLabel(p.rating_platform || 'uber'))} count</b> ${
  fmt(p.platform_lifetime_trips)}<span class="dim" title="trips the platform has ever recorded for this driver. Ours covers what we collected; theirs covers the whole relationship, so the two are shown side by side rather than merged."> ever</span></span>` : ''}
      </div>
      ${(p.banned_on || []).length || (p.platform_compliance || []).length ? `<div class="idsub">${
  (p.banned_on || []).map((x) => `<span class="pill bad" title="${esc(sourceLabel(x))} has barred this driver from taking work">${esc(sourceLabel(x))}: barred</span>`).join('')
}${(p.platform_compliance || []).map((c2) => {
    const ok = /active|valid|compliant/i.test(c2.status || '');
    return `<span class="pill ${ok ? 'ok' : 'warn'}" title="the platform's own view of whether this driver's papers are in order, which is separate from the document register on the Compliance page">${
      esc(sourceLabel(c2.platform))} papers: ${esc(String(c2.status).toLowerCase())}</span>`;
  }).join('')}</div>` : ''}
      ${(p.standing || []).length ? `<div class="idsub">${(p.standing || []).map((s) => {
    const tone = /suspend|deact|block/i.test(s.state || '') ? 'bad' : s.state === 'active' ? 'ok' : 'warn';
    return `<span class="pill ${tone}" title="${esc([s.platform, s.reason, s.plate ? `holds ${s.plate}` : null]
      .filter(Boolean).join(' · '))}">${esc(s.platform)}: ${esc(s.state || 'no state')}</span>`;
  }).join('')}</div>` : ''}
    </div>`;
  return wrap;
}

/* ── tab: overview ───────────────────────────────────────────────────────── */
async function tabOverview(root, id, prof) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const stand = panel('Standing in the fleet', 'Percentile against every driver with 5+ trips in this window'); g1.append(stand.panel);
  /* Lifetime, on a page whose every other panel is the selected window — and
     sorted by days held, so the car this person is driving today sat fourth
     behind three they gave back in March. The window is stated and the sort
     is by recency. */
  const veh = panel('Vehicles held — over the whole record',
    'Not this window. Newest custody first, so the car they are in now is the first row.');
  g1.append(veh.panel);
  const g2 = el('div', 'grid g2'); root.append(g2);
  const start = panel('When the day starts', 'First trip of each working day'); g2.append(start.panel);
  const hm = panel('Weekday × hour', 'Where this driver’s trips actually fall'); g2.append(hm.panel);
  const vol = panel('Trips per day', 'Completed and cancelled, day by day'); root.append(vol.panel);
  [stand.body, veh.body, start.body, hm.body, vol.body].forEach(loading);

  const [k, st, daily, hmap] = await Promise.all([
    qAll('/api/driver/kpis', { id }), qAll('/api/driver/standing', { id }),
    qAll('/api/driver/daily', { id }), qAll('/api/driver/heatmap', { id }),
  ]);

  kpiHost.replaceWith(kpiRow([
    { label: 'Typical start', value: hourStr(k.median_start_h), sub: k.start_consistency_h != null ? `±${(+k.start_consistency_h).toFixed(1)}h day to day` : null },
    { label: 'Days worked', value: fmt(k.days_worked), sub: `${fmt(k.trips_per_day, 1)} trips per day` },
    /* Both tiles say where the figure came from and over how much of the
       window, because neither is a whole-window fact. Availability is Uber's
       and Uber's only — 31 days of it — so a hotel or Yango driver has none,
       and a total with no day count under it reads as a month when it may be
       a fortnight. */
    { label: 'Hours online',
      value: k.hours_online != null ? fmt(k.hours_online, 1) : '—',
      sub: k.hours_online == null
        ? 'no channel this driver works publishes availability'
        : `${fmt(k.hours_on_job, 1)}h on job · ${countOf(k.hours_days, 'day')} with availability` },
    /* on-job ÷ online, and both halves from the stored record so the ratio is
       between two things measured the same way. It used to divide the
       platform's hours_on_trip — which nothing writes — by the platform's
       hours_online, and null/n is 0 in JavaScript, so this tile printed a
       confident critical 0% for every driver that had a denominator. */
    { label: 'Utilisation', value: k.utilisation_pct != null ? pct(k.utilisation_pct) : '—',
      sub: k.utilisation_pct == null ? 'needs both online and on-job time' : 'on-job ÷ online',
      tone: k.utilisation_pct == null ? null : k.utilisation_pct >= 55 ? 'good' : k.utilisation_pct >= 35 ? 'warn' : 'critical' },
    /* 3,381 km over 269 trips is 12.6, and this said 14.8 — avg_km is over
       the trips that report a distance, which was not on the tile. */
    { label: 'Trips', value: fmt(k.trips),
      sub: k.trips_with_distance && k.trips_with_distance !== k.trips
        ? `${fmt(k.km)} km · avg ${fmt(k.avg_km, 1)} km over the ${fmt(k.trips_with_distance)} `
          + 'reporting one'
        : `${fmt(k.km)} km · avg ${fmt(k.avg_km, 1)} km` },
    /* The numerator as well as the denominator. A rate with only its base under
       it is a figure the reader has to take on trust — and the fleet page six
       inches away on another screen prints both. */
    { label: 'Completion', value: pct(k.completion_pct, 1),
      sub: k.outcome_n
        ? `${fmt(k.completed)} of ${fmt(k.outcome_n)} completed, ${fmt(k.not_completed)} did not`
        : 'no platform here reports an outcome',
      tone: k.completion_pct == null ? null : k.completion_pct >= 95 ? 'good' : k.completion_pct >= 85 ? 'warn' : 'critical' },
    /* What this person's work brought in, both channels. This tile was the
       fares on their trips, and Uber's export has no fare column — so a driver
       doing eighty Uber trips and one hotel booking led with the price of the
       hotel booking. Their actual pay was three panels down under Earnings. */
    /* Only the halves that exist are named. This printed both unconditionally,
       so an Uber-only driver read "AED 0 in fares · AED 10,243 paid out" — and
       once the tile beside it started showing the statement's fare line, the
       same screen said AED 0 in fares and AED 15,738 in fares at the same
       time. The zero was never a measurement: it is the trip record having no
       fare column, which the Fares tile now says in words. */
    /* Both choosers live in ui.js now, because the PHONE showed a dash over
       this same driver's AED 22,925 while this tile showed the money. One
       implementation is the only way the two shells cannot disagree about what
       a person earned. */
    moneyInTile(k),
    faresTile(k),
    /* The same renderer as the Quality tab, so the two tiles cannot drift into
       showing one driver two different ratings. */
    ratingTrend(k),
  ]));

  /* The revenue bar ranks a driver against a fleet whose median fare is zero,
     because Uber publishes no fare per trip — so a hotel driver with four
     priced bookings scores 98th, an Uber-only driver scores nothing at all,
     and neither number compares to the other. Captioned rather than dropped:
     the bar is real about the fares it measured, and it is the sentence that
     was missing. */
  const moneyBar = (st.metrics || []).some((m) => /revenue|fare|earn/i.test(m.label || ''));
  percentileBars(stand.body, st.metrics || [], {
    note: 'Fares only — most of this fleet\'s work carries no fare, so this percentile is not comparable.' });
  if (!(st.metrics || []).length) {
    stand.body.append(note(k.trips
      ? `${fmt(k.trips)} trips in this window, which is fewer than the five a ranking needs — this person `
        + 'is not ranked rather than ranked badly.'
      : 'No trip in this window, so there is nothing to rank. Widen the range above.'));
  } else {
    stand.body.append(el('p', 'cap',
      `Compared against ${countOf(st.n_peers || 0, 'driver')} with five or more trips in this window.`
      + (moneyBar
        ? ` The revenue bar is over FARES only, and ${UBER_FARE_WHY} — so on a fleet that is `
          + 'mostly Uber the median it is measured against is near zero until those weeks land, and '
          + 'a driver who works one priced channel outranks one who works none. Read it as a rank '
          + 'among priced bookings, not as a rank by earnings.'
        : '')));
  }

  veh.body.innerHTML = '';
  // Narrow panel — the date range rides in the row tooltip rather than forcing
  // a horizontal scrollbar onto four columns that matter more.
  // Newest custody first: "which car are they in now" is the question this
  // panel is opened for, and days-held answered a different one.
  const heldRows = [...(prof.vehicles || [])]
    .sort((a, b) => String(b.last_day || '').localeCompare(String(a.last_day || '')));
  const vt = tableFrom(heldRows.slice(0, 8), [
    /* entity(), not a hand-rolled anchor: href() drops falsy parts, so a null
       plate produced `#vehicle` — a link with empty text that silently opened
       the whole vehicle directory instead of saying there was nothing to open. */
    { label: 'Plate', key: 'plate',
      render: (r) => entity('vehicle', r.plate, r.plate)
        + (r.ever_primary ? ' <span class="dim" title="primary holder on at least one day">●</span>' : '') },
    { label: 'Last held', key: 'last_day', render: (r) => dateStr(r.last_day) },
    { label: 'Days', key: 'days', num: true },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
  ], { compact: true, sortable: true, sortId: 'held', defaultSort: { key: 'last_day', dir: 'desc' } });
  veh.body.append(vt);
  veh.body.append(el('p', 'cap', '● marks a vehicle this driver was the primary holder of. '
    + `Custody is over the whole record, not the window above${heldRows.length > 8
      ? ` — showing the ${fmt(Math.min(8, heldRows.length))} most recent of ${fmt(heldRows.length)}` : ''}.`));

  startScatter(start.body, daily);
  heatmap(hm.body, hmap);
  vol.body.innerHTML = '';
  barChart(vol.body, daily.map((d) => ({ ...d, label: dayStr(d.day) })), { x: 'label', y: 'trips', color: '--b400' });
}

/* ── tab: activity ───────────────────────────────────────────────────────── */
async function tabActivity(root, id) {
  /* Full width. Twenty-eight days of a 24-hour axis in half a page gives each
     hour about eight pixels, so a thirty-minute job is four pixels wide and
     the panel that exists to show WHEN somebody worked shows a smear. */
  const sh = panel('How the day was spent',
    'Each job at its real position, and the waiting between them'); root.append(sh.panel);
  const g0 = el('div', 'grid g2'); root.append(g0);
  /* "on job", not "on-trip". The lower series is request-to-dropoff and the
     legend, the table column and the API field all say so; a title still
     promising time with a passenger is the one place left claiming a split no
     feed here reports. */
  const hrs = panel('Hours online vs on job',
    'From whichever feed measured the day — the platform\u2019s own daily figure where it publishes one, '
    + 'the availability record where it does not'); g0.append(hrs.panel);
  const dist = panel('Distance per day', 'Kilometres covered'); g0.append(dist.panel);
  /* "every day any feed reached", not "every working day". The spine is the
     union of the trip days, the days a statement paid for and the days
     availability was collected — so a day online with no job, and a day paid
     for work the trip feed missed, both appear, with zero trips on them. Those
     are two of the most informative rows here and the old subtitle promised
     they would not be. */
  const tbl = panel('Day by day',
    'Every day any feed reached in this window \u2014 including days with no trip on them \u2014 '
    + 'with the weather and calendar context for that date'); root.append(tbl.panel);
  const cust = panel('Vehicle custody', 'Which car, which day — handovers included'); root.append(cust.panel);
  [sh.body, hrs.body, dist.body, tbl.body, cust.body].forEach(loading);

  /* qAll, not q. A detail page must ignore the platform and fleet chips:
     "everything about this person" while a filter silently hides half their
     work is a lie, and on this panel it would erase whole jobs from the middle
     of a shift and redraw them as waiting. */
  const [daily, custody, shift, kept] = await Promise.all([
    qAll('/api/driver/daily', { id }), qAll('/api/driver/custody', { id }),
    qAll('/api/driver/shift', { id }),
    /* The KEPT record. /api/driver/shift derives from raw and is what the bars
       are drawn from; this is driver_day, written after every collection and
       outliving the providers' own retention. They should agree for any window
       both can answer, and only one of them can answer a window older than
       Uber's 31 days of availability. */
    qAll('/api/driver/days', { id }).catch(() => null)]);

  shiftBars(sh.body, shift.days, shift, id);
  /* Stated under the bars: what is kept, and how far back it goes. A reader
     looking at a chart that is bare on the left should not have to infer
     whether that is a quiet month or a provider that forgets. */
  if (kept?.totals?.days) {
    const t = kept.totals;
    sh.body.append(el('p', 'cap', esc(
      `${fmt(t.days)} of these days are also held as a stored record — `
      + `${fmt(Math.round(t.on_job_min / 60))} h on job and ${fmt(Math.round(t.wait_min / 60))} h waiting, `
      + `written after each collection rather than recomputed. `
      + (kept.online_days
        ? `${fmt(kept.online_days)} of them carry availability, which Uber itself only serves for 31 days. `
        : 'None of them carry availability yet. ')
      /* Dated, because "after each collection" is not a time.
         ─────────────────────────────────────────────────────────────────
         Swept over all 119 active drivers, this record and the live figures
         above it agree exactly on 115. The other four differ by one trip,
         every one of them on today, because the rollup ran and then the trip
         feed moved. Correct, and on the page indistinguishable from the
         arithmetic being wrong — so the record says when it was taken and the
         reader can tell a lag from a discrepancy. */
      + (t.computed_at
        ? `Written at ${dtStr(t.computed_at)}; anything collected since then is in the figures `
          + 'above and not yet in this record, so today can differ by a trip or two.'
        : ''))));
  }

  /* Two feeds answer this question and the panel used to ask only one.
     ─────────────────────────────────────────────────────────────────────────
     It read driver_performance's single-day rows, which Uber publishes for
     nine people out of 241, and said "No platform-reported hours in this
     window" — sitting directly under a shift timeline that had just drawn 405 h
     of this driver's August from the availability feed, and beside a stored
     per-day record holding the same figure. The number was collected. Only
     this panel did not ask for it.

     /api/driver/daily now answers from the platform where the platform speaks
     and from the availability record where it does not, and says which per day
     in hours_online_basis. The caption below reports that split rather than
     leaving a reader to assume one source — because the two are not
     interchangeable: one is the platform's own daily total, the other is our
     fold of the ONLINE spans it emitted. */
  const withHours = daily.filter((d) => d.hours_online != null);
  const nBasis = (b) => withHours.filter((d) => d.hours_online_basis === b).length;
  hrs.body.innerHTML = '';
  if (!withHours.length) {
    hrs.body.append(note('Neither feed answered for any day in this window: no channel published a '
      + 'daily hours figure, and no availability was collected. Uber is the only channel here that '
      + 'publishes availability at all, and only for the last 31 days, so this fills in as the '
      + 'collector runs and stays empty for a driver who works the other channels.'));
  } else {
    dualSeries(hrs.body, withHours);
    const plat = nBasis('platform');
    const avail = nBasis('availability');
    hrs.body.append(el('p', 'cap', esc(
      (plat && avail
        ? `${fmt(plat)} of these days are the platform\u2019s own hours figure and ${fmt(avail)} are `
          + 'derived from its ONLINE spans, so the two are measured differently.'
        : plat
          ? `All ${fmt(plat)} days are the platform\u2019s own reported hours.`
          : `The platform published no daily hours for this window, so all ${fmt(avail)} days are `
            + 'the ONLINE spans it emitted, folded into Dubai days and stored after each collection.')
      + ' The lower series is request to dropoff, which contains the drive to the rider \u2014 '
      + 'no channel here reports a pickup time, so the ride itself cannot be separated out of it.'
      + (withHours.length < daily.length
        ? ` ${fmt(daily.length - withHours.length)} of the ${fmt(daily.length)} days in this window `
          + 'have neither.'
        : ''))));
  }

  dist.body.innerHTML = '';
  barChart(dist.body, daily.map((d) => ({ label: dayStr(d.day), km: +d.km || 0 })), { x: 'label', y: 'km', color: '--b300', valueFmt: (v) => `${fmt(v)} km` });

  tbl.body.innerHTML = '';
  tbl.body.append(tableFrom([...daily].reverse(), [
    // A day is an address, and it was the one cell in the row that was not.
    { label: 'Day', key: 'day',
      render: (r) => entity('day', String(r.day).slice(0, 10), dayStr(r.day)) },
    { label: 'First', key: '_f', render: (r) => hourStr(r.first_hour) },
    { label: 'Last', key: '_l', render: (r) => hourStr(r.last_hour) },
    { label: 'Span', key: 'span_h', num: true, render: (r) => (r.span_h ? `${fmt(r.span_h, 1)} h` : '—') },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Cancelled', key: 'cancelled', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Fares', key: 'revenue', num: true, absent: UBER_FARE,
      render: (r) => (r.revenue ? money(r.revenue) : '\u2014') },
    /* What the day was actually worth, which the Fares column beside it cannot
       say. Fares are null on every Uber-only day \u2014 85 of this fleet's 119
       active drivers \u2014 because Uber's trip export carries no fare column;
       the money is in the statement, and driver_day resolves the two into one
       comparable figure per platform.

       Marked where it is an ALLOCATION rather than a measurement. Uber files
       this fleet weekly, so a week's earnings are divided across seven days
       and each of those days carries a seventh: real money, right at the week,
       and a figure nobody took on any single day inside it. The first version
       of this column shipped without the mark and production answered 309.88
       for seven days running \u2014 which reads as seven measurements. The
       grain travels with the number now (sql/schema_v44.sql), and a cell that
       cannot say it was measured says what it is instead. */
    { label: 'Money', key: 'money', num: true,
      absent: 'no channel this driver worked reported either a statement or a fare for these days',
      render: (r) => {
        if (r.money == null) return '\u2014';
        /* Three states, not two. A window of one day is a measurement; a
           window of seven is a share of one; and NO window recorded is neither
           — an operator import, or a row written before the grain was carried.
           Collapsing the third into either of the others is how a figure
           nobody measured comes to be printed as one. */
        const n = r.money_period_days;
        const tag = n == null ? 'grain?' : n > 1 ? `1/${n}` : (r.money_source || 'day');
        const why = n == null
          ? 'the statement behind this figure does not record the period it covered, so whether '
            + 'it was measured on this day is not something we can say'
          : n > 1
            ? `a ${n}-day statement divided across its days \u2014 right for the period, not `
              + 'measured on this day'
            : r.money_source === 'fares'
              ? 'the channel priced each booking on this day'
              : r.money_source === 'mixed'
                ? 'one channel filed a statement and another reported only fares'
                : 'the channel filed this day';
        return money(r.money) + `<span class="dim" title="${esc(why)}"> \u00b7 ${esc(tag)}</span>`;
      } },
    /* Marked where the figure is our fold of the availability spans rather than
       a number the platform itself published \u2014 same column, two
       provenances, and a reader deserves to know which cell is which. */
    { label: 'Online', key: 'hours_online', num: true,
      absent: 'availability reaches this fleet from Uber only, and only for the last 31 days \u2014 '
        + 'a driver who works the hotel channel or Yango has none, which is not the same as a '
        + 'driver who was never online',
      render: (r) => (r.hours_online
        ? `${fmt(r.hours_online, 1)} h` + (r.hours_online_basis === 'availability'
          ? '<span class="dim" title="from the availability feed\u2019s ONLINE spans, not a figure the platform published"> \u00b7 spans</span>' : '')
        : '\u2014') },
    { label: 'On job', key: 'hours_on_job', num: true,
      absent: 'no job on these days carries both a request and a dropoff time',
      render: (r) => (r.hours_on_job ? `${fmt(r.hours_on_job, 1)} h` : '\u2014') },
    /* A day may span two vehicles \u2014 a handover \u2014 so this is a
       comma-joined list, and each plate in it is its own page. */
    { label: 'Vehicle', key: 'plates', render: (r) => (r.plates
      ? String(r.plates).split(',').map((pl) => entity('vehicle', pl.trim(), pl.trim())).join(', ')
      : '\u2014') },
    /* No holiday here, and its absence is the honest reading.
       ─────────────────────────────────────────────────────────────────────
       calendar_day.is_holiday and holiday_name have never had a writer: only
       the DDL default at sql/schema_v2.sql:85, which is false. Rendered, that
       default said "not a public holiday" on every day of the record when what
       it meant was that nobody was ever asked. A column that cannot be
       anything but one value is not information, and printing it as one is the
       same mistake as filling a gap by inference. */
    { label: 'Context', key: '_c', render: (r) => [
      r.temp_max != null ? `${Math.round(r.temp_max)}\u00b0C` : null,
      r.precipitation > 0 ? 'rain' : null,
      r.is_ramadan ? 'Ramadan' : null,
    ].filter(Boolean).join(' · ') || '—' },
  ]));
  /* Said once under the table rather than left to the tags in the cells: the
     three columns to the right of Trips are measured over three different
     windows, and a reader adding them across a row deserves to know that
     before they do it. */
  {
     const spread = daily.filter((r) => r.money_period_days > 1);
     const unknown = daily.filter((r) => r.money != null && r.money_period_days == null);
     if (spread.length || unknown.length) {
       tbl.body.append(el('p', 'cap', esc(
         (spread.length
           ? `Money on ${fmt(spread.length)} of these days is a share of a longer statement \u2014 `
             + `${[...new Set(spread.map((r) => r.money_period_days))].sort((a, b) => a - b)
               .map((n) => `${n}-day`).join(' and ')} periods divided across the days they cover. `
             + 'The total over a whole period is what the platform reported; the figure on any one '
             + 'day inside it is not something anybody measured. Fares, where a channel prices its '
             + 'bookings, are per booking and need no such caveat. '
           : '')
         + (unknown.length
           ? `${fmt(unknown.length)} carry money from a statement that does not record the period `
             + 'it covered, so whether those are daily figures is not something this page can say.'
           : ''))));
     }
  }

  cust.body.innerHTML = '';
  const custRows = Array.isArray(custody) ? custody : (custody.rows || []);
  const custTotal = Array.isArray(custody) ? null : custody.total;
  const custShown = custRows.slice(0, 60);
  cust.body.append(tableFrom(custShown, [
    { label: 'Day', key: 'day',
      render: (r) => entity('day', String(r.day).slice(0, 10), dayStr(r.day)) },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Platform', key: 'platform', render: (r) => esc(sourceLabel(r.platform)) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'First', key: 'first_trip_at', render: (r) => timeStr(r.first_trip_at) },
    { label: 'Last', key: 'last_trip_at', render: (r) => timeStr(r.last_trip_at) },
    { label: 'Primary', key: 'is_primary',
      render: (r) => (r.is_primary ? '<span title="primary holder of this vehicle on this day">●</span>' : '—') },
  ], { sortable: true, sortId: 'custody', defaultSort: { key: 'day', dir: 'desc' } }));
  /* The table was cut to sixty of however many the endpoint returned — which
     is itself capped — and said nothing, so 60 of 256 days read as the whole
     of a driver's custody history. */
  if (custRows.length > custShown.length || (custTotal && custTotal > custShown.length)) {
    cust.body.append(el('p', 'cap',
      `Showing the ${fmt(custShown.length)} most recent of ${fmt(custTotal ?? custRows.length)} custody `
      + `${plural(custTotal ?? custRows.length, 'day')} in this window`
      + (custTotal && custTotal > custRows.length
        ? ', and the server sent only the newest of those.' : '.')));
  }
}

/* ── tab: territory ──────────────────────────────────────────────────────── */
async function tabTerritory(root, id) {
  // Map beside the area list rather than above it: a full-width map is roughly
  // 2.4:1, and a driver's working area is roughly square, so a full-width panel
  // is mostly empty margin however tightly the points are framed.
  const g = el('div', 'grid g23'); root.append(g);
  const mapP = panel('Where this driver works', 'Circles are pickup clusters, sized by trips. Hollow markers are places the vehicle sat still between jobs.');
  mapP.panel.classList.add('mapwrap'); g.append(mapP.panel);
  const node = el('div', 'mapnode'); mapP.body.append(node);
  const areas = panel('Busiest pickup areas', 'From the address the platform recorded'); g.append(areas.panel);
  const dmix = panel('Trip distance mix', 'Short hops or long runs'); root.append(dmix.panel);
  [areas.body, dmix.body].forEach(loading);

  const [terr, mix] = await Promise.all([qAll('/api/driver/territory', { id }), qAll('/api/driver/mix', { id })]);

  // The map is drawn either way. An empty map of the emirate still tells you
  // "we have no positions for this person", which a paragraph in place of the
  // map does not — and it keeps the page from reflowing between drivers.
  {
    const map = await makeMap(node, { zoom: 10 });
    const pts = [];
    const max = Math.max(1, ...terr.pickups.map((p) => p.n));
    terr.idle.forEach((s) => {
      L.circleMarker([s.lat, s.lng], { radius: 5 + Math.min(9, Math.sqrt(s.fixes)), color: css('--s5'), weight: 1.4,
        fill: false, opacity: .65, dashArray: '3,3' }).addTo(map)
        .bindTooltip(`Stationary here across ${s.fixes} five-minute fixes`, { direction: 'top' });
      pts.push([s.lat, s.lng]);
    });
    terr.pickups.forEach((p) => {
      L.circleMarker([p.lat, p.lng], {
        radius: 4 + 11 * Math.sqrt(p.n / max), color: '#fff', weight: 1.2,
        fillColor: css('--s1'), fillOpacity: .8,
      }).addTo(map).bindTooltip(
        `<b>${esc(p.addr || 'pickup')}</b><br>${p.n} pickup${p.n > 1 ? 's' : ''}` +
        `<br>avg ${fmt(p.avg_km, 1)} km${p.avg_fare ? ` · ${money(p.avg_fare)}` : ''}`, { direction: 'top' });
      pts.push([p.lat, p.lng]);
    });
    terr.dropoffs.slice(0, 150).forEach((d) => {
      L.circleMarker([d.lat, d.lng], { radius: 3, color: css('--s3'), weight: 1, fillColor: css('--s3'), fillOpacity: .4 })
        .addTo(map).bindTooltip(`Drop-off · ${esc(d.addr || '')} (${d.n})`, { direction: 'top' });
    });
    // Zoom to the driver's own working area rather than the whole emirate:
    // frame every marker with a fixed pixel margin, capped so a driver who only
    // ever works one street doesn't end up looking at rooftops.
    fitTo(map, pts, { maxZoom: 14 });
    if (!pts.length) {
      mapP.body.append(note('No positioned trips for this driver in this window. Uber supplies pickup coordinates; the FMS telematics feed does not, so a telematics-only driver has nothing to plot.'));
    }
    /* The denominator the map is drawn over. A one-cluster map sat beside a
       table of 139 pickups across 25 areas, and the "no positioned trips" note
       fired only at exactly zero — so a driver with 138 unpositioned pickups
       and one positioned saw a map that looked like their whole territory. */
    const areaTrips = (terr.areas || []).reduce((a, x) => a + (+x.n || 0), 0);
    const plotted = terr.pickups.reduce((a, x) => a + (+x.n || 0), 0);
    mapP.body.append(el('div', 'legend', `
      <span><i style="background:var(--s1)"></i>pickups</span>
      <span><i style="background:var(--s3)"></i>drop-offs</span>
      <span><i style="border:1.5px dashed var(--s5);background:none"></i>waiting spots</span>
      ${pts.length ? `<span>${terr.pickups.length} pickup clusters · ${terr.idle.length} waiting spots</span>` : ''}`));
    if (pts.length && areaTrips > plotted) {
      mapP.body.append(el('p', 'cap',
        `${fmt(plotted)} of ${fmt(areaTrips)} pickups carry coordinates and are on this map. The other `
        + `${fmt(areaTrips - plotted)} have an address and no position — the table beside this is over `
        + 'all of them, so it will name areas the map does not show.'));
    }
  }

  areas.body.innerHTML = '';
  areas.body.append(tableFrom(terr.areas.slice(0, 12), [
    { label: 'Area', key: 'area' },
    { label: 'Pickups', key: 'n', num: true },
    { label: 'Avg trip', key: 'avg_km', num: true, render: (r) => (r.avg_km ? `${fmt(r.avg_km, 1)} km` : '—') },
    { label: 'Avg fare', key: 'avg_fare', num: true, absent: UBER_FARE,
      render: (r) => (r.avg_fare ? money(r.avg_fare)
        : `<span class="ent-off" title="no pickup in this area carries a fare — ${UBER_FARE_WHY}">—</span>`) },
  ], { compact: true, sortable: true, sortId: 'areas', defaultSort: { key: 'n', dir: 'desc' } }));
  if ((terr.areas || []).length > 12) {
    areas.body.append(el('p', 'cap',
      `The 12 busiest of ${countOf(terr.areas.length, 'area')} this driver picked up in.`));
  }

  dmix.body.innerHTML = '';
  /* The distance mix carried an average fare per bucket and the chart threw it
     away — "short hops or long runs" is only half the question, and the other
     half is whether the short ones pay. */
  const dist = (mix.distance || []).map((d) => ({ ...d }));
  hbars(dmix.body, dist, { label: 'label', value: 'n', seq: true, signed: false,
    valueFmt: (v) => `${fmt(v)} trips` });
  if (dist.some((d) => d.avg_fare != null)) {
    dmix.body.append(tableFrom(dist, [
      { label: 'Trip length', key: 'label' },
      { label: 'Trips', key: 'n', num: true },
      { label: 'Avg fare', key: 'avg_fare', num: true, absent: UBER_FARE,
        render: (r) => (r.avg_fare != null ? money(r.avg_fare, 'AED', 2)
          : '<span class="ent-off" title="no trip in this bucket reports a fare">—</span>') },
    ], { compact: true }));
  }
}

/* THE FARE THE PLATFORM DOES REPORT.
   ─────────────────────────────────────────────────────────────────────────
   Uber's trip export carries no fare column, so sum(trip.price) is null for an
   Uber-only driver and this tile read "—" under the sentence "where the
   platform reports fares" — for people who had billed six figures. The
   platform does report them: not per trip, but as the `fare` line of the
   weekly statement, which this page already draws under Earnings.

   Two rules, and the second is the important one.

   1. The trip record wins where it has anything. A hotel driver's fares are
      per-booking facts and this tile has always shown them.

   2. The statement figure is NEVER added to anything, and says so. `fare` is
      the gross the rider was charged; the payout on the tile beside it is what
      reached the fleet out of exactly that money, after the platform's
      commission. They are the same money seen twice, so the tile names the
      figure as the platform's own and the sub-line says it already contains
      the payout rather than sitting beside it. /api/driver/kpis returns it
      under its own key for the same reason — fleetIncome() never sees it. */

/* ── tab: earnings ───────────────────────────────────────────────────────── */
async function tabEarnings(root, id, prof) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const comp = panel('Earnings components', 'As the platform breaks them down — fares, tips, tolls, adjustments'); g.append(comp.panel);
  const pay = panel('How riders paid', 'Card vs cash changes what actually reaches the fleet'); g.append(pay.panel);
  const line = panel('Revenue by day', 'Booked fare value from the trip record'); root.append(line.panel);
  const per = panel('Platform payout periods', 'The statements each platform published for this driver'); root.append(per.panel);
  [comp.body, pay.body, line.body, per.body].forEach(loading);

  const [e, mix, daily, k] = await Promise.all([
    qAll('/api/driver/earnings', { id }), qAll('/api/driver/mix', { id }),
    qAll('/api/driver/daily', { id }), qAll('/api/driver/kpis', { id }),
  ]);

  /* Every cash label, summed — not the first one `.find` happens to hit.
     /api/driver/mix returns payment labels ordered by count, so `.find(/cash/i)`
     always landed on Uber's bare `cash` bucket, whose revenue is null because
     that export carries no fare column. The tile printed a dash while
     `cash-driver` (10 trips, AED 395) and `pos-driver` (1, AED 30) sat two rows
     below it, and the components panel further down showed a cash clawback of
     AED 343 the fleet was owed. */
  const CASH_LABEL = /(^|[^a-z])cash([^a-z]|$)|cash-driver|cash-supervisor|pos-driver/i;
  const cashRows = (mix.payment || []).filter((p) => CASH_LABEL.test(String(p.label || '')));
  const cashTrips = cashRows.reduce((a, p) => a + (+p.n || 0), 0);
  const cashKnown = cashRows.filter((p) => p.revenue != null);
  const cashValue = cashKnown.length ? cashKnown.reduce((a, p) => a + (+p.revenue || 0), 0) : null;
  kpiHost.replaceWith(kpiRow([
    /* Every money figure here is over the trips that CARRY a fare, which on a
       driver working mostly Uber is a small fraction of their work — the Uber
       trip export has no fare column at all. Presented against the trip count
       it reads as what they earned, which is the single most misread number in
       this product. */
    /* Same rule as the overview's Fares tile, and the same reason: the trips
       report nothing, the statement reports the fare, and the two must not be
       added. Where neither exists the tile still says which is missing. */
    /* And it is BOOKED revenue, which is not this driver's money. A fare is
       the gross the rider was charged; Uber's service fee is exactly a quarter
       of it, measured on 29 of 29 priced trips. Now that Uber's payments
       report is filling these in, this tile sits beside a payout that is the
       same money minus the commission, and a reader who adds the two counts
       the fare twice. The sentence says so rather than leaving the tile to be
       read as earnings. */
    (k.priced_trips
      ? { label: 'Booked revenue', value: money(k.revenue),
          sub: `the gross the riders were charged, over ${fmt(k.priced_trips)} of `
            + `${fmt(k.trips)} trips that report a fare — the payout below is what was left `
            + 'of it after the platform’s commission, not an addition to it',
          tone: k.trips && k.priced_trips / k.trips < 0.5 ? 'warn' : null }
      : { label: 'Booked revenue', value: k.statement_fares ? money(k.statement_fares) : '—',
          sub: k.statement_fares
            ? `no trip of theirs reports a fare — this is the statement's own fare line, over `
              + `${countOf(k.statement_fare_periods, 'period')}, and the payout below came out of it`
            : 'no trip of theirs reports a fare, and no statement reports one either' }),
    { label: 'Average fare', value: money(k.avg_fare, 'AED', 2),
      sub: k.priced_trips ? `over the ${fmt(k.priced_trips)} priced trips` : null },
    { label: 'Platform earnings', value: money(k.reported_earnings), sub: 'as the platform reported it' },
    { label: 'Tips', value: money(e.tips), sub: e.tip_pct != null ? `${pct(e.tip_pct, 1)} of net fare` : 'no tip data yet',
      tone: e.tip_pct == null ? null : e.tip_pct >= 3 ? 'good' : e.tip_pct >= 1 ? 'warn' : null },
    { label: 'Cash collected', value: (() => {
      // The clawback line in the payout breakdown is the same money seen from
      // the other side, and is the only figure present when no cash trip
      // carries a fare.
      const fromComponents = (e.components || [])
        .filter((c) => /cash/i.test(c.category))
        .reduce((a, c) => a + Math.abs(+c.amount || 0), 0);
      const v = k.cash_earnings ?? cashValue ?? (fromComponents || null);
      return v ? money(v) : (cashTrips ? 'not reported' : money(0));
    })(),
    /* "73 cash trips across cash" — the label list is usually the single word
       "cash", and naming it after "across" made the sentence eat itself. */
    sub: cashTrips
      ? (() => {
        const labels = cashRows.map((p) => p.label);
        const named = labels.length > 1 ? `, across ${labels.join(', ')}`
          : (labels.length === 1 && !/^cash$/i.test(labels[0]) ? `, labelled ${labels[0]}` : '');
        const short = cashKnown.length < cashRows.length
          ? ` — ${countOf(cashRows.length - cashKnown.length, 'of those labels reports',
            'of those labels report')} no fare at all`
          : '';
        return `${countOf(cashTrips, 'cash trip')}${named}${short}`;
      })()
      : 'no cash booking in this window',
    tone: cashTrips && cashKnown.length < cashRows.length ? 'warn' : null },
    // Priced fares over the distance of the priced trips. Dividing by the whole
    // distance mixes two populations and understates it by however much of the
    // work carries no fare.
    { label: 'Revenue per km', value: k.priced_km > 0 && k.priced_measured_revenue
      ? money(Number(k.priced_measured_revenue) / Number(k.priced_km), 'AED', 2) : '—',
      sub: k.priced_km
        ? `${money(k.priced_measured_revenue)} over ${fmt(k.priced_km)} km, on the `
          + `${fmt(k.priced_measured_trips)} trips reporting both`
        : 'no trip reports both a fare and a distance' },
  ]));

  comp.body.innerHTML = '';
  if (!e.components.length) {
    comp.body.append(note('No earnings breakdown for this driver yet. Uber publishes components per payout period; they appear once a period covering this window has been collected.'));
  } else {
    /* Roots as bars, children nested beneath the root they belong to.
       Charted as siblings, this driver's "refunds 33.54" sat beside its own
       two parts — toll 29.40 and airport_fee_partner 4.14 — and all three were
       bars, so the same AED 33.54 was drawn twice and the bars summed to more
       than the payout they decompose. `parent` was carried into a title
       attribute and used for nothing else. */
    const roots = e.components.filter((c) => !c.parent);
    const kids = e.components.filter((c) => c.parent);
    if (roots.length) {
      hbars(comp.body, roots.map((c) => ({ label: String(c.category).replace(/_/g, ' '), n: +c.amount || 0 })), {
        valueFmt: (v) => money(v, roots[0].currency || 'AED'),
        legend: [['--b400', 'added to the payout'], ['--s2', 'deducted (cash already taken, fees)']] });
      const net = roots.reduce((a, c) => a + (+c.amount || 0), 0);
      comp.body.append(el('p', 'cap',
        `${countOf(roots.length, 'top-level component')} netting to ${money(net)}. `
        + 'Anything listed below is INSIDE one of them and is not added again.'));
    }
    if (kids.length) {
      comp.body.append(tableFrom(kids.map((c) => ({
        within: String(c.parent).replace(/_/g, ' '),
        label: String(c.category).replace(/_/g, ' '),
        amount: +c.amount || 0, currency: c.currency,
      })), [
        { label: 'Within', key: 'within' },
        { label: 'Component', key: 'label' },
        { label: 'Amount', key: 'amount', num: true,
          render: (r) => `${r.amount < 0 ? '−' : ''}${money(Math.abs(r.amount), r.currency || 'AED', 2)}` },
      ], { compact: true, sortable: true, sortId: 'dcomp' }));
    }
    if (!roots.length) {
      comp.body.append(el('p', 'cap', 'Every component here names a parent that was not returned for '
        + 'this window, so these are parts of a payout rather than the payout.'));
    }
  }

  pay.body.innerHTML = '';
  /* donut() folds its own tail into "Other (N)" and prints the true total in
     the ring. Slicing to six before handing it over defeated that: the centre
     read "218 total" from six slices while the eleven the driver actually has
     sum to 229 — the page's own Trips tile. */
  donut(pay.body, mix.payment, { max: 6 });

  line.body.innerHTML = '';
  const withRev = daily.filter((d) => d.revenue != null && +d.revenue > 0);
  if (!withRev.length) line.body.append(note('No fare values on this driver’s trips in this window — the telematics and hotel feeds carry fares, the Uber trip export does not.'));
  else {
    /* A day with no fare is plotted as a ZERO, not skipped.
       Filtering to priced days made a 31-day window draw four bars with an
       x-axis reading "Aug 7 · Aug 19 · Aug 23 · Aug 25" — twelve-day holes
       rendered as adjacent bars, which reads as four consecutive days of work.
       The full series is built here and the caption says how much of it
       carries a fare at all. */
    const byDay = new Map(daily.map((d) => [String(d.day).slice(0, 10), d]));
    const days = daily.map((d) => String(d.day).slice(0, 10)).sort();
    const series = [];
    if (days.length) {
      for (let t = Date.parse(`${days[0]}T12:00:00Z`); t <= Date.parse(`${days[days.length - 1]}T12:00:00Z`); t += 864e5) {
        const key = dubaiDay(new Date(t));
        const d = byDay.get(key);
        series.push({ label: key, v: d && d.revenue != null ? +d.revenue : 0, worked: !!d });
      }
    }
    barChart(line.body, series, { x: 'label', y: 'v', valueFmt: (v) => money(v),
      colorFor: (d) => (d.v > 0 ? '--b400' : d.worked ? '--surface-3' : '--surface-2') });
    line.body.append(el('p', 'cap',
      `${countOf(withRev.length, 'day')} of ${fmt(series.length)} in this window carry a fare. `
      + 'The rest are drawn at zero rather than left out, so a gap looks like a gap — pale bars are days '
      + 'this driver worked with no fare recorded, and the faintest are days they did not work.'));
  }

  per.body.innerHTML = '';
  /* These are the statements the platform published, and they OVERLAP: a
     provider is asked for a report window, not for a disjoint period, so a
     backfill and a catch-up on different grids describe the same week twice.
     The server resolves that per day and hands back `counted` — the part of
     each statement no finer report already accounts for. `earnings` is still
     the statement's own figure, because that is what the platform will show
     the driver, and the two have to be reconcilable.

     Adding the Earnings column down the page gives a number that is too big.
     The column that adds up is Counted, so it is the one totalled and the one
     the note explains. */
  const displaced = e.periods.filter((r) => r.days_used != null && r.days_used < r.period_days);
  const counted = e.periods.reduce((a, r) => a + Number(r.counted ?? r.earnings ?? 0), 0);
  /* A column that can never carry a value is worse than an absent one: it
     reads as "we looked and this driver has no acceptance rate". Neither
     `acceptance_rate` nor `rating` is in this endpoint's SELECT, so both were
     a column of dashes on every driver on the fleet. Rendered only where the
     payload actually carries one, and explained once underneath when it does
     not. */
  const hasAccept = e.periods.some((r) => r.acceptance_rate != null);
  const hasRating = e.periods.some((r) => r.rating != null);
  per.body.append(tableFrom(e.periods, [
    { label: 'Platform', key: 'platform', render: (r) => esc(sourceLabel(r.platform)) },
    { label: 'Period', key: 'period_start', render: (r) => `${dateStr(r.period_start)} → ${dateStr(r.period_end)}` },
    { label: 'Days', key: 'days_used', num: true,
      render: (r) => (r.days_used == null ? '—'
        : r.days_used === r.period_days ? String(r.period_days)
        : `<span class="tag warn" title="the other ${countOf(r.period_days - r.days_used, 'day')} `
          + `${plural(r.period_days - r.days_used, 'is', 'are')} covered by another statement">`
          + `${r.days_used} of ${r.period_days}</span>`) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Online', key: 'hours_online', num: true, absent: UBER_HOURS,
      render: (r) => (r.hours_online ? `${fmt(r.hours_online, 1)} h` : '—') },
    { label: 'On trip', key: 'hours_on_trip', num: true, absent: UBER_HOURS,
      render: (r) => (r.hours_on_trip ? `${fmt(r.hours_on_trip, 1)} h` : '—') },
    ...(hasAccept ? [{ label: 'Accept', key: 'acceptance_rate', num: true,
      render: (r) => (r.acceptance_rate != null ? pct(r.acceptance_rate * 100) : '—') }] : []),
    { label: 'Statement', key: 'earnings', num: true, render: (r) => money(r.earnings) },
    { label: 'Counted', key: 'counted', num: true, render: (r) => money(r.counted ?? r.earnings) },
    /* The sentence under this column used to say no statement separates the
       cash a driver already took from the net figure. driver_statement_day.cash
       is sql/schema_v25.sql:41 and this endpoint reads that very table — the
       column was there, unselected, forty lines below the note denying it.
       This column stays the PAYOUT's cash, which is a different measure on a
       different period; the statement's own figure is stated under the table,
       where its grain can be named. */
    { label: 'Cash', key: 'cash_earnings', num: true,
      absent: 'this platform\u2019s payout feed does not split out the cash the driver already '
        + 'took \u2014 where the channel files a statement, that figure is stated under this table',
      render: (r) => money(r.cash_earnings) },
    ...(hasRating ? [{ label: 'Rating', key: 'rating', num: true,
      render: (r) => (r.rating ? fmt(r.rating, 2) : '—') }] : []),
  ], { sortable: true, sortId: 'periods', defaultSort: { key: 'period_start', dir: 'desc' } }));
  /* How much of this person's work these statements actually describe.
     ─────────────────────────────────────────────────────────────────────────
     Coverage is bounded by RETENTION now, not by a broken request. Uber's
     earner-payments REST surface answers only for the current payment period,
     and while that was the only statement surface a driver with 3,295 trips on
     record could have four of them covered. The supplier GraphQL breakdown
     reaches back about 192 days, on a rolling window that moves forward daily,
     so the fraction below is now "how much of their work Uber still holds"
     rather than "how much of it we managed to ask for". The Trips column
     below is per period; the lifetime figure is in the profile the page has
     already fetched, and it was the difference between "this is what they
     earned" and "this is what we can see of what they earned". Printed as a
     fraction so the second reading is the only one available. */
  const accTrips = (prof?.accounts || []).reduce((a, x) => a + (+x.trips || 0), 0)
    || (prof?.span?.trips ?? 0);
  const perTrips = e.periods.reduce((a, r) => a + (+r.trips || 0), 0);
  if (accTrips && perTrips) {
    per.body.append(el('p', 'cap',
      `These statements account for ${fmt(perTrips)} of this driver's ${fmt(accTrips)} trips on record`
      + ` — ${pct(perTrips / accTrips * 100, 1)} of their work. The rest is not unpaid: it is work `
      + 'whose payout statement no platform surface will serve any more. Uber answers for the current '
      + 'payment period and returns an empty list for every older window, however wide the request, so '
      + 'this fraction grows a week at a time from the day collection started and can never be '
      + 'backfilled.'));
  }
  per.body.append(el('p', 'cap', `${money(counted)} counted across ${countOf(e.periods.length, 'statement')}`
    + (displaced.length
      ? ` — ${fmt(displaced.length)} of them overlap another statement, and only the days no other `
        + 'statement covers are counted. Adding the Statement column instead would count those days twice.'
      : '. None of them overlap, so Statement and Counted agree.')
    + ((hasAccept && hasRating) ? ''
      : ` Acceptance and rating are ${(!hasAccept && !hasRating) ? 'both ' : ''}absent from this report — `
        + 'the platform publishes them on a different surface, so no column is drawn for them rather '
        + 'than a column of dashes that reads as zero.')
    + (Math.abs(counted - Number(k.reported_earnings || 0)) > 1 && k.reported_earnings
      ? ` The Platform-earnings tile above reads ${money(k.reported_earnings)}: that is the sum of the `
        + 'statements as published, and this is the part of them that falls inside the window — a '
        + 'statement straddling the edge contributes only its days inside it.'
      : '')));
  /* The statement's own split, at the grain it was filed at.
     ─────────────────────────────────────────────────────────────────────────
     driver_statement_day is one row per driver per day with the overlapping
     periods already resolved, and it carries the four figures a driver
     actually asks about: what the fare came to, what was tipped, what Salik
     cost, and how much of it they already hold in cash. The endpoint was
     reading that table for tips alone and joining it on driver_ext_id — a
     column this table leaves null, since its identity is the NAME. So the join
     matched nothing, tips read as a dash for everyone, and the Cash column
     carried a note saying no statement separates cash from net.

     Stated as its own sentence rather than folded into the table above,
     because it is a different measurement of the same money: the table is
     per PERIOD as the platform published it, and this is per DAY as the
     statement filed it. They are not columns of one thing. */
  if (e.statement_days) {
    const bits = [
      e.fare != null ? `${money(e.fare)} net` : null,
      e.tips ? `${money(e.tips)} in tips` : null,
      e.statement_salik ? `${money(e.statement_salik)} of Salik` : null,
      e.statement_cash != null ? `${money(e.statement_cash)} already taken in cash` : null,
    ].filter(Boolean);
    if (bits.length) {
      per.body.append(el('p', 'cap',
        `The day-level statements covering ${countOf(e.statement_days, 'day')} of this window `
        + `report ${bits.join(', ')}. That is the same money as the table above, filed per day `
        + 'rather than per payout period, so the two are two readings and not two amounts.'));
    }
  }
}

/* ── tab: quality ────────────────────────────────────────────────────────── */
async function tabQuality(root, id) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const cx = panel('Non-completed trips', 'Who cancelled, and how often'); g.append(cx.panel);
  const ev = panel('Harsh-driving events', 'From the telematics layer, attributed on days this driver held the vehicle'); g.append(ev.panel);
  const line = panel('Cancellations by day', 'One bar per day — hover for the day’s total'); root.append(line.panel);
  [cx.body, ev.body, line.body].forEach(loading);

  const [qy, k] = await Promise.all([qAll('/api/driver/quality', { id }), qAll('/api/driver/kpis', { id })]);
  /* Split, not summed. Main Power Lost is the tracker reporting its own power
     loss, and summed into this total it reads on the tile as something the
     driver did. The server marks each row; ui.js:splitAlerts reads the flag so
     no page keeps a copy of the word list. */
  const harsh = splitAlerts(qy.alerts || []);
  const totalAlerts = harsh.drivingN;

  kpiHost.replaceWith(kpiRow([
    /* A null completion used to paint red. `null >= 95` is false, so every
       driver whose platforms report no outcome at all scored 'critical' — the
       page accused them of a 0% completion rate it had never measured. */
    { label: 'Completion', value: pct(k.completion_pct, 1),
      sub: k.outcome_n
        ? `${fmt(k.completed)} of ${fmt(k.outcome_n)} trips whose platform reports an outcome`
        : 'no platform reported an outcome',
      tone: k.completion_pct == null ? null : k.completion_pct >= 95 ? 'good' : k.completion_pct >= 85 ? 'warn' : 'critical' },
    { label: 'Did not complete', value: pct(k.cancel_pct, 1),
      sub: 'cancelled, rejected, no-show — normalised across platforms',
      tone: k.cancel_pct == null ? null : k.cancel_pct <= 5 ? 'good' : k.cancel_pct <= 12 ? 'warn' : 'critical' },
    { label: 'Acceptance', value: k.acceptance_rate != null ? pct(k.acceptance_rate * 100) : '\u2014',
      sub: k.acceptance_rate != null ? 'platform-reported'
        : 'no channel here publishes an acceptance rate' },
    /* Uber's own rating, and it says whose and when.
       ─────────────────────────────────────────────────────────────────────
       This tile read a column of driver_performance that nothing writes, so it
       has been a dash on every driver since the page was built. Uber answers
       recognitionRating on GetDriver; the collector now asks (src/sources/
       uber_profile.js). A rating is the platform's standing view of a person,
       not a measurement over the window on the toolbar, so the sub-label names
       the platform rather than the dates. */
    ratingTrend(k) || { label: 'Rating', value: '\u2014',
      sub: 'not yet collected for this driver' },
    /* alert_km is this person's custody distance on the days the ALERT FEED
       was up, not their distance over the window. The two differ by every
       kilometre driven while the feed was dark, and putting the window's
       distance under a count of events the feed collected reads as one
       population when it is two. */
    { label: 'Harsh events', value: fmt(totalAlerts),
      sub: !harsh.classified && harsh.total
        ? 'not split from tracker faults — this feed does not mark them'
        : (qy.alert_km ? `over ${fmt(qy.alert_km)} km the feed covered` : 'no matched distance') },
    /* Against the FLEET, where the fleet figure exists, rather than against a
       hardcoded 5/15 scale. 29.5 per 100 km was painted critical under a
       sub-label reading "comparable across drivers" with nothing on the page
       to compare it to — and on a fleet whose own rate is 30, critical is the
       wrong word for average. Falls back to the constant scale, saying so, so
       this reads correctly before the fleet baseline is returned. */
    (() => {
      /* Through the shared figure, so a measured 0.033 prints "<0.1" rather
         than the "0.0" an unmeasured rate would show, and so the absence
         sentence is the server's — it knows which of its three reasons
         applies and this page cannot. */
      const a = alertRateFigure(qy);
      const v = a.measured ? a.value : null;
      const base = qy.fleet_alerts_per_100km;
      const cov = qy.alert_coverage;
      /* WHICH DAYS, on the tile. Both figures are measured over the days the
         alert feed covered — a rate over 16 of a window's 30 days is a
         different statement from one over all 30, and printed without saying
         so it made a driver appear to improve whenever their window widened
         across the feed's 73-day hole. */
      const over = cov?.basis ? ` · ${cov.basis}` : '';
      /* Not measured, in words. A window the feed was dark for the whole of
         has no rate at all — not a dash the reader has to interpret, and
         certainly not a zero. */
      if (v == null) {
        return { label: 'Per 100 km', value: 'not measured', sub: a.title };
      }
      if (base == null) {
        return { label: 'Per 100 km', value: a.text,
          sub: 'against a fixed 5 / 15 scale — the fleet\'s own rate is not published on this endpoint'
            + over,
          tone: v <= 5 ? 'good' : v <= 15 ? 'warn' : null };
      }
      const ratio = base > 0 ? v / base : null;
      return { label: 'Per 100 km', value: a.text,
        /* The baseline is measured over the same days as the driver — same
           module, same day set — so the comparison is like against like. */
        sub: `fleet median ${fmt(base, 1)}`
          + (ratio ? ` — ${ratio >= 1 ? `${fmt(ratio, 1)}x it` : `${fmt(1 / ratio, 1)}x better`}` : '')
          + over,
        tone: ratio == null ? null : ratio <= 0.7 ? 'good' : ratio <= 1.3 ? null : ratio <= 2 ? 'warn' : 'critical' };
    })(),
  ]));

  cx.body.innerHTML = '';
  /* Each platform has its own word for the same thing — Bolt reports
     'client_did_not_show' where Uber reports 'rider_canceled' — so the label
     carries the platform. Without it the bars read as five different problems. */
  if (!qy.cancels.length) {
    cx.body.append(note(k.outcome_n
      ? `None of the ${fmt(k.outcome_n)} trips whose platform reported an outcome failed to complete.`
      : 'No platform this driver works on reported how any of these trips ended, so there is nothing to break down.'));
  } else {
    hbars(cx.body, qy.cancels.map((c) => ({
      label: `${c.status.replace(/_/g, ' ')}${c.platform ? ` · ${c.platform}` : ''}`, n: c.n,
    })), { label: 'label', value: 'n', seq: true });
    cx.body.append(el('p', 'cap',
      'Raw provider strings, deliberately — what counts as “did not complete” is decided by the normalised '
      + 'outcome, but the word each platform uses for it is worth seeing.'));
  }

  ev.body.innerHTML = '';
  if (!qy.alerts.length) ev.body.append(note('No harsh-driving events on the vehicles this driver held. Attribution needs both a telematics alert and a custody record for the same day, so a gap in either shows as nothing here.'));
  else {
    ev.body.append(tableFrom(qy.alerts, [
      /* The row says which of the two it is. A table headed by a tab called
         Quality that lists Main Power Lost beside Harsh Braking, unmarked,
         reads as five things this person did — and on a car with a failing
         tracker the biggest row is the one they did not do. */
      { label: 'Event', key: 'alert_type',
        render: (r) => esc(r.alert_type)
          + (r.device === true ? ` ${pill('tracker fault', 'warn')}` : '') },
      { label: 'Count', key: 'n', num: true },
      { label: 'Most recent', key: 'latest', render: (r) => dtStr(r.latest) },
    ]));
    if (harsh.deviceN) {
      ev.body.append(el('p', 'cap',
        `${fmt(harsh.deviceN)} of these ${fmt(harsh.total)} events are the tracker reporting its `
        + 'own power loss rather than anything done at the wheel, so the tile above counts '
        + `${fmt(harsh.drivingN)} and the rate is taken over those.`));
    }
  }

  line.body.innerHTML = '';
  const cd = qy.cancel_daily.filter((d) => d.trips > 0);
  if (!cd.some((d) => d.cancelled > 0)) {
    line.body.append(note(`No cancellations on any of the ${cd.length} days this driver worked in this window.`));
  } else {
    barChart(line.body, cd.map((d) => ({
      label: `${dayStr(d.day)} · ${d.cancelled} of ${d.trips}`, cancelled: d.cancelled,
    })), { x: 'label', y: 'cancelled', color: '--s2', valueFmt: (v) => fmt(v) });
    const tot = cd.reduce((a, d) => a + d.trips, 0), cx = cd.reduce((a, d) => a + d.cancelled, 0);
    line.body.append(el('p', 'cap', `${cx} cancelled out of ${tot} requested across ${cd.length} working days.`));
  }
}

/* ── tab: trips ──────────────────────────────────────────────────────────── */
async function tabTrips(root, id) {
  const p = panel('Trip records', 'The underlying rows, newest first — every platform this driver appears on');
  root.append(p.panel); loading(p.body);
  /* A page, not a ceiling. The endpoint returns {rows, total, offset,
     truncated}, so "500 newest" can become "500 of 1,247" and the reader can
     ask for the next 500 instead of being told the rest is unreachable. */
  const PAGE = 500;
  const res0 = await qAll('/api/driver/trips', { id, limit: PAGE });
  /* Minutes computed onto the row rather than in the renderer, and that is
     not a style choice: tableFrom prunes a column whose declared key is blank
     on every row (api/public/ui.js:186), so a Minutes column keyed on
     duration_s is dropped before its renderer ever runs — which is how the
     column disappeared instead of showing the span both timestamps describe.
     Keyed on a real field, it also sorts by duration rather than by end time. */
  const rows = (res0.rows || []).map((r) => ({ ...r, minutes: tripMinutes(r) }));
  let total = res0.total ?? rows.length;
  /* What an unpriced trip is nevertheless part of — see api/driver_routes.js.
     Keyed the way each row keys itself, so a lookup either hits or misses and
     never half-matches across platforms on the same date. */
  const dayMoney = new Map();
  const addDays = (r) => (r.days || []).forEach((d) => dayMoney.set(d.platform + '|' + d.day, d));
  addDays(res0);
  /* Whether the Fare column has anything to say beyond a dash — a day that
     reports money, or one that reports why it is withholding it. A day list
     of nothing but nulls is the same absence as no day list at all. */
  const dayMoneyKnown = [...dayMoney.values()]
    .some((d) => d.earnings != null || d.grain_reason);
  p.body.innerHTML = '';
  if (!rows.length) {
    return empty(p.body, 'No trip on any channel for this driver in this window. Widen the range above '
      + '— this person may simply not have worked in it.');
  }
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="tq" type="search" placeholder="Filter by address, plate, status or product…">
    <span class="cap" id="tn"></span>`;
  p.body.append(bar);
  const host = el('div'); p.body.append(host);
  const cols = [
    { label: 'Requested', key: 'requested_at', render: (r) => tripTime(r.plate, r.requested_at) },
    { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'From', key: 'pickup_addr' },
    { label: 'To', key: 'dropoff_addr' },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    /* Read from the two timestamps the row already carries.
       ─────────────────────────────────────────────────────────────────────
       This keyed on duration_s, which nothing writes, so the column was a
       dash on every trip of every driver — under a caption saying no channel
       reports a trip's duration. The endpoint has selected ended_at all along
       (api/driver_routes.js), and requested-to-dropoff is present on 85% of
       these rows; api/public/trip.js and api/public/driverday.js both already
       derive it this way. It is not the same measure as duration_s — it
       contains the drive to the rider — and NO_DURATION now says so. */
    { label: 'Minutes', key: 'minutes', num: true, absent: NO_DURATION,
      render: (r) => (r.minutes == null ? '\u2014' : fmt(r.minutes)) },
    { label: 'Product', key: 'product' },
    { label: 'Pay', key: 'payment_type' },
    /* The pill used to be green unless the word "cancel" appeared, so Bolt's
       client_did_not_show, driver_did_not_respond and driver_rejected all
       showed as successes. The colour comes from the normalised outcome; the
       text stays the provider's own word. */
    { label: 'Status', key: 'status', render: (r) => pill(r.status || '—',
      r.outcome === 'completed' ? 'ok' : r.outcome === 'not_completed' ? 'warn' : null) },
    /* A trip with no fare is not a trip with no money.
       ──────────────────────────────────────────────────────────────────────
       This cell was an em-dash on four rows in five, because Uber's trip
       export carries no fare column — true, and the least useful true thing
       available. Uber publishes the money per driver per DAY, and the row
       already knows its own local day, so the cell can say what the trip was
       part of instead of only what it is not.

       Never divided by the day's trip count. A per-trip figure Uber has not
       stated is a figure this product must not invent, and an eight-minute
       ride and an airport run are not the same fraction of a day. The rule is
       the one sql/schema_v58.sql turns on: a figure that cannot be measured at
       this grain renders absent with a reason, and the reason here is a real
       number at the grain that does exist. */
    /* `absent` is declared only when there is nothing to put in the cell at
       all, and that is load-bearing rather than tidy. tableFrom drops a column
       whose declared key is blank in every row IF it declares `absent` — which
       is right for a Rating nothing reports, and would be exactly wrong here:
       on an Uber-only driver every `price` is null, so the column carrying the
       day's money would be pruned before its renderer ever ran and the reader
       would be told the fare is unknowable while the server was holding it.

       Keyed on `price` and not on a computed fallback, so the sort stays a
       sort on FARES. Sorting unpriced rows by their day's money would rank a
       trip from a busy day above a priced trip worth less, which is a
       different ordering wearing the same column heading. */
    { label: 'Fare', key: 'price', num: true, absent: dayMoneyKnown ? undefined : UBER_FARE,
      render: (r) => {
        if (r.price) return money(r.price, r.currency);
        const d = dayMoney.get(r.platform + '|' + r.local_day);
        const own = r.platform === 'uber'
          ? UBER_FARE_WHY
          : 'no fare is recorded on this booking';
        /* The day WAS reported, and superseded: a finer report already stated
           this money, and the server wrote the sentence saying so. */
        if (d && d.grain_reason) {
          return `<span class="ent-off" title="${esc(own)} — ${esc(d.grain_reason)}">—</span>`;
        }
        const paid = d && d.earnings != null ? +d.earnings : null;
        if (paid == null) {
          return `<span class="ent-off" title="${esc(own)}, and no statement covers this day either">—</span>`;
        }
        const n = d.trips || 1;
        /* NAMED, because it is not the same quantity as the column it sits in.
           ─────────────────────────────────────────────────────────────────
           driver_payout_day.earnings is what the platform PAID — net of its
           commission. The Fare column is the GROSS a rider was charged, and on
           Uber those differ by a quarter. This cell first read "part of AED
           326.15" under a heading saying Fare, which invites the reader to
           take a net figure for a gross one; the two words that fix it are
           "earned that day", and the tooltip says the rest.

           Two decimals, not the money() default of none. This is a figure a
           reader reconciles against a bank line, and AED 73.78 shown as
           AED 74 is a figure that can no longer be checked. */
        return `<span class="ent-off" title="${esc(own)}. What this platform does report meanwhile `
          + `is the day: it paid ${esc(money(paid, r.currency, 2))} for ${fmt(n)} `
          + `${plural(n, 'trip')} on ${esc(dateStr(r.local_day))}. That is the money AFTER the `
          + `platform's commission, so it is not this trip's fare and not a share of one — the `
          + `trips of a day are not equal, and Uber has never stated a per-trip figure.`
          + `">part of ${money(paid, r.currency, 2)} earned that day</span>`;
      } },
  ];
  const DRAW = 400;
  /* The toolbar said 500 and the table drew 400 of them, out of roughly 1,200
     the driver actually has — three different numbers, one of them stated and
     none of them the truth. Every count is over the same list now, and the
     sentence names both ceilings. */
  const draw = (list, term) => {
    host.innerHTML = '';
    /* A row opens the booking. The endpoint has always returned external_id
       and the table never used it, so the one artefact somebody wants to look
       into — "which trip was that, exactly" — was the one thing here that led
       nowhere. Clicks on the plate link still go to the vehicle. */
    host.append(tableFrom(list.slice(0, DRAW), cols,
      { sortable: true, sortId: 'dtrips', defaultSort: { key: 'requested_at', dir: 'desc' },
        onRow: (r) => { location.hash = href('trip', r.platform, r.external_id); } }));
    if (!list.length) {
      host.innerHTML = '';
      host.append(note(`No trip here matches “${term}”. That is a filter over the `
        + `${fmt(rows.length)} trips loaded on this page`
        + (rows.length < total ? `, not over all ${fmt(total)} in the window.` : '.')));
      return;
    }
    const caps = [];
    if (list.length > DRAW) caps.push(`drawing the ${fmt(DRAW)} newest of ${fmt(list.length)} matching`);
    /* Both numbers, always: how many are loaded, and how many exist. "The
       server sent the 500 newest" is true and unusable — 500 of how many? */
    if (rows.length < total) {
      caps.push(`${fmt(rows.length)} of ${fmt(total)} trips in this window are loaded`);
    }
    if (caps.length) host.append(el('p', 'cap', `${caps.join('; ')}.`));

    if (rows.length < total) {
      const more = el('button', 'btn', `Load the next ${fmt(Math.min(PAGE, total - rows.length))}`);
      more.onclick = async () => {
        more.disabled = true; more.textContent = 'Loading…';
        try {
          const next = await qAll('/api/driver/trips', { id, limit: PAGE, offset: rows.length });
          rows.push(...(next.rows || []).map((r) => ({ ...r, minutes: tripMinutes(r) })));
          addDays(next);
          total = next.total ?? total;
          const t = bar.querySelector('#tq').value.trim().toLowerCase();
          const l = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
          count(l.length); draw(l, t);
        } catch (e) {
          more.disabled = false;
          more.textContent = 'Could not load more — try again';
        }
      };
      host.append(more);
    }
  };
  const count = (n) => {
    bar.querySelector('#tn').textContent = rows.length < total
      ? `${fmt(n)} of ${fmt(rows.length)} loaded · ${fmt(total)} in this window`
      : `${fmt(n)} of ${fmt(rows.length)} trips`;
  };
  count(rows.length);
  draw(rows, '');
  bar.querySelector('#tq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
    count(list.length);
    draw(list, t);
  };
}

const TABS = { overview: tabOverview, activity: tabActivity, territory: tabTerritory,
  earnings: tabEarnings, quality: tabQuality, trips: tabTrips };

/* ── page shell ──────────────────────────────────────────────────────────── */
export async function renderDriver(root, id, tab = 'overview') {
  /* Addressed with no id — a typed URL, a stale bookmark, a link whose id
     never got filled in. It went to the endpoint and printed the API's own
     complaint. #day has always answered this properly; these four did not. */
  if (!id) return noneChosen(root, 'driver', 'drivers', 'Every driver');
  const head = el('div'); root.append(head); loading(head);
  const body = el('div', 'stack'); root.append(body);

  let prof;
  try { prof = await qAll('/api/driver/profile', { id }); }
  catch (e) {
    head.innerHTML = `<div class="empty"><b>No such driver</b>Nothing in the record matches this id.
      <a class="lnk" href="${href('drivers')}">Back to all drivers</a></div>`;
    return;
  }
  head.innerHTML = '';
  head.append(identityCard(prof));
  head.append(tabBar(DRIVER_TABS, tab, (t) => href('driver', id, t === 'overview' ? null : t)));
  /* The SPLIT between accounts, which the identity card cannot show.
     ─────────────────────────────────────────────────────────────────────────
     The card now carries the whole-person figures — trips ever, first trip,
     last trip — so a single-account driver needs nothing here: the line would
     restate the card in a longer sentence. What the card cannot say is which
     channel the work came from when there is more than one, and that is what
     changes how everything below is read. */
  const accs = (prof.accounts || []).filter((a) => a.platform);
  if (accs.length > 1) {
    const each = accs.map((a) => `${sourceLabel(a.platform)} ${fmt(a.trips)} trip${a.trips === 1 ? '' : 's'}`
      + (a.first_trip ? ` since ${dateStr(a.first_trip)}` : '')).join(' · ');
    head.append(el('p', 'cap', `This person drives on ${fmt(accs.length)} platform accounts — ${each}. `
      + 'Everything below is the combined picture.'));
  }

  /* `day` carries its date in the query string rather than in the path,
     because the router's three slots are already view/param/sub and the sub is
     the tab. It is reached by clicking a bar on Activity; typed cold with no
     date it says so rather than rendering an empty timeline. */
  if (tab === 'day') {
    const on = new URLSearchParams(location.hash.split('?')[1] || '').get('on');
    await renderDriverDay(body, id, on);
    return prof;
  }
  const fn = TABS[tab] || tabOverview;
  await fn(body, id, prof);
  return prof;
}

/* ── the directory that links into the pages above ───────────────────────── */
export async function renderDriverDirectory(root) {
  /* The verdict goes above the search box. This page was 44,399 pixels tall —
     forty-four laptop screens — and opened on a search field and a 361-row
     table, so the first thing a reader saw was an instruction to go looking
     rather than an answer. */
  const vHost = el('div'); root.append(vHost);
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="dq" type="search" placeholder="Search drivers by name, plate or platform…">
    <span class="cap" id="dn"></span>`;
  root.append(bar);
  const grid = el('div', 'dircards'); root.append(grid);
  /* "All drivers" now means all drivers. The directory was built from the trip
     table, so anyone who took nothing in the window had no row — under this
     exact heading — and 64 of the people missing that way had an expired
     licence, which is precisely who an operator opens this page to find. The
     vehicle directory beside it does the opposite on purpose and says so. */
  const tblP = panel('All drivers',
    'Everyone on the books, including people with no trip in this window — those are the ones worth '
    + 'finding. Sorted by trips; click any row for the full detail.');
  root.append(tblP.panel);
  loading(tblP.body); loading(grid);

  const rows = (await qAll('/api/drivers/directory')).map((r) => ({
    ...r,
    /* TRUE OR NOTHING, never false.
       ─────────────────────────────────────────────────────────────────────
       The Barred column declares `absent` so it prunes itself when nobody is
       barred — and tableFrom decides that on the KEY, not on the renderer
       (ui.js:187), deliberately, because that branch removes a column. The key
       was is_banned, which arrives as `false` for every driver a platform has
       answered about, and `false` is not blank. So the column counted itself
       full, survived, and rendered 392 dashes.

       bin/render-audit.mjs reported it as a dead column on production: "Barred
       is empty in all 392 rows". Stamped as true-or-null, the key now says the
       same thing the cell does. */
    barred: r.is_banned === true ? true : null,
  }));
  /* Position in the ranking the endpoint returned — busiest first — stamped on
     the row rather than counted at paint time. tableFrom re-orders the array it
     is given IN PLACE when a column header is clicked, and it is handed a
     filtered copy when the search box has text in it, so anything derived from
     indexOf() renumbers 1..n on every sort and every keystroke. A number that
     means "47th busiest of 361" has to be fixed to the person, not to the row
     they happen to be occupying. */
  rows.forEach((r, i) => { r._rank = i + 1; });
  const active = rows.filter((r) => r.active_in_window);
  const idle = rows.filter((r) => !r.active_in_window && r.ever_driven);
  const never = rows.filter((r) => !r.ever_driven);
  /* A licence date the source writes when the field was never filled in is not
     an expiry. 77 people here carry licence number 123456 and the same date,
     and this toolbar counted every one of them as illegal to drive — while
     #compliance, running the same check with the placeholder excluded, reported
     zero. Two pages of one product disagreeing about whether 77 people can
     legally work.

     Detected the way the server detects it (api/server.js): the MODAL date,
     when one date covers at least half the rows that carry one and there are
     at least five of them. Real expiries are spread across the calendar; a
     single date shared by half the roster is a default value. Computed here
     rather than only server-side so the two pages agree today, and the
     endpoint's own flag wins the moment it starts sending one. */
  const dated = rows.map((r) => String(r.licence_expires || '').slice(0, 10)).filter(Boolean);
  const tally = new Map();
  dated.forEach((d) => tally.set(d, (tally.get(d) || 0) + 1));
  const [modalDate, modalN] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const inferredPlaceholder = (modalN >= 5 && modalN >= dated.length * 0.5) ? modalDate : null;
  const placeholderRow = (r) => {
    if (r.licence_placeholder != null) return !!r.licence_placeholder;
    const d = String(r.licence_expires || '').slice(0, 10);
    if (!d) return false;
    if (r.placeholder_date) return d === String(r.placeholder_date).slice(0, 10);
    if (/^0*123456$/.test(String(r.licence_no || ''))) return true;
    return d === inferredPlaceholder;
  };
  const notFilled = rows.filter(placeholderRow);
  const expired = rows.filter((r) => r.licence_days_left != null && r.licence_days_left < 0 && !placeholderRow(r));
  const summary = (n) => `${fmt(n)} of ${fmt(rows.length)} drivers`
    + (n === rows.length
      ? ` · ${fmt(active.length)} drove in this window`
        + (idle.length ? ` · ${fmt(idle.length)} did not` : '')
        + (never.length ? ` · ${fmt(never.length)} never have` : '')
        + (expired.length ? ` · ${countOf(expired.length, 'expired licence')}` : '')
        + (notFilled.length ? ` · ${fmt(notFilled.length)} with no real licence date on file` : '')
      : '');
  bar.querySelector('#dn').textContent = summary(rows.length);

  // the top few as cards, because a leaderboard is read as a ranking
  grid.innerHTML = '';
  active.slice(0, 6).forEach((r, i) => {
    const c = el('a', 'dircard');
    c.href = href('driver', r.driver_ext_id);
    c.innerHTML = `
      <div class="rank">${i + 1}</div>
      ${avatar(r.driver_name, r.picture_url, 'sm')}
      <div class="dc-meta">
        <b title="${esc(r.driver_name)}">${esc(r.driver_name)}</b>
        <div class="cap">${(r.platforms || []).map(sourceLabel).join(' · ')}${r.plate ? ' · ' + esc(r.plate) : ''}</div>
      </div>
      <div class="dc-n"><span class="num">${fmt(r.trips)}</span><small>trips</small></div>`;
    grid.append(c);
  });

  /* A person's STANDING, from the platform's own roster. 24 to 28 people here
     are suspended or deactivated and the directory rendered them as "no trip"
     — indistinguishable from somebody on leave, on the page an operator opens
     to find the ones not earning. */
  const STATE_TONE = (s) => (/suspend|deact|block|reject/i.test(s || '') ? 'bad'
    : /waitlist|onboard|pending|applied/i.test(s || '') ? 'warn' : 'ok');
  const anyFleet = rows.some((r) => r.fleet_id);
  const anyState = rows.some((r) => r.platform_state || r.can_earn != null);
  const anyLifetime = rows.some((r) => r.lifetime_trips != null);
  const cols = [
    /* The NAME first, with the rank inside it.
       ─────────────────────────────────────────────────────────────────────
       This table scrolls sideways on anything narrower than a laptop, and the
       first column is the one that stays pinned — so with `#` leading, a phone
       showed a frozen column of 1, 2, 3 while the person each row is about
       scrolled away behind three narrow columns. Every number on screen and
       nobody's name against any of it.

       The rank goes in the same cell rather than into its own: it is a
       property of the row's position, not a fact about the driver, and it
       costs a pinned column's width to say what a reader can count. */
    { label: 'Driver', key: 'driver_name',
      render: (r) => `<span class="rk" title="${fmt(r._rank)} of ${fmt(rows.length)} by trips in this window">${fmt(r._rank)}</span>`
        + entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'In this window', key: '_a',
      sortValue: (r) => (r.active_in_window ? 2 : r.ever_driven ? 1 : 0),
      render: (r) => (r.active_in_window
        ? pill('drove', 'ok')
        : r.ever_driven ? pill('no trip', 'warn') : pill('never driven', 'bad')) },
    ...(anyState ? [{ label: 'Standing', key: 'platform_state',
      render: (r) => (r.platform_state
        ? pill(r.platform_state, STATE_TONE(r.platform_state))
        : (r.can_earn === false
          ? pill('cannot earn', 'bad')
          : '<span class="ent-off" title="no platform published a standing for this person">not reported</span>')) }] : []),
    // On a two-fleet operator, which fleet. It is on every row and was drawn
    // nowhere.
    /* These three are IDENTITY, and the endpoint now answers them over the
       whole history when the window has nothing to say — 244 of 361 rows on
       production carried a name and three blanks, one of them belonging to a
       driver with 2,393 trips on record. `identity_from_history` marks those,
       so the page can show the fact and still be honest that it is not a
       measurement of the range on screen. */
    /* Uber's own rating, which this column was always meant to show.
       ─────────────────────────────────────────────────────────────────────
       It read driver_compliance.rating — the hotel channel's document
       register, which has never carried one — so the column was 365 dashes
       under a sentence blaming the channels. Uber answers recognitionRating on
       GetDriver and the collector now asks. The tag names whose rating it is,
       because two platforms rating the same human are two opinions on two
       scales and this column shows one of them.

       Placed beside Standing rather than after the money, and that is not
       cosmetic: this table is twenty columns wide and scrolls, so a column's
       position decides whether it is read. Rating and Barred are facts about
       the PERSON, like Standing and Fleet; the money columns are facts about
       the window. Shipped after the money, both sat off-screen at 1500px —
       found on production, which is the only place a twenty-column table tells
       the truth about itself. */
    { label: 'Rating', key: 'platform_rating', num: true,
      absent: 'no platform has answered for anybody yet. Uber publishes a rating and is asked for one '
        + 'every Monday; Bolt publishes one too and its roster call is currently refused \u2014 '
        + 'Collection gaps says which credential. This column read the hotel channel\u2019s document '
        + 'register until today, which has never carried a rating at all',
      render: (r) => (r.platform_rating != null
        ? `${fmt(r.platform_rating, 2)}`
          + (r.platform_lifetime_trips
            ? `<span class="dim" title="trips the platform has ever recorded for them"> \u00b7 ${fmt(r.platform_lifetime_trips)}</span>`
            : '')
        : '<span class="ent-off" title="not yet collected for this driver">\u2014</span>') },
    /* A ban is a harder constraint than a state of inactive, and it is the one
       fact here that changes what an operator does today. Shown only where it
       is true: a column of "no" on 360 people is not information. */
    { label: 'Barred', key: 'barred', num: false,
      absent: 'no platform has barred anybody in this window',
      render: (r) => (r.is_banned === true
        ? '<span class="tag bad" title="the platform has barred this driver">barred</span>'
        : '\u2014') },
    ...(anyFleet ? [{ label: 'Fleet', key: 'fleet_id',
      render: (r) => (r.fleet_id
        ? pill(sourceLabel(r.fleet_id), r.identity_from_history ? 'dim' : 'plat')
        : '<span class="ent-off" title="no trip of theirs names a fleet">—</span>') }] : []),
    { label: 'Platforms', key: '_p',
      render: (r) => (r.platforms || []).map((p) => pill(sourceLabel(p),
        r.identity_from_history ? 'dim' : 'plat')).join('') },
    { label: 'Usual vehicle', key: 'plate',
      render: (r) => (r.plate == null ? ''
        : r.identity_from_history
          ? `<span class="dim" title="their last vehicle — they took no booking in this window">${
            entity('vehicle', r.plate, r.plate)}</span>`
          : entity('vehicle', r.plate, r.plate)) },
    { label: 'Trips', key: 'trips', num: true, render: (r) => fmt(r.trips) },
    ...(anyLifetime ? [{ label: 'Trips ever', key: 'lifetime_trips', num: true,
      render: (r) => (r.lifetime_trips == null
        ? '<span class="ent-off" title="we hold no trip history for this person’s platforms">not observed</span>'
        : fmt(r.lifetime_trips)) }] : []),
    { label: 'Completed', key: 'completed', num: true,
      render: (r) => (r.completed == null
        ? '<span class="ent-off" title="no platform of theirs reports an outcome">—</span>'
        : fmt(r.completed)) },
    { label: 'Days', key: 'days', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    /* The one money column that answers for everybody, and the reason the two
       beside it are not enough on their own.
       ─────────────────────────────────────────────────────────────────────
       Measured on the live roster: of 119 active drivers, 44 have a fare and
       96 have a payout. Between them nobody is missing — and they are not the
       same 44 and 96, and a fare and a payout are not the same quantity. So a
       reader sorting this table by money was comparing what a rider paid for
       one person against what the platform paid us for the next.

       driver_day.money is the resolution this fleet already makes everywhere
       else: per platform, the statement's net where a channel filed one and
       its fares where it did not. The tag says which, and whether the figure
       is a measurement or a share of a longer statement — Uber files this
       fleet weekly, so most of it is a week divided across its days, right at
       the week and allocated at the day. */
    { label: 'Money', key: 'money', num: true,
      absent: 'no channel reported either a statement or a fare for anybody in this window',
      render: (r) => {
        if (r.money == null) {
          return r.trips
            ? '<span class="ent-off" title="this person drove in this window and no channel has reported money for it \u2014 see Reconciliation">\u2014</span>'
            : '<span class="ent-off" title="no trips in this window">\u2014</span>';
        }
        const n = r.money_period_days;
        const tag = n == null ? 'grain?' : n > 1 ? `1/${n}` : (r.money_source || 'day');
        const why = n == null
          ? 'part of this comes from a statement that does not record the period it covered'
          : n > 1
            ? `mostly ${n}-day statements divided across their days \u2014 right for the period, `
              + 'not measured on any one day inside it'
            : r.money_source === 'fares'
              ? 'the channels priced these bookings'
              : r.money_source === 'mixed'
                ? 'one channel filed statements and another reported only fares'
                : 'filed per day by the channel';
        return money(r.money)
          + `<span class="dim" title="${esc(why)}"> \u00b7 ${esc(tag)}</span>`;
      } },
    /* PAID, not FARED. This column was sum(trip.price) and Uber's export has no
       fare column, so on a seven-day window 101 people drove and 21 had a
       number here — eighty rows of dashes in the only money column a table
       whose whole job is ranking people had. The money was never missing; it
       is a payout, not a fare, and it lives in driver_payout_day.

       Fares stay, as a second line, because on the hotel channel they are what
       the property was charged and that is a different and real quantity. When
       a driver has both, both are shown; the dash now means what it says. */
    { label: 'Paid', key: 'payout', num: true,
      render: (r) => (r.payout
        ? `${money(r.payout)}${r.payout_days
          ? `<span class="dim" title="days inside this window that a payout statement covers"> · ${fmt(r.payout_days)}d</span>` : ''}`
        : (r.trips
          ? '<span class="ent-off" title="this person drove in this window but no payout statement reaches them — see Reconciliation">—</span>'
          : '<span class="ent-off" title="no trips in this window">—</span>')) },
    { label: 'Fares', key: 'revenue', num: true, absent: UBER_FARE,
      render: (r) => (r.revenue
        ? `${money(r.revenue)}${r.priced_trips != null
          ? `<span class="dim" title="bookings of theirs that report a fare"> · ${fmt(r.priced_trips)}</span>` : ''}`
        : `<span class="ent-off" title="${UBER_FARE_WHY}. Until this week is collected the money for it is in Paid">—</span>`) },
    { label: 'Completion', key: 'completion_pct', num: true, render: (r) => (r.completion_pct != null ? pct(r.completion_pct) : '—') },
    /* Measured on the live fleet: rating is null for all 360 people, because
       nothing in the collector writes it — Uber's roster endpoint returns
       onboarding status and a vehicle, not a score, and the earnings breakdown
       returns trips, distance and money. So on production this column is 360
       em-dashes wide, and `absent` turns it into one sentence under the table
       instead. On a database where some channel DOES report one, the column
       comes back on its own. */
    { label: 'First trip', key: 'first_trip',
      render: (r) => (r.first_trip ? dateStr(r.first_trip)
        : '<span class="ent-off">never</span>') },
    /* dayStr has no year, and this dashboard offers a 12-month window: "21 Oct"
       and "21 Aug" sat side by side with nothing to say which year, so a driver
       who last drove ten months ago read as current. The lifetime last trip is
       shown when there is none in the window, because that is the number that
       answers "is this person still with us". */
    { label: 'Last trip', key: 'last_trip',
      sortValue: (r) => (r.last_trip || r.last_ever ? Date.parse(r.last_trip || r.last_ever) : null),
      render: (r) => {
        const v = r.last_trip || r.last_ever;
        if (!v) return '<span class="ent-off">never</span>';
        const ago = Math.floor((Date.now() - Date.parse(v)) / 864e5);
        return `${dateStr(v)} <small class="dim">${fmt(ago)}d ago</small>`;
      } },
    /* A grey pill, not a red one. The 77 rows carrying the source's default
       date were painted EXPIRED, which accuses somebody of driving illegally
       on the strength of a field nobody filled in. */
    { label: 'Licence', key: 'licence_days_left', num: true,
      sortValue: (r) => (placeholderRow(r) ? null : r.licence_days_left),
      render: (r) => {
        if (placeholderRow(r)) {
          return '<span class="pill" title="this source writes a default date with licence number 123456 '
            + 'when the field was never filled in — a gap in the record, not an expiry">not filled in</span>';
        }
        if (r.licence_days_left == null) {
          return '<span class="ent-off" title="this person’s platforms publish no licence expiry">—</span>';
        }
        return pill(r.licence_days_left < 0 ? 'expired' : `${r.licence_days_left}d`,
          r.licence_days_left < 0 ? 'bad' : r.licence_days_left < 30 ? 'warn' : 'ok');
      } },
  ];
  const draw = (list, term) => {
    tblP.body.innerHTML = '';
    if (!list.length) {
      /* Names the search, not the date range. "No data for this range yet" on
         a search with no match blames the window for a typo. */
      tblP.body.append(note(`No driver matches “${term}”. Searching name, plate and platform across the `
        + `${fmt(rows.length)} people on the books — everyone is loaded, so this is the whole roster and `
        + 'not a page of it.'));
      return;
    }
    const tbl = tableFrom(list, cols, {
      sortable: true, sortId: 'dir', defaultSort: { key: 'trips', dir: 'desc' },
      onRow: (r) => { location.hash = href('driver', r.driver_ext_id); },
    });
    /* Folded, not truncated. Every row is still built and still sortable — the
       fold decides what is on screen at rest, and the control says exactly how
       many it is holding back. A search narrows the list, so a filtered result
       shorter than the fold simply has no control. */
    foldRows(tblP.body, tbl, { shown: 12, total: list.length, noun: 'driver', key: 'drivers-dir' });
  };
  /* ── the verdict ────────────────────────────────────────────────────────
     Chosen by what is worst, not by a fixed sentence. The question an operator
     opens this page with is "who is on the books and not earning" — that is
     what the 125 idle and 120 never-driven rows are, and they were previously
     findable only by scrolling past everyone who IS working. */
  {
    const v = driversVerdict({ rows, expired, idle, never, notFilled });
    let claim, figure, unit, recommend = null;
    if (v.branch === 'expired') {
      claim = `${countOf(v.expired, 'driver')} cannot legally work — the licence has expired`;
      figure = fmt(v.expired); unit = 'expired';
      recommend = 'Sort by Licence to bring them together, or open Compliance, which counts the same '
        + 'people the same way and shows every document with a date on it.';
    } else if (v.branch === 'idle') {
      claim = `${v.idlePct}% of the people on the books did not drive in this window`;
      figure = fmt(v.notEarning); unit = 'not earning';
      recommend = v.blocked
        ? `${countOf(v.blocked, 'person', 'people')} of them are suspended or deactivated on the platform, `
          + 'which is a different problem from somebody on leave — sort by Standing to separate them.'
        : 'Sort by Standing to separate people the platform has blocked from people simply not rostered.';
    } else {
      claim = `${fmt(v.active)} of ${fmt(v.total)} drivers worked this window`;
      figure = fmt(v.active); unit = 'drove';
    }
    verdict(vHost, {
      claim, figure, unit, tone: v.tone, recommend,
      meta: `${fmt(v.total)} on the books`,
      sub: `${fmt(v.active)} drove, ${fmt(v.idle)} did not, ${fmt(v.never)} never have.`
        + (v.notFilled ? ` ${fmt(v.notFilled)} carry no real licence date, so they are not counted as expired.` : ''),
    });
  }

  draw(rows, '');
  bar.querySelector('#dq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => `${r.driver_name} ${r.plate} ${(r.platforms || []).join(' ')}`.toLowerCase().includes(t)) : rows;
    bar.querySelector('#dn').textContent = summary(list.length);
    draw(list, t);
  };
  if (notFilled.length) {
    tblP.panel.append(note(`${countOf(notFilled.length, 'person', 'people')} here carry `
      + (inferredPlaceholder
        ? `${dateStr(`${inferredPlaceholder}T12:00:00`)} as their licence expiry — one date shared by `
          + `${Math.round((modalN / Math.max(1, dated.length)) * 100)}% of everybody who has one, which is `
          + 'a field nobody filled in rather than a fleet that all expires on the same day. '
        : 'the source\'s default licence date rather than a real one. ')
      + 'They are marked "not filled in" and are NOT counted as expired — the Compliance page counts '
      + 'them the same way, so the two agree.', 'warn'));
  }
  return rows;
}
