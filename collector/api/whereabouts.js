/* ── WHERE THE CAR WAS, EVERY MINUTE OF A DUBAI DAY ────────────────────────
   The operator, 2026-11-16: "whether pick up or drop off, we should ideally
   know where the car was at all times. currently we just focus on trips, but
   if we can figure out where the car is at all time that would be great too."

   What existed answered parts of that. /api/where names the car's ground at
   one moment, or lists its stops over a stretch; /api/map/journey draws the
   fixes; /api/driver/day follows ONE DRIVER's hours in a car. None of them
   accounts for the whole day of the CAR: the minutes between fixes were
   either drawn as a straight line or left out, and nothing said which of the
   1,440 minutes were watched, which were inferred and which nobody knows.

   This module is that accounting, pure, so the test drives it with synthetic
   fixes. api/vehicle_routes.js /api/vehicle/whereabouts gathers the fixes,
   the bookings and the FMS journeys and calls it; api/public/whereabouts.js
   draws what comes back.

   ── THE ONE IDEA: CLASSIFY EACH INTERVAL BETWEEN TWO FIXES ───────────────
   A tracker gives points; a day is made of the intervals between them. Each
   interval is judged by its two ends alone — how far apart in space, how far
   apart in time — against what that tracker does when nothing is wrong:

     same place, gap within the tracker's parked cadence  → STAY (watched)
     same place, gap longer than that                      → QUIET, parked
                                                              (INFERRED)
     different places, gap within the moving cadence      → DRIVE (watched)
     different places, gap longer than that                → QUIET, moved —
                                                              route not known
     any gap over a day                                   → QUIET, silent —
                                                              no reading since

   "Same place" is STAY_RADIUS_KM. The trackers file ON MOVEMENT — CABMAN
   every 5 minutes moving, FMS every ~6 — so a car that drove off between two
   fixes would have filed in between. Two fixes at one spot with no report
   between them, inside the tracker's normal parked cadence, are the tracker
   SAYING the car stood there: that is watched, not guessed. Past that
   cadence the report that should have come did not, so whether the tracker
   was alive in between is not known: "parked, tracker quiet" is then an
   inference, labelled as one and counted apart.

   ── THE NUMBERS, MEASURED ON PRODUCTION 2026-11-16 ───────────────────────
   40 tracked cars (20 FMS, 20 CABMAN, drawn at random from /api/live's
   roster), 9 days each (8–16 Nov), from /api/map/journey — 42,168 intervals:

   · STAY_RADIUS_KM = 0.15. A parked car's fix wanders: of CABMAN pairs taken
     on its parked heartbeat (55–70 min apart) 91.8% are within 50 m, 94.6%
     within 150 m and 95.6% within 250 m; of FMS stopped pairs 99.3% within
     50 m, 99.65% within 150 m, 99.78% within 250 m. Widening to 250 m (the
     radius /api/where's stop rule uses) gains one point on CABMAN and a tenth
     on FMS, and it makes a car crawling 250 m through a jam "one place". The
     two rules answer different questions: /api/where lists stops; this one
     infers "stood there throughout" across a silence from two ends being the
     same spot, so it is the stricter of the two on purpose.
   · PARKED_CADENCE_MIN — the longest gap at one spot that is still the
     tracker's own rhythm. CABMAN reports about hourly while parked: of its
     same-spot gaps 62.0% are under an hour and 97.9% under 67 minutes (the
     heartbeat sits at 65–67), 98.2% under 70. FMS kept reporting while
     parked in this sample: 97.7% of its same-spot gaps under 20 minutes,
     99.3% under 30 (it can still go quiet for a night — 0.08% over 6 h).
     So CABMAN 70, FMS 30.
   · MOVING_CADENCE_MIN = 20 — /api/where's and /api/map/journey's drawable
     step (GAP_MIN), imported, so "how far did it drive" has one answer
     across the product. Between two DIFFERENT places CABMAN filed within 20
     minutes 95.4% of the time and FMS 99.4%.
   · SILENT_MIN = 1440. COVERAGE: "past a day a car off the road and a dead
     unit look the same until it moves". A gap over a day is never called
     parked, whatever its two ends say.
   · STAY_MIN = 10 — /api/where's stop rule. A same-spot run shorter than
     this is a traffic light inside a drive, not a stay.

   ── WHAT IS NEVER DONE ───────────────────────────────────────────────────
   · No position is invented between fixes. A drive is "from → to" with the
     distance the fixes walked; a quiet stretch with movement is "route not
     known", with how far apart its ends are in a straight line — never a
     drawn route.
   · Two trackers are never mixed. Where a car carries both, the one with
     more fixes that day is read (the rule /api/driver/day uses) and the
     other is named in `tracker.second`, never merged: CABMAN and FMS on one
     car each walk the same road, and alternating them would draw zig-zags
     and double the distance.
   · A booking never becomes a tracker fix. Where a completed booking's span
     falls in a quiet stretch it says the car was on a job then, and its
     drop-off (and its pickup, where the trip's duration places it) anchors
     the car's ground AT THAT MINUTE — labelled "from a booking". The minutes
     of the job between those two pins are counted UNKNOWN, not inferred
     (independent review, 2026-11-16): a job says what the car was doing and
     where it began and ended, not where it was at 12:40 — exactly what a
     "moved while the tracker was silent" stretch says, and this module
     counts that unknown when its two ends are fixes 21 minutes apart. Read
     as inferred, a 40-minute job in a silence moved 40 minutes from unknown
     to inferred on the page's headline while placing the car at two minutes
     of them. A booking inside a "parked, tracker quiet" stretch proves the
     car did NOT stand still, so the stretch around it becomes "moved while
     the tracker was silent".
   · Coverage is three figures — watched, inferred, unknown — and never one.

   ── DUBAI DAYS ───────────────────────────────────────────────────────────
   Dubai keeps UTC+4 all year. The caller hands fixes from either side of
   the day (the route reads six hours beyond each end, and the nearest fix
   further out); every interval is judged whole and only then cut at 00:00
   and 24:00, so a stay across midnight ends one day at 24:00 and resumes the
   next at 00:00 in the same place, and says since when. Minutes are whole:
   every boundary is rounded to the minute once, so the segments of a day add
   to exactly 1,440 (or to the minutes elapsed, on today). */
