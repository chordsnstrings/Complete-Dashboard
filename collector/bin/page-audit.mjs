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
const FROM = dubai(new Date(Date.now() - 29 * 864e5));
const WIN = `from=${FROM}&to=${TO}`;

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
console.log(`window ${FROM} .. ${TO}\n  plate=${PLATE}  driver=${DRIVER}  property=${PROPERTY}`
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
  report.push({ view, endpoints: ps.length, broken, refused, blank, junky });
}

let bad = 0;
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
  if (r.junky.length) issues.push(`${r.junky.length} junk`);
  const ok = !r.broken.length && !r.junky.length && !r.refused.length;
  if (!ok) bad++;
  console.log(`${r.view.padEnd(20)} ${String(r.endpoints).padStart(5)}  ${issues.length ? issues.join(', ') : 'clean'}`);
  for (const b of r.broken) console.log(`  ✗ ${b.path} → ${b.status} ${b.raw}`);
  for (const j of r.junky) console.log(`  ✗ ${j}`);
  for (const b of r.blank) console.log(`  · ${b.path} — ${b.why}`);
  for (const b of r.refused) console.log(`  ✗ UNREACHED ${b.path} → ${b.status} ${b.raw.slice(0, 60)}`);
}
console.log('─'.repeat(78));
console.log(`${report.length} views, ${report.reduce((a, r) => a + (r.endpoints || 0), 0)} endpoint calls, `
  + `${bad} view(s) with an error or an unreached panel`);
process.exit(bad ? 1 : 0);
