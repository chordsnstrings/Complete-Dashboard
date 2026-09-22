/* The dependency-free .xlsx reader, against workbooks this file builds.
   ─────────────────────────────────────────────────────────────────────────
   src/salary/xlsx.js exists because the salary corpus is Excel and nothing in
   package.json could open one. It is hand-rolled on node:zlib, which means
   every trap an Excel library would have absorbed is now this building's
   problem, and each of them produces a WRONG NUMBER rather than an error.
   That is what this file is for.

   THE FIXTURES ARE SYNTHESISED HERE, NOT CHECKED IN. The real corpus is
   driver payroll — names, Emirates IDs, wages — and none of it may enter the
   repository. So this writes its own .xlsx files byte by byte, which has the
   side benefit of making each trap explicit: the sheet that exercises the
   self-closing-cell bug literally contains `<c r="B1" s="0"/>`.

   THE READER WAS ALSO PROVED AGAINST THE REAL CORPUS, differentially: every
   workbook in it was read with both this reader and openpyxl and every cell
   diffed. That run is what FOUND two of the defects asserted below — the
   self-closing-cell bug and the dropped times — so no assertion here was
   written from imagination. The differential needs Python and the corpus, so
   neither it nor its result can live in this suite; the measurement is
   recorded in collector/docs/COVERAGE.md, and bin/salary-verify.mjs re-runs
   THIS reader over a corpus directory and names every file it cannot open. */
import { deflateRawSync } from 'node:zlib';
import { readWorkbook, sharedStrings, dateStyles, serialToDate, serialTime, A1, decodeXml }
  from '../src/salary/xlsx.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── a minimal ZIP writer, so the fixtures are real archives ───────────── */
