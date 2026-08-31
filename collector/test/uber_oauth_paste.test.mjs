/* An OAuth application, pasted — and the question nothing else here has to ask.
   ─────────────────────────────────────────────────────────────────────────
   Every other credential in this product arrives already named. A Bolt token
   carries its fleet owner id; an Uber supplier cookie carries its org uuid. So
   src/credkit.js decodes them, names the key exactly, and the live check merely
   confirms the credential still works.

   An OAuth application carries nothing. It is two opaque base64-ish strings,
   and this fleet's own two clients are 32/115 and 32/40 characters — so which
   one is the id is not answerable by looking, and neither is which business it
   belongs to. Guessing writes an Ecosine client into Egari's slot, and Uber
   then answers 403 to every REST call for a reason no page can explain. That
   failure is not hypothetical: this fleet ran for months with one client pair
   shared by two businesses, and the second business collected nothing.

   So the recogniser refuses to name it and the CHECK does the asking: grant a
   token, ask which organisations the application reaches, and let the answer
   name the fleet. This file drives that against a stub Uber, because the
   branches that decide which fleet gets written are the ones worth pinning.

   Three keys come back, not one. An application without the organisation it is
   registered under is two thirds of a working configuration and fails exactly
   like a broken one — which is the state this fleet was actually left in when
   a correct new client was installed beside a stale org id. */
import express from 'express';
import { readFileSync } from 'node:fs';
import { recognise } from '../src/credkit.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const ID = 'Xq7bT2mKp9RvZ4nLc6HdWs1YgJf3AeUo';
const SECRET = 'Nb4tG8yQ_wR2zP7mVc5XkD3sLj9HfAeU6TnQ1oZi';
const EGARI_ORG = 'ENCRYPTED_EGARI_ORG_ID_' + 'a'.repeat(40);
const ECO_ORG = 'ENCRYPTED_ECOSINE_ORG_ID_' + 'b'.repeat(40);

/* A stub Uber: it grants a token for exactly one (id, secret) ordering, and
   answers /orgs with whatever the test asked it to. */
