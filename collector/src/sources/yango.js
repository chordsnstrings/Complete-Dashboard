/* Yango collector (Ecosine park). TWO HOSTS, and which one is not cosmetic.
   ─────────────────────────────────────────────────────────────────────────
   fleet.yango.com is the web CONSOLE and wants a Yandex session cookie. It has
   answered 403 since 2026-09-06 — with an HTML page from a CDN edge, and every
   Yango API refusal is JSON, so the HTML is something in FRONT of the API
   rather than the API. The park is provably right: /api/fleet/ui/v1/parks/
   users/profile returns 200 and names "ECOSINE TRANSPORTS LLC". The same call
   answers 401 with the cookie removed, and from one origin that pair is
   unreachable unless an edge is doing the refusing. No credential an operator
   can re-paste changes any of it; api/probe.js:post() carries the measurement.

   fleet-api.yango.tech is a DIFFERENT product — Yango's own Fleet API, keyed
   rather than cookied — and the YANGO_API_KEY this park already stores opens
   it under the client id shaped `taxi/park/<park id>`. Measured from
   production 2026-09-07, with no cookie anywhere: 145 drivers, 104 cars, live
   orders. So the three surfaces that matter moved:

     Trips   : POST fleet-api.yango.tech /v1/parks/orders/list          cursor
     Roster  : POST fleet-api.yango.tech /v1/parks/driver-profiles/list limit/offset
     Cars    : POST fleet-api.yango.tech /v1/parks/cars/list            limit/offset

   And two did not move, because they are not there. /v1/parks/transactions/
   list and /v1/parks/summary/drivers/list both answer 404 path_not_found, so
   the ledger and the weekly per-driver aggregate stay on the console host and
   stay refused until the session works. The aggregate could be recomputed from
   the orders — except that an order carries no commission field, and Yango's
   commission is about 24% of the gross (Aliyan Khalil, August 2026: gross
   3,069.00 against -749.58). Writing the gross into driver_performance.
   earnings would restate a number this collector was FIXED for, back to wrong,
   under a column api/income_sql.js describes to a reader as "the money that
   arrived". A figure that cannot be measured is absent with a reason.

   The two hosts also disagree about shape. The key host nests what the console
   kept flat, and the mapper below is written against the field names measured
   by /api/probe/yango/keyapi rather than remembered from the console:

     trip column     console                  key API
     driver_ext_id   driver_id                driver_profile.id
     driver_name     driver_full_name         driver_profile.name
     plate           car_license_number       car.license (object) / car.callsign
     pickup_addr     address_from (string)    address_from.address
     dropoff_addr    address_to               last of route_points[].address
     distance_km     mileage (number)         mileage (STRING)
     price           price (number)           price (STRING)                     */
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun, pool } from '../db.js';
import { iso, closedWeeks } from '../util.js';
import { log } from '../log.js';
import { stateRow, rawJson } from '../roster.js';
import { noteCredential } from '../auth_state.js';

const SRC = 'yango';

/** Every path this collector reads, on the host that serves it.
    ─────────────────────────────────────────────────────────────────────────
    Exported because src/credcheck.js must ask THE ENDPOINT THE COLLECTOR ASKS.
    A check that picks its own path tests its own choice: the first version of
    the Yango check asked /api/v1/parks/orders/list and reported a dead cookie
    that the collector was using successfully at that moment. Two copies of a
    path is one copy too many, and test/yango_refusal.test.mjs reads this
    object rather than a literal so the two cannot drift. */
export const YANGO_SURFACES = Object.freeze({
  /* fleet-api.yango.tech — keyed, no cookie. These three are the collector. */
  key: Object.freeze({
    orders: '/v1/parks/orders/list',
    drivers: '/v1/parks/driver-profiles/list',
    cars: '/v1/parks/cars/list',
  }),
  /* fleet.yango.com — the console, which wants a session and is refused by an
     edge. Neither of these exists on the key host (both 404 path_not_found),
     which is the only reason they are still here. */
  console: Object.freeze({
    summary: '/api/reports-api/v2/summary/drivers/list',
    ledger: '/api/v1/reports/transactions/park/list',
  }),
});
const headers = () => ({
  'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
  'content-type': 'application/json', 'Accept-Language': 'en', cookie: config.yango.cookie,
});
/* The keyed host. No cookie, and deliberately no X-Park-Id: the park is named
   in the client id and again in every request body, and a third place to say
   it is a third place for it to disagree with itself. */
