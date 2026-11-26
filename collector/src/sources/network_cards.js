/* CARD-MACHINE PAYMENTS — Network International, read from the sheet the
   operator's team keeps (FIX-STATUS CARD-1, 2026-11-23).
   ─────────────────────────────────────────────────────────────────────────
   Drivers take real cash and card payments on card machines. The sheet lists
   every card payment: the driver's Emirates ID (or "Not Found" / "N/A" where
   no driver was mapped to the terminal that day), the day, the fleet
   (Ecosine / Egari, in a column headed "Platform"), the terminal id and the
   amount. The operator: "This shows how much was in card machine. The rest
   is real cash still left in the driver."

   Decisions the operator made (2026-11-23), held here:
     · read the sheet directly, every hour (option b) — src/google_sheets.js;
     · a negative amount is a CHARGEBACK and is kept signed: "the negative
       amounts are chargebacks. so the calculations are correct", and "fare
       isn't lost. it usually comes back";
     · amounts over AED 1,000 are real ("the amounts are real") and kept;
     · terminals move between drivers ("they aren't fixed, terminals
       change"), so a payment is placed by the sheet's own Emirates ID, never
       by the car, and the terminal id stays on it for tracing back.

   ONE READ IS THE WHOLE SHEET, AND REPLACES WHAT IS STORED. The sheet is one
   running list with no transaction reference, so there is nothing to append
   by. The first build replaced only the days between a read's first and last
   payment; the review of 2026-11-23 showed what that leaves behind — a row
   dated 2026-12-01 by mistake widens the range, and once corrected its stored
   copy sits outside the next read's days forever, and a last-day row re-dated
   one day earlier is kept twice. So a read replaces every stored payment from
   this source, in one transaction. Identical rows are separate payments, as
   the sheet's own total counts them.

   THE GUARD, by the whole and by the month. A read is HELD, not written, when
   it would keep fewer than 90% of the stored payments overall, OR fewer than
   90% of any month holding at least 20 (a deleted month is ~9% of a year's
   sheet, which the overall share alone let through), OR when it is empty or
   every row is unreadable. A sheet half-cleared while someone edits it, or a
   filter left on, must not wipe a month. The hold is recorded (card_import
   status 'held', with the counts and the months) and the pages say so;
   `node src/index.js network-cards --accept-shrink` writes it once a person
   has looked.

   ONE READ AT A TIME, across processes. `cardsBusy` (src/run.js) holds within
   one worker only; a by-hand run, or the old and new worker overlapping in a
   deploy, is a second process, and under READ COMMITTED two overlapping
   replaces each keep their own insert — every payment doubled, and the guard
   then holding every later read. So the write takes a transaction-scoped
   advisory lock first and counts what is stored only after it holds it.

   Nothing here moves a money figure: the cash position is unchanged until
   phase 3 (FIX-STATUS CARD-3), which waits on the operator's review. */
import { get } from '../settings.js';
import { logRun } from '../db.js';
import { noteCredential } from '../auth_state.js';
import { log as defaultLog } from '../log.js';
import { parse as parseCsv } from 'csv-parse/sync';
import { parseServiceAccount, readValues, readCsvByLink, sheetFromLink } from '../google_sheets.js';
import { refreshFares } from '../card_fares.js';
import * as niReports from './ni_reports.js';
const sheetFromLinkSafe = (l) => { try { return sheetFromLink(l); } catch { return null; } };
/* CARD-3: the fares the payments are measured against, summed per account and
   day (src/card_fares.js). They come from the trips, not the sheet, so they
   are refreshed after every read whether the read worked or not — a sheet
   that stops answering must not freeze the cash side too. A failure here is
   logged and never costs the read. */
async function faresAfterRead(db, now, log) {
  const fares = await refreshFares(db, { now, log }).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
  if (fares.error) log.warn(SOURCE, 'fares refresh failed', { err: fares.error });
  return fares;
}

