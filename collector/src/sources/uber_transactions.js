/* UBER'S LIVE PER-TRIP MONEY — POST /v1/vehicle-suppliers/transactions.
   ═════════════════════════════════════════════════════════════════════════
   THE NEED. Uber's per-trip money reached this product by two routes: the
   fare walk (REPORT_TYPE_PAYMENTS_ORDER, src/sources/uber.js), which runs
   hourly but waits on Uber — a ride's fare is published hours after it, 4 h
   one night and 15 h the next (measured 2026-10-07/08) — and the weekly
   statements. So today is the one day whose Uber bookings carry no price, and
   every page reading today either projects Uber's money (src/day_routes'
   expected_revenue) or shows a dash: at 20:07 Dubai on 2026-09-08, 0 of 596.

   Uber documents a live feed of exactly that money, per transaction, at
   sub-minute freshness, on the scope src/config.js already requests. It was
   recorded three times in this codebase as "serves nothing" — our verb, then
   our parameter shape, then our clock (docs/COVERAGE.md "Uber's live per-trip
   feed WORKS — the request shape, measured 2026-09-10"). Nothing collected it.

   THE ONE SHAPE IT ANSWERS (each part was named by a refusal; see COVERAGE):
     POST https://api.uber.com/v1/vehicle-suppliers/transactions?org_id=<org>
     {"filters":[{"field":"timeRange","operator":"FILTER_OPERATOR_IN_RANGE",
                  "value":["<epoch ms, as a STRING>","<epoch ms, as a STRING>"]}],
      "pagination_options":{"page_size":50}}
   A range of at most 15 minutes, starting no more than 24 hours back and
   ending at least 5 minutes ago; 1 request a second, 429 beyond it.

   WHAT A ROW CARRIES, measured on production 2026-11-12 through
   /api/probe/uber/realtime (structure only; nothing personal was printed):
     driverInfo      { driverUuid, firstName, lastName }
     transactionInfo { transactionUuid, tripUuid, processedAt (ISO),
                       description: TRIP | PERSONAL_TRANSPORT,
                       breakDowns: [{ categoryName, categoryLabel,
                                      amount: { amountE5 (an integer NUMBER),
                                                currencyCode: 'AED' },
                                      children: [ ...same, or null ] }] }
   and the response's top level holds two keys, of 12 and 16 characters —
   `transactions` and `paginationResult`, the envelope every other Uber REST
   surface here uses. breakDowns is the same category tree the weekly statement
   and the payments report carry (schema_v117.sql draws it), so the fare this
   feed reports is the same quantity trip.price already holds: the BRANCH.

   WHAT THIS DOES WITH IT. Every quarter hour, per org, it walks the
   15-minute windows of the last N hours (UBER_TXN_HOURS, default 6, capped at
   Uber's 24), pages through each, and stores every transaction in
   uber_live_transaction keyed on Uber's own id — so asking the same window
   again rewrites rather than duplicates. Then it fills trip.price, and ONLY
   where nothing better exists: a NULL price, or a price this feed wrote
   itself. A price from the payments report, or from the channel's own row, is
   never touched; trip.price_source records which is which, and the fare walk
   now stamps its own (src/sources/uber.js FARE_WRITE_SQL), so the moment the
   statement-grade figure lands it replaces the provisional one.

   WHY THE WHOLE SIX HOURS, EVERY TIME, and not a cursor. The worker restarts
   on every deploy, a tick can be throttled, and Uber stamps a transaction when
   it is PROCESSED: re-asking six hours each pass means a missed tick, a
   restart or a late-processed transaction costs nothing, at a price that is
   measured rather than guessed — 24 windows per org, about 53 seconds of
   paced requests per run for both fleets. It can never backfill: nothing older
   than 24 hours is reachable, and the payments walk remains the record. */
import { config, loadSettings } from '../config.js';
import { http, sleep as realSleep } from '../http.js';
import { pool, logRun } from '../db.js';
import { log as defaultLog } from '../log.js';
import { uberOAuthToken } from '../auth/uber.js';
import { noteUberRest } from '../auth_state.js';
import { withPinnedSettings, getInt } from '../settings.js';
import { dubaiIso } from '../util.js';

export const SRC = 'uber_transactions';
/* 'realtime', and the reason is the response cache, not taste.
   ─────────────────────────────────────────────────────────────────────────
   api/cache.js moves every cached answer's version on the latest finish of any
   collection_run EXCEPT mode 'realtime' — CABMAN's five-minute tick, excluded
   after it was measured as most of the database's load on 2026-09-29: each
   version move restarts the warmer's 89 aggregates (519–1,050 s a pass), so a
   tick that finishes every few minutes keeps the database busy for ever.
   This one finishes four times an hour, between the rollups (:15, :45) and the
   incrementals (:00, :30) that already move the version. As any other mode it
   would roughly double the moves; as 'realtime' it moves none, and a price it
   fills reaches the cached pages with the next pass that does: a rollup (:15,
   :45) or an incremental (:00, :30) STARTS eight minutes after each of this
   tick's minutes (pinned in test/uber_transactions.test.mjs), so with that
   pass's own length a filled price is on the cached pages within about a
   quarter of an hour. Uncached readers (/api/status, the live views) see it at
   once. No reader keys on this mode other than the cache (grep "'realtime'"). */
