/* The assistant reads only what the person asking may read.
   ──────────────────────────────────────────────────────────────────────────
   The whole of the assistant's access story is one property: every tool is a
   GET to the dashboard's own route, over the loopback, carrying the asker's
   own session cookie — so the access layer judges it exactly as it judges
   the page. This file runs the REAL gate (api/access/middleware.js, the real
   route manifest) in front of every route, with real people in real roles,
   and a scripted model asking for cash:

     · a Finance manager gets the cash figures;
     · a Dispatcher, whose role holds no cash, gets the refusal the Money page
       would give them — stored on the result, passed to the model, and shown
       under the answer — never a zero;
     · an Operations manager whose access covers Egari only gets Egari's
       totals, LABELLED Egari, not "both fleets" (the gate narrows the call
       either way; the label has to follow);
     · with sign-in required, a visitor gets nothing from the assistant at all;
     · nobody can open another person's conversation.

   Proved by revert, 2026-10-09:
     · fetchApi in api/agent_routes.js forwarding no cookie: the loopback call
       is then anonymous, and while sign-in is optional an anonymous call is
       served everything — the Dispatcher is handed the cash figures and the
       Egari-only manager both fleets' totals — 3 of 12 fail. Forwarding the
       asker's own cookie IS the access control; this is the test that says so.
     · fixedFleet ignored in api/agent_tools.js: the Egari manager's drivers
       come back labelled "both fleets" — 1 fails. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { accessLayer } from '../api/access/middleware.js';
import * as svc from '../api/access/service.js';
import { hashPassword } from '../api/access/crypto.js';
import { agentTest } from '../api/agent_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const db = { query: (t, p) => pg.query(t, p) };
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let tn = 0;
for (const [fleet, n] of [['ecosine', 3], ['egari', 2]]) {
  for (let i = 0; i < n; i += 1) {
    await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km, payment_type)
             VALUES ('uber',$1,$2,'L1000${i}',$3,$4,'2026-10-01T10:00:00+04:00','2026-10-01T10:20:00+04:00','completed',20,5,'cash')`,
    [`t${++tn}`, fleet, `drv-${fleet}-${i}`, `Driver ${fleet} ${i}`]);
  }
}

const layer = accessLayer({ db });
const { port } = await mountAll(pg, { pre: (app) => { app.use(layer.identify); app.use(layer.gate); } });
const base = `http://127.0.0.1:${port}`;
agentTest.now = () => Date.parse('2026-10-09T10:00:00+04:00');

const cfg = await svc.getConfig(db, { fresh: true });
async function person(email, role, fleets = null) {
  const u = await svc.createUser(db, { email, name: `Test ${role}`, status: 'active', passwordHash: hashPassword('a long enough test password') });
  await svc.createGrant(db, { userId: u.id, roleCode: role, fleets, reason: 'test' });
  const s = await svc.createSession(db, { userId: u.id, mfaOk: true, cfg });
  return { cookie: `fm_sid=${s.token}; fm_csrf=testcsrf`, id: u.id };
}
const FIN = await person('fin@example.test', 'FIN');
const DSP = await person('dsp@example.test', 'DSP');
const OPS = await person('ops-egari@example.test', 'OPS', ['egari']);

let script = [];
agentTest.model = async () => {
  const s = script.shift();
  if (!s) throw Object.assign(new Error('script ran out'), { code: 'unreachable' });
  return s;
};
let n = 0;
const tool = (name, args) => ({ model: 'm', fallback: false,
  message: { content: '', tool_calls: [{ id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
const say = (text) => ({ model: 'm', fallback: false, message: { content: text } });
async function chat(who, message) {
  const r = await fetch(`${base}/api/agent/chat`, { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: who?.cookie || '', ...(who ? { 'x-fm-csrf': 'testcsrf' } : {}) },
    body: JSON.stringify({ message }) });
  const text = await r.text();
  let events = [];
  try { events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { events = [{ raw: text }]; }
  return { status: r.status, last: events[events.length - 1] };
}
const stored = async (who, rid) => {
  const owner = `u:${who.id}`;
  const [row] = await q(`SELECT r.body FROM agent_result r JOIN agent_conversation c ON c.id = r.conversation_id
                          WHERE c.owner = $1 AND r.rid = $2`, [owner, rid]);
  return row ? (typeof row.body === 'string' ? JSON.parse(row.body) : row.body) : null;
};

console.log('\n1. cash, asked by a Finance manager and by a Dispatcher');
script = [tool('cash_trips', { from: '2026-10-01', to: '2026-10-07' }), say('There were {{r1.cash_trips}} cash trips.')];
const fin = await chat(FIN, 'How many cash trips this week?');
const finR = await stored(FIN, 'r1');
check('the Finance manager gets the cash figures', fin.last?.type === 'answer' && finR && !finR.withheld && finR.values?.cash_trips === 5,
  JSON.stringify({ last: fin.last, r: finR && { w: finR.withheld, v: finR.values, e: finR.error } }).slice(0, 400));
check('…and the answer is filled from them', fin.last?.text === 'There were 5 cash trips.', fin.last?.text);

script = [tool('cash_trips', { from: '2026-10-01', to: '2026-10-07' }), say('Cash figures are not shown to your role.')];
const dsp = await chat(DSP, 'How many cash trips this week?');
const dspR = await stored(DSP, 'r1');
check('the Dispatcher\'s cash tool is refused by the gate — withheld, not a zero',
  dspR?.withheld && !dspR.values && /cash|not shown/i.test(dspR.withheld), JSON.stringify(dspR).slice(0, 300));
check('…and the refusal is shown under the answer, in the gate\'s words',
  (dsp.last?.sources || []).some((s) => s.id === 'r1' && s.withheld === dspR?.withheld), JSON.stringify(dsp.last?.sources));

console.log('\n2. a person whose access covers one fleet');
/* /api/kpis combines both fleets (manifest: fleet "mixed"), so the gate
   refuses it to an Egari-only reader with that reason — and the assistant
   says so rather than producing a number. */
