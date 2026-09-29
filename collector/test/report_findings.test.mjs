/* WHAT THE DAILY REPORT FINDS, AND WHAT GLM 5.2 MAY SAY ABOUT IT.
   ═══════════════════════════════════════════════════════════════════════════
   src/report_findings.js measures; src/daily_report.js analyse() lets GLM 5.2
   rank and phrase the actions and holds it to what was measured — each
   action to its own finding's numbers and people. GLM sees names and plates
   (the operator, 2026-09-29). Against a
   real schema (PGlite) with four weeks of synthetic Mondays; a fake model.

   D = Monday 2026-09-28; the prior Mondays are 21, 14, 7 September and 31
   August. Every case below is built to trip exactly one finding.

   REVERSIONS, run 2026-09-29, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

process.env.REPORT_MODEL_API_KEY = 'model-key-under-test';
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);
const { reportFindings, findingsForModel } = await import('../src/report_findings.js');
const { analyse, renderEmail, reportFacts } = await import('../src/daily_report.js');

let n = 0;
/* A Dubai wall-clock time on a day, as the UTC instant trip.requested_at holds. */
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+04:00`).toISOString();
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, 'ecosine', $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '20 minutes', $7, $8, $9, 'AED', '{}'::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.driver, o.name, o.plate || 'P0', o.at, o.status || 'completed', o.pay || 'card', o.price ?? 40]);
const D = '2026-09-28';
const PRIOR = ['2026-09-21', '2026-09-14', '2026-09-07', '2026-08-31'];

for (const d of PRIOR) {
  /* The bulk of a Monday: 20 evening Uber bookings. */
  for (let i = 0; i < 20; i++) await T({ driver: 'u-m', name: 'Test Driver M', plate: 'PM', at: at(d, `${18 + (i % 3)}:${String(10 + i).padStart(2, '0')}`) });
  /* R earns 400 on a usual Monday; S 150. */
  for (let i = 0; i < 4; i++) await T({ driver: 'u-r', name: 'Test Driver R', plate: 'PR', at: at(d, `0${9 + (i % 1)}:${10 + i}`), price: 100 });
  for (let i = 0; i < 3; i++) await T({ driver: 'u-s', name: 'Test Driver S', plate: 'PS', at: at(d, `11:${10 + i}`), price: 50 });
  /* Bolt completes 9 of 10 on a usual Monday. */
  for (let i = 0; i < 10; i++) await T({ platform: 'bolt', driver: 'b-x', name: 'Test Driver X', plate: 'PX', at: at(d, `13:${10 + i}`), status: i < 9 ? 'completed' : 'cancelled' });
}
/* Yesterday. */
for (let i = 0; i < 5; i++) await T({ driver: 'u-m', name: 'Test Driver M', plate: 'PM', at: at(D, `18:${10 + i}`) });
await T({ driver: 'u-r', name: 'Test Driver R', plate: 'PR', at: at(D, '09:10'), price: 100 });       // down: 100 against 400
for (let i = 0; i < 6; i++) await T({ driver: 'u-n', name: 'Test Driver N', plate: 'PN', at: at(D, `10:${10 + i}`), status: i < 3 ? 'completed' : 'cancelled' });
for (let i = 0; i < 10; i++) await T({ platform: 'bolt', driver: 'b-x', name: 'Test Driver X', plate: 'PX', at: at(D, `13:${10 + i}`), status: i < 4 ? 'completed' : 'cancelled' });
await T({ driver: 'u-h', name: 'Test Driver H', plate: 'PH', at: at(D, '15:00'), price: 50 });
/* A car idle three days: its last booking was on the 25th. */
await T({ driver: 'u-i', name: 'Test Driver I', plate: 'P-IDLE', at: at('2026-09-25', '12:00') });
/* Cash: C took seven cash trips of 100 in the week and handed in 100. */
await q(`INSERT INTO driver (id, full_name, fleet_id) VALUES (1, 'Test Driver C', 'ecosine'), (2, 'Test Driver T', 'ecosine')`);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, basis) VALUES ('uber', 'u-c', 1, 'human')`);
for (let i = 0; i < 7; i++) await T({ driver: 'u-c', name: 'Test Driver C', plate: 'PC', at: at(`2026-09-2${2 + i}`, '08:00'), pay: 'cash', price: 100 });
await q(`INSERT INTO driver_ledger (person_id, person_name, resolved_from, type_code, direction, book, amount, effective_on, entered_by, note)
         VALUES (1, 'Test Driver C', 'human:test', 'cash_deposit', -1, 'cash', -100, '2026-09-27', 'test', 'n')`);
/* Uber online time: H online 10 h for AED 50; M and R set the fleet's rate. */
const DD = (id, min) => q(`INSERT INTO driver_day (driver_ext_id, day, fleet_id, trips, completed, online_min)
                           VALUES ($1, $2, 'ecosine', 1, 1, $3)`, [id, D, min]);
