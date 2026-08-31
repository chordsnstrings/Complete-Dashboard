/* The calendar the whole product reads context from.
   ─────────────────────────────────────────────────────────────────────────
   calendar_day answers "was this a Ramadan day", and the driver, day and
   vehicle pages all print it beside the work. It was written by a collector
   that inserted exactly ONE row per run — the day the run happened — so the
   table held a row for each day the worker was up and nothing before it. On
   production that is is_ramadan answering for 21–31 August and NULL for 1–20,
   in a column that renders as a fact.

   And the day it stamped was the UTC one, while every join key in this
   database is a Dubai day. Between 20:00 and midnight Dubai the row was filed
   under YESTERDAY — wrong for four hours of every day, silently, and only for
   the runs that happened to land in that window.

   The provider was never the limit: Aladhan serves a whole Gregorian month per
   call and always has. These checks are on the source, because exercising the
   collector means reaching two public APIs, and a test that needs the internet
   is a test that fails for the wrong reason. */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync('src/sources/external.js', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\nthe calendar is filled for a range, in Dubai days');

check('nothing writes a single row keyed on the UTC clock any more',
  !/day:\s*iso\(now\)/.test(code) && !/\biso\(/.test(code),
  'iso() is the UTC date, and every join key here is a Dubai day');
check('the collector asks Aladhan for a whole month, not one day',
  /gToHCalendar\/\$\{m\}\/\$\{y\}/.test(code),
  'the one-day gToH endpoint is why the table only ever held the days a run happened');
check('and it writes them in one upsert rather than one row per run',
  /upsertMany\('calendar_day'/.test(code));
check('the range comes from the run window, so a backfill fills history',
  /pullCalendar\(from \|\| back\(\d+\), to \|\| today\)/.test(code));
check('collect() takes the window it is given',
  /collect\(\{ mode = 'incremental', from = null, to = null \} = \{\} \)?/.test(code)
  || /collect\(\{ mode = 'incremental', from = null, to = null \} = \{\}\)/.test(code));

console.log('\nthe day is Asia/Dubai, and so is the forecast flag');

check('there is one Dubai-day helper and the calendar uses it',
  /const dubaiDay = /.test(code) && /const today = dubaiDay\(\)/.test(code));
check('the weather run marks a forecast against the Dubai day too',
  (code.match(/dubaiDay\(\)/g) || []).length >= 2,
  'a UTC today marked the current day as a forecast for four hours every evening');
check('nothing ahead of today is written',
  /const end = to > today \? today : to;/.test(code),
  'a calendar row for a day that has not happened joins to trips that cannot exist');

console.log('\nsunrise and sunset come with it, at the right offset');

check('the sun times are asked for over the same range',
  /daily=sunrise,sunset&start_date=\$\{from\}&end_date=\$\{to\}/.test(code),
  'sunrise-sunset.org answers one day per call, which is why the column was only ever written once');
check('…and carry the Dubai offset, since the request named the zone',
  /\$\{rise\}:00\+04:00/.test(code) && /\$\{set\}:00\+04:00/.test(code),
  'a bare local time bound into a timestamptz by a UTC collector lands four hours early');
check('a failed sun lookup does not lose the Hijri row it was decorating',
  /catch \(e\) \{[\s\S]{0,220}sun lookup failed for the range/.test(src));
check('and the sun columns are omitted rather than nulled when unknown',
  /if \(s\) \{ row\.sunrise = s\.sunrise; row\.sunset = s\.sunset; \}/.test(code),
  'upsertMany updates the columns it is given — writing null would erase a value already stored');

console.log('\nwhat the page must NOT do with the columns nobody writes');

const drv = readFileSync('api/public/driver.js', 'utf8');
check('the driver day table does not print is_holiday, which has no writer',
  !/r\.is_holiday \?/.test(drv),
  'the DDL default is false, so rendering it says "not a holiday" where it means "never asked"');
check('…and the endpoint stops selecting it',
  !/c\.is_holiday, c\.holiday_name/.test(readFileSync('api/driver_routes.js', 'utf8')));
const sql = readFileSync('sql/schema_v2.sql', 'utf8');
check('the columns are still THERE, so a real holiday source can fill them',
  /is_holiday\s+BOOLEAN/.test(sql) && /holiday_name TEXT/.test(sql));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