script = [tool('fleet_totals', { from: '2026-10-01', to: '2026-10-07' }), say('Fleet totals are not open to you.')];
await chat(OPS, 'Completed trips this week?');
const opsT = await stored(OPS, 'r1');
check('whole-fleet totals are refused to an Egari-only manager, with the gate\'s reason',
  /combines the records of every fleet/.test(opsT?.withheld || '') && !opsT?.values, JSON.stringify(opsT).slice(0, 300));
/* The drivers page filters by fleet (manifest: "param"), so it answers —
   Egari's drivers only, and the result says Egari. */
script = [tool('drivers', { from: '2026-10-01', to: '2026-10-07' }), say('{{r2.drivers}} drivers worked.')];
const ops = await chat(OPS, 'Which drivers worked this week?');
const opsR = await stored(OPS, 'r2');
check('an Egari-only manager\'s drivers are Egari\'s: two, not five',
  opsR?.values?.drivers === 2 && (opsR.rows || []).every((r) => r.fleet === 'egari'), JSON.stringify(opsR?.values));
check('…and they are LABELLED Egari, not "both fleets"', /Egari/.test(opsR?.definition || '') && !/both fleets/.test(opsR?.definition || ''),
  opsR?.definition);

console.log('\n3. sign-in required');
process.env.ACCESS_MODE = 'enforced';
await svc.getConfig(db, { fresh: true });
const anon = await chat(null, 'How many trips?');
check('a visitor gets a sign-in refusal, and nothing from the assistant', anon.status === 401, `${anon.status} ${JSON.stringify(anon.last).slice(0, 120)}`);
const anonState = await fetch(`${base}/api/agent/state`);
check('…the state too, so the window does not appear', anonState.status === 401, String(anonState.status));
delete process.env.ACCESS_MODE;
await svc.getConfig(db, { fresh: true });

console.log('\n4. one person\'s conversation is theirs');
const [finConv] = await q(`SELECT id FROM agent_conversation WHERE owner = $1`, [`u:${FIN.id}`]);
script = [tool('make_excel', { results: ['r1'], title: 'x' }), say('[[file r2]]')];
await chat(FIN, 'Excel please');
const asDsp = await fetch(`${base}/api/agent/file/${finConv.id}/r2.xlsx`, { headers: { cookie: DSP.cookie } });
const asFin = await fetch(`${base}/api/agent/file/${finConv.id}/r2.xlsx`, { headers: { cookie: FIN.cookie } });
check('the Finance manager\'s file opens for them', asFin.status === 200, String(asFin.status));
check('…and is a 404 for the Dispatcher who learned its address', asDsp.status === 404, String(asDsp.status));
const dspState = await (await fetch(`${base}/api/agent/state`, { headers: { cookie: DSP.cookie } })).json();
check('each person\'s state is their own conversation', dspState.conversation?.id && dspState.conversation.id !== finConv.id);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
