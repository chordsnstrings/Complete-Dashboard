/* CARD-MACHINE PAYMENTS — Network International (FIX-STATUS CARD-1).
   ─────────────────────────────────────────────────────────────────────────
   The read side of src/sources/network_cards.js (its header has the
   operator's decisions). Three reads and one write:

     GET  /api/card/driver   one person's card payments: each with its day,
                             terminal and amount (the operator: "in driver's
                             history, the terminal ID should be there so that
                             we can trace back"), by day, and each terminal
                             they used with its first and last day
     GET  /api/card/summary  the fleet: by month and fleet, and what is not on
                             anybody — payments with no driver named, by
                             terminal, and Emirates IDs not yet placed
     GET  /api/card/review   the Emirates IDs not yet placed, for a person to
                             link (MRG: the people who decide same-person pairs)
     POST /api/card/link     link (or unlink) one such ID to a driver

   A PAYMENT IS PLACED BY ITS EMIRATES ID, through the card_id_person view
   (sql/schema_v127.sql): a person's link first, then the HR export. Never by
   the car — terminals move between drivers. A payment with no driver named,
   or under an ID not yet placed, is shown as exactly that and never spread
   across anybody.

   A NEGATIVE AMOUNT IS A CHARGEBACK and is summed as it is (the operator: the
   totals with them "are correct"; the fare "usually comes back").

   NOTHING HERE MOVES THE CASH POSITION. Until phase 3 (FIX-STATUS CARD-3)
   these payments are shown beside it, and every answer says so. */
import crypto from 'node:crypto';
import { deciderOf } from './charging_routes.js';

const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayParam = (v) => (DAY.test(String(v || '').trim()) ? String(v).trim() : null);
/* An unplaced Emirates ID is named on the review list by an opaque ref, so a
   decision can be sent back without the number travelling again — and a
   reader whose role sees the number masked can still decide.

   KEYED, not a bare hash (the review of 2026-11-23): an Emirates ID is 784,
   a birth year, seven digits and a check digit — some 10^8 candidates, and a
   reader shown the last four has ~10^5 left. An unsalted sha256 of that
   space is reversed in under a second. An HMAC under a key only this server
   holds (the same root the settings encryption derives from) is not; the
   ref stays stable across restarts, so a page loaded before one still links. */
const REF_KEY = crypto.createHash('sha256')
  .update(`card-ref:${process.env.SETTINGS_KEY || process.env.DATABASE_URL || 'fleet-dev-key'}`).digest();
export const refOf = (eid) => crypto.createHmac('sha256', REF_KEY).update(String(eid)).digest('hex').slice(0, 16);

export const NOT_IN_POSITION = 'card payments are shown beside the cash position, not yet taken off it — that change waits for the operator\'s review';

/* WHEN THE SHEET WAS LAST READ — and whether the latest attempt failed or
   was held after it, so a page never passes old payments off as current. */
export async function readState(q) {
  const [ok] = await q(`SELECT read_at, day_from, day_to, rows_kept, rows_skipped, skipped FROM card_import
                         WHERE status = 'ok' ORDER BY read_at DESC, id DESC LIMIT 1`);
  const [last] = await q(`SELECT read_at, status, why FROM card_import ORDER BY read_at DESC, id DESC LIMIT 1`);
  const [cov] = await q(`SELECT min(txn_day) AS first_day, max(txn_day) AS last_day FROM card_payment`);
  const iso = (d) => (d == null ? null : (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)));
  const failed = last && last.status !== 'ok' && (!ok || new Date(last.read_at) > new Date(ok.read_at))
    ? { at: last.read_at, status: last.status, why: last.why } : null;
  return {
    read_at: ok?.read_at || null,
    covers_from: iso(cov?.first_day), covers_to: iso(cov?.last_day),
    skipped_rows: ok ? ok.rows_skipped : null, skipped: ok?.skipped || null,
    failed,
    why: !ok && !last ? 'The card-payments sheet has not been read yet: it is read hourly once its link is set (Settings, Card machines).'
      : !ok ? `The card-payments sheet has never been read successfully: ${String(last.why || last.status).slice(0, 200)}` : null,
  };
}

