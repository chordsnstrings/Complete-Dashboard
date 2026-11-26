/* NETWORK INTERNATIONAL'S EMAILED "MERCHANT TRANSACTION ACTIVITY" REPORTS
   (FIX-STATUS NIR, 2026-11-26).
   ─────────────────────────────────────────────────────────────────────────
   Network International emails each merchant account a PDF every morning for
   the day before (sent around 09:20 Dubai to the accounts address, which
   forwards it to the mailbox read here): one row per card payment —
     DTOF TRN  TRMNL ID  CARD NUMBER  TRXN TYPE  ACQ_REF_NBR  AUTH CODE
     TRAN AMT  MSF AMT  TXN FEE  VAT AMT  NET AMT  TRXN DESP
   e.g. "25/11 10389535 529782XXX5583 SALES 72305166329020018316804 632203
   30.00 -0.98 0.00 -0.05 28.97 E/I", then the report's own grand totals
   (count, value, commission, VAT, NET PAYABLE).

   The operator, 2026-11-26: "for POS terminal mapping use the sheet. For the
   amount use the [report]". So this module reads the reports into ni_report /
   ni_card_txn and nothing else; src/sources/network_cards.js mergeBank() puts
   the bank's amounts in card_payment for the days a report covers, each with
   the driver the team's sheet maps to its terminal that day.

   Measured on the first two reports (25 Nov 2026): Ecosine 35 payments,
   AED 2,130.65 gross, 2,067.79 net; Egari 13, AED 969.32 / 938.20 — 48
   payments, AED 3,099.97, the sheet's day exactly, one for one by terminal
   and amount. What the report adds: a unique acquirer reference on every
   payment (the sheet has none, so its 413 identical rows cannot be told from
   double entries), the bank's fee and the net paid, and the bank's own date (a
   payment the bank dates 24 Nov arrived in the 25 Nov report). What it lacks:
   any driver, and the time of day.

   READ-ONLY, ALWAYS. The mailbox is opened with EXAMINE and every fetch is a
   BODY.PEEK: nothing is marked read, moved or deleted, so the accounts team's
   own view of the mailbox is never changed by this collector.

   A REPORT IS USED ONLY WHEN IT ADDS UP. Every row that looks like a
   transaction must be read, and the rows must reproduce the report's stated
   count and grand total to the fil; otherwise it is stored with the reason
   (status 'mismatch') and no amount is taken from it — the sheet's stays. */
import tls from 'node:tls';
import { createHash } from 'node:crypto';
import { get } from '../settings.js';
import { logRun } from '../db.js';
import { noteCredential } from '../auth_state.js';
import { log as defaultLog } from '../log.js';

export const SOURCE = 'ni_reports';
const SUBJECT = 'MERCHANT TRANSACTION ACTIVITY';
/* The senders, the receiving server and the merchant numbers, as measured on
   the first reports (2026-11-26); each a setting (src/settings.js). */
export const DEFAULT_SENDERS = 'accounts@arks.ae,nifax@network.ae';
export const DEFAULT_AUTHSERV = 'mailspamprotection.com';
export const DEFAULT_MERCHANTS = '200600866495:ecosine,200601523517:egari';
const splitList = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

/* ── MIME: just what these messages need ──────────────────────────────────
   A forwarded report is multipart/mixed (the forward's text, possibly
   multipart/alternative, and the PDF as application/octet-stream, base64).
   No library: the leaves are all this needs, and fewer dependencies is fewer
   advisories (FIX-STATUS DEP). Binary-safe: the message is handled as latin1. */
