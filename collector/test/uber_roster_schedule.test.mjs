/* The whole-roster timeline ask, and the sweep that had no schedule.
   ──────────────────────────────────────────────────────────────────────────
   src/sources/uber_timeline.js asks Uber once per driver per window, and the
   scheduled tick asked only about drivers who took a trip in the last two
   days. The reason recorded for that was "asking about the other 143 buys a
   timeline that is empty by construction — they were not working".

   A driver who comes online at 07:00 and is offered nothing has an ONLINE
   event and no trip. "No trip" is not "not working", and refusing exactly that
   inference is why the Online time page exists. Measured on production: 1 to 6
   drivers a day are online having taken no trip among the ones the narrow set
   reached, and 39 a day could not be reached at all — under a page sentence
   saying none is coming "until somebody runs the roster sweep". That sweep had
   no cron and last ran 2026-08-27.

   The cost was never the obstacle. MAX_WINDOW_DAYS is 30, so a window of up to
   a month is ONE request per driver: a two-day whole-roster ask costs the same
   ~280 requests as the thirty-day sweep, which wrote 132,038 rows with its two
   fleet runs finishing 97 seconds apart. */
import { readFileSync } from 'node:fs';
import { MAX_WINDOW_DAYS, windows } from '../src/sources/uber_timeline.js';
import { SETTING_DEFAULTS as DEFAULTS, SETTING_DEFS } from '../src/settings.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const strip = (f) => readFileSync(f, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const index = strip('src/index.js');

/* ── the three-hourly tick asks about everyone ──────────────────────────── */
check('the scheduled timeline tick asks about the whole roster',
  /uberTimelineCron, \(\) => uberTimelineTick\(\{ roster: true \}\)/.test(index));
check('…over the short window, so it is the cheap ask and not the deep one',
  !/uberTimelineCron[\s\S]{0,120}days:/.test(index),
  'the three-hourly tick must not carry a 30-day window');

/* ── the sweep has a schedule at all, which is the whole point ──────────── */
check('the whole-roster sweep is on a cron rather than waiting for somebody to run it',
  /uberRosterCron, \(\) => uberTimelineTick\(\{ roster: true, days: 30 \}\)/.test(index));
check('and the cron is a real five-field expression, weekly',
  /^\d+ \d+ \* \* [0-6]$/.test(DEFAULTS.UBER_ROSTER_CRON), DEFAULTS.UBER_ROSTER_CRON);
check('it is settable, so a fleet that needs it more often does not need a deploy',
  SETTING_DEFS.some((d) => d.key === 'UBER_ROSTER_CRON' && d.secret === false));
check('…and the setting explains what the deep pass is for',
  /31-day window|window slides/.test(
    SETTING_DEFS.find((d) => d.key === 'UBER_ROSTER_CRON')?.help || ''));

/* ── the two schedules must not collide ─────────────────────────────────── */
{
  const at = (c) => { const [m, h] = c.split(' '); return `${h}:${m}`; };
  check('the sweep does not start in the same minute as a timeline tick',
    at(DEFAULTS.UBER_ROSTER_CRON) !== at(DEFAULTS.UBER_TIMELINE_CRON),
    `${DEFAULTS.UBER_ROSTER_CRON} vs ${DEFAULTS.UBER_TIMELINE_CRON}`);
  /* 02:40 Dubai is the full re-collection — src/index.js. A two-minute sweep
     landing inside it would have both competing for the same Uber session. */
  check('nor in the same hour as the nightly full re-collection',
    DEFAULTS.UBER_ROSTER_CRON.split(' ')[1] !== '22',
    DEFAULTS.UBER_ROSTER_CRON);
}

/* ── the cost claim the change rests on ─────────────────────────────────── */
check('a month-long window is a single request per driver, which is why the sweep is cheap',
  MAX_WINDOW_DAYS === 30
    && windows(new Date('2026-08-01'), new Date('2026-08-31')).length === 1,
  String(windows(new Date('2026-08-01'), new Date('2026-08-31')).length));
check('…and a two-day window is no cheaper per driver than a month',
  windows(new Date('2026-08-01'), new Date('2026-08-03')).length
    === windows(new Date('2026-08-01'), new Date('2026-08-31')).length);
/* Past a month it does chunk, which is what makes the 30-day sweep the largest
   single-request pass available rather than an arbitrary number. */
check('past a month it chunks, so 30 days is the most one ask can cover',
  windows(new Date('2026-07-01'), new Date('2026-08-31')).length > 1);

/* ── the button and the schedule must do the same thing ─────────────────── */
{
  /* An operator can trigger a timeline run from Settings. It called
     `uberTimelineTick()` — the narrow set — so pressing it gave a different
     answer from the cron that had run twenty minutes earlier, and the person
     would reasonably conclude the schedule was broken rather than the button. */
  check('the on-demand timeline job makes the same ask as the cron',
    /job\.mode === 'timeline'\) await uberTimelineTick\(\{ roster: true \}\)/.test(index));
  check('and the command-line timeline does too, so all three agree',
    /cmd === 'timeline'\) return uberTimelineTick\(\{ roster: true \}\)/.test(index));
  check('and the deep sweep stays a separate, explicit job',
    /job\.mode === 'timeline-roster'\) await uberTimelineTick\(\{ roster: true, days: 30 \}\)/
      .test(index));
}

/* ── the narrow mode survives as the documented fallback ────────────────── */
{
  const src = readFileSync('src/sources/uber_timeline.js', 'utf8');
  check('the narrow ask is still reachable, being the fallback if Uber refuses',
    /roster = false/.test(strip('src/sources/uber_timeline.js')));
  /* Whitespace-tolerant: the sentence is wrapped in the source, and an
     assertion that only matches one line width fails on a reflow rather than
     on a change of meaning. The file still QUOTES the old premise — the point
     of the note is that it used to read that way — so what is asserted is that
     the rebuttal is there beside it. */
  check('and the file no longer claims an unasked driver was not working',
    /THAT PREMISE IS WRONG/.test(src)
      && /"No\s+trip" is not "not working"/.test(src)
      && !/at two thirds of the request budget/.test(src));
  check('the fallback is named where the decision is made, not left to be rediscovered',
    /IF UBER STARTS REFUSING/.test(readFileSync('src/index.js', 'utf8')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
