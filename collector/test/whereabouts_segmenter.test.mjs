/* Where the car was, every minute of a Dubai day — the arithmetic (WHR,
   2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   The operator: "whether pick up or drop off, we should ideally know where
   the car was at all times." api/whereabouts.js turns a tracker's fixes into
   a day of STAY, DRIVE and QUIET segments, each with the basis it rests on,
   and three coverage figures. This file drives it with synthetic fixes —
   no database — on every rule the module states:

     §1  the stay radius: wander inside 150 m is one stay; a fix 200 m off is
         not part of it;
     §2  a drive between two stays, with its distance, its two areas, and the
         FMS journey's own distance where the journey lies inside it;
     §3  a quiet gap at one spot → "parked, tracker quiet" (INFERRED), joined
         back into one stay in the stays table; a quiet gap whose ends differ
         → "moved while the tracker was silent" (unknown), with how far apart;
     §4  the edges: before the first fix of the day, after the last; a
         tracker silent over a day is "no reading since", even when its two
         ends are one spot; a car with no position ever;
     §5  Dubai midnight: a stay across it ends at 24:00 and resumes at 00:00
         the next day in the same place, saying since when;
     §6  a booking in a quiet stretch anchors it — "from a booking", never a
         fix — and a booking inside a parked-and-quiet stretch breaks the
         inference;
     §7  coverage is three figures adding to the day's minutes; today stops
         at now; two trackers are never mixed.

   Synthetic data only. */
import { whereaboutsDay, classify, coverageOf, STAY_RADIUS_KM, PARKED_CADENCE_MIN, SILENT_MIN }
  from '../api/whereabouts.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const D = '2026-11-10';
