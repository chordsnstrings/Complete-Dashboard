/* PASSKEYS — the WebAuthn verification in api/access/webauthn.js, alone.
   ═════════════════════════════════════════════════════════════════════════
   The CBOR decoder against RFC 8949 Appendix A, the COSE keys, the
   authenticator data, and both ceremonies against a synthetic authenticator
   (test/_authenticator.mjs, whose CBOR ENCODER is separate from the decoder
   here). Every refusal the server can give is provoked at least once, and
   each says what was wrong in words.

   The full ceremonies over HTTP, through the real access gate, are in
   test/access_passkey_sso.test.mjs.

   REVERSIONS THAT PROVE IT — each was made, run, and seen to fail the named
   check, 2026-11-12:
     · checkAuthData: drop the `!ad.uv` refusal — "user verification is
       required" fails (registration and sign-in both).
     · checkClientData: drop the origin comparison — "a passkey used on
       another site is refused" fails.
     · verifyAssertion: make `regressed` false — the three "counter" checks
       fail.
     · decodeCbor: allow trailing bytes at the top level — "bytes after the
       last value are refused" fails. */
import crypto from 'node:crypto';
import {
  decodeCbor, coseToKey, parseAuthData, verifyRegistration, verifyAssertion, rpConfig, creationOptions, requestOptions,
  fromB64url, WebAuthnError, keyToSpki,
} from '../api/access/webauthn.js';
import { cbor, makeAuthenticator } from './_authenticator.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const refuses = (fn, code) => {
  try { fn(); return `accepted`; } catch (e) {
    if (!(e instanceof WebAuthnError)) return `threw ${e}`;
    if (code && e.code !== code) return `refused as ${e.code}: ${e.detail}`;
    return e.detail && /[a-z]/.test(e.detail) ? true : 'no sentence';
  }
};
const hex = (h) => Buffer.from(h.replace(/\s+/g, ''), 'hex');

console.log('\n1. CBOR, against RFC 8949 Appendix A');
{
  const v = (h) => decodeCbor(hex(h)).value;
  check('0, 23, 24, 1000, 1000000, 1000000000000', v('00') === 0 && v('17') === 23 && v('1818') === 24 && v('1903e8') === 1000
    && v('1a000f4240') === 1000000 && v('1b000000e8d4a51000') === 1000000000000);
  check('-1, -100, -1000', v('20') === -1 && v('3863') === -100 && v('3903e7') === -1000);
  check("h'' and h'01020304'", v('40').length === 0 && v('4401020304').equals(hex('01020304')));
  check('"" "a" "IETF" and "ü" (UTF-8)', v('60') === '' && v('6161') === 'a' && v('6449455446') === 'IETF' && v('62c3bc') === 'ü');
  check('[] and [1, 2, 3] and [1, [2, 3], [4, 5]]', JSON.stringify(v('80')) === '[]' && JSON.stringify(v('83010203')) === '[1,2,3]'
    && JSON.stringify(v('8301820203820405')) === '[1,[2,3],[4,5]]');
  const m = v('a201020304');
  check('{1: 2, 3: 4} is a Map with integer keys', m instanceof Map && m.get(1) === 2 && m.get(3) === 4);
  check('false, true, null', v('f4') === false && v('f5') === true && v('f6') === null);
  check('the test encoder and the decoder agree on a COSE-shaped map',
    (() => { const x = decodeCbor(cbor(new Map([[1, 2], [-2, Buffer.from([9])], ['fmt', 'none']]))).value; return x.get(-2)[0] === 9 && x.get('fmt') === 'none'; })());
  check('undefined (0xf7) is refused', refuses(() => v('f7'), 'cbor') === true);
  check('a float (1.0 as a half float) is refused', refuses(() => v('f93c00'), 'cbor') === true);
  check('a tag (0 = date-time) is refused', refuses(() => v('c074323031332d30332d32315432303a30343a30305a'), 'cbor') === true);
  check('an indefinite byte string is refused', refuses(() => v('5f42010243030405ff'), 'cbor') === true);
  check('an indefinite array is refused', refuses(() => v('9fff'), 'cbor') === true);
  check('a number above 2^53 is refused', refuses(() => v('1bffffffffffffffff'), 'cbor') === true);
  check('bytes after the last value are refused', refuses(() => v('0000'), 'cbor') === true);
  check('…unless the caller is reading a value inside a longer buffer', decodeCbor(hex('0000'), { allowTrailing: true }).end === 1);
  check('a repeated map key is refused', refuses(() => v('a201020103'), 'cbor') === true);
  check('a map key that is a byte string is refused', refuses(() => v('a1410102'), 'cbor') === true);
  check('a value cut short is refused', refuses(() => v('4401020'), 'cbor') === true && refuses(() => v('44010203'), 'cbor') === true);
  check('an array claiming more entries than bytes is refused', refuses(() => v('9a7fffffff'), 'cbor') === true);
  check('text that is not UTF-8 is refused', refuses(() => v('62c328'), 'cbor') === true);
  check('nesting deeper than eight is refused', refuses(() => v('818181818181818181818100'), 'cbor') === true);
}

