/* OPERATIONS BASICS: the liveness answer, and a request budget per client.
   ─────────────────────────────────────────────────────────────────────────
   Two things the system audit of 2026-11-12 found missing, mounted by
   api/server.js BEFORE the access layer identifies the caller. Both are here
   rather than in server.js because they must run before anything that can
   touch the database, and because they are small enough to test whole, with
   no pool and no listening server behind them.

   ── 1. /api/health MUST NOT WAIT FOR THE DATABASE ─────────────────────────
   The route itself was always memory-only — `{ ok, migrating }` — but it was
   registered after `app.use(access.identify)`, and identify() runs for every
   /api path. Its first act is `svc.getConfig(db)`: a query against
   access_config, on the same eight-connection pool the heavy reads share.
   Measured on production 2026-11-12: /api/admin-mode, whose handler touches
   no database at all (server.js; it is never cached), took 7.96 s cold — time
   that can only have gone on the middleware in front of it, identify() and the
   gate; and 4,502 queries ran 2.5 s or longer in 19 hours of log (p90 12.7 s,
   max 71 s). When those fill the pool, the
   platform's probe (http_path /api/health, every 15 s) queues behind them,
   times out, and the platform restarts the API — which empties the response
   cache and makes the next wave of traffic entirely cold. server.js's
   /api/ready comment describes that loop; it was closed for /api/ready and
   left open for the route the platform actually calls.

   So health is answered first, from memory, before identify(), the migration
   gate's neighbours, the rate limiter and the cache. What it says:

     ok          always true — the process is up and its event loop turns.
     migrating   true until migrate() resolves. The platform relies on this
                 answer being 200 while migrations run (server.js's boot
                 comment: a closed or failing port during a slow migration
                 read as a failed deploy and rolled a good commit back).
     commit      the git commit this process was built from, from COMMIT_SHA,
                 which the app spec binds to DigitalOcean's ${_self.COMMIT_HASH}
                 (collector/deploy/app-spec.redacted.yaml). Absent, empty, a
                 placeholder DigitalOcean did not expand, or anything that is
                 not a commit hash: null, with commit_reason saying which —
                 never a guessed value. Until now the only way to tell what
                 was live was HANDOFF §9's sw.js trick.
     frontend    the shell fingerprint the service worker serves —
                 'fleet-' + 12 hex, the same string /sw.js writes into its
                 VERSION line — or null with frontend_reason.
     started_at, uptime_s   when this process started, and how long ago.
     rate_limit  the budget's own state (below), with NO address in it.

   ── 2. A REQUEST BUDGET PER CLIENT ────────────────────────────────────────
   Nothing limited how fast anyone could ask. The only throttle was the
   in-memory sign-in one in api/access/routes.js, which this does not touch
   (a sign-in still meets that one after this). One client looping a cold
   15-second endpoint takes the pool from everyone; one client looping a probe
   route spends the providers' quotas with the fleet's own credentials.

   Budgets, per client, each env-overridable (a positive integer; anything
   else is ignored with a warning and the default kept):

     reads     GET/HEAD/OPTIONS            600 a minute    RATE_LIMIT_READS_PER_MIN
     writes    every other method           60 a minute    RATE_LIMIT_WRITES_PER_MIN
     chat      /api/agent/chat              20 per 10 min  RATE_LIMIT_CHAT_PER_10MIN
     provider  routes that call a provider  10 an hour     RATE_LIMIT_PROVIDER_PER_HOUR

   Each request is charged to exactly one budget, the most specific that
   matches: provider, then chat, then writes or reads by method. The provider
   routes are /api/probe/* plus four named actions (PROVIDER_PATHS) — except
   /api/probe/results, which is NOT a provider call: it reads the stored
   provider_probe table (api/analytics_routes.js says "a page load must never
   be able to spend somebody else's API quota") and the Providers page
   (api/public/providers.js) fetches it on every open. Ten an hour would have
   broken that page for no protection at all.

   The windows are fixed and anchored at the client's first request in them:
   "600 in a minute" means the 601st request inside the minute that began with
   the first one is refused until that minute ends, and Retry-After says when.
   A refusal is 429 with a plain-English reason in the same {error, detail}
   shape api/public/data.js already prints ("429 too many requests: …"), and
   Cache-Control: no-store so no cache keeps it.

   Exempt: /api/health (above), and the process calling itself over loopback.
   Two kinds of self-call exist, and both are exempt:
     - the cache warmer (api/warm.js) and the stale-revalidate refresh
       (api/cache.js) carry the per-process internal token from a loopback
       socket; that is exactly what identify() calls kind 'system', and the
       rule is the same function, isInternal(), so the two can never disagree;
     - the assistant's tool calls (api/agent_routes.js, fetchApi) carry the
       ASKER's cookie and no token — on purpose, so the gate shapes each
       answer to the asker's access — from a loopback socket.
   The second kind was budgeted at first (review of 2026-11-12), and it was
   wrong twice over. Every asker's tool calls arrive from 127.0.0.1 with no
   connecting-ip header, so ALL of them shared one '127.0.0.1' key: 600 reads
   a minute for every conversation on the server together, one busy asker
   starving the rest. And each was counted under 'req.ip' in health — the
   very count the deploy check reads as "the platform sends neither header,
   readers share one key, switch the budget off". They are already paid for:
   the chat request that caused them spent its asker's chat budget (20 per
   10 minutes), and one turn is capped at MAX_STEPS model steps.
   selfCall() below is the rule: a loopback socket AND none of the headers a
   relaying proxy adds (X-Forwarded-For, Forwarded, X-Real-IP, the two
   connecting-ip headers). A reader's request reaches the container from
   App Platform's router over the container network, never over loopback —
   the image runs `node api/server.js` directly, with nothing in front of it
   inside the container — and anything that did relay over loopback would
   add X-Forwarded-For (it is what `trust proxy` reads). Were that ever
   wrong, the cost is those requests going unbudgeted — the state before
   this budget existed — not a reader locked out. A loopback request that
   DOES carry a forwarding header is budgeted by it like any other. Health
   counts self-calls separately (self_calls_since_boot), never as 'req.ip'.
   The same rule keeps a local test that starts the real server and drives
   it from 127.0.0.1 (signin_page, access_pages) clear of the budget.

   ── WHICH ADDRESS IS "THE CLIENT" — verified and assumed ─────────────────
   The key is the first of these that holds exactly one valid IP address:
     1. the `do-connecting-ip` header,
     2. the `cf-connecting-ip` header,
     3. req.ip (server.js sets `trust proxy` 1: the address the nearest proxy
        reports in X-Forwarded-For, else the socket's).
   VERIFIED (measured 2026-11-12): production answers through Cloudflare —
   `server: cloudflare` and a `cf-ray` on every response — so there are at
   least two proxies between a reader and this process, Cloudflare and
   App Platform's own router, and req.ip under `trust proxy` 1 can be a
   Cloudflare edge address that thousands of unrelated clients share. That is
   why it is the last resort and not the key.
   ASSUMED, NOT VERIFIED from here: that App Platform sets `do-connecting-ip`
   to the reader's address on every request and overwrites any value the
   reader sent; and that `cf-connecting-ip` reaches the container as
   Cloudflare set it. Nothing reachable from this sandbox echoes request
   headers, so neither could be observed. /api/health therefore reports — by
   header NAME only, never a value — which source keyed the last budgeted
   request, how many requests each source has keyed since boot, which one this
   health request itself would use, and how many header values were refused as
   not-an-address. On production, a stream of 'req.ip' means the platform did
   not send either header and every reader may be sharing one key.
   If the platform turns out to pass a client-sent `do-connecting-ip` through
   unchanged, a client could rotate keys to escape its budget; the key map's
   cap (below) still bounds memory, and the overflow bucket then budgets every
   new key together, so such a client is still limited once the map is full.

   Hardening that follows from the key being a header value:
     - only a value that is exactly one IPv4 or IPv6 address is used. A list
       ("a, b" — which is also what Node makes of a header sent twice) or
       anything else is refused and the next source is tried: a guessed
       address is worse than a coarser one, and a 16 KB "address" would turn
       the key map into a memory sink;
     - IPv6 addresses are keyed by their /64. One subscriber is normally given
       a whole /64, so a per-address key would hand each of them 2^64 budgets;
     - an IPv4-mapped IPv6 address (::ffff:a.b.c.d) is keyed as the IPv4 one.

   ── MEMORY IS BOUNDED ────────────────────────────────────────────────────
   One entry per client key, holding up to four small counters. Entries whose
   windows have all ended are swept at most once a minute, and when the map is
   full and a new key arrives — but then only once the earliest window held
   can have ended, and at most once a second. The first version swept on
   EVERY new key while full: with 10,000 live entries that is a 10,000-step
   walk per request that frees nothing (no window can end sooner than the
   earliest one held), so a flood of fresh keys — exactly the case the cap
   exists for — bought a full scan of the map with each refused request
   (review of 2026-11-12; test/ops_health_budget.test.mjs counts the walks).
   At RATE_LIMIT_MAX_KEYS (default 10,000 — this dashboard has tens
   of readers) a NEW key is not added: it shares one overflow entry with every
   other new key until the sweep frees room. Clients already tracked keep
   their own budgets; under a flood of fresh keys, the newcomers are budgeted
   together rather than the map growing without end or evicting real readers'
   counters (which would hand a key-rotating client fresh budgets forever).

   Set RATE_LIMIT=off to switch the whole budget off; health then says so. */
