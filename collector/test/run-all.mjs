/* Runs every test file in this directory.
   ─────────────────────────────────────────────────────────────────────────
   The npm "test" script used to be a hand-maintained && chain. It had fallen
   two files behind: test/edges.test.mjs and test/recon.test.mjs were on disk,
   were being written and re-run by hand, and were executed by nothing that CI
   or a deploy would run — and recon's assertions had been broken for long
   enough that four of them could not fail at all.

   This is the same drift that let nine test files each carry their own copy of
   the schema list. The fix is the same: discover, never enumerate. A file
   named *.test.mjs runs; there is no list to forget to add it to.

   Each file runs in its own process, because they all listen on sockets and
   open in-process Postgres instances and a shared process would have them
   fighting over the exit code. A few run concurrently — PGlite is CPU-bound
   and the suite is otherwise several minutes of one core. */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

const files = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).sort();
if (!files.length) { console.error('no test files found — is the cwd the collector root?'); process.exit(1); }

/* The browser tests need a server, and this used to not be its problem.
   ─────────────────────────────────────────────────────────────────────────
   Four files — audit_tools_detect, phone_render, phone_today_only and
   spacing — drive Chromium at http://localhost:8099, and each says in its
   header to start `node mockapi.mjs &` first. Nothing enforced that, so a
   run without it reported those files failing with `ERR_CONNECTION_REFUSED`,
   or worse `0 of 116 routes measured`, which reads exactly like a real defect
   in 116 routes rather than a missing server. Two consecutive runs of this
   suite disagreed for no reason but whether a stray mockapi from an earlier
   session happened to still be up.

   So the suite starts one itself, and stops it at the end. If a server is
   already listening — a developer's own, or a run against production through
   bin/prod-mirror.mjs — it is left alone and used as it stands. */
const BASE = process.env.SMOKE_BASE || 'http://localhost:8099';
const alive = async () => {
  try {
    const r = await fetch(`${BASE}/api/kpis?days=1`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
};

let mock = null;
if (await alive()) {
  console.log(`using the server already on ${BASE}`);
} else if (process.env.SMOKE_BASE) {
  console.error(`SMOKE_BASE is ${BASE} and nothing is answering there.`);
  process.exit(1);
} else {
  mock = spawn(process.execPath, ['mockapi.mjs'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let why = '';
  mock.stderr.on('data', (d) => { why += d; });
  const deadline = Date.now() + 30_000;
  while (!(await alive())) {
    if (mock.exitCode !== null || Date.now() > deadline) {
      console.error(`could not start mockapi.mjs on ${BASE} — the browser tests cannot run.`);
      if (why) console.error(why.split('\n').slice(0, 8).join('\n'));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`started mockapi.mjs on ${BASE} for the browser tests`);
}
const stopMock = () => { if (mock && mock.exitCode === null) mock.kill('SIGTERM'); };
process.on('exit', stopMock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopMock(); process.exit(1); });

const LIMIT = Math.max(1, Math.min(4, cpus().length - 1));
const results = [];

/* A file that prints nothing and exits 0 is a file that did not run its
   assertions — a syntax error in a top-level await, say. Every file in this
   suite ends by printing "N passed, M failed", so the absence of that line is
   itself a failure rather than a pass. */
const TALLY = /(\d+) passed, (\d+) failed/;

/* A file that never finishes is a failing file, not a stopped suite.
   ─────────────────────────────────────────────────────────────────────────
   spacing.test.mjs drives Chromium over 116 routes and one of them hung on a
   navigation — 0:02 of CPU over twenty minutes, nothing on stdout, and the
   whole run parked behind it with 182 of 183 files already green. Nothing
   said so; the log simply stopped. The slowest file in this suite finishes in
   under a minute, so five is an allowance no healthy file can reach, and a
   file that does reach it is reported like any other failure with what it had
   printed before it stopped. */
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT_MS || 300_000);

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [`test/${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      /* SIGKILL, not SIGTERM: the thing that hangs is a browser page whose
         own process tree ignores a polite ask, and a suite that waited on
         the shutdown would be back where it started. */
      p.kill('SIGKILL');
    }, FILE_TIMEOUT_MS);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      const m = timedOut ? null : out.match(TALLY);
      if (timedOut) {
        out += `\n  ✗ TIMED OUT after ${FILE_TIMEOUT_MS / 1000}s and was killed — `
          + 'it printed the lines above and then stopped\n';
      }
      resolve({
        file, code, out, timedOut, secs: ((Date.now() - started) / 1000).toFixed(1),
        passed: m ? +m[1] : 0,
        failed: m ? +m[2] : null,          // null = never reported a tally
      });
    });
  });
}

const queue = [...files];
await Promise.all(Array.from({ length: LIMIT }, async () => {
  while (queue.length) {
    const r = await run(queue.shift());
    results.push(r);
    const bad = r.code !== 0 || r.failed === null || r.failed > 0;
    console.log(`${bad ? '✗' : '✓'} ${r.file.padEnd(34)} ${String(r.passed).padStart(4)} passed`
      + `${r.failed ? `, ${r.failed} FAILED` : ''}`
      + `${r.timedOut ? ', TIMED OUT' : r.failed === null ? ', NO TALLY REPORTED' : ''}`
      + `  ${r.secs}s`);
    if (bad) console.log(r.out.split('\n').filter((l) => /✗|FAIL|Error|error:/.test(l)).slice(0, 25)
      .map((l) => `      ${l}`).join('\n'));
  }
}));

results.sort((a, b) => a.file.localeCompare(b.file));
const broken = results.filter((r) => r.code !== 0 || r.failed === null || r.failed > 0);
const total = results.reduce((a, r) => a + r.passed, 0);
console.log(`\n${results.length} files, ${total} assertions, ${broken.length} file(s) failing`);
stopMock();
process.exit(broken.length ? 1 : 0);
