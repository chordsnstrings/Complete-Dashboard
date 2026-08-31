/* Proving the past, rather than counting our own rows.
   ─────────────────────────────────────────────────────────────────────────
   /api/coverage/calendar reports 239,236 Uber trips over 376 days, gaps: [],
   missing_days: 0 — and it is measuring our own table. It catches a day that
   went missing entirely and cannot see a day we collected a tenth of, because
   that day has rows too.

   The measurement that made this worth building: trips per active driver per
   day fall from 10.0 in February 2026 to 3.4 in March, and the fall happens in
   the same month, by the same three quarters, in BOTH fleets — two separate
   businesses on two separate Uber orgs. Ecosine 17,385 -> 4,203, Egari
   8,052 -> 1,862. A calendar that counts our rows called that year complete.

   So the audit re-asks Uber. What is pinned here is the arithmetic and the
   four judgements inside it, each of which is a way the comparison could be
   confidently wrong:

     a Dubai day on one side and a UTC day on the other invents a discrepancy
     a midnight boundary is a disagreement about a trip, not an invented trip
     an error from Uber is a different answer from zero rows
     a verification that writes cannot report a failure it caused
*/
import { readFileSync } from 'node:fs';
import { compareTripSets, applyMisfiled } from '../src/sources/uber.js';
import { auditWindows, nextAuditWindows } from '../src/run.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const t = (id, at) => ({ external_id: id, requested_at: at });
const our = (id, day) => ({ external_id: id, day });

console.log('\nthe arithmetic of agreement');

{
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T08:00:00+04:00'), t('b', '2026-03-01T20:00:00+04:00')],
    ourRows: [our('a', '2026-03-01'), our('b', '2026-03-01')],
    lo: '2026-03-01', hi: '2026-03-01',
  });
  check('a window we hold completely agrees at 100%',
    r.uber_only === 0 && r.ours_only === 0 && r.agreement_pct === 100, JSON.stringify(r));
  check('and reports the same count on both sides', r.uber_rows_in_window === 2 && r.ours === 2);
}

{
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T08:00:00+04:00'), t('b', '2026-03-01T09:00:00+04:00'),
      t('c', '2026-03-01T10:00:00+04:00'), t('d', '2026-03-01T11:00:00+04:00')],
    ourRows: [our('a', '2026-03-01')],
    lo: '2026-03-01', hi: '2026-03-01',
  });
  check('a window we hold a quarter of says so, in the number that matters',
    r.uber_only === 3 && r.in_both === 1 && r.agreement_pct === 25, JSON.stringify(r));
  check('and names the trips, so the finding can be checked rather than believed',
    r.sample_missing.length === 3 && r.sample_missing.includes('c'));
  check('the day breakdown carries the shortfall on the day it happened',
    r.days.length === 1 && r.days[0].uber === 4 && r.days[0].ours === 1 && r.days[0].missing === 3,
    JSON.stringify(r.days));
}

console.log('\nthe two ways this comparison lies');

{
  /* 2026-03-01T02:00+04:00 is 2026-02-28T22:00Z. Slicing the UTC form would
     put this trip in February and report it missing from a March audit that
     holds it. */
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T02:00:00+04:00')],
    ourRows: [our('a', '2026-03-01')],
    lo: '2026-03-01', hi: '2026-03-01',
  });
  check('a 2am Dubai trip is a Dubai day, not the UTC day before',
    r.uber_rows_in_window === 1 && r.uber_only === 0,
    'the CSV is already Dubai wall-clock; converting it again moves four hours of every day');
}

{
  /* Uber's report window and our stored day disagree about one trip at the
     edge. We hold it; Uber's answer for THIS window does not list it in the
     window but does list it. That is a boundary disagreement. */
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T08:00:00+04:00'), t('edge', '2026-02-28T23:50:00+04:00')],
    ourRows: [our('a', '2026-03-01'), our('edge', '2026-03-01')],
    lo: '2026-03-01', hi: '2026-03-01',
  });
  check('a trip on the wrong side of a midnight is not an invented row',
    r.ours_only === 0, 'compared against the whole report, not the in-window slice');
  check('and the report saying more than we asked for is reported, not hidden',
    r.uber_rows_outside_window === 1);
}

