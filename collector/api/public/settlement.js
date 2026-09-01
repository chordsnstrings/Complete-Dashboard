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
  dayStr, dateStr, dtStr, timeStr, money, pct, sourceLabel, countOf, plural, verdict } from './ui.js';
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
  const host = el('div', 'stack'); root.append(host);
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

  /* Fields read off /api/settlement/mix on production: total_trips,
     unlabelled_trips, unlabelled_platforms, and classes[] with
     settlement_class, trips, revenue.

     A settlement route decides whether the fleet already HAS the money. Card
     and wallet are done at the ride; cash is in somebody's hand; on-account
     and salary are owed. The bookings that record no route at all are the ones
     this page cannot say anything about, and they were a subtitle. */
  {
    const atRide = clean.reduce((a, c) => a + c.trips, 0);
    const later = owed.reduce((a, c) => a + c.trips, 0);
    const inHand = cash ? cash.trips : 0;
    const blind = +s.unlabelled_trips || 0;
    const outstanding = inHand + later;
    /* The claim says what the figure MEASURES. It used to read "not settled
       at the ride", which is a different set from the one it counted: cash IS
       settled at the ride — the driver was handed the money — it simply has
       not been banked, while the 2,302 bookings the platform settles
       off-platform are not settled at the ride in any sense and are not in
       this number. The tile directly below it says "Settled at the ride
       54.8%", so the two sentences contradicted each other on one screen. */
    verdict(host, {
      claim: outstanding
        ? `${Math.round((outstanding / total) * 100)}% of bookings are still to be collected`
        : 'Every booking is already in the bank',
      figure: fmt(outstanding), unit: 'still to collect',
      tone: total && outstanding / total >= 0.3 ? 'warn' : null,
      meta: `${fmt(total)} with a route`,
      sub: `${fmt(atRide)} settled by card or wallet, ${fmt(inHand)} in cash and ${fmt(later)} on `
        + 'account or against salary.'
        + (blind
          ? ` A further ${fmt(blind)} record no route at all${s.unlabelled_platforms?.length
            ? ` (${s.unlabelled_platforms.map(sourceLabel).join(', ')})` : ''} — this page can say `
            + 'nothing about those.'
          : ''),
    });
  }

  host.append(kpiRow([
    { label: 'Bookings with a settlement route', value: fmt(total),
      sub: s.unlabelled_trips ? `${fmt(s.unlabelled_trips)} record none` : 'all of them' },
    { label: 'Settled at the ride', value: pct((clean.reduce((a, c) => a + c.trips, 0) / total) * 100, 1),
      sub: 'card and wallet — no cash risk, nothing outstanding', tone: 'good' },
    { label: 'Paid in cash', value: cash ? pct((cash.trips / total) * 100, 1) : '—',
      sub: cash ? `${fmt(cash.trips)} bookings` : null, tone: 'warn' },
    { label: 'Settled after the ride', value: pct((owed.reduce((a, c) => a + c.trips, 0) / total) * 100, 1),
      sub: 'on account or against salary', tone: owed.length ? 'warn' : null },
    /* The largest route the summary row was leaving out.
       ─────────────────────────────────────────────────────────────────────
       The three tiles above cover card+wallet, cash, and on-account+salary —
       54.6%, 22.1% and 2.7% on this fleet, which is 79.4% of the bookings. The
       missing fifth was almost all ONE route: settled off-platform, 18.8%,
       2,206 bookings. It has a card further down like every other route, and a
       reader who stops at the tiles — which is what a tile row is for — was
       left with a fifth of the fleet's settlements unaccounted and no hint
       that the remainder was anything in particular.

       It belongs in the summary on its own merits, too: money settled outside
       the app is the route an operator most wants counted, and the one this
       page can say least about. */
    (() => {
      const off = s.classes.find((c) => c.settlement_class === 'off_platform');
      if (!off) return null;
      return { label: 'Settled off-platform', value: pct((off.trips / total) * 100, 1),
        sub: `${fmt(off.trips)} bookings — the platform records the fare as settled outside the `
          + 'app and gives no further detail', tone: 'warn' };
    })(),
    /* Whatever the four tiles above do not name. They covered card, wallet,
       cash, on-account, salary and off-platform — 98.2% — under a first tile
       reading "11,758, all of them", leaving 208 bookings in `adjustment` and
       `complimentary` with no tile and no mention. Computed as a remainder
       rather than from a list, so a route a provider invents next month shows
       up here instead of quietly leaving the tiles short of 100%. */
    (() => {
      const NAMED = new Set(['card', 'wallet', 'cash', 'on_account', 'salary', 'off_platform']);
      const rest = s.classes.filter((c) => !NAMED.has(c.settlement_class));
      const n = rest.reduce((a, c) => a + c.trips, 0);
      if (!n) return null;
      return { label: 'Everything else', value: pct((n / total) * 100, 1),
        sub: `${countOf(n, 'booking')} — ${rest.map((c) => `${c.label || c.settlement_class} `
          + `${fmt(c.trips)}`).join(', ')}. The tiles above and this one cover every booking.` };
    })(),
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
      + `${s.unlabelled_platforms.length ? ` (${s.unlabelled_platforms.map(sourceLabel).join(', ')})` : ''} and are left out `
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
  /* Fields read off /api/settlement/cash-exposure on production:
     total_cash_trips, total_cash_value_known, value_known_pct, and the
     per-driver rows. Cash in a driver's hand is the fleet's money somewhere
     else, and the number that matters is how much of it we cannot even see —
     a cash booking with no fare on it is real money with no figure attached. */
  {
    const known = +c.total_cash_value_known || 0;
    const seen = c.value_known_pct == null ? null : +c.value_known_pct;
    const blind = seen == null ? null : Math.round(100 - seen);
    verdict(host, {
      claim: blind
        ? `${blind}% of cash bookings carry no fare at all`
        : known ? `${money(known)} is in drivers’ hands` : 'No cash booking in this window',
      figure: money(known), unit: 'we can put a figure on',
      tone: blind != null && blind >= 40 ? 'warn' : null,
      meta: `${fmt(c.total_cash_trips)} cash bookings`,
      sub: blind
        ? `The figure above is over the ${Math.round(seen)}% that report one — the rest is real money `
          + 'with no number against it, so this is a floor and not a total.'
        : 'Every cash booking in this window reports a fare.',
      recommend: reported != null && reported > known
        ? `The platforms' own statements say ${money(reported)} — a different measurement of the same `
          + 'money, and the larger of the two.'
        : null,
    });
  }

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
      sub: c.truncated ? `${fmt(c.drivers.length)} shown below` : 'every one of them listed below',
      cohort: c.drivers.length ? 'settlement-cash' : null },
  ]));
  if (c.caveat) host.append(note(c.caveat));
  if (!c.drivers.length) return empty(host, 'No cash booking in this window');
  /* Sortable, and defaulting to the column somebody actually reconciles on.
     The list arrives ordered by cash bookings, so the driver holding the most
     KNOWN money — AED 1,566 — sat 38th behind thirty-seven rows reading "—",
     and there was no way to reach him but to scroll. */
  const cp = panel(`Who is holding it — ${countOf(c.drivers.length, 'driver')}`,
    'One row per person. Value known is the fares of that driver\u2019s cash bookings that carry one '
    + 'and Coverage is the share of them that do; Statement cash is what the platform\u2019s own '
    + 'weekly statement says they took. Two measurements of the same money from opposite sides — '
    + 'never added together, and the statement is matched on the driver\u2019s name, so two people '
    + 'sharing one would merge.');
  host.append(cp.panel);
  cp.body.append(tableFrom(c.drivers, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Cash bookings', key: 'cash_trips', num: true },
    { label: 'Value known', key: 'cash_value', num: true,
      render: (r) => (r.cash_value
        ? money(r.cash_value)
        : '<span class="ent-off" title="none of this driver’s cash bookings reports a fare — the money is real and the figure is not recorded">—</span>') },
    { label: 'Coverage', key: 'value_known_pct', num: true, render: (r) => pct(r.value_known_pct, 0) },
    /* The column that answers the question this page is for. Value known is
       the fares of the cash bookings that carry one, and Uber's export carries
       none — so it read "—" for 106 of the 140 people listed, above a fleet
       tile confidently reporting the platforms' own cash figure. The figure
       behind that tile is per person, and this is it: what the platform's
       weekly statement says this driver took in cash.

       Its own column, never merged into Value known. The two measure the same
       cash from opposite sides — one from the bookings, one from the payout —
       and adding them counts it twice. */
    { label: 'Statement cash', key: 'statement_cash', num: true,
      absent: 'no payout statement in this window reports cash for anybody on this list — the '
        + 'platform statement feeds reach back about 192 days',
      render: (r) => (r.statement_cash == null
        ? '<span class="ent-off" title="no payout statement in this window reports cash for this person">—</span>'
        : `${money(r.statement_cash)}<span class="dim" title="the platform's own weekly statement, over ${
          r.statement_days} day${r.statement_days === 1 ? '' : 's'} it covers"> stmt</span>`) },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).map(sourceLabel).join(', ')) },
    { label: 'Vehicles', key: 'plates',
      render: (r) => ((r.plates || []).slice(0, 3).map((pl) => entity('vehicle', pl, pl)).join(' ')
        || '<span class="ent-off">none recorded</span>') },
    { label: 'Last cash trip', key: 'last_cash_trip',
      sortValue: (r) => (r.last_cash_trip ? Date.parse(r.last_cash_trip) : null),
      render: (r) => (r.last_cash_trip ? `${dateStr(r.last_cash_trip)} ${timeStr(r.last_cash_trip)}` : '—') },
  ], { sortable: true, sortId: 'cash', defaultSort: { key: 'cash_value', dir: 'desc' },
    capped: c.truncated ? `all ${fmt(c.driver_count)} drivers holding cash` : null }));
  /* The cap belongs with the table it caps, not adrift below it. */
  if (c.truncated) cp.body.append(note(
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
    /* The ageing used to be computed INSIDE the window, so the oldest debt at
       days=7 was at most seven days old and the >60-day warn tone was
       unreachable below a 60-day range. RECV_TO_DATE binds only the upper end
       now, and the response says so in ages_over_all_time, so the tile can
       finally mean what it has always said. */
    { label: 'Oldest debt', value: r.oldest_days != null ? countOf(r.oldest_days, 'day') : '—',
      sub: r.ages_over_all_time
        ? 'since the earliest unsettled booking on record'
        : `bounded by the window: this is the oldest inside the selected range, not the oldest debt `
          + 'the fleet holds',
      tone: (r.oldest_days ?? 0) > 60 ? 'warn' : null },
  ]));
  /* r.ageing.buckets, not r.buckets.
     ─────────────────────────────────────────────────────────────────────
     The endpoint has always nested these one level down, inside `ageing`
     beside the as-at date and the note that explains them. This read the top
     level, found undefined, and the guard did the rest: the panel was ABSENT
     rather than empty, so there was nothing on the page to look wrong. Live
     on 2026-09-01 it was hiding four populated rows — 318 bookings and
     AED 36,739 in 0-30 days, 247 and AED 33,695 in 31-60 — AED 70,434 of
     outstanding receivables that the endpoint computed, shipped, and nobody
     ever saw. */
  const buckets = r.ageing?.buckets;
  if (buckets?.length) {
    host.append(tableFrom(buckets, [
      { label: 'Age', key: 'label' },
      { label: 'Counterparties', key: 'counterparties', num: true },
      { label: 'Bookings', key: 'trips', num: true },
      { label: 'Amount', key: 'amount', num: true, render: (x) => money(x.amount) },
    ], { compact: true }));
    /* Which population, said beside the numbers rather than left to be
       inferred. The tiles above are the window — AED 570 across 7 bookings on
       production today — and this table is every unsettled booking up to the
       end of it: AED 70,954 across 571. Both are right and they are not the
       same question, and a reader who meets them stacked without a sentence
       between them is entitled to conclude one of them is broken. */
    host.append(el('p', 'cap',
      `${esc(r.ageing.note || '')} The tiles above cover the selected window; this table covers `
      + `every unsettled booking up to ${dateStr(r.ageing.as_at)}, which is why its total is larger.`));
  }
  if (!r.rows.length) return empty(host, 'Nothing outstanding in this window');
  const rp = panel(`Who owes it — ${countOf(r.rows.length, 'counterparty', 'counterparties')}`,
    'A ride settled against a salary is owed by the person it comes out of, so it is listed under their '
    + 'name; a ride charged to an account is listed under the property. Ordered by amount.');
  host.append(rp.panel);
  rp.body.append(tableFrom(r.rows, [
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
