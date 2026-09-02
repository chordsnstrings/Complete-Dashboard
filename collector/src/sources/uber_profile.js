/* What Uber says about each driver, one driver at a time.
   ──────────────────────────────────────────────────────────────────────────
   The roster page has shown a Rating column of em-dashes for every driver
   since it was built, under a sentence explaining that no channel this fleet
   is connected to reports one. That sentence was written from the two Uber
   surfaces the collector calls — the OAuth roster, which returns onboarding
   status and a plate, and the earnings breakdown, which returns trips,
   distance and money. Neither carries a rating, so the absence looked like a
   fact about the world.

   It is a fact about which questions we ask. The supplier portal answers
   GetDriver with a rating, a lifetime trip count, a banned flag, a compliance
   status and the car the driver is attached to — and it was captured from the
   portal with a working session months ago and left unread. Probed live on
   2026-08-31: rating 4.97, 8,998 completed trips, not banned, ACTIVE, one
   vehicle.

   Three things shape this module.

   ONE CALL PER DRIVER. GetDriver takes a single uuid; there is no list form in
   the captured traffic. At ~160 drivers per org that is ~320 calls a pass, so
   this runs WEEKLY rather than on any collection window, paced, and
   checkpointed per driver so a container restart does not start it again from
   the top. Weekly is the right cadence twice over: Uber's rating is a trailing
   average over hundreds of trips and moves by hundredths in a week, so a daily
   pull would write seven identical rows for every real movement — and 320
   calls a week is a different proposition from 2,240.

   THE ORG MUST OWN THE DRIVER. Asking Ecosine's org about an Egari driver
   returns an INTERNAL_SERVER_ERROR with an empty message — measured, and the
   reason the first live probe failed. So each org is asked only about the
   drivers its own roster names, and a driver we cannot attribute is skipped
   rather than guessed at.

   A RATING IS NOT A JUDGEMENT WE MAKE. It is stored as the platform's own
   number, on the platform's own row, and NULL means we did not ask or Uber did
   not answer — never that the driver is unrated. See sql/schema_v45.sql. */
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, pool, logRun } from '../db.js';
import { uberWebHeaders, UBER_WEB_HOST } from '../auth/uber.js';
import { uberOrgs } from './uber.js';
import { authFailure, saysAuth, noteCredential, credentialState } from '../auth_state.js';
import { log } from '../log.js';

const SRC = 'uber_profile';
const URL_ = `${UBER_WEB_HOST}/graphql`;

/* The selection set, trimmed to what we store. The portal's own query asks for
   a picture url, a phone number and an email as well; none of them is a fact
   about the work and this is not the place to start holding them. */
const QUERY = `query GetDriver($orgUUID: ID!, $driverUUID: ID!) {
  getDriver(orgUUID: $orgUUID, driverUUID: $driverUUID) {
    driver {
      uuid
      member { user {
        uuid
        driverInfo { completedTripsCount recognitionRating }
        isBanned
      } }
      associatedVehicles { uuid licensePlate make model year }
      complianceInfo { status }
    }
  }
}`;

