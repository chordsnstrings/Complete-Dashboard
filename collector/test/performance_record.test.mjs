/* One driver against their own record — and the four ways that goes wrong.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked for driver performance week by week and month by month,
   "out of the active drivers what was their position, and whether it got
   better or worse", and then said what the subject is: "it's a performance
   difference of the solo driver not comparison between the fleet drivers."

   Four things have to hold or the page lies in a way nobody can see:

   1. A DAY IS A DAY. A person working two platform accounts on one Dubai day
      has two sets of trip rows. The first draft of periodsSql expanded the
      per-day platform array in the FROM clause of the period aggregate —
      FROM day, LATERAL unnest(platforms) AS p — which multiplied every count,
      every sum and the active-day denominator by the number of channels that
      person works. A doubled count is a plausible-looking number, so nothing
      about it would have looked wrong.

   2. AN ACTIVE DAY IS A DAY THEY ACCEPTED WORK. trip_norm.is_booking is
      (platform <> 'fms') with no outcome filter, so a Bolt broadcast offer is
      a booking; counting days with any booking would mean AVAILABILITY on Bolt
      and DISPATCH on Uber, and put the 64%-against-15% artefact measured in
      docs/COVERAGE.md straight back into the denominator.

   3. A FLEET-WIDE MOVE IS NOT A PERSON'S MOVE. Eid, a fortnight of rain and a
      competitor's promotion move everybody at once. Two drivers whose raw
      change is identical must get OPPOSITE verdicts when one moved with the
      fleet and the other did not — that is the whole point of the fleet term,
      and the fixture below is built so that they do.

   4. A PERIOD THAT HAS NOT FINISHED IS NOT COMPARED. Every dashboard that has
      ever drawn a week-on-week arrow has told everybody they were down on a
      Tuesday morning.

   The fixture is positioned relative to TODAY rather than on fixed dates, so
   the suite means the same thing in November as it does today. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { periodSeries, periodEnd } from '../api/performance_sql.js';
import { dubaiIso } from '../src/util.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* Seven weeks ending with the one now in progress. w[5] is the last COMPLETE
   week — the one the fleet route judges by default — and its baseline is
   w[1] to w[4]. */
const W = periodSeries('week', dubaiIso(), 7);
const plus = (iso, n) => new Date(new Date(`${iso}T12:00:00Z`).getTime() + n * 864e5)
  .toISOString().slice(0, 10);

let seq = 0;
const trip = async (platform, drv, status, dayIso, n = 1, price = null) => {
  for (let i = 0; i < n; i++) {
    await q(
      `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                         requested_at, ended_at, status, distance_km, price)
       VALUES ($1, $2, 'ecosine', $3, $4, $5, $6, $6, $7, 9, $8)`,
      [platform, `t${++seq}`, `L-${drv}`, drv, `Driver ${drv}`,
        `${dayIso}T12:00:00+04:00`, status, price]);
  }
};

/* ── 1. one person, two channels, ONE day ───────────────────────────────── */
await trip('uber', 'TWOPLAT', 'completed', plus(W[5], 0), 3, 40);
await trip('bolt', 'TWOPLAT', 'finished', plus(W[5], 0), 2, 30);

/* ── 2. a Bolt driver who was OFFERED work on a day and took none ────────── */
await trip('bolt', 'OFFERED', 'optional_ride_driver_did_not_respond', plus(W[5], 1), 4);
await trip('bolt', 'OFFERED', 'finished', plus(W[5], 3), 2, 25);

/* ── 3. the fleet term: two identical falls, two different verdicts ──────── */
/* Twelve filler drivers hold 5 jobs a day over 6 days in every baseline week
   and 2 a day in w[5]. That IS the fleet halving, and it is what a driver's
   own fall has to be measured against. */
for (let d = 0; d < 12; d++) {
  for (let wk = 1; wk <= 4; wk++) {
    for (let dd = 0; dd < 6; dd++) await trip('uber', `FILL${d}`, 'completed', plus(W[wk], dd), 5, 50);
  }
  for (let dd = 0; dd < 6; dd++) await trip('uber', `FILL${d}`, 'completed', plus(W[5], dd), 2, 50);
}
/* MOVER falls with them, exactly in step. HELD does not fall at all. Their raw
   changes are opposite; their verdicts must be too, and neither is the sign of
   the raw change on its own. */
