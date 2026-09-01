/* Unit economics — the first screen.
   ──────────────────────────────────────────────────────────────────────────
     #unit            what the fleet earned, where it is concentrated, and
                      which assets and people produced none of it
     #unit/assets     every vehicle, sortable, with a rate on every row
     #unit/drivers    every person, the same way

   Why this replaced the overview as the landing page
   ─────────────────────────────────────────────────────────────────────────
   The old first screen led with TRIPS. Trips are the easiest thing this
   database holds and the least useful thing to lead with: the fleet's busiest
   month by trip count was also the month it earned least per trip, and no
   panel on that page could have shown it. Worse, the money it did show was
   trip.price — and the Uber export has no fare column, so a card headed
   "Revenue" was reporting the hotel channel's few hundred bookings against a
   fleet doing forty thousand.

   The question an operator opens this product to ask is which assets and which
   people make money and which do not, and that is a RANKING with a rate on
   every row. So the first screen is a ledger.

   What the numbers are, said once here and repeated where it matters:

     MONEY IN   fares where the channel prices a trip, attributed net payout
                where it does not, chosen per channel — never both, because a
                payout is what is left of those same fares after commission.
     PER DAY    over the days that asset or person actually EARNED, not over
                the calendar. Idle days are their own number beside it.
     PER KM     comparable within a channel and not across them: Uber's money
                is net of commission and the hotel channel's is a gross fare.

   And what is NOT here, because the database does not hold it: there is no
   fuel, lease, insurance, salary or maintenance table anywhere in this
   product, so there is no cost, no margin and no profit. "Losing money" on
   this page means an asset or a person consuming time — and, for a car,
   insurance and registration that are being paid whether or not it moves —
   while producing little or nothing. Nothing here is a P&L and no panel
   pretends to be one. */

import { areaChart, hbars, scatter, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, pill, entity,
  dayStr, money, pct, sourceLabel, countOf, plural, verdict } from './ui.js';
import { q, href, state } from './data.js';
import { makeMap, fitTo } from './map.js';

export const UNIT_TABS = [
  { id: 'overview', label: 'The money', ic: '◆' },
  { id: 'assets', label: 'Every vehicle', ic: '▤' },
  { id: 'drivers', label: 'Every driver', ic: '◧' },
];

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/* Three states an asset can be in, and the middle one is the expensive one.
   These are STATUS colours, not series colours: they mean good and bad rather
   than identity, so they carry a word as well as a hue — nothing here is
   distinguishable by colour alone. */
const BAND = {
  earning: { label: 'Earning', tone: 'ok', colour: '--good' },
  moved_unpaid: { label: 'Moved, no money', tone: 'bad', colour: '--critical' },
  still: { label: 'Never moved', tone: 'warn', colour: '--warn' },
};
const PBAND = {
  earning: { label: 'Earning', tone: 'ok' },
  drove_unpaid: { label: 'Drove, no money', tone: 'bad' },
  idle: { label: 'No trip', tone: 'warn' },
};

/* A cell that is empty because the question could not be asked, rather than
   because the answer is zero. The house rule is an em-dash with a reason; the
   reason lives in the title so a table stays a table. */
const absent = (why) => `<span class="ent-off" title="${esc(why)}">—</span>`;

/* ── a sortable ledger ────────────────────────────────────────────────────
   tableFrom renders; it does not sort, and a ranking nobody can re-rank is
   half a ranking. This wraps it: clicking a column header sorts by that
   column, clicking again reverses, and the active column says which way. Null
   always sinks — a missing rate is not the smallest rate, and letting it sort
   as zero puts every unmeasured row at the top of "worst". */
function ledger(host, rows, cols, { initial, dir = 'desc', onRow } = {}) {
  let key = initial || cols.find((c) => c.num)?.key;
  let down = dir === 'desc';
  const draw = () => {
    host.innerHTML = '';
    const col = cols.find((c) => c.key === key);
    const sorted = [...rows];
    if (col) {
      const val = (r) => (col.sortVal ? col.sortVal(r) : r[col.key]);
      sorted.sort((a, b) => {
        const x = val(a), y = val(b);
        const xn = x == null || x === '', yn = y == null || y === '';
        if (xn && yn) return 0;
        if (xn) return 1;                       // absence sinks, either direction
        if (yn) return -1;
        const c = typeof x === 'number' && typeof y === 'number'
          ? x - y : String(x).localeCompare(String(y));
        return down ? -c : c;
      });
    }
    const t = tableFrom(sorted, cols.map((c) => ({
      ...c,
      label: c.key === key ? `${c.label} ${down ? '▾' : '▴'}` : c.label,
    })));
    t.querySelectorAll('thead th').forEach((th, i) => {
      const c = cols[i];
      if (!c || c.nosort) return;
      th.style.cursor = 'pointer';
      th.title = `Sort by ${c.label}`;
      th.onclick = () => {
        if (key === c.key) down = !down; else { key = c.key; down = true; }
        draw();
      };
    });
    if (onRow) {
      t.querySelectorAll('tbody tr').forEach((tr, i) => {
        tr.style.cursor = 'pointer';
        tr.onclick = (ev) => { if (ev.target.tagName !== 'A') onRow(sorted[i]); };
      });
    }
    host.append(t);
  };
  draw();
  return { redraw: draw };
}

/* ── the shell ──────────────────────────────────────────────────────────── */
export async function renderEconomics(root) {
  const tab = UNIT_TABS.some((t) => t.id === state.param) ? state.param : 'overview';
  root.innerHTML = '';
  root.append(tabBar(UNIT_TABS, tab, (id) => href('unit', id === 'overview' ? null : id)));
  const host = el('div', 'stack'); root.append(host);
  if (tab === 'assets') return assetsTab(host);
  if (tab === 'drivers') return driversTab(host);
  return moneyTab(host);
}

/* The sentence every tab has to carry: money did not exist before February,
   and it is a property of the export rather than of the business. */
function coverageNote(host, cov, windowDays) {
  if (!cov) return;
  const parts = [cov.note];
  if (cov.unpayable_bookings) {
    parts.push(`${countOf(cov.unpayable_bookings, 'booking')} in the window you are looking at `
      + `${plural(cov.unpayable_bookings, 'falls', 'fall')} before that date across `
      + `${countOf(cov.unpayable_days, 'day')}, so they contribute work and `
      + 'no money. Narrow the range to compare like with like.');
  }
  host.append(note(parts.join(' '), cov.unpayable_bookings ? 'warn' : null));
}

