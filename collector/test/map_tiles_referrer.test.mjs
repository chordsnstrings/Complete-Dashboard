/* Map tiles carry a Referer, and nothing else in the product does.
   ─────────────────────────────────────────────────────────────────────────
   From 2026-09-28 every map rendered as a grid of OpenStreetMap's "Access
   blocked — App is not following the tile usage policy" images (HTTP 403).
   The hardening that day set `Referrer-Policy: same-origin` on every
   response, so a tile request to tile.openstreetmap.org left with no Referer,
   and OSM's tile policy refuses a browser request without one.

   The fix is on the tile layer alone: its images send the ORIGIN (site
   address, no path, no query). The page-wide header is not loosened — a URL
   here can carry a driver id and a date, and no other cross-origin request
   should learn it.

   REVERSION: drop `referrerPolicy: OSM_REFERRER` from the L.tileLayer(...)
   call in api/public/map.js — "the tile layer sets a referrer policy" fails;
   set OSM_REFERRER to 'same-origin' or 'no-referrer' — "…one that sends the
   origin cross-origin" fails; put the {s}. subdomain back in OSM — "tiles come
   from the single HTTPS host" fails. All three run 2026-09-29. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const map = readFileSync(new URL('../api/public/map.js', import.meta.url), 'utf8');
const leaflet = readFileSync(new URL('../api/public/vendor/leaflet.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');
/* Block comments only: stripping `//…` would eat the `//` in `https://`. */
const code = map.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\nthe tile layer');
const calls = [...code.matchAll(/L\.tileLayer\(([^)]*)\)/g)].map((m) => m[1]);
check('there is exactly one tile layer in the product', calls.length === 1, String(calls.length));
check('the tile layer sets a referrer policy', calls.every((c) => /referrerPolicy\s*:\s*OSM_REFERRER\b/.test(c)), calls.join(' | '));
const policy = (code.match(/const OSM_REFERRER\s*=\s*'([^']+)'/) || [])[1];
/* The policies under which a cross-origin HTTPS image request carries at
   least the origin. `same-origin` and `no-referrer` are what broke it. */
const SENDS_ORIGIN = ['strict-origin', 'origin', 'strict-origin-when-cross-origin', 'origin-when-cross-origin'];
check('…one that sends the origin cross-origin, and never the path', SENDS_ORIGIN.includes(policy), String(policy));
check('tiles come from the single HTTPS host, no {s} subdomains',
  /const OSM\s*=\s*'https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png'/.test(code));

console.log('\nthe library honours it, and the page-wide header is unchanged');
check('the vendored Leaflet copies the option onto the tile <img>',
  /referrerPolicy&&\(\w+\.referrerPolicy=this\.options\.referrerPolicy\)/.test(leaflet));
check('every response still says Referrer-Policy: same-origin',
  /res\.set\('Referrer-Policy', 'same-origin'\)/.test(server));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
