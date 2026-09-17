/* WHY THE WIRES WERE AT THE BACK OF THE QUEUE, AND WHAT checked_at IS FOR.
   ═══════════════════════════════════════════════════════════════════════════
   Three claims made by src/sources/uber_payout.js and sql/schema_v74.sql, each
   of which was a sentence in a comment before it was a test.

   1. THE BACKFILL WAS ORDERED SO THAT IT COULD NOT REACH A WIRE.
      missingDays() returns the days this fleet has no statement for and the
      walk is bounded at DAYS_PER_RUN (24) because a payment report takes
      10-40 s and Uber's limiter shuts for minutes. Strictly oldest-first, that
      budget is spent on whichever days happen to be oldest, and only one day in
      seven carries a transfer.

      Measured on production 2026-09-17: uber/ecosine held statement rows for
      2026-08-17 .. 08-20 and nothing after. Monday 2026-09-14 — the wire of
      111,179.66 that settles the week the Payouts page is asked about most —
      was therefore the TWENTY-FIFTH missing day, one past the budget. Not late:
      unreachable, on that night and on the next one, because each run refills
      the queue from the same end. Uber's limiter had cut the previous run to 4
      of the 8 days it asked for, so the queue was moving at four days a night
      with every wire behind 20 ordinary days.

      The fixture below reproduces that exact arithmetic and then asserts the
      shipped ORDER BY fixes it — and, just as importantly, that it changes
      WHICH days are asked first and not WHICH days are asked at all.

   2. EXTRACT(dow) IS 0=SUNDAY, 1=MONDAY. A convention worth getting wrong:
      ISODOW is 1=Monday..7=Sunday, DOW is 0=Sunday..6=Saturday, and the two
      agree on Monday and on nothing else — so a wrong guess here is a filter
      that silently prioritises Sundays and still returns every day, which no
      row count would catch. Postgres is asked directly rather than trusted.

   3. checked_at IS NOT collected_at. collected_at is NOT NULL DEFAULT now()
      and the walk asks a day once, so it is frozen at "when the backfill got
      here" for ever. checked_at means "the last time a human asked Uber live
      for this day", is nullable, has no default, and must survive a later
      backfill re-storing the row.

   And one structural claim, because it is the one that would rot quietly:
   POST /api/finance/payouts/verify and the nightly walk must go through ONE
   fetch-parse-store, not two. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema, SCHEMA_FILES } from './schema.mjs';
import { settlesWeek, MISSING_DAYS_ORDER, oneDay } from '../src/sources/uber_payout.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const applied = await applySchema(db);

/* ══ 1. schema_v74 is registered, and the column it adds actually lands ════ */
console.log('\nchecked_at exists after every migration has replayed');
{
  /* Registered, not merely written. A .sql file that is not in
     src/schema_files.js is a file production never runs — the ledger replays
     the list, not the directory — and the failure mode is a column that exists
     on every developer's PGlite and on no server. */
  check('schema_v74.sql is in the schema file list',
    SCHEMA_FILES.includes('schema_v74.sql'), SCHEMA_FILES.slice(-3).join(', '));
  check('…and applySchema replayed it with the rest',
    applied.includes('schema_v74.sql'), String(applied.length));

  /* Asserted against information_schema rather than by selecting the column:
     a SELECT would pass against a column added by any means, including a hand
     patch nobody committed. */
  const [col] = await q(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'platform_account_day' AND column_name = 'checked_at'`);
  check('platform_account_day.checked_at exists', !!col, 'no such column');
  check('…and it is a timestamptz',
    col && col.data_type === 'timestamp with time zone', col && col.data_type);
  /* NULL means NOBODY HAS ASKED. A NOT NULL column with a default would assert
     that the nightly walk is a human check, which is the precise claim this
     column exists to be able to deny. */
  check('…nullable, because nobody-has-asked is a real state',
    col && col.is_nullable === 'YES', col && col.is_nullable);
  check('…and with no default, so collection never counts as verification',
    col && col.column_default === null, col && String(col.column_default));

  /* collected_at is the other half of the distinction and must still be what
     it was: if it ever became nullable the two columns would mean the same
     thing and the page could not tell a backfilled row from a checked one. */
  const [old] = await q(
    `SELECT is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'platform_account_day' AND column_name = 'collected_at'`);
  check('collected_at is still NOT NULL DEFAULT now(), and so still means "collected"',
    old && old.is_nullable === 'NO' && /now\(\)/.test(String(old.column_default)),
    old && `${old.is_nullable} / ${old.column_default}`);
}

console.log('\na later backfill does not erase a check a human made');
{
  /* THE CLAIM sql/schema_v74.sql MAKES, EXERCISED. oneDay() puts checked_at in
     the row object only when live is true, and upsertMany builds its column
     list from the keys of the row it is given — so the nightly walk's
     ON CONFLICT DO UPDATE never names the column. The two statements below are
     exactly the two upserts that produces. */
  await q(
    `INSERT INTO platform_account_day
       (platform, fleet_id, day, basis, bank_transferred, checked_at)
     VALUES ('uber','ecosine',DATE '2026-09-14','statement',-111179.66,
             TIMESTAMPTZ '2026-09-17T09:00:00Z')
     ON CONFLICT (platform, fleet_id, day) DO UPDATE
       SET basis = EXCLUDED.basis, bank_transferred = EXCLUDED.bank_transferred,
           checked_at = EXCLUDED.checked_at`);
  await q(
    `INSERT INTO platform_account_day
       (platform, fleet_id, day, basis, bank_transferred)
     VALUES ('uber','ecosine',DATE '2026-09-14','statement',-111179.66)
     ON CONFLICT (platform, fleet_id, day) DO UPDATE
       SET basis = EXCLUDED.basis, bank_transferred = EXCLUDED.bank_transferred`);
  const [r] = await q(
    `SELECT checked_at FROM platform_account_day
      WHERE platform='uber' AND fleet_id='ecosine' AND day = DATE '2026-09-14'`);
  check('a re-store that omits the column leaves the human check standing',
    r && r.checked_at !== null, r && String(r.checked_at));
  /* Cleaned up so it cannot pollute the ordering fixture below, which is about
     which days are MISSING. */
  await q(`DELETE FROM platform_account_day WHERE day = DATE '2026-09-14'`);
}

/* ══ 2. Postgres's own weekday numbering, asked rather than assumed ════════ */
console.log('\nEXTRACT(dow) is 0=Sunday and 1=Monday, on this Postgres');
{
  /* 2026-08-17, 2026-09-07 and 2026-09-14 are the three Mondays this collector
     has measured Ecosine wires on, so they are the right dates to pin the
     convention with. */
  const [d] = await q(
    `SELECT EXTRACT(dow FROM DATE '2026-09-14')     AS mon_dow,
            EXTRACT(dow FROM DATE '2026-09-13')     AS sun_dow,
            EXTRACT(isodow FROM DATE '2026-09-14')  AS mon_iso,
            EXTRACT(isodow FROM DATE '2026-09-13')  AS sun_iso`);
  check('a Monday is dow 1', Number(d.mon_dow) === 1, String(d.mon_dow));
  check('a Sunday is dow 0, not 7', Number(d.sun_dow) === 0, String(d.sun_dow));
  /* The trap, stated as an assertion: isodow agrees on Monday and disagrees on
     Sunday, so "= 1" is correct under both and only dow makes Sunday 0. A test
     that pinned only Monday would pass under either convention. */
  check('isodow numbers the same Monday 1 as well, which is why the mistake survives',
    Number(d.mon_iso) === 1, String(d.mon_iso));
  check('…and numbers that Sunday 7, which is the difference that bites',
    Number(d.sun_iso) === 7, String(d.sun_iso));
}

/* ══ 3. The shipped ORDER BY, on the production fixture ═══════════════════ */
console.log('\nthe missing days come back Mondays first, then oldest first');

/* Production as it stood on 2026-09-17: uber/ecosine has statement rows for
   2026-08-17 .. 08-20 and nothing after. */
for (const d of ['2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20']) {
  await q(
    `INSERT INTO platform_account_day (platform, fleet_id, day, basis)
     VALUES ('uber','ecosine',$1::date,'statement')`, [d]);
}
/* One LEDGER row inside the window. A ledger row is not a statement row and
   the join says so, so this day must still count as missing — otherwise a
   Yango-style summed row would mark an Uber day as asked-and-answered. */
await q(
  `INSERT INTO platform_account_day (platform, fleet_id, day, basis)
   VALUES ('uber','ecosine',DATE '2026-08-25','ledger')`);
/* A statement row for the OTHER fleet on a day ecosine is missing, because the
   join is keyed on fleet too and a shared day would otherwise hide it. */
await q(
  `INSERT INTO platform_account_day (platform, fleet_id, day, basis)
   VALUES ('uber','egari',DATE '2026-09-14','statement')`);

/* missingDays()'s query, with the generate_series bound to literal dates
   instead of now(). The clock is deliberately out of this test: the shape
   under assertion is the ORDER BY, and a fixture that drifted with the wall
   date would stop reproducing the 25th-day arithmetic the day after it was
   written. MISSING_DAYS_ORDER is IMPORTED, not retyped, so this asserts the
   text that ships rather than a copy of it. */
const missingSql = (order) => `
  WITH asked AS (
    SELECT generate_series(DATE '2026-08-17', DATE '2026-09-16', interval '1 day')::date AS d
  )
  SELECT a.d::text AS d
    FROM asked a
    LEFT JOIN platform_account_day p
      ON p.platform = 'uber' AND p.fleet_id = 'ecosine' AND p.day = a.d AND p.basis = 'statement'
   WHERE p.day IS NULL
   ORDER BY ${order}`;

const shipped = (await q(missingSql(MISSING_DAYS_ORDER))).map((r) => r.d);
const oldOrder = (await q(missingSql('a.d'))).map((r) => r.d);
const DAYS_PER_RUN = 24;
const isMonday = (s) => {
  /* Noon UTC, the idiom src/sources/uber_payout.js settlesWeek() uses and for
     the same reason: midday is far enough from either midnight that no offset
     in use can move it across a date boundary. Computed in JS rather than read
     back from Postgres, so this is an independent witness of the ordering and
     not the ordering agreeing with itself. */
  return new Date(Date.parse(`${s}T12:00:00Z`)).getUTCDay() === 1;
};

{
  check('the ledger row does not count as a statement, so its day is still missing',
    shipped.includes('2026-08-25'), 'a summed ledger row is not the provider’s statement');
  check('the other fleet’s statement does not mark this fleet’s day as asked',
    shipped.includes('2026-09-14'), 'the join is keyed on fleet as well as day');

  /* THE POINT OF THE WHOLE CHANGE: the SET is identical and only the ORDER
     differs. A reordering that also dropped or added a day would be a
     collection bug wearing a performance fix. */
  check('exactly the same days are asked, in both orders',
    shipped.length === oldOrder.length
    && [...shipped].sort().join() === [...oldOrder].sort().join(),
    `${shipped.length} vs ${oldOrder.length}`);
  check('…and that set is the 27 days after the four already stored',
    shipped.length === 27 && !shipped.includes('2026-08-20')
    && shipped.includes('2026-08-21') && shipped.includes('2026-09-16'),
    String(shipped.length));

  const mondays = shipped.filter(isMonday);
  const rest = shipped.filter((d) => !isMonday(d));
  check('the window holds the four Mondays it should',
    mondays.join(',') === '2026-08-24,2026-08-31,2026-09-07,2026-09-14', mondays.join(','));

  /* EVERY Monday before EVERY non-Monday. Asserted as a boundary rather than
     by spot-checking a pair, because a comparator that merely floated one
     Monday forward would pass the spot check. */
  const lastMonday = Math.max(...mondays.map((d) => shipped.indexOf(d)));
  const firstOther = Math.min(...rest.map((d) => shipped.indexOf(d)));
  check('every Monday comes before every other day',
    lastMonday < firstOther, `last Monday at ${lastMonday}, first other at ${firstOther}`);

  const ascending = (xs) => xs.every((d, i) => i === 0 || xs[i - 1] < d);
  check('the Mondays are in ascending date order among themselves',
    ascending(mondays), mondays.join(','));
  check('…and so is everything behind them, which is the old rule kept',
    ascending(rest), rest.slice(0, 5).join(','));

  /* THE PRODUCTION DEFECT, REPRODUCED AND THEN FIXED.
     One run asks DAYS_PER_RUN days. Under the old order the wire of
     2026-09-14 sat at position 25 of 27 and could not be reached; under the
     shipped order it is in the first four. */
  check('under the old order the 2026-09-14 wire was the 25th missing day',
    oldOrder.indexOf('2026-09-14') === 24, String(oldOrder.indexOf('2026-09-14') + 1));
  check('…so a 24-day run could not reach it, on that night or any other',
    !oldOrder.slice(0, DAYS_PER_RUN).includes('2026-09-14'));
  check('under the shipped order it is in the first four days asked',
    shipped.indexOf('2026-09-14') < 4, String(shipped.indexOf('2026-09-14') + 1));
  check('…and so is every other wire in the window',
    mondays.every((d) => shipped.indexOf(d) < DAYS_PER_RUN),
    mondays.map((d) => shipped.indexOf(d)).join(','));
  /* The complement, spelled out: nothing was dropped to make room. The last
     ordinary day still gets asked, just on a later night. */
  check('the days pushed back are still in the queue, not out of it',
    shipped.includes('2026-09-16') && shipped.indexOf('2026-09-16') >= DAYS_PER_RUN,
    String(shipped.indexOf('2026-09-16')));
}

/* ══ 4. settlesWeek stamps Mon–Sun, and only for a Monday ═════════════════ */
console.log('\nsettlesWeek stamps the preceding Mon–Sun week, on Mondays only');
{
  const w = settlesWeek('2026-09-14');
  check('a Monday settles the week that ended the day before',
    w.period_start === '2026-09-07' && w.period_end === '2026-09-13',
    JSON.stringify(w));
  /* A second Monday, three weeks earlier, so this is a rule and not a constant
     that happens to be right for one date. */
  const w2 = settlesWeek('2026-08-17');
  check('…and so does the Monday three weeks before it',
    w2.period_start === '2026-08-10' && w2.period_end === '2026-08-16',
    JSON.stringify(w2));

  /* EVERY other weekday, not a sample. The bug this function was written to
     fix (see its comment) was an off-by-one weekday that fired on Tuesdays,
     which a test checking only Wednesday would have missed. */
  const rest = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18',
                '2026-09-19', '2026-09-20'];
  for (const d of rest) {
    const r = settlesWeek(d);
    check(`${d} is not a Monday and gets no invented period`,
      Object.keys(r).length === 0, JSON.stringify(r));
  }
  /* Sunday is the one that matters most: it is the day a UTC-anchored parse of
     Dubai midnight reported for a Monday, which is exactly how the original
     bug produced a period of NULL on every real wire. */
  check('Sunday in particular gets nothing',
    Object.keys(settlesWeek('2026-09-13')).length === 0);
  check('a date that is not a date gets nothing rather than NaN',
    Object.keys(settlesWeek('not-a-day')).length === 0);

  /* The period it stamps must be the one the reconcile route sums over, and
     that is seven days inclusive. Off by one at either end and the comparison
     against sum(driver_payout_day.earnings) silently gains or loses a day. */
  const span = (Date.parse(`${w.period_end}T12:00:00Z`)
                - Date.parse(`${w.period_start}T12:00:00Z`)) / 864e5;
  check('the stamped period is seven days inclusive', span === 6, String(span + 1));
}

/* ══ 5. One fetch-parse-store, not two ════════════════════════════════════ */
console.log('\nthe live route and the nightly walk share one implementation');
{
  const src = readFileSync(new URL('../src/sources/uber_payout.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  check('oneDay is exported, so api/payout_routes.js can call it',
    typeof oneDay === 'function' && /export async function oneDay\(/.test(code));
  /* It has to STORE, not just parse: the route's whole job is that what Uber
     said is kept. */
  check('…and it writes the statement day itself',
    /upsertMany\('platform_account_day'/.test(code));
  check('…and the register row for a day that was a wire',
    /upsertMany\('platform_payout'/.test(code));

  /* EXACTLY ONE OF EACH. A second copy is the failure this is guarding: the
     mapper's claim is that an EMPTY bank cell and an ABSENT bank column are
     different facts, and a copy that got that one line wrong would write a
     wire of zero on four days in five while the original wrote none. Two
     processes would then disagree about the same day depending on which asked. */
  const dayWrites = (code.match(/upsertMany\('platform_account_day'/g) || []).length;
  const payWrites = (code.match(/upsertMany\('platform_payout'/g) || []).length;
  check('there is exactly one statement write in the module', dayWrites === 1, String(dayWrites));
  check('and exactly one register write', payWrites === 1, String(payWrites));

  /* Both inside oneDay and not in collect()'s loop, which is what makes the
     API process's write identical rather than merely similar. */
  const oneDayAt = code.indexOf('export async function oneDay(');
  const collectAt = code.indexOf('export async function collect(');
  check('both writes sit inside oneDay, ahead of collect',
    oneDayAt > -1 && collectAt > oneDayAt
    && code.indexOf(`upsertMany('platform_account_day'`) > oneDayAt
    && code.indexOf(`upsertMany('platform_account_day'`) < collectAt
    && code.indexOf(`upsertMany('platform_payout'`) > oneDayAt
    && code.indexOf(`upsertMany('platform_payout'`) < collectAt,
    `oneDay ${oneDayAt}, collect ${collectAt}`);

  /* checked_at is stamped on the live ask only. If the walk started writing it
     the column would mean "collected" again and schema_v74 would be a second
     collected_at. */
  check('checked_at is written only when the caller says a human asked',
    /live \? \{ checked_at \} : \{\}/.test(code) || /live \? new Date\(\)/.test(code),
    'oneDay must gate checked_at on its live flag');
}

/* CLOSE THE DATABASE AND EXIT EXPLICITLY. PGlite holds handles of its own and
   test/run-all.mjs SIGKILLs a file at 300 s, throwing the tally away and
   reporting it as a failure with every assertion passing. */
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
