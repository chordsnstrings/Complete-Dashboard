/* The Month target page — every day against its target, where the month
   lands, and each driver against their share (api/target_month.js,
   api/public/targetmonth.js).
   ──────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-08: "each driver has a target based on the month's
   target, and we should know who is achieving that and who's not … 30 of
   them, downloadable as an excel … what our current trajectory would mean
   for the end of the month and how short or more we would be".

   What is pinned:
     1. a driver's money target is each SETTLED day's PLAN shared equally
        among that day's active drivers — so the targets add up to the
        fleet's plan for those days — and the trips target is the minimum for
        every such day; an active driver who drove nothing still has one; a
        day still waiting for fares is left out and named; fares on a booking
        that names nobody are counted, not dropped;
     2. the trajectory: the average-day pace IS the Target page's "at this
        pace", and the last 7 settled days' pace is carried over the days
        left;
     3. the 30 behind, by money and by trips, in the same order on the page
        and in the file;
     4. against a real schema: the page's days are the Target page's days, a
        person on two platforms is one row, and the workbook reads back;
     5. a role without names or earnings reads why, never a zero;
     6. the page's words: green and red only on a finished, settled day, with
        ▲ or ▼ and a word; nothing undefined.

   REVERSIONS (run 2026-10-08, each against this file unchanged; 56 pass
   with the code as it is):
     · share each day's NEEDED instead of its plan (api/target_month.js
       driverTargets) -> 49 passed, 7 FAILED, among them "the drivers'
       targets add up to the fleet's plan for the counted days" (6,896.10
       against 7,000 — the shortfall charged to drivers as well);
     · count every past day, settled or not -> 45 passed, 11 FAILED, among
       them "seven days counted" and "a driver whose only day is not
       settled yet is not measured at all";
     · give a target only to a driver who drove that day -> 45 passed,
       11 FAILED, among them "an active driver who drove nothing still has
       a target" — c vanished from the list, and a, who drove every day,
       turned "behind";
     · sort the client's money list by trips first (api/public/
       targetmonth.js behindList) -> 55 passed, 1 FAILED ("the page's 30
       are the file's 30");
     · put every day not settled down to Uber's fares, whatever its own
       reason (targetmonth.js monthNotes — what the first draft did, seen
       on the mock's 31 August, which a channel had not delivered) -> 57
       passed, 2 FAILED, among them "a day a channel has not delivered says
       so — not that Uber's fares are late". */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { readWorkbook, sheetNamed } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;
const near = (a, b, e = 0.011) => a != null && b != null && Math.abs(a - b) <= e;

const { computeMonth, addDays } = await import('../api/revenue_target.js');
const { driverTargets, trajectory, behind, monthViewOf, monthWorkbookOf, SHOW_BEHIND } = await import('../api/target_month.js');

/* ── the fixture ───────────────────────────────────────────────────────────
   October 2026 (31 days), read on the 9th. Ten cars earn every day, so every
   day is planned at 10 × AED 100 = 1,000 and the month at 31,000. Four
   drivers matter:
     a  12 trips every day, AED 35 a trip
     b  10 trips every day, AED 40 a trip
     c  drove on 28 September only — active 1–5 October, drove none of them
     e  14 trips on 3 October only, AED 50 a trip
   and d drove only on the 8th, which is NOT settled (90% priced) and is
   under its target on the fares in so far — so it is "not settled", not "under". */
const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const FARES = { '2026-10-01': 950, '2026-10-02': 1100, '2026-10-03': 1700, '2026-10-04': 900, '2026-10-05': 1000,
  '2026-10-06': 1050, '2026-10-07': 1000, '2026-10-08': 500 };