for (let wk = 1; wk <= 4; wk++) {
  for (let dd = 0; dd < 6; dd++) {
    await trip('uber', 'MOVER', 'completed', plus(W[wk], dd), 5, 50);
    await trip('uber', 'HELD', 'completed', plus(W[wk], dd), 5, 50);
  }
}
for (let dd = 0; dd < 6; dd++) {
  await trip('uber', 'MOVER', 'completed', plus(W[5], dd), 2, 50);
  await trip('uber', 'HELD', 'completed', plus(W[5], dd), 5, 50);
}

/* ── 3b. a driver with a GAP in the middle of their record ───────────────── */
/* Works W1, W2 and W4 and takes W3 off entirely. W3 is the case that matters:
   a period with no active day, sitting BETWEEN periods they worked, so it is a
   rest week rather than a period before they existed. Every quantity in the
   comparison is per active day, so this period has to refuse a verdict and say
   which kind of blank it is. Held at the fillers' own 5 a day so it does not
   move the fleet medians the assertions above depend on. */
for (const wk of [1, 2, 4]) {
  for (let dd = 0; dd < 6; dd++) await trip('uber', 'GAP', 'completed', plus(W[wk], dd), 5, 50);
}

/* ── 4. the two positions must be able to DISAGREE ───────────────────────── */
/* SHORTHOP does many cheap jobs; LONGHAUL does few expensive ones. If the page
   ever blends them into one rank, this pair stops being separable. */
for (let dd = 0; dd < 6; dd++) await trip('uber', 'SHORTHOP', 'completed', plus(W[5], dd), 10, 12);
for (let dd = 0; dd < 6; dd++) await trip('hotel', 'LONGHAUL', 'completed', plus(W[5], dd), 2, 400);

/* ── 5. a driver whose fares have not arrived ────────────────────────────── */
await trip('uber', 'UNPRICED', 'completed', plus(W[5], 0), 8, null);
await trip('uber', 'UNPRICED', 'completed', plus(W[5], 1), 2, 60);

/* ── 6. somebody in their very first week ────────────────────────────────── */
for (let dd = 0; dd < 4; dd++) await trip('uber', 'ROOKIE', 'completed', plus(W[5], dd), 6, 45);

/* ── 7. work inside the week still running ───────────────────────────────── */
await trip('uber', 'HELD', 'completed', plus(W[6], 0), 4, 50);

const { server, get } = await mountAll(db);
const J = async (u) => (await get(u)).body;

/* ─────────────────────────── the driver record ─────────────────────────── */
const rec = await J('/api/performance/driver?id=TWOPLAT&grain=week&periods=7');
const at = (b, iso) => b.periods.find((p) => p.period === iso);
const twoplat = at(rec, W[5]);

check('two channels on one Dubai day is ONE active day, not two',
  twoplat?.active_days === 1, JSON.stringify([twoplat?.active_days, twoplat?.platforms]));
check('…and the jobs are counted once, not once per channel',
  twoplat?.completed === 5 && twoplat?.bookings === 5,
  JSON.stringify([twoplat?.completed, twoplat?.bookings]));
check('…while both channels are still named on the row',
  (twoplat?.platforms || []).slice().sort().join(',') === 'bolt,uber',
  JSON.stringify(twoplat?.platforms));
check('and the trip value adds both channels once each',
  Number(twoplat?.value) === 3 * 40 + 2 * 30, String(twoplat?.value));

const offered = at(await J('/api/performance/driver?id=OFFERED&grain=week&periods=7'), W[5]);
check('a day of offers nobody took is not an active day',
  offered?.active_days === 1 && offered?.offered_only_days === 1,
  JSON.stringify([offered?.active_days, offered?.offered_only_days]));
check('…and the offers are not counted as work accepted',
  offered?.accepted === 2 && offered?.declined === 4,
  JSON.stringify([offered?.accepted, offered?.declined]));

/* ── the verdicts ───────────────────────────────────────────────────────── */
const mover = at(await J('/api/performance/driver?id=MOVER&grain=week&periods=7'), W[5]);
const held = at(await J('/api/performance/driver?id=HELD&grain=week&periods=7'), W[5]);

check('the fleet term is measured, not assumed',
  mover?.judgement?.verdict?.fleet?.measured === true
    && mover.judgement.verdict.fleet.factor < 0.6,
  JSON.stringify(mover?.judgement?.verdict?.fleet));
check('a driver who fell exactly as far as the whole fleet did is NOT marked down',
  mover?.judgement?.verdict?.changed === false,
  JSON.stringify([mover?.completed, mover?.judgement?.verdict?.expected, mover?.judgement?.verdict?.z]));
