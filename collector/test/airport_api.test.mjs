/* GET /api/airport — landings by Dubai hour, the fleet's airport trips, and
   the relationship between them (api/airport_routes.js, FIX-STATUS FLT).
   ═════════════════════════════════════════════════════════════════════════
   Two halves.

   A. THE ROUTE, mounted exactly as production mounts it (test/mount.mjs
      mountAll) over PGlite. Eleven UTC days of REAL OpenSky arrivals (the
      2026-11-15 list at OMDB, shifted a whole day at a time, stored by the
      collector's own storeLandings) and ten Dubai days of bookings in which
      the airport pickups follow the landings of the hour BEFORE — plus the
      false positives the classifier exists to refuse (Airport Rd – Al
      Garhoud, the Free Zone, "opposite Terminal 3", Internet City,
      International City) on every hour, a DWC pickup, drop-offs at T1, the
      tracker's own journeys, and the other fleet. It must give:
        · every hour of a complete day CONFIRMED, summing to what was stored;
        · exactly the seeded airport pickups and drop-offs — none of the
          false positives — by hour and by platform, and the share;
        · the impact: 10 complete days, the best lag 1 hour (as seeded), a
          strong positive r, pickups per 10 landings as seeded, the caveat;
        · fleet= narrowing the bookings and not the sky;
        · too few complete days → absent with that reason, no r;
        · a day nothing collected, with no client → every hour absent with
          "no OpenSky client configured", the day's total absent, never 0.
   B. airportShape, the pure half, at a fixed clock: a today's hour after now
      is "future"; 00:00–03:59 Dubai is judged on the PREVIOUS UTC day; a
      watched hour reads the live estimate, labelled live; an unwatched one is
      absent with both reasons; DXB+DWC is absent if either is.

   REVERSIONS (each made on 2026-11-16, each failed the checks named):
     · utcDayOfHour judging every hour on the Dubai day's own UTC day →
       "00:00–03:59 Dubai is judged on the previous UTC day" and "the day's
       total is absent while any past hour is".
     · `atAirport` accepting any airport for a single one → "airport pickups
       are exactly the seeded …", "the DWC pickup is not DXB's", the share
       and the daily totals.
     · the impact taking every day up to today, complete or not → "too few
       complete days → absent with that reason".
     · `isFuture` always false → "an hour after now is future". */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { dubaiDay } from '../api/window.js';
import { storeLandings, NO_CLIENT } from '../src/sources/flights.js';
import { airportShape, addDays } from '../api/airport_routes.js';
import { logRun } from '../src/db.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const J = (o) => JSON.stringify(o).slice(0, 400);
const OMDB = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/opensky/arrivals_OMDB_2026-11-15.json.gz', import.meta.url))).toString('utf8'));

const db = new PGlite();
await applySchema(db);
const { get } = await mountAll(db);

const today = dubaiDay(new Date());
const yday = addDays(today, -1);
const BASE = Date.parse('2026-11-15T00:00:00Z') / 1000;

/* ── seed: eleven UTC days of landings at OMDB, collected ── */
const L = new Map();   // dubaiDay|hour → landings
for (let k = 1; k <= 11; k++) {
  const ud = addDays(today, -k);
  const shift = (Date.parse(`${ud}T00:00:00Z`) / 1000) - BASE;
  const list = OMDB.map((f) => ({ ...f, firstSeen: f.firstSeen + shift, lastSeen: f.lastSeen + shift }));
  await storeLandings(db, 'OMDB', ud, list);
  await db.query(`INSERT INTO flight_day_coverage (airport, utc_day, status, landings, attempts, collected_at)
                  VALUES ('OMDB', $1, 'collected', $2, 1, now())`, [ud, list.length]);
  for (const f of list) {
    const t = new Date((f.lastSeen + 4 * 3600) * 1000);   // Dubai wall clock, read as UTC
    const k2 = `${t.toISOString().slice(0, 10)}|${t.getUTCHours()}`;
    L.set(k2, (L.get(k2) || 0) + 1);
  }
}
/* OMDW: only the last three UTC days → two complete Dubai days. */
for (let k = 1; k <= 3; k++) {
  await db.query(`INSERT INTO flight_day_coverage (airport, utc_day, status, landings, attempts, collected_at)
                  VALUES ('OMDW', $1, 'collected', 0, 1, now())`, [addDays(today, -k)]);
}

