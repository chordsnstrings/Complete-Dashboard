/* ── one driver's day as the CAR saw it ────────────────────────────────────
   The operator, 2026-10-13, about #driver/…/day for a driver online four hours
   that morning: "we need to see when he was online, from where, and where he
   moved on a granular level … his whole day's movement as reported by cabman
   or fms and potentially with a passenger or not."

   The day page knew the jobs, Uber's log-in record and — between jobs only —
   whether the car moved. It did not know which car a driver was in on a day
   with no booking (it found the car through the bookings), so a driver online
   all morning with his trips not yet filed drew nothing at all. And the
   tracker's whole day was attributed to whoever had a booking in the car,
   including the hours another driver had it.

   This module is the arithmetic, pure, so the test can drive it without a
   database. api/driver_routes.js /api/driver/day gathers the evidence and the
   fixes and calls it; the page draws what comes back.

   THREE QUESTIONS, IN ORDER:
     1. custodyWindows — WHICH car, and WHEN was it his? From his own evidence
        in each car (his bookings; Uber's own status rows, which name the
        driver AND the vehicle the app had him in, minute-stamped), stretched
        to the edges of the online spell that evidence sits in, and never
        across another driver's evidence in the same car.
     2. carRuns — what the car was doing, interval by interval: a passenger
        aboard, moving, or stopped; nothing where the tracker was silent.
     3. movementSegments — the same day as a log a person reads: stops and
        drives with their places, distances and whether a passenger was in.

   The stop rule and the distance rule are /api/where's (api/where_routes.js),
   imported rather than restated, so "how far did it go" and "where did it
   stop" have one answer across the assistant, the place route and this page. */
import { findStops, km, GAP_MIN, HOP_KM } from './where_routes.js';

/* A silence longer than this is a hole in the record, not a stretch of
   driving or parking: the same 20 minutes /api/map/journey and /api/where
   use for a drawable step. */
export const SILENCE_MIN = GAP_MIN;
/* Moving, where a fix carries no speed: displacement over the interval at
   more than walking pace. FMS often sends no speed at all (COVERAGE), so a
   missing speed must not read as a parked car. */
export const MOVING_KMH = 6;
/* A "drive" shorter than this between two stops is the tracker's jitter
   around one parking spot, not a journey; it is not listed (it is still in
   the distance totals, which follow /api/where's rule exactly). */
export const MIN_DRIVE_KM = 0.2;

const ms = (at) => new Date(at).getTime();
const r1 = (n) => Math.round(n * 10) / 10;

/* Union of [s, e] minute ranges. */
export function mergeRanges(ranges) {
  const out = [];
  for (const r of [...ranges].filter((x) => x && x.e >= x.s).sort((a, b) => a.s - b.s)) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ s: r.s, e: r.e });
  }
  return out;
}

/* Uber's live status, as spans of THIS day. `rows` are /api/status/driver's
   own query (api/status_routes.js SPANS_SQL — the opening state carried in
   from before midnight, the last span closed at now or the day's end), so the
   day page and the status strip cannot disagree about one driver's morning.
   Uber repeats ONLINE as a heartbeat, so consecutive spans of one status are
   one spell. */
export function statusSpans(rows, dayStartMs, nowMs) {
  const out = [];
  for (const r of rows || []) {
    const s = Math.max(0, Math.floor((ms(r.from_at) - dayStartMs) / 60000));
    const e = Math.min(1440, Math.floor((ms(r.to_at) - dayStartMs) / 60000));
    if (e <= s) continue;
    const last = out[out.length - 1];
    if (last && last.status === r.status && last.e >= s) { last.e = Math.max(last.e, e); continue; }
    out.push({ status: r.status, s, e });
  }
  const last = out[out.length - 1];
  /* Still running: the last span reaches the moment of asking. Said, because
     "on a trip until 11:46" and "on a trip, and that is as far as now" are
     different claims about the driver. */
  if (last && nowMs != null && last.e >= Math.floor((nowMs - dayStartMs) / 60000) - 1) last.open_ended = true;
  return out;
}

