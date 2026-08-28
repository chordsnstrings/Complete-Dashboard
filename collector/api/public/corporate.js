/* The corporate / hotel channel — five pages, not one panel.
   ──────────────────────────────────────────────────────────────────────────
   This channel is the richest source in the fleet and was the least read. It
   is the only one that reports, per booking: what the ride COST as well as what
   it sold for, which property booked it, which guest travelled, which room they
   were in, whether an authorisation was attached, whether an hourly charter ran
   over, and — uniquely — where the driver set off FROM, which is the only place
   in the whole dataset that the unpaid approach leg is measurable.

     #corporate              overview   — the channel in one screen
     #corporate/properties   properties — who books, and what they are worth
     #corporate/guests       guests     — repeat business
     #corporate/leakage      leakage    — every booking that cost money and should not
     #corporate/approach     approach   — the unpaid kilometres, cut five ways
     #property/<id>          one property

   Each page is an address. Nothing here opens in a modal, because the useful
   thing to do with "the eleven bookings that were given away last month" is to
   send somebody the link. */

import { donut, hbars, areaChart, stackedBar, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, entity,
  dayStr, dateStr, dtStr, money, pct, tripTime, sourceLabel, countOf, plural, noneChosen, verdict } from './ui.js';
import { q, qAll, href, state } from './data.js';

/* Why a whole column is empty, in the words the page prints under it. Shared
   so that the four tables carrying a Cost or a Room say the same thing — four
   wordings for one absence read as four separate problems. */
const COST = 'no booking in this group carries a cost — the hotel channel reports one on the '
  + 'bookings it prices, and a complimentary ride is priced at nothing by definition';
const ROOM = 'no booking in this group names a room — the hotel channel writes an empty string '
  + 'into roomNumber more often than a number, and a blank is not a room';

export const CORP_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'properties', label: 'Properties', ic: '❑' },
  { id: 'guests', label: 'Passengers', ic: '◧' },
  { id: 'leakage', label: 'Leakage', ic: '⚠' },
  { id: 'approach', label: 'Approach legs', ic: '◍' },
];

const grid = (cls = 'grid') => el('div', cls);
const add = (host, title, cap, render) => {
  const { panel: p, body } = panel(title, cap);
  host.append(p); loading(body);
  Promise.resolve(render(body)).catch((e) => { body.innerHTML = ''; body.append(note(`Could not load: ${e.message}`)); });
  return body;
};

export async function renderCorporate(root, tab = 'overview') {
  root.innerHTML = '';
  root.append(tabBar(CORP_TABS, tab, (id) => href('corporate', id === 'overview' ? null : id)));
  const host = el('div', 'stack'); root.append(host);
  const page = { overview: corpOverview, properties: corpProperties, guests: corpGuests,
    leakage: corpLeakage, approach: corpApproach }[tab] || corpOverview;
  await page(host);
}

