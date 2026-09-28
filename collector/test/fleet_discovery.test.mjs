/* FLEETS NAMED FROM THE PLATFORMS — discovery, the store, and the routes.
   ═════════════════════════════════════════════════════════════════════════
   collector/docs/ULM-DESIGN.md §3. Against PGlite built from every schema
   file (v87 included): CABMAN snapshots whose raw CompanyName is "Ecosine
   Transports LLC" and "Sahalat" — the two measured on production 2026-09-26 —
   become two accounts; the platform calls are driven through injected fakes
   (no network); the brand becomes the fleet's name; and linking, ignoring,
   naming and approving run through the real routes with the caller injected
   as req.fm, the way api/access/middleware.js hands it over. Then once more
   through the real access layer, with the manifest entries this change
   proposes, so those entries are proved and not merely written down.

   Synthetic people only (@example.test), synthetic plates (T1…), synthetic
   driver names. The business names are the platforms' own, as measured.

   Every block names the reversion that proves it; each was run that way. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema, SCHEMA_FILES } from './schema.mjs';
import { runDiscovery, discoverCabman, recordAccount, clean, yangoParkName, boltCompanyName } from '../src/sources/discovery.js';
import { fleetNameRoutes, syncFleetNames, visibilityImpact, newFleetId } from '../api/fleet_names_routes.js';
import { pgliteTx } from '../api/tx.js';
import * as svc from '../api/access/service.js';
import { computeAccess } from '../api/access/principal.js';
import { verifyChain } from '../api/access/audit.js';
import { parseCookies, accessLayer } from '../api/access/middleware.js';
import { accessRoutes } from '../api/access/routes.js';
import { hashPassword } from '../api/access/crypto.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = (v) => JSON.stringify(v);

const pg = new PGlite();
const db = { query: (t, p) => pg.query(t, p) };
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);

/* ══ 1. the schema ═══════════════════════════════════════════════════════
   REVERSION: drop 'schema_v87.sql' from src/schema_files.js — every table
   check here fails (and so does everything after it). */
console.log('\n1. schema v87 replays with the rest');
{
  check('v87 is the last registered schema file', SCHEMA_FILES[SCHEMA_FILES.length - 1] === 'schema_v87.sql', SCHEMA_FILES.slice(-2).join(','));
  await applySchema(pg);
  const t = (await q(`SELECT table_name FROM information_schema.tables WHERE table_name IN
    ('platform_account','platform_account_name','platform_account_vehicle','fleet_change','fleet_legal_name')`)).map((r) => r.table_name).sort();
  check('its tables and the legal-names view exist', j(t) === j(['fleet_change', 'fleet_legal_name', 'platform_account', 'platform_account_name', 'platform_account_vehicle']), j(t));
  let replay = null;
  try { await applySchema(pg); } catch (e) { replay = e; }
  check('replaying every file again changes nothing and fails nothing', replay === null, String(replay));
  const f = await q(`SELECT id, brand_choice, name_basis FROM fleet ORDER BY id`);
  check('the two fleets keep their ids, and nothing is chosen or seeded', j(f.map((r) => r.id)) === j(['ecosine', 'egari'])
    && f.every((r) => r.brand_choice === null && r.name_basis === null));
  check('no account is seeded', (await q(`SELECT count(*)::int n FROM platform_account`))[0].n === 0);
}

/* The fixture: CABMAN's Ecosine interface (81) carrying two companies, and
   trips so the evidence has something to count. */
const snap = async (plate, company, at, fleet = 'ecosine') => q(
  `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, raw) VALUES ('cabman', $1, $2, $3, $4)`,
  [fleet, plate, at, JSON.stringify(company == null ? { VehicleID: plate } : { VehicleID: plate, CompanyName: company })]);
