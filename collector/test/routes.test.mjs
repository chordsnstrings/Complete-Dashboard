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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
