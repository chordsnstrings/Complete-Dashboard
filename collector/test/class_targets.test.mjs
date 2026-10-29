/* DAILY TARGETS BY VEHICLE CLASS — api/revenue_target.js and everything that
   reads it (sql/schema_v111.sql class_target).
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-29: "Let me set targets vehicle wise. Make model year
   - per day target, which will reflect everywhere." What is pinned:
     1. a day's plan is the sum, over the cars it counts, of each car's class
        figure × the weekday weight; a class with no figure, and a car with no
        make or model, is asked the figure for every other car;
     2. a class save never re-scores a day before it, and under one figure
        for every car it is the month save to the fils;
     3. it carries into every later month, shared by that month's own
        weekday weights; a later save of either kind wins from its day;
     4. each class's part of the month adds up to the month, its fares are
        its plates', and fares with no plate are their own row;
     5. a driver's share of a day follows the class of the car they drove (on
        a day off, the car they last drove), the shares add up to the plan,
        and under one figure for every car they are equal — the Month target
        page and Low performers give the same figures;
     6. against a real schema: the save's refusals, the month, one car's
        page, the panel's "usually earns";
     7. the words (Today strip, the Target page's table), the workbooks'
        Classes sheet, and the access layer withholding the new figures.
   Synthetic plates (C…) and drivers (p…) only.
   REVERSIONS, run 2026-10-29, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { Workbook } from '../src/xlsx_write.js';
import { readWorkbook } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

const rt = await import('../api/revenue_target.js');
const { computeMonth, addDays, classKey, classLabel, driverShares, saveClassTarget, monthTarget, carTarget, classEditor, classRows } = rt;
const tm = await import('../api/target_month.js');
const lp = await import('../api/lowperf.js');

const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const cls = (make, model, year) => ({ make, model, year, key: classKey(make, model, year), label: classLabel({ make, model, year }) });
const BYD = cls('BYD', 'Han EV', 2025);
const MY = cls('Tesla', 'Model Y', 2023);
const HL = cls('Toyota', 'Highlander', 2023);
/* C1–C4 BYD Han EV 2025, C5–C6 Model Y 2023, C7 no make or model on file,
   C8 a Highlander the Owner gives no figure of its own. */
const classOf = new Map([['C1', BYD], ['C2', BYD], ['C3', BYD], ['C4', BYD], ['C5', MY], ['C6', MY], ['C8', HL]]);
const PLATES = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];

/* Every car takes AED 100 a day from 20 August; AED 50 a day comes with no
   plate. p1 drives C1, p2 C5, p3 C7 every day; p4 drives C8 until the 14th
   of September and then stops — still active for the 8 days after. */
function facts(from, to) {
  const days = new Map(), carDays = new Map(), plateFares = new Map(), personDays = new Map(), personCar = new Map();
  for (const d of span(from, to)) {
    days.set(d, { day: d, fares: 850, priced: 100, chargeable: 100, completed: 100, bookings: 100 });
    carDays.set(d, new Set(PLATES));
    plateFares.set(d, new Map(PLATES.map((p) => [p, 100])));
    const ppl = new Map([['p1', 10], ['p2', 10], ['p3', 10]]);
    const car = new Map([['p1', 'C1'], ['p2', 'C5'], ['p3', 'C7']]);
    if (d <= '2026-09-14') { ppl.set('p4', 10); car.set('p4', 'C8'); }
    personDays.set(d, ppl);
    personCar.set(d, car);
  }
  return { from, to, days, carDays, plateFares, personDays, personCar,
    runs: [{ source: 'uber', fleet: 'ecosine', ws: from, we: to, fin: Date.parse(`${addDays(to, 1)}T12:00:00+04:00`) }] };
}
const F = facts('2026-08-20', '2026-10-31');
const flat = (o) => ({ id: o.id ?? 1, gross_target: o.rate * o.cars * 30, cars: o.cars, rate: o.rate, past_plan: 0, set_day: o.day,
  set_at: o.at || `${o.day}T06:00:00Z`, set_by: null, set_by_label: 'owner@example.test' });
const clsRow = (o) => ({ id: o.id ?? 1, set_day: o.day, set_at: o.at || `${o.day}T07:00:00Z`, set_by: 7, set_by_label: 'owner@example.test',
  rates: o.rates, other_rate: o.other, cars: [{ ...BYD, cars: 4 }, { ...MY, cars: 2 }, { ...HL, cars: 1 }, { make: null, model: null, year: null, cars: 1 }],
  weights: o.weights || null, weights_basis: null });
