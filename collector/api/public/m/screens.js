/* The phone's screens.
   ─────────────────────────────────────────────────────────────────────────
   Five destinations and the drill-downs behind them. The set is not the
   desktop's fourteen views shrunk: it is what someone actually opens a phone
   for — is the fleet working, is the money arriving, who is out, where are the
   cars, and what needs doing — with everything else one tap away in More.

   Every screen is `async (deck, ctx)`. `ctx.alive()` is false once the reader
   has navigated away, and every await is followed by a check: on a slow
   connection a reader taps twice, and the second screen must not be painted
   over by the first one's response arriving late.
*/
import { state, q, qAll, api, href, windowLabel } from '../data.js';
import { el, esc, money, fmt, dayStr, card, lede, stats, rows, row, seg, search,
  skeleton, empty, failed, spark, bars, unwrap, cut, splitToday } from './ui.js';
/* The one place a channel key becomes a word a person reads — and the one
   place an instant becomes a clock. Both shared with the desktop rather than
   copied, so 'fms' is "FMS telematics" on both screens and 13:00Z is 17:00 on
   both: timeStr and dtStr pass timeZone: TZ, which is what makes the phone's
   collector-health times equal the ones on the desktop page beside them. */
import { sourceLabel, timeStr, dtStr, custodyText, moneyInTile, faresTile, standingNote, dialable,
  cashOnHandTile, bankDepositTile, countOf,
  alertRateFigure, splitAlerts, avgKmSub } from '../ui.js';
import { dubaiClock, dubaiDay } from '../tz.js';
import { todayLive, todayLede, FARES_LAG, tripValue, moneyHalves, wiredNote } from '../today.js';
/* The three words the desktop page uses for the three states it refuses to
   colour. Imported rather than retyped — see the comment on GREY there. */
import { GREY } from '../onlinetime.js';

export const TABS = [
  { id: 'today', route: 'today', label: 'Today', ic: '◱', owns: ['today', 'overview', 'demand'] },
  { id: 'money', route: 'money', label: 'Money', ic: '◈', owns: ['money', 'finance', 'receipts', 'platforms'] },
  /* 'online-time' is a People page and has a phone screen of its own — the
     one screen here whose rows dial rather than drill, because chasing a
     driver who has not come online is done from the phone in your hand. */
  { id: 'people', route: 'people', label: 'People', ic: '◧', owns: ['people', 'drivers', 'driver', 'online-time'] },
  { id: 'fleet', route: 'fleet', label: 'Fleet', ic: '▤', owns: ['fleet', 'vehicles', 'vehicle'] },
  { id: 'more', route: 'more', label: 'More', ic: '⋯',
    owns: ['more', 'live', 'map', 'safety', 'unauthorized', 'insights', 'compliance',
      'sources', 'settings', 'corporate', 'analyst', 'property', 'credentials',
      'optimise', 'trips', 'provenance', 'identity'] },
];

/* The header names the window the screen is ACTUALLY showing. It said
   "Last N days" unconditionally, which under a calendar period is a label for
   a window the screen is not using. */
const WINDOW_NOTE = () => windowLabel()
  + (state.platform ? ` · ${state.platform}` : '') + (state.fleet ? ` · ${state.fleet}` : '');

export function titleFor(view, param) {
  const t = {
    /* The screen leads with the day and then widens; the subtitle said
       THIS MONTH under a tab called Today, which named the second half of
       the screen and not the first. */
    today: ['Today', `now, then ${WINDOW_NOTE()}`],
    money: ['Money', WINDOW_NOTE()],
    people: ['People', WINDOW_NOTE()],
    'online-time': ['Online time', 'When each driver came online'],
    fleet: ['Fleet', WINDOW_NOTE()],
    more: ['More', 'Everything else'],
    trips: ['Every trip', WINDOW_NOTE()],
    live: ['Live fleet', 'Positions now'],
    safety: ['Safety', 'Harsh-driving events'],
    unauthorized: ['Unauthorized', 'Moved with no booking'],
    sources: ['Data sources', 'Collector health'],
    driver: [param || 'Driver', 'Everything on this person'],
    vehicle: [param || 'Vehicle', 'Everything on this car'],
    /* Named, even where the screen is the fallback: a header reading
       "insights" is the router's word for the page, not the product's. */
    corporate: ['Corporate', 'The hotel channel'],
    credentials: ['Credentials', 'Tested before they are stored'],
    analyst: ['Analyst', 'Claims the data was asked to settle'],
    optimise: ['Optimise', 'Where the next trip is'],
    insights: ['Action list', 'Built for a bigger screen'],
    /* The one finding page, which the action list links straight into and
       which had no entry here at all — so a phone opening a finding got a
       header reading "action", the router's word, over a screen that names
       people and asks somebody to ring them. */
    action: ['Finding', 'One flag, and who it is about'],
    receipts: ['What landed', 'Every figure a provider filed'],
    identity: ['One person, two records', 'Records the roster proves are one driver'],
    compliance: ['Compliance', 'Built for a bigger screen'],
    demand: ['Demand', 'Built for a bigger screen'],
    map: ['Map & replay', 'Built for a bigger screen'],
    settings: ['Settings', 'Built for a bigger screen'],
  }[view];
  return { title: t ? t[0] : (view || 'Fleet'), sub: t ? t[1] : 'Built for a bigger screen' };
}

/* A number the API sends as a string stays a string all the way to the screen
   unless something converts it — `round(sum(...)::numeric)` comes back as
   "100733", and "100733" + 0 is a bug waiting for a total. */
const n = (v) => (v == null || v === '' ? null : Number(v));
const D3M = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const countOfDays = (nDays) => `${fmt(nDays)} ${nDays === 1 ? 'day' : 'days'}`;

