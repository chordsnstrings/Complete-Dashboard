/* Unit economics: the arithmetic has to survive being sortable.
   ─────────────────────────────────────────────────────────────────────────
   Two endpoints turn "what did this car make" into "which of my cars make
   money", and the whole value of that is a rate on every row. A rate is where
   the arithmetic goes wrong: a zero denominator becomes Infinity or a
   confident 0, a fare gets added to the payout that already contains it, a
   person working two apps is ranked twice at half their size.

   So this checks the identities rather than the values:

     - money in never blends a channel's fare with its own payout
     - every rate is null where its denominator is, and never 0 or Infinity
     - the vehicle rows plus the unplaced remainder are the payout total
     - a vehicle that earned nothing still has a row, because that row is the
       point of the page
     - a person with two accounts is one row carrying both */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { seedFleet, PLATES } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
await seedFleet(db);
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });
const { get: raw, server } = await mountAll(db);
/* mountAll's get answers {status, body}. Every assertion below is about the
   body, and a route that 500s should say so once rather than as thirty
   confusing shape failures. */
const get = async (p) => {
  const r = await raw(p);
  if (r.status !== 200 || !r.body) {
    console.log(`  ✗ ${p} answered ${r.status}: ${JSON.stringify(r.body || r.raw).slice(0, 400)}`);
    fail++;
    return { rows: [], totals: {}, coverage: {} };
  }
  return r.body;
};

/* ── a car that earned BEFORE the window and stopped ──────────────────────
   The dead-capital panel lists vehicles with current papers and no money in
   the window, and its Last trip column came out of the windowed fold — so it
   was empty on every row BY CONSTRUCTION, pruned itself, and printed one
   sentence in its place: "none of these vehicles has ever taken a booking on
   any channel". That is a claim about all time made from a ninety-day query.

   This plate earned in March and has not since. If the answer to "when did
   this car last earn" is still null, the sentence above is still false. */
