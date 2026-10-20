/* ntfy alerts (api/alerts.js, src/ntfy.js): the credential banner pushed to a
   phone when it changes — and ONLY when it changes. The failure modes that
   matter are the two that make an alert channel useless: silence on a real
   stop, and noise that teaches the operator to mute it. Both held here
   against a real schema (PGlite) and a fake ntfy that records every post. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { noteCredential } from '../src/auth_state.js';
import { alertTick, compose, firstMessage, reasonOf, alertKey, wordOf, ALERT_GAP_MS, CONFIRM_MS, HOLD_MAX_MS } from '../api/alerts.js';
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
const advance = (ms) => { clock += ms; };
/* A run of a source at the test's clock — "observed again". */
const runAt = (src, fleet, status = 'ok', rows = 5, at = clock) => q(
  `INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, started_at, finished_at)
   VALUES ($1, $2, 'incremental', $3, $4, $5, $5)`, [src, fleet, status, rows, new Date(at).toISOString()]);
/* A change is sent once the source has been observed again and still says
   it: see it, let a later run of the named sources land, confirm it. */
const settle = async (...sources) => {
  const a = await tick();
  advance(CONFIRM_MS + 60e3);
  for (const [src, fleet] of sources) await runAt(src, fleet, 'ok', 5, clock - 30e3);
  const b = await tick();
  return [a, b];
};
const told = async (k) => (await q('SELECT severity, state FROM alert_state WHERE key = $1', [k]))[0];

console.log('off until a topic is set');
{
  const r = await alertTick({ q, publish: fake, config: config('') });
  check('no topic, no push', r.sent === 0 && sent.length === 0 && /NTFY_TOPIC/.test(r.skipped), JSON.stringify(r));
  const r2 = await tick();
  check('an empty banner is not announced as "all collecting"', r2.sent === 0 && /nothing observed/.test(r2.skipped), JSON.stringify(r2));
  /* Review finding 3: every row saved and not yet tested. "Right now all 0
     are collecting", every five minutes, because nothing could be remembered. */
  await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'saved',
    detail: 'saved — not yet tested', surface: 'get-trip-report' });
  const r3 = await tick();
  check('every row pending a test: nothing to report, and nothing claimed', r3.sent === 0 && /first test/.test(r3.skipped), JSON.stringify(r3));
  check('…and nothing is remembered, so the first real pass still says hello',
    (await q('SELECT count(*)::int n FROM alert_state'))[0].n === 0);
}

console.log('\nthe first pass says it is on, and what is wrong right now');
await run('cabman', null, 'ok', 52, 0.1);
await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'ok', surface: 'IVDData' });
await run('bolt', 'egari', 'partial', 72, 0.4);
await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'ok', surface: 'getPayouts' });
await run('hotel', 'egari', 'ok', 20, 0.4);
await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'invalid',
  detail: 'token refused (401)', surface: 'get-trip-report' });
const BOLT = 'bolt|egari|BOLT_REFRESH_TOKEN_EGARI', CAB = 'cabman|ecosine|CABMAN_ECOSINE_PASS';
{
  const r = await tick();
  check('one message on the first pass, sent at once', r.sent === 1 && r.first && sent.length === 1, JSON.stringify(r));
  const m = sent[0];
  check('it says the alerts are on', /alerts are on/.test(m.title), m.title);
  check('…and names what is broken right now, with the banner\'s own reason',
    /Stopped: hotel · Egari \(HOTEL_EGARI_TOKEN\) — token refused \(401\)/.test(m.message), m.message);
  check('…and counts it against everything watched', /Right now 1 of the 3 credentials watched is not working:/.test(m.message), m.message);
  check('the click opens the dashboard', m.click === 'https://dash.example');
  check('every watched row is remembered', (await q('SELECT count(*)::int n FROM alert_state'))[0].n === 3);
  advance(CONFIRM_MS + 60e3);
  const again = await tick();
  check('nothing changed, nothing sent', again.sent === 0 && sent.length === 1, JSON.stringify(again));
}

