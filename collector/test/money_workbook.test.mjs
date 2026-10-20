/* THE MONEY WORKBOOK — what a supervisor chasing cash downloads.
   ═════════════════════════════════════════════════════════════════════════
   api/money_workbook.js against a real schema (PGlite), written to bytes by
   src/xlsx_write.js and read back by src/salary/xlsx.js — so every check is
   on what the FILE says, not on an object the file was made from.

   What it proves:
     · "To hand in" is the operator's definition — cash from trips + cash
       advanced − cash handed in — with Uber's cash-collected figure where it
       has arrived, and a hand-in (stored negative) subtracted once;
     · a cash trip with no amount yet is COUNTED and named, never a nought;
     · Dubai days: 23:59 the night before is out, 00:05 on the first day in;
     · the mobile is the 05:00 text's choice, and where that text holds back
       the numbers are shown WITH the reason;
     · payouts by the day they arrived, with the week an Uber wire pays for;
     · the fleet and platform chips, one driver's file, the 31-day rule for
       every trip, and a withheld class reading "(withheld)", never blank.

   REVERSIONS, run 2026-09-28, each failing the checks named: take the
   hand-in's stored negative as the amount handed in, so it ADDS to what is
   owed (6 fail — A reads 167, not 67); drop `h(...)` from the "to hand in"
   column (1); stop counting unpriced trips (2); select cash trips by UTC day
   instead of Dubai day (7 — the 00:05 trip on the 1st drops out). */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { buildMoneyWorkbook, dialFormat } from '../api/money_workbook.js';
import { loadDirectory } from '../api/driver_routes.js';
import { readWorkbook, sheetNamed } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

/* ── people and their accounts (synthetic) ─────────────────────────────── */
const person = async (id, name, fleet, accounts, phones = {}) => {
  await q(`INSERT INTO driver (id, fleet_id, full_name) VALUES ($1, $2, $3)`, [id, fleet, name]);
  for (const [platform, ext] of accounts) {
    await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name) VALUES ($1, $2, $3, $4)`, [platform, ext, id, name]);
    if (phones[ext]) await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone) VALUES ($1, $2, $3, $4, $5)`, [platform, ext, fleet, name, phones[ext]]);
  }
};
await person(1, 'Test Driver A', 'ecosine', [['uber', 'u-a'], ['bolt', 'b-a']], { 'u-a': '0501111111' });
await person(2, 'Test Driver B', 'ecosine', [['uber', 'u-b']], { 'u-b': '0507777777' });
await person(3, 'Test Driver C', 'ecosine', [['uber', 'u-c']], { 'u-c': '0507777777' });   // same handset as B
await person(4, 'Test Driver D', 'egari', [['uber', 'u-d'], ['yango', 'y-d']], { 'u-d': '0502222222' });
/* E files a longer name on their trips than their person record carries —
   the Drivers page prints the longer one, and so must the file (DR1).
   F holds two accounts with 10.4 km each: 20.8, so 21 rounded once for the
   person, where rounding each account first made 20 (DR1-DR3, km). */
await person(5, 'Test Driver E', 'ecosine', [['uber', 'u-e']]);
await person(6, 'Test Driver F', 'ecosine', [['uber', 'u-f'], ['bolt', 'b-f']]);
/* G: two accounts and no distance on either (hotel bookings carry none) —
   km stays absent, not 0. H: one cash trip with no price and no Uber figure
   yet — cash taken is unknown, not 0.00. I: paid in the dates, no booking in
   them — the page shows the Paid figure, so the file carries the row. */
await person(7, 'Test Driver G', 'egari', [['uber', 'u-g'], ['hotel', 'h-g']]);
await person(8, 'Test Driver H', 'ecosine', [['uber', 'u-h']]);
await person(9, 'Test Driver I', 'ecosine', [['uber', 'u-i']]);
/* An account nobody has placed on a person yet, with its own number. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone) VALUES ('bolt', 'b-x', 'ecosine', 'Loose Bolt', '0509999999')`);

/* What each account files as the driver's name on a trip — the person's own
   name, as on production, so the Drivers page names them as the record does. */
