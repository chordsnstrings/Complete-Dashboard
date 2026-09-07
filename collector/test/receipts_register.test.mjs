/* The finance team's register — one row per document a provider filed.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in these words: "we are more interested in how much got into the
   account, which date, from the source exactly."

   The whole page turns on three refusals, and each of them is a way this table
   could quietly start lying:

     A WEEK IS NOT SEVEN DAYS. money_event stores the grain the provider
     reported at, and `day` is NULL for a weekly row precisely so nothing can
     divide it. If this endpoint ever spread a period across its days, a number
     nobody measured would appear beside numbers somebody did.

     A RE-FILING IS NOT A RECEIPT. Providers re-send the same money for an
     overlapping period. Uber's breakdown serves the same driver-week as a
     weekly row and, for recent days, as daily rows — both true, both the same
     money. Summed, August's payout came to AED 1.41m against the AED 415k the
     fleet was paid. So overlaps are marked and excluded from the month totals,
     and the excluded figure is returned beside them.

     A MONTH IS NOT A PERIOD. Five weeks a year straddle a month end. The
     convention is that a period is booked to the month it ENDS in, and the
     count of straddling periods is returned so a reader can see how much of a
     month rests on that convention.

   Everything below is asserted through the mounted route against a real
   Postgres, because the failure that matters is arithmetic in SQL and no
   amount of reading the source would catch it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari')
         ON CONFLICT DO NOTHING`);

const ev = (o) => q(
  `INSERT INTO money_event (source, platform, fleet_id, kind, category, driver_ext_id,
                            driver_name, period_start, period_end, day, amount, external_ref,
                            ingested_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10::date,$11,$12,$13::timestamptz)`,
  [o.source, o.platform, o.fleet || 'ecosine', o.kind, o.category || '', o.driver || '',
    o.driver_name || null, o.from, o.to, o.from === o.to ? o.from : null, o.amount,
    o.ref || '', o.seen || '2026-09-07T06:00:00Z']);

/* A WEEK. Uber's statement for 31 Aug – 6 Sep: two drivers, one filing. */
await ev({ source: 'uber_graphql', platform: 'uber', kind: 'payout', driver: 'd1',
  from: '2026-08-31', to: '2026-09-06', amount: 9000, seen: '2026-09-07T05:00:00Z' });
await ev({ source: 'uber_graphql', platform: 'uber', kind: 'payout', driver: 'd2',
  from: '2026-08-31', to: '2026-09-06', amount: 8749.24, seen: '2026-09-07T05:00:00Z' });
/* The commission on the same filing — a negative line, which a finance team is
   asked about separately from the credit. */
await ev({ source: 'uber_graphql', platform: 'uber', kind: 'payout', category: 'service_fee',
  driver: 'd1', from: '2026-08-31', to: '2026-09-06', amount: -1200, ref: 'fee1',
  seen: '2026-09-07T05:00:00Z' });

/* THE RE-FILING. The same driver-week, sent again as daily rows two days later.
   Same money; counting both doubles it. */
for (const [day, amt] of [['2026-09-01', 1200], ['2026-09-02', 1300], ['2026-09-03', 1100]]) {
  await ev({ source: 'uber_graphql', platform: 'uber', kind: 'payout', driver: 'd1',
    from: day, to: day, amount: amt, seen: '2026-09-07T09:00:00Z' });
}

/* A STRADDLING WEEK, entirely inside the previous month at one end. */
await ev({ source: 'uber_graphql', platform: 'uber', kind: 'payout', driver: 'd3',
  from: '2026-08-24', to: '2026-08-30', amount: 7000, seen: '2026-08-31T05:00:00Z' });

/* A LEDGER TRANSACTION — one day, one event. Ledger rows are never treated as
   restatements: two on a day are two transactions, not one re-filed. */
await ev({ source: 'yango_ledger', platform: 'yango', kind: 'ledger', category: 'card',
  from: '2026-09-02', to: '2026-09-02', amount: 240, ref: 'tx1' });