/* ── 1. which car, and when it was his ─────────────────────────────────────
   own:    [{ plate, s, e }]        his evidence in a car, minutes of the day
   others: [{ plate, s, e, who }]   anybody else's evidence in those cars
   online: [{ s, e }]               his online spells (log-in record and live
                                    status together)
   limit:  the last minute that can be his — now, on today; 1440 otherwise.

   The core of a window is the first to the last minute of his OWN evidence
   in that car. It is stretched back to the start of the online spell the
   first evidence sits in (he went online in the car before the app recorded
   the vehicle against him) and forward to the end of the spell the last sits
   in — but never across another driver's evidence in the same car, which is
   where a shared car changes hands. Another driver's evidence INSIDE the core
   cannot be resolved from the record and is returned as `shared`, said, never
   silently given to either. Two windows in two cars that overlap at their
   cores are flagged `overlap` for the same reason. */
export function custodyWindows({ own = [], others = [], online = [], limit = 1440 } = {}) {
  const spells = mergeRanges(online);
  const plates = [...new Set(own.map((o) => o.plate).filter(Boolean))];
  const windows = plates.map((plate) => {
    const mine = own.filter((o) => o.plate === plate);
    const coreFrom = Math.max(0, Math.min(...mine.map((o) => o.s)));
    const coreTo = Math.min(limit, Math.max(...mine.map((o) => (o.e ?? o.s))));
    let from = coreFrom; let to = coreTo;
    const startIn = spells.find((sp) => sp.s <= coreFrom && sp.e >= coreFrom);
    const endIn = spells.find((sp) => sp.s <= coreTo && sp.e >= coreTo);
    if (startIn) from = Math.max(0, startIn.s);
    if (endIn) to = Math.min(limit, endIn.e);
    const shared = [];
    for (const o of others.filter((x) => x.plate === plate)) {
      const oe = o.e ?? o.s;
      if (oe <= coreFrom) { if (oe > from) from = oe; } else if (o.s >= coreTo) { if (o.s < to) to = o.s; } else {
        shared.push({ who: o.who || null, who_id: o.who_id || null, s: Math.max(o.s, coreFrom), e: Math.min(oe, coreTo) });
      }
    }
    return { plate, from, to: Math.max(from, to), core_from: coreFrom, core_to: Math.max(coreFrom, coreTo),
      stretched: from < coreFrom || to > coreTo, shared, basis: [...new Set(mine.map((o) => o.kind).filter(Boolean))] };
  }).sort((a, b) => a.from - b.from);
  for (let i = 0; i + 1 < windows.length; i += 1) {
    const w = windows[i]; const n = windows[i + 1];
    if (w.to <= n.from) continue;
    if (w.core_to <= n.core_from) {
      /* The stretches meet: the change of car is at his last evidence in the
         first one. */
      n.from = Math.max(n.from, w.core_to);
      w.to = Math.min(w.to, n.from);
    } else {
      w.overlap = true; n.overlap = true;
    }
  }
  return windows;
}

/* The seat on an interval: the later fix's reading, or the earlier one's
   where the later has none. Tri-state — null is "this feed did not say",
   never an empty seat. */
const seatOn = (a, b) => (b.passenger != null ? b.passenger : a.passenger != null ? a.passenger : null);
const movingOn = (a, b) => {
  if (b.speed != null) return Number(b.speed) > 3;
  const h = (ms(b.at) - ms(a.at)) / 3600000;
  return h > 0 && km(a, b) / h > MOVING_KMH;
};

/* ── 2. what the car was doing, interval by interval ───────────────────────
   One run per stretch of one state: 'engaged' a passenger aboard, 'available'
   moving with none (or none reported — `seat` says which), 'idle' stopped.
   The names are the channel ramps' own (api/public/tokens.js RAMP), so the
   page paints them with the tracker's colours. A silence longer than
   SILENCE_MIN draws nothing: the car is not "stopped" where nobody saw it. */
