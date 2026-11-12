/* The runner's CI options: --skip-browser, --allow-fail, --shard, --jobs,
   --only, --list (test/run_all_lib.mjs, test/run-all.mjs).
   ─────────────────────────────────────────────────────────────────────────
   CI runs the suite with no Chromium and no Postgres. What must hold:
     - with no option, the runner behaves as it always has (it still probes,
       and adopts or starts, the browser tests' mock server);
     - --skip-browser leaves out exactly the files that need a browser — found
       from their source, including the one that only spawns a Chromium-driving
       bin/ script — and never starts OR PROBES the :8099 mock server;
     - --allow-fail reports a known failure without failing the run, and says
       when an allow-listed file has started to pass;
     - --shard splits the run into disjoint parts that together are the whole.
   The runner is spawned for real, with SMOKE_BASE pointed at a sentinel that
   counts every request it receives. A file is made to fail without adding a
   failing file to the suite: TEST_FILE_TIMEOUT_MS=1 kills it before it can
   report, which the runner counts as a failure like any other. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRunArgs, browserFiles, shardOf, verdict } from './run_all_lib.mjs';
/* The block-YAML reader bin/app-spec.mjs carries; ci.yml is written in the
   subset it reads (no flow lists), so the workflow can be checked here. */
import { parseYaml } from '../bin/app-spec.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the options ────────────────────────────────────────────────────────── */
console.log('parsing the options');
{
  const d = parseRunArgs([]);
  check('no option: nothing skipped, nothing allowed, no shard', d.skipBrowser === false && d.allowFail.size === 0
    && d.shard === null && d.jobs === null && d.only === null && d.list === false);
  const o = parseRunArgs(['--skip-browser', '--allow-fail=access_pages,truncation.test.mjs', '--shard=2/4', '--jobs=2', '--only=a,b', '--list']);
  check('every option parses, names with or without .test.mjs',
    o.skipBrowser && o.allowFail.has('access_pages.test.mjs') && o.allowFail.has('truncation.test.mjs')
    && o.shard.k === 2 && o.shard.n === 4 && o.jobs === 2 && o.only.has('a.test.mjs') && o.list, JSON.stringify({ ...o, allowFail: [...o.allowFail] }));
  check('a shard outside 1..n is refused', !!parseRunArgs(['--shard=0/4']).error && !!parseRunArgs(['--shard=5/4']).error);
  check('an unknown or malformed option is refused, not ignored',
    !!parseRunArgs(['--skip-browsers']).error && !!parseRunArgs(['--jobs=0']).error && !!parseRunArgs(['--allow-fail']).error);
}

/* ── which files need a browser ─────────────────────────────────────────── */
console.log('\nwhich files need a browser, from their source');
const files = readdirSync('test').filter((f) => f.endsWith('.test.mjs')).sort();
const browser = browserFiles(files);
check('the four files that drive the :8099 mock server are left out',
  ['audit_tools_detect', 'phone_render', 'phone_today_only', 'spacing'].every((f) => browser.has(`${f}.test.mjs`)));
check('a file that imports playwright through a helper is left out, and the helper named',
  /through test\/browser\.mjs/.test(browser.get('absent_columns.test.mjs') || ''), browser.get('absent_columns.test.mjs'));
check('a file that only SPAWNS a Chromium-driving bin/ script is left out, and the script named',
  browser.get('numbers_audit_identity.test.mjs') === 'spawns bin/numbers-audit.mjs, which drives Chromium', browser.get('numbers_audit_identity.test.mjs'));
check('audit_tools_detect is left out for the mock server', /mock server/.test(browser.get('audit_tools_detect.test.mjs') || ''));
check('access_pages and arkiv_classic_frozen (known failures) are browser files too',
  browser.has('access_pages.test.mjs') && browser.has('arkiv_classic_frozen.test.mjs'));
check('API and unit suites are kept',
  ['route_smoke', 'truncation', 'ops_health_budget', 'deploy_scripts', 'run_all_flags', 'access_manifest', 'assets']
    .every((f) => !browser.has(`${f}.test.mjs`)), [...browser.keys()].filter((f) => /route_smoke|truncation|ops_health|deploy_scripts|run_all|access_manifest|^assets/.test(f)).join(','));
