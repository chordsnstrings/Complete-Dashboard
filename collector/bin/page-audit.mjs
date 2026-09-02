#!/usr/bin/env node
/* The audit, page by page.
   ─────────────────────────────────────────────────────────────────────────
   bin/live-audit.mjs checks invariants — "the mix sums to the headline", "no
   percentage is out of range" — organised by the rule being enforced. That
   catches arithmetic, and it says nothing about whether a PAGE is sound. A view
   whose four panels all render, all return 200, and three of which are empty
   because the endpoint behind them answers with nothing, passes every invariant
   in that file and is broken to the person looking at it.

   So this walks the product the way a reader does: one view at a time, calling
   the endpoints that view actually calls, and reporting what a person opening
   it would see.

   The endpoint list per view is read from the front-end source rather than
   maintained here, because a hand-kept list goes stale the first time somebody
   adds a panel — and a stale list reports a page as audited when half of it was
   never asked about.

       node bin/page-audit.mjs
       BASE=http://localhost:8099 node bin/page-audit.mjs
*/
import { readFileSync, readdirSync } from 'node:fs';

const B = process.env.BASE || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const dubai = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const TO = dubai(new Date());
/* Every window the product offers, not only the default one.
   A page is not audited because it renders over thirty days. The windows differ
   in kind and not merely in size: seven days can hold nothing at all for a
   source that reports weekly, a year crosses every collection gap this fleet
   has, and all-time is the only window in which a page meets the months whose
   earnings were never collected. Each of those has broken something different. */
const WINDOWS = (process.env.WINDOWS || '7,30,90,365,all').split(',').map((w) => w.trim());
const windowQs = (w) => (w === 'all'
  ? 'from=2000-01-01&to=2100-01-01'
  : `from=${dubai(new Date(Date.now() - (Number(w) - 1) * 864e5))}&to=${TO}`);
let WIN = windowQs('30');

/* Which source file backs each view. Most views delegate to a module of the
   same name; the rest are declared inline in app.js. Discovered by looking for
   the module, so a new detail page is picked up without editing this. */
const PUB = 'api/public';
const modules = Object.fromEntries(readdirSync(PUB)
  .filter((f) => f.endsWith('.js'))
  .map((f) => [f.replace('.js', ''), readFileSync(`${PUB}/${f}`, 'utf8')]));
const app = modules.app;

/* Every view the router knows about — BOTH ways one is declared.
   ─────────────────────────────────────────────────────────────────────────
   `V.overview = ` is the common form and was the only form this matched. A
   view whose name is not a bare identifier has to be declared with a subscript,
   and two are: V['top-performers'] and V['low-performers']. Both are real
   pages, both are in test/routes_list.mjs, both call endpoints through
   renderPerformers — and neither has ever been audited by this tool, which
   reported "45 views" and read as complete coverage. Measured against the
   product's own router: 47 views exist. */
const DECL = /^V(?:\.([A-Za-z0-9_$]+)|\['([^']+)'\]) = /gm;
const VIEWS = [...app.matchAll(DECL)].map((m) => m[1] || m[2]);
const declOf = (view) => {
  const at = app.indexOf(`V.${view} = `);
  return at !== -1 ? at : app.indexOf(`V['${view}'] = `);
};

/* The source that backs one view: its slice of app.js, plus the module it
   delegates to if there is one. A view whose panels live in another file would
   otherwise look like it calls nothing. */
