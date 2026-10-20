/* ntfy alerts (api/alerts.js, src/ntfy.js): the credential banner pushed to a
   phone when it changes — and ONLY when it changes. The failure modes that
   matter are the two that make an alert channel useless: silence on a real
   stop, and noise that teaches the operator to mute it. Both held here
   against a real schema (PGlite) and a fake ntfy that records every post. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { noteCredential } from '../src/auth_state.js';
import { alertTick, compose, reasonOf, alertKey, ALERT_GAP_MS } from '../api/alerts.js';
import { publish, clip } from '../src/ntfy.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const sent = [];
let down = false;
const fake = async (m) => (down ? { ok: false, error: 'ntfy answered 502' } : (sent.push(m), { ok: true }));
const config = (topic = 'fleet-test') => async () => ({ topic, click: 'https://dash.example' });
let clock = Date.now();
const tick = (o = {}) => alertTick({ q, publish: fake, now: clock, config: config(), ...o });
const run = (src, fleet, status, rows, h) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, started_at, finished_at)
   VALUES ($1, $2, 'incremental', $3, $4, now() - $5 * interval '1 hour', now() - $5 * interval '1 hour')`,
  [src, fleet, status, rows, h]);
const note = (o) => noteCredential(db, o);

console.log('off until a topic is set');
{
  const r = await alertTick({ q, publish: fake, config: config('') });
  check('no topic, no push', r.sent === 0 && sent.length === 0 && /NTFY_TOPIC/.test(r.skipped), JSON.stringify(r));
  const r2 = await tick();
  check('an empty banner is not announced as "all collecting"', r2.sent === 0 && /nothing observed/.test(r2.skipped), JSON.stringify(r2));
  check('…and nothing is remembered, so the first real pass still says hello',
    (await q('SELECT count(*)::int n FROM alert_state'))[0].n === 0);
}

console.log('\nthe first pass says it is on, and what is wrong right now');
await run('cabman', null, 'ok', 52, 0.1);
await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'ok', surface: 'IVDData' });
await run('bolt', 'egari', 'partial', 72, 0.4);
await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'ok', surface: 'orderHistory' });
await run('hotel', 'egari', 'ok', 20, 0.4);
await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'invalid',
  detail: 'token refused (401)', surface: 'get-trip-report' });
{
  const r = await tick();
  check('one message on the first pass', r.sent === 1 && r.first && sent.length === 1, JSON.stringify(r));
  const m = sent[0];
  check('it says the alerts are on', /alerts are on/.test(m.title), m.title);
  check('…and names what is broken right now, with the banner\'s own reason',
    /Stopped: hotel · Egari \(HOTEL_EGARI_TOKEN\) — token refused \(401\)/.test(m.message), m.message);
  check('…and counts it against everything watched', /1 of 3 are not working/.test(m.message), m.message);
  check('the click opens the dashboard', m.click === 'https://dash.example');
  check('every watched row is remembered', (await q('SELECT count(*)::int n FROM alert_state'))[0].n === 3);
  const again = await tick();
  check('nothing changed, nothing sent', again.sent === 0 && sent.length === 1, JSON.stringify(again));
}

console.log('\na source stops');
clock += ALERT_GAP_MS + 1;
await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'invalid',
  detail: 'refresh token expired 2026-10-20T09:19:57.000Z — re-capture from the portal', surface: 'orderHistory' });
{
  const r = await tick();
  const m = sent.at(-1);
  check('one push', r.sent === 1 && r.changes === 1 && sent.length === 2, JSON.stringify(r));
  check('titled with what stopped', m.title === 'Stopped: bolt · Egari (BOLT_REFRESH_TOKEN_EGARI)', m.title);
  check('carrying the reason the banner gives', /refresh token expired 2026-10-20T09:19:57/.test(m.message), m.message);
  check('high priority', m.priority === 4);
  check('…and, having been collecting, carries no history line', !/\n/.test(m.message) && !/undefined/.test(m.message), m.message);
}

console.log('\na failed push is retried, not forgotten');
await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'expired',
  detail: 'login refused', surface: 'IVDData' });
clock += 60e3;
{
  down = true;
  const r = await tick();
  check('ntfy down: nothing is recorded as sent', r.sent === 0 && /502/.test(r.error), JSON.stringify(r));
  check('…the row still holds the last verdict that was delivered',
    (await q(`SELECT severity FROM alert_state WHERE key = $1`, ['cabman|ecosine|CABMAN_ECOSINE_PASS|IVDData']))[0]?.severity === 'ok');
  down = false;
  const r2 = await tick();
  check('ntfy back: the same news goes out on the next pass', r2.sent === 1 && /Stopped: cabman · Ecosine/.test(sent.at(-1).title),
    JSON.stringify(r2) + sent.at(-1)?.title);
}

console.log('\nflapping inside the quiet gap is never sent');
{
  const n0 = sent.length;
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'ok', surface: 'IVDData' });
  clock += 5 * 60e3;
  const r = await tick();
  check('recovered five minutes after the stop: held', r.sent === 0 && sent.length === n0, JSON.stringify(r));
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'expired',
    detail: 'login refused', surface: 'IVDData' });
  clock += ALERT_GAP_MS;
  const r2 = await tick();
  check('…and stopped again by the time the gap ends: nothing to say', r2.sent === 0 && sent.length === n0, JSON.stringify(r2));
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'ok', surface: 'IVDData' });
  clock += 60e3;
  const r3 = await tick();
  const m = sent.at(-1);
  check('a recovery after the gap is sent', r3.sent === 1 && m.title === 'Working again: cabman · Ecosine (CABMAN_ECOSINE_PASS)', m?.title);
  check('…at low priority, saying what it was and when that was first reported',
    m.priority === 2 && /\nWas stopped, first reported \d+ \w{3}, \d\d:\d\d Dubai\.$/.test(m.message), m.message);
}

console.log('\nchanges in one pass are one message');
clock += ALERT_GAP_MS + 1;
await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'ok', surface: 'orderHistory' });
await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'ok', surface: 'get-trip-report' });
await run('yango', 'ecosine', 'ok', 5, 40);
await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY', state: 'ok', surface: 'transactions' });
{
  const n0 = sent.length;
  const r = await tick();
  const m = sent.at(-1);
  check('three changes, one push', r.sent === 1 && r.changes === 3 && sent.length === n0 + 1, JSON.stringify(r));
  check('the title counts them, worst first', m.title === '3 sources changed: 1 not collecting, 2 working again', m.title);
  check('a NEW row that is already stalled is news, with the stall in hours',
    /Not collecting: yango · Ecosine \(YANGO_API_KEY\) — no successful collection for 40h — expected at least every 12h/.test(m.message), m.message);
  check('the worst line comes first', m.message.split('\n')[0].startsWith('Not collecting'), m.message);
  check('priority is the worst change\'s', m.priority === 4);
}

console.log('\nsaved-but-untested is neither news nor forgotten');
{
  /* A save on the Settings page turns a row pending until the collector tests
     it. The next real verdict is what matters, and it must be compared with
     what was last SAID, not with "pending". */
  clock += ALERT_GAP_MS + 1;
  await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'saved',
    detail: 'saved — not yet tested', surface: 'get-trip-report' });
  const r = await tick();
  check('pending is not sent', r.sent === 0, JSON.stringify(r));
  check('…and does not overwrite the last thing said',
    (await q(`SELECT severity FROM alert_state WHERE key LIKE 'hotel|egari|%'`))[0].severity === 'ok');
}

