/* money_event rewrites only the pass's window on a narrow pass (2026-11-26, MEV).
   ──────────────────────────────────────────────────────────────────────────
   Every pass — the quarter-hourly 14-day ones included — deleted and
   re-inserted the whole table (~531k rows on production, each computing the
   generated person_key and maintaining five indexes). On production that was
   188 s of a 14-day pass, and the trip_price INSERT was cancelled at the
   120 s statement timeout five times on 25 Nov. At production scale locally:
   a whole rebuild 17–19.5 s, a 14-day pass 1.1 s, and the narrow pass's table
   identical to a whole rebuild's after changes inside the window (0/0 over
   527,668 rows).

     §1  after changes inside the window — a new fare, a re-priced fare, a
         payout gone, a weekly payout straddling the bound re-stated, a new
         component and a new ledger line — a narrow pass leaves the table
         exactly as a whole rebuild of the same data would;
     §2  what it cannot see, stated: a figure changed entirely before the
         window waits for the full pass, which picks it up;
     §3  the statements: a narrow pass deletes only from its first day; a full
         pass deletes everything and runs with 600 s (SET LOCAL, inside its
         transaction, so the pool's 120 s returns at COMMIT); and the roll-up
         hands the pass's window down.

   Synthetic data only. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { refreshMoneyEvents, FULL_PASS_TIMEOUT_MS } from '../src/rollup.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const pg = new PGlite();
await applySchema(pg);
const q = (t, p = []) => pg.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const SINCE = '2026-10-11';
let n = 0;
const trip = (platform, d, day, price) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, ended_at, status, price, distance_km, payment_type)
   VALUES ($1, $2, 'ecosine', $3, $4, ($5 || ' 12:00+04')::timestamptz, ($5 || ' 12:20+04')::timestamptz, 'completed', $6, 5, 'cash')`,
  [platform, `t${(n += 1)}`, d, `Driver ${d}`, day, price]);
for (const day of ['2026-09-20', '2026-10-05', '2026-10-10', '2026-10-11', '2026-10-15', '2026-10-20']) {
  await trip('uber', 'u1', day, 40); await trip('bolt', 'b1', day, 25); await trip('hotel', 'h1', day, 60);
}
const perf = (d, from, to, amount) => q(
  `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, period_start, period_end, earnings, currency)
   VALUES ('uber', 'ecosine', $1, $2, $3, $4, $5, 'AED')`, [d, `Driver ${d}`, from, to, amount]);
await perf('u1', '2026-09-28', '2026-10-04', 900);   // a week wholly before the window
await perf('u1', '2026-10-05', '2026-10-11', 950);   // a week straddling its first day
await perf('u1', '2026-10-12', '2026-10-18', 990);
await perf('u2', '2026-10-15', '2026-10-15', 120);   // a day
await q(`INSERT INTO driver_earnings_component (platform, driver_ext_id, period_start, period_end, category, parent, amount, currency, driver_name, fleet_id)
  VALUES ('uber','u1','2026-10-01','2026-10-01','fare','your_earnings',50,'AED','Driver u1','ecosine'),
         ('uber','u1','2026-10-16','2026-10-16','fare','your_earnings',55,'AED','Driver u1','ecosine')`);
await q(`INSERT INTO ledger_entry (platform, external_id, fleet_id, driver_ext_id, driver_name, event_at, category, amount, currency)
  VALUES ('yango','l1','egari','y1','Driver y1','2026-10-02 10:00+04','commission',-5,'AED'),
         ('yango','l2','egari','y1','Driver y1','2026-10-14 10:00+04','commission',-6,'AED')`);
await q(`INSERT INTO driver_statement_day (platform, fleet_id, driver_name, driver_ext_id, day, gross, fees, net, tips, salik, cash, trips, source, pseudo, period_days)
  VALUES ('uber','ecosine','Driver u1','u1','2025-06-01',400,100,300,0,0,0,10,'ledger',false,1)`);

const COLS = `source, platform, fleet_id, kind, category, driver_ext_id, driver_name, person_key, plate,
  period_start::text, period_end::text, day::text, amount::text, currency, external_ref`;
const table = async () => JSON.stringify(await q(`SELECT ${COLS} FROM money_event ORDER BY ${COLS}`));
const seen = [];
const db = { query: (t, p) => { seen.push(t); return pg.query(t, p); } };

/* ── §1 ─────────────────────────────────────────────────────────────────── */
console.log('\n§1 a narrow pass leaves the table as a whole rebuild would');
await refreshMoneyEvents(db);
const before = await table();
await trip('uber', 'u1', '2026-10-21', 33);                                            // a new fare
await q(`UPDATE trip SET price = 44 WHERE platform = 'bolt' AND requested_at = '2026-10-15 12:00+04'`); // re-priced
await q(`DELETE FROM driver_performance WHERE driver_ext_id = 'u2'`);                  // a payout gone
await q(`UPDATE driver_performance SET earnings = 975 WHERE period_start = '2026-10-05'`); // straddling week re-stated
await q(`INSERT INTO driver_earnings_component (platform, driver_ext_id, period_start, period_end, category, parent, amount, currency, driver_name, fleet_id)
  VALUES ('uber','u1','2026-10-17','2026-10-17','tip','your_earnings',7,'AED','Driver u1','ecosine')`);
