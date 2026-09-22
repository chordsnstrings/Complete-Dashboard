/* THE REGISTER: one person's money, chronological, with a running balance.
   ══════════════════════════════════════════════════════════════════════════
   The operator asked for "everything that a person earns and spends in a
   ledger that looks similar to a bank statement which has specific
   transaction history", and gave the rule the cash column turns on:
   "Cash trips are cash to the driver unless they give it to the company."

   So the things this must get right are not the layout. They are:
     · that a cash fare RAISES what the driver holds, at the trip
     · that only a hand-in lowers it
     · that a card fare moves nothing, and SAYS so rather than showing a blank
     · that a balance with no stated opening is a running change, not a
       balance, and renders absent with that reason
     · that a window carries the previous balance IN rather than restarting
     · that the three figures called "earned" are never summed */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);

await q(`INSERT INTO driver (id, full_name) VALUES (42,'Statement Subject')`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name)
         VALUES ('uber','u-1',42,'Statement Subject'), ('bolt','b-1',42,'STATEMENT SUBJECT')`);

const trip = (id, acct, o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name,
                     requested_at, status, payment_type, price, currency, plate, raw)
   VALUES ($1,$2,'ecosine',$3,'Statement Subject',$4,$5,$6,$7,'AED','L45227',$8::jsonb)`,
  [o.platform || 'uber', id, acct, o.at, o.status || 'completed', o.pay, o.price ?? null,
    JSON.stringify(o.raw || {})]);

const led = (type, dir, book, amt, on, o = {}) => q(
  `INSERT INTO driver_ledger
     (person_id, person_name, resolved_from, type_code, direction, book, amount,
      effective_on, entered_by, note, entry_source)
   VALUES (42,'Statement Subject','human:t',$1,$2,$3,$4,$5::date,'ahsan',$6,$7)`,
  [type, dir, book, amt, on, o.note || 'n', o.src || 'manual']);

/* BEFORE the window — this is what must be carried in, not ignored. */
await trip('old-cash', 'u-1', { at: '2026-08-10T09:00:00Z', pay: 'cash', price: 100,
  raw: { uber_payments: { cash_collected: -105, service_fee: -25 } } });

/* IN the window. */
await trip('t1', 'u-1', { at: '2026-09-05T09:00:00Z', pay: 'cash', price: 29.83,
  raw: { uber_payments: { cash_collected: -67.13, service_fee: -7.46 } } });
await trip('t2', 'u-1', { at: '2026-09-06T09:00:00Z', pay: 'braintree', price: 100.53,
  raw: { uber_payments: { service_fee: -25.13 } } });
await trip('t3', 'b-1', { at: '2026-09-07T09:00:00Z', pay: 'cash', price: 50.00,
  platform: 'bolt' });
await trip('t4', 'u-1', { at: '2026-09-08T09:00:00Z', pay: 'cash', price: null,
  status: 'rider_cancelled' });

console.log('\nwith no opening stated, a running column is not a balance');
let r = (await get('/api/driver/register?person=42&from=2026-09-01&to=2026-09-30')).body;
check('the register still lists every line', r.of >= 5, `of=${r.of}`);
check('but the cash balance is ABSENT, not zero', r.opening.cash === null
  && r.lines.every((l) => l.running_cash === null), JSON.stringify(r.opening.cash));
check('and says it is a figure nobody has counted',
  /figure nobody has counted/.test(r.opening.cash_absent_reason || ''),
  r.opening.cash_absent_reason);
check('the owed balance is absent for its own separate reason',
  r.opening.owed === null && /unknown/.test(r.opening.owed_absent_reason || ''),
  r.opening.owed_absent_reason);

console.log('\nonce it is stated, the cash rule runs');
await led('cash_opening', 1, 'cash', 200, '2026-08-31');
await led('opening_balance', 1, 'advance', 1000, '2026-08-31');
await led('cash_deposit', -1, 'cash', -150, '2026-09-09');
await led('cash_advance', 1, 'advance', 500, '2026-09-10');
await led('cash_advance', 1, 'advance', 99999, '2026-09-10', { src: 'verification' });

r = (await get('/api/driver/register?person=42&from=2026-09-01&to=2026-09-30')).body;
const byRef = Object.fromEntries(r.lines.map((l) => [`${l.kind}:${l.ref}`, l]));

check('a cash fare RAISES what the driver holds, at the trip',
  byRef['trip:t1'].cash_in === 67.13, JSON.stringify(byRef['trip:t1']));
check('and it is the platform\'s payments figure, not the rider\'s fare',
  byRef['trip:t1'].fare === 29.83 && byRef['trip:t1'].cash_basis === 'payments_report',
  JSON.stringify(byRef['trip:t1']));
check('a trip with no payments blob falls back to the fare and says so',
  byRef['trip:t3'].cash_in === 50 && byRef['trip:t3'].cash_basis === 'fare_only',
  JSON.stringify(byRef['trip:t3']));

/* THE ONE A BLANK CELL WOULD GET WRONG. */
check('a CARD fare moves no balance', byRef['trip:t2'].cash_in === null);
check('and the row says WHY rather than leaving a cell to read as nought',
  /rider paid the platform/.test(byRef['trip:t2'].no_movement_reason || ''),
  byRef['trip:t2'].no_movement_reason);
