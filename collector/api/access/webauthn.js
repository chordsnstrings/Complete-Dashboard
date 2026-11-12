/* Passkeys (WebAuthn) — verifying what a browser's authenticator sends.
   ─────────────────────────────────────────────────────────────────────────
   ULM-DESIGN §5.1 makes the passkey the primary way in, and says it counts as
   multi-factor. This file is the whole of the cryptography behind that, and
   it uses node:crypto and nothing else: no WebAuthn library, no CBOR package.
   The brief for this work (2026-11-12) was "prefer no new dependency", and
   the arithmetic turned out to be small enough to own:

     · CBOR (RFC 8949) — only the parts an authenticator uses: integers, byte
       and text strings, arrays, maps, and true/false/null. Definite lengths
       only. A tag, a float, an indefinite length, a duplicate map key or a
       byte left over is REFUSED, not skipped: a parser that tolerates what it
       does not need is a parser an attacker gets to explore.
     · COSE keys (RFC 9053) — ES256 (P-256) and RS256 (RSA, 2048 bits or
       more), the two every platform authenticator uses (Apple, Google and
       Microsoft make ES256 passkeys; Windows Hello on some TPMs makes RS256).
       The key is handed to node:crypto as a JWK, which refuses a point that
       is not on the curve (measured: ERR_CRYPTO_INVALID_JWK).
     · authenticator data (WebAuthn L2 §6.1) — the RP id hash, the flags, the
       signature counter, and the credential the authenticator just made.

   ATTESTATION. The server asks for attestation 'none': FleetMirror does not
   decide which brand of authenticator a person may use, so the statement
   that would prove the brand is not wanted. Browsers replace the statement
   with fmt 'none' when asked for none; if one ever sends another format, its
   statement is NOT verified and NOT trusted — which gives it exactly the
   trust of 'none', the spec's own allowance (WebAuthn L2 §7.1 step 23). What
   makes a registration safe is not the statement: it is the challenge, the
   origin, the RP id hash and the user-verification flag, all checked here.

   WHAT EACH CEREMONY CHECKS (WebAuthn L2 §7.1 and §7.2, in this order):
     the client data's type, challenge and origin, and that it was not made
     inside another site's frame (crossOrigin) · SHA-256 of the RP id against
     the authenticator data · user PRESENT and user VERIFIED (a PIN or a
     fingerprint at the authenticator — that is what makes a passkey two
     factors and not one) · a backed-up credential that claims it cannot be
     backed up · the algorithm is one this server offered · and, signing in,
     the signature over authenticatorData ‖ SHA-256(clientDataJSON), and the
     counter.

   THE COUNTER. An authenticator that counts its signatures sends a larger
   number every time. A number that does not grow means two copies of one
   private key exist — a cloned authenticator — or a replay. Synced passkeys
   (iCloud Keychain, Google Password Manager) send 0 every time, which is
   "this authenticator does not count", not a regression: the check applies
   only when either number is non-zero (§7.2 step 21). What the server DOES
   about a regression is its own policy, decided in api/access/signin_methods.js:
   the credential is disabled and the sign-in refused, with that reason.

   Every function throws a WebAuthnError whose `detail` is a plain-English
   sentence saying what was wrong. The routes show it to the person. */
import crypto from 'node:crypto';

export class WebAuthnError extends Error {
  constructor(code, detail) { super(detail); this.code = code; this.detail = detail; }
}
const bad = (code, detail) => { throw new WebAuthnError(code, detail); };

/* ── base64url ─────────────────────────────────────────────────────────
   Buffer.from(s, 'base64url') skips characters outside the alphabet without
   a word (measured: 'ab$$cd' decodes as 'abcd'), so two different strings
   would name the same credential. The alphabet is checked first. */
const B64URL = /^[A-Za-z0-9_-]*$/;
export const toB64url = (buf) => Buffer.from(buf).toString('base64url');
export function fromB64url(s, what = 'value', { max = 65536 } = {}) {
  if (typeof s !== 'string' || !B64URL.test(s) || s.length > max) bad('malformed', `The ${what} is not valid base64url.`);
  return Buffer.from(s, 'base64url');
}

