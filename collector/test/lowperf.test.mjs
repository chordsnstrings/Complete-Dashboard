/* The Low performers page and its watch lists (api/lowperf.js,
   api/lowperf_routes.js, api/lowperf_workbook.js).
   ──────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-19: "I want reports like this for the low performer
   on the platform … more comprehensive like this so that we can check their
   performance improvement as well", "don't keep drivers who only drives in
   hotel, or let us filter it out", and who belongs on it: "anyone who is
   earning less than the target per day". Days off count; the month so far;
   lists kept by the Owner and the Operations managers.

   What is pinned:
     1. the people below target and their figures ARE the Month target
        page's for the same days (driverTargets) — same people, same gross,
        same target, to the fils — and a day off still asks its share;
     2. the hotel switch: hotel-only hidden by default, mostly-hotel on
        request, everyone on request, each counted as hidden;
     3. the trend: a person is improving or slipping only against everyone
        else's move, and a short week says why instead of guessing;
     4. watch lists: before against after, against everyone else; a member
        re-keyed by a merge is found by their accounts; one gone is named;
     5. against a real schema: the routes answer, agree with
        /api/target/month, only a signed-in Owner or Operations manager can
        save or change a list, the server (not the page) decides the
        members, and both workbooks read back;
     6. access: names and money withheld with the reason, one fleet's rows
        for a one-fleet reader, never a zero;
     7. the page: the address round-trips, four head cells, each day shaded
        against its own target with "off" in words, the written line says
        what the columns do not, a print page of its own;
     8. more granular (the operator, the same day: "this should have average
        of all the days shown for the driver as well. and more granular data
        on the page"): two averages a row (a day active, a day off as nothing;
        a day driven, absent when no day was), each day's list and
        everyone-else figures under the grid's head in the figure the cells
        print, the day in detail from the bookings in Dubai time, the causes
        held against everyone else's middle values, weekdays and hours, the
        workbook's four new sheets, and the new fields withheld by class.

   REVERSIONS (run 2026-10-19, each against this file as it then stood; 65
   pass for sections 1-6 and 78 with section 7, the page, added):
     · share each day's NEEDED instead of its plan (api/lowperf.js
       judgeDays) -> 54 passed, 11 FAILED, among them "the same gross,
       target and days active, each to the fils" (x asked 4,137.23 against
       the Month target page's 4,033.33 — the shortfall charged twice);
     · ask a share only of a day the driver drove (tally) -> the run dies
       after FAILING "the same people below target as the Month target
       page" (o, five days off, vanished) and "a day active and not driven
       asks its share";
     · drop the hotel-only rule (populationOf) -> 60 passed, 5 FAILED,
       among them "by default the hotel-only driver is left out";
     · judge the trend on the person's own move, not against everyone
       else's (verdictOf) -> 64 passed, 1 FAILED: "a person down 12 points
       while everyone else fell 12 is steady, not slipping";
     · end the weeks on the period's last day, settled or not (lowperfOf)
       -> 64 passed, 1 FAILED: "the weeks end on the last day that can be
       judged, the 20th";
     · find a saved member by person key only (watchOf) -> the run dies
       after FAILING "a member re-keyed by a merge since the save is found
       by an account they held";
     · let a visitor who is not signed in through (api/lowperf_routes.js
       editorOf) -> 64 passed, 1 FAILED: "a visitor … cannot save a list";
     · save the people the page names instead of the period's own
       (POST /api/lowperf/watch) -> 62 passed, 3 FAILED, among them "the
       members are the period's below-target people, never one the page
       adds";
     · the page: shade a day off as "under half" instead of "off"
       (api/public/lowperf.js cellClass) -> 76 passed, 2 FAILED, among them
       "the grid: o's five days off print off";
   and for section 8 (run 2026-10-19, 104 pass with it):
     · average a day driven over the active days (rowOf) -> 103 passed, 1
       FAILED: "o, five days off: … a day driven not measured … never a
       zero";
     · the day's reference rows over those who drove only (dayAverages) ->
       1 FAILED: "each day's references … 1 Oct: (0 + 80 + 160 + 120) ÷ 4";
     · a late start named without short days (causesOf) -> 1 FAILED: "a
       cause is named only when it is plainly so";
     · rates from one day driven (measuresOf) -> 1 FAILED: "a rate needs
       three days driven";
     · the day's clock read in UTC (loadDetail MIN_OF) -> 102 passed, 2
       FAILED: "the route's day in detail: first request 09:30 …" and the
       day sheet's clocks;
     · the grid's reference rows always in fares (api/public/lowperf.js
       gridHtml) -> 1 FAILED: "the cell switch … never fares against a start
       time";
     · rows[].days[].first left off the manifest -> 1 FAILED: "a role without
       bookings or conduct: the day's times … withheld".

     · drop the fleet from the page's address (pageHref) -> 77 passed,
       1 FAILED: "the address carries the period, the hotel switch and the
       fleet, and reads back". */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { readWorkbook, sheetNamed } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;
const near = (a, b, e = 0.011) => a != null && b != null && Math.abs(a - b) <= e;

const { computeMonth, addDays } = await import('../api/revenue_target.js');
const { driverTargets } = await import('../api/target_month.js');
const LP = await import('../api/lowperf.js');
const { lowperfWorkbookOf, watchWorkbookOf } = await import('../api/lowperf_workbook.js');
const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };

/* ── the fixture ───────────────────────────────────────────────────────────
   October 2026 read on the 22nd, a target of AED 100 a car a day over ten
   cars that earn every day: every day is planned at 1,000. Five drivers drive
   every day from 20 September, so each day's share is 1,000 ÷ 5 = 200:
     a, b  300 a day — 150% of target, the "everyone else"
     x     80 a day to the 14th, then 160 — 40% then 80%: improving
     y     160 a day to the 14th, then 80 — 80% then 40%: slipping
     z     120 a day throughout — 60%: steady; hotel-only
   and o, active from a trip on 28 September, drove nothing in October: five
   days off that still ask their share. The 21st is settled; nothing later. */
