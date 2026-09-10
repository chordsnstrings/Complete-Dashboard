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
import { createServer } from 'node:net';
/* The fleet's calendar is Dubai's, and this file asks a question about TODAY.
   Imported rather than re-derived: a local copy of the clock is how
   onlinetime.js came to print a collector time in UTC. */
import { dubaiDay } from '../api/window.js';

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
   bin/prod-mirror.mjs — it is left alone and used as it stands.

   ── ANSWERING AND USABLE ARE TWO QUESTIONS ──────────────────────────────
   Asking only the first cost a session. The probe here was
   `GET /api/kpis?days=1 → r.ok`, and a server that answers that is a server
   this suite adopts. test/preview.mjs mounts the same real handlers and
   defaults to the SAME port 8099, so it answers it perfectly — but it seeds
   `2026-08-01`..`2026-08-31` and nothing else, hard-coded. Every browser test
   that asks about TODAY then reads an empty day off a correct product:
   phone_today_only reported two failures, the screen was right, and the
   search went into the product before it went into the port.

   The probe therefore asks the second question too — can whatever is there
   serve TODAY — and the answer decides what happens here, out loud, rather
   than being rediscovered twenty minutes later inside a test file. */
const DEFAULT_BASE = 'http://localhost:8099';
const BASE = process.env.SMOKE_BASE || DEFAULT_BASE;
const TODAY = dubaiDay(new Date());

const answering = async (base) => {
  try {
    const r = await fetch(`${base}/api/kpis?days=1`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
};

/* Bookings today, off the same endpoint the screens read. A row of zero and no
   row at all are the same answer to the question being asked — neither can
   exercise a today-only window — and an endpoint that throws is not a server
   that can serve today either. `_` because prod-mirror sits behind a cache. */
const bookingsToday = async (base) => {
  try {
    const r = await fetch(`${base}/api/trips/daily?from=${TODAY}&to=${TODAY}&_=${process.pid}`,
      { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return 0;
    const d = await r.json();
    const rows = Array.isArray(d) ? d : d?.rows || [];
    const row = rows.find((x) => (x.d || x.day) === TODAY);
    return row ? Number(row.trips) || 0 : 0;
  } catch { return 0; }
};

/* A port the kernel just told us is free. Better than probing 8100, 8101…:
   bin/live-ui.mjs is on 8100 and bin/prod-mirror.mjs on 8200, and a suite that
   guessed its way up that range would eventually adopt one of them. */
const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.on('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

const startMock = async (port, base) => {
  const m = spawn(process.execPath, ['mockapi.mjs'],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PORT: String(port) } });
  let why = '';
  m.stderr.on('data', (d) => { why += d; });
  const deadline = Date.now() + 30_000;
  while (!(await answering(base))) {
    if (m.exitCode !== null || Date.now() > deadline) {
      console.error(`could not start mockapi.mjs on ${base} — the browser tests cannot run.`);
      if (why) console.error(why.split('\n').slice(0, 8).join('\n'));
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`started mockapi.mjs on ${base} for the browser tests`);
  return m;
};

let mock = null;
let base = BASE;
if (await answering(BASE)) {
  const n = await bookingsToday(BASE);
  if (n > 0) {
    console.log(`using the server already on ${BASE} — ${n} booking(s) for ${TODAY}`);
  } else if (process.env.SMOKE_BASE) {
    /* An explicit SMOKE_BASE is a choice, and this suite does not overrule a
       choice: bin/prod-mirror.mjs at 00:30 Dubai is a legitimate reason for a
       genuinely empty today, and 208 files do not care either way. So it is
       used as it stands and the consequence is named — by file — so that a
       failure over there is read as the fixture it is and not as a defect. */
    console.log(`WARNING: ${BASE} reports no bookings for ${TODAY}, and it is SMOKE_BASE, so it`
      + ' is used as it stands.\n  The files that drive a today-only window —'
      + ' phone_today_only.test.mjs above all — cannot\n  exercise their shape against an empty'
      + ' day, and will say so rather than pass quietly.');
  } else {
    /* Nobody asked for that server. 8099 is only the default port and
       something else reached it first — test/preview.mjs defaults to it, and
       seeds August 2026. Leave it running, because it is somebody's, and take
       a port of our own instead of failing or adopting a fixture that cannot
       answer the question the browser tests ask. */
    const port = await freePort();
    base = `http://localhost:${port}`;
    console.log(`something is answering on ${BASE} but has no data for ${TODAY}`
      + ' — test/preview.mjs defaults to that port and seeds\n  August 2026 only.'
      + ` Leaving it alone; starting mockapi.mjs on ${base} instead.`);
    mock = await startMock(port, base);
  }
} else if (process.env.SMOKE_BASE) {
  console.error(`SMOKE_BASE is ${BASE} and nothing is answering there.`);
  process.exit(1);
} else {
  mock = await startMock(8099, BASE);
}
/* Every browser test file reads SMOKE_BASE, and a spawn with no `env` inherits
   this one — so this single line is what points them at whichever server the
   block above settled on. */
process.env.SMOKE_BASE = base;
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
