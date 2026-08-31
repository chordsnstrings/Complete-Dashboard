// Uber collector — one pass per configured org (Ecosine, Egari).
//  Historical trips  : report pipeline GenerateReport -> poll DownloadReport -> signed CSV.
//                      Server limits: <=31-day range, <=3 concurrent reports, async, ~12mo retention.
//  Driver perf       : GraphQL getPerformanceReport / getEarnerBreakdownsV2 (per driver).
//  Live status       : OAuth /drivers/actions (online/on-trip/offline).
import { parse } from 'csv-parse/sync';
import { config, normPlate } from '../config.js';
import { http, qs, sleep } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { dateChunks, weekChunks, dubaiDayChunks, iso, unixMs } from '../util.js';
import { uberOAuthToken, uberWebHeaders } from '../auth/uber.js';
import { stateRow } from '../roster.js';
import { log } from '../log.js';
import { authFailure, saysAuth, noteCredential, noteUberRest } from '../auth_state.js';

const SRC = 'uber';

/* The org this run is collecting. collect() and pullLive() iterate the
   configured orgs sequentially and set this before each fleet's pass; the
   exported probes never set it and fall back to the first configured org (the
   legacy fields carry the same Ecosine values, so a database with only the old
   keys behaves exactly as before). Module state is safe here because the
   scheduler runs sources one at a time and every helper below awaits. */
let cur = null;
const org = () => cur || config.uber.orgs?.[0] || config.uber;
const REPORTS = 'https://supplier.uber.com/api/vs-sp-reports-management';

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
async function pullTrips(from, to, onStep, checkpoint = null) {
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
    /* Already collected by this job, on an attempt the worker did not survive.
       A monthly Uber report costs minutes at the provider, so redoing six of
       them is the difference between a backfill that finishes across restarts
       and one that dies at the same place every time. */
    if (checkpoint?.has(`trips ${iso(s)}..${iso(e)}`)) {
      chunk.skipped = true;
      chunks.push(chunk);
      continue;
    }
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
    /* Marked after the rows are written and only when the window did not fail:
       a window recorded as done because it errored is a hole this job would
       then skip for ever. An expected refusal — a date past Uber's retention —
       IS done, because asking again can only be refused again. */
    if (!chunk.error || chunk.expected) {
      await checkpoint?.mark(`trips ${iso(s)}..${iso(e)}`, chunk.rows);
    }
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
            earnerEarningsBreakdowns { earnerUuid earnerMetadata { name } tripInfos { tripAttributeName value } netOutstanding { amountE5 currencyCode }
              earnings { localizedCategoryLabel categoryName amount { amountE5 currencyCode }
                children { localizedCategoryLabel categoryName amount { amountE5 currencyCode }
                  children { localizedCategoryLabel categoryName amount { amountE5 currencyCode } } } }
              payouts { localizedCategoryLabel categoryName amount { amountE5 currencyCode }
                children { localizedCategoryLabel categoryName amount { amountE5 currencyCode } } } }
            pageInfo { nextPageToken }
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
  const URL_ = 'https://supplier.uber.com/graphql';
  const res = await http(URL_, { method: 'POST', headers: uberWebHeaders(org()), body });
  const { data } = res;
  /* An expired web cookie says NOTHING. Measured live: with `sid` dropped this
     request follows a redirect to auth.uber.com and answers 404 "Not Found",
     so the JSON parse fails, `data.errors` is undefined, the row list is
     undefined, and this function used to return no error and no rows — the
     exact shape of a week in which nobody drove, recorded as a successful run.
     src/auth_state.js carries the whole measurement. */
  const bad = authFailure(URL_, res);
  if (bad) {
    await noteCredential(pool, { provider: SRC, fleet: org().fleet,
      credential: org().fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI',
      state: 'expired', detail: bad.reason, surface: 'supplier graphql' });
    return { err: `web session: ${bad.reason}`, rows: [], auth: true };
  }
  if (data?.errors?.length) {
    const msg = String(data.errors[0]?.message || data.errors[0]).slice(0, 250);
    if (saysAuth(msg)) {
      await noteCredential(pool, { provider: SRC, fleet: org().fleet,
        credential: org().fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI',
        state: 'expired', detail: msg, surface: 'supplier graphql' });
      return { err: `web session: ${msg}`, rows: [], auth: true };
    }
    return { err: msg, rows: [] };
  }
  /* A well-formed answer IS the proof the credential works, so it is recorded
     on every call rather than inferred from the absence of a failure. */
  await noteCredential(pool, { provider: SRC, fleet: org().fleet,
    credential: org().fleet === 'ecosine' ? 'UBER_WEB_COOKIE' : 'UBER_WEB_COOKIE_EGARI',
    state: 'ok', detail: null, surface: 'supplier graphql' });
  const g = data?.data?.getEarnerBreakdownsV2;
  return { err: null, rows: g?.earnerEarningsBreakdowns || [], next: g?.pageInfo?.nextPageToken || '' };
}

