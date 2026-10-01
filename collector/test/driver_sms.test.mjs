/* THE DRIVER MESSAGES — who is texted, what they are told, and when nothing is.
   ═════════════════════════════════════════════════════════════════════════
   src/driver_sms.js against a real schema (PGlite) and a fake gateway. Every
   hold below is a case the measurement of production on 2026-09-28 found
   (docs/COVERAGE.md "Driver messages by SMS"), and every assertion was proved
   by reverting the rule it names:

     phone      Uber's number first, HR's second (the operator's ruling); two
                numbers, a number on another record, or a held same-person
                pair — nothing is sent.
     cash       Uber's cash-collected, never the fare; nothing until yesterday
                is complete, and at 09:00 a stated give-up; a driver on a
                channel that did not collect is held; nothing for no cash; a
                second run sends nothing twice; off means off.
     trips      only journeys that ended after go-live; the strict filter; the
                same journey reported again is not a second message; at night
                it waits until 07:00, and is re-checked before it goes.

   REVERSIONS, run 2026-09-28, each failing the checks named: read tc.fare
   for cash_amount (2 fail); drop `missingCatchup.length ||` (5); drop the
   channel_not_collected line (1); skip the plate-overlap match (3); set
   `wait` false (5); drop the HELD_IDS check in phoneFor (3); drop
   `others.length` in phoneFor (2); skip the 07:00 re-read (3); ignore the
   trip_since watermark (4).
   And for the rulings of 2026-09-29, each failing the checks named: count
   an uncollected channel's cash anyway (5); drop the channel names from the
   text (6); hold the whole message when any channel is left out, as before
   (6); stop leaving out a channel with no amount yet (3); stop leaving out a
   hotel account matched by name (2); hold a driver named by a last Uber trip
   over 24.9 hours old again (2); a 2 km minimum instead of 4 km (2). */
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { REFUSED } from '../api/identity_map.js';
import { loadPhoneBook, phoneFor, cashDepositRun, tripRegisterRun, flushQueued, readablePlace,
  cashText, tripText, dubaiDay, next7am, HOLD_WHY } from '../src/driver_sms.js';
import { smsRoutes } from '../api/sms_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const sent = [];
const send = async (m) => { sent.push(m); return { ok: true, messageId: `2026092800000${String(sent.length).padStart(6, '0')}`, sender: 'ECOSINE' }; };

/* ── people ─────────────────────────────────────────────────────────────── */
const person = async (id, name, accounts, phones = {}) => {
  await q(`INSERT INTO driver (id, fleet_id, full_name) VALUES ($1, 'ecosine', $2)`, [id, name]);
  for (const [platform, ext] of accounts) {
    await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name) VALUES ($1, $2, $3, $4)`, [platform, ext, id, name]);
    if (phones[ext]) await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone) VALUES ($1, $2, 'ecosine', $3, $4)`, [platform, ext, name, phones[ext]]);
  }
};
await person(1, 'Test Driver A', [['uber', 'u-a']], { 'u-a': '050 111 1111' });
await person(2, 'Test Driver B', [['uber', 'u-b']], { 'u-b': '0502222222' });
await person(3, 'Test Driver C', [['bolt', 'b-c']], {});
await person(4, 'Test Driver D', [['uber', 'u-d']], { 'u-d': '+971503333333' });
await person(5, 'Test Driver E', [['uber', REFUSED[0].a.id]], { [REFUSED[0].a.id]: '0504444444' });
await person(6, 'Test Driver H', [['yango', 'y-h']], { 'y-h': '0505555000' });      // Yango number: not Uber's
await person(7, 'Test Driver T', [['uber', 'u-t1'], ['uber', 'u-t2']], { 'u-t1': '0506666661', 'u-t2': '0506666662' });
await person(8, 'Test Driver S', [['uber', 'u-s']], { 'u-s': '0507777777' });
await person(9, 'Test Driver S2', [['uber', 'u-s2']], { 'u-s2': '0507777777' });   // the same handset
await person(10, 'Test Driver N', [['uber', 'u-n']], {});
await person(11, 'Test Driver X', [['uber', 'u-x']], { 'u-x': '0508888888' });
/* For the channel rule (the operator, 2026-09-29: "send even if bolt doesn't
   work. At least uber is there"): Uber cash beside a channel that cannot be
   counted — Bolt not collected, a Yango trip with no fare, a hotel account
   matched by name — and one driver whose only cash has no amount. */
await person(12, 'Test Driver M', [['uber', 'u-m'], ['bolt', 'b-m']], { 'u-m': '0503131313' });
await person(13, 'Test Driver Y', [['uber', 'u-y'], ['yango', 'y-y']], { 'u-y': '0503232323' });
await person(14, 'Test Driver Q', [['uber', 'u-q'], ['yango', 'y-q']], { 'u-q': '0503434343' });
await person(15, 'Test Driver Z', [['uber', 'u-z'], ['hotel', 'name:test driver z']], { 'u-z': '0503535353' });
await person(16, 'Test Driver V', [['yango', 'y-v']], { 'y-v': '0503636363' });
/* HR: person H's row (matched by the Yango account), and an HR employee
   matched to nobody who carries person X's Uber number. */
await q(`INSERT INTO hr_roster_upload (id, sha256, export_date, export_date_from, byte_len, rows_read, uploaded_by, summary)
         VALUES (1, 'sha-test', '2026-09-23', 'filename', 1, 2, 'test', '{}'::jsonb)`);
