/* Per-vehicle detail — the asset's own pages.
   ──────────────────────────────────────────────────────────────────────────
     #vehicle/<plate>            overview   what it is, and whether it earns
     #vehicle/<plate>/drivers    drivers    who has held it, day by day
     #vehicle/<plate>/movement   movement   where it goes, and where it sits
     #vehicle/<plate>/earnings   earnings   what it made, and how we know
     #vehicle/<plate>/safety     safety     harsh driving, attributed to a person
     #vehicle/<plate>/compliance compliance documents with an expiry date
     #vehicle/<plate>/trips      trips      the underlying records

   The question a fleet actually asks of a vehicle is "is this asset earning,
   and is it legal to be on the road" — and no single source answers it. The
   platforms know the trips, the telematics box knows the movement, the fleet
   portal knows the papers. These pages put the three next to each other. */

import { barChart, areaChart, donut, hbars, empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note, entity,
  dayStr, dtStr, timeStr, money, pct, fmt } from './ui.js';
import { qAll, href } from './data.js';
import { makeMap, fitTo, renderJourney } from './map.js';

export const VEHICLE_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'drivers', label: 'Drivers', ic: '◧' },
  { id: 'movement', label: 'Movement', ic: '◍' },
  { id: 'earnings', label: 'Earnings', ic: '◈' },
  { id: 'safety', label: 'Safety', ic: '△' },
  { id: 'compliance', label: 'Compliance', ic: '❑' },
  { id: 'trips', label: 'Trips', ic: '▤' },
];

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const docTone = (d) => (d == null ? null : d < 0 ? 'bad' : d < 30 ? 'warn' : 'ok');

/* ── identity header ─────────────────────────────────────────────────────── */
function identityCard(p) {
  const s = p.spec || {}, t = p.telemetry;
  const soonest = (p.documents || []).find((d) => d.days_left != null);
  const wrap = el('div', 'idcard');
  wrap.innerHTML = `
    <div class="platetag">${esc(p.plate)}</div>
    <div class="idmeta">
      <h2>${esc([s.year, s.make, s.model].filter(Boolean).join(' ') || p.plate)}</h2>
      <div class="idsub">
        ${s.fleet_id ? pill(s.fleet_id, 'plat') : ''}
        ${s.fuel_type ? pill(s.fuel_type, 'plat') : ''}
        ${t ? pill(t.stale ? 'tracker stale' : (t.status || 'tracked'), t.stale ? 'warn' : 'ok') : pill('no tracker', 'warn')}
        ${soonest ? pill(`${esc(soonest.doc_type)} ${soonest.days_left < 0 ? `expired ${Math.abs(soonest.days_left)}d ago` : `${soonest.days_left}d left`}`, docTone(soonest.days_left)) : ''}
      </div>
      <div class="idfacts">
        ${p.current_driver?.driver_name
          ? `<span><b>Driver</b> <a class="lnk" href="${href('driver', p.current_driver.driver_ext_id)}">${esc(p.current_driver.driver_name)}</a></span>`
          : '<span><b>Driver</b> unassigned</span>'}
        ${s.colour ? `<span><b>Colour</b> ${esc(s.colour)}</span>` : ''}
        ${s.vin ? `<span><b>VIN</b> ${esc(s.vin)}</span>` : ''}
        ${t?.odometer ? `<span><b>Odometer</b> ${fmt(t.odometer)} km</span>` : ''}
        ${t?.fuel_level != null ? `<span><b>Charge</b> ${fmt(t.fuel_level)}%</span>` : ''}
        <span><b>Last fix</b> ${dtStr(t?.last_fix)}</span>
        <span><b>Drivers</b> ${p.span?.drivers ?? 0}</span>
      </div>
    </div>`;
  return wrap;
}

