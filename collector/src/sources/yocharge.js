/* CHARGING — PowerDrive's customers, their wallets and their charging sessions.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-11-03: "this is charging api for the complete charging
   system … Let's find out a way to show charging wallet balance for the
   drivers that we have. the name match might be different so we need to be
   very precise before we incorporate anything into production", then, once
   the match was measured: "go ahead and deploy with this build. let's figure
   out how we can have all sessions as well. we can track how many times each
   vehicles are charging".

   WHERE. PowerDrive (portal cpms.powerdrive.ae) is a white label of YoCharge
   and lives on YoCharge's MENA region, api.mena.yocharge.com. The global host
   answers "Token does not exist." to a working PowerDrive key — which read
   like a dead key twice before the portal's own code named the host
   (docs/COVERAGE.md "YoCharge"). Auth: `Authorization: Token <key>` plus the
   tenant's `client-id`. Both are settings, never in the repository.

   READ-ONLY, BY CONSTRUCTION. The API this key opens can credit and debit a
   wallet, start and stop a live charge, create users and renew the token.
   This module holds one network primitive, ycGet, and it sends GET and
   nothing else (test/yocharge.test.mjs asserts every call it makes).

   WHAT IS READ, every YOCHARGE_CRON (six-hourly):
     1. every PowerDrive customer — 3,323 on 2026-11-03 — in pages of 40.
        Pages over ~50 time out at the host's 60-second gateway (about 0.37 s
        of server time a customer), so a full read is ~84 pages, ~20 minutes,
        on its own cron where it holds nothing else up. Each lands in
        charging_user: the match keys (name, mobile, email — a customer has
        no external id), the fleet group, the wallet.
     2. linkUsers: which of OUR people each customer is (below).
     3. sessions: ALL PowerDrive sessions (~470 a day) from the last day
        read (state 'sessions_through', so a missed run is caught up, at most
        31 days back) or INCREMENTAL_DAYS ago, whichever is earlier — of which
        only WATCHED customers' are kept: those in our fleet groups at
        PowerDrive, or linked to one of our people. Another customer's charging
        is never stored. Then each watched customer's whole history, once,
        BACKFILL_USERS_PER_RUN at a time (/v3/mini-transactions/?user_id=,
        which the tenant key may read: 1.2–1.5 s a customer, measured
        2026-11-03, and only that customer's rows — kept to them regardless).

   UNITS, measured on real sessions 2026-11-03: `units_consumed` is in WATT-
   HOURS — 10,335 for a 709-second session that cost AED 12.40 before VAT,
   i.e. 10.3 kWh at ~AED 1.20 — so kWh is it ÷ 1000. `duration` and
   `charging_duration` are seconds (equal to stop − start to the second).
   The currency is named on each session's payment (AED); a wallet names none.

   THE LINK, precisely. A customer becomes one of our people automatically
   ('auto') only when ALL of these hold:
     · their mobile, normalised (src/smsala.js uaeMobile), belongs to exactly
       one owner in the house's phone book (src/driver_sms.js loadPhoneBook —
       Uber's and HR's numbers, every account's), and that owner is a person;
     · no other PowerDrive customer has that mobile;
     · the person matches no other customer through another number;
     · none of the person's accounts is held by the same-person register
       (HELD_IDS: a refused or pending pair);
     · the two names AGREE: they share a distinctive word (three letters or
       more, not a particle — al, bin, abu, md… — nor one of the commonest
       given names — Muhammad, Ahmed, Ali, Khan…), or two words of any kind
       but particles (the customer's name against the person's own and every
       account's display name);
     · the customer's mobile is a UAE one by its own country code;
     · no decision about the customer names a person record that no longer
       exists (a fold the link did not follow);
     · nobody has refused that pair.
   Anything short of that is a 'candidate' with its reason — a phone whose
   names disagree, a number on two people or two customers, an email alone, a
   name alone inside our fleet groups — for a person to confirm or refuse.
   'confirmed' and 'refused' are a person's decisions: the collector never
   writes, changes or deletes them; when person rows fold, they follow the
   survivor (src/charging_links.js). Measured 2026-11-03 against production:
   198 automatic on "one shared word"; 192 on the reviewed rule above (the six
   moved to review were none of them active that week; 78 of the 111 active
   drivers stay automatic), 73 to review. */
import { get } from '../settings.js';
import { logRun } from '../db.js';
import { noteCredential } from '../auth_state.js';
import { uaeMobile } from '../smsala.js';
import { loadPhoneBook, HELD_IDS } from '../driver_sms.js';
import { log as defaultLog } from '../log.js';

export const SOURCE = 'yocharge';
export const PAGE_USERS = 40;
export const PAGE_SESSIONS = 200;
export const INCREMENTAL_DAYS = 2;
/* ~1.5 s a customer, so a run's backfill is a few minutes; the ~300 watched
   customers' whole histories land in the first two runs (or sooner with
   Settings → "Read PowerDrive charging now"). */
