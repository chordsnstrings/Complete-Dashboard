/* ACCESS REVIEWS AS A CYCLE, DORMANT SUSPENSION, AND WHO IS ON A FINDING —
   ULM Phase 4, on a real database, through the real access layer.
   ═════════════════════════════════════════════════════════════════════════
   docs/ULM-DESIGN.md §11.2, §11.3, §8 (act:finding.own), §13 phase 4. Built
   on 2026-11-12: api/access/reviews.js, api/access/findings.js,
   sql/schema_v122.sql. Like test/access_core.test.mjs this mounts identify,
   gate and the routes exactly as production does — test/mount.mjs stubs the
   access layer and would prove nothing here — against a pglite database
   built from every schema file, over real HTTP with real cookies. Synthetic
   people only (@example.test).

   REVERSIONS, each run on 2026-11-12 and each failing as named:
     reviews.js mayDecide: drop the `num(it.user_id) === num(actor.id)` test
       → "nobody attests their own access" fails.
     reviews.js collectItems: push only membership lines (skip direct
       grants) → "the review lists every direct grant" fails.
     reviews.js closeCycle: leave pending lines pending → "the close makes
       every undecided line unattested" fails.
     reviews.js expireUnattested: skip the lastOwner() check → "the last
       Owner is never ended by a review" fails.
     routes.js reinstate: drop markReinstated() → "a reinstated person is
       not suspended again by the next sweep" fails.
     routes.js login: put back the fixed "This account is suspended" text →
       "sign-in says why, since when, and the way back" fails.
     reviews.js dormantSweep: exempt every Owner again → "a dormant second
       Owner is suspended" fails.
     findings.js: take the fleet from the request body instead of the
       finding → "the finding's own fleet decides" fails.
     reviews.js reviewSweep: open the month's review before ending what is
       due → "the due grant ended, and the review that opened in the same
       pass does not list it" fails.
     schema_v122.sql: the two ALTERs on access_user bare, outside their DO
       block → "v122 runs for a user that does not own access_user" fails
       ("must be owner of table access_user").
     schema_v122.sql: the backfill's WHERE made false → "the old sweep's
       suspensions learn when they happened" fails.

   THE INDEPENDENT REVIEW (2026-11-12), sections 11–17, each reverted and
   run, each failing as named:
     reviews.js mayDecide + GET: judge a lead by the line's reviewer_id
       snapshot again → "a replaced lead no longer sees the team's lines"
       and "…nor keeps them" fail.
     reviews.js decideItem: drop the keep's settling of the same access's
       other open lines → "kept in one review, the same grant's line in the
       other is kept too" and "…closing the other review leaves nothing
       unattested, and the grant stands" fail.
     reviews.js stillHeld: drop the added_at test → "taken out and put back
       after the review opened" fails (the line is unattested).
     reviews.js inactiveDetail: explain whenever dormant_since is set →
       "…then suspended by an admin: the plain sentence" fails.
     findings.js seesFleet: judge rows by access.scope again → "their list
       leaves out the other fleet's rows" and "…one of them is refused"
       fail (Ecosine's closing note is served).
     reviews.js idOf: return Number(v) → both checks of section 16 fail
       with a 500 ("invalid input syntax for type bigint").
     reviews.js markReinstated: no catch → "no such column: passed" fails. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { SCHEMA_FILES } from './schema.mjs';
import { accessLayer } from '../api/access/middleware.js';
import { accessRoutes, housekeeping } from '../api/access/routes.js';
import * as svc from '../api/access/service.js';
import { hotp, totpStep, hashPassword } from '../api/access/crypto.js';
import {
  periodOf, scheduledKind, monthlyReviewed, reviewSweep, dormantSweep, expireUnattested, DORMANT_DAYS, UNATTESTED_DAYS,
  closeCycle, markReinstated,
} from '../api/access/reviews.js';
import { ROLE } from '../api/public/access_model.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const DAY = 864e5;

/* ══ 1. the calendar and the sensitive list ══════════════════════════════ */
console.log('\n1. which review the schedule opens, and who is reviewed monthly');
{
  /* 21:00 UTC on 31 December is 01:00 on 1 January in Dubai. */
  check('the quarter turns on Dubai’s clock', periodOf('quarterly', new Date('2026-12-31T21:00:00Z')) === '2027-Q1'
    && scheduledKind(new Date('2026-12-31T21:00:00Z')) === 'quarterly');
  check('…and a quarter’s other months get the monthly review', scheduledKind(new Date('2026-11-12T08:00:00Z')) === 'monthly'
    && periodOf('monthly', new Date('2026-11-12T08:00:00Z')) === '2026-11');
  const monthly = Object.fromEntries(Object.keys(ROLE).map((c) => [c, monthlyReviewed(ROLE[c])]));
  check('monthly: Owner, Cash desk, Finance, Access admin, Connections, HR, Safety, Operations, Auditor, Management',
    ['OWN', 'CLK', 'FIN', 'ACC', 'CON', 'HRO', 'SAF', 'OPS', 'AUD', 'MGT'].every((c) => monthly[c]), JSON.stringify(monthly));
  check('…not Dispatcher, Analyst, Fleet technician or a wall screen', ['DSP', 'ANL', 'TEC', 'WALL'].every((c) => !monthly[c]));
}

/* ══ 2. the app, as production mounts it ═════════════════════════════════ */
const pg = new PGlite();
for (const f of SCHEMA_FILES) await pg.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
const db = { query: (t, p) => pg.query(t, p) };
await db.query(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine'), ('egari', 'Egari') ON CONFLICT DO NOTHING`).catch(() => {});
svc.resetFleetCache?.();

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
const layer = accessLayer({ db });
app.use(layer.identify);
app.use(layer.gate);
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: 'internal', detail: String(e) }));
accessRoutes(app, { db, layer, wrap, smsSend: async () => ({ ok: true }) });
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;

const browser = () => {
  const jar = {};
  const call = async (method, path, body, { csrf = true } = {}) => {
    const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (csrf && jar.fm_csrf && method !== 'GET') h['x-fm-csrf'] = decodeURIComponent(jar.fm_csrf);
    const r = await fetch(B + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1);
    }
    let j = null; try { j = await r.json(); } catch { /* not json */ }
    return { status: r.status, json: j };
  };
  return { jar, get: (p, o) => call('GET', p, undefined, o), post: (p, b = {}, o) => call('POST', p, b, o) };
};

/* The first Owner: bootstrapped, new password, two-step on (which also
   counts as a fresh re-confirmation for ten minutes). */
