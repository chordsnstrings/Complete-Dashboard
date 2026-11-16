/* FLIGHTS LANDING AT DUBAI — the OpenSky Network, for the Airport page.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16: "add flight details and flights actually landing,
   and how that impacts the airport trips. use api - any free api." They
   supplied an OpenSky Network API client (a free account: 4,000 credits a
   day). Everything below about OpenSky was MEASURED that day with that client
   (docs/COVERAGE.md "OpenSky Network" has the numbers); the secret itself is
   never in this repository — it is a setting (OPENSKY_CLIENT_ID /
   OPENSKY_CLIENT_SECRET).

   AUTH. OAuth2 client credentials: POST OPENSKY_TOKEN_URL with grant_type,
   client_id and client_secret as a form → {access_token, expires_in: 1800}.
   OpenSky removed Basic auth on 2026-03-18, so there is no other way in. The
   token is cached until a minute before it expires; a 401 on a data call
   forgets it and asks once more, then gives up with the reason.

   TWO READS, TWO ALLOWANCES.
     1. ARRIVALS, the record. GET /flights/arrival?airport=OMDB&begin=&end= for
        one UTC day: 438 landings at OMDB and 74 at OMDW on 2026-11-15, each
        with icao24, callsign, firstSeen, lastSeen (the landing, to within
        minutes) and an ESTIMATED departure airport (null for 163 of the 438).
        30 credits a query (X-Rate-Limit-Remaining went 3970 → 3940 → 3910).
        OpenSky publishes flights in a NIGHTLY BATCH: the same query for the
        current UTC day answered 404 while yesterday's was complete. So a day
        is asked for once it is over, re-asked while it 404s, and recorded per
        airport in flight_day_coverage — collected, not published yet, failed
        (with the reason), or none returned — so a missing day is shown absent
        WITH ITS REASON and retried, never drawn as a day nothing landed.
     2. LIVE, an estimate. GET /states/all over a box around Dubai, every two
        minutes: 1 credit a call from a SEPARATE allowance (3999 → 3998).
        OpenSky's receivers do not see Dubai's ground traffic — about four
        aircraft within 8 nm of DXB and none on the ground in the sample — so
        a landing cannot be watched; it is INFERRED from the final approach
        (approachOf below). Those rows are labelled estimates everywhere and
        are superseded by the confirmed list once OpenSky publishes that day.

   WHEN. Arrivals at 41 minutes past every third hour from 01:41 UTC (05:41
   Dubai): the first slot after the UTC day closes that is clear of every
   other pass, and the later slots catch a batch that publishes late — only
   the days not yet collected are asked, so a slot after the day is in costs
   nothing. The first run fills OPENSKY_BACKFILL_DAYS (30) days: 60 queries,
   1,800 credits, under the OPENSKY_CREDIT_FLOOR the run never spends below.
   Live every two minutes (a step of 2 over the whole hour, which node-cron
   reads from minute 0 — not a stepped RANGE, the COVERAGE trap that kept the
   wallet refresh from ever running).

   ABSENT, NEVER ZERO. With no client configured both reads record "no OpenSky
   client configured" — a collection_run row (source 'opensky', /api/status)
   and, for live, the hour's last_error — and write no landing and no
   coverage row, so the Airport page says why there is nothing rather than
   drawing an empty sky. */
import { createHash } from 'node:crypto';
import { get, getInt } from '../settings.js';
import { logRun, pool } from '../db.js';
import { http as realHttp, qs } from '../http.js';
import { log as defaultLog } from '../log.js';

export const SOURCE = 'opensky';
export const NO_CLIENT = 'no OpenSky client configured — set OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET on the Settings page';

/* The airports the final-approach rule knows. OMSJ is a DECOY: Sharjah
   International stands about 9.5 nm north-east of DXB with a parallel runway
   (12/30), and its arrivals must be recognised as Sharjah's so they are never
   counted as Dubai's. count:false means "detected, named, not stored".
   Runway headings are the runways' directions, 12 ≈ 120° and 30 ≈ 300°, at
   all three airports (DXB's 12L/30R and 12R/30L are parallel). */