const hrRow = (emp, phone, matched) => q(
  `INSERT INTO hr_roster_row (upload_id, fleet_id, employee_id, full_name, phone, match_basis, matched_accounts)
   VALUES (1, 'ecosine', $1, 'Test Employee', $2, $3, $4::jsonb)`, [emp, phone, matched.length ? 'platform_id' : 'none', JSON.stringify(matched)]);
await hrRow('E-H', '0509999999', [{ platform: 'yango', ext_id: 'y-h' }]);
await hrRow('E-Z', '0508888888', []);

console.log('\n1. whose mobile: Uber first, then HR — or nobody');
const book = await loadPhoneBook(q);
check('Uber’s number, normalised to 9715…', phoneFor(book, 1).phone === '971501111111' && phoneFor(book, 1).source === 'uber', JSON.stringify(phoneFor(book, 1)));
check('no Uber number: HR’s (never the Yango roster’s)', phoneFor(book, 6).phone === '971509999999' && phoneFor(book, 6).source === 'hr', JSON.stringify(phoneFor(book, 6)));
check('two different Uber numbers: nobody is guessed', phoneFor(book, 7).hold === 'several_uber_numbers');
check('one handset on two drivers: neither is texted', phoneFor(book, 8).hold === 'number_shared' && phoneFor(book, 9).hold === 'number_shared');
check('a number also on another HR employee: not texted', phoneFor(book, 11).hold === 'number_shared');
check('an account in a REFUSED same-person pair: not texted', phoneFor(book, 5).hold === 'identity_held');
check('no number anywhere: held, not guessed', phoneFor(book, 10).hold === 'no_number');
check('a readable place, and street codes that are not', readablePlace('Al Garhoud') === 'Al Garhoud'
  && readablePlace('Al Barsha 1') === 'Al Barsha 1' && readablePlace('Production city,  Plot 12') === 'Production city'
  && readablePlace('93 D65') === null && readablePlace('16 9 St') === null && readablePlace('') === null);
/* 2026-10-01: 13 of 58 unexplained rides were held for "no readable place",
   most of them ordinary addresses. REVERSION (run 2026-10-01): drop the
   building-number strip -> 67 passed, 1 FAILED (this check). */
check('an address with a building number is its road; a numbered street is a name',
  readablePlace('33 Sheikh Rashid Rd') === 'Sheikh Rashid Rd' && readablePlace('352 Al Rasheed Road') === 'Al Rasheed Road'
  && readablePlace('30th St') === '30th St' && readablePlace('19 5th Street') === '5th Street'
  && readablePlace('D65') === null && readablePlace('12 B') === null,
  [readablePlace('33 Sheikh Rashid Rd'), readablePlace('30th St'), readablePlace('19 5th Street')].join(' | '));

