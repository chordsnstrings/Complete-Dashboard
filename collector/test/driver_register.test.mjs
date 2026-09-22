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

/* ── THE WINDOWED HALF: income, and cash taken as its three terms ───────────
   The operator, 2026-09-22: "this should show the amount that has come in for
   the date range selected as well, income. Cash taken doesn't show the range
   selected rather complete cash trip amount. cash taken should be cash trip
   amount + cash advance - cash deposited for the duration."

   running_taken above is CUMULATIVE — carry plus the window — which is the
   right answer to "how much has this driver ever taken" and the wrong one to
   "how much did they take in September". Measured on production for person
   114: those two are AED 47,526.31 and AED 1,082.10, forty-four times apart.
   So the flow is reported separately, bounded by the same window as every
   other total on this route.

   THE ARITHMETIC IS ASSERTED ON ITS SIGN, not just its total. driver_ledger
   stores a deposit NEGATIVE (direction -1), so "less what they handed back"
   is an ADDITION. Writing the operator's minus literally would add the
   deposits back and overstate what the driver holds — the dangerous
   direction — and it would still look plausible, which is why the terms and
   the total are pinned separately. */
{
  const ow = r.over_window;
  const t = ow.cash_taken_terms;
  check('the window reports cash fares over the window alone',
    t.cash_fares === 117.13, JSON.stringify(t.cash_fares));
  check('…the CASH advance only, not the whole advance book',
    t.cash_advance === 500 && t.cash_advance_rows === 1, JSON.stringify(t));
  check('…and the deposit, stored negative as the ledger stores it',
    t.cash_deposit === -150 && t.cash_deposit_rows === 1, JSON.stringify(t));
  check('so cash taken is fares plus advances LESS deposits — 117.13 + 500 - 150',
    ow.cash_taken === 467.13, JSON.stringify(ow.cash_taken));
  check('and the sign convention is stated rather than left to be rediscovered',
    t.deposit_is_already_negative === true);
  /* The verification row is 99999 and would dwarf every figure here. */
  check('a verification entry is not in any windowed term',
    t.cash_advance !== 100499 && ow.cash_taken < 1000, JSON.stringify(ow.cash_taken));
  check('the window it was measured over is named on the figure itself',
    ow.from === '2026-09-01' && ow.to === '2026-09-30', JSON.stringify([ow.from, ow.to]));
  /* INCOME. Nothing seeds driver_payout_day here, so this is the ABSENT case
     — and it must say the platforms published nothing for the window, never
     nought earned. */
  check('income is absent rather than nought when no statement was published',
    ow.earned === null, JSON.stringify(ow.earned));
  check('…with the true reason, which is a gap in what was published',
    /not a statement that they earned nothing/.test(ow.earned_absent_reason || ''),
    ow.earned_absent_reason);
}



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

/* THE OPERATOR'S CORRECTION, 2026-09-22, and it changed the design.
   ─────────────────────────────────────────────────────────────────────────
   This route shipped with ONE cash column, `running_cash`, which was null for
   every driver because it answered "how much is in their pocket now" — and
   that needs a stated opening and recorded hand-ins. The operator pointed out
   what that was hiding: "I'm not talking about cash deposit. I'm talking about
   cash trip which is with the driver."

   They were right. The cash TAKEN is measured on every cash trip we hold and
   needs nothing typed by anybody. Measured on production for person 202: 120
   cash trips, AED 7,427.40, and the column rendered an em dash for all of
   them. So there are two quantities now and only one of them can be absent. */