const PER_TRIP = { a: 35, b: 40, c: 30, d: 30, e: 50 };
const people = {};
for (const d of span('2026-09-20', '2026-10-08')) people[d] = { a: 12, b: 10 };
people['2026-09-28'].c = 5;
people['2026-10-03'].e = 14;
people['2026-10-08'].d = 9;
const facts = {
  days: new Map(Object.entries(FARES).map(([d, v]) => [d, { day: d, fares: v, priced: d === '2026-10-08' ? 90 : 100,
    chargeable: 100, completed: 100, bookings: 100 }])),
  carDays: new Map(span('2026-09-20', '2026-10-31').map((d) => [d, new Set(Array.from({ length: 10 }, (_, i) => `C${i + 1}`))])),
  personDays: new Map(Object.entries(people).map(([d, o]) => [d, new Map(Object.entries(o))])),
  runs: [],
};
const dd = {
  byDay: new Map(Object.entries(people).map(([d, o]) => [d, new Map(Object.entries(o).map(([pk, n]) => [pk, { trips: n, gross: n * PER_TRIP[pk] }]))])),
  who: new Map(['a', 'b', 'c', 'd', 'e'].map((pk, i) => [pk, { pk, name: `Driver ${pk.toUpperCase()}`, driver_ext_id: `u-${pk}`,
    fleet: i % 2 ? 'egari' : 'ecosine', platforms: ['uber'] }])),
};
const save = { id: 1, gross_target: 31000, cars: 10, rate: 100, past_plan: 0, set_day: '2026-10-01',
  set_at: '2026-10-01T06:00:00Z', set_by: null, set_by_label: 'owner@example.test' };
const t = computeMonth({ month: '2026-10', today: '2026-10-09', rows: [save], facts, min: 12 });
const dr = driverTargets({ t, facts, dd, min: 12 });
const by = Object.fromEntries(dr.rows.map((r) => [r.pk, r]));

/* ── 1. a driver's target ──────────────────────────────────────────────── */
console.log('\n1. a driver’s target: the plan of each settled day, shared among its active drivers');
check('seven days counted, 1 to 7 October', dr.counted_days === 7 && dr.from === '2026-10-01' && dr.through === '2026-10-07', j([dr.counted_days, dr.from, dr.through]));
check('a day still waiting for fares is left out, and named with why',
  dr.left_out.length === 1 && dr.left_out[0].day === '2026-10-08' && /90\.0% of Thu 8 Oct’s bookings carry a fare/.test(dr.left_out[0].why || ''), j(dr.left_out));
check('each day’s share is its plan over its active drivers: 1,000 ÷ 3 on the 1st, ÷ 4 on the 3rd (e and c both active)',
  dr.shares[0].active === 3 && near(dr.shares[0].share, 333.33) && dr.shares[2].active === 4 && dr.shares[2].share === 250, j(dr.shares.slice(0, 3)));
check('the drivers’ targets add up to the fleet’s plan for the counted days — 7 × 1,000',
  near(dr.totals.targets, 7000) && near(dr.totals.plan, 7000), j(dr.totals));
check('a: active all seven days — 4 × 333.33 + 3 × 250 = 2,083.33 — earned 2,940: on target',
  near(by.a.gross_target, 2083.33) && by.a.gross === 2940 && by.a.money_on === true && by.a.gross_short === 0 && by.a.gross_pct === 141.1, j(by.a));
check('an active driver who drove nothing still has a target, and is behind on both: c, 1,416.67 and 60 trips',
  by.c && by.c.days_active === 5 && by.c.days_driven === 0 && near(by.c.gross_target, 1416.67) && by.c.gross === 0
  && by.c.money_on === false && by.c.trips_target === 60 && by.c.trips === 0 && by.c.trips_on === false, j(by.c));
check('e drove one day of the five it was active: 700 of 1,416.67, 14 trips of 60',
  by.e.days_active === 5 && by.e.days_driven === 1 && by.e.gross === 700 && near(by.e.gross_short, 716.67) && by.e.trips_short === 46, j(by.e));
check('the trips target is the minimum for every counted day active: a did exactly 84 of 84 — on; b 70 — 14 short',
  by.a.trips === 84 && by.a.trips_target === 84 && by.a.trips_on === true && by.b.trips_short === 14 && by.b.trips_on === false, j([by.a, by.b]));
