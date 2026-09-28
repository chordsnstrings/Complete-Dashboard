/* EVERY ROUTE IS DECLARED — or the build fails.
   ═════════════════════════════════════════════════════════════════════════
   The access gate refuses a signed-in caller any /api path with no manifest
   entry (deny by default, ULM-DESIGN §9.1). So a route added in code and not
   declared is a page that works for anonymous visitors while sign-in is
   optional, and breaks for every signed-in person the moment it is not: the
   worst way to find out. This walks every route declaration in api/*.js and
   fails on any that api/access/manifest.json does not cover, and on any entry
   that is malformed or declares a route that no longer exists.

   REVERSION: delete one entry from manifest.json — "every route in code has
   an entry" fails and names it. */
import { readFileSync, readdirSync } from 'node:fs';
import { lookupEntry, allEntries, FOUR_EYES } from '../api/access/manifest.js';
import { CLASS_CODES, CAP_CODES } from '../api/public/access_model.js';
import { parsePath } from '../api/access/shape.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const API = new URL('../api/', import.meta.url);
const declared = [];
for (const f of readdirSync(API)) {
  if (!f.endsWith('.js')) continue;
  const src = readFileSync(new URL(f, API), 'utf8');
  for (const m of src.matchAll(/\.(get|post|put|delete|patch)\(\s*(['"`])(\/api\/[^'"`]*)\2/g)) {
    declared.push({ method: m[1].toUpperCase(), path: m[3], file: f });
  }
}
const inCode = declared.filter((d) => !d.path.startsWith('/api/auth/') && !d.path.startsWith('/api/access/'));

console.log('\n1. coverage');
const missing = inCode.filter((d) => !lookupEntry(d.method, d.path.replace(/:[a-z_]+/gi, 'x')));
check(`every route in code has an entry (${inCode.length} routes)`, missing.length === 0,
  missing.map((d) => `${d.method} ${d.path} (${d.file})`).join('; '));
const codeKeys = new Set(inCode.map((d) => `${d.method} ${d.path}`));
const stale = allEntries().filter((e) => !codeKeys.has(`${e.method} ${e.path}`));
check('no entry declares a route that no longer exists', stale.length === 0, stale.map((e) => `${e.method} ${e.path}`).join('; '));
check('the sign-in and access routes decide for themselves', lookupEntry('GET', '/api/auth/me')?.self === true
  && lookupEntry('POST', '/api/access/users')?.self === true);
check('an undeclared path has no entry (so the gate refuses it)', lookupEntry('GET', '/api/nothing-here') === null);

console.log('\n2. every entry is well formed');
const bad = [];
for (const e of allEntries()) {
  const k = `${e.method} ${e.path}`;
  if (!CLASS_CODES.includes(e.subject)) bad.push(`${k}: subject ${e.subject}`);
  if (!e.carries.includes(e.subject)) bad.push(`${k}: carries lacks its subject`);
  for (const c of e.carries) if (!CLASS_CODES.includes(c)) bad.push(`${k}: carries ${c}`);
  for (const f of e.fields) {
    if (!CLASS_CODES.includes(f.class)) bad.push(`${k}: field class ${f.class}`);
    for (const p of f.paths) if (!parsePath(p).length) bad.push(`${k}: path "${p}"`);
  }
  for (const c of e.whole) if (!CLASS_CODES.includes(c)) bad.push(`${k}: whole ${c}`);
  if (!['record', 'list', 'aggregate', 'none'].includes(e.grain)) bad.push(`${k}: grain ${e.grain}`);
  if (!['param', 'rows', 'global', 'mixed'].includes(e.fleet)) bad.push(`${k}: fleet ${e.fleet}`);
  if (e.fleet === 'rows' && !e.fleetRows.length) bad.push(`${k}: rows without paths`);
  if (e.cap && !CAP_CODES.includes(e.cap)) bad.push(`${k}: cap ${e.cap}`);
  if (e.method !== 'GET' && !e.cap) bad.push(`${k}: a write with no action`);
  if (e.capBy) for (const c of [e.capBy.default, ...Object.values(e.capBy.map)]) if (!CAP_CODES.includes(c)) bad.push(`${k}: capBy ${c}`);
}
check('classes, grains, fleet rules and actions are all known values', bad.length === 0, bad.slice(0, 20).join('; '));
const pub = allEntries().filter((e) => e.public).map((e) => e.path);
check('only the health checks answer without signing in', pub.every((p) => ['/api/health', '/api/ready'].includes(p)), pub.join(', '));
check('every change needs an action', allEntries().filter((e) => e.method !== 'GET').every((e) => e.cap));
check('raw records and query plans are the Owner’s alone (subject RAW)',
  ['/api/schema/raw-fields', '/api/schema/raw-values', '/api/unauthorized/attributed/plan']
    .every((p) => lookupEntry('GET', p)?.subject === 'RAW'));
check('probes spend quota, so they are an action', allEntries().filter((e) => e.path.startsWith('/api/probe/') && e.subject !== 'RAW')
  .every((e) => e.cap === 'collector.probe'));
check('cash pages are about cash', ['/api/ledger/entries', '/api/ledger/people', '/api/ledger/cash-position']
  .every((p) => lookupEntry('GET', p)?.subject === 'CASH'), ['/api/ledger/entries', '/api/ledger/people', '/api/ledger/cash-position']
  .map((p) => `${p}:${lookupEntry('GET', p)?.subject}`).join(' '));
check('the trigger’s action follows the job it asks for', lookupEntry('POST', '/api/settings/trigger')?.capBy?.map?.backfill === 'collector.backfill');
check('four-eyes routes are declared', Object.keys(FOUR_EYES).every((k) => { const [m, p] = k.split(' '); return lookupEntry(m, p)?.fourEyes; }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
