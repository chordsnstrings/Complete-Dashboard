/* The cash POSITION, and the three ways a read of it could lie.
   ──────────────────────────────────────────────────────────────────────────
   driver_statement_day.unremitted is "still-unremitted balance"
   (sql/schema_v25.sql:14) — the operator's own accounts figure for how much
   cash a driver is holding. It has been written on every statement import
   since that file shipped and read by NOTHING: a grep across api/ and src/
   before api/ledger_routes.js returned three hits, all inside the INSERT in
   /api/import/statement-days. Nobody, including the team that maintains it,
   could see what it holds.

   The advance ledger's exposure ratio leans on this number, so the three ways
   a read of it could mislead are each asserted here:

   1. A BALANCE SUMMED. It is a position, not a flow. Adding up a person's
      daily balances produces a number several times the truth that still looks
      like money. The headline must be the LAST figure filed.

   2. A MISSING FIGURE RENDERED AS ZERO. "The accounts team has not filed a
      position for this person" and "this person is holding nothing" are
      different facts, and only one of them is safe to lend against. A person
      with statement rows and no unremitted figure must come back null WITH a
      sentence, never 0.

   3. A STALE FIGURE RENDERED AS CURRENT. A balance filed in April is not a
      balance today. The age is returned so a page can say so rather than
      printing a four-month-old number beside today's date.

   The pseudo rows are the fourth: sql/schema_v25.sql:47 records that statement
   lines the operator could not tie to a person, and the org-level fee rows,
   are real money and not a driver. They must be counted in the source totals
   and excluded from every per-person figure. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

const row = (name, day, o = {}) => q(
  `INSERT INTO driver_statement_day
     (platform, fleet_id, driver_name, driver_ext_id, day, gross, net, cash, bank,
      network_cash, unremitted, trips, source, pseudo)
   VALUES ('uber','ecosine',$1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [name, o.ext ?? null, day, o.gross ?? 500, o.net ?? 450, o.cash ?? null, o.bank ?? null,
    o.network_cash ?? null, o.unremitted ?? null, o.trips ?? 10,
    o.source ?? 'ledger', o.pseudo ?? false]);

/* BALANCE HOLDER. Four days, a balance on three of them, drifting the way a
   position does. Sum 2,600; latest 900. If the route sums, it says 2,600. */
await row('Balance Holder', '2026-09-01', { unremitted: 1200, cash: 300 });
await row('Balance Holder', '2026-09-02', { unremitted: 500,  cash: 200 });
await row('Balance Holder', '2026-09-03', { cash: 150 });
await row('Balance Holder', '2026-09-04', { unremitted: 900,  cash: 250, ext: 'U-BAL' });

/* NO POSITION FILED. Statement rows, cash flows, and no balance anywhere. */
await row('No Position', '2026-09-01', { cash: 400 });
await row('No Position', '2026-09-02', { cash: 350 });

/* STALE. One balance, months old, and nothing since. */
await row('Stale Figure', '2026-05-10', { unremitted: 7000 });

/* PSEUDO — real money, not a person. */
await row('(unmatched statement lines)', '2026-09-02', { cash: 9999, pseudo: true });

const { get } = await mountAll(db);
const r = await get('/api/ledger/cash-position?as_of=2026-09-21');
const body = r.body ?? r;
const by = Object.fromEntries((body.people || []).map((p) => [p.driver_name, p]));

check('the route answers', r.status === 200 || body.people, JSON.stringify(body).slice(0, 200));

/* ── 1. a balance is the LAST one filed, not the total ─────────────────── */
check('the headline position is the latest filed balance', by['Balance Holder']?.unremitted === 900,
  String(by['Balance Holder']?.unremitted));
check('and it is NOT the sum of the daily balances', by['Balance Holder']?.unremitted !== 2600);
check('the sum is still returned, so a reader can judge whether it behaves like a balance',
  by['Balance Holder']?.unremitted_sum === 2600, String(by['Balance Holder']?.unremitted_sum));
check('with the day it was filed', by['Balance Holder']?.unremitted_on === '2026-09-04',
  String(by['Balance Holder']?.unremitted_on));
