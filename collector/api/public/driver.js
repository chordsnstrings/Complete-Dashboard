/* Per-driver detail — six pages, not one.
   ──────────────────────────────────────────────────────────────────────────
   A driver is the unit most operational decisions are made about: who to coach,
   who to give the better car to, whose licence is about to lapse. One scrolling
   page can't carry that, so this splits into addressable sub-pages:

     #driver/<id>            overview   — who they are and how they stand
     #driver/<id>/activity   activity   — when they work, and how consistently
     #driver/<id>/territory  territory  — where they work, and where they wait
     #driver/<id>/earnings   earnings   — what the work paid
     #driver/<id>/quality    quality    — completion, cancellations, driving
     #driver/<id>/trips      trips      — the underlying records

   Every panel here answers over *all* of a person's platform accounts, because
   the server folds Uber/Yango/Bolt ids that share a name into one identity. */

import { barChart, areaChart, donut, hbars, heatmap, empty } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note,
  dayStr, dtStr, timeStr, hourStr, money, pct, fmt } from './ui.js';
import { qAll, href } from './data.js';
import { makeMap, fitTo } from './map.js';

export const DRIVER_TABS = [
  { id: 'overview', label: 'Overview', ic: '◱' },
  { id: 'activity', label: 'Activity', ic: '◷' },
  { id: 'territory', label: 'Territory', ic: '◍' },
  { id: 'earnings', label: 'Earnings', ic: '◈' },
  { id: 'quality', label: 'Quality', ic: '△' },
  { id: 'trips', label: 'Trips', ic: '▤' },
];

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* ── percentile bars: where this driver sits in the fleet ─────────────────
   A bar is the driver's percentile, and the tick is the fleet median (always
   the 50th percentile — drawn so the bar has something to be read against). */
function percentileBars(host, metrics) {
  host.innerHTML = '';
  if (!metrics.length) return empty(host);
  const wrap = el('div', 'pbars');
  metrics.forEach((m, i) => {
    const p = Math.max(0, Math.min(100, m.percentile));
    const tone = p >= 75 ? '--good' : p >= 40 ? '--s1' : p >= 20 ? '--warn' : '--critical';
    const row = el('div', 'pbar');
    row.innerHTML = `
      <div class="pb-l">${esc(m.label)}</div>
      <div class="pb-track">
        <i style="width:${p}%;background:var(${tone});animation-delay:${i * 55}ms"></i>
        <span class="pb-mid" title="fleet median"></span>
      </div>
      <div class="pb-v num">${p}<small>th</small></div>`;
    row.title = `${m.label}: ${fmt(m.value, 1)} — fleet median ${fmt(m.median, 1)}`;
    wrap.append(row);
  });
  host.append(wrap);
}

/* ── first trip of each day, plotted as a clock ───────────────────────────
   The mockup's "first login" scatter. Consistency is the signal: a tight band
   is a driver on a shift, a scattered column is someone working ad hoc. */
function startScatter(host, days) {
  host.innerHTML = '';
  const pts = days.filter((d) => Number.isFinite(+d.first_hour)).map((d) => ({ ...d, first_hour: +d.first_hour }));
  if (pts.length < 2) return empty(host, 'Not enough working days to show a pattern');
  const W = 760, H = 240, P = { l: 46, r: 12, t: 14, b: 26 };
  const xs = pts.map((d) => +new Date(d.day));
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  // Scale to the hours actually used, with at least a 4-hour window: a driver
  // who always starts between 06:20 and 07:10 has a real pattern, and plotting
  // it against a full 24-hour axis flattens that into a single line.
  const hs = pts.map((d) => d.first_hour);
  // Clamp to the clock: a driver whose first trip is at 00:20 must not produce
  // a "-1:00" gridline, and one finishing at 23:50 must not produce "25:00".
  let lo = Math.max(0, Math.floor(Math.min(...hs) - 0.6));
  let hi = Math.min(24, Math.ceil(Math.max(...hs) + 0.6));
  if (hi - lo < 4) {
    const mid = (hi + lo) / 2;
    lo = Math.max(0, Math.min(20, mid - 2));
    hi = Math.min(24, lo + 4);
  }
  const X = (t) => P.l + ((+new Date(t) - x0) / Math.max(1, x1 - x0)) * (W - P.l - P.r);
  const Y = (h) => P.t + ((h - lo) / (hi - lo)) * (H - P.t - P.b);
  const step = (hi - lo) <= 6 ? 1 : (hi - lo) <= 12 ? 2 : 4;
  const svg = ['<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img">'];
  for (let h = Math.ceil(lo); h <= hi; h += step) {
    svg.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${Y(h)}" y2="${Y(h)}" stroke="var(--rule)" stroke-width="1"/>`);
    svg.push(`<text x="4" y="${Y(h) + 4}" font-size="10" fill="var(--ink-3)">${String(h).padStart(2, '0')}:00</text>`);
  }
  // the band containing the middle half of start times — the "usual" shift start
  const sorted = pts.map((d) => d.first_hour).sort((a, b) => a - b);
  const qa = sorted[Math.floor(sorted.length * 0.25)], qb = sorted[Math.floor(sorted.length * 0.75)];
  svg.push(`<rect x="${P.l}" y="${Y(qa)}" width="${W - P.l - P.r}" height="${Math.max(2, Y(qb) - Y(qa))}"
    fill="var(--accent-soft)" data-fade/>`);
  pts.forEach((d, i) => {
    svg.push(`<circle cx="${X(d.day).toFixed(1)}" cy="${Y(d.first_hour).toFixed(1)}" r="4.5"
      fill="var(--s1)" fill-opacity=".78" stroke="var(--surface)" stroke-width="1.2" data-rise
      style="animation-delay:${i * 16}ms"><title>${dayStr(d.day)} · first trip ${hourStr(d.first_hour)} · ${d.trips} trips</title></circle>`);
  });
  svg.push(`<text x="${P.l}" y="${H - 8}" font-size="10" fill="var(--ink-3)">${dayStr(pts[0].day)}</text>`);
  svg.push(`<text x="${W - P.r}" y="${H - 8}" font-size="10" fill="var(--ink-3)" text-anchor="end">${dayStr(pts[pts.length - 1].day)}</text>`);
  svg.push('</svg>');
  host.innerHTML = svg.join('');
  host.append(el('p', 'cap', `Shaded band = the middle half of start times (${hourStr(qa)}–${hourStr(qb)}). Each dot is one working day.`));
}