check('a driver whose only day is not settled yet is not measured at all', !by.d, j(Object.keys(by)));
check('fares on bookings that name nobody are counted — 7,700 on the counted days, 6,440 in the drivers’ rows, 1,260 in nobody’s',
  dr.totals.fleet_gross === 7700 && dr.totals.drivers_gross === 6440 && dr.totals.unattributed === 1260, j(dr.totals));
check('two on target for money and two behind; one on target for trips and three behind',
  dr.totals.money_on === 2 && dr.totals.money_behind === 2 && dr.totals.trips_on === 1 && dr.totals.trips_behind === 3, j(dr.totals));
check('furthest behind on money first', dr.rows.map((r) => r.pk).join('') === 'ceba', dr.rows.map((r) => r.pk).join(''));

const noTarget = driverTargets({ t: computeMonth({ month: '2026-10', today: '2026-10-09', rows: [], facts, min: 12 }), facts, dd, min: 12 });
check('no target set: no money targets — the reason instead — and the trips still measured',
  noTarget.rows.every((r) => r.gross_target === null && r.money_on === null) && noTarget.totals.money_on === null
  && /No target is set for October 2026/.test(noTarget.money_why || '') && noTarget.totals.trips_behind === 3, j(noTarget.totals));
const first = driverTargets({ t: computeMonth({ month: '2026-10', today: '2026-10-01', rows: [save], facts, min: 12 }), facts, dd, min: 12 });
check('on the 1st nothing has finished: said, not a list of zeros', first.rows.length === 0
  && /Nothing of October 2026 has finished yet/.test(first.why || ''), j(first));

/* ── 2. where the month lands ──────────────────────────────────────────── */
console.log('\n2. the trajectory');
const tj = trajectory(t);
check('the average-day pace is the Target page’s “at this pace”, exactly: 8,200 over 8 days × 31 = 31,775',
  tj.avg.month_end === t.summary.month_end_pace && tj.avg.month_end === 31775 && tj.avg.vs_target === 775, j(tj.avg));
check('the last 7 settled days (1–7, the 8th still waiting): 1,100 a day, carried over the 23 days left — 33,500, 2,500 over',
  tj.recent.days === 7 && tj.recent.from === '2026-10-01' && tj.recent.to === '2026-10-07' && tj.recent.per_day === 1100
  && tj.recent.month_end === 33500 && tj.recent.vs_target === 2500, j(tj.recent));
check('every day left must bring (31,000 − 8,200) ÷ 23 = 991.30', tj.per_day_left === 991.3 && tj.days_left === 23, j(tj));
check('the day still waiting is named for the caveat', tj.unsettled.length === 1 && tj.unsettled[0].day === '2026-10-08', j(tj.unsettled));
const endS = tj.series[tj.series.length - 1];
check('the chart’s lines end where the words say: the target path at 31,000, each pace at its month end',
  endS.plan_to_date === 31000 && endS.at_avg === tj.avg.month_end && endS.at_recent === tj.recent.month_end, j(endS));
check('…and both paces start from what was earned, on the last day gone',
  tj.series[7].earned_to_date === 8200 && tj.series[7].at_avg === 8200 && tj.series[7].at_recent === 8200 && tj.series[8].earned_to_date === null, j(tj.series.slice(7, 9)));
check('no target: no trajectory', trajectory(computeMonth({ month: '2026-10', today: '2026-10-09', rows: [], facts, min: 12 })) === null);

/* ── 3. the 30 behind ──────────────────────────────────────────────────── */
console.log('\n3. the 30 behind');
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location ??= { hash: '', search: '', pathname: '/' };
globalThis.window ??= globalThis;
globalThis.document ??= { documentElement: { dataset: {}, getAttribute: () => null } };
const page = await import('../api/public/targetmonth.js');
const many = Array.from({ length: 45 }, (_, i) => ({ pk: `p${i}`, name: `Driver ${String(i).padStart(2, '0')}`,
  gross_short: (i * 37) % 11 === 0 ? 0 : ((i * 37) % 11) * 100, money_on: (i * 37) % 11 === 0,
  trips_short: (i * 13) % 7, trips_on: (i * 13) % 7 === 0 }));
