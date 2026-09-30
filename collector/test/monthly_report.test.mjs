/* THE MONTHLY REPORT EMAIL — a month against the one before and a year ago.
   ═══════════════════════════════════════════════════════════════════════════
   src/monthly_report.js against a real schema (PGlite), a fake model and a
   fake Resend. Synthetic drivers and plates only (Test Driver …, E1, G1,
   @example.test).

   The fixture: August 2026 (the month), July 2026 (the one before) and
   August 2025 (a year ago), two companies, Uber and Bolt. 2026 carries Uber
   statements and payouts; 2025 carries only fares — as production does, the
   earnings surface reaching back about 192 days. Every expected figure below
   is worked out by hand from the rows inserted.

   What is pinned:
     1. each month's figures per company and for both: fares, earned after
        commission (the Overview's money in), paid into the bank, cash taken,
        completed trips, active vehicles and drivers, and the three averages;
     2. every comparison, and every one that cannot be made says why — earned
        across two money bases, a payout that was never collected, fares on a
        month that is under-priced;
     3. vehicle by vehicle and driver by driver, one person across platforms;
     4. GLM 5.2 may not state a number it was not given; its summary is
        dropped for the figures' own when it does;
     5. the send waits for a complete month, goes by the 3rd whatever the
        state, composes once, and sends each address once.

   REVERSIONS, run 2026-09-30, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

process.env.RESEND_API_KEY = 'resend-key-under-test';
process.env.REPORT_MODEL_API_KEY = 'model-key-under-test';
process.env.MONTHLY_REPORT_RECIPIENTS = 'Owner@Example.test, partner@example.test';
delete process.env.PUBLIC_URL;

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const R = await import('../src/monthly_report.js');
const { companyMonth, monthFacts, compare, renderMonthlyEmail, analyseMonth, monthlyReportRun, ruleSummary,
  modelInput, allowedNumbers, guardText, lastCall, lastCompleteMonth, MAX_ROWS } = R;

let n = 0;
/* 06:00Z is 10:00 Dubai, inside the same Dubai day. */
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, $9, $10, 'AED', $11::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.fleet || 'ecosine', o.id, o.name, o.plate, o.at, o.status || 'completed',
    o.pay || 'card', o.price ?? null, j(o.cash != null ? { uber_payments: { cash_collected: -o.cash } } : {})]);
const A = { id: 'u-a', name: 'Test Driver A', plate: 'E1' };
const B = { id: 'b-b', name: 'Test Driver B', plate: 'E2', platform: 'bolt' };
const C = { id: 'u-c', name: 'Test Driver C', plate: 'G1', fleet: 'egari' };
const D = { id: 'u-d', name: 'Test Driver D', plate: 'E3' };
/* August 2026 — fares 400 + 100 + 240 = 740, 9 completed, 3 drivers, 3 vehicles. */
await T({ ...A, at: '2026-08-10T06:00:00Z', price: 100, pay: 'cash', cash: 110 });
await T({ ...A, at: '2026-08-10T07:00:00Z', price: 100 });
await T({ ...A, at: '2026-08-11T06:00:00Z', price: 100 });
await T({ ...A, at: '2026-08-11T07:00:00Z', price: 100 });
await T({ ...A, at: '2026-08-11T08:00:00Z', status: 'rider_cancelled' });            // not a trip, no fare
await T({ ...B, at: '2026-08-10T06:00:00Z', price: 50, pay: 'cash' });
await T({ ...B, at: '2026-08-10T07:00:00Z', price: 50 });
for (const at of ['2026-08-10T06:00:00Z', '2026-08-10T07:00:00Z', '2026-08-11T06:00:00Z']) await T({ ...C, at, price: 80 });
/* July 2026 — fares 200 + 100 + 160 + 100 = 560, 7 completed, 4 drivers, 4 vehicles. */
await T({ ...A, at: '2026-07-10T06:00:00Z', price: 100 });
await T({ ...A, at: '2026-07-10T07:00:00Z', price: 100 });
await T({ ...B, at: '2026-07-10T06:00:00Z', price: 50 });
await T({ ...B, at: '2026-07-10T07:00:00Z', price: 50 });
await T({ ...C, at: '2026-07-10T06:00:00Z', price: 80 });
await T({ ...C, at: '2026-07-10T07:00:00Z', price: 80 });
await T({ ...D, at: '2026-07-10T08:00:00Z', price: 100 });
/* August 2025 — fares 500 + 160 = 660, 7 completed, 2 drivers, 2 vehicles; no statement, no payout. */
for (let i = 0; i < 5; i++) await T({ ...A, at: `2025-08-12T0${i}:30:00Z`, price: 100 });
await T({ ...C, at: '2025-08-12T06:00:00Z', price: 80 });
await T({ ...C, at: '2025-08-12T07:00:00Z', price: 80 });
/* Uber statements (net of commission) and payouts, 2026 only. */
const S = (fleet, name, id, day, net) => q(
  `INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day, net, source) VALUES ('uber', $1, $2, $3, $4, $5, 'uber_rest')`,
  [fleet, name, id, day, net]);
