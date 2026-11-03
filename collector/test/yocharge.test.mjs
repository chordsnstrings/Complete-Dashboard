/* CHARGING FROM POWERDRIVE (YoCharge) — src/sources/yocharge.js and
   api/charging_routes.js, against a real schema (PGlite) and a fake PowerDrive
   that records every request.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-11-03: "the name match might be different so we need to
   be very precise before we incorporate anything into production", then
   "let's figure out how we can have all sessions as well. we can track how
   many times each vehicles are charging". What is pinned:
     1. the collector can only READ: every request it makes is a GET — the API
        behind this key can credit wallets and stop live charges;
     2. units as PowerDrive sends them: watt-hours (÷ 1000), seconds, AED;
     3. the link is automatic ONLY on a mobile held by exactly one of our people
        and one customer with the names agreeing; everything else is a candidate
        with its reason; a person's decision is never touched by a run;
     4. only watched customers' sessions are stored, ever;
     5. each charge is put on a car by the session's own plate, the only car the
        driver drove that day, or the nearest booking — and says which;
     6. the routes: a person's money is absent with a reason when no wallet is
        linked; deciding a link needs a signed-in Owner/Access admin/Ops manager.
   Synthetic people (Test Driver …), plates (C…) and numbers (+9715000…) only.
   REVERSIONS, run 2026-11-03, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import * as yc from '../src/sources/yocharge.js';
import { chargingRoutes } from '../api/charging_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const noSleep = async () => {};

/* ── a fake PowerDrive ──────────────────────────────────────────────────── */
const calls = [];
let status = 200;
const json = (body, st = 200) => ({ status: st, json: async () => body, text: async () => JSON.stringify(body) });
function page(list, url) {
  const p = Number(url.searchParams.get('page') || 1);
  const size = Number(url.searchParams.get('page_size') || 10);
  const slice = list.slice((p - 1) * size, p * size);
  return { count: list.length, next: p * size < list.length ? 'more' : null, previous: null, results: slice };
}
const U = (o) => ({ id: o.id, name: o.name, email: o.email || null, mobile_country_code: o.cc ?? '+971', mobile_number: o.mob,
  fleet_group: o.fg ? { name: o.fg } : null, is_using_fleet_wallet: !!o.fw, fleet_limit: o.fw ? '500.00' : null,
  fleet_limit_available: o.fw ? '320.50' : null, fleet_limit_used: o.fw ? '179.50' : null, last_charging_session: '2026-11-02T08:00:00.000000Z',
  is_active: true, is_deleted: false, is_archived: false,
  vehicles: o.vn ? [{ vehicle_id: `v-${o.id}`, name: 'Tesla Model Y', vehicle_number: o.vn }] : [],
  wallets: [{ id: `w-${o.id}`, type: 'PERSONAL', balance: o.bal ?? '0.00', hold_amount: '0.00', custom_credit_limit: null }] });
