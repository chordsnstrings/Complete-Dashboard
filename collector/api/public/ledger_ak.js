/* THE LEDGER PAGES UNDER THE PAGE CONTRACT — the parts they share.
   ─────────────────────────────────────────────────────────────────────────
   #opening, #salary, #advances, #charging, #policy and #deposits are forms
   and registers first: the plan keeps every form, grid and register exactly
   where the operator works it (docs/UI-REDESIGN-PLAN.md §4, "Leave
   structurally untouched"), and adds a 00 band, a few charts drawn from the
   figures the page already fetched, and a † band. Those additions read the
   same few fields of /api/ledger/exposure on every one of the six pages, so
   they are computed here ONCE — six copies of "sum the cash ceilings" is how
   two pages come to disagree about the same number.

   Nothing here is read by the old skin: each page calls it only under
   contract().

   ── THE CEILING IS NOT A BALANCE ─────────────────────────────────────────
   owes.cash_taken is every cash fare on record put into a driver's hand (the
   route's own words: "a CEILING on what they could still be holding, not a
   balance"). Every figure built on it here says "ceiling", and nothing here
   subtracts, divides or ranks it against earnings — ledger_ui.test.mjs
   forbids #advances a client-side ratio and the same rule holds for all six.

   ── THREE KINDS OF "NO FIGURE", KEPT APART ───────────────────────────────
   A person with an exposure row and cash_taken null has NO cash fare on
   record — the route says so. A person with no exposure row at all (a roster
   account nobody has recorded against, or an exposure read that failed) has
   NOT BEEN MEASURED. The first is a count of drivers; the second is a gap in
   the read. They are never added together. */
import { el, esc, secHead, andList, countOf } from './ui.js';
import { hbars, barChart, empty, fmt } from './charts.js';
import { aed } from './deposit_core.js';
import { dubaiDay } from './tz.js';
import { href } from './data.js';

const r2 = (v) => Math.round(v * 100) / 100;
const DAY = 864e5;
const days = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);

/* The 00 band, empty, for a page to put first and fill when its data lands.
   The window note says so when the page is NOT windowed: every ledger read
   here is the whole record, and a control bar reading "This month" above it
   would otherwise be read as governing it. */
export function ledgerBand(note = 'The whole record — the date range above does not apply') {
  const band = el('section', 'cband');
  const tiles = el('div');
  band.append(secHead('00', 'At a glance', note), tiles);
  return { band, tiles };
}

/* The cash-fare ceiling across a list of people from loadPeople(). */
export function ceiling(people) {
  const measured = people.filter((p) => p.owes != null);
  const carriers = measured.filter((p) => p.owes.cash_taken != null);
  const froms = carriers.map((p) => p.owes.cash_taken_from).filter(Boolean).sort();
  const tos = carriers.map((p) => p.owes.cash_taken_to).filter(Boolean).sort();
  const top = carriers.reduce((m, p) => (!m || +p.owes.cash_taken > +m.owes.cash_taken ? p : m), null);
  return {
    people: people.length,
    measured: measured.length,
    unmeasured: people.length - measured.length,
    carriers,
    n: carriers.length,
    none: measured.length - carriers.length,
    sum: r2(carriers.reduce((a, p) => a + (+p.owes.cash_taken || 0), 0)),
    trips: carriers.reduce((a, p) => a + (+p.owes.cash_taken_trips || 0), 0),
    from: froms[0] || null,
    to: tos[tos.length - 1] || null,
    top,
  };
}

/* "276 of 347 carry one · 71 no cash fare on record · 2 not measured" — the
   three kinds said apart. */
export function ceilingWho(c) {
  return [
    `${fmt(c.n)} of ${fmt(c.people)} carry one`,
    c.none ? `${fmt(c.none)} no cash fare on record` : null,
    c.unmeasured ? `${fmt(c.unmeasured)} not on the exposure read` : null,
  ].filter(Boolean).join(' · ');
}

/* The table column the plan adds to #opening, #advances and #deposits. */
export const ceilingCol = () => ({
  label: 'Cash fares on record (ceiling)', key: 'ak_ceiling', num: true,
  sortValue: (p) => (p.owes?.cash_taken == null ? -1 : +p.owes.cash_taken),
  render: (p) => (p.owes?.cash_taken != null
    ? `${esc(aed(p.owes.cash_taken))}${p.owes.cash_taken_from
      ? ` <span class="dim">since ${esc(p.owes.cash_taken_from)}</span>` : ''}`
    : `<span class="dash" title="${esc(p.owes ? (p.owes.cash_taken_means || 'no cash-marked trip is on record for this person')
      : 'this person is not on the exposure read, so no cash fare has been measured for them')}">—</span>`),
});
export const lastCashCol = () => ({
  label: 'Last cash fare', key: 'ak_lastcash',
  sortValue: (p) => p.owes?.cash_taken_to || '',
  render: (p) => (p.owes?.cash_taken_to ? esc(p.owes.cash_taken_to)
    : '<span class="dash" title="no cash-marked trip is on record for this person">—</span>'),
});

/* How many drivers' cash fares began (or last ran) in each month. */
export function monthBars(host, people, key, { aria } = {}) {
  const by = new Map();
  people.forEach((p) => {
    const d = p.owes?.[key];
    if (d) by.set(d.slice(0, 7), (by.get(d.slice(0, 7)) || 0) + 1);
  });
  if (!by.size) { empty(host, 'No driver has a cash fare on record.'); return 0; }
  const ms = [...by.keys()].sort();
  const out = [];
  for (let [y, m] = ms[0].split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= ms[ms.length - 1];) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push({ month: k, n: by.get(k) || 0 });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  barChart(host, out, { x: 'month', y: 'n', color: '--ink', label: 'drivers', aria: aria || 'Drivers by month' });
  return out.length;
}

