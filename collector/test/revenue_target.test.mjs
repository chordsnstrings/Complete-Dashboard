/* THE MONTHLY REVENUE TARGET — api/revenue_target.js, its routes, the seed
   and the Today workbook.
   ═════════════════════════════════════════════════════════════════════════
   What is pinned — the operator's words and answers, 2026-10-02:
     1. their own example: 30 days, AED 3,000, 10 cars → AED 10 a car a day,
        AED 100 a day; a day under is spread over the days left (70 → 101.03),
        a day over lowers them the same way; 5 cars joining on day 15 make it
        AED 150 a day and the month 3,800, not 4,500;
     2. a save: the month target reads exactly what was typed; the days before
        the first save are planned at the cars counted at it; a correction the
        same day replaces it; a LATER save keeps every day already gone as it
        was asked, and re-spreads only what is left;
     3. a day is judged only when settled — every channel delivered it and 99%
        of its bookings carry a fare; an unsettled day already over is over,
        "at least"; today is never judged;
     4. a car counts when it EARNED in the 7 days before; an active driver is
        the 08:00 email's own rule, and the trips target is its minimum;
     5. the deploy seed applies once and never overwrites a month's target;
     6. the Today workbook lists the page's own figures, and withholds what a
        role does not hold;
     7. /api/target is never cached, carries no staff email, and the Action
        list query is one function shared by the page and the workbook;
     8. the trips chart (the operator, the same day: "There should also be a
        minimum 12 trips per day per active driver. there should be a similar
        chart for that too"): a floor every day, nothing carried, judged when
        settled, there with or without a revenue target, withheld whole from
        a role without booking counts.
   Synthetic plates (C…) and drivers (Test Driver …) only.
   REVERSIONS, run 2026-10-02, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { readWorkbook, sheetNamed } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

const rt = await import('../api/revenue_target.js');
const { computeMonth, addDays, saveTarget, monthTarget, applyTargetSeed, settledness, carsAsOf, tripsTarget,
  DRIVER_DAYS, SETTLED_COVERAGE } = rt;

/* Facts by hand, for the pure arithmetic: fares by day, the plates that
   earned each day, completed trips by person by day, collection runs. */
const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const mk = ({ fares = {}, cars = {}, people = {}, runs = [], cover = {} } = {}) => ({
  days: new Map(Object.entries(fares).map(([d, v]) => [d, { day: d, fares: v, priced: cover[d] ?? 100, chargeable: 100, completed: 100, bookings: 100 }])),
  carDays: new Map(Object.entries(cars).map(([d, l]) => [d, new Set(l)])),
  personDays: new Map(Object.entries(people).map(([d, o]) => [d, new Map(Object.entries(o))])),
  runs,
});
const plates = (n, from = 1) => Array.from({ length: n }, (_, i) => `C${from + i}`);
const row = (o) => ({ id: o.id ?? 1, gross_target: o.gross, cars: o.cars, rate: o.rate, past_plan: o.past ?? 0,
  set_day: o.day, set_at: o.at || `${o.day}T06:00:00Z`, set_by: null, set_by_label: o.by || 'owner@example.test' });

/* ── 1. the operator's own example ────────────────────────────────────────
   September 2026 has 30 days. C1–C10 earn every day from 24 August; C11–C15
   start on 14 September, so the 15th is the first morning they count.
   REVERSION (run 2026-10-02): a day's need without the shortfall share
   (needed = plan) -> 47 passed, 6 FAILED, among them "70 instead of 100 …
   101.03" and "a day over lowers the rest"; plan every day at the cars
   counted at the save (ignore cars joining) -> 49 passed, 4 FAILED, among
   them "… 3,800, not 4,500". */
console.log('\n1. the operator’s example: 3,000 over 30 days at 10 cars');
const cars1 = {};
for (const d of span('2026-08-24', '2026-09-30')) cars1[d] = d >= '2026-09-14' ? plates(15) : plates(10);
const fares1 = { '2026-09-01': 70, '2026-09-02': 150 };
for (const d of span('2026-09-03', '2026-09-14')) fares1[d] = 100;
const facts1 = mk({ fares: fares1, cars: cars1 });
const save1 = row({ gross: 3000, cars: 10, rate: 10, day: '2026-09-01' });
const onFirst = computeMonth({ month: '2026-09', today: '2026-09-01', rows: [save1], facts: facts1 });
check('10 cars, 30 days: AED 10 a car a day, AED 100 a day, and the month reads 3,000',
  onFirst.days[0].plan === 100 && onFirst.summary.month_target === 3000 && onFirst.summary.today_needs === 100,
  j([onFirst.days[0], onFirst.summary.month_target]));
const mid = computeMonth({ month: '2026-09', today: '2026-09-15', rows: [save1], facts: facts1 });
const at = (d) => mid.days.find((x) => x.day === d);
check('day 1 earned 70 instead of 100: under, and day 2 needs 100 + 30 ÷ 29 = 101.03',
  at('2026-09-01').verdict === 'under' && at('2026-09-01').diff === -30 && at('2026-09-02').needed === 101.03,
  j([at('2026-09-01'), at('2026-09-02').needed]));
check('a day over lowers the rest the same way: day 2 earned 150, day 3 needs 100 − 20 ÷ 28 = 99.29',
  at('2026-09-02').verdict === 'over' && at('2026-09-03').needed === 99.29, j(at('2026-09-03')));
