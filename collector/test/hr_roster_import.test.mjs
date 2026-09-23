/* THE HR ROSTER IMPORT, END TO END, OVER A REAL SCHEMA.
   ─────────────────────────────────────────────────────────────────────────
   Preview writes nothing; commit writes one immutable snapshot; the same file
   twice is refused; a newer export marks the dropped "off the HR list since"
   and keeps every earlier row; a column that goes blank is REPORTED and the
   earlier value kept; rows match by platform id, then phone, never by name;
   HR's groupings become PROPOSALS on #same-person under basis hr_roster and
   never merges; the one contradiction shape the first export found surfaces
   in the preview AND in the queue; the write routes are admin-gated; and
   every JSONB value is valid JSON on node-postgres's own wire.

   Every value is SYNTHETIC (test/hr_workbook.mjs). The only real identifiers
   here are the two Uber account ids of REFUSED[0], read from
   api/identity_map.js at run time — account ids already in the repository,
   not documents — because the contradiction under test is exactly "a link to
   one member of a refused pair". */
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { hrExport, person, ids, D } from './hr_workbook.mjs';
import { REFUSED } from '../api/identity_map.js';
import { dubaiDay } from '../api/window.js';
import { clearPersonMapCache } from '../api/person_map.js';
import { contradictionsOf, pairKey } from '../api/hr_roster.js';

/* node-postgres's OWN parameter encoder — what production sends. PGlite types
   a JSONB parameter from the column and accepts a JS array production refuses
   (docs/COVERAGE.md, 2026-09-23). */
const { prepareValue } = createRequire(import.meta.url)('pg/lib/utils');

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const today = dubaiDay(new Date());
const addDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const d1 = addDays(-7);
const d2 = today;

/* ── the accounts this product already holds ──────────────────────────── */
const I = (n) => ids(n);
const RA = REFUSED[0].a.id;          // one member of a pair ruled two people
const RB = REFUSED[0].b.id;          // …and the other
const db = new PGlite();
await applySchema(db);
await db.exec(`
  INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state) VALUES
    ('uber',  '${I(1).uber}',  'ecosine', 'Testperson 1 Example', 'active'),
    ('yango', '${I(1).yango}', 'ecosine', 'TESTPERSON ONE',       'active'),
    ('uber',  '${I(2).uber}',  'egari',   'Testperson 2 Example', 'active'),
    ('bolt',  '${I(2).bolt}',  'egari',   'Testperson 2 Example', 'active'),
    ('uber',  '${I(3).uber}',  'ecosine', 'Testperson 3 Example', 'active'),
    ('yango', '${I(3).yango}', 'ecosine', 'Testperson 3 Example', 'active'),
    ('uber',  '${RA}',         'ecosine', 'Refused Member A',     'active'),
    ('uber',  '${RB}',         'ecosine', 'Refused Member B',     'active'),
    ('yango', '${I(6).yango}', 'ecosine', 'TESTPERSON SIX',       'active'),
    ('uber',  '${I(7).uber}',  'ecosine', 'Testperson 7 Example', 'active'),
    ('uber',  '${I(8).uber}',  'ecosine', 'Testperson 8 Example', 'active');
  INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone, licence_expires) VALUES
    ('yango', '${I(1).yango}', 'ecosine', 'TESTPERSON ONE', NULL, '2021-05-01'),
    ('hotel', 'h-test-4', 'ecosine', 'Someone Four', '971509900004', NULL),
    ('hotel', 'h-test-5', 'ecosine', 'Testperson 5 Example', '971501111115', NULL),
    ('hotel', 'h-test-8', 'ecosine', 'Someone Eight', '971509900008', NULL);
  INSERT INTO driver (id, full_name) VALUES (10, 'Testperson 3 Example');
  INSERT INTO driver_platform_id (platform, external_id, driver_id, basis) VALUES
    ('uber', '${I(3).uber}', 10, 'test'), ('yango', '${I(3).yango}', 10, 'test');
  INSERT INTO driver_identity_link (alias_ext_id, alias_platform, alias_name, canonical_ext_id,
      canonical_platform, canonical_name, canonical_key, basis, evidence) VALUES
    ('${I(6).yango}', 'yango', 'TESTPERSON SIX', '${RA}', 'uber', 'Refused Member A',
     'refused member a', 'same_name', 'a synthetic same-name link for this test');
`);
clearPersonMapCache();

