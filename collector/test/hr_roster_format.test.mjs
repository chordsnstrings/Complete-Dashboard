/* THE HR ROSTER'S FORMAT GATE — this export, and only this export.
   ─────────────────────────────────────────────────────────────────────────
   The operator's decision (2026-09-23): a workbook whose sheet "Drivers" has
   exactly the 44 headings in exactly the export's order is accepted, and
   anything else is refused with a sentence naming what differs. A column that
   moved is a column whose values land under the wrong document, so "close
   enough" is the failure this gate exists to prevent.

   Every workbook here is SYNTHETIC (test/hr_workbook.mjs): the real export is
   driver PII and none of it enters the repository. */
import { readRoster, formatRefusals, HR_HEADERS, STORED, exportDateFromName, eidOf,
  docStatus, expirySummary, fleetOf } from '../src/hr_roster.js';
import { readWorkbook } from '../src/salary/xlsx.js';
import { hrExport, person, numbers, D } from './hr_workbook.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const people = [person(1), person(2, { fleet: 'egari', 'Employee ID': 'T001' }), person(3)];

console.log('\nthe export itself is accepted');
{
  const r = readRoster(hrExport(people));
  check('the right file reads with no refusal', r.ok && r.refusals.length === 0, JSON.stringify(r.refusals));
  check('…every row, keyed by fleet and employee id', r.rows.length === 3
    && r.rows.filter((x) => x.fleet_id === 'ecosine').length === 2
    && r.rows.filter((x) => x.fleet_id === 'egari').length === 1, JSON.stringify(r.rows.map((x) => x.fleet_id)));
  /* The same D-number in both fleets is two people, not a duplicate: HR
     issues employee numbers per company. */
  check('the same Employee ID in the two fleets is two rows, not a duplicate',
    r.rows.filter((x) => x.employee_id === 'T001').length === 2, JSON.stringify(r.rows.map((x) => x.employee_id)));
  check('the headings list is the export’s 44', HR_HEADERS.length === 44 && HR_HEADERS[0] === 'Employee ID'
    && HR_HEADERS[43] === 'Notes');
  /* A newer export of the same format is the normal case. */
  const newer = readRoster(hrExport([person(1), person(4)]));
  check('a newer export of the same format is accepted too', newer.ok && newer.rows.length === 2);
}

console.log('\nwhat is kept, and what is dropped at the door');
{
  const [r] = readRoster(hrExport([person(7, { 'Visa Number': 'VZ-DISTINCT-0007' })])).rows;
  const kept = Object.values(STORED).map(([c]) => c);
  check('twenty columns are kept: nineteen as themselves and Company Name as the fleet',
    kept.length === 19 && r.fleet_id === 'ecosine', String(kept.length));
  for (const gone of ['gender', 'nationality', 'date_of_birth', 'iban', 'bank_name', 'hired_at',
    'visa_no', 'visa_number', 'current_address', 'notes', 'active', 'vehicle_assigned']) {
    check(`${gone} never reaches a row`, !(gone in r));
  }
  check('the visa NUMBER is not kept anywhere on the row — only its expiry',
    !JSON.stringify(r).includes('VZ-DISTINCT-0007'), JSON.stringify(Object.keys(r)));
  check('…and the visa expiry is', r.visa_expires === '2028-01-01', String(r.visa_expires));
  check('a date cell becomes the calendar day', r.passport_expires === '2030-01-01'
    && r.licence_expires === '2029-01-01', JSON.stringify([r.passport_expires, r.licence_expires]));
}

console.log('\nthe Emirates ID is one number however it is written');
{
  const d = numbers(9).eid_digits;
  check('dashes are formatting', eidOf('784-1990-0000009-1').value === d);
  check('spaces are formatting', eidOf('784 1990 0000009 1').value === d);
  check('a bare number is the same number', eidOf(Number(d)).value === d);
  check('fifteen digits starting 784 is a well-formed one', eidOf(d).fifteen === true);
  check('anything else is kept as typed and flagged, not corrected', eidOf('784-1990-12345').fifteen === false
    && eidOf('784-1990-12345').value === '784199012345');
}

console.log('\nwhere the export date comes from');
check('the filename HR writes', exportDateFromName('active-drivers-2026-09-23.xlsx') === '2026-09-23');
check('…with the prefix an upload gains', exportDateFromName('bd061d4f-active-drivers-2026-09-23.xlsx') === '2026-09-23');
check('a name without it gives no date, rather than a guess', exportDateFromName('drivers.xlsx') === null);
check('a date that is not a date is not one', exportDateFromName('active-drivers-2026-13-40.xlsx') === null);