console.log('\na source stops — sent once a later run still says so');
advance(ALERT_GAP_MS);
await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'invalid',
  detail: 'refresh token expired 2026-10-20T09:19:57.000Z — re-capture from the portal', surface: 'orderHistory' });
{
  const [a, b] = await settle(['bolt', 'egari']);
  const m = sent.at(-1);
  check('first sighting: held', a.sent === 0, JSON.stringify(a));
  check('the next run still refused: one push', b.sent === 1 && b.changes === 1 && sent.length === 2, JSON.stringify(b));
  check('titled with what stopped', m.title === 'Stopped: bolt · Egari (BOLT_REFRESH_TOKEN_EGARI)', m.title);
  check('carrying the reason the banner gives', /refresh token expired 2026-10-20T09:19:57/.test(m.message), m.message);
  check('high priority', m.priority === 4);
  check('…and, having been collecting, carries no history line', !/\n/.test(m.message) && !/undefined/.test(m.message), m.message);
}

console.log('\nthe recovery and the NEXT expiry, though the surface moved (review finding 1)');
{
  /* A healthy Bolt run ends on getPayouts; an expired token is written on
     orderHistory. credential_state keeps one row per credential and
     overwrites `surface`. Keyed on the surface, the recovery was never sent
     and the next week's expiry was silent. */
  advance(ALERT_GAP_MS);
  await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'ok', surface: 'getPayouts' });
  const [, b] = await settle(['bolt', 'egari']);
  check('a new token that works is "Working again", whatever surface wrote it',
    b.sent === 1 && sent.at(-1).title === 'Working again: bolt · Egari (BOLT_REFRESH_TOKEN_EGARI)', sent.at(-1).title);
  advance(ALERT_GAP_MS);
  await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'invalid',
    detail: 'refresh token expired 2026-10-27T09:19:57.000Z — re-capture from the portal', surface: 'orderHistory' });
  const [, d] = await settle(['bolt', 'egari']);
  check('…and the next expiry is sent too', d.sent === 1 && /2026-10-27/.test(sent.at(-1).message), sent.at(-1).message);
  check('one memory row per credential', (await q(`SELECT count(*)::int n FROM alert_state WHERE key LIKE 'bolt|egari|%'`))[0].n === 1
    && alertKey({ provider: 'bolt', fleet_id: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', surface: 'x' }) === BOLT);
}

console.log('\na failed push is retried, not forgotten');
await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'expired',
  detail: 'login refused', surface: 'IVDData' });
{
  await tick();
  advance(CONFIRM_MS + 60e3);
  await runAt('cabman', null, 'error', 0, clock - 30e3);
  down = true;
  const r = await tick();
  check('ntfy down: nothing is recorded as sent', r.sent === 0 && /502/.test(r.error), JSON.stringify(r));
  check('…the row still holds the last verdict that was delivered', (await told(CAB))?.severity === 'ok');
  down = false;
  advance(5 * 60e3);
  const r2 = await tick();
  check('ntfy back: the same news goes out on the next pass', r2.sent === 1 && /Stopped: cabman · Ecosine/.test(sent.at(-1).title),
    JSON.stringify(r2) + sent.at(-1)?.title);
}