/* ── the shift bar: first trip → last trip, one row per day ─────────────── */
function shiftBars(host, days) {
  host.innerHTML = '';
  /* Postgres returns `numeric` as a STRING. `first_hour + 0.25` therefore
     concatenated ("6.5" + 0.25 = "6.50.25"), Math.max saw NaN, and every bar
     rendered as width:NaN% with a "—" end time. The whole panel was dead on
     every driver, and it looked like a styling problem. Coerce at the edge. */
  const rows = days.filter((d) => Number.isFinite(+d.first_hour)).slice(-28);
  if (!rows.length) return empty(host);
  const wrap = el('div', 'shifts');
  rows.forEach((d, i) => {
    const a = +d.first_hour;
    const b = Math.max(Number.isFinite(+d.last_hour) ? +d.last_hour : a, a + 0.25);
    const r = el('div', 'shift');
    r.innerHTML = `<div class="sh-d">${dayStr(d.day)}</div>
      <div class="sh-track"><i style="left:${(a / 24) * 100}%;width:${((b - a) / 24) * 100}%;animation-delay:${i * 25}ms"></i></div>
      <div class="sh-v num">${hourStr(a)}–${hourStr(b)}</div>
      <div class="sh-t num">${d.trips}</div>`;
    r.title = `${dayStr(d.day)} · ${d.trips} trips · ${fmt(d.km)} km${d.holiday_name ? ' · ' + d.holiday_name : ''}`;
    wrap.append(r);
  });
  host.append(wrap);
  host.append(el('p', 'cap', 'Bar spans the first to the last trip of the day (Dubai time) — not paid hours, but the working window the trips describe.'));
}

/* ── online vs on-trip, one chart ─────────────────────────────────────────
   Two areas on the same axis: total hours logged in, and the part of that with
   a passenger aboard. The gap between them is the idle time being paid for. */
function dualSeries(host, days) {
  host.innerHTML = '';
  const W = 760, H = 230, P = { l: 34, r: 10, t: 14, b: 24 };
  const max = Math.max(1, ...days.map((d) => +d.hours_online || 0));
  const X = (i) => P.l + (i / Math.max(1, days.length - 1)) * (W - P.l - P.r);
  const Y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const area = (key) => {
    const top = days.map((d, i) => `${X(i).toFixed(1)},${Y(+d[key] || 0).toFixed(1)}`).join(' L ');
    return `M ${X(0).toFixed(1)},${(H - P.b).toFixed(1)} L ${top} L ${X(days.length - 1).toFixed(1)},${(H - P.b).toFixed(1)} Z`;
  };
  const line = (key) => 'M ' + days.map((d, i) => `${X(i).toFixed(1)},${Y(+d[key] || 0).toFixed(1)}`).join(' L ');
  const svg = [`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">`];
  for (let g = 0; g <= 4; g++) {
    const v = (max / 4) * g;
    svg.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--rule)" stroke-width="1"/>`);
    svg.push(`<text x="2" y="${Y(v) + 4}" font-size="10" fill="var(--ink-3)">${v.toFixed(0)}h</text>`);
  }
  svg.push(`<path d="${area('hours_online')}" fill="var(--s1)" fill-opacity=".16" data-fade/>`);
  svg.push(`<path d="${line('hours_online')}" fill="none" stroke="var(--s1)" stroke-width="2" data-draw/>`);
  svg.push(`<path d="${area('hours_on_trip')}" fill="var(--s3)" fill-opacity=".26" data-fade/>`);
  svg.push(`<path d="${line('hours_on_trip')}" fill="none" stroke="var(--s3)" stroke-width="2" data-draw/>`);
  days.forEach((d, i) => {
    svg.push(`<circle cx="${X(i).toFixed(1)}" cy="${Y(+d.hours_online || 0).toFixed(1)}" r="7" fill="transparent">` +
      `<title>${dayStr(d.day)} · ${fmt(d.hours_online, 1)}h online, ${fmt(d.hours_on_trip, 1)}h on trip</title></circle>`);
  });
  svg.push('</svg>');
  host.innerHTML = svg.join('');
  const online = days.reduce((a, d) => a + (+d.hours_online || 0), 0);
  const onTrip = days.reduce((a, d) => a + (+d.hours_on_trip || 0), 0);
  host.append(el('div', 'legend', `
    <span><i style="background:var(--s1)"></i>online ${fmt(online, 0)}h</span>
    <span><i style="background:var(--s3)"></i>with a passenger ${fmt(onTrip, 0)}h</span>
    <span>the gap is ${fmt(online - onTrip, 0)}h of paid-for availability that earned nothing</span>`));
}

