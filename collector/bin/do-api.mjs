/* What bin/deploy.mjs and bin/app-spec.mjs share: the DigitalOcean token, the
   app id, and one way to call the API without ever printing either secret.
   ─────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS. Production has been deployed fourteen times in three weeks
   (20 Oct – 11 Nov 2026, all manual) by a script and a token file that lived
   in a session scratchpad — and both were lost with that container on
   2026-10-19 (CLAUDE.md, "Deploying"). A scratchpad is not storage. The
   scripts now live in the repository; the token never does.

   THE TOKEN comes from DIGITALOCEAN_TOKEN, or from --token-file <path>. A path
   inside the repository is refused, whatever it holds and however it is
   spelled (a relative path, an absolute one, or a symlink in either direction):
   a token file beside the code is one `git add -A` from being published, and
   CLAUDE.md's first rule about credentials is that they never enter the
   repository. The token is never printed — not in --dry-run, not in an error,
   and not inside an error body the API sends back, which is scrubbed of it
   before it is shown.

   THE APP ID comes from DO_APP_ID or --app-id. It is not a secret, but it is
   held outside the repository like the token (CLAUDE.md), so it is not
   written in any committed file either.

   COVERAGE trap 25 is printed by both scripts' --help, because it is the one
   fact about this platform that has cost a whole deploy: an app-spec update
   (PUT /v2/apps/{id}, or saving variables in the control panel) starts a
   deployment that re-runs the LAST BUILT commit with the new spec. It never
   builds the branch head. Only POST /v2/apps/{id}/deployments with
   {"force_build":true} does. */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const API = 'https://api.digitalocean.com';

export const TRAP_25 = [
  'COVERAGE trap 25 — an app-spec update does not deploy the branch head.',
  '  Changing the spec (PUT /v2/apps/{id}, or saving an environment variable in',
  '  the control panel) starts a deployment that re-runs the LAST BUILT commit',
  '  with the new spec; it builds nothing. It once re-ran e79bf05 with new',
  '  variables that code ignored. Only POST /v2/apps/{id}/deployments with',
  '  {"force_build":true} builds the branch head — which is what bin/deploy.mjs',
  '  sends. After any deployment, compare the commit it reports (and the commit',
  '  /api/health reports) with the branch before believing a single check.',
].join('\n');

/* The repository root: the nearest directory above this file holding a .git
   entry (a directory in a checkout, a file in a worktree). */
export function repoRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let d = resolve(from);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const inside = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/* Is this path inside the repository? Checked on the path as given (resolved
   against the working directory) AND on its real path, so neither a symlink
   in the repository pointing out, nor one outside pointing in, gets past. */
export function insideRepo(path, root = repoRoot()) {
  if (!root) return false;
  const roots = [resolve(root)];
  try { roots.push(realpathSync(root)); } catch { /* the root itself is always real here */ }
  const given = resolve(path);
  let real = given;
  try { real = realpathSync(given); } catch { /* a missing file is refused later, by the read */ }
  return roots.some((r) => inside(given, r) || inside(real, r));
}

/* The token and where it came from — never the token in any message. */
export function resolveToken({ tokenFile = null, env = process.env, root = repoRoot() } = {}) {
  if (tokenFile) {
    if (insideRepo(tokenFile, root)) {
      return { error: `refusing --token-file ${tokenFile}: it is inside the repository (${root}). `
        + 'Keep the token outside the checkout — CLAUDE.md: credentials never enter the repository.' };
    }
    let text;
    try { text = readFileSync(tokenFile, 'utf8'); } catch (e) {
      return { error: `could not read --token-file ${tokenFile}: ${e.code || e.message}` };
    }
    const token = text.trim();
    if (!token) return { error: `--token-file ${tokenFile} is empty` };
    if (/\s/.test(token)) return { error: `--token-file ${tokenFile} holds more than one word; it must hold only the token` };
    return { token, source: '--token-file' };
  }
  const t = String(env.DIGITALOCEAN_TOKEN || '').trim();
  if (t) return { token: t, source: 'DIGITALOCEAN_TOKEN' };
  return { error: 'no DigitalOcean token: set DIGITALOCEAN_TOKEN or pass --token-file <path outside the repository>' };
}

export function resolveAppId({ appId = null, env = process.env } = {}) {
  const id = String(appId || env.DO_APP_ID || '').trim();
  if (!id) return { error: 'no app id: set DO_APP_ID or pass --app-id <id>' };
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return { error: 'the app id must be letters, digits and dashes (a DigitalOcean app UUID)' };
  return { appId: id };
}

/* Minimal flag parsing: --name value, --name=value, and bare --flags. */
export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const name = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    if (flags.includes(name)) { out[name] = true; continue; }
    if (values.includes(name)) {
      const v = eq > 0 ? a.slice(eq + 1) : argv[i + 1];
      if (eq < 0) i += 1;
      if (v === undefined || (eq < 0 && v.startsWith('--'))) return { error: `--${name} needs a value` };
      out[name] = v;
      continue;
    }
    return { error: `unknown option --${name}` };
  }
  return out;
}

/* Never let the token reach the terminal, even inside an error the API sends. */
export const scrub = (text, token) => (token ? String(text).split(token).join('<redacted>') : String(text));

/* One API call. Returns { ok, status, body } and never throws for an HTTP
   error; a network failure becomes { ok:false, status:0, body:{message} }. */
export async function doRequest({ method = 'GET', path, token, body = undefined, fetchImpl = fetch }) {
  let r;
  try {
    r = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    return { ok: false, status: 0, body: { message: scrub(e?.cause?.code || e?.message || String(e), token) } };
  }
  const text = await r.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: scrub(text.slice(0, 300), token) }; }
  return { ok: r.ok, status: r.status, body: parsed };
}

/* An API error, said once, scrubbed. */
export const apiError = (what, res, token) => `${what}: HTTP ${res.status} — `
  + scrub(res.body?.message || res.body?.id || JSON.stringify(res.body).slice(0, 300), token);