const USERS = [
  U({ id: 'yA', name: 'Test Driver Alpha', mob: '501000001', fg: 'ecofleet', bal: '120.50' }),       // unique phone, names agree → auto
  U({ id: 'yB', name: 'Someone Else Entirely', mob: '501000002', fg: 'egari', bal: '15.00' }),       // unique phone, names disagree → candidate
  U({ id: 'yC', name: 'Test Driver Gamma', mob: '501000003', bal: '9.00' }),                         // number on two of our people → candidates
  U({ id: 'yD1', name: 'Test Driver Delta', mob: '501000004', bal: '1.00' }),                        // two customers share a number
  U({ id: 'yD2', name: 'Test Driver Delta', mob: '0501000004', bal: '2.00' }),
  U({ id: 'yE', name: 'Test Driver Epsilon', mob: '+971 50 100 0005', email: 'epsilon@example.test', bal: '-12.25' }), // email + phone: auto
  U({ id: 'yF', name: 'Test Driver Foxtrot', mob: '559999999', email: 'foxtrot@example.test', bal: '3.00' }), // email only → candidate
  U({ id: 'yG', name: 'Test Driver Golf', mob: '558888888', fg: 'ecofleet', bal: '0.00' }),          // name only, in our fleet group → candidate
  U({ id: 'yH', name: 'Test Driver Hotel', mob: '557777777', bal: '0.00' }),                         // name only, outside → nothing
  U({ id: 'yI', name: 'Test Driver India', mob: '501000009', fg: 'ecofleet', fw: true, bal: '0.00', vn: 'C21' }), // fleet wallet, auto
  U({ id: 'yZ', name: 'A Stranger', mob: '509999999', bal: '77.00' }),                               // not ours at all
  U({ id: 'yK', name: 'Unknown Fleet Member', mob: '506666666', fg: 'egari', bal: '0.00' }),          // in our fleet group, matches nobody
];
const S = (o) => ({ id: o.id, user: { id: o.user, name: 'x', is_using_fleet_wallet: false, mobile_number: 'x' },
  vehicle: { vehicle_id: 'v', name: 'Tesla Model Y', vehicle_number: o.vn ?? null }, units_consumed: o.wh, duration: o.s, charging_duration: o.s,
  status: o.st || 'COMPLETED', soc_start: 20, soc_end: 80, created_at: o.at, server_start_time: o.at, server_stop_time: o.stop || o.at, end_date: null,
  payment: { amount: String(o.cost ?? 0), amount_without_tax: '0', total_cost: { excl_vat: (o.cost ?? 0) / 1.05, incl_vat: o.cost ?? 0 }, currency: 'AED' },
  property: { id: 'p1', name: 'Test Charging Hub' }, connector: { connector_hid: 'c1', charger: { name: 'Charger 1' } },
  anomaly: false, anomaly_type: null, is_emsp_session: false });
const RECENT = [
  S({ id: 's1', user: 'yA', wh: 10335, s: 709, cost: 13.02, at: '2026-11-02T06:00:00Z' }),            // Alpha drove C1 only that day → only_car
  S({ id: 's2', user: 'yI', wh: 20000, s: 1200, cost: 25, at: '2026-11-02T07:00:00Z', vn: 'C21' }),   // its own plate → session_plate
  S({ id: 's3', user: 'yE', wh: 5000, s: 300, cost: 6, at: '2026-11-02T10:00:00Z' }),                 // Epsilon drove two cars → nearest
  S({ id: 's4', user: 'yA', wh: 0, s: 49, cost: 0, st: 'CANCELLED', at: '2026-11-02T06:30:00Z' }),    // no energy: not a charge
  S({ id: 's5', user: 'yZ', wh: 9000, s: 600, cost: 11, at: '2026-11-02T08:00:00Z' }),                // a stranger: never stored
  S({ id: 's6', user: 'yG', wh: 7000, s: 500, cost: 8, at: '2026-11-02T09:00:00Z' }),                 // Golf (confirmed below) drove nothing → no_trip
  S({ id: 's7', user: 'yK', wh: 4000, s: 400, cost: 5, at: '2026-11-02T11:00:00Z' }),                 // fleet member, linked to nobody → no_link
];
const HISTORY = { yA: [S({ id: 'h1', user: 'yA', wh: 15000, s: 900, cost: 18, at: '2026-10-20T05:00:00Z' }),
  S({ id: 'hX', user: 'yZ', wh: 1, s: 1, cost: 1, at: '2026-10-20T05:00:00Z' })] };   // the host sending another user's row: dropped
async function fakeFetch(u, opts = {}) {
  calls.push({ method: opts.method, url: u, headers: opts.headers });
  if (status !== 200) return json({ detail: 'Token does not exist.' }, status);
  const url = new URL(u);
  if (url.pathname === '/open/v1/users/') return json(page(USERS, url));
  if (url.pathname === '/open/v1/mini-transactions/') return json(page(RECENT, url));
  if (url.pathname === '/v3/mini-transactions/') return json(page(HISTORY[url.searchParams.get('user_id')] || [], url));
  return json({ detail: 'not found' }, 404);
}