await ev({ source: 'yango_ledger', platform: 'yango', kind: 'ledger', category: 'card',
  from: '2026-09-02', to: '2026-09-02', amount: 260, ref: 'tx2' });

/* Another fleet, so the fleet filter has something to exclude. */
await ev({ source: 'bolt_portal', platform: 'bolt', fleet: 'egari', kind: 'payout',
  driver: 'b1', from: '2026-09-01', to: '2026-09-07', amount: 500 });

const { get } = await mountAll(db);
const W = 'from=2026-08-01&to=2026-09-30';
const r = await get(`/api/finance/receipts?${W}`);
check('the register answers', r.status === 200, JSON.stringify(r.body).slice(0, 200));
if (r.status !== 200) { console.log(`\n  ${pass} passed, ${fail} failed`); process.exit(1); }

const rows = r.body.rows;
const byPeriod = (from, to, platform = 'uber') =>
  rows.find((x) => String(x.period_start).slice(0, 10) === from
    && String(x.period_end).slice(0, 10) === to && x.platform === platform);

/* ── the grain ─────────────────────────────────────────────────────────── */
const week = byPeriod('2026-08-31', '2026-09-06');
check('a weekly filing is ONE row covering seven days', week && week.days === 7,
  JSON.stringify(week && [week.days, week.rows_seen]));
check('…and is not marked as a dated figure', week && week.is_daily === false,
  String(week?.is_daily));
/* THE REFUSAL. Seven daily rows for that week would be seven measurements
   nobody took. */
check('…and no daily row was invented for the days it covers',
  !rows.some((x) => x.platform === 'uber' && x.is_daily
    && ['2026-09-04', '2026-09-05', '2026-09-06'].includes(String(x.period_start).slice(0, 10))),
  JSON.stringify(rows.filter((x) => x.is_daily).map((x) => String(x.period_start).slice(0, 10))));
check('…and it carries every line the provider filed for it',
  week && week.rows_seen === 3, String(week?.rows_seen));

/* ── credits and fees apart ────────────────────────────────────────────── */
check('the amount is the net of the filing', Math.abs(+week.amount - 16549.24) < 0.01,
  String(week?.amount));
check('…with the credit and the fee reported separately, because both are asked about',
  Math.abs(+week.credits - 17749.24) < 0.01 && Math.abs(+week.debits + 1200) < 0.01,
  JSON.stringify([week?.credits, week?.debits]));
check('…and how many people it is about', week.drivers === 2, String(week?.drivers));

/* ── when it ARRIVED, which is not when it covers ──────────────────────── */
check('a filing carries the date it reached us as well as the dates it covers',
  week.first_seen && new Date(week.first_seen).toISOString() === '2026-09-07T05:00:00.000Z',
  String(week?.first_seen));

/* ── the re-filing ─────────────────────────────────────────────────────── */
const refiled = rows.filter((x) => x.restated);
check('a period that overlaps one already counted is marked as a re-filing',
  refiled.length === 4, JSON.stringify(refiled.map((x) => String(x.period_start).slice(0, 10))));
check('…and the weekly row it overlaps is marked too, because either one alone is the truth',
  week.restated === true, String(week?.restated));
/* NOT DROPPED. A restatement is something the provider did and the register has
   to be able to show it. */
check('…and it is still in the register rather than being deleted',
  rows.some((x) => String(x.period_start).slice(0, 10) === '2026-09-01' && x.platform === 'uber'),
  JSON.stringify(rows.map((x) => String(x.period_start).slice(0, 10))));
/* A ledger transaction is not a re-filing however many land on one day. */
const led = rows.find((x) => x.platform === 'yango');
check('two transactions on one day are two events, not one restated',
  led && led.restated === false && led.rows_seen === 2,
  JSON.stringify([led?.restated, led?.rows_seen]));
check('…and they add up', led && Math.abs(+led.amount - 500) < 0.01, String(led?.amount));

