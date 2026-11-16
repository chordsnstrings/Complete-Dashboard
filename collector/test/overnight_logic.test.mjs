/* Where each car spent the night — the pure logic (OVN, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   api/overnight.js chooses, among the stays whereaboutsDay() finds for D+1,
   the one with the most minutes inside 00:00–05:00 Dubai, and words what it
   finds. Every case here is synthetic fixes run through the REAL
   whereaboutsDay (api/whereabouts.js), so a rule that holds here holds on
   the route and in the mock, which call the same function.

     §1  a stay across midnight is picked, with since and until;
     §2  an FMS unit quiet all night at one spot is INFERRED, and says so;
     §3  a unit silent over a day is "silent", never parked;
     §4  a plate with no tracker position ever is "no_tracker";
     §5  unnamed ground is area null with its reason, never a guess;
     §6  the majority rule: parked needs MORE than half the window;
     §7  moved while silent is "unknown", with the segment's own words;
     §8  byArea and the counts;
     §9  a month read at once, sliced per night, says what a night read alone
         says (the driver pages and the fleet table agree);
     §10 a night still running says so; the request's refusals; the cache rule
         (open until the READ ends at 12:00, not the window — OVN9);
     §11 a month of ten cars sorted once: the same answers, fast (OVN10).
   §1 also holds OVN11: a stay's end is a bound unless a watched drive ends it.

   Each rule's reversion is recorded in docs/FIX-STATUS.md (OVN). Synthetic
   plates and places only. */
import { carNight, carNights, overnightOf, byArea, countsOf, overnightNight, sliceNight, parseOvernightQuery,
  overnightOpen, nightWindow } from '../api/overnight.js';
import { whereaboutsDay } from '../api/whereabouts.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const NIGHT = '2026-11-10';          // its window: 00:00–05:00 on 2026-11-11
const ON = '2026-11-11';
const NOW = Date.parse('2026-11-16T08:00:00Z');
const PLACES = { A: [25.10, 55.20, 'Al Barsha 1'], B: [25.19, 55.20, 'Deira'], C: [25.05, 55.13, null] };
const fix = (day, hm, place, source = 'cabman', jitter = 0) => {
  const [lat, lng, area] = PLACES[place];
  return { at: new Date(Date.parse(`${day}T${hm}:00+04:00`)).toISOString(),
    lat: lat + jitter * 0.00005, lng, source, area, area_votes: area ? 50 : null };
};
const hm = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
/* Fixes every `every` minutes at one place from `from` to `to` (minutes of
   `day`, may run past 1440 into the next day). */
