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
import { jwtPayload, cookieMap, cookieText, recognise, splitBlocks, unrecognised, deCmd, curlUrl } from '../src/credkit.js';

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

/* ── a curl command, which is what is actually on the clipboard ──────────
   Nobody copies a cookie jar. They open devtools, right-click the request and
   choose "Copy as cURL", and what lands is a whole command with the jar
   buried in a `-b` flag. On Windows that command is cmd-escaped, and the
   escaping is aggressive enough that the jar is not a cookie jar any more:
   every quote is `^"`, every `%` is `^%^`, every `$` is `^$`, and the lines
   are joined by a bare trailing `^`.

   Both forms have to land on the same credential, because the operator has no
   way to know which one their browser gave them. */
const posix = (jar) => `curl 'https://supplier.uber.com/chronicle/graphql' \\
  -H 'accept: */*' \\
  -b '${jar}' \\
  -H 'origin: https://supplier.uber.com'`;

/* Escaped exactly as cmd.exe requires, built here rather than pasted so the
   fixture stays synthetic. */
const cmdEsc = (v) => String(v).replace(/[%$"{}!^]/g, (c) => (c === '%' ? '^%^' : `^${c}`));
const wincurl = (jar) => `curl --url ^"https://supplier.uber.com/chronicle/graphql^" ^
  -H ^"accept: */*^" ^
  -b ^"${cmdEsc(jar)}^" ^
  -H ^"origin: https://supplier.uber.com^"`;

const ecoJar = uberJar(ECO_ORG);

check('a POSIX curl yields the jar and nothing else',
  cookieText(posix(ecoJar)) === ecoJar, cookieText(posix(ecoJar)).slice(0, 60));
check('…and the flags around it are not swept in',
  !/-H|--url|curl /.test(cookieText(posix(ecoJar))));

/* The escaping is not cosmetic: a value carrying `%` or `$` comes back wrong
   if the carets are stripped by a rule that does not understand `^%^`. */
const trapped = `${ecoJar}; utag_main__ss=0%3Bexp-session; _ga_X=GS2.1$o5$g0`;
check('a Windows curl unescapes to exactly the same jar',
  cookieText(wincurl(trapped)) === trapped, cookieText(wincurl(trapped)).slice(-70));
check('…so a percent-encoded value survives',
  cookieMap(cookieText(wincurl(trapped))).utag_main__ss === '0%3Bexp-session');
check('…and a dollar sign survives',
  cookieMap(cookieText(wincurl(trapped)))._ga_X === 'GS2.1$o5$g0');
check('no caret is left anywhere in the jar',
  !cookieText(wincurl(trapped)).includes('^'));

check('the url the curl was calling is read back',
  curlUrl(wincurl(ecoJar)) === 'https://supplier.uber.com/chronicle/graphql', curlUrl(wincurl(ecoJar)));
check('…from the POSIX form too',
  curlUrl(posix(ecoJar)) === 'https://supplier.uber.com/chronicle/graphql');

/* deCmd is a no-op on anything that is not cmd-escaped, so a jar pasted on
   its own — the original supported form — cannot be damaged by it. */
check('a bare jar passes through deCmd untouched', deCmd(ecoJar) === ecoJar);
check('…and a POSIX curl does too', deCmd(posix(ecoJar)) === posix(ecoJar));
/* A caret that was DATA is written `^^` by cmd, and must come back as one
   caret — but only inside text that is cmd-escaped at all. A bare jar that
   happens to contain `^^` is not cmd output and is left exactly as it is,
   which is why deCmd looks for `^"` before touching anything. */
check('a literal caret inside a cmd-escaped command comes back as one',
  deCmd('-b ^"a=1^^2^"') === '-b "a=1^2"', deCmd('-b ^"a=1^^2^"'));
check('…while the same sequence in a bare jar is left alone',
  deCmd('a=1^^2') === 'a=1^^2');

/* The point of all of it: the same credential, recognised, on the same key. */
for (const [name, cmd] of [['POSIX', posix(ecoJar)], ['Windows', wincurl(ecoJar)]]) {
  const f = recognise(cmd);
  check(`a ${name} curl is recognised as one credential`, f.length === 1, String(f.length));
  check(`…named by the org inside it, not by the paste`, f[0]?.key === 'UBER_WEB_COOKIE',
    String(f[0]?.key));
  check(`…on the fleet that org belongs to`, f[0]?.fleet === 'ecosine', String(f[0]?.fleet));
  check(`…storing the jar, not the command`,
    f[0]?.value === ecoJar, String(f[0]?.value).slice(0, 50));
}

/* And once it IS recognised, it must not also be handed to the model as
   something nothing understood — the de-escaped value never appears
   literally in the escaped text, which is exactly how that regression
   happens. */
check('a recognised Windows curl leaves nothing for the model',
  unrecognised(wincurl(ecoJar)).length === 0);
check('…while genuinely unknown text is still passed along',
  unrecognised('SOME_UNKNOWN_TOKEN_' + 'z'.repeat(40)).length === 1);

/* Two fleets, two curls, one paste — the shape an operator actually sends. */
const both = recognise([wincurl(ecoJar), 'Ecosine', posix(uberJar(EGA_ORG)), 'Egari'].join('\n\n'));
check('two curls in one paste land on two different keys',
  both.length === 2 && new Set(both.map((f) => f.key)).size === 2,
  both.map((f) => f.key).join(','));
check('…mixing the two curl dialects freely',
  both.map((f) => f.key).sort().join(',') === 'UBER_WEB_COOKIE,UBER_WEB_COOKIE_EGARI');

/* ── an OAuth application: two strings that mean nothing apart ─────────── */
/* The one credential here that carries no identity of its own.
   ─────────────────────────────────────────────────────────────────────────
   A Bolt token declares its fleet owner and an Uber cookie declares its org,
   so those are recognised exactly and this file can assert the key. An OAuth
   application declares nothing: two opaque base64-ish strings whose id and
   secret are not reliably told apart by length — this fleet's own two clients
   are 32/115 and 32/40 characters.

   So the assertion that matters here is the opposite of the one above: that
   the recogniser REFUSES to name the key, and hands both strings to the live
   check, which performs the grant and asks Uber which organisation the
   application reaches. The alternative — guessing — writes an Ecosine client
   into Egari's slot, which is the failure this whole module exists to
   prevent, arriving through the one door that had no lock on it. */
const APP_ID = 'Xq7bT2mKp9RvZ4nLc6HdWs1YgJf3AeUo';                     // 32, the shape Uber issues
const APP_SECRET = 'Nb4tG8yQ_wR2zP7mVc5XkD3sLj9HfAeU6TnQ1oZi';  // 40, longer than its id
const oauthOf = (text) => recognise(text).filter((f) => f.kind === 'oauth');

{
  const labelled = oauthOf(`uber egari client secret : ${APP_SECRET}\nuber egari application id : ${APP_ID}`);
  check('an application id and its secret are read as ONE credential, not two',
    labelled.length === 1, String(labelled.length));
  check('and the labels decide which string is which',
    labelled[0]?.value === APP_ID && labelled[0]?.secret === APP_SECRET,
    `${labelled[0]?.value} / ${labelled[0]?.secret}`);
  check('it reaches the live check without a key, because the key is what the check answers',
    labelled[0]?.key === null && labelled[0]?.ok === true,
    JSON.stringify([labelled[0]?.key, labelled[0]?.ok]));
  check('a fleet named in the paste is carried as a claim, not as the answer',
    labelled[0]?.said_fleet === 'egari' && labelled[0]?.fleet === 'egari');
}

{
  /* No labels at all. The recogniser prefers the shorter string as the id
     because Uber's is 32 characters, and the check tries the other way round
     if that grant fails — so being wrong here costs one refused request. */
  const bare = oauthOf(`${APP_SECRET}\n${APP_ID}`);
  check('an unlabelled pair is still read as one credential', bare.length === 1);
  check('…with the 32-character half preferred as the id',
    bare[0]?.value === APP_ID && bare[0]?.secret === APP_SECRET);
  check('…and no fleet claimed, because nothing in the paste said one',
    bare[0]?.fleet === null && bare[0]?.said_fleet === null);
}

check('a pair separated by a blank line is one credential, not two blocks of nothing',
  oauthOf(`${APP_ID}\n\n${APP_SECRET}`).length === 1);
check('prose around it does not stop it being read',
  oauthOf(`Hi — Uber creds for Egari.\napplication id : ${APP_ID}\nclient secret : ${APP_SECRET}\nThanks!`).length === 1);

/* Declining is the important half, and these are the ways it must decline. */
check('one opaque string on its own is not an application',
  oauthOf(APP_ID).length === 0);
check('three of them are not an application either — a pair is exactly two',
  oauthOf(`${APP_ID}\n${APP_SECRET}\nTz5xW8qN2mB6vC4kR7jH9gF1dS3aL0pE`).length === 0);
check('a cookie jar is not an application, however many opaque values it holds',
  oauthOf(ecoJar).length === 0);
check('and neither is a Bolt JWT',
  oauthOf(jwt({ fleet_owner_id: 173999, exp: EXP })).length === 0);
/* A supplier jar is recognised as a cookie by the recogniser above it, and
   the loop breaks at the first hit — so the pair recogniser must not claim it
   through the whole-text fallback either. */
check('a paste that IS a supplier cookie stays a supplier cookie',
  recognise(posix(ecoJar)).every((f) => f.kind !== 'oauth'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
