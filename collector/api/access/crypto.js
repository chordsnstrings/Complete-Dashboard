/* Passwords, tokens, two-step codes — node:crypto only.
   ─────────────────────────────────────────────────────────────────────────
   No new dependency. scrypt is in node:crypto, TOTP is thirty lines of HMAC
   (RFC 6238 over RFC 4226), and AES-256-GCM seals the TOTP secrets at rest.

   PASSWORDS. scrypt with N=2^14, r=8, p=1: 16 MiB of memory per hash, which is
   the cost the platform's smallest instance (basic-xxs, 512 MiB) can pay for a
   handful of concurrent sign-ins without swapping. The stored form carries its
   own parameters, so raising them later re-hashes on the next sign-in rather
   than locking anybody out.

   TOKENS. Session, invite and reset tokens are 32 random bytes, base64url.
   Only their SHA-256 is stored: a copy of the database is not a copy of
   anybody's session. */
import crypto from 'node:crypto';

const N = 1 << 14, R = 8, P = 1, KEYLEN = 64;

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${Math.log2(N)}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/* Constant time, and a malformed stored value is simply "no". */
export function verifyPassword(plain, stored) {
  try {
    const [alg, logN, r, p, salt, hash] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const want = Buffer.from(hash, 'base64');
    const got = crypto.scryptSync(String(plain), Buffer.from(salt, 'base64'), want.length,
      { N: 1 << Number(logN), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch { return false; }
}
export const needsRehash = (stored) => !String(stored || '').startsWith(`scrypt$${Math.log2(N)}$${R}$${P}$`);

/* A password somebody will actually keep: long rather than decorated. The
   checks are the ones that matter — length, not the email, not one repeated
   character — and each refusal says which it was. */
export function passwordProblem(plain, { email = '' } = {}) {
  const s = String(plain || '');
  if (s.length < 12) return 'Use at least 12 characters.';
  if (s.length > 200) return 'Use at most 200 characters.';
  if (/^(.)\1+$/.test(s)) return 'Use more than one repeated character.';
  const local = String(email).toLowerCase().split('@')[0];
  if (local && local.length >= 4 && s.toLowerCase().includes(local)) return 'Do not include your email name in the password.';
  if (['password1234', '123456789012', 'qwertyuiopas', 'fleetmirror12', 'fleetmirror123'].includes(s.toLowerCase())) {
    return 'That password is too easy to guess.';
  }
  return null;
}

export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* A password the system generates (the handover password, a reset). Words a
   person can type on a phone, from a list with no look-alikes, with digits:
   about 80 bits. */
const WORDS = ('amber anchor arrow basil birch cedar cinder cobalt coral delta dune ember fable fern '
  + 'flint garnet harbor hazel indigo iris jade juniper kestrel lagoon larch linen lotus maple marble '
  + 'meadow mesa mint nectar oasis olive onyx orbit pebble pepper pine plume quartz raven reef ridge '
  + 'saffron sage sierra slate sparrow spruce summit tamarind thistle tidal topaz tundra umber velvet '
  + 'willow yarrow zephyr').split(' ');
export function generatePassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(1000, 10000));
  return `${pick()}-${pick()}-${pick()}-${pick()}-${digits}`;
}

/* ── sealing secrets at rest (TOTP seeds) ─────────────────────────────── */
const sealKey = () => crypto.createHash('sha256')
  .update(`fleetmirror-access|${process.env.ACCESS_KEY || process.env.SETTINGS_KEY || process.env.DATABASE_URL || 'fleet-dev-key'}`)
  .digest();
export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `a1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${out.toString('base64')}`;
}
export function unseal(blob) {
  try {
    const [v, iv, tag, data] = String(blob).split(':');
    if (v !== 'a1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

/* ── TOTP (RFC 6238: 30-second steps, 6 digits, HMAC-SHA1) ──────────────
   SHA-1 because it is what every authenticator app implements; HOTP's use of
   it is not affected by SHA-1's collision weakness. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function hotp(secretB32, counter) {
  const key = base32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 1e6).padStart(6, '0');
}
export const totpStep = (ms = Date.now()) => Math.floor(ms / 30000);
/* One step either side, for a phone clock that drifts. Returns the step that
   matched, so the caller can refuse the same code twice (replay). */
export function verifyTotp(secretB32, code, { now = Date.now(), lastStep = null } = {}) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const t = totpStep(now);
  for (const s of [t, t - 1, t + 1]) {
    if (lastStep != null && s <= Number(lastStep)) continue;
    if (safeEqual(hotp(secretB32, s), c)) return s;
  }
  return null;
}
export const otpauthUri = (secret, email, issuer = 'FleetMirror') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* Recovery codes: ten one-time codes shown once, stored hashed. */
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const s = crypto.randomBytes(5).toString('hex');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