check('5 more cars from the 15th: AED 150 a day from then, and the month becomes 14 × 100 + 16 × 150 = 3,800, not 4,500',
  at('2026-09-14').plan === 100 && at('2026-09-15').plan === 150 && mid.summary.month_target === 3800 && mid.summary.cars_now === 15,
  j([at('2026-09-14').plan, at('2026-09-15').plan, mid.summary.month_target]));
check('…and today, the 15th, needs its 150 less the 20 the month is ahead, over 16 days: 148.75 — AED 9.92 a car',
  mid.summary.today_needs === 148.75 && mid.summary.ahead === 20 && mid.summary.today_per_car === 9.92 && mid.summary.days_left === 16,
  j(mid.summary));
check('the days to come need their plan plus today’s share — what each needs if today is met',
  at('2026-09-20').needed === 148.75 && at('2026-09-20').verdict === null && at('2026-09-20').earned === null, j(at('2026-09-20')));
check('today is never judged', at('2026-09-15').state === 'today' && at('2026-09-15').verdict === null);
check('the month moved by the cars that joined, and says so: 3,800 − 3,000 = 800 since it was set',
  mid.summary.since_set === 800 && mid.summary.gross_set === 3000, String(mid.summary.since_set));
check('never below zero: a month already met needs nothing more',
  computeMonth({ month: '2026-09', today: '2026-09-03', rows: [save1],
    facts: mk({ fares: { '2026-09-01': 2000, '2026-09-02': 1500 }, cars: cars1 }) }).summary.today_needs === 0);

/* ── 2. what a day is judged against ──────────────────────────────────────
   REVERSION (run 2026-10-02): plan the days before the first save at the
   cars counted on each of them -> 52 passed, 1 FAILED ("the days before …").
   (The first fixture for it took two cars away for two days, which no
   7-day count notices, and the revert passed 53 of 53 — so C9 and C10 now
   join on the 5th.) REVERSION: take the FIRST save of the first day as the
   anchor rather than the last -> 49 passed, 4 FAILED ("a correction the same
   day …" among them). */
console.log('\n2. the days before a save, a correction, a later save');
/* C9 and C10 first earn on the 5th: the 7-day count is 8 on the 1st to the
   5th and 10 by the 10th, when the target is first saved. */
const thin = {};
for (const d of span('2026-08-24', '2026-09-30')) thin[d] = d >= '2026-09-05' ? plates(10) : plates(8);
const late = computeMonth({ month: '2026-09', today: '2026-09-10',
  rows: [row({ gross: 3000, cars: 10, rate: 10, day: '2026-09-10' })], facts: mk({ fares: fares1, cars: thin }) });
check('the days before the first save are planned at the cars counted at it, so the month reads what was typed',
  late.days.slice(0, 9).every((x) => x.cars === 10 && x.plan === 100) && late.summary.month_target === 3000,
  j(late.days.slice(0, 9).map((x) => x.cars)));
const typo = computeMonth({ month: '2026-09', today: '2026-09-10', facts: mk({ fares: fares1, cars: cars1 }), rows: [
  row({ id: 1, gross: 30000, cars: 10, rate: 100, day: '2026-09-10', at: '2026-09-10T06:00:00Z' }),
  row({ id: 2, gross: 3000, cars: 10, rate: 10, day: '2026-09-10', at: '2026-09-10T06:10:00Z' })] });
check('a correction the same day replaces the first figure — for the days before it too',
  typo.days[0].plan === 100 && typo.summary.month_target === 3000, j([typo.days[0].plan, typo.summary.month_target]));
const two = computeMonth({ month: '2026-09', today: '2026-09-15', facts: facts1, rows: [
  save1, row({ id: 2, gross: 4000, cars: 15, rate: 13.2, past: 1400, day: '2026-09-15' })] });
check('a later save re-spreads only what is left: the first 14 days keep their plan, and day 2 keeps its need',
  two.days[13].plan === 100 && two.days[1].needed === 101.03 && two.days[14].plan === 198, j([two.days[13], two.days[14].plan]));

/* ── 3. settled, or not yet ───────────────────────────────────────────────
   REVERSION (run 2026-10-02): judge every past day on what is counted,
   settled or not -> 52 passed, 1 FAILED ("a channel that has not delivered
   …"). REVERSION: count a run whose window merely REACHES the day (drop
   ws <= day) -> 50 passed, 3 FAILED ("a run whose window does not cover …"
   among them). */
console.log('\n3. a day is judged once it is complete');
const endOf = (d) => Date.parse(`${addDays(d, 1)}T00:00:00+04:00`);
const runs = [
  { source: 'uber', fleet: 'ecosine', ws: '2026-09-01', we: '2026-09-30', fin: endOf('2026-09-14') + 3600e3 },
  { source: 'bolt', fleet: 'ecosine', ws: '2026-09-01', we: '2026-09-12', fin: endOf('2026-09-12') + 3600e3 },
  { source: 'bolt', fleet: 'ecosine', ws: '2026-09-14', we: '2026-09-16', fin: endOf('2026-09-14') + 3600e3 },
];
const f3 = mk({ fares: { ...fares1, '2026-09-13': 50, '2026-09-11': 300 }, cars: cars1, runs, cover: { '2026-09-12': 97 } });
const m3 = computeMonth({ month: '2026-09', today: '2026-09-15', rows: [save1], facts: f3 });
const d13 = m3.days.find((x) => x.day === '2026-09-13');
check('a channel that has not delivered the day leaves a day under target unjudged, and names the channel',
  d13.verdict === 'unsettled' && d13.settled === false && /Bolt · Ecosine has not delivered Sun 13 Sep yet/.test(d13.why || ''), j(d13));
