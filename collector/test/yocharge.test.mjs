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
        driver drove within 12 hours of it, or the nearest booking — and says
        which; redone when its link changes; batched, never twice in a run;
     6. the routes: a person's money is absent with a reason when no wallet is
        linked; deciding a link needs a signed-in identity.decide holder;
     7. what the independent review of 2026-11-03 found, each pinned: a fold
        carries a decision to the surviving person; a decision about a person
        row that is gone holds its customer back; the link replace is one
        transaction; a failed run still drops strangers; "last read" is the
        last GOOD read, and a newer failure is said; an amount PowerDrive did
        not give is null, never 0; the queue has its own route; a second
        confirmation is refused.
   Synthetic people (Test Driver …), plates (C…) and numbers (+9715000…) only.
   REVERSIONS, run 2026-11-03, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import * as yc from '../src/sources/yocharge.js';
import { followPersonFold } from '../src/charging_links.js';
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
  if (url.pathname === '/open/v1/users/') {
    /* ?id= answers exactly that customer, as PowerDrive's does (measured). */
    const id = url.searchParams.get('id');
    return json(page(id ? USERS.filter((u) => u.id === id) : USERS, url));
  }
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
check('the mobile matches but the names share no word: a candidate, not a link', tierOf('yB', P.B) === 'candidate' && /names do not agree/.test(reasonOf('yB')));
/* REVERSION (run 2026-11-03): the name-agreement test removed -> this check
   fails (Bravo's wallet linked automatically to "Someone Else Entirely"). */
check('a mobile on two of our people: both offered, neither chosen', tierOf('yC', P.C1) === 'candidate' && tierOf('yC', P.C2) === 'candidate'
  && /2 of our records/.test(reasonOf('yC')));
check('two customers on one mobile: offered, not linked', tierOf('yD1', P.D) === 'candidate' && tierOf('yD2', P.D) === 'candidate'
  && /2 PowerDrive customers share/.test(reasonOf('yD1')));
check('an email alone: a candidate', tierOf('yF', P.F) === 'candidate' && /email matches/.test(reasonOf('yF')));
check('a name alone: a candidate inside our fleet groups, nothing outside them', tierOf('yG', P.G) === 'candidate' && !links.some((l) => l.yc_user_id === 'yH'));
check('a stranger is linked to nobody', !links.some((l) => l.yc_user_id === 'yZ'));
/* The name rule, reviewed: a particle or one of the commonest given names is
   not agreement — a recycled number reaching a new "Mohammed …" must not
   link on "mohammed" (the review, 2026-11-03). */
{
  const W = yc.nameWords;
  check('names agree on a distinctive word, or on two ordinary ones — never on a particle or one common name alone',
    yc.namesAgree(W('Ahmed Tarig Mohamed'), W('Tarig Ahmed')) && yc.namesAgree(W('Mohammed Ali Khan'), W('Mohammed Ali'))
    && !yc.namesAgree(W('Ahmed Al Mansoori'), W('Khalid Al Nuaimi')) && !yc.namesAgree(W('Mohammed Rafiq'), W('Mohammed Shafiq')));
  /* REVERSION (run 2026-11-03): namesAgree as "any shared word" (the first
     build) -> this check fails ("Al" and "Mohammed" agree). */
  check('a mobile is a UAE one only by its own country code: +966 05… is not ours',
    yc.phoneOf({ mobile_country_code: '+966', mobile_number: '0501000001' }) === null
    && yc.phoneOf({ mobile_country_code: '', mobile_number: '0501000001' }) === '971501000001');
  /* REVERSION (run 2026-11-03): the country-code guard removed -> this
     check fails (a Saudi mobile read as 971501000001). */
}
/* The replace is one transaction: a write that fails half way leaves the
   links that were there (the review: a kill between the DELETE and the
   INSERTs left none for up to six hours). */
{
  const before = await q(`SELECT yc_user_id, person_id::text AS p, tier FROM charging_link ORDER BY 1, 2`);
  const bad = { owners: new Map([['971501000001', new Set(['p:not-a-number'])]]), personAccounts: new Map() };
  let threw = false;
  try { await yc.linkUsers({ q, db, book: bad }); } catch { threw = true; }
  const now2 = await q(`SELECT yc_user_id, person_id::text AS p, tier FROM charging_link ORDER BY 1, 2`);
  check('the links are replaced in one transaction: a write that fails half way leaves the links that were there',
    threw && j(now2) === j(before), j([threw, now2.length, before.length]));
  /* REVERSION (run 2026-11-03): linkUsers writing through q, not inTx ->
     this check fails (every auto link deleted, none written). */
}
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
check('the only car the driver drove within 12 hours (Alpha, C1)', by.s1.plate === 'C1' && by.s1.plate_basis === 'only_car' && by.h1.plate === 'C1', j([by.s1, by.h1]));
check('two cars within 12 hours: the car of the booking nearest the charge (Epsilon, C3 at 10:20 for a 10:00 charge)',
  by.s3.plate === 'C3' && by.s3.plate_basis === 'nearest_trip', j(by.s3));
