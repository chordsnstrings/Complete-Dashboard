/* UBER'S OWN BOOKS, ONE DAY AT A TIME — the exact wire, on the exact date.
   ─────────────────────────────────────────────────────────────────────────
   The dashboard has shown a figure called "bank payout" since reconciliation
   was built and it has never been one. api/reconcile_routes.js sums
   driver_payout_day.earnings by month and names the total bank_payout: that is
   Uber's weekly PER-DRIVER earnings spread over the days they were earned. A
   real quantity, and not a transfer.

   ── THE "7.1% APART" THIS COMMENT USED TO CARRY WAS A WRONG-WEEK COMPARISON,
      AND IT IS RETRACTED HERE ────────────────────────────────────────────
   The retracted sentence read: "Measured on the closed week Mon 7 – Sun 13 Sep
   2026 for Ecosine, the dashboard says 110,962.09 and Uber's own books say the
   wire was 103,567.54 — 7.1% apart, describing different events." Its
   arithmetic is sound — 7,394.55 / 103,567.54 = 7.14% — and its two figures
   are not the same week, which is the only reason they disagreed by that much.

   103,567.54 was wired on MONDAY 2026-09-07. By the cadence established below,
   a Monday wire settles the Mon–Sun week that ended the day before, so that
   wire settles 31 Aug – 6 Sep. The wire that settles 7–13 Sep is the one paid
   on Monday 2026-09-14, and it is 111,179.66. Put beside the right wire, and
   measured on production 2026-09-17:

     ours, the seven daily bank_payout figures /api/reconcile prints for
     7–13 Sep, which are sum(driver_payout_day.earnings) per day:
       14,324.61 + 15,770.41 + 17,192.37 + 16,612.39
       + 17,532.04 + 15,726.00 + 13,804.27               = 110,962.09
     Uber's wire, Mon 2026-09-14                          = 111,179.66
     difference                                                217.57  (0.20%)

   So the two registers agree to a fifth of one percent. The seven percent was
   this file comparing a week's earnings against the wire for the week BEFORE
   it, and a page that repeated the figure inherited the error. They still
   describe different events — a week of per-driver earnings is not a transfer,
   and the 217.57 is the interesting number precisely because it is small —
   but "7.1% apart" was not a measurement of that difference.

   REPORT_TYPE_PAYMENTS_ORGANIZATION is the statement. One row per org per
   window, twenty-one columns, including "Payouts : Transferred To Bank
   Account", which is the literal wire. It closes to the fils on a one-day
   window as well as a weekly one — Ecosine, Mon 2026-09-14, live from Uber:

     opening 111,279.92 + earnings 20,816.90 + refunds & expenses 1,290.28
             - payouts 115,362.76 = closing 18,024.34

   where payouts 115,362.76 is cash collected 4,183.10 plus the wire
   111,179.66, and the identity holds exactly.

   THE FINDING THAT MADE THIS COLLECTOR POSSIBLE is that a ONE-DAY window
   works, and that is not obvious from a report whose own vocabulary is
   "period". The column is EMPTY on a day with no transfer and carries the
   whole transfer on the day it happened. Measured on production 2026-09-16,
   Ecosine, five consecutive one-day reports:

     Mon 2026-09-07  earnings 15,985.57  cash -2,816.65  BANK -103,567.54
     Tue 2026-09-08  earnings 18,127.27  cash -2,902.50  BANK (none)
     Wed 2026-09-09  earnings 19,426.04  cash -3,229.91  BANK (none)
     Thu 2026-09-10  earnings 18,713.33  cash -3,460.75  BANK (none)
     Fri 2026-09-11  earnings 21,066.24  cash -4,135.73  BANK (none)

   and the daily balances chain across all five without a gap:
     103,567.54 -> 14,199.06 -> 30,531.51 -> 47,693.72 -> 64,029.20 -> 82,086.09

   So Uber wires on MONDAY, and the Monday wire settles the Mon–Sun week that
   ended the day before. On this particular Monday the wire and that week's
   closing balance were the same figure to the fils — 103,567.54 is both — and
   that turned out to be a property of this Monday rather than of Mondays; see
   settlesWeek() below for the three measured Mondays and which of them agree.
   A week's report gives the amount. Only a day's report gives the date, and
   the date is the question.

   ── WHY THIS IS A SEPARATE MODULE AND A SEPARATE, SLOW WALK ──────────────
   Payment reports have a generation cap of their OWN, distinct from the
   three-in-flight cap on the rest of the report pipeline, and it is tighter:
   three one-day payment reports fired together came back

     "Code: rate-limited, Message: Payment report generation limit reached.
      Please wait for current reports to complete before generating a new one"

   and the limiter stayed shut for several minutes afterwards, refusing even a
   single request. So this walks ONE DAY AT A TIME, STRICTLY SEQUENTIALLY,
   across both fleets, and never runs on the half-hourly incremental. A day
   already stored is never asked again — which is what makes it affordable:
   after the first backfill it is one report per fleet per day, for ever. */
