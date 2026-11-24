/* Card-machine payments from Network International (FIX-STATUS CARD-1).
   ──────────────────────────────────────────────────────────────────────────
   The operator, 2026-11-23: drivers take real cash and card payments; the
   Network International sheet "shows how much was in card machine. The rest
   is real cash still left in the driver." Phase 1 stores and shows the card
   payments; it moves no money figure. Held here:

     §1  the sheet → payments: columns found by their names (a moved column
         reads the same), the first of two "Date" columns, "1-Jan-2026",
         chargebacks kept negative, "Not Found"/"N/A" kept as the sheet's own
         words, an unreadable ID never stored, each row left out counted;
     §2  the Google reader: the key pasted as JSON or base64, the signed
         assertion verifies with the account's public key, the read asks for
         the right sheet and range, a sheet not shared says whom to share with;
     §3  a read REPLACES the days it covers — never appends — and leaves the
         other days alone; one that would remove more than a tenth of its
         days' stored payments is HELD, an empty one too;
     §4  collect(): no key → skipped; a refused sheet → recorded, not thrown;
     §5  who a payment belongs to (card_id_person): the HR export's newest
         upload carrying the ID, a person's link over it, an ID the export
         puts on two records placed on neither;
     §6  the routes: a driver's payments with each terminal (the operator:
         "the terminal ID should be there so that we can trace back"), the
         true reason when there are none, the fleet summary, the review list;
     §7  behind the real gate: driver cash for the driver page, documents for
         the number on the review list, identity.decide for a link;
     §8  no HR document number is served: an ID the export places is never
         on the review list, and an ID it carries twice is shown without it.

   REVERSIONS (each run, each failing as named):
     · columns read by fixed position → §1 "moved column" fails
     · `amount < 0` rows dropped → §1 "chargebacks" and §6 "net" fail
     · the DELETE before the INSERT removed (append) → §3 "replaced" fails
     · the KEEP_SHARE guard removed → §3 "held" fails
     · the per-month guard removed → §3 "held by the month" fails
     · replace by date range again → §3 "stray date" fails
     · the advisory lock removed, or the count before it → §3 "the lock" fails
     · `on_hr` ignored on the review (the view alone) → §8 "matched to nobody" fails
     · refOf an unkeyed sha256 → §6 "the ref is keyed" fails
     · the 409 removed → §7 "a second decision" fails
     · the driver route's HR lookup removed → §6 "older upload" and "two records" fail
     · slash dates read day-first regardless → §1 "month-first" and "never guessed" fail
     · the sign-in check removed from readCsvByLink → §2b "no longer open" fails
     · statusOf without the day before's leftover → §9 "covered with the day before" fails
     · ALLOWANCE 0 → §9 "the allowance" fails
     · the crosscheck's day-before card read removed → §9 "a window starting on the 16th" fails
     · pos-driver fares left out of cashByDay → §9 "pos-driver covers the 20th" fails
     · the platform check on a trip's account dropped → §9 "the 8th" fails
     · allocate paying cash before pos-driver → §10 "pos-driver fare first" fails
     · allocate without the one-day carry → §10 "before midnight" and the preview fail
     · chargebacks netted into what card paid → §10 "the chargeback is shown" fails
     · cashByDay reading the trip views even when the table is built → §10 "the pages read the table" fails
     · the hourly refresh rebuilding everything → §10 "the last 14 days only" fails
     · the fares refreshed only after a read that worked → §10 "a read that fails" fails
     · the link's precedence over the HR export dropped (CASE order) → §5 fails
     · the review serving an ambiguous HR ID → §8 fails
     · the stranded-link fallback dropped → §5 "removed person" fails
     · d.driver_id IS NOT NULL dropped → §5 "no person" fails
   Synthetic people, IDs and keys only: the RSA key is generated here. */
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { accessLayer } from '../api/access/middleware.js';
import * as svc from '../api/access/service.js';
import { hashPassword } from '../api/access/crypto.js';
import { parseSheet, dayOf, slashOrderOf, writeRead, collect } from '../src/sources/network_cards.js';
import { parseServiceAccount, signedAssertion, readValues, sheetFromLink, readCsvByLink } from '../src/google_sheets.js';
import { refOf, allocate } from '../api/card_routes.js';
import { refreshFares } from '../src/card_fares.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const E1 = '784199000000001', E2 = '784199000000002', E3 = '784199000000003', E4 = '784199000000004';
const fmtE = (e) => `${e.slice(0, 3)}-${e.slice(3, 7)}-${e.slice(7, 14)}-${e.slice(14)}`;
const HEAD = ['Emirates ID', 'Date', 'Platform', 'TRMNL ID', 'TRAN AMT', '', '', '', 'Date', 'DD/MM/YY'];

