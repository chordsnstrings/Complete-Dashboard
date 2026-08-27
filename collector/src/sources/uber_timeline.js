/* Was the driver ONLINE and waiting, or just offline?
   ─────────────────────────────────────────────────────────────────────────
   The driver page's "How the day was spent" reports, over 28 days, 97.7 h on
   job against 426.9 h waiting — 81% of the working span in one undifferentiated
   band. It cannot tell a driver sitting at a rank with the app on from one who
   logged out and went home. The first is supply the fleet is paying for and
   failing to sell; the second is somebody's evening. Same colour, opposite
   meaning, and it is the largest thing on the page.

   supplier.uber.com/chronicle/graphql answers it per driver, and throws in the
   sub-states of every job: DJ_ASSIGNED, DJ_PICKUP_ARRIVED, DJ_PICKUP,
   DJ_COMPLETED. DJ_PICKUP is the boundary that panel's own footnote says does
   not exist — "the ride cannot be separated from the approach on any booking
   channel". On Uber it can now.

   Measured on production, 2026-08-27:
     · 31 days is the hard maximum per call ("Time Range Exceeds 31 days")
     · one driver over 30 days returns ~1,400 events
     · the org goes in an x-chronicle-widget-auth-scope header, and the session
       cookie is the ordinary supplier one — so this works for both fleets with
       credentials we already hold. */
import { pool, upsertMany, logRun } from '../db.js';
import { http } from '../http.js';
import { log } from '../log.js';
import { uberWebHeaders } from '../auth/uber.js';
import { uberOrgs } from './uber.js';
import { noteCredential } from '../auth_state.js';

const SRC = 'uber';
const GQL = 'https://supplier.uber.com/chronicle/graphql';

/* Uber's own limit, not a chosen one. 31 days is refused with
   "Time Range Exceeds 31 days maximum", so windows are cut at 30 to leave the
   boundary alone. */
export const MAX_WINDOW_DAYS = 30;

const QUERY = `query GetTimelineInfo($driverUuid: String!, $startAt: String!, $endAt: String!) {
  GetTimelineInfo(driverUuid: $driverUuid, startAt: $startAt, endAt: $endAt) {
    timelineInfo {
      timestamp jobuuid partnerUuid activeVehicleUuid status offlineReason
      rootLocation { latitude longitude }
      stateChange { timestamp type location { latitude longitude } }
    }
  }
}`;

/* The widget scope header is how this endpoint learns which org is asking.
   Without it the call is answered for whatever org the session last looked at,
   which for a two-fleet account is a coin toss. */
const scopeHeader = (orgUuid) => JSON.stringify({
  widgetFeatureIdentifier: 'chronicle/driver/timeline/driver-timeline',
  orgUUID: orgUuid,
});

export function windows(from, to, days = MAX_WINDOW_DAYS) {
  const out = [];
  let s = new Date(from);
  const end = new Date(to);
  while (s < end) {
    const e = new Date(Math.min(+end, +s + days * 864e5));
    out.push([new Date(s), e]);
    s = e;
  }
  return out;
}

/** One driver, one window. Returns { events, err }. */
export async function timelineFor(o, driverUuid, s, e) {
  const body = JSON.stringify({
    operationName: 'GetTimelineInfo',
    variables: { driverUuid, startAt: String(+s), endAt: String(+e) },
    query: QUERY,
  });
  const { data, redirected, status } = await http(GQL, {
    method: 'POST', body,
    headers: { ...uberWebHeaders(o), 'x-chronicle-widget-auth-scope': scopeHeader(o.orgUuid) },
  });
  /* A redirect is how this surface says "not logged in": the GraphQL endpoint
     302s to the login page rather than answering with an errors array, and
     fetch follows it silently, so without checking `redirected` an expired
     session reads as a driver who did nothing. src/http.js returns it for
     exactly this class of lie. */
  if (redirected || !data || typeof data !== 'object') {
    return { events: [], err: `session redirected to login (${status}) — the supplier cookie has expired` };
  }
  if (data.errors?.length) {
    return { events: [], err: String(data.errors[0]?.message || data.errors[0]).slice(0, 200) };
  }
  return { events: data?.data?.GetTimelineInfo?.timelineInfo || [], err: null };
}

/* One API event becomes one status row plus one row per job sub-state. Written
   flat rather than nested so a span query is a window function over one table
   rather than a join against a jsonb array. */