/* ── 2. the 05:00 cash reminder ─────────────────────────────────────────── */
console.log('\n2. the 05:00 cash reminder');
const T = (id, o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, 'x', $5, $6::timestamptz, $6::timestamptz + interval '20 minutes', $7, $8, $9, 'AED', $10::jsonb)`,
  [o.platform || 'uber', id, o.fleet || 'ecosine', o.driver, o.plate || 'C0', o.at, o.status || 'completed', o.pay || 'cash', o.price ?? null,
    JSON.stringify(o.cash != null ? { uber_payments: { cash_collected: -o.cash } } : {})]);
/* D = 2026-09-27 (Dubai). Requested times are UTC. */
await T('c1', { driver: 'u-a', at: '2026-09-27T10:00:00Z', price: 40, cash: 50 });
await T('c2', { driver: 'u-a', at: '2026-09-27T15:00:00Z', price: 55, cash: 60.5 });
await T('c3', { driver: 'u-b', at: '2026-09-27T11:00:00Z', price: 70, pay: 'braintree' });   // card: no cash
await T('c4', { driver: 'b-c', platform: 'bolt', at: '2026-09-27T12:00:00Z', price: 30 });
await T('c5', { driver: 'u-d', at: '2026-09-27T13:00:00Z', price: 45 });                        // no payments figure yet
await T('c6', { driver: REFUSED[0].a.id, at: '2026-09-27T09:00:00Z', price: 20, cash: 25 });
await T('c7', { driver: 'y-h', platform: 'yango', at: '2026-09-27T08:00:00Z', price: 35 });
await T('c8', { driver: 'u-a', at: '2026-09-26T19:59:00Z', price: 99, cash: 99 });            // 23:59 Dubai on the 26th: not yesterday
await T('m1', { driver: 'u-m', at: '2026-09-27T10:30:00Z', price: 40, cash: 44 });
await T('m2', { driver: 'b-m', platform: 'bolt', at: '2026-09-27T12:30:00Z', price: 25 });     // Bolt: did not collect
await T('y1', { driver: 'u-y', at: '2026-09-27T10:40:00Z', price: 30, cash: 33 });
await T('y2', { driver: 'y-y', platform: 'yango', at: '2026-09-27T12:40:00Z', price: 20 });    // Yango: collected
await T('q1', { driver: 'u-q', at: '2026-09-27T10:50:00Z', price: 50, cash: 55 });
await T('q2', { driver: 'y-q', platform: 'yango', at: '2026-09-27T12:50:00Z', price: null });  // Yango: no fare
await T('z1', { driver: 'u-z', at: '2026-09-27T11:00:00Z', price: 10, cash: 11 });
await T('z2', { driver: 'name:test driver z', platform: 'hotel', at: '2026-09-27T13:00:00Z', price: 60 });  // hotel by name
await T('v1', { driver: 'y-v', platform: 'yango', at: '2026-09-27T14:00:00Z', price: null });  // only cash, no amount
const run = (o) => q(`INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, started_at, finished_at, status, rows_written)
                      VALUES ($1, $2, $3, $7::date, $4, $5::timestamptz - interval '10 minutes', $5::timestamptz, $6, 10)`,
  [o.source, o.fleet || 'ecosine', o.mode || 'incremental', o.to || '2026-09-27', o.at, o.status || 'ok', o.from || '2026-08-28']);
await run({ source: 'yango', at: '2026-09-27T21:40:00Z' });
await run({ source: 'hotel', at: '2026-09-27T21:45:00Z' });
/* Bolt ran for Ecosine and failed (as it did on production that night). */
await run({ source: 'bolt', at: '2026-09-27T21:19:00Z', status: 'error' });

const at0530 = new Date('2026-09-28T01:30:00Z');
check('05:30 Dubai asks about the 27th', dubaiDay(new Date(at0530.getTime() - 864e5)) === '2026-09-27');
let r = await cashDepositRun({ q, now: at0530, send, cfg: {} });
check('an Uber cash trip without Uber’s own figure: nobody is texted yet', r.waiting === true && sent.length === 0
  && r.uber_cash_trips_without_figure === 1, JSON.stringify(r));
const [w] = await q(`SELECT status, hold_reason FROM sms_outbox WHERE dedupe_key = 'cash-run:2026-09-27'`);
check('…and the page can say the run is waiting', w?.status === 'held' && w.hold_reason === 'waiting');

/* Every figure in, but Uber's nightly catch-up has not run since the day
   ended: a trip that has not been fetched yet has no figure to be missing. */
await q(`UPDATE trip SET raw = '{"uber_payments":{"cash_collected":-47.5}}'::jsonb WHERE external_id = 'c5'`);
r = await cashDepositRun({ q, now: new Date('2026-09-28T01:40:00Z'), send, cfg: {} });
check('…nor before Uber’s catch-up has run since the day ended', r.waiting === true && sent.length === 0
  && r.missing_catchup?.join() === 'ecosine', JSON.stringify(r));
await run({ source: 'uber', mode: 'catchup', at: '2026-09-27T21:18:00Z' });
r = await cashDepositRun({ q, now: new Date('2026-09-28T01:45:00Z'), send, cfg: {} });
const toA = sent.find((m) => m.to === '971501111111');
check('a driver is told Uber’s cash collected, summed — AED 110.50, not the fare (95.00) — and that it is the Uber cash',
  toA?.text === cashText(110.5, ['uber'])
  && toA.text === 'Please deposit AED 110.50 of Uber cash you received yesterday. Talk to your supervisor on WhatsApp.', toA?.text);
check('…and the trip at 23:59 Dubai the night before is not yesterday’s', !/209|99/.test(toA?.text || 'x'));
check('a driver with only card trips gets nothing', !sent.some((m) => m.to === '971502222222'));
check('a Yango driver with no Uber number is texted on HR’s number, told it is the Yango cash', sent.some((m) => m.to === '971509999999'
  && m.text === 'Please deposit AED 35.00 of Yango cash you received yesterday. Talk to your supervisor on WhatsApp.'));
const textTo = (n) => sent.find((m) => m.to === n)?.text || '';
check('Bolt did not collect: the driver is still asked for the Uber cash, and told it is the Uber cash',
  textTo('971503131313') === 'Please deposit AED 44.00 of Uber cash you received yesterday. Talk to your supervisor on WhatsApp.', textTo('971503131313'));
check('both channels collected: the sum, and both named', textTo('971503232323')
  === 'Please deposit AED 53.00 of Uber and Yango cash you received yesterday. Talk to your supervisor on WhatsApp.', textTo('971503232323'));
check('a Yango trip with no fare: the Uber cash is asked for, Yango left out', textTo('971503434343')
  === 'Please deposit AED 55.00 of Uber cash you received yesterday. Talk to your supervisor on WhatsApp.', textTo('971503434343'));
check('a hotel account matched by name: the Uber cash is asked for, the hotel cash left out', textTo('971503535353')
  === 'Please deposit AED 11.00 of Uber cash you received yesterday. Talk to your supervisor on WhatsApp.', textTo('971503535353'));
const [mRow] = await q(`SELECT status, detail FROM sms_outbox WHERE kind = 'cash_deposit' AND person_id = 12`);
const bolt = (mRow?.detail?.left_out || []).find((x) => x.platform === 'bolt');
check('…and the record says what was left out and why: Bolt, 1 trip, AED 25.00 seen, did not collect',
  mRow?.status === 'sent' && mRow.detail.channels.join() === 'uber' && bolt?.trips === 1 && bolt.known_aed === 25 && bolt.why === 'not_collected',
  JSON.stringify(mRow?.detail));
const [qRow] = await q(`SELECT detail FROM sms_outbox WHERE kind = 'cash_deposit' AND person_id = 14`);
check('…and a trip with no fare is recorded as left out for that reason, not silently dropped',
  (qRow?.detail?.left_out || []).some((x) => x.platform === 'yango' && x.why === 'not_priced' && x.trips === 1), JSON.stringify(qRow?.detail));
/* The split by platform of the amount texted, kept for the 08:00 cash email
   (src/cash_sms_email.js). REVERSION (run 2026-09-30): drop by_channel from
   the detail -> 58 passed, 2 FAILED: this check and "the 08:00 email reads
   the split…". */
const [yRow] = await q(`SELECT detail FROM sms_outbox WHERE kind = 'cash_deposit' AND person_id = 13`);
check('the record keeps the amount per platform, summing to what was texted: Uber 33.00, Yango 20.00',
  JSON.stringify((yRow?.detail?.by_channel || []).map((c) => [c.platform, c.amount, c.trips])) === '[["uber",33,1],["yango",20,1]]'
  && yRow.detail.amount === 53, JSON.stringify(yRow?.detail));
{
  const { cashEmailFacts } = await import('../src/cash_sms_email.js');
  const ef = await cashEmailFacts(q, '2026-09-27');
  const y = ef.drivers.find((x) => x.person_id === 13);
  check('the 08:00 email reads the split and the texted drivers straight from this run',
    ef.drivers.length === 7 && y?.name === 'Test Driver Y' && y.phone === '971503232323'
    && JSON.stringify((y.split || []).map((c) => [c.platform, c.amount])) === '[["uber",33],["yango",20]]',
    JSON.stringify(ef.drivers.map((x) => [x.person_id, x.amount, x.split])));
}
const heldRows = await q(`SELECT person_id, hold_reason FROM sms_outbox WHERE kind = 'cash_deposit' AND status = 'held' ORDER BY person_id`);
const heldBy = Object.fromEntries(heldRows.map((h) => [h.person_id, h.hold_reason]));
check('a Bolt-only driver, when Bolt did not collect, is held — there is no certain amount', heldBy[3] === 'channel_not_collected', JSON.stringify(heldBy));
check('a driver whose only cash has no amount yet is held, with that reason', heldBy[16] === 'amount_not_final', JSON.stringify(heldBy));
check('a driver in a refused same-person pair is held', heldBy[5] === 'identity_held');
check('the counts add up: 7 sent (3 with a channel left out), 3 held', r.sent === 7 && r.held === 3 && r.partial === 3 && sent.length === 7,
  JSON.stringify({ sent: r.sent, held: r.held, partial: r.partial, n: sent.length }));
const n1 = sent.length;
r = await cashDepositRun({ q, now: new Date('2026-09-28T02:00:00Z'), send, cfg: {} });
check('the next quarter-hour sends nothing twice', r.already === true && sent.length === n1);
const [row] = await q(`SELECT destination, message_text, provider_message_id, status FROM sms_outbox WHERE kind = 'cash_deposit' AND person_id = 1`);
check('the outbox keeps the number, the words and the gateway id (as text)', row.status === 'sent' && row.destination === '971501111111'
  && row.message_text === cashText(110.5, ['uber']) && typeof row.provider_message_id === 'string');

/* The 28th never completes: 09:00 gives up and says so. */
await T('c9', { driver: 'u-a', at: '2026-09-28T10:00:00Z', price: 10 });
r = await cashDepositRun({ q, now: new Date('2026-09-29T05:00:00Z'), send, cfg: {}, final: true });
const [gave] = await q(`SELECT status, hold_reason FROM sms_outbox WHERE dedupe_key = 'cash-run:2026-09-28'`);
check('at 09:00, an incomplete day is given up on — stated, not sent', r.gaveUp === true && gave?.hold_reason === 'not_complete' && sent.length === n1);
r = await cashDepositRun({ q, now: new Date('2026-09-30T01:30:00Z'), send, cfg: { sms_cash: 'off' } });
check('switched off: nothing is sent', r.off === true && sent.length === n1);

/* ── 3. the trip request ────────────────────────────────────────────────── */
console.log('\n3. the trip request');
/* Go-live at 01:00Z on the 28th: a journey that ended before it, though
   inside the last 24 hours, is backlog and is never texted. */
await q(`UPDATE sms_state SET value = '2026-09-28T01:00:00Z' WHERE key = 'trip_since'`);
const place = (lat, lng, area) => q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations)
  VALUES (round($1 / 0.005)::int, round($2 / 0.005)::int, $3, 20, 1, 20) ON CONFLICT DO NOTHING`, [lat, lng, area]);
