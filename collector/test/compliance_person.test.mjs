/* COMPLIANCE COUNTED RECORDS AND CALLED THEM DRIVERS.
   ══════════════════════════════════════════════════════════════════════════
   THE DEFECT, AND THE MEASUREMENT THAT PROVED IT. Measured on production
   2026-09-21 over the same roster, four surfaces gave four answers to "how
   many drivers":

       /api/drivers/directory      347   register + links + a NAME match
       /api/compliance/drivers     437   ACCOUNTS, not people
       /api/ledger/people          508   accounts, not people
       /api/ledger/exposure          0   only persons the money ledger minted

   810 platform accounts belong to roughly 349 people. src/persons.js
   materialises that into driver + driver_platform_id and every other surface
   in this product had been moved onto it — leaving #compliance the last one
   still counting driver_compliance ROWS, under the banner

       "140 drivers cannot legally work — the licence has expired"

   which is the single most consequential sentence this product prints. A man
   with a hotel record and an Uber record was two of that 140. If one of his
   two records carries a lapsed licence he is ONE person to stand down, and
   which record carries the lapsed paper is a filing question.

   ── what this file pins ──────────────────────────────────────────────────
   1. The person count is smaller than the record count, and the two are
      reported separately and named.
   2. A person is headed by the SOONEST expiry across everything they hold.
   3. Two records of one person that disagree about a document are FLAGGED —
      and the values are compared on the server and never emitted, which is
      what lets the check exist at all on a response that withholds licence
      numbers and Emirates IDs from an anonymous caller.
   4. A person whose dates cannot be checked renders ABSENT WITH A REASON, and
      the reason is the true one of three — never zero, never "valid".
   5. An account the spine has not placed is its own row, says so, and does not
      quietly inflate a headcount.
   6. The page renders people, says so, and is not a race against countUp.

   ── PROVED BY REVERTING ──────────────────────────────────────────────────
   Two assertions were proved by breaking the code and watching them fail,
   rather than by passing against a file that was never changed — the practice
   CLAUDE.md requires because a green suite over an unchanged file has produced
   a false "fixed" claim here more than once. Both reverts and both observed
   failures are recorded at the foot of this file.

   The fixture is a database, not a stub: the grouping reads the real spine
   through api/person_map.js and the roster through the real route. Dates are
   relative to now() so nothing here expires. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { clearPersonMapCache } from '../api/person_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

/* ── the roster ──────────────────────────────────────────────────────────
   Thirteen platform accounts over nine people, plus one account the spine has
   not placed. Every shape the page renders differently is here, because a
   fixture of one-account people cannot catch a page that has gone back to
   counting rows — it would answer the same number either way.

   THE PLACEHOLDER HAS TO BE TRIPPED FOR REAL. The route detects the source's
   never-filled-in default as one value on more than half of ONE CHANNEL's
   dated rows, with a floor of five. Six hotel rows carry 2020-01-01 against
   seven dated hotel rows — 0.857, over the 0.5 line — so the detector fires
   on the same evidence it uses in production rather than on a flag a fixture
   set by hand. The same six carry the identical licence number '123456',
   which trips the number detector the same way. */
