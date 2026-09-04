#!/usr/bin/env node
/* Does the sum of the per-trip fares equal the statement's own fare line?
   ─────────────────────────────────────────────────────────────────────────
   Uber publishes the same money twice and never says so. Once per trip, in
   REPORT_TYPE_PAYMENTS_ORDER, which src/sources/uber.js writes into
   trip.price; and once per driver-week, as the `fare` node of the earnings
   breakdown that /api/driver/earnings returns. They are the same quantity, so
   the collector is right only if they agree — and when they disagree, WHICH
   line they agree with instead names the mistake.

   Both surfaces render the fare as a tree with the same shape:

       payments report          earnings breakdown
       Paid to you              your_earnings
       └─ Your earnings         ├─ fare              <- the BRANCH
          ├─ Fare               │  ├─ little_fare    <- its base-fare leaf
          │  ├─ Fare            │  ├─ wait_time
          │  ├─ Surge           │  └─ cancellation
          │  ├─ Wait time       ├─ service_fee
          │  └─ Cancellation    └─ taxes_earnings
          └─ Service fee

   The collector read the LEAF for a while. Measured over 24-30 August 2026,
   the five Ecosine drivers whose week the payments report priced in full had
   sum(trip.price) equal to their little_fare EXACTLY — 0.0% on every one —
   and 1.2% to 3.4% under their fare. After the fix the same drivers read 0.0%
   against `fare`. That flip is what this script is for.

   ── why only fully-priced weeks count ────────────────────────────────────
   Scaling a week that priced 2% of its trips up to 100% is arithmetic, not
   evidence: one AED 65 ride becomes AED 3,900. Weeks under the threshold are
   reported and excluded rather than quietly dropped, because how many were
   excluded is itself the state of the backfill.

   Usage:
     node bin/fare-vs-statement.mjs [from] [to]
     BASE=http://localhost:3000 node bin/fare-vs-statement.mjs 2026-08-24 2026-08-30
     MIN_SHARE=100 node bin/fare-vs-statement.mjs        # the clean comparison only

   Exits non-zero when the fully-priced weeks agree with neither line, which
   is the state that means something has gone wrong at the collector. */

const BASE = process.env.BASE || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const FROM = process.argv[2] || '2026-08-24';
const TO = process.argv[3] || '2026-08-30';
const MIN_SHARE = Number(process.env.MIN_SHARE || 95);
const W = `from=${FROM}&to=${TO}`;

const j = async (p) => {
  const r = await fetch(`${BASE}${p}`);
  if (!r.ok) throw new Error(`${p} → HTTP ${r.status}`);
  return r.json();
};

const lb = await j(`/api/drivers/leaderboard?${W}&platform=uber&limit=500`);
const drivers = Array.isArray(lb) ? lb : (lb.rows || []);
console.log(`${drivers.length} drivers on Uber, ${FROM}..${TO}, against ${BASE}\n`);

const out = [];
let thin = 0, noTree = 0;
for (const d of drivers) {
  const id = d.person_key || d.driver_ext_id;
  if (!id) continue;
  const [k, e] = await Promise.all([
    j(`/api/driver/kpis?id=${encodeURIComponent(id)}&${W}`),
    j(`/api/driver/earnings?id=${encodeURIComponent(id)}&${W}`),
  ]);
  if (!k.trips || !k.priced_trips) { thin += 1; continue; }
  const share = (k.priced_trips / k.trips) * 100;
  if (share < MIN_SHARE) { thin += 1; continue; }
  const c = Object.fromEntries((e.components || []).map((x) => [x.category, Number(x.amount)]));
  if (!c.fare || !c.little_fare) { noTree += 1; continue; }
  const scaled = Number(k.revenue) / (k.priced_trips / k.trips);
  out.push({ name: d.driver_name || id, share,
    scaled, leaf: c.little_fare, branch: c.fare,
    vsLeaf: ((scaled - c.little_fare) / c.little_fare) * 100,
    vsBranch: ((scaled - c.fare) / c.fare) * 100 });
}

console.log(`${thin} driver-weeks are under ${MIN_SHARE}% priced and are left out — the payments `
  + 'report has not finished those weeks, and scaling them would be arithmetic rather than evidence');
if (noTree) console.log(`${noTree} more have no fare/little_fare pair in their breakdown`);

if (!out.length) {
  console.log('\nNothing to compare. Either the window has no fully-priced week yet, or no '
    + 'statement covers it.');
  process.exit(0);
}

console.log(`\n${out.length} driver-weeks at ${MIN_SHARE}%+ priced with a full component tree\n`);
console.log('driver                       Σ trip.price   little_fare     vs        fare        vs');
for (const r of out.sort((a, b) => b.branch - a.branch)) {
  const s = (n) => `${n > 0 ? '+' : ''}${n.toFixed(1)}%`.padStart(7);
  console.log(`${r.name.slice(0, 27).padEnd(27)} ${r.scaled.toFixed(2).padStart(12)} `
    + `${r.leaf.toFixed(2).padStart(12)} ${s(r.vsLeaf)} ${r.branch.toFixed(2).padStart(11)} ${s(r.vsBranch)}`);
}

const sum = (f) => out.reduce((a, r) => a + f(r), 0);
const [T, L, B] = [sum((r) => r.scaled), sum((r) => r.leaf), sum((r) => r.branch)];
console.log(`\nTOTAL  Σ trip.price ${T.toFixed(2)}`);
console.log(`       little_fare  ${L.toFixed(2)}  ${(((T - L) / L) * 100).toFixed(2)}%`);
console.log(`       fare         ${B.toFixed(2)}  ${(((T - B) / B) * 100).toFixed(2)}%`);

/* The verdict is taken on the weeks priced IN FULL, where no scaling was
   applied at all — a per-driver equality, not a total that could net out. */
const whole = out.filter((r) => r.share >= 99.99);
const near = (xs, f) => xs.filter((r) => Math.abs(f(r)) < 0.05).length;
const onBranch = near(whole, (r) => r.vsBranch);
const onLeaf = near(whole, (r) => r.vsLeaf);
console.log(`\nof the ${whole.length} weeks priced in full, with no scaling applied:`);
console.log(`  ${onBranch} equal the statement's \`fare\` branch`);
console.log(`  ${onLeaf} equal its \`little_fare\` leaf`);

if (!whole.length) {
  console.log('\nNo week is priced in full yet, so there is nothing here to be right or wrong.');
  process.exit(0);
}
if (onBranch === whole.length) {
  console.log('\nEvery one of them is on the branch. The two surfaces agree.');
  process.exit(0);
}
if (onLeaf > onBranch) {
  console.log('\nThey are on the LEAF. trip.price is the base fare and is missing surge, wait '
    + 'time, reservation fees and cancellations — see PAY_COLS in src/sources/uber.js.');
  process.exit(1);
}
console.log(`\n${whole.length - onBranch} of them match neither line. Something between the `
  + 'payments report and trip.price is not what either surface says it is.');
process.exit(1);