/* ── the month rollup ──────────────────────────────────────────────────── */
const m = (month, platform) => (r.body.months || []).find(
  (x) => String(x.month).slice(0, 7) === month && x.platform === platform);
const sep = m('2026-09', 'uber');
/* The straddling week ENDS in September, so it is September's. */
check('a period is booked to the month it ends in',
  sep && Math.abs(+sep.amount - 0) >= 0, JSON.stringify(sep && [sep.amount, sep.periods]));
check('…and the count of straddling periods is reported, so the convention is visible',
  sep && sep.straddling === 1, String(sep?.straddling));
const aug = m('2026-08', 'uber');
check('…so the week ending 30 Aug is August’s and does not appear in September',
  aug && Math.abs(+aug.amount - 7000) < 0.01, JSON.stringify(aug && [aug.amount, aug.periods]));

/* THE ARITHMETIC THE WHOLE PAGE EXISTS FOR. September's Uber money is the
   weekly filing, net of its fee — 16,549.24 — and NOT that plus the 3,600 of
   daily rows restating three of its days. */
check('a month total excludes the re-filed rows',
  sep && Math.abs(+sep.amount - 16549.24) < 0.01, String(sep?.amount));
check('…and reports what it excluded, so the subtraction can be checked',
  sep && Math.abs(+sep.superseded_amount - 3600) < 0.01, String(sep?.superseded_amount));
/* THE RULE, named. Excluding every CONTESTED row rather than every SUPERSEDED
   one is the mistake that looks like a fix: the weekly filing and the three
   daily rows all overlap something, so dropping them all removed the money as
   well as the duplicate. Measured on this fixture before the rule existed:
   September came to AED 7,549.24 against a true 16,549.24, with 12,600
   reported as excluded — wrong in the direction nobody checks, because a total
   that is too small reads as a quiet month. */
check('…and it is the SHORTER filing that loses, not both of them',
  rows.filter((x) => x.superseded).every((x) => x.days === 1)
  && week.superseded === false,
  JSON.stringify(rows.filter((x) => x.superseded).map((x) => [String(x.period_start).slice(0, 10), x.days])));
check('…so the money in the contested week is counted exactly once',
  Math.abs((+sep.amount + +sep.superseded_amount) - (16549.24 + 3600)) < 0.01,
  JSON.stringify([sep?.amount, sep?.superseded_amount]));
check('…and the loser is still in the register, marked, rather than deleted',
  rows.filter((x) => x.superseded).length === 3,
  String(rows.filter((x) => x.superseded).length));

/* ── the filters ───────────────────────────────────────────────────────── */
const one = await get(`/api/finance/receipts?${W}&fleet=egari`);
check('the fleet filter narrows the register',
  one.body.rows.every((x) => x.fleet_id === 'egari') && one.body.rows.length === 1,
  JSON.stringify(one.body.rows.map((x) => x.fleet_id)));
const plat = await get(`/api/finance/receipts?${W}&platform=yango`);
check('…and so does the channel filter',
  plat.body.rows.every((x) => x.platform === 'yango') && plat.body.rows.length === 1,
  JSON.stringify(plat.body.rows.map((x) => x.platform)));

/* ── and the page is told the rules rather than repeating them ─────────── */
check('the response states the grain rule in words a page can print',
  /never divided into daily figures/i.test(r.body.note || ''), r.body.note);
check('…and the re-filing rule', /re-files/i.test(r.body.restated_note || ''), r.body.restated_note);
check('…and the month convention', /ENDS in/.test(r.body.month_note || ''), r.body.month_note);

/* An empty window is an empty register, not an error and not a zero. */
const none = await get('/api/finance/receipts?from=2020-01-01&to=2020-01-31');
check('a window no provider filed for returns nothing rather than a zero',
  none.status === 200 && none.body.rows.length === 0 && none.body.months.length === 0,
  JSON.stringify([none.status, none.body.rows?.length]));

await db.close();
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
