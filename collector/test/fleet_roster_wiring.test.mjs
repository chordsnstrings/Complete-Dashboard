/* THE PLATES THE TRACKER HAS STOPPED LISTING STOP COUNTING — and the pages
   are told why (FIXLIST C18, wired 2026-11-12).
   ═════════════════════════════════════════════════════════════════════════
   api/fleet_roster.js was written for C18 and imported by nothing. The CABMAN
   collector keeps a roster in source_state (a plate departs after 288 missed
   polls), and every count went on including the departed plates. Measured on
   production 2026-11-12: /api/live 268 rows, 177 CABMAN, 132 of those with a
   last poll more than a day old; /api/kpis tracked_vehicles 268, silent 162;
   the vehicle register 273 rows, 132 of them those plates with nothing else
   on record.

   The fixture is five plates and one roster, each plate a case the wiring has
   to get right:
     L1001  CABMAN, listed, reporting now            counts everywhere
     L1002  CABMAN, departed, last fix six days ago  gone from live and kpis;
                                                    set aside in the register
     L1003  CABMAN departed, FMS still reports it    stays, through its FMS fix
     L1004  FMS only                                 untouched
     L1005  CABMAN departed, a document knows it     gone from the tracker
                                                    counts; NOT set aside in
                                                    the register (it is a car)
     L1009  pending: never written to the table     in the roster's list only

   And the two ways an empty roster can lie: no roster row must exclude
   NOTHING (the SQL is null-safe, or every CABMAN row would vanish), and a
   failed read must say it failed rather than "not written yet".

   REVERSION, each proved on 2026-11-12 by copying the file, undoing the one
   change and restoring it byte for byte:
     · /api/live without ROSTER_KEEP           → section 1 fails
     · /api/kpis without ROSTER_KEEP / note    → section 2 fails
     · the directory without set_aside         → section 3 fails
     · no api/fleet_roster_routes.js           → section 4 fails (404)
     · api/fleet_roster.js as first written    → section 6 fails ('failed'
       read worded as "not written yet", and cached)
   And from the review (2026-11-12), each reverted the same way:
     · /api/fleet/roster answering n = held   → section 4 "n counts the plates
       the live list actually lost" fails (4, beside a list showing L1003)
     · live_cars without the roster read      → section 8 fails (a set-aside
       plate called "no tracker, or mistyped") */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { clearRosterCache, fleetRoster, rosterFor, exclusionNote, excludedPlates } from '../api/fleet_roster.js';
import { LATEST_FIX, ROSTER_KEEP } from '../api/telemetry_sql.js';
import { toolbox } from '../api/agent_tools.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const fix = (source, plate, minAgo, speed = 0) => q(
  `INSERT INTO telemetry_snapshot (source, plate, fleet_id, captured_at, polled_at, lat, lng, speed, status)
   VALUES ($1, $2, 'ecosine', now() - ($3 || ' minutes')::interval, now() - ($3 || ' minutes')::interval,
           25.2, 55.3, $4, 'Active')`, [source, plate, String(minAgo), speed]);
await fix('cabman', 'L1001', 2, 40);
await fix('cabman', 'L1002', 6 * 1440, 55);      // frozen at a speed recorded six days ago
await fix('cabman', 'L1003', 3 * 1440, 0);
await fix('fms', 'L1003', 5, 30);
await fix('fms', 'L1004', 10, 0);
await fix('cabman', 'L1005', 2 * 1440, 20);
await q(`INSERT INTO vehicle_document (platform, vehicle_ext_id, doc_type, plate, status, expires_at)
         VALUES ('uber', 'v-1005', 'registration', 'L1005', 'ACTIVE', now() + interval '200 days')`);