check('a run whose window does not cover the day does not count for it (a later 3-day run says nothing about the 13th)',
  settledness(f3, '2026-09-13').missing.length === 1 && settledness(f3, '2026-09-14').missing.length === 0);
const d12 = m3.days.find((x) => x.day === '2026-09-12');
check('fewer than 99% of a day’s bookings priced: not settled, and it says Uber prices overnight',
  d12.settled === false && /only 97\.0% of Sat 12 Sep’s bookings carry a fare yet — Uber prices a day overnight/i.test(d12.why || ''), j(d12));
const d11 = m3.days.find((x) => x.day === '2026-09-11');
check('a settled day is judged: over', d11.settled === true && d11.verdict === 'over' && !d11.provisional, j(d11));
const f3b = mk({ fares: { ...fares1, '2026-09-13': 400 }, cars: cars1, runs });
const d13b = computeMonth({ month: '2026-09', today: '2026-09-15', rows: [save1], facts: f3b }).days.find((x) => x.day === '2026-09-13');
check('an unsettled day that already beat its need is over, at least — whatever arrives can only add',
  d13b.verdict === 'over' && d13b.provisional === true, j(d13b));
check('99% is the monthly report’s own readiness line', SETTLED_COVERAGE === (await import('../src/monthly_report.js')).READY_COVERAGE);

/* ── 4. cars and drivers ──────────────────────────────────────────────────
   REVERSION (run 2026-10-02): count the cars that earned YESTERDAY only
   (CAR_DAYS 1) -> 52 passed, 1 FAILED ("a car idle yesterday still counts"). */
console.log('\n4. who counts');
const f4 = mk({ cars: { '2026-09-10': ['C1', 'C2'], '2026-09-14': ['C1'], '2026-09-02': ['C9'] } });
check('a car idle yesterday still counts; one that earned 8 days ago does not',
  carsAsOf(f4, '2026-09-15').size === 2 && !carsAsOf(f4, '2026-09-15').has('C9') && carsAsOf(f4, '2026-09-10').has('C9') === false
  && carsAsOf(f4, '2026-09-09').has('C9'), j([...carsAsOf(f4, '2026-09-15')]));
const lowTrips = await import('../src/low_trips_email.js');
check('an active driver is the 08:00 email’s rule: the day and the 7 before it', DRIVER_DAYS === lowTrips.ACTIVE_DAYS);
check('the trips target is the email’s minimum, read the same way',
  [{ low_trips_min: 12 }, {}, { low_trips_min: 0 }, { low_trips_min: 2.5 }, { low_trips_min: 'x' }]
    .every((c) => tripsTarget(c) === lowTrips.minTrips(c)));
const f4b = mk({ people: {
  '2026-09-14': { a: 12, b: 3 },
  '2026-09-08': { c: 5 },          // 7 days before: active on the 14th
  '2026-09-06': { d: 9 },          // 8 days before: not
}, cars: cars1, fares: fares1 });
const d14 = computeMonth({ month: '2026-09', today: '2026-09-15', rows: [save1], facts: f4b, min: 12 }).days.find((x) => x.day === '2026-09-14');
check('trips: 15 by 3 active drivers against 3 × 12 = 36; one reached 12; two drove',
  d14.trips === 15 && d14.active_drivers === 3 && d14.trips_target === 36 && d14.reached === 1 && d14.drove === 2
  && d14.trips_per_active === 5 && d14.trips_verdict === 'under', j(d14));

/* ── 5. against a database ────────────────────────────────────────────────
   October 2026 (31 days). C1–C10 each take one AED 10 fare a day from 20
   September; C11 joins on 4 October. The target is saved on the 3rd.
   REVERSION (run 2026-10-02): sum the month from the plans already rounded
   to the fils -> 50 passed, 3 FAILED: the month read 3,999.95 for a target
   typed as 4,000 ("raised on the 5th", the route and the workbook). */
console.log('\n5. saving it, against a real schema');
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let n = 0;
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, $9, $10, 'AED', '{}'::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.fleet || 'ecosine', o.id || `u-${o.driver}`, o.driver, o.plate, o.at, o.status || 'completed',
    o.pay || 'card', o.price === undefined ? 10 : o.price]);
for (const d of span('2026-09-20', '2026-10-31')) {
  for (let c = 1; c <= 10; c++) await T({ plate: `C${c}`, driver: `Test Driver ${c}`, at: `${d}T08:00:00Z` });
  if (d >= '2026-10-04') await T({ plate: 'C11', driver: 'Test Driver 11', at: `${d}T08:00:00Z` });
}
await T({ plate: 'C20', driver: 'Test Driver 20', at: '2026-10-01T09:00:00Z', status: 'cancelled', price: null });  // no fare: not a car that earned
await T({ plate: 'C21', driver: 'Test Driver 21', at: '2026-10-01T09:00:00Z', platform: 'fms', price: null });       // a journey
const at10 = (d, hhmm = '10:00') => new Date(`${d}T${hhmm}:00+04:00`);
let s = await saveTarget(q, { month: '2026-10', gross: 3100, now: at10('2026-10-03'), by: 7, byLabel: 'owner@example.test' });
check('saved on the 3rd over the 10 cars that earned in the 7 days before: AED 10 a car a day; the two days gone kept at 200',
  s.row?.cars === 10 && s.row.rate === 10 && s.row.past_plan === 200 && s.row.set_day === '2026-10-03', j(s));
