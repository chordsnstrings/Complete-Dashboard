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
     #driver/<id>/record     record     — their own week-by-week and month-by-month
     #driver/<id>/trips      trips      — the underlying records

   Every panel here answers over *all* of a person's platform accounts, because
   the server folds Uber/Yango/Bolt ids that share a name into one identity. */

import { barChart, gapBars, areaChart, donut, hbars, heatmap, empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note, entity,
  dayStr, dateStr, dtStr, timeStr, hourStr, money, pct, fmt, tripTime,
  sourceLabel, completionTone, plural, countOf, signed, UBER_FARE, UBER_HOURS, NO_DURATION, noneChosen, verdict, foldRows,
  avatar, moneyInTile, cashOnHandTile, bankDepositTile, faresTile,
  alertRateFigure, splitAlerts, standingNote,
  UBER_FARE_WHY, dialable } from './ui.js';
/* personAddr/personIdOf/rewriteParam: the person id as an address, and the
   in-place rewrite that leaves the reader holding the canonical one. See the
   block above rewriteParam in data.js — the rewrite must not be a navigation,
   and it must not rebuild the query string, because #driver/<id>/day carries
   the replayed day in it. */
import { qAll, href, currentGen, alive, windowLabel,
  personAddr, personIdOf, rewriteParam } from './data.js';
import { driversVerdict } from './verdicts.js';
import { renderDriverDay } from './driverday.js';
/* One driver against their own record, week by week and month by month. Its
   own module for the same reason driverday.js is: this file is already the
   longest view in the product. */
import { renderDriverRecord } from './driverrecord.js';
/* The operator's sixth requirement: "All advance repayment will be logged into
   the system in the drivers page preferrably in a new tab within the driver
   profile page". Its own module, like record and day, because this file is
   already the longest view in the product. */
import { renderDriverLedger } from './driverledger.js';

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
  /* Between Quality and Trips deliberately. Record is a reading of the same
     person over time rather than a new subject, so it sits after the panels
     that describe them and before the raw rows that evidence them. */
  { id: 'record', label: 'Record', ic: '◲' },
  /* AFTER RECORD AND BEFORE TRIPS. Money is a reading of this person, like
     Record, rather than a new subject — and it is read against what the tabs
     before it say they earned. It sits ahead of Trips for the same reason
     Record does: the raw rows evidence the readings, they are not one. */
  { id: 'money', label: 'Money', ic: '⊛' },
  { id: 'trips', label: 'Trips', ic: '▤' },
  /* LAST, and after Trips deliberately. Every tab before this one is built
     from records that NAME this person — a booking carries a driver id and the
     row is a fact. This one is built from journeys no booking explains, so
     every name on it is an inference drawn from the time and the custody
     record. It sits at the end because it is read after the record, against
     the record.

     Labelled "Unexplained trips" and not "Unauthorized": api/public/app.js
     setHeader() prints `${tab.label} — every platform this person works on,
     combined` as the page subtitle, and a label of "Unauthorized" makes that
     sentence read as a verdict on the PERSON rather than on the journeys. The
     journeys are unexplained; nobody on this page has been found to have done
     anything. */
  { id: 'unauthorized', label: 'Unexplained trips', ic: '◌' },
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
/* And never the word the label already said. The unit exists to disambiguate a
   bare number, so "Bookings (bookings)" disambiguates nothing — and at 1440px
   the longer one clipped to "Bookings a working day (b…", an ellipsis earned
   by a word the row had already used. Both appeared the moment the trips row
   was renamed from "Trips completed" to what it actually counts. */
const unitFor = (m) => {
  const l = String(m.label || '').toLowerCase();
  const u = m.unit || Object.entries(METRIC_UNIT).find(([k]) => l.includes(k))?.[1] || '';
  return u && l.includes(String(u).toLowerCase()) ? '' : u;
};

