/* A calendar, not a list of numbers.
   ─────────────────────────────────────────────────────────────────────────
   The range control was a <select> of thirteen fixed choices — five rolling
   day counts and eight relative period names. Two things were wrong with it,
   and they are the same thing said twice.

   It could not name a month. "This month" is the right frame while the month
   is running and useless the moment somebody wants to talk about August: there
   was no way to ask for August at all once September started, and no way to
   ask for a month with its year on it, which is how a business actually refers
   to one. A relative name also cannot be SENT to anybody — a link saying
   `period=month` opens on whatever month the reader opens it in, so two people
   reading the same address read different data.

   And it could not name two dates. Every window had to be one of thirteen
   shapes, so the commonest real question — "the 3rd to the 19th, when we ran
   the airport push" — had no answer at all.

   So: one control, three ways to answer it, and the panel says which one is
   in force. A quick chip for the spans people ask for daily; a month grid with
   a year stepper for a span named outright; two date fields for anything else.
   Picking any of the three clears the other two, because a page headed
   "August 2026" while showing the 3rd to the 19th is the bug this product has
   spent its whole life removing.

   Shared with the phone rather than reimplemented there. The phone's version
   of a popover is a bottom sheet, which is a placement decision and not a
   different control. */
import { el, esc } from './ui.js';
import { TZ } from './tz.js';
import { state, PERIODS, PERIOD_LABEL, periodLabel, dayLabel, MONTH_SHORT, api } from './data.js';

/* Dubai's today, not the reader's. Every boundary in this product is on the
   fleet's calendar, and at 02:00 Dubai those are different dates. */
export const dubaiToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