export const MODE = 'realtime';
export const TXN_URL = 'https://api.uber.com/v1/vehicle-suppliers/transactions';
export const WINDOW_MS = 15 * 60_000;
/* Uber refuses a range that is not at least five minutes old — "a window
   ending at now → invalid start time" (COVERAGE). Six, as /api/probe/uber/
   realtime has asked since that round, so a second of clock skew is not a
   refusal. */
export const LAG_MS = 6 * 60_000;
export const LOOKBACK_CAP_HOURS = 24;
/* The oldest window must still be inside 24 hours when it is ASKED, not when
   the walk was planned: newest-first, a 24-hour walk reaches its oldest window
   about two minutes after it starts, and further on a throttled day. */
export const LOOKBACK_MARGIN_MS = 10 * 60_000;
export const DEFAULT_HOURS = 6;
/* 50: the value the one shape that answered was measured with. Uber documents
   1–500, but the sibling earners/payments surface answers an over-large page
   with 200 and an EMPTY list (src/sources/uber_fleet.js EARNER_PAGE), so the
   page size stays at the number known to work and the walk pages instead. */
export const PAGE_SIZE = 50;
export const MAX_PAGES = 20;
/* The documented rate limit is one request a second; a sixth attempt fired
   back-to-back drew 429 TooManyRequests (COVERAGE). 1.1 s between requests,
   across both orgs, because the two fleets are walked one after the other by
   one process and whether Uber counts per client or per caller is unknown. */
export const PACE_MS = 1100;
/* On a 429: wait (Retry-After when Uber names it, capped), then try the same
   window again, three times. Still refused, the org's walk stops for this run
   — every window it did not ask is inside the next run's six hours, so a stop
   costs a quarter hour, and pressing on would only collect more 429s. */
export const BACKOFF_MS = [2_000, 5_000, 15_000];
export const RETRY_AFTER_CAP_MS = 60_000;
/* Two windows in a row refused with the same kind of 4xx (a 400 naming a
   field, a 404) mean the request is wrong, not the window: the rest of the run
   would collect the same refusal 22 more times. */
export const STOP_AFTER_REFUSALS = 2;
/* A freshness tier, not a record: after the payments walk has priced a trip
   the row is only worth keeping as the check that the two agree. 90 days of
   that is ~90,000 rows across both fleets. */
export const KEEP_DAYS = 90;

/* ── the windows ───────────────────────────────────────────────────────── */
export function clampHours(h) {
  const n = Number(h);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_HOURS;
  return Math.min(LOOKBACK_CAP_HOURS, Math.max(0.25, n));
}

/* The windows a run asks for, NEWEST FIRST.

   Aligned to the quarter hour (:00, :15, :30, :45 UTC), so two runs ask for
   the same windows and a window's outcome means the same thing on every pass;
   a window anchored on "now" would differ every run. The newest is the last
   quarter-hour boundary at least LAG_MS old.

   Each window spans 15 minutes LESS ONE MILLISECOND — [start, start + 15 min
   − 1 ms]. Uber documents "at most 15 minutes" and does not say whether its
   test is > or ≥; a span of 899,999 ms is legal under both readings, and the
   windows still tile the clock without a gap if the range is inclusive at
   both ends, which an IN_RANGE filter over two instants usually is. The only
   cost under a half-open reading is the final millisecond of each quarter
   hour.

   Newest first because the freshest money is the point of this feed: a run
   cut short by a throttle has still priced the trips that just ended. */
export function txnWindows(now = new Date(), hours = DEFAULT_HOURS) {
  const t = +new Date(now);
  const h = clampHours(hours);
  const lastEnd = Math.floor((t - LAG_MS) / WINDOW_MS) * WINDOW_MS;
  const floor = Math.max(lastEnd - h * 3600e3,
    t - LOOKBACK_CAP_HOURS * 3600e3 + LOOKBACK_MARGIN_MS);
  const out = [];
  for (let end = lastEnd; end - WINDOW_MS >= floor; end -= WINDOW_MS) {
    out.push({ start: new Date(end - WINDOW_MS), end: new Date(end - 1) });
  }
  return out;
}

/* The newest legal window inside [from, to], or null when there is none —
   which is the honest answer for a probe asked about a day this feed cannot
   serve (older than 24 hours), rather than a request Uber would refuse. */
export function latestLegalWindow({ from = null, to = null, now = new Date() } = {}) {
  const t = +new Date(now);
  const cap = to == null ? t : Math.min(t, +new Date(to) + LAG_MS);
  const [w] = txnWindows(new Date(cap), 0.25);
  if (!w) return null;
  if (+w.start < t - LOOKBACK_CAP_HOURS * 3600e3 + LOOKBACK_MARGIN_MS) return null;
  if (from != null && +w.start < +new Date(from)) return null;
  return w;
}

/* ── the request ───────────────────────────────────────────────────────── */
/* Snake_case envelope, epoch MILLISECONDS as STRINGS, the prefixed enum: each
   of those was the correction a refusal named (COVERAGE's table). The page
   token goes back as `page_token`, the snake_case of the envelope it sits in;
   the response's cursor is read below from the camelCase envelope Uber
   answers in, as src/sources/uber.js reads drivers/actions'. */