import { isIP } from 'node:net';
import { isInternal } from './access/internal.js';

/* When this process started — computed once, from the process clock rather
   than from when this module was first imported. */
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000));

/* ── the build's commit ─────────────────────────────────────────────────── */

/* COMMIT_SHA is bound at deploy to ${_self.COMMIT_HASH}. When DigitalOcean
   cannot resolve a bindable reference it can leave the literal text in place,
   and a literal '${_self.COMMIT_HASH}' printed as the commit would be a lie
   that looks like an answer. Every way this can fail is named, and the value
   itself is never echoed when it is not a commit hash: whatever ended up in
   the variable by mistake is not this route's to publish. */
export function commitFrom(env = process.env) {
  const SPEC = 'collector/deploy/app-spec.redacted.yaml binds COMMIT_SHA to ${_self.COMMIT_HASH} on both components';
  if (env.COMMIT_SHA === undefined) {
    return { commit: null,
      commit_reason: `COMMIT_SHA is not set in this process's environment, so the commit it was built from is not known here (${SPEC}; add it in DigitalOcean).` };
  }
  const v = String(env.COMMIT_SHA).trim();
  if (!v) {
    return { commit: null,
      commit_reason: `COMMIT_SHA is set but empty, so DigitalOcean gave no commit for this build (${SPEC}).` };
  }
  if (v.includes('${')) {
    return { commit: null,
      commit_reason: 'COMMIT_SHA still holds an unexpanded ${…} placeholder: DigitalOcean did not substitute '
        + 'the bindable variable. Check that the value is exactly ${_self.COMMIT_HASH} and that the component '
        + 'builds from a git source.' };
  }
  if (!/^[0-9a-f]{7,40}$/i.test(v)) {
    return { commit: null,
      commit_reason: 'COMMIT_SHA is set but is not a git commit hash (7 to 40 hexadecimal characters), so it is '
        + 'not reported as one.' };
  }
  return { commit: v.toLowerCase() };
}

