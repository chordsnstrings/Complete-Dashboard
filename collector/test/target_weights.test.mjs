/* THE MONTH SHARED BY WEEKDAY — api/target_weights.js and every place that
   reads it.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-11: "I think the target distribution makes more sense
   hourly and daily based on previous performance. A historically bad day on a
   Sunday can't be expected to perform the same way as weekday." What is pinned:
     1. the weights: each day against its own week's average, by weekday,
        mean 1 — a growing fleet does not tilt them; a week with a break in
        collection is left out and named; under 4 whole weeks there are none,
        and the reason says so;
     2. the trips minimum by weekday: a whole number of trips, 84 a week at 12;
        before the rule's day, the same every day;
     3. a weighted save: each day's plan is its weekday's share, the plans add
        up to what was typed, and a shortfall is caught up in the same
        proportions; a save made before the rule is the equal split exactly;
     4. saveTarget learns and stores the weights; with too little history it
        stores none and says why;
     5. the month in progress is re-shaped once: its month target and every
        day gone kept to the fils, a recorded system save, never twice;
     6. a month's trips weights are frozen once its first weighted day is read;
     7. the hours: today's weekday over the last 4 weeks, else the pooled days,
        said so;
     8. the 08:00 email, the goal texts and the hourly trips panel all read the
        day's own minimum.
   Synthetic plates (C…) and drivers (Test Driver …) only.
   REVERSIONS, each run against this file on 2026-10-11, recorded beside the
   checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

const tw = await import('../api/target_weights.js');
const rt = await import('../api/revenue_target.js');
const { weekdayWeights, minimumOn, weeksBefore, monthWeights, learnWeights, WEIGHTED_FROM } = tw;
const { computeMonth, addDays, saveTarget, monthTarget, applyWeightCutover } = rt;
const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

/* The fleet's week, Sunday first: trips (and AED 10 fares) a day. Mean 10, so
   the weights are exactly these ÷ 10. */
const PATTERN = [8, 9, 10, 10, 12, 12, 9];
const WANT = PATTERN.map((v) => v / 10);

/* ── 1. the weights ───────────────────────────────────────────────────────
   REVERSION: the gap rule removed (every week used) -> 3 FAIL — the week
   with a day at 15% is learned from and Tuesday reads 0.90 — and then the
   file THROWS: a week with no data at all divides by zero, the weights are
   NaN, and a save over such a span fails. The gap rule is also what keeps an
   empty week out. REVERSION: the minimum-weeks rule removed -> 2 FAIL (three
   weeks return weights; a save with one week behind it stores weights). */
console.log('\n1. the weights');
const before = '2026-10-11';                                  // a Sunday
const ws = weeksBefore(before);
check('eight whole Monday-to-Sunday weeks, the newest ending the Sunday before',
  ws.length === 8 && ws[0].sun === '2026-10-04' && ws[0].mon === '2026-09-28' && ws[7].mon === '2026-08-10', j(ws.slice(0, 2)));
/* A fleet that doubles over the eight weeks: week w carries (1 + w/7)× the
   pattern. Each day is read against its own week, so growth does not tilt. */
const grow = new Map();
ws.forEach((w, i) => span(w.mon, w.sun).forEach((d) => {
  const g = 1 + (7 - i) / 7;
  grow.set(d, { fares: 10 * PATTERN[dow(d)] * g, completed: PATTERN[dow(d)] * g });
}));
let W = weekdayWeights(grow, before);
check('a fleet that doubled reads the weekday pattern, Sunday first: 0.8 … Thursday 1.2',
  W.ok && W.fares.every((v, i) => near(v, WANT[i])) && W.trips.every((v, i) => near(v, WANT[i])), j(W.fares));
check('…and the seven weights average exactly 1', near(W.fares.reduce((s, v) => s + v, 0) / 7, 1, 1e-4), j(W.fares));
/* A break in collection: Tuesday of one week at 20% of its week. */
const gap = new Map(grow);
const tue = addDays(ws[2].mon, 1);
gap.set(tue, { fares: gap.get(tue).fares * 0.15, completed: gap.get(tue).completed * 0.15 });
W = weekdayWeights(gap, before);
check('a week with a day under 40% of its week is left out, and named with that day',
  W.ok && W.basis.used === 7 && W.basis.skipped.length === 1 && W.basis.skipped[0].day === tue
  && /gap in what was collected/.test(W.basis.skipped[0].why), j(W.basis));
