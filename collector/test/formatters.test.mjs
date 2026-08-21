/* The number formatters are the last line before a wrong value reaches a screen.
   Two of them were letting one through:

   - `isNaN(Infinity)` is false, so a division by zero rendered as "Infinity%"
     — and because Infinity clears every "good" threshold, the tile was painted
     GREEN. A driver with 4.5 on-trip hours against 0 online hours was shown as
     an exemplary utilisation figure.
   - `Number('') === 0`, so an empty string rendered as a confident "0" rather
     than "no data".
   - Minutes were rounded independently of hours, so 23:59:42 rendered "23:60". */
import { fmt, pct, hourStr, money } from '../api/public/ui.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