/* ── tab: overview ───────────────────────────────────────────────────────── */
async function tabOverview(root, plate, prof) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const vol = panel('Trips and idle days', 'A bar per day. Days with a tracker fix but no trip are the ones that cost money.'); g1.append(vol.panel);
  const who = panel('Who has driven it', 'By trips in this window'); g1.append(who.panel);
  const g2 = el('div', 'grid g3'); root.append(g2);
  const prod = panel('Service tier', 'Which product this asset serves'); g2.append(prod.panel);
  const plat = panel('Platform', 'Where its work comes from'); g2.append(plat.panel);
  const pay = panel('Payment', 'Card vs cash'); g2.append(pay.panel);
  const rev = panel('Revenue by day', 'Booked fare value'); root.append(rev.panel);
  [vol.body, who.body, prod.body, plat.body, pay.body, rev.body].forEach(loading);

  const [k, daily, dd, mix] = await Promise.all([
    qAll('/api/vehicle/kpis', { plate }), qAll('/api/vehicle/daily', { plate }),
    qAll('/api/vehicle/drivers-detail', { plate }), qAll('/api/vehicle/mix', { plate }),
  ]);

  kpiHost.replaceWith(kpiRow([
    /* Bookings, not bookings-plus-their-telematics-twins. This tile counted
       both and captioned it "trips", so a vehicle whose tracker was reporting
       looked like it did two to three times the work of one whose tracker was
       not — a difference in what we collect, presented as a difference in how
       hard the car worked. */
    { label: 'Bookings', value: fmt(k.trips),
      sub: `${fmt(k.days_earning ?? k.days_worked)} earning days`
        + (k.telematics_journeys ? ` · ${fmt(k.telematics_journeys)} tracked journeys behind them` : '') },
    { label: 'Distance', value: `${fmt(k.km)} km`,
      sub: k.measured_trips
        ? `avg ${fmt(k.avg_km, 1)} km over ${fmt(k.measured_trips)} measured bookings`
        : 'no booking on this vehicle carries a usable distance' },
    /* Revenue, with the share of bookings it was actually measured over.
       This card read "AED 525 · AED 0.14 per km" against 277 bookings, and both
       numbers are true of the eleven trips that carry a fare and of nothing
       else. Uber's trip export has no fare column at all, so on a car that
       works mostly Uber this figure covers a few per cent of its work — and
       presented bare it reads as what the vehicle earned. The fleet page has
       carried this caveat for a while; the vehicle page had not. */
    /* Both halves. The card above showed fares alone, and this page is the one
       somebody opens to ask what a car is worth: a vehicle working mostly Uber
       led with the price of its handful of hotel bookings while the platform
       paid for the rest of its work by the week. That money was already on the
       page, three panels down, under "attributed". */
    { label: 'Money in', value: k.accounted ? money(k.accounted) : '—',
      sub: k.accounted
        ? `${money(k.accounted_fares || 0)} in fares · ${money(k.accounted_payouts || 0)} attributed from `
          + `platform payouts · ${(k.accounted_platforms || []).join(', ')}`
        : 'no fare and no payout reaches this vehicle in this range' },
    { label: 'Fares', value: k.priced_trips ? money(k.accounted_fares) : '—',
      sub: !k.priced_trips
        ? 'no booking on this vehicle carries a fare'
        : `over ${fmt(k.priced_trips)} of ${fmt(k.trips)} bookings (${pct(100 * k.priced_trips / k.trips, 0)}) that report one`
          + (k.revenue_per_km ? ` · ${money(k.revenue_per_km, 'AED', 2)} per km over those` : ''),
      tone: k.priced_trips && k.trips && k.priced_trips / k.trips < 0.5 ? 'warn' : null },
    { label: 'Utilisation', value: k.utilisation != null ? pct(k.utilisation * 100, 1) : '—', sub: 'platform-reported, share of online time earning',
      tone: k.utilisation == null ? null : k.utilisation >= 0.5 ? 'good' : k.utilisation >= 0.3 ? 'warn' : 'critical' },
    { label: 'Idle days', value: fmt(k.idle_days), sub: 'reported a position, earned nothing',
      tone: k.idle_days === 0 ? 'good' : k.idle_days <= 3 ? 'warn' : 'critical' },
    { label: 'Drivers', value: fmt(k.drivers), sub: `across ${fmt(k.platforms)} platform(s)` },
    /* Completion, which the endpoint has always returned and this page never
       drew. A car with a normal booking count and a poor completion rate is a
       different problem from an idle one, and the vehicle page was the only
       view of the fleet that could not tell them apart. Reported with its
       numerator, so the rate can be checked against the trips it came from. */
    { label: 'Completion', value: pct(k.completion_pct, 1),
      sub: k.outcome_n
        ? `${fmt(k.completed)} of ${fmt(k.outcome_n)} bookings whose platform reports an outcome`
        : 'no platform on this vehicle reports an outcome',
      tone: k.completion_pct == null ? null
        : Number(k.completion_pct) >= 95 ? 'good' : Number(k.completion_pct) >= 85 ? 'warn' : 'critical' },
    { label: 'Harsh events', value: fmt(k.alerts), sub: k.alerts_per_100km != null ? `${fmt(k.alerts_per_100km, 1)} per 100 km` : 'no matched distance',
      tone: k.alerts_per_100km == null ? null : k.alerts_per_100km <= 5 ? 'good' : k.alerts_per_100km <= 15 ? 'warn' : 'critical' },
    { label: 'Last fix', value: k.hours_since_fix != null ? `${fmt(k.hours_since_fix, 1)}h ago` : '—', sub: `${fmt(k.fixes)} fixes in range`,
      tone: k.hours_since_fix == null ? null : k.hours_since_fix < 1 ? 'good' : k.hours_since_fix < 24 ? 'warn' : 'critical' },
  ]));

  vol.body.innerHTML = '';
  // Colour the bar by whether the day earned: an idle day with a live tracker
  // is a different fact from a day the vehicle was simply absent.
  barChart(vol.body, daily.map((d) => ({
    label: `${dayStr(d.day)}${d.trips ? '' : d.fixes ? ' · idle (tracker live)' : ''}`,
    trips: d.trips,
  })), { x: 'label', y: 'trips', color: '--b400' });
  const idle = daily.filter((d) => !d.trips && d.fixes);
  if (idle.length) vol.body.append(el('p', 'cap',
    `${idle.length} day(s) with a tracker fix and no trip on any platform: ${idle.map((d) => dayStr(d.day)).join(', ')}.`));

  who.body.innerHTML = '';
  if (!dd.totals.length) who.body.append(note('No custody records for this vehicle in this window.'));
  else {
    hbars(who.body, dd.totals.slice(0, 8).map((t) => ({ label: t.driver_name || t.driver_ext_id, n: t.trips })),
      { label: 'label', value: 'n', seq: true,
        onClick: (d) => { const t = dd.totals.find((x) => (x.driver_name || x.driver_ext_id) === d.label);
          if (t) location.hash = href('driver', t.driver_ext_id); } });
    who.body.append(el('p', 'cap', 'Click a driver to open their pages.'));
  }

  donut(prod.body, mix.product.slice(0, 6));
  donut(plat.body, mix.platform.slice(0, 6));
  donut(pay.body, mix.payment.slice(0, 6));

  rev.body.innerHTML = '';
  const withRev = daily.filter((d) => d.revenue != null && +d.revenue > 0);
  if (!withRev.length) rev.body.append(note('No fare values on this vehicle’s trips in this window — the Uber trip export omits fares, so revenue only appears where the hotel or telematics feed supplied one.'));
  else areaChart(rev.body, withRev.map((d) => ({ label: dayStr(d.day), v: +d.revenue })), { x: 'label', y: 'v', valueFmt: (v) => money(v) });
}