/* ── Today ──────────────────────────────────────────────────────────────── */
async function today(deck, ctx) {
  skeleton(deck, 4);
  const [k, daily, status, unauth, now] = await Promise.all([
    q('/api/kpis').catch(() => null),
    q('/api/trips/daily').catch(() => []),
    api('/api/status').catch(() => []),
    q('/api/unauthorized/summary').catch(() => null),
    /* The day in its own right — see api/public/today.js. The rest of this
       screen is the WINDOW, which excludes today on purpose because a part-day
       averaged into a daily rate reads as a collapse. Both are true and they
       are different questions, so the screen answers them one after the other
       instead of choosing. */
    todayLive().catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!k) { failed(deck, new Error('The overview could not be fetched.')); return; }

  /* ── today, first, on the tab called Today ───────────────────────────────
     This screen led with the month and mentioned the current day in a clause
     at the end of a paragraph. An operator opening a fleet dashboard at 06:45
     is asking what the fleet has done since midnight and how many cars are
     reporting, and neither was on the screen.

     Absent, never zero: before the first booking lands, the card is a sentence
     with the minute it is speaking at rather than four noughts. */
  if (now) {
    /* The tiles carry the counts; the caption carries the two things they
       cannot — the minute this is true at, and that it is the whole fleet
       whatever the chips above say. Leading it with the booking count as
       well printed 21 twice in one card. */
    const t = card('Today so far', now.started
      ? `as of ${now.asOf} Dubai \u00b7 both fleets, every channel`
      : todayLede(now));
    if (now.started) {
      stats(t.body, [
        { label: 'Bookings', value: fmt(now.bookings),
          sub: now.completed != null
            ? `${fmt(now.completed)} done \u00b7 ${fmt(now.cancelled ?? 0)} cancelled` : null,
          href: href('day', now.day) },
        /* TRIP VALUE LEADS, because it is the question the screen is opened
           with. At 20:07 Dubai on 2026-09-08 this tile was captioned "Fares so
           far" and read AED 2,874 on 47 of 664 priced, beside a 7 September
           that read AED 35,965 — and the operator's reply was that 2,874
           "can't be right". It was right, and it was the answer to "what have
           we been told a price for" rather than to "what did the fleet do".
           /api/day now values the bookings that carry no price yet; ../today.js
           holds the wording, including the ≈ and the word estimated, so the
           two shells cannot drift into describing it differently. */
        (() => {
          const tv = tripValue(now, fmt, sourceLabel);
          return { label: 'Trip value', href: href('day', now.day), sub: tv.sub,
            value: tv.amount == null ? '\u2014'
              : (tv.estimated ? `\u2248 ${money(tv.amount)}` : money(tv.amount)) };
        })(),
        /* The measured half kept beside it rather than replaced by it: an
           estimate with nothing to check it against is a number to be taken on
           faith, and this is the part of it that is on record. Dropped entirely
           on a settled day, where it would print the tile above it twice. */
        ...(now.expected != null ? [{ label: 'Priced so far',
          value: now.fares != null ? money(now.fares) : '\u2014',
          sub: now.priced ? `on ${fmt(now.priced)} of ${fmt(now.bookings)} bookings`
            : 'nothing priced yet',
          href: href('day', now.day) }] : []),
        /* Money in, which is NOT the fares above and must not read as a second
           opinion about them: a fare where the channel publishes one, the
           platform's payout where it publishes a payout instead. Uber is why
           they diverge — it pays a net payout and its gross fares are not
           counted into this at all, which on 5 September was AED 24,118 here
           against AED 6,110 of fares. The sub-line names the two halves so the
           reader can see which is which rather than wondering why one tile
           disagrees with the one beside it. */
        { label: 'Money in', value: now.money != null ? money(now.money) : '\u2014',
          sub: now.money == null
            ? (now.moneyAnswered
              ? 'no channel has been credited yet today'
              : 'this figure did not load — reload the page')
            /* fmt, not money: the currency is already on the value above, and
               repeating it twice more wrapped the sub onto a second line and
               made this tile taller than the one beside it. */
            : moneyHalves(now, fmt) || 'basis on the day page',
          href: href('day', now.day) },
        { label: 'Distance', value: now.km != null ? `${fmt(now.km)} km` : '\u2014',
          sub: now.drivers != null ? `${fmt(now.drivers)} out in ${fmt(now.vehicles)} cars` : null },
        { label: 'Reporting now', value: now.fresh != null ? fmt(now.fresh) : '\u2014',
          sub: now.tracked ? `of ${fmt(now.tracked)} tracked` : null,
          href: href('live') },
      ]);
      if (now.lastAt) {
        t.body.append(el('p', 'm-cap', `Latest booking ${timeStr(now.lastAt)}.`));
      }
      /* A fares count well under the booking count at breakfast is a schedule,
         not a hole, and the phone has no hover to explain it in. */
      if (now.priced != null && now.bookings != null && now.priced < now.bookings) {
        t.body.append(el('p', 'm-cap', FARES_LAG));
      }
      /* Bookings on a channel with no settled day behind it — valued at
         nothing rather than at somebody else's price, and said so. */
      if (now.unrated) {
        t.body.append(el('p', 'm-cap',
          `${fmt(now.unrated)} booking${now.unrated === 1 ? '' : 's'} on `
          + `${(now.unratedPlatforms || []).map(sourceLabel).join(', ') || 'an unmeasured channel'} `
          + 'are not in the estimate at all: there is no settled day behind them to value them from.'));
      }
      const wired = wiredNote(now, fmt, sourceLabel);
      if (wired) t.body.append(el('p', 'm-cap', wired));
    } else {
      /* Not a grid of noughts. The cars are still worth stating: a fleet with
         no trips yet at 06:00 still has vehicles reporting a position. */
      t.body.append(el('p', 'm-cap',
        'No booking has landed yet on any channel today.'
        + (now.tracked ? ` ${fmt(now.fresh ?? 0)} of ${fmt(now.tracked)} tracked vehicles are reporting a position.` : '')));
      rows(t.body, [{ title: 'Live fleet', sub: 'where every car is now', to: href('live') }]);
    }
    deck.append(t.card);
  }

  /* Today is still being collected, so it is neither averaged into the daily
     rate nor used as the "last full day" it was being compared as. On
     production that comparison read "down 81%" every morning — 103 bookings
     so far against yesterday's 543. */
  const { complete, today: partial } = splitToday(daily);
  const series = complete.map((d) => n(d.trips) || 0);
  const days = complete.length;
  /* NULL, NOT ZERO, when there is no complete day to average over.
     ─────────────────────────────────────────────────────────────────────────
     This read `days ? … : 0` and then printed that 0 unconditionally. On a
     TODAY-ONLY window there are no complete days by construction — today is
     excluded because it is still filling — so the screen led with "0 bookings
     a day" and, underneath it, "0 a day over the 0 days that are complete",
     directly above a tile reading 523. An operator sent a screenshot of a
     fleet that had done 523 jobs and been told it had done none.

     The desktop has answered this correctly since api/public/app.js:1072, in
     the same words: when today is the only day in the window it is not
     dropped, because then it is the entire question — the figure becomes what
     today has taken so far and says which minute it stopped at. The phone was
     ported without that rule. It has it now.

     A rate with no denominator is absent, never zero. It is the same house
     principle as alertRate in api/alert_coverage_sql.js, for the same reason:
     zero is a measurement, and a measurement is exactly what there isn't. */
  const perDay = days ? Math.round(series.reduce((a, b) => a + b, 0) / days) : null;
  const soFar = partial ? (n(partial.trips) || 0) : null;
  const last = series[series.length - 1] ?? 0;
  const prev = series[series.length - 2] ?? 0;
  const drift = prev ? Math.round(((last - prev) / prev) * 100) : 0;

  lede(deck, {
    claim: perDay != null
      ? `${fmt(perDay)} bookings a day`
      /* Today is the whole window, so today is the whole answer. */
      : soFar != null ? `${fmt(soFar)} bookings so far today`
        : `${fmt(k.trips)} bookings`,
    /* The TOTAL covers the whole window, today included; the RATE covers the
       complete days only. Pairing the two in one clause — "12,410 over 29
       days" — reads as a division that does not come out, so they are stated
       as the two different spans they are. */
    sub: `${fmt(k.trips)} across ${fmt(k.drivers)} drivers and ${fmt(k.vehicles)} vehicles. `
      + (perDay != null
        ? `${fmt(perDay)} a day over the ${countOfDays(days)} that are complete. `
          + (days >= 2
            ? `${dayStr(complete[days - 1].d)} ran ${drift >= 0 ? 'up' : 'down'} `
              + `${Math.abs(drift)}% on the day before it.`
            : '')
          /* The SAME number the card above it shows. This read the daily
             series, which is the stale-while-revalidate copy, while the card
             reads live — and on production the two printed 68 and 56 for the
             same day on the same screen. One today per screen. */
          + (partial || now?.started
            ? ` Today has ${fmt(now?.started ? now.bookings : soFar)} so far and is still being collected.`
            : '')
        /* No complete day, so no daily rate exists — and saying which minute
           the figure stopped at is what makes it usable instead of merely
           unexplained. */
        : `There is no whole day in this window yet, so there is no daily rate to give: `
          + `this is today, still being collected as of ${dubaiClock().hhmm} Dubai. `
          + 'Widen the range to compare it with days that finished.'),
    tone: perDay != null && drift < -25 ? 'warn' : null,
  });

  /* A chart of nothing, captioned "0 complete days", is a panel that looks
     broken. When there is nothing to draw, the caption is the whole answer and
     the empty axis is not drawn at all. */
  const trend = card('Bookings a day', days
    ? `${days} complete ${days === 1 ? 'day' : 'days'}`
      + (partial ? ', today excluded — it is still filling' : ' in this window')
    : 'nothing to chart yet — today is the only day in this window, and it is '
      + 'still being collected');
  if (days) {
    trend.body.append(spark(series, { h: 46 }));
    const foot = el('p', 'm-cap');
    foot.style.cssText = 'margin:8px 0 0;display:flex;justify-content:space-between';
    foot.append(el('span', null, dayStr((complete[0] || {}).d) || ''),
      el('span', null, dayStr((complete[days - 1] || {}).d) || ''));
    trend.body.append(foot);
  }
  deck.append(trend.card);

  stats(deck, [
    /* `${fmt(perDay)} a day` printed "0 a day" beside 523 bookings. The
       sub-line says what the figure IS when there is no rate to give. */
    { label: 'Bookings', value: fmt(k.trips),
      sub: perDay != null ? `${fmt(perDay)} a day` : 'today so far' },
    /* TRIP VALUE AND MONEY IN ARE DIFFERENT QUESTIONS AND BOTH BELONG HERE.
       ─────────────────────────────────────────────────────────────────────
       This card carried Money in alone, on a note reading "`revenue` is
       sum(trip.price) and the Uber export carries no fare column, so on this
       fleet it describes 875 of 12,410 bookings — the hotel channel and
       Yango". That was true when it was written and it has stopped being
       true: src/sources/uber.js:563 walks Uber's weekly PAYMENTS report and
       UPDATEs trip.price to the RIDER FARE, and measured on production
       2026-09-08 that covers 12,567 of August's 13,993 bookings (89.8%) and
       9,610 of July's 10,780 (89.1%). The tenth left over is very nearly the
       cancellations that took no fee — 2026-09-07 ran 89.9% priced against
       87.6% completed.

       So `revenue` is now the fleet's GROSS TRIP VALUE, what riders paid,
       and `accounted` is what the fleet is credited with once each platform
       has taken its commission and each channel has been counted exactly
       once. August 2026: AED 744,136 against AED 585,058. Neither is the
       other and an operator needs both — the first is how much work the
       fleet did, the second is how much of it is ours.

       The operator asked for the first by name on 2026-09-08, having been
       shown only the second: "we should get the trip value overall which was
       35k yesterday which gives us better indication than what is there at
       the moment." */
    { label: 'Trip value', value: n(k.revenue) != null ? money(n(k.revenue)) : '\u2014',
      sub: n(k.priced_trips)
        ? `on ${fmt(k.priced_trips)} of ${fmt(k.trips)} bookings priced`
        : 'no booking in this range carries a price',
      /* A window that includes today is understated here by construction and
         has to say so rather than read as a bad week. */
      tone: n(k.priced_pct) != null && n(k.priced_pct) < 60 ? 'warn' : null },
    { label: 'Money in', value: money(n(k.accounted) ?? n(k.revenue)),
      sub: n(k.accounted) ? 'each channel counted once, on its own report'
        : 'fares on record' },
    /* THE COUNT, with the rate under it — not the rate alone.
       ─────────────────────────────────────────────────────────────────────
       This tile read "88.7%" over "11.2% cancelled" and gave no number at
       all, so the screen showed 789 bookings and nothing that said how many
       of them were actual rides. The operator asked for exactly that: "it
       should show a breakdown of total trips, actual number of trips,
       cancelled trips, rider cancelled and driver cancelled." A percentage
       is a comparison; a count is the thing being compared, and the tile had
       only the comparison. */
    { label: 'Completed', value: fmt(k.completed_trips),
      sub: n(k.completion_pct) != null ? `${n(k.completion_pct)}% of ${fmt(k.bookable_trips)}`
        : 'no booking in this range carries an outcome',
      tone: n(k.completion_pct) >= 90 ? 'good' : n(k.completion_pct) >= 80 ? null : 'warn' },
    { label: 'Cancelled', value: fmt(k.cancelled_trips),
      sub: n(k.cancel_pct) != null ? `${n(k.cancel_pct)}% of ${fmt(k.bookable_trips)}`
        : 'no booking in this range carries an outcome',
      tone: n(k.cancel_pct) >= 20 ? 'warn' : null },
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: `${n(k.avg_km) ?? '—'} km a trip` },
  ]);

  /* WHO CALLED THE CANCELLATIONS OFF, as rows rather than four more tiles: a
     breakdown is a list of parts of one number and tiles read as separate
     figures. Rendered only when there is something to break down.

     FOUR lines, not the two that were asked for, because two do not add up.
     api/cancellation_sql.js carries the measurement: over 2026, 5,307 of the
     fleet's 7,032 driver-attributed cancellations are Bolt offers nobody
     picked up — broadcast to several drivers at once, so refusing one leaves
     nobody waiting, and Uber never files them at all. Folding those into
     "driver cancelled" would make the line three-quarters an artefact of which
     app a driver works. Yango's are the fourth: it files the bare word
     'cancelled' and never names an actor. */
  if (n(k.cancelled_trips)) {
    /* The separator is part of the string, not a space: without it the row read
       "changed their mind or did not show 67% of them", which runs one clause
       into the next and makes the reader parse where the sentence ended. */
    const pct = (v) => (k.cancelled_trips
      ? ` · ${Math.round((v / k.cancelled_trips) * 100)}% of them` : '');
    const unplaced = n(k.other_outcome) || 0;
    deck.append(el('p', 'm-sec', 'Who called it off'));
    rows(deck, [
      row({ title: 'The rider', sub: `changed their mind or did not show${pct(k.cancelled_by_rider)}`,
        value: fmt(k.cancelled_by_rider) }),
      row({ title: 'The driver', sub: `took the job, then ended it${pct(k.cancelled_by_driver)}`,
        value: fmt(k.cancelled_by_driver),
        tone: n(k.cancelled_by_driver) ? 'bad' : null }),
      n(k.declined_offers)
        ? row({ title: 'Offer not taken',
          /* SHORT, because the row's sub-line is one line on a phone and the
             longer form truncated mid-word at 420px — "and nobody was left w…"
             is worse than a shorter sentence that finishes. The clause that
             had to survive is the one that stops a reader adding this to the
             line above it. */
          sub: `Bolt only — nobody was left waiting${pct(k.declined_offers)}`,
          value: fmt(k.declined_offers) })
        : null,
      n(k.cancelled_unsaid)
        ? row({ title: 'Nobody said who',
          sub: `the channel does not report it${pct(k.cancelled_unsaid)}`,
          value: fmt(k.cancelled_unsaid) })
        : null,
    ]);
    /* The remainder is NOT a fifth bucket, and it was rendered as one — a peer
       row under a heading asking who called the cancellations off, which reads
       as part of the 1,007 when it is not a cancellation at all. It is a
       booking that is neither completed nor cancelled: a status this product
       has not mapped. Named rather than dropped, because it is the difference
       between a breakdown that adds up and one that nearly does, but named
       BELOW the list rather than inside it. */
    if (unplaced) {
      const cap = el('p', 'm-cap');
      cap.style.cssText = 'margin:8px 2px 0';
      cap.textContent = `${fmt(unplaced)} more booking${unplaced === 1 ? ' is' : 's are'} neither `
        + 'completed nor cancelled — a status this product has not mapped to an outcome.';
      deck.append(cap);
    }
  }

  /* What needs a person, not a chart. A source that stopped and a car that
     moved with nobody's name on it are the two things worth a phone buzzing. */
  const bad = (status || []).filter((r) => r.status && r.status !== 'ok');
  const unauthN = (unauth?.byVerdict || []).find((v) => v.verdict === 'unauthorized')?.n;
  const attention = [];
  if (bad.length) {
    attention.push(row({
      title: `${bad.length} source${bad.length > 1 ? 's need' : ' needs'} attention`,
      sub: [...new Set(bad.map((b) => b.source))].join(', '),
      value: '›', to: href('sources'),
    }));
  }
  if (n(unauthN)) {
    attention.push(row({
      title: `${fmt(unauthN)} unauthorized trips`,
      sub: 'seat occupied, vehicle moved, no booking',
      value: '›', to: href('unauthorized'), tone: 'critical',
    }));
  }
  if (n(k.alerts)) {
    attention.push(row({
      title: `${fmt(k.alerts)} harsh-driving events`,
      sub: 'from the telematics layer', value: '›', to: href('safety'),
    }));
  }
  if (attention.length) {
    deck.append(el('p', 'm-sec', 'Needs attention'));
    rows(deck, attention);
  }

  deck.append(el('p', 'm-sec', 'Go to'));
  rows(deck, [
    row({ title: 'Live fleet', sub: 'where every car is now', value: '›', to: href('live') }),
    row({ title: 'People', sub: 'who drove, and how much', value: '›', to: href('people') }),
    row({ title: 'Money', sub: 'revenue and payment mix', value: '›', to: href('money') }),
  ]);
}

