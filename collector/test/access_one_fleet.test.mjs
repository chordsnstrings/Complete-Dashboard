/* ONE-FLEET READERS ON THE ROUTES THAT MIX BOTH FLEETS — through the real gate.
   ═════════════════════════════════════════════════════════════════════════
   api/access/one_fleet.js is the design. A reader whose access covers one
   fleet was refused every `mixed` route; the routes classed `narrow` now
   answer them with THEIR fleet's rows, totals and counts, and every route
   still `mixed` refuses them with its own true reason.

   Mounted as production mounts it — identify, gate, the response cache, then
   every route (test/mount.mjs) — on a PGlite database built from every
   schema file and holding two fleets' records. Synthetic data only
   (@example.test, "Test Driver …", made-up plates).

   The test of a narrowed route is the same three questions each time:
     1. the one-fleet reader's answer names nothing of the other fleet — no
        plate, no driver, no id, no row with its fleet — and its totals are
        that fleet's own, not both fleets' printed beside one fleet's rows;
     2. an unrestricted reader still gets both fleets, unchanged;
     3. asking for the other fleet by name is refused, with that reason.

   REVERSIONS, each run on 2026-11-12 with the file copied first and restored
   byte for byte (cmp) afterwards — and in every one of them the unrestricted
   and open-mode checks (sections 11's first answer and 12) still passed,
   which is the proof that nothing changed for those readers:
     · api/segment_routes.js, cancellation_routes.js, hr_roster.js and
       feed_routes.js to 90d76da together — sections 2, 3, 9, 10, 11 and 13
       fail (21 checks): every Egari answer carries Ecosine's rows and totals.
     · api/server.js, analytics_routes.js and src/analyst.js to 90d76da —
       sections 4–8 fail (10): the tracker count, the silent sources, the
       recommendations and jobs, the horizons, the funnel, the tiers' custody
       and the brief's coverage are both fleets'.
     · the custody fleet bind in /api/segments alone (CUSTODY_1 → CUSTODY) —
       4 fail: the Crossfleet driver is named beside Egari's car.
     · the shaper's 'narrow' row filter (ROW_FILTERED back to 'rows') — 1.
     · mixedReason() back to the one generic sentence — section 14: 4 fail.
     · the gate's 'narrow' branch disabled — the narrowed routes refuse the
       reader again (403 "this combines…") and the run stops in section 2. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { accessLayer } from '../api/access/middleware.js';
import { allEntries } from '../api/access/manifest.js';
import { MIXED_WHY, GENERIC_WHY, NARROW_PARAM } from '../api/access/one_fleet.js';
import * as svc from '../api/access/service.js';
import { hashPassword } from '../api/access/crypto.js';
import { responseCache } from '../api/cache.js';
import { shapeBody } from '../api/access/shape.js';
import { ROLE } from '../api/public/access_model.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const db = { query: (t, p) => pg.query(t, p) };
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);

/* ── two fleets' records ───────────────────────────────────────────────── */
const AGO = (h) => `now() - interval '${h} hours'`;
const DAY = (h) => `((now() - interval '${h} hours') AT TIME ZONE 'Asia/Dubai')::date`;
const TRIPS = [
  // fleet, id, platform, plate, driver, name, hours ago, status, price
  ['egari', 'eg-t1', 'uber', 'EG-101', 'eg-d1', 'Test Driver Egari', 30, 'completed', 50],
  ['egari', 'eg-t2', 'uber', 'EG-101', 'eg-d1', 'Test Driver Egari', 28, 'completed', 60],
  ['egari', 'eg-t3', 'uber', 'EG-101', 'eg-d1', 'Test Driver Egari', 26, 'driver_cancelled', null],
  ['ecosine', 'ec-t1', 'uber', 'EC-201', 'ec-d1', 'Test Driver Ecosine', 30, 'completed', 70],
  ['ecosine', 'ec-t2', 'uber', 'EC-201', 'ec-d1', 'Test Driver Ecosine', 29, 'completed', 80],
  ['ecosine', 'ec-t3', 'uber', 'EC-201', 'ec-d1', 'Test Driver Ecosine', 27, 'driver_cancelled', null],
  ['ecosine', 'ec-t4', 'uber', 'EC-201', 'ec-d1', 'Test Driver Ecosine', 25, 'driver_cancelled', null],
  ['ecosine', 'ec-t5', 'uber', 'EC-201', 'ec-d1', 'Test Driver Ecosine', 24, 'driver_cancelled', null],
  /* Bolt: a channel only Ecosine uses, booked beside an Ecosine Uber ride so
     the two are one day's sources whatever the hour the test runs at. */
  ['ecosine', 'ec-b1', 'bolt', 'EC-201', 'ec-b1d', 'Test Driver Ecosine', 29, 'completed', 40],
];
for (const [fleet, id, platform, plate, drv, name, h, status, price] of TRIPS) {
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at,
                             ended_at, status, price, currency, distance_km, payment_type, product)
           VALUES ($1, $2, $3, $4, $5, $6, ${AGO(h)}, ${AGO(h - 0.3)}, $7, $8, 'AED', 9, 'card', 'UberX')`,
  [platform, id, fleet, plate, drv, name, status, price]);
}
/* Who held each car. EG-101 is Egari's car, and on the latest day an account
   filed under ECOSINE held it — the one name an Egari reader must never be
   handed beside their own car. */
for (const h of [72, 48, 24]) {
  await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, is_primary)
           VALUES ('EG-101', ${DAY(h)}, 'eg-d1', 'uber', 'Test Driver Egari', 'egari', 3, true),
                  ('EC-201', ${DAY(h)}, 'ec-d1', 'uber', 'Test Driver Ecosine', 'ecosine', 5, true)
           ON CONFLICT DO NOTHING`);
}
await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name, fleet_id, trips, is_primary)
         VALUES ('EG-101', ${DAY(0)}, 'ec-x1', 'uber', 'Test Driver Crossfleet', 'ecosine', 1, true),
                ('EG-101', ${DAY(20)}, 'ec-x1', 'uber', 'Test Driver Crossfleet', 'ecosine', 1, false)
         ON CONFLICT DO NOTHING`);
await q(`INSERT INTO occupancy_segment (source, plate, fleet_id, started_at, ended_at, duration_min, distance_km, verdict, verdict_reason)
         VALUES ('cabman', 'EG-101', 'egari', ${AGO(20)}, ${AGO(19.5)}, 30, 12, 'unauthorized', 'no booking on any channel'),
                ('cabman', 'EG-101', 'egari', ${AGO(18)}, ${AGO(17.6)}, 24, 5, 'authorized', 'matched uber trip'),
                ('cabman', 'EC-201', 'ecosine', ${AGO(21)}, ${AGO(20.5)}, 30, 40, 'unauthorized', 'no booking on any channel'),
                ('cabman', 'EC-201', 'ecosine', ${AGO(16)}, ${AGO(15.5)}, 30, 41, 'unauthorized', 'clock 2339 min behind'),
                ('fms_live', 'EC-201', 'ecosine', ${AGO(14)}, ${AGO(13.5)}, 30, 42, 'sensor_suspect', 'ecosine only reason')`);
/* As src/sources/events.js writes them: every break over both fleets
   together, fleet_id null — there is no per-fleet break to narrow to. */
await q(`INSERT INTO metric_break (metric, grain, platform, fleet_id, period_from, period_to, value_from, value_to, change_pct)
         VALUES ('trips', 'month', 'uber', NULL, '2026-08-01', '2026-09-01', 400, 230, -42.5)`);
await q(`INSERT INTO uber_trip_audit (fleet_id, window_from, window_to, kind, verified_at, uber_rows, our_rows, in_both, uber_only, misfiled, ours_only, agreement_pct)
         VALUES ('egari', '2026-09-01', '2026-09-30', 'month', now(), 100, 100, 100, 0, 0, 0, 100),
                ('ecosine', '2026-09-01', '2026-09-30', 'month', now(), 50, 45, 45, 5, 2, 0, 90)`);
await q(`INSERT INTO driver_payout_day (platform, driver_ext_id, day, period_start, period_end, fleet_id)
         VALUES ('uber', 'eg-d1', '2026-09-10', '2026-09-08', '2026-09-14', 'egari'),
                ('uber', 'ec-d1', '2026-09-11', '2026-09-08', '2026-09-14', 'ecosine'),
                ('uber', 'ec-d1', '2026-08-01', '2026-07-28', '2026-08-03', 'ecosine')`);
await q(`INSERT INTO driver_rating_history (platform, driver_ext_id, observed_on, fleet_id)
         VALUES ('uber', 'eg-d1', '2026-09-10', 'egari'), ('uber', 'ec-d1', '2026-09-10', 'ecosine'),
                ('uber', 'ec-d1', '2026-09-17', 'ecosine'), ('uber', 'ec-d1', '2026-09-24', 'ecosine')`);
await q(`INSERT INTO driver_performance (platform, driver_ext_id, driver_name, period_start, period_end, fleet_id, raw)
         VALUES ('yango', 'eg-d1', 'Test Driver Egari', ${DAY(48)}, ${DAY(24)}, 'egari',
                 '{"count_orders_all": 10, "count_orders_accepted": 8, "count_orders_completed": 7}'),
                ('yango', 'ec-d1', 'Test Driver Ecosine', ${DAY(48)}, ${DAY(24)}, 'ecosine',
                 '{"count_orders_all": 30, "count_orders_accepted": 20, "count_orders_completed": 15}')`);
await q(`INSERT INTO platform_recommendation (platform, rec_type, rec_uuid, fleet_id, period_end, flagged_count, updated_at)
         VALUES ('uber', 'acceptance', 'r-eg-1', 'egari', '2026-09-01', 2, now()),
                ('uber', 'acceptance', 'r-ec-1', 'ecosine', '2026-10-01', 9, now()),
                ('uber', 'cancellation', 'r-ec-2', 'ecosine', '2026-10-01', 4, now())`);
await q(`INSERT INTO collector_job (mode, status, requested_by, fleet)
         VALUES ('incremental', 'done', 'test', 'egari'), ('backfill', 'queued', 'test', 'ecosine'),
                ('incremental', 'running', 'test', NULL)`);
const [up] = await q(`INSERT INTO hr_roster_upload (sha256, export_date, export_date_from, filename, byte_len, rows_read, uploaded_by, summary)
                      VALUES ('feedfacefeedface', '2026-10-01', 'entered', 'test-roster.xlsx', 4321, 3, 'test', '{}') RETURNING id`);
await q(`INSERT INTO hr_roster_row (upload_id, fleet_id, employee_id, full_name, phone, match_basis, matched_accounts)
         VALUES ($1, 'egari', 'E1', 'Test Hr Egari', '0500000001', 'platform_id',
                 '[{"platform":"uber","ext_id":"eg-d1","fleet_id":"egari","via":"uber_id"},{"platform":"bolt","ext_id":"ec-acct-9","fleet_id":"ecosine","via":"bolt_id"}]'),
                ($1, 'ecosine', 'E2', 'Test Hr Ecosine', '0500000002', 'none', '[]'),
                ($1, 'ecosine', 'E3', 'Test Hr Ecosine Two', '0500000003', 'none', '[]')`, [up.id]);
await q(`INSERT INTO telemetry_snapshot (source, plate, captured_at, fleet_id, seat_occupied)
         VALUES ('cabman', 'EG-101', now() - interval '2 minutes', 'egari', true),
                ('cabman', 'EC-201', now() - interval '3 minutes', 'ecosine', true),
                ('fms', 'EC-202', now() - interval '3 days', 'ecosine', NULL)`);
await q(`INSERT INTO vehicle_profile (platform, vehicle_ext_id, plate, fleet_id, compliance_status)
         VALUES ('uber', 'v-eg-1', 'EG-101', 'egari', 'ACTIVE'), ('uber', 'v-ec-1', 'EC-201', 'ecosine', 'ACTIVE'),
                ('uber', 'v-ec-2', 'EC-202', 'ecosine', 'ACTIVE')`);

/* Anything of Ecosine's that a narrowed answer must not contain, anywhere. */
const ECOSINE_MARKS = ['EC-201', 'EC-202', 'ec-d1', 'ec-b1d', 'ec-x1', 'Test Driver Ecosine', 'Test Driver Crossfleet',
  'ec-acct-9', 'Test Hr Ecosine', 'r-ec-', 'ecosine only reason', '"ecosine"'];
const leaks = (body) => ECOSINE_MARKS.filter((m) => JSON.stringify(body ?? null).includes(m));

/* ── the application, as production mounts it ──────────────────────────── */
const layer = accessLayer({ db });
const cache = responseCache({ pool: db, ttlMs: 0 });
const { port } = await mountAll(pg, { pre: (app) => { app.use(layer.identify); app.use(layer.gate); app.use('/api', cache); } });
cache.setPort(port);
const base = `http://127.0.0.1:${port}`;
await svc.setConfig(db, 'mfa', 'none', null);
const cfg = await svc.getConfig(db, { fresh: true });
async function person(email, role, fleets = null) {
  const u = await svc.createUser(db, { email, name: `Test ${role}`, status: 'active', passwordHash: hashPassword('a long enough test password') });
  await svc.createGrant(db, { userId: u.id, roleCode: role, fleets, reason: 'test' });
  const s = await svc.createSession(db, { userId: u.id, mfaOk: true, cfg });
  return { cookie: `fm_sid=${s.token}` };
}
/* An Owner over Egari alone holds every class for that fleet: every route's
   subject is held, so what follows is the fleet narrowing and nothing else.
   An Operations manager over Egari is the realistic reader (section 13). */
