/* /api/health before the caller is identified, and the per-client request
   budget (api/ops.js, mounted by api/server.js).
   ─────────────────────────────────────────────────────────────────────────
   The defect: /api/health was memory-only but registered after
   `app.use(access.identify)`, whose first act is a query on the shared pool —
   so with the pool full of slow reads the platform's probe timed out and the
   API was restarted into a cold cache. And nothing limited how fast one client
   could ask, or how often it could make the server call a provider.

   What is proven here, in four parts:
     1. the wiring in server.js itself: the exact block that mounts health and
        the budget is sliced out of the shipped file and evaluated, with a
        stand-in identify() behind it that never answers (a saturated pool) —
        health still answers, everything else waits;
     2. what health says: commit from COMMIT_SHA or null with the true reason,
        the same shell fingerprint /sw.js serves, and no address anywhere;
     3. the budget: which requests spend which budget, 429 with Retry-After
        and a plain reason, separate clients, windows that end, the exempt
        callers (the process's own warmer; health), and RATE_LIMIT=off;
     4. memory: the key map stops at its cap and new keys share one entry. */
import express from 'express';
import { readFileSync } from 'node:fs';
import {
  commitFrom, frontendFrom, addressKey, clientKey, budgetFor, budgetPath, resolveBudgets,
  makeRateLimiter, makeHealth, refusalBody, BUDGETS,
} from '../api/ops.js';
import { internalHeaders } from '../api/access/internal.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SRC = readFileSync('api/server.js', 'utf8');

/* ── 1. the wiring in server.js ─────────────────────────────────────────── */
console.log('server.js mounts health and the budget before identify()');

/* Statements, at the start of their line — the prose around them names the
   same calls, and an indexOf that found a comment would prove nothing. */
