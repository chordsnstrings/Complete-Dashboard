/* THE FARES A DRIVER COLLECTS ON, per account per Dubai day (FIX-STATUS
   CARD-3; sql/schema_v128.sql has the why).
   ─────────────────────────────────────────────────────────────────────────
   Card payments settle fares the driver collects: cash trips, and the hotel
   channel's pos-driver fares (CARD-2b). Read live through the trip views the
   whole year took 19 s on production, so this sums them once per account and
   day into card_fare_day, and api/card_routes.js reads that.

   WHEN. After every card-payments read (src/sources/network_cards.js, hourly
   at :33): the last 14 days — a trip priced on Uber's next-day catch-up, or a
   hotel booking filed late, lands inside that — and in full once a day, month
   by month from the day before the first card payment, so no single statement
   comes near the pool's two-minute cap. A month is replaced in one
   transaction: a reader between the delete and the insert sees the month
   before, never an empty one.

   The state 'fares_full_at' says a full rebuild has finished; until then the
   API reads live (api/card_routes.js), so a page is never answered from a
   half-built table. */
import { log as defaultLog } from './log.js';

export const RECENT_DAYS = 14;
const FULL_EVERY_MS = 24 * 3600e3;
const SOURCE = 'network_cards';

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => iso(new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5));
const dubaiToday = (now) => iso(new Date(now + 4 * 3600e3));

const SUM = `
  INSERT INTO card_fare_day (platform, driver_ext_id, day, cash, cash_trips, pos, pos_trips, refreshed_at)
  SELECT platform, driver_ext_id, day, sum(cash), sum(cash_n)::int, sum(pos), sum(pos_n)::int, now()
    FROM (
      SELECT tc.platform, tc.driver_ext_id, (tc.requested_at AT TIME ZONE 'Asia/Dubai')::date AS day,
             coalesce(tc.cash_amount, 0) AS cash, 1 AS cash_n, 0::numeric AS pos, 0 AS pos_n
        FROM trip_cash tc
       WHERE tc.driver_ext_id IS NOT NULL
         AND tc.requested_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Dubai')
         AND tc.requested_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
      UNION ALL
      SELECT te.platform, te.driver_ext_id, (te.requested_at AT TIME ZONE 'Asia/Dubai')::date,
             0, 0, coalesce(te.price, 0), 1
        FROM trip_ext te
       WHERE te.driver_ext_id IS NOT NULL AND lower(coalesce(te.payment_type, '')) = 'pos-driver'
         AND te.outcome = 'completed'
         AND te.requested_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Dubai')
         AND te.requested_at <  (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
    ) x
   GROUP BY platform, driver_ext_id, day`;

/* Replace [from, to] (Dubai days) in one transaction. */
async function replaceRange(db, from, to) {
  const pooled = typeof db.connect === 'function';
  const client = pooled ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM card_fare_day WHERE day BETWEEN $1 AND $2', [from, to]);
    const r = await client.query(SUM, [from, to]);
    await client.query('COMMIT');
    return r.rowCount ?? 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { if (pooled) client.release(); }
}

const state = async (db, key) => (await db.query(
  `SELECT value FROM source_state WHERE source = $1 AND fleet_id = '-' AND key = $2`, [SOURCE, key])).rows[0]?.value || null;
const setState = (db, key, value) => db.query(
  `INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ($1, '-', $2, $3, now())
   ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SOURCE, key, value]);

/* One refresh: the last RECENT_DAYS, or everything when a full rebuild is
   due (none yet, or the last one over a day ago) or asked for. */
export async function refreshFares(db, { now = Date.now(), full = null, log = defaultLog } = {}) {
  const [first] = (await db.query(`SELECT to_char(min(txn_day), 'YYYY-MM-DD') AS d FROM card_payment`)).rows;
  if (!first?.d) return { skipped: 'no card payments yet' };
  const today = dubaiToday(now);
  const lastFull = await state(db, 'fares_full_at');
  const doFull = full ?? (!lastFull || now - Date.parse(lastFull) > FULL_EVERY_MS);
  const started = Date.now();
  let rows = 0; let from;
  if (doFull) {
    from = addDays(first.d, -1);
    /* Month by month: each statement a month of trips, well inside the cap. */
    let lo = from;
    while (lo <= today) {
      const monthEnd = addDays(`${lo.slice(0, 7)}-01`, 40).slice(0, 7);
      const hi = [addDays(`${monthEnd}-01`, -1), today].sort()[0];
      rows += await replaceRange(db, lo, hi);
      lo = addDays(hi, 1);
    }
    /* Anything stored before the span (a first card payment moved later)
       is no longer measured against. */
    await db.query('DELETE FROM card_fare_day WHERE day < $1', [from]);
    await setState(db, 'fares_full_at', new Date(now).toISOString());
  } else {
    from = addDays(today, -(RECENT_DAYS - 1));
    rows = await replaceRange(db, from, today);
  }
  await setState(db, 'fares_at', new Date(now).toISOString());
  const out = { full: doFull, from, to: today, rows, s: Math.round((Date.now() - started) / 100) / 10 };
  log.info(SOURCE, 'fares refreshed', out);
  return out;
}
