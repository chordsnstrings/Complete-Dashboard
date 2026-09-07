/* What "how they rank in the fleet" is allowed to claim.
   ──────────────────────────────────────────────────────────────────────────
   Four defects in one panel, all measured on production 2026-09-07 against
   the deployed API. None of them is arithmetic in the percentile itself; all
   four are the panel describing a different measurement from the one it made.

     · The five-trip floor ran on the ACCOUNT, before the fold that turns a
       person's several platform accounts into one row. /api/drivers/directory
       holds 104 people with 5+ bookings over 2026-09-01..09-07; this endpoint
       reported n_peers 97.
     · Muhammad Asif Amir Zada (6640364) has 5 bookings over 3 accounts, none
       reaching 5. He was unranked, and the page printed "5 trips in this
       window, which is fewer than the five a ranking needs".
     · n_peers meant ACCOUNTS in the unranked branch (117 for that same
       window) and PEOPLE in the ranked one (97). Same field, same window.
     · "Trips completed" was count(*) with no completion filter anywhere in
       the query — 95, eight pixels under a Completion tile reading "81 of 95
       completed, 14 did not".

   And two false sentences the percentile could not avoid producing, both
   sampled on 2026-09-06: "Days worked 1 · fleet median 1 · lowest in the
   fleet" in the warn colour (2 of 5 drivers), and "Cancellation rate 66.7% ·
   fleet median 9.1% · lowest in the fleet" — that metric is ranked inverted,
   so percentile 0 is the WORST canceller in the fleet. */
import { standingNote } from '../api/public/ui.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nthe floor is on the person, not on one of their accounts');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  const standing = routes.slice(routes.indexOf("app.get('/api/driver/standing'"),
    routes.indexOf("app.get('/api/driver/territory'"));
  check('the peers query no longer floors before the fold',
    !/GROUP BY 1 HAVING count\(\*\) >= 5/.test(standing),
    'HAVING on a GROUP BY keyed on an account is a floor on the account');
  check('…the floor is applied to the folded population instead',
    /const pop = \[\.\.\.folded\.values\(\)\]\.filter\(\(c\) => c\.trips >= FLOOR\)/.test(standing));
  check('…and it is named, so the response can state the number it used',
    /const FLOOR = 5;/.test(standing) && /peer_floor: FLOOR/.test(standing));
  check('the subject is the folded row, not a second sum of the same numbers',
    /const me = folded\.get\('__me__'\)/.test(standing)
      && !/const wavg = /.test(standing),
    'two implementations of one figure is how a page disagrees with itself');
  check('n_peers is the cohort in BOTH branches',
    !/n_peers: peers\.length/.test(standing),
    'the unranked branch returned the raw account count — 117 against 97');
  check('…and the unranked branch returns the subject’s own count',
    /trips_in_window: me \? me\.trips : 0/.test(standing),
    'so the page states the number the floor was tested against');
  /* Against the whole file, not the slice: the explanatory block sits ABOVE
     the app.get() line the slice starts at, which is where this codebase puts
     the reasoning for a route. */
  check('the measurement that proved it is written down',
    /Five is not fewer than five/.test(routes)
      && /6640364/.test(routes)
      && /104 people with 5 or more/.test(routes));
}

console.log('\na count of bookings is not a count of completions');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  check('the row is no longer labelled "Trips completed"',
    !/label: 'Trips completed'/.test(routes),
    'the measure is count(*) — there is no completion filter in that query');
  check('…it is named for what it counts',
    /\{ key: 'trips', label: 'Bookings', \.\.\.pct\('trips'\) \}/.test(routes));
  check('…and so is the row derived from it',
    /label: 'Bookings a working day'/.test(routes));
  /* The measure is deliberately unchanged: the panel already carries
     Completion rate and Cancellation rate as their own rows, taken over
     outcome, so bookings-taken is the workload rank this row is for. */
  check('completion is still ranked, on its own row, over outcome',
    /\{ key: 'completion', label: 'Completion rate'/.test(routes)
      && /outcome='completed'/.test(routes));
}

console.log('\nthe endpoint returns the size of the tie, because 0 cannot express it');
{
  const routes = readFileSync('api/driver_routes.js', 'utf8');
  check('pct counts how many hold the same value',
    /let tied = 0; for \(const x of vals\) if \(x === v\) tied\+\+;/.test(routes));
  check('…and returns it with the population it was counted over',
    /tied, population: vals\.length/.test(routes));
}

