/* YANGO'S WEEKLY PER-DRIVER SUMMARY, REBUILT FROM WHAT THE API KEY GIVES US.
   ─────────────────────────────────────────────────────────────────────────
   driver_performance's Yango rows came from ONE place: the console's
   /api/reports-api/v2/summary/drivers/list, a weekly per-driver aggregate
   behind a session cookie. Yandex's edge has refused that host from this app
   since 2026-09-12, so the table's Yango rows stop at the week ending
   2026-09-06 — 855 driver-weeks from 2026-05-11 — while trips and the payment
   ledger have kept arriving from fleet-api.yango.tech on the API key.

   Everything the summary carried except one field is in those two feeds:

     summary field               rebuilt from
     count_orders_completed      trips on the key host, status 'complete'
     sum_distance                the same trips' mileage
     price_cash                  the v2 ledger, driver by driver
     price_cashless              the v2 ledger
     price_platform_commission   the v2 ledger (the fee rows this file's
                                 sibling once said could not be measured —
                                 src/sources/yango.js LEDGER_GROUPS)
     work_time_seconds           NOTHING. Online time is on no key-host path
                                 Yango publishes; hours_online stays NULL on a
                                 rebuilt row and the reason travels with it.

   NOT WRITTEN UNTIL IT HAS BEEN CHECKED. compareRebuild() puts the rebuild
   beside every week the console did deliver and reports, per figure and per
   candidate formula, how many driver-weeks agree. The collector writes
   rebuilt rows only with the formulas that comparison chose (REBUILD_RULES),
   only for closed weeks that hold no console row, and marks each row with
   `raw.rebuilt_from` so the console can still fill and overwrite that week
   the day it answers again. */
import { LEDGER_GROUPS } from './sources/yango.js';

/* Dubai calendar weeks, Monday to Sunday — the grid the console was asked
   on (src/util.js closedWeeks) and the one driver_performance is keyed on. */
const WEEK = (col) => `to_char(date_trunc('week', ${col} AT TIME ZONE 'Asia/Dubai'), 'YYYY-MM-DD')`;
const SPAN = (col) => `${col} >= ($1::date::timestamp AT TIME ZONE 'Asia/Dubai')
       AND ${col} < (($2::date + 7)::timestamp AT TIME ZONE 'Asia/Dubai')`;

/** Per driver-week, everything the key host lets us count. `from` and `to`
    are the Mondays of the first and last week, inclusive. */
export async function weekComponents(db, from, to) {
  const out = new Map();
  const at = (d, ws) => {
    const k = `${d}|${ws}`;
    if (!out.has(k)) {
      out.set(k, { d, ws, trips_complete: 0, trips_all: 0, km_complete: 0,
        price_cash: 0, price_other: 0, plate: null, ledger: {}, groups: {} });
    }
    return out.get(k);
  };
  const { rows: trips } = await db.query(
    `SELECT driver_ext_id AS d, ${WEEK('requested_at')} AS ws,
            count(*) FILTER (WHERE status = 'complete')::int AS trips_complete,
            count(*)::int AS trips_all,
            coalesce(sum(distance_km) FILTER (WHERE status = 'complete'), 0)::float8 AS km_complete,
            coalesce(sum(price) FILTER (WHERE status = 'complete' AND payment_type = 'cash'), 0)::float8 AS price_cash,
            coalesce(sum(price) FILTER (WHERE status = 'complete' AND payment_type IS DISTINCT FROM 'cash'), 0)::float8 AS price_other,
            max(plate) FILTER (WHERE status = 'complete') AS plate
       FROM trip
      WHERE platform = 'yango' AND driver_ext_id IS NOT NULL AND ${SPAN('requested_at')}
      GROUP BY 1, 2`, [from, to]);
  for (const r of trips) Object.assign(at(r.d, r.ws), { ...r, d: r.d, ws: r.ws });
  const { rows: ledger } = await db.query(
    `SELECT driver_ext_id AS d, ${WEEK('event_at')} AS ws,
            coalesce(raw->>'group_id', 'unknown') AS grp, coalesce(category, 'unknown') AS cat,
            sum(amount)::float8 AS amount
       FROM ledger_entry
      WHERE platform = 'yango' AND driver_ext_id IS NOT NULL AND ${SPAN('event_at')}
      GROUP BY 1, 2, 3, 4`, [from, to]);
  for (const r of ledger) {
    const c = at(r.d, r.ws);
    c.ledger[r.cat] = (c.ledger[r.cat] || 0) + Number(r.amount);
    c.groups[r.grp] = (c.groups[r.grp] || 0) + Number(r.amount);
  }
  return out;
}