export const BACKFILL_USERS_PER_RUN = 150;
export const CATCH_UP_DAYS = 31;
/* PowerDrive's names for our fleets there; a setting, so a renamed group is a
   paste, not a deploy. */
export const DEFAULT_FLEET_GROUPS = 'ecofleet,egari,ecofleet investor fleet';

/* ── the one network primitive: GET ─────────────────────────────────────── */
export function client({ host, key, clientId, fetchImpl = fetch, timeoutMs = 75_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return async function ycGet(path, params = {}) {
    const url = new URL(path, host);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, String(v));
    let last = null;
    /* One retry on a gateway timeout or a dropped connection: the host's 60-second
       gateway sometimes answers 504 on a page it serves on the next ask. */
    for (let attempt = 0; attempt < 2; attempt++) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        /* redirect: 'error' — a redirect is never followed, so the key and
           the tenant id only ever reach the host they were saved for. */
        const r = await fetchImpl(url.toString(), { method: 'GET', redirect: 'error', signal: ac.signal,
          headers: { Authorization: `Token ${key}`, 'client-id': clientId, Accept: 'application/json' } });
        if (r.status === 200) return await r.json();
        const body = await r.text().catch(() => '');
        last = Object.assign(new Error(`YoCharge answered ${r.status} for ${url.pathname}`),
          { status: r.status, detail: body.slice(0, 200) });
        if (r.status !== 502 && r.status !== 503 && r.status !== 504) throw last;
      } catch (e) {
        if (e.status && e.status !== 502 && e.status !== 503 && e.status !== 504) throw e;
        last = e;
      } finally { clearTimeout(t); }
      await sleep(5_000);
    }
    throw last;
  };
}

/** Every page of a DRF list, page by page; `onPage` gets each page's results. */
export async function eachPage(ycGet, path, params, pageSize, onPage, { pause = 1_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxPages = 500 } = {}) {
  let n = 0;
  for (let page = 1; page <= maxPages; page++) {
    const j = await ycGet(path, { ...params, page, page_size: pageSize });
    const rows = Array.isArray(j?.results) ? j.results : [];
    n += rows.length;
    await onPage(rows, j);
    if (!j?.next || !rows.length) break;
    if (pause) await sleep(pause);
  }
  return n;
}

/* ── normalising what PowerDrive sends ──────────────────────────────────── */
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const iso = (v) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
export const fleetGroupOf = (u) => {
  const g = u?.fleet_group;
  return (g && typeof g === 'object' ? g.name : g) || null;
};
/** A customer's mobile as the house normalises one, or null. */
export function phoneOf(u) {
  const cc = String(u?.mobile_country_code ?? '').replace(/\D/g, '');
  const n = String(u?.mobile_number ?? '').replace(/\D/g, '');
  if (!n) return null;
  /* A UAE mobile only by its own country code (or none). Saudi and other
     Gulf mobiles are written 05X XXX XXXX too, and +966 0501234567 read as
     a bare local number became a UAE number (the review, 2026-11-03). */
  if (cc && cc !== '971') return null;
  return uaeMobile(n) || uaeMobile(`971${n.replace(/^0+/, '')}`) || null;
}
export function userRow(u, now = new Date()) {
  const w = (u.wallets || []).find((x) => x?.type === 'PERSONAL') || null;
  return {
    yc_user_id: String(u.id), name: u.name || null, phone_norm: phoneOf(u),
    email: u.email ? String(u.email).trim().toLowerCase() : null, fleet_group: fleetGroupOf(u),
    using_fleet_wallet: !!u.is_using_fleet_wallet,
    fleet_limit: num(u.fleet_limit), fleet_limit_available: num(u.fleet_limit_available), fleet_limit_used: num(u.fleet_limit_used),
    balance: w ? num(w.balance) : null, hold_amount: w ? num(w.hold_amount) : null, credit_limit: w ? num(w.custom_credit_limit) : null,
    last_session_at: iso(u.last_charging_session),
    vehicles: (u.vehicles || []).map((v) => ({ id: v.vehicle_id || null, name: v.name || null, number: v.vehicle_number || null })),
    is_active: u.is_active !== false && !u.is_deleted && !u.is_archived,
    fetched_at: now.toISOString(),
  };
}
/** One session. kWh is units_consumed ÷ 1000: PowerDrive counts watt-hours. */
export function sessionRow(t, now = new Date()) {
  const p = t.payment || {};
  const c = t.connector || {};
  const v = t.vehicle || {};
  const wh = num(t.units_consumed);
  return {
    id: String(t.id), yc_user_id: t.user?.id ? String(t.user.id) : null,
    started_at: iso(t.server_start_time) || iso(t.created_at), stopped_at: iso(t.server_stop_time) || iso(t.end_date),
    created_at: iso(t.created_at), status: t.status || null,
    kwh: wh == null ? null : Math.round(wh) / 1000,
    duration_s: num(t.duration), charging_s: num(t.charging_duration),
    soc_start: num(t.soc_start), soc_end: num(t.soc_end),
    cost_incl_vat: num(p.total_cost?.incl_vat ?? p.amount), cost_excl_vat: num(p.total_cost?.excl_vat ?? p.amount_without_tax),
    currency: p.currency || null,
    property_id: t.property?.id || null, property_name: t.property?.name || null,
    charger_name: c.charger?.name || null, connector: c.connector_hid || null,
    vehicle_id: v.vehicle_id || null, vehicle_name: v.name || null, vehicle_number: v.vehicle_number || null,
    anomaly: t.anomaly == null ? null : !!t.anomaly, anomaly_type: t.anomaly_type || null,
    is_emsp: t.is_emsp_session == null ? null : !!t.is_emsp_session, fetched_at: now.toISOString(),
  };
}

