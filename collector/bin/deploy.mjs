#!/usr/bin/env node
/* Deploy the branch head to DigitalOcean App Platform, and watch it land.
   ─────────────────────────────────────────────────────────────────────────
     DO_APP_ID=<app id> DIGITALOCEAN_TOKEN=<token> node bin/deploy.mjs
     node bin/deploy.mjs --app-id <id> --token-file ~/do.token
     node bin/deploy.mjs --dry-run          what it would send, and nothing sent

   WHAT IT DOES. One POST, then polling:
     POST https://api.digitalocean.com/v2/apps/$DO_APP_ID/deployments
          {"force_build":true}
     GET  …/deployments/<the id that POST returned>, every --interval seconds,
          printing each phase as it changes (PENDING_BUILD, BUILDING,
          PENDING_DEPLOY, DEPLOYING …), until ACTIVE, ERROR or CANCELED — or
          SUPERSEDED, which means a newer deployment replaced this one before
          it finished and is therefore an outcome too, not a phase to wait on.
   On ACTIVE it prints the commit each component was built from
   (services[].source_commit_hash), which is the check COVERAGE trap 25 says to
   make before believing anything else.

   Exit status: 0 ACTIVE; 1 ERROR, CANCELED, SUPERSEDED, a timeout or an API
   refusal; 2 a usage error (no token, no app id, a token file in the repo).

   Production builds from claude/ecosine-egari-tracking-apis-rf9ong and nothing
   deploys on push (deploy_on_push is off — collector/deploy/app-spec.redacted.yaml):
   push the branch first, then run this.

   THE POLL IS ON THE ID THE POST RETURNED, never "the latest deployment": a
   spec update or a second deploy started by someone else would otherwise be
   watched in its place, and its phase reported as this one's.

   bin/do-api.mjs holds the token rules (never printed; a path inside the
   repository refused). */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs, resolveToken, resolveAppId, doRequest, apiError, scrub, TRAP_25, API } from './do-api.mjs';

export const TERMINAL = { ACTIVE: 0, ERROR: 1, CANCELED: 1, SUPERSEDED: 1 };
export const BODY = { force_build: true };

export const HELP = `Deploy the branch head to DigitalOcean App Platform and watch it land.

  node bin/deploy.mjs [--app-id <id>] [--token-file <path>] [--dry-run]
                      [--interval <seconds>] [--timeout <minutes>]

  --app-id <id>        the app (default: DO_APP_ID)
  --token-file <path>  read the API token from a file OUTSIDE the repository
                       (default: DIGITALOCEAN_TOKEN). The token is never printed.
  --dry-run            print the request it would send, send nothing
  --interval <s>       seconds between polls (default 15, at least 5)
  --timeout <min>      give up after this many minutes (default 30)

Sends POST ${API}/v2/apps/$DO_APP_ID/deployments {"force_build":true},
then polls that deployment's phase until ACTIVE, ERROR, CANCELED or SUPERSEDED.
Exit 0 on ACTIVE, 1 on any other outcome, 2 on a usage error.

${TRAP_25}

After ACTIVE, read the live commit through the public URL as well:
  curl -s "https://<app>/api/health?_=$RANDOM"   → "commit" (needs COMMIT_SHA bound
  to \${_self.COMMIT_HASH} — collector/deploy/app-spec.redacted.yaml).
`;

const clock = (t) => new Date(t).toISOString().slice(11, 19);

/* The commit each component of a deployment was built from. */
export function builtFrom(dep) {
  const out = [];
  for (const kind of ['services', 'workers', 'jobs', 'static_sites']) {
    for (const c of dep?.[kind] || []) {
      if (c?.name) out.push(`${c.name} ${c.source_commit_hash ? c.source_commit_hash.slice(0, 12) : '(no commit recorded)'}`);
    }
  }
  return out;
}