const NAMES = { 'u-a': 'Test Driver A', 'b-a': 'Test Driver A', 'u-b': 'Test Driver B', 'u-c': 'Test Driver C',
  'u-d': 'Test Driver D', 'y-d': 'Test Driver D', 'u-e': 'Test Driver E Ehsan Longname', 'u-f': 'Test Driver F', 'b-f': 'Test Driver F',
  'u-g': 'Test Driver G', 'h-g': 'Test Driver G', 'u-h': 'Test Driver H', 'u-i': 'Test Driver I' };
const T = (id, o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status,
                     payment_type, price, currency, distance_km, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, $9, $10, 'AED', $11, $12::jsonb)`,
  [o.platform || 'uber', id, o.fleet || 'ecosine', o.driver, o.name ?? NAMES[o.driver] ?? 'x', o.plate || 'P1', o.at, o.status || 'completed',
    o.pay || 'cash', o.price ?? null, 'km' in o ? o.km : 10,
    JSON.stringify({ ...(o.cash != null ? { uber_payments: { cash_collected: -o.cash, ...(o.fee ? { service_fee: -o.fee } : {}) } } : {}) })]);
/* Range: 2026-09-01 .. 2026-09-07 (Dubai). Times are UTC; Dubai is +4. */
await T('a1', { driver: 'u-a', at: '2026-09-01T06:00:00Z', price: 40, cash: 45, fee: 10 });       // Uber's figure 45, not 40
await T('a2', { driver: 'b-a', platform: 'bolt', at: '2026-09-02T10:00:00Z', price: 30 });        // Bolt: the fare
await T('a3', { driver: 'u-a', at: '2026-09-03T10:00:00Z', price: 55, pay: 'braintree' });         // card: no cash
await T('a4', { driver: 'u-a', at: '2026-09-06T19:00:00Z' });                                        // cash, not priced yet
await T('a0', { driver: 'u-a', at: '2026-08-31T19:59:00Z', price: 99, cash: 99 });                 // 23:59 Dubai on the 31st: out
await T('a5', { driver: 'u-a', at: '2026-08-31T20:05:00Z', price: 20, cash: 22 });                 // 00:05 Dubai on the 1st: in
await T('b1', { driver: 'u-b', at: '2026-09-04T08:00:00Z', price: 70, cash: 77.5 });
await T('c1', { driver: 'u-c', at: '2026-09-04T09:00:00Z', price: 15, cash: 16.25 });
await T('x1', { driver: 'b-x', platform: 'bolt', name: 'Loose Bolt', at: '2026-09-05T09:00:00Z', price: 12 });
await T('d1', { driver: 'u-d', fleet: 'egari', at: '2026-09-02T09:00:00Z', price: 50, cash: 60 });
await T('d2', { driver: 'y-d', platform: 'yango', fleet: 'egari', at: '2026-09-02T11:00:00Z', price: null, pay: 'card' });
await T('late', { driver: 'u-a', at: '2026-10-20T09:00:00Z', price: 10, cash: 10 });                 // outside a 31-day range too
await T('e1', { driver: 'u-e', at: '2026-09-03T08:00:00Z', price: 25, pay: 'card' });
await T('f1', { driver: 'u-f', at: '2026-09-03T09:00:00Z', price: 20, pay: 'card', km: 10.4 });
await T('f2', { driver: 'b-f', platform: 'bolt', at: '2026-09-04T09:00:00Z', price: 20, pay: 'card', km: 10.4 });
/* A booking filed with no driver name: the page cannot list it (it keys a
   person on a name), the file holds it — so it must be shown, not dropped. */
await T('z1', { driver: 'u-z', name: '', at: '2026-09-05T08:00:00Z', price: 25, pay: 'card' });
await T('g1', { driver: 'u-g', fleet: 'egari', at: '2026-09-03T08:00:00Z', price: 30, pay: 'card', km: null });
await T('g2', { driver: 'h-g', platform: 'hotel', fleet: 'egari', at: '2026-09-04T08:00:00Z', price: 90, pay: 'card', km: null });
await T('h1', { driver: 'u-h', at: '2026-09-04T12:00:00Z' });                                            // cash, no price, no Uber figure
await T('i0', { driver: 'u-i', at: '2026-08-20T08:00:00Z', price: 30, pay: 'card' });                    // before the dates: on the books
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, day, period_start, period_end, period_days, earnings)
         VALUES ('uber', 'ecosine', 'u-i', '2026-09-03', '2026-08-31', '2026-09-06', 7, 41.5)`);