const ROLLING = [[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'],
  [180, 'Last 6 months'], [365, 'Last 12 months']];

/* What the picker is allowed to offer, learned from the data rather than
   assumed: a month grid that greys out January because the fleet's first
   booking was in August is telling the reader something true, and one that
   offers 2019 is inviting them to open an empty page. /api/platforms carries
   each channel's first and last row, and it is already fetched by the source
   line on nearly every view, so this is usually free. */
let span = null;
export async function dataSpan() {
  if (span) return span;
  const today = dubaiToday();
  try {
    /* Bare api(), not qAll(). This reads `earliest` and `latest` — each
       channel's first and last row ever — which no window can change, and the
       result is memoised in `span` for the life of the page whatever window
       was current when it was first asked. Sending one was the last of the
       four requests bin/page-audit.mjs found carrying a parameter its caller
       does not read: it made #settings, a page with no range control at all,
       report a windowed call, and gave the cache one entry per window for an
       answer identical across every one of them. */
    const rows = await api('/api/platforms');
    const days = (Array.isArray(rows) ? rows : rows?.rows || [])
      .flatMap((r) => [r.earliest, r.latest]).filter(Boolean)
      .map((t) => String(t).slice(0, 10)).sort();
    span = { first: days[0] || today, last: today };
  } catch { span = { first: today, last: today }; }
  return span;
}

/* Which of the three the current state is in, so the panel can show it rather
   than leaving the reader to work it out from what is highlighted. */
export const currentChoice = () => (state.from && state.to ? { kind: 'range' }
  : state.period ? { kind: 'period', value: state.period }
    : { kind: 'days', value: state.days });

const isSame = (cur, kind, value) => cur.kind === kind && String(cur.value) === String(value);

/* ── the panel ──────────────────────────────────────────────────────────── */
/* `onPick` receives exactly one of { period } | { days } | { from, to }, and
   is responsible for clearing the other two. It is not done here because the
   two hosts commit differently — the desktop writes the address, the phone
   mutates state and re-renders — and a picker that knew which was which would
   be two pickers. */
export function rangePanel({ onPick, close }) {
  const p = el('div', 'rangepanel');
  const cur = currentChoice();
  let year = +(state.period || dubaiToday()).slice(0, 4) || +dubaiToday().slice(0, 4);

  const sec = (title) => { p.append(el('p', 'rp-sec', title)); };
  const chipRow = (items, kind) => {
    const row = el('div', 'rp-chips');
    for (const [value, label] of items) {
      const b = el('button', `rp-chip${isSame(cur, kind, value) ? ' on' : ''}`, esc(label));
      b.type = 'button';
      b.onclick = () => { onPick(kind === 'period' ? { period: value } : { days: +value }); close(); };
      row.append(b);
    }
    p.append(row);
  };

  sec('Calendar period');
  chipRow(PERIODS.map((k) => [k, PERIOD_LABEL[k]]), 'period');

  /* ── a named month, with its year on it ───────────────────────────────── */
  sec('A month, by name');
  const head = el('div', 'rp-year');
  const back = el('button', 'rp-step', '‹');
  const label = el('b');
  const fwd = el('button', 'rp-step', '›');
  back.type = fwd.type = 'button';
  head.append(back, label, fwd);
  p.append(head);
  const grid = el('div', 'rp-months');
  /* Built once and refilled, not appended on every redraw: stepping the year
     three times used to leave three quarter rows stacked under the grid. */
  const extra = el('div', 'rp-chips');
  p.append(grid, extra);

  function drawMonths() {
    const today = dubaiToday();
    const firstYear = +(span?.first || today).slice(0, 4);
    const lastYear = +today.slice(0, 4);
    year = Math.min(Math.max(year, firstYear), lastYear);
    label.textContent = String(year);
    back.disabled = year <= firstYear;
    fwd.disabled = year >= lastYear;
    grid.innerHTML = '';
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, '0')}`;
      const b = el('button', `rp-m${isSame(cur, 'period', key) ? ' on' : ''}`, MONTH_SHORT[m - 1]);
      b.type = 'button';
      /* A month that has not started is not a window. One that started before
         the first row this fleet has is offered but marked, because "we hold
         nothing for March" is a real answer and hiding the month makes the
         product look like it lost it. */
      b.disabled = key > today.slice(0, 7);
      if (span && key < span.first.slice(0, 7)) { b.classList.add('empty'); b.title = 'Before the first record'; }
      b.onclick = () => { onPick({ period: key }); close(); };
      grid.append(b);
    }
    /* The whole year and its quarters, on the same row as the months they are
       made of — a reader asking for Q3 is asking about July to September, and
       having to add them up on a page that could have done it is the gap this
       control is here to close. */
    extra.innerHTML = '';
    for (const [key, text] of [[`${year}`, `All ${year}`], [`${year}-Q1`, 'Q1'],
      [`${year}-Q2`, 'Q2'], [`${year}-Q3`, 'Q3'], [`${year}-Q4`, 'Q4']]) {
      const b = el('button', `rp-chip${isSame(cur, 'period', key) ? ' on' : ''}`, text);
      b.type = 'button';
      b.disabled = key.length > 4 && `${year}-${String((+key.slice(-1) - 1) * 3 + 1).padStart(2, '0')}` > today.slice(0, 7);
      b.onclick = () => { onPick({ period: key }); close(); };
      extra.append(b);
    }
  }
  back.onclick = () => { year--; drawMonths(); };
  fwd.onclick = () => { year++; drawMonths(); };
  drawMonths();
  dataSpan().then(() => { if (p.isConnected) drawMonths(); });

  /* ── two dates ────────────────────────────────────────────────────────── */
  sec('Exact dates');
  const wrap = el('div', 'rp-dates');
  const mk = (value) => {
    const i = el('input');
    i.type = 'date';
    i.max = dubaiToday();
    i.value = value || '';
    return i;
  };
  const from = mk(state.from || (cur.kind === 'range' ? '' : ''));
  const to = mk(state.to || '');
  const apply = el('button', 'rp-apply', 'Show these days');
  apply.type = 'button';
  const err = el('p', 'rp-err');
  err.hidden = true;
  const check = () => {
    const ok = !!(from.value && to.value);
    apply.disabled = !ok;
    err.hidden = true;
    if (ok && from.value > to.value) { err.hidden = false; err.textContent = 'The first date is after the second — they will be swapped.'; }
  };
  from.oninput = to.oninput = check;
  check();
  apply.onclick = () => {
    if (!from.value || !to.value) return;
    /* An inverted range is a typo, not an empty set — the server already
       treats it that way, and correcting it here means the address that gets
       shared is the corrected one. */
    const [a, b] = from.value <= to.value ? [from.value, to.value] : [to.value, from.value];
    onPick({ from: a, to: b });
    close();
  };
  wrap.append(from, el('span', 'rp-to', 'to'), to);
  p.append(wrap, apply, err);

  sec('Rolling window');
  chipRow(ROLLING, 'days');

  /* What the panel is currently doing, in the words the page uses for it. */
  p.append(el('p', 'rp-now',
    `Showing ${esc(cur.kind === 'range'
      ? `${dayLabel(state.from)} – ${dayLabel(state.to)}`
      : cur.kind === 'period' ? periodLabel(state.period) : `the last ${state.days} days`)}`));
  return p;
}