export function txnRequestBody(start, end, pageToken = '') {
  return {
    filters: [{ field: 'timeRange', operator: 'FILTER_OPERATOR_IN_RANGE',
      value: [String(+new Date(start)), String(+new Date(end))] }],
    pagination_options: { page_size: PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) },
  };
}
export const txnUrl = (org) => `${TXN_URL}?org_id=${encodeURIComponent(org)}`;

const listOf = (data) => {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.transactions)) return data.transactions;
  for (const v of Object.values(data)) {
    if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v;
  }
  return [];
};
const nextToken = (data) => String(data?.paginationResult?.nextPageToken
  || data?.pagination_result?.next_page_token || data?.nextPageToken || '');

/* Retry-After is seconds or an HTTP date; either way capped, because a header
   asking for an hour would hold the tick past the next three. */
export function retryAfterMs(headers, nowMs = Date.now()) {
  const v = typeof headers?.get === 'function' ? headers.get('retry-after') : headers?.['retry-after'];
  if (v == null || v === '') return null;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - nowMs;
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.min(ms, RETRY_AFTER_CAP_MS);
}

/* Uber's own words, which on this surface are the whole diagnosis: every
   correction of the request shape came from reading them. */
const refusalText = (res) => {
  const d = res?.data;
  const said = d && typeof d === 'object'
    ? (d.message || d.error_description || d.error || d.code || d.errors?.[0]?.message || null)
    : (typeof d === 'string' ? d.trim().slice(0, 120) : null);
  return `${res?.status ?? '?'} from Uber${said ? ` — ${String(said).slice(0, 200)}` : ''}`;
};

/* One request at a time, at least `gapMs` apart. `clock` and `sleep` are
   parameters so a test can run a day of pacing in no time. */
export function pacer(sleep = realSleep, gapMs = PACE_MS, clock = Date.now) {
  let last = 0;
  return async () => {
    const wait = last ? last + gapMs - clock() : 0;
    if (wait > 0) await sleep(wait);
    last = clock();
  };
}

/* ── the money in a row ────────────────────────────────────────────────── */
/* amountE5 is an integer count of hundred-thousandths. Kept as an integer
   until the moment it is written, so a sum is exact and nothing is rounded on
   the way in; written as a decimal string, which Postgres reads exactly. */
const e5Int = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return /^-?\d{1,15}$/.test(s) ? Number(s) : null;
};
export const e5ToDec = (n) => {
  if (n == null || !Number.isFinite(n)) return null;
  const s = String(Math.abs(n)).padStart(6, '0');
  return `${n < 0 ? '-' : ''}${s.slice(0, -5)}.${s.slice(-5)}`;
};

/* The tree flattened to path → amount (e5 integers), e.g.
   'paid_to_you.your_earnings.fare' → 4694000. Two siblings with one name are
   summed rather than one overwriting the other. */
export function flattenBreakdown(nodes, prefix = '', out = { amounts: {}, currency: null, mixed: false }, depth = 0) {
  if (!Array.isArray(nodes) || depth > 8) return out;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const name = String(n.categoryName ?? n.category ?? n.name ?? '').trim();
    if (!name) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    const amt = e5Int(n.amount?.amountE5 ?? n.amountE5);
    if (amt != null) out.amounts[path] = (out.amounts[path] ?? 0) + amt;
    const cur = n.amount?.currencyCode ?? n.currencyCode ?? null;
    if (cur) {
      if (out.currency && out.currency !== cur) out.mixed = true;
      out.currency = out.currency || cur;
    }
    flattenBreakdown(n.children ?? n.breakDowns ?? null, path, out, depth + 1);
  }
  return out;
}

/* A node by its full path, else the SHALLOWEST node of that name — so a tree
   that nests one level differently still yields its fare, while a deeper node
   that happens to share a name never outranks the real one. */
const named = (amounts, full, leaf) => {
  if (amounts[full] != null) return amounts[full];
  let best = null, depth = Infinity;
  for (const [k, v] of Object.entries(amounts)) {
    const d = k.split('.').length;
    if ((k === leaf || k.endsWith(`.${leaf}`)) && d < depth) { best = v; depth = d; }
  }
  return best;
};

/* A ride, a correction to one, the wire, or something this product has not
   met. Only a ride's fare is a trip's price — the payments walk's rule
   (orderKind in src/sources/uber.js): an adjustment is real money and is kept,
   but adding it to the fare would make the fare differ from what the rider
   was charged. An unknown description is kept and named in the run's log
   rather than guessed into the fare. */
export function txnKind(description) {
  const d = String(description || '').toLowerCase();
  if (d.includes('adjust')) return 'adjustment';
  if (d.includes('payout')) return 'payout';
  if (/trip|transport|order|ride/.test(d)) return 'trip';
  return 'other';
}

/* One transaction as Uber sent it → one row of uber_live_transaction, or null
   when it carries no id or no time (a row that cannot be keyed or windowed
   cannot be kept honestly). Names are never read. */