export const APPROACH_AIRPORTS = {
  OMDB: { lat: 25.2528, lon: 55.3644, runways: [120, 300], count: true },
  OMDW: { lat: 24.8960, lon: 55.1610, runways: [120, 300], count: true },
  OMSJ: { lat: 25.3286, lon: 55.5172, runways: [120, 300], count: false },
};
/* The live box: DWC's south-west corner to beyond Sharjah, 0.75° × 0.70° —
   under OpenSky's smallest area band, so 1 credit a call. */
export const LIVE_BOX = { lamin: 24.70, lomin: 54.95, lamax: 25.45, lomax: 55.65 };

/* THE FINAL-APPROACH RULE.
   ─────────────────────────────────────────────────────────────────────────
   An aircraft is landing at an airport when, from its last position report:
     · the airport is AHEAD of it along its track, at most maxDistNm away
       (along-track distance ≥ minAlongNm, so a little past the threshold
       still counts — the reference point sits mid-field);
     · it is within maxCrossNm of the line through the airport along its
       track — i.e. lined up with the field, not passing beside it;
     · its track is within trackTolDeg of a runway heading;
     · it is low (≤ maxAltM, barometric, else geometric altitude) and
       descending (vertical rate ≤ −minDescentMs) — or on the ground and
       still rolling (over 20 m/s) within 3 nm, which OpenSky has not shown
       at Dubai but costs nothing to accept.
   On a 3° glide path an aircraft is ~580 m up at 6 nm, so 900 m at 6 nm
   leaves room for a level segment without admitting overflights.
   The lateral test is what keeps Sharjah's traffic off DXB: the two fields'
   extended centre lines run parallel about 8 nm apart, so no aircraft can be
   within 1.5 nm of both — and the decoy entry above claims OMSJ's own. */
export const APPROACH_RULE = Object.freeze({
  maxDistNm: 6, maxCrossNm: 1.5, minAlongNm: -0.5, trackTolDeg: 20, maxAltM: 900, minDescentMs: 0.5,
});
const RAD = Math.PI / 180;
const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360) + 360) % 360; return d > 180 ? 360 - d : d; };
const runwayName = (h) => String(Math.round(h / 10)).padStart(2, '0');

/** Which airport (if any) a state vector is on final approach to.
    `sv` is OpenSky's array: [icao24, callsign, origin_country, time_position,
    last_contact, lon, lat, baro_altitude, on_ground, velocity, true_track,
    vertical_rate, sensors, geo_altitude, squawk, spi, position_source,
    category]. Returns null, or {airport, counted, runway, along_nm,
    cross_nm, dist_nm, alt_m, eta_s}. Pure: the poller and the tests both
    call it. */
export function approachOf(sv, { airports = APPROACH_AIRPORTS, rule = APPROACH_RULE } = {}) {
  if (!Array.isArray(sv)) return null;
  const lon = sv[5], lat = sv[6], baro = sv[7], onGround = sv[8] === true;
  const vel = sv[9], track = sv[10], vrate = sv[11], geo = sv[13];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(track)) return null;
  const alt = Number.isFinite(baro) ? baro : (Number.isFinite(geo) ? geo : null);
  let best = null;
  for (const [icao, ap] of Object.entries(airports)) {
    /* Aircraft → airport in nautical miles on a local flat grid: a degree of
       latitude is 60 nm, a degree of longitude 60·cos(lat). At 6 nm the
       error of the flat grid is metres. */
    const n = (ap.lat - lat) * 60;
    const e = (ap.lon - lon) * 60 * Math.cos(((ap.lat + lat) / 2) * RAD);
    const dist = Math.hypot(n, e);
    if (dist > rule.maxDistNm) continue;
    const heading = ap.runways.find((h) => angDiff(track, h) <= rule.trackTolDeg);
    if (heading == null) continue;
    const ux = Math.sin(track * RAD), uy = Math.cos(track * RAD);   // east, north
    const along = n * uy + e * ux;
    const cross = Math.abs(n * ux - e * uy);
    if (along < rule.minAlongNm || cross > rule.maxCrossNm) continue;
    if (onGround) {
      if (dist > 3 || !(vel > 20)) continue;
    } else {
      if (alt == null || alt > rule.maxAltM) continue;
      if (!(Number.isFinite(vrate) && vrate <= -rule.minDescentMs)) continue;
    }
    const speed = Number.isFinite(vel) && vel > 30 ? vel : 70;   // m/s; ~136 kt is a typical final
    const cand = {
      airport: icao, counted: ap.count !== false, runway: runwayName(heading),
      along_nm: Math.round(along * 100) / 100, cross_nm: Math.round(cross * 100) / 100,
      dist_nm: Math.round(dist * 100) / 100, alt_m: alt, eta_s: Math.max(0, Math.round((Math.max(0, along) * 1852) / speed)),
    };
    if (!best || cand.cross_nm < best.cross_nm) best = cand;
  }
  return best;
}

