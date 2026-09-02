/* The Hijri calendar, and why it must not need a network call.
   ─────────────────────────────────────────────────────────────────────────
   MEASURED, production /api/status, 2026-09-02:

     external incremental partial
       hijri 2026-08: TypeError: fetch failed (ETIMEDOUT) …/gToHCalendar/8/2026
       hijri 2026-09: TypeError: fetch failed (ETIMEDOUT) …/gToHCalendar/9/2026
       calendar 2026-08-30..2026-09-02: asked for 2 month(s) and wrote no day
     events   incremental partial
       ramadan 2025: TypeError: fetch failed (ETIMEDOUT) …/hToG/01-09-1446
       ramadan 2026: TypeError: fetch failed (ETIMEDOUT) …/hToG/01-09-1447
       ramadan 2027: TypeError: fetch failed (ETIMEDOUT) …/hToG/01-09-1448

   calendar_day stopped dead at 2026-08-31: /api/day?day=2026-08-28 answers
   15-03-1448 Rabīʿ al-awwal, /api/day?day=2026-09-01 answers nothing. The same
   host answers those exact URLs with HTTP 200 in 0.81s from outside the app,
   so the fault is the app's egress and no amount of timeout, retry or backoff
   in this repo reaches it.

   The Hijri calendar does not need a provider. The fixtures below are the
   provider's own answers, so this file is the proof of that claim rather than
   an assertion of it:

     ALADHAN_MONTH_STARTS — every Hijri month start in 2024-01-01..2026-12-31,
       lifted from api.aladhan.com/v1/gToHCalendar JSON (method HJCoSA). If the
       37 boundaries land on the same Gregorian days, every day between them
       does too: both calendars advance one day at a time.
     STORED_BY_ALADHAN    — 48 days read back from production /api/day, i.e.
       rows Aladhan itself wrote into calendar_day while it was reachable,
       sampled across the whole span the table holds (2025-09-01..2026-08-28).
     RAMADAN_STARTS       — the three ramadan rows in production /api/events,
       likewise written by the network version.

   No network and no database here on purpose: the old calendar could only be
   exercised by reaching two public APIs, which is exactly why "wrote no day"
   shipped and ran for two days without a test noticing. */
import { hijriOf, gregorianOfHijri, calendarDays, HIJRI_CALENDAR_AVAILABLE } from '../src/sources/external.js';
import { ramadanEvents } from '../src/sources/events.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* Gregorian day → the Hijri date Aladhan returns for it, for every 1st of a
   Hijri month across three years. */
const ALADHAN_MONTH_STARTS = [
  ['2024-01-13', '01-07-1445', 'Rajab'], ['2024-02-11', '01-08-1445', 'Shaʿbān'],
  ['2024-03-11', '01-09-1445', 'Ramaḍān'], ['2024-04-10', '01-10-1445', 'Shawwāl'],
  ['2024-05-09', '01-11-1445', 'Dhū al-Qaʿdah'], ['2024-06-07', '01-12-1445', 'Dhū al-Ḥijjah'],
  ['2024-07-07', '01-01-1446', 'Muḥarram'], ['2024-08-05', '01-02-1446', 'Ṣafar'],
  ['2024-09-04', '01-03-1446', 'Rabīʿ al-awwal'], ['2024-10-04', '01-04-1446', 'Rabīʿ al-thānī'],
  ['2024-11-03', '01-05-1446', 'Jumādá al-ūlá'], ['2024-12-02', '01-06-1446', 'Jumādá al-ākhirah'],
  ['2025-01-01', '01-07-1446', 'Rajab'], ['2025-01-31', '01-08-1446', 'Shaʿbān'],
  ['2025-03-01', '01-09-1446', 'Ramaḍān'], ['2025-03-30', '01-10-1446', 'Shawwāl'],
  ['2025-04-29', '01-11-1446', 'Dhū al-Qaʿdah'], ['2025-05-28', '01-12-1446', 'Dhū al-Ḥijjah'],
  ['2025-06-26', '01-01-1447', 'Muḥarram'], ['2025-07-26', '01-02-1447', 'Ṣafar'],
  ['2025-08-24', '01-03-1447', 'Rabīʿ al-awwal'], ['2025-09-23', '01-04-1447', 'Rabīʿ al-thānī'],
  ['2025-10-23', '01-05-1447', 'Jumādá al-ūlá'], ['2025-11-22', '01-06-1447', 'Jumādá al-ākhirah'],
  ['2025-12-21', '01-07-1447', 'Rajab'], ['2026-01-20', '01-08-1447', 'Shaʿbān'],
  ['2026-02-18', '01-09-1447', 'Ramaḍān'], ['2026-03-20', '01-10-1447', 'Shawwāl'],
  ['2026-04-18', '01-11-1447', 'Dhū al-Qaʿdah'], ['2026-05-18', '01-12-1447', 'Dhū al-Ḥijjah'],
  ['2026-06-16', '01-01-1448', 'Muḥarram'], ['2026-07-15', '01-02-1448', 'Ṣafar'],
  ['2026-08-14', '01-03-1448', 'Rabīʿ al-awwal'], ['2026-09-12', '01-04-1448', 'Rabīʿ al-thānī'],
  ['2026-10-12', '01-05-1448', 'Jumādá al-ūlá'], ['2026-11-11', '01-06-1448', 'Jumādá al-ākhirah'],
  ['2026-12-10', '01-07-1448', 'Rajab'],
];