/* Every statement inside a write transaction, with its parameters, so the
   JSONB values can be put through prepareValue exactly as bound. */
const recorded = [];
const recDb = {
  query: (...a) => db.query(...a),
  exec: (...a) => db.exec(...a),
  transaction: (fn) => db.transaction((t) => fn({
    query: (sql, p) => { recorded.push({ sql, p }); return t.query(sql, p); },
  })),
};
const api = await mountAll(recDb);
const base = `http://127.0.0.1:${api.port}`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const post = async (path, bytes, headers = {}) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', body: bytes,
    headers: { 'content-type': XLSX, ...headers } });
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body, text };
};
const n = async (t) => Number((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);

/* ── the first export ─────────────────────────────────────────────────── */
const first = [
  person(1, { 'Yango Contractor ID': I(1).yango, 'Passport Expiry': D(addDays(-10)) }),
  person(2, { fleet: 'egari', 'Employee ID': 'T001', 'Bolt User ID': I(2).bolt,
    'Emirates ID Expiry': D(addDays(20)) }),
  person(3, { 'Yango Contractor ID': I(3).yango }),
  person(4, { Phone: '+971509900004' }),              // uber id not held; phone is
  person(5, { Phone: '+971502222225' }),              // same NAME as h-test-5, other phone
  person(6, { 'Uber User ID': RB, 'Yango Contractor ID': I(6).yango }),
  person(7, { 'Bolt User ID': I(7).bolt, 'YAY User ID': I(7).yay }),
  person(8, { Phone: '+971509900008' }),              // uber held AND phone of h-test-8
];
const book1 = hrExport(first);
const name1 = `active-drivers-${d1}.xlsx`;

console.log('\nthe write routes are admin-gated; the read is not');
{
  process.env.ADMIN_TOKEN = 'test-token-hr-roster';
  const p = await post(`/api/hr-roster/preview?filename=${name1}`, book1);
  const c = await post(`/api/hr-roster/commit?filename=${name1}&by=tester`, book1);
  const g = await api.get('/api/hr-roster');
  const ok = await post(`/api/hr-roster/preview?filename=${name1}`, book1,
    { 'x-admin-token': 'test-token-hr-roster' });
  check('a preview without the admin token is refused', p.status === 401, String(p.status));
  check('a commit without the admin token is refused', c.status === 401, String(c.status));
  check('…and the refusal wrote nothing', (await n('hr_roster_upload')) === 0);
  check('the roster read answers anybody', g.status === 200, String(g.status));
  check('with the token the preview answers', ok.status === 200, `${ok.status} ${ok.text.slice(0, 200)}`);
  delete process.env.ADMIN_TOKEN;
}

console.log('\nbefore anything is uploaded, the page’s figures are absent with a reason');
{
  const g = await api.get('/api/hr-roster');
  check('no upload: latest is null and totals are null, not zero',
    g.body.latest === null && g.body.totals === null, JSON.stringify(g.body).slice(0, 200));
  check('…and it says why', /No HR roster has been uploaded yet/.test(g.body.absent_reason || ''));
}

console.log('\nthe preview says everything and writes nothing');
const links0 = await n('driver_identity_link');
const spine0 = await n('driver_platform_id');
const pv = await post(`/api/hr-roster/preview?filename=${name1}`, book1);
{
  const b = pv.body || {};
  check('the preview answers 200', pv.status === 200, pv.text.slice(0, 300));
  check('it read every row', b.rows_read === 8, String(b.rows_read));
  check('the fleet split', b.fleet_split?.ecosine === 7 && b.fleet_split?.egari === 1, JSON.stringify(b.fleet_split));
  check('matched by platform id: six', b.match?.by_platform_id === 6, JSON.stringify(b.match));
  check('matched by phone: one — the row none of whose ids is held', b.match?.by_phone === 1);
  check('unmatched: one — the same NAME with a different phone does not match', b.match?.unmatched === 1);
  check('the export date came from the filename', b.export_date === d1 && b.export_date_from === 'filename',
    `${b.export_date} ${b.export_date_from}`);
  check('three proposals, three people', b.proposals?.pairs === 3 && b.proposals?.people === 3
    && b.proposals?.new === 3, JSON.stringify(b.proposals && { ...b.proposals, list: undefined }));
  check('a pair already one person on the spine is not proposed', b.proposals?.already_one_person === 1);
  const c = (b.contradictions || []).find((x) => x.kind === 'link_to_refused_partner');
  check('the contradiction is in the preview: a link to one member of a refused pair', !!c,
    JSON.stringify(b.contradictions));
  check('…naming the employee and the link', c && c.employees[0].employee_id === 'T006'
    && c.link?.basis === 'same_name' && c.link?.confirmed === false, JSON.stringify(c));
  const y = b.licence_vs_yango || {};
  check('HR’s licence date against Yango’s: one compared, one differs',
    y.compared === 1 && y.differ === 1 && y.yango_older_by_over_a_year === 1, JSON.stringify(y));
  check('…and it is one where HR says valid and Yango says expired', y.hr_valid_yango_expired === 1);
  check('the expiry summary is per document', b.expiry?.passport?.expired === 1
    && b.expiry?.emirates_id?.d30 === 1 && b.expiry?.visa?.ok === 8, JSON.stringify(b.expiry));
  check('ids that cannot be matched are counted by platform', b.match?.ids_not_held?.yay === 1
    && b.match?.ids_not_held?.bolt === 1, JSON.stringify(b.match?.ids_not_held));
  check('NOTHING was written: no upload', (await n('hr_roster_upload')) === 0);
  check('…no rows', (await n('hr_roster_row')) === 0);
  check('…no proposals', (await n('hr_roster_proposal')) === 0);
  check('…and no link', (await n('driver_identity_link')) === links0);
}

console.log('\ncommit writes the snapshot');
recorded.length = 0;
const cm = await post(`/api/hr-roster/commit?filename=${name1}&by=tester&expect_sha=${pv.body.sha256}`, book1);
{
  check('the commit answers 200', cm.status === 200, cm.text.slice(0, 300));
  check('it names what it wrote', cm.body?.written === true && cm.body?.wrote?.rows === 8
    && cm.body?.wrote?.proposals_new === 3, JSON.stringify(cm.body?.wrote));
  const [u] = (await db.query('SELECT sha256, to_char(export_date,\'YYYY-MM-DD\') d, uploaded_by, rows_read, summary FROM hr_roster_upload')).rows;
  check('one upload, with its sha256 and export date', u && u.sha256 === pv.body.sha256 && u.d === d1
    && u.uploaded_by === 'tester' && u.rows_read === 8, JSON.stringify(u && { ...u, summary: undefined }));
  check('the summary is stored as JSON', u && typeof u.summary === 'object' && u.summary.match?.by_phone === 1);
  check('every row is stored', (await n('hr_roster_row')) === 8);
  check('three proposals are stored', (await n('hr_roster_proposal')) === 3);
  check('NOT ONE of them in driver_identity_link', (await n('driver_identity_link')) === links0
    && (await db.query(`SELECT count(*)::int n FROM driver_identity_link WHERE basis = 'hr_roster'`)).rows[0].n === 0);
  check('…and nobody was folded on the spine', (await n('driver_platform_id')) === spine0);
  /* node-postgres's own wire, not PGlite's. */
  const upIns = recorded.find((r) => /INSERT INTO hr_roster_upload/.test(r.sql));
  const rowIns = recorded.filter((r) => /INSERT INTO hr_roster_row/.test(r.sql));
  const jsonOk = (v) => { const w = prepareValue(v); if (w === null) return true; try { JSON.parse(w); return true; } catch { return false; } };
  check('the upload’s summary is valid JSON on the node-postgres wire', upIns && jsonOk(upIns.p[8]),
    upIns && String(prepareValue(upIns.p[8])).slice(0, 80));
  const per = 23;
  const accts = rowIns.flatMap((r) => r.p.filter((_, i) => i % per === per - 1));
  check('every row’s matched_accounts is valid JSON on the node-postgres wire',
    accts.length === 8 && accts.every(jsonOk), accts.map((v) => String(prepareValue(v)).slice(0, 60)).join(' | '));
  check('…and it is the array of accounts', accts.every((v) => { try { return Array.isArray(JSON.parse(prepareValue(v))); } catch { return false; } }));
}

console.log('\nthe same file twice is refused');
{
  const again = await post(`/api/hr-roster/commit?filename=${name1}&by=tester`, book1);
  check('a second commit of the same bytes is refused', again.status === 409, `${again.status} ${again.text.slice(0, 200)}`);
  check('…saying it was already imported, by whom', /already imported — upload \d+, the export of .*by tester/
    .test((again.body?.refusals || []).join(' ')), (again.body?.refusals || []).join(' | '));
  check('…and nothing was written', (await n('hr_roster_upload')) === 1 && (await n('hr_roster_row')) === 8);
  const pre = await post(`/api/hr-roster/preview?filename=${name1}`, book1);
  check('the preview refuses it too', pre.status === 409);
}
{
  const other = hrExport([person(1)]);
  const mis = await post(`/api/hr-roster/commit?filename=active-drivers-${d2}.xlsx&by=tester&expect_sha=${pv.body.sha256}`, other);
  check('a commit whose bytes are not the previewed file is refused', mis.status === 409
    && /not the file that was previewed/.test((mis.body?.refusals || []).join(' ')), mis.text.slice(0, 200));
  const who = await post(`/api/hr-roster/commit?filename=active-drivers-${d2}.xlsx`, other);
  check('a commit that does not say who is refused', who.status === 400 && /who is uploading/.test(who.text));
  const noDate = await post('/api/hr-roster/preview?filename=drivers.xlsx', other);
  check('a filename with no date asks for one', noDate.status === 400 && noDate.body?.needs_export_date === true
    && /enter the day HR exported it/.test(noDate.text), noDate.text.slice(0, 200));
  const entered = await post(`/api/hr-roster/preview?filename=drivers.xlsx&export_date=${d2}`, other);
  check('…and accepts it entered', entered.status === 200 && entered.body?.export_date_from === 'entered');
  const wrong = await post('/api/hr-roster/preview?filename=x.xlsx&export_date=2026-02-30', other);
  check('an entered date that is not a day is refused', wrong.status === 400 && /not a YYYY-MM-DD date/.test(wrong.text));
  const bad = await post(`/api/hr-roster/preview?filename=${name1}`,
    hrExport([person(1)], { sheetName: 'Sheet1' }));
  check('a workbook that is not the export is refused through the route, with its reason',
    bad.status === 400 && /no sheet called “Drivers”/.test(bad.text), bad.text.slice(0, 200));
}

console.log('\na newer export: dropped, blanked, renewed — and nothing deleted');
const second = [
  person(1, { 'Yango Contractor ID': I(1).yango, 'Passport Expiry': D(addDays(-10)) }),
  person(2, { fleet: 'egari', 'Employee ID': 'T001', 'Bolt User ID': I(2).bolt,
    'Emirates ID Expiry': D(addDays(20)), 'Passport Expiry': null }),
  person(3, { 'Yango Contractor ID': I(3).yango, 'Driving License Expiry': D('2031-01-01') }),
  person(4, { Phone: '+971509900004' }),
  person(5, { Phone: '+971502222225' }),
  person(6, { 'Uber User ID': RB, 'Yango Contractor ID': I(6).yango }),
  person(7, { 'Bolt User ID': I(7).bolt, 'YAY User ID': I(7).yay }),
  person(9),
];
const book2 = hrExport(second);
const name2 = `active-drivers-${d2}.xlsx`;
{
  const p2 = await post(`/api/hr-roster/preview?filename=${name2}`, book2);
  const a = p2.body?.against || {};
  check('the preview compares against the export before it', a.against?.export_date === d1, JSON.stringify(a.against));
  check('…and names who is no longer on the list', (a.dropped || []).some((x) => x.employee_id === 'T008'),
    JSON.stringify(a.dropped));
  check('…how many are new', a.added === 1, String(a.added));
  const bl = (a.blanked || []).find((x) => x.column === 'Passport Expiry');
  check('a column that went blank is reported, with the rows', bl && bl.rows === 1 && bl.employees.includes('T001'),
    JSON.stringify(a.blanked));
  check('…and said to be not documents vanishing', /REPORTED, not read as documents vanishing/.test(a.note || ''));
  const c2 = await post(`/api/hr-roster/commit?filename=${name2}&by=tester2&expect_sha=${p2.body?.sha256}`, book2);
  check('the newer export commits', c2.status === 200, c2.text.slice(0, 200));
  check('every row of BOTH exports is kept', (await n('hr_roster_row')) === 16, String(await n('hr_roster_row')));
}
const view = (await api.get('/api/hr-roster')).body;
const who = (fleet, emp) => view.people.find((p) => p.fleet_id === fleet && p.employee_id === emp);
{
  check('the latest export is the newer one', view.latest?.export_date === d2 && view.uploads.length === 2,
    JSON.stringify(view.latest));
  check('the upload history names date, sha, rows and who', view.uploads.every((u) => u.sha256 && u.export_date
    && Number.isFinite(u.rows_read) && u.uploaded_by), JSON.stringify(view.uploads.map((u) => u.uploaded_by)));
  const p8 = who('ecosine', 'T008');
  check('someone missing from the newer export is off the HR list since its date',
    p8 && p8.on_list === false && p8.off_list_since === d2, JSON.stringify(p8 && { on: p8.on_list, since: p8.off_list_since }));
  check('…and is still there, not deleted', !!p8 && p8.last_export_date === d1);
  const p2 = who('egari', 'T001');
  check('a blank in the newer export keeps the earlier value, marked with where it came from',
    p2 && p2.documents.passport.expires === '2030-01-01' && p2.documents.passport.expires_from_export === d1,
    JSON.stringify(p2?.documents?.passport));
  const p3 = who('ecosine', 'T003');
  check('a renewal shows: the licence date moved between the exports',
    p3 && p3.renewals.some((r) => r.document === 'licence' && r.from === '2029-01-01' && r.to === '2031-01-01'
      && r.seen_in_export === d2), JSON.stringify(p3?.renewals));
  check('the totals count the people on the latest export', view.totals.on_list === 8 && view.totals.off_list === 1,
    JSON.stringify(view.totals && { on: view.totals.on_list, off: view.totals.off_list }));
}

console.log('\nmatched by platform id, then phone — never by name');
{
  const p1 = who('ecosine', 'T001');
  check('a row with held ids matched by id', p1.match_basis === 'platform_id' && p1.accounts.length === 2,
    JSON.stringify(p1.accounts));
  const p4 = who('ecosine', 'T004');
  check('a row none of whose ids is held matched by phone',
    p4.match_basis === 'phone' && p4.accounts.length === 1 && p4.accounts[0].ext_id === 'h-test-4'
      && p4.accounts[0].via === 'phone', JSON.stringify(p4.accounts));
  const p5 = who('ecosine', 'T005');
  check('the same name with a different phone does NOT match', p5.match_basis === 'none' && p5.accounts.length === 0,
    JSON.stringify(p5.accounts));
  const rows8 = (await db.query(`SELECT matched_accounts FROM hr_roster_row WHERE employee_id = 'T008'`)).rows;
  const acc8 = rows8[0].matched_accounts;
  check('an id match wins: the phone-matched record is not added beside it',
    acc8.length === 1 && acc8[0].via === 'uber_id' && !acc8.some((a) => a.ext_id === 'h-test-8'), JSON.stringify(acc8));
  const p3 = who('ecosine', 'T003');
  check('an account on the spine links to its person', p3.person_id === 10, String(p3.person_id));
  const p7 = who('ecosine', 'T007');
  const yay = p7.unmatched_ids.find((u) => u.platform === 'yay');
  const bolt = p7.unmatched_ids.find((u) => u.platform === 'bolt');
  check('an unmatched YAY id says nothing collects YAY', yay && /nothing in this product collects YAY/.test(yay.reason),
    JSON.stringify(p7.unmatched_ids));
  check('an unmatched Ecosine Bolt UUID says why, measured', bolt && /refused for this fleet/.test(bolt.reason),
    bolt?.reason);
}

console.log('\nproposals are on the same-person queue, under basis hr_roster, and are not merges');
{
  const sp = (await api.get('/api/same-person')).body;
  const hr = sp.pending.filter((p) => p.basis === 'hr_roster');
  check('three HR proposals wait for an answer', hr.length === 3, JSON.stringify(hr.map((p) => p.employee)));
  check('each carries its employee and every id HR filed', hr.every((p) => p.proposal_id && p.employee?.employee_id
    && (p.accounts || []).length >= 2), JSON.stringify(hr[0]));
  check('…and the evidence names the employee and says nothing was merged',
    hr.every((p) => /under one employee/.test(p.evidence) && /nothing has been merged/.test(p.evidence)));
  check('an HR item carries no alias_ext_id, so a verdict cannot be sent to a link by mistake',
    hr.every((p) => !('alias_ext_id' in p)));
  const six = hr.find((p) => p.employee?.employee_id === 'T006');
  check('the contradicted HR proposal says so on its card', six && /ruled two people/.test(six.hr_contradiction || ''),
    six?.hr_contradiction);
  const link = sp.pending.find((p) => p.alias_ext_id === I(6).yango);
  check('the existing link HR contradicts carries the contradiction in the queue',
    link && /HR files/.test(link.hr_contradiction || ''), JSON.stringify(link && link.hr_contradiction));
  check('the queue lists every HR contradiction', (sp.hr_contradictions || []).some((c) => c.kind === 'link_to_refused_partner'),
    JSON.stringify(sp.hr_contradictions));
  check('and says which export they came from', sp.hr_roster?.export_date === d2, JSON.stringify(sp.hr_roster));

  const one = hr.find((p) => p.employee?.employee_id === 'T001' && p.employee?.fleet_id === 'ecosine')
    || { proposal_id: -1 };
  const r = await fetch(`${base}/api/same-person/decide`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposal_id: one.proposal_id, verdict: 'same', by: 'tester' }) });
  const body = await r.json();
  check('a verdict on an HR proposal is recorded', r.status === 200 && body.ok && body.source === 'hr_roster',
    JSON.stringify(body));
  check('…and says it merged nothing', body.applied_now === false && /Nothing was merged/.test(body.effect));
  const [v] = (await db.query(`SELECT verdict, decided_by FROM hr_roster_proposal WHERE id = $1`, [one.proposal_id])).rows;
  check('the verdict is on the HR proposal', v.verdict === 'same' && v.decided_by === 'tester');
  check('NOTHING was written to driver_identity_link', (await n('driver_identity_link')) === links0);
  check('…and nobody was folded on the spine', (await n('driver_platform_id')) === spine0);
  const after = (await api.get('/api/same-person')).body;
  check('the answered one moves to decided', after.decided.some((p) => p.proposal_id === one.proposal_id)
    && !after.pending.some((p) => p.proposal_id === one.proposal_id));
  const counts = (await api.get('/api/same-person?counts=1')).body;
  check('the backlog count carries HR’s basis', counts.by_basis?.hr_roster === 2, JSON.stringify(counts.by_basis));
  const miss = await fetch(`${base}/api/same-person/decide`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proposal_id: 99999, verdict: 'same' }) });
  check('an unknown HR proposal is a 404, not a link decision', miss.status === 404);
}

