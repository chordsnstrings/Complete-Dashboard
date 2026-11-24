/* GET /api/probe/movement — four documented movement surfaces we have never called.
   ══════════════════════════════════════════════════════════════════════════
   WHY THIS EXISTS. The driver-movement views want to know where a car was
   BETWEEN bookings, and every source we collect answers that coarsely: FMS's
   live poll every 6.2 min at the median and CABMAN's every 5.0 (docs/
   COVERAGE.md, "The window, measured", 89 plates 8–16 Nov), plus each
   platform's pickup and drop-off. Three providers document finer surfaces that
   nothing in this repository has ever asked:

     fms_activity    InfoTrack GetVehicleActivity(username, Password, vehicleno,
                     fromdate, todate) — IDLE/STOP/TRAVEL segments with start
                     and end positions and distance (docs/fleet-tracking-api-
                     reference.md §2; FIXLIST #118, "never called").
     yango_track     POST /v1/parks/orders/track?park_id=&order_id= on the keyed
                     Fleet API host — the GPS trace of one order.
     bolt_states     fleet-integration getFleetStateLogs — each driver's state
                     (inactive / waiting_orders / has_order / busy) with a
                     position (docs/COVERAGE.md, "getFleetStateLogs (not
                     collected)"; FIXLIST #77).
     cabman_cadence  not a new surface: GetIVDData, asked five times fifteen
                     seconds apart, to see whether a moving unit's own fix time
                     advances faster than our five-minute poll can see.

   The operator approved running them on 2026-11-24 ("run the probes") so that
   whether to COLLECT any of them is decided on measurements rather than on a
   provider's brochure. This route is the instrument; it decides nothing.

   ONE `which` PER CALL. Each probe has to finish inside the platform's request
   timeout, and FMS alone is up to 24 calls; so a request runs one probe, under
   a BUDGET_MS deadline, and a call the deadline would cut short is reported as
   skipped for that reason rather than silently missing.

   THE RULES (api/probe.js's header and src/probe.js's, restated because this
   route handles personal data more directly than any sibling — a driver's
   position over time is the most sensitive thing this product can hold):

   1. Fixed, documented operations only. The caller picks WHICH of four named
      probes runs and may tune a few small integers (how many cars, how many
      days back, how many calls). No URL, operation name, header or body is
      ever taken from the request, so this cannot be turned into a proxy onto
      the fleet's credentials. Every verb is a read — POST only where the
      provider documents a read as POST (Yango's track, Bolt's gateway).
   2. Tiny windows: a day, a week at most, and single days far back for depth.
   3. SHAPE leaves this module, never a record. What a probe returns is field
      NAMES with fill rates, counts, time spans as dates, spacing and duration
      statistics, and value distributions ONLY for the one narrow enumeration
      each probe is about (acttype, order_status, state) — and even there a
      value must be enumeration-shaped (enumValue below) or it is counted and
      withheld. Never a coordinate (a lat/lon is reported as a fill rate),
      never an id, a plate, a name, a phone, an address or a credential. Cars
      and orders are "car 1", "order 2"; drivers are a count.
   4. Every error text passes through scrubber() below before it is returned:
      the URL query (FMS takes its password there) is cut, every configured
      credential value and every plate/order id this request used is replaced,
      and anything shaped like a token, a uuid, a long hex id, a coordinate or
      a phone number is masked. api/redact.js is the authority on which KEYS
      are secret; it has no string scrubber, and audit.js's scrub() is
      key-based too, so the value-based one lives here.
   5. Errors are answered in the body with HTTP 200 (`error` on the probe, the
      fleet or the call) — a probe that 500s tells the operator nothing about
      which of four providers failed. Only a request this route cannot
      interpret (an unknown `which` or `fleet`) is a 400.

   Nothing here writes: not to the database, not to credential_state, not to
   settings. It reads telemetry_snapshot and trip only to choose which cars and
   orders to ask about.

   The provider calls go through src/http.js with retries: 0 (a probe that
   retries hides the answer it was asked for) and through the same credential
   lookups the collectors use: config.fms / config.yango / config.bolt /
   config.cabman, and fiToken() from src/sources/bolt.js for the Bolt bearer —
   borrowed rather than re-minted, for the reason api/probe.js gives at its
   imports. GetVehicleActivity, the track call and getFleetStateLogs have no
   exported helper in src/sources/ (nothing collects them), so the request is
   written here, minimally, in the collectors' own transport: FMS's query
   string with `Password` spelled as GetTripPassenger spells it, Yango's
   keyHeaders() pair, Bolt's company_ids array beside company_id exactly as
   getFleetOrders sends it. */

import { config } from '../src/config.js';
import { http, qs, sleep as realSleep } from '../src/http.js';
import { pool } from '../src/db.js';
import { loadSettings as realLoadSettings } from '../src/settings.js';
import { fiToken as realFiToken } from '../src/sources/bolt.js';
import { dubaiIso, parseFmsTime, hmsToSeconds } from '../src/util.js';

export const MOVEMENT_PROBES = Object.freeze(['fms_activity', 'yango_track', 'bolt_states', 'cabman_cadence']);
const FLEETS = ['ecosine', 'egari'];

/* Under the platform's request timeout with room to spare: the App Platform
   edge drops a request that has not answered in about 100 s, and a probe that
   is cut off returns nothing at all — so the deadline is the probe's own. */
export const BUDGET_MS = 80_000;
const DAY_MS = 864e5;

/* ── small numeric helpers ─────────────────────────────────────────────── */
const round1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);

/* min / median / p90 / max, nearest-rank for the tail. A distribution, never
   the values: n numbers in, five out. */
export function stats(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: null, median: null, p90: null, max: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  const p90 = v[Math.min(v.length - 1, Math.max(0, Math.ceil(0.9 * v.length) - 1))];
  return { n: v.length, min: round1(v[0]), median: round1(median), p90: round1(p90), max: round1(v[v.length - 1]) };
}