import { km, GAP_MIN, HOP_KM } from './where_routes.js';

export const STAY_RADIUS_KM = 0.15;
export const STAY_MIN = 10;
export const MOVING_CADENCE_MIN = GAP_MIN;
export const PARKED_CADENCE_MIN = Object.freeze({ cabman: 70, fms: 30 });
const PARKED_DEFAULT_MIN = 30;   // a source this module has not measured gets the stricter figure
export const SILENT_MIN = 1440;
/* How far beyond each end of the day the route reads fixes, so a stay that
   began the evening before is recognised as one (it needs its own fixes, not
   just the last one) and says since when. */
export const LOOK_AROUND_H = 6;
/* An FMS journey counts for a drive only when it lies inside the drive, give
   or take this: a journey that runs on across a stay (ignition left on at a
   rank) belongs to no single drive, and the drive keeps its fixes' distance. */
export const JOURNEY_SLACK_MIN = 10;

const DUBAI_MS = 4 * 3600_000;
const MIN = 60_000;
export const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`) - DUBAI_MS;
const ms = (t) => (typeof t === 'number' ? t : new Date(t).getTime());
const hhmm = (m) => (m >= 1440 ? '24:00'
  : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
export const localStamp = (t) => {
  const d = new Date(ms(t) + DUBAI_MS);
  return { day: d.toISOString().slice(0, 10),
    time: `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
};
const parkedCadence = (source) => PARKED_CADENCE_MIN[source] ?? PARKED_DEFAULT_MIN;
const real = (p) => p && p.lat != null && p.lng != null && Number.isFinite(Number(p.lat))
  && Number.isFinite(Number(p.lng)) && !(Math.abs(Number(p.lat)) < 1 && Math.abs(Number(p.lng)) < 1);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (x) => Math.round(x * 10) / 10;
const fmtDur = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const placeWord = (a) => a || 'ground the fleet has no name for';

/* The three bases a minute can rest on. A booking's span is 'unknown': its
   two ends are pinned (anchors), the minutes between are not placed — see
   "WHAT IS NEVER DONE" above. */
export const BASIS = Object.freeze({ stay: 'fixes', drive: 'fixes', parked: 'inferred', booking: 'unknown',
  moved: 'unknown', before_first: 'unknown', after_last: 'unknown', silent: 'unknown', no_tracker: 'unknown' });

