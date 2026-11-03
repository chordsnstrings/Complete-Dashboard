/* CHARGING — PowerDrive wallets, the links to our people, and sessions.
   ─────────────────────────────────────────────────────────────────────────
   The read side of src/sources/yocharge.js (its header has the whole story:
   the MENA host, the precise link rule, watt-hours). Four reads and one write:

     GET  /api/charging/wallets   every linked person's wallet (CASH)
     GET  /api/charging/review    the review queue — candidates with their
                                  reason — and the customers in our fleet
                                  groups we cannot place (MRG: the people who
                                  decide them can read it without the cash)
     GET  /api/charging/sessions  charging in a window, by car, by driver, by
                                  day and by site — each car's count saying how
                                  it was put on the car
     GET  /api/charging/driver    one person: their wallet(s) and recent sessions
     GET  /api/charging/vehicle   one car: its charging in the window
     POST /api/charging/link      confirm or refuse a candidate (a signed-in
                                  holder of identity.decide: the Owner,
                                  Management, an HR officer)

   A CHARGE is a session that delivered energy (kWh > 0). PowerDrive also files
   cancelled and zero-energy sessions; they are counted apart, never as charges.
   A wallet balance is a named driver's money. No link, no balance: a person
   with no wallet linked reads "no charging wallet linked", never AED 0.
   Phones never leave this file whole — the last three digits, enough to tell
   two numbers apart on the review list. */
import { dubaiDay, winDays } from './window.js';
import { get } from '../src/settings.js';

const tail = (p) => (p ? `•••••••${String(p).slice(-3)}` : null);
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100);
/* Only links whose person still exists: a decision stranded by a fold the
   link did not follow is held back for review by the collector, not shown as
   "person 4" (src/charging_links.js has the story). */
const LINK_SQL = `SELECT DISTINCT ON (c.yc_user_id) c.yc_user_id, c.person_id, c.tier FROM charging_link c
                   WHERE c.tier IN ('confirmed', 'auto') AND EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id)
                   ORDER BY c.yc_user_id, (c.tier = 'confirmed') DESC, c.person_id`;
const BASES = ['session_plate', 'only_car', 'nearest_trip'];

/** Who may decide a link: a signed-in person holding identity.decide — the
    cap that decides same-person pairs (the Owner, Management, HR officers).
    Saying a PowerDrive customer IS one of our people is that same decision,
    and the manifest names the same cap, so the gate and this agree. */
export function deciderOf(req) {
  const fm = req.fm;
  if (fm?.kind !== 'user') return { status: 401, error: 'signin', detail: 'Sign in to confirm or refuse a charging wallet — it decides whose money a balance is.' };
  const caps = fm.access?.caps || [];
  if (!caps.includes('identity.decide')) {
    return { status: 403, error: 'not_allowed', detail: 'Only the Owner, Management and HR officers decide whose a charging wallet is — the people who decide same-person pairs.' };
  }
  return { by: fm.user?.email || String(fm.user?.id ?? 'user') };
}

/* WHEN PowerDrive WAS LAST READ — successfully. The first build took the
   latest run of any outcome, so after a revoked key the pages said "last
   read <the time of the failure>" above balances frozen since the last good
   read, with no warning (the review, 2026-11-03). Now synced_at is the last
   good (or partial) run, and `failed` carries the latest run's failure when
   it is newer — every page that shows a figure says it. */
async function syncState(q) {
  const [r] = await q(`SELECT max(finished_at) FILTER (WHERE status IN ('ok', 'partial')) AS at,
                              (array_agg(status ORDER BY finished_at DESC))[1] AS status,
                              (array_agg(error ORDER BY finished_at DESC))[1] AS error,
                              max(finished_at) AS last_at
                         FROM collection_run WHERE source = 'yocharge'`);
  const [u] = await q(`SELECT count(*)::int AS customers, max(fetched_at) AS fetched FROM charging_user`);
  /* How many the last read SAW: strangers are not kept as rows
     (src/sources/yocharge.js pruneStrangers), only counted. */
  const [seen] = await q(`SELECT value FROM source_state WHERE source = 'yocharge' AND fleet_id = '-' AND key = 'customers_read'`);
  const read = Number(seen?.value);
  const failed = r?.status === 'error' || r?.status === 'partial'
    ? { at: r.last_at, status: r.status, error: r.error || (r.status === 'error' ? 'the run failed' : 'part of the run failed') } : null;
  return { synced_at: r?.at || null, status: r?.status || null, error: r?.status === 'error' ? (r.error || null) : null, failed,
    customers: u?.customers || 0, customers_read: Number.isFinite(read) && read > 0 ? read : null, wallets_at: u?.fetched || null };
}
/* PowerDrive's names for our fleets, read where they are kept: the API
   process never loads settings outside the settings routes, so get() alone
   could answer with a value from before a save (the review, 2026-11-03). */
