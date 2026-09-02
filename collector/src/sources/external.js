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

/* The Hijri date, computed here instead of fetched.
   ─────────────────────────────────────────────────────────────────────────
   MEASURED, production, 2026-09-02:

     external incremental partial
       hijri 2026-08: TypeError: fetch failed (ETIMEDOUT) …/gToHCalendar/8/2026
       hijri 2026-09: TypeError: fetch failed (ETIMEDOUT) …/gToHCalendar/9/2026
       calendar 2026-08-30..2026-09-02: asked for 2 month(s) and wrote no day

   calendar_day stopped dead at 2026-08-31 — /api/day says 2026-08-28 carries
   15-03-1448 and 2026-09-01 carries nothing — while the same host answers that
   exact URL with HTTP 200 in 0.81s from outside the app.

   Four candidates were tested rather than guessed between, and three are ruled
   out by measurement:

   • "the timeout is too short". No. Measured on this Node: when THIS wrapper's
     AbortController fires, fetch rejects with `AbortError: This operation was
     aborted` and no err.cause — never `TypeError: fetch failed (ETIMEDOUT)`.
     ETIMEDOUT is the socket reporting that the CONNECTION never came up, so
     the endpoint is never reached and no timeoutMs saves it.
   • "slow only for the calendar endpoints". No. hToG/01-09-1447 is a single
     date conversion and it fails identically in events.js, same code, same
     minute. Nothing is reached to be slow.
   • "the retry policy gives up too early". No. http() already makes three
     attempts with backoff per call, the 25-month backfill made 25 such calls
     and the incremental made 2, and every attempt on every run since 08-31
     ended the same way.
   • "IPv6 first, blackholed". Plausible and NOT confirmed: api.aladhan.com
     publishes an AAAA (2a01:4ff:f0:ab3::1) and api.open-meteo.com — which
     answered in the SAME run, 37 weather days plus the whole sunrise range —
     publishes none. But this image is node:20-slim, where autoSelectFamily is
     on by default and falls back to IPv4 in 250ms, so that alone should not
     produce this. Confirming it needs a measurement from inside the container,
     which nothing outside can make. It is recorded as a hypothesis, not a
     cause.

   What is certain is that the app cannot open a connection to that host, and
   nothing in this file can change that. So the calendar stops depending on it.

   The Hijri calendar is deterministic and ICU already carries it. Aladhan's
   gToHCalendar answers with method HJCoSA, and Intl's `islamic-umalqura`
   agrees with it on ALL 1096 days of 2024-01-01..2026-12-31 — day, month and
   year, zero mismatches — checked against the provider's own JSON. It also
   reproduces every one of the 48 stored days sampled back through /api/day to
   2025-09-01, which is as far as calendar_day goes.

   The month NAMES are Aladhan's own transliterations rather than ICU's
   ("Ṣafar", not "Safar"), because a year of rows already in the table spell
   them that way and hijri_month is rendered as text and grouped on. */
const HIJRI_MONTHS = ['Muḥarram', 'Ṣafar', 'Rabīʿ al-awwal', 'Rabīʿ al-thānī',
  'Jumādá al-ūlá', 'Jumādá al-ākhirah', 'Rajab', 'Shaʿbān', 'Ramaḍān',
  'Shawwāl', 'Dhū al-Qaʿdah', 'Dhū al-Ḥijjah'];

// UTC, deliberately: the argument is already a Dubai calendar day, and asking
// the formatter to re-zone it would shift it back off that day.
const hijriFmt = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura',
  { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });

const pad2 = (n) => String(n).padStart(2, '0');

/* A runtime whose ICU has no Umm al-Qura calendar does not throw — Intl
   silently falls back to Gregorian, and every hijri_date would then be a
   Gregorian date wearing a Hijri label. That is precisely the silent-wrong
   this file exists to stop, so it is checked once rather than assumed. The app
   image is node:20-slim, which is an official Node build and ships full ICU;
   this is the guard for the day that stops being true. */
export const HIJRI_CALENDAR_AVAILABLE =
  hijriFmt.resolvedOptions().calendar === 'islamic-umalqura';

