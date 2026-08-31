/* The driver page reconciling with itself.
   ─────────────────────────────────────────────────────────────────────────
   The operator's report was "this has data but it's not reconciling", and the
   page proved them right in four separate ways at once. Each of them is a
   check here, because each is a class of mistake rather than a typo:

     the window     /api/driver/* bound requested_at as a raw timestamptz in a
                    UTC session, so a window opening on the 1st began at 04:00
                    Dubai. The panels beside it — the directory, driver_day,
                    the fleet totals — all key on the Dubai calendar day, so
                    the detail page reported 283 trips for a month the record
                    said was 285, and 4 on a day the trip list said was 6.

     the source     the hours panel asked driver_performance for a per-day
                    figure. Exactly one collector writes that column and it
                    files SEVEN-day windows, which the query's own
                    `period_start = period_end` then discards — so the panel
                    said "no platform-reported hours" directly under a
                    timeline drawing 405 of them from a feed nobody asked.

     the arithmetic utilisation was hours_on_trip / hours_online, and nothing
                    writes hours_on_trip. In JavaScript null/428.8 is 0, so the
                    tile printed a confident critical 0% — an invented number
                    accusing a named person of never carrying a passenger.

     the identity   driver_statement_day's own key is the driver NAME; its
                    driver_ext_id is nullable and mostly null. Joined on the id
                    alone, the tips figure matched nothing on any driver while
                    the same statements reconciled fine on the money pages.

   Two of the four are one-line predicates, which is exactly why they need a
   test: nothing about them looks wrong in review, and the page keeps rendering. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { driverRoutes } from '../api/driver_routes.js';
import { refreshDriverDays } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

const ID = 'u-sel', NAME = 'Mohammed Selim';
/* Dubai times in, so nothing here depends on the reader's clock — and one of
   them is 01:00 on the window's first day, which is the whole point. */
