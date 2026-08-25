#!/usr/bin/env node
/* Which capped lists are actually cutting.
   ─────────────────────────────────────────────────────────────────────────
   Fifty handlers in this API carry a LIMIT, and most of them are fine: a
   LIMIT 1 is a lookup, and a LIMIT 300 on a list of forty rows costs nothing.
   The ones that matter are the caps that are BITING — where the endpoint
   returns exactly its limit, so there is a tail the reader cannot see and, on
   any page that aggregates the list, a fleet figure computed over whatever
   happened to fit.

   That question cannot be answered from the source. `LIMIT 600` looks
   identical whether the table holds four hundred rows or four thousand; only
   asking the real database tells you which. A static check over the source
   flags twenty handlers, seventeen of them lookups — which is how a harness
   teaches people to ignore it.

   So this asks. For every route with a LIMIT it calls the endpoint over a
   twelve-month window and compares the row count against the limit.

       node bin/live-ui.mjs &
       node bin/cap-audit.mjs

   A cap that is biting is not automatically a bug: it is a bug when nothing in
   the response says so. The report separates the two. */
import { readFileSync, readdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8100';
const dubai = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const DAYS = Number(process.env.DAYS || 365);
const WIN = `from=${dubai(new Date(Date.now() - DAYS * 864e5))}&to=${dubai(new Date())}`;

const files = ['server.js', ...readdirSync('api').filter((f) => f.endsWith('_routes.js'))];
const src = Object.fromEntries(files.map((f) => [f, readFileSync(`api/${f}`, 'utf8')]));

const handlers = [];
for (const [file, s] of Object.entries(src)) {
  const marks = [...s.matchAll(/app\.get\('(\/api\/[^']*)'/g)];
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : s.length;
    const body = s.slice(m.index, end);
    /* A LIMIT 1 is a lookup and can never cut a list. Anything larger is a
       page size worth checking. */
    const lims = [...body.matchAll(/LIMIT (\d+)/g)].map((x) => +x[1]).filter((n) => n > 1);
    if (lims.length) handlers.push({ file, route: m[1], cap: Math.max(...lims), body });
  });
}

const listOf = (d) => {
  if (Array.isArray(d)) return { rows: d, envelope: null };
  if (d && typeof d === 'object') {
    for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return { rows: v, envelope: d, key: k };
    }
  }
  return { rows: null, envelope: d };
};
/* Does the answer state the size of the full set? The key differs by endpoint
   — total, total_guests, driver_count — so this looks for any count that is
   not simply the length of what came back, plus the row-level form
   /api/map/days uses. */
const discloses = (rows, env) => {
  const n = rows.length;
  const carries = (o) => Object.entries(o || {}).some(([k, v]) =>
    /total|count|truncated|shown/i.test(k) && (typeof v === 'boolean' || (typeof v === 'number' && v !== n)));
  return carries(env) || carries(rows[0]);
};

const biting = [], quiet = [], skipped = [];
for (const h of handlers.sort((a, b) => a.route.localeCompare(b.route))) {
  if (h.route.includes(':') || h.route.startsWith('/api/probe/')) { skipped.push(h.route); continue; }
  let d;
  try {
    const r = await fetch(`${BASE}${h.route}?${WIN}`);
    if (!r.ok) { skipped.push(`${h.route} (${r.status})`); continue; }
    d = await r.json();
  } catch { skipped.push(`${h.route} (unreachable)`); continue; }
  const { rows, envelope } = listOf(d);
  if (!rows) { skipped.push(`${h.route} (no list)`); continue; }
  if (rows.length < h.cap) continue;
  (discloses(rows, envelope) ? quiet : biting).push({ ...h, n: rows.length });
}

if (biting.length) {
  console.log('\nCAPS THAT ARE CUTTING, WITH NOTHING SAID:');
  biting.forEach((h) => console.log(`  ✗ ${h.route}  returns exactly ${h.n} (LIMIT ${h.cap})  [${h.file}]`));
}
if (quiet.length) {
  console.log('\nCaps that are cutting and say so:');
  quiet.forEach((h) => console.log(`  · ${h.route}  ${h.n} of a larger set, disclosed`));
}
console.log(`\n${handlers.length} handlers carry a LIMIT above 1; ${biting.length + quiet.length} are `
  + `at their cap, ${biting.length} silently. ${skipped.length} not checked `
  + '(needs a parameter, or returns no list).');
process.exit(biting.length ? 1 : 0);