let ORGS = [];
let GRANTS = 0;
const app = express();
app.use(express.urlencoded({ extended: false }));
app.post('/oauth/v2/token', (req, res) => {
  GRANTS++;
  if (req.body.client_id !== ID) {
    return res.status(401).json({ error: 'invalid_client', error_description: 'client ID is invalid' });
  }
  if (req.body.client_secret !== SECRET) {
    return res.status(403).json({ error: 'access_denied', error_description: 'AccessDenied: client secret mismatch' });
  }
  res.json({ access_token: 'stub-token', expires_in: 2592000 });
});
app.get('/v1/vehicle-suppliers/orgs', (req, res) => {
  if (req.get('authorization') !== 'Bearer stub-token') return res.status(401).json({ error: 'no' });
  res.json({ organizations: ORGS });
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

/* The two URLs are settings precisely so a Test-environment application can be
   pointed at the environment it was registered in — which is what makes this
   testable without reaching Uber. */
process.env.UBER_TOKEN_URL = `${base}/oauth/v2/token`;
process.env.UBER_ORGS_URL = `${base}/v1/vehicle-suppliers/orgs`;
process.env.UBER_ORG_ENCRYPTED = ECO_ORG;
process.env.UBER_ORG_ENCRYPTED_EGARI = EGARI_ORG;
process.env.UBER_ORG_UUID = '58ca3b81-4953-4793-9f56-d93e16f771bb';
process.env.UBER_ORG_UUID_EGARI = 'b2004b53-8175-4706-ab0a-c8b60e586c7c';

const { checkAll } = await import('../src/credcheck.js');
const run = async (text) => {
  const found = recognise(text).filter((f) => f.kind === 'oauth');
  if (!found.length) return null;
  const [t] = await checkAll(found.map((f) => ({ ...f, source: 'recognised' })));
  return t;
};

console.log('\nthe grant is what names the fleet');
ORGS = [{ id: EGARI_ORG, name: 'Egari Luxury Cars Transport LLC' }];
{
  const t = await run(`uber egari client secret : ${SECRET}\nuber egari application id : ${ID}`);
  check('a working application is accepted', t.verdict === 'pass', JSON.stringify(t?.detail));
  check('the fleet comes from the organisation it reaches', t.fleet === 'egari', String(t.fleet));
  check('three keys are written, not one',
    Object.keys(t.keys || {}).sort().join(',')
    === 'UBER_CLIENT_ID_EGARI,UBER_CLIENT_SECRET_EGARI,UBER_ORG_ENCRYPTED_EGARI',
    Object.keys(t.keys || {}).join(','));
  check('the id and the secret land the right way round',
    t.keys.UBER_CLIENT_ID_EGARI === ID && t.keys.UBER_CLIENT_SECRET_EGARI === SECRET);
  /* The one that was actually missing in production: a correct new client
     installed beside the previous application's org id, 403ing on every call. */
  check('and the organisation comes from the grant, not from what was already stored',
    t.keys.UBER_ORG_ENCRYPTED_EGARI === EGARI_ORG);
  check('the operator is told which business it turned out to be',
    /Egari Luxury Cars Transport LLC/.test(t.detail), t.detail);
}

console.log('\nwhich string is which is answered by trying, not by guessing');
{
  GRANTS = 0;
  const t = await run(`${ID}\n${SECRET}`);
  check('an unlabelled pair still resolves', t.verdict === 'pass', t.detail);
  check('…and took one grant, because the shorter half is preferred as the id', GRANTS === 1, String(GRANTS));
  GRANTS = 0;
  /* Reversed AND mislabelled: the preference is wrong here and the swap is
     what saves it. A recogniser that trusted the label would fail this. */
  const u = await run(`client secret: ${ID}\napplication id: ${SECRET}`);
  check('a pair labelled backwards is still accepted, by trying the other way round',
    u.verdict === 'pass', u.detail);
  check('…which costs exactly one extra grant', GRANTS === 2, String(GRANTS));
  check('and the keys still land the right way round',
    u.keys.UBER_CLIENT_ID_EGARI === ID && u.keys.UBER_CLIENT_SECRET_EGARI === SECRET);
}

console.log('\nand every way it must refuse');
{
  const t = await run(`application id: ${ID}\nclient secret: ${'x'.repeat(40)}`);
  check('a wrong secret is refused', t.verdict === 'fail', t.detail);
  check('…in Uber’s own words, not ours', /client secret mismatch/.test(t.detail), t.detail);
  check('and nothing is offered to write', !t.keys);
}
{
  /* The failure this module exists to prevent, arriving through the new door:
     a paste that says one business while the application belongs to another. */
  const t = await run(`uber ecosine application id: ${ID}\nuber ecosine client secret: ${SECRET}`);
  check('a paste labelled with the WRONG fleet is refused rather than corrected',
    t.verdict === 'fail', t.detail);
  check('…and says both what was claimed and what Uber answered',
    /ecosine/.test(t.detail) && /Egari Luxury Cars/.test(t.detail), t.detail);
  check('and writes nothing', !t.keys);
}
{
  ORGS = [];
  const t = await run(`application id: ${ID}\nclient secret: ${SECRET}`);
  check('an application that authenticates but reaches no org is refused',
    t.verdict === 'fail', t.detail);
  check('…and says that is what happened, which is a different errand from a bad secret',
    /not been granted access/.test(t.detail), t.detail);
}
{
  ORGS = [{ id: EGARI_ORG, name: 'Egari Luxury Cars Transport LLC' },
    { id: ECO_ORG, name: 'ECOSINE TRANSPORTS' }];
  const t = await run(`application id: ${ID}\nclient secret: ${SECRET}`);
  check('an application reaching two businesses cannot be filed against one fleet',
    t.verdict === 'fail', t.detail);
  check('…and names them both', /Egari/.test(t.detail) && /ECOSINE/.test(t.detail), t.detail);
}
{
  ORGS = [{ id: 'SOMETHING_ELSE', name: 'Third Business FZ-LLC' }];
  const t = await run(`application id: ${ID}\nclient secret: ${SECRET}`);
  check('an org matching neither fleet is reported, not guessed at',
    t.verdict === 'fail' && /Third Business/.test(t.detail), t.detail);
}
{
  /* Name-matching is the fallback when the stored org id is the stale one —
     which is exactly the state a new application is pasted to fix. */
  ORGS = [{ id: 'A_BRAND_NEW_ORG_ID_' + 'c'.repeat(40), name: 'Egari Luxury Cars Transport LLC' }];
  const t = await run(`application id: ${ID}\nclient secret: ${SECRET}`);
  check('a NEW org id is still filed to the right fleet, by the name Uber calls it',
    t.verdict === 'pass' && t.fleet === 'egari', t.detail);
  check('…and that new org id is what gets stored',
    t.keys.UBER_ORG_ENCRYPTED_EGARI === ORGS[0].id, t.keys?.UBER_ORG_ENCRYPTED_EGARI);
  check('and the reason names the organisation rather than claiming a match',
    /Uber calls this organisation/.test(t.detail), t.detail);
}

console.log('\nit is routed to the right check');
{
  /* provider is 'Uber' for both a supplier cookie and an application, and the
     cookie check would test this against a reports endpoint and fail it. */
  ORGS = [{ id: EGARI_ORG, name: 'Egari Luxury Cars Transport LLC' }];
  const t = await run(`application id: ${ID}\nclient secret: ${SECRET}`);
  check('an application is not sent to the supplier-cookie check',
    t.verdict === 'pass' && !/report/i.test(t.detail || ''), t.detail);
}

console.log('\nthe per-fleet suffix is resolved, never invented');
/* The defect this section exists for: `UBER_CLIENT_ID_${fleet.toUpperCase()}`
   is right for Egari and wrong for Ecosine, whose keys are the BARE names.
   There is no UBER_CLIENT_ID_ECOSINE, src/config.js never reads one, and
   setSetting throws on a key the catalogue does not declare — so an Ecosine
   application would have passed its grant, told the operator the provider
   accepted it, and then 500'd on write. */
{
  const { keyFor } = await import('../src/credkit.js');
  const { SETTING_DEFS } = await import('../src/settings.js');
  const KNOWN = new Set(SETTING_DEFS.map((d) => d.key));
  check('ecosine\u2019s Uber application keys are the bare ones',
    keyFor('UBER_CLIENT_ID', 'ecosine') === 'UBER_CLIENT_ID'
    && keyFor('UBER_ORG_ENCRYPTED', 'ecosine') === 'UBER_ORG_ENCRYPTED');
  check('\u2026and egari\u2019s are suffixed',
    keyFor('UBER_CLIENT_ID', 'egari') === 'UBER_CLIENT_ID_EGARI'
    && keyFor('UBER_ORG_ENCRYPTED', 'egari') === 'UBER_ORG_ENCRYPTED_EGARI');
  check('there is no _ECOSINE variant to write to, which is why appending one throws',
    !KNOWN.has('UBER_CLIENT_ID_ECOSINE') && !KNOWN.has('UBER_ORG_ENCRYPTED_ECOSINE'));

  ORGS = [{ id: ECO_ORG, name: 'ECOSINE TRANSPORTS' }];
  const t = await run(`application id: ${ID}\nclient secret: ${SECRET}`);
  check('an ecosine application resolves to keys that exist',
    t.verdict === 'pass' && Object.keys(t.keys).every((k) => KNOWN.has(k)),
    Object.keys(t.keys || {}).join(','));
  check('\u2026which are the bare names, the ones the collector actually reads',
    Object.keys(t.keys).sort().join(',')
    === 'UBER_CLIENT_ID,UBER_CLIENT_SECRET,UBER_ORG_ENCRYPTED',
    Object.keys(t.keys).join(','));
}

console.log('\nand the secret is not handed to anyone to be identified');
/* `unrecognised()` is what the model is shown. It filtered on the candidate's
   `value`, and a pair keeps its second half in `secret` — so a live client
   secret was being sent off to be identified, and drawn on the page as a
   second, red row for a credential that had just been accepted. */
{
  const { unrecognised, recognise: rec } = await import('../src/credkit.js');
  check('nothing is left over from a pair on one line each',
    unrecognised(`application id: ${ID}\nclient secret: ${SECRET}`).length === 0);
  check('\u2026nor from one split by a blank line, which is the case that leaked',
    unrecognised(`${ID}\n\n${SECRET}`).length === 0);
  /* Two applications in one paste are two claims on the same three settings.
     Every other credential here refuses that; this one used to grant twice and
     let the second write win. */
  const two = rec(`egari application id: ${ID}\nclient secret: ${SECRET}\n\n`
    + `egari application id: Qw3eR5tY7uI9oP1aS2dF4gH6jK8lZ0xC\nclient secret: Mn2bV4cX6zL8kJ0hG5fD3sA1qW7eR9tY5uI3oP1a`);
  const pairs = two.filter((f) => f.kind === 'oauth');
  check('two applications in one paste are both refused, not silently ordered',
    pairs.length === 2 && pairs.every((f) => f.ok === false),
    JSON.stringify(pairs.map((f) => f.ok)));
  check('\u2026and neither is given a made-up key to show the operator',
    pairs.every((f) => f.key === null), JSON.stringify(pairs.map((f) => f.key)));
}

console.log('\nall three keys, or none');
{
  const server2 = readFileSync('api/server.js', 'utf8');
  const start = server2.indexOf("app.post('/api/settings/paste'");
  const body = server2.slice(start, server2.indexOf('\napp.', start + 10));
  const guard = body.indexOf('SETTING_DEFS.some');
  const write = body.indexOf('await setSetting(');
  check('the keys are checked against the catalogue before the first write',
    guard > 0 && write > guard, `guard ${guard}, write ${write}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