const day = (n) => new Date(Date.now() - n * 864e5).toISOString();
for (let i = 0; i < 5; i += 1) {
  await snap('T101', 'Ecosine Transports LLC', day(i + 1));
  await snap('T102', 'Ecosine Transports LLC', day(i + 1));
}
await snap('T103', 'Ecosine Transports LLC', day(1));
await snap('T201', 'Sahalat', day(2));
await snap('T201', 'Sahalat', day(3));
const trip = (platform, id, fleet, plate, driver) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, status)
   VALUES ($1, $2, $3, $4, $5, $6, $7, 'completed')`, [platform, id, fleet, plate, driver ? `${platform}-${driver}` : null, driver, day(2)]);
await trip('uber', 'u1', 'ecosine', 'T101', 'Harbour Test Driver');
await trip('uber', 'u2', 'ecosine', 'T102', 'Lantern Test Driver');
await trip('bolt', 'b1', 'ecosine', 'T101', 'Harbour Test Driver');
await trip('uber', 'u3', 'egari', 'T301', 'Granite Test Driver');

/* ══ 2. CABMAN, from our own snapshots ═══════════════════════════════════
   REVERSION: in discoverCabman pass `configuredFleet: e.fleet` always —
   "both arrive NEW" fails (Sahalat would be linked to Ecosine by the
   interface's configuration). REVERSION: drop the watermark setState — "a
   second run counts each snapshot once" fails. */
console.log('\n2. CABMAN: one account per company behind the interface');
const logged = [];
const log = { info: (...a) => logged.push(j(a)), warn: (...a) => logged.push(j(a)), error: (...a) => logged.push(j(a)) };
{
  const s = await runDiscovery(db, { log, calls: false, interfaces: { ecosine: '81' } });
  const accts = await q(`SELECT * FROM platform_account WHERE platform = 'cabman' ORDER BY account_id`);
  check('two companies → two accounts, keyed by interface and CompanyName',
    j(accts.map((a) => a.account_id)) === j(['81/Ecosine Transports LLC', '81/Sahalat']), j(accts.map((a) => a.account_id)));
  check('each carries the name CABMAN gave it', accts[0].reported_name === 'Ecosine Transports LLC' && accts[1].reported_name === 'Sahalat');
  check('both arrive NEW: an interface carrying two companies says nothing about either', accts.every((a) => a.status === 'new' && a.fleet_id === null));
  check('…and both say where their rows were filed: Ecosine', accts.every((a) => a.filed_fleet === 'ecosine'));
  check('the snapshots are counted per company (11 and 2)', accts[0].detail.snapshots === 11 && accts[1].detail.snapshots === 2
    && accts[1].detail.filed?.ecosine === 2, j(accts.map((a) => a.detail.filed)));
  check('…and the vehicles behind them (3 and 1)', accts[0].detail.vehicles === 3 && accts[1].detail.vehicles === 1);
  const hist = await q(`SELECT name FROM platform_account_name ORDER BY id`);
  check('the names start a history', j(hist.map((h) => h.name)) === j(['Ecosine Transports LLC', 'Sahalat']));
  check('the run is summarised and says it asked no platform', s.calls === false && s.steps[0].platform === 'cabman' && s.steps[0].ok);
  const ev = accts[0].detail.evidence;
  check('evidence: Ecosine Transports LLC shares 2 plates with Ecosine, from Uber and Bolt trips', ev?.byFleet?.ecosine?.plates === 2, j(ev));
  check('…and names no driver count, with the reason, instead of 0', ev?.drivers === null && /names no driver/.test(ev?.driversReason || ''), j(ev));
  check('Sahalat shares nothing with either fleet', !accts[1].detail.evidence?.byFleet?.ecosine && !accts[1].detail.evidence?.byFleet?.egari);

  await snap('T103', 'Ecosine Transports LLC', day(0));
  await runDiscovery(db, { log, calls: false, interfaces: { ecosine: '81' } });
  const again = (await q(`SELECT detail FROM platform_account WHERE account_id = '81/Ecosine Transports LLC'`))[0].detail;
  check('a second run counts each snapshot once (11 + 1 new = 12)', again.snapshots === 12, String(again.snapshots));
  check('…and records no duplicate name', (await q(`SELECT count(*)::int n FROM platform_account_name`))[0].n === 2);
  const named = await q(`SELECT id, name, name_basis FROM fleet ORDER BY id`);
  check('no linked account yet: each fleet is shown by its own id, not by a typed name',
    named[0].name === 'Unnamed fleet — ecosine' && named[1].name === 'Unnamed fleet — egari' && named.every((f) => f.name_basis === 'unnamed'), j(named));
}

/* ══ 3. the platforms, through injected fakes ════════════════════════════
   REVERSION: in discovery.js use String(e.message) instead of clean(e) for
   the FMS failure — "no password reaches the store or the log" fails.
   REVERSION: in discoverUber pass `configuredFleet: o.fleet` for every org
   the client lists — "an org nobody configured arrives NEW" fails. */
console.log('\n3. Uber, Yango, Bolt, FMS and the hotel channel');
const SECRET = 'not-a-real-password-7f3a';
const calls = [];
const fakeHttp = async (url, opts = {}) => {
  calls.push({ url, opts });
  if (!opts.timeoutMs) throw new Error('a call without a timeout');
  const u = new URL(url);
  if (u.pathname.endsWith('/v1/vehicle-suppliers/orgs')) {
    const tok = opts.headers.authorization;
    if (tok === 'Bearer tok-eco') return { status: 200, data: { orgs: [{ id: 'org-eco-enc', name: 'ECOSINE TRANSPORTS' }, { id: 'org-parent-enc', name: 'Harbour Holdings Group' }] } };
    if (tok === 'Bearer tok-egari') return { status: 200, data: { orgs: [{ id: 'org-egari-enc', name: 'Egari Luxury Cars Transport LLC' }] } };
  }
  if (u.pathname.endsWith('/parks/users/profile')) return { status: 403, data: '<!DOCTYPE html><html>edge</html>' };
  if (u.pathname.endsWith('/getCompanyDetails')) return { status: 200, data: { code: 0, data: { country: 'ae' } } };
  if (u.pathname.endsWith('/getProfile')) return { status: 200, data: { code: 503, message: 'NOT_AUTHORIZED' } };
  if (u.pathname.endsWith('/Login')) {
    if (u.searchParams.get('username') === 'egari-login') throw new TypeError(`fetch failed (ECONNRESET) ${url}`);
    return { status: 200, data: { userid: 9001 } };
  }
  if (u.pathname.endsWith('/GetVehicleList')) {
    return { status: 200, data: { Data: [{ Vehicleno: 'T101', ClientName: 'Ecosine Transports LLC' }, { Vehicleno: 'T104', ClientName: 'Ecosine Transports LLC' }] } };
  }
  return { status: 404, data: {} };
};
const qs = (o) => Object.entries(o).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const deps = {
  http: fakeHttp, qs, normPlate: (p) => (p ? String(p).toUpperCase().replace(/[\s-]/g, '') : null),
  uberOrgs: () => [
    { fleet: 'ecosine', org: 'org-eco-enc', oauth: { clientId: 'client-eco' } },
    { fleet: 'egari', org: 'org-egari-enc', oauth: { clientId: 'client-egari' } },
  ],
  uberToken: async (o) => (o.fleet === 'ecosine' ? 'tok-eco' : 'tok-egari'),
  uberOrgsUrl: 'https://uber.example.test/v1/vehicle-suppliers/orgs',
  boltToken: async (c) => (c.fleet === 'egari' ? { at: 'portal-access' } : { at: null, err: 'refresh token expired 2026-09-01T00:00:00Z — re-capture from the portal' }),
  config: {
    yango: { parkId: 'park-test-0001', fleet: 'ecosine', cookie: 'Session_id=synthetic', base: 'https://yango.example.test' },
    bolt: { portalBase: 'https://bolt.example.test/fleetOwnerPortal', companies: [
      { fleet: 'egari', companyId: 142897, userId: 1 }, { fleet: 'ecosine', companyId: 142868, userId: 2 }] },
    fms: { base: 'http://fms.example.test/svc', fleets: [
      { fleet: 'ecosine', username: 'ecosine-login', password: SECRET }, { fleet: 'egari', username: 'egari-login', password: SECRET }] },
    hotel: { domain: 'hotel.example.test', fleet: 'ecosine' },
    cabman: { fleets: [{ fleet: 'ecosine', interfaceId: '81' }] },
  },
};
{
  const s = await runDiscovery(db, { log, deps });
  check('the run finishes with every platform stepped through', j(s.steps.map((x) => x.platform)) === j(['cabman', 'uber', 'yango', 'bolt', 'fms', 'hotel']), j(s.steps.map((x) => x.platform)));
  check('every call carried a timeout and at most one retry', calls.length > 0 && calls.every((c) => c.opts.timeoutMs > 0 && (c.opts.retries ?? 0) <= 1));
  const A = Object.fromEntries((await q(`SELECT * FROM platform_account`)).map((a) => [`${a.platform}:${a.account_id}`, a]));
  check('Uber: the configured org is linked by configuration, with its name',
    A['uber:org-eco-enc']?.status === 'linked' && A['uber:org-eco-enc'].fleet_id === 'ecosine'
    && A['uber:org-eco-enc'].link_basis === 'configuration' && A['uber:org-eco-enc'].reported_name === 'ECOSINE TRANSPORTS');
  check('…an org nobody configured arrives NEW (a parent org is not a fleet)', A['uber:org-parent-enc']?.status === 'new'
    && A['uber:org-parent-enc'].filed_fleet === null);
  check('…Egari’s own client names Egari', A['uber:org-egari-enc']?.reported_name === 'Egari Luxury Cars Transport LLC' && A['uber:org-egari-enc'].fleet_id === 'egari');
  check('Yango: the park is recorded; the refusal is its reason, not an error',
    A['yango:park-test-0001']?.status === 'linked' && A['yango:park-test-0001'].reported_name === null
    && /refused the profile call \(HTTP 403 — an HTML page from Yandex’s edge/.test(A['yango:park-test-0001'].name_reason || ''), A['yango:park-test-0001']?.name_reason);
  check('Bolt: a portal that cannot be signed into is the reason, with the real company id',
    /could not be signed into for company 142868: refresh token expired/.test(A['bolt:142868']?.name_reason || ''), A['bolt:142868']?.name_reason);
  check('…a portal that answers without a name says which calls said what',
    /getCompanyDetails answered with no company name; getProfile: NOT_AUTHORIZED code=503/.test(A['bolt:142897']?.name_reason || ''), A['bolt:142897']?.name_reason);
  check('FMS: the login is keyed by its numeric userid, never its login name', A['fms:9001']?.status === 'linked'
    && !Object.keys(A).some((k) => k.includes('ecosine-login')));
  check('…named by its vehicles’ ClientName, and its vehicles kept for the evidence', A['fms:9001']?.reported_name === 'Ecosine Transports LLC'
    && (await q(`SELECT count(*)::int n FROM platform_account_vehicle WHERE account_pk = $1`, [A['fms:9001'].id]))[0].n === 2);
  const fmsNote = s.steps.find((x) => x.platform === 'fms').notes.find((n) => n.fleet === 'egari');
  check('…a login that could not be reached is a note on the run, not an account', fmsNote?.ok === false && /could not be reached/.test(fmsNote.reason || ''), j(fmsNote));
  const everything = j(await q(`SELECT * FROM platform_account`)) + j(await q(`SELECT * FROM source_state`))
    + j(await q(`SELECT detail FROM access_audit`)) + logged.join('\n');
  check('no password, login name or query string reaches the store, the audit or the log',
    !everything.includes(SECRET) && !everything.includes('egari-login') && !everything.includes('password='), '');
  check('the hotel domain is an account with the channel’s true reason', A['hotel:hotel.example.test']?.fleet_id === 'ecosine'
    && /only by its x-domain header/.test(A['hotel:hotel.example.test'].name_reason || ''));
  const F = Object.fromEntries((await q(`SELECT id, name, name_basis FROM fleet`)).map((f) => [f.id, f]));
  check('the brand becomes the fleet’s name: Ecosine (Uber and FMS agree on "Ecosine Transports")', F.ecosine.name === 'Ecosine' && F.ecosine.name_basis === 'brand', j(F.ecosine));
  check('…and Egari, from Uber alone', F.egari.name === 'Egari', j(F.egari));
  svc.resetFleetCache();
  check('/api/auth/me’s fleet list now carries the derived names', j((await svc.allFleets(db)).map((f) => f.name)) === j(['Ecosine', 'Egari']));
  check('a change of name is audited', (await q(`SELECT count(*)::int n FROM access_audit WHERE action = 'fleet.renamed'`))[0].n >= 2);

  /* A platform renames the business: re-read, re-derived, shown once. */
  deps.http = async (url, opts) => (url.endsWith('/orgs') && opts.headers.authorization === 'Bearer tok-eco'
    ? { status: 200, data: { orgs: [{ id: 'org-eco-enc', name: 'ECOSINE PASSENGER TRANSPORT' }] } } : fakeHttp(url, opts));
  await runDiscovery(db, { log, deps });
  const names = await q(`SELECT n.name FROM platform_account_name n JOIN platform_account a ON a.id = n.account_pk
                          WHERE a.account_id = 'org-eco-enc' ORDER BY n.id`);
  check('a rename by the platform keeps both names, in order', j(names.map((n) => n.name)) === j(['ECOSINE TRANSPORTS', 'ECOSINE PASSENGER TRANSPORT']), j(names));
  check('…is audited as a rename', (await q(`SELECT count(*)::int n FROM access_audit WHERE action = 'fleet.account_renamed'`))[0].n === 1);
  check('…and the brand still derives: "Ecosine"', (await q(`SELECT name FROM fleet WHERE id = 'ecosine'`))[0].name === 'Ecosine');
  deps.http = fakeHttp;
  check('clean() strips a query string from a thrown message', !clean(new Error(`GET http://h/x?username=a&password=${SECRET} failed`)).includes(SECRET));
  check('a Yango park name is read only from a park-shaped field', yangoParkName({ parks: [{ id: 'p1', name: 'X' }] }, 'p1') === 'X' && yangoParkName({ user: { name: 'someone' } }, 'p1') === null);
  check('a Bolt company name is read from its own company', boltCompanyName({ data: { companies: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] } }, 2) === 'B');
}

