/* Network International's emailed POS reports: the bank's amounts, the
   sheet's driver (FIX-STATUS NIR, 2026-11-26; the review of the same day).
   ──────────────────────────────────────────────────────────────────────────
     §1  the report: a PDF's lines become transactions, and a report is used
         only when its rows reproduce its own grand totals — a row that cannot
         be read, a total that does not add up, a merchant number not on the
         list, an unseen transaction type or a span of several days each keep
         it out; a 31/12 payment in a 01/01 report is last year's;
     §2  the message: a forwarded multipart message gives up its PDF (nested
         parts, base64, an encoded filename, a forward-as-attachment), and it
         is read only from an allowed sender whom the receiving server passed
         — a stranger, a failed DMARC, a pass written by the sender itself
         below the server's fail, a look-alike server id, or no verdict at all
         are each rejected;
     §3  storing: one report per merchant and span, a re-sent one replacing it
         unless it is unusable and the held one usable; the same PDF attached
         twice is read once; a PDF with no merchant stores nothing;
     §4  IMAP, read-only: EXAMINE and BODY.PEEK only, a reply split anywhere
         across packets, and a message body that contains the tag cannot end
         the read; every message is recorded once with its outcome, a failed
         one is retried and blocks nothing after it; a refused login is a
         credential state;
     §5  the merge: on a fleet-day a report covers AND the sheet has, the
         bank's rows replace the sheet's, each taking the sheet's driver for
         its terminal that day (by amount, then an unmatched row, then the
         terminal's one driver, else nobody with the reason); a day the sheet
         has not reached waits; a terminal's fleet is the bank's merchant;
     §6  written: card_payment carries source, bank_ref and id_basis, the
         day's total is the bank's, and the shrink guard compares the sheet
         with the sheet.

   Synthetic data only: the PDFs and messages are built here. */
import { PGlite } from '@electric-sql/pglite';
import { EventEmitter } from 'node:events';
import { applySchema } from './schema.mjs';
import { parseReport, pdfLines, parseMime, checkOrigin, merchantsOf, ingestMessage, imapSession, collect, bankForMerge } from '../src/sources/ni_reports.js';
import { mergeBank, writeRead, parseSheet } from '../src/sources/network_cards.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const MERCHANTS = merchantsOf('200600000001:ecosine,200600000002:egari');
const OPTS = { senders: ['accounts@example.test'], authserv: 'filter.example.test', merchants: MERCHANTS };

/* A minimal PDF: one Courier text line per row, top to bottom. */
function makePdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  let y = 1150;
  const ops = lines.map((l) => { const op = `BT /F1 8 Tf 1 0 0 1 20 ${y} Tm (${esc(l)}) Tj ET`; y -= 12; return op; }).join('\n');
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 1191] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(ops)} >>\nstream\n${ops}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'];
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
    + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const reportLines = ({ merchant = '200600000001', name = 'ECOSINE TRANSPORTS', from = '25/11/2026', to = from, rows, statedCount, statedGross }) => {
  const gross = rows.reduce((a, r) => a + r.amt, 0);
  return ['MERCHANT TRANSACTION REPORT', `FROM ${from} TO ${to}`, `Merchant No : ${merchant}`, `Address : ${name}`,
    'Chain ID : 200000000009', 'Date : 26-Nov-2026', 'TRANSACTION DETAILS',
    'DTOF TRMNL CARD TRXN ACQ_REF_NBR AUTH TRAN MSF TXN VAT NET TRXN',
    ...rows.map((r, i) => `${r.day || '25/11'} ${r.term} 411111XXX${String(1000 + i)} ${r.type || 'SALES'} 7438231632902${String(1e9 + i)} A${String(10000 + i)} ${r.amt.toFixed(2)} ${(-r.amt * 0.0325).toFixed(2)} 0.00 ${(-r.amt * 0.0016).toFixed(2)} ${(r.amt * 0.9659).toFixed(2)} E/I`),
    `GRAND TOTAL OF POS TRANSACTIONS : ${String(statedCount ?? rows.length).padStart(5, '0')}`,
    `GRAND TOTAL VALUE OF POS TRANSACTIONS : ${(statedGross ?? gross).toFixed(2)}`,
    'GRAND TOTAL VALUE OF COMMISSION : -1.00', 'NET PAYABLE / RECEIVABLE 1.00'];
};

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 the report');
const ROWS = [{ term: '10389535', amt: 30 }, { term: '10389535', amt: 70 }, { term: '10392910', amt: 23.95, day: '24/11' }, { term: '10392910', amt: 123.75 }];
const good = parseReport(await pdfLines(makePdf(reportLines({ rows: ROWS }))), { merchants: MERCHANTS });
check('a PDF\'s lines become transactions: four rows, the merchant, the span, the fleet, every field',
  good.status === 'ok' && good.txns.length === 4 && good.merchant_no === '200600000001' && good.fleet_id === 'ecosine'
    && good.day_from === '2026-11-25' && good.txns[0].terminal_id === '10389535' && good.txns[0].amount === 30
    && good.txns[0].card_last4 === '1000' && good.txns[0].bank_ref.length >= 20 && good.txns[0].msf === -0.98, JSON.stringify(good).slice(0, 400));