await place(25.25, 55.35, 'Al Garhoud');
await place(25.27, 55.30, 'Deira');
await place(25.10, 55.20, '93 D65');
const seg = (o) => q(
  `INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, duration_min, distance_km, verdict, verdict_reason,
     low_confidence, nearest_gap_min, source, start_lat, start_lng, end_lat, end_lng)
   VALUES ($1, $2::timestamptz, $3::timestamptz, 'ecosine', 40, $4, $5, 'no booking', false, $6, $7, $8, $9, $10, $11)`,
  [o.plate, o.from, o.to, o.km ?? 12.4, o.verdict || 'unauthorized', o.gap ?? 90, o.source || 'fms_trip',
    o.s?.[0] ?? 25.25, o.s?.[1] ?? 55.35, o.e?.[0] ?? 25.27, o.e?.[1] ?? 55.30]);
/* Bracketed: the named driver's own Uber trips on the car end 90 minutes
   before and begin 90 minutes after — the strongest tier. */
const bracket = async (plate, driver, from, to) => {
  const f = new Date(from).getTime(); const t = new Date(to).getTime();
  await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, is_primary)
           VALUES ($1, $2::date, $3, 'uber', 'x', 'ecosine', 2, true) ON CONFLICT DO NOTHING`, [plate, dubaiDay(new Date(f)), driver]);
  await T(`${plate}-before`, { driver, plate, at: new Date(f - 120 * 60_000).toISOString(), pay: 'braintree', price: 20 });
  await q(`UPDATE trip SET ended_at = $2 WHERE external_id = $1`, [`${plate}-before`, new Date(f - 90 * 60_000).toISOString()]);
  await T(`${plate}-after`, { driver, plate, at: new Date(t + 90 * 60_000).toISOString(), pay: 'braintree', price: 20 });
};
const uberRan = (at) => run({ source: 'uber', at, to: '2026-09-29' });
await uberRan('2026-09-28T07:40:00Z');

await seg({ plate: 'L1', from: '2026-09-28T02:00:00Z', to: '2026-09-28T02:40:00Z' });
await bracket('L1', 'u-a', '2026-09-28T02:00:00Z', '2026-09-28T02:40:00Z');
/* The tracker's own journey, filed in `trip` under platform 'fms' as
   production files 241,769 of them: not a booking channel, and never
   "collected". Counting it as one held every FMS car as booking_channel_down.
   REVERSION (run 2026-10-01): read the car's channels from every platform
   again -> 68 passed, 2 FAILED — L1 is held as booking_channel_down and never
   texted. */
await T('L1-fms', { platform: 'fms', driver: null, plate: 'L1', at: '2026-09-27T09:00:00Z', pay: null });
await seg({ plate: 'L2', from: '2026-09-28T03:00:00Z', to: '2026-09-28T03:10:00Z', km: 1.2 });
await bracket('L2', 'u-d', '2026-09-28T03:00:00Z', '2026-09-28T03:10:00Z');
await seg({ plate: 'L3', from: '2026-09-28T01:00:00Z', to: '2026-09-28T01:30:00Z' });                 // nobody on the car: unknown
await seg({ plate: 'L4', from: '2026-09-28T04:00:00Z', to: '2026-09-28T04:30:00Z', e: [25.10, 55.20] });
await bracket('L4', 'u-x', '2026-09-28T04:00:00Z', '2026-09-28T04:30:00Z');
await seg({ plate: 'L5', from: '2026-09-28T00:00:00Z', to: '2026-09-28T00:30:00Z' });                 // before go-live
await bracket('L5', 'u-a', '2026-09-28T00:00:00Z', '2026-09-28T00:30:00Z');
await seg({ plate: 'L7', from: '2026-09-28T05:00:00Z', to: '2026-09-28T05:20:00Z', gap: 20 });         // a booking 20 min away
await bracket('L7', 'u-a', '2026-09-28T05:00:00Z', '2026-09-28T05:20:00Z');
await seg({ plate: 'L8', from: '2026-09-28T01:10:00Z', to: '2026-09-28T01:40:00Z' });
await bracket('L8', 'u-a', '2026-09-28T01:10:00Z', '2026-09-28T01:40:00Z');
await T('L8-bolt', { driver: 'b-c', platform: 'bolt', plate: 'L8', at: '2026-09-25T10:00:00Z', pay: 'cash', price: 12 });   // this car also works Bolt
/* The operator, 2026-09-29: "keep 4 km minimum" — a bracketed 3 km trip is
   now held; and "we send to the last driver of the vehicle" — a driver named
   only by their last Uber trip on the car, two days earlier, is texted. */
await seg({ plate: 'L12', from: '2026-09-28T04:40:00Z', to: '2026-09-28T04:55:00Z', km: 3 });
await bracket('L12', 'u-y', '2026-09-28T04:40:00Z', '2026-09-28T04:55:00Z');
await seg({ plate: 'L13', from: '2026-09-28T03:20:00Z', to: '2026-09-28T03:50:00Z' });
await T('L13-last', { driver: 'u-d', plate: 'L13', at: '2026-09-26T03:00:00Z', pay: 'braintree', price: 20 });

/* Two people had the car that day and no booking names either: the
   evidence names two, and the record must say who they are. */
await seg({ plate: 'L14', from: '2026-09-28T05:10:00Z', to: '2026-09-28T05:40:00Z' });
for (const [dvr, nm] of [['u-a', 'Test Driver A'], ['u-d', 'Test Driver D']]) {
  await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, is_primary)
           VALUES ('L14', '2026-09-28', $1, 'uber', $2, 'ecosine', 1, false)`, [dvr, nm]);
}
/* A second car that works Bolt, held while Bolt is down, whose journey a
   Bolt booking will explain once Bolt delivers. */