const owner = browser();
{
  await svc.bootstrapOwner(db, { email: 'owner@example.test', hash: hashPassword('first owner temporary pass') });
  await owner.post('/api/auth/login', { email: 'owner@example.test', password: 'first owner temporary pass' });
  await owner.post('/api/auth/password', { current: 'first owner temporary pass', next: 'granite harbour lantern' });
  const setup = await owner.post('/api/auth/totp/setup', {});
  owner.secret = setup.json.secret;
  const en = await owner.post('/api/auth/totp/enable', { code: hotp(owner.secret, totpStep()) });
  check('the Owner is signed in with two-step on', en.status === 200, JSON.stringify(en.json));
}
const ownerId = (await svc.getUserByEmail(db, 'owner@example.test')).id;

const people = {};
async function invite(key, role, { fleets = null, name = `Test ${key}` } = {}) {
  const r = await owner.post('/api/access/users', { email: `${key}@example.test`, name,
    grants: [{ role, ...(fleets ? { fleets } : {}) }], reason: 'test' });
  const token = r.json?.link?.split('invite=')[1];
  /* Never the email's own name: passwordProblem() refuses a password that
     contains it, and the invitation would be left unaccepted. */
  const password = `copper willow meadow ${Object.keys(people).length + 10}`;
  await browser().post('/api/auth/link/accept', { token, password });
  people[key] = { id: r.json?.user?.id, email: `${key}@example.test`, password, b: browser() };
  return r;
}
async function signIn(key) {
  const p = people[key];
  return p.b.post('/api/auth/login', { email: p.email, password: p.password });
}
console.log('\n2. the people');
{
  const r1 = await invite('lead', 'DSP', { name: 'Test Lead' });
  await invite('cash', 'CLK', { name: 'Test Cash' });
  await invite('ops', 'OPS', { name: 'Test Ops' });
  await invite('opsegari', 'OPS', { fleets: ['egari'], name: 'Test Ops Egari' });
  await invite('acc', 'ACC', { name: 'Test Access' });
  check('five people invited and accepted', r1.status === 200 && Object.values(people).every((p) => p.id), JSON.stringify(r1.json).slice(0, 160));
  const ins = [];
  for (const k of ['lead', 'cash', 'ops', 'opsegari', 'acc']) ins.push([k, (await signIn(k)).status]);
  check('…and signed in', ins.every(([, s]) => s === 200), JSON.stringify(ins));
  /* The Access admin must use two-step (the default policy). */
  const s = await people.acc.b.post('/api/auth/totp/setup', {});
  people.acc.secret = s.json.secret;
  await people.acc.b.post('/api/auth/totp/enable', { code: hotp(people.acc.secret, totpStep()) });
  const t = await owner.post('/api/access/teams', { name: 'Night shift', lead: people.lead.id });
  people.team = t.json?.team?.id;
  for (const k of ['lead', 'cash', 'ops']) await owner.post(`/api/access/teams/${people.team}`, { member: { userId: people[k].id, on: true } });
  const tg = await owner.post('/api/access/grants', { teamId: people.team, role: 'TEC', reason: 'the night shift looks after the cars' });
  check('a team with a lead, three members and a role of its own', t.status === 200 && tg.status === 200, JSON.stringify(tg.json).slice(0, 160));
}

