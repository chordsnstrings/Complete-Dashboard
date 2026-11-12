/* SINGLE SIGN-ON — the OpenID Connect client in api/access/oidc.js, alone.
   ═════════════════════════════════════════════════════════════════════════
   Configuration from the environment (and only from there), PKCE against
   RFC 7636's own example, the domain rules, and discovery, the code
   exchange and ID-token verification against a mock provider
   (test/_authenticator.mjs mockProvider) with its own signing keys. The
   whole round trip through the browser and the access gate is in
   test/access_passkey_sso.test.mjs.

   REVERSIONS THAT PROVE IT — each was made, run, and seen to fail the named
   check, 2026-11-12:
     · verifyIdToken: drop the nonce comparison — "an ID token without this
       sign-in's nonce is refused" fails.
     · verifyIdToken: accept any alg — "alg none is refused" fails.
     · discover: drop the issuer comparison — "a configuration naming
       another issuer is refused" fails.
     · verifyIdToken: drop the forced JWKS fetch on an unknown key id —
       "a rotated signing key is fetched once and accepted" fails. */
import crypto from 'node:crypto';
import { createOidc, ssoEnv, pkcePair, s256, domainProblem, parseDomains, emailVerified, multiFactor, emailDomain, OidcError }
  from '../api/access/oidc.js';
import { mockProvider } from './_authenticator.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const refusal = async (fn) => {
  try { await fn(); return { accepted: true }; } catch (e) { return e instanceof OidcError ? { code: e.code, detail: e.detail } : { threw: String(e) }; }
};
/* The answer, or the refusal — so a check that should pass reports a ✗
   rather than crashing the file when it does not. */
const attempt = async (fn) => { try { return await fn(); } catch (e) { return { refused: e?.detail || String(e) }; } };

console.log('\n1. configuration, from the environment only');
{
  const none = ssoEnv({});
  check('nothing set → not ready, and every missing piece is named', !none.ok
    && ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'PUBLIC_URL'].every((k) => none.why.includes(k)));
  const env = { OIDC_ISSUER: 'https://accounts.google.com/', OIDC_CLIENT_ID: 'cid', OIDC_CLIENT_SECRET: 'synthetic-secret-xyz', PUBLIC_URL: 'https://fleet.example.test/' };
  const g = ssoEnv(env);
  check('all four set → ready; the issuer loses its trailing slash', g.ok && g.issuer === 'https://accounts.google.com');
  check('the return address is PUBLIC_URL\'s /api/auth/sso/callback', g.redirectUri === 'https://fleet.example.test/api/auth/sso/callback');
  check('Google is named Google, and recognised for the hosted-domain rule', g.name === 'Google' && g.google === true);
  check('Microsoft is named Microsoft', ssoEnv({ ...env, OIDC_ISSUER: 'https://login.microsoftonline.com/0000-tenant/v2.0' }).name === 'Microsoft');
  check('OIDC_NAME names any other provider', ssoEnv({ ...env, OIDC_ISSUER: 'https://sso.example.test', OIDC_NAME: 'Company SSO' }).name === 'Company SSO');
  check('an http issuer on a real host is refused', !ssoEnv({ ...env, OIDC_ISSUER: 'http://sso.example.test' }).ok);
  check('…an http PUBLIC_URL on a real host too', !ssoEnv({ ...env, PUBLIC_URL: 'http://fleet.example.test' }).ok);
  check('the reason never carries the secret', !JSON.stringify(ssoEnv({ ...env, PUBLIC_URL: '' })).includes('"why":"' + env.OIDC_CLIENT_SECRET));
  check('a Settings-page value is not read: only the object passed (process.env in production)',
    !ssoEnv({ get: () => 'https://evil.example' }).ok);
}