const NEXT = '2026-11-11';
const PAST = Date.parse('2026-11-20T00:00:00Z');   // every test day is over
/* A Dubai wall-clock time on a day, as an ISO instant. */
const at = (day, hm) => new Date(Date.parse(`${day}T${hm}:00+04:00`)).toISOString();
/* Metres north / east of a point near Dubai, in degrees. */
const BASE = { lat: 25.2, lng: 55.3 };
const off = (n = 0, e = 0) => ({ lat: BASE.lat + n / 111_000, lng: BASE.lng + e / (111_000 * Math.cos(BASE.lat * Math.PI / 180)) });
const fix = (day, hm, n = 0, e = 0, source = 'fms', area = 'Test Quarter') => ({ at: at(day, hm), ...off(n, e), source, area, area_votes: 9 });
/* Every `step` minutes from `from` to `to` (inclusive), at one spot or along a line. */
const series = (day, from, to, step, place = () => [0, 0], source = 'fms', area = 'Test Quarter') => {
  const out = [];
  const [fh, fm] = from.split(':').map(Number); const [th, tm] = to.split(':').map(Number);
  for (let m = fh * 60 + fm, i = 0; m <= th * 60 + tm; m += step, i += 1) {
    const hm = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const [n, e] = place(i);
    out.push(fix(day, hm, n, e, source, area));
  }
  return out;
};
const tiles = (r) => {
  let m = 0;
  for (const s of r.segments) { if (s.start_min !== m || s.end_min <= s.start_min) return false; m = s.end_min; }
  return m === r.minutes;
};
const kinds = (r) => r.segments.map((s) => (s.kind === 'quiet' ? `quiet:${s.quiet}` : s.kind)).join(' ');

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 the stay radius');
{
  check(`the radius is ${STAY_RADIUS_KM * 1000} m, as measured`, STAY_RADIUS_KM === 0.15);
  // A whole day at one spot, wandering up to 100 m — FMS every 10 minutes.
  const pts = [...series(D, '00:00', '23:50', 10, (i) => [(i % 3) * 50, (i % 2) * 40]), fix(NEXT, '00:00')];
  const r = whereaboutsDay({ day: D, points: pts, nowMs: PAST });
  check('wander inside the radius is ONE stay', r.segments.filter((s) => s.kind === 'stay').length === 1, kinds(r));
  check('…named by the area its fixes carry', r.stays[0]?.area === 'Test Quarter', JSON.stringify(r.stays[0]));
  check('…and said as watched, with the tracker’s rhythm', r.stays[0]?.basis === 'fixes'
    && /every 10 min/.test(r.stays[0]?.how || ''), JSON.stringify(r.stays[0]));
  // The same day, but the 12:00 fix is 500 m away (another spot) and back.
  const moved = pts.map((p) => (p.at === at(D, '12:00') ? { ...p, ...off(500, 0) } : p));
  const r2 = whereaboutsDay({ day: D, points: moved, nowMs: PAST });
  check('a fix 500 m off is not part of the stay: the stay ends, a drive, another stay',
    r2.segments.filter((s) => s.kind === 'stay').length === 2 && r2.segments.some((s) => s.kind === 'drive'), kinds(r2));
  check('classify(): 140 m apart 10 minutes apart is still', classify(
    { t: 0, ...off(0, 0), source: 'fms' }, { t: 600_000, ...off(140, 0), source: 'fms' }) === 'still');
  check('classify(): 160 m apart 10 minutes apart is moving', classify(
    { t: 0, ...off(0, 0), source: 'fms' }, { t: 600_000, ...off(160, 0), source: 'fms' }) === 'moving');
}

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 a drive between two stays');
{
  const pts = [
    ...series(D, '00:00', '08:00', 10),                                       // stay at A
    ...series(D, '08:05', '08:40', 5, (i) => [(i + 1) * 1000, 0], 'fms', 'Road'),  // 8 km north, 1 km a fix
    ...series(D, '08:45', '23:55', 10, () => [9000, 0], 'fms', 'Far Quarter'),   // stay at B, 9 km north
    fix(NEXT, '00:05', 9000, 0, 'fms', 'Far Quarter'),
  ];
  const r = whereaboutsDay({ day: D, points: pts, nowMs: PAST });
  check('stay, drive, stay — and every minute is one of them', kinds(r) === 'stay drive stay' && tiles(r), kinds(r));
  const dr = r.segments.find((s) => s.kind === 'drive');
  check('the drive runs from the last fix at A to the first at B', dr?.from === '08:00' && dr?.to === '08:45', JSON.stringify(dr));
  check('…from area to area', dr?.from_area === 'Test Quarter' && dr?.to_area === 'Far Quarter', JSON.stringify(dr));
  check('…9 km, measured between fixes', dr?.km === 9 && dr?.km_basis === 'fixes', JSON.stringify(dr));
  check('the second stay is named by its own fixes', r.stays[1]?.area === 'Far Quarter', JSON.stringify(r.stays));
  // A five-minute pause at a light inside the drive is part of the drive.
  const light = pts.map((p) => (p.at === at(D, '08:25') ? { ...p, ...off(4000, 0) } : p));
  const rl = whereaboutsDay({ day: D, points: light, nowMs: PAST });
  check(`a same-spot pause shorter than ${10} minutes is a light inside the drive, not a stay`,
    kinds(rl) === 'stay drive stay', kinds(rl));
  // An FMS journey that lies inside the drive gives its own distance.
  const j = [{ started_at: at(D, '08:02'), ended_at: at(D, '08:44'), distance_km: 9.6 }];
  const rj = whereaboutsDay({ day: D, points: pts, journeys: j, nowMs: PAST });
  const dj = rj.segments.find((s) => s.kind === 'drive');
  check('an FMS journey inside the drive gives the distance, and says so', dj?.km === 9.6 && dj?.km_basis === 'fms_journey'
    && dj?.km_fixes === 9, JSON.stringify(dj));
  // A journey that runs on across the stay at B belongs to no one drive.
  const j2 = [{ started_at: at(D, '08:02'), ended_at: at(D, '11:00'), distance_km: 14 }];
  const dk = whereaboutsDay({ day: D, points: pts, journeys: j2, nowMs: PAST }).segments.find((s) => s.kind === 'drive');
  check('…but a journey that runs on across a stay is not this drive’s distance', dk?.km === 9 && dk?.km_basis === 'fixes', JSON.stringify(dk));
  // A booking over the drive marks it as on a job.
  const b = [{ platform: 'uber', requested_at: at(D, '08:03'), ended_at: at(D, '08:44'), duration_s: 2100 }];
  const db = whereaboutsDay({ day: D, points: pts, bookings: b, nowMs: PAST }).segments.find((s) => s.kind === 'drive');
  check('a booking over a drive says it was on a job, and on which channel', db?.booking?.n === 1
    && db.booking.platforms[0] === 'uber' && /on a booking \(uber\)/.test(db.say), JSON.stringify(db));
}

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 quiet gaps: parked (inferred) and moved (unknown)');
{
  check(`the parked cadences are CABMAN ${PARKED_CADENCE_MIN.cabman}, FMS ${PARKED_CADENCE_MIN.fms}`,
    PARKED_CADENCE_MIN.cabman === 70 && PARKED_CADENCE_MIN.fms === 30);
  // FMS every 10 min until 01:00, silent, then from 05:00 at the same spot.
  const pts = [...series(D, '00:00', '01:00', 10), ...series(D, '05:00', '23:50', 10, () => [30, 20]), fix(NEXT, '00:00', 30, 20)];
  const r = whereaboutsDay({ day: D, points: pts, nowMs: PAST });
  const q = r.segments.find((s) => s.kind === 'quiet');
  check('a silence with both ends at one spot is "parked, tracker quiet"', q?.quiet === 'parked' && q.from === '01:00'
    && q.to === '05:00', JSON.stringify(q));
  check('…labelled INFERRED, never watched', q?.basis === 'inferred' && /inferred/.test(q.say), q?.say);
  check('…with the area of the stay it is part of', q?.area === 'Test Quarter', JSON.stringify(q));
  check('the stays table joins it back into one stay, watched and inferred', r.stays.length === 1
    && r.stays[0].basis === 'fixes and inferred' && r.stays[0].inferred_min === 240
    && r.stays[0].watched_min === 1440 - 240, JSON.stringify(r.stays));
  check('coverage counts the four hours as inferred, not positioned', r.coverage.inferred_min === 240
    && r.coverage.positioned_min === 1200 && r.coverage.unknown_min === 0, JSON.stringify(r.coverage));
  // The same hourly rhythm on CABMAN is the tracker's own parked cadence: watched.
  const cab = series(D, '00:00', '23:00', 60, () => [0, 0], 'cabman');
  const rc = whereaboutsDay({ day: D, points: [...cab, fix(NEXT, '00:00', 0, 0, 'cabman')], nowMs: PAST });
  check('CABMAN hourly at one spot is its parked heartbeat — watched, not inferred', rc.coverage.positioned_min === 1440
    && rc.coverage.inferred_min === 0, JSON.stringify(rc.coverage));
  // …and on FMS, hourly at one spot is past its cadence: inferred.
  const fms = series(D, '00:00', '23:00', 60);
  const rf = whereaboutsDay({ day: D, points: [...fms, fix(NEXT, '00:00')], nowMs: PAST });
  check('…while FMS hourly at one spot is past ITS cadence — inferred', rf.coverage.inferred_min === 1440, JSON.stringify(rf.coverage));
  // A silence whose two ends are 5 km apart.
  const mv = [...series(D, '00:00', '10:00', 10), ...series(D, '11:00', '23:50', 10, () => [5000, 0], 'fms', 'Far Quarter'),
    fix(NEXT, '00:00', 5000, 0, 'fms', 'Far Quarter')];
  const rm = whereaboutsDay({ day: D, points: mv, nowMs: PAST });
  const qm = rm.segments.find((s) => s.kind === 'quiet');
  check('a silence with the car somewhere else after it is "moved — route not known"', qm?.quiet === 'moved'
    && qm.basis === 'unknown' && /route not known/.test(qm.say), JSON.stringify(qm));
  check('…naming both ends and how far apart they are in a straight line', qm?.from_area === 'Test Quarter'
    && qm?.to_area === 'Far Quarter' && qm?.apart_km === 5, JSON.stringify(qm));
  check('…counted unknown', rm.coverage.unknown_min === 60, JSON.stringify(rm.coverage));
  check('no drive is invented across the silence', !rm.segments.some((s) => s.kind === 'drive'), kinds(rm));
}

