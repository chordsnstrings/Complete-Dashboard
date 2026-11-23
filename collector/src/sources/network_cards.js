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

   ONE READ REPLACES THE DAYS IT COVERS. The sheet is one running list with no
   transaction reference, so there is nothing to append by: a read deletes the
   stored payments between its first and last day and writes the sheet's rows
   in their place, in one transaction. Identical rows are separate payments,
   as the sheet's own total counts them.

   THE GUARD. A read that would leave fewer than 90% of the payments already
   stored for its own days is HELD, not written — a sheet half-cleared while
   someone edits it, or a filter left on, must not wipe a month. The hold is
   recorded (card_import status 'held', with the counts) and the page says so;
   `node src/index.js network-cards --accept-shrink` writes it once a person
   has looked. An empty read is never written.

   Nothing here moves a money figure: the cash position is unchanged until
   phase 3 (FIX-STATUS CARD-3), which waits on the operator's review. */
import { get } from '../settings.js';
import { logRun } from '../db.js';
import { noteCredential } from '../auth_state.js';
import { log as defaultLog } from '../log.js';
import { parseServiceAccount, readValues } from '../google_sheets.js';

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
export function dayOf(v) {
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
  if (m) return validDay(+m[3], +m[2], +m[1]);
  return null;
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
  for (let i = hi + 1; i < rows.length; i += 1) {
    const r = rows[i] || [];
    const cell = (k) => r[col[k]];
    if (![cell('eid'), cell('day'), cell('terminal'), cell('amount')].some((c) => String(c ?? '').trim())) continue;
    const day = dayOf(cell('day'));
    if (!day) { out('no readable day'); continue; }
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

/* Write one read: replace the days it covers, or hold it. Returns the import
   row. `client` is a pooled pg client inside a transaction, or PGlite. */
export async function writeRead(db, parsed, { range = null, acceptShrink = false } = {}) {
  const P = parsed.payments;
  const skippedN = Object.values(parsed.skipped).reduce((a, n) => a + n, 0);
  const days = P.map((p) => p.txn_day).sort();
  const from = days[0] || null; const to = days[days.length - 1] || null;
  const base = [range, parsed.rows_read, P.length, skippedN, JSON.stringify(parsed.skipped), from, to, P.length ? sum(P) : null];
  const record = async (q, status, why, replaced = null) => (await q(
    `INSERT INTO card_import (sheet_range, rows_read, rows_kept, rows_skipped, skipped, day_from, day_to, total, replaced, status, why)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) RETURNING *`, [...base, replaced, status, why]))[0];
  const q0 = (t, p) => db.query(t, p).then((r) => r.rows);
  if (parsed.missing?.length) return record(q0, 'error', `the sheet has no ${parsed.missing.join(', ')} column`);
  if (!P.length) return record(q0, 'held', 'the sheet returned no payments; nothing was replaced');
  const [{ n: stored }] = await q0(`SELECT count(*)::int AS n FROM card_payment WHERE source = 'network_sheet' AND txn_day BETWEEN $1 AND $2`, [from, to]);
  if (!acceptShrink && stored > 0 && P.length < stored * KEEP_SHARE) {
    return record(q0, 'held', `this read has ${P.length} payments for ${from} to ${to}, where ${stored} are stored — `
      + `fewer than ${Math.round(KEEP_SHARE * 100)}%, so nothing was replaced until a person looks`);
  }
  const pooled = typeof db.connect === 'function';
  const client = pooled ? await db.connect() : db;
  const q = (t, p) => client.query(t, p).then((r) => r.rows);
  try {
    await client.query('BEGIN');
    const imp = await record(q, 'ok', null, stored);
    await q(`DELETE FROM card_payment WHERE source = 'network_sheet' AND txn_day BETWEEN $1 AND $2`, [from, to]);
    await q(`INSERT INTO card_payment (import_id, row_no, txn_day, fleet_id, terminal_id, amount, emirates_id, id_label)
             SELECT $1, * FROM unnest($2::int[], $3::date[], $4::text[], $5::text[], $6::numeric[], $7::text[], $8::text[])`,
    [imp.id, P.map((p) => p.row_no), P.map((p) => p.txn_day), P.map((p) => p.fleet_id), P.map((p) => p.terminal_id),
      P.map((p) => p.amount), P.map((p) => p.emirates_id), P.map((p) => p.id_label)]);
    await client.query('COMMIT');
    return imp;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (pooled) client.release(); }
}

export async function collect({ db, now = Date.now(), fetchImpl = fetch, log = defaultLog, acceptShrink = false,
  keyJson = get('GOOGLE_SERVICE_ACCOUNT_JSON', ''), sheetId = get('NETWORK_SHEET_ID', ''),
  range = get('NETWORK_SHEET_RANGE', 'A:J') } = {}) {
  if (!String(keyJson || '').trim()) return { skipped: 'GOOGLE_SERVICE_ACCOUNT_JSON is not set' };
  if (!sheetId) return { skipped: 'NETWORK_SHEET_ID is not set' };
  const cred = { provider: 'google', credential: 'GOOGLE_SERVICE_ACCOUNT_JSON', surface: 'network sheet' };
  try {
    const sa = parseServiceAccount(keyJson);
    const values = await readValues({ sa, sheetId, range, fetchImpl, now });
    await noteCredential(db, { ...cred, state: 'ok' }).catch(() => {});
    const parsed = parseSheet(values);
    const imp = await writeRead(db, parsed, { range, acceptShrink });
    await logRun({ source: SOURCE, fleet_id: null, mode: 'sheet', status: imp.status === 'ok' ? 'ok' : imp.status === 'held' ? 'partial' : 'error',
      rows_written: imp.status === 'ok' ? imp.rows_kept : 0, error: imp.why || null }, db);
    log.info(SOURCE, 'read', { status: imp.status, kept: imp.rows_kept, skipped: imp.rows_skipped, from: imp.day_from, to: imp.day_to });
    return { status: imp.status, kept: imp.rows_kept, skipped: parsed.skipped, from: imp.day_from, to: imp.day_to, why: imp.why || null };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    if (e.credential || /service account key|GOOGLE_SERVICE_ACCOUNT_JSON/.test(msg)) {
      await noteCredential(db, { ...cred, state: 'invalid', detail: msg.slice(0, 160) }).catch(() => {});
    }
    await db.query(`INSERT INTO card_import (sheet_range, status, why) VALUES ($1, 'error', $2)`, [range, msg]).catch(() => {});
    await logRun({ source: SOURCE, fleet_id: null, mode: 'sheet', status: 'error', rows_written: 0, error: msg }, db).catch(() => {});
    log.warn(SOURCE, 'read failed', { err: msg.slice(0, 200) });
    return { error: msg };
  }
}
