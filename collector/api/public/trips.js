/* Every trip the fleet took, as a list.
   ─────────────────────────────────────────────────────────────────────────
   The record was always there and was never browsable. A trip could be
   reached only through something else — a driver's page, a vehicle's page, a
   single day — or downloaded as a CSV nobody opens to answer a question. An
   operator asking "what happened on that job" had nowhere to look.

   So: one row per booking, newest first, searchable by the three things a
   person actually remembers — a plate, a name, a place — and carrying the
   channel on the row rather than leaving it to be inferred from a filter chip
   somewhere above.

   The fare column is mostly empty and that is the provider, not a gap: Uber's
   trip export has no price in it. The page says so once, under the table,
   rather than leaving twelve thousand dashes to be interpreted. */
import { el, esc, panel, loading, tableFrom, kpiRow, sourceLabel, tripTime, money, pct, countOf, plural,
  tierLabel, contract, glance, secHead, absenceBand, pageFoot } from './ui.js';
import { fmt, empty, gapBars, hbars } from './charts.js';
import { q, href, state, windowLabel } from './data.js';

const PAGE = 100;

/* An address is long and the useful half is the community, which is also the
   half every other page in this product groups by. The full text stays in the
   title so nothing is lost. */
const area = (addr) => {
  const s = String(addr || '');
  const part = s.split(' - ')[1];
  return (part || s).trim() || '—';
};