/* ══ 3. who is on a finding ══════════════════════════════════════════════ */
console.log('\n3. who is on a finding (act:finding.own)');
{
  await db.query(`INSERT INTO insight (code, severity, category, entity_type, entity_id, title, fleet_id, computed_at)
    VALUES ('idle_vehicle', 'warning', 'utilisation', 'vehicle', 'T1234', 'A car stood idle', 'egari', now()),
           ('stale_tracker', 'warning', 'data', 'vehicle', 'T9999', 'A tracker went quiet', 'ecosine', now())`);
  const egari = { code: 'idle_vehicle', entity_type: 'vehicle', entity_id: 'T1234' };
  const ecosine = { code: 'stale_tracker', entity_type: 'vehicle', entity_id: 'T9999' };
  const q = (k) => `/api/access/findings?code=${k.code}&entity_type=${k.entity_type}&entity_id=${k.entity_id}`;

  const anon = browser();
  const a1 = await anon.get(q(egari));
  check('a visitor while sign-in is optional is told it is for signed-in people — not sent to sign in',
    a1.status === 200 && a1.json.signedIn === false && a1.json.findings.length === 0 && /signed-in/.test(a1.json.why), JSON.stringify(a1.json));
  const a2 = await anon.post('/api/access/findings/take', egari);
  check('…and cannot take one: there is no name to record', a2.status === 401 && /no name to record/.test(a2.json.detail), JSON.stringify(a2.json));

  const c1 = await people.cash.b.get(q(egari));
  check('the cash desk (names, no finding.own) sees the state and cannot act, with the reason',
    c1.status === 200 && c1.json.canOwn === false && /Operations managers/.test(c1.json.why), JSON.stringify(c1.json));
  const c2 = await people.cash.b.post('/api/access/findings/take', egari);
  check('…and is refused the take', c2.status === 403, JSON.stringify(c2.json));

  const noCsrf = await people.ops.b.post('/api/access/findings/take', egari, { csrf: false });
  check('a take without the CSRF header is refused', noCsrf.status === 403 && noCsrf.json.error === 'csrf');
  const t1 = await people.ops.b.post('/api/access/findings/take', egari);
  const g1 = await people.ops.b.get(q(egari));
  check('Operations takes it, and the page reads who is on it',
    t1.status === 200 && g1.json.findings[0]?.state === 'taken' && g1.json.findings[0]?.owner?.name === 'Test Ops'
      && g1.json.canOwn === true && g1.json.open === true, JSON.stringify(g1.json).slice(0, 300));
  check('…and the people it could be given to are those who may take findings about its fleet',
    (g1.json.people || []).some((p) => p.id === people.opsegari.id) && !(g1.json.people || []).some((p) => p.id === people.cash.id),
    JSON.stringify(g1.json.people));

  /* The fleet is the FINDING's. REVERSION: read it from req.body.fleet. */
  const e1 = await people.opsegari.b.post('/api/access/findings/take', { ...ecosine, fleet: 'egari' });
  check('the finding’s own fleet decides: a one-fleet Operations manager cannot take the other fleet’s, whatever the request says',
    e1.status === 403 && /ecosine/.test(e1.json.detail), JSON.stringify(e1.json));
  const e2 = await people.opsegari.b.get(q(ecosine));
  check('…nor read who is on it', e2.status === 403, JSON.stringify(e2.json));
  await people.ops.b.post('/api/access/findings/take', ecosine);
  const e3 = await people.opsegari.b.get('/api/access/findings');
  check('a one-fleet reader’s list holds only their fleet’s findings',
    e3.status === 200 && e3.json.findings.length === 1 && e3.json.findings[0].entity_id === 'T1234', JSON.stringify(e3.json.findings));

  const as1 = await people.ops.b.post('/api/access/findings/assign', { ...egari, userId: people.cash.id });
  check('it cannot be given to someone whose role cannot take findings', as1.status === 400 && as1.json.error === 'cannot_own', JSON.stringify(as1.json));
  const as2 = await people.ops.b.post('/api/access/findings/assign', { ...egari, userId: people.opsegari.id });
  const g2 = await people.opsegari.b.get(q(egari));
  check('…and can be given to someone who can, saying who gave it',
    as2.status === 200 && g2.json.findings[0]?.owner?.id === people.opsegari.id && g2.json.findings[0]?.assigned_by?.id === people.ops.id,
    JSON.stringify(g2.json.findings));

  const cl0 = await people.opsegari.b.post('/api/access/findings/close', { ...egari, outcome: 'acted' });
  check('closing asks what was done', cl0.status === 400 && cl0.json.error === 'note');
  const cl1 = await people.opsegari.b.post('/api/access/findings/close', { ...egari, outcome: 'acted', note: 'Moved the car to the airport rank.' });
  const g3 = await people.opsegari.b.get(q(egari));
  check('closed: how it ended, what was done and by whom',
    cl1.status === 200 && g3.json.findings[0]?.state === 'closed' && g3.json.findings[0]?.outcome_text === 'Dealt with'
      && g3.json.findings[0]?.closed_by?.id === people.opsegari.id && /airport/.test(g3.json.findings[0]?.note), JSON.stringify(g3.json.findings));
  const cl2 = await people.opsegari.b.post('/api/access/findings/close', { ...egari, outcome: 'acted', note: 'again' });
  check('…once', cl2.status === 409);
  const ro = await people.ops.b.post('/api/access/findings/reopen', { ...egari, note: 'it is idle again' });
  const g4 = await people.ops.b.get(q(egari));
  check('reopened: nobody on it again', ro.status === 200 && g4.json.findings[0]?.state === 'open' && !g4.json.findings[0]?.owner);
  const { rows: au } = await db.query(`SELECT action, actor_id FROM access_audit WHERE action LIKE 'finding.%' ORDER BY id`);
  check('every step is in the audit log, under the person who took it',
    JSON.stringify(au.map((r) => r.action)) === JSON.stringify(['finding.taken', 'finding.taken', 'finding.assigned', 'finding.closed', 'finding.reopened'])
      && Number(au[3].actor_id) === people.opsegari.id, JSON.stringify(au));

  await owner.post('/api/auth/preview', { role: 'OPS' });
  const pv = await owner.post('/api/access/findings/take', egari);
  check('an Owner previewing a role cannot act', pv.status === 403 && pv.json.error === 'preview', JSON.stringify(pv.json));
  await owner.post('/api/auth/preview', { role: null });
  await db.query(`DELETE FROM insight WHERE code = 'stale_tracker'`);
  const gone = await people.ops.b.post('/api/access/findings/assign', { ...ecosine, userId: people.ops.id });
  const gc = await people.ops.b.post('/api/access/findings/close', { ...ecosine, outcome: 'no_action', note: 'The tracker came back.' });
  check('a finding its rule stopped finding can be closed, not taken or assigned', gone.status === 409 && gc.status === 200,
    `${gone.status} ${gc.status} ${JSON.stringify(gc.json)}`);
}

