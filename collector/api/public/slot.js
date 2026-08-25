/* One cell of the demand heatmap, as a page.
   ──────────────────────────────────────────────────────────────────────────
   A heatmap cell answers "is this hour busy". Nobody rosters on that. What you
   need before putting a car on the road at 03:00 on a Friday is: does the work
   actually turn up every Friday or only some of them, who covers it now, what
   breaks if that person is off, where does the work start, and does the hour
   pay for itself.

   All of it comes out of rows already in the table. The modal this replaces
   showed the driver ranking for the whole selected range, identically for
   every cell you clicked. */

import { empty, fmt, barChart, hbars, donut, areaChart } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, pill,
         dayStr, dateStr, hourStr, money, pct, sourceLabel, countOf, plural } from './ui.js';
import { q, href } from './data.js';

/* How many occurrences a rate needs before it is a rate.
   A slot seen once in the window has a "completion" of 0% or 100% and a
   "typical" of exactly what happened that day; #slot/0/4 at seven days drew a
   red 0.0% pill over one trip, and #slot/5/19 a 50.0% over two. Below this,
   the derived figures are withheld and the raw counts stand on their own. */
const MIN_OCCURRENCES = 3;
const MIN_TRIPS_FOR_RATE = 10;

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function renderSlot(root, dow, hour) {
  root.innerHTML = '';
  loading(root);
  const d = await q('/api/slot', { dow, hour });
  root.innerHTML = '';
  const h = d.headline;

  if (!h.trips) {
    /* Two different nothings. With bookings elsewhere in the window, an empty
       hour is a finding. With none anywhere, it is the absence of data and
       saying "you are not serving this demand" would be inventing one. */
    return empty(root, h.window_trips
      ? `No booking on any channel was requested at ${hourStr(hour)} on a ${DOW[dow]} `
        + `anywhere in this window, against ${fmt(h.window_trips)} bookings in the window overall. `
        + 'An empty slot is a real answer — it is either demand you are not serving '
        + 'or an hour the fleet has correctly decided not to staff.'
      : 'This window holds no bookings at all, on any day or hour, so there is nothing '
        + 'to say about this slot specifically. Widen the date range.');
  }

  /* A window holding one or two of this weekday cannot support a "typical" or
     a "covered". Widening the range is the fix and the tile says so. */
  const thin = (h.possible_days || 0) < MIN_OCCURRENCES;
  root.append(kpiRow([
    { label: 'Trips in this slot', value: fmt(h.trips),
      sub: `across ${fmt(h.days_seen)} of the ${countOf(h.possible_days, `${DOW[dow]}`)} in this window` },
    thin
      ? { label: 'Typical', value: '—',
        sub: `this window holds only ${countOf(h.possible_days, `${DOW[dow]}`)} — widen the range before `
          + 'reading an average off it' }
      : { label: 'Typical', value: h.trips_per_occurrence != null ? fmt(h.trips_per_occurrence, 1) : '—',
        sub: `per ${DOW[dow]}, counting the ones with nothing as zero` },
    thin
      ? { label: 'Covered', value: '—',
        sub: `${fmt(h.days_seen)} of ${fmt(h.possible_days)} — too few occurrences to be a rate` }
      : { label: 'Covered', value: h.coverage_pct != null ? pct(h.coverage_pct) : '—',
        sub: `of the ${fmt(h.possible_days)} ${DOW[dow]}s had any work in this hour`,
        tone: h.coverage_pct == null ? null : h.coverage_pct >= 80 ? 'good' : h.coverage_pct >= 40 ? 'warn' : 'critical' },
    { label: 'People covering it', value: fmt(h.drivers),
      sub: h.drivers <= 2 ? 'this hour depends on very few people' : `${countOf(h.vehicles, 'vehicle')}`,
      tone: h.drivers <= 2 ? 'critical' : h.drivers <= 4 ? 'warn' : null },
    /* Trip length is what turns a booking count into a car count, and the
       endpoint returned it. A slot of twenty 4-km hops and a slot of twenty
       40-km runs need different numbers of cars and read identically here. */
    { label: 'Average trip', value: h.avg_km != null ? `${fmt(h.avg_km, 1)} km` : '—',
      sub: h.avg_km != null
        ? 'how long a job in this hour runs — a booking count is not a car count without it'
        : 'no trip in this slot carries a usable distance' },
    /* Fares, named as such. An hour-of-week slot has no payout of its own —
       platform statements are weekly and spreading one to a single HOUR would
       be an estimate on an estimate — so this page states what it measured and
       leaves the combined figure to the pages that can honestly carry it. */
    { label: 'Fares', value: h.priced_n ? money(h.revenue) : '—',
      sub: h.priced_n
        ? `over the ${fmt(h.priced_n)} of ${fmt(h.trips)} trips that carry a fare`
        : 'no trip in this slot carries a fare — Uber’s export has no fare column' },
    { label: 'Per priced trip', value: h.revenue_per_priced_trip != null
      ? money(h.revenue_per_priced_trip, 'AED', 2)
      : (h.priced_n ? money(h.revenue / h.priced_n, 'AED', 2) : '—'),
      sub: h.priced_n
        ? `over the ${fmt(h.priced_n)} priced trips only — not over the ${fmt(h.trips)} in the slot`
        : 'nothing here carries a fare to average' },
  ]));

  if (h.priced_n && h.priced_n < h.trips) {
    root.append(note(`Only ${fmt(h.priced_n)} of ${fmt(h.trips)} trips in this slot carry a fare, so every money `
      + 'figure on this page describes those and no others. The Uber trip export has no fare column at all, '
      + 'so an hour dominated by Uber will look poor here whatever it actually earned.'));
  }

  const g = el('div', 'grid g2'); root.append(g);

  /* ── who covers it — the whole point of the page ───────────────────────── */
  const dp = panel('Who covers this hour',
    'Ranked by trips in this slot. A slot held up by one or two people is a rota risk, not a strength.');
  g.append(dp.panel);
  if (d.drivers.length) {
    dp.body.append(tableFrom(d.drivers, [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name || '(unnamed)') },
      { label: 'Trips', key: 'trips', num: true },
      { label: `${DOW[dow]}s worked`, key: 'days', num: true,
        render: (r) => `${r.days} of ${h.possible_days}` },
      { label: 'Platforms', key: 'platforms', render: (r) => esc(String(r.platforms || '').split(',')
        .map((x) => sourceLabel(x.trim())).join(', ')) },
      /* A completion rate over one or two trips is not a rate. It was toned
         red or green on any denominator at all, so a driver who took a single
         trip in this hour and completed it wore the same green pill as one who
         completed ninety. */
      { label: 'Completion', key: 'completion_pct', num: true,
        render: (r) => {
          if (r.completion_pct == null) return '<span class="ent-off" title="no platform of theirs reports an outcome">n/a</span>';
          return r.trips >= MIN_TRIPS_FOR_RATE
            ? `<span class="pill ${r.completion_pct >= 90 ? 'ok' : r.completion_pct >= 75 ? 'warn' : 'bad'}">${r.completion_pct}%</span>`
            : `<span class="dim" title="over only ${r.trips} trip(s) in this hour — too small a base to judge">${r.completion_pct}%</span>`;
        } },
      { label: 'Fares', key: 'revenue', num: true,
        absent: 'no booking in this hour carries a fare — Uber\'s export has no fare column, and '
          + 'at this hour of the week Uber is all of the work',
        render: (r) => (r.revenue ? money(r.revenue)
          : '<span class="ent-off" title="no trip of theirs in this hour carries a fare">—</span>') },
    ], { compact: true, sortable: true, sortId: 'slotdrv', defaultSort: { key: 'trips', dir: 'desc' },
      capped: d.drivers_total && d.drivers_total > d.drivers.length
        ? `all ${fmt(d.drivers_total)} people who work this hour` : null }));
    if ((d.drivers_total && d.drivers_total > d.drivers.length) || d.drivers.length >= 40) {
      dp.body.append(el('p', 'cap',
        `Showing the ${fmt(d.drivers.length)} busiest of ${fmt(d.drivers_total ?? h.drivers)} people who `
        + 'work this hour, ranked by trips in it.'));
    }
    if (d.drivers.some((r) => r.trips < MIN_TRIPS_FOR_RATE)) {
      dp.body.append(el('p', 'cap',
        `A completion rate is only toned above ${MIN_TRIPS_FOR_RATE} trips in this hour; below that it is `
        + 'shown grey, because one cancelled trip out of two is 50% and means nothing.'));
    }
    const top = d.drivers[0];
    const share = h.trips ? Math.round((top.trips / h.trips) * 100) : 0;
    if (share >= 40) dp.body.append(el('p', 'note err',
      `${esc(top.driver_name || 'One driver')} alone takes ${share}% of the work in this slot. `
      + 'If that person is unavailable this hour degrades immediately, and no other page in this dashboard would show it.'));
  } else empty(dp.body, 'No trip in this slot is attributed to a named driver');

  /* ── does it turn up every week? ───────────────────────────────────────── */
  const op = panel(`Every ${DOW[dow]} in the window`,
    'The average above is only meaningful if these are alike. A single spike and eleven quiet weeks is a different business.');
  g.append(op.panel);
  if (d.occurrences.length) {
    barChart(op.body, d.occurrences, { x: 'day', y: 'trips', label: 'trips',
      onClick: (r) => { location.hash = href('day', r.day); } });
    const ts = d.occurrences.map((r) => r.trips);
    const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
    const sd = Math.sqrt(ts.reduce((a, b) => a + (b - mean) ** 2, 0) / ts.length);
    const missing = h.possible_days - d.occurrences.length;
    /* "± 0" over one occurrence is not a spread, it is arithmetic on a single
       point — and "1 Sundays" is not a sentence. Both only appear where there
       is enough to say them about. */
    op.body.append(el('p', 'cap',
      `${countOf(d.occurrences.length, DOW[dow])} had work in this hour`
      + (missing > 0 ? `, and ${fmt(missing)} had none at all — those are not drawn, and they are not zero-height bars either` : '')
      + '. '
      + (ts.length >= MIN_OCCURRENCES
        ? `Spread on the days that did fire: ${fmt(mean, 1)} ± ${fmt(sd, 1)} trips.`
          + (mean > 0 && sd / mean > 0.6
            ? ' That is more variance than average, so treat the headline number as a range rather than a plan.' : '')
        : `With ${plural(ts.length, 'only one occurrence', `only ${fmt(ts.length)} occurrences`)} there is no `
          + 'spread to report — widen the range above before planning against this hour.')));
  } else empty(op.body, 'No occurrence recorded');

  const g2 = el('div', 'grid g3'); root.append(g2);

  /* ── which platform brings it ──────────────────────────────────────────── */
  const pp = panel('Which channel brings this hour', 'Share of the slot, not of the day');
  g2.append(pp.panel);
  if (d.platforms.length) {
    donut(pp.body, d.platforms.map((r) => ({ label: r.platform, n: r.trips })));
    pp.body.append(tableFrom(d.platforms, [
      { label: 'Platform', key: 'platform' },
      { label: 'Trips', key: 'trips', num: true },
      { label: 'Fares', key: 'revenue', num: true,
        render: (r) => (r.priced_n ? money(r.revenue) : '<span class="dim">no fare column</span>') },
    ], { compact: true }));
  } else empty(pp.body, 'No platform data');

  /* ── where does the work start ─────────────────────────────────────────── */
  const cp = panel('Where the work starts', 'Pickup area, as each channel’s address text describes it');
  g2.append(cp.panel);
  if (d.corridors.length) {
    hbars(cp.body, d.corridors.map((r) => ({ label: r.place, n: r.trips })), { seq: true, signed: false });
    /* How much of the slot these bars actually cover. The rows are split on a
       different delimiter from the one #corridors uses, so twelve bars can
       cover a quarter of the hour's trips with the largest reading
       "(no address)" — a panel that looks like a summary and is a sample. */
    const covered = d.corridors.reduce((a, r) => a + (+r.trips || 0), 0);
    const named = d.corridors.filter((r) => !/^\(no address\)$/i.test(r.place || ''))
      .reduce((a, r) => a + (+r.trips || 0), 0);
    cp.body.append(el('p', 'cap',
      `These cover ${fmt(covered)} of the ${fmt(h.trips)} trips in this slot`
      + (named < covered ? `, ${fmt(covered - named)} of them with no address at all` : '')
      + '. This is the rostering answer that a trip count is not: an hour whose work all starts in one '
      + 'place is staffed by putting a car there, not by putting more cars on. '
      + `<a class="lnk" href="${href('corridors')}">Full origin–destination view</a>, which parses the `
      + 'same addresses into the fleet-wide area taxonomy.'));
  } else empty(cp.body, 'No trip in this slot records where it was picked up from');

  /* ── the same hour across the week ─────────────────────────────────────── */
  const sp = panel(`${hourStr(hour)} across the week`, 'So "busy" has something to be busy against');
  g2.append(sp.panel);
  if (d.peers.length) {
    hbars(sp.body, d.peers.map((r) => ({ label: DOW[r.dow].slice(0, 3), n: r.trips, dow: r.dow })), {
      color: '--b400',
      onClick: (r) => { if (r.dow !== dow) location.hash = href('slot', String(r.dow), String(hour)); } });
    const mine = d.peers.find((r) => r.dow === dow);
    const others = d.peers.filter((r) => r.dow !== dow);
    if (mine && others.length) {
      const avg = others.reduce((a, r) => a + r.trips, 0) / others.length;
      const rel = avg > 0 ? Math.round(((mine.trips - avg) / avg) * 100) : null;
      sp.body.append(el('p', 'cap', rel == null ? ''
        : `${DOW[dow]} runs ${rel > 0 ? `${rel}% above` : `${Math.abs(rel)}% below`} the other weekdays at this hour.`));
    }
  } else empty(sp.body, 'No comparison available');

  /* ── how it settles, and how it ends ───────────────────────────────────── */
  const g3 = el('div', 'grid g2'); root.append(g3);
  const stp = panel('How this hour settles', 'Cash in a driver’s hand at 3am is a different operational fact from a card payment');
  g3.append(stp.panel);
  const settle = (d.settlement || []).filter((r) => r.trips);
  if (settle.length) {
    donut(stp.body, settle.map((r) => ({ label: r.settlement_class || 'unclassified', n: r.trips })));
    const cash = settle.find((r) => r.settlement_class === 'cash');
    if (cash) stp.body.append(el('p', 'cap',
      `${fmt(cash.trips)} of ${fmt(h.trips)} trips in this slot settle in cash`
      + (cash.revenue ? `, ${money(cash.revenue)} of it` : '')
      + `. <a href="${href('settlement', 'cash')}">Where that cash currently sits</a>.`));
  } else empty(stp.body, 'No settlement classification for this slot');

  const op2 = panel('How trips in this hour end', 'Normalised across platforms — Bolt says “finished”, Uber says “completed”');
  g3.append(op2.panel);
  if (d.outcome.length) {
    op2.body.append(tableFrom(d.outcome, [
      { label: 'Outcome', key: 'outcome', render: (r) => pill(r.outcome,
        r.outcome === 'completed' ? 'ok' : r.outcome === 'not_completed' ? 'bad' : null) },
      { label: 'Trips', key: 'trips', num: true },
      { label: 'Share', key: '_s', num: true,
        render: (r) => pct((r.trips / h.trips) * 100) },
    ], { compact: true }));
    if (h.completion_pct != null) op2.body.append(el('p', 'cap',
      `Completion in this slot is ${pct(h.completion_pct, 1)}, over the trips whose platform reports an outcome at all. `
      + 'Telematics journeys are excluded — “did this journey complete” is not a question about a GPS trace.'));
  } else empty(op2.body, 'No outcome reported for trips in this slot');
}
