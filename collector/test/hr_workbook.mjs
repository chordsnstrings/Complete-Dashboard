/* A SYNTHETIC HR roster export, built byte by byte.
   ─────────────────────────────────────────────────────────────────────────
   The real export is driver PII — passports, Emirates IDs, licences — and
   none of it may enter this repository. So the HR tests build their own
   workbook here: the same sheet name, the same 44 headings in the same order
   (taken from src/hr_roster.js, the one definition), shared strings and a
   date style exactly as Excel writes them, and every value INVENTED.

   The invented document numbers are deliberately distinctive strings
   (PZ9Q…, DL55…, RT77…, 784-1990-00000…) so that a test sweeping a whole
   response body for them cannot collide with a count or a timestamp. None is
   anybody's. */
import { deflateRawSync } from 'node:zlib';
import { HR_HEADERS } from '../src/hr_roster.js';

/* ── a minimal ZIP writer (the same shape test/salary_xlsx.test.mjs uses) ── */
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
export function zip(entries) {
  const files = [];
  const chunks = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const comp = deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    files.push({ nameBuf, comp, raw, crc: crc32(raw), offset });
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenStart = offset;
  for (const f of files) {
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(f.crc, 16);
    cen.writeUInt32LE(f.comp.length, 20); cen.writeUInt32LE(f.raw.length, 24);
    cen.writeUInt16LE(f.nameBuf.length, 28);
    cen.writeUInt32LE(f.offset, 42);
    chunks.push(cen, f.nameBuf);
    offset += 46 + f.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(offset - cenStart, 12); eocd.writeUInt32LE(cenStart, 16);
  chunks.push(eocd);
  return Buffer.concat(chunks);
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const colName = (i) => {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
/* Excel's serial for a calendar day: days since 1899-12-30, which absorbs
   the 1900 leap-year bug for every date after February 1900. */
const serial = (day) => (Date.parse(`${day}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

/* A value tagged as a date is written as a serial with the date style; any
   other string goes to shared strings; a number is written as a number. */
export const D = (day) => ({ date: day });

/** Build a workbook. `sheets` is [{ name, rows: [[cell, …], …] }]. */
export function workbook(sheets) {
  const strings = [];
  const sIdx = new Map();
  const si = (s) => {
    if (!sIdx.has(s)) { sIdx.set(s, strings.length); strings.push(s); }
    return sIdx.get(s);
  };
  const parts = {};
  sheets.forEach((sh, k) => {
    const body = sh.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      const ref = `${colName(c)}${r + 1}`;
      if (v == null || v === '') return `<c r="${ref}" s="0"/>`;
      if (v && typeof v === 'object' && v.date) return `<c r="${ref}" s="1"><v>${serial(v.date)}</v></c>`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="s"><v>${si(String(v))}</v></c>`;
    }).join('')}</row>`).join('');
    parts[`xl/worksheets/sheet${k + 1}.xml`] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + `<sheetData>${body}</sheetData></worksheet>`;
  });
  return zip({
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
      + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
      + sheets.map((sh, k) => `<sheet name="${xml(sh.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')
      + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')
      + '</Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0"?><sst count="${strings.length}" uniqueCount="${strings.length}">`
      + strings.map((s) => `<si><t xml:space="preserve">${xml(s)}</t></si>`).join('') + '</sst>',
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet><cellXfs count="2">'
      + '<xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>',
    ...parts,
  });
}

const pad = (n, w) => String(n).padStart(w, '0');
const hex = (n, w) => Number(n).toString(16).padStart(w, '0');
export const COMPANY = { ecosine: 'Ecosine Test Company LLC', egari: 'Egari Test Transport LLC' };

/* The invented numbers for employee `i`, exported so a test can sweep a body
   for exactly these strings. */
export const numbers = (i) => ({
  passport: `PZ9Q${pad(i, 5)}`,
  eid: `784-1990-${pad(i, 7)}-1`,
  eid_digits: `7841990${pad(i, 7)}1`,
  licence: `DL55${pad(i, 5)}`,
  rta: `RT77${pad(i, 5)}`,
});
/* Platform ids in the providers' own shapes — invented. */
export const ids = (i) => ({
  uber: `a0a0a0a0-0000-4000-8000-${pad(i, 12)}`,
  bolt: `b0b0b0b0-0000-4000-8000-${pad(i, 12)}`,
  yango: `c0c0${hex(i, 28)}`,
  yay: `d0d0${hex(i, 20)}`,
});

/* One employee as the export writes them, keyed by heading. Everything is
   invented; `over` replaces any heading. */
export function person(i, over = {}) {
  const n = numbers(i);
  const id = ids(i);
  const fleet = over.fleet || 'ecosine';
  const base = {
    'Employee ID': `T${pad(i, 3)}`,
    'Company Name': COMPANY[fleet],
    'Full Name': `Testperson ${i} Example`,
    'First Name': `Testperson${i}`,
    'Last Name': 'Example',
    Phone: `+97150990${pad(i, 4)}`,
    Email: `t${i}@example.invalid`,
    Gender: 'X',
    Nationality: 'Testland',
    'Date of Birth': D('1990-01-01'),
    'Marital Status': null,
    'Compliance Status': 'Compliant',
    Active: 'Yes',
    'Vehicle Assigned': 'No',
    'Current Address': 'Test Street 1',
    'Emergency Contact Name': null,
    'Emergency Contact Phone': null,
    'Passport Number': n.passport,
    'Passport Expiry': D('2030-01-01'),
    'Emirates ID Number': n.eid,
    'Emirates ID Expiry': D('2028-01-01'),
    'Visa Number': n.eid,
    'Visa Expiry': D('2028-01-01'),
    'UAE Driving License Number': n.licence,
    'Driving License Expiry': D('2029-01-01'),
    'RTA Permit Card Number': n.rta,
    'RTA Permit Expiry': D('2027-06-01'),
    'Uber User ID': id.uber,
    'Careem User ID': null,
    'Bolt User ID': null,
    'Yango Contractor ID': null,
    'YAY User ID': null,
    'Contract Start': null,
    'Contract End': null,
    'Bank Name': null,
    IBAN: null,
    'Joining Date': null,
    'Hired At': D('2025-01-01'),
    'Punctuality Score': null,
    'Safety Score': null,
    'Violations Count': '0',
    'Complaints Count': '0',
    'Last Test Result': null,
    Notes: null,
  };
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) if (k !== 'fleet') out[k] = v;
  return out;
}

/** The export: sheet "Drivers", the 44 headings, one row per person. */
export function hrExport(people, { headers = HR_HEADERS, sheetName = 'Drivers', extraSheets = [] } = {}) {
  const rows = [headers.slice(), ...people.map((p) => headers.map((h) => (h in p ? p[h] : null)))];
  return workbook([{ name: sheetName, rows }, ...extraSheets.map((name) => ({ name, rows: [['x']] }))]);
}