/* ── identity header, shown above every tab ──────────────────────────────── */
function identityCard(p) {
  const c = p.compliance?.[0] || {};
  const wrap = el('div', 'idcard');
  const initials = (p.name || '?').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
  const lic = c.licence_days_left;
  const licTone = lic == null ? null : lic < 0 ? 'bad' : lic < 30 ? 'warn' : 'ok';
  wrap.innerHTML = `
    <div class="av">${esc(initials)}</div>
    <div class="idmeta">
      <h2>${esc(p.name || 'Unnamed driver')}</h2>
      <div class="idsub">
        ${(p.platforms || []).map((x) => pill(x, 'plat')).join('')}
        ${p.span?.fleet_id ? pill(p.span.fleet_id, 'plat') : ''}
        ${c.state ? pill(c.state, c.state === 'active' ? 'ok' : 'warn') : ''}
        ${lic != null ? pill(`licence ${lic < 0 ? `expired ${Math.abs(lic)}d ago` : `${lic}d left`}`, licTone) : ''}
      </div>
      <div class="idfacts">
        ${c.phone ? `<span><b>Phone</b> ${esc(c.phone)}</span>` : ''}
        ${c.licence_no ? `<span><b>Licence</b> ${esc(c.licence_no)}</span>` : ''}
        ${c.emirates_id ? `<span><b>Emirates ID</b> ${esc(c.emirates_id)}</span>` : ''}
        ${c.device_brand ? `<span><b>Device</b> ${esc(c.device_brand)} ${esc(c.device_model || '')}</span>` : ''}
        <span><b>First seen</b> ${dayStr(p.span?.first_trip)}</span>
        <span><b>Last seen</b> ${dtStr(p.span?.last_trip)}</span>
        <span><b>Accounts</b> ${(p.accounts || []).length}</span>
      </div>
    </div>`;
  return wrap;
}

/* ── tab: overview ───────────────────────────────────────────────────────── */
async function tabOverview(root, id, prof) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const stand = panel('Standing in the fleet', 'Percentile against every driver with 5+ trips in this window'); g1.append(stand.panel);
  const veh = panel('Vehicles held', 'Days in custody, from the trip record'); g1.append(veh.panel);
  const g2 = el('div', 'grid g2'); root.append(g2);
  const start = panel('When the day starts', 'First trip of each working day'); g2.append(start.panel);
  const hm = panel('Weekday × hour', 'Where this driver’s trips actually fall'); g2.append(hm.panel);
  const vol = panel('Trips per day', 'Completed and cancelled, day by day'); root.append(vol.panel);
  [stand.body, veh.body, start.body, hm.body, vol.body].forEach(loading);

  const [k, st, daily, hmap] = await Promise.all([
    qAll('/api/driver/kpis', { id }), qAll('/api/driver/standing', { id }),
    qAll('/api/driver/daily', { id }), qAll('/api/driver/heatmap', { id }),
  ]);

  kpiHost.replaceWith(kpiRow([
    { label: 'Typical start', value: hourStr(k.median_start_h), sub: k.start_consistency_h != null ? `±${(+k.start_consistency_h).toFixed(1)}h day to day` : null },
    { label: 'Days worked', value: fmt(k.days_worked), sub: `${fmt(k.trips_per_day, 1)} trips per day` },
    { label: 'Hours online', value: k.hours_online != null ? fmt(k.hours_online, 1) : '—', sub: k.hours_on_trip != null ? `${fmt(k.hours_on_trip, 1)}h with a passenger` : 'platform-reported' },
    { label: 'Utilisation', value: k.utilisation_pct != null ? pct(k.utilisation_pct) : '—', sub: 'on-trip ÷ online', tone: k.utilisation_pct == null ? null : k.utilisation_pct >= 55 ? 'good' : k.utilisation_pct >= 35 ? 'warn' : 'critical' },
    { label: 'Trips', value: fmt(k.trips), sub: `${fmt(k.km)} km · avg ${fmt(k.avg_km, 1)} km` },
    { label: 'Completion', value: pct(k.completion_pct, 1), sub: `${pct(k.cancel_pct, 1)} cancelled`, tone: k.completion_pct >= 95 ? 'good' : k.completion_pct >= 85 ? 'warn' : 'critical' },
    { label: 'Revenue', value: money(k.revenue), sub: k.avg_fare ? `avg fare ${money(k.avg_fare)}` : 'where the platform reports fares' },
    k.rating ? { label: 'Rating', value: fmt(k.rating, 2), sub: 'platform-reported', tone: k.rating >= 4.8 ? 'good' : k.rating >= 4.5 ? 'warn' : 'critical' } : null,
  ]));

  percentileBars(stand.body, st.metrics || []);
  stand.body.append(el('p', 'cap', `Compared against ${st.n_peers || 0} drivers active in this window.`));

  veh.body.innerHTML = '';
  // Narrow panel — the date range rides in the row tooltip rather than forcing
  // a horizontal scrollbar onto four columns that matter more.
  const vt = tableFrom((prof.vehicles || []).slice(0, 8), [
    { label: 'Plate', key: 'plate', render: (r) => `<a class="lnk" href="${href('vehicle', r.plate)}">${esc(r.plate)}</a>${r.ever_primary ? ' <span class="dim">●</span>' : ''}` },
    { label: 'Days', key: 'days', num: true },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
  ], { compact: true });
  vt.querySelectorAll('tbody tr').forEach((tr, i) => {
    const r = prof.vehicles[i];
    tr.title = `${r.plate} · held ${dayStr(r.first_day)} → ${dayStr(r.last_day)}` +
      `${r.ever_primary ? ' · primary driver on at least one day' : ''}`;
  });
  veh.body.append(vt);
  veh.body.append(el('p', 'cap', '● marks a vehicle this driver was the primary holder of. Hover a row for the dates.'));

  startScatter(start.body, daily);
  heatmap(hm.body, hmap);
  vol.body.innerHTML = '';
  barChart(vol.body, daily.map((d) => ({ ...d, label: dayStr(d.day) })), { x: 'label', y: 'trips', color: '--b400' });
}

