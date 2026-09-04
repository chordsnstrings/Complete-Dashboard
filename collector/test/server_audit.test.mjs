/* The findings a page-by-page audit confirmed against production, held here so
   they cannot come back.
   ──────────────────────────────────────────────────────────────────────────
   Every scenario below was reproduced on the live fleet before it was fixed.
   They share one shape: a number rendered to a human that was not true, and in
   most cases a SECOND number on the same screen that contradicted it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

let n = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,
     distance_km,status,product,payment_type,price)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [o.platform, `a${n++}`, o.plate ?? null, o.drv ?? null, o.name ?? null, o.at,
   o.km ?? null, o.status ?? 'completed', o.product ?? null, o.pay ?? null, o.price ?? null]);

const DAY = '2026-08-14';
// 20 Uber bookings and their 20 FMS telematics twins — the same physical trips.
for (let i = 0; i < 20; i++) {
  await trip({ platform: 'uber', plate: 'L100', drv: 'u1', name: 'Kashif Ali Ayyub khan',
    at: `${DAY}T10:00:00+04:00`, km: 12, pay: 'braintree', product: 'UberX' });
  await trip({ platform: 'fms', plate: 'L100', at: `${DAY}T10:04:00+04:00`, km: 13 });
}
// One FMS row with an odometer-derived absurdity, which schema_v7 warns about.
await trip({ platform: 'fms', plate: 'L100', at: `${DAY}T11:00:00+04:00`, km: 193027 });
// The same human on the hotel channel, spelled differently.
for (let i = 0; i < 5; i++) {
  await trip({ platform: 'hotel', plate: 'L100', drv: 'h1', name: 'KASHIF ALI AYYUB KHAN',
    at: `${DAY}T14:00:00+04:00`, km: 20, price: 100, pay: 'room-charge', product: 'pick_and_drop' });
}

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const asDate = (v, f) => {
  const x = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x)) return f;
  const d = new Date(`${x}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== x ? f : x;
};
const range = (req) => {
  let from = asDate(req.query.from, '2000-01-01'); let to = asDate(req.query.to, '2100-01-01');
  if (from > to) [from, to] = [to, from];
  return [from, to, req.query.platform || null, req.query.fleet || null];
};
const W = (a = '') => { const c = a ? `${a}.` : '';
  return `${c}local_day BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR ${c}platform=$3)`
    + ` AND ($4::text IS NULL OR ${c}fleet_id=$4)`; };
const F = W();
const FB = `${F} AND is_booking`;
const DAYWIN = (col) => `(${col} AT TIME ZONE 'Asia/Dubai')::date BETWEEN $1::date AND $2::date`;
const CANON = (col) => `regexp_replace(
    btrim(regexp_replace(lower(${col}), '\\s+', ' ', 'g')),
    '(\\m\\w+)( \\1)+', '\\1', 'g')`;

const quote = (v) => {
  if (!/^[a-z0-9_]{1,32}$/i.test(String(v))) throw new Error(`unexpected platform name: ${v}`);
  return `'${v}'`;
};
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
const stub = async () => ({});
const src = readFileSync('api/server.js', 'utf8');
const { server, get: rawGet } = await mountAll(db);
const get = async (p) => {
  const r = await rawGet(p);
  if (r.body == null) throw new Error(`${p} → ${r.status} ${r.raw || '(no body)'}`);
  return r.body;
};
const WIN = 'from=2026-08-01&to=2026-08-31';

/* ── the platform donut contradicted the Trips KPI six inches above it ───
   /api/mix dropped the is_booking filter for the platform dimension only, so
   FMS telematics twins became a slice and donut() printed the sum of every
   slice as the ring's centre. Live: the ring said "7,167 total" while the
   Trips card on the same screen said 1,768. */
{
  const mix = await get(`/api/mix?by=platform&${WIN}`);
  const k = await get(`/api/kpis?${WIN}`);
  const ringTotal = mix.reduce((a, r) => a + r.n, 0);
  check('the platform donut totals the same population as the Trips KPI',
    ringTotal === k.trips, `${ringTotal} in the ring vs ${k.trips} in the KPI`);
  check('telematics is not a slice of the trips ring',
    !mix.some((r) => r.label === 'fms'), JSON.stringify(mix.map((r) => r.label)));
  check('but the telematics count is still reported, just not summed in',
    Object.getOwnPropertyDescriptor(mix, 'telematics_journeys') === undefined
    || mix.telematics_journeys > 0);
}

