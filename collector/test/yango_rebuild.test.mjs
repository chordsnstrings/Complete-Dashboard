/* YANGO'S WEEKLY SUMMARY, REBUILT FROM THE KEY HOST — against the real schema.
   ═══════════════════════════════════════════════════════════════════════════
   src/yango_rebuild.js rebuilds the console's weekly per-driver summary from
   the trips and the v2 payment ledger the API key delivers, and compares that
   rebuild with every week the console did deliver before a single rebuilt
   row may be written. Driven here on PGlite built from every schema file,
   with synthetic drivers only.

   What is pinned:
     • the week is DUBAI's Monday-to-Sunday: a trip at 23:30 Sunday Dubai
       (19:30Z) is that week's, one at 01:00 Monday Dubai (21:00Z Sunday) is
       the next week's;
     • the ledger's groups become cash, cashless and commission through the
       collector's own LEDGER_GROUPS table;
     • the comparison counts a console week the key host has nothing for as a
       disagreement, not as a skip;
     • a rebuilt row carries NULL online hours with the reason, net earnings,
       and the mark that lets the console overwrite it;
     • nothing is written while REBUILD_WRITES is off.

   REVERSIONS, run 2026-09-29, recorded beside the checks they break. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { weekComponents, compareRebuild, rebuiltRows, REBUILD_WRITES, REBUILT_FROM, HOURS_ABSENT }
  from '../src/yango_rebuild.js';
import { REBUILT_MARK } from '../src/sources/yango.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

const pg = new PGlite();
const db = { query: (t, p) => pg.query(t, p) };
await applySchema(pg);
await pg.query(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine') ON CONFLICT DO NOTHING`);

/* ── the key host's rows ─────────────────────────────────────────────────── */
let n = 0;
const trip = (d, at, { status = 'complete', km = 10, price = 50, pay = 'cash', plate = 'T 1' } = {}) =>
  pg.query(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, requested_at, ended_at,
                              distance_km, status, payment_type, price, plate)
            VALUES ('yango', $1, 'ecosine', $2, $3, $3, $4, $5, $6, $7, $8)`,
  [`t${++n}`, d, at, km, status, pay, price, plate]);
const led = (d, at, cat, grp, amount) =>
  pg.query(`INSERT INTO ledger_entry (platform, external_id, fleet_id, driver_ext_id, event_at, category, amount, raw)
            VALUES ('yango', $1, 'ecosine', $2, $3, $4, $5, $6)`,
  [`l${++n}`, d, at, cat, amount, j({ group_id: grp, category_id: cat })]);

/* Driver A, week of Monday 2026-09-07 (Dubai). */
await trip('drv-a', '2026-09-07T08:00:00Z');                                  // Mon
await trip('drv-a', '2026-09-13T19:30:00Z', { km: 12.5, pay: 'card', price: 80 }); // Sun 23:30 Dubai
await trip('drv-a', '2026-09-13T21:00:00Z');                                  // Mon 01:00 Dubai → next week
await trip('drv-a', '2026-09-09T10:00:00Z', { status: 'cancelled', km: 3 });
await led('drv-a', '2026-09-07T09:00:00Z', 'cash_collected', 'cash_collected', 50);
await led('drv-a', '2026-09-13T19:31:00Z', 'card', 'platform_card', 80);
await led('drv-a', '2026-09-13T19:32:00Z', 'tip', 'platform_tip', 5);
await led('drv-a', '2026-09-13T19:33:00Z', 'platform_ride_fee', 'platform_fees', -30);
await led('drv-a', '2026-09-13T19:34:00Z', 'platform_mandatory_fee', 'mandatory_taxes_fee', -5);
await led('drv-a', '2026-09-13T21:05:00Z', 'cash_collected', 'cash_collected', 50);  // next week

/* ── 1. the components ─────────────────────────────────────────────────────
   REVERSION: WEEK() truncating the UTC wall clock instead of Dubai's
   -> 13 passed, 7 FAILED: both week-boundary checks, and with them the
      completed count, the mileage, the ledger groups, the net earnings and
      the cash — the Monday-01:00-Dubai trip and cash fall into the wrong week. */
console.log('\n1. what the key host lets us count, by Dubai week');
const c = await weekComponents(db, '2026-09-07', '2026-09-14');
const a1 = c.get('drv-a|2026-09-07');
const a2 = c.get('drv-a|2026-09-14');
check('a trip at 23:30 Sunday Dubai is that week’s', a1?.trips_complete === 2, j(a1));
check('…one at 01:00 Monday Dubai is the next week’s', a2?.trips_complete === 1, j(a2));
check('only COMPLETED trips count, as count_orders_completed does', a1?.trips_all === 3 && a1?.trips_complete === 2);
check('distance is the completed trips’ mileage', Math.abs(a1.km_complete - 22.5) < 1e-9, a1.km_complete);
check('the ledger is filed by group, from the row’s own group_id',
  a1.groups.cash_collected === 50 && a1.groups.platform_card === 80 && a1.groups.platform_fees === -30, j(a1.groups));

/* ── 2. beside the console's own weeks ─────────────────────────────────────
   REVERSION: the comparison loops over `both` instead of every console row
   -> 17 passed, 3 FAILED: "every console driver-week is scored…" (n 1), "…a
      console week the key host has nothing for is a disagreement" (no
      example), and the cashless/commission check — the unmatched week had
      silently dropped out of every score. */
console.log('\n2. the comparison with the weeks the console delivered');
const perf = (d, ws, { trips, km, cash, cashless, commission, earnings, hours = 10 }) =>
  pg.query(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end,
                                            trips, distance_km, earnings, cash_earnings, hours_online, raw)
            VALUES ('yango', 'ecosine', $1, $2::date, $2::date + 6, $3, $4, $5, $6, $7, $8)`,
  [d, ws, trips, km, earnings, cash, hours, j({ count_orders_completed: trips, price_cash: cash,
    price_cashless: cashless, price_platform_commission: commission, work_time_seconds: hours * 3600,
    driver: { id: d, name: 'Synthetic Driver' } })]);