async function fleetGroupsOf(q) {
  const [s] = await q(`SELECT value FROM app_setting WHERE key = 'YOCHARGE_FLEET_GROUPS'`).catch(() => []);
  /* A saved value is used as saved, an empty one included, as the collector
     uses it; the default only when nothing is saved. */
  const raw = s ? String(s.value ?? '') : String(get('YOCHARGE_FLEET_GROUPS', 'ecofleet,egari,ecofleet investor fleet'));
  return raw.split(',').map((x) => x.trim()).filter(Boolean).join(',');
}
const whyOf = (s) => (s.customers ? null
  : s.status === 'error' ? `PowerDrive has not been read: ${s.error || 'the last run failed'}.`
    : 'PowerDrive has not been read yet — the charging collector runs every six hours once its key and client id are set (Settings → Charging).');

/* The page's own range, read the way every other route reads it (winDays:
   from/to, a named period, days). Nothing sent means winDays' open sentinels,
   2000-01-01 to 2100-01-01 — read here as the last thirty days to today, and an
   end past today as today, so the label a page prints is a range a person
   would recognise. */
function windowOf(req, days = 30) {
  const today = dubaiDay(new Date());
  let [from, to] = winDays(req);
  if (to > today) to = today;
  if (from === '2000-01-01') from = new Date(Date.parse(`${to}T12:00:00Z`) - (days - 1) * 864e5).toISOString().slice(0, 10);
  if (from > to) from = to;   // a window wholly after today is today, never a backwards label
  return { from, to };
}
const SPAN = `cs.started_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Dubai')
          AND cs.started_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`;

/** How many wait in the queue, for the wallets' tile. */
async function reviewCounts(q) {
  const groups = await fleetGroupsOf(q);
  const [r] = await q(`SELECT
      (SELECT count(*) FROM charging_link c WHERE c.tier IN ('candidate', 'held')
          AND EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id)
          AND NOT EXISTS (SELECT 1 FROM charging_link x WHERE x.yc_user_id = c.yc_user_id AND x.tier IN ('confirmed', 'auto')
                            AND EXISTS (SELECT 1 FROM driver dd WHERE dd.id = x.person_id)))::int AS review,
      (SELECT count(*) FROM charging_user u
        WHERE (lower(u.fleet_group) = ANY(string_to_array(lower($1), ','))
               OR EXISTS (SELECT 1 FROM charging_link s WHERE s.yc_user_id = u.yc_user_id
                            AND NOT EXISTS (SELECT 1 FROM driver d WHERE d.id = s.person_id)))
          AND NOT EXISTS (SELECT 1 FROM charging_link c WHERE c.yc_user_id = u.yc_user_id AND c.tier <> 'refused'
                            AND EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id)))::int AS unplaced`, [groups]);
  return r || { review: 0, unplaced: 0 };
}