const PER_DAY = (pk, d) => ({ a: 300, b: 300, z: 120, x: d <= '2026-10-14' ? 80 : 160, y: d <= '2026-10-14' ? 160 : 80 }[pk]);
const people = {};
for (const d of span('2026-09-20', '2026-10-21')) people[d] = { a: 10, b: 10, x: 5, y: 5, z: 4 };
people['2026-09-28'].o = 3;
const gross = (pk, d) => (pk === 'o' ? 90 : PER_DAY(pk, d));
const dd = {
  byDay: new Map(Object.entries(people).map(([d, o]) => [d, new Map(Object.entries(o).map(([pk, n]) => [pk, { trips: n, gross: gross(pk, d) }]))])),
  who: new Map(['a', 'b', 'x', 'y', 'z', 'o'].map((pk, i) => [pk, { pk, name: `Driver ${pk.toUpperCase()}`, driver_ext_id: `u-${pk}`,
    fleet: i % 2 ? 'egari' : 'ecosine', platforms: pk === 'z' ? ['hotel'] : ['uber'] }])),
};
const dayFares = (d) => Object.entries(people[d] || {}).reduce((s, [pk]) => s + gross(pk, d), 0);
const facts = {
  days: new Map(span('2026-09-20', '2026-10-21').map((d) => [d, { day: d, fares: dayFares(d), priced: 100, chargeable: 100, completed: 100, bookings: 100 }])),
  carDays: new Map(span('2026-09-01', '2026-10-31').map((d) => [d, new Set(Array.from({ length: 10 }, (_, i) => `C${i + 1}`))])),
  personDays: new Map(Object.entries(people).map(([d, o]) => [d, new Map(Object.entries(o))])),
  runs: [],
};
const save = { id: 1, gross_target: 31000, cars: 10, rate: 100, past_plan: 0, set_day: '2026-10-01',
  set_at: '2026-10-01T06:00:00Z', set_by: null, set_by_label: 'owner@example.test' };
const TODAY = '2026-10-22';
const months = [{ month: '2026-09', rows: [], facts, mw: null }, { month: '2026-10', rows: [save], facts, mw: null }];
const ex = (o) => ({ bookings_w: 0, hotel_w: 0, bookings: 0, completed: 0, cash: 0, by_platform: {}, plate: null, last_booking: null, ids: [], ...o });
const extras = new Map([
  ['a', ex({ bookings_w: 200, bookings: 200, completed: 190, ids: ['u-a'] })],
  ['b', ex({ bookings_w: 200, bookings: 200, completed: 190, ids: ['u-b'] })],
  ['x', ex({ bookings_w: 100, bookings: 100, completed: 90, cash: 25, plate: 'C3', ids: ['u-x', 'b-x'] })],
  ['y', ex({ bookings_w: 100, hotel_w: 60, bookings: 100, completed: 100, ids: ['u-y'] })],
  ['z', ex({ bookings_w: 80, hotel_w: 80, bookings: 80, completed: 80, ids: ['h-z'] })],
  ['o', ex({ bookings_w: 3, bookings: 0, ids: ['u-o'] })],
]);
const hours = new Map([['x', { online_min: 600, online_days: 5 }]]);
const bundle = { from: '2026-10-01', to: '2026-10-21', lo: '2026-09-17', today: TODAY, min: 12, months, dd, extras, hours };
const v = LP.lowperfOf({ ...bundle, hotel: 'show' });
const by = Object.fromEntries(v.rows.map((r) => [r.pk, r]));

/* ── 1. the Month target page's people and figures ─────────────────────── */
console.log('\n1. the people below target are the Month target page’s, to the fils');
const t = computeMonth({ month: '2026-10', today: TODAY, rows: [save], facts, min: 12 });
const mt = driverTargets({ t, facts, dd, min: 12 });
const mtBehind = mt.rows.filter((r) => r.money_on === false);
check('the same people below target as the Month target page, hotel drivers shown',
  j(v.rows.map((r) => r.pk).sort()) === j(mtBehind.map((r) => r.pk).sort()), j([v.rows.map((r) => r.pk), mtBehind.map((r) => r.pk)]));
check('…with the same gross, target and days active, each to the fils',
  mtBehind.every((m) => by[m.pk] && by[m.pk].gross === m.gross && by[m.pk].gross_target === m.gross_target
    && by[m.pk].days_active === m.days_active && by[m.pk].days_driven === m.days_driven),
  j(mtBehind.map((m) => [m.pk, m.gross, m.gross_target, by[m.pk]?.gross, by[m.pk]?.gross_target])));
check('twenty-one days counted, nothing left out', v.counted_days === 21 && v.left_out.length === 0 && v.days.length === 21, j([v.counted_days, v.left_out]));
check('each day asks 1,000 ÷ the day’s active drivers — six on 1–5 Oct (o still active from the 28th), five after',
  v.days[4].active === 6 && near(v.days[4].share, 166.67) && v.days[5].active === 5 && v.days[5].share === 200, j(v.days.slice(0, 7).map((d) => [d.active, d.share])));
check('the shares add up to the plan: 21 × 1,000', v.totals.plan === 21000, j(v.totals));
check('a day active and not driven asks its share: o, five days off, 0 of 833.33', by.o && by.o.days_active === 5 && by.o.days_off === 5
  && by.o.days_driven === 0 && by.o.gross === 0 && near(by.o.gross_target, 833.33) && by.o.band === 'lt50', j(by.o));
check('…and its grid says off on those days, never a day that asked nothing', by.o.days.slice(0, 5).every((c) => c.active === true && c.share > 0 && c.trips === 0)
  && by.o.days[6].active === false && by.o.days[6].share === null, j(by.o.days.slice(0, 7)));
check('furthest behind first: o (0%), then x, z, y', v.rows.map((r) => r.pk).join('') === 'oxzy', v.rows.map((r) => `${r.pk}:${r.gross_pct}`).join(' '));
check('bands: under half o; half to 80% x (2,240 of 4,033.33: 55.5%), z (62.5%) and y (69.4%)', j(v.totals.bands) === j({ lt50: 1, lt80: 3, lt100: 0 })
  && by.x.gross_pct === 55.5 && near(by.x.gross_target, 4033.33) && by.z.gross_pct === 62.5 && by.y.gross_pct === 69.4, j([v.totals.bands, v.rows.map((r) => r.gross_pct)]));
check('a and b are on target, so not listed — and they are everyone else', !by.a && !by.b && v.yardstick.rest.people === 2 && v.yardstick.rest.pct > 140, j(v.yardstick.rest));
check('the below-target sums are summed unrounded: earned, asked, short', near(v.totals.below_target, v.rows.reduce((s, r) => s + r.gross_target, 0), 0.03)
  && near(v.totals.below_short, v.totals.below_target - v.totals.below_gross), j(v.totals));
check('x: cash rides and Uber hours online come through as measured', by.x.cash_pct === 25 && by.x.online_h === 10 && by.x.plate === 'C3', j(by.x));
check('…and a person with no hours filed reads none, not zero', by.y.online_h === null && by.y.online_days === 0, j([by.y.online_h, by.y.online_days]));