import { config } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { log } from '../log.js';
import { dubaiIso } from '../util.js';
import { uberWebHeaders, UBER_WEB_HOST } from '../auth/uber.js';
import { uberOrgs } from './uber.js';
import { parse } from 'csv-parse/sync';

const SRC = 'uber';
const REPORTS = `${UBER_WEB_HOST}/api/vs-sp-reports-management`;
const REPORT_TYPE = 'REPORT_TYPE_PAYMENTS_ORGANIZATION';

/* Uber writes the same column path with and without spaces around the colon,
   in the same header row — 'Payouts : Cash collected' and
   'Total earnings:Tip' are both from the live report. Keyed on the squeezed
   form so a mapper written against one spelling finds the other. This is the
   same normaliser src/sources/uber.js uses on the order payments report and it
   is duplicated here deliberately: the two modules must be able to change
   independently, and the rule is four characters long. */
export const pathKey = (s) => String(s || '').toLowerCase().replace(/\s*:\s*/g, ':').trim();

/* Every column this mapper reads, by its squeezed path. Asserted rather than
   assumed: if Uber renames one, the run says which name went missing instead
   of writing a day of nulls that reads exactly like a quiet day. */
export const COLUMNS = Object.freeze({
  opening_balance: 'start of period balance',
  closing_balance: 'end of period balance',
  earnings: 'total earnings',
  refunds_expenses: 'refunds & expenses',
  cash_collected: 'payouts:cash collected',
  bank_transferred: 'payouts:transferred to bank account',
  tips: 'total earnings:tip',
  taxes: 'total earnings:taxes',
});

/* '' and '1,234.56' are different facts and parseFloat('') is NaN for both
   reasons. An empty cell on this report means the movement did not happen —
   Uber leaves the bank column blank on a day with no transfer — so it maps to
   0, while a column that is ABSENT from the header maps to null. The two are
   kept apart all the way to the page: zero is a measurement, null is not. */
