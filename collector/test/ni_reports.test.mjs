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
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { applySchema } from './schema.mjs';
import { parseReport, pdfLines, parseMime, checkOrigin, merchantsOf, ingestMessage, imapSession, collect, bankForMerge, SENDER,
  splitMessage, canonHeader, canonBody, parseAuthResults } from '../src/sources/ni_reports.js';
import { mergeBank, writeRead, parseSheet } from '../src/sources/network_cards.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const MERCHANTS = merchantsOf('200600000001:ecosine,200600000002:egari');
/* The receiving filter: its key, published in a fake DNS, seals messages the
   way the real one does (ARC, rsa-sha256, relaxed/relaxed). The signer below
   is the verifier's mirror; the real reports' seals, signed by the real
   filter, are what prove the canonicalisation (FIX-STATUS NIR, the dry run). */
const FILTER_D = 'incoming.x1.filter.example.test';
const filterKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const spki = (k) => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const DNS = { [`arckey._domainkey.${FILTER_D}`]: `k=rsa; p=${spki(filterKey)}`, 'sel1._domainkey.relay.other.test': `k=rsa; p=${spki(otherKey)}` };
let dnsDown = false;
const resolveTxt = async (name) => {
  if (dnsDown) throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
  if (DNS[name]) return [[DNS[name]]];
  throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
};
const MAILBOX = 'cardreports@mailbox.test';
const OPTS = { senders: ['accounts@example.test'], authserv: 'filter.example.test', merchants: MERCHANTS, resolveTxt, mailbox: MAILBOX };
const VERDICT = 'filter.example.test; iprev=pass smtp.remote-ip=192.0.2.1; spf=pass smtp.mailfrom=example.test; dmarc=pass header.from=example.test';
function arcSeal(raw, { i = 1, d = FILTER_D, s = 'arckey', key = filterKey.privateKey, aar = VERDICT, cv = i === 1 ? 'none' : 'pass',
  h = 'MIME-Version:Content-Type:Message-ID:Date:Subject:To:From' } = {}) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw;
  const { fields, body } = splitMessage(text);
  const bh = createHash('sha256').update(canonBody(body, 'relaxed'), 'latin1').digest('base64');
  const aarH = `ARC-Authentication-Results: i=${i}; ${aar}\r\n`;
  let amsH = `ARC-Message-Signature: i=${i}; a=rsa-sha256; c=relaxed/relaxed; d=${d}; s=${s};\r\n h=${h}; bh=${bh}; b=\r\n`;
  const used = new Set(); let data = '';
  for (const name of h.toLowerCase().split(':')) {
    for (let k = fields.length - 1; k >= 0; k -= 1) if (fields[k].name === name && !used.has(k)) { used.add(k); data += canonHeader(fields[k].text); break; }
  }
  data += canonHeader(amsH).replace(/\r\n$/, '');
  amsH = amsH.replace(/b=\r\n$/, `b=${sign('sha256', Buffer.from(data, 'latin1'), key).toString('base64')}\r\n`);
  let asH = `ARC-Seal: i=${i}; a=rsa-sha256; cv=${cv}; d=${d}; s=${s}; b=\r\n`;
  const inst = (f) => Number((f.text.match(/:\s*i\s*=\s*(\d+)/) || [])[1]);
  let sd = '';
  for (let j = 1; j < i; j += 1) {
    for (const n of ['arc-authentication-results', 'arc-message-signature', 'arc-seal']) sd += canonHeader(fields.find((f) => f.name === n && inst(f) === j).text);
  }
  sd += canonHeader(aarH) + canonHeader(amsH) + canonHeader(asH).replace(/\r\n$/, '');
  asH = asH.replace(/b=\r\n$/, `b=${sign('sha256', Buffer.from(sd, 'latin1'), key).toString('base64')}\r\n`);
  return Buffer.from(asH + amsH + aarH + text, 'latin1');
}

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
const twice = reportLines({ rows: ROWS }); twice.splice(9, 1, twice[8]);
const dup = parseReport(twice.map((l, i) => (i === 9 ? l.replace(/ 30\.00 /, ' 70.00 ') : l)), { merchants: MERCHANTS });
check('one bank reference on two rows keeps the report out (storing would drop one of them)', dup.status === 'mismatch'
  && /same bank reference appears on two rows/.test(dup.why), dup.why);