await DD('u-h', 600); await DD('u-m', 300); await DD('u-r', 120);
/* Unregistered journeys the 07:00 check found for T. */
for (const [k, km] of [['a', 6], ['b', 8]]) {
  await q(`INSERT INTO sms_outbox (kind, dedupe_key, person_id, status, plate, trip_start, trip_end, business_day, detail)
           VALUES ('trip_register', $1, 2, 'sent', 'PT', $2::timestamptz, $2::timestamptz + interval '15 minutes', $3, $4::jsonb)`,
  [`trip:${k}`, at(D, k === 'a' ? '14:00' : '16:00'), D, j({ km })]);
}
/* Safety: three alerts on one car. */
for (let i = 0; i < 3; i++) {
  await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at) VALUES ('fms', $1, 'ecosine', 'PX', 'harsh_braking', $2)`,
    [`al${i}`, at(D, `13:1${i}`)]);
}

console.log('\n1. what is found');
const facts = { ...(await reportFacts(q, D)), collection: { missing: [{ platform: 'bolt', fleet: 'egari' }], delivered: 3 } };
const r = await reportFindings(q, D, { facts });
const kind = (k) => r.findings.find((f) => f.kind === k);
const bookings = r.compare.find((c) => c.key === 'bookings');
/* REVERSION, run 2026-09-29: last_week taken from yesterday itself -> 26
   passed, 1 FAILED: "yesterday against last Monday and the usual of four". */
/* 24: the five kinds of Monday booking above, and one of C's week of cash
   trips, which falls on the Monday itself. */
check('yesterday against last Monday and the usual of four', bookings.today === 24 && bookings.last_week === 37
  && bookings.usual === 37 && bookings.unusual, j(bookings));
check('every measure the operator asked for carries last week\u2019s figure and the usual range',
  ['bookings', 'completed', 'fares', 'active_cars', 'earning_cars', 'earning_drivers', 'cash_trips', 'cash']
    .every((k) => { const c = r.compare.find((x) => x.key === k); return c && c.last_week != null && c.low != null; }), j(r.compare.map((c) => c.key)));
check('an unusual day is a finding for the manager', kind('demand')?.owner === 'Manager', j(kind('demand')));
/* REVERSION, run 2026-09-29: the channel's usual taken from yesterday ->
   "Bolt's completion fell…" FAILS, and the analysis group cannot run
   without that finding (the test stops with a TypeError). */
check('Bolt’s completion fell, with the drivers behind it',
  kind('channel')?.numbers.completion_pct === 40 && kind('channel')?.numbers.usual_completion_pct === 90
  && kind('channel')?.items[0]?.name === 'Test Driver X', j(kind('channel')));
check('the 3-hour window that lost most is named', kind('hours')?.numbers.window_start_hour === 18
  && kind('hours')?.numbers.bookings === 5 && kind('hours')?.numbers.usual === 20, j(kind('hours')));
/* REVERSION, run 2026-09-29: drivers compared with the fleet's median
   instead of their own usual -> "a regular down against their own usual"
   FAILS, and the analysis group then stops (no such finding to act on). */
check('a regular down against their own usual', kind('driver_down')?.items.some((i) => i.name === 'Test Driver R' && i.fares === 100 && i.usual === 400),
  j(kind('driver_down')));
check('a regular who did not drive', kind('driver_absent')?.items.some((i) => i.name === 'Test Driver S' && i.weeks_of_4 === 4), j(kind('driver_absent')));
check('a driver with half their bookings uncompleted', kind('noncomplete')?.items.some((i) => i.name === 'Test Driver N' && i.completed === 3 && i.bookings === 6),
  j(kind('noncomplete')));
check('a car idle three days, with its last driver', kind('cars_idle')?.items.some((i) => i.plate === 'P-IDLE' && i.idle_days === 3
  && i.last_driver === 'Test Driver I'), j(kind('cars_idle')));
check('long hours online on Uber for little', kind('hourly')?.items.some((i) => i.name === 'Test Driver H' && i.online_hours === 10 && i.aed_per_hour === 5),
  j(kind('hourly')));
/* REVERSION, run 2026-09-29: hand-ins left out of assembleCash -> 26 passed,
   1 FAILED: "cash to hand in is…" (700 against 600). */
check('cash to hand in is cash taken less the hand-in recorded, the workbook’s rule',
  kind('cash')?.items.some((i) => i.name === 'Test Driver C' && i.to_hand_in === 600 && i.last_hand_in === '2026-09-27')
  && kind('cash')?.numbers.hand_ins_recorded === 1, j(kind('cash')));
check('unregistered journeys, per driver', kind('unregistered')?.items.some((i) => i.name === 'Test Driver T' && i.journeys === 2 && i.km === 14),
  j(kind('unregistered')));
check('a car with three alerts', kind('safety')?.items.some((i) => i.plate === 'PX' && i.alerts === 3), j(kind('safety')));
check('a channel that did not deliver is a finding for the admin', kind('data')?.owner === 'Admin');
check('the most severe come first', r.findings.every((f, i, a) => i === 0 || a[i - 1].severity >= f.severity));

console.log('\n2. what the model is shown');
const shown = j(findingsForModel(r));
/* The operator, 2026-09-29: "GLM 5.2 always sees a person". */
check('the model sees drivers by name and cars by plate', /Test Driver R/.test(shown) && /P-IDLE/.test(shown), shown.slice(0, 160));
check('…not the internal refs, which mean nothing to it', !/"ref":/.test(shown));

console.log('\n3. what it may say');
const R = kind('driver_down'); const tokenR = 'Test Driver R';
const X = kind('channel'); const tokenX = X.items[0].name;
let reply;
const fake = async () => ({ status: 200, data: { choices: [{ message: { content: typeof reply === 'string' ? reply : j(reply) } }] } });
reply = { summary: 'Bookings fell to 24 against 37 last Monday, with Bolt completing 4 of 10.',
  actions: [{ finding: X.id, owner: 'Supervisors', action: `Ask ${tokenX} why 6 Bolt bookings did not complete.` },
    { finding: R.id, owner: 'Supervisors', action: `Call ${tokenR}: AED 100 against a usual AED 400.` }] };
const a1 = await analyse(facts, r, { http: fake });
check('the model’s summary and actions are kept, with the names it wrote',
  a1.outcome === 'ok' && a1.actions[0].text === 'Ask Test Driver X why 6 Bolt bookings did not complete.'
  && a1.actions[1].text.startsWith('Call Test Driver R'), j(a1.actions.slice(0, 2)));
check('a finding the model left out keeps its own action after the model’s', a1.actions.some((x) => x.by === 'rule'));
/* REVERSION, run 2026-09-29: the number guard skipped for actions -> 26
   passed, 1 FAILED: "an action with a number not in the findings…". */
reply = { summary: 'Bookings fell.', actions: [{ finding: R.id, owner: 'Supervisors', action: `Call ${tokenR}: down 75% on AED 900.` }] };
const a2 = await analyse(facts, r, { http: fake });
check('an action with a number not in the findings throws the whole reply out for the findings’ own',
  a2.outcome === 'dropped' && a2.actions.every((x) => x.by === 'rule') && /900|75/.test(a2.why), j(a2.why));
/* A driver who is in another finding, named in this one's action.
   REVERSION, run 2026-09-29: the own-name check removed -> 27 passed,
   1 FAILED: this check. */
reply = { summary: 'Bookings fell.', actions: [{ finding: R.id, owner: 'Supervisors', action: `Call ${tokenX}.` }] };
const a3 = await analyse(facts, r, { http: fake });
check('a driver from another finding named in this one’s action is refused', a3.outcome === 'dropped'
  && /test driver x/i.test(a3.why), j(a3.why));
/* 600 is a real number — driver C's cash to hand in — but not the idle
   cars' or the day's figures'.
   REVERSION, run 2026-09-29: actions checked against every finding's
   numbers instead of their own -> 27 passed, 1 FAILED: this check. */
const idleF = kind('cars_idle');
const idleTok = idleF.items[0].plate;
reply = { summary: 'Bookings fell.', actions: [{ finding: idleF.id, owner: 'Fleet', action: `Put a driver in ${idleTok}, idle 600 days.` }] };
const a6 = await analyse(facts, r, { http: fake });
check('an action may use only its own finding\u2019s numbers — not one from another finding', a6.outcome === 'dropped', j(a6.why));
reply = 'not json at all';
const a4 = await analyse(facts, r, { http: fake });
check('an answer that is not the agreed JSON falls back to the findings', a4.outcome === 'dropped' && a4.actions.length > 0);
const a5 = await analyse(facts, r, { http: async () => { throw new Error('socket hang up'); } });
check('a model that cannot be reached leaves the actions intact', a5.outcome === 'failed' && a5.actions.length === Math.min(8, r.findings.length));

console.log('\n4. the email');
const { html } = renderEmail(facts, a1, { report: r });
check('it leads with what to do, then what changed', html.indexOf('Do today') > 0 && html.indexOf('Do today') < html.indexOf('What changed')
  && html.indexOf('What changed') < html.indexOf('Revenue — fares'));
check('each action carries its evidence, by name', html.includes('Test Driver R — AED 100.00 against a usual AED 400.00'));
check('the unusual row says so in words', /Bookings&nbsp;<span[^>]*>● unusual/.test(html));
check('the cash action says how many hand-ins were recorded', /1 hand-in is recorded in those days/.test(html)
  || !html.includes('Collect cash'), '');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