/* ── storing ────────────────────────────────────────────────────────────── */
const USER_COLS = ['yc_user_id', 'name', 'phone_norm', 'email', 'fleet_group', 'using_fleet_wallet', 'fleet_limit',
  'fleet_limit_available', 'fleet_limit_used', 'balance', 'hold_amount', 'credit_limit', 'last_session_at', 'vehicles',
  'is_active', 'fetched_at'];
const SESSION_COLS = ['id', 'yc_user_id', 'started_at', 'stopped_at', 'created_at', 'status', 'kwh', 'duration_s', 'charging_s',
  'soc_start', 'soc_end', 'cost_incl_vat', 'cost_excl_vat', 'currency', 'property_id', 'property_name', 'charger_name',
  'connector', 'vehicle_id', 'vehicle_name', 'vehicle_number', 'anomaly', 'anomaly_type', 'is_emsp', 'fetched_at'];
async function upsert(q, table, cols, key, rows) {
  if (!rows.length) return 0;
  const vals = []; const tuples = [];
  rows.forEach((r, i) => {
    tuples.push(`(${cols.map((c, j) => `$${i * cols.length + j + 1}${c === 'vehicles' ? '::jsonb' : ''}`).join(', ')})`);
    for (const c of cols) vals.push(c === 'vehicles' ? JSON.stringify(r[c] || []) : r[c]);
  });
  await q(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}
           ON CONFLICT (${key}) DO UPDATE SET ${cols.filter((c) => c !== key).map((c) => `${c} = EXCLUDED.${c}`).join(', ')}`, vals);
  return rows.length;
}
const stateGet = async (q, key) => {
  const [r] = await q(`SELECT value FROM source_state WHERE source = $1 AND fleet_id = '-' AND key = $2`, [SOURCE, key]);
  try { return r ? JSON.parse(r.value) : null; } catch { return null; }
};
const stateSet = (q, key, value) => q(
  `INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ($1, '-', $2, $3, now())
   ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [SOURCE, key, JSON.stringify(value)]);

/* ── 1. the customers ───────────────────────────────────────────────────── */
export async function syncUsers({ q, ycGet, now = new Date(), sleep }) {
  let n = 0;
  await eachPage(ycGet, '/open/v1/users/', { role: 'END_USER' }, PAGE_USERS, async (rows) => {
    n += await upsert(q, 'charging_user', USER_COLS, 'yc_user_id', rows.map((u) => userRow(u, now)));
  }, { sleep });
  return n;
}

/* ── 2. the link ────────────────────────────────────────────────────────── */
const words = (s) => new Set(String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 1));
export const nameWords = words;
/* Particles and the commonest given names: two of our drivers share them
   all the time, so on their own they say nothing about who someone is. A
   recycled number reaching a new "Mohammed …" must not link on "mohammed". */
const PARTICLES = new Set(('al el bin ibn bint abu abd abdul abdel md mohd muhd mr mrs ms syed sayed sayyed sheikh shaikh sk '
  + 'haji hafiz ul ud ur din uddin').split(' '));
const COMMON = new Set(('muhammad mohammad mohammed mohamed muhammed mohamad mohammod mohamd ahmed ahmad ali hassan hasan '
  + 'hussain hussein husain khan abdullah abdulla omar umar ibrahim ismail yusuf yousef yousuf khalid mahmoud mahmood mustafa '
  + 'shah raza iqbal akhtar rahman rehman kumar singh').split(' '));
/** Do two names agree: a shared distinctive word, or two shared words that
    are not particles. */
export function namesAgree(a, b) {
  const shared = [...a].filter((w) => b.has(w) && !PARTICLES.has(w));
  return shared.some((w) => w.length >= 3 && !COMMON.has(w)) || shared.length >= 2;
}
const plain = (s) => [...words(s)].join(' ');

/** Write the automatic links and the candidates; never touch a decision.
    With `db`, the replace is one transaction: a run killed half way leaves
    the links it found, not none (the review, 2026-11-03). */