/* ── the client ──────────────────────────────────────────────────────────── */
export class OpenSkyError extends Error {
  constructor(kind, message, { status = null, retryAfter = null, credits = null } = {}) {
    super(message);
    this.kind = kind; this.status = status; this.retryAfter = retryAfter; this.credits = credits;
  }
}
let tokenCache = null;   // { key, token, exp } — memory only, never stored
/** For tests: forget the cached token. */
export const forgetToken = () => { tokenCache = null; };
const numHeader = (h, k) => { const v = h?.get ? h.get(k) : null; const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : null; };

/** The configured client, or null when either half is missing. */
export function clientConfig() {
  const id = String(get('OPENSKY_CLIENT_ID', '') || '').trim();
  const secret = String(get('OPENSKY_CLIENT_SECRET', '') || '').trim();
  if (!id || !secret) return null;
  return { clientId: id, clientSecret: secret,
    apiUrl: String(get('OPENSKY_API_URL', 'https://opensky-network.org/api')).replace(/\/+$/, ''),
    tokenUrl: String(get('OPENSKY_TOKEN_URL', 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token')) };
}

/** A client over one configuration. `http` and `now` are seams for tests. */
export function makeClient(cfg, { http = realHttp, now = () => Date.now() } = {}) {
  /* The cache is keyed by the endpoint, the client id and a hash of the
     secret, so a secret replaced on the Settings page is never answered with
     the old secret's token. */
  const key = `${cfg.tokenUrl}|${cfg.clientId}|${createHash('sha256').update(cfg.clientSecret).digest('hex').slice(0, 16)}`;
  const token = async () => {
    if (tokenCache && tokenCache.key === key && tokenCache.exp - 60_000 > now()) return tokenCache.token;
    const r = await http(cfg.tokenUrl, {
      method: 'POST', retries: 1, retryOn: [502, 503, 504], timeoutMs: 30000,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: qs({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.clientSecret }),
    });
    const tok = r.ok && r.data && typeof r.data === 'object' ? r.data.access_token : null;
    if (!tok) {
      /* Never the body: a token endpoint may echo what it was sent. */
      throw new OpenSkyError('auth', r.status === 401 || r.status === 400
        ? `OpenSky refused the API client (HTTP ${r.status}) — check OPENSKY_CLIENT_ID and OPENSKY_CLIENT_SECRET`
        : `OpenSky's token endpoint answered HTTP ${r.status}`, { status: r.status });
    }
    const life = Number(r.data.expires_in) > 0 ? Number(r.data.expires_in) * 1000 : 1800_000;
    tokenCache = { key, token: tok, exp: now() + life };
    return tok;
  };
  /** GET a path under the API. Resolves {status, data, credits} for 200 and
      404 (a 404 is an ANSWER here: "no flights", or "not published yet");
      throws OpenSkyError for a refusal, a rate limit or anything else. */
  const getJson = async (path, params) => {
    const url = `${cfg.apiUrl}${path}?${qs(params)}`;
    const once = async () => http(url, { retries: 1, retryOn: [502, 503, 504], timeoutMs: 60000,
      headers: { authorization: `Bearer ${await token()}` } });
    let r = await once();
    if (r.status === 401) { tokenCache = null; r = await once(); }
    const credits = numHeader(r.headers, 'x-rate-limit-remaining');
    if (r.status === 200 || r.status === 404) return { status: r.status, data: r.data, credits };
    if (r.status === 401 || r.status === 403) {
      throw new OpenSkyError('auth', `OpenSky refused the token (HTTP ${r.status}) after one fresh sign-in`, { status: r.status, credits });
    }
    if (r.status === 429) {
      const retryAfter = numHeader(r.headers, 'x-rate-limit-retry-after-seconds');
      throw new OpenSkyError('rate', `OpenSky's daily credit limit is reached (HTTP 429)${retryAfter != null ? `; it says retry after ${retryAfter} s` : ''}`,
        { status: 429, retryAfter, credits });
    }
    throw new OpenSkyError('http', `OpenSky answered HTTP ${r.status}`, { status: r.status, credits });
  };
  return { token, getJson };
}

/* ── arrivals: the confirmed record ─────────────────────────────────────── */
const DAY_MS = 86400e3;
/* UTC days ON PURPOSE: OpenSky partitions flights by UTC day, and a "day"
   here is the unit it is asked for and published in. The Airport page turns
   landings into Dubai hours itself. Built from a number, never from a clock
   read as a business date (test/timezone.test.mjs §2b). */
export const utcDayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayStartSec = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

/** The (airport, day) pairs a run should ask for, newest first: every UTC day
    from yesterday back `days`, except those already collected, an old day
    OpenSky has answered "none" for three times, and nothing from today
    (which OpenSky has not published by construction). */
export function planDays({ nowMs, days, coverage, airports = ['OMDB', 'OMDW'] }) {
  const have = new Map(coverage.map((c) => [`${c.airport}|${c.utc_day}`, c]));
  const out = [];
  for (let k = 1; k <= days; k++) {
    const day = utcDayOf(nowMs - k * DAY_MS);
    for (const airport of airports) {
      const c = have.get(`${airport}|${day}`);
      if (c?.status === 'collected') continue;
      if (c?.status === 'none_returned' && (c.attempts || 0) >= 3) continue;
      out.push({ airport, day });
    }
  }
  return out;
}

const landingRow = (airport, day, f) => ({
  airport, icao24: String(f.icao24 || '').toLowerCase(), callsign: f.callsign ? String(f.callsign).trim() || null : null,
  landed_at: new Date(f.lastSeen * 1000).toISOString(),
  first_seen: Number.isFinite(f.firstSeen) ? new Date(f.firstSeen * 1000).toISOString() : null,
  origin: f.estDepartureAirport ? String(f.estDepartureAirport).trim() || null : null,
  arrival_horiz_m: Number.isFinite(f.estArrivalAirportHorizDistance) ? Math.round(f.estArrivalAirportHorizDistance) : null,
  arrival_vert_m: Number.isFinite(f.estArrivalAirportVertDistance) ? Math.round(f.estArrivalAirportVertDistance) : null,
  utc_day: day, raw: JSON.stringify(f),
});

/** Store one airport-day's landings — idempotently: the key is
    (airport, icao24, landed_at), so a day stored twice is the same rows. */
export async function storeLandings(db, airport, day, flights) {
  const rows = (Array.isArray(flights) ? flights : [])
    .filter((f) => f && f.icao24 && Number.isFinite(f.lastSeen))
    .map((f) => landingRow(airport, day, f));
  /* One row per key within the batch: Postgres refuses an INSERT … ON
     CONFLICT that touches the same key twice in one statement. */
  const uniq = [...new Map(rows.map((r) => [`${r.icao24}|${r.landed_at}`, r])).values()];
  const cols = ['airport', 'icao24', 'callsign', 'landed_at', 'first_seen', 'origin', 'arrival_horiz_m', 'arrival_vert_m', 'utc_day', 'raw'];
  for (let i = 0; i < uniq.length; i += 200) {
    const part = uniq.slice(i, i + 200);
    const params = [];
    const tuples = part.map((r) => `(${cols.map((c) => { params.push(r[c]); return `$${params.length}`; }).join(', ')})`);
    await db.query(`INSERT INTO flight_landing (${cols.join(', ')}) VALUES ${tuples.join(', ')}
      ON CONFLICT (airport, icao24, landed_at) DO UPDATE SET
        callsign = EXCLUDED.callsign, first_seen = EXCLUDED.first_seen, origin = EXCLUDED.origin,
        arrival_horiz_m = EXCLUDED.arrival_horiz_m, arrival_vert_m = EXCLUDED.arrival_vert_m,
        utc_day = EXCLUDED.utc_day, raw = EXCLUDED.raw, collected_at = now()`, params);
  }
  return uniq.length;
}

async function noteDay(db, { airport, day, status, landings = null, reason = null, credits = null }) {
  await db.query(`INSERT INTO flight_day_coverage
      (airport, utc_day, status, landings, reason, attempts, credits_remaining, collected_at)
    VALUES ($1, $2::date, $3, $4, $5, 1, $6, CASE WHEN $3 = 'collected' THEN now() END)
    ON CONFLICT (airport, utc_day) DO UPDATE SET
      status = EXCLUDED.status, landings = EXCLUDED.landings, reason = EXCLUDED.reason,
      attempts = flight_day_coverage.attempts + 1, credits_remaining = EXCLUDED.credits_remaining,
      last_tried_at = now(),
      collected_at = CASE WHEN EXCLUDED.status = 'collected' THEN now() ELSE flight_day_coverage.collected_at END`,
  [airport, day, status, landings, reason, credits]);
}

/** Once a day's confirmed list is in, the live estimates for that UTC day at
    that airport are superseded, each pointed at the confirmed landing it
    matches (same aircraft within 30 minutes) when there is one — which is
    what lets the page say how many landings the live watch caught. */
export async function supersedeLive(db, airport, day) {
  const r = await db.query(`UPDATE flight_live_landing l SET superseded_at = now(),
      confirmed_id = (SELECT f.id FROM flight_landing f
                       WHERE f.airport = l.airport AND f.icao24 = l.icao24
                         AND abs(extract(epoch FROM f.landed_at - l.landed_at)) <= 1800
                       ORDER BY abs(extract(epoch FROM f.landed_at - l.landed_at)) LIMIT 1)
    WHERE l.airport = $1 AND l.superseded_at IS NULL
      AND l.landed_at >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND l.landed_at < (($2::date + 1)::timestamp AT TIME ZONE 'UTC')`, [airport, day]);
  return r.affectedRows ?? r.rowCount ?? 0;
}

/** The arrivals run. Asks for each planned (airport, day), newest first,
    until the plan is done, the credit floor is reached, or OpenSky refuses. */
export async function collectArrivals({ db = pool, cfg = clientConfig(), client = null, nowMs = Date.now(),
  days = getInt('OPENSKY_BACKFILL_DAYS', 30), floor = getInt('OPENSKY_CREDIT_FLOOR', 600), log = defaultLog } = {}) {
  const span = { window_start: utcDayOf(nowMs - days * DAY_MS), window_end: utcDayOf(nowMs - DAY_MS) };
  if (!cfg && !client) {
    await logRun({ source: SOURCE, fleet_id: null, mode: 'arrivals', status: 'error', rows_written: 0, ...span, error: NO_CLIENT }, db);
    return { skipped: NO_CLIENT };
  }
  const c = client || makeClient(cfg);
  const coverage = (await db.query(`SELECT airport, utc_day::text AS utc_day, status, attempts FROM flight_day_coverage
                                     WHERE utc_day >= $1::date`, [span.window_start])).rows;
  const todo = planDays({ nowMs, days, coverage });
  const yesterday = utcDayOf(nowMs - DAY_MS);
  const chunks = [];
  let written = 0, credits = null, stopped = null, fatal = null;
  for (const { airport, day } of todo) {
    if (credits != null && credits < floor) { stopped = `stopped at ${credits} credits left, under the floor of ${floor}`; break; }
    try {
      const begin = dayStartSec(day);
      const r = await c.getJson('/flights/arrival', { airport, begin, end: begin + 86400 - 1 });
      if (r.credits != null) credits = r.credits;
      /* A 200 is an answer only when it carries a LIST. storeLandings keeps
         array rows only, so a 200 holding anything else — the login page a
         redirect lands on (http() follows redirects silently and leaves a
         non-JSON body as text), or an error object — stored nothing and the
         day was written 'collected' with 0 landings: never asked again, and
         counted by /api/airport as a complete day on which nothing landed.
         This is the FMS trap src/http.js's header records ("a window that
         was asked and answered with nothing"), and the review of 2026-11-16
         found it here (FIX-STATUS FLT-R5). Such a day is now 'failed' with
         the reason and retried. An EMPTY list is OpenSky's "none" said
         another way — its documented answer for no flights is a 404 — so
         it is read exactly as a 404 is: not published yet for yesterday,
         none returned for an older day, never a collected zero. */
      if (r.status === 200 && !Array.isArray(r.data)) {
        throw new OpenSkyError('http', `OpenSky answered HTTP 200 without a list of arrivals (${typeof r.data === 'string'
          ? 'a page of text — a redirect to a sign-in page, perhaps' : `a${r.data === null ? ' null' : 'n object'}`})`, { status: 200, credits: r.credits });
      }
      if (r.status === 404 || r.data.length === 0) {
        /* A 404 means "no flights for that interval". For yesterday that is
           the nightly batch not having run yet — measured: today 404'd while
           yesterday held 438. For an older day it is a day OpenSky does not
           hold or saw nothing on; asked at most three times. */
        const fresh = day >= yesterday;
        const reason = fresh ? 'OpenSky has not published this day yet — its flights arrive in a nightly batch'
          : `OpenSky answered that it holds no arrivals for this day (${r.status === 404 ? 'HTTP 404' : 'an empty list'})`;
        await noteDay(db, { airport, day, status: fresh ? 'not_published' : 'none_returned', reason, credits });
        chunks.push({ from: day, to: day, rows: 0, kind: airport, note: reason });
        continue;
      }
      const n = await storeLandings(db, airport, day, r.data);
      await noteDay(db, { airport, day, status: 'collected', landings: n, credits });
      await supersedeLive(db, airport, day);
      written += n;
      chunks.push({ from: day, to: day, rows: n, kind: airport });
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      if (e instanceof OpenSkyError && (e.kind === 'auth' || e.kind === 'rate')) {
        /* A refusal of the client or of today's allowance is about every day,
           not this one: the run stops and says so, and the day keeps the
           state it had (a rate limit is still written on it, so the page can
           say why the newest day is late). */
        if (e.kind === 'rate') await noteDay(db, { airport, day, status: 'failed', reason: msg, credits: e.credits });
        fatal = msg;
        chunks.push({ from: day, to: day, rows: 0, kind: airport, error: msg });
        break;
      }
      await noteDay(db, { airport, day, status: 'failed', reason: msg, credits });
      chunks.push({ from: day, to: day, rows: 0, kind: airport, error: msg });
      log.warn?.(SOURCE, 'arrivals day failed', { airport, day, err: msg });
    }
  }
  /* A run with nothing to ask is 'ok' with no windows: every day in the span
     is already in. */
  await logRun({ source: SOURCE, fleet_id: null, mode: 'arrivals', ...span, rows_written: written,
    status: fatal ? 'error' : 'ok', error: fatal || null, chunks: chunks.length ? chunks : null,
    ...(stopped ? { error: stopped, status: 'partial' } : {}) }, db);
  return { asked: chunks.length, planned: todo.length, written, credits, stopped, error: fatal };
}

/* ── live: the estimate ─────────────────────────────────────────────────── */
let backoffUntil = 0;
let lastLive = null;       // { status, at } — what was last written to collection_run
/** For tests: reset the live poller's memory. */
export const resetLive = () => { backoffUntil = 0; lastLive = null; };
const hourStart = (ms) => new Date(Math.floor(ms / 3600e3) * 3600e3).toISOString();

async function noteHour(db, nowMs, { ok, seen = 0, error = null }) {
  await db.query(`INSERT INTO flight_live_hour (hour_start, polls, polls_ok, aircraft_seen, last_error, last_poll_at)
      VALUES ($1, 1, $2, $3, $4, $5)
    ON CONFLICT (hour_start) DO UPDATE SET polls = flight_live_hour.polls + 1,
      polls_ok = flight_live_hour.polls_ok + EXCLUDED.polls_ok,
      aircraft_seen = flight_live_hour.aircraft_seen + EXCLUDED.aircraft_seen,
      last_error = COALESCE(EXCLUDED.last_error, flight_live_hour.last_error), last_poll_at = EXCLUDED.last_poll_at`,
  [hourStart(nowMs), ok ? 1 : 0, seen, error, new Date(nowMs).toISOString()]);
}

/* The poller writes a collection_run when its outcome changes or every 30
   minutes — not 720 rows a day of "ok". */
async function noteLiveRun(db, nowMs, run) {
  if (lastLive && lastLive.status === run.status && lastLive.error === (run.error || null) && nowMs - lastLive.at < 30 * 60e3) return;
  lastLive = { status: run.status, error: run.error || null, at: nowMs };
  await logRun({ source: SOURCE, fleet_id: null, mode: 'live', ...run }, db);
}

/** Store a detected landing, one row per aircraft and airport within 20
    minutes: an approach seen on two consecutive polls refines its estimate
    instead of becoming a second landing. */
export async function storeLive(db, det, sv, seenMs) {
  const landed = new Date(seenMs + det.eta_s * 1000).toISOString();
  const vals = [det.airport, String(sv[0]).toLowerCase(), sv[1] ? String(sv[1]).trim() || null : null, landed,
    new Date(seenMs).toISOString(), det.runway, det.dist_nm, det.alt_m, sv[10], sv[11], sv[9], JSON.stringify(sv)];
  const upd = await db.query(`UPDATE flight_live_landing SET callsign = COALESCE($3, callsign), landed_at = $4, seen_at = $5,
      runway = $6, dist_nm = $7, alt_m = $8, track_deg = $9, vrate_ms = $10, speed_ms = $11, raw = $12
    WHERE id = (SELECT id FROM flight_live_landing WHERE airport = $1 AND icao24 = $2 AND superseded_at IS NULL
                  AND abs(extract(epoch FROM landed_at - $4::timestamptz)) <= 1200 ORDER BY id DESC LIMIT 1)
    RETURNING id`, vals);
  if (upd.rows.length) return { id: upd.rows[0].id, fresh: false };
  const ins = await db.query(`INSERT INTO flight_live_landing (airport, icao24, callsign, landed_at, seen_at, runway,
      dist_nm, alt_m, track_deg, vrate_ms, speed_ms, raw) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`, vals);
  return { id: ins.rows[0].id, fresh: true };
}

/** One live poll. */
export async function pollLive({ db = pool, cfg = clientConfig(), client = null, nowMs = Date.now(), log = defaultLog } = {}) {
  if (!cfg && !client) {
    await noteHour(db, nowMs, { ok: false, error: NO_CLIENT });
    await noteLiveRun(db, nowMs, { status: 'error', rows_written: 0, error: NO_CLIENT });
    return { skipped: NO_CLIENT };
  }
  if (backoffUntil > nowMs) {
    const why = `backing off after OpenSky's rate limit until ${new Date(backoffUntil).toISOString().slice(11, 16)} UTC`;
    await noteHour(db, nowMs, { ok: false, error: why });
    return { skipped: why };
  }
  const c = client || makeClient(cfg);
  try {
    const r = await c.getJson('/states/all', { ...LIVE_BOX, extended: 1 });
    /* Only a 200 carrying a `states` field is an answer. getJson resolves a
       404 (an ANSWER on /flights/*, where it means "no flights"), and this
       read used to take a 404 — or a 200 with no `states` in it — as an
       empty sky: the poll counted as answered, the hour as watched, and the
       Airport page drew "0 landings, live estimate" for an hour nothing was
       measured. A moved endpoint or a wrong OPENSKY_API_URL would have done
       that to every hour (review of 2026-11-16; FIX-STATUS FLT-R4). OpenSky
       sends `states: null` when the box is empty — that IS an answer. */
    if (r.status !== 200 || !r.data || typeof r.data !== 'object' || !('states' in r.data)) {
      throw new OpenSkyError('http', r.status !== 200
        ? `OpenSky answered HTTP ${r.status} for the live positions`
        : 'OpenSky answered the live positions without a states field', { status: r.status, credits: r.credits });
    }
    const states = Array.isArray(r.data.states) ? r.data.states : [];
    let landing = 0, sharjah = 0;
    for (const sv of states) {
      const det = approachOf(sv);
      if (!det) continue;
      if (!det.counted) { sharjah++; continue; }
      const t = Number.isFinite(sv[3]) ? sv[3] * 1000 : (Number.isFinite(sv[4]) ? sv[4] * 1000 : nowMs);
      const s = await storeLive(db, det, sv, t);
      if (s.fresh) landing++;
    }
    await noteHour(db, nowMs, { ok: true, seen: states.length });
    await noteLiveRun(db, nowMs, { status: 'ok', rows_written: landing });
    return { seen: states.length, landing, sharjah, credits: r.credits };
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    if (e instanceof OpenSkyError && e.kind === 'rate') backoffUntil = nowMs + (e.retryAfter ?? 3600) * 1000;
    await noteHour(db, nowMs, { ok: false, error: msg });
    await noteLiveRun(db, nowMs, { status: 'error', rows_written: 0, error: msg });
    log.warn?.(SOURCE, 'live poll failed', { err: msg });
    return { error: msg };
  }
}
