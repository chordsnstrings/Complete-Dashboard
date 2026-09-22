/* What period a wage sheet covers, read off the sheet's own period line.
   ─────────────────────────────────────────────────────────────────────────
   THE FILENAME AND THE FOLDER BOTH LIE, and they lie in opposite directions.
   The corpus holds "Ecosine Drivers Wages for the month of December 2025
   Yeamin.xlsx" filed under a November folder, and folders named "Jan 25 to
   June 25" that hold both fleets. The only statement of the period that is
   part of the DOCUMENT is the period line, so that is what this reads, and a
   caller that cannot find one gets a refusal rather than a guess.

   FIFTY DISTINCT GRAMMARS were measured across the 98 wage sheets, and they
   are not a tidy set. In four shapes:

     "For the Month of October, 2025"            a whole month
     "for the month ended 31 May 2026"           a whole month, by its last day
     "For the Month of April 1-15, 2025"         HALF a month — payroll is
     "For the Month of January Dated 16 to 31"   semi-monthly in 2024-25
     "Period: 01 November 2025 to 30 November"   an explicit range
     "Salary Sheet - February 2026"              the hotel supervisors' sheet

   SEMI-MONTHLY IS THE ONE THAT MATTERS MOST. A month can be TWO sheets, so
   anything keyed on the month alone silently overwrites the first half with
   the second, or double-counts both into one month. The period is therefore
   returned as a from/to pair and never as a month string.

   THE SOURCE IS WRONG IN PLACES, and this is where the house rule bites: a
   figure that cannot be measured renders ABSENT WITH A REASON, never as a
   guess dressed up as a reading. So each of these is carried as a named
   ANOMALY on the result rather than silently repaired or silently refused:

     "For the Month of April 16-31, 2025"   April has 30 days. The 31st does
                                            not exist. Clamped to the 30th and
                                            recorded, because the intent — the
                                            second half of April — is not in
                                            doubt, but the text is wrong and a
                                            later reader must be able to see
                                            that it was.
     "December Dated 15 to 31, 2024"        its companion sheet is "1 to 15",
                                            so the 15th is in BOTH. A real
                                            overlap in the source. Reported,
                                            never deduplicated here: which
                                            sheet owns the 15th is a question
                                            for whoever ran that payroll.
     "Janury", "30st", "01st"               a misspelled month and impossible
                                            ordinals. Read through, recorded.

   Nothing here decides what to DO about an anomaly. It states what the sheet
   says, what this file read it as, and why they differ. */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/* Matched on the first three letters, which is what survives the misspelling
   in the corpus ("Janury" → jan). Three and not two because June and July
   are one letter apart, and a two-letter match would put half of 2025's
   payroll in the wrong month. */
const monthIndex = (word) => {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
};

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/* Ordinal suffixes are stripped before any number is read: the corpus carries
   "01st November -2025 to 30st November-2025", where "30st" is not a typo
   this file should fail on. The suffix is removed only where it follows a
   digit, so a word like "August" is untouched. */
const tidy = (s) => String(s || '')
  .replace(/ /g, ' ')
  .replace(/[‐-―]/g, '-')
  .replace(/(\d)(st|nd|rd|th)\b/gi, '$1')
  .replace(/\s+/g, ' ')
  .trim();