let m = await monthTarget(q, { month: '2026-10', today: '2026-10-03', min: 12 });
check('the month target reads exactly what was typed, and the 1st was asked 100 and earned 100: over',
  m.summary.month_target === 3100 && m.days[0].needed === 100 && m.days[0].earned === 100 && m.days[0].verdict === 'over', j([m.summary, m.days[0]]));
check('a cancelled booking with no fare and a tracker journey make nobody a car that earned', m.days[2].cars === 10, String(m.days[2].cars));
s = await saveTarget(q, { month: '2026-10', gross: 3410, now: at10('2026-10-03', '10:20'), by: 7, byLabel: 'owner@example.test' });
m = await monthTarget(q, { month: '2026-10', today: '2026-10-03' });
const oct2Need = (await monthTarget(q, { month: '2026-10', today: '2026-10-05' })).days[1].needed;
check('corrected ten minutes later the same day: 3,410 is AED 11 a car a day, and the 1st is now asked 110',
  s.row.rate === 11 && m.summary.month_target === 3410 && m.days[0].plan === 110, j([s.row, m.days[0]]));
s = await saveTarget(q, { month: '2026-10', gross: 4000, now: at10('2026-10-05'), by: 7, byLabel: 'owner@example.test' });
m = await monthTarget(q, { month: '2026-10', today: '2026-10-05' });
check('raised on the 5th: the four days gone keep 110 each (440), the 27 left share 3,560 over 11 cars, the month reads 4,000, and the 2nd keeps the 110.33 it was asked',
  s.row.past_plan === 440 && s.row.cars === 11 && Math.abs(s.row.rate - 3560 / (11 * 27)) < 1e-6 && m.summary.month_target === 4000
  && m.days[1].needed === oct2Need && oct2Need === 110.33, j([s.row, m.summary.month_target, m.days[1].needed, oct2Need]));
check('the car that joined on the 4th counts from the 5th', m.days[3].cars === 10 && m.days[4].cars === 11, j(m.days.slice(3, 5).map((x) => x.cars)));
let bad = await saveTarget(q, { month: '2026-09', gross: 1000, now: at10('2026-10-05') });
check('a month that is over cannot be re-targeted', bad.error === 'month_over' && bad.status === 409, j(bad));
bad = await saveTarget(q, { month: '2026-10', gross: 0, now: at10('2026-10-05') });
check('zero is not a target', bad.error === 'bad_target');
bad = await saveTarget(q, { month: '2026-10', gross: 300, now: at10('2026-10-20') });
check('a month total below what the days gone were planned at is refused, with the figure',
  bad.error === 'below_past' && /planned at AED/.test(bad.detail), j(bad));
bad = await saveTarget(q, { month: '2027-01', gross: 1000, now: at10('2027-01-15') });
check('no car earned in the last 7 days: nothing to share a target over, said so', bad.error === 'no_cars', j(bad));
const nov = await monthTarget(q, { month: '2026-11', today: '2026-10-20' });
check('a month with no target says so, with where to set it — never a zero',
  nov.target === null && nov.summary === null && /No target is set for November 2026\. The Owner sets it in Set up › Access\./.test(nov.why), nov.why);

/* ── 6. the 1st of a month: yesterday belongs to the month before ──────── */
const firstNov = await monthTarget(q, { today: '2026-11-01' });
check('on the 1st, yesterday’s verdict is the last day of the month before, against that month’s target',
  firstNov.month === '2026-11' && firstNov.yesterday?.day === '2026-10-31' && firstNov.yesterday_month?.month === '2026-10'
  && firstNov.yesterday.needed != null, j([firstNov.yesterday, firstNov.yesterday_month?.month]));

/* ── 7. the seed ──────────────────────────────────────────────────────────
   REVERSION (run 2026-10-02): skip the "already applied" look-up -> the
   second boot sets low_trips_min back to 12 after the Owner moved it:
   49 passed, 4 FAILED ("a restart does not undo …" among them). */
console.log('\n7. TARGET_SEED');
let seed = await applyTargetSeed(db, { seed: '2026-11 1600000 trips=12', now: at10('2026-10-20') });
const cfgTrips = async () => (await q(`SELECT value FROM access_config WHERE key = 'low_trips_min'`))[0]?.value;
const novRows = await q(`SELECT gross_target, set_by, set_by_label FROM revenue_target WHERE month = '2026-11-01'`);
check('applied once: November at 1,600,000, set by the seed, and the trips a day at 12',
  seed.done === true && novRows.length === 1 && Number(novRows[0].gross_target) === 1600000 && novRows[0].set_by === null
  && novRows[0].set_by_label === 'system:seed' && Number(await cfgTrips()) === 12, j([seed, novRows, await cfgTrips()]));
await q(`UPDATE access_config SET value = '15' WHERE key = 'low_trips_min'`);
seed = await applyTargetSeed(db, { seed: '2026-11 1600000 trips=12', now: at10('2026-10-21') });
check('a restart does not undo the Owner’s own later change', seed.done === false && seed.why === 'already applied'
  && Number(await cfgTrips()) === 15, j([seed, await cfgTrips()]));
seed = await applyTargetSeed(db, { seed: '2026-10 9999999', now: at10('2026-10-21') });
check('a seed never overwrites a month that already has a target',
  seed.done === true && seed.row === null && (await q(`SELECT count(*)::int AS n FROM revenue_target WHERE gross_target = 9999999`))[0].n === 0, j(seed));