const EG = await person('owner-egari@example.test', 'OWN', ['egari']);
const ALL = await person('owner-all@example.test', 'OWN');
const OPS = await person('ops-egari@example.test', 'OPS', ['egari']);
const get = async (who, path) => {
  const r = await fetch(base + path, { headers: who ? { cookie: who.cookie } : {} });
  let body = null; try { body = await r.json(); } catch { /* not json */ }
  return { status: r.status, body };
};
const W = 'days=30';

/* Each narrowed route: the reader's answer, the unrestricted one, and the
   other fleet asked for by name. */
/* `marks`: whether the unrestricted answer names Ecosine's plates or people
   at all. An aggregate (the Overview, the chart) names nobody; there the
   route's own checks compare the two answers' totals instead. */
async function narrowed(path, name, { marks = true } = {}) {
  const eg = await get(EG, path);
  const all = await get(ALL, path);
  const other = await get(EG, `${path}${path.includes('?') ? '&' : '?'}fleet=ecosine`);
  check(`${name}: answers the one-fleet reader`, eg.status === 200, `${eg.status} ${JSON.stringify(eg.body).slice(0, 200)}`);
  check(`${name}: …naming nothing of the other fleet`, eg.status === 200 && leaks(eg.body).length === 0, leaks(eg.body).join(', '));
  check(`${name}: an unrestricted reader is answered`, all.status === 200 && (!marks || leaks(all.body).length > 0),
    `${all.status} ${JSON.stringify(all.body).slice(0, 160)}`);
  check(`${name}: asking for the other fleet is refused with that reason`,
    other.status === 403 && other.body?.error === 'fleet_scope' && /outside your access/.test(other.body?.detail || ''),
    `${other.status} ${JSON.stringify(other.body)}`);
  return { eg: eg.body, all: all.body };
}