/* ── §4 ─────────────────────────────────────────────────────────────────── */
console.log('\n§4 first and last of the day, a dead tracker, no tracker');
{
  const pts = series(D, '07:00', '20:00', 10);
  /* Read the next morning, ten hours after the last fix: "after the last
     fix" is a silence under a day. (Read on the 20th it is nine days of
     silence — the review's check below.) */
  const r = whereaboutsDay({ day: D, points: pts, nowMs: Date.parse(at(NEXT, '06:00')) });
  check('before the first fix of the day is said as such', r.segments[0]?.quiet === 'before_first'
    && r.segments[0].to === '07:00' && /first fix of the day/.test(r.segments[0].say), JSON.stringify(r.segments[0]));
  const last = r.segments[r.segments.length - 1];
  check('…and after the last', last?.quiet === 'after_last' && last.from === '20:00' && last.to === '24:00'
    && /last fix of the day/.test(last.say), JSON.stringify(last));
  check('…both unknown', r.coverage.unknown_min === 7 * 60 + 4 * 60, JSON.stringify(r.coverage));
  /* Independent review, 2026-11-16: the same last fix with the tracker still
     dark NINE DAYS later is a silence over a day, the rule the interval
     classifier applies the moment a next fix closes the gap — never "after the
     last fix of the day" beside a † band answering "Silent over a day: No".
     REVERSION: measure after_last's quiet to the day's end (`end - last.t`)
     instead of to now — this fails, the stretch reads after_last. */
  const darkSince = whereaboutsDay({ day: D, points: pts, nowMs: PAST });
  const tailDark = darkSince.segments[darkSince.segments.length - 1];
  check('a last fix with the tracker dark ever since (over a day, to now) is "no reading since", not "after the last fix"',
    tailDark?.quiet === 'silent' && tailDark.from === '20:00' && tailDark.to === '24:00'
    && /No reading since 2026-11-10 20:00/.test(tailDark.say) && tailDark.basis === 'unknown', JSON.stringify(tailDark));
  // A fix the evening before at the same spot: the morning is parked-and-quiet, not "before the first fix".
  const r2 = whereaboutsDay({ day: D, points: [fix('2026-11-09', '22:00'), ...pts], nowMs: PAST });
  check('with a fix the evening before at the same spot, the morning is parked, tracker quiet',
    r2.segments[0]?.quiet === 'parked' && r2.segments[0].start_min === 0, JSON.stringify(r2.segments[0]));
  // A dead tracker: the last fix three days before.
  const dead = [fix('2026-11-07', '14:20')];
  const rd = whereaboutsDay({ day: D, points: dead, nowMs: PAST, everFix: dead[0].at });
  check('a tracker silent over a day: the whole day is "no reading since"', rd.segments.length === 1
    && rd.segments[0].quiet === 'silent' && /No reading since 2026-11-07 14:20/.test(rd.segments[0].say), JSON.stringify(rd.segments));
  check('…unknown, every minute of it', rd.coverage.unknown_min === 1440 && rd.coverage.positioned_min === 0);
  // Silent for 30 hours and back at the very same spot: still not "parked".
  const back = [fix('2026-11-09', '20:00'), fix(NEXT, '02:00')];
  const rb = whereaboutsDay({ day: D, points: back, nowMs: PAST });
  check(`over ${SILENT_MIN / 60} h of silence is never called parked, even at one spot`,
    rb.segments.every((s) => s.quiet === 'silent'), kinds(rb));
  // A tracker whose first position ever is the day after: not "the first fix of the day".
  const later = whereaboutsDay({ day: D, points: [fix(NEXT, '08:00')], nowMs: PAST });
  check('a tracker first heard from the next day: "No fix on this day", with that date', later.segments.length === 1
    && later.segments[0].quiet === 'before_first' && /No fix on this day: .* 2026-11-11 08:00/.test(later.segments[0].say),
  JSON.stringify(later.segments));
  // Last heard the evening before, nothing since, under a day: not "the last fix of the day".
  const eve = whereaboutsDay({ day: D, points: [fix('2026-11-09', '20:00')], nowMs: Date.parse(at(D, '12:00')) + 3 * 3600e3 });
  check('last heard the evening before (under a day): "No fix since 2026-11-09 20:00", never "of the day"',
    eve.segments.every((s) => s.quiet === 'after_last' || s.quiet === 'silent')
    && /No fix since 2026-11-09 20:00/.test(eve.segments[0].say) && !/of the day/.test(eve.segments[0].say), JSON.stringify(eve.segments));
  // One booking spanning two quiet stretches, its pickup (12:00) on their boundary: one job, one anchor each end.
  const two = whereaboutsDay({ day: D, nowMs: PAST,
    points: [...series(D, '00:00', '10:00', 60, () => [0, 0], 'cabman'), fix(D, '12:00', 0, 0, 'cabman'),
      ...series(D, '14:00', '23:00', 60, () => [6000, 0], 'cabman'), fix(NEXT, '00:00', 6000, 0, 'cabman')],
    bookings: [{ platform: 'uber', requested_at: at(D, '11:00'), ended_at: at(D, '13:00'), duration_s: 3600 }] });
  check('a booking spanning two quiet stretches is one segment, each end anchored once', two.anchors.length === 2
    && two.anchors.filter((a) => a.end === 'pickup').length === 1 && two.segments.filter((s) => s.quiet === 'booking').length === 1,
    JSON.stringify(two.anchors));
  const none = whereaboutsDay({ day: D, points: [], nowMs: PAST });
  check('a car with no position ever says so', none.segments[0]?.quiet === 'no_tracker' && none.coverage.unknown_min === 1440,
    JSON.stringify(none.segments));
  // A 0,0 fix is no position (a lost satellite lock).
  const z = whereaboutsDay({ day: D, points: [...pts, { at: at(D, '21:00'), lat: 0, lng: 0, source: 'fms' }], nowMs: PAST });
  check('a 0,0 fix is not a position', z.segments[z.segments.length - 1]?.from === '20:00', kinds(z));
}