const pending = LP.lowperfOf({ ...bundle, to: '2026-10-21', months: [{ month: '2026-09', rows: [], facts, mw: null },
  { month: '2026-10', rows: [save], facts: { ...facts, days: new Map([...facts.days].map(([d, f]) => [d, d === '2026-10-21' ? { ...f, priced: 80 } : f])) }, mw: null }], hotel: 'show' });
check('a day still being priced is left out and named with its own reason', pending.counted_days === 20 && pending.left_out[0]?.day === '2026-10-21'
  && /80\.0% of Wed 21 Oct’s bookings carry a fare/.test(pending.left_out[0].why), j(pending.left_out));
check('…and the weeks end on the last day that can be judged, the 20th', pending.weeks[2].to === '2026-10-20' && pending.weeks[2].counted_days === 7, j(pending.weeks));
const noTarget = LP.lowperfOf({ ...bundle, months: [{ month: '2026-09', rows: [], facts, mw: null }, { month: '2026-10', rows: [], facts, mw: null }] });
check('no target: nobody is called below it — the reason instead', noTarget.rows.length === 0 && noTarget.counted_days === 0
  && /No target was set for October 2026/.test(noTarget.left_out[0]?.why || '') && /can be judged/.test(noTarget.why || ''), j([noTarget.why, noTarget.left_out[0]]));
const p1 = LP.periodOf({ today: '2026-11-01' });
check('the default period is the month so far — on the 1st, the whole month before', p1.from === '2026-10-01' && p1.to === '2026-10-31', j(p1));
const p2 = LP.periodOf({ today: TODAY, from: '2026-10-05', to: '2026-10-30' });
check('a period that runs into today ends yesterday, and says so', p2.to === '2026-10-21' && /not over/.test(p2.notes[0] || ''), j(p2));

/* ── 2. the hotel switch ───────────────────────────────────────────────── */
console.log('\n2. hotel drivers');
const hide = LP.lowperfOf({ ...bundle });
check('by default the hotel-only driver is left out, and counted as left out', !hide.rows.some((r) => r.pk === 'z')
  && hide.totals.hidden_hotel_only === 1 && hide.hotel === 'hide', j(hide.totals));
const mostly = LP.lowperfOf({ ...bundle, hotel: 'mostly' });
check('“mostly hotel” also leaves out y (60% of bookings on the hotel channel)', !mostly.rows.some((r) => ['y', 'z'].includes(r.pk))
  && mostly.totals.hidden_mostly_hotel === 1 && mostly.totals.hidden_hotel_only === 1, j(mostly.totals));
check('“show” keeps everyone, z with its hotel share', by.z.hotel_only === true && by.z.hotel_share === 100 && v.totals.hidden_hotel_only === 0);
const egari = LP.lowperfOf({ ...bundle, hotel: 'show', fleet: 'egari' });
check('one fleet: its drivers only, the rest counted as another fleet’s', egari.rows.every((r) => r.fleet === 'egari') && egari.totals.hidden_other_fleet > 0, j(egari.totals));

/* ── 3. the trend ──────────────────────────────────────────────────────── */
console.log('\n3. better or worse, against everyone else');
check('three weeks ending on the last counted day: 1–7, 8–14, 15–21 Oct', j(v.weeks.map((w) => [w.from, w.to])) === j([['2026-10-01', '2026-10-07'], ['2026-10-08', '2026-10-14'], ['2026-10-15', '2026-10-21']]), j(v.weeks));
check('x went from 40% to 80% while everyone else stayed at 150%: improving, +40 points', by.x.trend.verdict === 'improving'
  && by.x.weeks[1].pct === 40 && by.x.weeks[2].pct === 80 && by.x.trend.change === 40 && by.x.trend.rest_change === 0, j(by.x.trend));
check('y went from 80% to 40%: slipping', by.y.trend.verdict === 'slipping' && by.y.trend.change === -40, j(by.y.trend));
check('z held at 60%: steady', by.z.trend.verdict === 'steady' && by.z.trend.change === 0, j(by.z.trend));
check('o, active no day of the last two weeks: too few days to say — and says why', by.o.trend.verdict === null && /a span needs 3 to say/.test(by.o.trend.why), j(by.o.trend));
const quiet = LP.verdictOf({ pct: 50, days_active: 7, label: 'A' }, { pct: 38, days_active: 7, label: 'B' }, 100, 88);
check('a person down 12 points while everyone else fell 12 is steady, not slipping — a quiet week moves everyone',
  quiet.verdict === 'steady' && quiet.change === -12 && quiet.relative === 0, j(quiet));
check('…and the same fall while everyone else held is slipping', LP.verdictOf({ pct: 50, days_active: 7, label: 'A' }, { pct: 38, days_active: 7, label: 'B' }, 100, 100).verdict === 'slipping');
check('the counts of each', j(v.totals.trend) === j({ improving: 1, steady: 1, slipping: 1, unknown: 1 }), j(v.totals.trend));

/* ── 4. watch lists ────────────────────────────────────────────────────── */
console.log('\n4. a watch list, followed');
const watch = { id: 1, name: 'Fifteenth', saved_day: '2026-10-15', hotel: 'hide', fleet: null };
const sp = LP.spansOf({ saved: watch.saved_day, today: TODAY });
check('by default the 14 days before the save against the save day to yesterday', sp.a.from === '2026-10-01' && sp.a.to === '2026-10-14'
  && sp.b.from === '2026-10-15' && sp.b.to === '2026-10-21' && sp.defaults, j(sp));
const members = [{ pk: 'x-before-a-merge', ids: ['b-x'], name: 'Driver X' }, { pk: 'y', ids: ['u-y'], name: 'Driver Y' },
  { pk: 'gone', ids: ['u-gone'], name: 'Driver Gone' }];
const w = LP.watchOf({ watch, members, a: sp.a, b: sp.b, ...bundle, lo: '2026-10-01' });
const wb = Object.fromEntries(w.rows.map((r) => [r.pk, r]));
check('a member re-keyed by a merge since the save is found by an account they held', wb.x && wb.x.rekeyed === true && wb.x.saved_pk === 'x-before-a-merge', j(w.rows.map((r) => [r.pk, r.saved_pk])));
check('a member found nowhere is named, with why — not dropped', w.missing.length === 1 && w.missing[0].name === 'Driver Gone' && /No booking/.test(w.missing[0].why), j(w.missing));
check('x: 1,120 of 2,633.33 before (42.5%), 1,120 of 1,400 after (80%) — up 37.5 points against everyone else’s 12.3: improving',
  wb.x.a.gross === 1120 && wb.x.a.target === 2633.33 && wb.x.a.pct === 42.5 && wb.x.b.pct === 80 && wb.x.move.change === 37.5
  && wb.x.move.rest_change === 12.3 && wb.x.move.verdict === 'improving', j([wb.x.a, wb.x.b, wb.x.move]));