check('…so Tuesday is still read as 1.0, not dragged down by the break', near(W.fares[2], 1.0), String(W.fares[2]));
/* Only three whole weeks on record. */
const few = new Map([...grow].filter(([d]) => d >= ws[2].mon));
W = weekdayWeights(few, before);
check('under 4 whole weeks there are no weights, and the reason says how many there were',
  !W.ok && W.fares === null && /Only 3 of the 8 weeks/.test(W.basis.why) && /every day is asked the same/.test(W.basis.why), j(W.basis));

/* ── 2. the trips minimum by weekday ──────────────────────────────────────
   REVERSION: minimumOn returning the minimum unrounded -> 4 FAIL (here, and
   the page, the 08:00 email and the hourly panel asking 9.6 trips). */
console.log('\n2. the trips minimum by weekday');
const PROD = [0.796, 0.933, 1.036, 1.041, 1.128, 1.126, 0.940];  // production's, 8 weeks to 4 Oct 2026
const mw = { from_day: WEIGHTED_FROM, trips: PROD };
const mins = span('2026-10-12', '2026-10-18').map((d) => minimumOn(12, mw, d).min);
check('at 12: Mon 11, Tue 12, Wed 12, Thu 14, Fri 14, Sat 11, Sun 10 — whole trips', j(mins) === '[11,12,12,14,14,11,10]', j(mins));
check('…84 a week, exactly 7 × 12', mins.reduce((s, v) => s + v, 0) === 84, String(mins.reduce((s, v) => s + v, 0)));
check('before the rule’s day, and with no weights, the minimum is the same every day',
  minimumOn(12, mw, '2026-10-04').min === 12 && minimumOn(12, null, '2026-10-18').min === 12
  && minimumOn(12, { from_day: WEIGHTED_FROM, trips: null }, '2026-10-18').min === 12);

/* ── 3. a weighted save, by hand ──────────────────────────────────────────
   12 cars every day. October 2026: 31 days, Thu 1 to Sat 31.
   REVERSION: the shortfall spread evenly (shareOf = 1 ÷ days left) -> 2
   FAIL. REVERSION: the weight left off a day's plan -> 7 FAIL (every
   weekday asked the same, and a weighted month no longer adds up to what
   was typed). */
console.log('\n3. a weighted save, by hand');
const cars12 = Object.fromEntries(span('2026-09-20', '2026-10-31').map((d) => [d, Array.from({ length: 12 }, (_, i) => `C${i + 1}`)]));
const mk = (fares) => ({
  days: new Map(Object.entries(fares).map(([d, v]) => [d, { day: d, fares: v, priced: 100, chargeable: 100, completed: 100, bookings: 100 }])),
  carDays: new Map(Object.entries(cars12).map(([d, l]) => [d, new Set(l)])),
  personDays: new Map(), runs: [],
});
const octW = span('2026-10-01', '2026-10-31').reduce((s, d) => s + WANT[dow(d)], 0);
const G = 31000;
const rate = G / (12 * octW);
const row = (o) => ({ id: o.id ?? 1, gross_target: o.gross, cars: o.cars, rate: o.rate, past_plan: o.past ?? 0,
  set_day: o.day, set_at: o.at || `${o.day}T06:00:00Z`, set_by: null, set_by_label: o.by || 'owner@example.test',
  weights: o.weights === undefined ? null : o.weights });
const saved = [row({ gross: G, cars: 12, rate, day: '2026-10-01', weights: WANT })];
let t = computeMonth({ month: '2026-10', today: '2026-10-01', rows: saved, facts: mk({}) });
const plan = (d) => t.days.find((x) => x.day === d).plan;
check('each day is asked its weekday’s share: a Sunday 0.8 ÷ 1.2 of a Thursday',
  near(plan('2026-10-04') / plan('2026-10-01'), 0.8 / 1.2) && near(plan('2026-10-02') / plan('2026-10-01'), 1),
  j([plan('2026-10-01'), plan('2026-10-04')]));
check('…and the month reads exactly what was typed', t.summary.month_target === G, String(t.summary.month_target));
check('…with the AED a car of each day on its row, the rate on an average day in the summary',
  near(t.days[3].rate, rate * 0.8, 1e-6) && t.summary.rate === rate && t.summary.weighted === true && t.days[3].weight === 0.8,
  j([t.days[3].rate, t.days[3].weight, t.summary.rate]));