console.log('\nwhat a percentile is allowed to be called');
{
  /* THE TIE. On a one-day window nearly everybody has days_worked 1, so nobody
     is below anybody, so the percentile floors to 0 for the tied majority.
     Measured on production 2026-09-06: "Days worked 1 · fleet median 1", two
     of the five drivers sampled, rendered "lowest in the fleet" in warn. */
  const tie = standingNote({ percentile: 0, value: 1, median: 1, tied: 46, population: 51 });
  check('a value most of the fleet shares is not called the lowest',
    !/lowest|bottom/.test(tie.text), tie.text);
  check('…it is called a tie', /level with most of the fleet/.test(tie.text), tie.text);
  check('…and it is not painted as a failing', tie.tone === null, String(tie.tone));
  check('…the caller is told it is a tie so a bar can decline its colour',
    tie.tied === true);
  const all = standingNote({ percentile: 0, tied: 51, population: 51 });
  check('a value EVERYONE shares says so', /the same as everyone measured/.test(all.text), all.text);

  /* A genuine bottom is still a bottom: one person alone at the lowest value
     must not be softened into a tie. */
  const low = standingNote({ percentile: 0, value: 33.3, median: 90.9, tied: 1, population: 51 });
  check('a real bottom is still reported as one', /bottom of the fleet/.test(low.text), low.text);
  check('…and still carries the warn tone', low.tone === 'warn');
  const top = standingNote({ percentile: 100, tied: 1, population: 51 });
  check('and a real top as one', /top of the fleet/.test(top.text), top.text);
  check('…with the good tone', top.tone === 'good');

  /* THE DIRECTION. cancel is ranked inverted by the server (higher percentile
     = fewer cancellations), so percentile 0 there is the fleet's WORST
     canceller — and "lowest in the fleet" read as the fewest. Production
     2026-09-06 had one at 66.7% against a 9.1% median. The wording is
     rank-relative now, which is true whichever way the metric was oriented. */
  check('the wording never claims a direction the metric may not have',
    !/highest in the fleet|lowest in the fleet/.test(
      [standingNote({ percentile: 0, tied: 1, population: 9 }).text,
        standingNote({ percentile: 100, tied: 1, population: 9 }).text].join(' ')),
    '"lowest in the fleet" over the worst cancellation rate reads as the best');

  check('the middle is still a share, and still faces the right way',
    standingNote({ percentile: 76, tied: 1, population: 9 }).text === 'top 24%'
      && standingNote({ percentile: 24, tied: 1, population: 9 }).text === 'bottom 24%');
  /* A response from before the fix carries neither field: the tie branch
     cannot fire and the phrasing degrades rather than throwing. */
  const old = standingNote({ percentile: 0 });
  check('an older response without the tie fields still renders',
    old.text === 'bottom of the fleet' && old.tied === false);
  check('and a metric with no percentile says nothing at all',
    standingNote({}).text === null);
  check('a lone holder of a value is not a tie, whatever the population',
    standingNote({ percentile: 0, tied: 1, population: 1 }).tied === false);
}

console.log('\nboth shells ask the same helper, so they cannot drift');
{
  const desk = readFileSync('api/public/driver.js', 'utf8');
  const phone = readFileSync('api/public/m/screens.js', 'utf8');
  check('the phone no longer hand-rolls the sentence',
    !/lowest in the fleet/.test(phone) || /standingNote/.test(phone));
  check('…it calls the shared helper', /standingNote\(m\)/.test(phone));
  check('the desktop bar declines its colour on a tie',
    /const tone = sn\.tied \? '--s1'/.test(desk),
    'a tied value was painted --critical, the colour of the worst thing on the page');
  check('…and says why on hover',
    /hold this same value, so the/.test(desk));
  check('the panel subtitle no longer carries its own copy of the floor',
    !/5 or more trips in this window/.test(desk),
    'a number the response cannot reach is a number that goes stale silently');
  check('…the floor is stated once, from the endpoint',
    /st\.peer_floor \? `\$\{fmt\(st\.peer_floor\)\} or more` : 'five or more'/.test(desk));
  check('the unranked sentence uses the count the floor was tested against',
    /st\.trips_in_window \?\? k\.trips/.test(desk),
    'it printed kpis.trips beside a floor applied at a different grain');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