const keyHeaders = () => ({
  'X-API-Key': config.yango.apiKey, 'X-Client-ID': config.yango.clientId,
  'content-type': 'application/json', 'Accept-Language': 'en',
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

/* The console's half of the same bookkeeping — see keyRefusals. */
const consoleRefusals = new Set();

const post = async (path, body) => {
  const r = await http(`${config.yango.base}${path}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body),
  });
  if (r.status && r.status >= 400) {
    let hint = '';
    consoleRefusals.add(path);
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
          /* AND THE FOURTH POSSIBILITY, which is the one that turned out to be
             true and which this sentence did not name.
             ─────────────────────────────────────────────────────────────
             Measured 2026-09-07, minutes apart, with production's stored
             YANGO_PARK_ID and YANGO_COOKIE confirmed updated at 08:11:14Z:

               the same URL, method, headers and body, with the same park id
               and the same session, answered HTTP 200 with live orders from
               one host and HTTP 403 from the deployed app.

             Both hosts get 401 with the cookie removed, so the park id clears
             the pre-auth gate from both — an unrecognised park refuses 403
             with AND without a session, which is the other branch. And the
             API key is inert on this host: the same call returns a
             byte-identical 200 with a junk key and with no key header at all.

             That leaves nothing about the credentials. What differs is where
             the call comes FROM, and no amount of re-pasting changes a
             caller's address. Naming it matters because the three suspects
             this sentence used to list are all things an operator can go and
             fix, and they would have spent the afternoon fixing them. */
          ? ` — with no cookie this call answers HTTP ${bare.status} instead, so the session IS`
            + ` being read and authenticates${yangoAccount() ? ` as ${yangoAccount()}` : ''};`
            + ` a 403 after that is about entitlement, not the session — either this account is`
            + ` not on park ${config.yango.parkId}, or YANGO_PARK_ID or YANGO_API_KEY names a`
            + ' park it cannot see, or the refusal is of this HOST rather than of any credential:'
            + ' the same call with the same three credentials has been measured returning 200'
            + ' from a different network on the same day. Re-pasting the same account\u2019s'
            + ' cookie will not change any of the four'
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
      /* NOT YANGO_PARK_ID any more, and the reason is that something else now
         proves it every run.
         ─────────────────────────────────────────────────────────────────
         This wrote `YANGO_PARK_ID: invalid` — correct while the console was
         the only host, and destructive the moment keyPost() started writing
         `YANGO_PARK_ID: ok` from fleet-api.yango.tech. Both would run in the
         same collect(): the key host would prove the park id, and then these
         two console-only surfaces would fail four lines later and mark the
         same row invalid. Last write wins, so the panel would have gone red
         after every successful run, for a park the collector had just read
         145 drivers and 104 cars from.

         The console failure is real and belongs on the panel. It is just not
         ABOUT the park id, the API key or the session: the park answers 200
         and names ECOSINE TRANSPORTS LLC, the session authenticates (that is
         what the 401-without-cookie comparison above establishes), and the
         403 arrives as an HTML page from a CDN edge while every Yango API
         refusal is JSON. So it gets a row of its own, under a name that says
         what it is, in the state that asks for the right errand — 'blocked',
         which api/auth_routes.js scores as stopped and describes as refused
         in front of the API rather than as a credential to replace. */
      /* 'blocked' keys on WHAT the cookie-free probe said, not merely on
         whether it completed.
         ─────────────────────────────────────────────────────────────────
         The same refusal with and without a session — cookieIsNotIt — is the
         signature of a park this host does not recognise, which the branch
         above says in so many words. Writing 'blocked' for it would tell an
         operator that something in front of the API is turning the caller
         away, over a refusal that is about the park. 'blocked' is earned only
         by the asymmetry: authenticated with a session, refused anyway.

         Which does not make it the park id's fault either, because
         fleet-api.yango.tech proves that park every run with the same id. So
         the honest state for the symmetric case is 'unknown' — this host
         refuses this park and nothing here establishes why. */
      await noteCredential(pool, {
        provider: SRC, fleet: config.yango.fleet || '*',
        credential: 'YANGO_CONSOLE',
        state: bare && !cookieIsNotIt ? 'blocked' : 'unknown', surface: path,
        detail: `fleet.yango.com HTTP ${r.status}; ${bareSays}.`
          + (cookieIsNotIt
            ? ' The same refusal arrives with no session at all, so nothing here says what is'
              + ' being rejected — and it is not the park id, which fleet-api.yango.tech accepts'
              + ' on every run with this same value.'
            : ' The park id and API key are proven every run by fleet-api.yango.tech,'
              + ' which serves trips, the roster and the cars; only the weekly driver'
              + ' aggregate and the payment ledger are behind this host.'),
      });
    }
    throw new Error(`yango ${path} refused: HTTP ${r.status}${hint}`);
  }
  /* ── the console answered, so its own row goes green ─────────────────────
     The "a state only something can clear" fix went in for YANGO_COOKIE and
     stopped there — and it stopped one line above the call that made
     YANGO_PARK_ID the new write-invalid-only key. There is no YANGO_PARK_ID
     checker in src/credcheck.js either, so once that row went red nothing in
     the product could ever turn it green again, and api/auth_routes.js scores
     'invalid' as "stopped" for ever.

     A 200 here is the proof that the CONSOLE is reachable again — which is
     the only thing this host can still prove, now that the park id and the API
     key are established every run by keyPost() against fleet-api.yango.tech.
     Writing them from here as well would be two writers on one row, and the
     one that ran last would decide the colour. The same standard the cookie is
     held to eleven lines up, and the same one fms.js and uber.js apply. */
  /* Only when NOTHING on this host has been refused during the run. Both
     console surfaces write this one row and the ledger runs last, so a refused
     weekly aggregate followed by a ledger page that happened to answer would
     have painted the console green over its own failure. Same rule and same
     reason as keyRefusals above. */
  consoleRefusals.delete(path);
  if (consoleRefusals.size === 0) {
    await noteCredential(pool, {
      provider: SRC, fleet: config.yango.fleet || '*', credential: 'YANGO_CONSOLE',
      state: 'ok', surface: path, detail: null,
    });
  }
  return r;
};
/* The keyed host's transport, which is a different diagnosis from post()'s.
   ─────────────────────────────────────────────────────────────────────────
   post() spends an extra request working out whether the COOKIE is what is
   being refused, because the console sends three credentials and the refusal
   names none of them. Here there is no cookie and there are two: the API key
   and the client id. Yango tells them apart itself — a wrong client id
   answers 403 {"code":"403","message":"invalid client id or api key"}, and a
   path that does not exist answers 404 {"code":"path_not_found"} — so the
   honest thing is to quote the provider rather than to guess between them.

   A 404 is NOT a credential failure and must never be recorded as one. Three
   of the six paths tried on this host answer 404, and a red row against
   YANGO_API_KEY for a path Yango does not serve would send an operator to
   replace a key that works. */
/* Which key-host paths have been refused during THIS run. Cleared at the top
   of collect(), so it is a fact about one run and not a memory of a bad week. */
const keyRefusals = new Set();

const keyPost = async (path, body) => {
  if (!config.yango.clientId || !config.yango.apiKey) {
    /* RECORDED, not only thrown. bolt.js, cabman.js and fms.js all write
       state 'missing' when a credential is absent; this threw before any HTTP
       and wrote nothing, so a deployment with no YANGO_PARK_ID showed Yango
       nowhere on the credential panel at all — indistinguishable from a source
       that is fine. An absent credential is a state, and 'missing' is the word
       api/auth_routes.js already scores for it. */
    const missing = !config.yango.apiKey ? 'YANGO_API_KEY' : 'YANGO_PARK_ID';
    await noteCredential(pool, {
      provider: SRC, fleet: config.yango.fleet || '*', credential: missing,
      state: 'missing', surface: path,
      detail: `${missing} is not set, so nothing can be collected from `
        + `${config.yango.keyBase} — the trips, the roster and the cars all come from there`,
    });
    throw new Error(`yango: ${missing} is not set`);
  }
  const r = await http(`${config.yango.keyBase}${path}`, {
    method: 'POST', headers: keyHeaders(), body: JSON.stringify(body),
  });
  if (r.status && r.status >= 400) {
    const said = typeof r.data === 'object' && r.data
      ? (r.data.message || r.data.code || '')
      : String(r.data || '').slice(0, 120);
    if (r.status === 401 || r.status === 403) {
      keyRefusals.add(path);
      await noteCredential(pool, {
        provider: SRC, fleet: config.yango.fleet || '*', credential: 'YANGO_API_KEY',
        state: 'invalid', surface: path,
        /* Both credentials named, because Yango's own wording refuses to
           choose between them, and a detail line that picks one is inventing
           the half the provider withheld. */
        detail: `HTTP ${r.status} on ${config.yango.keyBase}: ${said}`
          + ' — this host authenticates on X-API-Key plus X-Client-ID and its refusal'
          + ' does not say which; the client id shape that works is taxi/park/<park id>',
      });
    }
    throw new Error(`yango ${path} refused: HTTP ${r.status}${said ? ` — ${said}` : ''}`
      + (r.status === 404 ? ' (this path does not exist on the key host)' : ''));
  }
  /* A 200 is the proof, and it is the only thing that can turn the panel green:
     noteCredential writes 'invalid' rows that nothing else clears.

     BUT NOT UNCONDITIONALLY, because three surfaces come through here in one
     run and credential_state is keyed (provider, fleet, credential) with no
     surface in the key — so the last writer decides the colour. A refused
     roster followed by a successful trips pull would have written 'invalid'
     and then 'ok' over it, and the panel would have shown green for a run that
     collected no drivers. The refusal is remembered for the rest of the run and
     only a run with NO refusal writes green; the next run starts clean, so a
     surface that recovers is not held against it for ever. */
  keyRefusals.delete(path);
  if (keyRefusals.size === 0) {
    for (const credential of ['YANGO_API_KEY', 'YANGO_PARK_ID']) {
      await noteCredential(pool, {
        provider: SRC, fleet: config.yango.fleet || '*', credential,
        state: 'ok', surface: path, detail: null,
      });
    }
  }
  return r;
};

/* Yango files numbers as STRINGS on this host — price "35.5", mileage "8123" —
   and Number('') is 0, which would file a fare of nothing as a fare of zero.
   Empty, null and unparseable all become null; a real zero stays zero. */
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const dubai = (d, end) => `${iso(d)}T${end ? '23:59:59' : '00:00:00'}+04:00`;

/* ── one name per Yango driver id ────────────────────────────────────────
   Yango hands the same driver_id back under three different name
   compositions, from three endpoints:

     orders/list        driver_full_name        "Khalil Aliyan"
     summary/drivers    first_name + last_name  "Aliyan Khalil"
     transactions/list  driver_name             (a third, unverified, string)

   The orders string puts the father's name first; the summary endpoint hands
   the parts back decomposed and in natural order. person_key is a GENERATED
   column folding each table's own name column (sql/schema_v20.sql for trip and
   driver_platform_state, v42 for money_event), so one Yango driver arrived as
   two people: their trips under one key and their roster row under another.
   That is how "Khalil Aliyan" came to sit beside "Aliyan khalil" in a roster
   of 395, and it is still live on at least two more accounts — Yango
   69f7e655… reads "Tariq Afzal Said Afzal" on screen while storing the
   person_key "said afzal tariq afzal", from one account, where two people is
   impossible.

   api/identity_map.js can only join the pairs a human has already verified,
   one at a time, after the fact. This stops the split being written.

   The decomposed name wins, because it is the one Yango gives us in parts and
   the only one whose word order we can account for. The map is seeded from
   what the roster already knows — so a run that pulls trips for a driver the
   summary endpoint does not return this window still files them under the
   name that driver's other rows carry — and pullDrivers overlays whatever it
   learns as it goes. An id we have never seen decomposed keeps the endpoint's
   own string: a name we cannot improve on is better than no name. */
const nameById = new Map();

/* The summary endpoint's decomposition, composed the same way everywhere and
   remembered, so the two calls after this one file the driver identically. */
function decomposed(d) {
  const name = `${d?.first_name || ''} ${d?.last_name || ''}`.trim();
  if (d?.id != null && name) nameById.set(String(d.id), name);
  return name || null;
}

async function seedNames() {
  nameById.clear();
  const { rows } = await pool.query(
    `SELECT driver_ext_id, full_name FROM driver_platform_state
      WHERE platform = $1 AND full_name IS NOT NULL AND full_name <> ''`, [SRC]);
  for (const r of rows) nameById.set(String(r.driver_ext_id), r.full_name);
  return nameById.size;
}

/* The endpoint's own string is the fallback, never an empty one. */
const nameFor = (id, given) => (id != null && nameById.get(String(id))) || given || null;

/* The plate an order was driven on, from three places in falling order of how
   much the field is a plate.
   ─────────────────────────────────────────────────────────────────────────
   The console gave `car_license_number`, one string. This host gives
   `car.license`, an object, plus `car.callsign` — and the park uses the plate
   AS the callsign, which is why the old pullDrivers read the plate out of
   `it.car?.callsign` and got it right. The object's own field names are read
   defensively rather than assumed: the probe walks two levels and `car.license`
   sits at the second, so its children were never measured. Whatever it holds
   is in `raw` either way, and /api/schema/raw-fields can be asked. */
/* The last route point that names anywhere — the DESTINATION. route_points is
   the whole itinerary and a two-stop order has three of them, so [0] would file
   the pickup twice under two column names. Taken once and read three times, so
   the address and the two coordinates cannot come from different points. */
const dropPoint = (o) => (o?.route_points || []).filter((rp) => rp?.address).slice(-1)[0] || null;

const orderPlate = (o) => normPlate(
  o?.car?.license?.normalized_number || o?.car?.license?.number
  || (typeof o?.car?.license === 'string' ? o.car.license : null)
  || o?.car?.callsign || null);

async function pullTrips(from, to) {
  let cursor, total = 0, guard = 0;
  do {
    const { data } = await keyPost(YANGO_SURFACES.key.orders, {
      query: { park: { id: config.yango.parkId,
        order: { booked_at: { from: dubai(from), to: dubai(to, true) } } } },
      limit: config.yango.pageSize,
      ...(cursor ? { cursor } : {}),
    });
    const orders = data?.orders || [];
    const rows = orders.map((o) => ({
      platform: SRC, external_id: o.id, fleet_id: config.yango.fleet, plate: orderPlate(o),
      driver_ext_id: o.driver_profile?.id,
      driver_name: nameFor(o.driver_profile?.id, o.driver_profile?.name),
      requested_at: o.booked_at, ended_at: o.ended_at,
      pickup_addr: o.address_from?.address || null,
      /* The coordinates, which the console never sent and this host does. The
         columns have existed since sql/schema.sql; leaving them null would put
         every Yango trip off the map beside Uber's, for want of two fields
         that arrive in the same object as the address already being read. */
      pickup_lat: num(o.address_from?.lat), pickup_lng: num(o.address_from?.lon),
      /* The DESTINATION is the last route point, not the first. route_points
         is the whole itinerary — a two-stop order has three of them — and
         taking [0] would file the pickup twice under two column names. */
      dropoff_addr: dropPoint(o)?.address || null,
      dropoff_lat: num(dropPoint(o)?.lat), dropoff_lng: num(dropPoint(o)?.lon),
      /* Metres, filed as a string. num() so an empty one is absent rather
         than a journey of zero kilometres. */
      distance_km: num(o.mileage) != null ? num(o.mileage) / 1000 : null,
      status: o.status, product: o.category, payment_type: o.payment_method,
      price: num(o.price),
      /* This host sends no currency_code. The park is Dubai and every fare it
         has ever filed is AED; the raw order is stored, so a park that one day
         is not can be found rather than silently converted. */
      currency: 'AED', raw: o,
    })).filter((r) => r.external_id);
    if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
    cursor = data?.cursor;
    if (orders.length === 0) break;
  } while (cursor && ++guard < 2000);
  return total;
}

/* ── the roster, from the endpoint that decomposes the name ──────────────
   This is the fix for the split this file has carried a comment about since
   the console days: one Yango driver arriving as two people because
   orders/list files "Khalil Aliyan" and the roster files "Aliyan Khalil".
   driver-profiles/list gives first_name and last_name SEPARATELY, so the
   composed name is the one whose word order we can account for — and it now
   comes from a host that needs no cookie, which is what makes it reachable at
   all while the console is refused.

   It writes driver_compliance as well as driver_platform_state, which the
   console path never did, and the phone is why: src/identity_link.js joins a
   person's two records on a phone number the roster filed against both, and
   Yango's drivers were invisible to it because nothing wrote their numbers. */
const firstString = (v) => {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) { for (const x of v) { const s = firstString(x); if (s) return s; } return null; }
  if (v && typeof v === 'object') {
    for (const k of ['number', 'phone', 'value', 'normalized_number', 'id']) {
      const s = firstString(v[k]); if (s) return s;
    }
  }
  return null;
};
/* The licence object's field names were never measured — it sits one level
   below where /api/probe/yango/keyapi stops — so the candidates are tried and
   the key set is LOGGED the first time none matches, which makes the next run's
   log the answer instead of another round trip. */
let licenceKeysLogged = false;
const licenceOf = (dl) => {
  if (!dl || typeof dl !== 'object') return { no: firstString(dl), exp: null };
  const no = firstString(dl.number ?? dl.normalized_number ?? dl.licence_number ?? dl.license_number);
  const exp = dl.expiry_date || dl.expiration_date || dl.expires_at || dl.valid_until || null;
  if (!no && !licenceKeysLogged) {
    licenceKeysLogged = true;
    log.warn(SRC, 'driver_license has no field this maps — the keys it does have',
      { keys: Object.keys(dl).slice(0, 20) });
  }
  return { no, exp: exp ? String(exp).slice(0, 10) : null };
};

async function pullRoster() {
  const LIMIT = 200;
  let offset = 0, seen = 0, total = 0, guard = 0;
  const states = [], compliance = [];
  for (;;) {
    const { data } = await keyPost(YANGO_SURFACES.key.drivers,
      { query: { park: { id: config.yango.parkId } }, limit: LIMIT, offset });
    const items = data?.driver_profiles || [];
    if (!items.length) break;
    for (const it of items) {
      const d = it.driver_profile || {};
      if (d.id == null) continue;
      /* decomposed(d) directly, not a rebuilt {id, first_name, last_name}.
         The driver_profile object already IS that shape, and composing the two
         parts a second time here would be a second place the name is built —
         which is the whole defect this endpoint is being read to avoid, and
         which test/yango_one_name.test.mjs counts. */
      const name = decomposed(d);
      const plate = it.car?.normalized_number || it.car?.number || it.car?.callsign || null;
      states.push(stateRow({
        platform: SRC, driverExtId: d.id, fleetId: config.yango.fleet, name,
        /* current_status is what the driver is doing right now (online, busy,
           offline) and work_status is whether the park employs them. The
           roster is a question about employment, so work_status leads and the
           live status is the fallback for a record that has none. */
        rawState: d.work_status || it.current_status?.status,
        reason: d.check_message || null,
        vehicleExtId: it.car?.id || null,
        plate: plate ? normPlate(plate) : null,
        raw: { work_status: d.work_status, current_status: it.current_status?.status,
          work_rule_id: d.work_rule_id, hire_date: d.hire_date,
          employment_type: d.employment_type, has_contract_issue: d.has_contract_issue },
      }));
      const lic = licenceOf(d.driver_license);
      compliance.push({
        platform: SRC, driver_ext_id: String(d.id), fleet_id: config.yango.fleet,
        full_name: name, phone: firstString(d.phones),
        licence_no: lic.no, licence_expires: lic.exp,
        state: d.work_status || it.current_status?.status || null,
        raw: rawJson({ driver_profile: d, current_status: it.current_status }),
      });
    }
    seen += items.length;
    offset += LIMIT;
    /* `total` only ends the walk when it is a REAL count. Number(null) is 0 and
       Number.isFinite(0) is true, so `seen >= known` was satisfied by a
       response that simply omitted the field — one page collected, no error,
       and a run that reports success with a fifth of the roster. A short page
       is the reliable signal and stays the primary one. */
    const known = data?.total == null ? null : Number(data.total);
    const complete = Number.isFinite(known) && known > 0 && seen >= known;
    if (items.length < LIMIT || complete || ++guard > 50) break;
  }
  if (states.length) {
    total += await upsertMany('driver_platform_state', states, ['platform', 'driver_ext_id']);
  }
  if (compliance.length) {
    await upsertMany('driver_compliance', compliance, ['platform', 'driver_ext_id']);
  }
  log.info(SRC, 'roster', { drivers: seen, with_phone: compliance.filter((c) => c.phone).length });
  return total;
}

/* ── the cars, which is a VIN per plate from a second independent source ──
   Nothing but src/sources/uber_fleet.js has ever written vehicle_profile, so
   every VIN this product holds came from one channel and could not be checked
   against anything. Yango names 104 of the same cars with their own VINs.

   The rows are keyed (platform, vehicle_ext_id), so these do not overwrite
   Uber's — they sit beside them, and sql/schema_v66.sql's vehicle_plate view
   is what makes one car read as one car afterwards. That view had to exist
   BEFORE this function did: four LEFT JOINs in the read API joined
   vehicle_profile on plate and would have printed a car known to both channels
   twice, or silently picked one of the two. */
async function pullCars() {
  const LIMIT = 200;
  let offset = 0, seen = 0, total = 0, guard = 0;
  for (;;) {
    const { data } = await keyPost(YANGO_SURFACES.key.cars,
      { query: { park: { id: config.yango.parkId } }, limit: LIMIT, offset });
    const cars = data?.cars || [];
    if (!cars.length) break;
    const rows = cars.filter((c) => c?.id != null && String(c.id).trim()).map((c) => ({
      platform: SRC, vehicle_ext_id: String(c.id), fleet_id: config.yango.fleet,
      plate: normPlate(c.normalized_number || c.number || c.callsign),
      make: c.brand || null, model: c.model || null,
      /* num(), not Number.isFinite(Number(x)). Number(null) and Number('') are
         both 0 and Number.isFinite(0) is true, so a car with no year on record
         was stored as the year 0 — a measurement where there was none, on a
         column a page prints beside the make. */
      year: num(c.year),
      colour: c.color || null,
      /* Uppercased and trimmed. A VIN is a 17-character identifier and the two
         channels must agree on its spelling or the cross-check this exists for
         compares a string with itself in another case and reports a fleet
         twice its size. */
      vin: c.vin ? String(c.vin).trim().toUpperCase() || null : null,
      /* NOT compliance_status. Yango's car `status` is a WORK status — the
         values are `working` and the like — while the only other writer of
         that column, src/sources/uber_fleet.js, puts Uber's document-compliance
         verdict there, and /api/vehicle/profile prints it as the car's
         compliance. Filing a work status under it would have made a working
         car read as document-compliant on a page an operator checks documents
         on. It rides in `raw`, where it is true, until a column means it. */
      raw: rawJson(c),
    }));
    if (rows.length) total += await upsertMany('vehicle_profile', rows, ['platform', 'vehicle_ext_id']);
    seen += cars.length;
    offset += LIMIT;
    /* Same trap as the roster walk above: an absent `total` reads as 0 and
       Number.isFinite(0) is true, which ends the walk after one page. */
    const known = data?.total == null ? null : Number(data.total);
    const complete = Number.isFinite(known) && known > 0 && seen >= known;
    if (cars.length < LIMIT || complete || ++guard > 50) break;
  }
  log.info(SRC, 'cars', { cars: seen, written: total });
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
async function pullDrivers(from, to, chunks = []) {
  let total = 0;
  /* closedWeeks, for the same reason Uber uses it: driver_performance is keyed
     on (period_start, period_end), so an open week asked for today would key a
     partial week under the whole week's identity — and this endpoint aggregates
     whatever range it is given, which is the smear the comment above is about.
     The week lands when it closes. */
  for (const { start, end } of closedWeeks(from, to)) {
    /* PER WEEK, like fms.js and uber.js already do.
       ─────────────────────────────────────────────────────────────────────
       post() throws on any status >= 400 and nothing stood between it and
       collect()'s single catch, so one refused week abandoned every LATER week
       — and, because collect() ran all three pulls in one try, the trips and
       the ledger with them. weekChunks yields oldest-first, so a refusal on
       the oldest week of a backfill cost the entire run: exactly the shape
       that had Bolt writing 70 rows over two years.

       A window that refused is a window, not a run. */
    let data = null;
    try {
      ({ data } = await post(YANGO_SURFACES.console.summary,
        { date_from: iso(start), date_to: iso(end), sort: { field: 'driver_id', direction: 'asc' } }));
    } catch (e) {
      const why = String(e && e.message ? e.message : e).slice(0, 200);
      log.warn(SRC, 'driver week refused', { from: iso(start), to: iso(end), err: why });
      chunks.push({ from: iso(start), to: iso(end), rows: 0, error: why });
      continue;
    }
    const items = data?.items || [];
    /* NO LIMIT IS SENT AND NO CURSOR IS READ, while both sibling endpoints in
       this file page. uber.js:1115 records what that cost once already on the
       identical shape — an API's default page of 50 against a 152-driver
       fleet, so driver_platform_state held a third of the roster and every
       "on the books but not earning" figure was computed over that third.

       It is not fixed here because it cannot be measured here: this park
       answers 403 (YANGO_PARK_ID is not entitled), so the page size and the
       cursor's spelling are both unknown, and paging invented against an
       endpoint nobody can call is a guess shipped as a fix. What IS possible
       is noticing: a count sitting exactly on a round boundary is what a first
       page looks like, and saying so beats discovering it a year later. */
    if (items.length && items.length % 50 === 0) {
      log.warn(SRC, 'driver week landed exactly on a page boundary — is this endpoint paged?',
        { from: iso(start), to: iso(end), items: items.length,
          hint: 'measure the page size and cursor once the park is entitled, then page it like pullTrips' });
    }
    const rows = items.map((it) => ({
      platform: SRC, fleet_id: config.yango.fleet, driver_ext_id: it.driver?.id,
      driver_name: decomposed(it.driver),
      plate: normPlate(it.car?.callsign), period_start: iso(start), period_end: iso(end),
      trips: it.count_orders_completed, distance_km: it.sum_distance != null ? Number(it.sum_distance) / 1000 : null,
      hours_online: it.work_time_seconds != null ? it.work_time_seconds / 3600 : null,
      /* NET, like every other channel's earnings — this was the gross.
         ─────────────────────────────────────────────────────────────────
         driver_payout_day.earnings is one column and api/income_sql.js prints
         one sentence over it: "net payout, after the platform's commission —
         this is the money that arrived". Uber's side of that column is
         netOutstanding, which is net. Yango's was price_cash + price_cashless,
         which is what the riders paid — so a quarter of Yango's line was
         Yango's own commission, described to a reader as money that arrived.

         Measured on production for August 2026: Aliyan Khalil, gross 3,069.00
         against a platform commission of -749.58, which is 24.4%. Across the
         fleet's Yango line for the month, roughly AED 1,320-1,590 of the
         5,846.06 the product reported had never reached the operator.

         price_platform_commission is filed NEGATIVE by Yango — the funnel
         route at api/analytics_routes.js reads it as it stands — so this adds
         rather than subtracts, and a row that omits the field falls back to
         the gross rather than to nothing.

         RESTATING HISTORY NEEDS A BACKFILL: rows already stored keep the
         gross until this window is collected again. */
      earnings: (Number(it.price_cash) || 0) + (Number(it.price_cashless) || 0)
        + (Number(it.price_platform_commission) || 0),
      /* Unchanged, and deliberately: cash is what the driver was handed, which
         is a fact about custody rather than about commission. */
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
    chunks.push({ from: iso(start), to: iso(end), rows: rows.length, error: null });
  }
  return total;
}

/* The roster snapshot rides on the summary response; one pass is enough and it
   is not window-keyed, so it upserts identically from any week. */
async function maybeRoster(data) {
  const roster = (data?.items || []).map((it) => stateRow({
    platform: SRC, driverExtId: it.driver?.id, fleetId: config.yango.fleet,
    name: decomposed(it.driver),
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
    const { data } = await post(YANGO_SURFACES.console.ledger,
      { query: { park: { transaction: { event_at: { from: dubai(from), to: dubai(to, true) } } } }, limit: 100, ...(cursor ? { cursor } : {}) });
    const txns = data?.transactions || [];
    const rows = txns.map((t) => ({
      platform: SRC, external_id: t.id, fleet_id: config.yango.fleet, driver_ext_id: t.driver_id,
      driver_name: nameFor(t.driver_id, t.driver_name), order_ref: t.order_id, event_at: t.event_at,
      category: t.category_id, amount: t.amount, currency: t.currency_code || 'AED', description: t.description, raw: t,
    })).filter((r) => r.external_id);
    if (rows.length) total += await upsertMany('ledger_entry', rows, ['platform', 'external_id']);
    cursor = data?.cursor;
    if (txns.length === 0) break;
  } while (cursor && ++guard < 2000);
  return total;
}

export async function collect({ from, to, mode }) {
  /* Per RUN, not for the life of the process. The collector is long-lived and
     a refusal remembered across runs would keep a recovered surface red until
     a restart. */
  keyRefusals.clear();
  consoleRefusals.clear();
  const fails = [];
  const chunks = [];
  let drivers = 0, trips = 0, ledger = 0;
  /* EACH SURFACE ON ITS OWN. Three endpoints — weekly driver summaries, the
     order list, the transaction ledger — sharing one try meant the first one
     to refuse took the other two with it, and this park refuses regularly.
     They are three different questions and two of them answering is worth
     having. */
  const surface = async (name, fn) => {
    try { return await fn(); } catch (e) {
      const why = String(e && e.message ? e.message : e).slice(0, 200);
      log.error(SRC, `${name} failed`, { err: why });
      fails.push(`${name}: ${why}`);
      return 0;
    }
  };
  let cars = 0, roster = 0;
  try {
    /* Order matters, and it is the only reason it is this way round. A trip is
       filed under the DECOMPOSED name — first_name plus last_name, the one
       whose word order we can account for — so the endpoint that decomposes is
       asked before the endpoint that files trips, and seedNames() covers the
       drivers that endpoint does not return from what the roster already holds.
       On the console this was pullDrivers; on the key host it is pullRoster,
       and it is now the only thing standing between one Yango driver and two
       person_keys. */
    const known = await surface('names', seedNames);
    roster = await surface('roster', pullRoster);
    cars = await surface('cars', pullCars);
    trips = await surface('trips', () => pullTrips(from, to));
    /* The two the key host does not serve.
       ─────────────────────────────────────────────────────────────────────
       /v1/parks/summary/drivers/list and /v1/parks/transactions/list both
       answer 404 path_not_found, so these stay on the console — which is
       refused, so they are expected to fail and their failure is not news.
       They are still ATTEMPTED, every run, because "the console started
       working again" is a fact nobody will go and check by hand, and this is
       the only thing that would notice. surface() records each refusal
       separately, so the run comes back 'partial' with the two named rather
       than 'ok' with two silent holes. */
    drivers = await surface('drivers (weekly aggregate — console only)',
      () => pullDrivers(from, to, chunks));
    ledger = await surface('ledger (console only)', () => pullLedger(from, to));
    log.info(SRC, 'names', { seeded: known, known: nameById.size });
    /* A floor the chunks can only worsen: logRun turns some-windows-failed into
       'partial' and all-failed into 'error', but it cannot see that a whole
       SURFACE was refused, because the driver weeks are the only windows here. */
    const status = fails.length === 0 ? 'ok'
      : (roster + cars + trips + drivers + ledger > 0 ? 'partial' : 'error');
    await logRun({ source: SRC, fleet_id: config.yango.fleet, mode,
      window_start: from, window_end: to, status,
      ...(chunks.length ? { chunks } : {}),
      rows_written: trips + drivers + ledger + roster + cars,
      error: fails.length ? fails.join('; ').slice(0, 500) : null });
    log[fails.length ? 'warn' : 'info'](SRC, 'done',
      { trips, roster, cars, drivers, ledger, failed: fails.length || undefined });
  } catch (e) {
    /* Every surface is guarded above, so this is the run row's own write. It
       stays because a source that throws without one disappears from the
       status page rather than showing as broken. rows_written carries what
       actually landed rather than 0 — those rows are written and durable. */
    await logRun({ source: SRC, fleet_id: config.yango.fleet, mode,
      window_start: from, window_end: to, status: 'error',
      rows_written: trips + drivers + ledger + roster + cars,
      error: [String(e), ...fails].join('; ').slice(0, 500) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
