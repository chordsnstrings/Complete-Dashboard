/* A tab called Today that did not show today.
   ─────────────────────────────────────────────────────────────────────────
   Measured on production, 5 September 2026 at 06:45 Dubai. The phone's first
   tab was headed "Today", subtitled THIS MONTH, and led with "773 bookings a
   day" over four complete days; its chart was captioned "4 complete days,
   today excluded — it is still filling", and the only mention of the current
   day was the last clause of the lede paragraph. The desktop landed on Unit
   economics over a thirty-day window and had no line about the current day at
   all. Meanwhile /api/day for that date held 21 bookings, 16 completed, AED
   964 in fares and 70 of 264 vehicles reporting a position.

   The exclusion of today from the daily RATE is correct and stays — a part-day
   averaged in reads as a collapse, which is the bug that put it there. What
   was missing is the day stated in its own right, beside the window.

   This file holds down the three things that make that honest:
     · which money figure a live line may show, and which it may not
     · that it is absent rather than zero before the first booking lands
     · that both shells say it the same way, from the same module */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const mod = readFileSync('api/public/today.js', 'utf8');
const app = readFileSync('api/public/app.js', 'utf8');
const phone = readFileSync('api/public/m/screens.js', 'utf8');
const html = readFileSync('api/public/index.html', 'utf8');
const css = readFileSync('api/public/app.css', 'utf8');

console.log('\nthe figure it shows is a measurement of today');

/* /api/day carries `revenue` — the price on the bookings actually taken since
   midnight — and `accounted`, whose own basis line reads "a share of each
   weekly platform statement, spread evenly across the days it covers". On 5
   September those were AED 964 and AED 9,657. The second is a seventh of a
   week that has not happened: it would print the same number at 06:00 as at
   23:00. A live line must not carry a projection. */
check('it reads the day’s own fares, not the statement spread',
  /fares: num\(h\.revenue\)/.test(mod) && !/accounted/.test(mod.replace(/\/\*[\s\S]*?\*\//g, '')),
  'accounted is a share of a weekly statement spread across its days — a projection, not today');
check('and it carries the count those fares cover',
  /priced: num\(h\.priced\)/.test(mod),
  'a fare total over an unstated number of bookings is the figure this product spent a month removing');
check('the fleet-wide caveat is stated, because /api/day takes no filters',
  /both fleets, every channel/.test(phone) && /does not follow the filters above it/.test(app),
  'a band that claimed to honour the channel chips would be lying about a figure it cannot filter');

console.log('\nabsent, never zero');

check('the day is marked started only when a booking has actually landed',
  /started: bookings != null && bookings > 0/.test(mod),
  'zero is a measurement, and before the first booking there is none to report');
check('and the lede says so, with the minute it is speaking at',
  /Nothing collected yet today, as of \$\{t\.asOf\} Dubai/.test(mod),
  'a row of noughts at 06:00 reads as a dead fleet');
check('both shells branch on it rather than printing the figures anyway',
  /if \(t\.started\)/.test(app) && /if \(now\.started\)/.test(phone));
check('…and the phone still names the cars, which are reporting either way',
  /tracked vehicles are reporting a position/.test(phone),
  'a fleet with no trips yet at 06:00 still has vehicles on the road');

console.log('\none module, both shells');

check('the desktop imports the shared shape rather than building its own',
  /import \{ todayLive, todayLede.*\} from '\.\/today\.js'/.test(app));
check('and so does the phone',
  /import \{ todayLive, todayLede.*\} from '\.\.\/today\.js'/.test(phone),
  'a rule kept in one shell is a rule the other shell will contradict');
check('the clock is Dubai’s on both, from tz.js',
  /dubaiClock\(\)\.hhmm/.test(mod) && /import \{ dubaiDay, dubaiClock \}/.test(mod));

console.log('\nand it is above every page, not on one of them');

check('the band lives in the shell, outside #view',
  /id="todayNow"/.test(html)
  && html.indexOf('id="todayNow"') < html.indexOf('<section id="view">'),
  'every view replaces #view wholesale, so a band inside it would be one page’s');
check('and is painted on every render, beside freshness and the auth banner',
  /freshness\(\); authBanner\(\); todayNow\(\);/.test(app));
check('it starts hidden, so a failed fetch shows nothing rather than an empty box',
  /id="todayNow" class="todaynow" hidden/.test(html) && /host\.hidden = true/.test(app));
check('the phone puts it FIRST on the tab that is named after it',
  phone.indexOf("card('Today so far'") > 0
  && phone.indexOf("card('Today so far'") < phone.indexOf("lede(deck, {"),
  'a Today tab that leads with the month is answering a question nobody opened it to ask');
check('and the tab’s subtitle no longer says only THIS MONTH',
  /today: \['Today', `now, then \$\{WINDOW_NOTE\(\)\}`\]/.test(phone));

console.log('\nit is live, and there is one today per screen');

/* api() is stale-while-revalidate: it returns the held body immediately and
   revalidates behind it. That is right for a page about a window and wrong for
   a band that stamps a Dubai clock time on itself — on production the band read
   56 bookings "as of 07:15" while the lede three inches below it, off a
   different endpoint, read 68. */
check('the band takes api() off the stale-while-revalidate path',
  /api\(`\$\{path\}&t=\$\{minute\}`, \{ cache: 'no-store' \}\)/.test(mod),
  'passing an options object is what stops api() reading and writing the store');
check('…and stamps the minute, for the caches it cannot pass an option to',
  /const minute = Math\.floor\(Date\.now\(\) \/ 60000\)/.test(mod),
  'the server cache is version-keyed and re-checks every 30s; a per-minute key costs one computation');
check('the phone\u2019s month lede reads the SAME today the card above it shows',
  /Today has \$\{fmt\(now\?\.started \? now\.bookings : soFar\)\} so far/.test(phone),
  'two numbers for today on one screen is the complaint the calendar window was built to answer');

console.log('\nand a low fares ratio is explained as the schedule it is');

check('the reason lives in one place',
  /export const FARES_LAG/.test(mod)
  && /separate weekly report, walked overnight/.test(mod));
check('the desktop hangs it off the band when the ratio is short',
  /lag \? `\\n\\n\$\{FARES_LAG\}` : ''/.test(app));
check('and the phone prints it, having no hover to put it in',
  /if \(now\.priced != null && now\.bookings != null && now\.priced < now\.bookings\)/.test(phone)
  && /FARES_LAG/.test(phone));

console.log('\nand the window keeps its own rule');

/* The reason the exclusion exists, unchanged: this file must not have been
   "fixed" by averaging a part-day back into the daily rate. */
check('today is still excluded from the daily rate it would distort',
  /today excluded — it is still filling/.test(phone)
  && /const \{ complete, today: partial \} = splitToday\(daily\)/.test(phone),
  'a part-day averaged into a daily rate reads as a collapse — that is why the exclusion is there');

console.log('\nthe band is styled through tokens, so it follows the theme');

check('no literal colour is used in the band’s rules',
  !/\.todaynow[\s\S]{0,1400}?#[0-9a-fA-F]{3,6}/.test(css),
  'a colour that is not a token works in one theme and not the other');
check('and the pulse respects prefers-reduced-motion',
  /prefers-reduced-motion: reduce\)\{\.todaynow \.tn-dot\{animation:none\}\}/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