/* ══ 4. a review, start to finish ════════════════════════════════════════ */
console.log('\n4. a review: opened, decided line by line, closed, ended');
let cycle = null;
{
  const l0 = await people.lead.b.post('/api/access/reviews/open', {});
  check('only an Access admin or the Owner opens a review', l0.status === 403, String(l0.status));
  const o1 = await owner.post('/api/access/reviews/open', { kind: 'quarterly' });
  cycle = o1.json?.cycle;
  /* Six direct grants (Owner, lead, cash, ops, opsegari, acc) and three team
     places (lead, cash, ops in Night shift, which holds a role). */
  check('the review lists every direct grant and every team place', o1.status === 200 && o1.json.grants === 6 && o1.json.memberships === 3,
    JSON.stringify(o1.json));
  const o2 = await owner.post('/api/access/reviews/open', { kind: 'quarterly' });
  check('one quarterly review per quarter', o2.status === 409 && o2.json.error === 'exists', JSON.stringify(o2.json));

  const og = await owner.get('/api/access/reviews');
  const mineOwn = og.json.items.find((i) => i.user_id === ownerId && i.kind === 'grant');
  check('the Owner sees every line, each with its owner and its state', og.status === 200 && og.json.items.length === 9
    && og.json.items.every((i) => i.state === 'pending') && og.json.cycles[0]?.counts?.pending === 9, JSON.stringify(og.json.cycles));
  /* REVERSION: drop the self test in mayDecide. */
  check('nobody attests their own access', mineOwn && mineOwn.canDecide === false && /your own access/.test(mineOwn.why), JSON.stringify(mineOwn));
  const lg = await people.lead.b.get('/api/access/reviews');
  const leadLines = lg.json.items.map((i) => `${i.kind}:${i.user_id}`).sort();
  check('the team lead sees the people in their team — not their own place, not direct grants',
    JSON.stringify(leadLines) === JSON.stringify([`membership:${people.cash.id}`, `membership:${people.ops.id}`].sort())
      && lg.json.items.every((i) => i.canDecide && i.reviewer_id === people.lead.id), JSON.stringify(lg.json.items));
  const cg = await people.cash.b.get('/api/access/reviews');
  check('someone who reviews nothing sees nothing', cg.status === 200 && cg.json.items.length === 0 && cg.json.cycles.length === 0);

  const line = (kind, key) => og.json.items.find((i) => i.kind === kind && i.user_id === people[key].id);
  const cashPlace = line('membership', 'cash');
  const opsPlace = line('membership', 'ops');
  const r0 = await people.lead.b.post(`/api/access/reviews/${cycle}/attest`, { decisions: [
    { item: cashPlace.id, keep: true }, { item: opsPlace.id, keep: false, reason: 'moved to days' }] });
  check('taking someone out needs a fresh re-confirmation', r0.status === 403 && r0.json.error === 'stepup');
  await people.lead.b.post('/api/auth/stepup', { password: people.lead.password });
  const r1 = await people.lead.b.post(`/api/access/reviews/${cycle}/attest`, { decisions: [
    { item: cashPlace.id, keep: true }, { item: opsPlace.id, keep: false, reason: 'moved to days' }] });
  const opsTeams = await svc.teamsOf(db, people.ops.id);
  check('the lead keeps one and takes the other out of the team, at once',
    r1.status === 200 && r1.json.kept === 1 && r1.json.revoked === 1 && !opsTeams.some((t) => t.id === people.team), JSON.stringify(r1.json));
  const { rows: dec } = await db.query(
    `SELECT action, actor_id, detail FROM access_audit WHERE action IN ('access.review_kept', 'access.review_revoked') ORDER BY id`);
  check('each decision is in the audit log with who, what and why',
    dec.length === 2 && dec.every((r) => Number(r.actor_id) === people.lead.id) && dec[1].detail.reason === 'moved to days'
      && dec[1].detail.user === people.ops.id, JSON.stringify(dec));
  const r2 = await people.lead.b.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ item: cashPlace.id, keep: false }] });
  check('a decided line cannot be decided again', r2.status === 409 && r2.json.error === 'decided', JSON.stringify(r2.json));
  const r3 = await people.lead.b.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ item: line('grant', 'cash').id, keep: true }] });
  check('a lead cannot attest a direct grant', r3.status === 403 && /directly/.test(r3.json.detail), JSON.stringify(r3.json));
  const r4 = await people.acc.b.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ item: mineOwn.id, keep: true }] });
  check('an Access admin cannot attest an Owner’s access', r4.status === 403 && /another Owner/.test(r4.json.detail), JSON.stringify(r4.json));
  const r5 = await people.acc.b.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ item: line('grant', 'lead').id, keep: true }] });
  check('an Access admin attests a direct grant', r5.status === 200 && r5.json.kept === 1, JSON.stringify(r5.json));
  const r6 = await owner.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ item: mineOwn.id, keep: true }] });
  check('…and the Owner cannot attest their own', r6.status === 403 && r6.json.error === 'self');

  /* Close early: the Owner's own line is the last Owner's, so it is kept;
     every other undecided line becomes unattested for 14 days.
     REVERSION: leave pending lines pending in closeCycle. */
  const c0 = await people.lead.b.post(`/api/access/reviews/${cycle}/close`, {});
  check('only an Access admin or the Owner closes a review', c0.status === 403);
  const c1 = await people.acc.b.post(`/api/access/reviews/${cycle}/close`, {});
  const { rows: st } = await db.query('SELECT state, count(*)::int AS n FROM access_review_item WHERE cycle_id = $1 GROUP BY state', [cycle]);
  const states = Object.fromEntries(st.map((r) => [r.state, r.n]));
  check('the close makes every undecided line unattested — and keeps the only Owner',
    c1.status === 200 && c1.json.unattested === 5 && c1.json.keptOwner === ownerId
      && states.unattested === 5 && states.kept === 3 && states.revoked === 1, `${JSON.stringify(c1.json)} ${JSON.stringify(states)}`);
  const ends = new Date(c1.json.expires_at).getTime();
  check(`…ending ${UNATTESTED_DAYS} days after the close`, Math.abs(ends - Date.now() - UNATTESTED_DAYS * DAY) < 60_000);
  const ag = await owner.get('/api/access/reviews');
  check('the unattested lines stay listed, with when they end', ag.json.items.length === 5
    && ag.json.items.every((i) => i.state === 'unattested' && i.expires_at), JSON.stringify(ag.json.items.map((i) => i.state)));

  /* A late attestation inside the 14 days keeps the access. */
  const late = ag.json.items.find((i) => i.kind === 'grant' && i.user_id === people.cash.id);
  const k1 = await owner.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ item: late.id, keep: true }] });
  const { rows: lateAudit } = await db.query(`SELECT detail FROM access_audit WHERE action = 'access.review_kept' ORDER BY id DESC LIMIT 1`);
  check('a late attestation keeps it, and the log says it was late', k1.status === 200 && k1.json.kept === 1 && lateAudit[0].detail.late === true);

  /* Fifteen days on: what nobody attested has ended. */
  const hk = await housekeeping(db, { now: new Date(Date.now() + 15 * DAY) });
  const g = async (key, role) => (await db.query('SELECT status FROM access_grant WHERE user_id = $1 AND role_code = $2', [people[key].id, role])).rows[0]?.status;
  const leadTeams = await svc.teamsOf(db, people.lead.id);
  check('fifteen days on, the unattested grants have ended',
    (await g('acc', 'ACC')) === 'revoked' && (await g('ops', 'OPS')) === 'revoked' && (await g('opsegari', 'OPS')) === 'revoked',
    JSON.stringify(hk.reviews?.expired));
  check('…and the unattested team place too (the lead’s own, which nobody else attested)', !leadTeams.some((t) => t.id === people.team));
  check('…while what was attested stands', (await g('cash', 'CLK')) === 'active' && (await g('lead', 'DSP')) === 'active');
  const { rows: own } = await db.query(`SELECT status FROM access_grant WHERE user_id = $1 AND role_code = 'OWN'`, [ownerId]);
  check('the last Owner is never ended by a review', own[0]?.status === 'active');
  const accNow = await people.acc.b.get('/api/access/overview');
  check('the Access admin whose access ended is refused at once', accNow.status === 403, String(accNow.status));
  const { rows: sys } = await db.query(`SELECT actor_label FROM access_audit WHERE action = 'access.review_expired'`);
  check('the ending is in the audit log, as the schedule', sys.length === 1 && sys[0].actor_label === 'system:schedule');
}

/* ══ 5. the schedule ═════════════════════════════════════════════════════ */
console.log('\n5. the schedule: nothing while sign-in is optional; the 1st of the month once it is required');
{
  const dec1 = new Date('2026-12-01T06:00:00Z');   // 10:00 Dubai, 1 December
  const off = await reviewSweep(db, { now: dec1 });
  check('while sign-in is optional, no review opens by itself', off.opened === null, JSON.stringify(off));
  await svc.setConfig(db, 'mode', 'enforced', ownerId);
  const on = await reviewSweep(db, { now: dec1 });
  /* December is a quarter's last month: the monthly review — sensitive
     classes only. Left: the Owner (OWN) and the cash desk (CLK). */
  check('once required, the 1st opens the month’s review of sensitive access',
    on.opened?.kind === 'monthly' && on.opened?.period === '2026-12' && on.opened?.items === 2, JSON.stringify(on));
  const again = await reviewSweep(db, { now: new Date(dec1.getTime() + 3600_000) });
  check('…once', again.opened === null);
  const { rows: who } = await db.query(`SELECT actor_label FROM access_audit WHERE action = 'access.review_opened' ORDER BY id DESC LIMIT 1`);
  check('…recorded as the schedule', who[0]?.actor_label === 'system:schedule');
  const due = await reviewSweep(db, { now: new Date(dec1.getTime() + 15 * DAY) });
  check('a review past its due date closes by itself', due.closed.length === 1 && due.closed[0].unattested === 1 && due.closed[0].keptOwner === ownerId,
    JSON.stringify(due.closed));
  await svc.setConfig(db, 'mode', 'open', ownerId);
  await svc.getConfig(db, { fresh: true });
}