const refund = parseReport(reportLines({ rows: [...ROWS, { term: '10389535', amt: 20, type: 'REFUND' }] }), { merchants: MERCHANTS });
check('a transaction type not yet seen keeps it out until its sign is checked', refund.status === 'mismatch' && /REFUND/.test(refund.why), refund.why);
const ny = parseReport(reportLines({ from: '01/01/2027', rows: [{ term: '10389535', amt: 30, day: '31/12' }, { term: '10389535', amt: 40, day: '01/01' }] }), { merchants: MERCHANTS });
check('a 31/12 payment in a report for 01/01 is last year\'s', ny.txns[0].txn_day === '2026-12-31' && ny.txns[1].txn_day === '2027-01-01', JSON.stringify(ny.txns.map((t) => t.txn_day)));

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 the message');
const pdf = makePdf(reportLines({ rows: ROWS }));
const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const PASS = VERDICT;
const unsealed = (pdfs, { id = '<r1@example.test>', from = 'Accounts <accounts@example.test>', auth = [PASS], date = 'Thu, 26 Nov 2026 08:05:22 +0000',
  to = `"Card reports" <${MAILBOX}>` } = {}) => Buffer.from([
  ...auth.map((a) => `Authentication-Results: ${a}`),
  ...[].concat(from).map((f) => `From: ${f}`), `To: ${to}`, 'Subject: FW: MERCHANT TRANSACTION ACTIVITY - 200600000001 FROM 25/11/2026 TO',
  `Message-ID: ${id}`, `Date: ${date}`, 'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="OUTER"', '', '--OUTER',
  'Content-Type: multipart/alternative; boundary="ALT"', '', '--ALT', 'Content-Type: text/plain; charset="utf-8"',
  'Content-Transfer-Encoding: quoted-printable', '', 'FYI =E2=80=94 the report is attached.', '--ALT',
  'Content-Type: text/html; charset="utf-8"', '', '<p>FYI</p>', '--ALT--',
  ...pdfs.flatMap((p, i) => ['--OUTER', `Content-Type: application/octet-stream; name="=?UTF-8?B?${Buffer.from(`PA_200600000001_${i}.PDF`).toString('base64')}?="`,
    'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="PA_200600000001_${i}.PDF"`, '', b64(p)]),
  '--OUTER--', ''].join('\r\n'), 'latin1');
const message = (pdfs, o = {}) => arcSeal(unsealed(pdfs, o), o.seal || {});
const mime = parseMime(message([pdf]));
const att = mime.parts.find((p) => p.filename);
check('a forwarded multipart message gives up its PDF, byte for byte, with its filename',
  att && att.filename === 'PA_200600000001_0.PDF' && Buffer.compare(att.data, pdf) === 0, JSON.stringify(mime.parts.map((p) => [p.contentType, p.filename, p.data.length])));
check('…and its quoted-printable text decodes', mime.parts.some((p) => p.contentType === 'text/plain' && p.data.toString('utf8').includes('FYI — the report')));
const wrapped = Buffer.from(['From: Accounts <accounts@example.test>', 'Subject: FW: report',
  'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="W"', '', '--W', 'Content-Type: text/plain', '', 'see attached', '--W',
  'Content-Type: message/rfc822', '', unsealed([pdf]).toString('latin1'), '--W--', ''].join('\r\n'), 'latin1');
const inner = parseMime(wrapped).parts.find((p) => p.filename);
check('a report forwarded as an attachment (message/rfc822) is opened and its PDF read', inner && Buffer.compare(inner.data, pdf) === 0,
  JSON.stringify(parseMime(wrapped).parts.map((p) => [p.contentType, p.filename])));
const origin = (raw, o = {}) => checkOrigin(raw, { ...OPTS, ...o });
const ok0 = await origin(message([pdf]));
check('an allowed sender, sealed by the receiving filter with a DMARC pass: read', ok0.ok === true, JSON.stringify(ok0));
const two = await origin(arcSeal(arcSeal(unsealed([pdf]), { d: 'relay.other.test', s: 'sel1', key: otherKey.privateKey, aar: 'relay.other.test; spf=pass smtp.mailfrom=example.test' }), { i: 2 }));
check('…the real shape, the filter\'s seal over an earlier relay\'s (i=2 over i=1): read', two.ok === true, JSON.stringify(two));
const rej = async (label, raw, re, o) => { const r = await origin(raw, o); check(label, r.ok === false && re.test(r.why || ''), JSON.stringify(r)); };
const nifax = await checkOrigin(unsealed([pdf], { from: 'NI Merchant HD <nifax@network.ae>' }), { authserv: 'filter.example.test', resolveTxt, mailbox: MAILBOX });
check('ONE sender, by the operator\'s ruling: accounts@arks.ae, and even the bank\'s own address is not read', SENDER === 'accounts@arks.ae'
  && nifax.ok === false && /nifax@network\.ae is not one of the allowed senders/.test(nifax.why), JSON.stringify(nifax));
await rej('a sender not on the list: rejected, and says who', message([pdf], { from: 'Someone <billing@elsewhere.test>' }), /billing@elsewhere\.test is not one of the allowed senders/);
await rej('a forged From the filter failed on DMARC: rejected', message([pdf], { seal: { aar: 'filter.example.test; spf=pass smtp.mailfrom=evil.test; dmarc=fail header.from=example.test' } }), /did not pass example\.test on DMARC/);
await rej('a "dmarc=pass…header.from=" echoed inside another entry (a DKIM selector) is not a DMARC result: the real fail stands',
  message([pdf], { seal: { aar: 'filter.example.test; spf=pass smtp.mailfrom=evil.test; dkim=pass header.d=evil.test header.s=dmarc=pass.header.from=example.test header.a=rsa-sha256; dmarc=fail header.from=example.test' } }),
  /dmarc=fail/);
await rej('…a pass and a fail in one verdict: rejected', message([pdf], { seal: { aar: `${VERDICT}; dmarc=fail header.from=example.test` } }), /dmarc=fail/);
await rej('a DMARC pass with no aligned SPF or DKIM pass in the sealed verdict: rejected — an unsealed header saying so does not vouch',
  message([pdf], { seal: { aar: 'filter.example.test; spf=pass smtp.mailfrom=evil.test; dmarc=pass header.from=example.test' } }), /no SPF or DKIM pass aligned/);
await rej('delivered past the filter, with its own "pass" header and no seal: rejected', unsealed([pdf]), /did not seal the message/);
await rej('a seal claiming the filter\'s name, signed with another key: rejected', message([pdf], { seal: { key: otherKey.privateKey } }), /message signature does not verify/);
const sealed = message([pdf]).toString('latin1');
await rej('the PDF changed after sealing: rejected', Buffer.from(sealed.replace(/(Content-Disposition: attachment[^\n]*\n\r\n)([A-Za-z0-9+/])/, (m, a, c) => a + (c === 'A' ? 'B' : 'A')), 'latin1'), /body is not the one the filter sealed/);
await rej('the From changed after sealing: rejected', Buffer.from(sealed.replace('From: Accounts <accounts@example.test>', 'From: Billing <accounts@example.test>'), 'latin1'), /message signature does not verify/);
await rej('…the subject changed after sealing: rejected', Buffer.from(sealed.replace('Subject: FW: MERCHANT', 'Subject: FW: MERCHANT!'), 'latin1'), /message signature does not verify/);
await rej('a filter verdict outside the seal that says fail: rejected', message([pdf], { auth: [`filter.example.test; dmarc=fail header.from=example.test`] }), /did not pass/);
await rej('a look-alike filter name: rejected', message([pdf], { seal: { d: 'incoming.evilfilter.example.test' } }), /not the receiving filter's/);
await rej('two From headers: rejected', message([pdf], { from: ['Accounts <accounts@example.test>', 'x@elsewhere.test'] }), /more than one From header/);
await rej('an address inside a quoted display name is not the address', message([pdf], { from: '"<accounts@example.test>" <noreply@example.test>' }), /noreply@example\.test is not one of the allowed senders/);
const gone = await origin(message([pdf], { seal: { s: 'gone' } })).then(() => null, (e) => e);
check('the filter\'s key not found: retried, never a permanent rejection (a resolver\'s negative answer or a key change)', gone?.retry === true, String(gone));
const top = (raw, line) => Buffer.from(`${line}\r\n${raw.toString('latin1')}`, 'latin1');
await rej('an unsigned Content-Type added on top of a sealed message: rejected (it would choose the MIME boundary)',
  top(message([pdf]), 'Content-Type: multipart/mixed; boundary="EVIL"'), /2 content-type headers/);
await rej('…an unsigned Subject added on top: rejected', top(message([pdf]), 'Subject: MERCHANT TRANSACTION ACTIVITY'), /2 subject headers/);
await rej('a genuine seal on mail to another of the filter\'s customers: rejected', message([pdf], { to: 'someone@elsewhere.test' }), /not addressed to this mailbox/);
await rej('a seal whose signature does not cover To: rejected', message([pdf], { seal: { h: 'MIME-Version:Content-Type:Message-ID:Date:Subject:From' } }), /does not cover to/);
const tiny = generateKeyPairSync('rsa', { modulusLength: 768 });
DNS[`tiny._domainkey.${FILTER_D}`] = `k=rsa; p=${spki(tiny)}`;
await rej('a key under 1024 bits is refused (RFC 8301)', message([pdf], { seal: { s: 'tiny', key: tiny.privateKey } }), /under 1024 bits/);
await rej('no mailbox address configured: the To cannot be checked, so nothing is read', message([pdf]), /mailbox address is not configured/, { mailbox: '' });
dnsDown = true;
const down = await origin(message([pdf])).then(() => null, (e) => e);
dnsDown = false;
check('a DNS failure worth retrying throws, so the message is retried rather than rejected', down && down.retry === true, String(down));
const pa = parseAuthResults('mx.example (comment; dmarc=pass) 1; dkim=pass (good) header.d="a.test"; reason="x;y" dmarc=pass header.from=a.test');
check('the verdict is read token by token: comments dropped, quoted ";" kept inside its entry', pa.authserv === 'mx.example'
  && pa.results.length === 2 && pa.results[0].props['header.d'] === 'a.test' && pa.results[1].method === '?', JSON.stringify(pa));

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
const newer = await ingestMessage(db, { raw: message([makePdf(reportLines({ rows: ROWS.slice(0, 2) }))], { id: '<r2n@example.test>', date: 'Fri, 27 Nov 2026 08:00:00 +0000' }), uid: 12, uidvalidity: 99 }, { log: quiet, ...OPTS });
const older = await ingestMessage(db, { raw: message([makePdf(reportLines({ rows: ROWS }))], { id: '<r2o@example.test>', date: 'Wed, 25 Nov 2026 20:00:00 +0000' }), uid: 13, uidvalidity: 99 }, { log: quiet, ...OPTS });
const held2 = await q(`SELECT txns::int t, mail_uid::int u FROM ni_report`);
check('…and an older copy, read after a newer one (a retry), never replaces it', newer.reports[0].status === 'ok' && older.reports[0].status === 'kept_earlier'
  && held2[0].t === 2 && held2[0].u === 12, JSON.stringify(held2));
const noMerchant = await ingestMessage(db, { raw: message([makePdf(['MERCHANT TRANSACTION REPORT', 'nothing else'])], { id: '<r2c@example.test>' }), uid: 10, uidvalidity: 99 }, { log: quiet, ...OPTS });
check('a PDF with no merchant or span is unreadable, and nothing is stored', noMerchant.status === 'unreadable'
  && (await q(`SELECT count(*)::int n FROM ni_report`))[0].n === 1, JSON.stringify(noMerchant));
const stranger = await ingestMessage(db, { raw: message([pdf], { from: 'x@elsewhere.test' }), uid: 11, uidvalidity: 99 }, { log: quiet, ...OPTS });
check('a message from a stranger is rejected before its PDF is opened', stranger.status === 'rejected' && stranger.reports.length === 0);

/* ── §4 ─────────────────────────────────────────────────────────────────── */
console.log('\n§4 IMAP, read-only');
const sent = [];
function fakeServer({ messages = {}, refuse = false, silent = {}, wrongUid = {}, size = {}, unsolicited = {} } = {}) {
  return () => {
    const sock = new EventEmitter();
    const say = (s) => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'); for (let i = 0; i < b.length; i += 7) { const part = b.subarray(i, i + 7); setImmediate(() => sock.emit('data', part)); } };
    sock.write = (line) => {
      const [tag, ...rest] = line.trim().split(' '); const c = rest.join(' '); sent.push(c.replace(/^LOGIN .*/, 'LOGIN ***'));
      if (/^LOGIN/.test(c)) say(refuse ? `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n` : `${tag} OK Logged in\r\n`);
      else if (/^EXAMINE/.test(c)) say(`* 2 EXISTS\r\n* OK [UIDVALIDITY 99] UIDs valid\r\n${tag} OK [READ-ONLY] Examine completed\r\n`);
      else if (/^UID SEARCH/.test(c)) say(`* SEARCH ${Object.keys(messages).join(' ')}\r\n${tag} OK Search completed\r\n`);
      else if (/^UID FETCH \d+ \(RFC822\.SIZE\)/.test(c)) {
        const uid = c.split(' ')[2];
        say(`${unsolicited[uid] ? '* 9 FETCH (UID 99 FLAGS (\\Seen))\r\n' : ''}* 1 FETCH (UID ${uid} RFC822.SIZE ${size[uid] ?? messages[uid].length})\r\n${tag} OK Fetch completed\r\n`);
      } else if (/^UID FETCH/.test(c)) {
        const uid = c.split(' ')[2]; const raw = messages[uid];
        const reply = () => say(Buffer.concat([Buffer.from(`${unsolicited[uid] ? '* 9 FETCH (UID 99 FLAGS (\\Seen))\r\n' : ''}* 1 FETCH (UID ${wrongUid[uid] || uid} BODY[] {${raw.length}}\r\n`), raw, Buffer.from(`)\r\n${tag} OK Fetch completed\r\n`)]));
        if (silent[uid]) setTimeout(reply, 150); else reply();
      } else if (/^LOGOUT/.test(c)) say(`* BYE\r\n${tag} OK Logout\r\n`);
    };
    sock.end = () => {}; sock.destroy = () => {};
    setImmediate(() => say('* OK [CAPABILITY IMAP4rev1] ready\r\n'));
    return sock;
  };
}
/* A body that contains what looks like this session's tags. */
const tricky = arcSeal(Buffer.concat([unsealed([pdf], { id: '<r3@example.test>' }), Buffer.from('\r\nN4 OK not the end\r\nN5 OK nor this\r\n')]));
await q('DELETE FROM ni_report');
const run1 = await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, connect: fakeServer({ messages: { 7: tricky } }) }) });
check('a reply split every 7 bytes, and a body holding "N4 OK", are read whole: the report is stored',
  run1.reports?.length === 1 && run1.reports[0].status === 'ok' && run1.reports[0].txns === 4, JSON.stringify(run1));
