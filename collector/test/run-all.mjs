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

const LIMIT = Math.max(1, Math.min(4, cpus().length - 1));
const results = [];

/* A file that prints nothing and exits 0 is a file that did not run its
   assertions — a syntax error in a top-level await, say. Every file in this
   suite ends by printing "N passed, M failed", so the absence of that line is
   itself a failure rather than a pass. */
const TALLY = /(\d+) passed, (\d+) failed/;

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [`test/${file}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const m = out.match(TALLY);
      resolve({
        file, code, out, secs: ((Date.now() - started) / 1000).toFixed(1),
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
      + `${r.failed ? `, ${r.failed} FAILED` : ''}${r.failed === null ? ', NO TALLY REPORTED' : ''}`
      + `  ${r.secs}s`);
    if (bad) console.log(r.out.split('\n').filter((l) => /✗|FAIL|Error|error:/.test(l)).slice(0, 25)
      .map((l) => `      ${l}`).join('\n'));
  }
}));

results.sort((a, b) => a.file.localeCompare(b.file));
const broken = results.filter((r) => r.code !== 0 || r.failed === null || r.failed > 0);
const total = results.reduce((a, r) => a + r.passed, 0);
console.log(`\n${results.length} files, ${total} assertions, ${broken.length} file(s) failing`);
process.exit(broken.length ? 1 : 0);