/* ══ 6. dormant accounts ═════════════════════════════════════════════════ */
console.log('\n6. dormant accounts: suspended, told why, reinstated, and left alone after');
{
  await invite('sleepy', 'DSP', { name: 'Test Sleepy' });
  const back = async (key, days) => db.query(
    `UPDATE access_user SET created_at = now() - make_interval(days => $2), last_login_at = now() - make_interval(days => $2),
            password_changed_at = now() - make_interval(days => $2), reinstated_at = NULL WHERE id = $1`, [people[key].id, days]);
  await back('sleepy', DORMANT_DAYS + 1);
  /* While sign-in is optional, not signing in is not dormancy (integration,
     2026-11-12). REVERSION: drop the mode gate in dormantSweep. */
  /* …even when the optional mode was set long ago, so the floor below
     cannot be what protects them. */
  await db.query(`UPDATE access_config SET updated_at = now() - make_interval(days => $1) WHERE key = 'mode'`, [DORMANT_DAYS + 30]);
  check('sign-in optional: a long-unused account is left alone', (await dormantSweep(db)).length === 0
    && (await svc.getUser(db, people.sleepy.id)).status === 'active');
  /* Required since today: the 60 days start now, not at the last sign-in.
     REVERSION: drop the requiredSince floor. */
  await svc.setConfig(db, 'mode', 'enforced', ownerId);
  check('sign-in required only since today: still left alone', (await dormantSweep(db)).length === 0
    && (await svc.getUser(db, people.sleepy.id)).status === 'active');
  await svc.setConfig(db, 'mode', 'open', ownerId);
  /* The checks below run each sweep as if sign-in had been required for
     longer than the dormancy window, and put the mode back afterwards: the
     rest of this file signs people in and grants roles in optional mode. */
  const sweepRequired = async () => {
    await svc.setConfig(db, 'mode', 'enforced', ownerId);
    await db.query(`UPDATE access_config SET updated_at = now() - make_interval(days => $1) WHERE key = 'mode'`, [DORMANT_DAYS + 30]);
    try { return await dormantSweep(db); } finally { await svc.setConfig(db, 'mode', 'open', ownerId); }
  };
  const s1 = await sweepRequired();
  const u1 = await svc.getUser(db, people.sleepy.id);
  check(`no sign-in for ${DORMANT_DAYS} days: suspended, not deleted`, s1.includes(people.sleepy.id) && u1.status === 'suspended'
    && u1.suspended_reason === `no sign-in for ${DORMANT_DAYS} days`, JSON.stringify(s1));
  check('…and only them', s1.length === 1, JSON.stringify(s1));
  const { rows: da } = await db.query(`SELECT actor_label FROM access_audit WHERE action = 'access.user_dormant' AND subject_id = $1`, [String(people.sleepy.id)]);
  check('…recorded in the audit log', da.length === 1 && da[0].actor_label === 'system:housekeeping');
  const wrong = await people.sleepy.b.post('/api/auth/login', { email: people.sleepy.email, password: 'not the password at all' });
  check('a wrong password learns nothing about the account', wrong.status === 401 && !/suspended/.test(wrong.json.detail));
  /* REVERSION: the fixed "This account is suspended" sentence. */
  const in1 = await signIn('sleepy');
  check('sign-in says why, since when, and the way back',
    in1.status === 403 && in1.json.error === 'inactive' && /because nobody had signed in to it for 60 days/.test(in1.json.detail)
      && /the last sign-in was on/.test(in1.json.detail) && /reinstate/.test(in1.json.detail) && /not deleted/.test(in1.json.detail),
    JSON.stringify(in1.json));
  const re = await owner.post(`/api/access/users/${people.sleepy.id}`, { action: 'reinstate' });
  const st = re.status === 403 && re.json.error === 'stepup'
    ? await owner.post('/api/auth/stepup', { code: hotp(owner.secret, totpStep() + 1) }) : null;
  const re2 = st ? await owner.post(`/api/access/users/${people.sleepy.id}`, { action: 'reinstate' }) : re;
  check('an admin reinstates them', re2.status === 200 && re2.json.user.status === 'active', JSON.stringify(re2.json).slice(0, 200));
  /* REVERSION: drop markReinstated() in the reinstate action. */
  const s2 = await sweepRequired();
  check('a reinstated person is not suspended again by the next sweep', !s2.includes(people.sleepy.id), JSON.stringify(s2));
  const in2 = await signIn('sleepy');
  check('…and signs in', in2.status === 200, JSON.stringify(in2.json));

  /* An admin's own suspension keeps its reason for admins. */
  await owner.post(`/api/access/users/${people.cash.id}`, { action: 'suspend', reason: 'a private reason for admins' });
  const in3 = await signIn('cash');
  check('an admin’s suspension is not explained to the account with the admin’s words',
    in3.status === 403 && in3.json.detail === 'This account is suspended. Ask the Owner or an Access admin.', JSON.stringify(in3.json));

  /* Owners: the last active one never; a dormant second one, yes.
     REVERSION: exempt every Owner. */
  const so = await owner.post('/api/access/users', { email: 'owner2@example.test', name: 'Test Owner Two', grants: [{ role: 'OWN' }], reason: 'test' });
  await browser().post('/api/auth/link/accept', { token: so.json?.link?.split('invite=')[1], password: 'copper willow meadow 99' });
  const o2 = (await svc.getUserByEmail(db, 'owner2@example.test')).id;
  people.owner2 = { id: o2 };
  check('a second Owner exists', (await svc.activeOwners(db)).length === 2);
  await back('owner2', DORMANT_DAYS + 5);
  const s3 = await sweepRequired();
  check('a dormant second Owner is suspended', s3.includes(o2) && (await svc.getUser(db, o2)).status === 'suspended', JSON.stringify(s3));
  await db.query(`UPDATE access_user SET status = 'active', dormant_since = NULL WHERE id = $1`, [o2]);
  await back('owner2', DORMANT_DAYS + 5);
  await db.query(`UPDATE access_user SET created_at = now() - interval '90 days', last_login_at = now() - interval '70 days',
                         password_changed_at = now() - interval '90 days' WHERE id = $1`, [ownerId]);
  const s4 = await sweepRequired();
  check('when every active Owner is dormant, none is suspended — the company keeps its access controls',
    !s4.includes(o2) && !s4.includes(ownerId), JSON.stringify(s4));
}

