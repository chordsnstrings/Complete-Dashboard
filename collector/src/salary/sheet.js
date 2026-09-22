/* Which wage sheet this is, where its table starts, and whose fleet it is.
   ─────────────────────────────────────────────────────────────────────────
   Between src/salary/xlsx.js (which returns cells) and an importer (which
   writes ledger rows) sits the question of what the sheet IS. The corpus does
   not answer it consistently, so this file answers it from evidence and
   REFUSES where the evidence disagrees with itself.

   FIVE FAMILIES, measured over the 98 wage sheets in the corpus. The header
   row is not in the same place in any two of them:

     family              marker                              header row
     ecosine-payslip     "Ecosine Transports LLC" in row 1    9
     working-sheet       "Driver's Salary Working Sheet"      5
     hotel-working       "Hotel Driver's Salary Working…"     4
     portal-wages        no company row; "Period" in row 3    7
     hotel-supervisors   "Salary Sheet - <Month> <Year>"      4

   So the header row is FOUND, never assumed: it is the first row carrying a
   cell that reads exactly "Emp. ID", "Driver ID" or "Employee ID". Every tab
   in these workbooks has near-identical headings, and a hard-coded row number
   that is one out reads the sub-heading band as data — which produces a
   driver named "CASH" earning "BANK".

   ══ THE FLEET IS THE DANGEROUS ONE ═════════════════════════════════════
   MEASURED ON 2026-09-22, and it is worse than "the folder lies".

   Ten sheets are named "Egari Driver's Salary Sheet …", sit under an Egari
   path, and carry "Ecosine Transports LLC" in their own company row with
   driver ids of the Ecosine shape (D###). All three signals disagree.

   The tie-break was measured rather than argued. Taking April 2025: the
   Egari-named sheet and the Ecosine wages sheet for the same fortnight share
   FOURTEEN driver ids, and in all fourteen the NAME IS DIFFERENT. Not one
   match. The two fleets genuinely reuse one numbering space, so

       D002 at Ecosine and D002 at Egari are two different humans,

   and a driver id is therefore NEVER a key on its own. The key is
   (fleet, driver_id). An import that got the fleet wrong on those ten sheets
   would merge fourteen pairs of unrelated drivers per fortnight — the
   over-merge this product exists to prevent, arriving through the back door
   of a payroll import.

   Egari later renumbered onto an EG### prefix: the one person present in both
   the April and the November 2025 Egari sheets went D018 -> EG018. ONE case
   is not a rule, so nothing here maps old ids to new. It is recorded so that
   somebody can rule on it.

   WHAT THIS FILE THEREFORE DOES: it gathers every fleet signal, says what
   each one claims, and where they conflict it returns NO FLEET and a refusal
   naming the disagreement. It does not vote, and it does not prefer the
   filename because the filename happened to be right in the ten cases
   examined — a majority of two wrong signals is still wrong, and the next
   batch may disagree the other way. A human settles it once, and
   (per the tasklist) that decision is stored so the same month is not
   re-asked. */
import { parsePeriod } from './period.js';

const ID_HEADER = /^(emp\.?\s*id|employee\s*id|driver\s*id)$/i;
const NAME_HEADER = /name/i;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const squash = (v) => text(v).replace(/\s+/g, ' ');

