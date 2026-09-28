/* A dependency-free WRITER for .xlsx workbooks — the other half of
   src/salary/xlsx.js.
   ─────────────────────────────────────────────────────────────────────────
   The operator asked for the money — cash, payouts, every platform — as "a
   downloadable excel file based on the range" (2026-09-28), for supervisors
   chasing cash. The reader beside this file was written dependency-free on
   the operator's ruling of 2026-09-22 (exceljs is 21.8 MB onto a basic-xxs
   build; SheetJS's last npm release carries advisories), and the writer
   follows the same ruling: an .xlsx is a ZIP of XML, and node:zlib ships the
   deflate.

   What it writes, and why each part is here:
     · plain numbers only — no formulas, on the operator's instruction ("Plain
       numbers"). A total is a number the server computed and wrote.
     · money as numbers with a #,##0.00 format, so a supervisor can sort and
       add them; never as text, which Excel will not sum.
     · dates and times as real Excel dates, in DUBAI wall-clock time, because
       Excel has no time zone and every date in this product is Dubai's. The
       caller hands over 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' strings already in
       Dubai time (formatted in SQL), so nothing here converts a zone.
     · text as inline strings. There is no shared-string table to keep in
       step, and a cell starting with "=" is text, not a formula, in this
       form — the formula-injection trap is a CSV trap, not an .xlsx one.
     · a bold header row that stays on screen while scrolling (a frozen
       pane) and carries Excel's filter arrows, so "just Egari" or "just
       Bolt" is one click in the file.

   What it refuses, by name, rather than writing something Excel will
   "repair": more rows than a sheet holds, a sheet name Excel forbids, two
   sheets with one name. A workbook Excel opens with a repair prompt reads as
   corrupt to the person holding it, whatever it contains. */
import { deflateRawSync } from 'node:zlib';

const MAX_ROWS = 1048576;
const MAX_CELL_TEXT = 32767;