const trip = (ext, atLocal, endLocal, extra = {}) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,driver_name,
                     requested_at,ended_at,distance_km,status,price)
   VALUES ('uber',$1,'ecosine','L46174',$2,$3,$4,$5,$6,$7,$8)`,
  [ext, ID, NAME, atLocal, endLocal, extra.km ?? 8, extra.status ?? 'completed', extra.price ?? null]);

// 2026-08-01: two trips in the first four Dubai hours, four in the afternoon.
await trip('t1', '2026-08-01T01:10:00+04:00', '2026-08-01T01:40:00+04:00');
await trip('t2', '2026-08-01T03:20:00+04:00', '2026-08-01T03:55:00+04:00');
for (let i = 0; i < 4; i++) {
  await trip(`t3${i}`, `2026-08-01T1${i}:00:00+04:00`, `2026-08-01T1${i}:30:00+04:00`);
}
// 2026-08-02: four ordinary trips, one of which has a dropoff BEFORE its own
// request — a bad timestamp the shift fold used to run to a 24-hour job.
for (let i = 0; i < 3; i++) {
  await trip(`t4${i}`, `2026-08-02T0${8 + i}:00:00+04:00`, `2026-08-02T0${8 + i}:35:00+04:00`);
}
await trip('t-bad', '2026-08-02T15:00:00+04:00', '2026-08-02T14:20:00+04:00');

/* Availability: ONLINE spans, the feed the hours actually come from. */
const ev = (at, status) => q(
  `INSERT INTO driver_timeline_event (platform,fleet_id,driver_ext_id,kind,status,at)
   VALUES ('uber','ecosine',$1,'status',$2,$3)`, [ID, status, at]);
await ev('2026-08-01T00:30:00+04:00', 'ONLINE');
await ev('2026-08-01T14:30:00+04:00', 'OFFLINE');
await ev('2026-08-02T07:00:00+04:00', 'ONLINE');
await ev('2026-08-02T17:00:00+04:00', 'OFFLINE');
/* And a day online with no job at all, no statement and no payout — the shape
   of day driver_day used to drop entirely. */
await ev('2026-08-03T18:00:00+04:00', 'ONLINE');
await ev('2026-08-03T22:00:00+04:00', 'OFFLINE');

/* The statement, filed under the NAME with no platform id — which is how this
   table actually arrives (sql/schema_v25.sql:25). */
/* Two grains on purpose. Uber files this fleet WEEKLY and src/rollup.js
   divides each statement across its seven days, so most days on the real page
   carry a seventh of one number — identical values seven in a row, which reads
   as seven measurements unless the window travels with the money. One day here
   is filed daily and one is a share of a week, so both render paths are
   exercised. */
for (const [day, net, tips, cash, periodDays] of [
  ['2026-08-01', 420, 30, 110, 7], ['2026-08-02', 380, 12, 90, 1]]) {
  await q(`INSERT INTO driver_statement_day (platform,fleet_id,driver_name,day,gross,fees,net,tips,cash,trips,period_days,source)
           VALUES ('uber','ecosine',$1,$2,$3,-40,$4,$5,$6,4,$7,'statement')`,
    [NAME, day, net + 40, net, tips, cash, periodDays]);
}

await refreshDriverDays(db);

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const endOfDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d);
driverRoutes(app, { q, wrap, endOfDay });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();
const W = 'from=2026-08-01&to=2026-08-03';

console.log('\nthe window is a Dubai calendar day, on every panel');

const daily = await get(`/api/driver/daily?id=${ID}&${W}`);
const d1 = daily.find((r) => String(r.day).startsWith('2026-08-01'));
check('the first four Dubai hours of the window are inside it',
  d1?.trips === 6, `day one has ${d1?.trips} trips, not 6`);

const kpis = await get(`/api/driver/kpis?id=${ID}&${W}`);
const days = await get(`/api/driver/days?id=${ID}&${W}`);
check('…so the detail page and the stored per-day record agree on the total',
  kpis.trips === days.totals.trips, `${kpis.trips} vs ${days.totals.trips}`);
check('…and so does the day-by-day spine',
  daily.reduce((a, r) => a + r.trips, 0) === kpis.trips);
/* A one-day window and ?day= must be the same window. They were not: one went
   through the raw-timestamp predicate and one through a Dubai-day cast. */
const oneDay = await get(`/api/driver/kpis?id=${ID}&from=2026-08-01&to=2026-08-01`);
const byDay = await get(`/api/driver/kpis?id=${ID}&day=2026-08-01`);
check('a one-day window and a named day are the same window',
  oneDay.trips === 6 && byDay.trips === 6, `${oneDay.trips} / ${byDay.trips}`);

console.log('\nhours come from the feed that has them, and say so');

check('the platform publishes no daily hours here, and the panel is not empty',
  d1?.hours_online > 0, String(d1?.hours_online));
check('…and the row names which feed answered',
  d1?.hours_online_basis === 'availability', String(d1?.hours_online_basis));
check('the fourteen-hour ONLINE span is the figure, clipped to the Dubai day',
  Math.round(d1.hours_online) === 14, String(d1.hours_online));
check('on-job is carried as on_job, never as "on trip"',
  d1.hours_on_job != null && !('hours_on_trip' in d1),
  'request-to-dropoff contains the approach; no feed here separates the ride out of it');
check('the tile reads the same feed as the chart',
  Math.round(kpis.hours_online) === Math.round(daily.reduce((a, r) => a + (+r.hours_online || 0), 0)),
  `${kpis.hours_online} vs ${daily.reduce((a, r) => a + (+r.hours_online || 0), 0)}`);
check('and reports how many days of the window carry availability',
  kpis.hours_days === 3 && kpis.hours_basis === 'availability',
  `${kpis.hours_days} days, basis ${kpis.hours_basis}`);

console.log('\na ratio needs both of its halves measured');

check('utilisation is a number here, because both halves exist',
  kpis.utilisation_pct > 0 && kpis.utilisation_pct < 100, String(kpis.utilisation_pct));
/* The trap itself: null/n is 0 in JavaScript, not NaN and not null, so a guard
   on the denominator alone lets a fabricated 0% through. */
check('…and null on-job time gives null, never a confident zero',
  (() => {
    const online = 428.8, onJob = null;
    const guarded = online && onJob != null ? +((onJob / online) * 100).toFixed(1) : null;
    return guarded === null && (onJob / online) * 100 === 0;
  })(),
  'null / n is 0 in JS — the guard has to test the numerator too');
{
  const src = readFileSync('api/driver_routes.js', 'utf8');
  check('the endpoint guards the numerator as well as the denominator',
    /hoursOnline && hoursOnJob != null/.test(src));
  /* Comments stripped first: the note explaining this bug quotes the predicate
     verbatim, and a check that matches its own explanation is a check that can
     never pass. test/credmodel.test.mjs learned the same lesson. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('and no driver query bounds the window as a raw timestamp any more',
    !/requested_at BETWEEN \$1 AND \$2/.test(code),
    'a bare timestamptz bound drops the first four Dubai hours of the window');
}

console.log('\nmoney reaches the day from whichever feed measured it');

check('the statement lands on the day even though it carries no platform id',
  d1?.money > 0, `driver_statement_day keys on the NAME — ${d1?.money}`);
check('…and the day says which feed it came from', d1?.money_source === 'statement', String(d1?.money_source));
/* The grain, which is the difference between a measurement and a share of one.
   These fixture statements are filed per day, so period_days is 1 — but the
   column has to travel, because Uber files this fleet WEEKLY and a seventh of
   a week shown in a daily cell is a number nobody took. Production made the
   point within an hour of the Money column shipping: 309.88 for seven
   consecutive days, then 446.84 for the next seven. */
check('the money carries the report window it was measured over',
  d1?.money_period_days === 7, String(d1?.money_period_days));
check('…and a day the channel actually filed says one',
  daily.find((r) => String(r.day).startsWith('2026-08-02'))?.money_period_days === 1);
{
  const src = readFileSync('api/public/driver.js', 'utf8');
  check('and the cell marks an allocated figure rather than printing it plain',
    /const n = r\.money_period_days;/.test(src) && /divided across its days/.test(src)
    && /n == null \? 'grain\?'/.test(src),
    'a weekly total in a daily cell is indistinguishable from seven measurements, '
    + 'and an unrecorded window is neither measured nor spread');
}
const earn = await get(`/api/driver/earnings?id=${ID}&${W}`);
check('tips reach the earnings tab through the same name match',
  Number(earn.tips) === 42, String(earn.tips));
check('and the cash the driver already holds is reported, not denied',
  Number(earn.statement_cash) === 200, String(earn.statement_cash));

console.log('\na bad dropoff is a bad timestamp, not a day-long job');

const shift = await get(`/api/driver/shift?id=${ID}&${W}`);
const s2 = shift.days.find((r) => String(r.day).startsWith('2026-08-02'));
const kept2 = days.days.find((r) => String(r.day).startsWith('2026-08-02'));
check('the live fold and the stored record agree on on-job minutes',
  Math.abs(s2.on_job_min - kept2.on_job_min) <= 1, `${s2?.on_job_min} vs ${kept2?.on_job_min}`);
check('…because neither runs a backwards same-day end to midnight',
  s2.on_job_min < 240, `${s2?.on_job_min} minutes — one bad row would add 1440`);

console.log('\na day that only availability knows about is still a day');

const d3 = days.days.find((r) => String(r.day).startsWith('2026-08-03'));
check('online with no job, no statement and no payout gets a row',
  !!d3 && d3.trips === 0 && d3.online_min > 0, JSON.stringify(d3 || null));
check('…and it carries the fleet the account belongs to',
  d3?.fleet_id === 'ecosine', String(d3?.fleet_id));
{
  const [row] = await q(`SELECT person_key FROM driver_day WHERE day = '2026-08-03'`);
  check('…and the same person key as the days that had trips',
    row?.person_key === 'mohammed selim',
    `${row?.person_key} — falling back to the raw id would split one human in two`);
}

/* Last, deliberately: these two rows are inserted AFTER the driver_day
   comparison above, because that check is between a live fold and a stored
   record and adding trips without re-running the rollup would make them
   disagree for a reason that is not the one under test. */
console.log('\nthe same two data-quality rules as everything else');

/* A complimentary ride and an odometer-derived distance of 12,000 km are both
   real rows and neither is a measurement of what the tile claims. trip_norm
   marks them (sql/schema_v18.sql:83,88) and src/rollup.js applies both when it
   writes driver_day — the driver page's own km and revenue did not, so the
   page disagreed with the record beside it and with the settlement page. */
await trip('t-foc', '2026-08-02T20:00:00+04:00', '2026-08-02T20:20:00+04:00', { price: 90 });
await q(`UPDATE trip SET payment_type = 'foc-complimentary' WHERE external_id = 't-foc'`);
await trip('t-odo', '2026-08-02T21:00:00+04:00', '2026-08-02T21:10:00+04:00', { km: 12000 });
{
  const k2 = await get(`/api/driver/kpis?id=${ID}&${W}`);
  const dd = await get(`/api/driver/daily?id=${ID}&${W}`);
  const d2 = dd.find((r) => String(r.day).startsWith('2026-08-02'));
  check('a complimentary ride is not revenue',
    !(+k2.revenue > 0) && !(+d2.revenue > 0), `${k2.revenue} / ${d2.revenue}`);
  check('…and an implausible odometer reading is not distance',
    +k2.km < 500 && +d2.km < 500, `${k2.km} / ${d2.km}`);
  check('…but both trips are still counted as trips, because they happened',
    k2.trips === 12, String(k2.trips));
}


console.log('\none money column the whole roster can be ranked by');

/* The two money columns beside it each answer for about half the roster, and
   not the same half: on production, 44 of 119 active drivers have a fare and
   96 have a payout. A reader sorting by money was comparing what a rider paid
   for one person against what the platform paid us for the next. */
{
  const dir = await get(`/api/drivers/directory?${W}`);
  const me = dir.find((r) => (r.ids || []).includes(ID) || r.driver_ext_id === ID);
  check('the roster carries a money figure for a driver with no fare at all',
    me && me.revenue == null && me.money > 0, JSON.stringify(me && { revenue: me.revenue, money: me.money }));
  check('…and states the coarsest window behind it, not the finest',
    me?.money_period_days === 7,
    'one day here is a seventh of a week and one was filed daily; the week is what limits the claim');
  const withMoney = dir.filter((r) => r.money != null);
  const withFare = dir.filter((r) => r.revenue != null);
  check('…so it answers for at least as many people as the fares column',
    withMoney.length >= withFare.length, `${withMoney.length} vs ${withFare.length}`);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
