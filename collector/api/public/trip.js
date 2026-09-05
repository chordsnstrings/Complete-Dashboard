/* One booking, and everything the record knows about it.
   ──────────────────────────────────────────────────────────────────────────
   Every trip table in this product ended in a row nobody could open. That is
   nine columns of a row that has twenty-odd, and the ones it dropped are the
   ones somebody asks for when a trip looks wrong: where exactly it started,
   how many seats, which fleet booked it, and what the provider actually sent.

   The money is the reason this is a page rather than a wider table. Uber's
   export carries no fare at all and its money arrives weekly as a payout for a
   DAY; the hotel channel prices every booking. Both fleets run both. A fare
   column alone is blank for most of this fleet's work, and a payout printed
   beside a trip reads as what the trip earned — which on a nine-trip day is
   nine times what it was. So the two sit in one panel that says which is
   which, and neither is shown without the other's caveat. */
import { empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, pill, money, pct,
  dayStr, dtStr, timeStr, sourceLabel, tierLabel, countOf, plural, noneChosen,
  trackerState, trackerSpeed, UBER_FARE_WHY } from './ui.js';
import { api, href } from './data.js';

const OUTCOME_TONE = { completed: 'ok', not_completed: 'warn' };
const coord = (a, b) => (a == null || b == null ? null
  : `${Number(a).toFixed(5)}, ${Number(b).toFixed(5)}`);