check('…the bank\'s own date is kept (a 24/11 payment in the 25/11 report)', good.txns[2].txn_day === '2026-11-24');
check('…and the rows reproduce the stated count and total to the fil', good.totals.gross === 247.7 && good.stated.gross === 247.7 && good.stated.txns === 4);
const short = parseReport(await pdfLines(makePdf(reportLines({ rows: ROWS, statedGross: 250 }))), { merchants: MERCHANTS });
check('a total that does not add up keeps the report out, and says why', short.status === 'mismatch' && /247\.70 against the report's 250\.00/.test(short.why), short.why);
const unread = parseReport([...reportLines({ rows: ROWS }).slice(0, 9), '25/11 10389535 garbled row', ...reportLines({ rows: ROWS }).slice(9)], { merchants: MERCHANTS });
check('a transaction row that cannot be read keeps it out', unread.status === 'mismatch' && /could not be read/.test(unread.why), unread.why);
const other = parseReport(reportLines({ rows: ROWS, merchant: '200699999999' }), { merchants: MERCHANTS });
check('a merchant number not on the list keeps it out, whatever name it carries', other.status === 'mismatch' && other.fleet_id === null
  && /200699999999 is not one of the accepted merchant numbers/.test(other.why), other.why);
const named = parseReport(reportLines({ rows: ROWS, merchant: '200699999999', name: 'ECOSINE TRANSPORTS' }), { merchants: MERCHANTS });
check('…a stranger\'s report named "ECOSINE" included', named.status === 'mismatch' && named.fleet_id === null);
const span = parseReport(reportLines({ rows: ROWS, from: '24/11/2026', to: '25/11/2026' }), { merchants: MERCHANTS });
check('a report over several days is held until one is seen: which day each payment is filed under is not known', span.status === 'mismatch'
  && /spans 2026-11-24 to 2026-11-25/.test(span.why), span.why);
const refund = parseReport(reportLines({ rows: [...ROWS, { term: '10389535', amt: 20, type: 'REFUND' }] }), { merchants: MERCHANTS });
check('a transaction type not yet seen keeps it out until its sign is checked', refund.status === 'mismatch' && /REFUND/.test(refund.why), refund.why);
const ny = parseReport(reportLines({ from: '01/01/2027', rows: [{ term: '10389535', amt: 30, day: '31/12' }, { term: '10389535', amt: 40, day: '01/01' }] }), { merchants: MERCHANTS });
check('a 31/12 payment in a report for 01/01 is last year\'s', ny.txns[0].txn_day === '2026-12-31' && ny.txns[1].txn_day === '2027-01-01', JSON.stringify(ny.txns.map((t) => t.txn_day)));

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 the message');
const pdf = makePdf(reportLines({ rows: ROWS }));
const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const PASS = 'filter.example.test; iprev=pass; spf=pass smtp.mailfrom=example.test; dmarc=pass header.from=example.test';
const message = (pdfs, { id = '<r1@example.test>', from = 'Accounts <accounts@example.test>', auth = [PASS] } = {}) => Buffer.from([
  ...auth.map((a) => `Authentication-Results: ${a}`),
  `From: ${from}`, 'Subject: FW: MERCHANT TRANSACTION ACTIVITY - 200600000001 FROM 25/11/2026 TO',
  `Message-ID: ${id}`, 'Date: Thu, 26 Nov 2026 08:05:22 +0000', 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"', '', '--OUTER',
  'Content-Type: multipart/alternative; boundary="ALT"', '', '--ALT', 'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable', '', 'FYI =E2=80=94 the report is attached.', '--ALT',
  'Content-Type: text/html; charset="utf-8"', '', '<p>FYI</p>', '--ALT--',
  ...pdfs.flatMap((p, i) => ['--OUTER', `Content-Type: application/octet-stream; name="=?UTF-8?B?${Buffer.from(`PA_200600000001_${i}.PDF`).toString('base64')}?="`,
    'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="PA_200600000001_${i}.PDF"`, '', b64(p)]),
  '--OUTER--', ''].join('\r\n'), 'latin1');
const mime = parseMime(message([pdf]));
const att = mime.parts.find((p) => p.filename);
check('a forwarded multipart message gives up its PDF, byte for byte, with its filename',
  att && att.filename === 'PA_200600000001_0.PDF' && Buffer.compare(att.data, pdf) === 0, JSON.stringify(mime.parts.map((p) => [p.contentType, p.filename, p.data.length])));
check('…and its quoted-printable text decodes', mime.parts.some((p) => p.contentType === 'text/plain' && p.data.toString('utf8').includes('FYI — the report')));
const wrapped = Buffer.from(['Authentication-Results: ' + PASS, 'From: Accounts <accounts@example.test>', 'Subject: FW: report',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="W"', '', '--W', 'Content-Type: text/plain', '', 'see attached', '--W',
  'Content-Type: message/rfc822', '', message([pdf]).toString('latin1'), '--W--', ''].join('\r\n'), 'latin1');
const inner = parseMime(wrapped).parts.find((p) => p.filename);
check('a report forwarded as an attachment (message/rfc822) is opened and its PDF read', inner && Buffer.compare(inner.data, pdf) === 0,
  JSON.stringify(parseMime(wrapped).parts.map((p) => [p.contentType, p.filename])));
const origin = (raw) => checkOrigin(parseMime(raw).headerBlock, OPTS);
check('an allowed sender the receiving server passed: read', origin(message([pdf])).ok === true, JSON.stringify(origin(message([pdf]))));
check('a sender not on the list: rejected, and says who', !origin(message([pdf], { from: 'Someone <billing@elsewhere.test>' })).ok
  && /billing@elsewhere\.test is not one of the allowed senders/.test(origin(message([pdf], { from: 'billing@elsewhere.test' })).why));
const forged = origin(message([pdf], { auth: ['filter.example.test; spf=fail smtp.mailfrom=example.test; dmarc=fail header.from=example.test'] }));
check('a forged From the receiving server failed on DMARC: rejected', !forged.ok && /did not pass example\.test/.test(forged.why), forged.why);
const planted = origin(message([pdf], { auth: ['filter.example.test; dmarc=fail header.from=example.test', PASS] }));
check('…its own "pass" written below the server\'s fail does not rescue it', !planted.ok, JSON.stringify(planted));
const lookalike = origin(message([pdf], { auth: [PASS.replace('filter.example.test', 'evilfilter.example.test')] }));
check('a look-alike server id is not the receiving server: rejected', !lookalike.ok && /no authentication result/.test(lookalike.why), lookalike.why);
check('no verdict at all: rejected', !origin(message([pdf], { auth: [] })).ok);
check('another domain\'s pass does not vouch for this sender', !origin(message([pdf], { auth: ['filter.example.test; dmarc=pass header.from=elsewhere.test'] })).ok);

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 storing');
const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
const db = { query: (t, p) => pg.query(t, p) };
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
const stored = await ingestMessage(db, { raw: message([pdf, pdf]), uid: 7, uidvalidity: 99 }, { log: quiet, ...OPTS });
const [rep] = await q(`SELECT * FROM ni_report`);
const txns = await q(`SELECT * FROM ni_card_txn ORDER BY bank_ref`);
check('the same PDF attached twice is read once; the report and its four transactions stored', stored.status === 'ok' && stored.reports.length === 1
  && rep.status === 'ok' && Number(rep.gross) === 247.7 && txns.length === 4 && Number(rep.mail_uid) === 7, JSON.stringify(stored));
check('…each keyed by the bank\'s reference, with its fee, VAT and net', txns.every((t) => t.bank_ref && t.net != null && t.msf != null));
await ingestMessage(db, { raw: message([makePdf(reportLines({ rows: ROWS.slice(0, 3) }))], { id: '<r2@example.test>' }), uid: 8, uidvalidity: 99 }, { log: quiet, ...OPTS });
const reps = await q(`SELECT count(*)::int n, max(mail_uid)::int u, max(txns)::int t FROM ni_report`);
check('a report re-sent for the same merchant and day replaces the first, transactions and all',
  reps[0].n === 1 && reps[0].u === 8 && reps[0].t === 3 && (await q(`SELECT count(*)::int n FROM ni_card_txn`))[0].n === 3, JSON.stringify(reps));
const broken = await ingestMessage(db, { raw: message([makePdf(reportLines({ rows: ROWS, statedGross: 999 }))], { id: '<r2b@example.test>' }), uid: 9, uidvalidity: 99 }, { log: quiet, ...OPTS });
const kept = await q(`SELECT status, txns::int t, mail_uid::int u FROM ni_report`);
check('…but an unusable copy never replaces the usable one held', broken.reports[0].status === 'kept_earlier' && kept.length === 1
  && kept[0].status === 'ok' && kept[0].t === 3 && kept[0].u === 8 && (await q(`SELECT count(*)::int n FROM ni_card_txn`))[0].n === 3, JSON.stringify([broken, kept]));
const noMerchant = await ingestMessage(db, { raw: message([makePdf(['MERCHANT TRANSACTION REPORT', 'nothing else'])], { id: '<r2c@example.test>' }), uid: 10, uidvalidity: 99 }, { log: quiet, ...OPTS });
check('a PDF with no merchant or span is unreadable, and nothing is stored', noMerchant.status === 'unreadable'
  && (await q(`SELECT count(*)::int n FROM ni_report`))[0].n === 1, JSON.stringify(noMerchant));
const stranger = await ingestMessage(db, { raw: message([pdf], { from: 'x@elsewhere.test' }), uid: 11, uidvalidity: 99 }, { log: quiet, ...OPTS });
check('a message from a stranger is rejected before its PDF is opened', stranger.status === 'rejected' && stranger.reports.length === 0);

/* ── §4 ─────────────────────────────────────────────────────────────────── */
console.log('\n§4 IMAP, read-only');
const sent = [];
function fakeServer({ messages = {}, refuse = false } = {}) {
  return () => {
    const sock = new EventEmitter();
    const say = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); for (let i = 0; i < b.length; i += 7) { const part = b.subarray(i, i + 7); setImmediate(() => sock.emit('data', part)); } };
    sock.write = (line) => {
      const [tag, ...rest] = line.trim().split(' '); const c = rest.join(' '); sent.push(c.replace(/^LOGIN .*/, 'LOGIN ***'));
      if (/^LOGIN/.test(c)) say(refuse ? `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n` : `${tag} OK Logged in\r\n`);
      else if (/^EXAMINE/.test(c)) say(`* 2 EXISTS\r\n* OK [UIDVALIDITY 99] UIDs valid\r\n${tag} OK [READ-ONLY] Examine completed\r\n`);
      else if (/^UID SEARCH/.test(c)) say(`* SEARCH ${Object.keys(messages).join(' ')}\r\n${tag} OK Search completed\r\n`);
      else if (/^UID FETCH/.test(c)) {
        const uid = c.split(' ')[2]; const raw = messages[uid];
        say(Buffer.concat([Buffer.from(`* 1 FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK Fetch completed\r\n`)]));
      } else if (/^LOGOUT/.test(c)) say(`* BYE\r\n${tag} OK Logout\r\n`);
    };
    sock.end = () => {}; sock.destroy = () => {};
    setImmediate(() => say('* OK [CAPABILITY IMAP4rev1] ready\r\n'));
    return sock;
  };
}
/* A body that contains what looks like this session's tags. */
const tricky = Buffer.concat([message([pdf], { id: '<r3@example.test>' }), Buffer.from('\r\nN4 OK not the end\r\nN5 OK nor this\r\n')]);
await q('DELETE FROM ni_report');
const run1 = await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, connect: fakeServer({ messages: { 7: tricky } }) }) });
check('a reply split every 7 bytes, and a body holding "N4 OK", are read whole: the report is stored',
  run1.reports?.length === 1 && run1.reports[0].status === 'ok' && run1.reports[0].txns === 4, JSON.stringify(run1));