export const money = (v) => {
  if (v == null) return null;
  const t = String(v).replace(/,/g, '').trim();
  if (t === '') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMITED = /rate-limited|generation limit|too many ongoing|in progress/i;

/* ONE REPORT, ONE DAY, ONE ORG — ASKED, PARSED AND STORED, IN ONE PLACE.
   ─────────────────────────────────────────────────────────────────────────
   Returns the mapped row, what it stored, and any transfer it found — or a
   reason. Never throws for a provider refusal: a limiter that is shut is a
   fact about this minute, not about the day being asked, and a throw here
   would abandon the other twenty days of the walk.

   WHY THIS IS EXPORTED AND WHY THE STORE MOVED INSIDE IT.
   POST /api/finance/payouts/verify (api/payout_routes.js) asks Uber for a
   named day on an operator's behalf, from the API process rather than the
   collector — the same thing api/probe.js already does, importing
   uberWebHeaders and uberOrgs and calling Uber directly. It needs exactly
   this: generate the report, poll for the signed url, parse it, keep Uber's
   own words, and write both the statement day and any transfer it names.

   A SECOND IMPLEMENTATION OF THAT IS FORBIDDEN, and the reason is specific
   rather than tidiness. The mapper's whole claim is that an EMPTY bank cell
   and an ABSENT bank column are different facts (see money() above): a copy
   that got that one line wrong would write a wire of zero on four days in
   five, and the two copies would then disagree about the same day depending
   on which process happened to ask. The column names, the one-row assertion,
   the sign convention and the payout threshold are all decisions that have to
   be made identically or not at all, so they are made once, here.

   The store used to sit in collect()'s loop. It is inline here now — not
   factored out into a writer of its own — because the only caller that wants
   the parse without the write does not exist, and the two callers that do want
   it want it identically.

   live=false is the nightly walk; live=true is a person asking. The only
   difference is checked_at (sql/schema_v74.sql): the walk omits the column
   from its upsert entirely, so a day a human verified keeps its verification
   even if a later backfill re-stores the row. */
/* EVERY ASK LEAVES A ROW, WHATEVER CAME BACK.
   ─────────────────────────────────────────────────────────────────────────
   sql/schema_v75.sql has the argument in full. The short version: a day Uber
   has nothing for stores no statement, so without this it returns to
   missingDays() next run and every run after, and a widened backfill window
   spends its whole budget re-asking dead days while the live ones wait.

   'empty' and 'refused' are the two that matter and they are not the same
   fact. Empty means the provider answered and has nothing — settled, never ask
   again, and never render as a day with no transfer. Refused means nothing was
   learned — the limiter shut, the report timed out, the shape was not the one
   this module reads — so it must be asked again.

   NEVER FATAL. A bookkeeping write that takes the collection down with it
   would be a worse bug than the one it prevents: if this fails the day is
   simply asked again, which is the behaviour that existed before the table. */
const recordAsk = async (org, day, outcome, detail, live) => {
  try {
    await upsertMany('payout_ask', [{
      platform: SRC, fleet_id: org.fleet, day, outcome,
      detail: detail ? String(detail).slice(0, 300) : null,
      live: !!live, asked_at: new Date().toISOString(),
    }], ['platform', 'fleet_id', 'day']);
  } catch (e) {
    log.warn(SRC, 'payout statement: could not record the ask',
      { fleet: org.fleet, day, err: String(e?.message || e).slice(0, 140) });
  }
};

export async function oneDay(org, day, { live = false } = {}) {
  const gen = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
    method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(org),
    body: JSON.stringify({
      orgId: { uuid: { value: org.orgUuid } }, reportType: REPORT_TYPE,
      startDate: { value: day }, endDate: { value: day },
      childOrgUuids: [{ uuid: { value: org.orgUuid } }],
    }),
  });
  if (gen.data?.status !== 'success') {
    const detail = JSON.stringify(gen.data?.data?.meta?.details || gen.data).slice(0, 240);
    await recordAsk(org, day, 'refused', detail, live);
    return { throttled: RATE_LIMITED.test(detail), why: detail };
  }
  const id = gen.data.data.reportId.uuid.value;

  /* A one-day organisation report is one row and lands in seconds — but "did
     not finish in the time we waited" is a TIMEOUT and never a "not
     available", and the two have been confused on this pipeline before. The
     budget is generous and the reason says which it was. */
  let url = null;
  const deadline = Date.now() + 180000;
  let wait = 4000;
  while (!url && Date.now() < deadline) {
    const { data } = await http(`${REPORTS}/DownloadReport?localeCode=en-GB`, {
      method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(org),
      body: JSON.stringify({ orgId: { uuid: { value: org.orgUuid } },
        reportId: { uuid: { value: id } } }),
    });
    url = data?.data?.signedUrl?.value;
    if (!url) { await sleep(wait); wait = Math.min(wait * 1.4, 15000); }
  }
  if (!url) {
    const why = 'report did not finish generating within 180s (a timeout, not a refusal)';
    await recordAsk(org, day, 'refused', why, live);
    return { why };
  }

  const { data: csv } = await http(url, { expect: 'text', timeoutMs: 120000 });
  const recs = parse(String(csv), { columns: true, skip_empty_lines: true, bom: true });
  if (!recs.length) {
    /* THE ONE THAT SETTLES A DAY WITHOUT STORING ANYTHING. The report ran and
       carried nothing, so Uber has no statement for this date — the org did
       not exist yet, or it is a gap in the provider's own record. Settled, and
       emphatically NOT a day with no transfer. */
    const why = 'the report generated and contains no rows';
    await recordAsk(org, day, 'empty', why, live);
    return { why, empty: true };
  }

  /* ONE ROW PER ORG, and childOrgUuids names exactly one, so more than one row
     means the request meant something other than what this module thinks it
     means. Refused rather than summed: silently adding two orgs' balances
     together would produce a plausible number nobody could trace. */
  if (recs.length > 1) {
    await recordAsk(org, day, 'refused',
      `expected one organisation row and the report has ${recs.length}`, live);
    return { why: `expected one organisation row and the report has ${recs.length} — `
      + 'childOrgUuids named one org, so this is a shape change, not a busy day' };
  }
  const r = recs[0];
  const byKey = new Map(Object.keys(r).map((k) => [pathKey(k), k]));
  const missing = Object.entries(COLUMNS)
    .filter(([, path]) => !byKey.has(path)).map(([, path]) => path);
  /* The bank column is the whole point, so its absence is fatal to the row
     rather than a null in it. The rest are reported and mapped to null. */
  if (!byKey.has(COLUMNS.bank_transferred)) {
    await recordAsk(org, day, 'refused',
      `the report has no "${COLUMNS.bank_transferred}" column`, live);
    return { why: `the report has no "${COLUMNS.bank_transferred}" column — `
      + `has Uber renamed it? Columns: ${[...byKey.keys()].slice(0, 24).join(' | ')}` };
  }
  const pick = (path) => (byKey.has(path) ? money(r[byKey.get(path)]) : null);

  /* checked_at ONLY on a live ask, and by omission rather than by null.
     sql/schema_v74.sql adds the column meaning "the last time a human asked
     Uber live for this day". upsertMany builds its column list from the keys
     of the row it is given, so leaving the key OFF on the nightly walk means
     the ON CONFLICT DO UPDATE never names the column and whatever a previous
     human check wrote survives. Setting it to null instead would erase that
     check the next time a backfill happened to re-store the row. */
  const checked_at = live ? new Date().toISOString() : null;
  const row = {
    platform: SRC, fleet_id: org.fleet, day, currency: 'AED', basis: 'statement',
    opening_balance: pick(COLUMNS.opening_balance),
    closing_balance: pick(COLUMNS.closing_balance),
    earnings: pick(COLUMNS.earnings),
    refunds_expenses: pick(COLUMNS.refunds_expenses),
    cash_collected: pick(COLUMNS.cash_collected),
    bank_transferred: pick(COLUMNS.bank_transferred),
    /* Yango's ledger fills this and Uber's statement has no equivalent
       column: Uber's service fee is netted off before a payment reaches the
       organisation account, so there is nothing here to read. NULL, not 0. */
    commission: null,
    tips: pick(COLUMNS.tips),
    taxes: pick(COLUMNS.taxes),
    components: null,
    raw: r,
    ...(live ? { checked_at } : {}),
  };

  /* A WRITE THAT FAILS IS NOT AN ASK THAT FAILED, AND THE DIFFERENCE IS THE
     WHOLE ANSWER TO "DID WE SPEND THE LIMITER?".
     ─────────────────────────────────────────────────────────────────────────
     THE DEFECT. Both upserts used to throw straight out of this function, and
     the only caller that wraps them — POST /api/finance/payouts/verify — has a
     single catch that reports `the ask failed before Uber answered`. So a
     Postgres error here told the operator the opposite of what happened: Uber
     DID answer, one of its three report slots WAS spent, and the figure is sat
     in `row` ready to be read. The most likely trigger is the ordinary deploy
     order — the API restarts with code that writes `checked_at` a moment before
     sql/schema_v74.sql has replayed — which is exactly when somebody presses
     the button to see whether the deploy worked.

     Caught and RETURNED instead, so the shape stays honest: the parsed row
     travels with stored:false and a why that names the write. The route's
     stored===false branch, which could not fire while this threw, now can. */
  let stored = 0;
  let writeWhy = null;
  try {
    stored = await upsertMany('platform_account_day', [row],
      ['platform', 'fleet_id', 'day']);
  } catch (e) {
    writeWhy = `Uber answered and the register write failed: ${String(e?.message || e).slice(0, 180)}`;
    log.error(SRC, 'payout statement: write failed', { fleet: org.fleet, day, err: writeWhy });
  }

  /* A TRANSFER, not a day with a transfer column. Only a day whose bank
     column carries a non-zero figure becomes a payout row; a day with a
     blank column is a day Uber did not wire, and writing a zero payout for
     it would put 300 imaginary transfers a year in a table whose whole claim
     is that every row in it is a wire that happened. 0.005 rather than 0
     because the column is money to two decimals and a float comparison
     against exact zero is a coin toss on a value that arrived as text. */
  const amt = row.bank_transferred;
  let payout = null;
  if (amt != null && Math.abs(amt) > 0.005) {
    payout = {
      platform: SRC, fleet_id: org.fleet,
      /* No provider id on this surface — the statement names a period, not a
         transfer — so the key is the thing that identifies it: this platform,
         this fleet, this date. Stable across re-runs and across backfill
         order, which a row number would not be. */
      payout_ext_id: `${org.fleet}:${day}`,
      paid_on: day,
      /* Uber signs a payout negative — money leaving the account. Stored
         POSITIVE here, because platform_payout's claim is "this much reached
         the bank" and Bolt's rows are positive; a table whose sign depended on
         which provider filled the row would be summed wrongly by the first
         query that touched both. The provider's own sign is kept unflipped one
         table over, in platform_account_day. */
      amount: Math.abs(amt),
      currency: 'AED',
      ...settlesWeek(day),
      method: 'bank',
      source: `${REPORT_TYPE} (one-day window)`,
      raw: null,
    };
    try {
      await upsertMany('platform_payout', [payout],
        ['platform', 'fleet_id', 'payout_ext_id']);
      log.info(SRC, 'payout statement: a transfer',
        { fleet: org.fleet, day, amount: payout.amount, live });
    } catch (e) {
      /* Same rule as the statement write above: the wire was READ, so it is
         returned. What failed is the register, and the caller is told which. */
      writeWhy = writeWhy
        || `Uber answered and the payout register write failed: ${String(e?.message || e).slice(0, 180)}`;
      log.error(SRC, 'payout statement: payout write failed',
        { fleet: org.fleet, day, err: writeWhy });
    }
  }

  /* What the caller gets. `row` is Uber's own statement, signs unflipped, and
     carries every column POST /api/finance/payouts/verify reports under its
     "uber" key. `payout` is the register row if this day was a wire and null
     if it was not — null here is "Uber did not transfer on this day", which
     the route must not render as a transfer of zero. `stored` is how many
     statement rows reached the table, so a caller can tell a successful parse
     from a successful write. */
  await recordAsk(org, day, writeWhy ? 'refused' : 'stored', writeWhy, live);
  return { missing, row, payout, stored: stored > 0 && !writeWhy, checked_at, writeWhy };
}