check('the count is what the runner\'s header says was measured (within a few files of 88)',
  browser.size >= 80 && browser.size <= 100, String(browser.size));

/* ── shards ─────────────────────────────────────────────────────────────── */
console.log('\nshards are disjoint and together complete');
{
  const kept = files.filter((f) => !browser.has(f));
  const parts = [1, 2, 3, 4].map((k) => shardOf(kept, { k, n: 4 }));
  const union = parts.flat();
  check('four shards cover every kept file exactly once',
    union.length === kept.length && new Set(union).size === kept.length, `${union.length} vs ${kept.length}`);
  check('…and are within one file of each other in size', Math.max(...parts.map((p) => p.length)) - Math.min(...parts.map((p) => p.length)) <= 1);
  check('no shard is the identity', shardOf(kept, null).length === kept.length);
}

/* ── the verdict ────────────────────────────────────────────────────────── */
console.log('\nwhat fails the run');
{
  const r = [{ file: 'a.test.mjs', code: 1, failed: 1 }, { file: 'b.test.mjs', code: 1, failed: 2 },
    { file: 'c.test.mjs', code: 0, failed: 0 }, { file: 'd.test.mjs', code: 0, failed: null }];
  const v = verdict(r, new Set(['b.test.mjs', 'c.test.mjs']));
  check('an allow-listed failure is reported, not counted', v.allowed.map((x) => x.file).join() === 'b.test.mjs');
  check('an allow-listed file that passes is reported as stale', v.allowedPassed.map((x) => x.file).join() === 'c.test.mjs');
  check('everything else that failed — or never reported a tally — fails the run', v.broken.map((x) => x.file).join() === 'a.test.mjs,d.test.mjs');
  check('with no list, the old rule exactly', verdict(r).broken.length === 3);
}

