/* The assistant reads PowerDrive charging wallets (2026-11-23).
   ──────────────────────────────────────────────────────────────────────────
   The operator: "give the chat the ability to collect powerdrive charging
   wallet balance". charging_wallets (api/agent_tools.js) is the Charging
   page's two reads, as the asker — /api/charging/wallets and
   /api/charging/driver — run here against the REAL routes on a synthetic
   PowerDrive (no request leaves this machine), then behind the REAL gate:

     §1  one driver: the balance, the hold, the last 30 days (charges, kWh,
         cost — a charge with no cost counted apart), the latest sessions,
         the read time, "as PowerDrive last reported it";
     §2  a fleet-wallet customer has NO personal balance: empty, never 0, and
         said why;
     §3  a driver with no wallet linked: "no wallet linked", never AED 0;
     §4  every linked wallet: totals that leave the unknown balance out and
         say so, a negative balance counted, sorted, the review queue named;
     §5  a newer failed read is said — balances frozen since the last good
         read are not passed off as current;
     §6  a driver_id from an older lookup (no person id kept) is resolved
         through /api/driver/profile; find_driver keeps the person id;
     §7  access: a Dispatcher (no driver cash) is refused in the gate's own
         words, never handed a zero; a Finance manager reads it.

   REVERSIONS (each run, each failing as named):
     · the null-balance guard removed (balance summed as 0) → §2 fails
     · the no-wallet branch returning balance_aed 0 → §3 fails
     · readNote ignoring b.failed → §5 fails
     · the /api/driver/profile fallback removed → §6 fails
     · contactsByPerson ignoring the gate's CT blanking → §8 "Analyst" fails
       (a withheld phone read as "no phone on record")
     · find() by person id only (no account ids, no unique name) → §8
       "Dispatcher" fails — person_id is MRG-class

   §9 (AG-17, 2026-11-23 — "give everyone asking about powerdrive wallet
   access to phone number"): whoever may see a wallet sees its driver's
   numbers, at the level they see the balance; nowhere else.
     · liftLevels(L, entry) removed from the gate → §9 "Cash desk" and
       "Auditor" fail (withheld / masked again)
     · the subject rule in liftLevels removed and a lift to another class
       declared → §9 "only to the subject" fails
     · the PowerDrive-first ordering removed → §9 "PowerDrive's number first"
       fails (the newer Bolt number wins)
     · `a.detached_at IS NULL` removed → §9 "detached" fails

   §10 (the review of AG-17, 2026-11-23):
     · the ID cap in liftLevels removed → §10 "no driver identity" and
       "identity masked" fail (numbers whole beside withheld names)
     · shapeSourcedTables not called → §10 "reload" fails (the Cash desk's
       Phone column blank again beside a sentence quoting it)
     · 'other_phones' out of the DICT → §10 "Analyst reload" fails
     · an empty list counted as withheld again → §10 "empty list" fails
     · the join on account id alone (no platform) → §9 "another platform"
       fails (someone else's FMS record's number on the wallet)

   Synthetic people only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { accessLayer } from '../api/access/middleware.js';
import * as svc from '../api/access/service.js';
import { hashPassword } from '../api/access/crypto.js';
import { toolbox } from '../api/agent_tools.js';
import { checkReply } from '../api/agent_guard.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const db = { query: (t, p) => pg.query(t, p) };
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

/* ── three people and their PowerDrive accounts ─────────────────────────── */
const person = async (name) => (await q(`INSERT INTO driver (fleet_id, full_name) VALUES ('ecosine', $1) RETURNING id`, [name]))[0].id;
const PA = await person('Test Charger Alpha');      // a personal wallet, charging often
const PB = await person('Test Charger Beta');       // fleet wallet only: no personal balance
const PC = await person('Test Charger Gamma');      // no PowerDrive account at all
const PD = await person('Test Charger Delta');      // a negative personal balance
const ua = async (id, o) => q(`INSERT INTO charging_user (yc_user_id, name, fleet_group, using_fleet_wallet, fleet_limit, fleet_limit_available,
    balance, hold_amount, last_session_at, phone_norm, fetched_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
[id, o.name, o.group ?? 'ecofleet', !!o.fleet, o.limit ?? null, o.avail ?? null, o.balance ?? null, o.hold ?? null, o.last ?? null, o.phone ?? null]);
/* Alpha registered with PowerDrive on the Uber record's number (the collector
   stores it normalised, src/sources/yocharge.js phoneOf). */
await ua('yc-a', { name: 'Alpha T', balance: 182.4, hold: 25, last: '2026-11-22T10:15:00Z', phone: '971500000001' });
await ua('yc-b', { name: 'Beta T', fleet: true, limit: 1000, avail: 640.5, last: '2026-11-21T06:00:00Z' });
await ua('yc-d', { name: 'Delta T', balance: -12.75, last: '2026-11-02T19:30:00Z' });
await q(`INSERT INTO charging_link (yc_user_id, person_id, tier) VALUES ('yc-a', $1, 'auto'), ('yc-b', $2, 'confirmed'), ('yc-d', $3, 'auto')`, [PA, PB, PD]);
let sn = 0;
const sess = (user, at, kwh, cost, plate = 'L46178') => q(`INSERT INTO charging_session (id, yc_user_id, started_at, kwh, cost_incl_vat, duration_s, charging_s,
    property_name, plate, plate_basis) VALUES ($1,$2,$3,$4,$5,1800,1700,'Test Site One',$6,'session_plate')`, [`s${++sn}`, user, at, kwh, cost, plate]);
const now = Date.now();
const daysAgo = (d) => new Date(now - d * 864e5).toISOString();
await sess('yc-a', daysAgo(1), 41.5, 49.8);
await sess('yc-a', daysAgo(3), 38.25, null);          // a charge PowerDrive sent no cost for
await sess('yc-a', daysAgo(9), 20, 24);
await sess('yc-a', daysAgo(40), 30, 36);              // outside the last 30 days
await sess('yc-a', daysAgo(2), 0, 0);                 // zero energy: not a charge
await sess('yc-b', daysAgo(2), 26, 31);       // no figure of 30 anywhere, so only charge_window_days can source one
const good = new Date(now - 3 * 3600e3).toISOString();
await q(`INSERT INTO collection_run (source, fleet_id, mode, started_at, finished_at, status) VALUES ('yocharge', '-', 'realtime', $1, $1, 'ok')`, [good]);

const A = 'aaaaaaaa-5555-4555-8555-000000000001', B = 'aaaaaaaa-5555-4555-8555-000000000002',
  C = 'aaaaaaaa-5555-4555-8555-000000000003';
/* The platform accounts and their roster records, seeded before any tool runs:
   the person spine (src/persons.js) is cached when first built, and the
   wallet tools now read the Compliance list for phones from §1 on — on
   production every account is already on the spine. */
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES
  ('uber', $1, $3), ('bolt', 'bolt-alpha', $3), ('uber', $2, $4) ON CONFLICT DO NOTHING`, [A, B, PA, PB]);
