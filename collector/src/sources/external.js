// External context that materially changes fleet decisions but isn't in any operator API:
//   • weather   — heat drives EV range + AC load; rain drives demand spikes AND crash risk
//   • calendar  — Hijri months (Ramadan) and daylight shift demand rhythm and night-risk windows
// All sources are free and key-less.
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { log } from '../log.js';

const SRC = 'external';
const LAT = 25.2048, LON = 55.2708;              // Dubai

// Past 30 days + 7-day forecast in one call (open-meteo serves both from the forecast endpoint).
async function pullWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max`
    + `&past_days=30&forecast_days=7&timezone=Asia%2FDubai`;
  const { data } = await http(url, { timeoutMs: 45000, retries: 3 });
  const d = data?.daily;
  if (!d?.time) return 0;
  /* The Dubai day, not the UTC one. open-meteo was asked for Asia/Dubai days,
     so between 20:00 and midnight Dubai a UTC "today" marked the current day
     as a forecast — and everything that reads is_forecast then treats a
     measured day as a prediction. */
  const today = dubaiDay();
  const rows = d.time.map((day, i) => ({
    day,
    temp_max: d.temperature_2m_max?.[i] ?? null,
    temp_min: d.temperature_2m_min?.[i] ?? null,
    precipitation: d.precipitation_sum?.[i] ?? null,
    wind_max: d.wind_speed_10m_max?.[i] ?? null,
    is_forecast: day > today,
    raw: { t: d.temperature_2m_max?.[i], p: d.precipitation_sum?.[i] },
  }));
  return upsertMany('weather_daily', rows, ['day']);
}

/* The calendar, for every day in the window rather than for today.
   ─────────────────────────────────────────────────────────────────────────
   This wrote exactly ONE row per run — `day: iso(now)` — so calendar_day held
   a row for each day the collector happened to run and nothing before it. On
   production that is is_ramadan answering for 21–31 August and NULL for 1–20,
   on a page that prints it as context beside every trip. The gap is not a
   provider limit: Aladhan serves a whole Gregorian month per call, and always
   has.

   And `iso(now)` is the UTC date. The fleet works Asia/Dubai and every join key
   in this database is a Dubai day, so between 20:00 and midnight Dubai this
   stamped the row with YESTERDAY — writing the wrong calendar onto four hours
   of every day, silently, and only for the runs that landed in that window.

   Both fixed here: Dubai days, a month at a time, over the range asked for. */

// The Dubai calendar date of an instant. Asia/Dubai is UTC+4 with no DST — it
// has had no transition since 1972 — so the shift is a constant, and a
// constant is worth more than a formatter here: this runs in the collector,
// under whatever TZ the container was started with.
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const dubaiDay = (d = new Date()) => new Date(d.getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10);

// Every YYYY-MM that the window touches, oldest first.
function monthsBetween(from, to) {
  const out = [];
  let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const last = `${to.slice(0, 4)}-${to.slice(5, 7)}`;
  for (let guard = 0; guard < 400; guard++) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push([y, m]);
    if (key >= last) break;
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/* Sunrise and sunset for a range, from the API this file already trusts for
   weather. The previous code asked sunrise-sunset.org, which answers one day
   per call — fine for a single row, hopeless for a month, and the reason the
   column was only ever written for the day the run happened. open-meteo serves
   both in the same daily block, so a month is one call.

   The times come back without an offset because the request names the zone, so
   the offset is appended: bound into a timestamptz column by a collector
   running in UTC, a bare local time would land four hours early. */
async function pullSun(from, to) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=sunrise,sunset&start_date=${from}&end_date=${to}&timezone=Asia%2FDubai`;
  const out = new Map();
  try {
    const { data } = await http(url, { timeoutMs: 45000, retries: 2 });
    const d = data?.daily;
    if (!d?.time) return out;
    d.time.forEach((day, i) => {
      const rise = d.sunrise?.[i]; const set = d.sunset?.[i];
      if (rise || set) out.set(day, { sunrise: rise ? `${rise}:00+04:00` : null, sunset: set ? `${set}:00+04:00` : null });
    });
  } catch (e) {
    /* A missing sunrise is a missing sunrise. The Hijri half of this row is
       the half anything reads, and it is not worth losing to this. */
    log.warn(SRC, 'sun lookup failed for the range', { from, to, err: String(e).slice(0, 100) });
  }
  return out;
}

async function pullCalendar(from, to) {
  const today = dubaiDay();
  // Nothing ahead of today: a Hijri date for a day that has not happened is
  // real, but a calendar row for it would join to trips that cannot exist.
  const end = to > today ? today : to;
  if (from > end) return 0;

  const sun = await pullSun(from, end);
  const rows = [];
  for (const [y, m] of monthsBetween(from, end)) {
    let days = null;
    try {
      const { data } = await http(`https://api.aladhan.com/v1/gToHCalendar/${m}/${y}`,
        { timeoutMs: 30000, retries: 2 });
      days = Array.isArray(data?.data) ? data.data : null;
    } catch (e) {
      log.warn(SRC, 'hijri month lookup failed', { y, m, err: String(e).slice(0, 100) });
    }
    if (!days) continue;
    for (const entry of days) {
      // "DD-MM-YYYY", the provider's own format for the Gregorian side.
      const g = String(entry?.gregorian?.date || '');
      const parts = g.split('-');
      if (parts.length !== 3) continue;
      const day = `${parts[2]}-${parts[1]}-${parts[0]}`;
      if (day < from || day > end) continue;
      const h = entry?.hijri;
      const row = {
        day,
        hijri_date: h?.date || null,
        hijri_month: h?.month?.en || null,
        is_ramadan: Number(h?.month?.number) === 9,
      };
      const s = sun.get(day);
      // Only where it is known: upsertMany updates the columns it is given, so
      // omitting them leaves an earlier value alone rather than nulling it.
      if (s) { row.sunrise = s.sunrise; row.sunset = s.sunset; }
      rows.push(row);
    }
  }
  if (!rows.length) return 0;
  return upsertMany('calendar_day', rows, ['day']);
}

export async function collect({ mode = 'incremental', from = null, to = null } = {}) {
  try {
    const w = await pullWeather();
    /* The range the run asked for, and a fortnight either way on an
       incremental — cheap (one Aladhan call per month), and it repairs the
       history that the one-row-per-run version never wrote. */
    const today = dubaiDay();
    const back = (days) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const c = await pullCalendar(from || back(45), to || today);
    await logRun({ source: SRC, fleet_id: null, mode, status: 'ok', rows_written: w + c });
    log.info(SRC, 'done', { weather_days: w, calendar: c });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