const ROSTER = {
  polls: 900, updated_at: '2026-11-12T05:25:00Z',
  plates: {
    L1001: { admitted: true, departed: false }, L1002: { admitted: true, departed: true },
    L1003: { admitted: true, departed: true }, L1005: { admitted: true, departed: true },
    L1009: { admitted: false, departed: false },
  },
  departed: ['L1002', 'L1003', 'L1005'], pending: ['L1009'], listed: ['L1001'],
};
const setRoster = async (value) => {
  await q(`DELETE FROM source_state WHERE source = 'cabman' AND key = 'roster'`);
  if (value != null) {
    await q(`INSERT INTO source_state (source, fleet_id, key, value) VALUES ('cabman', 'ecosine', 'roster', $1)`, [value]);
  }
  clearRosterCache();
};
await setRoster(JSON.stringify(ROSTER));

const { server, get } = await mountAll(db, { serverRoutes: true });
const plates = (rows) => (Array.isArray(rows) ? rows : []).map((r) => r.plate).sort();

console.log('\n1. /api/live: a set-aside plate’s CABMAN fixes are not its newest fix');
const live = await get('/api/live');
check('still a bare array — the access manifest shapes it by "[]" paths', live.status === 200 && Array.isArray(live.body),
  JSON.stringify(live.body).slice(0, 160));
check('the plates the tracker still reports, and no other', JSON.stringify(plates(live.body)) === '["L1001","L1003","L1004"]',
  JSON.stringify(plates(live.body)));
const l3 = (live.body || []).find((r) => r.plate === 'L1003');
check('a departed CABMAN plate FMS still reports is shown from its FMS fix', l3?.source === 'fms', JSON.stringify(l3));
check('nothing frozen days ago is moving any more',
  !(live.body || []).some((r) => +r.speed > 3 && r.fix_age_min > 1440), JSON.stringify(live.body?.map((r) => [r.plate, r.speed, r.fix_age_min])));

console.log('\n2. /api/kpis: the tracker counts, and the sentence for them');
const k = (await get('/api/kpis?days=30')).body || {};
check('tracked_vehicles counts the three plates a tracker still reports', k.tracked_vehicles === 3, String(k.tracked_vehicles));
check('tracked_set_aside names the two that left the count (L1002, L1005)', k.tracked_set_aside === 2, String(k.tracked_set_aside));
check('silent_vehicles no longer carries the frozen listings', k.silent_vehicles === 0, String(k.silent_vehicles));
check('live_vehicles: the three reporting now', k.live_vehicles === 3, String(k.live_vehicles));
check('fleet_roster: n is THIS figure’s drop, held the roster’s whole list',
  k.fleet_roster?.n === 2 && k.fleet_roster?.held === 4 && k.fleet_roster?.known === true, JSON.stringify(k.fleet_roster));
check('and its sentence says how many and why, in plain words',
  /^2 plates set aside: the tracker has stopped listing them/.test(k.fleet_roster?.reason || ''), k.fleet_roster?.reason);

console.log('\n3. /api/vehicles/directory: set aside only where the roster’s word is the only word');
const dir = (await get('/api/vehicles/directory?days=30')).body || [];
const by = Object.fromEntries((Array.isArray(dir) ? dir : []).map((r) => [r.plate, r]));
check('still a bare array, every plate still in the register', Array.isArray(dir) && ['L1001', 'L1002', 'L1003', 'L1004', 'L1005'].every((p) => by[p]),
  JSON.stringify(Object.keys(by)));
check('L1002 — CABMAN only, departed, nothing else knows it — is set aside as departed', by.L1002?.set_aside === 'departed',
  JSON.stringify(by.L1002?.set_aside));
check('L1003 is not set aside: FMS still reports it', by.L1003?.set_aside === null, JSON.stringify(by.L1003?.set_aside));
check('L1005 is not set aside: a document says it is a car', by.L1005?.set_aside === null, JSON.stringify(by.L1005?.set_aside));
check('a listed plate carries null, not a missing key', 'set_aside' in (by.L1001 || {}) && by.L1001.set_aside === null);

console.log('\n4. GET /api/fleet/roster: the note the pages print');
const r = await get('/api/fleet/roster');
check('answers with the roster’s counts', r.status === 200 && r.body.held === 4
  && r.body.departed === 3 && r.body.pending === 1 && r.body.listed === 1, JSON.stringify(r.body).slice(0, 200));