const ACCOUNTS = [
  /* PERSON 1 — two records, BOTH lapsed, on different dates and under
     different licence numbers. As accounts this is two expired rows; as a
     human it is one person who cannot legally work. The Emirates ID is the
     same on both, so it must NOT be reported as a disagreement. */
  ['hotel', 'h-khalid', 'ecosine', 'MUHAMMAD KHALIFA AFZAL KHALID', '+971500000001',
    '784-1980-1111111-1', 'DL-77-A', "now()::date - 20", 'offline'],
  ['uber', 'u-khalid', 'ecosine', 'Muhammad Khalid', '+971500000001',
    '784-1980-1111111-1', 'DL-77-B', "now()::date - 5", 'active'],
  /* PERSON 2 — two records that AGREE about the licence and its expiry, so
     nothing may be flagged. One of them carries an Emirates ID and the other
     does not: a document only one record holds is not a disagreement, and a
     comparison that treated a blank as a value would accuse this person. */
  ['uber', 'u-imran', 'ecosine', 'Imran Shah', '+971500000002',
    null, 'DL-88', "now()::date + 10", 'active'],
  ['bolt', 'b-imran', 'egari', 'Imran Shah Akbar', '+971500000002',
    '784-1985-2222222-2', 'DL-88', "now()::date + 10", 'active'],
  /* PERSONS 3–7 — one record each, all carrying the source's default date and
     the source's default licence number. Not expired: never filled in. */
  ...Array.from({ length: 5 }, (_, i) => ['hotel', `h-ph${i + 1}`, 'ecosine',
    `Placeholder Person ${i + 1}`, `+97150000001${i}`,
    `784-1990-333333${i}-3`, '123456', "DATE '2020-01-01'", 'offline']),
  /* PERSON 8 — one record, no expiry date at all. A different absence from
     the one above and it gets a different sentence. */
  ['uber', 'u-nodate', 'ecosine', 'Undated Driver', '+971500000020',
    null, null, 'NULL', 'active'],
  /* PERSON 9 — one defaulted record and one blank one, which is the case
     neither single-cause wording describes. */
  ['hotel', 'h-mixed', 'ecosine', 'Half Filed', '+971500000021',
    null, '123456', "DATE '2020-01-01'", 'offline'],
  ['uber', 'u-mixed', 'ecosine', 'Half Filed', '+971500000021',
    null, null, 'NULL', 'active'],
  /* AND ONE ACCOUNT THE SPINE HAS NOT PLACED. It has a perfectly good licence
     date, so it cannot be excused as noise: it must appear, and it must say
     that nobody has attached it to a person. */
  ['uber', 'u-orphan', 'ecosine', 'Unplaced Account', '+971500000030',
    null, 'DL-99', "now()::date + 200", 'active'],
];
for (const [platform, id, fleet, name, phone, eid, lic, expires, state] of ACCOUNTS) {
  await q(`INSERT INTO driver_compliance
             (platform, driver_ext_id, fleet_id, full_name, phone, emirates_id,
              licence_no, licence_expires, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,${expires},$8)`,
  [platform, id, fleet, name, phone, eid, lic, state]);
}

/* ── the spine ───────────────────────────────────────────────────────────
   Written directly rather than by running src/persons.js: this file is about
   what the READ side does with a spine, and test/persons_spine.test.mjs
   already holds down how the spine is built. u-orphan is deliberately absent
   from it. */
const PEOPLE = [
  [1, 'Muhammad Khalid', [['hotel', 'h-khalid'], ['uber', 'u-khalid']]],
  [2, 'Imran Shah Akbar', [['uber', 'u-imran'], ['bolt', 'b-imran']]],
  [3, 'Placeholder Person 1', [['hotel', 'h-ph1']]],
  [4, 'Placeholder Person 2', [['hotel', 'h-ph2']]],
  [5, 'Placeholder Person 3', [['hotel', 'h-ph3']]],
  [6, 'Placeholder Person 4', [['hotel', 'h-ph4']]],
  [7, 'Placeholder Person 5', [['hotel', 'h-ph5']]],
  [8, 'Undated Driver', [['uber', 'u-nodate']]],
  [9, 'Half Filed', [['hotel', 'h-mixed'], ['uber', 'u-mixed']]],
];
for (const [id, name, accounts] of PEOPLE) {
  await q(`INSERT INTO driver (id, fleet_id, full_name) VALUES ($1,'ecosine',$2)`, [id, name]);
  for (const [platform, ext] of accounts) {
    await q(`INSERT INTO driver_platform_id (platform, external_id, driver_id, display_name, basis)
             VALUES ($1,$2,$3,$4,'reviewed')`, [platform, ext, id, name]);
  }
}
/* The map is cached for thirty seconds and this process may already hold an
   empty one from another suite in the same run. */
clearPersonMapCache();

const { get, port } = await mountAll(db);
/* mountAll's own get() sends no headers, and the admin branch of this route is
   a header. Fetched directly rather than by widening a helper thirty other
   suites share. */
const getAs = async (path, headers) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  return JSON.parse(await r.text());
};
const body = (await get('/api/compliance/drivers')).body;
const person = (id) => (body.people || []).find(
  (p) => (p.accounts || []).some((a) => a.driver_ext_id === id));

/* ── 1. the two populations, told apart ─────────────────────────────────── */
console.log('\na count of people, and a count of records, and the difference said out loud');
check('every account on the roster is still returned, one row each',
  body.drivers.length === 13, String(body.drivers.length));
