/* ── two helpers with one name, and the second one wins silently ───────────
   test/mount.mjs builds the injection set the mounted slice of api/server.js
   runs against. It is an explicit list of helpers — win, winDays, GRAINS,
   CANCEL_CASE and forty others — followed by a SPREAD of every api/*_sql.js
   module, discovered rather than listed so that a new SQL module participates
   the day it is written:

     const injected = { q, wrap, ..., GRAINS, ..., ...allSqlModules };

   The spread is last, so an export from any api/*_sql.js silently replaces the
   named helper above it. api/window.js exports GRAINS — the product's grain
   table, with day and quarter in it — and api/performance_sql.js was written
   exporting a GRAINS of its own with two entries. Nothing would have thrown.
   Every route in the mounted slice that resolves a grain would simply have
   stopped recognising half of them, in the tests only, which is the worst
   place for a difference between the test application and the real one to
   live: the suite would have gone green on an application nobody ships.

   It was caught by listing the exports before writing the module, not by a
   test, and that is exactly the kind of catch that does not happen twice. So:

     1. No two api/*_sql.js modules may export the same name.
     2. No api/*_sql.js export may share a name with an explicitly injected
        helper in test/mount.mjs.

   Both rules have an allowlist, and the allowlist is the honest part: three
   names ARE deliberately shared, because cancellation_sql.js owns them and
   mount.mjs imports them from there BY NAME as well. Those resolve to the
   identical binding, so the shadowing is a no-op — and the test asserts they
   are identical rather than taking it on trust. */
import { readdirSync, readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const files = readdirSync('api').filter((f) => f.endsWith('_sql.js')).sort();
check('there are api/*_sql.js modules to check', files.length > 0, String(files.length));

const mods = new Map();
for (const f of files) mods.set(f, await import(`../api/${f}`));

/* ── rule 1: one name, one owner ───────────────────────────────────────── */
const owners = new Map();
for (const [f, m] of mods) {
  for (const k of Object.keys(m)) {
    if (!owners.has(k)) owners.set(k, []);
    owners.get(k).push(f);
  }
}
const dups = [...owners].filter(([, v]) => v.length > 1);
for (const [name, where] of dups) {
  /* A duplicate is allowed only when every module exporting it exports the
     SAME VALUE — a re-export of one definition, not a second definition. That
     is the property that matters; identical names holding different values is
     the bug, and identical names holding one value is merely untidy. */
  const vals = where.map((f) => mods.get(f)[name]);
  const same = vals.every((v) => Object.is(v, vals[0]));
  check(`${name} is exported by ${where.join(' and ')} — same binding`, same,
    same ? '' : 'DIFFERENT VALUES: one of these silently wins in test/mount.mjs');
}
if (!dups.length) check('no export name is defined by two api/*_sql.js modules', true);

/* ── rule 2: nothing shadows a named helper in the harness ──────────────── */
/* Read the injection list out of test/mount.mjs rather than restating it: a
   list copied into a test is a list that goes stale, and this one grows every
   time the server slice learns a new helper. The object literal is matched
   from `const injected = {` to the spread that ends it, and the bare
   identifiers and `name:` keys inside it are the named helpers. */
const src = readFileSync('test/mount.mjs', 'utf8');
const a = src.indexOf('const injected = {');
const b = src.indexOf('...Object.assign({}, ...await Promise.all(', a);
check('test/mount.mjs still builds `injected` with a trailing _sql.js spread', a > 0 && b > a,
  `start=${a} spread=${b}`);

const body = src.slice(a, b);
/* A depth-aware scan, not a regex over lines. The first version of this was
   /(?:^|,)\s*(\w+)\s*[,:}]/g and it consumed the comma it matched on, so on
   a line reading `dubaiSpanSql, CANCEL_CASE, DROPPED_SQL, DECLINED_SQL,` it
   found the first and third names and silently skipped the second and fourth.
   A guard that checks half the list is a guard that reports a clean pass over
   the half it did not look at. Splitting on commas instead is no better: the
   values in this object contain commas and nested objects, and `fleet` out of
   `{ uber: { orgs: [{ fleet: 'ecosine' }] } }` would enter the list as a name
   nothing may shadow.

   So: walk the characters, track nesting and string state, and take an
   identifier as a KEY only at depth 1 and only where a key can legally begin —
   right after the opening brace or after a comma. */
const keysAtTopLevel = (text) => {
  const out = new Set();
  let depth = 0; let quote = null; let expectKey = false; let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++; continue;
    }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue; }
    if (c === '/' && text[i + 1] === '/') { const e = text.indexOf('\n', i); i = e < 0 ? text.length : e + 1; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; expectKey = depth === 1 && c === '{'; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; expectKey = false; i++; continue; }
    if (c === ',') { expectKey = depth === 1; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (expectKey && /[A-Za-z_$]/.test(c)) {
      let j = i; while (j < text.length && /[\w$]/.test(text[j])) j++;
      out.add(text.slice(i, j));
      expectKey = false; i = j; continue;
    }
    expectKey = false; i++;
  }
  return out;
};
const named = keysAtTopLevel(body);
/* The scan is checked against names known to be in that object at both ends
   and in the middle of a multi-name line — the exact positions the regex it
   replaced got wrong. */
for (const k of ['q', 'wrap', 'GRAINS', 'CANCEL_CASE', 'DROPPED_SQL', 'DECLINED_SQL', 'pool']) {
  check(`the injection list scan found ${k}`, named.has(k));
}
check('the scan did not descend into a nested value', !named.has('orgs') && !named.has('fleet'));
check('the injection list parsed into something plausible', named.size > 20, `${named.size} names`);

/* The three deliberate ones, with the reason each is safe. */
const SHARED_ON_PURPOSE = new Set(['CANCEL_CASE', 'DROPPED_SQL', 'DECLINED_SQL']);
for (const [f, m] of mods) {
  for (const k of Object.keys(m)) {
    if (!named.has(k)) continue;
    if (SHARED_ON_PURPOSE.has(k)) {
      /* mount.mjs imports these from api/cancellation_sql.js by name, and the
         spread puts the same module's export over the top of it. Identical by
         construction — asserted, not assumed. */
      const { [k]: viaImport } = await import('../api/cancellation_sql.js');
      check(`${k} from ${f} is the same binding mount.mjs names explicitly`,
        Object.is(m[k], viaImport));
      continue;
    }
    check(`api/${f} exports ${k}, which shadows the injected helper of that name`, false,
      'rename the export, or add it to SHARED_ON_PURPOSE with the reason it is identical');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