check('a malformed seed does nothing', (await applyTargetSeed(db, { seed: '1.6M for October' })).why === 'malformed');
const audit = await q(`SELECT actor_label, detail FROM access_audit WHERE action = 'target.seed' ORDER BY id`);
check('every seed applied is on the audit chain, by the system', audit.length === 2 && audit.every((a) => a.actor_label === 'system:seed'), j(audit));
const { verifyChain } = await import('../api/access/audit.js');
check('…and the chain still verifies', (await verifyChain(db)).ok === true);

/* ── 8. the routes ─────────────────────────────────────────────────────── */
console.log('\n8. GET /api/target and the workbook route');
const { mountAll } = await import('./mount.mjs');
const api = await mountAll(db);
const got = await api.get('/api/target?month=2026-10&asof=2026-10-06');
check('GET /api/target: the month, day by day, with yesterday', got.status === 200 && got.body.days.length === 31
  && got.body.yesterday?.day === '2026-10-05' && got.body.summary.month_target === 4000, j(got.body?.summary));
check('…and no staff email in it — who saved it is the admin panel’s',
  !JSON.stringify(got.body).includes('owner@example.test') && got.body.saves.every((x) => !('set_by_label' in x) && !('set_by' in x)),
  j(got.body.saves));
const gotNov = await api.get('/api/target?month=2026-11&asof=2026-10-21');
check('…a seeded month says it was seeded', gotNov.body.saves[0]?.seeded === true, j(gotNov.body.saves));
const xr = await fetch(`http://127.0.0.1:${api.port}/api/export/today.xlsx`);
check('GET /api/export/today.xlsx answers a workbook', xr.status === 200
  && /spreadsheetml/.test(xr.headers.get('content-type') || '') && /attachment; filename="today-/.test(xr.headers.get('content-disposition') || ''),
  `${xr.status} ${xr.headers.get('content-type')}`);
check('/api/target is on the cache’s never list', /'\/api\/target',/.test(readFileSync('api/cache.js', 'utf8')));

/* ── 9. the Today workbook ────────────────────────────────────────────────
   REVERSION (run 2026-10-02): write names whatever the role holds -> 52
   passed, 1 FAILED ("…withheld"). */
console.log('\n9. the Today workbook');
await q(`INSERT INTO insight (code, severity, category, entity_type, entity_id, title, detail, action, impact_aed, fleet_id, computed_at)
         VALUES ('bolt_cancels', 'critical', 'revenue', 'fleet', 'ecosine', '58% of Bolt jobs cancel (63 of 108)', 'Split rider- vs driver-initiated cancels.',
                 'Coach the drivers.', 969.08, 'ecosine', now())`).catch((e) => console.log('   (insight fixture:', String(e).slice(0, 120), ')'));
const { buildTodayWorkbook } = await import('../api/today_workbook.js');
const built = await buildTodayWorkbook({ q, now: at10('2026-10-06', '09:00') });
const book = readWorkbook(built.wb.toBuffer());
check('the six sheets, in the page’s order', book.sheetNames.join('|') === 'Target|Days|Cars yesterday|Drivers yesterday|Action list|Today so far',
  book.sheetNames.join('|'));
const table = (name) => {
  const rows = sheetNamed(book, name)?.rows || [];
  const hi = rows.findIndex((r) => r.filter((c) => c != null).length > 2 && r.every((c) => c == null || typeof c === 'string'));
  return rows.slice(hi + 1).filter((r) => r.some((c) => c != null)).map((r) => Object.fromEntries(rows[hi].map((k, i) => [k, r[i]])));
};
const pairs = Object.fromEntries((sheetNamed(book, 'Target')?.rows || []).filter((r) => r[0] && r[1] != null).map((r) => [r[0], r[1]]));
check('Target: the month target, the rate and today’s need are the page’s own',
  pairs['Month target now (AED)'] === 4000 && Math.abs(pairs['AED a car a day'] - 3560 / 297) < 0.006 && pairs['Trips a day per active driver (minimum)'] === 15,
  j(pairs));
const days = table('Days');
const d5 = days.find((r) => r.Day instanceof Date && r.Day.toISOString().startsWith('2026-10-05'));
check('Days: a row a day; the 5th asked its need and earned 110 (11 cars × 10)', days.length === 31 && d5?.['Earned (AED)'] === 110
  && d5?.Verdict && d5?.Cars === 11, j(d5));
const carsY = table('Cars yesterday');
check('Cars yesterday: every car that earned, with its share of the day’s need', carsY.length === 11
  && carsY.every((r) => r['Earned (AED)'] === 10) && carsY.filter((r) => r['Share (AED)'] != null).length === 11, j(carsY.slice(0, 2)));
const drv = table('Drivers yesterday');
check('Drivers yesterday: every active driver against the trips target', drv.length === 11 && drv.every((r) => r.Target === 15 && r.Trips === 1 && r['Short by'] === 14),
  j(drv.slice(0, 2)));
check('…each with the id the dashboard finds them by (test/interlinking)', drv.every((r) => /^u-Test Driver \d+$/.test(r['Driver id'] || '')),
  j(drv.slice(0, 2).map((r) => r['Driver id'])));
