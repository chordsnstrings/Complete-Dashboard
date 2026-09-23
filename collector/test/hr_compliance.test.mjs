/* /api/compliance/drivers PUTS HR'S LICENCE DATE FIRST, AND KEEPS YANGO'S.
   ─────────────────────────────────────────────────────────────────────────
   Measured on the 2026-09-23 export: this route told the operator 88 people
   could not legally drive, every one of them on Yango's licence date, and for
   the 32 of them on HR's list HR says the licence is valid — 34 of Yango's 59
   dates were about five years older than HR's. The operator's decision: where
   HR carries a licence expiry, that date is the one counted; Yango's is kept
   beside it and reported as a disagreement, never silently dropped.

   Over the real route (test/mount.mjs), a real schema, and a synthetic HR
   export. The headline "cannot legally work" count is checked BEFORE and
   AFTER the upload, so the test proves HR moved it rather than that it
   happened to be zero. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { hrExport, person, D, numbers } from './hr_workbook.mjs';
import { dubaiDay } from '../api/window.js';
import { clearPersonMapCache } from '../api/person_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const today = dubaiDay(new Date());
const addDays = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const db = new PGlite();
await applySchema(db);
await db.exec(`
  INSERT INTO driver_compliance (platform, driver_ext_id, fleet_id, full_name, phone, licence_expires) VALUES
    ('yango', 'y-hr-a', 'ecosine', 'YANGO NAME A', NULL, '2021-03-01'),
    ('yango', 'y-hr-b', 'egari',   'YANGO NAME B', NULL, '${addDays(400)}');
  INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state) VALUES
    ('yango', 'y-hr-a', 'ecosine', 'YANGO NAME A', 'working'),
    ('yango', 'y-hr-b', 'egari',   'YANGO NAME B', 'working');
  INSERT INTO driver (id, full_name) VALUES (1, 'Testperson 31 Example'), (2, 'Testperson 32 Example');
  INSERT INTO driver_platform_id (platform, external_id, driver_id, basis) VALUES
    ('yango', 'y-hr-a', 1, 'test'), ('yango', 'y-hr-b', 2, 'test');
`);
clearPersonMapCache();
const api = await mountAll(db);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const before = (await api.get('/api/compliance/drivers')).body;
check('before any HR upload, the person on Yango’s old date is counted expired',
  before.people_totals.expired === 1, JSON.stringify(before.people_totals));
check('…and the route says no HR roster is uploaded, rather than showing empty HR columns',
  before.hr_roster === null && /No HR roster has been uploaded/.test(before.hr_absent_reason || ''));

const book = hrExport([
  person(31, { 'Uber User ID': null, 'Yango Contractor ID': 'y-hr-a',
    'Driving License Expiry': D('2030-01-01'), 'Passport Expiry': D(addDays(-3)) }),
  person(33, { 'Uber User ID': null, Phone: '+971502223333', 'Driving License Expiry': D(addDays(20)) }),
]);
const r = await fetch(`http://127.0.0.1:${api.port}/api/hr-roster/commit?filename=active-drivers-${today}.xlsx&by=tester`,
  { method: 'POST', body: book, headers: { 'content-type': XLSX } });
check('the synthetic HR export commits', r.status === 200, String(r.status));

const after = (await api.get('/api/compliance/drivers')).body;
const a = after.people.find((p) => p.accounts.some((x) => x.driver_ext_id === 'y-hr-a'));
const b = after.people.find((p) => p.accounts.some((x) => x.driver_ext_id === 'y-hr-b'));
const only = after.people.find((p) => p.hr_only);

console.log('\nHR’s licence date leads');
check('the person HR says is valid is valid', a && a.licence_status === 'valid', JSON.stringify(a && a.licence_status));
check('…on HR’s date', a && a.licence_expires === '2030-01-01' && a.licence_source === 'hr',
  JSON.stringify(a && { e: a.licence_expires, s: a.licence_source }));
check('Yango’s date is KEPT beside it', a && a.platform_licence_expires === '2021-03-01'
  && a.soonest_account?.driver_ext_id === 'y-hr-a', JSON.stringify(a && a.platform_licence_expires));
check('…and reported as a disagreement', a && a.licence_disagreement?.platform === 'yango'
  && a.licence_disagreement.hr_expires === '2030-01-01' && a.licence_disagreement.platform_expires === '2021-03-01',
  JSON.stringify(a && a.licence_disagreement));
check('the headline count moved because of HR: nobody is expired now', after.people_totals.expired === 0,
  JSON.stringify(after.people_totals));
check('…and the totals say how much rests on HR', after.people_totals.licence_from_hr === 2
  && after.people_totals.licence_disagreements === 1, JSON.stringify(after.people_totals));
check('a person HR does not list keeps the platform’s date, marked as the platform’s',
  b && b.licence_source === 'platform' && b.hr === null && b.licence_disagreement === null, JSON.stringify(b && b.licence_source));

console.log('\nHR’s documents on the person, never their numbers');
check('the HR record is on the person: employee, HR’s label, export date',
  a && a.hr?.employee_id === 'T031' && a.hr.hr_compliance_status === 'Compliant' && a.hr.export_date === today,
  JSON.stringify(a && a.hr && { ...a.hr, documents: undefined }));
check('every document with its expiry and status', a && a.hr.documents.passport.status === 'expired'
  && a.hr.documents.visa.expires === '2028-01-01' && a.hr.documents.rta_permit.expires === '2027-06-01');
check('…and whether a number is on file', a && a.hr.documents.passport.number_on_file === true
  && a.hr.documents.emirates_id.number_on_file === true);
const txt = JSON.stringify(after);
const n = numbers(31);
check('no HR number anywhere in the body', ![n.passport, n.eid, n.eid_digits, n.licence, n.rta].some((v) => txt.includes(v)));

console.log('\nsomebody on HR’s list with no account');
check('is a row, marked hr_only', only && only.hr?.employee_id === 'T033' && only.person_placed === false,
  JSON.stringify(only && { hr_only: only.hr_only, placed: only.person_placed }));
check('…counted on HR’s date', only && only.licence_status === 'expiring' && only.licence_source === 'hr');
check('…and NOT counted as an unplaced account', after.people_totals.hr_only === 1
  && after.people_totals.unplaced_accounts === 0 && after.person_basis === 'spine',
  JSON.stringify({ pt: after.people_totals.unplaced_accounts, basis: after.person_basis }));
check('the route names the export the HR columns come from', after.hr_roster?.export_date === today
  && after.hr_roster.attached === 2 && after.hr_roster.hr_only === 1, JSON.stringify(after.hr_roster));

console.log('\nthe fleet chip narrows HR too');
{
  const eg = (await api.get('/api/compliance/drivers?fleet=egari')).body;
  check('an Ecosine HR person is not on the Egari list', !eg.people.some((p) => p.hr), JSON.stringify(eg.people.map((p) => p.hr?.employee_id)));
}

console.log(`\n${pass} passed, ${fail} failed`);
api.server.close();
await db.close();
process.exit(fail ? 1 : 0);
