// Yango collector (Ecosine park). Cursor pagination; >=12 months retention.
//  Trips   : /api/reports-api/v1/orders/list        (40/page, cursor)
//  Drivers : /api/reports-api/v2/summary/drivers/list
//  Ledger  : /api/v1/reports/transactions/park/list (cursor)
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { iso, weekChunks } from '../util.js';
import { log } from '../log.js';
import { stateRow } from '../roster.js';
import { noteCredential } from '../auth_state.js';

const SRC = 'yango';
const headers = () => ({
  'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
  'content-type': 'application/json', 'Accept-Language': 'en', cookie: config.yango.cookie,
});
/* A refusal is not an empty day.
   ─────────────────────────────────────────────────────────────────────────
   This returned the response whatever its status, and every caller then read
   `data?.orders || []`. So a 403 — which is what an expired Yandex session
   gets — came back as zero orders, the loop ended, and the run logged `ok`
   with the rows the OTHER two pulls had written off the API key. Measured on
   production: the last Yango trip on record was 2026-08-26, three days before
   the source last reported itself healthy, and nothing anywhere said the
   session had stopped working.

   The credential check added alongside this is what found it — it asked this
   same endpoint with the same headers and got the 403 the collector had been
   swallowing. So the refusal is raised here, where the run can record it,
   which is the same fix fms.js already carries for the same reason. */
/* Who the pasted session belongs to, read out of the cookie rather than
   guessed. "Sign in as an account that owns this park" is not an instruction
   somebody can follow without knowing which account they are currently signed
   in as, and the cookie carries it. */
const yangoAccount = () => {
  const m = /(?:^|;\s*)yandex_login=([^;]+)/.exec(config.yango.cookie || '');
  return m ? decodeURIComponent(m[1]).slice(0, 60) : null;
};