await seg({ plate: 'L16', from: '2026-09-28T05:20:00Z', to: '2026-09-28T05:50:00Z' });
await bracket('L16', 'u-d', '2026-09-28T05:20:00Z', '2026-09-28T05:50:00Z');
await T('L16-bolt', { driver: 'b-c', platform: 'bolt', plate: 'L16', at: '2026-09-25T11:00:00Z', pay: 'cash', price: 12 });
const noon = new Date('2026-09-28T08:00:00Z');
const before = sent.length;
r = await tripRegisterRun({ q, now: noon, send, cfg: {} });
const byPlate = Object.fromEntries(r.decisions.map((d) => [d.plate, d]));
check('only journeys that ended after go-live are looked at', !byPlate.L5, Object.keys(byPlate).join(','));
const newTrips = sent.slice(before);
check('a bracketed, 12 km trip between two named places is texted, in the operator’s words',
  newTrips.some((m) => m.to === '971501111111'
    && m.text === 'Please Register your trip from Al Garhoud to Deira - 12 km with your supervisor - ADMIN.'),
  newTrips.map((m) => m.text).join(' | '));
check('a driver named only by their last Uber trip on the car, two days before: texted — the last driver of the vehicle',
  byPlate.L13?.tier === 'last_trip' && byPlate.L13?.hold === null && newTrips.some((m) => m.to === '971503333333'),
  JSON.stringify(byPlate.L13));
