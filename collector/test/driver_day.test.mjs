/* ── the derived per-day record, kept ──────────────────────────────────────
   Everything the collector fetches is stored, so nothing raw is lost. What was
   not kept is the DERIVED per-day picture — how long somebody was on a job,
   how long they waited, how much of that waiting they were online for. It was
   computed from raw on every page load.

   Three reasons that is not good enough, and each is a test here: the
   providers forget (Uber serves 31 days of availability); a derivation that
   lives only in a query changes the past when the query changes; and the
   arithmetic has to agree with what /api/driver/shift already draws.

   The gap arithmetic is the part worth testing hardest. It looks sequential
   and is not: the waiting before a job is its start minus the furthest any
   EARLIER job ran to — a running max, not the previous row. Overlapping jobs
   are real on this fleet, and "previous row" gets them wrong. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { refreshDriverDays } from '../src/rollup.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

let n = 0;
/* Dubai times in, so the day key is unambiguous. */
const trip = (from, to, extra = {}) => q(
  `INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
                     requested_at, ended_at, status, distance_km, price, currency)
   VALUES ('uber','ecosine',$1,'d1','D One','L1',$2::timestamptz,$3,'completed',$4,$5,'AED')`,
  [`t${++n}`, from, to, extra.km ?? 10, extra.price ?? null]);

/* 09:00–09:30, then 11:00–11:20. One gap of 90 minutes. */
await trip('2026-08-25T09:00:00+04', '2026-08-25T09:30:00+04');
await trip('2026-08-25T11:00:00+04', '2026-08-25T11:20:00+04');
/* An OVERLAP: starts before the previous one ended. Real on this fleet — the
   next rider is assigned before the current is dropped. */
await trip('2026-08-25T11:10:00+04', '2026-08-25T12:00:00+04');
/* And a job with no dropoff, which cannot close a gap. */
await q(`INSERT INTO trip (platform, fleet_id, external_id, driver_ext_id, driver_name, plate,
           requested_at, status, distance_km, currency)
         VALUES ('uber','ecosine','t-open','d1','D One','L1','2026-08-25T14:00:00+04','completed',5,'AED')`);

/* Availability: online 08:30 → 20:00 Dubai. */
const ev = (at, status) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber','ecosine','d1',$1::timestamptz,'status',$2,'')`, [at, status]);
await ev('2026-08-25T08:30:00+04', 'ONLINE');
await ev('2026-08-25T20:00:00+04', 'OFFLINE');

await refreshDriverDays(db);
const [row] = await q(`SELECT * FROM driver_day WHERE driver_ext_id = 'd1' AND day = '2026-08-25'`);

check('a day lands as one row', !!row, JSON.stringify(row));
check('with the trips and the distance on it',
  row.trips === 4 && Number(row.km) === 35, `${row.trips} trips, ${row.km} km`);
/* 30 + 20 + 50 = 100. The unclosed job contributes nothing. */
check('on-job is the sum of the jobs that ENDED',
  row.on_job_min === 100, String(row.on_job_min));
/* 09:30→11:00 is 90. The third job starts at 11:10 but the furthest anything
   ran to is 11:20, so there is no gap before it — and with "previous row"
   instead of a running max it would have counted a negative one. */
check('waiting is measured from the furthest any earlier job ran to, not from the previous row',
  row.wait_min === 90 && row.longest_wait_min === 90,
  `wait ${row.wait_min}, longest ${row.longest_wait_min}`);
check('an overlapping job does not create negative waiting', row.wait_min >= 0);
check('a job with no dropoff is counted and cannot close a gap',
  row.unknown_end === 1, String(row.unknown_end));
check('the span runs from the first request to the last known dropoff',
  row.first_min === 9 * 60 && row.last_min === 12 * 60 && row.span_min === 180,
  `${row.first_min}..${row.last_min} = ${row.span_min}`);
/* 08:30 → 20:00 is 690 minutes; idle is that less the 100 on a job. */
check('online is the availability span clipped to the Dubai day',
  row.online_min === 690, String(row.online_min));
check('and idle-online is what a job did not cover',
  row.idle_online_min === 590, String(row.idle_online_min));

/* ── the distinction the whole table exists for ──────────────────────────── */
await trip('2026-08-26T09:00:00+04', '2026-08-26T09:30:00+04');
await refreshDriverDays(db);
const [d26] = await q(`SELECT * FROM driver_day WHERE driver_ext_id='d1' AND day='2026-08-26'`);
check('a day nobody collected availability for is NULL, not zero — that is not '
  + 'a driver who was offline',
  d26.online_min === null && d26.idle_online_min === null, JSON.stringify(d26.online_min));

/* ── idempotent ──────────────────────────────────────────────────────────── */
const before = await q('SELECT count(*)::int c FROM driver_day');
await refreshDriverDays(db);
const after = await q('SELECT count(*)::int c FROM driver_day');
const [again] = await q(`SELECT * FROM driver_day WHERE driver_ext_id='d1' AND day='2026-08-25'`);
check('recomputing changes no counts', before[0].c === after[0].c, `${before[0].c} → ${after[0].c}`);
check('and lands the same figures on the same row',
  again.on_job_min === row.on_job_min && again.wait_min === row.wait_min
  && again.online_min === row.online_min, JSON.stringify(again));

/* ── incremental ─────────────────────────────────────────────────────────── */
await q(`UPDATE driver_day SET trips = 999 WHERE day = '2026-08-25'`);
await refreshDriverDays(db, { since: '2026-08-26' });
const [stale] = await q(`SELECT trips FROM driver_day WHERE day='2026-08-25'`);
check('a windowed refresh leaves days outside the window alone',
  stale.trips === 999, String(stale.trips));
await refreshDriverDays(db);
const [fixed] = await q(`SELECT trips FROM driver_day WHERE day='2026-08-25'`);
check('and a full refresh puts them right', fixed.trips === 4, String(fixed.trips));

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
