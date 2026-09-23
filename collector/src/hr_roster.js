/* THE OPERATOR'S HR ROSTER EXPORT — read, checked against its own shape, and
   reduced to the twenty columns this product keeps.
   ═════════════════════════════════════════════════════════════════════════
   Pure: no database, no network. api/hr_roster.js does the matching and the
   writing; mockapi.mjs uses this file too, so the page's import panel is
   refused for the same reasons in the mock as on production.

   ── ONE EXPORT, AND ONLY THAT EXPORT ─────────────────────────────────────
   The operator's decision (2026-09-23): accept a workbook whose sheet
   "Drivers" carries exactly the 44 headings below in exactly this order, and
   refuse anything else with a sentence naming what differs. Not a "flexible"
   importer that finds columns by fuzzy heading: a column that moved is a
   column whose values land under the wrong document, and on a file whose
   subject is passports and licences that is the one mistake that must not be
   made quietly. A NEWER export of the same format is the normal case and is
   accepted — the format is the contract, the date is not.

   ── WHAT IS KEPT ─────────────────────────────────────────────────────────
   Twenty columns: the nineteen in STORED, and Company Name, which is kept as
   the fleet it names (fleetOf). The other 24 are read so the shape can be
   checked and are then dropped here, before anything reaches a query:
   gender, nationality, date of birth, marital status, address, emergency
   contact, first and last name, bank, IBAN, notes, the four defaults HR
   fills for everybody (Active "Yes", Vehicle Assigned "No", violations 0,
   complaints 0), contract dates, joining date, Hired At, the two scores, the
   last test result — and the Visa Number, which on the first export is the
   Emirates ID typed a second time. Not stored, not compared, not mentioned:
   the operator's instruction. Visa EXPIRY is kept like every other expiry.

   ── THE READER ───────────────────────────────────────────────────────────
   src/salary/xlsx.js, the house reader. Its differential check against
   openpyxl was re-run on the 2026-09-23 export before this was written: 4,243
   non-empty cells, 0 differing (docs/COVERAGE.md). */
import { readWorkbook } from './salary/xlsx.js';

export const HR_SHEET = 'Drivers';

/* The export, heading for heading, in order. The whole format gate is a
   comparison against this list. */
export const HR_HEADERS = Object.freeze([
  'Employee ID', 'Company Name', 'Full Name', 'First Name', 'Last Name', 'Phone', 'Email',
  'Gender', 'Nationality', 'Date of Birth', 'Marital Status', 'Compliance Status', 'Active',
  'Vehicle Assigned', 'Current Address', 'Emergency Contact Name', 'Emergency Contact Phone',
  'Passport Number', 'Passport Expiry', 'Emirates ID Number', 'Emirates ID Expiry',
  'Visa Number', 'Visa Expiry', 'UAE Driving License Number', 'Driving License Expiry',
  'RTA Permit Card Number', 'RTA Permit Expiry', 'Uber User ID', 'Careem User ID',
  'Bolt User ID', 'Yango Contractor ID', 'YAY User ID', 'Contract Start', 'Contract End',
  'Bank Name', 'IBAN', 'Joining Date', 'Hired At', 'Punctuality Score', 'Safety Score',
  'Violations Count', 'Complaints Count', 'Last Test Result', 'Notes',
]);

/* heading -> [column, kind]. Everything not named here is never stored.
   `docno` is a document number: kept, and returned by no route except the
   two api/redact.js names for /api/driver/profile. */
export const STORED = Object.freeze({
  'Employee ID': ['employee_id', 'key'],
  'Full Name': ['full_name', 'text'],
  Phone: ['phone', 'text'],
  Email: ['email', 'text'],
  'Compliance Status': ['hr_compliance_status', 'text'],
  'Passport Number': ['passport_no', 'docno'],
  'Passport Expiry': ['passport_expires', 'date'],
  'Emirates ID Number': ['emirates_id', 'eid'],
  'Emirates ID Expiry': ['emirates_id_expires', 'date'],
  'Visa Expiry': ['visa_expires', 'date'],
  'UAE Driving License Number': ['licence_no', 'docno'],
  'Driving License Expiry': ['licence_expires', 'date'],
  'RTA Permit Card Number': ['rta_permit_no', 'docno'],
  'RTA Permit Expiry': ['rta_permit_expires', 'date'],
  'Uber User ID': ['uber_id', 'pid'],
  'Careem User ID': ['careem_id', 'pid'],
  'Bolt User ID': ['bolt_id', 'pid'],
  'Yango Contractor ID': ['yango_id', 'pid'],
  'YAY User ID': ['yay_id', 'pid'],
});