export function parsePeriod(text) {
  const raw = String(text ?? '');
  const s = tidy(raw);
  if (!s) return { error: 'no period line: the sheet does not state what period it covers' };
  const anomalies = [];
  const note = (code, said, read) => anomalies.push({ code, said, read });

  const yearOf = (str) => {
    const m = /\b(20\d\d)\b/.exec(str);
    return m ? Number(m[1]) : null;
  };

  /* ── an explicit range: "Period: 01 November 2025 to 30 November 2025" ── */
  const range = /(\d{1,2})\s*-?\s*([A-Za-z]+)\s*-?\s*(20\d\d)\s*(?:to|-|through|until)\s*(\d{1,2})\s*-?\s*([A-Za-z]+)\s*-?\s*(20\d\d)/i.exec(s);
  if (range) {
    const [, d1, mo1, y1, d2, mo2, y2] = range;
    const m1 = monthIndex(mo1); const m2 = monthIndex(mo2);
    if (m1 < 0 || m2 < 0) return { error: `period names a month this does not recognise: "${raw}"` };
    return finish(Number(y1), m1, Number(d1), Number(y2), m2, Number(d2), 'range');
  }

  /* ── "for the month ended 31 May 2026" — the whole month, by its last day ── */
  const ended = /month\s+ended\s+(\d{1,2})\s+([A-Za-z]+)\s*,?\s*(20\d\d)/i.exec(s);
  if (ended) {
    const m = monthIndex(ended[2]);
    if (m < 0) return { error: `period names a month this does not recognise: "${raw}"` };
    const y = Number(ended[3]);
    const last = daysIn(y, m);
    if (Number(ended[1]) !== last) {
      note('month-end-day-is-not-the-last-day', raw,
        `${MONTHS[m]} ${y} ends on the ${last}th; the sheet says the ${ended[1]}th. `
        + 'Read as the whole month.');
    }
    return finish(y, m, 1, y, m, last, 'month');
  }

  /* ── a half month, in either spelling ──────────────────────────────────
     "April 1-15, 2025" and "January Dated 16 to 31, 2025" are the same
     statement. The month must be found BEFORE the day pair, or "1-15" in a
     sheet titled "Salary Sheet - 1" would be read as days of nothing. */
  const mMatch = /(?:month\s+of|sheet\s*-)\s*([A-Za-z]+)/i.exec(s);
  const month = mMatch ? monthIndex(mMatch[1]) : -1;
  const year = yearOf(s);
  if (month >= 0 && year) {
    if (mMatch && monthIndex(mMatch[1]) >= 0 && !MONTHS[month].startsWith(String(mMatch[1]).toLowerCase())) {
      note('month-misspelled', raw, `read as ${MONTHS[month]}`);
    }
    const half = /(?:dated\s*)?\b(\d{1,2})\s*(?:-|to)\s*(\d{1,2})\b/i.exec(
      s.replace(/\b20\d\d\b/g, ' '));
    if (half) {
      let d1 = Number(half[1]); let d2 = Number(half[2]);
      const last = daysIn(year, month);
      if (d2 > last) {
        note('day-does-not-exist', raw,
          `${MONTHS[month]} ${year} has ${last} days; the sheet says the ${d2}th. `
          + `Clamped to the ${last}th.`);
        d2 = last;
      }
      if (d1 > last) return { error: `period starts on a day ${MONTHS[month]} does not have: "${raw}"` };
      if (d1 > d2) return { error: `period runs backwards: "${raw}"` };
      const kind = d1 <= 1 ? 'first-half' : 'second-half';
      /* A second half that starts on the 15th overlaps a first half that ends
         on it. Both sheets exist in the corpus for December 2024. */
      if (kind === 'second-half' && d1 <= 15) {
        note('half-months-overlap', raw,
          `the second half starts on the ${d1}th, and the first-half sheet for the `
          + `same month ends on the 15th — the ${d1}th is claimed by both`);
      }
      return finish(year, month, d1, year, month, d2, kind);
    }
    /* No day pair: the whole month. */
    return finish(year, month, 1, year, month, daysIn(year, month), 'month');
  }

  return { error: `period line not understood: "${raw}"` };

  function finish(y1, m1, d1, y2, m2, d2, kind) {
    const from = iso(y1, m1, d1);
    const to = iso(y2, m2, d2);
    if (to < from) return { error: `period runs backwards: "${raw}"` };
    const spansMonths = y1 !== y2 || m1 !== m2;
    if (spansMonths) {
      note('period-crosses-a-month-boundary', raw,
        'a wage period that is not inside one calendar month cannot be filed '
        + 'against a single month, and is carried as its own from/to pair');
    }
    return {
      from,
      to,
      kind,
      /* The month a whole-month or half-month sheet belongs to. Null where the
         period crosses a boundary, because there is no one month to name and
         inventing one is how a half of December lands in January. */
      month: spansMonths ? null : `${y1}-${String(m1 + 1).padStart(2, '0')}`,
      days: Math.round((Date.UTC(y2, m2, d2) - Date.UTC(y1, m1, d1)) / 86400000) + 1,
      said: raw.trim(),
      anomalies,
    };
  }
}