/* ══ 4. the routes, with the caller injected ═════════════════════════════ */
const mk = async (email, role, fleets = null) => {
  const u = await svc.createUser(db, { email, name: email.split('@')[0], status: 'active', passwordHash: hashPassword('synthetic long password') });
  await svc.createGrant(db, { userId: u.id, roleCode: role, fleets });
  return u;
};
const owner1 = await mk('owner-one@example.test', 'OWN');
const owner2 = await mk('owner-two@example.test', 'OWN');
const con = await mk('connections@example.test', 'CON');
const opsEgari = await mk('ops-egari@example.test', 'OPS', ['egari']);
const finAll = await mk('finance@example.test', 'FIN');
const conEgari = await mk('connections-egari@example.test', 'CON', ['egari']);

const principal = async (u, { stepup = true } = {}) => {
  const { grants, access } = await svc.accessForUser(db, u.id);
  return { kind: 'user', mode: 'open', user: u, grants, access, session: { id: `s${u.id}`, stepup_at: stepup ? new Date().toISOString() : null } };
};
const app = express();
app.use(express.json());
const who = new Map();
app.use(async (req, _res, next) => {
  req.fmCookies = parseCookies(req.headers.cookie);
  const as = req.get('x-test-as');
  req.fm = as ? await who.get(as)() : { kind: 'anonymous', mode: 'open' };
  next();
});
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: 'internal', detail: String(e) }));
fleetNameRoutes(app, { q, wrap, db, tx: pgliteTx(pg) });
const server = app.listen(0);
const B = `http://127.0.0.1:${server.address().port}`;
for (const [k, u, o] of [['owner1', owner1], ['owner2', owner2], ['con', con], ['ops', opsEgari], ['fin', finAll], ['conEgari', conEgari],
  ['owner1-nostep', owner1, { stepup: false }]]) who.set(k, () => principal(u, o));
