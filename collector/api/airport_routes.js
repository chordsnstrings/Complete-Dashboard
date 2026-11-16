/* THE AIRPORT — flights landing, the fleet's airport trips, and how the two
   move together. GET /api/airport.
   ─────────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16: "add flight details and flights actually landing,
   and how that impacts the airport trips." Three things, each with its own
   honesty problem, answered in one response for #airport
   (api/public/airport.js):

   1. LANDINGS BY DUBAI HOUR for one day, at DXB (OMDB), DWC (OMDW) or both —
      from OpenSky's nightly confirmed list (flight_landing) where that UTC
      day is collected, else from the live final-approach estimates
      (flight_live_landing) for an hour the live watch actually watched
      (flight_live_hour), labelled as estimates. A Dubai day spans two UTC
      days (00:00–03:59 Dubai is the previous UTC day), so each hour is judged
      on the UTC day it falls in. An hour neither covers is ABSENT, with the
      true reason — the day's coverage row, the arrivals run's error ("no
      OpenSky client configured"), or the live watch's — never 0.
   2. AIRPORT PICKUPS AND DROP-OFFS BY DUBAI HOUR — bookings whose address
      names the airport (api/airport_sql.js: one strict rule; "Airport Rd – Al
      Garhoud" is not the airport), by platform, any outcome.
   3. THE IMPACT over a window of days: landings per hour against the fleet's
      airport pickups in the same and the next one to three hours — the
      Pearson correlation at each lag, the best lag, pickups per 10 landings
      there (and the marginal slope), daily totals, and the share of the
      fleet's bookings that are airport pickups. Only days whose every hour
      of landings is CONFIRMED enter it (never a live estimate), and fewer
      than seven such days, or fewer than twenty airport pickups in them,
      is absent with that reason. Correlation is not causation, and the
      response says so in a field the page prints.

   PARAMETERS: day (a Dubai date, default today), airport (OMDB | OMDW |
   both, default OMDB), days (the window for the relationship, 7–90, default
   28, ending on `day`), fleet (honoured on the bookings only — the sky is the
   same for both fleets). */
import { airportOfSql, AIRPORT_NAMES, AIRPORT_RULE } from './airport_sql.js';
import { dubaiDay } from './window.js';
import { getInt } from '../src/settings.js';
import { outsideFleetScope } from '../src/fleet_scope.js';

export const AIRPORT_WINDOW = { dflt: 28, min: 7, max: 90 };
export const MIN_DAYS = 7;
export const MIN_PICKUPS = 20;
export const LAGS = [0, 1, 2, 3];
/* An hour counts as WATCHED live when at least two thirds of its polls
   answered: 20 of the 30 a two-minute watch makes. */
const WATCHED_SHARE = 2 / 3;
export const CAVEAT = 'Correlation is not causation: landings and airport pickups both follow the time of day and '
  + 'the day of the week, so a strong figure here says the two rise and fall together, not that more '
  + 'landings caused more pickups.';
export const COVERAGE_NOTE = 'Landings OpenSky’s receivers saw, not every landing: on 15 Nov 2026 they saw 438 at DXB '
  + 'against roughly 550–600 a day in public traffic figures, so about three in four — an estimate, and it varies by day.';

/* Where the fleet's landings come from, in words, for the origins table.
   The commonest origins of 2026-11-15 at DXB and DWC; any other ICAO code is
   printed as it is. OpenSky's departure airport is an ESTIMATE from where it
   first saw the aircraft, and it is null when it could not tell. */
