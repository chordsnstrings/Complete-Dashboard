/* Month-over-month breaks must never be computed across a hole in the data.
   Production reported "2025-10 → 2026-02: -82%, drivers 102 → 0" as a business
   event. Nothing had happened — we simply held no rows for November, December
   or January, and the comparison stepped straight over them. A confident wrong
   number is worse than no number, so this pins the behaviour. */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* v6 and v7 are loaded because the route reads trip_norm, not trip: the cancel
   ratio it reports was computed with ILIKE '%cancel%', which matches none of
   Bolt's client_did_not_show, driver_did_not_respond or driver_rejected, and
   its denominator counted FMS telematics rows that hardcode 'completed' and
   cannot be cancelled at all. */
for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
                 'schema_v6.sql', 'schema_v7.sql'])
  await db.exec(readFileSync(`sql/${f}`, 'utf8'));

// Sep and Oct 2025 busy on Uber with named drivers; Nov–Jan absent entirely;
// Feb 2026 back but only from the telematics feed, which carries no driver id.
const mk = (platform, ext, day, drv) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,requested_at,distance_km,status,price)
   VALUES ($1,$2,'ecosine','L1',$3,$4,$5,10,'completed',40)`,
  [platform, ext, drv, drv ? 'Driver ' + drv : null, `${day}T10:00:00+04:00`]);

let n = 0;
for (let i = 1; i <= 20; i++) await mk('uber', `s${n++}`, `2025-09-${String(i).padStart(2, '0')}`, `d${i % 4}`);
for (let i = 1; i <= 10; i++) await mk('uber', `o${n++}`, `2025-10-${String(i).padStart(2, '0')}`, `d${i % 4}`);
for (let i = 1; i <= 9; i++) await mk('fms', `f${n++}`, `2026-02-${String(i).padStart(2, '0')}`, null);
for (let i = 1; i <= 20; i++) await mk('fms', `g${n++}`, `2026-03-${String(i).padStart(2, '0')}`, null);

/* ── mount just the trend route, using the real handler source ─────────────
   The route is defined inline in api/server.js against a live pool, so it is
   extracted here rather than imported. Keeping the SQL identical is the point;
   the test fails loudly if the two drift. */
const src = readFileSync('api/server.js', 'utf8');
const body = src.slice(src.indexOf("app.get('/api/trend/monthly'"), src.indexOf('// external context joined to the day'));
const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
// eslint-disable-next-line no-new-func
new Function('app', 'q', 'wrap', body)(app, q, wrap);
const server = app.listen(0);
const port = server.address().port;
const { months, breaks, gaps } = await (await fetch(`http://127.0.0.1:${port}/api/trend/monthly`)).json();

/* ── the calendar is filled, so a hole looks like a hole ─────────────────── */
check('every month between first and last is present', months.length === 7, String(months.length));
check('months are labelled YYYY-MM', months[0].m === '2025-09', months[0]?.m);
const nov = months.find((m) => m.m === '2025-11');
check('a month with no rows is flagged no_data', nov?.no_data === true, JSON.stringify(nov));
check('a month with no rows reports null drivers, not zero', nov?.drivers === null, String(nov?.drivers));
check('an observed month is not flagged no_data', months.find((m) => m.m === '2025-09')?.no_data === false);

/* ── gaps are reported as runs ───────────────────────────────────────────── */
check('the three-month hole is reported as one gap', gaps.length === 1, JSON.stringify(gaps));
check('the gap spans Nov to Jan', gaps[0]?.from === '2025-11' && gaps[0]?.to === '2026-01', JSON.stringify(gaps[0]));
check('the gap length is counted', gaps[0]?.months === 3, String(gaps[0]?.months));

/* ── breaks never step over the hole ─────────────────────────────────────── */
check('no break is reported across the gap',
  !breaks.some((b) => b.from === '2025-10' && b.to === '2026-02'), JSON.stringify(breaks));
check('every break joins two adjacent observed months',
  breaks.every((b) => {
    const ia = months.findIndex((m) => m.m === b.from), ib = months.findIndex((m) => m.m === b.to);
    return ib === ia + 1 && !months[ia].no_data && !months[ib].no_data;
  }), JSON.stringify(breaks));
// Sep 20 → Oct 10 is -50%, and both months were observed, so it is real.
const real = breaks.find((b) => b.from === '2025-09');
check('a genuine month-over-month swing is still reported', real?.change_pct === -50, JSON.stringify(real));

/* ── "0 drivers" on a telematics-only month means unattributable ─────────── */
const feb = months.find((m) => m.m === '2026-02');
check('a telematics-only month has trips', feb?.trips === 9, String(feb?.trips));
check('a telematics-only month is marked as having no driver attribution',
  feb?.drivers_known === false, String(feb?.drivers_known));
const febBreak = breaks.find((b) => b.to === '2026-03');
check('a break with no attribution reports null drivers rather than zero',
  febBreak && febBreak.drivers_from === null && febBreak.drivers_to === null, JSON.stringify(febBreak));
check('a break where the platform mix changed says so',
  breaks.every((b) => b.platform_shift === null || (b.platform_shift.from && b.platform_shift.to)),
  JSON.stringify(breaks.map((b) => b.platform_shift)));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