await q(`INSERT INTO ledger_entry (platform, external_id, fleet_id, driver_ext_id, driver_name, event_at, category, amount, currency)
  VALUES ('yango','l3','egari','y1','Driver y1','2026-10-19 10:00+04','topup',20,'AED')`);
seen.length = 0;
const wrote = await refreshMoneyEvents(db, { since: SINCE });
const narrowSeen = [...seen];
const narrow = await table();
await refreshMoneyEvents(db);
const whole = await table();
check('after six kinds of change inside the window, the narrow table is the whole rebuild, row for row', narrow === whole && narrow !== before,
  `\n    narrow ${narrow.slice(0, 300)}\n    whole  ${whole.slice(0, 300)}`);
const inWindow = (await q(`SELECT count(*)::int c FROM money_event WHERE period_end >= $1`, [SINCE]))[0].c;
check('…and it wrote only the window\'s rows, not the table', wrote === inWindow && wrote < (await q(`SELECT count(*)::int c FROM money_event`))[0].c,
  JSON.stringify({ wrote, inWindow }));

/* ── §2 ─────────────────────────────────────────────────────────────────── */
console.log('\n§2 what a narrow pass cannot see, and the full pass that does');
await q(`UPDATE trip SET price = 99 WHERE platform = 'uber' AND requested_at = '2026-09-20 12:00+04'`);
await refreshMoneyEvents(db, { since: SINCE });
const old = async () => (await q(`SELECT amount::text a FROM money_event WHERE source = 'uber_trips' AND day = '2026-09-20'`))[0]?.a;
check('a fare re-priced wholly before the window keeps its old figure on a narrow pass', await old() === '40.00', await old());
await refreshMoneyEvents(db);
check('…and the full pass picks it up', await old() === '99.00', await old());

/* ── §3 ─────────────────────────────────────────────────────────────────── */
console.log('\n§3 the statements');
check('a narrow pass deletes only from its first day', narrowSeen.includes('DELETE FROM money_event WHERE period_end >= $1::date')
  && !narrowSeen.includes('DELETE FROM money_event'), JSON.stringify(narrowSeen.filter((t) => /DELETE/.test(t))));
const log = [];
const pooled = { connect: async () => ({ query: async (t) => { log.push(t.trim().split('\n')[0]); return { rowCount: 0, rows: [] }; }, release: () => log.push('release') }) };
await refreshMoneyEvents(pooled);
check('a full pass runs with the longer timeout inside its transaction, then deletes everything',
  log[0] === 'BEGIN' && log[1] === `SET LOCAL statement_timeout = ${FULL_PASS_TIMEOUT_MS}` && log[2] === 'DELETE FROM money_event' && log.at(-2) === 'COMMIT',
  JSON.stringify(log.slice(0, 4)));
log.length = 0;
await refreshMoneyEvents(pooled, { since: SINCE });
check('…a narrow pass keeps the pool\'s 120 s', !log.some((t) => /statement_timeout/.test(t)), JSON.stringify(log.slice(0, 3)));
const src = readFileSync(new URL('../src/rollup.js', import.meta.url), 'utf8');
check('the roll-up hands the pass\'s window down', /runOne\(db, 'money_event', \(\) => refreshMoneyEvents\(db, \{ since \}\)\)/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