function zip(entries) {
  const files = [];
  const chunks = [];
  let offset = 0;
  const crcTable = (() => {
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
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
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

const RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId9" Type="x" Target="worksheets/sheet7.xml"/>'
  + '<Relationship Id="rId1" Type="x" Target="worksheets/sheet2.xml"/></Relationships>';

const book = ({ sheets, strings = [], styles = '', parts = {} }) => zip({
  'xl/workbook.xml': `<?xml version="1.0"?><workbook><sheets>${sheets}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': RELS,
  'xl/sharedStrings.xml': `<?xml version="1.0"?><sst count="${strings.length}" uniqueCount="${strings.length}">`
    + strings.join('') + '</sst>',
  'xl/styles.xml': styles || '<?xml version="1.0"?><styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>',
  ...parts,
});

const sheetXml = (cells) => `<?xml version="1.0"?><worksheet><sheetData>${cells}</sheetData></worksheet>`;

/* ══ 1. the ZIP envelope ═══════════════════════════════════════════════ */
console.log('\nthe archive, before any spreadsheet is involved');
check('a buffer that is not a zip is refused by name, not read as empty',
  (() => { try { readWorkbook(Buffer.from('plain text, not a zip')); return false; }
    catch (e) { return /not a zip archive/.test(e.message); } })());
check('a zip that is not a workbook says so rather than returning no sheets',
  (() => { try { readWorkbook(zip({ 'hello.txt': 'hi' })); return false; }
    catch (e) { return /not an \.xlsx workbook/.test(e.message); } })());

/* ══ 2. THE TRAP THAT COST AN AFTERNOON ════════════════════════════════
   A self-closing cell with a greedy attribute run swallows the next cell.
   This is the whole defect, reduced: B1 is blank and self-closing, C1 holds
   the value, and a greedy reader returns C1 as absent. */
console.log('\na blank cell does not eat the cell after it');
{
  const wb = readWorkbook(book({
    sheets: '<sheet name="S" sheetId="1" r:id="rId1"/>',
    strings: ['<si><t>Sl</t></si>', '<si><t>after the blank</t></si>'],
    parts: { 'xl/worksheets/sheet2.xml': sheetXml(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="0"/><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" s="0"/><c r="B2" s="0"/><c r="C2"><v>42</v></c></row>') },
  }));
  const r = wb.sheets[0].rows;
  check('the cell before the blank survives', r[0][0] === 'Sl', JSON.stringify(r[0][0]));
  check('the blank reads as absent', r[0][1] === null, JSON.stringify(r[0][1]));
  check('THE CELL AFTER THE BLANK SURVIVES — greedy attributes drop it',
    r[0][2] === 'after the blank', JSON.stringify(r[0][2]));
  check('…and it survives after a run of two blanks', r[1][2] === 42, JSON.stringify(r[1][2]));
}

/* ══ 3. sparse rows and columns ════════════════════════════════════════ */
console.log('\na column is read from its own reference, never from its position');
{
  const wb = readWorkbook(book({
    sheets: '<sheet name="S" sheetId="1" r:id="rId1"/>',
    parts: { 'xl/worksheets/sheet2.xml': sheetXml(
      '<row r="1"><c r="A1"><v>1</v></c><c r="Q1"><v>17</v></c></row>'
      + '<row r="3"><c r="C3"><v>3</v></c></row>') },
  }));
  const r = wb.sheets[0].rows;
  check('a gap from A to Q lands Q at index 16, not index 1',
    r[0][16] === 17 && r[0][1] === null, JSON.stringify(r[0].slice(0, 3)));
  check('a skipped ROW is present and empty, so row 3 is still index 2',
    r[1].every((c) => c === null) && r[2][2] === 3, JSON.stringify(r[2]));
  check('every row is padded to the widest, so indexing never throws',
    new Set(r.map((x) => x.length)).size === 1, r.map((x) => x.length).join(','));
}

/* ══ 4. shared strings, including rich-text runs ═══════════════════════ */
console.log('\na name split across runs is still the whole name');
{
  const ss = sharedStrings('<sst><si><t>Sl</t></si><si><r><t>Sana</t></r><r><t>ullah</t></r></si>'
    + '<si><t xml:space="preserve">DOJ </t></si><si/><si><t/></si></sst>');
  check('runs are joined, not truncated at the first', ss[1] === 'Sanaullah', JSON.stringify(ss[1]));
  check('xml:space="preserve" keeps the trailing space', ss[2] === 'DOJ ', JSON.stringify(ss[2]));
  check('a self-closing <si/> is an empty string and does not shift the index',
    ss.length === 5 && ss[3] === '' && ss[4] === '', JSON.stringify(ss));
  check('an index past the table reads as absent rather than as a number',
    readWorkbook(book({
      sheets: '<sheet name="S" sheetId="1" r:id="rId1"/>',
      strings: ['<si><t>only</t></si>'],
      parts: { 'xl/worksheets/sheet2.xml': sheetXml('<row r="1"><c r="A1" t="s"><v>99</v></c></row>') },
    })).sheets[0].rows[0][0] === null);
  check('entities are decoded', decodeXml('a &amp; b &lt;c&gt; &#65;') === 'a & b <c> A');
  check('Excel’s literal CR LF inside a string becomes a plain newline',
    decodeXml('Net Payable \r\n( E )') === 'Net Payable \n( E )',
    JSON.stringify(decodeXml('Net Payable \r\n( E )')));
}

/* ══ 5. dates, times and the 1900 leap year ════════════════════════════ */
console.log('\na date is a number and only the style says so');
{
  check('serial 45535 is 2024-08-31', serialToDate(45535).toISOString().slice(0, 10) === '2024-08-31',
    String(serialToDate(45535)));
  check('serial 1 is 1900-01-01 — below the leap-year bug',
    serialToDate(1).toISOString().slice(0, 10) === '1900-01-01');
  check('serial 59 is 1900-02-28, the last day before the fiction',
    serialToDate(59).toISOString().slice(0, 10) === '1900-02-28');
  check('serial 60 is the 29th of February 1900, which never happened, so it is refused',
    serialToDate(60) === null);
  check('serial 61 is 1900-03-01 — the two-day offset applies from here up',
    serialToDate(61).toISOString().slice(0, 10) === '1900-03-01');
  check('a serial below 1 is not a date', serialToDate(0) === null && serialToDate(0.5) === null);
  check('a time of day is HH:MM:SS and carries at the minute',
    serialTime(0.4819444444) === '11:34:00', serialTime(0.4819444444));
  check('midnight is 00:00:00, not empty', serialTime(0) === '00:00:00');

  const styles = '<?xml version="1.0"?><styleSheet>'
    + '<numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>'
    + '<numFmt numFmtId="165" formatCode="hh:mm:ss"/>'
    + '<numFmt numFmtId="166" formatCode="&quot;Amount due&quot;"/></numFmts>'
    + '<cellStyleXfs count="1"><xf numFmtId="164"/></cellStyleXfs>'
    + '<cellXfs count="4"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/>'
    + '<xf numFmtId="166"/></cellXfs></styleSheet>';
  const ds = dateStyles(styles);
  check('a custom dd/mm/yyyy style is a date', ds.has(1) && !ds.has(0));
  check('a custom hh:mm:ss style is a TIME, not a date', ds.time.has(2) && !ds.has(2));
  check('the m in a quoted literal does not make "Amount due" a date',
    !ds.has(3) && !ds.time.has(3));
  check('cellStyleXfs is not mistaken for cellXfs — index 0 is the plain style',
    !ds.has(0) && !ds.time.has(0));

  const wb = readWorkbook(book({
    sheets: '<sheet name="S" sheetId="1" r:id="rId1"/>', styles,
    parts: { 'xl/worksheets/sheet2.xml': sheetXml(
      '<row r="1"><c r="A1" s="1"><v>45535</v></c><c r="B1" s="0"><v>45535</v></c>'
      + '<c r="C1" s="2"><v>0.4819444444</v></c><c r="D1" s="2"><v>3.22</v></c></row>') },
  }));
  const r = wb.sheets[0].rows[0];
  check('the same number is a Date under a date style', r[0] instanceof Date
    && r[0].toISOString().slice(0, 10) === '2024-08-31');
  check('…and stays a number under a plain style', r[1] === 45535, JSON.stringify(r[1]));
  check('a time under one day is a bare time', r[2] === '11:34:00', JSON.stringify(r[2]));
  check('a time format over a day or more keeps its date rather than dropping it',
    r[3] instanceof Date && r[3].toISOString().slice(0, 10) === '1900-01-03', JSON.stringify(r[3]));
}

/* ══ 6. cell kinds ═════════════════════════════════════════════════════ */
console.log('\nwhat a cell says when it is not a plain number');
{
  const wb = readWorkbook(book({
    sheets: '<sheet name="S" sheetId="1" r:id="rId1"/>',
    parts: { 'xl/worksheets/sheet2.xml': sheetXml(
      '<row r="1">'
      + '<c r="A1" t="inlineStr"><is><t>inline</t></is></c>'
      + '<c r="B1" t="str"><f>A1</f><v>formula text</v></c>'
      + '<c r="C1"><f>SUM(1,2)</f><v>3</v></c>'
      + '<c r="D1" t="e"><v>#REF!</v></c>'
      + '<c r="E1" t="b"><v>1</v></c>'
      + '<c r="F1"><f>NOW()</f></c>'
      + '</row>') },
  }));
  const r = wb.sheets[0].rows[0];
  check('an inline string is read', r[0] === 'inline', JSON.stringify(r[0]));
  check('a formula’s CACHED value is taken, never the formula', r[2] === 3, JSON.stringify(r[2]));
  check('…including a string-valued formula', r[1] === 'formula text', JSON.stringify(r[1]));
  check('a spreadsheet error is an object, so a caller can refuse the row by name',
    r[3] && r[3].error === '#REF!', JSON.stringify(r[3]));
  check('a boolean is a boolean', r[4] === true, JSON.stringify(r[4]));
  check('a formula with NO cached value is absent, never zero', r[5] === null, JSON.stringify(r[5]));
}

/* ══ 7. sheet order and identity ═══════════════════════════════════════
   The part a sheet lives in is resolved through r:id. sheetN.xml is NOT the
   sheet's position: reordering or deleting tabs leaves the old file names, so
   a reader that sorts by filename reads the wrong tab — and every tab in
   these workbooks has near-identical headers, so it would not look wrong. */
console.log('\nthe tab is found through r:id, not by the name of its part');
{
  const wb = readWorkbook(book({
    sheets: '<sheet name="Journal" sheetId="1" r:id="rId9"/>'
      + '<sheet name="Salary Sheet" sheetId="2" r:id="rId1" state="hidden"/>',
    parts: {
      'xl/worksheets/sheet7.xml': sheetXml('<row r="1"><c r="A1"><v>111</v></c></row>'),
      'xl/worksheets/sheet2.xml': sheetXml('<row r="1"><c r="A1"><v>222</v></c></row>'),
    },
  }));
  check('sheet order is the workbook’s, not the parts’',
    wb.sheetNames.join('|') === 'Journal|Salary Sheet', wb.sheetNames.join('|'));
  check('rId9 resolves to sheet7.xml even though it is listed first',
    wb.sheets[0].rows[0][0] === 111, JSON.stringify(wb.sheets[0].rows[0][0]));
  check('rId1 resolves to sheet2.xml', wb.sheets[1].rows[0][0] === 222);
  check('a hidden tab is reported as hidden rather than silently dropped',
    wb.sheets[1].state === 'hidden' && wb.sheets[0].state === 'visible');
}

/* ══ 8. namespace-prefixed elements ════════════════════════════════════
   One workbook in the corpus is written by a PDF-to-Excel converter and
   prefixes every element: <x:workbook><x:sheets><x:sheet .../>. Patterns
   matching <sheet\b find nothing in it, and the reader returned a workbook
   with ZERO SHEETS and no error — which is indistinguishable from an empty
   workbook. Found by the differential run against openpyxl, never by looking
   at the output. */
console.log('\na workbook that prefixes its XML elements is still a workbook');
{
  const ns = (x) => x.replace(/<(\/?)(workbook|sheets|sheet|worksheet|sheetData|row|c|v|is|t|si|sst)\b/g, '<$1x:$2');
  const wb = readWorkbook(zip({
    'xl/workbook.xml': ns('<?xml version="1.0"?><workbook xmlns:x="n"><sheets>'
      + '<sheet name="Converted Data" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': ns('<?xml version="1.0"?><sst count="1" uniqueCount="1"><si><t>Plate Code</t></si></sst>'),
    'xl/styles.xml': '<?xml version="1.0"?><styleSheet><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet2.xml': ns('<?xml version="1.0"?><worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="0"/><c r="C1"><v>7</v></c></row>'
      + '</sheetData></worksheet>'),
  }));
  check('the prefixed workbook reports its sheet rather than none',
    wb.sheetNames.length === 1 && wb.sheetNames[0] === 'Converted Data', JSON.stringify(wb.sheetNames));
  check('…and its cells are read, shared strings included',
    wb.sheets[0].rows[0][0] === 'Plate Code', JSON.stringify(wb.sheets[0].rows[0][0]));
  check('…and the blank-cell rule still holds under a prefix',
    wb.sheets[0].rows[0][2] === 7, JSON.stringify(wb.sheets[0].rows[0][2]));
}

check('A1 references decode past Z', A1('A1').col === 0 && A1('Z1').col === 25
  && A1('AA1').col === 26 && A1('BE152').col === 56 && A1('BE152').row === 151);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
