/* Corridors — where the work starts, where it ends, and what that implies.
   ──────────────────────────────────────────────────────────────────────────
   Four channels return a formatted address for pickup and drop-off and nothing
   was reading any of them. Rolled up to the community, they answer the one
   dispatch question this fleet could not previously ask from its own data:
   given a car free at 07:00, where should it be sitting?

   The area is PARSED out of the address text — providers return a string, not a
   place id — so this is evidence of a pattern, not a geofence. */

import { hbars, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, money, pct } from './ui.js';
import { q } from './data.js';

/* A morning share plotted as a plain bar is unreadable when every area sits
   between 35% and 53%: the bar scales to the largest value, so a five-point
   spread fills the panel and looks like a landslide. Drawn against a fixed
   centre line, the same numbers show what they actually are — a fleet whose
   areas are mostly balanced, with two that are not. */
function divergingWave(host, rows) {
  host.innerHTML = '';
  const wrap = el('div', 'wave');
  rows.forEach((r) => {
    const tot = r.morning + r.evening;
    const am = (r.morning / tot) * 100;
    const off = am - 50;                       // -50 .. +50, negative = evening-heavy
    const w = Math.abs(off);
    const row = el('div', 'wv');
    row.innerHTML = `
      <div class="k" title="${esc(r.area)}">${esc(r.area)}</div>
      <div class="wv-track">
        <span class="wv-mid"></span>
        <i class="${off >= 0 ? 'am' : 'pm'}" style="width:${w}%;${off >= 0 ? 'right' : 'left'}:50%"></i>
      </div>
      <div class="v num">${fmt(r.morning)} <span class="sep">/</span> ${fmt(r.evening)}</div>`;
    row.title = `${r.area} — ${fmt(r.morning)} trips 05:00-09:00, ${fmt(r.evening)} trips 16:00-21:00`;
    wrap.append(row);
  });
  host.append(wrap);
  host.append(el('p', 'cap', 'Numbers are morning / evening trip counts. The bar is the distance from an even split.'));
}

export async function renderCorridors(root) {
  root.innerHTML = '';
  loading(root);
  const c = await q('/api/geo/corridors');
  root.innerHTML = '';
  if (!c.corridors.length && !c.origins.length) {
    return empty(root, 'No trip in this range carries an address');
  }
  const named = c.origins.filter((o) => o.area !== '(unrecorded)');
  const totalOrigin = named.reduce((a, o) => a + o.trips, 0);
  /* The first two were lengths of lists the endpoint caps at 60 and 120 rows.
     Both read as fleet facts and both silently become the cap once the fleet
     works more corridors than that. Counted in the database now; the share
     figures below are still over the visible rows and say so. */
  const t = c.totals || {};
  root.append(kpiRow([
    { label: 'Distinct pickup areas', value: fmt(t.origins_all ?? named.length),
      sub: c.origins_truncated ? `${fmt(named.length)} shown below` : 'every one shown below' },
    { label: 'Corridors seen 3+ times', value: fmt(t.corridors_3plus ?? c.corridors.length),
      sub: t.corridors_all ? `of ${fmt(t.corridors_all)} distinct origin–destination pairs` : null },
    { label: 'Busiest pickup area', value: named[0]?.area || '—',
      sub: named[0] ? `${pct((named[0].trips / totalOrigin) * 100, 1)} of the addressed pickups shown` : null },
    { label: 'Top 5 areas', value: pct((named.slice(0, 5).reduce((a, o) => a + o.trips, 0) / totalOrigin) * 100, 1),
      sub: c.origins_truncated
        ? `share of the ${fmt(named.length)} areas shown, not of every area`
        : 'share of all addressed pickups' },
  ]));

  const g = el('div', 'grid'); root.append(g);
  const { panel: p1, body: b1 } = panel('Where jobs start', 'Pickup area, all channels combined.');
  hbars(b1, named.slice(0, 14).map((o) => ({ label: o.area, n: o.trips })));
  g.append(p1);
  const { panel: p2, body: b2 } = panel('Morning wave or evening wave',
    'Each area against the 50/50 line. A bar reaching left is an area that mostly produces work before 09:00; '
    + 'right is an area that mostly produces it after 16:00.');
  const waves = named.map((o) => ({ area: o.area, morning: o.morning, evening: o.evening }))
    .filter((o) => o.morning + o.evening >= 3).slice(0, 14);
  if (waves.length) divergingWave(b2, waves);
  else empty(b2, 'Not enough addressed trips in either wave');
  g.append(p2);

  const { panel: p3, body: b3 } = panel('Corridors', 'Pickup area → drop-off area, seen at least three times.');
  b3.append(tableFrom(c.corridors, [
    { label: 'From', key: 'from_area' },
    { label: 'To', key: 'to_area' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Avg km', key: 'avg_km', num: true, render: (r) => fmt(r.avg_km, 1) },
    { label: 'Avg minutes', key: 'avg_min', num: true, render: (r) => fmt(r.avg_min, 0) },
    { label: 'Avg fare', key: 'avg_fare', num: true, render: (r) => (r.priced ? money(r.avg_fare, 'AED', 2) : '—') },
    { label: 'Priced', key: 'priced', num: true, render: (r) => `${fmt(r.priced)} of ${fmt(r.trips)}` },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).join(', ')) },
  ]));
  root.append(p3);
  root.append(note(`${c.note} Fares are blank on corridors that are mostly Uber, because that export `
    + 'carries no fare column — the trip count on those rows is real and the money is simply not there '
    + 'to report.'));
}
