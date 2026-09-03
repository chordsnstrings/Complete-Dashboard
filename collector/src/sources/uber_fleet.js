// Uber surfaces the first pass missed: vehicle compliance documents, the richer
// vehicle master, Uber's own recommendations, and the earnings tree (which is where
// tips actually live — the trip report has no tip column).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, normPlate } from '../config.js';
import { http, qs } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { iso, dubaiIso, weekChunks } from '../util.js';
import { uberOAuthToken, uberWebHeaders, UBER_WEB_HOST } from '../auth/uber.js';
import { uberOrgs } from './uber.js';
import { log } from '../log.js';
import { authFailure, saysAuth, noteCredential, noteUberRest, credentialState } from '../auth_state.js';

const SRC = 'uber_fleet';
// The real queries, captured verbatim from the portal. Hand-writing them against a
// field list produced valid-looking GraphQL that the server rejected — the argument
// names and input types differ (pageSize not limit, String not ID, a request object
// for recommendations), so we ship the exact documents instead of a reconstruction.
const __dir = dirname(fileURLToPath(import.meta.url));
const Q = (f) => readFileSync(join(__dir, '..', 'gql', f), 'utf8');
const GQL = `${UBER_WEB_HOST}/graphql`;

/* Every surface below used to be stamped `fleet_id: 'ecosine'` and addressed
   with config.uber.orgUuid — the unsuffixed, Ecosine key. Egari is a
   configured org with its own uuid, encrypted id and web session, and none of
   this ever ran for it: on production Egari carried a bank payout for 7 of 13
   months and an expected payout for 0 of 13, because the component tree that
   `expected` is built from comes from here. collect() now iterates the orgs
   and each surface takes the one it is collecting. */
async function gql(operationName, query, variables, o) {
  const res = await http(GQL, {
    method: 'POST', timeoutMs: 45000, retries: 2,
    headers: uberWebHeaders(o), body: JSON.stringify({ operationName, query, variables }),
  });
  const { data } = res;
  const cred = o.fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI';
  /* The same silent hole the sibling collector had: an expired cookie
     redirects to auth.uber.com and answers 404, which parses as neither JSON
     nor an error, so `data?.errors` was false and `data?.data` undefined and
     every caller read it as a surface with nothing to say. */
  const bad = authFailure(GQL, res);
  if (bad) {
    await noteCredential(pool, { provider: SRC, fleet: o.fleet, credential: cred,
      /* See credentialState(): a bounce off a login host is an expired
         session, a bounce anywhere else is a moved endpoint. */
      state: credentialState(bad), detail: bad.reason,
      surface: `supplier graphql ${operationName}` });
    throw new Error(`${operationName}: web session — ${bad.reason}`);
  }
  if (data?.errors) {
    const msg = String(data.errors[0]?.extensions?.code || data.errors[0]?.message);
    if (saysAuth(msg)) {
      await noteCredential(pool, { provider: SRC, fleet: o.fleet, credential: cred,
        state: 'expired', detail: msg, surface: `supplier graphql ${operationName}` });
    }
    throw new Error(`${operationName}: ${msg}`);
  }
  await noteCredential(pool, { provider: SRC, fleet: o.fleet, credential: cred,
    state: 'ok', detail: null, surface: `supplier graphql ${operationName}` });
  return data?.data;
}

/* ── vehicles + compliance documents (registration/insurance expiry) ────── */

async function pullVehicles(o) {
  let pageToken = null, profiles = [], docs = [], guard = 0;
  do {
    const d = await gql('vehiclesTableVehicles', Q('vehicles.gql'), {
      orgUUID: o.orgUuid, pageToken: pageToken || '', pageSize: 200,
      filters: { vehicleComplianceStatus: null, vehicleAssignmentStatus: null,
                 gigUnifiedStatus: null, gigBaseType: null, documentComplianceStatus: null },
      withAssignments: true,
    }, o);
    const page = d?.getSupplierVehicles;
    for (const v of (page?.vehicles || [])) {
      const plate = normPlate(v.licensePlate);
      profiles.push({
        platform: 'uber', vehicle_ext_id: v.uuid, plate, fleet_id: o.fleet,
        make: v.make, model: v.model, year: v.year, colour: v.color, colour_hex: v.colorHexCode,
        vin: v.vin || null, image_url: v.imageURL || null, owner_ext_id: v.ownerUUID || null,
        assigned_driver_ext_id: v.assignments?.[0]?.entityUUID || null,
        compliance_status: v.compliance?.status || null, raw: v,
      });
      for (const doc of (v.compliance?.documents || [])) {
        docs.push({
          platform: 'uber', vehicle_ext_id: v.uuid, doc_type: doc.documentTypeName || 'unknown',
          plate, fleet_id: o.fleet, status: doc.status || null,
          expires_at: doc.expiresAt || null, raw: doc,
        });
      }
    }
    pageToken = page?.nextPageToken || null;
  } while (pageToken && ++guard < 20);

  const a = profiles.length ? await upsertMany('vehicle_profile', profiles, ['platform', 'vehicle_ext_id']) : 0;
  const b = docs.length ? await upsertMany('vehicle_document', docs, ['platform', 'vehicle_ext_id', 'doc_type']) : 0;
  return { vehicles: a, documents: b };
}

