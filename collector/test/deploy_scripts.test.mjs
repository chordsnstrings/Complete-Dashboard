/* The deploy script, the app-spec check and the committed spec — without the
   network.
   ─────────────────────────────────────────────────────────────────────────
   bin/deploy.mjs and bin/app-spec.mjs talk to DigitalOcean, and a test must
   not: every request here goes to a fake fetch that records what it was sent
   and answers what DigitalOcean would. What is proven:

     - the token is never printed: not in --dry-run, not in an error, not when
       the API's own error body echoes it back;
     - a --token-file inside the repository is refused, however it is reached
       (relative, absolute, a symlink either way);
     - a deploy sends exactly {"force_build":true} — COVERAGE trap 25 — then
       polls THE id the POST returned, prints each phase once, and ends on
       ACTIVE (0), ERROR / CANCELED / SUPERSEDED (1) or a timeout (1);
     - the committed spec says what production is (two components, sizes,
       branch, health check, 44 and 46 env keys, COMMIT_SHA bound to
       ${_self.COMMIT_HASH}) and holds no value;
     - redaction leaves no secret in anything compared or printed;
     - the structural diff is silent when the live spec matches and names each
       kind of drift when it does not. */
import { mkdtempSync, writeFileSync, symlinkSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, insideRepo, resolveToken, resolveAppId, parseArgs, scrub, TRAP_25 } from '../bin/do-api.mjs';
import { main as deploy, HELP as DEPLOY_HELP, builtFrom } from '../bin/deploy.mjs';
import { main as appSpec, parseYaml, emitYaml, redactSpec, structureOf, diffStructures, REDACTED, HELP as SPEC_HELP, DEFAULT_SPEC } from '../bin/app-spec.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const COLLECTOR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'dop_v1_TESTTOKEN_0123456789abcdef0123456789abcdef';
const APP = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const tmp = mkdtempSync(join(tmpdir(), 'deploy-test-'));

/* A fake DigitalOcean: answers in order, records every request. */
const fakeDO = (answers) => {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body });
    const a = answers.shift();
    if (!a) throw new Error('fake DO: no answer left');
    if (a.throw) throw a.throw;
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  };
  return { fetchImpl, calls };
};
const capture = () => {
  const lines = [];
  return { lines, out: (m) => lines.push(String(m)), err: (m) => lines.push(`ERR ${m}`), text: () => lines.join('\n') };
};
const dep = (phase, extra = {}) => ({ deployment: { id: 'dep-1', phase, progress: { success_steps: 3, total_steps: 10 }, ...extra } });

/* ── the token and the app id ───────────────────────────────────────────── */
console.log('the token: never printed, never inside the repository');

