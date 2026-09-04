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
import { dubaiIso } from '../util.js';

const SRC = 'uber_profile';
const URL_ = `${UBER_WEB_HOST}/graphql`;

/* The selection set.
   ─────────────────────────────────────────────────────────────────────────
   This used to stop at the driving record, with the note that the portal
   "asks for a picture url, a phone number and an email as well; none of them
   is a fact about the work and this is not the place to start holding them".
   The operator asked for them, so they are here now — and they go to
   driver_compliance, which has been the fleet's contact store since v2 and
   already held a phone for all 132 hotel drivers.

   THE SPELLINGS ARE MEASURED, NOT GUESSED. Introspection is disabled on this
   gateway ("GraphQL introspection is not allowed by Apollo Server"), and its
   refusals are scrubbed of their "Did you mean" suggestions, so the schema had
   to be established a field at a time through api/probe.js. What answers:

     email                              a scalar
     pictureUrl                         a scalar
     phone { countryCode
             nationalPhoneNumber }      +971 / 569585536
     name  { firstName lastName }

   phoneNumber, mobile, mobileNumber, emailAddress, photoUrl, profilePhotoUrl,
   avatarUrl and eleven more spellings of the number are all named absent, and
   so is EVERY address spelling on all three parent types — there is no postal
   address on this surface. sql/schema_v57.sql records that so nobody repeats
   the fifty-eight requests it took to find out. */
const QUERY = `query GetDriver($orgUUID: ID!, $driverUUID: ID!) {
  getDriver(orgUUID: $orgUUID, driverUUID: $driverUUID) {
    driver {
      uuid
      member { user {
        uuid
        driverInfo { completedTripsCount recognitionRating }
        isBanned
        email
        pictureUrl
        phone { countryCode nationalPhoneNumber }
        name { firstName lastName }
      } }
      associatedVehicles { uuid licensePlate make model year }
      complianceInfo { status }
    }
  }
}`;

/* E.164, with the plus. Uber hands back the country code and the national
   number separately and the hotel channel stores one string, so a column
   holding both spellings would be a column nobody can match on.
   sql/schema_v57.sql normalises the existing rows to the same form. */
export function e164(phone) {
  const cc = String(phone?.countryCode || '').replace(/[^0-9]/g, '');
  const nn = String(phone?.nationalPhoneNumber || '').replace(/[^0-9]/g, '');
  if (!cc || !nn) return null;
  return `+${cc}${nn}`;
}

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

  const u = d.member?.user || {};
  const info = u.driverInfo || {};
  const rating = Number(info.recognitionRating);
  const trips = Number(info.completedTripsCount);
  const cars = (d.associatedVehicles || []).filter((v) => v && (v.licensePlate || v.uuid));
  return {
    row: {
      platform: 'uber', driver_ext_id: uuid, fleet_id: o.fleet,
      rating: Number.isFinite(rating) ? rating : null,
      lifetime_trips: Number.isFinite(trips) ? trips : null,
      is_banned: typeof u.isBanned === 'boolean' ? u.isBanned : null,
      compliance_status: d.complianceInfo?.status || null,
      profile_at: new Date().toISOString(),
    },
    /* The contact details, kept apart from the driving record deliberately.
       driver_platform_state is rewritten on every pass and is the fleet's
       operational view; driver_compliance is where a person's phone, licence
       and identity documents already live, for the hotel channel since v2.
       Personal details belong in one place, not two. */
    contact: {
      platform: 'uber', driver_ext_id: uuid, fleet_id: o.fleet,
      full_name: [u.name?.firstName, u.name?.lastName]
        .filter((x) => x && String(x).trim()).join(' ').trim() || null,
      phone: e164(u.phone),
      email: u.email || null,
      picture_url: u.pictureUrl || null,
      rating: Number.isFinite(rating) ? rating : null,
      state: d.complianceInfo?.status || null,
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

/* The two writes that make a profile durable, so they can happen per batch
   instead of once at the very end of a 160-driver pass. */
async function writeProfiles(rows, contacts = []) {
  if (!rows.length) return;
  await upsertMany('driver_platform_state', rows, ['platform', 'driver_ext_id']);
  /* The contact details, into the store that has always held them. Only rows
     that actually carry something: a driver whose portal record has no phone,
     no email and no picture must not overwrite whatever is on file with three
     nulls. */
  const real = contacts.filter((c) => c && (c.phone || c.email || c.picture_url));
  if (real.length) await upsertMany('driver_compliance', real, ['platform', 'driver_ext_id']);
  /* And kept, as well as overwritten.
     ─────────────────────────────────────────────────────────────────────
     driver_platform_state answers "what is this driver rated"; it is
     replaced on every pass and can never answer "is it going up". The second
     question is the actionable one — 4.71 is a fact, 4.71 down from 4.86
     over five weeks is a conversation — so every reading also lands as its
     own row, keyed on the day it was taken. A week we did not ask leaves no
     row rather than a repeated one, so a gap reads as unmeasured rather than
     unchanged. See sql/schema_v46.sql. */
  /* dubaiIso(), not a hand-rolled +4h. The shift was right — this row is
     keyed on the Dubai day the reading was taken — but written out inline it
     was one more copy of arithmetic src/util.js already owns, and the one
     place a future edit would not think to look. */
  const day = dubaiIso();
  await upsertMany('driver_rating_history', rows.map((r) => ({
    platform: r.platform, driver_ext_id: r.driver_ext_id, observed_on: day,
    fleet_id: r.fleet_id, rating: r.rating, lifetime_trips: r.lifetime_trips,
    is_banned: r.is_banned, compliance_status: r.compliance_status,
  })), ['platform', 'driver_ext_id', 'observed_on']);
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

  /* ── the checkpoint must not run ahead of the write ──────────────────────
     checkpoint.mark said "this driver is done" as soon as the row was pushed
     onto an in-memory array, and the array was not written until the loop
     ended. So an auth refusal on driver 150 — which this function deliberately
     THROWS on, four lines below — discarded all 149 profiles collected before
     it, while the checkpoint recorded every one of them as collected. The
     resumed job then skipped them, and the rows were lost until something
     cleared the checkpoint. checkpoint.js's own contract is mark-after-write.

     Flushed in batches rather than once at the end, because marking only after
     the whole loop would trade the bug for its opposite: a run that dies at
     driver 150 of 160 would restart at zero every time and never finish. A
     batch is written, and only then are its drivers marked. */
  const BATCH = 25;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    await writeProfiles(batch.map((b) => b.row), batch.map((b) => b.contact));
    for (const b of batch) await checkpoint?.mark(`profile ${o.fleet}`, b.uuid, 1);
    rows.push(...batch.map((b) => b.row));
  };

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
      pending.push({ row: out.row, contact: out.contact, uuid });
      if (out.row.rating != null) rated += 1;
      for (const v of out.vehicles) cars.set(v.plate, v);
      if (pending.length >= BATCH) await flush();
    }
    onStep?.();
    /* Paced. The portal is a browser surface and this is the only place in the
       collector that makes a call per driver; a burst of 160 is what gets a
       session rate-limited. */
    await new Promise((r) => setTimeout(r, 250));
  }

  await flush();
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