check('…read-only: EXAMINE and BODY.PEEK, never SELECT, STORE, COPY, MOVE or EXPUNGE',
  sent.some((c) => /^EXAMINE/.test(c)) && sent.some((c) => /BODY\.PEEK\[\]/.test(c)) && !sent.some((c) => /^(SELECT|STORE|COPY|MOVE|EXPUNGE|UID (STORE|COPY|MOVE|EXPUNGE))/.test(c)), JSON.stringify(sent));
sent.length = 0;
const run2 = await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, connect: fakeServer({ messages: { 7: tricky } }) }) });
check('a message already read is not fetched again', run2.skipped_known === 1 && !sent.some((c) => /FETCH/.test(c)), JSON.stringify(run2));
/* One message that fails (the database refuses its report once), one from a
   stranger and one good one: the failure is recorded and retried, and blocks
   nothing; the stranger's is recorded once and never fetched again. */
await q('DELETE FROM ni_report'); await q('DELETE FROM ni_mail_message');
const egari = makePdf(reportLines({ rows: ROWS, merchant: '200600000002', name: 'EGARI' }));
const box = { 20: message([pdf], { id: '<f1@example.test>' }), 21: message([pdf], { id: '<s1@example.test>', from: 'x@elsewhere.test' }),
  22: message([egari], { id: '<g1@example.test>' }) };