const SEP_FLAT = flat({ day: '2026-09-01', rate: 100, cars: 8 });
const SEP_CLS = clsRow({ day: '2026-09-15', rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: 120 }, { make: 'Tesla', model: 'Model Y', year: 2023, rate: 90 }], other: 80 });

/* ── 1–2. the plan, and history ───────────────────────────────────────── */
console.log('\n1. a day’s plan is every car at its class’s figure');
const sep = computeMonth({ month: '2026-09', today: '2026-09-20', rows: [SEP_FLAT], facts: F, min: 10, classes: [SEP_CLS], classOf });
const day = (t, d) => t.days.find((x) => x.day === d);
check('before the class save, one figure for every car: 8 cars × 100 = 800 a day',
  day(sep, '2026-09-01').plan === 800 && day(sep, '2026-09-14').plan === 800, j([day(sep, '2026-09-01').plan, day(sep, '2026-09-14').plan]));
check('from it: 4 × 120 + 2 × 90 + the car with no make or model at 80 + the Highlander (no figure of its own) at 80 = 820',
  day(sep, '2026-09-15').plan === 820 && day(sep, '2026-09-30').plan === 820, j([day(sep, '2026-09-15').plan, day(sep, '2026-09-30').plan]));
check('the month is the sum: 14 × 800 + 16 × 820 = 24,320, and "a car on an average day" is today’s cars averaged (820 ÷ 8)',
  sep.summary.month_target === 24320 && sep.summary.rate === 102.5 && sep.summary.kind === 'class' && sep.summary.other_rate === 80,
  j([sep.summary.month_target, sep.summary.rate, sep.summary.kind]));
check('nothing typed for the month: no "set at", no "moved since", and the cars at the save are its own',
  sep.summary.gross_set === null && sep.summary.since_set === null && sep.summary.cars_at_set === 8 && sep.target.kind === 'class'
  && sep.target.rates.length === 2 && sep.target.other_rate === 80, j([sep.summary.gross_set, sep.summary.since_set, sep.target]));
check('a day’s "AED a car" is its plan over its cars', day(sep, '2026-09-16').rate === 102.5, String(day(sep, '2026-09-16').rate));
/* REVERSION (run 2026-10-29): plan = save.rate * cars * w for a class save
   too (its rate is undefined) -> every class day's plan null: 10 checks FAIL
   across sections 1–5, and the Low performers check then throws (a day with
   no plan has no shares). */

console.log('\n2. a class save never re-scores a day before it, and one figure for every car is the month save');
const flatOnly = computeMonth({ month: '2026-09', today: '2026-09-20', rows: [SEP_FLAT], facts: F, min: 10, classes: [], classOf });
const pick = (t) => t.days.filter((x) => x.day < '2026-09-15').map((x) => [x.plan, x.needed, x.verdict]);
check('the 14 days before it keep the plan, the need and the verdict they had', j(pick(sep)) === j(pick(flatOnly)), j(pick(sep).slice(0, 2)));
const same = clsRow({ day: '2026-09-15', rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: 100 }, { make: 'Tesla', model: 'Model Y', year: 2023, rate: 100 },
  { make: 'Toyota', model: 'Highlander', year: 2023, rate: 100 }], other: 100 });
const sameT = computeMonth({ month: '2026-09', today: '2026-09-20', rows: [SEP_FLAT], facts: F, min: 10, classes: [same], classOf });
check('every class at 100 is the month save at 100, day for day, to the fils',
  j(sameT.days.map((x) => [x.plan, x.needed, x.verdict])) === j(flatOnly.days.map((x) => [x.plan, x.needed, x.verdict])) && sameT.summary.month_target === flatOnly.summary.month_target,
  j([sameT.summary.month_target, flatOnly.summary.month_target]));
const anchored = computeMonth({ month: '2026-09', today: '2026-09-20', rows: [], facts: F, min: 10, classes: [SEP_CLS], classOf });
check('the month’s first save is a class save: the days before it are planned at it too, over each day’s own cars',
  day(anchored, '2026-09-01').plan === 820 && anchored.summary.month_target === 820 * 30, j([day(anchored, '2026-09-01').plan, anchored.summary.month_target]));

/* ── 3. later months, and later saves ─────────────────────────────────── */
console.log('\n3. it carries into every later month; a later save wins from its day');
const W = [0.8, 0.9, 1, 1, 1.2, 1.1, 1];   // Sunday first
const oct = computeMonth({ month: '2026-10', today: '2026-10-05', rows: [], facts: F, min: 10, classes: [SEP_CLS], classOf,
  mw: { month: '2026-10', from_day: '2026-10-01', trips: W, fares: W, basis: { weeks: 8, used: 8 } } });
