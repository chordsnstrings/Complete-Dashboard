#!/usr/bin/env node
/* A read-only mirror of the PRODUCTION origin, on 127.0.0.1.
   ─────────────────────────────────────────────────────────────────────────
   Chromium in this sandbox has no route to the internet. Not to the app, not
   to example.com, not through HTTPS_PROXY — a launch-level `proxy` option and
   an explicit --proxy-server both end in ERR_CONNECTION_RESET, while curl and
   Node's fetch reach the same hosts without trouble. So a screenshot of
   production cannot be taken by pointing a browser at production.

   bin/live-ui.mjs solves the neighbouring problem — it serves the WORKING TREE
   against the production API — and that is the right tool while iterating on a
   change. It is the wrong tool for "prove this is live", because the HTML, the
   JavaScript and the CSS on screen are the ones on this disk.

   This serves NOTHING of its own. Every byte — index.html, app.js, app.css,
   every /api/ response — is fetched from the production origin by Node and
   passed through unmodified. What the browser renders is what production
   serves; the only thing localhost contributes is the TCP hop the browser
   cannot make itself.

   What that proves, and what it does not:

     ✓ production's markup, scripts, styles and data, rendered by a real
       browser engine, at a real viewport
     ✓ a regression that only appears in the deployed bundle
     ✗ nothing about DNS, TLS, the CDN edge or redirects — Node terminates
       those, and --verify below is what checks the bytes are unaltered

   GET only. No header is forwarded from the browser and no method other than
   GET is answered, so nothing here can write to the fleet.

       node bin/prod-mirror.mjs &                 # then browse 127.0.0.1:8200
       node bin/prod-mirror.mjs --verify          # hash every asset both ways
*/
import express from 'express';

const UP = process.env.UPSTREAM || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const PORT = Number(process.env.PORT || 8200);

/* Retried, because a render pass is a thousand requests through the egress
   proxy and a handful come back ECONNRESET. A non-2xx is passed straight
   through — that IS production's answer — and only a thrown fetch is retried. */
const RETRIES = 3;
async function upstream(path) {
  let last;
  for (let i = 0; i <= RETRIES; i += 1) {
    try {
      return await fetch(`${UP}${path}`, { redirect: 'follow' });
    } catch (e) {
      last = e;
      if (i === RETRIES) break;
      await new Promise((r) => setTimeout(r, 150 * 2 ** i));
    }
  }
  throw last;
}

if (process.argv.includes('--verify')) {
  /* The mirror is only worth anything if it is byte-exact. This fetches each
     asset twice — once from the origin, once through the running mirror — and
     compares SHA-256. Run it against a mirror that is already up. */
  const { createHash } = await import('node:crypto');
  const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 16);
  const idx = await (await upstream('/')).text();
  const assets = ['/', ...new Set([...idx.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)]
    .map((m) => `/${m[1]}`))];
  let bad = 0;
  for (const a of assets) {
    const [o, m] = await Promise.all([
      upstream(a).then((r) => r.arrayBuffer()),
      fetch(`http://127.0.0.1:${PORT}${a}`).then((r) => r.arrayBuffer()),
    ]);
    const ok = sha(o) === sha(m);
    if (!ok) bad += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${a.padEnd(22)} origin ${sha(o)}  mirror ${sha(m)}`);
  }
  console.log(`\n${assets.length} asset(s) compared, ${bad} differ  (${UP})`);
  process.exit(bad ? 1 : 0);
}

const app = express();
app.use(async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('mirror is read-only');
  try {
    const r = await upstream(req.originalUrl);
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type');
    if (ct) res.type(ct);
    /* No caching, or a screenshot after a deploy shows the build before it. */
    res.set('cache-control', 'no-store');
    return res.status(r.status).send(buf);
  } catch (e) {
    console.log(`  ✗ ${req.originalUrl} — ${String(e).slice(0, 90)}`);
    return res.status(502).send('upstream unreachable');
  }
});
app.listen(PORT, () => console.log(`production mirror on http://127.0.0.1:${PORT} → ${UP}`));
