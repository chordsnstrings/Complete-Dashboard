/* ── the bytes a cold visit pays for ───────────────────────────────────────
   Two costs were being paid on every page by every visitor:

   1. Two webfont families fetched from fonts.googleapis.com. Before a single
      glyph arrived the browser did a DNS lookup and a TLS handshake to read a
      stylesheet, then a second lookup and handshake to fonts.gstatic.com to
      read the files it named. Four round trips to strangers, in front of the
      first paint, for files that never change.

   2. Leaflet — 147kb of script and 15kb of CSS — parsed and executed on the
      overview, the roster, the settlement page and thirty other views that
      never draw a map. Three views do.

   Both are now paid only when they are actually owed: the fonts come off this
   origin on the connection the page already has, and Leaflet is fetched the
   first time a map is drawn. These tests are about the ways that quietly
   regresses — a re-added CDN tag, a font file referenced but never committed,
   or a makeMap() call that forgets the change made it a promise. */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import compression from 'compression';
import { get as httpGet } from 'node:http';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const PUB = 'api/public';
const html = readFileSync(join(PUB, 'index.html'), 'utf8');
const mapJs = readFileSync(join(PUB, 'map.js'), 'utf8');
const fontsCss = readFileSync(join(PUB, 'fonts.css'), 'utf8');

console.log('\nfonts are served from this origin');

/* The whole point. A stylesheet link is the usual way this comes back — someone
   copies a snippet from a design tool — but a bare @import inside app.css costs
   the same round trips and is easier to miss, so look at every shipped file.

   Comments are stripped first, and not as a convenience: both files explain in
   prose why the Google host was dropped, and a test that cannot tell a fetch
   from a sentence about a fetch would forbid writing that down. */
const uncomment = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const shipped = ['index.html', 'app.css', 'fonts.css'].map((f) => [f, uncomment(readFileSync(join(PUB, f), 'utf8'))]);
for (const [name, body] of shipped) {
  check(`${name} names no third-party font host`,
    !/fonts\.(googleapis|gstatic)\.com/.test(body),
    '— a webfont is being fetched from Google again');
}

check('index.html links the local stylesheet', /<link[^>]+href="\/fonts\.css"/.test(html));

/* A preload for a file the page does not use is a wasted request, and a preload
   with the wrong crossorigin is worse: the font downloads twice, because a font
   fetched without CORS cannot satisfy a request that needs it. */
const preloads = [...html.matchAll(/<link[^>]+rel="preload"[^>]*>/g)].map((m) => m[0]);
check('every font preload is a woff2 with crossorigin',
  preloads.every((t) => /as="font"/.test(t) && /type="font\/woff2"/.test(t) && /\bcrossorigin\b/.test(t)),
  preloads.filter((t) => !/\bcrossorigin\b/.test(t)).join(' '));
check('preloaded fonts are files fonts.css actually asks for',
  preloads.map((t) => t.match(/href="([^"]+)"/)[1]).every((h) => fontsCss.includes(h.split('/').pop())),
  '— preloading a file no @font-face names');

/* The failure this catches is a deploy, not a diff: fonts.css is text and gets
   committed, the .woff2 files are binary and are exactly the sort of thing an
   over-broad .gitignore or a Docker build that copies only *.js quietly drops.
   The page then renders in Times New Roman with no error anywhere. */
