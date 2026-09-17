/* ── the transaction ledger, read to CHECK the wire register ───────────────
   WHAT THIS IS AND WHAT IT IS NOT. It is not a faster way to build the
   register. src/sources/uber_payout.js builds that from
   REPORT_TYPE_PAYMENTS_ORGANIZATION, one day at a time, Mondays first — and
   measured on production 2026-09-17 that walk found twenty payout dates across
   seventeen months (2025-04-07 to 2026-09-14) and every single one is a MONDAY.

   Which makes "Uber wires on a Monday" very likely and NOT CHECKED, and the
   walk cannot check it: it asks Mondays first precisely because that is where
   wires are, so a wire on a Thursday is the last thing it would reach — or, in
   any period it has not finished, the thing it never reaches at all. An
   operator reading a complete-looking register cannot tell those apart, and
   this product's whole discipline is that an absence must say which kind it is.

   REPORT_TYPE_PAYMENTS_ORDER answers it, because it is a different shape of
   report. Probed on production 2026-09-17:

     - PER TRANSACTION, not one aggregate row: 399+ rows for a single day.
     - The wire IS one of those rows. `Description` carries 'so.payout' beside
       'trip completed order', and the row's
       'Paid to you:Trip balance:Payouts:Transferred To Bank Account' held
       exactly -111,179.66 on 2026-09-14 — the figure the operator confirmed
       against their own bank statement.
     - EVERY ROW IS DATED, by a column named 'vs reporting': 399 of 399 values
       date-like, its range for a one-day window is that day, and for
       2026-09-07..14 the sampled rows are 2026-09-07.

   So one report over a window names every wire in it, with its date, whatever
   weekday it fell on. That is the audit.

   WHY IT IS NOT USED FOR THE BACKFILL ITSELF. Generation cost scales with the
   TRANSACTIONS in the window, not with the number of requests: an eight-day
   report took about thirteen minutes to generate, roughly 1.6 minutes per day
   of data, against 1.7–2.4 minutes per day for a one-day organisation ask. So
   a year of ORDER means generating a year of transaction rows however it is
   chunked, while a year of Mondays asks for fifty-six days of data. Asking
   less beats asking less often. This runs rarely, off the hot path, and proves
   the cheap walk was right. */
import { http } from '../http.js';
import { upsertMany, pool } from '../db.js';
import { log } from '../log.js';
import { dubaiIso } from '../util.js';
import { uberWebHeaders, UBER_WEB_HOST } from '../auth/uber.js';
import { uberOrgs } from './uber.js';
import { pathKey, COLUMNS, money } from './uber_payout.js';
import { parse } from 'csv-parse/sync';

const SRC = 'uber';
const REPORTS = `${UBER_WEB_HOST}/api/vs-sp-reports-management`;
export const ORDER_REPORT = 'REPORT_TYPE_PAYMENTS_ORDER';
const RATE_LIMITED = /rate-limited|generation limit|too many ongoing|in progress/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The three columns this module reads, by their folded header. pathKey() is
   src/sources/uber_payout.js's — one spelling rule for both reports, so a
   provider that re-spaces a header breaks both or neither. */
export const ORDER_COLUMNS = Object.freeze({
  description: 'description',
  at: 'vs reporting',
  bank: 'paid to you:trip balance:payouts:transferred to bank account',
});
/* The Description value that marks a transfer. Every other row in the report
   is a trip, an adjustment or a business order. */
export const PAYOUT_MARK = 'so.payout';

/* A MONTH IS THE UNIT, and the reason is generation time rather than taste.
   An eight-day report took ~13 minutes; a month is the largest window that has
   a chance of finishing inside a sane budget while still covering enough
   calendar to be worth the slot. Configurable because the fleet's transaction
   volume is what actually decides it, and that grows. */
const AUDIT_DAYS = Number(process.env.UBER_PAYOUT_AUDIT_DAYS || 31);
/* Generously longer than the one-day walk's 180 s: this report is two orders
   of magnitude more rows and the measured eight-day generation was 13 minutes.
   A timeout here is a TIMEOUT — the window stays un-audited and is asked
   again — and never a statement that the window is clean. */
const AUDIT_DEADLINE_MS = Number(process.env.UBER_PAYOUT_AUDIT_DEADLINE_MS || 900000);

const monthsBack = (n) => {
  const d = new Date(Date.now() - n * 864e5);
  return dubaiIso(d);
};