export function parseTransaction(t, fleet) {
  const info = t?.transactionInfo;
  const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
  const uuid = clean(info?.transactionUuid);
  if (!uuid) return null;
  const at = info?.processedAt ? new Date(info.processedAt) : null;
  if (!at || !Number.isFinite(+at)) return null;
  const flat = flattenBreakdown(info.breakDowns);
  const a = flat.amounts;
  const pick = (full, leaf) => e5ToDec(named(a, full, leaf));
  return {
    transaction_uuid: uuid,
    trip_uuid: clean(info.tripUuid),
    fleet_id: fleet,
    driver_ext_id: clean(t?.driverInfo?.driverUuid),
    processed_at: at.toISOString(),
    description: clean(info.description),
    kind: txnKind(info.description),
    currency: flat.mixed ? null : flat.currency,
    paid_to_you: pick('paid_to_you', 'paid_to_you'),
    your_earnings: pick('paid_to_you.your_earnings', 'your_earnings'),
    /* The BRANCH, never the leaf in its place: a leaf-for-branch fallback is
       the defect PAY_COLS in src/sources/uber.js records — every ride with a
       wait or a surge priced short. A row without the branch fills nothing;
       the payments walk prices it later. */
    fare: pick('paid_to_you.your_earnings.fare', 'fare'),
    fare_base: pick('paid_to_you.your_earnings.fare.little_fare', 'little_fare'),
    service_fee: pick('paid_to_you.your_earnings.service_fee', 'service_fee'),
    taxes: pick('paid_to_you.your_earnings.taxes_earnings', 'taxes_earnings'),
    tip: pick('paid_to_you.your_earnings.tip', 'tip'),
    cash_collected: pick('paid_to_you.trip_balance.payouts.cash_collected', 'cash_collected'),
    /* A STRING, not an object: node-postgres binds a JS array as a Postgres
       array literal and a JSONB column refuses it (COVERAGE trap "A JS ARRAY
       bound to a JSONB column passes on PGlite and fails on production"). The
       whole batch travels as one JSON text below; this stays plain data. */
    categories: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, Number(e5ToDec(v))])),
  };
}