/* ── Uber's own recommendations: who is below target, per Uber's maths ──── */

async function pullRecommendations(o) {
  // Recommendations are published for a trailing window; ask for the last 30 days.
  const endsAt = Date.now(), startsAt = endsAt - 30 * 864e5;
  const d = await gql('getRecommendations', Q('recommendations.gql'), {
    recommendationsRequest: {
      orgUuid: o.orgUuid, userUuid: o.orgUuid,
      timeRange: { startsAt, endsAt }, tenancy: 'uber/production',
    },
  }, o);
  const recs = d?.getRecommendations?.recommendations || [];
  const rows = recs.map((r) => {
    const dd = r.data || {};
    const acc = dd.acceptanceRateRecommendationData;
    const can = dd.cancellationRateRecommendationData;
    const comp = dd.tripCompletionRecommendationData;
    let orgV = null, tgtV = null, flagged = [];
    if (acc) {
      orgV = acc.orgAcceptanceRate; tgtV = acc.targetAcceptanceRate;
      flagged = (acc.belowTargetDrivers || []).map((x) => ({ driver_ext_id: x.uuid, value: x.acceptanceRate }));
    } else if (can) {
      orgV = can.orgCancellationRate; tgtV = can.targetCancellationRate;
      flagged = (can.aboveTargetDrivers || []).map((x) => ({ driver_ext_id: x.uuid, value: x.cancellationRate }));
    } else if (comp) {
      flagged = (comp.belowTargetDrivers || []).map((x) => ({
        driver_ext_id: x.uuid, value: Number(x.tripCount || 0),
        online_hours: Math.round(Number(x.onlineDurationMillis || 0) / 36e5 * 10) / 10,
      }));
    }
    const ms = (v) => (v ? new Date(Number(v)).toISOString().slice(0, 10) : null);
    return {
      platform: 'uber', rec_type: r.type, rec_uuid: r.uuid, fleet_id: o.fleet,
      period_start: ms(r.timeRange?.startsAt), period_end: ms(r.timeRange?.endsAt),
      org_value: orgV, target_value: tgtV,
      flagged_count: flagged.length, flagged: JSON.stringify(flagged), raw: r,
    };
  });
  return rows.length ? upsertMany('platform_recommendation', rows, ['platform', 'rec_type', 'rec_uuid']) : 0;
}

/* ── earnings components: tips, taxes, cash collected, clawbacks ──────────
   This is the only surface that carries Uber money. The trip export has no fare
   column at all, so without this the fleet's largest channel — 165,000 trips —
   contributes nothing to any revenue figure in the product.

   It returned zero rows for its entire life, and reported success while doing
   so. The earner id was read as `earnerUuid` or `earnerMetadata.uuid`; the
   response carries `earnerInfo.uuid`. Every record therefore hit the `continue`
   and the collector wrote nothing, logged nothing, and the run said ok.

   Two lessons are built in below. Field names are read from a list of the
   spellings this API is known to use rather than from one guess. And when
   records come back but none of them map, that is reported as a FAILURE with
   the keys that were actually present — a shape change should read as "we can
   no longer parse this", never as "there was no money this week". */
const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v != null && v !== '') return v;
  }
  return null;
};

/** amountE5 is Uber's fixed-point money; some surfaces send a plain number. */
const money = (a) => {
  if (a == null) return null;
  if (typeof a === 'number') return a;
  if (a.amountE5 != null) return Number(a.amountE5) / 1e5;
  if (a.amount != null) return Number(a.amount);
  return null;
};

