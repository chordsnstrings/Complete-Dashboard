/* ── WHERE EACH CAR SPENT THE NIGHT (OVN, 2026-11-16) ─────────────────────
   The operator, 2026-11-16: "also add the overnight parking table on the
   fleet page also in drivers activity list and drivers day page" — after
   asking to know where each car was at all times. WHR (api/whereabouts.js)
   answers that for one car and one day, minute by minute. This answers the
   one question an operator asks of the whole fleet every morning: where did
   each car sleep?

   ── THE DEFINITION (decided, 2026-11-16) ────────────────────────────────
   · The NIGHT OF D is the evening of day D into the morning of D+1, and its
     WINDOW is 00:00–05:00 Dubai on D+1 — the hours a car that is not working
     stands still, whoever drove it last. A night is named by the evening it
     begins on, so "the night after Monday's shift" is the night of Monday,
     and that is the label the driver pages put under Monday.
   · A car's overnight place is the STAY with the most minutes inside the
     window, taken from whereaboutsDay() for D+1 — never recomputed here. A
     WHR stay already joins the minutes the tracker watched and the minutes
     it inferred (parked, tracker quiet), names the ground by the most of its
     fixes, and says since when; this module only chooses among the stays and
     words the result. No segment logic is duplicated: what a stay, a drive or
     a silence IS stays in one place.
   · TRACKER ONLY. No booking is read. A booking laid into a quiet stretch is
     booking detail (manifest class BK) and would change which stretches are
     "moved" and which "parked"; the tracker's own account is what every role
     that sees locations may see, and it is the same answer for all of them.
   · The day is read from LOOK_AROUND_H before midnight to 12:00 on D+1, plus
     the nearest fix before and after per tracker — the /api/vehicle/whereabouts
     pattern — and judged with now held at 12:00 (or the real now, if earlier),
     so a stay that ran on into the morning says when it ended, and an FMS
     unit that was quiet all night (they are, often) is judged by the fix
     either side of the silence: at one spot, that is the module's own
     "parked, tracker quiet" — INFERRED, and always called inferred.

   ── STATUS, FROM THE WINDOW'S MINUTES ───────────────────────────────────
   W is the window's minutes so far (300, or fewer while the night is still
   running). Over them:
     parked      the chosen stay covers MORE THAN HALF of W. Its basis is the
                 window's own: "fixes" if the tracker watched every one of
                 its window minutes, "inferred" if none, else both. A stay
                 watched all evening and quiet from 23:00 is, for the night,
                 inferred — which is what the fleet table counts it as.
     otherwise   whichever covers most of W: SILENT (no reading for over a
                 day — a parked car and a dead unit look the same), UNKNOWN
                 (moved while the tracker was silent, before its first fix,
                 after its last), or MOVING (drives, plus stays at more than
                 one place). Ties go to the less certain word.
     no_tracker  no tracker position has ever been recorded for the plate.
   Every row that is not parked carries `reason`, a true sentence — the WHR
   segment's own `say` where one stretch decides it. A parked row whose
   ground the fleet has never named carries `area: null` and the reason
   "ground the fleet has never driven near has no name": the position is
   kept, a name is never guessed (place_cell names only cells the fleet's FMS
   trips have passed through).

   ── WHAT IT DOES NOT CLAIM ──────────────────────────────────────────────
   · Not who parked it. The driver pages name the car the person drove last
     (or first) that day and ask about the car; the car's night is the car's.
   · Not more than the window. A car parked 00:00–03:00 and driven 03:00–05:00
     is parked (180 of 300 minutes); a car parked 02:00–05:00 after driving
     until 02:00 is parked too. The from–to of the stay says the rest.
   · "Since" and "until" are bounds where they are bounds: `since_at_least`
     when the stay began on the earliest fix read (WHR's rule), `to_at_least`
     when it was still there at the last moment read (12:00, or now). */
import { whereaboutsDay, dayStartMs, localStamp, LOOK_AROUND_H, SILENT_MIN,
  STAY_RADIUS_KM, PARKED_CADENCE_MIN } from './whereabouts.js';

const MIN = 60_000;
export const WINDOW_FROM = '00:00';
export const WINDOW_TO = '05:00';
export const WINDOW_MIN = 300;
/* How far into D+1 the day is read: far enough that a car parked overnight
   and driven off at 07:30 says 07:30, not "still there at 05:00". */