check('a cancelled booking says its own different reason',
  /did not complete/.test(byRef['trip:t4'].no_movement_reason || ''),
  byRef['trip:t4'].no_movement_reason);

console.log('\nonly a hand-in brings it down');
const dep = r.lines.find((l) => l.type_code === 'cash_deposit');
check('a deposit is a ledger line in the cash book', dep && dep.book === 'cash' && dep.ledger === true);
check('and it lowers the running cash', dep.running_cash < byRef['trip:t3'].running_cash,
  `${byRef['trip:t3'].running_cash} -> ${dep.running_cash}`);

/* THE CARRY. 200 opening + 105 taken before the window = 305 in hand on the
   1st, before a single line of this window. A register that summed only its
   own window would have started at nought and read as a driver who repaid
   everything on the 1st. */
check('the window carries the previous balance IN rather than restarting',
  r.carried_in.cash === 305, JSON.stringify(r.carried_in));
check('so the first line continues from it, not from zero',
  byRef['trip:t1'].running_cash === 372.13, String(byRef['trip:t1'].running_cash));

console.log('\nthe books stay apart, and verification moves nothing');
check('a verification row is listed', r.lines.some((l) => l.verification === true));
check('and advances nobody anything',
  r.totals.ledger_advance === 500, String(r.totals.ledger_advance));
check('the owed balance runs on advances and deductions only',
  byRef['trip:t1'].running_owed === 1000, String(byRef['trip:t1'].running_owed));

console.log('\nwhat it refuses to call earnings');
check('fares are totalled', r.totals.fares === 180.36, String(r.totals.fares));
check('and named as the rider\'s charge, not the driver\'s earning',
  /never agree and are never summed/.test(r.totals.fares_are_not_earnings || ''),
  r.totals.fares_are_not_earnings);
/* TWO fee lines, not four: t3 is a Bolt trip and Bolt publishes no per-trip
   money at all, and t4 was cancelled. A register that invented a fee for them
   by allocating a period figure would be stating a number the platform never
   filed — which is the whole reason the commission is drawn per trip from the
   payments blob rather than spread from a statement. */
check('the commission is its own dated line, per trip',
  r.lines.filter((l) => l.kind === 'fee').length === 2,
  String(r.lines.filter((l) => l.kind === 'fee').length));
check('and a platform that files no per-trip fee gets no invented one',
  !r.lines.some((l) => l.kind === 'fee' && l.ref === 't3'));
check('and it is not summed into a book', r.totals.fees === 32.59, String(r.totals.fees));

console.log('\nand it is about one person, or nobody');
/* THREE DIFFERENT NOs, AND THE STATUS IS PART OF THE ANSWER.
   test/reachability.test.mjs enforces across every driver page that an id
   nobody has is a 404. A 200 carrying an absent_reason says "here is the
   answer about that driver" when there is no such driver — and a caller
   cannot then tell it from a real person with an empty register, which is the
   distinction the rest of this product spends its refusals maintaining. */
const none = await get('/api/driver/register');
check('a register with no driver named is REFUSED, not answered for the fleet',
  none.status === 400 && /no fleet-wide version/.test(none.body.absent_reason || ''),
  `${none.status} ${none.body.absent_reason}`);
const bad = await get('/api/driver/register?person=not-a-person');
check('a person id that is not one is a 400 — the question cannot be taken',
  bad.status === 400 && /not a person id/.test(bad.body.absent_reason || ''),
  `${bad.status} ${bad.body.absent_reason}`);
const gone = await get('/api/driver/register?id=no-such-person');
check('and an id NOBODY HAS is a 404 — there is no driver to answer about',
  gone.status === 404 && /no such driver/.test(gone.body.error || ''),
  `${gone.status} ${JSON.stringify(gone.body.error)}`);

/* THE ONE THAT MUST NOT BECOME A REFUSAL. A real person whose register is
   empty is a 200: "nothing has been recorded against them" is an answer about
   somebody, and it comes back with their accounts and the reasons. */
await q(`INSERT INTO driver (id, full_name) VALUES (43,'Never Recorded')`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id)
         VALUES ('uber','u-2',43)`);
const emptyReg = await get('/api/driver/register?person=43&from=2026-09-01&to=2026-09-30');
check('but a REAL person with an empty register is answered, not refused',
  emptyReg.status === 200 && emptyReg.body.person_id === 43,
  `${emptyReg.status} ${emptyReg.body.person_id}`);
check('with both balances absent and their own reasons, rather than zeros',
  emptyReg.body.opening.cash === null && emptyReg.body.opening.owed === null
  && !!emptyReg.body.opening.cash_absent_reason,
  JSON.stringify(emptyReg.body.opening));
const viaAcct = (await get('/api/driver/register?ext_id=b-1&from=2026-09-01&to=2026-09-30')).body;
check('either account of the person opens the same register',
  viaAcct.person_id === 42 && viaAcct.of === r.of, `${viaAcct.person_id} / ${viaAcct.of}`);

console.log(`\n${fail ? '✗' : '✓'} driver_register: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