/* 50, not 200.
   Uber caps page size on this family of surfaces and does not say so: the
   sibling GraphQL surface rejects anything over ten outright, and this one
   answers 200 OK with an EMPTY earnerPaymentBreakdowns list. The probe, which
   asks for 50, has been getting 50 earner records all along while the
   collector asking for 200 got none — the same endpoint, the same window, the
   same credentials, a different page size. An empty list is indistinguishable
   from a quiet week unless somebody compares the two, so the page size is
   pinned here to the value that is known to work and the pages are walked. */
const EARNER_PAGE = 50;
const EARNER_PAGES_MAX = 40;

/* Asked in Monday-anchored calendar weeks, never in one call for the run's
   window — the same law the Uber and Yango collectors follow, for the same
   reason: this surface aggregates whatever range it is asked, and the range
   asked is the key the rows are stored under. Stamped with the RUN's window,
   an incremental's three days and a backfill's year both produced rows that
   were neither comparable with each other nor with the weekly grid every
   other Uber figure lives on.

   Most of those weeks come back empty, and that is this surface's normal
   answer rather than a fault. Probing it week by week settles what it serves:
   the week ending 23 Aug 2026 answers with thirty-two earners, the week before
   it with none, February with none, and a June-to-today request with the same
   thirty-two — so what comes back is the CURRENT payment period and nothing
   else, however the window is asked. Every historical week in a backfill is
   legitimately silent and no request can change that.

   The zero-earner guard therefore fired on almost every chunk. It threw, which
   abandoned the rest of the loop — and the loop runs oldest first, so a catchup
   over the last month died on its first old week and never reached the one week
   Uber would have answered. The check is still worth making, because the
   failure it was written for (a page size the server silently refuses) is real;
   it just has to be a question about the RUN rather than about each week. If
   the whole window came back without a single earner while the probe of the
   same surface saw some, the request is wrong. If one week answered, the silent
   ones are simply outside the period Uber serves. */
async function pullEarningsComponents(from, to, o) {
  const token = await uberOAuthToken(o);
  let totalRows = 0, earners = 0, weeks = 0, served = 0;
  for (const wk of weekChunks(from, to)) {
    /* `until`, not `end`: the range is HALF-OPEN, so an end of Sunday asks for
       Sunday's first millisecond and nothing else. src/sources/uber.js records
       what that cost on the sibling surface — one day in seven of every Uber
       earning on record — and this collector was still making the same ask.
       The rows keep the CLOSED week as their key, because that is the grid
       every other Uber figure lives on and what schema_v26 prunes against. */
    const r = await pullEarningsWeek(token, wk.start, wk.end, wk.until, o);
    totalRows += r.rows; earners += r.earners; weeks += 1;
    if (r.earners) served += 1;
  }
  /* The probe describes ONE org, so the inference only holds for one fleet.
     ───────────────────────────────────────────────────────────────────────
     provider_probe is keyed (provider, surface) with no fleet column, and
     src/probe.js calls this surface with config.uber.org — Ecosine's. So
     "the probe saw earners, you saw none, therefore your request is wrong"
     is a valid deduction about Ecosine and a non sequitur about anybody else.

     Egari is the anybody else, and it paid for the confusion: this OAuth
     surface serves it nothing at all, every run of it threw against Ecosine's
     probe count, and /api/status reported Egari's uber_fleet as a partial
     failure with a reason that was not true. Its earnings components come
     from the supplier GraphQL breakdown instead (src/sources/uber.js), which
     does answer for both fleets, so an empty answer here is a fact about
     which org this credential covers rather than a fault to raise.

     Recorded rather than thrown for those fleets — a surface that serves one
     org of two is worth knowing about, and worth not being told twice. */
  const probed = o.fleet === config.uber.fleet;
  if (weeks && !earners) {
    /* to_char in the SELECT, not the bare column — the probe time is read to be
       PRINTED, and a bare TIMESTAMPTZ arrives here as a JS Date.
       ─────────────────────────────────────────────────────────────────────
       provider_probe.probed_at is TIMESTAMPTZ DEFAULT now() (sql/schema_v11.sql
       line 26) and nothing in this repo calls setTypeParser, so node-postgres
       parses it into a Date. Dropped into the template literal below, a Date
       stringifies with toString. Measured, feeding this exact sentence a value
       from pg-types.getTypeParser(1184, 'text')('2026-09-02 12:00:01.603+00'):

         …probe of the same surface saw 412 at Wed Sep 02 2026 12:00:01 GMT+0000
         (Coordinated Universal Time). The request, not the window, is wrong.

       Fifty-five characters of JS toString in the one sentence whose job is to
       tell an operator when the probe last looked — and it ships whole: the
       message measures 204 characters, inside the 300-char slice in
       collectOrg() below, and lands in collection_run.error as the named
       uber_fleet failure on the Data-sources page. This is the same trap
       src/sources/ledger.js:239 documents for a DATE ("covering days up to
       Fri Aug 21", live on production while this was written); isoDay() is the
       reader for that case, but the cheaper cure for a value that is only ever
       printed is to make it a string before it leaves Postgres, where no later
       String() or interpolation can turn it back into a Date.

       Asia/Dubai because the fleet works that clock and every other day and
       hour in this product is rendered on it. toISOString() would name the UTC
       hour instead, which is four hours out — and after 20:00 local, the wrong
       day as well. */
    const { rows: [probe] = [] } = await pool.query(
      `SELECT record_count,
              to_char(probed_at AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI') AS probed_at
         FROM provider_probe
        WHERE provider = 'uber' AND surface = 'earner-payments' AND ok`).catch(() => ({ rows: [] }));
    if (probed && probe?.record_count > 0) {
      throw new Error(`earner payments returned no earners in any of ${weeks} week(s), but the `
        + `probe of the same surface saw ${probe.record_count} at ${probe.probed_at} Dubai. `
        + 'The request, not the window, is wrong.');
    }
    if (!probed) {
      log.info(SRC, 'earner payments serves no earners for this org', {
        fleet: o.fleet, weeks, note: 'components come from the supplier GraphQL breakdown' });
    }
  }
  /* Weeks served beside weeks asked, because "3 of 53" is the shape of a
     surface with a horizon and "0 of 53" is the shape of a broken request. */
  log.info(SRC, 'earner payments', { weeks, weeks_served: served, earners, components: totalRows });
  return totalRows;
}