/* ── §5 ─────────────────────────────────────────────────────────────────── */
console.log('\n§5 Dubai midnight');
{
  // CABMAN, parked from 21:00 to 07:00 at one spot, hourly; driving either side.
  const pts = [
    ...series(D, '18:00', '20:55', 5, (i) => [i * 400, 0], 'cabman', 'Road'),
    ...series(D, '21:00', '23:00', 60, () => [30000, 0], 'cabman', 'Home Quarter'),
    ...series(NEXT, '00:00', '07:00', 60, () => [30000, 0], 'cabman', 'Home Quarter'),
    ...series(NEXT, '07:05', '09:00', 5, (i) => [30000 - i * 400, 0], 'cabman', 'Road'),
  ];
  const a = whereaboutsDay({ day: D, points: pts, nowMs: PAST });
  const b = whereaboutsDay({ day: NEXT, points: pts, nowMs: PAST });
  const lastA = a.segments[a.segments.length - 1];
  const firstB = b.segments[0];
  check('the stay is cut at 24:00…', lastA?.kind === 'stay' && lastA.to === '24:00' && lastA.end_min === 1440, JSON.stringify(lastA));
  check('…and resumes at 00:00 the next day, in the same place', firstB?.kind === 'stay' && firstB.from === '00:00'
    && firstB.area === lastA.area && firstB.area === 'Home Quarter', JSON.stringify(firstB));
  check('…saying since when (21:00 the day before)', b.stays[0]?.carried_in === true
    && b.stays[0].since === at(D, '21:00') && /since 21:00 the day before/.test(firstB.say), JSON.stringify(b.stays[0]));
  check('the first day knows the stay goes on past midnight', a.stays[a.stays.length - 1]?.carried_on === true,
    JSON.stringify(a.stays[a.stays.length - 1]));
  check('both days tile exactly', tiles(a) && tiles(b), `${kinds(a)} | ${kinds(b)}`);
  check('…and a stay that began after a drive says exactly since when, not "at least"', b.stays[0]?.since_at_least === false
    && !/at least/.test(firstB.say), JSON.stringify(b.stays[0]));
  /* Independent review, 2026-11-16: the route reads six hours before
     midnight and one fix before that. A run that begins on that EARLIEST fix
     may reach further back, so its "since" is a bound: a CABMAN car parked
     since 10:00 reached the module from its 17:05 heartbeat and was said to be
     "there since 17:05". REVERSION: set since_at_least to false always — this
     fails. */
  const edge = [...series(D, '17:05', '23:05', 60, () => [0, 0], 'cabman'),
    ...series(NEXT, '00:05', '08:05', 60, () => [0, 0], 'cabman'),
    ...series(NEXT, '08:10', '08:40', 5, (i) => [(i + 1) * 800, 0], 'cabman', 'Road'),
    ...series(NEXT, '09:00', '23:00', 60, () => [8000, 0], 'cabman', 'Far Quarter'),
    fix('2026-11-12', '00:00', 8000, 0, 'cabman', 'Far Quarter')];
  const w = whereaboutsDay({ day: NEXT, points: edge, nowMs: PAST });
  check('a stay that begins on the earliest fix read says "since at least", in the segment and the stays table',
    w.stays[0]?.carried_in === true && w.stays[0].since_at_least === true && w.stays[0].since === at(D, '17:05')
    && /there since at least 17:05 the day before/.test(w.segments[0]?.say || ''), JSON.stringify([w.stays[0], w.segments[0]?.say]));
  check('the day before 18:00 had no fix: said, not drawn', a.segments[0]?.quiet === 'before_first' && a.segments[0].to === '18:00',
    JSON.stringify(a.segments[0]));
}