export const SOURCE = 'network_cards';
export const KEEP_SHARE = 0.9;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const validDay = (y, m, d) => {
  if (!(y >= 2024 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
};
/* "1-Jan-2026" as the sheet shows it; also 2026-01-01, 01/01/2026 (day
   first, the UAE way) and a spreadsheet serial number, in case a cell's
   format changes. Anything else is not a day, and the row is counted out. */
export function dayOf(v, slashOrder = 'dmy') {
  if (typeof v === 'number' && Number.isFinite(v) && v > 40000 && v < 80000) {
    const t = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
    return validDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  }
  const s = String(v ?? '').trim();
  let m = /^(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return validDay(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    if (slashOrder === 'mdy') return validDay(+m[3], +m[1], +m[2]);
    if (slashOrder === 'dmy') return validDay(+m[3], +m[2], +m[1]);
    return null;   // the sheet's own dates cannot tell day from month
  }
  return null;
}

/* WHICH WAY A SHEET WRITES ITS SLASH DATES (the review of 2026-11-23). The
   CSV export carries a date as the sheet DISPLAYS it — "1-Jan-2026" today,
   unambiguous. Should the display become 5/11/2026, the column itself must
   say whether that is 5 November or 11 May: a first part over 12 proves
   day-first, a second part over 12 proves month-first. If neither ever
   happens (or both do), the slash dates are left unread and counted — never
   guessed, because a wrong guess moves a payment to another month. */
export function slashOrderOf(cells) {
  let dayFirst = false; let monthFirst = false;
  for (const c of cells) {
    const m = /^(\d{1,2})\/(\d{1,2})\/\d{4}$/.exec(String(c ?? '').trim());
    if (!m) continue;
    if (+m[1] > 12) dayFirst = true;
    if (+m[2] > 12) monthFirst = true;
  }
  return dayFirst && !monthFirst ? 'dmy' : monthFirst && !dayFirst ? 'mdy' : 'unknown';
}

const FLEETS = { ecosine: 'ecosine', egari: 'egari' };
const norm = (h) => String(h ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
const COLUMNS = {
  eid: ['emiratesid', 'eid', 'emiratesidno'],
  day: ['date', 'day', 'trandate', 'transactiondate'],
  fleet: ['platform', 'fleet', 'company'],
  terminal: ['trmnlid', 'terminalid', 'terminal', 'tid'],
  amount: ['tranamt', 'amount', 'transactionamount', 'amt'],
};

/* The sheet's rows → payments, and a count of every row left out by reason.
   Column positions come from the header row, so a column added or moved in
   the sheet does not shift the reading; the first of two "Date" columns is
   the one that is filled. */
export function parseSheet(values) {
  const rows = Array.isArray(values) ? values : [];
  const hi = rows.findIndex((r) => Array.isArray(r) && r.some((c) => COLUMNS.terminal.includes(norm(c))));
  if (hi < 0) return { payments: [], skipped: {}, rows_read: rows.length, missing: ['the header row (no "TRMNL ID" column)'] };
  const head = rows[hi].map(norm);
  const col = {};
  for (const [k, names] of Object.entries(COLUMNS)) col[k] = head.findIndex((h) => names.includes(h));
  const missing = Object.entries(col).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) return { payments: [], skipped: {}, rows_read: rows.length - hi - 1, missing };
  const payments = []; const skipped = {};
  const out = (why) => { skipped[why] = (skipped[why] || 0) + 1; };
  const order = slashOrderOf(rows.slice(hi + 1).map((r) => (r || [])[col.day]));
  for (let i = hi + 1; i < rows.length; i += 1) {
    const r = rows[i] || [];
    const cell = (k) => r[col[k]];
    if (![cell('eid'), cell('day'), cell('terminal'), cell('amount')].some((c) => String(c ?? '').trim())) continue;
    const day = dayOf(cell('day'), order);
    if (!day) {
      out(order === 'unknown' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(String(cell('day') ?? '').trim())
        ? 'a slash date whose day and month cannot be told apart' : 'no readable day');
      continue;
    }
    const fleet = FLEETS[norm(cell('fleet'))];
    if (!fleet) { out('fleet not Ecosine or Egari'); continue; }
    const terminal = String(cell('terminal') ?? '').trim().replace(/\.0+$/, '');
    if (!terminal) { out('no terminal id'); continue; }
    const rawAmt = cell('amount');
    const amount = typeof rawAmt === 'number' ? rawAmt : Number(String(rawAmt ?? '').replace(/[,\s]|AED/gi, ''));
    if (!Number.isFinite(amount) || String(rawAmt ?? '').trim() === '') { out('amount not a number'); continue; }
    const rawId = String(cell('eid') ?? '').trim();
    const digits = rawId.replace(/\D/g, '');
    let eid = null; let label = null;
    if (/^784\d{12}$/.test(digits)) eid = digits;
    else if (digits.length >= 6) label = 'unreadable Emirates ID';      // never stored: a typo of a real one is still one
    else label = rawId ? rawId.slice(0, 40) : 'no driver named';
    payments.push({ row_no: i + 1, txn_day: day, fleet_id: fleet, terminal_id: terminal.slice(0, 40),
      amount: Math.round(amount * 100) / 100, emirates_id: eid, id_label: label });
  }
  return { payments, skipped, rows_read: rows.length - hi - 1, missing: [] };
}

const sum = (xs) => Math.round(xs.reduce((a, p) => a + p.amount, 0) * 100) / 100;

/* AMOUNTS FROM THE BANK'S REPORT, THE DRIVER FROM THE SHEET (FIX-STATUS NIR;
   the operator, 2026-11-26: "for POS terminal mapping use the sheet. For the
   amount use the [emailed report]").
   ─────────────────────────────────────────────────────────────────────────
   A fleet-day takes the bank's transactions only when a usable report covers
   it AND THE SHEET ALREADY HAS THAT FLEET-DAY. Until the team has typed the
   day in, the bank's rows wait and nothing about the day changes — so the
   cash texts, which wait for the sheet's day (CARD-4, driver_sms.js), wait
   exactly as before. Every other day keeps the sheet's rows: all of history
   before the reports began.

   NO DRIVER IS GUESSED (the two reviews of 2026-11-26). A bank payment takes
   a driver only from the sheet's own row for that payment:
     1. the sheet's row for the same terminal, day and amount ('sheet_same_payment');
        on the report's day, or else — a late payment the team filed under the
        bank's own date — on that date;
     2. else an unmatched sheet row on that terminal that day when EVERY such
        row is the same driver's, paired smallest difference first across the
        terminal-day and only within AED 5 or 5% ('sheet_same_terminal_day': the
        sheet lists the payment, typed with another amount). Per payment in
        reference order, and unbounded, it once credited a driver an unlisted
        70 for a 50 typed for a 55 (the third review);
     3. else, when several drivers' rows are unmatched on that terminal that
        day, or one driver's row is left unmatched beyond that difference, the
        sheet cannot say whose the payment is: THAT TERMINAL-DAY STAYS AS THE
        SHEET HAS IT — its unmatched sheet rows are kept, and the
        bank's unmatched payments there are not written ('held'). Writing them
        with nobody would drop every one of those drivers' sheet rows, and
        each would be texted for a card payment they did make;
     4. else nobody ('none'), with the reason on the row: the sheet maps nobody
        to the terminal that day, or every row it lists there is already
        matched, so the sheet does not list this one. Nobody's credit changes:
        the sheet never put that money against anyone. Except: a payment of
        exactly the amount of a sheet row kept that day on a terminal no report
        has carried (a mistyped terminal) is held, not written, so the same
        money is not counted twice (the third review).
   A sheet row the bank did not take on day D is dropped at once when it
   exactly repeats a row the bank did take (a double entry); otherwise it is
   kept while the bank cannot yet have it — while D+1, whose report carries
   D's late payments, is not covered ('sheet_pending') — and dropped only
   after. A payment written with nobody, of exactly the amount of a kept row
   that day in the same fleet (a mistyped terminal, or a pending row), is held:
   counted once.
   (Earlier drafts borrowed a terminal's driver from an earlier day, and gave
   an unlisted payment to the terminal's one driver that day; each named a
   driver for money the sheet never put against them.)

   A ROW STAYS ON THE SHEET'S DAY. The cash texts and the card allocation work
   by the sheet's day, so a bank row is filed under the day of the sheet row it
   matched (the report's day otherwise), and the bank's own date is kept beside
   it as bank_day. (An earlier draft filed it under the bank's date: a payment
   the bank dates 24 Nov, arriving in the 25 Nov report and typed under the
   25th, left the 25th's text a credit short.)

   A terminal's fleet is the merchant it settles to, as the bank's reports show
   it (bank.terminalFleet); the sheet's Platform cell only for a terminal no
   report has carried. A sheet row on a terminal no report has ever carried is
   kept as the sheet's: the bank's silence about a terminal it has never shown
   is no evidence that the payment did not happen. A sheet row of no more than
   zero (a chargeback) is kept as the sheet's on any day: the report carries
   sales only. Pure: the rows in,
   the rows out, and what did not match. */
export function mergeBank(payments, bank) {
  const asSheet = (p) => ({ ...p, source: 'network_sheet', bank_ref: null, id_basis: 'sheet', bank_day: null });
  const reported = new Set((bank?.covered || []).map((c) => `${c.fleet_id}|${c.day}`));
  const txns = bank?.txns || [];
  const termFleet = bank?.terminalFleet || {};
  const fleetOf = (p) => termFleet[p.terminal_id] || p.fleet_id;
  /* Covered: reported by the bank, and present in the sheet. */
  const covered = new Set();
  for (const p of payments) { const k = `${fleetOf(p)}|${p.txn_day}`; if (reported.has(k)) covered.add(k); }
  if (!covered.size || !txns.length) return { rows: payments.map(asSheet), sheet_only: [], held: [], basis: {}, covered: [] };
  const rows = []; const onDay = new Map(); const keptOn = new Map();
  const push = (m, k, v) => (m.get(k) || m.set(k, []).get(k)).push(v);
  for (const p of payments) {
    const k = `${p.terminal_id}|${p.txn_day}`;
    const banked = Object.prototype.hasOwnProperty.call(termFleet, p.terminal_id);
    if (p.amount > 0 && banked && covered.has(`${fleetOf(p)}|${p.txn_day}`)) push(onDay, k, { ...p, used: false });
    else { const r = { ...asSheet(p), used: false }; rows.push(r); if (p.amount > 0) push(keptOn, k, r); }
  }
  const use = txns.map((t, i) => ({ t, i })).filter(({ t }) => covered.has(`${t.fleet_id}|${t.report_day}`));
  const pick = new Map();
  const exact = (list, t) => (list || []).find((p) => !p.used && Math.abs(p.amount - t.amount) < 0.005);
  const take = (i, p, how) => { p.used = true; pick.set(i, { src: p, how, day: p.txn_day }); };
  for (const { t, i } of use) {   // 1, on the report's day — before anything else may take a row
    const p = exact(onDay.get(`${t.terminal_id}|${t.report_day}`), t);
    if (p) take(i, p, 'sheet_same_payment');
  }
  for (const { t, i } of use) {   // 1, a row kept on that terminal and day (its Platform's fleet-day not covered)
    if (pick.has(i)) continue;
    const p = exact(keptOn.get(`${t.terminal_id}|${t.report_day}`), t);
    if (p) take(i, p, 'sheet_same_payment');
  }
  for (const { t, i } of use) {   // 1, on the bank's own date
    if (pick.has(i) || t.txn_day === t.report_day) continue;
    const k = `${t.terminal_id}|${t.txn_day}`;
    const p = exact(onDay.get(k), t) || exact(keptOn.get(k), t);
    if (p) take(i, p, 'sheet_same_payment');
  }
  const heldDays = new Set();
  const capOf = (a) => Math.max(5, 0.05 * Math.abs(a));
  const groups = new Map();
  for (const { t, i } of use) if (!pick.has(i)) push(groups, `${t.terminal_id}|${t.report_day}`, { t, i });
  for (const [k, list] of groups) {   // 2, else 3, else 4 — a terminal-day at a time
    const same = onDay.get(k) || [];
    const free = same.filter((p) => !p.used);
    const whose = new Set(free.map((p) => (p.emirates_id ? `id:${p.emirates_id}` : `label:${p.id_label || ''}`)));
    if (whose.size > 1) { heldDays.add(k); for (const { i } of list) pick.set(i, { how: 'held' }); continue; }
    const pairs = [];
    for (const { t, i } of list) {
      for (const p of free) { const gap = Math.abs(p.amount - t.amount); if (gap <= capOf(p.amount)) pairs.push({ gap, i, p }); }
    }
    pairs.sort((a, b) => a.gap - b.gap || a.i - b.i);
    for (const x of pairs) if (!pick.has(x.i) && !x.p.used) take(x.i, x.p, 'sheet_same_terminal_day');
    const left = free.some((p) => !p.used);
    for (const { i } of list) {
      if (pick.has(i)) continue;
      if (left) { heldDays.add(k); pick.set(i, { how: 'held' }); continue; }
      pick.set(i, { src: null, how: 'none', day: list[0].t.report_day,
        label: !same.length ? 'the sheet maps no driver to this terminal that day'
          : 'the sheet does not list this payment: every payment it lists on this terminal that day is matched to another' });
    }
  }
  /* 3: the held terminal-days keep their unmatched sheet rows, as the sheet's. */
  for (const k of heldDays) {
    for (const p of onDay.get(k)) if (!p.used) { p.used = true; p.kept = true; rows.push({ ...asSheet(p), id_basis: 'sheet_held', used: false }); }
  }
  /* The sheet's rows on a covered day that no bank transaction took. A row
     that exactly repeats one the bank did take (the same terminal, day,
     amount and driver) is a double entry: dropped now, before the day's text
     (the final review: the team's 413 identical rows are what the bank tells
     apart). Any other is kept while the bank cannot yet have shown it — D+1,
     whose report carries D's late payments, not covered ('sheet_pending'). */
  const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  const who = (p) => (p.emirates_id ? `id:${p.emirates_id}` : `label:${p.id_label || ''}`);
  const taken = new Set([...onDay.values()].flat().filter((p) => p.used && !p.kept).map((p) => `${p.terminal_id}|${p.txn_day}|${p.amount.toFixed(2)}|${who(p)}`));
  const unmatched = [...onDay.values()].flat().filter((p) => !p.used);
  const pending = unmatched.filter((p) => !covered.has(`${fleetOf(p)}|${nextDay(p.txn_day)}`)
    && !taken.has(`${p.terminal_id}|${p.txn_day}|${p.amount.toFixed(2)}|${who(p)}`));
  const pendingRows = pending.map((p) => ({ ...asSheet(p), id_basis: 'sheet_pending', used: false }));
  rows.push(...pendingRows);
  /* 4's exception: one payment, two rows. A payment written with nobody, of
     exactly the amount of a row kept that day in the same fleet — on a
     terminal no report has carried (a mistyped terminal), or pending — is
     held, so it is counted once (as the sheet's, with its driver), whether or
     not the sheet has other rows on the bank's terminal (the final review). */
  const keptAlone = [...rows.filter((r) => r.amount > 0 && !Object.prototype.hasOwnProperty.call(termFleet, r.terminal_id)), ...pendingRows];
  for (const { t, i } of use) {
    if (pick.get(i)?.how !== 'none') continue;
    const r = keptAlone.find((u) => !u.paired && u.txn_day === t.report_day && u.fleet_id === t.fleet_id && Math.abs(u.amount - t.amount) < 0.005);
    if (r) { r.paired = true; pick.set(i, { how: 'held' }); }
  }
  const basis = {}; const bankRows = []; const held = [];
  for (const { t, i } of use) {
    const { src, how, label, day } = pick.get(i);
    basis[how] = (basis[how] || 0) + 1;
    if (how === 'held') { held.push(t); continue; }
    bankRows.push({ row_no: -(i + 1), txn_day: day, bank_day: t.txn_day, fleet_id: t.fleet_id, terminal_id: t.terminal_id,
      amount: Math.round(t.amount * 100) / 100, emirates_id: src?.emirates_id || null,
      id_label: src ? src.id_label : label, source: 'network_report', bank_ref: t.bank_ref, id_basis: how });
  }
  /* The sheet's rows on a covered day that no bank transaction took: the bank
     is the record of what was paid, so they are not kept — they are returned,
     so the read can say how many the sheet has that the bank has not. A kept
     row a late bank payment matched gives way to it. */
  const sheet_only = unmatched.filter((p) => !pending.includes(p)).map(({ used, ...p }) => p);
  const out = [...rows.filter((r) => !r.used).map(({ used, paired, ...r }) => r), ...bankRows];
  return { rows: out, sheet_only, held, basis, covered: [...covered] };
}

/* Bank rows that stand for one sheet row each — what the shrink guard counts
   as the sheet's, so it compares the sheet's read with the sheet's last read. */
export const ONE_FOR_ONE = ['sheet_same_payment', 'sheet_same_terminal_day'];

export const MONTH_FLOOR = 20;
const LOCK_KEY = 727001;   // pg_advisory_xact_lock key for card-payment writes

/* Write one read: replace what is stored, or hold it. Returns the import
   row. Inside one transaction, under the advisory lock; the counts the guard
   compares are taken only once the lock is held. */
export async function writeRead(db, parsed, { range = null, acceptShrink = false, bank = null } = {}) {
  const merged = mergeBank(parsed.payments, bank);
  const P = merged.rows;
  const skippedN = Object.values(parsed.skipped).reduce((a, n) => a + n, 0);
  const days = P.map((p) => p.txn_day).sort();
  const from = days[0] || null; const to = days[days.length - 1] || null;
  const base = [range, parsed.rows_read, P.length, skippedN, JSON.stringify(parsed.skipped), from, to, P.length ? sum(P) : null];
  const record = async (q, status, why, replaced = null) => (await q(
    `INSERT INTO card_import (sheet_range, rows_read, rows_kept, rows_skipped, skipped, day_from, day_to, total, replaced, status, why)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`, [...base, replaced, status, why]))[0];
  const q0 = (t, p) => db.query(t, p).then((r) => r.rows);
  if (parsed.missing?.length) return record(q0, 'error', `the sheet has no ${parsed.missing.join(', ')} column`);
  if (!P.length) {
    const why = parsed.rows_read > 0 && skippedN
      ? `none of the sheet's ${parsed.rows_read} rows could be read (${Object.entries(parsed.skipped).map(([k, n]) => `${n} ${k}`).join(', ')}); nothing was replaced`
      : 'the sheet returned no payments; nothing was replaced';
    return record(q0, 'held', why);
  }
  const pooled = typeof db.connect === 'function';
  const client = pooled ? await db.connect() : db;
  const q = (t, p) => client.query(t, p).then((r) => r.rows);
  let held = null;
  try {
    await client.query('BEGIN');
    await q('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    /* THE SHRINK GUARD COMPARES THE SHEET WITH THE SHEET (the review of
       2026-11-26): the fresh side is the rows the sheet returned, the stored
       side the sheet's rows plus the bank rows that each stood for one sheet
       row. Counting the merged rows instead let the bank's rows stand in for
       sheet rows a broken read had lost. */
    const SHEETS = `(source = 'network_sheet' OR (source = 'network_report' AND id_basis = ANY($1::text[])))`;
    const [{ n: stored }] = await q(`SELECT count(*)::int AS n FROM card_payment WHERE source IN ('network_sheet', 'network_report')`);
    const [{ n: storedSheet }] = await q(`SELECT count(*)::int AS n FROM card_payment WHERE ${SHEETS}`, [ONE_FOR_ONE]);
    const S = parsed.payments;
    if (!acceptShrink && storedSheet > 0) {
      const months = await q(`SELECT to_char(txn_day, 'YYYY-MM') AS m, count(*)::int AS n FROM card_payment
                               WHERE ${SHEETS} GROUP BY 1 HAVING count(*) >= $2`, [ONE_FOR_ONE, MONTH_FLOOR]);
      const fresh = {};
      for (const p of S) { const m = p.txn_day.slice(0, 7); fresh[m] = (fresh[m] || 0) + 1; }
      const short = months.filter((x) => (fresh[x.m] || 0) < x.n * KEEP_SHARE)
        .map((x) => `${x.m} (${fresh[x.m] || 0} of ${x.n})`);
      if (S.length < storedSheet * KEEP_SHARE || short.length) {
        held = `this read keeps ${S.length} of the sheet's ${storedSheet} stored payments`
          + `${short.length ? `, and fewer than ${Math.round(KEEP_SHARE * 100)}% of ${short.join(', ')}` : ''}`
          + ` — so nothing was replaced until a person looks`;
      }
    }
    if (held) {
      await client.query('ROLLBACK');
      return record(q0, 'held', held, stored);
    }
    const imp = await record(q, 'ok', null, stored);
    await q(`DELETE FROM card_payment WHERE source IN ('network_sheet', 'network_report')`);
    await q(`INSERT INTO card_payment (import_id, row_no, txn_day, fleet_id, terminal_id, amount, emirates_id, id_label,
                                       source, bank_ref, id_basis, bank_day)
             SELECT $1, * FROM unnest($2::int[], $3::date[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::text[],
                                      $9::text[], $10::text[], $11::text[], $12::date[])`,
    [imp.id, P.map((p) => p.row_no), P.map((p) => p.txn_day), P.map((p) => p.fleet_id), P.map((p) => p.terminal_id),
      P.map((p) => p.amount), P.map((p) => p.emirates_id), P.map((p) => p.id_label),
      P.map((p) => p.source), P.map((p) => p.bank_ref), P.map((p) => p.id_basis), P.map((p) => p.bank_day || null)]);
    await client.query('COMMIT');
    return { ...imp, bank_rows: P.filter((p) => p.source === 'network_report').length, basis: merged.basis,
      sheet_only: merged.sheet_only.length, held: merged.held.length };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (pooled) client.release(); }
}

export async function collect({ db, now = Date.now(), fetchImpl = fetch, log = defaultLog, acceptShrink = false,
  keyJson = get('GOOGLE_SERVICE_ACCOUNT_JSON', ''), sheetId = get('NETWORK_SHEET_ID', ''),
  range = get('NETWORK_SHEET_RANGE', 'A:J'), link = get('NETWORK_SHEET_LINK', '') } = {}) {
  /* Two ways in. The LINK (the operator's choice, 2026-11-23: the sheet is
     open to anyone with it) needs no account; a service-account key, when
     one is set, is used instead — for the day the link is restricted. */
  const byKey = Boolean(String(keyJson || '').trim());
  if (!byKey && !String(link || '').trim()) return { skipped: 'NETWORK_SHEET_LINK is not set' };
  if (byKey && !sheetId && !sheetFromLinkSafe(link)) return { skipped: 'NETWORK_SHEET_ID is not set' };
  const cred = byKey ? { provider: 'google', credential: 'GOOGLE_SERVICE_ACCOUNT_JSON', surface: 'network sheet' }
    : { provider: 'google', credential: 'NETWORK_SHEET_LINK', surface: 'network sheet' };
  const via = byKey ? range : 'link';
  try {
    let values;
    if (byKey) {
      const sa = parseServiceAccount(keyJson);
      values = await readValues({ sa, sheetId: sheetId || sheetFromLinkSafe(link).id, range, fetchImpl, now });
    } else {
      const csv = await readCsvByLink({ link, fetchImpl });
      values = parseCsv(csv, { relax_column_count: true, skip_empty_lines: false, bom: true });
    }
    await noteCredential(db, { ...cred, state: 'ok' }).catch(() => {});
    const parsed = parseSheet(values);
    /* The bank's emailed reports first (FIX-STATUS NIR): a failure there costs
       only the bank's amounts — the sheet's are written as before. */
    let bank = null; let mail = null;
    try {
      mail = await niReports.collect({ db, log, now });
      bank = await niReports.bankForMerge(db);
    } catch (e) { log.warn(SOURCE, 'bank reports not merged', { err: String(e.message || e).slice(0, 200) }); }
    const imp = await writeRead(db, parsed, { range: via, acceptShrink, bank });
    await logRun({ source: SOURCE, fleet_id: null, mode: 'sheet', status: imp.status === 'ok' ? 'ok' : imp.status === 'held' ? 'partial' : 'error',
      rows_written: imp.status === 'ok' ? imp.rows_kept : 0, error: imp.why || null }, db);
    log.info(SOURCE, 'read', { status: imp.status, kept: imp.rows_kept, skipped: imp.rows_skipped, from: imp.day_from, to: imp.day_to,
      ...(imp.bank_rows ? { bank_rows: imp.bank_rows, basis: imp.basis, sheet_only: imp.sheet_only, held: imp.held } : {}),
      ...(mail?.error ? { mail_error: mail.error.slice(0, 120) } : {}) });
    const fares = await faresAfterRead(db, now, log);
    return { status: imp.status, kept: imp.rows_kept, skipped: parsed.skipped, from: imp.day_from, to: imp.day_to, why: imp.why || null, fares };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    if (e.credential || /service account key|GOOGLE_SERVICE_ACCOUNT_JSON|NETWORK_SHEET_LINK/.test(msg)) {
      await noteCredential(db, { ...cred, state: 'invalid', detail: msg.slice(0, 160) }).catch(() => {});
    }
    await db.query(`INSERT INTO card_import (sheet_range, status, why) VALUES ($1, 'error', $2)`, [via, msg]).catch(() => {});
    await logRun({ source: SOURCE, fleet_id: null, mode: 'sheet', status: 'error', rows_written: 0, error: msg }, db).catch(() => {});
    log.warn(SOURCE, 'read failed', { err: msg.slice(0, 200) });
    return { error: msg, fares: await faresAfterRead(db, now, log) };
  }
}