function percentileBars(host, metrics, opts = {}) {
  host.innerHTML = '';
  if (!metrics.length) return empty(host);
  const wrap = el('div', 'pbars');
  metrics.forEach((m, i) => {
    const p = Math.max(0, Math.min(100, m.percentile));
    /* A TIE IS NOT A RANK, AND IT IS CERTAINLY NOT A FAILING.
       On a one-day window nearly everybody has days_worked 1, so nobody is
       below anybody, so the percentile floors to 0 for the whole tied
       majority — and this line painted every one of them --critical for a
       value equal to the fleet median. Measured on production 2026-09-06: two
       of five drivers sampled, "Days worked 1, fleet median 1", in the colour
       reserved for the worst thing on the page. standingNote in ui.js knows
       the size of the tie because the endpoint now returns it; a tied bar gets
       the neutral fill and says so on hover. */
    const sn = standingNote(m);
    const tone = sn.tied ? '--s1'
      : p >= 75 ? '--good' : p >= 40 ? '--s1' : p >= 20 ? '--warn' : '--critical';
    const u = unitFor(m);
    const inverted = m.higher_is_better === false || /cancel|reject|no.?show/i.test(m.label || '');
    const row = el('div', 'pbar');
    row.innerHTML = `
      <div class="pb-l">${esc(m.label)}${u ? `<span class="dim"> (${esc(u)})</span>` : ''}</div>
      <div class="pb-track">
        <i style="width:${p}%;background:var(${tone});animation-delay:${i * 55}ms"></i>
        <span class="pb-mid" title="fleet median"></span>
      </div>
      <div class="pb-v num">${sn.tied ? '<small>tied</small>' : `${p}<small>${ordinal(p)}</small>`}</div>`;
    /* Assembled as sentences and joined, not concatenated with leading full
       stops: three optional clauses each carrying its own '.' produced
       "Bottom 8%.. Lower is better here" on the cancellation row. */
    row.title = [
      `${m.label}: ${fmt(m.value, 1)}${u ? ' ' + u : ''} — fleet median `
        + `${fmt(m.median, 1)}${u ? ' ' + u : ''}.`,
      sn.tied
        ? `${fmt(m.tied)} of the ${fmt(m.population)} compared hold this same value, so the `
          + 'percentile is a tie rather than a rank.'
        : sn.text ? `${sn.text[0].toUpperCase()}${sn.text.slice(1)}.` : '',
      inverted ? 'Lower is better here, so a high percentile means FEWER of them.' : '',
      opts.note && /revenue|fare|earn/i.test(m.label || '') ? opts.note : '',
    ].filter(Boolean).join(' ');
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
  /* A PATTERN NOBODY MEASURED, PLOTTED ON THE TAB THE PAGE OPENS ON.
     ═══════════════════════════════════════════════════════════════════════
     The filter was `Number.isFinite(+d.first_hour)`. `+null` is 0 and
     Number.isFinite(0) is true, so every day carrying NO first trip passed it
     and was plotted at midnight.

     MEASURED on production for e3cd308b2b5f48e19877b924b48bbb9d over
     2026-09-01..09-16: /api/driver/daily returns 13 rows, trips 0 and
     first_hour null on all 13. All 13 passed this guard. The Overview tab drew
     thirteen dots along the 00:00 line, computed a quartile band from thirteen
     zeros, and captioned it "the middle half of start times (00:00–00:00). Each
     dot is one working day" — under a DAYS WORKED tile reading 0. Every tooltip
     read "first trip 00:00 · 0 trips".

     That is worse than a zero in a money column: a zero is one wrong figure,
     and this is a fabricated shift pattern for a man who did not work. It is
     the same Number(null) === 0 trap ui.js:moneyParts already documents by
     name; this is that trap landed.

     Null-tested BEFORE the coercion, and the two absences are told apart
     underneath: a driver with one working day has too little to show a pattern,
     and a driver whose days carry no start time at all has nothing measured. */
  const pts = days.filter((d) => d.first_hour != null && Number.isFinite(+d.first_hour))
    .map((d) => ({ ...d, first_hour: +d.first_hour }));
  if (pts.length < 2) {
    const worked = days.filter((d) => +d.trips > 0).length;
    /* note(), not empty(). charts.js:empty() prints a bold "NOTHING TO SHOW"
       above whatever message it is given, and on a tab where every other panel
       now states its reason as a plain sentence this one read as a different
       and worse failure — the heading is the generic line the rest of the page
       has just stopped printing. The reason is the whole answer. */
    host.append(note(!days.length
      ? 'No day in this window reached this driver, so there is no start time to plot.'
      : !pts.length
        ? (worked
          ? `No day this driver worked in this window records the hour of their first trip, so there `
            + 'is no pattern to draw. Plotting them would put every day at midnight, which is a shift '
            + 'nobody observed.'
          : 'This driver worked no day in this window, so there is no first trip to plot. The days '
            + 'held here are dates a feed reached with nothing on them.')
        : 'Only one day in this window records a first trip, which is a point rather than a pattern.'));
    return;
  }
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
    svg.push(`<text x="4" y="${Y(h) + 4}" font-size="10" fill="var(--grey)">${String(h).padStart(2, '0')}:00</text>`);
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
  svg.push(`<text x="${P.l}" y="${H - 8}" font-size="10" fill="var(--grey)">${dayStr(pts[0].day)}</text>`);
  svg.push(`<text x="${W - P.r}" y="${H - 8}" font-size="10" fill="var(--grey)" text-anchor="end">${dayStr(pts[pts.length - 1].day)}</text>`);
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
      /* The delta is real — it is the difference between two figures the
         platform published, and on the driver in this defect both readings are
         4.97 — but "over 7 days" left out the fact that makes a nought delta
         readable: the platform's own rated-trip counter did not move between
         the two readings, so nothing happened that could have shifted it.

         NOT "no trip of theirs": `over_trips` is the difference between the
         platform's lifetime trip counts on the two rating rows
         (api/driver_routes.js), which is the population the RATING is taken
         over and not this person's work. MEASURED on production for
         68e368e3ff76a73626e0720e, who did 96 trips in this window: Uber's
         counter reads 792 on all five readings, so over_trips is 0 while the
         fleet recorded 96 bookings across three channels. The sentence names
         the counter, because that is the thing that did not move. A measured 0
         is stated; a missing over_trips is not. */
      : `over ${countOf(c.over_days, 'day')}`
        + (c.over_trips ? ` and ${fmt(c.over_trips)} trips`
          : c.over_trips === 0
            ? ', in which the platform added no trip to the count this rating is taken over' : '')
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
    svg.push(`<text x="2" y="${Y(v) + 4}" font-size="10" fill="var(--grey)">${v.toFixed(0)}h</text>`);
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

/* ── IS THIS PERSON ONLINE RIGHT NOW ──────────────────────────────────────
   The operator's question, from a FleetHub screenshot: a driver Uber reports
   as online for five hours, reading as nothing here. The status was arriving
   every two minutes all along and being discarded — sql/schema_v70.sql carries
   the measurement — and this is where it surfaces, at the top of the page
   about that person.

   Three things on the strip and all three are needed. WHAT the status is;
   WHEN the provider says it changed, because "online" without "since 06:14" is
   not actionable; and when the FEED last answered, because a status read off a
   dead feed looks exactly like a live one and is a claim about the past. */
function statusStrip(st) {
  const box = el('div', 'lstat');
  /* `!st.status` as well as `st.absent`, and not only because the endpoint now
     always sets one alongside the other. The last rung of the word ladder
     below is "Offline", so ANY future shape that reaches it without a status
     prints a confident claim about a driver nobody has measured — the failure
     found on production the hour this shipped, when 66 of 158 rows came back
     with a row present and no status. Two guards for one fact, deliberately:
     this is the branch where being wrong is silent. */
  if (!st || st.absent || !st.status) {
    box.classList.add('off');
    box.innerHTML = `<span class="lstat-dot"></span><b>No live status</b>`;
    box.append(el('span', 'lstat-why', st?.absent
      || 'Uber is the only channel that reports one to this fleet.'));
    /* Even with no status of their own, the day may hold events — and if it
       does, saying nothing about them would be its own small lie. */
    if (st?.today?.online_minutes) {
      const h = Math.floor(st.today.online_minutes / 60), m = st.today.online_minutes % 60;
      box.append(el('span', 'lstat-sum',
        `${h}h ${String(m).padStart(2, '0')}m online earlier today`));
    }
    return box;
  }
  const tone = st.stale ? 'stale' : st.status === 'ontrip' ? 'ontrip'
    : st.status === 'online' ? 'on' : 'off';
  box.classList.add(tone);
  const word = st.status === 'ontrip' ? 'On a trip'
    : st.status === 'online' ? 'Online' : 'Offline';
  box.innerHTML = `<span class="lstat-dot"></span><b>${esc(word)}</b>`;
  /* SINCE, not AT. The provider gives the instant the status changed, so the
     honest phrasing is a duration with the clock time behind it. */
  if (st.status_at) {
    box.append(el('span', 'lstat-since', `since ${timeStr(st.status_at)}`));
  }
  const t = st.today || {};
  if (t.online_minutes) {
    const h = Math.floor(t.online_minutes / 60), m = t.online_minutes % 60;
    /* "online today" only where the record covers today. Where it starts
       part-way through, the same page was carrying this figure beside the
       availability feed's larger one for the same driver and the same day,
       both unqualified — so the shorter one has to say what it is measured
       over, or it reads as a contradiction of the longer one. */
    box.append(el('span', 'lstat-sum',
      `${h}h ${String(m).padStart(2, '0')}m online ${t.partial ? `since ${t.online_since_local || 'the feed began'}` : 'today'}`
      + (t.on_trip_minutes ? ` · ${Math.round(t.on_trip_minutes / 60 * 10) / 10}h on trips` : '')
      + (t.online_since_local && !t.partial ? ` · from ${t.online_since_local}` : '')));
    if (t.partial_why) box.append(el('span', 'lstat-why', t.partial_why));
  } else if (t.absent) {
    box.append(el('span', 'lstat-why', t.absent));
  }
  /* The staleness sentence is never optional when it applies: this is the one
     line that stops a reader acting on a status the feed stopped confirming. */
  if (st.stale && st.stale_why) box.append(el('span', 'lstat-why', st.stale_why));
  return box;
}

/* THE WHOLE-PERSON FIGURES, DERIVED IN EXACTLY ONE PLACE.
   ──────────────────────────────────────────────────────────────────────────
   /api/driver/profile answers with TWO spans — `span` is the window on the
   toolbar and `accounts[].trips` is everything on record — and three things now
   read the second one: the identity card, the empty-window banner under the tab
   bar, and the Earnings tab's coverage fraction. They were about to be three
   copies of the same four lines.

   That matters here more than it usually would. The banner's whole content is
   "this person has 1,203 trips and none of them is in this window"; if it
   derived `lastEver` differently from the card six inches above it, the page
   would print two different dates for the same person's last trip and the
   reader would have no way to tell which one to believe. One derivation is the
   only way the card and the banner cannot disagree.

   `accounts` is deliberately the MAX of three lists, not the length of one: a
   driver with a Bolt account and no Bolt trip has an entry in `platforms` and
   none in `accounts`, and the card has printed "ACCOUNTS 0" beside a Bolt pill
   for exactly that reason before. */
/** The address this page should LINK by: the person id where the spine has
 *  placed the account, the provider account id where it has not. Never the
 *  thing to ASK an endpoint about — see renderDriver's header for why the two
 *  are kept apart. */
export const addressOf = (prof, accountId) =>
  (prof?.person_id != null ? personAddr(prof.person_id) : accountId);

export function personRecord(p) {
  const accs = p?.accounts || [];
  const dates = (k) => accs.map((a) => a[k]).filter(Boolean).sort();
  return {
    /* `|| null` rather than `|| 0`: a person whose accounts report no trip at
       all has no lifetime count to print, and 0 here is the absence, not a
       measurement of nought. The card renders this only when truthy. */
    evTrips: accs.reduce((a, x) => a + (+x.trips || 0), 0) || null,
    firstEver: dates('first_trip')[0] || p?.span?.first_trip || null,
    lastEver: dates('last_trip').pop() || p?.span?.last_trip || null,
    accountsWithTrips: accs.length,
    accounts: Math.max(accs.length, (p?.ids || []).length, (p?.platforms || []).length),
  };
}

function identityCard(p) {
  const c = p.compliance?.[0] || {};
  /* The identity documents the API refused to send, and — separately — whether
     this person's record actually HOLDS one. Both facts are needed: the two
     lines below render only when their value is truthy, so a withheld number
     would simply vanish from the card, which is the one thing this product is
     not allowed to do with a value it has. `identity_held` is counted on the
     server before the values are dropped, so "withheld" is printed for a
     person who has papers on file and nothing at all for a person whose
     channel never filed any — the same two states the row rendered before. */
  const idWithheld = new Set(p.identity_withheld || []);
  const idHeld = new Set(p.identity_held || []);
  const idNote = esc(p.identity_withheld_reason || 'withheld from an unauthenticated response');
  const idFact = (col, label) => (idWithheld.has(col)
    ? (idHeld.has(col)
      ? `<span><b>${label}</b> <span class="dim" title="${idNote}">withheld</span></span>`
      : '')
    : (c[col] ? `<span><b>${label}</b> ${esc(c[col])}</span>` : ''));
  const wrap = el('div', 'idcard');
  /* WHAT HR FILES FOR THIS PERSON — the operator's decision, 2026-09-23: this
     page shows the Emirates ID number, the UAE driving licence number and the
     licence expiry, HR's date first. /api/driver/profile is the only route
     that returns the two numbers (api/redact.js, HR_NUMBERS_SERVED). Where HR
     supplies a number, the compliance record's "withheld" line for the same
     document is not printed beside it: two lines about one document, one
     saying withheld and one showing it, read as a contradiction. */
  const hr = p.hr || null;
  const L = p.licence || null;
  const hrLeads = L && L.source === 'hr';
  const lic = hrLeads ? L.days_left : c.licence_days_left;
  const placeholder = !hrLeads && isPlaceholderLicence(c);
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
  const { evTrips, firstEver, lastEver } = personRecord(p);

  /* WHO THIS PAGE IS, AND WHICH RECORDS IT FOLDS.
     ═══════════════════════════════════════════════════════════════════════
     Until now this card named a person and listed the CHANNELS they work on,
     and the page itself was addressed by one of their provider account ids —
     `#driver/64686123-8389-4a9e-82f1-0287e936239b`. So the one identity that
     does not move (the person id, which driver_ledger already keys money on)
     appeared nowhere on the page about that person, and the one that does
     move was the address in the reader's bookmark.

     Measured on production 2026-09-21: 810 platform accounts over ~349
     people. Which account represents somebody is decided by the spine and
     changes when a merge is reviewed or undone; a reader looking at this card
     had no way to see that the page they were on folds three records, which
     three, or under which id to file the person in a message to somebody
     else. Both facts go here, in the card that already exists, rather than in
     a second card beside it saying a different half of the same thing.

     THE ABSENCE IS A SENTENCE, NOT A BLANK. An account the spine has not
     placed renders exactly the page it always did — it has trips, money and a
     licence that expires — and says which of the three not-placed states it
     is in, in the server's own words (see api/driver_routes.js, which is
     where the distinction is known). A card that simply omitted the line
     would leave a reader unable to tell an unreviewed account from a failed
     read from a register that has never been built. */
  const pid = p.person_id ?? null;
  const pAccounts = p.person_accounts || [];
  /* A UUID is 36 characters and three of them would wrap the header onto four
     lines. The whole id is on the pill's title, and the pill is a label rather
     than a thing to copy — the address bar carries the id worth copying. */
  const shortId = (x) => (String(x || '').length > 14 ? `${String(x).slice(0, 8)}…` : String(x || ''));
  const accountPills = pAccounts.map((a) => pill(
    `${sourceLabel(a.platform)} ${shortId(a.ext_id)}`,
    a.asked ? 'plat' : null,
    `${sourceLabel(a.platform)} account ${a.ext_id}`
    + (a.display_name ? ` — filed as ${a.display_name}` : '')
    + (a.basis ? ` · joined to this person by ${a.basis}` : '')
    + (a.asked ? ' · this is the account the address named' : ''))).join('');

  wrap.innerHTML = `
    ${avatar(p.name, c.picture_url, '', c.photo_absent_reason)}
    <div class="idmeta">
      <h2>${esc(p.name || 'Unnamed driver')}</h2>
      <div class="idsub">
        ${(p.platforms || []).map((x) => pill(sourceLabel(x), 'plat')).join('')}
        ${p.span?.fleet_id ? pill(p.span.fleet_id, 'plat') : ''}
        ${c.state ? pill(c.state, c.state === 'active' ? 'ok' : 'warn') : ''}
        ${placeholder
    ? '<span class="pill" title="This source writes 2026-01-01 with licence number 123456 when the field was never filled in. It is a gap in the record, not an expiry.">licence date not filled in</span>'
    : lic != null ? pill(`licence ${lic < 0 ? `expired ${Math.abs(lic)}d ago` : `${lic}d left`}${hrLeads ? ' · HR' : ''}`, licTone,
      hrLeads ? 'HR’s roster date — it leads wherever HR has one' : null) : ''}
        ${hrLeads && L.disagree && L.platform ? pill(`${sourceLabel(L.platform.platform)} says ${dateStr(L.platform.expires)}`, 'warn',
    `HR files ${L.expires}; ${sourceLabel(L.platform.platform)} files ${L.platform.expires}. HR’s date is the one counted — the other is kept here, not dropped.`) : ''}
      </div>
      <div class="idfacts">
        ${c.phone ? `<span><b>Phone</b> <a class="lnk" href="tel:${esc(dialable(c.phone))}">${esc(dialable(c.phone))}</a></span>` : ''}
        ${c.email ? `<span><b>Email</b> <a class="lnk" href="mailto:${esc(c.email)}">${esc(c.email)}</a></span>` : ''}
        ${hr?.emirates_id ? `<span data-hr="emirates_id"><b>Emirates ID</b> <span class="mono">${esc(hr.emirates_id)}</span><span class="dim" title="${esc(hr.source)}"> HR</span></span>` : idFact('emirates_id', 'Emirates ID')}
        ${hr?.licence_no ? `<span data-hr="licence_no"><b>Licence</b> <span class="mono">${esc(hr.licence_no)}</span><span class="dim" title="${esc(hr.source)}"> HR</span></span>` : idFact('licence_no', 'Licence')}
        ${hr?.licence_expires ? `<span data-hr="licence_expires"><b>Licence expires</b> ${dateStr(hr.licence_expires)}<span class="dim" title="${esc(hr.source)}"> HR</span></span>` : ''}
        ${c.device_brand ? `<span><b>Device</b> ${esc(c.device_brand)} ${esc(c.device_model || '')}</span>` : ''}
        <span><b>First trip</b> ${dateStr(firstEver)}<span class="dim" title="the first trip on record for this person's platform account — it does not move with the range selector"> ever</span></span>
        <span><b>Last trip</b> ${lastEver ? `${dateStr(lastEver)} ${timeStr(lastEver)}` : '—'}</span>
        ${evTrips ? `<span><b>Trips</b> ${fmt(evTrips)}<span class="dim" title="every trip on record for this person, in every window"> ever</span></span>` : ''}
        ${p.span?.trips != null ? `<span><b>In this window</b> ${fmt(p.span.trips)} trip${p.span.trips === 1 ? '' : 's'}${
  p.span.days_worked != null ? ` over ${fmt(p.span.days_worked)} day${p.span.days_worked === 1 ? '' : 's'}` : ''}${
  p.span.vehicles ? ` in ${fmt(p.span.vehicles)} car${p.span.vehicles === 1 ? '' : 's'}` : ''}</span>` : ''}
        <span><b>Accounts</b> ${fmt(accounts)}${accN !== accounts
    ? `<span class="dim" title="${accN} of them have taken a trip we hold"> · ${accN} with trips</span>` : ''}</span>
        ${pid != null
    ? `<span><b>Person</b> <span class="mono">p${esc(String(pid))}</span><span class="dim" title="The id this page is addressed by. It is the person, not one of their provider accounts, so it does not change when a merge changes which account represents them — and it is the id the money ledger keys on."> the stable address</span></span>`
    : '<span><b>Person</b> <span class="dim">not placed</span></span>'}
        ${p.rating != null ? `<span><b>Rating</b> ${fmt(p.rating, 2)}<span class="dim" title="${
  esc(sourceLabel(p.rating_platform))}'s own rating, read ${p.rating_at ? dateStr(p.rating_at) : 'daily'}"> ${
  esc(sourceLabel(p.rating_platform))}</span></span>` : ''}
        ${p.platform_lifetime_trips ? `<span><b>${esc(sourceLabel(p.rating_platform || 'uber'))} count</b> ${
  fmt(p.platform_lifetime_trips)}<span class="dim" title="trips the platform has ever recorded for this driver. Ours covers what we collected; theirs covers the whole relationship, so the two are shown side by side rather than merged."> ever</span></span>` : ''}
      </div>
      ${accountPills ? `<div class="idsub">${accountPills}</div>` : ''}
      ${pid != null && !pAccounts.length
    ? '<p class="cap">This person holds no live platform account. They exist in the register — '
      + 'money can be owed by somebody before any provider record is linked to them, and '
      + 'detaching a wrongly merged account leaves the person behind — so there is a page, and '
      + 'nothing on a provider’s side to measure them by.</p>' : ''}
      ${pid == null && p.person_absent_reason
    ? `<p class="cap">${esc(p.person_absent_reason)}</p>` : ''}
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
  /* No number in the subtitle. It said "5 or more trips" — a copy of the
     floor, in a place the response cannot reach, beside a word ("trips") the
     measure it describes does not use: the row is count(*), which this
     profile calls bookings everywhere else. The floor and its unit are stated
     once, under the bars, from peer_floor as the endpoint applied it. */
  const stand = panel('How they rank in the fleet', 'Ranked against the drivers who worked enough of this window to compare'); g1.append(stand.panel);
  /* Lifetime, on a page whose every other panel is the selected window — and
     sorted by days held, so the car this person is driving today sat fourth
     behind three they gave back in March. The window is stated and the sort
     is by recency. */
  const veh = panel('Cars they have held (whole record)',
    'Not this window. Newest first, so the car they hold now is the top row.');
  g1.append(veh.panel);
  const g2 = el('div', 'grid g2'); root.append(g2);
  const start = panel('When the day starts', 'First trip of each working day'); g2.append(start.panel);
  const hm = panel('Which days and hours they work', 'When this driver’s trips actually happen'); g2.append(hm.panel);
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
    /* THE TWO CARDS THE OPERATOR ASKED FOR, and they close: money in is the
       cash the driver already holds plus what the platforms settle by
       transfer, with the second defined as the first subtracted from the
       total. See the block above moneyParts in ui.js for what each feed
       actually reports and what none of them does. */
    cashOnHandTile(k),
    bankDepositTile(k),
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
  /* THE GENERIC BOX AND THE TRUE SENTENCE WERE BOTH PRINTED, IN THAT ORDER.
     ─────────────────────────────────────────────────────────────────────────
     percentileBars falls through to charts.js:empty() on an empty metric list,
     which draws "NOTHING TO SHOW / No data for this range yet" — and the branch
     below then appended the real reason underneath it. So the reader met a
     line that is not a reason first and the reason second, buried. The box is
     only drawn where there is a chart to be empty; where the reason is known,
     the reason is the whole of it. */
  if ((st.metrics || []).length) {
    percentileBars(stand.body, st.metrics, {
      note: 'Fares only — most of this fleet\'s work carries no fare, so this percentile is not comparable.' });
  } else stand.body.innerHTML = '';
  /* THE COUNT IN THE SENTENCE AND THE COUNT THE FLOOR WAS APPLIED TO HAVE TO
     BE THE SAME COUNT.
     ─────────────────────────────────────────────────────────────────────────
     This printed k.trips — the /api/driver/kpis figure, over the subject's own
     accounts — beside a floor /api/driver/standing had applied at a different
     grain, and asserted the relation between them. On production 2026-09-01..
     09-07 Muhammad Asif Amir Zada had 5 trips over 3 accounts, none reaching
     the floor when it was tested per account, and the page read "5 trips in
     this window, which is fewer than the five a ranking needs". Five is not
     fewer than five, and the page said so about a named person.

     The floor is on the person now (api/driver_routes.js), and the endpoint
     returns both trips_in_window and peer_floor so this sentence states the
     numbers the decision was actually made on rather than re-deriving them.
     Falls back to k.trips only where an older API is answering, and then
     without the comparison it can no longer support. */
  if (!(st.metrics || []).length) {
    const mineTrips = st.trips_in_window ?? k.trips;
    const floor = st.peer_floor;
    stand.body.append(note(mineTrips
      ? `${countOf(mineTrips, 'booking')} in this window`
        + (floor ? `, which is fewer than the ${fmt(floor)} a ranking needs` : ', which is too few to rank')
        + ' — this person is not ranked rather than ranked badly.'
      : 'No trip in this window, so there is nothing to rank. Widen the range above.'));
  } else {
    stand.body.append(el('p', 'cap',
      `Compared against ${countOf(st.n_peers || 0, 'driver')} with `
      + `${st.peer_floor ? `${fmt(st.peer_floor)} or more` : 'five or more'} bookings in this window.`
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
  /* tableFrom falls through to the generic empty box on an empty list, and
     "No data for this range yet" is wrong twice on this panel: it is not a
     range — the subtitle says so in its own title — and it is not a reason. */
  if (!heldRows.length) {
    veh.body.innerHTML = '';
    veh.body.append(note('No custody record has ever placed this driver in a vehicle. Custody is '
      + 'written from the trips and handovers of each day, so a person whose work reaches us through '
      + 'a channel that names no plate has none — which is not the same as a driver who has never '
      + 'held a car.'));
  } else {
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
  }

  startScatter(start.body, daily);
  /* Both of these fell through to charts.js:empty()'s "No data for this range
     yet", which is not a reason — it is the shape of a sentence where a reason
     should be. Their siblings on this very tab now say why they are empty, so
     the generic line reads as a different and worse failure sitting beside
     them. The heatmap is built from trips; an empty one means no trip, and
     saying so costs a line. */
  hm.body.innerHTML = '';
  if ((hmap || []).length) heatmap(hm.body, hmap);
  else {
    hm.body.append(note(+k.trips > 0
      ? 'No trip of this driver\'s in this window carries a timestamp we could place on a day and an '
        + 'hour, so there is no pattern to draw. This is a gap in what the feeds reported, not a '
        + 'driver who worked no hours.'
      : 'No trip of this driver\'s falls in this window, so there is no day and no hour to place one '
        + 'in. An empty grid here would read as a week they were never busy; there was no week.'));
  }

  /* TRIPS PER DAY DREW THIRTEEN BARS OF ZERO HEIGHT AND SAID NOTHING.
     ═══════════════════════════════════════════════════════════════════════
     MEASURED on production for e3cd308b2b5f48e19877b924b48bbb9d over
     2026-09-01..09-16: a 1090x327 SVG holding 13 zero-height rects, two axis
     lines and nine labels (y 0 and 1, x Sep 1..Sep 13), and no caption at all —
     on the first tab a reader opens. barChart's own empty() never fires,
     because the ROWS exist; it is the VALUES that are nought. A full-size axis
     with nothing under it is the emptiest thing on the page and the only one
     that does not admit it.

     A day a feed reached with no trip on it IS a measured nought and the chart
     is the right picture of it — but only where there is something to compare
     it against. Where every day in the series is nought, the chart is thirteen
     pictures of nothing and the sentence is the honest rendering. */
  vol.body.innerHTML = '';
  const volDays = (daily || []).filter((d) => +d.trips > 0);
  if (!daily.length) {
    vol.body.append(note('No day in this window reached this driver at all — not a day with no trips '
      + 'on it, but no day on record here. There is nothing to draw a bar for.'));
  } else if (!volDays.length) {
    vol.body.append(note(`Not one of the ${countOf(daily.length, 'day')} any feed reached in this window `
      + 'carries a trip for this driver, so every bar would be nought and the axis would be the only '
      + 'thing on the chart. The days themselves are in the day-by-day table on Activity, with what '
      + 'each of them did and did not report.'));
  } else {
    barChart(vol.body, daily.map((d) => ({ ...d, label: dayStr(d.day) })), { x: 'label', y: 'trips', color: '--b400' });
  }
}

/* ── tab: activity ───────────────────────────────────────────────────────── */
/* `prof` IS A PARAMETER, and the day rows below are why.
   ─────────────────────────────────────────────────────────────────────────
   THE DEFECT. This tab links its day rows by the person where the spine has
   placed them — addressOf(prof, id) — but the signature read (root, id) and
   `prof` was a free variable. There is no module-scope `prof`, so the tab
   threw ReferenceError on every render and the whole view came up as "Could
   not load this view — prof is not defined". It was not caught by the
   route-level or the per-panel suites, because nothing there evaluates a tab
   body; bin/smoke_views.mjs renders all 124 and reported 123.

   The dispatcher has always passed it — `await fn(body, id, prof)` at the
   TABS call site — and tabOverview and tabEarnings already declare it. This
   tab simply never took delivery. */
async function tabActivity(root, id, prof) {
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

  /* shiftBars falls through to charts.js:empty() when no day carries a first
     job, and "No data for this range yet" is not a reason. The panel is drawn
     from jobs, so an empty one means no job — which is a different fact from
     the feed not having reached these dates, and both are worth saying. */
  /* The day rows link by the PERSON where the spine has placed them. This tab
     already holds the person id (it is on `prof`), and requirement is that a
     page holding one links by it rather than by the account it was opened
     with — an account link still resolves, but it hands the next reader an
     address that moves when a merge does. */
  if ((shift.days || []).some((d) => d.first_min != null)) {
    shiftBars(sh.body, shift.days, shift, addressOf(prof, id));
  }
  else {
    sh.body.innerHTML = '';
    sh.body.append(note((shift.days || []).length
      ? `The feed reached ${countOf(shift.days.length, 'day')} in this window and not one of them `
        + 'carries a job with a start time on it, so there is no shift to lay out. An empty '
        + '24-hour track would read as a day spent waiting; these are days with nothing on them.'
      : 'No day in this window carries a job for this driver, so there is no shift to lay out.'));
  }
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
  /* A DAY WITH NO DISTANCE REPORTED IS NOT A DAY OF NO DISTANCE.
     ─────────────────────────────────────────────────────────────────────────
     This was `km: +d.km || 0` handed to barChart, which then does
     `+d[y] === 0 ? 0 : …` — and `+null === 0` is true, so a day the driver
     worked whose trips report no distance drew the identical empty slot as a
     day of genuinely zero kilometres, with a tooltip reading "0 km". There was
     no caption under it at all.

     The remedy was already written 400 lines below for the sibling revenue
     chart, which draws the same three states with a `worked` flag and a
     three-way colorFor and explains itself underneath. Same three states here,
     same treatment, and a panel with nothing measured in it says so in words
     instead of drawing a bare axis. */
  const kmDays = daily.filter((d) => d.km != null);
  const workedDays = daily.filter((d) => +d.trips > 0);
  if (!daily.length) {
    dist.body.append(note('No day in this window reached this driver at all, so there is no distance '
      + 'to plot — not a run of zero-kilometre days.'));
  } else if (!kmDays.length) {
    dist.body.append(note(
      workedDays.length
        ? `No trip on any of the ${fmt(workedDays.length)} days this driver worked in this window `
          + 'reports a distance, so there is nothing to plot. Drawing them at nought would say they '
          + 'drove no kilometres, which is not what the record says — it says nobody measured.'
        : 'This driver worked no day in this window, so there is no distance to plot. The days below '
          + 'are dates a feed reached with nothing on them, not days of zero kilometres.'));
  } else {
    barChart(dist.body, daily.map((d) => ({
      label: dayStr(d.day), km: d.km == null ? 0 : +d.km,
      measured: d.km != null, worked: +d.trips > 0,
    })), { x: 'label', y: 'km', colorFor: (d) => (d.measured ? '--b300' : d.worked ? '--surface-3' : '--surface-2'),
      valueFmt: (v) => `${fmt(v)} km` });
    dist.body.append(el('p', 'cap',
      `${countOf(kmDays.length, 'day')} of ${fmt(daily.length)} in this window carry a measured `
      + 'distance. The rest are drawn empty rather than left out, so a gap looks like a gap — pale '
      + 'slots are days this driver worked with no distance reported, and the faintest are days they '
      + 'did not work. A day nobody measured is not a day of zero kilometres.'));
  }

  tbl.body.innerHTML = '';
  /* HOW MANY OF THE WINDOW'S DAYS ARE NOT IN THIS TABLE.
     ─────────────────────────────────────────────────────────────────────────
     The spine is the union of the days any feed reached, which is the right
     spine and is what the subtitle promises. But on production for
     e3cd308b2b5f48e19877b924b48bbb9d over 2026-09-01..09-16 it listed Sep 1 to
     Sep 13 — thirteen rows under a toolbar and an identity card both reading
     sixteen days. A reader counting the rows gets thirteen and nothing on the
     panel accounts for the other three. Stated underneath, from the days the
     rows actually carry rather than from a second client-side calendar. */
  const spineCap = (() => {
    if (!daily.length) return null;
    const ds = daily.map((d) => String(d.day).slice(0, 10)).sort();
    const span = Math.round((Date.parse(`${ds[ds.length - 1]}T12:00:00Z`)
      - Date.parse(`${ds[0]}T12:00:00Z`)) / 864e5) + 1;
    const missing = span - daily.length;
    return el('p', 'cap',
      `${countOf(daily.length, 'day')} listed, ${dayStr(ds[0])} to ${dayStr(ds[ds.length - 1])}`
      + (missing > 0
        ? ` — with ${countOf(missing, 'day')} inside that span on which no feed reported anything `
          + 'at all, not even an empty one, so there is no row to show. A missing row is a day nobody '
          + 'reached, not a day of no work.'
        : '. Any day of the window outside those dates was not reached by any feed either.'));
  })();
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
            /* A SHARE OF NOUGHT IS THE ONE SHARE THAT LOSES NOTHING.
               ───────────────────────────────────────────────────────────
               Thirteen rows of "AED 0 \u00b7 1/7" sat above a caption saying the
               figure on any one day inside a period is not something anybody
               measured, and the two read as the page printing a number and
               then denying it. For every other value that tension is real and
               the tag is the disclosure. For nought it is not: the share is
               the period divided by its days, so a share of nought is a PERIOD
               of nought \u2014 Uber filed a statement for that week and every line
               of it reads 0.00. That is a figure the platform published, and
               the tooltip says which kind of nought it is rather than leaving
               a reader to assume this one was estimated like the others. */
            ? (+r.money === 0
              ? `the ${n}-day statement covering this day reports nought over the whole of it, so `
                + 'this day\u2019s share of it is nought too \u2014 a figure the platform published '
                + 'about that week, not a day anybody measured'
              : `a ${n}-day statement divided across its days \u2014 right for the period, not `
                + 'measured on this day')
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
          /* "4.9 h \u00b7 spans" parsed as a count whose number had gone missing,
             because the column two to its left uses "\u00b7 1/7" for exactly that
             shape. A provenance marker has to read as a phrase, not as a
             truncated figure. */
          ? '<span class="dim" title="from the availability feed\u2019s ONLINE spans, not a figure the platform published"> \u00b7 from spans</span>' : '')
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
  if (spineCap) tbl.body.append(spineCap);
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
  /* An empty custody table is the reason half this page is empty — no custody
     day is why Harsh events on Quality cannot be measured and why the map has
     no telematics positions — and it said "No data for this range yet". */
  if (!custShown.length) {
    cust.body.append(note('No custody record places this driver in a vehicle on any day of this '
      + 'window. Custody is written from the trips and handovers each day, so a window with no work '
      + 'in it has none — and anything on this profile that needs a car and a day together, the '
      + 'harsh-driving attribution on Quality above all, has nothing to join against here.'));
    return;
  }
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
        radius: 4 + 11 * Math.sqrt(p.n / max), color: css('--paper'), weight: 1.2,
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
  /* "No data for this range yet" under a heading promising the areas this
     person picks up in. An area list is built from pickup ADDRESSES, so an
     empty one means either no pickup or no address on the pickups there were,
     and those are different facts about different feeds. */
  if (!(terr.areas || []).length) {
    areas.body.append(note(terr.pickups.length
      ? `This driver has ${countOf(terr.pickups.length, 'pickup cluster')} in this window and not one `
        + 'of the pickups behind them carries an address, so there is no area to name. The map beside '
        + 'this has the positions; only the words are missing.'
      : 'No pickup of this driver\'s in this window carries an address, so there is no area to name. '
        + 'Uber records the pickup address; the FMS telematics feed records neither address nor '
        + 'position, so a window with only telematics journeys in it has nothing here.'));
  } else {
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
  }

  dmix.body.innerHTML = '';
  /* The distance mix carried an average fare per bucket and the chart threw it
     away — "short hops or long runs" is only half the question, and the other
     half is whether the short ones pay. */
  const dist = (mix.distance || []).map((d) => ({ ...d }));
  if (!dist.length) {
    dmix.body.append(note('No trip of this driver\'s in this window reports a distance, so there is no '
      + 'length to sort them by. A bucket chart of nothing is not a driver who only did short hops — '
      + 'it is a window in which nobody measured how far anything went.'));
  } else {
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
  const comp = panel('What made up the pay', 'Fares, tips, tolls and adjustments, as the platform reports them'); g.append(comp.panel);
  const pay = panel('How riders paid', 'Card vs cash changes what actually reaches the fleet'); g.append(pay.panel);
  const line = panel('Revenue by day', 'Booked fare value from the trip record'); root.append(line.panel);
  const per = panel('What each platform paid', 'The statements each platform published for this driver'); root.append(per.panel);
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
  /* A POPULATION IS NOT COVERAGE, AND cashTrips === 0 HAS A THIRD CAUSE.
     ─────────────────────────────────────────────────────────────────────────
     The cash tile was repaired by gating on whether the driver WORKED, which
     separates "nothing was measured" from "nothing was cash". It does not
     separate a third case, and the repair made the sentence stronger without
     adding the test that would justify it.

     /api/driver/mix builds the payment breakdown as
     `coalesce(payment_type,'unknown') label` (api/driver_routes.js), so a
     booking whose payment_type is NULL still produces a row — it is just
     labelled `unknown` and never matches CASH_LABEL. A driver with two
     bookings, both of them unlabelled, therefore has bookings, has no cash
     row, and was told "none of their 2 bookings in this window was paid in
     cash": a measurement over rows where none was taken. `unknown` is real on
     production — over from=2025-09-17&to=2026-09-16, three of six sampled
     drivers carry `unknown:1` or `unknown:2` payment rows.

     `labelledTrips` is the population the breakdown can actually speak for.
     Where it is zero and bookings exist, the method was never recorded and the
     answer is an absence with its own reason; where it is positive, AED 0 is a
     real measurement and the sentence names the population it was taken over —
     which is the labelled bookings, not k.trips. */
  const labelledRows = (mix.payment || []).filter((p) => !/^unknown$/i.test(String(p.label || '')));
  const labelledTrips = labelledRows.reduce((a, p) => a + (+p.n || 0), 0);
  /* DID THIS PERSON WORK IN THIS WINDOW AT ALL.
     ─────────────────────────────────────────────────────────────────────────
     The one test that separates "measured as nought" from "never measured"
     everywhere on this tab, and it is a count of ROWS rather than a sum of
     money, so it is never null-coerced into a false answer. Three fields
     because the three populations differ: `bookings` excludes the telematics
     journeys `trips` includes, and `days_worked` survives a window in which a
     feed reached the day but reported no row on it. Any one of them being
     positive means there was something here to measure. */
  const bookingsN = +k.bookings || +k.trips || 0;
  const worked = bookingsN > 0 || +k.days_worked > 0;
  const lastWorked = personRecord(prof).lastEver;

  /* THE THIRD CASE, WHICH ONLY THIS TAB CAN SEE.
     ─────────────────────────────────────────────────────────────────────────
     emptyWindowNote() in the shell covers the two cases knowable from the
     profile alone — no trip in this window, and no trip ever. It cannot see the
     third: a driver who DID work here and none of whose work carries a money
     figure. That needs /api/driver/kpis and /api/driver/earnings, which only
     this tab fetches, so the sentence stays here and never fires alongside the
     banner above (it is gated on `worked`, the banner on its negation).

     Without it, a driver with 84 trips over 19 days reads as five em dashes
     with no explanation on the one tab that is entirely about money, which is
     the same defect as the zero: an absence whose reason is not stated. */
  /* EVERY MONEY FIGURE THIS TAB RENDERS, not the subset the first pass listed.
     ─────────────────────────────────────────────────────────────────────────
     This test decides whether the tab may say "none of it carries a money
     figure", so it has to be over the same figures the tab prints. It read the
     KPI money, the mix, the tips, the components and the periods' earnings —
     and never consulted `e.fare`, `e.statement_cash`, `e.statement_gross` or
     the periods' own `cash_earnings`, ALL FOUR of which this same function
     renders further down. So one render could carry the banner "none of it
     carries a money figure ... no statement covering these dates has reached
     us" and, four lines lower, "The day-level statements covering 7 days of
     this window report AED 6,000 net, AED 250 already taken in cash." A
     sentence that denies what the paragraph under it prints is worse than no
     sentence. Not reachable on the current production window — 0 of 136
     working drivers have empty `periods` with a non-null `fare` — which is
     exactly the kind of latency that ships. */
  const moneyMeasured = k.revenue != null || k.reported_earnings != null
    || k.statement_fares != null || k.cash_earnings != null || cashValue != null
    || e.tips != null || e.fare != null || e.statement_cash != null
    || e.statement_gross != null || (e.components || []).some((c) => c.amount != null)
    || (e.periods || []).some((r) => r.earnings != null || r.counted != null
      || r.cash_earnings != null);
  if (worked && !moneyMeasured) {
    root.prepend(note(
      `This driver worked in ${windowLabel()} — ${countOf(k.trips, 'trip')}`
      + (k.days_worked ? ` over ${countOf(k.days_worked, 'day')}` : '')
      + ' — and none of it carries a money figure. '
      + (k.priced_trips ? '' : 'No trip of theirs reports a fare — the Uber trip export has no fare '
        + 'column at all — and ')
      + ((e.periods || []).length
        ? 'the statements that do cover these dates report no amount on any line, so '
        : 'no statement covering these dates has reached us, so ')
      + 'every money figure below is absent rather than nought.'));
  }
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
    /* The only tile in this row with no sub-line at all: `sub: … : null`, so a
       driver with no priced trip got a bare em dash while its five siblings
       each said why they were absent. An absence with no reason beside five
       with one reads as the hole in the row rather than as the same answer. */
    { label: 'Average fare', value: money(k.avg_fare, 'AED', 2),
      sub: k.priced_trips
        ? `over the ${fmt(k.priced_trips)} priced trips`
        /* UBER_FARE_WHY, not a sixteenth hand-written copy of it.
           test/fare_reason_shared.test.mjs exists to catch exactly this: the
           first draft of this sub-line said "the Uber trip export has no fare
           column at all" and stopped, which reads as "and therefore never
           will". The shared sentence names where the fare DOES come from. */
        : worked
          ? `not one of their ${countOf(bookingsN, 'booking')} in this window reports a fare, so there `
            + `is nothing to average — ${UBER_FARE_WHY}, and an average over the statement would be `
            + 'a week divided by trips it does not count'
          : 'no booking of any kind in this window, so there is no fare to average' },
    { label: 'Platform earnings', value: money(k.reported_earnings), sub: 'as the platform reported it' },
    { label: 'Tips', value: money(e.tips), sub: e.tip_pct != null ? `${pct(e.tip_pct, 1)} of net fare` : 'no tip data yet',
      tone: e.tip_pct == null ? null : e.tip_pct >= 3 ? 'good' : e.tip_pct >= 1 ? 'warn' : null },
    /* AED 0 AND \u2014 ARE TWO DIFFERENT ANSWERS, AND THIS TILE PRINTED THE
       FIRST FOR BOTH.
       ═══════════════════════════════════════════════════════════════════════
       It read `v ? money(v) : (cashTrips ? 'not reported' : money(0))`. The
       final branch is reached whenever no cash label appears in /api/driver/mix
       \u2014 and cashTrips === 0 has TWO causes that the expression cannot tell
       apart:

         (a) the driver WORKED in this window and none of their bookings was
             cash. Nothing was collected in cash. AED 0 is a real measurement
             and is the correct thing to print.
         (b) the driver did NOT WORK in this window at all. Nothing was
             measured. AED 0 asserts a measurement that was never taken.

       MEASURED on production for e3cd308b2b5f48e19877b924b48bbb9d over
       2026-09-01..09-16: /api/driver/mix returns {distance:[], product:[],
       payment:[], status:[], platform:[]} \u2014 payment is EMPTY, so cashRows is
       empty, so cashTrips is 0 by case (b). /api/driver/kpis for the same
       window returns trips 0, bookings 0, days_worked 0. The tile printed
       `CASH COLLECTED  AED 0` beside five siblings correctly reading \u2014, on a
       page whose stated principle is that a figure which cannot be measured
       renders absent with a reason and never as zero.

       The population count is the thing that separates them, and it was already
       in scope: `k` is /api/driver/kpis, fetched by this same Promise.all. A
       count of nought is still a true count \u2014 TRIPS 0 stays 0 on the overview
       \u2014 but a MONEY figure over an empty population is not a figure. */
    { label: 'Cash collected', value: (() => {
      // The clawback line in the payout breakdown is the same money seen from
      // the other side, and is the only figure present when no cash trip
      // carries a fare.
      /* A PUBLISHED NOUGHT IS A MEASUREMENT AND THIS DISCARDED IT.
         ───────────────────────────────────────────────────────────────────
         The repaired expression opened `if (v) return money(v);` — a
         TRUTHINESS test on the end of a `??` chain that exists precisely to
         tell null from zero. `v === 0` fell straight through it, and with cash
         trips present the tile then printed "not reported": the page asserting
         that the platform reported nothing about a figure the platform
         reported. Uber publishes 0.00 lines for this fleet routinely — the
         very driver in this defect gets `payouts 0.00` and `your_earnings
         0.00` back from /api/driver/earnings — so this is not a hypothetical.
         `(fromComponents || null)` collapsed a published 0.00 clawback to null
         for the same reason, which is why the components are split into valued
         and unvalued here rather than summed from a zero seed. */
      const cashComps = (e.components || []).filter((c) => /cash/i.test(c.category));
      const valuedCash = cashComps.filter((c) => c.amount != null);
      const fromComponents = valuedCash.length
        ? valuedCash.reduce((a, c) => a + Math.abs(+c.amount || 0), 0) : null;
      const v = k.cash_earnings ?? cashValue ?? fromComponents;
      if (v != null) return money(v);
      if (cashTrips) return 'not reported';
      /* Three ways to have no cash row, and only one of them is AED 0. */
      return worked && labelledTrips ? money(0) : '\u2014';
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
      /* THE REASON HAS TO BE TRUE FOR THE CASE IT IS PRINTED IN.
         "no cash booking in this window" was printed for both cases above. In
         case (a) it is the whole truth. In case (b) it is true and NARROW: no
         booking of ANY kind was in this window, and a sentence about cash
         implies the fleet looked through this person's bookings and found none
         of them cash. It did not; there were none to look through. The wider
         fact is the one that explains the rest of the page, so it is the one
         printed. */
      : worked && labelledTrips
        ? `none of the ${countOf(labelledTrips, 'booking')} in this window whose payment method was `
          + 'recorded was paid in cash'
          + (bookingsN > labelledTrips
            ? ` \u2014 the other ${fmt(bookingsN - labelledTrips)} record no method at all and are `
              + 'left out rather than counted as not-cash'
            : '')
        : worked
          ? `not one of their ${countOf(bookingsN, 'booking')} in this window records how it was paid, `
            + 'so whether any of it was cash is not something anybody measured'
          : 'no booking of any kind in this window, so no cash was measured either way'
            + (lastWorked ? ` \u2014 this person\u2019s last trip was ${dateStr(lastWorked)}` : ''),
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
    /* A BAR OF ZERO LENGTH IS A PICTURE OF NOTHING, AND THIS CHART DREW TWO.
       ═══════════════════════════════════════════════════════════════════════
       MEASURED on production for e3cd308b2b5f48e19877b924b48bbb9d over
       2026-09-01..09-16: /api/driver/earnings returns
         components [{category: 'payouts', amount: '0.00'},
                     {category: 'your_earnings', amount: '0.00'}]
       and this panel drew two full-width rows, each with an empty track and the
       literal text "0", under the caption "2 top-level components netting to
       AED 0". Components that carry no money were described as having NETTED
       OUT — an arithmetic claim about figures nobody added.

       TWO DISTINCT FAULTS WERE FOLDED TOGETHER HERE, and they need different
       answers:

       1. `n: +c.amount || 0` coerced a NULL amount to zero before hbars ever
          saw it. charts.js hbars() then does `+d[value] || 0` again, so a
          component the statement NAMED BUT DID NOT VALUE and a component the
          statement valued at nought render identically: no bar, the string "0".
          hbars is shared by a dozen callers and is not this fix's to change, so
          the split is made here, before the rows are handed over: only rows
          carrying an amount are charted, and the ones that do not are named in
          a sentence instead of being drawn as nought.

       2. Where every amount IS present and every one of them is 0.00, the
          figures are REAL — Uber published them — and must not be swept away
          with the absences. But a chart of noughts is still a chart of nothing,
          so they are stated as a sentence. This is the one nought on this whole
          tab that is honest, and the sentence exists to protect it: it says the
          platform published these, which is exactly what distinguishes it from
          a figure nobody took. */
    const priced = roots.filter((c) => c.amount != null);
    const unpriced = roots.filter((c) => c.amount == null);
    const cur = roots[0]?.currency || 'AED';
    const named = (list) => list.map((c) => String(c.category).replace(/_/g, ' ')).join(', ');
    const platNames = [...new Set((e.periods || []).map((r) => r.platform).filter(Boolean))]
      .map(sourceLabel).join(', ');
    const filer = platNames || 'The platform';
    if (roots.length && !priced.length) {
      comp.body.append(note(
        `${filer} named ${countOf(roots.length, 'top-level component')} for this window — `
        + `${named(roots)} — and put an amount on none of them. Nothing is drawn, because a bar `
        + 'would be a length nobody measured; these are components the statement listed without '
        + 'valuing, not components worth nothing.'));
    } else if (priced.length && priced.every((c) => Number(c.amount) === 0)) {
      comp.body.append(note(
        `${filer}\u2019s payout breakdown for this window returns `
        + `${plural(priced.length, 'its one top-level component', `all ${fmt(priced.length)} of its top-level components`)}`
        + ` at nought \u2014 ${priced.map((c) => `${String(c.category).replace(/_/g, ' ')} `
          + `${money(c.amount, cur, 2)}`).join(' and ')}. `
        + 'That is a figure the platform published about this window, not a figure nobody took, so it '
        + 'is stated rather than drawn: a bar of zero length is a component that does not exist, and '
        + 'these were reported.'
        + (unpriced.length ? ` ${countOf(unpriced.length, 'further component')} \u2014 ${named(unpriced)} `
          + `\u2014 ${plural(unpriced.length, 'was', 'were')} named with no amount at all.` : '')));
    } else if (priced.length) {
      hbars(comp.body, priced.map((c) => ({ label: String(c.category).replace(/_/g, ' '), n: +c.amount })), {
        valueFmt: (v) => money(v, cur),
        legend: [['--b400', 'added to the payout'], ['--s2', 'deducted (cash already taken, fees)']] });
      const net = priced.reduce((a, c) => a + Number(c.amount), 0);
      comp.body.append(el('p', 'cap',
        `${countOf(priced.length, 'top-level component')} netting to ${money(net)}. `
        + 'Anything listed below is INSIDE one of them and is not added again.'
        + (unpriced.length
          ? ` ${countOf(unpriced.length, 'further top-level component')} \u2014 ${named(unpriced)} \u2014 `
            + `${plural(unpriced.length, 'carries', 'carry')} no amount and ${plural(unpriced.length, 'is', 'are')} `
            + 'left off the chart rather than drawn at nought, so this net is over the components that '
            + 'were valued.'
          : '')));
    }
    if (kids.length) {
      /* `amount: +c.amount || 0` here was the same collapse as the chart above,
         one table down: a child the statement named without valuing printed
         "AED 0.00" in a column of measured amounts. Carried through as null and
         rendered by money(), which already returns an em dash for it. */
      comp.body.append(tableFrom(kids.map((c) => ({
        within: String(c.parent).replace(/_/g, ' '),
        label: String(c.category).replace(/_/g, ' '),
        amount: c.amount == null ? null : +c.amount, currency: c.currency,
      })), [
        { label: 'Within', key: 'within' },
        { label: 'Component', key: 'label' },
        { label: 'Amount', key: 'amount', num: true,
          absent: 'the statement names these components and puts no amount on any of them',
          render: (r) => (r.amount == null ? '\u2014'
            : `${r.amount < 0 ? '−' : ''}${money(Math.abs(r.amount), r.currency || 'AED', 2)}`) },
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
  /* donut() falls through to empty()'s generic line on an empty mix, on the
     one tab that is entirely about money. The breakdown is built from bookings,
     so an empty one means either no booking or no booking whose payment method
     anybody recorded — and the cash tile above this reads its own absence off
     the same two facts, so the two must not tell different stories. */
  if ((mix.payment || []).length) donut(pay.body, mix.payment, { max: 6 });
  else {
    pay.body.append(note(worked
      ? `This driver\'s ${countOf(bookingsN, 'booking')} in this window carry no payment method at `
        + 'all — no channel here recorded how any of them was settled — so there is nothing to split '
        + 'card from cash by. That is why the cash tile above is absent rather than nought.'
      : 'No booking of this driver\'s falls in this window, so there is no payment to break down. An '
        + 'empty ring here would read as a driver nobody paid.'));
  }

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
  /* TWO FALLBACKS, EACH HIDING THE ABSENCE THE ONE BEFORE IT EXPOSED.
     ═══════════════════════════════════════════════════════════════════════
     This read `a + Number(r.counted ?? r.earnings ?? 0)`.

     `counted` is the server's answer to "how much of this statement falls on
     days no finer statement already accounts for". Null means it counted
     NOTHING — which is a statement about our resolution of overlapping
     periods, not an invitation to substitute a different measure. The first
     `??` silently swapped in `earnings`, which is the statement's own
     un-clamped figure and is exactly the number the paragraph under this table
     explains must NOT be added down the page. The second `??` then turned that
     absence into 0.

     MEASURED on production for e3cd308b2b5f48e19877b924b48bbb9d: both periods
     return counted: null, so the sum was 0 + 0 and the page printed "AED 0
     counted across 2 statements. None of them overlap, so Statement and
     Counted agree." They agreed only because both had been coerced to nought.

     Summed over the rows that carry the figure, and null where none does. */
  const countedRows = e.periods.filter((r) => r.counted != null);
  const counted = countedRows.length
    ? countedRows.reduce((a, r) => a + Number(r.counted), 0) : null;
  /* WHY THERE IS NO COUNTED FIGURE, READ OFF THE PAYLOAD RATHER THAN ASSERTED.
     ═══════════════════════════════════════════════════════════════════════
     The first repair of this column gave it a reason, and the reason was not
     the true one — which is the second half of the house rule and the easier
     half to miss. Both the column's `absent` string and the caption under the
     table said "the server resolved no part of these statements onto a day
     this window covers".

     api/driver_routes.js builds `periods` from driver_payout_day under
     `WHERE ... day BETWEEN $1::date AND $2::date`, and selects
     `count(*) AS days_used` and `round(sum(earnings),2) AS counted` over
     exactly those rows. days_used therefore IS the count of days the statement
     resolved onto INSIDE this window, and `counted` comes back null only when
     those in-window days exist and every one of them carries a NULL earnings.
     The days were resolved. What is missing is money on them.

     MEASURED through bin/live-ui.mjs against production, from=2026-09-01&
     to=2026-09-16, for e3cd308b2b5f48e19877b924b48bbb9d: two periods, days_used
     7 and 6, counted null on both. The table printed "7" and "6 of 7" in its
     Days column while the sentence directly beneath it said none of them had
     been resolved onto a day inside the window — the panel contradicted itself
     across six inches. Nor is it confined to the empty-window driver: 8 of the
     136 drivers WITH trips in that window carry counted null on every period
     with days_used 13, so a working driver reads the same false sentence.

     Branched on the fact the payload carries. Where any period resolved onto a
     day here, the days are named and the absence is attributed to the earnings
     figure; where none did, the original sentence is the true one and stays. */
  const resolvedDays = e.periods.reduce((a, r) => a + (+r.days_used || 0), 0);
  const countedWhy = resolvedDays
    ? `these statements resolve onto ${countOf(resolvedDays, 'day')} inside this window and not one `
      + 'of those days carries an earnings figure, so there is nothing to count under this heading '
      + '\u2014 the Statement column beside it is the platform\u2019s own un-clamped total over the '
      + 'whole period, which is a different measurement'
    : 'the server resolved no part of these statements onto a day this window covers, so '
      + 'there is no clamped figure to put under this heading \u2014 the Statement column beside it '
      + 'is the platform\u2019s own un-clamped total and is a different measurement';
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
    /* `money(r.counted ?? r.earnings)` printed the period's OWN earnings under a
       heading that promises the window-clamped figure — two different
       measurements under one label, and on this driver both rendered AED 0.
       money() already returns an em dash for null; `absent` prunes the whole
       column, with its reason, when no row carries one, which is what
       ui.js:tableFrom exists to do rather than drawing a column of dashes. */
    { label: 'Counted', key: 'counted', num: true,
      absent: countedWhy,
      render: (r) => money(r.counted) },
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
  /* THE SENTENCE THAT ASSERTED AN AGREEMENT BETWEEN TWO COERCED ZEROS.
     ─────────────────────────────────────────────────────────────────────────
     It opened "AED 0 counted across 2 statements" from the reduce fixed above,
     and then closed "None of them overlap, so Statement and Counted agree" —
     affirmatively false as a claim of agreement, because the two agreed only
     in the sense that both had been turned into nought. And there was no guard
     on an empty list at all, so a driver with no statement at all read
     "AED 0 counted across 0 statements".

     Three states now, three sentences: no statement reached us; statements
     reached us and none of them resolved onto a day in this window; statements
     reached us and this is what they came to. */
  /* Why two columns are missing, said in every branch rather than only in the
     one where a total was printed. It is a fact about the REPORT, so it is as
     true of a window with no counted figure as of one with one. */
  const colTail = (hasAccept && hasRating) ? ''
    : ` Acceptance and rating are ${(!hasAccept && !hasRating) ? 'both ' : ''}absent from this report — `
      + 'the platform publishes them on a different surface, so no column is drawn for them rather '
      + 'than a column of dashes that reads as zero.';
  if (!e.periods.length) {
    /* "No statement from any platform" was too wide a denial for this panel to
       make. This table is the PAYOUT-PERIOD feed (driver_payout_day); the
       day-level statement feed is a different table, and its own total is
       printed a few lines below this very caption. Narrowed to the feed the
       panel is about, so the two can both be true on one screen. */
    per.body.append(el('p', 'cap', 'No payout-period statement from any platform covers a day of this '
      + 'window, so there is nothing to count and no figure here — not a total of nought.'
      + (e.statement_days
        ? ' The day-level statement feed did reach these dates, and what it reports is stated '
          + 'underneath: it is a different filing at a different grain, not a figure for this table.'
        : '')
      + colTail));
  } else if (counted == null) {
    /* One sentence per cause, and the cause is read off `days_used` rather than
       asserted — see the block above `resolvedDays`. "none of them" was also
       printed over a single statement, so the pronoun is built from the count. */
    const them = e.periods.length === 1 ? 'it' : 'them';
    per.body.append(el('p', 'cap',
      `${countOf(e.periods.length, 'statement')} ${plural(e.periods.length, 'reaches', 'reach')} into `
      + 'this window and '
      + (resolvedDays
        ? `the server resolved ${them} onto ${countOf(resolvedDays, 'day')} inside it, every one of `
          + 'which carries no earnings figure at all, so nothing could be counted'
        : `the server resolved no part of ${them} onto a day inside it, so nothing was counted`)
      + '. That is an absent figure, not a total of nought: the Statement column beside it is '
      + 'the platform\u2019s figure over its whole period, which is a different measurement and is '
      + 'not the same money as this window\u2019s.' + colTail));
  } else {
    /* THE COUNT IN THE SENTENCE IS THE COUNT THAT CONTRIBUTED.
       ─────────────────────────────────────────────────────────────────────
       "counted across 16 statements" was over e.periods.length while the total
       beside it was summed over countedRows — and on a working driver measured
       through bin/live-ui.mjs for 2026-09-01..09-16, one of those sixteen
       carries counted null, so the sentence described a denominator its own
       numerator had excluded. The rows that carry no figure are named as such
       instead, which is the same treatment the components chart above gets.

       AND THE RECONCILIATION SENTENCE NOW HAS TWO BRANCHES.
       It fired only when Counted and Platform earnings DISAGREED by more than
       a dirham, which was its whole reason for existing when Counted was being
       computed with `r.counted ?? r.earnings` and came out too big. With the
       total now summed over the clamped column the two agree on that driver —
       AED 7,432 on both — and the sentence silently vanished, leaving nothing
       on the page to tell a reader that the two figures are the same money.
       Agreement is worth one clause; it is the thing a reader checks for. */
    const nulls = e.periods.length - countedRows.length;
    const rep = k.reported_earnings == null ? null : Number(k.reported_earnings);
    per.body.append(el('p', 'cap', `${money(counted)} counted across `
      + `${countOf(countedRows.length, 'statement')}`
      + (nulls
        ? ` — the other ${countOf(nulls, 'statement')} ${plural(nulls, 'reaches', 'reach')} into `
          + `this window and ${plural(nulls, 'carries', 'carry')} no earnings figure on any day of `
          + 'it, so nothing of theirs could be counted'
        : '')
      + (displaced.length
        ? `${nulls ? '. ' : ' — '}${fmt(displaced.length)} of them overlap another statement, and `
          + 'only the days no other statement covers are counted. Adding the Statement column instead '
          + 'would count those days twice.'
        : '. None of them overlap, so Statement and Counted agree.')
      + colTail
      + (rep == null ? ''
        : Math.abs(counted - rep) > 1
          ? ` The Platform-earnings tile above reads ${money(rep)}: that is the sum of the `
            + 'statements as published, and this is the part of them that falls inside the window — a '
            + 'statement straddling the edge contributes only its days inside it.'
          : ` The Platform-earnings tile above reads ${money(rep)}, which is this same money: no `
            + 'statement here straddles the edge of the window with days outside it that carry an '
            + 'amount, so the published sum and the part of it counted in these dates come to one '
            + 'figure. They are one number checked two ways, not two numbers that happen to match.')));
  }
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
  const ev = panel('Harsh driving', 'From the tracker, on the days this driver held the car'); g.append(ev.panel);
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
    /* A COUNT OF NOUGHT OVER A POPULATION THAT DOES NOT EXIST IS NOT A COUNT.
       ═══════════════════════════════════════════════════════════════════════
       This tile read 0 under the sub "no matched distance" while the tile
       immediately to its right — Per 100 km, the same numerator over a
       denominator — correctly read "not measured". A numerator printing a
       confident nought beside a denominator refusing to print at all, on one
       row.

       Attribution here is a JOIN: alert rows against vehicle_driver_day rows
       for the same plate and day (api/driver_routes.js). With no custody row in
       the window there is nothing on the right of that join, so the count comes
       back 0 for a reason that has nothing to do with how this person drove —
       the panel below this tile says exactly that ("Attribution needs both a
       telematics alert and a custody record for the same day"), and the tile
       above it contradicted it with a digit.

       `telematics_journeys` is the field that separates the two: the endpoint
       sets it to null when plate_days is 0 — no custody row places this driver
       in a car at all — and to a number otherwise. MEASURED on production for
       e3cd308b2b5f48e19877b924b48bbb9d over 2026-09-01..09-16:
       telematics_journeys null, alerts [], alert_km null. Tested with === so an
       older API that omits the field leaves the count exactly as it was: a
       missing field is not a proof of absence. A driver who DID hold a car and
       triggered nothing still reads 0, because that is a measurement. */
    (qy.telematics_journeys === null && !totalAlerts
      ? { label: 'Harsh events', value: '\u2014',
        sub: 'no custody record places this driver in a car on any day of this window, so there was '
          + 'nothing for a tracker alert to be attributed to — this is not a clean record, it is an '
          + 'unmeasured one' }
      : { label: 'Harsh events', value: fmt(totalAlerts),
        sub: !harsh.classified && harsh.total
          ? 'not split from tracker faults — this feed does not mark them'
          : (qy.alert_km ? `over ${fmt(qy.alert_km)} km the feed covered` : 'no matched distance') }),
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
  /* THE EMPTY BRANCH ASSERTED A FACT THE REST OF THE PAGE DENIES.
     ═══════════════════════════════════════════════════════════════════════
     The first repair replaced "No cancellations on any of the 0 days this
     driver worked in this window" — awkward, but hedged — with the confident
     "This driver worked no day in this window". It is confident about the
     wrong thing.

     `cd` is cancel_daily filtered to `trips > 0`, and cancel_daily.trips is
     `count(*) FILTER (WHERE outcome IS NOT NULL)` over trip_norm
     (api/driver_routes.js), whose `outcome` is NULL for every platform='fms'
     row and for every row with a NULL status (sql/schema_v18.sql). So
     `cd.length === 0` means NO ROW IN THIS WINDOW CARRIES A NORMALISED
     OUTCOME. It does not mean nobody worked.

     Driven through this file with kpis {trips:84, days_worked:19,
     outcome_n:0} and quality {cancel_daily: []}, the Quality tab printed "This
     driver worked no day in this window ... it is a window with no work in
     it", while the Overview tab of the same profile printed Days worked 19 and
     Trips 84 and the Earnings tab printed Booked revenue AED 12,400. An
     operator screenshotting Quality would circulate a statement that a person
     did not work in a month they were paid for. Not on screen on the current
     production window — all 136 working drivers on 2026-09-01..09-16 have
     cancel_daily rows with trips > 0 — and live the moment a channel files a
     booking with no status, or an FMS journey is attributed to a driver.

     Two causes, two sentences, and the population test is the same one the
     Earnings tab already derives from /api/driver/kpis. */
  const workedQ = (+k.bookings || +k.trips || 0) > 0 || +k.days_worked > 0;
  if (!cd.length && !workedQ) {
    line.body.append(note('This driver worked no day in this window, so there is no day on which they '
      + 'could have cancelled anything. This is not a clean cancellation record — it is a window with '
      + 'no work in it.'));
  } else if (!cd.length) {
    line.body.append(note(
      `This driver worked in this window — ${countOf(k.trips, 'trip')}`
      + (k.days_worked ? ` over ${countOf(k.days_worked, 'day')}` : '')
      + ' — and no day of it carries a trip whose outcome any platform reported, so there is nothing '
      + 'to chart. The telematics feed publishes no outcome at all, and a booking filed without a '
      + 'status carries none either; both leave a day in this window with work on it and no way to '
      + 'say whether anything was cancelled. This is not a clean record — it is an unreported one.'));
  } else if (!cd.some((d) => d.cancelled > 0)) {
    line.body.append(note(`No cancellations on any of the ${countOf(cd.length, 'day')} this driver `
      + 'worked in this window.'));
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
  const p = panel('Trip records',
    'The underlying rows, newest first — every platform this driver appears on, and the '
    + 'journeys on their cars that no platform booked');
  root.append(p.panel); loading(p.body);
  /* A page, not a ceiling. The endpoint returns {rows, total, offset,
     truncated}, so "500 newest" can become "500 of 1,247" and the reader can
     ask for the next 500 instead of being told the rest is unreachable. */
  const PAGE = 500;
  /* THE UNEXPLAINED JOURNEYS ARE FETCHED BESIDE THE BOOKINGS, NOT AFTER THEM.
     ───────────────────────────────────────────────────────────────────────
     Asked for in these words: "on driver's trip page we should also keep
     unauthorized trips". A car's day is one sequence of events and the
     operator's question is what the car did, so the two lists have to be sorted
     together — which means the table cannot be drawn once without the journeys
     and then again with them, or the first paint is an answer that is missing
     the thing the page was opened for.

     The catch is not laziness. The bookings are the SUBJECT of this tab and the
     journeys are an addition to it: if the attribution endpoint is down, a
     driver's trip list must still render, and the toolbar says plainly that the
     other half could not be loaded rather than showing a number that silently
     excludes it. */
  const [res0, unRaw] = await Promise.all([
    qAll('/api/driver/trips', { id, limit: PAGE }),
    qAll('/api/driver/unauthorized', { id }).catch(() => null),
  ]);
  /* A 200 CARRYING THE WRONG BODY IS A FAILURE, NOT AN EMPTY ANSWER.
     ───────────────────────────────────────────────────────────────────────
     `.catch(() => null)` stops a thrown request and nothing else. A bare `[]`
     from a mock's catch-all, or from a proxy or cache that rewrote the body,
     is TRUTHY — so every `!un` branch below went unreached and the page said,
     in three separate places, things it had never measured: the toolbar read
     "500 of 640 bookings loaded · 0 with no booking", and the caption read "No
     journey with no booking against it has this person as one of several
     candidates in this window — every one that touches them is in the list
     above, named." The wording written for exactly this failure ("a failure of
     the request, not a finding about this driver") never fired. */
  const un = unRaw && unRaw.attributed && unRaw.attributed.rows ? unRaw : null;
  /* Minutes computed onto the row rather than in the renderer, and that is
     not a style choice: tableFrom prunes a column whose declared key is blank
     on every row (api/public/ui.js:186), so a Minutes column keyed on
     duration_s is dropped before its renderer ever runs — which is how the
     column disappeared instead of showing the span both timestamps describe.
     Keyed on a real field, it also sorts by duration rather than by end time. */
  const bookings = (res0.rows || []).map((r) => ({ ...r, kind: 'booking', minutes: tripMinutes(r) }));
  let total = res0.total ?? bookings.length;
  /* ONLY THE ATTRIBUTED JOURNEYS ARE INTERLEAVED, AND THAT RESTRAINT IS THE
     WHOLE CARE OF THIS CHANGE.
     ───────────────────────────────────────────────────────────────────────
     /api/driver/unauthorized returns two lists. `attributed` holds the journeys
     the ladder NAMED this person beside — their own Uber trips bracket the
     window, or they are the only person the record shows holding the car that
     day. `also_a_candidate` holds journeys where two or more people held the
     car and nothing separates them.

     The second list must never appear in this person's own trip ledger. A row
     sitting in somebody's list of trips is read as something they did, and on a
     page that mixes them a maybe becomes an accusation the moment anybody
     screenshots it. They are one click away, under their own heading and their
     own count, on the Unexplained trips tab — and the caption under this table
     says how many there are so the number is never hidden, only kept out of a
     list it would change the meaning of.

     Each field below is mapped onto the column a booking already uses, so ONE
     sort by time interleaves the two. Every mapped field is the same KIND of
     fact as the one it lands in; the two that are not — a place-cell area name
     is not a street address, a distance nobody was charged for is not a fare —
     render through their own branch in the column list and carry the difference
     in the cell, where the reader is, rather than in the key, where nobody
     looks. */
  const unrows = ((un && un.attributed && un.attributed.rows) || []).map((r) => ({
    ...r,
    kind: 'unexplained',
    requested_at: r.started_at,
    minutes: r.duration_min,
    pickup_addr: r.start_place?.area || null,
    dropoff_addr: r.end_place?.area || null,
    /* Left null on purpose, all five. An unexplained journey has no platform,
       no product, no payment type, no provider status and no booking id —
       because no channel booked it, which is the entire definition. Writing a
       placeholder into any of them would make a journey look like a booking in
       precisely the column a reader uses to tell the two apart. */
    platform: null, product: null, payment_type: null, status: null, external_id: null,
  }));
  const rows = bookings.concat(unrows);
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
    /* Both absences, because they are different facts and one of them is about
       us. "No booking" is measured across every channel; "no unexplained
       journey" is only as good as the seat sensor's coverage, which on this
       fleet is partial by construction — so an empty table must not be allowed
       to read as a clean record on a window nothing watched. */
    const cov = un && un.coverage;
    return empty(p.body, 'No trip on any channel for this driver in this window. Widen the range above '
      + '— this person may simply not have worked in it. '
      + (!un
        ? 'The unexplained-journey list could not be loaded, so nothing here says whether there '
        + 'were any.'
        : cov && cov.days_with_data === 0
          ? 'No seat-occupancy evidence covers this window either, so this is not a record of no '
          + 'unexplained journeys — it is an absence of the sensor that would find them.'
          : 'No journey with no booking against it is attributed to them here either.'));
  }
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="tq" type="search" placeholder="Filter by address, plate, status or product…">
    <span class="cap" id="tn"></span>`;
  p.body.append(bar);
  const host = el('div'); p.body.append(host);
  const cols = [
    /* THE MARKER, AND WHERE IT ENDED UP IS A MEASUREMENT RATHER THAN A TASTE.
       ─────────────────────────────────────────────────────────────────────
       A booking and a journey with no booking against it are different kinds
       of thing, and once the two are sorted together by time nothing else in
       the row says which is which: an unexplained journey has a plate, a clock
       time, a distance and two place names, exactly like a trip. It needs a
       marker that survives a screenshot, a greyscale print and a colour-blind
       reader, so it is `.pill.bad` — 600 weight with a "!" glyph in front of
       the text (api/public/app.css) — and not a tint on the row.

       It went in a column of its own at the left edge first, which is where
       a marker belongs. Measured at 1,440px on a driver who has one: the
       scroller is 1,090px and the table became 1,127, so FARE fell off the
       right edge and drew a sideways-scroll cue — on precisely the drivers
       with an unexplained journey and on no others, which hides a money column
       exactly where somebody came to look at it. Moving the pill into Platform
       cost 39px of that same 37px overflow, for the same reason: both columns
       were narrower than the pill.

       REQUESTED is already 100px wide because it carries "Aug 24 11:45", and
       the pill is about 80. So the marker sits above the timestamp in a cell
       that was already paying for the width, the table is exactly as wide as
       it was before this change, and the marker is still the leftmost thing in
       the row. */
    /* …AND THE FORGONE FIGURE RIDES HERE TOO, for a measured reason.
       ─────────────────────────────────────────────────────────────────────
       It was rendered only in Fare, which is the LAST column of a table that
       already overflows its scroller. Measured in Chromium on a driver with
       one unexplained journey: at 1,440px the table is 1,186px inside a
       1,090px .tscroll and only about 30px of the 111px "AED 55 forgone" span
       fell inside it — the reader saw the literal string "AED" and no number,
       which reads as a figure the page failed to produce rather than as a
       hidden column. At 1,280px none of it was on screen. The unexplained row
       also widens the table by a further 45px (Requested 100→117 for the pill,
       Status 150→170), so the change made the clipping worse on exactly the
       drivers this feature is about.

       Requested is already paying for the pill's width, so the figure goes
       under it, where it cannot scroll away. It stays in Fare as well: that is
       where a reader sorting on money looks, and a duplicated figure on one
       row is cheaper than a money column that is invisible at every width an
       operator uses. */
    { label: 'Requested', key: 'requested_at', render: (r) => (r.kind === 'unexplained'
      ? `<span style="display:block;margin-bottom:3px">${pill('no booking', 'bad',
        'The seat sensor saw a passenger aboard and no channel booked the journey. The name '
        + 'beside it is an inference, not a trip record — open the Unexplained trips tab for the '
        + 'rule that named this person and the measurement behind it.')}</span>`
        + tripTime(r.plate, r.requested_at)
        + (r.forgone_aed == null ? ''
          : `<span class="ent-off" style="display:block;margin-top:2px;font-size:11px" title="${
            esc(`This journey earned nothing: no channel booked it. Its distance would have been `
              + `worth this much had it been sold — ${r.rate_basis || ''}`)}">${
            esc(money(r.forgone_aed, 'AED', 0))} forgone</span>`)
      : tripTime(r.plate, r.requested_at)) },
    /* "none", dim, rather than a dash. A dash in this column on a row that
       otherwise looks like a trip reads as a channel we failed to record; the
       absence here IS the finding, and it is measured against every channel
       the reconciler checks. Kept to one short word because the column is
       sized by its own heading and anything longer widens the table. */
    { label: 'Platform', key: 'platform', render: (r) => (r.kind === 'unexplained'
      ? '<span class="ent-off" title="no channel booked this journey — that is what makes it '
        + 'unexplained, and it is measured against bolt, hotel, uber and yango alike">none</span>'
      : sourceLabel(r.platform)) },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    /* A BOOKING'S ADDRESS AND A SEGMENT'S PLACE ARE NOT THE SAME CLAIM.
       A booking carries the address the channel recorded. An unexplained
       journey carries only a coordinate, and the name beside it comes from the
       fleet's own history — `place_cell` folds past trips into ~0.5 km cells
       holding the modal area name (api/place_sql.js). So the two render
       differently: segPlace() dims a cell fewer than five trips agree on and
       puts the vote count in its title, and a cell nothing has ever named
       falls back to the coordinate rather than to the nearest thing it has. */
    { label: 'From', key: 'pickup_addr', render: (r) => (r.kind === 'unexplained'
      ? segPlace(r.start_place, r.start_lat, r.start_lng) : esc(r.pickup_addr ?? '—')) },
    { label: 'To', key: 'dropoff_addr', render: (r) => (r.kind === 'unexplained'
      ? segPlace(r.end_place, r.end_lat, r.end_lng) : esc(r.dropoff_addr ?? '—')) },
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
    { label: 'Status', key: 'status', render: (r) => {
      /* The reconciler's verdict standing in for a provider's status, because
         that is the analogous fact: what the record concluded about this
         journey. The tier that named THIS person rides in the tooltip
         alongside the evidence sentence — and the caption under the table
         sends the reader to the tab where that sentence is on the screen
         rather than under a cursor, which is where an accusation belongs. */
      /* THE STRENGTH OF THE CLAIM IS ON THE SCREEN, NOT IN A TOOLTIP.
         ─────────────────────────────────────────────────────────────────
         This is the one surface where an unexplained journey is sorted into
         the person's OWN trip ledger by time, so it reads most strongly as
         something they did — and the tier and the evidence existed only inside
         the pill's `title`. The row showed "!NO BOOKING" and "!UNAUTHORIZED"
         and nothing at all about how strong the claim behind them is. This
         file's own header quotes the house rule against exactly that: a fact a
         reader has to hover to find is a fact most readers never see. A
         manager screenshots the tab and circulates a list of somebody's trips
         with one flagged UNAUTHORIZED in red, and nothing on the image says
         the flag rests on "they were the only person holding the car that
         day". The column already carries a pill; the rung goes under it. */
      if (r.kind === 'unexplained') {
        return pill(r.verdict || 'unauthorized', 'bad',
          `${TIER_LABEL[r.attribution_tier] || r.attribution_tier}: ${r.attribution_evidence || ''}`)
          + `<span class="dim" style="display:block;margin-top:3px;font-size:11px" title="${
            esc(r.attribution_evidence || '')}">${esc(TIER_LABEL[r.attribution_tier]
            || r.attribution_tier || 'no rung reached')}</span>`;
      }
      return pill(r.status || '—',
        r.outcome === 'completed' ? 'ok' : r.outcome === 'not_completed' ? 'warn' : null);
    } },
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
    /* …and `absent` is withheld for a SECOND reason now.
       tableFrom prunes a column that declares `absent` and whose declared key
       is blank on every row, and it tests the RAW key — `price` — not what the
       renderer produces. An unexplained journey has no price and never will,
       so on a driver whose bookings are all unpriced Uber the column would be
       dropped while carrying a real figure: the revenue forgone on the rows
       this change added, pruned out from under the reader on exactly the page
       that put them there. */
    { label: 'Fare', key: 'price', num: true,
      absent: (dayMoneyKnown || unrows.some((r) => r.forgone_aed != null)) ? undefined : UBER_FARE,
      render: (r) => {
        /* NOT A FARE, AND THE CELL SAYS SO IN ITS OWN WORDS.
           ───────────────────────────────────────────────────────────────
           An unexplained journey earned nothing — that is the point of it —
           but its distance was worth something, and the whole reason the
           operator wanted these rows was to see what. Printing that figure
           plainly under a heading that says Fare would report revenue forgone
           as revenue taken, which is the exact error api/place_sql.js was
           written to prevent. So it renders dim, with the word "forgone" on
           the screen and not in a tooltip, and the rate it was computed at in
           the title. */
        if (r.kind === 'unexplained') {
          if (r.forgone_aed == null) {
            return `<span class="ent-off" title="${esc(r.rate_basis
              || 'no distance was measured across this journey')}">earned nothing</span>`;
          }
          /* TWO WORDS, AND THEY ARE ALLOWED TO WRAP.
             ─────────────────────────────────────────────────────────────
             The column is declared `num`, and api/public/app.css sets
             `td.num { white-space: nowrap }` — right for a figure, wrong for a
             figure with a noun after it. Measured at 1,440px: nowrap took this
             column from 84px to 139px and pushed the table 37px past its
             scroller, so the money column drew a sideways-scroll cue on
             exactly the rows this change added. Allowed to wrap it sets its
             own width from the longest word and the table is as wide as it was
             before.

             "AED 18 forgone" and not "nothing · AED 18 forgone" for the same
             reason. The word `forgone` is what stops the figure being read as
             revenue, so that is the word that stays; the rest of the sentence
             is in the title. */
          return `<span class="ent-off" style="white-space:normal;display:inline-block" `
            + `title="This journey earned nothing: no channel booked it. Its distance would have `
            + `been worth this much had it been sold — ${esc(r.rate_basis || '')}`
            + `">${esc(money(r.forgone_aed, 'AED', 0))} forgone</span>`;
        }
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
  /* THE CAP IS APPLIED TO A LIST IN TIME ORDER NOW, AND WHAT IT DROPS IS NAMED.
     ─────────────────────────────────────────────────────────────────────────
     THE DEFECT, MEASURED IN CHROMIUM. `rows` is `bookings.concat(unrows)` —
     the server's page of bookings, newest first, with the unexplained
     journeys appended AFTER all of them — and the draw was
     `list.slice(0, DRAW)` over that raw concatenation. So on any driver with
     DRAW or more bookings in the window every unexplained journey sits past
     index 400 and NONE of them is drawn, while the toolbar three lines above
     counts them.

     Rendered on the mock at 1,440px: the table drew 400 rows, 0 of them
     unexplained, under a toolbar reading "500 of 640 bookings loaded · 3 with
     no booking" and a caption reading "drawing the 400 newest of 503
     matching". Every one of those three statements is separately defensible
     and together they are a lie: the drawn set was the 400 newest BOOKINGS,
     the three journeys were dropped for their position in an array rather than
     for their age, and the reader is told a count of rows the table does not
     contain and cannot be made to contain by sorting — the header sort runs
     over the 400 already drawn.

     This is not a tidy-up. 1,200 trips a quarter is an ordinary driver on this
     fleet, so DRAW is reached routinely, and the interleave is the whole of
     the operator's first request ("on driver's trip page we should also keep
     unauthorized trips"). It failed silently on precisely the busy drivers the
     feature is about.

     Two changes, and the second is the honesty half. The list is put in time
     order BEFORE the cap, so "the 400 newest" is true of what is on screen;
     and where the cap still drops an unexplained journey — an old one, on a
     driver with 400 newer rows — the caption SAYS SO and points at the tab
     that holds it, rather than leaving a counted row invisible. A count
     without its rows is the shape of defect this whole tab exists to refuse. */
  const byTime = (a, b) => (Date.parse(b.requested_at) || 0) - (Date.parse(a.requested_at) || 0);
  const draw = (unordered, term) => {
    const list = [...unordered].sort(byTime);
    host.innerHTML = '';
    /* A row opens the booking. The endpoint has always returned external_id
       and the table never used it, so the one artefact somebody wants to look
       into — "which trip was that, exactly" — was the one thing here that led
       nowhere. Clicks on the plate link still go to the vehicle.

       An unexplained journey has no booking to open, so it opens the SEGMENT —
       api/public/segments.js renderSegment, where the case for and against the
       verdict is argued in full. A row carrying a name has to lead somewhere a
       reader can argue with it, and href('trip', null, null) leads nowhere. */
    host.append(tableFrom(list.slice(0, DRAW), cols,
      { sortable: true, sortId: 'dtrips', defaultSort: { key: 'requested_at', dir: 'desc' },
        onRow: (r) => {
          location.hash = r.kind === 'unexplained'
            ? href('segment', r.plate, r.started_at)
            : href('trip', r.platform, r.external_id);
        } }));
    if (!list.length) {
      host.innerHTML = '';
      host.append(note(`No trip here matches “${term}”. That is a filter over the `
        + `${fmt(rows.length)} rows loaded on this page`
        + (bookings.length < total ? `, not over all ${fmt(total)} bookings in the window.` : '.')));
      return;
    }
    const caps = [];
    if (list.length > DRAW) caps.push(`drawing the ${fmt(DRAW)} newest of ${fmt(list.length)} matching`);
    /* …and if the cap took an unexplained journey with it, name the number.
       See the block on `draw` above: these rows are the reason this table
       interleaves anything at all, and one falling off the bottom without a
       word is the same defect as a count with no rows behind it. */
    const droppedUn = list.slice(DRAW).filter((r) => r.kind === 'unexplained').length;
    if (droppedUn) {
      caps.push(`${fmt(droppedUn)} of the journeys with no booking against them are older than `
        + `the ${fmt(DRAW)} rows drawn here and are NOT in this table — they are on the `
        + 'Unexplained trips tab, in full, with the rule that named this person on each');
    }
    /* Both numbers, always: how many are loaded, and how many exist. "The
       server sent the 500 newest" is true and unusable — 500 of how many?
       Counted over the BOOKINGS, because that is the list the server is paging:
       the unexplained journeys arrive whole, and folding them into this
       arithmetic would make "500 of 1,247 loaded" wrong by however many there
       were. */
    if (bookings.length < total) {
      caps.push(`${fmt(bookings.length)} of ${fmt(total)} bookings in this window are loaded`);
    }
    if (caps.length) host.append(el('p', 'cap', `${caps.join('; ')}.`));

    /* THE COUNT THAT IS DELIBERATELY NOT IN THE TABLE, STATED UNDER IT.
       ─────────────────────────────────────────────────────────────────────
       The journeys this person is merely ONE CANDIDATE for are kept out of
       this ledger on purpose — a row in somebody's trip list is read as
       something they did. But keeping them out and saying nothing would hide
       them, so the number is stated here with the reason and the address of
       the page that holds them. Printed whether or not there are any: a zero a
       reader can see is worth something, and a silence is not. */
    if (un) {
      const amb = un.also_a_candidate?.total || 0;
      host.append(el('p', 'cap', amb
        ? `${fmt(amb)} further ${plural(amb, 'journey', 'journeys')} with no booking happened on a `
          + 'car this person held that day, alongside somebody else — nothing in the record says '
          + 'which of them was driving, so they are not in this list. They are on the Unexplained '
          + 'trips tab, under their own heading.'
        : 'No journey with no booking against it has this person as one of several candidates in '
          + 'this window — every one that touches them is in the list above, named.'));
    } else {
      host.append(el('p', 'cap', 'The unexplained-journey list could not be loaded, so this table is '
        + 'bookings only. That is a failure of the request, not a finding about this driver.'));
    }

    if (bookings.length < total) {
      const more = el('button', 'btn', `Load the next ${fmt(Math.min(PAGE, total - bookings.length))}`);
      more.onclick = async () => {
        more.disabled = true; more.textContent = 'Loading…';
        try {
          const next = await qAll('/api/driver/trips', { id, limit: PAGE, offset: bookings.length });
          const more0 = (next.rows || []).map((r) => ({ ...r, kind: 'booking', minutes: tripMinutes(r) }));
          bookings.push(...more0);
          rows.push(...more0);
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
  /* BOTH NUMBERS, ALWAYS.
     ───────────────────────────────────────────────────────────────────────
     "47 trips" when three of them are journeys nobody booked is a figure that
     hides the thing the operator opened this page for — and it is the figure
     that gets quoted, because it is the one at the top of the tab. So the
     toolbar states the split rather than the total, and states it when the
     unexplained count is zero as well: a zero a reader can see is the only
     zero worth anything on a tab that now claims to carry both. */
  const count = (n) => {
    const nb = bookings.length, nu = unrows.length;
    const loaded = nb < total
      ? `${fmt(nb)} of ${fmt(total)} bookings loaded`
      : `${fmt(nb)} ${plural(nb, 'booking')}`;
    const unsaid = !un
      ? 'unexplained journeys could not be loaded'
      : `${fmt(nu)} with no booking`;
    const filtered = n === rows.length ? '' : `${fmt(n)} of ${fmt(rows.length)} shown · `;
    bar.querySelector('#tn').textContent = `${filtered}${loaded} · ${unsaid}`;
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

/* ── unexplained journeys: the pieces the two tabs share ──────────────────
   An unauthorized trip is, BY DEFINITION, a journey with no booking against
   it. There is therefore no record naming its driver — if there were, the
   reconciler would have matched it and the verdict would not be
   `unauthorized`. So every name rendered below is an INFERENCE, and naming
   the wrong person accuses an innocent employee of theft.

   These helpers exist because the SAME journey is rendered on two tabs — its
   own tab below, and interleaved with the bookings on Trips — and a journey
   that reads one way here and another way on the tab beside it is two claims
   about one fact.

   segPlace and segForgone are lifted from api/public/segments.js rather than
   imported: both are module-private there and that file is the segments view,
   which this change does not own. A copy carrying this note is cheaper than
   widening another view's exports, and both copies render the same jsonb the
   same SQL builds — api/place_sql.js placeEnds() and forgone(). */
const segPlace = (place, lat, lng) => {
  if (place && place.area) {
    const votes = place.votes == null ? '' : ` · ${fmt(place.votes)} of ${fmt(place.seen ?? place.votes)}`
      + ' trips here call it that';
    /* A cell one trip named is not the same claim as a cell four hundred trips
       agree on, and on this tab it sits beside an accusation. */
    const thin = place.votes != null && place.votes < 5;
    const short = place.area.length > 18 ? `${place.area.slice(0, 17)}…` : place.area;
    return `<span class="${thin ? 'dim' : ''}" title="${esc(place.area
      + ` — from the fleet’s own trip endpoints${votes}`)}">`
      + `${esc(short)}${thin ? ' <span class="dim">?</span>' : ''}</span>`;
  }
  if (lat == null || lng == null) {
    return '<span class="ent-off" title="no position was recorded for this end">—</span>';
  }
  return '<span class="ent-off" title="the fleet has never driven near enough to this spot '
    + `to have a name for it">${esc(Number(lat).toFixed(3))}, ${esc(Number(lng).toFixed(3))}</span>`;
};
const segPlaces = (r) => '<span style="white-space:nowrap">'
  + segPlace(r.start_place, r.start_lat, r.start_lng)
  + '<span class="dim"> → </span>'
  + segPlace(r.end_place, r.end_lat, r.end_lng) + '</span>';

/* AED, and never under the word cost: it is the revenue those kilometres would
   have earned had they been sold. The rate is on the row so the tooltip can
   state it — a money figure whose rate is unstated is what this product spent
   a month removing from its money pages. */
const segForgone = (r) => (r.forgone_aed == null
  ? `<span class="ent-off" title="${esc(r.rate_basis || 'no distance was measured across this interval')}">—</span>`
  : `<span title="${esc(r.rate_basis || '')}">AED ${fmt(r.forgone_aed, 0)}</span>`);

/* The journey's own clock, and the car's replay of the day behind it. Linked
   through tripTime() — the same destination a booking's timestamp gives on the
   Trips tab — because the first thing an operator does with a journey nobody
   booked is watch the car drive it. */
const segWhen = (r) => tripTime(r.plate, r.started_at)
  + `<span class="dim"> → ${esc(timeStr(r.ended_at))}</span>`
  + (r.duration_min == null ? '' : `<span class="dim"> · ${fmt(r.duration_min)} min</span>`);

/* WHICH RULE NAMED THIS PERSON, IN FOUR WORDS.
   The tier pill is deliberately UNCOLOURED, and that is not an oversight.
   Every other pill in this product encodes good or bad; a colour ramp down a
   column of tiers would rank people by how strongly the product suspects them,
   which is precisely the choice api/unauthorized_sql.js's ladder refuses to
   make. The distinction is carried in words, and the working is in the
   evidence column beside it. */
/* FIVE RUNGS. `last_trip` — the operator's own rule, and the rung that carries
   most of this list — was added to the ladder in api/unauthorized_sql.js and
   this map was not updated with it, so a row on it rendered its raw key. */
const TIER_LABEL = { bracketed: 'named by time', last_trip: 'last trip on the car',
  sole_custodian: 'sole custodian', ambiguous: 'one of several', unknown: 'nobody named' };
const tierPill = (r, means) => pill(TIER_LABEL[r.attribution_tier] || r.attribution_tier || '—',
  null, means?.[r.attribution_tier] || null);

/* THE EVIDENCE, ON THE SCREEN AND NOT IN A TOOLTIP.
   ─────────────────────────────────────────────────────────────────────────
   api/public/ui.js says it about pills — "a fact a reader has to hover to find
   is a fact most readers never see" — and it matters more here than anywhere
   else in the product: the sentence IS the claim. api/public/segments.js clips
   its `Why` column to eighty characters because a reconciler's reason is
   context; this is the working behind a name beside a theft, and a reader has
   to be able to check it against the car's own trip list without first
   discovering that there is something to check.

   Everything the endpoint deliberately keeps OUT of the candidate list is
   printed here, dimmed and labelled: the clock skew that made time unusable,
   Uber's status feed (corroboration, never attribution), and the nearest
   booking — which names a person for free and must never be read as one. */
/* BOUNDED AT BOTH ENDS, AND THE LOWER BOUND IS THE ONE THAT WAS MEASURED.
   ─────────────────────────────────────────────────────────────────────────
   A max-width alone was wrong, and the first render of this tab proved it. On
   the ambiguous table — which carries a Candidates column holding two full
   names — the browser gave the evidence column the width left over, which was
   about four characters: the sentence wrapped to roughly a hundred lines and
   each row stood 300 pixels tall. A max-width tells a table what a cell may
   not exceed and says nothing about what it must claim, and the table's own
   algorithm will always spend the width on the columns that cannot wrap.

   So the span carries a min-width as well. The cell then claims a readable
   measure, the table gets wider than the panel, and .tscroll scrolls it
   sideways with the fade cue api/public/ui.js scrollCue() draws — which is the
   behaviour every wide table in this product already has, and is far better
   than a legible-in-principle sentence nobody can read. */
const EV = 'display:block;min-width:30ch;max-width:56ch';
/* THE ONE SENTENCE THAT MUST NEVER BE A TOOLTIP STAYS IN THE CELL; the rest
   goes behind a disclosure.
   ─────────────────────────────────────────────────────────────────────────
   Measured in Chromium on a driver with one attributed journey: at 1,440px the
   row stood 284px tall with the evidence column at 377px; at 1,280px the same
   ONE row was 418px tall with the column squeezed to 271px — more than a third
   of the viewport for one journey, with every other cell floating in ~200px of
   vertical whitespace. Four stacked paragraphs in a cell bounded at 30ch set
   the height of the whole row. The attribution sentence is the claim and stays
   on the screen; the clock skew, the status feed and the nearest booking are
   context and open on demand. */
const segMore = (html, n) => (html
  ? `<details style="margin-top:4px"><summary class="dim" style="cursor:pointer">`
    + `${n} more note${n === 1 ? '' : 's'} on this journey</summary>${html}</details>`
  : '');
const segEvidence = (r) => {
  const lines = [`<span class="wrap" style="${EV}">${esc(r.attribution_evidence
    || 'No evidence sentence was recorded for this journey, which is itself a fault — a name '
     + 'with no working behind it is exactly what this tab exists to prevent.')}</span>`];
  if (r.clock_skew_min != null) {
    lines.push(`<span class="wrap dim" style="${EV}">This tracker’s clock is ${fmt(r.clock_skew_min)} `
      + 'minutes behind, so no booking on any channel could honestly be compared against this '
      + 'window by time. That is why nothing here is named by time.</span>');
  }
  /* Rendered per row ONLY when it differs from the one hoisted to the panel.
     driver_status_event is append-only from 2026-09-14 with no backfill, so
     the server returns the identical sentence for essentially every row —
     "Uber's own driver-status feed holds nothing yet, so nothing here either
     confirms or contradicts the name above." — and the cell repeated one
     three-line paragraph down the whole table, in the narrowest column on the
     page, competing for width with the evidence sentence, which does differ. */
  if (r.status_note && r.status_note !== r._hoisted_status) {
    lines.push(`<span class="wrap dim" style="${EV}">${esc(r.status_note)}</span>`);
  }
  /* THE NEAREST BOOKING'S DRIVER NAME IS NOT PRINTED HERE, AND THAT IS THE
     WHOLE POINT OF THE LINE.
     ─────────────────────────────────────────────────────────────────────
     This cell used to end `… The booking is on Uber, driven by <name>.` — and
     the server's own `means` string, immediately before it, ends "…so this
     name is deliberately absent from the candidate list above". The UI printed
     the name the sentence had just said was withheld, and it printed it LAST,
     directly beneath the stacked candidate list, on a panel whose warn box
     reads "Nobody is accused here … every candidate is listed and none is
     chosen". The nearest booking is very often one of those candidates, so a
     reader who read the paragraph to the end was handed the tiebreaker the
     ladder had refused to make — off a pointer whose median gap over
     production's 106 populated rows is 97 minutes and whose maximum is 11,309,
     and which by construction did NOT explain the journey. On production
     nearest_trip_id is populated on 106 of 120 segments, so it fired on nearly
     every row.

     api/public/segments.js has never rendered it. Two surfaces, one ladder,
     one claim: the platform and the gap are context and stay; the name belongs
     on the segment page behind an explicit disclosure, not in the evidence
     cell of a row that lists candidates. */
  if (r.nearest_booking) {
    const nb = r.nearest_booking;
    lines.push(`<span class="wrap dim" style="${EV}">${esc(nb.means || '')} It is a `
      + `${esc(sourceLabel(nb.platform))} booking. Its driver is deliberately not named here: `
      + 'it did not explain this journey, so naming them would offer a tiebreaker the evidence '
      + 'does not support.</span>');
  }
  return lines[0] + segMore(lines.slice(1).join(''), lines.length - 1);
};

/* Every candidate, in the order the server sent them — which is NAME order,
   never trip count and never is_primary, because any ordering the evidence
   knows is read as a ranking. Rendered through entity() so each one is
   openable: a reader who wants to argue with a name has to be able to go and
   look at that person. */
const segCandidates = (r) => {
  const c = r.attribution_candidates || [];
  if (!c.length) {
    return '<span class="ent-off" title="no booking on any channel names a driver for this car '
      + 'on this day, so there is nobody to offer">nobody</span>';
  }
  /* ONE PER LINE, not comma-joined, and the reason is measured rather than
     aesthetic: joined on one line the column claimed ~290px of a 1,440px page
     and pushed the evidence sentence off the right edge of the table entirely.
     Stacked, the column is the width of the longest single name and the
     sentence that says "every candidate is listed; none is chosen" stays on
     the screen beside the names it is about. It also reads as a LIST, which is
     what it is — two people the record cannot separate, not a pair. */
  return c.map((x) => `<span style="display:block">${entity('driver', x.id, x.name)}</span>`).join('');
};

/* One table shape for both lists, because the difference between them is the
   HEADING and the sentence above it, never the columns. `candidates` adds the
   column that names everyone in the frame, which is the whole content of the
   second list and redundant in the first — there, the person whose page this
   is IS the candidate. */
/* THE TIER RIDES IN THE FIRST CELL AS WELL AS IN ITS OWN COLUMN.
   ─────────────────────────────────────────────────────────────────────────
   Seven columns, with Named-by sixth and The-evidence seventh. At phone width
   .tscroll keeps the first three, so the two cells that QUALIFY the accusation
   were the first to disappear behind a sideways scroll: rendered at 430px both
   tables printed "Scroll the table sideways for 5 more columns: … Named by,
   The evidence", and what a phone showed was a journey date, a duration and a
   plate under a heading naming one person. A screenshot taken on a phone was a
   list of journeys attached to a named person with every qualifier off-screen,
   which is exactly the artefact the tier-in-front-of-the-name discipline
   exists to prevent — and the Trips tab already solves it the same way, with
   its "no booking" pill above the timestamp. */
const unexplainedTable = (rows, { means, candidates = false, sortId }) => tableFrom(rows, [
  { label: 'Journey', key: 'started_at',
    render: (r) => `<span class="dim" style="display:block;font-size:11px" title="${
      esc(means?.[r.attribution_tier] || '')}">${esc(TIER_LABEL[r.attribution_tier]
      || r.attribution_tier || 'no rung reached')}</span>${segWhen(r)}` },
  { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
  { label: 'From → to', key: 'start_place', render: segPlaces },
  /* Null is not zero. A journey with no measured distance did not travel
     nothing — it was not measured, and "0 km" beside an occupancy verdict is a
     claim that the car did not move. */
  { label: 'Distance', key: 'distance_km', num: true,
    render: (r) => (r.distance_km == null
      ? '<span class="ent-off" title="no distance was measured across this interval">—</span>'
      : `${fmt(r.distance_km, 1)} km`) },
  { label: 'Worth', key: 'forgone_aed', num: true, render: segForgone },
  /* Keyed on the COUNT so the column sorts by how many people are in the
     frame, but deliberately not `num`: that right-aligns the cell, and a
     stacked list of names ragged against the right edge reads as a figure
     rather than as a list of people. */
  ...(candidates
    ? [{ label: 'Candidates', key: 'attribution_candidate_count',
      render: (r) => segCandidates(r) }]
    : [{ label: 'Named by', key: 'attribution_tier', render: (r) => tierPill(r, means) }]),
  { label: 'The evidence', key: 'attribution_evidence', render: segEvidence },
], { sortable: true, sortId, defaultSort: { key: 'started_at', dir: 'desc' },
  /* The row opens the SEGMENT, which is where the case for and against it is
     argued in full. A name on this page that leads nowhere is a name nobody
     can check. */
  onRow: (r) => { location.hash = href('segment', r.plate, r.started_at); } });

/* ── tab: unexplained trips ───────────────────────────────────────────────
   Asked for in these words: "we can get the unauthorized trips on the time and
   date and we can match who drove that car using uber and put it on their
   profile along with another tab of all unauthorized trips".

   THREE DISCIPLINES, AND THEY ARE THE WHOLE DESIGN OF THIS TAB.

   1. THE TWO LISTS ARE NEVER ONE TABLE. /api/driver/unauthorized returns
      `attributed` and `also_a_candidate` as separate objects with separate
      totals and separate sentences precisely so that a page cannot print them
      under one heading and one count — and the count is what gets quoted. A
      journey this person is NAMED beside and a journey they are one of three
      people who held the car on are two different claims about them, and
      mixing them turns a maybe into an accusation. Two panels, the second
      below the first, under a heading that says in words that no claim is
      being made.

   2. AN EMPTY TAB IS NEVER AN EXONERATION. CABMAN is a five-minute realtime
      poll with no history behind it and it is configured for Ecosine only:
      measured over 2026-06-01..2026-09-16, 27 of 108 days carry any segment at
      all. So "nothing found" and "nothing was looked at" are different facts
      about a person, and coverage.note — which states which one this is — is
      printed ABOVE the tables rather than under them. The empty state says
      which of the two it is and never implies a check that did not run.

   3. THE CONTRACT TRAVELS WITH THE NAMES. `note` on the response is the
      sentence that says every name here is an inference; it is rendered on the
      page, not left in the JSON. */
async function tabUnauthorized(root, id) {
  const p = panel('Journeys with no booking against them',
    'What the seat sensor saw with a passenger aboard that no channel booked — and the rule '
    + 'that put this person’s name beside it');
  root.append(p.panel); loading(p.body);

  let res;
  try { res = await qAll('/api/driver/unauthorized', { id }); }
  catch (e) {
    p.body.innerHTML = '';
    /* ABSENT WITH A REASON, and the reason is about US. A failed request and a
       driver with no unexplained journey are different facts, and a blank
       panel is indistinguishable from the second. */
    p.body.append(note('The unexplained-journey list could not be loaded just now. This says '
      + 'nothing about whether this person has any — the request for it failed.', 'warn'));
    return;
  }

  /* A 200 CARRYING THE WRONG BODY IS A FAILURE, NOT A MEASURED EMPTINESS.
     ───────────────────────────────────────────────────────────────────────
     The try/catch above defends against a THROWN request. It does nothing
     about a response that arrives 200 with a shape this tab cannot read — a
     bare `[]` from a mock's catch-all route, a proxy or a cache that rewrote
     the body, a deploy where the endpoint is not there yet. The three
     `res.x || {…}` defaults below silently converted that into a clean record:
     cov.days_with_data came back `undefined`, so the `=== 0` test further down
     was FALSE and the page took the "we looked and found nothing" branch
     instead of the "nothing was looked at" branch, and then printed two
     positive factual claims about data it had never fetched — "No unexplained
     journey in this window names this person, across the 0 of 0 days the seat
     sensor actually watched. That is what was measured" and "On every
     unexplained journey in this window where this person held the car, the
     record named them alone or named somebody else."

     Every driver in the fleet, exonerated in writing by a request that
     returned nothing. So the shape is checked, and a body that does not carry
     it takes the same path a thrown request takes. */
  if (!res || !res.attributed || !res.attributed.rows || !res.coverage) {
    p.body.innerHTML = '';
    p.body.append(note('The unexplained-journey list came back in a form this page cannot read, '
      + 'so nothing below was loaded. This says NOTHING about whether this person has any '
      + 'unexplained journeys — it is a failure of the request, not a finding about them. Try '
      + 'again, or check that the attribution service is deployed.', 'warn'));
    return;
  }

  const att = res.attributed;
  const cand = res.also_a_candidate || { rows: [], total: 0 };
  const cov = res.coverage;
  p.body.innerHTML = '';

  /* Above everything, because it changes how every count below is read. */
  if (cov.note) p.body.append(note(cov.note, 'warn'));
  p.body.append(note(res.note));

  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] == null ? 0 : Number(r[k])), 0);
  /* THE MONEY IS SPLIT BY RUNG, because the tile is the most quotable object
     on the tab and it is the one that reads as a debt this person owes.
     ───────────────────────────────────────────────────────────────────────
     "Revenue forgone AED 811", in warning colour, summed bracketed +
     last_trip + sole_custodian with a sub-line naming only the rate. Every one
     of the eight contributing rows on the measured example was sole_custodian,
     and the product's own words for that rung are "this is custody, not
     driving". A manager quoting AED 811 has converted eight custody records
     into a monetary claim, with the qualifier one tile to the left. */
  const byTime = att.rows.filter((r) => r.attribution_tier === 'bracketed');
  const byRule = att.rows.filter((r) => r.attribution_tier !== 'bracketed');
  const km = sum(att.rows, 'distance_km');
  const aed = sum(att.rows, 'forgone_aed');
  const kmTime = sum(byTime, 'distance_km');
  const aedTime = sum(byTime, 'forgone_aed');
  p.body.append(kpiRow([
    { label: 'Named beside', value: fmt(att.total), key: 'unauth-attributed',
      tone: att.total ? 'warn' : null,
      sub: att.total ? 'journeys no channel booked' : 'no journey in this window names them' },
    { label: 'Named by time', value: fmt(att.by_tier?.bracketed || 0),
      sub: 'their own Uber trips bracket the window' },
    { label: 'Last trip on the car', value: fmt(att.by_tier?.last_trip || 0),
      sub: 'the operator’s rule — theirs was the last Uber trip on that car before the '
        + 'journey. An inference from the car’s record, not about this journey' },
    { label: 'Sole custodian', value: fmt(att.by_tier?.sole_custodian || 0),
      sub: 'only person holding the car that day — custody, not driving' },
    { label: 'One of several', value: fmt(cand.total), key: 'unauth-candidate',
      sub: cand.total ? 'no claim is made on these' : 'none in this window' },
    { label: 'Distance', value: km ? `${fmt(km, 1)} km` : '—',
      sub: kmTime === km
        ? 'all of it across journeys narrowed to this person BY TIME'
        : `${fmt(kmTime, 1)} km across journeys narrowed by time · `
          + `${fmt(km - kmTime, 1)} km across journeys where the car’s own day, not this `
          + 'journey, put their name here' },
    /* Revenue forgone, never "cost": the fuel and wear behind these kilometres
       is a different, smaller number this product cannot measure. And never
       one figure across three rungs — see the block above. */
    { label: 'Revenue forgone', value: aed ? money(aed, 'AED', 0) : '—',
      /* NO WARNING COLOUR unless the whole of it rests on a time measurement.
         A tone is read as a verdict, and most of this figure is custody. */
      tone: aed && aedTime === aed ? 'warn' : null,
      sub: res.value?.aed_per_km == null ? 'no rate exists for this window'
        : `${money(aedTime, 'AED', 0)} across journeys narrowed to this person BY TIME · `
          + `${money(aed - aedTime, 'AED', 0)} across journeys named off the car’s own day `
          + 'instead — custody is not driving, and this second figure is not a debt anybody '
          + `owes. Both at AED ${res.value.aed_per_km}/km, the fleet’s own rate here. Revenue `
          + 'forgone, not money paid out.' },
  ]));

  /* THE STATUS-FEED SENTENCE, ONCE, WHEN IT IS THE SAME ON EVERY ROW.
     driver_status_event is append-only from 2026-09-14 with no backfill, so
     the server returns one identical sentence for essentially every row. It
     was rendered per row, three wrapped lines each, in the narrowest column on
     the page, saying nothing that differed between them. */
  const allRows = att.rows.concat(cand.rows);
  const notes = [...new Set(allRows.map((r) => r.status_note).filter(Boolean))];
  const hoisted = notes.length === 1 && allRows.every((r) => r.status_note) ? notes[0] : null;
  if (hoisted) {
    allRows.forEach((r) => { r._hoisted_status = hoisted; });
    p.body.append(el('p', 'cap', `Uber’s own driver-status feed, on every row below: ${hoisted}`));
  }

  /* ── what this person is NAMED beside ─────────────────────────────────── */
  const a = panel(att.heading, att.means);
  root.append(a.panel);
  if (att.rows.length) {
    a.body.append(unexplainedTable(att.rows, { means: res.tier_means, sortId: 'dunauth' }));
  } else {
    /* THREE DIFFERENT ABSENCES, THREE DIFFERENT SENTENCES. A single "none
       found" here would read as a clean record, and on two of the three it
       would be a clean record nobody measured. */
    empty(a.body, cov.days_with_data === 0
      ? 'No seat-occupancy evidence exists for this window at all, so this is not a record of '
        + 'nothing found — nothing was looked at. Widen the range, or read the note above.'
      : cand.total
        ? 'No journey in this window is attributed to this person. They are one of several '
          + `candidates on ${fmt(cand.total)} ${plural(cand.total, 'journey', 'journeys')}, listed `
          + 'separately below — and being a candidate is not being named.'
        /* THE DAYS ARE NOW COUNTED OVER THE CARS THIS PERSON HELD.
           ─────────────────────────────────────────────────────────────────
           This sentence used to print coverageOf()'s FLEET-WIDE day count —
           days on which ANY car in the fleet produced a segment — as though it
           were a statement about them. A driver whose cars carry no sensor at
           all read as "across the 27 of 108 days the seat sensor actually
           watched": an exoneration nobody measured, which is the mirror of the
           accusation nobody measured that the rest of this tab exists to
           avoid. The endpoint now scopes the count to their own plates and
           says so in `coverage.scope`; this prints what it was actually a
           count over, and refuses to print a measurement sentence at all when
           either number is missing. */
        : (cov.days_with_data == null || cov.days_in_window == null
          ? 'No unexplained journey in this window names this person. How many days the seat '
            + 'sensor covered could not be measured here, so this is not a statement about '
            + 'the days it did not cover.'
          : `No unexplained journey in this window names this person, across the ${fmt(cov.days_with_data)} `
            + `of ${fmt(cov.days_in_window)} days the seat sensor watched ${
              esc(cov.scope || 'the cars this person held')}. That is what `
            + 'was measured; it is not a statement about the days it did not cover.'));
  }

  /* ── …and what they are merely one of several candidates for ──────────── */
  const c = panel(cand.heading, cand.means);
  root.append(c.panel);
  if (cand.rows.length) {
    /* The strongest wording on the page, above the table rather than under it.
       This list exists to be read as NOT an accusation, and a heading alone
       has never stopped a table being quoted as one. */
    c.body.append(note('Nobody is accused here. Each of these journeys has more than one person '
      + 'who held the car that day and nothing in the record separates them, so every candidate '
      + 'is listed and none is chosen. These rows must never be counted together with the ones '
      + 'above.', 'warn'));
    c.body.append(unexplainedTable(cand.rows, { means: res.tier_means, candidates: true, sortId: 'dunauthc' }));
  } else {
    empty(c.body, cov.days_with_data === 0
      ? 'Nothing was looked at in this window — see the note at the top of the page.'
      : 'On every unexplained journey in this window where this person held the car, the record '
        + 'named them alone or named somebody else. There is no journey here they are merely a '
        + 'candidate for.');
  }

  /* The totals above are counted over the window by the endpoint, so they are
     exact even when the tables are short. The response says which in words. */
  if (res.total_basis) c.body.append(el('p', 'cap', res.total_basis));
}

/* ── the window said out loud, once, above every tab ──────────────────────
   THE DEFECT THIS EXISTS FOR.
   ═══════════════════════════════════════════════════════════════════════════
   MEASURED on production for Muhammad Nadeem Ajmal (Uber
   e3cd308b2b5f48e19877b924b48bbb9d) over 2026-09-01..2026-09-16:

     /api/driver/profile   span.trips 0, span.days_worked 0, span.last_trip null
                           accounts[0] uber, trips 1203, last_trip 2026-03-29
     /api/driver/kpis      trips 0, days_worked 0, priced_trips 0, revenue null
     /api/driver/mix       {distance:[], product:[], payment:[], status:[], platform:[]}

   Nothing there is wrong. The person genuinely did not work in September; their
   last trip was in March. But the page rendered as a wall of em dashes with one
   bold "AED 0" in the middle of it, and the operator who opened it asked what
   had broken — because NINE panels each said a different narrow thing about
   their own missing figure and not one of them said the single fact that
   explains all nine.

   So it is said ONCE, here, and the panels underneath are left exactly as they
   are. Three reasons this is the shell and not the tabs:

     · the fact is already on the wire. renderDriver has awaited
       /api/driver/profile before it paints anything, and `span` + `accounts`
       carry the whole sentence — no second request, no waiting on a tab.
     · `prof` already reaches all eight tabs (`await fn(body, id, prof)`), so a
       per-tab variant needs no plumbing. Writing it eight times is exactly how
       the fleet pages and this page came to disagree about money in the first
       place; the tab only chooses a tail clause.
     · it is an APPEND into an empty container. Nothing below is deleted, so an
       operator who widens the range still has their page.

   TWO CASES, TWO SENTENCES, deliberately. "A quiet month" and "no work on
   record at all" are different facts about a person, and one sentence covering
   both would be a sentence that is vague about which of them is true — which is
   the same defect as a zero nobody measured, in prose.

   WHAT IT DOES NOT SAY. It does not compute the window's start date to print
   "156 days before it opens". The client is not allowed a second implementation
   of the calendar — `period=month` is resolved by api/window.js and nothing in
   this payload carries the resolved dates — so the gap is stated against TODAY,
   which is a date the browser genuinely knows, and the window is named with
   windowLabel() rather than dated. A true smaller fact beats a fabricated
   larger one. */
const EMPTY_WINDOW_TAIL = {
  earnings: 'No money reached them for these dates either, and the tiles below say which figures '
    + 'were never measured and which were reported as nought.',
  activity: 'The day-by-day table below still lists every date any feed reached, with nothing on them.',
  territory: 'There is nowhere to plot them.',
  quality: 'There is no trip to have completed or cancelled.',
  trips: 'There are no rows.',
  /* No tail. Every other entry here explains what the ABSENCE OF WORK means
     for that tab, and on Money it means nothing at all: the ledger is not
     built from trips, so a window with no trips in it says nothing about what
     this driver owes. A sentence would have to invent a connection that is not
     there. */
};

export function emptyWindowNote(prof, tab) {
  const span = prof?.span;
  /* `trips` absent is not `trips` zero. A payload that never carried the count
     is a thing we do not know, and this banner asserts something about the
     window; it says nothing where it was told nothing. */
  if (!span || span.trips == null || +span.trips > 0) return null;
  const { evTrips, lastEver, accounts, accountsWithTrips } = personRecord(prof);
  const win = windowLabel();
  const tail = EMPTY_WINDOW_TAIL[tab] ? ` ${EMPTY_WINDOW_TAIL[tab]}` : '';

  /* CASE 2 — nothing on record, ever. Both tests, because they fail
     independently: an account row can carry trips 0 with a last_trip, and a
     channel that has never filed a trip has neither. */
  if (!evTrips && !lastEver) {
    return `No channel has ever reported a trip for this driver — not in ${win}, and not in any `
      + `window before it. They hold ${countOf(accounts, 'platform account')} and `
      + `${accountsWithTrips ? 'none of them has' : 'not one of them has'} taken a booking we hold, `
      + 'so the panels below are empty because there is no work on record at all, which is not the '
      + `same as a period they happened not to work.${tail}`;
  }

  /* CASE 1 — a record, and none of it in this window. */
  const t = lastEver ? Date.parse(lastEver) : NaN;
  const ago = Number.isFinite(t) ? Math.floor((Date.now() - t) / 864e5) : null;
  const when = lastEver
    ? `Their last was on ${dateStr(lastEver)}`
      + (ago != null && ago > 0 ? `, ${countOf(ago, 'day')} ago` : '')
    : 'No trip on their record carries a date';
  const record = evTrips
    ? `, and ${countOf(evTrips, 'trip')} ${plural(evTrips, 'sits', 'sit')} on their record`
    : '';
  /* THE CLOSING CLAUSE IS NOT TRUE ON EVERY TAB.
     ─────────────────────────────────────────────────────────────────────────
     "Every figure below is measured over those dates, so what is missing here
     is the work, not the record of it" is the right sentence on seven tabs and
     wrong on one. The Record tab is not windowed at all — it reads whole weeks
     and months from /api/performance/driver — and for this very driver that
     endpoint answers 404, so the banner asserted the record was intact
     directly above a warn strip saying the record could not be read. Two
     sentences contradicting each other in adjacent paragraphs is worse than
     either of them alone. */
  /* AND IT IS WRONG ON MONEY FOR A DIFFERENT REASON AGAIN. A balance is a
     POSITION, not a measurement over a span: what this driver owes today is
     what they owe today whether or not they drove in the window on the
     toolbar. Saying "every figure below is measured over those dates" above a
     tab carrying a cash position and an advance balance would tell a reader
     the figures are windowed when they are not — and the reader who believes
     it concludes the driver owes nothing because they did not work in
     September. */
  const closing = tab === 'record'
    ? 'Nothing below is measured over those dates: a record is read over whole weeks and months of '
      + 'this person’s work, so what this tab shows is governed by what has been built for them '
      + 'and not by the window on the toolbar.'
    : tab === 'money'
      ? 'The windowed panel and the register of entries below are measured over those dates; '
        + 'the tiles under "Where they stand" are not. What somebody owes is '
        + 'a POSITION and not a figure over a span — an advance taken in June is still '
        + 'outstanding in a window they did not work, and a balance that went quiet is not a '
        + 'balance that went away — so the figures under "Where they stand" stand as they are '
        + 'now, whatever window is chosen, while what a driver earned and the cash that moved '
        + 'are flows and belong to the dates that name them.'
    : 'Every figure below is measured over those dates, so what is missing here is the work, not '
      + 'the record of it.';
  return `No trip of this driver's falls in ${win}. ${when}${record}. ${closing}${tail}`;
}

const TABS = { overview: tabOverview, activity: tabActivity, territory: tabTerritory,
  earnings: tabEarnings, quality: tabQuality, record: renderDriverRecord,
  money: renderDriverLedger, trips: tabTrips,
  unauthorized: tabUnauthorized };

/* ── page shell ──────────────────────────────────────────────────────────── */
/* THE ADDRESS IS THE PERSON; THE ACCOUNT IS A DOOR INTO IT.
   ═══════════════════════════════════════════════════════════════════════════
   `addr` is the second slot of the hash and it is now one of two things:

     #driver/p412          a PERSON id — the canonical address.
     #driver/<ext_id>      a PROVIDER ACCOUNT id — every link ever made.

   The second still works and always will: there are links to it in this
   product, in bookmarks, and in messages sent to people who are not reading
   this. It resolves to the person and renders the identical page, then the
   address in the bar is rewritten to the canonical form (in place — see
   rewriteParam in api/public/data.js for why it is not a navigation), so what
   the reader copies from here is the id that does not move.

   TWO IDS ARE IN PLAY AFTER THE PROFILE LANDS, and conflating them would have
   been the easy mistake:

     `id`   the provider account every OTHER endpoint on this page keys on.
            /api/driver/kpis, /daily, /territory and the rest take ?id= and
            mean an account; that is unchanged and deliberately so, because a
            person id and a Yango account id are both bare digits and a route
            that guessed between them would one day answer the wrong person.
     `canon` what the page LINKS by — the tab bar, the day rows, the record
            tab's grain switch. The person address where the spine has placed
            the account, the account id where it has not, and what `addr` is
            rewritten to once the profile has landed.

   An account the spine has not placed is NOT an error and does not lose its
   page: it keeps its provider address, renders exactly as it did before, and
   the identity card states which of the three not-placed states it is in. */
export async function renderDriver(root, addr, tab = 'overview') {
  /* Addressed with no id — a typed URL, a stale bookmark, a link whose id
     never got filled in. It went to the endpoint and printed the API's own
     complaint. #day has always answered this properly; these four did not. */
  if (!addr) return noneChosen(root, 'driver', 'drivers', 'Every driver');
  const askedPerson = personIdOf(addr);
  const gen = currentGen();
  const head = el('div'); root.append(head); loading(head);
  const body = el('div', 'stack'); root.append(body);

  let prof;
  try {
    prof = await qAll('/api/driver/profile',
      askedPerson != null ? { person: askedPerson } : { id: addr });
  }
  catch (e) {
    /* Two different misses, two different sentences. "Nothing matches this id"
       under a person address sends the reader looking for a provider record
       that was never what they asked for. */
    head.innerHTML = askedPerson != null
      ? `<div class="empty"><b>No such person</b>The person register holds no p${esc(String(askedPerson))}.
        A person id is not a provider account id — if this link came from somewhere else it may be
        naming an account, which goes in the address without the p.
        <a class="lnk" href="${href('drivers')}">Back to all drivers</a></div>`
      : `<div class="empty"><b>No such driver</b>Nothing in the record matches this id.
      <a class="lnk" href="${href('drivers')}">Back to all drivers</a></div>`;
    return;
  }
  /* The account the tab endpoints are asked about. `prof.id` is the account
     the server resolved — the canonical one when the address named a person,
     the one in the address when it named an account — so both addresses ask
     every panel below the identical question. */
  const id = prof.id || (askedPerson != null ? null : addr);
  /* And the address the reader should end up with. */
  const canon = prof.person_id != null ? personAddr(prof.person_id) : (prof.id || addr);
  if (canon !== addr) rewriteParam(canon);
  head.innerHTML = '';
  head.append(identityCard(prof));
  /* A PERSON WITH NO LIVE PLATFORM ACCOUNT stops here, and the card has
     already said why. Every endpoint below keys on a provider account id;
     there is none, so asking them would put nine "could not load this panel"
     strips under a card that has just explained, correctly, that there is
     nothing on a provider's side to load. The register is the only thing that
     knows this person, and it is in the card. */
  if (!id) return prof;
  /* The live strip, fetched separately and never blocking the page.
     /api/status/driver is on api/cache.js's NEVER list — a cached live status
     is a wrong live status — so it is its own request rather than a field on
     the profile, which IS cached and should stay that way. */
  const live = el('div'); head.append(live);
  qAll('/api/status/driver', { id })
    .then((st) => { if (alive(gen)) { live.innerHTML = ''; live.append(statusStrip(st)); } })
    /* ABSENT WITH A REASON, not a blank. A strip that silently fails to load
       is indistinguishable from a driver with no live status, and those are
       different facts — one is about the driver and one is about us. */
    .catch(() => { if (alive(gen)) { live.innerHTML = ''; live.append(statusStrip(
      { absent: 'The live status could not be loaded just now. This says nothing about '
        + 'whether the driver is online — the request for it failed.' })); } });
  /* The tab bar links by the CANONICAL address, not by the account that
     happened to open the page. This is the one place in the product that
     always knows the person id, so a reader who arrives on an account link
     and clicks a tab leaves with the stable address in their bar. */
  head.append(tabBar(DRIVER_TABS, tab, (t) => href('driver', canon, t === 'overview' ? null : t)));
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
  /* FIRST CHILD OF THE SCROLLING COLUMN, above the KPI row, on every tab.
     `body` is still empty here, so this lands directly under the tab bar and is
     the first thing read after the tab that was clicked — and every panel below
     it renders exactly as it did before. See emptyWindowNote for why the
     sentence lives in one place rather than in eight tabs.

     NO TONE. `.note.warn` on this page means "we failed" (the live-status catch
     below) or "nobody is accused here" (the unexplained-journeys panel). A
     person who took six months off is neither, and painting their page amber
     would make the honest answer look like an incident. */
  const ew = emptyWindowNote(prof, tab);
  if (ew) body.append(note(ew));
  const fn = TABS[tab] || tabOverview;
  await fn(body, id, prof);
  return prof;
}

/* ── the directory that links into the pages above ───────────────────────── */
export async function renderDriverDirectory(root) {
  /* The generation this render belongs to, so a late answer from a background
     fetch cannot write into a page the reader has already navigated away
     from — the same guard every other late fetch in this file uses. */
  const gen = currentGen();
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
    'Everyone on the books, even people with no trip in this window. Click a row to open it.');
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
  /* THE SUPPORTED NUMBER, AND THE BACKLOG BESIDE IT.
     ─────────────────────────────────────────────────────────────────────
     This count is now one row per person from the spine (src/persons.js),
     built from reviewed decisions only. Before that it folded on a NAME as
     well, which made 92 of its 347 rows — 44 backed by a matching phone, 37
     on no evidence, and nine CONTRADICTED by different phone numbers on the
     records they joined.

     Removing that rule pushes the count UP, to what the evidence supports.
     Printing the higher number alone would read as a regression, so the pairs
     now awaiting an answer are named next to it: the backlog is the reason
     the count is what it is, and saying so is what makes it get worked. */
  let pendingPairs = null;
  let spinePeople = null;
  const summary = (n) => `${fmt(n)} of ${fmt(rows.length)} drivers`
    + (n === rows.length
      /* THE PAGE CHECKS ITSELF AGAINST THE SPINE.
         ───────────────────────────────────────────────────────────────
         This query was capped at 800 accounts for months. On 2026-09-21 the
         roster reached 810, and the page — headed "Everyone on the books" —
         quietly stopped showing three people. Nothing said so, because a
         count of the rows it fetched agrees with itself whatever the cap
         dropped.
         So it compares its own row count with the number of people the spine
         holds, and says when they differ. A cap that bites is then visible
         the day it does rather than the month somebody notices. */
      ? (spinePeople != null && spinePeople !== rows.length
        ? ` · showing ${fmt(rows.length)} of ${fmt(spinePeople)} people on the books`
        : '')
        + (pendingPairs ? ` · ${fmt(pendingPairs)} pairs awaiting review` : '')
        + ` · ${fmt(active.length)} drove in this window`
        + (idle.length ? ` · ${fmt(idle.length)} did not` : '')
        + (never.length ? ` · ${fmt(never.length)} never have` : '')
        + (expired.length ? ` · ${countOf(expired.length, 'expired licence')}` : '')
        + (notFilled.length ? ` · ${fmt(notFilled.length)} with no real licence date on file` : '')
      : '');
  bar.querySelector('#dn').textContent = summary(rows.length);
  /* Fetched after the count is on screen and never blocking it: a backlog
     figure is context, and a directory that waited for it would be slower for
     everybody to tell them something only sometimes true. */
  qAll('/api/same-person', { counts: 1 })
    .then((c) => {
      if (!alive(gen) || !c) return;
      pendingPairs = c.pending || null;
      spinePeople = c.people ?? null;
      if (!pendingPairs && spinePeople === rows.length) return;
      const host = bar.querySelector('#dn');
      if (host) host.textContent = summary(rows.length);
    })
    .catch(() => { /* the count is context; its absence is not worth a banner */ });

  // the top few as cards, because a leaderboard is read as a ranking
  grid.innerHTML = '';
  active.slice(0, 6).forEach((r, i) => {
    const c = el('a', 'dircard');
    c.href = href('driver', r.driver_ext_id);
    c.innerHTML = `
      <div class="rank">${i + 1}</div>
      ${avatar(r.driver_name, r.picture_url, 'sm', r.photo_absent_reason)}
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
    /* The verdict in the CELL, at the same thresholds the driver page's own
       tile has always used. 434 rows of bare percentages give a reader nothing
       to scan for; the whole reason to open this table is to find the people
       whose week went badly. */
    { label: 'Completion', key: 'completion_pct', num: true,
      cellCls: (r) => { const t = completionTone(r.completion_pct); return t ? `v-${t}` : ''; },
      render: (r) => (r.completion_pct != null ? pct(r.completion_pct) : '—') },
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