export const ORIGIN_NAMES = {
  VHHH: 'Hong Kong', VIDP: 'Delhi', LTFM: 'Istanbul', VABB: 'Mumbai', VOBL: 'Bengaluru', EGLL: 'London Heathrow',
  VGHS: 'Dhaka', RPLL: 'Manila', OBBI: 'Bahrain', OJAI: 'Amman', OLBA: 'Beirut', VTBS: 'Bangkok Suvarnabhumi',
  OTHH: 'Doha', VOCI: 'Kochi', OMDW: 'Dubai Al Maktoum (DWC)', OMDB: 'Dubai International (DXB)', WSSS: 'Singapore',
  EGKK: 'London Gatwick', LFPG: 'Paris CDG', FAOR: 'Johannesburg', EDDM: 'Munich', OPLA: 'Lahore', EDDF: 'Frankfurt',
  UUEE: 'Moscow Sheremetyevo', LLBG: 'Tel Aviv', EBLG: 'Liège', LGAV: 'Athens', LTFJ: 'Istanbul Sabiha Gökçen',
  LEBL: 'Barcelona', EGBB: 'Birmingham', EGCC: 'Manchester', VOMM: 'Chennai', EHAM: 'Amsterdam', LIMC: 'Milan Malpensa',
  WMKK: 'Kuala Lumpur', LROP: 'Bucharest', VAAH: 'Ahmedabad', SBGR: 'São Paulo', VTBD: 'Bangkok Don Mueang',
  LEMD: 'Madrid', LCLK: 'Larnaca', EIDW: 'Dublin', EDDL: 'Düsseldorf', LSZH: 'Zurich', LKPR: 'Prague', LIRF: 'Rome',
  LOWW: 'Vienna', KJFK: 'New York JFK', KORD: 'Chicago', KMIA: 'Miami', YSSY: 'Sydney', YMML: 'Melbourne',
  RKSI: 'Seoul Incheon', RJBB: 'Osaka Kansai', ZGGG: 'Guangzhou', OPKC: 'Karachi', OPIS: 'Islamabad', OERK: 'Riyadh',
  OEJN: 'Jeddah', OKKK: 'Kuwait', OOMS: 'Muscat', HECA: 'Cairo', OMAA: 'Abu Dhabi', OMSJ: 'Sharjah',
};

const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
/* Calendar arithmetic on a YYYY-MM-DD, anchored at noon UTC so no step can
   cross a midnight. */
export const addDays = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const STATUS_WORD = {
  not_published: 'not published yet', failed: 'the request failed', none_returned: 'OpenSky returned none',
};

/* The Dubai wall clock of an instant, as {day, hour, minute}. */
export function dubaiClockOf(ms) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const at = (t) => parts.find((p) => p.type === t)?.value;
  return { day: `${at('year')}-${at('month')}-${at('day')}`, hour: Number(at('hour')), minute: Number(at('minute')) };
}