export function toRows(o, driverUuid, events) {
  const rows = [];
  for (const ev of events) {
    const at = new Date(Number(ev.timestamp)).toISOString();
    rows.push({
      platform: SRC, fleet_id: o.fleet, driver_ext_id: driverUuid, at,
      kind: 'status', status: ev.status || '', offline_reason: ev.offlineReason || null,
      job_ext_id: ev.jobuuid || null, state: '',
      lat: ev.rootLocation?.latitude ?? null, lon: ev.rootLocation?.longitude ?? null,
      raw: ev,
    });
    for (const ch of ev.stateChange || []) {
      if (!ch?.type || ch.timestamp == null) continue;
      rows.push({
        platform: SRC, fleet_id: o.fleet, driver_ext_id: driverUuid,
        at: new Date(Number(ch.timestamp)).toISOString(),
        kind: 'job', status: '', offline_reason: null,
        job_ext_id: ev.jobuuid || null, state: ch.type,
        lat: ch.location?.latitude ?? null, lon: ch.location?.longitude ?? null,
        raw: ch,
      });
    }
  }
  /* Two events can share an instant AND a state — the API repeats a job's
     sub-states on each event that carries the job — and a single INSERT cannot
     touch the same key twice ("ON CONFLICT DO UPDATE command cannot affect row
     a second time"). Deduped here, on the same key the table uses. */
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.driver_ext_id}|${r.at}|${r.kind}|${r.status}|${r.state}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* Drivers who actually WORKED in this window, not the whole roster.
   ─────────────────────────────────────────────────────────────────────────
   This is one call per driver per window, so the driver set is the cost. The
   Ecosine roster is 154 and Egari's 63; on any given day about 50 and 24 of
   them drive. Asking about the other 143 buys a timeline that is empty by
   construction — they were not working — at two thirds of the request budget.

   `roster` widens it to everyone for a deliberate full sweep, because "who was
   online but never got a job" is a real question and those drivers have no
   trip to find them by. It is not what the scheduled tick does. */
async function driverIdsFor(fleet, from, to, { roster = false } = {}) {
  const { rows } = roster
    ? await pool.query(
      /* UNION, because one of these two is empty for one of the fleets.
         ─────────────────────────────────────────────────────────────────
         driver_platform_state is written by the OAuth REST roster pull, and
         that surface 403s for Egari — the API client is registered under the
         Ecosine org and no org id changes that. So the first roster sweep
         reported "ecosine 113 drivers, 79,674 rows / egari 0 drivers, 0 rows"
         and looked like a fleet that does not exist rather than a credential
         that cannot see it.

         Every driver who has ever taken an Uber trip for this fleet is the
         other half, and it needs no REST call at all. The union is the roster
         until that client is fixed, and remains correct after. */
      `SELECT DISTINCT driver_ext_id FROM (
         SELECT driver_ext_id FROM driver_platform_state
          WHERE platform = 'uber' AND fleet_id = $1
         UNION
         SELECT driver_ext_id FROM trip
          WHERE platform = 'uber' AND fleet_id = $1
       ) s WHERE coalesce(btrim(driver_ext_id), '') <> ''`, [fleet])
    : await pool.query(
      `SELECT DISTINCT driver_ext_id FROM trip
        WHERE platform = 'uber' AND fleet_id = $1
          AND requested_at >= $2 AND requested_at < $3
          AND coalesce(btrim(driver_ext_id), '') <> ''`, [fleet, from, to]);
  return rows.map((r) => r.driver_ext_id);
}

export async function collect({ from, to, mode, roster = false }) {
  let grand = 0;
  for (const o of uberOrgs()) {
    const drivers = await driverIdsFor(o.fleet, from, to, { roster });
    const wins = windows(from, to);
    let rows = 0, failed = 0, empty = 0, firstErr = null;
    for (const driver of drivers) {
      for (const [s, e] of wins) {
        let r;
        try {
          r = await timelineFor(o, driver, s, e);
        } catch (err) {
          failed++; firstErr ||= String(err.message || err);
          continue;
        }
        if (r.err) { failed++; firstErr ||= r.err; continue; }
        if (!r.events.length) { empty++; continue; }
        rows += await upsertMany('driver_timeline_event', toRows(o, driver, r.events),
          ['platform', 'driver_ext_id', 'at', 'kind', 'state', 'status']);
      }
    }
    /* A run that asked every driver and was refused every time is not a fleet
       that stayed offline. Recorded as a credential failure so the banner says
       so, rather than the panel quietly drawing a month of nothing. */
    const asked = drivers.length * wins.length;
    if (asked && failed === asked) {
      await noteCredential(pool, {
        provider: SRC, fleet: o.fleet,
        credential: o.fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI',
        state: 'expired', detail: `driver timeline refused for every driver — ${firstErr}`,
        surface: 'supplier chronicle timeline',
      });
    } else if (rows) {
      await noteCredential(pool, {
        provider: SRC, fleet: o.fleet,
        credential: o.fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI',
        state: 'ok', detail: null, surface: 'supplier chronicle timeline',
      });
    }
    log.info(SRC, 'driver timeline', { fleet: o.fleet, drivers: drivers.length, windows: wins.length, rows, empty, failed });
    await logRun({ source: `${SRC}_timeline`, fleet_id: o.fleet, mode,
      window_start: from, window_end: to,
      status: asked && failed === asked ? 'failed' : 'ok',
      rows_written: rows, error: firstErr });
    grand += rows;
  }
  return grand;
}
