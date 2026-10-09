/* The assistant's parts, one at a time: its calendar, its name matching, its
   guard and its model fallback. Synthetic data throughout; the clock is fixed
   at Friday 9 October 2026, 10:00 in Dubai.

   Proved by revert, 2026-10-09:
     · resolvePeriod's "last week" case removed (falls to the weekday rule):
       2 fail.
     · the one-word carrier rule removed from findDriver: "Shehzad"-style
       first names are offered as one man — 1 fails.
     · callModel's 401 short-circuit removed: a refused key is retried on the
       fallback model — 1 fails. */
import { resolvePeriod, shiftRange } from '../api/agent_period.js';
import { findDriver, findCar, normName } from '../api/agent_people.js';
import { checkReply, formatValue, plainAnswer } from '../api/agent_guard.js';
import { callModel } from '../api/agent_model.js';
import { forModel, labelOf } from '../api/agent_tools.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const NOW = Date.parse('2026-10-09T10:00:00+04:00');

console.log('\nthe calendar');
const P = (t) => resolvePeriod(t, NOW);
const span = (t) => { const r = P(t); return r.ok ? `${r.from}..${r.to}` : `NO: ${r.why}`; };
for (const [t, want] of [
  ['today', '2026-10-09..2026-10-09'], ['yesterday', '2026-10-08..2026-10-08'],
  ['last week', '2026-09-28..2026-10-04'], ['this week', '2026-10-05..2026-10-09'],
  ['last 7 days', '2026-10-03..2026-10-09'], ['this month', '2026-10-01..2026-10-09'],
  ['last month', '2026-09-01..2026-09-30'], ['September', '2026-09-01..2026-09-30'],
  ['December', '2025-12-01..2025-12-31'], ['q3', '2026-07-01..2026-09-30'],
  ['1-7 oct', '2026-10-01..2026-10-07'], ['1/10', '2026-10-01..2026-10-01'],
  ['thursday 1 october 2026', '2026-10-01..2026-10-01'], ['a week ago', '2026-10-02..2026-10-02'],
  ['monday', '2026-10-05..2026-10-05'], ['weekend', '2026-10-03..2026-10-04'],
  ['since 1 sep', '2026-09-01..2026-10-09'], ['week of 28 sep', '2026-09-28..2026-10-04'],
]) check(`"${t}" is ${want}`, span(t) === want, span(t));
check('"last week" says which reading it took', /Monday-to-Sunday/.test(P('last week').assumption || ''));
check('a month with no year is the most recent one, and says so', /December 2025/.test(P('December').assumption || ''));
check('"1/10" says it read the day first', /day first/.test(P('1/10').assumption || ''));
check('anything containing today says it is still running', P('this month').partial && /still running/.test(P('this month').assumption || ''));
check('the future is refused as the future, not as unreadable', P('next week').ok === false && P('next week').future === true);
check('an unreadable time is refused, with readings to offer', P('the other time').ok === false && (P('the other time').options || []).length > 3);
const sh = (f, t, by) => { const r = shiftRange(f, t, by, -1, NOW); return `${r.from}..${r.to}`; };
check('the same day last week', sh('2026-10-08', '2026-10-08', 'week') === '2026-10-01..2026-10-01');
check('the same days last month', sh('2026-10-01', '2026-10-09', 'month') === '2026-09-01..2026-09-09');
check('a whole month moves to the whole month before', sh('2026-09-01', '2026-09-30', 'month') === '2026-08-01..2026-08-31');
check('the period just before is the same length', sh('2026-09-28', '2026-10-04', 'period') === '2026-09-21..2026-09-27');
check('the same dates last year', sh('2026-10-01', '2026-10-09', 'year') === '2025-10-01..2025-10-09');

console.log('\nnames and plates');
check('one name, many spellings', normName('Mohammed Ahmed') === 'muhammad ahmad' && normName('Md. Hussein') === 'muhammad hussain'
  && normName('Abdul Rahman') === normName('Abdulrahman'));
const ROWS = [
  { driver_ext_id: 'a1', driver_name: 'Test Khalid Alpha', ids: ['a1'], platforms: ['uber'], plate: 'L10001', lifetime_trips: 900 },
  { driver_ext_id: 'a2', driver_name: 'Test Khalid Alpha Beta', ids: ['a2'], platforms: ['bolt'], plate: 'L10002', lifetime_trips: 40 },
  { driver_ext_id: 'a3', driver_name: 'Samir Gamma Delta', ids: ['a3'], platforms: ['uber'], plate: 'L10003', lifetime_trips: 300 },
  { driver_ext_id: 'a4', driver_name: 'Shehzad Epsilon', ids: ['a4'], platforms: ['uber'], plate: 'L10004', lifetime_trips: 50 },
  { driver_ext_id: 'a5', driver_name: 'Omar Shahzad Zeta', ids: ['a5'], platforms: ['bolt'], plate: 'L10005', lifetime_trips: 60 },
];
check('a first name two people carry is a question', findDriver('Khalid', ROWS).verdict === 'ambiguous');
check('…including two spellings of one first name', findDriver('Shehzad', ROWS).verdict === 'ambiguous',
  JSON.stringify(findDriver('Shehzad', ROWS).candidates.map((c) => [c.name, c.score])));
check('a full name is one person', findDriver('Samir Gamma Delta', ROWS).verdict === 'exact');
check('a typo still finds them, as "likely"', ['likely', 'exact'].includes(findDriver('Samir Gama Delta', ROWS).verdict)
  && findDriver('Samir Gama Delta', ROWS).candidates[0].driver_id === 'a3');