/** Pearson's r over pairs [[x, y], …]; null when either side does not vary. */
export function pearson(pairs) {
  const n = pairs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** The whole response, from rows. Pure: the route and mockapi.mjs both
    call it, so the mock can never certify a shape the server stopped
    returning. Every input is a list of plain rows (see the route's SQL). */
export function airportShape({ day, airport, days, fleet = null, nowMs, coverage = [], landed = [], live = [],
  liveHours = [], bookings = [], originsDay = [], originsWindow = [], runs = {}, liveCheck = {}, backfillDays = 30 }) {
  const clock = dubaiClockOf(nowMs);
  const today = clock.day;
  const from = addDays(day, -(days - 1));
  const APS = airport === 'both' ? ['OMDB', 'OMDW'] : [airport];
  const label = airport === 'both' ? 'DXB and DWC' : AIRPORT_NAMES[airport].iata;
  const cov = new Map(coverage.map((c) => [`${c.airport}|${c.utc_day}`, c]));
  const key = (a, d, h) => `${a}|${d}|${h}`;
  const L = new Map(); for (const r of landed) L.set(key(r.airport, r.d, r.h), (L.get(key(r.airport, r.d, r.h)) || 0) + Number(r.n));
  const LV = new Map(); for (const r of live) LV.set(key(r.airport, r.d, r.h), (LV.get(key(r.airport, r.d, r.h)) || 0) + Number(r.n));
  const LH = new Map(liveHours.map((r) => [`${r.d}|${r.h}`, r]));
  const arrRun = runs.arrivals || null;
  const liveRun = runs.live || null;
  const utcDayOfHour = (d, h) => (h < 4 ? addDays(d, -1) : d);
  const isFuture = (d, h) => d > today || (d === today && h > clock.hour);
  const oldestFilled = addDays(dubaiDay(new Date(nowMs)), -backfillDays);
  /* OpenSky's own unit: the UTC day this instant falls in (src/sources/
     flights.js utcDayOf) — the day it has not published yet. */
  const utcToday = new Date(nowMs).toISOString().slice(0, 10);

  /* Why an hour at one airport has no confirmed figure. */
  const confirmedWhy = (a, ud) => {
    const c = cov.get(`${a}|${ud}`);
    if (c) return `${STATUS_WORD[c.status] || c.status}${c.reason ? ` — ${c.reason}` : ''}`;
    if (arrRun?.status === 'error' && arrRun.error) return arrRun.error;
    if (ud < oldestFilled) return `not collected — older than the ${backfillDays} days the collector fills`;
    /* `ud` is a UTC day, so it is compared with the UTC day now — never with
       `today`, the DUBAI day. They differ every night from 00:00 to 03:59
       Dubai (20:00–23:59 UTC), when the Dubai day has turned and the UTC day
       has not: compared with the Dubai day, the UTC day still in progress
       (today's 00:00–03:59 Dubai, and yesterday's 04:00–23:59) read "not
       asked yet — the arrivals collector has not reached this day", which is
       not the reason: the collector never asks for a UTC day before it is
       over, because OpenSky has nothing to give for it (review of
       2026-11-16; test/airport_api.test.mjs section B pins both hours). */
    if (ud >= utcToday) return 'not published yet — OpenSky publishes a UTC day’s flights in a nightly batch once the day is over';
    return 'not asked yet — the arrivals collector has not reached this day';
  };
  const watched = (d, h) => {
    const r = LH.get(`${d}|${h}`);
    const expected = d === today && h === clock.hour ? Math.max(1, Math.floor(clock.minute / 2) + 1) : 30;
    const ok = Number(r?.polls_ok || 0);
    return { ok: ok >= Math.ceil(expected * WATCHED_SHARE), polls_ok: ok, expected, error: r?.last_error || null };
  };
  /* One hour at one airport. */
  const cell = (a, d, h) => {
    if (isFuture(d, h)) return { n: null, basis: 'future', why: null };
    const ud = utcDayOfHour(d, h);
    if (cov.get(`${a}|${ud}`)?.status === 'collected') return { n: L.get(key(a, d, h)) || 0, basis: 'confirmed', why: null };
    const w = watched(d, h);
    if (w.ok) return { n: LV.get(key(a, d, h)) || 0, basis: 'live', why: null, so_far: d === today && h === clock.hour };
    const liveWhy = w.polls_ok
      ? `the live watch answered ${w.polls_ok} of ${w.expected} polls`
      : (w.error ? `the live watch did not run: ${w.error}` : (liveRun?.status === 'error' && liveRun.error ? `the live watch did not run: ${liveRun.error}` : 'the live watch did not run that hour'));
    return { n: null, basis: 'absent', why: `${confirmedWhy(a, ud)}; ${liveWhy}` };
  };
  const hourRow = (d, h) => {
    const per = Object.fromEntries(APS.map((a) => [a, cell(a, d, h)]));
    const cells = Object.values(per);
    if (cells.some((c) => c.basis === 'future')) return { hour: h, n: null, basis: 'future', why: null, by_airport: per };
    const missing = APS.filter((a) => per[a].n == null);
    if (missing.length) {
      return { hour: h, n: null, basis: 'absent', by_airport: per,
        why: missing.map((a) => (APS.length > 1 ? `${AIRPORT_NAMES[a].iata}: ${per[a].why}` : per[a].why)).join(' · ') };
    }
    return { hour: h, n: cells.reduce((s, c) => s + c.n, 0), basis: cells.some((c) => c.basis === 'live') ? 'live' : 'confirmed',
      why: null, so_far: cells.some((c) => c.so_far), by_airport: per };
  };

  /* ── bookings ── */
  const atAirport = (code) => code != null && (airport === 'both' ? APS.includes(code) : code === airport);
  const B = new Map();   // d|h → {pickups, dropoffs, bookings, by_platform}
  const dayB = new Map();
  const platforms = new Map();
  for (const r of bookings) {
    const n = Number(r.n);
    const k = `${r.d}|${r.h}`;
    const cellB = B.get(k) || { pickups: 0, dropoffs: 0, bookings: 0, by_platform: {} };
    cellB.bookings += n;
    const p = cellB.by_platform[r.platform] || { pickups: 0, dropoffs: 0 };
    if (atAirport(r.pu)) { cellB.pickups += n; p.pickups += n; }
    if (atAirport(r.dr)) { cellB.dropoffs += n; p.dropoffs += n; }
    cellB.by_platform[r.platform] = p;
    B.set(k, cellB);
    const db = dayB.get(r.d) || { pickups: 0, dropoffs: 0, bookings: 0, completed_pickups: 0 };
    db.bookings += n;
    if (atAirport(r.pu)) { db.pickups += n; db.completed_pickups += Number(r.done || 0); }
    if (atAirport(r.dr)) db.dropoffs += n;
    dayB.set(r.d, db);
    if (r.d === day) {
      const pl = platforms.get(r.platform) || { platform: r.platform, bookings: 0, pickups: 0, dropoffs: 0, no_address: 0 };
      pl.bookings += n;
      if (atAirport(r.pu)) pl.pickups += n;
      if (atAirport(r.dr)) pl.dropoffs += n;
      pl.no_address += Number(r.noaddr || 0);
      platforms.set(r.platform, pl);
    }
  }

  /* ── the day ── */
  const hours = Array.from({ length: 24 }, (_, h) => {
    const lr = hourRow(day, h);
    const b = B.get(`${day}|${h}`) || { pickups: 0, dropoffs: 0, bookings: 0, by_platform: {} };
    return { ...lr, landings: lr.n, pickups: isFuture(day, h) ? null : b.pickups, dropoffs: isFuture(day, h) ? null : b.dropoffs,
      bookings: isFuture(day, h) ? null : b.bookings, by_platform: b.by_platform };
  });
  const past = hours.filter((x) => x.basis !== 'future');
  const measured = past.filter((x) => x.n != null);
  const dayTot = dayB.get(day) || { pickups: 0, dropoffs: 0, bookings: 0, completed_pickups: 0 };
  const landingsTotal = past.length && measured.length === past.length ? measured.reduce((s, x) => s + x.n, 0) : null;
  const firstAbsent = past.find((x) => x.n == null);

  /* ── the impact ── */
  const winDays = Array.from({ length: days }, (_, i) => addDays(from, i));
  const complete = (d) => APS.every((a) => cov.get(`${a}|${addDays(d, -1)}`)?.status === 'collected' && cov.get(`${a}|${d}`)?.status === 'collected');
  const landingsOf = (d, h) => APS.reduce((s, a) => s + (L.get(key(a, d, h)) || 0), 0);
  const pickupsOf = (d, h) => (B.get(`${d}|${h}`)?.pickups) || 0;
  const completeDays = winDays.filter(complete);
  const daily = winDays.map((d) => {
    const b = dayB.get(d) || { pickups: 0, dropoffs: 0, bookings: 0 };
    const done = complete(d);
    let why = null;
    if (!done) {
      const bad = [];
      for (const a of APS) for (const ud of [addDays(d, -1), d]) {
        if (cov.get(`${a}|${ud}`)?.status !== 'collected') bad.push(`${APS.length > 1 ? `${AIRPORT_NAMES[a].iata} ` : ''}UTC ${ud}: ${confirmedWhy(a, ud)}`);
      }
      why = bad[0] || null;
    }
    const future = d > today;
    return { day: d, landings: done ? Array.from({ length: 24 }, (_, h) => landingsOf(d, h)).reduce((s, v) => s + v, 0) : null,
      landings_why: done ? null : (future ? 'a day still to come' : why),
      pickups: future ? null : b.pickups, dropoffs: future ? null : b.dropoffs, bookings: future ? null : b.bookings,
      share_pct: !future && b.bookings ? r2((b.pickups / b.bookings) * 100) : null };
  });
  const winBookings = daily.reduce((s, x) => s + (x.bookings || 0), 0);
  const winPickups = daily.reduce((s, x) => s + (x.pickups || 0), 0);
  const pickupsInComplete = completeDays.reduce((s, d) => s + (dayB.get(d)?.pickups || 0), 0);
  let absentWhy = null;
  if (completeDays.length < MIN_DAYS) {
    absentWhy = `only ${completeDays.length} of these ${days} days ${completeDays.length === 1 ? 'has' : 'have'} every hour of landings `
      + `at ${label} confirmed by OpenSky's nightly list; the relationship needs at least ${MIN_DAYS}`
      + (completeDays.length ? '' : ` (${daily.find((x) => x.landings_why && x.landings_why !== 'a day still to come')?.landings_why || 'nothing collected yet'})`);
  } else if (pickupsInComplete < MIN_PICKUPS) {
    absentWhy = `only ${pickupsInComplete} airport ${pickupsInComplete === 1 ? 'pickup' : 'pickups'} at ${label} in the ${completeDays.length} complete days — `
      + `too few to relate to landings (at least ${MIN_PICKUPS})`;
  }
  const lags = LAGS.map((lag) => {
    const pairs = [];
    let sumL = 0, sumP = 0;
    for (const d of completeDays) {
      for (let h = 0; h < 24; h++) {
        const th = h + lag;
        const td = th >= 24 ? addDays(d, 1) : d;
        const tH = th % 24;
        if (td > day || isFuture(td, tH) || td < from) continue;
        const x = landingsOf(d, h), y = pickupsOf(td, tH);
        pairs.push([x, y]); sumL += x; sumP += y;
      }
    }
    const r = pearson(pairs);
    let slope = null;
    if (pairs.length >= 3) {
      const n = pairs.length, mx = sumL / n, my = sumP / n;
      let sxy = 0, sxx = 0;
      for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
      slope = sxx ? sxy / sxx : null;
    }
    return { lag, hours: pairs.length, r: r3(r), pickups_per_10_landings: sumL ? r2((sumP / sumL) * 10) : null,
      slope_per_10_landings: slope == null ? null : r2(slope * 10) };
  });
  const ranked = lags.filter((x) => x.r != null).sort((a, b) => b.r - a.r);
  const best = absentWhy ? null : ranked[0] || null;
  if (!absentWhy && !best) absentWhy = 'landings or airport pickups did not vary across the complete hours, so no correlation can be computed';

  /* ── origins ── */
  const originRows = (rows) => {
    const total = rows.reduce((s, r) => s + Number(r.n), 0);
    const known = rows.filter((r) => r.origin);
    return { total, unknown: rows.filter((r) => !r.origin).reduce((s, r) => s + Number(r.n), 0),
      top: known.sort((a, b) => Number(b.n) - Number(a.n)).slice(0, 15).map((r) => ({
        origin: r.origin, name: ORIGIN_NAMES[r.origin] || null, n: Number(r.n),
        share_pct: total ? r2((Number(r.n) / total) * 100) : null,
        note: APS.includes(r.origin) ? 'left and landed at the same airport — a go-around, a test or positioning flight, or OpenSky’s estimate of where it started' : null })) };
  };
  const dayHasConfirmed = APS.some((a) => cov.get(`${a}|${day}`)?.status === 'collected' || cov.get(`${a}|${addDays(day, -1)}`)?.status === 'collected');

  return {
    day, airport, airports: APS.map((a) => ({ icao: a, ...AIRPORT_NAMES[a] })), label, today, is_today: day === today,
    now: { day: clock.day, hour: clock.hour, minute: clock.minute }, fleet,
    landings: {
      hours: hours.map(({ hour, n, basis, why, so_far, by_airport }) => ({ hour, n, basis, why, so_far: !!so_far,
        by_airport: Object.fromEntries(Object.entries(by_airport).map(([a, c]) => [a, { n: c.n, basis: c.basis }])) })),
      total: landingsTotal,
      total_so_far: measured.reduce((s, x) => s + x.n, 0),
      hours_measured: measured.length, hours_past: past.length,
      live_hours: measured.filter((x) => x.basis === 'live').length,
      /* Words first, never a count first: the Arkiv hero animates a leading
         number, and "24 of 24 hours" reads as a figure. */
      total_why: landingsTotal == null ? (!past.length ? 'the day has not started'
        : !measured.length ? `no hour of this day has a landing figure: ${firstAbsent?.why}`
          : `only ${measured.length} of ${past.length} hours have a landing figure; the others: ${firstAbsent?.why}`) : null,
      note: COVERAGE_NOTE,
    },
    bookings: {
      hours: hours.map(({ hour, pickups, dropoffs, bookings: b, by_platform }) => ({ hour, pickups, dropoffs, bookings: b, by_platform })),
      totals: { bookings: dayTot.bookings, pickups: dayTot.pickups, completed_pickups: dayTot.completed_pickups, dropoffs: dayTot.dropoffs,
        share_pickups_pct: dayTot.bookings ? r2((dayTot.pickups / dayTot.bookings) * 100) : null },
      platforms: [...platforms.values()].sort((a, b) => b.pickups - a.pickups || b.dropoffs - a.dropoffs || b.bookings - a.bookings),
      rule: AIRPORT_RULE,
    },
    origins: { day: dayHasConfirmed ? originRows(originsDay) : null,
      day_why: dayHasConfirmed ? null : 'no confirmed landing on this day yet — OpenSky’s list carries the origin, the live estimate does not',
      window: originRows(originsWindow) },
    impact: {
      from, to: day, days, days_complete: completeDays.length, days_needed: MIN_DAYS,
      absent_why: absentWhy,
      lags, best_lag: best ? best.lag : null, r: best ? best.r : null,
      pickups_per_10_landings: best ? best.pickups_per_10_landings : null,
      slope_per_10_landings: best ? best.slope_per_10_landings : null,
      daily,
      share_pickups_pct: winBookings ? r2((winPickups / winBookings) * 100) : null,
      pickups: winPickups, bookings: winBookings,
      complete_days: completeDays,
      caveat: CAVEAT,
    },
    live: {
      last_poll_at: liveRun?.finished_at || null, status: liveRun?.status || null, error: liveRun?.status === 'error' ? liveRun.error : null,
      checked: liveCheck.checked ?? null, matched: liveCheck.matched ?? null,
      confirmed_watched: liveCheck.confirmed_watched ?? null, caught: liveCheck.caught ?? null,
    },
    arrivals_run: arrRun ? { status: arrRun.status, error: arrRun.error || null, finished_at: arrRun.finished_at } : null,
    basis: `Landings: OpenSky Network arrivals at ${label} (its nightly list; live final-approach estimates where a day is not `
      + `published yet, labelled). Airport trips: the fleet’s bookings${fleet ? ` (${fleet})` : ''} whose pickup or drop-off `
      + 'address names the airport, any outcome, by the Dubai hour the booking was made.',
  };
}

export function airportRoutes(app, { q, wrap }) {
  app.get('/api/airport', wrap(async (req, res) => {
    const nowMs = Date.now();
    const today = dubaiDay(new Date(nowMs));
    const day = isDay(req.query.day) && req.query.day <= today ? req.query.day : today;
    const airport = ['OMDB', 'OMDW', 'both'].includes(req.query.airport) ? req.query.airport : 'OMDB';
    const d0 = Number.parseInt(req.query.days, 10);
    const days = Number.isFinite(d0) ? Math.min(AIRPORT_WINDOW.max, Math.max(AIRPORT_WINDOW.min, d0)) : AIRPORT_WINDOW.dflt;
    const fleet = /^[a-z0-9_]{1,32}$/i.test(String(req.query.fleet || '')) ? String(req.query.fleet) : null;
    const from = addDays(day, -(days - 1));
    const aps = airport === 'both' ? ['OMDB', 'OMDW'] : [airport];
    const span = `>= ($1::date::timestamp AT TIME ZONE 'Asia/Dubai') AND COL < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dubai')`;
    const between = (col) => `${col} ${span.replace('COL', col)}`;
    const [coverage, landed, live, liveHours, bookings, originsDay, originsWindow, runs, check1, check2] = await Promise.all([
      q(`SELECT airport, utc_day::text AS utc_day, status, reason, landings FROM flight_day_coverage
          WHERE airport = ANY($3::text[]) AND utc_day BETWEEN ($1::date - 1) AND $2::date`, [from, day, aps]),
      q(`SELECT airport, (landed_at AT TIME ZONE 'Asia/Dubai')::date::text AS d,
                extract(hour FROM landed_at AT TIME ZONE 'Asia/Dubai')::int AS h, count(*)::int AS n
           FROM flight_landing WHERE airport = ANY($3::text[]) AND ${between('landed_at')} GROUP BY 1, 2, 3`, [from, day, aps]),
      q(`SELECT airport, (landed_at AT TIME ZONE 'Asia/Dubai')::date::text AS d,
                extract(hour FROM landed_at AT TIME ZONE 'Asia/Dubai')::int AS h, count(*)::int AS n
           FROM flight_live_landing WHERE airport = ANY($3::text[]) AND superseded_at IS NULL AND ${between('landed_at')}
          GROUP BY 1, 2, 3`, [day, day, aps]),
      q(`SELECT (hour_start AT TIME ZONE 'Asia/Dubai')::date::text AS d, extract(hour FROM hour_start AT TIME ZONE 'Asia/Dubai')::int AS h,
                polls, polls_ok, last_error FROM flight_live_hour WHERE ${between('hour_start')}`, [day, day]),
      /* The window's bookings, by Dubai day, hour, platform and the airport
         each end names (NULL for neither) — a few thousand groups at most.
         The day bounds are also written on requested_at so the planner can
         range over its index (the same reason as server.js W()). */
      q(`SELECT local_day::text AS d, local_hour AS h, platform,
                ${airportOfSql('pickup_addr')} AS pu, ${airportOfSql('dropoff_addr')} AS dr,
                count(*)::int AS n, count(*) FILTER (WHERE outcome = 'completed')::int AS done,
                count(*) FILTER (WHERE pickup_addr IS NULL OR btrim(pickup_addr) = '')::int AS noaddr
           FROM trip_norm
          WHERE is_booking AND local_day BETWEEN $1::date AND $2::date AND ${between('requested_at')}
            AND ($3::text IS NULL OR fleet_id = $3)
          GROUP BY 1, 2, 3, 4, 5`, [from, day, fleet]),
      q(`SELECT origin, count(*)::int AS n FROM flight_landing
          WHERE airport = ANY($3::text[]) AND ${between('landed_at')} GROUP BY 1`, [day, day, aps]),
      q(`SELECT origin, count(*)::int AS n FROM flight_landing
          WHERE airport = ANY($3::text[]) AND ${between('landed_at')} GROUP BY 1`, [from, day, aps]),
      /* OUTSIDE the reader's fleet scope, on purpose. The OpenSky collector
         files its runs with fleet_id NULL (the sky is not a fleet's), and
         v124's policy shows a one-fleet reader no NULL-fleet row — so for
         that reader this read came back empty, arrivals_run was null, and
         every hour nothing covered was given a reason that was not the true
         one ("not asked yet", "older than the 30 days") where an unrestricted
         reader was told "no OpenSky client configured". Measured in the
         review of 2026-11-16 (test/rls_routes.test.mjs section 3). These two
         rows are the collector's state, the same for every reader, and carry
         no fleet's data; the bookings above stay inside the scope. */
      outsideFleetScope(() => q(`SELECT DISTINCT ON (mode) mode, status, error, finished_at FROM collection_run
          WHERE source = 'opensky' ORDER BY mode, finished_at DESC NULLS LAST`)),
      /* How good the live estimate has been, where the nightly list has since
         arrived: of the estimates checked, how many were real landings; and
         of the confirmed landings in watched hours, how many it caught. */
      q(`SELECT count(*)::int AS checked, count(confirmed_id)::int AS matched FROM flight_live_landing
          WHERE airport = ANY($3::text[]) AND superseded_at IS NOT NULL AND ${between('landed_at')}`, [from, day, aps]),
      q(`SELECT count(*)::int AS confirmed_watched,
                count(*) FILTER (WHERE EXISTS (SELECT 1 FROM flight_live_landing l WHERE l.confirmed_id = f.id))::int AS caught
           FROM flight_landing f
           JOIN flight_live_hour h ON h.hour_start = date_trunc('hour', f.landed_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                                  AND h.polls_ok >= 20
          WHERE f.airport = ANY($3::text[]) AND ${between('f.landed_at')}`, [from, day, aps]),
    ]);
    /* The live watch logs mode 'realtime' (src/sources/flights.js LIVE_MODE:
       a two-minute tick must not move the response cache's version), the
       arrivals run mode 'arrivals'. Written out rather than imported: that
       module brings the collector's pool with it. */
    const byMode = Object.fromEntries(runs.map((r) => [r.mode, r]));
    res.json(airportShape({ day, airport, days, fleet, nowMs, coverage, landed, live, liveHours, bookings,
      originsDay, originsWindow, runs: { arrivals: byMode.arrivals, live: byMode.realtime },
      liveCheck: { ...(check1[0] || {}), ...(check2[0] || {}) },
      backfillDays: Math.max(1, getInt('OPENSKY_BACKFILL_DAYS', 30)) }));
  }));
}