const referenced = [...fontsCss.matchAll(/url\(([^)]+)\)/g)]
  .map((m) => m[1].replace(/['"]/g, '').trim())
  .filter((u) => !u.startsWith('data:'));
check('fonts.css references at least one file', referenced.length > 0);
const missing = referenced.filter((u) => !existsSync(join(PUB, u.replace(/^\//, ''))));
check('every file fonts.css names exists on disk', missing.length === 0, missing.join(', '));

/* Google serves these under the SIL Open Font License, which permits
   redistribution and requires the licence travel with the files. */
check('the licence ships with the fonts', existsSync(join(PUB, 'fonts', 'OFL.txt')));

/* unicode-range is what makes the split worth doing: without it the browser
   cannot tell the latin file from the latin-ext one and downloads both. */
const faces = fontsCss.split('@font-face').slice(1);
check('every @font-face carries a unicode-range',
  faces.length > 0 && faces.every((f) => f.includes('unicode-range')),
  `${faces.filter((f) => !f.includes('unicode-range')).length} of ${faces.length} without`);
check('every @font-face is font-display: swap',
  faces.every((f) => /font-display:\s*swap/.test(f)),
  '— a blocked paint while a font downloads is the thing self-hosting was meant to end');

console.log('\nleaflet is fetched only when a map is drawn');

check('index.html no longer loads leaflet',
  !/vendor\/leaflet/.test(html),
  '— back to 162kb on every view again');
check('map.js loads leaflet itself', /vendor\/leaflet\.js/.test(mapJs) && /vendor\/leaflet\.css/.test(mapJs));
check('the vendored files are still on disk',
  existsSync(join(PUB, 'vendor', 'leaflet.js')) && existsSync(join(PUB, 'vendor', 'leaflet.css')));

/* Leaflet resolves its marker images off a stylesheet rule. Injecting the CSS
   and the script together means the script can win, so we state the path. */
check('the marker image path is stated, not detected',
  /Icon\.Default\.imagePath\s*=\s*'\/vendor\/images\//.test(mapJs));
check('the marker images are there',
  existsSync(join(PUB, 'vendor', 'images', 'marker-icon.png')),
  '— L.marker would draw a broken image');

/* Caching a rejection would mean one dropped connection disables maps for the
   rest of the session, with a reload the only way out. */
check('a failed load is not cached', /leafletReady\s*=\s*null/.test(mapJs.split('catch')[1] || ''));

console.log('\nevery makeMap() call awaits it');

/* This is the regression the change itself creates. makeMap used to return a
   map object and now returns a promise for one; a call site that misses the
   await gets a Promise, and the very next line — L.layerGroup().addTo(map) —
   throws inside a panel that just says "Could not load this view". Grep is the
   right tool here precisely because it cannot be fooled by the page happening
   to work in whatever fixture a browser test loads. */
check('makeMap is async', /export async function makeMap/.test(mapJs));
const callers = ['app.js', 'driver.js', 'vehicle.js'];
let sites = 0;
for (const f of callers) {
  const src = readFileSync(join(PUB, f), 'utf8');
  for (const line of src.split('\n')) {
    // The definition and the import line are not call sites.
    if (!/\bmakeMap\s*\(/.test(line) || /function makeMap/.test(line)) continue;
    sites++;
    check(`${f}: ${line.trim()}`, /await\s+makeMap\s*\(/.test(line), '— missing await');
  }
}
check('all three map views were checked', sites === 3, `found ${sites}`);

console.log('\nresponses are compressed');

/* The largest single cost left on a first paint, and the one nothing was
   checking: app.js is 137kb on disk and 137kb was what went down the wire. */
const serverJs = readFileSync('api/server.js', 'utf8');
check('server.js mounts compression', /app\.use\(compression\(/.test(serverJs));

/* Before the routes AND before the response cache, or a cached answer — which
   is most answers — is the one thing that goes out uncompressed. */
const at = (re) => serverJs.search(re);
check('compression is mounted before the cache and the routes',
  at(/app\.use\(compression\(/) < at(/app\.use\('\/api', cache\)/)
  && at(/app\.use\(compression\(/) < at(/app\.use\(express\.static/),
  'mounted too late to wrap them');

/* And that it does what the mount assumes. The filter is the part worth
   checking: compressing a woff2 or a PNG spends CPU to make the file bigger,
   and gzipping a 40-byte JSON body costs more in headers than it saves. */
const probe = express();
probe.use(compression({ filter: (rq, rs) => rq.get('x-warm') !== '1' && compression.filter(rq, rs) }));
probe.get('/big.js', (_q, r) => r.type('application/javascript').send(readFileSync(join(PUB, 'app.js'))));
probe.get('/small', (_q, r) => r.json({ ok: 1 }));
probe.get('/font.woff2', (_q, r) => r.type('font/woff2').send(readFileSync(join(PUB, 'fonts', 'karla-latin.woff2'))));
const srv = probe.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
/* node:http rather than fetch, because fetch decompresses transparently and
   then reports the DECODED length — which is exactly the number this is
   supposed to be measuring the absence of. A first attempt here "proved"
   app.js still went over at 135kb while the response header said br. */
const hit = (path, extra = {}) => new Promise((resolve, reject) => {
  const req = httpGet(`${base}${path}`, { headers: { 'accept-encoding': 'gzip, deflate, br', ...extra } }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ enc: res.headers['content-encoding'] || null, bytes }));
  });
  req.on('error', reject);
});

const js = await hit('/big.js');
const appRaw = statSync(join(PUB, 'app.js')).size;
// br when the client offers it, gzip otherwise. Either is the point; neither being set is not.
check('a script is compressed', js.enc === 'br' || js.enc === 'gzip', `content-encoding: ${js.enc}`);
check(`app.js goes over the wire smaller than ${Math.round(appRaw / 1024)}kb`,
  js.bytes < appRaw / 2, `${Math.round(js.bytes / 1024)}kb of ${Math.round(appRaw / 1024)}kb`);

const tiny = await hit('/small');
check('a tiny body is left alone', tiny.enc === null, `content-encoding: ${tiny.enc}`);

/* The warmer fetches its own endpoints over loopback to fill the response
   cache and throws the bodies away. Compressing those is CPU the readers want. */
probe.get('/api/warmable', (_q, r) => r.json({ rows: Array.from({ length: 400 }, (_, i) => ({ plate: `L${i}`, trips: i })) }));
const cold = await hit('/api/warmable');
const warmed = await hit('/api/warmable', { 'x-warm': '1' });
check('an API answer is compressed for a reader', cold.enc === 'br' || cold.enc === 'gzip', `${cold.enc}`);
check('and left alone for the warmer', warmed.enc === null, `${warmed.enc}`);
check('the warmer still gets the whole body', warmed.bytes > cold.bytes, `${warmed.bytes} vs ${cold.bytes}`);

const font = await hit('/font.woff2');
const fontRaw = statSync(join(PUB, 'fonts', 'karla-latin.woff2')).size;
check('a woff2 is not re-compressed', font.enc === null, `content-encoding: ${font.enc}`);
check('and arrives whole', font.bytes === fontRaw, `${font.bytes} of ${fontRaw} bytes`);
srv.close();

console.log('\nboot: the port opens before the schema settles');

/* A deploy died in production because migrations queued behind a busy database:
   nothing listened until they finished, the readiness probe found a closed port
   eleven times, and the platform rolled back a commit with nothing wrong in it.
   The port must bind first, health must answer immediately, and every data
   route must refuse — 503, not 200, not a hang — until migrate() resolves. */
{
  const boot = express();
  let migrationsDone = false;
  boot.use((req2, res2, next2) => {
    if (migrationsDone || !req2.path.startsWith('/api/') || req2.path === '/api/health') return next2();
    res2.set('retry-after', '5');
    return res2.status(503).json({ error: 'starting' });
  });
  boot.get('/api/health', (_q, r2) => r2.json({ ok: true, migrating: !migrationsDone }));
  boot.get('/api/kpis', (_q, r2) => r2.json({ trips: 1 }));
  boot.get('/', (_q, r2) => r2.send('<html>'));
  const bs = boot.listen(0);
  await new Promise((r2) => bs.once('listening', r2));
  const bBase = `http://127.0.0.1:${bs.address().port}`;
  const g = async (path) => { const r2 = await fetch(`${bBase}${path}`); return { status: r2.status, body: await r2.json().catch(() => null), retry: r2.headers.get('retry-after') }; };

  const h1 = await g('/api/health');
  check('health answers 200 while migrations run', h1.status === 200 && h1.body?.migrating === true,
    JSON.stringify(h1));
  const d1 = await g('/api/kpis');
  check('a data route refuses with 503 and says when to retry',
    d1.status === 503 && d1.retry === '5', JSON.stringify(d1));
  const s1 = await fetch(`${bBase}/`);
  check('the static shell is not gated — a reader can load the page while it waits',
    s1.status === 200);

  migrationsDone = true;
  const h2 = await g('/api/health');
  const d2 = await g('/api/kpis');
  check('and everything serves once migrations resolve',
    h2.body?.migrating === false && d2.status === 200, JSON.stringify([h2.body, d2.status]));
  bs.close();
}

/* The gate in the real server has to match what was just proven: same predicate,
   health exempted by its full path, everything else held. */
const bootSrc = readFileSync('api/server.js', 'utf8');
/* The CALL, at the start of its line — 'migrate()' also appears in the prose
   explaining the gate, several hundred lines earlier. */
check('server.js binds the port before migrate()',
  bootSrc.indexOf('app.listen(port') < bootSrc.indexOf('\nmigrate()'),
  'migrate() still runs first');
check('and gates /api on the migration flag',
  /migrationsDone \|\| !req\.path\.startsWith\('\/api\/'\) \|\| req\.path === '\/api\/health'/.test(bootSrc));
check('and a failed migration still kills the process',
  /migrate failed — refusing to serve.*process\.exit\(1\)/.test(bootSrc));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
