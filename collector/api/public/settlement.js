/* Settlement — who settles the fare, and when.
   ──────────────────────────────────────────────────────────────────────────
   The dashboard already had a payment donut. It was charting fourteen labels,
   the largest of which was `braintree` — the name of a payment processor, which
   tells an operator nothing, and which sat beside `zaakpay`, `kcp_pg` and
   `alipay2` as if the four were different kinds of business.

   Grouped by who owes what to whom, the same column answers three questions
   this fleet actually has and could not previously ask:

     #settlement              mix          — how the fare is settled, by route
     #settlement/cash         cash         — what drivers are holding tonight
     #settlement/receivables  receivables  — what is outstanding, and from whom */

import { donut, hbars, stackedBar, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, entity,
  dayStr, dtStr, money, pct } from './ui.js';
import { q, href, state } from './data.js';

export const SETTLE_TABS = [
  { id: 'mix', label: 'How fares settle', ic: '◈' },
  { id: 'cash', label: 'Cash in hand', ic: '◧' },
  { id: 'receivables', label: 'Outstanding', ic: '❑' },
];

const TONE = { cash: 'warn', on_account: 'warn', salary: 'warn', complimentary: 'critical',
  card: 'good', wallet: 'good' };

export async function renderSettlement(root, tab = 'mix') {
  root.innerHTML = '';
  root.append(tabBar(SETTLE_TABS, tab, (id) => href('settlement', id === 'mix' ? null : id)));
  const host = el('div'); root.append(host);
  await ({ mix: settleMix, cash: settleCash, receivables: settleReceivables }[tab] || settleMix)(host);
}

async function settleMix(host) {
  loading(host);
  const s = await q('/api/settlement/mix');
  host.innerHTML = '';
  if (!s.classes.length) {
    host.append(note('No booking in this range records how it was paid.'));
    return;
  }
  const total = s.classes.reduce((a, c) => a + c.trips, 0);
  const cash = s.classes.find((c) => c.settlement_class === 'cash');
  const owed = s.classes.filter((c) => ['on_account', 'salary'].includes(c.settlement_class));
  const clean = s.classes.filter((c) => ['card', 'wallet'].includes(c.settlement_class));
  host.append(kpiRow([
    { label: 'Bookings with a settlement route', value: fmt(total),
      sub: s.unlabelled_trips ? `${fmt(s.unlabelled_trips)} record none` : 'all of them' },
    { label: 'Settled at the ride', value: pct((clean.reduce((a, c) => a + c.trips, 0) / total) * 100, 1),
      sub: 'card and wallet — no cash risk, nothing outstanding', tone: 'good' },
    { label: 'Paid in cash', value: cash ? pct((cash.trips / total) * 100, 1) : '—',
      sub: cash ? `${fmt(cash.trips)} bookings` : null, tone: 'warn' },
    { label: 'Settled after the ride', value: pct((owed.reduce((a, c) => a + c.trips, 0) / total) * 100, 1),
      sub: 'on account or against salary', tone: owed.length ? 'warn' : null },
  ]));

  const { panel: p0, body: b0 } = panel('Every booking, by settlement route', null);
  stackedBar(b0, s.classes.map((c) => ({ label: c.label, n: c.trips })));
  host.append(p0);

  const wrap = el('div', 'cards'); host.append(wrap);
  s.classes.forEach((c) => {
    const card = el('div', `card t-${TONE[c.settlement_class] || 'flat'}`);
    card.innerHTML = `
      <div class="card-h"><b>${esc(c.label)}</b><span class="num">${fmt(c.trips)}</span></div>
      <div class="card-n num">${pct(c.trip_share_pct, 1)}</div>
      <p>${esc(c.meaning || '')}</p>
      <dl>
        <div><dt>Revenue</dt><dd class="num">${c.revenue == null ? 'not reported' : money(c.revenue)}</dd></div>
        <div><dt>Average fare</dt><dd class="num">${c.avg_fare == null ? 'not reported' : money(c.avg_fare, 'AED', 2)}</dd></div>
        <div><dt>Priced bookings</dt><dd class="num">${fmt(c.priced_trips)} of ${fmt(c.trips)}</dd></div>
        <div><dt>Channels</dt><dd>${esc(c.platforms.join(', '))}</dd></div>
      </dl>`;
    wrap.append(card);
  });

  if (s.unlabelled_trips) {
    host.append(note(`${fmt(s.unlabelled_trips)} bookings carry no payment label at all`
      + `${s.unlabelled_platforms.length ? ` (${s.unlabelled_platforms.join(', ')})` : ''} and are left out `
      + 'of every share above rather than counted as cash.'));
  }
  host.append(note('"Revenue: not reported" is not zero. The Uber trip export carries no fare column, '
    + 'so for any route that is mostly Uber the count is known and the value is not — and inventing a '
    + 'number there is how this dashboard once reported an average fare of AED 6.98.'));
}

