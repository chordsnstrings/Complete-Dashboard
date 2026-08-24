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
const pub = join(dirname(fileURLToPath(import.meta.url)), 'api', 'public');
const app = express();
app.get('/api/*', async (req, res) => {
  try {
    const r = await fetch(`${UP}${req.originalUrl}`, { headers: { accept: 'application/json' } });
    const body = await r.text();
    res.status(r.status).type(r.headers.get('content-type') || 'application/json').send(body);
  } catch (e) { res.status(502).json({ error: String(e).slice(0, 200) }); }
});
app.use(express.static(pub));
app.get('*', (_, r) => r.sendFile(join(pub, 'index.html')));
/* PORT, because several of these run at once. Auditing the product a page-group
   at a time means several agents each holding a bridge to production, and a
   hardcoded port makes the second one die on EADDRINUSE — or worse, silently
   read the first one's upstream. */
const PORT = Number(process.env.PORT || 8100);
app.listen(PORT, () => console.log(`live proxy on http://localhost:${PORT} → ${UP}`));
