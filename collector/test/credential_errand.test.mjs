/* ── three ways to stop collecting, and only one of them is a replacement ───
   ──────────────────────────────────────────────────────────────────────────
   The operator sent a screenshot of the banner on 2026-09-07:

     "2 credentials stopped working — the surfaces behind them are collecting
      nothing until they are replaced
        Bolt · Ecosine  BOLT_CLIENT_ID — is not entitled to company_id 142868
        Yango · Ecosine YANGO_PARK_ID — HTTP 403; without a cookie: HTTP 401"

   Neither could be fixed by replacing anything.

     · BOLT_CLIENT_ID authenticates. It reads Egari's company 142897 and is
       refused Ecosine's 142868 with COMPANIES_NOT_ALLOWED. A new secret would
       carry exactly the same entitlement; somebody with Bolt portal access has
       to add the company. The detail line beside the headline SAID the secret
       was fine, so the banner contradicted itself in two lines.
     · Yango's console answers 403 with an HTML page from a CDN edge while
       every Yango API refusal is JSON, the park itself returns 200 and names
       ECOSINE TRANSPORTS LLC, and the same call answers 401 with the cookie
       removed. There is nothing to re-paste, and the park id it accused is
       proven correct by fleet-api.yango.tech on every run.

   api/auth_routes.js already had the idea, in `moved`: a state with the same
   severity as a dead credential and a different errand, added after days were
   spent re-pasting cookies when supplier.uber.com became fleethub.uber.com.
   This file holds down the other two, and the composition rule that decides
   which sentence a mixed set gets — because the first version of that rule
   printed the generic "replace them" lead for exactly the pair above, which is
   the only pair it was written for. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { noteCredential } from '../src/auth_state.js';
import { authRoutes, ERRANDS } from '../api/auth_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
authRoutes(app, { q, wrap });
const server = app.listen(0);
const auth = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/auth`)).json();

/* ══ 1. the vocabulary, and that every word in it is describable ═════════ */
console.log('\nevery state that stops collection names an errand');
{
  const src = readFileSync('api/auth_routes.js', 'utf8');
  const sev = src.slice(src.indexOf('const SEVERITY_OF'), src.indexOf('export const ERRANDS'));
  const stopping = [...sev.matchAll(/^\s{2}(\w+): 'stopped'/gm)].map((m) => m[1]);
  check('more than one state stops collection', stopping.length >= 3, stopping.join(', '));
  /* The errand table is what turns a severity into an instruction. A stopped
     state missing from it is described to the operator as a replacement,
     which for two of the three is the wrong afternoon's work. */
  const undescribed = stopping.filter((s) => !ERRANDS[s] && s !== 'invalid' && s !== 'expired');
  check('…and each one that is NOT a dead credential has a written errand',
    undescribed.length === 0, undescribed.join(', '));
  for (const [state, e] of Object.entries(ERRANDS)) {
    check(`  ${state}: says what it is and what to do about it`,
      typeof e.whole === 'function' && typeof e.part === 'function'
      && e.whole(1).length > 60 && e.whole(2).length > 60 && e.part(2).length > 20
      && !!e.noun);
  }
}