console.log('\n1. the manifest: which routes narrow, and every route still mixed has its own reason');
{
  const narrow = allEntries().filter((e) => e.fleet === 'narrow').map((e) => `${e.method} ${e.path}`);
  const mixed = allEntries().filter((e) => e.fleet === 'mixed').map((e) => `${e.method} ${e.path}`);
  const NARROWED = ['GET /api/analyst/brief', 'GET /api/cancellations', 'GET /api/coverage/verified',
    'GET /api/funnel/drivers', 'GET /api/hr-roster', 'GET /api/kpis', 'GET /api/recommendations', 'GET /api/segments',
    'GET /api/settings/jobs', 'GET /api/tiers/by-vehicle', 'GET /api/trips/daily', 'GET /api/vehicles/feeds'];
  check('the narrowed routes are re-classed narrow — these and no others', JSON.stringify([...narrow].sort())
    === JSON.stringify([...NARROWED].sort()), narrow.join(', '));
  const noReason = mixed.filter((k) => !MIXED_WHY[k]);
  check('every route still mixed has its own true reason (none falls back to the generic sentence)',
    noReason.length === 0, noReason.join(', '));
  const stale = Object.keys(MIXED_WHY).filter((k) => !mixed.includes(k));
  check('…and no reason is kept for a route that is no longer mixed', stale.length === 0, stale.join(', '));
  check('the narrowing parameter is the one the gate writes', NARROW_PARAM === '_fmfleet');
  /* The second line: where a narrowed route's rows carry their fleet, the
     shaper drops any row of another fleet even if a handler let one through. */
  const entry = { fleet: 'narrow', fleetRows: ['rows'], fleetKey: 'fleet_id', fields: [] };
  const shaped = shapeBody({ rows: [{ plate: 'EG-101', fleet_id: 'egari' }, { plate: 'EC-201', fleet_id: 'ecosine' }] },
    entry, ROLE.OWN.levels, { fleets: ['egari'] });
  check('the shaper drops another fleet\'s row from a narrowed answer, and says how many',
    shaped.body.rows.length === 1 && shaped.body.rows[0].plate === 'EG-101' && shaped.withheld.FLEET === '1',
    JSON.stringify(shaped));
}

