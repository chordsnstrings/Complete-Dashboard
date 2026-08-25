/* Map & replay — where every vehicle is now, and where it went on a given day.
   Tiles come from OpenStreetMap; positions come from the CABMAN 5-minute poll and
   FMS live feed already in telemetry_snapshot.

   The honest bit: a 5-minute sample is a sequence of sightings, not a traced route.
   We draw straight lines between consecutive fixes and break the line wherever the
   gap is long enough that a straight line would be a lie (handled server-side in
   /api/map/journey), so the map never invents a road the car may not have taken. */
import { timeStr } from './ui.js';

const OSM = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const DUBAI = [25.2048, 55.2708];

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

/* Leaflet, fetched the first time a map is actually drawn.
   ─────────────────────────────────────────────────────────────────────────
   It was loaded by index.html on every page: 44kb of script and 4kb of CSS
   downloaded, parsed and executed on the overview, the roster, the settlement
   page and every other view with no map on it — which is most of them. Three
   views draw a map.

   Loaded here instead, once, and shared: the promise is cached so two panels on
   one page do not each fetch it, and a failure is not cached, so a map that
   failed to load because the connection dropped can be retried by opening the
   page again.

   Still vendored locally rather than from a CDN — the reason for that has not
   changed, only when it is fetched. */
let leafletReady = null;
export function ensureLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = '/vendor/leaflet.css';
    document.head.append(link);
    const js = document.createElement('script');
    js.src = '/vendor/leaflet.js';
    js.onload = () => {
      if (!window.L) return reject(new Error('leaflet loaded but L is undefined'));
      // Leaflet works out where its marker images live by reading a background-image
      // off a probe element styled by leaflet.css. Injected together, the script can
      // win the race against the stylesheet and the probe comes back empty, which
      // gives a broken-image marker for the first fix. Stating the path removes the
      // race entirely — we know where we put the files.
      window.L.Icon.Default.imagePath = '/vendor/images/';
      resolve(window.L);
    };
    js.onerror = () => reject(new Error('leaflet failed to load'));
    document.head.append(js);
  }).catch((e) => {
    // Not cached: a dropped connection should not disable maps for the session.
    leafletReady = null;
    throw e;
  });
  return leafletReady;
}

export async function makeMap(node, { zoom = 10 } = {}) {
  await ensureLeaflet();
  // zoomSnap:0 is what actually makes "fit the points" fit. By default Leaflet
  // rounds the fitted zoom DOWN to a whole number, so a spread needing z=11.9
  // renders at z=11 and the markers sit in the middle of a half-empty panel.
  // Fractional zoom lets fitBounds use the level the data really needs; the
  // +/- buttons then step by a half so they still feel like zoom controls.
  const map = L.map(node, {
    zoomControl: true, attributionControl: true, zoomSnap: 0, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
  }).setView(DUBAI, zoom);
  L.tileLayer(OSM, { attribution: OSM_ATTR, maxZoom: 19 }).addTo(map);

  // Leaflet sizes itself — and its SVG overlay — from the container at creation time.
  // We build the map inside a panel that is still being laid out, so without this the
  // SVG pane ends up 0×0: polylines exist in the DOM with correct coordinates but are
  // clipped to nothing, which looks exactly like "the map is broken". A single
  // setTimeout is a race; observing the container is not.
  const nudge = () => {
    if (!node.clientWidth || !node.clientHeight) return;
    map.invalidateSize({ animate: false });
    // Re-frame after the size settles: a fit computed against a 0-height panel
    // leaves the markers clustered in the middle at the wrong zoom.
    if (map._fitAgain) map._fitAgain();
  };
  requestAnimationFrame(nudge);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(nudge);
    ro.observe(node);
    map.once('unload', () => ro.disconnect());
  }
  setTimeout(nudge, 250);      // belt and braces for slow font/layout settles
  return map;
}


