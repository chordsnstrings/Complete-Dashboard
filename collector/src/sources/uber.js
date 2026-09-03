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
import { uberOAuthToken, uberWebHeaders, UBER_WEB_HOST,
  UBER_EARNER_HORIZON_DAYS, UBER_EARNER_ASK_MARGIN_DAYS } from '../auth/uber.js';
import { stateRow } from '../roster.js';
import { log } from '../log.js';
import { authFailure, saysAuth, noteCredential, noteUberRest, credentialState } from '../auth_state.js';

const SRC = 'uber';

/* The org this run is collecting. collect() and pullLive() iterate the
   configured orgs sequentially and set this before each fleet's pass; the
   exported probes never set it and fall back to the first configured org (the
   legacy fields carry the same Ecosine values, so a database with only the old
   keys behaves exactly as before). Module state is safe here because the
   scheduler runs sources one at a time and every helper below awaits. */
let cur = null;
const org = () => cur || config.uber.orgs?.[0] || config.uber;
const REPORTS = `${UBER_WEB_HOST}/api/vs-sp-reports-management`;

// Uber caps an org at three reports in flight. Abandoning a report does not
// release its slot, so a run that gives up on three slow reports poisons every
// later chunk: GenerateReport then fails instantly and the whole backfill
// "succeeds" with zero rows. Wait the limit out rather than burning the run.
const CONCURRENCY_HINT = /concurrent|too many|limit|in progress|rate/i;

/* Was that an answer, or a door?
   ─────────────────────────────────────────────────────────────────────────
   earnerCall below has classified its responses since 2026-08-26: a request
   that comes back from a host it was not sent to did not return no data, it
   was never asked. The REPORT pipeline never learned. It reads
   `data.status === 'success'` and calls everything else a report the provider
   declined to generate.

   Measured, not supposed. Production uber/catchup, both fleets, run finished
   2026-09-01T21:05:47Z: 44 of 44 windows failed, 0 rows written, and the 44
   split two ways — 37 earner windows said "redirected to auth.uber.com — the
   session is no longer signed in", and the 7 that go through here (the trip
   window 2026-08-02..2026-09-01 and all six DRIVER_QUALITY weeks) said, in
   full,

       generate: "Not Found"

   which names no surface, no session and no host. One event described twice:
   supplier.uber.com had begun answering 301, a POST does not survive a 301, it
   degrades to a GET and lands on the login page, and `"Not Found"` is
   JSON.stringify of that page's body. A reader could only reach that from the
   OTHER windows' wording. src/auth/uber.js carries the host measurement.

   Both ends of the hop are in the message, and the one that matters is the URL
   the request was SENT to. A bounce that lands on a login host reads as an
   expired session whether the session is dead or the endpoint has moved, and
   that reading is exactly what sent this product to re-capture cookies that
   were never the problem. "asked supplier.uber.com" is the half that
   distinguishes them, and it was the half nobody had.

   Consulted only when the envelope the caller expects is absent, so a report
   that generated is never second-guessed about where its 200 came from —
   this classifies failures, it does not add a new way to fail. */
function reportBounce(url, res) {
  /* Whatever the status code: if Uber answered in the shape it promised, then
     Uber answered, and its own words beat any reading of them. The reports API
     puts them at data.meta.details — "endDate is too late", "invalid date
     range", "permission-denied" — none of which authFailure's generic
     providerWords() knows how to find, so classifying a refusal that arrived
     as a 403 would replace the one useful sentence with "the credential was
     refused". A door has no envelope at all. */
  if (res?.data?.data?.meta?.details != null || res?.data?.status != null) return null;
  const bad = authFailure(url, res);
  if (!bad) return null;
  const bare = (u) => String(u || '').split('?')[0];
  return `${bad.reason} — asked ${bare(url)}, answered by ${bare(res?.finalUrl) || 'elsewhere'}`;
}