check('October has no save of its own and still has a target: September’s figures, carried',
  oct.target?.kind === 'class' && oct.saves.length === 1 && oct.saves[0].carried === true && oct.saves[0].kind === 'class', j(oct.saves));
check('…shared by October’s own weekday weights: a Sunday 820 × 0.8, a Thursday 820 × 1.2',
  day(oct, '2026-10-04').plan === 656 && day(oct, '2026-10-01').plan === 984 && oct.saves[0].weights_month === '2026-10',
  j([day(oct, '2026-10-04').plan, day(oct, '2026-10-01').plan]));
/* REVERSION (run 2026-10-29): `carried` left out of computeMonth's saves ->
   43 passed, 3 FAILED: October reads "No target is set" (both checks above)
   and the 1st–14th below lose August's figures. */
const later = computeMonth({ month: '2026-09', today: '2026-09-20', rows: [SEP_FLAT, flat({ id: 2, day: '2026-09-18', rate: 50, cars: 8 })],
  facts: F, min: 10, classes: [SEP_CLS], classOf });
check('a month save after it governs from its own day: the 15th–17th at 820, the 18th on at 50 × 8',
  day(later, '2026-09-17').plan === 820 && day(later, '2026-09-18').plan === 400 && later.summary.kind === 'month',
  j([day(later, '2026-09-17').plan, day(later, '2026-09-18').plan]));
const cOld = clsRow({ id: 1, day: '2026-08-10', rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: 999 }], other: 999 });
const two = computeMonth({ month: '2026-09', today: '2026-09-20', rows: [], facts: F, min: 10, classes: [cOld, { ...SEP_CLS, id: 2 }], classOf });
check('of two earlier class saves only the later one reaches a month: August’s 999 is superseded on the 15th, and the 1st–14th carry it',
  day(two, '2026-09-01').plan === 999 * 8 && day(two, '2026-09-15').plan === 820 && two.saves.length === 2, j([day(two, '2026-09-01').plan, two.saves.length]));

/* ── 4. each class's part of the month ────────────────────────────────── */
console.log('\n4. each class’s part of the month');
const row = (t, label) => t.classes.find((c) => c.label === label);
const sumK = (t, k) => Math.round(t.classes.filter((c) => !c.no_plate).reduce((n, c) => n + (c[k] || 0), 0) * 100) / 100;
check('BYD Han EV 2025: 4 cars at 120 — 14 days at 400 and 16 at 480, 13,280 for the month; 8,000 planned and 7,600 earned to yesterday',
  row(sep, 'BYD Han EV 2025')?.cars_now === 4 && row(sep, 'BYD Han EV 2025').rate === 120 && row(sep, 'BYD Han EV 2025').month_plan === 13280
  && row(sep, 'BYD Han EV 2025').planned === 8000 && row(sep, 'BYD Han EV 2025').earned === 7600 && row(sep, 'BYD Han EV 2025').ahead === -400,
  j(row(sep, 'BYD Han EV 2025')));
check('the Highlander has no figure of its own: it is asked the figure for every other car, and says so',
  row(sep, 'Toyota Highlander 2023')?.rate === 80 && row(sep, 'Toyota Highlander 2023').uses_other === true
  && row(sep, 'BYD Han EV 2025').uses_other === false, j(row(sep, 'Toyota Highlander 2023')));
const bare = sep.classes.find((c) => c.key == null && !c.no_plate);
check('the car with no make or model is its own row, named by plate, at the figure for every other car',
  bare?.label === 'No make or model on file' && j(bare.plates) === j(['C7']) && bare.rate === 80 && bare.uses_other === true, j(bare));
check('the classes add up to the month, to what was planned and to what was earned — the fares with no plate their own row',
  sumK(sep, 'month_plan') === sep.summary.month_target && sumK(sep, 'planned') === sep.summary.planned
  && Math.round((sumK(sep, 'earned') + sep.classes.find((c) => c.no_plate).earned) * 100) / 100 === sep.summary.earned
  && sep.classes.find((c) => c.no_plate).earned === 950, j([sumK(sep, 'month_plan'), sep.summary.month_target, sumK(sep, 'earned'), sep.summary.earned]));