// Rows Aladhan wrote into production's calendar_day, read back via /api/day.
const STORED_BY_ALADHAN = [
  ['2025-09-01', '09-03-1447', 'Rabīʿ al-awwal', false], ['2025-09-10', '18-03-1447', 'Rabīʿ al-awwal', false],
  ['2025-09-20', '28-03-1447', 'Rabīʿ al-awwal', false], ['2025-09-28', '06-04-1447', 'Rabīʿ al-thānī', false],
  ['2025-10-01', '09-04-1447', 'Rabīʿ al-thānī', false], ['2025-10-10', '18-04-1447', 'Rabīʿ al-thānī', false],
  ['2025-10-20', '28-04-1447', 'Rabīʿ al-thānī', false], ['2025-10-28', '06-05-1447', 'Jumādá al-ūlá', false],
  ['2025-11-01', '10-05-1447', 'Jumādá al-ūlá', false], ['2025-11-10', '19-05-1447', 'Jumādá al-ūlá', false],
  ['2025-11-20', '29-05-1447', 'Jumādá al-ūlá', false], ['2025-11-28', '07-06-1447', 'Jumādá al-ākhirah', false],
  ['2025-12-01', '10-06-1447', 'Jumādá al-ākhirah', false], ['2025-12-10', '19-06-1447', 'Jumādá al-ākhirah', false],
  ['2025-12-20', '29-06-1447', 'Jumādá al-ākhirah', false], ['2025-12-28', '08-07-1447', 'Rajab', false],
  ['2026-01-01', '12-07-1447', 'Rajab', false], ['2026-01-10', '21-07-1447', 'Rajab', false],
  ['2026-01-20', '01-08-1447', 'Shaʿbān', false], ['2026-01-28', '09-08-1447', 'Shaʿbān', false],
  ['2026-02-01', '13-08-1447', 'Shaʿbān', false], ['2026-02-10', '22-08-1447', 'Shaʿbān', false],
  ['2026-02-20', '03-09-1447', 'Ramaḍān', true], ['2026-02-28', '11-09-1447', 'Ramaḍān', true],
  ['2026-03-01', '12-09-1447', 'Ramaḍān', true], ['2026-03-10', '21-09-1447', 'Ramaḍān', true],
  ['2026-03-20', '01-10-1447', 'Shawwāl', false], ['2026-03-28', '09-10-1447', 'Shawwāl', false],
  ['2026-04-01', '13-10-1447', 'Shawwāl', false], ['2026-04-10', '22-10-1447', 'Shawwāl', false],
  ['2026-04-20', '03-11-1447', 'Dhū al-Qaʿdah', false], ['2026-04-28', '11-11-1447', 'Dhū al-Qaʿdah', false],
  ['2026-05-01', '14-11-1447', 'Dhū al-Qaʿdah', false], ['2026-05-10', '23-11-1447', 'Dhū al-Qaʿdah', false],
  ['2026-05-20', '03-12-1447', 'Dhū al-Ḥijjah', false], ['2026-05-28', '11-12-1447', 'Dhū al-Ḥijjah', false],
  ['2026-06-01', '15-12-1447', 'Dhū al-Ḥijjah', false], ['2026-06-10', '24-12-1447', 'Dhū al-Ḥijjah', false],
  ['2026-06-20', '05-01-1448', 'Muḥarram', false], ['2026-06-28', '13-01-1448', 'Muḥarram', false],
  ['2026-07-01', '16-01-1448', 'Muḥarram', false], ['2026-07-10', '25-01-1448', 'Muḥarram', false],
  ['2026-07-20', '06-02-1448', 'Ṣafar', false], ['2026-07-28', '14-02-1448', 'Ṣafar', false],
  ['2026-08-01', '18-02-1448', 'Ṣafar', false], ['2026-08-10', '27-02-1448', 'Ṣafar', false],
  ['2026-08-20', '07-03-1448', 'Rabīʿ al-awwal', false], ['2026-08-28', '15-03-1448', 'Rabīʿ al-awwal', false],
];