/* ── seed: bookings over the ten complete Dubai days ── */
const T3 = 'Terminal 3 - Dubai Int\'l Airport - Dubai - United Arab Emirates';
const T1 = 'Terminal 1, Dubai International Airport (DXB) - Al Garhoud - DU - AE';
const DWC = 'Madinat Al Mataar - AL Maktoum International Airport (DWC) - Dubai - United Arab Emirates';
const FALSE = ['Airport Rd - Al Garhoud - Dubai - United Arab Emirates', 'Al Falak St - Dubai Internet City - Dubai',
  'Warsan First - Dubai International City - Dubai', '155 Al Quds St - Dubai Int\'l Airport - Dubai Airport Free Zone - Dubai',
  'Garhoud Area - opposite to Airport Terminal 3 - Al Garhoud - Dubai'];
const rowsT = [];
let seq = 0;
const trip = (platform, fleet, d, h, pu, dr, status = 'completed') => rowsT.push([platform, `${platform}-${++seq}`, fleet,
  `${d}T${String(h).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}:00+04:00`, pu, dr, status]);
const want = { pickups: {}, dropoffs: {}, bookings: {}, egari: {} };
const P = new Map();   // dubaiDay|hour → seeded airport pickups
const days10 = Array.from({ length: 10 }, (_, i) => addDays(today, -10 + i));
for (const d of days10) {
  for (let h = 0; h < 24; h++) {
    /* The pickups of hour h follow the landings of hour h − 1 — across
       midnight too, from the previous day's 23:00. */
    const prev = h > 0 ? (L.get(`${d}|${h - 1}`) || 0) : (L.get(`${addDays(d, -1)}|23`) || 0);
    const p = Math.floor(prev / 4);
    P.set(`${d}|${h}`, p);
    for (let i = 0; i < p; i++) trip(i % 3 === 2 ? 'hotel' : 'uber', i % 5 === 4 ? 'egari' : 'ecosine', d, h, T3, 'Dubai Marina - Dubai');
    for (const f of FALSE) trip('uber', 'ecosine', d, h, f, 'Business Bay - Dubai');
    trip('bolt', 'ecosine', d, h, 'Jumeirah Lakes Towers - Dubai', T1);           // a drop-off at DXB
    trip('fms', 'ecosine', d, h, T3, 'Dubai Marina - Dubai');                    // the tracker's journey: not a booking
    want.pickups[d] = (want.pickups[d] || 0) + p;
    want.egari[d] = (want.egari[d] || 0) + Array.from({ length: p }, (_, i) => i % 5 === 4).filter(Boolean).length;
    want.dropoffs[d] = (want.dropoffs[d] || 0) + 1;
    want.bookings[d] = (want.bookings[d] || 0) + p + FALSE.length + 1;
  }
}
trip('uber', 'ecosine', yday, 9, DWC, 'Dubai Marina - Dubai');                   // DWC: not DXB's
want.bookings[yday] += 1;
for (let i = 0; i < rowsT.length; i += 300) {
  const part = rowsT.slice(i, i + 300);
  const params = [];
  const tuples = part.map((r) => `(${r.map((v) => { params.push(v); return `$${params.length}`; }).join(',')})`);
  await db.query(`INSERT INTO trip (platform, external_id, fleet_id, requested_at, pickup_addr, dropoff_addr, status) VALUES ${tuples.join(',')}`, params);
}