check('yesterday and today, a class at a time: BYD asked 480 yesterday and today, and earned 400 yesterday',
  row(sep, 'BYD Han EV 2025').yday_plan === 480 && row(sep, 'BYD Han EV 2025').yday_earned === 400 && row(sep, 'BYD Han EV 2025').plan_today === 480,
  j(row(sep, 'BYD Han EV 2025')));
check('under one figure for every car the table is still each class’s share of it',
  row(flatOnly, 'BYD Han EV 2025')?.rate === 100 && row(flatOnly, 'BYD Han EV 2025').uses_other === false && flatOnly.summary.kind === 'month',
  j(row(flatOnly, 'BYD Han EV 2025')));
check('one car’s part of a day: C1 120, the Highlander 80, a plate not counted 0, a day with no target null',
  sep.carPlanOn('2026-09-16', 'C1') === 120 && sep.carPlanOn('2026-09-16', 'C8') === 80 && sep.carPlanOn('2026-09-16', 'C99') === 0
  && computeMonth({ month: '2026-09', today: '2026-09-20', rows: [], facts: F, classOf }).carPlanOn('2026-09-16', 'C1') === null);
check('the arithmetic’s own maps never reach an answer', !('saveOn' in JSON.parse(j(sep))) && !('carPlanOn' in JSON.parse(j(sep)))
  && !j(sep.saves).includes('rateBy'));

/* ── 5. a driver's share ──────────────────────────────────────────────── */
console.log('\n5. a driver’s share follows the class of the car they drove');
const active = new Set(['p1', 'p2', 'p3', 'p4']);
const sh = driverShares(sep, F, '2026-09-16', 820, active);
const r2 = (v) => Math.round(v * 100) / 100;
check('the 16th: p1 (BYD, 120), p2 (Model Y, 90), p3 (no class, 80), and p4 off but last in the Highlander (80): 820 × 120/370 …',
  r2(sh.get('p1')) === 265.95 && r2(sh.get('p2')) === 199.46 && r2(sh.get('p3')) === 177.3 && r2(sh.get('p4')) === 177.3,
  j([...sh].map(([k, v]) => [k, r2(v)])));
check('…and the shares add up to the day’s plan', Math.abs([...sh.values()].reduce((n, v) => n + v, 0) - 820) < 1e-9);
const eq = driverShares(sep, F, '2026-09-10', 800, active);
check('under one figure for every car they are equal, as they always were: 200 each', [...eq.values()].every((v) => v === 200), j([...eq]));
/* REVERSION (run 2026-10-29): driverShares returns plan ÷ drivers for a
   class save too -> 44 passed, 2 FAILED: the first check (205 each) and the
   Month target page's (every driver the same 3,825). */
const ddOf = (f) => {
  const byDay = new Map();
  for (const [d, ppl] of f.personDays) byDay.set(d, new Map([...ppl].map(([pk, n]) => [pk, { trips: n, gross: n * 9 }])));
  const who = new Map(['p1', 'p2', 'p3', 'p4'].map((pk) => [pk, { pk, name: `Driver ${pk}`, driver_ext_id: pk, fleet: 'ecosine', platforms: ['uber'] }]));
  return { byDay, who };
};
const dd = ddOf(F);
const view = tm.monthViewOf({ month: '2026-09', today: '2026-09-20', rows: [SEP_FLAT], facts: F, dd, min: 10, classes: [SEP_CLS], classOf });
const tgt = (pk) => view.drivers.rows.find((x) => x.pk === pk)?.gross_target;
check('the Month target page: p1’s target is 14 days at 200 and 5 at their BYD share, more than p3’s in a car with no class',
  tgt('p1') > tgt('p3') && Math.abs(view.drivers.rows.reduce((n, x) => n + x.gross_target, 0) - view.drivers.totals.plan) < 0.05,
  j(view.drivers.rows.map((x) => [x.pk, x.gross_target]).concat([['plan', view.drivers.totals.plan]])));
const judged = lp.judgeDays({ lo: '2026-09-01', to: '2026-09-19', today: '2026-09-20', min: 10,
  months: [{ month: '2026-09', rows: [SEP_FLAT], facts: F, mw: null, classes: [SEP_CLS], classOf }] });
const tl = (pk) => lp.tally(pk, judged, dd);
check('Low performers gives each driver the Month target page’s figure, to the fils',
  ['p1', 'p2', 'p3', 'p4'].every((pk) => r2(tl(pk).target) === tgt(pk)), j(['p1', 'p2', 'p3', 'p4'].map((pk) => [r2(tl(pk).target), tgt(pk)])));
