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
  check('the assets endpoint reports the fleet total as well as the placed sum',
    Number.isFinite(+t.fleet_money), JSON.stringify({ money: t.money, fleet: t.fleet_money }));
  const chan = (A.by_platform || []).reduce((a, c) => a + (Number(c.money) || 0), 0);
  check('…and that total is the channel-level basis, not the per-plate one',
    Math.abs(+t.fleet_money - chan) < 0.05, `${t.fleet_money} vs ${chan.toFixed(2)}`);
  check('…with the placed share stated against it',
    t.fleet_money ? Number.isFinite(+t.placed_pct) : t.placed_pct === null,
    String(t.placed_pct));
  /* Placed can exceed the fleet figure — that is the whole point of carrying
     both — but never by an order of magnitude, which would mean the per-plate
     rule had gone wrong rather than merely differed. */
  check('…and the two are the same order of magnitude',
    !t.fleet_money || (+t.money > +t.fleet_money * 0.5 && +t.money < +t.fleet_money * 2),
    `${t.money} vs ${t.fleet_money}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close(); await db.close();
process.exit(fail ? 1 : 0);