/* ══ 7. the old shape is refused with the reason ═════════════════════════ */
console.log('\n7. a decision must name its line');
{
  const bad = await owner.post(`/api/access/reviews/${cycle}/attest`, { decisions: [{ userId: people.cash.id, keep: false }] });
  check('the 2026-09 body (a person per team) is refused, saying what to send', bad.status === 400 && /item/.test(bad.json.detail), JSON.stringify(bad.json));
}

/* ══ 8. an Owner's unattested access, at its end ══════════════════════════
   The close keeps the last Owner (section 4), but an Owner's line can be
   unattested while a second Owner exists — and by the time its 14 days are
   up that second Owner may be gone. REVERSION: skip the lastOwner() check
   in expireUnattested — the only remaining Owner's grant is ended. */
console.log('\n8. an Owner\u2019s unattested access ends only while another Owner remains');
{
  const o2 = people.owner2.id;
  await db.query(`UPDATE access_user SET status = 'active', dormant_since = NULL WHERE id = ANY($1::bigint[])`, [[ownerId, o2]]);
  const grantOf = async (id) => (await db.query(
    `SELECT id, status FROM access_grant WHERE user_id = $1 AND role_code = 'OWN' ORDER BY id DESC LIMIT 1`, [id])).rows[0];
  const c = await db.query(`INSERT INTO access_review_cycle (kind, period, due_at, closed_at, expires_at, items)
    VALUES ('adhoc', 'test', now(), now(), now(), 2) RETURNING id`);
  const cid = c.rows[0].id;
  for (const id of [o2, ownerId]) {
    await db.query(`INSERT INTO access_review_item (cycle_id, kind, grant_id, user_id, roles, owner_only, state, expires_at)
      VALUES ($1, 'grant', $2, $3, '{OWN}', true, 'unattested', now() - interval '1 minute')`, [cid, (await grantOf(id)).id, id]);
  }
  check('two active Owners before the end', (await svc.activeOwners(db)).length === 2);
  const ex = await expireUnattested(db);
  const { rows: lines } = await db.query('SELECT user_id, state, reason FROM access_review_item WHERE cycle_id = $1 ORDER BY id', [cid]);
  check('the first Owner\u2019s unattested grant ends while another Owner remains',
    (await grantOf(o2)).status === 'revoked' && lines[0].state === 'expired', JSON.stringify(ex));
  check('the last Owner is never ended by a review — kept, saying why',
    (await grantOf(ownerId)).status === 'active' && lines[1].state === 'kept' && /only active Owner/.test(lines[1].reason), JSON.stringify(lines));
}

/* ══ 9. one pass: what ends first, then what opens ═══════════════════════
   The hourly sweep ends due access before it opens the month's review, so
   the new review never lists a line that ends in the same pass.
   REVERSION: open before expiring in reviewSweep — the new review lists
   the grant that ended a moment later. */
console.log('\n9. the sweep ends what is due before it opens the month’s review');
{
  await invite('sens', 'CLK', { name: 'Test Sensitive' });
  const g = (await db.query(`SELECT id FROM access_grant WHERE user_id = $1 AND role_code = 'CLK'`, [people.sens.id])).rows[0];
  const feb1 = new Date('2027-02-01T06:00:00Z');
  const c = await db.query(`INSERT INTO access_review_cycle (kind, period, due_at, closed_at, expires_at, items)
    VALUES ('adhoc', 'test-9', now(), now(), now(), 1) RETURNING id`);
  await db.query(`INSERT INTO access_review_item (cycle_id, kind, grant_id, user_id, roles, state, expires_at)
    VALUES ($1, 'grant', $2, $3, '{CLK}', 'unattested', $4)`, [c.rows[0].id, g.id, people.sens.id, new Date(feb1.getTime() - 60_000)]);
  await svc.setConfig(db, 'mode', 'enforced', ownerId);
  const r = await reviewSweep(db, { now: feb1 });
  await svc.setConfig(db, 'mode', 'open', ownerId);
  await svc.getConfig(db, { fresh: true });
  const { rows: lines } = await db.query('SELECT grant_id FROM access_review_item WHERE cycle_id = $1', [r.opened?.cycle ?? -1]);
  const st = (await db.query('SELECT status FROM access_grant WHERE id = $1', [g.id])).rows[0].status;
  check('the due grant ended, and the review that opened in the same pass does not list it',
    r.expired?.grants?.includes(Number(g.id)) && st === 'revoked' && r.opened?.period === '2027-02'
      && !lines.some((l) => Number(l.grant_id) === Number(g.id)), JSON.stringify({ r, lines }));
}

/* ══ 10. the migration, run by a user that does not own access_user ═════
   src/db.js runs each schema file as one query: one refused statement rolls
   back the whole file, and is refused again at every boot. The only
   statements in v122 needing more than CREATE are the two ALTERs on
   access_user (they need its owner); they are guarded, so the new tables
   are made whatever happens to those. REVERSION: the two ALTERs bare —
   "v122 runs for a user that does not own access_user" fails. */