/* ── our side ───────────────────────────────────────────────────────────── */
const person = async (name, accounts, email = null) => {
  const [d] = await q('INSERT INTO driver (full_name, email) VALUES ($1, $2) RETURNING id', [name, email]);
  for (const [platform, ext, phone, display] of accounts) {
    await q('INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name) VALUES ($1, $2, $3, $4)', [platform, ext, d.id, display || name]);
    if (phone) await q('INSERT INTO driver_compliance (platform, driver_ext_id, full_name, phone) VALUES ($1, $2, $3, $4)', [platform, ext, name, phone]);
  }
  return String(d.id);
};
const P = {
  A: await person('Test Driver Alpha', [['uber', 'uA', '+971501000001']]),
  B: await person('Test Driver Bravo', [['uber', 'uB', '0501000002']]),
  C1: await person('Test Driver Gamma One', [['uber', 'uC1', '+971501000003']]),
  C2: await person('Test Driver Gamma Two', [['bolt', 'bC2', '971501000003']]),
  D: await person('Test Driver Delta', [['uber', 'uD', '+971501000004']]),
  E: await person('Test Driver Epsilon', [['uber', 'uE', '+971501000005'], ['bolt', 'bE', null]], 'epsilon@example.test'),
  F: await person('Test Driver Foxtrot', [['uber', 'uF', '+971501000006']], 'foxtrot@example.test'),
  G: await person('Test Driver Golf', [['uber', 'uG', '+971501000007']]),
  H: await person('Test Driver Hotel', [['uber', 'uH', '+971501000008']]),
  I: await person('Test Driver India', [['uber', 'uI', '+971501000009']]),
};
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine') ON CONFLICT DO NOTHING`);
await q(`INSERT INTO vehicle (plate) VALUES ('C1'), ('C2'), ('C3'), ('C21') ON CONFLICT DO NOTHING`);
let tn = 0;
const trip = (platform, ext, plate, at) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, status, price, currency, raw)
   VALUES ($1, $2, 'ecosine', $3, 'Test Driver', $4, $5::timestamptz, 'completed', 30, 'AED', '{}'::jsonb)`, [platform, `t${++tn}`, ext, plate, at]);
await trip('uber', 'uA', 'C1', '2026-11-02T04:00:00Z');                    // Alpha: C1 only, 2 Nov
await trip('uber', 'uA', 'C1', '2026-11-02T09:00:00Z');
await trip('uber', 'uE', 'C2', '2026-11-02T05:00:00Z');                    // Epsilon: C2 early, C3 near 10:00 — two accounts
await trip('bolt', 'bE', 'C3', '2026-11-02T10:20:00Z');
await trip('uber', 'uA', 'C1', '2026-10-20T03:00:00Z');                    // for the history session

/* ── 1. read-only ───────────────────────────────────────────────────────── */
console.log('\n1. the collector can only read');
const now = new Date('2026-11-03T05:00:00Z');
const run = await yc.collect({ db, now, fetchImpl: fakeFetch, sleep: noSleep, key: 'test-key', clientId: 'tenant-1', host: 'https://pd.example',
  log: { info() {}, warn() {} } });
check('every request it made is a GET, to the host it was given, with the key and the tenant', calls.length > 0
  && calls.every((c) => c.method === 'GET' && c.url.startsWith('https://pd.example/') && c.headers.Authorization === 'Token test-key'
    && c.headers['client-id'] === 'tenant-1'), j(calls.slice(0, 2).map((c) => [c.method, c.url])));
const src = readFileSync(new URL('../src/sources/yocharge.js', import.meta.url), 'utf8');
check('…and the module holds no other method: no POST, PUT, PATCH or DELETE anywhere in it',
  !/method:\s*['"](?!GET)/i.test(src) && !/['"](POST|PUT|PATCH|DELETE)['"]/.test(src));
check('no key or no tenant: nothing is asked at all',
  (await yc.collect({ db, fetchImpl: () => { throw new Error('asked'); }, key: '', clientId: 'x' })).skipped === 'YOCHARGE_API_KEY is not set'
  && (await yc.collect({ db, fetchImpl: () => { throw new Error('asked'); }, key: 'k', clientId: '' })).skipped === 'YOCHARGE_CLIENT_ID is not set');

/* ── 2. units ───────────────────────────────────────────────────────────── */
console.log('\n2. as PowerDrive counts');
const s1 = yc.sessionRow(RECENT[0]);
check('watt-hours ÷ 1000: 10,335 is 10.335 kWh; seconds stay seconds; the payment\'s AED, VAT included',
  s1.kwh === 10.335 && s1.duration_s === 709 && s1.cost_incl_vat === 13.02 && s1.currency === 'AED', j(s1));
/* REVERSION (run 2026-11-03): kwh: wh (no ÷ 1000) -> this check fails
   (10335 kWh — a thousand times the charge). */
check('a mobile in any of the spellings PowerDrive keeps it, normalised as the house does',
  ['501000001', '0501000001', '+971 50 100 0001'].every((m) => yc.phoneOf({ mobile_country_code: '+971', mobile_number: m }) === '971501000001')
  && yc.phoneOf({ mobile_country_code: '+44', mobile_number: '7700900123' }) === null);
const wa = yc.userRow(USERS[0]);
check('a customer\'s wallet: the PERSONAL balance, the fleet group, the fleet-wallet limit when on one',
  wa.balance === 120.5 && wa.fleet_group === 'ecofleet' && yc.userRow(USERS[9]).fleet_limit_available === 320.5 && yc.userRow(USERS[9]).using_fleet_wallet === true);

/* ── 3. the link ────────────────────────────────────────────────────────── */
console.log('\n3. linked only when it is certain');
const links = await q(`SELECT yc_user_id, person_id::text AS p, tier, reason FROM charging_link ORDER BY yc_user_id, person_id`);
const tierOf = (y, p) => links.find((l) => l.yc_user_id === y && l.p === p)?.tier || null;
const reasonOf = (y) => links.filter((l) => l.yc_user_id === y).map((l) => l.reason).join(' | ');
check('automatic: a mobile held by one of our people and one customer, the names agreeing — Alpha, Epsilon, India',
  tierOf('yA', P.A) === 'auto' && tierOf('yE', P.E) === 'auto' && tierOf('yI', P.I) === 'auto'
  && links.filter((l) => l.tier === 'auto').length === 3, j(links));
check('the mobile matches but the names share no word: a candidate, not a link', tierOf('yB', P.B) === 'candidate' && /share no word/.test(reasonOf('yB')));
/* REVERSION (run 2026-11-03): the name-agreement test removed -> this check
   fails (Bravo's wallet linked automatically to "Someone Else Entirely"). */
check('a mobile on two of our people: both offered, neither chosen', tierOf('yC', P.C1) === 'candidate' && tierOf('yC', P.C2) === 'candidate'
  && /2 of our records/.test(reasonOf('yC')));
check('two customers on one mobile: offered, not linked', tierOf('yD1', P.D) === 'candidate' && tierOf('yD2', P.D) === 'candidate'
  && /2 PowerDrive customers share/.test(reasonOf('yD1')));
check('an email alone: a candidate', tierOf('yF', P.F) === 'candidate' && /email matches/.test(reasonOf('yF')));
check('a name alone: a candidate inside our fleet groups, nothing outside them', tierOf('yG', P.G) === 'candidate' && !links.some((l) => l.yc_user_id === 'yH'));
check('a stranger is linked to nobody', !links.some((l) => l.yc_user_id === 'yZ'));
/* …and not KEPT: every customer is read so a link can be judged against all
   of them, then a stranger's details are deleted — counted, not held. */
const keptUsers = (await q(`SELECT yc_user_id FROM charging_user ORDER BY 1`)).map((r) => r.yc_user_id);
check('a stranger is not kept: read, counted and deleted; our fleet groups and anyone matching one of our people stay',
  !keptUsers.includes('yZ') && !keptUsers.includes('yH') && keptUsers.includes('yK') && keptUsers.includes('yA') && run.pruned === 2
  && keptUsers.length === USERS.length - 2, j([keptUsers, run.pruned]));
/* REVERSION (run 2026-11-03): pruneStrangers not called -> this check fails
   (A Stranger's name, mobile and AED 77 balance stored). */
/* A person's decisions survive every run. */
await q(`UPDATE charging_link SET tier = 'refused', decided_by = 'owner@example.test' WHERE yc_user_id = 'yB' AND person_id = $1`, [P.B]);
await q(`DELETE FROM charging_link WHERE yc_user_id = 'yG'`);
await q(`INSERT INTO charging_link (yc_user_id, person_id, tier, decided_by) VALUES ('yG', $1, 'confirmed', 'owner@example.test')`, [P.G]);
await yc.linkUsers({ q });
const after = await q(`SELECT yc_user_id, person_id::text AS p, tier FROM charging_link ORDER BY 1, 2`);
check('a refused pair is never offered again, and a confirmed one is left exactly as it is',
  after.find((l) => l.yc_user_id === 'yB' && l.p === P.B)?.tier === 'refused' && after.filter((l) => l.yc_user_id === 'yB').length === 1
  && after.find((l) => l.yc_user_id === 'yG')?.tier === 'confirmed' && after.filter((l) => l.yc_user_id === 'yG').length === 1, j(after));

/* ── 4. sessions: ours only ─────────────────────────────────────────────── */
console.log('\n4. only our customers\' sessions');
const stored = await q(`SELECT id, yc_user_id, plate, plate_basis, kwh::float AS kwh FROM charging_session ORDER BY id`);
check('a stranger\'s session is never stored — from the day\'s feed or from a history page that carried one',
  !stored.some((s) => s.yc_user_id === 'yZ') && !stored.some((s) => s.id === 'hX' || s.id === 's5'), j(stored.map((s) => s.id)));
/* REVERSION (run 2026-11-03): the watched filter removed from syncSessions ->
   this check fails (s5, a stranger's charge, stored). */
check('our customers\' sessions and their history are — a fleet member linked to nobody included', ['s1', 's2', 's3', 's4', 's6', 's7', 'h1'].every((id) => stored.some((s) => s.id === id)), j(stored.map((s) => s.id)));
check('the history is read once per customer: the run says how many it did and how many wait',
  run.sessions?.backfilled > 0 && run.sessions.waiting === 0, j(run.sessions));
/* A missed run is caught up: the day feed starts from the last day read, at
   most CATCH_UP_DAYS back, never later than INCREMENTAL_DAYS ago. */
{
  const starts = [];
  const spy = async (path, params) => { if (path === '/open/v1/mini-transactions/') starts.push(params.start_date); return { results: [], next: null }; };
  const w = new Set(['yA']);
  const setThrough = (d) => q(`UPDATE source_state SET value = $1 WHERE source = 'yocharge' AND key = 'sessions_through'`, [JSON.stringify(d)]);
  const later = new Date('2026-11-13T05:00:00Z');                       // ten days after the first run
  await yc.syncSessions({ q, ycGet: spy, now: later, watched: w, sleep: noSleep });
  await setThrough('2026-09-01');                                        // a key broken for two months
  await yc.syncSessions({ q, ycGet: spy, now: later, watched: w, sleep: noSleep });
  await yc.syncSessions({ q, ycGet: spy, now: later, watched: w, sleep: noSleep });   // the day after a run: the usual two days
  check('a missed run is caught up from the last day read, at most 31 days back, and otherwise the last two days',
    j(starts) === j(['2026-11-03', '2026-10-13', '2026-11-11']), j(starts));
  /* REVERSION (run 2026-11-03): the start always INCREMENTAL_DAYS ago (the
     first build) -> this check fails: ten days missed are never read. */
}

/* ── 5. which car ───────────────────────────────────────────────────────── */
console.log('\n5. each charge on a car, saying how');
await yc.attributeSessions(q, { days: 9999 });
const by = Object.fromEntries((await q(`SELECT id, plate, plate_basis FROM charging_session`)).map((r) => [r.id, r]));
check('its own plate when PowerDrive has one that is ours (India, C21)', by.s2.plate === 'C21' && by.s2.plate_basis === 'session_plate', j(by.s2));
check('the only car the driver drove that day (Alpha, C1)', by.s1.plate === 'C1' && by.s1.plate_basis === 'only_car' && by.h1.plate === 'C1', j([by.s1, by.h1]));
check('two cars that day: the car of the booking nearest the charge (Epsilon, C3 at 10:20 for a 10:00 charge)',
  by.s3.plate === 'C3' && by.s3.plate_basis === 'nearest_trip', j(by.s3));
check('a linked driver who drove no car that day: on no car, and says why', by.s6.plate === null && by.s6.plate_basis === 'no_trip', j(by.s6));
check('a customer who is none of our people: on no car, and says why', by.s7.plate === null && by.s7.plate_basis === 'no_link', j(by.s7));

/* ── 6. the routes ──────────────────────────────────────────────────────── */
console.log('\n6. the pages\' answers');
const app = express();
app.use(express.json());
let as = null;
app.use((req, _res, next) => { if (as) req.fm = as; next(); });
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
chargingRoutes(app, { q, wrap });
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err.stack || err).slice(0, 500) }));
const srv = app.listen(0);
const base = `http://127.0.0.1:${srv.address().port}`;
const get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const w = await get('/api/charging/wallets');
check('wallets: every linked person with their balance, the review queue with reasons, phones as their last three digits only',
  w.status === 200 && w.body.rows.length === 4 && w.body.totals.balance === 108.25 && w.body.totals.negative === 1
  && w.body.review.length >= 5 && w.body.review.every((r) => r.reason && (!r.yc_phone || /^•+\d{3}$/.test(r.yc_phone)))
  && w.body.currency === 'AED' && w.body.customers_read === USERS.length && w.body.customers === USERS.length - 2, j(w.body).slice(0, 400));
