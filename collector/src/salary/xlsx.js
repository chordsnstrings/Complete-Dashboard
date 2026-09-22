/* A dependency-free reader for .xlsx workbooks.
   ─────────────────────────────────────────────────────────────────────────
   The salary corpus arrives as Excel workbooks and this building has to read
   them server-side, because the monthly drop is meant to be a file landing on
   a page rather than somebody remembering to run a converter. Nothing in
   package.json could open one: the six runtime dependencies are compression,
   csv-parse, dotenv, express, node-cron and pg.

   The three candidates were exceljs (21.8 MB unpacked, onto a basic-xxs
   build), SheetJS 0.18.5 (the last version published to npm, carrying
   prototype-pollution and ReDoS advisories — not something to put under a
   money system), and this. An .xlsx is a ZIP of XML and node:zlib ships
   `inflateRawSync`, so the only thing missing was the ZIP envelope and a
   reader for the four parts that matter. The operator chose this on
   2026-09-22.

   WHAT THIS DELIBERATELY IS NOT: a general Excel reader. It reads the parts
   these workbooks use and REFUSES, by name, anything it does not understand —
   a Zip64 archive, an encrypted one, a compression method that is not stored
   or deflate. A reader that guesses on a payslip is a reader that invents
   somebody's wages, so every path that cannot be certain throws with the
   reason rather than returning a plausible number.

   THE TRAPS THIS FILE EXISTS TO HANDLE, each of which silently produces a
   wrong figure rather than an error:

     1. A DATE IS A NUMBER. Excel stores 2024-08-31 as 45535. Nothing in the
        cell says it is a date — the only evidence is the number format its
        style points at. A reader that ignores styles.xml turns every date in
        the corpus into a five-digit integer, and "DOJ" becomes an amount.
     2. EXCEL BELIEVES 1900 WAS A LEAP YEAR. Serial 60 is the 29th of February
        1900, a day that did not happen. Every date from serial 61 onward is
        one day further from the epoch than naive arithmetic gives.
     3. A STRING MAY LIVE SOMEWHERE ELSE. t="s" means the <v> is an INDEX into
        sharedStrings.xml, not text. Read literally, every name in the sheet
        becomes a small integer.
     4. RICH TEXT IS SPLIT ACROSS RUNS. One shared string can be
        <si><r><t>Sana</t></r><r><t>ullah</t></r></si>, and taking the first
        <t> alone silently truncates the name.
     5. ROWS AND COLUMNS ARE SPARSE. An empty cell is usually absent, not
        empty: a row can jump A→C→Q. Reading cells in document order and
        assuming they are consecutive shifts every column after the first gap,
        which lands a deduction under the wrong heading.
     8. NOT EVERY WORKBOOK USES THE DEFAULT XML NAMESPACE. One file in the
        corpus — produced by a PDF-to-Excel converter, tabs "Converted Data"
        and "PDF Check" — writes every element with a prefix:
        `<x:workbook><x:sheets><x:sheet name="..."/>`. Patterns matching
        `<sheet\b` find nothing in it, and the reader returned a workbook with
        ZERO sheets and no error at all. Every element pattern below therefore
        admits an optional `prefix:`. Found by the differential run, not by
        reading output: a workbook with no sheets looks like an empty
        workbook.
     7. A SELF-CLOSING TAG EATS THE NEXT ONE IF THE ATTRIBUTES ARE GREEDY.
        This cost an afternoon and is the reason every tag pattern below uses
        a LAZY attribute run. Written `<c\b([^>]*)(?:\/>|>...<\/c>)`, the
        greedy `[^>]*` swallows the `/` of `<c r="B5" s="59"/>`; the `\/>`
        branch then cannot match, the bare `>` branch matches instead, and the
        lazy body runs forward to the NEXT `</c>` — consuming every cell in
        between. These sheets are mostly blank cells in exactly that form, so
        the reader returned 5,604 cells for a sheet and silently dropped the
        ones after each blank: column A of the header row and the period line
        were both simply absent, with no error anywhere. It was caught only by
        reading the same file with a second implementation and diffing. The
        fix is `([^>]*?)`, which stops before the slash and lets `\/>` win.
     6. A CACHED FORMULA VALUE IS WHAT WE WANT. <f> is the formula and <v> is
        what Excel last calculated. This reads <v> and never evaluates. Where
        <v> is absent the cell is reported as null rather than zero, because a
        workbook saved by a tool that did not cache values cannot be read and
        must say so.
*/
import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

