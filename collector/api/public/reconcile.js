/* Reconciliation: does what the platforms wired match what they said we earned?
   ─────────────────────────────────────────────────────────────────────────
   One row per month, with both sides of the identity the July 2026 ledger
   reconciliation proved to 0.7%:

       bank payout  ≈  on-trip net + tips + salik − cash collected

   The point of the page is the delta column: within a couple of percent the
   platform's numbers check out; beyond that, somebody has a question to ask.
   A month a statement surface no longer reaches shows a dash, never a zero —
   an expected payout of AED 0 would accuse the platform of not paying for
   work it simply never reported on.

   Two things every figure on this page depends on, and the page says both out
   loud rather than leaving them to be inferred.

   The SCOPE is the whole record. These rows are months; a thirty-day window
   spans two partial ones, and reconciling six days of July against July's bank
   payout is the very mismatch the delta column exists to catch. So the range
   selector is hidden here (see setHeader in app.js) and the span the numbers
   cover is printed where it used to sit — every tile and every row describes
   that same span.

   The COMPARISON is over driver-days, not months. The statement surface names
   some of the fleet's drivers and the bank figure names all of them, so the
   two figures the delta is made of are printed beside it rather than left to
   be assumed from the columns further left.

   Clicking a month opens the same table at day grain, because "August is 9%
   off" is only actionable once you can see WHICH days carry the gap — cash
   timing shows up as paired over/under days, a missing statement week as a
   run of dashes. */
import { empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, money, fmt, pct } from './ui.js';
import { api, state, href } from './data.js';

