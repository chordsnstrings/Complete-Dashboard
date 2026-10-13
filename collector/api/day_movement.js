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
  (rows || []).forEach((r, i) => {
    const s = Math.max(0, Math.floor((ms(r.from_at) - dayStartMs) / 60000));
    const e = Math.min(1440, Math.floor((ms(r.to_at) - dayStartMs) / 60000));
    if (e <= s) return;
    const last = out[out.length - 1];
    if (last && last.status === r.status && last.e >= s) { last.e = Math.max(last.e, e); return; }
    /* CARRIED IN, NOT BEGUN. SPANS_SQL opens the day with the state in force
       at midnight, timed AT midnight; it is not a change that happened then.
       The review (2026-10-13) caught the page printing "went online in Deira
       at 00:00" and "00:00 went offline" from it — COVERAGE's trap: a clipped
       00:00 is never a start time. */
    out.push({ status: r.status, s, e, ...(i === 0 && ms(r.from_at) <= dayStartMs ? { carried_in: true } : {}) });
  });
  const last = out[out.length - 1];
  /* Still running: the last span reaches the moment of asking. Said, because
     "on a trip until 11:46" and "on a trip, and that is as far as now" are
     different claims about the driver. */
  if (last && nowMs != null && last.e >= Math.floor((nowMs - dayStartMs) / 60000) - 1) last.open_ended = true;
  return out;
}

/* ── 1. which car, and when it was his ─────────────────────────────────────
   own:    [{ plate, s, e, kind }]      his evidence in a car, minutes of the day
   others: [{ plate, s, e, who, who_id }] anybody else's evidence in those cars
   spells: [{ s, e }]                   the stretches he was WORKING, by the
                                        record the route trusts for each part
                                        of the day (see /api/driver/day)
   limit:  the last minute that can be his — now, on today; 1440 otherwise.

   Built spell by spell, never from his first evidence to his last across the
   day. The first version did the latter, and the independent review of
   2026-10-13 showed what it cost: a driver online 06:00–10:00 and
   15:00–19:00 in a car another man drove 10:30–14:30 was given that man's
   whole shift, passenger kilometres and all, labelled "shared".

   So: within one spell, his evidence in a car is cut into runs wherever
   ANOTHER driver's evidence in the same car falls between two of his; each
   run reaches back to the start of the spell (or the other driver's last
   evidence before it) and forward to the end of the spell (or the other's
   next). The stretch between belongs to nobody on this page. Evidence of his
   outside every spell (a booking with no availability record — hotel, Bolt)
   is its own interval, not stretched. Another driver's evidence that falls
   INSIDE one of his own intervals is a genuine contradiction and is returned
   as `shared`; across spells, two cars whose cores overlap are `overlap`. */