check('…and one who held level while the fleet fell IS marked up',
  held?.judgement?.verdict?.changed === true && held.judgement.verdict.direction === 'up',
  JSON.stringify([held?.completed, held?.judgement?.verdict?.expected, held?.judgement?.verdict?.z]));
check('the two drivers moved in opposite directions on the same raw numbers',
  mover.completed < held.completed && mover.judgement.verdict.changed === false,
  `${mover.completed} vs ${held.completed}`);

/* The split has to account for the whole change, with nothing left over — the
   property splitChange() is built for and the reason it is symmetric. */
const sp = mover.judgement.verdict.split;
check('the days part and the intensity part add up to the whole change',
  Math.abs((sp.days_part + sp.rate_part) - sp.total) < 0.15,
  JSON.stringify(sp));
check('…and a fall with no change in days worked is charged entirely to intensity',
  Math.abs(sp.days_part) < 0.01 && sp.rate_part < 0, JSON.stringify(sp));

/* ── positions ──────────────────────────────────────────────────────────── */
const shorthop = at(await J('/api/performance/driver?id=SHORTHOP&grain=week&periods=7'), W[5]);
const longhaul = at(await J('/api/performance/driver?id=LONGHAUL&grain=week&periods=7'), W[5]);
check('the jobs position and the value position are separate numbers',
  shorthop.jobs_position.rank < longhaul.jobs_position.rank
    && longhaul.value_position.rank < shorthop.value_position.rank,
  JSON.stringify([shorthop.jobs_position, shorthop.value_position,
    longhaul.jobs_position, longhaul.value_position]));
check('…out of the same population of active drivers, named on the row',
  shorthop.jobs_position.of === longhaul.jobs_position.of && shorthop.jobs_position.of > 10,
  String(shorthop.jobs_position.of));

const unpriced = at(await J('/api/performance/driver?id=UNPRICED&grain=week&periods=7'), W[5]);
check('a driver whose fares have not arrived gets NO value position',
  unpriced.value_position === null && unpriced.value_rankable === false,
  JSON.stringify(unpriced.value_position));
check('…and the reason names the shortfall rather than leaving a blank',
  /2 of 10 completed/.test(unpriced.value_absent || ''), String(unpriced.value_absent));
check('…while their jobs position is unaffected, because a count is complete',
  unpriced.jobs_position && unpriced.jobs_position.of > 10, JSON.stringify(unpriced.jobs_position));

/* ── the refusals ───────────────────────────────────────────────────────── */
const rookie = at(await J('/api/performance/driver?id=ROOKIE&grain=week&periods=7'), W[5]);
check('a driver in their first period is given no verdict',
  rookie.judgement.verdict === null, JSON.stringify(rookie.judgement));
check('…and the reason is the true one, not "not enough data"',
  /first week they appear in/.test(rookie.judgement.absent || ''), String(rookie.judgement.absent));

/* A period they did no work in is a FACT, not a verdict of "no change".
   Every quantity in the comparison is per active day, so a period with none
   makes the expectation zero — and a verdict shape with a null direction reads
   on screen as "level", for somebody who was not there. */
{
  const gap = await J('/api/performance/driver?id=GAP&grain=week&periods=7');
  const idle = at(gap, W[3]);
  check('a rest period between two worked ones gets no verdict',
    idle.judgement.verdict === null && idle.completed === 0 && idle.active_days === 0,
    JSON.stringify([idle.completed, idle.active_days, idle.judgement.verdict]));
  check('…and the reason is that they accepted no work, not that nothing changed',
    /accepted no work in this week/.test(idle.judgement.absent || ''),
    String(idle.judgement.absent));
  /* And it is NOT confused with a period before they existed, which is a
     different sentence about a different thing. */
  check('…which is a different sentence from the period before they first appear',
    /first week they appear in/.test(at(gap, W[0]).judgement.absent || ''),
    String(at(gap, W[0]).judgement.absent));
  /* The week AFTER the gap is judged, and its baseline is the weeks they
     worked — the rest week lowers their usual DAYS without touching their
     usual pace, which is the whole reason the two are split. */
  const after = at(gap, W[4]);
  check('the period after a rest week is still judged, against a baseline that includes it',
    !!after.judgement.verdict && after.judgement.verdict.baseline.worked === 2
      && after.judgement.verdict.baseline.periods === 3,
    JSON.stringify(after.judgement.verdict?.baseline));
}
{
  /* …and on an offer channel the same blank is a different fact, because Bolt
     files the offers nobody took and Uber cannot. */
  const b = await J('/api/performance/driver?id=OFFERED&grain=week&periods=7');
  const only = b.periods.find((p) => p.offered_only_days > 0 && p.active_days === 0);
  if (only) {
    check('a day of offers nobody took is named in the refusal, where the channel files them',
      /though they were offered some/.test(only.judgement.absent || ''),
      String(only.judgement.absent));
  }
}