async function pullEarningsWeek(token, from, to, until, o) {
  const call = async (pageToken) => {
    const url = `https://api.uber.com/v1/vehicle-suppliers/earners/payments?${qs({
      org_id: o.org, start_time: new Date(from).getTime(),
      end_time: new Date(until).getTime(), page_size: EARNER_PAGE,
      ...(pageToken ? { page_token: pageToken } : {}),
    })}`;
    const res = await http(url, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 45000 });
    /* The refusal this surface has been answering with for one of the two
       fleets — 403 "bad key" — which nothing read, so an org key that selects
       nothing looked exactly like a provider with nothing to give. */
    const bad = await noteUberRest(pool, url, res, o, 'earners/payments', token);
    if (bad) throw new Error(`earner payments for ${o.fleet}: ${bad.reason}`);
    return res.data;
  };

  const breakdowns = [];
  let pageToken = '', pages = 0;
  do {
    const data = await call(pageToken);
    const page = data?.earnerPaymentBreakdowns || [];
    breakdowns.push(...page);
    pageToken = data?.paginationResult?.nextPageToken || data?.nextPageToken || '';
    if (!page.length) break;
  } while (pageToken && ++pages < EARNER_PAGES_MAX);

  const rows = [];
  /* iso(), deliberately, and NOT dubaiIso(): `from`/`to` here are wk.start and
     wk.end from weekChunks, which are built with Date.UTC and are therefore
     already midnight UTC of the day meant. That is the single argument iso() is
     defined for (src/util.js:86-95) — it is a clock, not an anchor, that iso()
     misreads. dubaiIso() would return the identical string for a UTC-midnight
     instant (+4h stays inside the same UTC day), so the swap would buy nothing
     and would falsely advertise this key as Dubai-anchored. It is not: this
     pair is the PRIMARY KEY of driver_earnings_component together with the
     driver and the category, it is the UTC Monday..Sunday grid every other Uber
     figure lives on, and schema_v26 prunes against it (period_end -
     period_start > 6). Re-anchoring it by a day would fork the grid. */
  const ps = iso(new Date(from)), pe = iso(new Date(to));
  const skipped = [];
  for (const b of breakdowns) {
    const driver = pick(b, 'earnerInfo.uuid', 'earnerUuid', 'earnerMetadata.uuid', 'earner.uuid', 'uuid');
    if (!driver) { skipped.push(Object.keys(b).join(',')); continue; }
    const first = pick(b, 'earnerInfo.firstName', 'earnerMetadata.firstName');
    const last = pick(b, 'earnerInfo.lastName', 'earnerMetadata.lastName');
    const name = pick(b, 'earnerMetadata.name', 'earnerInfo.name')
      || [first, last].filter(Boolean).join(' ') || null;
    const walk = (arr, parent, depth = 0) => {
      if (depth > 6) return;
      for (const c of (arr || [])) {
        const category = pick(c, 'categoryName', 'category', 'name', 'label', 'type');
        const amount = money(pick(c, 'amount', 'value', 'total'));
        if (category && amount != null) {
          rows.push({
            platform: 'uber', driver_ext_id: driver, period_start: ps, period_end: pe,
            category, parent: parent || null, amount,
            currency: pick(c, 'amount.currencyCode', 'currency') || 'AED',
            driver_name: name, fleet_id: o.fleet,
          });
        }
        const kids = c.children || c.breakdowns || c.items || c.subCategories;
        if (kids?.length) walk(kids, category || parent, depth + 1);
      }
    };
    walk(b.paymentBreakdowns || b.breakdowns || b.payments, null);
  }
  /* Records came back and not one of them yielded a row. That is a parse
     failure, not an empty week, and it is exactly the state this collector sat
     in for its whole life while reporting success. */
  if (breakdowns.length && !rows.length) {
    const shape = [...new Set(breakdowns.slice(0, 3).flatMap((b) => Object.keys(b)))].join(', ');
    throw new Error(`earner payments: ${breakdowns.length} earner record(s) and no parsable component. `
      + `Top-level keys seen: ${shape}. Skipped for want of an id: ${skipped.length}.`);
  }
  // de-dup on the PK (a category can appear at two depths)
  const seen = new Set();
  const uniq = rows.filter((r) => {
    const k = `${r.driver_ext_id}|${r.category}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  /* Zero earners is reported upward rather than thrown here — see the run-level
     check in pullEarningsComponents for why that distinction is the difference
     between collecting the one week Uber serves and collecting nothing. */
  return {
    earners: breakdowns.length,
    rows: uniq.length ? await upsertMany('driver_earnings_component', uniq,
      ['platform', 'driver_ext_id', 'period_start', 'period_end', 'category']) : 0,
  };
}

/* One pass per configured org. Each writes its own run row, because
   /api/status renders a source per fleet and a single row covering both would
   report Egari's failure as Ecosine's — or hide it entirely behind Ecosine's
   success, which is how this surface stayed broken for Egari. */
export async function collect({ from, to, mode }) {
  let total = 0;
  const orgs = uberOrgs();
  for (const o of orgs) {
    if (!o.orgUuid || !o.webCookie) {
      /* A LOG LINE IS NOT A RECORD. This was a `continue` and nothing else: no
         run row, no chunk, no credential note — so the fleet did not appear on
         /api/status as broken, it simply was not there, which is the one
         failure mode worse than being broken. bolt.js, fms.js and cabman.js
         all write 'missing' in exactly this situation, and fms.js carries the
         comment explaining why. */
      const cred = o.fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI';
      const why = !o.orgUuid
        ? `no org uuid configured for ${o.fleet}`
        : `no web session configured for ${o.fleet} — set ${cred}`;
      log.warn(SRC, `skipped ${o.fleet}`, { reason: why });
      if (!o.webCookie) {
        await noteCredential(pool, { provider: SRC, fleet: o.fleet, credential: cred,
          state: 'missing', surface: 'fleethub',
          detail: `${why}, so this fleet's supplier surfaces are not collected` })
          .catch(() => {});
      }
      await logRun({ source: SRC, fleet_id: o.fleet, mode, window_start: from, window_end: to,
        status: 'error', rows_written: 0, error: why });
      continue;
    }
    total += await collectOrg({ from, to, mode }, o);
  }
  return total;
}

