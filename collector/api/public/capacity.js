/* Which shifts to add, and which to stop paying for.
   ──────────────────────────────────────────────────────────────────────────
   The forecast says how much work is coming. The slot pages say who covers
   each hour now. This is the join: for every weekday-hour, next month's
   projected bookings against what the drivers who actually work that hour have
   historically delivered in it.

   The number it produces is a division, not a capacity claim, and the page
   says so in as many words. A driver's throughput in an hour is a measurement
   taken under whatever demand there was — a quiet hour makes its drivers look
   unproductive and a frantic one makes them look heroic. Presenting that as
   "how much a driver can do" would turn an artefact of demand into a
   performance judgement about people. */

import { empty, fmt, heatmap } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, countOf, plural,
  signed, foldRows, verdict, sourceLine } from './ui.js';
import { q, href } from './data.js';

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = (m) => {
  const [y, mm] = String(m).slice(0, 7).split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+mm - 1]} ${y.slice(2)}`;
};
const slotLink = (r) => href('slot', String(r.dow), String(r.hour));
const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;

/* The endpoint's own definition of a short hour — api/capacity_routes.js
   filters `driver_gap >= 0.5 && !thin` to build totals.cells_short. Mirrored
   here so the headline's FIGURE covers exactly the hours its CLAIM counts:
   "166 hours are short" and the number beside it have to be about the same
   166 hours, and there is no other way to reach that set from the response
   (`shortfall` is the twenty largest, not the list). */
const isShort = (r) => r.driver_gap != null && r.driver_gap >= 0.5 && !r.thin;

export async function renderCapacity(root) {
  root.innerHTML = '';
  loading(root);
  const [d, plats] = await Promise.all([
    q('/api/capacity'),
    q('/api/platforms').catch(() => []),
  ]);
  root.innerHTML = '';

  if (!d.ok) {
    root.append(el('div', 'empty', `<b>Cannot plan a rota yet</b>${esc(d.reason || '')}`));
    return;
  }

  const t = d.totals || {};

  /* The rate the hourly shares were measured at, as a monthly figure, computed
     once for the headline and for the paragraph at the foot of the page.
     ─────────────────────────────────────────────────────────────────────────
     The field is `observed_bookings` — capacity_routes.js has never sent
     `trailing_bookings`, which is what this read — so trailingRate was null on
     every load in production and the paragraph explaining WHY the week reads
     short fell through to a coarser fallback that names no percentage and no
     forecast interval. On 2026-09-02 the window carried 31,048 bookings over
     84 days, an 11,089-a-month rate, against a 15,500 projection for Oct 26:
     the projection is 40% above the rate every cell's share was measured at,
     which is the whole reason 166 of 168 hours read short. */
  const trailingBookings = d.trailing_bookings ?? d.observed_bookings ?? null;
  const trailingRate = trailingBookings != null && d.window_days
    ? (trailingBookings / d.window_days) * 30 : null;
  const liftPct = trailingRate && d.target_bookings
    ? Math.round(((d.target_bookings / trailingRate) - 1) * 100) : null;

  /* A rota page opened on four tiles and 188 rows of hours. The question it is
     open for is whether next month's work is covered — and by how much it is
     not, in people rather than in cells. */
  {
    const short = t.cells_short || 0;
    const spare = t.cells_spare || 0;
    const cells = (d.cells || []).length || (short + spare);
    const shortPct = cells ? Math.round((short / cells) * 100) : 0;
    const shortCells = (d.cells || []).filter(isShort);
    /* Drivers minus drivers. This subtracted DRIVERS from BOOKINGS — Tuesday
       18:00 contributed 38.7 bookings expected each time less 22.3 drivers on
       it, and the difference of two different units was then printed under the
       word "driver-shifts". Summed over the twenty rows of `shortfall` it read
       301 on 2026-09-02, a number that is neither bookings nor people.
       driver_gap is the same subtraction already done in ONE unit — drivers
       needed at this cell's own measured rate, less the drivers who turn up —
       and over the 166 hours the claim counts it is 763. Taken from `cells`
       rather than `shortfall` for that reason: shortfall is the twenty largest
       gaps, so the old sum described 20 hours under a headline about 166. */
    const heads = shortCells.reduce((a, r) => a + (+r.driver_gap || 0), 0);
    /* What the "most ever seen" column on the panel below already shows, said
       in the headline instead of leaving a reader to notice it row by row:
       149 of production's 166 short hours have carried at least as many
       drivers as the projection needs, at some point in the trailing 84 days.
       So "0 hours have people to spare" is a statement about the AVERAGE
       turnout in each hour, not about a fleet with nobody left. */
    const reached = shortCells.filter((r) => r.most_drivers_seen != null
      && r.drivers_needed != null && r.most_drivers_seen >= r.drivers_needed).length;
    verdict(root, {
      claim: short
        ? `${fmt(short)} ${plural(short, 'hour')} of the week ${short === 1 ? 'is' : 'are'} short of people`
        : 'Every hour of the week is covered for the forecast',
      figure: short ? fmt(Math.ceil(heads)) : fmt(spare),
      /* Driver-hours, because each cell is one hour of one weekday and its gap
         is drivers-per-occurrence: summed across the week's cells the total is
         what a single week of the projected month is short by. */
      unit: short ? 'driver-hours short in a week' : 'hours with people to spare',
      tone: shortPct >= 25 ? 'bad' : short ? 'warn' : null,
      meta: `${fmt(d.target_bookings)} bookings expected in ${MONTH(d.target_month)}`,
      /* The old sentence was unconditional and read "0 hours have people to
         spare, so some of this is a rota that can be moved rather than people
         who have to be hired" — a conclusion drawn from a count of zero, on a
         page whose spare-hours panel says in as many words that there are
         none. When the count is zero the sentence now says what was actually
         measured, and hands over the fact that does bear on moving people. */
      sub: (spare
        ? `${fmt(spare)} ${plural(spare, 'hour')} ${spare === 1 ? 'has' : 'have'} people to spare, so `
          + 'some of this is a rota that can be moved rather than people who have to be hired.'
        : 'No hour is covered beyond the projection, so this is measured against the average turnout in '
          + 'each hour and not against spare cover.'
          + (reached
            ? ` ${fmt(reached)} of the ${fmt(short)} short hours ${plural(reached, 'has', 'have')} already `
              + 'carried as many drivers as the projection needs, at some point in the trailing '
              + `${fmt(d.window_days)} days — the "most ever seen" column below — so the gap is in the `
              + 'average turnout rather than in the fleet\'s reach.'
            : ''))
        + (d.forecast_kind === 'extrapolation'
          ? ' The forecast behind it is an extrapolation, not a fitted model — read the range, not the point.'
          : ''),
      recommend: short
        ? 'Each hour below opens its own slot page, with who currently works it.'
        : null,
    });
  }

  root.append(kpiRow([
    { label: `Bookings expected in ${MONTH(d.target_month)}`, value: fmt(d.target_bookings),
      sub: d.target_low != null ? `${fmt(d.target_low)} – ${fmt(d.target_high)}` : null,
      tone: d.forecast_kind === 'extrapolation' ? 'warn' : null },
    { label: 'Hours needing more people', value: fmt(t.cells_short),
      sub: 'at the rate their own drivers currently work them',
      tone: t.cells_short ? 'warn' : 'good' },
    { label: 'Hours with people to spare', value: fmt(t.cells_spare),
      sub: 'covered beyond what the projection needs' },
    /* The HOUR, on a tile labelled "Busiest single hour" that printed a
       headcount — and led nowhere, on a page where every other row naming an
       hour opens it. */
    (() => {
      const peak = [...(d.cells || [])].sort((a, b) => (b.drivers_needed ?? -1) - (a.drivers_needed ?? -1))[0];
      if (!peak || peak.drivers_needed == null) {
        return { label: 'Busiest single hour', value: '—', sub: 'no hour has enough history to size' };
      }
      return { label: 'Busiest single hour',
        html: `<a class="ent" href="${slotLink(peak)}">${DOW[peak.dow]} ${hhmm(peak.hour)}</a>`,
        sub: `${fmt(peak.drivers_needed, 1)} drivers needed at the rate its own drivers currently work it` };
    })(),
    { label: 'Hours with too little history', value: fmt(t.cells_thin),
      sub: 'seen fewer than four times — shown, not planned on', tone: t.cells_thin ? 'warn' : null },
  ]));

  if (d.forecast_kind === 'extrapolation') {
    root.append(el('div', 'note err',
      `${MONTH(d.target_month)} is beyond the third forecast month, so its total is an extrapolation rather `
      + 'than a forecast. Every figure below inherits that: read them as a shape, not as a rota.'));
  }

  /* ── where the gap is ─────────────────────────────────────────────────── */
  const g = el('div', 'grid g2'); root.append(g);

  const { panel: sp, body: sb } = panel('Add people here',
    'Hours where the projection exceeds what the drivers who currently work them have been delivering. '
    + 'Ordered by the size of the gap.');
  g.append(sp);
  if (!d.shortfall.length) empty(sb, 'No hour is projected to need more than it currently gets.');
  else {
    foldRows(sb, gapTable(d.shortfall, 'short'),
      { shown: 10, total: d.shortfall.length, noun: 'hour', key: 'cap-short' });
    if (t.cells_short > d.shortfall.length) {
      sb.append(el('p', 'cap',
        `The ${fmt(d.shortfall.length)} largest gaps of ${countOf(t.cells_short, 'hour')} that read short. `
        + 'Every one of them is in the full table below.'));
    }
    const worst = d.shortfall[0];
    sb.append(el('p', 'note',
      `The largest gap is ${DOW[worst.dow]} at ${hhmm(worst.hour)}: ${fmt(worst.expected_per_occurrence, 1)} `
      + `bookings expected each time it comes round, against ${fmt(worst.drivers_per_occurrence, 1)} drivers `
      + `who between them have been doing ${fmt(worst.bookings_per_driver, 1)} each. That is `
      + `${fmt(worst.drivers_needed, 1)} people at the current rate — about `
      + `${Math.ceil(worst.driver_gap)} more than turn up now.`));
  }

  const { panel: pp, body: pb } = panel('Cover to spare here',
    'Hours covered beyond what the projection needs. Worth checking before adding people elsewhere — '
    + 'moving somebody is cheaper than recruiting.');
  g.append(pp);
  if (!d.surplus.length) empty(pb, 'No hour is covered beyond its projection.');
  else {
    foldRows(pb, gapTable(d.surplus, 'spare'),
      { shown: 10, total: d.surplus.length, noun: 'hour', key: 'cap-spare' });
    if (t.cells_spare > d.surplus.length) {
      pb.append(el('p', 'cap',
        `The ${fmt(d.surplus.length)} largest of ${countOf(t.cells_spare, 'hour')} with cover to spare.`));
    }
  }

  /* ── the whole week ───────────────────────────────────────────────────── */
  const { panel: hp, body: hb } = panel('Every hour of the week',
    'Darker means more people needed at the current rate. Click an hour to open it.');
  root.append(hp);
  const grid = d.cells.map((c) => ({ dow: c.dow, h: c.hour, trips: c.drivers_needed ?? 0 }));
  /* The unit, in the tooltip. Every cell said "— 28.6 trips" where the value
     is DRIVERS NEEDED, contradicting the caption directly beneath it. */
  heatmap(hb, grid, { unit: 'drivers needed', valueFmt: (v) => fmt(v, 1),
    onClick: (c) => { location.hash = href('slot', String(c.dow), String(c.h)); } });
  hb.append(el('p', 'cap',
    'The scale is drivers needed, not bookings — an hour with modest demand and nobody on it matters more '
    + 'to a rota than a busy hour that is already staffed. Shading is against this grid\'s own busiest '
    + 'cell, so it is a ranking within the week rather than an absolute level.'));

  /* ── the arithmetic, in full ──────────────────────────────────────────── */
  const { panel: ap, body: ab } = panel('Every hour, with the arithmetic',
    `Shares measured over the trailing ${d.window_days} days — the fleet that produced last year's hours is `
    + 'not the one rostering next month, and a shape averaged across a 76% collapse describes neither.');
  root.append(ap);
  /* Every hour of the week, not sixty of them. A panel titled "Every hour"
     that draws 60 of 168 rows is the one caption on this page nobody would
     think to check — and the table already lives in a scroll container. */
  const allHours = [...d.cells].sort((a, b) => (b.driver_gap ?? -99) - (a.driver_gap ?? -99));
  const hoursTable = tableFrom(allHours, [
      { label: 'Hour', key: '_s', render: (r) => `<a href="${slotLink(r)}">${SHORT[r.dow]} ${hhmm(r.hour)}</a>`
        + (r.thin ? ' <span class="tag warn">thin history</span>' : '') },
      { label: 'Share of the month', key: 'share_pct', num: true, render: (r) => `${r.share_pct}%` },
      { label: 'Expected', key: 'expected_month', num: true,
        render: (r) => `${fmt(r.expected_month)} <small class="dim">${fmt(r.expected_per_occurrence, 1)}/time</small>` },
      { label: 'Drivers now', key: 'drivers_per_occurrence', num: true, render: (r) => fmt(r.drivers_per_occurrence, 1) },
      { label: 'Each doing', key: 'bookings_per_driver', num: true,
        render: (r) => (r.bookings_per_driver == null ? '—' : fmt(r.bookings_per_driver, 1)) },
      { label: 'Needed at that rate', key: 'drivers_needed', num: true,
        render: (r) => (r.drivers_needed == null ? '—' : fmt(r.drivers_needed, 1)) },
      { label: 'Gap', key: 'driver_gap', num: true, render: (r) => (r.driver_gap == null ? '—'
        : `<span class="pill ${r.driver_gap >= 0.5 ? 'bad' : r.driver_gap <= -0.5 ? 'ok' : ''}">`
          + `${esc(signed(r.driver_gap, { d: 1 }))}</span>`) },
    ], { sortable: true, sortId: 'cells', defaultSort: { key: 'driver_gap', dir: 'desc' } });
  /* 168 rows — every hour of the week — is 7,460px on its own, and the hours
     that need a decision are the ones at the top. Folded to those; the rest
     stay one click away, still sortable, because "every hour" has to keep
     meaning every hour. */
  foldRows(ab, hoursTable, { shown: 14, total: allHours.length, noun: 'hour', key: 'cap-cells' });
  ab.append(el('p', 'cap',
    `All ${countOf(d.cells.length, 'hour')} of the week, largest gap first. The table scrolls; nothing is cut.`));

  /* Why nearly every hour reads short. The month's projection is above the
     rate the hourly shares were measured at, so the arithmetic produces a
     shortfall in almost every cell before anything about the rota is
     considered — 93 hours short and exactly one spare is a property of the
     comparison, not a finding about the week. */
  if (trailingRate && liftPct != null) {
    const lift = liftPct;
    if (Math.abs(lift) >= 5) {
      // Built with el(), not note(): note() escapes its text, and this sentence
      // carries the link to the page the comparison comes from.
      root.append(el('div', 'note warn',
        `${esc(MONTH(d.target_month))}'s projection is ${lift > 0 ? `${lift}% above` : `${Math.abs(lift)}% below`} `
        + `the rate the hourly shares were measured at (${fmt(Math.round(trailingRate))} bookings a month `
        + `over the trailing ${fmt(d.window_days)} days). Every cell inherits that, so `
        + `${lift > 0 ? 'most hours read short' : 'most hours read covered'} before anything about the rota `
        + 'is considered. '
        + (d.target_low != null
          ? `The low end of the forecast interval — ${fmt(d.target_low)} — is the conservative rota. `
            + `<a class="lnk" href="${href('forecast')}">Where the interval comes from</a>.`
          : '')));
    }
  } else if (t.cells_short > 100) {
    root.append(el('div', 'note warn',
      `${fmt(t.cells_short)} of ${fmt(d.cells.length)} hours read short and ${fmt(t.cells_spare)} read `
      + 'spare. A split that lopsided is usually the monthly projection sitting above the rate the '
      + 'hourly shares were measured at rather than a week that is uniformly understaffed — check the '
      + `total against <a class="lnk" href="${href('forecast')}">the forecast</a> before rostering to it.`));
  }

  root.append(note(d.caveat));
  root.append(el('p', 'cap',
    `<a href="${href('forecast')}">Where the monthly total comes from</a> · `
    + `<a href="${href('playbook')}">What else to do about it</a> · `
    + `<a href="${href('retention')}">Whether the people to fill these hours are still here</a>`));
  /* The rota is planned against demand from every channel the fleet works, and
     an audit of production found this page naming none of them. A projection
     built on a window in which one channel was silent is a projection of a
     smaller fleet, and the reader has to be able to see that. */
  const src = sourceLine(plats, {
    note: 'The projection is built on the demand these channels reported in the window it was '
      + 'fitted over, so a channel that stopped collecting lowers it',
  });
  if (src) root.append(src);
}