const call = async (as, method, path, body, { csrf = true } = {}) => {
  const headers = { 'content-type': 'application/json', cookie: 'fm_csrf=tok123' };
  if (as) headers['x-test-as'] = as;
  if (csrf) headers['x-fm-csrf'] = 'tok123';
  const r = await fetch(B + path, { method, headers, body: body ? j(body) : undefined });
  let b = null; try { b = await r.json(); } catch { /* none */ }
  return { status: r.status, body: b, headers: r.headers };
};
const acctId = async (accountId) => Number((await q(`SELECT id FROM platform_account WHERE account_id = $1`, [accountId]))[0].id);

console.log('\n4a. reading');
{
  const r = await call(null, 'GET', '/api/fleets');
  check('GET /api/fleets answers with every fleet’s brand', r.status === 200 && j(r.body.fleets.map((f) => f.name)) === j(['Ecosine', 'Egari']), j(r.body?.fleets?.map((f) => f.name)));
  const eco = r.body.fleets[0];
  check('…the platform names it came from, each with its platform (the legal names)',
    eco.reported.some((x) => x.platform === 'uber' && x.name === 'ECOSINE PASSENGER TRANSPORT') && eco.reported.some((x) => x.platform === 'fms'));
  check('…its linked accounts with their real ids', eco.linked.some((a) => a.label === 'Bolt company 142868'));
  check('…and the rename, once', eco.renames.length === 1 && eco.renames[0].from === 'ECOSINE TRANSPORTS', j(eco.renames));
  check('…and when the platforms were last asked', typeof r.body.discovery.lastRun === 'string' && r.body.discovery.reason === null);
  check('the answer is never cached', /no-store/.test(r.headers.get('cache-control') || ''), r.headers.get('cache-control'));
  const anon = await call(null, 'GET', '/api/fleets/accounts');
  check('accounts: an anonymous reader is told to sign in', anon.status === 401 && anon.body.error === 'signin');
  const ops = await call('ops', 'GET', '/api/fleets/accounts');
  check('accounts: Operations is refused, with who can see platform logins', ops.status === 403 && ops.body.class === 'CRED'
    && /Connections admin/.test(ops.body.detail), j(ops.body));
  const c = await call('con', 'GET', '/api/fleets/accounts');
  check('accounts: the Connections admin reads them', c.status === 200 && c.body.accounts.length >= 9, String(c.body?.accounts?.length));
  const sah = c.body.accounts.find((a) => a.account_id === '81/Sahalat');
  check('…Sahalat is new, with where its rows went', sah.status === 'new' && sah.filed?.ecosine === 2 && sah.brand === 'Sahalat');
  const ecoC = c.body.accounts.find((a) => a.account_id === '81/Ecosine Transports LLC');
  check('…Ecosine Transports LLC is suggested for Ecosine: same brand, shared plates', ecoC.suggestions[0]?.fleet === 'ecosine'
    && ecoC.suggestions[0].sameBrand && ecoC.suggestions[0].plates === 2, j(ecoC.suggestions));
  check('…the Connections admin may link, and is not the Owner', c.body.me.canLink && !c.body.me.owner);
  const ev = await call('con', 'GET', `/api/fleets/accounts/${ecoC.id}/evidence`);
  check('the lists behind the counts are the Owner’s: refused to the Connections admin', ev.status === 403);
  const evo = await call('owner1', 'GET', `/api/fleets/accounts/${ecoC.id}/evidence`);
  check('…opened by the Owner: the two shared plates, by fleet', evo.status === 200
    && j(evo.body.plates.shared.filter((s) => s.fleet_id === 'ecosine').map((s) => s.plate)) === j(['T101', 'T102']), j(evo.body?.plates));
}