console.log('\n2. PKCE (RFC 7636 Appendix B)');
{
  check('S256 of the RFC\'s verifier is the RFC\'s challenge', s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = pkcePair();
  check('a fresh pair: a 43-character verifier and its challenge', p.verifier.length === 43 && p.challenge === s256(p.verifier));
}

console.log('\n3. domains and claims');
{
  check('domains are trimmed, lower-cased, de-duplicated, @ dropped', JSON.stringify(parseDomains(' Example.TEST, @example.test;fleet.example.test ')) === '["example.test","fleet.example.test"]');
  check('a public mail service is refused, with the reason', /public email service/.test(domainProblem('gmail.com') || ''));
  check('something that is not a domain is refused', /not a domain/.test(domainProblem('https://example.test') || '') && Boolean(domainProblem('example')));
  check('a company domain passes', domainProblem('example.test') === null && domainProblem('xn--mnchen-3ya.example') === null);
  check('email_verified true, or the string "true"', emailVerified({ email_verified: true }) && emailVerified({ email_verified: 'true' }));
  check('Microsoft\'s xms_edov counts too', emailVerified({ xms_edov: true }) && emailVerified({ xms_edov: '1' }));
  check('missing or false does not', !emailVerified({}) && !emailVerified({ email_verified: false }) && !emailVerified({ email_verified: 'yes' }));
  check('multi-factor only when amr says mfa', multiFactor({ amr: ['pwd', 'mfa'] }) && !multiFactor({ amr: ['pwd'] }) && !multiFactor({}));
  check('the domain of an address is what follows its last @', emailDomain('A.B@Example.Test') === 'example.test' && emailDomain('nobody') === '');
}

console.log('\n4. discovery');
const p = await mockProvider();
const oidc = createOidc();
{
  const doc = await attempt(() => oidc.discover(p.issuer));
  check('the provider\'s configuration is read', doc.token_endpoint === `${p.issuer}/token`, JSON.stringify(doc).slice(0, 120));
  await oidc.discover(p.issuer);
  check('…and kept for an hour, not fetched on every sign-in', p.calls.discovery === 1);
  p.discoveryOverride = { issuer: 'https://evil.example' };
  const r = await refusal(() => createOidc().discover(p.issuer));
  check('a configuration naming another issuer is refused', r.code === 'discovery' && /evil\.example/.test(r.detail), JSON.stringify(r));
  p.discoveryOverride = { token_endpoint: 'https://elsewhere.example/token' };
  check('an endpoint on another scheme is refused', (await refusal(() => createOidc().discover(p.issuer))).code === 'discovery');
  p.discoveryOverride = { response_types_supported: ['id_token'] };
  check('a provider without the code flow is refused', (await refusal(() => createOidc().discover(p.issuer))).code === 'discovery');
  p.discoveryOverride = {};
  const dead = await refusal(() => createOidc().discover('http://127.0.0.1:9'));
  check('an unreachable provider is refused with the reason', dead.code === 'discovery' && /could not be reached/.test(dead.detail), JSON.stringify(dead));
}

console.log('\n5. the code exchange');
{
  const doc = await oidc.discover(p.issuer);
  const { verifier, challenge } = pkcePair();
  const code = 'c-1'; p.codes.set(code, { challenge, redirectUri: 'http://localhost:8310/api/auth/sso/callback', nonce: 'n-1' });
  const tok = await oidc.exchange(doc, { code, verifier, clientId: p.clientId, clientSecret: p.clientSecret, redirectUri: 'http://localhost:8310/api/auth/sso/callback' });
  check('client_secret_basic and the PKCE verifier get an ID token', typeof tok.id_token === 'string');
  p.codes.set('c-2', { challenge, redirectUri: 'r', nonce: 'n' });
  const wrongVerifier = await refusal(() => oidc.exchange(doc, { code: 'c-2', verifier: 'x'.repeat(43), clientId: p.clientId, clientSecret: p.clientSecret, redirectUri: 'r' }));
  check('a verifier that does not match the challenge is refused, the provider\'s error named', wrongVerifier.code === 'exchange' && /invalid_grant/.test(wrongVerifier.detail));
  p.codes.set('c-3', { challenge, redirectUri: 'r', nonce: 'n' });
  const wrongSecret = await refusal(() => oidc.exchange(doc, { code: 'c-3', verifier, clientId: p.clientId, clientSecret: 'wrong', redirectUri: 'r' }));
  check('a wrong client secret is refused, and the secret is not in the reason', wrongSecret.code === 'exchange' && /invalid_client/.test(wrongSecret.detail) && !wrongSecret.detail.includes('wrong'));
  const post = await mockProvider({ authMethods: ['client_secret_post'] });
  const pdoc = await createOidc().discover(post.issuer);
  post.codes.set('c-4', { challenge, redirectUri: 'r', nonce: 'n' });
  check('client_secret_post when that is all the provider takes', typeof (await createOidc().exchange(pdoc,
    { code: 'c-4', verifier, clientId: post.clientId, clientSecret: post.clientSecret, redirectUri: 'r' })).id_token === 'string');
  await post.close();
  const neither = await refusal(() => oidc.exchange({ ...doc, token_endpoint_auth_methods_supported: ['private_key_jwt'] },
    { code: 'x', verifier, clientId: 'a', clientSecret: 'b', redirectUri: 'r' }));
  check('a provider that takes neither is refused with the reason', neither.code === 'exchange' && /client_secret_basic or client_secret_post/.test(neither.detail));
}

console.log('\n6. the ID token');
{
  const doc = await oidc.discover(p.issuer);
  const want = { issuer: p.issuer, clientId: p.clientId, nonce: 'n-ok' };
  const v = (tok, w = want, o = oidc) => refusal(() => o.verifyIdToken(doc, tok, w));
  const good = await attempt(() => oidc.verifyIdToken(doc, p.makeIdToken({ nonce: 'n-ok' }), want));
  check('a good RS256 token verifies and its claims come back', good.sub === 'sub-0001' && good.email === 'person@example.test');
  const t = Math.floor(Date.now() / 1000);
  const cases = [
    ['an ID token without this sign-in\'s nonce is refused', { nonce: 'n-other' }, /nonce/],
    ['another issuer is refused', { nonce: 'n-ok', iss: 'https://evil.example' }, /issued by/],
    ['another audience is refused', { nonce: 'n-ok', aud: 'someone-else' }, /different application/],
    ['several audiences without our azp are refused', { nonce: 'n-ok', aud: [p.clientId, 'other'] }, /different party/],
    ['an azp naming another party is refused', { nonce: 'n-ok', azp: 'other' }, /different party/],
    ['an expired token is refused', { nonce: 'n-ok', exp: t - 120 }, /expired/],
    ['a token issued in the future is refused', { nonce: 'n-ok', iat: t + 600 }, /not issued just now/],
    ['a token issued long ago is refused', { nonce: 'n-ok', iat: t - 3600, exp: t + 60 }, /not issued just now/],
    ['a token not valid yet is refused', { nonce: 'n-ok', nbf: t + 600 }, /not valid yet/],
    ['a token naming no account is refused', { nonce: 'n-ok', sub: '' }, /which account/],
  ];
  for (const [name, claims, re] of cases) {
    const r = await v(p.makeIdToken(claims));
    check(name, r.code === 'token' && re.test(r.detail), JSON.stringify(r));
  }
  check('several audiences WITH our azp pass', (await attempt(() => oidc.verifyIdToken(doc, p.makeIdToken({ nonce: 'n-ok', aud: [p.clientId, 'x'], azp: p.clientId }), want))).sub === 'sub-0001');
  p.headerOverride = { alg: 'none' };
  check('alg none is refused', /accepts RS256 and ES256 only/.test((await v(p.makeIdToken({ nonce: 'n-ok' }))).detail || ''));
  p.headerOverride = { alg: 'HS256' };
  check('an HMAC token (keyed with the client secret) is refused', /accepts RS256 and ES256 only/.test((await v(p.makeIdToken({ nonce: 'n-ok' }))).detail || ''));
  p.headerOverride = {};
  p.signWith = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  check('a token signed by a key that is not the provider\'s is refused', /signature does not verify/.test((await v(p.makeIdToken({ nonce: 'n-ok' }))).detail || ''));
  p.signWith = null;
  const parts = p.makeIdToken({ nonce: 'n-ok' }).split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url')), email: 'owner@example.test' })).toString('base64url');
  check('a token whose claims were changed after signing is refused', /signature does not verify/.test((await v(`${parts[0]}.${forged}.${parts[2]}`)).detail || ''));
  check('something that is not a token is refused', (await v('not.a-token')).code === 'token');

  const before = p.calls.jwks;
  p.rotate();
  const rotated = await attempt(() => oidc.verifyIdToken(doc, p.makeIdToken({ nonce: 'n-ok' }), want));
  check('a rotated signing key is fetched once and accepted', rotated.sub === 'sub-0001' && p.calls.jwks === before + 1, `${p.calls.jwks - before} fetches ${JSON.stringify(rotated).slice(0, 120)}`);
  p.headerOverride = { kid: 'no-such-key' };
  const n0 = p.calls.jwks;
  const unknown = await v(p.makeIdToken({ nonce: 'n-ok' }));
  check('a key id the provider does not publish is refused…', /does not publish/.test(unknown.detail || ''));
  check('…without fetching the keys again within the minute', p.calls.jwks === n0);
  p.headerOverride = {};

  const ec = await mockProvider({ alg: 'ES256' });
  const eo = createOidc();
  const edoc = await eo.discover(ec.issuer);
  check('a good ES256 token (raw r‖s signature) verifies',
    (await attempt(() => eo.verifyIdToken(edoc, ec.makeIdToken({ nonce: 'n' }), { issuer: ec.issuer, clientId: ec.clientId, nonce: 'n' }))).sub === 'sub-0001');
  await ec.close();
}
await p.close();

console.log(`\n${fail ? '✗' : '✓'} oidc: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