/* How long each driver's cash has been running: first cash fare to last. */
export function runningBars(host, people) {
  const BANDS = [['under a month', 0, 30], ['1–3 months', 30, 91], ['3–6 months', 91, 182],
    ['6–12 months', 182, 365], ['a year or more', 365, Infinity]];
  const spans = people.filter((p) => p.owes?.cash_taken_from && p.owes?.cash_taken_to)
    .map((p) => days(p.owes.cash_taken_from, p.owes.cash_taken_to));
  if (!spans.length) { empty(host, 'No driver has a cash fare on record.'); return; }
  hbars(host, BANDS.map(([label, lo, hi]) => ({ label, n: spans.filter((d) => d >= lo && d < hi).length })),
    { signed: false, color: '--ink', shareOf: (x) => `${(x.n / spans.length * 100).toFixed(1)}%` });
}

/* The ceiling, ranked — the top N as bars, and the drivers with none as the
   absence OUTLINE with its count, never as bars of nought. */
export function ceilingRanked(host, people, { top = 20 } = {}) {
  const c = ceiling(people);
  if (!c.n) { empty(host, 'No driver has a cash fare on record.'); return c; }
  const rows = [...c.carriers].sort((a, b) => b.owes.cash_taken - a.owes.cash_taken).slice(0, top);
  hbars(host, rows.map((p) => ({ label: p.name, n: +p.owes.cash_taken, ext: p.ext_id })),
    { signed: false, color: '--ink', valueFmt: (v) => aed(v) || '—',
      onClick: (x) => { if (x.ext) location.hash = href('driver', x.ext); },
      clickable: (x) => !!x.ext });
  if (c.none) {
    const w = el('div', 'hbars');
    w.innerHTML = `<div class="hb"><div class="k">${esc(countOf(c.none, 'driver'))} with no cash fare on record</div>`
      + '<div class="track"><div class="fill hb-outline" style="width:24%"></div></div>'
      + '<div class="v num"><span class="ak-why">no cash-marked trip</span></div></div>';
    host.append(w);
  }
  return c;
}

/* Exposure as the route judged it: measurable, not measurable, over the
   line. Counts, never a fleet ratio (the route refuses one). */
export function exposureBars(host, people) {
  const withFig = people.filter((p) => p.exposure_pct != null);
  const over = withFig.filter((p) => p.over_policy === true).length;
  hbars(host, [
    { label: 'Measurable', n: withFig.length },
    { label: 'Not measurable', n: people.length - withFig.length },
    { label: 'Over the line', n: over },
  ], { signed: false, color: '--ink', shareOf: (x) => (people.length ? `${(x.n / people.length * 100).toFixed(1)}%` : null) });
  return { measurable: withFig.length, not: people.length - withFig.length, over };
}

/* Counts in two FORMS on one scale: a measured count solid, a count of
   people with NO RECORD as the absence outline — both proportional, both
   with their number, so "347 not recorded" is not drawn as though it were a
   quantity of something. rows: [{ label, n, outline?, why? }]. */
export function formBars(host, rows, { of = null } = {}) {
  const max = Math.max(...rows.map((r) => +r.n || 0), 1);
  const w = el('div', 'hbars');
  w.innerHTML = rows.map((r) => {
    const pc = Math.max((+r.n || 0) / max * 100, r.n ? 0.6 : 0);
    return `<div class="hb"${r.why ? ` title="${esc(r.why)}"` : ''}><div class="k">${esc(r.label)}</div>`
      + `<div class="track"><div class="fill${r.outline ? ' hb-outline' : ''}" style="width:${pc.toFixed(1)}%;`
      + `${r.outline ? '' : 'background:var(--ink)'}"></div></div>`
      + `<div class="v num">${fmt(r.n)}${of ? `<span class="dim"> ${((+r.n || 0) / of * 100).toFixed(1)}%</span>` : ''}</div></div>`;
  }).join('');
  host.append(w);
}

/* A spread of AED amounts in round bands (the step chosen from the largest,
   so ten-odd bars), drawn as counts of people. */
export function amountBands(host, values, { noun = 'people', aria = 'People by amount' } = {}) {
  const v = values.map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (!v.length) { empty(host, `No ${noun} to spread.`); return null; }
  const hi = Math.max(...v);
  const raw = hi / 10;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw) || 10 * mag;
  const out = [];
  for (let lo = 0; lo < hi || !out.length; lo += step) {
    out.push({ band: `${fmt(lo)}–${fmt(lo + step)}`, n: v.filter((x) => x >= lo && (x < lo + step || (lo + step >= hi && x <= hi))).length });
  }
  barChart(host, out, { x: 'band', y: 'n', color: '--ink', label: noun, aria });
  return { step, bars: out.length, n: v.length };
}

/* Has anything been recorded on the advance or deduction books for this
   person? The route says so as `books_recorded`; where a payload predates
   that field, a recorded book is one whose figure is not null (the route
   nulls both when nothing was ever written — "a balance nobody has written
   down" is not a balance of nought). */
export const booksRecorded = (p) => !!p.owes && (p.owes.books_recorded ?? (
  (+p.owes.advance_rows || 0) + (+p.owes.deduction_rows || 0) > 0
  || p.owes.advance != null || p.owes.deduction != null));

/* The reason the route gives, once — every row carries the same sentence,
   and the band prints it rather than a paraphrase of it. */
export const firstReason = (people, get) => people.map(get).find(Boolean) || null;

export const today = () => dubaiDay();
export const daysSince = (d) => (d ? days(d, dubaiDay()) : null);
export { andList };