check('…and they fold into fewer PEOPLE than there are records',
  body.people.length === 10 && body.people.length < body.drivers.length,
  `${body.people.length} people over ${body.drivers.length} records`);
check('no account is lost in the fold, and none is counted twice',
  body.people.reduce((n, p) => n + p.account_count, 0) === body.drivers.length
    && new Set(body.people.flatMap((p) => p.accounts.map((a) => a.driver_ext_id))).size === 13,
  String(body.people.reduce((n, p) => n + p.account_count, 0)));
check('the response names which population each number counts',
  body.counts.people === 10 && body.counts.accounts_on_this_roster === 13
    && /accounts_on_this_roster counts driver_compliance records/.test(body.counts.note || ''),
  JSON.stringify(body.counts));
/* THE HEADLINE. Two expired records, one expired human. This is the whole
   defect in one pair of numbers, and it is the first assertion that was
   proved by reverting — see the foot of this file. */
check('two lapsed RECORDS belonging to one man are ONE person who cannot legally work',
  body.totals.expired === 2 && body.people_totals.expired === 1,
  `${body.totals.expired} records, ${body.people_totals.expired} people`);
check('…and the same holds for the people expiring within 45 days',
  body.totals.within_45 === 2 && body.people_totals.expiring_45 === 1,
  `${body.totals.within_45} records, ${body.people_totals.expiring_45} people`);

/* ── 2. the soonest expiry is the person's ──────────────────────────────── */
console.log('\na person is headed by the worst of their records, and says which one it was');
{
  const p = person('h-khalid');
  check('the person carries both of their records',
    p && p.account_count === 2 && p.platforms.join(',') === 'hotel,uber',
    JSON.stringify(p && p.platforms));
  check('…is headed by the SOONEST of the two expiries, not the one that sorted first',
    p && p.days_left === -20, String(p && p.days_left));
  check('…and names the record that expiry came from, so an operator has somewhere to go',
    p && p.soonest_account && p.soonest_account.driver_ext_id === 'h-khalid',
    JSON.stringify(p && p.soonest_account));
  check('…and reads as expired rather than as two thirds of an answer',
    p && p.licence_status === 'expired', String(p && p.licence_status));
  check('the person is named by the spine, not by whichever record sorted first',
    p && p.name === 'Muhammad Khalid', String(p && p.name));
}

/* ── 3. records of one person that disagree ─────────────────────────────── */
console.log('\ntwo records of one person that disagree about a document are flagged, never quoted');
{
  const p = person('h-khalid');
  check('a different licence number on two records of one person is flagged',
    p && p.conflict_fields.includes('licence_no'), JSON.stringify(p && p.conflict_fields));
  check('…and a different expiry date on the same two records is flagged too',
    p && p.conflict_fields.includes('licence_expires'), JSON.stringify(p && p.conflict_fields));
  check('…and the flag names the records that disagree',
    p && (p.conflicts.find((c) => c.field === 'licence_no') || {}).accounts
      ?.map((a) => a.driver_ext_id).sort().join(',') === 'h-khalid,u-khalid',
    JSON.stringify(p && p.conflicts));
  check('an identity number that is the SAME on both records is not a disagreement',
    p && !p.conflict_fields.includes('emirates_id'), JSON.stringify(p && p.conflict_fields));
}
{
  const p = person('u-imran');
  check('a person whose two records agree is not accused of anything',
    p && p.conflicts.length === 0 && p.account_count === 2,
    JSON.stringify(p && p.conflict_fields));
  check('…and a document only ONE of the two records carries is not a disagreement either',
    p && !p.conflict_fields.includes('emirates_id'),
    JSON.stringify(p && p.conflicts));
}
check('exactly one person on this roster holds records that disagree',
  body.people_totals.with_conflicts === 1, String(body.people_totals.with_conflicts));
/* THE POINT OF DOING THE COMPARISON ON THE SERVER. These rows are served to a
   caller with no token — this product has no sign-in — so stripIdentity() has
   already removed licence_no and emirates_id from every row. The comparison
   still happens, because it happens before the boundary and reports only a
   difference. This is the second assertion proved by reverting. */