/* Frame a set of points as tightly as the container allows.
   `fitBounds(bounds.pad(n))` was wrong twice over: `pad` inflates the bounds in
   *degrees*, so the framing loosened as the spread grew, and a fit computed
   before the panel finished laying out picked a zoom for the wrong container
   size. This keeps the padding in pixels, caps the zoom so a lone point doesn't
   land on a rooftop, and re-fits whenever the container is resized. */
export function fitTo(map, points, { maxZoom = 15, padding = [28, 28] } = {}) {
  /* A tracker reporting 0,0 has no satellite lock; it is not sitting in the
     Gulf of Guinea. One such point in a Dubai fleet stretches the bounds
     across two continents and renders every real position as a single pixel —
     which looks exactly like a map that failed to load. Excluded from the
     FRAMING here, where every map in this product passes: a caller that has
     already dropped the bad fix loses nothing, and one that has not keeps a
     usable map. */
  const pts = (points || []).filter((p) => p && p[0] != null && p[1] != null &&
    isFinite(p[0]) && isFinite(p[1]) && !(Math.abs(p[0]) < 0.5 && Math.abs(p[1]) < 0.5));
  if (!pts.length) { map.setView(DUBAI, 10); return; }
  const b = L.latLngBounds(pts);
  const apply = () => {
    if (!map.getContainer().clientWidth) return;
    // A single point (or several at the same spot) has no extent to fit, so
    // fitBounds would zoom to maximum. Centre it at a readable scale instead.
    if (b.getNorthEast().equals(b.getSouthWest())) map.setView(b.getCenter(), Math.min(maxZoom, 14));
    else map.fitBounds(b, { padding, maxZoom, animate: false });
  };
  apply();
  map._fitAgain = apply;                 // re-run once the container settles
  requestAnimationFrame(apply);
  setTimeout(apply, 300);
}

/* Live fleet: one dot per vehicle, coloured by what it is doing. */
export function renderLive(map, rows, onPick) {
  const layer = L.layerGroup().addTo(map);
  const pts = [];
  /* Two vehicles at the same rank round to the same pixel, and the one
     underneath cannot be clicked at all — a click on the fourth marker timed
     out because a different vehicle's shape was intercepting the pointer.
     Co-located markers are pushed onto a small deterministic spiral: the same
     plate lands in the same place on every load, and every one of them can be
     reached. A cluster plugin would be better and we do not vendor one. */
  const seen = new Map();
  const nudge = (lat, lng) => {
    const key = `${(+lat).toFixed(4)},${(+lng).toFixed(4)}`;
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    if (!n) return [+lat, +lng];
    const a = n * 2.399963;                          // golden angle, so the ring fills evenly
    const rad = 0.00016 * Math.sqrt(n);              // ≈18m per step at this latitude
    return [+lat + rad * Math.cos(a), +lng + rad * Math.sin(a)];
  };
  for (const r of rows) {
    if (r.lat == null || r.lng == null) continue;
    // 0,0 is a tracker with no satellite lock, not a vehicle in the Atlantic.
    if (Math.abs(+r.lat) < 0.5 && Math.abs(+r.lng) < 0.5) continue;
    const seat = r.seat_occupied;
    const seatUnknown = seat === null || seat === undefined;
    const engaged = seat === true || /engag/i.test(r.status || '');
    const moving = Number(r.speed) > 3;
    /* Four states, not three. "Moving, empty" was asserted for every vehicle
       whose feed carries no seat sensor — 82 of 130 — which is a measurement
       claim about hardware that does not exist. renderJourney has drawn the
       unknown case separately for a while; this had not caught up. */
    const colour = r.stale ? css('--ink-3')
      : engaged ? css('--s3')
        : moving ? (seatUnknown ? css('--b300') : css('--s1'))
          : css('--s5');
    const at = nudge(r.lat, r.lng);
    const m = L.circleMarker(at, {
      radius: engaged ? 7 : 6, color: '#fff', weight: 1.5,
      fillColor: colour, fillOpacity: r.stale ? 0.45 : 0.95,
    }).addTo(layer);
    m.bindTooltip(
      `<b>${r.plate}</b>${r.current_driver ? '<br>' + r.current_driver : ''}` +
      `<br>${r.status || '—'} · ${r.speed != null ? r.speed + ' km/h' : 'no speed'}` +
      `<br>${seatUnknown && !/engag/i.test(r.status || '') ? 'seat sensor not reported by this feed'
        : engaged ? 'passenger on board' : 'seat sensor reports empty'}`
      + `${r.stale ? `<br><i>last fix ${r.fix_age_min != null ? `${r.fix_age_min} min ago` : 'is stale'}</i>` : ''}`,
      // Sticky, so a marker under the pointer keeps its label while you aim.
      { direction: 'top', sticky: true });
    if (onPick) m.on('click', () => onPick(r));
    pts.push(at);
  }
  fitTo(map, pts, { maxZoom: 14 });
  return layer;
}