check('the mailbox is asked for the one sender\'s messages only: other mail is never fetched',
  sent.some((c) => /^UID SEARCH SINCE \S+ FROM "accounts@example\.test" SUBJECT "MERCHANT TRANSACTION ACTIVITY"$/.test(c)), JSON.stringify(sent.filter((c) => /SEARCH/.test(c))));
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
  && b4[21] === 'rejected/1' && b4[22] === 'ok/1' && sent.filter((c) => /BODY\.PEEK/.test(c)).length === 1, JSON.stringify([b4, sent]));
check('…and the rejected message left nothing in the reports', (await q(`SELECT count(*)::int n FROM ni_report`))[0].n === 2);
/* A fetch that times out ends the session: its late reply must never be taken
   as the next message's (the second review). */
await q('DELETE FROM ni_mail_message');
const slowBox = { 40: message([pdf], { id: '<t40@example.test>' }), 41: message([egari], { id: '<t41@example.test>' }) };
const run5 = await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, timeoutMs: 60, connect: fakeServer({ messages: slowBox, silent: { 40: true } }) }) });
await new Promise((r) => setTimeout(r, 250));
const b5 = await book();
check('a fetch that times out is recorded, and the next message is read on a FRESH session — one message cannot stop the rest',
  b5[40] === 'error/1' && b5[41] === 'ok/1' && !run5.stopped, JSON.stringify([b5, run5.stopped]));
