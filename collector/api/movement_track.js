/* A driver's movement, granular (2026-11-24, the operator: "in territory
   let's focus on granular view. we need to see territory where they move
   around, where they park everything").
   ──────────────────────────────────────────────────────────────────────────
   The range view (api/driver_routes.js /api/driver/movement) summed each day
   into half-kilometre cells, which says where the time went but not where the
   car actually drove or stood. This module holds the three pure readings the
   granular view is built from, shared by the rollup that keeps them
   (src/movement_rollup.js) and the route that reads them back
   (/api/driver/movement/track), so the two cannot disagree:

     segmentRows   the day page's own log (api/day_movement.js
                   movementSegments: stops, drives, silences, in order) as
                   rows, each stop split by what the driver was doing while
                   the car stood — waiting online, on a job, or with no
                   working status;
     routePieces   the car's path between fixes inside the driver's hours, cut
                   wherever the state changes (a passenger aboard, moving
                   empty, moving with the seat unreported) and wherever the
                   tracker went silent — a line is never drawn across a hole;
     parkingSpots  the stops over a range, grouped where they fall within
                   STAY_RADIUS_KM of each other: how often, how long, what the
                   driver was doing there, and how many nights.

   Positions are never stored twice: the rollup keeps which car was the
   driver's and when (driver_move_window), and the route reads the tracker's
   own fixes for those hours. */
import { intervalState } from './day_movement.js';
import { km } from './where_routes.js';
import { STAY_RADIUS_KM } from './whereabouts.js';

/* A stop that covers this much of 00:00–05:00 Dubai is a night parked. */
export const NIGHT_END_MIN = 300;
export const NIGHT_MIN = 60;

const r1 = (x) => (x == null ? null : Math.round(Number(x) * 10) / 10);

/** The day's segments as rows, numbered in order. `status` is the
    minute-by-minute reading of what the driver was doing (minuteStatus in
    src/movement_rollup.js): 'ontrip', 'online' or null. Pure. */
export function segmentRows(segments = [], status = []) {
  return segments.map((g, seq) => {
    let wait = 0; let job = 0; let off = 0;
    if (g.kind === 'stop') {
      for (let m = Math.max(0, g.s); m < Math.min(1440, Math.max(g.e, g.s + 1)); m += 1) {
        const st = status[m];
        if (st === 'ontrip') job += 1; else if (st === 'online') wait += 1; else off += 1;
      }
    }
    return {
      seq, kind: g.kind, s_min: g.s, e_min: g.e, minutes: Math.max(0, Math.round(g.minutes ?? (g.e - g.s))),
      plate: g.plate || null, source: g.source || null,
      lat: g.lat ?? null, lng: g.lng ?? null, area: g.kind === 'drive' ? (g.from_area || null) : (g.area || g.from_area || null),
      to_lat: g.to_lat ?? null, to_lng: g.to_lng ?? null, to_area: g.to_area || null,
      km: g.kind === 'drive' ? r1(g.km) : g.kind === 'silence' ? r1(g.moved_km) : null,
      km_with_passenger: g.kind === 'drive' ? r1(g.km_with_passenger) : null,
      passenger: g.passenger || null, passenger_min: g.passenger_min ?? null,
      wait_min: g.kind === 'stop' ? wait : null, ontrip_min: g.kind === 'stop' ? job : null, offline_min: g.kind === 'stop' ? off : null,
      /* A stop held across a quiet tracker (CABMAN's hourly heartbeat, FMS
         asleep) is inferred from two fixes at one place, and says so. */
      inferred: g.kind === 'stop' && (g.longest_silence_min ?? 0) > 20,
    };
  });
}

/** The path, as pieces of one state each: [{ state, seat, plate, s, e,
    points: [[lat, lng], …] }]. `fixes` are one day's fixes inside the
    driver's hours, each with plate, source, at, m and (optionally) w, the
    custody window it sits in. A stop is not a piece (the stops layer draws
    it); a silence ends one. Pure. */
export function routePieces(fixes = []) {
  const byCar = new Map();
  for (const f of fixes) {
    const k = `${f.plate}|${f.source}|${f.w ?? ''}`;
    if (!byCar.has(k)) byCar.set(k, []);
    byCar.get(k).push(f);
  }
  const pieces = [];
  for (const fs of byCar.values()) {
    fs.sort((a, b) => new Date(a.at) - new Date(b.at));
    let cur = null;
    for (let i = 1; i < fs.length; i += 1) {
      const a = fs[i - 1]; const b = fs[i];
      const iv = intervalState(a, b);
      const state = !iv || iv.state === 'idle' ? null
        : iv.state === 'engaged' ? 'passenger' : iv.seat === false ? 'empty' : 'seat_unknown';
      if (!state) { cur = null; continue; }
      if (cur && cur.state === state && cur.last === a) {
        cur.points.push([b.lat, b.lng]); cur.e = b.m; cur.last = b; cur.km += km(a, b);
      } else {
        cur = { state, plate: a.plate, s: a.m, e: b.m, points: [[a.lat, a.lng], [b.lat, b.lng]], last: b, km: km(a, b) };
        pieces.push(cur);
      }
    }
  }
  return pieces.map(({ last, km: k, ...p }) => ({ ...p, km: r1(k) }));
}

/** Stops over a range grouped into the places the driver parks. `stops` are
    segment rows of kind 'stop' with day, lat, lng, minutes, s_min, e_min and
    the wait / on-job / offline split. Greedy on the longest stops first, so
    a spot is centred where the car stood longest. Pure. */
export function parkingSpots(stops = [], { radiusKm = STAY_RADIUS_KM, minMinutes = 10 } = {}) {
  const spots = [];
  const sorted = stops.filter((x) => x.lat != null && x.lng != null && x.minutes >= minMinutes)
    .sort((a, b) => b.minutes - a.minutes);
  for (const st of sorted) {
    const hit = spots.find((sp) => km(sp, st) <= radiusKm);
    const sp = hit || (spots[spots.push({ lat: st.lat, lng: st.lng, stops: [] }) - 1]);
    sp.stops.push(st);
  }
  return spots.map((sp) => {
    const mins = sp.stops.reduce((a, x) => a + x.minutes, 0);
    const sum = (k) => sp.stops.reduce((a, x) => a + (x[k] || 0), 0);
    const areas = new Map();
    for (const x of sp.stops) if (x.area) areas.set(x.area, (areas.get(x.area) || 0) + x.minutes);
    const nights = sp.stops.filter((x) => Math.min(x.e_min, NIGHT_END_MIN) - Math.max(x.s_min, 0) >= NIGHT_MIN).length;
    const med = (xs) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
    const days = [...new Set(sp.stops.map((x) => x.day))].sort();
    return {
      lat: r1(sp.stops.reduce((a, x) => a + x.lat * x.minutes, 0) / mins * 1e4) / 1e4,
      lng: r1(sp.stops.reduce((a, x) => a + x.lng * x.minutes, 0) / mins * 1e4) / 1e4,
      area: [...areas.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      visits: sp.stops.length, days: days.length, first_day: days[0] || null, last_day: days[days.length - 1] || null,
      minutes: mins, wait_min: sum('wait_min'), ontrip_min: sum('ontrip_min'), offline_min: sum('offline_min'),
      nights, usual_from_min: med(sp.stops.map((x) => x.s_min)), usual_to_min: med(sp.stops.map((x) => x.e_min)),
      inferred_visits: sp.stops.filter((x) => x.inferred).length,
    };
  }).sort((a, b) => b.minutes - a.minutes);
}