console.log('\n§1 the sheet → payments');
{
  const p = parseSheet([HEAD,
    [fmtE(E1), '1-Jan-2026', 'Ecosine', 10389537, 180],
    [fmtE(E1), '1-Jan-2026', 'Ecosine', 10389537, 180],            // identical: a second payment
    [fmtE(E1), '2-Jan-2026', 'Ecosine', 10389537, -40],            // a chargeback
    ['Not Found', '2-Jan-2026', 'Egari', 10392911, 300],
    ['N/A', '3-Jan-2026', 'Egari', 10392912, '1,250.50'],
    ['784-1990-00000', '3-Jan-2026', 'Ecosine', 10389537, 10],     // too short: not stored
    [fmtE(E2), 'yesterday', 'Ecosine', 1, 5],
    [fmtE(E2), '3-Jan-2026', 'Careem', 1, 5],
    [fmtE(E2), '3-Jan-2026', 'Ecosine', '', 5],
    [fmtE(E2), '3-Jan-2026', 'Ecosine', 1, 'abc'],
    ['', '', '', '', ''],
  ]);
  check('six payments kept, identical rows twice, totals as the sheet sums them',
    p.payments.length === 6 && p.payments.filter((x) => x.amount === 180).length === 2
    && Math.round(p.payments.reduce((a, x) => a + x.amount, 0) * 100) === Math.round((180 + 180 - 40 + 300 + 1250.5 + 10) * 100), JSON.stringify(p.payments));
  check('chargebacks kept, negative', p.payments.some((x) => x.amount === -40));
  check('"Not Found" and "N/A" kept as the sheet\'s words, with no ID', p.payments.filter((x) => !x.emirates_id).map((x) => x.id_label).join('|') === 'Not Found|N/A|unreadable Emirates ID');
  check('an unreadable ID is never stored as digits', !JSON.stringify(p.payments).includes('784199000000') || p.payments.filter((x) => x.emirates_id).every((x) => /^784\d{12}$/.test(x.emirates_id)));
  check('each row left out is counted by reason', p.skipped['no readable day'] === 1 && p.skipped['fleet not Ecosine or Egari'] === 1
    && p.skipped['no terminal id'] === 1 && p.skipped['amount not a number'] === 1, JSON.stringify(p.skipped));
  check('the day, fleet, terminal and ID read right', p.payments[0].txn_day === '2026-01-01' && p.payments[0].fleet_id === 'ecosine'
    && p.payments[0].terminal_id === '10389537' && p.payments[0].emirates_id === E1 && p.payments[0].row_no === 2);
  const moved = parseSheet([['Note', 'TRAN AMT', 'TRMNL ID', 'Platform', 'Date', 'Emirates ID'], ['', 55, 7, 'Egari', '5-Feb-2026', fmtE(E3)]]);
  check('moved column: read by name, not position', moved.payments[0]?.amount === 55 && moved.payments[0].terminal_id === '7'
    && moved.payments[0].emirates_id === E3 && moved.payments[0].txn_day === '2026-02-05', JSON.stringify(moved));
  check('no header row: nothing kept, and said', parseSheet([['a', 'b']]).missing.length === 1);
  /* Slash dates (CARD-1b): read only when the column itself proves which
     part is the day — never guessed. */
  check('slash dates: a first part over 12 proves day-first, a second over 12 month-first, neither or both is unknown',
    slashOrderOf(['13/01/2026', '02/01/2026']) === 'dmy' && slashOrderOf(['01/13/2026', '01/02/2026']) === 'mdy'
    && slashOrderOf(['01/02/2026', '03/04/2026']) === 'unknown' && slashOrderOf(['13/01/2026', '01/13/2026']) === 'unknown');
  const mdy = parseSheet([HEAD, [fmtE(E1), '11/5/2026', 'Ecosine', 1, 5], [fmtE(E1), '11/25/2026', 'Ecosine', 1, 6]]);
  check('a month-first sheet reads 11/5/2026 as 5 November', mdy.payments[0]?.txn_day === '2026-11-05' && mdy.payments[1]?.txn_day === '2026-11-25',
    JSON.stringify(mdy.payments.map((x) => x.txn_day)));
  const amb = parseSheet([HEAD, [fmtE(E1), '5/11/2026', 'Ecosine', 1, 5], [fmtE(E1), '1-Dec-2026', 'Ecosine', 1, 6]]);
  check('…and a column that cannot tell day from month leaves those rows unread, counted, never guessed',
    amb.payments.length === 1 && amb.skipped['a slash date whose day and month cannot be told apart'] === 1, JSON.stringify(amb.skipped));
  check('days: D-Mon-YYYY, ISO, day-first slashes, serial; nonsense refused',
    dayOf('1-Jan-2026') === '2026-01-01' && dayOf('2026-03-04') === '2026-03-04' && dayOf('04/03/2026') === '2026-03-04'
    && dayOf(46023) === '2026-01-01' && dayOf('31-Feb-2026') === null && dayOf('soon') === null);
}

console.log('\n§2 the Google reader');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const keyJson = JSON.stringify({ type: 'service_account', client_email: 'reader@test-project.iam.gserviceaccount.com', private_key: pem,
  token_uri: 'https://oauth2.example.test/token' });
{
  const sa = parseServiceAccount(keyJson);
  check('the key read as pasted, as one line, and as base64', sa.email.startsWith('reader@')
    && parseServiceAccount(keyJson.replace(/\n/g, '')).email === sa.email && parseServiceAccount(Buffer.from(keyJson).toString('base64')).email === sa.email);
  let msg = '';
  try { parseServiceAccount(JSON.stringify({ type: 'authorized_user', client_email: 'x', private_key: pem })); } catch (e) { msg = e.message; }
  check('a key that is not a service account\'s is refused in words', /not a service account/.test(msg), msg);
  const jwt = signedAssertion(sa, { now: Date.UTC(2026, 10, 23) });
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  check('the assertion verifies with the public key and asks read-only Sheets',
    crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url'))
    && claims.scope === 'https://www.googleapis.com/auth/spreadsheets.readonly' && claims.aud === sa.tokenUri && claims.exp - claims.iat === 3600, JSON.stringify(claims));
  const calls = [];
  const fake = (sheetStatus = 200) => async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'synthetic-token' }), { status: 200 });
    return new Response(JSON.stringify(sheetStatus === 200 ? { values: [HEAD, [fmtE(E1), '1-Jan-2026', 'Ecosine', 1, 5]] } : { error: { message: 'nope' } }), { status: sheetStatus });
  };
  const v = await readValues({ sa, sheetId: 'sheet-abc', range: 'A:J', fetchImpl: fake() });
  const sheetCall = calls.find((x) => x.url.includes('sheets.googleapis.com'));
  check('one token request, then the values of the named sheet and range, unformatted', v.length === 2
    && new URLSearchParams(String(calls[0].opts.body)).get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    && sheetCall.url.includes('/spreadsheets/sheet-abc/values/A%3AJ') && sheetCall.url.includes('valueRenderOption=UNFORMATTED_VALUE')
    && sheetCall.url.includes('dateTimeRenderOption=SERIAL_NUMBER')
    && sheetCall.opts.headers.authorization === 'Bearer synthetic-token', JSON.stringify(calls.map((x) => x.url)));
  let m403 = '';
  try { await readValues({ sa, sheetId: 'sheet-abc', range: 'A:J', fetchImpl: fake(403) }); } catch (e) { m403 = e.message; }
  check('a sheet not shared says whom to share it with', m403.includes('reader@test-project.iam.gserviceaccount.com') && /Viewer/.test(m403), m403);
  const disabledApi = async (url) => (String(url).includes('/token') ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'Google Sheets API has not been used in project 123 before or it is disabled.',
      details: [{ reason: 'SERVICE_DISABLED' }] } }), { status: 403 }));
  let mOff = ''; let credOff = null;
  try { await readValues({ sa, sheetId: 'sheet-abc', range: 'A:J', fetchImpl: disabledApi }); } catch (e) { mOff = e.message; credOff = e.credential; }
  check('the Sheets API not enabled is said as itself — not "share the sheet", and the key is not blamed',
    /Sheets API is not enabled/.test(mOff) && !/share it/.test(mOff) && /has not been used/.test(mOff) && !credOff, mOff);
}