async function generateReport(start, end, attempt = 0, reportType = 'REPORT_TYPE_TRIP_ACTIVITY') {
  const body = JSON.stringify({
    orgId: { uuid: { value: org().orgUuid } },
    reportType,
    startDate: { value: iso(start) }, endDate: { value: iso(end) },
    childOrgUuids: [{ uuid: { value: org().orgUuid } }],
  });
  const url = `${REPORTS}/GenerateReport?localeCode=en-GB`;
  const res = await http(url, { method: 'POST', headers: uberWebHeaders(org()), body });
  const { data } = res;
  if (data.status !== 'success') {
    /* Before the concurrency retry, because a login page is not a busy slot:
       waiting 60, 120, 180 and 240 seconds for one would cost ten minutes a
       window and then report the wrong reason anyway. */
    const bounced = reportBounce(url, res);
    if (bounced) throw new Error(`generate: ${bounced}`);
    const detail = JSON.stringify(data?.data?.meta?.details || data);
    if (CONCURRENCY_HINT.test(detail) && attempt < 4) {
      const wait = 60000 * (attempt + 1);
      log.warn(SRC, `report slot busy, waiting ${wait / 1000}s`, { attempt: attempt + 1 });
      await sleep(wait);
      return generateReport(start, end, attempt + 1, reportType);
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
    const poll = `${REPORTS}/DownloadReport?localeCode=en-GB`;
    const res = await http(poll, {
      method: 'POST', headers: uberWebHeaders(org()),
      body: JSON.stringify({ orgId: { uuid: { value: org().orgUuid } }, reportId: { uuid: { value: reportId } } }),
    });
    const { data } = res;
    const url = data?.data?.signedUrl?.value;
    if (url) return url;
    /* A login page carries no signedUrl and no status, which is precisely the
       shape of a report still generating — so this loop used to poll a closed
       door for the whole 600s budget and then blame the provider for being
       slow. Asked once, answered from somewhere else: stop. */
    const bounced = reportBounce(poll, res);
    if (bounced) throw new Error(`download: ${bounced}`);
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

/* Quality, from the report nobody had asked for.
   ─────────────────────────────────────────────────────────────────────────
   driver_performance.acceptance_rate, cancellation_rate and completion_rate
   have existed since the first schema and no collector has ever written one.
   That is the whole reason the ACCEPTANCE tile on a driver's Quality tab is an
   em-dash: not a missing column, a report never requested.

   Two report types carry a Driver UUID, and only those are usable — the third,
   REPORT_TYPE_DRIVER_PERFORMANCE, was probed the same day and identifies
   drivers by name, email and phone with no uuid at all. Joining it would mean
   folding names, which already merges seventeen of this fleet's hundred and
   nineteen "drivers" into people who are the same person twice. It also
   carries Hours on Job and Earnings/hr that nothing else has; when that is
   worth the ambiguity it is a separate decision, taken openly.

     REPORT_TYPE_DRIVER_QUALITY   uuid, confirmation / cancellation /
                                  completion rates, ratings over four weeks and
                                  over five hundred trips, and the disposition
                                  of every dispatch
     REPORT_TYPE_DRIVER_ACTIVITY  uuid, trips completed, time online, time on
                                  trip — the platform's OWN hours, which for
                                  Uber nothing has ever collected

   Merged on the uuid into one row per driver per week, because they are two
   views of the same driver-week and two rows would make every average in the
   product double-count. */
const QUALITY_REPORTS = ['REPORT_TYPE_DRIVER_QUALITY', 'REPORT_TYPE_DRIVER_ACTIVITY'];

/* "0.87", "87%", "87 %" and "" all arrive in these columns depending on the
   locale the report was generated under. A rate stored sometimes as a fraction
   and sometimes as a percentage is worse than no rate, because every average
   over the mixture is wrong and nothing looks broken. */
export function rate(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const n = parseFloat(s.replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return /%/.test(s) || n > 1.5 ? n / 100 : n;
}
export const num = (v) => {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
/* "1 : 06 : 30" — days, hours, minutes, and the report spaces it differently
   in the two headers that carry it. */
export function spanHours(v) {
  if (!v) return null;
  const p = String(v).split(':').map((x) => parseInt(x.trim(), 10));
  if (p.some((x) => !Number.isFinite(x))) return null;
  const [d, h, m] = p.length === 3 ? p : [0, p[0], p[1]];
  return d * 24 + h + m / 60;
}

/* One driver-week, from whichever of the two reports is speaking. */
export function qualityRow(r, ps, pe) {
  const g = (...names) => { for (const n of names) if (r[n] != null && r[n] !== '') return r[n]; return null; };
  const uuid = g('Driver UUID');
  if (!uuid) return null;
  const online = spanHours(g('Time online (days : hours: minutes)', 'Time online (days : hours : minutes)'));
  const onTrip = spanHours(g('Time on trip (days : hours : minutes)', 'Time on trip (days : hours: minutes)'));
  return {
    platform: SRC, fleet_id: org().fleet, driver_ext_id: uuid,
    driver_name: [g('Driver first name'), g('Driver surname')].filter(Boolean).join(' ') || null,
    period_start: ps, period_end: pe,
    trips: num(g('Trips completed')),
    hours_online: online, hours_on_trip: onTrip,
    /* Confirmation rate is the PERIOD measure of accepting dispatched work,
       which is what a dated row should carry. The driver-app figures below are
       rolling and current; writing one of those here would state something
       true about today as though it were true about the week. */
    acceptance_rate: rate(g('Confirmation rate')),
    confirmation_rate: rate(g('Confirmation rate')),
    cancellation_rate: rate(g('Cancellation rate')),
    completion_rate: rate(g('Completion rate')),
    acceptance_rate_app: rate(g("Driver's current acceptance rate as seen in driver app")),
    cancellation_rate_app: rate(g("Driver's current cancellation rate as seen in driver app")),
    rating: num(g('Driver ratings (last 4 weeks)')),
    rating_500: num(g('Driver ratings (previous 500 trips)')),
    trips_accepted: num(g('Trips accepted (excluding Trip Radar or similar)', 'Trips accepted')),
    trips_rejected: num(g('Trips rejected')),
    trips_cancelled: num(g('Trips cancelled')),
    trips_cancelled_driver: num(g('Trips cancelled – Driver at fault', 'Trips cancelled - Driver at fault')),
    trips_failed: num(g('Trips failed')),
    trip_assignments: num(g('Total trips assignments')),
    source_report: 'uber-report', raw: r,
  };
}

/* Two reports become one row per driver, with the later one only FILLING what
   the earlier left null. Overwriting would let DRIVER_ACTIVITY's trip count
   silently replace DRIVER_QUALITY's, and the two count slightly different
   things. */
export function mergeQuality(into, row) {
  const at = into.get(row.driver_ext_id);
  if (!at) { into.set(row.driver_ext_id, row); return; }
  for (const [k, v] of Object.entries(row)) {
    if (v != null && (at[k] == null || at[k] === '')) at[k] = v;
  }
}

/* How far back a quality pass will walk, in whole weeks.
   ─────────────────────────────────────────────────────────────────────────
   Each week costs TWO Uber reports per fleet, and a report takes minutes at
   the provider against a cap of three in flight per org. A year would be 208
   reports and the better part of a day, spent mostly re-fetching weeks that
   have not changed since the last pass — while the trip and earnings pulls
   queue behind it for the same three slots.

   Twenty-six weeks is half a year: long enough that a rating over four weeks
   has somewhere to trend against, short enough that a backfill still finishes,
   and it sits inside the ~192-day earnings horizon so a quality week almost
   always has money beside it. */
const QUALITY_WEEK_HORIZON = 26;

async function pullDriverQuality(from, to, onStep, checkpoint = null) {
  let total = 0;
  const chunks = [];
  /* Whole provider weeks. The report aggregates over whatever window it is
     given, so the window IS the grain, and driver_performance is keyed on
     (period_start, period_end) — an arbitrary seven days from whenever a run
     began would key a second row against the same week's work. */
  const weeks = [...weekChunks(from, to)].reverse().slice(0, QUALITY_WEEK_HORIZON);
  for (const w of weeks) {
    const ps = iso(w.start), pe = iso(w.end);
    const chunk = { from: ps, to: pe, rows: 0, error: null };
    if (checkpoint?.has(`quality ${ps}..${pe}`)) {
      chunk.skipped = true; chunks.push(chunk); continue;
    }
    await onStep?.({ window: `quality ${ps}..${pe}`, index: chunks.length, of: weeks.length, rows_so_far: total });
    const merged = new Map();
    try {
      for (const type of QUALITY_REPORTS) {
        const id = await generateReport(w.start, w.end, 0, type);
        const url = await downloadReport(id);
        const { data: csv } = await http(url, { expect: 'text', timeoutMs: 180000 });
        for (const r of parse(csv, { columns: true, skip_empty_lines: true, bom: true })) {
          const row = qualityRow(r, ps, pe);
          if (row) mergeQuality(merged, row);
        }
        await sleep(4000);
      }
      const rows = [...merged.values()];
      if (rows.length) {
        total += await upsertMany('driver_performance', rows,
          ['platform', 'driver_ext_id', 'period_start', 'period_end']);
      }
      chunk.rows = rows.length;
      log.info(SRC, `quality ${ps}..${pe}`, { drivers: rows.length,
        rated: rows.filter((r) => r.rating != null).length,
        with_acceptance: rows.filter((r) => r.acceptance_rate != null).length });
    } catch (err) {
      /* WHAT THE FIRST REPORT PARSED IS NOT THE SECOND REPORT'S TO LOSE.
         ─────────────────────────────────────────────────────────────────────
         Both report types were inside one try and the write was after the
         loop, so a bounce or a 600-second timeout on the SECOND report threw
         away everything the first had already downloaded and parsed — a full
         week of ratings discarded because the acceptance report was slow. The
         two reports merge into one row per driver, so a half-filled row is a
         real answer with columns missing, not a wrong one; and the chunk error
         beside it says which report did not arrive. */
      if (merged.size) {
        const partial = [...merged.values()];
        try {
          total += await upsertMany('driver_performance', partial,
            ['platform', 'driver_ext_id', 'period_start', 'period_end']);
          chunk.rows = partial.length;
          chunk.partial = true;
          log.warn(SRC, `quality ${ps}..${pe} kept what the first report gave`,
            { drivers: partial.length });
        } catch (e2) {
          log.error(SRC, `quality ${ps}..${pe} could not keep its partial rows`,
            { err: String(e2).slice(0, 200) });
        }
      }
      const msg = String(err?.message || err);
      const expected = /invalid date range|retention|out of range/i.test(msg);
      chunk.error = expected ? `outside retention: ${msg.slice(0, 160)}` : msg.slice(0, 300);
      chunk.expected = expected;
      log[expected ? 'info' : 'error'](SRC, `quality ${ps}..${pe} ${expected ? 'outside retention' : 'FAILED'}`,
        { err: msg.slice(0, 240) });
    }
    chunks.push(chunk);
    if (!chunk.error || chunk.expected) await checkpoint?.mark(`quality ${ps}..${pe}`, chunk.rows);
    await sleep(4000);
  }
  return { total, chunks };
}

/* The arithmetic of "do these two sets of trips agree", with no I/O in it.
   ─────────────────────────────────────────────────────────────────────────
   Separated from the call that fetches them so it can be tested against
   handmade sets, because the two ways this comparison goes wrong are both
   silent. A day computed in UTC on one side and in Dubai on the other reports
   four hours of every day as missing and four as invented, and it reports it
   with the confidence of a count. And a trip we date one side of a midnight
   that Uber dates the other is a boundary disagreement, not a row we made up
   — counted as an extra, it puts a false accusation in every audit that spans
   a month end. */
export function compareTripSets({ theirs, ourRows, lo, hi, sample = 10 }) {
  /* Uber's CSV timestamps are Dubai wall-clock already — csvToTrips appends
     +04:00 rather than converting — so the calendar day is the first ten
     characters, and it is the same day the SQL above computes with
     AT TIME ZONE 'Asia/Dubai'. */
  const dayOf = (t) => (t.requested_at ? String(t.requested_at).slice(0, 10) : null);
  const theirAll = new Set(theirs.map((t) => t.external_id));
  const inWindow = theirs.filter((t) => { const d = dayOf(t); return d && d >= lo && d <= hi; });
  const theirIds = new Set(inWindow.map((t) => t.external_id));
  const ourIds = new Set(ourRows.map((r) => r.external_id));

  const missing = [...theirIds].filter((x) => !ourIds.has(x));
  const extra = [...ourIds].filter((x) => !theirAll.has(x));

  const byDay = new Map();
  const bump = (d, k) => {
    if (!d) return;
    const e = byDay.get(d) || { day: d, uber: 0, ours: 0, missing: 0 };
    e[k]++; byDay.set(d, e);
  };
  const dayById = new Map(inWindow.map((t) => [t.external_id, dayOf(t)]));
  for (const t of inWindow) bump(dayOf(t), 'uber');
  for (const r of ourRows) bump(r.day, 'ours');
  for (const x of missing) bump(dayById.get(x), 'missing');

  return {
    uber_rows: theirs.length,
    uber_rows_in_window: inWindow.length,
    /* A report returning rows dated outside the window it was asked for is
       telling us the window means something other than we assumed —
       completion date rather than request date, most likely — and that is
       worth seeing rather than silently filtering away. */
    uber_rows_outside_window: theirs.length - inWindow.length,
    ours: ourRows.length,
    in_both: theirIds.size - missing.length,
    uber_only: missing.length,
    ours_only: extra.length,
    agreement_pct: theirIds.size
      ? Math.round(((theirIds.size - missing.length) / theirIds.size) * 1000) / 10 : null,
    sample_missing: missing.slice(0, sample),
    days: [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)),
    /* The whole list, for the caller to check before believing it. Never
       stored and never returned to a page — see auditTripWindow, which uses it
       to separate a trip we do not have from a trip we have under the other
       fleet's name, and then drops it. */
    missing_ids: missing,
    day_of_missing: Object.fromEntries(missing.map((x) => [x, dayById.get(x)])),
  };
}

/* Move the trips we DO hold, under another fleet's name, out of the loss
   column — headline, per-day breakdown and sample alike, because a window
   whose total is right and whose days point somewhere else is a finding
   nobody can act on. Returns how many moved. */
export function applyMisfiled(cmp, heldElsewhere) {
  if (!heldElsewhere.size) return 0;
  const moved = cmp.missing_ids.filter((x) => heldElsewhere.has(x));
  if (!moved.length) return 0;
  cmp.uber_only -= moved.length;
  cmp.in_both += moved.length;
  cmp.agreement_pct = cmp.uber_rows_in_window
    ? Math.round(((cmp.uber_rows_in_window - cmp.uber_only) / cmp.uber_rows_in_window) * 1000) / 10
    : null;
  cmp.missing_ids = cmp.missing_ids.filter((x) => !heldElsewhere.has(x));
  cmp.sample_missing = cmp.missing_ids.slice(0, cmp.sample_missing.length || 10);
  const byDay = new Map((cmp.days || []).map((d) => [d.day, d]));
  for (const d of byDay.values()) d.misfiled = 0;
  for (const id of moved) {
    const day = cmp.day_of_missing?.[id];
    const e = day && byDay.get(day);
    if (e) { e.missing--; e.misfiled++; }
  }
  return moved.length;
}

/* Is the past actually there, or do we only think it is?
   ─────────────────────────────────────────────────────────────────────────
   /api/coverage/calendar answers "did we collect on this day" by counting OUR
   OWN rows, and it currently reports 239,236 Uber trips across 376 days with
   gaps: [] and missing_days: 0. That is a real check and it catches a whole
   day going missing — it found the 2026-07-16..08-02 hole — but it is
   self-referential. It cannot tell a day we collected completely from a day we
   collected a tenth of, because in both cases the day has rows.

   That distinction is not hypothetical here. Trips per active driver per day
   fall from 10.0 in February 2026 to 3.4 in March and only reach 5.5 by
   August, and the fall happens in the SAME month, by the same three quarters,
   in two separate fleets holding two separate Uber orgs. Two unrelated
   businesses do not lose three quarters of their work on the same Sunday. That
   looked like the shape of a collection that thinned, and no amount of
   counting our own rows could ever have said so.

   IT WAS NOT. This check has now answered its own founding question, and the
   answer is recorded here because a suspicion left standing in a comment is a
   suspicion every later reader inherits.

   Read from /api/coverage/verified on 2026-09-02 — twelve monthly windows,
   February to July 2026, both fleets, every one of them:

     agreement 100%   uber_only 0   misfiled 0

   March 2026 included, which is the month the fall happens in: Uber reports
   4,190 Ecosine and 1,852 Egari against our 4,203 and 1,862. We hold
   everything Uber still serves for every month it will still serve. The
   collapse is real business — two fleets on one platform in one city meeting
   the same market — and nothing on any page should imply otherwise.

   The check keeps earning its place: it is the only thing that can tell a day
   we collected completely from a day we collected a tenth of, and the next
   time that question is asked it will answer in hours rather than in
   speculation. (Six August windows currently error with `generate: "Not
   Found"`, which is the report-path bounce off the moved supplier host, not a
   gap — see reportBounce below.)

   The only thing that can is Uber. So this re-asks Uber for a window we
   already hold, on the same report pipeline the backfill uses, and compares
   the two sets of Trip UUIDs. What comes back is one of three answers, and
   they mean different things:

     uber_only = 0            we have everything Uber still serves for it
     uber_only > 0            trips exist upstream that we never stored
     the report itself errors Uber no longer serves the window at all

   Read-only against our database and against Uber. It writes nothing, because
   a verification that repairs what it measures can never report a failure. */
export async function auditTripWindow({ from, to, fleet = null, sample = 10 }) {
  const prev = cur;
  const out = [];
  try {
    for (const o of uberOrgs(fleet)) {
      cur = o;
      const started = Date.now();
      const entry = { fleet: o.fleet, window: [iso(from), iso(to)] };
      try {
        const id = await generateReport(from, to);
        const url = await downloadReport(id);
        const { data: csv } = await http(url, { expect: 'text', timeoutMs: 180000 });
        /* Through csvToTrips, so the audit reads the report exactly the way
           the collector does — a comparison against a differently-parsed copy
           would be measuring the parser, not the collection — and then
           immediately down to the two fields the comparison uses. csvToTrips
           keeps `raw: r`, the whole CSV record, on every trip; on a monthly
           report of twenty thousand rows that is the shape that has already
           OOM-killed this 512MB box once (see api/export_routes.js). The full
           array is garbage by the next line; only the pairs survive. */
        const theirs = csvToTrips(csv)
          .map((t) => ({ external_id: t.external_id, requested_at: t.requested_at }));
        const { rows: ourRows } = await pool.query(
          `SELECT external_id, to_char((requested_at AT TIME ZONE 'Asia/Dubai')::date, 'YYYY-MM-DD') AS day
             FROM trip
            WHERE platform = 'uber' AND fleet_id = $1
              AND (requested_at AT TIME ZONE 'Asia/Dubai')::date BETWEEN $2::date AND $3::date`,
          [o.fleet, iso(from), iso(to)]);
        const cmp = compareTripSets({ theirs, ourRows, lo: iso(from), hi: iso(to), sample });

        /* "We never stored it" and "we stored it under the other fleet" are
           different facts, and only the first is loss.
           ─────────────────────────────────────────────────────────────────
           trip's primary key is (platform, external_id) with fleet_id an
           ordinary column, and the collector upserts on that key — so the LAST
           org to collect a trip wins its fleet_id. A trip both orgs can see
           therefore ends up filed under one of them, and the query above,
           which filters fleet_id = this org, does not find it. Left
           unchecked, that trip is reported as a booking Uber has and we do
           not, on the panel whose entire claim is that its numbers are not
           our own opinion of ourselves.

           So the missing ids are asked again with no fleet filter. What is
           genuinely absent stays in uber_only; what turns up under another
           fleet becomes misfiled, which is a reconciliation defect worth
           seeing and is emphatically not lost data. */
        let misfiled = 0;
        if (cmp.missing_ids.length) {
          try {
            const { rows: held } = await pool.query(
              `SELECT external_id FROM trip
                WHERE platform = 'uber' AND external_id = ANY($1) AND fleet_id IS DISTINCT FROM $2`,
              [cmp.missing_ids, o.fleet]);
            /* The ids, not a count, so the per-day breakdown can be corrected
               too — otherwise a window whose headline is right still points at
               the wrong days. */
            misfiled = applyMisfiled(cmp, new Set(held.map((r) => r.external_id)));
          } catch (e) {
            /* Unknown, not zero. Reporting every missing id as lost because a
               second query failed would be the exact overstatement this check
               exists to prevent, so the window says it could not tell. */
            misfiled = null;
            log.warn(SRC, 'could not separate misfiled trips from missing ones',
              { fleet: o.fleet, err: String(e).slice(0, 140) });
          }
        }
        delete cmp.missing_ids;
        delete cmp.day_of_missing;
        Object.assign(entry, cmp, { misfiled, took_ms: Date.now() - started });
      } catch (e) {
        /* An error IS an answer, and a different one from zero rows: "Uber
           will not serve this window any more" and "Uber served it and it was
           empty" have opposite consequences for whether a backfill is worth
           running. */
        const msg = String(e?.message || e);
        entry.error = msg.slice(0, 300);
        entry.past_retention = /invalid date range|retention|out of range/i.test(msg);
        entry.took_ms = Date.now() - started;
      }
      out.push(entry);
    }
  } finally { cur = prev; }
  return out;
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
  const URL_ = `${UBER_WEB_HOST}/graphql`;
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
      /* 'moved' when the bounce was to something other than a login host —
         see credentialState(). A cookie is not the fix for a renamed host. */
      state: credentialState(bad), detail: bad.reason, surface: 'supplier graphql' });
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
/* How far back to ask, day by day and week by week. The endpoint's own horizon
   is measured — see UBER_EARNER_HORIZON_DAYS in src/auth/uber.js, where both
   halves of this now live — and it rolls forward daily, so the ASK sits a
   little past it: overshooting costs a few empty calls, undershooting loses
   days that can never be re-fetched.

   Derived rather than written down again. api/reconcile_routes.js had its own
   copy of the measured edge and the two had already drifted eight days apart,
   so the banner telling a reader where Uber stops answering and the grid
   deciding what to ask could disagree about the same day. */
const EARNER_DAY_HORIZON = UBER_EARNER_HORIZON_DAYS + UBER_EARNER_ASK_MARGIN_DAYS;

async function pullEarnerBreakdowns(from, to, onStep, checkpoint = null) {
  let total = 0;
  const chunks = [];
  const drivers = await uberDriverIds();
  /* Whole calendar weeks, not seven days counted from whenever this run began
     — see weekChunks. The window is the primary key of what gets stored, so a
     grid that moves with the run stores the same week twice. */
  /* Bounded by the same rolling horizon the daily grid below is bounded by,
     for the reason its own comment already gives: "Asking past the edge costs
     calls and returns empty." That reasoning was applied to the days and not
     to the weeks, three lines apart.

     Measured against the live endpoint on 2026-09-02, one week per probe:

       2026-08-10..08-16   10 rows,  4 with money
       2026-03-02..03-08   10 rows,  7 with money
       2026-02-16..02-22   10 rows,  7 with money   <- 192 days back, the edge
       2026-02-09..02-15    0 rows
       2026-02-02..02-08    0 rows
       2025-12-15..12-21    0 rows
       2025-06-16..06-22    0 rows

     Over a two-year backfill that is 73 of 100 weekly windows per fleet asking
     Uber for something it will never serve, and it is not free: backfill job
     41 was measured at 72 seconds a window, so roughly three and a half hours
     of every backfill, every week, spent being told nothing — while FMS, which
     is last in the source order and holds a 73-day alert hole, waits behind it.

     The margin is deliberate and points the same way as the daily grid's:
     overshooting costs a few empty calls, undershooting loses weeks that can
     never be re-fetched. A week is kept if any part of it reaches the
     horizon. */
  const weekHorizon = new Date(Date.now() - EARNER_DAY_HORIZON * 864e5);
  const weekly = [...weekChunks(from, to)]
    .filter((w) => w.end >= weekHorizon)
    .map((w) => ({ ...w, ps: iso(w.start), pe: iso(w.end) }));

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
    /* What is already written and committed, so a throw reports it rather
       than zero. */
    let written = 0;
    try {
      /* The checkpoint is per ORG as well as per window: the two fleets walk
         the same calendar, so a bare window name would let Egari's run be
         skipped because Ecosine had already done that month. */
      const ck = checkpoint && {
        has: (u) => checkpoint.has(`${o.fleet}:${u}`),
        mark: (u, n) => checkpoint.mark(`${o.fleet}:${u}`, n),
      };
      const trips = await pullTrips(from, to, onStep, ck);
      written += trips.total;
      const perf = await pullEarnerBreakdowns(from, to, onStep, ck);
      written += perf.total;
      /* Quality LAST, and never on the half-hourly incremental.
         ─────────────────────────────────────────────────────────────────────
         Two reports per week per fleet, minutes each, against a cap of three
         in flight per org. On the incremental — a three-day window, every
         thirty minutes — that is four reports an hour of the day, for a week
         that has not changed since the last pass, taken from the same three
         slots the trip and earnings pulls need. The nightly catch-up walks
         thirty days and the weekly backfill walks the horizon, which is where
         a report this expensive belongs.

         Last in the pass for the same reason: trips and earnings are the
         product, acceptance and ratings make it rankable, and a run that runs
         out of slots should end having collected the money. */
      const qual = mode === 'incremental'
        ? { total: 0, chunks: [] }
        : await pullDriverQuality(from, to, onStep, ck);
      written += qual.total;
      // Every sub-source's windows, so a run that fetched every trip and no
      // earnings reads as partial rather than as ok.
      const chunks = [...trips.chunks, ...perf.chunks, ...qual.chunks];
      // `chunks` is what turns "ok, 1129 rows" into "partial — these nine windows
      // are still missing", and it is the difference between a hole that is
      // visible and one that is not.
      await logRun({ source: SRC, fleet_id: o.fleet, mode,
        window_start: from, window_end: to,
        rows_written: trips.total + perf.total + qual.total,
        chunks });
      log.info(SRC, `done (${o.fleet})`, { trips: trips.total, perf, quality: qual.total,
        windows_failed: trips.chunks.filter((c) => c.error).length, of: trips.chunks.length });
    } catch (e) {
      /* rows_written, not 0. src/db.js stores `run.rows_written || 0`, so
         omitting it told the status page that a run which had already written
         and committed thousands of rows wrote none — and "collected nothing"
         is the sentence that sends somebody hunting a fault that is not
         there. What landed, landed. */
      await logRun({ source: SRC, fleet_id: o.fleet, mode, window_start: from, window_end: to,
        status: 'error', rows_written: written, error: String(e) });
      log.error(SRC, `failed (${o.fleet})`, { err: String(e) });
    } finally {
      cur = null;
    }
  }
}