check('…and exactly those two are texted in this pass', newTrips.length === 2, String(newTrips.length));
check('…never saying "unauthorized"', newTrips.every((m) => !/unauthori[sz]ed/i.test(m.text)));
check('under 4 km: held — 1.2 km, and a bracketed 3 km trip', byPlate.L2?.hold === 'short' && byPlate.L12?.hold === 'short',
  JSON.stringify([byPlate.L2, byPlate.L12]));
check('nobody named on the car: held', byPlate.L3?.hold === 'driver_not_certain', JSON.stringify(byPlate.L3));
check('a street code for a place: held', byPlate.L4?.hold === 'places_unreadable', JSON.stringify(byPlate.L4));
check('a booking 20 minutes away: held (driving to a pickup)', byPlate.L7?.hold === 'near_booking', JSON.stringify(byPlate.L7));
check('a car that also works Bolt, when Bolt did not collect: held', byPlate.L8?.hold === 'booking_channel_down', JSON.stringify(byPlate.L8));
/* WHO THE EVIDENCE NAMES, ON A HELD ROW (2026-10-01: every held row read
   "nobody the evidence names" though 51 of 58 named one driver).
   REVERSION (run 2026-10-01): resolve the person only when nothing else
   held it, as before -> 67 passed, 1 FAILED (the first check); keep no
   candidates on the record -> 67 passed, 1 FAILED (the second). */
const heldWho = Object.fromEntries((await q(
  `SELECT plate, person_id, detail FROM sms_outbox WHERE kind = 'trip_register' AND status = 'held'`)).map((x) => [x.plate, x]));
check('a held journey still records the driver the evidence names: short (L2), near a booking (L7), a street code (L4), Bolt down (L8)',
  heldWho.L2?.person_id === 4 && heldWho.L7?.person_id === 1 && heldWho.L4?.person_id === 11 && heldWho.L8?.person_id === 1,
  JSON.stringify(['L2', 'L7', 'L4', 'L8'].map((k) => [k, heldWho[k]?.person_id])));
check('…and where it names two, both are on the record by name',
  byPlate.L14?.hold === 'driver_not_certain' && heldWho.L14?.person_id === null
  && JSON.stringify([...(heldWho.L14?.detail?.candidates || [])].sort()) === '["Test Driver A","Test Driver D"]',
  JSON.stringify([byPlate.L14, heldWho.L14]));
/* The rows filed BEFORE the driver was recorded: a filed journey is skipped
   on every later pass, so without nameHeldRows the rows on the operator's
   screen would read "nobody" for ever. Made here by wiping what the run
   just recorded, as the older code left it.
   REVERSION (run 2026-10-01): drop the nameHeldRows call -> 68 passed,
   2 FAILED (both checks below). */
await q(`UPDATE sms_outbox SET person_id = NULL, detail = detail - 'candidates' WHERE plate IN ('L2', 'L14')`);
const n1b = sent.length;
r = await tripRegisterRun({ q, now: new Date('2026-09-28T08:20:00Z'), send, cfg: {} });
const again = Object.fromEntries((await q(
  `SELECT plate, person_id, status, hold_reason, detail FROM sms_outbox WHERE plate IN ('L2', 'L14')`)).map((x) => [x.plate, x]));
check('a held row filed before the driver was recorded is named on the next pass — and only named: same hold, nothing sent',
  again.L2?.person_id === 4 && again.L2.status === 'held' && again.L2.hold_reason === 'short'
  && sent.length === n1b && r.named >= 1, JSON.stringify([again.L2, r.named, sent.length - n1b]));
check('…and one the evidence names two people on gets both names back',
  again.L14?.person_id === null && again.L14.hold_reason === 'driver_not_certain'
  && JSON.stringify([...(again.L14?.detail?.candidates || [])].sort()) === '["Test Driver A","Test Driver D"]',
  JSON.stringify(again.L14));

/* The same journey, reported again: the next pass deleted its window and
   re-inserted FMS's final record, three minutes off the provisional start. */
await q(`DELETE FROM occupancy_segment WHERE plate = 'L1'`);
await seg({ plate: 'L1', from: '2026-09-28T02:03:00Z', to: '2026-09-28T02:41:00Z' });
const n2 = sent.length;
r = await tripRegisterRun({ q, now: new Date('2026-09-28T08:30:00Z'), send, cfg: {} });
check('the same journey reported again is not a second message', sent.length === n2 && r.skipped >= 1, JSON.stringify({ skipped: r.skipped, sent: sent.length - n2 }));

