/* A paste that verifies and then refuses to save.
   ═══════════════════════════════════════════════════════════════════════════
   Reported from the Settings page in as many words: "This is bolt, but on
   settings page where we paste it, it doesn't get added immediately."

   The Settings paste is two steps by design — read the credential, show what
   it is and whether it works, then apply. Every check in src/credcheck.js is a
   READ, which is what makes running one twice harmless. Bolt's was not. The
   portal's getAccessToken ROTATES the refresh token and invalidates the one
   presented (src/sources/bolt.js:201-217 says so, and persists the successor
   for exactly this reason); checkBolt called the same endpoint and kept only
   `access_token`. So:

     press Read   → "pass", and the pasted token is now spent
     press Apply  → the same value goes back to the portal, which answers with
                    the jti of the token that superseded it, the verdict is
                    'fail', and nothing is written

   The operator sees a credential that verified a second ago refuse to save,
   and the advice on screen is to capture another one — which is spent the same
   way, forever. Two properties close it, and both are asserted here against a
   portal that behaves the way the real one does: single-use tokens, a
   successor in the response, and the superseded token's jti in the error.

   No real credential is used. The tokens below are unsigned JWTs built here. */
import express from 'express';
import { config } from '../src/config.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (jti) => `${b64({ alg: 'HS256', typ: 'JWT' })}.`
  + `${b64({ data: { type: 'base', fleet_owner_id: 173999, jti }, iat: 1787229731,
    exp: Math.floor(Date.now() / 1000) + 7 * 86400 })}.sig`;

const FIRST = token('11111111-1111-4111-8111-111111111111');
const SECOND = token('22222222-2222-4222-8222-222222222222');
const THIRD = token('33333333-3333-4333-8333-333333333333');

/* A portal with the real one's manners: a refresh token works exactly once,
   the response carries its successor, and presenting a spent token names the
   token that replaced it. */
const chain = new Map([[FIRST, SECOND], [SECOND, THIRD]]);
const usedBy = new Map();
let exchanges = 0;
const app = express();
app.use(express.json({ limit: '1mb' }));
app.post('/getAccessToken', (req, res) => {
  exchanges++;
  const rt = req.body?.refresh_token;
  if (usedBy.has(rt)) {
    return res.json({ message: 'REFRESH_TOKEN_INVALID', code: 503,
      error_hint: JSON.parse(Buffer.from(usedBy.get(rt).split('.')[1], 'base64url')).data.jti });
  }
  const next = chain.get(rt);
  if (!next) return res.json({ message: 'REFRESH_TOKEN_INVALID', code: 503, error_hint: 'Invalid refresh token' });
  usedBy.set(rt, next);
  res.json({ data: { access_token: `at-for-${next.slice(-6)}`, refresh_token: next } });
});
const server = app.listen(0);
const port = server.address().port;

/* `config.bolt` is a getter that hardcodes the real portal, so the stub is
   installed by redefining the accessor rather than assigning through it.
   checkBolt reads `config.bolt` INSIDE the function, which is what makes this
   work at all — and is the property worth having: a check that captured its
   endpoint at import time could not be pointed at a fixture, and the only way
   left to test it would be against the live portal, spending real tokens. */
const realBolt = config.bolt;
Object.defineProperty(config, 'bolt', {
  configurable: true,
  get: () => ({ ...realBolt, portalBase: `http://127.0.0.1:${port}`,
    companies: [{ fleet: 'ecosine', companyId: 99001, userId: 173999 }] }),
});

const { checkCandidate } = await import('../src/credcheck.js');
const paste = (value) => ({ ok: true, provider: 'Bolt', key: 'BOLT_REFRESH_TOKEN_ECOSINE',
  fleet: 'ecosine', value });

console.log('\nthe two clicks the Settings page actually makes');

/* CLICK ONE — the dry run. */
const read = await checkCandidate(paste(FIRST));
check('a fresh token verifies', read.verdict === 'pass', JSON.stringify([read.verdict, read.detail]));
/* THE FIX. The value that gets written is the successor, not the paste — the
   paste is spent the moment it is verified. */
check('…and what it offers to store is the ROTATED token, not the spent paste',
  read.keys?.BOLT_REFRESH_TOKEN_ECOSINE === SECOND,
  JSON.stringify(Object.keys(read.keys || {})));
check('…under the key that fleet’s collector reads',
  Object.keys(read.keys || {}).join() === 'BOLT_REFRESH_TOKEN_ECOSINE',
  JSON.stringify(read.keys && Object.keys(read.keys)));
check('…and it says the rotation happened rather than reporting a plain pass',
  /rotat/i.test(read.detail || ''), read.detail);

/* CLICK TWO — Apply, seconds later, presenting the same value. This is the
   click that used to fail. */
const before = exchanges;
const applyStep = await checkCandidate(paste(FIRST));
check('pressing Apply on the same paste still passes',
  applyStep.verdict === 'pass', JSON.stringify([applyStep.verdict, applyStep.detail]));
check('…and still names the successor, so the write lands on a live token',
  applyStep.keys?.BOLT_REFRESH_TOKEN_ECOSINE === SECOND,
  JSON.stringify(applyStep.keys));
/* And it does NOT go back to the portal. A second exchange would spend the
   successor too, which is the same bug one step along. */
check('…without spending another token to find out',
  exchanges === before, `${exchanges - before} extra exchanges`);
check('…and says why it did not ask again',
  /already exchanged/i.test(applyStep.detail || ''), applyStep.detail);

console.log('\nand a token that is genuinely dead still reads as dead');

/* A token this portal has never issued: a broken signature, not a rotation. */
const junk = await checkCandidate(paste(token('99999999-9999-4999-8999-999999999999')));
check('an unknown token fails', junk.verdict === 'fail', JSON.stringify([junk.verdict, junk.detail]));
check('…and nothing is offered for storage', !junk.keys, JSON.stringify(junk.keys));
/* The portal's own words are the difference between "capture a new one" and
   "something already used this one", and they were being flattened away. */
check('…with the portal’s own hint carried through',
  /Invalid refresh token/.test(junk.detail || ''), junk.detail);

/* A token spent by somebody else — the collector's own run, say — is a
   DIFFERENT failure, and the portal says so by naming its successor. */
usedBy.set(SECOND, THIRD);
const superseded = await checkCandidate(paste(SECOND));
check('a token spent elsewhere fails rather than being silently accepted',
  superseded.verdict === 'fail', JSON.stringify([superseded.verdict, superseded.detail]));
check('…and the detail carries the jti of whatever superseded it',
  /3333/.test(superseded.detail || ''), superseded.detail);

server.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
