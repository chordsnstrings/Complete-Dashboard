/* ── two businesses, two logins, two KINDS of login ────────────────────────
   The supplier session is a browser login and has always been per-org: that is
   why trips and the GraphQL earnings work for both fleets. Proven again here
   against production on 2026-08-27 — the Egari session generates a report for
   the Egari org and gets `permission-denied` for the Ecosine org, so one
   session cannot serve both and two logins are structural, not a preference.

   The OAuth client is NOT a login. It is a registered application, and an
   application is registered under one org. One client pair was shared by both
   fleets, `/v1/vehicle-suppliers/orgs` on it returns exactly one org
   (ECOSINE TRANSPORTS), and every Egari REST call 403s. No org id fixes that.

   So the client is per-fleet too — falling back to the shared pair, which is
   exactly the behaviour that existed before and stays the behaviour until an
   Egari-scoped application exists. These tests hold that fallback, and hold
   the two bugs a per-fleet client introduces if written carelessly: one token
   cache handing fleet A's token to fleet B, and one org-list cache answering
   fleet B's question with fleet A's answer. */
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* config.js reads process.env through get(), so the environment IS the fixture.
   Set before the import, because the getter closes over nothing but env. */
process.env.UBER_CLIENT_ID = 'shared-id';
process.env.UBER_CLIENT_SECRET = 'shared-secret';
process.env.UBER_ORG_UUID = 'eco-uuid';
process.env.UBER_ORG_ENCRYPTED = 'eco-org';
process.env.UBER_WEB_COOKIE = 'eco-cookie';
process.env.UBER_ORG_UUID_EGARI = 'ega-uuid';
process.env.UBER_ORG_ENCRYPTED_EGARI = 'ega-org';
process.env.UBER_WEB_COOKIE_EGARI = 'ega-cookie';
delete process.env.UBER_CLIENT_ID_EGARI;
delete process.env.UBER_CLIENT_SECRET_EGARI;

const { config } = await import('../src/config.js');
const byFleet = () => Object.fromEntries(config.uber.orgs.map((o) => [o.fleet, o]));

/* ── the fallback: nothing changes until a second application exists ─────── */
{
  const o = byFleet();
  check('both fleets are collected', Object.keys(o).sort().join() === 'ecosine,egari',
    Object.keys(o).join());
  check('with no Egari client, Egari falls back to the shared one',
    o.egari.oauth.clientId === 'shared-id' && o.egari.oauth.clientSecret === 'shared-secret',
    JSON.stringify(o.egari.oauth));
  /* The distinction the banner needs: sharing a client and owning one fail for
     different reasons and have different remedies. */
  check('and is marked as NOT having a client of its own', o.egari.oauth.own === false);
  check('while Ecosine, whose org the shared client is registered under, does',
    o.ecosine.oauth.own === true);
  check('the credential named for a failure is the one that actually signed it',
    o.egari.oauth.secretKey === 'UBER_CLIENT_SECRET'
    && o.ecosine.oauth.secretKey === 'UBER_CLIENT_SECRET',
    `${o.egari.oauth.secretKey} / ${o.ecosine.oauth.secretKey}`);
}

/* ── once Egari has its own application ──────────────────────────────────── */
process.env.UBER_CLIENT_ID_EGARI = 'ega-id';
process.env.UBER_CLIENT_SECRET_EGARI = 'ega-secret';
{
  const o = byFleet();
  check('Egari uses its own client once one is set',
    o.egari.oauth.clientId === 'ega-id' && o.egari.oauth.clientSecret === 'ega-secret',
    JSON.stringify(o.egari.oauth));
  check('and Ecosine is untouched by it',
    o.ecosine.oauth.clientId === 'shared-id', o.ecosine.oauth.clientId);
  check('Egari now owns its client, so a 403 means a different thing',
    o.egari.oauth.own === true && o.egari.oauth.secretKey === 'UBER_CLIENT_SECRET_EGARI',
    JSON.stringify(o.egari.oauth));
}

/* ── a half-pasted client must not be treated as a client ────────────────── */
delete process.env.UBER_CLIENT_SECRET_EGARI;
check('an id without a secret is not an application, and falls back',
  byFleet().egari.oauth.clientSecret === 'shared-secret'
  && byFleet().egari.oauth.own === false,
  JSON.stringify(byFleet().egari.oauth));
process.env.UBER_CLIENT_SECRET_EGARI = 'ega-secret';

/* ── the token cache must be keyed by client, not by nothing ─────────────── */
/* One `cached` slot was right while one client served everybody. With two it
   hands the first fleet's token to the second fleet's calls, which then 403
   against an org that client cannot see — reproducing, as a fix, the exact
   symptom being fixed.

   Exercised against a real token endpoint rather than a stubbed module: an ESM
   namespace is frozen, so patching `http` throws, and a source regex would
   only confirm the word `Map` appears. UBER_TOKEN_URL exists because Uber runs
   two OAuth environments; pointing it at a local server is the same mechanism
   an operator uses to reach the sandbox one. */
const express = (await import('express')).default;
const grants = [];
const tokenApp = express();
tokenApp.use(express.urlencoded({ extended: false }));
tokenApp.post('/token', (req, res) => {
  grants.push(req.body.client_id);
  res.json({ access_token: `token-for-${req.body.client_id}`, expires_in: 3600 });
});
const tokenSrv = tokenApp.listen(0);
process.env.UBER_TOKEN_URL = `http://127.0.0.1:${tokenSrv.address().port}/token`;

const { uberOAuthToken } = await import('../src/auth/uber.js');
const o = byFleet();
const eco = await uberOAuthToken(o.ecosine);
const ega = await uberOAuthToken(o.egari);
const ecoAgain = await uberOAuthToken(o.ecosine);

check('each fleet gets the token for ITS OWN client',
  eco === 'token-for-shared-id' && ega === 'token-for-ega-id', `${eco} / ${ega}`);
check('and the grant was made with each client, not one of them twice',
  grants.join() === 'shared-id,ega-id', grants.join());
check('a second ask reuses the cached token rather than re-granting',
  ecoAgain === 'token-for-shared-id' && grants.length === 2, grants.join());
/* The shared client called WITHOUT an org — how every probe calls it — must
   still land on the same cache entry rather than granting a third time. */
const bare = await uberOAuthToken();
check('a probe calling with no org shares the shared client’s cached token',
  bare === 'token-for-shared-id' && grants.length === 2, `${bare} / ${grants.join()}`);
tokenSrv.close();

/* ── the org-list cache has the same shape of bug ────────────────────────── */
const src = (await import('node:fs')).readFileSync('src/auth_state.js', 'utf8');
check('the org-list diagnosis is cached per client, not once for everybody',
  /orgLists\s*=\s*new Map\(\)/.test(src) && /knownOrgs\(token,\s*key/.test(src),
  'a single slot answers the second fleet with the first client’s org list');
check('and the 403 message names a remedy that depends on owning a client',
  /oauth\?\.own/.test(src) && /gets its own Uber application/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
