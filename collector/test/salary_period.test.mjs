/* What period a wage sheet covers, read off the sheet rather than the folder.
   ─────────────────────────────────────────────────────────────────────────
   THE STRINGS BELOW ARE THE REAL ONES. All fifty distinct period lines in the
   salary corpus were collected and run through this parser; the ones asserted
   here are every shape among them plus every one the source gets wrong. They
   are dates and English, carrying no driver PII, so unlike the workbooks
   themselves they can live in the repository — and they should, because a
   grammar invented in a test is a grammar that has never met the data.

   SEMI-MONTHLY PAYROLL IS THE REASON THIS FILE IS CAREFUL. Through 2024 and
   2025 a month is often TWO sheets, "1-15" and "16-31". Anything keyed on the
   month alone either overwrites the first half with the second or counts both
   into one month, and both failures look like a plausible salary. */
import { parsePeriod } from '../src/salary/period.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const p = (s) => parsePeriod(s);
const span = (s) => { const r = p(s); return r.error ? `ERROR ${r.error}` : `${r.from}..${r.to}`; };
const codes = (s) => (p(s).anomalies || []).map((a) => a.code).join(',');

console.log('\nthe four grammars the corpus actually uses');
check('"For the Month of October, 2025" is the whole month',
  span('For the Month of October, 2025') === '2025-10-01..2025-10-31', span('For the Month of October, 2025'));
check('…and the comma is optional',
  span('For the Month of July 2025') === '2025-07-01..2025-07-31', span('For the Month of July 2025'));
check('"for the month ended 31 May 2026" is the whole month, named by its last day',
  span('for the month ended 31 May 2026') === '2026-05-01..2026-05-31', span('for the month ended 31 May 2026'));
check('an explicit range is taken as given',
  span('Period: 1 December 2025 to 31 December 2025') === '2025-12-01..2025-12-31',
  span('Period: 1 December 2025 to 31 December 2025'));
check('the hotel supervisors’ sheet titles its own month',
  span('Salary Sheet - February 2026') === '2026-02-01..2026-02-28', span('Salary Sheet - February 2026'));
check('February 2026 is not a leap year and ends on the 28th',
  p('Salary Sheet - February 2026').to === '2026-02-28');
check('February 2024 IS a leap year and ends on the 29th',
  span('For the Month of February, 2024') === '2024-02-01..2024-02-29', span('For the Month of February, 2024'));

console.log('\nsemi-monthly: a month is two sheets, and they must not collide');
check('"April 1-15, 2025" is the first half',
  span('For the Month of April 1-15, 2025') === '2025-04-01..2025-04-15');
check('…and is labelled as a half, not as a month',
  p('For the Month of April 1-15, 2025').kind === 'first-half');
check('"January Dated 16 to 31, 2025" is the same statement in the other spelling',
  span('For the Month of January Dated 16 to 31, 2025') === '2025-01-16..2025-01-31');
check('…and is a second half', p('For the Month of January Dated 16 to 31, 2025').kind === 'second-half');
check('the two halves of one month do not overlap',
  p('For the Month of April 1-15, 2025').to < p('For the Month of April 16-31, 2025').from,
  `${p('For the Month of April 1-15, 2025').to} vs ${p('For the Month of April 16-31, 2025').from}`);
check('a whole month is NOT reported as a half, so a caller can tell them apart',
  p('For the Month of April, 2025').kind === 'month' && p('For the Month of April, 2025').days === 30);

console.log('\nwhere the source is wrong, it is read through and RECORDED');
/* The house rule: a figure that cannot be measured renders absent with a
   reason, and a figure that had to be repaired says so. None of these is
   silently fixed and none is silently refused. */
check('"April 16-31" — April has 30 days, so the 31st is clamped',
  span('For the Month of April 16-31, 2025') === '2025-04-16..2025-04-30',
  span('For the Month of April 16-31, 2025'));
check('…and the clamp is reported rather than hidden',
  codes('For the Month of April 16-31, 2025') === 'day-does-not-exist',
  codes('For the Month of April 16-31, 2025'));
check('…naming what the sheet said and what was read',
  /April has 30 days|has 30 days/.test(p('For the Month of April 16-31, 2025').anomalies[0].read),
  p('For the Month of April 16-31, 2025').anomalies[0].read);
check('"December Dated 15 to 31, 2024" overlaps its own first-half sheet on the 15th',
  codes('For the Month of December Dated 15 to 31, 2024') === 'half-months-overlap',
  codes('For the Month of December Dated 15 to 31, 2024'));
check('…and the overlap is NOT silently deduplicated — the range is what it says',
  span('For the Month of December Dated 15 to 31, 2024') === '2024-12-15..2024-12-31');
check('"Janury" is read as January and the misspelling is recorded',
  span('For the Month of Janury Dated 01 to 15, 2025') === '2025-01-01..2025-01-15'
  && codes('For the Month of Janury Dated 01 to 15, 2025') === 'month-misspelled',
  codes('For the Month of Janury Dated 01 to 15, 2025'));
check('"01st" and "30st" are impossible ordinals and are read through',
  span('Period: 01st November -2025 to 30st  November-2025') === '2025-11-01..2025-11-30',
  span('Period: 01st November -2025 to 30st  November-2025'));
check('a whole month whose stated end day is not the last day says so',
  codes('for the month ended 30 May 2026') === 'month-end-day-is-not-the-last-day',
  codes('for the month ended 30 May 2026'));

console.log('\nwhat it refuses, rather than guessing');
check('an empty period line is an error, not a default month',
  !!p('').error && !!p(null).error);
check('a line with no month is refused', !!p('Salary details attached').error);
check('a month with no year is refused — the year is never inferred',
  !!p('For the Month of April 1-15').error, JSON.stringify(p('For the Month of April 1-15')));
check('a backwards half is refused rather than swapped',
  !!p('For the Month of April 20-5, 2025').error, JSON.stringify(p('For the Month of April 20-5, 2025')));
check('a start day the month does not have is refused, not clamped',
  !!p('For the Month of April 31-31, 2025').error);
check('June and July are told apart — a two-letter match would not',
  p('For the Month of June, 2025').month === '2025-06'
  && p('For the Month of July, 2025').month === '2025-07');

console.log('\nthe shape a caller depends on');
{
  const r = p('For the Month of April 16-31, 2025');
  check('a half month names the month it belongs to', r.month === '2025-04', String(r.month));
  check('…and carries its own day count', r.days === 15, String(r.days));
  check('…and keeps the sheet’s own words, so a reader can check it',
    r.said === 'For the Month of April 16-31, 2025', r.said);
  check('a clean period carries no anomalies',
    p('For the Month of October, 2025').anomalies.length === 0);
  const x = p('Period: 25 November 2025 to 10 December 2025');
  check('a period crossing a month boundary has no single month, and says why',
    x.month === null && x.anomalies.some((a) => a.code === 'period-crosses-a-month-boundary'),
    JSON.stringify(x.month));
  check('…but still carries its real from/to', x.from === '2025-11-25' && x.to === '2025-12-10');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