/* MONDAYS FIRST, THEN OLDEST FIRST — the order the missing days are asked in.
   ─────────────────────────────────────────────────────────────────────────
   THE ORIGINAL ARGUMENT, WHICH STILL HOLDS AND IS NOT BEING DISCARDED.
   Oldest first and not newest first, deliberately. A backfill that starts at
   today walks backwards into history and an operator watching it sees the most
   recent week fill and then stall; starting at the oldest missing day means the
   record grows forwards and the newest day is always the one just added by the
   incremental. Today itself is excluded: a statement for a day still in
   progress would be stored as though it were final and then never asked again.

   WHAT THAT ORDER COST, MEASURED ON PRODUCTION 2026-09-17.
   The walk is bounded — DAYS_PER_RUN, 24 days per fleet per run — because a
   report takes 10–40 s and the payment limiter shuts for minutes. Strictly
   oldest-first spends that budget on whichever days happen to be oldest, and
   the days that carry a WIRE are one in seven. The count on the day this was
   written: uber/ecosine held 4 statement days (2026-08-17 .. 08-20) and one
   payout; uber/egari held 19 (08-17 .. 09-09) and two. Monday 2026-09-14 — the
   wire of 111,179.66 that settles the week the Payouts page is asked about
   most — was the TWENTY-FIFTH missing day for ecosine, one past the budget,
   so last night's run could not have reached it and neither could tonight's.
   It was worse than that in practice: Uber's report limiter cut last night's
   run to 4 of the 8 days it asked for, so the queue was moving at four days a
   night with the wires at the back of it.

   THE CHANGE, AND ITS EXACT SCOPE. Uber wires on Monday and only on Monday
   (see the five consecutive one-day reports at the top of this file), so
   ordering the missing set by "is this a Monday" before the date discovers
   every wire in the first few nights and then fills the ordinary days behind
   them, oldest first, exactly as before.

   THIS CHANGES WHICH DAYS ARE ASKED FIRST. IT DOES NOT CHANGE WHETHER ANY DAY
   IS ASKED. The WHERE clause is untouched: the set is still every day in the
   window with no statement row, the LIMIT still bounds one run and not the
   backfill, and a day pushed behind the Mondays is asked on a later night
   rather than dropped. Nothing is ever recorded as absent because the walk had
   not got to it — that is what collect()'s days_still_missing is for.

   EXTRACT(dow) IS 0=SUNDAY, 1=MONDAY IN POSTGRES, which is a convention worth
   getting wrong: ISODOW is 1=Monday..7=Sunday and DOW is 0=Sunday..6=Saturday,
   so the two agree on Monday and on nothing else. test/uber_payout_history.test.mjs
   asserts Postgres's own answer for a known Monday rather than trusting this
   sentence.

   The ORDER BY is a named constant so the test can assert the SHIPPED text
   instead of a copy of it that could drift from it silently. */
