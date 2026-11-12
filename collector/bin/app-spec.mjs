#!/usr/bin/env node
/* Is the live App Platform spec the one in the repository?
   ─────────────────────────────────────────────────────────────────────────
     node bin/app-spec.mjs --check     compare the live spec with
                                       collector/deploy/app-spec.redacted.yaml;
                                       exit 1 on drift
     node bin/app-spec.mjs --print     the live spec, redacted, as YAML — to
                                       refresh the committed file after a
                                       deliberate change in DigitalOcean
   Both read DO_APP_ID / --app-id and DIGITALOCEAN_TOKEN / --token-file, the
   same way bin/deploy.mjs does (bin/do-api.mjs). Neither changes anything.

   WHY. Until now the spec existed only inside DigitalOcean: two components,
   their sizes, the branch they build from, 43 and 45 environment variables,
   the health check. Nothing in the repository said what production was, so
   nothing could notice it changing — and a spec change is not a code change
   (COVERAGE trap 25: it redeploys the last BUILT commit). The committed file
   is the record; this is the check that the record is still true.

   REDACTION. Every environment variable's value is replaced by
   '<set in DigitalOcean>' before anything is compared or printed — with one
   exception: a value that is nothing but a single bindable reference, like
   ${_self.COMMIT_HASH} or ${db.DATABASE_URL}, is kept, because a reference
   names where a value comes from and holds none, and whether COMMIT_SHA is
   bound to the right one is exactly the kind of drift this exists to catch.
   Any other field whose name says token, secret, password, key or credential,
   and anything shaped like an email address (alert recipients), is replaced
   the same way, wherever it sits in the spec.

   WHAT IS COMPARED — the structure, not the secrets:
     app        name, region
     components which services/workers/jobs/static sites/functions exist; for
                each: source (repo, branch, deploy_on_push), source_dir,
                dockerfile_path, run_command, http_port, instance size and
                count, autoscaling, the health check (every field either side
                states), and the environment: the SET of keys, each key's type
                (SECRET or GENERAL), its scope where the committed file states
                one, and its value only where the committed file states a
                bindable reference
     databases  name, engine, production, cluster
   A field the committed file leaves out is compared only where its absence
   means a default (deploy_on_push: false, instance_count: 1, type GENERAL).
   Paths are compared without a leading "./" or "/", so "/collector" and
   "collector" are one directory. Ingress rules, domains, alerts and features
   are not compared.

   The committed file is YAML, and this repository carries no YAML library
   (package.json has six runtime dependencies and none is one). parseYaml below
   reads the block-style subset that file and --print use — maps, lists,
   scalars, comments — and refuses anything else loudly rather than guess.
   test/deploy_scripts.test.mjs pins it, and the committed file was checked
   against PyYAML once when it was written (FIX-STATUS OPS3). */
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { parseArgs, resolveToken, resolveAppId, doRequest, apiError, TRAP_25 } from './do-api.mjs';

export const REDACTED = '<set in DigitalOcean>';
export const DEFAULT_SPEC = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'app-spec.redacted.yaml');
const KINDS = ['services', 'workers', 'jobs', 'static_sites', 'functions'];

/* ── a YAML subset: block maps, block lists, scalars, comments ─────────── */