check('thirty, not forty-five', behind(many, 'money').length === SHOW_BEHIND && SHOW_BEHIND === 30 && page.SHOW_BEHIND === 30);
check('only drivers behind, the most short first', behind(many, 'money').every((r, i, a) => r.money_on === false && (!i || a[i - 1].gross_short >= r.gross_short)));
check('the page’s 30 are the file’s 30, in the same order, on both lists',
  ['money', 'trips'].every((k) => j(page.behindList(many, k).map((r) => r.pk)) === j(behind(many, k).map((r) => r.pk))),
  j([page.behindList(many, 'money').slice(0, 5).map((r) => r.pk), behind(many, 'money').slice(0, 5).map((r) => r.pk)]));

/* ── 4. against a real schema ──────────────────────────────────────────── */
console.log('\n4. GET /api/target/month and the workbook, against a real schema');
const db = new PGlite();
await applySchema(db);
const q = (s, p = []) => db.query(s, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let n = 0;
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, 'card', $9, 'AED', '{}'::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.fleet || 'ecosine', o.id ?? null, o.driver ?? null, o.plate, o.at, o.status || 'completed',
    o.price === undefined ? 30 : o.price]);
for (const d of span('2026-09-22', '2026-10-06')) {
  for (let k = 0; k < 3; k++) await T({ id: 'u-1', driver: 'Test Driver 1', plate: 'C1', at: `${d}T0${k + 5}:00:00Z` });
  await T({ platform: 'bolt', id: 'b-1', driver: 'Test Driver 1', plate: 'C1', at: `${d}T09:00:00Z`, price: 20 });
  for (let k = 0; k < 2; k++) await T({ id: 'u-2', driver: 'Test Driver 2', plate: 'C2', fleet: 'egari', at: `${d}T0${k + 5}:30:00Z`, price: 25 });
  await T({ plate: 'C4', at: `${d}T10:00:00Z`, price: 15 });   // a booking that names nobody
}
await T({ id: 'u-3', driver: 'Test Driver 3', plate: 'C3', at: '2026-09-25T08:00:00Z' });
const { saveTarget } = await import('../api/revenue_target.js');
const saved = await saveTarget(q, { month: '2026-10', gross: 6200, now: new Date('2026-10-01T10:00:00+04:00'), by: 7, byLabel: 'owner@example.test' });
check('a target saved for October', !saved.error && saved.row?.gross === 6200, j(saved));
const { mountAll } = await import('./mount.mjs');
const api = await mountAll(db);
const got = await api.get('/api/target/month?month=2026-10&asof=2026-10-06');
const tgt = await api.get('/api/target?month=2026-10&asof=2026-10-06');
const v = got.body;
check('GET /api/target/month answers the month, day by day', got.status === 200 && v.days?.length === 31 && v.month === '2026-10', `${got.status} ${j(v).slice(0, 200)}`);
const pick = (d) => [d.day, d.state, d.plan, d.needed, d.earned, d.verdict, d.settled, d.trips, d.trips_target, d.trips_verdict];
check('…its days are the Target page’s days, to the fils — the two pages cannot disagree about a day',
  j(v.days.map(pick)) === j(tgt.body.days.map(pick)) && j(v.summary) === j(tgt.body.summary), j([v.days[0], tgt.body.days[0]].map(pick)));
check('…not held by the response cache: /api/target is on its never list, and this is under it',
  /'\/api\/target',/.test(readFileSync('api/cache.js', 'utf8')) && got.headers?.['cache-control'] !== 'public', String(got.headers?.['cache-control']));
const rows = Object.fromEntries((v.drivers?.rows || []).map((r) => [r.name, r]));
check('one person on two platforms is one row: Test Driver 1 on Uber and Bolt',
  rows['Test Driver 1'] && j(rows['Test Driver 1'].platforms) === '["bolt","uber"]' && rows['Test Driver 1'].days_driven === v.drivers.counted_days,
  j(rows['Test Driver 1']));
check('…its gross is every platform’s fares on the counted days: (3 × 30 + 20) a day',
  rows['Test Driver 1'].gross === 110 * v.drivers.counted_days, j([rows['Test Driver 1'].gross, v.drivers.counted_days]));