console.log('\n2. COSE keys');
{
  const a = makeAuthenticator({ alg: -7 });
  const k = coseToKey(a.state.cose);
  check('an ES256 COSE key becomes a P-256 public key', k.alg === -7 && k.key.asymmetricKeyDetails.namedCurve === 'prime256v1');
  check('…stored as SubjectPublicKeyInfo', keyToSpki(k.key).length > 80);
  const r = makeAuthenticator({ alg: -257 });
  check('an RS256 COSE key becomes a 2048-bit RSA key', coseToKey(r.state.cose).key.asymmetricKeyDetails.modulusLength === 2048);
  const off = new Map(a.state.cose); off.set(-3, Buffer.alloc(32, 7));
  check('a point that is not on the curve is refused', refuses(() => coseToKey(off), 'key') === true);
  const short = new Map(a.state.cose); short.set(-2, Buffer.alloc(31, 1));
  check('a coordinate of the wrong length is refused', refuses(() => coseToKey(short), 'key') === true);
  const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'jwk' });
  check('an RSA key under 2048 bits is refused', refuses(() => coseToKey(new Map([[1, 3], [3, -257],
    [-1, Buffer.from(weak.n, 'base64url')], [-2, Buffer.from(weak.e, 'base64url')]])), 'key') === true);
  let edDetail = '';
  try { coseToKey(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.alloc(32)]])); } catch (e) { edDetail = `${e.code}: ${e.detail}`; }
  check('EdDSA (-8), which was not offered, is refused with the algorithm named', /^alg: .*COSE -8.*ES256 and RS256/.test(edDetail), edDetail);
  const wrongKty = new Map(a.state.cose); wrongKty.set(1, 3);
  check('an ES256 key that says it is RSA is refused', refuses(() => coseToKey(wrongKty), 'key') === true);
}

console.log('\n3. authenticator data');
{
  const a = makeAuthenticator();
  const rp = rpConfig({ PUBLIC_URL: 'http://localhost:8310' });
  const opts = creationOptions({ rp, challenge: 'c1', userHandle: 'u1', email: 'p@example.test', exclude: [] });
  const att = decodeCbor(fromB64url(a.create(opts).response.attestationObject)).value;
  const ad = parseAuthData(att.get('authData'));
  check('flags, counter, credential id and key are read', ad.up && ad.uv && !ad.be && ad.signCount === 0
    && ad.credentialId.toString('base64url') === a.credentialId && ad.cose instanceof Map);
  check('bytes after the key are refused', refuses(() => parseAuthData(Buffer.concat([att.get('authData'), Buffer.from([0])])), 'authdata') === true);
  check('data shorter than 37 bytes is refused', refuses(() => parseAuthData(Buffer.alloc(36)), 'authdata') === true);
  const tiny = Buffer.concat([att.get('authData').subarray(0, 37), Buffer.alloc(16), Buffer.from([0, 4]), Buffer.alloc(4)]);
  check('a credential id under 16 bytes is refused', refuses(() => parseAuthData(tiny), 'authdata') === true);
  const withExt = Buffer.concat([att.get('authData'), cbor(new Map([['credProtect', 2]]))]);
  withExt[32] |= 0x80;
  check('extensions (the ED flag) are read past, not left over', parseAuthData(withExt).cose instanceof Map);
}