const text = JSON.stringify(body);
check('the licence numbers that were compared do not appear anywhere in the response',
  !text.includes('DL-77-A') && !text.includes('DL-77-B') && !/\b123456\b/.test(text),
  (text.match(/DL-77-[AB]|\b123456\b/) || [''])[0]);
check('…nor does any Emirates ID, though one of them was compared',
  !/\b784-\d{4}-\d{7}-\d\b/.test(text), (text.match(/\b784-\d{4}-\d{7}-\d\b/) || [''])[0]);
check('…and the anonymous rows carry no identity-document keys at all',
  body.people.every((p) => p.accounts.every(
    (a) => !('licence_no' in a) && !('emirates_id' in a))),
  JSON.stringify(body.people[0].accounts[0]));
check('the conflict entry carries a COUNT of distinct values and no values',
  body.people.flatMap((p) => p.conflicts).every(
    (c) => typeof c.distinct === 'number' && !('values' in c) && !('value' in c)),
  JSON.stringify(body.people.flatMap((p) => p.conflicts)));
/* An administrator gets the documents on the account rows, where they belong.
   The conflict entries still carry no values — the difference is the finding,
   and duplicating the numbers into it would be a second place for them to
   escape from. */
{
  process.env.ADMIN_TOKEN = 'test-token-not-a-real-one';
  clearPersonMapCache();
  const adm = await getAs('/api/compliance/drivers',
    { 'x-admin-token': process.env.ADMIN_TOKEN });
  const p = (adm.people || []).find((x) => x.accounts.some((a) => a.driver_ext_id === 'h-khalid'));
  check('an administrator is given the documents on the records themselves',
    p && p.accounts.some((a) => a.licence_no === 'DL-77-A')
      && p.accounts.some((a) => a.licence_no === 'DL-77-B'),
    JSON.stringify(p && p.accounts.map((a) => a.licence_no)));
  check('…while the conflict entry still states a difference and quotes nothing',
    !JSON.stringify(adm.people.flatMap((x) => x.conflicts)).includes('DL-77'),
    JSON.stringify(adm.people.flatMap((x) => x.conflicts)).slice(0, 200));
  delete process.env.ADMIN_TOKEN;
  clearPersonMapCache();
}

/* ── 4. absent with a reason, and the reason is the true one ────────────── */
console.log('\na person whose licence cannot be checked is absent with a reason, never zero');
check('the source’s default date was detected on its own evidence',
  body.placeholder_date === '2020-01-01' && body.placeholder_rows === 6,
  `${body.placeholder_date} x ${body.placeholder_rows}`);
{
  const p = person('h-ph1');
  check('a person whose only date is the source’s default is not expired',
    p && p.licence_status === 'unknown' && p.days_left === null,
    `${p && p.licence_status} / ${p && p.days_left}`);
  check('…and is not "valid" either — the page is told it cannot say',
    p && p.licence_status !== 'valid' && /never filled in/.test(p.licence_unknown_reason || ''),
    String(p && p.licence_unknown_reason));
}
{
  const p = person('u-nodate');
  check('a person no channel files a date for gets a DIFFERENT reason',
    p && p.licence_status === 'unknown'
      && /no channel that onboarded this person publishes/.test(p.licence_unknown_reason || ''),
    String(p && p.licence_unknown_reason));
}
{
  const p = person('h-mixed');
  check('a person with one defaulted record and one blank one gets a sentence naming both',
    p && /1 carry the value this source writes/.test(p.licence_unknown_reason || '')
      && /1 carry no date at all/.test(p.licence_unknown_reason || ''),
    String(p && p.licence_unknown_reason));
  check('…and the row carries the per-record counts the sentence is built from',
    p && p.placeholder_accounts === 1 && p.no_date_accounts === 1 && p.dated_accounts === 0,
    JSON.stringify(p && [p.placeholder_accounts, p.no_date_accounts, p.dated_accounts]));
}
check('the unanswerable people are counted as unanswerable, and split by cause',
  body.people_totals.unknown === 7 && body.people_totals.placeholder_only === 6
    && body.people_totals.no_date_at_all === 1,
  JSON.stringify(body.people_totals));
check('…and none of them is counted as expired or as valid',
  body.people_totals.expired + body.people_totals.expiring_45
    + body.people_totals.valid + body.people_totals.unknown === body.people_totals.total,
  JSON.stringify(body.people_totals));