let refuseOnce = true;
const flaky = { query: (t, p) => (refuseOnce && /INSERT INTO ni_report/.test(t) ? (refuseOnce = false, Promise.reject(new Error('connection reset'))) : pg.query(t, p)) };
const run3 = await collect({ db: flaky, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, connect: fakeServer({ messages: box }) }) });
const book = async () => Object.fromEntries((await q(`SELECT mail_uid::int u, status, attempts FROM ni_mail_message`)).map((r) => [r.u, `${r.status}/${r.attempts}`]));
const b3 = await book();
check('one failed message blocks nothing after it: the good one is stored, each outcome recorded', run3.reports.length === 1
  && run3.reports[0].fleet === 'egari' && b3[20] === 'error/1' && b3[21] === 'rejected/1' && b3[22] === 'ok/1', JSON.stringify([run3, b3]));
sent.length = 0;
await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, connect: fakeServer({ messages: box }) }) });
const b4 = await book();
check('…the next read retries only the failed one; the rejected and the read are not fetched again', b4[20] === 'ok/2'
  && b4[21] === 'rejected/1' && b4[22] === 'ok/1' && sent.filter((c) => /FETCH/.test(c)).length === 1, JSON.stringify([b4, sent]));
check('…and the rejected message left nothing in the reports', (await q(`SELECT count(*)::int n FROM ni_report`))[0].n === 2);
const bad = await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p',
  session: (o) => imapSession({ ...o, connect: fakeServer({ refuse: true }) }) });