{
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T08:00:00+04:00')],
    ourRows: [our('a', '2026-03-01'), our('ghost', '2026-03-01')],
    lo: '2026-03-01', hi: '2026-03-01',
  });
  check('a row we hold that Uber does not report at all IS counted as ours only',
    r.ours_only === 1, JSON.stringify(r));
}

{
  const r = compareTripSets({ theirs: [], ourRows: [], lo: '2025-01-01', hi: '2025-01-31' });
  check('a window neither side has is not 100% agreement',
    r.agreement_pct === null, 'nothing over nothing is unknown, and unknown must not read as verified');
}

console.log('\nthe judgements in the collector');

const code = readFileSync('src/sources/uber.js', 'utf8');
const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const probe = readFileSync('api/probe.js', 'utf8');
const bareProbe = probe.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

check('the audit reads the same report type the backfill writes from',
  /reportType: 'REPORT_TYPE_TRIP_ACTIVITY'/.test(bare)
  && /const id = await generateReport\(from, to\);/.test(bare),
  'auditing a different surface would prove nothing about the one we collect');
check('it compares against OUR rows for the same fleet, not the whole table',
  /WHERE platform = 'uber' AND fleet_id = \$1/.test(bare),
  'the two fleets are two orgs; one report can only answer for one of them');
check('it slices our side by the Dubai day, exactly as the report is dated',
  /\(requested_at AT TIME ZONE 'Asia\/Dubai'\)::date BETWEEN \$2::date AND \$3::date/.test(bare));
const auditBody = (() => {
  const i = bare.indexOf('export async function auditTripWindow');
  return i < 0 ? '' : bare.slice(i, bare.indexOf('\n}\n', i) + 3);
})();
check('the audit function is where the test says it is', auditBody.length > 400);
check('it writes nothing',
  auditBody.length > 400 && !/upsertMany|INSERT INTO|UPDATE \w|DELETE FROM/i.test(auditBody),
  'a verification that repairs what it measures can never report a failure');
check('an error is kept apart from an empty answer',
  /entry\.past_retention = \/invalid date range\|retention\|out of range\/i\.test\(msg\)/.test(bare),
  'Uber refusing a window and Uber serving an empty one mean opposite things');
check('the org it borrows is put back, so an audit cannot redirect a collection',
  /const prev = cur;/.test(bare) && /finally \{ cur = prev; \}/.test(bare));

console.log('\nthe judgements at the endpoint');

check('a window longer than the gateway will wait for is refused before a report is spent',
  /if \(days > 8\)/.test(bareProbe),
  'a monthly report outlives 75 seconds and would read as a provider failure');
check('the endpoint totals the fleets as well as listing them',
  /agreement_pct: num\('uber_rows_in_window'\)/.test(bareProbe),
  'a reader who has to add two numbers will add them wrong on the audit that matters');
check('and says out loud what it does NOT verify',
  /verifies: 'trips only, for this window/.test(probe),
  'money has a 192-day horizon and rating has no history at all; one green tick must not imply three');

console.log('\nwhich windows a nightly run picks, and in what order');

const iso = (d) => d.toISOString().slice(0, 10);
const W = auditWindows(new Date('2026-08-31T09:00:00Z'));

check('it walks whole calendar months back to Uber retention edge',
  W.filter((w) => w.kind === 'month').length === 13);
check('a month window is the whole month, last day included',
  W.some((w) => iso(w.from) === '2026-07-01' && iso(w.to) === '2026-07-31')
  && W.some((w) => iso(w.from) === '2026-02-01' && iso(w.to) === '2026-02-28'),
  'day 0 of the next month, so February is 28 or 29 without a table of month lengths');
check('the newest month it verifies is the last COMPLETE one',
  iso(W[0].from) === '2026-07-01' && iso(W[0].to) === '2026-07-31',
  'the current month is still being collected and would disagree every night for no reason');