/* Which platform each id column belongs to. `yay` is a real channel here —
   a handful of drivers carry a YAY user id — and nothing collects it. It is
   NOT added to the statement import's platform list in api/server.js, which
   rightly refuses `yay` there as a misspelling of a revenue source; this file
   stores the id and says it cannot be matched. */
export const PLATFORM_COLUMNS = Object.freeze({
  uber_id: 'uber', careem_id: 'careem', bolt_id: 'bolt', yango_id: 'yango', yay_id: 'yay',
});

/* The five documents, in the order the page shows them. `number` is null for
   the visa: its number is not kept, by instruction. */
export const DOCS = Object.freeze([
  { key: 'passport', label: 'Passport', number: 'passport_no', expires: 'passport_expires',
    heading: 'Passport Expiry' },
  { key: 'emirates_id', label: 'Emirates ID', number: 'emirates_id',
    expires: 'emirates_id_expires', heading: 'Emirates ID Expiry' },
  { key: 'licence', label: 'Driving licence', number: 'licence_no', expires: 'licence_expires',
    heading: 'Driving License Expiry' },
  { key: 'visa', label: 'Visa', number: null, expires: 'visa_expires', heading: 'Visa Expiry' },
  { key: 'rta_permit', label: 'RTA permit', number: 'rta_permit_no',
    expires: 'rta_permit_expires', heading: 'RTA Permit Expiry' },
]);

/* The columns a later upload is compared against an earlier one on, for the
   "went blank" report. Every stored column except the key. */
export const COMPARED = Object.freeze(Object.entries(STORED)
  .filter(([, [, kind]]) => kind !== 'key').map(([heading, [col]]) => ({ heading, col })));

/* Company Name -> fleet. Two values on the first export, one naming each
   fleet, and 0 disagreements with the fleet the database files the same
   accounts under. A name matching neither — or both — is refused by row. */
export function fleetOf(company) {
  const s = String(company ?? '');
  const eco = /ecosine/i.test(s);
  const ega = /egari/i.test(s);
  if (eco === ega) return null;
  return eco ? 'ecosine' : 'egari';
}

const isBlank = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const pad2 = (n) => String(n).padStart(2, '0');

/* A day, from a cell. The reader returns a Date built in UTC for a
   date-formatted cell, so the UTC components ARE the calendar day. An ISO
   string is accepted too; anything else is not a date and is refused by row
   rather than guessed at — "12/03/2027" is December in one locale and March
   in the other, on a column that decides whether someone may drive. */
export function dayOf(v) {
  if (isBlank(v)) return { ok: true, day: null };
  if (v instanceof Date && Number.isFinite(v.getTime())) {
    return { ok: true, day: `${v.getUTCFullYear()}-${pad2(v.getUTCMonth() + 1)}-${pad2(v.getUTCDate())}` };
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v).trim());
  if (m) {
    const d = new Date(`${m[0]}T00:00:00Z`);
    if (Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === m[0]) return { ok: true, day: m[0] };
  }
  return { ok: false, day: null };
}

/* Text, from a cell. A number is written back as the integer it is — a
   licence number typed as 1234567 must not become "1234567.0" or 1.23e6. */
export function textOf(v) {
  if (isBlank(v)) return null;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return dayOf(v).day;
  if (typeof v === 'object') return null;
  return String(v).trim();
}

/* An Emirates ID, as digits. Written "784-1990-1234567-1", "784 1990
   1234567 1" or 784199012345671 it is one number, and the stored form is the
   fifteen digits. A value that is not fifteen digits is kept as the digits HR
   typed — not corrected, not dropped — and counted, so the preview can say so
   without printing it. */
export function eidOf(v) {
  const t = textOf(v);
  if (!t) return { value: null, fifteen: true };
  const d = t.replace(/\D/g, '');
  if (!d) return { value: null, fifteen: false };
  return { value: d, fifteen: d.length === 15 && d.startsWith('784') };
}

/* A platform id. UUIDs and Yango's hex ids compare case-insensitively and
   the providers write them lower-case, so they are stored that way. */
export const pidOf = (v) => {
  const t = textOf(v);
  if (!t) return null;
  return /^[0-9a-f-]+$/i.test(t) ? t.toLowerCase() : t;
};

/* The export date, when the filename says it. The operator's uploads arrive
   with a prefix ("bd061d4f-active-drivers-2026-09-23.xlsx"), so this finds
   the stamp anywhere in the name rather than only at the start. */
export function exportDateFromName(name) {
  const m = /active-drivers-(\d{4}-\d{2}-\d{2})\.xlsx$/i.exec(String(name || ''));
  if (!m) return null;
  const r = dayOf(m[1]);
  return r.ok ? r.day : null;
}

