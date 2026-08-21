/* One day, as an address.
   ──────────────────────────────────────────────────────────────────────────
   Clicking a bar on the demand chart used to open a modal titled "Trips on
   14 August" containing a driver leaderboard — not trips, and not linkable.
   For the one artefact somebody actually wants to send a colleague — "look at
   what happened on the 14th" — a modal is the wrong shape entirely.

   The first thing on the page is not a number. It is whether every source was
   collecting, because a quiet Tuesday and a Tuesday nobody fetched produce the
   same chart, and every figure below is computed over whatever landed. */

import { barChart, donut, hbars, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity,
  dayStr, dtStr, timeStr, money, pct } from './ui.js';
import { api, href, state } from './data.js';

const shift = (day, n) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export async function renderDay(root, day, onDetail) {
  root.innerHTML = '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    root.append(note('That is not a date. A day page is addressed as #day/YYYY-MM-DD.'));
    return null;
  }
  loading(root);
  let d;
  try { d = await api(`/api/day?day=${encodeURIComponent(day)}`); }
  catch (e) { root.innerHTML = ''; root.append(note(`Could not load: ${e.message}`)); return null; }
  root.innerHTML = '';
  onDetail?.(d);

  // Previous / next, so a day can be walked rather than searched for.
  const nav = el('div', 'daynav');
  nav.innerHTML = `<a href="${href('day', shift(day, -1))}">← ${esc(dayStr(shift(day, -1)))}</a>
    <b>${esc(new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined,
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}</b>
    <a href="${href('day', shift(day, 1))}">${esc(dayStr(shift(day, 1)))} →</a>`;
  root.append(nav);

  /* Before any number: was everything collecting? */
  if (d.collection.warning) {
    const w = el('div', 'note err'); w.textContent = d.collection.warning;
    root.append(w);
  }

  const h = d.headline;
  const vs = d.versus_neighbours;
  root.append(kpiRow([
    { label: 'Bookings', value: fmt(h.bookings),
      sub: vs.delta_pct == null ? null
        : `${vs.delta_pct > 0 ? '+' : ''}${pct(vs.delta_pct, 0)} on the fortnight median of ${fmt(vs.median_bookings)}`,
      tone: vs.delta_pct == null ? null : vs.delta_pct < -30 ? 'critical' : vs.delta_pct < -10 ? 'warn' : null },
    { label: 'Completed', value: fmt(h.completed),
      sub: h.completion_pct == null ? null : `${pct(h.completion_pct, 1)} of bookable`,
      tone: h.completion_pct != null && h.completion_pct < 85 ? 'warn' : null },
    { label: 'Revenue', value: money(h.revenue),
      sub: h.priced ? `over ${fmt(h.priced)} priced bookings` : 'no booking that day reports a fare' },
    { label: 'Drivers out', value: fmt(h.drivers) },
    { label: 'Vehicles used', value: fmt(h.vehicles) },
    { label: 'Telematics journeys', value: fmt(h.telematics),
      sub: `${fmt(h.telematics_km)} km — the same physical trips, seen by the trackers` },
    { label: 'First / last booking', value: h.first_at ? `${timeStr(h.first_at)} – ${timeStr(h.last_at)}` : '—' },
  ]));

  if (!h.bookings && !h.telematics) {
    root.append(note('Nothing at all is recorded for this day. If a source is listed above as silent, '
      + 'that is the reason; otherwise the fleet did not move.'));
  }

  const g = el('div', 'grid'); root.append(g);

  const add = (title, cap, render) => {
    const { panel: p, body } = panel(title, cap);
    g.append(p);
    try { render(body); } catch (e) { body.innerHTML = ''; body.append(note(String(e.message))); }
    return body;
  };

  add('Through the day', 'Bookings by Dubai-local hour, with the telematics journeys behind them.', (b) => {
    if (!d.hours.length) return empty(b, 'No trip carries an hour on this day');
    barChart(b, d.hours, { x: 'hour', y: 'bookings',
      valueFmt: (v) => `${fmt(v)} bookings`,
      onClick: (r) => { location.hash = href('demand', 'hour', String(r.hour)); } });
    const peak = d.hours.reduce((a, r) => (r.bookings > (a?.bookings ?? -1) ? r : a), null);
    const cancelled = d.hours.reduce((a, r) => a + r.cancelled, 0);
    b.append(el('p', 'cap', [
      peak ? `Busiest hour ${String(peak.hour).padStart(2, '0')}:00 with ${fmt(peak.bookings)} bookings.` : null,
      cancelled ? `${fmt(cancelled)} bookings did not complete.` : null,
    ].filter(Boolean).join(' ')));
  });

  add('Against the fortnight around it', 'The same day of the previous and next week, so this one has something to be read against.', (b) => {
    if (vs.series.length < 3) return empty(b, 'Not enough neighbouring days');
    barChart(b, vs.series, { x: 'day', y: 'bookings',
      // The day being read has to be findable among its neighbours; without
      // this the chart is fifteen identical bars and says nothing.
      colorFor: (r) => (r.day === day ? '--accent' : '--b300'),
      onClick: (r) => { location.hash = href('day', r.day); } });
    b.append(el('p', 'cap', vs.delta_pct == null
      ? 'Not enough neighbouring days to compare against.'
      : `This day is highlighted. It ran ${vs.delta_pct > 0 ? 'above' : 'below'} the median of the `
        + `fortnight around it by ${pct(Math.abs(vs.delta_pct), 1)}.`));
  });

  add('Which channel', null, (b) => {
    if (!d.platforms.length) return empty(b);
    donut(b, d.platforms.map((r) => ({ label: r.platform, n: r.n })), {
      onClick: (x) => { location.hash = href('platforms'); } });
  });

  if (d.settlement.length) {
    add('How the fares settled', 'Only the channels that report a payment route appear.', (b) => {
      hbars(b, d.settlement.map((r) => ({ label: r.settlement_class, n: r.n })), {
        onClick: () => { location.hash = href('settlement'); } });
    });
  }
  if (d.tiers.length) {
    add('Uber product tier', null, (b) => donut(b, d.tiers.map((r) => ({ label: r.tier, n: r.n }))));
  }
  if (d.alerts.length) {
    add('Harsh-driving events', 'From the telematics layer, on this day only.', (b) => {
      hbars(b, d.alerts.map((r) => ({ label: r.alert_type, n: r.n })), {
        onClick: () => { location.hash = href('safety'); } });
      b.append(el('p', 'cap', `${fmt(d.alerts.reduce((a, r) => a + r.n, 0))} events across `
        + `${fmt(new Set(d.alerts.flatMap((r) => r.on_plates || [])).size)} vehicles.`));
    });
  }
  if (d.corridors.length) {
    add('Where the work ran', 'Areas parsed from the address text each provider returns.', (b) => {
      hbars(b, d.corridors.slice(0, 8).map((r) => ({ label: `${r.from_area} → ${r.to_area}`, n: r.trips })), {
        onClick: () => { location.hash = href('corridors'); } });
    });
  }

  /* Unexplained occupancy on this day — the evidence, not a count. */
  if (d.segments.length) {
    const sp = panel('Unexplained occupancy',
      'A seat was occupied and the vehicle moved. Only `unauthorized` is an accusation; the rest are '
      + 'journeys the evidence cannot settle either way.');
    sp.body.append(tableFrom(d.segments, [
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'From', key: 'started_at', render: (r) => timeStr(r.started_at) },
      { label: 'To', key: 'ended_at', render: (r) => timeStr(r.ended_at) },
      { label: 'Minutes', key: 'duration_min', num: true },
      { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
      { label: 'Verdict', key: 'verdict',
        render: (r) => pill(r.verdict, r.verdict === 'unauthorized' ? 'err'
          : r.verdict === 'authorized' ? 'ok' : 'warn') },
      { label: 'Why', key: 'verdict_reason', render: (r) => esc(String(r.verdict_reason || '').slice(0, 120)) },
    ]));
    root.append(sp.panel);
  }

  const dp = panel('Who drove', 'Every driver with a booking on this day, across all channels.');
  dp.body.append(tableFrom(d.drivers, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Did not complete', key: 'cancelled', num: true },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).join(', ')) },
    { label: 'Vehicles', key: 'plates',
      render: (r) => (r.plates || []).slice(0, 3).map((p2) => entity('vehicle', p2, p2)).join(' ') },
    { label: 'On the road', key: 'first_trip',
      render: (r) => `${timeStr(r.first_trip)} – ${timeStr(r.last_trip)}` },
  ]));
  root.append(dp.panel);

  const vp = panel('What moved', 'Bookings and telematics journeys per vehicle. A vehicle with journeys and no bookings drove without a fare behind it.');
  vp.body.append(tableFrom(d.vehicles, [
    { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Bookings', key: 'bookings', num: true },
    { label: 'Telematics journeys', key: 'telematics', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Drivers', key: 'drivers', num: true },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
  ]));
  root.append(vp.panel);

  /* Context and coverage last: the reader has the day by now, and these say how
     much of it to believe. */
  const cp = panel('The day itself', 'Weather and calendar, and what each source collected.');
  const c = d.context || {};
  const bits = [
    c.temp_max != null ? `${fmt(c.temp_max)}°C high, ${fmt(c.temp_min)}°C low` : null,
    c.precipitation ? `${fmt(c.precipitation, 1)} mm of rain` : null,
    c.wind_max ? `wind to ${fmt(c.wind_max)} km/h` : null,
    c.is_ramadan ? 'Ramadan' : null,
    c.is_holiday ? `public holiday — ${c.holiday_name || 'unnamed'}` : null,
    c.hijri_date ? `${c.hijri_date}` : null,
  ].filter(Boolean);
  cp.body.append(el('p', 'cap', bits.length ? bits.join(' · ')
    : 'No weather or calendar context was collected for this day.'));
  cp.body.append(tableFrom(d.coverage, [
    { label: 'Source', key: 'source' },
    { label: 'Rows this day', key: 'rows', num: true },
    { label: 'Normally', key: 'median_rows', num: true, render: (r) => fmt(r.median_rows) },
    { label: 'Verdict', key: 'v', render: (r) => (!r.inside_span
      ? pill('no history here', '')
      : r.rows === 0 && Number(r.median_rows) > 0 ? pill('collected nothing', 'err')
        : Number(r.median_rows) > 0 && r.rows < Number(r.median_rows) * 0.3 ? pill('far below normal', 'warn')
          : pill('normal', 'ok')) },
  ]));
  root.append(cp.panel);
  return d;
}