const at = (re) => { const m = SRC.match(re); return m ? m.index : -1; };
const iHealth = at(/^app\.get\('\/api\/health', /m);
const iBudget = at(/^app\.use\(requestBudget\);$/m);
const iIdentify = at(/^app\.use\(access\.identify\);$/m);
const iCache = at(/^app\.use\('\/api', \(req, res, next\) => \($/m);
check('/api/health is registered before app.use(access.identify)',
  iHealth > 0 && iIdentify > 0 && iHealth < iIdentify, `health@${iHealth} identify@${iIdentify}`);
check('the request budget is mounted before identify() and before the cache',
  iBudget > 0 && iBudget < iIdentify && iBudget < iCache, `budget@${iBudget} identify@${iIdentify} cache@${iCache}`);
check('there is exactly one /api/health route in server.js',
  (SRC.match(/^app\.get\('\/api\/health'/gm) || []).length === 1);
check('the old registration below identify() is gone',
  !/app\.get\('\/api\/health', \(_, res\) => res\.json\(\{ ok: true, migrating: !migrationsDone \}\)\)/.test(SRC));
/* The fingerprint health reports is the one /sw.js writes, from one variable. */
check('health reads the same shellHash that /sw.js serves as fleet-<hash>',
  /frontend: \(\) => shellHash/.test(SRC) && SRC.includes("`const VERSION = 'fleet-${shellHash}';`"));

/* The block itself, sliced from the shipped file and run. `migrationsDone` and
   `shellHash` are declared around it, as they are in server.js, so the getters
   it hands to makeHealth close over bindings this test can change. */
const a = SRC.indexOf('const requestBudget = makeRateLimiter(');
const b = SRC.indexOf('app.use(requestBudget);');
check('the mounting block is found in server.js', a > 0 && b > a, `${a}..${b}`);
const block = SRC.slice(a, b + 'app.use(requestBudget);'.length);

const warned = [];
const log = { info() {}, warn: (_c, m) => warned.push(m), error() {} };
const mountShipped = (app, { shell = 'abcdef012345' } = {}) => new Function('app', 'makeHealth', 'makeRateLimiter', 'log',
  `let migrationsDone = false; let shellHash = ${JSON.stringify(shell)};\n${block}\n`
  + 'return { done: () => { migrationsDone = true; }, budget: requestBudget };')(app, makeHealth, makeRateLimiter, log);

const listen = (app) => new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const getJson = async (base, path, headers = {}, timeoutMs = 3000) => {
  const t0 = Date.now();
  const r = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(timeoutMs) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body, ms: Date.now() - t0, retry: r.headers.get('retry-after'),
    cc: r.headers.get('cache-control') };
};

{
  const saved = { ...process.env };
  process.env.COMMIT_SHA = '52CBF9D949AB52CBF9D949AB52CBF9D949AB52CB';
  process.env.RATE_LIMIT_READS_PER_MIN = '5';
  delete process.env.RATE_LIMIT;
  const app = express();
  const shipped = mountShipped(app);
  /* identify() on a saturated pool: it never calls next(). */
  let identifyCalls = 0;
  app.use((req, _res, next) => { if (req.path.startsWith('/api/')) { identifyCalls += 1; return; } next(); });
  app.get('/api/kpis', (_q, r) => r.json({ trips: 1 }));
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}`;

  /* A health route that waits on identify() never answers here: caught and
     reported as the failure it is, rather than crashing the file. */
  const h = await getJson(base, '/api/health').catch((e) => ({ status: `no answer (${e.name})`, body: null, ms: 3000 }));
  check('health answers 200 while identify() is stuck', h.status === 200 && h.body?.ok === true, JSON.stringify(h));
  check('…from memory, without reaching identify()', identifyCalls === 0, `identify calls ${identifyCalls}`);
  check('…and quickly', h.ms < 1000, `${h.ms} ms`);
  check('…and is never stored by a cache', h.cc === 'no-store', String(h.cc));
  check('migrating is true until migrations resolve', h.body?.migrating === true);
  shipped.done();
  const h2 = await getJson(base, '/api/health').catch(() => ({ status: 'no answer', body: {} }));
  check('…and false once they have', h2.body?.migrating === false);
  check('commit comes from COMMIT_SHA, lower-cased',
    h2.body?.commit === '52cbf9d949ab52cbf9d949ab52cbf9d949ab52cb' && !('commit_reason' in h2.body), JSON.stringify(h2.body));
  check('frontend is the fingerprint /sw.js serves', h2.body?.frontend === 'fleet-abcdef012345', h2.body?.frontend);
  check('started_at is a time and uptime_s a count',
    !Number.isNaN(Date.parse(h2.body?.started_at)) && Number.isInteger(h2.body?.uptime_s) && h2.body.uptime_s >= 0);
  check('the fields the platform and the integrator read are all there',
    ['ok', 'migrating', 'commit', 'frontend', 'started_at', 'uptime_s', 'rate_limit'].every((k) => k in h2.body),
    Object.keys(h2.body || {}).join(','));

  let stuck = 'answered';
  try { await getJson(base, '/api/kpis', {}, 400); } catch { stuck = 'waited'; }
  check('a data route, by contrast, waits on identify()', stuck === 'waited' && identifyCalls === 1, `${stuck} ${identifyCalls}`);

  /* The budget in the shipped wiring, with the env override it reads. */
  const ip = { 'do-connecting-ip': '198.51.100.7' };
  const codes = [];
  for (let i = 0; i < 6; i += 1) {
    try { codes.push((await getJson(base, '/api/kpis', ip, 250)).status); } catch { codes.push('passed-to-identify'); }
  }
  check('the shipped budget honours RATE_LIMIT_READS_PER_MIN=5: five reach identify(), the sixth is 429',
    codes.slice(0, 5).every((c) => c === 'passed-to-identify') && codes[5] === 429, codes.join(','));
  const h3 = await getJson(base, '/api/health', ip).catch(() => ({ status: 'no answer', body: {} }));
  check('health is never budgeted, even for a client over budget', h3.status === 200);
  check('health names the header that keyed the last request', h3.body?.rate_limit?.key_source_last === 'do-connecting-ip',
    JSON.stringify(h3.body?.rate_limit));
  check('…and the one this request would use', h3.body?.rate_limit?.key_source_this_request === 'do-connecting-ip');
  check('health carries no address', !JSON.stringify(h3.body).includes('198.51.100.7'), JSON.stringify(h3.body));

  /* The process's own loopback fetch (the warmer), carrying the internal token. */
  const sys = { ...ip, ...internalHeaders() };
  let sysOk = 0;
  for (let i = 0; i < 8; i += 1) {
    try { await getJson(base, '/api/kpis', sys, 250); } catch { sysOk += 1; }
  }
  check('the warmer (internal token on loopback) is never budgeted', sysOk === 8, `${sysOk} of 8 reached identify()`);

  /* The assistant's tool calls look like this over real HTTP: loopback, the
     asker's cookie, no token, no forwarding header. Past the budget of five. */
  let selfOk = 0;
  for (let i = 0; i < 8; i += 1) {
    try { await getJson(base, '/api/kpis', { cookie: 'fm_sid=not-a-real-session' }, 250); } catch { selfOk += 1; }
  }
  check('a self-call over loopback (the assistant\'s fetchApi) is never budgeted', selfOk === 8, `${selfOk} of 8 reached identify()`);
  const h4 = await getJson(base, '/api/health').catch(() => ({ body: {} }));
  check('…and health counts it apart, never as req.ip',
    h4.body?.rate_limit?.self_calls_since_boot >= 8 && h4.body?.rate_limit?.key_sources_since_boot?.['req.ip'] === 0,
    JSON.stringify(h4.body?.rate_limit));

  srv.closeAllConnections?.();
  srv.close();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
}

/* With COMMIT_SHA left unset and a shell that could not be hashed, the shipped
   block says so rather than inventing either. */
{
  const saved = process.env.COMMIT_SHA;
  delete process.env.COMMIT_SHA;
  const app = express();
  mountShipped(app, { shell: null });
  const srv = await listen(app);
  const h = await getJson(`http://127.0.0.1:${srv.address().port}`, '/api/health');
  check('no COMMIT_SHA: commit null, with the reason', h.body?.commit === null && /not set/.test(h.body?.commit_reason || ''),
    JSON.stringify(h.body));
  check('no shell hash: frontend null, with the reason', h.body?.frontend === null && /could not be hashed/.test(h.body?.frontend_reason || ''));
  srv.close();
  if (saved !== undefined) process.env.COMMIT_SHA = saved;
}

/* ── 2. what health says about the build ────────────────────────────────── */
console.log('\nthe commit and the front end, or the reason they are absent');

check('unset → null, "not set"', commitFrom({}).commit === null && /not set/.test(commitFrom({}).commit_reason));
check('empty → null, "empty"', commitFrom({ COMMIT_SHA: '  ' }).commit === null && /empty/.test(commitFrom({ COMMIT_SHA: '' }).commit_reason));
{
  const r = commitFrom({ COMMIT_SHA: '${_self.COMMIT_HASH}' });
  check('an unexpanded ${…} placeholder → null, named as such', r.commit === null && /unexpanded/.test(r.commit_reason), JSON.stringify(r));
  const r2 = commitFrom({ COMMIT_SHA: 'abc${COMMIT_HASH}' });
  check('…wherever the dollar-brace sits', r2.commit === null && /unexpanded/.test(r2.commit_reason));
}
{
  const r = commitFrom({ COMMIT_SHA: 'latest-build' });
  check('not a commit hash → null, and the value is not echoed',
    r.commit === null && /not a git commit hash/.test(r.commit_reason) && !r.commit_reason.includes('latest-build'), JSON.stringify(r));
}
check('a short hash is accepted', commitFrom({ COMMIT_SHA: '52cbf9d' }).commit === '52cbf9d');
check('frontend: 12 hex → fleet-<hex>', frontendFrom('714b035d76ad').frontend === 'fleet-714b035d76ad');
check('frontend: null → null with a reason', frontendFrom(null).frontend === null && frontendFrom(null).frontend_reason.length > 20);
check('frontend: anything else → null', frontendFrom('fleet-dev').frontend === null);
{
  /* A getter read before its const is initialised throws; health must not. */
  const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, json(b) { this.body = b; return this; } };
  makeHealth({ migrating: () => { throw new ReferenceError('x'); }, frontend: () => { throw new ReferenceError('y'); }, env: {} })({}, res);
  check('a getter that throws gives "not known yet", not a crash',
    res.body?.ok === true && res.body.migrating === true && res.body.frontend === null && /not been computed/.test(res.body.frontend_reason));
}

/* ── 3. the budget ──────────────────────────────────────────────────────── */
console.log('\nwhich client, which budget');

check('do-connecting-ip is preferred',
  clientKey({ headers: { 'do-connecting-ip': '203.0.113.5', 'cf-connecting-ip': '203.0.113.6' }, ip: '10.0.0.1' }).source === 'do-connecting-ip');
check('cf-connecting-ip when the platform header is absent',
  clientKey({ headers: { 'cf-connecting-ip': '203.0.113.6' }, ip: '10.0.0.1' }).key === '203.0.113.6');
check('req.ip when neither is present', clientKey({ headers: {}, ip: '10.0.0.1' }).source === 'req.ip');
{
  const k = clientKey({ headers: { 'do-connecting-ip': '1.2.3.4, 5.6.7.8', 'cf-connecting-ip': '203.0.113.6' }, ip: '10.0.0.1' });
  check('a list is not an address: the next source is used, and the refusal counted',
    k.source === 'cf-connecting-ip' && k.invalid === 1, JSON.stringify(k));
}
check('a huge header value is refused', addressKey('9'.repeat(5000)) === null);
check('garbage is refused', addressKey('not-an-ip') === null && addressKey('') === null && addressKey(undefined) === null);
check('IPv6 is keyed by its /64',
  addressKey('2001:db8:abcd:12:1::5') === '2001:db8:abcd:12::/64'
  && addressKey('2001:db8:abcd:12:ffff:ffff:ffff:1') === '2001:db8:abcd:12::/64', addressKey('2001:db8:abcd:12:1::5'));
check('…including the compressed forms', addressKey('2001:db8::1') === '2001:db8:0:0::/64', addressKey('2001:db8::1'));
check('IPv4-mapped IPv6 is keyed as IPv4', addressKey('::ffff:203.0.113.9') === '203.0.113.9');

check('GET and HEAD are reads', budgetFor('GET', '/api/kpis') === 'reads' && budgetFor('HEAD', '/api/kpis') === 'reads');
check('other methods are writes', ['POST', 'PUT', 'PATCH', 'DELETE'].every((m) => budgetFor(m, '/api/ledger/entry') === 'writes'));
check('/api/agent/chat is the chat budget', budgetFor('POST', '/api/agent/chat') === 'chat');
check('/api/probe/* is the provider budget', budgetFor('GET', '/api/probe/uber/rest') === 'provider');
check('the four named provider actions are the provider budget',
  budgetFor('POST', '/api/finance/payouts/verify') === 'provider' && budgetFor('POST', '/api/uber/fares/run') === 'provider'
  && budgetFor('POST', '/api/analyst/run') === 'provider' && budgetFor('GET', '/api/tesla/connect') === 'provider');
check('/api/probe/results reads the stored probe: a read, not a provider call', budgetFor('GET', '/api/probe/results') === 'reads');
check('capitals and a trailing slash do not move a provider call into reads',
  budgetFor('GET', '/api/Probe/Uber/Rest/') === 'provider' && budgetFor('POST', '/API/AGENT/CHAT') === 'chat');
check('a page or a script is not under /api', budgetPath('/assets/app.js') === null && budgetPath('/') === null);
check('the defaults are the agreed budgets',
  BUDGETS.reads.limit === 600 && BUDGETS.writes.limit === 60 && BUDGETS.chat.limit === 20 && BUDGETS.chat.window_s === 600
  && BUDGETS.provider.limit === 10 && BUDGETS.provider.window_s === 3600);
{
  const w = [];
  const r = resolveBudgets({ RATE_LIMIT_READS_PER_MIN: 'abc', RATE_LIMIT_WRITES_PER_MIN: '0', RATE_LIMIT_CHAT_PER_10MIN: '7' },
    { warn: (_c, m) => w.push(m) });
  check('an override must be a positive whole number; a bad one is warned about and ignored',
    r.reads.limit === 600 && r.writes.limit === 60 && r.chat.limit === 7 && r.chat.from_env && w.length === 2, JSON.stringify({ r, w }));
}

/* The middleware itself, driven directly with a clock this test owns. */
const fakeReq = (method, path, headers = {}, remote = '10.1.2.3') => ({
  method, path, headers, ip: remote, socket: { remoteAddress: remote },
  get(n) { return this.headers[String(n).toLowerCase()]; },
});
const fakeRes = () => ({ code: 200, headers: {}, body: null,
  set(k, v) { this.headers[k.toLowerCase()] = v; return this; },
  status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const drive = (lim, req) => { const res = fakeRes(); let passed = false; lim(req, res, () => { passed = true; }); return { passed, res }; };

{
  let clock = 1_000_000;
  const lim = makeRateLimiter({ env: { RATE_LIMIT_READS_PER_MIN: '3' }, now: () => clock });
  const A = { 'do-connecting-ip': '203.0.113.10' };
  const B = { 'do-connecting-ip': '203.0.113.11' };
  const r = [1, 2, 3, 4].map(() => drive(lim, fakeReq('GET', '/api/kpis', A)));
  check('three reads pass, the fourth is refused', r.slice(0, 3).every((x) => x.passed) && !r[3].passed && r[3].res.code === 429);
  const refusal = r[3].res;
  check('429 carries Retry-After in whole seconds to the end of the window', refusal.headers['retry-after'] === '60', refusal.headers['retry-after']);
  check('…and is never cached', refusal.headers['cache-control'] === 'no-store');
  check('…and says why in plain words',
    refusal.body?.error === 'too many requests from this address — try again in 60 seconds' && refusal.body.budget === 'reads' && refusal.body.limit === 3
    && /at most 3 requests for figures per minute/.test(refusal.body.detail) && /in 60 seconds/.test(refusal.body.detail),
    JSON.stringify(refusal.body));
  check('another client is untouched', drive(lim, fakeReq('GET', '/api/kpis', B)).passed);
  check('writes are a separate budget', drive(lim, fakeReq('POST', '/api/ledger/entry', A)).passed);
  clock += 30_000;
  const mid = drive(lim, fakeReq('GET', '/api/kpis', A));
  check('half-way through the window the wait has halved', !mid.passed && mid.res.headers['retry-after'] === '30', mid.res.headers['retry-after']);
  clock += 30_000;
  check('once the window ends, the client is answered again', drive(lim, fakeReq('GET', '/api/kpis', A)).passed);
}
{
  let clock = 5_000_000;
  const lim = makeRateLimiter({ env: {}, now: () => clock });
  const A = { 'cf-connecting-ip': '203.0.113.20' };
  const prov = Array.from({ length: 11 }, () => drive(lim, fakeReq('GET', '/api/probe/uber/rest', A)));
  check('provider calls: ten an hour by default, the eleventh refused',
    prov.slice(0, 10).every((x) => x.passed) && !prov[10].passed && prov[10].res.headers['retry-after'] === '3600');
  check('…and the reason names the providers\' quotas, in minutes', /providers' quotas/.test(prov[10].res.body.detail)
    && /in 60 minutes/.test(prov[10].res.body.detail), prov[10].res.body.detail);
  check('the stored probe page is still answered after that', drive(lim, fakeReq('GET', '/api/probe/results', A)).passed);
  const chat = Array.from({ length: 21 }, () => drive(lim, fakeReq('POST', '/api/agent/chat', A)));
  check('chat: twenty per ten minutes by default, the twenty-first refused',
    chat.slice(0, 20).every((x) => x.passed) && !chat[20].passed && chat[20].res.headers['retry-after'] === '600');
  check('/api/health is exempt inside the limiter too', Array.from({ length: 700 }, () => drive(lim, fakeReq('GET', '/api/health', A))).every((x) => x.passed));
  check('pages and scripts are not budgeted', Array.from({ length: 700 }, () => drive(lim, fakeReq('GET', '/app.js', A))).every((x) => x.passed));
  /* The process calling itself. The assistant's tool calls (api/agent_routes.js,
     fetchApi) come from a loopback socket carrying the ASKER's cookie, no
     internal token and no forwarding header — every asker's calls alike. The
     first version budgeted them: all conversations then shared one
     '127.0.0.1' key, and each call was counted as 'req.ip' in health, the
     count the deploy check reads as "the platform sends neither header". */
  const agentLike = { cookie: 'fm_sid=not-a-real-session' };
  const self = Array.from({ length: 700 }, () => drive(lim, fakeReq('GET', '/api/kpis', agentLike, '127.0.0.1')));
  check('a self-call (loopback socket, no forwarding header) is not budgeted, even past 600 a minute',
    self.every((x) => x.passed), `${self.filter((x) => !x.passed).length} refused`);
  check('…in the IPv4-mapped and IPv6 loopback spellings too',
    ['::ffff:127.0.0.1', '::1'].every((a) => drive(lim, fakeReq('GET', '/api/kpis', {}, a)).passed));
  /* Relayed over loopback: anything in front of the process adds a forwarding
     header, and is budgeted by the address it names. */
  const relayed = Array.from({ length: 601 },
    () => drive(lim, fakeReq('GET', '/api/kpis', { 'x-forwarded-for': '203.0.113.30' }, '127.0.0.1')));
  check('a loopback request that carries a forwarding header is budgeted like any other',
    !relayed[600].passed && relayed.slice(0, 600).every((x) => x.passed));
  const viaHeader = drive(lim, fakeReq('GET', '/api/probe/uber/rest', { 'do-connecting-ip': '203.0.113.20' }, '127.0.0.1'));
  check('…including one that names a connecting-ip (that client is over its provider budget here)', !viaHeader.passed);
  const d = lim.describe(fakeReq('GET', '/api/health', {}));
  check('health counts which header keyed each request since boot, self-calls apart and never as req.ip',
    d.key_sources_since_boot['cf-connecting-ip'] === 11 + 1 + 21 && d.key_sources_since_boot['do-connecting-ip'] === 1
    && d.key_sources_since_boot['req.ip'] === 601 && d.self_calls_since_boot === 702,
    JSON.stringify({ ...d.key_sources_since_boot, self: d.self_calls_since_boot }));
  check('…and how many were refused', d.refused_since_boot === 4, String(d.refused_since_boot));
  check('…with no address in it', !/\d+\.\d+\.\d+\.\d+/.test(JSON.stringify(d)), JSON.stringify(d));
  check('a health request that is itself a self-call says so',
    lim.describe(fakeReq('GET', '/api/health', {}, '127.0.0.1')).key_source_this_request === 'self-call (exempt)');
}
{
  const lim = makeRateLimiter({ env: { RATE_LIMIT: 'off', RATE_LIMIT_READS_PER_MIN: '1' } });
  check('RATE_LIMIT=off switches the budget off', [1, 2, 3].every(() => drive(lim, fakeReq('GET', '/api/kpis', {})).passed));
  check('…and health says so', lim.describe().enabled === false && /RATE_LIMIT=off/.test(lim.describe().reason));
}
check('the refusal body is shaped the way data.js prints it ({error, detail})',
  (() => { const x = refusalBody('writes', { limit: 60, window_s: 60, what: 'changes' }, 1); return x.error && /in 1 second\./.test(x.detail); })());
/* payouts.js prints `error` alone on a refusal: the wait must be in it. */
check('`error` alone still says when to retry', /try again in 41 minutes$/.test(refusalBody('provider', BUDGETS.provider, 2460).error),
  refusalBody('provider', BUDGETS.provider, 2460).error);

/* Over real HTTP, through Express, the order server.js uses. */
{
  const app = express();
  const lim = makeRateLimiter({ env: { RATE_LIMIT_WRITES_PER_MIN: '2' } });
  app.use(lim);
  app.use(express.json());
  app.post('/api/ledger/entry', (_q, r) => r.json({ ok: true }));
  const srv = await listen(app);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = () => fetch(`${base}/api/ledger/entry`, { method: 'POST', headers: { 'content-type': 'application/json', 'do-connecting-ip': '192.0.2.44' }, body: '{}' });
  const s = [];
  for (let i = 0; i < 3; i += 1) { const r = await post(); s.push([r.status, r.headers.get('retry-after'), await r.json()]); }
  check('over HTTP: the third change in a minute is 429 with Retry-After',
    s[0][0] === 200 && s[1][0] === 200 && s[2][0] === 429 && Number(s[2][1]) >= 59 && s[2][2].budget === 'writes', JSON.stringify(s));
  srv.close();
}

/* ── 4. memory is bounded ───────────────────────────────────────────────── */
console.log('\nthe key map stops at its cap');
{
  let clock = 9_000_000;
  const lim = makeRateLimiter({ env: { RATE_LIMIT_MAX_KEYS: '5', RATE_LIMIT_READS_PER_MIN: '3' }, now: () => clock });
  const results = [];
  for (let i = 0; i < 20; i += 1) results.push(drive(lim, fakeReq('GET', '/api/kpis', { 'do-connecting-ip': `198.51.100.${i + 1}` })));
  check('twenty fresh keys hold at most five entries', lim.size() === 5, String(lim.size()));
  check('the five tracked keys passed', results.slice(0, 5).every((x) => x.passed));
  check('new keys past the cap share one budget: three pass, the rest are refused',
    results.slice(5, 8).every((x) => x.passed) && results.slice(8).every((x) => !x.passed), results.map((x) => (x.passed ? 1 : 0)).join(''));
  check('health reports the overflow', lim.describe().overflow_since_boot === 15, String(lim.describe().overflow_since_boot));
  check('a tracked client keeps its own budget under the flood',
    drive(lim, fakeReq('GET', '/api/kpis', { 'do-connecting-ip': '198.51.100.1' })).passed);
  clock += 61_000;
  const fresh = drive(lim, fakeReq('GET', '/api/kpis', { 'do-connecting-ip': '198.51.100.200' }));
  check('once windows end the sweep frees room for a new key of its own', fresh.passed && lim.size() === 1, String(lim.size()));
}
{
  /* A full map under a flood of fresh keys, with nothing in it able to expire
     for an hour: the first version walked all of it for every newcomer. */
  let clock = 20_000_000;
  const lim = makeRateLimiter({ env: { RATE_LIMIT_MAX_KEYS: '50' }, now: () => clock });
  for (let i = 0; i < 50; i += 1) drive(lim, fakeReq('GET', '/api/probe/uber/rest', { 'do-connecting-ip': `198.51.100.${i + 1}` }));
  const before = lim.sweeps();
  for (let i = 0; i < 2000; i += 1) {
    clock += 1;
    drive(lim, fakeReq('GET', '/api/kpis', { 'do-connecting-ip': `203.0.${Math.floor(i / 250)}.${(i % 250) + 1}` }));
  }
  check('2,000 fresh keys against a full map walk it at most once, not once each',
    lim.size() === 50 && lim.sweeps() - before <= 1, `${lim.sweeps() - before} walks, ${lim.size()} held`);
}
{
  /* …and still free room as soon as something CAN expire, before the next
     once-a-minute sweep would. K0 at t0 and K1..K4 at t0+30 s fill the map
     (cap 5, reads windows of 60 s); the sweep at t0+61 s frees K0 and admits
     N1; at t0+91 s K1..K4 have expired and only the full-map walk can see it. */
  let clock = 30_000_000;
  const lim = makeRateLimiter({ env: { RATE_LIMIT_MAX_KEYS: '5', RATE_LIMIT_READS_PER_MIN: '1' }, now: () => clock });
  const k = (n) => fakeReq('GET', '/api/kpis', { 'do-connecting-ip': `198.51.100.${n}` });
  drive(lim, k(1));
  clock += 30_000;
  for (let n = 2; n <= 5; n += 1) drive(lim, k(n));
  clock += 31_000;
  drive(lim, k(100));                          // the periodic sweep frees K0; N1 takes its place
  drive(lim, k(101));                          // map full, nothing expired: overflow (spends its one read)
  clock += 30_000;
  const n2 = drive(lim, k(102));
  check('a newcomer gets an entry of its own once the earliest window has ended, between minute sweeps',
    n2.passed && lim.size() === 2, `passed ${n2.passed}, ${lim.size()} held`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