/* ── Money ──────────────────────────────────────────────────────────────── */
async function moneyScreen(deck, ctx) {
  skeleton(deck, 4);
  const [k, daily, settle, plats] = await Promise.all([
    q('/api/kpis').catch(() => null),
    q('/api/trips/daily').catch(() => []),
    q('/api/settlement/mix').catch(() => null),
    q('/api/platforms').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!k) { failed(deck, new Error('The money view could not be fetched.')); return; }

  /* Today drops the last point to a fraction of a day's fares and the spark
     draws it as a cliff. Same separation as the Today screen. */
  const { complete: fullDays, today: partialDay } = splitToday(daily);
  const rev = fullDays.map((d) => n(d.revenue) || 0);
  const total = n(k.revenue) || 0;
  const priced = (daily || []).reduce((a, d) => a + (n(d.priced_trips) || 0), 0);

  /* Cash in a driver's hand and a fare charged to a room are money the fleet
     has EARNED and does not HOLD. That distinction is the reason this screen
     exists on a phone, so it is the headline rather than a tile. */
  const cls = settle?.classes || [];
  const owed = cls.filter((c) => ['cash', 'on_account', 'salary'].includes(c.settlement_class))
    .reduce((a, c) => a + (n(c.trips) || 0), 0);
  const routed = cls.reduce((a, c) => a + (n(c.trips) || 0), 0);

  /* TWO FIGURES, TWO QUESTIONS, AND ONE OF THEM HAD GONE STALE.
     ───────────────────────────────────────────────────────────────────────
     This said "`revenue` is the fares alone, which on this fleet is one
     channel in three and 7% of the bookings", and the lede below it told the
     reader that "Uber publishes no per-trip fare, so most of the work is in
     the second figure". Both were true when written. Uber's weekly PAYMENTS
     walk (src/sources/uber.js:563) now UPDATEs trip.price to the RIDER FARE,
     and measured on production 2026-09-08 that is 12,567 of August's 13,993
     bookings — 89.8%, not 7%. Telling an operator most of their work is
     missing from a figure that holds nine tenths of it is the kind of stale
     note that makes a correct number look broken.

     So `revenue` is TRIP VALUE — what riders paid — and `accounted` is money
     in, each channel counted once on the best report it files. August 2026:
     AED 744,136 against AED 585,058. */
  const inAll = n(k.accounted);
  lede(deck, {
    claim: owed && routed
      ? `${Math.round((owed / routed) * 100)}% of bookings are still to be collected`
      : `${money(inAll ?? total)} in`,
    sub: (owed && routed
      ? `${fmt(owed)} of ${fmt(routed)} bookings settled into a driver's hand, onto a room, or `
        + 'against salary. '
      : `Over ${fmt(k.trips)} bookings. `)
      /* TWO FIGURES, STATED SIDE BY SIDE, WITH NO ARITHMETIC BETWEEN THEM.
         A first draft of this said "${money(inAll)} of that is money in" and
         closed with "the gap is what the platforms keep". Both are false on a
         window that still holds unpriced bookings, which is every window that
         includes today: on 2026-09-08 money in was AED 7,170 against AED 2,874
         of trip value, so money in was the LARGER of the two and there was no
         gap to attribute. Each figure now states what it is and what it was
         measured over, and the sentence draws no relation it cannot prove. */
      + (inAll
        ? `Trip value is ${money(total)} — what riders paid, on the ${fmt(priced)} of `
          + `${fmt(k.trips)} bookings that carry a price. Money in is ${money(inAll)}, `
          + 'each channel counted once on the best report it files: '
          + [n(k.accounted_statements) ? `${money(n(k.accounted_statements))} on platform statements` : null,
            n(k.accounted_fares) ? `${money(n(k.accounted_fares))} in fares` : null,
            n(k.accounted_payouts) ? `${money(n(k.accounted_payouts))} in payouts` : null,
          ].filter(Boolean).join(', ')
          + '.'
        : `${money(total)} is what the priced bookings came to.`),
    tone: routed && owed / routed >= 0.3 ? 'warn' : null,
  });

  const c = card('Trip value a day', (priced
    ? `${fmt(priced)} of ${fmt(k.trips)} bookings carry a price` : 'no booking carries a price')
    + (partialDay ? ' · today excluded, it is still filling' : ''));
  c.body.append(spark(rev, { h: 46, tone: 'var(--s3)' }));
  deck.append(c.card);

  stats(deck, [
    { label: 'Trip value', value: money(total),
      sub: priced ? `what riders paid on ${fmt(priced)} of ${fmt(k.trips)} bookings`
        : 'no booking carries a price', long: true },
    { label: 'Money in', value: money(inAll ?? total),
      sub: inAll ? 'each channel counted once, on its own report' : 'fares only' },
    { label: 'Per priced booking',
      value: total && priced ? money(total / priced, 'AED', 0) : '\u2014',
      sub: priced ? `${fmt(priced)} priced` : 'none priced' },
    /* From the server, over the trips reporting BOTH a fare and a distance.
       This divided the priced fares by EVERY trip's distance — 65,367 over
       154,746 km — got 0.42, and then Math.round made it "AED 0". Two
       different populations and a rounding that destroys any rate below one. */
    { label: 'Per km', value: money(n(k.revenue_per_km), 'AED', 2),
      sub: n(k.priced_measured_trips)
        ? `over ${fmt(k.priced_measured_trips)} priced trips with a distance` : 'no priced distance' },
    /* Four, not five. The grid is two across, so an odd tile sits alone in a
       row of its own — and the one that was orphaned here was Bookings, which
       is the Today screen's headline and says nothing about money. */
  ]);

  if (cls.length) {
    const m = card('How fares settle', 'Every booking that records a settlement route');
    bars(m.body, cls.map((r) => ({ label: r.label || r.settlement_class, n: n(r.trips) })), { max: 6 });
    if (settle.unlabelled_trips) {
      const note = el('p', 'm-cap');
      note.style.cssText = 'margin:9px 0 0';
      note.textContent = `${fmt(settle.unlabelled_trips)} more record no route at all`
        + `${settle.unlabelled_platforms?.length ? ` (${settle.unlabelled_platforms.join(', ')})` : ''}`
        + ' — this card can say nothing about those.';
      m.body.append(note);
    }
    deck.append(m.card);
  }

  const pl = unwrap(plats).rows;
  if (pl.length) {
    deck.append(el('p', 'm-sec', 'By channel'));
    const byPlat = new Map();
    pl.forEach((p2) => {
      const cur = byPlat.get(p2.platform) || { trips: 0, fares: 0 };
      cur.trips += n(p2.window_bookings ?? p2.bookings ?? p2.trips) || 0;
      cur.fares += n(p2.fares) || 0;
      byPlat.set(p2.platform, cur);
    });
    const totalTrips = [...byPlat.values()].reduce((a, v) => a + v.trips, 0) || 1;
    rows(deck, [...byPlat.entries()].sort((a, b) => b[1].trips - a[1].trips).map(([name, v]) => row({
      title: name === 'fms' ? 'FMS telematics' : name[0].toUpperCase() + name.slice(1),
      sub: `${Math.round((v.trips / totalTrips) * 100)}% of bookings`,
      value: v.fares ? money(v.fares) : fmt(v.trips),
      note: v.fares ? 'fares' : 'bookings',
    })));
  }
}

/* ── People ─────────────────────────────────────────────────────────────── */
async function people(deck, ctx) {
  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  deck.append(bar);
  const list = el('div');
  deck.append(list);
  skeleton(list, 5);

  const board = unwrap(await q('/api/drivers/leaderboard').catch(() => []));
  if (!ctx.alive()) return;
  list.innerHTML = '';
  if (!board.rows.length) {
    empty(list, 'Nobody drove in this window', 'Widen the window from the \u22ee menu.');
    return;
  }

  /* No folding here. /api/drivers/leaderboard already answers per PERSON —
     `platforms` and `accounts` are how many channel identities that person
     holds — so folding again on this side would only be a second, worse copy
     of a rule the server already applies. */
  /* Money, not `revenue`.
     ───────────────────────────────────────────────────────────────────────
     `revenue` is sum(trip.price), and Uber's trip export carries no fare
     column at all — so this tab printed an em-dash for 72 of 100 people at a
     month and 81 of 100 at a year, then sorted every one of those dashes to
     zero. Everybody driving Uber filed below anybody with a single priced
     hotel booking; Nauman Hassan, 40,596 km, ranked on nothing.

     None of that was unmeasured. The same response now carries `money` —
     driver_day's resolution, the statement's net where a channel filed one and
     its fares where it did not — and it is present for all 72. `revenue`
     stays as the fallback so a row that somehow has only the trip-side figure
     still shows it, and a row with neither is a dash WITH a reason, which is
     the only honest dash on this column. */
  const moneyOf = (d) => (d.money != null ? n(d.money)
    : (d.revenue != null ? n(d.revenue) : null));
  const KEY = { trips: (d) => n(d.trips) || 0, km: (d) => n(d.km) || 0, money: moneyOf };
  /* Which record the figure came out of, said on the row rather than left for
     the reader to assume it is fares. money_period_days is the coarsest period
     behind the total — most of it is a weekly statement divided across its
     days — and a page that prints the money without it states a week's figure
     over a day. */
  const moneySub = (d) => {
    if (d.money == null) {
      return d.revenue != null ? 'fares on the bookings themselves'
        : 'no fare on any booking and no statement covers this window';
    }
    const src = { statement: 'from the platform statements',
      fares: 'from the fares on the bookings',
      mixed: 'statements and fares' }[d.money_source] || 'from the daily ledger';
    return src + (d.money_period_days > 1
      ? `, weekly figures split across days` : '');
  };
  let sort = 'trips', term = '';
  const draw = () => {
    list.innerHTML = '';
    const shown = board.rows
      .filter((d) => !term || String(d.driver_name || d.person || '')
        .toLowerCase().includes(term.toLowerCase()))
      /* Absences last in this descending sort, not first and not as zero — the
         same rule the desktop tables follow in ui.js. */
      .sort((a, b) => (KEY[sort](b) ?? -1) - (KEY[sort](a) ?? -1));
    if (!shown.length) { empty(list, 'Nobody matches that', 'Try part of a name.'); return; }
    rows(list, shown.map((d) => row({
      title: d.driver_name || d.person || d.driver_ext_id,
      name: d.driver_name || d.person || '?',
      photo: d.picture_url || null,
      sub: `${(d.platforms || []).join(', ') || 'no channel'} \u00b7 ${fmt(d.km)} km`
        + (d.accounts > 1 ? ` \u00b7 ${d.accounts} accounts` : '')
        + (sort === 'money' ? ` \u00b7 ${moneySub(d)}` : ''),
      value: sort === 'money'
        ? (moneyOf(d) == null ? '\u2014' : money(moneyOf(d)))
        : fmt(KEY[sort](d)),
      note: { trips: 'bookings', km: 'km', money: 'money in' }[sort],
      to: href('driver', d.driver_ext_id),
    })));
    if (!term) cut(list, board, 'people who drove');
  };
  search(bar, 'Search people', (v) => { term = v; draw(); });
  seg(bar, [{ id: 'trips', label: 'Bookings' }, { id: 'km', label: 'Distance' },
    { id: 'money', label: 'Money in' }], sort, (id) => { sort = id; draw(); });
  draw();
}

/* ── Fleet ──────────────────────────────────────────────────────────────── */
async function fleet(deck, ctx) {
  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  deck.append(bar);
  const list = el('div');
  deck.append(list);
  skeleton(list, 5);

  const [carsRaw, live] = await Promise.all([
    q('/api/vehicles').catch(() => []),
    api('/api/live').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  const cars = unwrap(carsRaw);
  list.innerHTML = '';
  if (!cars.rows.length) {
    empty(list, 'No vehicle worked in this window', 'Widen the window from the \u22ee menu.');
    return;
  }

  const pos = new Map((live || []).map((l) => [l.plate, l]));
  let sort = 'trips', term = '';
  const draw = () => {
    list.innerHTML = '';
    const key = (c) => (sort === 'trips' ? (c.trips ?? c.bookings) : c[sort]);
    const shown = cars.rows
      .filter((c) => !term || String(c.plate).toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => (n(key(b)) || 0) - (n(key(a)) || 0));
    if (!shown.length) { empty(list, 'No plate matches that', 'Try part of a plate.'); return; }
    rows(list, shown.map((c) => {
      const p = pos.get(c.plate);
      const where = p ? (p.stale ? 'stale fix'
        : (p.speed || 0) > 3 ? `moving ${Math.round(p.speed)} km/h` : 'stopped')
        : 'not reporting';
      return row({
        title: c.plate,
        sub: `${where}${c.current_driver ? ` \u00b7 ${c.current_driver}` : ''}`,
        value: sort === 'revenue' ? money(n(c.revenue)) : fmt(n(key(c))),
        note: { trips: 'bookings', km: 'km', revenue: 'fares' }[sort],
        to: href('vehicle', c.plate),
      });
    }));
    if (!term) cut(list, cars, 'vehicles');
  };
  search(bar, 'Search plates', (v) => { term = v; draw(); });
  seg(bar, [{ id: 'trips', label: 'Bookings' }, { id: 'km', label: 'Distance' },
    { id: 'revenue', label: 'Fares' }], sort, (id) => { sort = id; draw(); });
  draw();
}

/* ── Live ───────────────────────────────────────────────────────────────── */
async function live(deck, ctx) {
  skeleton(deck, 4);
  const feed = await api('/api/live').catch(() => null);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!feed) { failed(deck, new Error('The live feed could not be fetched.')); return; }
  if (!feed.length) { empty(deck, 'No vehicle is reporting', 'The telematics collector may be behind.'); return; }

  const moving = feed.filter((v) => (v.speed || 0) > 3).length;
  const busy = feed.filter((v) => v.seat_occupied).length;
  const stale = feed.filter((v) => v.stale).length;
  stats(deck, [
    { label: 'Reporting', value: fmt(feed.length) },
    { label: 'Moving', value: fmt(moving), sub: 'above 3 km/h' },
    { label: 'Occupied', value: fmt(busy), sub: 'seat sensor' },
    { label: 'Stale fix', value: fmt(stale), sub: 'no recent position', tone: stale ? 'warn' : 'good' },
  ]);

  deck.append(el('p', 'm-sec', 'Every vehicle'));
  rows(deck, [...feed]
    .sort((a, b) => (b.speed || 0) - (a.speed || 0))
    .map((v) => row({
      title: v.plate,
      sub: `${v.source || 'feed'} · ${v.seat_occupied ? 'occupied' : 'empty'}`
        /* The fix time in Dubai. Left on the reader's clock this printed
           L12615's 2026-09-02T13:00:01.603Z fix (production /api/live,
           measured) as 09:00 in New York and 14:00 in London, against 17:00
           in Dubai — beside a fleet whose every other hour comes from SQL
           already converted. */
        + (v.polled_at ? ` · ${timeStr(v.polled_at)}` : ''),
      value: v.stale ? 'stale' : (v.speed || 0) > 3 ? `${Math.round(v.speed)}` : 'stopped',
      note: v.stale ? '' : (v.speed || 0) > 3 ? 'km/h' : '',
      tone: v.stale ? 'warn' : null,
      to: href('vehicle', v.plate),
    })));
}

/* ── Safety and unauthorized ────────────────────────────────────────────── */
async function safety(deck, ctx) {
  skeleton(deck, 3);
  const [sum, byVehRaw] = await Promise.all([
    q('/api/alerts/summary').catch(() => []),
    q('/api/alerts/by-vehicle').catch(() => []),
  ]);
  const byVeh = unwrap(byVehRaw);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  const total = (sum || []).reduce((a, r) => a + (n(r.n) || 0), 0);
  if (!total) { empty(deck, 'No harsh-driving event in this window', 'Nothing to review.'); return; }
  lede(deck, { claim: `${fmt(total)} harsh-driving events`,
    sub: 'Recorded by the telematics layer. A count on its own says more about how far a car drove than how it was driven.' });
  const c = card('By kind', null);
  bars(c.body, (sum || []).map((r) => ({ label: r.alert_type, n: n(r.n) })), { max: 8 });
  deck.append(c.card);
  if (byVeh.rows.length) {
    deck.append(el('p', 'm-sec', 'By vehicle'));
    rows(deck, byVeh.rows.map((r) => row({
      title: r.plate,
      sub: [r.harsh_brake && `${r.harsh_brake} brake`, r.harsh_accel && `${r.harsh_accel} accel`,
        r.sharp_turn && `${r.sharp_turn} turn`].filter(Boolean).join(' \u00b7 ') || 'events recorded',
      value: fmt(n(r.alerts ?? r.n)), note: 'events', to: href('vehicle', r.plate),
    })));
    cut(deck, byVeh, 'vehicles with an event');
  }
}

async function unauthorized(deck, ctx) {
  skeleton(deck, 3);
  const [sum, listRaw] = await Promise.all([
    q('/api/unauthorized/summary').catch(() => null),
    q('/api/unauthorized/list').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!sum) { failed(deck, new Error('Unauthorized movement could not be fetched.')); return; }
  const v = Object.fromEntries((sum.byVerdict || []).map((r) => [r.verdict, r]));
  lede(deck, {
    claim: `${fmt(v.unauthorized?.n || 0)} trips with nobody's name on them`,
    sub: 'The seat was occupied and the vehicle moved, but no channel recorded a booking.',
    tone: (v.unauthorized?.n || 0) > 0 ? 'bad' : 'good',
  });
  stats(deck, ['unauthorized', 'partial', 'authorized', 'sensor_suspect'].map((key) => v[key] && ({
    label: key.replace('_', ' '),
    value: fmt(v[key].n),
    sub: `${fmt(v[key].km)} km`,
    tone: key === 'unauthorized' ? 'bad' : key === 'authorized' ? 'good' : null,
  })).filter(Boolean));
  /* The window asked for is not the window answered: this measurement needs a
     seat sensor AND a telematics journey, and only the days carrying both can
     be judged. Saying "21 trips in 30 days" over three days of evidence would
     be the most misleading sentence on the phone. */
  const cov = sum.coverage;
  if (cov && cov.complete === false) {
    const c2 = el('div', 'm-stale');
    c2.textContent = `Only ${cov.days_with_data} of the ${cov.days_in_window} days in this `
      + 'window carry both a seat sensor and a journey, so this is over those days.';
    deck.append(c2);
  }
  const items = unwrap(listRaw).rows;
  if (items.length) {
    deck.append(el('p', 'm-sec', 'Every one of them'));
    rows(deck, items.slice(0, 40).map((r) => row({
      title: r.plate || '—',
      /* custodyText, not r.driver_name — a field /api/segments has never
         returned, so every row said "no driver" including the ones naming two
         people. See its definition in ../ui.js for what the words mean. */
      sub: `${custodyText(r)}${r.started_at ? ` · ${dayStr(r.started_at)}` : ''}`,
      value: r.distance_km != null ? `${n(r.distance_km)}` : '',
      note: r.distance_km != null ? 'km' : '',
      to: href('vehicle', r.plate),
    })));
  }
}

/* ── Sources ────────────────────────────────────────────────────────────── */
async function sources(deck, ctx) {
  skeleton(deck, 3);
  const st = await api('/api/status').catch(() => null);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!st) { failed(deck, new Error('Collector status could not be fetched.')); return; }
  const latest = new Map();
  for (const r of st) {
    const k = `${r.source}|${r.fleet_id || ''}`;
    if (!latest.has(k) || (r.finished_at || '') > (latest.get(k).finished_at || '')) latest.set(k, r);
  }
  const all = [...latest.values()].sort((a, b) => String(a.source).localeCompare(String(b.source)));
  const bad = all.filter((r) => r.status !== 'ok');
  lede(deck, {
    claim: bad.length ? `${bad.length} of ${all.length} collectors need attention`
      : `All ${all.length} collectors are healthy`,
    sub: bad.length ? 'A source that stops does not empty the dashboard — it freezes it, which looks the same as a quiet week.'
      : 'Every source finished its last run without an error.',
    tone: bad.length ? 'warn' : 'good',
  });
  rows(deck, all.map((r) => row({
    title: r.source + (r.fleet_id ? ` · ${r.fleet_id}` : ''),
    sub: r.error ? String(r.error).slice(0, 70)
      /* The same field the desktop's Sources table renders through dtStr, so
         the two now agree: bolt/backfill finished_at 2026-09-02T12:40:13.916Z
         (production /api/status, measured) is 16:40, which is what the desktop
         showed while the phone said 08:40 in New York. */
      : `${r.mode || 'run'} · ${r.finished_at ? timeStr(r.finished_at) : 'never'}`,
    value: r.status === 'ok' ? 'ok' : r.status,
    note: `${fmt(r.rows_written)} rows`,
    tone: r.status === 'ok' ? 'good' : r.status === 'partial' ? 'warn' : 'critical',
  })));
}

/* ── Every trip ─────────────────────────────────────────────────────────── */
/* The record, on the device it gets asked about from.
   ─────────────────────────────────────────────────────────────────────────
   "What happened on that job" is a question asked standing next to the car,
   not at a desk. The desktop's nine-column table does not survive a 390px
   screen, so this is the same list as a stack of cards: who, which car, when,
   and the two ends of the journey — with the same search, because a plate and
   a name are the two things somebody has in their head at that moment.

   The channel is on every card for the same reason it is on every desktop
   row: a mixed list with the channel in a filter somewhere above reads as one
   channel's. */
const AREA = (a) => { const s = String(a || ''); return (s.split(' - ')[1] || s).trim(); };

async function tripsScreen(deck, ctx) {
  const host = el('div');
  let term = '', kind = 'bookings', offset = 0;

  search(deck, 'Plate, driver or place', (v) => { term = v; offset = 0; draw(); });
  seg(deck, [{ id: 'bookings', label: 'Bookings' }, { id: 'telematics', label: 'Journeys' },
    { id: 'all', label: 'Both' }], kind, (v) => { kind = v; offset = 0; draw(); });
  deck.append(host);

  async function draw() {
    skeleton(host, 4);
    let d;
    try {
      d = await q('/api/trips/list', { limit: 40, offset, q: term, kind: kind === 'bookings' ? '' : kind });
    } catch (e) { if (ctx.alive()) { host.innerHTML = ''; failed(host, e); } return; }
    if (!ctx.alive()) return;
    host.innerHTML = '';

    lede(host, {
      claim: `${fmt(d.total)} ${kind === 'telematics' ? 'telematics journeys' : 'bookings'}`
        + (term ? ` matching “${term}”` : ''),
      sub: kind === 'bookings'
        ? 'Newest first. The telematics journeys behind them are the same cars, counted again.'
        : kind === 'telematics' ? 'What the trackers saw. These are movement, not work.'
          : 'Bookings and tracker journeys together.',
    });
    if (!d.rows.length) {
      empty(host, term ? 'Nothing matches that' : 'No trip in this window',
        term ? 'Try a plate, part of a name, or a community.' : '');
      return;
    }
    /* Two columns, and what goes in each is decided by what a phone can fit.
       The left is who and where — the half that identifies the job and the
       half that is long. The right is when and on whose behalf, both short.
       Putting the route in the right column, beside a channel name, gave
       every card an ellipsis three words in. */
    rows(host, d.rows.map((r) => row({
      title: r.driver_name || r.driver_ext_id || 'Unnamed driver',
      sub: (r.has_fare ? `${money(r.price, r.currency || 'AED')} · ` : '')
        + `${r.plate || 'no vehicle'} · ${AREA(r.pickup_addr) || '—'} → ${AREA(r.dropoff_addr) || '—'}`,
      /* Was a local `clock` helper: ui.js's options object copied a fifth
         time with 'Asia/Dubai' written out by hand. It was CORRECT — the one
         phone clock that already said Dubai — but a literal is not reachable
         from the constant that decides it, and timeStr is the same formatter
         (2-digit, h23, timeZone: TZ) the other three now go through. */
      value: timeStr(r.requested_at),
      note: `${dayStr(r.requested_at)} · ${sourceLabel(r.platform)}`
        + (r.outcome === 'not_completed' ? ' · cancelled' : ''),
      tone: r.outcome === 'not_completed' ? 'critical' : null,
      to: r.plate ? href('vehicle', r.plate) : (r.driver_ext_id ? href('driver', r.driver_ext_id) : null),
    })));

    /* Rows, not page numbers: what a reader wants to know is how much of the
       window is behind them, not which page they are on. */
    const nav = el('div', 'm-seg');
    const mk = (label, on, go) => {
      const b = el('button', null, label);
      b.type = 'button'; b.disabled = !on;
      b.onclick = () => { offset = go; draw(); window.scrollTo({ top: 0 }); };
      nav.append(b);
    };
    mk('‹ Newer', offset > 0, Math.max(0, offset - 40));
    mk('Older ›', d.truncated, offset + 40);
    host.append(nav);
    host.append(el('p', 'm-cap',
      `${fmt(d.offset + 1)}–${fmt(d.offset + d.shown)} of ${fmt(d.total)}`
      + (kind !== 'telematics' && d.priced < d.shown
        ? ` · ${fmt(d.shown - d.priced)} of these carry no fare, because the channel publishes none`
        : '')));
  }
  await draw();
}

/* ── More ───────────────────────────────────────────────────────────────── */
async function more(deck) {
  deck.append(el('p', 'm-sec', 'Analyse'));
  rows(deck, [
    row({ title: 'Optimise', sub: 'where the next trip is', value: '›', to: href('optimise') }),
    row({ title: 'Corporate', sub: 'the hotel channel', value: '›', to: href('corporate') }),
    row({ title: 'Analyst', sub: 'claims the data was asked to settle', value: '›', to: href('analyst') }),
  ]);
  deck.append(el('p', 'm-sec', 'Operate'));
  rows(deck, [
    row({ title: 'Live fleet', sub: 'positions now', value: '›', to: href('live') }),
    row({ title: 'Safety', sub: 'harsh-driving events', value: '›', to: href('safety') }),
    row({ title: 'Every trip', sub: 'one card per booking, searchable', value: '›', to: href('trips') }),
    row({ title: 'Unauthorized trips', sub: 'moved with no booking', value: '›', to: href('unauthorized') }),
    row({ title: 'Data sources', sub: 'collector health', value: '›', to: href('sources') }),
    row({ title: 'Paste a credential', sub: 'read, tested, then stored', value: '›', to: href('credentials') }),
  ]);
  deck.append(el('p', 'm-sec', 'On the desktop'));
  rows(deck, ['provenance', 'insights', 'compliance', 'demand', 'map', 'settings'].map((v) => row({
    title: { provenance: 'Money sources', insights: 'Action list',
      compliance: 'Compliance', demand: 'Demand', map: 'Map & replay', settings: 'Settings' }[v],
    sub: 'built for a bigger screen', value: '›', to: href(v),
  })));

  const c = card('This app', null);
  const p = el('p', 'm-cap');
  p.style.margin = '0';
  p.innerHTML = 'Installed from the browser menu — <b>Add to Home Screen</b>. It keeps the last '
    + 'numbers it saw, so it opens with something to read even with no signal.';
  c.body.append(p);
  const b = el('button', 'm-chip');
  b.type = 'button'; b.textContent = 'Open the desktop version';
  b.style.marginTop = '10px';
  b.onclick = () => { location.href = `/?ui=desktop${location.hash}`; };
  c.body.append(b);
  deck.append(c.card);
}

/* ── driver ─────────────────────────────────────────────────────────────
   One person, everything about them, in the order a phone is read in: who
   they are, how they are doing against the fleet, then the detail. The
   standing block is the part a desktop table buries — a percentile answers
   "is 268 trips good?", which the number alone never does. */
async function driver(deck, ctx) {
  const id = ctx.param;
  skeleton(deck, 4);
  const [profile, kpis, daily, standing, quality] = await Promise.all([
    qAll('/api/driver/profile', { id }).catch(() => null),
    qAll('/api/driver/kpis', { id }).catch(() => null),
    qAll('/api/driver/daily', { id }).catch(() => []),
    qAll('/api/driver/standing', { id }).catch(() => null),
    /* The PER-PERSON endpoint, not the fleet leaderboard.
       ───────────────────────────────────────────────────────────────────
       This asked /api/alerts/by-driver with &id=, and that route reads no
       id at all: it ranks the WHOLE FLEET and stops at a hundred. So a page
       headed "Aamir Khan Amin - 0 bookings in this window" printed the top
       six rows of that leaderboard as his - 1,186 / 620 / 585 / 532 / 523 /
       519 events, measured on production 2026-09-04 - and at days=365 one
       man's page showed 40,270 events where his own record holds 3,548. One
       of those rows belonged to a near-namesake, so a reader would have gone
       and coached the wrong man.

       /api/driver/quality is id-scoped, is what the desktop has always used,
       and carries what a ranked list never could: the rate, the fleet
       baseline it should be read against, and the server's own sentence for
       why the rate is sometimes not measurable at all. */
    qAll('/api/driver/quality', { id }).catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!profile) { failed(deck, new Error('Nothing in the record matches this id.')); return; }

  const k = kpis || {};
  /* The compliance row is where a person's face, phone and email live — see
     sql/schema_v57.sql. The first row that carries a picture wins: a person
     with a hotel record and an Uber one has two, and only Uber's has a photo. */
  const cRows = profile.compliance || [];
  const c = cRows.find((x) => x && x.picture_url) || cRows[0] || {};
  ctx.setTitle(profile.name || id, `${fmt(k.trips)} bookings in this window`);
  lede(deck, {
    claim: profile.name || id,
    name: profile.name || id,
    photo: c.picture_url || null,
    sub: `${(profile.platforms || []).join(', ') || 'no channel'}`
      + `${profile.span?.days_worked ? ` \u00b7 ${countOfDays(profile.span.days_worked)} worked` : ''}`
      + `${(profile.ids || []).length > 1 ? ` \u00b7 ${profile.ids.length} platform accounts` : ''}`,
  });

  /* Reaching a driver is what a phone is FOR. On a desktop these sit in a row
     of identity facts; here they are the two things somebody standing in a
     yard actually wants, and they are tappable. */
  const reach = [c.phone && { label: 'Call', v: c.phone, to: `tel:${dialable(c.phone)}` },
    c.email && { label: 'Email', v: c.email, to: `mailto:${c.email}` }].filter(Boolean);
  if (reach.length) {
    const rc = card('Contact', c.platform ? `from the ${sourceLabel(c.platform)} record` : null);
    rows(rc.body, reach.map((x) => row({ title: x.v, sub: x.label, to: x.to })));
    deck.append(rc.card);
  }

  stats(deck, [
    { label: 'Bookings', value: fmt(k.trips), sub: k.days_worked ? `${countOfDays(k.days_worked)} worked` : null },
    /* NOT k.revenue. Uber's trip export carries no fare column, so `revenue` is
       null for most of this fleet however much they earned — and this tile
       printed a dash for a driver with 48 bookings, AED 22,925 paid out and
       AED 27,761 of statement fares sitting in the very response it had
       already fetched. The desktop had the chooser and the phone did not; it
       is in ui.js now and both call it. */
    moneyInTile(k),
    /* The same two cards as the desktop, from the same helpers, because the
       one thing this pair must never do is disagree about a person's money on
       two screens. */
    cashOnHandTile(k),
    bankDepositTile(k),
    faresTile(k),
    { label: 'Completed', value: k.completion_pct != null ? `${n(k.completion_pct)}%` : '\u2014',
      sub: k.not_completed != null ? `${fmt(k.not_completed)} did not` : null,
      tone: n(k.completion_pct) >= 90 ? 'good' : n(k.completion_pct) >= 80 ? null : 'warn' },
    /* avgKmSub, not "N km a booking". avg_km is kilometres per booking THAT
       REPORTS A DISTANCE and the tile beside it counts every booking — the
       helper in ui.js exists for exactly this and its own comment records that
       the phone was ported without it. Measured on production over every
       driver who worked 2026-09-06: 39 of 87 have a distance denominator
       smaller than their booking count, overstating by 26% at the median and
       by 197% at the worst (10 km over 3 bookings, 1 of them measured, printed
       as "9.9 km a booking"). The driver this came in about read "16.7 km a
       booking" for 100 km over 10 bookings, which is 10.0. */
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: avgKmSub(k), long: true },
  ]);

  /* TODAY IS NOT A DAY YET, and this chart drew it as one.
     ───────────────────────────────────────────────────────────────────────
     The two other charts on this phone already exclude the part-day and say
     so — the Today trend at :252 and Fares a day at :372, both through
     splitToday. This one plotted it beside seven finished days, so a driver
     eight hours into a shift showed a collapse at the right-hand edge.
     Measured for Shahab Ali Shaukat Hayat at 15:35 Dubai on 2026-09-08: seven
     whole days of 12, 11, 11, 12, 12, 9 and 14, then today's 9-so-far drawn as
     though the day were over.

     splitToday keys on `d` or `day` now; these rows carry `day`, so it
     returned "no today" here and the exclusion never fired. */
  const { complete: fullTripDays, today: partialTripDay } = splitToday(daily);
  const series = (fullTripDays || []).map((d) => n(d.trips) || 0);
  if (series.length > 1) {
    const c = card('Bookings a day',
      `${countOfDays(series.length)}`
      + (partialTripDay
        ? ` · today excluded, it is still filling — ${countOf(n(partialTripDay.trips) || 0, 'booking')} so far`
        : ' in this window'));
    c.body.append(spark(series, { h: 44 }));
    deck.append(c.card);
  }

  /* Against the fleet, not against nothing. */
  if (standing?.metrics?.length) {
    deck.append(el('p', 'm-sec', `Against the other ${fmt(standing.n_peers)} who drove`));
    rows(deck, standing.metrics.slice(0, 6).map((m) => row({
      title: m.label,
      sub: m.median != null ? `fleet median ${fmt(m.median)}` : null,
      value: fmt(m.value),
      /* "top 76%" is not a compliment and not an insult; it is a number
         facing the wrong way, so below the median it is said as a bottom. And
         the best in the fleet came out as "top 0%", which is not a share of
         anything — at the very top the honest phrasing names the rank.

         In ui.js now, with the desktop, because two of the sentences this
         block used to produce were false: "lowest in the fleet" in warn colour
         over a value equal to the median (a tie the percentile cannot express)
         and the same phrase over the fleet's WORST cancellation rate, which
         the server ranks inverted. See standingNote for both measurements. */
      ...(() => { const sn = standingNote(m); return { note: sn.text, tone: sn.tone }; })(),
    })));
  }

  /* How this person drives, and how that compares - not a count on its own.
     ───────────────────────────────────────────────────────────────────────
     A bare list of event types answers "how many", which is the question
     nobody has: 87 events is good over 40,000 km and alarming over 900. The
     rate and the fleet's own rate come back in the same response, so both are
     on the tile. Main Power Lost is the tracker complaining about its own
     wiring and is split out rather than counted as driving - the word list is
     the server's, in api/alert_coverage_sql.js, and splitAlerts reads the flag
     the rows already carry. */
  const qy = quality || {};
  const ev = splitAlerts(qy.alerts || []);
  const rate = alertRateFigure(qy);
  if (ev.total || rate.measured) {
    deck.append(el('p', 'm-sec', 'Harsh driving'));
    const base = qy.fleet_alerts_per_100km;
    const ratio = rate.measured && base > 0 ? rate.value / base : null;
    stats(deck, [
      /* Absent WITH THE REASON, never a zero. An untracked car supplies a full
         denominator from the trip table and an empty numerator, and the 0.0
         that used to print made exactly those people the fleet's safest. */
      rate.measured
        ? { label: 'Per 100 km', value: rate.text,
            sub: base != null
              ? `fleet ${fmt(base, 1)}${ratio ? ` - ${ratio >= 1 ? `${fmt(ratio, 1)}x it`
                : `${fmt(1 / ratio, 1)}x better`}` : ''}`
              : (rate.title || 'over the days the alert feed covered'),
            tone: ratio == null ? null
              : ratio <= 0.7 ? 'good' : ratio <= 1.3 ? null : 'warn' }
        : { label: 'Per 100 km', value: 'not measured', sub: rate.title, long: true },
      /* When the feed has not marked which rows are tracker faults, the count
         is every row and the tile says so rather than heading a total nobody
         has split with the word "driving". */
      { label: 'Events', value: fmt(ev.drivingN),
        sub: !ev.classified && ev.total
          ? 'not split from tracker faults - this channel does not mark them'
          : (qy.alert_km ? `over ${fmt(qy.alert_km)} km the feed covered`
            : 'no matched distance') },
      /* Named, not hidden. A car whose every alert is its own power loss has a
         wiring job waiting, and that is worth a line even though it is not
         this person's driving. */
      ev.deviceN
        ? { label: 'Tracker faults', value: fmt(ev.deviceN),
            sub: 'the box reporting its own power loss, not driving' }
        : null,
    ], true);
    if (ev.driving.length) {
      rows(deck, ev.driving.slice(0, 6).map((r) => row({
        title: r.alert_type || 'event',
        sub: r.latest ? `latest ${dayStr(r.latest)}` : null,
        value: fmt(n(r.n)), note: 'events',
      })));
    }
  }

  deck.append(el('p', 'm-sec', 'More'));
  rows(deck, [
    row({ title: 'Their bookings', sub: 'every trip, on the desktop', value: '\u203a',
      to: `#driver/${encodeURIComponent(id)}/trips` }),
    row({ title: 'Their vehicles', sub: 'custody, on the desktop', value: '\u203a',
      to: `#driver/${encodeURIComponent(id)}/activity` }),
  ]);
}

/* ── vehicle ────────────────────────────────────────────────────────────── */
async function vehicle(deck, ctx) {
  const plate = ctx.param;
  skeleton(deck, 4);
  const [profile, kpis, daily, drivers, safe] = await Promise.all([
    qAll('/api/vehicle/profile', { plate }).catch(() => null),
    qAll('/api/vehicle/kpis', { plate }).catch(() => null),
    qAll('/api/vehicle/daily', { plate }).catch(() => []),
    qAll('/api/vehicle/drivers', { plate }).catch(() => []),
    qAll('/api/vehicle/safety', { plate }).catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!profile) { failed(deck, new Error('No vehicle in the record carries this plate.')); return; }

  const k = kpis || {}, spec = profile.spec || {};
  ctx.setTitle(plate, [spec.make, spec.model].filter(Boolean).join(' ') || 'vehicle');
  lede(deck, {
    claim: plate,
    sub: [spec.year, spec.make, spec.model].filter(Boolean).join(' ')
      + (spec.colour ? ` \u00b7 ${spec.colour}` : '')
      + (spec.compliance_status ? ` \u00b7 ${spec.compliance_status.toLowerCase()}` : ''),
    tone: spec.compliance_status && spec.compliance_status !== 'ACTIVE' ? 'warn' : null,
  });

  stats(deck, [
    { label: 'Bookings', value: fmt(k.trips), sub: k.days_worked ? `${countOfDays(k.days_worked)} worked` : null },
    { label: 'Fares', value: money(n(k.revenue)), sub: k.avg_fare ? `${money(n(k.avg_fare))} a booking` : null },
    /* Same rule, same helper — /api/vehicle/kpis spells the denominator
       measured_trips rather than trips_with_distance and avgKmSub reads both. */
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: avgKmSub(k), long: true },
    { label: 'Drivers', value: fmt(k.attributed_drivers ?? unwrap(drivers).total),
      sub: 'held this car' },
  ]);

  /* TODAY IS NOT A DAY YET, and this chart drew it as one.
     ───────────────────────────────────────────────────────────────────────
     The two other charts on this phone already exclude the part-day and say
     so — the Today trend at :252 and Fares a day at :372, both through
     splitToday. This one plotted it beside seven finished days, so a driver
     eight hours into a shift showed a collapse at the right-hand edge.
     Measured for Shahab Ali Shaukat Hayat at 15:35 Dubai on 2026-09-08: seven
     whole days of 12, 11, 11, 12, 12, 9 and 14, then today's 9-so-far drawn as
     though the day were over.

     splitToday keys on `d` or `day` now; these rows carry `day`, so it
     returned "no today" here and the exclusion never fired. */
  const { complete: fullTripDays, today: partialTripDay } = splitToday(daily);
  const series = (fullTripDays || []).map((d) => n(d.trips) || 0);
  if (series.length > 1) {
    const c = card('Bookings a day',
      `${countOfDays(series.length)}`
      + (partialTripDay
        ? ` · today excluded, it is still filling — ${countOf(n(partialTripDay.trips) || 0, 'booking')} so far`
        : ' in this window'));
    c.body.append(spark(series, { h: 44 }));
    deck.append(c.card);
  }

  if (safe?.by_type?.length) {
    const c = card('Harsh-driving events', 'A count says more about how far this car drove than how it was driven.');
    bars(c.body, safe.by_type.map((r) => ({ label: r.alert_type, n: n(r.n) })), { max: 6 });
    deck.append(c.card);
  }

  const dr = unwrap(drivers).rows;
  if (dr.length) {
    deck.append(el('p', 'm-sec', 'Who drove it'));
    rows(deck, dr.slice(0, 10).map((r) => row({
      title: r.driver_name || r.driver_ext_id || '\u2014',
      sub: r.days ? `${fmt(r.days)} days` : null,
      value: fmt(n(r.trips)), note: 'bookings',
      to: r.driver_ext_id ? href('driver', r.driver_ext_id) : null,
    })));
  }

  deck.append(el('p', 'm-sec', 'More'));
  rows(deck, [
    row({ title: 'Where it went', sub: 'movement and replay, on the desktop', value: '\u203a',
      to: `#vehicle/${encodeURIComponent(plate)}/movement` }),
    row({ title: 'Its documents', sub: 'compliance, on the desktop', value: '\u203a',
      to: `#vehicle/${encodeURIComponent(plate)}/compliance` }),
  ]);
}

/* ── corporate ──────────────────────────────────────────────────────────── */
async function corporate(deck, ctx) {
  skeleton(deck, 4);
  const [sum, props] = await Promise.all([
    q('/api/corporate/summary').catch(() => null),
    q('/api/corporate/properties').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!sum || !sum.bookings) {
    empty(deck, 'No hotel booking in this window', 'Widen the window from the \u22ee menu.');
    return;
  }
  const margin = sum.has_cost && sum.revenue ? Math.round(((sum.revenue - sum.cost) / sum.revenue) * 100) : null;
  lede(deck, {
    claim: `${money(n(sum.revenue))} from ${fmt(sum.bookings)} hotel bookings`,
    sub: margin != null
      ? `${money(n(sum.cost))} of that is what the driver was paid, leaving ${margin}%.`
      : 'The channel reports a fare but no cost, so no margin can be taken from it.',
  });
  stats(deck, [
    { label: 'Average fare', value: money(n(sum.avg_fare)) },
    { label: 'Per km', value: sum.revenue_per_km ? money(n(sum.revenue_per_km)) : '\u2014' },
    { label: 'Unpaid approach', value: sum.deadhead_km != null ? `${fmt(sum.deadhead_km)} km` : '\u2014',
      sub: sum.deadhead_ratio_pct != null ? `${n(sum.deadhead_ratio_pct)}% of the driving` : null,
      tone: n(sum.deadhead_ratio_pct) > 20 ? 'warn' : null },
    { label: 'Free of charge', value: fmt(sum.foc_trips ?? sum.foc ?? 0), sub: 'billed to nobody' },
  ]);
  const rowsIn = unwrap(props);
  if (rowsIn.rows.length) {
    deck.append(el('p', 'm-sec', 'By property'));
    rows(deck, rowsIn.rows.map((r) => row({
      title: r.name || r.partner_id,
      sub: `${fmt(r.bookings)} bookings \u00b7 ${money(n(r.avg_fare))} average`,
      value: money(n(r.revenue)), note: 'fares',
      to: r.partner_id ? href('property', r.partner_id) : null,
    })));
    cut(deck, rowsIn, 'properties');
  }
}

/* ── analyst ────────────────────────────────────────────────────────────── */
async function analyst(deck, ctx) {
  skeleton(deck, 3);
  const d = await q('/api/analyst/findings').catch(() => null);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!d) { failed(deck, new Error('The analyst could not be reached.')); return; }
  if (!d.runs) {
    empty(deck, 'The analyst has not run yet', 'Nothing has been proposed or tested on this fleet.');
    return;
  }
  lede(deck, {
    claim: `${fmt(d.confirmed)} of ${fmt(d.confirmed + d.refuted + d.immaterial + d.unsupported)} claims held up`,
    sub: `Across ${fmt(d.runs)} passes. A claim the data refuses is as much of an answer as one it `
      + 'supports, so the refuted and the immaterial are kept rather than discarded.',
    tone: d.confirmed ? null : 'warn',
  });
  stats(deck, [
    { label: 'Confirmed', value: fmt(d.confirmed), tone: 'good' },
    { label: 'Refuted', value: fmt(d.refuted) },
    { label: 'Immaterial', value: fmt(d.immaterial) },
    { label: 'Unsupported', value: fmt(d.unsupported), tone: d.unsupported ? 'warn' : null },
  ]);
  const found = d.findings || [];
  if (found.length) {
    deck.append(el('p', 'm-sec', 'What it found'));
    found.slice(0, 12).forEach((f) => {
      const c = card(null, null);
      c.card.classList.add('m-finding');
      const b = el('b', null, esc(f.claim || ''));
      b.style.cssText = 'display:block;font-size:.92rem;line-height:1.35;margin-bottom:5px';
      const tag = el('span', 'm-chip');
      tag.textContent = f.verdict || '';
      tag.style.cssText = 'font-size:.66rem;padding:3px 9px;'
        + `color:var(--${f.verdict === 'confirmed' ? 'good' : f.verdict === 'refuted' ? 'critical' : 'ink-3'})`;
      c.body.append(b, tag);
      deck.append(c.card);
    });
  }
  if (d.last_run) {
    const p = el('p', 'm-cap');
    p.style.cssText = 'margin:4px 2px 0;text-align:center';
    /* dtStr, because this one crosses a DAY. last_run
       2026-09-01T23:10:13.470Z (production /api/analyst/findings, measured) is
       "Sep 2 03:10" in Dubai and "9/1/2026, 7:10:13 PM" on a New York phone —
       not a few hours out, the wrong date, telling a reader the analyst had not
       run today when it had. */
    p.textContent = `Last pass ${dtStr(d.last_run)}`
      + (d.model ? ` \u00b7 ${d.model}` : '');
    deck.append(p);
  }
}

/* ── paste a credential ─────────────────────────────────────────────────
   On a phone this is not a devtools workflow — it is the one where somebody
   sends you a token and you want it in before the collector's next tick,
   standing somewhere that is not a desk. Same endpoint as the desktop panel,
   same rule: nothing is stored until the provider has accepted it. */
async function credentials(deck, ctx) {
  const c = card('Paste a credential',
    'A cookie jar, a token, or a whole curl command. It is tried against the provider before anything is stored.');
  deck.append(c.card);

  const ta = el('textarea');
  ta.rows = 6;
  ta.placeholder = 'Paste here — several at once is fine, separated by a blank line. '
    + 'An Uber OAuth application goes in as its two lines, id and secret, in either order.';
  ta.style.cssText = 'width:100%;background:var(--surface-2);border:1px solid var(--rule);'
    + "border-radius:11px;padding:11px 12px;font-family:'IBM Plex Mono',monospace;font-size:.76rem;"
    + 'line-height:1.5;resize:vertical;color:var(--ink);-webkit-appearance:none';
  c.body.append(ta);

  const btn = el('button', 'm-chip');
  btn.type = 'button';
  btn.textContent = 'Read and test';
  btn.style.cssText = 'margin-top:10px;min-height:40px;padding:9px 16px';
  c.body.append(btn);

  const out = el('div');
  deck.append(out);

  const post = async (apply) => {
    const text = ta.value.trim();
    if (text.length < 20) return;
    btn.disabled = true;
    btn.textContent = apply ? 'Applying…' : 'Asking each provider…';
    out.innerHTML = '';
    let d;
    try {
      d = await api('/api/settings/paste', {
        method: 'POST',
        /* The token the desktop sends. The write gate is held open while
           ADMIN_TOKEN is unset, so this changed nothing today — and the day it
           is set, the phone was the one surface that would start refusing
           every paste, with no manual credential grid to fall back to. */
        headers: { 'content-type': 'application/json',
          ...(state.admin ? { 'x-admin-token': state.admin } : {}) },
        body: JSON.stringify({ text, apply }),
      });
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Read and test';
      failed(out, e);
      return;
    }
    if (!ctx.alive()) return;
    btn.disabled = false; btn.textContent = 'Read and test';
    out.innerHTML = '';
    if (!d.proposals.length) {
      empty(out, 'Nothing recognised', 'No part of that looked like a credential this dashboard stores.');
      return;
    }
    rows(out, d.proposals.map((r) => row({
      /* Three keys where an OAuth application resolved to three. Showing the
         first alone would hide the two that make it work. */
      title: r.keys?.length ? r.keys.join(', ') : (r.key || 'could not be named'),
      sub: `${r.provider}${r.fleet ? ` \u00b7 ${r.fleet}` : ''} \u00b7 ${r.detail || r.why || ''}`,
      value: r.verdict === 'pass' ? 'accepted' : r.verdict === 'unknown' ? 'no answer' : 'refused',
      tone: r.verdict === 'pass' ? 'good' : r.verdict === 'unknown' ? 'warn' : 'critical',
    })));
    const good = d.proposals.filter((r) => r.verdict === 'pass');
    if (d.applied?.length) {
      out.append(el('div', 'm-stale', `Stored ${d.applied.join(', ')} — live on the collector's next tick.`));
    } else if (good.length) {
      const go = el('button', 'm-chip');
      go.type = 'button';
      go.textContent = `Apply the ${good.length} that were accepted`;
      go.style.cssText = 'margin-top:12px;min-height:40px;padding:9px 16px';
      go.onclick = () => post(true);
      const wrap = el('div');
      wrap.style.cssText = 'display:flex;justify-content:center';
      wrap.append(go);
      out.append(wrap);
    }
  };
  btn.onclick = () => post(false);
}

/* ── Online time ─────────────────────────────────────────────────────────
   The one screen on this app that exists to make somebody pick up a phone.

   It was going to be the fallback — "built for a bigger screen, open the
   desktop version" — and that was the wrong call for this page specifically.
   Every other wide table here is something a reader LOOKS at; this one ends in
   an action, and the action is a phone call to a driver who has not come
   online. The person doing the chasing is holding the phone they would make
   the call on. Sending them to a desktop build to read a number they then type
   by hand is the opposite of what the page is for.

   So the row IS the call. `to` is a tel: link rather than a drill-down, which
   is the only screen here where that is true, and the caption says so — a
   chevron that dials is a surprise unless the page tells you first.

   The three grey states from api/online_routes.js survive the shrink intact.
   A phone has less room to explain, which is exactly why the temptation is to
   drop the reasons and show two colours; a two-colour version of this screen
   would put "LATE" beside a driver Uber was never asked about and send a
   caller to accuse somebody of something that was never measured. The chip
   carries the state's own short word and the sub carries the full sentence. */
async function onlineTime(deck, ctx) {
  /* The same localStorage key the desktop page writes. One reader, one
     standard for when the fleet starts — a phone that kept its own copy would
     colour the same morning two different ways depending which screen it was
     read on. */
  const KEY = 'online-time:start';
  const readStart = () => {
    try { return localStorage.getItem(KEY) || '06:00'; } catch { return '06:00'; }
  };
  let start = readStart();
  let day = dubaiDay();
  let only = 'late';

  const head = el('div');
  head.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  deck.append(head);
  const body = el('div');
  deck.append(body);

  const ctrl = el('div');
  ctrl.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap';
  const dayIn = el('input'); dayIn.type = 'date'; dayIn.value = day; dayIn.className = 'm-inp';
  const startIn = el('input'); startIn.type = 'time'; startIn.value = start; startIn.className = 'm-inp';
  const lab = (t, node) => {
    const w = el('label');
    w.style.cssText = 'display:flex;gap:6px;align-items:center;flex:1;min-width:0';
    w.append(el('span', 'm-cap', esc(t)), node);
    return w;
  };
  ctrl.append(lab('Day', dayIn), lab('Start', startIn));
  head.append(ctrl);

  const FILTERS = [
    { id: 'late', label: 'To chase' },
    { id: 'grey', label: 'Cannot judge' },
    { id: 'all', label: 'Everyone' },
  ];
  seg(head, FILTERS, only, (id) => { only = id; paint(); });

  let d = null;
  let gen = 0;

  const paint = () => {
    if (!d) return;
    body.innerHTML = '';
    const t = d.totals;
    /* Same rule as the desktop tiles: with no readable start time there is no
       verdict, and "Nobody is late" is a claim rather than an absence. The
       phone is the shell where that matters most — this lede is often the only
       line read. */
    const judged = d.expected_start != null;
    lede(body, {
      claim: !judged ? 'Nobody can be judged yet'
        : (t.late
          ? `${t.late} ${t.late === 1 ? 'driver has' : 'drivers have'} not started on time`
          : 'Nobody is late'),
      /* The grey count rides in the lede and not only in the list, because a
         reader who filters to "To chase" and sees three rows must not conclude
         that three is the whole problem when four more were never measured. */
      sub: !judged
        ? (d.start_why || 'No start time is set.')
        : `Against ${d.expected_start}. ${fmt(t.on_time || 0)} on time`
          + (t.unjudged ? ` · ${fmt(t.unjudged)} cannot be judged` : '')
          + ` · ${fmt(t.people || 0)} people`,
      tone: !judged ? null : (t.late ? 'bad' : 'good'),
    });

    /* Worst first. The endpoint returns the roster in its own order and the
       desktop table re-sorts on the client; the phone has no column headers to
       sort by, so the order it is given IS the order, and the order a call
       list wants is the person who is furthest behind. Absences sort last
       rather than as zero — the same rule every table in ui.js follows. */
    const worstFirst = (a, b) => (b.minutes_late ?? -Infinity) - (a.minutes_late ?? -Infinity);
    const late = d.rows.filter((r) => r.late === true).sort(worstFirst);
    const grey = d.rows.filter((r) => r.late == null);
    const shown = only === 'late' ? late
      : (only === 'grey' ? grey : [...late, ...d.rows.filter((r) => r.late === false).sort(worstFirst), ...grey]);
    if (!shown.length) {
      /* An empty call list has TWO causes and they are opposite: everybody
         beat the start time, or there is no start time to beat. This read
         "Everyone measured on 2026-09-09 was online by null" — a claim that
         nobody was late, on a day nothing had been judged, with the missing
         time printed as the word null. */
      empty(body, only === 'late' ? (judged ? 'Nobody to chase' : 'Nothing to chase yet')
        : 'Nothing here',
        only !== 'late' ? 'No driver is in this state on this day.'
          : (judged ? `Everyone measured on ${d.day} was online by ${d.expected_start}.`
            /* The lede two inches above already carries start_why in full.
               Repeating it here is the same sentence twice on a 402px screen. */
            : 'Set a start time above, as HH:MM, to see who is behind it.'));
      return;
    }

    const { card: c, body: cb } = card(
      only === 'late' ? 'Call these people' : (only === 'grey' ? 'Not measured' : 'Everyone'),
      'Tap a row to call. A grey time is a reason, not a verdict.');
    body.append(c);
    rows(cb, shown.map((r) => {
      const grey = r.late == null;
      const where = r.where?.area || null;
      const car = r.plate ? `${r.plate}${r.plate_basis && /\?|unknown/i.test(r.plate_basis) ? ' ?' : ''}` : null;
      return row({
        title: r.name || r.driver_ext_id || '?',
        name: r.name || '?',
        photo: r.picture_url || null,
        /* Car, place and first trip — the three things the caller is asked
           next. The reason sentence comes last and only when there is one,
           so a normal row stays one line. */
        sub: [car, where, r.first_trip_local ? `first trip ${r.first_trip_local}` : null]
          .filter(Boolean).join(' · ') || 'nothing else known about this day',
        value: grey ? (GREY[r.online_basis] || 'no event') : r.online_local,
        tone: grey ? null : (r.late ? 'bad' : 'good'),
        note: grey ? null
          : (r.minutes_late > 0 ? `+${fmt(r.minutes_late)}m` : 'on time'),
        to: r.phone ? `tel:${dialable(r.phone)}` : null,
      });
    }));
    /* ONE LINE PER DISTINCT STATE, not one line for the list.
       ─────────────────────────────────────────────────────────────────────
       This printed the FIRST grey row's `online_why` under the whole list,
       which on the "Cannot judge" filter meant three drivers in three
       different states — never asked, not in yet, already on — sat above a
       single sentence explaining only the first of them. A reader takes a
       sentence under a list as being about the list. That is the house rule's
       exact failure: not an absent reason but a reason that is not the true
       one, which is worse, because it is believed.

       The word each row carries is the key, so the line and the chip cannot
       drift apart. */
    const reasons = new Map();
    for (const r of shown) {
      if (r.late == null && r.online_why && !reasons.has(r.online_basis)) {
        reasons.set(r.online_basis, r.online_why);
      }
    }
    for (const [basis, why] of reasons) {
      cb.append(el('p', 'm-cap', `${GREY[basis] || basis} — ${why}`));
    }
    /* Somebody with no number cannot be chased from here at all, and that is
       a roster gap the operations team can close — so it is stated, not left
       as a row that quietly does nothing when tapped. */
    const noPhone = shown.filter((r) => !r.phone).length;
    if (noPhone) {
      cb.append(el('p', 'm-cap',
        `${noPhone} of these ${shown.length} ${noPhone === 1 ? 'has' : 'have'} no phone number `
        + 'on file and cannot be called from here.'));
    }
  };

  const load = async () => {
    const mine = ++gen;
    body.innerHTML = '';
    skeleton(body, 5);
    try {
      /* q(path, extra) builds `path?<params>` — the query string is ITS job.
         Passing a path that already carried one produced
         `/api/online-time?day=..&start=..?from=..`, so `start` arrived with a
         `?from=` glued to it, failed the HH:MM validation, and the page
         rendered "Against null" and judged nobody. It looked like an empty
         day rather than a broken call, which is the dangerous kind of wrong
         on a page whose job is to produce a call list. */
      d = await q('/api/online-time', { day, start });
    } catch (e) {
      if (mine !== gen || !ctx.alive()) return;
      body.innerHTML = '';
      return failed(body, e);
    }
    if (mine !== gen || !ctx.alive()) return;
    paint();
  };

  dayIn.onchange = () => { day = dayIn.value || dubaiDay(); load(); };
  startIn.onchange = () => {
    start = startIn.value || '06:00';
    try { localStorage.setItem(KEY, start); } catch { /* private window */ }
    load();
  };
  await load();
}

/* ── the fallback ───────────────────────────────────────────────────────
   A route this app has no screen for still has to resolve: an address someone
   sent to a phone must not dead-end. A driver or vehicle SUB-page renders the
   real desktop module, which exports its renderer and is styled by app.css;
   the rest are pages built around a wide table, and the honest answer for
   those is the desktop build, one tap away and returning to this address. */
/* ── Optimise ───────────────────────────────────────────────── */
/* The desktop leads with a 168-cell heatmap. A phone cannot read one, and the
   person holding the phone is usually deciding one thing: where to be in the
   next hour. So the same two measurements arrive as two ranked lists — the
   hours worth being out for, and the place-hours where cars sit — with the
   week's own numbers, not a shrunken grid. */
async function optimise(deck, ctx) {
  skeleton(deck, 4);
  const [opt, bal] = await Promise.all([
    q('/api/optimise').catch((e) => ({ error: e.message })),
    q('/api/supply/balance').catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (opt?.error) { failed(deck, new Error(opt.error)); return; }

  /* A balance cell is PER OCCURRENCE of its weekday, not the window's total —
     see the desktop page for why. Rates and rankings use the cell; every
     absolute hour count comes from the route's totals. */
  const cells = (bal?.cells || []).filter((c) => n(c.online_h) > 5);
  const occ = (c) => n(c.occurrences) || 1;
  const T = bal?.totals || null;
  const onlineH = T ? n(T.online_h) : cells.reduce((a, c) => a + (n(c.online_h) || 0) * occ(c), 0);
  const jobH = T ? n(T.on_job_h) : cells.reduce((a, c) => a + (n(c.on_job_h) || 0) * occ(c), 0);
  const idlePct = T && T.idle_pct != null ? Math.round(n(T.idle_pct))
    : (onlineH ? Math.round(((onlineH - jobH) / onlineH) * 100) : null);
  const rated = [...cells].sort((a, b) => n(b.jobs_per_online_h) - n(a.jobs_per_online_h));
  const sorted = rated.map((c) => n(c.jobs_per_online_h)).sort((a, b) => a - b);
  const med = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;
  const upside = med == null ? 0
    : cells.filter((c) => n(c.jobs_per_online_h) < med)
      .reduce((a, c) => a + (med - n(c.jobs_per_online_h)) * n(c.online_h) * occ(c), 0);

  lede(deck, {
    claim: idlePct != null ? `${idlePct}% of paid hours are idle`
      : 'Availability is not being collected yet',
    sub: idlePct != null
      ? `${fmt(Math.round(jobH))} of ${fmt(Math.round(onlineH))} online hours went on a job. `
        + `Median ${opt.median_wait_overall ?? '\u2014'} min between one job and the next.`
      : 'Idle time cannot be separated from time off until the availability collector writes.',
    tone: idlePct >= 70 ? 'warn' : null,
  });

  stats(deck, [
    { label: 'Idle hours', value: `${fmt(opt.idle_h_between_jobs)} h`,
      sub: `over ${fmt(opt.handovers)} handovers`, tone: 'warn' },
    { label: 'Median wait',
      value: opt.median_wait_overall != null ? `${opt.median_wait_overall} min` : '\u2014',
      sub: 'drop-off to next pick-up' },
    { label: 'Extra trips', value: upside ? `+${fmt(Math.round(upside))}` : '\u2014',
      sub: 'a month, at the fleet median', tone: upside ? 'good' : null },
  ], true);

  const body = el('div');
  const bar = el('div');
  deck.append(bar, body);

  const hours = () => {
    body.innerHTML = '';
    if (!rated.length) {
      empty(body, 'No hour carries enough online time to rank',
        'Availability has to be collected before an hour can be judged.');
      return;
    }
    const c = card('Worth being out for',
      'Jobs won per hour online — a rate, so a thin Tuesday with two drivers can out-rank '
      + 'a busy Friday with twenty.');
    body.append(c.card);
    rows(c.body, rated.slice(0, 12).map((r) => ({
      title: `${D3M[r.dow]} ${String(r.h).padStart(2, '0')}:00`,
      sub: `${fmt(Math.round(n(r.online_h)))} online h · ${fmt(n(r.jobs))} `
        + `${n(r.jobs) === 1 ? 'job' : 'jobs'}`,
      value: n(r.jobs_per_online_h).toFixed(2),
      note: 'per online h',
      tone: med != null && n(r.jobs_per_online_h) >= med ? 'good' : null,
    })));
    if (med != null) {
      c.body.append(el('p', 'm-cap',
        `Fleet median ${med.toFixed(2)}. Every hour above it is the fleet proving to itself `
        + 'what the hours below it could do.'));
    }
    const worst = [...rated].reverse().slice(0, 6);
    const w = card('Hours that do not pay for themselves',
      'Same rate, the other end. These are the hours to move drivers OFF, not to staff harder.');
    body.append(w.card);
    rows(w.body, worst.map((r) => ({
      title: `${D3M[r.dow]} ${String(r.h).padStart(2, '0')}:00`,
      sub: `${fmt(Math.round(n(r.online_h)))} online h · ${fmt(n(r.jobs))} `
        + `${n(r.jobs) === 1 ? 'job' : 'jobs'}`,
      value: n(r.jobs_per_online_h).toFixed(2),
      note: 'per online h',
      tone: 'bad',
    })));
  };

  const places = () => {
    body.innerHTML = '';
    const waits = opt.waits || [];
    if (!waits.length) {
      empty(body, 'No vehicle completed two bookings here',
        'A wait needs a drop-off and the same plate picking up again.');
      return;
    }
    const top = waits.slice(0, 15);
    const c = card('Where the cars are standing',
      'Each vehicle followed from one drop-off to its next pick-up. This counts a CAR, not an '
      + 'address, so two providers writing one place two ways cannot distort it.');
    body.append(c.card);
    rows(c.body, top.map((r) => ({
      title: (r.area || 'Unnamed area')
        + (r.charging_site
          ? (r.charging_site === r.area ? ' \u00b7 charger' : ` \u00b7 charger at ${r.charging_site}`)
          : ''),
      sub: `${D3M[r.dow]} ${String(r.h).padStart(2, '0')}:00 · ${fmt(n(r.handovers))} `
        + `${n(r.handovers) === 1 ? 'handover' : 'handovers'}`,
      value: `${fmt(Math.round(n(r.idle_h)))} h`,
      note: `${fmt(n(r.median_wait_min))} min median`,
      tone: 'warn',
    })));
    const idle = top.reduce((a, r) => a + (n(r.idle_h) || 0), 0);
    c.body.append(el('p', 'm-cap',
      `These ${top.length} place-hours hold ${fmt(Math.round(idle))} of the fleet's `
      + `${fmt(opt.idle_h_between_jobs)} idle hours — `
      + `${Math.round((idle / Math.max(1, n(opt.idle_h_between_jobs))) * 100)}% of all the waiting, `
      + `in ${top.length} cells of a 168-cell week`
      + (opt.totals?.waits > top.length
        ? `, out of ${fmt(opt.totals.waits)} that had a measurable wait.` : '.')));
    if ((opt.charging_sites || []).length) {
      c.body.append(el('p', 'm-cap',
        `${opt.charging_sites.join(' and ')} hold charging stations. `
        + `${opt.idle_h_at_charging_sites != null ? `${fmt(opt.idle_h_at_charging_sites)} idle hours ` : 'Some idle time '}`
        + `${opt.idle_h_charging_pct != null ? `(${opt.idle_h_charging_pct}%) ` : ''}`
        + 'sit in an area with one, so that time mixes waiting with refuelling. '
        + 'It matches the address, not a plug — treat it as an upper bound.'
        + ((opt.charging_aliases || []).length
          ? ` ${opt.charging_aliases.map((a) => `${a.site} is written `
            + `${a.written.map((x) => `\u201c${x}\u201d`).join(' and ')}`).join('; ')}.`
          : '')));
    }
    if (opt.empty_arrival_pct != null) {
      c.body.append(el('p', 'm-cap',
        `Separately, ${opt.empty_arrival_pct}% of placeable bookings began in an area where no car `
        + 'had finished a trip in the hour before.'));
    }
  };

  let tab = 'hours';
  seg(bar, [{ id: 'hours', label: 'When' }, { id: 'places', label: 'Where' }], tab, (id) => {
    tab = id;
    (id === 'hours' ? hours : places)();
  });
  hours();
}

async function fallback(deck, ctx) {
  const { view, param, sub } = ctx;
  const box = el('div', 'm-fallback');
  deck.append(box);
  if ((view === 'driver' || view === 'vehicle') && param) {
    skeleton(box, 3);
    try {
      const mod = view === 'driver' ? await import('../driver.js') : await import('../vehicle.js');
      if (!ctx.alive()) return;
      box.innerHTML = '';
      await (view === 'driver'
        ? mod.renderDriver(box, param, sub || 'overview')
        : mod.renderVehicle(box, param, sub || 'overview'));
    } catch (e) {
      if (!ctx.alive()) return;
      box.innerHTML = '';
      failed(box, e);
    }
    return;
  }
  empty(box, 'Built for a bigger screen',
    'This view is a wide table, and squeezing it onto a phone would lose the row you are reading.');
  const b = el('button', 'm-chip');
  b.type = 'button';
  b.textContent = 'Open it on the desktop version';
  b.onclick = () => { location.href = `/?ui=desktop#${[view, param, sub].filter(Boolean).join('/')}`; };
  const wrap = el('div');
  wrap.style.cssText = 'display:flex;justify-content:center';
  wrap.append(b);
  deck.append(wrap);
}

export const SCREENS = {
  today, money: moneyScreen, people, fleet, live, safety, unauthorized, sources, more,
  corporate, analyst, credentials, optimise, trips: tripsScreen, fallback,
  'online-time': onlineTime,
  /* A driver or vehicle with no sub-page gets the phone screen; a sub-page
     (`#driver/x/earnings`) is a desktop tab and goes to the fallback, which
     renders the real module. Decided in render() rather than here, because a
     route table cannot see whether `sub` is set. */
  driver, vehicle,
  /* The desktop's own addresses, so a link that predates this app still lands
     somewhere sensible rather than on the fallback. */
  overview: today, drivers: people, vehicles: fleet, finance: moneyScreen,
  unit: moneyScreen, settlement: moneyScreen, revenue: moneyScreen,
};