// The Hijri date of a 'YYYY-MM-DD' Gregorian day, or null if it is not one.
export function hijriOf(day) {
  if (!HIJRI_CALENDAR_AVAILABLE) return null;
  const t = Date.parse(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(hijriFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const d = Number(p.day);
  const m = Number(p.month);
  // Some ICU locales append the era to the year part ("1448 AH"); the digits
  // are the year either way.
  const y = Number(String(p.year).replace(/\D/g, ''));
  if (!(d >= 1 && d <= 30) || !(m >= 1 && m <= 12) || !(y > 0)) return null;
  return { day: d, month: m, year: y, month_en: HIJRI_MONTHS[m - 1],
    date: `${pad2(d)}-${pad2(m)}-${y}` };
}

/* And the other direction, for events.js: which Gregorian day is 1 Ramaḍān?
   Intl converts one way only, so this estimates from the Hijri epoch — 1
   Muḥarram 1 AH, and a mean year of 354.36707 days — and then walks outward
   until hijriOf() agrees. The estimate is never more than a couple of days out
   over the range this product cares about; ±45 is slack, not a guess. Verified
   both ways: every day of 2020-01-01..2030-12-31 round-trips, 4018 for 4018. */
const HIJRI_EPOCH_UTC = Date.UTC(622, 6, 19);

export function gregorianOfHijri(hy, hm, hd) {
  const guess = HIJRI_EPOCH_UTC
    + Math.round(((hy - 1) * 354.36707 + (hm - 1) * 29.530589 + (hd - 1)) * 864e5);
  for (let off = 0; off <= 45; off++) {
    for (const s of (off ? [off, -off] : [0])) {
      const iso = new Date(guess + s * 864e5).toISOString().slice(0, 10);
      const h = hijriOf(iso);
      if (h && h.year === hy && h.month === hm && h.day === hd) return iso;
    }
  }
  return null;
}

const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/* Every day of the range, with no hole possible.
   ─────────────────────────────────────────────────────────────────────────
   Pure and exported so the calendar can be tested without a network or a
   database — the previous shape could only be exercised by reaching two public
   APIs, which is why "wrote no day" was never caught by a test. */
export function calendarDays(from, to) {
  const rows = [];
  if (!from || !to || from > to) return rows;
  // A runaway guard, not a range limit: the longest window this collector is
  // ever handed is the 25-month backfill, ~760 days.
  for (let d = from, guard = 0; d <= to && guard < 40000; d = nextDay(d), guard++) {
    const h = hijriOf(d);
    if (!h) continue;
    rows.push({ day: d, hijri_date: h.date, hijri_month: h.month_en, is_ramadan: h.month === 9 });
  }
  return rows;
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

/* One live call per run, to keep the local table honest — not to fill it.
   ─────────────────────────────────────────────────────────────────────────
   The rows above no longer need this. But a computed calendar that silently
   drifts from the provider would be a new way to be quietly wrong, and the
   whole point of this file is not being quietly wrong. So one month is asked
   for, and only DISAGREEMENT is reported: a run whose data is complete does
   not get to say 'partial' because a cross-check could not reach a host.

   Bounded on purpose. The old shape asked for a month per month of window,
   with retries:2 and timeoutMs:30000 — on the 25-month backfill that is 75
   connection attempts that each have to time out, and it is why the external
   run has been taking tens of minutes to write nothing. One call, no retry,
   eight seconds. */
async function crossCheckHijri(rows, failed = []) {
  if (!rows.length) return;
  const [y, m] = [Number(rows[rows.length - 1].day.slice(0, 4)),
    Number(rows[rows.length - 1].day.slice(5, 7))];
  let days = null;
  try {
    const { data } = await http(`https://api.aladhan.com/v1/gToHCalendar/${m}/${y}`,
      { timeoutMs: 8000, retries: 0 });
    days = Array.isArray(data?.data) ? data.data : null;
  } catch (e) {
    // Exactly the ETIMEDOUT this fix exists for. Recorded, not escalated.
    log.warn(SRC, 'hijri cross-check unreachable', { y, m, err: String(e).slice(0, 120) });
    return;
  }
  if (!days) { log.warn(SRC, 'hijri cross-check answered without a calendar', { y, m }); return; }
  const mine = new Map(rows.map((r) => [r.day, r.hijri_date]));
  const off = [];
  for (const entry of days) {
    // "DD-MM-YYYY", the provider's own format for the Gregorian side.
    const parts = String(entry?.gregorian?.date || '').split('-');
    if (parts.length !== 3) continue;
    const day = `${parts[2]}-${parts[1]}-${parts[0]}`;
    const theirs = entry?.hijri?.date;
    if (!mine.has(day) || !theirs) continue;
    if (mine.get(day) !== theirs) off.push(`${day} local=${mine.get(day)} aladhan=${theirs}`);
  }
  if (off.length) {
    failed.push(`hijri cross-check ${y}-${pad2(m)}: ${off.length} day(s) disagree — ${off[0]}`);
    log.warn(SRC, 'hijri cross-check disagrees', { y, m, n: off.length, first: off[0] });
  } else {
    log.info(SRC, 'hijri cross-check agrees', { y, m, days: mine.size });
  }
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
  /* Computed first, and unconditionally. This is the line that changes: the
     Hijri half of the row no longer has a network call between the range and
     the table, so "asked for 2 month(s) and wrote no day" cannot happen
     because a host was unreachable. */
  const rows = calendarDays(from, end);
  for (const row of rows) {
    const s = sun.get(row.day);
    // Only where it is known: upsertMany updates the columns it is given, so
    // omitting them leaves an earlier value alone rather than nulling it.
    if (s) { row.sunrise = s.sunrise; row.sunset = s.sunset; }
  }

  await crossCheckHijri(rows, failed);

  /* A range with days in it that yields no rows is a failure, whichever step
     swallowed it — the provider answering 200 with a calendar this code cannot
     read looks, from here, exactly like the provider being down. Production
     wrote zero calendar rows on a backfill spanning 25 months and reported ok.
     This is the line that stops that being possible. It should now be
     unreachable for any real window, and it stays because "should" is not
     "is". */
  if (!rows.length) {
    failed.push(HIJRI_CALENDAR_AVAILABLE
      ? `calendar ${from}..${end}: asked for `
        + `${monthsBetween(from, end).length} month(s) and wrote no day`
      : `calendar ${from}..${end}: this runtime's ICU has no islamic-umalqura `
        + `calendar (resolved '${hijriFmt.resolvedOptions().calendar}'), so no Hijri date can be computed`);
    return 0;
  }
  return upsertMany('calendar_day', rows, ['day']);
}

export async function collect({ mode = 'incremental', from = null, to = null } = {}) {
  /* Why this source cannot simply say 'ok'.
     ───────────────────────────────────────────────────────────────────────
     Every fetch under here swallows: pullWeather returns 0 on a body with no
     daily block, the sun lookup catches into log.warn, and pullCalendar
     returns 0 if nothing accumulated. The run status was the literal 'ok', so
     the only outcomes this source could ever report were 'ok' and a thrown
     error.

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
    /* The range the run asked for, and a month and a half back on an
       incremental. That used to cost one Aladhan call per month of window;
       it now costs nothing but arithmetic, so the reach-back also repairs
       whatever the outage left NULL — 2026-09-01 onward on production — the
       first time this runs after a deploy. */
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