console.log('\nA · the route, on PGlite');
{
  const r = await get(`/api/airport?day=${yday}&days=10`);
  const b = r.body || {};
  check('200 with the day, the airport and both halves', r.status === 200 && b.day === yday && b.airport === 'OMDB' && b.landings && b.bookings && b.impact, `${r.status} ${J(b).slice(0, 200)}`);
  const hours = b.landings?.hours || [];
  const stored = Array.from({ length: 24 }, (_, h) => L.get(`${yday}|${h}`) || 0);
  check('every hour of a complete day is confirmed', hours.length === 24 && hours.every((x) => x.basis === 'confirmed'), J(hours.filter((x) => x.basis !== 'confirmed').slice(0, 2)));
  check('…hour by hour, exactly the landings stored', hours.every((x, h) => x.n === stored[h]), J(hours.map((x) => x.n)));
  check(`…and the day’s total is their sum (${stored.reduce((s, v) => s + v, 0)})`, b.landings?.total === stored.reduce((s, v) => s + v, 0), String(b.landings?.total));
  check('the coverage note says “OpenSky’s receivers saw” and that the share is an estimate', /receivers saw/.test(b.landings?.note || '') && /estimate/.test(b.landings?.note || ''));
  const t = b.bookings?.totals || {};
  check(`airport pickups are exactly the seeded ${want.pickups[yday]} — none of the five false positives, not the DWC one, not the tracker’s`,
    t.pickups === want.pickups[yday], `${t.pickups} vs ${want.pickups[yday]}`);
  check('the DWC pickup is not DXB’s', !(b.bookings?.hours || []).some((x) => x.hour === 9 && x.pickups !== Math.floor((L.get(`${yday}|8`) || 0) / 4)));
  check(`drop-offs at DXB are the seeded ${want.dropoffs[yday]}`, t.dropoffs === want.dropoffs[yday], String(t.dropoffs));
  check('bookings count every booking and no tracker journey', t.bookings === want.bookings[yday], `${t.bookings} vs ${want.bookings[yday]}`);
  check('the share of bookings that are airport pickups', Math.abs(t.share_pickups_pct - (100 * want.pickups[yday]) / want.bookings[yday]) < 0.01, String(t.share_pickups_pct));
  const pl = Object.fromEntries((b.bookings?.platforms || []).map((x) => [x.platform, x]));
  check('by platform: Uber and the hotel channel pick up, Bolt only drops off, the tracker is not a platform here',
    pl.uber?.pickups > 0 && pl.hotel?.pickups > 0 && pl.bolt?.pickups === 0 && pl.bolt?.dropoffs === 24 && !pl.fms, J(pl));
  const im = b.impact || {};
  check('the impact: 10 complete days', im.days_complete === 10 && im.absent_why == null, J({ c: im.days_complete, w: im.absent_why }));
  check('…the best lag is the seeded one hour, with a strong positive r', im.best_lag === 1 && im.r > 0.8, J(im.lags));
  check('…every lag 0–3 is reported with its r and its hours', (im.lags || []).length === 4 && im.lags.every((x) => x.hours > 0 && 'r' in x));
  /* The same pairs the route forms at lag 1: every hour of a complete day
     whose next hour is inside the window (so not yesterday's 23:00). */
  let sumL = 0, sumP = 0;
  for (const d of days10) for (let h = 0; h < 24; h++) {
    if (d === yday && h === 23) continue;
    sumL += L.get(`${d}|${h}`) || 0;
    sumP += h < 23 ? P.get(`${d}|${h + 1}`) : P.get(`${addDays(d, 1)}|0`);
  }
  check(`…pickups per 10 landings at that lag (${(10 * sumP / sumL).toFixed(2)})`, Math.abs(im.pickups_per_10_landings - (10 * sumP) / sumL) < 0.02, String(im.pickups_per_10_landings));
  check('…the daily totals, ten days, each with its landings and pickups', (im.daily || []).length === 10 && im.daily.every((x) => x.landings > 0 && x.pickups === want.pickups[x.day]), J(im.daily?.[0]));
  check('…and the caveat that correlation is not causation', /not causation/i.test(im.caveat || ''));
  const top = b.origins?.day?.top || [];
  check('top origins carry a name where one is known, and the unknown are counted apart', top[0]?.origin && top.some((x) => x.name) && b.origins.day.unknown === 163, J(top.slice(0, 3)));
  check('…and a flight that left and landed at DXB says what that may be', top.find((x) => x.origin === 'OMDB')?.note?.includes('go-around'));

  const e = (await get(`/api/airport?day=${yday}&days=10&fleet=egari`)).body;
  check('fleet= narrows the bookings…', e.bookings.totals.pickups === want.egari[yday], `${e.bookings.totals.pickups} vs ${want.egari[yday]}`);
  check('…and not the sky', e.landings.total === b.landings.total);

  const w = (await get(`/api/airport?day=${yday}&days=7&airport=OMDW`)).body;
  check('too few complete days → the impact is absent with that reason, and no r', w.impact.r == null && w.impact.best_lag == null
    && /only 2 of these 7 days/.test(w.impact.absent_why || ''), w.impact.absent_why);

  await logRun({ source: 'opensky', fleet_id: null, mode: 'arrivals', status: 'error', rows_written: 0, error: NO_CLIENT }, db);
  const old = (await get(`/api/airport?day=${addDays(today, -20)}&days=7`)).body;
  check('a day nothing collected, with no client: every hour absent with “no OpenSky client configured”',
    old.landings.hours.every((x) => x.n == null && x.basis === 'absent' && /no OpenSky client configured/.test(x.why)), J(old.landings.hours[5]));
  check('…the day’s total absent with the reason, never 0', old.landings.total == null && /no OpenSky client configured/.test(old.landings.total_why || ''), String(old.landings.total_why));
  check('…and the origins say why there are none', old.origins.day == null && /no confirmed landing/.test(old.origins.day_why || ''));
  const bad = (await get('/api/airport?day=2026-13-45&airport=XXXX&days=abc')).body;
  check('a malformed day, airport and window fall back to today, OMDB and 28 days', bad.day === today && bad.airport === 'OMDB' && bad.impact.days === 28);
}