/* Money and Paid, the page's two money columns, for A. */
await q(`INSERT INTO driver_day (driver_ext_id, day, fleet_id, money, money_period_days, money_source)
         VALUES ('u-a', '2026-09-02', 'ecosine', 123.45, 7, 'statement')`);
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, day, period_start, period_end, period_days, earnings)
         VALUES ('uber', 'ecosine', 'u-a', '2026-09-02', '2026-08-31', '2026-09-06', 7, 98.76)`);

/* A hand-in of 50 and an advance of 20 for A; stored the ledger's way. */
const led = (o) => q(
  `INSERT INTO driver_ledger (person_id, person_name, resolved_from, type_code, direction, book, amount, effective_on, entered_by, note)
   VALUES ($1, $2, 'person_id', $3, $4, $5, $6, $7, 'supervisor@example.test', $8)`,
  [o.person, o.name, o.type, Math.sign(o.amount), o.book, o.amount, o.day, o.note || '']);
let ledOk = true;
try {
  await led({ person: 1, name: 'Test Driver A', type: 'cash_deposit', book: 'cash', amount: -50, day: '2026-09-04', note: 'handed to supervisor' });
  await led({ person: 1, name: 'Test Driver A', type: 'cash_advance', book: 'advance', amount: 20, day: '2026-09-05' });
} catch (e) { ledOk = false; console.log(`  (ledger seed: ${e.message})`); }
check('the ledger took a hand-in and an advance the way the product stores them', ledOk);

/* Payouts: an Uber wire on Monday the 7th paying for 31 Aug–6 Sep; a Bolt
   payout the list has; one only Bolt's balance ledger shows; one outside. */
await q(`INSERT INTO platform_payout (platform, fleet_id, payout_ext_id, paid_on, amount, period_start, period_end, source)
         VALUES ('uber', 'ecosine', 'u-w1', '2026-09-07', 12345.67, '2026-08-31', '2026-09-06', 'payments statement'),
                ('bolt', 'ecosine', 'b-p1', '2026-09-01', 800.00, NULL, NULL, 'fleetOwnerPortal'),
                ('uber', 'ecosine', 'u-w0', '2026-08-31', 999.00, '2026-08-24', '2026-08-30', 'payments statement')`);
await q(`INSERT INTO platform_balance_day (platform, fleet_id, day, payout) VALUES ('bolt', 'ecosine', '2026-09-07', 321.00)`);
await q(`INSERT INTO platform_account_day (platform, fleet_id, day, basis, earnings, cash_collected, commission, bank_transferred)
         VALUES ('uber', 'ecosine', '2026-09-07', 'statement', 1000, -300, -250, 12345.67)`);
const run = (source, fleet, status, at) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, started_at, finished_at, status, rows_written)
   VALUES ($1, $2, 'incremental', '2026-09-01', '2026-09-07', $4::timestamptz - interval '5 minutes', $4::timestamptz, $3, 1)`, [source, fleet, status, at]);
await run('uber', 'ecosine', 'ok', '2026-09-07T20:00:00Z');
await run('bolt', 'ecosine', 'ok', '2026-09-05T20:00:00Z');
await run('bolt', 'ecosine', 'error', '2026-09-07T20:00:00Z');

const NOW = new Date('2026-09-08T06:00:00Z');
/* The Drivers page's rows for the same dates and chips, as the route passes
   them (api/money_export_routes.js). */
const pageRows = (o = {}) => loadDirectory(q, { from: o.from || '2026-09-01', to: o.to || '2026-09-07', platform: o.platform || null, fleet: o.fleet || null });
const make = async (o) => {
  const r = await buildMoneyWorkbook({ q, from: '2026-09-01', to: '2026-09-07', now: NOW, directory: await pageRows(o), ...o });
  return { ...r, file: readWorkbook(r.wb.toBuffer()) };
};
const table = (file, name) => {
  const rows = sheetNamed(file, name)?.rows || [];
  const hi = rows.findIndex((r) => r.some((c) => c != null) && r.every((c) => c == null || typeof c === 'string') && rows.indexOf(r) >= 0 && r[0] != null && r.length > 2);
  const head = rows[hi] || [];
  return rows.slice(hi + 1).filter((r) => r.some((c) => c != null)).map((r) => Object.fromEntries(head.map((k, i) => [k, r[i]])));
};
const text = (file, name) => (sheetNamed(file, name)?.rows || []).map((r) => r.filter((c) => c != null).map(String).join(' | ')).join('\n');