/* At night: waits until 07:00, and is re-checked before it goes. */
await uberRan('2026-09-28T20:10:00Z');
await seg({ plate: 'L9', from: '2026-09-28T17:00:00Z', to: '2026-09-28T17:40:00Z' });
await bracket('L9', 'u-a', '2026-09-28T17:00:00Z', '2026-09-28T17:40:00Z');
await seg({ plate: 'L10', from: '2026-09-28T17:50:00Z', to: '2026-09-28T18:20:00Z' });
await bracket('L10', 'u-a', '2026-09-28T17:50:00Z', '2026-09-28T18:20:00Z');
const night = new Date('2026-09-28T20:30:00Z');       // 00:30 Dubai
const n3 = sent.length;
r = await tripRegisterRun({ q, now: night, send, cfg: {} });
const queued = await q(`SELECT plate, not_before FROM sms_outbox WHERE status = 'queued' ORDER BY plate`);
check('found at 00:30, a trip message waits — nothing is sent at night', sent.length === n3 && queued.length === 2, JSON.stringify(queued));
check('…until 07:00 Dubai', queued.every((m) => new Date(m.not_before).toISOString() === next7am(night).toISOString()
  && next7am(night).toISOString() === '2026-09-29T03:00:00.000Z'), JSON.stringify(queued));
await q(`UPDATE occupancy_segment SET verdict = 'authorized' WHERE plate = 'L10'`);   // a later pass found the booking
let f = await flushQueued({ q, now: new Date('2026-09-29T02:55:00Z'), send, cfg: {} });
check('not before 07:00', f.due === 0 && sent.length === n3);
f = await flushQueued({ q, now: new Date('2026-09-29T03:00:00Z'), send, cfg: {} });
const [l10] = await q(`SELECT status, hold_reason FROM sms_outbox WHERE plate = 'L10'`);
check('at 07:00 the one still unexplained is sent', f.sent === 1 && sent.length === n3 + 1 && /from Al Garhoud to Deira/.test(sent[sent.length - 1].text));
check('…and the one a later pass explained is held, not sent', l10.status === 'held' && l10.hold_reason === 'no_longer_unauthorized');
f = await flushQueued({ q, now: new Date('2026-09-29T03:05:00Z'), send, cfg: {} });
check('a flush later sends nothing twice', f.due === 0 && sent.length === n3 + 1);
r = await tripRegisterRun({ q, now: noon, send, cfg: { sms_trip: 'off' } });
check('switched off: no trip is looked at', r.off === true);
check('nothing texted anywhere says "unauthorized"', sent.every((m) => !/unauthori[sz]ed/i.test(m.text)));
check('every message went as transactional, never OTP or promotional', sent.every((m) => m.type === 'transactional'));

/* ── 3b. Bolt collects again ──────────────────────────────────────────────
   The operator, 2026-10-01: "if and when bolt collects, and the trip is
   verified as unauthorized do let those drivers know."
   REVERSION (run 2026-10-01): skip recheckChannelDown -> 66 passed,
   2 FAILED (the release and the explained check); drop the "judged again
   since" test -> 65 passed, 3 FAILED — and the journey the new Bolt booking
   explains is TEXTED, which is the whole reason for the test. */
console.log('\n3b. a channel that collects again');
const atNine = new Date('2026-09-29T05:00:00Z');            // 09:00 Dubai
let n4 = sent.length;
r = await tripRegisterRun({ q, now: atNine, send, cfg: {} });
check('while Bolt has still not delivered the day, the held journey stays held', sent.length === n4
  && (await q(`SELECT status FROM sms_outbox WHERE plate = 'L8'`))[0].status === 'held');
await run({ source: 'bolt', at: '2026-09-29T01:00:00Z', to: '2026-09-29' });         // Bolt delivers the 28th
await q(`UPDATE occupancy_segment SET ingested_at = '2026-09-28T07:00:00Z' WHERE plate IN ('L8', 'L16')`);
r = await tripRegisterRun({ q, now: atNine, send, cfg: {} });
check('not before the journey has been judged again on the new data', sent.length === n4
  && (await q(`SELECT status FROM sms_outbox WHERE plate = 'L8'`))[0].status === 'held', JSON.stringify(r));
/* The reconcile re-judges the window: L8 still unexplained; L16 explained
   by the Bolt booking that arrived. */
await q(`UPDATE occupancy_segment SET ingested_at = '2026-09-29T01:10:00Z' WHERE plate IN ('L8', 'L16')`);
await q(`UPDATE occupancy_segment SET verdict = 'authorized' WHERE plate = 'L16'`);
r = await tripRegisterRun({ q, now: atNine, send, cfg: {} });
const late = sent.slice(n4);
const [l8] = await q(`SELECT status, hold_reason, message_text FROM sms_outbox WHERE plate = 'L8'`);
const [l16] = await q(`SELECT status, hold_reason FROM sms_outbox WHERE plate = 'L16'`);
check('Bolt delivered and the journey is still unexplained: the driver is texted, the day named',
  l8.status === 'sent' && late.length === 1 && late[0].to === '971501111111'
  && late[0].text === 'Please Register your trip on 28 Sep from Al Garhoud to Deira - 12 km with your supervisor - ADMIN.'
  && r.released === 1 && r.late_sent === 1 && r.late_failed === 0, JSON.stringify([l8, late, r.released, r.late_sent]));