/* REVERSION: delete the csrfOk check in actor() — "a change without the
   CSRF header is refused" fails. REVERSION: in actor() check capsAny
   instead of capsOver(fleets) — "a Connections admin scoped to Egari cannot
   link into Ecosine" fails. */
console.log('\n4b. proposing: link, and who gains or loses');
let linkEco;
{
  const ecoC = await acctId('81/Ecosine Transports LLC');
  const anon = await call(null, 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'ecosine' });
  check('an anonymous change is refused even while sign-in is open', anon.status === 401);
  const ops = await call('ops', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'egari' });
  check('Operations cannot link (no fleets.link)', ops.status === 403 && ops.body.error === 'not_allowed');
  const noCsrf = await call('con', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'ecosine' }, { csrf: false });
  check('a change without the CSRF header is refused', noCsrf.status === 403 && noCsrf.body.error === 'csrf');
  const scoped = await call('conEgari', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'ecosine' });
  check('a Connections admin scoped to Egari cannot link into Ecosine', scoped.status === 403 && /ecosine/.test(scoped.body.detail), j(scoped.body));
  const bad = await call('con', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'nowhere' });
  check('an unknown fleet is a 400 that names it', bad.status === 400 && /nowhere/.test(bad.body.detail));
  const dry = await call('con', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'ecosine', dry_run: true });
  check('a dry run shows the impact and stores nothing', dry.status === 200 && dry.body.dry_run
    && (await q(`SELECT count(*)::int n FROM fleet_change WHERE status = 'pending'`))[0].n === 0);
  const r = await call('con', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'ecosine', reason: 'same brand, 2 shared plates' });
  check('a link is stored as pending (202), nothing moves yet', r.status === 202 && r.body.status === 'pending'
    && (await q(`SELECT status FROM platform_account WHERE id = $1`, [ecoC]))[0].status === 'new');
  check('…linking to where its rows already are moves nobody: no one gains or loses', r.body.impact.gains === 0 && r.body.impact.loses === 0, j(r.body.impact));
  check('…and a Connections admin sees how many, not who', r.body.impact.namesWithheld === true);
  linkEco = r.body.change;
  const dup = await call('con', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'egari' });
  check('a second pending change for the same account is refused', dup.status === 409 && dup.body.error === 'pending');

  const sah = await acctId('81/Sahalat');
  const imp = await visibilityImpact(db, { from: 'ecosine', to: 'egari' });
  check('moving Sahalat from Ecosine to Egari: the Egari-only person gains, nobody with every fleet is affected',
    j(imp.gains.map((g) => g.label).sort()) === j(['connections-egari', 'ops-egari']) && imp.loses.length === 0, j(imp));
  const newImp = await visibilityImpact(db, { from: 'ecosine', newFleet: 'sahalat' });
  check('a new fleet is seen only by grants over every fleet, so Egari-only people see nothing new',
    newImp.gains.length === 0 && !newImp.loses.some((l) => l.label === 'finance'), j(newImp));
}

/* REVERSION: in approve, delete `if (!sole) return fail(… 'four_eyes' …)` —
   "the proposer cannot approve while another Owner exists" fails.
   REVERSION: delete the isOwner check in approve — "the Connections admin
   cannot approve" fails. */
