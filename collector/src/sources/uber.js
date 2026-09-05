// Uber collector — one pass per configured org (Ecosine, Egari).
//  Historical trips  : report pipeline GenerateReport -> poll DownloadReport -> signed CSV.
//                      Server limits: <=31-day range, <=3 concurrent reports, async, ~12mo retention.
//  Driver perf       : GraphQL getPerformanceReport / getEarnerBreakdownsV2 (per driver).
//  Live status       : OAuth /drivers/actions (online/on-trip/offline).
import { parse } from 'csv-parse/sync';
import { config, normPlate } from '../config.js';
import { http, qs, sleep } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { dateChunks, weekChunks, closedWeeks, dubaiDayChunks, iso, unixMs } from '../util.js';
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

/* The fifteen header strings this mapper is keyed on, asserted rather than
   assumed.
   ─────────────────────────────────────────────────────────────────────────
   Every lookup below is an exact string match against Uber's header row, and
   those strings are the localeCode=en-GB RENDERING — not the canonical field
   names. Uber's own reference publishes the same fifteen fields, in the same
   order, spelled differently on all of them: 'Trip Pickup Address' for
   'Pick-up address', 'Vehicle License Number' for 'Number plate', 'Trip
   DropOff Time' for 'Trip drop-off time'. Our spellings are the live ones —
   plates, addresses and payment types all land — so they must not be
   "corrected" to the documented ones, which would null every column at once.

   But that means one locale flip or one header refresh turns every trip's
   plate, driver, distance, addresses and payment type to NULL, silently,
   while the run still reports the same row count. The payments report in this
   same file already learned this the expensive way and got pathKey()
   normalisation; the trip mapper, written first, got nothing.

   Normalising is the wrong fix here — 'Pick-up address' and 'Trip Pickup
   Address' do not normalise onto each other, and pretending they might would
   hide the day Uber actually renames something. What is wanted is a LOUD
   failure, so this asserts the header and throws. A run that fails is a hole
   somebody fixes; a run that writes fifteen nulls per row and reports success
   is a year of silent corruption. */
const TRIP_COLUMNS = ['Trip UUID', 'Driver UUID', 'Number plate', 'Trip request time',
  'Trip status', 'Payment type'];

function assertTripHeader(recs) {
  if (!recs.length) return;
  const seen = new Set(Object.keys(recs[0]));
  const missing = TRIP_COLUMNS.filter((c) => !seen.has(c));
  if (!missing.length) return;
  /* The observed header travels in the message. Without it the operator knows
     only that something changed, and the whole cost of this class of failure
     is the hours between "it broke" and "it is called this now". */
  throw new Error(`trip report header changed — missing ${missing.join(', ')}; `
    + `Uber sent: ${[...seen].slice(0, 20).join(' | ')}`);
}

