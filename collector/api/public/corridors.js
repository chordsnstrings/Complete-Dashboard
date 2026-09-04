/* Corridors — where the work starts, where it ends, and what that implies.
   ──────────────────────────────────────────────────────────────────────────
   Four channels return a formatted address for pickup and drop-off and nothing
   was reading any of them. Rolled up to the community, they answer the one
   dispatch question this fleet could not previously ask from its own data:
   given a car free at 07:00, where should it be sitting?

   The area is PARSED out of the address text — providers return a string, not a
   place id — so this is evidence of a pattern, not a geofence. */

import { hbars, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, money, pct,
  countOf, plural, sourceLabel, foldRows, verdict } from './ui.js';
import { q, href, hrefFilter, state, currentGen, alive } from './data.js';

/* How many bars and wave rows this page draws. One constant, used by the
   slices AND by the subtitles that describe them — the KPI row said
   "59 shown below" above fourteen bars, and "share of the 59 areas shown"
   over a figure computed across all of them. */
const SHOWN = 14;

/* A morning share plotted as a plain bar is unreadable when every area sits
   between 35% and 53%: the bar scales to the largest value, so a five-point
   spread fills the panel and looks like a landslide. Drawn against a fixed
   centre line, the same numbers show what they actually are — a fleet whose
   areas are mostly balanced, with two that are not. */
function divergingWave(host, rows, wave = {}) {
  host.innerHTML = '';
  const span = (pair, dflt) => (Array.isArray(pair) && pair.length === 2
    ? `${String(pair[0]).padStart(2, '0')}:00-${String(pair[1]).padStart(2, '0')}:59` : dflt);
  const mLabel = span(wave.morning, '05:00-09:59');
  const eLabel = span(wave.evening, '16:00-21:59');
  const wrap = el('div', 'wave');
  rows.forEach((r) => {
    const tot = r.morning + r.evening;
    const am = (r.morning / tot) * 100;
    const off = am - 50;                       // -50 .. +50, negative = evening-heavy
    const w = Math.abs(off);
    const row = el('div', 'wv');
    row.innerHTML = `
      <div class="k" title="${esc(r.area)}">${esc(r.area)}</div>
      <div class="wv-track">
        <span class="wv-mid"></span>
        <i class="${off >= 0 ? 'am' : 'pm'}" style="width:${w}%;${off >= 0 ? 'right' : 'left'}:50%"></i>
      </div>
      <div class="v num">${fmt(r.morning)} <span class="sep">/</span> ${fmt(r.evening)}</div>`;
    /* The hours come from the endpoint, which is the thing that applied them.
       Hardcoded here they said 05:00-09:00 and 16:00-21:00 while the SQL used
       BETWEEN, i.e. through :59 — an hour of the fleet's day per tooltip. */
    row.title = `${r.area} — ${fmt(r.morning)} trips ${mLabel}, ${fmt(r.evening)} trips ${eLabel}`
      + (wave.days ? `, over ${fmt(wave.days)} day${wave.days === 1 ? '' : 's'}` : '');
    wrap.append(row);
  });
  host.append(wrap);
  host.append(el('p', 'cap', 'Numbers are morning / evening trip counts. The bar is the distance from an even split.'));
}