/* ── tab: activity ───────────────────────────────────────────────────────── */
async function tabActivity(root, id) {
  const g0 = el('div', 'grid g2'); root.append(g0);
  const sh = panel('Shift window by day', 'From first trip to last trip'); g0.append(sh.panel);
  const hrs = panel('Hours online vs on-trip', 'Only for days the platform reported hours'); g0.append(hrs.panel);
  const dist = panel('Distance per day', 'Kilometres covered'); root.append(dist.panel);
  const tbl = panel('Day by day', 'Every working day, with the weather and calendar context for that date'); root.append(tbl.panel);
  const cust = panel('Vehicle custody', 'Which car, which day — handovers included'); root.append(cust.panel);
  [sh.body, hrs.body, dist.body, tbl.body, cust.body].forEach(loading);

  const [daily, custody] = await Promise.all([qAll('/api/driver/daily', { id }), qAll('/api/driver/custody', { id })]);

  shiftBars(sh.body, daily);

  const withHours = daily.filter((d) => d.hours_online != null);
  hrs.body.innerHTML = '';
  if (!withHours.length) hrs.body.append(note('No platform-reported hours in this window. Uber and Yango only publish these for recent periods, so this fills in as the collector runs.'));
  else dualSeries(hrs.body, withHours);

  dist.body.innerHTML = '';
  barChart(dist.body, daily.map((d) => ({ label: dayStr(d.day), km: +d.km || 0 })), { x: 'label', y: 'km', color: '--b300', valueFmt: (v) => `${fmt(v)} km` });

  tbl.body.innerHTML = '';
  tbl.body.append(tableFrom([...daily].reverse(), [
    { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
    { label: 'First', key: '_f', render: (r) => hourStr(r.first_hour) },
    { label: 'Last', key: '_l', render: (r) => hourStr(r.last_hour) },
    { label: 'Span', key: 'span_h', num: true, render: (r) => (r.span_h ? `${fmt(r.span_h, 1)} h` : '—') },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Cancelled', key: 'cancelled', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
    { label: 'Online', key: 'hours_online', num: true, render: (r) => (r.hours_online ? `${fmt(r.hours_online, 1)} h` : '—') },
    { label: 'Vehicle', key: 'plates' },
    { label: 'Context', key: '_c', render: (r) => [
      r.temp_max != null ? `${Math.round(r.temp_max)}°C` : null,
      r.precipitation > 0 ? 'rain' : null,
      r.is_holiday ? esc(r.holiday_name || 'holiday') : null,
      r.is_ramadan ? 'Ramadan' : null,
    ].filter(Boolean).join(' · ') || '—' },
  ]));

  cust.body.innerHTML = '';
  cust.body.append(tableFrom(custody.slice(0, 60), [
    { label: 'Day', key: 'day', render: (r) => dayStr(r.day) },
    { label: 'Plate', key: 'plate', render: (r) => `<a class="lnk" href="${href('vehicle', r.plate)}">${esc(r.plate)}</a>` },
    { label: 'Platform', key: 'platform' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'First', key: '_a', render: (r) => timeStr(r.first_trip_at) },
    { label: 'Last', key: '_b', render: (r) => timeStr(r.last_trip_at) },
    { label: 'Primary', key: 'is_primary', render: (r) => (r.is_primary ? '●' : '—') },
  ]));
}

/* ── tab: territory ──────────────────────────────────────────────────────── */
async function tabTerritory(root, id) {
  // Map beside the area list rather than above it: a full-width map is roughly
  // 2.4:1, and a driver's working area is roughly square, so a full-width panel
  // is mostly empty margin however tightly the points are framed.
  const g = el('div', 'grid g23'); root.append(g);
  const mapP = panel('Where this driver works', 'Circles are pickup clusters, sized by trips. Hollow markers are places the vehicle sat still between jobs.');
  mapP.panel.classList.add('mapwrap'); g.append(mapP.panel);
  const node = el('div', 'mapnode'); mapP.body.append(node);
  const areas = panel('Busiest pickup areas', 'From the address the platform recorded'); g.append(areas.panel);
  const dmix = panel('Trip distance mix', 'Short hops or long runs'); root.append(dmix.panel);
  [areas.body, dmix.body].forEach(loading);

  const [terr, mix] = await Promise.all([qAll('/api/driver/territory', { id }), qAll('/api/driver/mix', { id })]);

  // The map is drawn either way. An empty map of the emirate still tells you
  // "we have no positions for this person", which a paragraph in place of the
  // map does not — and it keeps the page from reflowing between drivers.
  {
    const map = makeMap(node, { zoom: 10 });
    const pts = [];
    const max = Math.max(1, ...terr.pickups.map((p) => p.n));
    terr.idle.forEach((s) => {
      L.circleMarker([s.lat, s.lng], { radius: 5 + Math.min(9, Math.sqrt(s.fixes)), color: css('--s5'), weight: 1.4,
        fill: false, opacity: .65, dashArray: '3,3' }).addTo(map)
        .bindTooltip(`Stationary here across ${s.fixes} five-minute fixes`, { direction: 'top' });
      pts.push([s.lat, s.lng]);
    });
    terr.pickups.forEach((p) => {
      L.circleMarker([p.lat, p.lng], {
        radius: 4 + 11 * Math.sqrt(p.n / max), color: '#fff', weight: 1.2,
        fillColor: css('--s1'), fillOpacity: .8,
      }).addTo(map).bindTooltip(
        `<b>${esc(p.addr || 'pickup')}</b><br>${p.n} pickup${p.n > 1 ? 's' : ''}` +
        `<br>avg ${fmt(p.avg_km, 1)} km${p.avg_fare ? ` · ${money(p.avg_fare)}` : ''}`, { direction: 'top' });
      pts.push([p.lat, p.lng]);
    });
    terr.dropoffs.slice(0, 150).forEach((d) => {
      L.circleMarker([d.lat, d.lng], { radius: 3, color: css('--s3'), weight: 1, fillColor: css('--s3'), fillOpacity: .4 })
        .addTo(map).bindTooltip(`Drop-off · ${esc(d.addr || '')} (${d.n})`, { direction: 'top' });
    });
    // Zoom to the driver's own working area rather than the whole emirate:
    // frame every marker with a fixed pixel margin, capped so a driver who only
    // ever works one street doesn't end up looking at rooftops.
    fitTo(map, pts, { maxZoom: 14 });
    if (!pts.length) {
      mapP.body.append(note('No positioned trips for this driver in this window. Uber supplies pickup coordinates; the FMS telematics feed does not, so a telematics-only driver has nothing to plot.'));
    }
    mapP.body.append(el('div', 'legend', `
      <span><i style="background:var(--s1)"></i>pickups</span>
      <span><i style="background:var(--s3)"></i>drop-offs</span>
      <span><i style="border:1.5px dashed var(--s5);background:none"></i>waiting spots</span>
      ${pts.length ? `<span>${terr.pickups.length} pickup clusters · ${terr.idle.length} waiting spots</span>` : ''}`));
  }

  areas.body.innerHTML = '';
  areas.body.append(tableFrom(terr.areas.slice(0, 12), [
    { label: 'Area', key: 'area' },
    { label: 'Pickups', key: 'n', num: true },
    { label: 'Avg trip', key: 'avg_km', num: true, render: (r) => (r.avg_km ? `${fmt(r.avg_km, 1)} km` : '—') },
    { label: 'Avg fare', key: 'avg_fare', num: true, render: (r) => (r.avg_fare ? money(r.avg_fare) : '—') },
  ], { compact: true }));

  dmix.body.innerHTML = '';
  hbars(dmix.body, mix.distance, { label: 'label', value: 'n', seq: true, valueFmt: (v) => `${fmt(v)} trips` });
}

/* ── tab: earnings ───────────────────────────────────────────────────────── */
async function tabEarnings(root, id) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const comp = panel('Earnings components', 'As the platform breaks them down — fares, tips, tolls, adjustments'); g.append(comp.panel);
  const pay = panel('How riders paid', 'Card vs cash changes what actually reaches the fleet'); g.append(pay.panel);
  const line = panel('Revenue by day', 'Booked fare value from the trip record'); root.append(line.panel);
  const per = panel('Platform payout periods', 'The statements each platform published for this driver'); root.append(per.panel);
  [comp.body, pay.body, line.body, per.body].forEach(loading);

  const [e, mix, daily, k] = await Promise.all([
    qAll('/api/driver/earnings', { id }), qAll('/api/driver/mix', { id }),
    qAll('/api/driver/daily', { id }), qAll('/api/driver/kpis', { id }),
  ]);

  const cash = mix.payment.find((p) => /cash/i.test(p.label));
  kpiHost.replaceWith(kpiRow([
    { label: 'Booked revenue', value: money(k.revenue), sub: `${fmt(k.trips)} trips` },
    { label: 'Average fare', value: money(k.avg_fare, 'AED', 2), sub: k.avg_km ? `over ${fmt(k.avg_km, 1)} km` : null },
    { label: 'Platform earnings', value: money(k.reported_earnings), sub: 'as the platform reported it' },
    { label: 'Tips', value: money(e.tips), sub: e.tip_pct != null ? `${pct(e.tip_pct, 1)} of net fare` : 'no tip data yet',
      tone: e.tip_pct == null ? null : e.tip_pct >= 3 ? 'good' : e.tip_pct >= 1 ? 'warn' : null },
    { label: 'Cash collected', value: money(k.cash_earnings ?? (cash ? cash.revenue : null)),
      sub: cash ? `${fmt(cash.n)} cash trips` : 'card only' },
    { label: 'Revenue per km', value: k.km > 0 && k.revenue ? money(k.revenue / k.km, 'AED', 2) : '—', sub: 'booked fare ÷ distance' },
  ]));

  comp.body.innerHTML = '';
  if (!e.components.length) {
    comp.body.append(note('No earnings breakdown for this driver yet. Uber publishes components per payout period; they appear once a period covering this window has been collected.'));
  } else {
    // Components come signed: fares and tips add, cash already collected and
    // fees subtract. Drawing every bar the same way would present a deduction
    // as income, so the sign decides the colour and stays in the label.
    const max = Math.max(...e.components.map((c) => Math.abs(+c.amount))) || 1;
    const rows = el('div', 'hbars');
    e.components.forEach((c, i) => {
      const v = +c.amount, neg = v < 0;
      const r = el('div', 'hb');
      r.innerHTML = `<div class="k" title="${esc(c.parent || '')}">${esc(c.category.replace(/_/g, ' '))}</div>
        <div class="track"><div class="fill" style="width:${(Math.abs(v) / max * 100).toFixed(1)}%;
          background:var(${neg ? '--s2' : i === 0 ? '--b600' : '--b400'});animation-delay:${i * 45}ms"></div></div>
        <div class="v num">${neg ? '−' : ''}${money(Math.abs(v), c.currency)}</div>`;
      r.title = `${c.category.replace(/_/g, ' ')} — ${c.parent || 'component'} — ${neg ? 'deducted from' : 'added to'} the payout`;
      rows.append(r);
    });
    comp.body.append(rows);
    comp.body.append(el('div', 'legend', `
      <span><i style="background:var(--b500)"></i>added to the payout</span>
      <span><i style="background:var(--s2)"></i>deducted (cash already taken, fees)</span>`));
  }

  pay.body.innerHTML = '';
  donut(pay.body, mix.payment.slice(0, 6));

  line.body.innerHTML = '';
  const withRev = daily.filter((d) => d.revenue != null && +d.revenue > 0);
  if (!withRev.length) line.body.append(note('No fare values on this driver’s trips in this window — the telematics and hotel feeds carry fares, the Uber trip export does not.'));
  else areaChart(line.body, withRev.map((d) => ({ label: dayStr(d.day), v: +d.revenue })), { x: 'label', y: 'v', valueFmt: (v) => money(v) });

  per.body.innerHTML = '';
  per.body.append(tableFrom(e.periods, [
    { label: 'Platform', key: 'platform' },
    { label: 'Period', key: '_p', render: (r) => `${dayStr(r.period_start)} → ${dayStr(r.period_end)}` },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Online', key: 'hours_online', num: true, render: (r) => (r.hours_online ? `${fmt(r.hours_online, 1)} h` : '—') },
    { label: 'On trip', key: 'hours_on_trip', num: true, render: (r) => (r.hours_on_trip ? `${fmt(r.hours_on_trip, 1)} h` : '—') },
    { label: 'Accept', key: 'acceptance_rate', num: true, render: (r) => (r.acceptance_rate != null ? pct(r.acceptance_rate * 100) : '—') },
    { label: 'Earnings', key: 'earnings', num: true, render: (r) => money(r.earnings) },
    { label: 'Cash', key: 'cash_earnings', num: true, render: (r) => money(r.cash_earnings) },
    { label: 'Rating', key: 'rating', num: true, render: (r) => (r.rating ? fmt(r.rating, 2) : '—') },
  ]));
}