console.log('\n§2b by link (the operator: "let\'s go for the easy option")');
{
  check('the link names the sheet and its tab: the edit link, an export link, a bare id',
    sheetFromLink('https://docs.google.com/spreadsheets/d/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy/edit?gid=42#gid=42')?.gid === '42'
    && sheetFromLink('https://docs.google.com/spreadsheets/d/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy/edit')?.gid === '0'
    && sheetFromLink('AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy')?.id === 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy'
    && sheetFromLink('https://example.test/nothing') === null);
  const LINK = 'https://docs.google.com/spreadsheets/d/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy/edit?gid=7#gid=7';
  let asked = '';
  const csv = `Emirates ID,Date,Platform,TRMNL ID,TRAN AMT,,,,Date,DD/MM/YY\n${fmtE(E1)},1-Jan-2026,Ecosine,10389537,180\n"${fmtE(E1)}",2-Jan-2026,Ecosine,10389537,"1,250.50"\n`;
  const open = async (url) => { asked = String(url); return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } }); };
  const text = await readCsvByLink({ link: LINK, fetchImpl: open });
  check('one GET of the tab\'s CSV export, no sign-in', asked === 'https://docs.google.com/spreadsheets/d/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy/export?format=csv&gid=7'
    && text.startsWith('Emirates ID'), asked);
  const closed = async () => Object.defineProperty(new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    'url', { value: 'https://accounts.google.com/v3/signin/identifier?continue=x' });
  let shut = ''; let shutCred = null;
  try { await readCsvByLink({ link: LINK, fetchImpl: closed }); } catch (e) { shut = e.message; shutCred = e.credential; }
  check('a link no longer open ends at the sign-in page and says so — never parsed as payments', /not open to anyone with it/.test(shut) && shutCred === true, shut);
}