export async function renderTrips(root) {
  root.innerHTML = '';
  loading(root);

  let offset = 0, term = '', kind = 'bookings', outcome = '';
  const bar = el('div', 'toolbar');
  const host = el('div');
  const foot = el('div');

  /* Empty values are dropped by data.js's clean(), so they are passed as ''
     rather than as `|| undefined` — which URLSearchParams stringifies into the
     four-letter word "undefined" and a route reads as a real filter. */
  const fetchPage = () => q('/api/trips/list', {
    limit: PAGE, offset, q: term,
    kind: kind === 'bookings' ? '' : kind,
    outcome,
  });

  /* Under the page contract (plan §4 trips): 00 from /api/kpis over the
     window, the bookings table directly under it (operators come here to
     find a job — the plan's deliberate departure from "hero chart at 01"),
     then the price-status, daily, cancel-rate and settlement charts, and a
     † band. The search, the selects, the paging and the columns are the old
     page's; Tier, Payment and a link to the booking page are added. */
  const ak = contract();
  const extra = ak ? Promise.all([
    q('/api/kpis').catch(() => null),
    q('/api/trips/daily').catch(() => null),
    q('/api/mix', { by: 'payment' }).catch(() => null),
  ]) : null;
  let d = await fetchPage();
  const [K, daily, pay] = ak ? await extra : [];
  const first = d;
  root.innerHTML = '';
  if (ak) tripsGlance(root, K, first);

  /* The count comes first. A hundred rows is a long scroll and a reader who
     reaches the bottom to learn there are 12,000 has already lost the number
     they came for. */
  const tiles = el('div');
  root.append(tiles);

  const KIND_SUB = {
    bookings: 'bookings only — the telematics journeys are the same cars again',
    telematics: 'telematics journeys, which are not bookings',
    all: 'bookings and telematics journeys together',
  };
  const KIND_TITLE = { bookings: 'Bookings', telematics: 'Telematics journeys', all: 'Bookings and journeys' };

  const head = panel('Bookings',
    'Newest first. Search a plate, a driver or a place.', ak ? 'trips-list' : undefined);
  root.append(head.panel);
  head.body.append(bar, host, foot);

  /* Search, kind and outcome are controls rather than links: this is a list
     somebody scans, not an address they send. The window and channel chips
     above the page still apply, and the count says so. */
  const box = el('input');
  box.type = 'search';
  box.placeholder = 'Plate, driver, pickup or drop-off';
  box.className = 'inp';
  box.value = term;
  let timer = null;
  box.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { term = box.value.trim(); offset = 0; d = await fetchPage(); draw(); }, 260);
  };

  const sel = (label, opts, cur, onPick) => {
    const s = el('select');
    s.className = 'inp';
    s.title = label;
    for (const [v, t] of opts) {
      const o = new Option(t, v);
      if (String(v) === String(cur)) o.selected = true;
      s.append(o);
    }
    s.onchange = async () => { onPick(s.value); offset = 0; d = await fetchPage(); draw(); };
    return s;
  };

  bar.append(box,
    sel('What', [['bookings', 'Bookings'], ['telematics', 'Telematics journeys'], ['all', 'Both']],
      kind, (v) => { kind = v; }),
    sel('Outcome', [['', 'Any outcome'], ['completed', 'Completed'], ['not_completed', 'Not completed']],
      outcome, (v) => { outcome = v; }));

  function draw() {
    host.innerHTML = ''; foot.innerHTML = '';
    head.panel.querySelector('h3').textContent = KIND_TITLE[kind] || 'Trips';
    tiles.innerHTML = '';
    if (ak) {
      /* The window's figures are 00's; what the search and the page hold is
         said here, beside the table they describe. */
      tiles.append(el('p', 'cap trips-count', esc(`${term ? 'Matching this search' : 'In this window'}: ${fmt(d.total)} — `
        + `${KIND_SUB[kind]} · on this page ${d.total > d.shown ? `rows ${fmt(d.offset + 1)}–${fmt(d.offset + d.shown)}` : 'all of them'}`
        + ` · ${fmt(d.priced)} carrying a fare`)));
    } else tiles.append(kpiRow([
      { label: term ? 'Matching this search' : 'Trips in this window', value: fmt(d.total),
        sub: KIND_SUB[kind] },
      { label: 'On this page', value: fmt(d.shown),
        sub: d.total > d.shown ? `rows ${fmt(d.offset + 1)}–${fmt(d.offset + d.shown)}` : 'all of them' },
      /* `priced` COUNTS THE WINDOW NOW, AND THIS CAPTION SAID THE PAGE.
         ─────────────────────────────────────────────────────────────────
         The route used to compute it over the LIMIT/OFFSET page beside a
         `total` computed over the window; it now counts both in one query, so
         the figure changed under a caption that did not. Caught on the
         production mirror rendering "5,156" above "of the 100 rows on this
         page" — a figure and a caption describing different populations,
         which is the defect this product has a whole test file about. */
      { label: 'Carrying a fare', value: fmt(d.priced),
        sub: d.total ? `of the ${fmt(d.total)} in this window` : 'nothing to price' },
    ]));
    if (ak && tiles.parentNode !== head.body) head.body.insertBefore(tiles, bar);
    if (!d.rows.length) {
      empty(host, term ? 'Nothing matches that' : 'No trip in this window');
      return;
    }
    host.append(tableFrom(d.rows, [
      /* tripTime, not a local formatter: every trips table in this product
         opens the vehicle's replay of that day from the timestamp, and a list
         of every trip is the last place that door should be missing. */
      { label: 'When', key: 'requested_at', render: (r) => tripTime(r.plate, r.requested_at) },
      /* The channel ON the row. Every other list in this product leaves it to
         a filter chip, and a mixed list then looks like one channel's. */
      { label: 'Channel', key: 'platform',
        render: (r) => `${esc(sourceLabel(r.platform))}`
          + `<span class="dim"> · ${esc(r.fleet_id || '—')}</span>` },
      { label: 'Driver', key: 'driver_name',
        render: (r) => (r.driver_ext_id
          ? `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>`
          : esc(r.driver_name || '—')) },
      { label: 'Vehicle', key: 'plate',
        render: (r) => (r.plate ? `<a class="lnk" href="${href('vehicle', r.plate)}">${esc(r.plate)}</a>` : '—') },
      { label: 'From', key: 'pickup_addr',
        render: (r) => `<span title="${esc(r.pickup_addr || '')}">${esc(area(r.pickup_addr))}</span>` },
      { label: 'To', key: 'dropoff_addr',
        render: (r) => `<span title="${esc(r.dropoff_addr || '')}">${esc(area(r.dropoff_addr))}</span>` },
      { label: 'Km', key: 'distance_km', num: true,
        render: (r) => (r.distance_km == null ? '—' : fmt(Math.round(+r.distance_km * 10) / 10)) },
      { label: 'Outcome', key: 'outcome',
        /* Text under the contract: a green/red fill on an outcome is a tone
           on a level; not-completed carries a ▼ in the negative token. */
        render: (r) => (ak
          ? (r.outcome === 'not_completed'
            ? `<span class="dlt dlt-negative"><span class="dlt-g" aria-hidden="true">▼</span>${esc(r.status || r.outcome)}</span>`
            : esc(r.status || r.outcome || '—'))
          : `<span class="tag ${r.outcome === 'completed' ? 'ok' : r.outcome === 'not_completed' ? 'bad' : 'dim'}">`
          + `${esc(r.status || r.outcome || '—')}</span>`) },
      { label: 'Fare', key: 'price', num: true,
        absent: 'no booking in this window reports a fare',
        render: (r) => (r.has_fare ? money(r.price) : '<span class="dim">—</span>') },
      ...(ak ? [
        { label: 'Tier', key: 'product', absent: 'no row on this page names a tier',
          render: (r) => (r.product ? esc(tierLabel(r.product)) : '<span class="dim">—</span>') },
        { label: 'Payment', key: 'payment_type', absent: 'no row on this page names how it was paid',
          render: (r) => (r.payment_type ? esc(String(r.payment_type).replace(/_/g, ' ')) : '<span class="dim">—</span>') },
        /* No #trips row could open #trip until now (plan §4 trips). */
        { label: 'Booking', key: 'external_id',
          render: (r) => (r.external_id && r.is_booking !== false
            ? `<a class="lnk" href="${href('trip', r.platform, r.external_id)}">open →</a>` : '<span class="dim">—</span>') },
      ] : []),
    ], { compact: true }));

    /* Paging, stated in rows rather than page numbers: a reader wants to know
       how much of the window they are looking at, not which page they are on. */
    const from = d.offset + 1, to = d.offset + d.shown;
    const nav = el('div', 'btnrow');
    nav.style.marginTop = '10px';
    const back = el('button', 'btn sec', 'Newer');
    back.disabled = d.offset === 0;
    back.onclick = async () => { offset = Math.max(0, offset - PAGE); d = await fetchPage(); draw(); };
    const fwd = el('button', 'btn sec', 'Older');
    fwd.disabled = !d.truncated;
    fwd.onclick = async () => { offset += PAGE; d = await fetchPage(); draw(); };
    nav.append(back, fwd, el('span', 'note',
      `${fmt(from)}–${fmt(to)} of ${fmt(d.total)}`));
    foot.append(nav);

    /* THE NUMBER, NOT THE REASSURANCE.
       ─────────────────────────────────────────────────────────────────────
       The note below used to tell a reader that a cancelled ride with no fare
       "charged nothing and never will". Measured on production 2026-09-08,
       that sentence was served over 8 rides in the trailing thirty days and 27
       in May 2026 whose stored payments blob shows the provider billed AED
       15.00 to AED 90.00. The fare of a cancellation fee is not published in
       the fare column — it arrives on a row described "adjust", which the
       walk read as no fare at all and wrote over the price as null.

       The collector now recovers it (src/sources/uber.js deriveFare) and this
       count should fall to zero as each week is re-walked. Until it does the
       count is on the screen, because a reader cannot audit a reassurance. */
    if (d.unpriced_but_charged) {
      foot.append(el('p', 'cap warn',
        `${fmt(d.unpriced_but_charged)} cancelled booking`
        + `${d.unpriced_but_charged === 1 ? '' : 's'} in this window `
        + `${d.unpriced_but_charged === 1 ? 'shows' : 'show'} no fare, and the platform’s own `
        + 'payments record says money was charged. Their fare has not been recovered yet — the '
        + 'week is re-walked nightly for thirty days and weekly for the year.'));
    }
    if (d.derived_fares) {
      foot.append(el('p', 'cap',
        `${fmt(d.derived_fares)} fare${d.derived_fares === 1 ? '' : 's'} here `
        + `${d.derived_fares === 1 ? 'was' : 'were'} recovered from the payments breakdown rather `
        + 'than read off a fare column — the platform does not publish one on a cancellation fee.'));
    }
    if (d.note) foot.append(el('p', 'cap', d.note));
  }

  draw();
  if (ak) tripsCharts(root, first, K, daily, pay);

  /* The CSV that already existed, linked from the page that made somebody
     want it. Trip grain, the same window and channel filters as the screen. */
  const dl = el('p', 'cap');
  const qs = new URLSearchParams({ grain: 'trip', from: d.window.from, to: d.window.to });
  if (state.platform) qs.set('platform', state.platform);
  if (state.fleet) qs.set('fleet', state.fleet);
  dl.innerHTML = `<a class="lnk" href="/api/export/trips.csv?${qs}">Download every trip in this `
    + 'window as CSV</a> — the same rows, at trip grain, with the full addresses.';
  root.append(dl);
  if (ak) pageFoot({ colophon: [windowLabel(), `${fmt(first.total)} bookings`] }, root);
}