check('and how many days carry a figure at all', by['Balance Holder']?.unremitted_days === 3,
  String(by['Balance Holder']?.unremitted_days));
check('the ledger id is carried through where the import attached one',
  by['Balance Holder']?.driver_ext_id === 'U-BAL');

/* ── 2. absent WITH A REASON, never zero ───────────────────────────────── */
check('a person with no filed balance returns null, not 0',
  by['No Position']?.unremitted === null, JSON.stringify(by['No Position']?.unremitted));
check('and says so in a sentence naming what IS on file',
  /has not|nobody has filed|on none of them/i.test(by['No Position']?.unremitted_absent_reason || ''),
  by['No Position']?.unremitted_absent_reason);
check('while their cash FLOW is still reported beside it',
  by['No Position']?.cash_sum === 750, String(by['No Position']?.cash_sum));
check('a person WITH a balance carries no absent reason',
  by['Balance Holder']?.unremitted_absent_reason === null);

/* ── 3. staleness is a number the page can print ───────────────────────── */
check('a months-old balance reports its age in days',
  by['Stale Figure']?.unremitted_age_days === 134, String(by['Stale Figure']?.unremitted_age_days));
check('the summary names the stalest figure on file',
  body.summary?.stalest_figure_days === 134, String(body.summary?.stalest_figure_days));

/* ── 4. pseudo rows: counted, never attributed ─────────────────────────── */
check('a pseudo statement line is not a person',
  !Object.keys(by).some((n) => /unmatched/i.test(n)), Object.keys(by).join(' | '));
const led = (body.sources || []).find((s) => s.source === 'ledger');
check('but it IS counted in the source totals, so the two reconcile',
  led?.pseudo_rows === 1, JSON.stringify(led));
check('the source block reports how many rows carry a balance at all',
  led?.rows_unremitted === 4, String(led?.rows_unremitted));
check('and how many PEOPLE do', led?.people_unremitted === 2, String(led?.people_unremitted));

/* ── the summary, which is the first thing anybody reads ───────────────── */
check('the summary counts people on the ledger, excluding pseudo',
  body.summary?.people_on_the_ledger === 3, String(body.summary?.people_on_the_ledger));
check('and how many of them carry a daily figure', body.summary?.people_with_a_daily_figure === 2,
  String(body.summary?.people_with_a_daily_figure));
check('and names the gap rather than leaving it to subtraction',
  body.summary?.people_without_any_figure === 1, String(body.summary?.people_without_any_figure));
check('the total is the sum of each person\'s latest DAILY figure',
  body.summary?.total_of_latest_daily_figures === 7900,
  String(body.summary?.total_of_latest_daily_figures));

/* THE ASSERTION THAT MATTERS MOST IN THIS FILE.
   Measured on production 2026-09-21: unremitted records, per day, the cash a
   driver had not handed in when that row was written, and NOTHING reduces it
   when they hand it in later, because no remittance event is recorded anywhere
   in this database. So the sum overstates by every dirham ever returned and
   the latest figure is one day's leftovers. Neither is a position, and the
   route must not let a reader believe otherwise — the field name alone was
   enough to mislead its own author. */
check('the route refuses to call any of this a cash position',
  body.summary?.is_a_cash_position === false, JSON.stringify(body.summary?.is_a_cash_position));
check('and says why, naming the missing remittance event',
  /remittance event/i.test(body.summary?.why_not || ''), body.summary?.why_not);
check('no field in the summary is called a position or a balance',
  !Object.keys(body.summary || {}).some((k) => /position|balance/.test(k)
    && k !== 'is_a_cash_position'),
  Object.keys(body.summary || {}).join(','));
check('the basis names the fold this ledger uses, because it is not person_key',
  /name/i.test(body.basis || '') && /not reconciled|different person fold/i.test(body.basis || ''),
  body.basis);

/* ── THE WINDOW, which is the shape the operator actually asked for ──────
   "how much the driver earned for the duration and how much the guy has daily
   will give us the accumulated figure and we can see for any duration of our
   choosing." Summing a FLOW over a window is what a flow is for; the earlier
   mistake was calling the same column a balance and reporting one day of it.

   Balance Holder: 1200 + 500 + (none) + 900 = 2600 over the four days, and
   1400 over the three from the 2nd. Gross 500/day and net 450/day by fixture. */