console.log('\n4. registration');
const rp = rpConfig({ PUBLIC_URL: 'http://localhost:8310' });
const opts = (challenge = crypto.randomBytes(32).toString('base64url')) => creationOptions({ rp, challenge,
  userHandle: crypto.randomBytes(32).toString('base64url'), email: 'person@example.test', name: 'Test Person', exclude: [] });
{
  const a = makeAuthenticator();
  const o = opts();
  const v = verifyRegistration({ credential: a.create(o), challenge: o.challenge, rp });
  check('a well-formed ES256 registration verifies', v.credentialId === a.credentialId && v.alg === -7 && v.signCount === 0);
  check('…its public key is the authenticator\'s', crypto.createPublicKey({ key: Buffer.from(v.publicKey, 'base64'), format: 'der', type: 'spki' })
    .export({ format: 'jwk' }).x === a.state.privateKey.export({ format: 'jwk' }).x);
  check('…unknown transports are dropped, known ones kept', JSON.stringify(v.transports) === '["internal","hybrid"]');
  const r = makeAuthenticator({ alg: -257 });
  const o2 = opts();
  check('a well-formed RS256 registration verifies', verifyRegistration({ credential: r.create(o2), challenge: o2.challenge, rp }).alg === -257);
  const s = makeAuthenticator({ synced: true });
  const o3 = opts();
  const sv = verifyRegistration({ credential: s.create(o3), challenge: o3.challenge, rp });
  check('a synced passkey is recorded as backed up', sv.backupEligible && sv.backedUp);

  const bad = (over, code, name) => {
    const x = makeAuthenticator(); const oo = opts();
    check(name, refuses(() => verifyRegistration({ credential: x.create(oo, over), challenge: oo.challenge, rp }), code) === true);
  };
  bad({ type: 'webauthn.get' }, 'type', 'an assertion presented as a registration is refused');
  bad({ challenge: 'not-the-challenge' }, 'challenge', 'a challenge FleetMirror did not issue is refused');
  bad({ origin: 'https://evil.example' }, 'origin', 'a passkey made on another site is refused');
  bad({ crossOrigin: true }, 'origin', 'a passkey made inside another site\'s frame is refused');
  bad({ rp: 'evil.example' }, 'rpid', 'a passkey for another RP id is refused');
  bad({ flags: { uv: false } }, 'verification', 'user verification is required');
  bad({ flags: { up: false } }, 'presence', 'user presence is required');
  bad({ flags: { be: false, bs: true } }, 'flags', 'backed up but not backup-eligible is refused');
  bad({ attStmt: new Map([['sig', Buffer.alloc(8)]]) }, 'attestation', 'a "none" attestation carrying a statement is refused');
  bad({ idOverride: crypto.randomBytes(32).toString('base64url') }, 'malformed', 'a credential id that differs from the one in the authenticator data is refused');
  bad({ coseKey: new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.alloc(32)]]) }, 'alg', 'an algorithm that was not offered is refused');
  const p = makeAuthenticator(); const op = opts();
  check('another attestation format is accepted with its statement ignored (the trust of "none")',
    verifyRegistration({ credential: p.create(op, { fmt: 'packed', attStmt: new Map([['alg', -7], ['sig', Buffer.alloc(8)]]) }), challenge: op.challenge, rp }).fmt === 'packed');
  /* Review, 2026-11-12: the format's name is whatever the authenticator
     wrote (up to the attestation object's 64 KB) and goes into the audit
     log; it is a label, so it is cut. */
  const lf = makeAuthenticator(); const olf = opts();
  check('…and that format\'s name, which only the audit log keeps, is cut to 32 characters',
    verifyRegistration({ credential: lf.create(olf, { fmt: 'x'.repeat(5000) }), challenge: olf.challenge, rp }).fmt.length === 32);
  const lenient = makeAuthenticator(); const ol = opts();
  const cred = lenient.create(ol);
  cred.response.attestationObject = `${cred.response.attestationObject.slice(0, 10)}$$${cred.response.attestationObject.slice(10)}`;
  check('base64url with characters outside its alphabet is refused (not silently skipped)',
    refuses(() => verifyRegistration({ credential: cred, challenge: ol.challenge, rp }), 'malformed') === true);
  check('no credential at all is refused', refuses(() => verifyRegistration({ credential: null, challenge: 'x', rp }), 'malformed') === true);
}