function gapTable(rows, id) {
  return tableFrom(rows, [
    { label: 'Hour', key: '_s',
      sortValue: (r) => r.dow * 24 + r.hour,
      render: (r) => `<a class="ent" href="${slotLink(r)}">${DOW[r.dow]} ${hhmm(r.hour)}</a>` },
    { label: 'Expected each time', key: 'expected_per_occurrence', num: true,
      render: (r) => fmt(r.expected_per_occurrence, 1) },
    { label: 'Drivers now', key: 'drivers_per_occurrence', num: true, render: (r) => fmt(r.drivers_per_occurrence, 1) },
    /* The ceiling this hour has ever actually reached, where the endpoint
       reports it — asking for 28.6 drivers on a Friday at 19:00 means
       something different when the most ever seen in that hour is 29. */
    { label: 'Most ever seen', key: 'most_drivers_seen', num: true,
      render: (r) => (r.most_drivers_seen == null
        ? '<span class="ent-off" title="not reported for this hour">—</span>'
        : fmt(r.most_drivers_seen)) },
    { label: 'Needed', key: 'drivers_needed', num: true, render: (r) => fmt(r.drivers_needed, 1) },
    { label: 'Times next month', key: 'occurrences_next', num: true,
      render: (r) => (r.occurrences_next == null
        ? '<span class="ent-off" title="not reported for this hour">—</span>'
        : fmt(r.occurrences_next)) },
    { label: 'Gap', key: 'driver_gap', num: true,
      render: (r) => `<span class="pill ${r.driver_gap > 0 ? 'bad' : 'ok'}">${esc(signed(r.driver_gap, { d: 1 }))}</span>` },
  ], { compact: true, sortable: true, sortId: `gap-${id}`,
    defaultSort: { key: 'driver_gap', dir: id === 'short' ? 'desc' : 'asc' } });
}