export async function linkUsers({ q, db = null, fleetGroups = DEFAULT_FLEET_GROUPS, book = null }) {
  const pb = book || await loadPhoneBook(q);
  const groups = new Set(String(fleetGroups).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  const [users, names, decided] = await Promise.all([
    q(`SELECT yc_user_id, name, phone_norm, email, fleet_group FROM charging_user WHERE is_active IS NOT FALSE`),
    q(`SELECT d.id::text AS person, d.full_name AS name, d.email, p.display_name
         FROM driver d LEFT JOIN driver_platform_id p ON p.driver_id = d.id AND p.detached_at IS NULL`),
    q(`SELECT c.yc_user_id, c.person_id::text AS person, c.tier, EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id) AS alive
         FROM charging_link c WHERE c.tier IN ('confirmed', 'refused')`),
  ]);
  const personWords = new Map(); const personEmail = new Map(); const personName = new Map();
  const addTo = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v); };
  for (const r of names) {
    if (!personWords.has(r.person)) personWords.set(r.person, new Set());
    for (const w of words(r.name)) personWords.get(r.person).add(w);
    for (const w of words(r.display_name)) personWords.get(r.person).add(w);
    /* Every person an email or a name points at, not the first or the last:
       two of our people sharing one is a reason in itself (the review). */
    if (r.email) addTo(personEmail, String(r.email).trim().toLowerCase(), r.person);
    if (r.name && plain(r.name)) addTo(personName, plain(r.name), r.person);
  }
  /* A decision about a person row that no longer exists — a fold no link
     followed — holds its customer back from any automatic link, and a
     confirmation stranded that way no longer settles it. */
  const stranded = new Set(decided.filter((d) => !d.alive).map((d) => d.yc_user_id));
  const live = decided.filter((d) => d.alive);
  const refused = new Set(live.filter((d) => d.tier === 'refused').map((d) => `${d.yc_user_id}|${d.person}`));
  const settledUser = new Set(live.filter((d) => d.tier === 'confirmed').map((d) => d.yc_user_id));
  const byPhone = new Map();
  for (const u of users) if (u.phone_norm) byPhone.set(u.phone_norm, (byPhone.get(u.phone_norm) || 0) + 1);
  const held = (person) => (pb.personAccounts.get(person) || []).some((a) => HELD_IDS.has(String(a.id)));

  /* First pass: a customer's phone → the one person it can be, or why not. */
  const viaPhone = new Map();          // yc_user_id → { person, why }
  const personHits = new Map();        // person → Set(yc_user_id) through a phone
  for (const u of users) {
    if (!u.phone_norm) continue;
    const owners = [...(pb.owners.get(u.phone_norm) || [])];
    if (!owners.length) continue;
    const people = owners.filter((o) => o.startsWith('p:')).map((o) => o.slice(2));
    let why = null;
    if (owners.length > 1) why = `this mobile belongs to ${owners.length} of our records`;
    else if (!people.length) why = 'this mobile belongs to an account or HR row not on the person spine';
    else if (byPhone.get(u.phone_norm) > 1) why = `${byPhone.get(u.phone_norm)} PowerDrive customers share this mobile`;
    const person = people.length === 1 ? people[0] : null;
    viaPhone.set(u.yc_user_id, { person, why, people });
    if (person) {
      if (!personHits.has(person)) personHits.set(person, new Set());
      personHits.get(person).add(u.yc_user_id);
    }
  }
  const auto = []; const candidates = [];
  for (const u of users) {
    if (settledUser.has(u.yc_user_id)) continue;
    const ph = viaPhone.get(u.yc_user_id);
    if (ph?.person) {
      let why = ph.why;
      if (!why && (personHits.get(ph.person)?.size || 0) > 1) why = `this person matches ${personHits.get(ph.person).size} PowerDrive customers`;
      if (!why && held(ph.person)) why = 'this person’s accounts are held by the same-person register';
      if (!why && stranded.has(u.yc_user_id)) why = 'a decision about this customer named a person record that no longer exists — decide again';
      if (!why && !namesAgree(words(u.name), personWords.get(ph.person) || new Set())) {
        why = 'the mobile matches but the names do not agree (no distinctive word in common)';
      }
      if (refused.has(`${u.yc_user_id}|${ph.person}`)) continue;
      (why ? candidates : auto).push({ yc_user_id: u.yc_user_id, person: ph.person, reason: why || 'mobile held by this person alone, and the names agree' });
      continue;
    }
    /* A number on two or more of our people: each is offered, with the
       reason, and none is chosen. One on an account or HR row with no person
       is unplaced — shown as such, not guessed at. */
    if (ph && !ph.person) {
      for (const person of ph.people) {
        if (!refused.has(`${u.yc_user_id}|${person}`)) candidates.push({ yc_user_id: u.yc_user_id, person, reason: ph.why });
      }
      continue;
    }
    const viaEmail = [...(u.email ? personEmail.get(u.email) || [] : [])];
    if (viaEmail.length) {
      const why = viaEmail.length > 1 ? `the email matches ${viaEmail.length} of our people; the mobile does not`
        : 'the email matches; the mobile does not';
      for (const person of viaEmail) {
        if (!refused.has(`${u.yc_user_id}|${person}`)) candidates.push({ yc_user_id: u.yc_user_id, person, reason: why });
      }
      continue;
    }
    if (groups.has(String(u.fleet_group || '').toLowerCase())) {
      const viaName = [...(personName.get(plain(u.name)) || [])];
      const why = viaName.length > 1 ? `in our fleet group at PowerDrive; ${viaName.length} of our people share this name, and nothing else matches`
        : 'in our fleet group at PowerDrive; the name matches, nothing else does';
      for (const person of viaName) {
        if (!refused.has(`${u.yc_user_id}|${person}`)) candidates.push({ yc_user_id: u.yc_user_id, person, reason: why });
      }
    }
  }
  /* Replace the collector's own rows wholesale; decisions stay as they are. */
  const replace = async (tq) => {
    await tq(`DELETE FROM charging_link WHERE tier IN ('auto', 'candidate')`);
    const write = async (rows, tier) => {
      for (let i = 0; i < rows.length; i += 200) {
        const part = rows.slice(i, i + 200);
        const vals = []; const tuples = part.map((r, k) => {
          vals.push(r.yc_user_id, Number(r.person), tier, r.reason);
          return `($${k * 4 + 1}, $${k * 4 + 2}, $${k * 4 + 3}, $${k * 4 + 4})`;
        });
        await tq(`INSERT INTO charging_link (yc_user_id, person_id, tier, reason) VALUES ${tuples.join(', ')}
                  ON CONFLICT (yc_user_id, person_id) DO NOTHING`, vals);
      }
    };
    await write(auto, 'auto');
    await write(candidates, 'candidate');
  };
  await (db ? inTx(db, replace) : replace(q));
  return { auto: auto.length, candidates: candidates.length };
}