/* One vehicle, one day: draw each segment, colour by whether a passenger was aboard. */
export function renderJourney(map, journey) {
  const layer = L.layerGroup().addTo(map);
  const all = [];
  (journey.segments || []).forEach((seg) => {
    const pts = seg.points.filter((p) => p.lat != null).map((p) => [p.lat, p.lng]);
    if (pts.length < 2) {
      if (pts.length === 1) L.circleMarker(pts[0], { radius: 4, color: css('--ink-3'), fillOpacity: .7 }).addTo(layer);
      all.push(...pts); return;
    }
    // a segment can change occupancy mid-way; split so colour stays truthful
    let run = [seg.points[0]];
    const flush = () => {
      if (run.length < 2) { run = [run[run.length - 1]]; return; }
      /* Tri-state: true, false, or null for "this feed does not report it".
         Coercing null to false drew the whole trail dashed in the running-empty
         colour with a "Running empty" tooltip — a claim, not an absence. */
      const occ = run[0].occupied;
      const occupied = occ === true, unknown = occ === null || occ === undefined;
      L.polyline(run.map((p) => [p.lat, p.lng]), {
        color: unknown ? css('--ink-3') : occupied ? css('--s3') : css('--s1'),
        weight: occupied ? 4 : 3, opacity: unknown ? .5 : occupied ? .95 : .65,
        dashArray: occupied ? null : unknown ? '2,4' : '5,6',
      }).addTo(layer).bindTooltip(
        `${unknown ? 'Occupancy not reported by this feed' : occupied ? 'Passenger on board' : 'Running empty'}<br>` +
        `${timeStr(run[0].t)} → ${timeStr(run[run.length - 1].t)}`,
        { sticky: true });
      run = [run[run.length - 1]];
    };
    for (let i = 1; i < seg.points.length; i++) {
      const p = seg.points[i];
      // A change BETWEEN the three states breaks the run, including into null.
      if (p.occupied !== run[0].occupied) { run.push(p); flush(); }
      run.push(p);
    }
    flush();
    all.push(...pts);
  });

  // start and end markers
  const first = (journey.segments || []).flatMap((s) => s.points)[0];
  const pointsFlat = (journey.segments || []).flatMap((s) => s.points);
  const last = pointsFlat[pointsFlat.length - 1];
  if (first) L.marker([first.lat, first.lng], { title: 'first fix' }).addTo(layer)
    .bindTooltip(`Start ${timeStr(first.t)}`, { direction: 'top' });
  if (last && last !== first) L.circleMarker([last.lat, last.lng], {
    radius: 8, color: css('--s2'), weight: 3, fillColor: css('--s2'), fillOpacity: .35,
  }).addTo(layer).bindTooltip(`Last fix ${timeStr(last.t)}`, { direction: 'top' });

  fitTo(map, all, { maxZoom: 16 });
  return layer;
}