const d1x = days.find((r) => r.Day instanceof Date && r.Day.toISOString().startsWith('2026-10-01'));
check('Days: the trips chart’s columns — 10 trips by 10 active drivers against 10 × 15 = 150, under by 140',
  d1x?.Trips === 10 && d1x?.['Trips needed'] === 150 && d1x?.['Trips over (+) / under (−)'] === -140 && d1x?.['Trips verdict'] === 'under', j(d1x));
check('Target: the trips summary beside the revenue’s', pairs['Trips to yesterday'] === 52 && pairs['Trips needed to yesterday'] === 780
  && pairs['Trips a driver a day, month so far'] === 1 && pairs['Trip days judged / over / under / not settled'] === '5 / 0 / 5 / 0', j(pairs));
const acts = table('Action list');
check('Action list: the page’s own findings', acts.some((r) => /58% of Bolt jobs cancel/.test(r.Finding || '')), j(acts.slice(0, 1)));
const hidden = readWorkbook((await buildTodayWorkbook({ q, now: at10('2026-10-06', '09:00'), hide: new Set(['ID', 'REV']) })).wb.toBuffer());
const hrows = (name) => (sheetNamed(hidden, name)?.rows || []).flat().map(String).join('|');
check('a role without driver identity or revenue: names and money withheld, and the Action list withheld whole',
  !/Test Driver/.test(hrows('Drivers yesterday')) && !/u-Test/.test(hrows('Drivers yesterday')) && /\(withheld\)/.test(hrows('Drivers yesterday')) && /\(withheld\)/.test(hrows('Target'))
  && /Withheld: the findings name drivers/.test(hrows('Action list')) && !/58% of Bolt/.test(hrows('Action list')), hrows('Action list').slice(0, 200));

/* ── 10. the words on Today (api/public/target.js) ────────────────────────
   Green and red only on a finished, settled day; every coloured verdict
   carries an arrow and a word; today never coloured; behind with a day
   still unsettled is ink, not red; no target is a sentence, not a zero.
   REVERSION (run 2026-10-02): colour "behind" red whatever is unsettled ->
   62 passed, 1 FAILED ("behind, with a day not settled"). */
console.log('\n10. the words on Today');
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location ??= { hash: '', search: '', pathname: '/' };
globalThis.window ??= globalThis;
globalThis.document ??= { documentElement: { dataset: {}, getAttribute: () => null } };
const { targetView, targetHtml } = await import('../api/public/target.js');
const view = (month, y) => targetView({ ...month, yesterday: y }, null);
const cellOf = (vm, key) => vm.cells.find((c) => c.key === key);
const sep = (d) => m3.days.find((x) => x.day === d);
const vUnder = view(m3, sep('2026-09-01'));
check('yesterday under and settled: red, with ▼ and the word',
  cellOf(vUnder, 'yesterday').tone === 'under' && cellOf(vUnder, 'yesterday').value === '▼ Under by AED 30.00', j(cellOf(vUnder, 'yesterday')));
const vOver = view(m3, sep('2026-09-11'));
check('yesterday over and settled: green, with ▲ and the word', cellOf(vOver, 'yesterday').tone === 'over'
  && /^▲ Over by AED /.test(cellOf(vOver, 'yesterday').value), j(cellOf(vOver, 'yesterday')));
const vWait = view(m3, sep('2026-09-13'));
check('yesterday not settled: neither colour, and what it waits for', cellOf(vWait, 'yesterday').tone === 'wait'
  && cellOf(vWait, 'yesterday').value === 'Not settled yet'
  && cellOf(vWait, 'yesterday').subs.some((x) => /Bolt · Ecosine has not delivered Sun 13 Sep yet/.test(x.text)), j(cellOf(vWait, 'yesterday')));
const vLeast = view(m3, sep('2026-09-12'));
check('over before it settled: green, and it says "at least" and why', cellOf(vLeast, 'yesterday').tone === 'over'
  && cellOf(vLeast, 'yesterday').subs.some((x) => /^At least: Only 97\.0%/.test(x.text)), j(cellOf(vLeast, 'yesterday').subs));
check('today is never coloured', cellOf(vOver, 'today').tone === null && /to earn$/.test(cellOf(vOver, 'today').value), j(cellOf(vOver, 'today')));
check('every coloured figure carries an arrow and a word, never colour alone',
  [vUnder, vOver, vLeast].flatMap((vm) => vm.cells).filter((c) => c.tone === 'over' || c.tone === 'under')
    .every((c) => /^[▲▼] /.test(c.value) || c.value === 'Month target met'));
/* Behind, with a day not settled: ink. The same month with that day settled: red. */
const behindFacts = mk({ fares: { '2026-09-01': 50, '2026-09-02': 50 }, cars: cars1, runs: [
  { source: 'uber', fleet: 'ecosine', ws: '2026-09-01', we: '2026-09-30', fin: endOf('2026-09-01') + 3600e3 }] });
const behind = computeMonth({ month: '2026-09', today: '2026-09-03', rows: [save1], facts: behindFacts });
check('behind, with a day not settled: said in ink, not red', cellOf(view(behind, behind.days[1]), 'month').tone === 'wait'
  && /▼ AED 100\.00 behind/.test(cellOf(view(behind, behind.days[1]), 'month').value), j(cellOf(view(behind, behind.days[1]), 'month')));
const behindSettled = computeMonth({ month: '2026-09', today: '2026-09-03', rows: [save1], facts: mk({ fares: { '2026-09-01': 50, '2026-09-02': 50 }, cars: cars1 }) });
check('…and once every day has settled, red', cellOf(view(behindSettled, behindSettled.days[1]), 'month').tone === 'under');
const none = targetView(computeMonth({ month: '2026-09', today: '2026-09-15', rows: [], facts: facts1 }), null);
check('no target: the sentence and where to set it, and no figure at all', none.absent === 'No target is set for September 2026. The Owner sets it in Set up › Access.'
  && none.cells.length === 0, j(none));