const credRow = (await q(`SELECT state FROM credential_state WHERE credential = 'NI_MAIL_PASS'`).catch(() => []))[0];
check('a refused login is an error and a credential state, not silence', bad.error && /AUTHENTICATIONFAILED/.test(bad.error) && credRow?.state === 'invalid',
  JSON.stringify([bad, credRow]));
check('nothing configured: skipped, and no connection made', (await collect({ db, log: quiet, host: '', user: '', pass: '' })).skipped);

/* ── §5 ─────────────────────────────────────────────────────────────────── */
console.log('\n§5 the merge');
const sheetRow = (row_no, day, fleet, terminal, amount, eid, label = null) => ({ row_no, txn_day: day, fleet_id: fleet, terminal_id: terminal, amount, emirates_id: eid, id_label: label });
const E1 = '784200000000001'; const E2 = '784200000000002'; const E3 = '784200000000003';
const sheet = [
  sheetRow(2, '2026-11-24', 'ecosine', '10392910', 10, E2),          // a day no report covers: kept
  sheetRow(3, '2026-11-25', 'ecosine', '10389535', 30, E1),          // matched by amount
  sheetRow(4, '2026-11-25', 'ecosine', '10389535', 70, E1),
  sheetRow(5, '2026-11-25', 'ecosine', '10392910', 23.95, E2),       // the late payment, under the 25th
  sheetRow(6, '2026-11-25', 'ecosine', '10392910', 120, E2),         // the bank says 123.75
  sheetRow(7, '2026-11-25', 'ecosine', '10397223', 50, null, 'Not Found'),
  sheetRow(8, '2026-11-20', 'ecosine', '10403934', 15, E3),          // the terminal's earlier driver: never borrowed
  sheetRow(9, '2026-11-25', 'ecosine', '10999999', 5, E3),           // on the sheet only
  sheetRow(10, '2026-11-25', 'egari', '10413936', 60, E1),           // the other fleet, no report: kept
  sheetRow(11, '2026-11-25', 'ecosine', '10600000', 30, E1),         // two drivers on one terminal
  sheetRow(12, '2026-11-25', 'ecosine', '10600000', 45, E2),
  sheetRow(13, '2026-11-25', 'ecosine', '10700000', 20, E1),
  sheetRow(14, '2026-11-25', 'ecosine', '10700000', 25, E3),
  sheetRow(15, '2026-11-25', 'egari', '10392910', 5, E2),            // Platform says Egari; the terminal settles to Ecosine
];
const bankTx = (ref, day, term, amount, reportDay = '2026-11-25', fleet = 'ecosine') => ({ bank_ref: ref, terminal_id: term, report_day: reportDay, txn_day: day, amount, txn_type: 'SALES', fleet_id: fleet });
const bank = { covered: [{ fleet_id: 'ecosine', day: '2026-11-25' }, { fleet_id: 'ecosine', day: '2026-11-26' }],
  terminalFleet: { 10392910: 'ecosine', 10389535: 'ecosine' },
  txns: [
    bankTx('R1', '2026-11-25', '10389535', 30), bankTx('R2', '2026-11-25', '10389535', 70), bankTx('R3', '2026-11-24', '10392910', 23.95),
    bankTx('R4', '2026-11-25', '10392910', 123.75), bankTx('R5', '2026-11-25', '10397223', 50), bankTx('R6', '2026-11-25', '10403934', 40),
    bankTx('R7', '2026-11-25', '10500000', 9), bankTx('R8', '2026-11-25', '10600000', 44), bankTx('R9', '2026-11-25', '10600000', 30),
    bankTx('R10', '2026-11-25', '10392910', 12), bankTx('R11', '2026-11-25', '10700000', 20), bankTx('R12', '2026-11-25', '10700000', 25),
    bankTx('R13', '2026-11-25', '10700000', 31), bankTx('R14', '2026-11-25', '10392910', 5),
    bankTx('R20', '2026-11-26', '10389535', 66, '2026-11-26')] };
