/* Reading a credential rather than being told what it is.
   ─────────────────────────────────────────────────────────────────────────
   The failure this prevents is silent and expensive: put the Egari cookie on
   UBER_WEB_COOKIE and the Ecosine collector points at the wrong organisation,
   Uber answers happily, and another business's trips arrive under this one's
   name. Nothing errors. So the assertion that matters is not "it recognised a
   cookie" — it is "it put the cookie on the right KEY", and that every case it
   cannot be sure about is refused rather than guessed.

   Every fixture is built here from its parts. Nothing in this file is a real
   session, and the only claims that carry meaning are the ones the code reads:
   fleet_owner_id, and supplierOrgUUID.
*/
import { jwtPayload, cookieMap, cookieText, recognise, splitBlocks } from '../src/credkit.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const HEAD = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const jwt = (payload) => [HEAD, b64(payload), 'not_a_real_signature'].join('.');
const EXP = Math.floor(Date.parse('2026-09-03T10:30:00Z') / 1000);

const ECO_ORG = '58ca3b81-4953-4793-9f56-d93e16f771bb';
const EGA_ORG = 'b2004b53-8175-4706-ab0a-c8b60e586c7c';
process.env.UBER_ORG_UUID = ECO_ORG;
process.env.UBER_ORG_UUID_EGARI = EGA_ORG;

/* A supplier jar, assembled rather than pasted: the marker cookie, the session
   JWT that names the org, and two of the analytics cookies that ride along. */
const uberJar = (org) => [
  'marketing_vistor_id=00000000-0000-0000-0000-000000000000',
  'udi-id=placeholder==value=',
  'sid=QA.PLACEHOLDER.value',
  `sp-jwt-session=${jwt({ data: { supplierOrgUUID: org, tenancy: 'uber/production' }, iat: 1, exp: EXP })}`,
  'utag_main__pn=2%3Bexp-session',
].join('; ');

const boltTok = (owner) => jwt({ data: { type: 'base', fleet_owner_id: owner }, iat: 1, exp: EXP });

/* Yandex's `yp` and `ymex` values contain semicolons and hashes of their own;
   splitting on every "; " tore them into fragments and lost the jar. */
const yangoJar = [
  'yp=2101621394.udn.cGxhY2Vob2xkZXI#1788069198.yu.2608223611',
  'ymex=1790574798.oyu.2608223611#2101621275.yrts.1786261275',
  'Session_id=3:1786261394.5.0:PLACEHOLDER:511b.1.2:1|196.0.2.0:3.3|60:121.306.abc',
  'yandex_login=muzammil16075',
  'lang=en',
].join('; ');

/* ── the pieces ─────────────────────────────────────────────────────────── */
check('a JWT payload is read without checking its signature',
  jwtPayload(boltTok(173999))?.data?.fleet_owner_id === 173999);
check('a JWT embedded in a longer string is still found',
  jwtPayload(`sp-jwt-session=${jwt({ a: 1 })}; other=2`)?.a === 1);
check('nonsense is not a JWT', jwtPayload('hello world') === null);
check('a truncated JWT is not a JWT', jwtPayload('eyJhbGci.broken') === null);
check('a cookie value containing # and . survives the split',
  cookieMap(yangoJar).yp.includes('#1788069198.yu.2608223611'));
check('and the cookie after it is still found', cookieMap(yangoJar).lang === 'en');
check('the jar is pulled out of a pasted curl command',
  cookieMap(cookieText(`curl --url 'https://x' -b 'a=1; b=2' -H 'accept: */*'`)).b === '2');
check('a bare jar is left alone', cookieMap(cookieText('a=1; b=2')).a === '1');

/* ── naming the credential ──────────────────────────────────────────────── */
const one = (t) => recognise(t)[0];

check('a Bolt token names itself by fleet owner', one(boltTok(173999))?.provider === 'Bolt');
check('…owner 173999 is ecosine', one(boltTok(173999))?.key === 'BOLT_REFRESH_TOKEN_ECOSINE');
check('…owner 174036 is egari', one(boltTok(174036))?.key === 'BOLT_REFRESH_TOKEN_EGARI');
check('…and an owner this fleet does not have is refused, not guessed',
  one(boltTok(999999))?.key === null && one(boltTok(999999))?.ok === false);
check('a Bolt token carries its expiry', one(boltTok(173999))?.expires_at.startsWith('2026-09-03'));

check('an Uber jar names itself by the org inside its session cookie',
  one(uberJar(ECO_ORG))?.provider === 'Uber');
check('…the ecosine org goes to the unsuffixed key', one(uberJar(ECO_ORG))?.key === 'UBER_WEB_COOKIE');
check('…the egari org goes to the suffixed key', one(uberJar(EGA_ORG))?.key === 'UBER_WEB_COOKIE_EGARI');
check('…and an org matching neither is refused',
  one(uberJar('00000000-0000-0000-0000-000000000000'))?.ok === false);
check('an Uber jar keeps the WHOLE jar, not just the one cookie that named it',
  one(uberJar(ECO_ORG)).value.includes('marketing_vistor_id='));

check('a Yandex jar is Yango', one(yangoJar)?.key === 'YANGO_COOKIE');
check('…and reports which account it is', one(yangoJar)?.account === 'muzammil16075');

check('a cookie jar with neither marker is not claimed', recognise('a=1; b=2; c=3').length === 0);
check('prose is not a credential', recognise('here are the tokens for you').length === 0);

/* ── several at once, which is how they actually arrive ─────────────────── */
const paste = [boltTok(173999), 'Bolt', uberJar(ECO_ORG), 'Uber Ecosine',
  uberJar(EGA_ORG), 'Uber Egari', yangoJar, 'Yango Ecosine'].join('\n\n');
const many = recognise(paste);
check('four credentials in one paste are all found', many.length === 4, `${many.length}`);
check('…each on its own key', new Set(many.map((f) => f.key)).size === 4, many.map((f) => f.key).join(','));
check('…and the labels between them change nothing',
  many.map((f) => f.key).sort().join(',')
  === 'BOLT_REFRESH_TOKEN_ECOSINE,UBER_WEB_COOKIE,UBER_WEB_COOKIE_EGARI,YANGO_COOKIE');
check('a label on its own is not mistaken for a block', splitBlocks('Bolt').length === 0);

/* Two cookies for the same org means one is stale and nothing here can tell
   which, so neither is applied. Resolving it silently is how the wrong one
   wins half the time. */
const dupe = recognise([uberJar(ECO_ORG), uberJar(ECO_ORG)].join('\n\n'));
check('the same key claimed twice refuses BOTH', dupe.length === 2 && dupe.every((f) => !f.ok));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