console.log('\na blip is never sent (review findings 2 and 5)');
{
  const n0 = sent.length;
  /* A quiet row: refused once, fixed by the next run. */
  await runAt('yango', 'ecosine', 'ok', 5, clock - 60e3);
  await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY', state: 'ok', surface: 'transactions' });
  advance(5 * 60e3);
  const r0 = await tick();
  check('a new healthy row is recorded without a word', r0.sent === 0 && (await told('yango|ecosine|YANGO_API_KEY'))?.severity === 'ok', JSON.stringify(r0));
  await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY', state: 'invalid', detail: '401', surface: 'transactions' });
  advance(5 * 60e3);
  const r1 = await tick();
  advance(25 * 60e3);
  await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY', state: 'ok', surface: 'transactions' });
  await runAt('yango', 'ecosine', 'ok', 5, clock - 30e3);
  advance(5 * 60e3);
  const r2 = await tick();
  check('one refused run on a quiet row, fixed by the next: no buzz at all', r1.sent === 0 && r2.sent === 0 && sent.length === n0,
    JSON.stringify([r1, r2]));
  /* Review of c2a9ccb: a half-hourly source's verdict from ONE failed run
     survives every pass until the next run. YANGO_CONSOLE is blocked, so it
     is degraded while Yango collects and stopped while it does not; one
     errored run flipped it for half an hour, which two passes confirmed. */
  await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_CONSOLE', state: 'blocked',
    detail: '403 from a CDN edge', surface: 'reports-api' });
  const [, d0] = await settle(['yango', 'ecosine']);
  check('a known refused surface is announced once, as degraded', d0.sent === 1 && /^Degraded: yango/.test(sent.at(-1).title), sent.at(-1).title);
  const n1 = sent.length;
  advance(ALERT_GAP_MS + 1);
  await runAt('yango', 'ecosine', 'error', 0, clock - 30e3);
  const e1 = await tick();
  advance(5 * 60e3); const e2 = await tick();
  advance(5 * 60e3); const e3 = await tick();
  advance(5 * 60e3); const e4 = await tick();
  advance(10 * 60e3);
  await runAt('yango', 'ecosine', 'ok', 5, clock - 30e3);
  const e5 = await tick();
  check('one failed half-hourly run under a degraded surface: no "Stopped", no "Degraded" after it',
    [e1, e2, e3, e4, e5].every((x) => x.sent === 0) && sent.length === n1, JSON.stringify([e1, e2, e3, e4, e5]));
  /* And a stopped row that reads "ok" for one run. */
  advance(ALERT_GAP_MS);
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'ok', surface: 'IVDData' });
  await runAt('cabman', null, 'ok', 5, clock - 30e3);
  const r3 = await tick();
  advance(5 * 60e3);
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'expired',
    detail: 'login refused', surface: 'IVDData' });
  await runAt('cabman', null, 'error', 0, clock - 30e3);
  advance(5 * 60e3);
  const r4 = await tick();
  check('one "ok" run on a stopped row: no "Working again"', r3.sent === 0 && r4.sent === 0 && sent.length === n1,
    JSON.stringify([r3, r4]));
}

console.log('\na real recovery is sent, at low priority');
{
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'ok', surface: 'IVDData' });
  const [, b] = await settle(['cabman', null]);
  const m = sent.at(-1);
  check('sent once a later run agrees', b.sent === 1 && m.title === 'Working again: cabman · Ecosine (CABMAN_ECOSINE_PASS)', m?.title);
  check('…saying what it was and when that was first reported',
    m.priority === 2 && /\nWas stopped, first reported \d+ \w{3}, \d\d:\d\d Dubai\.$/.test(m.message), m.message);
}

console.log('\nchanges in one pass are one message');
advance(ALERT_GAP_MS + 1);
await note({ provider: 'bolt', fleet: 'egari', credential: 'BOLT_REFRESH_TOKEN_EGARI', state: 'ok', surface: 'getPayouts' });
await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'ok', surface: 'get-trip-report' });
await run('uber', 'egari', 'ok', 5, 40);
await note({ provider: 'uber', fleet: 'egari', credential: 'UBER_WEB_COOKIE_EGARI', state: 'ok', surface: 'supplier graphql' });
{
  const n0 = sent.length;
  /* The stall has no later run to wait for — the silence is the evidence —
     so it is confirmed by holding for two passes. */
  const [, r] = await settle(['bolt', 'egari'], ['hotel', 'egari']);
  const m = sent.at(-1);
  check('three changes, one push', r.sent === 1 && r.changes === 3 && sent.length === n0 + 1, JSON.stringify(r));
  check('the title counts them, worst first', m.title === '3 sources changed: 1 not collecting, 2 working again', m.title);
  check('a NEW row that is already stalled is news, with the stall in hours',
    /Not collecting: uber · Egari \(UBER_WEB_COOKIE_EGARI\) — no successful collection for 40h — expected at least every 6h/.test(m.message), m.message);
  check('the worst line comes first', m.message.split('\n')[0].startsWith('Not collecting'), m.message);
  check('priority is the worst change\'s', m.priority === 4);
}

