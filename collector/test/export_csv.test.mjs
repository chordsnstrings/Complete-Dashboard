/* ── every figure could be read and none of it could be taken anywhere ─────
   The product had no export: no CSV, no download, no Content-Disposition
   anywhere in the API or the UI. An operator who wanted last month's trips in
   a spreadsheet read them off a screen and retyped them.

   Two grains, because "daily trip data" means different things to different
   people, and BOTH carry the fleet on every row — one file covers both
   organisations rather than needing two stitched together.

   The rule these tests exist for: no silent cap. A truncated export is worse
   than a refused one, because a spreadsheet quietly missing its last ten
   thousand rows reads as complete. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { exportRoutes } from '../api/export_routes.js';
import { winDays } from '../api/window.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

let n = 0;
const trip = (fleet, platform, at, extra = {}) => q(
  `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                     requested_at, ended_at, status, distance_km, price, currency,
                     product, payment_type, pickup_addr, dropoff_addr)
   VALUES ($1,$2,$3,$4,$5,$6,$7::timestamptz,$7::timestamptz + interval '18 min',
           $8,$9,$10,'AED',$11,$12,$13,$14)`,
  [platform, fleet, `x${++n}`, `d-${fleet}`, `Driver ${fleet}`, `L${100 + n}`, at,
    extra.status || 'completed', extra.km ?? 12.5, extra.price ?? null,
    extra.product || 'UberX', extra.payment || 'app',
    extra.pickup || 'A, Dubai', extra.dropoff || 'B, Dubai']);

/* Both organisations, same day, so one file must carry both. */
await trip('ecosine', 'uber', '2026-08-25T09:00:00+04');
await trip('ecosine', 'uber', '2026-08-25T11:00:00+04');
await trip('egari', 'uber', '2026-08-25T10:00:00+04');
await trip('egari', 'hotel', '2026-08-25T12:00:00+04', { price: 88.5 });
/* A Dubai evening: 23:30 Dubai is still the 25th, and 00:30 is the 26th. The
   export keys on local_day for exactly this reason. */
await trip('ecosine', 'uber', '2026-08-25T23:30:00+04');
await trip('ecosine', 'uber', '2026-08-26T00:30:00+04');
/* An FMS row — a telematics twin of a booking another channel already
   reported. Counting it would double the fleet. */
await trip('ecosine', 'fms', '2026-08-25T09:05:00+04');

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
exportRoutes(app, { q, wrap, winDays });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, type: r.headers.get('content-type'),
    disp: r.headers.get('content-disposition'), rows: r.headers.get('x-export-rows'),
    window: r.headers.get('x-export-window'), body: await r.text() };
};
const parse = (csv) => csv.trim().split('\n').map((l) => l.split(','));

/* ── the daily grain ────────────────────────────────────────────────────── */
const W = 'from=2026-08-25&to=2026-08-26';
const day = await get(`/api/export/trips.csv?${W}`);
check('it answers as a CSV file, not as JSON in a browser tab',
  day.status === 200 && /text\/csv/.test(day.type || ''), `${day.status} ${day.type}`);
check('and as an attachment with a name that says what it is',
  /attachment/.test(day.disp || '') && /trips-day-2026-08-25-to-2026-08-26\.csv/.test(day.disp || ''),
  day.disp);
const dRows = parse(day.body);
check('the header names the columns', dRows[0].join(',').startsWith('day,fleet,channel,bookings'),
  dRows[0].join(','));
/* The whole question: one file, both organisations. */
const fleets = new Set(dRows.slice(1).map((r) => r[1]));
check('one file carries BOTH organisations',
  fleets.has('ecosine') && fleets.has('egari'), [...fleets].join());
const eco25 = dRows.slice(1).find((r) => r[0] === '2026-08-25' && r[1] === 'ecosine' && r[2] === 'uber');
check('a Dubai evening stays on its own day',
  eco25 && eco25[3] === '3', JSON.stringify(eco25));
const eco26 = dRows.slice(1).find((r) => r[0] === '2026-08-26' && r[1] === 'ecosine');
check('and just past midnight starts the next one', eco26 && eco26[3] === '1', JSON.stringify(eco26));
check('the telematics twin is not counted as a booking',
  !dRows.slice(1).some((r) => r[2] === 'fms'), dRows.slice(1).map((r) => r[2]).join());
check('the row count travels in a header so a saved file can say what it holds',
  Number(day.rows) === dRows.length - 1 && day.window === '2026-08-25..2026-08-26',
  `${day.rows} ${day.window}`);

/* ── the trip grain ─────────────────────────────────────────────────────── */
const trips = await get(`/api/export/trips.csv?${W}&grain=trip`);
const tRows = parse(trips.body);
check('the trip grain gives one row per booking', tRows.length - 1 === 6, String(tRows.length - 1));
check('and names the fleet on every one of them',
  tRows.slice(1).every((r) => r[1] === 'ecosine' || r[1] === 'egari'));
check('with the trip id, so a row can be opened in the product',
  tRows[0][3] === 'trip_id' && tRows.slice(1).every((r) => r[3]));

/* ── filters ────────────────────────────────────────────────────────────── */
const one = parse((await get(`/api/export/trips.csv?${W}&fleet=egari`)).body);
check('a fleet filter narrows it to that organisation',
  one.slice(1).every((r) => r[1] === 'egari') && one.length > 1, one.map((r) => r[1]).join());
