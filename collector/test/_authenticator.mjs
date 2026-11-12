/* A synthetic WebAuthn authenticator and a mock OpenID provider, for tests.
   ─────────────────────────────────────────────────────────────────────────
   Not a test itself (the runner takes *.test.mjs only). Shared by
   test/webauthn.test.mjs, test/oidc.test.mjs and
   test/access_passkey_sso.test.mjs.

   THE AUTHENTICATOR builds exactly what a browser posts after
   navigator.credentials.create()/get(): clientDataJSON, a CBOR attestation
   object with fmt "none", authenticator data with the RP id hash, flags,
   counter and COSE public key, and an ES256 (DER) or RS256 signature over
   authenticatorData ‖ SHA-256(clientDataJSON). Its CBOR ENCODER is written
   here, separately from the decoder under test (api/access/webauthn.js), so
   the two cannot share a misreading. Every knob a malicious or broken
   authenticator could turn is an option: the flags, the counter, the origin,
   the type, the RP id, the user handle, extra bytes.

   THE PROVIDER is an express app with its own RSA (or EC) signing key: a
   discovery document, a JWKS, an authorization endpoint that sends the
   browser straight back with a code, and a token endpoint that checks the
   client secret and the PKCE verifier and returns an ID token carrying
   whatever claims the test asks for. Synthetic only: every address is
   @example.test or a domain the test names. */
import crypto from 'node:crypto';
import express from 'express';

