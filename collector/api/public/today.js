/* Today, live, on both shells.
   ─────────────────────────────────────────────────────────────────────────
   The product had today and hid it. The desktop lands on Unit economics over
   a thirty-day window; the phone's first tab is called "Today" and its
   subtitle read THIS MONTH, its chart captioned "4 complete days, today
   excluded — it is still filling", and the only mention of the current day
   was a clause at the end of a paragraph. Both were right about the
   arithmetic — a part-day averaged into a daily rate reads as a collapse, and
   that bug is why the exclusion exists — and both answered a question nobody
   opened the app to ask. An operator opening a fleet dashboard at 06:45 wants
   to know what the fleet has done since midnight and how many cars are
   reporting right now.

   So today is stated in its own right, beside the window rather than inside
   it: the exclusion from the RATE stands, and the day gets its own line.

   ── which money, and why not the other one ───────────────────────────────
   /api/day carries two money figures for a day and they differ by an order of
   magnitude — on 5 September, AED 964 and AED 9,657. The larger one is
   `accounted`, and its own basis line says what it is: "a share of each weekly
   platform statement, spread evenly across the days it covers". That is the
   right figure for a settled day and the wrong one for a day three hours old,
   because it is a seventh of a week that has not happened yet — it would print
   the same number at 06:00 as at 23:00 and move only when the statement did.

   The fares are a MEASUREMENT of today: the price on each booking the fleet
   has actually taken since midnight. So that is what this shows, with the
   count it covers, and the day page is one click away for the accounted view
   with its basis stated. A live line must not carry a projection.

   ── absent, never zero ───────────────────────────────────────────────────
   Before the first booking of the day lands, every one of these is genuinely
   unmeasured. The line says so, with the minute it is speaking at, rather
   than printing a row of noughts that reads as a dead fleet. */
import { api } from './data.js';
import { dubaiDay, dubaiClock } from './tz.js';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/* One shape, both shells. Each surface renders it in its own idiom; neither
   decides what "today" means, which is what kept the phone and the desktop
   disagreeing about it in the first place. */
export async function todayLive() {
  const day = dubaiDay();
  /* Whole fleet, both channels: /api/day takes a day and nothing else, so a
     strip that claimed to honour the channel chips would be lying about a
     figure it cannot filter. The tile says so. */
  /* Live, never the cache. api() is stale-while-revalidate and returns the
     held body immediately, which is right for a page about a window and wrong
     for a band that puts a Dubai clock time on itself: on production the band
     read 56 bookings "as of 07:15" while the lede three inches below it, off a
     different endpoint, read 68. Two numbers for today on one screen is the
     exact complaint the calendar window was built to answer.

     Two things make it live. Passing an options object at all takes api() off
     the stale-while-revalidate path — it neither reads nor writes the store —
     and `no-store` stops the browser's own HTTP cache. The minute stamp is for
     the third cache, the server's: it is version-keyed and re-checks every 30
     seconds, so a stamp that changes once a minute costs at most one real
     computation a minute and can never serve a body from before it. */
  const minute = Math.floor(Date.now() / 60000);
  const live = (path) => api(`${path}&t=${minute}`, { cache: 'no-store' }).catch(() => null);
  const [d, k] = await Promise.all([
    live(`/api/day?day=${day}`),
    live('/api/kpis?days=1'),
  ]);
  const h = d?.headline || {};
  const bookings = num(h.bookings);
  return {
    day,
    asOf: dubaiClock().hhmm,
    /* null, not 0, when the day has not been collected at all — the caller
       renders a sentence rather than a grid of noughts. */
    started: bookings != null && bookings > 0,
    bookings,
    completed: num(h.completed),
    cancelled: num(h.not_completed),
    priced: num(h.priced),
    fares: num(h.revenue),
    km: num(h.booked_km),
    drivers: num(h.drivers),
    vehicles: num(h.vehicles),
    lastAt: h.last_at || null,
    /* The other half of "live": what is reporting a position right now, which
       is a fact about this minute rather than about the day. */
    fresh: num(k?.fresh),
    tracked: num(k?.tracked_vehicles),
  };
}

/* Why today's fares lag its bookings, in one sentence both shells can use.
   ─────────────────────────────────────────────────────────────────────────
   On production at 07:15 the band read "AED 964 in fares on 15 of 56 priced
   so far", which is true and, without this, unexplained. Uber carries no fare
   on its trip export at all: the price arrives on a separate PAYMENTS report
   asked for a whole week at a time, and that report has a generation cap of
   its own — so it is walked on the nightly catch-up and the Sunday backfill,
   never on the half-hourly incremental. Every other channel prices a booking
   on the trip row the same day.

   A low ratio here is therefore a schedule, not a hole, and the difference
   matters: one is worth investigating and the other is worth waiting for. */
export const FARES_LAG = 'Uber carries no fare on its trip export \u2014 the price arrives '
  + 'on a separate weekly report, walked overnight, so today\u2019s Uber bookings are priced '
  + 'by the morning rather than as they happen. Every other channel prices a booking as it lands.';

/* The one sentence both shells lead with, so they cannot word it differently. */
export const todayLede = (t) => (t.started
  ? `${t.bookings} booking${t.bookings === 1 ? '' : 's'} so far today, as of ${t.asOf} Dubai`
  : `Nothing collected yet today, as of ${t.asOf} Dubai`);
