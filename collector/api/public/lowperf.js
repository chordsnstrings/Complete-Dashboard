/* THE LOW PERFORMERS PAGE, AND A WATCH LIST FOLLOWED.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-19, after the bottom-45 PDFs: "I want reports like
   this for the low performer on the platform … more comprehensive like this
   so that we can check their performance improvement as well" — and "don't
   keep drivers who only drives in hotel, or let us filter it out", and who
   belongs: "anyone who is earning less than the target per day".

   #low-performers[/FROM..TO[/HOTEL[.FLEET]]], top to bottom:
     00  BELOW TARGET — how many, by how far (under half, half to 80%, 80% to
         target), what they were asked and earned, everyone else beside them,
         and who is improving or slipping. The period, the hotel switch and
         the fleet are this page's own controls, carried in its address.
     01  THE LIST — furthest behind first, grouped by how far; per person the
         fares against the target, days active / driven / off, AED a day
         driven against the target a day, trips against the minimum, cash,
         Uber hours, the three weeks, and a written line.
     02  DAY BY DAY — the bottom-45 report's grid: every day's fares, shaded
         against THAT day's own target: at or above, half to target, under
         half; "off" for a day they were active and did not drive.
     03  WATCH LISTS — save this list on a day and follow it (#watchlist/ID).

   More granular, the same day ("this should have average of all the days
   shown for the driver as well. and more granular data on the page"): WHY
   THEY ARE BELOW TARGET above the list (each measured cause, how many carry
   it, its rule and everyone else's middle value); each name with its causes
   and a "Days ▸" that opens the driver (the causes in words, ten figures, a
   line a day, weekdays, hours against the fleet); the grid ending each row in
   both averages — a day active (a day off as nothing) and a day driven — with
   the day's asked, the list's and everyone else's figures under its head, a
   switch for the figure the cells print, and every figure a link to that
   driver's day; WHEN, the list and everyone else by weekday and by hour.

   #watchlist/ID[/A_B]: one list followed — the members before and after the
   save (or any two days or spans), each against everyone else's move, and
   the same grid with a line on the save day.

   Every figure is the server's (api/lowperf.js): the targets are the Month
   target page's, rule for rule, and the page adds nothing up that it was
   not sent. Absent, never zero: a class withheld from the reader's role, a
   day not settled, a week too short to judge — each is said in words.

   PRINT. "Print / PDF" prints the page as a landscape A4: the controls fall
   away and the grid fits the width; the browser's own "Save as PDF" makes the
   file. The landscape @page lives in a <style> this page adds while it is on
   screen and takes away when it is not (landscape() below). A CSS named page
   was tried first and Chromium broke the sheet wherever the name changed —
   the first PDF was the shell's header and the credentials banner stretched
   over a whole page, the list starting on the second. */
import { api, alive, currentGen, href } from './data.js';
import { el, esc, money, fils, countOf, sourceLabel, panel, secHead, loading, contract } from './ui.js';
import { fmt } from './charts.js';
import { withheldSentence } from './access_model.js';
import { downloadFile } from './target.js';
import { who, canDo, post } from './access.js';
import { dubaiDay } from './tz.js';

export const HOTEL_MODES = ['hide', 'mostly', 'show'];
export const HOTEL_WORD = {
  hide: 'Hotel-only drivers left out',
  mostly: 'Mostly-hotel drivers left out',
  show: 'Hotel drivers included',
};
const HOTEL_CHIP = { hide: 'Hide hotel-only', mostly: 'Hide mostly hotel', show: 'Show everyone' };
const FLEETS = ['ecosine', 'egari'];
const BAND_WORD = { lt50: 'Under half of target', lt80: 'Half to 80% of target', lt100: '80% to target' };
const TREND = {
  improving: { mark: '▲', word: 'improving', tone: 'tg-over' },
  slipping: { mark: '▼', word: 'slipping', tone: 'tg-under' },
  steady: { mark: '–', word: 'steady', tone: '' },
};
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (d) => DAY_RE.test(String(d || ''));
const aed = (v) => (v == null ? '—' : money(v));
const n0 = (v) => (v == null ? '—' : fmt(v));
const pc = (v) => (v == null ? '—' : `${fmt(v, 1)}%`);
const said = (cls, lvl) => withheldSentence(cls, { level: lvl === 'A' || lvl === 'M' ? lvl : '' });
const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const shortDay = (d) => {
  const t = new Date(`${d}T12:00:00Z`);
  return `${WD[t.getUTCDay()]} ${t.getUTCDate()} ${MON[t.getUTCMonth()]}`;
};
/* The page's content sits in its own stack: the router clones #view's
   attributes onto the next page's root (app.js freshView), so a class put on
   #view itself would follow the reader to the next page. */
const pageBox = (root) => {
  const box = el('div', 'stack lp-page');
  root.append(box);
  return box;
};
export const PRINT_ID = 'lp-print';
export const PRINT_CSS = '@media print{@page{size:A4 landscape;margin:9mm}}';
/** A landscape A4 for printing, in the document only while `host` is on it:
    removed on the next navigation, and checked again before any print. */
export function landscape(host) {
  if (typeof document === 'undefined' || !document.head) return;
  if (!document.getElementById(PRINT_ID)) {
    const st = document.createElement('style');
    st.id = PRINT_ID;
    st.textContent = PRINT_CSS;
    document.head.append(st);
  }
  const off = () => {
    if (host.isConnected) return;
    document.getElementById(PRINT_ID)?.remove();
    window.removeEventListener('hashchange', later);
    window.removeEventListener('beforeprint', off);
    window.removeEventListener('beforeprint', fit);
  };
  const later = () => setTimeout(off, 250);
  const fit = () => fitGrids(host);
  window.addEventListener('hashchange', later);
  window.addEventListener('beforeprint', off);
  window.addEventListener('beforeprint', fit);
}
/* The grid fitted to the printed page's width, however many days it holds.
   ─────────────────────────────────────────────────────────────────────────
   The averages close each row, on the right — the first thing a page too
   narrow cuts off. With the fares to the fils the mock's 22-day grid printed
   1,206 px wide on a landscape A4 of 1,054 px (297 mm less two 9 mm margins
   at 96 px an inch); in whole dirhams it had fitted to the pixel, so a
   31-day month overflowed even then. Before a print the grid is measured
   under the print rule's own type and padding (.lp-measure, app.css), at
   its own width rather than the frame's it stretches to, and given the zoom
   that brings it inside the page, as --lp-fit, which only the print rule
   reads — the screen never changes. */
export const PRINT_W = Math.floor(((297 - 2 * 9) / 25.4) * 96);
export const fitOf = (w, page = PRINT_W) => (w > page ? Math.floor((page / w) * 1000) / 1000 : 1);
export function fitGrids(host) {
  if (!host?.isConnected) return;
  document.body.classList.add('lp-measure');
  for (const g of host.querySelectorAll('.lp-grid')) g.style.setProperty('--lp-fit', String(fitOf(g.scrollWidth)));
  document.body.classList.remove('lp-measure');
}
/* Today in Dubai, by the shared clock rule (./tz.js), never the UTC day. */
const dubaiToday = () => dubaiDay(new Date());

/* ── the address ─────────────────────────────────────────────────────────── */
/** #low-performers[/FROM..TO[/HOTEL[.FLEET]]] → the request. */
export function parseParam(param, sub) {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(param || ''));
  const [h, f] = String(sub || '').split('.');
  return {
    from: m && m[1] <= m[2] ? m[1] : null,
    to: m && m[1] <= m[2] ? m[2] : null,
    hotel: HOTEL_MODES.includes(h) ? h : 'hide',
    fleet: FLEETS.includes(f) ? f : null,
  };
}
export const pageHref = ({ from = null, to = null, hotel = 'hide', fleet = null } = {}) => {
  const p = from && to ? `${from}..${to}` : null;
  const s = hotel !== 'hide' || fleet ? `${hotel}${fleet ? `.${fleet}` : ''}` : null;
  return href('low-performers', p || (s ? 'month' : null), s);
};
const query = (o) => Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
export const listUrl = (r) => `/api/lowperf?${query({ from: r.from, to: r.to, hotel: r.hotel, fleet: r.fleet })}`;
export const listXlsx = (r) => `/api/export/lowperf.xlsx?${query({ from: r.from, to: r.to, hotel: r.hotel, fleet: r.fleet })}`;

