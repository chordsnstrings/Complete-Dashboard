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

   ── both money figures, because they answer different questions ──────────
   /api/day carries two, and they differ by a lot — on 5 September, AED 6,110
   of fares against AED 24,118 accounted. This module used to show only the
   fares, on the argument that `accounted` is a frozen seventh of a week and so
   a projection. That argument does not survive measurement: polled minutes
   apart the same afternoon, the fares half stood still at AED 3,211 while the
   payout half moved 20,431.69 → 20,906.66. It moves because the collector is
   writing rows, which is a measurement catching up, not a statement being
   re-spread.

   So both are shown. They are not two answers to one question:

     FARES SO FAR is the price on the bookings taken since midnight — every
       channel that publishes a fare, whether or not that fare is the money the
       fleet keeps.
     MONEY IN is what the fleet is actually credited with — a fare where the
       channel publishes one, the platform's payout where it publishes a payout
       instead. Uber is the reason the two diverge: it pays a net payout and its
       gross fares are not counted into money in at all.

   Money in carries its two halves in the sub-line so a reader can see which
   part is a fare and which is a payout, and the day page is one click away for
   the full basis.

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
    /* Money in — the product's own name for this figure, the same one the
       Overview tile and the vehicle page print. `accounted` is fares where the
       channel publishes a fare and the platform's payout where it publishes a
       payout instead, which is why it is not the fares figure above and must
       not be captioned as though it were: on 5 September it read AED 24,118
       against AED 6,110 of fares, because Uber's money reaches us as a payout
       and its fares are not counted into it. The two halves ride with it so
       the tile can say which is which. */
    money: num(h.accounted),
    moneyFares: num(h.accounted_fares),
    /* reported_payouts: both shells render this as "N payouts" beside the
       fares, meaning what the platforms wired today. accounted_payouts is the
       payouts of the channels COUNTED on their payout, which after
       api/income_sql.js started preferring the statement net is a small
       remainder rather than the payout — the Today band would have shown the
       fleet a couple of hundred dirhams of payouts on a day it was wired six
       figures. */
    /* THE HALVES HAVE TO ADD UP TO THE TILE ABOVE THEM.
       ─────────────────────────────────────────────────────────────────────
       This read `reported_payouts ?? accounted_payouts`, and on 2026-09-08 at
       18:44 the phone drew "AED 6,711" over "2,649 fares · 17,010 payouts" —
       two numbers that sum to 19,659, name a figure the total deliberately
       EXCLUDES, and omit the 4,062 that is most of it. reported_payouts is
       what Uber wired; /api/kpis reports it back as `uncounted_payouts` on the
       same response, because the statement net already counts the same money
       and adding both would count the week twice.

       So the caption names the three things `accounted` is actually made of —
       statement net, fares, and the payouts of the channels counted ON their
       payout — and nothing else. What was wired but not counted is a real
       question and it gets its own sentence below the tiles rather than a
       slot inside the tile's arithmetic. */
    moneyStatements: num(h.accounted_statements),
    moneyPayouts: num(h.accounted_payouts),
    moneyWired: num(h.reported_payouts),
    moneyWiredPlatforms: h.uncounted_payout_platforms || h.reported_payout_platforms || [],
    /* ── what the day's bookings came to ──────────────────────────────────
       `fares` above is the price ON RECORD, and on this fleet that is not the
       same question as what the day was worth: Uber publishes no fare on its
       trip export, so at 20:07 Dubai on 2026-09-08 the record held AED 2,874
       over 664 bookings while 7 September, whose weekly report had been walked
       overnight, held AED 35,965 over 675. /api/day now values the bookings
       that carry no price yet at what a booking on the same channel was worth
       over the settled days behind them, and labels every part of it. */
    expected: num(h.expected_revenue),
    projected: num(h.projected_revenue),
    projectedBookings: num(h.projected_bookings),
    projectedPlatforms: h.projected_platforms || [],
    projectionParts: h.projection_parts || [],
    projectionBasis: h.projection_basis || null,
    /* Bookings we could not value at all — a channel with no settled day
       behind it. Named, never folded in at another channel's price. */
    unrated: num(h.unrated_bookings),
    unratedPlatforms: h.unrated_platforms || [],
    /* Whether the SERVER said there is no money yet, or we never got the field.
       num() collapses both to null and the tile then printed "no channel has
       been credited yet today" either way — which is a claim about the fleet's
       morning, and it was false on a phone whose cached copy of this file
       predated the `money` field: /api/day was answering accounted 2616.27 at
       the moment the tile said nobody had been credited. `accounted` is a key
       /api/day always sends, so its ABSENCE means the payload did not reach
       this code intact, and that is a different sentence. */
    moneyAnswered: h.accounted !== undefined,
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