/* ── CBOR encoding (RFC 8949 §3), the subset an authenticator emits ─────── */
function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
}
export function cbor(v) {
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === null) return Buffer.from([0xf6]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cannot encode ${typeof v}`);
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

/* ── the authenticator ─────────────────────────────────────────────────── */
export function makeAuthenticator({ alg = -7, rpId = 'localhost', origin = 'http://localhost:8310', counter = 0, synced = false } = {}) {
  const pair = alg === -7 ? crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  const cose = alg === -7
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])
    : new Map([[1, 3], [3, -257], [-1, Buffer.from(jwk.n, 'base64url')], [-2, Buffer.from(jwk.e, 'base64url')]]);
  const credId = crypto.randomBytes(32);
  const state = { counter, userHandle: null, credId, rpId, origin, cose, alg, privateKey: pair.privateKey, synced };

  const flagsOf = ({ up = true, uv = true, be = synced, bs = synced, at = false, ed = false }) =>
    (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (be ? 0x08 : 0) | (bs ? 0x10 : 0) | (at ? 0x40 : 0) | (ed ? 0x80 : 0);
  const authData = ({ rp = state.rpId, flags = {}, count = state.counter, attested = false, extra = null, coseKey = state.cose, id = credId }) => {
    const parts = [sha256(Buffer.from(rp, 'utf8')), Buffer.from([flagsOf({ ...flags, at: attested || flags.at })])];
    const c = Buffer.alloc(4); c.writeUInt32BE(count >>> 0, 0); parts.push(c);
    if (attested) {
      const len = Buffer.alloc(2); len.writeUInt16BE(id.length, 0);
      parts.push(Buffer.alloc(16), len, id, cbor(coseKey));
    }
    if (extra) parts.push(extra);
    return Buffer.concat(parts);
  };
  const clientData = ({ type, challenge, origin: o = state.origin, crossOrigin, more = {} }) => Buffer.from(JSON.stringify({
    type, challenge, origin: o, ...(crossOrigin !== undefined ? { crossOrigin } : {}), ...more }));

  return {
    state,
    credentialId: b64u(credId),
    /* navigator.credentials.create(), answered. `options` is what the server
       sent (publicKey). Every override is a way an authenticator, a browser
       or an attacker could get it wrong. */
    create(options, { origin: o, type = 'webauthn.create', rp = options.rp.id, flags = {}, fmt = 'none', attStmt = new Map(),
      challenge = options.challenge, coseKey, extraAuthData = null, idOverride, crossOrigin } = {}) {
      state.userHandle = options.user.id;
      const cd = clientData({ type, challenge, origin: o, crossOrigin });
      const ad = authData({ rp, flags, attested: true, coseKey, extra: extraAuthData });
      const att = cbor(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', ad]]));
      return { id: idOverride || b64u(credId), rawId: idOverride || b64u(credId), type: 'public-key',
        response: { clientDataJSON: b64u(cd), attestationObject: b64u(att), transports: ['internal', 'hybrid', 'warp-drive'] } };
    },
    /* navigator.credentials.get(), answered. The counter steps on by one
       for a counting authenticator, unless the test sets it. */
    get(options, { origin: o, type = 'webauthn.get', rp = options.rpId, flags = {}, count, challenge = options.challenge,
      userHandle = state.userHandle, tamper = false, signWith = null, crossOrigin, more } = {}) {
      if (count === undefined) { if (state.counter !== 0 || !synced) state.counter = synced ? 0 : state.counter + 1; count = state.counter; }
      const cd = clientData({ type, challenge, origin: o, crossOrigin, more });
      const ad = authData({ rp, flags, count });
      const data = Buffer.concat([ad, sha256(cd)]);
      const key = signWith || state.privateKey;
      let sig = state.alg === -7 ? crypto.sign('sha256', data, { key, dsaEncoding: 'der' })
        : crypto.sign('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING });
      if (tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 1; }
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key',
        response: { clientDataJSON: b64u(cd), authenticatorData: b64u(ad), signature: b64u(sig), userHandle } };
    },
  };
}

/* ── a mock OpenID provider ────────────────────────────────────────────── */
/* `host` + `base` + `prefix`: mount the provider under a path of an app that
   is already listening (the browser test keeps to the one port the brief
   allows, 8310); otherwise it listens on a free port of its own. */
export async function mockProvider({ alg = 'RS256', clientId = 'fleet-test-client', clientSecret = 'synthetic-test-secret-1',
  authMethods = ['client_secret_basic'], host = null, base = '', prefix = '/idp' } = {}) {
  const app = express.Router();
  app.use(express.urlencoded({ extended: false }));
  let server = null;
  let issuer;
  if (host) {
    host.use(prefix, app);
    issuer = `${base}${prefix}`;
  } else {
    const e = express();
    e.use(app);
    server = e.listen(0);
    await new Promise((r) => server.once('listening', r));
    issuer = `http://127.0.0.1:${server.address().port}`;
  }
  let pair = alg === 'RS256' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let kid = 'k1';
  const p = {
    issuer, clientId, clientSecret, calls: { discovery: 0, jwks: 0, token: 0 }, tokens: [],
    /* What the next ID token says, and how it is made. */
    claims: { sub: 'sub-0001', email: 'person@example.test', email_verified: true, name: 'Test Person' },
    override: {},          // claims to add or replace (null deletes)
    headerOverride: {},    // e.g. { alg: 'none' }
    signWith: null,        // another private key
    tokenStatus: 200, tokenBody: null,
    codes: new Map(),      // code → { challenge, redirectUri, nonce }
    rotate() { pair = alg === 'RS256' ? crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }) : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }); kid = `k${Date.now()}`; },
    discoveryOverride: {},
    close: () => new Promise((r) => (server ? server.close(r) : r())),
  };
  const jwkPublic = () => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg });
  p.makeIdToken = (extra = {}) => {
    const header = { alg, kid, typ: 'JWT', ...p.headerOverride };
    const t = Math.floor(Date.now() / 1000);
    const claims = { iss: issuer, aud: clientId, iat: t, exp: t + 300, ...p.claims, ...extra };
    for (const [k, v] of Object.entries(p.override)) { if (v === null) delete claims[k]; else claims[k] = v; }
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
    const key = p.signWith || pair.privateKey;
    const sig = header.alg === 'none' ? Buffer.alloc(0)
      : alg === 'RS256' ? crypto.sign('sha256', Buffer.from(input), key)
        : crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
    return `${input}.${b64u(sig) || 'AA'}`;
  };
  app.get('/.well-known/openid-configuration', (req, res) => {
    p.calls.discovery += 1;
    res.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      response_types_supported: ['code'], id_token_signing_alg_values_supported: [alg],
      token_endpoint_auth_methods_supported: authMethods, code_challenge_methods_supported: ['S256'], ...p.discoveryOverride });
  });
  app.get('/jwks', (req, res) => { p.calls.jwks += 1; res.json({ keys: [jwkPublic()] }); });
  /* The person "signs in" at once: straight back with a code. */
  app.get('/authorize', (req, res) => {
    const q = req.query;
    if (q.client_id !== clientId || q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !q.code_challenge) {
      return res.redirect(`${q.redirect_uri}?error=invalid_request&state=${encodeURIComponent(q.state || '')}`);
    }
    const code = crypto.randomBytes(16).toString('hex');
    p.codes.set(code, { challenge: q.code_challenge, redirectUri: q.redirect_uri, nonce: q.nonce, state: q.state });
    p.lastAuthorize = { ...q, code };
    return res.redirect(`${q.redirect_uri}?code=${code}&state=${encodeURIComponent(q.state)}`);
  });
  app.post('/token', (req, res) => {
    p.calls.token += 1;
    let id = req.body.client_id; let secret = req.body.client_secret;
    const basic = /^Basic (.+)$/.exec(req.get('authorization') || '');
    if (basic) {
      const [a, b] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
      id = decodeURIComponent(a.replace(/\+/g, ' ')); secret = decodeURIComponent(b.replace(/\+/g, ' '));
    }
    if (id !== clientId || secret !== clientSecret) return res.status(401).json({ error: 'invalid_client' });
    const c = p.codes.get(req.body.code);
    if (!c) return res.status(400).json({ error: 'invalid_grant' });
    p.codes.delete(req.body.code);
    const want = crypto.createHash('sha256').update(String(req.body.code_verifier || ''), 'ascii').digest('base64url');
    if (want !== c.challenge) return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verifier' });
    if (req.body.redirect_uri !== c.redirectUri) return res.status(400).json({ error: 'invalid_grant' });
    if (p.tokenStatus !== 200) return res.status(p.tokenStatus).json(p.tokenBody || { error: 'server_error' });
    const idToken = p.makeIdToken({ nonce: c.nonce });
    p.tokens.push(idToken);
    return res.json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 300, id_token: idToken });
  });
  return p;
}