console.log('\n4c. approving');
{
  const byCon = await call('con', 'POST', `/api/fleets/changes/${linkEco}/approve`);
  check('the Connections admin cannot approve', byCon.status === 403 && byCon.body.error === 'not_allowed');
  const noStep = await call('owner1-nostep', 'POST', `/api/fleets/changes/${linkEco}/approve`);
  check('an Owner who has not re-confirmed is asked to (403 stepup, which access.js post() answers)', noStep.status === 403 && noStep.body.error === 'stepup');
  const ok = await call('owner1', 'POST', `/api/fleets/changes/${linkEco}/approve`);
  check('an Owner approves it', ok.status === 200 && ok.body.applied);
  const a = (await q(`SELECT status, fleet_id, link_basis FROM platform_account WHERE account_id = '81/Ecosine Transports LLC'`))[0];
  check('…the account is linked, by a person', a.status === 'linked' && a.fleet_id === 'ecosine' && a.link_basis === 'person');
  const again = await call('owner2', 'POST', `/api/fleets/changes/${linkEco}/approve`);
  check('…and cannot be approved twice', again.status === 404);
  const junk = await call('owner2', 'POST', '/api/fleets/changes/undefined/approve');
  const junk2 = await call('owner2', 'GET', '/api/fleets/accounts/1e3/evidence');
  check('a malformed id is "nothing with that number", never a 500', junk.status === 404 && junk2.status === 404, `${junk.status} ${junk2.status}`);
  const r = await call(null, 'GET', '/api/fleets');
  const eco = r.body.fleets.find((f) => f.id === 'ecosine');
  /* Uber renamed the business in section 3 ("ECOSINE PASSENGER TRANSPORT"),
     so the names now share only their first word — and the brand is still
     that word. The rule, not a coincidence of spellings. */
  check('the fleet still reads "Ecosine": with Uber’s new name the platforms share only that word',
    eco.name === 'Ecosine' && eco.common === 'Ecosine' && eco.reported.some((x) => x.platform === 'cabman' && x.name === 'Ecosine Transports LLC'),
    j({ n: eco.name, c: eco.common }));

  const ecoC = await acctId('81/Ecosine Transports LLC');
  const prop = await call('owner1', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'unlink', reason: 'test of four eyes' });
  check('an Owner may propose', prop.status === 202);
  const self = await call('owner1', 'POST', `/api/fleets/changes/${prop.body.change}/approve`);
  check('the proposer cannot approve while another Owner exists', self.status === 403 && self.body.error === 'four_eyes', j(self.body));
  const other = await call('owner2', 'POST', `/api/fleets/changes/${prop.body.change}/approve`);
  check('…the other Owner can', other.status === 200 && (await q(`SELECT status FROM platform_account WHERE id = $1`, [ecoC]))[0].status === 'new');

  /* The only Owner: §6.4's wait, which is none while sign-in is open. */
  const g2 = (await svc.listGrants(db, { userId: owner2.id })).find((g) => g.role_code === 'OWN');
  await svc.endGrant(db, g2.id, owner1.id);
  const solo = await call('owner1', 'POST', `/api/fleets/accounts/${ecoC}`, { action: 'link', fleet: 'ecosine' });
  await svc.setConfig(db, 'mode', 'enforced', owner1.id);
  await svc.getConfig(db, { fresh: true });
  const wait = await call('owner1', 'POST', `/api/fleets/changes/${solo.body.change}/approve`);
  check('the only Owner’s own change waits the company’s delay once sign-in is required', wait.status === 403 && wait.body.error === 'wait'
    && /24 hours/.test(wait.body.detail), j(wait.body));
  await svc.setConfig(db, 'mode', 'open', owner1.id);
  await svc.getConfig(db, { fresh: true });
  const soloOk = await call('owner1', 'POST', `/api/fleets/changes/${solo.body.change}/approve`);
  check('…and while sign-in is open, when a delay protects nothing, the only Owner may approve it', soloOk.status === 200, j(soloOk.body));
  await svc.createGrant(db, { userId: owner2.id, roleCode: 'OWN' });
}

/* REVERSION: in the approve route drop the from_fleet comparison — "a change
   whose account has moved since is set aside" fails (it would re-link). */