/* ── CBOR, narrowly ────────────────────────────────────────────────────
   Maps come back as JS Maps: COSE keys are negative integers, which an
   object would turn into strings. */
const MAX_DEPTH = 8;
export function decodeCbor(input, { offset = 0, allowTrailing = false } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let pos = offset;
  const need = (n) => { if (pos + n > buf.length) bad('cbor', 'The authenticator\'s answer ended in the middle of a value.'); };
  const readLen = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) { need(1); return buf[pos++]; }
    if (ai === 25) { need(2); const v = buf.readUInt16BE(pos); pos += 2; return v; }
    if (ai === 26) { need(4); const v = buf.readUInt32BE(pos); pos += 4; return v; }
    if (ai === 27) {
      need(8); const v = buf.readBigUInt64BE(pos); pos += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) bad('cbor', 'The authenticator\'s answer holds a number too large to be real.');
      return Number(v);
    }
    /* 28–30 are reserved, 31 is an indefinite length: neither is something
       an authenticator sends (CTAP2 canonical CBOR has no indefinite lengths). */
    return bad('cbor', ai === 31 ? 'The authenticator\'s answer uses an indefinite length, which is not accepted.'
      : 'The authenticator\'s answer uses a reserved CBOR encoding.');
  };
  const item = (depth) => {
    if (depth > MAX_DEPTH) bad('cbor', 'The authenticator\'s answer is nested too deeply.');
    need(1);
    const ib = buf[pos++];
    const major = ib >> 5;
    const ai = ib & 31;
    switch (major) {
      case 0: return readLen(ai);
      case 1: return -1 - readLen(ai);
      case 2: { const n = readLen(ai); need(n); const v = Buffer.from(buf.subarray(pos, pos + n)); pos += n; return v; }
      case 3: {
        const n = readLen(ai); need(n);
        let s;
        try { s = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(pos, pos + n)); } catch { bad('cbor', 'The authenticator\'s answer holds text that is not UTF-8.'); }
        pos += n; return s;
      }
      case 4: {
        const n = readLen(ai);
        if (n > buf.length - pos) bad('cbor', 'The authenticator\'s answer claims more entries than it holds.');
        const out = [];
        for (let i = 0; i < n; i += 1) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = readLen(ai);
        if (n * 2 > buf.length - pos) bad('cbor', 'The authenticator\'s answer claims more entries than it holds.');
        const out = new Map();
        for (let i = 0; i < n; i += 1) {
          const k = item(depth + 1);
          if (typeof k !== 'number' && typeof k !== 'string') bad('cbor', 'The authenticator\'s answer has a map key that is neither a number nor text.');
          if (out.has(k)) bad('cbor', 'The authenticator\'s answer repeats a map key.');
          out.set(k, item(depth + 1));
        }
        return out;
      }
      case 7:
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        return bad('cbor', 'The authenticator\'s answer holds a CBOR value (a float or an undefined) that is not accepted.');
      default:
        return bad('cbor', 'The authenticator\'s answer holds a CBOR tag, which is not accepted.');
    }
  };
  const value = item(0);
  if (!allowTrailing && pos !== buf.length) bad('cbor', 'The authenticator\'s answer has bytes left over after its last value.');
  return { value, end: pos };
}

/* ── COSE keys → node:crypto ───────────────────────────────────────────
   COSE labels: 1 kty, 3 alg, -1 crv | n, -2 x | e, -3 y. */