console.log('\n2. /api/segments — the list that ignored the fleet chip');
{
  const { eg, all } = await narrowed(`/api/segments?${W}`, 'segments');
  check('Egari\'s rows only, each saying so', eg.rows.length === 2 && eg.rows.every((r) => r.fleet_id === 'egari'),
    JSON.stringify(eg.rows.map((r) => [r.plate, r.fleet_id])));
  check('…the total is Egari\'s, not both fleets\'', eg.total === 2 && all.total === 5, `${eg.total} / ${all.total}`);
  const vN = (b) => b.facets.verdict.reduce((a, v) => a + v.segments, 0);
  check('…the verdict facet counts Egari\'s segments only', vN(eg) === 2 && vN(all) === 5, `${vN(eg)} / ${vN(all)}`);
  check('…the plate facet lists Egari\'s car only', eg.facets.plate.map((p) => p.key).join() === 'EG-101');
  check('…each provider\'s count is Egari\'s', eg.facets.source.find((s) => s.key === 'cabman')?.segments === 2
    && !(eg.facets.source.find((s) => s.key === 'fms_live')?.segments > 0), JSON.stringify(eg.facets.source));
  check('…the reason facet holds no reason only Ecosine\'s segments gave', !eg.facets.reason.some((r) => /ecosine only/.test(r.key)));
  const named = eg.rows.flatMap((r) => [r.drivers, ...(r.driver_refs || []).map((x) => x.name)]).join('|');
  check('…and nobody filed under the other fleet is named as holding Egari\'s car', !/Crossfleet/.test(named), named);
  check('the unrestricted reader still sees the cross-fleet custodian (unchanged)',
    all.rows.some((r) => /Crossfleet/.test(r.drivers || '')), JSON.stringify(all.rows.map((r) => r.drivers)));
}