/* The ledger's groups by what they are, from the collector's own table so
   the two readings of one ledger cannot drift. */
const sumGroups = (c, heads) => Object.entries(c.groups)
  .filter(([g]) => heads.includes(LEDGER_GROUPS[g])).reduce((s, [, v]) => s + v, 0);
export const ledgerCash = (c) => sumGroups(c, ['cash_collected']);
export const ledgerCashless = (c) => sumGroups(c, ['earnings', 'tips']);
/* Fees only, WITHOUT the mandatory fee. Measured on production 2026-09-29
   against the 112 console driver-weeks from 2026-05-11: the console's
   price_platform_commission agrees with platform + partner fees on 102 of 112
   (91.1%) and with fees plus mandatory taxes on 63 (56.3%) — AED -4,053.09
   against -4,358.22 and -5,098.22. So the console's commission, and the net
   its earnings column was defined on, leave the mandatory fee out, and the
   rebuild follows it so the two halves of the record mean the same thing. */
export const ledgerCommission = (c) => sumGroups(c, ['commission']);
export const ledgerTaxes = (c) => sumGroups(c, ['taxes']);

/* The candidate formula per figure. compareRebuild scores each; the
   collector writes with the ones REBUILD_RULES names. */
export const CANDIDATES = {
  trips: { console: (k) => k.trips, rebuilt: { complete_trips: (c) => c.trips_complete }, tol: () => 0 },
  distance_km: { console: (k) => k.km_raw,
    rebuilt: { complete_trips_mileage: (c) => c.km_complete },
    tol: (v) => Math.max(0.5, Math.abs(v) * 0.01) },
  cash: { console: (k) => k.cash,
    rebuilt: { ledger_cash_collected: ledgerCash, trip_price_cash: (c) => c.price_cash },
    tol: () => 0.01 },
  cashless: { console: (k) => k.cashless,
    rebuilt: { ledger_earnings_and_tips: ledgerCashless, trip_price_not_cash: (c) => c.price_other },
    tol: () => 0.01 },
  commission: { console: (k) => k.commission,
    rebuilt: { ledger_fees_only: ledgerCommission, ledger_fees_and_taxes: (c) => ledgerCommission(c) + ledgerTaxes(c) },
    tol: () => 0.01 },
  /* Against the console's own parts, not its stored earnings column: every
     one of the 112 console rows holds the GROSS there (cash + cashless, AED
     18,229 = 6,318 + 11,911), stored before the collector's net fix and never
     restated because the console stopped answering. */
  earnings: { console: (k) => (k.cash == null || k.cashless == null || k.commission == null ? null
    : Number(k.cash) + Number(k.cashless) + Number(k.commission)),
    rebuilt: { ledger_net: (c) => ledgerCash(c) + ledgerCashless(c) + ledgerCommission(c) },
    tol: () => 0.01 },
};

/* What the collector writes a rebuilt row with. Set from the comparison on
   production — see docs/COVERAGE.md, "Yango's weekly summary, rebuilt".
   A figure with no rule here is written NULL: absent, not guessed. */
export const REBUILD_RULES = Object.freeze({
  trips: 'complete_trips',
  distance_km: 'complete_trips_mileage',
  cash: 'ledger_cash_collected',
  cashless: 'ledger_earnings_and_tips',
  commission: 'ledger_fees_only',
});
export const REBUILT_FROM = 'fleet-api.yango.tech';
/* ON since the comparison was read on production, 2026-09-29, over the 112
   console driver-weeks from 2026-05-11 (docs/COVERAGE.md, "Yango's weekly
   summary, rebuilt"): completed trips agree on 106 (94.6%), cash on 107
   (95.5%), cashless on 106 (94.6%), fees on 102 (91.1%); 15 of the 17 weeks
   agree exactly, and the two that do not are the console's first and last.
   /api/probe/yango/weekly-rebuild still shows the comparison. */
