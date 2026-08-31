/* Uber's own word on a driver, and the sentence it replaces.
   ─────────────────────────────────────────────────────────────────────────
   The roster showed a Rating column of em-dashes on all 365 people, under a
   sentence explaining that no channel this fleet is connected to reports one.
   That was never a fact about the channels. Uber answers GetDriver with

     driver.member.user.driverInfo.recognitionRating
     driver.member.user.driverInfo.completedTripsCount
     driver.member.user.isBanned
     driver.complianceInfo.status
     driver.associatedVehicles[] { uuid, licensePlate, make, model, year }

   and nothing here had asked. Probed live on 2026-08-31 against a real Ecosine
   driver: 4.97, 8,998 trips, not barred, ACTIVE, one vehicle.

   What is worth pinning is not the plumbing but the four judgements in it,
   because each is a way the feature could be quietly wrong:

     the org must own the driver, or Uber answers an error with no message
     a rating is one platform's opinion and must never be averaged with another
     a null rating means unasked, never unrated
     a make Uber knows must not overwrite a make we already hold with a null
*/
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const src = readFileSync('src/sources/uber_profile.js', 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const routes = readFileSync('api/driver_routes.js', 'utf8');
const ui = readFileSync('api/public/driver.js', 'utf8');
const sql = readFileSync('sql/schema_v45.sql', 'utf8');

console.log('\nthe collector asks the right org about the right driver');

check('a driver is only asked of the org whose roster names them',
  /WHERE platform = 'uber' AND fleet_id = \$1/.test(code),
  'asking Ecosine about an Egari driver returns an error with an empty message — measured');
check('the profile pull is its own pass, not folded into a collection window',
  /export async function collect\(\{ mode = 'profile'/.test(code));
check('it checkpoints per driver, so a deploy mid-sweep resumes',
  /checkpoint\?\.has\(`profile \$\{o\.fleet\}`, uuid\)/.test(code)
  && /checkpoint\?\.mark\(`profile \$\{o\.fleet\}`, uuid/.test(code));
check('and it paces, because this is the one call-per-driver surface here',
  /setTimeout\(r, 250\)/.test(code));
check('a dead cookie stops the pass rather than writing a fleet of nulls',
  /if \(out\.auth\)/.test(code) && /throw new Error\(`profile \$\{o\.fleet\}/.test(code),
  'a expired session must not be recorded as 160 drivers with no rating');
check('one refused driver does not cost the other hundred and fifty',
  /catch \(e\) \{ out = \{ err: String\(e\)/.test(code));
check('a GraphQL error is serialised, not String()-ed',
  /e\?\.message \|\| JSON\.stringify\(e\)/.test(code),
  'String() on an error object yields "[object Object]"');

console.log('\na rating is one platform’s opinion');

check('ratings are never averaged across platforms',
  !/avg\(rating\)|sum\(rating\)/i.test(routes),
  'two platforms rating one human are two opinions on two scales');
check('the best-attested platform leads, by the trips behind it',
  /\(r\.platform_lifetime_trips \|\| 0\) > \(cur\._ratingTrips \|\| 0\)/.test(routes));
check('a ban on any account bars the person',
  /if \(r\.is_banned === true\) cur\.is_banned = true;/.test(routes));
check('the endpoint says WHOSE rating it is',
  /rating_platform: rated\[0\]\?\.platform/.test(routes));
check('…and the tile prints that platform rather than "platform-reported"',
  /sourceLabel\(k\.rating_platform\)/.test(ui));
/* The kpis block specifically — the profile route sets a rating too, earlier
   in the file, and comparing against the first match measures the wrong one. */
{
  const kpis = routes.slice(routes.indexOf("app.get('/api/driver/kpis'"),
    routes.indexOf("app.get('/api/driver/daily'"));
  check('the rating is set AFTER the driver_performance spread, so a null cannot win',
    kpis.indexOf('rating: rated[0]?.rating') > kpis.indexOf('...perf,'),
    'spread order decides which survives when two sources offer the same key');
  check('…and driver_performance is no longer asked for a rating at all',
    !/avg\(rating\)/.test(kpis),
    'a column no collector writes, averaged, produced the null that shadowed the real one');
}

console.log('\na rating is only useful if you can see it move');

const hist = readFileSync('sql/schema_v46.sql', 'utf8');
check('every reading is kept, keyed on the day it was taken',
  /CREATE TABLE IF NOT EXISTS driver_rating_history/.test(hist)
  && /PRIMARY KEY \(platform, driver_ext_id, observed_on\)/.test(hist));
check('a week we did not ask leaves no row, so a gap is not read as no change',
  /A gap means we did not ask, never that the rating was unchanged/.test(hist));
check('the collector writes the history as well as the current row',
  /upsertMany\('driver_rating_history'/.test(code)
  && /upsertMany\('driver_platform_state'/.test(code));
check('the history day is the Dubai day, not the UTC one',
  /Date\.now\(\) \+ 4 \* 3600 \* 1000/.test(code));
check('the pull is weekly, on a Monday',
  /cron\.schedule\('20 0 \* \* 1'/.test(readFileSync('src/index.js', 'utf8')),
  'the rating moves by hundredths in a week; daily would write seven identical rows per movement');
check('the change is measured against the previous READING, not a fixed week',
  /row_number\(\) OVER \(PARTITION BY platform ORDER BY observed_on DESC\)/.test(routes)
  && /over_days/.test(routes),
  'a missed week must not be reported as a week of no change');
check('…and it carries the trips behind it',
  /over_trips/.test(routes),
  '0.02 over 40 trips and 0.02 over 900 are different events');
check('one reading gives null, never a change of zero',
  /\(trend\?\.latest != null && trend\?\.previous != null\)/.test(routes)
  && /rating_change: chg/.test(routes));
check('…and the tile says "first reading" rather than showing no movement',
  /first reading/.test(ui));

console.log('\nthe tile can carry markup, and the direction is not colour alone');

const appjs = readFileSync('api/public/app.js', 'utf8');
const css = readFileSync('api/public/app.css', 'utf8');
check('the count-up animation no longer flattens a composed KPI value',
  /if \(node\.firstElementChild\)/.test(appjs) && /querySelector\('\[data-count\]'\)/.test(appjs),
  'countUp assigns node.textContent, which destroyed the sparkline and the chip a frame after they rendered');
check('…and the rating number is still animated, by naming it',
  /class="rt-v" data-count/.test(ui));
check('the direction is stated in an arrow and a signed number, not only a hue',
  /\\u25b2/.test(ui) && /\\u25bc/.test(ui) && /signed\(c\.change/.test(ui),
  'app.css states the rule where severity chips are defined: never colour alone');
check('the sparkline is scaled to the readings, not to the 0-5 range',
  /const lo = Math\.min\(\.\.\.ys\), hi = Math\.max\(\.\.\.ys\);/.test(ui),
  'a rating lives in the top hundredths of its scale; drawn against 0-5 every driver is a flat line');
check('a single reading draws no line at all',
  /if \(pts\.length >= 2\)/.test(ui),
  'flat and unmeasured must not look the same');
check('the chip cannot be the part that gets clipped',
  /\.rt-chip\{flex:0 0 auto\}/.test(css));
check('motion is decoration, and the global reduced-motion rule covers it',
  /@media \(prefers-reduced-motion: reduce\)/.test(css)
  && /animation-duration:\.001ms !important/.test(css));
check('a rating always shows two decimals',
  /v\.toFixed\(2\)/.test(ui),
  '4.9 beside 4.83 reads as two different precisions');

console.log('\nnull means unasked, never unrated');

check('the schema says so',
  /never that the driver is unrated/.test(sql));
check('the tile says so',
  /not yet collected for this driver/.test(ui));
check('the roster column names the two channels and why each is empty',
  /Uber publishes a rating and is \\n?\s*\+? ?'?asked once a day/.test(ui)
  || /Uber publishes a rating and is/.test(ui));
check('the old sentence blaming the channels is gone',
  !/no channel this fleet is connected to reports a driver rating/.test(ui),
  'it was false: Uber reports one and we had not asked');

console.log('\nthe vehicle Uber names fills the register without clobbering it');

check('make, model and year are coalesced, never overwritten with a null',
  /make\s*=\s*coalesce\(EXCLUDED\.make,\s*vehicle\.make\)/.test(code)
  && /year\s*=\s*coalesce\(EXCLUDED\.year,\s*vehicle\.year\)/.test(code));
check('an existing fleet_id wins over the one this pass infers',
  /fleet_id = coalesce\(vehicle\.fleet_id,\s*EXCLUDED\.fleet_id\)/.test(code));
check('a driver attached to no car does not blank a car',
  /\.filter\(\(v\) => v\.plate\)/.test(code));

console.log('\nthe rating does not live in the column another provider uses');

check('score is left to Bolt, and the schema says why',
  /Deliberately NOT reusing `score`/.test(sql) && !/score:/.test(code),
  'one column holding two incomparable measures is how a page ranks people on a number that means two things');
check('profile_at is separate from observed_at',
  /ADD COLUMN IF NOT EXISTS profile_at/.test(sql) && /profile_at: new Date\(\)/.test(code),
  'the roster is read every half hour and this once a day');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
