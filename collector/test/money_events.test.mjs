/* Every figure, traceable to the call that produced it.
   ─────────────────────────────────────────────────────────────────────────
   Money reaches this product through nine API surfaces and lands in five
   tables with five vocabularies. Uber's trip export carries no price at all;
   its GraphQL breakdown carries a weekly net and a tree of named components;
   its OAuth REST endpoint carries the same thing under different words, for
   one fleet only. Yango prices every trip AND publishes a weekly driver
   summary AND a park ledger. The hotel channel prices every booking. The
   operator's own import carries the months the APIs no longer serve.

   Reading a fleet total therefore meant knowing which of five tables to trust
   for which channel over which window — and the answer lived in one function
   that picks a winner per channel and discards the rest. That is the right
   rule for a total and the wrong place for it to be the only record: a figure
   nobody can trace back to the call that produced it is a figure nobody can
   check.

   money_event is that record. What it must never become is a place where an
   invented number is indistinguishable from a measured one, which is what
   this file mostly guards:

     a weekly statement is ONE measurement of seven days, not seven daily
     figures, so its `day` is NULL and stays NULL;

     a derived table is not a source — driver_statement_day is computed FROM
     driver_earnings_component, and appending both counts the same money twice
     under two names;

     and every row carries the API surface that sent it, not just the
     platform, because Uber has three that carry money and they disagree. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

let n = 0;
const trip = (plat, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, ended_at, distance_km, status, price, currency, raw)
   VALUES ($1,$2,'ecosine','L1','d1','Ann Ahmed',$3::timestamptz,$3::timestamptz+interval '15 min',
           9,'completed',$4,'AED','{}'::jsonb)`,
  [plat, `t${++n}`, `${day}T09:00:00+04`, price]);

/* Three channels with three money shapes: one that prices every booking, one
   that prices none, and one that does both. */
for (let d = 1; d <= 5; d++) {
  await trip('hotel', `2026-08-0${d}`, 150);
  await trip('uber', `2026-08-0${d}`, null);
  await trip('yango', `2026-08-0${d}`, 42);
}
/* A WEEKLY payout and a DAILY one, from the same provider. The pair is the
   point: the table has to keep them apart. */
await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end, earnings, currency)
         VALUES ('uber','ecosine','d1','Ann Ahmed','2026-08-03','2026-08-09', 1400, 'AED'),
                ('uber','ecosine','d1','Ann Ahmed','2026-08-04','2026-08-04', 210, 'AED')`);
await q(`INSERT INTO driver_earnings_component (platform, driver_ext_id, period_start, period_end, category, parent, amount, currency, driver_name, fleet_id)
         VALUES ('uber','d1','2026-08-03','2026-08-09','your_earnings','earnings',1200,'AED','Ann Ahmed','ecosine'),
                ('uber','d1','2026-08-03','2026-08-09','tip','earnings',80,'AED','Ann Ahmed','ecosine'),
                ('uber','d1','2026-08-03','2026-08-09','toll','reimbursements',120,'AED','Ann Ahmed','ecosine')`);
/* Yango's park ledger — collected on every run since the collector was
   written, and reaching no figure in the product. */
await q(`INSERT INTO ledger_entry (platform, external_id, fleet_id, driver_ext_id, driver_name, event_at, category, amount, currency)
         VALUES ('yango','L-1','ecosine','d1','Ann Ahmed','2026-08-05T10:00:00+04','commission',-33,'AED'),
                ('yango','L-2','ecosine','d1','Ann Ahmed','2026-08-06T10:00:00+04','top_up',500,'AED')`);
/* And the operator's own import, for a month the APIs no longer serve. */
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day, gross, fees, net, tips, cash, source)
         VALUES ('uber','ecosine','Ann Ahmed','d1','2026-08-02', 900, 100, 800, 20, 40, 'ledger')`);

await refreshRollups({ db });

console.log('\nevery provider figure is in it, once, with its source');
const ev = await q('SELECT * FROM money_event ORDER BY source, period_start');
check('the table was populated at all', ev.length > 0, String(ev.length));
const by = (k) => ev.filter((r) => r.source === k);
check('the hotel channel’s priced bookings are there', by('hotel_trip_report').length === 5,
  String(by('hotel_trip_report').length));
check('and Yango’s', by('yango_orders').length === 5, String(by('yango_orders').length));
check('Uber contributes no fares, because its export carries no price column',
  !ev.some((r) => r.platform === 'uber' && r.kind === 'fare'));
check('the platform payouts are there', by('uber_graphql_breakdown').length === 2,
  String(by('uber_graphql_breakdown').length));
check('so are the named lines inside them',
  ev.filter((r) => r.kind === 'component').length === 3,
  String(ev.filter((r) => r.kind === 'component').length));
check('the park ledger reaches the record for the first time',
  by('yango_park_ledger').length === 2, String(by('yango_park_ledger').length));
check('and so does the operator’s own import',
  by('statement_import').length === 1, String(by('statement_import').length));
check('every row names the API that sent it, not just the channel',
  ev.every((r) => r.source && r.source !== r.platform), '');
check('and every row carries an amount a provider actually sent',
  ev.every((r) => r.amount != null));

console.log('\na period is not a day, and never becomes one');
const weekly = ev.find((r) => r.kind === 'payout' && +r.amount === 1400);
const daily = ev.find((r) => r.kind === 'payout' && +r.amount === 210);
check('a weekly payout keeps its week', weekly.period_start.toISOString().slice(0, 10) === '2026-08-03'
  && weekly.period_end.toISOString().slice(0, 10) === '2026-08-09', JSON.stringify(weekly));