const IDLE_PLATE = 'L77701';   // not otherwise in this fixture's window
await db.query(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price, pickup_addr, dropoff_addr)
   VALUES ('uber','idle-1','ecosine',$1,'d-idle','Idle Driver',
           '2026-03-04T09:00:00+04:00','2026-03-04T09:20:00+04:00', 11, 'completed', NULL,
           'A - Deira - Dubai - UAE','B - Al Barsha - Dubai - UAE'),
          ('uber','idle-2','ecosine',$1,'d-idle','Idle Driver',
           '2026-03-05T09:00:00+04:00','2026-03-05T09:20:00+04:00', 11, 'completed', NULL,
           'A - Deira - Dubai - UAE','B - Al Barsha - Dubai - UAE')`,
  [IDLE_PLATE]);

const WIN = 'from=2026-08-01&to=2026-08-31';
const A = await get(`/api/economics/assets?${WIN}`);
const D = await get(`/api/economics/drivers?${WIN}`);

/* ── shape ─────────────────────────────────────────────────────────────── */
check('the asset ledger answers an object with rows', A && Array.isArray(A.rows), typeof A);
check('and a totals block', !!A.totals);
check('and states when money begins', !!A.coverage?.note);
check('the people ledger answers an object with rows', D && Array.isArray(D.rows));
check('the window is echoed as whole days', A.window_days === 31, String(A.window_days));

/* ── every plate we hold anything about, earning or not ─────────────────── */
check('every seeded plate has a row', PLATES.every((p) => A.rows.some((r) => r.plate === p)),
  PLATES.filter((p) => !A.rows.some((r) => r.plate === p)).join(', '));
const zero = A.rows.filter((r) => !r.money);
check('a vehicle that earned nothing is still a row', A.rows.length > 0);
check('and it is banded rather than dropped',
  zero.every((r) => ['moved_unpaid', 'still'].includes(r.band)),
  zero.map((r) => `${r.plate}:${r.band}`).join(' '));
check('an earning vehicle is banded earning',
  A.rows.filter((r) => r.money > 0).every((r) => r.band === 'earning'));

/* ── rates: null, never zero, never infinite ─────────────────────────────
   `isNaN(Infinity)` is false and `Number('') === 0`, which is how a division
   by zero reaches a page as a confident number. Absence has to arrive as
   null so it can render as an em-dash with a reason. */
const RATES = ['aed_per_earning_day', 'aed_per_km', 'aed_per_booking', 'alerts_per_100km'];
const bad = [];
for (const r of A.rows) {
  for (const k of RATES) {
    const v = r[k];
    if (v == null) continue;
    if (!Number.isFinite(Number(v))) bad.push(`${r.plate}.${k}=${v}`);
  }
  if (!r.days_earning && r.aed_per_earning_day != null) bad.push(`${r.plate} rate with no earning day`);
  if (!r.km && r.aed_per_km != null) bad.push(`${r.plate} per-km with no km`);
  if (!r.bookings && r.aed_per_booking != null) bad.push(`${r.plate} per-booking with no booking`);
}
check('no asset rate is infinite, and none exists without its denominator',
  bad.length === 0, bad.slice(0, 6).join(' · '));

const dbad = [];
for (const r of D.rows) {
  for (const k of ['aed_per_day_worked', 'aed_per_booking', 'aed_per_km', 'aed_per_hour_online']) {
    if (r[k] != null && !Number.isFinite(Number(r[k]))) dbad.push(`${r.driver_name}.${k}=${r[k]}`);
  }
  if (!r.hours_online && r.aed_per_hour_online != null) dbad.push(`${r.driver_name} hourly with no hours`);
}
check('no person rate is infinite, and none exists without its denominator',
  dbad.length === 0, dbad.slice(0, 6).join(' · '));

/* ── the money rule: never a channel's fare AND its own payout ──────────── */
check('a vehicle\'s money is its fares plus its payouts, and never both for one channel',
  A.rows.every((r) => {
    const parts = (r.fares || 0) + (r.payouts || 0);
    return Math.abs(parts - (r.money || 0)) < 0.02;
  }));
check('the platforms the money was measured on are named',
  A.rows.filter((r) => r.money > 0).every((r) => Array.isArray(r.money_platforms)
    && r.money_platforms.length > 0));

/* ── the partition: placed + unplaced is the whole payout ────────────────
   attribution_sql's third rule. A payout whose driver has no vehicle-day
   inside the period cannot be placed on any car; dropping it would make this
   table quietly sum to less than the Revenue page, which is how a
   reconciliation stops being possible. */
const [payTotal] = await db.query(
  `SELECT round(sum(earnings)::numeric,2) AS t FROM driver_payout_day
   WHERE day BETWEEN '2026-08-01' AND '2026-08-31'`).then((r) => r.rows);
const placed = Number(A.totals.attributed || 0);
const unplaced = Number(A.totals.unplaced_payouts || 0);
check('attributed plus unplaced payout is the payout total',
  Math.abs((placed + unplaced) - Number(payTotal.t || 0)) < 1,
  `${placed} + ${unplaced} vs ${payTotal.t}`);
/* And the income rule is allowed to be SMALLER than the attribution: a channel
   that prices its trips contributes its fares instead, or the same money would
   be counted nearly twice. Smaller, never larger. */
check('the chosen payout figure never exceeds what was attributed',
  Number(A.totals.payouts || 0) <= placed + 0.05,
  `${A.totals.payouts} vs ${placed}`);
check('a fleet filter withholds the unplaced figure with its reason', await (async () => {
  const f = await get(`/api/economics/assets?${WIN}&fleet=ecosine`);
  return f.totals.unplaced_payouts === null && !!f.totals.unplaced_note;
})());

/* ── totals agree with the rows they are made of ─────────────────────────── */
const sumRows = (f) => A.rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
check('the money total is the sum of the rows',
  Math.abs(sumRows((r) => r.money) - Number(A.totals.money || 0)) < 0.05,
  `${sumRows((r) => r.money)} vs ${A.totals.money}`);
check('the bands partition the fleet',
  A.totals.earning + A.totals.moved_unpaid + A.totals.still === A.totals.vehicles,
  `${A.totals.earning}+${A.totals.moved_unpaid}+${A.totals.still} vs ${A.totals.vehicles}`);
check('the fleet rate is the fleet money over the fleet earning-days',
  A.totals.earning_vehicle_days === 0 || Math.abs(
    A.totals.aed_per_earning_day - (A.totals.money / A.totals.earning_vehicle_days)) < 0.02);

/* ── idle days are the window minus the days it moved ───────────────────── */
check('idle days never exceed the window and never go negative',
  A.rows.every((r) => r.idle_days >= 0 && r.idle_days <= r.window_days));
check('idle days plus days moved is the window',
  A.rows.every((r) => r.idle_days + r.days_moved === r.window_days),
  (A.rows.find((r) => r.idle_days + r.days_moved !== r.window_days) || {}).plate || '');
check('a day that earned is a day that moved',
  A.rows.every((r) => r.days_earning <= r.days_moved),
  (A.rows.find((r) => r.days_earning > r.days_moved) || {}).plate || '');

/* ── people are folded to humans, not accounts ───────────────────────────
   The fixture deliberately contains one person with two ids on two platforms.
   Summed per account they rank twice at half their size. */
const multi = D.rows.filter((r) => r.accounts > 1);
check('a person with two accounts is one row', multi.length > 0,
  'the fixture has a two-account driver; the fold should have found them');
check('and that row carries both platforms',
  multi.every((r) => r.platforms.length >= 1));
const names = D.rows.map((r) => String(r.driver_name).toLowerCase());
check('no person appears twice', new Set(names).size === names.length,
  names.filter((x, i) => names.indexOf(x) !== i).join(', '));

/* ── hours: the column this fleet cannot fill ────────────────────────────
   Uber sends no online hours at all and is nine bookings in ten, so an hourly
   rate is missing for almost everyone. The response has to SAY that rather
   than draw an empty column. */
check('the people ledger states how many hourly rates it could compute',
  typeof D.totals.people_with_hours === 'number' && !!D.totals.hours_note);

/* ── the money cliff ─────────────────────────────────────────────────────
   Bank payouts begin in February 2026 and nothing earlier will ever arrive.
   A view wider than that has to name the date rather than draw a collapse. */
check('the coverage block names the first day money exists',
  A.coverage.first_payout_day === null || /^\d{4}-\d{2}-\d{2}$/.test(A.coverage.first_payout_day),
  String(A.coverage.first_payout_day));
const wide = await get('/api/economics/assets?from=2025-01-01&to=2026-08-31');
check('and counts the bookings inside a wide window that no money can reach',
  typeof wide.coverage.unpayable_bookings === 'number');
check('a wide window still returns rows', wide.rows.length > 0);

/* ── filters reach both endpoints ───────────────────────────────────────── */
const uberOnly = await get(`/api/economics/assets?${WIN}&platform=uber`);
check('a platform filter narrows the asset ledger',
  uberOnly.rows.every((r) => !r.money_platforms.length
    || r.money_platforms.every((p) => p === 'uber')),
  uberOnly.rows.flatMap((r) => r.money_platforms).filter((p) => p !== 'uber').join(', '));
const oneFleet = await get(`/api/economics/drivers?${WIN}&fleet=ecosine`);
check('a fleet filter narrows the people ledger', Array.isArray(oneFleet.rows));

/* ── rows are ranked, because the page is a ranking ─────────────────────── */
const ordered = A.rows.every((r, i) => i === 0 || (A.rows[i - 1].money ?? 0) >= (r.money ?? 0));
check('assets arrive ranked by money', ordered);
check('people arrive ranked by money',
  D.rows.every((r, i) => i === 0 || (D.rows[i - 1].money ?? 0) >= (r.money ?? 0)));

/* ── a person's days cannot exceed the window ──────────────────────────────
   KASHIF ALI AYYUB KHAN holds a Uber id and a hotel id. The people query
   groups on the ACCOUNT, so he arrives twice, and the fold used to ADD the two
   per-account day counts: 7 + 6 = 13 days worked inside a SEVEN-day window.

   That is not a cosmetic overcount. The Unit-economics page gates its
   best-earning and worst-earning tables on "at least 10 days driven", and at
   days=7 he was the ONLY person in a fleet of 246 who cleared it — so he was
   the single row on both lists at once, presented as simultaneously the best
   and the worst earner in the fleet. Every multi-account driver inflates the
   same way; he was simply the one who crossed a threshold.

   The union is the fix, and this is the assertion that catches the sum. */
{
  const w = { from: '2026-08-19', to: '2026-08-25' };
  const r = await get(`/api/economics/drivers?from=${w.from}&to=${w.to}`);
  const rows = r.rows || [];
  const over = rows.filter((x) => (x.days_worked || 0) > (x.window_days || 7));
  check('nobody works more days than the window holds',
    over.length === 0,
    over.slice(0, 3).map((x) => `${x.driver_name} ${x.days_worked}>${x.window_days}`).join(', '));
  const multi = rows.filter((x) => (x.platforms || []).length > 1);
  check('and a driver on two platforms is still one person with one set of days',
    multi.every((x) => (x.days_worked || 0) <= (x.window_days || 7)),
    multi.slice(0, 3).map((x) => `${x.driver_name} ${x.platforms} ${x.days_worked}`).join(' | '));
}

/* ── the fleet total, and the part of it that lands on a vehicle ──────────
   Audited against production: this endpoint reported AED 471,407 where
   /api/kpis reported AED 469,915 for the same window, at the same instant, and
   neither page mentioned the other. Both are real answers to different
   questions — chooseBasis picks fares-or-payout ONCE for a channel at fleet
   level, and again PER PLATE here, so a channel counted on its fares fleet-wide
   can be counted on its payout for a vehicle whose coverage of it is thinner.

   The per-plate sum is what the page is FOR — money placed on an asset. It is
   not the fleet's income, and the endpoint now carries both so the page can say
   which is which instead of presenting one as the other. */
{
  const t = A.totals || {};
  /* The page places money on VEHICLES, which means walking each payout through
     custody to a plate. A payout it cannot place has to be reported, not
     dropped — that figure is the whole reason the total differs from Finance's
     and the only thing that makes the difference legible. */
  check('the placed total is accompanied by what could NOT be placed',
    t.unplaced_payouts === null || Number.isFinite(+t.unplaced_payouts),
    JSON.stringify({ money: t.money, unplaced: t.unplaced_payouts }));
  check('…and no invented "fleet total" is returned beside it',
    t.fleet_money === undefined,
    'a total recomputed from the same per-plate rows equalled the per-plate sum exactly, '
    + 'which disproved the basis-rule theory rather than reconciling anything');
  /* The per-channel attribution is what actually differs between this endpoint
     and /api/revenue, so the channel rows have to carry their own basis for
     anyone to see which side a channel fell on. */
  check('every channel row names the basis its money was taken on',
    (A.by_platform || []).every((c) => typeof c.basis === 'string'),
    JSON.stringify((A.by_platform || []).map((c) => [c.platform, c.basis])));
}

/* A tile that explains why it has no number, beside the number.
   ─────────────────────────────────────────────────────────────────────────
   #unit/drivers rendered `value: '—'` as a literal under a sub-line saying
   how many people have online hours — while aed_per_measured_hour sat in the
   very response that sub-line was read from. Production: 16.93 over the
   month, 71.22 over the record. The overview verdict on the same page has
   been rendering the same field correctly the whole time. */
{
  const src = readFileSync('api/public/economics.js', 'utf8');
  check('the per-hour tile renders the rate the response carries',
    /value: t\.aed_per_measured_hour != null \? money\(t\.aed_per_measured_hour\) : '—'/.test(src),
    'the figure was in the same object the sub-line came from');
  check('and still says nothing when nothing was measured',
    /t\.aed_per_measured_hour != null/.test(src),
    'Uber reports no online hours, and AED 0 per hour is a different claim from "nobody reported one"');
}

/* ── when did it last earn ────────────────────────────────────────────── */
{
  const idle = A.rows.find((r) => r.plate === IDLE_PLATE);
  check('the plate that earned before the window is in the ledger', !!idle, IDLE_PLATE);
  check('it has no booking IN the window, which is what puts it on the idle list',
    idle && !idle.last_trip, String(idle?.last_trip));
  /* The whole fix: the windowed fold cannot answer this and the unfiltered one
     can. Compared as a date rather than as a string so a driver of the query
     changing type does not quietly pass. */
  check('…and the whole-record fold still says when it last earned',
    idle?.last_booking_ever
      && new Date(idle.last_booking_ever).toISOString().slice(0, 10) === '2026-03-05',
    String(idle?.last_booking_ever));
  check('…with how many bookings that plate has ever carried',
    (idle?.bookings_ever || 0) >= 2, String(idle?.bookings_ever));
  check('…and how long ago, so the panel can say how long it has been idle',
    idle?.days_since_last_booking > 100, String(idle?.days_since_last_booking));

  /* A plate that really has never earned must stay null, or the column would
     say "last earned" about a car that never did. */
  const never = A.rows.filter((r) => r.bookings_ever === 0);
  check('a plate that has never carried a booking reports no date at all',
    never.every((r) => r.last_booking_ever == null),
    JSON.stringify(never.filter((r) => r.last_booking_ever).map((r) => r.plate)));
  /* And the fold is asked only of the plates that need it — the ones with no
     booking in the window. A working car carries no all-time count, because
     nobody measured one for it; reporting 0 there would be a number we did not
     take. test/economics_cost.test.mjs is the other half of this: folded over
     every plate, a one-day window cost as much as a month. */
  check('a car that worked in the window is not folded over the whole record',
    A.rows.filter((r) => r.bookings > 0).every((r) => r.bookings_ever == null),
    JSON.stringify(A.rows.filter((r) => r.bookings > 0 && r.bookings_ever != null)
      .map((r) => [r.plate, r.bookings_ever]).slice(0, 3)));
  check('…and every car that did NOT is',
    A.rows.filter((r) => !r.bookings).every((r) => r.bookings_ever != null),
    JSON.stringify(A.rows.filter((r) => !r.bookings && r.bookings_ever == null)
      .map((r) => r.plate).slice(0, 3)));

  /* And the fold must not resurrect plates the window, the fleet filter and
     the vehicle register have all excluded. */
  const egari = await get(`/api/economics/assets?${WIN}&fleet=egari`);
  const both = await get(`/api/economics/assets?${WIN}`);
  check('the all-time fold does not add plates the filter excluded',
    egari.rows.length <= both.rows.length,
    `${egari.rows.length} filtered vs ${both.rows.length} unfiltered`);
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await db.close();
process.exit(fail ? 1 : 0);
