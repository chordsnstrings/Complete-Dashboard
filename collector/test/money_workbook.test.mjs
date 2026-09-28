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
/* An account nobody has placed on a person yet, with its own number. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone) VALUES ('bolt', 'b-x', 'ecosine', 'Loose Bolt', '0509999999')`);

const T = (id, o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status,
                     payment_type, price, currency, distance_km, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', $8, $9, $10, 'AED', $11, $12::jsonb)`,
  [o.platform || 'uber', id, o.fleet || 'ecosine', o.driver, o.name || 'x', o.plate || 'P1', o.at, o.status || 'completed',
    o.pay || 'cash', o.price ?? null, o.km ?? 10,
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
const make = async (o) => {
  const r = await buildMoneyWorkbook({ q, from: '2026-09-01', to: '2026-09-07', now: NOW, ...o });
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
check('…name the platform whose trips are not priced, and why', /Uber: 1 cash trip has no amount yet — Uber prices a trip only when its nightly catch-up/.test(rm));
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
check('every trip, cash or card, for a week — ten bookings, the two outside the dates left out', table(all.file, 'Every trip').length === 10, String(table(all.file, 'Every trip').length));

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
check('one driver: their own sheets, no company-wide ones', one.file.sheetNames.join('|') === 'Read me|Cash to collect|Cash by day|Cash trips|Hand-ins & advances|Every trip', one.file.sheetNames.join('|'));
check('…only their rows', table(one.file, 'Cash to collect').length === 1 && table(one.file, 'Cash trips').every((r) => r.Driver === 'Test Driver A')
  && table(one.file, 'Every trip').length === 5, String(table(one.file, 'Every trip').length));
const long = await buildMoneyWorkbook({ q, from: '2026-09-01', to: '2026-10-31', now: NOW });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
