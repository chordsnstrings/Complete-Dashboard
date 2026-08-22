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

// Every view the router knows about.
const VIEWS = [...app.matchAll(/^V\.([a-z]+) = /gm)].map((m) => m[1]);

/* The source that backs one view: its slice of app.js, plus the module it
   delegates to if there is one. A view whose panels live in another file would
   otherwise look like it calls nothing. */
function sourceFor(view) {
  const start = app.indexOf(`V.${view} = `);
  const rest = app.slice(start + 1);
  const nextAt = rest.search(/^V\.[a-z]+ = /m);
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
const paths = (src) => [...new Set(
  [...src.matchAll(/['"`](\/api\/[a-z0-9/_-]+)/gi)].map((m) => m[1].replace(/\/$/, '')))];

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
const NEEDS_FOR = (path) => {
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

const byWindow = [];
for (const W of WINDOWS) {
WIN = windowQs(W);
const report = [];
for (const view of VIEWS) {
  const { text, delegates, resolved } = sourceFor(view);
  const all = paths(text);
  const ps = all.filter((p) => !/^\/api\/(settings|probe)/.test(p));
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
const totalBad = byWindow.reduce((a, w) => a + w.bad, 0);
console.log(`\n${byWindow.length} windows, ${byWindow.reduce((a, w) => a + w.calls, 0)} calls, ${totalBad} failing`);
process.exit(totalBad ? 1 : 0);