/* n is what /api/live LOST, not what the roster holds (review, 2026-11-12):
   #live and #map print this sentence above /api/live's rows. L1003 still
   shows through its FMS fix and L1009 was never written, so of the four set
   aside, two (L1002, L1005) left the list — the same two /api/kpis counts in
   tracked_set_aside. With n = held the sentence said 4 beside a list that
   still showed L1003. */
check('n counts the plates the live list actually lost (L1002, L1005), with the sentence worded for that count',
  r.body.n === 2 && /^2 plates set aside: /.test(r.body.reason || '')
  /* and every plate the table holds is either on the live list or in n */
  && r.body.n === k.tracked_set_aside && live.body.length + r.body.n === 5,
  JSON.stringify({ n: r.body.n, reason: r.body.reason }));
check('the plates themselves, sorted, so the claim can be checked', JSON.stringify(r.body.plates) === '["L1002","L1003","L1005","L1009"]',
  JSON.stringify(r.body.plates));
check('a count-free reason for a page that counts its own rows', /stopped listing them/.test(r.body.why || ''), r.body.why);
const eg = await get('/api/fleet/roster?fleet=egari');
check('a fleet with no roster of its own is NOT KNOWN — never "every plate is listed"',
  eg.status === 200 && eg.body.known === false && eg.body.n === 0 && /has not been written yet/.test(eg.body.reason || ''),
  JSON.stringify(eg.body).slice(0, 200));
const nope = await get('/api/fleet/roster?fleet=nowhere');
check('a fleet that does not exist is a 400, not a reason that is not the true one', nope.status === 400 && nope.body?.error === 'bad_fleet',
  JSON.stringify(nope.body));

console.log('\n5. no roster at all: NOTHING is excluded, and the sentence says why');
await setRoster(null);
const live0 = await get('/api/live');
check('every plate is back — the predicate is null-safe, so no CABMAN row is dropped by an empty list',
  JSON.stringify(plates(live0.body)) === '["L1001","L1002","L1003","L1004","L1005"]', JSON.stringify(plates(live0.body)));
const k0 = (await get('/api/kpis?days=30')).body || {};
check('the tracked count is every plate, and none is called set aside', k0.tracked_vehicles === 5 && k0.tracked_set_aside === 0,
  JSON.stringify([k0.tracked_vehicles, k0.tracked_set_aside]));
check('and the note says the roster has not been written — it does not claim "every plate is listed"',
  k0.fleet_roster?.known === false && k0.fleet_roster?.state === 'none'
  && /^The tracker roster has not been written yet/.test(k0.fleet_roster?.reason || ''), JSON.stringify(k0.fleet_roster));
const dir0 = (await get('/api/vehicles/directory?days=30')).body || [];
check('the register sets nothing aside', Array.isArray(dir0) && dir0.every((x) => x.set_aside === null));
await setRoster('{this is not a roster');
const ru = (await get('/api/fleet/roster')).body || {};
check('a stored roster that does not parse is "unreadable", with that reason', ru.known === false && ru.state === 'unreadable'
  && /stored but could not be read/.test(ru.reason || ''), JSON.stringify(ru).slice(0, 200));

console.log('\n6. the module itself: four states, true sentences, one rule for shared plates');
await setRoster(JSON.stringify(ROSTER));          // a good roster in the table, the cache empty
const failed = await fleetRoster(async () => { throw new Error('connection terminated'); });
check('a read that FAILED says it failed — not "not written yet"', failed.state === 'failed' && failed.known === false
  && /could not be read just now/.test(exclusionNote(failed).reason), exclusionNote(failed).reason);
/* No clearRosterCache() here, deliberately: a cached failure would be served
   for a minute after the database recovered. */
const after = await fleetRoster(q);
check('and a failure is not cached: the next read reads', after.state === 'read' && after.excluded.size === 4, after.state);
check('excludedPlates is null when nothing is set aside — "keep everything" to the SQL', excludedPlates(failed) === null
  && excludedPlates(after)?.length === 4);