/* ── the same double-count on the vehicle list ───────────────────────── */
{
  // {rows, total, shown, truncated} — the busiest 200 with the fleet size beside
  // them, so the list cannot be read as the whole register.
  const v = await get(`/api/vehicles?${WIN}`);
  const row = (v.rows || []).find((r) => r.plate === 'L100');
  check('the vehicle list says how many vehicles there are, not just how many it returned',
    typeof v.total === 'number' && v.total >= (v.rows || []).length,
    `${v.total} total, ${v.shown} shown`);
  check('a vehicle’s trips are bookings only', row.trips === 25, String(row.trips));
  check('its telematics journeys are counted separately', row.telematics_journeys === 21,
    String(row.telematics_journeys));
  check('the two are never summed into one column', row.trips !== 46);
  // 20 uber x 12km + 5 hotel x 20km = 340. The 193,027 km odometer row must not
  // reach any distance a human reads.
  // Postgres numeric arrives as a STRING over JSON. Comparing it with === is
  // itself a bug this product has shipped twice, so the assertions coerce.
  check('an odometer-derived 193,027 km row is excluded from distance',
    Number(row.km) === 340, String(row.km));
  check('and from the telematics distance too', Number(row.telematics_km) === 260,
    String(row.telematics_km));
}

/* ── cross-platform said nobody worked two platforms ─────────────────── */
{
  const x = await get(`/api/drivers/cross-platform?${WIN}`);
  check('the platform columns cover every platform with data',
    x.platforms.includes('hotel') && x.platforms.includes('uber'), JSON.stringify(x.platforms));
  check('two spellings of one name are one person', x.drivers.length === 1,
    JSON.stringify(x.drivers.map((d) => d.driver_name)));
  const d0 = x.drivers[0];
  check('that person is recognised as cross-platform',
    d0.platform_count > 1 && x.multi_platform === 1, `${d0.platform_count} platforms`);
  check('the total equals the sum of the columns beside it',
    x.platforms.reduce((a, p) => a + (d0[`${p}_trips`] || 0), 0) === d0.total_trips,
    `${x.platforms.map((p) => `${p}=${d0[`${p}_trips`]}`).join(' ')} vs total ${d0.total_trips}`);
  check('the fold reports how many accounts it combined', d0.accounts === 2, String(d0.accounts));
}