/* Interval class from its two ends. Exported for the test. */
export function classify(a, b) {
  const gap = (b.t - a.t) / MIN;
  if (gap > SILENT_MIN) return 'silent';
  const near = km(a, b) <= STAY_RADIUS_KM;
  if (near) return gap <= parkedCadence(a.source) ? 'still' : 'parked';
  return gap <= MOVING_CADENCE_MIN ? 'moving' : 'moved';
}

/* The fixes the day is read from: positions only, one tracker. */
function pickTracker(points, d0, end) {
  const all = points.filter(real)
    .map((p) => ({ ...p, t: ms(p.at ?? p.captured_at), lat: Number(p.lat), lng: Number(p.lng) }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  const inDay = new Map();
  for (const p of all) if (p.t >= d0 && p.t < end) inDay.set(p.source, (inDay.get(p.source) || 0) + 1);
  let source = [...inDay.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
  if (!source) {
    /* No fix inside the day: the tracker whose reading is nearest the day,
       the one before it first (it is what the day inherited). */
    const before = all.filter((p) => p.t < d0).pop();
    source = before?.source ?? all.find((p) => p.t >= end)?.source ?? null;
  }
  const seen = new Set();
  const P = all.filter((p) => p.source === source && !seen.has(p.t) && seen.add(p.t));
  const second = [...inDay.entries()].filter(([s]) => s !== source).sort((a, b) => b[1] - a[1])[0];
  return { P, source, fixesInDay: inDay.get(source) || 0,
    second: second ? { source: second[0], fixes: second[1] } : null };
}

/* Runs of same-spot intervals, each anchored on its first fix so a slow
   creep cannot chain into one "place". A run under STAY_MIN is a pause inside
   a drive and its intervals become driving. Mutates `iv[k].cls` / `.run`. */
function markRuns(P, iv) {
  let run = 0;
  let k = 0;
  while (k < iv.length) {
    if (iv[k].cls !== 'still' && iv[k].cls !== 'parked') { k += 1; continue; }
    const anchor = P[k];
    let j = k;
    while (j < iv.length && (iv[j].cls === 'still' || iv[j].cls === 'parked')
      && km(anchor, P[j + 1]) <= STAY_RADIUS_KM) j += 1;
    if (j === k) {
      /* The pair is near but drifted off a previous anchor — judged alone. */
      j = k + 1;
    }
    const span = (P[j].t - P[k].t) / MIN;
    if (span >= STAY_MIN) {
      run += 1;
      for (let x = k; x < j; x += 1) iv[x].run = run;
    } else {
      for (let x = k; x < j; x += 1) if (iv[x].cls === 'still') iv[x].cls = 'moving';
    }
    k = j;
  }
}

/* The ground a stay is on: the name most of its fixes carry, so one stray
   fix on a cell boundary does not rename a two-hour stay (findStops' rule). */
function modalArea(pts) {
  const tally = new Map();
  for (const p of pts) if (p.area) tally.set(p.area, (tally.get(p.area) || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!top) return { area: null, area_votes: null };
  const votes = pts.find((p) => p.area === top[0])?.area_votes ?? null;
  return { area: top[0], area_votes: votes };
}

/* ── the day ───────────────────────────────────────────────────────────────
   points:   fixes, any source, any time (the route reads the day ± LOOK_AROUND_H
             and the nearest fix beyond each end): { at, lat, lng, source,
             area?, area_votes? }.
   bookings: completed bookings in this car: { platform, requested_at,
             ended_at, duration_s?, pickup_area?, dropoff_area? }.
   journeys: FMS journeys in this car: { started_at, ended_at, distance_km }.
   everFix:  the car's newest fix ever, for a car with nothing near the day. */
export function whereaboutsDay({ day, points = [], bookings = [], journeys = [], nowMs = Date.now(), everFix = null }) {
  const d0 = dayStartMs(day);
  const d1 = d0 + 1440 * MIN;
  const running = nowMs < d1;
  const end = Math.min(d1, nowMs);
  const endMin = Math.max(0, Math.round((end - d0) / MIN));
  const toMin = (t) => Math.min(endMin, Math.max(0, Math.round((t - d0) / MIN)));
  const out = { day, from: '00:00', to: hhmm(endMin), running, minutes: endMin,
    tracker: null, segments: [], stays: [], anchors: [], coverage: null };
  if (endMin <= 0) return { ...out, coverage: coverageOf([], 0) };

  const { P, source, fixesInDay, second } = pickTracker(points, d0, end);
  const iv = [];
  for (let k = 0; k + 1 < P.length; k += 1) iv.push({ a: P[k], b: P[k + 1], k, cls: classify(P[k], P[k + 1]), run: null });
  markRuns(P, iv);
  const observedGaps = iv.filter((x) => (x.cls === 'still' || x.cls === 'moving') && x.b.t > d0 && x.a.t < end)
    .map((x) => (x.b.t - x.a.t) / MIN);
  out.tracker = { source, fixes: fixesInDay, second,
    every_min: observedGaps.length ? Math.round(median(observedGaps)) : null,
    parked_cadence_min: source ? parkedCadence(source) : null, moving_cadence_min: MOVING_CADENCE_MIN,
    first_fix: P.find((p) => p.t >= d0 && p.t < end)?.at ?? null,
    last_fix: [...P].reverse().find((p) => p.t >= d0 && p.t < end)?.at ?? null };

  /* Pieces: every interval cut to the day, plus the two edges where no fix
     lies beyond. */
  const pieces = [];
  const push = (cls, s, e, extra = {}) => {
    const sm = toMin(s); const em = toMin(e);
    if (em > sm) pieces.push({ cls, s: sm, e: em, sMs: Math.max(s, d0), eMs: Math.min(e, end), ...extra });
  };
  if (!P.length) {
    push(everFix ? 'silent' : 'no_tracker', d0, end, everFix ? { last: { t: ms(everFix), at: everFix } } : {});
  } else {
    if (P[0].t > d0) push('before_first', d0, Math.min(P[0].t, end), { next: P[0] });
    for (const x of iv) push(x.cls, x.a.t, x.b.t, { iv: x, run: x.run, last: x.a, next: x.b });
    const last = P[P.length - 1];
    if (last.t < end) {
      /* Quiet until NOW, not until the end of the day (independent review,
         2026-11-16). The route reads the first fix after the day, so a last
         fix with nothing after it is a tracker that has not reported since —
         and the interval rule above calls a gap over a day 'silent' the moment
         a next fix closes it. Measured to the day's end instead, a unit that
         died at 01:00 on the 10th and is still dark on the 16th drew the 10th
         as "after the last fix of the day", and the † band answered "Silent
         over a day: No" for a tracker six days dark — the same silence named
         two ways depending on whether it had ended. On a running day now IS
         the end, so today reads exactly as before. */
      const quietFor = (nowMs - last.t) / MIN;
      push(quietFor > SILENT_MIN ? 'silent' : 'after_last', Math.max(last.t, d0), end, { last });
    }
  }

  /* Bookings that fall in a quiet stretch split it. */
  const jobs = bookings.map((b) => {
    const s = ms(b.requested_at); const e = ms(b.ended_at);
    const dur = Number(b.duration_s);
    const pick = Number.isFinite(dur) && dur > 0 ? e - dur * 1000 : null;
    return { ...b, s, e, pick: pick != null && pick >= s - MIN ? pick : null };
  }).filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s && b.e > d0 && b.s < end)
    .sort((a, b) => a.s - b.s);
  const QUIETS = new Set(['parked', 'moved', 'before_first', 'after_last', 'silent', 'no_tracker']);
  const split = [];
  for (const p of pieces) {
    if (!QUIETS.has(p.cls)) { split.push(p); continue; }
    const over = jobs.filter((b) => toMin(b.e) > p.s && toMin(b.s) < p.e);
    if (!over.length) { split.push(p); continue; }
    /* A booking in a parked-and-quiet stretch: the car was driven, so the
       inference falls and the rest of the stretch is movement nobody saw. */
    const rest = p.cls === 'parked' ? 'moved' : p.cls;
    let cur = p.s;
    for (const b of over) {
      const bs = Math.max(cur, toMin(b.s)); const be = Math.min(p.e, toMin(b.e));
      if (bs > cur) split.push({ ...p, cls: rest, s: cur, e: bs, brokenBy: p.cls === 'parked' ? b : null });
      if (be > bs) split.push({ ...p, cls: 'booking', s: bs, e: be, job: b, run: null });
      cur = Math.max(cur, be);
    }
    if (p.e > cur) split.push({ ...p, cls: rest, s: cur, e: p.e, brokenBy: p.cls === 'parked' ? over[over.length - 1] : null });
  }

  /* Merge into segments: a run's watched intervals are one stay; consecutive
     driving intervals are one drive; every quiet piece is its own segment. */
  const segs = [];
  for (const p of split) {
    const prev = segs[segs.length - 1];
    const kind = p.cls === 'still' ? 'stay' : p.cls === 'moving' ? 'drive' : 'quiet';
    const sameStay = kind === 'stay' && prev?.kind === 'stay' && prev.run === p.run && prev.end_min === p.s;
    const sameDrive = kind === 'drive' && prev?.kind === 'drive' && prev.end_min === p.s;
    if (sameStay || sameDrive) { prev.end_min = p.e; prev.ivs.push(p.iv); prev.eMs = p.eMs; continue; }
    /* One booking that spans two quiet stretches (a parked one it broke and a
       moved one after it) is one job: one segment, its ends anchored once. */
    if (p.cls === 'booking' && prev?.cls === 'booking' && prev.job === p.job && prev.end_min === p.s) {
      prev.end_min = p.e; prev.eMs = p.eMs; prev.next = p.next; continue;
    }
    segs.push({ kind, cls: p.cls, start_min: p.s, end_min: p.e, run: p.run ?? null, ivs: p.iv ? [p.iv] : [],
      sMs: p.sMs, eMs: p.eMs, last: p.last, next: p.next, job: p.job, brokenBy: p.brokenBy || null });
  }

  /* The fixes of each run, whole (beyond the day too), for its name and its
     "since" — so a stay across midnight is named the same on both days. */
  const runPts = new Map();
  iv.forEach((x) => {
    if (!x.run) return;
    if (!runPts.has(x.run)) runPts.set(x.run, [x.a]);
    runPts.get(x.run).push(x.b);
  });

  for (const s of segs) {
    s.minutes = s.end_min - s.start_min;
    s.from = hhmm(s.start_min); s.to = hhmm(s.end_min);
    s.basis = BASIS[s.kind === 'quiet' ? s.cls : s.kind];
    if (s.kind === 'stay' || s.cls === 'parked') {
      const pts = runPts.get(s.run) || [];
      Object.assign(s, modalArea(pts));
      const first = pts[0]; const lastP = pts[pts.length - 1];
      s.lat = first?.lat ?? null; s.lng = first?.lng ?? null;
      s.since = first && first.t < d0 ? first.at : null;
      /* "Since" is a lower bound when the run begins on the EARLIEST fix this
         day was handed (independent review, 2026-11-16). The route reads
         LOOK_AROUND_H before midnight plus the one fix before that, so a
         CABMAN car parked from 10:00 the day before reaches this module as a
         run starting at its 17:05 heartbeat, and the page said "there since
         17:05 the day before" of a car that had stood there seven hours
         longer. Nothing before P[0] was read, so the run may reach further
         back: it is "since at least". A run that begins after an earlier fix
         (a drive or a silence before it) began where it says. */
      s.since_at_least = Boolean(s.since) && first === P[0];
      s.until = lastP && lastP.t > end ? lastP.at : null;
    }
    if (s.kind === 'stay') {
      const gaps = s.ivs.map((x) => (x.b.t - x.a.t) / MIN);
      s.every_min = gaps.length ? Math.max(1, Math.round(median(gaps))) : null;
      s.fixes = (runPts.get(s.run) || []).filter((p) => p.t >= d0 + s.start_min * MIN - 30_000
        && p.t <= d0 + s.end_min * MIN + 30_000).length;
      s.how = `tracker fixes every ${s.every_min} min`;
      s.say = `Stood in ${placeWord(s.area)}; ${s.how}`
        + (s.since && s.start_min === 0
          ? `, there since ${s.since_at_least ? 'at least ' : ''}${localStamp(s.since).time} the day before`
            + (s.since_at_least ? ' (the earliest fix read for this day)' : '')
          : '') + '.';
    } else if (s.kind === 'drive') {
      let fixKm = 0;
      for (const x of s.ivs) {
        const step = km(x.a, x.b);
        if (step >= HOP_KM) continue;
        const whole = x.b.t - x.a.t;
        const inside = Math.min(x.b.t, end) - Math.max(x.a.t, d0);
        fixKm += whole > 0 ? step * Math.max(0, inside) / whole : 0;
      }
      const a = s.ivs[0].a; const b = s.ivs[s.ivs.length - 1].b;
      s.from_area = a.area || null; s.to_area = b.area || null;
      s.fixes = new Set(s.ivs.flatMap((x) => [x.a.t, x.b.t]).filter((t) => t >= d0 && t < end)).size;
      s.km_fixes = round1(fixKm);
      const lo = s.sMs - JOURNEY_SLACK_MIN * MIN; const hi = s.eMs + JOURNEY_SLACK_MIN * MIN;
      const inJ = journeys.filter((j) => j.distance_km != null && ms(j.started_at) >= lo && ms(j.ended_at) <= hi
        && ms(j.ended_at) > ms(j.started_at));
      s.km_journey = inJ.length ? round1(inJ.reduce((t, j) => t + Number(j.distance_km), 0)) : null;
      s.km = s.km_journey ?? s.km_fixes;
      s.km_basis = s.km_journey != null ? 'fms_journey' : 'fixes';
      const over = jobs.filter((j) => j.e > s.sMs && j.s < s.eMs);
      s.booking = over.length ? { n: over.length, platforms: [...new Set(over.map((j) => j.platform))],
        minutes: over.reduce((t, j) => t + Math.max(0, Math.round((Math.min(j.e, s.eMs) - Math.max(j.s, s.sMs)) / MIN)), 0) } : null;
      s.say = `Drove from ${placeWord(s.from_area)} to ${placeWord(s.to_area)}, ${s.km} km `
        + (s.km_basis === 'fms_journey' ? '(FMS’s own journey distance)' : '(between fixes)')
        + (s.booking ? `; on ${s.booking.n === 1 ? 'a booking' : `${s.booking.n} bookings`} (${s.booking.platforms.join(', ')})` : '') + '.';
    } else {
      s.quiet = s.cls;
      const lastAt = s.last?.at ?? null; const nextAt = s.next?.at ?? null;
      s.last_fix = lastAt; s.next_fix = nextAt;
      const when = (t) => { const l = localStamp(t); return l.day === day ? l.time : `${l.day} ${l.time}`; };
      if (s.cls === 'parked') {
        s.say = `Parked in ${placeWord(s.area)}, tracker quiet for ${fmtDur(s.minutes)} — inferred: the fixes either side `
          + `(${when(lastAt)} and ${when(nextAt)}) are within ${STAY_RADIUS_KM * 1000} m of each other, but nothing was reported between them.`;
      } else if (s.cls === 'moved') {
        s.from_area = s.last?.area || null; s.to_area = s.next?.area || null;
        s.apart_km = s.last && s.next ? round1(km(s.last, s.next)) : null;
        s.say = s.brokenBy
          ? `Moved while the tracker was silent — route not known. The fixes either side (${when(lastAt)} and ${when(nextAt)}) `
            + `are at one spot, but a ${s.brokenBy.platform} booking in this car from ${localStamp(s.brokenBy.s).time} shows it did not stand still.`
          : `Moved while the tracker was silent — route not known: ${placeWord(s.from_area)} at ${when(lastAt)}, `
            + `${placeWord(s.to_area)} at ${when(nextAt)}, ${s.apart_km} km apart in a straight line.`;
        if (s.brokenBy) s.broken_by_booking = true;
      } else if (s.cls === 'before_first') {
        /* "Of the day" only when the fix IS on this day: a tracker whose first
           position ever came later says so, with that date. */
        s.say = nextAt && localStamp(nextAt).day === day
          ? `Before the tracker’s first fix of the day (${when(nextAt)}); no earlier position is on record.`
          : `No fix on this day: the tracker’s first position on record is from ${when(nextAt)}.`;
      } else if (s.cls === 'after_last') {
        s.say = running && s.end_min === endMin
          ? `No fix since ${when(lastAt)} — the day is still running.`
          /* Off a running day the last fix is always on this day: one before it
             with nothing after would be over a day of silence, which is "silent". */
          : `After the tracker’s last fix of the day (${when(lastAt)}); no later position is on record.`;
      } else if (s.cls === 'silent') {
        const l = localStamp(lastAt);
        s.say = lastAt
          ? `No reading since ${l.day} ${l.time}. Past a day a parked car and a dead tracker look the same, so this is not called parked.`
          : 'No reading for over a day.';
      } else if (s.cls === 'no_tracker') {
        s.say = 'No tracker position has ever been recorded for this car.';
      } else if (s.cls === 'booking') {
        const j = s.job;
        s.platform = j.platform;
        s.from_area = j.pickup_area || null; s.to_area = j.dropoff_area || null;
        s.say = `On a ${j.platform} booking while the tracker was silent — route not known; its ends are from a booking, not a tracker fix: `
          + `${j.pick != null ? `picked up in ${placeWord(s.from_area)} at ${localStamp(j.pick).time}, ` : ''}dropped off in ${placeWord(s.to_area)} at ${localStamp(j.e).time}.`;
        const anchors = [];
        if (j.pick != null && j.pick >= d0 && j.pick < end) anchors.push({ at: new Date(j.pick).toISOString(), minute: toMin(j.pick), area: s.from_area, end: 'pickup' });
        if (j.e >= d0 && j.e <= end) anchors.push({ at: new Date(j.e).toISOString(), minute: toMin(j.e), area: s.to_area, end: 'dropoff' });
        /* Only an end that falls in THIS quiet stretch anchors anything: one
           inside a watched stretch is already placed by the tracker. */
        s.anchors = anchors.filter((a) => a.minute >= s.start_min && a.minute <= s.end_min)
          .map((a) => ({ ...a, time: hhmm(a.minute), platform: j.platform, basis: 'booking' }));
        out.anchors.push(...s.anchors);
      }
    }
  }

  const INTERNAL = new Set(['ivs', 'cls', 'run', 'sMs', 'eMs', 'last', 'next', 'job', 'brokenBy']);
  out.segments = segs.map((s) => Object.fromEntries(Object.entries(s)
    .filter(([k, v]) => !INTERNAL.has(k) && v !== undefined)));
  out.stays = staysOf(segs, d0);
  out.coverage = coverageOf(out.segments, endMin);
  return out;
}

/* The stays table: a run's watched stretches and its parked-and-quiet
   stretches joined back into one stay, with how much of it was watched. */
function staysOf(segs, d0) {
  const rows = [];
  for (const s of segs) {
    if (!(s.kind === 'stay' || s.cls === 'parked')) continue;
    const prev = rows[rows.length - 1];
    if (prev && prev.run === s.run && prev.end_min === s.start_min) {
      prev.end_min = s.end_min;
      prev[s.kind === 'stay' ? 'watched_min' : 'inferred_min'] += s.minutes;
      if (s.every_min) prev.every.push(s.every_min);
      prev.until = s.until; prev.fixes += s.fixes || 0;
      continue;
    }
    rows.push({ run: s.run, area: s.area, area_votes: s.area_votes, lat: s.lat, lng: s.lng,
      start_min: s.start_min, end_min: s.end_min, since: s.since, since_at_least: Boolean(s.since_at_least),
      until: s.until, fixes: s.fixes || 0,
      watched_min: s.kind === 'stay' ? s.minutes : 0, inferred_min: s.kind === 'stay' ? 0 : s.minutes,
      every: s.every_min ? [s.every_min] : [] });
  }
  return rows.map(({ run, every, ...r }) => {
    const minutes = r.end_min - r.start_min;
    const basis = r.inferred_min === 0 ? 'fixes' : r.watched_min === 0 ? 'inferred' : 'fixes and inferred';
    const cadence = every.length ? Math.round(median(every)) : null;
    const how = basis === 'fixes' ? `tracker fixes every ${cadence} min`
      : basis === 'inferred' ? `inferred: a fix at this spot either side of ${fmtDur(minutes)} with no report between`
        : `tracker fixes every ${cadence} min for ${fmtDur(r.watched_min)}; parked with the tracker quiet for ${fmtDur(r.inferred_min)} (inferred)`;
    return { ...r, minutes, from: hhmm(r.start_min), to: hhmm(r.end_min), basis, how,
      carried_in: r.start_min === 0 && Boolean(r.since), carried_on: Boolean(r.until) };
  });
}

/* Three figures, never one: watched, inferred, unknown — of the minutes the
   day has had. Percentages to one place; the minutes add to the whole. */
export function coverageOf(segments, minutes) {
  const by = { fixes: 0, inferred: 0, unknown: 0 };
  for (const s of segments) by[s.basis] = (by[s.basis] || 0) + s.minutes;
  const pct = (x) => (minutes ? Math.round((x / minutes) * 1000) / 10 : null);
  return { minutes, positioned_min: by.fixes, inferred_min: by.inferred, unknown_min: by.unknown,
    positioned_pct: pct(by.fixes), inferred_pct: pct(by.inferred), unknown_pct: pct(by.unknown) };
}

/* A week (or any run of days): each day on its own, and the three figures
   summed over the days. */
export function sumCoverage(days) {
  const t = days.reduce((a, d) => ({ minutes: a.minutes + d.coverage.minutes,
    p: a.p + d.coverage.positioned_min, i: a.i + d.coverage.inferred_min, u: a.u + d.coverage.unknown_min }),
  { minutes: 0, p: 0, i: 0, u: 0 });
  const pct = (x) => (t.minutes ? Math.round((x / t.minutes) * 1000) / 10 : null);
  return { minutes: t.minutes, positioned_min: t.p, inferred_min: t.i, unknown_min: t.u,
    positioned_pct: pct(t.p), inferred_pct: pct(t.i), unknown_pct: pct(t.u) };
}

/* ── the answer the route sends (and the mock, so the page draws the same) ──
   TWICE PER DAY, ON PURPOSE. The tracker's own account (no booking read) is
   the answer every role with locations may see; the same day with the
   bookings laid into its quiet stretches is booking DETAIL — when a job ran,
   on which channel, where it dropped off — and goes in `with_bookings`,
   which the manifest classes BK, so a Fleet technician (bookings as totals
   only) is handed the tracker's day and not the jobs. A booking cannot be
   stripped out of a segment list element by element; a whole second account
   can be withheld in one path. */
export function whereaboutsBody({ plate, fleetId = null, days, points = [], bookings = [], journeys = [], nowMs = Date.now() }) {
  const out = days.map((day) => {
    const { anchors: _none, ...bare } = whereaboutsDay({ day, points, journeys, nowMs });
    const booked = whereaboutsDay({ day, points, bookings, journeys, nowMs });
    const d0 = dayStartMs(day);
    const seen = bookings.filter((b) => ms(b.ended_at) > d0 && ms(b.requested_at) < d0 + 1440 * MIN).length;
    return { ...bare, with_bookings: { bookings: seen, segments: booked.segments, stays: booked.stays,
      anchors: booked.anchors, coverage: booked.coverage } };
  });
  return {
    plate, fleet_id: fleetId, days: out,
    coverage: sumCoverage(out),
    coverage_with_bookings: sumCoverage(out.map((d) => d.with_bookings)),
    rules: {
      stay_radius_m: STAY_RADIUS_KM * 1000, stay_min: STAY_MIN,
      parked_cadence_min: PARKED_CADENCE_MIN, moving_cadence_min: MOVING_CADENCE_MIN, silent_min: SILENT_MIN,
      stay: `fixes within ${STAY_RADIUS_KM * 1000} m of where it began for ${STAY_MIN} minutes or more`,
      watched: `two fixes at one spot within the tracker's parked rhythm (CABMAN ${PARKED_CADENCE_MIN.cabman} min, `
        + `FMS ${PARKED_CADENCE_MIN.fms} min), or at different spots within ${MOVING_CADENCE_MIN} minutes: `
        + 'the tracker files on movement, so it would have reported in between',
      inferred: 'parked with the tracker quiet past its rhythm (a fix at one spot either side, nothing between)',
      unknown: 'moved while the tracker was silent (on a booking or not: a booking pins its pickup and drop-off, '
        + `not the route between), before the first fix or after the last, or silent over ${SILENT_MIN / 60} hours`,
    },
    area_why: 'An area is the fleet’s own name for a half-kilometre cell, learnt from its FMS trips; '
      + 'ground the fleet has never driven near has no name and is left unnamed rather than guessed.',
  };
}
