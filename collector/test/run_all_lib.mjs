/* The choices test/run-all.mjs makes before it runs anything — kept here, out
   of the runner, so they can be tested without running the suite.
   ─────────────────────────────────────────────────────────────────────────
   WHY THE RUNNER GREW OPTIONS. CI (.github/workflows/ci.yml) runs the suite on
   a machine with no Chromium and no Postgres, against a ten-minute budget. The
   runner's default behaviour is unchanged — with no option it runs every file
   and starts the :8099 mock server for the browser tests, exactly as before —
   and these options exist only to say, out loud, what a CI run leaves out:

     --skip-browser      leave out every file that needs a browser, and never
                         start or even probe the :8099 mock server
     --allow-fail=a,b    files known to fail for a reason that is not a defect
                         in the code under test: reported, not counted
     --shard=k/n         run every n-th file starting at the k-th (1-based), so
                         n machines share the suite; the union of the n shards
                         is the whole run
     --jobs=N            files run at once (default: CPUs − 1, at most 4)
     --only=a,b          just these files (with or without .test.mjs)
     --list              print what would run, and why anything is left out,
                         and run nothing

   WHICH FILES NEED A BROWSER is decided from the source, not from a list —
   the runner's own rule ("discover, never enumerate"). A file needs one when:
     1. it imports playwright, directly or through any local module it imports
        (74 files reach it through test/browser.mjs, test/arkiv_pages.mjs or
        test/phone_harness.mjs; 12 import it themselves);
     2. it reads the browser tests' mock server address (process.env.SMOKE_BASE,
        or a localhost/127.0.0.1:8099 URL) — audit_tools_detect, phone_render,
        phone_today_only, spacing;
     3. it spawns a bin/ script that drives Chromium itself:
        numbers_audit_identity runs bin/numbers-audit.mjs, which launches
        Chromium through test/browser.mjs and imports nothing of it here.
   Counted on 2026-11-12: 88 of the 397 files — 86 by the first rule, then
   audit_tools_detect by the second and numbers_audit_identity by the third.
   The third rule exists because the first two missed exactly that file. */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join, sep } from 'node:path';

export function parseRunArgs(argv) {
  const o = { skipBrowser: false, allowFail: new Set(), shard: null, jobs: null, only: null, list: false };
  const names = (v) => new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.endsWith('.test.mjs') ? s : `${s}.test.mjs`)));
  for (const a of argv) {
    const [k, v] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (k === '--skip-browser' && v === null) o.skipBrowser = true;
    else if (k === '--list' && v === null) o.list = true;
    else if (k === '--allow-fail' && v) o.allowFail = names(v);
    else if (k === '--only' && v) o.only = names(v);
    else if (k === '--jobs' && /^[1-9]\d*$/.test(v || '')) o.jobs = Number(v);
    else if (k === '--shard' && /^\d+\/\d+$/.test(v || '')) {
      const [i, n] = v.split('/').map(Number);
      if (!(n >= 1 && i >= 1 && i <= n)) return { error: `--shard=${v}: needs k/n with 1 ≤ k ≤ n` };
      o.shard = { k: i, n };
    } else {
      return { error: `unknown or malformed option: ${a} (known: --skip-browser, --allow-fail=a,b, --shard=k/n, --jobs=N, --only=a,b, --list)` };
    }
  }
  return o;
}

const SPEC = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const PLAYWRIGHT = (s) => s === 'playwright' || s.startsWith('playwright/') || s === 'playwright-core'
  || s.startsWith('playwright-core/') || s === '@playwright/test';

/* Does this module reach playwright through its own imports? Follows relative
   imports anywhere under `root` except node_modules; memoised. */
export function reachesPlaywright(file, root, memo = new Map(), stack = new Set()) {
  if (memo.has(file)) return memo.get(file);
  if (stack.has(file)) return false;
  stack.add(file);
  let via = false;
  let src = '';
  try { src = readFileSync(file, 'utf8'); } catch { memo.set(file, false); return false; }
  for (const m of src.matchAll(SPEC)) {
    const spec = m[1] || m[2] || m[3];
    if (PLAYWRIGHT(spec)) { via = 'playwright'; break; }
    if (!spec.startsWith('.')) continue;
    const p = resolve(dirname(file), spec);
    if (!p.startsWith(root + sep) || p.includes(`${sep}node_modules${sep}`)) continue;
    if (!existsSync(p) || !statSync(p).isFile()) continue;
    if (reachesPlaywright(p, root, memo, stack)) { via = p; break; }
  }
  stack.delete(file);
  memo.set(file, via);
  return via;
}

/* Reading the mock server's address — process.env.SMOKE_BASE, or a literal
   localhost/127.0.0.1:8099 URL — not merely naming the variable: this runner's
   own test sets SMOKE_BASE for a child it spawns and needs no browser. */
const MOCK = /process\.env\.SMOKE_BASE|(?:localhost|127\.0\.0\.1):8099/;
const SPAWNS = /\b(spawn|spawnSync|execFile|execFileSync|fork|exec|execSync)\s*\(/;
const MJS = /['"/]([A-Za-z0-9_.-]+\.mjs)['"]/g;

/* Map of file → the reason it needs a browser, for every file that does. */
export function browserFiles(files, { root = process.cwd(), testDir = join(root, 'test') } = {}) {
  const memo = new Map();
  const rel = (p) => p.slice(root.length + 1);
  const out = new Map();
  for (const f of files) {
    const path = join(testDir, f);
    const via = reachesPlaywright(path, root, memo);
    if (via) {
      out.set(f, via === 'playwright' ? 'imports playwright' : `imports playwright through ${rel(via)}`);
      continue;
    }
    const src = readFileSync(path, 'utf8');
    if (MOCK.test(src)) { out.set(f, 'drives the :8099 mock server'); continue; }
    if (SPAWNS.test(src)) {
      for (const m of src.matchAll(MJS)) {
        const bin = join(root, 'bin', m[1]);
        if (existsSync(bin) && reachesPlaywright(bin, root, memo)) { out.set(f, `spawns bin/${m[1]}, which drives Chromium`); break; }
      }
    }
  }
  return out;
}

/* Every n-th file starting at the k-th. Deterministic over the sorted list,
   so the same commit always splits the same way, and the shards are disjoint
   and together complete. */
export const shardOf = (files, shard) => (shard ? files.filter((_, i) => i % shard.n === shard.k - 1) : files);

/* Which results fail the run. An allow-listed file that fails is reported but
   not counted; one that passes is reported too, so a list that has gone stale
   says so instead of quietly allowing a future regression. */
export function verdict(results, allowFail = new Set()) {
  const bad = (r) => r.code !== 0 || r.failed === null || r.failed > 0;
  return {
    broken: results.filter((r) => bad(r) && !allowFail.has(r.file)),
    allowed: results.filter((r) => bad(r) && allowFail.has(r.file)),
    allowedPassed: results.filter((r) => !bad(r) && allowFail.has(r.file)),
  };
}