check('a linked driver who drove no car within 12 hours: on no car, and says why', by.s6.plate === null && by.s6.plate_basis === 'no_trip', j(by.s6));
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
const rv = await get('/api/charging/review');
check('wallets: every linked person with their balance; the queue on its own route, with reasons and phones as their last three digits only',
  w.status === 200 && w.body.rows.length === 4 && w.body.totals.balance === 108.25 && w.body.totals.negative === 1
  && w.body.review === undefined && w.body.totals.review === rv.body.review.length
  && rv.status === 200 && rv.body.review.length >= 5 && rv.body.review.every((r) => r.reason && (!r.yc_phone || /^•+\d{3}$/.test(r.yc_phone)))
  && w.body.currency === 'AED' && w.body.customers_read === USERS.length && w.body.customers === USERS.length - 2, j([w.body, rv.body]).slice(0, 400));
const none = await get(`/api/charging/driver?person=${P.H}`);
check('a driver with no wallet linked: absent, with the reason — never AED 0',
  none.status === 200 && none.body.wallets.length === 0 && /No PowerDrive charging wallet is linked/.test(none.body.why), j(none.body));
const alpha = await get(`/api/charging/driver?person=${P.A}`);
check('a linked driver: their balance and recent charges, the cancelled one left out',
  alpha.body.wallets[0]?.balance === 120.5 && alpha.body.recent.length === 2 && alpha.body.recent.every((r) => r.kwh > 0)
  && alpha.body.charges_total === 2, j(alpha.body));
const ses = await get('/api/charging/sessions?from=2026-11-02&to=2026-11-02');
check('sessions by car: C21, C1, C3 one charge each, each saying how; the cancelled one counted apart',
  ses.body.totals.charges === 5 && ses.body.totals.no_energy === 1 && ses.body.vehicles.length === 3
  && ses.body.totals.basis.no_trip === 1 && ses.body.totals.basis.no_link === 1
  && ses.body.vehicles.find((v) => v.plate === 'C3')?.basis.nearest_trip === 1
  && ses.body.sites.length === 1 && ses.body.sites_total === 1, j(ses.body).slice(0, 500));
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