export const REBUILD_WRITES = true;
export const HOURS_ABSENT = 'Yango publishes online time only in the console’s weekly summary, '
  + 'which Yandex’s edge refuses from this server; trips, distance and money here are rebuilt '
  + 'from the API key’s trips and payment ledger.';

/** The console's weeks, as the numbers the summary carried. */
async function consoleWeeks(db, from, to) {
  const { rows } = await db.query(
    `SELECT driver_ext_id AS d, to_char(period_start, 'YYYY-MM-DD') AS ws, trips,
            distance_km::float8 AS km, earnings::float8 AS earnings,
            cash_earnings::float8 AS cash, hours_online::float8 AS hours,
            (raw->>'price_cashless')::float8 AS cashless,
            (raw->>'price_platform_commission')::float8 AS commission,
            /* Yango names it distance, in metres. The collector's mapper read
               sum_distance, which is not there, so the stored distance_km is
               NULL on every console row (fixed in src/sources/yango.js). */
            coalesce((raw->>'distance')::float8, (raw->>'sum_distance')::float8) / 1000 AS km_raw,
            (SELECT jsonb_object_agg(key, value) FROM jsonb_each(raw)
              WHERE jsonb_typeof(value) = 'number') AS numbers
       FROM driver_performance
      WHERE platform = 'yango' AND period_end = period_start + 6
        AND NOT coalesce(raw ? 'rebuilt_from', false)
        AND period_start BETWEEN $1::date AND $2::date`, [from, to]);
  return rows;
}

const round2 = (v) => Math.round(v * 100) / 100;

/** Every stored console week beside its rebuild: per figure, per candidate,
    how many driver-weeks agree and what the totals are. Aggregates only —
    no driver id or name leaves this function. */
export async function compareRebuild(db, { from, to }) {
  const [cons, comps] = await Promise.all([consoleWeeks(db, from, to), weekComponents(db, from, to)]);
  const byKey = new Map(cons.map((k) => [`${k.d}|${k.ws}`, k]));
  const both = [...byKey.keys()].filter((k) => comps.has(k));
  const empty = { trips_complete: 0, trips_all: 0, km_complete: 0, price_cash: 0, price_other: 0, ledger: {}, groups: {} };
  const metrics = {};
  for (const [name, def] of Object.entries(CANDIDATES)) {
    metrics[name] = {};
    for (const [rule, fn] of Object.entries(def.rebuilt)) {
      let n = 0, agree = 0, consoleTotal = 0, rebuiltTotal = 0;
      const examples = [];
      /* Over EVERY console driver-week, not only the ones the rebuild also
         has: a week the key host holds nothing for is a disagreement too. */
      for (const [key, k] of byKey) {
        const want = def.console(k);
        if (want == null) continue;
        const got = fn(comps.get(key) || empty);
        n += 1; consoleTotal += Number(want); rebuiltTotal += got;
        if (Math.abs(got - want) <= def.tol(want) + 1e-9) agree += 1;
        else if (examples.length < 5) examples.push({ week: k.ws, console: round2(Number(want)), rebuilt: round2(got) });
      }
      metrics[name][rule] = { n, agree, agree_pct: n ? Math.round((agree / n) * 1000) / 10 : null,
        console_total: round2(consoleTotal), rebuilt_total: round2(rebuiltTotal), examples };
    }
  }
  /* Per week, the headline figures both ways, so a week the key host does
     not reach (its ledger's history is finite) is visible as a week. */
  const weeks = new Map();
  const wk = (ws) => {
    if (!weeks.has(ws)) weeks.set(ws, { week: ws, console_rows: 0, rebuilt_rows: 0, both: 0,
      console: { trips: 0, cash: 0, earnings: 0 }, rebuilt: { trips: 0, cash: 0, earnings: 0 } });
    return weeks.get(ws);
  };
  for (const k of cons) {
    const w = wk(k.ws); w.console_rows += 1;
    w.console.trips += Number(k.trips) || 0; w.console.cash += Number(k.cash) || 0;
    w.console.earnings += Number(k.earnings) || 0;
  }
  for (const c of comps.values()) {
    if (!(c.trips_complete > 0) && !Object.keys(c.groups).length) continue;
    const w = wk(c.ws); w.rebuilt_rows += 1;
    if (byKey.has(`${c.d}|${c.ws}`)) w.both += 1;
    w.rebuilt.trips += c.trips_complete; w.rebuilt.cash += ledgerCash(c);
    w.rebuilt.earnings += ledgerCash(c) + ledgerCashless(c) + ledgerCommission(c);
  }
  const numbers = {};
  for (const k of cons) {
    for (const [f, v] of Object.entries(k.numbers || {})) numbers[f] = round2((numbers[f] || 0) + Number(v));
  }
  const cats = {};
  for (const key of both) {
    for (const [cat, v] of Object.entries(comps.get(key).ledger)) cats[cat] = round2((cats[cat] || 0) + v);
  }
  const { rows: [span] } = await db.query(
    `SELECT (SELECT min(requested_at) FROM trip WHERE platform = 'yango') AS trips_first,
            (SELECT max(requested_at) FROM trip WHERE platform = 'yango') AS trips_last,
            (SELECT min(event_at) FROM ledger_entry WHERE platform = 'yango') AS ledger_first,
            (SELECT max(event_at) FROM ledger_entry WHERE platform = 'yango') AS ledger_last`);
  const { rows: statuses } = await db.query(
    `SELECT coalesce(status, '(none)') AS status, coalesce(payment_type, '(none)') AS payment, count(*)::int AS n
       FROM trip WHERE platform = 'yango' AND ${SPAN('requested_at')} GROUP BY 1, 2 ORDER BY 3 DESC`, [from, to]);
  return {
    window: { from, to },
    coverage: span,
    driver_weeks: { console: byKey.size, rebuilt: [...comps.values()].filter((c) => c.trips_complete > 0
      || Object.keys(c.groups).length).length, both: both.length },
    metrics,
    weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).map((w) => ({ ...w,
      console: { trips: w.console.trips, cash: round2(w.console.cash), earnings: round2(w.console.earnings) },
      rebuilt: { trips: w.rebuilt.trips, cash: round2(w.rebuilt.cash), earnings: round2(w.rebuilt.earnings) } })),
    console_number_fields: numbers,
    ledger_categories_on_matched_weeks: cats,
    trip_status_payment: statuses,
    rules_in_use: REBUILD_RULES,
  };
}