/* THE CROSS-CHECK (FIX-STATUS CARD-2, 2026-11-23: the operator's "go ahead
   with phase 2"). A card payment settles a CASH trip on the card machine
   instead of in notes, so a driver's card total for a day should not exceed
   the cash their cash trips collected that day. Measured on production before
   it was built, one driver, 1–22 Nov: 14 of 16 card days were covered, most
   to the fils (45.50 against a 45.50 cash trip, 77.37 against 77.37), and two
   ran about AED 50 over — exactly what this is for.

   Each driver-day with card payments gets one status:
     covered                  card ≤ that day's cash trips + the allowance;
     covered_with_day_before  only with what the day before left over (a
                              fare taken before midnight, paid after it);
     over                     card exceeds both, by over_by;
     no_cash_trips            no cash trip that day or the day before.
   "over" and "no_cash_trips" mean the sheet put the payment on the wrong
   driver (the terminal was in someone else's hands), or the driver took card
   payments for rides not on any platform. The allowance is AED 5 a day: a
   card payment may carry a tip or a rounding the cash trip did not.

   Cash trips are trip_cash (sql/schema_v80.sql): completed trips the driver
   holds cash for, valued by Uber's own cash_collected where its payments
   report has it, else the fare — the figure the cash text uses. Placed on the
   person by the whole account key, live accounts only; the Dubai day the trip
   was requested. */
export const ALLOWANCE = 5;
export function statusOf({ card, cash, prevCash = 0, prevCard = 0, cashTrips = 0, prevTrips = 0 }) {
  const spare = Math.max(0, prevCash - Math.max(0, prevCard));
  if (!cashTrips && !prevTrips) return { status: 'no_cash_trips', over_by: r2(card) };
  if (card <= cash + ALLOWANCE) return { status: 'covered', over_by: null };
  if (card <= cash + spare + ALLOWANCE) return { status: 'covered_with_day_before', over_by: null };
  return { status: 'over', over_by: r2(card - cash - spare) };
}

/* Cash trips per person per Dubai day, over [lo, hi]. One grouped read. */
async function cashByDay(q, personIds, lo, hi) {
  const ids = [...new Set(personIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length || !lo || !hi) return out;
  const rows = await q(`SELECT a.driver_id::text AS person_id, to_char((tc.requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
                               count(*)::int AS trips, coalesce(sum(tc.cash_amount), 0)::float AS cash
                          FROM trip_cash tc
                          JOIN driver_platform_id a ON a.platform = tc.platform AND a.external_id = tc.driver_ext_id
                                                   AND a.detached_at IS NULL AND a.driver_id = ANY($1::bigint[])
                         WHERE tc.requested_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Dubai')
                           AND tc.requested_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
                         GROUP BY 1, 2`, [ids, lo, hi]);
  for (const r of rows) out.set(`${r.person_id}|${r.day}`, { trips: r.trips, cash: r.cash });
  return out;
}
const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);