export async function renderCorridors(root) {
  root.innerHTML = '';
  const gen = currentGen();
  /* The KPI row and the origins roll-up paint as soon as they land, rather
     than after the whole corridor detail — which is 8.45s cold at a 365-day
     window, and drew one page-wide skeleton for all of it. The panels are laid
     out first so the page has a shape while it fills. */
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);
  const g = el('div', 'grid'); root.append(g);
  const { panel: p1, body: b1 } = panel('Where jobs start', 'Pickup area, all channels combined.');
  g.append(p1); loading(b1);
  const { panel: p2, body: b2 } = panel('Morning wave or evening wave',
    'Each area against the 50/50 line. A bar reaching left is an area that mostly produces work before 09:00; '
    + 'right is an area that mostly produces it after 16:00.');
  g.append(p2); loading(b2);
  const { panel: p3, body: b3 } = panel('Corridors', 'Pickup area → drop-off area, seen at least three times.');
  root.append(p3); loading(b3);

  let c;
  try { c = await q('/api/geo/corridors'); } catch (e) {
    if (!alive(gen)) return;
    root.innerHTML = '';
    return empty(root, `The corridor roll-up could not be computed: ${e.message}`);
  }
  if (!alive(gen)) return;

  if (!c.corridors.length && !c.origins.length) {
    root.innerHTML = '';
    /* A filter that matches nothing is not an empty date range. */
    const box = el('div', 'empty');
    box.innerHTML = state.platform
      ? `<b>No ${esc(sourceLabel(state.platform))} trip in this window carries an address</b>`
        + 'Not every channel returns one, and a channel with no bookings at all returns nothing to parse.'
      : '<b>No trip in this range carries an address</b>Pickup and drop-off text comes from the '
        + 'provider; without it there is no area to roll up to.';
    if (state.platform) {
      const link = el('p', 'cap');
      link.innerHTML = `<a class="lnk" href="${hrefFilter('corridors', { platform: '' })}">Every channel</a>`;
      box.append(link);
    }
    root.append(box);
    return;
  }
  /* The bucket this page drops, measured before it is dropped.
     ─────────────────────────────────────────────────────────────────────
     Filtering out '(unrecorded)' is right for a CHART — an unnamed bucket is
     not a place and drawing it as the tallest bar would say the fleet's
     busiest pickup point is nowhere. But on the live fleet it is 1,915
     pickups of 8,468, which is 22.6% and LARGER than Al Garhoud, the busiest
     area actually drawn. Silently removing a fifth of the data also moves
     every share on this page: "share of every addressed pickup" divides by
     the named total, so each area's percentage is overstated against the work
     that really happened.

     So it is dropped from the chart and STATED on the page. */
  const unrecorded = c.origins.find((o) => o.area === '(unrecorded)');
  const named = c.origins.filter((o) => o.area !== '(unrecorded)');
  const shownOrigins = named.slice(0, SHOWN);
  /* The share is over EVERY named area the endpoint returned, not over the
     fourteen drawn — a "Top 5" that divides by the visible rows reports the
     top five as a larger share of a smaller world. */
  const totalOrigin = named.reduce((a, o) => a + o.trips, 0);
  const t = c.totals || {};
  /* EVERY PICKUP IN THE WINDOW — one expression, so "of every pickup" cannot
     mean two things on one page.
     ─────────────────────────────────────────────────────────────────────
     The tile and the caption under the bars both describe the SAME unnamed
     bucket, and they divided it by different denominators: on production
     2026-09-02 over the last 30 days the tile said 2,112 was 15.6% of every
     pickup (2,112 / 13,536 = totals.pickups_all) while the caption said 22.3%
     of the window, which was 2,112 / (7,375 + 2,112) — 7,375 being the sum of
     the 59 named origin rows the SERVER SENT out of 1,362 areas in the window.
     The fallback is the same sum, used only when an older server sends no
     totals at all; it is a floor, not a second definition. */
  const pickupsAll = +t.pickups_all || (totalOrigin + (unrecorded?.trips || 0));
  kpiHost.innerHTML = '';
  /* This page rolls addresses into areas, and the fact that decides whether any
     of it can be trusted is how many pickups carry an address at all. */
  {
    /* `pickups_all` and `pickups_named` — the fields the endpoint really sends.
       Checked against production before writing the sentence, having shipped
       three verdicts today that read a field name I had assumed. */
    const all = +t.pickups_all || 0;
    /* Left as a bare read of the two fields rather than falling back to
       `pickupsAll`: an older server sending neither would make `all` the
       origins sum and `withArea` zero, and this block would announce that
       100% of pickups have no area. Both fields or no verdict. */
    const withArea = +t.pickups_named || 0;
    const noArea = all ? ((all - withArea) / all) * 100 : 0;
    const top = named[0];
    const topPct = top && withArea ? Math.round((top.trips / withArea) * 100) : 0;
    verdict(kpiHost, {
      /* WHAT IS MISSING IS MOSTLY A PARSE. NOT ALL OF IT — corrected.
         ───────────────────────────────────────────────────────────────
         This said "carry no usable address" over "11,424 of 13,536 pickups
         carry an address", which reads as 2,112 bookings with the field
         empty. The correction written here claimed "None of them is", on the
         evidence that /api/kpis?days=1 returned 535 bookings against
         pickups_all 535 on production 2026-09-02 — every booking has the
         text.

         That test could not tell the two cases apart. pickups_all was
         count(*) FILTER (WHERE pickup_addr IS NOT NULL), and an empty pickup
         address arrives from csv-parse as '' rather than NULL, which
         IS NOT NULL passes. 535 = 535 was consistent with every booking
         having an address AND with any number of them having ''.

         Measured properly since: Uber sends a BLANK pickup address on 23.0%
         of the trips it marks settled offline, against 2.4% of every other
         Uber trip, over 4,000 August 2026 bookings. So some of that 2,112 is
         the field genuinely empty, and the confident "None of them is" was
         wrong.

         api/analytics_routes.js now tests coalesce(btrim(pickup_addr), '')
         <> '' everywhere it counts an address, which is what AREA had always
         done — so pickups_all excludes the blanks and the gap between it and
         the addressed count is the parse failure it was always meant to be.
         The headline is true again, for a different reason than it claimed.

         Not escaped here: verdict() escapes the claim it is given, and doing
         it twice renders an area called "Al Qouz 1 & 2" as "Al Qouz 1 &amp;
         2". */
      claim: noArea >= 20
        ? `${Math.round(noArea)}% of pickup addresses name no area`
        : top
          ? `${top.area} is the busiest pickup area — ${topPct}% of addressed jobs`
          : 'No addressed pickup in this window',
      figure: noArea >= 20 ? `${Math.round(100 - noArea)}%` : fmt(t.corridors_3plus ?? c.corridors.length),
      unit: noArea >= 20 ? 'resolve to an area' : 'corridors seen 3+ times',
      tone: noArea >= 40 ? 'bad' : noArea >= 20 ? 'warn' : null,
      meta: `${fmt(t.origins_all ?? named.length)} pickup areas`,
      sub: `${fmt(withArea)} of ${fmt(all)} pickups resolve to an area. `
        + (noArea >= 20
          ? 'The rest carry an address the parse finds no community in. Every share on this page is '
            + 'over the ones that resolve — a corridor is only as real as the addresses behind it.'
          : `They roll into ${fmt(t.origins_all ?? named.length)} areas and `
            + `${fmt(t.corridors_all ?? c.corridors.length)} origin–destination pairs.`),
    });
  }

  kpiHost.append(kpiRow([
    { label: 'Distinct pickup areas', value: fmt(t.origins_all ?? named.length),
      sub: named.length > SHOWN
        ? `${fmt(SHOWN)} drawn below, of ${fmt(named.length)} the server returned`
        : `all ${fmt(named.length)} drawn below` },
    { label: 'Corridors seen 3+ times', value: fmt(t.corridors_3plus ?? c.corridors.length),
      sub: t.corridors_all ? `of ${fmt(t.corridors_all)} distinct origin–destination pairs` : null },
    /* One denominator for every share on this page.
       ─────────────────────────────────────────────────────────────────────
       There used to be three, in four adjacent tiles. "Busiest pickup area —
       25.9% of every addressed pickup" divided by the trips in the 59 areas
       the server RETURNED; "Top 5 areas — 52.4%" divided by the same 59; and
       "Pickups with no area — 22.2% of every pickup" divided by everything.
       The origins list is the top 60 of 1,237 areas, so the first two were
       shares of a truncated base and the third was not, and the tiles sat side
       by side with no way to tell.

       The endpoint now counts pickups over the WHOLE window rather than over
       the rows it returns — totals.pickups_all and pickups_named — so every
       figure here divides by the same thing and says which. */
    { label: 'Busiest pickup area', value: named[0]?.area || '—',
      sub: named[0]
        ? `${pct((named[0].trips / (t.pickups_named || totalOrigin)) * 100, 1)} of the `
          + `${fmt(t.pickups_named || totalOrigin)} pickups that carry a recognisable area`
        : null },
    { label: 'Top 5 areas', value: pct((named.slice(0, 5).reduce((a, o) => a + o.trips, 0)
      / (t.pickups_named || totalOrigin)) * 100, 1),
      sub: `of the same ${fmt(t.pickups_named || totalOrigin)} — and the five are the busiest of `
        + `${fmt(t.origins_all ?? named.length)} areas, not of the ${fmt(named.length)} this page `
        + 'was sent' },
    /* The largest single bucket on the page, and the one every percentage
       above it silently excludes. */
    unrecorded && unrecorded.trips
      ? { label: 'Pickups with no area', value: fmt(unrecorded.trips),
        tone: unrecorded.trips > (named[0]?.trips || 0) ? 'warn' : null,
        sub: `${pct((unrecorded.trips / pickupsAll) * 100, 1)} of every pickup — `
          + 'the address text carried no community, so these are in none of the figures beside this one' }
      : null,
  ]));

  /* An area is a place, and a place with a name is something a dispatcher
     wants to open — the whole page had zero anchors on it. */
  hbars(b1, shownOrigins.map((o) => ({ label: o.area, n: o.trips })), { signed: false });
  if (unrecorded && unrecorded.trips) {
    /* The tile above prints this same bucket as a share of every pickup in the
       window; here it was a share of `totalOrigin + unrecorded`, the rows this
       page happened to receive. Production 2026-09-02, last 30 days: 2,112
       pickups, 15.6% on the tile and 22.3% in this sentence, two panels apart
       and both about the same 2,112. */
    b1.append(el('p', 'cap', esc(
      `${countOf(unrecorded.trips, 'further pickup')} — `
      + `${pct((unrecorded.trips / pickupsAll) * 100, 1)} of the ${fmt(pickupsAll)} pickups in this `
      + 'window — carry an address with no community in it and are in none of these bars. Every share '
      + 'on this page is over the pickups that resolve to an area.')));
  }
  b1.append(el('p', 'cap', named.length > SHOWN
    ? `The ${fmt(SHOWN)} busiest of ${countOf(named.length, 'area')} the server returned`
      + `${t.origins_all && t.origins_all > named.length
        ? `, itself the busiest of ${fmt(t.origins_all)} in the window` : ''}.`
    : `Every one of the ${countOf(named.length, 'area')} with an addressed pickup.`));

  /* WHICH DAYS THE RATIO IS OVER.
     ─────────────────────────────────────────────────────────────────────────
     This panel is a ratio of two hour windows, and it was being drawn over a
     window whose last day had had one of them. On production 2026-09-02 at
     15:17 Dubai the endpoint returned evening = 0 for every area on a
     today-only window and this page printed "morning wave" over all of them;
     over Sep 1–2 it drew Al Garhoud and Business Bay as morning-heavy when
     Sep 1 alone — the only day that finished — is 17/21 and 2/8 the other way.

     The endpoint now holds a day out of BOTH halves until its evening window
     closes at 22:00 Dubai, and says which day and how many are left. The page
     says it too, because a bar whose denominator excludes today is a different
     claim from one that includes it. */
  const wv = c.wave || {};
  const hrs = (pair, dflt) => (Array.isArray(pair) && pair.length === 2
    ? `${String(pair[0]).padStart(2, '0')}:00\u2013${String(pair[1]).padStart(2, '0')}:59` : dflt);
  const waveHours = `${hrs(wv.morning, '05:00\u201309:59')} against ${hrs(wv.evening, '16:00\u201321:59')}`;
  const waves = named.map((o) => ({ area: o.area, morning: o.morning, evening: o.evening }))
    .filter((o) => o.morning + o.evening >= 3).slice(0, SHOWN);
  if (waves.length) {
    divergingWave(b2, waves, wv);
    /* `wave` absent means an older server is answering — the front end deploys
       ahead of the API often enough that "over 0 days in this window" would be
       a number this page invented. The hours are still stated; the denominator
       is only claimed when the server sent one. */
    b2.append(el('p', 'cap',
      waveHours
      + (wv.days == null ? '.' : `, over ${countOf(wv.days, 'day')}`)
      + (wv.days != null && wv.window_days && wv.window_days > wv.days
        ? ` of the ${fmt(wv.window_days)} in this window` : (wv.days == null ? '' : ' in this window'))
      + (wv.live_day
        ? `. ${esc(wv.live_day)} is today and is in NEITHER half: it is ${esc(wv.as_of || '')} Dubai, `
          + `its evening window does not close until ${esc(wv.closes || '22:00')}, and an evening that `
          + 'has not happened is not a quiet evening — counted, its morning alone would turn an '
          + 'evening-heavy area over.'
        : (wv.days == null ? '' : '.'))));
    if (named.length > waves.length) {
      b2.append(el('p', 'cap',
        `${fmt(waves.length)} of ${countOf(named.length, 'area')} shown — an area with fewer than three `
        + 'trips across both waves is left out rather than drawn as a landslide in one direction.'));
    }
  } else if (wv.live_day && !(wv.days ?? 0)) {
    /* A today-only window. The honest answer is that the question cannot be
       asked yet — not a chart of every area leaning whichever way the clock
       is currently pointing. */
    empty(b2, `Today is the only day in this window and its evening window (${
      esc(hrs(wv.evening, '16:00\u201321:59'))}) does not close until ${esc(wv.closes || '22:00')} Dubai — `
      + `it is ${esc(wv.as_of || '')} now. An area cannot be called morning- or evening-leaning from a `
      + 'morning alone, so nothing is drawn here until a day in this window has had both.');
  } else empty(b2, 'Not enough addressed trips in either wave');

  b3.innerHTML = '';
  /* The column used to be absent on every window, because it read duration_s
     — declared in the schema and written by no collector. The measurement was
     there all along in the two timestamps, which #trip has always shown and
     this page said nothing about; the endpoint derives it now. Still guarded,
     because a window with no ended_at at all is a real state. */
  const anyMin = c.corridors.some((r) => r.avg_min != null);
  /* Request to dropoff CONTAINS the approach and the rider's wait, so it is
     not drive time and must not be labelled as one. Named on the MAJORITY
     rather than on "did any channel file one": on this fleet none does, so the
     whole column is derived — but a single channel-timed booking must not
     rename the column back to a measure the other several thousand rows are
     not. Where any of it is derived, the header says so and the caption says
     how much of it a channel actually filed. */
  const minsReported = c.duration_reported || 0;
  const minsDerived = (c.duration_measured || 0) > minsReported;
  const corrTable = tableFrom(c.corridors, [
    { label: 'From', key: 'from_area' },
    { label: 'To', key: 'to_area' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Avg km', key: 'avg_km', num: true, render: (r) => fmt(r.avg_km, 1) },
    /* THE DENOMINATOR IS PRINTED, NOT HOVERED.
       ─────────────────────────────────────────────────────────────────────
       This cell rendered "14 min" and hid `min_n` in a title attribute — a
       tooltip is invisible in a screenshot, absent on touch, and unreachable
       by keyboard, while the two money columns beside it state their coverage
       inline ("205 of 357 · 57%") and mark a thin one with a visible asterisk.
       On production 2026-09-02 that hid real spreads: Burj Khalifa → Burj
       Khalifa averaged 19.4 min over 497 of 3,277 trips (15%) and Business Bay
       → Business Bay 14.9 min over 1,211 of 2,693 (45%), both printed as a
       bare number. Below half the whole cell is dimmed, the same withholding
       Avg fare does, because an average over a seventh of a corridor is not
       the corridor's average. */
    ...(anyMin ? [{ label: minsDerived ? 'Request → drop' : 'Avg minutes', key: 'avg_min', num: true,
      render: (r) => {
        if (r.avg_min == null) return '<span class="ent-off" title="no booking on this corridor records both a request and an end time">—</span>';
        const over = `${fmt(r.min_n)} of ${fmt(r.trips)}`;
        const thin = r.trips ? (r.min_n / r.trips) < 0.5 : false;
        return thin
          ? `<span class="dim" title="over only ${over} trips on this corridor — the rest record no end time">${
            fmt(r.avg_min, 0)} min · ${over}</span>`
          : `${fmt(r.avg_min, 0)}<span class="dim" title="over the ${over} trips on this corridor that record both times"> min · ${over}</span>`;
      } }] : []),
    /* An average over 2% of a corridor's trips is not the corridor's average.
       The denominator sits beside it and the tone is withheld below half. */
    { label: 'Avg fare', key: 'avg_fare', num: true,
      render: (r) => {
        if (!r.priced) return '<span class="ent-off" title="no trip on this corridor reports a fare — mostly Uber, whose export has no fare column">—</span>';
        const cover = r.trips ? (r.priced / r.trips) * 100 : 0;
        return cover < 50
          ? `<span class="dim" title="over only ${r.priced} of ${r.trips} trips — too little coverage to compare corridors on">${
            esc(money(r.avg_fare, 'AED', 2))} *</span>`
          : money(r.avg_fare, 'AED', 2);
      } },
    { label: 'Priced', key: 'priced', num: true,
      sortValue: (r) => (r.trips ? (r.priced / r.trips) : null),
      render: (r) => `${fmt(r.priced)} of ${fmt(r.trips)}<span class="dim"> · ${
        pct(r.trips ? (r.priced / r.trips) * 100 : 0, 0)}</span>` },
    { label: 'Channels', key: 'platforms', render: (r) => esc((r.platforms || []).map(sourceLabel).join(', ')) },
  ], { sortable: true, sortId: 'corr', defaultSort: { key: 'trips', dir: 'desc' },
    capped: c.truncated ? `all ${fmt(t.corridors_3plus ?? c.corridors.length)} corridors` : null });
  foldRows(b3, corrTable, { shown: 12, total: c.corridors.length, noun: 'corridor', key: 'corridors' });

  const caps = [];
  if (c.truncated || (t.corridors_3plus && t.corridors_3plus > c.corridors.length)) {
    caps.push(`Showing the ${fmt(c.corridors.length)} busiest of `
      + `${fmt(t.corridors_3plus ?? c.corridors.length)} corridors seen three or more times`
      + (t.corridors_all ? `, out of ${fmt(t.corridors_all)} distinct pairs in the window` : ''));
  }
  if (c.corridors.some((r) => r.priced && r.trips && r.priced / r.trips < 0.5)) {
    caps.push('* the average fare is over fewer than half that corridor\'s trips, so it describes the '
      + 'priced minority — two starred averages are not comparable with each other');
  }
  if (!anyMin) {
    caps.push('There is no timing column because no booking in this window records both a request '
      + 'time and an end time, and no channel files a duration of its own — the field is declared '
      + 'in the schema and the collector never writes it');
  } else if (minsDerived) {
    caps.push('"Request → drop" is the gap between the two timestamps on the booking, not drive '
      + 'time: it contains the approach and the rider\'s wait. It is measured over the '
      + `${fmt(c.duration_measured || 0)} bookings that record both times`
      + (minsReported
        ? `, of which ${fmt(minsReported)} carry a duration the channel filed itself`
        : ', and no channel here files a duration of its own'));
  }
  /* The Avg fare column's own explanation, BESIDE the table rather than at the
     foot of the page.
     ─────────────────────────────────────────────────────────────────────────
     This sentence existed and sat in the closing note, after everything else on
     the view. Measured on production 2026-09-02, "Avg fare" is a dash in 34 of
     42 corridor rows — a column that is empty five times in six, with its
     reason two panels further down, past a fold on a phone. A reader who
     reaches the dashes has to leave the table to find out they are not a bug.
     bin/render-audit.mjs reported it as a sparse column for the same reason:
     it reads the captions inside the panel, which is where a sentence about
     this table's column belongs. */
  const blankFare = c.corridors.filter((r) => !r.priced).length;
  if (blankFare) {
    caps.push(`Avg fare is blank on ${countOf(blankFare, 'corridor')} — those are mostly Uber, whose `
      + 'export carries no fare column at all. The trip count on those rows is real; the money is '
      + 'simply not there to report');
  }
  if (caps.length) b3.append(el('p', 'cap', `${caps.join('. ')}.`));

  root.append(note(c.note));
}