export const ALGS = Object.freeze({ ES256: -7, RS256: -257 });
const ALG_NAME = { [-7]: 'ES256', [-257]: 'RS256' };
export function coseToKey(cose) {
  if (!(cose instanceof Map)) bad('key', 'The authenticator did not send a public key FleetMirror can read.');
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (alg === ALGS.ES256) {
    const crv = cose.get(-1); const x = cose.get(-2); const y = cose.get(-3);
    if (kty !== 2 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
      bad('key', 'The authenticator\'s ES256 key is not a P-256 key.');
    }
    try {
      return { alg, key: crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: toB64url(x), y: toB64url(y) }, format: 'jwk' }) };
    } catch { return bad('key', 'The authenticator\'s key is not a point on the P-256 curve.'); }
  }
  if (alg === ALGS.RS256) {
    const n = cose.get(-1); const e = cose.get(-2);
    if (kty !== 3 || !Buffer.isBuffer(n) || !Buffer.isBuffer(e)) bad('key', 'The authenticator\'s RS256 key is not an RSA key.');
    let key;
    try { key = crypto.createPublicKey({ key: { kty: 'RSA', n: toB64url(n), e: toB64url(e) }, format: 'jwk' }); } catch {
      bad('key', 'The authenticator\'s RSA key could not be read.');
    }
    if ((key.asymmetricKeyDetails?.modulusLength || 0) < 2048) bad('key', 'The authenticator\'s RSA key is shorter than 2048 bits.');
    return { alg, key };
  }
  return bad('alg', `The authenticator made a key with an algorithm FleetMirror does not accept (COSE ${alg}). It accepts ES256 and RS256.`);
}
export const keyToSpki = (key) => key.export({ type: 'spki', format: 'der' }).toString('base64');
export const spkiToKey = (b64) => crypto.createPublicKey({ key: Buffer.from(String(b64), 'base64'), format: 'der', type: 'spki' });

/* ── authenticator data ────────────────────────────────────────────────── */
export const FLAG = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 });
export function parseAuthData(input) {
  const buf = Buffer.from(input);
  if (buf.length < 37) bad('authdata', 'The authenticator data is too short to be real.');
  const flags = buf[32];
  const out = {
    rpIdHash: buf.subarray(0, 32), flags,
    up: Boolean(flags & FLAG.UP), uv: Boolean(flags & FLAG.UV),
    be: Boolean(flags & FLAG.BE), bs: Boolean(flags & FLAG.BS),
    signCount: buf.readUInt32BE(33), credentialId: null, aaguid: null, cose: null,
  };
  let pos = 37;
  if (flags & FLAG.AT) {
    if (buf.length < pos + 18) bad('authdata', 'The authenticator data ends before the new credential does.');
    out.aaguid = buf.subarray(pos, pos + 16).toString('hex');
    const len = buf.readUInt16BE(pos + 16);
    pos += 18;
    if (len < 16 || len > 1023) bad('authdata', 'The credential id is not between 16 and 1023 bytes long.');
    if (buf.length < pos + len) bad('authdata', 'The authenticator data ends inside the credential id.');
    out.credentialId = Buffer.from(buf.subarray(pos, pos + len));
    pos += len;
    const k = decodeCbor(buf, { offset: pos, allowTrailing: true });
    out.cose = k.value;
    pos = k.end;
  }
  if (flags & FLAG.ED) {
    const x = decodeCbor(buf, { offset: pos, allowTrailing: true });
    if (!(x.value instanceof Map)) bad('authdata', 'The authenticator\'s extensions are not a map.');
    pos = x.end;
  }
  if (pos !== buf.length) bad('authdata', 'The authenticator data has bytes left over.');
  return out;
}

/* ── the client data, and where a ceremony may come from ───────────────── */
export function parseClientData(b64) {
  const raw = fromB64url(b64, 'client data', { max: 8192 });
  let c;
  try { c = JSON.parse(raw.toString('utf8')); } catch { bad('clientdata', 'The browser\'s client data is not JSON.'); }
  if (!c || typeof c !== 'object') bad('clientdata', 'The browser\'s client data is not an object.');
  return { raw, c };
}
/* The challenge a client data names, so the route can find the ceremony it
   belongs to before verifying anything else. */