console.log('\nsaved-but-untested is neither news nor forgotten');
{
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'saved',
    detail: 'saved — not yet tested', surface: 'get-trip-report' });
  const [a, b] = await settle(['hotel', 'egari']);
  check('pending is not sent', a.sent === 0 && b.sent === 0, JSON.stringify([a, b]));
  check('…and does not overwrite the last thing said', (await told('hotel|egari|HOTEL_EGARI_TOKEN'))?.severity === 'ok');
}

console.log('\na new state inside "stopped" is a different errand');
{
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'expired',
    detail: 'login refused', surface: 'IVDData' });
  await settle(['cabman', null]);
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'cabman', fleet: 'ecosine', credential: 'CABMAN_ECOSINE_PASS', state: 'moved',
    detail: 'redirected — the endpoint has moved', surface: 'IVDData' });
  const n0 = sent.length;
  const [, r] = await settle(['cabman', null]);
  check('a moved URL after a refused login is news', r.sent === 1 && sent.length === n0 + 1 && /endpoint has moved/.test(sent.at(-1).message), JSON.stringify(r));
  advance(ALERT_GAP_MS + 1);
  const [c, d] = await settle(['cabman', null]);
  check('…once', c.sent === 0 && d.sent === 0, JSON.stringify([c, d]));
}

console.log('\na new credential, broken and mended before anyone was told');
{
  const n0 = sent.length;
  await runAt('fms', 'egari', 'ok', 9, clock - 60e3);
  await note({ provider: 'fms', fleet: 'egari', credential: 'FMS_EGARI_PASS', state: 'invalid', detail: 'login refused', surface: 'Login' });
  const a = await tick();
  await note({ provider: 'fms', fleet: 'egari', credential: 'FMS_EGARI_PASS', state: 'ok', surface: 'Login' });
  await runAt('fms', 'egari', 'ok', 9, clock + 60e3);
  advance(CONFIRM_MS + 60e3);
  const b = await tick();
  await runAt('fms', 'egari', 'ok', 9, clock + 60e3);
  advance(CONFIRM_MS + 60e3);
  const c = await tick();
  check('no "Working again" for a fault nobody heard of', a.sent === 0 && b.sent === 0 && c.sent === 0 && sent.length === n0,
    JSON.stringify([a, b, c]));
  check('…and it is remembered as working', (await told('fms|egari|FMS_EGARI_PASS'))?.severity === 'ok');
}