console.log('\n3. /api/cancellations');
{
  const { eg, all } = await narrowed(`/api/cancellations?${W}`, 'cancellations');
  check('one row, the Egari driver\'s', eg.rows.length === 1 && eg.rows[0].driver_ext_id === 'eg-d1', JSON.stringify(eg.rows));
  check('…totals are Egari\'s', eg.totals.cancelled === 1 && eg.totals.drivers === 1 && all.totals.cancelled === 4,
    `${JSON.stringify(eg.totals)} / ${all.totals.cancelled}`);
}

console.log('\n4. /api/kpis — the Overview');
{
  const { eg, all } = await narrowed(`/api/kpis?${W}`, 'kpis', { marks: false });
  check('bookings are Egari\'s', eg.trips === 3 && all.trips === 9, `${eg.trips} / ${all.trips}`);
  check('trackers: Egari\'s alone, where they counted both fleets', eg.tracked_vehicles === 1 && eg.live_vehicles === 1
    && all.tracked_vehicles === 3, `${eg.tracked_vehicles}/${eg.live_vehicles} vs ${all.tracked_vehicles}`);
}

console.log('\n5. /api/trips/daily — the Overview chart');
{
  const { eg, all } = await narrowed(`/api/trips/daily?${W}`, 'trips/daily', { marks: false });
  const sum = (b) => b.reduce((a, d) => a + (d.trips || 0), 0);
  check('the days sum to Egari\'s bookings', sum(eg) === 3 && sum(all) === 9, `${sum(eg)} / ${sum(all)}`);
  check('no day counts a channel only the other fleet uses as a source Egari expected',
    eg.every((d) => !(d.silent_sources || []).includes('bolt') && (d.sources_expected || 0) <= 1),
    JSON.stringify(eg.filter((d) => d.sources_expected).map((d) => [d.d, d.sources_expected, d.silent_sources])));
  check('…where the unrestricted chart expects both fleets\' channels', all.some((d) => d.sources_expected === 2),
    JSON.stringify(all.filter((d) => d.sources_expected).map((d) => [d.d, d.sources_expected])));
}