/* WHICH WINDOW TO AUDIT NEXT, newest first.
   ─────────────────────────────────────────────────────────────────────────
   The backfill walk fills OLDEST first, deliberately: a hole in the middle of
   the record is worse than a short tail. The audit is the opposite question —
   "is what we are showing right?" — and what is being shown is the recent
   months. So it works backwards from today, one window per run, skipping the
   windows already audited. A window whose audit was REFUSED is not skipped:
   nothing was learned about it. */
export async function nextWindow(org, { days = AUDIT_DAYS, horizon = 400 } = {}) {
  const { rows } = await pool.query(
    `WITH edges AS (
       SELECT generate_series(
                ((now() AT TIME ZONE 'Asia/Dubai')::date - $2::int),
                ((now() AT TIME ZONE 'Asia/Dubai')::date - $3::int),
                ($3::int || ' days')::interval)::date AS s
     )
     SELECT to_char(e.s, 'YYYY-MM-DD') AS period_start,
            to_char(LEAST(e.s + ($3::int - 1), (now() AT TIME ZONE 'Asia/Dubai')::date - 1),
                    'YYYY-MM-DD') AS period_end
       FROM edges e
       LEFT JOIN payout_audit a
         ON a.platform = 'uber' AND a.fleet_id = $1
        AND a.period_start = e.s AND a.outcome = 'audited'
      WHERE a.period_start IS NULL
        AND e.s <= (now() AT TIME ZONE 'Asia/Dubai')::date - 1
      ORDER BY e.s DESC
      LIMIT 1`,
    [org.fleet, horizon, days]);
  return rows[0] || null;
}

const record = async (org, w, outcome, detail, found = null, added = null) => {
  try {
    await upsertMany('payout_audit', [{
      platform: SRC, fleet_id: org.fleet,
      period_start: w.period_start, period_end: w.period_end,
      outcome, detail: detail ? String(detail).slice(0, 300) : null,
      wires_found: found, wires_new: added,
      audited_at: new Date().toISOString(),
    }], ['platform', 'fleet_id', 'period_start', 'period_end']);
  } catch (e) {
    log.warn(SRC, 'payout audit: could not record the window',
      { fleet: org.fleet, ...w, err: String(e?.message || e).slice(0, 140) });
  }
};

/** Read one window of the transaction ledger and reconcile its so.payout rows
    against the register. Returns what it found, or { why } and nothing else. */