/* ── the front end's fingerprint ────────────────────────────────────────── */

/* server.js computes `shellHash` once at boot, over every file the service
   worker can cache, and /sw.js serves `fleet-<shellHash>`. When hashing failed
   it is null and /sw.js serves the literal VERSION written in
   api/public/sw.js — a string that names no build, so it is not reported as
   one. */
export function frontendFrom(hash) {
  if (typeof hash === 'string' && /^[0-9a-f]{12}$/.test(hash)) return { frontend: `fleet-${hash}` };
  if (hash === null || hash === undefined) {
    return { frontend: null,
      frontend_reason: 'The front-end files could not be hashed when this process started (the API log says '
        + '"could not hash the shell"), so /sw.js serves the literal version written in api/public/sw.js, '
        + 'which does not identify a build.' };
  }
  return { frontend: null, frontend_reason: 'The shell fingerprint is not 12 hexadecimal characters, so it is not reported.' };
}

/* ── which client is asking ─────────────────────────────────────────────── */

/* Expand an IPv6 address to its eight groups (numbers), or null. */
function v6Groups(addr) {
  let s = addr.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);                      // a zone id says nothing about the client
  const v4 = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    s = `${s.slice(0, s.length - v4[0].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/* One budget key per client: an IPv4 address as itself, an IPv4-mapped IPv6
   address as its IPv4 form, any other IPv6 address as its /64. Null when the
   value is not exactly one address. */
export function addressKey(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v || v.length > 64) return null;
  const kind = isIP(v);
  if (kind === 4) return v;
  if (kind !== 6) return null;
  const g = v6Groups(v);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

export const KEY_SOURCES = ['do-connecting-ip', 'cf-connecting-ip', 'req.ip'];

/* The client's key and which source gave it. `invalid` counts header values
   that were present but refused, so health can say they happened. */
export function clientKey(req) {
  let invalid = 0;
  for (const name of ['do-connecting-ip', 'cf-connecting-ip']) {
    const v = req.headers?.[name];
    if (v === undefined) continue;
    const key = addressKey(Array.isArray(v) ? v.join(', ') : v);
    if (key) return { key, source: name, invalid };
    invalid += 1;
  }
  const ip = addressKey(req.ip) || addressKey(req.socket?.remoteAddress) || 'unknown';
  return { key: ip, source: 'req.ip', invalid };
}

/* Is this the process calling itself? A loopback socket, and none of the
   headers a relaying proxy adds — see "Exempt:" in the header for why both,
   and why the assistant's tool calls depend on it. The loopback spellings are
   the three api/access/internal.js accepts for isInternal(). */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const RELAYED = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'do-connecting-ip', 'cf-connecting-ip'];
export function selfCall(req) {
  if (!LOOPBACK.has(String(req.socket?.remoteAddress || ''))) return false;
  return RELAYED.every((h) => req.headers?.[h] === undefined);
}

/* ── which budget a request spends ──────────────────────────────────────── */

export const BUDGETS = {
  reads: { env: 'RATE_LIMIT_READS_PER_MIN', limit: 600, window_s: 60,
    what: 'requests for figures' },
  writes: { env: 'RATE_LIMIT_WRITES_PER_MIN', limit: 60, window_s: 60,
    what: 'changes (saves, uploads, sign-ins and other actions)' },
  chat: { env: 'RATE_LIMIT_CHAT_PER_10MIN', limit: 20, window_s: 600,
    what: 'questions to the assistant' },
  provider: { env: 'RATE_LIMIT_PROVIDER_PER_HOUR', limit: 10, window_s: 3600,
    what: 'actions that call an outside provider (Uber, Bolt, Yango, FMS, Tesla or the AI analyst) '
      + "with the fleet's own credentials" },
};

/* The provider-calling actions outside /api/probe/*. Each of these spends a
   provider's quota or mints provider state on every call it is not refused:
     /api/finance/payouts/verify   asks Uber/Bolt for the payouts to compare
     /api/uber/fares/run           queues an Uber fares pass for the worker,
                                   which spends Uber's report slots (the route
                                   answers 409 while one is queued or running)
     /api/analyst/run              queues an analyst pass: a model call once
                                   the worker runs it (409 likewise; MiniMax
                                   was refusing with 402 "usage limit reached"
                                   on 2026-11-12)
     /api/tesla/connect            mints a Tesla sign-in link and stores its state
   The two queued actions already refuse a duplicate; the budget bounds how
   often a client can start a new pass once the last one has finished. */
export const PROVIDER_PATHS = new Set(['/api/finance/payouts/verify', '/api/uber/fares/run',
  '/api/analyst/run', '/api/tesla/connect']);
/* Under /api/probe/ but a database read — see the header. */
export const PROVIDER_EXEMPT = new Set(['/api/probe/results']);

/* The path budgets are decided on. Express matches routes case-insensitively
   and ignores one trailing slash, so `/api/Probe/uber/rest/` reaches the same
   handler as `/api/probe/uber/rest`; classifying the raw spelling would let a
   change of case move a provider call into the reads budget. (The access gate
   refuses a capitalised /API prefix and a trailing slash, but it runs after
   this, and capitals after the prefix it does not refuse.) Null for anything
   that is not under /api. */
export function budgetPath(path) {
  const p = String(path || '');
  if (!/^\/api(\/|$)/i.test(p)) return null;
  const lower = p.toLowerCase();
  return lower.length > 5 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
}

export function budgetFor(method, path) {
  const p = budgetPath(path) ?? String(path || '').toLowerCase();
  if (p === '/api/agent/chat') return 'chat';
  if ((p.startsWith('/api/probe/') && !PROVIDER_EXEMPT.has(p)) || PROVIDER_PATHS.has(p)) return 'provider';
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'reads' : 'writes';
}

const positiveInt = (v) => (typeof v === 'string' && /^\s*\d+\s*$/.test(v) && Number(v) > 0 ? Number(v) : null);

/* The effective budgets: defaults, overridden by a positive integer in the
   named variable. A value that is not one is reported and ignored — a typo
   must not switch a budget off, and must not pass silently either. */
export function resolveBudgets(env = process.env, log = null) {
  const out = {};
  for (const [name, b] of Object.entries(BUDGETS)) {
    const raw = env[b.env];
    const n = positiveInt(raw);
    if (raw !== undefined && n === null) {
      log?.warn?.('ratelimit', `${b.env} is not a positive whole number — keeping the default ${b.limit}`);
    }
    out[name] = { limit: n ?? b.limit, window_s: b.window_s, from_env: n !== null, env: b.env, what: b.what };
  }
  return out;
}

const per = (s) => (s === 60 ? 'minute' : s === 600 ? '10 minutes' : s === 3600 ? 'hour'
  : `${s} seconds`);
const wait = (s) => (s < 120 ? `${s} second${s === 1 ? '' : 's'}`
  : `${Math.ceil(s / 60)} minutes`);

/* The 429 body. Plain words, and true ones: the limit is per network address,
   so several people behind one office connection share it. `error` carries
   the wait as well as the word, because not every page prints `detail`:
   api/public/data.js shows "429 <error>: <detail>", but the payout
   verification panel (payouts.js) shows `error` alone, and "too many
   requests" with no time in it would leave the reader guessing when to retry. */
export function refusalBody(name, b, retryAfter) {
  return {
    error: `too many requests from this address — try again in ${wait(retryAfter)}`,
    budget: name,
    limit: b.limit,
    window_s: b.window_s,
    retry_after_s: retryAfter,
    detail: `This dashboard answers at most ${b.limit} ${b.what} per ${per(b.window_s)} from one network `
      + `address, and that many have come from yours in the current ${per(b.window_s)}. It will answer again `
      + `in ${wait(retryAfter)}. Nothing is wrong with the figures: the limit keeps one busy client from `
      + `slowing the dashboard for everyone${name === 'provider' ? " and from spending the providers' quotas" : ''}.`,
  };
}

/* ── the limiter ────────────────────────────────────────────────────────── */

export function makeRateLimiter({ env = process.env, now = Date.now, log = null } = {}) {
  const enabled = String(env.RATE_LIMIT || '').trim().toLowerCase() !== 'off';
  const budgets = resolveBudgets(env, log);
  const maxKeys = positiveInt(env.RATE_LIMIT_MAX_KEYS) ?? 10_000;
  if (env.RATE_LIMIT_MAX_KEYS !== undefined && positiveInt(env.RATE_LIMIT_MAX_KEYS) === null) {
    log?.warn?.('ratelimit', 'RATE_LIMIT_MAX_KEYS is not a positive whole number — keeping 10000');
  }
  const SWEEP_MS = 60_000;
  const FULL_SWEEP_MS = 1_000;
  const clients = new Map();          // key → { b: { [budget]: { n, reset } }, until }
  const overflow = { b: {}, until: 0 };
  const sources = Object.fromEntries(KEY_SOURCES.map((s) => [s, 0]));
  let lastSource = null;
  let invalidHeaders = 0;
  let refused = 0;
  let overflowed = 0;
  let selfCalls = 0;
  let lastSweep = 0;
  let sweeps = 0;
  /* No entry held can expire before this: the smallest `until` the last sweep
     kept, lowered as entries are added. An entry's `until` only ever grows,
     so it stays a true lower bound — a sweep before it cannot free anything. */
  let nextExpiry = Infinity;

  const sweep = (t) => {
    let soonest = Infinity;
    for (const [k, c] of clients) {
      if (c.until <= t) clients.delete(k);
      else if (c.until < soonest) soonest = c.until;
    }
    nextExpiry = soonest;
    lastSweep = t;
    sweeps += 1;
  };

  function limiter(req, res, next) {
    if (!enabled) return next();
    const path = budgetPath(req.path);
    if (path === null || path === '/api/health') return next();
    if (isInternal(req)) return next();
    /* The assistant's tool calls and any other self-call — see "Exempt:". */
    if (selfCall(req)) { selfCalls += 1; return next(); }

    const t = now();
    const { key, source, invalid } = clientKey(req);
    lastSource = source;
    sources[source] += 1;
    invalidHeaders += invalid;
    if (t - lastSweep >= SWEEP_MS) sweep(t);

    let c = clients.get(key);
    if (!c) {
      /* Full: walk the map only when something in it can have expired, and
         not more than once a second — under a flood of fresh keys whose
         entries expire one by one, each expiry would otherwise buy a walk. */
      if (clients.size >= maxKeys && t >= nextExpiry && t - lastSweep >= FULL_SWEEP_MS) sweep(t);
      if (clients.size >= maxKeys) { c = overflow; overflowed += 1; }
      else { c = { b: {}, until: 0 }; clients.set(key, c); }
    }
    const name = budgetFor(req.method, path);
    const b = budgets[name];
    let w = c.b[name];
    if (!w || w.reset <= t) {
      w = { n: 0, reset: t + b.window_s * 1000 };
      c.b[name] = w;
    }
    if (w.reset > c.until) c.until = w.reset;
    if (c !== overflow && c.until < nextExpiry) nextExpiry = c.until;
    if (w.n >= b.limit) {
      refused += 1;
      const retryAfter = Math.max(1, Math.ceil((w.reset - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      res.set('Cache-Control', 'no-store');
      return res.status(429).json(refusalBody(name, b, retryAfter));
    }
    w.n += 1;
    return next();
  }

  /* What /api/health shows. Header NAMES and counts only — no address, no
     key, nothing that identifies a reader. */
  limiter.describe = (req) => {
    if (!enabled) return { enabled: false, reason: 'RATE_LIMIT=off is set in the environment.' };
    return {
      enabled: true,
      key_source_last: lastSource,
      key_source_this_request: req ? (selfCall(req) ? 'self-call (exempt)' : clientKey(req).source) : null,
      key_sources_since_boot: { ...sources },
      /* Not in key_sources_since_boot: a self-call is not a reader, and
         counting it under 'req.ip' would fake the very signal the deploy
         check reads there. */
      self_calls_since_boot: selfCalls,
      invalid_header_values_since_boot: invalidHeaders,
      clients_tracked: clients.size,
      max_clients: maxKeys,
      overflow_since_boot: overflowed,
      refused_since_boot: refused,
      budgets: Object.fromEntries(Object.entries(budgets)
        .map(([k, v]) => [k, { limit: v.limit, window_s: v.window_s, from_env: v.from_env }])),
    };
  };
  /* For tests: the number of entries held, overflow excluded, and how many
     times the map has been walked. */
  limiter.size = () => clients.size;
  limiter.sweeps = () => sweeps;
  return limiter;
}

/* ── the health handler ─────────────────────────────────────────────────── */

/* `migrating` and `frontend` are getters, read per request: server.js's
   migration flag flips once migrate() resolves, and the shell hash is a const
   declared much further down that file than this handler is mounted. A getter
   read before that line has run throws (the temporal dead zone) — impossible
   in practice, since nothing listens until the module has finished, but if it
   ever happens the answer is "not known yet", not a crash of the liveness
   probe. COMMIT_SHA cannot change inside a running process, so it is read once. */
export function makeHealth({ migrating, frontend, limiter = null, env = process.env }) {
  const commit = commitFrom(env);
  return function health(req, res) {
    let fe;
    try { fe = frontendFrom(frontend()); } catch {
      fe = { frontend: null, frontend_reason: 'The shell fingerprint has not been computed yet: the process is still starting.' };
    }
    let mig;
    try { mig = Boolean(migrating()); } catch { mig = true; }
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      migrating: mig,
      ...commit,
      ...fe,
      started_at: STARTED_AT.toISOString(),
      uptime_s: Math.round(process.uptime()),
      rate_limit: limiter?.describe ? limiter.describe(req)
        : { enabled: false, reason: 'No request budget is mounted in this process.' },
    });
  };
}