check('nobody close is "none"', findDriver('Quentin Xylophone', ROWS).verdict === 'none');
check('a plate as typed', findCar('l 10003', [{ plate: 'L10003' }, { plate: 'L10004' }]).verdict === 'exact'
  && findCar('10004', [{ plate: 'L10003' }, { plate: 'L10004' }]).candidates[0].plate === 'L10004');

console.log('\nthe guard');
const R = new Map([
  ['r1', { id: 'r1', kind: 'value', definition: 'Fleet totals · every platform · both fleets · Thu 8 Oct 2026', filters: { platform: null, fleet: null },
    values: { completed_trips: 1005, gross_fares_aed: 65981.74, completion_pct: 87.2 }, kinds: { completed_trips: 'int', gross_fares_aed: 'aed', completion_pct: 'pct' } }],
  ['r2', { id: 'r2', kind: 'table', definition: 'Trips · Test Driver · Bolt', filters: { platform: 'bolt', driver: 'Test Driver' },
    values: { completed: 12 }, kinds: { completed: 'int' }, columns: [{ key: 'fare_aed', kind: 'aed' }], rows: [{ fare_aed: 31.5 }] }],
]);
const g = (t, o) => checkReply(t, R, o);
check('placeholders are filled the way the pages format', g('{{r1.completed_trips}} trips, {{r1.gross_fares_aed}}, {{r1.completion_pct}}.').text
  === '1,005 trips, AED 65,981.74, 87.2%.');
check('a unit the model repeats is absorbed', g('AED {{r1.gross_fares_aed}} and {{r1.completion_pct}}%.').text === 'AED 65,981.74 and 87.2%.');
check('a cell of a row can be cited', g('The fare was {{r2.rows[0].fare_aed}}.').text === 'The fare was AED 31.50.');
check('a number the model typed is refused', !g('They completed 1,234 trips.').ok && /1234/.test(g('They completed 1,234 trips.').problems[0]));
check('…but one that is in a result is not', g('They completed 1,005 trips.').ok);
check('…nor one the person typed', g('Here are the top 7.', { userTexts: ['top 7 drivers please'] }).ok);
check('"on Bolt" over an every-platform figure is refused', !g('On Bolt they completed {{r1.completed_trips}}.').ok);
check('"on Bolt" over a Bolt figure is fine', g('On Bolt he completed {{r2.completed}}.').ok);
check('"Egari" over a both-fleets figure is refused', !g('Egari completed {{r1.completed_trips}}.').ok);
check('an unknown figure is refused', !g('{{r1.nothing}}').ok && !g('{{r9.completed_trips}}').ok);
check('stray braces are refused and never shown', !g('It was {{total}}.').ok && !g('It was {{total}}.').text.includes('{{'));
check('a negative is a minus sign, money with its unit', formatValue(-46323.98, 'aed') === '−AED 46,323.98' && formatValue(2.5, 'pts') === '+2.5 pts');
check('the plain answer lists what was measured', /exactly as measured/.test(plainAnswer([...R.values()], 'x').text));

console.log('\nwhat the model is shown');
const big = { id: 'r5', definition: 'd', columns: [{ key: 'a', kind: 'int' }], rows: Array.from({ length: 40 }, (_, i) => ({ a: i })), values: { rows: 40 } };
const fm = forModel(big);
check('a dozen rows of forty, and a pointer to the rest', fm.rows.length === 12 && fm.row_count === 40 && /summarise/.test(fm.rows_note));
check('a withheld result is a sentence, not a figure', forModel({ id: 'r6', definition: 'd', withheld: 'Not shown to your role.' }).withheld && !forModel({ id: 'r6', definition: 'd', withheld: 'x' }).values);
check('figure names read as words', labelOf('gross_fares_aed') === 'Gross fares (AED)' && labelOf('completion_pct') === 'Completion %');

console.log('\nthe model, and when it is not there');
const reply = (status, body) => ({ status, json: async () => body });
const ok = (m) => reply(200, { choices: [{ message: { content: `from ${m}` } }] });
const cfg = { baseUrl: 'http://m', apiKey: 'k', model: 'pro', fallback: 'lite' };
{
  const asked = [];
  const http = async (url, o) => { const m = JSON.parse(o.body).model; asked.push(m); return asked.length < 3 ? reply(500, {}) : ok(m); };
  const r = await callModel({ messages: [], cfg, http });
  check('Pro twice, then Lite — and the answer says it was Lite', JSON.stringify(asked) === '["pro","pro","lite"]' && r.fallback && r.model === 'lite');
}
{
  const asked = [];
  const http = async (url, o) => { asked.push(JSON.parse(o.body).model); return reply(401, {}); };
  let err = null;
  try { await callModel({ messages: [], cfg, http }); } catch (e) { err = e; }
  check('a refused key is not retried on the other model — both use it', err?.code === 'key' && asked.length === 1, JSON.stringify(asked));
}
{
  let err = null;
  try { await callModel({ messages: [], cfg: { ...cfg, apiKey: '' }, http: async () => ok('x') }); } catch (e) { err = e; }
  check('no key is said as no key', err?.code === 'no_key');
}
{
  const http = async () => reply(503, {});
  let err = null;
  try { await callModel({ messages: [], cfg, http }); } catch (e) { err = e; }
  check('nobody answering is "unreachable"', err?.code === 'unreachable');
}
{
  let sent = null;
  const http = async (url, o) => { sent = JSON.parse(o.body); return ok('pro'); };
  await callModel({ messages: [], cfg, http });
  check('thinking is off and the temperature low', sent.thinking?.type === 'disabled' && sent.temperature <= 0.2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