export function csvToTrips(csv) {
  const recs = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
  assertTripHeader(recs);
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


/* ── the per-trip fare, which Uber does publish after all ─────────────────
   REPORT_TYPE_PAYMENTS_ORDER is one row per TRANSACTION, and unlike
   TRIP_ACTIVITY it carries money. Probed live on the Ecosine org for the week
   of 24-30 August 2026, 399 rows:

     transaction UUID                       399 distinct
     Trip UUID                              379 distinct
     Description                            5 values, listed below
     Paid to you                            the transaction's total
     Paid to you : Your earnings            net of Uber's service fee
     Paid to you : Your earnings : Fare     THE FARE — a BRANCH, see PAY_COLS
     Paid to you:Your earnings:Fare:Fare    the base-fare leaf beneath it
     Paid to you:Your earnings:Service fee  exactly 25% of the branch
     Paid to you : Trip balance : Payouts : Cash collected
     Paid to you:Trip balance:Payouts:Transferred To Bank Account

   That last column answered a question this product had been reconciling by
   hand: its only non-zero value in the sample is -66863.51, which is exactly
   the AED 66,863.51 credited to the Ecosine ENBD account on 24 August. The
   wire is IN the report.

   Why this exists at all, and why it took so long to find: the trip export
   (REPORT_TYPE_TRIP_ACTIVITY) has fifteen columns and no fare, so 12,445 of
   August's 13,950 bookings carried price NULL and every fare figure in the
   product came from the hotel, Bolt and Yango channels — a tenth of the work.
   api/probe.js had asked Uber which report types exist using sixteen INVENTED
   names, four of which happened to be real, and reported "only four report
   types are valid for this org". Uber publishes sixteen real ones. This was in
   the twelve nobody asked for.

   ── the column names are a tree flattened into strings ───────────────────
   Uber renders the earnings breakdown as a path — 'Paid to you:Your
   earnings:Fare:Fare' — and the separator is inconsistent in the provider's
   own header row: some columns use ' : ' with spaces and some use ':' without.
   Both spellings appear in ONE report. So every lookup here normalises
   whitespace around the separator rather than matching the literal, because a
   mapper keyed on the exact string silently reads null the first time Uber
   reformats a header, and a null fare is indistinguishable from a trip that
   was never priced.

   ── which rows are a trip, and which are not ─────────────────────────────
   Description takes five values in the sample:

     'trip completed order'                          a ride
     'Business Order for: marketplace: PERSONAL_TRANSPORT'   a ride, U4B
     'trip fare adjust order'                        a correction to a ride
     'Business Adjustment Order for: ...'            a correction, U4B
     'so.payout'                                     the weekly WIRE

   Only the first two are the fare of a ride. An adjustment is real money and
   belongs to the trip, but adding it to `price` would make the fare of the
   trip differ from what the rider was charged; it is summed separately so a
   page can show both. 'so.payout' carries no Trip UUID and is the settlement —
   it is the row that reconciles to the bank, and writing it as a trip price
   would attribute a whole week's wire to one ride. */
const PAYMENTS_REPORT = 'REPORT_TYPE_PAYMENTS_ORDER';

/* Uber writes the same path with and without spaces around the colon, in the
   same header row. Keyed on the squeezed form so both find each other. */
const pathKey = (s) => String(s || '').toLowerCase().replace(/\s*:\s*/g, ':').trim();

/* The FARE is the parent node, and taking the leaf understates it.
   ─────────────────────────────────────────────────────────────────────────
   'Paid to you:Your earnings:Fare' is a branch. Its children in the live
   report are Fare, Surge, Wait time at pick-up, Time at stop, Cancellation,
   Additional cancellation fee for extended wait time, Reservation Fee,
   Business trip premium and Adjustment — nine columns, of which the first is
   also called Fare. This mapper read that leaf, so every ride whose money was
   not purely base fare was written into `price` short.

   MEASURED on production, 29 priced Ecosine trips of 25-28 August 2026. The
   report is internally consistent to the fils on every one of them:

       service fee = 25.00% of the fare BRANCH, on 29 rows of 29
       earnings    = fare branch + service fee + 5% VAT on that fee + tip

   which pins the branch total without needing the column at all, and lets the
   leaf be checked against it. The leaf agreed on 19 rows and was short on 10:

       41.28 against 49.41      a surge ride
       28.97 against 46.37      wait time and a reservation fee
       80.50 against 87.67
        0.00 against 15.00      a cancellation — the whole fare is the fee,
        0.00 against 15.00      and the leaf for it is zero

   Two of those are the worst case in the product: a trip that earned AED 15
   was on record as costing nothing, which is not a missing figure a reader
   can see but a wrong one they cannot.

   ── and Uber's OTHER surface says the same thing ─────────────────────────
   The weekly earnings breakdown — a different API, a different vocabulary —
   carries the identical tree. One driver's week of 24-30 August 2026, read off
   /api/driver/earnings:

       your_earnings          1900.67
       ├─ fare                2550.17     the BRANCH
       │  ├─ little_fare      2468.75     its base-fare leaf
       │  ├─ wait_time          66.42
       │  └─ cancellation       15.00
       ├─ service_fee         -637.61     exactly 25.00% of fare
       ├─ taxes_earnings       -31.89     5% VAT on that fee
       └─ tip                   20.00
                              --------
                              1900.67     closes to the fils

   `little_fare` is what this parser was writing into trip.price. Measured
   across the five drivers of that week whose payments report priced 100% of
   their trips, sum(trip.price) equalled their little_fare EXACTLY — 0.0% on
   every one — and sat 1.2% to 3.4% under their `fare`. So the two surfaces
   agree about which node is which, and this was reading the wrong one on both.

   It matters beyond the size of it: `statement_fares`, the figure the driver
   page already calls the fare the platform reports, is the BRANCH. With the
   leaf in trip.price the product held two numbers for one quantity and they
   could not be reconciled. With the branch, sum(trip.price) IS the statement's
   fare line, and each is a check on the other.

   So the branch is read first and the leaf is the fallback, for a report old
   enough not to carry the branch. The leaf is kept beside it in `raw` — an
   auditor comparing the two is exactly how this was found. */
const PAY_COLS = {
  txn: 'transaction uuid',
  trip: 'trip uuid',
  driver: 'driver uuid',
  what: 'description',
  paid: 'paid to you',
  earnings: 'paid to you:your earnings',
  fare: 'paid to you:your earnings:fare',
  fare_base: 'paid to you:your earnings:fare:fare',
  service_fee: 'paid to you:your earnings:service fee',
  cash: 'paid to you:trip balance:payouts:cash collected',
  bank: 'paid to you:trip balance:payouts:transferred to bank account',
  tip: 'paid to you:your earnings:tip',
};

/* A ride, an adjustment to a ride, or the weekly wire. Matched on substrings
   because the U4B variants carry a marketplace suffix that will grow. */
function orderKind(description) {
  const d = String(description || '').toLowerCase();
  if (d.includes('payout')) return 'payout';
  if (d.includes('adjust')) return 'adjustment';
  if (d.includes('order')) return 'trip';
  return 'other';
}

const money = (v) => {
  if (v == null || v === '') return null;
  /* Uber writes '0' for a component that did not apply and '-66863.51' for
     money leaving the balance. Both are real values; only a blank is absent. */
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/* One CSV into the two things it holds: a fare per trip, and the settlement
   rows that are not about any trip. */
export function csvToPayments(csv) {
  const recs = parse(csv, { columns: true, skip_empty_lines: true, bom: true });
  const trips = new Map();
  const settlements = [];
  for (const r of recs) {
    const g = {};
    for (const [k, v] of Object.entries(r)) g[pathKey(k)] = v;
    const kind = orderKind(g[PAY_COLS.what]);
    const tripId = String(g[PAY_COLS.trip] || '').trim();
    if (kind === 'payout' || !tripId) {
      settlements.push({
        transaction_id: String(g[PAY_COLS.txn] || '').trim() || null,
        driver_ext_id: String(g[PAY_COLS.driver] || '').trim() || null,
        description: g[PAY_COLS.what] || null,
        amount: money(g[PAY_COLS.paid]),
        bank: money(g[PAY_COLS.bank]),
        kind,
      });
      continue;
    }
    /* One trip can carry several transactions — the ride, then a fare
       adjustment days later, then a tip. They are folded here rather than
       upserted one after another, because two upserts on the same primary key
       would leave whichever arrived last, and the answer is the sum. */
    const cur = trips.get(tripId) || { external_id: tripId, fare: null, fare_base: null,
      adjustment: null, earnings: null, service_fee: null, cash: null, tip: null, txns: 0 };
    const add = (field, v) => { if (v != null) cur[field] = (cur[field] ?? 0) + v; };
    if (kind === 'adjustment') add('adjustment', money(g[PAY_COLS.paid]));
    else {
      /* Branch first, leaf second — see PAY_COLS. `??` and not `||`, because
         a genuine zero fare is a real answer and must not fall through to the
         other column. */
      add('fare', money(g[PAY_COLS.fare]) ?? money(g[PAY_COLS.fare_base]));
      add('fare_base', money(g[PAY_COLS.fare_base]));
    }
    add('earnings', money(g[PAY_COLS.earnings]));
    add('service_fee', money(g[PAY_COLS.service_fee]));
    add('cash', money(g[PAY_COLS.cash]));
    add('tip', money(g[PAY_COLS.tip]));
    cur.txns += 1;
    trips.set(tripId, cur);
  }
  return { trips: [...trips.values()], settlements };
}


/* Walk the payments report and fill in the fare every Uber trip was missing.
   ─────────────────────────────────────────────────────────────────────────
   Weekly windows, newest first, for the same reasons pullTrips walks months
   newest first: a truncated run leaves the recent weeks collected rather than
   the oldest, and a report costs minutes at the provider.

   ── the RUNNING week is asked for too, CLAMPED, and never checkpointed ───
   This walked closedWeeks() alone, and the cost of that is the days a reader
   actually looks at. Measured on Friday 4 September 2026: the week that began
   Monday the 31st holds 3,252 Uber bookings against 3,321 in the week before
   it, and not one of them could carry a fare until the week closed on Sunday.
   A Monday trip waited seven days. Every other channel — Bolt, Yango, the
   hotel desk — prices its bookings on the trip row itself, the same day; Uber
   was the only one where a reader saw a dash, and the reason was ours.

   The reason closedWeeks exists is real and is recorded in
   test/earner_horizon.test.mjs: an open week's chunk ENDS on the coming
   Sunday, and Uber refuses a range whose end is in the future outright —
   "endDate is too late", measured on production on every mid-week run. That
   is a refusal of a FUTURE date, not of a part week. pullTrips asks for
   windows ending today on every pass and Uber serves them, which is why this
   product holds Uber trips for this morning.

   So the running week is asked for as Monday-to-`to` rather than
   Monday-to-Sunday: entirely in the past, and the same shape of range the
   trip report is answered for every half hour. If Uber refuses it anyway the
   refusal lands in chunk.error, is classified expected, and costs one request
   a night — which is worth spending to find out.

   Never checkpointed, because it is not finished: asking again tomorrow
   restates it with another day's trips in it, and asking once more after it
   closes is what settles it. The write is an UPDATE of price on rows that
   already exist, so re-asking is idempotent and a trip's fare only improves.

   FIRST, not last, because the report-generation cap is freshest at the start
   of a pass and because this is the only week whose data does not exist yet —
   a closed week missed tonight is already collected and will be re-asked
   tomorrow. The one thing that must not follow is a throttle here abandoning
   the closed weeks, so a throttle on the running week continues rather than
   breaking. Everywhere else it still breaks: the cap is per run, and the
   remaining weeks would only hit it too.

   WEEKS and not months, because this report is rate-limited on a counter of
   its own — 'Payment report generation limit reached. Please wait for current
   reports to complete before generating a new one' — which is a different cap
   from the three-in-flight one the trip reports hit, and it is easily
   exhausted. A month-wide window would be cheaper in requests but Uber refuses
   the wider ranges on this type more often than it refuses a week.

   The writes are deliberately narrow. `trip` rows already exist from
   TRIP_ACTIVITY, keyed on (platform, external_id), and this fills price and
   currency on the ones the payments report prices. It must never INSERT a trip:
   a payments row whose Trip UUID we have never seen is a trip outside the
   window the trip report covered, and inventing a row for it would create a
   booking with no time, no plate and no driver that every count in the product
   would then include. */
/* The weeks this walk asks for, running week first, closed weeks newest-first.

   Lifted out of the walk because the walk is no longer per fleet: both orgs
   ask for the same calendar, and pullTripFaresAcross drives them through it
   together. Computing the list once also makes `of` — the denominator an
   operator reads on the Settings page — the number of weeks rather than the
   number of weeks times the number of fleets. */
export function fareWeeks(from, to) {
  const closed = [...closedWeeks(from, to)].reverse();
  /* The week the range reaches that has not ended. weekChunks yields every
     week the range touches; closedWeeks yields the subset that has finished,
     so the difference is at most one — and it is the one this walk used to
     miss. Compared on the start instant rather than by identity, because the
     two generators build their own Date objects.

     CLAMPED to `to`. A running week's own `end` is the coming Sunday and Uber
     refuses a future end date; asked as Monday-to-today it is an ordinary past
     range. See the header. */
  const done = new Set(closed.map((w) => +w.start));
  const end = new Date(to);
  const running = [...weekChunks(from, to)]
    .filter((w) => !done.has(+w.start) && w.start <= end)
    .map((w) => ({ ...w, end: w.end > end ? end : w.end, isOpen: true }));
  return [...running, ...closed.map((w) => ({ ...w, isOpen: false }))];
}

/* The order the walk asks in: every fleet on a week before any fleet moves on
   to the next one.

   Pure, and exported, because the ORDER is the entire fix and the walk that
   consumes it cannot be tested — every step of it is a report that costs
   minutes at Uber. What a test can hold down is the property that makes the
   fix a fix: at no point in the sequence has one fleet been asked about more
   weeks than another, plus or minus the one week in hand. A walk that fails
   that property is a walk where a job cut short leaves one fleet complete and
   the other empty, which is the state Egari was actually in. */
export function* fareTasks(orgs, weeks) {
  for (const w of weeks) for (const o of orgs) yield { w, o };
}

/* One fleet, one week. The caller owns the accumulation because the
   accumulation is per fleet and the walk is not. */
async function collectFareWeek(w, onStep, checkpoint, state) {
  const ps = iso(w.start), pe = iso(w.end);
  const isOpen = w.isOpen;
  const chunk = { from: ps, to: pe, rows: 0, error: null, open: isOpen || undefined };
  /* The key carries which fare column this pass writes, not just which week
     it covers. Checkpoints live for the length of a job and a long backfill
     survives several container restarts, so a job that already collected a
     week under the old leaf-column reading would skip it forever and leave
     those weeks understated. Changing what a window MEANS has to change its
     key, or resuming silently keeps the old answer. */
  const key = `fares:branch ${ps}..${pe}`;
  /* A running week is never checkpointed and so is never skipped — see the
     header. It is asked again on every pass until it closes. */
  if (!isOpen && checkpoint?.has(key)) {
    chunk.skipped = true; state.chunks.push(chunk); return chunk;
  }
  /* The fleet is named in the step now that two of them walk the same week
     one after the other: without it an operator watching a backfill sees the
     same window twice and reads it as the job having stalled. */
  await onStep?.({ window: `fares ${ps}..${pe}`, fleet: org().fleet,
    index: state.chunks.length, of: state.of, rows_so_far: state.total });
  try {
    const id = await generateReport(w.start, w.end, 0, PAYMENTS_REPORT);
    const url = await downloadReport(id);
    const { data: csv } = await http(url, { expect: 'text', timeoutMs: 180000 });
    const { trips, settlements } = csvToPayments(csv);
    /* UPDATE, never upsert. See the header above: a Trip UUID we do not hold
       is a trip outside the collected window, and the row must not be
       invented. The count of rows that matched is what tells an operator
       whether the two reports actually describe the same trips. */
    let priced = 0;
    for (const t of trips) {
      if (t.fare == null && t.earnings == null) continue;
      const { rowCount } = await pool.query(
        `UPDATE trip SET price = $3, currency = coalesce(currency, 'AED'),
                raw = coalesce(raw, '{}'::jsonb) || $4::jsonb
           WHERE platform = 'uber' AND external_id = $2 AND fleet_id = $1`,
        [org().fleet, t.external_id, t.fare,
          JSON.stringify({ uber_payments: {
            fare: t.fare, fare_base: t.fare_base, earnings: t.earnings,
            service_fee: t.service_fee, cash_collected: t.cash, tip: t.tip,
            adjustment: t.adjustment, transactions: t.txns } })]);
      priced += rowCount;
    }
    state.total += priced;
    chunk.rows = priced;
    /* Both numbers, because they answer different questions. `rows` is what
       landed; `orders` and `unmatched` say whether the payments report and
       the trip report agree about which trips exist, which is the check that
       catches a window collected by one and not the other. */
    chunk.orders = trips.length;
    chunk.unmatched = trips.length - priced;
    chunk.settlements = settlements.length;
    log.info(SRC, `fares ${org().fleet} ${ps}..${pe}`, { orders: trips.length, priced,
      unmatched: trips.length - priced, settlements: settlements.length });
    state.consecutiveFailures = 0;
  } catch (err) {
    const msg = String(err);
    /* A RUNNING week is a speculative ask, so its refusal is never a hole.
       Uber may not serve a payments report for a week it has not settled,
       and if it does not, that is an answer rather than a failure — the
       closed weeks are asked immediately after and would report any real
       problem (an expired cookie, a dead endpoint) on their own. Held here
       so a nightly ask for the current week cannot make every run read
       partial for the life of the week. */
    const expected = isOpen || /invalid date range|retention|out of range/i.test(msg);
    /* Rate limiting is its OWN case and is not a hole. This report has a
       generation cap separate from the three-in-flight one, and a run that
       hits it has not failed to collect the week — it has been told to come
       back. Recorded as an error so the run reads partial, but never
       checkpointed, so the next pass asks again. */
    const throttled = /rate-limit|generation limit|too many ongoing/i.test(msg);
    chunk.error = isOpen ? `the week is still running: ${msg.slice(0, 140)}`
      : expected ? `outside retention: ${msg.slice(0, 160)}`
        : throttled ? `rate-limited, will retry next run: ${msg.slice(0, 120)}`
          : msg.slice(0, 300);
    chunk.expected = expected;
    chunk.throttled = throttled;
    log[expected || throttled ? 'info' : 'error'](SRC,
      `fare chunk ${org().fleet} ${ps}..${pe} ${isOpen ? 'running week, not served' : expected ? 'outside retention' : throttled ? 'rate-limited' : 'FAILED'}`,
      { err: msg.slice(0, 200) });
    if (!expected && !throttled) state.consecutiveFailures++;
    /* A throttle on the RUNNING week must not cost the closed ones. It is
       the first ask of the pass and the only speculative one; everywhere
       else the cap is per run and the remaining weeks would hit it too.

       The chunk is pushed BEFORE the walk stops, and that is a fix rather
       than a tidy-up: `break` from inside this catch skipped the push at the
       foot of the loop, so a fares pass refused outright recorded no chunk at
       all and the run reported itself ok. An operator reading /api/status saw
       a healthy Uber run with no fares in it and nothing saying why — the
       same class of silence as the 299-day hole the trip walk's comment
       describes.

       It stops THIS FLEET and not the walk. The two orgs hold separate
       supplier sessions and the generation counter is the provider's, per
       supplier — so a cap reached asking as Ecosine is not evidence about
       Egari. If it turns out to be one counter across both, the other fleet
       throttles on its own next window and stops itself, one request later:
       the cost of being wrong here is a single request, and the cost of
       assuming the opposite is the fleet that was never asked. */
    if (throttled && !isOpen) {
      state.stopped = true; state.chunks.push(chunk); return chunk;
    }
  }
  state.chunks.push(chunk);
  /* Never for the running week: it is not finished, and marking it done
     would freeze a part-week answer for the rest of the job. */
  if (!isOpen && (!chunk.error || chunk.expected)) await checkpoint?.mark(key, chunk.rows);
  await sleep(state.consecutiveFailures ? 20000 : 8000);
  return chunk;
}

/* Both fleets through the same calendar, week by week, together.
   ─────────────────────────────────────────────────────────────────────────
   This used to be one full walk per fleet, run one after the other from
   collect(), and the cost of that was measurable and one-sided: on 5 September
   2026 Ecosine carried a fare on 99.9% of its chargeable Uber bookings in
   every one of the twelve months Uber still serves, and Egari carried one on
   0% of every month before the current one. Not because Egari's reports are
   refused — they are served, and the weeks that have been asked for came back
   full — but because nothing ever asked. A backfill walks ~105 weekly windows
   per fleet at roughly a minute each plus a paced sleep, the worker restarts
   whenever the app deploys, and Egari's walk is behind all of Ecosine's. Job
   50 died at Ecosine week 51 and had to be resumed to reach Egari at all.

   Interleaved, a job that dies leaves the two fleets the same distance back
   instead of one complete and one empty, and the first hour of any backfill
   covers the most recent weeks of BOTH. The provider cost is identical — the
   same windows, the same number of reports — only the order changes.

   The order within a week is the org order, which is stable, so a resumed job
   asks in the same sequence it did before and the checkpoint still lands on
   the windows it describes. */
async function pullTripFaresAcross(orgs, from, to, onStep, ckFor) {
  const weeks = fareWeeks(from, to);
  const state = new Map(orgs.map((o) => [o.fleet,
    { total: 0, chunks: [], consecutiveFailures: 0, stopped: false, of: weeks.length }]));
  log.info(SRC, 'fares walk', { weeks: weeks.length, fleets: orgs.map((o) => o.fleet).join(',') });
  const prev = cur;
  try {
    for (const { w, o } of fareTasks(orgs, weeks)) {
      const st = state.get(o.fleet);
      if (st.stopped) continue;
      cur = o;
      /* collectFareWeek catches the provider; this catches everything else —
         a checkpoint write that fails, an onStep that throws. One fleet's bad
         turn must not end the other fleet's walk, which is the whole point of
         interleaving them. */
      try { await collectFareWeek(w, onStep, ckFor(o), st); }
      catch (e) {
        st.stopped = true;
        st.chunks.push({ from: iso(w.start), to: iso(w.end), rows: 0,
          error: `fare walk stopped: ${String(e).slice(0, 200)}` });
        log.error(SRC, `fare walk stopped (${o.fleet})`, { err: String(e).slice(0, 200) });
      }
    }
  } finally { cur = prev; }
  return new Map([...state].map(([f, s]) => [f, { total: s.total, chunks: s.chunks }]));
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
  /* closedWeeks, not weekChunks: an open week ends on the coming Sunday and
     Uber refuses it outright — "endDate is too late" — so every mid-week run
     spent a report slot to be told no and recorded a failed chunk for it. See
     src/util.js. The week lands when it closes. */
  const weeks = [...closedWeeks(from, to)].reverse().slice(0, QUALITY_WEEK_HORIZON);
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
  const weekly = [...closedWeeks(from, to)]
    .filter((w) => w.end >= weekHorizon)
    .map((w) => ({ ...w, ps: iso(w.start), pe: iso(w.end) }));

  /* And the same question asked one Dubai day at a time, for as far back as
     Uber will answer it.
     ─────────────────────────────────────────────────────────────────────────
     A week stored as one row is spread across its seven days by
     driver_payout_day_finest, so #reconcile showed the same figure on three
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
  /* Phases across the orgs, not one whole pass per org.
     ─────────────────────────────────────────────────────────────────────────
     Each configured org still gets its own run row — so the Sources page
     shows uber/ecosine and uber/egari separately and a dead cookie on one
     fleet reads as that fleet's failure, not as half the numbers quietly
     missing from a shared one — and the two are still worked sequentially,
     because the report pipeline's three-in-flight cap is per org but the two
     sessions share this process's connection pool and the API's patience.

     What changed is the grain of "sequentially". A pass per org meant the
     second fleet waited out the FIRST fleet's entire history before it was
     asked anything, and on a walk of ~105 weekly windows per source that is
     hours — longer than the worker survives between deploys. The measured
     cost is in pullTripFaresAcross: eleven months where Ecosine had a fare on
     99.9% of its bookings and Egari had one on none of them, because Egari's
     walk was always behind. Phases put both fleets through the same stage
     before either moves on, so a run that is cut short is cut short evenly. */
  const orgs = uberOrgs(fleet);
  /* The checkpoint is per ORG as well as per window: the two fleets walk
     the same calendar, so a bare window name would let Egari's run be
     skipped because Ecosine had already done that month. */
  const ckFor = (o) => checkpoint && {
    has: (u) => checkpoint.has(`${o.fleet}:${u}`),
    mark: (u, n) => checkpoint.mark(`${o.fleet}:${u}`, n),
  };
  const empty = () => ({ total: 0, chunks: [] });
  /* One accumulator per org, filled by the phases below and reported at the
     foot. `written` is what has already been written and committed, so a
     throw reports it rather than zero. */
  const st = new Map(orgs.map((o) => [o.fleet, { o, written: 0, error: null,
    trips: empty(), perf: empty(), fares: empty(), qual: empty() }]));
  /* rows_written, not 0. src/db.js stores `run.rows_written || 0`, so omitting
     it told the status page that a run which had already written and committed
     thousands of rows wrote none — and "collected nothing" is the sentence
     that sends somebody hunting a fault that is not there. What landed,
     landed. Written the moment the fleet fails rather than at the foot: the
     phases below can run for hours, and an operator watching a backfill needs
     to see a dead session when it dies, not when the other fleet finishes. */
  const fail = async (s, e) => {
    s.error = e;
    await logRun({ source: SRC, fleet_id: s.o.fleet, mode, window_start: from, window_end: to,
      status: 'error', rows_written: s.written, error: String(e) });
    log.error(SRC, `failed (${s.o.fleet})`, { err: String(e) });
  };
  /* A fleet that has already failed sits out the rest of the phases, which is
     what the per-org try/catch did when the pass was per org: a fleet whose
     session is dead has nothing to gain from three more surfaces asking. */
  const phase = async (s, name, fn) => {
    if (s.error) return;
    cur = s.o;
    try { const r = await fn(); s[name] = r; s.written += r.total || 0; }
    catch (e) { await fail(s, e); }
    finally { cur = null; }
  };

  /* 1. Trips, for every fleet. FIRST because the fare walk UPDATEs rows this
        creates and never inserts its own. */
  for (const s of st.values()) await phase(s, 'trips', () => pullTrips(from, to, onStep, ckFor(s.o)));

  /* 2. The per-trip fare, week by week ACROSS the fleets — see
        pullTripFaresAcross. Not on the incremental: the payments report has a
        generation cap of its own, separate from the three-in-flight one, and a
        half-hourly three-day window would spend it on a week that has not
        closed. The fares land when the week does, which is what the nightly
        catch-up and the weekly backfill are for. */
  if (mode !== 'incremental') {
    const live = [...st.values()].filter((s) => !s.error);
    if (live.length) {
      /* The walk itself cannot throw — every step is caught per fleet inside
         it — so this catches only what precedes the first step: a range that
         does not parse into weeks. It fails every fleet in the walk, because
         none of them was asked anything. */
      try {
        const per = await pullTripFaresAcross(live.map((s) => s.o), from, to, onStep, ckFor);
        for (const [f, r] of per) {
          const s = st.get(f);
          if (!s) continue;
          s.fares = r; s.written += r.total;
        }
      } catch (e) { for (const s of live) await fail(s, e); }
    }
  }

  /* 3. The earnings tree, and then quality. Quality LAST, and never on the
        half-hourly incremental: two reports per week per fleet, minutes each,
        against a cap of three in flight per org. On the incremental — a
        three-day window, every thirty minutes — that is four reports an hour
        of the day, for a week that has not changed since the last pass, taken
        from the same three slots the trip and earnings pulls need.

        Last for the same reason the fares are second: trips and earnings are
        the product, acceptance and ratings make it rankable, and a run that
        runs out of slots should end having collected the money. */
  for (const s of st.values()) {
    await phase(s, 'perf', () => pullEarnerBreakdowns(from, to, onStep, ckFor(s.o)));
  }
  /* A separate loop, not the tail of the one above. Perf and quality are each
     a walk of their own, so pairing them per fleet would put the second
     fleet's earnings behind the first fleet's ratings — the same ordering
     that left Egari without fares, one surface down. Whole phases keep the
     fleets level at every boundary. These two are not interleaved week by
     week the way the fares are: both are bounded by the provider's rolling
     horizon (192 days, and QUALITY_WEEK_HORIZON weeks) rather than by the
     whole backfill, so a fleet is minutes behind here and not hours. */
  if (mode !== 'incremental') {
    for (const s of st.values()) {
      await phase(s, 'qual', () => pullDriverQuality(from, to, onStep, ckFor(s.o)));
    }
  }

  /* 4. One run row per fleet, at the foot rather than at the end of that
        fleet's pass — the phases interleave, so there is no such moment any
        more. The row says the same thing it always did. */
  for (const s of st.values()) {
    const o = s.o;
    // A fleet that failed already has its run row, written when it failed.
    if (s.error) continue;
    // Every sub-source's windows, so a run that fetched every trip and no
    // earnings reads as partial rather than as ok.
    const chunks = [...s.trips.chunks, ...s.perf.chunks, ...s.fares.chunks, ...s.qual.chunks];
    // `chunks` is what turns "ok, 1129 rows" into "partial — these nine windows
    // are still missing", and it is the difference between a hole that is
    // visible and one that is not.
    await logRun({ source: SRC, fleet_id: o.fleet, mode,
      window_start: from, window_end: to, rows_written: s.written, chunks });
    log.info(SRC, `done (${o.fleet})`, { trips: s.trips.total, perf: s.perf.total,
      fares: s.fares.total, quality: s.qual.total,
      windows_failed: s.trips.chunks.filter((c) => c.error).length, of: s.trips.chunks.length });
  }
}