export function clientDataChallenge(b64) {
  try { const { c } = parseClientData(b64); return typeof c.challenge === 'string' ? c.challenge : null; } catch { return null; }
}
function checkClientData(c, { type, challenge, origin }) {
  if (c.type !== type) bad('type', `The browser described a ${String(c.type || 'different').slice(0, 30)} ceremony where ${type} was expected.`);
  if (typeof c.challenge !== 'string' || !challenge || c.challenge !== challenge) {
    bad('challenge', 'The browser signed a challenge FleetMirror did not issue for this step.');
  }
  if (c.origin !== origin) {
    bad('origin', `The passkey was used on ${String(c.origin || 'an unknown address').slice(0, 80)}, not on ${origin}.`);
  }
  /* Inside another site's frame. The page refuses framing anyway
     (frame-ancestors 'none'); this is the authenticator's own word for it. */
  if (c.crossOrigin === true || c.topOrigin !== undefined) bad('origin', 'The passkey was used inside a frame on another site.');
}
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
function checkAuthData(ad, { rpId }) {
  if (!crypto.timingSafeEqual(ad.rpIdHash, sha256(Buffer.from(rpId, 'utf8')))) {
    bad('rpid', `The passkey belongs to a different site, not to ${rpId}.`);
  }
  if (!ad.up) bad('presence', 'The authenticator did not confirm that a person was present.');
  if (!ad.uv) bad('verification', 'The authenticator did not verify the person (no PIN, fingerprint or face check), and FleetMirror requires it.');
  if (ad.bs && !ad.be) bad('flags', 'The authenticator says the passkey is backed up but cannot be backed up — a contradiction.');
}

/* ── where passkeys belong: PUBLIC_URL, from the environment only ────────
   The RP id is the host a passkey is bound to and the origin is the address
   a ceremony must come from. Both come from PUBLIC_URL, read from
   process.env and never from the Settings page: the system audit of
   2026-11-12 found that a value kept there can be rewritten anonymously
   while sign-in is optional (PUT /api/settings), and a site whose passkey
   origin anybody could change would accept ceremonies from anybody's site.
   https only, except http://localhost for a developer's own machine
   (WebAuthn treats localhost as a secure context; an IP address is never a
   valid RP id). */
export function rpConfig(env = process.env) {
  const raw = String(env.PUBLIC_URL || '').trim();
  if (!raw) return { ok: false, why: 'PUBLIC_URL is not set on the platform, so it is not known which address passkeys belong to.' };
  let u;
  try { u = new URL(raw); } catch { return { ok: false, why: 'PUBLIC_URL on the platform is not a valid address.' }; }
  const local = u.protocol === 'http:' && u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !local) return { ok: false, why: 'PUBLIC_URL on the platform is not an https address, and passkeys work only over https.' };
  if (/^[\d.]+$/.test(u.hostname) || u.hostname.includes(':')) return { ok: false, why: 'PUBLIC_URL on the platform is an IP address, and passkeys need a domain name.' };
  return { ok: true, origin: u.origin, rpId: u.hostname, name: 'FleetMirror' };
}

/* ── options the browser is given ──────────────────────────────────────── */
export const TRANSPORTS = Object.freeze(['usb', 'nfc', 'ble', 'smart-card', 'hybrid', 'internal', 'cable']);
export function creationOptions({ rp, challenge, userHandle, email, name, exclude = [] }) {
  return {
    rp: { id: rp.rpId, name: rp.name },
    user: { id: userHandle, name: email, displayName: name || email },
    challenge,
    pubKeyCredParams: [{ type: 'public-key', alg: ALGS.ES256 }, { type: 'public-key', alg: ALGS.RS256 }],
    timeout: 300000,
    attestation: 'none',
    /* Discoverable ("resident") so the sign-in page needs no email typed —
       and so asking for one never says which addresses have passkeys. */
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: exclude.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports || [] })),
  };
}
export function requestOptions({ rp, challenge, allow = [] }) {
  return {
    challenge, rpId: rp.rpId, timeout: 300000, userVerification: 'required',
    allowCredentials: allow.map((c) => ({ type: 'public-key', id: c.credential_id, transports: c.transports || [] })),
  };
}

/* ── the shape of what the browser posts back ──────────────────────────── */
function credentialShape(cred, fields) {
  if (!cred || typeof cred !== 'object' || cred.type !== 'public-key') bad('malformed', 'The browser did not send a passkey.');
  if (typeof cred.id !== 'string' || !B64URL.test(cred.id) || !cred.id) bad('malformed', 'The passkey has no valid id.');
  if (cred.rawId !== undefined && cred.rawId !== cred.id) bad('malformed', 'The passkey\'s id and raw id disagree.');
  const r = cred.response;
  if (!r || typeof r !== 'object') bad('malformed', 'The browser sent a passkey with no response.');
  for (const f of fields) if (typeof r[f] !== 'string') bad('malformed', `The passkey response is missing ${f}.`);
  return r;
}

