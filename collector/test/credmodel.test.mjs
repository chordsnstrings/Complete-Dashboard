/* What the model is allowed to see, and allowed to decide.
   ─────────────────────────────────────────────────────────────────────────
   Two properties are worth a test each, because losing either turns a
   convenience into an incident:

     the silhouette must not carry the secret. A credential mailed to a third
     party to be identified is a credential that has been disclosed, and the
     whole reason this feature exists is that the operator is holding live
     provider sessions.

     a hallucinated key must not reach the store. The model names a key; the
     key is checked against the catalogue here, and against the real provider
     after that. Neither gate may be skipped.
*/
import { silhouette } from '../src/credmodel.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const SECRET = 'sUpErSeCrEtVaLuE0123456789';
const jar = `sid=QA.${SECRET}.sig; sp-jwt-session=eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.z; lang=en`;
const sil = silhouette(jar);
const asText = JSON.stringify(sil);

check('the silhouette does not carry the secret', !asText.includes(SECRET), asText.slice(0, 120));
check('…nor any cookie VALUE at all', !asText.includes('QA.'));
check('…but it does carry the cookie names, which are the signal',
  sil.cookie_names.includes('sp-jwt-session') && sil.cookie_names.includes('sid'));
check('it says what shape the block is', sil.looks_like === 'a cookie jar', sil.looks_like);
check('a bare JWT is described as one',
  silhouette('eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig').looks_like === 'a JWT');
check('a user:password pair is described as one',
  silhouette('ecosinetranspor:hunter2').looks_like === 'a user:password pair');
check('an opaque token is not mistaken for prose',
  silhouette('abcdefghijklmnopqrstuvwxyz0123').looks_like === 'an opaque token');
check('prose is prose', silhouette('here is the thing you asked for').looks_like === 'free text');
check('a URL is kept, because it names the provider',
  silhouette(`curl 'https://fleetownerportal.live.boltsvc.net/x' -b 'a=1'`).url
    === 'https://fleetownerportal.live.boltsvc.net');
check('the length is reported without the content', sil.length === jar.length);

/* The catalogue gate: proposeKeys drops any key SETTING_DEFS does not declare.
   Asserted on the source, because exercising it needs a model endpoint. */
import { readFileSync } from 'node:fs';
const src = readFileSync('src/credmodel.js', 'utf8');
check('a key the catalogue does not declare is dropped',
  /known\.has\(p\.key\) \? p\.key : null/.test(src));
check('…and a proposal with no surviving key is discarded',
  /\.filter\(\(p\) => p\.key\)/.test(src));
check('the model is only asked about what was NOT recognised',
  /proposeKeys\(leftovers\)/.test(readFileSync('api/server.js', 'utf8')));
check('a model proposal is still tested against the provider before it is stored',
  /const tested = await checkAll\(candidates\)/.test(readFileSync('api/server.js', 'utf8')));
/* The gate, asserted on ORDER rather than on one line of source.
   ─────────────────────────────────────────────────────────────────────────
   This used to pin the exact line `if (t.verdict !== 'pass' || !t.key)`, and
   broke the moment a credential arrived that resolves to more than one key —
   an Uber OAuth application writes its id, its secret and the organisation the
   grant revealed. The property that matters is not the shape of the condition:
   it is that no setSetting in this route is reachable without the verdict
   having been checked first. */
{
  const server = readFileSync('api/server.js', 'utf8');
  const start = server.indexOf("app.post('/api/settings/paste'");
  const body = server.slice(start, server.indexOf('\napp.', start + 10));
  /* `admit` rather than the literal condition: 'unknown' is now let through
     for a credential the OPERATOR labelled by name, for which no live check
     exists — refusing that made the labelled-credential route pointless, since
     such a key would be read correctly, routed correctly, reported as
     untestable and then silently not written. What must remain true is
     unchanged: the decision is made BEFORE any write, and 'fail' never
     passes. */
  const gate = body.indexOf('const admit =');
  const writes = [...body.matchAll(/await setSetting\(/g)].map((m) => m.index);
  check('nothing is stored unless the provider accepted it',
    gate > 0 && writes.length > 0 && writes.every((i) => i > gate),
    `gate at ${gate}, writes at ${writes.join(',')}`);
  check('…and the gate is a `continue`, so a refused candidate is skipped rather than caught later',
    /if \(!admit\) continue;/.test(body));
  check('…a passing verdict is admitted', /t\.verdict === 'pass'/.test(body));
  check('…an untestable one only when the operator named the key themselves',
    /t\.verdict === 'unknown' && t\.labelled === true/.test(body));
  /* The one that would be a security hole rather than an inconvenience. */
  check('…and a refused credential is never written on any branch',
    !/verdict === 'fail'/.test(body.slice(gate, writes[writes.length - 1])),
    'nothing between the gate and the last write may admit a fail');
}
/* The page must be able to SAY things.
   ─────────────────────────────────────────────────────────────────────────
   pastePanel declared `const note = el('span', 'note')`, which shadowed the
   imported note() helper for the whole function — so every message the paste
   page gives threw "note is not a function" rather than rendering, including
   the confirmation after a credential was successfully stored. Caught by
   driving the real page against production, not by any test here, so here is
   the test. */
{
  const ui = readFileSync('api/public/app.js', 'utf8');
  const start = ui.indexOf('function pastePanel(root) {');
  /* Comments stripped first — this one quotes the very declaration it is
     checking for, and a test that matches its own explanation is a test that
     can never pass. */
  const body = ui.slice(start, ui.indexOf('V.settings = async (root) => {'))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  check('the paste panel does not shadow the note() helper it calls',
    !/\bconst note\s*=/.test(body) && /out\.append\(note\(/.test(body),
    'a local `note` would make every message on this page throw');
}
check('the paste route never echoes a value back',
  !/value: t\.value/.test(readFileSync('api/server.js', 'utf8')));
check('a dry run is the default', /const apply = req\.body\?\.apply === true;/.test(readFileSync('api/server.js', 'utf8')));

/* A provider that cannot be reached says nothing about the credential. */
const chk = readFileSync('src/credcheck.js', 'utf8');
check('an unreachable provider is `unknown`, not a failed credential',
  /verdict: 'unknown'/.test(chk) && /unreachable\(e\)/.test(chk));
check('the check uses the CANDIDATE value, not the stored one',
  /cookie: value/.test(chk) && /refresh_token: value/.test(chk));
check('the Uber check is scoped to the org the credential itself declared',
  /orgId: \{ uuid: \{ value: org_uuid \} \}/.test(chk));
/* A check that picks its own endpoint tests its own choice. The Yango check
   asked a path the collector never calls and returned a false failure for a
   cookie that was working — which is worse than no check, because it sends an
   operator to re-capture a session that is fine. */
for (const [name, path] of [['Yango', '/api/reports-api/v1/orders/list']]) {
  check(`the ${name} check calls the endpoint the collector calls`, chk.includes(path));
}
check('…and that path is really the collector\'s',
  readFileSync('src/sources/yango.js', 'utf8').includes('/api/reports-api/v1/orders/list'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