/* ══ 2. the two states, end to end, at the sizes production had ═════════ */
console.log('\nthe operator\'s two rows, as the API describes them');
await noteCredential(db, {
  provider: 'bolt', fleet: 'ecosine', credential: 'BOLT_CLIENT_ID', state: 'unentitled',
  surface: 'fleet-integration getDrivers',
  detail: 'BOLT_CLIENT_ID is not entitled to company_id 142868 (ecosine): NOT_AUTHORIZED '
    + 'hint=COMPANIES_NOT_ALLOWED. The same token read 142897 (egari), so the secret is fine.',
});
await noteCredential(db, {
  provider: 'yango', fleet: 'ecosine', credential: 'YANGO_CONSOLE', state: 'blocked',
  surface: '/api/reports-api/v2/summary/drivers/list',
  detail: 'fleet.yango.com HTTP 403; without a cookie: HTTP 401.',
});
{
  const d = await auth();
  check('both are stopped — the severity is honestly the same as a dead credential',
    d.stopped === 2, JSON.stringify({ stopped: d.stopped, at_risk: d.at_risk }));
  check('…and neither is amber, which an unknown state would have made them',
    (d.rows || []).every((r) => r.severity === 'stopped'),
    JSON.stringify((d.rows || []).map((r) => [r.credential, r.severity])));
  check('the two errands are counted apart', d.unentitled === 1 && d.blocked === 1,
    JSON.stringify({ u: d.unentitled, b: d.blocked }));
  check('…and listed, so a caller can compose its own sentence',
    (d.errands || []).length === 2
    && (d.errands || []).every((e) => e.count === 1 && e.rows.length === 1 && e.noun),
    JSON.stringify(d.errands));

  /* THE SENTENCE. This is the assertion the screenshot is about: with two
     DIFFERENT non-replaceable errands the headline must not fall back to
     "until they are replaced", which is the one instruction that cannot work
     for either of them. */
  check('the headline does not tell anybody to replace either of them',
    !/replaced/.test(d.headline || ''), d.headline);
  check('…and names both errands',
    /permission to grant/.test(d.headline) && /in front of the API/.test(d.headline),
    d.headline);
  check('…while still naming the two credentials, so it can be acted on',
    /BOLT_CLIENT_ID/.test(d.headline) && /YANGO_CONSOLE/.test(d.headline), d.headline);
}

/* ══ 3. and a genuine dead credential still says so ═════════════════════ */
console.log('\nand a credential that really has stopped is still described as one');
await noteCredential(db, {
  provider: 'uber', fleet: 'egari', credential: 'UBER_WEB_COOKIE_EGARI', state: 'expired',
  surface: 'supplier graphql', detail: 'redirected to auth.uber.com',
});
{
  const d = await auth();
  check('a mixed set leads with the replacement, which is true of the one that is',
    /stopped working/.test(d.headline) && /replaced/.test(d.headline), d.headline);
  check('…and still names the two that are not, rather than sweeping them in',
    /permission to grant/.test(d.headline) && /in front of the API/.test(d.headline), d.headline);
  check('three stopped, one of them replaceable', d.stopped === 3);
}
/* The whole-set case, which is what makes the mixed rule above meaningful. */
await q(`DELETE FROM credential_state WHERE credential = 'YANGO_CONSOLE'`);
await q(`DELETE FROM credential_state WHERE credential = 'UBER_WEB_COOKIE_EGARI'`);
{
  const d = await auth();
  check('one errand covering every stopped row gets its own sentence, not the generic one',
    !/stopped working/.test(d.headline) && /not permitted/.test(d.headline), d.headline);
  check('…in the singular, because there is one of them',
    !/credentials are/.test(d.headline), d.headline);
}

/* ══ 4. the page composes the same claims from the same names ═══════════ */
console.log('\nand the banner draws from the same vocabulary, not a second copy');
{
  const ui = readFileSync('api/public/app.js', 'utf8');
  const HEAD = ui.slice(ui.indexOf('const ERRAND_HEAD'), ui.indexOf('async function authBanner'));
  for (const state of Object.keys(ERRANDS)) {
    check(`  the banner has a line for ${state}`, new RegExp(`\\b${state}:`).test(HEAD));
  }
  /* Singular and plural both written. countOf() emits "1 call" and a clause
     written plural-only produced "1 call are being refused". */
  check('every line is written for one row and for several',
    (HEAD.match(/one:/g) || []).length === Object.keys(ERRANDS).length
    && (HEAD.match(/many:/g) || []).length === Object.keys(ERRANDS).length,
    HEAD.match(/(one|many):/g)?.join(' '));
  /* And the errands are derived from the rows the page already has, so a
     browser holding this file against an older API still says the right
     thing rather than silently reverting to "replace them". */
  check('the page derives the errands from the rows, not only from the API field',
    /const errandsOf = \(rows\)/.test(ui) && /rows\.filter\(\(r\) => r\.state === state\)/.test(ui),
    'reading d.errands alone makes an older API silently produce the wrong instruction');
  check('…and the generic lead is used only when some row really is a dead credential',
    /covered === stopped\.length/.test(ui),
    'two different non-replaceable errands is exactly the case the operator reported');
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