/** `fn(q)` in one transaction: a pg Pool's client, or PGlite's own. */
async function inTx(db, fn) {
  if (typeof db.transaction === 'function') return db.transaction((tx) => fn((t, p) => tx.query(t, p).then((r) => r.rows)));
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((t, p) => client.query(t, p).then((r) => r.rows));
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
}

/* ── 2b. a stranger is not kept ─────────────────────────────────────────── */
/* The read is of EVERY PowerDrive customer (3,323), because a link can only
   be judged against all of them — "two customers share this mobile" needs the
   other customer. But a stranger's name, mobile, email and balance are not
   ours to hold: once the link pass has run, a customer who is in none of our
   fleet groups, matches none of our people at any tier, and has no session
   stored is deleted. Each run reads them afresh and drops them again; how many
   were read is kept as a count (state 'customers_read'), not as rows. */
export async function pruneStrangers(q, fleetGroups = DEFAULT_FLEET_GROUPS) {
  const groups = String(fleetGroups).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const r = await q(`DELETE FROM charging_user u
                      WHERE NOT (lower(coalesce(u.fleet_group, '')) = ANY($1::text[]))
                        AND NOT EXISTS (SELECT 1 FROM charging_link c WHERE c.yc_user_id = u.yc_user_id)
                        AND NOT EXISTS (SELECT 1 FROM charging_session s WHERE s.yc_user_id = u.yc_user_id)
                  RETURNING 1`, [groups]);
  return r.length;
}

/** The sessions of a customer who is no longer ours — a link dropped, a
    fleet group left — go: they counted on our cars and drivers only while
    the customer was one of ours (the review, 2026-11-03). */
export async function dropUnwatchedSessions(q, watched) {
  const r = await q(`DELETE FROM charging_session WHERE NOT (yc_user_id = ANY($1::text[])) RETURNING 1`, [[...watched]]);
  return r.length;
}

/* ── 3. the sessions ────────────────────────────────────────────────────── */
/** The customers whose sessions are ours to keep. */
export async function watchedUsers(q, fleetGroups = DEFAULT_FLEET_GROUPS) {
  const groups = String(fleetGroups).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const rows = await q(`SELECT yc_user_id FROM charging_user WHERE lower(fleet_group) = ANY($1::text[])
                        UNION SELECT yc_user_id FROM charging_link WHERE tier IN ('auto', 'confirmed')`, [groups]);
  return new Set(rows.map((r) => String(r.yc_user_id)));
}
const dubaiDay = (t) => new Date(t + 4 * 3600e3).toISOString().slice(0, 10);