check('and has NO day, because seven days were measured once',
  weekly.day === null, JSON.stringify(weekly.day));
check('a payout the provider reported for one day does carry that day',
  daily.day && daily.day.toISOString().slice(0, 10) === '2026-08-04', JSON.stringify(daily.day));
check('the weekly components keep their week too',
  ev.filter((r) => r.kind === 'component').every((r) => r.day === null));
check('a trip fare is a single day by construction',
  ev.filter((r) => r.kind === 'fare').every((r) => r.day !== null));
check('nothing was spread — no row sums to a fraction of what a provider sent',
  ev.every((r) => Number.isFinite(+r.amount) && String(+r.amount) === String(Math.round(+r.amount * 100) / 100)));

console.log('\na derived table is not a source');
/* driver_statement_day and driver_payout_day are computed FROM the two tables
   above. Appending them too would count the same money twice under two names,
   which is the exact failure a "unified" store invites. */
check('the resolved daily payout view is not appended',
  !ev.some((r) => r.source.includes('payout_day')), '');
check('nor is the derived statement view, except the operator’s own import',
  ev.filter((r) => r.kind === 'statement').every((r) => r.source === 'statement_import'));
const payouts = ev.filter((r) => r.kind === 'payout').reduce((a, r) => a + +r.amount, 0);
check('so the payouts sum to exactly what the provider reported, not more',
  payouts === 1610, String(payouts));

console.log('\nthe person fold is the same one the rest of the product uses');
check('a name folds to the stored key', ev.every((r) => !r.driver_name || r.person_key === 'ann ahmed'),
  JSON.stringify([...new Set(ev.map((r) => r.person_key))]));

console.log('\nrebuilding is idempotent');
await refreshRollups({ db });
const again = await q('SELECT count(*)::int n, round(sum(amount)::numeric,2) s FROM money_event');
check('a second pass does not double the rows', again[0].n === ev.length, `${again[0].n} vs ${ev.length}`);
check('nor the money', +again[0].s === Math.round(ev.reduce((a, r) => a + +r.amount, 0) * 100) / 100,
  `${again[0].s}`);

console.log('\n/api/money/sources — the provenance page’s data');
const { get } = await mountAll(db, { serverRoutes: true });
const r = (await get('/api/money/sources?from=2026-08-01&to=2026-08-31')).body;
check('it answers rows', Array.isArray(r.rows) && r.rows.length > 0, JSON.stringify(r).slice(0, 120));
check('one row per API surface, channel and kind',
  r.rows.length === new Set(r.rows.map((x) => `${x.source}|${x.platform}|${x.kind}`)).size);
check('each says how many figures the provider sent',
  r.rows.every((x) => x.rows_seen > 0));
check('and separates the ones reported as a day from the ones reported as a span',
  r.rows.every((x) => x.reported_days + x.period_rows === x.rows_seen),
  JSON.stringify(r.rows.map((x) => [x.source, x.reported_days, x.period_rows])));
const uberPay = r.rows.find((x) => x.source === 'uber_graphql_breakdown' && x.kind === 'payout');
check('the weekly payout is shown as a period row, not seven daily ones',
  uberPay.period_rows === 1 && uberPay.reported_days === 1, JSON.stringify(uberPay));
check('and the page can say how long the longest period was',
  uberPay.max_period_days === 7, String(uberPay.max_period_days));
check('the amounts are the providers’ own, summed and not otherwise touched',
  +r.rows.reduce((a, x) => a + +x.amount, 0).toFixed(2)
  === +ev.reduce((a, x) => a + +x.amount, 0).toFixed(2),
  `${r.rows.reduce((a, x) => a + +x.amount, 0)} vs ${ev.reduce((a, x) => a + +x.amount, 0)}`);
check('the categories come back in the provider’s own words',
  r.categories.some((c) => c.category === 'your_earnings')
  && r.categories.some((c) => c.category === 'commission'),
  JSON.stringify(r.categories.map((c) => c.category)));
check('and the note says what the page is and is not',
  /allocated, spread or estimated/i.test(r.note || ''));

console.log('\nthe window is an OVERLAP, because a week is not a month');
/* A weekly statement covering the window's first day is money that touches
   this window. Dropping it because its period starts earlier would understate
   every window that is not a whole number of the provider's own periods. */
const narrow = (await get('/api/money/sources?from=2026-08-04&to=2026-08-05')).body;
check('a week overlapping a two-day window is counted',
  narrow.rows.some((x) => x.source === 'uber_graphql_breakdown' && x.kind === 'payout'),
  JSON.stringify(narrow.rows.map((x) => x.source)));
check('and the page can say how little of it the window covers',
  narrow.rows.find((x) => x.kind === 'payout').max_period_days === 7,
  JSON.stringify(narrow.rows.find((x) => x.kind === 'payout')));
const outside = (await get('/api/money/sources?from=2026-09-01&to=2026-09-30')).body;
check('a window nothing touches is empty, not defaulted to everything',
  outside.rows.length === 0, JSON.stringify(outside.rows.length));

console.log('\nthe channel chip narrows it');
const uberOnly = (await get('/api/money/sources?from=2026-08-01&to=2026-08-31&platform=uber')).body;
check('a channel filter leaves only that channel',
  uberOnly.rows.every((x) => x.platform === 'uber') && uberOnly.rows.length > 0);
check('and the fleet filter works too',
  (await get('/api/money/sources?from=2026-08-01&to=2026-08-31&fleet=ecosine')).body.rows.length > 0);

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