/* ── the scrubber ──────────────────────────────────────────────────────────
   Built per request from the credentials config holds right now plus the
   plates and order ids this request chose, longest first so a value that
   contains another is replaced whole. Values under four characters are left
   alone: CABMAN's interface id is "81", and masking every "81" in a sentence
   would garble it while protecting nothing (it is not a secret; settings.js
   marks it so). Exported so the test can hold it to its promise directly. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function scrubber(values = []) {
  const vals = [...new Set(values.filter((s) => s != null).map(String).filter((s) => s.length >= 4)
    .flatMap((s) => [s, encodeURIComponent(s)]))].sort((a, b) => b.length - a.length);
  return (text, max = 300) => {
    let t = String(text ?? '');
    t = t.replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/gi, '$1?(query withheld)');
    for (const v of vals) t = t.split(v).join('(withheld)');
    t = t.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer (withheld)')
      .replace(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*/g, '(token withheld)')
      .replace(UUID, '(id)')
      .replace(/\b[0-9a-f]{20,}\b/gi, '(id)')
      .replace(/-?\d{1,3}\.\d{4,}/g, '(number)')
      .replace(/\+?\d{7,}/g, '(digits)');
    return t.slice(0, max);
  };
}

/* Every credential config holds, whichever probe runs: an error from one
   provider has been known to echo another's request (a proxy page quoting the
   URL), and a value that is not present costs nothing to look for. */
function credentialValues() {
  const out = [];
  for (const f of config.fms?.fleets || []) out.push(f.username, f.password);
  for (const f of config.cabman?.fleets || []) out.push(f.user, f.pass, f.interfaceId);
  const y = config.yango || {};
  out.push(y.apiKey, y.clientId, y.parkId, y.cookie);
  const b = config.bolt || {};
  out.push(b.clientId, b.clientSecret, b.refreshToken);
  return out;
}

/* ── shape reducers ────────────────────────────────────────────────────── */

/* A key that is itself data — some APIs key a map by driver id — is reported
   as its shape, so a field list cannot become an id list. */
const ID_SHAPED_KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|\+?\d{5,}|[A-Z]{0,3}\d{4,})$/i;
const safeKey = (k) => (ID_SHAPED_KEY.test(k) ? '(id-shaped key)' : String(k).slice(0, 48));
const isFilled = (v) => v != null && v !== '' && !(Array.isArray(v) && !v.length)
  && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/* Field names with the share of records that carried a non-empty value, two
   levels deep (a track point's `location.lat` is one level down). Names and
   percentages only — nothing of any value. */
