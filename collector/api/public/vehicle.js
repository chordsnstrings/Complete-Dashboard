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

import { barChart, gapBars, areaChart, donut, hbars, empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note, entity,
  dayStr, dateStr, dtStr, timeStr, money, pct, fmt, tripTime,
  custodyAsOf, sourceLabel, plural, countOf, asList, UBER_FARE, noneChosen} from './ui.js';
import { qAll, href, parseHash, currentGen, alive } from './data.js';
import { dubaiDay } from './tz.js';
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
/* Everything in `span` moves with the range selector, and only one of it was
   drawn — as a bare "Drivers 3", which reads as how many people have ever held
   this car. Measured on L36397:

     days=7     trips   87   journeys  47   days_worked   7   first_trip 2026-08-19
     days=365   trips 3987   journeys 986   days_worked 342   first_trip 2025-08-26

   So the count changed under a label that promised it would not, and the four
   figures beside it — including the telematics journey count, which is the
   only place on the page the twin feed is quantified — were fetched on every
   visit and shown nowhere. They are drawn together now, under a heading that
   names the window they belong to. */
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
        ${/* With the as-of day. "Driver: Mohammed Alsous" in the present tense
              over a custody record from last September is how somebody rings
              the wrong person; custodyAsOf was written for exactly this. */
  ''}<span><b>Last held by</b> ${custodyAsOf(p.current_driver
    ? { name: p.current_driver.driver_name, id: p.current_driver.driver_ext_id, day: p.current_driver.as_of }
    : null)}</span>
        ${s.colour ? `<span><b>Colour</b> ${esc(s.colour)}</span>` : ''}
        ${s.vin ? `<span><b>VIN</b> ${esc(s.vin)}</span>` : ''}
        ${t?.odometer ? `<span><b>Odometer</b> ${fmt(t.odometer)} km</span>` : ''}
        ${/* 0 is what the FMS feed sends when it has nothing to report, and it
              rendered as "Charge 0%" on cars doing 68 km/h. A flat battery and
              a feed with no battery reading are different facts. */
  t?.fuel_level != null && !(Number(t.fuel_level) === 0 && /fms/i.test(t.source || ''))
    ? `<span><b>Charge</b> ${fmt(t.fuel_level)}%</span>`
    : '<span><b>Charge</b> <span class="ent-off" title="this vehicle’s feed reports no fuel or charge level — a 0 here is an absent reading, not an empty tank">not reported</span></span>'}
        <span><b>Last fix</b> ${t?.last_fix ? `${dateStr(t.last_fix)} ${timeStr(t.last_fix)}` : '—'}</span>
        ${/* first_trip stays INSIDE the window sentence. Given its own heading
              it read as the day the car entered service, and it is not: at
              days=30 it says 27 July 2026 and at days=365 it says 26 August
              2025 — the same defect one line up, moved down a line. Nothing in
              this payload knows when the car started; saying so is better than
              printing a date that quietly means something else. */''}
        <span><b>In this window</b> ${fmt(p.span?.trips ?? 0)} trip${p.span?.trips === 1 ? '' : 's'}${
  p.span?.days_worked != null ? ` over ${fmt(p.span.days_worked)} day${p.span.days_worked === 1 ? '' : 's'}` : ''
}${p.span?.drivers != null ? ` · ${fmt(p.span.drivers)} driver${p.span.drivers === 1 ? '' : 's'}` : ''}${
  p.span?.telematics_journeys != null
    ? ` · ${fmt(p.span.telematics_journeys)} telematics journey${p.span.telematics_journeys === 1 ? '' : 's'}`
    : ''}${p.span?.first_trip ? `<span class="dim" title="the earliest trip inside the selected range, not the day the car entered service"> from ${dateStr(p.span.first_trip)}</span>` : ''}</span>
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
          + `platform payouts · ${(k.accounted_platforms || []).map(sourceLabel).join(', ')}`
        : 'no fare and no payout reaches this vehicle in this range' },
    { label: 'Fares', value: k.priced_trips ? money(k.accounted_fares) : '—',
      sub: !k.priced_trips
        ? 'no booking on this vehicle carries a fare'
        : `over ${fmt(k.priced_trips)} of ${fmt(k.trips)} bookings (${pct(100 * k.priced_trips / k.trips, 0)}) that report one`
          + (k.revenue_per_km ? ` · ${money(k.revenue_per_km, 'AED', 2)} per km over those` : ''),
      tone: k.priced_trips && k.trips && k.priced_trips / k.trips < 0.5 ? 'warn' : null },
    { label: 'Utilisation', value: k.utilisation != null ? pct(k.utilisation * 100, 1) : '—', sub: 'platform-reported, share of online time earning',
      tone: k.utilisation == null ? null : k.utilisation >= 0.5 ? 'good' : k.utilisation >= 0.3 ? 'warn' : 'critical' },
    /* Zero records is not zero idle days. A vehicle with nothing at all on it
       in this window scored "Idle days 0" and was painted GREEN — the best
       possible reading of a car we know nothing about. */
    (() => {
      const known = (k.fixes || 0) > 0 || (k.trips || 0) > 0;
      if (!known) {
        return { label: 'Idle days', value: '—',
          sub: 'no booking and no tracker fix in this window — nothing to judge either way' };
      }
      return { label: 'Idle days', value: fmt(k.idle_days), sub: 'reported a position, earned nothing',
        tone: k.idle_days === 0 ? 'good' : k.idle_days <= 3 ? 'warn' : 'critical' };
    })(),
    { label: 'Drivers', value: fmt(k.drivers), sub: `across ${countOf(k.platforms, 'platform')}` },
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
  /* A day the endpoint omits is drawn as a HOLE, not as a touching bar.
     18 rows over a 31-day window were drawn as 18 adjacent bars, so a car that
     sat still from the 12th to the 18th looked like it worked every day at a
     lower rate. gapBars exists for exactly this: absent days are hatched,
     tracker journeys are drawn behind the bookings, and a car that moved
     without earning is visible instead of being a footnote. */
  const byDay = new Map(daily.map((d) => [String(d.day).slice(0, 10), d]));
  const keys = daily.map((d) => String(d.day).slice(0, 10)).sort();
  const series = [];
  if (keys.length) {
    for (let t = Date.parse(`${keys[0]}T12:00:00Z`); t <= Date.parse(`${keys[keys.length - 1]}T12:00:00Z`); t += 864e5) {
      const key = dubaiDay(new Date(t));
      const d = byDay.get(key);
      series.push({ d: key, trips: d ? +d.trips || 0 : 0, fixes: d ? +d.fixes || 0 : 0,
        uncollected: !d });
    }
  }
  gapBars(vol.body, series, { x: 'd', y: 'trips', label: 'bookings', secondary: 'fixes',
    secondaryLabel: 'tracker fixes', gapLabel: 'no record for this vehicle on this day',
    onClick: (r) => { location.hash = href('day', r.d); } });
  const idle = daily.filter((d) => !d.trips && d.fixes);
  if (idle.length) {
    const c = el('p', 'cap');
    c.innerHTML = `${countOf(idle.length, 'day')} with a tracker fix and no booking on any platform: `
      + idle.map((d) => `<a class="lnk" href="${href('day', String(d.day).slice(0, 10))}">${esc(dayStr(d.day))}</a>`).join(', ')
      + '. That is the figure the Idle days tile counts.';
    vol.body.append(c);
  }

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
            + ` <span class="dim">· ${esc((r.platforms || []).map(sourceLabel).join(', '))}</span></span>`
          : `<span class="dim">${esc((r.platforms || []).join(', ')) || '1'}</span>`) },
      { label: 'Days', key: 'days', num: true },
      { label: 'As primary', key: 'primary_days', num: true },
      { label: 'Trips', key: 'trips', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Fares', key: 'revenue', num: true, absent: UBER_FARE,
        render: (r) => (r.revenue ? money(r.revenue) : '—') },
      { label: 'Held', key: 'last_day',
        sortValue: (r) => (r.last_day ? Date.parse(r.last_day) : null),
        render: (r) => `${dateStr(r.first_day)} → ${dateStr(r.last_day)}` },
    ], { sortable: true, sortId: 'vcust', defaultSort: { key: 'trips', dir: 'desc' } });
    tot.body.append(t);
  }

  tl.body.innerHTML = '';
  tl.body.append(tableFrom(dd.days.slice(0, 120), [
    { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('driver', r.driver_ext_id, r.driver_name || r.driver_ext_id) },
    { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'First', key: '_a', render: (r) => timeStr(r.first_trip_at) },
    { label: 'Last', key: '_b', render: (r) => timeStr(r.last_trip_at) },
    { label: 'Primary', key: 'is_primary', render: (r) => (r.is_primary ? '●' : '—') },
  ], { sortable: true, sortId: 'vcustdays', defaultSort: { key: 'day', dir: 'desc' } }));
  /* A table that ends on exactly 120 rows is a table somebody cut, and nothing
     here said so — on a car with a year of custody that is four months of days
     silently missing from the bottom of the list. */
  if (dd.days.length > 120) {
    tl.body.append(el('p', 'cap',
      `The 120 most recent of ${countOf(dd.days.length, 'day')} on which somebody held this `
      + 'vehicle. Sort by Day ascending to reach the earliest of them.'));
  }
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
  /* The four tiles above are ONE replayed day; these four panels are the whole
     window. They sat on one screen with nothing to say the periods differ. */
  const verd = panel('Movement accounted for — across the window',
    'Every period the vehicle moved in the selected range, matched against a booking. Not the single day '
    + 'replayed above.');
  g.append(verd.panel);
  const park = panel('Where it sits — across the window',
    'Clusters of stationary fixes over the whole range: depot, rank, or somebody’s street.');
  g.append(park.panel);
  const seg = panel('Movement periods — across the window', 'Newest first'); root.append(seg.panel);
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
    if (!track.length) {
      const tripsTab = plate ? href('vehicle', plate, 'trips') : null;
      const n = el('div', 'note');
      n.innerHTML = 'No GPS fix has ever been stored for this plate — this vehicle carries no tracker we '
        + 'can read, which is a different thing from a tracker that has gone quiet.'
        + (tripsTab ? ` Its bookings are still on the <a class="lnk" href="${tripsTab}">Trips tab</a>.` : '');
      return now.body.append(n);
    }
    const recent = track.slice(-40).reverse();
    const age = Math.round((Date.now() - Date.parse(recent[0].captured_at)) / 60000);
    now.body.append(el('p', 'cap', age < 60
      ? `Last fix ${countOf(age, 'minute')} ago — CABMAN polls every five minutes.`
      : `Last fix ${dtStr(recent[0].captured_at)}. This tracker is not currently reporting.`));
    now.body.append(tableFrom(recent, [
      { label: 'Time', key: 'captured_at', render: (r) => `${dateStr(r.captured_at)} ${timeStr(r.captured_at)}` },
      { label: 'Speed', key: 'speed', num: true, render: (r) => (r.speed != null ? `${fmt(r.speed)} km/h` : '—') },
      { label: 'Seat', key: 'seat_occupied', render: (r) => (r.seat_occupied == null
        ? '<span class="tag dim">not reported</span>'
        : r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag">empty</span>') },
      { label: 'Ignition', key: 'ignition', render: (r) => (r.ignition == null ? '—' : r.ignition ? 'on' : 'off') },
      /* Six decimals, not sixteen — the same precision the parked-cluster
         table three panels down uses, so two tables on one page stop printing
         the same coordinate two different ways. Six decimals is about 11cm,
         which is finer than any of these feeds can resolve. */
      { label: 'Position', key: 'lat', num: true,
        render: (r) => (r.lat == null ? '—'
          : `<span class="plate">${(+r.lat).toFixed(6)}, ${(+r.lng).toFixed(6)}</span>`) },
      { label: 'Source', key: 'source', render: (r) => esc(sourceLabel(r.source)) },
    ], { compact: true, sortable: true, sortId: 'track', defaultSort: { key: 'captured_at', dir: 'desc' } }));
  }).catch(() => { now.body.innerHTML = ''; now.body.append(note('Telemetry could not be read.')); });
  let layer = null;

  const sel = ctl.querySelector('#vDay');
  /* "119 fixes" here against "108" on the replay KPI for the same day: this
     count is every stored row and the replay counts the ones with coordinates,
     because a fix with no lock cannot be drawn. Named as stored rows so the two
     read as the different things they are. */
  sel.innerHTML = mv.days.map((d) => `<option value="${esc(String(d.day).slice(0, 10))}">${
    esc(dateStr(d.day))} · ${fmt(d.fixes)} stored fixes</option>`).join('')
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
    // Headed with the day, because these four tiles are one date and the four
    // panels below them are the whole window.
    stat.append(el('p', 'cap', `Everything in these four tiles is ${dateStr(`${day}T12:00:00`)} alone.`));
    stat.append(kpiRow([
      { label: 'Fixes with a position', value: fmt(j.fixes),
        sub: 'five-minute samples that carry coordinates — the picker above counts stored rows, '
          + 'including any with no satellite lock' },
      { label: 'Distance', value: `${fmt(j.distance_km)} km`, sub: 'between consecutive fixes' },
      /* Null, not zero, where the feed carries no seat sensor. An FMS-tracked
         plate showed "0 km · 0% of the day" — a positive claim that it drove
         empty — on days it ran fifteen bookings. */
      j.occupancy_reported
        ? { label: 'With passenger', value: `${fmt(j.occupied_km)} km`,
          sub: j.occupancy_measured_km
            ? `${Math.round((j.occupied_km / j.occupancy_measured_km) * 100)}% of the distance where occupancy was measured`
            : null }
        : { label: 'With passenger', value: '—',
          sub: 'this vehicle’s feed carries no seat sensor, so occupancy was never measured' },
      { label: 'Driver', html: j.driver ? entity('driver', j.driver_id, j.driver) : '—',
        sub: j.driver_trips != null ? `${fmt(j.driver_trips)} trips that day` : 'from the trip record' },
    ]));
  };

  sel.onchange = (e) => showDay(e.target.value);
  /* Every trip row in the app deep-links here with ?day= — the replay of THIS
     vehicle on THAT trip's day. Honoured only when the day is actually
     replayable; an address asking for a day with no stored fixes falls back to
     the newest one, exactly as if no day had been asked for. */
  const asked = parseHash().day;
  if (asked && mv.days.some((d) => String(d.day).slice(0, 10) === asked)) sel.value = asked;
  if (mv.days.length) await showDay(sel.value); else showParking();

  verd.body.innerHTML = '';
  if (!mv.by_verdict.length) verd.body.append(note('No movement periods derived yet. These come from the occupancy analysis, which needs seat-sensor telemetry alongside the trip feed.'));
  else {
    hbars(verd.body, mv.by_verdict.map((v) => ({ label: v.verdict.replace(/_/g, ' '), n: v.n })), { label: 'label', value: 'n', seq: true });
    const un = mv.by_verdict.find((v) => v.verdict === 'unauthorized');
    if (un) {
      verd.body.append(el('p', 'cap',
        `${countOf(un.n, 'period')} covering ${fmt(un.km)} km had the seat occupied and the `
        + 'vehicle moving with no booking on any channel.'));
    }
  }

  park.body.innerHTML = '';
  const parkShown = mv.parked.slice(0, 12);
  park.body.append(tableFrom(parkShown, [
    // Six decimals, matching the fix table above — the two printed the same
    // kind of coordinate at three decimals and at sixteen on one page.
    { label: 'Location', key: 'lat', num: true,
      render: (r) => `<span class="plate">${(+r.lat).toFixed(6)}, ${(+r.lng).toFixed(6)}</span>` },
    { label: 'Fixes', key: 'fixes', num: true },
    { label: 'Approx. hours', key: '_h', num: true,
      sortValue: (r) => (r.fixes * 5) / 60,
      render: (r) => fmt((r.fixes * 5) / 60, 1) },
  ], { compact: true, sortable: true, sortId: 'parked', defaultSort: { key: 'fixes', dir: 'desc' } }));
  park.body.append(el('p', 'cap',
    'Each fix is a five-minute sample, so the hours column is a floor, not a measure.'
    + (mv.parked.length > parkShown.length
      ? ` Showing the ${fmt(parkShown.length)} longest of ${countOf(mv.parked.length, 'cluster')}, `
        + 'ordered by how many fixes landed there.'
      : '')));

  seg.body.innerHTML = '';
  /* Every row here is an accusation or an exoneration, and until now it was
     dead text: the verdict pill said "unauthorized" and there was nowhere to
     go to find out why. The start time is the segment's address. */
  const segShown = mv.segments.slice(0, 60);
  const anyReason = mv.segments.some((r) => r.verdict_reason);
  /* An empty table here fell through to tableFrom's default, "No data for this
     range yet" — which on a page that has just drawn a map of this vehicle's
     parking is simply confusing. A segment is built from a RUN of fixes with
     the seat occupied; a car that was tracked all month and never carried
     anybody produces none, and that is the answer rather than a gap. It says
     what IS held instead, so the reader can tell the two apart. */
  if (!mv.segments.length) {
    empty(seg.body, mv.days.length
      ? `No occupancy interval was built for ${plate} in this window. `
        + `${countOf(mv.days.length, 'day')} of fixes ${plural(mv.days.length, 'is', 'are')} stored and `
        + `${countOf(mv.parked.length, 'stationary period')} `
        + `${plural(mv.parked.length, 'was', 'were')} found — the tracker was reporting; `
        + 'it never saw a run of fixes with the seat occupied.'
      : `No telemetry at all is stored for ${plate} in this window, so nothing could be built `
        + 'from it. Collection gaps says whether CABMAN was running.');
  } else seg.body.append(tableFrom(segShown, [
    { label: 'Started', key: 'started_at',
      render: (r) => `<a href="${href('segment', plate, r.started_at)}">${esc(`${dateStr(r.started_at)} ${timeStr(r.started_at)}`)}</a>` },
    { label: 'Ended', key: 'ended_at', render: (r) => timeStr(r.ended_at) },
    { label: 'Minutes', key: 'duration_min', num: true },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Top speed', key: 'top_speed', num: true, render: (r) => (r.top_speed ? `${fmt(r.top_speed)} km/h` : '—') },
    { label: 'Verdict', key: 'verdict', render: (r) => pill(r.verdict || 'unknown',
      r.verdict === 'unauthorized' ? 'bad' : r.verdict === 'authorized' ? 'ok' : 'warn') },
    /* The reason. Without it a verdict is an assertion, and this table was
       strictly poorer than the SAME rows on #segments, which has carried the
       reason and the unreadable-channel list since it was built. */
    ...(anyReason ? [{ label: 'Why', key: 'verdict_reason',
      render: (r) => (r.verdict_reason
        ? `<span class="wrap dim" title="${esc(r.verdict_reason)}">${esc(String(r.verdict_reason).slice(0, 90))}${
          String(r.verdict_reason).length > 90 ? '…' : ''}</span>`
        : '<span class="ent-off" title="judged by a version of the reconciler that did not write one down">no reason recorded</span>') }] : []),
    { label: 'Matched', key: 'matched_platform',
      render: (r) => (r.matched_platform ? esc(sourceLabel(r.matched_platform))
        : '<span class="ent-off" title="no booking on any collected channel overlaps this interval">no booking matched</span>') },
    { label: 'Confidence', key: 'low_confidence',
      render: (r) => {
        if (!r.low_confidence) return '<span class="tag dim">ok</span>';
        const out = asList(r.unavailable_sources).map(sourceLabel);
        return `<span class="tag warn" title="${esc(out.length
          ? `unreadable when this was judged: ${out.join(', ')}`
          : 'a revenue channel was unreadable when this was judged')}">blind${
          out.length ? ` · ${esc(out.join(', '))}` : ''}</span>`;
      } },
  ], { sortable: true, sortId: 'vsegs', defaultSort: { key: 'started_at', dir: 'desc' } }));
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
    /* Which channels' payouts are IN this figure, and which are deliberately
       out. `attributed_earnings` and `accounted_payouts` differ by exactly
       Yango's payout, because Yango prices per trip AND pays out — counting
       both would count those bookings twice — and the exclusion was invisible,
       so the Overview tile and this one disagreed by AED 1,818 with nothing
       on either page to reconcile them. */
    { label: 'Attributed pay', value: money(t.attributed),
      sub: (t.attributed_platforms || e.attributed_platforms || []).length
        ? `share of driver payouts from ${(t.attributed_platforms || e.attributed_platforms).join(', ')}, `
          + 'net of commission'
        : 'share of driver payouts, net of commission',
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
  ], { compact: true, sortable: true, sortId: 'vchan', defaultSort: { key: 'bookings', dir: 'desc' } }));
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
      /* Named for the period it counts. "Trips here 288" was the trip count of
         the whole PAYOUT PERIOD, not of the window — the Drivers tab said 171
         for the same car and the same range, and neither number was labelled. */
      { label: 'Trips in the payout period', key: 'trips', num: true },
      { label: 'Period', key: 'period_start',
        absent: 'no statement attributed to this vehicle carries period bounds — the channel '
          + 'sent an amount and the days it covers without saying which days those are',
        render: (r) => (r.period_start
          ? `${dateStr(r.period_start)} → ${dateStr(r.period_end)}`
          : '<span class="ent-off" title="the statement carries no period bounds">—</span>') },
      { label: 'Days', key: 'days', num: true },
      /* An even split means the payout period recorded no trips to weight by,
         so the share is the weakest kind of inference this page makes. Marking
         it is the difference between a number and a number you can act on. */
      { label: 'Basis', key: 'any_even_split',
        render: (r) => pill(r.any_even_split ? 'even split' : 'by trips', r.any_even_split ? 'warn' : 'ok') },
    ], { compact: true, sortable: true, sortId: 'vattr', defaultSort: { key: 'attributed', dir: 'desc' } }));
    drvP.body.append(el('p', 'cap',
      'Attributed pay is a share of that driver’s payout for the period, split across the vehicles they '
      + 'held, weighted by trips. A payout period is weekly and straddles the edge of the window above, '
      + 'so "Trips in the payout period" is over the whole statement and will not match the Drivers tab, '
      + 'which counts this window.'));
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
    /* The residual, so the two panels reconcile. by_type summed 1,436 and
       by_driver 1,381 on the same car, with the 55 events attributed to nobody
       simply absent — under a caption explaining what "(unattributed)" means,
       on a table that never showed one. Synthesised here until the endpoint
       returns the bucket the fleet-level route already does. */
    const attributed = sf.by_driver.reduce((a, r) => a + (+r.n || 0), 0);
    const rows = [...sf.by_driver];
    const missing = total - attributed;
    if (missing > 0 && !rows.some((r) => /unattributed/i.test(r.driver_name || ''))) {
      rows.push({ driver_name: '(unattributed)', driver_ext_id: null, n: missing, km: null });
    }
    drv.body.append(tableFrom(rows, [
      { label: 'Driver', key: 'driver_name',
        render: (r) => (r.driver_ext_id
          ? entity('driver', r.driver_ext_id, r.driver_name)
          : `<span class="ent-off" title="no custody record for this vehicle on the day of these events">${esc(r.driver_name)}</span>`) },
      { label: 'Events', key: 'n', num: true },
      /* The driver's BOOKED km on this plate, which is what the fleet safety
         page divides by. This column used a different distance, so the same
         driver read 215.3 per 100 km here and 34 on the vehicle rate beside
         it — the ratio of two figures nobody could see were different. */
      { label: 'Booked km here', key: 'booked_km', num: true,
        sortValue: (r) => (r.booked_km ?? r.km ?? null),
        render: (r) => ((r.booked_km ?? r.km)
          ? fmt(r.booked_km ?? r.km)
          : '<span class="ent-off" title="no booking of theirs on this plate carries a distance">—</span>') },
      { label: 'Per 100 km', key: '_r', num: true,
        sortValue: (r) => { const km = r.booked_km ?? r.km; return km > 0 ? (r.n / km) * 100 : null; },
        render: (r) => {
          const km = r.booked_km ?? r.km;
          if (!(km > 0)) return '<span class="ent-off" title="no distance to rate over">—</span>';
          const rate = (r.n / km) * 100;
          return `${fmt(rate, 1)}${km < 200 ? '<span class="dim" title="under 200 km — too small a base to compare on"> · thin</span>' : ''}`;
        } },
    ], { compact: true, sortable: true, sortId: 'vsafe', defaultSort: { key: 'n', dir: 'desc' } }));
    drv.body.append(el('p', 'cap',
      '“unattributed” means the event landed on a day with no custody record — a trip gap, not an '
      + 'unknown driver. Rates are over BOOKED kilometres on this plate, which is the same basis the '
      + 'fleet safety page uses, so the two are comparable.'
      + (missing > 0 ? ` ${countOf(missing, 'event')} on this vehicle could not be attributed to anybody.` : '')));
  }

  line.body.innerHTML = '';
  if (!sf.daily.length) empty(line.body, 'No events in this range');
  else barChart(line.body, sf.daily.map((d) => ({ label: dayStr(d.day), alerts: d.alerts })), { x: 'label', y: 'alerts', color: '--s2' });

  recent.body.innerHTML = '';
  /* Columns that can never have a value are dropped rather than drawn as sixty
     dashes. This device reports neither a position nor a clip on any event, so
     "Position" and "Clip" were two empty columns under a caption promising
     "with location where the device reported one" — which reads as a device
     that stopped reporting rather than one that never did. */
  const anyPos = sf.recent.some((r) => r.lat != null);
  const anyClip = sf.recent.some((r) => r.video_url);
  const shown = sf.recent.slice(0, 60);
  recent.body.append(tableFrom(shown, [
    { label: 'When', key: 'occurred_at', render: (r) => `${dateStr(r.occurred_at)} ${timeStr(r.occurred_at)}` },
    { label: 'Event', key: 'alert_type' },
    // The device's own trailing comma and unit code are noise on every row.
    { label: 'Location', key: 'location',
      render: (r) => esc(String(r.location || '').replace(/\s*,\s*$/, '').replace(/\s+[A-Z0-9]{6,}$/, '') || '—') },
    ...(anyPos ? [{ label: 'Position', key: 'lat', num: true,
      render: (r) => (r.lat ? `${(+r.lat).toFixed(4)}, ${(+r.lng).toFixed(4)}` : '—') }] : []),
    ...(anyClip ? [{ label: 'Clip', key: 'video_url',
      render: (r) => (r.video_url ? `<a class="lnk" href="${esc(r.video_url)}" target="_blank" rel="noopener">view</a>` : '—') }] : []),
  ], { sortable: true, sortId: 'vrecent', defaultSort: { key: 'occurred_at', dir: 'desc' } }));
  const caps = [];
  if (!anyPos) caps.push('This tracker attaches no coordinates to an event, so there is no position column');
  if (!anyClip) caps.push('and no camera is fitted, so there is no clip');
  if (sf.recent.length > shown.length || sf.recent.length >= 100) {
    caps.push(`showing the ${fmt(shown.length)} most recent of ${fmt(sf.recent.length)} the server returned`
      + (sf.recent.length >= 100 ? ', which is itself the newest 100' : ''));
  }
  if (caps.length) recent.body.append(el('p', 'cap', `${caps.join(' — ')}.`));
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
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', r.status === 'ACTIVE' ? 'ok' : 'warn') },
      { label: 'Expires', key: 'expires_at', render: (r) => dayStr(r.expires_at) },
      { label: 'Days left', key: 'days_left', num: true, render: (r) => (r.days_left == null ? '—'
        : pill(r.days_left < 0 ? `expired ${Math.abs(r.days_left)}d ago` : `${r.days_left}d`, docTone(r.days_left))) },
    ], { sortable: true, sortId: 'vdocs2', defaultSort: { key: 'days_left', dir: 'asc' } }));
    const soon = docs.filter((d) => d.days_left != null && d.days_left < 30);
    if (soon.length) p.body.append(el('p', 'cap',
      `${countOf(soon.length, 'document')} ${plural(soon.length, 'expires', 'expire')} within 30 days. `
      + 'Renewal in the UAE is not same-day — leaving it to the final week risks losing the vehicle '
      + 'from service.'));
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
    /* The picture is hosted by the PLATFORM, not by us — tb-static.uber.com —
       so it is the one thing on this page that can fail for reasons nothing
       here controls. Ad blockers block that host as a matter of course, and a
       failed <img> renders as a broken-image icon with the plate beside it,
       which reads as a broken page rather than as a picture we do not have.
       On failure the image removes itself and says where it came from. */
    const img = el('img');
    img.alt = `${prof.plate}`;
    img.style.cssText = 'max-width:320px;border-radius:var(--r-sm);margin-top:14px';
    /* Handler BEFORE src, and no lazy loading. A cached failure can dispatch
       error before the next statement runs, and `loading="lazy"` defers the
       request until the image scrolls into view — which on a panel below the
       fold means the fallback appears late or not at all. Both would leave the
       broken-image icon this exists to replace. */
    img.onerror = () => {
      img.replaceWith(el('p', 'cap',
        `The photograph for this vehicle is served by ${esc(sourceLabel(s.platform) || 'the platform')} `
        + 'and could not be loaded. Nothing else on this page depends on it.'));
    };
    img.src = s.image_url;
    spec.body.append(img);
  }
}