const direct = imapSession({ host: 'imap.example.test', timeoutMs: 60, connect: fakeServer({ messages: slowBox, silent: { 40: true } }) });
await direct.login('u', 'p'); await direct.examine('INBOX');
const t1 = await direct.fetchRaw(40).then(() => 'answered', (e) => e.message);
const t2 = await direct.uidSearch('ALL').then(() => 'answered', (e) => e.message);
check('…the session itself is ended by a timeout: the next command fails rather than read a late reply', /timed out/.test(t1) && /timed out/.test(t2), JSON.stringify([t1, t2]));
await new Promise((r) => setTimeout(r, 200));
await q('DELETE FROM ni_mail_message');
const run6 = await collect({ db, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS,
  session: (o) => imapSession({ ...o, connect: fakeServer({ messages: slowBox, wrongUid: { 40: 41 } }) }) });
const b6 = await book();
check('an answer for another message than the one asked for is refused, and the next is read on a fresh session', b6[40] === 'error/1' && b6[41] === 'ok/1',
  JSON.stringify([b6, run6]));
await q('DELETE FROM ni_mail_message');
const timeline = [];
const spyDb = { query: (t, p) => { if (/INSERT INTO ni_mail_message/.test(t)) timeline.push(`db:attempt ${p[1]}`); return pg.query(t, p); } };
const big = { 50: message([pdf], { id: '<b50@example.test>' }), 51: message([pdf], { id: '<b51@example.test>' }), 52: message([egari], { id: '<b52@example.test>' }) };
const run7 = await collect({ db: spyDb, log: quiet, host: 'imap.example.test', user: 'u', pass: 'p', readOpts: OPTS, maxBytes: big[50].length - 1,
  session: (o) => imapSession({ ...o, connect: (...a) => { const sock = fakeServer({ messages: big, size: { 51: 10, 52: 10 }, unsolicited: { 52: true } })(...a);
    const w = sock.write; sock.write = (l) => { if (/BODY\.PEEK/.test(l)) timeline.push(`imap:fetch ${l.split(' ')[3]}`); return w(l); }; return sock; } }) });