/* ── THE SHAPE THE REAL EXPORT FOUND, reduced ──────────────────────────────
   The dry run of the 2026-09-23 export against production's links found ONE
   contradiction, and it was not the fixture's shape above: a `same_name` link
   stamped confirmed with NO reviewer recorded, joining a Yango account Y to
   an Uber account A — while HR files Y with Uber account B under one employee
   and A under another, and A/B is a pair this product has ruled two people.
   Pure: contradictionsOf over a hand-built context, no database. */
console.log('\nthe real export’s contradiction, reduced to its shape');
{
  const ctx = {
    edges: [{ a: 'Y', a_platform: 'yango', b: 'A', b_platform: 'uber', source: 'link', basis: 'same_name',
      confirmed: true, confirmed_by: null, applied: true }],
    refused: new Map([[pairKey('A', 'B'), { source: 'register', why: 'simultaneous trips in two cars' }]]),
    same: () => false, rep: (x) => x,
  };
  const matched = [
    { fleet_id: 'ecosine', employee_id: 'E1', full_name: 'Testperson E1',
      accounts: [{ platform: 'uber', ext_id: 'B', via: 'uber_id' }, { platform: 'yango', ext_id: 'Y', via: 'yango_id' }] },
    { fleet_id: 'ecosine', employee_id: 'E2', full_name: 'Testperson E2',
      accounts: [{ platform: 'uber', ext_id: 'A', via: 'uber_id' }] },
  ];
  const cs = contradictionsOf(matched, ctx);
  const c = cs.find((x) => x.kind === 'link_joins_two_employees');
  check('a link HR splits across two employees is a contradiction', !!c && cs.length === 1, JSON.stringify(cs));
  check('…it says the link was stamped with no reviewer', c && /confirmed \(no reviewer recorded\)/.test(c.evidence), c?.evidence);
  check('…and that it touches a pair ruled two people', c && c.touches_refused_pair === true
    && /ruled a different person from A \(simultaneous trips in two cars\)/.test(c.evidence), c?.evidence);
  const plain = contradictionsOf(matched, { ...ctx, refused: new Map() });
  check('without the refusal it is still a contradiction, just not that one', plain.length === 1
    && plain[0].touches_refused_pair === false && !/ruled/.test(plain[0].evidence), JSON.stringify(plain));
}

console.log(`\n${pass} passed, ${fail} failed`);
api.server.close();
await db.close();
process.exit(fail ? 1 : 0);