export function cardRoutes(app, { q, wrap }) {
  app.get('/api/card/driver', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const person = Number(req.query.person);
    if (!Number.isInteger(person) || person <= 0) return res.status(400).json({ error: 'person required' });
    const from = dayParam(req.query.from); const to = dayParam(req.query.to);
    const s = await readState(q);
    /* The view once (the review of 2026-11-23: it was evaluated five times
       a call); the payments are then read by the IDs it placed here. */
    const ids = await q(`SELECT emirates_id, basis FROM card_id_person WHERE person_id = $1`, [person]);
    const E = ids.map((x) => x.emirates_id);
    const W = `p.emirates_id = ANY($1::text[]) AND ($2::date IS NULL OR p.txn_day >= $2) AND ($3::date IS NULL OR p.txn_day <= $3)`;
    const P3 = [E, from, to];
    const [t] = await q(`SELECT count(*)::int AS payments, coalesce(sum(p.amount) FILTER (WHERE p.amount > 0), 0)::float AS card,
             coalesce(sum(p.amount) FILTER (WHERE p.amount < 0), 0)::float AS chargebacks, coalesce(sum(p.amount), 0)::float AS net,
             count(*) FILTER (WHERE p.amount < 0)::int AS chargeback_n,
             to_char(min(p.txn_day), 'YYYY-MM-DD') AS first_day, to_char(max(p.txn_day), 'YYYY-MM-DD') AS last_day
        FROM card_payment p WHERE ${W}`, P3);
    const days = await q(`SELECT to_char(p.txn_day, 'YYYY-MM-DD') AS day, count(*)::int AS payments, sum(p.amount)::float AS net,
             count(*) FILTER (WHERE p.amount < 0)::int AS chargebacks, array_agg(DISTINCT p.terminal_id ORDER BY p.terminal_id) AS terminals
        FROM card_payment p WHERE ${W}
       GROUP BY p.txn_day ORDER BY p.txn_day DESC LIMIT 90`, P3);
    const payments = await q(`SELECT to_char(p.txn_day, 'YYYY-MM-DD') AS day, p.terminal_id, p.amount::float AS amount, p.fleet_id
        FROM card_payment p WHERE ${W}
       ORDER BY p.txn_day DESC, p.row_no DESC LIMIT 200`, P3);
    /* CARD-2: each day against that day's cash trips (and the day before's
       leftover). Card per day over the same span, for the day-before term. */
    const dayList = days.map((d) => d.day).sort();
    const cashMap = dayList.length ? await cashByDay(q, [person], dayBefore(dayList[0]), dayList[dayList.length - 1]) : new Map();
    const cardByDay = new Map(dayList.length ? (await q(`SELECT to_char(p.txn_day, 'YYYY-MM-DD') AS day, sum(p.amount)::float AS card
        FROM card_payment p WHERE p.emirates_id = ANY($1::text[]) AND p.txn_day BETWEEN $2 AND $3 GROUP BY 1`,
    [E, dayBefore(dayList[0]), dayList[dayList.length - 1]])).map((x) => [x.day, x.card]) : []);
    const checkDay = (d) => {
      const k = cashMap.get(`${person}|${d.day}`) || { trips: 0, cash: 0 };
      const pk = cashMap.get(`${person}|${dayBefore(d.day)}`) || { trips: 0, cash: 0 };
      const st = statusOf({ card: d.net, cash: k.cash, prevCash: pk.cash, prevCard: cardByDay.get(dayBefore(d.day)) || 0,
        cashTrips: k.trips, prevTrips: pk.trips });
      return { cash_trips: k.trips, cash: r2(k.cash), ...st };
    };
    const terminals = await q(`SELECT p.terminal_id, count(*)::int AS payments, sum(p.amount)::float AS net,
             to_char(min(p.txn_day), 'YYYY-MM-DD') AS first_day, to_char(max(p.txn_day), 'YYYY-MM-DD') AS last_day
        FROM card_payment p WHERE ${W}
       GROUP BY p.terminal_id ORDER BY max(p.txn_day) DESC, p.terminal_id`, P3);
    /* Why there is nothing, TRULY (the review of 2026-11-23: "not on the HR
       export" was also said when it IS on the export but placed on nobody or
       on another record). The person's own HR rows are asked directly. */
    let why = s.why;
    if (!why && !t.payments) {
      if (ids.length) {
        why = `No card payment on the Network International sheet is under this driver's Emirates ID${from || to ? ' in this window' : ''}.`;
      } else {
        const hr = await q(`SELECT DISTINCT m.basis, m.person_id, m.hr_people FROM hr_roster_row r
            CROSS JOIN LATERAL jsonb_array_elements(coalesce(r.matched_accounts, '[]'::jsonb)) a
            JOIN driver_platform_id d ON d.platform = a ->> 'platform' AND d.external_id = a ->> 'ext_id'
                                     AND d.detached_at IS NULL AND d.driver_id = $1
            LEFT JOIN card_id_person m ON m.emirates_id = r.emirates_id
           WHERE r.emirates_id ~ '^784[0-9]{12}$'`, [person]);
        why = !hr.length
          ? 'No Emirates ID is known for this driver: it is not on the HR export and nobody has linked one, so no card payment can be placed on them.'
          : hr.some((x) => x.basis === 'hr_ambiguous')
            ? 'This driver\'s Emirates ID is on the HR export under more than one driver record, so no card payment is placed on any of them — fold the records into one person (Same person page).'
            : 'This driver\'s Emirates ID on an older HR export is placed on another driver record by a newer one (or by a person\'s link), so its card payments are shown there.';
      }
    }
    return res.json({ person_id: String(person), from, to, ...s, why, currency: 'AED',
      placed_by: { hr_export: ids.filter((x) => x.basis === 'hr').length, linked: ids.filter((x) => x.basis === 'linked').length },
      totals: { payments: t.payments, card: r2(t.card), chargebacks: r2(t.chargebacks), chargeback_n: t.chargeback_n, net: r2(t.net),
        first_day: t.first_day, last_day: t.last_day },
      days: days.map((d) => ({ ...d, net: r2(d.net), ...checkDay(d) })),
      allowance_aed: ALLOWANCE,
      payments: payments.map((p) => ({ ...p, amount: r2(p.amount), chargeback: p.amount < 0 })),
      terminals: terminals.map((x) => ({ ...x, net: r2(x.net) })),
      in_cash_position: false, note: NOT_IN_POSITION });
  }));

  /* THE FLEET'S CROSS-CHECK (CARD-2): every placed driver-day with card
     payments, against that driver's cash trips. Not cached (api/cache.js):
     a link moves which driver a payment is on. */
  app.get('/api/card/crosscheck', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const from = dayParam(req.query.from); const to = dayParam(req.query.to);
    const s = await readState(q);
    const card = await q(`SELECT m.person_id::text AS person_id, d.full_name AS name, to_char(p.txn_day, 'YYYY-MM-DD') AS day,
             count(*)::int AS payments, sum(p.amount)::float AS card, array_agg(DISTINCT p.terminal_id ORDER BY p.terminal_id) AS terminals
        FROM card_payment p JOIN card_id_person m ON m.emirates_id = p.emirates_id
        LEFT JOIN driver d ON d.id = m.person_id
       WHERE m.person_id IS NOT NULL AND ($1::date IS NULL OR p.txn_day >= $1) AND ($2::date IS NULL OR p.txn_day <= $2)
       GROUP BY m.person_id, d.full_name, p.txn_day`, [from, to]);
    const days = card.map((c) => c.day).sort();
    const cashMap = days.length ? await cashByDay(q, card.map((c) => c.person_id), dayBefore(days[0]), days[days.length - 1]) : new Map();
    const cardKey = new Map(card.map((c) => [`${c.person_id}|${c.day}`, c.card]));
    /* The day before a window's first day is read for its cash, and its card
       too — else a window starting mid-month would call a covered day "over". */
    if (days.length) {
      for (const r of await q(`SELECT m.person_id::text AS person_id, to_char(p.txn_day, 'YYYY-MM-DD') AS day, sum(p.amount)::float AS card
          FROM card_payment p JOIN card_id_person m ON m.emirates_id = p.emirates_id
         WHERE m.person_id IS NOT NULL AND p.txn_day = $1::date - 1 GROUP BY 1, 2`, [days[0]])) cardKey.set(`${r.person_id}|${r.day}`, r.card);
    }
    const rows = card.map((c) => {
      const k = cashMap.get(`${c.person_id}|${c.day}`) || { trips: 0, cash: 0 };
      const pk = cashMap.get(`${c.person_id}|${dayBefore(c.day)}`) || { trips: 0, cash: 0 };
      return { ...c, card: r2(c.card), cash_trips: k.trips, cash: r2(k.cash),
        ...statusOf({ card: c.card, cash: k.cash, prevCash: pk.cash, prevCard: cardKey.get(`${c.person_id}|${dayBefore(c.day)}`) || 0,
          cashTrips: k.trips, prevTrips: pk.trips }) };
    });
    const by = (st) => rows.filter((r) => r.status === st);
    const sum = (xs, k) => r2(xs.reduce((a, r) => a + (r[k] || 0), 0));
    const people = new Map();
    for (const r of rows) {
      const p = people.get(r.person_id) || { person_id: r.person_id, name: r.name || null, card_days: 0, card: 0,
        over_days: 0, over_aed: 0, no_cash_days: 0, no_cash_aed: 0 };
      p.card_days += 1; p.card += r.card;
      if (r.status === 'over') { p.over_days += 1; p.over_aed += r.over_by; }
      if (r.status === 'no_cash_trips') { p.no_cash_days += 1; p.no_cash_aed += r.card; }
      people.set(r.person_id, p);
    }
    const drivers = [...people.values()].map((p) => ({ ...p, card: r2(p.card), over_aed: r2(p.over_aed), no_cash_aed: r2(p.no_cash_aed),
      unexplained_aed: r2(p.over_aed + p.no_cash_aed) }))
      .sort((a, b) => b.unexplained_aed - a.unexplained_aed || b.card - a.card);
    const flagged = rows.filter((r) => r.status === 'over' || r.status === 'no_cash_trips')
      .sort((a, b) => (b.over_by || 0) - (a.over_by || 0));
    return res.json({ from, to, ...s, currency: 'AED', allowance_aed: ALLOWANCE,
      why: s.why || (rows.length ? null : 'No card payment in this window is placed on a driver, so there is nothing to check against cash trips.'),
      totals: { driver_days: rows.length, card: sum(rows, 'card'),
        covered: by('covered').length, covered_with_day_before: by('covered_with_day_before').length,
        over: by('over').length, over_aed: sum(by('over'), 'over_by'),
        no_cash_trips: by('no_cash_trips').length, no_cash_aed: sum(by('no_cash_trips'), 'card') },
      drivers: drivers.filter((d) => d.unexplained_aed > 0).slice(0, 60),
      drivers_flagged: drivers.filter((d) => d.unexplained_aed > 0).length,
      days: flagged.slice(0, 150), days_flagged: flagged.length,
      note: 'the cash trips are the platforms\' own: a payment for a ride on no platform shows as over, and so does one the sheet put on the wrong driver' });
  }));

  app.get('/api/card/summary', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const from = dayParam(req.query.from); const to = dayParam(req.query.to);
    const s = await readState(q);
    const W = `($1::date IS NULL OR p.txn_day >= $1) AND ($2::date IS NULL OR p.txn_day <= $2)`;
    const months = await q(`SELECT to_char(date_trunc('month', p.txn_day), 'YYYY-MM') AS month, p.fleet_id, count(*)::int AS payments,
             sum(p.amount)::float AS net, coalesce(sum(p.amount) FILTER (WHERE p.amount < 0), 0)::float AS chargebacks,
             count(DISTINCT p.emirates_id)::int AS ids, count(DISTINCT p.terminal_id)::int AS terminals
        FROM card_payment p WHERE ${W} GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [from, to]);
    const [placed] = await q(`SELECT
             count(*) FILTER (WHERE m.person_id IS NOT NULL)::int AS placed_n, coalesce(sum(p.amount) FILTER (WHERE m.person_id IS NOT NULL), 0)::float AS placed,
             count(DISTINCT m.person_id)::int AS people,
             count(*) FILTER (WHERE p.emirates_id IS NULL)::int AS no_driver_n, coalesce(sum(p.amount) FILTER (WHERE p.emirates_id IS NULL), 0)::float AS no_driver,
             count(*) FILTER (WHERE p.emirates_id IS NOT NULL AND m.person_id IS NULL)::int AS unplaced_n,
             coalesce(sum(p.amount) FILTER (WHERE p.emirates_id IS NOT NULL AND m.person_id IS NULL), 0)::float AS unplaced,
             count(DISTINCT p.emirates_id) FILTER (WHERE p.emirates_id IS NOT NULL AND m.person_id IS NULL)::int AS unplaced_ids,
             count(*)::int AS payments, coalesce(sum(p.amount), 0)::float AS net
        FROM card_payment p LEFT JOIN card_id_person m ON m.emirates_id = p.emirates_id WHERE ${W}`, [from, to]);
    const noDriver = await q(`SELECT p.terminal_id, count(*)::int AS payments, sum(p.amount)::float AS net,
             array_agg(DISTINCT p.id_label) AS labels,
             to_char(min(p.txn_day), 'YYYY-MM-DD') AS first_day, to_char(max(p.txn_day), 'YYYY-MM-DD') AS last_day,
             EXISTS (SELECT 1 FROM card_payment o WHERE o.terminal_id = p.terminal_id AND o.emirates_id IS NOT NULL) AS ever_mapped
        FROM card_payment p WHERE p.emirates_id IS NULL AND ${W}
       GROUP BY p.terminal_id ORDER BY sum(p.amount) DESC LIMIT 40`, [from, to]);
    const [ndT] = await q(`SELECT count(DISTINCT p.terminal_id)::int AS n FROM card_payment p WHERE p.emirates_id IS NULL AND ${W}`, [from, to]);
    return res.json({ from, to, ...s, currency: 'AED',
      totals: { payments: placed.payments, net: r2(placed.net), placed_payments: placed.placed_n, placed: r2(placed.placed), people: placed.people,
        no_driver_payments: placed.no_driver_n, no_driver: r2(placed.no_driver),
        unplaced_payments: placed.unplaced_n, unplaced: r2(placed.unplaced), unplaced_ids: placed.unplaced_ids },
      months: months.map((m) => ({ ...m, net: r2(m.net), chargebacks: r2(m.chargebacks) })),
      no_driver_terminals: noDriver.map((x) => ({ ...x, net: r2(x.net), labels: (x.labels || []).filter(Boolean) })),
      no_driver_terminals_total: ndT.n,
      in_cash_position: false, note: NOT_IN_POSITION });
  }));

  app.get('/api/card/review', wrap(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const s = await readState(q);
    const rows = await q(`SELECT p.emirates_id, m.basis, coalesce(m.hr_people, 0) AS hr_people,
             EXISTS (SELECT 1 FROM hr_roster_row h WHERE h.emirates_id = p.emirates_id) AS on_hr,
             count(*)::int AS payments, sum(p.amount)::float AS net,
             to_char(min(p.txn_day), 'YYYY-MM-DD') AS first_day, to_char(max(p.txn_day), 'YYYY-MM-DD') AS last_day,
             array_agg(DISTINCT p.fleet_id) AS fleets, array_agg(DISTINCT p.terminal_id ORDER BY p.terminal_id) AS terminals
        FROM card_payment p LEFT JOIN card_id_person m ON m.emirates_id = p.emirates_id
       WHERE p.emirates_id IS NOT NULL AND m.person_id IS NULL
       GROUP BY p.emirates_id, m.basis, m.hr_people ORDER BY max(p.txn_day) DESC, sum(p.amount) DESC`);
    /* The reason asks hr_roster_row itself (the review of 2026-11-23): the
       view leaves out an HR row matched to no live account, so "not in the
       view" said "not on the HR export" — falsely — and served the number. */
    const whyOf = (r) => (r.basis === 'hr_ambiguous'
      ? `on the HR export, under ${r.hr_people} driver records — fold those records into one person (Same person page) and it places itself`
      : r.basis === 'link_stranded'
        ? `it was linked to a driver record that no longer exists${r.on_hr ? ', and the HR export matches it to no driver either' : ''} — link it again`
        : r.on_hr ? 'on the HR export, but that employee is matched to no driver record — match them on the HR roster page, or link it here'
          : 'not on the HR export — upload a newer export, or link it to a driver here');
    return res.json({ ...s,
      rows: rows.map((r) => ({
        ref: refOf(r.emirates_id),
        /* The number is shown only where NO HR row carries it: an HR
           document number is served by /api/driver/profile alone
           (api/redact.js HR_NUMBERS_SERVED; test/hr_roster_numbers sweeps
           this route over payments under every seeded HR number). Class DOC
           by key name (api/access/shape.js), so a role without documents
           gets null. */
        emirates_id: r.on_hr ? null : r.emirates_id,
        why: whyOf(r),
        payments: r.payments, net: r2(r.net), first_day: r.first_day, last_day: r.last_day,
        fleets: (r.fleets || []).filter(Boolean), terminals: r.terminals || [] })),
      totals: { ids: rows.length, payments: rows.reduce((a, r) => a + r.payments, 0), net: r2(rows.reduce((a, r) => a + r.net, 0)) } });
  }));

  app.post('/api/card/link', wrap(async (req, res) => {
    const who = deciderOf(req);
    if (who.error) return res.status(who.status).json({ error: who.error, detail: who.detail });
    const b = req.body || {};
    const ref = String(b.ref || '');
    const decision = b.decision === 'unlink' ? 'unlink' : b.decision === 'link' ? 'link' : null;
    const person = Number(b.person_id);
    if (!/^[0-9a-f]{16}$/.test(ref) || !decision || (decision === 'link' && !(Number.isInteger(person) && person > 0))) {
      return res.status(400).json({ error: 'bad_request', detail: 'Send ref (from /api/card/review), decision: link or unlink, and person_id to link.' });
    }
    const known = await q(`SELECT DISTINCT emirates_id FROM card_payment WHERE emirates_id IS NOT NULL
                           UNION SELECT emirates_id FROM card_id_link`);
    const eid = known.map((r) => r.emirates_id).find((e) => refOf(e) === ref);
    if (!eid) return res.status(404).json({ error: 'not_found', detail: 'No Emirates ID on the card payments has that ref.' });
    if (decision === 'unlink') {
      await q('DELETE FROM card_id_link WHERE emirates_id = $1', [eid]);
      return res.json({ ok: true, ref, decision });
    }
    const [d] = await q('SELECT 1 FROM driver WHERE id = $1', [person]);
    if (!d) return res.status(404).json({ error: 'not_found', detail: 'No person has that id.' });
    /* An earlier decision for another driver is not silently overwritten
       (the review of 2026-11-23; POST /api/charging/link answers 409 the same
       way): two people on stale pages must not clobber each other. A link to
       a person since removed is no decision any more and is replaced. */
    const [prev] = await q(`SELECT l.person_id::text AS person_id FROM card_id_link l
                             WHERE l.emirates_id = $1 AND EXISTS (SELECT 1 FROM driver x WHERE x.id = l.person_id)`, [eid]);
    if (prev && prev.person_id !== String(person) && b.replace !== true) {
      return res.status(409).json({ error: 'already_linked', person_id: prev.person_id,
        detail: 'This Emirates ID is already linked to another driver. Unlink it first, or send replace: true.' });
    }
    await q(`INSERT INTO card_id_link (emirates_id, person_id, decided_by) VALUES ($1, $2, $3)
             ON CONFLICT (emirates_id) DO UPDATE SET person_id = EXCLUDED.person_id, decided_by = EXCLUDED.decided_by, decided_at = now()`,
    [eid, person, who.by]);
    return res.json({ ok: true, ref, decision, person_id: String(person) });
  }));
}