check('one plate: singular, and the grammar agrees', exclusionNote(after, { removed: 1 }).reason
  .startsWith('1 plate set aside: the tracker has stopped listing it, or has listed it too few times'), exclusionNote(after, { removed: 1 }).reason);
check('nothing removed from a figure while plates are set aside: says so, without claiming none is counted',
  /^No plate was taken out of this figure: the 4 the tracker has set aside/.test(exclusionNote(after, { removed: 0 }).reason),
  exclusionNote(after, { removed: 0 }).reason);
/* A plate departed for one fleet and listed for another (two fleets must not
   share a plate; if they do, LISTED WINS — in the merged roster AND in the
   one-fleet view, so the view agrees with what the SQL set aside). */
clearRosterCache();
const shared = await fleetRoster(async () => [
  { fleet_id: 'ecosine', value: JSON.stringify({ plates: { X1: {} }, departed: ['X1', 'X2'], pending: [], listed: [] }) },
  { fleet_id: 'egari', value: JSON.stringify({ plates: { X1: {} }, departed: [], pending: [], listed: ['X1'] }) },
]);
check('listed wins in the merged roster', !shared.excluded.has('X1') && shared.excluded.has('X2'));
const eco = rosterFor(shared, 'ecosine');
check('and in a one-fleet view of the fleet that departed it', !eco.excluded.has('X1') && eco.excluded.has('X2')
  && eco.known === true, JSON.stringify([...eco.excluded]));
check('a one-fleet view never shows the other fleet’s plates', rosterFor(shared, 'egari').excluded.size === 0);
clearRosterCache();

console.log('\n7. the SQL fragments');
check('LATEST_FIX without a predicate is the fragment live_fix.test.mjs compares with DISTINCT ON',
  !/undefined|null/.test(LATEST_FIX('p.plate')) && LATEST_FIX('p.plate').includes('t.captured_at <= now()\n'));
check('ROSTER_KEEP coalesces, so a NULL list keeps every CABMAN fix', /coalesce\(t\.plate = ANY\(\$1::text\[\]\), false\)/.test(ROSTER_KEEP('t.')));
const [nullSafe] = await q(`SELECT count(*)::int n FROM telemetry_snapshot t WHERE ${ROSTER_KEEP('t.')}`, [null]);
const [all] = await q('SELECT count(*)::int n FROM telemetry_snapshot');
check('and Postgres agrees: with no list, every row passes', nullSafe.n === all.n, `${nullSafe.n} of ${all.n}`);

/* §8 THE ASSISTANT (review, 2026-11-12). api/agent_tools.js live_cars reads
   /api/live, so it got the smaller list with no word — and for a set-aside
   plate it answered "no tracker position is on record — the car may have no
   tracker, or the plate may be mistyped", a reason that is not the true one.
   Reverted (the roster read in live_cars), every check here fails. */
console.log('\n8. the assistant says what the live list left out');
{
  clearRosterCache();
  const run = toolbox({ fetchApi: (p) => get(p), now: () => Date.now() });
  const ctx = { results: new Map(), drivers: new Map(), store(x) { return x; } };
  const one = await run('live_cars', { plate: 'L1002' }, ctx);
  check('a set-aside plate is named as set aside, not as "no tracker" or "mistyped"',
    /L1002 is not on the live list: the tracker has set it aside/.test(one.error || '') && !/mistyped/.test(one.error || ''),
    JSON.stringify(one).slice(0, 240));
  const none = await run('live_cars', { plate: 'L4040' }, ctx);
  check('a plate the roster does not hold keeps the old reasons, and no roster claim',
    /no tracker position is on record for L4040/.test(none.error || '') && !/set it aside|stopped listing/.test(none.error || ''),
    JSON.stringify(none).slice(0, 240));
  const all = await run('live_cars', {}, ctx);
  check('the fleet-wide answer carries the roster’s sentence for the list',
    all.values?.cars_with_a_position === 3 && /left out of this list: 2 plates set aside/.test(all.note || ''),
    JSON.stringify({ values: all.values, note: all.note }).slice(0, 300));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