console.log('\n6. /api/recommendations, /api/settings/jobs');
{
  const r = await narrowed('/api/recommendations', 'recommendations', { marks: false });
  check('recommendations: the newest of Egari\'s, its history count Egari\'s', r.eg.rows.length === 1
    && r.eg.rows[0].flagged_count === 2 && r.eg.history === 1 && r.all.history === 3, JSON.stringify(r.eg));
  const j = await narrowed('/api/settings/jobs', 'settings/jobs', { marks: false });
  check('jobs: Egari\'s, never one queued for every fleet', j.eg.jobs.length === 1 && j.eg.total === 1
    && j.eg.pending === 0 && j.eg.running === 0 && j.all.total === 3 && j.all.running === 1, JSON.stringify(j.eg));
}

console.log('\n7. /api/coverage/verified');
{
  const { eg, all } = await narrowed('/api/coverage/verified', 'coverage/verified');
  check('windows and totals are Egari\'s', eg.windows.length === 1 && eg.uber_rows === 100 && all.uber_rows === 150);
  check('…and so are the money and rating horizons', eg.horizons.money.rows === 1 && eg.horizons.rating.rows === 1
    && all.horizons.money.rows === 3 && all.horizons.rating.rows === 4, JSON.stringify(eg.horizons));
}

console.log('\n8. /api/funnel/drivers, /api/tiers/by-vehicle, /api/analyst/brief');
{
  const f = await narrowed(`/api/funnel/drivers?${W}`, 'funnel/drivers');
  check('funnel: Egari\'s driver, Egari\'s total', f.eg.rows.length === 1 && f.eg.total === 1 && f.all.total === 2);
  const t = await narrowed(`/api/tiers/by-vehicle?${W}`, 'tiers/by-vehicle');
  check('tiers: Egari\'s car, Egari\'s vehicle count, its custodians Egari\'s', t.eg.vehicles?.length === 1
    && t.eg.vehicles[0].plate === 'EG-101' && t.eg.total === 1 && t.all.vehicles?.length === 2 && t.all.total === 2
    && !(t.eg.vehicles[0].driver_refs || []).some((d) => /Crossfleet/.test(d.name)), JSON.stringify(t.eg.vehicles?.[0]?.driver_refs));
  check('…where the unrestricted table names the cross-fleet custodian beside the same car (unchanged)',
    (t.all.vehicles || []).some((v) => v.plate === 'EG-101' && (v.driver_refs || []).some((d) => /Crossfleet/.test(d.name))));
  const a = await narrowed(`/api/analyst/brief?${W}`, 'analyst/brief', { marks: false });
  check('brief: Egari\'s bookings, and its coverage Egari\'s channels', a.eg.headline?.bookings === 3
    && a.eg.fleet === 'egari' && !(a.eg.coverage || []).some((c) => c.source === 'bolt')
    && (a.all.coverage || []).some((c) => c.source === 'bolt'), JSON.stringify(a.eg.coverage));
}

console.log('\n9. /api/hr-roster');
{
  const { eg, all } = await narrowed('/api/hr-roster', 'hr-roster');
  check('Egari\'s employee only', eg.people.length === 1 && eg.people[0].employee_id === 'E1' && all.people.length === 3);
  check('…every total counted from them', eg.totals.on_list === 1 && JSON.stringify(eg.totals.by_fleet) === '{"egari":1}'
    && all.totals.on_list === 3, JSON.stringify(eg.totals));
  check('…an account HR matched under the other fleet is not shown', !eg.people[0].accounts.some((a) => a.fleet_id !== 'egari')
    && eg.people[0].accounts.length === 1, JSON.stringify(eg.people[0].accounts));
  check('…the upload says how many of its rows are Egari\'s, and withholds its both-fleet size with the reason',
    eg.latest.rows_read === 1 && eg.uploads[0].rows_read === 1 && eg.uploads[0].byte_len === null
      && /both fleets/.test(eg.uploads[0].byte_len_absent || '') && all.uploads[0].rows_read === 3 && all.uploads[0].byte_len === 4321,
    JSON.stringify(eg.uploads[0]));
}