// world_event rows this collector wrote when hToG still answered (/api/events).
const RAMADAN_STARTS = [[1446, '2025-03-01'], [1447, '2026-02-18'], [1448, '2027-02-08']];

console.log('\nthe computed Hijri date is the one Aladhan returned');

{
  const wrong = ALADHAN_MONTH_STARTS
    .map(([g, hd, en]) => { const h = hijriOf(g); return (h && h.date === hd && h.month_en === en) ? null : `${g} want ${hd} ${en} got ${h && h.date} ${h && h.month_en}`; })
    .filter(Boolean);
  check(`all ${ALADHAN_MONTH_STARTS.length} Hijri month boundaries of 2024–2026 land on the provider's day`,
    wrong.length === 0, wrong.slice(0, 3).join(' | '));
}

{
  const wrong = STORED_BY_ALADHAN
    .map(([g, hd, en, ram]) => {
      const h = hijriOf(g);
      return (h && h.date === hd && h.month_en === en && (h.month === 9) === ram)
        ? null : `${g} want ${hd} ${en} ramadan=${ram} got ${h && h.date} ${h && h.month_en}`;
    }).filter(Boolean);
  check(`all ${STORED_BY_ALADHAN.length} days Aladhan already wrote into calendar_day are reproduced exactly`,
    wrong.length === 0, wrong.slice(0, 3).join(' | '));
}

check('the month names are the provider\'s transliteration, not ICU\'s',
  hijriOf('2026-08-01').month_en === 'Ṣafar' && hijriOf('2026-02-20').month_en === 'Ramaḍān',
  'a year of rows already in the table spell them this way and hijri_month is grouped on as text');

check('a day that is not a day is refused rather than guessed at',
  hijriOf('not-a-day') === null && hijriOf(null) === null);

/* Intl does not throw when the calendar is missing — it silently answers with
   Gregorian, which would fill hijri_date with a Gregorian date wearing a Hijri
   label. The collector asserts the calendar is really there and says so in the
   run error if it is not, rather than writing a year of confident nonsense. */
check('the runtime actually has the Umm al-Qura calendar, and the code checks',
  HIJRI_CALENDAR_AVAILABLE === true
  && new Intl.DateTimeFormat('en-u-ca-islamic-umalqura').resolvedOptions().calendar === 'islamic-umalqura');
check('…and the collector names that as the reason rather than "wrote no day"',
  /no islamic-umalqura /.test(readFileSync('src/sources/external.js', 'utf8')));

console.log('\nand it converts back, which is what the events collector needs');

{
  const wrong = RAMADAN_STARTS.map(([hy, g]) => (gregorianOfHijri(hy, 9, 1) === g ? null
    : `1 Ramaḍān ${hy}: want ${g} got ${gregorianOfHijri(hy, 9, 1)}`)).filter(Boolean);
  check('1 Ramaḍān 1446/1447/1448 are the dates production stored from hToG',
    wrong.length === 0, wrong.join(' | '));
}

{
  // Both directions agree for every day of a decade, so neither is fitted to
  // the fixtures above.
  let n = 0, bad = null;
  for (let t = Date.UTC(2020, 0, 1); t <= Date.UTC(2030, 11, 31); t += 864e5) {
    const g = new Date(t).toISOString().slice(0, 10);
    const h = hijriOf(g); n++;
    if (!h || gregorianOfHijri(h.year, h.month, h.day) !== g) { bad = g; break; }
  }
  check(`every day of 2020–2030 round-trips (${n} days)`, bad === null, String(bad));
}

console.log('\nthe range is filled with no hole, network or not');

{
  /* The exact window the last production run reported as "asked for 2 month(s)
     and wrote no day". */
  const rows = calendarDays('2026-08-30', '2026-09-02');
  check('the window that wrote no day now writes one row per day', rows.length === 4, String(rows.length));
  check('…including 2026-09-01 and 2026-09-02, which are NULL in production today',
    rows[2]?.day === '2026-09-01' && rows[2]?.hijri_date === '19-03-1448'
    && rows[3]?.day === '2026-09-02' && rows[3]?.hijri_date === '20-03-1448',
    JSON.stringify(rows.slice(2)));
}