const stay = (day, from, to, place, every, source = 'cabman') => {
  const out = [];
  for (let m = from; m <= to; m += every) {
    const d = m >= 1440 ? new Date(Date.parse(`${day}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) : day;
    out.push(fix(d, hm(m % 1440), place, source, m % 3));
  }
  return out;
};
/* A drive from one place to another, a fix every 5 minutes. */
const drive = (day, from, to, a, b, source = 'cabman') => {
  const out = [];
  const [la, ga] = PLACES[a]; const [lb, gb] = PLACES[b];
  for (let m = from + 5; m < to; m += 5) {
    const f = (m - from) / (to - from);
    const d = m >= 1440 ? ON : day;
    out.push({ at: new Date(Date.parse(`${d}T${hm(m % 1440)}:00+04:00`)).toISOString(),
      lat: la + (lb - la) * f, lng: ga + (gb - ga) * f, source, area: null, area_votes: null });
  }
  return out;
};
const night = (points, extra = {}) => carNight({ plate: 'L00001', night: NIGHT, points, nowMs: NOW, ...extra });

console.log('\n§1 a stay across midnight');
{
  /* Drove to A, arriving 21:00; CABMAN's hourly heartbeat all night, the
     last at 07:00; drove off at 07:30 (first moving fix 07:35). */
  const pts = [...stay(NIGHT, 1140, 1200, 'B', 10), ...drive(NIGHT, 1200, 1260, 'B', 'A'),
    ...stay(NIGHT, 1260, 1440 + 450, 'A', 60), ...drive(ON, 450, 500, 'A', 'B')];
  const r = night(pts);
  check('parked at the stay that holds the window', r.status === 'parked' && r.area === 'Al Barsha 1', JSON.stringify(r));
  check('from 21:00 the evening before, and that is when it began (not a bound)',
    r.from === '21:00' && r.from_day === NIGHT && r.since_at_least === false, `${r.from} ${r.from_day} ${r.since_at_least}`);
  /* Review OVN11: the first draft asserted to_at_least false here. But the
     next fix, at 07:35, is a kilometre off — 35 minutes nobody watched: the
     car left somewhere between 07:00 and 07:35, so 07:00 is when it was
     last seen there, and the page says "still there at 07:00". */
  check('until its last fix there in the morning (07:00) — a bound: the next fix, 35 min later, is already away',
    r.to === '07:00' && r.to_day === ON && r.to_at_least === true, `${r.to} ${r.to_day} ${r.to_at_least}`);
  check('seen: every window minute between two fixes inside CABMAN’s parked rhythm',
    r.basis === 'fixes' && r.minutes_in_window === 300 && r.watched_min === 300 && r.inferred_min === 0 && /^seen/.test(r.how),
    JSON.stringify([r.basis, r.minutes_in_window, r.watched_min, r.how]));
  check('no reason on a named parked row; the tracker is named', r.reason === null && r.source === 'cabman');
  check('lat/lng are the stay’s', Math.abs(r.lat - 25.10) < 0.001 && Math.abs(r.lng - 55.20) < 0.001);
  /* Only the stay's own fixes were read: the first is P[0], so "since" is a bound. */
  const only = night(sliceNight(stay(NIGHT, 1100, 1440 + 800, 'A', 60), NIGHT));
  check('…and a stay that begins on the earliest fix read is "since at least"',
    only.status === 'parked' && only.since_at_least === true && only.from === '18:20', JSON.stringify([only.from, only.since_at_least]));
  check('…and one still there at the first fix after the read (12:20) is "until at least"',
    only.to === '12:20' && only.to_at_least === true, JSON.stringify([only.to, only.to_at_least]));
  /* A stay whose last fix is 04:20 with nothing after ends at 04:20: the
     rest of the window is the silence after it, not more stay. But 04:20 is
     when it was last SEEN there, not when it left — nothing watched it go
     (review OVN11; the first draft asserted "not a bound" here). */
  const ends = night(stay(NIGHT, 1100, 1440 + 300, 'A', 60));
  check('…a last fix at 04:20 with nothing after ends the stay there (260 window minutes), and 04:20 is a bound — last seen, not left',
    ends.status === 'parked' && ends.to === '04:20' && ends.to_at_least === true && ends.minutes_in_window === 260,
    JSON.stringify([ends.to, ends.to_at_least, ends.minutes_in_window]));
  /* OVN11 on the morning it was found: CABMAN's hourly heartbeat, read at
     06:30 — the 06:00 fix is the last so far, the 07:00 one not yet due. */
  const hb = stay(NIGHT, 1260, 1440 + 360, 'A', 60);
  const at = (iso) => carNight({ plate: 'L1', night: NIGHT, points: hb, nowMs: Date.parse(iso) });
  const r630 = at(`${ON}T06:30:00+04:00`);
  check('read at 06:30 between two heartbeats: "still there at 06:00", never "–06:00" as if it left',
    r630.status === 'parked' && r630.to === '06:00' && r630.to_at_least === true, JSON.stringify([r630.to, r630.to_at_least]));
}

console.log('\n§2 an FMS unit quiet all night at one spot is inferred');
{
  const pts = [...drive(NIGHT, 1150, 1200, 'B', 'A', 'fms'), ...stay(NIGHT, 1200, 1380, 'A', 10, 'fms'),
    fix(ON, '06:30', 'A', 'fms'), ...drive(ON, 390, 430, 'A', 'B', 'fms')];
  const r = night(pts);
  check('parked at A', r.status === 'parked' && r.area === 'Al Barsha 1', JSON.stringify(r));
  check('the window is inferred — not one of its minutes was watched',
    r.basis === 'inferred' && r.inferred_min === 300 && r.watched_min === 0, JSON.stringify([r.basis, r.watched_min, r.inferred_min]));
  check('and it says so in words', /inferred/.test(r.how) && /nothing reported between/.test(r.how), r.how);
  check('the stay still says when it began and ended', r.from === '20:00' && r.to === '06:30', `${r.from}–${r.to}`);
  /* OVN11's other side: the 06:30 fix is followed five minutes later by a
     moving one — a watched drive — so 06:30 is when it left, not a bound. */
  check('…and an end a watched drive follows is when it left, not a bound', r.to_at_least === false, String(r.to_at_least));
  check('the fleet count files it under inferred, not parked',
    countsOf([r]).inferred === 1 && countsOf([r]).parked === 0, JSON.stringify(countsOf([r])));
  /* The basis is the WINDOW's, not the stay's: quiet from 23:00 to 05:30,
     then reporting every ten minutes at the same spot until 07:00. The stay
     on the 11th is watched for 90 minutes and inferred for 330 — "fixes and
     inferred" — but not one of its window minutes was watched. */
  const later = night([...stay(NIGHT, 1300, 1380, 'A', 10, 'fms'), ...stay(ON, 330, 420, 'A', 10, 'fms'),
    ...drive(ON, 420, 460, 'A', 'B', 'fms')]);
  check('a stay watched after the window but quiet through it is inferred FOR THE NIGHT',
    later.status === 'parked' && later.basis === 'inferred' && later.watched_min === 0 && later.inferred_min === 300
    && later.to === '07:00', JSON.stringify([later.basis, later.watched_min, later.inferred_min, later.to]));
}

console.log('\n§3 a unit silent over a day is silent, not parked');
{
  /* Its last fix three days before, at A — only the read's "before" edge. */
  const before = [fix('2026-11-07', '14:20', 'A', 'fms')];
  const r = night(sliceNight([], NIGHT, { before }));
  check('silent', r.status === 'silent', JSON.stringify(r));
  check('…with no area, no stay times, and the WHR sentence as its reason',
    r.area === null && r.from === null && /No reading since 2026-11-07 14:20/.test(r.reason) && /not called parked/.test(r.reason), r.reason);
  /* One fix either side, at one spot, 28 hours apart: past a day, not parked. */
  const r2 = night([fix(NIGHT, '10:00', 'A', 'fms'), fix(ON, '14:00', 'A', 'fms')]);
  check('one spot either side of 28 hours of silence is silent too, never parked', r2.status === 'silent', JSON.stringify([r2.status, r2.reason]));
}

console.log('\n§3b a silence after the last fix is measured to now, not to the 12:00 the day is read to');
{
  /* Last heard 22:56 the evening before, nothing after (the read carries the
     first fix after 12:00 when there is one, so none was sent). Measured on
     production for the night of 15 Nov: WHR's wording for a day cut at
     12:00 told it at 17:40 the next day that "the day is still running". */
  const pts = [...stay(NIGHT, 1200, 1376, 'A', 8, 'fms')];
  const at = (iso) => carNight({ plate: 'L1', night: NIGHT, points: pts, nowMs: Date.parse(iso) });
  const evening = at(`${ON}T17:40:00+04:00`);
  check('the afternoon after: not known, "has not reported since" — never "the day is still running"',
    evening.status === 'unknown' && /No fix since 2026-11-10 22:56: the tracker has not reported since\./.test(evening.reason)
    && !/still running/.test(evening.reason), evening.reason);
  const later = at('2026-11-13T09:00:00+04:00');
  check('…past a day of it: silent, in WHR’s words, never parked', later.status === 'silent'
    && /No reading since 2026-11-10 22:56\. Past a day/.test(later.reason), JSON.stringify([later.status, later.reason]));
  const during = at(`${ON}T03:00:00+04:00`);
  check('…and while the night is running: "the night is still running"', during.status === 'unknown'
    && /No fix since 2026-11-10 22:56 — the night is still running\./.test(during.reason), during.reason);
}

console.log('\n§4 no tracker');
{
  const r = night([]);
  check('no position ever: no_tracker, with its reason', r.status === 'no_tracker'
    && /No tracker position has ever been recorded/.test(r.reason) && r.area === null && r.source === null, JSON.stringify(r));
}

console.log('\n§5 unnamed ground is absent with its reason');
{
  const r = night([...drive(NIGHT, 1150, 1200, 'A', 'C'), ...stay(NIGHT, 1200, 1440 + 420, 'C', 60), ...drive(ON, 420, 470, 'C', 'A')]);
  check('parked, area null — never the nearest named cell', r.status === 'parked' && r.area === null, JSON.stringify(r));
  check('the reason says why', /ground the fleet has never driven near has no name/i.test(r.reason || ''), r.reason);
  check('the position is kept', Math.abs(r.lat - 25.05) < 0.001);
  const ba = byArea([r]);
  check('byArea counts it as unnamed (area null), not dropped', ba.length === 1 && ba[0].area === null && ba[0].n === 1, JSON.stringify(ba));
}

console.log('\n§6 the majority rule');
{
  /* Parked at A to 02:30 (150 min, exactly half), a 20-minute drive, parked
     at B from 02:50 (130 min): neither stay holds MORE than half. */
  const split = [...stay(NIGHT, 1320, 1440 + 150, 'A', 30), ...drive(ON, 150, 170, 'A', 'B'),
    ...stay(ON, 170, 420, 'B', 30)];
  const r = night(split);
  check('exactly half is not a majority: not parked', r.status !== 'parked', JSON.stringify([r.status, r.split]));
  check('…it moved between two places: moving, with the window split', r.status === 'moving'
    && r.split.longest_stay === 150 && r.split.drive === 20 && r.split.other_stays === 130, JSON.stringify(r.split));
  check('…and the reason says so, with the longest stay', /no one place held it/.test(r.reason) && /drove for 20 min/.test(r.reason)
    && /150 min|2 h 30 min/.test(r.reason) && /Al Barsha 1/.test(r.reason), r.reason);
  /* Ten minutes longer at A: 160 of 300 is a majority. */
  const more = night([...stay(NIGHT, 1320, 1440 + 160, 'A', 10), ...drive(ON, 160, 180, 'A', 'B'),
    ...stay(ON, 180, 420, 'B', 30)]);
  check('160 of 300 minutes is: parked at A, for its window minutes', more.status === 'parked' && more.area === 'Al Barsha 1'
    && more.minutes_in_window === 160 && more.to === '02:40', JSON.stringify([more.status, more.area, more.minutes_in_window, more.to]));
}

console.log('\n§7 moved while silent is unknown');
{
  const r = night([...stay(NIGHT, 1300, 1380, 'A', 10, 'fms'), ...stay(ON, 270, 500, 'B', 10, 'fms')]);
  check('unknown', r.status === 'unknown' && r.minutes_in_window === 270, JSON.stringify([r.status, r.minutes_in_window, r.split]));
  check('the reason carries the WHR words for the stretch', /tracker cannot say/.test(r.reason)
    && /Moved while the tracker was silent — route not known/.test(r.reason) && /Al Barsha 1 at/.test(r.reason) && /Deira at 04:30/.test(r.reason), r.reason);
}

console.log('\n§8 byArea and the counts');
{
  const P = (area, w = 300, i = 0) => ({ status: 'parked', area, watched_min: w, inferred_min: i });
  const rows = [P('Deira'), P('Al Quoz'), P('Deira', 0, 300), P(null), P('Al Quoz'), P('Deira'),
    { status: 'unknown' }, { status: 'silent' }, { status: 'moving' }, { status: 'no_tracker' }];
  const ba = byArea(rows);
  check('parked cars by area, the commonest first, unnamed last, the rest left out',
    JSON.stringify(ba) === JSON.stringify([{ area: 'Deira', n: 3 }, { area: 'Al Quoz', n: 2 }, { area: null, n: 1 }]), JSON.stringify(ba));
  const c = countsOf(rows);
  check('the counts partition the cars (a mostly-inferred stay is "inferred")',
    c.parked === 5 && c.inferred === 1 && c.unknown === 1 && c.silent === 1 && c.moving === 1 && c.no_tracker === 1
    && Object.values(c).reduce((a, b) => a + b, 0) === rows.length, JSON.stringify(c));
  const n = overnightNight({ night: NIGHT, cars: rows, nowMs: NOW });
  check('a night carries its window, the cars, by_area and counts', n.window.on === ON && n.window.from === '00:00'
    && n.window.to === '05:00' && n.running === false && n.by_area.length === 3 && n.counts.parked === 5, JSON.stringify({ ...n, cars: n.cars.length }));
}

console.log('\n§9 a month read at once says what each night read alone says');
{
  /* Ten nights of one CABMAN car: home at A most nights, B on some, a dead
     stretch, then back. One read over the range, sliced per night, against
     a read of each night's own 18:00–12:00 with its own edges. */
  const days = Array.from({ length: 12 }, (_, i) => new Date(Date.parse('2026-11-01T12:00:00Z') + i * 864e5).toISOString().slice(0, 10));
  const all = [];
  days.forEach((d, i) => {
    if (i === 6 || i === 7) return;                  // two days with nothing at all
    const home = i % 3 === 2 ? 'B' : 'A';
    all.push(...stay(d, 0, 420, home, 60), ...drive(d, 420, 460, home, 'C'), ...stay(d, 460, 1080, 'C', 30),
      ...drive(d, 1080, 1130, 'C', home), ...stay(d, 1130, 1435, home, 60));
  });
  const t = (p) => Date.parse(p.at);
  const nights = days.slice(0, 10);
  const lo = nightWindow(nights[0]).readFromMs; const hi = nightWindow(nights[nights.length - 1]).readToMs;
  const read = all.filter((p) => t(p) >= lo && t(p) < hi);
  const before = all.filter((p) => t(p) < lo).slice(-1); const after = all.filter((p) => t(p) >= hi).slice(0, 1);
  let same = 0; const diffs = [];
  for (const n of nights) {
    const w = nightWindow(n);
    const own = [...all.filter((p) => t(p) < w.readFromMs).slice(-1), ...all.filter((p) => t(p) >= w.readFromMs && t(p) < w.readToMs),
      ...all.filter((p) => t(p) >= w.readToMs).slice(0, 1)];
    const a = JSON.stringify(carNight({ plate: 'L1', night: n, points: sliceNight(read, n, { before, after }), nowMs: NOW }));
    const b = JSON.stringify(carNight({ plate: 'L1', night: n, points: own, nowMs: NOW }));
    if (a === b) same += 1; else diffs.push(`${n}: ${a.slice(0, 160)} ≠ ${b.slice(0, 160)}`);
  }
  check('all ten nights identical, field for field', same === nights.length, diffs.join('\n      '));
  const statuses = nights.map((n) => carNight({ plate: 'L1', night: n, points: sliceNight(read, n, { before, after }), nowMs: NOW }).status);
  check('…and the dead stretch is not parked on either side of it', statuses[5] !== 'parked' && statuses[6] !== 'parked', statuses.join(','));
}

console.log('\n§10 a running night, the refusals, the cache rule');
{
  const at3 = Date.parse(`${ON}T03:00:00+04:00`);
  const r = carNight({ plate: 'L1', night: NIGHT, points: stay(NIGHT, 1200, 1440 + 180, 'A', 60), nowMs: at3 });
  check('at 03:00 the window so far is 180 minutes, and the stay runs to now', r.window_min === 180 && r.status === 'parked'
    && r.to === '03:00' && r.to_at_least === true, JSON.stringify([r.window_min, r.status, r.to, r.to_at_least]));
  check('…and the night says it is running', overnightNight({ night: NIGHT, cars: [r], nowMs: at3 }).running === true);
  check('…and is not running once the window has closed', overnightNight({ night: NIGHT, cars: [r], nowMs: Date.parse(`${ON}T05:00:00+04:00`) }).running === false);
  const day0 = whereaboutsDay({ day: ON, points: [], nowMs: Date.parse(`${ON}T00:00:00+04:00`) });
  check('a window with no minutes yet is never called parked', overnightOf(day0, NIGHT).status === 'unknown'
    && /has not begun/.test(overnightOf(day0, NIGHT).reason));

  const now = Date.parse('2026-11-16T10:00:00+04:00');          // Dubai 16 Nov, 10:00
  const ok = (qs) => parseOvernightQuery(qs, now);
  check('default: last night, fleet-wide', JSON.stringify(ok({})) === JSON.stringify({ plates: null, nights: ['2026-11-15'] }), JSON.stringify(ok({})));
  check('plates and a range', JSON.stringify(ok({ plates: 'l 12345,L12345, L-7', from: '2026-11-01', to: '2026-11-03' }))
    === JSON.stringify({ plates: ['L12345', 'L7'], nights: ['2026-11-01', '2026-11-02', '2026-11-03'] }), JSON.stringify(ok({ plates: 'l 12345,L12345, L-7', from: '2026-11-01', to: '2026-11-03' })));
  const refused = [
    [{ night: '2026-13-01' }, /night must be YYYY-MM-DD/],
    [{ night: '2026-11-16' }, /has not begun/],
    [{ plates: 'L1', from: '2026-11-10', to: '2026-11-16' }, /has not begun/],
    [{ plates: Array.from({ length: 11 }, (_, i) => `L${i + 10}`).join(',') }, /at most 10 plates/],
    [{ plates: 'L1', from: '2026-09-01', to: '2026-10-15' }, /at most 31 nights/],
    [{ plates: 'L1', from: '2026-11-05', to: '2026-11-01' }, /from and to/],
    [{ from: '2026-11-01', to: '2026-11-03' }, /range of nights is for named plates/],
    [{ plates: 'L1;DROP' }, /letters and digits/],
  ];
  for (const [qs, re] of refused) {
    const a = ok(qs);
    check(`refused with 400 and a reason: ${JSON.stringify(qs).slice(0, 60)}`, a.status === 400 && re.test(`${a.error} ${a.detail || ''}`), JSON.stringify(a));
  }
  check('31 nights is allowed', ok({ plates: 'L1', from: '2026-10-01', to: '2026-10-31' }).nights?.length === 31);
  check('last night is allowed while it is still running (03:00)', parseOvernightQuery({ night: '2026-11-15' }, Date.parse('2026-11-16T03:00:00+04:00')).nights?.[0] === '2026-11-15');

  const before5 = Date.parse('2026-11-16T04:59:00+04:00');
  const at630 = Date.parse('2026-11-16T06:30:00+04:00');
  const before12 = Date.parse('2026-11-16T11:59:00+04:00'); const at12 = Date.parse('2026-11-16T12:00:00+04:00');
  /* OVN9: the window closes at 05:00 but the read runs to 12:00, and the
     answer moves until then — §3b's FMS unit at 06:30 says "not reported
     since", and the next tick makes that false. */
  check('the cache rule: last night is open until its READ ends at 12:00 (not the window, 05:00), then cacheable',
    overnightOpen({}, before5) === true && overnightOpen({}, at630) === true && overnightOpen({}, before12) === true
    && overnightOpen({}, at12) === false, JSON.stringify([before5, at630, before12, at12].map((t) => overnightOpen({}, t))));
  /* Why: the same car-night, read at 06:30 and at 07:00, says two things. */
  const quiet = [...stay(NIGHT, 1300, 1350, 'A', 10, 'fms')];
  const woke = [...quiet, fix(ON, '06:40', 'A', 'fms'), ...drive(ON, 400, 440, 'A', 'B', 'fms')];
  const s630 = carNight({ plate: 'L1', night: NIGHT, points: quiet, nowMs: Date.parse(`${ON}T06:30:00+04:00`) });
  const s700 = carNight({ plate: 'L1', night: NIGHT, points: woke, nowMs: Date.parse(`${ON}T07:00:00+04:00`) });
  check('…because after 05:00 the answer still moves: "not reported since" at 06:30, parked (inferred) once it reports at 06:40',
    s630.status === 'unknown' && /has not reported since/.test(s630.reason) && s700.status === 'parked' && s700.basis === 'inferred',
    JSON.stringify([s630.status, s700.status, s700.basis]));
  check('…an older night is cacheable; a range is open while its last night is read',
    overnightOpen({ night: '2026-11-10' }, before5) === false && overnightOpen({ plates: 'L1', from: '2026-11-10', to: '2026-11-15' }, before5) === true
    && overnightOpen({ plates: 'L1', from: '2026-11-10', to: '2026-11-14' }, before5) === false);
}

console.log('\n§11 a month of ten cars: the same answers, and in a fraction of a second');
{
  /* OVN10. The route judges a car's whole range night by night. The first
     draft re-sorted every car's month for every night (Date.parse in the
     comparator) and re-built every point per night: ten FMS cars over 31
     nights (240 fixes a car-day, as measured on production) took 4.6 s of
     synchronous arithmetic on the review machine. carNights sorts once and
     finds each night by binary search. Two checks: field-for-field the same
     as each night sliced alone, and well under a second for the month. */
  const nights = Array.from({ length: 31 }, (_, i) => new Date(Date.parse('2026-10-01T12:00:00Z') + i * 864e5).toISOString().slice(0, 10));
  const lo = nightWindow(nights[0]).readFromMs; const hi = nightWindow(nights[30]).readToMs;
  const cars = Array.from({ length: 10 }, (_, k) => {
    const pts = [];
    for (let t = lo; t < hi; t += 6 * 60_000) {
      const h = new Date(t + 4 * 3600e3).getUTCHours();
      const moving = h >= 7 && h < 22 && (k + h) % 4;
      pts.push({ at: new Date(t).toISOString(), lat: 25.1 + (moving ? (t % 7_200_000) / 1e8 : k * 0.01), lng: 55.2,
        source: k % 3 ? 'fms' : 'cabman', area: moving ? null : `Area ${k}`, area_votes: moving ? null : 20 });
    }
    return { plate: `L${k}`, pts };
  });
  const t0 = performance.now();
  const fast = cars.map((c) => carNights({ plate: c.plate, nights, points: c.pts, nowMs: NOW }));
  const ms = performance.now() - t0;
  let same = 0;
  for (const [k, c] of cars.entries()) {
    for (const [i, n] of nights.entries()) {
      if (k % 4 && i % 5) continue;                   // a sample: the naive path is the slow one
      const a = JSON.stringify(fast[k][i]);
      const b = JSON.stringify(carNight({ plate: c.plate, night: n, points: sliceNight(c.pts, n), nowMs: NOW }));
      if (a === b) same += 1; else { same = -1e9; console.log(`      ${c.plate} ${n}: ${a.slice(0, 120)} ≠ ${b.slice(0, 120)}`); }
    }
  }
  check('every sampled car-night is field for field what the night sliced alone says', same > 0, String(same));
  check(`ten cars × 31 nights (${cars.reduce((t, c) => t + c.pts.length, 0)} fixes) judged in under a second (took ${Math.round(ms)} ms)`,
    ms < 1000, `${Math.round(ms)} ms`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