/* ── #trips under the page contract ────────────────────────────────────────
   00: Carrying a fare, the hero (its share and the unpriced count, the list's
   own window count) · bookings · completed % · cancelled, by rider and by
   driver · drivers and cars · the mean fare over priced bookings · how long a
   ride took, ABSENT (duration_s is null on every row, and request→end is not
   ride time). After the table: whether a booking carries a price · every
   booking a day at a time (today hatched) · how much of a day gets cancelled
   · how the fare settles · †.
   NOT BUILT: the 3px channel marker in the row gutter (a row style tableFrom
   does not take; the Channel text says it). */
function tripsGlance(root, K, d) {
  const band = el('section', 'cband');
  const tiles = el('div');
  band.append(secHead('00', 'At a glance', windowLabel()), tiles);
  root.append(band);
  const unpriced = (d.total || 0) - (d.priced || 0);
  const failed = 'the window\u2019s figures (/api/kpis) did not load';
  glance(tiles, [
    { label: 'Carrying a fare', value: fmt(d.priced), hero: true,
      sub: d.total ? `${pct((d.priced / d.total) * 100, 1)} of the ${fmt(d.total)} bookings in this window · ${fmt(unpriced)} carry none` : 'nothing to price' },
    K ? { label: 'Bookings', value: fmt(K.trips), sub: 'every channel, in this window' } : { label: 'Bookings', na: failed },
    K && K.completion_pct != null ? { label: 'Completed', value: pct(+K.completion_pct, 1), sub: `${fmt(K.completed_trips)} bookings` }
      : { label: 'Completed', na: K ? 'no booking in this window reports an outcome' : failed },
    K ? { label: 'Cancelled', value: fmt(K.cancelled_trips),
      sub: `${fmt(K.cancelled_by_rider)} by the rider, ${fmt(K.cancelled_by_driver)} by the driver`
        + (+K.cancelled_unsaid ? `, ${fmt(K.cancelled_unsaid)} not saying who` : '') } : { label: 'Cancelled', na: failed },
    K ? { label: 'Drivers and cars', value: `${fmt(K.drivers)} · ${fmt(K.vehicles)}`, sub: 'drivers and cars with a booking in this window' }
      : { label: 'Drivers and cars', na: failed },
    K && K.avg_fare != null ? { label: 'Mean fare', value: money(+K.avg_fare), sub: `over the ${fmt(K.priced_trips)} bookings that carry one` }
      : { label: 'Mean fare', na: K ? 'no booking in this window carries a fare' : failed },
    { label: 'How long a ride took', na: 'no channel sends a ride\u2019s duration, and request to end is not ride time' },
  ]);
}
function tripsCharts(root, d, K, daily, pay) {
  const g1 = el('div', 'grid g2'); root.append(g1);
  const p2 = panel('Whether the booking carries a price', 'Over the window\u2019s bookings, before any search.', 'trips-price');
  const p5 = panel('How the fare settles', 'Bookings per payment type, with what the priced ones earned.', 'trips-settle');
  g1.append(p2.panel, p5.panel);
  const status = [
    ['Carries a fare', d.priced],
    ['Cancelled, never charged', d.unpriced_cancelled],
    ['Completed, fare not filed yet', d.unpriced_completed],
    ['Fare recovered from earnings', d.derived_fares],
    ['Charged, but unpriced', d.unpriced_but_charged],
  ].filter(([, n]) => n != null);
  if (!status.length) empty(p2.body, 'The list answer carries no price counts.');
  else hbars(p2.body, status.map(([label, n]) => ({ label, n: +n })), { signed: false, color: '--ink',
    colorFor: (x) => (x.label === 'Carries a fare' ? '--ink' : '--grey') });
  p2.body.append(el('p', 'cap', esc('Recovered fares are inside "carries a fare"; the other four are apart. A cancellation nobody was charged for is not a missing figure.')));
  const P = Array.isArray(pay) ? pay : [];
  if (!P.length) empty(p5.body, pay ? 'No booking in this window records how it was paid.' : 'The payment mix did not load.');
  else {
    hbars(p5.body, [...P].sort((a, b) => (+b.n || 0) - (+a.n || 0)).map((r) => ({
      label: `${String(r.label || 'not recorded').replace(/_/g, ' ')}${+r.priced_n ? ` · ${money(+r.revenue || 0)} over ${fmt(r.priced_n)} priced` : ' · no fare reported'}`,
      n: +r.n || 0 })), { signed: false, color: '--mk-fill' });
  }

  const g2 = el('div', 'grid g2'); root.append(g2);
  const p3 = panel('Every booking, a day at a time', 'Today is still being collected and is drawn so.', 'trips-daily');
  const p4 = panel('How much of a day gets cancelled', 'Cancelled over bookings, per day.', 'trips-cancel');
  g2.append(p3.panel, p4.panel);
  const D = Array.isArray(daily) ? daily : [];
  if (!D.length) { empty(p3.body, 'The daily series did not load.'); empty(p4.body, 'The daily series did not load.'); }
  else {
    gapBars(p3.body, D, { x: 'd', y: 'trips', label: 'bookings', color: '--ink', gapKey: 'uncollected',
      gapLabel: 'nobody collected this day', valueFmt: (v) => fmt(v) });
    const rate = D.map((r) => ({ d: r.d, rate: +r.trips && r.cancelled != null ? (100 * +r.cancelled) / +r.trips : null,
      none: !+r.trips || r.cancelled == null || r.uncollected }));
    gapBars(p4.body, rate, { x: 'd', y: 'rate', label: 'cancelled', color: '--grey', gapKey: 'none',
      gapLabel: 'no outcome reported on this day', valueFmt: (v) => pct(v, 1) });
    if (K && K.cancel_pct != null) p4.body.append(el('p', 'cap', esc(`${pct(+K.cancel_pct, 1)} over the window.`)));
  }

  const absHost = el('div'); root.append(absHost);
  const dur = (d.rows || []).filter((r) => r.duration_s != null).length;
  absenceBand(absHost, [
    { label: 'How long a ride took', hl: true, fig: null, none: 'Not sent',
      why: `duration_s is empty on ${dur ? `${fmt((d.rows || []).length - dur)} of ${fmt((d.rows || []).length)}` : 'every one'} of the rows on this page, `
        + 'and the stamps from request to end are not ride time — they include the wait and the approach.' },
    { label: 'Charged, but unpriced', fig: fmt(d.unpriced_but_charged || 0),
      why: d.unpriced_but_charged ? 'Cancelled bookings the provider billed for whose fare has not been recovered yet — the week is re-walked nightly for thirty days.'
        : 'No cancelled booking in this window shows a charge without a fare.' },
  ]);
}