/* ── tab: quality ────────────────────────────────────────────────────────── */
async function tabQuality(root, id) {
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid g2'); root.append(g);
  const cx = panel('Non-completed trips', 'Who cancelled, and how often'); g.append(cx.panel);
  const ev = panel('Harsh-driving events', 'From the telematics layer, attributed on days this driver held the vehicle'); g.append(ev.panel);
  const line = panel('Cancellations by day', 'One bar per day — hover for the day’s total'); root.append(line.panel);
  [cx.body, ev.body, line.body].forEach(loading);

  const [qy, k] = await Promise.all([qAll('/api/driver/quality', { id }), qAll('/api/driver/kpis', { id })]);
  const totalAlerts = qy.alerts.reduce((a, r) => a + r.n, 0);

  kpiHost.replaceWith(kpiRow([
    { label: 'Completion', value: pct(k.completion_pct, 1), tone: k.completion_pct >= 95 ? 'good' : k.completion_pct >= 85 ? 'warn' : 'critical' },
    { label: 'Cancellation', value: pct(k.cancel_pct, 1), sub: 'of all requested trips', tone: k.cancel_pct <= 5 ? 'good' : k.cancel_pct <= 12 ? 'warn' : 'critical' },
    { label: 'Acceptance', value: k.acceptance_rate != null ? pct(k.acceptance_rate * 100) : '—', sub: 'platform-reported' },
    { label: 'Rating', value: k.rating ? fmt(k.rating, 2) : '—', sub: 'platform-reported' },
    { label: 'Harsh events', value: fmt(totalAlerts), sub: qy.alert_km ? `over ${fmt(qy.alert_km)} km` : 'no matched distance' },
    { label: 'Per 100 km', value: qy.alerts_per_100km != null ? fmt(qy.alerts_per_100km, 1) : '—', sub: 'comparable across drivers',
      tone: qy.alerts_per_100km == null ? null : qy.alerts_per_100km <= 5 ? 'good' : qy.alerts_per_100km <= 15 ? 'warn' : 'critical' },
  ]));

  cx.body.innerHTML = '';
  if (!qy.cancels.length) cx.body.append(note('Every trip in this window completed.'));
  else hbars(cx.body, qy.cancels.map((c) => ({ label: c.status.replace(/_/g, ' '), n: c.n })), { label: 'label', value: 'n', seq: true });

  ev.body.innerHTML = '';
  if (!qy.alerts.length) ev.body.append(note('No harsh-driving events on the vehicles this driver held. Attribution needs both a telematics alert and a custody record for the same day, so a gap in either shows as nothing here.'));
  else ev.body.append(tableFrom(qy.alerts, [
    { label: 'Event', key: 'alert_type' }, { label: 'Count', key: 'n', num: true },
    { label: 'Most recent', key: 'latest', render: (r) => dtStr(r.latest) },
  ]));

  line.body.innerHTML = '';
  const cd = qy.cancel_daily.filter((d) => d.trips > 0);
  if (!cd.some((d) => d.cancelled > 0)) {
    line.body.append(note(`No cancellations on any of the ${cd.length} days this driver worked in this window.`));
  } else {
    barChart(line.body, cd.map((d) => ({
      label: `${dayStr(d.day)} · ${d.cancelled} of ${d.trips}`, cancelled: d.cancelled,
    })), { x: 'label', y: 'cancelled', color: '--s2', valueFmt: (v) => fmt(v) });
    const tot = cd.reduce((a, d) => a + d.trips, 0), cx = cd.reduce((a, d) => a + d.cancelled, 0);
    line.body.append(el('p', 'cap', `${cx} cancelled out of ${tot} requested across ${cd.length} working days.`));
  }
}