export function carRuns(fixes) {
  const runs = [];
  for (let i = 1; i < fixes.length; i += 1) {
    const a = fixes[i - 1]; const b = fixes[i];
    if (a.plate !== b.plate) continue;
    if ((ms(b.at) - ms(a.at)) / 60000 > SILENCE_MIN) continue;
    const seat = seatOn(a, b);
    const state = seat === true ? 'engaged' : movingOn(a, b) ? 'available' : 'idle';
    const last = runs[runs.length - 1];
    if (last && last.state === state && last.seat === seat && last.e === a.m && last.plate === b.plate && last.source === b.source) {
      last.e = b.m;
    } else {
      runs.push({ s: a.m, e: b.m, state, seat, source: b.source, plate: b.plate });
    }
  }
  return runs.filter((r) => r.e > r.s);
}

/* Minutes of an interval list by seat. */
function seatMinutes(fs) {
  const t = { with: 0, without: 0, unknown: 0 };
  for (let i = 1; i < fs.length; i += 1) {
    const gap = (ms(fs[i].at) - ms(fs[i - 1].at)) / 60000;
    if (gap > SILENCE_MIN) continue;
    const seat = seatOn(fs[i - 1], fs[i]);
    t[seat === true ? 'with' : seat === false ? 'without' : 'unknown'] += gap;
  }
  return t;
}
const seatWord = (t) => {
  const known = t.with + t.without;
  if (!known) return 'seat not reported';
  if (t.with && !t.without) return 'with a passenger';
  if (!t.with) return 'empty';
  return 'part of it with a passenger';
};

/* Distance by seat, on /api/where's step rule (a step over GAP_MIN or a hop
   over HOP_KM is not driving). The three parts sum to the total. */
export function distanceBySeat(fixes) {
  const t = { total: 0, with: 0, without: 0, unknown: 0 };
  for (let i = 1; i < fixes.length; i += 1) {
    const a = fixes[i - 1]; const b = fixes[i];
    if (a.plate !== b.plate) continue;
    const gap = (ms(b.at) - ms(a.at)) / 60000;
    const step = km(a, b);
    if (gap > GAP_MIN || step >= HOP_KM) continue;
    const seat = seatOn(a, b);
    t.total += step;
    t[seat === true ? 'with' : seat === false ? 'without' : 'unknown'] += step;
  }
  return { km: r1(t.total), km_with_passenger: r1(t.with), km_empty: r1(t.without), km_seat_not_reported: r1(t.unknown) };
}

const drive = (fs) => {
  const d = distanceBySeat(fs);
  const via = [];
  for (const f of fs.slice(1, -1)) if (f.area && f.area !== via[via.length - 1] && f.area !== fs[0].area) via.push(f.area);
  const seat = seatMinutes(fs);
  return { kind: 'drive', s: fs[0].m, e: fs[fs.length - 1].m, from: fs[0].time, to: fs[fs.length - 1].time,
    minutes: Math.round((ms(fs[fs.length - 1].at) - ms(fs[0].at)) / 60000),
    from_area: fs[0].area || null, to_area: fs[fs.length - 1].area || null,
    via: via.filter((a) => a !== fs[fs.length - 1].area).slice(0, 4),
    km: d.km, km_with_passenger: d.km_with_passenger, passenger: seatWord(seat),
    /* The minutes behind the word, so "part of it" can be said as "15 of 20
       minutes" — a passenger set down a few minutes before the car stops is
       the ordinary case, not a contradiction. */
    passenger_min: Math.round(seat.with), seat_reported_min: Math.round(seat.with + seat.without),
    source: fs[fs.length - 1].source, plate: fs[0].plate, fixes: fs.length };
};