console.log('\n5. signing in (assertion)');
{
  const signIn = (a, row, over = {}, { requireUserHandle = true } = {}) => {
    const challenge = crypto.randomBytes(32).toString('base64url');
    const o = requestOptions({ rp, challenge });
    return verifyAssertion({ credential: a.get(o, over), challenge, rp, stored: row, requireUserHandle });
  };
  const enrol = (alg = -7, extra = {}) => {
    const a = makeAuthenticator({ alg, ...extra }); const o = opts();
    const v = verifyRegistration({ credential: a.create(o), challenge: o.challenge, rp });
    return { a, row: { credential_id: v.credentialId, public_key: v.publicKey, alg: v.alg, sign_count: v.signCount, user_handle: o.user.id } };
  };
  {
    const { a, row } = enrol(-7);
    const r = signIn(a, row);
    check('a well-formed ES256 assertion verifies, and the counter moves on', r.signCount === 1 && !r.regressed);
    row.sign_count = r.signCount;
    check('…and again', signIn(a, row).signCount === 2);
  }
  {
    const { a, row } = enrol(-257);
    check('a well-formed RS256 assertion verifies', !signIn(a, row).regressed);
  }
  {
    const { a, row } = enrol();
    check('a tampered signature is refused', refuses(() => signIn(a, row, { tamper: true }), 'signature') === true);
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    check('a signature by another key is refused', refuses(() => signIn(a, row, { signWith: other }), 'signature') === true);
    check('a passkey used on another site is refused', refuses(() => signIn(a, row, { origin: 'https://evil.example' }), 'origin') === true);
    check('a registration presented as a sign-in is refused', refuses(() => signIn(a, row, { type: 'webauthn.create' }), 'type') === true);
    check('another RP id is refused', refuses(() => signIn(a, row, { rp: 'evil.example' }), 'rpid') === true);
    check('user verification is required to sign in too', refuses(() => signIn(a, row, { flags: { uv: false } }), 'verification') === true);
    check('a user handle naming somebody else is refused', refuses(() => signIn(a, row, { userHandle: crypto.randomBytes(32).toString('base64url') }), 'user') === true);
    check('no user handle, signing in with no email, is refused', refuses(() => signIn(a, row, { userHandle: null }), 'user') === true);
    check('…while a step-up, which knows who is asking, does not need one', !signIn(a, row, { userHandle: null }, { requireUserHandle: false }).regressed);
    const wrong = { ...row, credential_id: 'c29tZXRoaW5nLWVsc2U' };
    check('a credential that is not the one on record is refused', refuses(() => signIn(a, wrong), 'malformed') === true);
    check('a challenge that was not issued is refused', refuses(() => {
      const o = requestOptions({ rp, challenge: 'issued' });
      return verifyAssertion({ credential: a.get(o, { challenge: 'forged' }), challenge: 'issued', rp, stored: row, requireUserHandle: true });
    }, 'challenge') === true);
  }
  {
    const { a, row } = enrol(-7, { counter: 5 });
    row.sign_count = 5;
    check('counter: the same number again is a regression', signIn(a, row, { count: 5 }).regressed === true);
    check('counter: a smaller number is a regression', signIn(a, row, { count: 4 }).regressed === true);
    check('counter: a larger number is not', signIn(a, row, { count: 6 }).regressed === false);
    const s = enrol(-7, { synced: true });
    check('counter: 0 and 0 (a synced passkey, which does not count) is not a regression', signIn(s.a, s.row).regressed === false && s.row.sign_count === 0);
    s.row.sign_count = 3;
    check('counter: 0 after 3 is a regression', signIn(s.a, s.row, { count: 0 }).regressed === true);
  }
}

console.log('\n6. where passkeys belong (PUBLIC_URL, from the environment)');
{
  check('unset → not ready, and says so', !rpConfig({}).ok && /PUBLIC_URL is not set/.test(rpConfig({}).why));
  check('http on a real host → not ready', !rpConfig({ PUBLIC_URL: 'http://fleet.example.test' }).ok);
  check('an IP address → not ready', !rpConfig({ PUBLIC_URL: 'https://10.0.0.5' }).ok);
  const ok = rpConfig({ PUBLIC_URL: 'https://fleet.example.test/' });
  check('https → ready, RP id the host, origin with no path', ok.ok && ok.rpId === 'fleet.example.test' && ok.origin === 'https://fleet.example.test');
  check('http://localhost → ready (a developer\'s machine)', rpConfig({ PUBLIC_URL: 'http://localhost:8310' }).ok);
  const o = creationOptions({ rp: ok, challenge: 'c', userHandle: 'u', email: 'p@example.test', exclude: [{ credential_id: 'abc', transports: ['usb'] }] });
  check('options ask for a discoverable credential, user verification, no attestation, ES256 then RS256',
    o.authenticatorSelection.residentKey === 'required' && o.authenticatorSelection.userVerification === 'required'
    && o.attestation === 'none' && o.pubKeyCredParams.map((x) => x.alg).join() === '-7,-257' && o.excludeCredentials[0].id === 'abc');
}

console.log(`\n${fail ? '✗' : '✓'} webauthn: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
