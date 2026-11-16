/* Is each fleet's Uber API client approved for the per-driver cash block?
   ──────────────────────────────────────────────────────────────────────────
   The operator asked whether Uber has approved cash-block-action /
   query-cash-block-actions for us, checked through production (2026-11-16).
   src/probe.js's cashScopeCheck asks the token endpoint for each scope and
   nothing else. These checks pin what it may and may not do, against a fake
   token endpoint — no request leaves this machine:

     1. a refusal reads "no" with Uber's code, and keeps nothing;
     2. a grant reads "yes" only off the scope list the token came back with —
        a token issued WITHOUT the scope is "no", and one with no list is
        "unknown", never "yes";
     3. each scope is asked ALONE, by client_credentials, at the token URL, and
        no other URL is called;
     4. nothing in the record carries the token or the secret;
     5. a check that was issued a token forgets the process's cached grants
        (Uber does not say whether a new token retires older ones); a refused
        check forgets nothing;
     6. the nightly probe lists one cash-block surface per DISTINCT client.

   REVERSIONS (each run, each failing as named):
     · `granted` read off d.access_token alone → §2 "issued without" fails
     · both scopes joined into one request → §3 fails
     · `if (issued) forget()` removed → §5 "forgets" fails
     · askedClients dedupe removed → §6 "shared client asked once" fails     */

process.env.UBER_CLIENT_ID = 'shared-client-id';
process.env.UBER_CLIENT_SECRET = 'shared-client-not-a-real-secret';
process.env.UBER_ORG_ENCRYPTED = 'org-eco';
process.env.UBER_ORG_ENCRYPTED_EGARI = 'org-egari';
delete process.env.UBER_CLIENT_ID_EGARI; delete process.env.UBER_CLIENT_SECRET_EGARI;

const { cashScopeCheck, CASH_BLOCK_SCOPES, surfaces } = await import('../src/probe.js');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const TOKEN_URL = 'https://auth.example.test/oauth/v2/token';
const oauth = { clientId: 'cid-1', clientSecret: 'csecret-zzz' };

/* A fake token endpoint: `answer(scope)` decides what Uber says to each ask. */
function fakeUber(answer) {
  const calls = [];
  const httpImpl = async (url, opts) => {
    const p = new URLSearchParams(opts.body);
    calls.push({ url, method: opts.method, grant: p.get('grant_type'), scope: p.get('scope'),
      id: p.get('client_id'), secret: p.get('client_secret') });
    return answer(p.get('scope'));
  };
  return { calls, httpImpl };
}
let forgot = 0;
const forget = () => { forgot += 1; };

