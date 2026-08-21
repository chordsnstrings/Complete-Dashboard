// External context that materially changes fleet decisions but isn't in any operator API:
//   • weather   — heat drives EV range + AC load; rain drives demand spikes AND crash risk
//   • calendar  — Hijri months (Ramadan) and daylight shift demand rhythm and night-risk windows
// All sources are free and key-less.
import { http } from '../http.js';
import { upsertMany, upsert, logRun } from '../db.js';
import { iso } from '../util.js';
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
  const today = iso(new Date());
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

// Hijri date for today + daylight bounds. Ramadan (month 9) reshapes demand completely.
async function pullCalendar() {
  const now = new Date();
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = now.getUTCFullYear();
  let hijri = null, sun = null;
  try {
    const { data } = await http(`https://api.aladhan.com/v1/gToH/${dd}-${mm}-${yyyy}`, { timeoutMs: 20000, retries: 2 });
    hijri = data?.data?.hijri || null;
  } catch (e) { log.warn(SRC, 'hijri lookup failed', { err: String(e).slice(0, 80) }); }
  try {
    const { data } = await http(`https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LON}&formatted=0`, { timeoutMs: 20000, retries: 2 });
    sun = data?.results || null;
  } catch (e) { log.warn(SRC, 'sun lookup failed', { err: String(e).slice(0, 80) }); }
  if (!hijri && !sun) return 0;
  await upsert('calendar_day', {
    day: iso(now),
    hijri_date: hijri?.date || null,
    hijri_month: hijri?.month?.en || null,
    is_ramadan: hijri?.month?.number === 9,
    sunrise: sun?.sunrise || null,
    sunset: sun?.sunset || null,
  }, ['day']);
  return 1;
}

export async function collect({ mode = 'incremental' } = {}) {
  try {
    const w = await pullWeather();
    const c = await pullCalendar();
    await logRun({ source: SRC, fleet_id: null, mode, status: 'ok', rows_written: w + c });
    log.info(SRC, 'done', { weather_days: w, calendar: c });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