/* ── tab: drivers ────────────────────────────────────────────────────────── */
async function tabDrivers(root, plate) {
  const tot = panel('Drivers who have held this vehicle', 'Totals across the window — click through to a driver’s pages'); root.append(tot.panel);
  const tl = panel('Custody day by day', 'Every day, and who was holding it. More than one row on a day is a handover.'); root.append(tl.panel);
  [tot.body, tl.body].forEach(loading);
  const dd = await qAll('/api/vehicle/drivers-detail', { plate });

  tot.body.innerHTML = '';
  if (!dd.totals.length) { tot.body.append(note('No custody records for this vehicle in this window.')); }
  else {
    const t = tableFrom(dd.totals, [
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('driver', r.driver_ext_id, r.driver_name || r.driver_ext_id) },
      /* One human, several platform accounts. This table used to list Muhammad
         Khalid twice — once per provider id — with his work split between the
         rows and neither of them right. It folds by person now, and says how
         many accounts the row stands for so the fold is visible rather than
         something the reader has to take on trust. */
      { label: 'Accounts', key: 'driver_ids',
        render: (r) => ((r.driver_ids || []).length > 1
          ? `<span title="${esc((r.driver_ids || []).join(', '))}">${fmt(r.driver_ids.length)}`
            + ` <span class="dim">· ${esc((r.platforms || []).join(', '))}</span></span>`
          : `<span class="dim">${esc((r.platforms || []).join(', ')) || '1'}</span>`) },
      { label: 'Days', key: 'days', num: true },
      { label: 'As primary', key: 'primary_days', num: true },
      { label: 'Trips', key: 'trips', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
      { label: 'Held', key: '_h', render: (r) => `${dayStr(r.first_day)} → ${dayStr(r.last_day)}` },
    ]);
    tot.body.append(t);
  }

  tl.body.innerHTML = '';
  tl.body.append(tableFrom(dd.days.slice(0, 120), [
    { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('driver', r.driver_ext_id, r.driver_name || r.driver_ext_id) },
    { label: 'Platform', key: 'platform' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'First', key: '_a', render: (r) => timeStr(r.first_trip_at) },
    { label: 'Last', key: '_b', render: (r) => timeStr(r.last_trip_at) },
    { label: 'Primary', key: 'is_primary', render: (r) => (r.is_primary ? '●' : '—') },
  ]));
}