async function collectOrg({ from, to, mode }, o) {
  let vehicles = 0, documents = 0, recs = 0, earnings = 0;
  /* Each surface is independent — one failing must not cost us the others. But
     "independent" was doing too much work: a surface that threw was written to
     the log and nowhere else, and the run still reported ok as long as ANY of
     the four returned something. Uber earnings failed on every run for the
     collector's whole life and /api/status said "uber_fleet ok" throughout.

     Each failure is now a recorded window, which is what /api/status already
     renders for the sources that chunk — so a surface that stops parsing shows
     up on the Data sources page as a named failure with its reason. */
  const failed = [];
  const surface = async (name, fn) => {
    try { return await fn(); }
    catch (e) {
      const err = String(e?.message || e).slice(0, 300);
      log.warn(SRC, `${name} failed`, { fleet: o.fleet, err });
      /* iso(), not dubaiIso(), and this one is NOT an oversight — see the block
         above logRun() below for the measurement that decided it. These two
         dates are compared against this run's finished_at in the browser, on
         the UTC clock, and must stay on the same clock as the thing they are
         compared with. */
      failed.push({ from: iso(new Date(from)), to: iso(new Date(to)), error: `${name}: ${err}` });
      return null;
    }
  };
  const veh = await surface('vehicles/compliance', () => pullVehicles(o));
  if (veh) ({ vehicles, documents } = veh);
  recs = (await surface('recommendations', () => pullRecommendations(o))) || 0;
  earnings = (await surface('earnings components', () => pullEarningsComponents(from, to, o))) || 0;

  /* The run window, on the clock the fleet works — and the failed-window dates
     a few lines up deliberately NOT on it.
     ────────────────────────────────────────────────────────────────────────
     `from` and `to` here are CLOCKS, not day anchors: src/run.js:293 is
     `catchUp = (days) => runWindow('catchup', daysAgo(days), new Date(), …)`
     and src/util.js:80-81 builds daysAgo/monthsAgo by offsetting `new Date()`.
     iso() on a clock is the UTC day, and between 20:00 and midnight Dubai the
     UTC day is yesterday — so the window was recorded a day short at BOTH ends
     on every scheduled catch-up, because src/index.js:98 runs it at
     `cron.schedule('0 21 * * *')`, 21:00 UTC = 01:00 Dubai. Measured on
     production /api/status, not inferred:

       uber_fleet catchup ecosine | win 2026-08-02 -> 2026-09-01
                                  | finished 2026-09-01T21:06:54.462Z

     21:06:54Z is 02 Sep 01:06 in Dubai, and `to` was the `new Date()` made
     seconds before that, so the run covered up to 2 Sep and the row says 1 Sep.
     dubaiIso() (src/util.js:104) is the same question asked on Dubai's clock.

     These two columns have no reader — checked every consumer: the only
     window_start/window_end rendered in api/public/app.js (line 1623) belongs
     to the `insight` table, not to collection_run — so this is an internal
     honesty fix and there is nothing on a page to compare before and after.

     The failed-window `from`/`to` in surface() above are a different question
     with a different answer, and the difference is measured. Those two land in
     `detail`, come back as failed_windows, and api/public/app.js compares them
     against this run's own finished_at — `dayKey(h.to) > dayKey(h.finished_at)`
     at lines 4098 and 4370 — where dayKey is String(v).slice(0, 10), i.e. the
     UTC day of an ISO instant. Put a Dubai day on one side of that comparison
     and the 21:00 UTC catch-up looks like a window running past its own run:
     replaying production's 42 status rows through the real collectionDebt()
     lifted `invented` from 8 to 10, dropped the debt from 1478 owed days to
     1416, and made both uber_fleet groups vanish from "Windows that did not
     land" — relabelling 62 days of a genuinely dead Uber web session as "not
     yet due". A hole nobody can see is worse than a date a day early, so the
     chunk dates stay on the clock the comparison uses. */
  await logRun({ source: SRC, fleet_id: o.fleet, mode,
    window_start: dubaiIso(from), window_end: dubaiIso(to),
    // Four surfaces: all four working is ok, some working is partial, none is
    // an error. "ok" used to cover three of the four being broken.
    status: failed.length === 0 ? 'ok' : (vehicles || recs || earnings) ? 'partial' : 'error',
    error: failed.length ? failed.map((f) => f.error).join(' | ').slice(0, 500) : null,
    chunks: failed.length
      ? [{ from: iso(new Date(from)), to: iso(new Date(to)), ok: false, rows: 0, error: failed[0].error }]
      : undefined,
    rows_written: vehicles + documents + recs + earnings });
  log.info(SRC, 'done', { fleet: o.fleet, vehicles, documents, recs, earnings, failed: failed.length });
  return vehicles + documents + recs + earnings;
}