/* An estimate printed to the dirham claims a precision it does not have, and a
   reader who sees AED 35,593 will reconcile against it. Rounded to the nearest
   hundred above ten thousand, the nearest ten below, so the figure reads as
   what it is. */
export const roughly = (v) => (v == null ? null
  : (Math.abs(v) >= 10000 ? Math.round(v / 100) * 100 : Math.round(v / 10) * 10));

/* TRIP VALUE — WHAT THE DAY'S BOOKINGS CAME TO.
   ─────────────────────────────────────────────────────────────────────────
   Shared rather than written twice, because the two shells wording this
   differently is how the same fleet ends up with two answers on two screens,
   and because the honesty of it lives entirely in the wording: the estimate
   and the measurement must never be able to swap labels.

   Three states, and the caption is different in each:

     MEASURED   every booking that will carry a price has one, so the figure
                is the fares on record and says what fraction of the day's
                bookings carry one.
     ESTIMATED  some of the day's bookings carry no price yet — on this fleet
                that is the Uber ones until the weekly report is walked
                overnight — so they are valued at what a booking on the same
                channel was worth over the settled days behind them. Marked
                with ≈, captioned "estimated", and rounded so it cannot be
                mistaken for a measurement.
     ABSENT     nothing priced and nothing to project it from. A reason, never
                a zero.

   The operator's own words for why this exists, 2026-09-08: "we should get the
   trip value overall which was 35k yesterday which gives us better indication
   than what is there at the moment." AED 2,874 was the true answer to a
   question nobody had asked. */
export const tripValue = (t, fmt, label = (x) => x) => {
  const est = t.expected != null;
  if (est) {
    const plats = [...new Set(t.projectedPlatforms || [])].map(label);
    return {
      estimated: true,
      amount: roughly(t.expected),
      sub: `estimated \u00b7 ${fmt(t.projectedBookings)} booking`
        + `${t.projectedBookings === 1 ? '' : 's'}`
        + `${plats.length ? ` on ${plats.join(', ')}` : ''} not priced yet`,
    };
  }
  if (t.fares != null) {
    return {
      estimated: false,
      amount: t.fares,
      sub: t.priced != null && t.bookings != null
        ? `on ${fmt(t.priced)} of ${fmt(t.bookings)} bookings priced`
        : 'the fares on record',
    };
  }
  return {
    estimated: false,
    amount: null,
    sub: t.bookings
      ? 'no booking carries a price yet, and no settled day to value them from'
      : 'nothing collected yet',
  };
};

/* The halves of Money in, and only the halves that are IN it. See the model
   above: naming what a platform wired beside a total that excludes it is the
   defect this replaces. */
export const moneyHalves = (t, fmt) => [
  t.moneyStatements ? `${fmt(t.moneyStatements)} statement` : null,
  t.moneyFares ? `${fmt(t.moneyFares)} fares` : null,
  t.moneyPayouts ? `${fmt(t.moneyPayouts)} payouts` : null,
].filter(Boolean).join(' \u00b7 ');

/* And the figure that was wired and deliberately not counted, said out loud
   rather than left for a reader to find on the day page. Six figures of Uber
   payout sitting invisibly beside a five-figure total is the kind of gap that
   gets a dashboard disbelieved. */
export const wiredNote = (t, fmt, label = (x) => x) => (t.moneyWired && t.moneyStatements
  ? `${(t.moneyWiredPlatforms || []).map(label).join(', ') || 'The platform'} also wired `
    + `AED ${fmt(t.moneyWired)} against the week this day falls in. It is not added above: `
    + 'the statement net already counts the same trips, and adding both would count the '
    + 'week twice.'
  : null);