const partial = at(await J('/api/performance/driver?id=HELD&grain=week&periods=7'), W[6]);
check('the week still running carries its real figures',
  partial.completed === 4, String(partial.completed));
check('…and no verdict at all, with the days elapsed said out loud',
  partial.judgement.verdict === null && /of 7 days old/.test(partial.judgement.absent || ''),
  String(partial.judgement.absent));

/* ── the fleet view ─────────────────────────────────────────────────────── */
const fleet = await J('/api/performance/fleet?grain=week&periods=7');
check('the fleet page judges the last COMPLETE period by default',
  fleet.period === W[5] && fleet.period_complete === true,
  `${fleet.period} vs ${W[5]}`);
check('the threshold rises with the number of people tested',
  fleet.movement.threshold > 2 && fleet.movement.tested > 10,
  JSON.stringify(fleet.movement));
check('and the page carries the sentence that explains the threshold',
  /one-in-twenty spread across all of them/.test(fleet.movement.why || ''));
const fleetHeld = fleet.rows.find((r) => r.driver_ext_id === 'HELD');
check('the fleet row and the driver page agree on the same number',
  fleetHeld.completed === held.completed && fleetHeld.jobs_position.rank === held.jobs_position.rank,
  JSON.stringify([fleetHeld.completed, held.completed]));
check('a driver with no accepted work is not ranked at the bottom of the column',
  fleet.rows.every((r) => r.active_days > 0), 'an inactive driver reached the table');

/* The period totals the chart is drawn from must be the same rows. */
const w5 = fleet.periods.find((p) => p.period === W[5]);
check('the per-period summary counts the same drivers the table holds',
  w5.drivers === fleet.rows.length, `${w5.drivers} vs ${fleet.rows.length}`);
check('the current period is marked incomplete on the series too',
  fleet.periods.find((p) => p.period === W[6]).complete === false);

/* ── the month grain is the same machine ────────────────────────────────── */
const mo = await J('/api/performance/driver?id=TWOPLAT&grain=month&periods=4');
check('month grain answers with month starts and the same shape',
  mo.grain === 'month' && mo.periods.length === 4
    && mo.periods.every((p) => /-01$/.test(p.period)),
  JSON.stringify(mo.periods.map((p) => p.period)));
check('…and the end of each month is the last day of it',
  mo.periods.every((p) => p.end === periodEnd('month', p.period)),
  JSON.stringify(mo.periods.map((p) => [p.period, p.end])));

/* ── an unknown id is a 404, and a known one with no work is not ─────────── */
const missing = await get('/api/performance/driver?id=NOBODY-AT-ALL');
check('an id nothing has ever seen is a 404, not an empty success',
  missing.status === 404, String(missing.status));

/* ── the scan happens once per grain, not once per period ────────────────
   The response cache keys on the whole URL, so every one of the thirteen
   period chips is its own key — and the SQL behind all thirteen is identical,
   because only which period gets tabled differs and that is JavaScript over a
   result set already in memory. Measured on production the month grain is a
   nineteen-second scan, so a reader clicking a second chip paid it twice.

   Counted here rather than timed: a timing assertion on a fixture this small
   would pass whether the context were held or not. */
{
  let scans = 0;
  const counting = {
    query: (text, params) => {
      if (/LATERAL unnest/.test(String(text))) scans++;
      return db.query(text, params);
    },
  };
  const m2 = await mountAll(counting);
  await m2.get('/api/performance/fleet?grain=week&periods=7');
  const after1 = scans;
  await m2.get(`/api/performance/fleet?grain=week&periods=7&period=${W[3]}`);
  await m2.get(`/api/performance/fleet?grain=week&periods=7&period=${W[4]}`);
  await m2.get('/api/performance/driver?id=HELD&grain=week&periods=7');
  check('the first request scans trip_norm', after1 === 1, String(after1));
  check('…and three more requests at the same grain do not scan again',
    scans === 1, `${scans} scans`);
  /* A different grain is a different set of periods and a different window,
     so it genuinely is a different question and must scan. */
  await m2.get('/api/performance/fleet?grain=month&periods=4');
  check('a different grain does scan', scans === 2, `${scans} scans`);
  m2.server.close();
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
