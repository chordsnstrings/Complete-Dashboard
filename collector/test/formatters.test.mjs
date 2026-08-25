/* The number formatters are the last line before a wrong value reaches a screen.
   Two of them were letting one through:

   - `isNaN(Infinity)` is false, so a division by zero rendered as "Infinity%"
     — and because Infinity clears every "good" threshold, the tile was painted
     GREEN. A driver with 4.5 on-trip hours against 0 online hours was shown as
     an exemplary utilisation figure.
   - `Number('') === 0`, so an empty string rendered as a confident "0" rather
     than "no data".
   - Minutes were rounded independently of hours, so 23:59:42 rendered "23:60". */
import { fmt, pct, hourStr, money, tripTime, tierLabel } from '../api/public/ui.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

check('a finite number formats', fmt(1234.5, 1) === '1,234.5', fmt(1234.5, 1));
check('Infinity is not a number', fmt(Infinity) === '—', fmt(Infinity));
check('-Infinity is not a number', fmt(-Infinity) === '—', fmt(-Infinity));
check('NaN is not a number', fmt(NaN) === '—', fmt(NaN));
check('null is not a number', fmt(null) === '—', fmt(null));
check('an empty string is not zero', fmt('') === '—', fmt(''));
// Postgres sends numeric as a string; those must still format.
check('a numeric string still formats', fmt('15723.00') === '15,723', fmt('15723.00'));
check('zero is a real value, not missing', fmt(0) === '0', fmt(0));

check('a percentage formats', pct(96.42, 1) === '96.4%', pct(96.42, 1));
check('Infinity is not a percentage', pct(Infinity) === '—', pct(Infinity));
check('an empty string is not 0%', pct('') === '—', pct(''));
check('zero percent is a real value', pct(0) === '0%', pct(0));

check('a clock time formats', hourStr(6.5) === '06:30', hourStr(6.5));
check('a numeric string clock time formats', hourStr('6.50') === '06:30', hourStr('6.50'));
// 23.9995h is 23:59:58. Rounding minutes alone gave "23:60".
check('minutes never reach 60', hourStr(23.9995) === '00:00' || /:[0-5]\d$/.test(hourStr(23.9995)), hourStr(23.9995));
check('a near-hour rounds into the next hour', hourStr(6.999) === '07:00', hourStr(6.999));
check('an out-of-range hour is not rendered negative', !/-/.test(hourStr(-0.5)), hourStr(-0.5));
check('Infinity is not a clock time', hourStr(Infinity) === '—', hourStr(Infinity));

check('money formats with its currency', money(1234, 'AED') === 'AED 1,234', money(1234, 'AED'));
// A rate rounded to whole dirhams destroys the number: 2.70 became "AED 3".
check('a rate keeps its decimals', money(2.7, 'AED', 2) === 'AED 2.70', money(2.7, 'AED', 2));
check('missing money is not zero', money(null) === '—', money(null));
check('Infinity money is not rendered', money(Infinity) === '—', money(Infinity));

console.log('\ntripTime: the replay link takes what an API row actually carries');

/* requested_at arrives as an ISO STRING, and Intl.DateTimeFormat.format()
   accepts only Dates and numbers — handed the string it threw "Invalid time
   value" and the whole Drivers trips tab rendered its error state. The unit
   suite passed because nothing here called the helper with a row's real
   shape; the browser smoke that would have caught it did not get re-run for
   that change. This is the check that makes the unit suite enough. */
{
  const ok = tripTime('L45235', '2026-08-24T02:14:11.000Z');
  check('a string timestamp renders a link, not a throw',
    /href=.*vehicle.*movement\?day=2026-08-24/.test(ok), ok.slice(0, 90));
  check('the day in the link is the DUBAI day of the instant',
    ok.includes('day=2026-08-24'), '02:14 UTC is 06:14 in Dubai — same date here, but computed via TZ');
  const night = tripTime('L45235', '2026-08-23T21:30:00.000Z');
  check('and an evening UTC instant lands on the next Dubai date',
    night.includes('day=2026-08-24'), night.slice(0, 90));
  check('no plate degrades to plain text', !/href/.test(tripTime(null, '2026-08-24T02:14:11Z')));
  check('garbage time degrades to plain text, never a broken link',
    !/href/.test(tripTime('L45235', 'not-a-time')));
  check('null time does not throw either', !/href/.test(tripTime('L45235', null)));
}

/* ── two database enums in a header row of product names ──────────────────
   The tier table on #vehicles builds its columns from whatever the channels
   call their products, and the channels do not agree on a convention. Uber
   sends "Comfort" and "Black"; the hotel channel sends "drop_off" and
   "pick_and_drop". So the header row read

     Electric · UberX · Comfort · Black · pick_and_drop · drop_off

   — four product names and two enum values, side by side. tierLabel touches
   only the raw shape, because re-casing "UberX" to "Uberx" would be the same
   mistake in the other direction. */
console.log('\ntier labels: raw enums are for the database, not the header row');
check('an underscored enum becomes words', tierLabel('drop_off') === 'Drop Off', tierLabel('drop_off'));
check('and a longer one too', tierLabel('pick_and_drop') === 'Pick And Drop', tierLabel('pick_and_drop'));
check('a product name already written for a reader is left exactly alone',
  tierLabel('UberX') === 'UberX' && tierLabel('Comfort') === 'Comfort'
  && tierLabel('Uber Black') === 'Uber Black', tierLabel('UberX'));
check('a single lowercase word is not an enum and is not touched',
  tierLabel('electric') === 'electric', tierLabel('electric'));
check('an absent tier is a dash, not the word undefined',
  tierLabel(null) === '—' && tierLabel(undefined) === '—' && tierLabel('') === '—');
check('a digit inside an enum survives', tierLabel('tier_2_black') === 'Tier 2 Black', tierLabel('tier_2_black'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);