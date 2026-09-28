/* A signed-in person's change is recorded against THEM.
   ─────────────────────────────────────────────────────────────────────────
   Before sign-in, money and identity writes were attributed by a name the
   form sent (one of four supervisors, or a free-text `by`). Signed in, the
   person recorded is the person whose session made the request, whatever the
   form says (api/access/actor.js, ULM-DESIGN §5.3); a visitor while sign-in
   is optional still names themself. The real routes are mounted
   (test/mount.mjs) behind a stand-in for the access layer that sets req.fm
   when a request carries x-test-user, exactly as identify() does for a
   session.

   Found missing on 2026-09-28: /api/same-person/decide took the name-pair
   verdict's reviewer from the body even for a signed-in caller, so anybody
   signed in could record a verdict under anybody's name.
   REVERSION: restore `by = null` from the body in that route — the first
   check fails with the body's name. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { port } = await mountAll(db, {
  pre: (app) => app.use((req, _res, next) => {
    const u = req.get('x-test-user');
    if (u) req.fm = { kind: 'user', user: { id: 7, email: u } };
    next();
  }),
});
const post = async (path, body, user) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch { /* not json */ }
  return { status: r.status, body: j };
};

console.log('\nthe same-person queue');
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, full_name, state) VALUES
  ('uber','A-1','Test Driver Alpha','active'), ('bolt','A-2','Test Driver Alpha','active')`);
await q(`INSERT INTO driver_identity_link
   (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
    canonical_name, canonical_key, basis, evidence)
   VALUES ('A-2','bolt','Test Driver Alpha','A-1','uber','Test Driver Alpha','test driver alpha','same_name','the same name')`);
const signed = await post('/api/same-person/decide', { alias_ext_id: 'A-2', verdict: 'same', by: 'somebody else' }, 'reviewer@example.test');
const [row] = await q(`SELECT confirmed_by FROM driver_identity_link WHERE alias_ext_id = 'A-2'`);
check('a signed-in verdict is recorded against the signed-in person, not the name sent',
  signed.status === 200 && row.confirmed_by === 'reviewer@example.test', `${signed.status} ${JSON.stringify(signed.body).slice(0, 120)} by=${row.confirmed_by}`);
await post('/api/same-person/decide', { alias_ext_id: 'A-2', verdict: 'undecided' }, 'reviewer@example.test');
const anon = await post('/api/same-person/decide', { alias_ext_id: 'A-2', verdict: 'same', by: 'ahsan' });
const [row2] = await q(`SELECT confirmed_by FROM driver_identity_link WHERE alias_ext_id = 'A-2'`);
check('a visitor while sign-in is optional still names themself', anon.status === 200 && row2.confirmed_by === 'ahsan', row2.confirmed_by);

console.log('\nthe cash ledger and the lending line');
const pol = await post('/api/ledger/policy', { pct: 35, effective_from: '2026-10-01', set_by: 'somebody else', note: 'test line: the operator asked for thirty-five percent', dry_run: true }, 'finance@example.test');
check('a lending line proposed while signed in is set by the signed-in person',
  pol.body?.policy?.set_by === 'finance@example.test' || pol.body?.set_by === 'finance@example.test'
    || JSON.stringify(pol.body || {}).includes('"set_by":"finance@example.test"'), JSON.stringify(pol.body).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