const m = mergeBank(sheet, bank);
const by = (ref) => m.rows.find((r) => r.bank_ref === ref);
check('rows on days no report covers stay the sheet\'s — another day, the other fleet',
  m.rows.filter((r) => r.source === 'network_sheet').map((r) => r.row_no).sort((a, b) => a - b).join() === '2,8,10', JSON.stringify(m.rows.filter((r) => r.source === 'network_sheet')));
check('a covered day\'s rows are the bank\'s, every one of them, and none of the sheet\'s', m.rows.filter((r) => r.source === 'network_report').length === 14
  && !m.rows.some((r) => r.source === 'network_sheet' && r.txn_day === '2026-11-25' && r.terminal_id !== '10413936'));
check('a day the bank reports but the sheet has not reached waits: none of its rows, the day not covered — the cash texts wait as before',
  !by('R20') && !m.covered.includes('ecosine|2026-11-26'), JSON.stringify(m.covered));
check('1. the same terminal, day and amount: the sheet\'s driver', by('R1').emirates_id === E1 && by('R1').id_basis === 'sheet_same_payment');
check('2. the same terminal and day, another amount: the unmatched row\'s driver, at the bank\'s amount',
  by('R4').emirates_id === E2 && by('R4').id_basis === 'sheet_same_terminal_day' && by('R4').amount === 123.75);
check('…an exact match is never taken by a near one, and a row once taken is not taken again: 44 goes to the 45 row\'s driver, not the 30 row\'s',
  by('R9').emirates_id === E1 && by('R9').id_basis === 'sheet_same_payment' && by('R8').emirates_id === E2 && by('R8').id_basis === 'sheet_same_terminal_day');
check('3. every row on the terminal already taken, one driver there that day: that driver', by('R10').emirates_id === E2 && by('R10').id_basis === 'sheet_terminal_driver');
check('4. several drivers on the terminal and nothing to tell them apart: nobody, and said so', by('R13').emirates_id === null
  && by('R13').id_basis === 'none' && /several drivers/.test(by('R13').id_label));
check('…a terminal the sheet has not mapped that day: nobody — never its driver from an earlier day', by('R6').emirates_id === null
  && by('R6').id_basis === 'none' && /maps no driver to this terminal that day/.test(by('R6').id_label));
