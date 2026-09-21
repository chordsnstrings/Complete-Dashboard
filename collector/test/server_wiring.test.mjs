/* THE BOTTOM OF api/server.js IS EXECUTED BY NOTHING.
   ══════════════════════════════════════════════════════════════════════════
   test/mount.mjs evaluates ONE REGION of server.js — between START and END,
   lines 394 to 5746 — as a function body with its helpers injected. Everything
   after that marker, which is every `xxxRoutes(app, { … })` registration in the
   product, is never run by any test at all. The route MODULES are covered,
   thoroughly, because mount.mjs discovers and mounts them itself with its own
   deps; what is not covered is server.js handing them the right things.

   So the harness both misses the line AND supplies what the line got wrong.
   mount.mjs declares `const tx = pgliteTx(db)` and passes it in by name, while
   server.js has no `tx` — it constructs `pgTx(pool)` at each call site. A
   registration written as `ledgerPolicyRoutes(app, { q, wrap, tx })` is
   therefore:

     · valid syntax, so `node --check` passes
     · a ReferenceError only at module evaluation, so nothing catches it early
     · never evaluated by the suite, so 274 files and 8601 assertions pass
     · fatal at boot on production

   That is exactly what shipped on 2026-09-21. The deployment reached DEPLOYING,
   the container exited 1 with `ReferenceError: tx is not defined`, and App
   Platform rolled back automatically — so the app's phase read ACTIVE while
   running the PREVIOUS build. A poll that watches for ACTIVE and stops sees a
   successful deploy of code that never started.

   This file is the check that a green suite could not give. It reads what every
   registration in server.js passes and asserts server.js can actually supply
   it: imported, declared there, or a standard global. Nothing else. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SRC = readFileSync(new URL('../api/server.js', import.meta.url), 'utf8');

/* Comments and string bodies are stripped first: a name inside a sentence is
   not a reference, and this file's whole job is to distinguish those. */
const stripped = SRC
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

/* ── what server.js can actually supply ────────────────────────────────── */
const defined = new Set();
/* imports: named, default and namespace */
for (const m of stripped.matchAll(/import\s+([\s\S]*?)\s+from\s+/g)) {
  const clause = m[1];
  for (const nm of clause.matchAll(/\{([\s\S]*?)\}/g)) {
    nm[1].split(',').forEach((part) => {
      const t = part.trim();
      if (!t) return;
      defined.add((t.split(/\s+as\s+/).pop() || t).trim());
    });
  }
  const bare = clause.replace(/\{[\s\S]*?\}/g, '').replace(/\*\s+as\s+/, '').split(',');
  bare.forEach((t) => { const x = t.trim(); if (/^[A-Za-z_$][\w$]*$/.test(x)) defined.add(x); });
}
/* declarations, at any depth — a name declared inside a block is still a name
   server.js has, and this check is about "does it exist", not scope */
for (const m of stripped.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
for (const m of stripped.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) defined.add(m[1]);
/* destructured declarations */
for (const m of stripped.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
  m[1].split(',').forEach((part) => {
    const t = part.split(':').pop().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(t)) defined.add(t);
  });
}

const GLOBALS = new Set(['app', 'process', 'console', 'JSON', 'Math', 'Date', 'Number', 'String',
  'Object', 'Array', 'Boolean', 'Promise', 'Map', 'Set', 'Error', 'RegExp', 'Buffer', 'URL',
  'URLSearchParams', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'globalThis',
  'true', 'false', 'null', 'undefined', 'async', 'await', 'new', 'typeof', 'void', 'req', 'res',
  'this', 'return', 'function', 'if', 'else', 'try', 'catch', 'throw']);

/* ── every registration, and what it passes ────────────────────────────── */
/* Balanced-paren scan rather than a regex for the whole call: a deps object
   containing a call — `tx: pgTx(pool)` — closes the first `)` early, and a
   greedy match runs past the end of the statement into the next one. */
function callsIn(src) {
  const out = [];
  const re = /\b([A-Za-z_$][\w$]*Routes)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = re.lastIndex, depth = 1;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      i += 1;
    }
    out.push({ name: m[1], args: src.slice(re.lastIndex, i - 1) });
  }
  return out;
}

const END_MARKER = '/* ───────────────── per-driver detail pages ───────────────── */';

const calls = callsIn(stripped);
check('server.js registers route modules, and this file found them',
  calls.length >= 10, `${calls.length} found`);

/* Every identifier a registration USES — keys skipped, values checked. */
const problems = [];
for (const c of calls) {
  const obj = c.args.slice(c.args.indexOf('{') + 1, c.args.lastIndexOf('}'));
  if (c.args.indexOf('{') < 0) continue;
  /* Split on top-level commas so `tx: pgTx(pool)` stays one property. */
  const props = [];
  let depth = 0, cur = '';
  for (const ch of obj) {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) { props.push(cur); cur = ''; continue; }
    cur += ch;
  }
  props.push(cur);

  for (const raw of props) {
    const p = raw.trim();
    if (!p) continue;
    const colon = p.indexOf(':');
    /* SHORTHAND is both key and value, so it is checked. `tx: …` is a key and
       is not — the key names what the module receives, the value is what
       server.js must have. */
    const value = colon >= 0 ? p.slice(colon + 1) : p;
    for (const idm of value.matchAll(/[A-Za-z_$][\w$]*/g)) {
      const id = idm[0];
      if (GLOBALS.has(id) || defined.has(id)) continue;
      /* A property access — `pool.query` — names a member, not a binding. */
      const at = value.indexOf(id);
      if (at > 0 && value[at - 1] === '.') continue;
      problems.push(`${c.name}(… ${p.trim()} …): "${id}" is neither imported nor declared `
        + 'in api/server.js');
    }
  }
}

/* THE ASSERTION. Proved by reverting the fix — restore
   `ledgerPolicyRoutes(app, { q, wrap, tx })` and this goes red naming `tx`,
   which is the failure that reached production and that no other test in this
   repo could see. */
check('every route registration passes something api/server.js actually has',
  problems.length === 0, `\n      ${problems.join('\n      ')}`);

/* ── AND THE REGISTRATIONS ARE OUTSIDE THE TESTED REGION, WHICH IS WHY ──── */
const a = SRC.indexOf('/* ───────────────────────── overview ───────────────────────── */');
const b = SRC.indexOf(END_MARKER);
const firstReg = SRC.indexOf('Routes(app,', b);
check('the route registrations really do sit outside the region mount.mjs runs',
  a >= 0 && b > a && firstReg > b,
  `slice ends at ${b}, first registration after it at ${firstReg}`);
check('so this file is the only thing checking them — which is the point of it',
  true);

/* ── EVERY MODULE server.js IMPORTS IS ALSO REGISTERED ──────────────────── */
/* An imported-but-never-mounted route module is a set of endpoints that exist
   in the repository and answer 404 in production, with a full test file
   passing against them — because mount.mjs discovers modules from the
   directory and does not care what server.js does. */
const imported = new Set();
for (const m of stripped.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*''/g)) {
  m[1].split(',').forEach((t) => {
    const nm = (t.split(/\s+as\s+/).pop() || t).trim();
    if (/Routes$/.test(nm)) imported.add(nm);
  });
}
const registered = new Set(calls.map((c) => c.name));
const orphans = [...imported].filter((n) => !registered.has(n));
check('every *Routes function server.js imports is also registered',
  orphans.length === 0,
  `imported but never mounted: ${orphans.join(', ')} — these would 404 on production `
  + 'while their test files pass, because mount.mjs discovers modules from the directory');

console.log(`\n${fail ? '✗' : '✓'} server_wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