/** The period chips: each a from–to the server would also choose. */
export function presets(today = dubaiToday()) {
  const y = addDays(today, -1);
  const first = `${y.slice(0, 7)}-01`;
  const lastMonthEnd = addDays(first, -1);
  return [
    { key: 'month', label: 'Month so far', from: null, to: null },
    { key: 'last-month', label: 'Last month', from: `${lastMonthEnd.slice(0, 7)}-01`, to: lastMonthEnd },
    { key: '14', label: 'Last 14 days', from: addDays(y, -13), to: y },
    { key: '7', label: 'Last 7 days', from: addDays(y, -6), to: y },
  ];
}

/* ── 00 the head ─────────────────────────────────────────────────────────── */
const cell = (key, label, value, subs, t2 = null) => `<div class="tg-cell${t2 ? ` tg-${t2}` : ''}" data-lp="${esc(key)}">`
  + `<span class="tg-l">${esc(label)}</span><b class="tg-v">${esc(value)}</b>`
  + (subs || []).filter(Boolean).map((s) => (typeof s === 'string' ? `<span class="tg-sub">${esc(s)}</span>`
    : `<span class="tg-sub${s.tone ? ` tg-${s.tone}` : ''}">${esc(s.text)}</span>`)).join('')
  + '</div>';

/** The period in words, for the caption and the print header. */
export function periodWords(v) {
  const span = v.from === v.to ? shortDay(v.from) : `${shortDay(v.from)} – ${shortDay(v.to)}`;
  return `${span} · ${v.fleet ? sourceLabel(v.fleet) : 'both fleets'} · ${HOTEL_WORD[v.hotel] || ''}`;
}