const b7 = await book();
check('a message over the size limit is recorded too_large from its size alone, and never fetched', b7[50] === 'too_large/1'
  && !timeline.includes('imap:fetch 50'), JSON.stringify([b7, timeline]));
check('…a server that understates a size cannot make the reader hold it: the oversized body ends that session unread, and the next is read',
  b7[51] === 'error/1' && b7[52] === 'ok/1', JSON.stringify(b7));
check('…an unsolicited flag update for another message is not taken as this message\'s answer', b7[52] === 'ok/1' && run7.reports.some((r) => r.fleet === 'egari'));
check('every attempt is counted BEFORE the message is fetched, so a message that kills the process still uses up its tries',
  timeline.indexOf('db:attempt 51') >= 0 && timeline.indexOf('db:attempt 51') < timeline.indexOf('imap:fetch 51'), JSON.stringify(timeline));
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
  sheetRow(5, '2026-11-25', 'ecosine', '10392910', 23.95, E2),       // the late payment, typed under the 25th
  sheetRow(6, '2026-11-25', 'ecosine', '10392910', 120, E2),         // the bank says 123.75
  sheetRow(7, '2026-11-25', 'ecosine', '10397223', 50, null, 'Not Found'),
  sheetRow(8, '2026-11-20', 'ecosine', '10403934', 15, E3),          // the terminal's earlier driver: never borrowed
  sheetRow(9, '2026-11-25', 'ecosine', '10999999', 5, E3),           // a terminal no report has ever carried: kept
  sheetRow(10, '2026-11-25', 'egari', '10413936', 60, E1),           // the other fleet, no report: kept
  sheetRow(11, '2026-11-25', 'ecosine', '10600000', 30, E1),         // two drivers on one terminal, one exact
  sheetRow(12, '2026-11-25', 'ecosine', '10600000', 45, E2),
  sheetRow(13, '2026-11-25', 'ecosine', '10700000', 20, E1),         // both matched; the bank has a third
  sheetRow(14, '2026-11-25', 'ecosine', '10700000', 25, E3),
  sheetRow(15, '2026-11-25', 'egari', '10392910', 5, E2),            // Platform says Egari; the terminal settles to Ecosine
  sheetRow(16, '2026-11-25', 'ecosine', '10800000', 50, E1),         // two drivers, near amounts, nothing exact
  sheetRow(17, '2026-11-25', 'ecosine', '10800000', 52, E3),
  sheetRow(18, '2026-11-23', 'ecosine', '10900000', 33, E3),         // a late payment typed under the bank's own date
  sheetRow(19, '2026-11-25', 'ecosine', '10389535', -700, E1),       // a chargeback
  sheetRow(20, '2026-11-25', 'ecosine', '10990000', 7, E3),          // a terminal the bank knows, without this payment (yet)
];
const bankTx = (ref, day, term, amount, reportDay = '2026-11-25', fleet = 'ecosine') => ({ bank_ref: ref, terminal_id: term, report_day: reportDay, txn_day: day, amount, txn_type: 'SALES', fleet_id: fleet });
const txnsB = [
  bankTx('R1', '2026-11-25', '10389535', 30), bankTx('R2', '2026-11-25', '10389535', 70), bankTx('R3', '2026-11-24', '10392910', 23.95),
  bankTx('R4', '2026-11-25', '10392910', 123.75), bankTx('R5', '2026-11-25', '10397223', 50), bankTx('R6', '2026-11-25', '10403934', 40),
  bankTx('R7', '2026-11-25', '10500000', 9), bankTx('R8', '2026-11-25', '10600000', 44), bankTx('R9', '2026-11-25', '10600000', 30),
  bankTx('R10', '2026-11-25', '10392910', 12), bankTx('R11', '2026-11-25', '10700000', 20), bankTx('R12', '2026-11-25', '10700000', 25),
  bankTx('R13', '2026-11-25', '10700000', 31), bankTx('R14', '2026-11-25', '10392910', 5), bankTx('R15', '2026-11-25', '10800000', 51.5),
  bankTx('R16', '2026-11-25', '10800000', 53), bankTx('R17', '2026-11-23', '10900000', 33),
  bankTx('R20', '2026-11-26', '10389535', 66, '2026-11-26')];