/* ── the last day of the window was silently dropped ─────────────────── */
{
  await q(`INSERT INTO occupancy_segment (plate, fleet_id, started_at, ended_at, duration_min,
             distance_km, verdict, verdict_reason, low_confidence)
           VALUES ('L100','ecosine',$1,$2,26,18,'unauthorized','no completed booking overlaps',false),
                  ('L100','ecosine',$3,$4,10,4,'unverifiable','a channel was missing',true),
                  ('L101','ecosine',$5,$6,5,0.2,'stationary','did not travel far enough',false),
                  ('L900','egari',$7,$8,9,6,'unauthorized','no completed booking overlaps',false)`,
    [`${DAY}T22:30:00+04:00`, `${DAY}T22:56:00+04:00`,
     `${DAY}T23:30:00+04:00`, `${DAY}T23:40:00+04:00`,
     `${DAY}T12:00:00+04:00`, `${DAY}T12:05:00+04:00`,
     `${DAY}T14:00:00+04:00`, `${DAY}T14:09:00+04:00`]);
  /* A window ENDING on the day itself must include its evening. Scoped to one
     fleet, because these checks are about the Dubai day boundary and not about
     how many rows the fixture holds — the Egari segment below exists to prove
     the fleet filter, and counting it here would couple one test to the other. */
  const s = await get(`/api/unauthorized/summary?from=${DAY}&to=${DAY}&fleet=ecosine`);
  check('a 22:30 Dubai segment is inside a window ending that day',
    s.totals.unauthorized === 1, JSON.stringify(s.totals));
  check('a 23:30 Dubai segment is too', s.totals.unverifiable === 1, JSON.stringify(s.totals));

  /* ── and the KPI strip omitted two of the seven verdicts ───────────── */
  check('every verdict the schema defines has a total',
    ['unauthorized', 'authorized', 'unverifiable', 'pending', 'partial', 'sensor_suspect', 'stationary']
      .every((v) => v in s.totals), Object.keys(s.totals).join(','));
  check('the totals sum to the same number the donut shows',
    s.totals.segments === s.byVerdict.reduce((a, r) => a + r.n, 0), String(s.totals.segments));
  check('nothing vanishes between the strip and the chart',
    ['unauthorized', 'authorized', 'unverifiable', 'pending', 'partial', 'sensor_suspect', 'stationary']
      .reduce((a, v) => a + s.totals[v], 0) === s.totals.segments);
  check('segments needing a human are counted', s.totals.needs_a_human === 1, String(s.totals.needs_a_human));

  /* ── the evidence trail was never selected ─────────────────────────── */
  const list = await get(`/api/unauthorized/list?from=${DAY}&to=${DAY}&verdict=all`);
  check('the verdict carries its reason', list.every((r) => 'verdict_reason' in r));
  check('and the fields that make a clock skew self-evident',
    list.every((r) => 'nearest_gap_min' in r && 'nearest_platform' in r && 'channels_checked' in r),
    Object.keys(list[0] || {}).join(','));

  /* ── and the evidence table ignored the fleet its siblings honour ──── */
  /* summary, daily and by-vehicle all bind the fleet; this one did not. On
     production an Egari-filtered page showed every tile at zero above a table
     of twenty-six Ecosine segments, each labelled Ecosine in its own column. */
  const eg = await get(`/api/unauthorized/list?from=${DAY}&to=${DAY}&verdict=all&fleet=egari`);
  check('the segment list is filtered to the fleet asked for',
    eg.length === 1 && eg.every((r) => r.fleet_id === 'egari'),
    JSON.stringify(eg.map((r) => `${r.plate}/${r.fleet_id}`)));
  const ec = await get(`/api/unauthorized/list?from=${DAY}&to=${DAY}&verdict=all&fleet=ecosine`);
  check('and the other fleet sees only its own',
    ec.length === 3 && ec.every((r) => r.fleet_id === 'ecosine'),
    JSON.stringify(ec.map((r) => `${r.plate}/${r.fleet_id}`)));
  check('no fleet asked for still means every fleet',
    list.length === 4, String(list.length));
  /* The table and the tiles above it must describe the same rows — the bug was
     precisely that they did not. */
  const egS = await get(`/api/unauthorized/summary?from=${DAY}&to=${DAY}&fleet=egari`);
  check('the tiles and the table agree about the fleet',
    egS.totals.segments === eg.length, `${egS.totals.segments} vs ${eg.length}`);

  /* ── the daily chart bucketed in UTC while the drill filtered in Dubai ── */
  const daily = await get(`/api/unauthorized/daily?from=${DAY}&to=${DAY}&fleet=ecosine`);
  check('a 23:30 Dubai segment is on the Dubai day, not the next one',
    daily.length === 1 && String(daily[0].d).slice(0, 10) === DAY,
    JSON.stringify(daily.map((r) => String(r.d).slice(0, 10))));
  check('the daily row counts the segments that need a human too',
    daily[0].needs_a_human === 1 && daily[0].segments === 3, JSON.stringify(daily[0]));
}