/* ── tab: trips ──────────────────────────────────────────────────────────── */
async function tabTrips(root, id) {
  const p = panel('Trip records', 'The underlying rows, newest first — every platform this driver appears on');
  root.append(p.panel); loading(p.body);
  const rows = await qAll('/api/driver/trips', { id, limit: 500 });
  p.body.innerHTML = '';
  if (!rows.length) return empty(p.body);
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="tq" type="search" placeholder="Filter by address, plate, status or product…">
    <span class="cap" id="tn">${rows.length} trips</span>`;
  p.body.append(bar);
  const host = el('div'); p.body.append(host);
  const cols = [
    { label: 'Requested', key: 'requested_at', render: (r) => dtStr(r.requested_at) },
    { label: 'Platform', key: 'platform' },
    { label: 'Plate', key: 'plate', render: (r) => (r.plate ? `<a class="lnk" href="${href('vehicle', r.plate)}">${esc(r.plate)}</a>` : '—') },
    { label: 'From', key: 'pickup_addr' },
    { label: 'To', key: 'dropoff_addr' },
    { label: 'Km', key: 'distance_km', num: true, render: (r) => fmt(r.distance_km, 1) },
    { label: 'Minutes', key: 'duration_s', num: true, render: (r) => (r.duration_s ? fmt(r.duration_s / 60) : '—') },
    { label: 'Product', key: 'product' },
    { label: 'Pay', key: 'payment_type' },
    { label: 'Status', key: 'status', render: (r) => pill(r.status || '—', /cancel/i.test(r.status || '') ? 'warn' : 'ok') },
    { label: 'Fare', key: 'price', num: true, render: (r) => (r.price ? money(r.price, r.currency) : '—') },
  ];
  const draw = (list) => { host.innerHTML = ''; host.append(tableFrom(list.slice(0, 400), cols)); };
  draw(rows);
  bar.querySelector('#tq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(t)) : rows;
    bar.querySelector('#tn').textContent = `${list.length} trips`;
    draw(list);
  };
}

const TABS = { overview: tabOverview, activity: tabActivity, territory: tabTerritory,
  earnings: tabEarnings, quality: tabQuality, trips: tabTrips };

/* ── page shell ──────────────────────────────────────────────────────────── */
export async function renderDriver(root, id, tab = 'overview') {
  const head = el('div'); root.append(head); loading(head);
  const body = el('div'); root.append(body);

  let prof;
  try { prof = await qAll('/api/driver/profile', { id }); }
  catch (e) {
    head.innerHTML = `<div class="empty"><b>No such driver</b>Nothing in the record matches this id.
      <a class="lnk" href="${href('drivers')}">Back to all drivers</a></div>`;
    return;
  }
  head.innerHTML = '';
  head.append(identityCard(prof));
  head.append(tabBar(DRIVER_TABS, tab, (t) => href('driver', id, t === 'overview' ? null : t)));
  if ((prof.accounts || []).length > 1) {
    head.append(el('p', 'cap', `This person appears on ${prof.accounts.length} platform accounts (${prof.accounts.map((a) => `${a.platform}: ${a.trips} trips`).join(', ')}). Everything below is the combined picture.`));
  }

  const fn = TABS[tab] || tabOverview;
  await fn(body, id, prof);
  return prof;
}

/* ── the directory that links into the pages above ───────────────────────── */
export async function renderDriverDirectory(root) {
  const bar = el('div', 'toolbar');
  bar.innerHTML = `<input id="dq" type="search" placeholder="Search drivers by name, plate or platform…">
    <span class="cap" id="dn"></span>`;
  root.append(bar);
  const grid = el('div', 'dircards'); root.append(grid);
  const tblP = panel('All drivers', 'Sorted by trips in this window — click any row for the full detail'); root.append(tblP.panel);
  loading(tblP.body); loading(grid);

  const rows = await qAll('/api/drivers/directory');
  bar.querySelector('#dn').textContent = `${rows.length} drivers`;

  // the top few as cards, because a leaderboard is read as a ranking
  grid.innerHTML = '';
  rows.slice(0, 6).forEach((r, i) => {
    const c = el('a', 'dircard');
    c.href = href('driver', r.driver_ext_id);
    const initials = (r.driver_name || '?').split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
    c.innerHTML = `
      <div class="rank">${i + 1}</div>
      <div class="av sm">${esc(initials)}</div>
      <div class="dc-meta">
        <b>${esc(r.driver_name)}</b>
        <div class="cap">${(r.platforms || []).join(' · ')}${r.plate ? ' · ' + esc(r.plate) : ''}</div>
      </div>
      <div class="dc-n"><span class="num">${fmt(r.trips)}</span><small>trips</small></div>`;
    grid.append(c);
  });

  const cols = [
    { label: '#', key: '_i', render: (r) => String(rows.indexOf(r) + 1) },
    { label: 'Driver', key: 'driver_name', render: (r) => `<a class="lnk" href="${href('driver', r.driver_ext_id)}">${esc(r.driver_name)}</a>` },
    { label: 'Platforms', key: '_p', render: (r) => (r.platforms || []).map((p) => pill(p, 'plat')).join('') },
    { label: 'Usual vehicle', key: 'plate' },
    { label: 'Trips', key: 'trips', num: true, render: (r) => fmt(r.trips) },
    { label: 'Days', key: 'days', num: true },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => (r.revenue ? money(r.revenue) : '—') },
    { label: 'Completion', key: 'completion_pct', num: true, render: (r) => (r.completion_pct != null ? pct(r.completion_pct) : '—') },
    { label: 'Last trip', key: 'last_trip', render: (r) => dayStr(r.last_trip) },
    { label: 'Licence', key: '_l', render: (r) => (r.licence_days_left == null ? '—'
      : pill(r.licence_days_left < 0 ? `expired` : `${r.licence_days_left}d`, r.licence_days_left < 0 ? 'bad' : r.licence_days_left < 30 ? 'warn' : 'ok')) },
  ];
  const draw = (list) => {
    tblP.body.innerHTML = '';
    const t = tableFrom(list, cols);
    t.querySelectorAll('tbody tr').forEach((tr, i) => {
      tr.style.cursor = 'pointer';
      tr.onclick = (ev) => { if (ev.target.tagName !== 'A') location.hash = href('driver', list[i].driver_ext_id); };
    });
    tblP.body.append(t);
  };
  draw(rows);
  bar.querySelector('#dq').oninput = (e) => {
    const t = e.target.value.trim().toLowerCase();
    const list = t ? rows.filter((r) => `${r.driver_name} ${r.plate} ${(r.platforms || []).join(' ')}`.toLowerCase().includes(t)) : rows;
    bar.querySelector('#dn').textContent = `${list.length} drivers`;
    draw(list);
  };
  return rows;
}