/* ── 7. what the review found ───────────────────────────────────────────── */
console.log('\n7. the independent review\'s findings, each pinned');
{
  const again = await post('/api/charging/link', { yc_user_id: 'yC', person_id: Number(P.C2), decision: 'confirm' });
  const still = await q(`SELECT person_id::text AS p, tier FROM charging_link WHERE yc_user_id = 'yC' ORDER BY 1`);
  check('a second confirmation of one customer as somebody else is refused, and changes nothing',
    again.status === 409 && again.body.person_id === P.C1 && still.length === 1 && still[0].tier === 'confirmed', j([again, still]));
  /* REVERSION (run 2026-11-03): the 409 removed -> this check fails (two
     people confirmed for one customer). */
}
{
  /* A decision is put on cars again: the POST clears the customer's
     attribution, and a link changed by any path re-does even an old charge. */
  await q(`INSERT INTO charging_session (id, yc_user_id, started_at, kwh, cost_incl_vat) VALUES ('o1', 'yK', '2026-09-01T06:00:00Z', 8, 9)`);
  await trip('uber', 'uA', 'C1', '2026-09-01T04:00:00Z');
  await yc.attributeSessions(q, { runAt: new Date('2026-11-03T06:00:00Z') });
  const was = (await q(`SELECT plate_basis FROM charging_session WHERE id = 'o1'`))[0];
  await q(`INSERT INTO charging_link (yc_user_id, person_id, tier, decided_by) VALUES ('yK', $1, 'confirmed', 'hr@example.test')`, [P.A]);
  await yc.attributeSessions(q, { runAt: new Date('2026-11-03T07:00:00Z') });
  const is = (await q(`SELECT plate, plate_basis, attributed_person::text AS ap FROM charging_session WHERE id = 'o1'`))[0];
  check('a charge is put on a car again when its customer\'s link changes — even one older than every recency window',
    was.plate_basis === 'no_link' && is.plate === 'C1' && is.plate_basis === 'only_car' && is.ap === P.A, j([was, is]));
  /* REVERSION (run 2026-11-03): the attributed_person condition removed ->
     this check fails (o1 stays no_link for ever). */
  const dec = await post('/api/charging/link', { yc_user_id: 'yK', person_id: Number(P.A), decision: 'refuse' });
  const cleared = (await q(`SELECT plate_basis FROM charging_session WHERE id = 'o1'`))[0];
  check('…and a decision through the page clears the customer\'s charges for the next run', dec.status === 200 && cleared.plate_basis === null, j(cleared));
}
{
  /* A night shift's car is not lost to the calendar day: a 00:30 charge
     after an evening in C2, with a morning in C3 the same Dubai day. */
  await trip('uber', 'uA', 'C2', '2026-10-25T18:00:00Z');      // 22:00 Dubai, 25 Oct
  await trip('uber', 'uA', 'C3', '2026-10-26T07:00:00Z');      // 11:00 Dubai, 26 Oct
  await q(`INSERT INTO charging_session (id, yc_user_id, started_at, kwh) VALUES ('n1', 'yA', '2026-10-25T20:30:00Z', 10)`);
  const tally = await yc.attributeSessions(q, { runAt: new Date('2026-11-03T08:00:00Z'), batch: 1 });
  const n1 = (await q(`SELECT plate, plate_basis FROM charging_session WHERE id = 'n1'`))[0];
  check('a 00:30 charge after an evening in one car goes on that car, not on the next morning\'s', n1.plate === 'C2' && n1.plate_basis === 'nearest_trip', j(n1));
  /* REVERSION (run 2026-11-03): the ±12 h window replaced by the Dubai
     calendar day (the first build) -> this check fails (only_car C3). */
  const eligible = (await q(`SELECT count(*)::int AS n FROM charging_session WHERE attributed_at = '2026-11-03T08:00:00Z'`))[0].n;
  const twice = await yc.attributeSessions(q, { runAt: new Date('2026-11-03T08:00:00Z'), batch: 1 });
  check('batched a session at a time, every eligible session is done once a run, and a second pass of the same run finds nothing',
    Object.values(tally).reduce((a, b) => a + b, 0) === eligible && eligible > 1 && Object.keys(twice).length === 0, j([tally, eligible, twice]));
  /* REVERSION (run 2026-11-03): the attributed_at condition removed -> this
     check fails (the batch loop re-does the same recent sessions until
     maxBatches). */
}
{
  /* An amount PowerDrive did not give is null, never 0. */
  await q(`INSERT INTO charging_session (id, yc_user_id, started_at, kwh, cost_incl_vat) VALUES ('u1', 'yI', '2026-08-02T06:00:00Z', 5, NULL)`);
  const u = await get('/api/charging/sessions?from=2026-08-02&to=2026-08-02');
  check('a day whose only charge states no amount: cost null and counted as unknown, not AED 0',
    u.body.totals.charges === 1 && u.body.totals.cost === null && u.body.totals.cost_unknown === 1, j(u.body.totals));
  /* REVERSION (run 2026-11-03): coalesce(sum, 0) back -> this check fails (0). */
}
{
  /* "Last read" is the last GOOD read; a newer failure is said. And a run
     that fails after reading customers still drops strangers. */
  const failing = async (u, opts = {}) => {
    const url = new URL(u);
    if (url.pathname === '/open/v1/users/') {
      return url.searchParams.get('page') === '1' ? json({ count: 99, next: 'more', results: USERS }) : json({ detail: 'gateway' }, 504);
    }
    return fakeFetch(u, opts);
  };
  const good = (await get('/api/charging/wallets')).body.synced_at;
  const r = await yc.collect({ db, now: new Date('2026-11-03T09:00:00Z'), fetchImpl: failing, sleep: noSleep, key: 'k', clientId: 't',
    host: 'https://pd.example', log: { info() {}, warn() {} } });
  const kept = (await q(`SELECT yc_user_id FROM charging_user ORDER BY 1`)).map((x) => x.yc_user_id);
  check('a run that fails after reading customers still drops the strangers it read', !!r.error && !kept.includes('yZ') && !kept.includes('yH'), j([r.error, kept]));
  /* REVERSION (run 2026-11-03): the finally prune removed -> this check
     fails (A Stranger's details stored after the failed run). */
  const after = (await get('/api/charging/wallets')).body;
  check('"last read" stays the last good read, and the newer failure is said with its reason',
    after.synced_at === good && after.failed?.status === 'error' && /504/.test(after.failed.error), j([good, after.synced_at, after.failed]));
  /* REVERSION (run 2026-11-03): synced_at = max(finished_at) of any run ->
     this check fails (the time of the failure). */
}
{
  /* A fold carries a decision to the surviving person; a fold that did not
     (any path but the three that call followPersonFold) holds the customer
     back rather than letting a refusal turn into a link. */
  const survivor = async (name) => (await q(`INSERT INTO driver (full_name) VALUES ($1) RETURNING id::text AS id`, [name]))[0].id;
  const fold = async (keep, gone, follow) => {
    await q(`UPDATE driver_platform_id SET driver_id = $1 WHERE driver_id = $2`, [keep, gone]);
    if (follow) await followPersonFold(q, keep, [gone]);
    await q(`DELETE FROM driver WHERE id = $1`, [gone]);
  };
  await q(`UPDATE charging_link SET tier = 'refused', decided_by = 'hr@example.test' WHERE yc_user_id = 'yA' AND person_id = $1`, [P.A]);
  const sA = await survivor('Test Driver Alpha');
  await fold(sA, P.A, true);
  await yc.linkUsers({ q, db });
  const rowsA = await q(`SELECT person_id::text AS p, tier FROM charging_link WHERE yc_user_id = 'yA'`);
  check('a fold carries a refusal to the surviving person: the next run does not link the customer to them',
    rowsA.length === 1 && rowsA[0].p === sA && rowsA[0].tier === 'refused', j(rowsA));
  /* REVERSION (run 2026-11-03): followPersonFold not called -> this check
     fails (the refusal left on a person that is gone). */
  await q(`UPDATE charging_link SET tier = 'confirmed', decided_by = 'hr@example.test' WHERE yc_user_id = 'yE' AND person_id = $1`, [P.E]);
  const sE = await survivor('Test Driver Epsilon');
  await fold(sE, P.E, false);
  await yc.linkUsers({ q, db });
  const rowsE = await q(`SELECT person_id::text AS p, tier, reason FROM charging_link WHERE yc_user_id = 'yE' ORDER BY tier`);
  const wl = (await get('/api/charging/wallets')).body.rows;
  check('a decision stranded on a person that is gone holds its customer back for a person, and is shown nowhere',
    rowsE.some((x) => x.p === sE && x.tier === 'candidate' && /no longer exists/.test(x.reason)) && !rowsE.some((x) => x.tier === 'auto')
    && !wl.some((x) => x.person_id === P.E), j([rowsE, wl.map((x) => x.person_id)]));
  /* REVERSION (run 2026-11-03): the stranded guard removed from linkUsers ->
     this check fails (yE linked automatically to the survivor). */
  await q(`INSERT INTO charging_link (yc_user_id, person_id, tier, decided_by) VALUES ('yC', $1, 'refused', 'hr@example.test')`, [P.C2]);
  await fold(P.C1, P.C2, true);
  const rowsC = await q(`SELECT person_id::text AS p, tier, reason FROM charging_link WHERE yc_user_id = 'yC'`);
  check('two records judged apart — one confirmed, one refused — are one person now: the pair goes back to a person, unresolved',
    rowsC.length === 1 && rowsC[0].p === P.C1 && rowsC[0].tier === 'candidate' && /decide again/.test(rowsC[0].reason), j(rowsC));
}
{
  /* A customer who leaves the watched set loses their sessions, and is read
     again if they come back. */
  const v3 = [];
  const spy = async (path, params) => { if (path === '/v3/mini-transactions/') v3.push(params.user_id); return { results: [], next: null }; };
  await yc.syncSessions({ q, ycGet: spy, now: new Date('2026-11-03T10:00:00Z'), watched: new Set(['yI']), sleep: noSleep });
  await yc.syncSessions({ q, ycGet: spy, now: new Date('2026-11-03T10:00:00Z'), watched: new Set(['yI', 'yA']), sleep: noSleep });
  check('a customer who left the watched set and came back has their whole history read again', v3.includes('yA'), j(v3));
  /* REVERSION (run 2026-11-03): backfilled kept for customers no longer
     watched -> this check fails (yA never read again). */
  const dropped = await yc.dropUnwatchedSessions(q, new Set(['yA']));
  const left = (await q(`SELECT DISTINCT yc_user_id FROM charging_session`)).map((x) => x.yc_user_id);
  check('the sessions of customers no longer ours are dropped', dropped > 0 && j(left) === j(['yA']), j([dropped, left]));
}
/* ── 8. between the full reads: our drivers' wallets, every three hours ──── */
console.log('\n8. our drivers\' wallets, between the full reads');
{
  const watchedNow = await yc.watchedUsers(q);
  USERS.find((u) => u.id === 'yA').wallets[0].balance = '99.00';
  calls.length = 0;
  const r = await yc.collectWallets({ db, now: new Date('2026-11-03T11:00:00Z'), fetchImpl: fakeFetch, sleep: noSleep, key: 'k', clientId: 't',
    host: 'https://pd.example', log: { info() {}, warn() {} } });
  const asked = calls.filter((c) => new URL(c.url).pathname === '/open/v1/users/').map((c) => new URL(c.url).searchParams.get('id'));
  const yA = (await q(`SELECT balance::float AS b FROM charging_user WHERE yc_user_id = 'yA'`))[0];
  check('only our customers are asked for, one GET each by id — never the whole list', calls.every((c) => c.method === 'GET')
    && asked.length === watchedNow.size && asked.every((id) => id && watchedNow.has(id)) && r.wallets?.refreshed === watchedNow.size,
  j([asked, [...watchedNow], r.wallets]));
  /* REVERSION (run 2026-11-03): every stored customer asked for instead of
     the watched -> this check fails (candidates who are not ours yet asked). */
  check('…and the balance on screen is the one PowerDrive holds now', yA?.b === 99, j(yA));
  const v3 = calls.filter((c) => new URL(c.url).pathname === '/v3/mini-transactions/').length;
  const day = calls.filter((c) => new URL(c.url).pathname === '/open/v1/mini-transactions/').length;
  const run = (await q(`SELECT mode, status FROM collection_run WHERE source = 'yocharge' ORDER BY id DESC LIMIT 1`))[0];
  check('the day\'s sessions are read with them, no history, and the run is logged as a wallet refresh',
    day > 0 && v3 === 0 && run?.mode === 'wallets' && run?.status === 'ok', j([day, v3, run]));
  /* REVERSION (run 2026-11-03): budget 0 dropped from the refresh's
     syncSessions -> this check fails if any history is still waiting. */
  status = 401;
  const refused = await yc.collectWallets({ db, now: new Date('2026-11-03T12:00:00Z'), fetchImpl: fakeFetch, sleep: noSleep, key: 'k', clientId: 't',
    host: 'https://pd.example', log: { info() {}, warn() {} } });
  status = 200;
  const cred = (await q(`SELECT state FROM credential_state WHERE provider = 'yocharge' ORDER BY checked_at DESC NULLS LAST LIMIT 1`).catch(() => [{}]))[0];
  check('a refused key on the refresh says so on the banner, and the run is an error', !!refused.error && cred?.state === 'invalid', j([refused.error, cred]));
  check('no key: nothing is asked', (await yc.collectWallets({ db, fetchImpl: () => { throw new Error('asked'); }, key: '', clientId: 't' })).skipped === 'YOCHARGE_API_KEY is not set');
}
srv.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