/* ── the runner itself ──────────────────────────────────────────────────── */
console.log('\nthe runner, spawned for real against a sentinel on SMOKE_BASE');
let hits = 0;
const sentinel = createServer((req, res) => {
  hits += 1;
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(req.url.startsWith('/api/trips/daily') ? '[]' : '{}');
});
await new Promise((r) => sentinel.listen(0, '127.0.0.1', r));
const SMOKE = `http://127.0.0.1:${sentinel.address().port}`;
const runner = (args, extraEnv = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['test/run-all.mjs', ...args], {
    env: { ...process.env, SMOKE_BASE: SMOKE, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

{
  hits = 0;
  const r = await runner(['--skip-browser', '--only=access_manifest,phone_render']);
  check('--skip-browser: the sentinel on SMOKE_BASE received no request at all', hits === 0, `${hits} request(s)`);
  check('…the browser file was left out and said so', /phone_render\.test\.mjs: imports playwright/.test(r.out), r.out.slice(0, 400));
  check('…the kept file ran and passed, and the run passed', r.code === 0 && /✓ access_manifest\.test\.mjs/.test(r.out)
    && /1 files, \d+ assertions, 0 file\(s\) failing/.test(r.out), r.out.slice(-400));
}
{
  hits = 0;
  const r = await runner(['--only=access_manifest']);
  check('no option: the runner still probes the browser tests\' server, as before', hits >= 1 && r.code === 0, `${hits} request(s), exit ${r.code}`);
  check('…and adopts an explicit SMOKE_BASE with its warning, as before', /is SMOKE_BASE, so it/.test(r.out), r.out.slice(0, 300));
}
{
  const failing = await runner(['--skip-browser', '--only=access_manifest'], { TEST_FILE_TIMEOUT_MS: '1' });
  check('a file that fails fails the run', failing.code === 1 && /1 file\(s\) failing/.test(failing.out) && /failing: access_manifest\.test\.mjs/.test(failing.out), failing.out.slice(-300));
  const allowed = await runner(['--skip-browser', '--only=access_manifest', '--allow-fail=access_manifest'], { TEST_FILE_TIMEOUT_MS: '1' });
  check('the same failure on --allow-fail is reported and the run passes',
    allowed.code === 0 && /access_manifest\.test\.mjs failed and is on --allow-fail/.test(allowed.out) && /1 allowed to fail/.test(allowed.out), allowed.out.slice(-300));
  const stale = await runner(['--skip-browser', '--only=access_manifest', '--allow-fail=access_manifest']);
  check('an allow-listed file that passes is called out', stale.code === 0 && /is on --allow-fail but PASSED/.test(stale.out), stale.out.slice(-300));
}
{
  const lists = await Promise.all([1, 2].map((k) => runner(['--skip-browser', `--shard=${k}/2`, '--list'])));
  const names = lists.map((l) => l.out.split('\n').filter((x) => /^ {2}[a-z0-9_]+\.test\.mjs$/.test(x)).map((x) => x.trim()));
  const kept = files.filter((f) => !browser.has(f));
  check('--list runs nothing and two shards list every kept file once',
    lists.every((l) => l.code === 0) && names[0].length + names[1].length === kept.length
    && new Set([...names[0], ...names[1]]).size === kept.length, `${names[0].length}+${names[1].length} vs ${kept.length}`);
  const bad = await runner(['--skip-browsers']);
  check('a misspelt option stops the runner with exit 2 before anything runs', bad.code === 2 && /unknown or malformed option/.test(bad.out));
}
sentinel.close();

/* ── the workflow that uses all this ────────────────────────────────────── */
console.log('\n.github/workflows/ci.yml says what it runs');
{
  const ci = parseYaml(readFileSync(join('..', '.github', 'workflows', 'ci.yml'), 'utf8'));
  const steps = Object.values(ci.jobs).flatMap((j) => j.steps);
  const runs = steps.filter((s) => s.run).map((s) => s.run);
  check('on pull requests into the production branch, and on demand',
    JSON.stringify(ci.on.pull_request.branches) === JSON.stringify(['claude/ecosine-egari-tracking-apis-rf9ong'])
    && 'workflow_dispatch' in ci.on, JSON.stringify(ci.on));
  check('read-only token', ci.permissions?.contents === 'read');
  check('Node 22 everywhere', steps.filter((s) => s.uses?.startsWith('actions/setup-node')).every((s) => s.with['node-version'] === 22));
  check('the lockfile must be committed, and is installed with npm ci',
    runs.includes('test -f package-lock.json') && runs.filter((r) => r.startsWith('npm ci')).length === 2);
  /* setup-node's npm cache is keyed on the lockfile and fails first, with an
     error about cache paths, when it is missing — a check after it is dead. */
  {
    const first = ci.jobs['install-and-parse'].steps;
    const iCheck = first.findIndex((s) => s.run === 'test -f package-lock.json');
    const iNode = first.findIndex((s) => s.uses?.startsWith('actions/setup-node'));
    check('…and the lockfile is checked BEFORE setup-node, whose cache would fail on its absence first',
      iCheck >= 0 && iNode >= 0 && iCheck < iNode, `check@${iCheck} setup-node@${iNode}`);
  }
  check('every file under src, api and bin is parsed', runs.some((r) => /^find src api bin .*'\*\.mjs'.*node --check$/.test(r)));
  const test = runs.find((r) => r.startsWith('node test/run-all.mjs'));
  check('the tests skip the browser, allow exactly the three known failures, and shard by the matrix',
    test === 'node test/run-all.mjs --skip-browser --allow-fail=access_pages,arkiv_classic_frozen,truncation --shard=${{ matrix.shard }}/4 --jobs=2', test);
  check('…four shards, each a whole slice of the suite',
    JSON.stringify(ci.jobs.test.strategy.matrix.shard) === JSON.stringify([1, 2, 3, 4]) && ci.jobs.test.strategy['fail-fast'] === false);
  check('…and the runner accepts that command line', !parseRunArgs(test.replace('${{ matrix.shard }}', '1').split(' ').slice(2)).error);
  check('nothing in it deploys', !/deploy\.mjs|digitalocean|doctl/i.test(runs.join('\n')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