console.log('\n§3 a read is the whole sheet, and replaces what is stored');
const pg = new PGlite();
await applySchema(pg);
const db = { query: (t, p) => pg.query(t, p) };
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
const stored = async () => (await q(`SELECT count(*)::int n, coalesce(sum(amount),0)::float s FROM card_payment`))[0];
const rows = (n, day, amt = 10, eid = E1, term = 100) => Array.from({ length: n }, () => [fmtE(eid), day, 'Ecosine', term, amt]);
const sheet = (...parts) => parseSheet([HEAD, ...parts.flat()]);
{
  const r1 = await writeRead(db, sheet(rows(30, '5-Jan-2026'), rows(30, '5-Feb-2026')));
  check('the first read writes every payment', r1.status === 'ok' && (await stored()).n === 60, JSON.stringify(r1));
  const r2 = await writeRead(db, sheet(rows(30, '5-Jan-2026', 12), rows(30, '5-Feb-2026', 12)));
  const s2 = await stored();
  check('a corrected read REPLACES — 60 payments at the new amounts, not 120', r2.status === 'ok' && s2.n === 60 && s2.s === 720, JSON.stringify(s2));
  const r3 = await writeRead(db, sheet(rows(30, '5-Jan-2026')));
  check('held: a read without February (half the stored payments) replaces nothing, and says why', r3.status === 'held'
    && /keeps 30 of the 60/.test(r3.why) && (await stored()).n === 60, JSON.stringify([r3.status, r3.why]));
  const r4 = await writeRead(db, sheet(rows(31, '5-Jan-2026', 12), rows(25, '5-Feb-2026', 12), rows(3, '6-Mar-2026', 12)));
  check('held by the month: February down to 25 of 30 is held though the read keeps 59 of 60',
    r4.status === 'held' && /2026-02 \(25 of 30\)/.test(r4.why) && (await stored()).n === 60, JSON.stringify([r4.status, r4.why]));
  const r5 = await writeRead(db, sheet(rows(30, '5-Jan-2026', 12), rows(30, '5-Feb-2026', 12), rows(1, '1-Dec-2026', 12)));
  const r6 = await writeRead(db, sheet(rows(30, '5-Jan-2026', 12), rows(30, '5-Feb-2026', 12)));
  const dec = (await q(`SELECT count(*)::int n FROM card_payment WHERE txn_day >= '2026-12-01'`))[0].n;
  check('a stray date, once corrected, leaves nothing behind (a month under 20 is not guarded)', r5.status === 'ok' && r6.status === 'ok'
    && dec === 0 && (await stored()).n === 60, JSON.stringify([r5.status, r6.status, dec]));
  const r7 = await writeRead(db, sheet(rows(30, '5-Jan-2026')), { acceptShrink: true });
  check('…a held read is written once a person accepts it', r7.status === 'ok' && (await stored()).n === 30);
  const r8 = await writeRead(db, sheet());
  check('an empty read is held, nothing removed', r8.status === 'held' && /returned no payments/.test(r8.why) && (await stored()).n === 30);
  const r9 = await writeRead(db, parseSheet([HEAD, [fmtE(E1), 'soon', 'Ecosine', 1, 5], [fmtE(E1), 'later', 'Ecosine', 1, 5]]));
  check('a read with every row unreadable says so, and replaces nothing', r9.status === 'held'
    && /none of the sheet's 2 rows could be read \(2 no readable day\)/.test(r9.why) && (await stored()).n === 30, r9.why);
  const r10 = await writeRead(db, parseSheet([['Emirates ID', 'Date', 'TRMNL ID', 'TRAN AMT'], [fmtE(E1), '1-Jan-2026', 1, 5]]));
  check('a sheet missing a column is an error, nothing removed', r10.status === 'error' && /fleet/.test(r10.why) && (await stored()).n === 30, r10.why);
  /* ONE READ AT A TIME, ACROSS PROCESSES: the advisory lock is taken inside
     the transaction BEFORE the stored payments are counted — the statements
     in the order they were sent. */
  const seen = [];
  const spy = { query: (t, p) => { seen.push(String(t).replace(/\s+/g, ' ').trim().slice(0, 40)); return pg.query(t, p); } };
  await writeRead(spy, sheet(rows(30, '5-Jan-2026')));
  const at = (re) => seen.findIndex((x) => re.test(x));
  check('the lock is taken inside the transaction, before the count, the delete and the insert',
    at(/^BEGIN/) >= 0 && at(/^BEGIN/) < at(/pg_advisory_xact_lock/) && at(/pg_advisory_xact_lock/) < at(/^SELECT count/)
    && at(/^SELECT count/) < at(/^DELETE FROM card_payment/) && at(/^DELETE/) < at(/^INSERT INTO card_payment/), JSON.stringify(seen));
}

console.log('\n§4 collect()');
{
  const sk = await collect({ db, keyJson: '', sheetId: '', link: '' });
  check('neither a link nor a key: skipped, and says which setting', sk.skipped === 'NETWORK_SHEET_LINK is not set', JSON.stringify(sk));
  const before = (await stored()).n;
  const LINK = 'https://docs.google.com/spreadsheets/d/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy/edit?gid=0';
  const csvRows = [['Emirates ID', 'Date', 'Platform', 'TRMNL ID', 'TRAN AMT'], ...Array.from({ length: 30 }, () => [fmtE(E1), '5-Jan-2026', 'Ecosine', '100', '10'])]
    .map((r) => r.join(',')).join('\n');
  const viaLink = await collect({ db, keyJson: '', link: LINK, fetchImpl: async () => new Response(csvRows, { status: 200, headers: { 'content-type': 'text/csv' } }) });
  const [lastImp] = await q(`SELECT status, sheet_range FROM card_import ORDER BY id DESC LIMIT 1`);
  check('by link: read, written, and recorded as read by link', viaLink.status === 'ok' && viaLink.kept === 30 && lastImp.sheet_range === 'link'
    && before === 30, JSON.stringify([viaLink, lastImp, before]));
  const refuse = async (url) => (String(url).includes('/token') ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
    : new Response('{}', { status: 403 }));
  const er = await collect({ db, keyJson, sheetId: 'x', fetchImpl: refuse });
  const [imp] = await q(`SELECT status, why FROM card_import ORDER BY id DESC LIMIT 1`);
  const [run] = await q(`SELECT status, error FROM collection_run WHERE source = 'network_cards' ORDER BY finished_at DESC LIMIT 1`);
  check('a refused sheet is recorded (the read and the run), never thrown', /not shared/.test(er.error || '') && imp.status === 'error' && run?.status === 'error',
    JSON.stringify([er, imp, run]));
}

console.log('\n§5 who a payment belongs to');
await q(`DELETE FROM card_payment`);
const person = async (name) => (await q(`INSERT INTO driver (fleet_id, full_name) VALUES ('ecosine', $1) RETURNING id`, [name]))[0].id;
const PA = await person('Card Test Alpha'), PB1 = await person('Card Test Beta'), PB2 = await person('Card Test Beta Twin'),
  PC = await person('Card Test Gamma'), PD = await person('Card Test Delta'), PE = await person('Card Test Epsilon');
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES
  ('uber', 'u-alpha', $1), ('uber', 'u-beta', $2), ('bolt', 'b-beta', $3), ('uber', 'u-delta', $4), ('uber', 'u-eps', $5)`, [PA, PB1, PB2, PD, PE]);
const upload = async (sha, day) => (await q(`INSERT INTO hr_roster_upload (sha256, export_date, export_date_from, byte_len, rows_read, uploaded_by, summary)
  VALUES ($1, $2, 'entered', 1, 1, 'test', '{}'::jsonb) RETURNING id`, [sha, day]))[0].id;
const U1 = await upload('sha-old', '2026-08-01'), U2 = await upload('sha-new', '2026-09-23');
const hrRow = (u, emp, eid, accounts) => q(`INSERT INTO hr_roster_row (upload_id, fleet_id, employee_id, emirates_id, match_basis, matched_accounts)
  VALUES ($1, 'ecosine', $2, $3, 'platform_id', $4::jsonb)`, [u, emp, eid, JSON.stringify(accounts)]);
await hrRow(U2, 'e1', E1, [{ platform: 'uber', ext_id: 'u-alpha' }]);
await hrRow(U2, 'e2', E2, [{ platform: 'uber', ext_id: 'u-beta' }, { platform: 'bolt', ext_id: 'b-beta' }]);   // two records
await hrRow(U1, 'e4', E4, [{ platform: 'uber', ext_id: 'u-delta' }]);                                          // older upload…
await hrRow(U2, 'e4', E4, [{ platform: 'uber', ext_id: 'u-eps' }]);                                            // …the newer one wins
const E5 = '784199000000005', E6 = '784199000000006';
await hrRow(U2, 'e5', E5, []);                                                                                   // on the export, matched to nobody
await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES ('uber', 'u-orphan', NULL)`);
await hrRow(U2, 'e6', E6, [{ platform: 'uber', ext_id: 'u-orphan' }]);                                          // an account with no person
await writeRead(db, parseSheet([HEAD,
  [fmtE(E1), '10-Nov-2026', 'Ecosine', 501, 100], [fmtE(E1), '10-Nov-2026', 'Ecosine', 501, 60], [fmtE(E1), '12-Nov-2026', 'Ecosine', 502, -25],
  [fmtE(E2), '11-Nov-2026', 'Ecosine', 503, 70], [fmtE(E3), '11-Nov-2026', 'Egari', 504, 90], [fmtE(E4), '11-Nov-2026', 'Ecosine', 505, 33],
  ['Not Found', '12-Nov-2026', 'Egari', 506, 300], ['N/A', '12-Nov-2026', 'Egari', 501, 20],
  [fmtE(E5), '13-Nov-2026', 'Ecosine', 507, 44]]), { acceptShrink: true });
const map = Object.fromEntries((await q(`SELECT emirates_id, person_id, basis FROM card_id_person`)).map((r) => [r.emirates_id, r]));
check('the HR export places an ID on its one driver', map[E1]?.person_id == PA && map[E1].basis === 'hr', JSON.stringify(map[E1]));
check('an ID the export puts on two records is placed on neither, and says so', map[E2]?.person_id == null && map[E2].basis === 'hr_ambiguous', JSON.stringify(map[E2]));
check('the newest upload carrying an ID wins', map[E4]?.person_id == PE, JSON.stringify(map[E4]));
check('an ID not on the export is not in the map', !map[E3]);
check('an HR row matched to nobody, or to an account with no person, places nothing (never "hr" with no person)', !map[E5] && !map[E6],
  JSON.stringify([map[E5], map[E6]]));
await q(`INSERT INTO card_id_link (emirates_id, person_id, decided_by) VALUES ($1, 999999, 'test')`, [E1]);
const m1 = (await q(`SELECT person_id, basis FROM card_id_person WHERE emirates_id = $1`, [E1]))[0];
check('a link to a removed person falls back to the HR export\'s own placement', m1.person_id == PA && m1.basis === 'hr', JSON.stringify(m1));
await q(`DELETE FROM card_id_link WHERE emirates_id = $1`, [E1]);
await q(`INSERT INTO card_id_link (emirates_id, person_id, decided_by) VALUES ($1, $2, 'test')`, [E4, PD]);
const m4 = (await q(`SELECT person_id, basis FROM card_id_person WHERE emirates_id = $1`, [E4]))[0];
check('a person\'s link wins over the HR export', m4.person_id == PD && m4.basis === 'linked', JSON.stringify(m4));
await q(`DELETE FROM card_id_link WHERE emirates_id = $1`, [E4]);