/* ── §6 ─────────────────────────────────────────────────────────────────── */
console.log('\n§6 a booking in a quiet stretch');
{
  // CABMAN at A until 10:00, nothing, then at B (6 km away) from 14:00.
  const pts = [...series(D, '00:00', '10:00', 60, () => [0, 0], 'cabman'),
    ...series(D, '14:00', '23:00', 60, () => [6000, 0], 'cabman', 'Far Quarter'), fix(NEXT, '00:00', 6000, 0, 'cabman', 'Far Quarter')];
  const bookings = [{ platform: 'bolt', requested_at: at(D, '11:00'), ended_at: at(D, '11:40'), duration_s: 1800,
    pickup_area: 'Pickup Quarter', dropoff_area: 'Dropoff Quarter' }];
  const r = whereaboutsDay({ day: D, points: pts, bookings, nowMs: PAST });
  check('the quiet stretch splits round the booking', kinds(r) === 'stay quiet:moved quiet:booking quiet:moved stay', kinds(r));
  const bk = r.segments.find((s) => s.quiet === 'booking');
  check('…the booking’s span is "from a booking, not a tracker fix"', bk?.from === '11:00' && bk?.to === '11:40'
    && /from a booking, not a tracker fix/.test(bk.say), JSON.stringify(bk));
  /* Independent review, 2026-11-16: a job pins where it began and ended, not
     the road between — the minutes of a booking in a silence are unknown, as
     a "moved" stretch with two fixes for ends is. REVERSION: BASIS.booking
     back to 'inferred' — this fails (inferred 40). */
  check('…counted unknown, never inferred or positioned: its route is not known', bk?.basis === 'unknown'
    && /route not known/.test(bk.say) && r.coverage.inferred_min === 0
    && r.coverage.positioned_min === 600 + 600 && r.coverage.unknown_min === 240, JSON.stringify(r.coverage));
  check('…and its pickup (by the trip’s duration) and drop-off anchor the car’s ground',
    r.anchors.length === 2 && r.anchors[0].end === 'pickup' && r.anchors[0].time === '11:10'
    && r.anchors[0].area === 'Pickup Quarter' && r.anchors[1].end === 'dropoff' && r.anchors[1].time === '11:40'
    && r.anchors.every((x) => x.basis === 'booking'), JSON.stringify(r.anchors));
  // No duration: the span still counts; only the drop-off anchors.
  const r2 = whereaboutsDay({ day: D, points: pts, bookings: [{ ...bookings[0], duration_s: null }], nowMs: PAST });
  check('without a duration only the drop-off anchors (requested is not picked up)', r2.anchors.length === 1
    && r2.anchors[0].end === 'dropoff', JSON.stringify(r2.anchors));
  // A booking inside a parked-and-quiet stretch: the car was not standing still.
  const parked = [...series(D, '00:00', '01:00', 10), ...series(D, '05:00', '23:50', 10), fix(NEXT, '00:00')];
  const rp = whereaboutsDay({ day: D, points: parked, nowMs: PAST,
    bookings: [{ platform: 'uber', requested_at: at(D, '02:00'), ended_at: at(D, '02:30'), duration_s: 1200 }] });
  check('a booking in a parked-and-quiet stretch breaks the inference: the rest is movement nobody saw',
    kinds(rp) === 'stay quiet:moved quiet:booking quiet:moved stay', kinds(rp));
  check('…and says why', rp.segments.filter((s) => s.quiet === 'moved').every((s) => s.broken_by_booking === true
    && /did not stand still/.test(s.say)), JSON.stringify(rp.segments.filter((s) => s.quiet === 'moved')));
  check('…so none of it is counted parked (nor the job itself inferred)', rp.coverage.inferred_min === 0, JSON.stringify(rp.coverage));
  // A booking that began while the tracker watched and ended in the silence:
  // its pickup (09:30, watched) anchors nothing; its drop-off (11:40) does.
  const rl = whereaboutsDay({ day: D, points: pts, nowMs: PAST, bookings: [{ ...bookings[0],
    requested_at: at(D, '09:20'), ended_at: at(D, '11:40'), duration_s: 7800 }] });
  check('only a booking end inside the quiet stretch anchors: a pickup the tracker watched does not',
    rl.anchors.length === 1 && rl.anchors[0].end === 'dropoff' && rl.anchors[0].time === '11:40', JSON.stringify(rl.anchors));
  // A booking anchor inside a watched stretch anchors nothing.
  const watched = [...series(D, '00:00', '23:50', 10), fix(NEXT, '00:00')];
  const rw = whereaboutsDay({ day: D, points: watched, nowMs: PAST, bookings });
  check('a booking where the tracker was watching anchors nothing', rw.anchors.length === 0
    && !rw.segments.some((s) => s.quiet === 'booking'), kinds(rw));
}

