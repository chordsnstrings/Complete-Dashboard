/* NO ROUTE RETURNS AN HR DOCUMENT NUMBER — except the two the operator put on
   the driver page, and only there.
   ─────────────────────────────────────────────────────────────────────────
   The operator's decisions of 2026-09-23, as api/redact.js records them:

     passport_no     stored, returned by NO route
     rta_permit_no   stored, returned by NO route
     emirates_id     stored, returned by /api/driver/profile ONLY
     licence_no      stored, returned by /api/driver/profile ONLY
     visa number     not stored at all

   Asserted BY VALUE, not by key: a synthetic snapshot is committed with
   distinctive invented numbers, and the body of every GET route the
   application declares is swept for them — plus the raw-values sampler asked
   about every document-shaped key, the CSV export, both HR write routes, the
   same-person queue and its verdict, and /api/compliance/drivers as an
   ADMINISTRATOR (who is shown the compliance record's numbers, and must still
   not be shown HR's). "A second place a document can escape from is the
   whole defect, whatever the first place does" — api/redact.js.

   A POSITIVE CONTROL comes first: the driver page does carry the Emirates ID
   and the licence number. Without it a sweep over a database where the match
   silently failed would pass for the wrong reason. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll, declaredRoutes } from './mount.mjs';
import { hrExport, person, numbers } from './hr_workbook.mjs';
import { dubaiDay } from '../api/window.js';
import { HR_NUMBERS_SERVED } from '../api/redact.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
const api = await mountAll(db);
const base = `http://127.0.0.1:${api.port}`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const today = dubaiDay(new Date());

/* Four employees: two matched to fixture drivers by platform id, one by
   id to a Yango account, one matched to nobody. */
const people = [
  person(21, { 'Uber User ID': 'u-khalid', 'Yango Contractor ID': 'y-khalid' }),
  person(22, { 'Uber User ID': 'u-kashif', 'Bolt User ID': 'b-kashif' }),
  person(23, { 'Uber User ID': null, 'Yango Contractor ID': 'y-tariq' }),
  person(24, { 'Uber User ID': null }),
];
const N = [21, 22, 23, 24].map(numbers);
const NEVER = N.flatMap((x) => [x.passport, x.rta]);
const PROFILE_ONLY = N.flatMap((x) => [x.eid, x.eid_digits, x.licence]);
const allowedOn = (route) => (HR_NUMBERS_SERVED[route] ? PROFILE_ONLY : []);

const post = async (path, body, type = XLSX) => {
  const r = await fetch(`${base}${path}`, { method: 'POST', body, headers: { 'content-type': type } });
  return { status: r.status, text: await r.text() };
};
const offenders = [];
const sweep = (label, route, text) => {
  const ok = new Set(allowedOn(route));
  for (const v of [...NEVER, ...PROFILE_ONLY]) {
    if (ok.has(v)) continue;
    if (String(text).includes(v)) offenders.push(`${label}: carries ${v.slice(0, 4)}…`);
  }
};

console.log('\nthe write routes, with a real file in them');
const book = hrExport(people);
const name = `active-drivers-${today}.xlsx`;
const pv = await post(`/api/hr-roster/preview?filename=${name}`, book);
sweep('POST /api/hr-roster/preview', '/api/hr-roster/preview', pv.text);
const cm = await post(`/api/hr-roster/commit?filename=${name}&by=tester`, book);
sweep('POST /api/hr-roster/commit', '/api/hr-roster/commit', cm.text);
check('the synthetic snapshot committed', cm.status === 200, cm.text.slice(0, 200));
const again = await post(`/api/hr-roster/commit?filename=${name}&by=tester`, book);
sweep('POST /api/hr-roster/commit (refused)', '/api/hr-roster/commit', again.text);
check('…and the numbers ARE stored (the sweep is not over an empty table)',
  (await db.query(`SELECT count(*)::int n FROM hr_roster_row
                    WHERE passport_no IS NOT NULL AND rta_permit_no IS NOT NULL
                      AND emirates_id IS NOT NULL AND licence_no IS NOT NULL`)).rows[0].n === 4);
check('…the Emirates ID as its fifteen digits',
  (await db.query(`SELECT emirates_id FROM hr_roster_row WHERE employee_id = 'T021'`)).rows[0].emirates_id
    === N[0].eid_digits);