console.log('\n4d. ignoring, starting a new fleet, declining, a stale change');
{
  const sah = await acctId('81/Sahalat');
  const noWhy = await call('con', 'POST', `/api/fleets/accounts/${sah}`, { action: 'ignore' });
  check('ignoring needs a reason', noWhy.status === 400 && noWhy.body.error === 'reason');
  const ig = await call('con', 'POST', `/api/fleets/accounts/${sah}`, { action: 'ignore', reason: 'another operator’s cars on our CABMAN interface' });
  check('ignoring a NEW account applies at once (it moves nobody’s rows)', ig.status === 200 && ig.body.applied && ig.body.status === 'ignored');
  check('…and says its rows stay where they were filed', /2 under ecosine/.test(ig.body.detail || ''), ig.body.detail);
  const un = await call('con', 'POST', `/api/fleets/accounts/${sah}`, { action: 'unignore' });
  check('…and can be undone', un.status === 200 && (await q(`SELECT status FROM platform_account WHERE id = $1`, [sah]))[0].status === 'new');

  const nf = await call('con', 'POST', `/api/fleets/accounts/${sah}`, { action: 'new', reason: 'a business of its own' });
  check('starting a new fleet from Sahalat proposes the id its brand gives: "sahalat"', nf.status === 202 && nf.body.fleet === 'sahalat', j(nf.body));
  const ap = await call('owner2', 'POST', `/api/fleets/changes/${nf.body.change}/approve`);
  const fl = (await q(`SELECT id, name, name_basis, created_from FROM fleet WHERE id = 'sahalat'`))[0];
  check('an Owner approves: the fleet exists, named "Sahalat" from its platform', ap.status === 200 && fl?.name === 'Sahalat' && fl.name_basis === 'brand' && Number(fl.created_from) === sah, j(fl));
  svc.resetFleetCache();
  check('…and every page that asks the server for fleets now has three', (await svc.allFleets(db)).length === 3);
  check('a new fleet id is never invented: without a name it is the platform and account id',
    newFleetId({ platform: 'bolt', account_id: '142868', reported_name: null }, ['ecosine']) === 'bolt-142868');

  const eco = await acctId('81/Ecosine Transports LLC');
  const p = await call('con', 'POST', `/api/fleets/accounts/${eco}`, { action: 'link', fleet: 'egari' });
  const w = await call('con', 'POST', `/api/fleets/changes/${p.body.change}/decline`, { reason: '' });
  check('the proposer may withdraw their own change', w.status === 200 && w.body.status === 'withdrawn');
  const p2 = await call('con', 'POST', `/api/fleets/accounts/${eco}`, { action: 'unlink' });
  const d0 = await call('owner1', 'POST', `/api/fleets/changes/${p2.body.change}/decline`, {});
  check('an Owner declining says why', d0.status === 400 && d0.body.error === 'reason');
  const d1 = await call('owner1', 'POST', `/api/fleets/changes/${p2.body.change}/decline`, { reason: 'it is Ecosine’s' });
  check('…and then it is declined', d1.status === 200 && d1.body.status === 'declined');
  const opsDecline = await call('ops', 'POST', `/api/fleets/changes/${p2.body.change}/decline`, { reason: 'x y z' });
  check('someone who neither proposed it nor owns cannot decline', opsDecline.status === 404 || opsDecline.status === 403);

  const p3 = await call('con', 'POST', `/api/fleets/accounts/${eco}`, { action: 'unlink' });
  await q(`UPDATE platform_account SET status = 'new', fleet_id = NULL WHERE id = $1`, [eco]);
  const st = await call('owner2', 'POST', `/api/fleets/changes/${p3.body.change}/approve`);
  check('a change whose account has moved since is set aside, not applied', st.status === 409 && st.body.error === 'superseded'
    && (await q(`SELECT status FROM fleet_change WHERE id = $1`, [p3.body.change]))[0].status === 'superseded');
}

/* REVERSION: in the name route skip isCandidate — "a word the platforms
   never sent is refused" fails. */
console.log('\n4e. choosing the name, never typing it');
{
  const typed = await call('con', 'POST', '/api/fleets/egari/name', { words: 'Egari Limousines' });
  check('a word the platforms never sent is refused, with the choices', typed.status === 400 && /“Egari Luxury”/.test(typed.body.detail), j(typed.body));
  const ops = await call('ops', 'POST', '/api/fleets/egari/name', { words: 'Egari Luxury' });
  check('Operations cannot choose a name', ops.status === 403);
  const ok = await call('con', 'POST', '/api/fleets/egari/name', { words: 'Egari Luxury', reason: 'what the office calls it' });
  check('the Connections admin chooses "Egari Luxury": it is the name', ok.status === 200 && ok.body.fleet.name === 'Egari Luxury' && ok.body.fleet.basis === 'chosen', j(ok.body?.fleet?.name));
  check('…written where /api/auth/me reads it', (await q(`SELECT name FROM fleet WHERE id = 'egari'`))[0].name === 'Egari Luxury');
  check('…and listed in the fleet’s name history', ok.body.fleet.nameChoices[0]?.words === 'egari luxury');
  const back = await call('con', 'POST', '/api/fleets/egari/name', { words: '' });
  check('clearing the choice returns to the derived brand', back.status === 200 && back.body.fleet.name === 'Egari');
}

console.log('\n4f. the audit trail');
{
  const acts = (await q(`SELECT action FROM access_audit WHERE action LIKE 'fleet.%'`)).map((r) => r.action);
  for (const a of ['fleet.change_proposed', 'fleet.change_approved', 'fleet.account_ignored', 'fleet.name_chosen', 'fleet.change_declined', 'fleet.account_linked_by_configuration']) {
    check(`audited: ${a}`, acts.includes(a));
  }
  const v = await verifyChain(db);
  check('the audit chain verifies', v.ok, j(v));
}
server.close();

/* ══ 5. through the real access layer, with the proposed manifest ═════════
   The entries this change asks the orchestrator to add to
   api/access/manifest.json, checked by the gate itself. REVERSION: give
   'POST /api/fleets/accounts/:id' cap null — the gate refuses every write
   ("a write with no action"), and "the Connections admin proposes through
   the gate" fails. */
