// Uber collector (Ecosine).
//  Historical trips  : report pipeline GenerateReport -> poll DownloadReport -> signed CSV.
//                      Server limits: <=31-day range, <=3 concurrent reports, async, ~12mo retention.
//  Driver perf       : GraphQL getPerformanceReport / getEarnerBreakdownsV2 (per driver).
//  Live status       : OAuth /drivers/actions (online/on-trip/offline).
import { parse } from 'csv-parse/sync';
import { config, normPlate } from '../config.js';
import { http, qs, sleep } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { dateChunks, iso, unixMs } from '../util.js';
import { uberOAuthToken, uberWebHeaders } from '../auth/uber.js';
import { log } from '../log.js';

const SRC = 'uber';
const REPORTS = 'https://supplier.uber.com/api/vs-sp-reports-management';

// Uber caps an org at three reports in flight. Abandoning a report does not
// release its slot, so a run that gives up on three slow reports poisons every
// later chunk: GenerateReport then fails instantly and the whole backfill
// "succeeds" with zero rows. Wait the limit out rather than burning the run.
const CONCURRENCY_HINT = /concurrent|too many|limit|in progress|rate/i;

async function generateReport(start, end, attempt = 0) {
  const body = JSON.stringify({
    orgId: { uuid: { value: config.uber.orgUuid } },
    reportType: 'REPORT_TYPE_TRIP_ACTIVITY',
    startDate: { value: iso(start) }, endDate: { value: iso(end) },
    childOrgUuids: [{ uuid: { value: config.uber.orgUuid } }],
  });
  const { data } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`,
    { method: 'POST', headers: uberWebHeaders(), body });
  if (data.status !== 'success') {
    const detail = JSON.stringify(data?.data?.meta?.details || data);
    if (CONCURRENCY_HINT.test(detail) && attempt < 4) {
      const wait = 60000 * (attempt + 1);
      log.warn(SRC, `report slot busy, waiting ${wait / 1000}s`, { attempt: attempt + 1 });
      await sleep(wait);
      return generateReport(start, end, attempt + 1);
    }
    throw new Error('generate: ' + detail.slice(0, 300));
  }
  return data.data.reportId.uuid.value;
}

// A three-day report lands in seconds; a full month for ~90 vehicles routinely
// takes several minutes. The old fixed 12x5s budget timed out on every monthly
// chunk, which is why a year backfill returned nothing at all.
async function downloadReport(reportId, budgetMs = 600000) {
  const deadline = Date.now() + budgetMs;
  let wait = 4000;
  while (Date.now() < deadline) {
    const { data } = await http(`${REPORTS}/DownloadReport?localeCode=en-GB`, {
      method: 'POST', headers: uberWebHeaders(),
      body: JSON.stringify({ orgId: { uuid: { value: config.uber.orgUuid } }, reportId: { uuid: { value: reportId } } }),
    });
    const url = data?.data?.signedUrl?.value;
    if (url) return url;
    const status = JSON.stringify(data?.data?.status || data?.status || '');
    if (/fail|error/i.test(status)) throw new Error(`report ${reportId} failed server-side: ${status.slice(0, 160)}`);
    await sleep(wait);
    wait = Math.min(wait * 1.4, 20000);       // back off, but keep checking
  }
  throw new Error(`download timed out after ${Math.round(budgetMs / 1000)}s for report ${reportId}`);
}

function csvToTrips(csv) {
  const recs = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
  return recs.map((r) => ({
    platform: SRC, external_id: r['Trip UUID'], fleet_id: config.uber.fleet,
    plate: normPlate(r['Number plate']),
    driver_ext_id: r['Driver UUID'],
    driver_name: `${r['Driver first name'] || ''} ${r['Driver surname'] || ''}`.trim(),
    requested_at: r['Trip request time'] ? r['Trip request time'].replace(' ', 'T') + '+04:00' : null,
    ended_at: r['Trip drop-off time'] ? r['Trip drop-off time'].replace(' ', 'T') + '+04:00' : null,
    pickup_addr: r['Pick-up address'], dropoff_addr: r['Drop-off address'],
    distance_km: parseFloat(r['Trip distance']) || null,
    status: r['Trip status'], product: r['Product type'], payment_type: r['Payment type'],
    raw: r,
  })).filter((t) => t.external_id);
}

// Pull historical trips one month at a time. Sequential is necessary but not
// sufficient: a report abandoned mid-generation keeps its slot, so pacing and a
// realistic poll budget are what actually keep us under the three-report cap.
async function pullTrips(from, to) {
  let total = 0;
  const chunks = [...dateChunks(from, to, config.uber.reportRangeDays)];
  let consecutiveFailures = 0;
  for (const [s, e] of chunks) {
    try {
      const id = await generateReport(s, e);
      const url = await downloadReport(id);
      const { data: csv } = await http(url, { expect: 'text', timeoutMs: 180000 });
      const rows = csvToTrips(csv);
      if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
      log.info(SRC, `trips ${iso(s)}..${iso(e)}`, { rows: rows.length });
      consecutiveFailures = 0;
    } catch (err) {
      const msg = String(err);
      // "invalid date range" past retention (~12mo) is expected on the oldest
      // chunks; anything else is a real failure and is logged as one, because a
      // silent skip turns a broken backfill into a successful empty one.
      const expected = /invalid date range|retention|out of range/i.test(msg);
      log[expected ? 'info' : 'error'](SRC, `trip chunk ${iso(s)}..${iso(e)} ${expected ? 'outside retention' : 'FAILED'}`,
        { err: msg.slice(0, 300) });
      if (!expected) consecutiveFailures++;
    }
    // Pause between chunks so the previous report's slot is released before the
    // next GenerateReport, rather than racing the three-in-flight cap.
    await sleep(consecutiveFailures ? 20000 : 4000);
  }
  if (consecutiveFailures >= 3) log.error(SRC, 'trip backfill degraded', { consecutiveFailures, chunks: chunks.length });
  return total;
}

// Per-driver earnings + trip count + distance (7-day windows, GraphQL).
async function pullEarnerBreakdowns(from, to) {
  let total = 0;
  for (const [s, e] of dateChunks(from, to, 7)) {
    const body = JSON.stringify({
      operationName: 'getEarnerBreakdownsV2',
      variables: {
        supplierUuid: config.uber.orgUuid,
        timeRange: { unixMilliOrDate: 'Unix_Time_Range', startTimeUnixMillis: unixMs(s), endTimeUnixMillis: unixMs(e) },
        driverListOrPageOptions: 'Page_Options', pageOptions: { pageSize: 200, pageToken: '' },
        driverList: null, excludeAdjustmentItems: true,
      },
      query: `query getEarnerBreakdownsV2($supplierUuid: ID!, $timeRange: OneOfTimeRange__Input, $driverListOrPageOptions: DriverListOrPagination, $driverList: [ID!], $pageOptions: PaginationOption__Input, $excludeAdjustmentItems: Boolean) {
        getEarnerBreakdownsV2(supplierUuid: $supplierUuid, timeRange: $timeRange, driverList: $driverList, pageOptions: $pageOptions, driverListOrPageOptions: $driverListOrPageOptions, excludeAdjustmentItems: $excludeAdjustmentItems) {
          earnerEarningsBreakdowns { earnerUuid earnerMetadata { name } tripInfos { tripAttributeName value } netOutstanding { amountE5 currencyCode } }
        } }`,
    });
    const { data } = await http('https://supplier.uber.com/graphql', { method: 'POST', headers: uberWebHeaders(), body });
    // An expired web cookie answers with `errors` and no data, which is
    // indistinguishable from "this fleet had no drivers" unless we say so.
    if (data?.errors?.length) {
      log.warn(SRC, `earner breakdown ${iso(s)}..${iso(e)} rejected`,
        { err: String(data.errors[0]?.message || data.errors[0]).slice(0, 200) });
      continue;
    }
    const bd = data?.data?.getEarnerBreakdownsV2?.earnerEarningsBreakdowns || [];
    const rows = bd.map((d) => {
      const ti = Object.fromEntries((d.tripInfos || []).map((x) => [x.tripAttributeName, x.value]));
      return {
        platform: SRC, fleet_id: config.uber.fleet, driver_ext_id: d.earnerUuid,
        driver_name: d.earnerMetadata?.name, period_start: iso(s), period_end: iso(e),
        trips: parseInt(ti['TRIP_ATTRIBUTE_NAME_COUNT']) || null,
        distance_km: parseFloat(ti['TRIP_ATTRIBUTE_NAME_DISTRANCE']) || null,
        earnings: d.netOutstanding ? Number(d.netOutstanding.amountE5) / 1e5 : null,
        currency: d.netOutstanding?.currencyCode || 'AED', raw: d,
      };
    });
    if (rows.length) total += await upsertMany('driver_performance', rows, ['platform', 'driver_ext_id', 'period_start', 'period_end']);
  }
  return total;
}

// Live driver status snapshot (OAuth).
export async function pullLive() {
  const token = await uberOAuthToken();
  const { data } = await http(`https://api.uber.com/v1/vehicle-suppliers/drivers/actions?${qs({ org_id: config.uber.org })}`,
    { headers: { authorization: `Bearer ${token}` } });
  const rows = (data?.driverStatusOverviews || []).map((d) => ({
    source: SRC, fleet_id: config.uber.fleet, plate: normPlate(d.vehicleInfo?.licensePlate || 'UNKNOWN'),
    captured_at: d.statusEntries?.[0]?.timestamp || new Date().toISOString(),
    status: (d.statusEntries?.[0]?.status || '').replace('DRIVER_STATUS_', ''), raw: d,
  })).filter((r) => r.plate !== 'UNKNOWN');
  return rows.length ? upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']) : 0;
}

export async function collect({ from, to, mode }) {
  try {
    const trips = await pullTrips(from, to);
    const perf = await pullEarnerBreakdowns(from, to);
    await logRun({ source: SRC, fleet_id: config.uber.fleet, mode, window_start: from, window_end: to, status: 'ok', rows_written: trips + perf });
    log.info(SRC, 'done', { trips, perf });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: config.uber.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