console.log('\nthe positive control: the driver page carries exactly the two it is allowed');
{
  const r = await api.get('/api/driver/profile?id=u-khalid&from=2026-08-01&to=2026-08-31');
  const hr = r.body?.hr || {};
  check('the Emirates ID number is on the driver page', hr.emirates_id === N[0].eid, JSON.stringify(hr));
  check('…and the UAE licence number', hr.licence_no === N[0].licence);
  check('…and HR’s licence expiry leads, the platform’s kept beside it',
    r.body?.licence?.source === 'hr' && r.body.licence.expires === '2029-01-01'
      && r.body.licence.platform?.expires === '2026-11-15' && r.body.licence.disagree === true,
    JSON.stringify(r.body?.licence));
  check('…and the passport and RTA permit numbers are not', !r.raw && !JSON.stringify(r.body).includes(N[0].passport)
    && !JSON.stringify(r.body).includes(N[0].rta));
  check('the account from the other record of the same person reaches the same row',
    (await api.get('/api/driver/profile?id=y-khalid&from=2026-08-01&to=2026-08-31')).body?.hr?.employee_id === 'T021');
  check('a driver HR does not list has no HR row, rather than an empty one',
    (await api.get('/api/driver/profile?id=u-nauman&from=2026-08-01&to=2026-08-31')).body?.hr === null);
}

console.log('\nevery GET route the application declares');
const WIN = 'from=2026-08-01&to=2026-08-31';
/* Arguments by route FAMILY, so every per-entity route answers about a real
   fixture driver or car rather than 404ing for want of an id — a 404 body is
   a sweep that swept nothing. A function over prefixes rather than an ARGS
   table, because test/route_smoke.test.mjs reads every `const ARGS` in the
   suite as a list of ROUTES and rightly refuses a key that is not one. */
const argsFor = (route) => {
  if (route.startsWith('/api/driver/')) return '&id=u-khalid';
  if (route.startsWith('/api/vehicle/') || route === '/api/track') return `&plate=${PLATES[0]}`;
  if (route === '/api/map/journey') return `&plate=${PLATES[0]}&day=2026-08-05`;
  if (route === '/api/trip') return '&platform=uber&id=uber-30-9';
  if (route === '/api/day') return '&day=2026-08-05';
  if (route === '/api/slot') return '&dow=2&hour=19';
  if (route.startsWith('/api/mix')) return '&by=payment';
  if (route === '/api/corporate/property') return '&id=p-marina';
  return '';
};
let swept = 0;
for (const route of declaredRoutes()) {
  if (route.includes(':')) continue;
  const r = await fetch(`${base}${route}?${WIN}${argsFor(route)}`);
  sweep(`GET ${route}`, route, await r.text());
  swept += 1;
}
/* The driver page again, addressed by PERSON as well as by account, and the
   sampler asked about every key a document number could hide under. */
for (const key of ['emirates_id', 'emiratesId', 'passport_no', 'passport', 'licence_no', 'licenseNumber',
  'rta_permit_no', 'permitNumber', 'Passport Number', 'Emirates ID Number']) {
  for (const table of ['trip', 'alert', 'telemetry_snapshot', 'driver_performance', 'vehicle_profile']) {
    const r = await fetch(`${base}/api/schema/raw-values?table=${table}&key=${encodeURIComponent(key)}&${WIN}`);
    sweep(`GET /api/schema/raw-values ${table}.${key}`, '/api/schema/raw-values', await r.text());
    swept += 1;
  }
}
{
  const r = await fetch(`${base}/api/export/trips.csv?${WIN}`);
  sweep('GET /api/export/trips.csv', '/api/export/trips.csv', await r.text());
  const sp = await fetch(`${base}/api/same-person`);
  const spText = await sp.text();
  sweep('GET /api/same-person', '/api/same-person', spText);
  const pid = (JSON.parse(spText).pending || []).find((p) => p.proposal_id)?.proposal_id;
  const d = await post('/api/same-person/decide', JSON.stringify({ proposal_id: pid, verdict: 'same' }), 'application/json');
  sweep('POST /api/same-person/decide', '/api/same-person/decide', d.text);
  process.env.ADMIN_TOKEN = 'test-token-numbers';
  const adm = await fetch(`${base}/api/compliance/drivers`, { headers: { 'x-admin-token': 'test-token-numbers' } });
  const admText = await adm.text();
  sweep('GET /api/compliance/drivers as an administrator', '/api/compliance/drivers', admText);
  delete process.env.ADMIN_TOKEN;
  check('the administrator’s compliance body is the real one (it carries the compliance record’s numbers)',
    /"licence_no":"Lu-khalid"/.test(admText), admText.slice(0, 120));
  swept += 4;
}
check('the sweep covered every declared route and more', swept > 150, String(swept));
check('NO route returns a passport or RTA-permit number, and none but the driver page an Emirates ID or licence number',
  offenders.length === 0, `\n      ${offenders.join('\n      ')}`);