console.log('\n1. refused');
{
  forgot = 0;
  const u = fakeUber(() => ({ status: 400, ok: false, data: { error: 'invalid_scope' } }));
  const r = await cashScopeCheck(oauth, { httpImpl: u.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('both scopes read "no" with Uber\'s code', r.data.length === 2
    && r.data.every((x) => x.granted === 'no' && x.uber_said === 'invalid_scope'), JSON.stringify(r.data));
  check('…and the row records a provider that answered (status 200, not a failure)', r.status === 200);
}

console.log('\n2. granted — read off the scope list, never off "a token came back"');
{
  const yes = fakeUber((s) => ({ status: 200, ok: true, data: { access_token: 'tok-AAA', expires_in: 2592000, scope: `${s} other.scope` } }));
  const r = await cashScopeCheck(oauth, { httpImpl: yes.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('a token whose list carries the scope is "yes"', r.data.every((x) => x.granted === 'yes' && x.uber_said === 'granted'), JSON.stringify(r.data));
  const without = fakeUber(() => ({ status: 200, ok: true, data: { access_token: 'tok-BBB', scope: 'solutions.suppliers.metrics.read' } }));
  const r2 = await cashScopeCheck(oauth, { httpImpl: without.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('a token issued without the scope is "no", saying so', r2.data.every((x) => x.granted === 'no' && /issued without/.test(x.uber_said)), JSON.stringify(r2.data));
  const bare = fakeUber(() => ({ status: 200, ok: true, data: { access_token: 'tok-CCC' } }));
  const r3 = await cashScopeCheck(oauth, { httpImpl: bare.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('a token with no scope list is "unknown", never "yes"', r3.data.every((x) => x.granted === 'unknown'), JSON.stringify(r3.data));
  const boom = await cashScopeCheck(oauth, { httpImpl: async () => { throw new Error('ETIMEDOUT'); }, forget, tokenUrl: TOKEN_URL });
  check('a network failure is "unknown" with the error, not "no"', boom.data.every((x) => x.granted === 'unknown' && /ETIMEDOUT/.test(x.uber_said)));
}

console.log('\n3. what is asked, and where');
{
  const u = fakeUber(() => ({ status: 400, data: { error: 'invalid_scope' } }));
  await cashScopeCheck(oauth, { httpImpl: u.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('one request per scope, each scope alone, in order', u.calls.length === 2
    && u.calls.map((c) => c.scope).join('|') === CASH_BLOCK_SCOPES.join('|'), JSON.stringify(u.calls.map((c) => c.scope)));
  check('client_credentials, POST, the token URL only — no cash-block endpoint is called',
    u.calls.every((c) => c.grant === 'client_credentials' && c.method === 'POST' && c.url === TOKEN_URL), JSON.stringify(u.calls.map((c) => c.url)));
  check('the scopes are the two Uber documents', CASH_BLOCK_SCOPES.join(' ') === 'vehicle_suppliers.cash_block.read vehicle_suppliers.cash_block.write');
}

console.log('\n4. nothing secret in the record');
{
  const u = fakeUber((s) => ({ status: 200, data: { access_token: 'tok-SECRET-XYZ', scope: s } }));
  const r = await cashScopeCheck(oauth, { httpImpl: u.httpImpl, forget, tokenUrl: TOKEN_URL });
  const j = JSON.stringify(r);
  check('neither the token nor the client secret appears', !/tok-SECRET-XYZ|csecret-zzz|access_token/.test(j), j);
}

console.log('\n5. a token issued is a cache forgotten');
{
  forgot = 0;
  const u = fakeUber((s) => ({ status: 200, data: { access_token: 't', scope: s } }));
  await cashScopeCheck(oauth, { httpImpl: u.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('a check that was issued a token forgets the cached grants once', forgot === 1, String(forgot));
  forgot = 0;
  const no = fakeUber(() => ({ status: 400, data: { error: 'invalid_scope' } }));
  await cashScopeCheck(oauth, { httpImpl: no.httpImpl, forget, tokenUrl: TOKEN_URL });
  check('a refused check forgets nothing', forgot === 0, String(forgot));
}

console.log('\n6. the nightly probe asks each distinct client once');
{
  const list = surfaces({ from: new Date('2026-11-13'), to: new Date('2026-11-16') });
  const cash = list.filter((s) => s.provider === 'uber' && /^cash-block-scope:/.test(s.surface));
  check('a shared client is asked once, under the first fleet', cash.length === 1 && cash[0].surface === 'cash-block-scope:ecosine',
    JSON.stringify(cash.map((s) => s.surface)));
  check('…and its note carries the grant-type caveat', /Authorization Code/.test(cash[0]?.note || ''));
  process.env.UBER_CLIENT_ID_EGARI = 'egari-client-id';
  process.env.UBER_CLIENT_SECRET_EGARI = 'egari-not-a-real-secret';
  const two = surfaces({ from: new Date('2026-11-13'), to: new Date('2026-11-16') })
    .filter((s) => s.provider === 'uber' && /^cash-block-scope:/.test(s.surface)).map((s) => s.surface);
  check('each fleet with its own client is asked', two.join(',') === 'cash-block-scope:ecosine,cash-block-scope:egari', two.join(','));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