export const MISSING_DAYS_ORDER = '(EXTRACT(dow FROM a.d) = 1) DESC, a.d';

/* Exported for test/uber_payout_history.test.mjs, which pins the two things
   that decide whether a backfill converges: that the Mondays come first, and
   that a day already settled is never asked again. A copy of this query in a
   test would drift from it and stop testing anything. */
/* THE QUERY ITSELF, exported so a test can run it against PGlite.
   missingDays() below issues it through src/db.js's pool, which a PGlite test
   has no way to reach — so the function is not testable and the SQL is. Both
   use this one string, which is the point: a copy of it in a test would drift
   from the shipped query and quietly stop testing anything. */
export const MISSING_DAYS_SQL = `WITH asked AS (
       SELECT generate_series($2::date, LEAST($3::date, (now() AT TIME ZONE 'Asia/Dubai')::date - 1),
                              interval '1 day')::date AS d
     )
     SELECT a.d
       FROM asked a
       LEFT JOIN platform_account_day p
         ON p.platform = 'uber' AND p.fleet_id = $1 AND p.day = a.d AND p.basis = 'statement'
       /* AND THE DAYS ALREADY SETTLED WITHOUT A STATEMENT.
          ────────────────────────────────────────────────────────────────────
          A day Uber has nothing for stores no statement row, so the LEFT JOIN
          above leaves it missing and it comes back in every run's list for
          ever. Invisible while this walk only worked inside the month Uber
          does hold; fatal the moment the window widens to backfill, which is
          what it now does — 390 unasked days on ecosine and 378 on egari, any
          of which may predate the org.

          Only 'stored' and 'empty' settle a day. 'refused' — the limiter shut,
          the report timed out, the shape was not the one this module reads —
          learned nothing, so it stays in the list and is asked again. See
          sql/schema_v75.sql. */
       LEFT JOIN payout_ask k
         ON k.platform = 'uber' AND k.fleet_id = $1 AND k.day = a.d
        AND k.outcome IN ('stored', 'empty')
      WHERE p.day IS NULL AND k.day IS NULL
      ORDER BY ${MISSING_DAYS_ORDER}
      LIMIT $4`;

