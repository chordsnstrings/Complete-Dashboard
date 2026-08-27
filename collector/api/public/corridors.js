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
function divergingWave(host, rows) {
  host.innerHTML = '';
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
    row.title = `${r.area} — ${fmt(r.morning)} trips 05:00-09:00, ${fmt(r.evening)} trips 16:00-21:00`;
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
  kpiHost.innerHTML = '';
  /* This page rolls addresses into areas, and the fact that decides whether any
     of it can be trusted is how many pickups carry an address at all. */
  {
    /* `pickups_all` and `pickups_named` — the fields the endpoint really sends.
       Checked against production before writing the sentence, having shipped
       three verdicts today that read a field name I had assumed. */
    const all = +t.pickups_all || 0;
    const withArea = +t.pickups_named || 0;
    const noArea = all ? ((all - withArea) / all) * 100 : 0;
    const top = named[0];
    const topPct = top && withArea ? Math.round((top.trips / withArea) * 100) : 0;
    verdict(kpiHost, {
      /* Not escaped here: verdict() escapes the claim it is given, and doing it
         twice renders an area called "Al Qouz 1 & 2" as "Al Qouz 1 &amp; 2". */
      claim: noArea >= 20
        ? `${Math.round(noArea)}% of pickups carry no usable address`
        : top
          ? `${top.area} is the busiest pickup area — ${topPct}% of addressed jobs`
          : 'No addressed pickup in this window',
      figure: noArea >= 20 ? `${Math.round(100 - noArea)}%` : fmt(t.corridors_3plus ?? c.corridors.length),
      unit: noArea >= 20 ? 'addressed' : 'corridors seen 3+ times',
      tone: noArea >= 40 ? 'bad' : noArea >= 20 ? 'warn' : null,
      meta: `${fmt(t.origins_all ?? named.length)} pickup areas`,
      sub: `${fmt(withArea)} of ${fmt(all)} pickups carry an address. `
        + (noArea >= 20
          ? 'Every share on this page is over those — a corridor is only as real as the addresses behind it.'
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
        sub: `${pct((unrecorded.trips / (t.pickups_all || (totalOrigin + unrecorded.trips))) * 100, 1)} of every pickup — `
          + 'the address text carried no community, so these are in none of the figures beside this one' }
      : null,
  ]));

  /* An area is a place, and a place with a name is something a dispatcher
     wants to open — the whole page had zero anchors on it. */
  hbars(b1, shownOrigins.map((o) => ({ label: o.area, n: o.trips })), { signed: false });
  if (unrecorded && unrecorded.trips) {
    b1.append(el('p', 'cap', esc(
      `${countOf(unrecorded.trips, 'further pickup')} — `
      + `${pct((unrecorded.trips / (totalOrigin + unrecorded.trips)) * 100, 1)} of the window — carry an `
      + 'address with no community in it and are in none of these bars. Every share on this page is '
      + 'over the addressed pickups only.')));
  }
  b1.append(el('p', 'cap', named.length > SHOWN
    ? `The ${fmt(SHOWN)} busiest of ${countOf(named.length, 'area')} the server returned`
      + `${t.origins_all && t.origins_all > named.length
        ? `, itself the busiest of ${fmt(t.origins_all)} in the window` : ''}.`
    : `Every one of the ${countOf(named.length, 'area')} with an addressed pickup.`));

  const waves = named.map((o) => ({ area: o.area, morning: o.morning, evening: o.evening }))
    .filter((o) => o.morning + o.evening >= 3).slice(0, SHOWN);
  if (waves.length) {
    divergingWave(b2, waves);
    if (named.length > waves.length) {
      b2.append(el('p', 'cap',
        `${fmt(waves.length)} of ${countOf(named.length, 'area')} shown — an area with fewer than three `
        + 'trips across both waves is left out rather than drawn as a landslide in one direction.'));
    }
  } else empty(b2, 'Not enough addressed trips in either wave');

  b3.innerHTML = '';
  /* `avg_min` is null on every corridor in every window, because duration_s is
     declared and never written. A column of dashes reads as "these particular
     corridors have no timing"; one sentence says what it actually is. */
  const anyMin = c.corridors.some((r) => r.avg_min != null);
  const corrTable = tableFrom(c.corridors, [
    { label: 'From', key: 'from_area' },
    { label: 'To', key: 'to_area' },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Avg km', key: 'avg_km', num: true, render: (r) => fmt(r.avg_km, 1) },
    ...(anyMin ? [{ label: 'Avg minutes', key: 'avg_min', num: true, render: (r) => fmt(r.avg_min, 0) }] : []),
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
    caps.push('There is no average-minutes column because no provider\'s trip duration is stored: the '
      + 'field is declared in the schema and the collector never writes it, so a column here would be '
      + 'empty on every corridor in every window rather than on these ones');
  }
  if (caps.length) b3.append(el('p', 'cap', `${caps.join('. ')}.`));

  root.append(note(`${c.note} Fares are blank on corridors that are mostly Uber, because that export `
    + 'carries no fare column — the trip count on those rows is real and the money is simply not there '
    + 'to report.'));
}