/* ── registration ──────────────────────────────────────────────────────── */
export function verifyRegistration({ credential, challenge, rp }) {
  const r = credentialShape(credential, ['clientDataJSON', 'attestationObject']);
  const { c } = parseClientData(r.clientDataJSON);
  checkClientData(c, { type: 'webauthn.create', challenge, origin: rp.origin });
  const att = decodeCbor(fromB64url(r.attestationObject, 'attestation object')).value;
  if (!(att instanceof Map) || typeof att.get('fmt') !== 'string' || !Buffer.isBuffer(att.get('authData')) || !(att.get('attStmt') instanceof Map)) {
    bad('attestation', 'The authenticator\'s attestation object is not shaped as WebAuthn says.');
  }
  const fmt = att.get('fmt');
  if (fmt === 'none' && att.get('attStmt').size !== 0) bad('attestation', 'An attestation of format "none" carried a statement.');
  const ad = parseAuthData(att.get('authData'));
  checkAuthData(ad, { rpId: rp.rpId });
  if (!ad.credentialId || !ad.cose) bad('authdata', 'The authenticator did not include the new credential.');
  if (toB64url(ad.credentialId) !== credential.id) bad('malformed', 'The credential id in the authenticator data is not the one the browser named.');
  const { alg, key } = coseToKey(ad.cose);
  const transports = Array.isArray(r.transports)
    ? [...new Set(r.transports.filter((t) => TRANSPORTS.includes(t)))].slice(0, 8) : [];
  return {
    credentialId: credential.id, publicKey: keyToSpki(key), alg, algName: ALG_NAME[alg],
    /* fmt is the authenticator's own text (up to the attestation object's
       64 KB) and only the audit log keeps it: a label, so it is cut. */
    signCount: ad.signCount, transports, aaguid: ad.aaguid, backupEligible: ad.be, backedUp: ad.bs, fmt: fmt.slice(0, 32),
  };
}

/* ── authentication ────────────────────────────────────────────────────
   `stored` is the credential's row: public_key (SPKI, base64), alg,
   sign_count, user_handle. Returns the new counter and whether it went
   backwards; the caller decides what a regression costs.
   `requireUserHandle`: signing in with no email typed, the credential is
   the only thing that says who this is, so it must name its person (§7.2
   step 6); a step-up already knows who is asking and lists the credentials
   it will take. */
export function verifyAssertion({ credential, challenge, rp, stored, requireUserHandle = false }) {
  const r = credentialShape(credential, ['clientDataJSON', 'authenticatorData', 'signature']);
  if (stored.credential_id && stored.credential_id !== credential.id) bad('malformed', 'The passkey presented is not the one on record.');
  if (r.userHandle != null && r.userHandle !== '') {
    if (typeof r.userHandle !== 'string' || !B64URL.test(r.userHandle) || r.userHandle !== stored.user_handle) {
      bad('user', 'The passkey names a different person from the one it was registered to.');
    }
  } else if (requireUserHandle) {
    bad('user', 'The passkey did not say whose it is.');
  }
  const { raw, c } = parseClientData(r.clientDataJSON);
  checkClientData(c, { type: 'webauthn.get', challenge, origin: rp.origin });
  const adBuf = fromB64url(r.authenticatorData, 'authenticator data', { max: 4096 });
  const ad = parseAuthData(adBuf);
  checkAuthData(ad, { rpId: rp.rpId });
  const sig = fromB64url(r.signature, 'signature', { max: 2048 });
  const data = Buffer.concat([adBuf, sha256(raw)]);
  const key = spkiToKey(stored.public_key);
  let ok = false;
  try {
    ok = Number(stored.alg) === ALGS.ES256
      ? crypto.verify('sha256', data, { key, dsaEncoding: 'der' }, sig)
      : Number(stored.alg) === ALGS.RS256
        ? crypto.verify('sha256', data, { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)
        : false;
  } catch { ok = false; }
  if (!ok) bad('signature', 'The passkey\'s signature does not verify.');
  const before = Number(stored.sign_count) || 0;
  const regressed = (ad.signCount !== 0 || before !== 0) && ad.signCount <= before;
  return { signCount: ad.signCount, regressed, before, backedUp: ad.bs, backupEligible: ad.be };
}
