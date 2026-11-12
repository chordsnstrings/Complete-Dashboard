/* Passkeys and single sign-on — the browser's half, and the sentences.
   ─────────────────────────────────────────────────────────────────────────
   Shared by the sign-in page (signin.js), the account page (account.js), the
   Access settings (accessadmin.js), the "confirm it is you" dialog
   (access.js) — and by the server, which imports SSO_REFUSALS so that every
   refusal code it can send back from the single sign-on return trip has a
   sentence here (test/access_passkey_sso.test.mjs checks both ways). Nothing
   in this file touches a browser global until one of its functions is
   called, so node can import it.

   WHY A RETURN TRIP NEEDS A CODE AND NOT A SENTENCE. Every other refusal on
   the sign-in page is the server's own `detail`, shown next to the form that
   caused it. Single sign-on is a NAVIGATION: the provider sends the browser
   to /api/auth/sso/callback, and the server can only answer it by sending
   the browser on — to /signin?sso=<code>. Putting the sentence itself in the
   address would let anybody make the sign-in page say anything (a link to
   /signin?sso=Your+account+is+locked,+call+…), so the address carries a code
   and the page looks the sentence up here. An unknown code gets a sentence
   that says exactly that. */

export const SSO_REFUSALS = Object.freeze({
  off: 'Single sign-on is not turned on for FleetMirror. Sign in with your email and password.',
  not_configured: 'Single sign-on is turned on, but the platform is missing its settings (the provider’s address, '
    + 'the client id or secret, PUBLIC_URL, or a company domain). Tell the Owner.',
  provider_unreachable: 'The sign-in provider could not be reached, or its configuration could not be read. Try again in a minute; if it keeps happening, tell the Owner.',
  expired: 'That single sign-on took too long or was already used. Start again.',
  browser: 'That single sign-on was started in a different browser, or this browser lost its note of it. Start again here.',
  denied: 'The sign-in provider did not sign you in: you cancelled, or it refused. Start again if you meant to sign in.',
  provider_error: 'The sign-in provider answered with an error instead of signing you in. Try again; if it keeps happening, tell the Owner.',
  exchange: 'FleetMirror could not finish the sign-in with the provider (it would not exchange the sign-in code). Try again; if it keeps happening, tell the Owner.',
  token: 'The sign-in provider’s answer could not be verified, so it was not trusted. Try again; if it keeps happening, tell the Owner.',
  no_email: 'The sign-in provider did not say which email address the account has, so it cannot be matched to anyone here.',
  unverified_email: 'The sign-in provider did not confirm that this email address belongs to the account, so it cannot be used to sign in here.',
  domain: 'This address is not on a company domain the Owner allowed for single sign-on. Use your company account, or ask the Owner.',
  hosted_domain: 'This Google account is not one of the company’s Google Workspace accounts, so it cannot sign in here.',
  no_account: 'There is no FleetMirror account for this address. Ask the Owner or an Access admin to invite you.',
  invite_expired: 'Your invitation has expired, so single sign-on cannot finish setting up your account. Ask the Owner or an Access admin for a new one.',
  other_identity: 'This FleetMirror account is already linked to a different account at the sign-in provider, so this one cannot open it. Ask the Owner or an Access admin.',
  suspended: 'This account is suspended. Ask the Owner or an Access admin.',
  inactive: 'This account is not active. Use the link you were sent, or ask an admin for a new one.',
  slow_down: 'Too many attempts from here. Wait fifteen minutes and try again.',
});
export const SSO_UNKNOWN = 'Single sign-on did not finish, and the reason it gave is not one this page knows. Start again.';
export const ssoRefusal = (code) => (Object.prototype.hasOwnProperty.call(SSO_REFUSALS, code) ? SSO_REFUSALS[code] : SSO_UNKNOWN);

/* ── base64url ↔ bytes ─────────────────────────────────────────────────── */
export function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 1) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* The server's options are JSON (base64url strings); the browser's API wants
   bytes where the spec says BufferSource. Converted by hand rather than with
   PublicKeyCredential.parseCreationOptionsFromJSON, which older Safari and
   Firefox builds do not have. */
export function creationFromJson(o) {
  return { ...o, challenge: b64urlToBytes(o.challenge), user: { ...o.user, id: b64urlToBytes(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })) };
}
export function requestFromJson(o) {
  return { ...o, challenge: b64urlToBytes(o.challenge),
    allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBytes(c.id) })) };
}
export function credentialJson(cred) {
  const r = cred.response;
  const out = { id: cred.id, rawId: bytesToB64url(cred.rawId), type: cred.type, response: { clientDataJSON: bytesToB64url(r.clientDataJSON) } };
  if (r.attestationObject) {
    out.response.attestationObject = bytesToB64url(r.attestationObject);
    out.response.transports = typeof r.getTransports === 'function' ? r.getTransports() : [];
  } else {
    out.response.authenticatorData = bytesToB64url(r.authenticatorData);
    out.response.signature = bytesToB64url(r.signature);
    out.response.userHandle = r.userHandle ? bytesToB64url(r.userHandle) : null;
  }
  return out;
}

export const passkeySupported = () => typeof window !== 'undefined' && Boolean(window.PublicKeyCredential)
  && typeof navigator !== 'undefined' && Boolean(navigator.credentials?.create);

/* What the browser said when a ceremony did not finish, in words. A person
   who closes the passkey sheet has not hit an error; it is said as what it
   was. */
export function passkeyFailure(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError') return 'The passkey request was closed or timed out before it finished. Nothing was changed. Try again when you are ready.';
  if (n === 'InvalidStateError') return 'This device already holds a passkey for your account here.';
  if (n === 'SecurityError') return 'This browser refused the passkey request for this address: passkeys work only on the site’s own https address.';
  if (n === 'NotSupportedError') return 'This browser or device cannot make a passkey of a kind FleetMirror accepts.';
  if (n === 'AbortError') return 'The passkey request was cancelled.';
  return e?.message || 'The passkey request did not finish.';
}

/* The two ceremonies, end to end, for a page that has a `post(path, body)`
   (access.js's, which carries the CSRF header and handles "confirm it is
   you"). Each returns the server's answer or throws with its sentence. */
export async function registerPasskey(post, { name = '' } = {}) {
  const { publicKey } = await post('/api/auth/passkey/register/options', {});
  let cred;
  try { cred = await navigator.credentials.create({ publicKey: creationFromJson(publicKey) }); } catch (e) { throw new Error(passkeyFailure(e)); }
  return post('/api/auth/passkey/register', { credential: credentialJson(cred), name }, { retry: false });
}
export async function passkeyAssertion(post, optionsPath, finishPath, extra = {}) {
  const { publicKey } = await post(optionsPath, {}, { retry: false });
  let cred;
  try { cred = await navigator.credentials.get({ publicKey: requestFromJson(publicKey) }); } catch (e) { throw new Error(passkeyFailure(e)); }
  return post(finishPath, { credential: credentialJson(cred), ...extra }, { retry: false });
}
export const signInWithPasskey = (post) => passkeyAssertion(post, '/api/auth/passkey/login/options', '/api/auth/passkey/login');
export const stepUpWithPasskey = (post) => passkeyAssertion(post, '/api/auth/passkey/stepup/options', '/api/auth/passkey/stepup');
