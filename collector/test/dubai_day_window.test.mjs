/* A window must mean the DUBAI day, on every page that has one.
   ──────────────────────────────────────────────────────────────────────────
   /api/cancellations shipped bounding on `n.requested_at >= $1 AND
   n.requested_at <= $2`, with $1/$2 a pair of naked date strings that the
   server's UTC session reads as UTC midnights. sql/schema_v18.sql:84 defines
   local_day as (requested_at AT TIME ZONE 'Asia/Dubai')::date, and every
   other windowed route in the product bounds on that instead — twenty-seven
   call sites of `local_day BETWEEN $1::date AND $2::date`.

   So this one page's "day" began at 04:00 Dubai and ran to 03:59 the next
   morning. MEASURED on production 2026-09-10, this endpoint against the daily
   rollup over identical windows — both counting outcome = 'not_completed':

     window            rollup   the page   out by
     today             77       65         -12   (-16%)
     yesterday         85       88          +3
     week (07-10)     354      343         -11
     month (01-10)    856      846         -10

   The live figure was always the one most wrong, because today loses its own
   first four hours and has not yet reached the four it borrows from tomorrow.
   The live figure is also the one on screen.

   The fixture below is built so the two bounds do not merely disagree by a
   few rows — they name DIFFERENT DRIVERS. Every cancellation lives inside the
   00:00–04:00 Dubai band, which is the band the UTC bound moves across a date
   boundary, so a regression cannot pass by counting the same total twice. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* Times are written Dubai-local with their offset, because the whole defect is
   about which calendar a time belongs to and a UTC literal here would hide the
   question the fixture is asking. The UTC instant is spelled out beside each
   one so the arithmetic is checkable without a timezone database. */
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, status, distance_km)
   VALUES ('uber', $1, 'ecosine', $2, $3, $4, $5, $5, $6, 8)`,
  [o.id, o.plate, o.drv, `Driver ${o.drv}`, o.at, o.status]);

// Driver A cancels twice in the small hours of Dubai's 5 August.
await trip({ id: 'a1', plate: 'L1', drv: 'd-a', at: '2026-08-05T01:00:00+04:00', status: 'rider_cancelled' });   // 2026-08-04 21:00 UTC
await trip({ id: 'a2', plate: 'L1', drv: 'd-a', at: '2026-08-05T03:30:00+04:00', status: 'driver_cancelled' });  // 2026-08-04 23:30 UTC
await trip({ id: 'a3', plate: 'L1', drv: 'd-a', at: '2026-08-05T12:00:00+04:00', status: 'completed' });

// Driver B cancels in the small hours of Dubai's 6 August — the NEXT day, but
// still 5 August in UTC, which is the row the broken bound reached for.
await trip({ id: 'b1', plate: 'L2', drv: 'd-b', at: '2026-08-06T02:00:00+04:00', status: 'rider_cancelled' });   // 2026-08-05 22:00 UTC
await trip({ id: 'b2', plate: 'L2', drv: 'd-b', at: '2026-08-06T12:00:00+04:00', status: 'completed' });

/* Alerts too. alert.occurred_at is a raw timestamptz with no local_day beside
   it, so fourteen queries behind the vehicle page bound it as
   `BETWEEN $1 AND $2` — the same four-hour error as the trip counts, on the
   safety figures. Two of these three sit in the band that moves. */
const alert = (id, plate, at) => q(
  `INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
   VALUES ('fms', $1, 'ecosine', $2, 'Harsh Brake', $3)`, [id, plate, at]);
await alert('k1', 'L1', '2026-08-05T00:30:00+04:00');   // 2026-08-04 20:30 UTC
await alert('k2', 'L1', '2026-08-05T03:59:00+04:00');   // 2026-08-04 23:59 UTC
await alert('k3', 'L1', '2026-08-05T15:00:00+04:00');   // 2026-08-05 11:00 UTC
await alert('k4', 'L1', '2026-08-06T01:00:00+04:00');   // the NEXT Dubai day

const { server, get } = await mountAll(db);

/* ── what the database itself says, so the endpoint is checked against the
      definition rather than against another copy of the endpoint ─────────── */
const truth = await q(
  `SELECT local_day::text AS d, count(*)::int AS c
     FROM trip_norm n WHERE n.outcome = 'not_completed' GROUP BY 1 ORDER BY 1`);
check('the fixture puts two cancellations on the Dubai 5th and one on the 6th',
  JSON.stringify(truth) === JSON.stringify([{ d: '2026-08-05', c: 2 }, { d: '2026-08-06', c: 1 }]),
  JSON.stringify(truth));

/* ── one Dubai day ──────────────────────────────────────────────────────── */
const day5 = (await get('/api/cancellations?from=2026-08-05&to=2026-08-05')).body;
check('a one-day window counts the cancellations that happened on that Dubai day',
  day5.totals?.cancelled === 2, JSON.stringify(day5.totals));
/* The sharp end. Bounded on requested_at this answered 1, and it was the OTHER
   driver's — a page naming the wrong person to ring is worse than a page
   naming a number that is slightly off. */
check('and names the driver who cancelled on it, not the one four hours past midnight after',
  day5.rows?.length === 1 && day5.rows[0].driver_ext_id === 'd-a',
  JSON.stringify(day5.rows?.map((r) => r.driver_ext_id)));
check('a cancellation at 01:00 Dubai is not pushed into the previous day',
  day5.rows?.[0]?.by_rider === 1 && day5.rows?.[0]?.by_driver === 1,
  JSON.stringify(day5.rows?.[0]));

const day6 = (await get('/api/cancellations?from=2026-08-06&to=2026-08-06')).body;
check('the next Dubai day gets its own 02:00 cancellation and nobody else’s',
  day6.totals?.cancelled === 1 && day6.rows?.[0]?.driver_ext_id === 'd-b',
  JSON.stringify(day6.totals));

/* ── no row may fall between two adjacent windows, or be counted by both ── */
const both = (await get('/api/cancellations?from=2026-08-05&to=2026-08-06')).body;
check('two adjacent day windows partition the span exactly, losing and duplicating nothing',
  both.totals?.cancelled === day5.totals.cancelled + day6.totals.cancelled
    && both.totals.cancelled === 3, JSON.stringify(both.totals));

/* ── and it must agree with the endpoint the operator would check it against ─
   This is the comparison that exposed the defect in production: two pages over
   one window, both counting outcome = 'not_completed', disagreeing. A green
   test that only ever asks this endpoint cannot see that. */
for (const w of ['from=2026-08-05&to=2026-08-05', 'from=2026-08-06&to=2026-08-06',
  'from=2026-08-01&to=2026-08-31']) {
  const daily = (await get(`/api/trips/daily?${w}`)).body;
  const rollupTotal = (Array.isArray(daily) ? daily : daily.rows || [])
    .reduce((a, r) => a + (Number(r.cancelled) || 0), 0);
  const page = (await get(`/api/cancellations?${w}`)).body;
  check(`the daily rollup and the cancellations page agree over ${w}`,
    rollupTotal === page.totals?.cancelled,
    `rollup ${rollupTotal} vs page ${page.totals?.cancelled}`);
}

/* ── the source, because a comment that describes a different query from the
      one beneath it is how this shipped in the first place ───────────────── */
{
  /* Comments stripped first. The block above the query QUOTES the predicate
     being removed, on purpose — the point of the note is that this code used
     to read that way — and a grep over the raw file would read the warning as
     the offence. Only the code is asserted about. */
  const code = readFileSync('api/cancellation_routes.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('the route bounds on local_day',
    /n\.local_day BETWEEN \$1::date AND \$2::date/.test(code));
  check('and no longer compares a date string against the requested_at timestamp',
    !/n\.requested_at/.test(code));
  check('and takes calendar bounds from winDays, not the end-of-day timestamps win() builds',
    /winDays\(req\)/.test(code) && !/[^s]\bwin\(req\)/.test(code));
}

/* ── the same defect, on the vehicle page ────────────────────────────────
   api/vehicle_routes.js carried one window constant, TW, shared by twelve
   queries behind the vehicle detail page, and it bound on requested_at while
   the vehicles DIRECTORY in the same file bound on local_day. So the list and
   the car's own page answered the same question two ways. MEASURED on
   production 2026-09-10 for plate L36397 at period=today: the directory said
   26 trips, /api/vehicle/kpis said 25. Over a ten-day window the two happened
   to agree exactly, which is how it survived — a four-hour error is invisible
   until somebody asks for a short window, and "today" is the shortest and the
   most read.

   Asserted here rather than in a vehicle-only test because it is the same
   defect: two ideas of what a day is, in one product. */
for (const [plate, day, trips] of [['L1', '2026-08-05', 3], ['L2', '2026-08-06', 2]]) {
  const w = `from=${day}&to=${day}`;
  const dir = (await get(`/api/vehicles/directory?${w}`)).body;
  const listed = (Array.isArray(dir) ? dir : dir.rows || dir.vehicles || [])
    .find((r) => r.plate === plate);
  const kpis = (await get(`/api/vehicle/kpis?plate=${plate}&${w}`)).body;
  check(`${plate} on the Dubai ${day}: the directory counts the whole day`,
    Number(listed?.trips) === trips, `${listed?.trips} of ${trips}`);
  check(`${plate} on the Dubai ${day}: and its own page counts the same day`,
    Number(kpis?.trips) === trips, `${kpis?.trips} of ${trips}`);
}

/* The trip list behind the page is bounded by the same constant, so it must
   hold the same rows the count claims. A total that disagrees with the rows
   under it is the version of this bug a reader can actually see. */
{
  const t = (await get('/api/vehicle/trips?plate=L1&from=2026-08-05&to=2026-08-05')).body;
  check('the vehicle trip list holds every trip of that Dubai day, and only those',
    t.total === 3 && t.rows?.length === 3, `${t.total} total, ${t.rows?.length} rows`);
}

{
  const code = readFileSync('api/vehicle_routes.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the vehicle window constant bounds on local_day',
    /const TW = .plate = \$3 AND local_day BETWEEN \$1::date AND \$2::date./.test(code));
  check('and no query behind the vehicle page reads the base table around it',
    !/FROM trip WHERE \$\{TW\}/.test(code));
}

/* A safety figure must be cut on the same midnight as the trip beside it. Read
   off /api/vehicle/safety, whose alert count is bounded by TS() alone — the
   alerts_per_100km path narrows to the covered-day set as well, so it would
   pass even with the window wrong and cannot stand as the proof. */
{
  const sf = (await get('/api/vehicle/safety?plate=L1&from=2026-08-05&to=2026-08-05')).body;
  const n = sf.alerts ?? sf.total ?? sf.count
    ?? (sf.by_type || []).reduce((a, r) => a + (Number(r.n) || 0), 0);
  check('three alerts happened on L1 during the Dubai 5th, and three are counted',
    n === 3, `${n} of 3`);
  const next = (await get('/api/vehicle/safety?plate=L1&from=2026-08-06&to=2026-08-06')).body;
  const m = next.alerts ?? next.total ?? next.count
    ?? (next.by_type || []).reduce((a, r) => a + (Number(r.n) || 0), 0);
  check('and the 01:00 one belongs to the 6th, not to the night before it',
    m === 1, `${m} of 1`);
}

{
  const code = readFileSync('api/vehicle_routes.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('no query behind the vehicle page still bounds a timestamp on the UTC day',
    !/(occurred_at|captured_at|started_at) BETWEEN \$1 AND \$2/.test(code));
  check('they share one Dubai-midnight window expression rather than fourteen copies',
    (code.match(/\$\{TS\('/g) || []).length === 14,
    String((code.match(/\$\{TS\('/g) || []).length));
}

/* ── the class, not the four instances ───────────────────────────────────
   This bug was fixed once in api/driver_routes.js — its DAYWIN comment
   reconciles a driver's August day by day and finds 283 trips against a
   stored 285 — and then shipped again on the cancellations page, the vehicle
   page, the cohort comparison and the map. Four times, because a fix in one
   file teaches nothing to the next one written.

   So the rule is asserted over the whole read API rather than over the files
   that happened to break: a column known to be a raw timestamptz may not be
   compared against a bare window placeholder. The list is the columns this
   product windows on; a new one is a line here. */
{
  const TS_COLS = ['requested_at', 'occurred_at', 'captured_at', 'started_at',
    'ended_at', 'polled_at', 'created_at'];
  /* The diagnostic samplers are the deliberate exception and are named, not
     filtered by a loose pattern. /api/schema/raw-fields and raw-values pick a
     random sample of raw JSON out of a table to report which provider fields
     arrive filled; the four hours at each edge of that sample change no figure
     a reader compares against another figure, and there is no local_day on
     half the tables they read. Named here so the exemption is a decision
     somebody made rather than a gap in a regex. */
  const EXEMPT = /raw-fields|raw-values/;
  const offenders = [];
  for (const f of readdirSync('api').filter((x) => x.endsWith('.js'))) {
    const code = readFileSync(`api/${f}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const col of TS_COLS) {
      const re = new RegExp(`\\b${col}\\s+BETWEEN\\s+\\$\\d+\\s+AND\\s+\\$\\d+`, 'g');
      for (const m of code.match(re) || []) {
        /* Read the surrounding statement so a named exemption can be seen. */
        const at = code.indexOf(m);
        const around = code.slice(Math.max(0, at - 1200), at + 200);
        if (!EXEMPT.test(around)) offenders.push(`${f}: ${m}`);
      }
    }
  }
  check('no read route bounds a raw timestamp on the UTC day instead of the Dubai one',
    offenders.length === 0, offenders.join(' | '));
}

/* ── a phone column must not print two shapes of the same thing ──────────
   The href was always normalised through dialable(); the LINK TEXT was the raw
   roster column, and the roster does not store one shape. On production
   2026-09-10 the cancellations table printed +971551667768 and 971561881739 in
   adjacent rows. Both dial. But an operator reading down a column where some
   numbers carry a country-code marker and some do not has to stop and check
   whether the bare ones are incomplete, which is the whole cost of it. */
{
  const surfaces = ['cancellations.js', 'onlinetime.js', 'people.js', 'driver.js'];
  const raw = [];
  for (const f of surfaces) {
    const code = readFileSync(`api/public/${f}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* A tel: link whose text is the bare column rather than the same
       dialable() the href is built from. */
    if (/href="tel:\$\{esc\(dialable\([^)]*\)\)\}">\$\{esc\((?!dialable)/.test(code)) raw.push(f);
  }
  check('every surface that prints a phone prints the number it dials',
    raw.length === 0, raw.join(' '));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