const steps = (dep) => {
  const p = dep?.progress;
  return p && Number.isFinite(p.total_steps) ? ` (steps ${p.success_steps ?? 0}/${p.total_steps}`
    + `${p.error_steps ? `, ${p.error_steps} failed` : ''})` : '';
};

export async function main(argv, {
  env = process.env, fetchImpl = fetch, out = console.log, err = console.error,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
} = {}) {
  const args = parseArgs(argv, { flags: ['dry-run', 'help'], values: ['app-id', 'token-file', 'interval', 'timeout'] });
  if (args.error) { err(`${args.error}\n\n${HELP}`); return 2; }
  if (args.help) { out(HELP); return 0; }
  const interval = Number(args.interval ?? 15);
  const timeoutMin = Number(args.timeout ?? 30);
  if (!(interval >= 5) || !(timeoutMin > 0)) { err('--interval must be at least 5 seconds and --timeout above 0 minutes'); return 2; }

  const app = resolveAppId({ appId: args['app-id'], env });
  const tok = resolveToken({ tokenFile: args['token-file'], env });

  if (args['dry-run']) {
    out('DRY RUN — nothing is sent.');
    out(`  POST ${API}/v2/apps/${app.appId || '<no app id: set DO_APP_ID or --app-id>'}/deployments`);
    out(`  Authorization: Bearer <redacted> — ${tok.token ? `token from ${tok.source}` : `NO TOKEN (${tok.error}); a real run would stop here`}`);
    out('  Content-Type: application/json');
    out(`  body: ${JSON.stringify(BODY)}`);
    out(`then GET ${API}/v2/apps/${app.appId || '<app id>'}/deployments/<the id returned> every ${interval} s,`);
    out(`  printing each phase, until ACTIVE, ERROR, CANCELED or SUPERSEDED (giving up after ${timeoutMin} min).`);
    out('');
    out(TRAP_25);
    return app.error || tok.error ? 2 : 0;
  }
  if (app.error) { err(app.error); return 2; }
  if (tok.error) { err(tok.error); return 2; }
  const { token } = tok;

  const started = await doRequest({ method: 'POST', path: `/v2/apps/${app.appId}/deployments`, token, body: BODY, fetchImpl });
  if (!started.ok || !started.body?.deployment?.id) {
    err(apiError('the deployment was not started', started, token));
    return 1;
  }
  const id = started.body.deployment.id;
  out(`deployment ${id} started (force_build) — token from ${tok.source}`);

  const deadline = now() + timeoutMin * 60_000;
  let last = null;
  let dep = started.body.deployment;
  for (;;) {
    const phase = dep?.phase || 'UNKNOWN';
    if (phase !== last) {
      out(`[${clock(now())}] ${phase}${steps(dep)}`);
      last = phase;
    }
    if (phase in TERMINAL) {
      if (phase === 'ACTIVE') {
        out('ACTIVE — built from:');
        for (const line of builtFrom(dep)) out(`  ${line}`);
        out('Compare that with the branch head, and with /api/health\'s "commit", before believing any other check.');
      } else {
        err(`deployment ${id} ended ${phase}${steps(dep)}.`
          + (phase === 'SUPERSEDED' ? ' A newer deployment replaced it before it finished.' : ' Read its build and deploy logs in DigitalOcean.'));
      }
      return TERMINAL[phase];
    }
    if (now() >= deadline) {
      err(`gave up after ${timeoutMin} min with deployment ${id} still ${phase}. It is still running in DigitalOcean; nothing was cancelled.`);
      return 1;
    }
    await sleep(interval * 1000);
    const polled = await doRequest({ path: `/v2/apps/${app.appId}/deployments/${id}`, token, fetchImpl });
    if (!polled.ok) {
      /* One failed poll is not a failed deploy: say so, and keep polling until
         the deadline. The deployment carries on regardless of us. */
      err(scrub(apiError(`[${clock(now())}] a poll failed (the deployment carries on)`, polled, token), token));
      continue;
    }
    dep = polled.body?.deployment || dep;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