/* Thursday the 1st earned nothing: the shortfall is caught up in the same
   proportions over the 30 days left. */
t = computeMonth({ month: '2026-10', today: '2026-10-02', rows: saved, facts: mk({ '2026-10-01': 0 }) });
const short = rate * 12 * 1.2;
const left = octW - 1.2;
const need = (d) => t.days.find((x) => x.day === d).needed;
check('a day under is caught up in proportion: Friday needs its plan + the shortfall × 1.2 ÷ the weights left',
  near(need('2026-10-02'), rate * 12 * 1.2 + short * 1.2 / left, 0.01), j([need('2026-10-02'), rate * 12 * 1.2 + short * 1.2 / left]));
check('…and a Sunday carries less of it than a Thursday',
  near(need('2026-10-04') - plan('2026-10-04'), short * 0.8 / left, 0.01) && near(need('2026-10-08') - t.days[7].plan, short * 1.2 / left, 0.01),
  j([need('2026-10-04') - plan('2026-10-04'), need('2026-10-08') - t.days[7].plan]));
/* The same with a save made before the rule: the even spread, exactly. */
const legacy = [row({ gross: G, cars: 12, rate: G / (12 * 31), day: '2026-10-01', weights: null })];
t = computeMonth({ month: '2026-10', today: '2026-10-02', rows: legacy, facts: mk({ '2026-10-01': 0 }) });
check('a save made before the rule shares equally, and the shortfall over the days left evenly — as it always did',
  near(t.days[1].plan, 1000) && near(t.days[1].needed, 1000 + 1000 / 30, 0.01) && near(t.days[3].needed, 1000 + 1000 / 30, 0.01)
  && t.summary.weighted === false, j([t.days[1].plan, t.days[1].needed, t.days[3].needed]));

/* ── a fleet in a real schema ─────────────────────────────────────────────
   From Mon 3 Aug 2026 to Sat 31 Oct: every day PATTERN[weekday] drivers —
   Test Driver 1…n in car Cn — each complete one AED 10 trip at noon Dubai. */