function sourceFor(view) {
  const start = declOf(view);
  const rest = app.slice(start + 1);
  /* The NEXT declaration in either form, so a subscript-declared view does not
     swallow the rest of the file — and so its neighbour's endpoints are not
     credited to it. */
  const nextAt = rest.search(/^V(?:\.[A-Za-z0-9_$]+|\['[^']+'\]) = /m);
  const slice = nextAt === -1 ? app.slice(start) : app.slice(start, start + 1 + nextAt);
  /* Resolved by WHO EXPORTS the function, not by guessing a filename from it.
     renderSegment lives in segments.js and renderProperty in corporate.js, so a
     filename guess found neither — and both views were then reported as
     "static pages with no endpoints", which is a clean bill of health for a
     page that was never asked about. */
  const called = [...new Set([...slice.matchAll(/\b(render[A-Z][a-zA-Z]*)\(/g)].map((m) => m[1]))];
  const extra = called.map((fn) => {
    const hit = Object.entries(modules).find(([name, srcText]) =>
      name !== 'app' && new RegExp(`export (async )?function ${fn}\\b`).test(srcText));
    return hit ? hit[1] : null;
  }).filter(Boolean);
  return { text: [slice, ...new Set(extra)].join('\n'), delegates: called, resolved: extra.length };
}

/* The closing quote is not required. Half these calls are template literals —
   `/api/day?${params}` — so the character after the path is a `?`, and a regex
   demanding a quote matched none of them. Two views reported zero endpoints for
   that reason alone. */
/* A dot is part of a path, not the end of one. /api/export/trips.csv is a real
   endpoint and this regex stopped at the dot, so the audit fetched
   /api/export/trips, got "no such endpoint", and reported #trips as a view with
   a refused call — a 404 the harness had invented. */
const paths = (src) => [...new Set(
  [...src.matchAll(/['"`](\/api\/[a-z0-9/_.-]+)/gi)].map((m) => m[1].replace(/[/.]+$/, '')))];

/* Real ids, so a detail page is audited against something that exists rather
   than against a 404 that would read as a clean pass. */
const one = async (path, key) => {
  try {
    const r = await fetch(`${B}${path}?${WIN}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.rows || j.drivers || j.vehicles || j.people || []);
    return rows[0]?.[key] ?? null;
  } catch { return null; }
};
const PLATE = await one('/api/vehicles/directory', 'plate');
const DRIVER = await one('/api/drivers/leaderboard', 'driver_ext_id');
const PROPERTY = await one('/api/corporate/properties', 'partner_id');
/* A segment is addressed by plate AND the instant it began, so a made-up
   timestamp 404s and the panel goes unaudited. Taken from a real segment. */
const SEG = await (async () => {
  try {
    const r = await fetch(`${B}/api/segments?${WIN}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.rows || j.segments || []);
    return rows[0] ? { plate: rows[0].plate, at: rows[0].started_at } : null;
  } catch { return null; }
})();
/* The platforms this fleet actually has, read from the data rather than listed
   here: a hard-coded set would report Bolt as missing for ever, and would miss a
   seventh channel the day one is added. */
const FLEET_PLATFORMS = await (async () => {
  try {
    const r = await fetch(`${B}/api/coverage?from=2000-01-01&to=2100-01-01`);
    const j = await r.json();
    const set = new Set((j.trips || []).filter((t) => Number(t.n) > 0)
      .map((t) => String(t.platform).toLowerCase()));
    return set.size ? set : new Set();
  } catch { return new Set(); }
})();

console.log(`windows: ${WINDOWS.join(', ')}  (today ${TO})`
  + `\n  fleet platforms: ${[...FLEET_PLATFORMS].join(', ') || '(unknown)'}`
  + `\n  plate=${PLATE}  driver=${DRIVER}  property=${PROPERTY}`
  + `  segment=${SEG ? `${SEG.plate}@${String(SEG.at).slice(0, 19)}` : 'none'}\n`);

/* Per route, not one global bag. `id` means a driver on /api/driver/* and a
   partner on /api/corporate/property, so sending one value for both handed the
   corporate page a driver uuid, got an honest 404, and left that panel
   unaudited — while the run still said the view was fine. */
/* One real booking, for /api/trip: the platform and the provider's own id,
   taken from a vehicle's trip list the same way PLATE and DRIVER are found. */
const TRIP = await (async () => {
  try {
    const r = await fetch(`${B}/api/vehicle/trips?plate=${encodeURIComponent(PLATE)}&${WIN}`);
    const j = await r.json();
    const rows = Array.isArray(j) ? j : (j.rows || j.trips || []);
    const t = rows.find((x) => x.platform && x.external_id);
    return t ? { platform: t.platform, id: t.external_id } : null;
  } catch { return null; }
})();

const NEEDS_FOR = (path) => {
  /* /api/trip is ONE booking by the provider's own platform and id, and asking
     without them is a 400 the audit then reported as an unreached panel on
     every window of every run. A real one, taken from the segments feed. */
  if (path === '/api/trip') return { platform: TRIP?.platform, id: TRIP?.id };
  if (path.startsWith('/api/driver/')) return { id: DRIVER };
  if (path.startsWith('/api/corporate/property')) return { id: PROPERTY };
  if (path.startsWith('/api/vehicle/')) return { plate: PLATE };
  if (path.startsWith('/api/segment')) return { plate: SEG?.plate, at: SEG?.at };
  if (path.startsWith('/api/slot')) return { dow: '2', hour: '19' };
  if (path.startsWith('/api/day') || path.startsWith('/api/map/journey')
      || path.startsWith('/api/track')) return { day: TO, plate: PLATE };
  if (path.startsWith('/api/schema/raw-values')) return { table: 'trip', key: 'platform' };
  if (path.startsWith('/api/action')) return { plate: PLATE, id: DRIVER };
  return { plate: PLATE, id: DRIVER, day: TO };
};

/* An endpoint that needs an entity gets one. Discovered by asking without it
   and reading the complaint, so this does not need a per-route table. */
async function call(path) {
  const url = (extra = '') => `${B}${path}?${WIN}${extra}`;
  let r = await fetch(url());
  let body = await r.text();
  if (r.status === 400 || r.status === 404) {
    /* A 404 saying "driver not found" needs an id just as much as a 400 saying
       "plate required", and the word it uses is not always the parameter name.
       When the complaint names no parameter, every known one is offered: an
       endpoint ignores what it does not want, and the alternative was auditing
       ten driver panels against a 404 and calling it clean. */
    /* Every known parameter, not only the ones the complaint names. A route
       that says "hour must be 0-23" may also be missing dow, and offering one
       at a time left panels unaudited behind a second complaint nobody read.
       An endpoint ignores what it does not want. */
    const needs = NEEDS_FOR(path);
    const need = Object.keys(needs).filter((k) => needs[k] != null);
    if (need.length) {
      const extra = need.map((k) => `&${k}=${encodeURIComponent(needs[k])}`).join('');
      r = await fetch(url(extra));
      body = await r.text();
    }
  }
  let json = null;
  try { json = JSON.parse(body); } catch { /* not json */ }
  return { status: r.status, json, raw: body.slice(0, 120) };
}

/* Is there anything on this panel? An endpoint answering 200 with an empty list
   is the single most common way a page is blank while every check passes. */
function emptiness(json) {
  if (json == null) return 'not json';
  if (Array.isArray(json)) return json.length ? null : 'empty array';
  if (typeof json !== 'object') return null;
  if (json.error) return `error: ${String(json.error).slice(0, 40)}`;
  if (json.ok === false) return `refused: ${String(json.reason || '').slice(0, 50)}`;
  const arrays = Object.entries(json).filter(([, v]) => Array.isArray(v));
  if (arrays.length && arrays.every(([, v]) => v.length === 0)) return 'every list empty';
  const vals = Object.values(json);
  if (vals.length && vals.every((v) => v == null)) return 'every field null';
  return null;
}

/* Is this panel showing the whole fleet, or one source standing in for it?
   ─────────────────────────────────────────────────────────────────────────
   This product's entire purpose is combining CABMAN, FMS, Uber, Yango, Bolt and
   the hotel channel into one view, and the failure it keeps having is a panel
   that renders perfectly while describing one of them. Uber's export carries no
   fare, so a revenue panel silently became "the hotel channel"; the driver
   ranking folded names differently from the directory, so one page counted 90
   people and the next 89.

   A panel that names its platforms is checked against the platforms the fleet
   actually has. It is not an error to show one — a Bolt-only panel is right
   when only Bolt has that kind of row — so this reports rather than fails, and
   names which are missing so the reader can judge. */
const platformsIn = (json) => {
  const found = new Set();
  const walk = (v, key) => {
    if (v == null) return;
    if (typeof v === 'string' && /^(platform|source)$/i.test(key || '')) found.add(v.toLowerCase());
    if (Array.isArray(v)) {
      if (/^(platforms|booking_platforms|platforms_worked)$/i.test(key || '')) {
        v.filter((x) => typeof x === 'string').forEach((x) => found.add(x.toLowerCase()));
      }
      v.slice(0, 200).forEach((x) => walk(x, key));
    } else if (typeof v === 'object') {
      Object.entries(v).forEach(([k, x]) => walk(x, k));
    }
  };
  walk(json, null);
  /* Only values that are actually platform names. `platform` is not always a
     platform: /api/events carries "seasonal" under that key, and counting it
     reported the world-event feed as a channel missing five others. */
  return new Set([...found].filter((v) => FLEET_PLATFORMS.has(v)));
};

/* FMS is telematics, not a channel: is_booking is literally platform <> 'fms',
   so every booking-scoped panel excludes it by definition and reporting that as
   a gap would flag most of the product for working correctly. */
const BOOKING_PLATFORMS = () => new Set([...FLEET_PLATFORMS].filter((p) => p !== 'fms'));

/* The panels whose JOB is combining channels.
   ─────────────────────────────────────────────────────────────────────────
   Scoped deliberately. Checking every panel that mentions a platform produced
   thirteen findings and all thirteen were correct behaviour: /api/live and
   /api/track are position feeds so their source is a tracker, compliance comes
   from one provider, and Yango has eight trips in the record so it is legitimately
   absent from a corridor map. A check that prints thirteen expected lines every
   run is a check people learn to scroll past.

   These are the ones where a single source IS the bug, and each has been that
   bug: the revenue headline was the hotel channel alone for the life of the
   project, because Uber's export carries no fare and nothing said so. */
const MUST_COMBINE = new Set([
  '/api/kpis', '/api/mix', '/api/mix/detail', '/api/revenue',
  '/api/trips/daily', '/api/drivers/directory', '/api/drivers/leaderboard',
  '/api/vehicles/directory', '/api/vehicles', '/api/coverage', '/api/status',
]);

// Numbers that render as text a reader should never see.
function junk(json) {
  const bad = [];
  const walk = (v, p) => {
    if (v == null) return;
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push(`${p}=${v}`);
    if (typeof v === 'string' && /^(NaN|Infinity|-Infinity|undefined|\[object Object\]|Invalid Date)$/.test(v)) bad.push(`${p}="${v}"`);
    if (Array.isArray(v)) v.slice(0, 40).forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, p ? `${p}.${k}` : k));
  };
  walk(json, '');
  return [...new Set(bad)].slice(0, 4);
}

/* What each endpoint answered, per view and per window, so the run can ask a
   question no single window can: does the range selector on this page actually
   govern anything? See the range-honesty pass at the bottom. */
const answers = new Map();          // `${view}|${W}` -> Map(path -> fingerprint)
const fingerprint = (j) => (j == null ? 'null' : JSON.stringify(j).length + ':'
  + JSON.stringify(j).slice(0, 400));
/* Whether an answer is empty enough that comparing two windows proves nothing.
   /api/analyst/findings returns every count at zero because no analyst run has
   ever happened on this fleet; identical at 7 days and at 365 says the endpoint
   has no data, not that it ignores the window. */
const barren = (j) => j == null || emptiness(j) != null
  || (Array.isArray(j) && !j.length);
const bodies = new Map();           // `${view}|${W}` -> Map(path -> json)

const byWindow = [];
for (const W of WINDOWS) {
WIN = windowQs(W);
const report = [];
for (const view of VIEWS) {
  const { text, delegates, resolved } = sourceFor(view);
  const all = paths(text);
  /* Excluded because calling them has an effect, not because they are hard.
     `/api/settings/*` holds credential writes and the run trigger, and every
     `/api/probe/<provider>/<surface>` reaches out to a provider on request.

     `/api/probe/results` does neither — it reads the stored results of the
     nightly probe pass out of the database — and the blanket /api/probe prefix
     was taking it with them. That left the Providers page as the one view of
     thirty-six this tool never called at all, reported as "1 endpoint, all
     excluded", which reads like a decision rather than a hole. */
  /* /api/analyst/run only answers POST — a GET falls through to the 404
     handler, which this tool read as a missing endpoint on every window of
     every run. It is also a route that STARTS an analyst pass, so it belongs
     beside the settings writes rather than in a read-only audit. */
  const ps = all.filter((p) => !/^\/api\/settings/.test(p)
    && p !== '/api/analyst/run'
    && !/^\/api\/probe\/(?!results)/.test(p));
  if (!ps.length) {
    /* Three different things used to print as "static page": a view with no
       calls, a view whose calls were all filtered out, and a view whose module
       this tool failed to find. Only the first is a clean result; the third is
       the audit missing a page entirely. */
    const why = all.length ? `${all.length} endpoint(s), all excluded from this audit`
      : delegates.length && !resolved ? `UNRESOLVED — delegates to ${delegates.join(', ')}, module not found`
        : 'no endpoints — static page';
    report.push({ view, endpoints: 0, note: why, unresolved: !!(delegates.length && !resolved) });
    continue;
  }
  const results = [];
  for (const p of ps) results.push({ path: p, ...(await call(p)) });
  const broken = results.filter((r) => r.status >= 500 || r.status === 0);
  /* Still refused after being handed every id this tool holds. That is not a
     pass: it is a panel the audit never saw, and reporting it beside "clean"
     is how a page goes unchecked while the run says 35 views audited. */
  const refused = results.filter((r) => r.status >= 400 && r.status < 500);
  const blank = results.map((r) => ({ path: r.path, why: emptiness(r.json) })).filter((r) => r.why);
  const junky = results.flatMap((r) => junk(r.json).map((j) => `${r.path} ${j}`));
  /* Only panels that name a platform at all — most do not, and demanding one of
     a KPI row would be noise rather than a finding. */
  const partial = results
    .filter((r) => MUST_COMBINE.has(r.path.split('?')[0]))
    /* A truncated list is allowed to be missing a channel: it is a ranking, and
       a platform with eight trips in the record falls below the cut at a wide
       window. Seen for real — the leaderboard shows Yango over thirty days and
       not over a year, which is the list working rather than a gap in it. The
       envelope says so, so this can tell the two apart instead of reporting the
       cut as an absence. */
    .filter((r) => !(r.json && r.json.truncated === true))
    .map((r) => ({ path: r.path, have: platformsIn(r.json) }))
    .map((r) => ({ ...r, want: BOOKING_PLATFORMS() }))
    .filter((r) => r.have.size > 0 && [...r.want].some((p) => !r.have.has(p)))
    .map((r) => `${r.path} — ${[...r.have].join('+')} only, missing `
      + `${[...r.want].filter((p) => !r.have.has(p)).join(', ')}`);
  answers.set(`${view}|${W}`, new Map(results.map((r) => [r.path, fingerprint(r.json)])));
  bodies.set(`${view}|${W}`, new Map(results.map((r) => [r.path, r.json])));
  report.push({ view, endpoints: ps.length, broken, refused, blank, junky, partial });
}

let bad = 0;
console.log(`\n== window: ${W === 'all' ? 'all time' : `last ${W} days`}`);
console.log('view                 calls  status');
console.log('─'.repeat(78));
for (const r of report) {
  if (r.note) {
    if (r.unresolved) bad++;
    console.log(`${r.view.padEnd(20)} ${String(r.endpoints).padStart(5)}  ${r.note}`);
    continue;
  }
  const issues = [];
  if (r.broken.length) issues.push(`${r.broken.length} ERROR`);
  if (r.refused.length) issues.push(`${r.refused.length} refused`);
  if (r.blank.length) issues.push(`${r.blank.length} empty`);
  if (r.partial?.length) issues.push(`${r.partial.length} single-source`);
  if (r.junky.length) issues.push(`${r.junky.length} junk`);
  const ok = !r.broken.length && !r.junky.length && !r.refused.length;
  if (!ok) bad++;
  console.log(`${r.view.padEnd(20)} ${String(r.endpoints).padStart(5)}  ${issues.length ? issues.join(', ') : 'clean'}`);
  for (const b of r.broken) console.log(`  ✗ ${b.path} → ${b.status} ${b.raw}`);
  for (const j of r.junky) console.log(`  ✗ ${j}`);
  for (const b of r.blank) console.log(`  · ${b.path} — ${b.why}`);
  for (const b of (r.partial || [])) console.log(`  ~ ${b}`);
  for (const b of r.refused) console.log(`  ✗ UNREACHED ${b.path} → ${b.status} ${b.raw.slice(0, 60)}`);
}
console.log('─'.repeat(78));
const calls = report.reduce((a, r) => a + (r.endpoints || 0), 0);
console.log(`${report.length} views, ${calls} endpoint calls, `
  + `${bad} view(s) with an error or an unreached panel`);
byWindow.push({ window: W, views: report.length, calls, bad });
}

console.log(`\n${'='.repeat(78)}\nsummary`);
for (const w of byWindow) {
  console.log(`  ${(w.window === 'all' ? 'all time' : `${w.window}d`).padEnd(10)}`
    + `${String(w.calls).padStart(5)} calls   ${w.bad ? `${w.bad} view(s) with an error` : 'clean'}`);
}

/* ── does the range selector on this page govern anything? ─────────────────
   Every view either shows the date-range control or hides it, and data.js says
   which: NO_RANGE plus NO_FILTER. That list is a CLAIM about the endpoints
   behind the page, and nothing checked it.

   Both directions are a lie the reader cannot detect:

     - a control that changes nothing. The reader moves it from 30 days to a
       year, every number stays where it was, and they conclude the fleet did
       nothing in the other eleven months. #reconcile earned its place on
       NO_RANGE this way — its rows are whole months, and a thirty-day window
       spanning two partial ones is the exact mismatch its delta column exists
       to catch.
     - a page with no control whose numbers move anyway. Then the figures
       depend on a window the reader cannot see and was never shown.

   So the answers from the narrowest and widest windows are compared per
   endpoint. Nothing here is automatically a fault — an endpoint may honestly
   have the same answer at 7 days and at 365 because that is all the data there
   is — which is why it reports the count and names the endpoints rather than
   failing the run. What it makes visible is a page whose control is decoration
   and a page whose numbers have a hidden scope. */
const NARROW = WINDOWS.includes('7') ? '7' : WINDOWS[0];
const WIDE = WINDOWS.includes('365') ? '365' : WINDOWS[WINDOWS.length - 1];
if (NARROW !== WIDE) {
  /* Read from data.js rather than restated here: a copy of this list is a copy
     that disagrees with the product within a week, and the whole point is to
     check the product's own claim. */
  const dataSrc = readFileSync(`${PUB}/data.js`, 'utf8');
  const listOf = (name) => {
    const m = dataSrc.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\];`));
    return m ? [...m[1].matchAll(/'([a-z-]+)'/g)].map((x) => x[1]) : [];
  };
  const hidden = new Set([...listOf('NO_RANGE'), ...listOf('NO_FILTER')]);

  /* Only the calls that CARRY the window.
     ───────────────────────────────────────────────────────────────────────
     This tool appends from/to to everything it calls, so an endpoint that
     honours a window looks window-dependent whether or not the page ever sends
     one. That reported eight views as having a hidden scope, and seven of them
     call their endpoints through bare api() and send no window at all.

     `q()` and `qAll()` are the two helpers in data.js that inject
     windowDates(); a path reached through either is a path the PAGE is
     windowing. `q(path, { from, to })` overrides the injected pair with its
     own — #performer picks its Monday-to-Sunday week that way — so a call site
     passing from/to is windowed by the page and not by the reader's selector,
     and is not counted. */
  /* Scoped to the code the view ACTUALLY runs, not to the whole module.
     ───────────────────────────────────────────────────────────────────────
     sourceFor() hands back the entire file a delegate lives in, which is the
     right answer for "which endpoints does this page touch" and the wrong one
     here: renderSegment and renderSegments are neighbours in segments.js, so
     #segment was credited with `q('/api/segments')` — a call it never makes —
     and reported on every run as a page whose numbers move with a window it
     does not offer. It makes exactly one call, through bare api(), and sends
     no window at all.

     So this walks the delegate's own body and the bodies of the same-module
     helpers that body calls. One level of helpers is enough for this codebase
     and keeps a sibling function out. */
  const bodyOf = (srcText, fn) => {
    const m = srcText.match(new RegExp(`(export )?(async )?function ${fn}\\b`));
    if (!m) return null;
    const from = srcText.slice(m.index + 1);
    const nextAt = from.search(/^(export )?(async )?(function|const) /m);
    return nextAt === -1 ? srcText.slice(m.index) : srcText.slice(m.index, m.index + 1 + nextAt);
  };
  const runSourceFor = (view) => {
    const start = declOf(view);
    if (start === -1) return '';
    const rest = app.slice(start + 1);
    const nextAt = rest.search(/^V(?:\.[A-Za-z0-9_$]+|\['[^']+'\]) = /m);
    const slice = nextAt === -1 ? app.slice(start) : app.slice(start, start + 1 + nextAt);
    const parts = [slice];
    for (const m of slice.matchAll(/\b(render[A-Z][a-zA-Z]*)\(/g)) {
      for (const [name, srcText] of Object.entries(modules)) {
        if (name === 'app') continue;
        const body = bodyOf(srcText, m[1]);
        if (!body) continue;
        parts.push(body);
        /* one level of same-module helpers */
        for (const h of body.matchAll(/\b([a-z][a-zA-Z0-9]*)\(/g)) {
          const hb = bodyOf(srcText, h[1]);
          if (hb && hb !== body) parts.push(hb);
        }
        break;
      }
    }
    return [...new Set(parts)].join('\n');
  };

  const windowedBy = (view) => {
    const text = runSourceFor(view);
    const out = new Set();
    for (const m of text.matchAll(/\bq(?:All)?\(\s*[`'"](\/api\/[a-z0-9/_-]+)[`'"]\s*(,([^)]*))?\)/gi)) {
      if (m[3] && /\bfrom\s*:/.test(m[3])) continue;      // brings its own window
      out.add(m[1]);
    }
    return out;
  };

  /* One endpoint, one window, one fingerprint — the same shape the run
     recorded, so the two are comparable. */
  const ask = async (path, w) => {
    const keep = WIN;
    WIN = windowQs(w);
    try { const { json } = await call(path); return fingerprint(json); }
    catch { return null; }
    finally { WIN = keep; }
  };

  console.log(`\n${'='.repeat(78)}\nrange honesty — ${NARROW}d against ${WIDE}d`);
  console.log('Does the date-range control on each page govern the numbers on it?');
  console.log('Counted over the calls the page makes through q()/qAll(), which are the');
  console.log('ones that carry the reader’s window; an endpoint empty in BOTH windows is');
  console.log('skipped, because identical-and-empty proves nothing either way.\n');
  console.log('view                 control   windowed calls that move');
  console.log('─'.repeat(78));
  let quiet = 0, loud = 0;
  for (const view of VIEWS) {
    const a = answers.get(`${view}|${NARROW}`), b = answers.get(`${view}|${WIDE}`);
    const ja = bodies.get(`${view}|${NARROW}`), jb = bodies.get(`${view}|${WIDE}`);
    if (!a || !b || !a.size) continue;
    const carries = windowedBy(view);
    const asked = [...a.keys()].filter((path) => carries.has(path) && b.has(path)
      && !(barren(ja.get(path)) && barren(jb.get(path))));
    if (!asked.length) {
      console.log(`${view.padEnd(20)} ${(hidden.has(view) ? 'hidden' : 'shown').padEnd(9)} `
        + `${carries.size ? 'nothing comparable — every windowed call is empty in both'
          : 'sends no window on any call'}`);
      continue;
    }
    /* A difference is only evidence if the endpoint holds still.
       ───────────────────────────────────────────────────────────────────
       The run's own two windows are fetched minutes apart and the collector
       writes throughout, so an endpoint reading whole-history rollups
       answers differently for reasons that have nothing to do with a
       window. #capacity was reported on that basis; asked twice at the same
       window it is byte-identical, and its handler does not read from/to at
       all.

       So a candidate is re-asked here and now, bracketed — narrow, wide,
       wide, narrow — the same shape the numbers audit uses on identity
       cards. Anything drifting over the four calls disagrees with its own
       pair and is dropped; only an endpoint that answers one way at one
       window and another way at the other, twice each, is windowed.
       Comparing a fresh call against the fingerprint recorded at the top of
       the run is not the same thing and does not work: by the time this
       section runs the fleet has moved on, and every endpoint looks
       volatile. */
    const moved = [], still = [], restless = [];
    for (const path of asked) {
      if (a.get(path) === b.get(path)) { still.push(path); continue; }
      const n1 = await ask(path, NARROW);
      const w1 = await ask(path, WIDE);
      const w2 = await ask(path, WIDE);
      const n2 = await ask(path, NARROW);
      if (n1 == null || w1 == null) { restless.push(path); continue; }
      /* Disagreeing with its own pair is INCONCLUSIVE, not unchanged.
         /api/economics/drivers is 200KB of live aggregate and moves between
         two calls seconds apart; treating that as "the window changed
         nothing" reported the range control on the product's first screen
         as decoration, when the same endpoint answers 200,627 bytes at
         seven days and 231,060 at a year. A path that will not hold still
         is not evidence in either direction and leaves the count. */
      if (n1 !== n2 || w1 !== w2) { restless.push(path); continue; }
      (n1 === w1 ? still : moved).push(path);
    }
    const judged = moved.length + still.length;
    if (!judged) {
      console.log(`${view.padEnd(20)} ${(hidden.has(view) ? 'hidden' : 'shown').padEnd(9)} `
        + `nothing comparable — all ${restless.length} windowed call(s) are still moving`);
      continue;
    }
    const shows = !hidden.has(view);
    const line = `${view.padEnd(20)} ${(shows ? 'shown' : 'hidden').padEnd(9)} `
      + `${moved.length} of ${judged}`
      + (restless.length ? `  (${restless.length} too volatile to judge)` : '');
    if (shows && moved.length === 0) {
      quiet += 1;
      console.log(`${line}   ← the control is on screen and changes nothing`);
      asked.slice(0, 4).forEach((x) => console.log(`      · ${x}`));
    } else if (!shows && moved.length) {
      loud += 1;
      console.log(`${line}   ← no control, but the reader’s window still governs these`);
      moved.slice(0, 4).forEach((x) => console.log(`      · ${x}`));
    } else {
      console.log(line);
    }
  }
  console.log('─'.repeat(78));
  console.log(`${quiet} view(s) offer a range control that changes nothing, `
    + `${loud} are governed by one they do not offer`);
}

const totalBad = byWindow.reduce((a, w) => a + w.bad, 0);
console.log(`\n${byWindow.length} windows, ${byWindow.reduce((a, w) => a + w.calls, 0)} calls, ${totalBad} failing`);
process.exit(totalBad ? 1 : 0);