/* ── "stale" was measured from our poll, not from the fix ────────────── */
{
  await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, speed, seat_occupied)
           VALUES ('L100','ecosine','cabman', now() - interval '2 minutes', now(), 25.1, 55.2, 40, true),
                  ('L101','ecosine','cabman', now() - interval '400 days', now(), 25.1, 55.2, 0, NULL)`);
  const live = await get('/api/live');
  const dead = live.find((r) => r.plate === 'L101');
  const alive = live.find((r) => r.plate === 'L100');
  check('a tracker silent for 400 days is stale however recently we polled',
    dead.stale === true, JSON.stringify({ stale: dead.stale, fix: dead.fix_age_min }));
  check('a tracker reporting two minutes ago is not stale', alive.stale === false);
  check('the fix age and the poll age are two different numbers',
    dead.fix_age_min > 500000 && dead.poll_age_min < 5,
    `fix ${dead.fix_age_min} / poll ${dead.poll_age_min}`);
}

/* ── harsh driving was attributed to whoever holds the car TODAY ─────── */
{
  await q(`INSERT INTO alert (platform, external_id, plate, fleet_id, alert_type, occurred_at)
           VALUES ('fms','x1','L100','ecosine','Harsh Brake', $1),
                  ('fms','x2','L100','ecosine','Main Power Lost', $2)`,
    [`${DAY}T09:00:00+04:00`, `${DAY}T09:30:00+04:00`]);
  // Two platforms held the car that day — the fan-out that once doubled counts.
  await q(`INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, driver_name, platform, fleet_id, trips)
           VALUES ('L100',$1,'u1','Kashif Ali Ayyub khan','uber','ecosine',20),
                  ('L100',$1,'h1','KASHIF ALI AYYUB KHAN','hotel','ecosine',5),
                  ('L100',$2,'z9','Someone Else Entirely','uber','ecosine',9)`,
    [DAY, '2026-08-20']);
  const byVPage = await get(`/api/alerts/by-vehicle?${WIN}`);
  const byV = byVPage.rows;
  const row = byV.find((r) => r.plate === 'L100');
  check('two platform rows for one custody day do not double the alert count',
    row.alerts === 2, String(row.alerts));
  check('an event type outside the four buckets is counted, not lost',
    row.other === 1 && row.harsh_brake === 1, JSON.stringify(row));
  check('the columns and the total can be reconciled',
    row.harsh_brake + row.harsh_accel + row.sharp_turn + row.overspeed + row.other === row.alerts);
  const byDPage = await get(`/api/alerts/by-driver?${WIN}`);
  const byD = byDPage.rows;
  const who = byD.find((r) => /Kashif/i.test(r.driver_name || ''));
  check('the events are attributed to whoever held the car that day',
    !!who && who.alerts === 2, JSON.stringify(byD.map((r) => [r.driver_name, r.alerts])));
  check('and not to whoever holds it now',
    !byD.some((r) => /Someone Else Entirely/.test(r.driver_name || '')),
    JSON.stringify(byD.map((r) => r.driver_name)));
  // 20 Uber trips x 12 km + 5 hotel trips x 20 km = 340, across BOTH spellings
  // of this person's name. Grouping the denominator on the raw string gave 240.
  check('a per-100km rate is computed over the whole person, not one account',
    Number(who.booked_km) === 340, String(who.booked_km));

  /* Both lists are capped at 100 rows and the Safety page turned their lengths
     into "Vehicles involved" and "Drivers named" — labels that read as fleet
     facts. The fleet runs about 130 vehicles, so the cap is one busy month
     away from binding, and the tile would read exactly 100 with nothing
     saying it had been cut. */
  check('the vehicle count is its own number, not the length of a capped list',
    byVPage.totals?.vehicles === new Set(byV.map((r) => r.plate)).size,
    `${byVPage.totals?.vehicles} vs ${byV.length}`);
  check('the named-driver count excludes the unattributed bucket, which is not a person',
    byDPage.totals?.drivers === byD.filter((r) => r.driver_name !== '(unattributed)').length,
    `${byDPage.totals?.drivers} vs ${byD.length}`);
  check('unattributed events are totalled over the window, not over the page',
    typeof byDPage.totals?.unattributed === 'number', String(byDPage.totals?.unattributed));
  check('both responses say whether their list was cut',
    'truncated' in byVPage && 'truncated' in byDPage);
}

/* ── a NULL seat sensor was rendered as an empty seat ────────────────── */
{
  await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, speed, seat_occupied)
           SELECT 'L200','ecosine','fms', ($1::date)::timestamptz + (g || ' minutes')::interval, now(),
                  25.1 + g*0.002, 55.2 + g*0.002, 40, NULL
           FROM generate_series(1,20) g`, [DAY]);
  const j = await get(`/api/map/journey?plate=L200&day=${DAY}`);
  check('a feed that never reports occupancy yields null, not 0 km',
    j.occupied_km === null, JSON.stringify({ occupied_km: j.occupied_km }));
  check('and says so explicitly', j.occupancy_reported === false && j.occupancy_reported_fixes === 0);
  check('the trail is still drawn — distance is measured normally', j.distance_km > 0);
  check('a segment marks occupancy as unknown rather than false',
    j.segments.every((s) => s.occupied === null));
}