const unfold = (h) => h.replace(/\r?\n[ \t]+/g, ' ');
function headersOf(block) {
  const out = {};
  for (const line of unfold(block).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in out)) out[k] = line.slice(i + 1).trim(); }
  }
  return out;
}
function paramsOf(value = '') {
  const [first, ...rest] = value.split(';');
  const params = {};
  for (const p of rest) {
    const m = p.match(/^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/);
    if (m) params[m[1].toLowerCase().replace(/\*$/, '')] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  }
  return { value: first.trim().toLowerCase(), params };
}
/* RFC 2047 encoded words, as in a filename or a subject. */
export function decodeWords(s = '') {
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    try {
      const buf = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
      return new TextDecoder(/utf-?8/i.test(cs) ? 'utf-8' : 'latin1').decode(buf);
    } catch { return text; }
  });
}
function decodeBody(body, cte = '') {
  const e = cte.toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    return Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  }
  return Buffer.from(body, 'latin1');
}
/* Every occurrence of a header, top first (headersOf keeps only the first). */
export function headerAll(block, name) {
  const want = name.toLowerCase();
  return unfold(block).split(/\r?\n/).filter((l) => l.slice(0, l.indexOf(':')).trim().toLowerCase() === want)
    .map((l) => l.slice(l.indexOf(':') + 1).trim());
}
/* -> { headers, headerBlock, parts: [{ contentType, filename, data: Buffer }] } — the leaves, in
   order. A report forwarded AS AN ATTACHMENT (message/rfc822) is opened and its leaves read too. */
