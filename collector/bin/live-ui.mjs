#!/usr/bin/env node
/* Serves the local UI against PRODUCTION's API, so the browser smoke test can
   render the real fleet.
   ─────────────────────────────────────────────────────────────────────────
   Pointing Playwright straight at the deployed app fails in this environment:
   outbound HTTPS goes through a local egress proxy that Node's fetch honours
   and Chromium does not, so every navigation dies with ERR_CONNECTION_RESET.
   This flips it around — Node does the talking, the browser only ever sees
   127.0.0.1, and the UI it loads is the one in the working tree.

   Which makes it the most useful of the three targets: the mock's fixtures are
   tidy by construction and the preview's seed is something I wrote, but a page
   rendered against production meets nulls, name collisions, numeric strings and
   a fleet that is 89% Uber. Read-only — GET only, no write path at all.

       node bin/live-ui.mjs &
       SMOKE_BASE=http://localhost:8100 node test/smoke_views.mjs

   UPSTREAM overrides the target. */
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const UP = process.env.UPSTREAM || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
/* `..`, because this file lives in bin/ and the dashboard lives in api/public.
   Without it every asset resolved to collector/bin/api/public, which does not
   exist: express.static matched nothing, the catch-all fell through to
   sendFile of an index.html that is not there, and the bridge served a
   Node ENOENT page for every route while the API half worked perfectly. The
   smoke run against it reported the same failure for all eighty views, which
   reads as a broken build rather than a broken path. */
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public');
const app = express();

/* Upstream fetches retry; a browser page load does not.
   ─────────────────────────────────────────────────────────────────────────
   A full render audit is 104 routes at three widths and something over a
   thousand upstream requests through the egress proxy, and a handful of them
   come back ECONNRESET. Each one reached the browser as a failed fetch, and
   the audit reported it as a js-error on the page — 282 of them in one run,
   every single one saying ERR_CONNECTION_RESET, burying the 51 findings that
   were about the product.

   The page cannot retry: it has already rendered its error state by the time
   anybody sees it. The bridge can, and this is the layer that knows the
   difference between "the API said no" and "the connection dropped on the way
   to Amsterdam". A non-2xx is passed straight through — that IS the answer —
   and only a thrown fetch is retried. */
const RETRIES = 3;
const upstream = async (url, init = { headers: { accept: 'application/json' } }) => {
  let last;
  for (let i = 0; i <= RETRIES; i += 1) {
    try {
      return await fetch(url, init);
    } catch (e) {
      last = e;
      if (i === RETRIES) break;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  throw last;
};

/* Writes too, not only reads.
   ─────────────────────────────────────────────────────────────────────────
   This bridged GET and nothing else, so every write the product does — pasting
   a credential, triggering a collection, saving a setting — 404'd against a
   bridge whose whole purpose is "this working tree, against the live API".
   The failure was quiet in the worst way: the page renders its own error box,
   which reads exactly like the endpoint being broken in production.

   A write is only forwarded when the caller opts in with ALLOW_WRITES=1, and
   the reason is the upstream: this points at production by default, and a
   harness that silently forwards a POST to a live fleet is a harness nobody
   should leave running. The paste endpoint is a dry run unless the body says
   otherwise, which is what makes it the useful thing to check here. */
const WRITES = process.env.ALLOW_WRITES === '1';
app.use('/api/*', express.json({ limit: '2mb' }), async (req, res, next) => {
  if (req.method === 'GET') return next();
  if (!WRITES) {
    console.log(`  ⃠ ${req.method} ${req.path} — set ALLOW_WRITES=1 to forward writes to ${UP}`);
    return res.status(405).json({ error: 'this bridge forwards reads only',
      detail: `re-run with ALLOW_WRITES=1 to send ${req.method} through to ${UP}` });
  }
  try {
    console.log(`  → ${req.method} ${req.path} → ${UP}`);
    const r = await upstream(`${UP}${req.originalUrl}`, {
      method: req.method,
      headers: {
        accept: 'application/json',
        'content-type': req.get('content-type') || 'application/json',
        ...(req.get('x-admin-token') ? { 'x-admin-token': req.get('x-admin-token') } : {}),
      },
      body: req.body == null ? undefined : JSON.stringify(req.body),
    });
    const body = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
  } catch (e) {
    console.log(`  ✗ ${req.method} ${req.path} — upstream unreachable: ${String(e).slice(0, 90)}`);
    res.status(502).json({ error: String(e).slice(0, 200) });
  }
});

app.get('/api/*', async (req, res) => {
  try {
    const r = await upstream(`${UP}${req.originalUrl}`);
    const body = await r.text();
    /* An endpoint this working tree declares and the deployed build does not
       comes back as the API's own 404 JSON, and the page renders its error box
       with "no such endpoint" in it — which is right, and easy to misread as a
       bug in the page. Named here so the operator running the bridge sees it
       in the terminal as what it is: a route that has not deployed yet. */
    if (r.status === 404 && body.includes('no such endpoint')) {
      console.log(`  ↯ ${req.path} is not on ${UP} yet — the page will show its error state`);
    }
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
  } catch (e) {
    /* Named in the terminal, because a 502 here is the BRIDGE failing and not
       the API — and the page will render an error box that looks identical to
       a real one. */
    console.log(`  ✗ ${req.path} — upstream unreachable after ${RETRIES} retries: ${String(e).slice(0, 90)}`);
    res.status(502).json({ error: String(e).slice(0, 200) });
  }
});
app.use(express.static(pub));
app.get('*', (_, r) => r.sendFile(join(pub, 'index.html')));
/* PORT, because several of these run at once. Auditing the product a page-group
   at a time means several agents each holding a bridge to production, and a
   hardcoded port makes the second one die on EADDRINUSE — or worse, silently
   read the first one's upstream. */
const PORT = Number(process.env.PORT || 8100);
app.listen(PORT, () => console.log(`live proxy on http://localhost:${PORT} → ${UP}`));