console.log('\n10. v122 runs even where access_user is not this user’s to alter');
{
  const fresh = new PGlite();
  for (const f of SCHEMA_FILES.filter((x) => x !== 'schema_v122.sql')) {
    await fresh.exec(readFileSync(new URL(`../sql/${f}`, import.meta.url), 'utf8'));
  }
  await fresh.exec(`CREATE ROLE rev_not_owner NOLOGIN; GRANT CREATE, USAGE ON SCHEMA public TO rev_not_owner;`);
  let err = null;
  try {
    await fresh.exec(`SET ROLE rev_not_owner; ${readFileSync(new URL('../sql/schema_v122.sql', import.meta.url), 'utf8')}`);
  } catch (e) { err = e; }
  await fresh.exec('RESET ROLE');
  const made = (await fresh.query(`SELECT count(*)::int AS n FROM pg_tables WHERE tablename IN ('access_review_cycle', 'access_review_item', 'finding_owner')`)).rows[0].n;
  check('v122 runs for a user that does not own access_user, and still makes its tables', !err && made === 3, String(err?.message || made));
  /* The backfill, run by the owner: an account the 2026-09-28 sweep
     suspended gets its dormant_since from the audit row that recorded it,
     or — with no such row — from the day it became 60 days dormant. */
  const u1 = (await fresh.query(`INSERT INTO access_user (email, email_norm, status, suspended_reason, created_at, last_login_at)
    VALUES ('old1@example.test', 'old1@example.test', 'suspended', 'no sign-in for 60 days', '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z')
    RETURNING id`)).rows[0].id;
  const u2 = (await fresh.query(`INSERT INTO access_user (email, email_norm, status, suspended_reason, created_at)
    VALUES ('old2@example.test', 'old2@example.test', 'suspended', 'no sign-in for 60 days', '2026-06-01T00:00:00Z') RETURNING id`)).rows[0].id;
  const u3 = (await fresh.query(`INSERT INTO access_user (email, email_norm, status, suspended_reason, created_at)
    VALUES ('old3@example.test', 'old3@example.test', 'suspended', 'left the company', '2026-06-01T00:00:00Z') RETURNING id`)).rows[0].id;
  await fresh.query(`INSERT INTO access_audit (at, actor_label, action, subject_type, detail, hash)
    VALUES ('2026-08-30T10:00:00Z', 'system:housekeeping', 'access.housekeeping', 'system', $1, 'x')`,
  [JSON.stringify({ suspended: [Number(u1)], grants_ended: [] })]);
  await fresh.exec(readFileSync(new URL('../sql/schema_v122.sql', import.meta.url), 'utf8'));
  const ds = Object.fromEntries((await fresh.query('SELECT id, dormant_since FROM access_user')).rows
    .map((r) => [Number(r.id), r.dormant_since ? new Date(r.dormant_since).toISOString() : null]));
  check('the old sweep’s suspensions learn when they happened — from the audit log, else from the 60th day',
    ds[Number(u1)] === '2026-08-30T10:00:00.000Z' && ds[Number(u2)] === '2026-07-31T00:00:00.000Z' && ds[Number(u3)] === null, JSON.stringify(ds));
  await fresh.close();
}

/* ══ 11–16: the independent review of 2026-11-12 ═════════════════════════
   Each section below failed against the branch as built and passes with
   its fix; the reversions are in the header. The Owner's re-confirmation
   is renewed in the database (as a code would renew it) so these sections
   do not depend on how long the ones above took. */