console.log('\nthe roster page says a number is on file, without it');
{
  const r = await api.get('/api/hr-roster');
  const p = r.body.people.find((x) => x.employee_id === 'T021');
  check('each document says whether a number is on file',
    p && p.documents.passport.number_on_file === true && p.documents.emirates_id.number_on_file === true
      && p.documents.licence.number_on_file === true && p.documents.rta_permit.number_on_file === true,
    JSON.stringify(p?.documents));
  check('the visa’s number is not a thing this product keeps, and says null rather than false',
    p && p.documents.visa.number_on_file === null);
  check('…and no key on a person is a document number', p && !['passport_no', 'emirates_id', 'licence_no',
    'rta_permit_no'].some((k) => k in p));
}

/* ── THE MOCK'S HR ROWS HAVE THE REAL ROWS' SHAPE ─────────────────────────
   test/mockapi.test.mjs compares the mock with a real database that has no
   HR upload, so every HR list there is empty and "an empty fixture list says
   nothing". This database has one — so the row-level comparison that test
   cannot make is made here: every key a real HR row carries, the mock's rows
   carry too. */
console.log('\nthe mock’s HR rows are the real rows’ shape');
{
  const { app: mockApp } = await import('../mockapi.mjs');
  const ms = mockApp.listen(0);
  const mget = async (p) => (await fetch(`http://127.0.0.1:${ms.address().port}${p}`)).json();
  const lacks = (real, mock) => Object.keys(real || {}).filter((k) => !(k in (mock || {})));
  const keysOf = (rows) => Object.assign({}, ...rows.map((r) => Object.fromEntries(Object.keys(r).map((k) => [k, 1]))));
  const rv = (await api.get('/api/hr-roster')).body;
  const mv = await mget('/api/hr-roster');
  const miss1 = lacks(keysOf(rv.people), keysOf(mv.people));
  const miss2 = lacks(rv.people[0].documents.passport, mv.people[0].documents.passport);
  const miss3 = lacks(rv.totals, mv.totals);
  check('roster rows, documents and totals', !miss1.length && !miss2.length && !miss3.length,
    JSON.stringify({ miss1, miss2, miss3 }));
  const rc = (await api.get('/api/compliance/drivers')).body;
  const mc = await mget('/api/compliance/drivers');
  const withHr = rc.people.filter((p) => p.hr);
  const miss4 = lacks(keysOf(rc.people), keysOf(mc.people));
  const miss5 = lacks(withHr[0]?.hr, mc.people.find((p) => p.hr)?.hr);
  const miss6 = lacks(rc.people_totals, mc.people_totals);
  check('compliance person rows, their hr block and the totals',
    withHr.length > 0 && !miss4.length && !miss5.length && !miss6.length, JSON.stringify({ miss4, miss5, miss6 }));
  const rp = (await api.get('/api/driver/profile?id=u-khalid&from=2026-08-01&to=2026-08-31')).body;
  const mp = await mget('/api/driver/profile?id=drv-0');
  const miss7 = [...lacks(rp.hr, mp.hr), ...lacks(rp.licence, mp.licence)];
  check('the driver profile’s hr and licence blocks', !miss7.length, JSON.stringify(miss7));
  const rs = (await api.get('/api/same-person')).body;
  const ms2 = await mget('/api/same-person');
  const rHr = [...rs.pending, ...rs.decided].filter((p) => p.basis === 'hr_roster');
  const mHr = [...ms2.pending, ...ms2.decided].filter((p) => p.basis === 'hr_roster');
  const miss8 = lacks(keysOf(rHr), keysOf(mHr));
  check('the same-person queue’s HR items', rHr.length > 0 && !miss8.length, JSON.stringify(miss8));
  ms.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
api.server.close();
await db.close();
process.exit(fail ? 1 : 0);