const stripComment = (line) => {
  let q = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) { if (c === q && line[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
};

export function scalar(s) {
  const v = s.trim();
  if (v.startsWith('"')) {
    if (!v.endsWith('"') || v.length < 2) throw new Error(`unterminated string: ${v}`);
    return JSON.parse(v);
  }
  if (v.startsWith("'")) {
    if (!v.endsWith("'") || v.length < 2) throw new Error(`unterminated string: ${v}`);
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[[{]/.test(v) || /^[&*!|>%@`]/.test(v)) {
    throw new Error(`this parser reads plain block YAML only; quote or rewrite: ${v}`);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~' || v === '') return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  return v;
}

const KEY = /^("[^"]*"|'[^']*'|[A-Za-z0-9_.\-/]+):(?:\s+(.*))?$/;
const isItem = (t) => t === '-' || t.startsWith('- ');

export function parseYaml(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    if (/^\s*\t/.test(raw)) throw new Error(`line ${n + 1}: a tab in the indentation`);
    const body = stripComment(raw);
    if (!body.trim()) return;
    if (body.trim() === '---') return;
    lines.push({ indent: body.match(/^ */)[0].length, text: body.trim(), n: n + 1 });
  });
  let i = 0;
  const block = (indent) => (isItem(lines[i].text) ? seq(indent) : map(indent));
  function map(indent) {
    const obj = {};
    while (i < lines.length && lines[i].indent === indent && !isItem(lines[i].text)) {
      const m = lines[i].text.match(KEY);
      if (!m) throw new Error(`line ${lines[i].n}: expected "key: value", got: ${lines[i].text}`);
      const key = scalar(m[1]);
      if (Object.prototype.hasOwnProperty.call(obj, key)) throw new Error(`line ${lines[i].n}: duplicate key ${key}`);
      const rest = m[2] === undefined ? '' : m[2];
      i += 1;
      if (rest.trim() !== '') { obj[key] = scalar(rest); continue; }
      if (i < lines.length && lines[i].indent > indent) obj[key] = block(lines[i].indent);
      else if (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) obj[key] = seq(indent);
      else obj[key] = null;
    }
    if (i < lines.length && lines[i].indent > indent) throw new Error(`line ${lines[i].n}: unexpected indentation`);
    return obj;
  }
  function seq(indent) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && isItem(lines[i].text)) {
      const after = lines[i].text === '-' ? '' : lines[i].text.slice(2);
      if (after.trim() === '') {
        i += 1;
        arr.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null);
        continue;
      }
      if (KEY.test(after.trim())) {
        const inner = indent + (lines[i].text.length - after.trimStart().length);
        lines[i] = { ...lines[i], indent: inner, text: after.trim() };
        arr.push(map(inner));
        continue;
      }
      arr.push(scalar(after));
      i += 1;
    }
    return arr;
  }
  if (!lines.length) return null;
  const doc = block(lines[0].indent);
  if (i < lines.length) throw new Error(`line ${lines[i].n}: could not read past here`);
  return doc;
}

/* The writer --print uses. Strings are double-quoted (JSON's quoting is valid
   YAML) unless they are plainly safe; parseYaml reads every byte back. */
const plainSafe = (s) => /^[A-Za-z0-9_./-]+$/.test(s) && !/^(true|false|null|~|-?\d+)$/.test(s) && !s.startsWith('-');
const emitScalar = (v) => (v === null || v === undefined ? 'null' : typeof v === 'string'
  ? (plainSafe(v) ? v : JSON.stringify(v)) : String(v));

export function emitYaml(v, indent = 0) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) throw new Error('an empty list cannot be written in block style');
    return v.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const body = emitYaml(item, indent + 2).split('\n');
        return `${pad}- ${body[0].trimStart()}${body.length > 1 ? `\n${body.slice(1).join('\n')}` : ''}`;
      }
      if (Array.isArray(item)) return `${pad}-\n${emitYaml(item, indent + 2)}`;
      return `${pad}- ${emitScalar(item)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    return Object.entries(v).filter(([, x]) => !(Array.isArray(x) && x.length === 0)).map(([k, x]) => {
      const key = plainSafe(k) ? k : JSON.stringify(k);
      if (x && typeof x === 'object') {
        if (!Array.isArray(x) && !Object.keys(x).length) return `${pad}${key}: null`;
        return `${pad}${key}:\n${emitYaml(x, indent + 2)}`;
      }
      return `${pad}${key}: ${emitScalar(x)}`;
    }).join('\n');
  }
  return `${pad}${emitScalar(v)}`;
}

/* ── redaction ──────────────────────────────────────────────────────────── */

export const isReference = (v) => typeof v === 'string' && /^\$\{[A-Za-z0-9_.-]+\}$/.test(v.trim());
const SECRETISH = /token|secret|password|passwd|api_?key|credential|private_?key|webhook/i;
const EMAIL = /[^\s@"']+@[^\s@"']+\.[A-Za-z]{2,}/;

/* A deep copy with every env value redacted (references kept), every
   secret-named string field redacted, and every email-shaped string redacted. */
export function redactSpec(spec) {
  const walk = (v, key = '', inEnv = false) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, key, inEnv));
    if (v && typeof v === 'object') {
      const out = {};
      const isEnv = inEnv && 'key' in v;
      for (const [k, x] of Object.entries(v)) {
        if (isEnv && k === 'value') { out[k] = isReference(x) ? x.trim() : REDACTED; continue; }
        out[k] = walk(x, k, k === 'envs');
      }
      return out;
    }
    if (typeof v === 'string') {
      if (SECRETISH.test(key)) return REDACTED;
      if (EMAIL.test(v)) return REDACTED;
    }
    return v;
  };
  return walk(spec);
}

/* ── the structure, and what differs ────────────────────────────────────── */

const normPath = (p) => (p === undefined || p === null || p === '' ? null
  : String(p).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '') || '.');

function envShape(envs) {
  const out = {};
  for (const e of envs || []) {
    if (!e?.key) continue;
    out[e.key] = { type: e.type || 'GENERAL', scope: e.scope ?? null, value: isReference(e.value) ? e.value.trim() : REDACTED };
  }
  return out;
}

export function structureOf(spec) {
  const s = { app: { name: spec?.name ?? null, region: spec?.region ?? null }, components: {}, databases: {},
    app_envs: envShape(spec?.envs) };
  for (const kind of KINDS) {
    for (const c of spec?.[kind] || []) {
      const srcKind = ['github', 'gitlab', 'bitbucket', 'git', 'image'].find((k) => c[k]) || null;
      const src = srcKind ? c[srcKind] : {};
      s.components[`${kind.replace(/s$/, '')} ${c.name}`] = {
        source: srcKind,
        repo: src.repo ?? src.repo_clone_url ?? src.repository ?? null,
        branch: src.branch ?? null,
        deploy_on_push: Boolean(src.deploy_on_push),
        source_dir: normPath(c.source_dir),
        dockerfile_path: normPath(c.dockerfile_path),
        run_command: c.run_command ?? null,
        http_port: c.http_port ?? null,
        instance_size_slug: c.instance_size_slug ?? null,
        instance_count: c.instance_count ?? 1,
        autoscaling: c.autoscaling ?? null,
        health_check: c.health_check && Object.keys(c.health_check).length ? c.health_check : null,
        envs: envShape(c.envs),
      };
    }
  }
  for (const d of spec?.databases || []) {
    s.databases[d.name] = { engine: d.engine ?? null, production: Boolean(d.production), cluster_name: d.cluster_name ?? null };
  }
  return s;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => (v === null || v === undefined ? '(absent)' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function diffEnvs(where, want, got, out) {
  for (const k of Object.keys(want)) if (!(k in got)) out.push(`${where}: env ${k} is in the committed file but not live`);
  for (const k of Object.keys(got)) if (!(k in want)) out.push(`${where}: env ${k} is live but not in the committed file`);
  for (const k of Object.keys(want)) {
    if (!(k in got)) continue;
    const w = want[k]; const g = got[k];
    if (w.type !== g.type) out.push(`${where}: env ${k} is ${g.type} live, ${w.type} in the committed file`);
    if (w.scope !== null && w.scope !== g.scope) out.push(`${where}: env ${k} scope is ${show(g.scope)} live, ${w.scope} in the committed file`);
    if (w.value !== REDACTED && w.value !== g.value) {
      out.push(`${where}: env ${k} should be bound to ${w.value}; live it is `
        + (g.value === REDACTED ? 'a literal value (not shown)' : g.value));
    }
  }
}

/* Every difference, in words. Empty when the live spec is the committed one. */
export function diffStructures(want, got) {
  const out = [];
  for (const f of ['name', 'region']) if (!same(want.app[f], got.app[f])) out.push(`app ${f}: ${show(got.app[f])} live, ${show(want.app[f])} in the committed file`);
  for (const c of Object.keys(want.components)) if (!(c in got.components)) out.push(`${c}: in the committed file but not live`);
  for (const c of Object.keys(got.components)) if (!(c in want.components)) out.push(`${c}: live but not in the committed file`);
  for (const c of Object.keys(want.components)) {
    const w = want.components[c]; const g = got.components[c];
    if (!g) continue;
    for (const f of ['source', 'repo', 'branch', 'deploy_on_push', 'source_dir', 'dockerfile_path', 'run_command',
      'http_port', 'instance_size_slug', 'instance_count', 'autoscaling']) {
      if (!same(w[f], g[f])) out.push(`${c}: ${f} is ${show(g[f])} live, ${show(w[f])} in the committed file`);
    }
    const hk = new Set([...Object.keys(w.health_check || {}), ...Object.keys(g.health_check || {})]);
    for (const k of [...hk].sort()) {
      if (!same(w.health_check?.[k], g.health_check?.[k])) {
        out.push(`${c}: health_check.${k} is ${show(g.health_check?.[k])} live, ${show(w.health_check?.[k])} in the committed file`);
      }
    }
    diffEnvs(c, w.envs, g.envs, out);
  }
  diffEnvs('app', want.app_envs, got.app_envs, out);
  for (const d of Object.keys(want.databases)) if (!(d in got.databases)) out.push(`database ${d}: in the committed file but not live`);
  for (const d of Object.keys(got.databases)) if (!(d in want.databases)) out.push(`database ${d}: live but not in the committed file`);
  for (const d of Object.keys(want.databases)) {
    if (!got.databases[d]) continue;
    for (const f of ['engine', 'production', 'cluster_name']) {
      if (!same(want.databases[d][f], got.databases[d][f])) {
        out.push(`database ${d}: ${f} is ${show(got.databases[d][f])} live, ${show(want.databases[d][f])} in the committed file`);
      }
    }
  }
  return out;
}

export const HELP = `Compare the live App Platform spec with the one in the repository.

  node bin/app-spec.mjs --check [--spec <file>] [--app-id <id>] [--token-file <path>]
  node bin/app-spec.mjs --print [--app-id <id>] [--token-file <path>]

  --check   GET the live spec, redact every env value, and compare its structure
            (components, sizes, branch, env key sets, health check, databases)
            with collector/deploy/app-spec.redacted.yaml. Exit 0 in step,
            1 on drift, 2 on a usage or API error.
  --print   print the live spec, redacted, as YAML (to refresh the committed
            file after a deliberate change in DigitalOcean).
  App id from DO_APP_ID or --app-id; token from DIGITALOCEAN_TOKEN or
  --token-file (a path outside the repository). Nothing is changed.

${TRAP_25}
`;

export async function main(argv, { env = process.env, fetchImpl = fetch, out = console.log, err = console.error } = {}) {
  const args = parseArgs(argv, { flags: ['check', 'print', 'help'], values: ['spec', 'app-id', 'token-file'] });
  if (args.error) { err(`${args.error}\n\n${HELP}`); return 2; }
  if (args.help || (!args.check && !args.print)) { (args.help ? out : err)(HELP); return args.help ? 0 : 2; }

  let want = null;
  if (args.check) {
    const file = args.spec || DEFAULT_SPEC;
    try { want = structureOf(parseYaml(readFileSync(file, 'utf8'))); } catch (e) {
      err(`could not read the committed spec ${file}: ${e.message}`);
      return 2;
    }
  }
  const app = resolveAppId({ appId: args['app-id'], env });
  if (app.error) { err(app.error); return 2; }
  const tok = resolveToken({ tokenFile: args['token-file'], env });
  if (tok.error) { err(tok.error); return 2; }

  const res = await doRequest({ path: `/v2/apps/${app.appId}`, token: tok.token, fetchImpl });
  if (!res.ok || !res.body?.app?.spec) { err(apiError('could not read the live spec', res, tok.token)); return 2; }
  const live = redactSpec(res.body.app.spec);

  if (args.print) {
    out('# The live App Platform spec, redacted by bin/app-spec.mjs --print.');
    out(emitYaml(live));
    if (!args.check) return 0;
  }
  const drift = diffStructures(want, structureOf(live));
  if (!drift.length) {
    out('in step: the live spec matches collector/deploy/app-spec.redacted.yaml '
      + `(${Object.keys(want.components).length} components; env values not compared, only keys, types and bindings).`);
    return 0;
  }
  out(`DRIFT — ${drift.length} difference${drift.length === 1 ? '' : 's'} between the live spec and the committed file:`);
  for (const d of drift) out(`  - ${d}`);
  out('If the live spec is right, refresh the file from `node bin/app-spec.mjs --print` and commit it;');
  out('if the file is right, change the spec in DigitalOcean — and then force a build (bin/deploy.mjs),');
  out('because a spec change alone redeploys the last BUILT commit (COVERAGE trap 25).');
  return 1;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