/* ── 3. the day as a log ───────────────────────────────────────────────────
   Within each window: silences (no fix for over SILENCE_MIN), stops
   (/api/where's rule: 10 minutes within 250 m) and the drives between them,
   in order. A window's own edges are honoured: a stretch from his first
   minute to the first fix with no fix in it is a silence, said. */
export function movementSegments(fixes, windows) {
  const out = [];
  for (const w of windows) {
    const fs = fixes.filter((f) => f.plate === w.plate && f.m >= w.from && f.m <= w.to);
    if (!fs.length) {
      if (w.to > w.from) out.push({ kind: 'silence', s: w.from, e: w.to, minutes: w.to - w.from, plate: w.plate, edge: 'whole' });
      continue;
    }
    if (fs[0].m - w.from > SILENCE_MIN) out.push({ kind: 'silence', s: w.from, e: fs[0].m, minutes: fs[0].m - w.from, plate: w.plate, edge: 'start' });
    /* Runs between silences. */
    const runs = [[fs[0]]];
    for (let i = 1; i < fs.length; i += 1) {
      if ((ms(fs[i].at) - ms(fs[i - 1].at)) / 60000 > SILENCE_MIN) runs.push([fs[i]]); else runs[runs.length - 1].push(fs[i]);
    }
    runs.forEach((run, ri) => {
      if (ri > 0) {
        const p = runs[ri - 1][runs[ri - 1].length - 1];
        out.push({ kind: 'silence', s: p.m, e: run[0].m, minutes: Math.round((ms(run[0].at) - ms(p.at)) / 60000), plate: w.plate,
          /* Where it went silent and where it came back, so a reader can see
             whether the car moved while nobody was watching. */
          from_area: p.area || null, to_area: run[0].area || null, moved_km: r1(km(p, run[0])) });
      }
      const stops = findStops(run);
      let at = 0;
      const index = (iso) => run.findIndex((f) => f.at === iso);
      for (const st of stops) {
        const i0 = index(st.from_at); const j0 = index(st.to_at);
        if (i0 > at) {
          const d = drive(run.slice(at, i0 + 1));
          if (d.km >= MIN_DRIVE_KM) out.push(d);
        }
        const seat = seatMinutes(run.slice(i0, j0 + 1));
        out.push({ kind: 'stop', s: run[i0].m, e: run[j0].m, from: st.from, to: st.to, minutes: st.minutes,
          area: st.area, lat: st.lat, lng: st.lng, fixes: st.fixes, longest_silence_min: st.longest_silence_min,
          passenger: seatWord(seat), source: run[j0].source, plate: w.plate });
        at = j0;
      }
      if (run.length - 1 > at) {
        const d = drive(run.slice(at));
        if (d.km >= MIN_DRIVE_KM) out.push(d);
      }
    });
    const last = fs[fs.length - 1];
    if (w.to - last.m > SILENCE_MIN) out.push({ kind: 'silence', s: last.m, e: w.to, minutes: w.to - last.m, plate: w.plate, edge: 'end', from_area: last.area || null });
  }
  return out.sort((a, b) => a.s - b.s);
}

/* The day's totals over the windows: distance by seat on the step rule, and
   minutes by what the car was doing. */
export function movementTotals(fixes, windows, runs) {
  const inside = fixes.filter((f) => windows.some((w) => f.plate === w.plate && f.m >= w.from && f.m <= w.to));
  const d = distanceBySeat(inside);
  const mins = (st) => runs.filter((r) => r.state === st).reduce((a, r) => a + (r.e - r.s), 0);
  const covered = runs.reduce((a, r) => a + (r.e - r.s), 0);
  const held = windows.reduce((a, w) => a + Math.max(0, w.to - w.from), 0);
  return { ...d, fixes: inside.length,
    with_passenger_min: mins('engaged'), moving_empty_min: mins('available'), stopped_min: mins('idle'),
    held_min: held, unseen_min: Math.max(0, held - covered),
    seat_reported: inside.some((f) => f.passenger != null),
    sources: [...new Set(inside.map((f) => f.source).filter(Boolean))] };
}