check('and it reaches back a full year',
  W.some((w) => iso(w.from) === '2025-08-01'), 'trip retention is about twelve months');

const weeks = W.filter((w) => w.kind === 'week');
check('it also verifies whole Mon-Sun weeks, so the recent past does not wait for a month to end',
  weeks.length >= 3 && weeks.length <= 4, String(weeks.length));
check('a week window starts on a Monday and ends on the Sunday',
  weeks.every((w) => w.from.getUTCDay() === 1 && w.to.getUTCDay() === 0),
  weeks.map((w) => iso(w.from) + '..' + iso(w.to)).join(' '));
/* Asked on Monday 2026-08-31, the last complete week is Aug 24-30, which
   ended YESTERDAY. It is deliberately not audited: Uber's report would list
   trips the half-hourly incremental has not reached yet, and this would print
   that lag as trips we never stored. */
check('a window that ended in the last two days is left to settle',
  iso(weeks[0].to) === '2026-08-23',
  iso(weeks[0].from) + '..' + iso(weeks[0].to)
  + ' — a false accusation with the confidence of a count is worse than a day of delay');
check('and the settle rule does not swallow whole months, which are old enough already',
  iso(W[0].to) === '2026-07-31');
check('every window has fixed dates, so re-verifying updates a row instead of adding one',
  W.every((w) => iso(w.to) < '2026-08-31'),
  'a window ending "yesterday" leaves a new primary key every day and a history of nothing');

{
  const none = new Map();
  const picked = nextAuditWindows(W, none, 3);
  check('with nothing verified it starts at the most recent past, not the oldest',
    iso(picked[0].from) === '2026-07-01',
    'the first runs must answer for the months anyone is actually looking at');
  check('and it takes only the run budget, not the whole calendar',
    picked.length === 3, 'each window costs one Uber report and minutes of a shared slot');
}

{
  const seen = new Map(W.map((w, i) => [iso(w.from) + '..' + iso(w.to), 2000 + i]));
  const picked = nextAuditWindows(W, seen, 2);
  check('once everything is verified it re-verifies the stalest first',
    picked.length === 2 && seen.get(iso(picked[0].from) + '..' + iso(picked[0].to)) === 2000,
    'a month that agreed in September and stops agreeing in November must be caught, not assumed');
}

{
  const seen = new Map([['2026-07-01..2026-07-31', 9e12]]);
  const picked = nextAuditWindows(W, seen, 2);
  check('a window never asked about beats one verified an hour ago',
    !picked.some((w) => iso(w.from) === '2026-07-01'),
    'not verified and verified fine are different answers, and the unasked one is worth more');
}

const runjs = readFileSync('src/run.js', 'utf8');
const bareRun = runjs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const auditTick = bareRun.slice(bareRun.indexOf('export async function uberAuditTick'));
check('the nightly verification writes to its own table and never to trip',
  /INSERT INTO uber_trip_audit/.test(auditTick) && !/INSERT INTO trip|upsertMany\('trip'/.test(auditTick),
  'a verification that repairs what it measures can never report a failure');
check('it checkpoints per window, because a deploy mid-audit must not respend the slots',
  /ckpt\.has\(unit\)/.test(auditTick) && /ckpt\.mark\(unit/.test(auditTick));
check('a window that could not be read from past audits re-verifies rather than being skipped',
  /could not read past audits/.test(runjs));

console.log('\na trip under the other fleet\u2019s name is not a trip we lost');

{
  /* trip's primary key is (platform, external_id) and fleet_id is an ordinary
     column the upsert overwrites, so a trip both orgs can see ends up filed
     under whichever collected last. The fleet-filtered query does not find it,
     and without this correction it is reported as a booking Uber has and we do
     not — on the one panel whose whole claim is that its numbers are not our
     own opinion of ourselves. */
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T08:00:00+04:00'), t('b', '2026-03-01T09:00:00+04:00'),
      t('c', '2026-03-02T10:00:00+04:00')],
    ourRows: [our('a', '2026-03-01')],
    lo: '2026-03-01', hi: '2026-03-02',
  });
  check('before the check, everything absent from this fleet counts as lost',
    r.uber_only === 2 && r.agreement_pct === 33.3, JSON.stringify(r));

  const moved = applyMisfiled(r, new Set(['b']));
  check('a trip held under the other fleet moves out of the loss column',
    moved === 1 && r.uber_only === 1 && r.in_both === 2);
  check('and the agreement is recomputed, not left stale',
    r.agreement_pct === 66.7, String(r.agreement_pct));
  check('the day it was wrongly blamed on is corrected too',
    r.days.find((d) => d.day === '2026-03-01').missing === 0
    && r.days.find((d) => d.day === '2026-03-01').misfiled === 1
    && r.days.find((d) => d.day === '2026-03-02').missing === 1,
    JSON.stringify(r.days));
  check('and it is dropped from the evidence, so a checkable id is really missing',
    !r.sample_missing.includes('b') && r.sample_missing.includes('c'),
    JSON.stringify(r.sample_missing));
}