check('y: slipping', wb.y.move.verdict === 'slipping', j(wb.y.move));
check('everyone else is everyone active but the list, under the list’s hotel setting: a, b and o — not z, hotel-only',
  w.rest.people === 3 && w.rest.a.pct === 137.7 && w.rest.b.pct === 150, j(w.rest));
check('the grid starts 14 days before the save', w.from === '2026-10-01' && w.days[0].day === '2026-10-01' && w.rows[0].days.length === w.days.length, j([w.from, w.days.length]));
const two = LP.spansOf({ saved: watch.saved_day, today: TODAY, a: '2026-10-13', b: '2026-10-20' });
const wt = LP.watchOf({ watch, members, a: two.a, b: two.b, ...bundle, lo: '2026-10-01' });
check('any two days compared: Tue 13 Oct against Tue 20 Oct, one active day each enough to say',
  two.a.label === 'Tue 13 Oct' && two.b.label === 'Tue 20 Oct' && wt.rows.find((r) => r.pk === 'x').move.verdict === 'improving', j(wt.rows.map((r) => r.move)));

/* ── 5. against a real schema ──────────────────────────────────────────── */
console.log('\n5. the routes, against a real schema');
const db = new PGlite();
await applySchema(db);
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let n = 0;
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, $10, $9, 'AED', '{}'::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.fleet || 'ecosine', o.id ?? null, o.driver ?? null, o.plate, o.at, o.status || 'completed',
    o.price === undefined ? 30 : o.price, o.pay || 'card']);