check('…and a day’s cell carries that driver’s own share', judged.find((d) => d.day === '2026-09-16').shares.get('p1') === sh.get('p1'));

/* ── 6. against a real schema ─────────────────────────────────────────── */
console.log('\n6. saving them, against a real schema');
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO vehicle (plate, make, model, year) VALUES ('C1','BYD','Han EV',2025),('C2','BYD','Han EV',2025),('C3','Tesla','Model Y',2023)`);
let n = 0;
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ('uber', $1, 'ecosine', $2, $3, $4, $5::timestamptz, $5::timestamptz + interval '20 minutes', 'completed', 'card', $6, 'AED', '{}'::jsonb)`,
  [`t${++n}`, `u-${o.driver}`, o.driver, o.plate, o.at, o.price]);
/* Each car a fare a day from 1 October: C1 and C2 AED 300, C3 AED 200, C4
   (no make or model) AED 100. */
for (const d of span('2026-09-25', '2026-10-28')) {
  for (const [p, price] of [['C1', 300], ['C2', 300], ['C3', 200], ['C4', 100]]) await T({ plate: p, driver: `Test Driver ${p}`, at: `${d}T08:00:00Z`, price });
}
const at = (d, hhmm = '10:00') => new Date(`${d}T${hhmm}:00+04:00`);
let bad = await saveClassTarget(q, { rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: 600 }], now: at('2026-10-29') });
check('no figure for every other car: refused, saying so', bad.error === 'bad_other' && /every other car/.test(bad.detail), j(bad));
bad = await saveClassTarget(q, { rates: [{ make: 'Ford', model: 'T', year: 1908, rate: 600 }], other: 500, now: at('2026-10-29') });
check('a class not on the register: refused, by name', bad.error === 'unknown_class' && /Ford T 1908/.test(bad.detail), j(bad));
bad = await saveClassTarget(q, { rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: 600 }, { make: 'byd', model: 'han  ev', year: '2025', rate: 610 }], other: 500, now: at('2026-10-29') });
check('one class twice, however it is spelt: refused', bad.error === 'duplicate_class', j(bad));
bad = await saveClassTarget(q, { rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: -5 }], other: 500, now: at('2026-10-29') });
check('a figure at or below zero: refused, by class', bad.error === 'bad_rate' && /BYD Han EV 2025/.test(bad.detail), j(bad));
const ok = await saveClassTarget(q, { rates: [{ make: 'BYD', model: 'Han EV', year: 2025, rate: 350 }, { make: 'Tesla', model: 'Model Y', year: 2023, rate: '' }],
  other: 150, now: at('2026-10-29'), by: 7, byLabel: 'owner@example.test' });
check('saved: a class sent with no figure is left to the figure for every other car; the cars each class counted are kept',
  ok.row?.rates.length === 1 && ok.row.other === 150 && ok.row.set_day === '2026-10-29'
  && j(ok.row.cars_at_set.map((c) => c.cars)) === j([2, 1, 1]), j(ok.row));
const mt = await monthTarget(q, { month: '2026-10', today: '2026-10-29', min: 12 });
check('October from the 29th: C1, C2 at 350, C3 (Model Y, no figure) and C4 (no make or model) at 150 — 1,000 a day',
  day(mt, '2026-10-29').plan === 1000 && day(mt, '2026-10-31').plan === 1000 && mt.summary.kind === 'class', j([day(mt, '2026-10-29'), mt.summary.kind]));
check('…and the days before it, with no save of their own, planned at it over each day’s own cars',
  day(mt, '2026-10-02').plan === 1000 && mt.summary.month_target === 31000, j([day(mt, '2026-10-02').plan, mt.summary.month_target]));
check('the month by class, read from the register: BYD earned 2 × 300 × 28 to yesterday',
  row(mt, 'BYD Han EV 2025')?.earned === 16800 && row(mt, 'Tesla Model Y 2023')?.uses_other === true, j(mt.classes));
const car = await carTarget(q, 'C1', { today: '2026-10-29' });
check('one car’s page: its class, its figure, and the last 7 days — 350 asked and 300 earned each, under on all 7',
  car.class?.label === 'BYD Han EV 2025' && car.rate === 350 && car.uses_other === false && car.days.length === 7
  && car.totals?.plan === 2450 && car.totals.earned === 2100 && car.totals.over === 0 && car.days.every((d) => d.verdict === 'under'), j(car).slice(0, 400));