console.log('\nconfirmed by a re-check, or by an hour');
{
  /* A credential re-tested (a save's check, a probe) is an observation as
     much as a run is. */
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'fms', fleet: 'egari', credential: 'FMS_EGARI_PASS', state: 'invalid', detail: 'login refused', surface: 'Login' });
  const a = await tick();
  advance(5 * 60e3);
  await q(`UPDATE credential_state SET checked_at = $1 WHERE credential = 'FMS_EGARI_PASS'`, [new Date(clock - 30e3).toISOString()]);
  const b = await tick();
  check('re-checked and still refused: sent', a.sent === 0 && b.sent === 1 && /Stopped: fms · Egari/.test(sent.at(-1).title),
    JSON.stringify([a, b]));
  /* A refusal, then nothing at all — a worker that died after the failing
     run. No later run will ever confirm it; an hour does. */
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'fms', fleet: 'egari', credential: 'FMS_EGARI_PASS', state: 'ok', surface: 'Login' });
  await settle(['fms', 'egari']);
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'hotel', fleet: 'egari', credential: 'HOTEL_EGARI_TOKEN', state: 'invalid',
    detail: 'token refused (401)', surface: 'get-trip-report' });
  const n0 = sent.length;
  const h1 = await tick();
  advance(HOLD_MAX_MS / 2); const h2 = await tick();
  check('no later observation: held for under an hour', h1.sent === 0 && h2.sent === 0 && sent.length === n0, JSON.stringify([h1, h2]));
  advance(HOLD_MAX_MS / 2 + 60e3); const h3 = await tick();
  check('…and sent once it has held for an hour', h3.sent === 1 && /Stopped: hotel · Egari/.test(sent.at(-1).title), JSON.stringify(h3));
}

console.log('\na row is told at most once per half hour');
{
  /* Confirmed both ways inside thirty minutes — a token pasted wrong and then
     right. The second message waits for the gap; it is not dropped. */
  advance(ALERT_GAP_MS + 1);
  await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY', state: 'invalid', detail: '401', surface: 'transactions' });
  const [, a1] = await settle(['yango', 'ecosine']);
  check('stopped, confirmed: sent', a1.sent === 1 && /Stopped: yango · Ecosine \(YANGO_API_KEY\)/.test(sent.at(-1).title), sent.at(-1).title);
  await note({ provider: 'yango', fleet: 'ecosine', credential: 'YANGO_API_KEY', state: 'ok', surface: 'transactions' });
  const [b1, b2] = await settle(['yango', 'ecosine']);
  check('back ten minutes later, confirmed: held by the gap', b1.sent === 0 && b2.sent === 0, JSON.stringify([b1, b2]));
  advance(ALERT_GAP_MS);
  const c = await tick();
  check('…and sent once the gap has passed', c.sent === 1 && /Working again: yango · Ecosine \(YANGO_API_KEY\)/.test(sent.at(-1).title), sent.at(-1).title);
}

console.log('\nwording');
{
  const row = { provider: 'bolt', fleet_id: 'ecosine', credential: 'BOLT_CLIENT_ID', surface: 'getDrivers',
    state: 'unentitled', severity: 'degraded', detail: 'not entitled to company 142868' };
  check('degraded says the channel is still collecting', /still collecting/.test(reasonOf(row)), reasonOf(row));
  /* Production's first message, 2026-10-20: YANGO_COOKIE is 'unknown' — its
     check could not run — on a Yango channel collecting every half hour. */
  const unverified = { provider: 'yango', fleet_id: 'ecosine', credential: 'YANGO_COOKIE', surface: 'reports',
    state: 'unknown', severity: 'at-risk', detail: 'not checked — the edge refused this server', run_age_h: 0.1,
    stall_limit_h: 12, still_collecting: true };
  check('an unverified credential on a collecting source is "At risk", never "Not collecting"',
    wordOf(unverified) === 'At risk', wordOf(unverified));
  check('…in the first message too', /At risk: yango · Ecosine \(YANGO_COOKIE\) — not checked/.test(firstMessage([unverified]).message)
    && !/Not collecting/.test(firstMessage([unverified]).message), firstMessage([unverified]).message);
  const stalled = { ...unverified, credential: 'YANGO_API_KEY', state: 'ok', run_age_h: 40, still_collecting: false };
  check('a stall is still "Not collecting"', wordOf(stalled) === 'Not collecting', wordOf(stalled));
  const two = compose([{ r: unverified, from: null }, { r: stalled, from: null }]);
  check('a title counts by the word its lines print', two.title === '2 sources changed: 1 not collecting, 1 at risk', two.title);
  check('keys follow credential_state\'s own key, not the surface', alertKey(row) === 'bolt|ecosine|BOLT_CLIENT_ID');
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