console.log('\n10. /api/vehicles/feeds');
{
  const { eg, all } = await narrowed('/api/vehicles/feeds', 'vehicles/feeds');
  check('Egari\'s car only, and the totals count it alone', eg.rows.length === 1 && eg.totals.vehicles === 1
    && JSON.stringify(eg.totals.fleets) === '{"egari":1}' && all.totals.vehicles === 3, JSON.stringify(eg.totals));
  check('…its current driver is not one filed under the other fleet',
    !(eg.rows[0].driver_refs || []).some((d) => /Crossfleet/.test(d.name || '')), JSON.stringify(eg.rows[0].driver_refs));
  check('…and the accounts list names Egari\'s alone', Object.values(eg.accounts).every((v) => v.every((f) => f === 'egari')));
}

console.log('\n11. the cache keeps the narrowed answer apart');
{
  /* The unrestricted reader asks first, so the cache holds a both-fleet
     answer at /api/segments?…&fleet=egari (the handler ignores the chip for
     them, as it always has). The Egari reader's request carries the gate's
     key — with _fmfleet — and must not be served it. */
  const url = `/api/segments?${W}&fleet=egari`;
  const first = await get(ALL, url);
  const egari = await get(EG, url);
  check('an unrestricted answer cached under the same address is not served to the one-fleet reader',
    leaks(first.body).length > 0 && egari.status === 200 && leaks(egari.body).length === 0 && egari.body.total === 2,
    `${egari.status} ${leaks(egari.body).join(', ')}`);
  const again = await get(EG, url);
  check('…and the reader\'s own repeat is still Egari\'s', again.status === 200 && again.body.total === 2);
}

console.log('\n12. open mode and unrestricted readers are unchanged');
{
  const anon = await get(null, `/api/segments?${W}`);
  const all = await get(ALL, `/api/segments?${W}`);
  check('an anonymous visitor in open mode still gets both fleets', anon.status === 200 && anon.body.total === 5);
  check('…exactly what the unrestricted signed-in reader gets', JSON.stringify(anon.body) === JSON.stringify(all.body));
  const anonChip = await get(null, `/api/segments?${W}&fleet=egari`);
  check('the fleet chip alone does not narrow an open-mode answer (only the gate\'s parameter does)',
    anonChip.body.total === 5, String(anonChip.body.total));
  const anonK = await get(null, `/api/kpis?${W}`);
  check('the Overview for a visitor counts every tracker, as before', anonK.body.tracked_vehicles === 3);
}

console.log('\n13. a realistic reader: an Operations manager over Egari');
{
  const s = await get(OPS, `/api/segments?${W}`);
  check('the segment list opens for them, Egari\'s alone', s.status === 200 && s.body.total === 2 && leaks(s.body).length === 0,
    `${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
  const k = await get(OPS, `/api/kpis?${W}`);
  check('…and the Overview\'s figures', k.status === 200 && k.body.trips === 3, `${k.status} ${JSON.stringify(k.body).slice(0, 160)}`);
}

console.log('\n14. routes still mixed refuse with their own reason');
{
  const t = await get(EG, '/api/target');
  check('the revenue target: one company figure, said so', t.status === 403 && t.body.error === 'fleet_scope'
    && /one figure set for the company/.test(t.body.detail) && t.body.detail === MIXED_WHY['GET /api/target'], JSON.stringify(t.body));
  const d = await get(EG, '/api/driver/kpis?id=eg-d1');
  check('a driver page: a person\'s accounts can sit in both fleets', d.status === 403
    && /both fleets/.test(d.body.detail) && d.body.detail !== GENERIC_WHY, JSON.stringify(d.body));
  const c = await get(EG, '/api/ledger/people');
  check('the cash pages: cash is kept per person', c.status === 403 && /Cash is kept per person/.test(c.body.detail), JSON.stringify(c.body));
  /* Not narrowed, although its handler filters on ?fleet=: every break is
     written over both fleets (fleet_id null), so one fleet's list would be
     an empty list that reads as "nothing changed". */
  const b = await get(EG, '/api/breaks');
  check('the trend breaks: detected over both fleets together, so refused rather than answered empty',
    b.status === 403 && /detected over both fleets together/.test(b.body.detail), JSON.stringify(b.body));
  const allT = await get(ALL, '/api/target');
  check('…and the unrestricted reader is not refused any of them', allT.status !== 403, String(allT.status));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