console.log('\nB · airportShape at a fixed clock');
{
  const nowMs = Date.parse('2026-11-16T10:30:00Z');       // 14:30 in Dubai
  const D = '2026-11-16';
  const base = { day: D, airport: 'OMDB', days: 7, nowMs, backfillDays: 30,
    coverage: [{ airport: 'OMDB', utc_day: '2026-11-15', status: 'collected', landings: 3 }],
    landed: [{ airport: 'OMDB', d: D, h: 1, n: 7 }],
    live: [{ airport: 'OMDB', d: D, h: 9, n: 4 }, { airport: 'OMDB', d: D, h: 14, n: 1 }],
    liveHours: [{ d: D, h: 9, polls: 30, polls_ok: 30 }, { d: D, h: 10, polls: 30, polls_ok: 5, last_error: 'OpenSky answered HTTP 503' },
      { d: D, h: 14, polls: 16, polls_ok: 16 }],
    runs: { live: { status: 'ok', finished_at: '2026-11-16T10:30:00Z' } } };
  const s = airportShape(base);
  const H = s.landings.hours;
  check('an hour after now is “future”, with no figure', H[15].basis === 'future' && H[15].n == null && H[23].basis === 'future');
  check('00:00–03:59 Dubai is judged on the previous UTC day (collected → confirmed)', H[1].basis === 'confirmed' && H[1].n === 7 && H[3].basis === 'confirmed' && H[3].n === 0, J(H.slice(0, 4)));
  check('a watched hour reads the live estimate, labelled live', H[9].basis === 'live' && H[9].n === 4);
  check('the hour in progress, watched so far, is live and “so far”', H[14].basis === 'live' && H[14].so_far === true && H[14].n === 1, J(H[14]));
  check('an hour the watch half-missed is absent, with both reasons', H[10].n == null && /not published yet/.test(H[10].why) && /5 of 30 polls/.test(H[10].why), H[10].why);
  check('the day’s total is absent while any past hour is', s.landings.total == null && s.landings.total_so_far === 12 && s.landings.live_hours === 2, J(s.landings));
  const both = airportShape({ ...base, airport: 'both' });
  check('DXB and DWC together are absent where DWC is, naming it', both.landings.hours[1].n == null && /DWC:/.test(both.landings.hours[1].why || ''), both.landings.hours[1].why);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
