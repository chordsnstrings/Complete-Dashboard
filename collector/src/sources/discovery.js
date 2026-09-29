/* WHAT EACH PLATFORM CALLS US — the accounts behind each credential, and their names.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §3.1 and §3.3. A fleet's name is derived from
   what its platforms call it (src/fleet_names.js); this is the part that asks
   them, and records the answer in platform_account (sql/schema_v87.sql).

   WHAT WAS MEASURED BEFORE THIS EXISTED (docs/COVERAGE.md, "What each
   platform calls the fleets — measured 2026-09-26"): the names were being
   thrown away or never asked for.
     Uber    /v1/vehicle-suppliers/orgs → name, called by src/credcheck.js on
             paste and by src/auth_state.js on a refusal, and never stored
     Yango   console parks/users/profile names the park; 403 since 2026-09-06
     CABMAN  CompanyName on every vehicle of GetIVDData, stored whole in
             telemetry_snapshot.raw and never read — "Ecosine Transports LLC"
             on 25,183 snapshots in a week and "Sahalat" on 64, both through
             Ecosine's interface and so both filed as Ecosine (src/config.js:70)
     Bolt    fleet-integration gives company ids 142868 / 142897 and no name;
             the portal's getCompanyDetails / getProfile never called
     FMS     GetVehicleList → ClientName, never called
     Hotel   x-domain only; nothing name-like to ask for

   ONE ACCOUNT PER THING THE PLATFORM IDENTIFIES, by its own id: an Uber org's
   encrypted id, the Yango park id, the Bolt company id, the FMS login's
   numeric userid (from Login — the login NAME is half a credential and is
   never stored), the hotel x-domain, and for CABMAN "<interface>/<CompanyName>"
   — each company behind an interface is its own account, because the Ecosine
   interface carries another operator's cars.

   LINKED ONLY WHERE CONFIGURATION ALREADY DECIDED, and only on first sight.
   An account whose id is the one src/config.js collects for a fleet — the
   Uber org id stored for it, a Bolt company id, the Yango park, the hotel
   domain, the FMS login — has had its rows filed under that fleet all along.
   Recording that as a link moves nobody's rows, so it is recorded
   ('configuration') rather than proposed. Anything else arrives NEW and waits
   for a person: an Uber org the client reaches that no fleet is configured
   for, and every CABMAN company behind an interface that carries more than
   one — so "Sahalat" is never quietly made part of Ecosine's name, and nor is
   "Ecosine Transports LLC" filed as Ecosine's by a guess. A later run never
   re-links an account somebody unlinked or ignored: status is written on
   insert only.

   CALLS. Every provider call goes through src/http.js with a timeout and at
   most one retry, is wrapped so a refusal becomes a recorded reason and never
   an exception in the caller, and no URL is ever logged here — FMS takes its
   password in the query string, and src/http.js already strips queries from
   everything it logs. Only ids and names are stored; no token, cookie or
   password goes anywhere near this module's writes.

   The collector runs runDiscovery(pool, { log }) nightly (src/index.js) under
   withPinnedSettings, so every credential read in one pass is from one
   snapshot. */
import { log as defaultLog } from '../log.js';
import { brandOf, accountLabel, platformLabel } from '../fleet_names.js';
import { syncFleetNames, accountEvidence } from '../../api/fleet_names_routes.js';
import { appendAudit } from '../../api/access/audit.js';

const STATE = { source: 'discovery', fleet: '-' };
const CALL_TIMEOUT_MS = 20_000;
/* Anything that could carry a query string, out of a message before it is
   stored or logged. src/http.js already strips queries from the URLs it
   names; this is the belt to that brace for errors thrown from below it. */