const quote = (s) => `“${s}”`;
const list = (a, n = 6) => (a.length <= n ? a.join(', ')
  : `${a.slice(0, n).join(', ')} and ${a.length - n} more`);

/* ── THE FORMAT GATE ──────────────────────────────────────────────────────
   Returns the refusals, each a sentence naming what differs. Empty means
   this is the export.

   A heading that is missing AND a heading that is not in the export, sitting
   at the same position, is one fact — a RENAME — and is said as one, because
   "column “Visa Expiry” is missing" and "column 23 is not part of the export"
   leave the reader to work out that those are the same column. */
export function formatRefusals(wb) {
  const out = [];
  const names = wb.sheets.map((s) => s.name);
  const sheet = wb.sheets.find((s) => s.name.trim() === HR_SHEET);
  if (!sheet) {
    const near = wb.sheets.find((s) => s.name.trim().toLowerCase() === HR_SHEET.toLowerCase());
    out.push(near
      ? `the sheet is called ${quote(near.name)}; the export calls it ${quote(HR_SHEET)}`
      : `the workbook has no sheet called ${quote(HR_SHEET)} — it has `
        + `${names.length ? names.map(quote).join(', ') : 'no sheets at all'}`);
    return out;
  }
  const others = names.filter((n) => n !== sheet.name);
  if (others.length) {
    out.push(`the export is one sheet, ${quote(HR_SHEET)}; this workbook also has `
      + `${others.map(quote).join(', ')}`);
  }
  const rows = sheet.rows;
  if (!rows.length) { out.push(`the ${quote(HR_SHEET)} sheet is empty`); return out; }

  const raw = (rows[0] || []).map((v) => (v == null ? '' : String(v).trim()));
  while (raw.length && raw[raw.length - 1] === '') raw.pop();
  /* A column with values under no heading is an extra column too, and the
     commonest way one arrives: somebody typed a note beside the table. */
  let width = raw.length;
  for (const r of rows.slice(1)) {
    for (let c = r.length - 1; c >= width; c -= 1) {
      if (!isBlank(r[c])) { width = Math.max(width, c + 1); break; }
    }
  }
  const got = Array.from({ length: width }, (_, i) => raw[i] ?? '');

  const seen = new Map();
  got.forEach((h, i) => { if (h) seen.set(h, [...(seen.get(h) || []), i + 1]); });
  let dup = false;
  for (const [h, at] of seen) {
    if (at.length > 1) {
      dup = true;
      out.push(`column ${quote(h)} appears ${at.length} times (columns ${at.join(', ')})`);
    }
  }
  const want = new Set(HR_HEADERS);
  const missing = HR_HEADERS.filter((h) => !seen.has(h));
  const extra = got.map((h, i) => ({ h, i })).filter(({ h }) => !want.has(h));
  const renamedAt = new Set();
  for (const m of missing) {
    const i = HR_HEADERS.indexOf(m);
    const x = extra.find((e) => e.i === i);
    if (x && !renamedAt.has(i)) {
      renamedAt.add(i);
      out.push(x.h
        ? `column ${i + 1} is headed ${quote(x.h)} where the export has ${quote(m)} — renamed`
        : `column ${i + 1} has no heading where the export has ${quote(m)}`);
    }
  }
  for (const m of missing) {
    const i = HR_HEADERS.indexOf(m);
    if (!renamedAt.has(i)) out.push(`column ${quote(m)} is missing (it is column ${i + 1} of the export)`);
  }
  for (const x of extra) {
    if (renamedAt.has(x.i)) continue;
    out.push(x.h
      ? `column ${x.i + 1}, ${quote(x.h)}, is not part of the export`
      : `column ${x.i + 1} carries values but has no heading, and the export has no such column`);
  }
  /* Everything present, nothing extra, and still not the export: the order.
     Named column by column, because "reordered" alone sends somebody to
     compare 44 headings by eye. */
  if (!missing.length && !extra.length && !dup) {
    const moved = HR_HEADERS.map((h, i) => ({ h, want: i + 1, at: got.indexOf(h) + 1 }))
      .filter((x) => x.at !== x.want);
    if (moved.length) {
      out.push(`the columns are in a different order: ${list(moved.map((x) =>
        `${quote(x.h)} is column ${x.at} here and column ${x.want} in the export`), 4)}`);
    }
  }
  return out;
}

/* ── THE ROWS ─────────────────────────────────────────────────────────────
   Only called once the format gate has passed, so every index below is the
   export's. A row with nothing in it is skipped; a row with a problem is
   REFUSED BY NUMBER, and one refused row refuses the upload — a snapshot
   that silently lost row 17 would report somebody "off the HR list" who is
   still on it. Problems name the row, the employee and the heading, never a
   cell's contents: the preview answers a browser, and a document number has
   no business in a refusal. */