console.log('\nthe refusals — each names what differs');
const refuse = (label, buf, pattern) => {
  const r = readRoster(buf);
  const text = r.refusals.join(' | ');
  check(`${label}: refused`, !r.ok && r.refusals.length > 0, text);
  check(`${label}: and the reason says which`, pattern.test(text), text);
};
refuse('a wrong sheet name', hrExport(people, { sheetName: 'Sheet1' }),
  /no sheet called “Drivers” — it has “Sheet1”/);
refuse('a sheet named in the wrong case', hrExport(people, { sheetName: 'drivers' }),
  /the sheet is called “drivers”; the export calls it “Drivers”/);
refuse('a second sheet', hrExport(people, { extraSheets: ['Notes'] }),
  /also has “Notes”/);
{
  const h = HR_HEADERS.filter((x) => x !== 'Visa Expiry');
  refuse('a missing column', hrExport(people, { headers: h }), /column “Visa Expiry” is missing \(it is column 23 of the export\)/);
}
{
  const h = HR_HEADERS.map((x) => (x === 'Visa Expiry' ? 'Visa Expiration' : x));
  refuse('a renamed column', hrExport(people, { headers: h }),
    /column 23 is headed “Visa Expiration” where the export has “Visa Expiry” — renamed/);
}
{
  const h = [...HR_HEADERS, 'Remarks'];
  refuse('an extra column', hrExport(people, { headers: h }), /column 45, “Remarks”, is not part of the export/);
}
{
  const h = HR_HEADERS.slice();
  [h[5], h[6]] = [h[6], h[5]];            // Phone and Email swapped
  refuse('a reordered column', hrExport(people, { headers: h }),
    /different order: “Phone” is column 7 here and column 6 in the export/);
}
{
  const h = HR_HEADERS.slice();
  h[10] = 'Phone';
  const r = readRoster(hrExport(people, { headers: h }));
  check('a duplicated heading is named with both positions',
    /column “Phone” appears 2 times \(columns 6, 11\)/.test(r.refusals.join(' ')), r.refusals.join(' | '));
}
{
  /* Values under no heading are a column too — somebody's note beside the
     table. */
  const rows = [person(1)];
  const buf = hrExport(rows);
  const wb = readWorkbook(buf);
  wb.sheets[0].rows[1][46] = 'stray';
  check('values in a column with no heading are refused',
    /column 47 carries values but has no heading/.test(formatRefusals(wb).join(' ')), formatRefusals(wb).join(' | '));
}
refuse('a file that is not a workbook', Buffer.from('Employee ID,Company Name\nT1,Ecosine'),
  /not an \.xlsx workbook/);

console.log('\nrows that cannot be read are refused by number, never by their contents');
{
  const r = readRoster(hrExport([person(1), person(2, { 'Passport Expiry': 'N/A' })]));
  const t = r.refusals.join(' ');
  check('text in a date column refuses the upload', !r.ok && /row 3 \(employee T002\): Passport Expiry is not a date/.test(t), t);
  check('…and the refusal does not repeat the cell', !/N\/A/.test(t), t);
}
{
  const r = readRoster(hrExport([person(1), person(2, { 'Employee ID': 'T001' })]));
  check('the same employee twice in one fleet is refused',
    /employee T001 appears twice in the Ecosine rows \(rows 2 and 3\)/.test(r.refusals.join(' ')), r.refusals.join(' | '));
}
{
  const r = readRoster(hrExport([person(1, { 'Company Name': 'Somebody Else LLC' })]));
  check('a company that names neither fleet is refused', /names neither Ecosine nor Egari/.test(r.refusals.join(' ')));
  check('fleetOf reads the two company names', fleetOf('Ecosine Test Company LLC') === 'ecosine'
    && fleetOf('Egari Test Transport LLC') === 'egari' && fleetOf('Ecosine and Egari') === null);
}
{
  const r = readRoster(hrExport([person(1, { 'Employee ID': null })]));
  check('a row with no Employee ID is refused', /row 2 has no Employee ID/.test(r.refusals.join(' ')));
}
{
  const r = readRoster(hrExport([]));
  check('headings and no rows is refused', /has headings and no driver rows/.test(r.refusals.join(' ')));
}

console.log('\nexpiry status, one definition');
{
  const today = '2026-09-23';
  const s = (d) => docStatus(d, today).status;
  check('yesterday is expired', s('2026-09-22') === 'expired');
  check('today is not', s('2026-09-23') === 'd30');
  check('30 days out is ≤30', s('2026-10-23') === 'd30');
  check('31 days out is ≤45', s('2026-10-24') === 'd45');
  check('46 days out is ≤90', s('2026-11-08') === 'd90');
  check('91 days out is ok', s('2026-12-23') === 'ok');
  check('no date is missing, not ok', s(null) === 'missing' && docStatus(null, today).days_left === null);
  const sum = expirySummary([{ visa_expires: null, passport_expires: '2026-09-01' }], today);
  check('the summary counts per document', sum.visa.missing === 1 && sum.passport.expired === 1,
    JSON.stringify(sum));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
