// Guards route ordering: the SPA catch-all (`app.get('*')`) must be registered
// after every /api route, otherwise it silently serves index.html for API calls
// and the dashboard shows empty panels with a 200 status.
import { readFileSync } from 'node:fs';

const src = readFileSync('api/server.js', 'utf8');
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const catchAll = src.indexOf("app.get('*'");
const staticAt = src.indexOf('express.static');
check('catch-all route exists', catchAll > -1);
check('static handler exists', staticAt > -1);

// every /api route declaration must appear before the catch-all
const apiRoutes = [...src.matchAll(/app\.(get|post)\((['"])(\/api\/[^'"]*)\2/g)]
  .map((m) => ({ path: m[3], at: m.index }));
check('api routes found', apiRoutes.length > 10, String(apiRoutes.length));

const shadowed = apiRoutes.filter((r) => r.at > catchAll).map((r) => r.path);
check('no /api route is shadowed by the catch-all', shadowed.length === 0, shadowed.join(', '));

// the catch-all must be the last route registered
const lastApi = Math.max(...apiRoutes.map((r) => r.at));
check('catch-all is registered after the last api route', catchAll > lastApi);

// endOfDay guard: date-only `to` bounds must be widened
check('endOfDay helper present', /const endOfDay =/.test(src));
check('range() uses endOfDay', /endOfDay\(req\.query\.to/.test(src));


/* ── map/CSS regressions ──────────────────────────────────────────────────
   Two bugs that both produced a "broken map" with no error in the console:
   1. a blanket `svg{width:100%;height:auto}` collapsed Leaflet's overlay pane
      to 0×0, so polylines sat in the DOM invisibly;
   2. the same rule blew up Leaflet's attribution flag.
   Both are CSS-only, so they are checked by reading the stylesheet. */
const cssTxt = readFileSync('api/public/app.css', 'utf8');
const jsTxt = readFileSync('api/public/app.js', 'utf8');
const htmlTxt = readFileSync('api/public/index.html', 'utf8');

check('no blanket svg sizing rule', !/^svg\{[^}]*width:100%/m.test(cssTxt));
check('chart svg rule excludes the map panel', /\.panel:not\(\.mapwrap\) svg/.test(cssTxt));
check('map panel carries the opt-out class', /panel mapwrap/.test(jsTxt));
check('leaflet is vendored, not CDN', /vendor\/leaflet\.js/.test(htmlTxt) && !/unpkg\.com/.test(htmlTxt));
check('nav css targets the real markup (a, .grp)', /#nav a\{/.test(cssTxt) && /#nav \.grp\{/.test(cssTxt));
check('map view is registered', /id: 'map'/.test(jsTxt));

/* ── the driver detail pages ──────────────────────────────────────────────
   Their routes are registered by driverRoutes(app, …) rather than inline, so
   the "no /api route after the catch-all" scan above cannot see them. Check the
   call site's position instead — registering it after app.get('*') would serve
   index.html for every /api/driver/* request. */
const driverAt = src.indexOf('driverRoutes(app');
check('driver routes are registered', driverAt > -1);
check('driver routes register before the catch-all', driverAt > -1 && driverAt < catchAll);

/* ── multipage shell ────────────────────────────────────────────────────── */
const driverJs = readFileSync('api/public/driver.js', 'utf8');
const dataJs = readFileSync('api/public/data.js', 'utf8');
const mapJs = readFileSync('api/public/map.js', 'utf8');
check('router parses view/param/sub', /export function parseHash/.test(dataJs));
check('app applies the parsed route', /applyRoute\(\)/.test(jsTxt));
check('a detail page keeps its parent lit in the nav', /const PARENT = \{ driver: 'drivers'/.test(jsTxt));
check('breadcrumb element exists', /id="crumb"/.test(htmlTxt));
check('every driver tab is a real route', /href\('driver', id, t === 'overview' \? null : t\)/.test(driverJs));
check('all six driver tabs registered', ['overview', 'activity', 'territory', 'earnings', 'quality', 'trips']
  .every((t) => new RegExp(`id: '${t}'`).test(driverJs)), 'DRIVER_TABS');
// Detail pages must ignore the platform/fleet filter: showing "everything about
// this person" while a platform filter silently hides half their work is a lie.
check('detail pages fetch unfiltered', !/[^A]\bq\('\/api\/driver\//.test(driverJs) && /qAll\('\/api\/driver\//.test(driverJs));

/* ── map framing ───────────────────────────────────────────────────────────
   Leaflet rounds a fitted zoom DOWN to a whole level unless zoomSnap is 0, so
   points that need z=11.9 render at z=11 in the middle of a half-empty panel.
   Both of these are load-bearing for "the dots fill the map". */
check('fractional zoom is enabled', /zoomSnap: 0/.test(mapJs));
check('a shared fitTo helper exists', /export function fitTo/.test(mapJs));
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
check('no bounds are framed with degree padding',
  !/fitBounds\([^)]*\.pad\(/.test(strip(mapJs)) && !/\.pad\(/.test(strip(driverJs)));
check('the fit is re-applied when the panel resizes', /_fitAgain/.test(mapJs));
check('the territory map renders even with no points', /if \(!pts\.length\) \{\s*mapP\.body\.append/.test(driverJs));

/* ── chart markup must match the stylesheet ───────────────────────────────
   charts.js emits .k/.track/.fill/.v; the CSS once styled .lab/.bar-cell, so
   every horizontal bar in the dashboard rendered as text with no bar. */
const chartsJs = readFileSync('api/public/charts.js', 'utf8');
check('hbars emits the classes the CSS styles', /class="fill"/.test(chartsJs) && /\.hb \.fill\{/.test(cssTxt));
check('bar tracks are styled', /\.hb \.track\{/.test(cssTxt));
check('legend swatches have a size', /\.legend i\{|\.sw,\.legend i\{/.test(cssTxt));
check('axis ticks dedupe on small integer ranges', /function ticks\(/.test(chartsJs));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