console.log('\n1. the whole fleet, one week');
const all = await make({});
check('the sheets, in the supervisor’s order', all.file.sheetNames.join('|')
  === 'Read me|Cash to collect|Cash by day|Cash trips|Hand-ins & advances|Drivers|Money by day|Bank payouts|Platform statements|Every trip', all.file.sheetNames.join('|'));
const cc = table(all.file, 'Cash to collect');
const A = cc.find((r) => r.Driver === 'Test Driver A');
check('A: cash from trips is Uber’s figure (45 + 22) plus Bolt’s fare (30) = 97', A?.['Cash from trips (AED)'] === 97, JSON.stringify(A));
check('A: advanced 20, handed in 50 — the hand-in shown as a positive amount', A?.['Advances recorded (AED)'] === 20 && A?.['Hand-ins recorded (AED)'] === 50);
check('A: to hand in = 97 + 20 − 50 = 67', A?.['To hand in (AED)'] === 67);
check('A: the trip at 23:59 the night before is out, 00:05 on the 1st is in', A?.['Cash trips'] === 4, String(A?.['Cash trips']));
check('A: the Uber trip not priced yet is counted, and in no amount', A?.['Not priced yet'] === 1);
check('A: the mobile is Uber’s, written to dial', A?.Mobile === '+971 50 111 1111' && A?.['About the mobile'] === 'Uber’s number', `${A?.Mobile} ${A?.['About the mobile']}`);
check('A: the last cash trip and hand-in are dates', A?.['Last cash trip'] instanceof Date && A['Last cash trip'].toISOString() === '2026-09-06T23:00:00.000Z'
  && A?.['Last hand-in'] instanceof Date && A['Last hand-in'].toISOString().startsWith('2026-09-04'), String(A?.['Last cash trip']));
const B = cc.find((r) => r.Driver === 'Test Driver B');
check('B: a number on two drivers is shown with the reason in words', B?.Mobile === '+971 50 777 7777' && /also on another driver/.test(B?.['About the mobile'] || ''), JSON.stringify(B));
const X = cc.find((r) => /Loose Bolt/.test(r.Driver || ''));
check('an account no person holds yet is listed, named as such, with its own number', /\(Bolt account, not yet placed on a person\)/.test(X?.Driver || '')
  && X?.Mobile === '+971 50 999 9999', JSON.stringify(X));
check('the most to collect comes first', cc[0]?.Driver === 'Test Driver B' && cc.findIndex((r) => r.Driver === 'Test Driver A') === 1, cc.map((r) => `${r.Driver}:${r['To hand in (AED)']}`).join(', '));
check('a card-only driver is not on the cash sheet', !cc.some((r) => r.Driver === 'Test Driver D' && r['Cash trips'] === 0));

const rm = text(all.file, 'Read me');
check('the notes give the definition in words', /To hand in = cash from trips \+ advances recorded − hand-ins recorded/.test(rm));
check('…name the platform whose trips are not priced, and why', /Uber: 2 cash trips have no amount yet — Uber publishes a trip’s amount on its payments report hours after the ride/.test(rm) && /read every hour/.test(rm));
check('…say a failed collection by name', /Bolt — Ecosine \| The latest collection \(2026-09-07 23:55\) FAILED; the last good one was 2026-09-06 00:00/.test(rm), rm.split('\n').filter((l) => /Bolt —/.test(l)).join(' / '));
check('…say payouts are by the day they arrived', /Listed by the day the money ARRIVED/.test(rm) && /Yango \| Yango does not publish a transfer/.test(rm));
check('…and carry the summary total to hand in', (sheetNamed(all.file, 'Read me').rows.find((r) => r[0] === 'To hand in (AED)') || [])[1] === 67 + 77.5 + 16.25 + 12 + 60);