const db = new PGlite();
await applySchema(db);
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
const vals = [];
let n = 0;
for (const d of span('2026-08-03', '2026-10-31')) {
  for (let c = 1; c <= PATTERN[dow(d)]; c++) {
    n += 1;
    vals.push(`('uber','t${n}','ecosine','u-Test Driver ${c}','Test Driver ${c}','C${c}','${d}T08:00:00Z','${d}T08:20:00Z','completed','card',10,'AED','{}'::jsonb)`);
  }
}
for (let i = 0; i < vals.length; i += 500) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
           VALUES ${vals.slice(i, i + 500).join(',')}`);
}
const at = (d, hhmm = '10:00') => new Date(`${d}T${hhmm}:00+04:00`);

/* ── 4. saveTarget learns them ────────────────────────────────────────────
   REVERSION: saveTarget dividing by the number of days, not the weights ->
   1 FAILS: November reads AED 29,700 for a target typed as 30,000 (it has
   five Sundays and Mondays, four Thursdays and Fridays). */
console.log('\n4. a save learns the weights');
let s = await saveTarget(q, { month: '2026-11', gross: 30000, now: at('2026-10-25'), by: 7, byLabel: 'owner@example.test' });
check('a save stores the weekday weights it learned, Sunday first', Array.isArray(s.row?.weights)
  && s.row.weights.every((v, i) => near(v, WANT[i])) && s.row.weights_basis?.used === 8, j(s.row));
let m = await monthTarget(q, { month: '2026-11', today: '2026-10-25', min: 12 });
check('…and the month it shares reads exactly what was typed', m.summary.month_target === 30000, String(m.summary.month_target));
check('…a Sunday asked 0.8 of an average day, a Thursday 1.2',
  near(m.days.find((d) => d.day === '2026-11-01').plan / m.days.find((d) => d.day === '2026-11-05').plan, 0.8 / 1.2), '');
s = await saveTarget(q, { month: '2026-08', gross: 9000, now: at('2026-08-12'), by: 7, byLabel: 'owner@example.test' });
check('with under 4 whole weeks before it, a save stores no weights and says why',
  s.row && s.row.weights === null && /Only \d of the 8 weeks/.test(s.row.weights_basis?.why || ''), j(s.row?.weights_basis));

/* ── 5. the month in progress, re-shaped once ─────────────────────────────
   October saved on the 2nd under the equal split (no weights), over 11 cars:
   12 earn now, so the month has floated above what was typed.
   REVERSION: the cutover re-saving the TYPED figure (latest.gross) instead
   of the month as it stands -> 1 FAILS: 37,100 becomes 34,100 — the cars
   that joined since the save quietly undone. REVERSION: the "already
   weighted" test removed -> 2 FAIL (a second system save, a second audit
   row, on the second boot). */
console.log('\n5. the month in progress, re-shaped once');
await q(`INSERT INTO revenue_target (month, gross_target, cars, rate, past_plan, set_day, set_at, set_by, set_by_label)
         VALUES ('2026-10-01', 34100, 11, 100, 1100, '2026-10-02', '2026-10-02T06:00:00Z', 7, 'owner@example.test')`);
const beforeCut = await monthTarget(q, { month: '2026-10', today: '2026-10-11', min: 12 });
const out = await applyWeightCutover(db, { now: at('2026-10-11') });
const afterCut = await monthTarget(q, { month: '2026-10', today: '2026-10-11', min: 12 });
check('one system save, weighted, recorded on the audit chain', out.length === 1 && out[0].done
  && afterCut.saves.length === 2 && afterCut.saves[1].set_by_label === 'system:reweight' && Array.isArray(afterCut.saves[1].weights)
  && (await q(`SELECT count(*)::int AS n FROM access_audit WHERE action = 'target.reweight'`))[0].n === 1, j(out));
check('the month target is kept to the fils', afterCut.summary.month_target === beforeCut.summary.month_target
  && beforeCut.summary.month_target > 34100, j([beforeCut.summary.month_target, afterCut.summary.month_target]));
check('every day already gone keeps the plan it was judged against',
  afterCut.days.slice(0, 10).every((d, i) => d.plan === beforeCut.days[i].plan && d.needed === beforeCut.days[i].needed),
  j(afterCut.days.slice(0, 3).map((d) => d.plan)));
check('from today each day is its weekday’s share: Sunday the 11th 0.8 of Thursday the 15th',
  near(afterCut.days[10].plan / afterCut.days[14].plan, 0.8 / 1.2), j([afterCut.days[10].plan, afterCut.days[14].plan]));
check('…and the Owner’s own figures stay on the row: typed 34,100 over 11 cars',
  afterCut.saves[1].gross === 34100 && afterCut.saves[1].cars === 11, j(afterCut.saves[1]));
const again = await applyWeightCutover(db, { now: at('2026-10-11', '11:00') });
check('the next boot does nothing: the month’s latest save carries weights', again.length === 0
  && (await q(`SELECT count(*)::int AS n FROM revenue_target WHERE month = '2026-10-01'`))[0].n === 2, j(again));

/* ── 6. a month's trips weights, frozen ───────────────────────────────────
   REVERSION: monthWeights never storing (learning on every read) -> 5 FAIL:
   October is not kept, the new Sundays move its weights mid-month, and the
   page, the email and the hourly panel ask Sunday 11 instead of 10. */
console.log('\n6. a month’s trips weights, frozen');
const early = await monthWeights(q, '2026-12', '2026-11-20');
check('a month looked at before it begins is learned, not kept', early.frozen === false
  && (await q(`SELECT count(*)::int AS n FROM target_weights WHERE month = '2026-12-01'`))[0].n === 0, j(early));
const oct = await monthWeights(q, '2026-10', '2026-10-11');
check('October’s, read on the rule’s first day: kept, from 11 Oct, learned from the weeks before it',
  oct.frozen && oct.from_day === '2026-10-11' && oct.trips.every((v, i) => near(v, WANT[i])) && oct.basis.to === '2026-10-04', j(oct));
/* Sundays double in the weeks it was learned from — after it was kept. */
const extra = span('2026-08-10', '2026-10-04').filter((d) => dow(d) === 0)
  .map((d, i) => `('uber','x${i}','ecosine','u-Test Driver 99','Test Driver 99','C99','${d}T09:00:00Z','${d}T09:20:00Z','completed','card',80,'AED','{}'::jsonb)`);
await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
         VALUES ${extra.join(',')}`);
const still = await monthWeights(q, '2026-10', '2026-10-20');
check('…and a Sunday’s minimum does not move under a driver mid-month when the history does', near(still.trips[0], 0.8), j(still.trips));
check('a month before the rule has none', (await monthWeights(q, '2026-09', '2026-10-11')) === null);
const relearned = await learnWeights(q, '2026-10-11');
check('(the history did move: learned again it reads Sundays higher)', relearned.trips[0] > 0.85, j(relearned.trips));