console.log('\nwording');
{
  /* Inside 'stopped', a different STATE is a different errand: a refused
     token is replaced, a moved URL is changed. Same verdict, new news. */
  clock += ALERT_GAP_MS + 1;
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'expired',
    detail: 'login refused', surface: 'IVDData' });
  await tick();
  clock += ALERT_GAP_MS + 1;
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'moved',
    detail: 'redirected — the endpoint has moved', surface: 'IVDData' });
  const n0 = sent.length;
  const r = await tick();
  check('a new state inside "stopped" is a different errand and is news',
    r.sent === 1 && sent.length === n0 + 1 && /endpoint has moved/.test(sent.at(-1).message), JSON.stringify(r));
  clock += ALERT_GAP_MS + 1;
  const r2 = await tick();
  check('…once', r2.sent === 0, JSON.stringify(r2));
  const row = { provider: 'bolt', fleet_id: 'ecosine', credential: 'BOLT_CLIENT_ID', surface: 'getDrivers',
    state: 'unentitled', severity: 'degraded', detail: 'not entitled to company 142868' };
  check('degraded says the channel is still collecting', /still collecting/.test(reasonOf(row)), reasonOf(row));
  check('keys follow the banner row', alertKey(row) === 'bolt|ecosine|BOLT_CLIENT_ID|getDrivers');
  const big = compose(Array.from({ length: 80 }, (_, i) => ({ r: { ...row, credential: `K${i}`, severity: 'stopped',
    detail: 'x'.repeat(80) }, from: null })));
  check('a long message is clipped under ntfy\'s attachment limit', Buffer.byteLength(clip(big.message)) <= 3900);
}

console.log('\nthe publisher');
{
  const posts = [];
  const f = async (url, o) => { posts.push({ url, o }); return { ok: true, status: 200, json: async () => ({ id: 'abc' }) }; };
  const r = await publish({ title: 'Stopped: bolt — x', message: 'm', priority: 4, tags: ['warning'], click: 'https://d' },
    { topic: ' fleet-x ', url: 'https://ntfy.example/', token: 'tk', fetchImpl: f });
  const body = JSON.parse(posts[0].o.body);
  check('posts JSON to the server root', posts[0].url === 'https://ntfy.example/' && posts[0].o.method === 'POST');
  check('…with the topic trimmed, title, priority, tags and click', body.topic === 'fleet-x' && body.title === 'Stopped: bolt — x'
    && body.priority === 4 && body.tags[0] === 'warning' && body.click === 'https://d', posts[0].o.body);
  check('…and the token as a bearer header only when one is set', posts[0].o.headers.authorization === 'Bearer tk');
  check('accepted', r.ok && r.id === 'abc', JSON.stringify(r));
  await publish({ title: 't', message: 'm' }, { topic: 't', url: 'https://ntfy.example', token: '', fetchImpl: f });
  check('no token, no header', !('authorization' in posts[1].o.headers));
  const no = await publish({ title: 't', message: 'm' }, { topic: '', fetchImpl: f });
  check('no topic: refused without a request', !no.ok && posts.length === 2);
  const bad = await publish({ title: 't', message: 'm' }, { topic: 't', fetchImpl: async () => ({ ok: false, status: 429, text: async () => 'limit' }) });
  check('a refusal is reported, not thrown', !bad.ok && /429/.test(bad.error), JSON.stringify(bad));
  const boom = await publish({ title: 't', message: 'm' }, { topic: 't', fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  check('a network error is reported, not thrown', !boom.ok && /ECONNRESET/.test(boom.error));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