/* ── tab: the money ─────────────────────────────────────────────────────── */
async function moneyTab(root) {
  const vuHost = el('div'); root.append(vuHost);
  const covHost = el('div'); root.append(covHost);
  const kpiHost = el('div'); root.append(kpiHost); loading(kpiHost);

  const g1 = el('div', 'grid g23'); root.append(g1);
  const conc = panel('Where the money is concentrated',
    'Vehicles ranked by what they earned, cumulative. A steep start means a few assets carry the '
    + 'fleet; a straight line means every car pulls the same weight. Click for the full ledger.');
  g1.append(conc.panel);
  const chan = panel('What each channel yields per kilometre',
    'Money in over booked distance. Compare a channel with itself over time — not with the one '
    + 'beside it: a payout is net of the platform’s commission and a fare is not.');
  g1.append(chan.panel);

  const g2 = el('div', 'grid g2'); root.append(g2);
  /* ENOUGH OF THE WINDOW TO CARRY A RATE — AND THE WINDOW IS NOT ALWAYS A MONTH.
     ─────────────────────────────────────────────────────────────────────────
     The gate was a flat ten days. That is right for a month and IMPOSSIBLE for
     any window shorter than ten, and this product's DEFAULT window is the
     calendar month — so on the 1st of every month it emptied four of this
     page's eight panels, and again on the 2nd, and every day to the 10th.

     Measured on production on 2026-09-01: 84 vehicles and 94 drivers cleared
     it at days=30, and ZERO at period=month, which is what the page opens on.
     The render audit called it "4 of 8 panels have no data".

     A third of the window, capped at ten and floored at one: a month still
     asks for ten days, a week asks for three, and a one-day window ranks on
     the day itself rather than showing four empty panels. Every caption and
     every empty state below prints the gate it actually used, because "at
     least 10" over a three-day window was a sentence about a different page. */
  const best = panel('Assets earning most per day worked',
    'Enough earning days to carry a rate, so a car that worked once for a good fare does not lead '
    + 'the fleet.');
  g2.append(best.panel);
  const worst = panel('Assets earning least per day worked',
    'The same threshold. These held a driver and produced almost nothing — the row above the ones '
    + 'that produced nothing at all.');
  g2.append(worst.panel);

  const dead = panel('Held, insured, earning nothing',
    'No money in this window, and papers that have not expired — the fleet is paying to keep these '
    + 'road-legal and getting nothing back. This is the closest this database gets to a loss: there '
    + 'is no cost table anywhere in this product, so what these cost cannot be stated, only that '
    + 'they earned nothing.');
  root.append(dead.panel);

  const mapP = panel('Where the fleet is sitting',
    'Every vehicle at its last known fix, coloured by whether it earned in this window. A cluster '
    + 'of idle cars in one place is a yard problem; idle cars scattered are a driver problem.');
  mapP.panel.classList.add('mapwrap');
  root.append(mapP.panel);

  const g3 = el('div', 'grid g2'); root.append(g3);
  const pbest = panel('People earning most per day worked', 'Enough days driven to carry a rate');
  g3.append(pbest.panel);
  const pworst = panel('People earning least per day worked',
    'The same threshold — the shifts are not the problem here, the yield is');
  g3.append(pworst.panel);

  [conc.body, chan.body, best.body, worst.body, dead.body, mapP.body, pbest.body, pworst.body]
    .forEach(loading);

  /* Two requests, and deliberately not a third.
     ─────────────────────────────────────────────────────────────────────
     The map below wants a position per vehicle, and the obvious way to get one
     is /api/live. It is also the slowest answer this product serves — it is
     the one thing here that cannot be cached, because it is different every
     five minutes, and under load production has taken over a minute to return
     it. Asked for here, every figure on the first screen would sit behind that
     poll for a map at the bottom of the page.

     It is not needed. /api/live reads the newest telemetry_snapshot row per
     plate, and the asset ledger already carries exactly that row — the same
     DISTINCT ON, in the same query that produced the table. Drawing the map
     from the ledger costs nothing, removes the slowest request on the page,
     and guarantees the marker and the row it belongs to describe one vehicle
     rather than two answers fetched a minute apart. */
  const [A, D, K] = await Promise.all([
    q('/api/economics/assets'), q('/api/economics/drivers'),
    /* Finance's own figure, fetched rather than recomputed. This page places
       money on vehicles by walking payouts through custody to a plate, and
       /api/kpis sums the same payout rows without that walk — measured on
       production the two differ by about AED 1,450 on Uber and by 4,000 on
       Yango in the other direction. Both are real; presenting either as "the
       fleet's money" without the other was the problem. Comparing against the
       number Finance actually renders means the two cannot drift. */
    q('/api/kpis').catch(() => null),
  ]);
  const t = A.totals, dt = D.totals;

  /* Fields read off /api/economics/drivers on production: totals carries
     people, earning, drove_unpaid, idle, money, payouts, fares, bookings, km,
     worked_days, aed_per_day_worked, aed_per_booking, aed_per_km.

     Unit economics is a page of rates, and a rate is a lie if its denominator
     is wrong. The one that matters here is that "per driver" over the whole
     roster and "per driver who worked" are different numbers, and the gap
     between them is the headline. */
  {
    const people = +dt.people || 0;
    const earning = +dt.earning || 0;
    const idle = +dt.idle || 0;
    const perWorked = +dt.aed_per_day_worked || 0;
    const perHour = +dt.aed_per_measured_hour || 0;
    const onlineH = +dt.measured_hours_online || 0;
    const idleH = +dt.measured_idle_h || 0;
    const covered = +dt.people_with_availability || 0;
    const unpaid = +dt.drove_unpaid || 0;
    const measMoney = dt.measured_money != null ? +dt.measured_money : +dt.money || 0;
    const nothing = Math.max(0, people - earning);
    verdict(vuHost, {
      /* Per ONLINE HOUR where we have measured it, because a day worked can be
         one job or fourteen hours logged in and dividing by it calls those the
         same day. This page used to note that the hourly rate was "the one
         this fleet cannot have" — true while it depended on payout statements
         Uber does not write, and untrue since the availability collector
         landed. It falls back to per day worked where nothing is measured. */
      claim: unpaid
        ? `${countOf(unpaid, 'driver')} drove and ${unpaid === 1 ? 'was' : 'were'} paid nothing`
        : perHour
          ? `${money(perHour)} for every hour a driver was online`
          : perWorked
            ? `${money(perWorked)} per driver-day actually worked`
            : `${fmt(earning)} of ${fmt(people)} drivers earned`,
      figure: perHour ? money(perHour) : perWorked ? money(perWorked) : fmt(earning),
      unit: perHour ? 'per online hour' : perWorked ? 'per day worked' : 'earning',
      tone: unpaid ? 'bad' : (people && idle / people >= 0.4 ? 'warn' : null),
      /* The claim counts a set, so the claim leads to it. "1 driver drove and
         was paid nothing" was the sentence a reader most wanted to click and
         the one thing on the page that went nowhere. */
      cohort: unpaid ? 'unit-drove-unpaid' : idle ? 'unit-earned-nothing' : null,
      meta: `${fmt(dt.worked_days)} driver-days`,
      /* The denominator, stated. Spreading the same money over everybody on the
         books gives a per-driver number roughly half this one, and both are
         "per driver". */
      /* Both halves of the rate name the same people. `idle` is the band that
         never drove; `people - earning` is everyone who earned nothing,
         which is that band plus whoever drove unpaid — the sentence used to
         say "N of those earned nothing" about the people who HAD earned,
         which read as 126 of 122. */
      sub: perHour
        ? `${money(measMoney)} earned over ${fmt(onlineH)} online hours by the `
          + `${countOf(covered, 'driver')} whose availability is measured`
          + `${idleH ? ` — ${fmt(Math.round((idleH / onlineH) * 100))}% of those hours `
            + 'with nobody in the car' : ''}. `
          + `The other ${fmt(people - covered)} on the books have no measured hours, and `
          + `${fmt(nothing)} of the ${fmt(people)} earned nothing at all.`
        : `Over the ${fmt(earning)} people who earned, not the ${fmt(people)} on the books — `
          + `the other ${fmt(nothing)} earned nothing, and spreading the same ${money(dt.money)} `
          + `across all ${fmt(people)} would cut every rate here to `
          + `${fmt(Math.round((earning / (people || 1)) * 100))}% of what it shows.`,
    });
  }

  coverageNote(covHost, A.coverage, A.window_days);

  kpiHost.replaceWith(kpiRow([
    /* Named for how it was PLACED, because #revenue answers the same question
       differently and the two must not both be "money in".
       ─────────────────────────────────────────────────────────────────────
       Measured on the live fleet, same window, same fleet:

         30 days   this page 399,627   the fleet total 382,763   +4%
          7 days   this page 104,824   the fleet total  68,682  +53%
        365 days   this page 2,203,726 the fleet total 2,186,367 +0.8%

       Neither is wrong and neither is a bug. A weekly payout has to be spread
       over days before it can sit on a car, and there are two honest ways to
       do it. driver_payout_day spreads it over the seven CALENDAR days of the
       period, which is what the fleet-wide figure sums. This page spreads it
       over the days the driver actually DROVE, because a week's pay earned
       across three days of custody belongs to those three days — dividing by
       seven and then dropping the four days with no custody record would
       delete more than half of it.

       The two agree over a long window and diverge at a short one, because
       the difference is entirely at the edges: a window that clips a payout
       period counts more of it here than there. That is why the gap is 0.8%
       over a year and 53% over a week.

       So the tile says which one this is, and names the other. */
    /* PLACED, and it says so — this is not the fleet's income. The per-plate
       basis choice can differ from the fleet-level one, so summing the plates
       gives a number a few thousand dirhams away from what Finance reports,
       and until now neither page mentioned the other. The tile names both. */
    { label: 'Money placed on assets', value: money(t.money),
      sub: `${money(t.fares || 0)} in fares · ${money(t.payouts || 0)} of platform payouts placed `
        + `on the days each driver actually drove · over ${fmt(A.window_days)} days`
        + (K?.accounted
          ? ` · against ${money(K.accounted)} on Finance, which counts the same payouts without `
            + 'walking them through custody to a vehicle — this page can only place what it can '
            + `name a car for, and reports ${money(t.unplaced_payouts || 0)} it could not`
          : '') },
    { label: 'Per earning vehicle-day', value: money(t.aed_per_earning_day, 'AED', 0),
      sub: `${fmt(t.earning_vehicle_days)} vehicle-days actually earned` },
    { label: 'Per km', value: money(t.aed_per_km, 'AED', 2),
      sub: `over ${fmt(t.km)} booked km` },
    /* The bookings PLACED ON AN ASSET, which is fewer than the fleet's — a
       booking whose driver held no vehicle that day cannot be attributed to
       one. Audited against production: 12,512 here against 12,526 on every
       other money page, exactly the 14 the fleet reports without a vehicle.
       The gap is legitimate and was invisible, so the tile now names its own
       base rather than letting a reader read it as the fleet's total. */
    { label: 'Per booking', value: money(t.aed_per_booking, 'AED', 2),
      sub: `over ${fmt(t.bookings)} bookings that a vehicle can be named for` },
    { label: 'Assets earning', value: `${fmt(t.earning)} / ${fmt(t.vehicles)}`,
      tone: t.earning === t.vehicles ? 'good'
        : t.vehicles - t.earning > t.vehicles / 4 ? 'critical' : 'warn',
      sub: `${fmt(t.moved_unpaid)} moved without earning · ${fmt(t.still)} never moved`,
      cohort: t.moved_unpaid ? 'unit-moved-unpaid' : t.still ? 'unit-still' : null },
    /* The one tile on this page that is closest to "losing money", and it was
       a number with no way to reach the cars it counted. */
    { label: 'Insured and idle', value: fmt(t.idle_but_documented),
      tone: t.idle_but_documented ? 'critical' : 'good',
      sub: 'earned nothing, papers still current',
      cohort: t.idle_but_documented ? 'unit-idle-documented' : null },
    { label: 'Idle vehicle-days', value: fmt(t.idle_vehicle_days),
      tone: 'warn',
      sub: t.forgone_at_own_rate
        ? `${money(t.forgone_at_own_rate)} at each asset’s own daily rate — unearned, not lost`
        : 'no asset has a daily rate to price them at' },
    t.unplaced_payouts
      ? { label: 'Money we cannot place', value: money(t.unplaced_payouts),
          tone: 'warn',
          sub: `${pct(t.unplaced_pct, 1)} of what the platforms paid — the driver held no vehicle `
            + 'in that period, so it belongs to no car here' }
      : null,
  ]));

  /* Why this total is not the one on #revenue.
     ─────────────────────────────────────────────────────────────────────────
     Both pages answer "what did this fleet take in", both are right, and they
     differ — by 0.8% over a year and by 53% over a week. A reader who notices
     that and finds nothing explaining it has to assume one of the two pages is
     broken, which is a worse outcome than either number. Stated where the
     larger figure is, with the mechanism rather than a hedge. */
  root.append(note('This page places money on ASSETS, so a weekly payout is spread over the days '
    + 'its driver actually drove. Revenue by channel spreads the same payout over the seven '
    + 'calendar days of its period. Both are honest and they agree over a long window; a window '
    + 'that cuts through a payout period counts more of it here than there, which is why the two '
    + 'totals separate as the range gets shorter. Neither figure is the other one rounded.'));

  /* Concentration: one series, so no legend — the title names it. Cumulative
     share against rank, which is a curve and therefore an area rather than
     bars. The reading is in the caption, not in a number on every point. */
  const ranked = A.rows.filter((r) => (r.money ?? 0) > 0);
  if (!ranked.length) {
    empty(conc.body, 'No vehicle earned anything in this range');
  } else {
    let run = 0;
    const curve = ranked.map((r, i) => {
      run += Number(r.money) || 0;
      return { label: String(i + 1), share: Math.round((run / t.money) * 1000) / 10, plate: r.plate };
    });
    const half = curve.findIndex((c) => c.share >= 50) + 1;
    const eighty = curve.findIndex((c) => c.share >= 80) + 1;
    areaChart(conc.body, curve, { x: 'label', y: 'share', max: 100,
      valueFmt: (v) => `${fmt(v, 1)}%`,
      onClick: (d) => { location.hash = href('vehicle', d.plate); } });
    conc.body.append(el('p', 'cap',
      `The top <b>${fmt(half)}</b> of ${fmt(t.vehicles)} vehicles earn half the money; the top `
      + `<b>${fmt(eighty)}</b> earn 80% of it. ${fmt(t.vehicles - ranked.length)} earned nothing `
      + 'at all and are not on this curve. The x axis is rank, not a plate — click a point to '
      + 'open the vehicle sitting there.'));
  }

  /* Per-km yield by channel. One measure across a few named categories, ranked
     — horizontal bars, one hue, because the bar length already carries the
     magnitude and the categories have no order of their own. */
  const yields = (A.by_platform || []).filter((p) => p.aed_per_km != null);
  if (!yields.length) {
    empty(chan.body, 'No channel reports both money and distance in this range');
  } else {
    hbars(chan.body, yields.map((p) => ({ label: sourceLabel(p.platform), n: p.aed_per_km })),
      { color: '--b500', valueFmt: (v) => money(v, 'AED', 2),
        onClick: () => { location.hash = href('revenue'); } });
    /* The basis rides in the channel's own cell rather than in a fifth column.
       It is the caveat that makes the comparison readable, and as a column it
       sat off the right edge of a one-third-width panel — a warning nobody
       scrolls to is a warning nobody reads. */
    chan.body.append(tableFrom(yields, [
      { label: 'Channel', key: 'platform',
        render: (r) => `${esc(sourceLabel(r.platform))}<br>`
          + pill(r.basis === 'fares' || r.basis === 'partial_fares' ? 'gross fare' : 'net payout',
            r.basis === 'fares' ? 'ok' : null)
          + (String(r.basis || '').startsWith('partial') ? ' ' + pill('partial', 'warn') : '') },
      { label: 'Money in', key: 'money', num: true, render: (r) => money(r.money) },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Per km', key: 'aed_per_km', num: true, render: (r) => money(r.aed_per_km, 'AED', 2) },
    ], { compact: true }));
  }

  const rateCols = [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Held by', key: 'current_driver',
      render: (r) => (r.current_driver_id ? entity('driver', r.current_driver_id, r.current_driver)
        : absent('no custody row names a driver for this plate')) },
    { label: 'Money in', key: 'money', num: true, render: (r) => money(r.money) },
    { label: 'Days', key: 'days_earning', num: true, render: (r) => fmt(r.days_earning) },
    { label: 'Per day', key: 'aed_per_earning_day', num: true,
      render: (r) => money(r.aed_per_earning_day, 'AED', 0) },
    { label: 'Per km', key: 'aed_per_km', num: true,
      render: (r) => (r.aed_per_km == null ? absent('no booking on this vehicle carries a distance')
        : money(r.aed_per_km, 'AED', 2)) },
  ];
  /* ENOUGH OF THE WINDOW TO CARRY A RATE — AND THE WINDOW IS NOT ALWAYS A MONTH.
     ─────────────────────────────────────────────────────────────────────────
     The gate was a flat ten days. That is right for a month and IMPOSSIBLE for
     any window shorter than ten — and this product's DEFAULT window is the
     calendar month, so on the 1st of every month it emptied four of this
     page's eight panels, and again on the 2nd, and every day to the 10th.

     Measured on production on 2026-09-01: 84 vehicles and 94 drivers cleared
     it at days=30, and ZERO at period=month, which is what the page opens on.
     bin/render-audit.mjs called it "4 of 8 panels have no data".

     A third of the window, capped at ten and floored at one: a month still
     asks for ten days, a week asks for three, and a one-day window ranks on
     the day itself rather than showing four empty panels. The captions are
     rewritten below rather than written at construction time, because the
     panels are built before the fetch so the skeleton can render — and a
     caption saying "at least 10" over a three-day window describes a
     threshold this page is not applying. */
  const days = A.window_days || 30;
  const gate = Math.max(1, Math.min(10, Math.ceil(days / 3)));
  const nDays = (n, noun) => `${n === 1 ? 'one' : n} ${noun}${n === 1 ? '' : 's'}`;
  const capOf = (el2, text) => { const c = el2.querySelector('p.cap'); if (c) c.textContent = text; };
  const short = gate < 10 ? ` The window is ${fmt(days)} days, so the usual ten would rank nobody.` : '';
  capOf(best.panel, `At least ${nDays(gate, 'earning day')}, so a car that worked once for a good `
    + `fare does not lead the fleet.${short}`);
  capOf(worst.panel, `The same threshold. These held a driver and produced almost nothing — the row `
    + 'above the ones that produced nothing at all.');
  capOf(pbest.panel, `At least ${nDays(gate, 'day')} driven.${short}`);
  capOf(pworst.panel, `At least ${nDays(gate, 'day')} driven — the shifts are not the problem here, `
    + 'the yield is.');

  const rated = A.rows.filter((r) => r.days_earning >= gate && r.aed_per_earning_day != null)
    .sort((a, b) => b.aed_per_earning_day - a.aed_per_earning_day);
  const open = (r) => { location.hash = href('vehicle', r.plate); };
  if (!rated.length) {
    /* Naming the gate it actually used. "ten earning days" over a three-day
       window described a threshold this page was not applying. */
    const why = `No vehicle has ${nDays(gate, 'earning day')} in this range of ${fmt(days)} days`;
    empty(best.body, why);
    empty(worst.body, why);
  } else {
    ledger(best.body, rated.slice(0, 10), rateCols,
      { initial: 'aed_per_earning_day', onRow: open });
    ledger(worst.body, rated.slice(-10).reverse(), rateCols,
      { initial: 'aed_per_earning_day', dir: 'asc', onRow: open });
  }

  /* The dead capital list. Named rather than counted: a count is a statistic
     and a list is a morning's work. */
  const idle = A.rows.filter((r) => !r.money && r.doc_days_left != null && r.doc_days_left >= 0)
    .sort((a, b) => (a.doc_days_left ?? 0) - (b.doc_days_left ?? 0));
  dead.body.innerHTML = '';
  if (!idle.length) {
    empty(dead.body, 'Every vehicle with current papers earned something in this range');
  } else {
    ledger(dead.body, idle, [
      { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Make & model', key: 'model', nosort: true,
        render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
      { label: 'Held by', key: 'current_driver',
        render: (r) => (r.current_driver_id
          ? `${entity('driver', r.current_driver_id, r.current_driver)}`
            + `<span class="dim"> since ${esc(dayStr(r.driver_as_of))}</span>`
          : absent('no custody row names a driver for this plate')) },
      { label: 'Idle days', key: 'idle_days', num: true, render: (r) => fmt(r.idle_days) },
      { label: 'Bookings', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
      { label: 'Journeys seen', key: 'telematics_journeys', num: true,
        render: (r) => (r.telematics_journeys
          ? `<b>${fmt(r.telematics_journeys)}</b>` : fmt(0)) },
      /* THE QUESTION IN FRONT OF THIS LIST IS HOW LONG.
         ─────────────────────────────────────────────────────────────────
         last_trip is bounded by the window, and a vehicle is on this panel
         precisely because it took no booking in the window — so the column was
         empty on every row by construction, pruned itself, and printed one
         sentence in its place: "none of these vehicles has ever taken a
         booking on any channel". That is a claim about all time made from a
         ninety-day query, and it is false for every one of these cars that
         earned in the months before it.

         last_booking_ever is the unfiltered fold. A car that last earned in
         March is a different conversation from one that never has, and this is
         the only column on the panel that can tell them apart. */
      { label: 'Last earned', key: 'last_booking_ever',
        sortValue: (r) => (r.last_booking_ever ? Date.parse(r.last_booking_ever) : null),
        absent: 'no vehicle on this list has ever taken a booking on any channel — every one of '
          + 'them has been held, insured and unused for the whole record',
        render: (r) => {
          if (r.last_trip) return dayStr(r.last_trip);
          if (!r.last_booking_ever) return absent('no booking on this plate in the whole record we hold');
          return `${dayStr(r.last_booking_ever)}<span class="dim" title="before the window above — `
            + `${fmt(r.bookings_ever)} bookings on this plate in the whole record"> `
            + `${fmt(r.days_since_last_booking)}d ago</span>`;
        } },
      { label: 'Papers', key: 'doc_days_left', num: true,
        render: (r) => pill(`${fmt(r.doc_days_left)}d left`,
          r.doc_days_left < 30 ? 'warn' : 'ok') },
      { label: 'State', key: 'band', render: (r) => pill(BAND[r.band].label, BAND[r.band].tone) },
    ], { initial: 'idle_days', onRow: open });
    /* Never-earned and stopped-earning are two different problems with two
       different owners, and a count of "idle vehicles" hides which is which. */
    const never = idle.filter((r) => !r.last_booking_ever).length;
    dead.body.append(el('p', 'cap',
      `${fmt(idle.length)} vehicles. ${never
        ? `${fmt(never)} of them have never taken a booking on any channel; the rest earned before `
          + 'this window and stopped — Last earned says when. '
        : 'Every one of them earned before this window and stopped — Last earned says when. '}`
      + 'The ones with journeys seen but no bookings are the expensive ones: the tracker watched '
      + 'them drive and no channel paid for it.'));
  }

  const pCols = [
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Money in', key: 'money', num: true, render: (r) => money(r.money) },
    { label: 'Days', key: 'days_worked', num: true, render: (r) => fmt(r.days_worked) },
    { label: 'Per day', key: 'aed_per_day_worked', num: true,
      render: (r) => money(r.aed_per_day_worked, 'AED', 0) },
    /* Per hour ONLINE, beside per day worked rather than instead of it: the
       two disagree for a reason worth seeing. Somebody earning well per day
       may be logged in fourteen hours to do it. `absent` prunes the column
       where nothing has been measured, which on a window older than Uber's
       31-day availability retention is every row. */
    { label: 'Per online h', key: 'aed_per_measured_hour', num: true,
      absent: 'availability has not been collected for anyone in this window — Uber serves the '
        + 'last 31 days and nothing older, so this fills in going forward',
      render: (r) => (r.aed_per_measured_hour == null
        ? '<span class="ent-off" title="no availability collected for this driver in this window">—</span>'
        : `${money(r.aed_per_measured_hour, 'AED', 0)}`
          + (r.measured_hours_online
            ? `<span class="dim" title="hours online"> · ${fmt(r.measured_hours_online, 0)}h</span>` : '')) },
    { label: 'Bookings/day', key: 'bookings_per_day', num: true,
      render: (r) => fmt(r.bookings_per_day, 1) },
    { label: 'Per booking', key: 'aed_per_booking', num: true,
      render: (r) => money(r.aed_per_booking, 'AED', 2) },
  ];
  const pRated = D.rows.filter((r) => r.days_worked >= gate && r.aed_per_day_worked != null)
    .sort((a, b) => b.aed_per_day_worked - a.aed_per_day_worked);
  const openP = (r) => { location.hash = href('driver', r.driver_ext_id); };
  if (!pRated.length) {
    const pwhy = `Nobody has ${nDays(gate, 'day')} driven and a payout in this range of ${fmt(days)} days`;
    empty(pbest.body, pwhy);
    empty(pworst.body, pwhy);
  } else {
    ledger(pbest.body, pRated.slice(0, 10), pCols, { initial: 'aed_per_day_worked', onRow: openP });
    ledger(pworst.body, pRated.slice(-10).reverse(), pCols,
      { initial: 'aed_per_day_worked', dir: 'asc', onRow: openP });
    pworst.body.append(el('p', 'cap',
      `${fmt(dt.drove_unpaid)} more people drove in this window with no payout reaching them at `
      + 'all, and are not on either list — see Every driver.'));
  }
  /* The map. Position comes from the live feed, money from the ledger, joined
     on the plate — a vehicle with no fix simply does not appear, and the
     caption says how many that is rather than letting the map imply a smaller
     fleet than there is.

     Drawn from the ledger's own last fix — see above. */
  await assetMap(mapP.body, A.rows);
}

/* One marker per vehicle, at its last fix, coloured by band.
   The fix is the one the ledger already carries, so a car whose tracker went
   quiet in March is drawn where it went quiet — which is the whole point of
   this map, and something a realtime feed cannot tell you. */
async function assetMap(host, rows) {
  host.innerHTML = '';
  const pts = rows.map((r) => {
    const lat = num(r.lat), lng = num(r.lng);
    return lat == null || lng == null ? null : { ...r, lat, lng };
  }).filter(Boolean);
  if (!pts.length) return empty(host, 'No vehicle in this range has a position on record');

  const node = el('div');
  node.style.height = '460px'; node.style.width = '100%';
  const holder = el('div'); holder.style.margin = '0 -18px'; holder.append(node);
  host.append(holder);
  const map = await makeMap(node);
  const layer = L.layerGroup().addTo(map);
  for (const r of pts) {
    const b = BAND[r.band] || BAND.still;
    const m = L.circleMarker([r.lat, r.lng], {
      radius: r.band === 'earning' ? 5 : 7,
      // A 2px surface ring rather than a border, so overlapping markers stay
      // separable without a stroke that reads as another category.
      color: css('--surface'), weight: 2,
      fillColor: css(b.colour), fillOpacity: r.band === 'earning' ? 0.75 : 0.95,
    }).addTo(layer);
    m.bindTooltip(`<b>${esc(r.plate)}</b> — ${esc(b.label)}<br>`
      + `${r.money ? `${money(r.money)} over ${fmt(r.days_earning)} earning days`
        : `${fmt(r.idle_days)} idle days, no money`}<br>`
      + `${r.current_driver ? esc(r.current_driver) : 'nobody on record'}`
      + `<br><span class="dim">last fix ${esc(dayStr(r.last_fix))}`
      + `${r.stale ? ' — the tracker has gone quiet' : ''}</span>`,
    { direction: 'top' });
    m.on('click', () => { location.hash = href('vehicle', r.plate); });
  }
  fitTo(map, pts.map((r) => [r.lat, r.lng]), { maxZoom: 13 });

  const counts = {};
  pts.forEach((r) => { counts[r.band] = (counts[r.band] || 0) + 1; });
  const leg = el('div', 'legend');
  leg.innerHTML = Object.entries(BAND).map(([k, b]) =>
    `<span><i class="sw" style="background:var(${b.colour})"></i>${esc(b.label)} · `
    + `<b class="num">${fmt(counts[k] || 0)}</b></span>`).join('');
  host.append(leg);
  const missing = rows.length - pts.length;
  if (missing > 0) {
    host.append(el('p', 'cap', `${fmt(missing)} of ${fmt(rows.length)} vehicles have no position `
      + 'on record and are not drawn — an absence from this map is not a car that is nowhere.'));
  }
}

/* ── tab: every vehicle ─────────────────────────────────────────────────── */
async function assetsTab(root) {
  const covHost = el('div'); root.append(covHost);
  const bar = el('div', 'toolbar');
  bar.innerHTML = '<input id="ueq" type="search" placeholder="Search by plate, make, model or driver…">'
    + '<span class="chips" id="ueb"></span><span class="cap" id="uen"></span>';
  root.append(bar);
  const sc = panel('Distance against money',
    'One dot per vehicle. The diagonal is the fleet’s rate per kilometre — below it a car is '
    + 'covering ground that is not paying, above it the work is unusually well priced. Click a dot '
    + 'to open the asset.');
  root.append(sc.panel);
  const tblP = panel('Every vehicle', 'Click a column to rank by it. Click a row to open the asset.');
  root.append(tblP.panel);
  [sc.body, tblP.body].forEach(loading);

  const A = await q('/api/economics/assets');
  coverageNote(covHost, A.coverage, A.window_days);
  const t = A.totals;

  root.insertBefore(kpiRow([
    { label: 'Money in', value: money(t.money), sub: `over ${fmt(A.window_days)} days` },
    { label: 'Per earning vehicle-day', value: money(t.aed_per_earning_day, 'AED', 0),
      sub: `${fmt(t.earning_vehicle_days)} earned · ${fmt(t.idle_vehicle_days)} idle` },
    { label: 'Earning', value: fmt(t.earning), tone: 'good', sub: `of ${fmt(t.vehicles)} vehicles` },
    { label: 'Moved, no money', value: fmt(t.moved_unpaid),
      tone: t.moved_unpaid ? 'critical' : 'good', sub: 'the tracker saw it drive',
      cohort: t.moved_unpaid ? 'unit-moved-unpaid' : null },
    { label: 'Never moved', value: fmt(t.still), tone: t.still ? 'warn' : 'good',
      sub: 'no booking and no journey', cohort: t.still ? 'unit-still' : null },
    { label: 'Insured and idle', value: fmt(t.idle_but_documented),
      tone: t.idle_but_documented ? 'critical' : 'good', sub: 'papers current, earned nothing',
      cohort: t.idle_but_documented ? 'unit-idle-documented' : null },
  ]), bar);

  const withKm = A.rows.filter((r) => (r.km ?? 0) > 0 && (r.money ?? 0) > 0);
  if (!withKm.length) empty(sc.body, 'No vehicle has both distance and money in this range');
  else {
    scatter(sc.body, withKm, { x: 'km', y: 'money', label: 'plate',
      xLabel: 'booked km', yLabel: 'money in (AED)',
      onClick: (r) => { location.hash = href('vehicle', r.plate); } });
    sc.body.append(el('p', 'cap',
      `${fmt(withKm.length)} of ${fmt(A.rows.length)} vehicles have both. The fleet averages `
      + `${money(t.aed_per_km, 'AED', 2)} per km; a dot well below that line is doing distance `
      + 'that is not being paid for, which on this fleet usually means a car working a channel '
      + 'that prices nothing per trip while its driver’s payout goes somewhere else.'));
  }

  const cols = [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Fleet', key: 'fleet_id',
      render: (r) => (r.fleet_id ? pill(sourceLabel(r.fleet_id), 'plat')
        : absent('no source names a fleet for this plate')) },
    { label: 'Make & model', key: 'model', nosort: true,
      render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
    { label: 'Held by', key: 'current_driver',
      render: (r) => (r.current_driver_id ? entity('driver', r.current_driver_id, r.current_driver)
        : absent('no custody row names a driver for this plate')) },
    { label: 'Money in', key: 'money', num: true,
      render: (r) => (r.money == null
        ? absent('no fare and no payout reaches this vehicle in this range') : money(r.money)) },
    { label: 'Per day', key: 'aed_per_earning_day', num: true,
      render: (r) => (r.aed_per_earning_day == null
        ? absent('this vehicle earned on no day in this range')
        : money(r.aed_per_earning_day, 'AED', 0)) },
    { label: 'Per km', key: 'aed_per_km', num: true,
      render: (r) => (r.aed_per_km == null
        ? absent('no money, or no booking carrying a distance') : money(r.aed_per_km, 'AED', 2)) },
    { label: 'Per booking', key: 'aed_per_booking', num: true,
      render: (r) => (r.aed_per_booking == null
        ? absent('no booking on this plate in this range') : money(r.aed_per_booking, 'AED', 2)) },
    { label: 'Bookings', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
    { label: 'Km', key: 'km', num: true,
      render: (r) => (r.km == null ? absent('no booking carries a usable distance') : fmt(r.km)) },
    { label: 'Earning days', key: 'days_earning', num: true, render: (r) => fmt(r.days_earning) },
    { label: 'Idle days', key: 'idle_days', num: true, render: (r) => fmt(r.idle_days) },
    { label: 'Alerts /100km', key: 'alerts_per_100km', num: true,
      render: (r) => (r.alerts_per_100km == null ? absent('no distance to measure against')
        : `<span class="${r.alerts_per_100km > 20 ? 'ent-off' : ''}">${fmt(r.alerts_per_100km, 1)}</span>`) },
    { label: 'Papers', key: 'doc_days_left', num: true,
      render: (r) => (r.doc_days_left == null ? absent('no document with an expiry date on file')
        : pill(r.doc_days_left < 0 ? 'expired' : `${fmt(r.doc_days_left)}d`,
          r.doc_days_left < 0 ? 'bad' : r.doc_days_left < 30 ? 'warn' : 'ok')) },
    { label: 'State', key: 'band', render: (r) => pill(BAND[r.band].label, BAND[r.band].tone) },
  ];

  let band = '';
  let text = '';
  const list = () => A.rows.filter((r) => (!band || r.band === band)
    && (!text || `${r.plate} ${r.make} ${r.model} ${r.current_driver}`.toLowerCase().includes(text)));
  const draw = () => {
    const rows = list();
    bar.querySelector('#uen').textContent = `${rows.length} of ${A.rows.length} vehicles`;
    tblP.body.innerHTML = '';
    if (!rows.length) return empty(tblP.body, 'No vehicle matches this filter');
    ledger(tblP.body, rows, cols, { initial: 'money',
      onRow: (r) => { location.hash = href('vehicle', r.plate); } });
    return null;
  };
  const chips = bar.querySelector('#ueb');
  const bands = [['', 'All', A.rows.length],
    ...Object.entries(BAND).map(([k, b]) => [k, b.label, A.rows.filter((r) => r.band === k).length])];
  chips.innerHTML = bands.map(([k, label, n]) =>
    `<button class="chip" data-b="${k}">${esc(label)} ${fmt(n)}</button>`).join('');
  chips.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      band = btn.dataset.b;
      chips.querySelectorAll('button').forEach((x) => x.classList.toggle('warn', x === btn && !!band));
      draw();
    };
  });
  bar.querySelector('#ueq').oninput = (e) => { text = e.target.value.trim().toLowerCase(); draw(); };
  draw();
}

