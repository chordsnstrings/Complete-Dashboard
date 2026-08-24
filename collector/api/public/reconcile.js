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
    render: (r) => orDash(r.expected_payout, 'needs the statement') },
  { label: 'Bank payout', key: 'bank_payout', num: true,
    render: (r) => orDash(r.bank_payout, 'no payout reported') },
  { label: 'Δ bank − expected', key: 'delta', num: true, render: deltaPill },
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

  const t = d.totals;
  host.append(kpiRow([
    { label: 'Trips', value: t.trips != null ? fmt(t.trips) : '—',
      sub: 'bookings over the rows below' },
    { label: 'Expected payout', value: t.expected_payout != null ? money(t.expected_payout) : '—',
      sub: 'on-trip net + tips + salik − cash, where a statement exists' },
    { label: 'Bank payout', value: t.bank_payout != null ? money(t.bank_payout) : '—',
      sub: 'what the platforms report having paid' },
    { label: 'Gap', html: t.delta == null ? '<span class="dim">—</span>'
        : deltaPill(t),
      sub: t.delta == null
        ? `nothing reconcilable: no ${month ? 'day' : 'month'} holds both sides`
        : `over the ${fmt(t.reconciled_rows)} ${month ? 'day(s)' : 'month(s)'} holding both sides` },
  ]));

  const mp = month
    ? panel(`${MONTH_LABEL(month)}, day by day`,
      'The same identity at day grain. A dash is a day the source in question reported nothing.')
    : panel('Month by month',
      'One row per month, all platforms combined unless the platform filter narrows it. Click a month for its days.');

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
    + 'unguessed. And the on-trip side only reaches as far back as the platform statement '
    + 'surfaces do — Uber serves roughly the last six months — so older months show an expected '
    + 'payout of “—”, which means unknowable, not zero.'));
}