check('a driver active on the 1st and 2nd from a trip on 25 September has a target for those two days, and earned nothing on them',
  rows['Test Driver 3']?.days_active === 2 && rows['Test Driver 3'].gross === 0 && rows['Test Driver 3'].money_on === false
  && rows['Test Driver 3'].trips_target === 2 * v.trips_min, j(rows['Test Driver 3']));
check('the targets add up to the plan for the counted days, and the nameless booking is in nobody’s row',
  near(v.drivers.totals.targets, v.drivers.totals.plan) && near(v.drivers.totals.plan,
    v.days.filter((d) => d.state === 'past' && d.settled).reduce((s, d) => s + d.plan, 0), 0.05)
  && near(v.drivers.totals.unattributed, 15 * v.drivers.counted_days), j(v.drivers.totals));
check('the trajectory’s average pace is the Target page’s', v.trajectory?.avg?.month_end === tgt.body.summary.month_end_pace, j([v.trajectory?.avg, tgt.body.summary.month_end_pace]));

const xr = await fetch(`http://127.0.0.1:${api.port}/api/export/target-month.xlsx?month=2026-10`);
const buf = Buffer.from(await xr.arrayBuffer());
check('GET /api/export/target-month.xlsx answers a workbook named for the month', xr.status === 200
  && /spreadsheetml/.test(xr.headers.get('content-type') || '') && /attachment; filename="month-target-2026-10-as-of-/.test(xr.headers.get('content-disposition') || ''),
  `${xr.status} ${xr.headers.get('content-disposition')}`);
const book = readWorkbook(buf);
check('the five sheets, in the page’s order', book.sheetNames.join('|') === 'Month|Days|Behind on money (30)|Behind on trips (30)|All drivers', book.sheetNames.join('|'));
const flat = (bk, name) => (sheetNamed(bk, name)?.rows || []).flat().map(String).join('|');
check('All drivers names every driver; the money list leads with the one furthest behind',
  ['Test Driver 1', 'Test Driver 2', 'Test Driver 3'].every((x) => flat(book, 'All drivers').includes(x)), flat(book, 'All drivers').slice(0, 300));

/* ── 5. a role without names or earnings ───────────────────────────────── */
console.log('\n5. withheld, never zero');
const fixtureView = monthViewOf({ month: '2026-10', today: '2026-10-09', rows: [save], facts, dd, min: 12 });
const hidden = readWorkbook(monthWorkbookOf(fixtureView, { hide: new Set(['ID', 'EARN']) }).wb.toBuffer());
check('the file: names and earnings written “(withheld)”, never left blank or zero',
  !/Driver [ABCE]/.test(flat(hidden, 'All drivers')) && /\(withheld\)/.test(flat(hidden, 'All drivers')) && !/\|2940\|/.test(flat(hidden, 'All drivers')),
  flat(hidden, 'All drivers').slice(0, 300));
const manifest = JSON.parse(readFileSync('api/access/manifest.json', 'utf8'));
const entry = manifest.find((e) => e.method === 'GET' && e.path === '/api/target/month');
check('both routes are on the access manifest', entry && manifest.some((e) => e.method === 'GET' && e.path === '/api/export/target-month.xlsx'));
const { shapeBody } = await import('../api/access/shape.js');
const shaped = shapeBody(structuredClone(fixtureView), entry, { REV: 'F', BK: 'F', VEH: 'F', SYS: 'F', ID: '', EARN: '' }).body;
check('the shaper takes the names and each driver’s money, and says so', shaped.drivers.rows.every((r) => r.name === null && r.gross === null && r.pk === null)
  && shaped._withheld?.ID != null && shaped._withheld?.EARN != null && shaped.summary.month_target === 31000, j(shaped._withheld));
const scoped = shapeBody(structuredClone(fixtureView), entry, { REV: 'F', BK: 'F', VEH: 'F', SYS: 'F', ID: 'F', EARN: 'F' }, { fleets: ['egari'] }).body;
check('a reader shown one fleet gets that fleet’s drivers only, and is told how many are not listed',
  scoped.drivers.rows.length && scoped.drivers.rows.every((r) => r.fleet === 'egari') && Number(scoped._withheld?.FLEET) > 0, j(scoped._withheld));