const bank = { covered: [{ fleet_id: 'ecosine', day: '2026-11-25' }, { fleet_id: 'ecosine', day: '2026-11-26' }],
  terminalFleet: { ...Object.fromEntries(txnsB.map((t) => [t.terminal_id, t.fleet_id])), 10990000: 'ecosine' }, txns: txnsB };
const m = mergeBank(sheet, bank);
const by = (ref) => m.rows.find((r) => r.bank_ref === ref);
const sheetNos = m.rows.filter((r) => r.source === 'network_sheet').map((r) => r.row_no).sort((a, b) => a - b).join();
check('kept as the sheet\'s: other days, the other fleet, a terminal no report has carried, a chargeback, a terminal-day the sheet cannot split, and a row the bank cannot have shown yet',
  sheetNos === '2,8,9,10,16,17,19,20' && m.rows.find((r) => r.row_no === 20).id_basis === 'sheet_pending', sheetNos);
check('a covered day\'s other rows are the bank\'s: 15 of them (two held back, one from another day)', m.rows.filter((r) => r.source === 'network_report').length === 15,
  String(m.rows.filter((r) => r.source === 'network_report').length));
check('a day the bank reports but the sheet has not reached waits: none of its rows, the day not covered — the cash texts wait as before',
  !by('R20') && !m.covered.includes('ecosine|2026-11-26'), JSON.stringify(m.covered));
check('1. the same terminal, day and amount: the sheet\'s driver', by('R1').emirates_id === E1 && by('R1').id_basis === 'sheet_same_payment');
check('2. the same terminal and day, another amount, every unmatched row there one driver\'s: that driver, at the bank\'s amount',
  by('R4').emirates_id === E2 && by('R4').id_basis === 'sheet_same_terminal_day' && by('R4').amount === 123.75);
check('…an exact match is never taken by a near one: 30 to the 30 row\'s driver, then 44 to the only unmatched row\'s',
  by('R9').emirates_id === E1 && by('R9').id_basis === 'sheet_same_payment' && by('R8').emirates_id === E2 && by('R8').id_basis === 'sheet_same_terminal_day');
check('3. two drivers\' unmatched rows and nothing exact: that terminal-day stays as the sheet has it — both sheet rows kept, the bank\'s two not written',
  !by('R15') && !by('R16') && m.held.length === 2 && m.rows.filter((r) => r.terminal_id === '10800000').every((r) => r.id_basis === 'sheet_held')
    && m.rows.filter((r) => r.terminal_id === '10800000').map((r) => r.amount).join() === '50,52', JSON.stringify(m.rows.filter((r) => r.terminal_id === '10800000')));
check('4. a payment the sheet does not list (every row there matched): nobody — not the terminal\'s one driver that day', by('R10').emirates_id === null
  && by('R10').id_basis === 'none' && /does not list this payment/.test(by('R10').id_label) && by('R13').emirates_id === null);
check('…a terminal the sheet has not mapped that day: nobody — never its driver from an earlier day', by('R6').emirates_id === null
  && by('R6').id_basis === 'none' && /maps no driver to this terminal that day/.test(by('R6').id_label));
check('…the sheet\'s "Not Found" travels with its match', by('R5').emirates_id === null && by('R5').id_label === 'Not Found');
check('the late payment stays on the sheet\'s day (25th) with its driver; the bank\'s date (24th) is kept beside it',
  by('R3').txn_day === '2026-11-25' && by('R3').bank_day === '2026-11-24' && by('R3').emirates_id === E2, JSON.stringify(by('R3')));
check('a late payment the team typed under the bank\'s own date is matched there, filed there, and replaces that sheet row',
  by('R17').txn_day === '2026-11-23' && by('R17').emirates_id === E3 && by('R17').id_basis === 'sheet_same_payment' && !m.rows.some((r) => r.row_no === 18),
  JSON.stringify(by('R17')));
check('a row whose Platform cell disagrees with the bank\'s merchant follows the merchant: replaced, not counted twice',
  by('R14').emirates_id === E2 && by('R14').id_basis === 'sheet_same_payment' && !m.rows.some((r) => r.row_no === 15));
