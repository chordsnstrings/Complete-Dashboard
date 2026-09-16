/* UBER'S OWN BOOKS, ONE DAY AT A TIME — the exact wire, on the exact date.
   ─────────────────────────────────────────────────────────────────────────
   The dashboard has shown a figure called "bank payout" since reconciliation
   was built and it has never been one. api/reconcile_routes.js sums
   driver_payout_day.earnings by month and names the total bank_payout: that is
   Uber's weekly PER-DRIVER earnings spread over the days they were earned. A
   real quantity, and not a transfer. Measured on the closed week Mon 7 – Sun
   13 Sep 2026 for Ecosine, the dashboard says 110,962.09 and Uber's own books
   say the wire was 103,567.54 — 7.1% apart, describing different events.

   REPORT_TYPE_PAYMENTS_ORGANIZATION is the statement. One row per org per
   window, twenty-one columns, including `Payouts : Transferred To Bank
   Account`, which is the literal wire. Asked for the whole week it closes to
   the fils:

     start 103,567.54 + earnings 125,745.05 + refunds 6,985.26
           - cash 21,450.39 - bank 103,567.54 = end 111,279.92

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

   So Uber wires on MONDAY, and it wires the closing balance of the week that
   ended the day before — 103,567.54 was both the Monday transfer and the
   Sunday closing balance of 31 Aug – 6 Sep. A week's report gives the amount.
   Only a day's report gives the date, and the date is the question.

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

/* One report, one day, one org. Returns the mapped row, or a reason.
   Never throws for a provider refusal: a limiter that is shut is a fact about
   this minute, not about the day being asked, and a throw here would abandon
   the other twenty days of the walk. */
async function oneDay(org, day) {
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
  if (!url) return { why: `report did not finish generating within 180s (a timeout, not a refusal)` };

  const { data: csv } = await http(url, { expect: 'text', timeoutMs: 120000 });
  const recs = parse(String(csv), { columns: true, skip_empty_lines: true, bom: true });
  if (!recs.length) return { why: 'the report generated and contains no rows' };

  /* ONE ROW PER ORG, and childOrgUuids names exactly one, so more than one row
     means the request meant something other than what this module thinks it
     means. Refused rather than summed: silently adding two orgs' balances
     together would produce a plausible number nobody could trace. */
  if (recs.length > 1) {
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
    return { why: `the report has no "${COLUMNS.bank_transferred}" column — `
      + `has Uber renamed it? Columns: ${[...byKey.keys()].slice(0, 24).join(' | ')}` };
  }
  const pick = (path) => (byKey.has(path) ? money(r[byKey.get(path)]) : null);

  return {
    missing,
    row: {
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
    },
  };
}

/* Which Dubai days this fleet has no statement for yet, oldest first.
   ─────────────────────────────────────────────────────────────────────────
   Oldest first and not newest first, deliberately. A backfill that starts at
   today walks backwards into history and an operator watching it sees the
   most recent week fill and then stall; starting at the oldest missing day
   means the record grows forwards and the newest day is always the one just
   added by the incremental. Today itself is excluded: a statement for a day
   still in progress would be stored as though it were final and then never
   asked again. */
async function missingDays(org, from, to, limit) {
  const { rows } = await pool.query(
    `WITH asked AS (
       SELECT generate_series($2::date, LEAST($3::date, (now() AT TIME ZONE 'Asia/Dubai')::date - 1),
                              interval '1 day')::date AS d
     )
     SELECT a.d
       FROM asked a
       LEFT JOIN platform_account_day p
         ON p.platform = 'uber' AND p.fleet_id = $1 AND p.day = a.d AND p.basis = 'statement'
      WHERE p.day IS NULL
      ORDER BY a.d
      LIMIT $4`,
    [org.fleet, from, to, limit]);
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
   Uber's Monday wire settles the Mon–Sun week that ended the day before,
   proven twice over consecutive weeks: wire(N) = closing balance(N-1) =
   opening balance(N), to the fils. That is worth recording because it is
   knowable, and only for the weekday it was proven on — a wire on any other
   day is left with a null period rather than given an invented one.

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
      const days = await missingDays(org, from, to, DAYS_PER_RUN + 1);
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
        written += await upsertMany('platform_account_day', [res.row],
          ['platform', 'fleet_id', 'day']);

        /* A TRANSFER, not a day with a transfer column. Only a day whose bank
           column carries a non-zero figure becomes a payout row; a day with a
           blank column is a day Uber did not wire, and writing a zero payout
           for it would put 300 imaginary transfers a year in a table whose
           whole claim is that every row in it is a wire that happened. */
        const amt = res.row.bank_transferred;
        if (amt != null && Math.abs(amt) > 0.005) {
          /* Uber signs a payout negative — money leaving the account. Stored
             POSITIVE here, because platform_payout's claim is "this much
             reached the bank" and Bolt's rows are positive; a table whose sign
             depended on which provider filled the row would be summed wrongly
             by the first query that touched both. The provider's own sign is
             kept unflipped one table over, in platform_account_day. */
          await upsertMany('platform_payout', [{
            platform: SRC, fleet_id: org.fleet,
            /* No provider id on this surface — the statement names a period,
               not a transfer — so the key is the thing that identifies it:
               this platform, this fleet, this date. Stable across re-runs and
               across backfill order, which a row number would not be. */
            payout_ext_id: `${org.fleet}:${day}`,
            paid_on: day,
            amount: Math.abs(amt),
            currency: 'AED',
            ...settlesWeek(day),
            method: 'bank',
            source: `${REPORT_TYPE} (one-day window)`,
            raw: null,
          }], ['platform', 'fleet_id', 'payout_ext_id']);
          log.info(SRC, 'payout statement: a transfer', { fleet: org.fleet, day, amount: Math.abs(amt) });
        }
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