const html = targetHtml(vOver, { link: (d) => `#day/${d}` });
check('the desktop panel: the verdict classes, a link to each day gone, and nothing undefined',
  /class="tg-cell tg-over" data-tg="yesterday"/.test(html) && /href="#day\/2026-09-01"/.test(html) && /tg-d tg-today/.test(html)
  && !/undefined|NaN|\[object Object\]/.test(html), html.slice(0, 200));

/* ── 12. the trips chart ──────────────────────────────────────────────────
   September 2026 with NO revenue target saved — the minimum always exists.
   a1–a10 drive from the 1st; b1 joins on the 4th. Uber has delivered every
   day; Bolt only to the 4th, so the 5th and 6th are not settled. Today is
   the 7th. Minimum 12.
     1st  a1–a10 × 12 = 120 of 10 × 12 = 120   met exactly
     2nd  a1–a10 × 6  =  60 of 120              under by 60
     3rd  a1–a10 × 12 = 120 of 120 — NOT 180: a short day is not carried
     4th  b1 alone 30 of 11 × 12 = 132          under (the ten are still active)
     5th  a1–a10 × 18 + b1 × 20 = 200 of 132    over before it settled: at least
     6th  a1 × 10 = 10 of 132                   short and not settled: neither colour
   REVERSIONS (run 2026-10-02, 85 checks in the file): the trips summary
   only when a revenue target is saved -> 73 passed, 12 FAILED ("no revenue
   target, and the trips chart is still there" first); carry a short day's
   shortfall into the next day's need -> 73 passed, 12 FAILED ("a day short
   is not carried" among them); the month's figure as the average of the
   days' own ratios -> 84 passed, 1 FAILED ("a driver a day is the month's
   trips ÷ its driver-days"); judge a short day under whether or not it
   settled -> 79 passed, 6 FAILED ("not settled and short" among them); no
   trips band when the revenue has no target -> 79 passed, 6 FAILED ("no
   revenue target: the revenue says so, and the trips chart is drawn under
   it" first); the trips fields left out of api/access/manifest.json -> 84
   passed, 1 FAILED ("a role without booking counts"). */
console.log('\n12. the trips minimum, its own chart');
const tenAt = (n) => Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`a${i + 1}`, n]));
const f12 = mk({
  people: {
    '2026-09-01': tenAt(12), '2026-09-02': tenAt(6), '2026-09-03': tenAt(12), '2026-09-04': { b1: 30 },
    '2026-09-05': { ...tenAt(18), b1: 20 }, '2026-09-06': { a1: 10 }, '2026-09-07': { a1: 3, a2: 2 },
  },
  runs: [
    { source: 'uber', fleet: 'ecosine', ws: '2026-09-01', we: '2026-09-30', fin: endOf('2026-09-06') + 3600e3 },
    { source: 'bolt', fleet: 'ecosine', ws: '2026-09-01', we: '2026-09-04', fin: endOf('2026-09-04') + 3600e3 },
  ],
});
const mT = computeMonth({ month: '2026-09', today: '2026-09-07', rows: [], facts: f12, min: 12 });
const td = (d) => mT.days.find((x) => x.day === `2026-09-0${d}`);
const ts = mT.trips_summary || {};  // {} so a reverted summary fails its checks rather than stopping the file
check('no revenue target, and the trips chart is still there: the minimum always exists',
  mT.summary === null && ts.min === 12 && ts.judged === 5, j(mT.trips_summary));
check('exactly the minimum is over, not under (120 of 120)', td(1).trips_verdict === 'over' && td(1).trips_diff === 0 && td(1).trips_pct === 100, j(td(1)));
check('a day short is not carried: the 2nd under by 60, and the 3rd still asks 10 × 12 = 120 — and is over',
  td(2).trips_verdict === 'under' && td(2).trips_diff === -60 && td(3).trips_target === 120 && td(3).trips_verdict === 'over', j([td(2), td(3).trips_target]));
check('a driver active in the 8 days counts on a day off: the 4th asks 11 × 12 = 132 of b1’s 30, and one of one who drove reached 12',
  td(4).active_drivers === 11 && td(4).trips_target === 132 && td(4).trips_verdict === 'under' && td(4).reached === 1 && td(4).drove === 1, j(td(4)));
check('over before it settled: over, at least', td(5).trips_verdict === 'over' && td(5).trips_provisional === true && td(5).settled === false, j(td(5)));
check('not settled and short: neither colour, and the channel it waits for', td(6).trips_verdict === 'unsettled'
  && /Bolt · Ecosine has not delivered Sun 6 Sep yet/.test(td(6).why || ''), j(td(6)));
const meanOfRatios = [1, 2, 3, 4, 5, 6].reduce((a, d) => a + td(d).trips / td(d).active_drivers, 0) / 6;
check('a driver a day is the month’s trips ÷ its driver-days — 540 ÷ 63 = 8.57, not the days’ own ratios averaged (8.64)',
  ts.trips === 540 && ts.driver_days === 63 && ts.per_active === 8.57 && Math.abs(meanOfRatios - 8.64) < 0.01 && ts.needed === 756, j(ts));