export function headHtml(v) {
  const wh = v._withheld || {};
  if (v.why) return `<p class="tg-absent">${esc(v.why)}</p>`;
  const rows = v.rows || [];
  /* Counted from the rows this reader was sent, so a one-fleet reader reads
     their fleet's list, not a total the list under it cannot add up to. */
  const n = rows.length;
  const band = (k) => rows.filter((r) => r.band === k).length;
  const tr = (k) => rows.filter((r) => r.trend?.verdict === k).length;
  const t = v.totals || {};
  const scoped = Number(wh.FLEET) > 0;
  const sum = (k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const asked = scoped ? sum('gross_target') : t.below_target;
  const earned = scoped ? sum('gross') : t.below_gross;
  const rest = v.yardstick?.rest;
  const hid = (t.hidden_hotel_only || 0) + (t.hidden_mostly_hotel || 0);
  return '<div class="targetnow tg-page"><div class="tg-cells">' + [
    cell('below', 'Below target', scoped ? n0(n) : `${n0(n)} of ${n0(t.population)}`, [
      `${n0(band('lt50'))} under half · ${n0(band('lt80'))} half to 80% · ${n0(band('lt100'))} at 80% or more`,
      `${countOf(v.counted_days, 'day')} counted${hid ? ` · ${countOf(hid, 'hotel driver')} left out` : ''}`]),
    cell('short', 'Short of their targets', aed(asked == null || earned == null ? null : Math.round((asked - earned) * 100) / 100), [
      `earned ${aed(earned)} of ${aed(asked)}`,
      asked ? { text: `${pc(Math.round((1000 * earned) / asked) / 10)} of what they were asked`, tone: 'under' } : null], 'under'),
    cell('rest', 'Everyone else', rest?.pct == null ? '—' : pc(rest.pct), [
      rest ? `${countOf(rest.people, 'driver')} on or over target` : null,
      'of their own targets, the same days']),
    cell('trend', 'Last week against the one before', `${n0(tr('improving'))} ▲ · ${n0(tr('slipping'))} ▼`, [
      `${countOf(tr('steady'), 'steady', 'steady')}${tr(null) ? ` · ${n0(rows.filter((r) => !r.trend?.verdict).length)} too few days to say` : ''}`,
      'held against everyone else’s move']),
  ].join('') + '</div></div>';
}

/* ── 01 the list ─────────────────────────────────────────────────────────── */
/** A person's written line: what the columns beside it do not say — the
    days off and the trend in words, against everyone else's move. */
export function readingOf(r) {
  const out = [];
  if (r.days_off) out.push(`${countOf(r.days_off, 'day')} off while active — each still asks its share`);
  else if (r.days_active) out.push('drove every day they were active');
  const t = r.trend || {};
  if (t.verdict && t.change != null) {
    /* The verdict is against everyone else's move, so the sentence says so:
       on production the first draft read "improving last week: down 7.1
       points" for a driver who fell less than everyone else's 21.5. */
    const me = t.change === 0 ? 'no change' : `${t.change > 0 ? 'up' : 'down'} ${fmt(Math.abs(t.change), 1)} points`;
    const them = !t.rest_change ? 'everyone else held' : `everyone else ${t.rest_change > 0 ? 'rose' : 'fell'} ${fmt(Math.abs(t.rest_change), 1)}`;
    const how = { improving: 'better than everyone else', slipping: 'worse than everyone else', steady: 'in step with everyone else' }[t.verdict];
    out.push(`${how} last week: ${me} while ${them}`);
  } else if (t.why) out.push(t.why.replace(/\.$/, '').replace(/^./, (c) => c.toLowerCase()));
  const s = out.join('; ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

const who_ = (r) => (r.name ? (r.driver_ext_id ? `<a href="${esc(href('driver', r.driver_ext_id))}">${esc(r.name)}</a>` : esc(r.name))
  : '<span class="mt-dim">(withheld)</span>');
const trendCell = (t) => {
  const k = TREND[t?.verdict];
  if (!k) return `<span class="mt-dim" title="${esc(t?.why || '')}">— too few days</span>`;
  return `<span class="${k.tone}">${k.mark} ${esc(k.word)}</span>`
    + (t.relative != null ? ` <span class="mt-dim">${t.relative >= 0 ? '+' : '−'}${esc(fmt(Math.abs(t.relative), 1))}</span>` : '');
};
const weeksCell = (r) => (r.weeks || []).map((w) => (w.pct == null ? '<span class="mt-dim">—</span>' : esc(fmt(w.pct, 0)))).join('<span class="mt-dim"> · </span>');

export function listHtml(v) {
  const wh = v._withheld || {};
  if (v.why) return `<p class="tg-absent">${esc(v.why)}</p>`;
  const rows = v.rows || [];
  if (!rows.length) return `<p class="tg-absent">${esc(`Every driver measured over ${periodWords(v)} reached their target.`)}</p>`;
  const notes = [];
  if (v.left_out?.length) {
    notes.push(`Not counted — a driver is measured only on settled days in a month with a target: ${v.left_out.map((d) => `${d.label}${d.why ? ` (${d.why.replace(/\.$/, '')})` : ''}`).join('; ')}.`);
  }
  if (Number(wh.FLEET) > 0) notes.push(`${countOf(Number(wh.FLEET), 'driver')} of a fleet your role does not see ${Number(wh.FLEET) === 1 ? 'is' : 'are'} not listed.`);
  for (const c of ['ID', 'CASH', 'COND', 'BK', 'VEH']) if (wh[c] != null) notes.push(said(c, wh[c]));
  const wk = v.weeks || [];
  let i = 0;
  const body = ['lt50', 'lt80', 'lt100'].map((b) => {
    const list = rows.filter((r) => r.band === b);
    if (!list.length) return '';
    return `<tr class="lp-band"><th scope="rowgroup" colspan="11" class="l">${esc(BAND_WORD[b])} <span class="mt-dim">· ${esc(countOf(list.length, 'driver'))}</span></th></tr>`
      + list.map((r) => {
        i += 1;
        const plat = (r.platforms || []).map(sourceLabel).join(', ');
        const car = r.plate ? ` · ${esc(r.plate)}` : '';
        return `<tr data-pk="${esc(r.pk || '')}"><td class="mt-dim">${i}<button type="button" class="lp-open lp-noprint" data-open="${esc(r.pk || '')}" aria-expanded="false"`
          + ` title="Each day, the causes, the weekdays and the hours">Days ▸</button></td>`
          + `<th scope="row" class="l">${who_(r)}<span class="lp-meta">${esc(r.fleet ? sourceLabel(r.fleet) : '—')}${car}${plat ? ` · ${esc(plat)}` : ''}`
          + `${r.hotel_share ? ` · hotel ${esc(fmt(r.hotel_share, 0))}%` : ''}</span>${r.causes ? `<span class="lp-chips">${causeChips(r)}</span>` : ''}</th>`
          + `<td><b class="tg-under">${esc(pc(r.gross_pct))}</b><span class="lp-bar" aria-hidden="true"><i style="width:${Math.max(0, Math.min(100, r.gross_pct || 0))}%"></i></span></td>`
          + `<td>${esc(aed(r.gross))}<span class="lp-meta">of ${esc(aed(r.gross_target))}</span></td>`
          + `<td>${r.gross_short ? `<span class="tg-under">▼ ${esc(money(r.gross_short))}</span>` : '—'}</td>`
          + `<td>${esc(n0(r.days_active))}<span class="lp-meta">drove ${esc(n0(r.days_driven))}${r.days_off ? ` · <b class="tg-under">${esc(n0(r.days_off))} off</b>` : ''}</span></td>`
          + `<td>${esc(aed(r.per_day_driven))}<span class="lp-meta">asked ${esc(aed(r.per_day_target))}</span></td>`
          + `<td>${esc(n0(r.trips))}<span class="lp-meta">of ${esc(n0(r.trips_target))}</span></td>`
          + `<td>${r.cash_pct == null ? '—' : esc(pc(r.cash_pct))}<span class="lp-meta">${r.online_h == null ? 'no Uber hours' : `${esc(fmt(r.online_h, 1))} h on Uber`}</span></td>`
          + `<td>${weeksCell(r)}<span class="lp-meta">${trendCell(r.trend)}</span></td>`
          + `<td class="l lp-read">${esc(readingOf(r))}</td></tr>`;
      }).join('');
  }).join('');
  const head = '<thead><tr><th scope="col">#</th><th scope="col" class="l">Driver</th><th scope="col">% of target</th>'
    + '<th scope="col">Fares</th><th scope="col">Short by</th><th scope="col">Days active</th><th scope="col">AED a day driven</th>'
    + '<th scope="col">Trips</th><th scope="col">Cash · hours</th>'
    + `<th scope="col" title="${esc(wk.map((w) => w.label).join(' · '))}">3 weeks, % · trend</th><th scope="col" class="l lp-read">In words</th></tr></thead>`;
  return `${notes.map((x) => `<p class="mt-note">${esc(x)}</p>`).join('')}`
    + `<div class="tablewrap"><table class="mt-t lp-t">${head}<tbody>${body}</tbody></table></div>`
    + `<p class="cap mt-rule">${esc(RULE(v))}</p>`;
}
const RULE = (v) => 'How a driver’s target is set — the Month target page’s rule: each settled day’s plan (its share of the month’s target) '
  + 'is divided equally among the drivers active that day (a completed trip in the 8 days to it). A day they were active and did not drive still '
  + `asks its share. Gross is their fares on every platform, before commission. Trips: the day’s minimum (${v.trips_min} on an average day). `
  + 'The three weeks end on the last settled day; improving or slipping means at least 10 points more, or less, than everyone else moved.';

/* ── 02 day by day ──────────────────────────────────────────────────────── */
/** One grid cell: the day's fares, shaded against that day's own target. The
    shade is always the fares' verdict, whatever the cell is set to print. */
export function cellClass(c) {
  if (c.share == null) return c.fares ? 'lp-c-none' : 'lp-c-blank';
  if (!c.trips && !c.fares) return 'lp-c-off';
  if (c.fares >= c.share - 0.005) return 'lp-c-over';
  if (c.fares >= c.share / 2) return 'lp-c-mid';
  return 'lp-c-low';
}
/** Minutes from Dubai midnight as a clock: 1440 is a drop-off after midnight. */
export const hhmm = (m) => (m == null ? '—' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
/* What a grid cell can print. The shade stays the fares' verdict in every one,
   so a short day reads short whatever is printed in it. */
export const GRID_METRICS = [
  { key: 'fares', label: 'Fares, AED' },
  { key: 'pct', label: '% of that day’s target' },
  { key: 'trips', label: 'Trips' },
  { key: 'hours', label: 'Hours on jobs' },
  { key: 'start', label: 'First request' },
];
/* The grid's fares are to the fils, like every other money figure (ruling 2).
   ─────────────────────────────────────────────────────────────────────────
   The day cells, the row averages and the rows under the head printed whole
   dirhams — fmt(Math.round(x)) — while the opened driver, the phone and the
   Excel sheets printed the same figures with their fils. LPG put "Asked of
   each, AED" at the head of a row of those rounded figures, and arkiv_fils
   read "AED 457 457 457…" off the rendered page on e542bdb: 79 passed, 1
   failed, alone and in the full run. The cells print the figure alone, by
   fils(), because the row or the switch already names the currency. */
export function cellText(c, metric = 'fares') {
  const k = cellClass(c);
  if (k === 'lp-c-off') return 'off';
  if (k === 'lp-c-blank') return '';
  if (metric === 'pct') return c.share ? `${Math.round((100 * c.fares) / c.share)}%` : '—';
  if (metric === 'trips') return fmt(c.trips);
  if (metric === 'hours') return c.job_min == null ? '—' : fmt(Math.round(c.job_min / 6) / 10, 1);
  if (metric === 'start') return hhmm(c.first);
  return c.fares == null ? '—' : fils(c.fares);
}
/** The days a row's averages are taken over: counted, active, and (for the
    second) driven — the same days the gross and the target are counted on. */
const activeCells = (r) => (r.days || []).filter((c) => c.share != null);
const drivenCells = (r) => activeCells(r).filter((c) => c.trips > 0);
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
/** The row-end figures for a metric: per active day, and per day driven. */
export function rowAverages(r, metric = 'fares') {
  const A = activeCells(r);
  const D = drivenCells(r);
  if (metric === 'trips') return [mean(A.map((c) => c.trips)), mean(D.map((c) => c.trips))].map((x) => (x == null ? '—' : fmt(Math.round(x * 10) / 10, 1)));
  if (metric === 'hours') {
    const h = D.filter((c) => c.job_min != null).map((c) => c.job_min / 60);
    return ['', h.length ? fmt(Math.round(mean(h) * 10) / 10, 1) : '—'];
  }
  if (metric === 'start') {
    const f = D.map((c) => c.first).filter((x) => x != null).sort((x, y) => x - y);
    return ['', f.length ? hhmm(f[Math.floor((f.length - 1) / 2)]) : '—'];
  }
  if (metric === 'pct') return [r.avg_active_pct, r.avg_driven_pct].map((x) => (x == null ? '—' : `${fmt(x, 1)}%`));
  return [r.avg_active, r.avg_driven].map((x) => (x == null ? '—' : fils(x)));
}
/** Under the fares averages, each as a share of the target a day. */
const avgPct = (r, metric) => (metric !== 'fares' ? ['', ''] : [r.avg_active_pct, r.avg_driven_pct]
  .map((x) => (x == null ? '' : `<small class="${x < 100 ? 'tg-under' : ''}">${esc(fmt(Math.round(x)))}%</small>`)));
const dayHref = (r, day) => (r.driver_ext_id ? href('driver', r.driver_ext_id, 'day', { on: day }) : null);
export function gridHtml(v, { saved = null, metric = 'fares' } = {}) {
  const rows = v.rows || [];
  if (!rows.length || !v.days?.length) return '';
  const days = v.days;
  const col = (d) => `${d.counted ? '' : 'lp-nc'}${saved && d.day === saved ? ' lp-saved' : ''}`.trim();
  const avgHead = metric === 'hours' || metric === 'start'
    ? '<th scope="col" class="lp-avg"></th><th scope="col" class="lp-avg">Typical day driven</th>'
    : '<th scope="col" class="lp-avg">Average a day active</th><th scope="col" class="lp-avg">Average a day driven</th>';
  /* The rows under the head print the same figure as the cells: what each
     driver was asked, then the list's and everyone else's day (the server's
     list_* and rest_*), so a quiet day for everyone reads as one. */
  const unit = { fares: 'AED', pct: '% of target', trips: 'trips', hours: 'h on jobs', start: 'start' }[metric] || 'AED';
  const refOf = (d, who) => {
    if (who === 'ask') {
      if (metric === 'fares') return d.share;
      if (metric === 'pct') return d.share == null ? null : 100;
      if (metric === 'trips') return d.share == null ? null : d.trips_min;
      return null;
    }
    if (metric === 'fares') return d[`${who}_avg`];
    if (metric === 'pct') return d[`${who}_avg`] == null || !d.share ? null : (100 * d[`${who}_avg`]) / d.share;
    if (metric === 'trips') return d[`${who}_trips`];
    if (metric === 'hours') return d[`${who}_job_h`];
    return d[`${who}_first`];
  };
  const refText = (x) => {
    if (x == null) return '—';
    if (metric === 'start') return hhmm(Math.round(x));
    if (metric === 'pct') return `${fmt(Math.round(x))}%`;
    if (metric === 'trips' || metric === 'hours') return fmt(Math.round(x * 10) / 10, 1);
    return fils(x);
  };
  const refEnd = (who) => {
    const xs = days.filter((d) => d.counted).map((d) => refOf(d, who)).filter((x) => x != null);
    if (!xs.length) return '—';
    if (metric === 'start') return refText([...xs].sort((p, q) => p - q)[Math.floor((xs.length - 1) / 2)]);
    return refText(mean(xs));
  };
  const endCols = (who) => (metric === 'hours' || metric === 'start'
    ? `<td class="lp-avg"></td><td class="lp-avg">${esc(refEnd(who))}</td>` : `<td class="lp-avg">${esc(refEnd(who))}</td><td class="lp-avg"></td>`);
  const refRow = (label, who, cls) => `<tr class="lp-ref ${cls}"><th scope="row" class="l lp-who">${esc(`${label}, ${unit}`)}</th>`
    + days.map((d) => `<td class="${col(d)}">${esc(refText(refOf(d, who)))}</td>`).join('') + `${endCols(who)}</tr>`;
  const asks = metric === 'fares' || metric === 'pct' || metric === 'trips';
  const head = '<thead><tr><th scope="col" class="l lp-who">Driver</th>'
    + days.map((d) => `<th scope="col" class="${col(d)}" title="${esc(d.counted ? `${d.label}: each active driver was asked ${money(d.share)}` : `${d.label}: not counted — ${d.why || ''}`)}">`
      + `${esc(d.label.split(' ')[0].slice(0, 2))}<br>${esc(d.label.split(' ')[1])}</th>`).join('') + `${avgHead}</tr>`
    + (asks ? `<tr class="lp-share"><th scope="row" class="l lp-who">${esc(`Asked of each, ${unit}`)}</th>`
      + days.map((d) => `<td class="${col(d)}">${esc(refText(refOf(d, 'ask')))}</td>`).join('') + `${endCols('ask')}</tr>` : '')
    + (days.some((d) => d.list_avg != null) ? refRow('Their average', 'list', 'lp-ref-list') : '')
    + (days.some((d) => d.rest_avg != null) ? refRow('Everyone else', 'rest', 'lp-ref-rest') : '')
    + '</thead>';
  const body = rows.map((r) => {
    const avgs = rowAverages(r, metric);
    const pcs = avgPct(r, metric);
    return `<tr><th scope="row" class="l lp-who">${who_(r)}</th>`
      + (r.days || []).map((c, i) => {
        const t = cellText(c, metric);
        const link = t && t !== '' ? dayHref(r, days[i].day) : null;
        const tip = c.share != null || c.fares ? ` title="${esc(`${days[i].label}: ${money(c.fares)}${c.share != null ? ` of ${money(c.share)}` : ''}, ${c.trips} trips`
          + `${c.job_min != null ? `, ${fmt(Math.round(c.job_min / 6) / 10, 1)} h on jobs` : ''}${c.first != null ? `, ${hhmm(c.first)}–${hhmm(c.last)}` : ''}`)}"` : '';
        return `<td class="${cellClass(c)} ${col(days[i])}"${tip}>${link ? `<a href="${esc(link)}">${esc(t)}</a>` : esc(t)}</td>`;
      }).join('')
      + `<td class="lp-avg">${esc(avgs[0])}${pcs[0]}</td><td class="lp-avg">${esc(avgs[1])}${pcs[1]}</td></tr>`;
  }).join('');
  const key = '<p class="lp-key"><span class="lp-k lp-c-over">812.40</span>at or above that day’s target'
    + '<span class="lp-k lp-c-mid">402.15</span>half to target<span class="lp-k lp-c-low">96.80</span>under half'
    + '<span class="lp-k lp-c-off">off</span>active and did not drive<span class="lp-k lp-c-blank"></span>not active — the day asked nothing'
    + (saved ? '<span class="lp-k lp-k-saved"></span>the day the list was saved' : '')
    + '<span>The shade is always the day’s fares against its target; a figure opens that driver’s day.</span></p>';
  const pick = `<div class="chips lp-metric lp-noprint" role="group" aria-label="What each day shows">${GRID_METRICS.map((m) => `<button type="button" class="chip${m.key === metric ? ' on' : ''}" data-metric="${m.key}" aria-pressed="${m.key === metric}">${esc(m.label)}</button>`).join('')}</div>`;
  const rule = '<p class="cap mt-rule">Average a day active: their fares over the counted days they were active, a day off counting as nothing — the base their target is judged on. '
    + 'Average a day driven: over the days they drove. Their average and everyone else: each day among the people active on it, on the list and off it — '
    + 'fares and trips with a day off as nothing; hours on jobs and the first request over those who drove, the start as the middle value. '
    + 'Hours on jobs: request to drop-off, summed. First request: the day’s first booking.</p>';
  return `${pick}${key}<div class="tablewrap lp-gridwrap"><table class="lp-grid">${head}<tbody>${body}</tbody></table></div>${rule}`;
}

/* ── why below target ─────────────────────────────────────────────────────── */
const CAUSE_LABEL = { days_off: 'Days off', short_days: 'Short days', low_rate: 'Low AED an hour', late_start: 'Late starts', few_trips: 'Few trips', abandons: 'Abandoned jobs' };
/** One cause in words: their figure and everyone else's. */
export function causeWords(key, c, r) {
  const n1 = (x) => fmt(x, 1);
  if (key === 'days_off') return r.days_driven === 0 ? `did not drive on any of their ${r.days_active} active days`
    : `${r.days_off} of ${r.days_active} active days not driven (${n1(c.value)}%; everyone else ${c.rest == null ? '—' : `${n1(c.rest)}%`})`;
  if (key === 'short_days') return `${n1(c.value)} h on jobs a day driven; everyone else ${n1(c.rest)} h`;
  if (key === 'low_rate') return `${money(c.value)} an hour on jobs; everyone else ${money(c.rest)}`;
  if (key === 'late_start') return `first request typically ${hhmm(c.value)}; everyone else ${hhmm(c.rest)}`;
  if (key === 'few_trips') return `${n1(c.value)} trips a day driven; everyone else ${n1(c.rest)}`;
  if (key === 'abandons') return `${r.abandoned} accepted jobs abandoned (${n1(c.value)}%); everyone else ${c.rest == null ? '—' : `${n1(c.rest)}%`}`;
  return '';
}
const causeChips = (r) => {
  const ks = Object.keys(r.causes || {});
  if (!r.causes) return '';
  return ks.map((k) => `<span class="lp-chip" title="${esc(causeWords(k, r.causes[k], r))}">${esc(CAUSE_LABEL[k] || k)}</span>`).join('');
};
export function causesHtml(v) {
  const t = v.totals || {};
  if (!t.causes || !v.rows?.length) return '';
  const md = v.medians || {};
  const restOf = { days_off: md.off_share == null ? '—' : `${fmt(md.off_share, 1)}% of active days off`,
    short_days: md.job_h_day == null ? '—' : `${fmt(md.job_h_day, 1)} h on jobs a day driven`,
    low_rate: md.aed_per_job_h == null ? '—' : `${money(md.aed_per_job_h)} an hour on jobs`,
    late_start: md.start_med == null ? '—' : `first request ${hhmm(md.start_med)}`,
    few_trips: md.trips_day == null ? '—' : `${fmt(md.trips_day, 1)} trips a day driven`,
    abandons: md.abandon_pct == null ? '—' : `${fmt(md.abandon_pct, 1)}% of accepted jobs abandoned` };
  const rows = (v.cause_rules || []).map((c) => `<tr><th scope="row" class="l">${esc(c.label)}</th><td>${esc(fmt(t.causes[c.key] || 0))}</td>`
    + `<td class="l">${esc(c.rule)}</td><td class="l">${esc(restOf[c.key])}</td></tr>`).join('');
  return `<p class="mt-lede">${esc(`Each cause is a measurement held against everyone else’s middle value — the ${md.people ?? 0} drivers on or over target, the same days and settings. A driver can carry several; ${countOf(t.no_cause || 0, 'driver')} carr${(t.no_cause || 0) === 1 ? 'ies' : 'y'} none, so their gap is spread thin.`)}</p>`
    + '<div class="tablewrap"><table class="mt-t lp-causes"><thead><tr><th scope="col" class="l">Cause</th><th scope="col">Drivers</th>'
    + '<th scope="col" class="l">Named when</th><th scope="col" class="l">Everyone else’s middle value</th></tr></thead>'
    + `<tbody>${rows}</tbody></table></div>`;
}

/* ── one driver in detail ─────────────────────────────────────────────────── */
const heat = (xs) => {
  const hi = Math.max(1, ...xs);
  return xs.map((x) => (x ? Math.min(4, 1 + Math.floor((3.999 * x) / hi)) : 0));
};
/** Twenty-four hours as shaded cells, each with its count on hover. */
export function hoursStrip(rowsOf) {
  return '<div class="tablewrap"><table class="lp-hours"><thead><tr><th scope="col" class="l"></th>'
    + Array.from({ length: 24 }, (_, h) => `<th scope="col">${h % 3 ? '' : String(h).padStart(2, '0')}</th>`).join('') + '</tr></thead><tbody>'
    + rowsOf.map(([label, xs, unit]) => {
      const lv = heat(xs);
      return `<tr><th scope="row" class="l">${esc(label)}</th>${xs.map((x, h) => `<td class="lp-h${lv[h]}" title="${esc(`${String(h).padStart(2, '0')}:00 — ${fmt(x)} ${unit}`)}"></td>`).join('')}</tr>`;
    }).join('') + '</tbody></table></div>';
}
export function weekdayBars(list, rest = null) {
  return '<div class="tablewrap"><table class="mt-t lp-wd"><thead><tr><th scope="col" class="l"></th>'
    + list.map((w) => `<th scope="col">${esc(w.label)}</th>`).join('') + '</tr></thead><tbody>'
    + `<tr><th scope="row" class="l">${esc(rest ? 'Below target' : 'Share of target')}</th>${list.map((w) => `<td>${w.pct == null ? '—' : `<b class="${w.pct < 50 ? 'tg-under' : ''}">${esc(fmt(Math.round(w.pct)))}%</b>`}${w.days != null ? `<span class="lp-meta">${esc(countOf(w.days, 'day'))}</span>` : ''}</td>`).join('')}</tr>`
    + (rest ? `<tr><th scope="row" class="l">Everyone else</th>${rest.map((w) => `<td>${w.pct == null ? '—' : `${esc(fmt(Math.round(w.pct)))}%`}</td>`).join('')}</tr>` : '')
    + '</tbody></table></div>';
}
export function detailHtml(r, v) {
  const days = v.days || [];
  const ks = Object.keys(r.causes || {});
  const causes = r.causes ? `<ul class="lp-why">${ks.length ? ks.map((k) => `<li><b>${esc(CAUSE_LABEL[k] || k)}</b> — ${esc(causeWords(k, r.causes[k], r))}</li>`).join('')
    : '<li>No single cause stands out against everyone else: the gap is spread across days, hours and rate.</li>'}</ul>` : '';
  const facts = [
    ['Average a day active', r.avg_active == null ? '—' : `${money(r.avg_active)} (${pc(r.avg_active_pct)})`],
    ['Average a day driven', r.avg_driven == null ? '—' : `${money(r.avg_driven)} (${pc(r.avg_driven_pct)})`],
    ['Asked a day', aed(r.per_day_target)],
    ['Hours on jobs a day driven', r.job_h_day == null ? '—' : `${fmt(r.job_h_day, 1)} h`],
    ['AED an hour on jobs', aed(r.aed_per_job_h)],
    ['AED a trip', r.trips ? money(r.gross / r.trips) : '—'],
    ['Trips a day driven', r.trips_day == null ? '—' : fmt(r.trips_day, 1)],
    ['First request, last drop-off', r.start_med == null ? '—' : `${hhmm(r.start_med)} – ${hhmm(r.finish_med)} typically`],
    ['Uber online a day', r.online_h_day == null ? 'no Uber hours' : `${fmt(r.online_h_day, 1)} h`],
    ['Km a day driven', r.km_day == null ? '—' : fmt(r.km_day, 1)],
    ['Abandoned · declined', `${fmt(r.abandoned ?? 0)} · ${fmt(r.declined ?? 0)}${r.abandon_pct != null ? ` (${fmt(r.abandon_pct, 1)}% of accepted abandoned)` : ''}`],
  ];
  const factList = `<dl class="lp-facts">${facts.map(([k, x]) => `<div><dt>${esc(k)}</dt><dd>${esc(x)}</dd></div>`).join('')}</dl>`;
  const lines = (r.days || []).map((c, i) => ({ c, d: days[i] })).filter(({ c }) => c.share != null || c.trips || c.bookings);
  const table = '<div class="tablewrap"><table class="mt-t lp-dt"><thead><tr><th scope="col" class="l">Day</th><th scope="col">Asked</th><th scope="col">Fares</th><th scope="col">%</th>'
    + '<th scope="col">Trips / bookings</th><th scope="col">First – last</th><th scope="col">On jobs</th><th scope="col">Uber online</th><th scope="col">Km</th>'
    + '<th scope="col">AED an hour</th><th scope="col">AED a trip</th><th scope="col">Abandoned · declined</th><th scope="col" class="l">Platforms · car</th></tr></thead><tbody>'
    + lines.map(({ c, d }) => {
      const link = dayHref(r, d.day);
      const rate = c.job_min ? money(c.fares / (c.job_min / 60)) : '—';
      return `<tr class="${cellClass(c)}-row"><th scope="row" class="l">${link ? `<a href="${esc(link)}">${esc(d.label)}</a>` : esc(d.label)}${d.counted ? '' : ' <span class="mt-dim">not counted</span>'}</th>`
        + `<td>${c.share == null ? '<span class="mt-dim">—</span>' : esc(aed(c.share))}</td>`
        + `<td class="${cellClass(c)}">${c.share != null && !c.trips && !c.fares ? 'off' : esc(aed(c.fares))}</td>`
        + `<td>${c.share ? esc(`${Math.round((100 * c.fares) / c.share)}%`) : '—'}</td>`
        + `<td>${esc(fmt(c.trips))} / ${esc(fmt(c.bookings))}</td>`
        + `<td>${c.first == null ? '—' : esc(`${hhmm(c.first)} – ${hhmm(c.last)}`)}</td>`
        + `<td>${c.job_min == null ? '—' : esc(`${fmt(Math.round(c.job_min / 6) / 10, 1)} h`)}</td>`
        + `<td>${c.online_min == null ? '—' : esc(`${fmt(Math.round(c.online_min / 6) / 10, 1)} h`)}</td>`
        + `<td>${c.km == null ? '—' : esc(fmt(c.km, 1))}</td><td>${esc(rate)}</td><td>${c.trips ? esc(money(c.fares / c.trips)) : '—'}</td>`
        + `<td>${esc(`${fmt(c.abandoned)} · ${fmt(c.declined)}`)}</td>`
        + `<td class="l">${esc([(c.platforms || []).map(sourceLabel).join(', '), c.plate].filter(Boolean).join(' · ') || '—')}</td></tr>`;
    }).join('') + '</tbody></table></div>';
  const fleetH = v.hours?.fleet || Array(24).fill(0);
  return `<div class="lp-detail">${causes}${factList}${table}`
    + `<p class="lp-sub">Share of target by weekday, over the counted days</p>${weekdayBars(r.weekdays || [])}`
    + `<p class="lp-sub">When they work, against when the fleet is booked</p>${hoursStrip([['Their completed trips', r.hours || Array(24).fill(0), 'trips'], ['Fleet bookings', fleetH, 'bookings']])}</div>`;
}

/* ── when: weekdays and hours, the list against everyone else ─────────────── */
export function patternsHtml(v) {
  if (!v.weekdays || !v.rows?.length) return '';
  const h = v.hours || {};
  return `<p class="lp-sub">Share of their own targets by weekday, over the counted days</p>${weekdayBars(v.weekdays.below, v.weekdays.rest)}`
    + `<p class="lp-sub">Completed trips by the hour they were requested, against the fleet’s bookings</p>`
    + hoursStrip([['Below target', h.below || [], 'trips'], ['Everyone else', h.rest || [], 'trips'], ['Fleet bookings', h.fleet || [], 'bookings']])
    + '<p class="cap mt-rule">Each row is shaded against its own busiest hour, so the three can be read for shape side by side; hover an hour for its count.</p>';
}

/* ── the weeks against everyone else ────────────────────────────────────── */
export function weeksHtml(v) {
  const y = v.yardstick;
  if (!y || !v.weeks?.length) return '';
  const row = (label, s) => `<tr><th scope="row" class="l">${esc(label)}</th>`
    + s.weeks.map((w) => `<td>${esc(pc(w.pct))}</td>`).join('')
    + `<td>${s.weeks[1].pct == null || s.weeks[2].pct == null ? '—' : esc(`${s.weeks[2].pct - s.weeks[1].pct >= 0 ? '+' : '−'}${fmt(Math.abs(Math.round((s.weeks[2].pct - s.weeks[1].pct) * 10) / 10), 1)}`)}</td></tr>`;
  return '<div class="tablewrap"><table class="mt-t lp-weeks"><thead><tr><th scope="col" class="l">Share of their own targets</th>'
    + v.weeks.map((w) => `<th scope="col">${esc(w.label)}${w.counted_days < 7 ? `<br><span class="mt-dim">${esc(countOf(w.counted_days, 'day'))} counted</span>` : ''}</th>`).join('')
    + '<th scope="col">Last week’s move, points</th></tr></thead><tbody>'
    + row(`Below target (${y.below.people})`, y.below) + row(`Everyone else (${y.rest.people})`, y.rest)
    + '</tbody></table></div>';
}

/* ── the page ────────────────────────────────────────────────────────────── */
function controlsHtml(r, v) {
  const ps = presets(v?.today || dubaiToday());
  const on = (p) => (p.from === r.from && p.to === r.to) || (!p.from && !r.from);
  const chip = (h, label, pressed) => `<a class="chip${pressed ? ' on' : ''}" href="${esc(h)}" aria-current="${pressed ? 'true' : 'false'}">${esc(label)}</a>`;
  return '<div class="lp-ctl lp-noprint">'
    + `<div class="chips" role="group" aria-label="Period">${ps.map((p) => chip(pageHref({ ...r, from: p.from, to: p.to }), p.label, on(p))).join('')}`
    + `<form class="lp-range"><label>From <input type="date" name="from" value="${esc(v?.from || '')}"></label>`
    + `<label>to <input type="date" name="to" value="${esc(v?.to || '')}"></label><button class="btn sec" type="submit">Show</button></form></div>`
    + `<div class="chips" role="group" aria-label="Hotel drivers">${HOTEL_MODES.map((h) => chip(pageHref({ ...r, hotel: h }), HOTEL_CHIP[h], r.hotel === h)).join('')}</div>`
    + `<div class="chips" role="group" aria-label="Fleet">${[null, ...FLEETS].map((f) => chip(pageHref({ ...r, fleet: f }), f ? sourceLabel(f) : 'Both fleets', r.fleet === f)).join('')}</div>`
    + '<div class="chips lp-acts"><button type="button" class="btn sec" data-act="xlsx">Excel ⤓</button>'
    + '<button type="button" class="btn sec" data-act="print">Print / PDF</button>'
    + '<button type="button" class="btn sec" data-act="print-all" title="Every driver opened to their days, then printed">Print with every driver</button>'
    + '<span class="mt-xmsg" role="status" hidden></span></div></div>';
}

/** Open or close one driver's days under their row in the list. */
function toggleDetail(btn, v, byPk, open = null) {
  const tr = btn.closest('tr');
  const next = tr?.nextElementSibling;
  const isOpen = next?.classList.contains('lp-drow');
  const want = open == null ? !isOpen : open;
  if (want === isOpen) return false;
  btn.setAttribute('aria-expanded', String(want));
  btn.textContent = want ? 'Days ▾' : 'Days ▸';
  if (!want) { next.remove(); return true; }
  const r = byPk.get(btn.dataset.open);
  if (!r) return false;
  const d = document.createElement('tr');
  d.className = 'lp-drow';
  d.innerHTML = `<td colspan="11">${detailHtml(r, v)}</td>`;
  tr.after(d);
  /* The list is wider than a narrow screen and scrolls inside its frame; the
     detail is held to the frame's width and pinned to its left edge, so it
     reads without scrolling the list sideways. Print lets it go (app.css). */
  const wrap = tr.closest('.tablewrap');
  const box = d.querySelector('.lp-detail');
  if (wrap && box) box.style.width = `${wrap.clientWidth}px`;
  return true;
}

/** The saved lists, and saving this one. */
export function watchListsHtml(lists, v, { editor = canEditWatch() } = {}) {
  const items = (lists || []).map((l) => `<li><a href="${esc(href('watchlist', String(l.id)))}">${esc(l.name)}</a>`
    + ` <span class="mt-dim">· saved ${esc(shortDay(l.saved_day))} · ${esc(countOf(l.members, 'person', 'people'))}`
    + `${l.period_from ? ` · from ${esc(shortDay(l.period_from))} – ${esc(shortDay(l.period_to))}` : ''}</span></li>`).join('');
  const save = !v?.rows?.length ? ''
    : editor ? `<form class="lp-save lp-noprint"><label>Save these ${esc(countOf(v.rows.length, 'person', 'people'))} as a watch list `
      + `<input name="name" maxlength="120" required value="${esc(`Below target ${shortDay(v.from)} – ${shortDay(v.to)}`)}"></label>`
      + '<button class="btn" type="submit">Save watch list</button><span class="mt-xmsg" role="status" hidden></span></form>'
      : `<p class="mt-note lp-noprint">${esc(who.signedIn ? 'Watch lists are kept by the Owner and the Operations managers.'
        : 'Sign in as the Owner or an Operations manager to save this list and follow it from today.')}</p>`;
  return `${items ? `<ul class="lp-lists">${items}</ul>` : '<p class="mt-note">No watch list has been saved yet.</p>'}${save}`;
}
/** The grid's cell switch: redraw the grid with the chosen figure in it. */
function metricSwitch(host, draw) {
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-metric]');
    if (!b) return;
    const x = host.querySelector('.lp-gridwrap')?.scrollLeft || 0;
    host.innerHTML = draw(b.dataset.metric);
    const w = host.querySelector('.lp-gridwrap');
    if (w) w.scrollLeft = x;
  });
}
export const canEditWatch = () => who.signedIn === true && who.kind === 'user' && !who.preview && canDo('watchlist.edit');

export async function lowPerformersPage(outer, param = null, sub = null) {
  const gen = currentGen();
  const root = pageBox(outer);
  landscape(root);
  const ak = contract();
  const r = parseParam(param === 'month' ? null : param, sub);
  const note = el('span');
  const head = el('div');
  const ctl = el('div');
  if (ak) {
    const band = el('section', 'cband lp-head');
    band.append(secHead('00', 'Below target', note), ctl, head);
    root.append(band);
  } else {
    const p = panel('Below target', null, 'lp-head');
    const cap = el('p', 'cap');
    cap.append(note);
    p.panel.querySelector('h3')?.after(cap);
    p.body.append(ctl, head);
    root.append(p.panel);
  }
  const why = panel('Why they are below target', null, 'lp-why');
  const list = panel('The list — furthest behind first', null, 'lp-list');
  const grid = panel('Day by day, against each day’s own target', null, 'lp-grid');
  const when = panel('When — weekdays and hours, against everyone else', null, 'lp-when');
  const weeks = panel('Week by week, against everyone else', null, 'lp-weeks');
  const saved = panel('Watch lists', null, 'lp-watch');
  saved.panel.classList.add('lp-noprint');
  root.append(why.panel, list.panel, grid.panel, when.panel, weeks.panel, saved.panel);
  [head, why.body, list.body, grid.body, when.body, weeks.body, saved.body].forEach((b) => loading(b));
  ctl.innerHTML = controlsHtml(r, null);

  const [v, lists] = await Promise.all([
    api(listUrl(r)).catch((e) => ({ _err: e })),
    api('/api/lowperf/watch').catch(() => ({ lists: [] })),
  ]);
  if (!alive(gen)) return null;
  if (v._err) {
    const msg = `<p class="tg-absent">${esc(`The list could not be read: ${v._err.message || 'no answer'}`)}</p>`;
    head.innerHTML = msg; list.body.innerHTML = msg;
    for (const b of [why.body, grid.body, when.body, weeks.body, saved.body]) b.innerHTML = '';
    return null;
  }
  note.textContent = `${periodWords(v)} · as of ${v.today}`;
  ctl.innerHTML = controlsHtml(r, v) + (v.notes || []).map((x) => `<p class="mt-note">${esc(x)}</p>`).join('');
  head.innerHTML = headHtml(v);
  why.body.innerHTML = causesHtml(v) || '<p class="mt-note">Nobody below target to explain.</p>';
  list.body.innerHTML = listHtml(v);
  grid.body.innerHTML = gridHtml(v) || '<p class="mt-note">Nobody to show.</p>';
  when.body.innerHTML = patternsHtml(v) || '<p class="mt-note">Nobody to show.</p>';
  weeks.body.innerHTML = weeksHtml(v);
  saved.body.innerHTML = watchListsHtml(lists?.lists, v);
  const byPk = new Map((v.rows || []).map((x) => [x.pk, x]));
  list.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) toggleDetail(b, v, byPk);
  });
  metricSwitch(grid.body, (metric) => gridHtml(v, { metric }));

  ctl.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const from = String(f.get('from') || ''), to = String(f.get('to') || '');
    if (isDay(from) && isDay(to) && from <= to) location.hash = pageHref({ ...r, from, to }).slice(1);
  });
  ctl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'print') { window.print(); return; }
    if (b.dataset.act === 'print-all') {
      /* Every driver opened for the printout, and the ones this opened
         closed again after it, so the screen is left as it was. */
      const opened = [...list.body.querySelectorAll('[data-open]')].filter((x) => toggleDetail(x, v, byPk, true));
      window.print();
      for (const x of opened) toggleDetail(x, v, byPk, false);
      return;
    }
    const msg = ctl.querySelector('.lp-acts .mt-xmsg');
    const was = b.textContent;
    b.disabled = true; b.textContent = 'Preparing…';
    try {
      await downloadFile(listXlsx(r), `low-performers-${v.from}-to-${v.to}.xlsx`);
      if (msg) { msg.textContent = ''; msg.hidden = true; }
    } catch (err) { if (msg) { msg.textContent = err.message; msg.hidden = false; } } finally { b.disabled = false; b.textContent = was; }
  });
  saved.body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = saved.body.querySelector('.mt-xmsg');
    const name = String(new FormData(e.target).get('name') || '').trim();
    try {
      const out = await post('/api/lowperf/watch', { name, from: v.from, to: v.to, hotel: v.hotel, fleet: v.fleet });
      location.hash = href('watchlist', String(out.list.id)).slice(1);
    } catch (err) { if (msg) { msg.textContent = err.message; msg.hidden = false; } }
  });
  return null;
}