export function readRows(sheet) {
  const idx = Object.fromEntries(HR_HEADERS.map((h, i) => [h, i]));
  const problems = [];
  const rows = [];
  const notes = { eid_not_15_digits: 0 };
  const keys = new Map();
  sheet.rows.slice(1).forEach((r, k) => {
    const n = k + 2;                               // the spreadsheet's own row number
    if (!r.some((v) => !isBlank(v))) return;
    const cell = (h) => r[idx[h]];
    const errorIn = HR_HEADERS.filter((h) => r[idx[h]] && typeof r[idx[h]] === 'object'
      && !(r[idx[h]] instanceof Date) && 'error' in r[idx[h]]);
    const emp = textOf(cell('Employee ID'));
    const who = emp ? `row ${n} (employee ${emp})` : `row ${n}`;
    if (errorIn.length) {
      problems.push(`${who}: ${list(errorIn.map(quote))} ${errorIn.length === 1 ? 'holds' : 'hold'} `
        + 'a spreadsheet error rather than a value');
    }
    if (!emp) { problems.push(`row ${n} has no Employee ID`); return; }
    const fleet = fleetOf(cell('Company Name'));
    if (!fleet) problems.push(`${who}: Company Name names neither Ecosine nor Egari`);
    const out = { row: n, fleet_id: fleet };
    for (const [heading, [col, kind]] of Object.entries(STORED)) {
      const v = cell(heading);
      if (kind === 'date') {
        const d = dayOf(v);
        if (!d.ok) problems.push(`${who}: ${heading} is not a date`);
        out[col] = d.day;
      } else if (kind === 'eid') {
        const e = eidOf(v);
        if (e.value && !e.fifteen) notes.eid_not_15_digits += 1;
        out[col] = e.value;
      } else if (kind === 'pid') {
        out[col] = pidOf(v);
      } else {
        out[col] = textOf(v);
      }
    }
    if (fleet) {
      const key = `${fleet}\u0000${emp}`;
      if (keys.has(key)) {
        problems.push(`employee ${emp} appears twice in the ${fleet === 'ecosine' ? 'Ecosine' : 'Egari'} `
          + `rows (rows ${keys.get(key)} and ${n}); the key is the fleet and the Employee ID together`);
      } else keys.set(key, n);
    }
    rows.push(out);
  });
  if (!rows.length && !problems.length) problems.push(`the ${quote(HR_SHEET)} sheet has headings and no driver rows`);
  return { rows, problems, notes };
}

/* The whole of reading one upload: bytes in, rows or refusals out. Never
   throws — an unreadable file is a refusal with the reader's own sentence. */
export function readRoster(bytes) {
  let wb;
  try { wb = readWorkbook(bytes); } catch (e) {
    return { ok: false, refusals: [`this is not an .xlsx workbook the reader can open: ${String(e?.message || e)}`],
      rows: [], notes: {} };
  }
  const refusals = formatRefusals(wb);
  if (refusals.length) return { ok: false, refusals, rows: [], notes: {} };
  const sheet = wb.sheets.find((s) => s.name.trim() === HR_SHEET);
  const { rows, problems, notes } = readRows(sheet);
  return { ok: problems.length === 0, refusals: problems, rows, notes };
}

/* ── EXPIRY STATUS, one definition for the preview, the page and the API ──
   Six states. `missing` is not "ok" and not "expired": HR filed no date, and
   the page says so rather than implying either. */
export const STATUS_ORDER = ['expired', 'd30', 'd45', 'd90', 'ok', 'missing'];
export const STATUS_LABEL = { expired: 'expired', d30: '≤30 days', d45: '≤45 days',
  d90: '≤90 days', ok: 'ok', missing: 'missing' };

export function daysBetween(today, day) {
  if (!today || !day) return null;
  const a = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

export function docStatus(expires, today) {
  const d = daysBetween(today, expires);
  if (d == null) return { status: 'missing', days_left: null };
  const status = d < 0 ? 'expired' : d <= 30 ? 'd30' : d <= 45 ? 'd45' : d <= 90 ? 'd90' : 'ok';
  return { status, days_left: d };
}

/* The preview's expiry summary: per document, how many rows fall in each
   state. Counts only. */
export function expirySummary(rows, today) {
  const out = {};
  for (const doc of DOCS) {
    const b = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
    for (const r of rows) b[docStatus(r[doc.expires], today).status] += 1;
    out[doc.key] = b;
  }
  return out;
}
