/* What a wage workbook IS, tab by tab — read, classified, and nothing kept.
   ─────────────────────────────────────────────────────────────────────────
   src/salary/sheet.js decides which of the five wage-sheet families a tab is,
   finds its header row, its period and its company line, gathers every fleet
   signal, and REFUSES where the evidence disagrees with itself. It was written
   on 2026-09-22 and imported by nothing for seven weeks: the payslip import it
   was built for waits on the operator's answers (docs/HANDOFF.md §6.4 — which
   gross a payslip uses, when the issued payslip starts), so the classifier sat
   unreachable, and the only way to learn what it would say about a workbook
   was to read its source.

   This is the classifier with no import behind it. It takes the bytes of one
   .xlsx, reads them with src/salary/xlsx.js, and runs readWageSheet over every
   tab, returning what each tab was recognised as, or the refusal with its
   reason. It writes nothing, reads no database, and holds nothing after it
   returns — it does not even receive a database handle. The route that serves
   it (api/wage_sheet_routes.js) runs it in a worker thread with a heap limit
   and a clock, because the xlsx reader's regular expressions are linear per
   match but not across a hostile document, and a tab built to be slow should
   cost a refusal, not the API process.

   WHAT IT DELIBERATELY DOES NOT RETURN: any person. Not a name, not a driver
   id, not an amount. The classifier reads the id column to judge the fleet
   (an EG prefix can only be Egari) and counts the rows; this returns the
   count, the prefixes the classifier already reports as a fleet signal, and
   how many rows carry a placeholder such as "TBA" instead of an id. A preview
   that echoed the payroll back would be a payroll read path with no access
   rule of its own. */
import { readWorkbook } from './xlsx.js';
import { readWageSheet } from './sheet.js';

/* Twenty-four megabytes unpacked. A wage workbook is a few tabs of a few
   hundred rows; the HR export, the largest workbook this product reads, is
   255 KB for 143 people. Ten times anything real, and well inside a worker's
   heap on a 512 MB machine. */
export const MAX_UNPACKED = 24 * 1048576;
/* Forty tabs. The corpus's largest workbook has a handful; a file with
   hundreds is not a wage sheet, and reading every one is work nobody asked
   for. The tabs past the limit are counted and named as unread. */
export const MAX_SHEETS = 40;

const colLetter = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/* One tab, as the page shows it. Row and column are given as Excel numbers
   them — row 7, column B — because that is where a person looking at the
   file will look; the classifier counts rows from zero. */
function describeTab(sheet, r) {
  const refusals = [...(r.refusals || [])];
  /* A HIDDEN TAB IS REFUSED. src/salary/xlsx.js keeps the state for exactly
     this: a hidden tab is often the previous month left in place, and an
     import that read it would file last month's wages again. The classifier
     judges the cells; the tab's visibility is the workbook's fact, so it is
     said here. */
  if (sheet.state !== 'visible') {
    refusals.push(`this tab is ${sheet.state} — a hidden tab is often a previous month left in `
      + 'place, and an import would not read it as this month’s wages');
  }
  return {
    name: sheet.name,
    state: sheet.state,
    ok: refusals.length === 0,
    family: r.family ?? null,
    header_row: r.headerRow != null ? r.headerRow + 1 : null,
    id_header: r.idHeader ?? null,
    id_column: r.idColumn != null ? colLetter(r.idColumn) : null,
    name_column: r.nameColumn != null ? colLetter(r.nameColumn) : null,
    company: r.company || null,
    period_text: r.periodText ?? null,
    period: r.period ? {
      from: r.period.from, to: r.period.to, kind: r.period.kind, month: r.period.month,
      days: r.period.days, anomalies: r.period.anomalies || [],
    } : null,
    fleet: r.fleet ?? null,
    fleet_basis: r.fleetBasis ?? null,
    fleet_signals: (r.fleetSignals || []).map((s) => ({ source: s.source, says: s.says, detail: s.detail })),
    rows: r.rowCount ?? null,
    placeholder_rows: (r.placeholders || []).length,
    refusals,
  };
}

export function previewWorkbook(bytes, { filename = '', maxBytes = MAX_UNPACKED, maxSheets = MAX_SHEETS } = {}) {
  let wb;
  try {
    wb = readWorkbook(bytes, { maxBytes });
  } catch (e) {
    return { ok: false, readable: false, sheets: [], sheet_count: 0,
      refusals: [`this file could not be read as an .xlsx workbook: ${e.message}`] };
  }
  const tabs = wb.sheets.slice(0, maxSheets);
  const sheets = tabs.map((s) => {
    try {
      return describeTab(s, readWageSheet(s.rows, { path: filename }));
    } catch (e) {
      /* One tab the reader cannot finish is a refusal of that tab, never of
         the workbook, and never a guess. */
      return { name: s.name, state: s.state, ok: false, family: null,
        refusals: [`this tab could not be read: ${e.message}`] };
    }
  });
  const refusals = [];
  if (!wb.sheets.length) refusals.push('the workbook has no tabs at all');
  if (wb.sheets.length > tabs.length) {
    refusals.push(`only the first ${tabs.length} of ${wb.sheets.length} tabs were read — a wage `
      + `workbook has a handful, and these were not: ${wb.sheets.slice(tabs.length).map((s) => s.name).slice(0, 10).join(', ')}`);
  }
  return {
    ok: sheets.some((s) => s.ok),
    readable: true,
    sheet_count: wb.sheets.length,
    sheets,
    refusals,
  };
}
