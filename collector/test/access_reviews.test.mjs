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
       finding → "the finding's own fleet decides" fails. */
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
  const s1 = await dormantSweep(db);
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
  const s2 = await dormantSweep(db);
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
  const s3 = await dormantSweep(db);
  check('a dormant second Owner is suspended', s3.includes(o2) && (await svc.getUser(db, o2)).status === 'suspended', JSON.stringify(s3));
  await db.query(`UPDATE access_user SET status = 'active', dormant_since = NULL WHERE id = $1`, [o2]);
  await back('owner2', DORMANT_DAYS + 5);
  await db.query(`UPDATE access_user SET created_at = now() - interval '90 days', last_login_at = now() - interval '70 days',
                         password_changed_at = now() - interval '90 days' WHERE id = $1`, [ownerId]);
  const s4 = await dormantSweep(db);
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

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