/* ── the ZIP envelope ───────────────────────────────────────────────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* DOS date and time, which is what a ZIP header carries. */
function dosStamp(d) {
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

export function zip(files, when = new Date()) {
  const { time, date } = dosStamp(when);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // UTF-8 names
    local.writeUInt16LE(8, 8);             // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, packed);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);              // made by
    cen.writeUInt16LE(20, 6);              // needed
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(packed.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/* ── cells ──────────────────────────────────────────────────────────────── */
/* Characters XML 1.0 cannot carry at all. A driver name pasted from a phone
   can hold one, and one of them makes Excel refuse the whole sheet. */
// eslint-disable-next-line no-control-regex
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export const xmlText = (s) => String(s).replace(BAD_XML, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const colName = (i) => {
  let s = ''; let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
};

/* Excel's day number for a calendar day. Day 1 is 1900-01-01 and Excel also
   counts a 29 February 1900 that never happened, so every modern date is the
   Unix day count plus 25,569 — the same arithmetic the reader undoes. */
const EPOCH = Date.UTC(1899, 11, 30);
export function serialOf(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(text || ''));
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return (ms - EPOCH) / 86400000;
}

/* The style of each kind of cell — the index into cellXfs below. */
const STYLE = { text: 0, header: 1, money: 2, int: 3, date: 4, datetime: 5, wrap: 6, bold: 7, title: 8, num1: 9, moneyBold: 10, dim: 11 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="167" formatCode="#,##0.0"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="14"/><name val="Calibri"/><family val="2"/></font><font><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDEFF2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

function cellXml(ref, value, kind) {
  if (value == null || value === '') return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const s = STYLE[kind] ?? STYLE.text;
    return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${value}</v></c>`;
  }
  if ((kind === 'date' || kind === 'datetime') && typeof value === 'string') {
    const n = serialOf(value);
    if (n != null) return `<c r="${ref}" s="${STYLE[kind]}"><v>${n}</v></c>`;
  }
  let text = String(value);
  if (text.length > MAX_CELL_TEXT) text = `${text.slice(0, MAX_CELL_TEXT - 1)}…`;
  /* Text in a money or number column (a "(withheld)", say) keeps the plain
     text style: a number format on a string does nothing and misleads. */
  const s = ['header', 'wrap', 'bold', 'title', 'dim'].includes(kind) ? STYLE[kind] : 0;
  return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${xmlText(text)}</t></is></c>`;
}

/* ── a sheet ────────────────────────────────────────────────────────────── */
class Sheet {
  constructor(name, { widths = [] } = {}) {
    this.name = name;
    this.widths = widths;
    this.rows = [];          // row XML strings
    this.headerAt = null;    // 1-based row of the table header
    this.cols = null;        // kinds of the table's columns
    this.lastCol = 0;
  }
  get rowCount() { return this.rows.length; }
  push(cells) {
    if (this.rows.length >= MAX_ROWS) throw new Error(`sheet "${this.name}" is over Excel's ${MAX_ROWS.toLocaleString('en')}-row limit`);
    const r = this.rows.length + 1;
    let xml = '';
    cells.forEach(([v, kind], i) => { xml += cellXml(`${colName(i)}${r}`, v, kind); });
    this.rows.push(`<row r="${r}">${xml}</row>`);
    this.lastCol = Math.max(this.lastCol, cells.length);
    return this;
  }
  /** A line of prose, in the first column. */
  text(s, kind = 'wrap') { return this.push([[s, kind]]); }
  /** Two columns: a label in bold, then its value in the given kind. */
  pair(label, value, kind = 'wrap') { return this.push([[label, 'bold'], [value, kind]]); }
  blank() { this.rows.push(`<row r="${this.rows.length + 1}"/>`); return this; }
  /** The table header: bold, frozen, and where the filter arrows go. */
  header(labels, kinds) {
    if (this.headerAt != null) throw new Error(`sheet "${this.name}" already has a header`);
    this.push(labels.map((l) => [l, 'header']));
    this.headerAt = this.rows.length;
    this.cols = kinds;
    return this;
  }
  /** A table row, each value in its column's kind. */
  row(values, kinds = this.cols) {
    return this.push(values.map((v, i) => [v, (kinds && kinds[i]) || 'text']));
  }
  xml(first) {
    const views = this.headerAt != null
      ? `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''}><pane ySplit="${this.headerAt}" topLeftCell="A${this.headerAt + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''}/></sheetViews>`;
    const cols = this.widths.length
      ? `<cols>${this.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const filter = this.filterRef() ? `<autoFilter ref="${this.filterRef()}"/>` : '';
    /* The used range. Excel does not need it, but a reader in read-only
       mode (openpyxl's, and pandas on top of it) takes the sheet's size from
       it and reports none without it — measured on the first production
       download, 2026-09-28. */
    const dim = `<dimension ref="A1${this.rows.length > 1 || this.lastCol > 1 ? `:${colName(Math.max(this.lastCol, 1) - 1)}${Math.max(this.rows.length, 1)}` : ''}"/>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${dim}${views}<sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${this.rows.join('')}</sheetData>${filter}</worksheet>`;
  }
  filterRef() {
    if (this.headerAt == null || !this.cols) return null;
    const last = Math.max(this.rows.length, this.headerAt);
    return `A${this.headerAt}:${colName(this.cols.length - 1)}${last}`;
  }
}

/* Excel's own rules for a tab name: 31 characters, none of []:*?/\ , not
   blank, not starting or ending with an apostrophe. */
const BAD_SHEET = /[[\]:*?/\\]/;

export class Workbook {
  constructor({ creator = 'FleetMirror', created = new Date() } = {}) {
    this.sheets = [];
    this.creator = creator;
    this.created = created;
  }
  sheet(name, opts) {
    if (!name || name.length > 31 || BAD_SHEET.test(name) || /^'|'$/.test(name)) {
      throw new Error(`"${name}" is not a sheet name Excel accepts`);
    }
    if (this.sheets.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`two sheets are named "${name}"`);
    }
    const s = new Sheet(name, opts);
    this.sheets.push(s);
    return s;
  }
  toBuffer() {
    if (!this.sheets.length) throw new Error('a workbook needs at least one sheet');
    const q = (n) => `'${n.replace(/'/g, "''")}'`;
    const defined = this.sheets.map((s, i) => (s.filterRef()
      ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlText(q(s.name))}!${s.filterRef().replace(/([A-Z]+)(\d+)/g, '$$$1$$$2')}</definedName>` : '')).join('');
    const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${
      this.sheets.map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
    }</sheets>${defined ? `<definedNames>${defined}</definedNames>` : ''}</workbook>`;
    const n = this.sheets.length;
    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
      this.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    }<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
    const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${
      this.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    }<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
    const stamp = this.created.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${xmlText(this.creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
    return zip([
      ['[Content_Types].xml', types],
      ['_rels/.rels', rootRels],
      ['docProps/core.xml', core],
      ['xl/workbook.xml', workbook],
      ['xl/_rels/workbook.xml.rels', wbRels],
      ['xl/styles.xml', STYLES_XML],
      ...this.sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, s.xml(i === 0)]),
    ], this.created);
  }
}