{
  // A backfill-shaped range: every day present, once, in order.
  const rows = calendarDays('2025-09-01', '2026-08-31');
  const days = rows.map((r) => r.day);
  const expect = Math.round((Date.parse('2026-08-31') - Date.parse('2025-09-01')) / 864e5) + 1;
  check(`a year-long range yields every day exactly once (${rows.length}/${expect})`,
    rows.length === expect && new Set(days).size === expect, String(rows.length));
  check('…in ascending order, with no gap', days.every((d, i) => i === 0
    || Date.parse(d) - Date.parse(days[i - 1]) === 864e5));
  check('…and Ramadan 1447 is flagged across its whole month, not just its first day',
    rows.filter((r) => r.is_ramadan).length === 30
    && rows.find((r) => r.is_ramadan).day === '2026-02-18',
    String(rows.filter((r) => r.is_ramadan).length));
}

check('an inverted or empty range yields nothing rather than throwing',
  calendarDays('2026-09-02', '2026-08-30').length === 0 && calendarDays(null, null).length === 0);

console.log('\nRamadan and Eid are computed, and the month ends where Shawwāl begins');

{
  const failed = [];
  const ev = ramadanEvents([2025, 2026, 2027], failed);
  const by = (code, hy) => ev.find((e) => e.code === code && e.title.endsWith(String(hy)));
  check('nothing failed, because nothing was fetched', failed.length === 0, failed.join('; '));
  check('Ramadan 1447 starts on the day production stored', by('ramadan', 1447)?.starts_on === '2026-02-18',
    by('ramadan', 1447)?.starts_on);
  /* Ramadan 1446 is a 29-day month. The network version wrote start + 29 days,
     which is 2025-03-30 — 1 Shawwāl, the Eid day, and the same date its own
     eid_fitr row starts on. Production still holds that overlap. */
  check('a 29-day Ramadan ends the day BEFORE Eid, not on it',
    by('ramadan', 1446)?.ends_on === '2025-03-29', by('ramadan', 1446)?.ends_on);
  check('…and the Eid row starts on 1 Shawwāl, the day after it',
    by('eid_fitr', 1446)?.starts_on === '2025-03-30' && by('eid_fitr', 1446)?.ends_on === '2025-04-01',
    JSON.stringify([by('eid_fitr', 1446)?.starts_on, by('eid_fitr', 1446)?.ends_on]));
  check('a 30-day Ramadan ends on its 30th day', by('ramadan', 1447)?.ends_on === '2026-03-19',
    by('ramadan', 1447)?.ends_on);
  check('no Ramadan row is ever left with the Eid row on top of it',
    ev.filter((e) => e.code === 'ramadan').every((r) => {
      const eid = ev.find((e) => e.code === 'eid_fitr' && e.title.endsWith(r.title.split(' ').pop()));
      return eid && eid.starts_on > r.ends_on;
    }));
}

console.log('\nthe collector no longer has a network call between the range and the table');

{
  const ext = readFileSync('src/sources/external.js', 'utf8');
  const extCode = ext.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the calendar rows come from the local computation',
    /const rows = calendarDays\(from, end\);/.test(extCode),
    'this is the line that makes "wrote no day" impossible when a host is unreachable');
  check('…and no calendar_day column is read out of an Aladhan response any more',
    !/hijri_date:\s*h\?\.date/.test(extCode)
    && !/hijri_month:\s*h\?\.month\?\.en/.test(extCode)
    && !/is_ramadan:\s*Number\(h\?\.month\?\.number\)/.test(extCode),
    'the provider is a cross-check now, not the writer');
  /* The live call is KEPT, but only as a cross-check on one month, so a
     computed calendar cannot silently drift from the provider. It must be
     cheap: the old shape was one call per month of window with retries:2 and
     timeoutMs:30000, which on a 25-month backfill is 75 connection attempts
     that each have to time out. */
  check('a cross-check against the provider survives, bounded to one cheap call',
    /crossCheckHijri/.test(extCode) && /timeoutMs: 8000, retries: 0/.test(extCode));
  check('…and an unreachable cross-check is logged, not counted as a data failure',
    /hijri cross-check unreachable[\s\S]{0,80}return;/.test(ext),
    'the run wrote every day it was asked for; calling that partial is noise');
  check('…while a cross-check that DISAGREES is a failure the run reports',
    /failed\.push\(`hijri cross-check /.test(ext));

  const evs = readFileSync('src/sources/events.js', 'utf8');
  // Comment-stripped: the production error string is quoted above the function
  // it explains, and the point is that no CODE reaches that endpoint.
  const evsCode = evs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('the events collector no longer calls hToG at all', !/hToG/.test(evsCode),
    'a single-date conversion is arithmetic; it does not need a provider');
  check('…and ramadanEvents is exported so this file calls it rather than restating it',
    /export function ramadanEvents/.test(evs));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
