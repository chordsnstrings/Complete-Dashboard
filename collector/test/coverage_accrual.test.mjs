/* ── the record does not run into next week ────────────────────────────────
   driver_payout_day expands a payout period across period_start..period_end,
   and weekChunks runs an OPEN week to the following Sunday, so this table
   legitimately holds rows for days that have not arrived. /api/coverage's
   inventory took max(day) with no bound, and read off production on
   2026-09-02:

     earnings · uber   rows 49,395   from 2026-02-06   to 2026-09-06   days 213

   — four days that had not happened, printed as the end of the record, in the
   table headed "what has actually landed", on the page an operator opens to
   find out what is MISSING. /api/coverage/calendar had already been bounded
   for exactly this reason; this is the other half of the same row.

   The accrual is NOT truncated away. It is real money, /api/reconcile names it
   as an accrual, and a coverage table that silently dropped it would be
   answering a different question from the page beside it. It is counted and
   labelled instead. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* Dubai days, because that is what the route bounds against. Three that have
   happened and two that have not — the shape an open weekly period makes. */
/* to_char, so the day arrives as a string. A bare DATE comes back as a Date at
   LOCAL midnight and String(it).slice(0, 10) is "Fri Aug 21" — the trap this
   whole afternoon was spent on. */
const dubaiToday = (await q(
  `SELECT to_char((now() AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS d`))[0].d;
const shift = (n) => new Date(Date.parse(`${dubaiToday}T00:00:00Z`) + n * 864e5)
  .toISOString().slice(0, 10);
for (const [day, earnings] of [[shift(-3), 100], [shift(-2), 110], [shift(0), 120],
  [shift(1), 130], [shift(2), 140]]) {
  await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, day,
             period_start, period_end, earnings)
           VALUES ('uber','ecosine','d1',$1::date,$1::date,$1::date,$2)`, [day, earnings]);
}
/* A platform with no open period at all, so the plain case is exercised too. */
await q(`INSERT INTO driver_payout_day (platform, fleet_id, driver_ext_id, day,
           period_start, period_end, earnings)
         VALUES ('yango','ecosine','d2',$1::date,$1::date,$1::date,90)`, [shift(-1)]);

const { server } = await mountAll(db);
const port = server.address().port;
const body = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

const cov = await body('/api/coverage');
const uber = (cov.earnings || []).find((r) => r.platform === 'uber');
const yango = (cov.earnings || []).find((r) => r.platform === 'yango');

const iso = (v) => (v == null ? null : String(v).slice(0, 10) === String(v)
  ? String(v) : new Date(v).toISOString().slice(0, 10));

check('the inventory still reports every row it holds', uber?.n === 5, JSON.stringify(uber));
check('to_day is the last day STORED, accrual included — nothing is hidden',
  iso(uber.to_day) === shift(2), `${iso(uber?.to_day)} vs ${shift(2)}`);
check('but the LATEST day is the last one that has happened',
  iso(uber.to_day_settled) === shift(0), `${iso(uber?.to_day_settled)} vs ${shift(0)}`);
check('and the days it claims to cover exclude the ones that have not arrived',
  uber.days === 3, `days=${uber?.days} over 5 rows, 2 of them future`);
check('the accrual is counted and named rather than dropped',
  uber.accrual_days === 2, String(uber?.accrual_days));
check('a platform with no open period reports no accrual at all',
  yango?.accrual_days === 0 && iso(yango.to_day_settled) === iso(yango.to_day),
  JSON.stringify(yango));
check('and the money is still the whole of it — an accrual is real money',
  Number(uber.earnings) === 600, String(uber?.earnings));

/* The bound must be the DUBAI day, like every other calendar key here. A UTC
   bound would drop a row for today between 20:00 and midnight Dubai — the four
   hours in which this exact class of bug has been found twice today. */
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('api/server.js', 'utf8');
  /* The inventory query specifically. driver_payout_day is read in a dozen
     places; slicing around the FIRST match measured somebody else's. */
  const at = src.indexOf('min(day) from_day, max(day) to_day');
  const block = at < 0 ? '' : src.slice(at, src.indexOf('GROUP BY 1', at) + 20);
  check('the bound is the Dubai day, not the UTC one',
    /day <= \(now\(\) AT TIME ZONE 'Asia\/Dubai'\)::date/.test(block)
    && !/day <= current_date/.test(block), 'a UTC bound loses today after 20:00 Dubai');
}

server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