/* ── where the table starts ──────────────────────────────────────────── */
export function findHeaderRow(rows, limit = 24) {
  for (let r = 0; r < Math.min(limit, rows.length); r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < row.length; c += 1) {
      if (ID_HEADER.test(text(row[c]))) {
        let nameCol = null;
        for (let k = 0; k < row.length; k += 1) {
          if (k !== c && NAME_HEADER.test(text(row[k]))) { nameCol = k; break; }
        }
        return { row: r, idCol: c, nameCol, idHeader: text(row[c]) };
      }
    }
  }
  /* The hotel supervisors' sheet has no id column at all — four people, by
     name, with a basis and a commission. It is still a wage sheet and must be
     recognised rather than discarded, but it is returned WITHOUT an id
     column so a caller cannot key on one that does not exist. */
  for (let r = 0; r < Math.min(limit, rows.length); r += 1) {
    const row = rows[r] || [];
    const hasName = row.some((c) => /^name$/i.test(text(c)));
    const hasNo = row.some((c) => /^(no\.?|sl\.?\s*no\.?|#)$/i.test(text(c)));
    if (hasName && hasNo) {
      return { row: r, idCol: null, nameCol: row.findIndex((c) => /^name$/i.test(text(c))), idHeader: null };
    }
  }
  return null;
}

/* ── the period line, wherever the family put it ─────────────────────── */
export function findPeriodLine(rows, limit = 12) {
  for (let r = 0; r < Math.min(limit, rows.length); r += 1) {
    const row = rows[r] || [];
    for (let c = 0; c < Math.min(8, row.length); c += 1) {
      const v = squash(row[c]);
      if (!v) continue;
      /* "Period" in its own cell with the range in the next one — the portal
         family. The label alone parses as nothing, so the neighbour is what
         gets read. */
      if (/^period$/i.test(v)) {
        const n = row[c + 1];
        const said = n instanceof Date ? n.toISOString().slice(0, 10) : squash(n);
        if (said) return { text: said, at: { row: r, col: c + 1 } };
      }
      if (/for the (month|period)/i.test(v) || /^salary sheet\s*[-–]\s*[A-Za-z]/i.test(v)) {
        return { text: v, at: { row: r, col: c } };
      }
    }
  }
  return null;
}

const FAMILY = [
  [/^ecosine transports llc$/i, 'ecosine-payslip'],
  [/^hotel driver'?s salary working sheet/i, 'hotel-working'],
  [/^driver'?s salary working sheet/i, 'working-sheet'],
  [/^salary sheet\s*[-–]/i, 'hotel-supervisors'],
];

export function findCompanyLine(rows, limit = 4) {
  for (let r = 0; r < Math.min(limit, rows.length); r += 1) {
    for (const cell of rows[r] || []) {
      const v = squash(cell);
      if (v) return { text: v, at: { row: r } };
    }
  }
  return null;
}

/* ── the fleet, from every signal at once ────────────────────────────── */
const FLEET_FROM_TEXT = (s) => {
  if (/egari/i.test(s)) return 'egari';
  if (/ecosine|le meridien/i.test(s)) return 'ecosine';
  return null;
};

export function fleetSignals({ path = '', company = '', ids = [] }) {
  const file = String(path).split('/').pop() || '';
  const signals = [];
  const fromFile = FLEET_FROM_TEXT(file);
  if (fromFile) signals.push({ source: 'filename', says: fromFile, detail: file });
  const fromCompany = FLEET_FROM_TEXT(company);
  if (fromCompany) signals.push({ source: 'company-row', says: fromCompany, detail: company });
  /* The id prefix is the WEAKEST signal and is reported as such: both fleets
     used D### at once, so it can only ever confirm Egari (EG/EGIN), never
     Ecosine. A D-prefixed sheet is not evidence of anything. */
  const prefixes = new Set(ids.map((i) => (/^([A-Za-z]+)/.exec(String(i).trim()) || [, ''])[1].toUpperCase())
    .filter(Boolean));
  if ([...prefixes].some((p) => p.startsWith('EG'))) {
    signals.push({ source: 'id-prefix', says: 'egari', detail: [...prefixes].join(', ') });
  }
  const claims = new Set(signals.map((s) => s.says));
  if (claims.size === 1) {
    return { fleet: [...claims][0], basis: signals.map((s) => s.source).join('+'), signals, conflict: null };
  }
  if (claims.size === 0) {
    return {
      fleet: null,
      basis: null,
      signals,
      conflict: 'nothing on this sheet or in its name says which fleet it belongs to',
    };
  }
  return {
    fleet: null,
    basis: null,
    signals,
    conflict: 'the fleet signals disagree — '
      + signals.map((s) => `${s.source} says ${s.says}`).join('; ')
      + '. Measured 2026-09-22: ten sheets named "Egari …" carry an Ecosine company row '
      + 'and Ecosine-shaped ids, and the two fleets reuse one numbering space — the same '
      + 'id is a different person in each. Guessing here merges unrelated drivers, so this '
      + 'is left for a human to settle.',
  };
}

/* ── the whole reading of one sheet ──────────────────────────────────── */
export function readWageSheet(rows, { path = '' } = {}) {
  const refusals = [];
  const head = findHeaderRow(rows);
  if (!head) {
    return {
      ok: false,
      refusals: ['no header row: no cell reading "Emp. ID", "Driver ID" or "Employee ID", '
        + 'and no Name/No. pair either — this may not be a wage sheet'],
    };
  }
  const companyLine = findCompanyLine(rows);
  const company = companyLine ? companyLine.text : '';
  let family = 'unknown';
  for (const [re, name] of FAMILY) if (re.test(company)) { family = name; break; }
  if (family === 'unknown' && head.idCol !== null && head.row === 6) family = 'portal-wages';

  const periodLine = findPeriodLine(rows);
  let period = null;
  if (!periodLine) {
    refusals.push('no period line: the sheet does not say what period it covers, and the '
      + 'filename is not evidence — the corpus holds a December sheet in a November folder');
  } else {
    period = parsePeriod(periodLine.text);
    if (period.error) refusals.push(period.error);
  }

  /* The ids, read for the fleet check and for the caller's row loop. */
  const ids = [];
  if (head.idCol !== null) {
    for (let r = head.row + 1; r < rows.length; r += 1) {
      const v = rows[r][head.idCol];
      if (v === null || v === undefined || text(String(v)) === '') continue;
      ids.push(String(v).trim());
    }
  }
  const fleet = fleetSignals({ path, company, ids });
  if (fleet.conflict) refusals.push(fleet.conflict);

  /* "TBA" is not an id. Twenty rows in the corpus carry it where a driver id
     belongs, and a row whose subject is unknown cannot be filed against a
     person — it belongs in the unmatched queue, named. */
  const placeholders = ids.filter((i) => /^(tba|n\/?a|-+)$/i.test(i));

  return {
    ok: refusals.length === 0,
    family,
    company,
    headerRow: head.row,
    idColumn: head.idCol,
    nameColumn: head.nameCol,
    idHeader: head.idHeader,
    periodText: periodLine ? periodLine.text : null,
    period: period && !period.error ? period : null,
    fleet: fleet.fleet,
    fleetBasis: fleet.basis,
    fleetSignals: fleet.signals,
    rowCount: ids.length,
    placeholders,
    refusals,
  };
}
