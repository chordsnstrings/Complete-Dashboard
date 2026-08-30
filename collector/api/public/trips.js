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
import { el, esc, panel, loading, tableFrom, kpiRow, sourceLabel, tripTime } from './ui.js';
import { fmt, empty } from './charts.js';
import { q, href, state } from './data.js';

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

  let d = await fetchPage();
  root.innerHTML = '';

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
    'Newest first. Search a plate, a driver or a place.');
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
    tiles.append(kpiRow([
      { label: term ? 'Matching this search' : 'Trips in this window', value: fmt(d.total),
        sub: KIND_SUB[kind] },
      { label: 'On this page', value: fmt(d.shown),
        sub: d.total > d.shown ? `rows ${fmt(d.offset + 1)}–${fmt(d.offset + d.shown)}` : 'all of them' },
      { label: 'Carrying a fare', value: fmt(d.priced),
        sub: d.shown ? `of the ${fmt(d.shown)} rows on this page` : 'nothing to price' },
    ]));
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
        render: (r) => `<span class="tag ${r.outcome === 'completed' ? 'ok' : r.outcome === 'not_completed' ? 'bad' : 'dim'}">`
          + `${esc(r.status || r.outcome || '—')}</span>` },
      { label: 'Fare', key: 'price', num: true,
        absent: 'no booking in this window reports a fare',
        render: (r) => (r.has_fare ? `AED ${fmt(r.price)}` : '<span class="dim">—</span>') },
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

    if (d.note) foot.append(el('p', 'cap', d.note));
  }

  draw();

  /* The CSV that already existed, linked from the page that made somebody
     want it. Trip grain, the same window and channel filters as the screen. */
  const dl = el('p', 'cap');
  const qs = new URLSearchParams({ grain: 'trip', from: d.window.from, to: d.window.to });
  if (state.platform) qs.set('platform', state.platform);
  if (state.fleet) qs.set('fleet', state.fleet);
  dl.innerHTML = `<a class="lnk" href="/api/export/trips.csv?${qs}">Download every trip in this `
    + 'window as CSV</a> — the same rows, at trip grain, with the full addresses.';
  root.append(dl);
}