/* ── tab: every driver ──────────────────────────────────────────────────── */
async function driversTab(root) {
  const covHost = el('div'); root.append(covHost);
  const bar = el('div', 'toolbar');
  bar.innerHTML = '<input id="udq" type="search" placeholder="Search by name…">'
    + '<span class="chips" id="udb"></span><span class="cap" id="udn"></span>';
  root.append(bar);
  const tblP = panel('Every driver', 'Click a column to rank by it. Click a row to open the person.');
  root.append(tblP.panel);
  loading(tblP.body);

  const D = await q('/api/economics/drivers');
  coverageNote(covHost, D.coverage, D.window_days);
  const t = D.totals;

  root.insertBefore(kpiRow([
    { label: 'Money to drivers', value: money(t.money),
      sub: `${money(t.payouts || 0)} in payouts · ${money(t.fares || 0)} in fares they collected` },
    { label: 'Per day worked', value: money(t.aed_per_day_worked, 'AED', 0),
      sub: `${fmt(t.worked_days)} person-days` },
    { label: 'Per booking', value: money(t.aed_per_booking, 'AED', 2),
      sub: `over ${fmt(t.bookings)} bookings` },
    /* 247, where #drivers says 361 and #roster says 280 — three different
       populations, and this one never said which it was. It is everyone who
       drove OR was paid inside the window, which is the only population the
       money on this page can be divided by. */
    { label: 'Earning', value: fmt(t.earning), tone: 'good',
      sub: `of ${fmt(t.people)} who drove or were paid in this window` },
    { label: 'Drove, no money', value: fmt(t.drove_unpaid),
      tone: t.drove_unpaid ? 'critical' : 'good',
      sub: 'took bookings, no payout statement reaches them',
      cohort: t.drove_unpaid ? 'unit-drove-unpaid' : null },
    { label: 'Earned nothing', value: fmt(t.idle),
      tone: t.idle ? 'warn' : 'good',
      sub: 'on the books, no booking and no payout',
      cohort: t.idle ? 'unit-earned-nothing' : null },
    /* The rate, not a dash. This tile has rendered a hardcoded em-dash under a
       sub-line explaining WHY the number is missing, while the number sat in
       the same response object the sub-line came from: production returns
       aed_per_measured_hour 16.93 over the month and 71.22 over the record.
       The overview verdict a few hundred lines up has been rendering the same
       field correctly the whole time.

       Still a dash when nothing is measured, because Uber sends no online
       hours and a fleet with none of the other channels genuinely has no
       hourly rate — and AED 0 per hour is a different claim from "nobody
       reported an hour". */
    { label: 'Per hour online',
      value: t.aed_per_measured_hour != null ? money(t.aed_per_measured_hour) : '—',
      sub: t.hours_note },
  ]), bar);

  const cols = [
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('driver', r.driver_ext_id, r.driver_name)
        + (r.accounts > 1 ? ` <span class="dim">${r.accounts} accounts</span>` : '') },
    { label: 'Channels', key: 'platforms', nosort: true,
      render: (r) => (r.platforms.length ? r.platforms.map((p) => pill(sourceLabel(p), 'plat')).join(' ')
        : absent('no platform record for this person in this range')) },
    { label: 'Money in', key: 'money', num: true,
      render: (r) => (r.money == null
        ? absent('no payout statement and no priced booking reaches this person')
        : money(r.money)) },
    { label: 'Per day worked', key: 'aed_per_day_worked', num: true,
      render: (r) => (r.aed_per_day_worked == null
        ? absent('no money, or no day driven in this range')
        : money(r.aed_per_day_worked, 'AED', 0)) },
    { label: 'Per booking', key: 'aed_per_booking', num: true,
      render: (r) => (r.aed_per_booking == null ? absent('no booking in this range')
        : money(r.aed_per_booking, 'AED', 2)) },
    { label: 'Per km', key: 'aed_per_km', num: true,
      render: (r) => (r.aed_per_km == null ? absent('no booking carrying a usable distance')
        : money(r.aed_per_km, 'AED', 2)) },
    { label: 'Days', key: 'days_worked', num: true, render: (r) => fmt(r.days_worked) },
    { label: 'Bookings', key: 'bookings', num: true, render: (r) => fmt(r.bookings) },
    { label: 'Bookings/day', key: 'bookings_per_day', num: true,
      render: (r) => (r.bookings_per_day == null ? absent('no day driven in this range')
        : fmt(r.bookings_per_day, 1)) },
    { label: 'Completion', key: 'completion_pct', num: true,
      render: (r) => (r.completion_pct == null
        ? absent('no booking on this person carries an outcome') : pct(r.completion_pct, 0)) },
    /* The cars, named and openable. A ledger that says a person earned nothing
       and cannot say which asset they were holding while doing it sends the
       reader back to the vehicle list to work it out. */
    { label: 'Cars held', key: 'vehicles', num: true,
      sortVal: (r) => r.vehicles,
      render: (r) => ((r.plates || []).length
        ? (r.plates || []).map((x) => entity('vehicle', x.plate, x.plate)).join(' ')
          + (r.vehicles > r.plates.length
            ? `<span class="dim"> +${fmt(r.vehicles - r.plates.length)}</span>` : '')
        : absent('no custody row places this person in a vehicle in this range')) },
    { label: 'Alerts /100km', key: 'alerts_per_100km', num: true,
      render: (r) => (r.alerts_per_100km == null ? absent('no distance to measure against')
        : fmt(r.alerts_per_100km, 1)) },
    { label: 'Licence', key: 'licence_days_left', num: true,
      absent: 'most of these people have no licence expiry on file — the compliance record comes '
        + 'from the channel that onboarded them, and the channels report it for a minority',
      render: (r) => (r.licence_days_left == null ? absent('no licence expiry on file')
        : pill(r.licence_days_left < 0 ? 'expired' : `${fmt(r.licence_days_left)}d`,
          r.licence_days_left < 0 ? 'bad' : r.licence_days_left < 30 ? 'warn' : 'ok')) },
    { label: 'State', key: 'band', render: (r) => pill(PBAND[r.band].label, PBAND[r.band].tone) },
  ];

  let band = '';
  let text = '';
  const list = () => D.rows.filter((r) => (!band || r.band === band)
    && (!text || String(r.driver_name).toLowerCase().includes(text)));
  const draw = () => {
    const rows = list();
    bar.querySelector('#udn').textContent = `${rows.length} of ${D.rows.length} people`;
    tblP.body.innerHTML = '';
    if (!rows.length) return empty(tblP.body, 'Nobody matches this filter');
    ledger(tblP.body, rows, cols, { initial: 'money',
      onRow: (r) => { location.hash = href('driver', r.driver_ext_id); } });
    return null;
  };
  const chips = bar.querySelector('#udb');
  const bands = [['', 'All', D.rows.length],
    ...Object.entries(PBAND).map(([k, b]) => [k, b.label, D.rows.filter((r) => r.band === k).length])];
  chips.innerHTML = bands.map(([k, label, n]) =>
    `<button class="chip" data-b="${k}">${esc(label)} ${fmt(n)}</button>`).join('');
  chips.querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      band = btn.dataset.b;
      chips.querySelectorAll('button').forEach((x) => x.classList.toggle('warn', x === btn && !!band));
      draw();
    };
  });
  bar.querySelector('#udq').oninput = (e) => { text = e.target.value.trim().toLowerCase(); draw(); };
  draw();
}