const cd = table(all.file, 'Cash by day').filter((r) => r.Driver === 'Test Driver A');
check('cash by day runs A’s total up to the same 67', cd.at(-1)?.['To hand in so far (AED)'] === 67, cd.map((r) => r['To hand in so far (AED)']).join(','));
const ct = table(all.file, 'Cash trips');
const a1 = ct.find((r) => r['Trip id'] === 'a1');
check('a cash trip says how its cash was valued', a1?.['Cash (AED)'] === 45 && a1?.['How the cash was valued'] === 'the platform’s cash-collected figure' && a1?.['Fare (AED)'] === 40);
check('…and an unpriced one says so, with no amount', ct.find((r) => r['Trip id'] === 'a4')?.['How the cash was valued'] === 'not priced yet' && ct.find((r) => r['Trip id'] === 'a4')?.['Cash (AED)'] == null);
const hi = table(all.file, 'Hand-ins & advances');
check('hand-ins and advances are listed with who recorded them', hi.length === 2 && hi[0].What === 'Cash handed in' && hi[0]['Amount (AED)'] === 50
  && hi[0]['Recorded by'] === 'supervisor@example.test', JSON.stringify(hi[0]));

const dr = table(all.file, 'Drivers');
const D = dr.find((r) => r.Driver === 'Test Driver D');
check('Drivers: a platform that sent no fare is an empty cell, not 0.00', D && D['Yango fares (AED)'] == null && D['Uber fares (AED)'] === 50, JSON.stringify(D));
check('Drivers: Uber’s commission is carried where Uber filed it', dr.find((r) => r.Driver === 'Test Driver A')?.['Uber commission (AED)'] === 10);

const bp = table(all.file, 'Bank payouts');
check('payouts: only those that arrived in the dates', bp.length === 3 && !bp.some((r) => r['Amount (AED)'] === 999), bp.map((r) => r['Amount (AED)']).join(','));
const w1 = bp.find((r) => r['Amount (AED)'] === 12345.67);
check('…an Uber wire says the week it pays for', w1?.['Pays for, from'] instanceof Date && w1['Pays for, from'].toISOString().startsWith('2026-08-31'));
check('…a Bolt payout says Bolt does not say', bp.find((r) => r['Amount (AED)'] === 800)?.['Pays for, from'] === 'Bolt does not say');
check('…and one only Bolt’s ledger shows is marked as such', /^not yet/.test(bp.find((r) => r['Amount (AED)'] === 321)?.['Listed by the platform'] || ''));
check('the platform’s own statement is carried as it filed it', table(all.file, 'Platform statements')[0]?.['To the bank (AED)'] === 12345.67);
check('every trip, cash or card, for a week — seventeen bookings, the three outside the dates left out', table(all.file, 'Every trip').length === 17, String(table(all.file, 'Every trip').length));

console.log('\n2. the chips, one driver, a longer range');
const eg = await make({ fleet: 'egari' });
const egc = table(eg.file, 'Cash to collect');
check('Egari only: one driver, D', egc.length === 1 && egc[0].Driver === 'Test Driver D' && egc[0]['To hand in (AED)'] === 60, JSON.stringify(egc));
check('…and the notes say no hand-in is recorded, so it is all the cash taken', /No cash hand-in is recorded in FleetMirror for these dates/.test(text(eg.file, 'Read me')));
const bo = await make({ platform: 'bolt' });
const boA = table(bo.file, 'Cash to collect').find((r) => r.Driver === 'Test Driver A');
check('Bolt only: A’s Bolt cash, with the hand-in still subtracted in full', boA?.['Cash from trips (AED)'] === 30 && boA?.['To hand in (AED)'] === 0);
check('…and the notes say why', /A hand-in is not per platform/.test(text(bo.file, 'Read me')));
const one = await make({ person: { id: 1, name: 'Test Driver A' } });
check('one driver: their own sheets, no company-wide ones', one.file.sheetNames.join('|') === 'Read me|Driver|Cash to collect|Cash by day|Cash trips|Hand-ins & advances|Every trip', one.file.sheetNames.join('|'));
check('…only their rows', table(one.file, 'Cash to collect').length === 1 && table(one.file, 'Cash trips').every((r) => r.Driver === 'Test Driver A')
  && table(one.file, 'Every trip').length === 5, String(table(one.file, 'Every trip').length));
