/* A run that fetched no trips never vouches for a day's bookings.
   ──────────────────────────────────────────────────────────────────────────
   2026-10-08: the Uber fare pass went hourly (src/run.js fareRefresh). It
   writes an 'uber' row to collection_run every hour — mode 'fares', ok, a
   window covering today — and so does the payout walk every two hours (mode
   'payout-walk:payout'). Every check that asks "was this channel's day
   collected?" counted any ok row, so a trip collector dead since breakfast
   would have read as current all day: goal texts on stale trip counts, the
   Target page settling a day with trips missing, the morning report's data
   health green. api/run_kinds.js TRIP_RUN_SQL is the one rule they share now;
   this drives each check with fares and payout rows only, then with a real
   trip run, and once with a run logged without a mode. Synthetic throughout. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { channelsCollected } from '../src/daily_report.js';
import { channelHealthSql } from '../api/channels_sql.js';
import { freshChannels } from '../src/target_sms.js';
import { collectedPairs } from '../src/driver_sms.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const run = (mode, status, ws, we, fin, fleet = 'ecosine', source = 'uber') => q(
  `INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, started_at, finished_at, status, rows_written)
   VALUES ($1, $2, $3, $4::date, $5::date, $6::timestamptz - interval '5 minutes', $6::timestamptz, $7, 10)`,
  [source, fleet, mode, ws, we, fin, status]);

const D = '2026-10-07';                         // its Dubai day ends 2026-10-07 20:00Z
await run('incremental', 'ok', '2026-10-02', '2026-10-05', '2026-10-05T10:00:00Z');   // a pair that collects
await run('fares', 'ok', '2026-10-05', '2026-10-07', '2026-10-07T21:05:00Z');          // after the day, covering it
await run('payout-walk:payout', 'ok', '2026-09-07', '2026-10-07', '2026-10-07T22:20:00Z');

console.log('\nwith only a fares run and a payout run after the day ended');
{
  const c = await channelsCollected(q, D);
  check('the morning report counts Uber Ecosine as NOT delivered',
    c.missing.some((m) => m.platform === 'uber' && m.fleet === 'ecosine'), JSON.stringify(c));
  const pairs = await collectedPairs(q, D, new Date('2026-10-07T20:00:00Z'));
  check('the SMS gate does not count it as collected', !pairs.has('uber:ecosine'), JSON.stringify([...pairs]));
  const fresh = await freshChannels(q, D, new Date('2026-10-07T21:10:00Z'));
  check('the goal texts do not count it as fresh', !fresh.has('uber:ecosine'), JSON.stringify([...fresh]));
}

console.log('\nthe channel-health panel shows the trip run, not the price pass after it');
{
  await run('incremental', 'error', '2026-10-05', '2026-10-07', '2026-10-07T21:00:00Z', 'egari');
  await run('fares', 'ok', '2026-10-05', '2026-10-07', '2026-10-07T21:06:00Z', 'egari');
  const [h] = await q(`SELECT * FROM (${channelHealthSql()}) h WHERE source = 'uber' AND fleet_id = 'egari'`);
  check('a failed trip run is not hidden by an ok fares run six minutes later', h?.status === 'error', JSON.stringify(h));
}

console.log('\nonce a real trip run lands');
{
  await run('incremental', 'ok', '2026-10-04', '2026-10-07', '2026-10-07T21:30:00Z');
  const c = await channelsCollected(q, D);
  check('the morning report counts it delivered', !c.missing.some((m) => m.platform === 'uber' && m.fleet === 'ecosine'),
    JSON.stringify(c.missing));
  const pairs = await collectedPairs(q, D, new Date('2026-10-07T20:00:00Z'));
  check('…the SMS gate counts it collected', pairs.has('uber:ecosine'));
  const fresh = await freshChannels(q, D, new Date('2026-10-07T21:40:00Z'));
  check('…and the goal texts count it fresh', fresh.has('uber:ecosine'));
}

console.log('\na run logged without a mode still counts');
{
  await run(null, 'ok', '2026-10-05', '2026-10-07', '2026-10-07T21:30:00Z', 'ecosine', 'hotel');
  const pairs = await collectedPairs(q, D, new Date('2026-10-07T20:00:00Z'));
  check('a NULL mode is not mistaken for a fares or payout run', pairs.has('hotel:ecosine'), JSON.stringify([...pairs]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
