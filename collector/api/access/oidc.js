/* Single sign-on — an OpenID Connect client, node:crypto and fetch only.
   ─────────────────────────────────────────────────────────────────────────
   ULM-DESIGN §5.1: "the company's own SSO (Google Workspace or Microsoft
   Entra) can be added if it has one". This is the authorization-code flow
   with PKCE (RFC 7636), a nonce and a state (OpenID Connect Core §3.1), for
   ONE issuer — the company's own tenant. What it does, in order:

     discover   GET {issuer}/.well-known/openid-configuration, and refuse a
                document whose `issuer` is not exactly the one configured
                (OIDC Discovery §4.3) or whose endpoints change scheme.
     authorize  the browser goes to the provider with a fresh state, nonce
                and S256 code challenge, all three kept on the server.
     exchange   the code, the verifier and the client secret go to the
                token endpoint — client_secret_basic unless the provider
                says it takes only client_secret_post.
     verify     the ID token: RS256 or ES256 only (never 'none', never an
                HMAC keyed with the client secret), a key from the
                provider's JWKS (fetched again once when an unknown key id
                appears — the provider rotated), then iss, aud, azp, exp,
                iat, nbf and the nonce.

   WHERE THE SECRETS COME FROM. OIDC_ISSUER, OIDC_CLIENT_ID and
   OIDC_CLIENT_SECRET are read from the ENVIRONMENT ONLY, never from the
   Settings page. The system audit of 2026-11-12 found that any URL kept in
   Settings can be rewritten by an anonymous visitor while sign-in is
   optional (PUT /api/settings, open mode), and the client secret is POSTed
   to whatever the issuer's discovery document names: an issuer typed into a
   page would be a way to make the server hand its client secret to anyone.
   The redirect address is PUBLIC_URL's, from the environment for the same
   reason. Nothing here ever logs or returns the secret.

   What the issuer ASSERTS about a person is judged in
   api/access/signin_methods.js: an email the provider says it verified, on
   a domain the Owner listed, mapped to an account that already exists unless
   the Owner allows new ones. */
import crypto from 'node:crypto';

export class OidcError extends Error {
  constructor(code, detail) { super(detail); this.code = code; this.detail = detail; }
}
const bad = (code, detail) => { throw new OidcError(code, detail); };

/* ── configuration, from the environment only ──────────────────────────── */
const NAMES = { 'accounts.google.com': 'Google', 'login.microsoftonline.com': 'Microsoft' };
const localHost = (h) => h === 'localhost' || h === '127.0.0.1';
export function ssoEnv(env = process.env) {
  const issuer = String(env.OIDC_ISSUER || '').trim().replace(/\/+$/, '');
  const clientId = String(env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = String(env.OIDC_CLIENT_SECRET || '');
  const publicUrl = String(env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const missing = [];
  if (!issuer) missing.push('OIDC_ISSUER (the provider’s address)');
  if (!clientId) missing.push('OIDC_CLIENT_ID');
  if (!clientSecret) missing.push('OIDC_CLIENT_SECRET');
  if (!publicUrl) missing.push('PUBLIC_URL (this site’s own address, for the return trip)');
  let host = '';
  if (issuer) {
    try {
      const u = new URL(issuer);
      host = u.hostname;
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localHost(u.hostname))) missing.push('OIDC_ISSUER as an https address');
      if (u.search || u.hash) missing.push('OIDC_ISSUER without a query or fragment');
    } catch { missing.push('OIDC_ISSUER as a valid address'); }
  }
  let redirectUri = '';
  if (publicUrl) {
    try {
      const u = new URL(publicUrl);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && localHost(u.hostname))) missing.push('PUBLIC_URL as an https address');
      redirectUri = `${u.origin}/api/auth/sso/callback`;
    } catch { missing.push('PUBLIC_URL as a valid address'); }
  }
  const name = String(env.OIDC_NAME || '').trim().slice(0, 40) || NAMES[host] || host || 'single sign-on';
  return {
    ok: missing.length === 0, missing, issuer, clientId, clientSecret, redirectUri, name,
    google: host === 'accounts.google.com',
    why: missing.length ? `The platform is missing ${missing.join(', ')}.` : null,
  };
}

/* ── PKCE (RFC 7636 §4.1–4.2) ──────────────────────────────────────────── */
export const s256 = (verifier) => crypto.createHash('sha256').update(String(verifier), 'ascii').digest('base64url');
export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');   // 43 characters
  return { verifier, challenge: s256(verifier) };
}

/* ── domains the Owner allows ──────────────────────────────────────────
   An address anyone can sign up for is not a company domain: with it on the
   list, anybody with a free mailbox there could sign in (or, with
   provisioning on, open an account). */