check('a chargeback on a covered day is kept, and never matched to a sale', m.rows.some((r) => r.row_no === 19 && r.amount === -700 && r.source === 'network_sheet'));
check('a row the bank has not shown is kept while the next day — whose report carries late payments — is not covered', m.sheet_only.length === 0,
  JSON.stringify(m.sheet_only.map((r) => r.row_no)));
{
  /* The third review's cases, on their own. */
  const D = '2026-12-01'; const D1 = '2026-12-02';
  const sh = [sheetRow(31, D, 'ecosine', 'T5', 50, E1), sheetRow(32, D, 'ecosine', 'T6', 50, E1), sheetRow(33, D, 'ecosine', 'T7X', 30, E2),
    sheetRow(34, D, 'ecosine', 'T8', 40, E3), sheetRow(35, D, 'ecosine', 'T9', 40, E1), sheetRow(36, D1, 'ecosine', 'T10', 10, E2)];
  const tx = [bankTx('A1', D, 'T5', 70, D), bankTx('A2', D, 'T5', 55, D), bankTx('B1', D, 'T6', 90, D), bankTx('C1', D, 'T7', 30, D),
    bankTx('D1', D, 'T8', 40, D), bankTx('F1', D1, 'T10', 10, D1)];
  const bk = (txns) => ({ covered: [{ fleet_id: 'ecosine', day: D }, { fleet_id: 'ecosine', day: D1 }],
    terminalFleet: { T5: 'ecosine', T6: 'ecosine', T7: 'ecosine', T8: 'egari', T9: 'ecosine', T10: 'ecosine' }, txns });
  const r = mergeBank(sh, bk(tx)); const b = (ref) => r.rows.find((x) => x.bank_ref === ref);
  check('pairing is smallest difference first across the terminal-day: the 55 takes the row typed 50, and the unlisted 70 has nobody (in reference order the 70 took it)',
    b('A2').emirates_id === E1 && b('A2').id_basis === 'sheet_same_terminal_day' && b('A1').emirates_id === null && b('A1').id_basis === 'none', JSON.stringify([b('A1'), b('A2')]));
  check('…and never beyond AED 5 or 5%: a row typed 50 against a payment of 90 holds the terminal-day as the sheet has it',
    !b('B1') && r.rows.some((x) => x.row_no === 32 && x.id_basis === 'sheet_held'), JSON.stringify(r.rows.filter((x) => x.terminal_id === 'T6')));
  check('a mistyped terminal: the payment is held, not written with nobody beside the kept row — counted once, with its driver',
    !b('C1') && r.rows.some((x) => x.row_no === 33 && x.source === 'network_sheet') && r.held.some((t) => t.bank_ref === 'C1'), JSON.stringify(r.held));
  check('a terminal that changed merchants: its row kept by the newer fleet still matches that day\'s payment — counted once',
    b('D1').emirates_id === E3 && b('D1').id_basis === 'sheet_same_payment' && !r.rows.some((x) => x.row_no === 34), JSON.stringify(b('D1')));
  check('a row the bank has not shown, once the next day is covered and its report lacks it too: reported, not kept',
    r.sheet_only.length === 1 && r.sheet_only[0].row_no === 35 && !r.rows.some((x) => x.row_no === 35), JSON.stringify(r.sheet_only));
  const r3 = mergeBank([sheetRow(37, D, 'ecosine', 'T11', 50, E1)], { covered: [{ fleet_id: 'ecosine', day: D }], terminalFleet: { T11: 'ecosine' },
    txns: [bankTx('H1', D, 'T11', 54, D), bankTx('H2', D, 'T11', 52, D)] });
  const h = (ref) => r3.rows.find((x) => x.bank_ref === ref);
  check('…both within the limit: the closer payment takes the row whatever the reference order (52 against 50, not 54)',
    h('H2').emirates_id === E1 && h('H1').emirates_id === null && h('H1').id_basis === 'none', JSON.stringify([h('H1'), h('H2')]));
  /* The final review's cases: the day's text is computed before the next
     day's report exists, so D+1 is never covered then. */
  const E = '2026-12-05';
  const r4 = mergeBank([sheetRow(41, E, 'ecosine', 'T12', 30, E1), sheetRow(42, E, 'ecosine', 'T12', 30, E1),
    sheetRow(43, E, 'ecosine', 'T13', 20, E2), sheetRow(44, E, 'ecosine', 'T13', 25, E2), sheetRow(45, E, 'ecosine', 'T13X', 30, E2),
    sheetRow(46, E, 'ecosine', 'T14', 35, E3)],
  { covered: [{ fleet_id: 'ecosine', day: E }], terminalFleet: { T12: 'ecosine', T13: 'ecosine', T14: 'ecosine', T15: 'ecosine' },
    txns: [bankTx('J1', E, 'T12', 30, E), bankTx('K1', E, 'T13', 20, E), bankTx('K2', E, 'T13', 25, E), bankTx('K3', E, 'T13', 30, E),
      bankTx('L1', E, 'T15', 35, E)] });
  const total = (rows) => Math.round(rows.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  check('a payment typed twice, the bank showing it once: the double entry is dropped before the day\'s text, not kept as pending',
    r4.rows.filter((x) => x.terminal_id === 'T12').length === 1 && r4.sheet_only.some((x) => x.row_no === 42)
      && !r4.rows.some((x) => x.id_basis === 'sheet_pending' && x.terminal_id === 'T12'), JSON.stringify(r4.rows.filter((x) => x.terminal_id === 'T12')));
  check('a mistyped terminal beside the real one\'s other rows: the third payment is held, not written beside the kept row — 75, not 105',
    !r4.rows.some((x) => x.bank_ref === 'K3') && total(r4.rows.filter((x) => ['T13', 'T13X'].includes(x.terminal_id))) === 75,
    JSON.stringify(r4.rows.filter((x) => ['T13', 'T13X'].includes(x.terminal_id))));
  check('a payment typed under the wrong (known) terminal: kept as pending, and the bank\'s payment with nobody beside it is held — counted once',
    r4.rows.some((x) => x.row_no === 46 && x.id_basis === 'sheet_pending') && !r4.rows.some((x) => x.bank_ref === 'L1')
      && r4.held.some((t) => t.bank_ref === 'L1'), JSON.stringify([r4.rows.filter((x) => x.terminal_id === 'T14'), r4.held.map((t) => t.bank_ref)]));
  const r2 = mergeBank(sh, bk([...tx, bankTx('G1', D, 'T9', 40, D1)]));
  check('…and when the next day\'s report does carry it, it is matched on its own day', r2.rows.find((x) => x.bank_ref === 'G1')?.txn_day === D
    && r2.rows.find((x) => x.bank_ref === 'G1').emirates_id === E1 && r2.sheet_only.length === 0);
}
check('no report: the sheet\'s rows, all of them, marked as the sheet\'s', mergeBank(sheet, null).rows.every((r) => r.source === 'network_sheet' && r.id_basis === 'sheet') && mergeBank(sheet, null).rows.length === sheet.length);
const perDriverDay = (rows) => { const o = {}; for (const r of rows) { const k = `${r.emirates_id}|${r.txn_day}`; o[k] = Math.round(((o[k] || 0) + r.amount) * 100) / 100; } return o; };
const before = perDriverDay(sheet); const after = perDriverDay(m.rows);
check('…and on the measured shape no driver-day moves: where the bank and the sheet agree, every driver keeps every day\'s total',
  ['784200000000001|2026-11-25', '784200000000002|2026-11-24', '784200000000003|2026-11-23'].every((k) => before[k] === after[k]), JSON.stringify([before, after]));

/* ── §6 ─────────────────────────────────────────────────────────────────── */
console.log('\n§6 written');
const toValues = (rows) => [['Emirates ID', 'Date', 'Platform', 'TRMNL ID', 'TRAN AMT'],
  ...rows.map((r) => [r.emirates_id || r.id_label, r.txn_day.split('-').reverse().join('/'), r.fleet_id === 'ecosine' ? 'Ecosine' : 'Egari', r.terminal_id, String(r.amount)])];
const parsed = parseSheet(toValues(sheet));
await q('DELETE FROM card_payment');
const imp = await writeRead(db, parsed, { range: 'test', bank });
const cp = await q(`SELECT source, bank_ref, id_basis, emirates_id, txn_day::text d, amount::float a FROM card_payment ORDER BY source, bank_ref, d`);
check('card_payment carries source, bank_ref and id_basis for every row', imp.status === 'ok' && cp.length === 23
  && cp.filter((r) => r.source === 'network_report').every((r) => r.bank_ref && r.id_basis) && cp.filter((r) => r.source === 'network_sheet').every((r) => !r.bank_ref && ['sheet', 'sheet_held', 'sheet_pending'].includes(r.id_basis)),
  JSON.stringify([imp.status, imp.why, cp.length]));
const day25 = cp.filter((r) => r.source === 'network_report').reduce((a, r) => a + r.a, 0);
const want25 = bank.txns.filter((t) => t.report_day === '2026-11-25' && !['R15', 'R16'].includes(t.bank_ref)).reduce((a, t) => a + t.amount, 0);
check('…the bank\'s rows are the bank\'s amounts, with its date beside them', Math.abs(day25 - want25) < 0.005
  && (await q(`SELECT bank_day::text b FROM card_payment WHERE bank_ref = 'R3'`))[0].b === '2026-11-24', `${day25} ${want25}`);
const again = await writeRead(db, parsed, { range: 'test', bank });
check('a second read replaces, never doubles', again.status === 'ok' && again.held === 2 && (await q('SELECT count(*)::int n FROM card_payment'))[0].n === 23);
/* A broken read that kept ONE of the 25th's rows: the day stays covered, so
   the bank's rows would pad the merged count back up. Counted sheet against
   sheet, it is 4 of 19, and held. */
const thin = parseSheet(toValues(sheet.filter((r) => r.row_no <= 3 || r.row_no === 8 || r.row_no === 10)));
const held = await writeRead(db, thin, { range: 'test', bank });
check('the shrink guard compares the sheet with the sheet: the bank\'s rows cannot stand in for rows a broken read lost',
  held.status === 'held' && /keeps 4 of the sheet's 19 stored payments/.test(held.why)
  && (await q('SELECT count(*)::int n FROM card_payment'))[0].n === 23, JSON.stringify([held.status, held.why]));
await q('DELETE FROM ni_report'); await q('DELETE FROM ni_mail_message');
await ingestMessage(db, { raw: message([pdf]), uid: 30, uidvalidity: 99 }, { log: quiet, ...OPTS });
await ingestMessage(db, { raw: message([makePdf(reportLines({ rows: ROWS, merchant: '200699999999' }))], { id: '<x@example.test>' }), uid: 31, uidvalidity: 99 }, { log: quiet, ...OPTS });
const fromDb = await bankForMerge(db);
check('the merge reads only usable reports and the days they cover, and learns each terminal\'s fleet from the bank', fromDb.covered.length === 1
  && fromDb.covered[0].day === '2026-11-25' && fromDb.txns.length === 4 && fromDb.terminalFleet['10389535'] === 'ecosine', JSON.stringify(fromDb.covered));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