/* ── tab: movement ───────────────────────────────────────────────────────── */
async function tabMovement(root, plate) {
  const ctl = el('div', 'toolbar');
  ctl.innerHTML = `<label class="cap" for="vDay">Replay a day</label>
    <select id="vDay" class="btn"></select>
    <span class="cap" id="vDayNote"></span>`;
  root.append(ctl);
  const mapP = panel('Where it went', 'Straight lines join consecutive fixes; a long gap breaks the line rather than inventing a route.');
  mapP.panel.classList.add('mapwrap'); root.append(mapP.panel);
  const node = el('div', 'mapnode'); mapP.body.append(node);
  const stat = el('div'); mapP.body.append(stat);
  const g = el('div', 'grid g2'); root.append(g);
  const verd = panel('Movement accounted for', 'Every period the vehicle moved, matched against a booking'); g.append(verd.panel);
  const park = panel('Where it sits', 'Clusters of stationary fixes — depot, rank, or somebody’s street'); g.append(park.panel);
  const seg = panel('Movement periods', 'Newest first'); root.append(seg.panel);
  [verd.body, park.body, seg.body].forEach(loading);

  const mv = await qAll('/api/vehicle/movement', { plate });
  const map = await makeMap(node, { zoom: 10 });

  /* The replay dropdown is built from days that already have stored fixes, so
     the day currently in progress is either missing or half-there. An operator
     asking "where is this car" needs the newest fixes regardless of which day
     they fall on — this is what the Live page's breadcrumb modal used to give
     and had no other home. */
  const now = panel('Most recent fixes', 'Newest first, whatever day they fall on — the replay above is by completed day');
  root.append(now.panel); loading(now.body);
  qAll('/api/track', { plate }).then((track) => {
    now.body.innerHTML = '';
    if (!track.length) return now.body.append(note('No GPS fix has ever been stored for this plate.'));
    const recent = track.slice(-40).reverse();
    const age = Math.round((Date.now() - Date.parse(recent[0].captured_at)) / 60000);
    now.body.append(el('p', 'cap', age < 60
      ? `Last fix ${age} minute(s) ago — CABMAN polls every five minutes.`
      : `Last fix ${dtStr(recent[0].captured_at)}. This tracker is not currently reporting.`));
    now.body.append(tableFrom(recent, [
      { label: 'Time', key: 'captured_at', render: (r) => dtStr(r.captured_at) },
      { label: 'Speed', key: 'speed', num: true, render: (r) => (r.speed != null ? `${fmt(r.speed)} km/h` : '—') },
      { label: 'Seat', key: 'seat_occupied', render: (r) => (r.seat_occupied == null
        ? '<span class="tag dim">not reported</span>'
        : r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag">empty</span>') },
      { label: 'Ignition', key: 'ignition', render: (r) => (r.ignition == null ? '—' : r.ignition ? 'on' : 'off') },
      { label: 'Lat', key: 'lat', num: true }, { label: 'Lng', key: 'lng', num: true },
      { label: 'Source', key: 'source' },
    ], { compact: true }));
  }).catch(() => { now.body.innerHTML = ''; now.body.append(note('Telemetry could not be read.')); });
  let layer = null;

  const sel = ctl.querySelector('#vDay');
  sel.innerHTML = mv.days.map((d) => `<option value="${String(d.day).slice(0, 10)}">${dayStr(d.day)} · ${d.fixes} fixes</option>`).join('')
    || '<option value="">no replayable days</option>';

  const showParking = () => {
    if (layer) { map.removeLayer(layer); layer = null; }
    layer = L.layerGroup().addTo(map);
    const pts = [];
    mv.parked.forEach((s) => {
      L.circleMarker([s.lat, s.lng], { radius: 5 + Math.min(10, Math.sqrt(s.fixes)), color: css('--s5'),
        weight: 1.5, fill: false, dashArray: '3,3', opacity: .7 }).addTo(layer)
        .bindTooltip(`Stationary across ${s.fixes} fixes`, { direction: 'top' });
      pts.push([s.lat, s.lng]);
    });
    fitTo(map, pts, { maxZoom: 14 });
    stat.innerHTML = '';
    stat.append(el('p', 'cap', mv.parked.length
      ? `${mv.parked.length} places this vehicle stood still. Pick a day above to replay its route instead.`
      : 'No stationary clusters recorded. Pick a day above to replay a route.'));
  };

  const showDay = async (day) => {
    if (!day) return showParking();
    if (layer) { map.removeLayer(layer); layer = null; }
    stat.innerHTML = '<div class="skel">Loading…</div>';
    const j = await qAll('/api/map/journey', { plate, day });
    stat.innerHTML = '';
    if (!j.fixes) { stat.append(note(`No GPS fixes stored for ${plate} on ${day}.`)); return showParking(); }
    layer = renderJourney(map, j);
    stat.append(kpiRow([
      { label: 'Fixes', value: fmt(j.fixes), sub: 'five-minute samples' },
      { label: 'Distance', value: `${fmt(j.distance_km)} km`, sub: 'between consecutive fixes' },
      { label: 'With passenger', value: `${fmt(j.occupied_km)} km`,
        sub: j.distance_km ? `${Math.round((j.occupied_km / j.distance_km) * 100)}% of the day` : null },
      { label: 'Driver', value: j.driver || '—', sub: j.driver_trips != null ? `${j.driver_trips} trips` : 'from the trip record' },
    ]));
  };

  sel.onchange = (e) => showDay(e.target.value);
  if (mv.days.length) await showDay(sel.value); else showParking();

  verd.body.innerHTML = '';
  if (!mv.by_verdict.length) verd.body.append(note('No movement periods derived yet. These come from the occupancy analysis, which needs seat-sensor telemetry alongside the trip feed.'));
  else {
    hbars(verd.body, mv.by_verdict.map((v) => ({ label: v.verdict.replace(/_/g, ' '), n: v.n })), { label: 'label', value: 'n', seq: true });
    const un = mv.by_verdict.find((v) => v.verdict === 'unauthorized');
    if (un) verd.body.append(el('p', 'cap', `${un.n} period(s) covering ${fmt(un.km)} km had the seat occupied and the vehicle moving with no booking on any channel.`));
  }

  park.body.innerHTML = '';
  park.body.append(tableFrom(mv.parked.slice(0, 12), [
    { label: 'Location', key: '_l', render: (r) => `${(+r.lat).toFixed(3)}, ${(+r.lng).toFixed(3)}` },
    { label: 'Fixes', key: 'fixes', num: true },
    { label: 'Approx. hours', key: '_h', num: true, render: (r) => fmt((r.fixes * 5) / 60, 1) },
  ], { compact: true }));
  park.body.append(el('p', 'cap', 'Each fix is a five-minute sample, so the hours column is a floor, not a measure.'));

  seg.body.innerHTML = '';
  /* Every row here is an accusation or an exoneration, and until now it was
     dead text: the verdict pill said "unauthorized" and there was nowhere to
     go to find out why. The start time is the segment's address. */
  seg.body.append(tableFrom(mv.segments.slice(0, 60), [
    { label: 'Started', key: 'started_at',
      render: (r) => `<a href="${href('segment', plate, r.started_at)}">${esc(dtStr(r.started_at))}</a>` },
    { label: 'Ended', key: 'ended_at', render: (r) => timeStr(r.ended_at) },
    { label: 'Minutes', key: 'duration_min', num: true },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Top speed', key: 'top_speed', num: true, render: (r) => (r.top_speed ? `${fmt(r.top_speed)} km/h` : '—') },
    { label: 'Verdict', key: 'verdict', render: (r) => pill(r.verdict || 'unknown',
      r.verdict === 'unauthorized' ? 'bad' : r.verdict === 'authorized' ? 'ok' : 'warn') },
    { label: 'Matched', key: 'matched_platform' },
    { label: 'Confidence', key: 'low_confidence', render: (r) => (r.low_confidence ? 'low' : 'normal') },
  ]));
  if (mv.segments.length > 60) seg.body.append(el('p', 'cap',
    `Showing 60 of ${fmt(mv.segments.length)} movement periods. `
    + `<a href="${href('segments', 'plate', plate)}">All of them, filterable by verdict</a>.`));
  else if (mv.segments.length) seg.body.append(el('p', 'cap',
    `<a href="${href('segments', 'plate', plate)}">The same periods with the verdict filter and the evidence trail</a>.`));
}

/* ── tab: safety ─────────────────────────────────────────────────────────── */
/* ── earnings ──────────────────────────────────────────────────────────────
   This car showed AED 525 against 266 trips and 3,586 km, and the number was
   not wrong — it was the sum of the fares on ten hotel bookings, the only
   trips in the set that carry a price. The other 256 were Uber, which reports
   no fare per trip and pays the DRIVER weekly instead, so the money existed
   and simply had no route to a vehicle page.

   Two columns, never one. The fares are measured: a rider paid that, for that
   trip. The attributed figure is a share of a driver's net payout, after the
   platform's commission, split across the vehicles that driver was holding.
   They are different quantities and adding them would produce a third that
   means nothing — so the page shows both, says which is which, and shows what
   share of the bookings each one covers. */
async function tabEarnings(root, plate) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const chP = panel('By channel', 'Fares are measured per trip; attributed pay is a share of a driver payout'); g.append(chP.panel);
  const drvP = panel('By driver', 'Whose payout, and how much of it this vehicle earned'); g.append(drvP.panel);
  const dayP = panel('Day by day', 'The two series side by side — a gap in one is not a gap in the other'); root.append(dayP.panel);
  [chP.body, drvP.body, dayP.body].forEach(loading);

  const e = await qAll('/api/vehicle/earnings', { plate });
  const t = e.totals;

  kpiHost.replaceWith(kpiRow([
    { label: 'Attributed pay', value: money(t.attributed), sub: 'share of driver payouts, net of commission',
      tone: t.attributed > 0 ? 'good' : null },
    { label: 'Measured fares', value: money(t.fares),
      sub: `on ${fmt(t.priced_bookings)} of ${fmt(t.bookings)} bookings` },
    { label: 'Fare coverage', value: t.fare_coverage_pct != null ? pct(t.fare_coverage_pct) : '—',
      sub: `${fmt(t.priced_platforms)} of ${fmt(t.platforms)} channels price per trip`,
      tone: t.fare_coverage_pct == null ? null : t.fare_coverage_pct >= 80 ? 'good' : t.fare_coverage_pct >= 30 ? 'warn' : 'critical' },
    { label: 'Drivers paid', value: fmt(e.attributed.length), sub: 'contributed pay to this asset' },
  ]));

  /* The sentence that stops the two columns being read as one. Without it the
     smaller number looks like the answer and the larger like a duplicate. */
  if (e.caveat) root.insertBefore(note(e.caveat), g);

  chP.body.innerHTML = '';
  const byChannel = e.by_platform.map((r) => ({
    ...r,
    attributed: e.attributed.filter((a) => a.platform === r.platform)
      .reduce((a, x) => a + Number(x.attributed || 0), 0),
  }));
  if (!byChannel.length) chP.body.append(note('No bookings for this vehicle in this window.'));
  else chP.body.append(tableFrom(byChannel, [
    { label: 'Channel', key: 'platform', render: (r) => pill(r.platform) },
    { label: 'Bookings', key: 'bookings', num: true },
    { label: 'Measured fares', key: 'fares', num: true,
      render: (r) => (r.fares != null ? money(r.fares) : '—') },
    { label: 'Attributed pay', key: 'attributed', num: true,
      render: (r) => (r.attributed > 0 ? money(r.attributed) : '—') },
    { label: 'Km', key: 'km', num: true, render: (r) => (r.km ? fmt(r.km) : '—') },
  ], { compact: true }));
  chP.body.append(el('p', 'cap',
    'A channel with bookings and no fares prices nothing per trip — its money is in the attributed column, or nowhere yet.'));

  drvP.body.innerHTML = '';
  if (!e.attributed.length) {
    drvP.body.append(note('No driver payout overlaps this vehicle in this window. '
      + 'Either the channels here price per trip, or the payout data has not been collected for these dates.'));
  } else {
    drvP.body.append(tableFrom(e.attributed, [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Channel', key: 'platform', render: (r) => pill(r.platform) },
      { label: 'Attributed', key: 'attributed', num: true, render: (r) => money(r.attributed) },
      { label: 'Trips here', key: 'trips', num: true },
      { label: 'Days', key: 'days', num: true },
      /* An even split means the payout period recorded no trips to weight by,
         so the share is the weakest kind of inference this page makes. Marking
         it is the difference between a number and a number you can act on. */
      { label: 'Basis', key: 'any_even_split',
        render: (r) => pill(r.any_even_split ? 'even split' : 'by trips', r.any_even_split ? 'warn' : 'ok') },
    ], { compact: true }));
    drvP.body.append(el('p', 'cap',
      'Attributed pay is a share of that driver’s payout for the period, split across the vehicles they held, weighted by trips.'));
  }

  dayP.body.innerHTML = '';
  if (!e.daily.length) dayP.body.append(note('Nothing to plot for this window.'));
  else {
    /* Two hosts, not one: both chart helpers clear the element they are given,
       so drawing the second into the same node erases the first — and the
       panel would silently show one series while claiming to show two. */
    const a = el('div'); const b = el('div');
    dayP.body.append(el('p', 'cap', 'Attributed pay — a share of driver payouts, by day'), a,
      el('p', 'cap', 'Measured fares — what riders paid on this vehicle’s own trips'), b);
    areaChart(a, e.daily, { x: 'day', y: 'attributed' });
    barChart(b, e.daily, { x: 'day', y: 'fares', label: 'Measured fares' });
  }
}

async function tabSafety(root, plate) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const types = panel('Event types', 'What the telematics box flagged'); g.append(types.panel);
  const drv = panel('Attributed to a driver', 'By whoever held the vehicle on the day of the event'); g.append(drv.panel);
  const line = panel('Events by day', ''); root.append(line.panel);
  const recent = panel('Recent events', 'Newest first, with location where the device reported one'); root.append(recent.panel);
  [types.body, drv.body, line.body, recent.body].forEach(loading);

  const [sf, k] = await Promise.all([qAll('/api/vehicle/safety', { plate }), qAll('/api/vehicle/kpis', { plate })]);
  const total = sf.by_type.reduce((a, r) => a + r.n, 0);

  kpiHost.replaceWith(kpiRow([
    { label: 'Harsh events', value: fmt(total), sub: `over ${fmt(k.km)} km` },
    { label: 'Per 100 km', value: k.alerts_per_100km != null ? fmt(k.alerts_per_100km, 1) : '—', sub: 'comparable across the fleet',
      tone: k.alerts_per_100km == null ? null : k.alerts_per_100km <= 5 ? 'good' : k.alerts_per_100km <= 15 ? 'warn' : 'critical' },
    { label: 'Worst type', value: sf.by_type[0]?.alert_type || '—', sub: sf.by_type[0] ? `${fmt(sf.by_type[0].n)} events` : null },
    { label: 'Most events', value: sf.by_driver[0]?.driver_name || '—', sub: sf.by_driver[0] ? `${fmt(sf.by_driver[0].n)} events` : null },
  ]));

  types.body.innerHTML = '';
  if (!sf.by_type.length) types.body.append(note('No harsh-driving events for this vehicle in this window.'));
  else hbars(types.body, sf.by_type.map((r) => ({ label: r.alert_type, n: r.n })), { label: 'label', value: 'n', seq: true });

  drv.body.innerHTML = '';
  if (!sf.by_driver.length) drv.body.append(note('Nothing to attribute yet.'));
  else {
    drv.body.append(tableFrom(sf.by_driver, [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Events', key: 'n', num: true },
      { label: 'Km that day', key: 'km', num: true, render: (r) => (r.km ? fmt(r.km) : '—') },
      { label: 'Per 100 km', key: '_r', num: true, render: (r) => (r.km > 0 ? fmt((r.n / r.km) * 100, 1) : '—') },
    ], { compact: true }));
    drv.body.append(el('p', 'cap', '“unattributed” means the event landed on a day with no custody record — a trip gap, not an unknown driver.'));
  }

  line.body.innerHTML = '';
  if (!sf.daily.length) empty(line.body, 'No events in this range');
  else barChart(line.body, sf.daily.map((d) => ({ label: dayStr(d.day), alerts: d.alerts })), { x: 'label', y: 'alerts', color: '--s2' });

  recent.body.innerHTML = '';
  recent.body.append(tableFrom(sf.recent.slice(0, 60), [
    { label: 'When', key: 'occurred_at', render: (r) => dtStr(r.occurred_at) },
    { label: 'Event', key: 'alert_type' },
    { label: 'Location', key: 'location' },
    { label: 'Position', key: '_p', render: (r) => (r.lat ? `${(+r.lat).toFixed(4)}, ${(+r.lng).toFixed(4)}` : '—') },
    { label: 'Clip', key: 'video_url', render: (r) => (r.video_url ? `<a class="lnk" href="${esc(r.video_url)}" target="_blank" rel="noopener">view</a>` : '—') },
  ]));
}