async function missingDays(org, from, to, limit) {
  const { rows } = await pool.query(MISSING_DAYS_SQL, [org.fleet, from, to, limit]);
  return rows.map((r) => dubaiIso(r.d));
}

/* How many days one run may spend. A report takes 10–40 s when the limiter is
   open and the limiter shuts for minutes when it is not, so a nightly run with
   an unbounded walk would still be running when the next one started. Bounded,
   and the run says how many are left — a backfill that needs a fortnight of
   nights is fine as long as nobody thinks it has finished. */
const DAYS_PER_RUN = Number(process.env.UBER_PAYOUT_DAYS_PER_RUN || 24);
/* What to do when the limiter says no. Measured: it stayed shut for several
   minutes after three concurrent asks, and opened again on its own. Backing
   off and giving up on THIS RUN is right — the days are still missing, the
   next run asks for them, and nothing is recorded as absent that was merely
   not asked. */
const THROTTLE_BACKOFF_MS = 45000;
const THROTTLE_GIVE_UP_AFTER = 3;

/* WHICH WEEK A MONDAY WIRE SETTLES — AND WHY THE ANCHOR IS NOON UTC.
   ─────────────────────────────────────────────────────────────────────────
   Uber's Monday wire settles the Mon–Sun week that ended the day before. That
   is worth recording because it is knowable, and only for the weekday it was
   proven on — a wire on any other day is left with a null period rather than
   given an invented one.

   ── THE "TO THE FILS" CLAIM THIS COMMENT USED TO MAKE IS WITHDRAWN ───────
   It read: "proven twice over consecutive weeks: wire(N) = closing balance(N-1)
   = opening balance(N), to the fils." Two Mondays were measured when that was
   written. A third is now measurable, and it disagrees. Every Ecosine Monday
   this collector can currently see, live from Uber:

     Monday        opening balance      wire           difference
     2026-08-17      57,791.73        57,810.41    wire  18.68 ABOVE opening
     2026-09-07     103,567.54       103,567.54    exact
     2026-09-14     111,279.92       111,179.66    wire 100.26 BELOW opening

   One of three is exact, and the other two miss in opposite directions, which
   rules out a fee or a rounding rule and points at movements Uber books after
   the Sunday close — an adjustment, a refund, a late trip — landing on either
   side of the transfer. Two consecutive agreements were a sample, not a proof;
   the third Monday is what a sample of two is for.

   WHAT SURVIVES AND WHAT DOES NOT. The CADENCE survives and is what this
   function stamps: the Monday wire settles the preceding Mon–Sun week, on all
   three. The EQUALITY does not, and must stop being stated as proven anywhere
   it is stated — this comment and api/public/payouts.js were both saying it.
   A page that tells an operator the wire equals the previous week's closing
   balance to the fils is telling them a difference of 100.26 is an error in
   our books, when on this evidence it is a normal Monday.

   Note what this does NOT touch: period_start and period_end are the week the
   wire settles, and they are right on all three. Nothing below changes.

   THIS WAS WRITTEN WITH A BUG THAT MADE IT DO EXACTLY NOTHING, AND THE BUG IS
   WORTH KEEPING DESCRIBED BECAUSE IT LOOKS RIGHT. The test was

     new Date(`${day}T00:00:00+04:00`).getUTCDay() === 1

   and `${day}T00:00:00+04:00` IS the correct instant for Dubai midnight. It is
   also 20:00 on the PREVIOUS UTC day, and getUTCDay() asks UTC what day it is
   — so it answered the day before. Measured on the very wire this module was
   built to capture: 2026-09-07 is a Monday and carried Ecosine's AED
   103,567.54, and getUTCDay() on that parse returns 0.

   So the branch was FALSE on every real wire. Every Monday payout row was
   written with period_start = period_end = NULL, and api/public/payouts.js
   then rendered "not stated", with the tooltip "this provider does not say
   which period a transfer settles" — a sentence that is false for Uber and
   true for nobody. The mirror was live too: the branch fired only on a Dubai
   TUESDAY, where it would have stamped a Tue–Mon span, which is precisely the
   invented period the paragraph above forbids.

   The fix anchors at NOON UTC, the idiom already used at api/public/day.js:176
   and api/public/performers.js:58: midday is far enough from either midnight
   that no offset in use can move it across a date boundary, so the weekday it
   reports is the weekday of the calendar date rather than of an instant.

   It is a named, exported, pure function rather than an inline spread because
   the inline version could not be asserted: test/payout_register.test.mjs was
   INSERTing period_start by hand and proving nothing about this code at all.
   Mutating the old expression (=== 1 to === 9) left the suite green at 44/0. */