export const PUBLIC_MAIL = Object.freeze(new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'mail.com', 'yandex.com', 'zoho.com']));
const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
export function domainProblem(d) {
  const s = String(d || '');
  if (!DOMAIN.test(s)) return `“${s.slice(0, 60)}” is not a domain name (write it like example.com, without @ or https://).`;
  if (PUBLIC_MAIL.has(s)) return `${s} is a public email service: anyone can have an address there, so it cannot be a company domain for single sign-on.`;
  return null;
}
export function parseDomains(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  return [...new Set(list.map((x) => String(x).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
}
export const emailDomain = (email) => {
  const s = String(email || '').trim().toLowerCase();
  const i = s.lastIndexOf('@');
  return i > 0 ? s.slice(i + 1) : '';
};
/* Did the provider vouch for the address? `email_verified` is the standard
   claim (Google, Okta, Keycloak; some send the string "true"). Microsoft
   Entra does not send it; its documented equivalent is `xms_edov`, "email
   domain owner verified", an optional claim the tenant turns on. Anything
   else is an address the person may have typed themselves. */
export const emailVerified = (claims) => [true, 'true'].includes(claims?.email_verified)
  || [true, 'true', 1, '1'].includes(claims?.xms_edov);
/* RFC 8176: 'mfa' — the provider used more than one factor. Only then does
   a single sign-on count as two-step here. */
export const multiFactor = (claims) => Array.isArray(claims?.amr) && claims.amr.includes('mfa');

/* ── the client ────────────────────────────────────────────────────────
   `http` is injectable so the tests run against a mock provider; the real
   one is fetch with a time limit, refusing redirects (every endpoint must
   answer itself — a redirect is how a fetch is walked somewhere it was not
   sent) and answers larger than a megabyte. */
async function fetchHttp(url, { method = 'GET', headers = {}, body } = {}) {
  const r = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  const len = Number(r.headers.get('content-length') || 0);
  if (len > 1_000_000) return { status: 502, json: null };
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json };
}

const SKEW_S = 60;
export function createOidc({ http = fetchHttp, now = () => Date.now() } = {}) {
  const docs = new Map();       // issuer → { doc, at }
  const keys = new Map();       // jwks_uri → { keys, at, tried }
  const HOUR = 3600_000;

  async function discover(issuer, { fresh = false } = {}) {
    const hit = docs.get(issuer);
    if (!fresh && hit && now() - hit.at < HOUR) return hit.doc;
    let r;
    try { r = await http(`${issuer}/.well-known/openid-configuration`); } catch (e) {
      bad('discovery', `The sign-in provider at ${issuer} could not be reached (${String(e?.name || e).slice(0, 60)}).`);
    }
    const d = r?.json;
    if (r?.status !== 200 || !d || typeof d !== 'object') bad('discovery', `The sign-in provider at ${issuer} did not return its configuration (HTTP ${r?.status}).`);
    if (d.issuer !== issuer) bad('discovery', `The provider's configuration names its issuer as ${String(d.issuer).slice(0, 100)}, not ${issuer}.`);
    const scheme = new URL(issuer).protocol;
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      let u;
      try { u = new URL(String(d[k] || '')); } catch { bad('discovery', `The provider's configuration has no valid ${k}.`); }
      if (u.protocol !== scheme) bad('discovery', `The provider's ${k} does not use ${scheme.replace(':', '')}.`);
    }
    if (Array.isArray(d.response_types_supported) && !d.response_types_supported.includes('code')) {
      bad('discovery', 'The provider does not offer the authorization-code flow.');
    }
    docs.set(issuer, { doc: d, at: now() });
    return d;
  }

  async function jwks(doc, { force = false } = {}) {
    const hit = keys.get(doc.jwks_uri);
    if (!force && hit && now() - hit.at < HOUR) return hit.keys;
    /* At most one FORCED fetch a minute: an ID token naming a key id that
       does not exist must not become a way to make the server hammer the
       provider. Counted from the last forced fetch, not the last fetch: a
       provider that rotates its key a few seconds after the first sign-in
       of the day must still be followed at once (test/oidc.test.mjs caught
       the first version refusing exactly that). */
    if (force && hit && now() - (hit.forcedAt || 0) < 60_000) return hit.keys;
    let r;
    try { r = await http(doc.jwks_uri); } catch { bad('jwks', 'The provider\'s signing keys could not be fetched.'); }
    if (r?.status !== 200 || !Array.isArray(r?.json?.keys)) bad('jwks', `The provider's signing keys could not be read (HTTP ${r?.status}).`);
    keys.set(doc.jwks_uri, { keys: r.json.keys, at: now(), forcedAt: force ? now() : hit?.forcedAt || 0 });
    return r.json.keys;
  }

  function authorizeUrl(doc, { clientId, redirectUri, state, nonce, challenge }) {
    const u = new URL(doc.authorization_endpoint);
    const p = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid email profile',
      state, nonce, code_challenge: challenge, code_challenge_method: 'S256' };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
    return u.toString();
  }

  async function exchange(doc, { code, verifier, clientId, clientSecret, redirectUri }) {
    const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : ['client_secret_basic'];
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (methods.includes('client_secret_basic')) {
      /* RFC 6749 §2.3.1: each half form-encoded before the base64. */
      const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.authorization = `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`).toString('base64')}`;
    } else if (methods.includes('client_secret_post')) {
      form.set('client_id', clientId); form.set('client_secret', clientSecret);
    } else {
      bad('exchange', 'The provider accepts no way of presenting the client secret that FleetMirror uses (client_secret_basic or client_secret_post).');
    }
    let r;
    try { r = await http(doc.token_endpoint, { method: 'POST', headers, body: form.toString() }); } catch {
      bad('exchange', 'The provider\'s token endpoint could not be reached.');
    }
    if (r?.status !== 200 || typeof r?.json?.id_token !== 'string') {
      const err = typeof r?.json?.error === 'string' ? r.json.error.replace(/[^a-z_]/gi, '').slice(0, 40) : `HTTP ${r?.status}`;
      bad('exchange', `The provider would not exchange the sign-in code (${err}).`);
    }
    return r.json;
  }

  async function verifyIdToken(doc, idToken, { issuer, clientId, nonce }) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) bad('token', 'The provider\'s ID token is not a signed token.');
    let header, claims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { bad('token', 'The provider\'s ID token could not be read.'); }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') bad('token', 'The provider\'s ID token could not be read.');
    const alg = header.alg;
    if (alg !== 'RS256' && alg !== 'ES256') bad('token', `The provider signed the ID token with ${String(alg).slice(0, 20)}; FleetMirror accepts RS256 and ES256 only.`);
    const fits = (k) => k && typeof k === 'object' && (k.use === undefined || k.use === 'sig')
      && (k.alg === undefined || k.alg === alg)
      && (alg === 'RS256' ? k.kty === 'RSA' : k.kty === 'EC' && k.crv === 'P-256')
      && (header.kid === undefined || k.kid === header.kid);
    const pick = (list) => {
      const c = list.filter(fits);
      return header.kid === undefined ? (c.length === 1 ? c[0] : null) : c[0] || null;
    };
    let jwk = pick(await jwks(doc));
    if (!jwk) jwk = pick(await jwks(doc, { force: true }));
    if (!jwk) bad('token', 'The ID token was signed with a key the provider does not publish.');
    let key;
    try {
      key = crypto.createPublicKey({ key: alg === 'RS256' ? { kty: 'RSA', n: jwk.n, e: jwk.e } : { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    } catch { bad('token', 'The provider\'s signing key could not be read.'); }
    if (alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength || 0) < 2048) bad('token', 'The provider\'s signing key is shorter than 2048 bits.');
    const input = Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii');
    const sig = Buffer.from(parts[2], 'base64url');
    let ok = false;
    try {
      ok = alg === 'RS256' ? crypto.verify('sha256', input, key, sig)
        : sig.length === 64 && crypto.verify('sha256', input, { key, dsaEncoding: 'ieee-p1363' }, sig);
    } catch { ok = false; }
    if (!ok) bad('token', 'The ID token\'s signature does not verify.');

    const t = Math.floor(now() / 1000);
    if (claims.iss !== issuer) bad('token', `The ID token was issued by ${String(claims.iss).slice(0, 100)}, not ${issuer}.`);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) bad('token', 'The ID token was issued for a different application.');
    if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) bad('token', 'The ID token was issued to a different party.');
    if (typeof claims.exp !== 'number' || t > claims.exp + SKEW_S) bad('token', 'The ID token has expired.');
    if (typeof claims.iat !== 'number' || claims.iat > t + SKEW_S || claims.iat < t - 600) bad('token', 'The ID token was not issued just now.');
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf > t + SKEW_S)) bad('token', 'The ID token is not valid yet.');
    if (typeof claims.nonce !== 'string' || !nonce || claims.nonce !== nonce) bad('token', 'The ID token does not carry the nonce this sign-in was started with.');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) bad('token', 'The ID token does not say which account it is for.');
    return claims;
  }

  return { discover, jwks, authorizeUrl, exchange, verifyIdToken };
}