const MONTH_LABEL = (m) => {
  const [y, mm] = String(m).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y}`;
};

/* A figure that was not reported is an em-dash with the reason dimmed beside
   it, never 0 — absence and zero are different facts, and on a money page the
   difference is an accusation. */
const orDash = (v, why) => (v == null
  ? `<span class="dim">— ${esc(why)}</span>`
  : money(v));

/* The delta toned by how far the two sides sit apart: within ±2% is the
   agreement the July reconciliation achieved, ±10% is worth a look (usually
   cash banked in a different month), beyond that something is actually wrong
   or missing. */
const deltaPill = (r) => {
  if (r.delta == null) return '<span class="dim">—</span>';
  const off = r.delta_pct == null ? null : Math.abs(r.delta_pct);
  const tone = off == null ? 'warn' : off <= 2 ? 'ok' : off <= 10 ? 'warn' : 'bad';
  const sign = r.delta > 0 ? '+' : r.delta < 0 ? '−' : '±';
  return pill(`${sign}AED ${fmt(Math.abs(r.delta))}${off == null ? '' : ` · ${pct(off, 1)}`}`, tone);
};

/* A full-period figure, with the part of it the comparison actually used shown
   beside it when the two differ. Without the second number a partly-matched
   row reads as a wild discrepancy instead of a partial answer. */
const withCompared = (full, compared, why) => {
  if (full == null) return orDash(null, why);
  const show = compared != null && Math.abs(compared - full) > 1;
  return `${money(full)}${show ? `<span class="dim"> · ${money(compared)} compared</span>` : ''}`;
};

/* Why nothing could be compared in this row. Three different absences, and
   they call for three different actions — chase the statement, chase the
   payout, or look at who is missing from one of them. */
const noMatchReason = (r) => {
  if (r.ontrip_net == null) return 'no statement';
  if (r.bank_payout == null) return 'no payout reported';
  return 'no driver-day on both sides';
};

const COLS = (keyCol) => [
  keyCol,
  { label: 'Trips', key: 'trips', num: true,
    render: (r) => (r.trips == null ? '<span class="dim">—</span>' : fmt(r.trips)) },
  { label: 'On-trip net', key: 'ontrip_net', num: true,
    render: (r) => orDash(r.ontrip_net, 'no statement') },
  { label: 'Tips', key: 'tips', num: true, render: (r) => orDash(r.tips, '') },
  { label: 'Salik', key: 'salik', num: true, render: (r) => orDash(r.salik, '') },
  { label: 'Cash collected', key: 'cash_collected', num: true,
    render: (r) => orDash(r.cash_collected, '') },
  { label: 'Expected payout', key: 'expected_payout', num: true,
    render: (r) => withCompared(r.expected_payout, r.expected_covered, 'needs the statement') },
  { label: 'Bank payout', key: 'bank_payout', num: true,
    render: (r) => withCompared(r.bank_payout, r.bank_covered, 'no payout reported') },
  { label: 'Δ bank − expected', key: 'delta', num: true, render: deltaPill },
  /* The column that explains the one before it. A delta drawn over 53 of the
     189 drivers the bank paid that day is a different claim from one drawn
     over all of them, and the number is the difference between "the platform
     underpaid" and "we hold a third of the statement". */
  { label: 'Compared over', key: 'matched_pairs',
    render: (r) => (r.matched_pairs
      ? `<span class="dim">${fmt(r.matched_drivers)} of ${fmt(r.bank_drivers)} drivers`
        + ` · ${fmt(r.matched_days)} day${r.matched_days === 1 ? '' : 's'}</span>`
      : `<span class="dim">— ${esc(noMatchReason(r))}</span>`) },
];

export async function renderReconcile(root, month) {
  root.innerHTML = '';
  if (month != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return empty(root, 'A reconciliation address is #reconcile/<YYYY-MM>.');
  }
  const host = el('div'); root.append(host); loading(host);

  /* The window selector does not apply here — the whole record is the point of
     a reconciliation — but the platform and fleet filters do, and the endpoint
     answers for one platform when one is chosen. */
  const p = new URLSearchParams();
  if (month) p.set('month', month);
  if (state.platform) p.set('platform', state.platform);
  if (state.fleet) p.set('fleet', state.fleet);
  const d = await api(`/api/reconcile?${p.toString()}`);
  host.innerHTML = '';

  if (month) {
    host.append(el('p', 'cap',
      `<a class="lnk" href="${href('reconcile')}">← All months</a> · ${esc(MONTH_LABEL(month))}, day by day`));
  }
  if (!d.rows.length) {
    return empty(host, month
      ? `Nothing recorded in ${MONTH_LABEL(month)} — no trips, no statement, no payout.`
      : 'Nothing to reconcile yet: no trips, statements or payouts on record.');
  }

  /* The span every figure below covers, said once, in the words the rows are
     keyed in. This is the sentence the range selector used to contradict. */
  const span = month ? MONTH_LABEL(month)
    : d.rows.length === 1 ? MONTH_LABEL(d.rows[0].m)
      : `${MONTH_LABEL(d.rows[0].m)} → ${MONTH_LABEL(d.rows[d.rows.length - 1].m)}`;
  const over = `over ${span}`;

  const t = d.totals;
  host.append(kpiRow([
    { label: 'Trips', value: t.trips != null ? fmt(t.trips) : '—',
      sub: `bookings ${over}` },
    { label: 'Expected payout', value: t.expected_payout != null ? money(t.expected_payout) : '—',
      sub: `on-trip net + tips + salik − cash, ${over}, where a statement exists` },
    { label: 'Bank payout', value: t.bank_payout != null ? money(t.bank_payout) : '—',
      sub: `what the platforms report having paid, ${over}` },
    /* The two figures the gap is the difference of, and how much of the record
       they cover. The Gap tile used to sit beside a bank total spanning every
       month while measuring one — two scopes in one row of tiles, with nothing
       on screen to tell them apart. */
    { label: 'Compared over', value: t.matched_pairs ? fmt(t.matched_pairs) : '—',
      sub: t.matched_pairs
        ? `driver-day(s) both sides describe, in ${fmt(t.reconciled_rows)} `
          + `${month ? 'day(s)' : 'month(s)'}`
        : 'no driver-day is described by both sides' },
    { label: 'Gap', html: t.delta == null ? '<span class="dim">—</span>' : deltaPill(t),
      sub: t.delta == null
        ? 'nothing reconcilable: the two sides never describe the same driver on the same day'
        : `${money(t.bank_covered)} banked against ${money(t.expected_covered)} expected, `
          + 'on those driver-days alone' },
  ]));

  const mp = month
    ? panel(`${MONTH_LABEL(month)}, day by day`,
      'The same identity at day grain. A dash is a day the source in question reported nothing.')
    : panel('Month by month',
      `Every month on record — ${span} — all platforms combined unless the platform filter `
      + 'narrows it. The date range at the top of the page does not apply to a table of months, '
      + 'so it is not offered here. Click a month for its days.');

  const keyCol = month
    ? { label: 'Day', key: 'd',
      render: (r) => `<a class="lnk" href="${href('day', r.d)}" title="Everything recorded on this day">${esc(r.d)}</a>` }
    : { label: 'Month', key: 'm',
      render: (r) => `<a class="lnk" href="${href('reconcile', r.m)}" title="This month, day by day">${esc(MONTH_LABEL(r.m))}</a>` };

  // Newest first for the monthly view — reconciliation starts from the latest
  // statement — and calendar order inside a month, which is how a month reads.
  const rows = month ? d.rows : [...d.rows].reverse();
  mp.body.append(tableFrom(rows, COLS(keyCol)));
  host.append(mp.panel);

  host.append(el('p', 'cap', esc(d.note)));
  host.append(note(
    'A gap between bank and expected is usually timing, not theft: cash a driver banked in the '
    + 'neighbouring month, and per-trip surcharges the statement mapping deliberately leaves '
    + 'unguessed. The on-trip side reaches only as far back as the platform statement surfaces '
    + 'do, and Uber’s is far shorter than it reads: its earner-payments surface answers for the '
    + 'CURRENT payment period and returns an empty list for every older window, however wide the '
    + 'request. So the on-trip column begins where collection began and grows a week at a time '
    + 'from here; earlier months show “—”, which means unknowable, not zero.'));
}