export const settlesWeek = (day) => {
  const noon = Date.parse(`${String(day).slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(noon) || new Date(noon).getUTCDay() !== 1) return {};
  return {
    period_start: dubaiIso(new Date(noon - 7 * 864e5)),
    period_end: dubaiIso(new Date(noon - 864e5)),
  };
};

export async function collect({ from, to, mode, fleet = null }) {
  /* Never on the incremental. One report per day per fleet against a limiter
     this tight, every thirty minutes, would spend the whole allowance on days
     that are already stored and starve the trip and earnings walks that share
     the session. */
  if (mode === 'incremental') return;

  for (const org of uberOrgs(fleet)) {
    const fails = [];
    let written = 0;
    let asked = 0;
    let remaining = null;
    try {
      /* THE WALK REACHES BACK AS FAR AS THE FLEET HAS WORKED, NOT AS FAR AS
         THE RUN WINDOW.
         ─────────────────────────────────────────────────────────────────────
         THE DEFECT. This asked missingDays() over the caller's window, and the
         only caller that reaches here is the nightly catch-up, whose window is
         thirty days. So the record could never grow backwards: anything older
         than a month was reachable only by the Sunday backfill, and on
         2026-09-17 that left uber/ecosine with 390 unasked days and uber/egari
         with 378 while the page's whole purpose was to show past payments.

         The floor is the earliest day this fleet has an Uber TRIP for, which
         is the honest bound: a statement for a day before the fleet was
         earning is a day Uber has nothing for, and asking for it is a report
         slot spent to learn nothing. Where there are no trips at all the
         caller's window stands, so a fleet with no Uber history behaves
         exactly as it did.

         It costs nothing per run. DAYS_PER_RUN still caps the work; widening
         the window changes WHICH days are eligible, not how many are asked.
         And sql/schema_v75.sql is what makes it safe to widen at all — without
         payout_ask, every dead day in a year of history would be re-asked on
         every run for ever. */
      const [floor] = (await pool.query(
        `SELECT min((requested_at AT TIME ZONE 'Asia/Dubai')::date)::text AS d
           FROM trip WHERE platform = 'uber' AND fleet_id = $1`, [org.fleet])).rows;
      const walkFrom = floor?.d && floor.d < String(from).slice(0, 10)
        ? floor.d : from;
      const days = await missingDays(org, walkFrom, to, DAYS_PER_RUN + 1);
      remaining = Math.max(0, days.length - DAYS_PER_RUN);
      const todo = days.slice(0, DAYS_PER_RUN);
      let throttles = 0;

      for (const day of todo) {
        const res = await oneDay(org, day);
        asked += 1;
        if (res.throttled) {
          throttles += 1;
          if (throttles >= THROTTLE_GIVE_UP_AFTER) {
            /* Named as what it is. "Uber's payment-report limiter is shut" and
               "Uber has no statement for these days" are different sentences
               and only one of them is true here. */
            fails.push(`payment-report limiter shut after ${written} of ${todo.length} days — `
              + 'the remaining days are still missing and the next run asks for them');
            break;
          }
          log.warn(SRC, `payout statement: limiter shut, backing off`,
            { fleet: org.fleet, day, attempt: throttles });
          await sleep(THROTTLE_BACKOFF_MS);
          continue;
        }
        if (!res.row) {
          fails.push(`${day}: ${String(res.why).slice(0, 180)}`);
          continue;
        }
        throttles = 0;
        if (res.missing?.length) {
          log.warn(SRC, 'payout statement: columns absent from the report',
            { fleet: org.fleet, day, missing: res.missing.join(', ') });
        }
        /* THE WRITE MOVED INTO oneDay() AND IS NOT REPEATED HERE.
           It used to be these thirty lines: upsert the statement day, then
           decide whether the bank column names a transfer and upsert the
           register row if it does. POST /api/finance/payouts/verify needs the
           identical behaviour from the API process, and the only way two
           processes can be relied on to write the same day the same way is for
           there to be one copy of the rule. oneDay() has it; this loop now
           counts what it did and reports the run. */
        written += res.stored ? 1 : 0;
      }

      await logRun({ source: SRC, fleet_id: org.fleet, mode: `${mode}:payout`,
        window_start: from, window_end: to,
        status: fails.length === 0 ? 'ok' : (written > 0 ? 'partial' : 'error'),
        rows_written: written,
        error: fails.length ? fails.join('; ').slice(0, 500) : null });
      log[fails.length ? 'warn' : 'info'](SRC, 'payout statements done', {
        fleet: org.fleet, days_written: written, days_asked: asked,
        /* Said out loud, every run. A bounded walk that does not report its
           own remainder reads as "finished" to everyone who is not counting. */
        days_still_missing: remaining, failed: fails.length || undefined });
    } catch (e) {
      await logRun({ source: SRC, fleet_id: org.fleet, mode: `${mode}:payout`,
        window_start: from, window_end: to, status: 'error', rows_written: written,
        error: [String(e), ...fails].join('; ').slice(0, 500) });
      log.error(SRC, 'payout statements failed', { fleet: org.fleet, err: String(e) });
    }
  }
}