/* Alpha's Bolt record was reported more recently than the Uber one: the
   wallet still lists the Uber number first, because it is the one PowerDrive
   holds (§9). */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone, state, updated_at) VALUES
  ('uber', $1, 'ecosine', 'Test Charger Alpha', '+971500000001', 'active', now() - interval '2 days'),
  ('bolt', 'bolt-alpha', 'ecosine', 'Test Charger Alpha', '+971500000099', 'active', now() - interval '1 hour'),
  ('uber', $2, 'ecosine', 'Test Charger Beta', '+971500000002', 'active', now() - interval '1 day') ON CONFLICT DO NOTHING`, [A, B]);

/* ── the tools, bare and behind the gate ───────────────────────────────── */
const bare = await mountAll(pg);
const layer = accessLayer({ db });
const gated = await mountAll(pg, { pre: (app) => { app.use(layer.identify); app.use(layer.gate); } });
const fetchVia = (port, cookie = '') => async (path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: cookie ? { cookie } : {} });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body, withheld: r.headers.get('x-fm-withheld') };
};

function harness(fetchApi, drivers) {
  const run = toolbox({ fetchApi, now: () => now });
  let n = 0;
  const ctx = { results: new Map(), drivers: new Map(drivers),
    store(r) { const id = `r${++n}`; const s = { id, ...r }; this.results.set(id, s); return s; } };
  return { tool: (name, args) => run(name, args, ctx), ctx };
}
const { tool } = harness(fetchVia(bare.port), [
  [A, { name: 'Test Charger Alpha', ids: [A], person_id: PA }],
  [B, { name: 'Test Charger Beta', ids: [B], person_id: PB }],
  [C, { name: 'Test Charger Gamma', ids: [C], person_id: PC }]]);

console.log('\n§1 one driver\'s wallet');
const a1 = await tool('charging_wallets', { driver_id: A });
check('balance AED 182.40, AED 25 on hold, one wallet, not on the fleet wallet',
  a1.values?.balance_aed === 182.4 && a1.values?.on_hold_aed === 25 && a1.values?.wallets === 1 && a1.values?.on_fleet_wallet === 'no',
  JSON.stringify(a1.values));
check('last 30 days: 3 charges (the zero-energy session and the 40-day-old one not counted), 99.75 kWh',
  a1.values?.charges_30d === 3 && a1.values?.kwh_30d === 99.8, JSON.stringify(a1.values));
check('…cost AED 73.80 over the charges that carry one, and the uncosted charge said',
  a1.values?.cost_30d_aed === 73.8 && /1 of the last 30 days' charges carry no cost/.test(a1.note || ''), `${a1.values?.cost_30d_aed} ${a1.note}`);
check('the latest sessions as rows, newest first, with car and site', a1.rows?.length === 4 && a1.rows[0].kwh === 41.5
  && a1.rows[0].plate === 'L46178' && a1.rows[0].site === 'Test Site One', JSON.stringify(a1.rows?.[0]));
check('a position as of the last read: the definition says so and the read time is a value',
  /as PowerDrive last reported it/.test(a1.definition) && /Test Charger Alpha/.test(a1.definition) && !!a1.values?.read_at
  && /last read/.test(a1.note || ''), `${a1.definition} | ${a1.note}`);
check('the result is about this driver, for the guard', a1.filters?.driver === 'Test Charger Alpha');


console.log('\n§2 a fleet-wallet customer has no personal balance');
const b1 = await tool('charging_wallets', { driver_id: B });
check('no balance_aed at all — empty, never 0 — and on the fleet wallet with AED 640.50 left',
  !('balance_aed' in (b1.values || {})) && b1.values?.on_fleet_wallet === 'yes' && b1.values?.fleet_limit_available_aed === 640.5,
  JSON.stringify(b1.values));
check('…and the note says why', /charges only on the fleet's wallet has no personal balance/.test(b1.note || ''), b1.note);
/* Production, 2026-11-23: the model wrote "in the last 30 days" and the guard
   refused the whole answer — no result carried 30 (that driver's note did not
   mention the window either). The window is a value of the result now. The
   guard is handed the values alone — the note's read time ("09:30") and a
   session row costing AED 30 can each carry a 30 of their own — so only the
   value can source the 30 here. */
const RG = new Map([['r1', { id: 'r1', kind: b1.kind, definition: b1.definition, filters: b1.filters, values: b1.values, kinds: b1.kinds }]]);
const g30 = checkReply('Test Charger Beta charged {{r1.charges_30d}} times in the last 30 days.', RG, { driverNames: ['Test Charger Beta'] });
check('a reply saying "the last 30 days" passes the guard: the window is a figure of the result',
  g30.ok, JSON.stringify(g30.problems));
/* Production, 2026-11-23: {{r6.values.rows}} — the values path spelled out —
   threw away a correct answer. Read as {{r6.rows}}; an unknown key still fails. */
const gv = checkReply('Test Charger Beta charged {{r1.values.charges_30d}} times.', RG, { driverNames: ['Test Charger Beta'] });
const gx = checkReply('Test Charger Beta charged {{r1.values.no_such_key}} times.', RG, { driverNames: ['Test Charger Beta'] });
check('{{rN.values.key}} is read as {{rN.key}} and filled; a key the result does not hold still fails',
  gv.ok && /charged 1 times/.test(gv.text) && !gx.ok, JSON.stringify([gv.problems, gv.text, gx.ok]));

console.log('\n§3 a driver with no wallet linked');
const c1 = await tool('charging_wallets', { driver_id: C });
check('"no wallet linked", and no balance figure anywhere', c1.values?.wallet_linked === 'no' && !('balance_aed' in (c1.values || {}))
  && /never a balance of AED 0/.test(c1.note || ''), JSON.stringify(c1).slice(0, 300));

console.log('\n§4 every linked wallet');
const all = await tool('charging_wallets', {});
check('three wallets, three drivers, total AED 169.65 — the fleet-wallet customer left out and said',
  all.values?.wallets === 3 && all.values?.drivers === 3 && all.values?.total_balance_aed === 169.65
  && all.values?.wallets_without_a_personal_balance === 1 && /leaves those 1 out/.test(all.note || ''), `${JSON.stringify(all.values)} ${all.note}`);
check('one negative balance counted', all.values?.negative_balances === 1, JSON.stringify(all.values));
check('sorted by balance, highest first, the unknown balance last',
  all.rows?.map((r) => r.driver).join('|') === 'Test Charger Alpha|Test Charger Delta|Test Charger Beta', JSON.stringify(all.rows?.map((r) => r.driver)));
check('a driver not listed is said to have no wallet linked, not AED 0', /not a balance of AED 0/.test(all.note || ''));
const asc = await tool('charging_wallets', { sort_by: 'balance_aed', order: 'asc' });
check('…and lowest first on request', asc.rows?.[0]?.driver === 'Test Charger Delta', JSON.stringify(asc.rows?.map((r) => r.driver)));

console.log('\n§5 a newer failed read is said');
await q(`INSERT INTO collection_run (source, fleet_id, mode, started_at, finished_at, status, error) VALUES ('yocharge', '-', 'realtime', now(), now(), 'error', 'HTTP 401 from PowerDrive')`);
const { tool: tool2 } = harness(fetchVia(bare.port), [[A, { name: 'Test Charger Alpha', ids: [A], person_id: PA }]]);
const a5 = await tool2('charging_wallets', { driver_id: A });
check('the failure, its reason, and that the balances are from the last good read',
  /latest PowerDrive read failed/.test(a5.note || '') && /HTTP 401/.test(a5.note || '') && /may be out of date/.test(a5.note || ''), a5.note);
await q(`DELETE FROM collection_run WHERE status = 'error'`);

console.log('\n§6 the person id: kept by find_driver, or resolved');
const { tool: tool3 } = harness(fetchVia(bare.port), [[A, { name: 'Test Charger Alpha', ids: [A] }]]);
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES ('uber', $1, $2) ON CONFLICT DO NOTHING`, [A, PA]);
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at, status, price)
         VALUES ('uber', 'tc1', 'ecosine', 'L46178', $1, 'Test Charger Alpha', $2, $2, 'completed', 30)`, [A, daysAgo(1)]);
const a6 = await tool3('charging_wallets', { driver_id: A });
check('a driver_id with no person id kept still finds the wallet through the profile', a6.values?.balance_aed === 182.4,
  JSON.stringify(a6).slice(0, 300));
const src = (await import('node:fs')).readFileSync(new URL('../api/agent_tools.js', import.meta.url), 'utf8');
check('find_driver keeps the person id with the name', /person_id: row\?\.person_id \?\? null/.test(src));

console.log('\n§7 access: the asker\'s own GET');
const cfg = await svc.getConfig(db, { fresh: true });
const userIds = new Map();
async function cookieFor(email, role) {
  const u = await svc.createUser(db, { email, name: `Test ${role}`, status: 'active', passwordHash: hashPassword('a long enough test password') });
  userIds.set(email, u.id);
  await svc.createGrant(db, { userId: u.id, roleCode: role, fleets: null, reason: 'test' });
  const s = await svc.createSession(db, { userId: u.id, mfaOk: true, cfg });
  return `fm_sid=${s.token}; fm_csrf=testcsrf`;
}
const { tool: DSP } = harness(fetchVia(gated.port, await cookieFor('dsp-charge@example.test', 'DSP')), [[A, { name: 'Test Charger Alpha', ids: [A], person_id: PA }]]);
const d1 = await DSP('charging_wallets', { driver_id: A });
const d2 = await DSP('charging_wallets', {});
check('a Dispatcher (no driver cash) is refused both reads, never handed a balance',
  !!d1.withheld && !d1.values && !!d2.withheld && !d2.values, JSON.stringify([d1, d2]).slice(0, 300));
const { tool: FIN } = harness(fetchVia(gated.port, await cookieFor('fin-charge@example.test', 'FIN')), [[A, { name: 'Test Charger Alpha', ids: [A], person_id: PA }]]);
const o1 = await FIN('charging_wallets', { driver_id: A });
check('a Finance manager, who holds driver cash, reads the same balance the page shows', o1.values?.balance_aed === 182.4, JSON.stringify(o1).slice(0, 300));

console.log('\n§8 phone numbers: on the wallets, and driver_contacts');
/* The operator, 2026-11-23: "let chat access phone numbers of drivers as well,
   so that if needed, for charging wallet, we can get the numbers as well".
   Phones come from /api/compliance/drivers (the Compliance page's list, one row
   per person); the gate shapes contact fields (class CT) per role. */

const { tool: T8 } = harness(fetchVia(bare.port), [
  [A, { name: 'Test Charger Alpha', ids: [A], person_id: PA }], [C, { name: 'Test Charger Gamma', ids: [C], person_id: PC }]]);
const w8 = await T8('charging_wallets', { driver_id: A });
check('one driver\'s wallet carries their phone, and the other number their records hold',
  w8.values?.phone === '+971500000001' && w8.values?.other_phones === '+971500000099', JSON.stringify(w8.values));
check('…with the rule for quoting it, and that it is the number on their PowerDrive account',
  /quote a phone number exactly as given/.test(w8.note || '') && /also the number on their PowerDrive account/.test(w8.note || ''), w8.note);
const l8 = await T8('charging_wallets', {});
const ph = Object.fromEntries((l8.rows || []).map((r) => [r.driver, [r.phone, r.other_phones]]));
check('every wallet row carries its driver\'s phone; one with none on record is empty, not invented',
  ph['Test Charger Alpha']?.[0] === '+971500000001' && ph['Test Charger Alpha']?.[1] === '+971500000099'
  && ph['Test Charger Beta']?.[0] === '+971500000002' && ph['Test Charger Beta']?.[1] === null && ph['Test Charger Delta']?.[0] === null
  && l8.columns?.some((c) => c.key === 'phone') && l8.columns?.some((c) => c.key === 'other_phones')
  && /an empty phone means none is on the driver's platform driver records/.test(l8.note || ''), JSON.stringify([ph, l8.note]));
const c8 = await T8('driver_contacts', { driver_id: A });
check('driver_contacts, one driver: the main phone, and the Bolt account\'s different number as another phone',
  c8.values?.phone === '+971500000001' && c8.values?.other_phones === '+971500000099' && c8.rows?.length === 2
  && c8.rows.some((r) => r.platform === 'bolt' && r.phone === '+971500000099'), JSON.stringify([c8.values, c8.rows]));
const g8 = await T8('driver_contacts', { driver_id: C });
check('a driver not on the Compliance list: said so, no number guessed', g8.values?.on_the_compliance_list === 'no'
  && !('phone' in (g8.values || {})), JSON.stringify(g8));
const all8 = await T8('driver_contacts', {});
check('driver_contacts, everyone: one row per person, alphabetical, with the phones',
  all8.values?.with_a_phone === 2 && all8.rows?.[0]?.driver === 'Test Charger Alpha' && all8.rows.some((r) => r.phone === '+971500000002'),
  JSON.stringify(all8.values));
const G = (email, role) => cookieFor(email, role).then((c) => harness(fetchVia(gated.port, c), [[A, { name: 'Test Charger Alpha', ids: [A], person_id: PA }]]).tool);
const FIN8 = await G('fin8-charge@example.test', 'FIN');
const f8 = await FIN8('charging_wallets', {});
const fph = Object.fromEntries((f8.rows || []).map((r) => [r.driver, r.phone]));
check('the Finance manager (contacts and cash, but no person ids) gets each wallet\'s phone from the wallet itself — no matching by name',
  fph['Test Charger Alpha'] === '+971500000001' && fph['Test Charger Beta'] === '+971500000002' && !/matched by the driver's name/.test(f8.note || ''),
  JSON.stringify([fph, (f8.note || '').slice(0, 300)]));
const f1 = await FIN8('charging_wallets', { driver_id: A });
check('…and one driver\'s phone the same way', f1.values?.phone === '+971500000001'
  && !/matched by the driver's name/.test(f1.note || ''), JSON.stringify([f1.values?.phone, f1.note]).slice(0, 300));
const DSP8 = await G('dsp8-charge@example.test', 'DSP');
const d8 = await DSP8('driver_contacts', { driver_id: A });
check('a Dispatcher (contact details, no driver cash) gets the phone from driver_contacts', d8.values?.phone === '+971500000001',
  JSON.stringify(d8).slice(0, 300));
const ANL = await G('anl-charge@example.test', 'ANL');
const n8 = await ANL('driver_contacts', { driver_id: A });
check('an Analyst (no contact details) is told the numbers are withheld, never handed one',
  !n8.values?.phone && (n8.withheld || /withheld from this person's role/.test(n8.note || '')), JSON.stringify(n8).slice(0, 300));

console.log('\n§9 whoever may see a wallet sees its driver\'s numbers — and nowhere else (AG-17)');
/* The operator, 2026-11-23: "give everyone asking about powerdrive wallet
   access to phone number". The Cash desk holds driver cash and no contact
   details; the Auditor holds cash in full and contact details masked. On the
   two wallet routes the gate lifts CT to the reader's level of CASH, the
   routes' subject (api/access/shape.js liftLevels). */
const CLK = await G('clk-charge@example.test', 'CLK');
const k9 = await CLK('charging_wallets', { driver_id: A });
check('the Cash desk (driver cash, no contact details) sees the balance AND the phone, in full',
  k9.values?.balance_aed === 182.4 && k9.values?.phone === '+971500000001' && k9.values?.other_phones === '+971500000099'
  && !/withheld|masked/.test(k9.note || ''), JSON.stringify([k9.values, k9.note]).slice(0, 400));
const kl9 = await CLK('charging_wallets', {});
const kph = Object.fromEntries((kl9.rows || []).map((r) => [r.driver, r.phone]));
check('…and every wallet\'s phone on the list', kph['Test Charger Alpha'] === '+971500000001' && kph['Test Charger Beta'] === '+971500000002'
  && kph['Test Charger Delta'] === null && !/withheld/.test(kl9.note || ''), JSON.stringify([kph, (kl9.note || '').slice(0, 200)]));
const AUD = await G('aud-charge@example.test', 'AUD');
const a9 = await AUD('charging_wallets', { driver_id: A });
check('the Auditor (cash in full, contact details masked) sees the wallet\'s phone in full, as it sees the balance',
  a9.values?.phone === '+971500000001' && !/masked/.test(a9.note || ''), JSON.stringify([a9.values?.phone, a9.note]).slice(0, 300));

/* The routes themselves, as the Cash desk: the lift is the route's. */
const clkCookie = await cookieFor('clk9-charge@example.test', 'CLK');
const gw = await fetchVia(gated.port, clkCookie)('/api/charging/wallets');
const gAlpha = (gw.body?.rows || []).find((r) => r.person_id === String(PA));
check('GET /api/charging/wallets as the Cash desk: rows[].phones in full, CT not among what the gate withheld',
  gw.status === 200 && JSON.stringify(gAlpha?.phones) === JSON.stringify(['+971500000001', '+971500000099']) && !/CT/.test(gw.withheld || ''),
  JSON.stringify([gw.status, gAlpha?.phones, gw.withheld]));
const gd = await fetchVia(gated.port, clkCookie)(`/api/charging/driver?person=${PA}`);
check('GET /api/charging/driver as the Cash desk: phones in full, PowerDrive\'s number first',
  gd.status === 200 && gd.body?.phones?.[0] === '+971500000001' && gd.body?.phone_on_powerdrive === true, JSON.stringify([gd.status, gd.body?.phones]));
const gc = await fetchVia(gated.port, clkCookie)('/api/compliance/drivers');
const cAlpha = (gc.body?.people || []).find((p) => p.name === 'Test Charger Alpha');
check('…but the same Cash desk on the Compliance list: no number — the lift does not leave the wallet routes',
  gc.status === 200 && cAlpha && cAlpha.phone == null && /CT/.test(gc.withheld || ''), JSON.stringify([gc.status, cAlpha?.phone, gc.withheld]));
const dspCookie = await cookieFor('dsp9-charge@example.test', 'DSP');
const dw = await fetchVia(gated.port, dspCookie)('/api/charging/wallets');
check('a lift opens no route: the Dispatcher (no driver cash) is still refused the wallets', dw.status === 403, String(dw.status));

check('PowerDrive\'s number first, though the Bolt record reported its number more recently',
  JSON.stringify(gAlpha?.phones) === JSON.stringify(['+971500000001', '+971500000099']) && gAlpha?.phone_on_powerdrive === true,
  JSON.stringify(gAlpha));
const { liftLevels } = await import('../api/access/shape.js');
const lv = (o) => liftLevels({ ID: 'F', ...o }, { subject: 'CASH', lift: { CT: 'CASH', DOC: 'CASH' } });
check('liftLevels only raises: CT:F with CASH:M stays F; CT none with CASH:M becomes M',
  lv({ CT: 'F', CASH: 'M' }).CT === 'F' && lv({ CASH: 'M' }).CT === 'M' && lv({ CT: 'M', CASH: 'F' }).CT === 'F', '');
check('liftLevels lifts only to the route\'s subject', liftLevels({ CASH: 'F' }, { subject: 'ID', lift: { CT: 'CASH' } }).CT === undefined, '');

/* A detached account is no longer the person's (sql/schema_v101.sql). */
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, detached_at) VALUES ('yango', 'yango-old-alpha', $1, now())`, [PA]);
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone, state) VALUES
  ('yango', 'yango-old-alpha', 'ecosine', 'Old Yango Record', '+971500000077', 'active')`);
const det = await fetchVia(bare.port)('/api/charging/wallets');
const dAlpha = (det.body?.rows || []).find((r) => r.person_id === String(PA));
check('a detached account\'s number is not on the wallet', dAlpha && !dAlpha.phones.includes('+971500000077'), JSON.stringify(dAlpha?.phones));
/* The whole account key (the review of AG-17): a record on another platform
   that happens to carry the same id is someone else's. */
await q(`INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone, state) VALUES
  ('fms', 'bolt-alpha', 'ecosine', 'Someone Else Entirely', '+971500000055', 'active')`);
const pk = await fetchVia(bare.port)('/api/charging/wallets');
const pAlpha = (pk.body?.rows || []).find((r) => r.person_id === String(PA));
check('a record on another platform with the same account id is not this driver\'s number', pAlpha && !pAlpha.phones.includes('+971500000055')
  && pAlpha.phones.includes('+971500000099'), JSON.stringify(pAlpha?.phones));

console.log('\n§10 the review of AG-17: identity, the reload, an empty list');
/* A custom role an Access admin can make: driver cash, no driver identity.
   Its names come back withheld — so must the numbers, or each balance is
   tied back to its driver. With the identity masked, so are the numbers. */
await svc.createRole(db, { code: 'XCASHONLY', name: 'Test cash only', levels: { CASH: 'F', SYS: 'F' }, caps: [], by: null });
await svc.createRole(db, { code: 'XCASHIDM', name: 'Test cash, identity masked', levels: { CASH: 'F', ID: 'M', SYS: 'F' }, caps: [], by: null });
const xw = await fetchVia(gated.port, await cookieFor('xcash-charge@example.test', 'XCASHONLY'))('/api/charging/wallets');
const xAlpha = (xw.body?.rows || []).find((r) => r.balance === 182.4);
check('a role with driver cash and NO driver identity: names withheld, and the numbers too',
  xw.status === 200 && xAlpha && xAlpha.name == null && xAlpha.phones == null && /CT/.test(xw.withheld || ''),
  JSON.stringify([xw.status, xAlpha?.name, xAlpha?.phones, xw.withheld]));
const mw = await fetchVia(gated.port, await cookieFor('xcashm-charge@example.test', 'XCASHIDM'))('/api/charging/wallets');
const mAlpha = (mw.body?.rows || []).find((r) => r.balance === 182.4);
check('…with the identity masked, the numbers are masked too (last two digits)',
  mw.status === 200 && Array.isArray(mAlpha?.phones) && mAlpha.phones.every((x) => /^•+\d{2}$/.test(x)) && /01$/.test(mAlpha.phones[0]),
  JSON.stringify([mw.status, mAlpha?.name, mAlpha?.phones]));
check('liftLevels never goes above ID', liftLevels({ CASH: 'F' }, { subject: 'CASH', lift: { CT: 'CASH' } }).CT === undefined
  && liftLevels({ CASH: 'F', ID: 'M' }, { subject: 'CASH', lift: { CT: 'CASH' } }).CT === 'M', '');

/* THE RELOAD: GET /api/agent/state serves a stored conversation through the
   gate again. A wallet table keeps the numbers its route showed this reader;
   a table from anywhere else is shaped at the reader's own contact level. */
const { shapeBody } = await import('../api/access/shape.js');
const convFor = async (email, role) => {
  const cookie = await cookieFor(email, role);
  const id = `conv-${email}`;
  await q(`INSERT INTO agent_conversation (id, owner) VALUES ($1, $2)`, [id, `u:${userIds.get(email)}`]);
  const tables = [
    { id: 'r1', title: 'wallets', source: '/api/charging/wallets', columns: [{ key: 'driver' }, { key: 'phone' }, { key: 'other_phones' }],
      rows: [{ driver: 'Test Charger Alpha', phone: '+971500000001', other_phones: '+971500000099' }], total_rows: 1 },
    { id: 'r2', title: 'contacts', source: '/api/compliance/drivers', columns: [{ key: 'driver' }, { key: 'phone' }],
      rows: [{ driver: 'Test Charger Alpha', phone: '+971500000001' }], total_rows: 1 },
    { id: 'r3', title: 'no source', source: null, columns: [{ key: 'phone' }], rows: [{ phone: '+971500000001' }], total_rows: 1 },
  ];
  await q(`INSERT INTO agent_message (conversation_id, role, body) VALUES ($1, 'assistant', $2::jsonb)`, [id, JSON.stringify({ text: '[[table r1]]', tables })]);
  const r = await fetchVia(gated.port, cookie)('/api/agent/state');
  const t = r.body?.conversation?.messages?.[0]?.tables || [];
  return { status: r.status, w: t[0]?.rows?.[0], c: t[1]?.rows?.[0], n: t[2]?.rows?.[0] };
};
const rk = await convFor('clk-reload@example.test', 'CLK');
check('reload, the Cash desk: the wallet table keeps both numbers; a Compliance or unsourced table does not',
  rk.status === 200 && rk.w?.phone === '+971500000001' && rk.w?.other_phones === '+971500000099' && rk.c?.phone == null && rk.n?.phone == null,
  JSON.stringify(rk));
const ra = await convFor('aud-reload@example.test', 'AUD');
check('reload, the Auditor: the wallet table in full, the Compliance table masked',
  ra.w?.phone === '+971500000001' && ra.w?.other_phones === '+971500000099' && /^•+01$/.test(ra.c?.phone || ''), JSON.stringify(ra));
const rn = await convFor('anl-reload@example.test', 'ANL');
check('reload, the Analyst (no cash, no contact): every number withheld — other_phones included',
  rn.status === 200 && rn.w?.phone == null && rn.w?.other_phones == null && rn.c?.phone == null, JSON.stringify(rn));

/* AN EMPTY LIST is nothing to withhold: marked withheld, it told the
   assistant "withheld from this person's role" about numbers that did not
   exist. */
const e1 = shapeBody({ rows: [{ phones: [] }] }, { fields: [] }, { CT: 'M' });
const e2 = shapeBody({ rows: [{ phones: ['+971500000001'] }] }, { fields: [] }, { CT: 'M' });
check('empty list: not marked withheld; a real list is masked and marked',
  !e1.withheld.CT && JSON.stringify(e1.body.rows[0].phones) === '[]' && e2.withheld.CT === 'M' && /^•+01$/.test(e2.body.rows[0].phones[0]),
  JSON.stringify([e1.withheld, e2.withheld, e2.body.rows[0].phones]));

bare.server?.close?.(); gated.server?.close?.();
await pg.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