check('the repository root is found from bin/', repoRoot() && insideRepo(join(COLLECTOR, 'bin', 'deploy.mjs')), String(repoRoot()));
check('a path in the repository is inside it', insideRepo(join(COLLECTOR, 'deploy', 'do.token')));
check('a path in the system temp directory is not', !insideRepo(join(tmp, 'do.token')));
{
  /* A fake repository in the temp dir, so no link is ever made in the real one. */
  const fakeRoot = join(tmp, 'repo'); const outside = join(tmp, 'outside');
  mkdirSync(join(fakeRoot, '.git'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(outside, 'tok'), `${TOKEN}\n`); writeFileSync(join(fakeRoot, 'tok'), `${TOKEN}\n`);
  symlinkSync(join(outside, 'tok'), join(fakeRoot, 'link-out'));
  symlinkSync(join(fakeRoot, 'tok'), join(outside, 'link-in'));
  check('a link inside the repository pointing out is refused', insideRepo(join(fakeRoot, 'link-out'), fakeRoot));
  check('a link outside pointing into the repository is refused', insideRepo(join(outside, 'link-in'), fakeRoot));
  const r = resolveToken({ tokenFile: join(fakeRoot, 'tok'), env: {}, root: fakeRoot });
  check('resolveToken refuses a token file in the repository, and says why',
    r.error && /inside the repository/.test(r.error) && !r.error.includes(TOKEN) && !r.token, JSON.stringify(r));
  const ok = resolveToken({ tokenFile: join(outside, 'tok'), env: {}, root: fakeRoot });
  check('a token file outside the repository is read, trimmed', ok.token === TOKEN && ok.source === '--token-file');
}
{
  writeFileSync(join(tmp, 'empty'), '  \n'); writeFileSync(join(tmp, 'two'), 'a b\n');
  check('an empty token file is refused', /empty/.test(resolveToken({ tokenFile: join(tmp, 'empty'), env: {} }).error || ''));
  check('a token file with two words is refused', /more than one word/.test(resolveToken({ tokenFile: join(tmp, 'two'), env: {} }).error || ''));
  check('a missing token file is refused', /could not read/.test(resolveToken({ tokenFile: join(tmp, 'nope'), env: {} }).error || ''));
  check('DIGITALOCEAN_TOKEN is used when no file is given', resolveToken({ env: { DIGITALOCEAN_TOKEN: TOKEN } }).source === 'DIGITALOCEAN_TOKEN');
  check('no token at all is an error naming both ways to give one', /DIGITALOCEAN_TOKEN.*--token-file/.test(resolveToken({ env: {} }).error));
  check('the app id comes from DO_APP_ID or --app-id', resolveAppId({ env: { DO_APP_ID: APP } }).appId === APP
    && resolveAppId({ appId: APP, env: {} }).appId === APP && /no app id/.test(resolveAppId({ env: {} }).error));
  check('an app id that could reshape the URL is refused', !!resolveAppId({ appId: '../../v2/account', env: {} }).error);
  const a = parseArgs(['--app-id', 'x', '--dry-run', '--token-file=/t'], { flags: ['dry-run'], values: ['app-id', 'token-file'] });
  check('flags parse as --name value, --name=value and bare flags', a['app-id'] === 'x' && a['dry-run'] === true && a['token-file'] === '/t');
  check('an unknown option, or a value left out, is an error',
    !!parseArgs(['--force'], {}).error && !!parseArgs(['--app-id'], { values: ['app-id'] }).error);
  check('scrub removes every copy of the token', scrub(`a ${TOKEN} b ${TOKEN}`, TOKEN) === 'a <redacted> b <redacted>');
}

/* ── bin/deploy.mjs ─────────────────────────────────────────────────────── */
console.log('\nbin/deploy.mjs: force_build, then the phase of THAT deployment');
const env = { DO_APP_ID: APP, DIGITALOCEAN_TOKEN: TOKEN };
const fast = { sleep: async () => {}, now: (() => { let t = Date.UTC(2026, 10, 12, 9); return () => (t += 15_000); })() };

check('--help names COVERAGE trap 25 and force_build', /COVERAGE trap 25/.test(DEPLOY_HELP) && /force_build/.test(DEPLOY_HELP)
  && /LAST BUILT commit/.test(TRAP_25));
{
  const c = capture();
  const fake = fakeDO([]);
  const code = await deploy(['--dry-run'], { env, fetchImpl: fake.fetchImpl, out: c.out, err: c.err });
  check('--dry-run sends nothing', fake.calls.length === 0 && code === 0, `${fake.calls.length} calls, exit ${code}`);
  check('--dry-run shows the POST, the body and the poll',
    c.text().includes(`POST https://api.digitalocean.com/v2/apps/${APP}/deployments`) && c.text().includes('{"force_build":true}')
    && /until ACTIVE, ERROR, CANCELED or SUPERSEDED/.test(c.text()), c.text());
  check('--dry-run shows the token only as <redacted>, with where it came from',
    c.text().includes('Bearer <redacted>') && c.text().includes('DIGITALOCEAN_TOKEN') && !c.text().includes(TOKEN));
}
{
  const c = capture();
  const code = await deploy(['--dry-run'], { env: { DO_APP_ID: APP }, fetchImpl: fakeDO([]).fetchImpl, out: c.out, err: c.err });
  check('--dry-run with no token says a real run would stop, and exits 2', code === 2 && /NO TOKEN/.test(c.text()));
}
{
  const c = capture();
  const code = await deploy(['--token-file', join(COLLECTOR, 'deploy', 'do.token')], { env: { DO_APP_ID: APP }, fetchImpl: fakeDO([]).fetchImpl, out: c.out, err: c.err });
  check('a token file in the repository stops the deploy before any request (exit 2)', code === 2 && /inside the repository/.test(c.text()), c.text());
}
{
  const c = capture();
  const ACTIVE = dep('ACTIVE', { progress: { success_steps: 10, total_steps: 10 },
    services: [{ name: 'api', source_commit_hash: '52cbf9d949ab52cbf9d949ab52cbf9d949ab52cb' }],
    workers: [{ name: 'collector', source_commit_hash: '52cbf9d949ab52cbf9d949ab52cbf9d949ab52cb' }] });
  const fake = fakeDO([{ status: 200, body: dep('PENDING_BUILD') }, { status: 200, body: dep('BUILDING') },
    { status: 200, body: dep('BUILDING') }, { status: 200, body: dep('DEPLOYING') }, { status: 200, body: ACTIVE }]);
  const code = await deploy([], { env, fetchImpl: fake.fetchImpl, out: c.out, err: c.err, ...fast });
  const [first, ...polls] = fake.calls;
  check('the deploy is one POST with exactly {"force_build":true}',
    first.method === 'POST' && first.url === `https://api.digitalocean.com/v2/apps/${APP}/deployments`
    && first.body === '{"force_build":true}', JSON.stringify(first));
  check('…authorised with the token', first.headers.Authorization === `Bearer ${TOKEN}`);
  check('every poll asks for the id the POST returned',
    polls.length === 4 && polls.every((p) => p.method === 'GET' && p.url.endsWith(`/v2/apps/${APP}/deployments/dep-1`)), JSON.stringify(polls.map((p) => p.url)));
  const phases = c.lines.filter((l) => /^\[\d\d:\d\d:\d\d\] /.test(l)).map((l) => l.split(' ')[1]);
  check('each phase is printed once, in order', JSON.stringify(phases) === JSON.stringify(['PENDING_BUILD', 'BUILDING', 'DEPLOYING', 'ACTIVE']), phases.join(','));
  check('ACTIVE exits 0 and names the commit each component was built from',
    code === 0 && c.text().includes('api 52cbf9d949ab') && c.text().includes('collector 52cbf9d949ab'), c.text());
  check('the token appears nowhere in what was printed', !c.text().includes(TOKEN));
}
for (const end of ['ERROR', 'CANCELED', 'SUPERSEDED']) {
  const c = capture();
  const fake = fakeDO([{ status: 200, body: dep('PENDING_BUILD') }, { status: 200, body: dep('BUILDING') }, { status: 200, body: dep(end) }]);
  const code = await deploy([], { env, fetchImpl: fake.fetchImpl, out: c.out, err: c.err, ...fast });
  check(`${end} exits 1 and says so`, code === 1 && c.text().includes(`ended ${end}`), `${code} ${c.text()}`);
}
{
  const c = capture();
  const fake = fakeDO([{ status: 401, body: { id: 'unauthorized', message: `Unable to authenticate you (token ${TOKEN})` } }]);
  const code = await deploy([], { env, fetchImpl: fake.fetchImpl, out: c.out, err: c.err, ...fast });
  check('a refused POST exits 1 with the API\'s reason', code === 1 && /HTTP 401/.test(c.text()) && /Unable to authenticate/.test(c.text()), c.text());
  check('…and an error body that echoes the token is scrubbed', !c.text().includes(TOKEN) && c.text().includes('<redacted>'));
}
{
  const c = capture();
  const fake = fakeDO([{ status: 200, body: dep('PENDING_BUILD') }, { status: 500, body: { message: 'internal' } }, { status: 200, body: dep('ACTIVE', { services: [] }) }]);
  const code = await deploy([], { env, fetchImpl: fake.fetchImpl, out: c.out, err: c.err, ...fast });
  check('one failed poll is reported and polling carries on', code === 0 && /a poll failed \(the deployment carries on\)/.test(c.text()), c.text());
}
{
  const c = capture();
  const answers = [{ status: 200, body: dep('PENDING_BUILD') }];
  for (let k = 0; k < 400; k += 1) answers.push({ status: 200, body: dep('BUILDING') });
  const code = await deploy(['--timeout', '1'], { env, fetchImpl: fakeDO(answers).fetchImpl, out: c.out, err: c.err, ...fast });
  check('a deployment still building at the deadline: exit 1, "nothing was cancelled"', code === 1 && /gave up after 1 min/.test(c.text()) && /nothing was cancelled/.test(c.text()), c.text().slice(-300));
}
check('builtFrom says when a component recorded no commit', builtFrom({ services: [{ name: 'api' }] })[0] === 'api (no commit recorded)');

/* ── the committed spec ─────────────────────────────────────────────────── */
console.log('\ncollector/deploy/app-spec.redacted.yaml');
const specText = readFileSync(DEFAULT_SPEC, 'utf8');
const spec = parseYaml(specText);
const committed = structureOf(spec);
const api = committed.components['service api'];
const worker = committed.components['worker collector'];
check('it parses, and holds the api service and the collector worker',
  !!api && !!worker && Object.keys(committed.components).length === 2, Object.keys(committed.components).join(','));
check('app fleet-dashboard in fra', committed.app.name === 'fleet-dashboard' && committed.app.region === 'fra');
check('both basic-xxs × 1, from the production branch, deploy_on_push off, from collector/Dockerfile',
  [api, worker].every((c) => c.instance_size_slug === 'basic-xxs' && c.instance_count === 1
    && c.branch === 'claude/ecosine-egari-tracking-apis-rf9ong' && c.deploy_on_push === false
    && c.source_dir === 'collector' && c.dockerfile_path === 'collector/Dockerfile' && c.repo === 'chordsnstrings/Complete-Dashboard'));
check('the api runs node api/server.js on 8080; the worker runs the schedule',
  api.run_command === 'node api/server.js' && api.http_port === 8080 && worker.run_command === 'node src/index.js schedule');
check('the health check is /api/health, 30 s initial delay, every 15 s',
  JSON.stringify(api.health_check) === JSON.stringify({ http_path: '/api/health', initial_delay_seconds: 30, period_seconds: 15 }), JSON.stringify(api.health_check));
check('43 + COMMIT_SHA env keys on the api, 45 + COMMIT_SHA on the worker (the 2026-11-12 audit)',
  Object.keys(api.envs).length === 44 && Object.keys(worker.envs).length === 46);
check('19 and 20 of them encrypted (type SECRET)',
  Object.values(api.envs).filter((e) => e.type === 'SECRET').length === 19 && Object.values(worker.envs).filter((e) => e.type === 'SECRET').length === 20);
check('COMMIT_SHA is bound to ${_self.COMMIT_HASH}, scope RUN_TIME, on both',
  [api, worker].every((c) => c.envs.COMMIT_SHA?.value === '${_self.COMMIT_HASH}' && c.envs.COMMIT_SHA.scope === 'RUN_TIME'));
check('every other value is the redaction placeholder',
  [api, worker].every((c) => Object.entries(c.envs).every(([k, e]) => k === 'COMMIT_SHA' || e.value === REDACTED)));
{
  const values = [...specText.matchAll(/^\s+value:\s*(.*)$/gm)].map((m) => m[1].trim());
  check('no value line in the file holds anything else (read as text, not parsed)',
    values.length === 90 && values.every((v) => v === `"${REDACTED}"` || v === '"${_self.COMMIT_HASH}"'), `${values.length} ${values.find((v) => v !== `"${REDACTED}"`)}`);
}
check('the database is the production PG cluster fleet-dashboard-db',
  JSON.stringify(committed.databases) === JSON.stringify({ db: { engine: 'PG', production: true, cluster_name: 'fleet-dashboard-db' } }));

/* ── the YAML subset ────────────────────────────────────────────────────── */
console.log('\nthe YAML reader and writer');
{
  const y = parseYaml('# c\na: 1\nb:\n  c: "x # not a comment"  # a comment\n  d: [no]\n'.replace('[no]', "'it''s'") + 'e:\n  - f: true\n    g: null\n  - plain words\nh:\n- 1\n');
  check('maps, lists of maps, scalars, quotes and comments',
    JSON.stringify(y) === JSON.stringify({ a: 1, b: { c: 'x # not a comment', d: "it's" }, e: [{ f: true, g: null }, 'plain words'], h: [1] }), JSON.stringify(y));
  let refused = 0;
  for (const bad of ['a: [1, 2]\n', 'a: {b: 1}\n', 'a:\n\tb: 1\n', 'a: 1\na: 2\n', 'a: &x 1\n']) { try { parseYaml(bad); } catch { refused += 1; } }
  check('flow collections, tabs, duplicate keys and anchors are refused, not guessed', refused === 5, `${refused} of 5`);
  const obj = { name: 'fleet-dashboard', services: [{ name: 'api', http_port: 8080, deploy_on_push: false,
    health_check: { http_path: '/api/health' }, envs: [{ key: 'A', value: REDACTED }, { key: 'B', scope: 'RUN_TIME', value: '${_self.COMMIT_HASH}' },
      { key: 'C', value: 'has: colon # and hash' }, { key: 'D', value: '123' }, { key: 'E', value: 'true' }] }] };
  check('whatever --print writes, parseYaml reads back exactly', JSON.stringify(parseYaml(emitYaml(obj))) === JSON.stringify(obj), emitYaml(obj));
}

/* ── redaction and drift ────────────────────────────────────────────────── */
console.log('\nredaction, and the structural diff');
/* A live spec as DigitalOcean returns it: the committed structure with real
   values, scopes on every variable, and "collector" without its slash. */
const SECRETS = ['sk-live-SECRET-1', 'postgresql://doadmin:PASSWORD9@db.example:25060/defaultdb', 'EV[1:abc:SECRETENC]', 'dd-api-SECRET', 'ops-person@example.com'];
const liveSpec = () => {
  const s = JSON.parse(JSON.stringify(spec));
  for (const c of [...s.services, ...s.workers]) {
    c.source_dir = 'collector';
    for (const e of c.envs) {
      if (e.key === 'COMMIT_SHA') continue;
      e.scope = 'RUN_AND_BUILD_TIME';
      e.value = e.key === 'DATABASE_URL' ? SECRETS[1] : e.type === 'SECRET' ? SECRETS[2] : SECRETS[0];
    }
  }
  s.log_destinations = [{ name: 'dd', datadog: { endpoint: 'https://http-intake.example', api_key: SECRETS[3] } }];
  s.alerts = [{ rule: 'DEPLOYMENT_FAILED', emails: [SECRETS[4]] }];
  s.ingress = { rules: [{ component: { name: 'api' }, match: { path: { prefix: '/' } } }] };
  return s;
};
{
  const red = JSON.stringify(redactSpec(liveSpec()));
  check('redaction leaves none of the secrets, the connection string or the alert address',
    SECRETS.every((x) => !red.includes(x)), SECRETS.filter((x) => red.includes(x)).join(' | '));
  check('…keeps a bindable reference, which holds no value', red.includes('${_self.COMMIT_HASH}'));
  check('…and keeps every env key name', red.includes('"key":"UBER_CLIENT_SECRET"') && red.includes('"key":"BOLT_REFRESH_TOKEN_EGARI"'));
  check('the live spec as DigitalOcean returns it is in step with the committed file',
    diffStructures(committed, structureOf(redactSpec(liveSpec()))).length === 0,
    diffStructures(committed, structureOf(redactSpec(liveSpec()))).join('; '));
}
const drifted = (mutate) => { const s = liveSpec(); mutate(s); return diffStructures(committed, structureOf(redactSpec(s))); };
{
  const d = drifted((s) => { s.services[0].instance_size_slug = 'basic-xs'; });
  check('a size change is drift, in words', d.length === 1 && d[0] === 'service api: instance_size_slug is basic-xs live, basic-xxs in the committed file', d.join('; '));
  check('the branch', drifted((s) => { s.workers[0].github.branch = 'main'; }).some((x) => /worker collector: branch is main live/.test(x)));
  check('a variable added in DigitalOcean', drifted((s) => { s.services[0].envs.push({ key: 'NEW_ONE', value: 'x' }); }).some((x) => x === 'service api: env NEW_ONE is live but not in the committed file'));
  const missing = drifted((s) => { s.services[0].envs = s.services[0].envs.filter((e) => e.key !== 'COMMIT_SHA'); });
  check('COMMIT_SHA not yet added: named as drift', missing.length === 1 && missing[0] === 'service api: env COMMIT_SHA is in the committed file but not live', missing.join('; '));
  const literal = drifted((s) => { s.workers[0].envs.find((e) => e.key === 'COMMIT_SHA').value = 'deadbeefcafe'; });
  check('COMMIT_SHA set to a literal: the binding is named, the literal is not shown',
    literal.length === 1 && /should be bound to \$\{_self\.COMMIT_HASH\}; live it is a literal value \(not shown\)/.test(literal[0]) && !literal[0].includes('deadbeef'), literal.join('; '));
  check('a secret stored as a plain variable', drifted((s) => { s.services[0].envs.find((e) => e.key === 'HOTEL_TOKEN').type = 'GENERAL'; })
    .some((x) => x === 'service api: env HOTEL_TOKEN is GENERAL live, SECRET in the committed file'));
  check('the health check path', drifted((s) => { s.services[0].health_check.http_path = '/api/ready'; }).some((x) => /health_check\.http_path is \/api\/ready live/.test(x)));
  check('a health check field set only in DigitalOcean', drifted((s) => { s.services[0].health_check.timeout_seconds = 5; })
    .some((x) => x === 'service api: health_check.timeout_seconds is 5 live, (absent) in the committed file'));
  check('a component added in DigitalOcean', drifted((s) => { s.jobs = [{ name: 'backup', instance_size_slug: 'basic-xxs' }]; }).some((x) => x === 'job backup: live but not in the committed file'));
  check('the database cluster', drifted((s) => { s.databases[0].cluster_name = 'other'; }).some((x) => /database db: cluster_name is other live/.test(x)));
  check('ingress, alerts and log destinations are not compared', drifted(() => {}).length === 0);
}

/* bin/app-spec.mjs end to end, against a fake DigitalOcean. */
{
  const c = capture();
  const fake = fakeDO([{ status: 200, body: { app: { spec: liveSpec() } } }]);
  const code = await appSpec(['--check'], { env, fetchImpl: fake.fetchImpl, out: c.out, err: c.err });
  check('--check: in step → exit 0', code === 0 && /in step/.test(c.text()) && fake.calls[0].url === `https://api.digitalocean.com/v2/apps/${APP}` && fake.calls[0].method === 'GET', c.text());
}
{
  const c = capture();
  const s = liveSpec(); s.services[0].instance_count = 2; s.services[0].envs = s.services[0].envs.filter((e) => e.key !== 'COMMIT_SHA');
  const code = await appSpec(['--check'], { env, fetchImpl: fakeDO([{ status: 200, body: { app: { spec: s } } }]).fetchImpl, out: c.out, err: c.err });
  check('--check: drift → exit 1, every difference listed, trap 25 named', code === 1 && /DRIFT — 2 differences/.test(c.text())
    && /instance_count is 2 live/.test(c.text()) && /env COMMIT_SHA is in the committed file but not live/.test(c.text()) && /trap 25/.test(c.text()), c.text());
  check('…and prints no secret and no token', SECRETS.every((x) => !c.text().includes(x)) && !c.text().includes(TOKEN));
}
{
  const c = capture();
  const code = await appSpec(['--print'], { env, fetchImpl: fakeDO([{ status: 200, body: { app: { spec: liveSpec() } } }]).fetchImpl, out: c.out, err: c.err });
  const printed = c.text();
  check('--print: the live spec as YAML, redacted, that the reader parses back',
    code === 0 && SECRETS.every((x) => !printed.includes(x)) && parseYaml(printed).services[0].name === 'api', printed.slice(0, 200));
}
{
  const c = capture();
  const code = await appSpec(['--check'], { env, fetchImpl: fakeDO([{ status: 403, body: { message: `forbidden for ${TOKEN}` } }]).fetchImpl, out: c.out, err: c.err });
  check('--check: an API refusal → exit 2, scrubbed', code === 2 && /HTTP 403/.test(c.text()) && !c.text().includes(TOKEN), c.text());
}
check('--help for app-spec names trap 25', /COVERAGE trap 25/.test(SPEC_HELP));

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