/* ── the ZIP envelope ────────────────────────────────────────────────────
   Read through the CENTRAL DIRECTORY rather than by walking local headers.
   A local header may carry zeroed sizes with the real ones in a trailing data
   descriptor (bit 3 of the general-purpose flags), which cannot be found
   without either scanning for a signature that may occur inside the data or
   trusting the central directory. The central directory always has them. */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  /* The EOCD is last, but a ZIP comment can follow it, so it is searched for
     backwards over the 64 KiB a comment may occupy plus the record itself. */
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip archive: no end-of-central-directory record. '
    + 'An .xlsx is a zip; a file that is not one is either a genuine .xls '
    + '(OLE2, magic D0 CF 11 E0), a CSV with the wrong extension, or corrupt.');
}

export function unzip(buf) {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (off === 0xffffffff || entryCount === 0xffff) {
    throw new Error('this archive is Zip64 and this reader does not implement it. '
      + 'Zip64 appears past 65,535 entries or 4 GiB; a salary workbook that '
      + 'reaches either is not a salary workbook, so this refuses rather than '
      + 'reading the wrong offsets.');
  }
  const files = new Map();
  for (let n = 0; n < entryCount; n += 1) {
    if (buf.readUInt32LE(off) !== CEN_SIG) {
      throw new Error(`central directory entry ${n} has no signature — archive is corrupt`);
    }
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    /* Bit 0 is the traditional-encryption flag. An encrypted member inflates
       to noise, which would read as a workbook full of nulls rather than as
       the locked file it is. */
    if (flags & 0x1) throw new Error(`"${name}" is encrypted — this reader cannot open it`);
    if (method !== 0 && method !== 8) {
      throw new Error(`"${name}" uses compression method ${method}; only stored (0) `
        + 'and deflate (8) are implemented');
    }
    /* The local header repeats the name and extra fields, and its extra field
       length may DIFFER from the central one, so the data offset has to be
       computed from the local header rather than from this entry. */
    if (buf.readUInt32LE(localOff) !== LOC_SIG) {
      throw new Error(`"${name}" points at offset ${localOff}, which is not a local file header`);
    }
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    files.set(name, method === 0 ? Buffer.from(raw) : inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ── XML scraps ──────────────────────────────────────────────────────────
   Not a parser. These documents are machine-written by Excel and the shapes
   below are the ones it emits; anything structural that is unexpected fails
   loudly upstream rather than being tolerated here. */
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
/* Excel writes a newline inside a cell as a literal CR LF pair. Left alone,
   every multi-line header ("Net Payable \r\n( E )= (C-D)") compares unequal to
   the same header read by anything that normalises, and the importer matches
   columns BY HEADER TEXT — so this is a correctness concern, not cosmetics. */
export const decodeXml = (s) => String(s).replace(/\r\n?/g, '\n').replace(
  /&(?:#(x?)([0-9a-fA-F]+)|([a-z]+));/g,
  (m, hex, num, name) => {
    if (num !== undefined) {
      const cp = parseInt(num, hex ? 16 : 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return name in ENTITIES ? ENTITIES[name] : m;
  });

/* ── sharedStrings.xml ───────────────────────────────────────────────────
   Trap 4 lives here: one <si> may hold several <r> runs and the string is all
   of their <t> joined. Taking the first would truncate a name at the point
   somebody changed the font. */
export function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const si = /<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>)/g;
  let m;
  while ((m = si.exec(xml)) !== null) {
    const inner = m[1] || '';
    let s = '';
    const t = /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>)/g;
    let tm;
    while ((tm = t.exec(inner)) !== null) s += decodeXml(tm[1] || '');
    out.push(s);
  }
  return out;
}

/* ── styles.xml: which cells are dates ───────────────────────────────────
   Trap 1. A cell's `s` attribute indexes cellXfs; that xf names a numFmtId;
   and the format is a date if it is one of the built-in date ids or if its
   custom format code contains a date token. The built-ins are fixed by the
   spec: 14-17 and 22 are dates, 18-21 and 45-47 are times. */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22]);
/* TIME-ONLY, and separate from the dates above because a time is NOT a date
   with a small number in front of it. Excel stores 11:34 as 0.4819 — a
   fraction of a day with no day — so running it through the date path gives a
   serial below 1, which serialToDate correctly refuses, and the cell then
   reads as EMPTY. That is how the Salik timestamps in the corpus silently
   disappeared: js=null where a second implementation read '11:34:00'. A time
   is returned as a plain HH:MM:SS string instead, because the only honest
   thing to say about 0.4819 is the time of day it encodes. */
const BUILTIN_TIME = new Set([18, 19, 20, 21, 45, 46, 47]);

export function dateStyles(xml) {
  const isDate = new Set();
  const isTime = new Set();
  isDate.time = isTime;
  if (!xml) return isDate;
  /* Custom formats first, so the xf loop can look them up. A format code is a
     date if it carries y, m, d, h or s OUTSIDE a quoted literal — "mmm" is a
     month, but the m in a literal like "Amount" is not. Bracketed sections
     ([$-409], [Red]) are stripped for the same reason. */
  const custom = new Map();
  const nf = /<(?:[A-Za-z_][\w.-]*:)?numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m;
  while ((m = nf.exec(xml)) !== null) {
    const code = decodeXml(m[2]).replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
    /* `m` is ambiguous — month in "mm/yyyy", minute in "hh:mm" — so it never
       decides on its own. A code carrying y or d is a date; one carrying h or
       s and NEITHER y nor d is a time of day. */
    if (/[yd]/i.test(code)) custom.set(Number(m[1]), 'date');
    else if (/[hs]/i.test(code)) custom.set(Number(m[1]), 'time');
    else custom.set(Number(m[1]), false);
  }
  /* cellXfs is the one xf list cells point at. styles.xml also holds
     cellStyleXfs with the same element name, so the block is isolated first —
     indexing into the wrong list marks the wrong columns as dates. */
  const block = /<(?:[A-Za-z_][\w.-]*:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?cellXfs>/.exec(xml);
  if (!block) return isDate;
  const xf = /<(?:[A-Za-z_][\w.-]*:)?xf\b[^>]*>|<(?:[A-Za-z_][\w.-]*:)?xf\b[^>]*\/>/g;
  let i = 0;
  let x;
  while ((x = xf.exec(block[1])) !== null) {
    const id = /numFmtId="(\d+)"/.exec(x[0]);
    const n = id ? Number(id[1]) : 0;
    const c = custom.get(n);
    if (BUILTIN_DATE.has(n) || c === 'date') isDate.add(i);
    else if (BUILTIN_TIME.has(n) || c === 'time') isTime.add(i);
    i += 1;
  }
  return isDate;
}

/* ── serial → Date ───────────────────────────────────────────────────────
   Trap 2. Excel's day 1 is 1900-01-01 and it also believes 1900-02-29
   existed, so serials from 61 up are one day ahead of a naive epoch. Serial
   60 IS that impossible day; it is returned as null rather than silently
   becoming the 28th or the 1st, because a date nobody can name is not a date.
   Dates are built in UTC and read back in UTC: a payslip day is a calendar
   day, and giving it a timezone is how it becomes the day before. */
export function serialToDate(n) {
  if (!Number.isFinite(n) || n < 1) return null;
  if (n >= 60 && n < 61) return null;
  const days = Math.floor(n) - (n >= 61 ? 2 : 1);
  const ms = Math.round((n - Math.floor(n)) * 86400) * 1000;
  return new Date(Date.UTC(1900, 0, 1) + days * 86400000 + ms);
}

/* A time of day, as HH:MM:SS. Only the fractional part carries the time; a
   datetime formatted as a time keeps its time and loses its date, which is
   what the format asked for. Rounding is to the second and carries: 0.99999
   of a day is 24:00:00 by naive truncation, and that is not a time. */
export function serialTime(n) {
  if (!Number.isFinite(n)) return null;
  let secs = Math.round((n - Math.floor(n)) * 86400);
  if (secs >= 86400) secs -= 86400;
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(secs / 3600))}:${p(Math.floor(secs / 60) % 60)}:${p(secs % 60)}`;
}

export const A1 = (ref) => {
  /* "BE152" → column index 56. Trap 5 depends on this: the column is read
     from the cell's own reference, never from its position in the row. */
  const m = /^([A-Z]+)(\d+)$/.exec(ref || '');
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
};

/* ── a worksheet ─────────────────────────────────────────────────────────
   Returns a dense array of rows, each a dense array of cells, with null for
   anything the sheet did not carry — so `rows[8][15]` is column P of row 9
   whatever the file chose to omit. */
function readSheet(xml, strings, isDateStyle) {
  const rows = [];
  const put = (r, c, v) => {
    while (rows.length <= r) rows.push([]);
    const row = rows[r];
    while (row.length <= c) row.push(null);
    row[c] = v;
  };
  const cell = /<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g;
  let m;
  while ((m = cell.exec(xml)) !== null) {
    const attrs = m[1] || '';
    const inner = m[2] || '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs);
    const at = ref ? A1(ref[1]) : null;
    if (!at) continue;
    const t = (/\bt="([^"]*)"/.exec(attrs) || [])[1] || 'n';
    const sIdx = Number((/\bs="(\d+)"/.exec(attrs) || [])[1] ?? NaN);

    if (t === 'inlineStr') {
      let s = '';
      const tt = /<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>)/g;
      let tm;
      while ((tm = tt.exec(inner)) !== null) s += decodeXml(tm[1] || '');
      put(at.row, at.col, s === '' ? null : s);
      continue;
    }
    /* <v> only — never <f>. Trap 6: the cached value is the answer, and a
       cell with a formula and no cached value is reported as absent. */
    const v = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(inner);
    if (!v) { put(at.row, at.col, null); continue; }
    const raw = decodeXml(v[1]);
    if (t === 's') {
      const i = Number(raw);
      put(at.row, at.col, Number.isInteger(i) && i >= 0 && i < strings.length ? strings[i] : null);
    } else if (t === 'str') {
      put(at.row, at.col, raw === '' ? null : raw);
    } else if (t === 'b') {
      put(at.row, at.col, raw === '1');
    } else if (t === 'e') {
      /* #DIV/0!, #REF! — a spreadsheet error is not a number and not a blank.
         It is surfaced as an object so a caller can refuse the row by name. */
      put(at.row, at.col, { error: raw });
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n)) { put(at.row, at.col, null); continue; }
      if (isDateStyle.has(sIdx)) put(at.row, at.col, serialToDate(n));
      else if (isDateStyle.time && isDateStyle.time.has(sIdx)) {
        /* A time format over a value of a day or more is either a datetime or
           an elapsed duration, and returning the time alone would throw away
           the days. Below one day there is no date to keep, so a bare time is
           the whole of what the cell says. */
        put(at.row, at.col, n < 1 ? serialTime(n) : serialToDate(n));
      }
      else put(at.row, at.col, n);
    }
  }
  /* Pad every row to the widest, so a caller may index a column without
     checking whether this particular row reached it. */
  const width = rows.reduce((a, r) => Math.max(a, r.length), 0);
  for (const r of rows) while (r.length < width) r.push(null);
  return rows;
}

/* ── the workbook ────────────────────────────────────────────────────────
   Sheet ORDER and sheet NAMES come from workbook.xml; the part each one lives
   in comes from resolving its r:id through workbook.xml.rels. The filename
   sheetN.xml is NOT the sheet's position — a workbook whose tabs have been
   reordered or deleted keeps the old file names, so a reader that sorts by
   filename silently reads the wrong tab. */
export function readWorkbook(bufOrPath) {
  const buf = Buffer.isBuffer(bufOrPath) ? bufOrPath : readFileSync(bufOrPath);
  const files = unzip(buf);
  const text = (n) => (files.has(n) ? files.get(n).toString('utf8') : null);

  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new Error('no xl/workbook.xml — this zip is not an .xlsx workbook');
  const relsXml = text('xl/_rels/workbook.xml.rels') || '';

  const rels = new Map();
  const rel = /<(?:[A-Za-z_][\w.-]*:)?Relationship\b[^>]*>/g;
  let rm;
  while ((rm = rel.exec(relsXml)) !== null) {
    const id = (/\bId="([^"]*)"/.exec(rm[0]) || [])[1];
    let target = (/\bTarget="([^"]*)"/.exec(rm[0]) || [])[1];
    if (!id || !target) continue;
    target = decodeXml(target).replace(/^\/xl\//, '').replace(/^\.\//, '');
    rels.set(id, target.startsWith('xl/') ? target : `xl/${target}`);
  }

  const strings = sharedStrings(text('xl/sharedStrings.xml'));
  const isDateStyle = dateStyles(text('xl/styles.xml'));

  const sheets = [];
  const sh = /<(?:[A-Za-z_][\w.-]*:)?sheet\b[^>]*>/g;
  let sm;
  while ((sm = sh.exec(wbXml)) !== null) {
    const name = decodeXml((/\bname="([^"]*)"/.exec(sm[0]) || [])[1] || '');
    const rid = (/\br:id="([^"]*)"/.exec(sm[0]) || [])[1];
    /* state="hidden" is kept and reported. A hidden tab is often the previous
       month left in place, and the importer must be able to see that it is
       hidden in order to refuse it. */
    const state = (/\bstate="([^"]*)"/.exec(sm[0]) || [])[1] || 'visible';
    const part = rid && rels.get(rid);
    sheets.push({
      name,
      state,
      part: part || null,
      get rows() {
        if (!part || !files.has(part)) return [];
        const value = readSheet(files.get(part).toString('utf8'), strings, isDateStyle);
        Object.defineProperty(this, 'rows', { value, configurable: true });
        return value;
      },
    });
  }
  return { sheets, sheetNames: sheets.map((s) => s.name), file: files };
}

export const sheetNamed = (wb, name) =>
  wb.sheets.find((s) => s.name.trim().toLowerCase() === String(name).trim().toLowerCase()) || null;