/* The console's week for A agrees with the rebuild to the fils. */
await perf('drv-a', '2026-09-07', { trips: 2, km: 22.5, cash: 50, cashless: 85, commission: -35, earnings: 100 });
/* And driver B has a console week the key host never saw. */
await perf('drv-b', '2026-09-07', { trips: 4, km: 40, cash: 100, cashless: 0, commission: -20, earnings: 80 });
const r = await compareRebuild(db, { from: '2026-09-07', to: '2026-09-07' });
check('every console driver-week is scored, including one the key host has nothing for',
  r.metrics.trips.complete_trips.n === 2 && r.metrics.trips.complete_trips.agree === 1, j(r.metrics.trips));
check('…a console week the key host has nothing for is a disagreement, with its figures',
  r.metrics.trips.complete_trips.examples.some((e) => e.console === 4 && e.rebuilt === 0), j(r.metrics.trips.complete_trips.examples));
check('cash from the ledger agrees where the ledger has the week',
  r.metrics.cash.ledger_cash_collected.agree === 1, j(r.metrics.cash));
/* B's cashless is 0 on the console and 0 in the rebuild, which is agreement;
   B's commission is -20 against nothing, which is not. */
check('cashless is card, promotions and tips; commission is fees and taxes, as filed',
  r.metrics.cashless.ledger_earnings_and_tips.agree === 2 && r.metrics.commission.ledger_fees_and_taxes.agree === 1,
  j([r.metrics.cashless, r.metrics.commission]));
check('net earnings: the three together, as the console’s earnings column is',
  r.metrics.earnings.ledger_net.agree === 1, j(r.metrics.earnings));
check('the answer carries no driver id or name', !/drv-a|drv-b|Synthetic Driver/.test(j(r)), '');
check('a rebuilt week that is not a console week is not scored against anything',
  r.driver_weeks.console === 2 && r.driver_weeks.both === 1, j(r.driver_weeks));

/* ── 3. the rows it would write ────────────────────────────────────────────
   REVERSION: hours_online filled with 0 instead of NULL -> 19 passed,
   1 FAILED: "online hours are ABSENT on a rebuilt row, never a zero". */
console.log('\n3. a rebuilt row');
const rows = rebuiltRows(c, { fleet: 'ecosine', nameOf: () => 'Synthetic Driver' });
const ra = rows.find((x) => x.period_start === '2026-09-07');
check('online hours are ABSENT on a rebuilt row, never a zero', ra && ra.hours_online === null, j(ra));
check('…and the row says why', ra?.raw.hours_online_absent === HOURS_ABSENT && /online time/.test(HOURS_ABSENT));
check('earnings are net — what the riders paid plus the platform’s fees', ra?.earnings === 100, ra?.earnings);
check('cash is the ledger’s cash collected', ra?.cash_earnings === 50);
check('the row is marked so the console can overwrite it, under the key the collector looks for',
  ra?.raw[REBUILT_MARK] === REBUILT_FROM, j(ra?.raw));
check('the week is keyed Monday to Sunday', ra?.period_end === '2026-09-13');
const idle = new Map([['x|2026-09-07', { d: 'x', ws: '2026-09-07', trips_complete: 0, trips_all: 2, km_complete: 0,
  price_cash: 0, price_other: 0, plate: null, ledger: {}, groups: {} }]]);
check('a driver with no completed trip and no money that week gets no row', rebuiltRows(idle, { fleet: 'ecosine' }).length === 0);

/* ── 4. nothing is written until the comparison has been read ──────────────
   REBUILD_WRITES is the switch; it goes on in a commit of its own, with the
   comparison measured on production recorded in docs/COVERAGE.md. */
console.log('\n4. the switch');
check('rebuilt rows are not written until the production comparison has been read',
  REBUILD_WRITES === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