export function fieldFill(records, { depth = 2, max = 60 } = {}) {
  const rows = (records || []).filter((r) => r && typeof r === 'object' && !Array.isArray(r));
  const seen = new Map();
  for (const rec of rows) {
    const filledHere = new Set();
    const walk = (obj, prefix, d) => {
      for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${safeKey(k)}` : safeKey(k);
        if (v && typeof v === 'object' && !Array.isArray(v) && d > 1) { walk(v, path, d - 1); continue; }
        if (!seen.has(path)) seen.set(path, { key: path, type: typeOf(v), filled: 0 });
        const f = seen.get(path);
        if (f.type === 'null' && v !== null) f.type = typeOf(v);
        if (isFilled(v) && !filledHere.has(path)) { filledHere.add(path); f.filled += 1; }
      }
    };
    walk(rec, '', depth);
  }
  const all = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key))
    .map((f) => ({ key: f.key, type: f.type, fill_pct: pct(f.filled, rows.length) }));
  return all.length > max ? [...all.slice(0, max), { key: `(${all.length - max} more fields not listed)` }] : all;
}

/* What an enumeration value looks like: one token of letters, `_` or `-`
   (waiting_orders, TRAVEL, transporting), or an ALL-CAPS phrase. A personal
   name has a space and mixed case; an id has digits; an address has both —
   none of them passes, and each is counted rather than echoed. */
const enumValue = (s) => /^[A-Za-z][A-Za-z_-]{0,31}$/.test(s) || /^[A-Z][A-Z _-]{0,31}$/.test(s);
export function enumDist(values, max = 12) {
  const counts = new Map();
  let withheld = 0, empty = 0;
  for (const raw of values) {
    if (raw == null || String(raw).trim() === '') { empty += 1; continue; }
    const s = String(raw).trim();
    if (!enumValue(s)) { withheld += 1; continue; }
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  if (counts.size > max) {
    return { '(wider than an enumeration — values not reported)': values.length - empty - withheld,
      distinct: counts.size, ...(withheld ? { '(not enumeration-shaped, withheld)': withheld } : {}),
      ...(empty ? { '(empty)': empty } : {}) };
  }
  const out = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]));
  if (withheld) out['(not enumeration-shaped, withheld)'] = withheld;
  if (empty) out['(empty)'] = empty;
  return out;
}

/* The first key across the records matching any of the patterns, in order. */
const keyLike = (records, ...res) => {
  for (const re of res) {
    for (const r of records) for (const k of Object.keys(r || {})) if (re.test(k)) return k;
  }
  return null;
};

/* A timestamp in any of the shapes these providers send, to epoch ms. Naive
   local times are Dubai's (FMS's convention; parseFmsTime stamps +04:00). */
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  const s = String(v).trim();
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  const wcf = /\/Date\((\d+)/.exec(s);
  if (wcf) return Number(wcf[1]);
  const fms = parseFmsTime(s);
  if (fms) return Date.parse(fms);
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return Date.parse(`${s.replace(' ', 'T')}+04:00`);
  const p = Date.parse(s);
  return Number.isFinite(p) ? p : null;
}
const dayOf = (ms) => (ms == null ? null : dubaiIso(new Date(ms)));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, '')); return Number.isFinite(n) ? n : null; };

/* The record list in an answer: under a key the provider is known to use,
   even when empty (an empty list is an answer; "no list" is a different
   one), else the first array of objects anywhere two levels down. */
function listIn(data, keys = []) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return null;
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') return v;
  for (const v of Object.values(data)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const k of keys) if (Array.isArray(v[k])) return v[k];
      for (const w of Object.values(v)) if (Array.isArray(w) && w.length && w[0] && typeof w[0] === 'object') return w;
    }
  }
  return null;
}
/* A JSON answer that is a string holding JSON (WCF does this) is read through. */
const asJson = (d) => {
  if (typeof d !== 'string') return d;
  const s = d.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return d;
  try { return JSON.parse(s); } catch { return d; }
};
/* The provider's own words on a refusal, scrubbed — the message-shaped keys
   only, never the payload. */
const MESSAGE_KEYS = ['code', 'message', 'Message', 'error', 'error_hint', 'error_description', 'errormessage', 'fault', 'status_message'];
function providerSaid(d, scrub) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const said = {};
  for (const k of MESSAGE_KEYS) {
    const v = d[k];
    if (v == null || typeof v === 'object') continue;
    said[k] = typeof v === 'number' ? v : scrub(v, 200);
  }
  return Object.keys(said).length ? said : null;
}
const topKeys = (d) => (d && typeof d === 'object' && !Array.isArray(d) ? Object.keys(d).slice(0, 20).map(safeKey) : []);
/* A body that is not JSON: its size and kind, and its first words only on a
   refusal (a 200 that is not JSON may be a data dump in another format). */
const notJson = (r, scrub) => {
  const text = String(r.data ?? '');
  return { answered: 'not JSON', body_length: text.length,
    body_kind: /^\s*</.test(text) ? (/<html/i.test(text) ? 'html' : 'xml') : 'text',
    body_starts: r.status >= 400 ? scrub(text, 160) : null };
};

/* Run task thunks with at most n in flight, results in task order. */
async function limited(tasks, n = 4) {
  const out = new Array(tasks.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    while (i < tasks.length) { const k = i++; out[k] = await tasks[k](); }
  }));
  return out;
}

/* ══ 1. FMS GetVehicleActivity ═════════════════════════════════════════════
   Per fleet with a credential, the cars with the most FMS fixes yesterday
   (telemetry_snapshot, source 'fms', Dubai day) — the cars most likely to
   have segments to return. The device's own vehicleno is asked for where the
   poll kept it in raw (GetVehicleStatus's `vehicleno`), since FMS matches on
   its spelling, not ours; normPlate's form otherwise.

   Windows, each as [fromdate, todate] in FMS's YYYY.MM.DD:
     yesterday         [yesterday, today]  — two dates, so it covers yesterday
                       whether FMS reads todate as inclusive or as midnight;
                       earliest_day / latest_day in the answer say which.
     last_N_days       [today-N, today]
     depth_90_days     [today-90, today-89]
     depth_<back>_days [today-back, today-back+1]
   so the deep windows answer "does FMS still hold segments that old?". */
const FMS_PLATES_SQL = `
  SELECT plate, max(NULLIF(raw->>'vehicleno', '')) AS vno, count(*)::int AS fixes
    FROM telemetry_snapshot
   WHERE source = 'fms' AND fleet_id = $1
     AND captured_at >= $2::timestamptz AND captured_at < $3::timestamptz
   GROUP BY plate
   ORDER BY fixes DESC, plate
   LIMIT $4`;

export function activityShape(list) {
  const rows = list.filter((r) => r && typeof r === 'object');
  const kAct = keyLike(rows, /^act.?type$/i, /activity.?type/i, /^type$/i);
  const kStart = keyLike(rows, /^start.?time$/i, /^start.?(date|dt)/i, /start.*time/i);
  const kEnd = keyLike(rows, /^end.?time$/i, /^end.?(date|dt)/i, /end.*time/i);
  const kDur = keyLike(rows, /^duration$/i, /duration/i);
  const kDist = keyLike(rows, /^distance.?travel/i, /distance/i);
  const latKey = (side) => keyLike(rows, new RegExp(`^${side}.?lat`, 'i'), new RegExp(`^${side}.*lat`, 'i'));
  const lonKey = (side) => keyLike(rows, new RegExp(`^${side}.?(lon|lng)`, 'i'), new RegExp(`^${side}.*(lon|lng)`, 'i'));
  const pair = (kLat, kLon) => (kLat && kLon
    ? pct(rows.filter((r) => num(r[kLat]) && num(r[kLon])).length, rows.length) : null);

  const segs = rows.map((r) => {
    const s = kStart ? toMs(r[kStart]) : null;
    const e = kEnd ? toMs(r[kEnd]) : null;
    let minutes = s != null && e != null && e >= s ? (e - s) / 60000 : null;
    let basis = minutes != null ? 'start/end' : null;
    if (minutes == null && kDur && /:/.test(String(r[kDur] ?? ''))) {
      const sec = hmsToSeconds(String(r[kDur]).trim());
      if (sec != null) { minutes = sec / 60; basis = 'Duration field'; }
    }
    return { s, e, minutes, basis, act: kAct ? r[kAct] : null };
  });
  const starts = segs.map((x) => x.s).filter((x) => x != null).sort((a, b) => a - b);
  const ends = segs.map((x) => x.e).filter((x) => x != null);
  const lastMs = ends.length ? Math.max(...ends) : starts.length ? starts[starts.length - 1] : null;
  const ordered = segs.filter((x) => x.s != null && x.e != null).sort((a, b) => a.s - b.s);
  const gaps = [];
  for (let i = 1; i < ordered.length; i += 1) gaps.push((ordered[i].s - ordered[i - 1].e) / 60000);

  /* Minutes per activity type, for the types that passed the enumeration
     test only — a type that would be withheld from the distribution is not
     reintroduced as a key here. */
  const dist = enumDist(segs.map((x) => x.act));
  const byAct = {};
  for (const t of Object.keys(dist)) {
    if (t.startsWith('(') || t === 'distinct') continue;
    const st = stats(segs.filter((x) => String(x.act ?? '').trim() === t).map((x) => x.minutes));
    byAct[t] = { n: st.n, median_min: st.median, p90_min: st.p90 };
  }
  const dists = kDist ? rows.map((r) => num(r[kDist])).filter((x) => x != null) : [];
  return {
    fields: fieldFill(rows),
    acttype_field: kAct, acttype: kAct ? dist : null,
    segment_minutes: stats(segs.map((x) => x.minutes)),
    segment_minutes_by_acttype: kAct ? byAct : null,
    duration_basis: [...new Set(segs.map((x) => x.basis).filter(Boolean))],
    gap_between_segments_minutes: stats(gaps),
    time_parse_pct: kStart ? pct(segs.filter((x) => x.s != null).length, rows.length) : null,
    start_latlon_fill_pct: pair(latKey('start'), lonKey('start')),
    end_latlon_fill_pct: pair(latKey('end'), lonKey('end')),
    distance: kDist ? { field: kDist, fill_pct: pct(dists.length, rows.length), median: round1(stats(dists).median),
      unit_note: 'as FMS sends it — GetTripPassenger\'s distance is km' } : null,
    earliest_day: dayOf(starts[0] ?? null),
    latest_day: dayOf(lastMs),
  };
}

async function fmsActivity(q, ctx) {
  const nPlates = clampInt(q.plates, 1, 3, 3);
  const days = clampInt(q.days, 1, 14, 7);
  const back = clampInt(q.back, 30, 800, 400);
  const today = dubaiIso(new Date(ctx.now()));
  const yesterday = addDays(today, -1);
  const windows = [
    { window: 'yesterday', from: yesterday, to: today },
    { window: `last_${days}_days`, from: addDays(today, -days), to: today },
    { window: 'depth_90_days', from: addDays(today, -90), to: addDays(today, -89) },
    ...(back !== 90 ? [{ window: `depth_${back}_days`, from: addDays(today, -back), to: addDays(today, -back + 1) }] : []),
  ];
  const fleets = [];
  const tasks = [];
  for (const f of (config.fms.fleets || []).filter((x) => !q.fleet || x.fleet === q.fleet)) {
    if (!f.username || !f.password) {
      fleets.push({ fleet: f.fleet, skipped: 'no FMS username/password is configured for this fleet' });
      continue;
    }
    const entry = { fleet: f.fleet, cars: [] };
    fleets.push(entry);
    let picked;
    try {
      picked = (await ctx.query(FMS_PLATES_SQL,
        [f.fleet, `${yesterday}T00:00:00+04:00`, `${today}T00:00:00+04:00`, nPlates])).rows || [];
    } catch (e) { entry.error = `choosing cars from telemetry_snapshot failed: ${ctx.scrub(e?.message || e)}`; continue; }
    if (!picked.length) {
      entry.skipped = `no FMS fixes were collected for ${f.fleet} on ${yesterday}, so there is no car to ask about`;
      continue;
    }
    for (const p of picked) ctx.addSecrets([p.plate, p.vno]);
    picked.forEach((p, i) => {
      const car = { car: `car ${i + 1}`, fixes_yesterday: p.fixes, calls: [] };
      entry.cars.push(car);
      for (const w of windows) {
        tasks.push(async () => {
          const call = { window: w.window, from: w.from, to: w.to };
          car.calls.push(call);
          const timeoutMs = ctx.timeoutFor(45_000);
          if (!timeoutMs) { call.skipped = `the ${BUDGET_MS / 1000}s budget for one request was spent before this call`; return; }
          const t0 = Date.now();
          try {
            const r = await http(`${config.fms.base}/GetVehicleActivity?${qs({
              username: f.username, Password: f.password, vehicleno: p.vno || p.plate,
              fromdate: w.from.replace(/-/g, '.'), todate: w.to.replace(/-/g, '.'),
            })}`, { timeoutMs, retries: 0 });
            call.http = r.status;
            call.elapsed_ms = Date.now() - t0;
            const d = asJson(r.data);
            if (!d || typeof d !== 'object') { Object.assign(call, notJson(r, ctx.scrub)); return; }
            const list = listIn(d, ['Data', 'data', 'GetVehicleActivityResult', 'Result', 'result']);
            const said = providerSaid(d, ctx.scrub);
            if (!list) { Object.assign(call, { rows: null, top_level_keys: topKeys(d), provider_said: said }); return; }
            Object.assign(call, { rows: list.length, ...(said ? { provider_said: said } : {}), ...activityShape(list) });
          } catch (e) {
            call.elapsed_ms = Date.now() - t0;
            call.error = ctx.scrub(e?.message || e);
          }
        });
      }
    });
  }
  await limited(tasks, 4);
  /* Calls finish out of order; put each car's back in window order. */
  const order = windows.map((w) => w.window);
  for (const f of fleets) for (const c of f.cars || []) c.calls.sort((a, b) => order.indexOf(a.window) - order.indexOf(b.window));
  return {
    asked: { plates: nPlates, days, back, windows: windows.map((w) => w.window) },
    fleets,
    notes: [
      'Cars are the ones with the most FMS fixes yesterday (Dubai day) and are numbered, never named.',
      'fromdate/todate are sent as two dates even for one day, so the window holds whether FMS reads todate '
        + 'as inclusive or as midnight; earliest_day/latest_day show which it did.',
      'A depth window with rows: 0 and no provider_said is FMS answering "nothing that old", not a refusal; '
        + 'provider_said carries FMS\'s own words when it refused (it refuses a bad password with HTTP 200).',
      'Coordinates are reported only as start/end lat-lon fill rates; distance as a median.',
    ],
  };
}

/* ══ 2. Yango order track ══════════════════════════════════════════════════
   Three recent orders (newest, preferring status 'complete', which is the
   order most likely to have a trace) and one at least `back` days old, which
   asks how long Yango keeps a track. POST with the key pair, park_id and
   order_id in the query as Yango documents it, and `{}` as the body; if that
   draws a 400, once more with no body — the documentation shows none, and a
   first-ever call is worth not losing to a body the server did not want. */
const YANGO_RECENT_SQL = `
  SELECT external_id, requested_at FROM trip
   WHERE platform = 'yango' AND external_id IS NOT NULL AND requested_at IS NOT NULL
     AND requested_at > now() - interval '14 days'
   ORDER BY (status = 'complete') DESC, requested_at DESC
   LIMIT 3`;
const YANGO_OLD_SQL = `
  SELECT external_id, requested_at FROM trip
   WHERE platform = 'yango' AND external_id IS NOT NULL AND requested_at IS NOT NULL
     AND requested_at < now() - make_interval(days => $1::int)
   ORDER BY (status = 'complete') DESC, requested_at DESC
   LIMIT 1`;

export function trackShape(points) {
  const rows = points.filter((r) => r && typeof r === 'object');
  const at = rows.map((r) => toMs(r.tracked_at ?? r.trackedAt ?? r.time ?? r.timestamp)).filter((x) => x != null)
    .sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < at.length; i += 1) gaps.push((at[i] - at[i - 1]) / 1000);
  const fields = fieldFill(rows);
  const fill = (re) => { const f = fields.find((x) => re.test(x.key)); return f ? f.fill_pct : null; };
  const kStatus = keyLike(rows, /^order_status$/i, /status/i);
  return {
    fields,
    spacing_seconds: stats(gaps),
    span_minutes: at.length > 1 ? round1((at[at.length - 1] - at[0]) / 60000) : null,
    first_day: dayOf(at[0] ?? null), last_day: dayOf(at[at.length - 1] ?? null),
    location_fill_pct: fill(/(^|\.)(lat|latitude)$/i),
    speed_fill_pct: fill(/(^|\.)speed$/i),
    direction_fill_pct: fill(/(^|\.)(direction|heading|bearing)$/i),
    order_status_field: kStatus,
    order_status: kStatus ? enumDist(rows.map((r) => r[kStatus])) : null,
  };
}

async function yangoTrack(q, ctx) {
  const back = clampInt(q.back, 7, 400, 60);
  const y = config.yango;
  const fleet = y.fleet || 'ecosine';
  const asked = { back };
  if (q.fleet && q.fleet !== fleet) {
    return { asked, fleets: [{ fleet: q.fleet, skipped: `Yango is configured for ${fleet} only` }], notes: [] };
  }
  if (!y.parkId || !y.apiKey || !y.clientId) {
    return { asked, fleets: [{ fleet, skipped: 'YANGO_PARK_ID and YANGO_API_KEY must both be set' }], notes: [] };
  }
  const entry = { fleet, orders: [] };
  let picked;
  try {
    const recent = (await ctx.query(YANGO_RECENT_SQL, [])).rows || [];
    const old = (await ctx.query(YANGO_OLD_SQL, [back])).rows || [];
    picked = [...recent.map((r) => ({ ...r, kind: 'recent' })), ...old.map((r) => ({ ...r, kind: `older than ${back} days` }))];
  } catch (e) {
    entry.error = `choosing orders from trip failed: ${ctx.scrub(e?.message || e)}`;
    return { asked, fleets: [entry], notes: [] };
  }
  ctx.addSecrets(picked.map((p) => p.external_id));
  if (!picked.length) entry.skipped = 'no Yango order is held in trip, so there is nothing to ask a track for';
  const hdrs = { 'X-API-Key': y.apiKey, 'X-Client-ID': y.clientId, 'content-type': 'application/json', 'Accept-Language': 'en' };
  for (const [i, p] of picked.entries()) {
    const o = { order: `order ${i + 1}`, kind: p.kind,
      age_days: p.requested_at ? Math.floor((ctx.now() - new Date(p.requested_at).getTime()) / DAY_MS) : null };
    entry.orders.push(o);
    const url = `${y.keyBase}/v1/parks/orders/track?${qs({ park_id: y.parkId, order_id: p.external_id })}`;
    const t0 = Date.now();
    try {
      let timeoutMs = ctx.timeoutFor(20_000);
      if (!timeoutMs) { o.skipped = `the ${BUDGET_MS / 1000}s budget for one request was spent before this call`; continue; }
      let r = await http(url, { method: 'POST', headers: hdrs, body: '{}', timeoutMs, retries: 0 });
      o.body_sent = '{}';
      if (r.status === 400 && (timeoutMs = ctx.timeoutFor(20_000))) {
        const { 'content-type': _ct, ...bare } = hdrs;
        r = await http(url, { method: 'POST', headers: bare, timeoutMs, retries: 0 });
        o.body_sent = 'none (the {} body drew a 400)';
      }
      o.http = r.status;
      o.elapsed_ms = Date.now() - t0;
      const d = asJson(r.data);
      if (!d || typeof d !== 'object') { Object.assign(o, notJson(r, ctx.scrub)); continue; }
      const list = listIn(d, ['track', 'points', 'items']);
      const said = r.status >= 300 || !list ? providerSaid(d, ctx.scrub) : null;
      if (!list) { Object.assign(o, { points: null, top_level_keys: topKeys(d), provider_said: said }); continue; }
      Object.assign(o, { points: list.length, top_level_keys: topKeys(d), ...trackShape(list) });
    } catch (e) {
      o.elapsed_ms = Date.now() - t0;
      o.error = ctx.scrub(e?.message || e);
    }
  }
  return {
    asked,
    fleets: [entry],
    notes: [
      'Orders are numbered, never named; age_days is how old the order is, which is what the retention '
        + 'question turns on.',
      'Track points are reported as spacing, span and field fill rates; a position is only ever a fill rate.',
      'A 404 or an empty track on the old order and not on the recent ones is Yango\'s retention, not a refusal; '
        + 'a 401/403 on all of them is the key pair.',
    ],
  };
}

/* ══ 3. Bolt getFleetStateLogs ═════════════════════════════════════════════
   The fleet-integration client is entitled to Egari's company only (measured:
   COMPANIES_NOT_ALLOWED for Ecosine on getDrivers and getFleetOrders), so
   Egari gets three windows — the last 24 h, a day 30 days back and a day
   `back` days back (depth) — at up to `limit` rows each, one page each, and
   Ecosine one call so the refusal is on record for this surface too.

   The body: getFleetOrders requires `company_ids` as an ARRAY and takes
   `company_id` beside it, and that is what is sent first. Bolt's spec for
   this path was not read here, so if the gateway answers with a validation
   refusal the call is repeated once with `company_id` alone, and which body
   was accepted is part of the answer. */
const BOLT_VALIDATION = /validation|is not array|not allowed|unknown property|additional propert|invalid.*(body|request|param)/i;

export function stateShape(list) {
  const rows = list.filter((r) => r && typeof r === 'object');
  const kState = keyLike(rows, /^state$/i, /^driver_state$/i, /state/i);
  const kTime = keyLike(rows, /^created$/i, /^created_(at|ts|timestamp)$/i, /timestamp|_ts$/i, /created|time/i);
  const kDriver = keyLike(rows, /^driver_uuid$/i, /^driver_id$/i, /driver.*(uuid|id)$/i);
  const fields = fieldFill(rows);
  const fill = (re) => { const f = fields.find((x) => re.test(x.key)); return f ? f.fill_pct : null; };
  const byDriver = new Map();
  const times = [];
  for (const r of rows) {
    const t = kTime ? toMs(r[kTime]) : null;
    if (t == null) continue;
    times.push(t);
    const d = kDriver ? String(r[kDriver] ?? '') : '';
    if (!byDriver.has(d)) byDriver.set(d, []);
    byDriver.get(d).push(t);
  }
  const gaps = [];
  for (const ts of byDriver.values()) {
    ts.sort((a, b) => a - b);
    for (let i = 1; i < ts.length; i += 1) gaps.push((ts[i] - ts[i - 1]) / 1000);
  }
  times.sort((a, b) => a - b);
  return {
    fields,
    state_field: kState, states: kState ? enumDist(rows.map((r) => r[kState])) : null,
    lat_fill_pct: fill(/(^|\.)(lat|latitude)$/i),
    lng_fill_pct: fill(/(^|\.)(lng|lon|longitude)$/i),
    time_field: kTime,
    time_parse_pct: kTime ? pct(times.length, rows.length) : null,
    distinct_drivers: kDriver ? new Set(rows.map((r) => r[kDriver]).filter((x) => x != null && x !== '')).size : null,
    spacing_seconds_per_driver: kDriver ? stats(gaps) : null,
    earliest_day: dayOf(times[0] ?? null), latest_day: dayOf(times[times.length - 1] ?? null),
    span_hours: times.length > 1 ? round1((times[times.length - 1] - times[0]) / 3600e3) : null,
  };
}

async function boltStates(q, ctx) {
  const back = clampInt(q.back, 31, 400, 90);
  const limit = clampInt(q.limit, 1, 1000, 1000);
  const asked = { back, limit };
  const b = config.bolt;
  if (!b.clientId || !b.clientSecret) {
    return { asked, fleets: [{ fleet: 'egari', skipped: 'BOLT_CLIENT_ID and BOLT_CLIENT_SECRET must both be set' }], notes: [] };
  }
  let token;
  try {
    token = await ctx.fiToken();
    ctx.addSecrets([token]);
  } catch (e) {
    return { asked, fleets: [{ fleet: 'egari', error: `the fleet-integration token could not be minted: ${ctx.scrub(e?.message || e)}` }], notes: [] };
  }
  const nowS = Math.floor(ctx.now() / 1000);
  const dayS = 86400;
  const plan = [
    { fleet: 'egari', windows: [
      { window: 'last_24h', start_ts: nowS - dayS, end_ts: nowS, limit },
      { window: 'depth_30_days', start_ts: nowS - 30 * dayS, end_ts: nowS - 29 * dayS, limit },
      ...(back !== 30 ? [{ window: `depth_${back}_days`, start_ts: nowS - back * dayS, end_ts: nowS - (back - 1) * dayS, limit }] : []),
    ] },
    { fleet: 'ecosine', expected: 'COMPANIES_NOT_ALLOWED — the refusal measured on getDrivers and getFleetOrders',
      windows: [{ window: 'last_24h', start_ts: nowS - dayS, end_ts: nowS, limit: 1 }] },
  ].filter((p) => !q.fleet || p.fleet === q.fleet);
  const fleets = [];
  for (const p of plan) {
    const company = (b.companies || []).find((c) => c.fleet === p.fleet);
    const entry = { fleet: p.fleet, ...(p.expected ? { expected: p.expected } : {}), calls: [] };
    fleets.push(entry);
    if (!company) { entry.skipped = `no Bolt company is configured for ${p.fleet}`; continue; }
    for (const w of p.windows) {
      const call = { window: w.window, from_day: dayOf(w.start_ts * 1000), to_day: dayOf(w.end_ts * 1000), limit: w.limit };
      entry.calls.push(call);
      const ask = async (withArray) => {
        const timeoutMs = ctx.timeoutFor(30_000);
        if (!timeoutMs) return null;
        return http(`${b.fiGateway}/getFleetStateLogs`, {
          method: 'POST', timeoutMs, retries: 0,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ company_id: company.companyId, ...(withArray ? { company_ids: [company.companyId] } : {}),
            offset: 0, limit: w.limit, start_ts: w.start_ts, end_ts: w.end_ts }),
        });
      };
      const t0 = Date.now();
      try {
        let r = await ask(true);
        call.body_sent = 'company_id + company_ids[]';
        if (r) {
          const d0 = asJson(r.data);
          /* Not the entitlement refusal: COMPANIES_NOT_ALLOWED is about the
             company, and a second body cannot change it. */
          const refusedShape = d0 && typeof d0 === 'object' && d0.code !== 0
            && !/COMPANIES?_NOT_ALLOWED/i.test(`${d0.message ?? ''} ${d0.error_hint ?? ''}`)
            && (Array.isArray(d0.validation_errors) || BOLT_VALIDATION.test(`${d0.message ?? ''} ${d0.error_hint ?? ''}`));
          if (refusedShape) {
            call.first_body_refused = providerSaid(d0, ctx.scrub);
            const r2 = await ask(false);
            if (r2) { r = r2; call.body_sent = 'company_id only (the array body drew a validation refusal)'; }
          }
        }
        call.elapsed_ms = Date.now() - t0;
        if (!r) { call.skipped = `the ${BUDGET_MS / 1000}s budget for one request was spent before this call`; continue; }
        call.http = r.status;
        const d = asJson(r.data);
        if (!d || typeof d !== 'object') { Object.assign(call, notJson(r, ctx.scrub)); continue; }
        call.provider_said = providerSaid(d, ctx.scrub);
        if (Array.isArray(d.validation_errors)) {
          call.validation_errors = d.validation_errors.slice(0, 5).map((v) => ({
            property: safeKey(String(v?.property ?? '')), error: ctx.scrub(v?.error ?? '', 120) }));
        }
        const inner = d.data && typeof d.data === 'object' ? d.data : null;
        const list = listIn(inner ?? d, ['state_logs', 'stateLogs', 'fleet_state_logs', 'logs', 'items', 'rows']);
        call.data_keys = topKeys(inner);
        /* The provider's own counters, if it sends any — numbers only. */
        if (inner) {
          const totals = Object.fromEntries(Object.entries(inner)
            .filter(([k, v]) => typeof v === 'number' && /total|count|has_more|next/i.test(k)).map(([k, v]) => [safeKey(k), v]));
          if (Object.keys(totals).length) call.provider_totals = totals;
        }
        if (!list) { call.rows = null; continue; }
        call.rows = list.length;
        call.page_full = list.length >= w.limit;
        Object.assign(call, stateShape(list));
      } catch (e) {
        call.elapsed_ms = Date.now() - t0;
        call.error = ctx.scrub(e?.message || e);
      }
    }
  }
  return {
    asked,
    fleets,
    notes: [
      'Drivers are a count; spacing is between consecutive logs of the same driver, pooled over drivers.',
      'page_full: true means Bolt had at least `limit` rows for the window and only the first page was read — '
        + 'the spacing is then over a prefix of the window, and rows is a floor, not the total.',
      'HTTP 200 with a non-zero provider_said.code is Bolt\'s refusal (Bolt puts its own code in the body).',
      'A position is reported only as lat/lng fill rates.',
    ],
  };
}

/* ══ 4. CABMAN cadence ═════════════════════════════════════════════════════
   GetIVDData `calls` times, `interval` seconds apart, every fleet in the same
   tick. For each vehicle present in two consecutive answers and moving
   (speed > 5 in either), did the device's own fix time (`gmt`) advance, and
   by how much? If moving units advance by ~interval, the units report far
   more often than our 5-minute poll samples them, and a faster poll would buy
   a finer trace; if they advance by nothing within the interval, the unit's
   own cadence is the limit and polling faster buys nothing.

   `gmt` is GMT with no zone (src/sources/cabman.js, parseGmt — not exported,
   so its two lines are repeated here). Vehicle ids are used to pair answers
   and never leave this function. */
const parseGmt = (v) => {
  const s = String(v || '').trim();
  if (!s) return null;
  const iso = s.replace(' ', 'T');
  const t = Date.parse(/[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(t) ? t : null;
};

export function cadenceShape(snaps, { movingKmh = 5 } = {}) {
  const advances = [];
  const between = [];
  let pairs = 0, advanced = 0, still = 0, backwards = 0;
  for (let i = 1; i < snaps.length; i += 1) {
    const a = snaps[i - 1], b = snaps[i];
    if (!a?.byId || !b?.byId) { between.push({ between: `${i}→${i + 1}`, skipped: 'one of the two calls did not answer' }); continue; }
    let m = 0, adv = 0;
    for (const [id, now] of b.byId) {
      const was = a.byId.get(id);
      if (!was || was.gmt == null || now.gmt == null) continue;
      if (!(Math.max(was.speed ?? 0, now.speed ?? 0) > movingKmh)) continue;
      m += 1; pairs += 1;
      if (now.gmt > was.gmt) { adv += 1; advanced += 1; advances.push((now.gmt - was.gmt) / 1000); }
      else if (now.gmt < was.gmt) backwards += 1;
      else still += 1;
    }
    between.push({ between: `${i}→${i + 1}`, seconds_apart: round1((b.at - a.at) / 1000), moving: m, advanced: adv });
  }
  return { moving_vehicle_pairs: pairs, advanced, did_not_advance: still, went_backwards: backwards,
    advance_seconds: stats(advances), by_interval: between };
}

async function cabmanCadence(q, ctx) {
  let calls = clampInt(q.calls, 2, 6, 5);
  const interval = clampInt(q.interval, 5, 20, 15);
  const notes = [];
  while ((calls - 1) * interval > BUDGET_MS / 1000 - 10 && calls > 2) calls -= 1;
  const asked = { calls, interval_s: interval };
  const all = (config.cabman.fleets || []).filter((f) => !q.fleet || f.fleet === q.fleet);
  const fleets = [];
  const live = [];
  for (const f of all) {
    if (!f.pass) { fleets.push({ fleet: f.fleet, skipped: 'no CABMAN password is configured for this fleet' }); continue; }
    const entry = { fleet: f.fleet, per_call: [], snaps: [] };
    fleets.push(entry);
    live.push({ f, entry });
  }
  const start = ctx.now();
  for (let i = 0; i < calls && live.length; i += 1) {
    if (i) {
      const wait = start + i * interval * 1000 - ctx.now();
      if (wait > 0) await ctx.sleep(wait);
    }
    await Promise.all(live.map(async ({ f, entry }) => {
      const t0 = Date.now();
      const at = ctx.now();
      const timeoutMs = ctx.timeoutFor(12_000);
      if (!timeoutMs) { entry.per_call.push({ call: i + 1, skipped: 'request budget spent' }); entry.snaps.push(null); return; }
      try {
        const r = await http(config.cabman.url, { timeoutMs, retries: 0,
          headers: { InterfaceUniqueId: f.interfaceId, InterfaceUserName: f.user, InterfacePassword: f.pass } });
        const d = asJson(r.data);
        const list = d && typeof d === 'object' ? listIn(d, ['IVDDataResult']) : null;
        const pc = { call: i + 1, http: r.status, elapsed_ms: Date.now() - t0 };
        if (!list) {
          Object.assign(pc, d && typeof d === 'object'
            ? { vehicles: null, top_level_keys: topKeys(d), provider_said: providerSaid(d, ctx.scrub) } : notJson(r, ctx.scrub));
          entry.per_call.push(pc); entry.snaps.push(null); return;
        }
        const byId = new Map();
        for (const v of list) {
          const id = v?.VehicleID ?? v?.vehicleId ?? v?.vehicleID;
          if (id == null || id === '') continue;
          byId.set(String(id), { gmt: parseGmt(v.gmt), speed: num(v.speed) });
        }
        const moving = [...byId.values()].filter((v) => (v.speed ?? 0) > 5);
        Object.assign(pc, { vehicles: byId.size, moving: moving.length,
          fix_age_seconds_moving: stats(moving.map((v) => (v.gmt == null ? null : (at - v.gmt) / 1000))) });
        entry.per_call.push(pc);
        entry.snaps.push({ at, byId });
      } catch (e) {
        entry.per_call.push({ call: i + 1, elapsed_ms: Date.now() - t0, error: ctx.scrub(e?.message || e) });
        entry.snaps.push(null);
      }
    }));
  }
  for (const { entry } of live) {
    const c = cadenceShape(entry.snaps);
    delete entry.snaps;
    entry.pairs = c;
    const a = c.advance_seconds;
    entry.reading = !c.moving_vehicle_pairs
      ? 'No vehicle was moving in two consecutive answers, so the cadence of a moving unit was not observed this run.'
      : !c.advanced
        ? `Of ${c.moving_vehicle_pairs} moving-vehicle pairs, no device fix time advanced within ~${interval}s — `
          + 'the units report no faster than that, so polling faster than our 5 minutes may buy little.'
        : `${c.advanced} of ${c.moving_vehicle_pairs} moving-vehicle pairs advanced; the device fix time moved by `
          + `${a.min}s at the least and ${a.median}s at the median between calls ~${interval}s apart — `
          + `${a.median != null && a.median < 300 ? 'faster than' : 'no faster than'} our 5-minute poll samples it.`;
  }
  if (calls < clampInt(q.calls, 2, 6, 5)) notes.push(`calls was reduced to ${calls} to stay inside the ${BUDGET_MS / 1000}s budget.`);
  notes.push('Fix age is the poll time minus the device\'s own gmt, over moving vehicles; vehicles are counted, never named.');
  return { asked, fleets, notes };
}

/* ── the runner and the route ──────────────────────────────────────────── */
const RUN = { fms_activity: fmsActivity, yango_track: yangoTrack, bolt_states: boltStates, cabman_cadence: cabmanCadence };

/* deps exist so the test can stand in for the database, the settings load,
   the clock and the sleep; the provider calls themselves go through the real
   src/http.js, which the test reaches by replacing global fetch. */
export async function runMovement(which, query = {}, deps = {}) {
  const d = {
    query: (t, p) => pool.query(t, p), loadSettings: realLoadSettings, sleep: realSleep,
    now: () => Date.now(), fiToken: realFiToken, ...deps,
  };
  const t0 = d.now();
  const deadline = t0 + BUDGET_MS;
  const extra = [];
  let scrub = scrubber(credentialValues());
  const ctx = {
    ...d,
    get scrub() { return scrub; },
    addSecrets: (vals) => { extra.push(...vals.filter(Boolean)); scrub = scrubber([...credentialValues(), ...extra]); },
    /* The timeout a call may have: its own ceiling or what is left of the
       request's budget, and 0 (skip it) when under two seconds remain. */
    timeoutFor: (ms) => { const left = deadline - d.now(); return left < 2000 ? 0 : Math.min(ms, left); },
  };
  const q = { ...query, fleet: FLEETS.includes(String(query.fleet)) ? String(query.fleet) : null };
  let out;
  try {
    await d.loadSettings();
    scrub = scrubber(credentialValues());
    out = await RUN[which](q, ctx);
  } catch (e) {
    out = { fleets: [], notes: [], error: ctx.scrub(e?.message || e) };
  }
  /* The last line of defence: every string and every key a reducer above
     returns is scrubbed once more, so a value that slipped into a field name
     or a provider message on a path nobody thought of still cannot leave.
     Walked, not done on the serialised text: a credential that happened to be
     "null" or "true" would otherwise rewrite the JSON's own syntax. */
  const body = { which, ran_at: new Date(t0).toISOString(), elapsed_ms: d.now() - t0, ...out };
  return deepScrub(body, ctx.scrub);
}
const deepScrub = (v, scrub) => {
  if (typeof v === 'string') return scrub(v, Infinity);
  if (Array.isArray(v)) return v.map((x) => deepScrub(x, scrub));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k, Infinity), deepScrub(x, scrub)]));
  }
  return v;
};

export function movementRoutes(app, { wrap, deps = {} }) {
  app.get('/api/probe/movement', wrap(async (req, res) => {
    const which = String(req.query.which || '');
    if (!MOVEMENT_PROBES.includes(which)) {
      return res.status(400).json({ error: `which must be one of ${MOVEMENT_PROBES.join(', ')} — one probe per request`,
        allowed: MOVEMENT_PROBES });
    }
    if (req.query.fleet != null && !FLEETS.includes(String(req.query.fleet))) {
      return res.status(400).json({ error: `fleet, when given, must be one of ${FLEETS.join(', ')}` });
    }
    res.json(await runMovement(which, req.query, deps));
  }));
}