export async function syncSessions({ q, ycGet, now = new Date(), watched, budget = BACKFILL_USERS_PER_RUN, sleep }) {
  const keep = (rows) => rows.filter((t) => t?.user?.id && watched.has(String(t.user.id))).map((t) => sessionRow(t, now));
  let recent = 0;
  /* From the last day read, so runs missed while the key was broken are
     caught up — never further back than CATCH_UP_DAYS (beyond that the
     per-customer history below is the record), never later than
     INCREMENTAL_DAYS ago (a session is filed when it STOPS, so the day
     before is still filling). */
  const through = await stateGet(q, 'sessions_through');
  let start = dubaiDay(now.getTime() - INCREMENTAL_DAYS * 864e5);
  const floor = dubaiDay(now.getTime() - CATCH_UP_DAYS * 864e5);
  if (typeof through === 'string' && through < start) start = through < floor ? floor : through;
  await eachPage(ycGet, '/open/v1/mini-transactions/', { start_date: start, end_date: dubaiDay(now.getTime()) },
    PAGE_SESSIONS, async (rows) => { recent += await upsert(q, 'charging_session', SESSION_COLS, 'id', keep(rows)); }, { sleep });
  await stateSet(q, 'sessions_through', dubaiDay(now.getTime()));
  /* Each watched customer's whole history, once. */
  /* Only customers still watched count as read: one who left (and lost
     their sessions with it) and came back is read again. */
  const done = new Set((await stateGet(q, 'backfilled') || []).filter((id) => watched.has(id)));
  await stateSet(q, 'backfilled', [...done]);   // the leaving is remembered even on a run that reads no history
  const todo = [...watched].filter((id) => !done.has(id)).sort().slice(0, budget);
  let history = 0;
  for (const id of todo) {
    await eachPage(ycGet, '/v3/mini-transactions/', { user_id: id }, PAGE_SESSIONS, async (rows) => {
      /* Only this customer's rows, whatever the host sends back. */
      history += await upsert(q, 'charging_session', SESSION_COLS, 'id', rows.filter((t) => String(t?.user?.id) === id).map((t) => sessionRow(t, now)));
    }, { sleep });
    done.add(id);
    await stateSet(q, 'backfilled', [...done]);
  }
  return { recent, from: start, history, backfilled: todo.length, waiting: [...watched].filter((id) => !done.has(id)).length };
}

/* ── 4. which of our cars charged ───────────────────────────────────────── */
/* PowerDrive rarely knows the car: of the 142 vehicles our fleet-group
   customers registered on 2026-11-03, 34 carried a number and 15 equalled one
   of our plates. So a session is put on a car by, in order:
     session_plate  its own vehicle number equals one of our plates;
     only_car       the linked driver drove one car (a booking with a plate)
                    that Dubai day;
     nearest_trip   they drove more than one; the car of the booking nearest
                    the session's start;
   and is otherwise left off every car with its reason — no_trip (the driver
   drove nothing that day) or no_link (the customer is not one of our people).
   The basis is kept on the row, so a count can say how it was made.

   WHICH SESSIONS, each run: any never attributed; any whose customer's
   current link is not the person it was attributed with (a link confirmed,
   dropped or moved — attributed_person); the last ATTRIBUTE_DAYS (a booking
   can arrive late); and a charge on no car over the catch-up horizon,
   RECHECK_DAYS (a backfill can bring its booking weeks later).

   HOW, and why it is shaped like this (the independent review, 2026-11-03):
   the first build counted each session's distinct plates with a subquery
   over the whole trips set per row — quadratic, 43 s at 20,000 rows in
   PGlite — and matched each session against every trip its driver ever
   made before filtering to the day, in ONE statement under the collector's
   120-second timeout: the first history backfill would have been cancelled,
   rolled back, and grown every run after. Now:
     · a driver's bookings are read per session by LATERAL over the
       (driver_ext_id, requested_at) index, bounded to ±NEAR_HOURS of the
       charge — which also stops a night shift's car being lost to the
       calendar day (a 00:30 charge after an evening in car A is A's);
     · plates are counted once, grouped;
     · ATTRIBUTE_BATCH sessions a statement, stamped with the run
       (attributed_at) so a batch never picks up one this run already did.
   A failure here does not fail the run (collect marks it partial). */