for (const d of span('2026-09-22', '2026-10-06')) {
  for (let k = 0; k < 3; k++) await T({ id: 'u-1', driver: 'Test Driver 1', plate: 'C1', at: `${d}T0${k + 5}:00:00Z`, pay: k ? 'card' : 'cash' });
  await T({ platform: 'bolt', id: 'b-1', driver: 'Test Driver 1', plate: 'C1', at: `${d}T09:00:00Z`, price: 20 });
  for (let k = 0; k < 2; k++) await T({ id: 'u-2', driver: 'Test Driver 2', plate: 'C2', fleet: 'egari', at: `${d}T0${k + 5}:30:00Z`, price: 25 });
  await T({ platform: 'hotel', id: 'h-4', driver: 'Test Driver 4', plate: 'C5', at: `${d}T11:00:00Z`, price: 10 });
  await T({ plate: 'C4', at: `${d}T10:00:00Z`, price: 15 });
}
await T({ id: 'u-3', driver: 'Test Driver 3', plate: 'C3', at: '2026-09-25T08:00:00Z' });
const { saveTarget } = await import('../api/revenue_target.js');
await saveTarget(q, { month: '2026-10', gross: 6200, now: new Date('2026-10-01T10:00:00+04:00'), by: 7, byLabel: 'owner@example.test' });
const { mountAll } = await import('./mount.mjs');
let as = null;   // who the next request is from
const api = await mountAll(db, { pre: (app) => app.use((req, _res, next) => { if (as) req.fm = as; next(); }) });
api.post = async (p, b) => {
  const res = await fetch(`http://127.0.0.1:${api.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: null, raw: text.slice(0, 200) }; }
};
const OPS = { kind: 'user', user: { id: 21, email: 'ops@example.test' }, access: { caps: ['watchlist.edit', 'export'] }, levels: {} };
const ANL = { kind: 'user', user: { id: 22, email: 'analyst@example.test' }, access: { caps: ['export'] }, levels: {} };

const ASOF = '2026-10-07';
const got = await api.get(`/api/lowperf?from=2026-10-01&to=2026-10-06&hotel=show&asof=${ASOF}`);
const month = await api.get(`/api/target/month?month=2026-10&asof=${ASOF}`);
const L = got.body;
check('GET /api/lowperf answers the period', got.status === 200 && L.from === '2026-10-01' && L.to === '2026-10-06' && L.counted_days > 0, `${got.status} ${j(L).slice(0, 300)}`);
const mb = (month.body.drivers?.rows || []).filter((r) => r.money_on === false);
check('…the same people below target as /api/target/month for the same days, with the same figures',
  month.body.drivers.counted_days === L.counted_days
  && j(mb.map((r) => [r.name, r.gross, r.gross_target]).sort()) === j(L.rows.map((r) => [r.name, r.gross, r.gross_target]).sort()),
  j([mb.map((r) => [r.name, r.gross, r.gross_target]), L.rows.map((r) => [r.name, r.gross, r.gross_target])]));
const lr = Object.fromEntries(L.rows.map((r) => [r.name, r]));
check('Test Driver 3, active on the 1st and 2nd from a trip on 25 September, drove neither: two days off, below target',
  lr['Test Driver 3']?.days_active === 2 && lr['Test Driver 3'].days_off === 2 && lr['Test Driver 3'].gross === 0, j(lr['Test Driver 3']));
check('the hotel-only driver is on it with hotel shown — and gone by default, counted', lr['Test Driver 4']?.hotel_only === true
  && (await api.get(`/api/lowperf?from=2026-10-01&to=2026-10-06&asof=${ASOF}`)).body.totals.hidden_hotel_only === 1, j(lr['Test Driver 4']));
const t1 = (await api.get(`/api/lowperf?from=2026-10-01&to=2026-10-06&hotel=show&asof=${ASOF}&fleet=ecosine`)).body;
check('Test Driver 1 (Uber and Bolt) is one person: a cash ride in four is 25%, completed 100%',
  t1.rows.every((r) => r.fleet === 'ecosine') && (!lr['Test Driver 1'] || (lr['Test Driver 1'].cash_pct === 25 && lr['Test Driver 1'].completion_pct === 100)),
  j(lr['Test Driver 1'] || t1.rows.map((r) => r.name)));
check('…not held by the response cache: /api/lowperf is on its never list', /'\/api\/lowperf',/.test(readFileSync('api/cache.js', 'utf8')));

const body = { name: 'First week of October', from: '2026-10-01', to: '2026-10-06', hotel: 'show' };
as = null;
let r = await api.post('/api/lowperf/watch', body);
check('a visitor who is not signed in cannot save a list — even in open mode', r.status === 401 && r.body.error === 'signin', j(r));
as = ANL;
r = await api.post('/api/lowperf/watch', body);
check('a signed-in role without the capability is refused, with who can', r.status === 403 && /Owner and the Operations managers/.test(r.body.detail), j(r));
as = OPS;
r = await api.post('/api/lowperf/watch', { ...body, pks: [...L.rows.map((x) => x.pk), 'someone-on-target'] });
const listId = r.body.list?.id;
check('an Operations manager saves it; the members are the period’s below-target people, never one the page adds',
  r.status === 200 && r.body.list.members === L.rows.length && r.body.list.period_from === '2026-10-01', j(r));
const stored = await q('SELECT pk, ids, at_save FROM lowperf_watch_member WHERE watch_id = $1 ORDER BY pk', [listId]);
check('each member is kept with every account they held and their figures at the save, as the server computed them',
  stored.length === L.rows.length && stored.every((m) => m.at_save && typeof m.at_save.pct === 'number')
  && stored.some((m) => m.ids.includes('u-1') && m.ids.includes('b-1')) === !!lr['Test Driver 1'], j(stored.map((m) => [m.ids, m.at_save?.pct])));
as = null;
const lists = await api.get('/api/lowperf/watch');
check('GET /api/lowperf/watch lists it, with how many members — and no one named', lists.status === 200 && lists.body.lists[0]?.id === listId
  && !/Test Driver/.test(j(lists.body)), j(lists.body));
const f = await api.get(`/api/lowperf/watch/${listId}?asof=2026-10-07&a=2026-10-01..2026-10-03&b=2026-10-04..2026-10-06`);
check('GET /api/lowperf/watch/:id follows it: members, both spans, everyone else', f.status === 200 && f.body.rows.length === L.rows.length
  && f.body.a.label === 'Thu 1 Oct – Sat 3 Oct' && f.body.b.label === 'Sun 4 Oct – Tue 6 Oct' && f.body.rest.people >= 1, `${f.status} ${j(f.body).slice(0, 400)}`);
const missing = await api.get('/api/lowperf/watch/99999');
check('a list that does not exist is a 404 with why', missing.status === 404 && /No watch list/.test(missing.body.detail), j(missing));
as = OPS;
const drop = L.rows[0].pk;
r = await api.post(`/api/lowperf/watch/${listId}`, { name: 'Renamed', remove: [drop], add: ['nobody-at-all'] });
check('rename, remove one and try to add someone who drove nothing: renamed, one fewer, the stranger refused in words',
  r.status === 200 && r.body.list.name === 'Renamed' && r.body.list.members === L.rows.length - 1 && /drove nothing/.test(r.body.unknown || ''), j(r));
const kept = await q('SELECT removed_at, removed_by FROM lowperf_watch_member WHERE watch_id = $1 AND pk = $2', [listId, drop]);
check('removal stamps the row, never deletes it', kept.length === 1 && kept[0].removed_at && Number(kept[0].removed_by) === 21, j(kept));
r = await api.post(`/api/lowperf/watch/${listId}`, { archive: true });
check('archived lists leave the listing', r.status === 200 && r.body.list.archived === true
  && !(await api.get('/api/lowperf/watch')).body.lists.some((x) => x.id === listId), j(r.body));
as = null;

const x1 = await fetch(`http://127.0.0.1:${api.port}/api/export/lowperf.xlsx?from=2026-10-01&to=2026-10-06&hotel=show&asof=${ASOF}`);
const book = readWorkbook(Buffer.from(await x1.arrayBuffer()));
check('GET /api/export/lowperf.xlsx: the eight sheets', x1.status === 200
  && book.sheetNames.join('|') === 'Summary|Below target|Day by day (AED)|Day by day (% of target)|Day detail|Why below target|Weekdays|Hours',
  `${x1.status} ${book.sheetNames.join('|')}`);
const flat = (bk, name) => (sheetNamed(bk, name)?.rows || []).flat().map(String).join('|');
check('…every below-target driver in it', L.rows.every((x) => flat(book, 'Below target').includes(x.name)), flat(book, 'Below target').slice(0, 300));
check('…and a day off reads “off” on the % sheet', !lr['Test Driver 3'] || /Test Driver 3\|Ecosine\|off\|off/.test(flat(book, 'Day by day (% of target)')), flat(book, 'Day by day (% of target)').slice(0, 400));
const x2 = await fetch(`http://127.0.0.1:${api.port}/api/export/lowperf-watch.xlsx?id=${listId}&asof=2026-10-07`);
const book2 = readWorkbook(Buffer.from(await x2.arrayBuffer()));
check('GET /api/export/lowperf-watch.xlsx: the list followed, as a workbook', x2.status === 200
  && book2.sheetNames.join('|') === 'Watch list|Members|Day by day (AED)|Day by day (% of target)|Day detail', book2.sheetNames.join('|'));
/* The day in detail, from the bookings themselves (loadDetail): Test Driver
   2 books at 05:30 and 06:30 UTC, twenty minutes each — 09:30 and 10:30 in
   Dubai, the last drop-off at 10:50, forty minutes on jobs, car C2. */
const d2 = lr['Test Driver 2'];
const d2day = d2?.days.find((c) => c.trips > 0) || {};
check('the route’s day in detail: first request 09:30, last drop-off 10:50, 40 minutes on jobs, two bookings, Uber, C2 — Dubai time',
  d2day.first === 570 && d2day.last === 650 && d2day.job_min === 40 && d2day.bookings === 2 && j(d2day.platforms) === j(['uber'])
  && d2day.plate === 'C2' && d2day.abandoned === 0 && d2day.km === null, j(d2day));
check('…and their trips by the hour requested: 09:00 and 10:00, one a day each; the fleet’s bookings beside them',
  d2 && d2.hours[9] === d2.days_driven && d2.hours[10] === d2.days_driven && d2.hours[5] === 0
  && L.hours.fleet[14] >= d2.days_driven, j([d2?.hours, L.hours?.fleet]));
check('…the day sheet carries a row a driver a day, the times as clocks', /Test Driver 2\|Egari\|[^|]+\|yes\|[^|]+\|50\|[^|]+\|2\|2\|09:30\|10:50\|0\.7/.test(flat(book, 'Day detail')),
  flat(book, 'Day detail').slice(0, 400));

/* ── 6. access ─────────────────────────────────────────────────────────── */
console.log('\n6. withheld, never zero');
const manifest = JSON.parse(readFileSync('api/access/manifest.json', 'utf8'));
const entry = (m, p) => manifest.find((e) => e.method === m && e.path === p);
check('every route is on the manifest, the writes behind watchlist.edit', ['/api/lowperf', '/api/export/lowperf.xlsx', '/api/lowperf/watch',
  '/api/lowperf/watch/:id', '/api/export/lowperf-watch.xlsx'].every((p) => entry('GET', p))
  && entry('POST', '/api/lowperf/watch')?.cap === 'watchlist.edit' && entry('POST', '/api/lowperf/watch/:id')?.cap === 'watchlist.edit');
const { ROLE } = await import('../api/public/access_model.js');
check('the capability is the Owner’s and the Operations manager’s, and nobody else’s',
  Object.values(ROLE).filter((x) => x.caps.includes('watchlist.edit')).map((x) => x.code).sort().join(',') === 'OPS,OWN');
const { shapeBody } = await import('../api/access/shape.js');
const FULL = { ID: 'F', EARN: 'F', BK: 'F', REV: 'F', VEH: 'F', CASH: 'F', COND: 'F', SYS: 'F' };
const sh = shapeBody(structuredClone(v), entry('GET', '/api/lowperf'), { ...FULL, CASH: '', COND: '' }).body;
check('a role without cash or conduct (the Operations manager has no cash) gets those nulled and is told',
  sh.rows.every((x) => x.cash_pct === null && x.online_h === null) && sh._withheld?.CASH != null && sh._withheld?.COND != null && sh.rows[0].gross != null, j(sh._withheld));
const shId = shapeBody(structuredClone(v), entry('GET', '/api/lowperf'), { ...FULL, ID: '' }).body;
check('without names: no name, id, person key or account', shId.rows.every((x) => x.name === null && x.driver_ext_id === null && x.pk === null && x.ids === null), j(shId.rows[0]));
const scoped = shapeBody(structuredClone(v), entry('GET', '/api/lowperf'), FULL, { fleets: ['egari'] }).body;
check('one fleet’s reader: that fleet’s rows, and how many are not listed', scoped.rows.every((x) => x.fleet === 'egari') && Number(scoped._withheld?.FLEET) > 0, j(scoped._withheld));
const wbHidden = readWorkbook(lowperfWorkbookOf(v, { hide: new Set(['ID', 'EARN']) }).wb.toBuffer());
check('the file: names and earnings written “(withheld)”, never blank or zero', !/Driver [OXYZ]/.test(flat(wbHidden, 'Below target'))
  && /\(withheld\)/.test(flat(wbHidden, 'Below target')), flat(wbHidden, 'Below target').slice(0, 300));
check('the watch workbook writes the same way', /\(withheld\)/.test(flat(readWorkbook(watchWorkbookOf(w, { hide: new Set(['EARN']) }).wb.toBuffer()), 'Members')));

/* ── 7. the page ───────────────────────────────────────────────────────── */
console.log('\n7. the page');
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location ??= { hash: '', search: '', pathname: '/' };
globalThis.window ??= globalThis;
globalThis.document ??= { documentElement: { dataset: {}, getAttribute: () => null } };
const pg = await import('../api/public/lowperf.js');
const rt = pg.parseParam('2026-10-01..2026-10-21', 'mostly.egari');
check('the address carries the period, the hotel switch and the fleet, and reads back',
  rt.from === '2026-10-01' && rt.to === '2026-10-21' && rt.hotel === 'mostly' && rt.fleet === 'egari'
  && pg.pageHref(rt) === '#low-performers/2026-10-01..2026-10-21/mostly.egari'
  && pg.pageHref({ hotel: 'hide' }) === '#low-performers' && j(pg.parseParam(null, null)) === j({ from: null, to: null, hotel: 'hide', fleet: null }),
  j([rt, pg.pageHref(rt)]));
check('…and the request it makes is the one the server reads', pg.listUrl(rt) === '/api/lowperf?from=2026-10-01&to=2026-10-21&hotel=mostly&fleet=egari', pg.listUrl(rt));
const hh = pg.headHtml(v);
check('the head: four cells — below target with its bands, short by, everyone else, the trend',
  (hh.match(/class="tg-cell[ "]/g) || []).length === 4 && /4 of 6/.test(hh) && /1 under half · 3 half to 80% · 0 at 80% or more/.test(hh)
  && /1 ▲ · 1 ▼/.test(hh), hh.slice(0, 900));
check('cells shade against that day’s own target: at it, half to it, under half, off, not asked',
  pg.cellClass({ fares: 200, trips: 3, share: 200 }) === 'lp-c-over' && pg.cellClass({ fares: 100, trips: 2, share: 200 }) === 'lp-c-mid'
  && pg.cellClass({ fares: 99, trips: 1, share: 200 }) === 'lp-c-low' && pg.cellClass({ fares: 0, trips: 0, share: 200 }) === 'lp-c-off'
  && pg.cellClass({ fares: 0, trips: 0, share: null }) === 'lp-c-blank');
const gh = pg.gridHtml(v);
check('the grid: o’s five days off print “off”, and the key says what each shade means',
  (gh.match(/class="lp-c-off[^"]*"[^>]*>(?:<a [^>]*>)?off</g) || []).length >= 5 && /active and did not drive/.test(gh) && /at or above that day’s target/.test(gh), gh.slice(0, 600));
const lh = pg.listHtml(v);
check('the list: grouped by how far below, in the server’s order', /Under half of target/.test(lh) && /Half to 80% of target/.test(lh)
  && lh.indexOf('Driver O') < lh.indexOf('Driver X') && lh.indexOf('Driver X') < lh.indexOf('Driver Y'), lh.slice(0, 400));
check('the written line says what the columns do not: the days off, and the move against everyone else',
  /5 days off while active — each still asks its share/.test(pg.readingOf(by.o))
  && /^Drove every day they were active; better than everyone else last week: up 40 points while everyone else held\.$/.test(pg.readingOf(by.x))
  && /worse than everyone else last week: down 40 points while everyone else held/.test(pg.readingOf(by.y)), j([pg.readingOf(by.o), pg.readingOf(by.x), pg.readingOf(by.y)]));
const lhId = pg.listHtml({ ...shId, _withheld: { ID: '' } });
check('a role without names reads “(withheld)” and the reason — never a blank row', /\(withheld\)/.test(lhId) && !/Driver [OXYZ]/.test(lhId)
  && /Not shown to your role/.test(lhId), lhId.slice(0, 500));
check('nobody below target is said in words, not an empty table', /reached their target/.test(pg.listHtml({ ...v, rows: [] })));
const wh = pg.watchHeadHtml(w);
check('a watch list’s head: the list and everyone else, before and after', /42\.5%|on the list/i.test(wh) && /Everyone else/.test(wh)
  && /137\.7% → 150%/.test(wh), wh.slice(0, 700));
check('its members table names the move against everyone else', /improving/.test(pg.membersHtml(w)) && /against \+12\.3/.test(pg.membersHtml(w)), pg.membersHtml(w).slice(0, 600));
check('the save day is marked in the grid', /lp-saved/.test(pg.gridHtml(w, { saved: '2026-10-15' })));
const css = readFileSync('api/public/app.css', 'utf8');
check('printing is a landscape A4 of this page’s own — a rule it adds while open, never one every page prints under',
  pg.PRINT_CSS === '@media print{@page{size:A4 landscape;margin:9mm}}' && !/@page/.test(css.slice(css.indexOf('── Low performers'))),
  pg.PRINT_CSS);
/* The grid printed wider than the page once its fares carried their fils
   (1,206 px on 1,054, the averages cut off the right edge), and a 31-day
   month overflowed even in whole dirhams. Measured on a real landscape A4 PDF
   of the mock: 19 days print at 0.872, all of September at 0.593. */
check('the printed grid fits the landscape page: 297 mm less two 9 mm margins is 1,054 px, a wider grid zoomed down to it, a narrower one left at 1',
  pg.PRINT_W === 1054 && pg.fitOf(1206) === 0.873 && pg.fitOf(2108) === 0.5 && pg.fitOf(1054) === 1 && pg.fitOf(800) === 1,
  JSON.stringify([pg.PRINT_W, pg.fitOf(1206), pg.fitOf(2108)]));
{
  const pr = css.slice(css.indexOf('@media print', css.indexOf('── Low performers')));
  const ms = css.slice(css.indexOf('.lp-measure .lp-grid{'), css.indexOf('@media print', css.indexOf('── Low performers')));
  check('only the print rule reads the fit, and the measure is taken under the print rule’s own type, padding and name column',
    /\.lp-grid\{zoom:var\(--lp-fit,1\)\}/.test(pr) && !/zoom/.test(css.slice(0, css.indexOf('@media print', css.indexOf('── Low performers'))).slice(css.indexOf('── Low performers')))
    && /font-size:var\(--t1\)/.test(ms) && /padding:1px 2px/.test(ms) && /max-width:20ch/.test(ms)
    && /\.lp-grid\{font-size:var\(--t1\)\}/.test(pr) && /\.lp-grid th,\.lp-grid td\{padding:1px 2px\}/.test(pr)
    && /\.lp-grid thead \.lp-who\{white-space:normal;text-overflow:clip\}/.test(pr) && /thead \.lp-who\{white-space:normal;text-overflow:clip\}/.test(ms),
    ms.slice(0, 300));
}

/* ── 8. more granular: the averages, the day in detail, why, when ─────── */
console.log('\n8. averages, the day in detail, why below target, weekdays and hours');
/* The operator, 2026-10-19, on the grid: "this should have average of all the
   days shown for the driver as well. and more granular data on the page".
   Each day driven, as loadDetail reads it: everyone else (a and b) on jobs
   eight hours from 07:00, ten trips; x three hours from 10:00 — short days
   and a late start; y full days at 07:00 but an accepted job abandoned every
   day out of six bookings; z (hotel) full days. */
const DET = {
  a: { first: 420, job_min: 480, bookings: 10 }, b: { first: 420, job_min: 480, bookings: 10 },
  x: { first: 600, job_min: 180, bookings: 5 }, y: { first: 420, job_min: 480, bookings: 6, abandoned: 1 },
  z: { first: 420, job_min: 480, bookings: 4 },
};
const detail = { byDay: new Map(), hours: new Map(), fleetHours: Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 23 ? 30 : 2)) };
for (const [d, o] of Object.entries(people)) {
  detail.byDay.set(d, new Map(Object.keys(o).filter((pk) => DET[pk]).map((pk) => [pk, { last: DET[pk].first + DET[pk].job_min + 60, km: 12.5,
    abandoned: 0, declined: 0, platforms: ['uber'], plate: 'C9', ...DET[pk] }])));
}
for (const pk of ['a', 'b', 'x', 'y', 'z']) detail.hours.set(pk, Array.from({ length: 24 }, (_, h) => (h >= Math.floor(DET[pk].first / 60) && h < Math.floor(DET[pk].first / 60) + 3 ? 7 : 0)));
const G = LP.lowperfOf({ ...bundle, detail, hotel: 'show' });
const gb = Object.fromEntries(G.rows.map((r) => [r.pk, r]));
check('the detail changes nobody’s place or figure: the same people, gross and target', j(G.rows.map((r) => [r.pk, r.gross, r.gross_target]))
  === j(v.rows.map((r) => [r.pk, r.gross, r.gross_target])));
check('two averages a row: x a day active 2,240 ÷ 21 = 106.67 (55.5%, as the target counts), a day driven the same — x drove every day',
  gb.x.avg_active === 106.67 && gb.x.avg_active_pct === 55.5 && gb.x.avg_driven === 106.67 && gb.x.avg_driven_pct === 55.5, j([gb.x.avg_active, gb.x.avg_active_pct, gb.x.avg_driven, gb.x.avg_driven_pct]));
check('…o, five days off: a day active 0 and 0%; a day driven not measured — no day was, so no figure, never a zero',
  gb.o.avg_active === 0 && gb.o.avg_active_pct === 0 && gb.o.avg_driven === null && gb.o.avg_driven_pct === null, j([gb.o.avg_active, gb.o.avg_driven]));
check('each day’s references: the list’s average and everyone else’s among those active, a day off as nothing — 1 Oct: (0 + 80 + 160 + 120) ÷ 4 = 90; a and b 300',
  G.days[0].list_avg === 90 && G.days[0].list_n === 4 && G.days[0].rest_avg === 300 && G.days[0].rest_n === 2
  && G.days[0].rest_job_h === 8 && G.days[0].rest_first === 420 && G.days[0].list_first === 420, j(G.days[0]));
check('the day in detail rides the grid: x on 1 Oct, 10:00 to 14:00, three hours on jobs, the car', gb.x.days[0].first === 600 && gb.x.days[0].last === 840
  && gb.x.days[0].job_min === 180 && gb.x.days[0].plate === 'C9' && gb.x.job_h_day === 3 && gb.x.start_med === 600, j(gb.x.days[0]));
check('everyone else’s middle values: eight hours a day, 07:00, ten trips, AED 37.50 an hour, nothing abandoned',
  G.medians.job_h_day === 8 && G.medians.start_med === 420 && G.medians.trips_day === 10 && G.medians.aed_per_job_h === 37.5
  && G.medians.abandon_pct === 0 && G.medians.people === 2, j(G.medians));
check('x: short days (3 h against 8), a late start (10:00 against 07:00, with short days), few trips (5 against 10) — not a low rate (AED 35.56 an hour against 37.50)',
  j(Object.keys(gb.x.causes).sort()) === j(['few_trips', 'late_start', 'short_days']) && gb.x.causes.short_days.value === 3 && gb.x.causes.short_days.rest === 8
  && gb.x.aed_per_job_h === 35.56, j([gb.x.causes, gb.x.aed_per_job_h]));
check('y: full days at 07:00, so neither short nor late — a low rate (AED 16.67 an hour), few trips, and one accepted job in six abandoned every day',
  j(Object.keys(gb.y.causes).sort()) === j(['abandons', 'few_trips', 'low_rate']) && gb.y.abandoned === 21 && gb.y.abandon_pct === 16.7, j([gb.y.causes, gb.y.abandoned]));
check('o: drove none of their active days — days off, and no rate it could be judged on', j(Object.keys(gb.o.causes)) === j(['days_off']) && gb.o.job_h_day === null, j(gb.o.causes));
check('the counts at the top add up the people, each cause once a person', G.totals.causes.few_trips === 3 && G.totals.causes.short_days === 1
  && G.totals.causes.days_off === 1 && G.totals.causes.abandons === 1 && G.totals.no_cause === 0 && G.cause_rules.length === 6, j([G.totals.causes, G.totals.no_cause]));
check('weekdays Monday first; x’s share of target by weekday, the counted days of each', j(gb.x.weekdays.map((w) => w.label)) === j(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
  && gb.x.weekdays.reduce((s, w) => s + w.days, 0) === gb.x.days_active && G.weekdays.below.length === 7 && G.weekdays.rest[0].pct > 140, j(gb.x.weekdays));
check('hours: x’s trips by the hour, the list’s and everyone else’s sums, the fleet’s bookings', gb.x.hours[10] === 7 && G.hours.below[10] === 7
  && G.hours.rest[7] === 14 && G.hours.fleet[7] === 30, j([gb.x.hours, G.hours.below, G.hours.rest]));
const cm = LP.causesOf({ off_share: 20, job_h_day: 6, aed_per_job_h: 40, trips_day: 8, start_med: 600, abandon_pct: 4, abandoned: 2 },
  { off_share: 0, job_h_day: 8, aed_per_job_h: 40, trips_day: 10, start_med: 420, abandon_pct: 1 }, { days_active: 10, days_driven: 8 });
check('a cause is named only when it is plainly so: 20% days off, 6 h against 8, a late start on full-ish days, 2 abandons — none', j(cm) === '{}', j(cm));
check('a rate needs three days driven: two days say nothing about an hour, a trip or a day’s length', LP.measuresOf({ days_active: 5, days_driven: 2, days_off: 3,
  job_days: 2, job_min: 200, gross_timed: 100, trips: 4, bookings: 4, declined: 0, abandoned: 0, firsts: [500], lasts: [700] }).job_h_day === null);
const ref = pg.gridHtml(G);
check('the grid ends each row in both averages, and carries the day’s asked, their average and everyone else’s under the head',
  /Average a day active/.test(ref) && /Average a day driven/.test(ref) && /Their average, AED/.test(ref) && /Everyone else, AED/.test(ref)
  && /Asked of each, AED/.test(ref) && />106\.67<small class="tg-under">56%<\/small>/.test(ref), ref.slice(ref.indexOf('Driver X'), ref.indexOf('Driver X') + 2600).slice(-500));
const refStart = pg.gridHtml(G, { metric: 'start' });
check('the cell switch: the first request in the cells and the rows under the head, never fares against a start time', />10:00</.test(refStart)
  && /Everyone else, start<\/th><td[^>]*>07:00</.test(refStart) && !/Asked of each/.test(refStart) && !/Everyone else, AED/.test(refStart), refStart.slice(0, 400));
check('a figure opens that driver’s day', /href="#driver\/u-x\/day\?[^"]*on=2026-10-01"/.test(ref));
const why = pg.causesHtml(G);
check('“why below target”: each cause, how many drivers carry it, the rule and everyone else’s middle value', /Short days<\/th><td>1</.test(why)
  && /Few trips<\/th><td>3</.test(why) && /07:00/.test(why) && /8 h on jobs a day driven/.test(why), why.slice(0, 800));
const dx = pg.detailHtml(gb.x, G);
check('a driver opened: the causes in words, their figures, a line a day, the weekdays and the hours against the fleet',
  /first request typically 10:00; everyone else 07:00/.test(dx) && /3 h on jobs a day driven; everyone else 8 h/.test(dx)
  && /10:00 – 14:00/.test(dx) && /Their completed trips/.test(dx) && /Fleet bookings/.test(dx) && /AED 106\.67 \(55\.5%\)/.test(dx), dx.slice(0, 900));
check('the list carries each person’s causes beside their name and a way to open their days', /lp-chip[^>]*>Short days</.test(pg.listHtml(G))
  && /data-open="x"/.test(pg.listHtml(G)));
check('the patterns: the list and everyone else by weekday, and the three hour rows', /Below target/.test(pg.patternsHtml(G)) && /Fleet bookings/.test(pg.patternsHtml(G)));
const wbG = readWorkbook(lowperfWorkbookOf(G).wb.toBuffer());
check('the workbook: both averages on each grid row, the causes and their middle values, a day a row', /Driver X\|Ecosine\|80\|[^]*\|160\|106\.67\|106\.67\|/.test(flat(wbG, 'Day by day (AED)'))
  && /Everyone else’s middle value\|null\|null\|0\|8\|37\.5\|07:00\|10\|0\|/.test(flat(wbG, 'Why below target'))
  && /Driver X\|Ecosine\|55\.5\|0\|3\|35\.56\|10:00\|5\|0\|short days, late starts, few trips/.test(flat(wbG, 'Why below target'))
  && /Driver X\|Ecosine\|[^|]+\|yes\|166\.67\|80\|48\|5\|5\|10:00\|14:00\|3\|null\|12\.5\|26\.67\|16\|0\|0\|uber\|C9/.test(flat(wbG, 'Day detail')),
  ['Day by day (AED)', 'Why below target', 'Day detail'].map((n) => { const t = flat(wbG, n); const i = t.search(/Driver X|Everyone else’s middle/); return t.slice(i, i + 160); }).join(' // '));
const shG = shapeBody(structuredClone(G), entry('GET', '/api/lowperf'), { ...FULL, COND: '', BK: '' }).body;
check('a role without bookings or conduct: the day’s times, hours, abandons and the causes they make withheld; the money stays',
  shG.rows.every((x) => x.days.every((c) => c.first === null && c.job_min === null && c.abandoned === null) && x.job_h_day === null && x.abandoned === null
    && x.causes.short_days == null && x.causes.abandons == null && x.avg_active != null) && shG.medians.job_h_day === null && shG.hours.fleet === null
  && shG.days.every((d) => d.list_first === null && d.list_avg != null), j(shG.rows[1]).slice(0, 600));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