/* ── 7. the hours, by weekday ─────────────────────────────────────────────
   REVERSION: shapeOf never choosing the weekday (always pooled) -> 2 FAIL. */
console.log('\n7. the hours, by weekday');
const { shapeOf, HOUR_MIN_DAYS } = await import('../api/target_hours.js');
const today = '2026-10-18';                                              // a Sunday
const hrs = [];
for (const d of span('2026-09-20', '2026-10-17')) hrs.push({ d, h: dow(d) === 0 ? 10 : 18, v: 100 });
let sh = shapeOf(hrs, { today, from: '2026-09-20', to: '2026-10-17' });
check('a Sunday is shared the way the last 4 Sundays ran: all of it at 10:00', sh.basis.kind === 'weekday' && sh.share[10] === 1
  && sh.basis.days === 4 && /last 4 Sundays/.test(sh.basis.text), j(sh.basis));
check('…its usual hour is a Sunday’s, not the pooled day’s', sh.usual[10] === 100 && sh.usual[18] === 0, j([sh.usual[10], sh.usual[18]]));
const thin = hrs.filter((r) => !(dow(r.d) === 0 && r.d < '2026-10-04'));
sh = shapeOf(thin, { today, from: '2026-09-20', to: '2026-10-17' });
check(`with fewer than ${HOUR_MIN_DAYS} of them on record, every day of the span pooled — and it says so`,
  sh.basis.kind === 'pooled' && sh.share[18] > 0.9 && /Only 2 of the last 4 Sundays/.test(sh.basis.why), j(sh.basis));

/* ── 8. one minimum, everywhere ───────────────────────────────────────────
   Sunday 18 October 2026 asks 10 of each active driver at 12 an average day.
   REVERSION: the 08:00 email reading minTrips(cfg) -> 1 FAILS. REVERSION:
   the goal texts reading minTrips(cfg) -> 1 FAILS. */
console.log('\n8. one minimum: the page, the hours, the 08:00 email, the goal texts');
const sun = await monthTarget(q, { month: '2026-10', today: '2026-10-18', min: 12 });
const sd = sun.days.find((d) => d.day === '2026-10-18');
check('the Target page: Sunday asks 10 trips of each active driver, the trips target its drivers × 10',
  sd.trips_min === 10 && sd.trips_target === sd.active_drivers * 10 && sun.trips_summary.today_min === 10 && sun.trips_summary.min === 12,
  j({ min: sd.trips_min, target: sd.trips_target, active: sd.active_drivers }));
const { lowTripsRun } = await import('../src/low_trips_email.js');
const lt = await lowTripsRun({ q, now: at('2026-10-19', '08:00'), day: '2026-10-18', cfg: { low_trips_min: 12 },
  only: 'ops@example.test', force: true, http: async () => ({ status: 200, json: async () => ({ id: 'x' }) }) });
check('the 08:00 email judges Sunday by Sunday’s 10', lt.min === 10, j(lt));
const { minimumSentence } = await import('../src/low_trips_email.js');
check('…and says where the 10 comes from', /Sunday’s share of the 12 a day/.test(minimumSentence({ day: '2026-10-18', min: 10, min_average: 12, min_weight: 0.8 })));
const { targetNudgeRun } = await import('../src/target_sms.js');
const nudge = await targetNudgeRun({ q, now: at('2026-10-18', '13:05'), cfg: { sms_target: 'dry', low_trips_min: 12 }, dry: true,
  book: { byPerson: new Map(), byPhone: new Map() },
  hours: { today: '2026-10-18', lag_min: 3, clock: '13:02', cut_at: at('2026-10-18', '13:02').toISOString(),
    trips: { min: 10, target: 80, need_by_now: 30 } } });
check('the goal texts ask today’s 10, the trips panel’s own figure', nudge.goal === 10, j({ goal: nudge.goal, held: nudge.held }));
const { targetHours } = await import('../api/target_hours.js');
const th = await targetHours(q, { now: at('2026-10-18', '13:00'), min: 12 });
check('the hourly trips panel carries the day’s minimum and the average day’s', th.trips.min === 10 && th.trips.min_average === 12
  && th.trips.target === sd.trips_target, j({ min: th.trips.min, avg: th.trips.min_average, target: th.trips.target, absent: th.trips.absent }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