check('…3 over, 2 under, 1 not settled', ts.over === 3 && ts.under === 2 && ts.unsettled === 1, j(ts));
check('today asks its own active drivers × 12, and counts what is done so far', ts.today_target === 132 && ts.today_active === 11
  && ts.today_trips === 5 && td(7).trips_verdict === null, j(ts));
const { tripsView } = await import('../api/public/target.js');
const vmT = targetView({ ...mT, yesterday: td(4) }, null);
const tc = (vm, key) => (vm.trips?.cells || []).find((c) => c.key === key) || {};
check('no revenue target: the revenue says so, and the trips chart is drawn under it',
  /^No target is set for September 2026/.test(vmT.absent || '') && vmT.trips?.cells.length === 4 && vmT.trips?.strip.length === 30, j(vmT.trips?.cells.map((c) => c.key)));
check('yesterday short and settled: red, with ▼, the word and the count', tc(vmT, 'trips-yesterday').tone === 'under'
  && tc(vmT, 'trips-yesterday').value === '▼ Under by 102 trips'
  && (tc(vmT, 'trips-yesterday').subs || []).some((x) => x.text === '30 of 132 needed · 22.7%'), j(tc(vmT, 'trips-yesterday')));
const yMet = tripsView({ ...mT, yesterday: td(1) }).cells[0] || {};
check('…met to the trip says so, in green', yMet.value === '▲ Met exactly' && yMet.tone === 'over', j(yMet));
const yWait = tripsView({ ...mT, yesterday: td(6) }).cells[0] || {};
check('yesterday not settled: neither colour, and what it waits for', yWait.tone === 'wait' && yWait.value === 'Not settled yet'
  && (yWait.subs || []).some((x) => /Bolt · Ecosine has not delivered/.test(x.text)), j(yWait));
check('today is never coloured: 132 trips to complete, 5 done', tc(vmT, 'trips-today').tone === null
  && tc(vmT, 'trips-today').value === '132 trips to complete' && Math.abs(tc(vmT, 'trips-today').bar - (100 * 5) / 132) < 1e-9, j(tc(vmT, 'trips-today')));
check('the month below the minimum with a day not settled: said in ink, not red', tc(vmT, 'trips-month').tone === 'wait'
  && tc(vmT, 'trips-month').value === '▼ 8.6 a driver a day', j(tc(vmT, 'trips-month')));
check('the strip: green, red, green, red, green at least, hatched, today, to come',
  (vmT.trips?.strip || []).slice(0, 8).map((d) => d.tone).join(' ') === 'over under over under over wait today future'
  && /\(at least\)$/.test(vmT.trips?.strip[4].title || ''), (vmT.trips?.strip || []).slice(0, 8).map((d) => d.tone).join(' '));
check('every coloured trips figure carries an arrow and a word, never colour alone',
  [vmT, targetView({ ...mT, yesterday: td(1) }, null)].flatMap((vm) => vm.trips?.cells || []).filter((c) => c.tone === 'over' || c.tone === 'under')
    .every((c) => /^[▲▼] /.test(c.value)));
const htmlT = targetHtml(vmT, { link: (d) => `#day/${d}` });
check('the desktop panel draws the trips band under the revenue, with its own keys and one legend',
  htmlT.indexOf('data-tg-band="revenue"') < htmlT.indexOf('data-tg-band="trips"') && /data-tg="trips-yesterday"/.test(htmlT)
  && (htmlT.match(/class="tg-legend"/g) || []).length === 1 && !/undefined|NaN|\[object Object\]/.test(htmlT), htmlT.slice(0, 160));
/* The access layer: a role that holds revenue but not booking counts. No
   built-in role is shaped so, but a grant can be; the trip figures are
   declared BK in api/access/manifest.json, and an undeclared one would ride
   through the shaper untouched. */
const { shapeBody } = await import('../api/access/shape.js');
const { lookupEntry } = await import('../api/access/manifest.js');
const tEntry = lookupEntry('GET', '/api/target');
const shaped = shapeBody(JSON.parse(JSON.stringify({ ...mT, yesterday: td(4) })), tEntry, { REV: 'F', VEH: 'F', SYS: 'F' }).body;
const COUNTS = ['trips', 'trips_target', 'trips_diff', 'trips_pct', 'trips_per_active', 'reached', 'drove'];
const leaks = [...shaped.days, shaped.yesterday].flatMap((d) => COUNTS.filter((k) => d[k] != null).map((k) => `${d.day}.${k}`))
  .concat(['trips', 'needed', 'reached', 'per_active', 'today_target', 'today_trips'].filter((k) => shaped.trips_summary?.[k] != null).map((k) => `trips_summary.${k}`));
check('a role without booking counts: every trip figure withheld, and the trips chart says why instead of drawing empty days',
  leaks.length === 0 && shaped._withheld?.BK === '' && /^Not shown to your role: /.test(tripsView(shaped).absent || ''), leaks.slice(0, 6).join(' '));

/* ── 11. one Action-list query ─────────────────────────────────────────── */
const server = readFileSync('api/server.js', 'utf8');
check('the Action list route and the workbook read one query (api/insights_sql.js)',
  /insightListSql\(INSIGHT_LIMIT\)/.test(server) && !/`WITH run AS \(/.test(server.slice(server.indexOf("app.get('/api/insights'"), server.indexOf("app.get('/api/insights/summary'"))));

console.log(`\n${pass} passed, ${fail} failed`);
api.server.close();
process.exit(fail ? 1 : 0);