const none = await get(`/api/charging/driver?person=${P.H}`);
check('a driver with no wallet linked: absent, with the reason — never AED 0',
  none.status === 200 && none.body.wallets.length === 0 && /No PowerDrive charging wallet is linked/.test(none.body.why), j(none.body));
const alpha = await get(`/api/charging/driver?person=${P.A}`);
check('a linked driver: their balance and recent charges, the cancelled one left out',
  alpha.body.wallets[0]?.balance === 120.5 && alpha.body.recent.length === 2 && alpha.body.recent.every((r) => r.kwh > 0), j(alpha.body));
const ses = await get('/api/charging/sessions?from=2026-11-02&to=2026-11-02');
check('sessions by car: C21, C1, C3 one charge each, each saying how; the cancelled one counted apart',
  ses.body.totals.charges === 5 && ses.body.totals.no_energy === 1 && ses.body.vehicles.length === 3
  && ses.body.totals.basis.no_trip === 1 && ses.body.totals.basis.no_link === 1
  && ses.body.vehicles.find((v) => v.plate === 'C3')?.basis.nearest_trip === 1, j(ses.body).slice(0, 500));
const veh = await get('/api/charging/vehicle?plate=C1&from=2026-10-01&to=2026-11-02');
check('one car: its charges in the window, with who charged it', veh.body.charges === 2 && veh.body.recent[0]?.driver === 'Test Driver Alpha', j(veh.body));
const anon = await post('/api/charging/link', { yc_user_id: 'yC', person_id: Number(P.C1), decision: 'confirm' });
as = { kind: 'user', user: { id: 9, email: 'viewer@example.test' }, access: { caps: [] } };
const viewer = await post('/api/charging/link', { yc_user_id: 'yC', person_id: Number(P.C1), decision: 'confirm' });
as = { kind: 'user', user: { id: 8, email: 'ops@example.test' }, access: { caps: ['collector.run', 'watchlist.edit', 'export'] } };
const ops = await post('/api/charging/link', { yc_user_id: 'yC', person_id: Number(P.C1), decision: 'confirm' });
check('deciding a link: a visitor is told to sign in; a viewer, and an Operations manager without identity.decide, are refused',
  anon.status === 401 && viewer.status === 403 && ops.status === 403, `${anon.status} ${viewer.status} ${ops.status}`);
/* REVERSION (run 2026-11-03): deciderOf returning { by } for anyone -> this
   check fails (a visitor confirms whose money a balance is). */
as = { kind: 'user', user: { id: 1, email: 'hr@example.test' }, access: { caps: ['hr.import', 'identity.decide', 'identity.merge'] } };
const ok = await post('/api/charging/link', { yc_user_id: 'yC', person_id: Number(P.C1), decision: 'confirm' });
const yc_ = await q(`SELECT person_id::text AS p, tier, decided_by FROM charging_link WHERE yc_user_id = 'yC'`);
check('an HR officer confirms: the customer is that person, who decided is kept, and the other suggestion for it is retired',
  ok.status === 200 && yc_.length === 1 && yc_[0].p === P.C1 && yc_[0].tier === 'confirmed' && yc_[0].decided_by === 'hr@example.test', j(yc_));
srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