const renew = async (id) => {
  await db.query('UPDATE access_session SET stepup_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  svc.bumpAccess();
};
let dayReview = null;
console.log('\n11. the team’s lead NOW decides its lines — a replaced lead does not');
{
  await renew(ownerId);
  for (const [k, n] of [['lead2', 'Test Lead Two'], ['lead3', 'Test Lead Three'], ['mem', 'Test Member']]) {
    await invite(k, 'DSP', { name: n });
    await signIn(k);
  }
  const t = await owner.post('/api/access/teams', { name: 'Day shift', lead: people.lead2.id });
  people.day = t.json?.team?.id;
  for (const k of ['lead2', 'lead3', 'mem']) await owner.post(`/api/access/teams/${people.day}`, { member: { userId: people[k].id, on: true } });
  await owner.post('/api/access/grants', { teamId: people.day, role: 'TEC', reason: 'the day shift looks after the cars' });
  const o = await owner.post('/api/access/reviews/open', { kind: 'adhoc' });
  dayReview = o.json?.cycle;
  const before = await people.lead2.b.get('/api/access/reviews');
  const memLine = (before.json?.items || []).find((i) => i.kind === 'membership' && i.user_id === people.mem.id && i.cycle_id === dayReview);
  check('while they lead the team, its lead sees a member’s line and may decide it',
    o.status === 200 && memLine?.canDecide === true, JSON.stringify(before.json?.items || before.json).slice(0, 300));
  const ch = await owner.post(`/api/access/teams/${people.day}`, { lead: people.lead3.id });
  /* REVERSION: judge a lead by the line's reviewer_id snapshot again. */
  const after = await people.lead2.b.get('/api/access/reviews');
  check('a replaced lead no longer sees the team’s lines',
    ch.status === 200 && !(after.json?.items || []).some((i) => i.team_id === people.day), JSON.stringify(after.json?.items));
  const k = await people.lead2.b.post(`/api/access/reviews/${dayReview}/attest`, { decisions: [{ item: memLine?.id, keep: true }] });
  check('…nor keeps them — the true reason: the line is the team’s lead’s, or an Access admin’s',
    k.status === 403 && k.json?.error === 'not_allowed' && /team’s lead/.test(k.json?.detail), JSON.stringify(k.json));
  const n = await people.lead3.b.get('/api/access/reviews');
  check('…and the new lead sees and may decide it at once',
    (n.json?.items || []).some((i) => i.id === memLine?.id && i.canDecide), JSON.stringify(n.json?.items).slice(0, 300));
}

console.log('\n12. one attestation settles the same access in every open review');
{
  /* Two reviews open side by side (the Reviews tab has three Open buttons),
     both listing one grant. REVERSION: drop the keep's settling of the
     other lines in decideItem — the second line stays pending, the close
     makes it unattested, and the grant someone attested would end. */
  const g = (await db.query(`SELECT id FROM access_grant WHERE user_id = $1 AND role_code = 'DSP' AND status = 'active'`, [people.mem.id])).rows[0];
  const mk = async (period) => (await db.query(
    `INSERT INTO access_review_cycle (kind, period, due_at, items) VALUES ('adhoc', $1, now() + interval '14 days', 1) RETURNING id`, [period])).rows[0].id;
  const line = async (cid) => (await db.query(
    `INSERT INTO access_review_item (cycle_id, kind, grant_id, user_id, roles) VALUES ($1, 'grant', $2, $3, '{DSP}') RETURNING id`,
    [cid, g.id, people.mem.id])).rows[0].id;
  const a = await mk('test-12a'); const b = await mk('test-12b');
  const la = Number(await line(a)); const lb = Number(await line(b));
  const k = await owner.post(`/api/access/reviews/${a}/attest`, { decisions: [{ item: la, keep: true }] });
  const { rows: st } = await db.query('SELECT id, state, decided_by, reason FROM access_review_item WHERE id = ANY($1::bigint[]) ORDER BY id', [[la, lb]]);
  check('kept in one review, the same grant’s line in the other is kept too — by whom, and where',
    k.status === 200 && st[1]?.state === 'kept' && Number(st[1]?.decided_by) === ownerId && new RegExp(`line ${la} of review ${a}`).test(st[1]?.reason),
    JSON.stringify({ k: k.json, st }));
  const { rows: au } = await db.query(`SELECT detail FROM access_audit WHERE action = 'access.review_kept' ORDER BY id DESC LIMIT 1`);
  check('…and the audit row names every line the keep settled', (au[0]?.detail?.also_kept || []).includes(lb), JSON.stringify(au[0]?.detail));
  const c = await closeCycle(db, { cycleId: Number(b) });
  const gs = (await db.query('SELECT status FROM access_grant WHERE id = $1', [g.id])).rows[0].status;
  check('…so closing the other review leaves nothing unattested, and the grant stands', c.closed && c.unattested === 0 && gs === 'active',
    JSON.stringify(c));
}

console.log('\n13. a team place made after the review opened is not ended as unattested');
{
  /* REVERSION: drop the added_at test from stillHeld — the close makes
     the re-added member's line unattested, and the sweep would take them
     out of the team 14 days later. */
  await renew(ownerId);
  const off = await owner.post(`/api/access/teams/${people.day}`, { member: { userId: people.mem.id, on: false } });
  const on = await owner.post(`/api/access/teams/${people.day}`, { member: { userId: people.mem.id, on: true } });
  const c = await owner.post(`/api/access/reviews/${dayReview}/close`, {});
  const { rows } = await db.query(`SELECT state FROM access_review_item WHERE cycle_id = $1 AND kind = 'membership' AND user_id = $2`,
    [dayReview, people.mem.id]);
  const still = (await svc.teamsOf(db, people.mem.id)).some((x) => x.id === people.day);
  check('taken out and put back after the review opened: the listed place reads “already ended”, and they stay in the team',
    off.status === 200 && on.status === 200 && c.status === 200 && rows[0]?.state === 'gone' && still, JSON.stringify({ c: c.json, rows }));
}

console.log('\n14. an admin’s suspension over the sweep’s is not explained as dormancy');
{
  /* REVERSION: explain whenever dormant_since is set (no check of the
     reason) — the holder is told the sweep closed it, after an admin did. */
  await renew(ownerId);
  await invite('dozy', 'DSP', { name: 'Test Dozy' });
  await db.query(`UPDATE access_user SET status = 'suspended', suspended_reason = $2, dormant_since = now() WHERE id = $1`,
    [people.dozy.id, `no sign-in for ${DORMANT_DAYS} days`]);
  svc.bumpAccess();
  const d1 = await signIn('dozy');
  check('closed by the sweep: told why', d1.status === 403 && /because nobody had signed in/.test(d1.json?.detail), JSON.stringify(d1.json));
  const s = await owner.post(`/api/access/users/${people.dozy.id}`, { action: 'suspend', reason: 'a private reason for admins' });
  const d2 = await signIn('dozy');
  check('…then suspended by an admin: the plain sentence, not the sweep’s reason',
    s.status === 200 && d2.status === 403 && d2.json?.detail === 'This account is suspended. Ask the Owner or an Access admin.', JSON.stringify(d2.json));
}

console.log('\n15. who is on a finding: a row only where the reader holds driver identity over its fleet');
{
  /* Dispatcher over Egari (driver identity there) plus Connections over
     every fleet (credentials, no driver identity): their scope is both
     fleets, their driver identity only Egari's — /api/insights refuses
     them Ecosine's findings. REVERSION: judge rows by access.scope again —
     the list and the single read hand them Ecosine's closing note. */
  await renew(ownerId);
  await invite('mixed', 'DSP', { fleets: ['egari'], name: 'Test Mixed' });
  await db.query(`INSERT INTO access_grant (user_id, role_code, status, reason) VALUES ($1, 'CON', 'active', 'test: credentials, no driver identity')`,
    [people.mixed.id]);
  svc.bumpAccess();
  await signIn('mixed');
  const eco = { code: 'stale_tracker', entity_type: 'vehicle', entity_id: 'T9999' };
  const egari = { code: 'idle_vehicle', entity_type: 'vehicle', entity_id: 'T1234' };
  const q = (k) => `/api/access/findings?code=${k.code}&entity_type=${k.entity_type}&entity_id=${k.entity_id}`;
  const list = await people.mixed.b.get('/api/access/findings');
  check('their list leaves out the other fleet’s rows (and its closing note)',
    list.status === 200 && !(list.json?.findings || []).some((f) => f.entity_id === 'T9999'), JSON.stringify(list.json).slice(0, 300));
  const one = await people.mixed.b.get(q(eco));
  check('…and one of them is refused, with the true reason', one.status === 403 && /ecosine/.test(one.json?.detail) && /driver identity/.test(one.json?.detail),
    JSON.stringify(one.json));
  const own = await people.mixed.b.get(q(egari));
  check('…while their own fleet’s finding still reads', own.status === 200 && own.json?.signedIn === true, JSON.stringify(own.json).slice(0, 200));
  const all = await owner.get('/api/access/findings');
  check('…and a reader of every fleet still sees the other fleet’s row', (all.json?.findings || []).some((f) => f.entity_id === 'T9999'));
}

console.log('\n16. a number that is not a whole number is refused, not a 500');
{
  await renew(ownerId);
  const c = await owner.post('/api/access/reviews/abc/close', {});
  const a = await owner.post(`/api/access/reviews/${dayReview}/attest`, { decisions: [{ item: 1.5, keep: true }] });
  check('a review number that is not one: 404, saying so', c.status === 404 && c.json?.error === 'not_found', JSON.stringify(c));
  check('a line number that is not one: 400, saying what to send', a.status === 400 && a.json?.error === 'bad_request', JSON.stringify(a));
}

console.log('\n17. a reinstatement that succeeded is not turned into an error by the missing columns');
{
  /* Where v122's guarded ALTER was refused (section 10) the dormancy
     columns do not exist. REVERSION: let markReinstated throw on any error
     — the admin's reinstatement, already written, answers 500. */
  const err = (code) => ({ query: async () => { const e = new Error('simulated'); e.code = code; throw e; } });
  let missing = null; let other = null;
  try { await markReinstated(err('42703'), 1); } catch (e) { missing = e; }
  try { await markReinstated(err('08006'), 1); } catch (e) { other = e; }
  check('no such column: passed, since there is no dormancy clock to restart', missing === null, String(missing));
  check('…any other failure still reaches the admin', other?.code === '08006', String(other));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
