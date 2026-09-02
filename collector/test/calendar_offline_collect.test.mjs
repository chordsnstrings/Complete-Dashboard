/* The whole external run, with api.aladhan.com doing exactly what it does on
   production: never answering.
   ─────────────────────────────────────────────────────────────────────────
   MEASURED, /api/status, 2026-09-02:

     external  incremental  partial  rows_written 37
       hijri 2026-08: TypeError: fetch failed (ETIMEDOUT) …/gToHCalendar/8/2026
       hijri 2026-09: TypeError: fetch failed (ETIMEDOUT) …/gToHCalendar/9/2026
       calendar 2026-08-30..2026-09-02: asked for 2 month(s) and wrote no day

   37 is past_days 30 + forecast_days 7 — the weather, all of it, from
   api.open-meteo.com, in the same function, in the same run, in the same
   seconds. So this is not the container losing the internet: one host is
   unreachable and the other is not, and the Hijri half of calendar_day has
   been NULL since 2026-08-31 as a result.

   This test freezes that world. open-meteo answers; api.aladhan.com rejects
   with the exact error undici raises for a connection that never comes up —
   `TypeError: fetch failed` with cause.code ETIMEDOUT — and the run is
   required to fill every day of its window anyway.

   It fails on the version that fetched the Hijri date. The failure is quoted
   in the report; it is the production string, verbatim:
     "calendar 2026-07-30..2026-08-02: asked for 2 month(s) and wrote no day"

   The window is deliberately in the past and deliberately spans two Gregorian
   months, so the test reproduces that message without depending on today. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
/* upsertMany writes through pool.connect(), not pool.query, so both have to
   point at the throwaway database or the collector reaches for the real one. */
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});

const FROM = '2026-07-30', TO = '2026-08-02';
const DAYS = ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02'];

/* api.open-meteo.com answers, api.aladhan.com does not. http.js calls the
   global fetch by name at call time, so replacing it here is enough — no
   argument has to be threaded through the collector to make it testable. */
let aladhanAttempts = 0;
const jsonRes = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('api.aladhan.com')) {
    aladhanAttempts++;
    // undici's shape for a connection that never came up. Not an AbortError:
    // measured on this Node, our own AbortController produces
    // "AbortError: This operation was aborted" with no cause, which is how we
    // know production's ETIMEDOUT is not our timeout firing.
    const e = new TypeError('fetch failed');
    e.cause = Object.assign(new Error('connect ETIMEDOUT 104.21.0.1:443'), { code: 'ETIMEDOUT' });
    throw e;
  }
  if (u.includes('api.open-meteo.com') && u.includes('sunrise')) {
    return jsonRes({ daily: { time: DAYS, sunrise: DAYS.map(() => '2026-07-30T05:43'), sunset: DAYS.map(() => '2026-07-30T19:07') } });
  }
  if (u.includes('api.open-meteo.com')) {
    return jsonRes({ daily: { time: DAYS, temperature_2m_max: [44, 44, 43, 43], temperature_2m_min: [33, 33, 33, 33],
      precipitation_sum: [0, 0, 0, 0], wind_speed_10m_max: [18, 19, 17, 18] } });
  }
  throw new Error(`unexpected host in test: ${u}`);
};

const { collect } = await import('../src/sources/external.js');

console.log('\nthe calendar fills while the provider is unreachable');

await collect({ mode: 'incremental', from: FROM, to: TO });

const cal = await q('SELECT * FROM calendar_day ORDER BY day');
check(`every day of ${FROM}..${TO} got a row (${cal.length}/4)`, cal.length === 4, String(cal.length));
check('…and every one of them carries a Hijri month, not NULL',
  cal.length === 4 && cal.every((r) => r.hijri_month && r.hijri_date),
  JSON.stringify(cal.map((r) => [String(r.day).slice(0, 10), r.hijri_month])));
check('…matching what Aladhan itself returned for those days',
  cal[2] && cal[2].hijri_date === '18-02-1448' && cal[2].hijri_month === 'Ṣafar',
  JSON.stringify(cal[2] && [String(cal[2].day).slice(0, 10), cal[2].hijri_date, cal[2].hijri_month]));
check('…and the sunrise/sunset the reachable provider did answer with',
  cal.every((r) => r.sunrise && r.sunset));

const run = (await q("SELECT * FROM collection_run WHERE source = 'external' ORDER BY id DESC LIMIT 1"))[0];
check('the run reports ok: nothing it was asked for is missing',
  run && run.status === 'ok', run && `${run.status} — ${run.error}`);
check('…and it no longer reports "asked for N month(s) and wrote no day"',
  !/wrote no day/.test(run?.error || ''), run?.error);
check('rows_written counts the calendar as well as the weather',
  run && run.rows_written === 8, String(run && run.rows_written));

/* The provider is still asked — once, so a computed calendar cannot drift
   from it unnoticed — but the old shape asked once per month of window with
   retries:2, which is 3 connection attempts per month and 75 on the 25-month
   backfill, every one of them having to time out before the run could move on. */
check('the unreachable host is attempted once, not once per month with retries',
  aladhanAttempts === 1, `${aladhanAttempts} attempts`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
