/* The credential that carries no identity of its own.
   ─────────────────────────────────────────────────────────────────────────
   src/credkit.js opens by saying that FMS, CABMAN and Hotel credentials "carry
   no identity of their own and are the one case a human still has to label" —
   and then there was nowhere to put the label. Every recogniser matched on
   SHAPE, so an opaque string reached the operator as "this credential could
   not be named", and the only route in was to find the right one of thirty-four
   boxes by hand. That is the exact task the paste box exists to remove.

   It mattered most on Yango. The collector's own refusal now says to check
   YANGO_API_KEY when the cookie-free probe shows the session is not what is
   being rejected — an instruction the product could not carry out, because
   there was no way to paste one.

   And a second fault under it: checkCandidate routed on cand.provider, while
   checkYango tests a COOKIE — it puts cand.value into the cookie header. A
   YANGO_API_KEY sent through it would have been pasted into a cookie jar and
   reported as a dead session. */
import { recognise } from '../src/credkit.js';
import { checkCandidate } from '../src/credcheck.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const one = (t) => { const r = recognise(t); return Array.isArray(r) ? r[0] : r; };

console.log('\na credential the operator names is named');

{
  const c = one('YANGO_API_KEY=abc123def456');
  check('the key is read from the label', c?.key === 'YANGO_API_KEY', JSON.stringify(c));
  check('…and the value is what followed it', c?.value === 'abc123def456', c?.value);
  check('…and it is marked as taken at the operator’s word',
    c?.labelled === true, JSON.stringify(c));
  check('…and the reason says so rather than claiming to have recognised it',
    /taken at its word/.test(c?.why || ''), c?.why);
}

{
  check('a colon separates as well as an equals',
    one('HOTEL_TOKEN: eyJhbGciOiJIUzI1NiJ9.abc.def')?.key === 'HOTEL_TOKEN');
  check('and a shell export line is the same thing with a word in front',
    one('export CABMAN_ECOSINE_PASS=hunter2')?.key === 'CABMAN_ECOSINE_PASS');
  check('quotes around the value are not part of the value',
    one('YANGO_PARK_ID="park-99"')?.value === 'park-99');
}

console.log('\nand a name the product does not have is still declined');

{
  /* The whole point of the file this lives in: a credential it cannot name
     must reach a person rather than a best guess. A label is only evidence
     because it is matched against the catalogue — an invented name is not. */
  check('an invented key name is not accepted',
    !one('YANGO_SECRET_KEY=abc123def456')?.key, JSON.stringify(one('YANGO_SECRET_KEY=abc123def456')));
  check('and a bare opaque string is still unnamed',
    !one('abc123def456ghi789jkl012mno345')?.key);
}

console.log('\nand a credential that identifies itself is not relabelled');

{
  /* Order matters. An Uber jar pasted under the wrong name has to be read as
     the org it actually belongs to — the whole reason the shape recognisers
     exist is that "pasting the Egari cookie into UBER_WEB_COOKIE points the
     Ecosine collector at another org, and Uber answers happily". */
  const jar = 'sid=QA.abc; sp-jwt-session=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
    + Buffer.from(JSON.stringify({ data: { supplierOrgUUID: '58ca3b81-4953-4793-9f56-d93e16f771bb' } }))
      .toString('base64url') + '.sig';
  const c = one(jar);
  check('an Uber jar is read as Uber, not as whatever it was labelled',
    c?.provider === 'Uber', JSON.stringify(c && { p: c.provider, k: c.key }));
  check('…and the labelled recogniser did not claim it',
    c?.labelled !== true, JSON.stringify(c && { labelled: c.labelled }));
}

console.log('\nand the check that runs matches the credential, not the provider');

{
  /* checkYango would put this value in a cookie header. The assertion is that
     it does not run at all, and that the answer is "cannot test" rather than
     "broken" — an operator must not be told a good key is dead. */
  const r = await checkCandidate({ ok: true, ...one('YANGO_API_KEY=abc123def456') });
  check('an API key is not tested by the cookie check',
    r.verdict === 'unknown', JSON.stringify({ v: r.verdict, d: r.detail }));
  check('…and it says it could not test it, rather than that it failed',
    /no live check exists for YANGO_API_KEY/.test(r.detail || ''), r.detail);
  check('…and names what will test it instead',
    /tested by the next run/.test(r.detail || ''), r.detail);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