/* ── a watch list followed ───────────────────────────────────────────────── */
/** #watchlist/ID/A_B — the spans, each FROM or FROM..TO. */
export function parseSpans(sub) {
  const ok = (s) => /^\d{4}-\d{2}-\d{2}(\.\.\d{4}-\d{2}-\d{2})?$/.test(s || '');
  const [a, b] = String(sub || '').split('_');
  return ok(a) && ok(b) ? { a, b } : { a: null, b: null };
}
export const watchUrl = (id, s = {}) => `/api/lowperf/watch/${encodeURIComponent(id)}${s.a && s.b ? `?${query({ a: s.a, b: s.b })}` : ''}`;
const moveCell = (m) => {
  const k = TREND[m?.verdict];
  if (!k) return `<span class="mt-dim">${esc(m?.why || '—')}</span>`;
  return `<span class="${k.tone}">${k.mark} ${esc(k.word)}</span> <span class="mt-dim">${m.change >= 0 ? '+' : '−'}${esc(fmt(Math.abs(m.change), 1))} against ${m.rest_change >= 0 ? '+' : '−'}${esc(fmt(Math.abs(m.rest_change), 1))}</span>`;
};

export function watchHeadHtml(w) {
  const ch = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${fmt(Math.abs(x), 1)} points`);
  return '<div class="targetnow tg-page"><div class="tg-cells">' + [
    cell('members', 'On the list', n0(w.rows.length), [`saved ${shortDay(w.watch.saved_day)}`,
      w.missing.length ? `${countOf(w.missing.length, 'person', 'people')} not found` : null]),
    cell('list', 'The list', `${pc(w.list.a.pct)} → ${pc(w.list.b.pct)}`, [`${w.a.label} → ${w.b.label}`,
      { text: ch(w.list.change), tone: w.list.change == null ? null : w.list.change >= 0 ? 'over' : 'under' }]),
    cell('rest', 'Everyone else', `${pc(w.rest.a.pct)} → ${pc(w.rest.b.pct)}`, [countOf(w.rest.people, 'driver'), ch(w.rest.change)]),
    cell('moves', 'Against everyone else', `${n0(w.moves.improving)} ▲ · ${n0(w.moves.slipping)} ▼`,
      [`${n0(w.moves.steady)} steady · ${n0(w.moves.unknown)} too few days to say`]),
  ].join('') + '</div></div>';
}

export function membersHtml(w, { editor = false } = {}) {
  const rows = w.rows || [];
  const notes = [];
  if (w.missing.length) notes.push(`Not found on any day shown: ${w.missing.map((m) => m.name || '(withheld)').join(', ')} — no booking under them or any account they held when saved.`);
  if (Number(w._withheld?.FLEET) > 0) notes.push(`${countOf(Number(w._withheld.FLEET), 'member')} of a fleet your role does not see ${Number(w._withheld.FLEET) === 1 ? 'is' : 'are'} not listed.`);
  const body = rows.map((r) => `<tr data-pk="${esc(r.pk || '')}"><th scope="row" class="l">${who_(r)}`
    + `<span class="lp-meta">${esc(r.fleet ? sourceLabel(r.fleet) : '—')}${r.plate ? ` · ${esc(r.plate)}` : ''}${r.rekeyed ? ' · found by an account' : ''}</span></th>`
    + `<td>${r.at_save?.pct == null ? '<span class="mt-dim">joined later</span>' : esc(pc(r.at_save.pct))}</td>`
    + `<td>${esc(pc(r.a.pct))}<span class="lp-meta">${esc(aed(r.a.gross))} of ${esc(aed(r.a.target))} · ${esc(n0(r.a.days_active))} days</span></td>`
    + `<td>${esc(pc(r.b.pct))}<span class="lp-meta">${esc(aed(r.b.gross))} of ${esc(aed(r.b.target))} · ${esc(n0(r.b.days_active))} days</span></td>`
    + `<td class="l">${moveCell(r.move)}</td>`
    + (editor ? `<td class="lp-noprint"><button type="button" class="btn sec lp-rm" data-rm="${esc(r.pk || '')}">Remove</button></td>` : '')
    + '</tr>').join('');
  return notes.map((x) => `<p class="mt-note">${esc(x)}</p>`).join('')
    + '<div class="tablewrap"><table class="mt-t lp-t"><thead><tr><th scope="col" class="l">Driver</th><th scope="col">At the save</th>'
    + `<th scope="col">${esc(w.a.label)}</th><th scope="col">${esc(w.b.label)}</th><th scope="col" class="l">Moved, against everyone else</th>`
    + (editor ? '<th scope="col" class="lp-noprint"></th>' : '') + `</tr></thead><tbody>${body}</tbody></table></div>`;
}

function spanControls(id, w) {
  const y = addDays(w.today, -1);
  const opts = [
    { label: 'Before and after the save', a: null, b: null },
    { label: 'The last two days', a: addDays(y, -1), b: y },
    { label: 'The last two weeks', a: `${addDays(y, -13)}..${addDays(y, -7)}`, b: `${addDays(y, -6)}..${y}` },
  ];
  const cur = w.default_spans ? null : `${w.a.from}${w.a.to !== w.a.from ? `..${w.a.to}` : ''}_${w.b.from}${w.b.to !== w.b.from ? `..${w.b.to}` : ''}`;
  return '<div class="lp-ctl lp-noprint"><div class="chips" role="group" aria-label="Compare">'
    + opts.map((o) => {
      const s = o.a ? `${o.a}_${o.b}` : null;
      return `<a class="chip${s === cur ? ' on' : ''}" href="${esc(href('watchlist', String(id), s))}">${esc(o.label)}</a>`;
    }).join('')
    + `<form class="lp-range" data-spans="1"><label>Compare <input type="date" name="a1" value="${esc(w.a.from)}"></label>`
    + `<label>to <input type="date" name="a2" value="${esc(w.a.to)}"></label><label>with <input type="date" name="b1" value="${esc(w.b.from)}"></label>`
    + `<label>to <input type="date" name="b2" value="${esc(w.b.to)}"></label><button class="btn sec" type="submit">Compare</button></form></div>`
    + '<div class="chips lp-acts"><button type="button" class="btn sec" data-act="xlsx">Excel ⤓</button>'
    + '<button type="button" class="btn sec" data-act="print">Print / PDF</button><span class="mt-xmsg" role="status" hidden></span></div></div>';
}

/** #watchlist — every saved list; #watchlist/ID — one followed. */
export async function watchListPage(outer, param = null, sub = null) {
  const gen = currentGen();
  const root = pageBox(outer);
  landscape(root);
  if (!param) {
    const p = panel('Watch lists', 'Lists saved from the Low performers page, each followed from the day it was saved.', 'lp-watch');
    root.append(p.panel);
    loading(p.body);
    const lists = await api('/api/lowperf/watch?archived=1').catch((e) => ({ _err: e }));
    if (!alive(gen)) return null;
    p.body.innerHTML = lists._err ? `<p class="tg-absent">${esc(lists._err.message)}</p>`
      : watchListsHtml((lists.lists || []).filter((l) => !l.archived), null)
        + `<p class="mt-note"><a href="${esc(href('low-performers'))}">Back to Low performers</a> to save a new one.</p>`;
    return { name: 'Watch lists' };
  }
  const spans = parseSpans(sub);
  const ak = contract();
  const note = el('span');
  const head = el('div');
  const ctl = el('div');
  if (ak) {
    const band = el('section', 'cband lp-head');
    band.append(secHead('00', 'The list, followed', note), ctl, head);
    root.append(band);
  } else {
    const p = panel('The list, followed', null, 'lp-head');
    const cap = el('p', 'cap');
    cap.append(note);
    p.panel.querySelector('h3')?.after(cap);
    p.body.append(ctl, head);
    root.append(p.panel);
  }
  const mem = panel('Each member, against everyone else', null, 'lp-members');
  const grid = panel('Day by day, from two weeks before the save', null, 'lp-grid');
  root.append(mem.panel, grid.panel);
  [head, mem.body, grid.body].forEach((b) => loading(b));
  const w = await api(watchUrl(param, spans)).catch((e) => ({ _err: e }));
  if (!alive(gen)) return null;
  if (w._err) {
    const msg = `<p class="tg-absent">${esc(`The watch list could not be read: ${w._err.message || 'no answer'}`)}</p>`;
    head.innerHTML = msg; mem.body.innerHTML = ''; grid.body.innerHTML = '';
    return { name: 'Watch list' };
  }
  const editor = canEditWatch() && !w.watch.archived;
  note.textContent = `${w.watch.name} · saved ${shortDay(w.watch.saved_day)} · ${HOTEL_WORD[w.watch.hotel] || ''} · `
    + `${w.watch.fleet ? sourceLabel(w.watch.fleet) : 'both fleets'}${w.watch.archived ? ' · archived' : ''}`;
  ctl.innerHTML = spanControls(param, w);
  head.innerHTML = watchHeadHtml(w);
  mem.body.innerHTML = membersHtml(w, { editor });
  grid.body.innerHTML = gridHtml(w, { saved: w.watch.saved_day });
  metricSwitch(grid.body, (metric) => gridHtml(w, { saved: w.watch.saved_day, metric }));
  if (editor) {
    const m = el('form', 'lp-save lp-noprint');
    m.innerHTML = `<label>Name <input name="name" maxlength="120" value="${esc(w.watch.name)}"></label>`
      + '<button class="btn sec" type="submit">Rename</button><button class="btn sec" type="button" data-archive="1">Archive this list</button>'
      + '<span class="mt-xmsg" role="status" hidden></span>';
    mem.body.append(m);
  }
  const say = (host, text) => { const x = host.querySelector('.mt-xmsg'); if (x) { x.textContent = text; x.hidden = !text; } };
  const change = async (body) => {
    try { await post(`/api/lowperf/watch/${encodeURIComponent(param)}`, body); window.dispatchEvent(new HashChangeEvent('hashchange')); }
    catch (err) { say(mem.body, err.message); }
  };
  mem.body.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { change({ remove: [rm.dataset.rm] }); return; }
    if (e.target.closest('[data-archive]')) change({ archive: true });
  });
  mem.body.addEventListener('submit', (e) => { e.preventDefault(); change({ name: String(new FormData(e.target).get('name') || '') }); });
  ctl.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const g = (k) => String(f.get(k) || '');
    const sp = (a, b) => (a === b ? a : `${a}..${b}`);
    if ([g('a1'), g('a2'), g('b1'), g('b2')].every(isDay) && g('a1') <= g('a2') && g('b1') <= g('b2')) {
      location.hash = href('watchlist', String(param), `${sp(g('a1'), g('a2'))}_${sp(g('b1'), g('b2'))}`).slice(1);
    }
  });
  ctl.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.act === 'print') { window.print(); return; }
    const was = b.textContent;
    b.disabled = true; b.textContent = 'Preparing…';
    try {
      const q = query({ id: param, a: spans.a, b: spans.b });
      await downloadFile(`/api/export/lowperf-watch.xlsx?${q}`, 'watch-list.xlsx');
      say(ctl, '');
    } catch (err) { say(ctl, err.message); } finally { b.disabled = false; b.textContent = was; }
  });
  return { name: w.watch.name };
}