console.log('\n5. through the real gate');
{
  const ENTRIES = [
    { method: 'GET', path: '/api/fleets', subject: 'SYS', carries: ['SYS'], grain: 'aggregate', fields: [], whole: [], fleet: 'global', fleetRows: [], fleetKey: '', cap: null },
    { method: 'GET', path: '/api/fleets/accounts', subject: 'CRED', carries: ['CRED', 'SYS'], grain: 'list', fields: [], whole: [], fleet: 'global', fleetRows: [], fleetKey: '', cap: null },
    { method: 'GET', path: '/api/fleets/accounts/:id/evidence', subject: 'CRED', carries: ['CRED', 'VEH', 'ID'], grain: 'list', fields: [], whole: ['VEH', 'ID'], fleet: 'global', fleetRows: [], fleetKey: '', cap: null, auditRead: true },
    { method: 'POST', path: '/api/fleets/accounts/:id', subject: 'CRED', carries: ['CRED'], grain: 'none', fields: [], whole: [], fleet: 'global', fleetRows: [], fleetKey: '', cap: 'fleets.link' },
    { method: 'POST', path: '/api/fleets/:id/name', subject: 'SYS', carries: ['SYS'], grain: 'none', fields: [], whole: [], fleet: 'global', fleetRows: [], fleetKey: '', cap: 'fleets.link' },
    { method: 'POST', path: '/api/fleets/changes/:id/approve', subject: 'CRED', carries: ['CRED'], grain: 'none', fields: [], whole: [], fleet: 'global', fleetRows: [], fleetKey: '', cap: 'fleets.link', stepup: true },
    { method: 'POST', path: '/api/fleets/changes/:id/decline', subject: 'CRED', carries: ['CRED'], grain: 'none', fields: [], whole: [], fleet: 'global', fleetRows: [], fleetKey: '', cap: 'fleets.link' },
  ];
  const pat = ENTRIES.map((e) => ({ e, re: new RegExp(`^${e.path.replace(/:[a-z]+/g, '[^/]+')}$`) }));
  const lookup = (m, p) => {
    if (p.startsWith('/api/auth/') || p.startsWith('/api/access/')) return { self: true, subject: 'SYS', carries: [], grain: 'none', fields: [], whole: [], fleet: 'global' };
    return pat.find((x) => x.e.method === (m === 'HEAD' ? 'GET' : m) && x.re.test(p))?.e || null;
  };
  await svc.setConfig(db, 'mfa', 'none', owner1.id);
  await svc.getConfig(db, { fresh: true });
  const gapp = express();
  gapp.use(express.json());
  const layer = accessLayer({ db, lookup });
  gapp.use(layer.identify);
  gapp.use(layer.gate);
  accessRoutes(gapp, { db, layer, wrap });
  fleetNameRoutes(gapp, { q, wrap, db, tx: pgliteTx(pg) });
  const gs = gapp.listen(0);
  const G = `http://127.0.0.1:${gs.address().port}`;
  const browser = () => {
    const jar = {};
    const go = async (method, path, body) => {
      const h = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), 'content-type': 'application/json' };
      if (jar.fm_csrf && method !== 'GET') h['x-fm-csrf'] = decodeURIComponent(jar.fm_csrf);
      const r = await fetch(G + path, { method, headers: h, body: body ? j(body) : undefined });
      for (const c of r.headers.getSetCookie?.() || []) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        if (/Max-Age=0/.test(c)) delete jar[kv.slice(0, i)]; else jar[kv.slice(0, i)] = kv.slice(i + 1);
      }
      let b = null; try { b = await r.json(); } catch { /* none */ }
      return { status: r.status, body: b };
    };
    return { get: (p) => go('GET', p), post: (p, b = {}) => go('POST', p, b) };
  };
  const signIn = async (email) => {
    const b = browser();
    await b.get('/api/auth/me');
    const r = await b.post('/api/auth/login', { email, password: 'synthetic long password' });
    return r.status === 200 ? b : null;
  };
  const conB = await signIn('connections@example.test');
  const opsB = await signIn('ops-egari@example.test');
  const ownB = await signIn('owner-two@example.test');
  check('three synthetic people sign in', conB && opsB && ownB);
  const r1 = await opsB.get('/api/fleets');
  check('any signed-in role reads the fleet names through the gate', r1.status === 200 && r1.body.fleets.length === 3);
  const r2 = await opsB.get('/api/fleets/accounts');
  check('the gate itself refuses accounts to Operations (CRED)', r2.status === 403 && r2.body.class === 'CRED');
  const sah = await acctId('81/Star Skyline Luxury Transport LLC').catch(() => null);
  const eco = await acctId('81/Ecosine Transports LLC');
  const r3 = await conB.post(`/api/fleets/accounts/${eco}`, { action: 'link', fleet: 'ecosine' });
  check('the Connections admin proposes through the gate', r3.status === 202, j(r3.body));
  const r4 = await opsB.post(`/api/fleets/accounts/${eco}`, { action: 'link', fleet: 'egari' });
  /* The gate judges the subject before the action: Operations holds no
     platform-login class at all, so it is refused as withheld CRED. */
  check('the gate refuses Operations (no platform logins, so no action on them)', r4.status === 403
    && (r4.body.class === 'CRED' || r4.body.cap === 'fleets.link'), j(r4.body));
  const r5 = await ownB.post(`/api/fleets/changes/${r3.body.change}/approve`);
  check('the gate asks the Owner to re-confirm before approving', r5.status === 403 && r5.body.error === 'stepup', j(r5.body));
  const su = await ownB.post('/api/auth/stepup', { password: 'synthetic long password' });
  const r6 = await ownB.post(`/api/fleets/changes/${r3.body.change}/approve`);
  check('…and once re-confirmed, it is approved', su.status === 200 && r6.status === 200, j(r6.body));
  check('(no Star Skyline account was ever made up)', sah === null);
  gs.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