console.log('\ncash taken is measured, and never waits on an opening');
{
  /* Their own subject, created here: the people above have openings by this
     point in the file, and person 43 is not created until the refusals block
     at the bottom. A test that borrows a fixture from another section is a
     test that breaks when that section moves. */
  await q(`INSERT INTO driver (id, full_name) VALUES (44,'No Opening Stated')`);
  await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id)
           VALUES ('uber','u-44',44)`);
  await trip('n1', 'u-44', { at: '2026-09-04T09:00:00Z', pay: 'cash', price: 40.00,
    raw: { uber_payments: { cash_collected: -45.00 } } });
  await trip('n2', 'u-44', { at: '2026-09-06T09:00:00Z', pay: 'cash', price: 60.00 });
  const noOpen = (await get('/api/driver/register?person=44&from=2026-09-01&to=2026-09-30')).body;
  check('and its cash-taken runs on the trips alone',
    noOpen.lines.filter((l) => l.cash_in).length === 2, String(noOpen.of));
  check('a person with NO opening still gets a cash-taken column',
    noOpen.lines.every((l) => l.running_taken != null),
    JSON.stringify(noOpen.lines.slice(0, 2).map((l) => l.running_taken)));
  check('while what they STILL hold stays absent, with its reason',
    noOpen.lines.every((l) => l.running_cash === null)
    && /figure nobody has counted/.test(noOpen.opening.cash_absent_reason || ''),
    noOpen.opening.cash_absent_reason);
  check('and the response says why one needs an opening and the other does not',
    /ceiling, not a balance/.test(noOpen.opening.taken_needs_no_opening || ''),
    noOpen.opening.taken_needs_no_opening);
}

check('cash taken runs cumulatively across the window',
  byRef['trip:t3'].running_taken > byRef['trip:t1'].running_taken,
  `${byRef['trip:t1'].running_taken} -> ${byRef['trip:t3'].running_taken}`);
check('and a hand-in does NOT reduce it — that money was still taken',
  r.lines.find((l) => l.type_code === 'cash_deposit').running_taken
    === byRef['trip:t3'].running_taken,
  'a deposit moved the taken column, which records what went into a hand');

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

/* A NON-CASH ADVANCE INSIDE THE WINDOW, which is what tells the two possible
   readings of "cash advance" apart. `book = 'advance'` is a NET over seven
   type codes — salary_advance, charging_advance, opening_balance, repayment,
   writeoff, refund — and the operator asked for the CASH one. Without a
   second kind of advance in range, summing the book and summing the type give
   the same answer and a wrong implementation passes. */
await led('salary_advance', 1, 'advance', 250, '2026-09-12');
{
  const w = (await get('/api/driver/register?person=42&from=2026-09-01&to=2026-09-30')).body;
  check('a salary advance moves the advance BOOK', w.totals.ledger_advance === 750,
    JSON.stringify(w.totals.ledger_advance));
  check('…but not the CASH advance term, which is the one the operator named',
    w.over_window.cash_taken_terms.cash_advance === 500,
    JSON.stringify(w.over_window.cash_taken_terms.cash_advance));
  check('…so cash taken does not move either',
    w.over_window.cash_taken === 467.13, JSON.stringify(w.over_window.cash_taken));
}

/* And once a statement IS published, income is the sum over the window. */
await q(`INSERT INTO driver_payout_day
           (platform, driver_ext_id, day, period_start, period_end, earnings)
         VALUES ('uber','u-1','2026-09-05','2026-09-01','2026-09-07',400.25),
                ('uber','u-1','2026-09-20','2026-09-15','2026-09-21',300.30),
                ('uber','u-1','2026-10-15','2026-10-12','2026-10-18',9999.99)`);
{
  const w = (await get('/api/driver/register?person=42&from=2026-09-01&to=2026-09-30')).body
    .over_window;
  check('income is the earnings the platforms published inside the window',
    w.earned === 700.55, JSON.stringify(w.earned));
  check('…and a day outside it is not swept in',
    w.earned !== 10700.54, JSON.stringify(w.earned));
  check('…counted over the days that carried one',
    w.earning_days === 2, JSON.stringify(w.earning_days));
  check('…and no longer absent', w.earned_absent_reason === null, w.earned_absent_reason);
}

console.log(`\n${fail ? '✗' : '✓'} driver_register: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