/* ── overview ─────────────────────────────────────────────────────────── */
async function corpOverview(host) {
  const kpiHost = el('div'); host.append(kpiHost); loading(kpiHost);
  const s = await q('/api/corporate/summary');
  kpiHost.innerHTML = '';
  // A margin needs two different numbers. This channel returns one money value
  // per booking; the API says whether what it stored as `cost` is genuinely a
  // second figure, and if it is not there is no margin to show.
  const grossMargin = s.has_cost ? s.revenue - s.cost : null;

  /* Fields read off /api/corporate/summary on production: bookings, priced,
     revenue, cost, km, deadhead_km, deadhead_measured, foc_trips,
     overrun_trips, scheduled_trips.

     This is the one channel that reports a cost, a property and a guest — so
     it is the only one where a booking given away for free is visible as such.
     That, and the empty kilometres driven to reach the pickup, are what the
     channel is actually costing. */
  {
    const dead = +s.deadhead_km || 0;
    const km = +s.km || 0;
    const deadPct = km ? Math.round((dead / (km + dead)) * 100) : 0;
    const foc = +s.foc_trips || 0;
    verdict(kpiHost, {
      claim: foc
        ? `${countOf(foc, 'booking')} ${foc === 1 ? 'was' : 'were'} given away`
        : s.deadhead_measured && deadPct
          ? `${deadPct}% of the kilometres on this channel are empty`
          : `${fmt(s.bookings)} corporate bookings`,
      figure: s.revenue != null ? money(s.revenue) : fmt(s.bookings),
      unit: s.revenue != null ? 'reported' : 'bookings',
      tone: foc ? 'warn' : null,
      meta: `${fmt(s.bookings)} bookings`,
      sub: (s.deadhead_measured
        ? `${fmt(dead)} km were driven to reach a pickup and carried nobody. `
        : 'Empty kilometres are not measured on this channel. ')
        + (s.priced != null && s.priced < s.bookings
          ? `${fmt(s.bookings - s.priced)} of these bookings carry no price at all.`
          : 'Every booking carries a price.'),
    });
  }

  kpiHost.append(kpiRow([
    { label: 'Bookings', value: fmt(s.bookings), sub: `${s.properties} properties · ${s.guests} guests` },
    { label: 'Revenue', value: money(s.revenue), sub: `over ${fmt(s.priced)} priced bookings` },
    { label: 'Average fare', value: money(s.avg_fare, 'AED', 2), sub: 'complimentary rides excluded' },
    s.has_cost
      ? { label: 'Cost of delivery', value: money(s.cost), sub: 'reported per booking by this channel' }
      /* It divides revenue by EVERY booking's distance — priced_km is not even
         returned on this endpoint — so "over priced bookings only" described a
         denominator the figure does not use. 64,900 over 14,725 km is 4.41. */
      : { label: 'Revenue per km', value: money(s.revenue_per_km, 'AED', 2),
        sub: s.km ? `${money(s.revenue)} over ${fmt(s.km)} km, priced or not` : 'no distance reported' },
    s.has_cost
      ? { label: 'Gross margin', value: money(grossMargin),
          sub: s.revenue ? `${pct((grossMargin / s.revenue) * 100, 1)} of revenue` : null,
          tone: grossMargin > 0 ? 'good' : 'critical' }
      : { label: 'Booked in advance', value: pct(s.scheduled_pct, 1),
          sub: `${fmt(s.scheduled_trips)} of ${fmt(s.bookings)} bookings` },
    /* With the share of bookings it was measured on. "889 km" is a total over
       whatever fraction reported both ends, and the fraction was returned and
       not shown. */
    { label: 'Unpaid approach', value: s.deadhead_km == null ? '—' : `${fmt(s.deadhead_km)} km`,
      sub: [s.deadhead_ratio_pct != null ? `${pct(s.deadhead_ratio_pct, 1)} of paid distance` : null,
        s.deadhead_measured_pct != null
          ? `measured on ${pct(s.deadhead_measured_pct, 0)} of bookings`
          : null].filter(Boolean).join(' · ') || null,
      tone: s.deadhead_ratio_pct > 20 ? 'warn' : null },
    { label: 'Given away', value: fmt(s.foc_trips), sub: 'complimentary bookings',
      tone: s.foc_trips > 0 ? 'warn' : null },
    /* Three figures the summary returns and the page never drew. An
       authorisation rate is the control this channel exists to enforce, and a
       booking that ends outside Dubai is a dispatch problem with an address. */
    s.authorized_pct != null
      ? { label: 'Carried an authorisation', value: pct(s.authorized_pct, 1),
        sub: 'of bookings at properties that require one',
        tone: s.authorized_pct < 50 ? 'warn' : null }
      : null,
    s.outside_dubai
      ? { label: 'Ended outside Dubai', value: fmt(s.outside_dubai),
        sub: 'a booking the driver has to come back from empty', tone: 'warn' }
      : null,
    /* A bare "3,632" under a label naming no unit. It is a Herfindahl index —
       the sum of each property's squared share, out of 10,000 — and without
       the scale beside it the number says nothing to anyone who has not met
       one before. */
    { label: 'Client concentration', value: s.concentration_hhi == null ? '—' : fmt(s.concentration_hhi),
      sub: s.top_property
        ? `${s.top_property} is ${pct(s.top_property_share_pct, 0)} · Herfindahl index out of 10,000, `
          + `where above 2,500 is a concentrated book and ${fmt(10000)} is a single client`
        : null,
      tone: s.concentration_hhi > 2500 ? 'warn' : null },
  ]));

  if (!s.bookings) {
    host.append(note('No corporate bookings in this window. The hotel collector writes to the '
      + 'same trip table as every other channel — check Data sources if this looks wrong.'));
    return;
  }

  const g = grid(); host.append(g);

  add(g, 'Who books', 'Bookings by property. Click one to open its page.', async (body) => {
    const rows = await q('/api/corporate/properties');
    body.innerHTML = '';
    hbars(body, rows.slice(0, 10).map((r) => ({ label: r.name, n: r.bookings, id: r.partner_id })), {
      onClick: (d) => { location.hash = href('property', d.id); },
    });
    body.append(el('p', 'cap', `A Herfindahl index of ${fmt(s.concentration_hhi)} out of 10,000. `
      + 'Above 2,500 is a business resting on one customer.'));
  });

  add(g, 'How the fare is settled', 'Cash, card, on account, or given away.', async (body) => {
    const mix = await q('/api/settlement/mix', { platform: 'hotel' });
    body.innerHTML = '';
    if (!mix.classes.length) return empty(body, 'No booking in this range records how it was paid');
    stackedBar(body, mix.classes.map((c) => ({ label: c.label, n: c.trips })));
    const owed = mix.classes.filter((c) => ['on_account', 'salary'].includes(c.settlement_class));
    body.append(el('p', 'cap',
      owed.length
        ? `${fmt(owed.reduce((a, c) => a + c.trips, 0))} bookings are settled after the ride — `
          + `see Settlement → Receivables for what is outstanding and from whom.`
        : 'Every booking in this window settled at the time of the ride.'));
  });

  add(g, 'What is booked', 'Booking types on this channel are not Uber tiers and never share an axis with them.', async (body) => {
    const rows = await q('/api/mix', { by: 'product', platform: 'hotel' });
    body.innerHTML = '';
    donut(body, rows.map((r) => ({ label: String(r.label).replace(/^hotel: /, '').replace(/_/g, ' '), n: r.n })));
  });

  add(g, 'The unpaid approach leg', 'Straight-line distance from where the driver set off to where the passenger got in.', async (body) => {
    const rows = await q('/api/corporate/approach', { by: 'daypart' });
    body.innerHTML = '';
    if (!rows.length) return empty(body, 'No booking in this range records where the driver set off from');
    hbars(body, rows.map((r) => ({ label: r.label, n: r.avg_deadhead_km })), {
      valueFmt: (v) => `${fmt(v, 2)} km`,
      onClick: () => { location.hash = href('corporate', 'approach', 'daypart'); },
    });
    body.append(el('p', 'cap', 'Approach only — driver to pickup. A straight line understates road '
      + 'distance, so treat these as a floor, and the return leg (usually the larger of the two) is on '
      + 'the Approach legs tab. It is the only measure of positioning cost anywhere in this dataset.'));
  });

  add(g, 'Booked ahead or called on the spot', null, async (body) => {
    body.innerHTML = '';
    donut(body, [
      { label: 'Scheduled in advance', n: s.scheduled_trips },
      { label: 'On demand', n: s.bookings - s.scheduled_trips },
    ]);
    body.append(el('p', 'cap', `${pct(s.scheduled_pct, 0)} of bookings arrive with notice. `
      + 'That share is how much of the day can be planned rather than reacted to.'));
  });

  add(g, 'What is going wrong', 'Every booking that cost money and should not have.', async (body) => {
    const l = await q('/api/corporate/leakage');
    body.innerHTML = '';
    const live = l.kinds.filter((k) => k.n > 0);
    if (!live.length) return empty(body, 'Nothing leaking in this window');
    const wrap = el('div', 'leaks');
    live.forEach((k) => {
      const a = el('a', 'leak');
      a.href = href('corporate', 'leakage', k.kind);
      a.innerHTML = `<b class="num">${fmt(k.n)}</b><span>${esc(k.label)}</span>`;
      wrap.append(a);
    });
    body.append(wrap);
    body.append(el('p', 'cap', [
      l.summary.foc_cost ? `${money(l.summary.foc_cost)} of delivery cost was given away.` : null,
      l.summary.wasted_km ? `${fmt(l.summary.wasted_km, 1)} km driven to reach jobs shorter than the approach.` : null,
    ].filter(Boolean).join(' ') || 'Click any figure for the bookings behind it.'));
  });

  host.append(note('Everything on this page comes from fields that were being collected and stored but '
    + 'never read: the property, the booking type, the payment route, the room, the authorisation, and '
    + 'the driver’s starting point — which makes this the only channel in the fleet where the unpaid '
    + 'approach leg is measurable at all.'
    + (s.has_cost ? '' : ' It does not report a delivery cost: the report returns one money figure per '
      + 'booking, so there is a fare and no margin, and nothing here pretends otherwise.')));
}

