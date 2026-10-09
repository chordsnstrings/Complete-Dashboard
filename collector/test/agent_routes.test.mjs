/* The chat assistant, end to end, against a real schema and a scripted model.
   ──────────────────────────────────────────────────────────────────────────
   The model is replaced by a script (agentTest.model) so every step is
   deterministic; everything else is the product: the routes, the tools
   calling the dashboard's own endpoints over the loopback, the guard, the
   storage, the Excel download, the 24-hour sweep.

   What it holds the assistant to:
     §1  an ambiguous name becomes a question with the candidates, and the
         choice carries over to the next turn by id;
     §2  a figure in the answer is the server's — the same number the Drivers
         page's endpoint gives — filled into the model's placeholder;
     §3  a number the model typed itself is sent back once and the rewrite is
         shown; a sentence that says "Bolt" over an every-platform result is
         refused twice and replaced by the figures as measured;
     §4  an Excel file is built from the stored rows, opens for its owner,
         and is a 404 for anybody else;
     §5  the model being unreachable is said, not hidden;
     §6  everything is gone 24 hours on — conversation, results, file link —
         and "New chat" forgets at once;
     §7  nothing anybody typed reaches the log.

   Proved by revert (each run against this file, 2026-10-09):
     · checkReply's stray-number test switched off (api/agent_guard.js): the
       made-up "999" reaches the person — 2 of 27 fail.
     · the platform rule switched off: "On Bolt he completed 6" (an
       every-platform figure) is shown as written — 2 fail.
     · the owner check dropped from the file route: a stranger downloads the
       file — 1 fails.
     · sweepAgentMemory's three DELETEs made no-ops: the conversation, its
       results and the Excel link survive 25 hours — 3 fail. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { agentTest } from '../api/agent_routes.js';
import { readWorkbook, sheetNamed } from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const A = 'aaaaaaaa-1111-4111-8111-000000000001';   // "Muhammad Khalid"
const B = 'aaaaaaaa-1111-4111-8111-000000000002';   // "Muhammad Khalid Younas Gul"
const C = '7000123';                                // a Bolt driver
let tn = 0;
const trip = (platform, id, name, day, status, price, plate) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6::timestamptz,$6::timestamptz + interval '15 min',$7,$8,6)`,
  [platform, `t${++tn}`, plate, id, name, `${day}T10:00:00+04:00`, status, price]);
for (const d of ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']) await trip('uber', A, 'Muhammad Khalid', d, 'completed', 25, 'L90721');
await trip('uber', A, 'Muhammad Khalid', '2026-10-03', 'canceled', null, 'L90721');
for (const d of ['2026-09-28', '2026-09-29', '2026-10-04']) await trip('uber', B, 'Muhammad Khalid Younas Gul', d, 'completed', 30, 'L94178');
for (const d of ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03']) await trip('bolt', C, 'Ali Hassan', d, 'completed', 30, 'L11111');

const { port } = await mountAll(db);
const base = `http://127.0.0.1:${port}`;
agentTest.now = () => Date.parse('2026-10-09T10:00:00+04:00');

/* The script: each model call takes the next step. */
let script = [];
const seen = [];
agentTest.model = async ({ messages }) => {
  seen.push(messages);
  const step = script.shift();
  if (!step) throw Object.assign(new Error('script ran out'), { code: 'unreachable' });
  if (typeof step === 'function') return step(messages);
  return step;
};
let callN = 0;
const tool = (name, args) => ({ model: 'seed-2-0-pro-260328', fallback: false,
  message: { content: '', tool_calls: [{ id: `c${++callN}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } });
const say = (text, extra = {}) => ({ model: 'seed-2-0-pro-260328', fallback: false, message: { content: text }, ...extra });

let cookie = '';
async function chat(message, body = {}, ck = cookie) {
  const r = await fetch(`${base}/api/agent/chat`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(ck ? { cookie: ck } : {}) },
    body: JSON.stringify({ message, ...body }) });
  const set = r.headers.get('set-cookie');
  if (set && !ck) cookie = set.split(';')[0];
  const text = await r.text();
  const events = text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { status: r.status, events, last: events[events.length - 1] };
}
const getJson = async (p, ck = cookie) => {
  const r = await fetch(`${base}${p}`, { headers: ck ? { cookie: ck } : {} });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body };
};

/* ── §1 an ambiguous name becomes a question ─────────────────────────── */
console.log('\n§1 "Khalid" is two men, so the assistant asks which');
/* The log is watched from here to the end of §2 — see §7. */
const logged = [];
const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
/* The logger writes through console.log (src/log.js) — and so does check(),
   whose own lines name drivers. Only lines in the logger's format count. */
const tap = (k) => (...a) => { const t = a.map(String).join(' '); if (/ (INFO|WARN|ERROR) +\[/.test(t)) logged.push(t); orig[k](...a); };
console.log = tap('log'); console.info = tap('info'); console.warn = tap('warn'); console.error = tap('error');
const QUESTION = 'How many trips did Khalid complete last week?';
script = [
  tool('resolve_period', { text: 'last week' }),
  tool('find_driver', { name: 'Khalid' }),
  (msgs) => {
    const found = JSON.parse(msgs[msgs.length - 1].content);
    const opts = (found.candidates || []).map((c) => `${c.name} — ${c.platforms.join(', ')}, ${c.plate}`);
    return tool('ask_user', { question: 'Which Khalid do you mean?', options: opts });
  },
];
const t1 = await chat(QUESTION);
check('the turn streams status lines, then the question', t1.events.some((e) => e.type === 'status') && t1.last.type === 'ask',
  JSON.stringify(t1.events.map((e) => e.type)));
check('…offering both men, by name, with their cars',
  t1.last.options?.length === 2 && t1.last.options.some((o) => o.startsWith('Muhammad Khalid —') && o.includes('L90721'))
  && t1.last.options.some((o) => o.startsWith('Muhammad Khalid Younas Gul')), JSON.stringify(t1.last.options));
check('the dates were worked out by the server: last week is Mon 28 Sep – Sun 4 Oct 2026',
  seen[1].some((m) => m.role === 'tool' && /"from":"2026-09-28".*"to":"2026-10-04"/.test(m.content)));
check('a visitor gets a cookie to keep the conversation by', /^fm_agent=/.test(cookie), cookie);

/* ── §2 the answer's figure is the server's ──────────────────────────── */
console.log('\n§2 the choice carries over, and the figure is the endpoint\'s own');
script = [
  (msgs) => {
    const sys = msgs[0].content;
    const m = /"Muhammad Khalid — [^"]*" = driver_id ([^\s;]+)/.exec(sys);
    return tool('drivers', { from: '2026-09-28', to: '2026-10-04', driver_id: m ? m[1] : 'missing' });
  },
  say('Muhammad Khalid completed {{r3.total_completed}} trips last week ({{r1.label}}).'),
];
const t2 = await chat('Muhammad Khalid');
check('the system prompt told the model which id the chosen option is', seen[3][0].content.includes(`driver_id ${A}`), seen[3][0].content.slice(-400));
const dir = await getJson('/api/drivers/directory?from=2026-09-28&to=2026-10-04');
const pageSays = (dir.body || []).find((r) => (r.ids || []).includes(A))?.completed;
check('the Drivers page\'s endpoint says 5 completed for him', pageSays === 5, String(pageSays));
check('…and the answer says exactly that, filled in by the server',
  t2.last.type === 'answer' && t2.last.text === 'Muhammad Khalid completed 5 trips last week (Mon 28 Sep – Sun 4 Oct 2026).', t2.last.text);
check('…with its sources: what r3 is, in words', (t2.last.sources || []).some((s) => s.id === 'r3' && /Driver figures · Muhammad Khalid ·.*28 Sep/.test(s.definition)),
  JSON.stringify(t2.last.sources));
check('the chips now hold the period and the driver',
  t2.last.context?.period?.from === '2026-09-28' && t2.last.context?.driver?.name === 'Muhammad Khalid', JSON.stringify(t2.last.context));

/* ── §7 nothing typed reaches the log ────────────────────────────────── */
console.log = orig.log; console.info = orig.info; console.warn = orig.warn; console.error = orig.error;
console.log('\n§7 the log carries counts, never words');
const all = logged.join('\n');
check('a turn was logged', /\bturn\b/.test(all), all.slice(0, 200));
check('…without the question, the driver\'s name or the answer',
  !all.includes('complete last week') && !all.includes('Khalid') && !all.includes('Younas'), all.slice(0, 400));

/* ── §3 the guard ─────────────────────────────────────────────────────── */
console.log('\n§3 a number the model made up is sent back; a false sentence is replaced');
script = [
  say('He completed 999 trips.'),
  say('He completed {{r3.total_completed}} trips.'),
];
const t3 = await chat('Are you sure?');
const retryMsg = seen[seen.length - 1].slice(-1)[0];
check('the stray number went back to the model with what was wrong',
  retryMsg.role === 'user' && /cannot be shown yet/.test(retryMsg.content) && /999/.test(retryMsg.content), retryMsg.content);
check('…and the rewrite is what the person sees', t3.last.text === 'He completed 5 trips.' && !t3.last.plain, t3.last.text);

script = [
  tool('driver_trips', { driver_id: A, from: '2026-09-28', to: '2026-10-04' }),
  say('On Bolt he completed {{r4.completed}} trips.'),
  say('On Bolt he completed {{r4.completed}} trips.'),
];
const t4 = await chat('How many of those were on Bolt?');
check('"on Bolt" over an every-platform result is refused twice and replaced by the figures as measured',
  t4.last.plain === true && /exactly as measured/.test(t4.last.text) && /Trips · Muhammad Khalid · every platform/.test(t4.last.text), t4.last.text);
check('…which still shows the trips themselves', (t4.last.tables || []).some((t) => t.id === 'r4' && t.total_rows === 6),
  JSON.stringify((t4.last.tables || []).map((t) => [t.id, t.total_rows])));

/* ── §4 Excel ─────────────────────────────────────────────────────────── */
console.log('\n§4 an Excel file from the stored rows, for its owner only');
script = [
  tool('summarise', { result: 'r4', group_by: 'outcome', measures: [{ fn: 'count' }] }),
  tool('make_excel', { results: ['r4', 'r5'], title: 'Khalid last week' }),
  say('Here it is:\n[[file r6]]\n[[table r5]]'),
];
const t5 = await chat('Give me that in Excel');
const file = t5.last.files?.[0];
check('the answer carries a file link and the grouped table',
  file?.url === `/api/agent/file/${t1.events[0].conversation}/r6.xlsx` && t5.last.tables?.[0]?.id === 'r5', JSON.stringify(t5.last).slice(0, 300));
check('…and the grouped table is the server\'s count: 5 completed, 1 not completed',
  JSON.stringify(t5.last.tables?.[0]?.rows) === JSON.stringify([{ outcome: 'completed', count: 5 }, { outcome: 'not_completed', count: 1 }]),
  JSON.stringify(t5.last.tables?.[0]?.rows));
{
  const r = await fetch(`${base}${file.url}`, { headers: { cookie } });
  const buf = Buffer.from(await r.arrayBuffer());
  check('the file downloads for its owner, as an .xlsx', r.status === 200
    && /spreadsheetml/.test(r.headers.get('content-type') || '') && buf.slice(0, 2).toString() === 'PK', `${r.status}`);
  const wb = readWorkbook(buf);
  const names = wb.sheetNames;
  const first = JSON.stringify(sheetNamed(wb, names[0])?.rows || []);
  check('…with a sheet of his six trips under a header', names.length === 2
    && (first.match(/L90721/g) || []).length === 6 && first.includes('Outcome'), `${names} ${first.slice(0, 200)}`);
  const stranger = await fetch(`${base}${file.url}`, { headers: { cookie: 'fm_agent=somebodyelse_cookie_value_123' } });
  check('anybody else asking for the same address gets a 404', stranger.status === 404, String(stranger.status));
}

/* ── §5 the model unreachable ─────────────────────────────────────────── */
console.log('\n§5 no model, said plainly');
script = [];
const t6 = await chat('And yesterday?');
check('the person is told the model cannot be reached, not shown a blank or a guess',
  t6.last.type === 'error' && /can.t reach its model/.test(t6.last.text), JSON.stringify(t6.last));
script = [say('Muhammad Khalid completed {{r3.total_completed}} trips.', { model: 'seed-2-0-lite-260428', fallback: true })];
const t7 = await chat('Again please');
check('an answer from the fallback model says so', t7.last.fallback === true && t7.last.model === 'seed-2-0-lite-260428', JSON.stringify([t7.last.model, t7.last.fallback]));

/* ── §6 24 hours ──────────────────────────────────────────────────────── */
console.log('\n§6 the memory lasts a day, and "New chat" forgets at once');
{
  const s = await getJson('/api/agent/state');
  check('before: the conversation is there, with its messages', s.body?.conversation?.messages?.length >= 10, String(s.body?.conversation?.messages?.length));
  await q(`UPDATE agent_message SET created_at = now() - interval '25 hours'`);
  await q(`UPDATE agent_result SET created_at = now() - interval '25 hours'`);
  await q(`UPDATE agent_conversation SET created_at = now() - interval '25 hours', last_at = now() - interval '25 hours'`);
  const after = await getJson('/api/agent/state');
  check('25 hours on, the next visit finds nothing', after.body?.conversation === null, JSON.stringify(after.body?.conversation)?.slice(0, 120));
  const counts = await q(`SELECT (SELECT count(*) FROM agent_message)::int m, (SELECT count(*) FROM agent_result)::int r, (SELECT count(*) FROM agent_conversation)::int c`);
  check('…because every message, result and conversation was deleted', counts[0].m === 0 && counts[0].r === 0 && counts[0].c === 0, JSON.stringify(counts[0]));
  const r = await fetch(`${base}${file.url}`, { headers: { cookie } });
  check('…and the Excel link is dead', r.status === 404, String(r.status));
}
{
  script = [say('Hello — ask me about the fleet.')];
  await chat('hi');
  const before = await getJson('/api/agent/state');
  const r = await fetch(`${base}/api/agent/new`, { method: 'POST', headers: { cookie } });
  const after = await getJson('/api/agent/state');
  check('"New chat" deletes the conversation now', before.body?.conversation && r.status === 200 && after.body?.conversation === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