{
  const r = compareTripSets({
    theirs: [t('a', '2026-03-01T08:00:00+04:00')],
    ourRows: [],
    lo: '2026-03-01', hi: '2026-03-01',
  });
  check('finding nothing under another fleet changes nothing',
    applyMisfiled(r, new Set()) === 0 && r.uber_only === 1 && r.agreement_pct === 0);
}

check('the collector asks the trip table again with no fleet filter before believing a loss',
  /AND fleet_id IS DISTINCT FROM \$2/.test(bare),
  'the same query that produced the finding cannot also test it');
check('and a failure of that second query reports unknown, not zero',
  /misfiled = null;/.test(bare),
  'calling every missing id lost because a check failed is the overstatement the check exists to prevent');

console.log('\ntwo grains in one table, and the sum that would double-count them');

const analytics = readFileSync('api/analytics_routes.js', 'utf8');
const verified = analytics.slice(analytics.indexOf("app.get('/api/coverage/verified'"),
  analytics.indexOf("app.get('/api/coverage/verified'") + 4000);
const schema47 = readFileSync('sql/schema_v47.sql', 'utf8');

check('a verified window records which grain it is',
  /kind\s+TEXT NOT NULL DEFAULT 'month'/.test(schema47)
  && /kind = EXCLUDED\.kind/.test(bareRun),
  'a week window sits inside a month window and nothing else in the row says so');
check('trips are totalled over whole months alone',
  /const months = measured\.filter\(\(r\) => r\.kind !== 'week'\)/.test(verified)
  && /const sum = \(k\) => months\.reduce/.test(verified),
  'summing a week and the month containing it counts every trip in that week twice, '
  + 'and divides the agreement percentage by a doubled denominator');
check('but a week that disagrees is still counted as a finding',
  /const disagreeing = measured\.filter/.test(verified),
  'dropping the weeks from the counts would hide the most recent disagreement there is');
check('the response says which population its totals are over',
  /totals_over:/.test(verified),
  'a reader of the JSON must not have to infer that the totals skip rows it just received');
check('a week that rolls out of the grid is retired rather than frozen',
  /DELETE FROM uber_trip_audit/.test(bareRun) && /kind = 'week'/.test(bareRun),
  'nothing else would ever remove it, and a Checked date that stops moving reads as still watched');
check('the audit keeps two fields per trip, not the whole CSV record',
  /\.map\(\(t\) => \(\{ external_id: t\.external_id, requested_at: t\.requested_at \}\)\)/.test(bare),
  'csvToTrips keeps raw: r on every row, and twenty thousand of those is the shape '
  + 'that has already OOM-killed this 512MB box once');

check('the verified endpoint is never served from the cache',
  /'\/api\/coverage\/verified'/.test(readFileSync('api/cache.js', 'utf8'))
  && /'\/api\/coverage\/verified'/.test(readFileSync('api/public/swr.js', 'utf8')),
  'the cache invalidates on a collection run and the audit is neither — measured on production, '
  + 'six months landed at 100% agreement and the endpoint went on reporting zero windows');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