const wd = page.driversHtml(shaped, 'money');
check('the page: no money to be behind on, so the trips list — and the reasons in words',
  /Not shown to your role/.test(wd) && /\(withheld\)/.test(wd) && /data-by="trips" aria-pressed="true"/.test(wd), wd.slice(0, 600));
check('…and the fleet scoping said in words', /of a fleet your role does not see/.test(page.driversHtml(scoped, 'money')));

/* ── 6. the page's words ───────────────────────────────────────────────── */
console.log('\n6. the page');
const mh = page.monthHtml(fixtureView);
check('the month: five cells — the target, earned, the two paces, what every day left must bring',
  (mh.match(/class="tg-cell[ "]/g) || []).length === 5 && /AED 31,000\.00/.test(mh) && /AED 991\.30/.test(mh), mh.slice(0, 400));
check('each pace leads with how far over or short, with ▲ or ▼ and the word',
  /data-mt="avg"><span class="tg-l">At the average day so far<\/span><b class="tg-v">▲ AED 775\.00 over<\/b>/.test(mh)
  && /data-mt="recent"><span class="tg-l">At the last 7 settled days<\/span><b class="tg-v">▲ AED 2,500\.00 over<\/b>/.test(mh), mh.slice(0, 900));
check('the day still waiting is named, with its own reason', /Not settled yet, Thu 8 Oct: Only 90\.0% of Thu 8 Oct’s bookings carry a fare yet/.test(mh), mh.slice(-500));
/* The reason is the day's own. Measured on the mock 2026-10-08: a day a
   channel had not delivered, every booking priced, was put down to Uber's
   fares — a reason that was not the true one. */
const chFacts = { ...facts, days: new Map([...facts.days].map(([d, x]) => [d, d === '2026-10-08' ? { ...x, priced: 100 } : x])),
  runs: [{ source: 'bolt', fleet: 'ecosine', ws: '2026-09-15', we: '2026-10-07', fin: Date.parse('2026-10-08T01:00:00+04:00') }] };
const chView = monthViewOf({ month: '2026-10', today: '2026-10-09', rows: [save], facts: chFacts, dd, min: 12 });
const chNote = page.monthHtml(chView);
check('a day a channel has not delivered says so — not that Uber’s fares are late',
  /Not settled yet, Thu 8 Oct: [^<]*has not delivered Thu 8 Oct yet/.test(chNote) && !/fares hours after/.test(chNote)
  && /Not settled yet · a channel still to deliver it/.test(page.daysTable(chView)), chNote.slice(-400));
const sep = monthViewOf({ month: '2026-09', today: '2026-10-09', facts, dd, min: 12,
  rows: [{ ...save, gross_target: 30000, set_day: '2026-09-01', set_at: '2026-09-01T06:00:00Z' }] });
const sh = page.monthHtml(sep);
check('a month that is over: what it came to, its days on target, its best and worst day — no pace, and the cars of its own save',
  /data-mt="ended"><span class="tg-l">The month ended<\/span><b class="tg-v">▼ Target missed/.test(sh) && /data-mt="days"/.test(sh)
  && /data-mt="best"/.test(sh) && !/data-mt="avg"|data-mt="recent"|data-mt="left"/.test(sh) && /set over 10 cars/.test(sh), sh.slice(0, 700));
check('…and where it landed in one sentence, no pace carried',
  /the month ended at AED/.test(page.pathHtml(sep)) && !/at the average day/.test(page.pathHtml(sep)), page.pathHtml(sep).slice(0, 300));
const chart = page.dayChart(fixtureView, { W: 1300 });
const grp = (d) => (chart.match(new RegExp(`<g class="mc-d mc-(\\w+)"><title>${d}:`)) || [])[1];
check('the chart colours a finished day by its verdict, a day waiting grey, today ink, the days to come unfilled',
  grp('Thu 1 Oct') === 'under' && grp('Fri 2 Oct') === 'over' && grp('Thu 8 Oct') === 'wait' && chart.includes('<g class="mc-d mc-now"><title>Fri 9 Oct, today')
  && grp('Sat 10 Oct') === 'future', j(['Thu 1 Oct', 'Fri 2 Oct', 'Thu 8 Oct', 'Sat 10 Oct'].map(grp)));
