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
import { REBUILT_MARK, rebuildWeeks } from '../src/sources/yango.js';

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
  /* Stored as production stores them: distance_km NULL (the mapper read a
     field Yango does not send), Yango's own `distance` in metres in raw, and
     the GROSS in the earnings column. */
  [d, ws, trips, null, earnings, cash, hours, j({ count_orders_completed: trips, price_cash: cash,
    price_cashless: cashless, price_platform_commission: commission, work_time_seconds: hours * 3600,
    distance: km * 1000, driver: { id: d, name: 'Synthetic Driver' } })]);
/* The console's week for A agrees with the rebuild to the fils. */
/* The console's commission leaves the mandatory fee out, as production's
   does (fees -30, the mandatory fee -5 not in it). */
await perf('drv-a', '2026-09-07', { trips: 2, km: 22.5, cash: 50, cashless: 85, commission: -30, earnings: 135 });
/* And driver B has a console week the key host never saw. */
await perf('drv-b', '2026-09-07', { trips: 4, km: 40, cash: 100, cashless: 0, commission: -20, earnings: 100 });
const r = await compareRebuild(db, { from: '2026-09-07', to: '2026-09-07' });
check('every console driver-week is scored, including one the key host has nothing for',
  r.metrics.trips.complete_trips.n === 2 && r.metrics.trips.complete_trips.agree === 1, j(r.metrics.trips));
check('…a console week the key host has nothing for is a disagreement, with its figures',
  r.metrics.trips.complete_trips.examples.some((e) => e.console === 4 && e.rebuilt === 0), j(r.metrics.trips.complete_trips.examples));
check('cash from the ledger agrees where the ledger has the week',
  r.metrics.cash.ledger_cash_collected.agree === 1, j(r.metrics.cash));
/* B's cashless is 0 on the console and 0 in the rebuild, which is agreement;
   B's commission is -20 against nothing, which is not. */
check('cashless is card, promotions and tips; commission is the fees without the mandatory fee',
  r.metrics.cashless.ledger_earnings_and_tips.agree === 2 && r.metrics.commission.ledger_fees_only.agree === 1
  && r.metrics.commission.ledger_fees_and_taxes.agree === 0,
  j([r.metrics.cashless, r.metrics.commission]));
check('net earnings agree with the console’s own parts, not its stored (gross) column',
  r.metrics.earnings.ledger_net.agree === 1 && r.metrics.earnings.ledger_net.console_total === 185, j(r.metrics.earnings));
check('distance is read from the console’s raw metres, since its stored column is empty',
  r.metrics.distance_km.complete_trips_mileage.agree === 1 && r.metrics.distance_km.complete_trips_mileage.n === 2,
  j(r.metrics.distance_km));
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
check('earnings are net — the riders’ fares plus the platform’s fees, the mandatory fee apart as the console has it',
  ra?.earnings === 105, ra?.earnings);
check('cash is the ledger’s cash collected', ra?.cash_earnings === 50);
check('the row is marked so the console can overwrite it, under the key the collector looks for',
  ra?.raw[REBUILT_MARK] === REBUILT_FROM, j(ra?.raw));
check('the week is keyed Monday to Sunday', ra?.period_end === '2026-09-13');
const idle = new Map([['x|2026-09-07', { d: 'x', ws: '2026-09-07', trips_complete: 0, trips_all: 2, km_complete: 0,
  price_cash: 0, price_other: 0, plate: null, ledger: {}, groups: {} }]]);
check('a driver with no completed trip and no money that week gets no row', rebuiltRows(idle, { fleet: 'ecosine' }).length === 0);

/* ── 4. the switch ─────────────────────────────────────────────────────────
   REBUILD_WRITES went on only after /api/probe/yango/weekly-rebuild was read
   on production, 2026-09-29; the numbers are in docs/COVERAGE.md. */
console.log('\n4. the switch');
check('rebuilt rows are written, now the production comparison has been read (docs/COVERAGE.md)',
  REBUILD_WRITES === true);