export function custodyWindows({ own = [], others = [], spells = [], limit = 1440 } = {}) {
  const sp = mergeRanges(spells.map((x) => ({ s: Math.max(0, x.s), e: Math.min(limit, x.e) })).filter((x) => x.e >= x.s));
  const spellOf = (m) => sp.findIndex((x) => x.s <= m && m <= x.e);
  const groups = new Map();
  for (const o of own) {
    if (!o.plate || o.s > limit) continue;
    const k = `${spellOf(o.s)}|${o.plate}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ ...o, e: Math.min(limit, o.e ?? o.s) });
  }
  const windows = [];
  for (const [k, mine] of groups) {
    const [si, plate] = [Number(k.split('|')[0]), k.slice(k.indexOf('|') + 1)];
    const S = si >= 0 ? sp[si] : null;
    mine.sort((a, b) => a.s - b.s || a.e - b.e);
    const theirs = others.filter((o) => o.plate === plate).map((o) => ({ ...o, e: o.e ?? o.s }))
      .filter((o) => (S ? o.e >= S.s && o.s <= S.e : true)).sort((a, b) => a.s - b.s);
    /* Runs of his evidence with no other driver's evidence between them. */
    const runs = [];
    for (const ev of mine) {
      const cur = runs[runs.length - 1];
      const between = cur && cur.e < ev.s && theirs.some((o) => o.s >= cur.e && o.e <= ev.s);
      if (!cur || between) runs.push({ s: ev.s, e: ev.e, kinds: [ev.kind] });
      else { cur.e = Math.max(cur.e, ev.e); cur.kinds.push(ev.kind); }
    }
    for (const r of runs) {
      let from = S ? S.s : r.s; let to = S ? S.e : r.e;
      const shared = [];
      for (const o of theirs) {
        if (o.e <= r.s) { if (o.e > from) from = o.e; } else if (o.s >= r.e) { if (o.s < to) to = o.s; } else {
          shared.push({ who: o.who || null, who_id: o.who_id || null, s: Math.max(o.s, r.s), e: Math.min(o.e, r.e) });
        }
      }
      windows.push({ plate, from: Math.min(from, r.s), to: Math.max(to, r.e), core_from: r.s, core_to: r.e,
        stretched: from < r.s || to > r.e, shared, basis: [...new Set(r.kinds.filter(Boolean))] });
    }
  }
  /* In order of his own evidence, not of the stretched edges: two windows
     stretched back to one spell's start tie on `from`, and the order they
     were pushed in decided which was "first" (review, 2026-10-13). */
  windows.sort((a, b) => a.core_from - b.core_from || a.core_to - b.core_to);
  for (let i = 0; i + 1 < windows.length; i += 1) {
    const w = windows[i]; const n = windows[i + 1];
    if (w.to <= n.from) continue;
    if (w.core_to <= n.core_from) {
      /* The stretches meet: the change of car (or of run) is at his last
         evidence in the first one. */
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
/* Fixes by car: two cars at once (an `overlap`) interleave by time, and a
   step from one car to the other is not driving — the first version skipped
   every such pair and read a two-car hour as "0 km, no position" (review,
   2026-10-13). */
const byPlate = (fixes) => {
  const m = new Map();
  for (const f of fixes) { if (!m.has(f.plate)) m.set(f.plate, []); m.get(f.plate).push(f); }
  return [...m.values()];
};
export function carRuns(fixes) {
  return byPlate(fixes).flatMap((fs) => carRunsOne(fs)).sort((a, b) => a.s - b.s || String(a.plate).localeCompare(String(b.plate)));
}
function carRunsOne(fixes) {
  const runs = [];
  for (let i = 1; i < fixes.length; i += 1) {
    const a = fixes[i - 1]; const b = fixes[i];
    if (a.plate !== b.plate || a.source !== b.source) continue;
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
  const t = { with: 0, without: 0, unknown: 0 };
  for (const fs of byPlate(fixes)) for (let i = 1; i < fs.length; i += 1) {
    const a = fs[i - 1]; const b = fs[i];
    if (a.source !== b.source) continue;
    const gap = (ms(b.at) - ms(a.at)) / 60000;
    const step = km(a, b);
    if (gap > GAP_MIN || step >= HOP_KM) continue;
    const seat = seatOn(a, b);
    t[seat === true ? 'with' : seat === false ? 'without' : 'unknown'] += step;
  }
  /* The total is the sum of the rounded parts, so the three figures the page
     prints beside it add up to it (review, 2026-10-13: 0.3 = 0.2 + 0.2). */
  const parts = { km_with_passenger: r1(t.with), km_empty: r1(t.without), km_seat_not_reported: r1(t.unknown) };
  return { km: r1(parts.km_with_passenger + parts.km_empty + parts.km_seat_not_reported), ...parts };
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
  const held = mergeRanges(windows.map((w) => ({ s: w.from, e: w.to }))).reduce((a, w) => a + Math.max(0, w.e - w.s), 0);
  return { ...d, fixes: inside.length,
    with_passenger_min: mins('engaged'), moving_empty_min: mins('available'), stopped_min: mins('idle'),
    held_min: held, unseen_min: Math.max(0, held - covered),
    seat_reported: inside.some((f) => f.passenger != null),
    sources: [...new Set(inside.map((f) => f.source).filter(Boolean))] };
}