check('…and one the new Bolt data explains is not texted, and says why', l16.status === 'held' && l16.hold_reason === 'no_longer_unauthorized'
  && r.explained === 1, JSON.stringify(l16));
n4 = sent.length;
r = await tripRegisterRun({ q, now: new Date('2026-09-29T05:30:00Z'), send, cfg: {} });
check('…and nothing is texted twice', sent.length === n4);

/* A journey five days back, held while Bolt was down. Only the nightly
   30-day catch-up fetches — and re-judges — that day; the half-hourly run
   covers the last 3 days. A later half-hourly run must not count as "the
   data since which it has to be judged again", or it never is.
   REVERSION (run 2026-10-01): count any run whose window merely reaches the
   day (window_end only) -> 70 passed, 1 FAILED (this check) — held for good. */
await seg({ plate: 'L17', from: '2026-09-24T02:00:00Z', to: '2026-09-24T02:40:00Z' });
await bracket('L17', 'u-b', '2026-09-24T02:00:00Z', '2026-09-24T02:40:00Z');
await T('L17-bolt', { driver: 'b-c', platform: 'bolt', plate: 'L17', at: '2026-09-20T10:00:00Z', pay: 'cash', price: 12 });
await q(`INSERT INTO sms_outbox (kind, dedupe_key, fleet_id, status, hold_reason, plate, trip_start, trip_end, business_day, detail)
         VALUES ('trip_register', 'trip:L17:2026-09-24T02:00:00.000Z', 'ecosine', 'held', 'booking_channel_down', 'L17',
                 '2026-09-24T02:00:00Z', '2026-09-24T02:40:00Z', '2026-09-24', '{}'::jsonb)`);
await run({ source: 'bolt', mode: 'catchup', from: '2026-08-30', to: '2026-09-29', at: '2026-09-29T21:20:00Z' });
await q(`UPDATE occupancy_segment SET ingested_at = '2026-09-29T21:25:00Z' WHERE plate = 'L17'`);   // its reconcile
await run({ source: 'bolt', from: '2026-09-26', to: '2026-09-30', at: '2026-09-29T21:31:00Z' });
await run({ source: 'uber', from: '2026-09-26', to: '2026-09-30', at: '2026-09-29T21:31:00Z' });
n4 = sent.length;
r = await tripRegisterRun({ q, now: new Date('2026-09-30T05:00:00Z'), send, cfg: {} });
const [l17] = await q(`SELECT status, hold_reason, person_id FROM sms_outbox WHERE plate = 'L17'`);
check('a journey 5 days back is released once the catch-up that covers its day has re-judged it — later 3-day runs do not hold it',
  l17.status === 'sent' && sent.length === n4 + 1 && sent[n4].to === '971502222222'
  && sent[n4].text === 'Please Register your trip on 24 Sep from Al Garhoud to Deira - 12 km with your supervisor - ADMIN.',
  JSON.stringify([l17, sent.slice(n4), r.rechecked, r.released]));

/* ── 4. the Messages page's two answers ─────────────────────────────────── */
console.log('\n4. what the page is told');
const app = express();
app.use((req, _res, next) => {
  req.fm = req.headers['x-as'] === 'user' ? { kind: 'user', user: { id: 1 } } : { kind: 'anonymous', mode: 'open' };
  next();
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
smsRoutes(app, { q, wrap, access: { getConfig: async () => ({ sms_cash: 'on', sms_trip: 'off' }) } });
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
const get = async (path, as) => { const x = await fetch(B + path, { headers: as ? { 'x-as': as } : {} }); return { status: x.status, cc: x.headers.get('cache-control'), body: await x.json() }; };
let g = await get('/api/sms/log');
check('not signed in, even in open mode: refused, and nothing about a driver', g.status === 401 && !g.body.rows && /Sign in/.test(g.body.detail));
g = await get('/api/sms/preview?kind=cash');
check('the preview is refused the same way', g.status === 401);
g = await get('/api/sms/log', 'user');
const held = g.body.rows.find((x) => x.hold_reason === 'channel_not_collected');
check('signed in: every decision, newest first, never cached', g.status === 200 && g.body.rows.length > 10 && /no-store/.test(g.cc));
check('a held message carries its reason in words', held?.why === HOLD_WHY.channel_not_collected && held.person_name === 'Test Driver C');
check('the gateway id stays text, not a rounded number', g.body.rows.filter((x) => x.status === 'sent').every((x) => x.provider_message_id === undefined || typeof x.provider_message_id === 'string'));
check('the switches are what Settings holds', g.body.switches.sms_cash === 'on' && g.body.switches.sms_trip === 'off');
g = await get('/api/sms/log?kind=trip_register&status=held', 'user');
check('filtered by kind and status', g.body.rows.length > 0 && g.body.rows.every((x) => x.kind === 'trip_register' && x.status === 'held'));
const [{ n: before_ }] = await q(`SELECT count(*)::int AS n FROM sms_outbox`);
g = await get('/api/sms/preview?kind=trip', 'user');
const [{ n: after_ }] = await q(`SELECT count(*)::int AS n FROM sms_outbox`);
check('the preview decides and writes nothing', g.status === 200 && before_ === after_ && /nothing sent/.test(g.body.note));
server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