console.log('\n§6 the routes');
const bare = await mountAll(pg);
const fetchVia = (port, cookie = '') => async (path, opts = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { ...opts, headers: { 'content-type': 'application/json',
    ...(cookie ? { cookie, 'x-fm-csrf': 'testcsrf' } : {}), ...(opts.headers || {}) } });
  let body = null; try { body = await r.json(); } catch { body = null; }
  return { status: r.status, body, withheld: r.headers.get('x-fm-withheld') };
};
const B = fetchVia(bare.port);
{
  const d = await B(`/api/card/driver?person=${PA}`);
  const b = d.body || {};
  check('a driver\'s card payments: count, card, chargebacks and net (chargeback summed as it is)', b.totals?.payments === 3 && b.totals.card === 160
    && b.totals.chargebacks === -25 && b.totals.net === 135 && b.totals.chargeback_n === 1, JSON.stringify(b.totals));
  check('every payment carries its terminal; each terminal with its first and last day', b.payments?.every((p) => p.terminal_id)
    && b.terminals?.length === 2 && b.terminals.find((t) => t.terminal_id === '501')?.payments === 2
    && b.terminals.find((t) => t.terminal_id === '502')?.first_day === '2026-11-12' && b.payments.find((p) => p.amount === -25)?.chargeback === true,
  JSON.stringify(b.terminals));
  check('by day, and the read\'s coverage', b.days?.[0]?.day === '2026-11-12' && b.days[1].net === 160 && b.covers_to === '2026-11-13' && b.read_at,
    JSON.stringify([b.days, b.covers_to]));
  check('placed by the HR export, said; no Emirates ID anywhere in the answer', b.placed_by?.hr_export === 1 && !JSON.stringify(b).includes(E1));
  check('…and it says the cash position is not yet changed', b.in_cash_position === false && /not yet taken off/.test(b.note || ''));
  const none = await B(`/api/card/driver?person=${PC}`);
  check('no Emirates ID known: the true reason, not "no payments"', /No Emirates ID is known for this driver/.test(none.body?.why || ''), none.body?.why);
  const d4 = await B(`/api/card/driver?person=${PD}`);
  check('an ID on an older upload, placed on another record by the newer one: said so, not "no ID known"',
    d4.body?.totals?.payments === 0 && /placed on another driver record by a newer one/.test(d4.body?.why || ''), d4.body?.why);
  const db1 = await B(`/api/card/driver?person=${PB1}`);
  check('an ID the export puts on two records: said so, with the fix', /under more than one driver record/.test(db1.body?.why || '')
    && /Same person page/.test(db1.body.why), db1.body?.why);
  const w = await B(`/api/card/driver?person=${PA}&from=2026-11-11&to=2026-11-30`);
  check('a window narrows it', w.body?.totals?.payments === 1 && w.body.totals.net === -25, JSON.stringify(w.body?.totals));
  check('a missing person is a 400', (await B('/api/card/driver')).status === 400);

  const s = (await B('/api/card/summary')).body || {};
  check('the summary: placed, no driver named, and IDs not placed — every dirham once', s.totals?.payments === 9 && s.totals.net === 692
    && s.totals.placed === 168 && s.totals.no_driver === 320 && s.totals.unplaced === 204 && s.totals.unplaced_ids === 3
    && Math.round((s.totals.placed + s.totals.no_driver + s.totals.unplaced) * 100) === Math.round(s.totals.net * 100), JSON.stringify(s.totals));
  const nd = Object.fromEntries((s.no_driver_terminals || []).map((t) => [t.terminal_id, t]));
  check('no-driver payments by terminal, in the sheet\'s words, and whether the terminal was ever mapped',
    nd['506']?.labels?.[0] === 'Not Found' && nd['506'].ever_mapped === false && nd['501']?.ever_mapped === true && s.no_driver_terminals_total === 2,
    JSON.stringify(s.no_driver_terminals));
  check('months by fleet', s.months?.some((m) => m.month === '2026-11' && m.fleet_id === 'egari' && m.net === 410), JSON.stringify(s.months));

  const r = (await B('/api/card/review')).body || {};
  const byWhy = Object.fromEntries((r.rows || []).map((x) => [x.ref, x]));
  check('the review: an ID not on the export, with its number, payments and terminals', byWhy[refOf(E3)]?.emirates_id === E3
    && /not on the HR export/.test(byWhy[refOf(E3)].why) && byWhy[refOf(E3)].terminals[0] === '504', JSON.stringify(r.rows));
  check('§8 an ID the export carries on two records: listed WITHOUT the number, and why', byWhy[refOf(E2)] && byWhy[refOf(E2)].emirates_id === null
    && /under 2 driver records/.test(byWhy[refOf(E2)].why), JSON.stringify(byWhy[refOf(E2)]));
  check('§8 an ID the export places is not on the review list at all', !byWhy[refOf(E1)] && !JSON.stringify(r).includes(E1) && !JSON.stringify(r).includes(E2));
  check('§8 an ID on the export but matched to nobody: listed WITHOUT the number, and the true reason (not "not on the HR export")',
    byWhy[refOf(E5)] && byWhy[refOf(E5)].emirates_id === null && /matched to no driver record/.test(byWhy[refOf(E5)].why)
    && !JSON.stringify(r).includes(E5), JSON.stringify(byWhy[refOf(E5)]));
  check('the ref is keyed: not the bare hash of the number, which a reader shown its last digits could reverse',
    refOf(E3) !== crypto.createHash('sha256').update(`card-id:${E3}`).digest('hex').slice(0, 16) && /^[0-9a-f]{16}$/.test(refOf(E3)));
}