export const ATTRIBUTE_DAYS = 8;
export const RECHECK_DAYS = 31;
export const ATTRIBUTE_BATCH = 2000;
export const NEAR_HOURS = 12;
export async function attributeSessions(q, { days = ATTRIBUTE_DAYS, recheck = RECHECK_DAYS, batch = ATTRIBUTE_BATCH,
  maxBatches = 200, runAt = new Date() } = {}) {
  const n = {};
  for (let i = 0; i < maxBatches; i++) {
    const r = await q(`
      WITH link AS (
        SELECT DISTINCT ON (c.yc_user_id) c.yc_user_id, c.person_id FROM charging_link c
         WHERE c.tier IN ('confirmed', 'auto') AND EXISTS (SELECT 1 FROM driver d WHERE d.id = c.person_id)
         ORDER BY c.yc_user_id, (c.tier = 'confirmed') DESC, c.person_id),
      todo AS (
        SELECT cs.id, cs.started_at, cs.vehicle_number, l.person_id
          FROM charging_session cs LEFT JOIN link l ON l.yc_user_id = cs.yc_user_id
         WHERE cs.started_at IS NOT NULL
           AND cs.attributed_at IS DISTINCT FROM $4::timestamptz
           AND (cs.plate_basis IS NULL
                OR cs.attributed_person IS DISTINCT FROM l.person_id
                OR cs.started_at > now() - make_interval(days => $1::int)
                OR (cs.plate_basis = 'no_trip' AND cs.started_at > now() - make_interval(days => $2::int)))
         ORDER BY cs.started_at DESC, cs.id
         LIMIT $3),
      sp AS (
        SELECT DISTINCT ON (t.id) t.id, v.plate FROM todo t
          JOIN vehicle v ON upper(regexp_replace(v.plate, '[^A-Za-z0-9]', '', 'g'))
                          = upper(regexp_replace(t.vehicle_number, '[^A-Za-z0-9]', '', 'g'))
         WHERE coalesce(btrim(t.vehicle_number), '') <> ''
         ORDER BY t.id, v.plate),
      trips AS (
        SELECT t.id, x.plate, x.requested_at, t.started_at
          FROM todo t
          JOIN driver_platform_id p ON p.driver_id = t.person_id AND p.detached_at IS NULL
          CROSS JOIN LATERAL (
            SELECT btrim(tr.plate) AS plate, tr.requested_at FROM trip tr
             WHERE tr.driver_ext_id = p.external_id AND tr.platform = p.platform
               AND tr.requested_at >= t.started_at - make_interval(hours => $5::int)
               AND tr.requested_at <  t.started_at + make_interval(hours => $5::int)
               AND tr.platform <> 'fms' AND coalesce(btrim(tr.plate), '') <> '') x
         WHERE t.person_id IS NOT NULL),
      plates AS (SELECT id, count(DISTINCT plate)::int AS n FROM trips GROUP BY id),
      nt AS (
        SELECT DISTINCT ON (id) id, plate FROM trips
         ORDER BY id, abs(extract(epoch FROM requested_at - started_at)), plate)
      UPDATE charging_session cs SET
        plate = coalesce(sp.plate, nt.plate),
        plate_basis = CASE WHEN sp.plate IS NOT NULL THEN 'session_plate'
                           WHEN pl.n = 1 THEN 'only_car'
                           WHEN pl.n > 1 THEN 'nearest_trip'
                           WHEN t.person_id IS NULL THEN 'no_link'
                           ELSE 'no_trip' END,
        attributed_person = t.person_id,
        attributed_at = $4::timestamptz
        FROM todo t LEFT JOIN sp ON sp.id = t.id LEFT JOIN nt ON nt.id = t.id LEFT JOIN plates pl ON pl.id = t.id
       WHERE cs.id = t.id
      RETURNING cs.plate_basis`, [days, recheck, batch, runAt.toISOString(), NEAR_HOURS]);
    for (const x of r) n[x.plate_basis] = (n[x.plate_basis] || 0) + 1;
    if (r.length < batch) break;
  }
  return n;
}

/* ── between the full reads: our drivers' wallets ───────────────────────── */
/* The operator, 2026-11-03: "just our drivers every 3 hours?" — the full read
   is ~84 pages of 40 every six hours (it is how a NEW customer is found and
   judged), and between two of them our own drivers' balances were up to six
   hours old. So at the hours between, only the customers who are ours — our
   fleet groups at PowerDrive, and every customer linked to one of our people —
   are asked for, one GET each: /open/v1/users/?id=<id> answers exactly that
   customer with their wallets, 1.2–1.8 s each (measured 2026-11-03), so ~300
   take a few minutes. The day's sessions are read with them (the same
   incremental read the full run makes, no history backfill) and put on cars.
   Linking is NOT redone here: who is whose changes only on a full read. */
export async function refreshWallets({ q, ycGet, now = new Date(), ids, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pause = 200 }) {
  let refreshed = 0; let missing = 0;
  for (const id of [...ids].sort()) {
    const j = await ycGet('/open/v1/users/', { role: 'END_USER', id });
    const u = (Array.isArray(j?.results) ? j.results : []).find((x) => String(x?.id) === String(id));
    if (u) { refreshed += await upsert(q, 'charging_user', USER_COLS, 'yc_user_id', [userRow(u, now)]); } else missing += 1;
    if (pause) await sleep(pause);
  }
  return { refreshed, missing };
}

