// Uber collector — one pass per configured org (Ecosine, Egari).
//  Historical trips  : report pipeline GenerateReport -> poll DownloadReport -> signed CSV.
//                      Server limits: <=31-day range, <=3 concurrent reports, async, ~12mo retention.
//  Driver perf       : GraphQL getPerformanceReport / getEarnerBreakdownsV2 (per driver).
//  Live status       : OAuth /drivers/actions (online/on-trip/offline).
import { parse } from 'csv-parse/sync';
import { config, normPlate } from '../config.js';
import { http, qs, sleep } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { dateChunks, weekChunks, iso, unixMs } from '../util.js';
import { uberOAuthToken, uberWebHeaders, PORTAL } from '../auth/uber.js';
import { stateRow } from '../roster.js';
import { log } from '../log.js';

const SRC = 'uber';

/* The org this run is collecting. collect() and pullLive() iterate the
   configured orgs sequentially and set this before each fleet's pass; the
   exported probes never set it and fall back to the first configured org (the
   legacy fields carry the same Ecosine values, so a database with only the old
   keys behaves exactly as before). Module state is safe here because the
   scheduler runs sources one at a time and every helper below awaits. */
let cur = null;
const org = () => cur || config.uber.orgs?.[0] || config.uber;
const REPORTS = `${PORTAL}/api/vs-sp-reports-management`;

// Uber caps an org at three reports in flight. Abandoning a report does not
// release its slot, so a run that gives up on three slow reports poisons every
// later chunk: GenerateReport then fails instantly and the whole backfill
// "succeeds" with zero rows. Wait the limit out rather than burning the run.
const CONCURRENCY_HINT = /concurrent|too many|limit|in progress|rate/i;