/* ── one window, every page ────────────────────────────────────────────── */
export async function fetchWindow({ url, token, w, httpImpl = http, sleep = realSleep,
  pace = async () => {}, clock = Date.now }) {
  const raw = [];
  const backoffs = [];
  let pageToken = '', pages = 0, lastKey = null, res = null;
  for (;;) {
    const body = JSON.stringify(txnRequestBody(w.start, w.end, pageToken));
    let tries = 0;
    for (;;) {
      await pace();
      try {
        res = await httpImpl(url, { method: 'POST', body, timeoutMs: 30_000, retries: 0,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
      } catch (e) {
        return { raw, pages, res: null, backoffs, network: true,
          error: `the request did not complete: ${String(e?.message || e).slice(0, 160)}` };
      }
      /* Backing off on a 429 is the whole point of handling it here rather
         than in http(): http()'s own retry would wait 1–8 s and then hand back
         the refusal as though the window had been answered. */
      if (res.status === 429 && tries < BACKOFF_MS.length) {
        const wait = retryAfterMs(res.headers, clock()) ?? BACKOFF_MS[tries];
        backoffs.push(wait); tries += 1;
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && tries < 1) { tries += 1; await sleep(BACKOFF_MS[0]); continue; }
      break;
    }
    if (res.status === 429) {
      return { raw, pages, res, backoffs, throttled: true,
        error: `rate-limited by Uber (429) after ${backoffs.length} back-offs `
          + `(${backoffs.map((b) => `${Math.round(b / 1000)} s`).join(', ')})` };
    }
    if (res.status < 200 || res.status >= 300) return { raw, pages, res, backoffs, error: refusalText(res) };
    const data = res.data === '' ? {} : res.data;
    if (!data || typeof data !== 'object') {
      return { raw, pages, res, backoffs,
        error: `answered ${res.status} with text, not JSON: ${String(data).slice(0, 80)}` };
    }
    const page = listOf(data);
    /* A cursor the server ignores returns page one again: the ids repeat, and
       the walk stops and says so rather than looping. Only a FULL first page
       can hide more rows behind an ignored cursor, so only that is an error. */
    const key = page.map((x) => x?.transactionInfo?.transactionUuid).join(',');
    if (key && key === lastKey) {
      return { raw, pages, res, backoffs, cursorIgnored: true,
        error: page.length >= PAGE_SIZE
          ? `Uber returned the same page for the next cursor — this window holds more than ${PAGE_SIZE} `
            + 'transactions and the rest were not read' : null };
    }
    lastKey = key;
    raw.push(...page);
    pages += 1;
    pageToken = nextToken(data);
    if (!pageToken || !page.length) return { raw, pages, res, backoffs };
    if (pages >= MAX_PAGES) {
      return { raw, pages, res, backoffs, truncated: true,
        error: `more than ${MAX_PAGES} pages of ${PAGE_SIZE} — the rest of this window was not read` };
    }
  }
}

/* ── storing ───────────────────────────────────────────────────────────── */
/* One statement per batch, the batch as ONE JSON text expanded server-side, so
   both PGlite and node-postgres bind a string. The guard on the update is the
   house rule for re-asked data (src/db.js upsert): a re-walk that changes
   nothing writes nothing, and RETURNING counts only what was written —
   node-postgres' rowCount and PGlite's affectedRows disagree (COVERAGE). */
export const STORE_SQL = `
  INSERT INTO uber_live_transaction AS u
    (transaction_uuid, trip_uuid, fleet_id, driver_ext_id, processed_at, description, kind,
     currency, paid_to_you, your_earnings, fare, fare_base, service_fee, taxes, tip,
     cash_collected, categories)
  SELECT x.transaction_uuid, x.trip_uuid, x.fleet_id, x.driver_ext_id, x.processed_at,
         x.description, x.kind, x.currency, x.paid_to_you, x.your_earnings, x.fare,
         x.fare_base, x.service_fee, x.taxes, x.tip, x.cash_collected,
         coalesce(x.categories, '{}'::jsonb)
    FROM jsonb_to_recordset($1::jsonb) AS x(
         transaction_uuid text, trip_uuid text, fleet_id text, driver_ext_id text,
         processed_at timestamptz, description text, kind text, currency text,
         paid_to_you numeric, your_earnings numeric, fare numeric, fare_base numeric,
         service_fee numeric, taxes numeric, tip numeric, cash_collected numeric,
         categories jsonb)
  ON CONFLICT (transaction_uuid) DO UPDATE SET
    trip_uuid = EXCLUDED.trip_uuid, fleet_id = EXCLUDED.fleet_id,
    driver_ext_id = EXCLUDED.driver_ext_id, processed_at = EXCLUDED.processed_at,
    description = EXCLUDED.description, kind = EXCLUDED.kind, currency = EXCLUDED.currency,
    paid_to_you = EXCLUDED.paid_to_you, your_earnings = EXCLUDED.your_earnings,
    fare = EXCLUDED.fare, fare_base = EXCLUDED.fare_base, service_fee = EXCLUDED.service_fee,
    taxes = EXCLUDED.taxes, tip = EXCLUDED.tip, cash_collected = EXCLUDED.cash_collected,
    categories = EXCLUDED.categories, updated_at = now()
  WHERE (u.trip_uuid, u.fleet_id, u.driver_ext_id, u.processed_at, u.description, u.kind,
         u.currency, u.paid_to_you, u.your_earnings, u.fare, u.fare_base, u.service_fee,
         u.taxes, u.tip, u.cash_collected, u.categories)
     IS DISTINCT FROM
        (EXCLUDED.trip_uuid, EXCLUDED.fleet_id, EXCLUDED.driver_ext_id, EXCLUDED.processed_at,
         EXCLUDED.description, EXCLUDED.kind, EXCLUDED.currency, EXCLUDED.paid_to_you,
         EXCLUDED.your_earnings, EXCLUDED.fare, EXCLUDED.fare_base, EXCLUDED.service_fee,
         EXCLUDED.taxes, EXCLUDED.tip, EXCLUDED.cash_collected, EXCLUDED.categories)
  RETURNING (xmax = 0) AS inserted`;

export async function storeTransactions(q, rows) {
  /* ON CONFLICT DO UPDATE refuses to touch one row twice in one statement,
     and overlapping pages can carry a transaction twice. Last copy wins. */
  const uniq = [...new Map(rows.map((r) => [r.transaction_uuid, r])).values()];
  if (!uniq.length) return { written: 0, inserted: 0 };
  const out = await q(STORE_SQL, [JSON.stringify(uniq)]);
  return { written: out.length, inserted: out.filter((r) => r.inserted).length };
}

/* ── filling trip.price, only where nothing better exists ──────────────── */
/* THE RULE, and why each clause is there.
   ─────────────────────────────────────────────────────────────────────────
   • UPDATE, never INSERT. A transaction whose Trip UUID we do not hold is a
     trip the trip export has not landed yet; inventing a row for it would make
     a booking with no time, plate or driver that every count would include
     (the fare walk's rule, src/sources/uber.js). It is counted as `unmatched`
     and filled on a later pass, once the half-hourly export brings the trip.
   • `price IS NULL OR price_source = 'uber_live'`. The feed may write where
     there is nothing, and may correct what it wrote itself (a ride's fare
     restated in a later transaction). A price from the payments report
     ('uber_payments') is statement-grade; a price with no stated source came
     from the channel's own row or from the payments walk before v117. Both
     outrank this feed, and neither is touched.
   • The fare of RIDE transactions only, summed over every transaction stored
     for the trip — not just this run's — so a fare does not shrink to the
     part of it a later window happened to see.
   • `IS DISTINCT FROM`, so a re-walk that learns nothing writes nothing.
   • The same fleet on both sides, as the fare walk matches: a credential
     confusion must never move one fleet's money onto the other's trip.
   The counts come from a snapshot of the trips taken in the same statement
   (every part of a WITH sees one snapshot), so `filled` and `revised` say what
   the price WAS, not what this statement made it. */
export const FILL_SQL = `
  WITH touched AS (
    SELECT DISTINCT trip_uuid FROM uber_live_transaction
     WHERE fleet_id = $1 AND processed_at >= $2::timestamptz AND trip_uuid IS NOT NULL),
  live AS (
    SELECT x.trip_uuid,
           round(sum(x.fare) FILTER (WHERE x.kind = 'trip'), 2) AS fare,
           min(x.currency) FILTER (WHERE x.kind = 'trip') AS currency
      FROM uber_live_transaction x JOIN touched USING (trip_uuid)
     WHERE x.fleet_id = $1
     GROUP BY x.trip_uuid),
  prior AS (
    SELECT t.external_id, t.price, t.price_source
      FROM trip t JOIN live l ON l.trip_uuid = t.external_id
     WHERE t.platform = 'uber' AND t.fleet_id = $1),
  wrote AS (
    UPDATE trip t
       SET price = l.fare,
           currency = coalesce(t.currency, l.currency, 'AED'),
           price_source = 'uber_live'
      FROM live l
     WHERE t.platform = 'uber' AND t.fleet_id = $1 AND t.external_id = l.trip_uuid
       AND l.fare IS NOT NULL
       AND (t.price IS NULL OR t.price_source = 'uber_live')
       AND t.price IS DISTINCT FROM l.fare
    RETURNING t.external_id)
  SELECT
    (SELECT count(*) FROM live)::int AS trips,
    (SELECT count(*) FROM live WHERE fare IS NULL)::int AS no_fare,
    (SELECT count(*) FROM live l
      WHERE NOT EXISTS (SELECT 1 FROM prior p WHERE p.external_id = l.trip_uuid))::int AS unmatched,
    (SELECT count(*) FROM wrote w JOIN prior p USING (external_id) WHERE p.price IS NULL)::int AS filled,
    (SELECT count(*) FROM wrote w JOIN prior p USING (external_id) WHERE p.price IS NOT NULL)::int AS revised,
    (SELECT count(*) FROM prior p JOIN live l ON l.trip_uuid = p.external_id
      WHERE l.fare IS NOT NULL AND p.price IS NOT NULL
        AND p.price_source IS DISTINCT FROM 'uber_live')::int AS held`;

/* Over every transaction processed in the last 26 hours, not only this run's:
   a trip whose export landed after the run that saw its money is filled by
   the next pass, whatever that pass fetched. */
export async function fillTripMoney(q, fleet, now = new Date()) {
  const since = new Date(+new Date(now) - (LOOKBACK_CAP_HOURS + 2) * 3600e3).toISOString();
  const [r] = await q(FILL_SQL, [fleet, since]);
  return r || { trips: 0, no_fare: 0, unmatched: 0, filled: 0, revised: 0, held: 0 };
}

export async function pruneTransactions(q, fleet, now = new Date()) {
  const before = new Date(+new Date(now) - KEEP_DAYS * 864e5).toISOString();
  const out = await q(`DELETE FROM uber_live_transaction
                        WHERE fleet_id = $1 AND processed_at < $2::timestamptz
                        RETURNING transaction_uuid`, [fleet, before]);
  return out.length;
}

/* ── what /api/status shows ────────────────────────────────────────────── */
/* The windows that were ASKED, oldest first, with neighbours of the same
   outcome merged: a healthy run is one row reading "04:00 → 10:00, 312
   transactions", and a refusal names its own quarter hour and its words.
   Windows a stopped run never asked are not windows that failed — they are
   the next run's — so they are counted in the run's error sentence and left
   out of the list, as the fare walk leaves out the weeks after a throttle.
   Merging also keeps collection_run.detail small at 96 runs a fleet a day. */
const stamp = (d) => new Date(d).toISOString().replace(/\.000Z$/, 'Z');
export function compactChunks(asked) {
  const sorted = [...asked].sort((a, b) => a.w.start - b.w.start);
  const out = [];
  for (const x of sorted) {
    const prev = out[out.length - 1];
    const err = x.error || null;
    if (prev && prev.error === err && +prev._end === +x.w.start) {
      prev.rows += x.rows; prev._end = new Date(+x.w.end + 1); prev.to = stamp(prev._end);
    } else {
      const end = new Date(+x.w.end + 1);
      out.push({ from: stamp(x.w.start), to: stamp(end), rows: x.rows, error: err, _end: end });
    }
  }
  return out.map(({ _end, ...c }) => c);
}

/* ── one org ───────────────────────────────────────────────────────────── */
const hostOf = (u) => { try { return new URL(u).host; } catch { return null; } };

async function collectOrg({ o, db, q, now, hours, httpImpl, tokenFor, noteRest, sleep, pace, clock, log }) {
  const windows = txnWindows(now, hours);
  const asked = [];
  /* Two separate runs of bad luck, counted apart: the same 4xx twice in a row
     (the request is wrong), and three windows in a row with no answer at all
     (the network or Uber is down). A good window resets both. */
  let notAsked = 0, stop = null, noted = false;
  let sameRefusal = 0, lastRefusal = null, noAnswer = 0;
  const received = [];

  let token;
  try {
    token = await tokenFor(o);
  } catch (e) {
    /* The grant records its own credential row (src/auth/uber.js); what the
       run records is that nothing was asked, and why. */
    const error = `no OAuth token for ${o.fleet}: ${String(e?.message || e).slice(0, 200)}`;
    await logRun({ source: SRC, fleet_id: o.fleet, mode: MODE, status: 'error', rows_written: 0,
      window_start: windows.length ? dubaiIso(windows[windows.length - 1].start) : null,
      window_end: windows.length ? dubaiIso(windows[0].end) : null, error }, db);
    log.error(SRC, `${o.fleet}: no token`, { err: error.slice(0, 160) });
    return { fleet: o.fleet, status: 'error', error };
  }
  const url = txnUrl(o.org);

  for (const w of windows) {
    if (stop) { notAsked += 1; continue; }
    const r = await fetchWindow({ url, token, w, httpImpl, sleep, pace, clock });
    const item = { w, rows: r.raw.length, error: r.error || null };
    received.push(...r.raw);
    asked.push(item);

    /* The credential row, written from a response that can speak for it: the
       first answer of the run, and any refusal shaped like a credential one.
       NEVER a 429 or a 5xx — authFailure reads a text body as "answered with
       text, not JSON" and files it as an expired session, which would turn a
       rate limit into a red credential banner. */
    const authShaped = r.res && (r.res.status === 401 || r.res.status === 403
      || (r.res.finalUrl && hostOf(r.res.finalUrl) !== hostOf(url)));
    const firstGood = r.res && !noted && r.res.status >= 200 && r.res.status < 300;
    if (authShaped || firstGood) {
      let bad = null;
      try { bad = await noteRest(db, url, r.res, o, 'transactions', token); } catch (e) {
        log.warn(SRC, `${o.fleet}: credential note failed`, { err: String(e).slice(0, 120) });
      }
      noted = true;
      if (bad) { item.error = bad.reason || item.error; stop = { why: bad.reason || 'refused' }; continue; }
    }
    if (authShaped && !stop) { stop = { why: item.error }; continue; }

    if (r.throttled) {
      stop = { why: `Uber rate-limited this run (429) at ${stamp(w.start).slice(11, 16)} UTC` };
      continue;
    }
    const status = r.res?.status ?? null;
    if (r.error && status != null && status >= 400 && status < 500) {
      sameRefusal = lastRefusal === status ? sameRefusal + 1 : 1;
      lastRefusal = status;
      noAnswer = 0;
      if (sameRefusal >= STOP_AFTER_REFUSALS) {
        stop = { why: `Uber refused ${sameRefusal} windows in a row (${r.error.slice(0, 120)}) — `
          + 'the request or the clock is wrong, not the window' };
      }
      continue;
    }
    if (r.network || (status != null && status >= 500)) {
      noAnswer += 1;
      sameRefusal = 0; lastRefusal = null;
      if (noAnswer >= 3) stop = { why: `three windows in a row did not answer (${String(r.error).slice(0, 120)})` };
      continue;
    }
    /* Answered: a whole window, or one that answered and could not be read to
       its end (a truncated or cursor-ignoring window keeps what it read and
       says so in its own error). Either way Uber is talking to us. */
    sameRefusal = 0; lastRefusal = null; noAnswer = 0;
  }

  /* Rows that cannot be keyed or timed are counted, never guessed. All of a
     non-empty answer unreadable is a shape change, and it fails the run: a
     collector that stores nothing and reports success is the silence this
     product exists to refuse (src/sources/uber_fleet.js says the same of its
     earner records). */
  const rows = received.map((t) => parseTransaction(t, o.fleet)).filter(Boolean);
  const unreadable = received.length - rows.length;
  const store = await storeTransactions(q, rows);
  let fill = null, fillError = null;
  try { fill = await fillTripMoney(q, o.fleet, now); } catch (e) {
    fillError = `the trips were not priced: ${String(e?.message || e).slice(0, 160)}`;
  }
  let pruned = 0;
  try { pruned = await pruneTransactions(q, o.fleet, now); } catch { /* retried next run */ }

  const failed = asked.filter((x) => x.error);
  const kinds = {};
  for (const r of rows) kinds[r.description || '(none)'] = (kinds[r.description || '(none)'] || 0) + 1;
  const sentences = [];
  if (failed.length) {
    sentences.push(`${failed.length} of ${asked.length} windows refused: ${failed[0].error.slice(0, 160)}`);
  }
  if (notAsked) {
    sentences.push(`${notAsked} of ${windows.length} windows not asked — ${stop?.why || 'the walk stopped'}; `
      + 'asked again at the next quarter hour');
  }
  if (unreadable) {
    sentences.push(`${unreadable} of ${received.length} transactions had no id or no time and were not kept`);
  }
  if (fillError) sentences.push(fillError);
  const shapeBroken = received.length > 0 && rows.length === 0;
  const status = shapeBroken || (asked.length && failed.length === asked.length) ? 'error'
    : (sentences.length ? 'partial' : 'ok');
  const chunks = compactChunks(asked);
  await logRun({ source: SRC, fleet_id: o.fleet, mode: MODE, status,
    window_start: windows.length ? dubaiIso(windows[windows.length - 1].start) : null,
    window_end: windows.length ? dubaiIso(windows[0].end) : null,
    rows_written: store.written, error: sentences.length ? sentences.join('; ').slice(0, 300) : null,
    chunks }, db);
  const summary = { fleet: o.fleet, status, windows: windows.length, asked: asked.length,
    failed: failed.length, not_asked: notAsked, received: received.length, stored: rows.length,
    written: store.written, inserted: store.inserted, unreadable, pruned,
    ...(fill || {}), kinds };
  log[status === 'ok' ? 'info' : 'warn'](SRC, `live money ${o.fleet}`, summary);
  return summary;
}

/* ── one run, every org ────────────────────────────────────────────────── */
/* Every seam a test needs is a parameter, defaulted to production: the HTTP
   client, the token, the credential note (which itself calls Uber's org list
   on a 403), the clock and the sleep. */
export async function collect({ db = pool, now = null, hours = null, fleet = null,
  orgs = null, httpImpl = http, tokenFor = (o) => uberOAuthToken(o), noteRest = noteUberRest,
  sleep = realSleep, clock = Date.now, log = defaultLog } = {}) {
  const q = (t, p) => db.query(t, p).then((r) => r.rows);
  const h = clampHours(hours ?? getInt('UBER_TXN_HOURS', DEFAULT_HOURS));
  const list = (orgs ?? config.uber.oauthOrgs ?? []).filter((o) => !fleet || o.fleet === fleet);
  if (!list.length) {
    const skipped = 'no Uber fleet has both an OAuth client and an encrypted org id '
      + '(UBER_ORG_ENCRYPTED / UBER_ORG_ENCRYPTED_EGARI)';
    log.info(SRC, `skipped — ${skipped}`);
    return { skipped };
  }
  const pace = pacer(sleep, PACE_MS, clock);
  const fleets = [];
  for (const o of list) {
    /* One fleet's failure is that fleet's: an Egari refusal must not cost
       Ecosine its run (the rule src/sources/uber.js pullLive states). */
    try {
      fleets.push(await collectOrg({ o, db, q, now: now ?? new Date(clock()), hours: h, httpImpl,
        tokenFor, noteRest, sleep, pace, clock, log }));
    } catch (e) {
      const error = String(e?.message || e).slice(0, 300);
      log.error(SRC, `${o.fleet}: run failed`, { err: error.slice(0, 200) });
      await logRun({ source: SRC, fleet_id: o.fleet, mode: MODE, status: 'error', rows_written: 0, error }, db)
        .catch(() => {});
      fleets.push({ fleet: o.fleet, status: 'error', error });
    }
  }
  return { hours: h, fleets };
}

/* The scheduled tick (src/index.js, 7,22,37,52 past each hour). One at a
   time: a run held up by back-offs must not have the next quarter hour start a
   second walk beside it at the same rate limit. */
let running = false;
export async function liveMoneyTick(opts = {}) {
  if (running) {
    defaultLog.info(SRC, 'tick skipped — the previous run is still going');
    return { skipped: 'the previous run is still going' };
  }
  running = true;
  try {
    return await withPinnedSettings(async () => { await loadSettings(); return collect(opts); });
  } catch (e) {
    defaultLog.error(SRC, 'tick failed', { err: String(e?.message || e).slice(0, 200) });
    return { error: String(e?.message || e) };
  } finally { running = false; }
}

/* ── the probe's question, asked the way the feed answers ─────────────── */
/* src/probe.js (nightly) and /api/probe/uber/rest + /window asked this surface
   with GET and recorded the 404 as "the provider serves nothing" — three
   probes, one wrong verb. They ask through here now, with the collector's own
   request builder, so the probe and the collector cannot drift into describing
   two different requests. The newest legal window inside [from, to] (default:
   the last 24 hours); null `window` and no request when there is none. */
export async function probeTransactions({ org, token = null, from = null, to = null,
  now = new Date(), httpImpl = http } = {}) {
  const w = latestLegalWindow({ from, to, now });
  if (!w) return { data: null, status: null, window: null };
  const tok = token ?? await uberOAuthToken();
  const { data, status } = await httpImpl(txnUrl(org), {
    method: 'POST', timeoutMs: 45_000, retries: 0,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify(txnRequestBody(w.start, w.end)),
  });
  return { data: withholdNames(data), status, window: [w.start.toISOString(), w.end.toISOString()] };
}

/* THE PROBES DESCRIBE WHAT THEY RECEIVE, and describe() prints a field's
   values whenever it has a dozen or fewer of them (src/probe.js MAX_VALUES).
   A quiet quarter hour carries two or three drivers, so the nightly probe —
   which stores that description in provider_probe.fields, served by the
   /api/probe pages — would have started keeping drivers' first and last names
   the night it stopped getting a 404. The keys stay, so the probe still says
   Uber sends a name and that this product does not keep it; the values never
   reach the description. */
const NAME_WITHHELD = '(withheld — a person\'s name)';
export function withholdNames(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.transactions)) return data;
  return { ...data, transactions: data.transactions.map((t) => (t?.driverInfo ? { ...t,
    driverInfo: { ...t.driverInfo,
      ...('firstName' in t.driverInfo ? { firstName: NAME_WITHHELD } : {}),
      ...('lastName' in t.driverInfo ? { lastName: NAME_WITHHELD } : {}) } } : t)) };
}

/* The columns this surface lands in, and the names Uber gives the ones a
   plain name-match would miss — for the probe's "what do we not keep". The
   driver's first and last names stay unmapped on purpose: they are not kept
   here, and saying so is the truth. */
export const TXN_COLS = ['transaction_uuid', 'trip_uuid', 'fleet_id', 'driver_ext_id', 'processed_at',
  'description', 'kind', 'currency', 'paid_to_you', 'your_earnings', 'fare', 'fare_base',
  'service_fee', 'taxes', 'tip', 'cash_collected', 'categories'];
export const TXN_ALIASES = { driverUuid: 'driver_ext_id', breakDowns: 'categories' };