export function parseMime(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const walk = (chunk, depth) => {
    const sep = chunk.search(/\r?\n\r?\n/);
    const head = sep < 0 ? chunk : chunk.slice(0, sep);
    const body = sep < 0 ? '' : chunk.slice(sep).replace(/^\r?\n\r?\n/, '');
    const h = headersOf(head);
    const ct = paramsOf(h['content-type'] || 'text/plain');
    if (ct.value.startsWith('multipart/') && ct.params.boundary && depth < 8) {
      const b = `--${ct.params.boundary}`;
      const pieces = body.split(new RegExp(`(?:^|\\r?\\n)${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
      return { headers: h, parts: pieces.slice(1).filter((p) => p.trim()).flatMap((p) => walk(p, depth + 1).parts) };
    }
    if (ct.value === 'message/rfc822' && depth < 8) {
      return { headers: h, parts: walk(decodeBody(body, h['content-transfer-encoding'] || '').toString('latin1'), depth + 1).parts };
    }
    const cd = paramsOf(h['content-disposition'] || '');
    const filename = decodeWords(cd.params.filename || ct.params.name || '') || null;
    return { headers: h, parts: [{ contentType: ct.value, filename, data: decodeBody(body, h['content-transfer-encoding'] || '') }] };
  };
  const top = walk(text, 0);
  const sep = text.search(/\r?\n\r?\n/);
  return { ...top, headerBlock: sep < 0 ? text : text.slice(0, sep) };
}

/* WHO SENT IT (the review of 2026-11-26). Anyone can email the mailbox, and a
   report's amounts change what drivers are asked for, so a message is read
   only when (1) its From address is an allowed sender, and (2) the RECEIVING
   server's own verdict passes DMARC (or, with no DMARC result, SPF) for that
   sender's domain. Measured on the real reports: the inbound filter
   (…prod.antispam.mailspamprotection.com, ahead of the mailbox's own server) wrote
   "spf=pass smtp.mailfrom=arks.ae; dmarc=pass header.from=arks.ae". A forged
   "From: accounts@arks.ae" fails arks.ae's DMARC there. A sender can write its
   own Authentication-Results header, so EVERY one carrying the receiving
   server's id must pass, and at least one must exist. */
export function checkOrigin(headerBlock, { senders = [], authserv = '' } = {}) {
  const from = (headerAll(headerBlock, 'from')[0] || '');
  const addr = ((from.match(/<([^>]+)>/) || [])[1] || from).trim().toLowerCase();
  const domain = addr.split('@')[1] || '';
  if (!addr || !senders.map((x) => x.trim().toLowerCase()).filter(Boolean).includes(addr)) {
    return { ok: false, sender: addr || null, why: `sender ${addr || '(none)'} is not one of the allowed senders` };
  }
  const suffix = String(authserv || '').trim().toLowerCase();
  if (!suffix) return { ok: false, sender: addr, why: 'no receiving server is configured to vouch for senders (NI_MAIL_AUTHSERV)' };
  const ours = headerAll(headerBlock, 'authentication-results')
    .filter((v) => { const id = v.split(';')[0].trim().toLowerCase(); return id === suffix || id.endsWith(`.${suffix}`); });
  if (!ours.length) return { ok: false, sender: addr, why: `no authentication result from the receiving server (${suffix})` };
  for (const v of ours) {
    const dmarc = v.match(/\bdmarc=(\w+)[^;]*?header\.from=([^\s;]+)/i);
    const spf = v.match(/\bspf=(\w+)[^;]*?smtp\.mailfrom=([^\s;]+)/i);
    const pass = dmarc ? dmarc[1].toLowerCase() === 'pass' && dmarc[2].toLowerCase().replace(/^.*@/, '') === domain
      : (spf ? spf[1].toLowerCase() === 'pass' && spf[2].toLowerCase().replace(/^.*@/, '') === domain : false);
    if (!pass) return { ok: false, sender: addr, why: `the receiving server did not pass ${domain} (${(dmarc || spf || ['', 'no result'])[0].slice(0, 80)})` };
  }
  return { ok: true, sender: addr };
}
const safeIso = (v) => { const t = Date.parse(v || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

/* ── PDF -> lines ─────────────────────────────────────────────────────────
   unpdf (Mozilla's pdf.js, serverless build, no dependencies). Text items are
   grouped into lines by their baseline (within 2 points) and ordered left to
   right — on the real reports this gives exactly the printed lines. */
export async function pdfLines(data) {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 });
  const lines = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = it.transform[5]; const x = it.transform[4];
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, s: it.str.trim() });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) lines.push(r.items.sort((a, b) => a.x - b.x).map((i) => i.s).join(' '));
  }
  await doc.destroy?.();
  return lines;
}

/* ── The report ───────────────────────────────────────────────────────────── */
const NUM = '-?[\\d,]+\\.\\d\\d';
const ROW = new RegExp(`^(\\d\\d)/(\\d\\d) (\\d{6,10}) (\\d{4,8}X{2,8}\\d{4}) ([A-Z][A-Z /-]*?) (\\d{12,30}) (\\S{1,12}) (${NUM}) (${NUM}) (${NUM}) (${NUM}) (${NUM})(?: (\\S+))?$`);
const LOOKS_LIKE_ROW = /^\d\d\/\d\d \d{6,10}\b/;
const num = (s) => Math.round(Number(String(s).replace(/,/g, '')) * 100) / 100;
const iso = (dmy) => { const [d, m, y] = dmy.split('/'); return `${y}-${m}-${d}`; };
const r2 = (x) => Math.round(x * 100) / 100;

/* The merchant numbers this collector accepts, and the fleet each is
   (NI_MERCHANTS, "merchant:fleet,merchant:fleet"). A report under any other
   number is stored and never used — the name on it can be typed by anyone. */
export function merchantsOf(spec = '') {
  const out = {};
  for (const pair of String(spec).split(',')) {
    const [mid, fleet] = pair.split(':').map((x) => (x || '').trim());
    if (/^\d{6,20}$/.test(mid) && /^[a-z0-9_-]+$/.test(fleet || '')) out[mid] = fleet;
  }
  return out;
}

/* lines -> { merchant_no, merchant_name, fleet_id, day_from, day_to,
   report_date, txns, totals, stated, status, why }. */
export function parseReport(lines, { merchants = {} } = {}) {
  const all = lines.join('\n');
  const pick = (re) => (all.match(re) || [])[1] || null;
  const merchant_no = pick(/Merchant No\s*:\s*(\d+)/);
  const merchant_name = pick(/Address\s*:\s*([^\n]+)/)?.trim() || null;
  const span = all.match(/FROM (\d\d\/\d\d\/\d{4}) TO (\d\d\/\d\d\/\d{4})/);
  const day_from = span ? iso(span[1]) : null; const day_to = span ? iso(span[2]) : null;
  const rd = all.match(/Date\s*:\s*(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  const MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const report_date = rd ? `${rd[3]}-${MON[rd[2].toLowerCase()] || '00'}-${rd[1].padStart(2, '0')}` : null;
  const txns = []; const unread = [];
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(ROW);
    if (!m) { if (LOOKS_LIKE_ROW.test(line)) unread.push(line.slice(0, 60)); continue; }
    const [, dd, mm, terminal, card, type, ref, auth, amt, msf, fee, vat, net, desc] = m;
    /* The year is the report's; a payment dated after the report's last day
       belongs to the year before (a 31/12 payment in a report for 01/01). */
    let year = Number((day_to || '0000').slice(0, 4));
    if (day_to && `${year}-${mm}-${dd}` > day_to) year -= 1;
    txns.push({ txn_day: `${year}-${mm}-${dd}`, terminal_id: terminal, card_last4: card.slice(-4), txn_type: type.trim(),
      bank_ref: ref, auth_code: auth, amount: num(amt), msf: num(msf), fee: num(fee), vat: num(vat), net: num(net), card_class: desc || null });
  }
  const stated = {
    txns: pick(/GRAND TOTAL OF POS TRANSACTIONS\s*:\s*(\d+)/) != null ? Number(pick(/GRAND TOTAL OF POS TRANSACTIONS\s*:\s*(\d+)/)) : null,
    gross: pick(new RegExp(`GRAND TOTAL VALUE OF POS TRANSACTIONS\\s*:\\s*(${NUM})`)) != null ? num(pick(new RegExp(`GRAND TOTAL VALUE OF POS TRANSACTIONS\\s*:\\s*(${NUM})`))) : null,
    net: pick(new RegExp(`NET PAYABLE / RECEIVABLE\\s*:?\\s*(${NUM})`)) != null ? num(pick(new RegExp(`NET PAYABLE / RECEIVABLE\\s*:?\\s*(${NUM})`))) : null,
  };
  const totals = { txns: txns.length, gross: r2(txns.reduce((a, t) => a + t.amount, 0)),
    fees: r2(txns.reduce((a, t) => a + t.msf + t.fee, 0)), vat: r2(txns.reduce((a, t) => a + t.vat, 0)),
    net: r2(txns.reduce((a, t) => a + t.net, 0)) };
  const why = [];
  if (!merchant_no) why.push('no merchant number');
  if (!day_from || !day_to) why.push('no FROM/TO dates');
  if (unread.length) why.push(`${unread.length} transaction row(s) could not be read, e.g. "${unread[0]}"`);
  if (stated.txns == null || stated.gross == null) why.push('no grand totals to check against');
  else {
    if (stated.txns !== totals.txns) why.push(`${totals.txns} rows read against the report's ${stated.txns}`);
    if (Math.abs(stated.gross - totals.gross) > 0.005) why.push(`rows add up to ${totals.gross.toFixed(2)} against the report's ${stated.gross.toFixed(2)}`);
  }
  const fleet_id = (merchant_no && merchants[merchant_no]) || null;
  if (!fleet_id) why.push(`merchant ${merchant_no || '(none)'} is not one of the accepted merchant numbers`);
  /* Every report seen so far covers one day. One spanning several is held
     until one is seen: the sheet files payments by the report's day, and with
     a span it is not known which day each belongs under (the review). */
  if (day_from && day_to && day_from !== day_to) why.push(`spans ${day_from} to ${day_to}; a report over several days has not been seen yet, so its amounts are not taken`);
  const types = [...new Set(txns.map((t) => t.txn_type))].filter((t) => t !== 'SALES');
  if (types.length) why.push(`transaction types not yet seen in a report: ${types.join(', ')} — check their sign before trusting the amounts`);
  return { merchant_no, merchant_name, fleet_id, day_from, day_to, report_date, txns, totals, stated,
    status: why.length ? 'mismatch' : 'ok', why: why.join('; ') || null };
}

/* ── Store ────────────────────────────────────────────────────────────────
   One report row per merchant and span; a report re-sent replaces it and its
   transactions. Inside one transaction, so a reader never sees half a report. */
export async function storeReport(db, rep, meta = {}) {
  const pooled = typeof db.connect === 'function';
  const client = pooled ? await db.connect() : db;
  const q = (t, p) => client.query(t, p).then((r) => r.rows);
  try {
    await client.query('BEGIN');
    const [row] = await q(
      `INSERT INTO ni_report (merchant_no, merchant_name, fleet_id, day_from, day_to, report_date, message_id, mail_uid,
         mail_uidvalidity, received_at, attachment, txns, gross, fees, vat, net, stated_txns, stated_gross, stated_net, status, why)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (merchant_no, day_from, day_to) DO UPDATE SET merchant_name = EXCLUDED.merchant_name,
         fleet_id = EXCLUDED.fleet_id, report_date = EXCLUDED.report_date, message_id = EXCLUDED.message_id,
         mail_uid = EXCLUDED.mail_uid, mail_uidvalidity = EXCLUDED.mail_uidvalidity, received_at = EXCLUDED.received_at,
         attachment = EXCLUDED.attachment, txns = EXCLUDED.txns, gross = EXCLUDED.gross, fees = EXCLUDED.fees,
         vat = EXCLUDED.vat, net = EXCLUDED.net, stated_txns = EXCLUDED.stated_txns, stated_gross = EXCLUDED.stated_gross,
         stated_net = EXCLUDED.stated_net, status = EXCLUDED.status, why = EXCLUDED.why, ingested_at = now()
       WHERE ni_report.status <> 'ok' OR EXCLUDED.status = 'ok'
       RETURNING id`,
      [rep.merchant_no, rep.merchant_name, rep.fleet_id, rep.day_from, rep.day_to,
        rep.report_date, meta.message_id || null, meta.uid ?? null, meta.uidvalidity ?? null, meta.received_at || null,
        meta.attachment || null, rep.totals.txns, rep.totals.gross, rep.totals.fees, rep.totals.vat, rep.totals.net,
        rep.stated.txns, rep.stated.gross, rep.stated.net, rep.status, rep.why]);
    /* An unusable copy never replaces a usable one (the review): the earlier
       report and its rows stay, and null says so. */
    if (!row) { await client.query('COMMIT'); return null; }
    await q('DELETE FROM ni_card_txn WHERE report_id = $1', [row.id]);
    for (const t of rep.txns) {
      await q(`INSERT INTO ni_card_txn (merchant_no, bank_ref, report_id, report_day, txn_day, terminal_id, card_last4,
                 txn_type, auth_code, amount, msf, vat, net, card_class)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               ON CONFLICT (report_id, bank_ref) DO NOTHING`,
      [rep.merchant_no, t.bank_ref, row.id, rep.day_to, t.txn_day, t.terminal_id, t.card_last4, t.txn_type, t.auth_code,
        t.amount, r2(t.msf + t.fee), t.vat, t.net, t.card_class]);
    }
    await client.query('COMMIT');
    return row.id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (pooled) client.release(); }
}

/* One fetched message -> { status, why, sender, reports }. Statuses: 'ok' (its
   report(s) stored), 'rejected' (who sent it does not check out), 'no_report'
   (no PDF), 'unreadable' (no PDF with a merchant and a span). A PDF attached
   twice (the same bytes) is read once. Throws only on a failure worth
   retrying (the database); the caller records the outcome either way. */
export async function ingestMessage(db, { raw, uid = null, uidvalidity = null }, {
  log = defaultLog, senders = splitList(get('NI_MAIL_SENDERS', DEFAULT_SENDERS)),
  authserv = get('NI_MAIL_AUTHSERV', DEFAULT_AUTHSERV), merchants = merchantsOf(get('NI_MERCHANTS', DEFAULT_MERCHANTS)) } = {}) {
  const { headers, headerBlock, parts } = parseMime(raw);
  const meta = { message_id: headers['message-id'] || null, subject: decodeWords(headers.subject || '').slice(0, 200),
    received_at: safeIso(headers.date) };
  const origin = checkOrigin(headerBlock, { senders, authserv });
  if (!origin.ok) {
    log.warn(SOURCE, 'message not read', { subject: meta.subject.slice(0, 100), why: origin.why });
    return { ...meta, sender: origin.sender, status: 'rejected', why: origin.why, reports: [] };
  }
  const seen = new Set(); const reports = []; const unreadable = [];
  for (const part of parts) {
    const isPdf = /\.pdf$/i.test(part.filename || '') || part.contentType === 'application/pdf'
      || part.data.subarray(0, 5).toString('latin1') === '%PDF-';
    if (!isPdf) continue;
    const key = createHash('sha256').update(part.data).digest('hex');
    if (seen.has(key)) continue;
    seen.add(key);
    let rep;
    try { rep = parseReport(await pdfLines(part.data), { merchants }); } catch (e) {
      unreadable.push(`${part.filename || 'a PDF'} could not be opened (${String(e.message || e).slice(0, 80)})`); continue;
    }
    if (!rep.merchant_no || !rep.day_from || !rep.day_to) { unreadable.push(`${part.filename || 'a PDF'}: ${rep.why}`); continue; }
    const id = await storeReport(db, rep, { message_id: meta.message_id, uid, uidvalidity, received_at: meta.received_at, attachment: part.filename });
    reports.push({ id, merchant: rep.merchant_no, fleet: rep.fleet_id, from: rep.day_from, to: rep.day_to,
      txns: rep.totals.txns, gross: rep.totals.gross, status: id ? rep.status : 'kept_earlier',
      why: id ? rep.why : `${rep.why}; the usable report already held for this merchant and day is kept` });
    if (rep.status !== 'ok') log.warn(SOURCE, 'report not used for amounts', { subject: meta.subject.slice(0, 100), why: rep.why });
  }
  if (reports.length) return { ...meta, sender: origin.sender, status: 'ok', why: unreadable.join('; ') || null, reports };
  if (!seen.size) return { ...meta, sender: origin.sender, status: 'no_report', why: 'no PDF in the message', reports };
  return { ...meta, sender: origin.sender, status: 'unreadable', why: unreadable.join('; ').slice(0, 500), reports };
}

/* ── IMAP, read-only ──────────────────────────────────────────────────────
   A minimal client: LOGIN, EXAMINE, UID SEARCH, UID FETCH BODY.PEEK[],
   LOGOUT. A response is complete at the line that starts with its tag;
   literals ({n}\r\n then n bytes) are skipped whole while looking for it, so a
   message body that happens to contain the tag cannot end the read early. */
export function imapSession({ host, port = 993, connect = tls.connect, timeoutMs = 60000 } = {}) {
  const sock = connect({ host, port, servername: host });
  let buf = Buffer.alloc(0); let waiting = null; let failed = null; let greeted = false; let onGreet = null;
  const tryResolve = () => {
    if (!greeted) {
      const e = buf.indexOf('\r\n');
      if (e >= 0) { greeted = true; buf = buf.subarray(e + 2); onGreet?.(); }
      return;
    }
    if (!waiting) return;
    let i = 0;
    while (i < buf.length) {
      const e = buf.indexOf('\r\n', i);
      if (e < 0) return;
      const line = buf.subarray(i, e).toString('latin1');
      const lit = line.match(/\{(\d+)\}$/);
      if (lit) { const n = Number(lit[1]); if (buf.length < e + 2 + n) return; i = e + 2 + n; continue; }
      if (line.startsWith(`${waiting.tag} `)) {
        const out = buf.subarray(0, e + 2); buf = buf.subarray(e + 2);
        const w = waiting; waiting = null; clearTimeout(w.timer);
        if (/^\S+ OK\b/.test(line)) w.res(out); else w.rej(Object.assign(new Error(line.slice(0, 200)), { imap: true, line }));
        return;
      }
      i = e + 2;
    }
  };
  sock.on('data', (d) => { buf = Buffer.concat([buf, d]); tryResolve(); });
  sock.on('error', (e) => { failed = e; if (waiting) { clearTimeout(waiting.timer); waiting.rej(e); waiting = null; } });
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('IMAP greeting timed out')), timeoutMs);
    t.unref?.();
    onGreet = () => { clearTimeout(t); res(); }; sock.once('error', (e) => { clearTimeout(t); rej(e); });
  });
  ready.catch(() => {});
  let n = 0;
  const cmd = async (c) => {
    await ready;
    if (failed) throw failed;
    return new Promise((res, rej) => {
      const tag = `N${++n}`;
      const timer = setTimeout(() => { waiting = null; rej(new Error(`IMAP ${c.split(' ')[0]} timed out`)); }, timeoutMs);
      timer.unref?.();
      waiting = { tag, res, rej, timer };
      sock.write(`${tag} ${c}\r\n`);
      tryResolve();
    });
  };
  const quote = (x) => `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return {
    login: (user, pass) => cmd(`LOGIN ${quote(user)} ${quote(pass)}`),
    async examine(box = 'INBOX') {
      const r = (await cmd(`EXAMINE ${quote(box)}`)).toString('latin1');
      return { exists: Number((r.match(/\* (\d+) EXISTS/) || [])[1] || 0), uidvalidity: Number((r.match(/UIDVALIDITY (\d+)/) || [])[1] || 0) };
    },
    async uidSearch(criteria) {
      const r = (await cmd(`UID SEARCH ${criteria}`)).toString('latin1');
      return ((r.match(/\* SEARCH([\d ]*)/) || [])[1] || '').trim().split(/\s+/).filter(Boolean).map(Number);
    },
    async fetchRaw(uid) {
      const r = await cmd(`UID FETCH ${uid} (BODY.PEEK[])`);
      const head = r.toString('latin1');
      const m = /BODY\[\] \{(\d+)\}\r\n/.exec(head);
      if (!m) return null;
      const start = m.index + m[0].length;
      return r.subarray(start, start + Number(m[1]));
    },
    async logout() { try { await cmd('LOGOUT'); } catch { /* the server may close first */ } sock.end(); },
    close() { sock.destroy(); },
  };
}

const IMAP_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const imapDate = (d) => `${d.getUTCDate()}-${IMAP_MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`;

/* The collector tick: read the reports that are new since the last read.
   Skipped (and silent) until the mailbox is configured. */
export async function collect({ db, log = defaultLog, now = Date.now(), sinceDays = 10,
  host = get('NI_MAIL_HOST', ''), port = Number(get('NI_MAIL_PORT', '993')) || 993,
  user = get('NI_MAIL_USER', ''), pass = get('NI_MAIL_PASS', ''), session = imapSession, readOpts = {} } = {}) {
  if (!host || !user || !pass) return { skipped: 'NI_MAIL_HOST, NI_MAIL_USER or NI_MAIL_PASS is not set' };
  const cred = { provider: 'network_international_mail', credential: 'NI_MAIL_PASS', surface: 'emailed POS reports' };
  const s = session({ host, port });
  const out = { reports: [], skipped_known: 0 };
  try {
    try { await s.login(user, pass); } catch (e) {
      if (e.imap) await noteCredential(db, { ...cred, state: 'invalid', detail: String(e.line || e.message).slice(0, 160) }).catch(() => {});
      throw e;
    }
    await noteCredential(db, { ...cred, state: 'ok' }).catch(() => {});
    const box = await s.examine('INBOX');
    const uids = await s.uidSearch(`SINCE ${imapDate(new Date(now - sinceDays * 864e5))} SUBJECT "${SUBJECT}"`);
    /* Known: every message already recorded, except one that failed for a
       reason worth retrying, up to three attempts (ni_mail_message). */
    const known = new Set((await db.query(
      `SELECT mail_uid FROM ni_mail_message WHERE mail_uidvalidity = $1 AND (status <> 'error' OR attempts >= 3)`,
      [box.uidvalidity])).rows.map((r) => Number(r.mail_uid)));
    for (const uid of uids) {
      if (known.has(uid)) { out.skipped_known += 1; continue; }
      let res;
      try {
        const raw = await s.fetchRaw(uid);
        res = raw ? await ingestMessage(db, { raw, uid, uidvalidity: box.uidvalidity }, { log, ...readOpts })
          : { status: 'error', why: 'the server returned no body' };
      } catch (e) { res = { status: 'error', why: String(e.message || e).slice(0, 300) }; }
      await db.query(
        `INSERT INTO ni_mail_message (mail_uidvalidity, mail_uid, message_id, sender, subject, received_at, status, why)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (mail_uidvalidity, mail_uid) DO UPDATE SET status = EXCLUDED.status, why = EXCLUDED.why,
           attempts = ni_mail_message.attempts + 1, seen_at = now()`,
        [box.uidvalidity, uid, res.message_id || null, res.sender || null, res.subject || null, res.received_at || null, res.status, res.why || null]);
      out.messages = (out.messages || 0) + 1;
      out.reports.push(...(res.reports || []));
      if (res.status === 'error') log.warn(SOURCE, 'message failed; it will be tried again', { uid, why: String(res.why).slice(0, 160) });
    }
    await s.logout();
    await logRun({ source: SOURCE, fleet_id: null, mode: 'mail', status: 'ok', rows_written: out.reports.reduce((a, r) => a + r.txns, 0) }, db);
    if (out.reports.length) log.info(SOURCE, 'read', { reports: out.reports.length, known: out.skipped_known,
      used: out.reports.filter((r) => r.status === 'ok').length });
    return out;
  } catch (e) {
    s.close();
    const msg = String(e.message || e).slice(0, 300);
    await logRun({ source: SOURCE, fleet_id: null, mode: 'mail', status: 'error', rows_written: 0, error: msg }, db).catch(() => {});
    log.warn(SOURCE, 'read failed', { err: msg.slice(0, 200) });
    return { error: msg, ...out };
  }
}

/* What the sheet write merges: the transactions of every usable report (one
   per bank reference, the newest usable report's), the fleet-days those
   reports cover, and each terminal's fleet as the bank's reports show it (any
   report: the merchant a terminal settles to is the bank's fact, whatever the
   sheet's Platform column says). */
export async function bankForMerge(db) {
  const reports = (await db.query(
    `SELECT id, fleet_id, to_char(day_from, 'YYYY-MM-DD') AS day_from, to_char(day_to, 'YYYY-MM-DD') AS day_to
       FROM ni_report WHERE status = 'ok' AND fleet_id IS NOT NULL`)).rows;
  const terminalFleet = Object.fromEntries((await db.query(
    `SELECT DISTINCT ON (t.terminal_id) t.terminal_id, r.fleet_id
       FROM ni_card_txn t JOIN ni_report r ON r.id = t.report_id
      WHERE r.fleet_id IS NOT NULL ORDER BY t.terminal_id, t.report_day DESC`)).rows.map((r) => [r.terminal_id, r.fleet_id]));
  if (!reports.length) return { covered: [], txns: [], terminalFleet };
  const covered = [];
  for (const r of reports) {
    for (let d = new Date(`${r.day_from}T00:00:00Z`); d <= new Date(`${r.day_to}T00:00:00Z`); d = new Date(d.getTime() + 864e5)) {
      covered.push({ fleet_id: r.fleet_id, day: d.toISOString().slice(0, 10) });
    }
  }
  const txns = (await db.query(
    `SELECT DISTINCT ON (t.merchant_no, t.bank_ref) t.bank_ref, t.terminal_id, to_char(t.report_day, 'YYYY-MM-DD') AS report_day,
            to_char(t.txn_day, 'YYYY-MM-DD') AS txn_day, t.amount::float AS amount, t.txn_type, r.fleet_id
       FROM ni_card_txn t JOIN ni_report r ON r.id = t.report_id
      WHERE r.status = 'ok' AND r.fleet_id IS NOT NULL
      ORDER BY t.merchant_no, t.bank_ref, r.ingested_at DESC, r.id DESC`)).rows
    .sort((a, b) => (a.report_day + a.terminal_id + a.bank_ref < b.report_day + b.terminal_id + b.bank_ref ? -1 : 1));
  return { covered, txns, terminalFleet };
}