/* Page mode, all the way to the end of the list.
   ─────────────────────────────────────────────────────────────────────────
   The comment on EARNER_BATCH says page mode "returns the first ten drivers
   and stops" because "the response type carries no pagination token this query
   can select". The first half was true and the second was not: the query can
   select `pageInfo { nextPageToken }`, and it pages. Checked against the live
   endpoint — Egari answers a day in three pages and Ecosine in five or six,
   and the drivers that come back match the ones the driver-list mode finds for
   the same span.

   That matters for cost, which is what decides whether a grid can be daily at
   all. Driver-list mode asks in batches of ten NAMES, so it costs
   ceil(207/10) = 21 calls for a window whatever happened in it. Page mode
   costs one call per ten drivers who actually EARNED — five or six on a real
   day. Over a 200-day backfill that is the difference between about 4,200
   calls per fleet and about 1,200. */
async function earnerPages(s, e, cap = 40) {
  const rows = [];
  let token = '', pages = 0;
  for (;;) {
    const r = await earnerCall(s, e, {
      driverListOrPageOptions: 'Page_Options',
      pageOptions: { pageSize: EARNER_BATCH, pageToken: token }, driverList: null,
    });
    if (r.err) return { err: r.err, rows };
    rows.push(...r.rows);
    token = r.next;
    if (!token || ++pages >= cap) break;
  }
  return { err: null, rows };
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
/* How far back to ask day by day. The endpoint's own horizon measured 192 days
   on 2026-08-26 and it rolls forward daily, so this sits a little past it:
   overshooting costs a few empty calls, undershooting loses days that can
   never be re-fetched. */
const EARNER_DAY_HORIZON = 200;

async function pullEarnerBreakdowns(from, to, onStep, checkpoint = null) {
  let total = 0;
  const chunks = [];
  const drivers = await uberDriverIds();
  /* Whole calendar weeks, not seven days counted from whenever this run began
     — see weekChunks. The window is the primary key of what gets stored, so a
     grid that moves with the run stores the same week twice. */
  const weekly = [...weekChunks(from, to)].map((w) => ({ ...w, ps: iso(w.start), pe: iso(w.end) }));

  /* And the same question asked one Dubai day at a time, for as far back as
     Uber will answer it.
     ─────────────────────────────────────────────────────────────────────────
     A week stored as one row is spread across its seven days by
     driver_payout_day_live, so #reconcile showed the same figure on three
     consecutive days. Measured against the live endpoint, seven daily calls
     and one weekly call over the identical span agree to the cent on trips and
     on netOutstanding — 842 trips and AED 30,280.53 for Egari, 1,862 and AED
     71,006.78 for Ecosine — so the day is a real measurement here and not a
     finer-looking guess. The view already prefers the finest window it holds,
     so these supersede the week covering them and nothing else has to change.

     Bounded, because the endpoint serves a ROLLING window: measured at 192
     days — Feb 15 answered in full and Feb 14 returned nothing — and it moves
     every day. Asking past the edge costs calls and returns empty, so the
     grid stops a little beyond it rather than walking the whole year. */
  const dayHorizon = new Date(Date.now() - EARNER_DAY_HORIZON * 864e5);
  const dayFrom = new Date(Math.max(new Date(from).getTime(), dayHorizon.getTime()));
  const daily = dayFrom > new Date(to) ? []
    : [...dubaiDayChunks(dayFrom, to)].map((d) => ({ start: d.start, end: d.start, until: d.until,
      ps: d.day, pe: d.day, daily: true }));

  const windows = [...weekly, ...daily];
  log.info(SRC, 'earner breakdown', { drivers: drivers.length,
    weeks: weekly.length, days: daily.length });
  let listMode = drivers.length > 0;
  let done = 0;
  let comps = 0;

  /* `ps`/`pe` are the ISO dates to STAMP, which for the daily grid are not
     iso(start): a Dubai day begins at 20:00Z the day before. */
  const write = async (bd, ps, pe) => {
    const rows = bd.map((d) => {
      const ti = Object.fromEntries((d.tripInfos || []).map((x) => [x.tripAttributeName, x.value]));
      return {
        platform: SRC, fleet_id: org().fleet, driver_ext_id: d.earnerUuid,
        driver_name: d.earnerMetadata?.name, period_start: ps, period_end: pe,
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

  /* The earnings tree, from the surface that actually serves both fleets.
     ─────────────────────────────────────────────────────────────────────────
     driver_earnings_component is where tips live, and where #reconcile's
     "expected payout" is built from. It was filled only by uber_fleet.js,
     which reads a REST surface on api.uber.com — and that surface answers for
     Ecosine and returns nothing at all for Egari: on production, after a full
     backfill, "earner payments returned no earners in any of 53 week(s)".
     Un-hardcoding the fleet there was necessary and not sufficient; the fleet
     ran and the provider had nothing to give it.

     This GraphQL surface does serve it, for both orgs, with the same session
     the rest of this file already uses — checked live before writing this, and
     the components reconcile: fare minus service fee minus taxes plus tip
     equals your_earnings to the cent on both fleets.

     WEEKLY only. Sliced into days the components lose 2-3% of fare and 9-16%
     of tips, because Uber attributes an item to the period it settles in —
     measured on both fleets. Trips and net outstanding are exactly additive
     and are what the daily grid collects; these are not, and are collected on
     the grid they are true on.

     INCOMPLETE, and deliberately left so. This surface returns exactly two
     trees, and each equals its own children to the fils — but their sum is
     BELOW netOutstanding. Ecosine, week of 6 July, measured live: 52,793.48
     outstanding against 49,185.37 itemised. There is no third field to ask
     for; fifteen plausible names were probed and the server rejected every
     one, and introspection is disabled. The week of 17 August identifies the
     residual: 4,553.91 here, against 1,295.96 of reimbursements and expenses
     reported by the OAuth REST feed over 29% of the same drivers — about
     4,434 scaled. So the missing money is the reimbursement bucket, Salik
     above all.

     The residual is exactly computable, and is NOT written. Doing so would
     make #reconcile's expected payout a rearrangement of netOutstanding,
     which is what its bank side already is — the check would then prove
     nothing. api/reconcile_routes.js states the resulting floor under the
     gap instead. */
  const writeComponents = async (bd, ps, pe) => {
    const out = [];
    const seen = new Set();
    for (const d of bd) {
      if (!d.earnerUuid) continue;
      const walk = (node, parent, depth = 0) => {
        if (!node || depth > 6) return;
        for (const c of (Array.isArray(node) ? node : [node])) {
          if (!c) continue;
          const category = c.categoryName;
          const e5 = c.amount?.amountE5;
          if (category && e5 != null) {
            const k = `${d.earnerUuid}|${category}`;
            if (!seen.has(k)) {
              seen.add(k);
              out.push({
                platform: SRC, driver_ext_id: d.earnerUuid, driver_name: d.earnerMetadata?.name,
                period_start: ps, period_end: pe, category, parent: parent || null,
                amount: Number(e5) / 1e5, currency: c.amount?.currencyCode || 'AED',
                fleet_id: org().fleet,
              });
            }
          }
          if (c.children?.length) walk(c.children, category || parent, depth + 1);
        }
      };
      walk(d.earnings, null);
      walk(d.payouts, null);
    }
    if (!out.length) return 0;
    return upsertMany('driver_earnings_component', out,
      ['platform', 'driver_ext_id', 'period_start', 'period_end', 'category']);
  };

  for (const { start: s, end: e, until, ps, pe, daily: isDay } of windows) {
    /* Already collected by this job. The earnings grid is fifty-three weekly
       windows plus two hundred daily ones — around eight hundred provider
       calls — so redoing it after every restart is most of why a backfill
       never reached the sources behind it. */
    const unit = `earnings ${isDay ? ps : `${ps}..${pe}`}`;
    if (checkpoint?.has(unit)) { done += 1; continue; }
    let got = 0, err = null, seen = 0;

    /* A day is asked for in page mode, a week in driver-list mode.
       ─────────────────────────────────────────────────────────────────────
       Driver-list mode is the right shape for a week: it names every driver,
       so a driver absent from the answer is a fact about that driver rather
       than about where a page ran out. It costs the same 21 calls whether the
       fleet worked or not, which a 200-day grid cannot afford. Page mode now
       pages properly and costs one call per ten drivers who actually earned —
       and on a single day "who earned" is the whole question, so nothing is
       being traded away. */
    if (isDay) {
      const r = await earnerPages(s, until);
      if (r.err) {
        err = r.err;
        log.warn(SRC, `earner breakdown ${ps} rejected`, { err });
      } else {
        seen += r.rows.length;
        got += await write(r.rows, ps, pe);
      }
    } else if (listMode) {
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
            : `earner breakdown ${ps}..${pe} batch failed, keeping driver-list mode`,
            { err: r.err });
          err = r.err;
          if (modeRejected) listMode = false;
          break;
        }
        seen += r.rows.length;
        got += await write(r.rows, ps, pe);
        comps += await writeComponents(r.rows, ps, pe);
      }
    }

    if (!isDay && !listMode) {
      // Paginated too: the fallback used to take one page of ten and stop,
      // which is the cap the driver-list mode was built to work around.
      const r = await earnerPages(s, until);
      if (r.err) {
        err = r.err;
        log.warn(SRC, `earner breakdown ${ps}..${pe} rejected`, { err });
      } else {
        seen += r.rows.length;
        got += await write(r.rows, ps, pe);
        comps += await writeComponents(r.rows, ps, pe);
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
    /* Every weekly window is recorded; a daily one only when it FAILED. The
       Sources page renders these, and two hundred green day rows per fleet
       would bury the handful of week rows an operator reads it for — while a
       day that failed is exactly what they need to see. */
    if (!isDay || err) {
      chunks.push({
        from: ps, to: pe, rows: got, error: err,
        detail: `${seen} of ${drivers.length} drivers answered`,
      });
    }
    /* Reported per window, like the trip windows are. Fifty-three windows of
       sixteen batches is around eight hundred calls and a quarter of an hour,
       and it ran with the progress row frozen on the last TRIP window the whole
       time — so a watcher could not tell this phase from a wedged one. That is
       the exact condition onStep was added for. */
    done += 1;
    /* Marked only where the window answered. A window that errored is a hole,
       and recording it as finished would make every later attempt skip the one
       thing that needs retrying. */
    if (!err) await checkpoint?.mark(unit, got);
    onStep?.({ window: isDay ? ps : `${ps}..${pe}`, index: done - 1, of: windows.length,
      rows_so_far: total, phase: 'earnings' });
  }
  /* Components counted separately in the log and added to the total, because
     "the earnings phase wrote nothing" was true of this collector for its
     whole life and only a number in the run row would have said so. */
  log.info(SRC, 'earner components', { fleet: org().fleet, rows: comps });
  return { total: total + comps, chunks };
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
  const token = await uberOAuthToken(o);
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
    const url = `https://api.uber.com/v1/vehicle-suppliers/drivers/actions?${qs({
      org_id: o.org, limit: 50, ...(pageToken ? { page_token: pageToken } : {}),
    })}`;
    const res = await http(url, { headers: { authorization: `Bearer ${token}` } });
    /* A 403 here is a credential, not a quiet fleet. Production logged one of
       these twice a minute — "bad key" against one of the two orgs — while
       every page reported the source healthy, because the OAuth token grant
       that precedes it succeeds. See src/auth_state.js. */
    const bad = await noteUberRest(pool, url, res, o, 'drivers/actions', token);
    if (bad) throw new Error(`driver roster for ${o.fleet}: ${bad.reason}`);
    const { data } = res;
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

export async function collect({ from, to, mode, onStep, fleet = null, checkpoint = null }) {
  /* One full pass per configured org, sequentially, each under its own run
     row — so the Sources page shows uber/ecosine and uber/egari separately
     and a dead cookie on one fleet reads as that fleet's failure, not as half
     the numbers quietly missing from a shared one. Sequential on purpose:
     the report pipeline's three-in-flight cap is per org, but the two
     sessions share this process's connection pool and the API's patience. */
  for (const o of uberOrgs(fleet)) {
    cur = o;
    try {
      /* The checkpoint is per ORG as well as per window: the two fleets walk
         the same calendar, so a bare window name would let Egari's run be
         skipped because Ecosine had already done that month. */
      const ck = checkpoint && {
        has: (u) => checkpoint.has(`${o.fleet}:${u}`),
        mark: (u, n) => checkpoint.mark(`${o.fleet}:${u}`, n),
      };
      const trips = await pullTrips(from, to, onStep, ck);
      const perf = await pullEarnerBreakdowns(from, to, onStep, ck);
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