export const MORNING_MIN = 720;
/* Who is in the fleet-wide table: every plate with a positioned tracker fix
   in the seven days before the window's end. A car silent longer than that
   has no night to speak of, and the population sentence says so. */
export const POPULATION_DAYS = 7;
export const MAX_PLATES = 10;
export const MAX_NIGHTS = 31;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const okDay = (d) => ISO_DAY.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`))
  && new Date(Date.parse(`${d}T12:00:00Z`)).toISOString().slice(0, 10) === d;
/* Midday UTC, so a day shifted by whole days never crosses a calendar edge. */
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const dubaiDayOfMs = (t) => localStamp(t).day;
const fmtDur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const normPlate = (s) => String(s || '').toUpperCase().replace(/[\s-]+/g, '');

/* The night of D, as instants. */
export function nightWindow(night) {
  const on = addDays(night, 1);
  const d0 = dayStartMs(on);
  return { night, on, startMs: d0, endMs: d0 + WINDOW_MIN * MIN,
    readFromMs: d0 - LOOK_AROUND_H * 3600_000, readToMs: d0 + MORNING_MIN * MIN };
}
/* Last night: D = yesterday in Dubai. Before 05:00 its window is still
   running, and that is said, not hidden. */
export const lastNightOf = (nowMs) => addDays(dubaiDayOfMs(nowMs), -1);
export const nightBegun = (night, nowMs) => nowMs >= nightWindow(night).startMs;
export const nightRunning = (night, nowMs) => nightBegun(night, nowMs) && nowMs < nightWindow(night).endMs;

/* For api/cache.js: an answer whose LAST night's window has not ended moves
   with every tracker tick (CABMAN's five-minute realtime poll advances no
   data version), so it is never cached. The night asked is the range's end,
   or the one night, or last night by default. A malformed value is refused
   by the route, and a refusal is never cached either. */
export function overnightOpen(query = {}, nowMs = Date.now()) {
  const pick = (v) => String(v ?? '').trim().slice(0, 10);
  const last = pick(query.to) || pick(query.night) || lastNightOf(nowMs);
  if (!okDay(last)) return false;
  return nowMs < nightWindow(last).endMs;
}

/* ── the request, read once for the route and the mock ───────────────────
   Returns { plates|null, nights } or { status: 400, error, detail }. The
   refusals mirror /api/vehicle/whereabouts': a malformed day, a night whose
   window has not begun (it has no minutes to account for, and 300 unknown
   minutes would read as a tracker that failed), too many plates or nights. */
export function parseOvernightQuery(query = {}, nowMs = Date.now()) {
  const str = (v) => String(v ?? '').trim();
  const rawPlates = str(query.plates);
  const night = str(query.night); const from = str(query.from); const to = str(query.to);
  const last = lastNightOf(nowMs);
  const bad = (error, detail) => ({ status: 400, error, ...(detail ? { detail } : {}) });
  let plates = null;
  let nights;
  if (rawPlates) {
    plates = [...new Set(rawPlates.split(',').map(normPlate).filter(Boolean))];
    if (!plates.length) return bad('plates must name at least one plate');
    if (plates.length > MAX_PLATES) {
      return bad(`at most ${MAX_PLATES} plates at a time`,
        'each car-night is read fix by fix; the fleet-wide table (no ?plates) covers every car for one night');
    }
    if (plates.some((p) => !/^[A-Z0-9]{2,12}$/.test(p))) return bad('a plate is letters and digits only, as L12345');
    if (from || to) {
      if (!okDay(from) || !okDay(to) || to < from) {
        return bad('from and to must both be YYYY-MM-DD, with to on or after from');
      }
      nights = [];
      for (let d = from; d <= to && nights.length <= MAX_NIGHTS; d = addDays(d, 1)) nights.push(d);
      if (nights.length > MAX_NIGHTS) {
        return bad(`at most ${MAX_NIGHTS} nights at a time`, 'ask for a month, then the next');
      }
    } else if (night) {
      if (!okDay(night)) return bad('night must be YYYY-MM-DD');
      nights = [night];
    } else nights = [last];
  } else {
    if (from || to) {
      return bad('a range of nights is for named plates',
        `?plates= (at most ${MAX_PLATES}) with ?from=&to=; the fleet-wide table is one night at a time (?night=)`);
    }
    if (night && !okDay(night)) return bad('night must be YYYY-MM-DD');
    nights = [night || last];
  }
  const early = nights.find((n) => !nightBegun(n, nowMs));
  if (early) {
    return bad('that night has not begun',
      `the night of ${early} is read from ${WINDOW_FROM} to ${WINDOW_TO} Dubai on ${addDays(early, 1)}; `
      + `the latest night begun is ${last}`);
  }
  return { plates, nights };
}

/* ── one plate's fixes, cut to one night's read ──────────────────────────
   `fixes`: that plate's fixes from a read covering this night (any range
   around it), any tracker. `edges.before` / `edges.after`: the nearest fix
   before / after the WHOLE read, per tracker. The nearest before this
   night's read is the last fetched fix before it, else the read's own
   "before"; likewise after. So the fleet-wide read (one night) and the
   driver pages' read (a month at once) hand whereaboutsDay exactly what a
   per-night read would — the same car-night says the same thing on both. */
export function sliceNight(fixes, night, { before = [], after = [] } = {}) {
  const w = nightWindow(night);
  const tOf = (p) => (typeof p.t === 'number' ? p.t : Date.parse(p.at));
  const sorted = [...fixes].sort((a, b) => tOf(a) - tOf(b));
  const lastBefore = new Map(before.filter(Boolean).map((p) => [p.source, p]));
  const firstAfter = new Map(after.filter(Boolean).map((p) => [p.source, p]));
  const inRead = [];
  const localAfter = new Map();
  for (const p of sorted) {
    const t = tOf(p);
    if (t < w.readFromMs) lastBefore.set(p.source, p);
    else if (t < w.readToMs) inRead.push(p);
    else if (!localAfter.has(p.source)) localAfter.set(p.source, p);
  }
  for (const [s, p] of localAfter) firstAfter.set(s, p);
  return [...lastBefore.values(), ...inRead, ...firstAfter.values()];
}

/* One car, one night: the WHR day for D+1, judged up to 12:00 (or now). */
export function carNight({ plate, fleetId = null, night, points = [], nowMs = Date.now() }) {
  const w = nightWindow(night);
  const day = whereaboutsDay({ day: w.on, points, nowMs: Math.min(nowMs, w.readToMs) });
  return overnightOf(day, night, { plate, fleet_id: fleetId, nowMs });
}

/* ── the choice and its words ────────────────────────────────────────────
   `day` is whereaboutsDay()'s answer for D+1. Pure: the test drives it with
   synthetic days and fixes. */
export function overnightOf(day, night, { plate = null, fleet_id = null, nowMs = Date.now() } = {}) {
  const W = Math.max(0, Math.min(WINDOW_MIN, day?.minutes ?? 0));
  /* A SILENCE AFTER THE LAST FIX, MEASURED TO NOW — NOT TO 12:00.
     ───────────────────────────────────────────────────────────────────────
     The day is judged with now held at 12:00 on D+1, because nothing after
     the first fix past 12:00 is read. WHR words a stretch after the last fix
     on a day that has not ended as "No fix since 22:56 — the day is still
     running", and with now held at 12:00 every night's D+1 has "not ended":
     measured on production fixes for the night of 15 Nov (40 cars), a unit
     last heard at 22:56 on the 15th was told at 17:40 on the 16th that its
     day was still running. An "after the last fix" stretch here means no fix
     at all after that one — the read carries the first fix after 12:00 when
     there is one — so the silence runs to the real now: past a day it is
     SILENT (WHR's own rule, "never call a gap over a day parked"), and short
     of one it is said as what it is. */
  const segs = (day?.segments || []).map((s) => {
    if (s.quiet !== 'after_last' || !s.last_fix) return s;
    const lastMs = Date.parse(s.last_fix);
    const l = localStamp(lastMs);
    const at = l.day === day.day ? l.time : `${l.day} ${l.time}`;
    if (nowMs - lastMs > SILENT_MIN * MIN) {
      return { ...s, quiet: 'silent', say: `No reading since ${l.day} ${l.time}. Past a day a parked car and a dead tracker `
        + 'look the same, so this is not called parked.' };
    }
    return { ...s, say: nightRunning(night, nowMs) ? `No fix since ${at} — the night is still running.`
      : `No fix since ${at}: the tracker has not reported since.` };
  });
  const clip = (s, e) => Math.max(0, Math.min(e, W) - Math.max(s, 0));
  const base = { plate, fleet_id, night, status: null, area: null, lat: null, lng: null,
    from: null, from_day: null, to: null, to_day: null, since_at_least: false, to_at_least: false,
    minutes_in_window: null, window_min: W, watched_min: null, inferred_min: null, basis: null, how: null,
    source: day?.tracker?.source ?? null, reason: null, split: null };
  if (!W) {
    return { ...base, status: 'unknown',
      reason: `The night window (${WINDOW_FROM}–${WINDOW_TO} on ${addDays(night, 1)}) has not begun, so it has no minutes to account for.` };
  }

  /* The window's minutes by what the tracker says of them. */
  const split = { longest_stay: 0, other_stays: 0, drive: 0, unknown: 0, silent: 0, no_tracker: 0 };
  let stayMin = 0;
  for (const s of segs) {
    const m = clip(s.start_min, s.end_min);
    if (!m) continue;
    if (s.kind === 'stay' || s.quiet === 'parked') stayMin += m;
    else if (s.kind === 'drive') split.drive += m;
    else if (s.quiet === 'silent') split.silent += m;
    else if (s.quiet === 'no_tracker') split.no_tracker += m;
    else split.unknown += m;           // moved, before_first, after_last
  }

  /* Each stay's window minutes, and how many the tracker watched. A stay row
     is a run of consecutive stay / parked-quiet segments, so the segments
     inside its span are exactly its own. */
  const stays = (day?.stays || []).map((st) => {
    let watched = 0; let inferred = 0;
    for (const s of segs) {
      if (s.start_min < st.start_min || s.end_min > st.end_min) continue;
      const m = clip(s.start_min, s.end_min);
      if (s.kind === 'stay') watched += m;
      else if (s.quiet === 'parked') inferred += m;
    }
    return { st, inW: watched + inferred, watched, inferred };
  }).filter((x) => x.inW > 0)
    /* Most window minutes; then the more watched; then the later (where the
       night ended up). */
    .sort((a, b) => b.inW - a.inW || b.watched - a.watched || b.st.start_min - a.st.start_min);
  const best = stays[0] || null;
  split.longest_stay = best ? best.inW : 0;
  split.other_stays = stayMin - split.longest_stay;
  const out = { ...base, split };
  /* Each reason stands alone (the Activity row prints it on one line, cut
     with an ellipsis): what the window was, then the stretch that decided it. */
  const windowWords = `the night window (${WINDOW_FROM}–${WINDOW_TO}${W < WINDOW_MIN ? `, ${fmtDur(W)} of it so far` : ''})`;
  const longest = best ? `; its longest stay in the window was ${fmtDur(best.inW)} in ${best.st.area || 'ground the fleet has no name for'}` : '';

  if (split.no_tracker * 2 >= W) {
    const seg = segs.find((s) => s.quiet === 'no_tracker');
    return { ...out, status: 'no_tracker', minutes_in_window: split.no_tracker,
      reason: seg?.say || 'No tracker position has ever been recorded for this car.' };
  }
  if (best && best.inW * 2 > W) {
    const st = best.st;
    const basis = best.inferred === 0 ? 'fixes' : best.watched === 0 ? 'inferred' : 'fixes and inferred';
    const since = st.since ? localStamp(st.since) : null;
    const fromStamp = since || { day: day.day, time: st.from };
    const reachedEnd = st.end_min >= day.minutes;
    const until = st.until ? localStamp(st.until) : null;
    const toStamp = until || { day: day.day, time: st.to };
    return { ...out, status: 'parked', area: st.area || null, lat: st.lat ?? null, lng: st.lng ?? null,
      from: fromStamp.time, from_day: fromStamp.day, to: toStamp.time, to_day: toStamp.day,
      since_at_least: Boolean(st.since && st.since_at_least), to_at_least: Boolean(until) || reachedEnd,
      minutes_in_window: best.inW, watched_min: best.watched, inferred_min: best.inferred, basis,
      how: basis === 'inferred'
        ? `inferred: a fix within ${STAY_RADIUS_KM * 1000} m either side of a silence past the tracker’s parked rhythm `
          + `(${(out.source && PARKED_CADENCE_MIN[out.source]) || 30} min), nothing reported between`
        : basis === 'fixes' ? `seen: ${st.how}` : `seen for ${fmtDur(best.watched)} of the window, inferred for ${fmtDur(best.inferred)} — ${st.how}`,
      reason: st.area ? null
        : 'Ground the fleet has never driven near has no name — the position is kept, a name is not guessed.' };
  }
  /* Not parked: the largest of the rest decides, ties to the less certain. */
  const moving = split.drive + split.other_stays;
  const pickOf = [['silent', split.silent], ['unknown', split.unknown], ['moving', moving]]
    .reduce((a, b) => (b[1] > a[1] ? b : a));
  const [status, minutes] = pickOf[1] > 0 ? pickOf : ['unknown', W];
  const longestSeg = (pred) => segs.filter(pred)
    .sort((a, b) => clip(b.start_min, b.end_min) - clip(a.start_min, a.end_min))[0];
  let reason;
  if (status === 'silent') {
    const seg = longestSeg((s) => s.quiet === 'silent');
    reason = seg?.say || `No reading for over ${SILENT_MIN / 60} hours.`;
  } else if (status === 'unknown') {
    const seg = longestSeg((s) => ['moved', 'before_first', 'after_last'].includes(s.quiet));
    reason = `${seg?.say ? `${seg.say} ` : ''}For ${fmtDur(minutes)} of ${windowWords} the tracker cannot say where it was${longest}.`;
  } else {
    reason = `It drove for ${fmtDur(split.drive)} of ${windowWords}`
      + (split.other_stays ? ' and stood at more than one place' : '') + `${longest}; no one place held it for most of the window.`;
  }
  return { ...out, status, minutes_in_window: minutes, reason };
}

/* "Where the fleet slept": parked cars by area, the commonest first. The
   unnamed are one row, `area: null`, never folded into a guess. */
export function byArea(rows) {
  const tally = new Map();
  for (const r of rows || []) {
    if (r.status !== 'parked') continue;
    const k = r.area ?? null;
    tally.set(k, (tally.get(k) || 0) + 1);
  }
  return [...tally.entries()].map(([area, n]) => ({ area, n }))
    .sort((a, b) => b.n - a.n || (a.area == null) - (b.area == null) || String(a.area).localeCompare(String(b.area)));
}

/* A partition of the cars: parked (mostly seen) + inferred (parked, mostly
   inferred) + unknown + silent + no_tracker + moving = every car. */
export function countsOf(rows) {
  const n = { parked: 0, inferred: 0, unknown: 0, silent: 0, no_tracker: 0, moving: 0 };
  for (const r of rows || []) {
    if (r.status === 'parked') n[(r.inferred_min || 0) > (r.watched_min || 0) ? 'inferred' : 'parked'] += 1;
    else if (r.status in n) n[r.status] += 1;
  }
  return n;
}

export function overnightNight({ night, cars, nowMs = Date.now() }) {
  const w = nightWindow(night);
  return { night, window: { on: w.on, from: WINDOW_FROM, to: WINDOW_TO }, running: nightRunning(night, nowMs),
    cars, by_area: byArea(cars), counts: countsOf(cars) };
}

export const OVERNIGHT_RULES = Object.freeze({
  window: `the night of D is ${WINDOW_FROM}–${WINDOW_TO} Dubai on D+1`,
  place: 'the stay with the most minutes inside the window, from the tracker alone (no booking is read); '
    + `the day is read from ${LOOK_AROUND_H} hours before midnight to 12:00, with the nearest fix either side`,
  parked: 'that stay covers more than half of the window',
  seen: 'every window minute of the stay between two fixes inside the tracker’s parked rhythm',
  inferred: 'parked with the tracker quiet past its rhythm — a fix at one spot either side, nothing between',
  unknown: 'no stay held most of the window and the tracker could not say for most of it: moved while it was silent, '
    + 'before its first fix or after its last',
  silent: `no reading for over ${SILENT_MIN / 60} hours: a parked car and a dead tracker look the same, so it is not called parked`,
  moving: 'no stay held most of the window and the car drove, or stood at more than one place, for most of it',
  no_tracker: 'no tracker position has ever been recorded for the plate',
});
export const OVERNIGHT_AREA_WHY = 'An area is the fleet’s own name for a half-kilometre cell, learnt from its FMS trips; '
  + 'ground the fleet has never driven near has no name and is left unnamed rather than guessed.';

export function overnightBody({ nights, population, roster = null }) {
  return { nights, population, roster, rules: OVERNIGHT_RULES, area_why: OVERNIGHT_AREA_WHY };
}