/** driver_performance rows for the given weeks, by REBUILD_RULES. A figure
    with no rule is NULL; hours_online is always NULL, with the reason. */
export function rebuiltRows(comps, { fleet, nameOf = () => null, plateOf = (p) => p } = {}) {
  const pick = (name, c) => {
    const rule = REBUILD_RULES[name];
    const fn = rule && CANDIDATES[name].rebuilt[rule];
    return fn ? fn(c) : null;
  };
  const rows = [];
  for (const c of comps.values()) {
    const trips = pick('trips', c);
    const cash = pick('cash', c);
    const cashless = pick('cashless', c);
    const commission = pick('commission', c);
    const money = [cash, cashless, commission];
    /* A week with neither a completed trip nor money is not a row — the same
       rule the console mapper applies to a row of zeros. */
    if (!(trips > 0) && !money.some((v) => v)) continue;
    const end = new Date(`${c.ws}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
    rows.push({
      platform: 'yango', fleet_id: fleet, driver_ext_id: c.d,
      driver_name: nameOf(c.d), plate: plateOf(c.plate),
      period_start: c.ws, period_end: end.toISOString().slice(0, 10),
      trips, distance_km: pick('distance_km', c) == null ? null : Math.round(pick('distance_km', c) * 1000) / 1000,
      hours_online: null,
      /* Net, as the console row's earnings is: what the riders paid plus the
         platform's (negative) fees — src/sources/yango.js explains why. Only
         when all three parts have a rule; otherwise absent. */
      earnings: money.every((v) => v != null) ? round2(cash + cashless + commission) : null,
      cash_earnings: cash == null ? null : round2(cash),
      raw: { rebuilt_from: REBUILT_FROM, rules: REBUILD_RULES,
        price_cash: cash == null ? null : round2(cash),
        price_cashless: cashless == null ? null : round2(cashless),
        price_platform_commission: commission == null ? null : round2(commission),
        trips_all: c.trips_all, hours_online_absent: HOURS_ABSENT },
    });
  }
  return rows;
}