export const clean = (e) => String(e?.message ?? e ?? '').replace(/\?[^\s)'"]*/g, '?…').slice(0, 200);

const rowsOf = (db) => (t, p = []) => db.query(t, p).then((r) => r.rows);

/* ── recording one account ────────────────────────────────────────────────
   `name`: undefined = this pass did not ask; a string = the platform's name;
   null = it was asked and gave none, `nameReason` saying why. A name the
   platform stops answering with is KEPT (it is still the last thing the
   platform called the account) and the failed check is recorded beside it.
   `configuredFleet`: the fleet src/config.js collects this id for — used on
   first insert only. `filedFleet`: where its rows are filed today. */
export async function recordAccount(q, obs, { audit = async () => {} } = {}) {
  const { platform, accountId, configuredFleet = null, filedFleet = null, name, nameReason = null,
    sourceCall = null, detail = {} } = obs;
  const id = String(accountId);
  const fleets = (await q(`SELECT id FROM fleet`)).map((r) => r.id);
  const cfg = configuredFleet && fleets.includes(configuredFleet) ? configuredFleet : null;
  const inserted = (await q(
    `INSERT INTO platform_account (platform, account_id, fleet_id, status, filed_fleet, link_basis, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (platform, account_id) DO NOTHING RETURNING id`,
    [platform, id, cfg, cfg ? 'linked' : 'new', filedFleet, cfg ? 'configuration' : null, JSON.stringify(detail)]))[0];
  const row = (await q(`SELECT id, reported_name, status, fleet_id, detail FROM platform_account WHERE platform = $1 AND account_id = $2`, [platform, id]))[0];
  const pk = Number(row.id);
  if (inserted && cfg) {
    await q(`INSERT INTO fleet_change (kind, account_pk, fleet_id, status, basis, reason, approved_at)
             VALUES ('link', $1, $2, 'applied', 'configuration', $3, now())`,
    [pk, cfg, `src/config.js already files this account’s rows under ${cfg}; recorded as the link it already was.`]);
    await audit({ action: 'fleet.account_linked_by_configuration', subjectType: 'platform_account', subjectId: pk,
      detail: { platform, account: accountLabel({ platform, account_id: id }), fleet: cfg } });
  } else if (inserted) {
    await audit({ action: 'fleet.account_discovered', subjectType: 'platform_account', subjectId: pk,
      detail: { platform, account: accountLabel({ platform, account_id: id }), filed: filedFleet } });
  }
  if (!inserted) {
    await q(`UPDATE platform_account SET last_seen = now(), filed_fleet = COALESCE($2, filed_fleet),
               detail = detail || $3::jsonb WHERE id = $1`, [pk, filedFleet, JSON.stringify(detail)]);
  }

  if (name === undefined) return pk;
  const check = { at: new Date().toISOString(), call: sourceCall, ok: Boolean(name), reason: name ? null : nameReason };
  if (name) {
    const prev = row.reported_name;
    await q(`UPDATE platform_account SET reported_name = $2, name_reason = NULL, reported_at = now(), source_call = $3,
               detail = detail || jsonb_build_object('name_check', $4::jsonb) WHERE id = $1`,
    [pk, name, sourceCall, JSON.stringify(check)]);
    const last = (await q(`SELECT id, name FROM platform_account_name WHERE account_pk = $1 ORDER BY first_reported DESC, id DESC LIMIT 1`, [pk]))[0];
    if (last && last.name === name) {
      await q(`UPDATE platform_account_name SET last_reported = now() WHERE id = $1`, [last.id]);
    } else {
      await q(`INSERT INTO platform_account_name (account_pk, name, source_call) VALUES ($1, $2, $3)`, [pk, name, sourceCall]);
      if (prev && prev !== name) {
        /* The platform renamed the business (§3.2 rule 9): audited, and the
           fleet's page shows it once as "renamed by <platform> on <date>". */
        await audit({ action: 'fleet.account_renamed', subjectType: 'platform_account', subjectId: pk,
          detail: { platform, account: accountLabel({ platform, account_id: id }), from: prev, to: name } });
      }
    }
  } else {
    /* Asked, and no name: the reason is kept only while there is no name to
       show; a name read earlier stays, with this check beside it. */
    await q(`UPDATE platform_account SET name_reason = CASE WHEN reported_name IS NULL THEN $2 ELSE name_reason END,
               detail = detail || jsonb_build_object('name_check', $3::jsonb) WHERE id = $1`,
    [pk, nameReason, JSON.stringify(check)]);
  }
  return pk;
}

/* Vehicles an account reported (CABMAN, FMS), accumulated. */
async function recordVehicles(q, pk, plates) {
  for (const [plate, v] of plates) {
    await q(
      `INSERT INTO platform_account_vehicle (account_pk, plate, first_seen, last_seen, observations)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_pk, plate) DO UPDATE SET
         first_seen = LEAST(platform_account_vehicle.first_seen, EXCLUDED.first_seen),
         last_seen = GREATEST(platform_account_vehicle.last_seen, EXCLUDED.last_seen),
         observations = platform_account_vehicle.observations + EXCLUDED.observations`,
      [pk, plate, v.first, v.last, v.n]);
  }
}

async function getState(q, key) {
  return (await q(`SELECT value FROM source_state WHERE source = $1 AND fleet_id = $2 AND key = $3`, [STATE.source, STATE.fleet, key]))[0]?.value ?? null;
}
async function setState(q, key, value) {
  await q(`INSERT INTO source_state (source, fleet_id, key, value, updated_at) VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (source, fleet_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
  [STATE.source, STATE.fleet, key, value]);
}

/* ── CABMAN: from our own stored snapshots, no provider call ──────────────
   Every GetIVDData vehicle is stored whole in telemetry_snapshot.raw, and
   its CompanyName says whose car it is. Read incrementally by the row id (a
   snapshot is inserted once and only its polled_at moves on a re-poll, so an
   id watermark counts each snapshot exactly once), in slices so the first
   run over months of five-minute polls is not one enormous statement.
   `interfaces`: fleet → InterfaceUniqueId, from src/config.js. */
export async function discoverCabman(q, { interfaces = {}, audit, slice = 200_000 } = {}) {
  const from = Number(await getState(q, 'cabman_snapshot_id')) || 0;
  const top = Number((await q(`SELECT max(id) AS m FROM telemetry_snapshot WHERE source = 'cabman'`))[0]?.m) || 0;
  const acc = new Map();
  for (let lo = from; lo < top; lo += slice) {
    const rows = await q(
      `SELECT fleet_id, NULLIF(btrim(raw ->> 'CompanyName'), '') AS company, plate,
              count(*)::bigint AS n, min(captured_at) AS first_at, max(captured_at) AS last_at
         FROM telemetry_snapshot
        WHERE source = 'cabman' AND id > $1 AND id <= $2
        GROUP BY 1, 2, 3`, [lo, Math.min(lo + slice, top)]);
    for (const r of rows) {
      const k = `${r.fleet_id}\u0000${r.company ?? ''}`;
      const e = acc.get(k) || { fleet: r.fleet_id, company: r.company, n: 0, plates: new Map() };
      const p = e.plates.get(r.plate) || { n: 0, first: r.first_at, last: r.last_at };
      p.n += Number(r.n);
      if (r.first_at < p.first) p.first = r.first_at;
      if (r.last_at > p.last) p.last = r.last_at;
      e.plates.set(r.plate, p);
      e.n += Number(r.n);
      acc.set(k, e);
    }
  }
  /* How many companies each interface has EVER carried — stored accounts
     plus this scan — decides whether "configured to Ecosine" says anything
     about a company: it does when the interface carries one, and it does not
     when it carries several. */
  const ifaceOf = (fleet) => interfaces[fleet] ?? null;
  const known = await q(`SELECT account_id FROM platform_account WHERE platform = 'cabman'`);
  const companiesOn = (iface) => new Set([
    ...known.map((r) => r.account_id).filter((x) => x.startsWith(`${iface}/`)),
    ...[...acc.values()].filter((e) => ifaceOf(e.fleet) === iface).map((e) => `${iface}/${e.company ?? ''}`),
  ]).size;
  const out = [];
  for (const e of acc.values()) {
    const iface = ifaceOf(e.fleet);
    if (iface == null) {
      /* Rows filed under a fleet that no configured interface belongs to any
         more: the interface id is what names the account, and inventing one
         would be the made-up id §2.2 forbids. Said, and skipped. */
      out.push({ fleet: e.fleet, company: e.company, skipped: 'no CABMAN interface is configured for this fleet any more' });
      continue;
    }
    const prev = (await q(`SELECT detail FROM platform_account WHERE platform = 'cabman' AND account_id = $1`, [`${iface}/${e.company ?? ''}`]))[0]?.detail || {};
    const filed = { ...(prev.filed || {}) };
    filed[e.fleet] = (Number(filed[e.fleet]) || 0) + e.n;
    const pk = await recordAccount(q, {
      platform: 'cabman', accountId: `${iface}/${e.company ?? ''}`,
      configuredFleet: companiesOn(iface) === 1 ? e.fleet : null,
      filedFleet: e.fleet,
      name: e.company ?? null,
      nameReason: e.company ? null : 'CABMAN sent no CompanyName on these vehicles.',
      sourceCall: 'CABMAN GetIVDData → CompanyName (stored snapshots)',
      detail: { snapshots: (Number(prev.snapshots) || 0) + e.n, filed, interface: String(iface) },
    }, { audit });
    await recordVehicles(q, pk, e.plates);
    const vehicles = Number((await q(`SELECT count(*)::int AS n FROM platform_account_vehicle WHERE account_pk = $1`, [pk]))[0].n);
    await q(`UPDATE platform_account SET detail = detail || jsonb_build_object('vehicles', $2::int) WHERE id = $1`, [pk, vehicles]);
    out.push({ account: `${iface}/${e.company ?? ''}`, snapshots: e.n, plates: e.plates.size });
  }
  if (top > from) await setState(q, 'cabman_snapshot_id', String(top));
  return { scanned: Math.max(0, top - from), accounts: out };
}

/* ── the provider calls ──────────────────────────────────────────────────
   Dependencies are passed in so the tests drive every branch with no
   network; the real ones are loaded lazily, so a caller that only wants the
   CABMAN pass (the tests, the API) never loads the provider modules. */
export async function realDeps() {
  const [{ config, normPlate }, { http, qs }, settings, uberAuth, bolt] = await Promise.all([
    import('../config.js'), import('../http.js'), import('../settings.js'),
    import('../auth/uber.js'), import('./bolt.js')]);
  return {
    config, http, qs, normPlate,
    /* Exactly src/sources/uber.js uberOrgs(): the per-fleet orgs, or the
       shared client's one when none is set up per fleet. */
    uberOrgs: () => (config.uber.orgs?.length ? config.uber.orgs : [config.uber]),
    uberToken: (o) => uberAuth.uberOAuthToken(o && o.oauth ? o : null),
    uberOrgsUrl: settings.get('UBER_ORGS_URL', settings.SETTING_DEFAULTS.UBER_ORGS_URL),
    boltToken: (c) => bolt.portalToken(c),
  };
}
const safely = async (fn, fallback) => { try { return await fn(); } catch (e) { return fallback(e); } };

async function discoverUber(q, d, audit) {
  const notes = [];
  const lists = new Map();
  for (const o of d.uberOrgs()) {
    if (o.org) {
      await recordAccount(q, { platform: 'uber', accountId: o.org, configuredFleet: o.fleet, filedFleet: o.fleet }, { audit });
    }
    const client = o.oauth?.clientId || 'shared';
    if (!lists.has(client)) {
      lists.set(client, await safely(async () => {
        const token = await d.uberToken(o);
        const r = await d.http(d.uberOrgsUrl, { headers: { authorization: `Bearer ${token}` }, timeoutMs: CALL_TIMEOUT_MS, retries: 0 });
        const orgs = r.data?.organizations || r.data?.orgs;
        if (r.status >= 400 || !Array.isArray(orgs)) {
          return { list: null, reason: `Uber answered the organisation list with HTTP ${r.status} and no organisations.` };
        }
        return { list: orgs, reason: null };
      }, (e) => ({ list: null, reason: `Uber’s organisation list could not be read: ${clean(e)}` })));
    }
    const { list, reason } = lists.get(client);
    if (list) {
      for (const org of list) {
        if (!org?.id) continue;
        await recordAccount(q, {
          platform: 'uber', accountId: String(org.id),
          configuredFleet: String(org.id) === String(o.org || '') ? o.fleet : null,
          filedFleet: String(org.id) === String(o.org || '') ? o.fleet : null,
          name: org.name ? String(org.name).trim() : null,
          nameReason: org.name ? null : 'Uber listed this organisation without a name.',
          sourceCall: 'GET /v1/vehicle-suppliers/orgs',
          detail: { types: Array.isArray(org.types) ? org.types.slice(0, 6) : undefined },
        }, { audit });
      }
      if (o.org && !list.some((x) => String(x?.id) === String(o.org))) {
        const reached = list.map((x) => x?.name || x?.id).filter(Boolean).join(', ') || 'no organisation';
        await recordAccount(q, { platform: 'uber', accountId: o.org, name: null, sourceCall: 'GET /v1/vehicle-suppliers/orgs',
          nameReason: `The OAuth client ${o.fleet} uses reaches ${reached}, not the organisation id configured for ${o.fleet}, so Uber has not named it here.` }, { audit });
      }
      notes.push({ fleet: o.fleet, ok: true, orgs: list.length });
    } else {
      if (o.org) await recordAccount(q, { platform: 'uber', accountId: o.org, name: null, nameReason: reason, sourceCall: 'GET /v1/vehicle-suppliers/orgs' }, { audit });
      notes.push({ fleet: o.fleet, ok: false, reason });
    }
  }
  return notes;
}

/* Yango names the park only on its web console; the key-based Fleet API
   (fleet-api.yango.tech) has no profile surface. The console has refused
   this host since 2026-09-06 (api/probe.js), so a refusal here is the
   expected answer, recorded as the reason rather than treated as an error. */
export function yangoParkName(data, parkId) {
  if (!data || typeof data !== 'object') return null;
  const pick = (o) => (o && typeof o === 'object' ? (o.name || o.park_name || o.title || null) : null);
  if (Array.isArray(data.parks)) {
    const p = data.parks.find((x) => String(x?.id ?? x?.park_id ?? '') === String(parkId));
    if (pick(p)) return String(pick(p)).trim();
  }
  for (const c of [data.park, data.park_info, data.current_park, data.data?.park]) if (pick(c)) return String(pick(c)).trim();
  if (data.park_name) return String(data.park_name).trim();
  return null;
}
async function discoverYango(q, d, audit) {
  const y = d.config.yango;
  if (!y.parkId) return [{ ok: false, reason: 'no Yango park is configured' }];
  const call = 'GET /api/fleet/ui/v1/parks/users/profile';
  await recordAccount(q, { platform: 'yango', accountId: y.parkId, configuredFleet: y.fleet, filedFleet: y.fleet }, { audit });
  if (!y.cookie) {
    const reason = 'No Yango console session is configured (YANGO_COOKIE), so the park’s profile was not asked for its name.';
    await recordAccount(q, { platform: 'yango', accountId: y.parkId, name: null, nameReason: reason, sourceCall: call }, { audit });
    return [{ ok: false, reason }];
  }
  /* NOT ASKED ON A DAY THE CONSOLE HAS ALREADY REFUSED. (2026-09-29)
     This goes to the same host as the collector's weekly summary, and
     Yandex's edge refuses this server's address there before any session is
     read: every nightly profile call since 2026-09-06 came back as the edge's
     HTML page. The collector now asks that host once a day and files the
     answer as YANGO_CONSOLE; a second refusal the same day tells nobody
     anything, and puts the session on the wire from a refused address once
     more. A name already reported stays — recordAccount keeps it when this
     call has none. */
  const refusedToday = await safely(async () => (await q(
    `SELECT state FROM credential_state
      WHERE provider = 'yango' AND credential = 'YANGO_CONSOLE' AND state <> 'ok'
        AND (checked_at AT TIME ZONE 'Asia/Dubai')::date = (now() AT TIME ZONE 'Asia/Dubai')::date
      LIMIT 1`))[0] || null, () => null);
  if (refusedToday) {
    const reason = `Not asked today: fleet.yango.com already refused this server today (${refusedToday.state}), `
      + 'and the profile call goes to the same host. The park keeps the name it last gave.';
    await recordAccount(q, { platform: 'yango', accountId: y.parkId, name: null, nameReason: reason, sourceCall: call }, { audit });
    return [{ ok: false, reason }];
  }
  const got = await safely(async () => {
    const r = await d.http(`${y.base}/api/fleet/ui/v1/parks/users/profile`, {
      headers: { 'X-Park-Id': y.parkId, 'Accept-Language': 'en', cookie: y.cookie },
      timeoutMs: CALL_TIMEOUT_MS, retries: 0 });
    if (r.status >= 400) {
      const html = typeof r.data === 'string' && /<html|<!doctype/i.test(r.data);
      return { name: null, reason: `Yango’s console refused the profile call (HTTP ${r.status}${html
        ? ' — an HTML page from Yandex’s edge, not the API' : ''}), so the park has not named itself here.` };
    }
    const name = yangoParkName(r.data, y.parkId);
    return name ? { name } : { name: null, reason: `Yango’s console answered the profile call with no field read as the park’s name (top-level keys: ${
      Object.keys(r.data && typeof r.data === 'object' ? r.data : {}).slice(0, 10).join(', ') || 'none'}).` };
  }, (e) => ({ name: null, reason: `Yango’s console could not be reached: ${clean(e)}` }));
  await recordAccount(q, { platform: 'yango', accountId: y.parkId, name: got.name, nameReason: got.reason || null, sourceCall: call }, { audit });
  return [{ ok: Boolean(got.name), reason: got.reason || null }];
}

/* Bolt's fleet-integration API has no name for a company (getCompanies
   answers 404). The fleet-owner portal has getCompanyDetails and getProfile,
   never called before this; the access token is minted exactly as the trips
   collector mints it (src/sources/bolt.js portalToken — scoped to the
   company at mint time, which is load-bearing, see the block above it), and
   the call is shaped like its getPayouts: a GET with the company in the
   query. HTTP 200 is not success on this host — its own `code` is. */
export function boltCompanyName(data, companyId) {
  const d = data?.data;
  if (!d || typeof d !== 'object') return null;
  const direct = d.company?.name || d.company_name || d.name || null;
  if (direct) return String(direct).trim();
  for (const list of [d.companies, d.company_list, d.fleet_companies]) {
    if (!Array.isArray(list)) continue;
    const c = list.find((x) => String(x?.id ?? x?.company_id ?? '') === String(companyId));
    const n = c?.name || c?.company_name;
    if (n) return String(n).trim();
  }
  return null;
}
async function discoverBolt(q, d, audit) {
  const notes = [];
  for (const c of d.config.bolt.companies || []) {
    const id = String(c.companyId);
    await recordAccount(q, { platform: 'bolt', accountId: id, configuredFleet: c.fleet, filedFleet: c.fleet }, { audit });
    const got = await safely(async () => {
      const t = await d.boltToken(c);
      if (!t?.at) {
        return { name: null, reason: `Bolt’s fleet-integration API returns no company name, and the fleet-owner portal `
          + `could not be signed into for company ${id}: ${clean(t?.err || 'no access token')}.` };
      }
      const qstr = `?language=en-us&version=FO.3.856&company_id=${c.companyId}&user_id=${c.userId}&brand=bolt`;
      const headers = { authorization: `Bearer ${t.at}`, 'content-type': 'application/json' };
      const said = [];
      for (const path of ['getCompanyDetails', 'getProfile']) {
        const r = await d.http(`${d.config.bolt.portalBase}/${path}${qstr}`, { method: 'GET', headers, timeoutMs: CALL_TIMEOUT_MS, retries: 0 });
        if (r.status < 400 && Number(r.data?.code) === 0) {
          const name = boltCompanyName(r.data, c.companyId);
          if (name) return { name, call: `fleetOwnerPortal/${path}` };
          said.push(`${path} answered with no company name`);
        } else {
          said.push(`${path}: ${[r.data?.message, r.data?.code != null && `code=${r.data.code}`].filter(Boolean).join(' ') || `HTTP ${r.status}`}`);
        }
      }
      return { name: null, reason: `Bolt’s fleet-owner portal did not name company ${id} (${said.join('; ')}).` };
    }, (e) => ({ name: null, reason: `Bolt’s fleet-owner portal could not be reached: ${clean(e)}` }));
    await recordAccount(q, { platform: 'bolt', accountId: id, name: got.name, nameReason: got.reason || null,
      sourceCall: got.call || 'fleetOwnerPortal/getCompanyDetails' }, { audit });
    notes.push({ fleet: c.fleet, ok: Boolean(got.name), reason: got.reason || null });
  }
  return notes;
}

/* FMS / InfoTrack. The account is the login's numeric userid, which Login
   returns only when the password is accepted — the login NAME stays in the
   settings, because it is half of a credential. GetVehicleList carries a
   ClientName per vehicle (docs/fleet-tracking-api-reference.md §2), never
   read before; one name across the login's vehicles names the account, more
   than one is reported as exactly that. Both calls carry the password in
   the query string, as every FMS call does; nothing here logs a URL. */
const FMS_ERROR_KEYS = new Set(['error', 'message', 'errormessage', 'fault', 'errors', 'status_message']);
const fmsRefusal = (r) => {
  if (!r) return 'no answer';
  if (r.status >= 400) return `HTTP ${r.status}`;
  const x = r.data;
  if (x && typeof x === 'object' && !Array.isArray(x)) {
    const keys = Object.keys(x);
    if (keys.length && keys.every((k) => FMS_ERROR_KEYS.has(k.toLowerCase()))) {
      return keys.map((k) => String(x[k])).filter((v) => v && v !== 'null').join('; ').slice(0, 160) || 'an error with no message';
    }
  }
  return null;
};
export function fmsVehicles(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.Data) ? data.Data : Array.isArray(data?.data) ? data.data : null;
  return list;
}
async function discoverFms(q, d, audit) {
  const notes = [];
  for (const f of d.config.fms.fleets || []) {
    if (!f.username) continue;
    if (!f.password) { notes.push({ fleet: f.fleet, ok: false, reason: 'no FMS password is configured, so the login cannot be identified' }); continue; }
    const got = await safely(async () => {
      const login = await d.http(`${d.config.fms.base}/Login?${d.qs({ username: f.username, password: f.password })}`,
        { timeoutMs: CALL_TIMEOUT_MS * 1.5, retries: 1 });
      const userid = login.data?.userid;
      if (!userid) return { skip: `FMS refused the login (${fmsRefusal(login) || 'no userid in the answer'}), so it could not be identified.` };
      const r = await d.http(`${d.config.fms.base}/GetVehicleList?${d.qs({ username: f.username, password: f.password })}`,
        { timeoutMs: CALL_TIMEOUT_MS * 1.5, retries: 1 });
      const refused = fmsRefusal(r);
      const list = refused ? null : fmsVehicles(r.data);
      if (!list) return { userid, name: null, reason: `FMS answered GetVehicleList ${refused ? `with a refusal (${refused})` : 'in a shape with no vehicle list'}, so the client name was not read.` };
      const names = new Map();
      const plates = new Map();
      const now = new Date().toISOString();
      for (const v of list) {
        const n = String(v?.ClientName ?? '').trim();
        if (n) names.set(n, (names.get(n) || 0) + 1);
        const p = d.normPlate(v?.Vehicleno ?? v?.VehicleNo ?? v?.['Plate No']);
        if (p) plates.set(p, { n: 1, first: now, last: now });
      }
      const client = [...names.entries()].sort((a, b) => b[1] - a[1]);
      if (client.length === 1) return { userid, name: client[0][0], plates, vehicles: list.length, clientNames: client };
      return { userid, name: null, plates, vehicles: list.length, clientNames: client,
        reason: client.length
          ? `This login’s ${list.length} vehicles carry ${client.length} client names (${client.map(([n, k]) => `${n}: ${k}`).join(', ')}); FMS does not name the login itself.`
          : `None of this login’s ${list.length} vehicles carries a ClientName.` };
    }, (e) => ({ skip: `FMS could not be reached: ${clean(e)}` }));
    if (got.skip) { notes.push({ fleet: f.fleet, ok: false, reason: got.skip }); continue; }
    const pk = await recordAccount(q, {
      platform: 'fms', accountId: String(got.userid), configuredFleet: f.fleet, filedFleet: f.fleet,
      name: got.name, nameReason: got.reason || null, sourceCall: 'FMS GetVehicleList → ClientName',
      detail: got.clientNames ? { client_names: got.clientNames.slice(0, 10).map(([name, vehicles]) => ({ name, vehicles })), vehicles: got.vehicles } : {},
    }, { audit });
    if (got.plates?.size) await recordVehicles(q, pk, got.plates);
    notes.push({ fleet: f.fleet, ok: Boolean(got.name), reason: got.reason || null });
  }
  return notes;
}

/* The hotel channel: its only identity is the x-domain header. Nothing to
   ask; the account is recorded so it can be linked on the screen instead of
   by configuration (§3.4), and it names nothing. */
async function discoverHotel(q, d, audit) {
  const h = d.config.hotel;
  if (!h.domain) return [{ ok: false, reason: 'no hotel domain is configured' }];
  await recordAccount(q, { platform: 'hotel', accountId: h.domain, configuredFleet: h.fleet, filedFleet: h.fleet,
    name: null, sourceCall: 'x-domain header (no identity call exists)',
    nameReason: 'The hotel channel identifies itself only by its x-domain header; it sends no company name.' }, { audit });
  return [{ ok: false, reason: 'the channel has no name to give' }];
}

/* ── one pass ─────────────────────────────────────────────────────────────
   Never throws: a platform that refuses, times out or changes shape is a
   recorded reason on its accounts and a line in the summary, and the next
   platform is still asked. `calls: false` runs only what needs no provider
   (CABMAN from stored snapshots, then the evidence and the names). */
export async function runDiscovery(db, { log = defaultLog, calls = true, deps = null, interfaces = null } = {}) {
  const q = rowsOf(db);
  const started = Date.now();
  const steps = [];
  const audit = (entry) => appendAudit(db, { actorLabel: 'system:discovery', ...entry })
    .catch((e) => log.warn('discovery', 'audit append failed', { err: clean(e) }));
  const step = async (platform, fn) => {
    try {
      const r = await fn();
      steps.push({ platform, label: platformLabel(platform), ok: true, notes: r });
    } catch (e) {
      /* A store failure, not a provider's refusal (those are caught inside
         each step): said as one, and the next platform still runs. */
      steps.push({ platform, label: platformLabel(platform), ok: false, error: clean(e) });
      log.error('discovery', `${platform} failed`, { err: clean(e) });
    }
  };
  let d = deps;
  if (!d && calls) {
    try { d = await realDeps(); } catch (e) { log.error('discovery', 'could not load the provider modules', { err: clean(e) }); }
  }
  const ifaces = interfaces || Object.fromEntries((d?.config?.cabman?.fleets || [])
    .filter((f) => f.interfaceId != null && f.interfaceId !== '').map((f) => [f.fleet, String(f.interfaceId)]));

  await step('cabman', async () => {
    const r = await discoverCabman(q, { interfaces: ifaces, audit });
    return [{ ok: true, scanned: r.scanned, accounts: r.accounts.filter((a) => !a.skipped).length },
      ...r.accounts.filter((a) => a.skipped).map((a) => ({ ok: false, fleet: a.fleet,
        reason: `company “${a.company ?? 'with no name'}”: ${a.skipped}` }))];
  });
  if (calls && d) {
    await step('uber', () => discoverUber(q, d, audit));
    await step('yango', () => discoverYango(q, d, audit));
    await step('bolt', () => discoverBolt(q, d, audit));
    await step('fms', () => discoverFms(q, d, audit));
    await step('hotel', () => discoverHotel(q, d, audit));
  }
  /* The evidence, for every account: counted from our own rows. */
  let evidenceFailed = 0;
  for (const a of await q(`SELECT id, platform, account_id, filed_fleet, status FROM platform_account`).catch(() => [])) {
    try {
      const ev = await accountEvidence(q, { ...a, id: Number(a.id) });
      await q(`UPDATE platform_account SET detail = detail || jsonb_build_object('evidence', $2::jsonb) WHERE id = $1`, [a.id, JSON.stringify(ev)]);
    } catch (e) { evidenceFailed += 1; log.warn('discovery', 'evidence failed', { account: a.id, err: clean(e) }); }
  }
  let renamed = [];
  try { renamed = await syncFleetNames(q, { audit }); } catch (e) { log.error('discovery', 'fleet names not synced', { err: clean(e) }); }
  const summary = { at: new Date().toISOString(), ms: Date.now() - started, calls: Boolean(calls && d), steps, evidenceFailed,
    renamed: renamed.map((r) => ({ id: r.id, to: r.to, basis: r.basis })) };
  try {
    await setState(q, 'last_run', summary.at);
    await setState(q, 'last_summary', JSON.stringify(summary));
  } catch (e) { log.warn('discovery', 'summary not stored', { err: clean(e) }); }
  log.info('discovery', 'finished', { ms: summary.ms, steps: steps.map((s) => `${s.platform}:${s.ok ? 'ok' : 'failed'}`).join(' '),
    renamed: summary.renamed.map((r) => `${r.id}→${r.to}`).join(', ') || 'none' });
  return summary;
}

/* For a reader who wants the brand an account's own name would give. */
export const accountBrand = (name) => (name ? brandOf([name]).display : null);