const P = (fleet, name, id, day, earnings) => q(
  `INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, driver_name, day, period_start, period_end, period_days, earnings)
   VALUES ('uber', $1, $2, $3, $4, $4, $4, 1, $5)`, [fleet, id, name, day, earnings]);
for (const day of ['2026-08-10', '2026-08-11']) {
  await S('ecosine', 'Test Driver A', 'u-a', day, 150); await P('ecosine', 'Test Driver A', 'u-a', day, 120);
  await S('egari', 'Test Driver C', 'u-c', day, 90); await P('egari', 'Test Driver C', 'u-c', day, 70);
}
await S('ecosine', 'Test Driver A', 'u-a', '2026-07-10', 150); await P('ecosine', 'Test Driver A', 'u-a', '2026-07-10', 120);
await S('egari', 'Test Driver C', 'u-c', '2026-07-10', 120); await P('egari', 'Test Driver C', 'u-c', '2026-07-10', 100);
/* Every channel delivered August's last day. */
const run = (source, fleet, finished, end) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, status, rows_written, finished_at)
   VALUES ($1, $2, 'incremental', $4::date - 2, $4::date, 'ok', 5, $3::timestamptz)`, [source, fleet, finished, end]);
await run('uber', 'ecosine', '2026-09-01T00:00:00Z', '2026-08-31');
await run('uber', 'egari', '2026-09-01T00:00:00Z', '2026-08-31');
await run('bolt', 'ecosine', '2026-09-01T00:00:00Z', '2026-08-31');

const NOW = new Date('2026-09-30T08:00:00Z');

/* ── 1. one month, per company and for both ──────────────────────────────
   REVERSION: count every booking as a trip (drop `outcome = 'completed'`
   from the activity query) -> 39 passed, 4 FAILED ("completed trips 9…",
   "averages…", and the two model checks, whose 9 is no longer a figure).
   REVERSION: earned from fares alone (fleetIncome's accounted_fares) -> 39
   passed, 4 FAILED ("earned is the Overview's money in", both companies,
   "earned against July"). */
console.log('\n1. one month');
const all = await companyMonth(q, '2026-08', null);
check('fares are every priced trip: 400 + 100 + 240', all.fares === 740 && all.fare_coverage_pct === 100, j([all.fares, all.fare_coverage_pct]));
check('earned is the Overview’s money in: Uber on its statement (300 + 180), Bolt on its fares (100)',
  all.earned === 580 && all.earned_basis.uber === 'statement' && all.earned_basis.bolt === 'fares', j([all.earned, all.earned_basis]));
check('paid into the bank: Uber’s payouts, 240 + 140, and the platforms it covers', all.bank === 380 && j(all.bank_platforms) === '["uber"]', j([all.bank, all.bank_platforms]));
check('cash taken: Uber’s own 110 on its cash trip, the fare (50) on Bolt’s', all.cash === 160 && all.cash_trips === 2, j([all.cash, all.cash_trips]));
check('completed trips 9 (a cancellation is not one); 3 drivers; 3 vehicles',
  all.completed === 9 && all.drivers === 3 && all.vehicles === 3, j([all.completed, all.drivers, all.vehicles]));
check('averages: fares per vehicle and per driver 246.67, trips per driver 3',
  all.per_vehicle === 246.67 && all.per_driver === 246.67 && all.trips_per_driver === 3, j([all.per_vehicle, all.per_driver, all.trips_per_driver]));
const eco = await companyMonth(q, '2026-08', 'ecosine');
const ega = await companyMonth(q, '2026-08', 'egari');
check('by company: Ecosine fares 500, earned 400, bank 240, cash 160', eco.fares === 500 && eco.earned === 400 && eco.bank === 240 && eco.cash === 160,
  j([eco.fares, eco.earned, eco.bank, eco.cash]));
check('by company: Egari fares 240, earned 180, bank 140, no cash', ega.fares === 240 && ega.earned === 180 && ega.bank === 140 && ega.cash === 0,
  j([ega.fares, ega.earned, ega.bank, ega.cash]));
const y = await companyMonth(q, '2025-08', null);
check('a year ago: fares only — Uber counted on fares, no payout', y.fares === 660 && j(y.earned_basis) === '{"uber":"fares"}' && y.bank === null,
  j([y.fares, y.earned_basis, y.bank]));

/* ── 2. the comparisons ────────────────────────────────────────────────────
   REVERSION: compare `earned` without the basis check -> 41 passed,
   2 FAILED ("earned against a year ago is refused…" — it prints -12.1%, a
   statement against fares — and the email's n/c check).
   REVERSION: drop the payout-never-collected reason -> 42 passed, 1 FAILED
   ("the bank against a year ago…"). REVERSION: FARE_COVERAGE_MIN 0 -> 42
   passed, 1 FAILED ("fares on an under-priced month…": +146.7%). */
console.log('\n2. the comparisons');
const f = await monthFacts(q, '2026-08', { now: NOW });
const row = (rows, key) => rows.find((r) => r.key === key);
const fares = row(f.total, 'fares');
check('fares: +32.1% on July (740 vs 560), +12.1% on August 2025 (740 vs 660)',
  fares.vs_prev.pct === 32.1 && fares.vs_ly.pct === 12.1, j([fares.vs_prev, fares.vs_ly]));
const earned = row(f.total, 'earned');
check('earned against July: same bases, +56.8% (580 vs 370)', earned.prev === 370 && earned.vs_prev.pct === 56.8, j([earned.prev, earned.vs_prev]));
check('earned against a year ago is refused, and says why: Uber on fares then, on its statement now',
  earned.vs_ly.pct === null && /August 2025 counts Uber on fares \(before commission\), August 2026 on its statement \(after commission\) — not the same measure/.test(earned.vs_ly.why || ''),
  j(earned.vs_ly));
const bank = row(f.total, 'bank');
check('the bank against July: +72.7% (380 vs 220)', bank.vs_prev.pct === 72.7, j(bank.vs_prev));
check('the bank against a year ago: no payout collected, and why',
  bank.vs_ly.pct === null && /no payout was collected for August 2025: Uber's earnings reach back about 192 days/.test(bank.vs_ly.why || ''), j(bank.vs_ly));
const veh = row(f.total, 'vehicles');
check('active vehicles: 3 against 4 (−25%) and against 2 (+50%)', veh.vs_prev.pct === -25 && veh.vs_ly.pct === 50, j([veh.vs_prev, veh.vs_ly]));
const thin = compare('fares', { month: '2026-08', fares: 740, fare_coverage_pct: 100 }, { month: '2025-04', fares: 300, fare_coverage_pct: 66.7 });
check('fares on an under-priced month are not compared, and it says how priced',
  thin.pct === null && /April 2025 has fares on only 66.7% of its trips/.test(thin.why || ''), j(thin));
const cashThin = compare('cash', { month: '2026-08', cash: 900, cash_trips: 10, cash_unvalued: 0 }, { month: '2025-08', cash: 100, cash_trips: 10, cash_unvalued: 4 });
check('cash against a month whose cash trips have no amount is not compared', cashThin.pct === null && /4 of August 2025's 10 cash trips have no amount/.test(cashThin.why || ''), j(cashThin));
const ecoRows = f.companies.find((c) => c.fleet === 'ecosine').rows;
check('per company: Ecosine’s fares +25% on July (500 vs 400)', row(ecoRows, 'fares').vs_prev.pct === 25, j(row(ecoRows, 'fares')));

/* ── 3. vehicle by vehicle, driver by driver ────────────────────────────── */
console.log('\n3. vehicles and drivers');
check('every vehicle with a trip this month, by fares: E1, G1, E2 — not E3, which drove only in July',
  j(f.vehicles.map((v) => v.label)) === '["E1","G1","E2"]', j(f.vehicles.map((v) => v.label)));
const e1 = f.vehicles[0];
check('E1: 4 trips, 400 — +100% on July (200), −20% on August 2025 (500)', e1.trips === 4 && e1.fares === 400 && e1.vs_prev === 100 && e1.vs_ly === -20, j(e1));
const e2 = f.vehicles.find((v) => v.label === 'E2');
check('E2 had no trip a year ago: no percentage, marked new', e2.vs_ly === null && e2.trips_ly === 0, j(e2));
check('drivers by fares, with their company', j(f.drivers.map((d) => [d.label, d.fleet])) === '[["Test Driver A","ecosine"],["Test Driver C","egari"],["Test Driver B","ecosine"]]',
  j(f.drivers.map((d) => [d.label, d.fleet])));
check('the month is ready: every channel delivered the last day, fares fully priced', f.ready === true, j([f.collection, f.at['2026-08'].all.fare_coverage_pct]));

/* ── 4. the model may not move a number ─────────────────────────────────
   REVERSION: skip guardText on the summary -> 42 passed, 1 FAILED ("a
   summary with a number it was not given is dropped…"). */
console.log('\n4. GLM 5.2, held to the figures');
const calls = [];
const modelSays = (content) => async (url, opt) => {
  calls.push(url);
  if (/resend/.test(url)) return { status: 200, data: { id: `re_${calls.length}` } };
  return { status: 200, data: { choices: [{ message: { content }, finish_reason: 'stop' }] } };
};
const good = j({ summary: 'Fares rose 32.1% on July to AED 740 across 9 completed trips; Egari held at 240 while Ecosine grew 25%.',
  points: ['E1 doubled on July, up 100%.', 'Earned after commission cannot be set against August 2025.'] });
let note = await analyseMonth(f, { http: modelSays(good) });
check('a summary using only given numbers is kept', note.outcome === 'ok' && note.by === 'model' && note.points.length === 2, j(note));
note = await analyseMonth(f, { http: modelSays(j({ summary: 'Fares rose 41% on July.', points: [] })) });
check('a summary with a number it was not given is dropped, the figures’ own stands in, and the email says why',
  note.outcome === 'dropped' && note.by === 'rule' && /41/.test(note.why) && /Riders paid AED 740.00 in fares in August 2026/.test(note.summary), j(note));
note = await analyseMonth(f, { http: modelSays('not json at all') });
check('an answer not in the agreed form is dropped', note.outcome === 'dropped' && /agreed form/.test(note.why), j(note));
check('a percentage written without its sign is still a number it was given (−25% as "25%")',
  guardText('Vehicles fell 25% on July.', allowedNumbers(modelInput(f), f)).ok);
check('the rule summary names both companies', /Ecosine: AED 500.00 in fares/.test(ruleSummary(f)) && /Egari: AED 240.00/.test(ruleSummary(f)), ruleSummary(f));

console.log('\n5. the email');
note = await analyseMonth(f, { http: modelSays(good) });
const { html, text, subject } = renderMonthlyEmail(f, note, { dashboard: 'https://fleet.example.test' });
check('the subject: month, fares, both changes', subject === 'August 2026 — fares AED 740.00 · +32.1% on Jul 26 · +12.1% on Aug 25', subject);
check('both companies, each company, vehicles and drivers are in it',
  ['Both companies', 'By company', 'Ecosine', 'Egari', 'Vehicles', 'Drivers', 'Test Driver A', 'E1'].every((s) => html.includes(s)));
check('a refused comparison reads n/c with its reason under the tables',
  html.includes('n/c') && html.includes('Earned after platform commission, against August 2025: August 2025 counts Uber on fares'));
check('the model’s summary is in it, and says it was checked', html.includes('Fares rose 32.1% on July') && html.includes('every number in it was checked'));
check('…and in the plain text', text.includes('Fares — what riders paid: 740.00') && text.includes('Test Driver C (Egari) — 3 trips, AED 240.00'));
const big = { ...f,
  vehicles: Array.from({ length: 150 }, (_, i) => ({ ...e1, label: `E${i}` })),
  drivers: Array.from({ length: 250 }, (_, i) => ({ ...f.drivers[0], label: `Test Driver ${i}` })) };
const bigHtml = renderMonthlyEmail(big, note).html;
check('150 vehicles and 250 drivers stay under Gmail’s clipping size, the drivers past 200 counted, not dropped silently',
  Buffer.byteLength(bigHtml) < 100_000 && bigHtml.includes(`And 50 more on the dashboard.`) && MAX_ROWS.drivers === 200,
  `${Buffer.byteLength(bigHtml)} bytes`);

/* ── 6. the send ────────────────────────────────────────────────────────
   REVERSION: drop the readiness wait -> 41 passed, 2 FAILED ("on the 1st,
   a month not yet complete waits", and the 3rd's send, which already went).
   REVERSION: recompose on every run instead of reusing the kept report ->
   42 passed, 1 FAILED ("…the model asked once a month"). */
console.log('\n6. the send');
check('the last complete month on 1 October (Dubai) is September; the last call is 3 October 10:00 Dubai',
  lastCompleteMonth(new Date('2026-10-01T02:00:00Z')) === '2026-09' && lastCall('2026-09').toISOString() === '2026-10-03T06:00:00.000Z');
/* Bolt · Egari ran before August ended and not after: the month is not complete. */
await run('bolt', 'egari', '2026-08-30T12:00:00Z', '2026-08-30');
calls.length = 0;
let r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-08', now: new Date('2026-09-01T06:05:00Z') });
check('on the 1st, a month not yet complete waits, and nothing is asked or sent', r.waiting === true && calls.length === 0, j([r, calls]));
r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-08', now: new Date('2026-09-03T06:05:00Z') });
const sends = calls.filter((u) => /resend/.test(u)).length;
check('on the 3rd it goes anyway: both addresses, the model asked once', r.sent === 2 && sends === 2 && calls.length === 3, j([r, calls.length]));
const [kept] = await q(`SELECT detail FROM monthly_report_send WHERE month = '2026-08-01' AND recipient = 'owner@example.test'`);
check('…and says what was short', /Bolt · Egari had not delivered the month’s last day/.test(renderMonthlyEmail(kept.detail.facts, kept.detail.note).html));
calls.length = 0;
r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-08', now: new Date('2026-09-03T07:05:00Z') });
check('an hour later nothing is sent again', r.due === 0 && calls.length === 0, j(r));
process.env.MONTHLY_REPORT_RECIPIENTS = 'owner@example.test, partner@example.test, late@example.test';
calls.length = 0;
r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-08', now: new Date('2026-09-03T08:05:00Z') });
check('an address added later gets the kept report: one send, the model asked once a month', r.sent === 1 && calls.length === 1, j([r, calls]));
calls.length = 0;
r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-07', only: 'tester@example.test', now: NOW });
check('the one-shot test: one address, composed fresh, sent', r.sent === 1 && calls.length === 2, j([r, calls.length]));
calls.length = 0;
r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-07', only: 'tester@example.test', now: NOW });
check('…and a restart does not send it twice', r.due === 0 && calls.length === 0, j(r));
process.env.MONTHLY_REPORT_RECIPIENTS = '';
r = await monthlyReportRun({ q, http: modelSays(good), month: '2026-06', now: NOW });
check('no address set: nothing sent, and why', /MONTHLY_REPORT_RECIPIENTS is empty/.test(r.why || ''), j(r));

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