console.log('\n§7 behind the real gate');
const layer = accessLayer({ db });
const gated = await mountAll(pg, { pre: (app) => { app.use(layer.identify); app.use(layer.gate); } });
const cfg = await svc.getConfig(db, { fresh: true });
async function cookieFor(email, role) {
  const u = await svc.createUser(db, { email, name: `Test ${role}`, status: 'active', passwordHash: hashPassword('a long enough test password') });
  await svc.createGrant(db, { userId: u.id, roleCode: role, fleets: null, reason: 'test' });
  const s = await svc.createSession(db, { userId: u.id, mfaOk: true, cfg });
  return `fm_sid=${s.token}; fm_csrf=testcsrf`;
}
{
  const FIN = fetchVia(gated.port, await cookieFor('fin-card@example.test', 'FIN'));
  const DSP = fetchVia(gated.port, await cookieFor('dsp-card@example.test', 'DSP'));
  const HRO = fetchVia(gated.port, await cookieFor('hro-card@example.test', 'HRO'));
  const MGT = fetchVia(gated.port, await cookieFor('mgt-card@example.test', 'MGT'));
  const f = await FIN(`/api/card/driver?person=${PA}`);
  check('the Finance manager (driver cash) reads a driver\'s card payments', f.status === 200 && f.body?.totals?.net === 135, String(f.status));
  check('a Dispatcher (no driver cash) is refused them', (await DSP(`/api/card/driver?person=${PA}`)).status === 403);
  const h = await HRO('/api/card/review');
  const h3 = (h.body?.rows || []).find((x) => x.ref === refOf(E3));
  check('an HR officer (documents, same-person decisions, no cash) reads the review: the number in full, the amounts withheld',
    h.status === 200 && h3?.emirates_id === E3 && h3.net == null && h3.payments === 1, JSON.stringify([h.status, h3]));
  const g = await MGT('/api/card/review');
  const g3 = (g.body?.rows || []).find((x) => x.ref === refOf(E3));
  check('Management (documents masked) sees the number masked', g.status === 200 && /^•+\d{4}$/.test(g3?.emirates_id || ''), JSON.stringify(g3));
  const no = await DSP('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: refOf(E3), decision: 'link', person_id: PC }) });
  check('a link needs identity.decide: the Dispatcher is refused', no.status === 403, String(no.status));
  const ok = await HRO('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: refOf(E3), decision: 'link', person_id: PC }) });
  const [lk] = await q(`SELECT person_id, decided_by FROM card_id_link WHERE emirates_id = $1`, [E3]);
  check('an HR officer links the ID by its ref; the decision is recorded with who made it', ok.status === 200 && lk?.person_id == PC && lk.decided_by === 'hro-card@example.test',
    JSON.stringify([ok.status, ok.body, lk]));
  const pc = await FIN(`/api/card/driver?person=${PC}`);
  check('…and the payment is now on that driver, placed by the link', pc.body?.totals?.net === 90 && pc.body.placed_by?.linked === 1, JSON.stringify(pc.body?.totals));
  const clash = await HRO('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: refOf(E3), decision: 'link', person_id: PA }) });
  check('a second decision for ANOTHER driver is refused (409), never silently overwriting the first', clash.status === 409
    && clash.body?.person_id === String(PC) && (await q(`SELECT person_id FROM card_id_link WHERE emirates_id = $1`, [E3]))[0].person_id == PC,
  JSON.stringify([clash.status, clash.body]));
  const over = await HRO('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: refOf(E3), decision: 'link', person_id: PA, replace: true }) });
  check('…and goes through when it says replace', over.status === 200 && (await q(`SELECT person_id FROM card_id_link WHERE emirates_id = $1`, [E3]))[0].person_id == PA);
  const un = await HRO('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: refOf(E3), decision: 'unlink' }) });
  check('unlink takes it off again', un.status === 200 && (await q(`SELECT 1 FROM card_id_link WHERE emirates_id = $1`, [E3])).length === 0);
  check('an unknown ref is a 404, a malformed one a 400',
    (await HRO('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: '0123456789abcdef', decision: 'link', person_id: PC }) })).status === 404
    && (await HRO('/api/card/link', { method: 'POST', body: JSON.stringify({ ref: 'x', decision: 'link', person_id: PC }) })).status === 400);
}

console.log('\n§9 against the cash trips (CARD-2)');
/* A card payment settles a cash trip, so a day's card total should not run
   past that day's cash trips. One driver, four days, one of each status.
   §4's reads summed the fares before any trip existed (CARD-3); §9 reads them
   live, and §10 proves the summed table gives the same answer. */
await q(`DELETE FROM card_fare_day`);
await q(`DELETE FROM source_state WHERE source = 'network_cards' AND key IN ('fares_full_at', 'fares_at')`);
{
  await writeRead(db, parseSheet([HEAD,
    [fmtE(E1), '1-Nov-2026', 'Ecosine', 601, 100],          // cash 98 + 202 → covered (within the AED 5 allowance of the 98? no: of 300)
    [fmtE(E1), '2-Nov-2026', 'Ecosine', 601, 200],          // cash 50; the 1st left 200 spare → covered with the day before
    [fmtE(E1), '5-Nov-2026', 'Ecosine', 601, 150],          // cash 80, none on the 4th → over by 70
    [fmtE(E1), '8-Nov-2026', 'Ecosine', 601, 60],           // no cash trip on the 7th or 8th
    [fmtE(E1), '10-Nov-2026', 'Ecosine', 601, 103],         // cash 98 → covered only by the allowance
    [fmtE(E1), '15-Nov-2026', 'Ecosine', 601, 280],         // cash 300 → covered, 20 left over
    [fmtE(E1), '16-Nov-2026', 'Ecosine', 601, 100],         // cash 50 + the 20 → over by 30
    [fmtE(E1), '20-Nov-2026', 'Ecosine', 601, 120],         // a hotel fare filed pos-driver, 120 → covered
    [fmtE(E1), '21-Nov-2026', 'Ecosine', 601, 80],          // only a pos-SUPERVISOR fare; the 20th's fare was its own → over by 80
    [fmtE(E4), '11-Nov-2026', 'Ecosine', 602, 33]]), { acceptShrink: true });
  let tn = 0;
  const cashTrip = (acct, at, price, pay = 'cash', platform = 'uber') => q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status, payment_type, price, currency)
    VALUES ($6, $1, 'ecosine', $2, 'Card Test', $3, 'completed', $4, $5, 'AED')`, [`ct${tn++}`, acct, at, pay, price, platform]);
  await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id) VALUES ('hotel', 'h-alpha', $1)`, [PA]);
  await cashTrip('u-alpha', '2026-11-01T10:00:00+04:00', 98);
  await cashTrip('u-alpha', '2026-11-01T22:30:00+04:00', 202);
  await cashTrip('u-alpha', '2026-11-02T09:00:00+04:00', 50);
  await cashTrip('u-alpha', '2026-11-05T09:00:00+04:00', 80);
  await cashTrip('u-alpha', '2026-11-05T11:00:00+04:00', 999, 'card');   // a card-paid trip: not a cash trip
  await cashTrip('u-alpha', '2026-11-10T09:00:00+04:00', 98);
  await cashTrip('u-alpha', '2026-11-15T09:00:00+04:00', 300);
  await cashTrip('u-alpha', '2026-11-16T09:00:00+04:00', 50);
  await cashTrip('h-alpha', '2026-11-20T09:00:00+04:00', 120, 'pos-driver', 'hotel');
  await cashTrip('h-alpha', '2026-11-21T09:00:00+04:00', 80, 'pos-supervisor', 'hotel');
  await cashTrip('u-alpha', '2026-11-08T09:00:00+04:00', 500, 'cash', 'yango');   // the same id on another platform: someone else's
  const d = (await B(`/api/card/driver?person=${PA}`)).body || {};
  const st16 = (b) => (b.days || []).find((r) => r.day === '2026-11-16');
  const st = Object.fromEntries((d.days || []).map((x) => [x.day, x]));
  check('covered: the 1st, 100 on card against 300 of cash trips', st['2026-11-01']?.status === 'covered' && st['2026-11-01'].cash === 300
    && st['2026-11-01'].cash_trips === 2, JSON.stringify(st['2026-11-01']));
  check('covered with the day before: the 2nd, 200 on card, 50 of cash trips, 200 left over from the 1st',
    st['2026-11-02']?.status === 'covered_with_day_before', JSON.stringify(st['2026-11-02']));
  check('over: the 5th, 150 on card against 80 — over by 70 (a card-paid trip is not a cash trip)', st['2026-11-05']?.status === 'over'
    && st['2026-11-05'].over_by === 70 && st['2026-11-05'].cash === 80, JSON.stringify(st['2026-11-05']));
  check('no cash trips: the 8th, nothing that day or the day before — a 500 cash trip under the same id on ANOTHER platform is not theirs',
    st['2026-11-08']?.status === 'no_cash_trips' && st['2026-11-08'].cash_trips === 0, JSON.stringify(st['2026-11-08']));
  check('a hotel fare filed pos-driver (the driver\'s own card machine) covers the 20th', st['2026-11-20']?.status === 'covered'
    && st['2026-11-20'].pos === 120 && st['2026-11-20'].pos_trips === 1 && st['2026-11-20'].cash_trips === 0, JSON.stringify(st['2026-11-20']));
  check('…a pos-SUPERVISOR fare (the supervisor\'s machine) does not: the 21st is over by the whole 80 (the 20th\'s fare went to the 20th)',
    st['2026-11-21']?.status === 'over' && st['2026-11-21'].over_by === 80 && st['2026-11-21'].pos_trips === 0, JSON.stringify(st['2026-11-21']));
  check('the allowance: 103 on card against 98 is covered (AED 5 a day for tips and rounding)', st['2026-11-10']?.status === 'covered'
    && d.allowance_aed === 5, JSON.stringify(st['2026-11-10']));
  const x = (await B('/api/card/crosscheck')).body || {};
  check('the fleet cross-check: ten driver-days, five covered (one with the day before), three over by 180, two with no fare collected',
    x.totals?.driver_days === 10 && x.totals.covered === 4 && x.totals.covered_with_day_before === 1 && x.totals.over === 3
    && x.totals.over_aed === 180 && x.totals.no_cash_trips === 2 && x.totals.no_cash_aed === 93, JSON.stringify(x.totals));
  check('…the driver with the most unexplained first (180 over + 60 with no fare)', x.drivers?.[0]?.person_id === String(PA)
    && x.drivers[0].unexplained_aed === 240 && x.drivers[1]?.person_id === String(PE) && x.drivers[1].unexplained_aed === 33,
  JSON.stringify(x.drivers));
  check('…and the flagged days, largest first', x.days?.[0]?.day === '2026-11-21' && x.days?.[1]?.day === '2026-11-05' && x.days_flagged === 5,
    JSON.stringify(x.days?.map((r) => r.day)));
  check('the 16th: 20 left over from the 15th is not enough — over by 30', st16(d)?.status === 'over' && st16(d).over_by === 30, JSON.stringify(st16(d)));
  const w = (await B('/api/card/crosscheck?from=2026-11-16&to=2026-11-30')).body || {};
  const w16 = (w.days || []).find((r) => r.day === '2026-11-16');
  check('a window starting on the 16th reads the 15th\'s card too — the 16th over by 30, not "covered with the day before"',
    w16?.status === 'over' && w16.over_by === 30 && w.totals?.covered_with_day_before === 0, JSON.stringify([w16, w.totals]));
  /* Not cached (api/cache.js NEVER): a link moves which driver a payment is on. */
  const { NEVER } = await import('../api/cache.js');
  check('the card reads are never served from the response cache (a link would otherwise redraw as undone)',
    ['/api/card/review', '/api/card/driver', '/api/card/summary', '/api/card/crosscheck'].every((r) => NEVER.some((p) => r.startsWith(p))), '');
}

console.log('\n§10 cash in notes (CARD-3)');
/* The operator, 2026-11-24: "net card off cash fares". notes = cash fares −
   the part card payments paid; pos-driver fares first (never cash), then the
   same day's cash, then the day before's; the rest is not taken off. */
{
  const a1 = allocate([{ day: '2026-11-01', cash: 100, pos: 50, pay: 80 }]);
  check('card pays the hotel\'s pos-driver fare first, then cash: 80 = 50 pos + 30 cash, 70 left in notes',
    a1[0].on_pos === 50 && a1[0].on_cash === 30 && a1[0].notes === 70 && a1[0].unexplained === 0, JSON.stringify(a1));
  const a2 = allocate([{ day: '2026-11-01', cash: 100, pay: 0 }, { day: '2026-11-02', cash: 0, pay: 60 }]);
  check('a fare taken before midnight, paid by card after: the 1st keeps 40 in notes, the 2nd\'s 60 settles it',
    a2[0].notes === 40 && a2[0].paid_next_day === 60 && a2[1].on_cash === 60 && a2[1].unexplained === 0, JSON.stringify(a2));
  const a3 = allocate([{ day: '2026-11-01', cash: 100, pay: 0 }, { day: '2026-11-03', cash: 0, pay: 60 }]);
  check('…one day back, never further: the 3rd\'s 60 is not explained, the 1st keeps its 100', a3[0].notes === 100 && a3[1].unexplained === 60,
    JSON.stringify(a3));
  const a4 = allocate([{ day: '2026-11-05', cash: 50, pay: 80 }]);
  check('card beyond the fares is not taken off: 50 paid by card, 30 not explained, notes 0 (never below)', a4[0].on_cash === 50
    && a4[0].unexplained === 30 && a4[0].notes === 0, JSON.stringify(a4));
  const many = allocate([{ day: '2026-11-01', cash: 120, pay: 30 }, { day: '2026-11-02', cash: 40, pay: 150, pos: 20 }, { day: '2026-11-03', cash: 75, pay: 10 }]);
  const sm = (k) => Math.round(many.reduce((x, r) => x + r[k], 0) * 100) / 100;
  check('summed: notes = cash − the part paid by card', sm('notes') === Math.round((sm('cash') - sm('on_cash')) * 100) / 100, JSON.stringify(many));

  /* THE FARES, summed per account and day (sql/schema_v128.sql). */
  const before = (await B('/api/card/crosscheck')).body?.totals;
  const fr = await refreshFares(db, { full: true, now: Date.parse('2026-11-23T08:00:00Z') });
  const fd = Object.fromEntries((await q(`SELECT platform || '|' || driver_ext_id || '|' || to_char(day, 'YYYY-MM-DD') AS k, cash::float AS cash, cash_trips, pos::float AS pos, pos_trips FROM card_fare_day`))
    .map((r) => [r.k, r]));
  check('the full rebuild sums cash trips and pos-driver fares per account and day (a card-paid trip and a pos-supervisor fare left out)',
    fr.full === true && fd['uber|u-alpha|2026-11-01']?.cash === 300 && fd['uber|u-alpha|2026-11-01'].cash_trips === 2
    && fd['hotel|h-alpha|2026-11-20']?.pos === 120 && fd['uber|u-alpha|2026-11-05']?.cash === 80 && !fd['hotel|h-alpha|2026-11-21'],
  JSON.stringify([fr, fd['uber|u-alpha|2026-11-01'], fd['hotel|h-alpha|2026-11-21']]));
  const after = (await B('/api/card/crosscheck')).body?.totals;
  check('…and the cross-check reads the same answer from the table as it did live', JSON.stringify(before) === JSON.stringify(after),
    JSON.stringify([before, after]));
  await q(`UPDATE card_fare_day SET cash = 9999 WHERE platform = 'uber' AND driver_ext_id = 'u-alpha' AND day = '2026-11-05'`);
  const dd = (await B(`/api/card/driver?person=${PA}`)).body || {};
  check('once built, the pages read the table (a planted 9999 shows), not the trip views', (dd.days || []).find((r) => r.day === '2026-11-05')?.cash === 9999);
  await q(`UPDATE card_fare_day SET cash = 7777 WHERE platform = 'uber' AND driver_ext_id = 'u-alpha' AND day = '2026-11-01'`);
  const recent = await refreshFares(db, { now: Date.parse('2026-11-23T08:00:00Z') });
  const [s01] = await q(`SELECT cash::float AS cash FROM card_fare_day WHERE driver_ext_id = 'u-alpha' AND day = '2026-11-01'`);
  const [s05] = await q(`SELECT cash::float AS cash FROM card_fare_day WHERE driver_ext_id = 'u-alpha' AND day = '2026-11-05'`);
  check('an hourly refresh rebuilds the last 14 days only (the 10th to the 23rd): the 1st and the 5th keep what was planted',
    recent.full === false && recent.from === '2026-11-10' && s01.cash === 7777 && s05.cash === 9999, JSON.stringify([recent, s01, s05]));
  await refreshFares(db, { full: true, now: Date.parse('2026-11-23T08:00:00Z') });
  await q(`INSERT INTO card_fare_day (platform, driver_ext_id, day, cash, cash_trips) VALUES ('uber', 'u-ghost', '2026-11-20', 5555, 1)`);
  const failed = await collect({ db, keyJson, sheetId: 'x', now: Date.parse('2026-11-23T09:00:00Z'),
    fetchImpl: async (url) => (String(url).includes('/token') ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 }) : new Response('{}', { status: 403 })) });
  const [ghost] = await q(`SELECT count(*)::int AS n FROM card_fare_day WHERE driver_ext_id = 'u-ghost'`);
  check('a read that fails still refreshes the fares (they come from the trips, not the sheet): a planted day with no trip is gone',
    failed.error && failed.fares?.full === false && ghost.n === 0, JSON.stringify([failed.fares, ghost]));

  /* THE PREVIEW, per driver. A chargeback on the 1st is not put back. */
  const [imp] = await q(`SELECT id FROM card_import ORDER BY id DESC LIMIT 1`);
  await q(`INSERT INTO card_payment (import_id, row_no, txn_day, fleet_id, terminal_id, amount, emirates_id) VALUES ($1, 999, '2026-11-01', 'ecosine', '601', -25, $2)`,
    [imp.id, E1]);
  const n = (await B('/api/card/notes')).body || {};
  const na = (n.drivers || []).find((r) => r.person_id === String(PA));
  check('the preview, one driver: 878 of cash fares, 828 paid by card, 50 left in notes; 120 on the hotel card machine; 245 not taken off',
    na?.cash === 878 && na.on_cash === 828 && na.notes === 50 && na.on_pos === 120 && na.unexplained === 245 && na.card === 1193,
    JSON.stringify(na));
  check('…the chargeback is shown, not put back into notes', na?.chargebacks === -25 && na.notes === 50, JSON.stringify(na));
  check('…the whole span by default once the fares are summed, with the totals', n.from === '2026-11-01' && n.to === '2026-11-21' && n.fares_summarised_at
    && n.totals?.drivers === 2 && n.totals.cash === 878 && n.totals.on_cash === 828 && n.totals.notes === 50 && n.totals.unexplained === 278,
  JSON.stringify([n.from, n.to, n.totals]));
  check('…and it says it is a preview no other figure uses yet', n.in_cash_position === false && /a preview/.test(n.note || ''));
  const d1 = ((await B(`/api/card/driver?person=${PA}`)).body?.days || []);
  const dy = (day) => d1.find((r) => r.day === day) || {};
  check('the driver\'s day table: the 1st paid 100 by card and 150 the next day, 50 left in notes; the 16th paid 70, 30 not taken off',
    dy('2026-11-01').on_cash === 100 && dy('2026-11-01').paid_next_day === 150 && dy('2026-11-01').notes === 50
    && dy('2026-11-16').on_cash === 70 && dy('2026-11-16').unexplained === 30, JSON.stringify([dy('2026-11-01'), dy('2026-11-16')]));
}

bare.server?.close?.(); gated.server?.close?.();
await pg.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