/* ── 5. an account nobody has placed ────────────────────────────────────── */
console.log('\nan account the spine has not placed is a row that says so, not a person');
{
  const p = person('u-orphan');
  check('the unplaced account still appears — a licence nobody has attached still expires',
    !!p, String(!!p));
  check('…and it does not claim to be a person',
    p && p.person_placed === false && p.person_id === null,
    JSON.stringify(p && [p.person_placed, p.person_id]));
  check('the response says the total is people PLUS accounts nobody has placed',
    body.person_basis === 'spine-partial' && body.people_totals.placed === 9
      && body.people_totals.unplaced_accounts === 1,
    `${body.person_basis} ${body.people_totals.placed}/${body.people_totals.unplaced_accounts}`);
  check('…in a sentence a page can print rather than a code it has to interpret',
    /accounts it has not attached to anybody yet/.test(body.person_basis_note || ''),
    String(body.person_basis_note));
}
/* THE FAILURE MODE personMap's OWN CONTRACT WARNS ABOUT. `ok` is false only
   when the query threw, and a caller that reads that as "nobody is anybody"
   turns a failed read into a fleet of one-account drivers. The page must be
   told it is a failure to measure. */
console.log('\na spine that cannot be read is a failure to measure, not a fleet of strangers');
{
  clearPersonMapCache();
  await db.query('ALTER TABLE driver_platform_id RENAME TO driver_platform_id_hidden');
  const broken = (await get('/api/compliance/drivers')).body;
  await db.query('ALTER TABLE driver_platform_id_hidden RENAME TO driver_platform_id');
  clearPersonMapCache();
  check('the roster is still served rather than 500ing', Array.isArray(broken.people),
    String(broken && broken.error));
  check('…but the response says the headcount could not be taken',
    broken.person_basis === 'unreadable', String(broken.person_basis));
  check('…and says so in plain English, naming it as a failure to measure',
    /could not be read/.test(broken.person_basis_note || '')
      && /not a fleet of one-account drivers/.test(broken.person_basis_note || ''),
    String(broken.person_basis_note));
  check('…and does not pass 13 accounts off as 13 drivers',
    broken.people.every((p) => p.person_placed === false),
    JSON.stringify(broken.people.map((p) => p.person_placed)));
}