const car4 = await carTarget(q, 'C4', { today: '2026-10-29' });
check('a car with no make or model: the figure for every other car, and says so', car4.class === null && car4.rate === 150 && car4.uses_other === true, j(car4).slice(0, 200));
const ed = await classEditor(q, { today: '2026-10-29' });
check('the panel: every class on the register with its cars now, and what a car of it usually earns a day',
  ed.classes.length === 2 && ed.classes[0].label === 'BYD Han EV 2025' && ed.classes[0].cars_now === 2 && ed.classes[0].usual === 300
  && ed.classes[1].usual === 200 && ed.unclassed.cars_now === 1 && j(ed.unclassed.plates) === j(['C4']) && ed.fleet_usual === 225, j(ed));
check('every save kept', (await classRows(q, '2026-10-29')).length === 1);

/* ── 7. the words, the files, the access layer ───────────────────────── */
console.log('\n7. the words, the workbooks and the access layer');
const { targetView, classesHtml } = await import('../api/public/target.js');
const vm = targetView({ ...sep, yesterday: day(sep, '2026-09-19') }, null);
check('the Today strip: "targets by vehicle class", the average a car, and today’s cars each at its class',
  /targets by vehicle class, AED 102\.50 a car on an average day on average/.test(vm.meta)
  && vm.cells.find((c) => c.key === 'today')?.subs[0].text.includes('each at its class’s target'), j([vm.meta, vm.cells.find((c) => c.key === 'today')?.subs[0]]));
const html = classesHtml(sep);
check('the Target page’s table: every class, the car with no class by plate, the Highlander’s missing figure, the fares with no plate, the fleet’s row',
  /BYD Han EV 2025/.test(html) && /C7 — asked the figure for every other car/.test(html) && /no figure of its own/.test(html)
  && /Fares with no plate/.test(html) && /All cars/.test(html) && !/undefined|NaN|\[object Object\]/.test(html), html.slice(0, 300));
check('…and under one figure for every car it says the table is each class’s share', /each class’s share of it/.test(classesHtml(flatOnly)));
const book = (wbOf) => readWorkbook(wbOf.toBuffer());
const wb = new Workbook({ created: new Date('2026-09-20T08:00:00Z') });
tm.classSheet(wb, sep, (c, x) => x);
const sheet = book(wb).sheets.find((s) => s.name === 'Classes');
check('the workbooks’ Classes sheet: a row a class, the figures as the page prints them',
  sheet && sheet.rows.some((r) => r.includes('BYD') && r.includes(13280)) && sheet.rows.some((r) => r.includes('Fares with no plate')), j(sheet?.rows?.slice(0, 4)));
const wbH = new Workbook({ created: new Date('2026-09-20T08:00:00Z') });
tm.classSheet(wbH, sep, (c, x) => (c === 'REV' ? '(withheld)' : x));
check('…withheld cell by cell from a role without revenue', !book(wbH).sheets.find((s) => s.name === 'Classes').rows.some((r) => r.includes(13280)));
const { shapeBody } = await import('../api/access/shape.js');
const { lookupEntry } = await import('../api/access/manifest.js');
const body = JSON.parse(j({ ...sep, saves: sep.saves }));
const noRev = shapeBody(JSON.parse(j(body)), lookupEntry('GET', '/api/target'), { VEH: 'F', SYS: 'F', BK: 'F' }).body;
check('a role without revenue: every class figure and rate withheld from /api/target, the cars kept',
  noRev.classes.every((c) => c.rate == null && c.planned == null && c.earned == null && c.month_plan == null)
  && noRev.target.rates.every((r) => r.rate == null) && noRev.target.other_rate == null && noRev.summary.other_rate == null
  && noRev.classes.find((c) => c.label === 'BYD Han EV 2025').cars_now === 4, j(noRev.classes[0]));
const noVeh = shapeBody(JSON.parse(j(body)), lookupEntry('GET', '/api/target'), { REV: 'F', SYS: 'F', BK: 'F' }).body;
check('a role without vehicles: the plates and car counts withheld', noVeh.classes.every((c) => c.cars_now == null && (c.plates == null)), j(noVeh.classes.slice(-2)));
const carE = lookupEntry('GET', '/api/target/car');
const carNoRev = shapeBody(JSON.parse(j(car)), carE, { VEH: 'F', SYS: 'F' }).body;
check('/api/target/car is declared, and a role without revenue gets no figure from it',
  !!carE && carNoRev.rate == null && carNoRev.days.every((d) => d.plan == null && d.earned == null) && carNoRev.totals.plan == null, j(carNoRev).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