/* ── tab: compliance ─────────────────────────────────────────────────────── */
async function tabCompliance(root, plate, prof) {
  const p = panel('Documents', 'Everything with an expiry date attached to this vehicle'); root.append(p.panel);
  const docs = prof.documents || [];
  p.body.innerHTML = '';
  if (!docs.length) {
    p.body.append(note('No documents collected for this vehicle. Uber publishes these per vehicle; they appear once the fleet-portal collector has run against an account that can see them.'));
  } else {
    p.body.append(tableFrom(docs, [
      { label: 'Document', key: 'doc_type' },
      { label: 'Platform', key: 'platform' },
      { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', r.status === 'ACTIVE' ? 'ok' : 'warn') },
      { label: 'Expires', key: 'expires_at', render: (r) => dayStr(r.expires_at) },
      { label: 'Days left', key: 'days_left', num: true, render: (r) => (r.days_left == null ? '—'
        : pill(r.days_left < 0 ? `expired ${Math.abs(r.days_left)}d ago` : `${r.days_left}d`, docTone(r.days_left))) },
    ]));
    const soon = docs.filter((d) => d.days_left != null && d.days_left < 30);
    if (soon.length) p.body.append(el('p', 'cap',
      `${soon.length} document(s) expire within 30 days. Renewal in the UAE is not same-day — leaving it to the final week risks losing the vehicle from service.`));
  }

  const s = prof.spec || {};
  const spec = panel('Specification', 'As the fleet register and the platform profile describe it'); root.append(spec.panel);
  spec.body.innerHTML = '';
  const rows = [['Plate', prof.plate], ['Make', s.make], ['Model', s.model], ['Year', s.year],
    ['Colour', s.colour], ['VIN', s.vin], ['Fuel', s.fuel_type], ['Fleet', s.fleet_id],
    ['Platform record', s.platform ? `${s.platform} · ${s.vehicle_ext_id}` : null],
    ['Platform compliance', s.compliance_status]].filter(([, v]) => v != null && v !== '');
  spec.body.append(el('div', 'kv', rows.map(([k, v]) =>
    `<div class="kv-k">${esc(k)}</div><div class="kv-v">${esc(v)}</div>`).join('')));
  if (s.image_url) {
    const img = el('img'); img.src = s.image_url; img.alt = `${prof.plate}`;
    img.style.cssText = 'max-width:320px;border-radius:var(--r-sm);margin-top:14px';
    spec.body.append(img);
  }
}

/* ── tab: trips ──────────────────────────────────────────────────────────── */
async function tabTrips(root, plate) {
  const p = panel('Trip records', 'Every platform, newest first'); root.append(p.panel); loading(p.body);
  const rows = await qAll('/api/vehicle/trips', { plate, limit: 500 });
  p.body.innerHTML = '';
  if (!rows.length) return empty(p.body);
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="vq" type="search" placeholder="Filter by driver, address, product or status…">
    <span class="cap" id="vn">${rows.length} trips</span>`;
  p.body.append(bar);
  const host = el('div'); p.body.append(host);
  const cols = [
    { label: 'Requested', key: 'requested_at', render: (r) => dtStr(r.requested_at) },
    { label: 'Driver', key: 'driver_name', render: (r) => (r.driver_ext_id
      ? `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>`
      : esc(r.driver_name || '—')) },
    { label: 'Platform', key: 'platform' },
    { label: 'From', key: 'pickup_addr' },
    { label: 'To', key: 'dropoff_addr' },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Product', key: 'product' },
    { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', /cancel/i.test(r.status || '') ? 'warn' : 'ok') },
    { label: 'Fare', key: 'price', num: true, render: (r) => (r.price ? money(r.price, r.currency) : '—') },
  ];
  const draw = (list) => { host.innerHTML = ''; host.append(tableFrom(list.slice(0, 400), cols)); };
  draw(rows);
  bar.querySelector('#vq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
    bar.querySelector('#vn').textContent = `${list.length} trips`;
    draw(list);
  };
}

const TABS = { overview: tabOverview, drivers: tabDrivers, movement: tabMovement,
  earnings: tabEarnings, safety: tabSafety, compliance: tabCompliance, trips: tabTrips };

/* ── page shell ──────────────────────────────────────────────────────────── */
export async function renderVehicle(root, plate, tab = 'overview') {
  const head = el('div'); root.append(head); loading(head);
  const body = el('div'); root.append(body);

  let prof;
  try { prof = await qAll('/api/vehicle/profile', { plate }); }
  catch {
    head.innerHTML = `<div class="empty"><b>No such vehicle</b>Nothing in the record matches this plate.
      <a class="lnk" href="${href('vehicles')}">Back to all vehicles</a></div>`;
    return;
  }
  head.innerHTML = '';
  head.append(identityCard(prof));
  head.append(tabBar(VEHICLE_TABS, tab, (t) => href('vehicle', plate, t === 'overview' ? null : t)));

  const fn = TABS[tab] || tabOverview;
  await fn(body, plate, prof);
  return { name: prof.plate, spec: prof.spec };
}

/* ── the directory that links into the pages above ───────────────────────── */
export async function renderVehicleDirectory(root) {
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="vdq" type="search" placeholder="Search by plate, make, model or driver…">
    <span class="cap" id="vdn"></span>`;
  root.append(bar);
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const tblP = panel('Every vehicle', 'Including assets with no trips in this window — those are the ones worth finding'); root.append(tblP.panel);
  loading(tblP.body);

  const [rows, fleet] = await Promise.all([
    qAll('/api/vehicles/directory'), qAll('/api/kpis').catch(() => ({})),
  ]);
  bar.querySelector('#vdn').textContent = `${rows.length} vehicles`;

  /* `trips` used to include telematics journeys, so a car that drove all month
     with no booking behind it counted as "Earning" — inverting the exact
     question the tile exists to answer. Three states now, and the middle one is
     the operationally interesting bucket that was hidden inside the first. */
  const earning = rows.filter((r) => r.trips > 0).length;
  const movedOnly = rows.filter((r) => !r.trips && r.telematics_journeys > 0).length;
  const still = rows.length - earning - movedOnly;
  const tracked = rows.filter((r) => r.last_fix).length;
  const staleN = rows.filter((r) => r.stale).length;
  const expiring = rows.filter((r) => r.doc_days_left != null && r.doc_days_left < 30).length;
  kpiHost.replaceWith(kpiRow([
    { label: 'Vehicles', value: fmt(rows.length), sub: 'with any record at all' },
    { label: 'Took a booking', value: fmt(earning), sub: 'earned in this window',
      tone: earning === rows.length ? 'good' : rows.length - earning > rows.length / 4 ? 'critical' : 'warn' },
    { label: 'Moved, no booking', value: fmt(movedOnly),
      sub: 'the tracker saw it drive and nothing paid for it',
      tone: movedOnly ? 'critical' : 'good' },
    { label: 'Did not move', value: fmt(still), sub: 'no booking and no journey',
      tone: still ? 'warn' : 'good' },
    { label: 'Tracked', value: fmt(tracked), sub: `${fmt(staleN)} with a stale fix`,
      tone: staleN === 0 ? 'good' : 'warn' },
    { label: 'Documents due', value: fmt(expiring), sub: 'expiring within 30 days',
      tone: expiring === 0 ? 'good' : 'critical' },
  ]));
  /* Bookings with no vehicle recorded appear on no vehicle page, so this table
     sums to fewer trips than the fleet does. Said plainly, because a reader who
     adds the column up and gets a different number to the overview has no way
     to tell which of the two is wrong. */
  if (fleet.trips_without_vehicle) {
    tblP.body.append(note(`${fmt(fleet.trips_without_vehicle)} booking(s) in this window carry no `
      + 'vehicle at all, so they appear on no row here — this table sums to that many fewer trips '
      + 'than the fleet total on the overview.'));
  }

  const cols = [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    // Not the vehicle's identity — that is the plate beside it. A column
    // labelled "Vehicle" that prints a make and model and links nowhere reads
    // as a dead end when it is really a description.
    { label: 'Make & model', key: '_v', render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
    { label: 'Current driver', key: 'current_driver',
      render: (r) => (r.current_driver_id
        ? entity('driver', r.current_driver_id, r.current_driver)
        : `<span class="ent-off">${esc(r.current_driver || '—')}</span>`) },
    { label: 'Bookings', key: 'trips', num: true, render: (r) => fmt(r.trips) },
    { label: 'Journeys seen', key: 'telematics_journeys', num: true,
      render: (r) => fmt(r.telematics_journeys) },
    { label: 'Days', key: 'days', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
    { label: 'Alerts', key: 'alerts', num: true },
    { label: 'Tracker', key: '_t', render: (r) => (!r.last_fix ? pill('none', 'warn')
      : pill(r.stale ? 'stale' : (r.status || 'live'), r.stale ? 'warn' : 'ok')) },
    { label: 'Documents', key: '_d', render: (r) => (r.doc_days_left == null ? '—'
      : pill(r.doc_days_left < 0 ? 'expired' : `${r.doc_days_left}d`, docTone(r.doc_days_left))) },
    { label: 'Last trip', key: 'last_trip', render: (r) => dayStr(r.last_trip) },
  ];
  const draw = (list) => {
    tblP.body.innerHTML = '';
    const t = tableFrom(list, cols);
    t.querySelectorAll('tbody tr').forEach((tr, i) => {
      tr.style.cursor = 'pointer';
      tr.onclick = (ev) => { if (ev.target.tagName !== 'A') location.hash = href('vehicle', list[i].plate); };
    });
    tblP.body.append(t);
  };
  draw(rows);
  bar.querySelector('#vdq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => `${r.plate} ${r.make} ${r.model} ${r.current_driver}`.toLowerCase().includes(t)) : rows;
    bar.querySelector('#vdn').textContent = `${list.length} vehicles`;
    draw(list);
  };
  return rows;
}
