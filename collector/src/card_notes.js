/* CASH IN NOTES — the shared definition (FIX-STATUS CARD-3, CARD-3b, CARD-4).
   ─────────────────────────────────────────────────────────────────────────
   What card payments (Network International, src/sources/network_cards.js)
   paid of a driver's cash fares, per person per Dubai day, and what that
   leaves in notes. ONE definition, read by:
     · GET /api/card/notes and /api/card/driver (api/card_routes.js);
     · the cash-fare ceiling, /api/ledger/exposure owes.cash_taken
       (api/ledger_routes.js), and its weekly history (api/history_routes.js);
     · the driver's cash-taken tiles (api/register_routes.js,
       api/driver_routes.js);
     · the cash text (src/driver_sms.js cashDepositRun).
   A second copy of this arithmetic anywhere is how two pages come to show
   two different figures for the same driver's cash.

   FROM AUGUST (the operator, 2026-11-24: "approve from August"). Measured on
   production the same day, the fares we hold explain 85–91% of card money a
   month from August 2026; January to July, 29–61% of it had no fare to set
   it against (no hotel card-machine fare is held before July, and the cash
   fares we hold fall from 106k in February to 19k in March — COVERAGE). So
   the figures that take card off — the ceiling, the tiles, the history —
   take it off fare days from NET_FROM on; the preview still shows any window
   asked for. */
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
export const NET_FROM = '2026-08-01';
export const daysBack = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) - n * 864e5).toISOString().slice(0, 10);
export const dayBefore = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
export const dubaiToday = (now = Date.now()) => new Date(now + 4 * 3600e3).toISOString().slice(0, 10);
const dmy = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).replace('Sept', 'Sep');
const aedW = (v) => `AED ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const NET_WHY = 'the operator approved taking card off from August on 24 Nov 2026; before then the fares we hold explain too little of the card money to take it off';

/* The fares a driver collects on, per person per Dubai day, over [lo, hi]:
   CASH trips (trip_cash) and the hotel channel's POS-DRIVER trips — the
   hotel's own word for a fare paid on the driver's card machine. Measured on
   production the day CARD-2 went live: the three drivers with the most card
   money "not explained" each had ~135 card days and no cash trip on any —
   they drive the hotel channel, where the card-machine fares are filed
   'pos-driver', never 'cash'. Against cash + pos-driver, their November days
   matched to the fils on 6 of 12 and 7 of 19. ('pos-supervisor' is the
   supervisor's machine, 'cash-supervisor' cash paid to the supervisor:
   neither is the driver's.)

   Accounts first, then the trips by their account ids, so the read rides the
   (driver_ext_id, requested_at) index rather than the views over every trip
   (the whole year took 4.5–6.6 s joined the other way round). */
export async function cashByDay(q, personIds, lo, hi, { live = false } = {}) {
  const ids = [...new Set(personIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const out = new Map();
  if (!ids.length || !lo || !hi) return out;
  const accts = await q(`SELECT platform, external_id, driver_id::text AS person_id FROM driver_platform_id
                          WHERE detached_at IS NULL AND driver_id = ANY($1::bigint[])`, [ids]);
  if (!accts.length) return out;
  const who = new Map(accts.map((a) => [`${a.platform}|${a.external_id}`, a.person_id]));
  const exts = [...new Set(accts.map((a) => a.external_id))];
  /* CARD-3: the collector's per-account-day sums (sql/schema_v128.sql) once a
     full rebuild has finished AND the range starts on or after the first day
     it covered ('fares_from'); the trip views, live, otherwise — a range
     reaching before the table read as no fares at all (the review of
     2026-11-24). */
  const st = Object.fromEntries((await q(`SELECT key, value FROM source_state WHERE source = 'network_cards' AND fleet_id = '-'
                                            AND key IN ('fares_full_at', 'fares_from')`)).map((r) => [r.key, r.value]));
  /* live: the cash text reads the trip views for its two days, so the card
     part is worked out against the same figures it asks for (the review of
     2026-11-24: card_fare_day can be an hour behind a catch-up that lifted a
     fare to Uber's cash figure). */
  const ready = !live && !!(st.fares_full_at && st.fares_from && lo >= st.fares_from);
  const rows = ready ? await q(`SELECT platform, driver_ext_id, to_char(day, 'YYYY-MM-DD') AS day, cash::float AS cash, cash_trips,
                                       cash_unvalued, pos::float AS pos, pos_trips
                                  FROM card_fare_day WHERE driver_ext_id = ANY($1::text[]) AND day BETWEEN $2 AND $3`, [exts, lo, hi])
    : await q(`SELECT platform, driver_ext_id, day, sum(cash)::float AS cash, sum(cash_n)::int AS cash_trips,
                               sum(cash_nv)::int AS cash_unvalued, sum(pos)::float AS pos, sum(pos_n)::int AS pos_trips
                          FROM (
                            SELECT tc.platform, tc.driver_ext_id, to_char((tc.requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day,
                                   coalesce(tc.cash_amount, 0) AS cash, 1 AS cash_n,
                                   CASE WHEN tc.cash_amount IS NULL THEN 1 ELSE 0 END AS cash_nv, 0::numeric AS pos, 0 AS pos_n
                              FROM trip_cash tc
                             WHERE tc.driver_ext_id = ANY($1::text[])
                               AND tc.requested_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Dubai')
                               AND tc.requested_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
                            UNION ALL
                            SELECT te.platform, te.driver_ext_id, to_char((te.requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD'),
                                   0, 0, 0, coalesce(te.price, 0), 1
                              FROM trip_ext te
                             WHERE te.driver_ext_id = ANY($1::text[]) AND lower(coalesce(te.payment_type, '')) = 'pos-driver'
                               AND te.outcome = 'completed'
                               AND te.requested_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Dubai')
                               AND te.requested_at <  (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')
                          ) x GROUP BY 1, 2, 3`, [exts, lo, hi]);
  for (const r of rows) {
    const pid = who.get(`${r.platform}|${r.driver_ext_id}`);
    if (!pid) continue;                     // the same id on another platform is someone else's
    const k = `${pid}|${r.day}`;
    const cur = out.get(k) || { cash: 0, cash_trips: 0, cash_unvalued: 0, pos: 0, pos_trips: 0 };
    cur.cash += r.cash; cur.cash_trips += r.cash_trips; cur.cash_unvalued += r.cash_unvalued || 0; cur.pos += r.pos; cur.pos_trips += r.pos_trips;
    out.set(k, cur);
  }
  return out;
}
/* What a day's card may be measured against: cash + card-machine fares. */
export const NONE = { cash: 0, cash_trips: 0, cash_unvalued: 0, pos: 0, pos_trips: 0 };

/* CASH IN NOTES (FIX-STATUS CARD-3; the operator chose it 2026-11-24: "net
   card off cash fares"). For one driver, day by day in order:
     · the day's card payments — chargebacks left out: "the fare isn't lost,
       it usually comes back", so a chargeback never puts cash back in a hand;
     · settle the hotel's pos-driver fares first (paid on the driver's own
       card machine — never counted as cash, so never taken off cash);
     · the rest settles that day's cash fares, then the day before's (a fare
       taken before midnight, paid after it — one day back, never further);
     · whatever is left is NOT EXPLAINED and is not taken off anything: card
       money beyond the fares collected is a ride on no platform or a payment
       the sheet put on the wrong driver, never cash the driver did not take.
   Booked on the FARE's day: on_cash is the part of THIS day's cash fares paid
   by card — its own card, plus the next day's (paid_next_day) — so over any
   run of days Σcash − Σon_cash = Σnotes. Card on a day that paid the day
   before's fares is paid_prev_day. (The review of 2026-11-24: booked on the
   card's day, a window starting the day after a carry showed cash 50, paid
   by card 100, "200% by card".) Per row, card = on_pos + (on_cash −
   paid_next_day) + paid_prev_day + unexplained. */
export function allocate(days) {
  const out = []; let prev = null;
  for (const d of [...days].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))) {
    const cash = d.cash || 0; const pos = d.pos || 0;
    const pay = Math.max(0, d.pay || 0);
    const onPos = Math.min(pay, pos);
    let rest = pay - onPos;
    const useOwn = Math.min(rest, cash); rest -= useOwn;
    let useCarry = 0;
    if (rest > 0 && prev && prev.day === dayBefore(d.day) && prev.leftover > 0) {
      useCarry = Math.min(rest, prev.leftover);
      prev.leftover -= useCarry; prev.row.on_cash += useCarry; prev.row.notes -= useCarry; prev.row.paid_next_day += useCarry;
      rest -= useCarry;
    }
    const row = { day: d.day, cash, cash_unvalued: d.cash_unvalued || 0, pos, card: pay, on_pos: onPos, on_cash: useOwn,
      paid_next_day: 0, paid_prev_day: useCarry, unexplained: rest, notes: cash - useOwn };
    out.push(row);
    prev = { day: d.day, leftover: cash - useOwn, row };
  }
  return out.map((r) => ({ ...r, cash: r2(r.cash), pos: r2(r.pos), card: r2(r.card), on_pos: r2(r.on_pos), on_cash: r2(r.on_cash),
    unexplained: r2(r.unexplained), paid_next_day: r2(r.paid_next_day), paid_prev_day: r2(r.paid_prev_day), notes: r2(r.notes) }));
}

/* Each placed driver with a card payment in [from, to] (personIds narrows
   it): cash fares, card, what card paid of the pos-driver fares (on_pos) and
   of the cash fares (on_cash, booked on the FARE's day), what it did not
   explain, what is left in notes, card on `from` that paid the day before's
   fares (paid_before_window), chargebacks (never put back). Over the window,
   cash − on_cash = notes and on_pos + on_cash + paid_before_window +
   unexplained = card. The day before `from` is read for the carry only: a
   driver whose only card payment is that day is not in the window. */
export async function notesByPerson(q, { from, to, personIds = null, withDays = false, live = false, today = dubaiToday() }) {
  const ids = personIds == null ? null : [...new Set(personIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!from || !to || from > to || (ids && !ids.length)) return [];
  /* THE DAY AFTER `to` IS READ TOO (the review of 2026-11-24): card just after
     midnight that paid `to`'s last fares is booked on `to` (on_cash), and read
     only up to `to` it came off no window at all — October asked alone and
     November asked alone took it off neither. It is read for that carry only:
     its own card and fares stay out of the window. Never past today. */
  const after = to < today ? daysBack(to, -1) : to;
  const card = await q(`SELECT m.person_id::text AS person_id, d.full_name AS name, to_char(p.txn_day, 'YYYY-MM-DD') AS day,
           coalesce(sum(p.amount) FILTER (WHERE p.amount > 0), 0)::float AS pay,
           coalesce(sum(p.amount) FILTER (WHERE p.amount < 0), 0)::float AS chargebacks
      FROM card_payment p JOIN card_id_person m ON m.emirates_id = p.emirates_id LEFT JOIN driver d ON d.id = m.person_id
     WHERE m.person_id IS NOT NULL AND p.txn_day BETWEEN $1::date - 1 AND $2
       AND ($3::bigint[] IS NULL OR m.person_id = ANY($3::bigint[]))
     GROUP BY m.person_id, d.full_name, p.txn_day`, [from, after, ids]);
  const people = new Map();
  for (const c of card) {
    const p = people.get(c.person_id) || { person_id: c.person_id, name: c.name || null, pay: new Map(), chargebacks: 0, inWindow: false };
    p.pay.set(c.day, c.pay);
    if (c.day >= from && c.day <= to) { p.chargebacks += c.chargebacks; p.inWindow = true; }
    people.set(c.person_id, p);
  }
  for (const [k, p] of people) if (!p.inWindow) people.delete(k);
  const cashMap = await cashByDay(q, [...people.keys()], dayBefore(from), after, { live });
  /* Each person's fare days, in one pass over the map (a year is ~30,000 keys). */
  const fareDays = new Map();
  for (const k of cashMap.keys()) {
    const [pid, day] = k.split('|');
    if (!fareDays.has(pid)) fareDays.set(pid, []);
    fareDays.get(pid).push(day);
  }
  const rows = [];
  for (const p of people.values()) {
    const days = new Set([...p.pay.keys(), ...(fareDays.get(p.person_id) || [])]);
    const alloc = allocate([...days].map((day) => {
      const k = cashMap.get(`${p.person_id}|${day}`) || NONE;
      return { day, cash: k.cash, cash_unvalued: k.cash_unvalued, pos: k.pos, pay: p.pay.get(day) || 0 };
    })).filter((r) => r.day >= from && r.day <= to);
    const sum = (k) => r2(alloc.reduce((a, r) => a + (r[k] || 0), 0));
    const last = alloc.find((r) => r.day === to) || null;
    const first = alloc.find((r) => r.day === from);
    rows.push({ person_id: p.person_id, name: p.name, cash: sum('cash'), cash_unvalued: alloc.reduce((a, r) => a + (r.cash_unvalued || 0), 0),
      card: sum('card'), on_cash: sum('on_cash'), on_pos: sum('on_pos'),
      unexplained: sum('unexplained'), notes: sum('notes'), paid_before_window: r2(first?.paid_prev_day || 0), chargebacks: r2(p.chargebacks),
      card_days: alloc.filter((r) => r.card > 0).length,
      latest: last ? { day: last.day, cash: last.cash, cash_unvalued: last.cash_unvalued, on_cash: last.on_cash, notes: last.notes }
        : { day: to, cash: 0, cash_unvalued: 0, on_cash: 0, notes: 0 },
      ...(withDays ? { days: alloc } : {}) });
  }
  return rows;
}

/* Whether card payments can be taken off at all: the sheet must have been
   read. Never read, nothing is known to have been paid by card — which is
   not the same as nothing having been (the house rule: absent, with the
   reason). */
export async function cardSheet(q, { day = null } = {}) {
  const [ok] = await q(`SELECT read_at FROM card_import WHERE status = 'ok' ORDER BY read_at DESC, id DESC LIMIT 1`);
  /* THE LAST DAY THE SHEET REALLY HAS (the review of 2026-11-24): a row typed
     with a future date (the sheet is kept by hand; COVERAGE records one dated
     a month ahead) must not make every day look covered — the cash text's gate
     would open each morning before that day's card was in. Rows dated after
     the Dubai day of the read are not counted. */
  const readDay = ok?.read_at ? dubaiToday(new Date(ok.read_at).getTime()) : null;
  const [cov] = readDay ? await q(`SELECT to_char(max(txn_day) FILTER (WHERE txn_day <= $1::date), 'YYYY-MM-DD') AS last_day,
      count(*) FILTER (WHERE txn_day = $2::date)::int AS day_rows,
      count(*) FILTER (WHERE txn_day > $1::date)::int AS future_rows
      FROM card_payment`, [readDay, day]) : [];
  return { read_at: ok?.read_at || null, covers_to: cov?.last_day || null, day_rows: cov?.day_rows ?? 0, future_rows: cov?.future_rows ?? 0,
    absent: ok ? null : 'the card payments sheet has never been read, so nothing paid by card is known to take off' };
}

/* What card paid of each person's cash fares over [from, to] ∩ [NET_FROM, …):
   the term the ceiling and the tiles take off. by: person_id → {on_cash,
   on_pos, card, unexplained}; a person absent from it had no card payment
   there (0 taken off). absent: the true reason nothing can be taken off. */
export async function cardNet(q, personIds, { from = null, to, today = dubaiToday() }) {
  const lo = from && from > NET_FROM ? from : NET_FROM;
  const out = { from: lo, to, card_to: null, absent: null, by: new Map(), noId: new Set() };
  if (!to || to < NET_FROM) return { ...out, absent: `card payments are taken off fares from ${dmy(NET_FROM)}, and these dates end before then` };
  if (lo > today) return { ...out, absent: 'these dates have not happened yet' };
  if (to < lo) return { ...out, absent: 'these dates hold no day to take card off' };
  const sheet = await cardSheet(q);
  if (sheet.absent) return { ...out, absent: sheet.absent };
  /* Only through the sheet's last day: a fare after it has no card figure
     yet, which is not the same as none (said in the means). */
  const cardTo = sheet.covers_to && sheet.covers_to < to ? sheet.covers_to : to;
  if (cardTo < lo) return { ...out, absent: `the card payments sheet runs to ${sheet.covers_to}, before these dates` };
  out.card_to = cardTo;
  for (const r of await notesByPerson(q, { from: lo, to: cardTo, personIds, today })) {
    out.by.set(String(r.person_id), { on_cash: r.on_cash, on_pos: r.on_pos, card: r.card, unexplained: r.unexplained });
  }
  /* A person with no Emirates ID known (not on the HR export, not linked) can
     have no card payment placed on them: their card part is unknown, never 0
     (the review of 2026-11-24). */
  const ids = (personIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) {
    const known = new Set((await q(`SELECT DISTINCT person_id::text AS p FROM card_id_person WHERE person_id = ANY($1::bigint[])`, [ids])).map((r) => r.p));
    for (const id of ids) if (!known.has(String(id))) out.noId.add(String(id));
  }
  return out;
}

/* One person's card part from a cardNet answer: { card, absent }. card is
   null exactly when it cannot be known, and absent then says why. */
export const NO_ID_WHY = 'no Emirates ID is known for this driver (not on the HR export, and nobody has linked one), so no card payment can be placed on them';
export function cardPartFor(net, personId) {
  if (net.absent) return { card: null, absent: net.absent };
  if (net.noId?.has(String(personId))) return { card: null, absent: NO_ID_WHY };
  return { card: r2(net.by.get(String(personId))?.on_cash || 0), absent: null };
}
const thruWords = (net) => (net.card_to && net.to && net.card_to < net.to
  ? ` to ${dmy(net.card_to)}, the card sheet's last day (a fare after it has no card figure yet)` : '');

/* Take the term off one exposure row's ceiling (owes), keeping both parts
   beside it: cash_taken_gross (every cash fare on record), cash_taken_card
   (what card settled of the fares from cash_taken_card_from), and the true
   reason when nothing could be taken off. */
export function applyCardNet(owes, net, personId) {
  if (!owes || owes.cash_taken == null) return owes;
  const gross = owes.cash_taken;
  const { card, absent } = cardPartFor(net, personId);
  return Object.assign(owes, {
    cash_taken: card == null ? gross : r2(gross - card),
    cash_taken_gross: gross,
    cash_taken_card: card,
    cash_taken_card_from: net.from,
    cash_taken_card_to: card == null ? null : net.card_to,
    cash_taken_card_absent_reason: absent,
    cash_taken_means: card == null
      ? `every cash fare on record went into this driver's hand. Card payments are not taken off: ${absent}. It is a CEILING on what `
        + 'they could still be holding, not a balance.'
      : `every cash fare on record went into this driver's hand, less ${aedW(card)} that card payments settled of the fares from `
        + `${dmy(net.from)}${thruWords(net)} (${NET_WHY}). It is a CEILING on what they could still be holding, not a balance — it comes `
        + 'down when a hand-in is recorded, and none is until somebody records one.',
  });
}

/* Card that paid cash fares, per FARE day, summed over every placed person
   with a name (the ledger's people) — the term the ceiling's weekly history
   takes off. */
export async function onCashByDay(q, { from = NET_FROM, to }) {
  const by = new Map();
  if (!to || to < from) return by;
  for (const r of await notesByPerson(q, { from, to, withDays: true })) {
    if (!r.name) continue;
    for (const d of r.days) if (d.on_cash) by.set(d.day, (by.get(d.day) || 0) + d.on_cash);
  }
  return by;
}