export async function renderTrip(root, platform, id) {
  root.innerHTML = '';
  if (!platform || !id) {
    return noneChosen(root, 'trip', 'drivers', 'Every driver');
  }
  loading(root);
  let d;
  try {
    d = await api(`/api/trip?platform=${encodeURIComponent(platform)}&id=${encodeURIComponent(id)}`);
  } catch (e) {
    root.innerHTML = '';
    return empty(root, `No ${sourceLabel(platform)} trip with that id is on record. `
      + 'A trip is addressed by the provider’s own id, so a link survives a re-collection — '
      + 'but not a trip the provider has since withdrawn.');
  }
  root.innerHTML = '';
  const t = d.trip;
  const n = d.notes || {};

  /* The two ends of the journey, which is what a person means by "which
     trip". Addresses where the channel reports them, coordinates where it
     reports only those, and said plainly when it reports neither. */
  const head = el('div', 'note');
  head.innerHTML = `<b>${esc(t.pickup_addr || coord(t.pickup_lat, t.pickup_lng) || 'pickup not reported')}</b>`
    + ' → '
    + `<b>${esc(t.dropoff_addr || coord(t.dropoff_lat, t.dropoff_lng) || 'drop-off not reported')}</b>`
    + `<br>${esc(sourceLabel(t.platform))}`
    + (t.fleet_id ? ` · ${esc(sourceLabel(t.fleet_id))}` : '')
    + (t.local_day ? ` · <a href="${href('day', t.local_day)}">${esc(dayStr(t.local_day))}</a>` : '')
    + (t.driver_ext_id
      ? ` · driven by ${entity('driver', t.driver_ext_id, t.driver_name || 'this driver')}` : '')
    + (t.plate ? ` · ${entity('vehicle', t.plate, t.plate)}` : '');
  root.append(head);

  const mins = t.duration_s == null ? null : Math.round(Number(t.duration_s) / 60);
  root.append(kpiRow([
    { label: 'Status', value: t.status || '—', tone: OUTCOME_TONE[t.outcome] || null,
      sub: t.outcome && t.outcome !== t.status ? `normalised: ${t.outcome}` : 'as the channel words it' },
    { label: 'Distance', value: t.distance_km == null ? '—' : `${fmt(t.distance_km, 1)} km`,
      sub: t.distance_km == null ? 'this channel reported none' : 'as the channel reported it' },
    /* No source fills trip.duration_s on this fleet, so this is usually the
       gap between the two timestamps — and that is a different measurement,
       which the tile says rather than presenting one as the other. */
    { label: 'Time', value: mins != null ? `${fmt(mins)} min`
      : (t.requested_at && t.ended_at
        ? `${fmt(Math.round((new Date(t.ended_at) - new Date(t.requested_at)) / 60000))} min` : '—'),
      sub: mins != null ? 'reported by the channel'
        : (t.requested_at && t.ended_at ? 'requested to ended — the channel reports no duration'
          : 'no duration and no end time') },
    /* The sub is about SEATS. Written as "no tier reported" it contradicted
       the tier printed directly above it whenever a channel named the product
       and not the seat count — which the hotel channel always does. */
    { label: 'Product', value: t.product ? tierLabel(t.product) : '—',
      sub: t.seat_count ? countOf(t.seat_count, 'seat')
        : (t.product ? 'no seat count reported' : 'this channel names no tier') },
    { label: 'Fare', value: t.price != null ? money(t.price, t.currency || 'AED', 2) : '—',
      sub: t.price != null ? 'priced on this booking'
        : (n.platform_prices_trips ? 'no fare on this booking'
          : `${sourceLabel(t.platform)} prices no trip — see the day’s payout below`),
      tone: t.price == null && !n.platform_prices_trips ? 'warn' : null },
  ]));

  if (!t.is_booking) {
    root.append(note('This is a telematics journey, not a booking. The tracker recorded the vehicle '
      + 'moving; no channel sold it. It appears here because the same table holds both.', 'warn'));
  }

  /* ── the money ────────────────────────────────────────────────────────── */
  const tm = d.trip_money;
  const mp = panel('What this trip earned',
    tm
      ? 'The first rows are measurements of THIS booking, from the platform’s payments report. '
        + 'The rest are measurements of the whole DAY, and the two must not be added.'
      : `A fare is a measurement of THIS booking. A payout is a measurement of the whole DAY. `
        + `${UBER_FARE_WHY}, so on an Uber trip whose week is not collected the payout is the only `
        + 'money there is.');
  root.append(mp.panel);
  const pd = d.payout_day;
  const sd = d.statement_day;
  /* Cash comes from the STATEMENT, not the payout.
     ───────────────────────────────────────────────────────────────────────
     driver_payout_day is built from the performance feed, and Uber's reports
     no cash at all — so this row was a dash for a fleet whose drivers collect
     thousands of dirhams a week. The earnings components carry it, and
     api/trip_routes.js now reads the resolved day beside the payout. The
     payout figure is left alone: it is what reached the bank, and that is a
     different question from what the day was made of. */
  const cash = sd?.cash != null ? Number(sd.cash) : null;
  mp.body.append(tableFrom([
    { what: 'Fare on this booking', v: t.price != null ? money(t.price, t.currency || 'AED', 2) : null,
      basis: t.price != null
        ? (tm ? 'the gross the rider was charged, from the payments report'
          : 'the channel priced this trip')
        : (n.platform_prices_trips ? 'this channel prices trips, and priced none for this one'
          : `${sourceLabel(t.platform)} reports no fare on any trip`) },
    /* The booking's OWN breakdown, where the provider files one. This panel
       used to jump from the fare straight to the day, so a reader asking what
       a single ride made was answered with a figure for twelve of them — while
       the commission, the net and the cash for this exact ride sat unread in
       the row. Only rendered where trip_money exists; a channel that reports a
       price and no breakdown shows the day rows alone, as before. */
    ...(tm ? [
      { what: 'What the platform kept on this booking',
        v: tm.service_fee == null ? null : money(Math.abs(tm.service_fee), t.currency || 'AED', 2),
        basis: tm.commission_pct != null
          ? `its commission on this ride — ${pct(tm.commission_pct, 2)} of the fare above`
          : 'its commission on this ride' },
      { what: 'Earned on this booking',
        v: tm.earnings == null ? null : money(tm.earnings, t.currency || 'AED', 2),
        basis: 'the fare less the commission and the tax on it, plus any tip — '
          + 'this ride’s share of what reaches the fleet' },
      { what: 'Cash collected on this booking',
        v: tm.cash_collected == null ? null : money(Math.abs(tm.cash_collected), t.currency || 'AED', 2),
        basis: !tm.cash_collected
          ? 'the rider paid in the app, so the driver held nothing'
          : 'handed to the driver, so the platform keeps it back from the payout' },
      ...(tm.tip ? [{ what: 'Tip on this booking',
        v: money(tm.tip, t.currency || 'AED', 2),
        basis: 'on top of the fare, and already inside the earnings above' }] : []),
      ...(tm.adjustment ? [{ what: 'Adjusted afterwards',
        v: money(tm.adjustment, t.currency || 'AED', 2),
        basis: 'a correction filed against this ride after it ran, and not part of its fare' }] : []),
    ] : []),
    { what: 'Paid to the driver that day', v: pd ? money(pd.earnings, 'AED', 2) : null,
      basis: pd
        ? `over ${countOf(pd.trips == null ? 0 : Math.round(Number(pd.trips)), 'trip')} that day`
          + `, from a ${countOf(Number(pd.period_days) || 1, 'day')} payout period`
          + ` (${dayStr(pd.period_start)} → ${dayStr(pd.period_end)})`
        : 'no payout statement covers this day' },
    /* The day, as the channel itself breaks it down. Each row is null rather
       than zero where the statement does not reach the day, because a driver
       who was not paid and a day nobody reported on look identical at 0. */
    { what: 'Net fare that day', v: sd?.net != null ? money(sd.net, 'AED', 2) : null,
      basis: sd ? 'what the channel says the day’s trips earned, after its commission'
        : 'no statement covers this day' },
    { what: 'Tips that day', v: sd?.tips != null ? money(sd.tips, 'AED', 2) : null,
      basis: sd ? (Number(sd.tips) ? 'riders’ tips, on top of the fares'
        : 'no rider tipped this driver that day') : 'no statement covers this day' },
    { what: 'Salik reimbursed that day', v: sd?.salik != null ? money(sd.salik, 'AED', 2) : null,
      basis: sd ? (Number(sd.salik) ? 'tolls the channel paid back'
        : 'no toll was reimbursed that day') : 'no statement covers this day' },
    /* The basis has to describe what is in the cell, not what would be there.
       Written unconditionally it said "part of the figure above" beside an
       em dash, which describes a number that is not on the page. */
    { what: 'Cash the driver held that day', v: cash != null ? money(cash, 'AED', 2) : null,
      basis: !sd ? 'no statement covers this day'
        : (cash === null ? 'the statement for this day reports no cash collected'
          : cash === 0 ? 'every fare that day was paid in the app'
            : 'already in their hand, so the channel keeps it back from the payout') },
  ], [
    { label: 'Figure', key: 'what' },
    { label: 'Amount', key: 'v', num: true, render: (r) => (r.v == null
      ? '<span class="ent-off">—</span>' : r.v) },
    { label: 'What it measures', key: 'basis' },
  ], { compact: true }));
  /* The identity, checked on the page rather than asserted in a caption.
     ───────────────────────────────────────────────────────────────────────
     #reconcile proves `bank ≈ net + tips + salik − cash` month by month, to
     0.7% on July 2026. With both sides of it now on this panel a reader can
     add the four rows up and compare — so the page does the addition and says
     how close it came, which is the difference between a table of numbers and
     a table that can be checked.

     Only when every term is present: a sum with a missing term is not a
     smaller gap, it is a different equation, and printing it would report
     absent data as a discrepancy. */
  if (pd && sd && pd.earnings != null
      && sd.net != null && sd.tips != null && sd.salik != null && sd.cash != null) {
    const expect = Number(sd.net) + Number(sd.tips) + Number(sd.salik) - Number(sd.cash);
    const bank = Number(pd.earnings);
    const gap = bank - expect;
    const pctOff = expect ? Math.abs(gap / expect) * 100 : null;
    /* Stated, not flagged. On a SINGLE day these two are on different grains
       by construction: the payout is measured for the day, while the statement
       figures come from whatever period covered it — usually a week, divided
       evenly across its seven days. So a per-day gap is the normal state and
       colouring it a warning would cry wolf on every trip in the fleet. The
       arithmetic is still worth printing, because it is what the reader would
       otherwise do by hand and get wrong. */
    mp.body.append(note(`The four figures above are the payout's own parts: `
      + `${money(sd.net, 'AED', 2)} + ${money(sd.tips, 'AED', 2)} tips `
      + `+ ${money(sd.salik, 'AED', 2)} Salik − ${money(sd.cash, 'AED', 2)} cash `
      + `= ${money(expect, 'AED', 2)}, against ${money(bank, 'AED', 2)} paid`
      + (Math.abs(gap) < 0.01 ? ' — they agree exactly.'
        : `, a gap of ${money(Math.abs(gap), 'AED', 2)}`
          + (pctOff == null ? '.' : ` (${pctOff.toFixed(1)}%).`)
          + ' Uber states the payout per day and the statement per period, so on'
          + ' one day these are a measurement against a week’s average spread'
          + ' across it. #reconcile is where the two are compared at a grain'
          + ' where they should agree.')));
  }

  if (pd && Number(pd.period_days) > 1) {
    mp.body.append(note(`The payout above covers ${countOf(Number(pd.period_days), 'day')} and has been `
      + 'divided evenly across them. It is the finest measurement Uber served for this period — a day '
      + 'collected day-by-day would show what that day actually earned.', 'warn'));
  }

  /* ── the driver's day ─────────────────────────────────────────────────── */
  if (d.same_day?.length) {
    const dp = panel(`The rest of that day — ${countOf(d.same_day.length, 'booking')}`,
      'Every booking this driver took on this Dubai day, across every channel. This one is marked.');
    root.append(dp.panel);
    dp.body.append(tableFrom(d.same_day.map((x) => ({
      ...x, _this: x.platform === t.platform && x.external_id === t.external_id,
    })), [
      { label: '', key: '_this', render: (r) => (r._this ? pill('this trip', 'ok') : '') },
      { label: 'Time', key: 'requested_at', render: (r) => timeStr(r.requested_at) },
      { label: 'Channel', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
      { label: 'Product', key: 'product', render: (r) => (r.product ? tierLabel(r.product) : '—') },
      { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', OUTCOME_TONE[r.outcome] || null) },
      { label: 'Fare', key: 'price', num: true,
        absent: `no booking in this day carries a fare — most of this fleet’s work is Uber, and `
          + `${UBER_FARE_WHY}`,
        render: (r) => (r.price != null ? money(r.price, r.currency || 'AED', 2)
          : '<span class="ent-off">—</span>') },
    ], { compact: true,
      onRow: (r) => { location.hash = href('trip', r.platform, r.external_id); } }));
  }

  /* ── what the trackers saw ────────────────────────────────────────────── */
  const tp = panel(`What the trackers saw — ${countOf(d.telemetry?.length || 0, 'fix', 'fixes')}`,
    'Every position reported for this vehicle while the booking was running, ten minutes either side. '
    + 'A booking with no fixes behind it is a booking the trackers did not see.');
  root.append(tp.panel);
  if (d.telemetry?.length) {
    tp.body.append(tableFrom(d.telemetry, [
      { label: 'At', key: 'captured_at', render: (r) => timeStr(r.captured_at) },
      trackerState, trackerSpeed,
      { label: 'Seat', key: 'seat_occupied',
        absent: 'no tracker on this vehicle reports a seat sensor',
        render: (r) => (r.seat_occupied == null ? '—' : pill(r.seat_occupied ? 'occupied' : 'empty',
          r.seat_occupied ? 'ok' : null)) },
      { label: 'Ignition', key: 'ignition',
        render: (r) => (r.ignition == null ? '—' : (r.ignition ? 'on' : 'off')) },
      { label: 'Position', key: '_p', render: (r) => esc(coord(r.lat, r.lng) || '—') },
      { label: 'Feed', key: 'source', render: (r) => sourceLabel(r.source) },
    ], { compact: true, capped: d.telemetry.length >= 300 ? 'the first 300 fixes' : null }));
  } else {
    empty(tp.body, t.plate
      ? `No tracker reported ${t.plate} while this booking was running. That is a gap in the `
        + 'telemetry, not evidence the trip did not happen.'
      : 'This booking names no vehicle, so there is nothing to look up.');
  }

  /* ── occupancy ────────────────────────────────────────────────────────── */
  if (d.segments?.length) {
    const sp = panel(`Occupancy around this booking — ${countOf(d.segments.length, 'interval')}`,
      'The seat-sensor analysis runs independently of the trip feed. An interval matched to this trip '
      + 'is the two records agreeing; an unmatched one overlapping it is worth a look.');
    root.append(sp.panel);
    sp.body.append(tableFrom(d.segments, [
      { label: 'Started', key: 'started_at', render: (r) => timeStr(r.started_at) },
      { label: 'Minutes', key: 'duration_min', num: true },
      { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
      { label: 'Verdict', key: 'verdict', render: (r) => pill(r.verdict || '—',
        r.verdict === 'unauthorized' ? 'bad' : r.verdict === 'authorized' ? 'ok' : 'warn') },
      { label: 'Matched this trip', key: '_m',
        render: (r) => (r.matched_trip_id === t.external_id ? pill('yes', 'ok')
          : (r.matched_trip_id ? `another ${sourceLabel(r.matched_platform)} trip` : 'no')) },
      { label: 'Why', key: 'verdict_reason' },
    ], { compact: true,
      onRow: (r) => { location.hash = href('segment', r.plate, r.started_at); } }));
  }

  /* ── custody ──────────────────────────────────────────────────────────── */
  if (d.custody?.length) {
    const cp = panel(`Who held ${esc(t.plate)} that day — ${countOf(d.custody.length, 'person', 'people')}`,
      'Custody is resolved per plate per day, so a car that changed hands names everyone who had it.');
    root.append(cp.panel);
    cp.body.append(tableFrom(d.custody, [
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Channel', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'Bookings', key: 'trips', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km, 1) },
      { label: 'First', key: 'first_trip_at', render: (r) => timeStr(r.first_trip_at) },
      { label: 'Last', key: 'last_trip_at', render: (r) => timeStr(r.last_trip_at) },
      { label: 'Primary', key: 'is_primary', render: (r) => (r.is_primary ? pill('yes', 'ok') : '') },
    ], { compact: true }));
  }

  /* ── the provider's own record ────────────────────────────────────────── */
  const raw = el('details', 'act-basis');
  raw.innerHTML = '<summary>What the provider actually sent</summary>'
    + '<p class="cap">The record as it arrived, before this product mapped it into columns. '
    + 'Every figure above is derived from this; a field here with nowhere to go is what '
    + '“What each API offers” is for.</p>';
  /* The record below is now the record MINUS whatever api/redact.js refused to
     serve — on a hotel booking that is the embedded driver's bcrypt password,
     Emirates ID and Expo push token, which /api/trip handed to anonymous
     callers on all 12 of 12 hotel trips sampled on 2026-09-05. A field that
     just vanished from this dump would be indistinguishable from a field the
     provider never sent, and this panel exists precisely to tell those apart,
     so the withheld paths are named. Nothing when the record carried none:
     an empty line under every uber trip would only teach a reader to skip it. */
  const withheld = d.raw_redacted || [];
  if (withheld.length) {
    raw.append(el('p', 'cap', `${countOf(withheld.length, 'field')} withheld: `
      + withheld.map((p) => `<code>${esc(p)}</code>`).join(', ')
      + ' — identity documents and credentials are not served. Everything else the provider sent is below.'));
  }
  const pre = el('pre', 'wrap');
  pre.style.cssText = 'overflow:auto;max-height:26rem;font-size:.72rem;line-height:1.5';
  pre.textContent = JSON.stringify(t.raw ?? {}, null, 2);
  raw.append(pre);
  root.append(raw);

  root.append(el('p', 'cap',
    `Ingested ${t.ingested_at ? dtStr(t.ingested_at) : 'at an unrecorded time'} · `
    + `provider id <code>${esc(t.external_id)}</code> on ${esc(sourceLabel(t.platform))}`
    + (t.plate ? ` · <a href="${href('vehicle', t.plate, 'trips')}">this vehicle’s trips</a>` : '')
    + (t.driver_ext_id ? ` · <a href="${href('driver', t.driver_ext_id, 'trips')}">this driver’s trips</a>` : '')));
  return d;
}