export function chargingRoutes(app, { q, wrap }) {
  app.get('/api/charging/wallets', wrap(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const s = await syncState(q);
    const [rows, reviewN, groupsRow] = await Promise.all([
      q(`WITH link AS (${LINK_SQL})
         SELECT l.person_id::text AS person_id, l.tier, u.yc_user_id, d.full_name AS name, u.balance, u.hold_amount,
                u.using_fleet_wallet, u.fleet_limit, u.fleet_limit_available, u.fleet_group, u.last_session_at,
                (SELECT count(*) FROM charging_session cs WHERE cs.yc_user_id = u.yc_user_id AND cs.kwh > 0
                   AND cs.started_at > now() - interval '30 days')::int AS charges_30d
           FROM link l JOIN charging_user u ON u.yc_user_id = l.yc_user_id
           LEFT JOIN driver d ON d.id = l.person_id
          ORDER BY d.full_name NULLS LAST, u.yc_user_id`),
      reviewCounts(q),
      q(`SELECT count(DISTINCT lower(fleet_group))::int AS n FROM charging_user WHERE fleet_group IS NOT NULL`),
    ]);
    const out = rows.map((r) => ({
      person_id: r.person_id, name: r.name || null, tier: r.tier, yc_user_id: r.yc_user_id,
      balance: r2(r.balance), hold_amount: r2(r.hold_amount), using_fleet_wallet: !!r.using_fleet_wallet,
      fleet_limit: r2(r.fleet_limit), fleet_limit_available: r2(r.fleet_limit_available), fleet_group: r.fleet_group || null,
      last_session_at: r.last_session_at, charges_30d: r.charges_30d,
    }));
    const people = new Set(out.map((r) => r.person_id));
    /* A customer with no PERSONAL wallet has no balance — null, never 0 —
       and the total says how many it could not count (the review). */
    const known = out.filter((r) => r.balance != null);
    return res.json({
      ...s, why: whyOf(s), currency: 'AED',
      totals: {
        linked_people: people.size, linked_wallets: out.length,
        balance: known.length ? r2(known.reduce((a, r) => a + r.balance, 0)) : null, balance_unknown: out.length - known.length,
        nonzero: known.filter((r) => r.balance).length, negative: known.filter((r) => r.balance < 0).length,
        on_fleet_wallet: out.filter((r) => r.using_fleet_wallet).length,
        auto: out.filter((r) => r.tier === 'auto').length, confirmed: out.filter((r) => r.tier === 'confirmed').length,
        review: reviewN.review, unplaced: reviewN.unplaced, fleet_groups_seen: groupsRow[0]?.n || 0,
      },
      rows: out,
    });
  }));

  /* THE QUEUE, on its own (the review, 2026-11-03): it lived inside
     /api/charging/wallets, whose subject is CASH, so an HR officer — who
     holds identity.decide, the cap that decides these — was refused the page
     that holds the buttons. Its subject is MRG, the same-person decisions. */
  app.get('/api/charging/review', wrap(async (_req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const s = await syncState(q);
    const groups = await fleetGroupsOf(q);
    const [review, unplaced] = await Promise.all([
      q(`SELECT c.yc_user_id, c.person_id::text AS person_id, c.tier, c.reason, u.name AS yc_name, u.phone_norm, u.fleet_group,
                d.full_name AS our_name
           FROM charging_link c JOIN charging_user u ON u.yc_user_id = c.yc_user_id
           JOIN driver d ON d.id = c.person_id
          WHERE c.tier IN ('candidate', 'held')
            AND NOT EXISTS (SELECT 1 FROM charging_link x WHERE x.yc_user_id = c.yc_user_id AND x.tier IN ('confirmed', 'auto')
                              AND EXISTS (SELECT 1 FROM driver dd WHERE dd.id = x.person_id))
          ORDER BY (c.tier = 'held') DESC, u.name, c.person_id`),
      /* Unplaced: in our fleet groups, or carrying a decision about a person
         record that no longer exists (the second review: such a customer was
         in no list at all), and with no live link a person could act on. */
      q(`SELECT u.yc_user_id, u.name, u.phone_norm, u.fleet_group,
                EXISTS (SELECT 1 FROM charging_link s WHERE s.yc_user_id = u.yc_user_id
                          AND NOT EXISTS (SELECT 1 FROM driver d WHERE d.id = s.person_id)) AS stranded
           FROM charging_user u
          WHERE (lower(u.fleet_group) = ANY(string_to_array(lower($1), ','))
                 OR EXISTS (SELECT 1 FROM charging_link s WHERE s.yc_user_id = u.yc_user_id
                              AND NOT EXISTS (SELECT 1 FROM driver d WHERE d.id = s.person_id)))
            AND NOT EXISTS (SELECT 1 FROM charging_link c WHERE c.yc_user_id = u.yc_user_id AND c.tier <> 'refused'
                              AND EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id))
          ORDER BY u.fleet_group, u.name`, [groups]),
    ]);
    return res.json({ ...s, why: whyOf(s),
      review: review.map((r) => ({ yc_user_id: r.yc_user_id, person_id: r.person_id, tier: r.tier, reason: r.reason,
        yc_name: r.yc_name || null, yc_phone: tail(r.phone_norm), yc_fleet_group: r.fleet_group || null, our_name: r.our_name || null })),
      unplaced: unplaced.map((r) => ({ yc_user_id: r.yc_user_id, yc_name: r.name || null, yc_phone: tail(r.phone_norm),
        yc_fleet_group: r.fleet_group || null, stranded: !!r.stranded })),
    });
  }));

  app.post('/api/charging/link', wrap(async (req, res) => {
    const who = deciderOf(req);
    if (who.error) return res.status(who.status).json({ error: who.error, detail: who.detail });
    const b = req.body || {};
    const yc = String(b.yc_user_id || '');
    const person = Number(b.person_id);
    const decision = b.decision === 'confirm' ? 'confirmed' : b.decision === 'refuse' ? 'refused' : null;
    if (!yc || !Number.isInteger(person) || person <= 0 || !decision) {
      return res.status(400).json({ error: 'bad_request', detail: 'Send yc_user_id, person_id and decision: confirm or refuse.' });
    }
    const [u] = await q('SELECT 1 FROM charging_user WHERE yc_user_id = $1', [yc]);
    const [d] = await q('SELECT 1 FROM driver WHERE id = $1', [person]);
    if (!u || !d) return res.status(404).json({ error: 'not_found', detail: !u ? 'No PowerDrive customer has that id.' : 'No person has that id.' });
    if (decision === 'confirmed') {
      /* One customer is one person. Already confirmed as somebody else: say
         so, and change nothing — the earlier decision is refused first, by a
         person, not overwritten here (the review, 2026-11-03). */
      const [other] = await q(`SELECT c.person_id::text AS p FROM charging_link c
                                WHERE c.yc_user_id = $1 AND c.person_id <> $2 AND c.tier = 'confirmed'
                                  AND EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id)`, [yc, person]);
      if (other) {
        return res.status(409).json({ error: 'already_confirmed', person_id: other.p,
          detail: 'This PowerDrive customer is already confirmed as another of our people. Refuse that link first.' });
      }
      /* Confirming retires every other suggestion for that customer — it is
         not two people's wallet. */
      await q(`DELETE FROM charging_link WHERE yc_user_id = $1 AND person_id <> $2 AND tier IN ('auto', 'candidate', 'held')`, [yc, person]);
      /* …and any decision about it that names a person record that no longer
         exists: this confirmation replaces it (the second review: it
         answered 409 for a dead person, and refusing that answered 404). */
      await q(`DELETE FROM charging_link c WHERE c.yc_user_id = $1 AND NOT EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id)`, [yc]);
    }
    try {
      await q(`INSERT INTO charging_link (yc_user_id, person_id, tier, reason, decided_by, decided_at)
               VALUES ($1, $2, $3, $4, $5, now())
               ON CONFLICT (yc_user_id, person_id) DO UPDATE SET tier = EXCLUDED.tier, reason = EXCLUDED.reason,
                 decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [yc, person, decision, decision === 'confirmed' ? 'confirmed by a person' : 'refused by a person', who.by]);
    } catch (e) {
      /* Two confirmations of one customer sent at once: the second meets the
         one-confirmation index (sql/schema_v114.sql) — the same answer. */
      if (e.code === '23505') {
        return res.status(409).json({ error: 'already_confirmed',
          detail: 'This PowerDrive customer was just confirmed as another of our people. Refuse that link first.' });
      }
      throw e;
    }
    /* Its charges are put on cars again on the next run, against the person
       it now belongs to (or none). */
    await q(`UPDATE charging_session SET plate = NULL, plate_basis = NULL WHERE yc_user_id = $1`, [yc]);
    return res.json({ ok: true, yc_user_id: yc, person_id: String(person), tier: decision });
  }));

  app.get('/api/charging/sessions', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const { from, to } = windowOf(req);
    const s = await syncState(q);
    const P = [from, to];
    const [tot, cars, drivers, days, sites] = await Promise.all([
      q(`SELECT count(*)::int AS sessions, count(*) FILTER (WHERE cs.kwh > 0)::int AS charges,
                count(*) FILTER (WHERE cs.kwh IS NOT NULL AND cs.kwh <= 0)::int AS no_energy,
                count(*) FILTER (WHERE cs.kwh IS NULL)::int AS energy_unknown,
                coalesce(round(sum(cs.kwh) FILTER (WHERE cs.kwh > 0), 1), 0)::float AS kwh,
                round(sum(cs.cost_incl_vat) FILTER (WHERE cs.kwh > 0), 2)::float AS cost,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.cost_incl_vat IS NULL)::int AS cost_unknown,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate IS NOT NULL)::int AS on_a_car,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate_basis = 'session_plate')::int AS session_plate,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate_basis = 'only_car')::int AS only_car,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate_basis = 'nearest_trip')::int AS nearest_trip,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate_basis = 'no_trip')::int AS no_trip,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate_basis = 'no_link')::int AS no_link,
                count(*) FILTER (WHERE cs.kwh > 0 AND cs.plate_basis IS NULL)::int AS not_yet
           FROM charging_session cs WHERE ${SPAN}`, P),
      q(`SELECT cs.plate, count(*)::int AS charges, round(sum(cs.kwh), 1)::float AS kwh,
                round(sum(cs.cost_incl_vat), 2)::float AS cost, round(sum(coalesce(cs.charging_s, cs.duration_s, 0)) / 60.0)::int AS minutes,
                max(cs.started_at) AS last_at, count(DISTINCT cs.yc_user_id)::int AS drivers,
                count(*) FILTER (WHERE cs.plate_basis = 'session_plate')::int AS session_plate,
                count(*) FILTER (WHERE cs.plate_basis = 'only_car')::int AS only_car,
                count(*) FILTER (WHERE cs.plate_basis = 'nearest_trip')::int AS nearest_trip
           FROM charging_session cs WHERE ${SPAN} AND cs.kwh > 0 AND cs.plate IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC, 1`, P),
      q(`WITH link AS (${LINK_SQL})
         SELECT l.person_id::text AS person_id, d.full_name AS name, count(*)::int AS charges,
                round(sum(cs.kwh), 1)::float AS kwh, round(sum(cs.cost_incl_vat), 2)::float AS cost,
                max(cs.started_at) AS last_at, count(DISTINCT cs.plate)::int AS cars
           FROM charging_session cs JOIN link l ON l.yc_user_id = cs.yc_user_id LEFT JOIN driver d ON d.id = l.person_id
          WHERE ${SPAN} AND cs.kwh > 0
          GROUP BY 1, 2 ORDER BY 3 DESC, 2`, P),
      q(`SELECT to_char((cs.started_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day, count(*)::int AS charges,
                round(sum(cs.kwh), 1)::float AS kwh, round(sum(cs.cost_incl_vat), 2)::float AS cost
           FROM charging_session cs WHERE ${SPAN} AND cs.kwh > 0 GROUP BY 1 ORDER BY 1`, P),
      /* The twelve busiest sites, and how many there were. */
      q(`SELECT coalesce(cs.property_name, '(site not named)') AS site, count(*)::int AS charges, round(sum(cs.kwh), 1)::float AS kwh,
                count(*) OVER ()::int AS sites_total
           FROM charging_session cs WHERE ${SPAN} AND cs.kwh > 0 GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, P),
    ]);
    const t = tot[0] || {};
    return res.json({ from, to, ...s, why: whyOf(s), currency: 'AED',
      /* no_energy: PowerDrive said none; energy_unknown: it said nothing (the
         second review — one was being counted as the other). */
      totals: { sessions: t.sessions || 0, charges: t.charges || 0, no_energy: t.no_energy || 0, energy_unknown: t.energy_unknown || 0,
        /* null when no charge carried an amount; cost_unknown says how many
           charges the total could not include (never a silent 0). */
        kwh: t.kwh || 0, cost: t.cost ?? null, cost_unknown: t.cost_unknown || 0, on_a_car: t.on_a_car || 0,
        basis: Object.fromEntries([...BASES, 'no_trip', 'no_link', 'not_yet'].map((k) => [k, t[k] || 0])) },
      vehicles: cars.map((c) => ({ ...c, basis: Object.fromEntries(BASES.map((k) => [k, c[k]])) })).map(({ session_plate: _a, only_car: _b, nearest_trip: _c, ...c }) => c),
      drivers, days, sites: sites.map(({ sites_total: _t, ...x }) => x), sites_total: sites[0]?.sites_total || 0 });
  }));

  app.get('/api/charging/driver', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const person = Number(req.query.person);
    if (!Number.isInteger(person) || person <= 0) return res.status(400).json({ error: 'person required' });
    const s = await syncState(q);
    const wallets = await q(`WITH link AS (${LINK_SQL})
      SELECT u.yc_user_id, l.tier, u.balance, u.hold_amount, u.using_fleet_wallet, u.fleet_limit_available, u.fleet_group, u.last_session_at
        FROM link l JOIN charging_user u ON u.yc_user_id = l.yc_user_id WHERE l.person_id = $1`, [person]);
    const [bf] = await q(`SELECT value FROM source_state WHERE source = 'yocharge' AND fleet_id = '-' AND key = 'backfilled'`);
    let backfilled = new Set();
    try { backfilled = new Set(JSON.parse(bf?.value || '[]')); } catch { /* not read yet */ }
    const recent = wallets.length ? await q(`SELECT cs.started_at, cs.kwh::float AS kwh, cs.cost_incl_vat::float AS cost, cs.plate, cs.plate_basis,
             cs.property_name AS site, round(coalesce(cs.charging_s, cs.duration_s, 0) / 60.0)::int AS minutes
        FROM charging_session cs WHERE cs.yc_user_id = ANY($1::text[]) AND cs.kwh > 0
       ORDER BY cs.started_at DESC LIMIT 20`, [wallets.map((w) => w.yc_user_id)]) : [];
    const [c30] = wallets.length ? await q(`SELECT count(*) FILTER (WHERE started_at > now() - interval '30 days')::int AS charges,
             coalesce(round(sum(kwh) FILTER (WHERE started_at > now() - interval '30 days'), 1), 0)::float AS kwh,
             round(sum(cost_incl_vat) FILTER (WHERE started_at > now() - interval '30 days'), 2)::float AS cost,
             count(*) FILTER (WHERE started_at > now() - interval '30 days' AND cost_incl_vat IS NULL)::int AS cost_unknown,
             count(*)::int AS ever
        FROM charging_session WHERE yc_user_id = ANY($1::text[]) AND kwh > 0`,
    [wallets.map((w) => w.yc_user_id)]) : [null];
    return res.json({ person_id: String(person), ...s, currency: 'AED',
      why: wallets.length ? null : (whyOf(s) || 'No PowerDrive charging wallet is linked to this driver.'),
      wallets: wallets.map((w) => ({ yc_user_id: w.yc_user_id, tier: w.tier, balance: r2(w.balance), hold_amount: r2(w.hold_amount),
        using_fleet_wallet: !!w.using_fleet_wallet, fleet_limit_available: r2(w.fleet_limit_available), fleet_group: w.fleet_group || null,
        last_session_at: w.last_session_at })),
      /* `recent` is the latest 20: charges_total says how many there are, so
         a cut list is never read as the whole record. */
      last_30_days: c30 ? { charges: c30.charges, kwh: c30.kwh, cost: c30.cost ?? null, cost_unknown: c30.cost_unknown } : null,
      /* Whether each wallet's whole history has been read yet: until it has,
         a count is "so far", not "all" (backfill, 150 customers a run). */
      history_read: wallets.length ? wallets.every((w) => backfilled.has(w.yc_user_id)) : null,
      charges_total: c30 ? c30.ever : 0, recent });
  }));

  app.get('/api/charging/vehicle', wrap(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const plate = String(req.query.plate || '').toUpperCase().replace(/[\s-]+/g, '');
    if (!plate) return res.status(400).json({ error: 'plate required' });
    const { from, to } = windowOf(req);
    const s = await syncState(q);
    const P = [from, to, plate];
    const [t] = await q(`SELECT count(*)::int AS charges, coalesce(round(sum(cs.kwh), 1), 0)::float AS kwh,
             round(sum(cs.cost_incl_vat), 2)::float AS cost, count(*) FILTER (WHERE cs.cost_incl_vat IS NULL)::int AS cost_unknown,
             max(cs.started_at) AS last_at,
             count(*) FILTER (WHERE cs.plate_basis = 'session_plate')::int AS session_plate,
             count(*) FILTER (WHERE cs.plate_basis = 'only_car')::int AS only_car,
             count(*) FILTER (WHERE cs.plate_basis = 'nearest_trip')::int AS nearest_trip
        FROM charging_session cs WHERE ${SPAN} AND cs.kwh > 0 AND cs.plate = $3`, P);
    const recent = await q(`WITH link AS (${LINK_SQL})
      SELECT cs.started_at, cs.kwh::float AS kwh, cs.cost_incl_vat::float AS cost, cs.plate_basis, cs.property_name AS site,
             d.full_name AS driver, l.person_id::text AS person_id
        FROM charging_session cs LEFT JOIN link l ON l.yc_user_id = cs.yc_user_id LEFT JOIN driver d ON d.id = l.person_id
       WHERE ${SPAN} AND cs.kwh > 0 AND cs.plate = $3 ORDER BY cs.started_at DESC LIMIT 15`, P);
    return res.json({ plate, from, to, ...s, why: whyOf(s), currency: 'AED',
      charges: t.charges, kwh: t.kwh, cost: t.cost ?? null, cost_unknown: t.cost_unknown, last_at: t.last_at,
      basis: { session_plate: t.session_plate, only_car: t.only_car, nearest_trip: t.nearest_trip }, recent });
  }));
}

