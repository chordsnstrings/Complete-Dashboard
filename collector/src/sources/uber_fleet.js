// Uber surfaces the first pass missed: vehicle compliance documents, the richer
// vehicle master, Uber's own recommendations, and the earnings tree (which is where
// tips actually live — the trip report has no tip column).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, normPlate } from '../config.js';
import { http, qs } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { iso, weekChunks } from '../util.js';
import { uberOAuthToken, uberWebHeaders, PORTAL } from '../auth/uber.js';
import { log } from '../log.js';

const SRC = 'uber_fleet';
// The real queries, captured verbatim from the portal. Hand-writing them against a
// field list produced valid-looking GraphQL that the server rejected — the argument
// names and input types differ (pageSize not limit, String not ID, a request object
// for recommendations), so we ship the exact documents instead of a reconstruction.
const __dir = dirname(fileURLToPath(import.meta.url));
const Q = (f) => readFileSync(join(__dir, '..', 'gql', f), 'utf8');
const GQL = `${PORTAL}/graphql`;
const FLEET = 'ecosine';

async function gql(operationName, query, variables) {
  const { data } = await http(GQL, {
    method: 'POST', timeoutMs: 45000, retries: 2,
    headers: uberWebHeaders(), body: JSON.stringify({ operationName, query, variables }),
  });
  // A signed-out session answers 200 with the login page, not with GraphQL.
  // http() leaves unparseable bodies as a string, so `data.errors` is
  // undefined, `data.data` is undefined, and every caller below reads its rows
  // off `undefined || []` — a run that was refused, recorded as a run that
  // found nothing. Say it instead.
  if (typeof data !== 'object' || data === null) {
    throw new Error(`${operationName}: portal returned ${String(data).length} bytes of non-JSON`
      + ' — the web session is signed out (re-paste the cookie)');
  }
  if (data?.errors) throw new Error(`${operationName}: ${data.errors[0]?.extensions?.code || data.errors[0]?.message}`);
  return data?.data;
}

/* ── vehicles + compliance documents (registration/insurance expiry) ────── */

async function pullVehicles() {
  let pageToken = null, profiles = [], docs = [], guard = 0;
  do {
    const d = await gql('vehiclesTableVehicles', Q('vehicles.gql'), {
      orgUUID: config.uber.orgUuid, pageToken: pageToken || '', pageSize: 200,
      filters: { vehicleComplianceStatus: null, vehicleAssignmentStatus: null,
                 gigUnifiedStatus: null, gigBaseType: null, documentComplianceStatus: null },
      withAssignments: true,
    });
    const page = d?.getSupplierVehicles;
    for (const v of (page?.vehicles || [])) {
      const plate = normPlate(v.licensePlate);
      profiles.push({
        platform: 'uber', vehicle_ext_id: v.uuid, plate, fleet_id: FLEET,
        make: v.make, model: v.model, year: v.year, colour: v.color, colour_hex: v.colorHexCode,
        vin: v.vin || null, image_url: v.imageURL || null, owner_ext_id: v.ownerUUID || null,
        assigned_driver_ext_id: v.assignments?.[0]?.entityUUID || null,
        compliance_status: v.compliance?.status || null, raw: v,
      });
      for (const doc of (v.compliance?.documents || [])) {
        docs.push({
          platform: 'uber', vehicle_ext_id: v.uuid, doc_type: doc.documentTypeName || 'unknown',
          plate, fleet_id: FLEET, status: doc.status || null,
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

async function pullRecommendations() {
  // Recommendations are published for a trailing window; ask for the last 30 days.
  const endsAt = Date.now(), startsAt = endsAt - 30 * 864e5;
  const d = await gql('getRecommendations', Q('recommendations.gql'), {
    recommendationsRequest: {
      orgUuid: config.uber.orgUuid, userUuid: config.uber.orgUuid,
      timeRange: { startsAt, endsAt }, tenancy: 'uber/production',
    },
  });
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
      platform: 'uber', rec_type: r.type, rec_uuid: r.uuid, fleet_id: FLEET,
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
async function pullEarningsComponents(from, to) {
  const token = await uberOAuthToken();
  let totalRows = 0, earners = 0, weeks = 0, served = 0;
  for (const wk of weekChunks(from, to)) {
    /* `until`, not `end`: the range is HALF-OPEN, so an end of Sunday asks for
       Sunday's first millisecond and nothing else. src/sources/uber.js records
       what that cost on the sibling surface — one day in seven of every Uber
       earning on record — and this collector was still making the same ask.
       The rows keep the CLOSED week as their key, because that is the grid
       every other Uber figure lives on and what schema_v26 prunes against. */
    const r = await pullEarningsWeek(token, wk.start, wk.end, wk.until);
    totalRows += r.rows; earners += r.earners; weeks += 1;
    if (r.earners) served += 1;
  }
  if (weeks && !earners) {
    const { rows: [probe] = [] } = await pool.query(
      `SELECT record_count, probed_at FROM provider_probe
        WHERE provider = 'uber' AND surface = 'earner-payments' AND ok`).catch(() => ({ rows: [] }));
    if (probe?.record_count > 0) {
      throw new Error(`earner payments returned no earners in any of ${weeks} week(s), but the `
        + `probe of the same surface saw ${probe.record_count} at ${probe.probed_at}. `
        + 'The request, not the window, is wrong.');
    }
  }
  /* Weeks served beside weeks asked, because "3 of 53" is the shape of a
     surface with a horizon and "0 of 53" is the shape of a broken request. */
  log.info(SRC, 'earner payments', { weeks, weeks_served: served, earners, components: totalRows });
  return totalRows;
}

async function pullEarningsWeek(token, from, to, until = to) {
  const call = async (pageToken) => {
    const url = `https://api.uber.com/v1/vehicle-suppliers/earners/payments?${qs({
      org_id: config.uber.org, start_time: new Date(from).getTime(),
      end_time: new Date(until).getTime(), page_size: EARNER_PAGE,
      ...(pageToken ? { page_token: pageToken } : {}),
    })}`;
    const { data } = await http(url, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 45000 });
    return data;
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
            driver_name: name, fleet_id: FLEET,
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

export async function collect({ from, to, mode }) {
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
      log.warn(SRC, `${name} failed`, { err });
      failed.push({ from: iso(new Date(from)), to: iso(new Date(to)), error: `${name}: ${err}` });
      return null;
    }
  };
  const veh = await surface('vehicles/compliance', pullVehicles);
  if (veh) ({ vehicles, documents } = veh);
  recs = (await surface('recommendations', pullRecommendations)) || 0;
  earnings = (await surface('earnings components', () => pullEarningsComponents(from, to))) || 0;

  await logRun({ source: SRC, fleet_id: FLEET, mode,
    window_start: iso(new Date(from)), window_end: iso(new Date(to)),
    // Four surfaces: all four working is ok, some working is partial, none is
    // an error. "ok" used to cover three of the four being broken.
    status: failed.length === 0 ? 'ok' : (vehicles || recs || earnings) ? 'partial' : 'error',
    error: failed.length ? failed.map((f) => f.error).join(' | ').slice(0, 500) : null,
    chunks: failed.length
      ? [{ from: iso(new Date(from)), to: iso(new Date(to)), ok: false, rows: 0, error: failed[0].error }]
      : undefined,
    rows_written: vehicles + documents + recs + earnings });
  log.info(SRC, 'done', { vehicles, documents, recs, earnings, failed: failed.length });
}