const post = async (path, body) => {
  const r = await http(`${config.yango.base}${path}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  if (r.status && r.status >= 400) {
    let hint = '';
    if (r.status === 401 || r.status === 403) {
      /* Which of the three credentials is being refused.
         ─────────────────────────────────────────────────────────────────
         Every request carries the park id, the API key AND the cookie, so
         the refusal on its own names none of them. This used to name the
         cookie regardless: "the Yandex session has expired; re-paste
         YANGO_COOKIE". Measured 2026-09-02, the endpoint answers the same
         403 with the cookie header omitted entirely — so that sentence sent
         an operator to re-capture a session that was never the question,
         and the real suspect went unnamed for as long as they believed it.

         One extra request settles it, and it is worth one request: this
         path is only reached when the run is already lost. */
      const bare = await http(`${config.yango.base}${path}`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { 'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
          'content-type': 'application/json', 'Accept-Language': 'en' },
      }).catch(() => null);
      const cookieIsNotIt = bare && bare.status === r.status;
      /* The bare status is recorded either way, because the verdict is only
         as good as the comparison behind it and the comparison is invisible
         once it has been turned into a sentence. A probe that could not run
         at all (network, proxy, a throw) must not silently become evidence
         FOR the cookie — that is how the old unconditional hint got there. */
      const bareSays = bare ? `without a cookie: HTTP ${bare.status}` : 'the cookie-free probe did not complete';
      hint = cookieIsNotIt
        ? ` — the same refusal arrives with no cookie at all, so the session is not what is being rejected;`
          + ` check YANGO_PARK_ID (${config.yango.parkId}) and YANGO_API_KEY`
        : bare
          /* The sibling branch's advice was the very mistake this block was
             written to end, one line further down.
             ─────────────────────────────────────────────────────────────
             A 401 without the cookie and a 403 with it is proof the session
             AUTHENTICATES — that is what the sentence says — and the reply
             was "re-paste YANGO_COOKIE", which is work that cannot change the
             answer. A fresh cookie for the same account authenticates the same
             way and is refused the same way. Measured on production
             2026-09-03: a cookie captured that morning, verified live by
             src/credcheck.js as a real fleet session for muzammil16075, and
             still 403 on this park.
             403 after authenticating is about ENTITLEMENT, so it names the
             three things it can be: the account may not hold this park, the
             park id may be another park's, or the API key may be. The account
             is read out of the cookie because "sign in as somebody who owns
             this park" is unactionable if the operator cannot see who they
             are currently signed in as. */
          ? ` — with no cookie this call answers HTTP ${bare.status} instead, so the session IS`
            + ` being read and authenticates${yangoAccount() ? ` as ${yangoAccount()}` : ''};`
            + ` a 403 after that is about entitlement, not the session — either this account is`
            + ` not on park ${config.yango.parkId}, or YANGO_PARK_ID or YANGO_API_KEY names a`
            + ' park it cannot see. Re-pasting the same account\u2019s cookie will not change it'
          : ' — and the cookie-free comparison did not complete, so which credential is being'
            + ' refused is not yet established';
      /* The cookie is recorded as WORKING when it demonstrably worked.
         ─────────────────────────────────────────────────────────────────
         Blaming a different credential stops writing red rows against this
         one; it does not clear the red row already there. Measured on
         production 2026-09-03, minutes after the fix that stopped blaming the
         cookie shipped: /api/auth carried BOTH `YANGO_PARK_ID invalid` from
         the new code and `YANGO_COOKIE invalid` from the old, so the panel
         accused a session that had just authenticated, for ever, because
         nothing would ever overwrite it. Same shape as src/sources/fms.js
         never writing 'ok' — a state only something can clear.

         The evidence is the comparison itself: a 401 without the cookie and a
         403 with it is the portal reading the session. That is a working
         cookie whatever else is refused. */
      if (bare && !cookieIsNotIt) {
        await noteCredential(pool, {
          provider: SRC, fleet: config.yango.fleet || '*', credential: 'YANGO_COOKIE',
          state: 'ok', surface: path, detail: null,
        });
      }
      /* Recorded, not only thrown: a thrown error dies with the run, and the
         credential panel is where somebody goes to find out what to re-paste.
         Uber has done this since the OAuth work; the other five sources never
         did, so their refusals reached the operator as a source that had
         simply gone quiet. */
      await noteCredential(pool, {
        provider: SRC, fleet: config.yango.fleet || '*',
        /* Not YANGO_COOKIE when the cookie authenticated. Blaming it puts a
           red row against a credential that works and sends somebody to
           replace it; the entitlement is what is refused, and the park id is
           the field that names it. */
        credential: cookieIsNotIt || bare ? 'YANGO_PARK_ID' : 'YANGO_COOKIE',
        state: cookieIsNotIt || bare ? 'invalid' : 'unknown', surface: path,
        detail: `HTTP ${r.status}; ${bareSays}`,
      });
    }
    throw new Error(`yango ${path} refused: HTTP ${r.status}${hint}`);
  }
  return r;
};
const dubai = (d, end) => `${iso(d)}T${end ? '23:59:59' : '00:00:00'}+04:00`;

async function pullTrips(from, to) {
  let cursor, total = 0, guard = 0;
  do {
    const { data } = await post('/api/reports-api/v1/orders/list',
      { date_type: 'booked_at', date_from: dubai(from), date_to: dubai(to, true), ...(cursor ? { cursor } : {}) });
    const orders = data?.orders || [];
    const rows = orders.map((o) => ({
      platform: SRC, external_id: o.id, fleet_id: config.yango.fleet, plate: normPlate(o.car_license_number),
      driver_ext_id: o.driver_id, driver_name: o.driver_full_name,
      requested_at: o.booked_at, ended_at: o.ended_at,
      pickup_addr: o.address_from, dropoff_addr: o.address_to,
      distance_km: o.mileage != null ? Number(o.mileage) / 1000 : null,
      status: o.status, product: o.category, payment_type: o.payment_method,
      price: o.price, currency: o.currency_code || 'AED', raw: o,
    })).filter((r) => r.external_id);
    if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
    cursor = data?.cursor;
    if (orders.length === 0) break;
  } while (cursor && ++guard < 2000);
  return total;
}

/* Weekly, on the same Monday grid as Uber — never one call for the run's whole
   window. The summary endpoint aggregates whatever range it is asked, so a
   backfill asking for a year got one 366-day row per driver, stamped with the
   run's own bounds. Ten of those smeared AED 17,000 across every month of the
   record at a flat forty-six dirhams a day — including months before Yango had
   carried a single trip — and the resolution in sql/schema_v23.sql could not
   help, because nothing finer existed for the days only the year-row covered.
   The window a report is asked for is the key it is stored under; a moving
   window is a duplicate and a huge one is a smear. */
async function pullDrivers(from, to) {
  let total = 0;
  for (const { start, end } of weekChunks(from, to)) {
    const { data } = await post('/api/reports-api/v2/summary/drivers/list',
      { date_from: iso(start), date_to: iso(end), sort: { field: 'driver_id', direction: 'asc' } });
    const rows = (data?.items || []).map((it) => ({
      platform: SRC, fleet_id: config.yango.fleet, driver_ext_id: it.driver?.id,
      driver_name: `${it.driver?.first_name || ''} ${it.driver?.last_name || ''}`.trim(),
      plate: normPlate(it.car?.callsign), period_start: iso(start), period_end: iso(end),
      trips: it.count_orders_completed, distance_km: it.sum_distance != null ? Number(it.sum_distance) / 1000 : null,
      hours_online: it.work_time_seconds != null ? it.work_time_seconds / 3600 : null,
      earnings: (Number(it.price_cash) || 0) + (Number(it.price_cashless) || 0),
      cash_earnings: it.price_cash, raw: it,
    /* A driver who did nothing that week comes back as a row of zeros, and a
       zero is a measure — it would claim the week's days in the resolution and
       expand seven rows of nothing per idle driver per week. A week with no
       work is represented by no row, the same way a day with no trips is. */
    })).filter((r) => r.driver_ext_id
      && ((r.trips || 0) > 0 || (r.earnings || 0) > 0 || (r.hours_online || 0) > 0));
    if (rows.length) total += await upsertMany('driver_performance', rows,
      ['platform', 'driver_ext_id', 'period_start', 'period_end']);
    await maybeRoster(data);
  }
  return total;
}

/* The roster snapshot rides on the summary response; one pass is enough and it
   is not window-keyed, so it upserts identically from any week. */
async function maybeRoster(data) {
  const roster = (data?.items || []).map((it) => stateRow({
    platform: SRC, driverExtId: it.driver?.id, fleetId: config.yango.fleet,
    name: `${it.driver?.first_name || ''} ${it.driver?.last_name || ''}`.trim(),
    rawState: it.driver?.status || it.status || it.driver?.work_status,
    reason: it.driver?.status_reason,
    plate: it.car?.callsign ? normPlate(it.car.callsign) : null,
    raw: { status: it.driver?.status, trips_per_hour: it.trips_per_hour },
  })).filter((r) => r.driver_ext_id);
  if (roster.length) await upsertMany('driver_platform_state', roster, ['platform', 'driver_ext_id']);
}

async function pullLedger(from, to) {
  let cursor, total = 0, guard = 0;
  do {
    const { data } = await post('/api/v1/reports/transactions/park/list',
      { query: { park: { transaction: { event_at: { from: dubai(from), to: dubai(to, true) } } } }, limit: 100, ...(cursor ? { cursor } : {}) });
    const txns = data?.transactions || [];
    const rows = txns.map((t) => ({
      platform: SRC, external_id: t.id, fleet_id: config.yango.fleet, driver_ext_id: t.driver_id,
      driver_name: t.driver_name, order_ref: t.order_id, event_at: t.event_at,
      category: t.category_id, amount: t.amount, currency: t.currency_code || 'AED', description: t.description, raw: t,
    })).filter((r) => r.external_id);
    if (rows.length) total += await upsertMany('ledger_entry', rows, ['platform', 'external_id']);
    cursor = data?.cursor;
    if (txns.length === 0) break;
  } while (cursor && ++guard < 2000);
  return total;
}

export async function collect({ from, to, mode }) {
  try {
    const trips = await pullTrips(from, to);
    const drivers = await pullDrivers(from, to);
    const ledger = await pullLedger(from, to);
    await logRun({ source: SRC, fleet_id: config.yango.fleet, mode, window_start: from, window_end: to, status: 'ok', rows_written: trips + drivers + ledger });
    log.info(SRC, 'done', { trips, drivers, ledger });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: config.yango.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