/* ── tab: trips ──────────────────────────────────────────────────────────── */
async function tabTrips(root, plate) {
  const p = panel('Trip records', 'Every platform, newest first'); root.append(p.panel); loading(p.body);
  /* A page, not a ceiling — the twin of the driver trip ledger. The endpoint
     returns {rows, total, offset, truncated}, so the table can say how many of
     the window's trips are actually on screen and the reader can ask for the
     rest instead of silently seeing four hundred of twelve hundred. */
  const PAGE = 500;
  const res0 = await qAll('/api/vehicle/trips', { plate, limit: PAGE });
  const rows = res0.rows || [];
  let total = res0.total ?? rows.length;
  p.body.innerHTML = '';
  if (!rows.length) return empty(p.body);
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="vq" type="search" placeholder="Filter by driver, address, product or status…">
    <span class="cap" id="vn"></span>`;
  p.body.append(bar);
  const host = el('div'); p.body.append(host);
  const cols = [
    { label: 'Requested', key: 'requested_at', render: (r) => tripTime(plate, r.requested_at) },
    { label: 'Driver', key: 'driver_name', render: (r) => (r.driver_ext_id
      ? `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>`
      : esc(r.driver_name || '—')) },
    { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'From', key: 'pickup_addr' },
    { label: 'To', key: 'dropoff_addr' },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Product', key: 'product' },
    { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', /cancel/i.test(r.status || '') ? 'warn' : 'ok') },
    { label: 'Fare', key: 'price', num: true,
      absent: 'Uber\'s trip export carries no fare column at all, and Uber is most of what this '
        + 'vehicle carries — the money for those trips reaches the fleet in the weekly statement',
      render: (r) => (r.price ? money(r.price, r.currency) : '—') },
  ];
  const DRAW = 400;
  const count = (n) => {
    bar.querySelector('#vn').textContent = rows.length < total
      ? `${fmt(n)} of ${fmt(rows.length)} loaded · ${fmt(total)} in this window`
      : `${fmt(n)} of ${fmt(rows.length)} trips`;
  };
  const draw = (list) => {
    host.innerHTML = '';
    host.append(tableFrom(list.slice(0, DRAW), cols));
    const caps = [];
    if (list.length > DRAW) caps.push(`drawing the ${fmt(DRAW)} newest of ${fmt(list.length)} matching`);
    if (rows.length < total) caps.push(`${fmt(rows.length)} of ${fmt(total)} trips in this window are loaded`);
    if (caps.length) host.append(el('p', 'cap', `${caps.join('; ')}.`));
    if (rows.length < total) {
      const more = el('button', 'btn', `Load the next ${fmt(Math.min(PAGE, total - rows.length))}`);
      more.onclick = async () => {
        more.disabled = true; more.textContent = 'Loading…';
        try {
          const next = await qAll('/api/vehicle/trips', { plate, limit: PAGE, offset: rows.length });
          rows.push(...(next.rows || []));
          total = next.total ?? total;
          const t = bar.querySelector('#vq').value.trim().toLowerCase();
          const l = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
          count(l.length); draw(l);
        } catch {
          more.disabled = false; more.textContent = 'Could not load more — try again';
        }
      };
      host.append(more);
    }
  };
  count(rows.length);
  draw(rows);
  bar.querySelector('#vq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
    count(list.length);
    draw(list);
  };
}

const TABS = { overview: tabOverview, drivers: tabDrivers, movement: tabMovement,
  earnings: tabEarnings, safety: tabSafety, compliance: tabCompliance, trips: tabTrips };

/* ── page shell ──────────────────────────────────────────────────────────── */
export async function renderVehicle(root, plate, tab = 'overview') {
  /* Addressed with no id — a typed URL, a stale bookmark, a link whose id
     never got filled in. It went to the endpoint and printed the API's own
     complaint. #day has always answered this properly; these four did not. */
  if (!plate) return noneChosen(root, 'vehicle', 'vehicles', 'Every vehicle');
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
    /* Named, because the product carries two rules for the word "stale" and
       this page uses the other one. /api/vehicles flags a fix stale after 11
       minutes; /api/live flags it after 30, which is what #live and #map show.
       On the same fleet at the same moment that read 65 here and 50 there,
       with neither tile saying which rule it applied.

       They are not obviously reconcilable: measured on production, an FMS
       vehicle reports every ~5 minutes (median fix age 7 min across 83
       vehicles) while a CABMAN one sits at a median of 43. Eleven minutes
       calls most healthy CABMAN vehicles stale; thirty calls a silent FMS one
       fresh. Picking one number for both feeds is a decision about what the
       word should mean, so both tiles now state the rule they used instead. */
    { label: 'Tracked', value: fmt(tracked),
      sub: `${fmt(staleN)} with no fix in 11 min`,
      tone: staleN === 0 ? 'good' : 'warn' },
    { label: 'Documents due', value: fmt(expiring), sub: 'expiring within 30 days',
      tone: expiring === 0 ? 'good' : 'critical' },
  ]));
  /* Bookings with no vehicle recorded appear on no vehicle page, so this table
     sums to fewer trips than the fleet does. Said plainly, because a reader who
     adds the column up and gets a different number to the overview has no way
     to tell which of the two is wrong.

     Appended to the PANEL and not to its body: draw() clears the body on every
     search keystroke, so this caveat existed for exactly as long as it took the
     table to render and was then destroyed by the very next call. */
  if (fleet.trips_without_vehicle) {
    tblP.panel.append(note(`${countOf(fleet.trips_without_vehicle, 'booking')} in this window `
      + `${plural(fleet.trips_without_vehicle, 'carries', 'carry')} no vehicle at all, so they appear on `
      + 'no row here — this table sums to that many fewer trips than the fleet total on the overview.'));
  }

  const anyFleet = rows.some((r) => r.fleet_id);
  const cols = [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    // Not the vehicle's identity — that is the plate beside it. A column
    // labelled "Vehicle" that prints a make and model and links nowhere reads
    // as a dead end when it is really a description.
    { label: 'Make & model', key: '_v', render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
    ...(anyFleet ? [{ label: 'Fleet', key: 'fleet_id',
      render: (r) => (r.fleet_id ? pill(sourceLabel(r.fleet_id), 'plat') : '—') }] : []),
    /* With the as-of day. 28 of these rows named somebody whose custody record
       predates June, in the present tense, on the page an operator scans to
       decide who to ring about a car. */
    { label: 'Last held by', key: 'current_driver',
      sortValue: (r) => (r.current_driver || '').toLowerCase() || null,
      render: (r) => custodyAsOf(r.current_driver
        ? { name: r.current_driver, id: r.current_driver_id, day: r.current_driver_as_of || r.driver_as_of }
        : null) },
    { label: 'Bookings', key: 'trips', num: true, render: (r) => fmt(r.trips) },
    { label: 'Journeys seen', key: 'telematics_journeys', num: true,
      render: (r) => fmt(r.telematics_journeys) },
    { label: 'Days', key: 'days', num: true },
    { label: 'Days moved', key: 'days_moved', num: true,
      render: (r) => (r.days_moved == null
        ? '<span class="ent-off" title="no tracker on this vehicle">—</span>'
        : fmt(r.days_moved)) },
    { label: 'Booked km', key: 'km', num: true, render: (r) => fmt(r.km) },
    /* The column behind the "Moved, no booking" tile. The tile is painted
       critical off telematics_km and the table had no column carrying it, so
       fourteen vehicles whose tracker saw 20% more distance than their
       bookings account for could not be found from this page. */
    { label: 'Tracked km', key: 'telematics_km', num: true,
      render: (r) => {
        if (r.telematics_km == null) return '<span class="ent-off" title="no tracker on this vehicle">—</span>';
        const over = r.km > 0 && r.telematics_km > r.km * 1.2;
        return `${fmt(r.telematics_km)}${over
          ? `<span class="dim" title="the tracker saw ${fmt(Math.round((r.telematics_km / r.km - 1) * 100))}% more distance than the bookings account for"> · +${
            Math.round((r.telematics_km / r.km - 1) * 100)}%</span>` : ''}`;
      } },
    { label: 'Fares', key: 'revenue', num: true, absent: UBER_FARE,
      render: (r) => (r.revenue
        ? `${money(r.revenue)}${r.priced_trips != null
          ? `<span class="dim" title="bookings on this vehicle that report a fare"> · ${fmt(r.priced_trips)}</span>` : ''}`
        : '<span class="ent-off" title="no booking on this vehicle reports a fare — Uber’s export has no fare column">—</span>') },
    { label: 'Alerts', key: 'alerts', num: true },
    /* A count beside a Km column and no rate between them: a car doing 6,000km
       with 40 events and one doing 400km with 12 read as the first being
       worse. Computed from the two columns already on the row. */
    { label: 'Per 100 km', key: '_p100', num: true,
      sortValue: (r) => (r.km > 0 ? ((+r.alerts || 0) / r.km) * 100 : null),
      render: (r) => (r.km > 0
        ? fmt(((+r.alerts || 0) / r.km) * 100, 1)
        : '<span class="ent-off" title="no booked distance to rate over">—</span>') },
    { label: 'Drivers', key: 'drivers', num: true,
      render: (r) => (r.drivers == null ? '—' : fmt(r.drivers)) },
    /* The pill took its colour from staleness and its text from the provider's
       status word, so a tracker whose status string is "OFFLINE" rendered
       GREEN as long as the fix was recent. Both halves decide the tone now. */
    { label: 'Tracker', key: '_t',
      sortValue: (r) => (!r.last_fix ? 0 : r.stale ? 1 : 2),
      render: (r) => {
        if (!r.last_fix) return pill('none', 'warn');
        const down = /offline|off|dead|inactive|disconnect/i.test(r.status || '');
        const label = r.stale ? 'stale' : (r.status || 'live');
        return pill(label, (r.stale || down) ? 'warn' : 'ok')
          + (r.fix_age_min != null ? `<span class="dim" title="minutes since the last fix"> ${fmt(r.fix_age_min)}m</span>` : '');
      } },
    { label: 'Documents', key: 'doc_days_left', num: true,
      render: (r) => (r.doc_days_left == null
        ? '<span class="ent-off" title="no document with an expiry date on this vehicle">—</span>'
        : pill(r.doc_days_left < 0 ? 'expired' : `${r.doc_days_left}d`, docTone(r.doc_days_left))) },
    { label: 'Last trip', key: 'last_trip',
      sortValue: (r) => (r.last_trip ? Date.parse(r.last_trip) : null),
      render: (r) => (r.last_trip ? dateStr(r.last_trip) : '<span class="ent-off">never</span>') },
  ];
  const draw = (list, term) => {
    tblP.body.innerHTML = '';
    if (!list.length) {
      tblP.body.append(note(`No vehicle matches “${term}”. Searching plate, make, model and driver across `
        + `the ${fmt(rows.length)} vehicles on the books — every one is loaded, so this is the whole fleet `
        + 'and not a page of it.'));
      return;
    }
    tblP.body.append(tableFrom(list, cols, {
      sortable: true, sortId: 'vdir', defaultSort: { key: 'trips', dir: 'desc' },
      onRow: (r) => { location.hash = href('vehicle', r.plate); },
    }));
  };
  draw(rows, '');
  bar.querySelector('#vdq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => `${r.plate} ${r.make} ${r.model} ${r.current_driver}`.toLowerCase().includes(t)) : rows;
    bar.querySelector('#vdn').textContent = `${fmt(list.length)} of ${fmt(rows.length)} vehicles`;
    draw(list, t);
  };
  return rows;
}
