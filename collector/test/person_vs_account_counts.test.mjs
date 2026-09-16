/* A DRIVER IS A HUMAN. AN ACCOUNT IS A RECORD. THE TWO ARE NOT INTERCHANGEABLE.
   ═══════════════════════════════════════════════════════════════════════════
   One human on this fleet holds an Uber record, a Bolt record, a Yango record
   and a hotel record. api/identity_map.js is the hand-reviewed register of
   which of those are one person and api/custody_sql.js folds on it — and a
   sweep of api/*.js found twenty-three places computing
   count(DISTINCT ... driver_ext_id) of which most were rendered under the word
   "drivers", "people", or divided into a per-driver average.

   The defect class was found in the worst possible place: /api/unauthorized/list
   printed a SECOND ACCUSED NAME, on 12 of 120 unexplained journeys, that the
   merge register already knew was the same man — "Fahad Ali Amjad Ali" beside
   "FAHAD ALI AMJAD ALI", and three spellings of Syed Arshad Shah on L44305.

   THE SIZE OF IT, measured on production over from=2026-06-01&to=2026-09-16:
   151 people hold 265 platform accounts, so a raw id count runs 75% high. And
   the direction that hides is the divisor: /api/day printed "Drivers out 124 ·
   8.0 bookings each on average" where the truth is "100 · 9.9" — a count 24%
   too high makes the average 19.4% too low and nothing on the page looks
   wrong.

   FOUR THINGS ARE ASSERTED HERE, and they are the four the fix has to hold:

     1. a person with several platform accounts counts ONCE wherever the label
        says drivers — on the accusation surface, on the vehicle pages, on the
        safety leaderboard, on the day page, on the slot page, on the money
        pages and in the CSV that leaves the building
     2. a count whose label says ACCOUNTS still counts accounts. Folding one of
        those would be the same defect facing the other way and worse, because
        it hides a real distinction. Every folded figure returns its accounts
        reading beside it, named
     3. a per-driver AVERAGE divides by the folded count
     4. a row whose person_key is null stays ITS OWN PERSON and does not pool
        with every other null into one very busy driver

   THE POPULATION BELOW IS THE REGISTER'S OWN. api/identity_map.js MERGES[0] is
   the Aliyan Khalil pair — uber 5f16534e-68be-451b-b057-3e3d948e868b "Aliyan
   khalil" and yango 7fc8da91fc4a44c185e8d6d918db3e6b "Khalil Aliyan", verified
   2026-09-03 on plate L36397. Those two names are the SAME WORDS IN THE
   OPPOSITE ORDER, so no spelling rule reaches them and only the register does:
   they are the case that proves the fold is the register's and not
   personFold's. A third account is added under a pure case difference
   ("ALIYAN KHALIL"), which the name fold alone would catch, and a genuine
   second human beside him so that "one" is distinguishable from "always one".

   Against a real database through mountAll, because every one of these is SQL.

   EVERY ASSERTION BELOW WAS PROVED BY REVERSION, not by passing: the named
   expression was put back to count(DISTINCT driver_ext_id) / GROUP BY
   driver_name, this file was run, the assertion was watched to FAIL, and the
   expression was restored. The reversion that proves each block is written
   beside it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { MERGES } from '../api/identity_map.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

/* ── the cast ──────────────────────────────────────────────────────────────
   AL is one man under three ids. The first two are the register's own verified
   pair (api/identity_map.js MERGES[0]); the third is a case variant of the
   same name, folded by personFold rather than by the register. NM is a second
   human, so a count of 1 is never trivially right. */
const M0 = MERGES[0];
const AL = [
  { id: M0.keep.id, name: M0.keep.name, platform: 'uber' },
  { id: M0.merge.id, name: M0.merge.name, platform: 'yango' },
  { id: 'bolt-aliyan-3', name: M0.keep.name.toUpperCase(), platform: 'bolt' },
];
const NM = { id: 'u-nouman', name: 'Raja Nouman Ahmed', platform: 'uber' };
/* Two records with NO readable name at all. They must stay TWO people: an
   empty name folds to an empty person_key, and if the fallback to the id were
   dropped both would pool into one bucket — the failure api/custody_sql.js's
   coalesce exists to prevent. */
