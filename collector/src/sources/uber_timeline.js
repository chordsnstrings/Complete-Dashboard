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
import { uberWebHeaders, UBER_WEB_HOST } from '../auth/uber.js';
import { uberOrgs } from './uber.js';
import { noteCredential } from '../auth_state.js';

const SRC = 'uber';
/* The name this surface answers to in collection_run AND in credential_state,
   and they have to be the same string.
   ─────────────────────────────────────────────────────────────────────────
   credential_state is keyed (provider, fleet_id, credential) — sql/schema_v33
   — and this module used to write provider 'uber', which is the row
   src/sources/uber.js rewrites on its half-hourly incremental. Measured on
   production /api/auth 2026-09-02 11:30 UTC: the ecosine UBER_WEB_COOKIE row
   reads surface "supplier graphql", not "supplier chronicle timeline" — the
   half-hourly writer had already erased this one. So a chronicle session that
   died on Thursday went back to green within thirty minutes of dying, every
   time, and could never be reported.

   Worse, /api/auth measures a credential's stall as the age of the newest
   collection_run whose SOURCE equals the credential's PROVIDER. Under
   'uber' that clock read 0.6 h while this surface's own last roster sweep was
   148 h old. Under 'uber_timeline' it reads the timeline's own runs, which is
   the only way the banner can ever say this feed has stopped.

   src/sources/uber_fleet.js already does exactly this with the same cookie —
   /api/auth carries a separate uber_fleet row for it — so this is the pattern
   the codebase already has, not a new one. */
const RUN_SRC = 'uber_timeline';
const GQL = `${UBER_WEB_HOST}/chronicle/graphql`;

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
    const cred = o.fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI';
    if (asked && failed === asked) {
      await noteCredential(pool, {
        provider: RUN_SRC, fleet: o.fleet, credential: cred,
        state: 'expired', detail: `driver timeline refused for every driver — ${firstErr}`,
        surface: 'supplier chronicle timeline',
      });
    } else if (asked) {
      /* Any answered ask is proof the session authenticated, so the green half
         keys on that rather than on rows. It used to key on `rows`, which meant
         a window in which every driver was genuinely idle — an answered request
         carrying no events — left the row wherever the last failure had put it.
         A banner that can only ever go red never goes green again. */
      await noteCredential(pool, {
        provider: RUN_SRC, fleet: o.fleet, credential: cred,
        state: 'ok', detail: null, surface: 'supplier chronicle timeline',
      });
    }
    log.info(SRC, 'driver timeline', { fleet: o.fleet, drivers: drivers.length, windows: wins.length, rows, empty, failed });
    /* ok | partial | error, and nothing else.
       ─────────────────────────────────────────────────────────────────────
       This reported the literal string 'failed' when every ask was refused and
       'ok' for everything else, and both halves were wrong.

       'failed' is not a word the rest of the product knows. The Data-sources
       page maps { ok: 'ok', partial: 'warn', error: 'bad' } and falls through
       to 'bad', so it happened to paint red; src/db.js's logRun, which decides
       the same question for every chunked source, calls that case 'error'.
       One vocabulary, and this is now in it.

       The 'ok' was the expensive half. A stale supplier session does not
       refuse every driver at once — it keeps answering for what it has warm —
       so the ordinary shape of this surface dying is most drivers refused and
       a few answered, and that reported status 'ok' with a green "healthy" in
       the Detail column of the page whose subject is which collector has
       stopped. The error string carried the provider's message and nothing
       about how much of the run it applied to, so 3-of-4 refused and 1-of-400
       refused read identically. */
    const someFailed = failed > 0 && failed < asked;
    await logRun({ source: RUN_SRC, fleet_id: o.fleet, mode,
      window_start: from, window_end: to,
      status: asked && failed === asked ? 'error' : (someFailed ? 'partial' : 'ok'),
      rows_written: rows,
      error: failed
        ? `${failed} of ${asked} driver-window request(s) refused — ${firstErr}`
        : null });
    grand += rows;
  }
  return grand;
}