/* ── §7 ─────────────────────────────────────────────────────────────────── */
console.log('\n§7 coverage, today, two trackers');
{
  const pts = [...series(D, '06:00', '12:00', 10), ...series(D, '13:00', '20:00', 10, () => [5000, 0])];
  const r = whereaboutsDay({ day: D, points: pts, nowMs: PAST });
  const c = r.coverage;
  check('three figures, adding to the day', c.positioned_min + c.inferred_min + c.unknown_min === 1440
    && c.minutes === 1440, JSON.stringify(c));
  check('…as minutes and as shares', c.positioned_pct === Math.round(c.positioned_min / 1440 * 1000) / 10
    && typeof c.unknown_pct === 'number', JSON.stringify(c));
  check('coverageOf() of nothing is absent, not 0%', coverageOf([], 0).positioned_pct === null);
  // Today: the day stops at now.
  const now = Date.parse(at(D, '15:35'));
  const t = whereaboutsDay({ day: D, points: pts.filter((p) => Date.parse(p.at) <= now), nowMs: now });
  check('today runs to now, not to 24:00', t.running === true && t.minutes === 935 && t.to === '15:35' && tiles(t), JSON.stringify({ m: t.minutes, to: t.to }));
  const tail = t.segments[t.segments.length - 1];
  check('…and the minutes since the last fix are "no fix since", the day still running', tail.quiet === 'after_last'
    && tail.from === '15:30' && /No fix since 15:30 — the day is still running/.test(tail.say), JSON.stringify(tail));
  // Two trackers: the one with more fixes is read, the other named.
  // Three minutes off the FMS fixes' clock, so no timestamp coincides.
  const cab = series(D, '06:03', '20:03', 60, (i) => [i * 50, 2000], 'cabman', 'Elsewhere');
  const two = whereaboutsDay({ day: D, points: [...pts, ...cab], nowMs: PAST });
  check('two trackers: the one with more fixes that day is read', two.tracker.source === 'fms'
    && two.tracker.second?.source === 'cabman' && two.tracker.second.fixes === 15, JSON.stringify(two.tracker));
  check('…and never mixed into one track', JSON.stringify(two.segments) === JSON.stringify(r.segments));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