const long = await buildMoneyWorkbook({ q, from: '2026-09-01', to: '2026-10-31', now: NOW, directory: await pageRows({ to: '2026-10-31' }) });
check('over 31 days: no Every trip sheet, and the notes say where to get it', !long.sheets.includes('Every trip')
  && /“Every trip” is included for ranges up to 31 days; this range is 61/.test(text(readWorkbook(long.wb.toBuffer()), 'Read me')));

console.log('\n3. a role without cash or contact details');
const w = await make({ hide: new Set(['CASH', 'CT']) });
const wA = table(w.file, 'Cash to collect').find((r) => r.Driver === 'Test Driver A');
check('cash cells read (withheld), never empty', wA?.['To hand in (AED)'] === '(withheld)' && wA?.['Cash from trips (AED)'] === '(withheld)');
check('the mobile reads (withheld)', wA?.Mobile === '(withheld)');
check('…while the count of trips and the name stay', wA?.['Cash trips'] === 4 && wA?.Driver === 'Test Driver A');
check('the notes say which classes and what an empty cell means', /\(withheld\) held a value your role does not include: cash, contact details\. An empty cell never had one\./.test(text(w.file, 'Read me')));
check('a phone written to dial', dialFormat('971501234567') === '+971 50 123 4567' && dialFormat('') === '');

