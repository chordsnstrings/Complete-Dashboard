// Uber surfaces the first pass missed: vehicle compliance documents, the richer
// vehicle master, Uber's own recommendations, and the earnings tree (which is where
// tips actually live — the trip report has no tip column).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, normPlate } from '../config.js';
import { http, qs } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { iso } from '../util.js';
import { uberOAuthToken, uberWebHeaders } from '../auth/uber.js';
import { log } from '../log.js';

const SRC = 'uber_fleet';
// The real queries, captured verbatim from the portal. Hand-writing them against a
// field list produced valid-looking GraphQL that the server rejected — the argument
// names and input types differ (pageSize not limit, String not ID, a request object
// for recommendations), so we ship the exact documents instead of a reconstruction.
const __dir = dirname(fileURLToPath(import.meta.url));
const Q = (f) => readFileSync(join(__dir, '..', 'gql', f), 'utf8');
const GQL = 'https://supplier.uber.com/graphql';
const FLEET = 'ecosine';

async function gql(operationName, query, variables) {
  const { data } = await http(GQL, {
    method: 'POST', timeoutMs: 45000, retries: 2,
    headers: uberWebHeaders(), body: JSON.stringify({ operationName, query, variables }),
  });
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

/* ── earnings components: tips, taxes, cash collected, clawbacks ────────── */
async function pullEarningsComponents(from, to) {
  const token = await uberOAuthToken();
  const url = `https://api.uber.com/v1/vehicle-suppliers/earners/payments?${qs({
    org_id: config.uber.org, start_time: new Date(from).getTime(), end_time: new Date(to).getTime(), page_size: 200,
  })}`;
  const { data } = await http(url, { headers: { authorization: `Bearer ${token}` }, timeoutMs: 45000 });
  const rows = [];
  const ps = iso(new Date(from)), pe = iso(new Date(to));
  for (const b of (data?.earnerPaymentBreakdowns || [])) {
    const driver = b.earnerUuid || b.earnerMetadata?.uuid;
    if (!driver) continue;
    const walk = (arr, parent) => {
      for (const c of (arr || [])) {
        if (c.categoryName && c.amount) {
          rows.push({
            platform: 'uber', driver_ext_id: driver, period_start: ps, period_end: pe,
            category: c.categoryName, parent: parent || null,
            amount: Number(c.amount.amountE5 || 0) / 1e5, currency: c.amount.currencyCode || 'AED',
            driver_name: b.earnerMetadata?.name || null, fleet_id: FLEET,
          });
        }
        if (c.children?.length) walk(c.children, c.categoryName);
      }
    };
    walk(b.paymentBreakdowns, null);
  }
  // de-dup on the PK (a category can appear at two depths)
  const seen = new Set();
  const uniq = rows.filter((r) => {
    const k = `${r.driver_ext_id}|${r.category}`;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  return uniq.length ? upsertMany('driver_earnings_component', uniq,
    ['platform', 'driver_ext_id', 'period_start', 'period_end', 'category']) : 0;
}

export async function collect({ from, to, mode }) {
  let vehicles = 0, documents = 0, recs = 0, earnings = 0;
  // Each surface is independent — one failing must not cost us the others.
  try { ({ vehicles, documents } = await pullVehicles()); }
  catch (e) { log.warn(SRC, 'vehicles/compliance failed', { err: String(e).slice(0, 120) }); }
  try { recs = await pullRecommendations(); }
  catch (e) { log.warn(SRC, 'recommendations failed', { err: String(e).slice(0, 120) }); }
  try { earnings = await pullEarningsComponents(from, to); }
  catch (e) { log.warn(SRC, 'earnings components failed', { err: String(e).slice(0, 120) }); }

  await logRun({ source: SRC, fleet_id: FLEET, mode,
    window_start: iso(new Date(from)), window_end: iso(new Date(to)),
    status: (vehicles || recs || earnings) ? 'ok' : 'error',
    rows_written: vehicles + documents + recs + earnings });
  log.info(SRC, 'done', { vehicles, documents, recs, earnings });
}