/* ── properties ───────────────────────────────────────────────────────── */
async function corpProperties(host) {
  loading(host);
  const rows = await q('/api/corporate/properties');
  host.innerHTML = '';
  if (!rows.length) return empty(host, 'No property booked in this window');
  const totalB = rows.reduce((a, r) => a + r.bookings, 0);
  const totalR = rows.reduce((a, r) => a + (+r.revenue || 0), 0);
  /* The widest table on the page began with no heading of any kind. */
  const pp = panel(`Every property that books — ${countOf(rows.length, 'property', 'properties')}`,
    `${fmt(totalB)} bookings worth ${money(totalR)} in this window, ordered by revenue.`);
  host.append(pp.panel);
  pp.body.append(tableFrom(rows, [
    { label: 'Property', key: 'name', render: (r) => entity('property', r.partner_id, r.name) },
    { label: 'Bookings', key: 'bookings', num: true, render: (r) => `${fmt(r.bookings)} <small class="dim">${pct((r.bookings / totalB) * 100, 1)}</small>` },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
    /* Revenue divided by Bookings does not give Avg fare, because avg fare is
       over the bookings that CARRY a fare — 766 booked, 755 priced. Without
       the divisor on screen the column looked like an arithmetic error. */
    { label: 'With a fare', key: 'priced', num: true,
      render: (r) => (r.priced == null ? '—'
        : `${fmt(r.priced)}${r.priced < r.bookings
          ? ` <small class="dim">of ${fmt(r.bookings)}</small>` : ''}`) },
    { label: 'Avg fare', key: 'avg_fare', num: true, render: (r) => money(r.avg_fare, 'AED', 2) },
    ...(rows.some((r) => r.cost != null && r.cost !== r.revenue) ? [
      { label: 'Cost', key: 'cost', num: true, absent: COST, render: (r) => money(r.cost) },
      { label: 'Margin', key: 'm', num: true, render: (r) => (r.revenue != null && r.cost != null
        ? `${money(r.revenue - r.cost)} <small class="dim">${pct(((r.revenue - r.cost) / r.revenue) * 100, 0)}</small>` : '—') },
    ] : []),
    { label: 'AED/km', key: 'revenue_per_km', num: true, render: (r) => money(r.revenue_per_km, 'AED', 2) },
    { label: 'Guests', key: 'guests', num: true },
    { label: 'Bookings/guest', key: 'bookings_per_guest', num: true, render: (r) => fmt(r.bookings_per_guest, 2) },
    { label: 'Approach', key: 'avg_deadhead_km', num: true, render: (r) => (r.avg_deadhead_km == null ? '—' : `${fmt(r.avg_deadhead_km, 2)} km`) },
    { label: 'Scheduled', key: 'scheduled_pct', num: true, render: (r) => pct(r.scheduled_pct, 0) },
    { label: 'Hourly', key: 'hourly', num: true },
    { label: 'Given away', key: 'foc', num: true },
    { label: 'Last booking', key: 'last_at', render: (r) => dateStr(r.last_at) },
  ], { sortable: true, sortId: 'props', defaultSort: { key: 'revenue', dir: 'desc' } }));
  pp.body.append(el('p', 'cap',
    'Avg fare is revenue over the bookings that carry one, not over all of them, so Revenue ÷ Bookings '
    + 'will read slightly low wherever the two counts differ. AED/km divides the same revenue by the '
    + 'distance of every booking, priced or not.'));
  host.append(note(rows.some((r) => r.cost != null && r.cost !== r.revenue)
    ? 'Margin is revenue minus the cost this channel reports per booking.'
    : 'There is no margin column because there is no cost: this report returns a single money figure per '
      + 'booking. Not every row here is a hotel either — the booking system uses the same field for '
      + 'internal categories such as office transport and self-managed rides, and they are shown as they '
      + 'are labelled rather than quietly folded into a property.'));
}