check('the gap is printed over each judged day — missed −50 in red, over +98 in green — and not over a day still waiting',
  /<text class="mc-lab tg-under"[^>]*>−50<\/text>/.test(chart) && /<text class="mc-lab tg-over"[^>]*>\+98<\/text>/.test(chart)
  && (chart.match(/class="mc-lab /g) || []).length === 7, (chart.match(/<text class="mc-lab[^<]*<\/text>/g) || []).join(' '));
const dh = page.daysHtml(fixtureView, { W: 1300 });
check('the table: a finished day links to its day page, with what it missed or made in words',
  /<a href="#day\/2026-10-01">Thu 1 Oct<\/a>/.test(dh) && /<span class="tg-under">▼ Missed by AED 50\.00<\/span>/.test(dh)
  && /<span class="tg-over">▲ Over by AED 98\.33<\/span>/.test(dh) && /Not settled yet · 90% priced/.test(dh), dh.slice(0, 300));
const ph = page.pathHtml(fixtureView, { W: 1300 });
check('where the month lands, in words and on the chart', /▲ AED 775\.00 over<\/b> at the average day/.test(ph)
  && /the month ends at AED 33,500\.00/.test(ph) && /<polyline class="mp-recent"/.test(ph) && /<polyline class="mp-earned"/.test(ph), ph.slice(0, 500));
const dm = page.driversHtml(fixtureView, 'money');
const dt = page.driversHtml(fixtureView, 'trips');
check('behind on money: c then e, each a link to the driver, with what they are short',
  /<a href="#driver\/u-c[^"]*">Driver C<\/a>[\s\S]*<a href="#driver\/u-e[^"]*">Driver E<\/a>/.test(dm) && /▼ AED 1,416\.67/.test(dm) && !/Driver A<\/a>/.test(dm), dm.slice(0, 900));
check('behind on trips: c, e, b — and the counts above both lists',
  /Driver C[\s\S]*Driver E[\s\S]*Driver B/.test(dt) && /data-mt="money"><span class="tg-l">On target for money<\/span><b class="tg-v">2 of 4<\/b>/.test(dt)
  && /On target for trips · 12 a day<\/span><b class="tg-v">1 of 4<\/b>/.test(dt), dt.slice(0, 900));
check('the Excel button and the rule are on the page', /data-xlsx="1">Excel ⤓ every driver<\/button>/.test(dm) && /How a driver’s target is set/.test(dm));
const bare = monthViewOf({ month: '2026-10', today: '2026-10-09', rows: [], facts, dd, min: 12 });
check('no target: each panel says why, and the days still list their trips',
  /^<p class="tg-absent">No target is set for October 2026/.test(page.monthHtml(bare)) && /No target is set/.test(page.daysHtml(bare))
  && /<table class="mt-t mt-days">/.test(page.daysHtml(bare)) && /No target is set/.test(page.pathHtml(bare))
  && /data-by="trips" aria-pressed="true"/.test(page.driversHtml(bare, 'money')));
check('nothing undefined, NaN or null anywhere on the page',
  ![mh, chart, dh, ph, dm, dt, page.monthHtml(bare), page.daysHtml(bare), page.driversHtml(bare)].some((x) => /undefined|NaN|\bnull\b|\[object Object\]/.test(x)));
check('the address of another month’s file', page.workbookUrl('2026-09') === '/api/export/target-month.xlsx?month=2026-09'
  && page.workbookUrl(null) === '/api/export/target-month.xlsx' && page.workbookUrl('2026-13') === '/api/export/target-month.xlsx');
check('the months either side', page.shiftMonth('2026-01', -1) === '2025-12' && page.shiftMonth('2026-12', 1) === '2027-01');

console.log(`\n${pass} passed, ${fail} failed`);
await api.close?.();
process.exit(fail ? 1 : 0);