/* ── 5. the collector writes the weeks the console has not delivered ───────
   REVERSION, run 2026-09-29: the ledger-history filter dropped from
   rebuildWeeks -> 25 passed, 1 FAILED: "a week before the ledger's history
   is not written…" (drv-d written with trips and no money). */
console.log('\n5. what the collector writes');
{
  /* A driver the console never covered, in the week of 2026-09-14, and one
     in a week before the ledger's history begins (2026-08-31). */
  await trip('drv-c', '2026-09-15T08:00:00Z', { pay: 'card', price: 60 });
  await led('drv-c', '2026-09-15T08:05:00Z', 'card', 'platform_card', 60);
  await led('drv-c', '2026-09-15T08:06:00Z', 'platform_ride_fee', 'platform_fees', -12);
  await pg.query(`UPDATE ledger_entry SET event_at = event_at WHERE true`);
  const written = [];
  const upsert = async (table, rs) => {
    for (const r of rs) {
      written.push(r);
      await pg.query(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end, trips,
                        distance_km, hours_online, earnings, cash_earnings, raw)
                      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                      ON CONFLICT (platform, driver_ext_id, period_start, period_end) DO UPDATE SET earnings = EXCLUDED.earnings`,
      [r.platform, r.fleet_id, r.driver_ext_id, r.period_start, r.period_end, r.trips, r.distance_km, r.hours_online,
        r.earnings, r.cash_earnings, j(r.raw)]);
    }
    return rs.length;
  };
  await trip('drv-d', '2026-08-31T08:00:00Z', { pay: 'card', price: 40 });
  const n = await rebuildWeeks(new Date('2026-08-31T00:00:00Z'), new Date('2026-09-20T00:00:00Z'),
    new Date('2026-09-29T08:00:00Z'), { db, upsert, writes: true });
  const c = written.find((r) => r.driver_ext_id === 'drv-c');
  check('a closed week with no console row is written from the key host',
    n > 0 && c && c.period_start === '2026-09-14' && c.trips === 1 && c.earnings === 48, j(written.map((r) => [r.driver_ext_id, r.period_start, r.earnings])));
  check('…marked, so the console can replace it', c?.raw[REBUILT_MARK] === 'fleet-api.yango.tech');
  check('a week the console delivered is not rebuilt over it', !written.some((r) => r.period_start === '2026-09-07'),
    j(written.map((r) => r.period_start)));
  check('a week before the ledger\u2019s history is not written: trips with no money would read as a week that earned nothing',
    !written.some((r) => r.driver_ext_id === 'drv-d'), j(written.map((r) => r.driver_ext_id)));
  check('with writing off, nothing is written',
    (await rebuildWeeks(new Date('2026-08-31T00:00:00Z'), new Date('2026-09-20T00:00:00Z'),
      new Date('2026-09-29T08:00:00Z'), { db, upsert: async () => { throw new Error('wrote'); }, writes: false })) === 0);
}

/* ── 6. sql/schema_v90.sql re-files only the cookie row the old reading wrote
   REVERSION, run 2026-09-29: the checked_at cutoff dropped from v90 -> 1
   FAILED: "a cookie proven after the new code went live is left alone". */
console.log('\n6. the cookie row the old 403/401 reading painted green');
{
  const { readFileSync } = await import('node:fs');
  const v90 = readFileSync(new URL('../sql/schema_v90.sql', import.meta.url), 'utf8');
  const put = (cred, state, at, lastOk) => pg.query(
    `INSERT INTO credential_state (provider, fleet_id, credential, state, checked_at, last_ok_at)
     VALUES ('yango', 'ecosine', $1, $2, $3::timestamptz, $4::timestamptz)
     ON CONFLICT (provider, fleet_id, credential) DO UPDATE SET state = EXCLUDED.state,
       checked_at = EXCLUDED.checked_at, last_ok_at = EXCLUDED.last_ok_at`, [cred, state, at, lastOk]);
  const cookie = async () => (await pg.query(`SELECT state, last_ok_at, detail FROM credential_state WHERE credential = 'YANGO_COOKIE'`)).rows[0];
  await put('YANGO_CONSOLE', 'blocked', '2026-09-29T11:01:38Z', '2026-09-12T11:31:32Z');
  await put('YANGO_COOKIE', 'ok', '2026-09-29T11:01:38Z', '2026-09-29T11:01:38Z');
  await pg.exec(v90);
  const a1 = await cookie();
  check('the unearned "ok" becomes "not checked", with no last-ok time', a1.state === 'unknown' && a1.last_ok_at === null
    && /not checked/.test(a1.detail), j(a1));
  await pg.exec(v90);
  check('replaying it changes nothing more', (await cookie()).state === 'unknown');
  await put('YANGO_COOKIE', 'ok', '2026-09-30T01:00:00Z', '2026-09-30T01:00:00Z');
  await pg.exec(v90);
  check('a cookie proven after the new code went live is left alone', (await cookie()).state === 'ok');
  await put('YANGO_CONSOLE', 'ok', '2026-09-29T11:01:00Z', '2026-09-29T11:01:00Z');
  await put('YANGO_COOKIE', 'ok', '2026-09-29T11:01:38Z', '2026-09-29T11:01:38Z');
  await pg.exec(v90);
  check('…and so is one the console itself answered for', (await cookie()).state === 'ok');
}

/* ── 7. sql/schema_v92.sql restates the console's weeks to net ────────────
   REVERSIONS, run 2026-09-29: the "still exactly the gross" condition
   dropped -> 35 passed, 2 FAILED ("a row the console restated itself…" and
   "a replay changes nothing": 104.5 overwritten with 105); the rebuilt
   exclusion dropped from the distance update -> 36 passed, 1 FAILED (the
   rebuilt week given 5 km); the number-type guard dropped -> the migration
   itself errors ("invalid input syntax for type numeric: n/a"), which on
   production would stop the boot. */
console.log('\n7. the console weeks restated from gross to net');
{
  const { readFileSync } = await import('node:fs');
  const v92 = readFileSync(new URL('../sql/schema_v92.sql', import.meta.url), 'utf8');
  await pg.query(`DELETE FROM driver_performance`);
  const row = (d, ws, earnings, raw, km = null) => pg.query(
    `INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, period_start, period_end, earnings, distance_km, raw)
     VALUES ('yango', 'ecosine', $1, $2::date, $2::date + 6, $3, $4, $5)`, [d, ws, earnings, km, j(raw)]);
  const get = async (d) => (await pg.query(`SELECT earnings::float8 AS e, distance_km::float8 AS km FROM driver_performance WHERE driver_ext_id = $1`, [d])).rows[0];
  await row('gross', '2026-08-03', 135, { price_cash: 50, price_cashless: 85, price_platform_commission: -30, distance: 22500 });
  /* Restated by the console itself, to a net that differs from the raw sum
     by its own rounding: its figure stands. */
  await row('net-already', '2026-08-03', 104.5, { price_cash: 50, price_cashless: 85, price_platform_commission: -30 });
  await row('no-commission', '2026-08-03', 40, { price_cash: 40, price_cashless: 0, price_platform_commission: 0 });
  await row('rebuilt', '2026-09-14', 60, { rebuilt_from: 'fleet-api.yango.tech', price_cash: 0, price_cashless: 60, price_platform_commission: -12, distance: 5000 });
  await row('text-figure', '2026-08-03', 10, { price_cash: 'n/a', price_cashless: 10, price_platform_commission: -2 });
  await pg.exec(v92);
  check('a gross console week becomes the net, from its own raw figures', (await get('gross')).e === 105, j(await get('gross')));
  check('…and its distance is filled from Yango\u2019s metres', (await get('gross')).km === 22.5, j(await get('gross')));
  check('a row the console restated itself is left as it wrote it', (await get('net-already')).e === 104.5, j(await get('net-already')));
  check('a week with no commission has nothing to restate', (await get('no-commission')).e === 40);
  check('a rebuilt week is never touched', (await get('rebuilt')).e === 60 && (await get('rebuilt')).km === null, j(await get('rebuilt')));
  check('a figure that is not a number in raw is never cast', (await get('text-figure')).e === 10);
  await pg.exec(v92);
  check('a replay changes nothing', (await get('gross')).e === 105 && (await get('net-already')).e === 104.5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
