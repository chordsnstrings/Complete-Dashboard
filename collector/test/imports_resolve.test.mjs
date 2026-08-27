/* ── an import of something that was never exported ────────────────────────
   app.js imported `foldChildren` from ui.js for a commit in which ui.js never
   received it — a patch whose anchor did not match, applied to one file and
   not the other. In a browser that is a module that fails to load and a blank
   page. The whole suite passed: nothing in it loads the public modules as
   modules, and `node --check` only parses a file, it does not resolve what the
   file imports.

   A static cross-check closes the class. Every named import between the shipped
   browser modules must correspond to a real named export in the file it names.
   Cheap, and it catches the exact failure that a screenshot cannot: the page
   does not render at all. */
import { readdirSync, readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const DIR = 'api/public';
const files = readdirSync(DIR).filter((f) => f.endsWith('.js'));
const src = Object.fromEntries(files.map((f) => [f, readFileSync(`${DIR}/${f}`, 'utf8')]));

/* What each file exports by name. Covers `export function x`, `export async
   function x`, `export const x`, `export class x`, and `export { a, b }`. */
const exportsOf = (text) => {
  const out = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    out.add(m[1]);
  }
  for (const m of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) out.add(name);
    }
  }
  return out;
};
const EXPORTS = Object.fromEntries(files.map((f) => [f, exportsOf(src[f])]));

check('the modules were found and export things', files.length > 20
  && Object.values(EXPORTS).some((s) => s.size > 5), `${files.length} files`);

const missing = [];
const unresolved = [];
for (const f of files) {
  /* Only relative imports of siblings — a bare specifier is a vendored library
     and not this check's business. */
  for (const m of src[f].matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)'/g)) {
    const target = m[2];
    if (!EXPORTS[target]) { unresolved.push(`${f} → ${target}`); continue; }
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      if (!EXPORTS[target].has(name)) missing.push(`${f} imports { ${name} } from ${target}, which does not export it`);
    }
  }
}
check('every relative import names a file that exists',
  unresolved.length === 0, unresolved.join('; '));
check('and every named import is actually exported by it',
  missing.length === 0, `\n      ${missing.join('\n      ')}`);

/* The same for the server side, where a missing export is a crashed boot
   rather than a blank page — louder, but no reason to find it in production. */
const API = readdirSync('api').filter((f) => f.endsWith('.js'));
const apiSrc = Object.fromEntries(API.map((f) => [f, readFileSync(`api/${f}`, 'utf8')]));
const apiExports = Object.fromEntries(API.map((f) => [f, exportsOf(apiSrc[f])]));
const apiMissing = [];
for (const f of API) {
  for (const m of apiSrc[f].matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)'/g)) {
    if (!apiExports[m[2]]) continue;
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !apiExports[m[2]].has(name)) {
        apiMissing.push(`api/${f} imports { ${name} } from ${m[2]}`);
      }
    }
  }
}
check('the same holds across the api modules',
  apiMissing.length === 0, apiMissing.join('; '));

console.log(`\n  ${files.length} browser modules, ${API.length} api modules checked`);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