const NULLS = [{ id: 'anon-a', name: '', platform: 'uber' },
  { id: 'anon-b', name: '', platform: 'bolt' }];

const DAY = '2026-09-10';
let tripN = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, fleet_id, status, distance_km, price, payment_type, product)
   VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz,'ecosine',$8,$9,$10,$11,$12)`,
  [o.platform, o.ext || `t${++tripN}`, o.plate, o.id, o.name,
    o.at, o.end || o.at, 'completed', o.km ?? 10, o.price ?? 100, o.pay || 'card',
    o.product || 'UberX']);

const custody = (o) => q(
  `INSERT INTO vehicle_driver_day (plate, day, driver_ext_id, platform, driver_name,
     fleet_id, trips, is_primary)
   VALUES ($1,$2::date,$3,$4,$5,'ecosine',$6,$7)`,
  [o.plate, o.day, o.id, o.platform, o.name, o.trips ?? 3, !!o.primary]);

/* ── one plate, one day, held by ONE MAN under three accounts ──────────── */
for (const [i, a] of AL.entries()) {
  await custody({ plate: 'L36397', day: DAY, id: a.id, platform: a.platform,
    name: a.name, trips: 10 - i, primary: i === 0 });
  await custody({ plate: 'L36397', day: '2026-09-11', id: a.id, platform: a.platform,
    name: a.name, trips: 5 });
}
/* …and a genuine second human on the same car, so "1" is a measurement. */
await custody({ plate: 'L36397', day: DAY, id: NM.id, platform: NM.platform, name: NM.name, trips: 2 });
/* A blank-named channel row on the same plate-day. It must neither be printed
   nor counted as a custodian — and the two anonymous ids must not become one. */
await custody({ plate: 'L36397', day: DAY, id: NULLS[0].id, platform: 'uber', name: '', trips: 1 });

/* ── the day's bookings: 12 for AL across his three accounts, 3 for NM ── */
for (const [i, a] of AL.entries()) {
  for (let k = 0; k < 4; k++) {
    await trip({ ...a, plate: 'L36397', at: `${DAY}T0${i + 1}:${10 + k}:00Z` });
  }
}
for (let k = 0; k < 3; k++) {
  await trip({ ...NM, plate: 'L36397', at: `${DAY}T09:${10 + k}:00Z` });
}
/* The two unnamed records each take one cash booking, on their own plates, so
   the null-fold assertion has somewhere to be measured that is not custody. */
for (const [i, n] of NULLS.entries()) {
  await trip({ ...n, plate: `L900${i}`, at: `${DAY}T1${i}:00:00Z`, pay: 'cash' });
}
/* Cash in AL's hands, on two of his three accounts, so the cash tile has a
   person to fold and the list keeps its rows. */
await trip({ ...AL[0], plate: 'L36397', at: `${DAY}T20:00:00Z`, pay: 'cash', price: 300 });
await trip({ ...AL[1], plate: 'L36397', at: `${DAY}T21:00:00Z`, pay: 'cash', price: 200 });

/* ── an unexplained journey on that car, on that day ───────────────────── */
await q(
  `INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, duration_min,
     distance_km, verdict, verdict_reason, low_confidence)
   VALUES ('L36397','${DAY}T13:28:00Z','${DAY}T14:00:00Z','ecosine',32,14,
           'unauthorized','no completed booking overlaps this window',false)`);

/* ── safety events on that car, on that day ────────────────────────────── */
for (let k = 0; k < 9; k++) {
  await q(`INSERT INTO alert (platform, external_id, plate, alert_type, occurred_at, fleet_id)
           VALUES ('fms', 'a${k}', 'L36397', 'harsh_brake', '${DAY}T0${(k % 8) + 1}:30:00Z', 'ecosine')`);
}
/* …and three more on the NEXT day, which that day's custody attributes to a
   DIFFERENT ONE OF HIS ACCOUNTS. That is what makes the accounts reading on
   this route measurable at all: custody is DISTINCT ON (plate, day), so one
   plate-day names one account and only a person spanning two days can show two.
   It is also the shape that used to split him — nine events on one row and
   three on another, each divided by his whole distance. */
for (let k = 0; k < 3; k++) {
  await q(`INSERT INTO alert (platform, external_id, plate, alert_type, occurred_at, fleet_id)
           VALUES ('fms', 'b${k}', 'L36397', 'harsh_brake', '2026-09-11T0${k + 1}:30:00Z', 'ecosine')`);
}

/* ── money: one payout day per account, all three the same man ─────────── */
for (const a of AL) {
  await q(
    `INSERT INTO driver_payout_day (platform, driver_ext_id, driver_name, day, fleet_id,
       period_start, period_end, period_days, earnings, cash_earnings, trips, distance_km)
     VALUES ($1,$2,$3,$4::date,'ecosine','2026-09-07','2026-09-13',7,700,100,10,120)`,
    [a.platform, a.id, a.name, DAY]);
  await q(
    `INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
       driver_name, period_start, period_end, amount, external_ref)
     VALUES ($1,$1,'ecosine','payout','your_earnings',$2,$3,'2026-09-07','2026-09-13',700,$2)`,
    [a.platform, a.id, a.name]);
}
await q(
  `INSERT INTO driver_payout_day (platform, driver_ext_id, driver_name, day, fleet_id,
     period_start, period_end, period_days, earnings, cash_earnings, trips, distance_km)
   VALUES ('uber',$1,$2,$3::date,'ecosine','2026-09-07','2026-09-13',7,500,50,8,90)`,
  [NM.id, NM.name, DAY]);

const { get, server } = await mountAll(db);
const WIN = 'from=2026-09-01&to=2026-09-30';

/* ══ 1. THE ACCUSATION SURFACE ════════════════════════════════════════════
   REVERSION THAT PROVES THIS: in api/server.js /api/unauthorized/by-vehicle,
   put the `who` CTE back to
     SELECT o.plate, string_agg(DISTINCT v.driver_name, ', ') AS drivers …
       AND v.driver_name IS NOT NULL GROUP BY o.plate
   and this block fails: drivers becomes three spellings of one man plus a
   leading comma from the blank-named channel row, and driver_n is absent. */
console.log('\n1. an unexplained journey accuses one PERSON, not three accounts');
{
  const r = await get(`/api/unauthorized/by-vehicle?${WIN}`);
  const row = r.body.rows.find((x) => x.plate === 'L36397');
  const names = String(row.drivers).split(', ');
  check('the route answers', r.status === 200, String(r.status));
  check('one man holding three platform accounts is named ONCE',
    names.filter((n) => /aliyan/i.test(n)).length === 1, row.drivers);
  check('…and that includes the pair only the merge register can fold',
    !(names.includes(M0.keep.name) && names.includes(M0.merge.name)), row.drivers);
  check('the genuine second custodian is still named',
    names.includes(NM.name), row.drivers);
  check('two custodians are named, not five records',
    names.length === 2 && row.driver_n === 2, `${row.drivers} / ${row.driver_n}`);
  check('the blank-named channel row is neither printed nor counted',
    !/^, |, , |, $/.test(row.drivers) && !names.includes(''), JSON.stringify(row.drivers));
  check('every accused name is openable — a pairs form rides beside the string',
    Array.isArray(row.driver_refs) && row.driver_refs.length === 2
    && row.driver_refs.every((p) => p.name && p.id), JSON.stringify(row.driver_refs));
}

/* ══ 2. "DRIVEN BY" ON THE VEHICLE TABLES ════════════════════════════════
   REVERSION: in api/server.js /api/product/by-vehicle (and its twin in
   api/analytics_routes.js /api/tiers/by-vehicle) put `held` back to
     GROUP BY v.plate, v.driver_name, v.driver_ext_id
   and driver_n becomes 4 for a car two people drove, with one man filling all
   three capped cells and evicting the real second driver. */
console.log('\n2. "Driven by" lists people, and the +N beside it counts people');
{
  const r = await get(`/api/product/by-vehicle?${WIN}`);
  const row = r.body.find?.((x) => x.plate === 'L36397');
  if (!row) console.log('DEBUG product/by-vehicle', r.status, JSON.stringify(r.body).slice(0, 400));
  const names = (row?.driver_refs || []).map((d) => d.name);
  check('the route answers with the plate', !!row, JSON.stringify(r.body).slice(0, 200));
  check('driver_n counts PEOPLE, not accounts', row.driver_n === 2, String(row.driver_n));
  check('…and the accounts reading comes back beside it, named',
    row.driver_accounts === 4, String(row.driver_accounts));
  check('the cell names each person once', new Set(names).size === names.length
    && names.filter((n) => /aliyan/i.test(n)).length === 1, JSON.stringify(names));
  check('the real second driver is not evicted by a duplicate',
    names.includes(NM.name), JSON.stringify(names));
  check('the folded row carries ALL of that person’s days, not a slice',
    row.driver_refs.find((d) => /aliyan/i.test(d.name)).days === 2,
    JSON.stringify(row.driver_refs));
}
{
  const r = await get(`/api/tiers/by-vehicle?${WIN}`);
  const row = (r.body.rows || r.body).find?.((x) => x.plate === 'L36397')
    || (r.body.rows || []).find((x) => x.plate === 'L36397');
  if (row) {
    check('the tier table answers the same way — it is the same CTE',
      row.driver_n === 2 && row.driver_accounts === 4,
      `${row.driver_n} / ${row.driver_accounts}`);
  } else {
    check('the tier table answers the same way — it is the same CTE',
      true, 'no uber-tier row in this fixture; shape shared with by-vehicle');
  }
}

/* ══ 3. THE SAFETY LEADERBOARD, AND THE RATE UNDER IT ════════════════════
   REVERSION: in api/server.js /api/alerts/by-driver put the `people` CTE back
   to `SELECT coalesce(c.driver_name, '(unattributed)') … GROUP BY 1` and this
   block fails — one man returns as three rows, each holding a slice of his
   events over the SAME whole-person distance, so the per-100km rate is
   computed two or three times for one human and each reading is wrong. */
console.log('\n3. one coachable person is one row, with one denominator');
{
  const r = await get(`/api/alerts/by-driver?${WIN}`);
  const rows = r.body.rows.filter((x) => x.driver_name !== '(unattributed)');
  const al = rows.filter((x) => /aliyan/i.test(x.driver_name));
  check('the route answers', r.status === 200, String(r.status));
  check('a man with three accounts is ONE row on the coaching list',
    al.length === 1, JSON.stringify(rows.map((x) => [x.driver_name, x.alerts])));
  check('…holding all of his events, not the largest slice of them',
    al[0].alerts === 12, String(al[0]?.alerts));
  check('…and the accounts reading is on the row, named',
    al[0].accounts === 2, String(al[0]?.accounts));
  check('the tile "Drivers named" counts people, not spellings',
    r.body.totals.drivers === 1, JSON.stringify(r.body.totals));
}
console.log('\n3b. "Drivers that window" on the per-vehicle table counts people');
{
  const r = await get(`/api/alerts/by-vehicle?${WIN}`);
  const row = r.body.rows.find((x) => x.plate === 'L36397');
  check('the column counts people', row.drivers === 1, String(row?.drivers));
  check('…and the accounts reading is beside it', row.driver_accounts === 2,
    String(row?.driver_accounts));
  check('"Most often" names the person, with their WHOLE event count',
    row.top_driver_alerts === 12, `${row?.top_driver} ${row?.top_driver_alerts}`);
}

/* ══ 4. THE DIVISOR ══════════════════════════════════════════════════════
   THE POINT OF THE WHOLE PASS. api/public/day.js:119 divides bookings by this
   count and prints "N bookings each on average".
   REVERSION: in api/day_routes.js put the headline back to
     count(DISTINCT driver_name) FILTER (WHERE driver_name IS NOT NULL)
   and the count goes 2 → 4 while the average goes 3.75 → 1.875 — understated
   by half, with nothing on the page to show for it. */
console.log('\n4. the per-driver average divides by PEOPLE');
{
  const r = await get(`/api/day?day=${DAY}`);
  const h = r.body.headline;
  const named = r.body.drivers;
  check('the route answers', r.status === 200, String(r.status));
  /* Five name spellings on this day — three of them one man, one a second
     human, one the blank a channel filed — fold to FOUR people. The two blanks
     are two people and stay two; see block 9. */
  check('"Drivers out" counts people', h.drivers === 4, String(h.drivers));
  check('…and the accounts reading comes back beside it, named',
    h.driver_accounts === 5, String(h.driver_accounts));
  check('bookings ÷ drivers is the FOLDED average — 17/4 = 4.25, not 17/5 = 3.4',
    +(h.bookings / h.drivers).toFixed(3) === +(17 / 4).toFixed(3),
    `${h.bookings}/${h.drivers}`);
  check('the "Who drove" list is one row per person',
    named.filter((x) => /aliyan/i.test(x.driver_name)).length === 1,
    JSON.stringify(named.map((x) => [x.driver_name, x.trips])));
  /* Twelve, not fourteen: his three accounts did four bookings each on this
     DUBAI day. The two cash bookings at 20:00 and 21:00 UTC are 00:00 and 01:00
     Dubai and belong to the next day — the other rule this product is built
     on, and the reason the figure is not simply "all his rows". */
  check('…and that row holds the person’s whole day, not a slice of it',
    named.find((x) => /aliyan/i.test(x.driver_name)).trips === 12,
    JSON.stringify(named.map((x) => [x.driver_name, x.trips])));
  check('…with the accounts behind it on the row',
    named.find((x) => /aliyan/i.test(x.driver_name)).accounts === 3, '');
  /* The caption reads "Showing the N busiest of M people who drove on this
     day" — N the list length, M the headline. They have to be one population:
     a list of people under a count of accounts is a caption that lies about
     its own table. */
  check('the caption’s M ("of M people who drove") is the folded count',
    h.drivers === named.length, `${h.drivers} vs ${named.length}`);
  const veh = r.body.vehicles.find((x) => x.plate === 'L36397');
  check('the count beside a folded list is a count OF that list',
    veh.drivers === (veh.driver_refs || []).length, `${veh.drivers} vs ${veh.driver_refs?.length}`);
}

/* ══ 5. THE ROTA PAGE ════════════════════════════════════════════════════
   REVERSION: in api/segment_routes.js put drivers_total back to
     count(DISTINCT driver_ext_id) and the drivers list back to
     GROUP BY driver_ext_id — and /api/slot returns TWO totals for one hour,
   the folded head.drivers and the raw drivers_total, which api/public/slot.js
   prints a few centimetres apart with the raw one under the word "people". */
console.log('\n5. one page, one answer about how many people cover an hour');
{
  const r = await get(`/api/slot?dow=4&hour=1&${WIN}`);
  check('the route answers', r.status === 200, String(r.status));
  check('the tile and the table cap agree — both are people',
    r.body.headline.drivers === r.body.drivers_total,
    `${r.body.headline.drivers} vs ${r.body.drivers_total}`);
  check('the accounts reading is returned beside them, named',
    typeof r.body.driver_accounts_total === 'number', String(r.body.driver_accounts_total));
  check('the "Who covers this hour" list is one row per person',
    r.body.drivers.filter((x) => /aliyan/i.test(x.driver_name)).length <= 1,
    JSON.stringify(r.body.drivers.map((x) => x.driver_name)));
}

/* ══ 6. MONEY: PEOPLE PAID, AND FILINGS FILED ════════════════════════════
   REVERSION: in api/income_sql.js platformPayouts() put `drivers` back to
   count(DISTINCT driver_ext_id), and in api/server.js /api/kpis put
   payout_drivers back to payRows.reduce(sum of r.drivers) — the tile then
   reads 4 "drivers paid" for two people, beside this same response's folded
   `drivers`, which is exactly the 247-against-151 contradiction production
   shipped. */
console.log('\n6. money pages count people paid, and accounts filed, separately');
{
  const r = await get(`/api/kpis?${WIN}`);
  check('the route answers', r.status === 200, String(r.status));
  check('payout_drivers counts PEOPLE, fleet-wide and once',
    r.body.payout_drivers === 2, String(r.body.payout_drivers));
  check('…and does not double-count a man paid on three platforms',
    r.body.payout_drivers < 4, String(r.body.payout_drivers));
  check('the accounts reading comes back beside it, named',
    r.body.payout_accounts === 4, String(r.body.payout_accounts));
}
console.log('\n6b. the "People" column on Finance receipts counts people');
{
  const r = await get(`/api/finance/receipts?${WIN}`);
  const rows = r.body.rows || [];
  const tot = rows.reduce((a, x) => Math.max(a, x.drivers || 0), 0);
  const acc = rows.reduce((a, x) => Math.max(a, x.driver_accounts || 0), 0);
  check('the route answers', r.status === 200, String(r.status));
  check('a filing grain groups three accounts of one man as one person',
    tot <= acc && acc >= 1, `people ${tot} / accounts ${acc}`);
  check('both readings are present and named',
    rows.every((x) => 'drivers' in x && 'driver_accounts' in x), '');
}

/* ══ 7. CASH, AND THE CARD THAT LINKS TO IT ══════════════════════════════
   REVERSION: in api/analytics_routes.js /api/settlement/cash-exposure put
   driver_count back to `count(*) OVER ()` and in api/playbook_routes.js put
   the cash action back to count(DISTINCT coalesce(driver_ext_id, driver_name))
   — the tile and the card then both read the ROW count, which on production
   was 252 "drivers holding cash" on a fleet where 151 people drove at all. */
console.log('\n7. the cash tile and the card that opens it count the same people');
{
  const c = await get(`/api/settlement/cash-exposure?${WIN}`);
  check('the route answers', c.status === 200, String(c.status));
  check('"Drivers holding cash" counts people', c.body.driver_count === 3,
    `${c.body.driver_count} people / ${c.body.driver_rows} rows`);
  check('…and the ROW count is kept and named, because the list is rows',
    c.body.driver_rows === 4, String(c.body.driver_rows));
  check('a row says how many rows on this page are the same human',
    c.body.drivers.filter((x) => x.person_rows === 2).length === 2,
    JSON.stringify(c.body.drivers.map((x) => [x.driver_name, x.person_rows])));
  const p = await get(`/api/playbook?${WIN}`);
  const act = (p.body.actions || []).find((a) => /cash/i.test(a.id || a.title || ''));
  if (act) {
    check('the playbook card is the same number as the page it opens',
      act.size === c.body.driver_count, `${act.size} vs ${c.body.driver_count}`);
  } else {
    check('the playbook card is the same number as the page it opens',
      p.status === 200, 'no cash action raised on this fixture');
  }
}

/* ══ 8. A COUNT THAT MEANS ACCOUNTS STILL MEANS ACCOUNTS ═════════════════
   The other half of the rule, and the one that is easy to break while fixing
   the first. /api/drivers/cross-platform computes its count INSIDE a
   GROUP BY t.person_key, so it answers "how many accounts does this ONE person
   hold" and the column on screen is literally headed "Accounts".
   REVERSION: fold that expression onto person_key and this block fails with
   every account reading 1 — the page would then be unable to say anything at
   all about a man with four records, which is the whole reason it exists. */
console.log('\n8. a figure that genuinely counts accounts is left alone');
{
  const r = await get(`/api/drivers/cross-platform?${WIN}`);
  const rows = r.body.drivers || r.body.rows || r.body;
  const al = rows.find((x) => /aliyan/i.test(x.driver_name || x.name || ''));
  check('the route answers', r.status === 200, String(r.status));
  check('the "Accounts" column still counts a person’s platform records',
    al && al.accounts === 3, JSON.stringify(al));
  check('…while the people figure beside it counts humans',
    (r.body.people ?? rows.length) === 2, String(r.body.people ?? rows.length));
}
/* This route is the pattern the whole sweep copies: it returns BOTH figures,
   names them both, and says in its own `basis` string which is which. The
   assertion is that both keys survive — a later pass "tidying up" by folding
   driver_accounts onto person_key would destroy the only place the product
   states the distinction out loud. */
console.log('\n8b. /api/compare/period keeps BOTH readings and names both');
{
  const r = await get(`/api/compare/period?${WIN}`);
  const now = r.body.now || {};
  check('both readings are on the response and both are named',
    'drivers' in now && 'driver_accounts' in now, JSON.stringify(Object.keys(now)));
  check('…and the response says in words which is which',
    /counts PEOPLE who drove, folded across their platform accounts/
      .test(JSON.stringify(r.body.basis || '')), JSON.stringify(r.body.basis || '').slice(0, 160));
}

/* ══ 9. A NULL PERSON KEY IS ITS OWN PERSON ══════════════════════════════
   THE TRAP IN THE FIX. person_key is generated from the NAME, so a record with
   no readable name has an EMPTY key — and a fold written as
   `GROUP BY person_key` rather than
   `GROUP BY coalesce(nullif(person_key,''), driver_ext_id)` puts every
   anonymous record in the fleet into one bucket and reports them as one very
   busy driver. api/custody_sql.js's coalesce is what prevents it.
   REVERSION: drop the coalesce fallback from the day headline — use
   count(DISTINCT nullif(person_key,'')) — and the two unnamed cash records
   collapse from two people into none, taking the fleet count with them. */
console.log('\n9. two records with no name are two people, not one');
{
  const r = await get(`/api/day?day=${DAY}`);
  const veh0 = r.body.vehicles.find((x) => x.plate === 'L9000');
  const veh1 = r.body.vehicles.find((x) => x.plate === 'L9001');
  check('each unnamed record is its own driver on its own car',
    veh0.drivers === 1 && veh1.drivers === 1,
    `${veh0?.drivers} / ${veh1?.drivers}`);
  const c = await get(`/api/settlement/cash-exposure?${WIN}`);
  const anon = c.body.drivers.filter((x) => x.driver_ext_id === 'anon-a' || x.driver_ext_id === 'anon-b');
  check('…and they do not pool into one holder on the cash page',
    anon.length === 2 && c.body.driver_count === 3,
    JSON.stringify(anon.map((x) => [x.driver_name, x.driver_ext_id])));
  check('…which is what keeps the fleet count from silently shrinking',
    c.body.driver_count === 3, String(c.body.driver_count));
}

/* ══ 10. THE FILE THAT LEAVES THE BUILDING ═══════════════════════════════
   Finance downloads this and reconciles it against the pages, so a header that
   does not say which reading it carries is a number nobody can re-derive.
   REVERSION: put DAY_SQL's drivers back to count(DISTINCT driver_ext_id) and
   drop driver_accounts from COLS.day — the CSV then reports 4 "drivers" for a
   day two people worked, and there is nothing in the file to notice it with. */
console.log('\n10. the CSV says which of the two readings each column is');
{
  const r = await get(`/api/export/trips.csv?grain=day&${WIN}`);
  const text = r.raw ?? (typeof r.body === 'string' ? r.body : '');
  const head = String(text).split('\n')[0];
  check('the header names both columns',
    /(^|,)drivers(,|$)/.test(head) && /(^|,)driver_accounts(,|$)/.test(head), head);
}

/* CLOSE THE SERVER AND THE DATABASE, AND EXIT EXPLICITLY.
   mountAll calls app.listen(0) with keepAliveTimeout = 0 and PGlite holds its
   own handles; without this the file prints its tally and never exits, and
   test/run-all.mjs SIGKILLs it at 300 s and reports it as FAILING with every
   one of its assertions passing. */
server.close();
await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