async function settleCash(host) {
  loading(host);
  const c = await q('/api/settlement/cash-exposure');
  host.innerHTML = '';
  host.append(kpiRow([
    { label: 'Cash bookings', value: fmt(c.total_cash_trips), sub: 'driver collected the money directly' },
    { label: 'Value we can see', value: money(c.total_cash_value_known),
      sub: `${pct(c.value_known_pct, 0)} of cash bookings report a fare`,
      tone: c.value_known_pct != null && c.value_known_pct < 60 ? 'warn' : null },
    /* Counted in the database. This was c.drivers.length — the length of a
       list the endpoint caps at 200 — under a label that reads as a fleet
       fact. It is right until the fleet has more than 200 drivers taking cash,
       and then it is quietly a cap. */
    { label: 'Drivers holding cash', value: fmt(c.driver_count ?? c.drivers.length),
      sub: c.truncated ? `${fmt(c.drivers.length)} shown below` : 'every one of them listed below' },
  ]));
  if (c.caveat) host.append(note(c.caveat));
  if (!c.drivers.length) return empty(host, 'No cash booking in this window');
  host.append(tableFrom(c.drivers, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Cash bookings', key: 'cash_trips', num: true },
    { label: 'Value known', key: 'cash_value', num: true, render: (r) => money(r.cash_value) },
    { label: 'Coverage', key: 'value_known_pct', num: true, render: (r) => pct(r.value_known_pct, 0) },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).join(', ')) },
    { label: 'Vehicles', key: 'plates', render: (r) => (r.plates || []).slice(0, 3).map((pl) => entity('vehicle', pl, pl)).join(' ') },
    { label: 'Last cash trip', key: 'last_cash_trip', render: (r) => dtStr(r.last_cash_trip) },
  ]));
  if (c.truncated) host.append(note(
    `Listing the ${fmt(c.drivers.length)} drivers holding the most cash, of ${fmt(c.driver_count)}. `
    + 'The totals above are over all of them.'));
  host.append(note('A fare collected by a supervisor is deliberately excluded: this is the money a '
    + 'driver personally ends a shift holding, which is the number a cash-handling control is sized on.'));
}

async function settleReceivables(host) {
  loading(host);
  const r = await q('/api/settlement/receivables');
  host.innerHTML = '';
  host.append(kpiRow([
    /* Every one of these three came off the visible list, which the endpoint
       caps at 200 counterparties ordered by amount. An outstanding figure that
       silently excludes its own tail is worse than none, because somebody will
       reconcile against it. All three are computed over the table now. */
    { label: 'Outstanding', value: money(r.total),
      sub: `across ${fmt(r.total_trips)} bookings`
        + (r.priced_trips < r.total_trips
          ? `, ${fmt(r.total_trips - r.priced_trips)} of which carry no fare` : '') },
    { label: 'Counterparties', value: fmt(r.counterparties ?? r.rows.length),
      sub: r.truncated ? `${fmt(r.rows.length)} shown below` : 'every one of them listed below' },
    { label: 'Oldest debt', value: r.oldest_days != null ? `${fmt(r.oldest_days)} days` : '—',
      sub: 'since the earliest unsettled booking',
      tone: (r.oldest_days ?? 0) > 60 ? 'warn' : null },
  ]));
  if (!r.rows.length) return empty(host, 'Nothing outstanding in this window');
  host.append(tableFrom(r.rows, [
    { label: 'Owed by', key: 'counterparty', render: (x) => (x.partner_id
      ? entity('property', x.partner_id, x.counterparty)
      : entity('driver', x.driver_ext_id, x.counterparty)) },
    { label: 'Route', key: 'label' },
    { label: 'Bookings', key: 'trips', num: true },
    { label: 'Amount', key: 'amount', num: true, render: (x) => money(x.amount) },
    { label: 'Oldest', key: 'oldest', render: (x) => dayStr(x.oldest) },
    { label: 'Age', key: 'age_days', num: true, render: (x) => (x.age_days == null ? '—' : `${x.age_days}d`) },
    { label: 'Newest', key: 'newest', render: (x) => dayStr(x.newest) },
  ]));
  host.append(note('"Outstanding" here means the fare was recorded as settled after the ride — '
    + 'charged to a room, to a property account, or against an employee’s salary. Whether it has since '
    + 'been collected is not in this data; this is the exposure, not the ledger.'));
}
