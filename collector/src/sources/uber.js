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
    status: r['Trip status'], product: r['Product type'],
    // Uber sends "CASH" and "cash" for the same thing; grouping split them.
    payment_type: r['Payment type'] ? String(r['Payment type']).trim().toLowerCase() : null,
    // Uber's own personal-vs-business split, and its own id for the car.
    service_type: r['Service type'] || null,
    vehicle_ext_id: r['Vehicle UUID'] || null,
    raw: r,
  })).filter((t) => t.external_id);
}

// Pull historical trips one month at a time. Sequential is necessary but not
// sufficient: a report abandoned mid-generation keeps its slot, so pacing and a
// realistic poll budget are what actually keep us under the three-report cap.
async function pullTrips(from, to) {
  let total = 0;
  const windows = [...dateChunks(from, to, config.uber.reportRangeDays)];
  // Newest first. A backfill that starts twelve months ago spends its first
  // hour on windows that are already collected, and if it dies partway — a
  // container restart, a session that expires mid-run — it dies before ever
  // reaching the recent months anyone is looking at. Ordering by recency means
  // the most valuable windows land first and a truncated run is still useful.
  windows.reverse();
  const chunks = [];
  let consecutiveFailures = 0;
  for (const [s, e] of windows) {
    const chunk = { from: iso(s), to: iso(e), rows: 0, error: null };
    try {
      const id = await generateReport(s, e);
      const url = await downloadReport(id);
      const { data: csv } = await http(url, { expect: 'text', timeoutMs: 180000 });
      const rows = csvToTrips(csv);
      if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
      chunk.rows = rows.length;
      log.info(SRC, `trips ${iso(s)}..${iso(e)}`, { rows: rows.length });
      consecutiveFailures = 0;
    } catch (err) {
      const msg = String(err);
      // "invalid date range" past retention (~12mo) is expected on the oldest
      // windows; anything else is a real failure and is recorded as one,
      // because a silent skip turns a broken backfill into a successful empty
      // one — which is exactly how a 299-day hole survived for months behind a
      // run that reported status='ok'.
      const expected = /invalid date range|retention|out of range/i.test(msg);
      chunk.error = expected ? `outside retention: ${msg.slice(0, 160)}` : msg.slice(0, 300);
      chunk.expected = expected;
      log[expected ? 'info' : 'error'](SRC, `trip chunk ${iso(s)}..${iso(e)} ${expected ? 'outside retention' : 'FAILED'}`,
        { err: msg.slice(0, 300) });
      if (!expected) consecutiveFailures++;
    }
    chunks.push(chunk);
    // Pause between chunks so the previous report's slot is released before the
    // next GenerateReport, rather than racing the three-in-flight cap.
    await sleep(consecutiveFailures ? 20000 : 4000);
  }
  const failed = chunks.filter((c) => c.error && !c.expected).length;
  if (failed) log.error(SRC, 'trip backfill left holes', { failed, of: chunks.length,
    windows: chunks.filter((c) => c.error && !c.expected).map((c) => `${c.from}..${c.to}`).join(', ') });
  return { total, chunks };
}

// Per-driver earnings + trip count + distance (7-day windows, GraphQL).
//
// The server caps this at ten drivers per call — "driver-uuids or page size
// cannot be more than 10" — so a pageSize of 200 was rejected outright and the
// fleet had no per-driver Uber earnings at all. Ten at a time, paged through.
const EARNER_PAGE = 10;

async function pullEarnerBreakdowns(from, to) {
  let total = 0;
  for (const [s, e] of dateChunks(from, to, 7)) {
    let pageToken = '', pages = 0;
    do {
      const body = JSON.stringify({
        operationName: 'getEarnerBreakdownsV2',
        variables: {
          supplierUuid: config.uber.orgUuid,
          timeRange: { unixMilliOrDate: 'Unix_Time_Range', startTimeUnixMillis: unixMs(s), endTimeUnixMillis: unixMs(e) },
          driverListOrPageOptions: 'Page_Options', pageOptions: { pageSize: EARNER_PAGE, pageToken },
          driverList: null, excludeAdjustmentItems: true,
        },
        query: `query getEarnerBreakdownsV2($supplierUuid: ID!, $timeRange: OneOfTimeRange__Input, $driverListOrPageOptions: DriverListOrPagination, $driverList: [ID!], $pageOptions: PaginationOption__Input, $excludeAdjustmentItems: Boolean) {
          getEarnerBreakdownsV2(supplierUuid: $supplierUuid, timeRange: $timeRange, driverList: $driverList, pageOptions: $pageOptions, driverListOrPageOptions: $driverListOrPageOptions, excludeAdjustmentItems: $excludeAdjustmentItems) {
            nextPageToken
            earnerEarningsBreakdowns { earnerUuid earnerMetadata { name } tripInfos { tripAttributeName value } netOutstanding { amountE5 currencyCode } }
          } }`,
      });
      const { data } = await http('https://supplier.uber.com/graphql', { method: 'POST', headers: uberWebHeaders(), body });
      // An expired web cookie answers with `errors` and no data, which is
      // indistinguishable from "this fleet had no drivers" unless we say so.
      if (data?.errors?.length) {
        log.warn(SRC, `earner breakdown ${iso(s)}..${iso(e)} rejected`,
          { err: String(data.errors[0]?.message || data.errors[0]).slice(0, 200) });
        break;
      }
      const page = data?.data?.getEarnerBreakdownsV2 || {};
      const bd = page.earnerEarningsBreakdowns || [];
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
      pageToken = page.nextPageToken || '';
      // A page cap the server does not honour would otherwise spin forever;
      // 40 pages is 400 drivers, comfortably past this fleet's size.
      if (++pages >= 40) { log.warn(SRC, `earner breakdown ${iso(s)}..${iso(e)} stopped at ${pages} pages`); break; }
    } while (pageToken);
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
    // `chunks` is what turns "ok, 1129 rows" into "partial — these nine windows
    // are still missing", and it is the difference between a hole that is
    // visible and one that is not.
    await logRun({ source: SRC, fleet_id: config.uber.fleet, mode,
      window_start: from, window_end: to, rows_written: trips.total + perf,
      chunks: trips.chunks });
    log.info(SRC, 'done', { trips: trips.total, perf,
      windows_failed: trips.chunks.filter((c) => c.error).length, of: trips.chunks.length });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: config.uber.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