const credOf = (o) => (o.fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI');

/* One driver. Returns { row, vehicles } or an error, and never throws for a
   single bad driver — one uuid Uber will not answer about must not cost the
   other hundred and fifty. */
async function fetchOne(o, uuid) {
  const res = await http(URL_, {
    method: 'POST', timeoutMs: 30000, headers: uberWebHeaders(o),
    body: JSON.stringify({ operationName: 'GetDriver',
      variables: { orgUUID: o.orgUuid, driverUUID: uuid }, query: QUERY }),
  });
  const bad = authFailure(URL_, res);
  /* `kind` travels with the refusal so the caller can record the accurate
     credential state — a moved endpoint is not an expired cookie. */
  if (bad) return { auth: true, err: bad.reason, kind: bad.kind };
  const { data } = res;
  if (data?.errors?.length) {
    const e = data.errors[0];
    /* JSON, not String(). Half of Uber's GraphQL errors carry no `message` and
       String() on one yields "[object Object]" — a diagnostic that diagnoses
       nothing, and the exact slip that left the analyst's charging-site rule
       naming no place. */
    const msg = (typeof e === 'string' ? e : (e?.message || JSON.stringify(e))).slice(0, 300);
    return { auth: saysAuth(msg), err: msg };
  }
  const d = data?.data?.getDriver?.driver;
  if (!d) return { err: 'no driver in the response' };

  const info = d.member?.user?.driverInfo || {};
  const rating = Number(info.recognitionRating);
  const trips = Number(info.completedTripsCount);
  const cars = (d.associatedVehicles || []).filter((v) => v && (v.licensePlate || v.uuid));
  return {
    row: {
      platform: 'uber', driver_ext_id: uuid, fleet_id: o.fleet,
      rating: Number.isFinite(rating) ? rating : null,
      lifetime_trips: Number.isFinite(trips) ? trips : null,
      is_banned: typeof d.member?.user?.isBanned === 'boolean' ? d.member.user.isBanned : null,
      compliance_status: d.complianceInfo?.status || null,
      profile_at: new Date().toISOString(),
    },
    /* The assignment as the PROVIDER states it, which is a different and better
       fact than the one this product infers from who happened to drive the car.
       Only the first is taken for the driver row: associatedVehicles is a list
       and a driver attached to two cars has no single plate. */
    vehicles: cars.map((v) => ({
      plate: normPlate(v.licensePlate), ext_id: v.uuid || null,
      make: v.make || null, model: v.model || null,
      year: Number.isFinite(Number(v.year)) ? Number(v.year) : null,
      fleet_id: o.fleet,
    })).filter((v) => v.plate),
  };
}

/* Every Uber driver this org's own roster names. Restricted to the org because
   asking about another fleet's driver is an error, not an empty answer. */
async function driverIdsFor(o) {
  const { rows } = await pool.query(
    `SELECT driver_ext_id FROM driver_platform_state
      WHERE platform = 'uber' AND fleet_id = $1
        AND coalesce(btrim(driver_ext_id), '') <> ''
      ORDER BY observed_at DESC NULLS LAST`, [o.fleet]);
  return rows.map((r) => r.driver_ext_id);
}

async function pullOrg(o, { checkpoint = null, onStep = null } = {}) {
  const ids = await driverIdsFor(o);
  if (!ids.length) {
    log.warn(SRC, 'no roster to profile', { fleet: o.fleet });
    /* `noRoster`, not a bare zero.
       ─────────────────────────────────────────────────────────────────────
       This returned { drivers: 0, rated: 0, vehicles: 0 } — no `failed` key —
       and collect() decided the status with `r.failed ? 'partial' : 'ok'`.
       An absent key is falsy, so a pass that could not begin, asked nobody and
       stored nothing recorded itself as a clean run: status ok, and the
       Data-sources page prints a green "healthy" in the Detail column for any
       row with no error. The one surface this could happen to is the one it
       matters most for — driver_platform_state is written by the OAuth REST
       roster, which 403s for Egari (see src/sources/uber_timeline.js), so an
       empty roster here is a credential story, not a fleet with no drivers. */
    return { drivers: 0, rated: 0, vehicles: 0, asked: 0, failed: 0, skipped: 0, noRoster: true };
  }
  const rows = [];
  const cars = new Map();
  let rated = 0, failed = 0, skipped = 0;

  for (const uuid of ids) {
    if (checkpoint?.has(`profile ${o.fleet}`, uuid)) { skipped += 1; continue; }
    let out;
    try { out = await fetchOne(o, uuid); }
    catch (e) { out = { err: String(e).slice(0, 200) }; }

    if (out.auth) {
      /* A dead cookie is not a fleet of unrated drivers. Stop the pass and say
         so, rather than writing 160 nulls that read as an answer. */
      /* provider SRC ('uber_profile'), not 'uber'.
         ─────────────────────────────────────────────────────────────────────
         credential_state is keyed (provider, fleet_id, credential), so writing
         'uber' here put this refusal in the row src/sources/uber.js rewrites
         every half hour — measured on production /api/auth 2026-09-02, that
         row reads surface "supplier graphql", the half-hourly writer's, not
         this one's. A GetDriver refusal recorded on a Monday was green again
         by 00:50. And /api/auth ages a credential against the collection_run
         whose SOURCE matches the PROVIDER, so under 'uber' this surface's
         staleness was measured against a feed that runs every thirty minutes.
         src/sources/uber_fleet.js already writes under its own provider name
         with this same cookie. */
      await noteCredential(pool, { provider: SRC, fleet: o.fleet,
        credential: credOf(o), state: credentialState(out), detail: out.err,
        surface: 'supplier graphql GetDriver' });
      throw new Error(`profile ${o.fleet}: ${out.err}`);
    }
    if (out.err) {
      failed += 1;
      if (failed <= 3) log.warn(SRC, 'driver refused', { fleet: o.fleet, err: out.err });
    } else {
      rows.push(out.row);
      if (out.row.rating != null) rated += 1;
      for (const v of out.vehicles) cars.set(v.plate, v);
      await checkpoint?.mark(`profile ${o.fleet}`, uuid, 1);
    }
    onStep?.();
    /* Paced. The portal is a browser surface and this is the only place in the
       collector that makes a call per driver; a burst of 160 is what gets a
       session rate-limited. */
    await new Promise((r) => setTimeout(r, 250));
  }

  if (rows.length) {
    await upsertMany('driver_platform_state', rows, ['platform', 'driver_ext_id']);
    /* And kept, as well as overwritten.
       ─────────────────────────────────────────────────────────────────────
       driver_platform_state answers "what is this driver rated"; it is
       replaced on every pass and can never answer "is it going up". The second
       question is the actionable one — 4.71 is a fact, 4.71 down from 4.86
       over five weeks is a conversation — so every reading also lands as its
       own row, keyed on the day it was taken. A week we did not ask leaves no
       row rather than a repeated one, so a gap reads as unmeasured rather than
       unchanged. See sql/schema_v46.sql. */
    const day = new Date(Date.now() + 4 * 3600 * 1000).toISOString().slice(0, 10);
    await upsertMany('driver_rating_history', rows.map((r) => ({
      platform: r.platform, driver_ext_id: r.driver_ext_id, observed_on: day,
      fleet_id: r.fleet_id, rating: r.rating, lifetime_trips: r.lifetime_trips,
      is_banned: r.is_banned, compliance_status: r.compliance_status,
    })), ['platform', 'driver_ext_id', 'observed_on']);
  }
  if (cars.size) {
    /* Never overwrite a make, model or year that is already recorded with a
       null: a driver attached to no car must not blank the car's own record.
       COALESCE keeps whatever is there when Uber does not say. */
    const list = [...cars.values()];
    const cols = ['plate', 'ext_id', 'make', 'model', 'year', 'fleet_id'];
    const params = [];
    const tuples = list.map((v) => `(${cols.map((c) => { params.push(v[c]); return `$${params.length}`; }).join(',')})`);
    await pool.query(
      `INSERT INTO vehicle (${cols.join(',')}) VALUES ${tuples.join(',')}
       ON CONFLICT (plate) DO UPDATE SET
         ext_id   = coalesce(EXCLUDED.ext_id,   vehicle.ext_id),
         make     = coalesce(EXCLUDED.make,     vehicle.make),
         model    = coalesce(EXCLUDED.model,    vehicle.model),
         year     = coalesce(EXCLUDED.year,     vehicle.year),
         fleet_id = coalesce(vehicle.fleet_id,  EXCLUDED.fleet_id),
         updated_at = now()`, params);
  }
  log.info(SRC, 'profiles', { fleet: o.fleet, asked: ids.length - skipped, stored: rows.length,
    rated, vehicles: cars.size, failed, skipped });
  /* `asked` travels with the counts. Without it collect() cannot tell "three
     drivers refused out of three hundred" from "three out of three", and those
     are a blip and a dead surface. */
  return { drivers: rows.length, rated, vehicles: cars.size, asked: ids.length - skipped,
    failed, skipped };
}

export async function collect({ mode = 'profile', fleet = null, checkpoint = null, onStep = null } = {}) {
  let any = 0;
  for (const o of uberOrgs(fleet)) {
    try {
      const r = await pullOrg(o, { checkpoint, onStep });
      any += r.drivers;
      /* ok | partial | error, decided on how much of the pass survived.
         ─────────────────────────────────────────────────────────────────────
         Two things were wrong with `r.failed ? 'partial' : 'ok'`.

         A pass with no roster (above) fell to 'ok'. And a pass in which the
         provider refused EVERY driver fell to 'partial' with rows_written 0 —
         the exact shape src/db.js's logRun refuses to allow a chunked source,
         in its own words: "one that failed on ALL of them is not 'partial'
         either — there is no part". The Data-sources page paints partial amber
         and error red, so a surface that answered for nobody wore the colour
         of a run that mostly worked.

         Live reading this corrects: /api/status on 2026-09-02 showed
         uber_profile ecosine/egari 'ok', 113 and 43 rows, 46 h old. Those are
         real numbers from a real pass (job 34, 31 Aug 13:27) — the point is
         that nothing in that row shape could have said otherwise if they had
         not been. */
      const allRefused = r.asked > 0 && r.failed === r.asked;
      const status = (r.noRoster || allRefused) ? 'error' : (r.failed ? 'partial' : 'ok');
      const error = r.noRoster
        ? `no Uber roster for ${o.fleet} to profile — driver_platform_state names no driver `
          + 'for this fleet, so this pass asked nobody'
        : (r.failed ? `${r.failed} of ${r.asked} driver(s) refused by the provider` : null);
      await logRun({ source: SRC, fleet_id: o.fleet, mode, status,
        rows_written: r.drivers, error });
      /* The green half, which did not exist.
         ─────────────────────────────────────────────────────────────────────
         This module wrote credential_state only from the `out.auth` branch in
         pullOrg — a refusal and never a success — so once the row went red
         nothing this surface could do would clear it, and replacing the cookie
         would leave the banner red until some other surface happened to write
         the same key. src/auth_state.js states the rule for the REST surfaces:
         "a banner that can only ever go red never goes green again". Any
         answered driver is proof the session authenticated. */
      if (r.asked > 0 && r.failed < r.asked) {
        await noteCredential(pool, { provider: SRC, fleet: o.fleet, credential: credOf(o),
          state: 'ok', detail: null, surface: 'supplier graphql GetDriver' });
      }
    } catch (e) {
      await logRun({ source: SRC, fleet_id: o.fleet, mode, status: 'error', error: String(e).slice(0, 400) });
      log.error(SRC, 'failed', { fleet: o.fleet, err: String(e).slice(0, 200) });
    }
  }
  return any;
}
