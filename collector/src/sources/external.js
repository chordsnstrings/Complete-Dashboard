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
async function pullWeather(failed = []) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max`
    + `&past_days=30&forecast_days=7&timezone=Asia%2FDubai`;
  const { data } = await http(url, { timeoutMs: 45000, retries: 3 });
  const d = data?.daily;
  if (!d?.time) { failed.push('weather: open-meteo answered without a daily block'); return 0; }
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

/* The window, whatever shape the caller had it in.
   ─────────────────────────────────────────────────────────────────────────
   runWindow hands every source a DATE, not a string: src/run.js:228-252 calls
   it with daysAgo(...)/monthsAgo(...) and new Date(), and passes both straight
   through to collect(). This file read them as strings — from.slice(0, 4) —
   and every incremental run after the range fill shipped failed with
   "from.slice is not a function", one minute past every half hour, in silence:
   the collector records the error against the source and carries on, so the
   pages it feeds looked unchanged and only /api/status said anything.

   Both shapes are real — a Date from the scheduler, a string from a CLI
   invocation or a test — so this takes either rather than picking one and
   throwing on the other. Placed at the boundary of the function that needs a
   string, not at its call site, so a future caller cannot reintroduce it. */
const dayOf = (v) => (v == null ? null
  : v instanceof Date ? dubaiDay(v)
    : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10)
      : dubaiDay(new Date(v)));

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
async function pullSun(from, to, failed = []) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}`
    + `&daily=sunrise,sunset&start_date=${from}&end_date=${to}&timezone=Asia%2FDubai`;
  const out = new Map();
  try {
    const { data } = await http(url, { timeoutMs: 45000, retries: 2 });
    const d = data?.daily;
    if (!d?.time) { failed.push('sun: open-meteo answered without a daily block'); return out; }
    d.time.forEach((day, i) => {
      const rise = d.sunrise?.[i]; const set = d.sunset?.[i];
      if (rise || set) out.set(day, { sunrise: rise ? `${rise}:00+04:00` : null, sunset: set ? `${set}:00+04:00` : null });
    });
  } catch (e) {
    /* A missing sunrise is a missing sunrise. The Hijri half of this row is
       the half anything reads, and it is not worth losing to this. */
    log.warn(SRC, 'sun lookup failed for the range', { from, to, err: String(e).slice(0, 100) });
    failed.push(`sun ${from}..${to}: ${String(e).slice(0, 120)}`);
  }
  return out;
}

async function pullCalendar(rawFrom, rawTo, failed = []) {
  const from = dayOf(rawFrom);
  const to = dayOf(rawTo);
  if (!from || !to) return 0;
  const today = dubaiDay();
  // Nothing ahead of today: a Hijri date for a day that has not happened is
  // real, but a calendar row for it would join to trips that cannot exist.
  const end = to > today ? today : to;
  if (from > end) return 0;

  const sun = await pullSun(from, end, failed);
  const rows = [];
  for (const [y, m] of monthsBetween(from, end)) {
    let days = null;
    try {
      const { data } = await http(`https://api.aladhan.com/v1/gToHCalendar/${m}/${y}`,
        { timeoutMs: 30000, retries: 2 });
      days = Array.isArray(data?.data) ? data.data : null;
    } catch (e) {
      log.warn(SRC, 'hijri month lookup failed', { y, m, err: String(e).slice(0, 100) });
      failed.push(`hijri ${y}-${String(m).padStart(2, '0')}: ${String(e).slice(0, 120)}`);
    }
    if (!days) { if (!failed.some((f) => f.startsWith(`hijri ${y}-`))) failed.push(`hijri ${y}-${String(m).padStart(2, '0')}: answered without a calendar`); continue; }
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
  /* A range with days in it that yields no rows is a failure, whichever step
     swallowed it — the provider answering 200 with a calendar this code cannot
     read looks, from here, exactly like the provider being down. Production
     wrote zero calendar rows on a backfill spanning 25 months and reported ok.
     This is the line that stops that being possible. */
  if (!rows.length) {
    failed.push(`calendar ${from}..${end}: asked for `
      + `${monthsBetween(from, end).length} month(s) and wrote no day`);
    return 0;
  }
  return upsertMany('calendar_day', rows, ['day']);
}

export async function collect({ mode = 'incremental', from = null, to = null } = {}) {
  /* Why this source cannot simply say 'ok'.
     ───────────────────────────────────────────────────────────────────────
     Every fetch under here swallows: pullWeather returns 0 on a body with no
     daily block, the Hijri lookup catches into log.warn and `continue`, and
     pullCalendar returns 0 if nothing accumulated. The run status was the
     literal 'ok', so the only outcomes this source could ever report were
     'ok' and a thrown error.

     Measured on production 2026-09-02: all three latest runs — backfill,
     catch-up and incremental — reported ok with rows_written 37, and 37 is
     exactly past_days 30 + forecast_days 7. The calendar half had written
     nothing on any of them, including a backfill spanning 25 months and 25
     Aladhan calls. calendar_day stopped dead at 2026-08-31; every day since,
     today included, carried hijri_month NULL and is_holiday NULL, on a
     product that prints Ramadan and public holidays beside every trip and
     feeds them to the forecaster. Nothing anywhere said so.

     uber_fleet.js:359-392 already carries this treatment; it was never
     brought here. */
  const failed = [];
  try {
    const w = await pullWeather(failed);
    /* The range the run asked for, and a fortnight either way on an
       incremental — cheap (one Aladhan call per month), and it repairs the
       history that the one-row-per-run version never wrote. */
    const today = dubaiDay();
    const back = (days) => {
      const d = new Date(`${today}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() - days);
      return d.toISOString().slice(0, 10);
    };
    const c = await pullCalendar(from || back(45), to || today, failed);
    /* A run that wrote the weather and none of the calendar is 'partial': half
       the product's context landed. One that wrote neither is an error however
       quietly each half failed. */
    await logRun({ source: SRC, fleet_id: null, mode, rows_written: w + c,
      status: !failed.length ? 'ok' : (w + c > 0 ? 'partial' : 'error'),
      error: failed.length ? failed.slice(0, 4).join('; ').slice(0, 400) : null });
    log.info(SRC, 'done', { weather_days: w, calendar: c, failed: failed.length });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