/* ── 6. the page ────────────────────────────────────────────────────────── */
console.log('\nthe page renders people, and says that is what it is counting');
{
  const { chromium } = await import('playwright');
  const { app } = await import('../mockapi.mjs');
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  /* reducedMotion: EVERY HEADLINE NUMBER COUNTS UP OVER 620ms, so every
     assertion on a .kpi tile is a race. countUp in api/public/app.js animates
     .kpi .n from zero; measured across six runs of one assertion the API
     answered 420 for, a test read 419.72, 419.77, 419.83, 419.85, 419.95 and
     419.99 — and passed on the seventh, which is how it came to be written.
     countUp is skipped under prefers-reduced-motion, Playwright sets that
     media query directly, and it is a state a real reader can be in. */
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
  await page.goto(`${base}/#compliance`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-panel="compliance-people"] table', { timeout: 20000 });
  check('the view renders without a page error', errs.length === 0, errs.join(' | '));

  const tile = await page.$eval('[data-kpi="compliance-expired-people"]', (e) => e.innerText);
  /* The fixture carries 3 expired licence RECORDS over 2 people, deliberately
     unequal, so a tile that had gone back to counting rows would read 3. */
  check('the headline figure is the number of PEOPLE, not of records',
    /\b2\b/.test(tile) && !/\b3\b/.test(tile.split('\n')[1] || ''), tile.replace(/\n/g, ' | '));
  check('…and the tile says in words that it is counting people',
    /people/i.test(tile) && /cannot legally work/i.test(tile), tile.replace(/\n/g, ' | '));
  check('…with the record count beside it, so the two can never be read as one number',
    /3 expired licence records/i.test(tile), tile.replace(/\n/g, ' | '));

  const panelText = await page.$eval('[data-panel="compliance-people"]', (e) => e.innerText);
  check('the table says it is one row per person, with the records listed inside',
    /one row per person/i.test(panelText), panelText.slice(0, 200).replace(/\n/g, ' | '));
  check('a person holding two records shows both of them, with each one’s documents',
    /Records and their documents/i.test(panelText)
      && /Bolt/i.test(panelText) && /Hotel/i.test(panelText),
    panelText.slice(0, 400).replace(/\n/g, ' | '));
  check('a disagreement between two of one person’s records is on the row',
    /licence number differs/i.test(panelText) && /expiry date differs/i.test(panelText),
    (panelText.match(/.{0,60}differs.{0,40}/) || [''])[0]);
  check('a person whose date is the source’s default reads "cannot be checked", not expired',
    /cannot be checked/i.test(panelText), panelText.slice(0, 600).replace(/\n/g, ' | '));
  /* The panel's own caption is a .cap too, and it is a child of .panel while
     the sentence under the table is a child of .pbody — so a selector that
     does not say which one reads the heading's caption and asserts nothing. */
  const foot = await page.$eval('[data-panel="compliance-people"] .pbody > .cap',
    (e) => e.innerText).catch(() => '');
  check('the sentence under the table counts people AND the records behind them',
    /people/.test(foot) && /platform records/.test(foot), foot);

  const pageText = await page.evaluate(() => document.body.innerText);
  check('the page states what its headcount was built from',
    /reviewed person spine/i.test(pageText), (pageText.match(/.{0,80}spine.{0,80}/) || [''])[0]);

  await browser.close();
  srv.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/* ── PROVED BY REVERTING ──────────────────────────────────────────────────
   CLAUDE.md: "Prove a fix by reverting it and watching the test fail. A test
   that passes against the unchanged file has proved nothing." Both reverts
   below were applied to the working tree, this file was run, the named
   assertions failed, and the revert was undone. The counts are the ones the
   runs actually printed.

   ── REVERT 1 — group by ACCOUNT instead of by person ─────────────────────
   Which is what the route did before this change. In api/server.js, in the
   grouping block, drop the `pid == null ?` so every row keys on its own
   account:

       const key = `account:${raw.platform}\u0000${raw.driver_ext_id}`;

   Run: 35 passed, 15 FAILED. Among them:

     ✗ …and they fold into fewer PEOPLE than there are records
           13 people over 13 records
     ✗ two lapsed RECORDS belonging to one man are ONE person who cannot
       legally work                         2 records, 2 people
     ✗ …and the same holds for the people expiring within 45 days
                                            2 records, 2 people
     ✗ the person carries both of their records            ["hotel"]
     ✗ a different licence number on two records of one person is flagged  []
     ✗ …and a different expiry date on the same two records is flagged too []
     ✗ exactly one person on this roster holds records that disagree       0
     ✗ the response names which population each number counts
           {"people":13,"accounts_on_this_roster":13,…}
     ✗ the unanswerable people are counted as unanswerable, and split by
       cause    {"total":13,…,"unknown":8,"placeholder_only":6,
                 "no_date_at_all":2,"with_conflicts":0,"multi_account":0}

   Two assertions in that section still PASSED under the revert, and they are
   worth naming because they are the ones that would have made this a false
   proof if they had been the only ones: "…is headed by the SOONEST of the two
   expiries" passes because h-khalid's own row is the -20 one, and "the person
   is named by the spine" passes because the name is still read off the spine
   even when the key is the account. An assertion that cannot fail is not
   evidence; the fourteen that did are.

   ── REVERT 2 — put the values on the conflict ────────────────────────────
   In api/server.js, inside `cmp`, add to the pushed object:

       values: [...distinct],

   Run: 47 passed, 3 FAILED.

     ✗ the licence numbers that were compared do not appear anywhere in the
       response                                                     DL-77-A
     ✗ the conflict entry carries a COUNT of distinct values and no values
           [{"field":"licence_no","distinct":2,
             "values":["DL-77-A","DL-77-B"],…}]
     ✗ …while the conflict entry still states a difference and quotes nothing
           (the same, on the ADMIN response)

   That is the assertion that matters most on this route. The licence numbers
   are withheld from an anonymous caller by stripIdentity(), and a conflict
   check that reported WHAT differed rather than THAT it differed would have
   handed them straight back through the one field nobody was watching — the
   same shape as the finding in api/redact.js's header, where the identity-doc
   list living in two files let /api/driver/profile go on serving an Emirates
   ID after the roster had stopped. */