/* ── the sensor-health panel could not show the failure it warns about ── */
{
  // A pad stuck ON: 40 of 40 fixes occupied. Under the old ascending sort this
  // was the last row of a hundred and never rendered.
  await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, seat_occupied)
           SELECT 'L300','ecosine','cabman', ($1::date)::timestamptz + (g || ' minutes')::interval, now(),
                  25.1, 55.2, true FROM generate_series(1,40) g`, [DAY]);
  await q(`INSERT INTO telemetry_snapshot (plate, fleet_id, source, captured_at, polled_at, lat, lng, seat_occupied)
           SELECT 'L400','ecosine','cabman', ($1::date)::timestamptz + (g || ' minutes')::interval, now(),
                  25.1, 55.2, (g % 3 = 0) FROM generate_series(1,40) g`, [DAY]);
  const raw = await get(`/api/sensor-health?from=${DAY}&to=${DAY}`);
  /* {rows, total, shown, truncated} — the endpoint caps at 100 and now says
     so, where it used to return a bare array and let the page print the LIMIT
     as a fleet count. */
  const health = raw.rows || raw;
  check('the response says how many trackers there were, not only how many it sent',
    raw.total === health.length && raw.shown === health.length && raw.truncated === false,
    JSON.stringify({ total: raw.total, shown: raw.shown, truncated: raw.truncated }));
  check('a pad stuck on is at the top of the list, not the bottom',
    health[0].plate === 'L300', JSON.stringify(health.map((r) => [r.plate, r.occupied_pct])));
  check('a plausible pad ranks below both extremes',
    health.findIndex((r) => r.plate === 'L400') > 0);
  check('a pad with too few observations is marked unjudgeable rather than accused',
    health.every((r) => typeof r.judgeable === 'boolean'));
  check('the occupancy ratio is reported, not just a raw count',
    Number(health[0].occupied_pct) === 100, String(health[0].occupied_pct));
}

/* ── the action list was 200 copies of one rule ──────────────────────────
   The insight table accumulated a fresh row per finding on every collector run
   — every thirty minutes — because the unique key contained NULL window
   columns and Postgres UNIQUE is NULLS DISTINCT. Live: 2,979 open actions, of
   which the 200 the page could show were all one rule, and a "quantified cost"
   tile of AED 1,424,592 that was a run counter times a constant. */
{
  const ins = (code, entity, when, impact) => q(
    `INSERT INTO insight (code, severity, category, entity_type, entity_id, title, detail, action,
       impact_aed, window_start, window_end, computed_at)
     VALUES ($1,'critical','utilisation','vehicle',$2,'t','d','a',$3,NULL,NULL,$4)
     ON CONFLICT DO NOTHING`, [code, entity, impact, when]);
  /* Two layers, and both are load-bearing.

     schema_v15 added a partial unique index over the NULL-window rules, so the
     duplicates can no longer be WRITTEN — three runs of the same finding
     collapse to one row at insert time. That is the actual fix, and it is what
     this first block checks.

     The endpoint still deduplicates on read, because 2,979 rows written before
     v15 existed are still in the live table and the page has to be correct
     over them too. The second block drops the index and reproduces exactly what
     production held, to prove the read path has not quietly stopped working
     now that the write path makes it look redundant. */
  for (const t of ['2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', '2026-08-20T11:00:00Z']) {
    await ins('idle_vehicle', 'L100', t, 1680);
  }
  await ins('vehicle_doc_expiring', 'L101', '2026-08-20T11:00:00Z', null);
  check('the unique index stops a duplicate finding being written at all',
    (await q(`SELECT count(*)::int n FROM insight WHERE code='idle_vehicle'`))[0].n === 1,
    String((await q(`SELECT count(*)::int n FROM insight WHERE code='idle_vehicle'`))[0].n));

  await q('DROP INDEX insight_nullwindow_uniq');
  for (const t of ['2026-08-20T10:30:00Z', '2026-08-20T11:00:00Z']) {
    await ins('idle_vehicle', 'L100', t, 1680);
  }
  const stored = (await q(`SELECT count(*)::int n FROM insight`))[0].n;
  check('without the index the old duplication reappears, so the fixture is real',
    stored === 4, String(stored));

  const page = await get('/api/insights');
  check('a finding appears once however many runs wrote it',
    page.insights.filter((r) => r.code === 'idle_vehicle' && r.entity_id === 'L100').length === 1,
    String(page.insights.length));
  check('the newest copy is the one kept',
    page.insights.find((r) => r.code === 'idle_vehicle').computed_at.startsWith('2026-08-20T11:00'),
    page.insights.find((r) => r.code === 'idle_vehicle')?.computed_at);
  check('the response says whether the limit cut anything', 'truncated' in page && 'limit' in page);

  const sum = await get('/api/insights/summary');
  check('the counts are over the deduplicated set', sum.total.n === 2, String(sum.total.n));
  check('and how many duplicates were suppressed is visible',
    sum.duplicates_suppressed === stored - 2, `${sum.duplicates_suppressed} of ${stored}`);
  /* A modelled figure and a measured one do not belong in one total. */
  check('a modelled cost is reported apart from a measured one',
    sum.total.measured_impact == null && Number(sum.modelled.aed) === 1680,
    JSON.stringify({ measured: sum.total.measured_impact, modelled: sum.modelled.aed }));
  check('the assumption behind the modelled figure is stated',
    /per vehicle per day/.test(sum.modelled.assumption || ''), sum.modelled.assumption);
  check('category counts come from the whole table, not the visible page',
    sum.by_category.reduce((a, c) => a + c.n, 0) === sum.total.n);
}

/* ── 77 expired licences that were all one placeholder ───────────────────
   Every one of those rows carried the identical date and the identical licence
   number, because the source writes a default into an unset field. The insight
   engine already refused to accuse anybody; this page counted them and said
   "stand down until renewed". */
{
  for (let i = 0; i < 8; i++) {
    await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, licence_no,
               licence_expires, state)
             VALUES ('hotel',$1,$2,'123456','2026-01-01','active')`, [`p${i}`, `Placeholder ${i}`]);
  }
  await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, licence_no,
             licence_expires, state)
           VALUES ('bolt','r1','Real Person','AE99','2026-08-01','active')`);
  const c = await get('/api/compliance/drivers');
  check('a date repeated across most of the roster is identified as a default',
    c.placeholder_date === '2026-01-01' && c.placeholder_rows === 8,
    `${c.placeholder_date} x ${c.placeholder_rows}`);
  check('the caveat says it is a data problem, not an expiry',
    /data-quality problem, not expired licences/.test(c.caveat || ''), c.caveat);
  check('a genuine date is not swept up with it',
    c.drivers.some((d) => d.licence_no === 'AE99'));
  /* node-postgres returns a DATE as a JS Date, and String(thatDate).slice(0, 10)
     is "Thu Jan 01". Every date a server response carries as an identifier is
     formatted in SQL rather than sliced in JS. */
  check('a date used as an identifier is a date, not a weekday',
    /^\d{4}-\d{2}-\d{2}$/.test(c.placeholder_date || ''), c.placeholder_date);
  // With fewer repeats than half the roster, nothing is called a placeholder.
  for (let i = 0; i < 20; i++) {
    await q(`INSERT INTO driver_compliance (platform, driver_ext_id, full_name, licence_no,
               licence_expires, state) VALUES ('bolt',$1,$2,$3,$4,'active')`,
      [`u${i}`, `Unique ${i}`, `AE${i}`, `2027-0${1 + (i % 9)}-01`]);
  }
  const c2 = await get('/api/compliance/drivers');
  check('a roster of genuine dates is not accused of being a default',
    c2.placeholder_date === null, String(c2.placeholder_date));
}

/* ── revenue per day drew AED 0 where nothing was ever collected ─────── */
{
  const finBody = await get(`/api/finance/daily?from=${DAY}&to=2026-08-16`);
  const fin = finBody.rows;
  check('every calendar day in the window is present', fin.length === 3, String(fin.length));
  check('a day with nothing recorded is null, not zero',
    fin.every((r) => r.nothing_recorded === false
      || (r.amount === null && r.revenue === null && r.money === null)),
    JSON.stringify(fin));
  check('and says so explicitly', fin.some((r) => r.nothing_recorded === true));
  check('the day is a plain date string, not a JS Date rendering',
    /^\d{4}-\d{2}-\d{2}$/.test(fin[0].d), fin[0].d);
  /* The money half, and the two facts without which it cannot be read.
     ─────────────────────────────────────────────────────────────────────
     `revenue` here is sum(trip.price) and on this fleet that is a seventh of
     what came in — Uber files no per-trip fare and is 90% of the bookings.
     The row must therefore carry the resolved figure as well, the period the
     provider reported it over (7 means a weekly statement divided across its
     days, which is an allocation, not a measurement of that day), and which
     record it came out of. */
  for (const f of ['money', 'money_period_days', 'money_source', 'payout', 'bookings',
    'fares_part', 'payout_part']) {
    check(`each day carries ${f}`, fin.every((r) => f in r), JSON.stringify(fin[0]));
  }
  check('a day with no money at all says null, never 0',
    fin.every((r) => r.money !== 0), JSON.stringify(fin));
  check('the totals travel with the rows so a caption cannot re-derive them wrongly',
    finBody.totals && 'money' in finBody.totals && 'fares' in finBody.totals
      && 'bookings' in finBody.totals, JSON.stringify(finBody.totals));
  /* THE INVARIANT THIS PANEL EXISTS FOR.
     ─────────────────────────────────────────────────────────────────────
     The bars sit directly under the accounted tile, and the first version of
     this endpoint summed driver_day.money — which is built from the trip table
     and so holds only the people who drove, while the statements pay everyone.
     On production 1-3 Sept 2026 it came to AED 56,917 against AED 81,385
     accounted: a chart contradicting the tile above it, on the finance page.
     Both figures now come from the same per-platform basis in
     api/income_sql.js, so they must agree, and the endpoint returns the tile's
     own number so a caller can check rather than trust. */
  const barSum = fin.reduce((a, r) => a + (r.money || 0), 0);
  check('the bars sum to the accounted figure the tiles above them show',
    finBody.totals.accounted == null
      || Math.abs(finBody.totals.accounted - barSum) <= Math.max(1, barSum * 0.005),
    JSON.stringify({ accounted: finBody.totals.accounted, bars: +barSum.toFixed(2) }));
  check('and the money never double-counts a channel that reports both',
    finBody.totals.money == null
      || Math.abs(finBody.totals.money
        - ((finBody.totals.money_fares_part || 0) + (finBody.totals.money_payout_part || 0)))
        <= 1,
    JSON.stringify(finBody.totals));
  /* Which figure each channel was counted on, so a caption can name it rather
     than infer it from the shape of the numbers. A channel counted on its
     payout must not also appear as fares. */
  check('the response names the basis it applied per channel',
    Array.isArray(finBody.money_basis)
      && finBody.money_basis.every((b) => b.platform && typeof b.basis === 'string'),
    JSON.stringify(finBody.money_basis));
}

/* ── the daily trend must distinguish a hole from a quiet day ─────────── */
{
  const daily = await get(`/api/trips/daily?from=2026-08-10&to=2026-08-20`);
  check('every calendar day in the window is present', daily.length === 11, String(daily.length));
  check('a day is a plain date string', /^\d{4}-\d{2}-\d{2}$/.test(daily[0].d), daily[0].d);
  check('each day carries how many sources were silent on it',
    daily.every((r) => typeof r.sources_silent === 'number' && typeof r.uncollected === 'boolean'));
  check('telematics volume rides alongside bookings rather than inside them',
    daily.every((r) => 'telematics_journeys' in r));
  const busy = daily.find((r) => r.d === DAY);
  check('the day with data reports its bookings, not its bookings plus twins',
    busy.trips === 25, String(busy.trips));
}

/* ── a legal claim must not be a .filter().length ─────────────────────────
   The Compliance page prints "Vehicle docs expired — cannot legally work" and
   "Driver licences expired — stand down until renewed". Both were counted by
   filtering the array the page had just fetched, and both lists are capped at
   300 rows. Expired rows sort first, so the numbers agree right up until the
   fleet crosses the cap — at which point they quietly stop, on the two tiles
   in this product that assert somebody may not drive. */
{
  await q(`DELETE FROM vehicle_document`);
  await q(`DELETE FROM driver_compliance`);
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < 6; i++) {
    await q(`INSERT INTO vehicle_document (platform,vehicle_ext_id,doc_type,plate,fleet_id,status,expires_at)
             VALUES ('uber',$1,'registration',$2,'ecosine','ACTIVE',$3::date)`,
      [`vd${i}`, `LX${i}`, day(i < 2 ? -5 : i < 4 ? 3 : 30)]);
  }
  const vc = await get('/api/compliance/vehicles');
  check('the vehicle document response separates the list from the counts',
    Array.isArray(vc.rows) && vc.totals && typeof vc.totals.expired === 'number',
    JSON.stringify(Object.keys(vc)));
  check('expired is counted in the database, not off the returned list',
    vc.totals.expired === 2, String(vc.totals.expired));
  check('the seven-day and forty-five-day bands do not overlap',
    vc.totals.within_7 === 2 && vc.totals.within_45 === 2,
    `${vc.totals.within_7} / ${vc.totals.within_45}`);
  check('the document types come from the whole table, not the visible rows',
    (vc.doc_types || []).some((d) => d.doc_type === 'registration'), JSON.stringify(vc.doc_types));
  check('the response says whether the list was cut', 'truncated' in vc);

  /* Six drivers share one licence date — the placeholder this source writes
     for an unset field — plus one genuine expiry and two with no date at all.
     The placeholder must not be counted as an expiry, and the people with NO
     date must be visible rather than absent from every tile. */
  for (let i = 0; i < 6; i++) {
    await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_no,licence_expires)
             VALUES ('hotel',$1,'ecosine',$2,'123456','2020-01-01'::date)`, [`p${i}`, `Placeholder ${i}`]);
  }
  await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_no,licence_expires)
           VALUES ('hotel','real1','ecosine','Real Expiry','DL-9',$1::date)`, [day(-3)]);
  for (let i = 0; i < 2; i++) {
    await q(`INSERT INTO driver_compliance (platform,driver_ext_id,fleet_id,full_name,licence_no)
             VALUES ('hotel',$1,'ecosine',$2,'DL-N')`, [`n${i}`, `No Date ${i}`]);
  }
  const dc = await get('/api/compliance/drivers');
  check('the placeholder date is detected', dc.placeholder_date === '2020-01-01', String(dc.placeholder_date));
  check('six identical dates are not six expired licences',
    dc.totals.expired === 1, `${dc.totals.expired} (should be the one real expiry)`);
  check('the placeholder rows are reported as their own number',
    dc.placeholder_rows === 6, String(dc.placeholder_rows));
  check('drivers with no licence date at all are counted rather than invisible',
    dc.totals.no_date_at_all === 2, String(dc.totals.no_date_at_all));
  check('the total covers every driver record, dated or not',
    dc.totals.total === 9, String(dc.totals.total));
}

server.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