async function generateReport(start, end, attempt = 0) {
  const body = JSON.stringify({
    orgId: { uuid: { value: org().orgUuid } },
    reportType: 'REPORT_TYPE_TRIP_ACTIVITY',
    startDate: { value: iso(start) }, endDate: { value: iso(end) },
    childOrgUuids: [{ uuid: { value: org().orgUuid } }],
  });
  const { data } = await http(`${REPORTS}/GenerateReport?localeCode=en-GB`,
    { method: 'POST', headers: uberWebHeaders(org()), body });
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
      method: 'POST', headers: uberWebHeaders(org()),
      body: JSON.stringify({ orgId: { uuid: { value: org().orgUuid } }, reportId: { uuid: { value: reportId } } }),
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
    platform: SRC, external_id: r['Trip UUID'], fleet_id: org().fleet,
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
async function pullTrips(from, to, onStep) {
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
    /* A monthly Uber report takes minutes and a year is twelve of them, so a
       whole backfill can spend hours inside this one loop. Reporting only when
       the SOURCE finishes makes a working run indistinguishable from a wedged
       one for that whole time — and the boot requeue, which abandons a job that
       restarts three times without advancing, could not tell them apart either
       and marked a run that had just landed 35,000 rows as 'may be crashing the
       collector'. */
    await onStep?.({ window: `${iso(s)}..${iso(e)}`,
      index: chunks.length, of: windows.length, rows_so_far: total });
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

/* Every Uber driver this fleet has ever had, from the two places their ids
   land. The roster is written by pullLive on every incremental and covers
   people who have not driven yet; the trip table covers people who have driven
   but may since have left the roster. Neither alone is the fleet. */
async function uberDriverIds() {
  /* Scoped to the org being collected: asking Egari's supplier endpoint about
     Ecosine's drivers wastes a batch per ten of them, and the union of two
     fleets grows every driver either one hires. Rows from before the fleet
     split carry Ecosine's id already; a null fleet is included for safety —
     an extra id costs a little, a missing one costs that driver's earnings. */
  const { rows } = await pool.query(
    `SELECT DISTINCT driver_ext_id FROM (
       SELECT driver_ext_id FROM driver_platform_state
        WHERE platform = 'uber' AND (fleet_id = $1 OR fleet_id IS NULL)
       UNION SELECT driver_ext_id FROM trip
        WHERE platform = 'uber' AND (fleet_id = $1 OR fleet_id IS NULL)
     ) s WHERE coalesce(btrim(driver_ext_id), '') <> ''`, [org().fleet]);
  return rows.map((r) => r.driver_ext_id);
}

const EARNER_QUERY = `query getEarnerBreakdownsV2($supplierUuid: ID!, $timeRange: OneOfTimeRange__Input, $driverListOrPageOptions: DriverListOrPagination, $driverList: [ID!], $pageOptions: PaginationOption__Input, $excludeAdjustmentItems: Boolean) {
          getEarnerBreakdownsV2(supplierUuid: $supplierUuid, timeRange: $timeRange, driverList: $driverList, pageOptions: $pageOptions, driverListOrPageOptions: $driverListOrPageOptions, excludeAdjustmentItems: $excludeAdjustmentItems) {
            earnerEarningsBreakdowns { earnerUuid earnerMetadata { name } tripInfos { tripAttributeName value } netOutstanding { amountE5 currencyCode } }
          } }`;

/* The range is HALF-OPEN: [s, e). Uber takes two instants, not two days, so an
   `e` of "the last day I want" asks for that day's first millisecond and
   nothing else — six days of a seven-day week. Callers pass the instant the
   period ENDS. This cost one day in seven of every Uber earning on record. */
async function earnerCall(s, e, variables) {
  const body = JSON.stringify({
    operationName: 'getEarnerBreakdownsV2',
    variables: {
      supplierUuid: org().orgUuid,
      timeRange: {
        unixMilliOrDate: 'Unix_Time_Range',
        startTimeUnixMillis: unixMs(s), endTimeUnixMillis: unixMs(e),
      },
      excludeAdjustmentItems: true,
      ...variables,
    },
    query: EARNER_QUERY,
  });
  const { data } = await http(`${PORTAL}/graphql`,
    { method: 'POST', headers: uberWebHeaders(org()), body });
  // A cookie can fail two ways and only one of them was covered here. An
  // expired-but-recognised session answers with `errors` and no data. A
  // signed-OUT session never reaches GraphQL at all: the portal bounces to the
  // login page and returns HTML under a 200, which http() hands back as a
  // string. `data.errors` on a string is undefined, so the old check waved it
  // through and the fleet was recorded as having had no drivers that week.
  if (typeof data !== 'object' || data === null) {
    return { err: 'signed out — the portal answered with its login page, not GraphQL'
      + ' (re-paste the web cookie)', rows: [] };
  }
  if (data?.errors?.length) {
    return { err: String(data.errors[0]?.message || data.errors[0]).slice(0, 250), rows: [] };
  }
  return { err: null, rows: data?.data?.getEarnerBreakdownsV2?.earnerEarningsBreakdowns || [] };
}

/* One earner window, for the operator probe.
   ─────────────────────────────────────────────────────────────────────────
   Exported so api/probe.js can ask "does Uber still hold earnings for
   September 2025?" without a second copy of the GraphQL document living in the
   probe — the drift that would cause is the same one that has already produced
   five copies of a name fold in this codebase.

   The question is worth a route because the answer decides what to do about a
   half-year of missing money: the backfill asked for those windows, none
   failed, and all of them came back empty. Either the provider will not serve
   data that old — in which case it is gone and the product should say so —
   or we asked wrongly, and re-collecting recovers it.

   A sample of drivers, not the fleet: this is a diagnosis, not a collection,
   and ten drivers answering for a window is enough to prove it is served. */
export async function probeEarnerWindow(from, to, limit = 10) {
  const drivers = (await uberDriverIds()).slice(0, limit);
  if (!drivers.length) return { drivers: 0, rows: 0, err: 'no uber driver ids held' };
  const { err, rows } = await earnerCall(from, to, {
    driverListOrPageOptions: 'Driver_List', driverList: drivers,
  });
  /* Priced separately from the row count: a window can return a row per driver
     with nothing in it, which is a different fact from returning nothing. */
  const withMoney = rows.filter((r) => Number(r?.netOutstanding?.amountE5 || 0) !== 0).length;
  return { drivers: drivers.length, rows: rows.length, rows_with_money: withMoney, err };
}

/* Per-driver earnings, in seven-day windows, asked for BY NAME ten at a time
   rather than paged.
   ─────────────────────────────────────────────────────────────────────────
   The server caps a page at ten — "driver-uuids or page size cannot be more
   than 10" — and the response type carries no pagination token this query can
   select, so page mode returns the first ten drivers and stops. On a fleet of
   eighty-five that is an eighth of the money, reported as all of it: every
   weekly period in the database held exactly ten drivers, which is the shape a
   cap leaves and not one any real week has.

   Asking for an explicit driver list removes the question. We already hold
   every Uber driver id, so the batches ARE the fleet, and a driver missing from
   a window is then a fact about that driver rather than about where the page
   ran out.

   If the server rejects list mode, it falls back to the single page it managed
   before: a wrong guess about an enum should cost the improvement, not the
   data. */
const EARNER_BATCH = 10;

async function pullEarnerBreakdowns(from, to, onStep) {
  let total = 0;
  const chunks = [];
  const drivers = await uberDriverIds();
  /* Whole calendar weeks, not seven days counted from whenever this run began
     — see weekChunks. The window is the primary key of what gets stored, so a
     grid that moves with the run stores the same week twice. */
  const windows = [...weekChunks(from, to)];
  log.info(SRC, 'earner breakdown', { drivers: drivers.length, windows: windows.length });
  let listMode = drivers.length > 0;

  const write = async (bd, s, e) => {
    const rows = bd.map((d) => {
      const ti = Object.fromEntries((d.tripInfos || []).map((x) => [x.tripAttributeName, x.value]));
      return {
        platform: SRC, fleet_id: org().fleet, driver_ext_id: d.earnerUuid,
        driver_name: d.earnerMetadata?.name, period_start: iso(s), period_end: iso(e),
        trips: parseInt(ti['TRIP_ATTRIBUTE_NAME_COUNT']) || null,
        distance_km: parseFloat(ti['TRIP_ATTRIBUTE_NAME_DISTRANCE']) || null,
        earnings: d.netOutstanding ? Number(d.netOutstanding.amountE5) / 1e5 : null,
        currency: d.netOutstanding?.currencyCode || 'AED', raw: d,
      };
    }).filter((r) => r.driver_ext_id);
    if (!rows.length) return 0;
    return upsertMany('driver_performance', rows,
      ['platform', 'driver_ext_id', 'period_start', 'period_end']);
  };

  for (const { start: s, end: e, until } of windows) {
    let got = 0, err = null, seen = 0;

    if (listMode) {
      for (let i = 0; i < drivers.length; i += EARNER_BATCH) {
        const r = await earnerCall(s, until, {
          driverListOrPageOptions: 'Driver_List',
          driverList: drivers.slice(i, i + EARNER_BATCH), pageOptions: null,
        });
        if (r.err) {
          /* A rejected MODE and a bad moment are different failures, and
             treating them the same cost a year of history.

             listMode is declared outside the window loop, so setting it false
             here disabled driver-list mode for every remaining window — and the
             windows run oldest first. One timeout in the first week of the
             record therefore degraded all fifty-three weeks to a single page of
             ten drivers, and the run still reported every window successful,
             because a page of ten is not an error.

             The mode is only abandoned when the server says the mode is wrong.
             Anything else is retried on the next window, where it will either
             recur — and be recorded — or not. */
          const modeRejected = /driver.?list|driverListOrPageOptions|unknown enum|invalid.*mode/i
            .test(r.err);
          log.warn(SRC, modeRejected
            ? 'earner breakdown driver-list mode rejected, falling back to one page'
            : `earner breakdown ${iso(s)}..${iso(e)} batch failed, keeping driver-list mode`,
            { err: r.err });
          err = r.err;
          if (modeRejected) listMode = false;
          break;
        }
        seen += r.rows.length;
        got += await write(r.rows, s, e);
      }
    }

    if (!listMode) {
      const r = await earnerCall(s, until, {
        driverListOrPageOptions: 'Page_Options',
        pageOptions: { pageSize: EARNER_BATCH, pageToken: '' }, driverList: null,
      });
      if (r.err) {
        err = r.err;
        log.warn(SRC, `earner breakdown ${iso(s)}..${iso(e)} rejected`, { err });
      } else {
        seen += r.rows.length;
        got += await write(r.rows, s, e);
      }
    }

    /* Recorded per window, like the trip chunks beside it, and with the driver
       count: a window answering for ten of eighty-five drivers is not a quiet
       week, and only this number tells the two apart. A sub-source that fails
       silently is the shape that hid a 299-day hole in the trip feed; this one
       hid seven eighths of every Uber earning the fleet has made. */
    /* `total` is what collect() adds to rows_written and what onStep reports as
       progress. It was declared, never added to, and returned as 0 — so every
       run in the record says the earnings phase wrote nothing, including the
       ones that wrote 154 rows a week for twenty-eight weeks. */
    total += got;
    chunks.push({
      from: iso(s), to: iso(e), rows: got, error: err,
      detail: `${seen} of ${drivers.length} drivers answered`,
    });
    /* Reported per window, like the trip windows are. Fifty-three windows of
       sixteen batches is around eight hundred calls and a quarter of an hour,
       and it ran with the progress row frozen on the last TRIP window the whole
       time — so a watcher could not tell this phase from a wedged one. That is
       the exact condition onStep was added for. */
    onStep?.({ window: `${iso(s)}..${iso(e)}`, index: chunks.length - 1, of: windows.length,
      rows_so_far: total, phase: 'earnings' });
  }
  return { total, chunks };
}

// Live driver status snapshot (OAuth).
export async function pullLive() {
  /* One fleet's failure is that fleet's failure.
     ─────────────────────────────────────────────────────────────────────────
     The two fleets are separate Uber businesses with separate credentials, and
     the only thing they share is this process. Written as a bare loop, a
     rejection on the second org threw out of the whole pass — so an expired
     Egari credential would have taken Ecosine's live map down with it, and the
     log would have named Egari while the operator watched Ecosine go blank.
     They are collected one at a time and each one's outcome is its own: a
     fleet that fails is reported, and the next fleet still runs.

     Live status is a REST call keyed on the ENCRYPTED org id, which is not the
     uuid the reports and GraphQL surfaces use. An org without one is skipped
     rather than failed — it is a credential nobody has pasted yet, not a
     broken collector — and it says so once per run rather than throwing on
     every five-minute poll. */
  let total = 0;
  const failed = [];
  for (const o of uberOrgs()) {
    if (!o.org) { log.info(SRC, `live status skipped for ${o.fleet} — no encrypted org id`); continue; }
    try {
      total += await pullLiveOrg(o);
    } catch (e) {
      failed.push(o.fleet);
      log.error(SRC, `live status failed for ${o.fleet}`, { err: String(e).slice(0, 200) });
    }
  }
  /* Reported, not swallowed: the caller counts rows, and rows written by the
     fleets that DID answer must not read as "everything is fine". */
  if (failed.length) log.warn(SRC, 'live status incomplete', { failed: failed.join(', ') });
  return total;
}

/* The orgs to collect, in order, honouring a fleet filter.
   Every entry point takes the same filter, so a single fleet can be collected
   on its own — to re-pull one after a credential is replaced, without making
   the other fleet pay for a full pass it did not need. */
export function uberOrgs(fleet = null) {
  const all = config.uber.orgs?.length ? config.uber.orgs : [config.uber];
  return fleet ? all.filter((o) => o.fleet === fleet) : all;
}

async function pullLiveOrg(o) {
  const token = await uberOAuthToken();
  /* Paged. This asked once, with no limit and no cursor, and took whatever came
     back — which is the API's default page of 50. The fleet has 152 Uber
     drivers, so driver_platform_state held a third of the roster and every
     "on the books but not earning" figure in the product was computed over
     that third. A default page size is not a fleet size.

     The token parameter name is a guess (the probe records that the response
     carries paginationResult, not what to send back), so the loop is written to
     survive being wrong: if the server ignores the cursor it returns page one
     again, the ids are identical, and it stops and says so rather than looping
     for ever. */
  const overviews = [];
  let pageToken = '', pages = 0, lastKey = null;
  do {
    const { data } = await http(
      `https://api.uber.com/v1/vehicle-suppliers/drivers/actions?${qs({
        org_id: o.org, limit: 50, ...(pageToken ? { page_token: pageToken } : {}),
      })}`, { headers: { authorization: `Bearer ${token}` } });
    const page = data?.driverStatusOverviews || [];
    const key = page.map((d) => d.driverInfo?.driverUuid).join(',');
    if (key && key === lastKey) {
      log.warn(SRC, 'driver roster cursor ignored by the server — stopping at one page',
        { drivers: overviews.length });
      break;
    }
    lastKey = key;
    overviews.push(...page);
    pageToken = data?.paginationResult?.nextPageToken || data?.nextPageToken || '';
    if (!page.length) break;
  } while (pageToken && ++pages < 40);

  /* This response carries an `onboardingStatus` per driver — ACTIVE, WAITLIST,
     and two more — and it was being discarded, along with everyone it describes.
     The filter below keeps only drivers with a vehicle attached, which is
     exactly the filter that removes every driver still waiting to start: the
     supply pipeline was invisible because the one endpoint that reports it was
     read for its position data and thrown away. */
  const roster = overviews.map((d) => stateRow({
    platform: SRC, driverExtId: d.driverInfo?.driverUuid, fleetId: o.fleet,
    name: [d.driverInfo?.firstName, d.driverInfo?.lastName].filter(Boolean).join(' '),
    rawState: d.onboardingStatus,
    reason: d.suspensionReason || d.statusEntries?.[0]?.reason,
    plate: d.vehicleInfo?.licensePlate ? normPlate(d.vehicleInfo.licensePlate) : null,
    vehicleExtId: d.vehicleInfo?.vehicleUuid || null,
    raw: { onboardingStatus: d.onboardingStatus, vehicle: d.vehicleInfo?.licensePlate },
  })).filter((r) => r.driver_ext_id && r.driver_ext_id !== 'undefined');
  if (roster.length) {
    await upsertMany('driver_platform_state', roster, ['platform', 'driver_ext_id']);
    log.info(SRC, 'roster', { drivers: roster.length,
      cannot_earn: roster.filter((r) => r.can_earn === false).length });
  }

  const rows = overviews.map((d) => ({
    source: SRC, fleet_id: o.fleet, plate: normPlate(d.vehicleInfo?.licensePlate || 'UNKNOWN'),
    captured_at: d.statusEntries?.[0]?.timestamp || new Date().toISOString(),
    status: (d.statusEntries?.[0]?.status || '').replace('DRIVER_STATUS_', ''), raw: d,
  })).filter((r) => r.plate !== 'UNKNOWN');
  return rows.length ? upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']) : 0;
}

export async function collect({ from, to, mode, onStep, fleet = null }) {
  /* One full pass per configured org, sequentially, each under its own run
     row — so the Sources page shows uber/ecosine and uber/egari separately
     and a dead cookie on one fleet reads as that fleet's failure, not as half
     the numbers quietly missing from a shared one. Sequential on purpose:
     the report pipeline's three-in-flight cap is per org, but the two
     sessions share this process's connection pool and the API's patience. */
  for (const o of uberOrgs(fleet)) {
    cur = o;
    try {
      const trips = await pullTrips(from, to, onStep);
      const perf = await pullEarnerBreakdowns(from, to, onStep);
      // Both sub-sources' windows, so a run that fetched every trip and no
      // earnings reads as partial rather than as ok.
      const chunks = [...trips.chunks, ...perf.chunks];
      // `chunks` is what turns "ok, 1129 rows" into "partial — these nine windows
      // are still missing", and it is the difference between a hole that is
      // visible and one that is not.
      await logRun({ source: SRC, fleet_id: o.fleet, mode,
        window_start: from, window_end: to, rows_written: trips.total + perf.total,
        chunks });
      log.info(SRC, `done (${o.fleet})`, { trips: trips.total, perf,
        windows_failed: trips.chunks.filter((c) => c.error).length, of: trips.chunks.length });
    } catch (e) {
      await logRun({ source: SRC, fleet_id: o.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
      log.error(SRC, `failed (${o.fleet})`, { err: String(e) });
    } finally {
      cur = null;
    }
  }
}