export async function collectWallets({ db, now = new Date(), fetchImpl = fetch, sleep, log = defaultLog,
  key = get('YOCHARGE_API_KEY', ''), clientId = get('YOCHARGE_CLIENT_ID', ''), host = get('YOCHARGE_HOST', 'https://api.mena.yocharge.com'),
  fleetGroups = get('YOCHARGE_FLEET_GROUPS', DEFAULT_FLEET_GROUPS) } = {}) {
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  if (!key || !clientId) return { skipped: !key ? 'YOCHARGE_API_KEY is not set' : 'YOCHARGE_CLIENT_ID is not set' };
  const ycGet = client({ host, key, clientId, fetchImpl, sleep });
  const out = { wallets: null, sessions: null };
  try {
    const watched = await watchedUsers(q, fleetGroups);
    /* Nothing is ours until a full read has run: say so, ask for nothing. */
    if (!watched.size) return { skipped: 'no customer is ours yet — the six-hourly full read has not run' };
    out.wallets = await refreshWallets({ q, ycGet, now, ids: watched, sleep });
    await noteCredential(db, { provider: SOURCE, credential: 'YOCHARGE_API_KEY', state: 'ok', surface: 'wallets' });
    out.sessions = await syncSessions({ q, ycGet, now, watched, budget: 0, sleep });
    let attributionError = null;
    try { out.attributed = await attributeSessions(q, { runAt: now }); } catch (e) {
      attributionError = `charges not yet put on cars: ${String(e.message || e).slice(0, 200)}`;
      log.warn('yocharge', 'attribution failed', { err: attributionError });
    }
    await logRun({ source: SOURCE, fleet_id: null, mode: 'wallets', status: attributionError ? 'partial' : 'ok',
      rows_written: out.wallets.refreshed + out.sessions.recent, error: attributionError }, db);
    if (attributionError) out.attribution_error = attributionError;
    log.info('yocharge', 'wallets', out);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      await noteCredential(db, { provider: SOURCE, credential: 'YOCHARGE_API_KEY', state: 'invalid',
        detail: `PowerDrive refused the key (${e.status}${e.detail ? `: ${String(e.detail).slice(0, 80)}` : ''})`, surface: 'wallets' });
    }
    await logRun({ source: SOURCE, fleet_id: null, mode: 'wallets', status: 'error',
      rows_written: out.wallets?.refreshed || 0, error: String(e.message || e).slice(0, 300) }, db).catch(() => {});
    log.warn('yocharge', 'wallet refresh failed', { err: String(e.message || e).slice(0, 200), status: e.status || null });
    out.error = String(e.message || e);
  }
  return out;
}

/* ── one run ────────────────────────────────────────────────────────────── */
export async function collect({ db, now = new Date(), fetchImpl = fetch, sleep, log = defaultLog,
  key = get('YOCHARGE_API_KEY', ''), clientId = get('YOCHARGE_CLIENT_ID', ''), host = get('YOCHARGE_HOST', 'https://api.mena.yocharge.com'),
  fleetGroups = get('YOCHARGE_FLEET_GROUPS', DEFAULT_FLEET_GROUPS) } = {}) {
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  if (!key || !clientId) {
    return { skipped: !key ? 'YOCHARGE_API_KEY is not set' : 'YOCHARGE_CLIENT_ID is not set' };
  }
  const ycGet = client({ host, key, clientId, fetchImpl, sleep });
  const started = Date.now();
  const out = { users: 0, links: null, sessions: null };
  let pruned = false;
  try {
    out.users = await syncUsers({ q, ycGet, now, sleep });
    await noteCredential(db, { provider: SOURCE, credential: 'YOCHARGE_API_KEY', state: 'ok', surface: 'users' });
    await stateSet(q, 'customers_read', out.users);
    out.links = await linkUsers({ q, db, fleetGroups });
    const watched = await watchedUsers(q, fleetGroups);
    out.dropped = await dropUnwatchedSessions(q, watched);
    out.pruned = await pruneStrangers(q, fleetGroups);
    pruned = true;
    out.sessions = await syncSessions({ q, ycGet, now, watched, sleep });
    /* The sessions are in; which car each was on is worked out after, and a
       failure there marks the run partial rather than undoing the read. */
    let attributionError = null;
    try { out.attributed = await attributeSessions(q, { runAt: now }); } catch (e) {
      attributionError = `charges not yet put on cars: ${String(e.message || e).slice(0, 200)}`;
      log.warn('yocharge', 'attribution failed', { err: attributionError });
    }
    await logRun({ source: SOURCE, fleet_id: null, mode: 'users+sessions', status: attributionError ? 'partial' : 'ok',
      rows_written: out.users + out.sessions.recent + out.sessions.history, error: attributionError }, db);
    if (attributionError) out.attribution_error = attributionError;
    log.info('yocharge', 'run', { ...out, s: Math.round((Date.now() - started) / 1000) });
  } catch (e) {
    const refused = e.status === 401 || e.status === 403;
    if (refused) {
      await noteCredential(db, { provider: SOURCE, credential: 'YOCHARGE_API_KEY', state: 'invalid',
        detail: `PowerDrive refused the key (${e.status}${e.detail ? `: ${String(e.detail).slice(0, 80)}` : ''})`, surface: 'users' });
    }
    await logRun({ source: SOURCE, fleet_id: null, mode: 'users+sessions', status: 'error',
      rows_written: out.users, error: String(e.message || e).slice(0, 300) }, db).catch(() => {});
    log.warn('yocharge', 'run failed', { err: String(e.message || e).slice(0, 200), status: e.status || null });
    out.error = String(e.message || e);
  } finally {
    /* A run that failed after reading customers must not leave strangers'
       details stored until a later run succeeds (the review, 2026-11-03). */
    if (!pruned) out.pruned = await pruneStrangers(q, fleetGroups).catch(() => null);
  }
  return out;
}