const chan = parse((await get(`/api/export/trips.csv?${W}&platform=hotel`)).body);
check('and a channel filter to that channel',
  chan.slice(1).every((r) => r[2] === 'hotel') && chan.length === 2);

/* ── the things a CSV gets wrong ────────────────────────────────────────── */
await trip('ecosine', 'uber', '2026-08-25T14:00:00+04',
  { pickup: 'Al Barsha, "The Views", Dubai', dropoff: 'B\nnewline' });
const quoted = (await get(`/api/export/trips.csv?${W}&grain=trip`)).body;
check('a comma inside a field does not become a new column',
  quoted.includes('"Al Barsha, ""The Views"", Dubai"'), 'RFC 4180 quoting');
check('a newline inside a field is quoted rather than breaking the row',
  /"B\nnewline"/.test(quoted));
check('the file ends with a newline, which some readers need to see the last row',
  quoted.endsWith('\n'));

/* ── an empty window is a file, not a failure ───────────────────────────── */
const none = await get('/api/export/trips.csv?from=2025-01-01&to=2025-01-02');
const nRows = parse(none.body);
check('a window with no bookings still downloads its header',
  none.status === 200 && nRows.length === 1 && nRows[0][0] === 'day', JSON.stringify(nRows));

/* ── and the rule this endpoint exists to keep ──────────────────────────── */
/* A truncated export reads as complete, so over the limit it refuses and says
   what would fit rather than handing back a plausible lie. */
const src = (await import('node:fs')).readFileSync('api/export_routes.js', 'utf8');
/* A SQL LIMIT clause, not the English word — the refusal message below
   legitimately says "row limit", and a check that cannot tell the two apart
   is a check that fails for the wrong reason. */
check('there is no SQL LIMIT in the query — nothing is silently dropped',
  !/\bLIMIT\s+(\d+|\$\d)/i.test(src), 'a silent LIMIT is exactly what this must not do');
/* The refusal, EXERCISED rather than grepped for.
   ─────────────────────────────────────────────────────────────────────────
   This used to be a regex over the source asserting that `status(413)` and the
   words "Narrow the range" appear in the file. Both did, and the number the
   message carried was wrong: it scaled the requested day count by the row
   ratio, so a 1,200-day request over an 863-day record answered "about 1,007
   days would fit" — a window holding every one of the rows it had just
   refused. A check that reads the words cannot see that. This one mounts the
   same route with a cap of 3 and reads the answer. */
const tiny = express();
exportRoutes(tiny, { q, wrap, winDays, maxRows: 3 });
const tinySrv = tiny.listen(0);
const tinyGet = async (path) => {
  const r = await fetch(`http://127.0.0.1:${tinySrv.address().port}${path}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const over = await tinyGet(`/api/export/trips.csv?${W}&grain=trip`);
check('over the cap it refuses rather than truncating',
  over.status === 413 && over.body?.error === 'too many rows for one file',
  `${over.status} ${JSON.stringify(over.body)}`);
check('and says how many rows there actually are',
  over.body?.rows === 7 && over.body?.limit === 3, JSON.stringify(over.body));

/* 2026-08-26 holds 1 booking, 2026-08-25 holds 6. Walking back from the most
   recent day, the 26th fits (1 ≤ 3) and adding the 25th would not (7 > 3), so
   the only window that fits is the 26th alone. An extrapolation would have
   said "about 1 day", landing on the same date by luck; the walk-back says it
   because it counted. */
check('the window it suggests is one the data actually fits into',
  over.body?.fits_from === '2026-08-26' && over.body?.fits_to === '2026-08-26'
  && over.body?.fits_rows === 1, JSON.stringify(over.body));
/* And the suggestion is not advice — it is a request that works. */
const retry = await tinyGet(
  `/api/export/trips.csv?from=${over.body?.fits_from}&to=${over.body?.fits_to}&grain=trip`);
check('and following that suggestion succeeds instead of refusing again',
  retry.status === 200, String(retry.status));

/* A window that extends far past the record must not be answered with a day
   count longer than the record — the exact bug this replaced. */
const wide = await tinyGet('/api/export/trips.csv?from=2020-01-01&to=2026-08-26&grain=trip');
check('a window wider than the record still suggests a date inside it',
  wide.status === 413 && wide.body?.fits_from === '2026-08-26',
  JSON.stringify(wide.body));

/* One day over the cap on its own has no narrower window to offer, and must
   say so rather than naming a date that would refuse again. */
const noneFit = express();
exportRoutes(noneFit, { q, wrap, winDays, maxRows: 1 });
const nfSrv = noneFit.listen(0);
const nf = await fetch(
  `http://127.0.0.1:${nfSrv.address().port}/api/export/trips.csv?from=2026-08-25&to=2026-08-25&grain=trip`)
  .then((r) => r.json());
check('a single day over the cap admits it has no window to offer',
  nf.fits_from === null && /Even one day/.test(nf.detail || ''), JSON.stringify(nf));
check('and still points at the two ways out that do work',
  /one fleet/.test(nf.detail || '') && /grain=day/.test(nf.detail || ''), nf.detail);
tinySrv.close(); nfSrv.close();

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