console.log('\n4. the Drivers sheet is the Drivers page (DR1-DR3, 2026-10-20)');
/* REVERSIONS, run 2026-10-20: build the sheet from the workbook's own
   per-account entries again (the old loop) — the name, days, money and paid
   checks fail; take the person record's name in shownName — "E is named as
   the page names them" fails; drop the loose-row loop — "a booking the page
   cannot list is shown" fails; round km per account in loadDirectory again —
   the km check fails with 20. */
{
  const rows = await pageRows();
  const page = rows.filter((r) => Number(r.trips) > 0 || Number(r.money) || Number(r.payout));
  const sheet = table(all.file, 'Drivers');
  const listed = sheet.filter((r) => !/not on the Drivers page/.test(r.Driver));
  check('one row per person the page lists, in the page\u2019s order, under the page\u2019s name',
    listed.length === page.length && listed.every((r, i) => r.Driver === page[i].driver_name),
    JSON.stringify([listed.map((r) => r.Driver), page.map((r) => r.driver_name)]));
  const num = (v) => (v == null ? null : Number(v));
  const same = listed.every((r, i) => {
    const p = page[i];
    return r.Bookings === p.trips && r.Completed === p.completed
      && (num(p.priced_trips) ? r['Fares (AED)'] === Math.round(num(p.revenue) * 100) / 100 : r['Fares (AED)'] == null)
      && (r['Money (AED)'] ?? null) === (p.money == null ? null : Math.round(num(p.money) * 100) / 100)
      && (r['Paid (AED)'] ?? null) === (p.payout == null ? null : Math.round(num(p.payout) * 100) / 100)
      && (r.Km ?? null) === num(p.km) && r['Days worked'] === p.days;
  });
  check('bookings, completed, fares, money, paid, km and days are the page\u2019s, row for row', same,
    JSON.stringify(listed.map((r) => [r.Driver, r.Bookings, r['Fares (AED)'], r['Money (AED)'], r['Paid (AED)'], r.Km, r['Days worked']])));
  const A = listed.find((r) => r.Driver === 'Test Driver A');
  check('A worked Uber on the 1st, 3rd and 6th and Bolt on the 2nd: four days, not the three of one account',
    A?.['Days worked'] === 4, JSON.stringify(A));
  check('A\u2019s Money and Paid are the page\u2019s columns', A?.['Money (AED)'] === 123.45 && A?.['Paid (AED)'] === 98.76
    && /7-day statements/.test(A?.['Money is'] || ''), JSON.stringify(A));
  check('A\u2019s cash is still the operator\u2019s cash taken', A?.['Cash trips'] === 4 && A?.['Cash from trips (AED)'] === 45 + 30 + 22, JSON.stringify(A));
  check('E is named as the page names them, on every sheet', listed.some((r) => r.Driver === 'Test Driver E Ehsan Longname')
    && !listed.some((r) => r.Driver === 'Test Driver E')
    && table(all.file, 'Every trip').some((r) => r.Driver === 'Test Driver E Ehsan Longname'));
  check('F: 10.4 + 10.4 km is 21 for the person, rounded once', listed.find((r) => r.Driver === 'Test Driver F')?.Km === 21
    && page.find((r) => r.driver_name === 'Test Driver F')?.km === 21, JSON.stringify(page.find((r) => r.driver_name === 'Test Driver F')));
  const loose = sheet.filter((r) => /not on the Drivers page/.test(r.Driver));
  check('a booking the page cannot list (no driver name) is shown, never dropped', loose.length === 1 && loose[0].Bookings === 1, JSON.stringify(loose));
  check('the whole sheet holds every booking in the dates', sheet.reduce((a, r) => a + r.Bookings, 0) === table(all.file, 'Every trip').length);
  const d1 = table(one.file, 'Driver');
  const pa = page.find((r) => r.driver_name === 'Test Driver A');
  check('one driver\u2019s file opens with their page\u2019s figures', d1.length === 1 && d1[0].Driver === 'Test Driver A'
    && d1[0].Bookings === pa.trips && d1[0]['Booked revenue (AED)'] === Number(pa.revenue) && d1[0]['Platform earnings (AED)'] === 98.76
    && d1[0]['Money (AED)'] === 123.45 && d1[0]['Cash collected (AED)'] === 97 && d1[0]['Cash trips'] === 4 && d1[0]['Days worked'] === 4,
  JSON.stringify(d1));
  const named = await make({ person: { id: 1, name: 'Test Driver A As Their Page Names Them' } });
  check('…under the name their page prints, on every sheet of it', table(named.file, 'Driver')[0]?.Driver === 'Test Driver A As Their Page Names Them'
    && table(named.file, 'Cash to collect')[0]?.Driver === 'Test Driver A As Their Page Names Them');
  const wE = await make({ hide: new Set(['EARN']) });
  check('a role without driver earnings finds Money and Paid withheld', table(wE.file, 'Drivers').find((r) => r.Driver === 'Test Driver A')?.['Money (AED)'] === '(withheld)');
  /* The independent review of 2026-10-20.
     REVERSIONS (run 2026-10-20): the fold's `+(cur.km || 0) + +(r.km || 0)`
     — "G … absent" fails with 0; the trips-only row filter — "I … carries
     the row" fails; `r2(sumOf(cashTaken))` for an all-unpriced row — both
     "H … unknown" checks fail with 0. */
  const G = listed.find((r) => r.Driver === 'Test Driver G');
  check('G: two accounts and no distance on either reads no km — absent, as on their page, not 0',
    G && G.Km == null && page.find((r) => r.driver_name === 'Test Driver G')?.km === null, JSON.stringify(G));
  const I = listed.find((r) => r.Driver === 'Test Driver I');
  check('I: paid in the dates with no booking in them — the page shows the Paid, so the file carries the row',
    I && I.Bookings === 0 && I['Paid (AED)'] === 41.5, JSON.stringify(I));
  const H = listed.find((r) => r.Driver === 'Test Driver H');
  check('H: a cash trip with no price yet — cash from trips is unknown, not 0.00, and says one is not priced',
    H && H['Cash trips'] === 1 && H['Cash from trips (AED)'] == null && H['Cash not priced yet'] === 1, JSON.stringify(H));
  const h1 = table((await make({ person: { id: 8, name: 'Test Driver H' } })).file, 'Driver')[0];
  check('…and their own file says the same: no Cash collected figure, one trip not priced yet',
    h1 && h1['Cash collected (AED)'] == null && h1['Not priced yet'] === 1 && h1['Cash trips'] === 1, JSON.stringify(h1));
  check('A, partly priced: the priced part, and the one waiting named beside it',
    A?.['Cash from trips (AED)'] === 97 && A?.['Cash not priced yet'] === 1, JSON.stringify(A));
  let threw = false;
  try { await buildMoneyWorkbook({ q, from: '2026-09-01', to: '2026-09-07', now: NOW }); } catch { threw = true; }
  check('without the page\u2019s rows the file is refused, never built from a second set of queries', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
