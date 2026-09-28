#!/usr/bin/env node
/* The access layer in front of PRODUCTION's data — for testing every role on
   every page before anything is deployed.
   ─────────────────────────────────────────────────────────────────────────
   The sign-in, the gate, the manifest and the shaper that run here are the
   files that will ship (api/access/*): identify → gate → the answer. Only the
   route handlers are replaced: a GET under /api is fetched from the deployed
   app (read-only, anonymously — sign-in is not required there yet) and handed
   to res.json, so the shaper filters production's real answer for the role
   asking, exactly as it will filter the local handler's answer once deployed.

   NEVER A WRITE. Anything that is not a GET, outside /api/auth, /api/access
   and /api/fleets (which run locally against a scratch database), is answered 501
   here and never forwarded. There is no code path that sends a POST upstream.

   People, sessions and grants live in a local Postgres (DATABASE_URL, default
   the sweep database on 127.0.0.1:55432). Production answers are cached on
   disk (GATEWAY_CACHE) so a second sweep does not ask production again.

       DATABASE_URL=postgres://fleet@127.0.0.1:55432/fleet_sweep PORT=8500 node bin/access-gateway.mjs */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

process.env.DATABASE_URL ||= 'postgres://fleet@127.0.0.1:55432/fleet_sweep';
process.env.DATABASE_SSL ||= 'false';
const UP = process.env.UPSTREAM || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const CACHE_DIR = process.env.GATEWAY_CACHE || join(dirname(fileURLToPath(import.meta.url)), '..', '.gateway-cache');
mkdirSync(CACHE_DIR, { recursive: true });

const { pool, migrate } = await import('../src/db.js');
const { log } = await import('../src/log.js');
const { accessLayer } = await import('../api/access/middleware.js');
const { accessRoutes } = await import('../api/access/routes.js');
const { fleetNameRoutes } = await import('../api/fleet_names_routes.js');
const { pgTx } = await import('../api/tx.js');

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public');
await migrate();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
const layer = accessLayer({ db: pool, log });
app.use(layer.identify);
app.use(layer.gate);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(500).json({ error: 'internal', detail: String(e).slice(0, 200) });
});
accessRoutes(app, { db: pool, layer, wrap, log });
/* The fleet-names routes are new with this change and not on production yet,
   so they run here against the sweep database, like the access routes. */
fleetNameRoutes(app, { q: (t, p) => pool.query(t, p).then((r) => r.rows), wrap, db: pool, tx: pgTx(pool), log });

/* Answers from production, kept on disk by URL. */
const inflight = new Map();
async function upstreamJson(pathAndQuery) {
  const key = createHash('sha1').update(pathAndQuery).digest('hex');
  const file = join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    let last;
    for (let i = 0; i < 4; i += 1) {
      try {
        const r = await fetch(`${UP}${pathAndQuery}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(150_000) });
        const type = r.headers.get('content-type') || '';
        const text = await r.text();
        const out = { status: r.status, type, text, withheld: r.headers.get('x-export-withheld') };
        if (r.status < 500) writeFileSync(file, JSON.stringify(out));
        return out;
      } catch (e) { last = e; await new Promise((ok) => setTimeout(ok, 500 * 2 ** i)); }
    }
    return { status: 502, type: 'application/json', text: JSON.stringify({ error: 'upstream', detail: String(last) }) };
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

app.use('/api', async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(501).json({ error: 'sweep_readonly', detail: 'The sweep gateway never forwards a change to production.' });
  }
  /* The query as the GATE left it — a one-fleet reader's filter has been
     narrowed to their fleet, and that narrowed question is what is asked. */
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (Array.isArray(v)) v.forEach((x) => qs.append(k, x)); else if (v != null) qs.append(k, String(v));
  }
  const pq = `/api${req.path}${qs.toString() ? `?${qs}` : ''}`;
  const r = await upstreamJson(pq);
  res.status(r.status);
  if (/json/.test(r.type)) {
    let body;
    try { body = JSON.parse(r.text); } catch { return res.type(r.type).send(r.text); }
    return res.json(body);
  }
  return res.type(r.type || 'text/plain').send(r.text);
});

app.use(express.static(pub, { etag: false, maxAge: 0 }));
app.get('/signin', (_, res) => res.sendFile(join(pub, 'signin.html')));
app.get('*', (_, res) => res.sendFile(join(pub, 'index.html')));

const port = Number(process.env.PORT || 8500);
app.listen(port, '127.0.0.1', () => log.info('gateway', `access gateway on :${port} over ${UP} (read-only)`));