check('…the sheet\'s "Not Found" travels with its match', by('R5').emirates_id === null && by('R5').id_label === 'Not Found');
check('the late payment keeps the bank\'s date (24th), the driver from the sheet\'s 25th', by('R3').txn_day === '2026-11-24' && by('R3').emirates_id === E2);
check('a row whose Platform cell disagrees with the bank\'s merchant follows the merchant: replaced, not counted twice',
  by('R14').emirates_id === E2 && by('R14').id_basis === 'sheet_same_payment' && !m.rows.some((r) => r.source === 'network_sheet' && r.row_no === 15));
check('a sheet row the bank does not have is reported, not kept', m.sheet_only.length === 1 && m.sheet_only[0].terminal_id === '10999999', JSON.stringify(m.sheet_only.map((r) => r.terminal_id)));
check('no report: the sheet\'s rows, all of them, marked as the sheet\'s', mergeBank(sheet, null).rows.every((r) => r.source === 'network_sheet' && r.id_basis === 'sheet') && mergeBank(sheet, null).rows.length === sheet.length);

/* ── §6 ─────────────────────────────────────────────────────────────────── */
console.log('\n§6 written');
const toValues = (rows) => [['Emirates ID', 'Date', 'Platform', 'TRMNL ID', 'TRAN AMT'],
  ...rows.map((r) => [r.emirates_id || r.id_label, r.txn_day.split('-').reverse().join('/'), r.fleet_id === 'ecosine' ? 'Ecosine' : 'Egari', r.terminal_id, String(r.amount)])];
const parsed = parseSheet(toValues(sheet));
await q('DELETE FROM card_payment');
const imp = await writeRead(db, parsed, { range: 'test', bank });
const cp = await q(`SELECT source, bank_ref, id_basis, emirates_id, txn_day::text d, amount::float a FROM card_payment ORDER BY source, bank_ref, d`);
check('card_payment carries source, bank_ref and id_basis for every row', imp.status === 'ok' && cp.length === 17
  && cp.filter((r) => r.source === 'network_report').every((r) => r.bank_ref && r.id_basis) && cp.filter((r) => r.source === 'network_sheet').every((r) => !r.bank_ref && r.id_basis === 'sheet'),
  JSON.stringify([imp.status, imp.why, cp.length]));
const day25 = cp.filter((r) => r.source === 'network_report').reduce((a, r) => a + r.a, 0);
const want25 = bank.txns.filter((t) => t.report_day === '2026-11-25').reduce((a, t) => a + t.amount, 0);
check('…the covered day\'s total is the bank\'s', Math.abs(day25 - want25) < 0.005, `${day25} ${want25}`);
const again = await writeRead(db, parsed, { range: 'test', bank });
check('a second read replaces, never doubles', again.status === 'ok' && (await q('SELECT count(*)::int n FROM card_payment'))[0].n === 17);
/* A broken read that kept ONE of the 25th's rows: the day stays covered, so
   the bank's 14 rows would pad the merged count back up (16 of 17). Counted
   sheet against sheet, it is 4 of 13, and held. */
const thin = parseSheet(toValues(sheet.filter((r) => r.row_no <= 3 || r.row_no === 8 || r.row_no === 10)));
const held = await writeRead(db, thin, { range: 'test', bank });
check('the shrink guard compares the sheet with the sheet: the bank\'s rows cannot stand in for rows a broken read lost',
  held.status === 'held' && /keeps 4 of the sheet's 13 stored payments/.test(held.why)
  && (await q('SELECT count(*)::int n FROM card_payment'))[0].n === 17, JSON.stringify([held.status, held.why]));
await q('DELETE FROM ni_report'); await q('DELETE FROM ni_mail_message');
await ingestMessage(db, { raw: message([pdf]), uid: 30, uidvalidity: 99 }, { log: quiet, ...OPTS });
await ingestMessage(db, { raw: message([makePdf(reportLines({ rows: ROWS, merchant: '200699999999' }))], { id: '<x@example.test>' }), uid: 31, uidvalidity: 99 }, { log: quiet, ...OPTS });
const fromDb = await bankForMerge(db);
check('the merge reads only usable reports and the days they cover, and learns each terminal\'s fleet from the bank', fromDb.covered.length === 1
  && fromDb.covered[0].day === '2026-11-25' && fromDb.txns.length === 4 && fromDb.terminalFleet['10389535'] === 'ecosine', JSON.stringify(fromDb.covered));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
