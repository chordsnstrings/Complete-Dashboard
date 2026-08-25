/* One day, as an address.
   ──────────────────────────────────────────────────────────────────────────
   Clicking a bar on the demand chart used to open a modal titled "Trips on
   14 August" containing a driver leaderboard — not trips, and not linkable.
   For the one artefact somebody actually wants to send a colleague — "look at
   what happened on the 14th" — a modal is the wrong shape entirely.

   The first thing on the page is not a number. It is whether every source was
   collecting, because a quiet Tuesday and a Tuesday nobody fetched produce the
   same chart, and every figure below is computed over whatever landed. */
import { TZ } from './tz.js';

import { barChart, donut, hbars, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity,
  dayStr, dtStr, timeStr, money, pct, custody } from './ui.js';
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
      { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ }))}</b>
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
    /* Both channels. This tile was the fares on the day's trips, and Uber
       prices nothing per trip — so a day the fleet ran nine hundred bookings
       showed the price of the handful of hotel ones. The payout half is a share
       of the weekly statements covering this day, which is an estimate, and the
       sub-line says so rather than letting an exact-looking number imply it was
       measured on the day. */
    { label: 'Money in', value: h.accounted ? money(h.accounted) : '—',
      sub: h.accounted
        ? `${money(h.accounted_fares || 0)} in fares · ${money(h.accounted_payouts || 0)} `
          + (h.payout_basis ? 'estimated from the weekly platform statements' : 'in payouts')
        : 'no fare and no payout statement reaches this day' },
    { label: 'Fares', value: money(h.revenue),
      sub: h.priced ? `over ${fmt(h.priced)} priced bookings` : 'no booking that day reports a fare' },
    { label: 'Drivers out', value: fmt(h.drivers) },
    { label: 'Vehicles used', value: fmt(h.vehicles) },
    { label: 'Telematics journeys', value: fmt(h.telematics),
      sub: `${fmt(h.telematics_km)} km — the same physical trips, seen by the trackers` },
    { label: 'First / last booking', value: h.first_at ? `${timeStr(h.first_at)} – ${timeStr(h.last_at)}` : '—' },
  ]));

  if (!h.bookings && !h.telematics) {
    /* Before the record began is not "the fleet did not move". A date earlier
       than anything collected has every coverage row outside its span, and the
       page told the reader the fleet stood still. */
    const outside = (d.coverage || []).length && (d.coverage || []).every((r) => !r.inside_span);
    root.append(note(outside
      ? 'This date is before anything was collected. No source has history reaching back here, so there '
        + 'is nothing to show and nothing to conclude — it is not a day the fleet stood still.'
      : 'Nothing at all is recorded for this day. If a source is listed below as silent, that is the '
        + 'reason; otherwise the fleet did not move.', outside ? 'warn' : null));
    if (outside) {
      const link = el('p', 'cap');
      const first = (d.coverage || []).map((r) => r.first_day).filter(Boolean).sort()[0];
      link.innerHTML = (first ? `The record starts on ${esc(dayStr(first))}. ` : '')
        + `<a class="lnk" href="${href('coverage')}">Which days each source actually collected</a>.`;
      root.append(link);
    }
  }

  const g = el('div', 'grid'); root.append(g);

  const add = (title, cap, render) => {
    const { panel: p, body } = panel(title, cap);
    g.append(p);
    try { render(body); } catch (e) { body.innerHTML = ''; body.append(note(String(e.message))); }
    return body;
  };

  /* The weekday of the day being read, so an hour bar can open the slot it
     belongs to. `day` is already a Dubai calendar date; anchoring it at noon
     UTC (16:00 in Dubai) puts the instant far enough from both midnights that
     the UTC weekday and the Dubai weekday cannot disagree. */
  const dowOf = new Date(`${day}T12:00:00Z`).getUTCDay();

  add('Through the day', 'Bookings by Dubai-local hour, with the telematics journeys behind them.', (b) => {
    if (!d.hours.length) return empty(b, 'No trip carries an hour on this day');
    /* `#demand/hour/14` is not a page. V.demand reads neither state.param nor
       state.sub, so clicking the 14:00 bar rendered the ordinary thirty-day
       Demand view with the day and the hour both discarded — the reader's
       click was silently thrown away. `#slot/<dow>/<hour>` is the real page,
       and it is the one the demand heatmap already opens. */
    barChart(b, d.hours, { x: 'hour', y: 'bookings',
      valueFmt: (v) => `${fmt(v)} bookings`,
      onClick: (r) => { location.hash = href('slot', String(dowOf), String(r.hour)); } });
    const peak = d.hours.reduce((a, r) => (r.bookings > (a?.bookings ?? -1) ? r : a), null);
    const cancelled = d.hours.reduce((a, r) => a + r.cancelled, 0);
    const cap = el('p', 'cap');
    cap.innerHTML = [
      peak ? `Busiest hour <a class="lnk" href="${href('slot', String(dowOf), String(peak.hour))}">`
        + `${String(peak.hour).padStart(2, '0')}:00</a> with ${fmt(peak.bookings)} bookings.` : null,
      cancelled ? `${fmt(cancelled)} bookings did not complete.` : null,
      'An hour opens as a rostering question — who covers it every week, not only on this day.',
    ].filter(Boolean).join(' ');
    b.append(cap);
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
      /* The plate alone is not something anyone can act on. This is the day's
         most serious claim and it used to name a car and no person, so the
         reader's next move was to open the vehicle page and work backwards to
         who had it. Custody is per day, so the name here is who held that car
         on THIS day — naming today's custodian against a flag from March
         accuses the wrong person. */
      { label: 'Driver that day', key: 'drivers',
        render: (r) => custody(r, { title: 'This driver’s other flagged segments',
          hrefFor: (dr) => href('segments', 'driver', dr.name) }) },
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

  /* The same events, against the person who was driving.
     A bar chart of "38 harsh brakes" tells an operations manager the shape of
     the day and nothing they can do about it tomorrow. Broken out per vehicle
     and attributed to whoever held that vehicle on this day, it is a list of
     conversations — which is what the page is for. */
  if ((d.alertsByVehicle || []).length) {
    const ap = panel('Harsh driving, by vehicle and driver',
      'Telematics events on this day, against whoever held the car that day.');
    ap.body.append(tableFrom(d.alertsByVehicle, [
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Driver that day', key: 'drivers', render: (r) => custody(r) },
      { label: 'Events', key: 'n', num: true },
      { label: 'Braking', key: 'harsh_brake', num: true },
      { label: 'Acceleration', key: 'harsh_accel', num: true },
      { label: 'Turns', key: 'sharp_turn', num: true },
      { label: 'Speeding', key: 'overspeed', num: true },
    ], { sortable: true, sortId: 'dayAlerts', defaultSort: { key: 'n', dir: 'desc' } }));
    root.append(ap.panel);
  }

  const dp = panel('Who drove', 'Every driver with a booking on this day, across all channels.');
  dp.body.append(tableFrom(d.drivers, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Did not complete', key: 'cancelled', num: true },
    { label: 'Fares', key: 'revenue', num: true, render: (r) => money(r.revenue) },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).join(', ')) },
    { label: 'Vehicles', key: 'plates',
      render: (r) => (r.plates || []).slice(0, 3).map((p2) => entity('vehicle', p2, p2)).join(' ') },
    { label: 'On the road', key: 'first_trip',
      render: (r) => `${timeStr(r.first_trip)} – ${timeStr(r.last_trip)}` },
  ], { sortable: true, sortId: 'dayDrivers', defaultSort: { key: 'trips', dir: 'desc' },
    capped: h.drivers > d.drivers.length ? `all ${fmt(h.drivers)} who drove` : null }));
  /* The list is capped; the headline counts are measured over the whole day.
     A table that shows 120 of 180 people and says nothing reads as the roster. */
  if (h.drivers > d.drivers.length) {
    dp.body.append(el('p', 'cap',
      `Showing the ${fmt(d.drivers.length)} busiest of ${fmt(h.drivers)} people who drove on this day.`));
  }
  root.append(dp.panel);

  const vp = panel('What moved', 'Bookings and telematics journeys per vehicle. A vehicle with journeys and no bookings drove without a fare behind it.');
  vp.body.append(tableFrom(d.vehicles, [
    { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Bookings', key: 'bookings', num: true },
    { label: 'Telematics journeys', key: 'telematics', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    /* Named, not counted. "This car did 1 journey and 0 bookings" is the row on
       this page most likely to start a conversation, and "drivers: 2" is not
       somebody you can ring. */
    { label: 'Driver that day', key: 'driver_refs', render: (r) => custody(r) },
    { label: 'Fares', key: 'revenue', num: true, render: (r) => money(r.revenue) },
  ], { sortable: true, sortId: 'dayVeh', defaultSort: { key: 'bookings', dir: 'desc' } }));
  if (h.vehicles > d.vehicles.length) {
    vp.body.append(el('p', 'cap',
      `Showing the ${fmt(d.vehicles.length)} busiest of ${fmt(h.vehicles)} vehicles that moved.`));
  }
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