const w = (await get('/api/ledger/cash-position?as_of=2026-09-21')).body;
const wby = Object.fromEntries((w.people || []).map((p) => [p.driver_name, p]));
check('the accumulated figure is every daily amount in the window, added up',
  wby['Balance Holder']?.cash_held_accumulated === 2600,
  String(wby['Balance Holder']?.cash_held_accumulated));
check('earnings over the same window come back beside it, gross and net apart',
  wby['Balance Holder']?.earned_gross === 2000 && wby['Balance Holder']?.earned_net === 1800,
  JSON.stringify([wby['Balance Holder']?.earned_gross, wby['Balance Holder']?.earned_net]));
check('with the days actually worked, so a rate can be read without inventing one',
  wby['Balance Holder']?.days_worked === 4, String(wby['Balance Holder']?.days_worked));

const n = (await get('/api/ledger/cash-position?from=2026-09-02&as_of=2026-09-21')).body;
const nby = Object.fromEntries((n.people || []).map((p) => [p.driver_name, p]));
check('a narrower duration accumulates only that duration',
  nby['Balance Holder']?.cash_held_accumulated === 1400,
  String(nby['Balance Holder']?.cash_held_accumulated));
check('and narrows the earnings with it, not just the cash',
  nby['Balance Holder']?.earned_gross === 1500 && nby['Balance Holder']?.earned_net === 1350,
  JSON.stringify([nby['Balance Holder']?.earned_gross, nby['Balance Holder']?.earned_net]));
check('the window it answered for is echoed back, so a reader cannot mistake it',
  n.from === '2026-09-02' && w.from === null, JSON.stringify([n.from, w.from]));
/* An unasked window accumulates the WHOLE record. The payouts page shipped
   reading 6 of 217 transfers because a route defaulted to a sliver and said
   nothing; this one defaults wide and says which. */
check('an unasked duration reaches back to the oldest row, not a silent slice',
  !!wby['Stale Figure'] && wby['Stale Figure'].unremitted === 7000,
  JSON.stringify(Object.keys(wby)));
check('and a narrow one drops a person whose only rows fall outside it, correctly',
  !nby['Stale Figure'] && Object.keys(nby).length === 2, JSON.stringify(Object.keys(nby)));

/* ── the per-person series, which is what settles balance-vs-daily-flow ──
   The aggregate cannot distinguish a balance that climbs and drops from a
   quantity that stands alone each day; only consecutive days can. */
const ser = await get('/api/ledger/cash-position?person=balance%20holder&as_of=2026-09-21');
const sb = ser.body ?? ser;
check('a person series comes back newest first',
  (sb.days || []).map((d) => d.day).join(',') === '2026-09-04,2026-09-03,2026-09-02,2026-09-01',
  JSON.stringify((sb.days || []).map((d) => d.day)));
check('and carries the daily figure, nulls included rather than zeroed',
  sb.days?.[1]?.unremitted === null && sb.days?.[0]?.unremitted === 900,
  JSON.stringify(sb.days?.slice(0, 2)));
check('with the cash flow beside it for comparison',
  sb.days?.[0]?.cash === 250, String(sb.days?.[0]?.cash));
check('a name the ledger does not hold says so rather than returning an empty list silently',
  /no statement day on file/i.test((await get('/api/ledger/cash-position?person=nobody')).body?.note || ''));

/* ── an empty ledger says so instead of totalling nothing to zero ──────── */
const db2 = new PGlite();
await applySchema(db2);
const { get: get2 } = await mountAll(db2);
const e = await get2('/api/ledger/cash-position?as_of=2026-09-21');
const eb = e.body ?? e;
check('with no ledger at all the total is null, not AED 0',
  eb.summary?.total_of_latest_daily_figures === null, JSON.stringify(eb.summary));
check('and the reason says the column may simply never have been filled',
  /never have been filled|no cash position/i.test(eb.summary?.total_unremitted_reason || ''),
  eb.summary?.total_unremitted_reason);

console.log(`\n${fail ? '✗' : '✓'} ledger_cash_position: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