/* ── passengers ───────────────────────────────────────────────────────── */
async function corpGuests(host) {
  loading(host);
  const g = await q('/api/corporate/guests');
  host.innerHTML = '';

  if (g.id_is_per_booking) {
    // The honest version of this page. A repeat rate of 0% here would be a
    // statement about the identifier, and displaying it as a KPI would be a
    // statement about the customers — which is not the same thing and is not
    // supported by anything in this data.
    host.append(kpiRow([
      { label: 'Passenger records', value: fmt(g.total_guests), sub: `across ${fmt(g.total_bookings)} bookings` },
      { label: 'Bookings with a room number', value: fmt(g.bookings_with_room),
        sub: g.total_bookings ? pct((g.bookings_with_room / g.total_bookings) * 100, 1) + ' of bookings' : null },
      /* With the denominator. "21 rooms seen more than once" is a different
         claim depending on whether the channel has ever named 25 rooms or
         2,500, and distinct_rooms has been in this payload all along. */
      { label: 'Rooms seen more than once', value: g.distinct_rooms
        ? `${fmt(g.repeat_rooms ?? g.rooms.length)} of ${fmt(g.distinct_rooms)}`
        : fmt(g.repeat_rooms ?? g.rooms.length),
        sub: [g.repeat_bookings ? `${fmt(g.repeat_bookings)} bookings between them` : null,
          g.distinct_rooms ? `${fmt(g.distinct_rooms)} distinct rooms named in this window` : null]
          .filter(Boolean).join(' · ') || null,
        tone: (g.repeat_rooms ?? g.rooms.length) ? 'good' : null },
      /* A tile reading "not measurable" with nothing beside it is a tile that
         looks broken. The reason is one line down in `g.caveat` and belongs
         here: this channel issues a NEW passenger id per booking, so two rides
         by the same person are two strangers and no repeat rate can be
         computed from them at all. */
      { label: 'Repeat travel', value: 'not measurable', tone: 'warn',
        sub: `this channel issues a new passenger id per booking — ${fmt(g.total_guests)} ids `
          + `across ${fmt(g.total_bookings)} rides, so the same person twice is two strangers` },
    ]));
    host.append(note(g.caveat));
    if (g.rooms.length) {
      const { panel: p, body } = panel('Rooms that travelled more than once',
        'The only thing on this channel that recurs. A room is not a person — a returning guest and two '
        + 'different guests in the same room look identical here — but a room booking cars repeatedly is '
        + 'still worth knowing about.');
      if (g.rooms_truncated) {
        body.append(note(`Showing the ${fmt(g.rooms.length)} busiest of ${fmt(g.repeat_rooms)} rooms `
          + 'that travelled more than once. The tile above counts all of them.'));
      }
      body.append(tableFrom(g.rooms, [
        { label: 'Room', key: 'room_no', absent: ROOM },
        { label: 'Property', key: 'property',
          render: (r) => entity('property', r.partner_id, r.property)
            + (r.properties > 1 ? ` <span class="dim">+${r.properties - 1} more</span>` : '') },
        { label: 'Bookings', key: 'bookings', num: true },
        { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
        { label: 'First', key: 'first_at', render: (r) => dateStr(r.first_at) },
        { label: 'Last', key: 'last_at', render: (r) => dateStr(r.last_at) },
      ], { sortable: true, sortId: 'rooms', defaultSort: { key: 'bookings', dir: 'desc' } }));
      host.append(p);
    }
    const { panel: p2, body: b2 } = panel('Every passenger record',
      'One row per booking, because that is what this channel issues.');
    b2.append(tableFrom(g.guests, GUEST_COLS,
      { sortable: true, sortId: 'guests', defaultSort: { key: 'bookings', dir: 'desc' },
        capped: g.total_guests > g.guests.length ? `all ${fmt(g.total_guests)} records` : null }));
    if (g.total_guests > g.guests.length) {
      b2.append(el('p', 'cap',
        `Showing ${fmt(g.guests.length)} of ${countOf(g.total_guests, 'passenger record')}, busiest first. `
        + 'The tiles above are over all of them.'));
    }
    host.append(p2);
    return;
  }

  host.append(kpiRow([
    { label: 'Guests', value: fmt(g.total_guests), sub: `across ${fmt(g.total_bookings)} bookings` },
    { label: 'Booked more than once', value: fmt(g.repeat_guests), sub: pct(g.repeat_rate_pct, 1) + ' of guests' },
    { label: 'Bookings from repeat guests', value: pct(g.bookings_from_repeat_pct, 1),
      tone: g.bookings_from_repeat_pct > 40 ? 'good' : null },
    { label: 'Bookings per guest', value: g.total_guests ? fmt(g.total_bookings / g.total_guests, 2) : '—',
      sub: g.total_guests ? `${fmt(g.total_bookings)} rides across ${fmt(g.total_guests)} guests` : null },
  ]));
  host.append(note('A short window understates repeat business by construction: a guest who books once a '
    + 'quarter looks like a stranger inside a 30-day range. Widen the range above to see the real pattern.'));
  if (!g.guests.length) return empty(host, 'No passenger identified in this window');
  host.append(tableFrom(g.guests, GUEST_COLS,
    { sortable: true, sortId: 'guests2', defaultSort: { key: 'bookings', dir: 'desc' },
      capped: g.total_guests > g.guests.length ? `all ${fmt(g.total_guests)} guests` : null }));
  if (g.total_guests > g.guests.length) {
    host.append(el('p', 'cap',
      `Showing ${fmt(g.guests.length)} of ${countOf(g.total_guests, 'guest')}, busiest first.`));
  }
}

const GUEST_COLS = [
  { label: 'Record', key: 'guest_id', render: (r) => `<code>${esc(String(r.guest_id).slice(-8))}</code>` },
  { label: 'Property', key: 'property', render: (r) => entity('property', r.partner_id, r.property) },
  { label: 'Room', key: 'room_no', absent: ROOM },
  { label: 'Bookings', key: 'bookings', num: true },
  { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
  { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
  { label: 'When', key: 'first_at', render: (r) => dayStr(r.first_at) },
  { label: 'Purpose', key: 'purpose', render: (r) => esc((r.purpose || '').replace(/\s+/g, ' ').slice(0, 40) || '—') },
];

/* ── leakage ──────────────────────────────────────────────────────────── */
async function corpLeakage(host, kind = state.sub) {
  loading(host);
  const l = await q('/api/corporate/leakage', kind ? { kind } : {});
  host.innerHTML = '';
  const strip = el('div', 'leaks');
  l.kinds.forEach((k) => {
    // A category that CANNOT fire is not the same as one that found nothing,
    // and must not read as a clean bill of health.
    const a = el(k.disabled ? 'div' : 'a', `leak${k.kind === kind ? ' on' : ''}${k.n ? '' : ' zero'}${k.disabled ? ' off' : ''}`);
    if (!k.disabled) a.href = href('corporate', 'leakage', k.kind === kind ? null : k.kind);
    a.innerHTML = `<b class="num">${k.disabled ? 'n/a' : fmt(k.n)}</b><span>${esc(k.label)}</span>`;
    if (k.disabled) a.title = k.disabled;
    strip.append(a);
  });
  host.append(strip);
  const off = l.kinds.filter((k) => k.disabled);
  if (off.length) off.forEach((k) => host.append(note(`${k.label}: ${k.disabled}`)));

  const sum = l.summary;
  host.append(kpiRow([
    { label: 'Bookings in window', value: fmt(sum.total) },
    // This channel reports no delivery cost, so a giveaway is measured in the
    // things it does record: distance driven and a driver's time.
    sum.foc_cost != null
      ? { label: 'Cost of rides given away', value: money(sum.foc_cost), tone: 'warn' }
      : { label: 'Given away', value: sum.foc_km == null ? '—' : `${fmt(sum.foc_km, 1)} km`,
          sub: sum.foc_hours ? `${fmt(sum.foc_hours, 1)} driver-hours` : 'no cost is reported on this channel',
          tone: sum.foc_km ? 'warn' : null },
    { label: 'Value of hourly overruns', value: money(sum.overrun_value),
      sub: 'billed or not is not in this record' },
    { label: 'Km driven to reach shorter jobs', value: sum.wasted_km == null ? '—' : `${fmt(sum.wasted_km, 1)} km` },
    { label: 'Properties requiring approval', value: `${fmt(sum.properties_requiring_approval)} of ${fmt(sum.properties)}`,
      sub: 'a missing authorisation only counts at these' },
  ]));

  if (!kind) {
    host.append(note('Pick a category above to see the named, dated bookings behind it. Each row '
      + 'links to the driver and the vehicle, so a number becomes a conversation.'));
    return;
  }
  const meta = l.kinds.find((k) => k.kind === kind);
  const { panel: p, body } = panel(meta?.label || kind, meta?.why || null);
  host.append(p);
  if (!l.rows.length) { empty(body, 'Nothing in this category for this window'); return; }
  body.append(tableFrom(l.rows, [
    { label: 'When', key: 'requested_at', render: (r) => tripTime(r.plate, r.requested_at) },
    { label: 'Property', key: 'property', render: (r) => entity('property', r.partner_id, r.property) },
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Type', key: 'product', render: (r) => esc(String(r.product || '—').replace(/_/g, ' ')) },
    { label: 'Paid by', key: 'payment_type', render: (r) => esc(r.payment_type || '—') },
    { label: 'Fare', key: 'price', num: true,
      absent: 'no booking in this group reports a fare — the hotel channel prices the bookings it '
        + 'charges a property for, and a complimentary ride is not one of them',
      render: (r) => money(r.price) },
    { label: 'Cost', key: 'cost', num: true, absent: COST, render: (r) => money(r.cost) },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Approach', key: 'deadhead_km', num: true, render: (r) => (r.deadhead_km == null ? '—' : `${fmt(r.deadhead_km, 1)} km`) },
    { label: 'Room', key: 'room_no', absent: ROOM },
    { label: 'Authorised', key: 'has_authorization',
      render: (r) => (r.has_authorization
        ? '<span class="tag ok">yes</span>'
        : '<span class="tag warn">no</span>') },
  ], { sortable: true, sortId: `leak-${kind}`, defaultSort: { key: 'requested_at', dir: 'desc' } }));
}

/* ── approach legs ────────────────────────────────────────────────────── */
const APPROACH_BY = [
  { id: 'property', label: 'By property' }, { id: 'daypart', label: 'By time of day' },
  { id: 'driver', label: 'By driver' }, { id: 'type', label: 'By booking type' },
  { id: 'zone', label: 'By zone' },
];
async function corpApproach(host) {
  const by = APPROACH_BY.some((b) => b.id === state.sub) ? state.sub : 'property';
  host.append(tabBar(APPROACH_BY, by, (id) => href('corporate', 'approach', id)));
  const body = el('div', 'stack'); host.append(body); loading(body);
  const [rows, stranding] = await Promise.all([
    q('/api/corporate/approach', { by }),
    q('/api/corporate/stranding').catch(() => []),
  ]);
  body.innerHTML = '';
  if (!rows.length) return empty(body, 'No booking in this range records where the driver set off from');

  /* This page reported the approach leg alone and called it deadhead. That is
     half the empty running, and the forgivable half — sending a car to collect
     somebody is the cost of doing the job. The expensive half is where the
     driver is LEFT, and the hotel API has been reporting it all along. */
  const anyReturn = rows.some((r) => r.measured_return > 0);
  const tot = rows.reduce((a, r) => ({
    approach: a.approach + (+r.deadhead_km || 0),
    ret: a.ret + (+r.return_km || 0),
    both: a.both + (+r.both_km || 0),
    bothN: a.bothN + (r.measured_both || 0),
    stranded: a.stranded + (r.stranded_15km || 0),
  }), { approach: 0, ret: 0, both: 0, bothN: 0, stranded: 0 });

  body.append(kpiRow([
    { label: 'Approach — driver to pickup', value: `${fmt(tot.approach, 1)} km`,
      sub: 'the leg this page used to report on its own' },
    { label: 'Return — drop-off to wherever they ended up',
      value: anyReturn ? `${fmt(tot.ret, 1)} km` : '—',
      sub: anyReturn ? 'never measured until now' : 'this channel reports no driver end position',
      tone: tot.ret > tot.approach ? 'critical' : tot.ret > 0 ? 'warn' : null },
    { label: 'Both legs, where both were measured',
      value: tot.bothN ? `${fmt(tot.both, 1)} km` : '—',
      sub: tot.bothN ? `over ${fmt(tot.bothN)} bookings that report both ends` : 'nothing reports both' },
    { label: 'Ended more than 15 km from anywhere', value: fmt(tot.stranded),
      sub: 'a dispatch problem with an address on it', tone: tot.stranded ? 'warn' : null },
  ]));
  if (anyReturn && tot.ret > tot.approach) {
    body.append(note(`The return leg is larger than the approach — ${fmt(tot.ret, 1)} km against `
      + `${fmt(tot.approach, 1)} km. Every previous version of this page reported only the smaller of `
      + 'the two, so the fleet\u2019s unpaid running has been understated by more than half.'));
  }

  /* Titled for what it draws. "Unpaid kilometres, both directions" sat over a
     chart of one leg, corrected by a caption underneath — a heading that has
     to be walked back by the sentence below it is a heading that is wrong. */
  const { panel: p, body: chart } = panel('The approach leg, by ' + by,
    'Driver to pickup only. The return leg — usually the larger of the two — is the column beside it '
    + 'in the table below, because a group with only one leg measured cannot be summed with one that '
    + 'has both.');
  hbars(chart, rows.slice(0, 15).map((r) => ({ label: r.label, n: +r.deadhead_km || 0 })),
    { valueFmt: (v) => `${fmt(v, 1)} km`, color: '--s3', signed: false });
  chart.append(el('p', 'cap', rows.length > 15
    ? `The 15 largest of ${countOf(rows.length, 'group')}, by total approach kilometres.`
    : `All ${countOf(rows.length, 'group')}, by total approach kilometres.`));
  body.append(p);
  /* The per-BOOKING column. Ranked by total, a property with 900 bookings at
     0.23 km each outranks one with 40 at 4.78 — and the second is the dispatch
     finding. `avg_deadhead_km` was returned and drawn nowhere. */
  const perBooking = [...rows].filter((r) => r.avg_deadhead_km != null)
    .sort((a, b) => (+b.avg_deadhead_km || 0) - (+a.avg_deadhead_km || 0));
  if (perBooking.length > 1) {
    const worst = perBooking[0], best = perBooking[perBooking.length - 1];
    if (+worst.avg_deadhead_km > +best.avg_deadhead_km * 2) {
      body.append(note(`Per booking rather than in total: ${worst.label} averages `
        + `${fmt(worst.avg_deadhead_km, 2)} km of approach against ${best.label}'s `
        + `${fmt(best.avg_deadhead_km, 2)} km — `
        + `${fmt((+worst.avg_deadhead_km) / Math.max(0.01, +best.avg_deadhead_km), 0)}x. `
        + 'The bars above rank by total, which puts the busiest group first rather than the most '
        + 'expensive one to serve; sort the "Approach per booking" column below to see it the other way.'));
    }
  }
  /* `'By property'.replace('By ', '')` gave a header reading "property" in a
     table where every other header is sentence case — and the same for "time
     of day", "booking type" and "zone". */
  const byLabel = (() => {
    const t = APPROACH_BY.find((b) => b.id === by).label.replace('By ', '');
    return t.charAt(0).toUpperCase() + t.slice(1);
  })();
  const ap = panel(`Both legs, ${APPROACH_BY.find((b) => b.id === by).label.toLowerCase()}`
    + ` — ${countOf(rows.length, 'row')}`,
    'Approach is the leg before the fare starts; return is the leg after it ends. Both are measured '
    + 'only where the booking reports that end, so Measured is the honest denominator for every '
    + 'per-booking figure beside it.');
  body.append(ap.panel);
  ap.body.append(tableFrom(rows, [
    { label: byLabel, key: 'label', render: (r) => esc(r.label) },
    { label: 'Bookings', key: 'bookings', num: true },
    { label: 'Measured', key: 'measured', num: true, render: (r) => `${fmt(r.measured)} <small class="dim">${pct((r.measured / r.bookings) * 100, 0)}</small>` },
    { label: 'Approach km', key: 'deadhead_km', num: true, render: (r) => fmt(r.deadhead_km, 1) },
    { label: 'Approach per booking', key: 'avg_deadhead_km', num: true,
      render: (r) => (r.avg_deadhead_km == null
        ? '<span class="ent-off" title="no booking in this group reports where the driver set off from">—</span>'
        : `${fmt(r.avg_deadhead_km, 2)} km`) },
    { label: 'Return km', key: 'return_km', num: true,
      render: (r) => (r.measured_return ? fmt(r.return_km, 1) : '<span class="dim">not reported</span>') },
    { label: 'Return per booking', key: 'avg_return_km', num: true,
      render: (r) => (r.avg_return_km == null
        ? '<span class="ent-off" title="this channel reports no driver end position for this group">—</span>'
        : `${fmt(r.avg_return_km, 2)} km`) },
    { label: 'Avg both legs', key: 'avg_both_km', num: true,
      render: (r) => (r.measured_both
        ? `${fmt(r.avg_both_km, 2)} km <small class="dim">over ${fmt(r.measured_both)}</small>`
        : '<span class="dim">—</span>') },
    { label: 'Paid km', key: 'paid_km', num: true, render: (r) => fmt(r.paid_km, 1) },
    { label: 'Approach ÷ paid', key: 'ratio_pct', num: true, render: (r) => pct(r.ratio_pct, 1) },
    { label: 'Both ÷ paid', key: 'both_ratio_pct', num: true,
      render: (r) => (r.measured_both ? pct(r.both_ratio_pct, 1) : '<span class="dim">—</span>') },
  ], { sortable: true, sortId: `approach-${by}`, defaultSort: { key: 'deadhead_km', dir: 'desc' } }));
  body.append(note('Every one of these kilometres is driven with nobody paying. "Both ÷ paid" is '
    + 'computed only over bookings that report BOTH ends — adding a measured approach to an '
    + 'unmeasured return and dividing by every booking would produce a confident understatement, '
    + 'which is what the single-leg version of this page was.'));

  /* Where a job ends and leaves the driver with nothing. This is the
     operational counterpart to the corridor view: not where work happens, but
     which drop-off points cost the most to walk away from. */
  if (stranding.length) {
    const { panel: sp, body: sb } = panel('Drop-off points that leave a driver furthest from the next job',
      'Ranked by how far the driver had to travel after the passenger got out. At least three measured drops each.');
    body.append(sp);
    hbars(sb, stranding.slice(0, 12).map((r) => ({ label: r.place, n: +r.avg_return_km || 0 })),
      { valueFmt: (v) => `${fmt(v, 2)} km`, color: '--s8' });
    sb.append(tableFrom(stranding, [
      { label: 'Drop-off area', key: 'place' },
      { label: 'Drops', key: 'drops', num: true },
      { label: 'Measured', key: 'measured', num: true },
      { label: 'Avg return', key: 'avg_return_km', num: true, render: (r) => `${fmt(r.avg_return_km, 2)} km` },
      { label: 'Worst', key: 'worst_km', num: true, render: (r) => `${fmt(r.worst_km, 1)} km` },
      /* Zero is a NUMBER here, and a useful one: "no drop in this area left the
         driver more than 15 km from the next job" is the answer, and it was
         being rendered as an em-dash — which reads as "not measured" on a
         column whose neighbours are all measurements. Twenty-two rows of that
         made the column look broken rather than clean. */
      { label: 'Over 15 km', key: 'over_15km', num: true,
        render: (r) => (r.over_15km
          ? `<span class="pill warn">${fmt(r.over_15km)}</span>`
          : (r.over_15km === 0 ? '<span class="dim">0</span>' : '—')) },
      { label: 'Avg paid trip', key: 'avg_paid_km', num: true, render: (r) => `${fmt(r.avg_paid_km, 1)} km` },
    ], { compact: true, sortable: true, sortId: 'strand',
      defaultSort: { key: 'avg_return_km', dir: 'desc' } }));
    sb.append(el('p', 'cap',
      'A short paid trip that ends somewhere with a long return is worse than a long one that ends '
      + `on a rank. Compare the last two columns: ${esc(stranding[0].place)} averages `
      + `${fmt(stranding[0].avg_paid_km, 1)} km paid and ${fmt(stranding[0].avg_return_km, 2)} km unpaid afterwards.`));
  }
}

/* ── one property ─────────────────────────────────────────────────────── */
export const PROPERTY_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'guests', label: 'Passengers', ic: '◧' },
  { id: 'drivers', label: 'Drivers', ic: '◨' },
];

export async function renderProperty(root, id, tab = 'overview', onDetail) {
  root.innerHTML = '';
  /* #property with nothing after it is reachable — from a typed URL, a stale
     bookmark, a link whose id never got filled in — and it went straight to the
     endpoint and printed "Could not load: 400 id required". A page has to say
     which property it wants and offer the list, not hand back the API's
     complaint about a missing query parameter. */
  if (!id) return noneChosen(root, 'property', 'corporate', 'Every property that books', 'properties');
  root.append(tabBar(PROPERTY_TABS, tab, (t) => href('property', id, t === 'overview' ? null : t)));
  const host = el('div', 'stack'); root.append(host); loading(host);
  let d;
  try { d = await qAll('/api/corporate/property', { id }); }
  catch (e) {
    host.innerHTML = '';
    /* A property that does not exist and a property that was quiet are
       different sentences. A 404 on an id means nothing in the record matches
       it at all — a merged partner, or a stale link — and telling the reader
       to widen the range sends them looking for something that is not there. */
    if (/404|not found/i.test(e.message)) {
      const box = el('div', 'empty');
      box.innerHTML = '<b>No property with that id</b>Nothing in the record matches it — it may have '
        + 'been merged into another partner, or the link may be stale. This is not a quiet window.';
      const back = el('p', 'cap');
      back.innerHTML = `<a class="lnk" href="${href('corporate', 'properties')}">Every property that books</a>`;
      box.append(back);
      host.append(box);
      return;
    }
    host.append(note(`Could not load: ${e.message}`, 'err'));
    return;
  }
  onDetail?.(d.profile);
  host.innerHTML = '';

  if (tab === 'guests') {
    /* The same caveat #corporate/guests carries. This channel's "guest id" is
       issued per BOOKING, so 40 hex ids under a heading reading "Passengers"
       are 40 bookings and not 40 people — and this page said nothing. */
    host.append(note('This channel issues a passenger id per BOOKING, not per person, so a row here is '
      + 'one booking. A returning guest appears as several rows and there is no way to tell them from '
      + 'several different guests. The room number is the only thing on this channel that recurs.'));
    host.append(tableFrom(d.guests, [
      { label: 'Record', key: 'guest_id', render: (r) => `<code>${esc(String(r.guest_id).slice(-8))}</code>` },
      { label: 'Room', key: 'room_no', absent: ROOM,
        render: (r) => (r.room_no ? esc(r.room_no)
          : '<span class="ent-off" title="this booking records no room number">—</span>') },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
      { label: 'First', key: 'first_at', render: (r) => dateStr(r.first_at) },
      { label: 'Last', key: 'last_at', render: (r) => dateStr(r.last_at) },
    ], { sortable: true, sortId: 'pguests', defaultSort: { key: 'bookings', dir: 'desc' },
      capped: ((d.guests_total ?? d.profile?.guests) > d.guests.length)
        ? `all ${fmt(d.guests_total ?? d.profile?.guests)} records` : null }));
    const gTotal = d.guests_total ?? d.profile?.guests;
    if (gTotal && gTotal > d.guests.length) {
      host.append(el('p', 'cap',
        `Showing ${fmt(d.guests.length)} of ${countOf(gTotal, 'passenger record')} this property placed, `
        + 'busiest first.'));
    }
    return;
  }
  if (tab === 'drivers') {
    host.append(tableFrom(d.drivers, [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
      { label: 'Avg approach', key: 'avg_deadhead_km', num: true,
        render: (r) => (r.avg_deadhead_km == null
          ? '<span class="ent-off" title="none of their bookings here records where they set off from">—</span>'
          : `${fmt(r.avg_deadhead_km, 2)} km`) },
    ], { sortable: true, sortId: 'pdrivers', defaultSort: { key: 'bookings', dir: 'desc' } }));
    host.append(note('Approach distance varies more by where a driver waits than by who they are — '
      + 'read a high average here as a positioning question first.'));
    return;
  }

  const pr = d.profile;
  host.append(kpiRow([
    { label: 'Bookings', value: fmt(pr.bookings) },
    { label: 'Revenue', value: money(pr.revenue), sub: `over ${fmt(pr.priced)} priced` },
    { label: 'Average fare', value: money(pr.avg_fare, 'AED', 2) },
    { label: 'Guests', value: fmt(pr.guests) },
    { label: 'Drivers', value: fmt(pr.drivers) },
    { label: 'Vehicles', value: fmt(pr.vehicles) },
    { label: 'First booking', value: dayStr(pr.first_at) },
    { label: 'Last booking', value: dayStr(pr.last_at) },
  ]));
  const g = grid(); host.append(g);
  add(g, 'Bookings and revenue per day', 'Two series, because a quiet day of expensive charters and a '
    + 'busy day of short hops are the same bar on a booking count.', (body) => {
    body.innerHTML = '';
    const a = el('div'); const b = el('div');
    body.append(el('p', 'cap', 'Bookings'), a);
    areaChart(a, d.daily, { x: 'day', y: 'bookings' });
    if (d.daily.some((x) => x.revenue != null)) {
      body.append(el('p', 'cap', 'Revenue'), b);
      areaChart(b, d.daily, { x: 'day', y: 'revenue', color: '--s3', valueFmt: (v) => money(v) });
    }
  });
  /* Counts AND money. "hourly 14 bookings" is 5% of the bookings and 11.7% of
     the revenue, and the donut charted only the first — so the booking type
     this property is actually worth money on was the smallest slice. Both
     `types[].revenue` and `payments[].revenue` came back and were dropped. */
  add(g, 'What they book', 'Bookings by type, with what each type is worth.', (body) => {
    body.innerHTML = '';
    const rows = d.types.map((t) => ({ label: String(t.label || '—').replace(/_/g, ' '), n: t.n, revenue: t.revenue }));
    donut(body, rows);
    if (rows.some((r) => r.revenue != null)) {
      const tot = rows.reduce((a, r) => a + (+r.revenue || 0), 0);
      body.append(tableFrom(rows, [
        { label: 'Type', key: 'label' },
        { label: 'Bookings', key: 'n', num: true },
        { label: 'Revenue', key: 'revenue', num: true,
          render: (r) => (r.revenue == null
            ? '<span class="ent-off" title="no booking of this type reports a fare">—</span>'
            : `${money(r.revenue)}<span class="dim"> · ${pct(tot ? (r.revenue / tot) * 100 : 0, 1)}</span>`) },
      ], { compact: true, sortable: true, sortId: 'ptypes', defaultSort: { key: 'revenue', dir: 'desc' } }));
    }
  });
  add(g, 'How they settle', 'The provider’s own label, and what it means for us.', (body) => {
    body.innerHTML = '';
    const rows = d.payments.map((p2) => ({
      label: `${p2.label} — ${p2.label_class || 'unclassified'}`, n: p2.n,
      revenue: p2.revenue, cls: p2.label_class }));
    hbars(body, rows, { signed: false });
    const owed = rows.filter((r) => ['on_account', 'salary'].includes(r.cls));
    if (owed.length) {
      /* Money this property owes, on the property's own page. It was in the
         payload and the only place it surfaced was #settlement/receivables,
         where this hotel is spread across eight rows. */
      const amount = owed.reduce((a, r) => a + (+r.revenue || 0), 0);
      const line = el('p', 'cap');
      line.innerHTML = `${countOf(owed.reduce((a, r) => a + r.n, 0), 'booking')} settled AFTER the ride`
        + (amount ? `, worth ${esc(money(amount))}` : '')
        + ` — <a class="lnk" href="${href('settlement', 'receivables')}">what is outstanding across every `
        + 'counterparty</a>.';
      body.append(line);
    }
  });
  add(g, 'When they travel', null, (body) => {
    body.innerHTML = '';
    donut(body, d.dayparts.map((x) => ({ label: x.label, n: x.n })));
  });
}