export async function auditWindow(org, w) {
  const gen = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`, {
    method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(org),
    body: JSON.stringify({
      orgId: { uuid: { value: org.orgUuid } }, reportType: ORDER_REPORT,
      startDate: { value: w.period_start }, endDate: { value: w.period_end },
      childOrgUuids: [{ uuid: { value: org.orgUuid } }],
    }),
  });
  if (gen.data?.status !== 'success') {
    const detail = JSON.stringify(gen.data?.data?.meta?.details || gen.data).slice(0, 240);
    await record(org, w, 'refused', detail);
    return { throttled: RATE_LIMITED.test(detail), why: detail };
  }
  const id = gen.data.data.reportId.uuid.value;

  let url = null;
  const deadline = Date.now() + AUDIT_DEADLINE_MS;
  let wait = 8000;
  while (!url && Date.now() < deadline) {
    const { data } = await http(`${REPORTS}/DownloadReport?localeCode=en-GB`, {
      method: 'POST', timeoutMs: 30000, retries: 0, headers: uberWebHeaders(org),
      body: JSON.stringify({ orgId: { uuid: { value: org.orgUuid } },
        reportId: { uuid: { value: id } } }),
    });
    url = data?.data?.signedUrl?.value;
    if (!url) { await sleep(wait); wait = Math.min(wait * 1.3, 30000); }
  }
  if (!url) {
    const why = `report did not finish generating within ${Math.round(AUDIT_DEADLINE_MS / 1000)}s `
      + '(a timeout, not a refusal — the window stays un-audited and is asked again)';
    await record(org, w, 'refused', why);
    return { why };
  }

  const { data: csv } = await http(url, { expect: 'text', timeoutMs: 180000 });
  const recs = parse(String(csv), { columns: true, skip_empty_lines: true, bom: true });

  /* THE HEADER IS FOLDED ONCE AND LOOKED UP, never matched loosely. A column
     that is ABSENT is a shape change and must stop the audit, because a
     so.payout row read without its bank column would be a wire of nothing. */
  const keyed = new Map();
  for (const k of Object.keys(recs[0] || {})) keyed.set(pathKey(k), k);
  const missing = Object.entries(ORDER_COLUMNS)
    .filter(([, v]) => !keyed.has(v)).map(([k]) => k);
  if (missing.length) {
    const why = `the report is missing ${missing.join(', ')} — this is a shape change in `
      + `${ORDER_REPORT}, not an empty window, and nothing was read from it`;
    await record(org, w, 'refused', why);
    return { why };
  }

  const wires = [];
  for (const r of recs) {
    const desc = String(r[keyed.get(ORDER_COLUMNS.description)] || '').trim().toLowerCase();
    if (desc !== PAYOUT_MARK) continue;
    const at = String(r[keyed.get(ORDER_COLUMNS.at)] || '').slice(0, 10);
    const amt = money(r[keyed.get(ORDER_COLUMNS.bank)]);
    /* A so.payout row whose bank column is blank or unreadable is not a wire
       of zero — it is a row this module cannot interpret, and it is reported
       rather than counted. */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || amt == null || !amt) continue;
    wires.push({ day: at, amount: Math.abs(amt) });
  }

  /* One row per DAY. A day with two so.payout lines is summed, because the
     register's unit is the transfer that reached the bank on a date and two
     lines on one date are one day's money — and the sum is what the
     organisation statement's own bank column would have shown for that day. */
  const byDay = new Map();
  for (const x of wires) byDay.set(x.day, (byDay.get(x.day) || 0) + x.amount);

  let added = 0;
  let disagreed = 0;
  for (const [day, amount] of byDay) {
    const extId = `${org.fleet}:${day}`;
    const { rows: [have] } = await pool.query(
      `SELECT amount::float8 AS amount FROM platform_payout
        WHERE platform = 'uber' AND fleet_id = $1 AND payout_ext_id = $2`,
      [org.fleet, extId]);
    const rounded = Math.round(amount * 100) / 100;
    if (!have) {
      /* A WIRE THE REGISTER DID NOT HOLD. This is the case the audit exists
         for — a transfer on a day the Mondays-first walk had not reached, or
         would never have reached. */
      added += 1;
      await upsertMany('platform_payout', [{
        platform: SRC, fleet_id: org.fleet, payout_ext_id: extId, paid_on: day,
        amount: rounded, currency: 'AED', method: 'bank',
        source: `${ORDER_REPORT} (so.payout row, dated by "${ORDER_COLUMNS.at}")`,
        audit_amount: rounded, audited_at: new Date().toISOString(),
      }], ['platform', 'fleet_id', 'payout_ext_id']);
      log.warn(SRC, 'payout audit: a wire the register did not hold',
        { fleet: org.fleet, day, amount: rounded });
      continue;
    }
    if (Math.abs(Number(have.amount) - rounded) >= 0.01) disagreed += 1;
    /* NEVER an overwrite of `amount`. Two Uber reports disagreeing about one
       transfer is a finding, and resolving it by writing order would destroy
       the only evidence that they disagree. Both travel, and the page says so. */
    await upsertMany('platform_payout', [{
      platform: SRC, fleet_id: org.fleet, payout_ext_id: extId,
      audit_amount: rounded, audited_at: new Date().toISOString(),
    }], ['platform', 'fleet_id', 'payout_ext_id']);
  }

  await record(org, w, 'audited',
    disagreed ? `${disagreed} wire(s) disagree with the register` : null,
    byDay.size, added);
  log.info(SRC, 'payout audit: window read',
    { fleet: org.fleet, ...w, rows: recs.length, wires: byDay.size, added, disagreed });
  return { found: byDay.size, added, disagreed, rows: recs.length };
}

/** One window per fleet per run, newest un-audited first. */
export async function collect({ fleet = null } = {}) {
  for (const org of uberOrgs(fleet)) {
    try {
      const w = await nextWindow(org);
      if (!w) { log.info(SRC, 'payout audit: nothing left to audit', { fleet: org.fleet }); continue; }
      const res = await auditWindow(org, w);
      if (res.why) {
        log.warn(SRC, 'payout audit: window refused',
          { fleet: org.fleet, ...w, why: String(res.why).slice(0, 160) });
      }
    } catch (e) {
      log.error(SRC, 'payout audit failed', { fleet: org.fleet, err: String(e).slice(0, 200) });
    }
  }
}

export { monthsBack };
