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
  dayStr, dateStr, dtStr, timeStr, money, pct, sourceLabel, countOf, plural } from './ui.js';
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

  /* Each card is a route. They were plain divs — the Cash card printed 2,650
     bookings and did not link to the Cash tab, and "On account" and "Salary
     deduction" did not link to Outstanding, on a page whose whole structure is
     three tabs answering exactly those three questions. */
  const TAB = { cash: ['settlement', 'cash'], on_account: ['settlement', 'receivables'],
    salary: ['settlement', 'receivables'], complimentary: ['corporate', 'leakage'] };
  const wrap = el('div', 'cards'); host.append(wrap);
  s.classes.forEach((c) => {
    const to = TAB[c.settlement_class];
    const card = el(to ? 'a' : 'div', `card t-${TONE[c.settlement_class] || 'flat'}${to ? ' card-link' : ''}`);
    if (to) card.href = href(...to);
    /* An average over a tenth of the rows is not the average of the class.
       Wallet reported "Average fare AED 101.70" from 10 priced bookings of
       2,753, beside Card's AED 61.27 from 246 of 3,779 — two numbers a reader
       would compare, computed over 0.4% and 6.5% of their populations. */
    const cover = c.trips ? (c.priced_trips / c.trips) * 100 : 0;
    const thin = cover < 50;
    card.innerHTML = `
      <div class="card-h"><b>${esc(c.label)}</b><span class="num">${fmt(c.trips)}</span></div>
      <div class="card-n num">${pct(c.trip_share_pct, 1)}</div>
      <p>${esc(c.meaning || '')}</p>
      <dl>
        <div><dt>Revenue</dt><dd class="num">${c.revenue == null ? 'not reported' : money(c.revenue)}</dd></div>
        <div><dt>Average fare</dt><dd class="num${thin ? ' dim' : ''}"${thin
    ? ` title="over only ${c.priced_trips} of ${c.trips} bookings — too little coverage to compare against another route"`
    : ''}>${c.avg_fare == null ? 'not reported'
    : `${money(c.avg_fare, 'AED', 2)}${thin ? ' *' : ''}`}</dd></div>
        <div><dt>Priced bookings</dt><dd class="num">${fmt(c.priced_trips)} of ${fmt(c.trips)}<span class="dim"> · ${pct(cover, 0)}</span></dd></div>
        <div><dt>Channels</dt><dd>${esc(c.platforms.map(sourceLabel).join(', '))}</dd></div>
      </dl>
      ${to ? '<p class="cap">Open →</p>' : ''}`;
    wrap.append(card);
  });
  if (s.classes.some((c) => c.trips && (c.priced_trips / c.trips) * 100 < 50)) {
    host.append(el('p', 'cap',
      '* the average is over fewer than half of that route\'s bookings, so it describes the priced '
      + 'minority rather than the route. Two starred averages are not comparable with each other.'));
  }

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
  /* The platforms' own cash figure, beside the per-booking one.
     Three pages of this product carry a "cash" number — the Revenue tile, the
     Finance tile and this page — and no two agreed, because each reads a
     different source and none named which. This page measures cash from
     BOOKINGS that report a fare (8.5% of them); the payout statements report
     what the platforms say drivers took. Both are here now, labelled. */
  const [c, rev] = await Promise.all([
    q('/api/settlement/cash-exposure'),
    q('/api/revenue').catch(() => null),
  ]);
  host.innerHTML = '';
  const reported = rev && rev.totals
    ? (rev.totals.cash != null || rev.totals.statement_cash != null
      ? (+rev.totals.cash || 0) + (+rev.totals.statement_cash || 0) : null)
    : null;
  host.append(kpiRow([
    { label: 'Cash bookings', value: fmt(c.total_cash_trips), sub: 'driver collected the money directly' },
    { label: 'Value we can see', value: money(c.total_cash_value_known),
      sub: `over the ${pct(c.value_known_pct, 0)} of cash bookings that report a fare — the rest is real `
        + 'money with no figure attached',
      tone: c.value_known_pct != null && c.value_known_pct < 60 ? 'warn' : null },
    reported != null
      ? { label: 'Cash the platforms report', value: money(reported),
        sub: 'from the payout statements, not from per-booking fares — a different measurement of the '
          + 'same money, and the larger of the two' }
      : { label: 'Cash the platforms report', value: '—',
        sub: 'no payout statement covers this window' },
    /* Counted in the database. This was c.drivers.length — the length of a
       list the endpoint caps at 200 — under a label that reads as a fleet
       fact. It is right until the fleet has more than 200 drivers taking cash,
       and then it is quietly a cap. */
    { label: 'Drivers holding cash', value: fmt(c.driver_count ?? c.drivers.length),
      sub: c.truncated ? `${fmt(c.drivers.length)} shown below` : 'every one of them listed below' },
  ]));
  if (c.caveat) host.append(note(c.caveat));
  if (!c.drivers.length) return empty(host, 'No cash booking in this window');
  /* Sortable, and defaulting to the column somebody actually reconciles on.
     The list arrives ordered by cash bookings, so the driver holding the most
     KNOWN money — AED 1,566 — sat 38th behind thirty-seven rows reading "—",
     and there was no way to reach him but to scroll. */
  host.append(tableFrom(c.drivers, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Cash bookings', key: 'cash_trips', num: true },
    { label: 'Value known', key: 'cash_value', num: true,
      render: (r) => (r.cash_value
        ? money(r.cash_value)
        : '<span class="ent-off" title="none of this driver’s cash bookings reports a fare — the money is real and the figure is not recorded">—</span>') },
    { label: 'Coverage', key: 'value_known_pct', num: true, render: (r) => pct(r.value_known_pct, 0) },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).map(sourceLabel).join(', ')) },
    { label: 'Vehicles', key: 'plates',
      render: (r) => ((r.plates || []).slice(0, 3).map((pl) => entity('vehicle', pl, pl)).join(' ')
        || '<span class="ent-off">none recorded</span>') },
    { label: 'Last cash trip', key: 'last_cash_trip',
      sortValue: (r) => (r.last_cash_trip ? Date.parse(r.last_cash_trip) : null),
      render: (r) => (r.last_cash_trip ? `${dateStr(r.last_cash_trip)} ${timeStr(r.last_cash_trip)}` : '—') },
  ], { sortable: true, sortId: 'cash', defaultSort: { key: 'cash_value', dir: 'desc' },
    capped: c.truncated ? `all ${fmt(c.driver_count)} drivers holding cash` : null }));
  if (c.truncated) host.append(note(
    `Listing the ${fmt(c.drivers.length)} drivers holding the most cash, of ${fmt(c.driver_count)}. `
    + 'The totals above are over all of them.'));
  host.append(note('A fare collected by a supervisor is deliberately excluded: this is the money a '
    + 'driver personally ends a shift holding, which is the number a cash-handling control is sized on. '
    + 'It is also why this page counts fewer cash bookings than the mix tab beside it — the difference '
    + 'is the supervisor-collected ones, which are the fleet\'s money already.'));
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
    /* The ageing is computed INSIDE the window, so it can never exceed it: at
       days=7 the oldest debt on the fleet is at most seven days old, and the
       >60-day warn tone is unreachable below a 60-day range. Said out loud
       until the endpoint ages over all unsettled bookings. */
    { label: 'Oldest debt', value: r.oldest_days != null ? countOf(r.oldest_days, 'day') : '—',
      sub: r.ages_over_all_time
        ? 'since the earliest unsettled booking on record'
        : `bounded by the window: this is the oldest inside the selected range, not the oldest debt `
          + 'the fleet holds',
      tone: (r.oldest_days ?? 0) > 60 ? 'warn' : null },
  ]));
  if (r.buckets) {
    host.append(tableFrom(r.buckets, [
      { label: 'Age', key: 'label' },
      { label: 'Counterparties', key: 'counterparties', num: true },
      { label: 'Bookings', key: 'trips', num: true },
      { label: 'Amount', key: 'amount', num: true, render: (x) => money(x.amount) },
    ], { compact: true }));
  }
  if (!r.rows.length) return empty(host, 'Nothing outstanding in this window');
  host.append(tableFrom(r.rows, [
    /* Branch on the CLASS, not on which id happens to be present. A salary
       deduction row carries both a `partner_id` (the "Office" partner that
       booked the ride) and a `driver_ext_id` (the person who owes it), and
       this tested partner_id first — so nine driver names opened a property
       page, all of them the same property. */
    { label: 'Owed by', key: 'counterparty', render: (x) => (x.settlement_class === 'salary'
      ? entity('driver', x.driver_ext_id, x.counterparty)
      : entity('property', x.partner_id, x.counterparty)) },
    { label: 'Route', key: 'label' },
    { label: 'Bookings', key: 'trips', num: true },
    { label: 'Amount', key: 'amount', num: true, render: (x) => money(x.amount) },
    { label: 'Oldest', key: 'oldest', render: (x) => dateStr(x.oldest) },
    { label: 'Age', key: 'age_days', num: true,
      render: (x) => (x.age_days == null ? '—'
        : `<span class="pill ${x.age_days > 90 ? 'bad' : x.age_days > 60 ? 'warn' : ''}">${x.age_days}d</span>`) },
    { label: 'Newest', key: 'newest', render: (x) => dateStr(x.newest) },
  ], { sortable: true, sortId: 'recv', defaultSort: { key: 'amount', dir: 'desc' },
    capped: r.truncated ? `all ${fmt(r.counterparties)} counterparties` : null }));
  host.append(note('"Outstanding" here means the fare was recorded as settled after the ride — '
    + 'charged to a room, to a property account, or against an employee’s salary. Whether it has since '
    + 'been collected is not in this data; this is the exposure, not the ledger.'));
}
