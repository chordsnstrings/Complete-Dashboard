/* Who did well last week, who did not, and what the difference looks like.
   ─────────────────────────────────────────────────────────────────────────
     #top-performers      the people the week went well for
     #low-performers      the people it did not
     #performer/<id>      one person's week, day by day

   Both lists rank the same population by the same metric in opposite
   directions, and the interesting part of either page is the drill-down.

   FIVE THINGS THIS PAGE REFUSES TO DO, each of which it would otherwise do
   wrongly:

   1. IT DOES NOT RANK ON A BLENDED TOTAL. api/income_sql.js picks a basis per
      channel: the hotel channel reports a fare, which is gross — what the
      property was charged. Uber reports a payout, which is net of commission
      and of the cash the driver already pocketed. Adding them and sorting puts
      a hotel driver above an Uber driver who earned more, and the page would
      have no way to show it. The money column names its parts.

   2. IT DOES NOT RANK A PARTIAL WEEK. The window is the last COMPLETE Monday
      to Sunday, because ranking people on a day that is four hours old rewards
      whoever starts early.

   3. IT DOES NOT CALL A LOW EARNER A BAD DRIVER. The data cannot tell a
      person who worked and earned little from one who was on leave, whose car
      was off the road, or whose licence had lapsed — so the row carries days
      worked, standing, and licence state beside the money, and the page says
      in words what it cannot distinguish.

   4. IT DOES NOT RANK ON A RATE WITHOUT EXPOSURE. One good day is not a good
      week. Below the threshold a rate is noise, and those people are listed
      separately rather than sorted among the rest.

   5. IT DOES NOT CALL AN ON-TRIP HOUR AN ONLINE HOUR. Uber reports no online
      hours at all — 232 of 241 people have none — so what is shown is time
      carrying someone, measured from the trips, and it is labelled that. */
import { hbars } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity, money,
  fmt, empty, noneChosen, sourceLabel, dateStr, verdict, countOf } from './ui.js';
import { q, href, state } from './data.js';

/* Enough of a week to rank on. Two thirds of a working week: below it a
   per-day rate is one or two shifts wearing a week's clothing. */
const MIN_DAYS = 4;
const MIN_BOOKINGS = 15;

const eligible = (r) => (r.days_worked || 0) >= MIN_DAYS && (r.bookings || 0) >= MIN_BOOKINGS;

/* The week rides in the address — `#top-performers/<monday>` and
   `#performer/<id>/<monday>` — so a ranking of March can be linked, opened in
   a tab, and drilled into without snapping back to the current week. Only a
   MONDAY is honoured: the server treats whatever it is given as a week start,
   so a hand-typed Wednesday would rank a seven-day window aligned to nothing
   while every caption on the page still said "Monday to Sunday". */
const isWeek = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '')
  && new Date(`${v}T12:00:00Z`).getUTCDay() === 1;

/* THE MEASURE HAS TO EXIST IN THE WEEK.
   ─────────────────────────────────────────────────────────────────────────
   The rate is money per day worked. Uber publishes no per-trip fare, so on
   this fleet the money IS the weekly payout statement — and the statements
   held reach back only into early 2026. For every week before them `money` is
   null on every row, the rate is 0 for everybody, and a sort by it leaves the
   array exactly as the endpoint returned it: alphabetical. Making the older
   weeks reachable turned that into a page: "Aamir Khan Amin earned most per
   day worked — AED 0", with a hundred and ten people under him all on AED 0,
   in alphabetical order, under a heading that called it a ranking.

   An alphabetical list in a leaderboard's clothes is worse than no page. So
   the basis is chosen FROM THE WEEK — money where the week has money, work
   where it does not — and the swap is said out loud on the headline, the
   tiles, the column and the caption, because a page that quietly changes what
   it measures is the same failure wearing a different suit. */
const MONEY_BASIS = {
  money: true,
  of: (r) => (r.days_worked ? (r.money || 0) / r.days_worked : null),
  fmt: (v) => money(v),
  unit: 'per day worked',
  verb: (top) => (top ? 'earned most' : 'earned least'),
  tile: (top) => (top ? 'Best per day' : 'Lowest per day'),
  column: 'Per day',
  caption: 'Money in per day worked',
  why: null,
};
const WORK_BASIS = {
  money: false,
  of: (r) => (r.days_worked ? (r.bookings || 0) / r.days_worked : null),
  fmt: (v) => (v == null ? '—' : fmt(v, 1)),
  unit: 'bookings per day worked',
  verb: (top) => (top ? 'drove most' : 'drove least'),
  tile: (top) => (top ? 'Most a day' : 'Fewest a day'),
  column: 'Bookings a day',
  caption: 'Bookings per day worked',
  why: 'No channel reported money for this week, so nobody can be ranked on it. Uber publishes '
    + 'no per-trip fare and the payout statements this fleet holds do not reach back this far — '
    + 'so the ranking below is on WORK DONE, bookings per day worked, and the money columns are '
    + 'absent rather than zero.',
};
const NO_MONEY = 'no channel reported money for this week — Uber publishes no per-trip fare, and '
  + 'the payout statements this fleet holds do not reach back to it';

function whyNotRanked(r) {
  if (!r.days_worked) return 'did not drive';
  if ((r.days_worked || 0) < MIN_DAYS) return `${r.days_worked}d worked`;
  if ((r.bookings || 0) < MIN_BOOKINGS) return `${r.bookings} bookings`;
  return null;
}

export async function renderPerformers(root, band) {
  const top = band === 'top';
  /* The week note and the verdict beneath it are two sections, not one block —
     see .stack in app.css. Without it they touched. */
  const head = el('div', 'stack'); root.append(head);
  const kh = el('div', 'kpis'); root.append(kh);
  const listP = panel(top ? 'Ranked highest' : 'Ranked lowest',
    `Money in per day worked, over the last complete week. At least ${MIN_DAYS} days `
    + `and ${MIN_BOOKINGS} bookings — click any row for the week in detail.`);
  root.append(listP.panel);
  const shapeP = panel('What the two ends look like',
    'The same measures for the ranked group, best and worst, side by side');
  root.append(shapeP.panel);
  const outP = panel('Not ranked', 'Too little of the week to carry a rate — listed, not sorted');
  root.append(outP.panel);
  [kh, listP.body, shapeP.body, outP.body].forEach(loading);

  const weeks = await q('/api/performer/weeks').catch(() => ({ weeks: [] }));
  /* `state.week` — which is what this read for months — is not a field of
     `state`. It was always undefined, so every visit fell to the newest week
     and the list of weeks fetched on the line above was fetched and thrown
     away: no control offered them, no address named one, and the endpoint's
     whole purpose went unused. The week now comes off the hash. */
  const wk = (isWeek(state.param) ? state.param : null) || weeks.latest_complete;
  const d = await q('/api/economics/drivers', wk ? { from: wk, to: weekEnd(wk) } : {});
  const rows = (d.rows || []).filter((r) => (r.days_worked || 0) > 0);

  head.innerHTML = '';
  /* An asked-for week that the endpoint does not list is still shown, and still
     listed, rather than quietly swapped for the newest one — a page that ranks
     one week under a heading naming another is the failure this control exists
     to prevent. It will simply be empty, which is the truth about it. */
  const offered = (weeks.weeks || []).map((w) => w.week);
  const list = wk && !offered.includes(wk) ? [wk, ...offered] : offered;
  if (list.length > 1) {
    const pick = el('div', 'note');
    pick.append(el('span', 'cap', 'Week&nbsp;'));
    const sel = el('select', 'btn');
    sel.innerHTML = list.map((w) => `<option value="${esc(w)}"${w === wk ? ' selected' : ''}>`
      + `${esc(dateStr(w))} – ${esc(dateStr(weekEnd(w)))}</option>`).join('');
    sel.onchange = () => { location.hash = href(top ? 'top-performers' : 'low-performers', sel.value); };
    pick.append(sel);
    if (weeks.first_booking) {
      pick.append(el('span', 'cap',
        `&nbsp; every complete week back to ${esc(dateStr(weeks.first_booking))}, `
        + 'the first booking on record'));
    }
    head.append(pick);
  }
  const wkNote = el('div', 'note info');
  /* The only two dates on this page, and they were the raw ISO strings the
     endpoint returns — "2026-08-17 to 2026-08-23" — in a product that writes
     "Aug 17, 2026" in every date column on every other page. */
  wkNote.innerHTML = `The week of <b>${esc(wk ? dateStr(wk) : '—')}</b> to `
    + `<b>${esc(weekEnd(wk) ? dateStr(weekEnd(wk)) : '—')}</b>, `
    + 'Dubai days, the last one that finished. A part-finished week ranks whoever started earliest.';
  head.append(wkNote);

  /* Chosen from the rows, not from the date: a week with money ranks on money
     whatever its age, and a recent week that somehow arrived without any would
     be caught by the same branch. */
  const basis = rows.some((r) => (r.money || 0) > 0) ? MONEY_BASIS : WORK_BASIS;
  const rate = basis.of;
  if (basis.why) head.append(note(basis.why, 'warn'));
  /* The caption was written before the fetch, when the measure was not yet
     known. It names the measure, so it is corrected here rather than left
     describing a ranking the page is not showing. */
  const cap = listP.panel.querySelector('p.cap');
  if (cap) {
    cap.textContent = `${basis.caption}, over the week above. At least ${MIN_DAYS} days `
      + `and ${MIN_BOOKINGS} bookings — click any row for the week in detail.`;
  }

  const ranked = rows.filter(eligible).filter((r) => rate(r) != null);
  ranked.sort((a, b) => (top ? rate(b) - rate(a) : rate(a) - rate(b)));
  const rest = rows.filter((r) => !eligible(r) || rate(r) == null);

  /* A ranking page's honest headline is the SPREAD, not the winner: "who did
     best" is the list itself, and the question an operator has is whether the
     gap between the ends is worth acting on. Stated with how many people are
     not ranked at all, because a leaderboard over a third of the roster is a
     different object from one over all of it. */
  {
    /* `ranked` is already sorted FOR THIS PAGE — descending on Top, ascending
       on Low — so position 0 is always the person the page is about. Written
       as `top ? ranked[0] : ranked.at(-1)` first, which on the Low page is the
       far end of an ascending list: the best earner in the fleet, labelled
       "earned least". Both pages named the same man, one calling him the most
       and the other the least, and each sentence was individually plausible. */
    const led = ranked[0];
    const other = ranked[ranked.length - 1];
    const lR = led ? rate(led) : null;
    const oR = other ? rate(other) : null;
    const base = Math.min(Math.abs(lR ?? 0), Math.abs(oR ?? 0));
    const spread = lR != null && oR != null && base
      ? Math.round((Math.abs(lR - oR) / base) * 100) : null;
    verdict(head, {
      claim: led
        ? `${led.driver_name || 'Somebody'} ${basis.verb(top)} per day worked`
        : 'Nobody worked enough of this week to rank',
      figure: led ? basis.fmt(rate(led)) : '—',
      unit: basis.unit,
      tone: null,
      meta: `${fmt(ranked.length)} ranked`,
      sub: (spread != null
        ? `The two ends of the ranking are ${spread}% apart. `
        : '')
        + (rest.length
          ? `${countOf(rest.length, 'person', 'people')} are not ranked at all — too little of the `
            + 'week to carry a rate, and a rate over one day is not a rate.'
          : 'Everybody who worked is ranked.'),
    });
  }

  const t = d.totals || {};
  kh.replaceWith(kpiRow([
    { label: 'People ranked', value: fmt(ranked.length),
      sub: `of ${fmt(rows.length)} who drove — the rest did too little of the week` },
    { label: basis.tile(top),
      value: ranked.length ? basis.fmt(rate(ranked[0])) : '—',
      sub: ranked.length ? esc(ranked[0].driver_name) : 'nobody cleared the threshold' },
    /* AED 0 is a claim about the week; "—" with the reason is the truth about
       it. The fleet rate came through as a zero on every week before the
       statements, and a tile reading AED 0 beside a hundred working drivers is
       read as a bad week rather than as an absent feed. */
    { label: 'Fleet per day worked',
      value: basis.money ? money(t.aed_per_day_worked) : '—',
      sub: basis.money ? 'every person, every day anyone drove' : NO_MONEY },
    /* Same trap as the two-ends table below: first-over-last is a magnitude on
       the page sorted highest-first and a fraction on the page sorted
       lowest-first, where AED 361 against AED 13 was rounded to "0x". */
    { label: 'Spread', value: (() => {
      if (ranked.length < 2) return '—';
      const a = rate(ranked[0]) || 0;
      const b = rate(ranked[ranked.length - 1]) || 0;
      const hi = Math.max(a, b);
      const lo = Math.min(a, b);
      return lo > 0 ? `${Math.round((hi / lo) * 10) / 10}×` : '—';
    })(),
      sub: 'between the best and the worst of the ranked' },
  ]));

  listP.body.innerHTML = '';
  if (!ranked.length) {
    empty(listP.body, `Nobody worked enough of this week to be ranked. The gate is ${MIN_DAYS} days and ${MIN_BOOKINGS} bookings.`);
  } else {
    listP.body.append(tableFrom(ranked.slice(0, 40).map((r, i) => ({ ...r, rank: i + 1 })), [
      /* tableFrom's render takes the ROW only — no index. The rank is stamped
         onto the row before it gets here, which is also what makes it survive
         a column sort: the number means position in THIS ranking, not the
         order the browser happens to be showing.

         It rides inside the name rather than leading in a column of its own.
         This table is thirteen columns wide and scrolls on every screen
         narrower than a laptop; the first column is the one that stays pinned,
         and pinning the rank froze 1, 2, 3 on screen while the person each row
         is about scrolled out of sight. */
      { label: 'Driver', key: 'driver_name',
        render: (r) => `<span class="rk">${r.rank}</span>`
          + entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Fleet', key: 'fleet_id', render: (r) => (r.fleet_id ? pill(sourceLabel(r.fleet_id)) : '—') },
      { label: 'Platforms', key: 'platforms',
        render: (r) => (r.platforms || []).map((x) => pill(sourceLabel(x))).join(' ') || '—' },
      { label: basis.column, key: '_rate', num: true, render: (r) => basis.fmt(rate(r)) },
      /* `absent` rather than a column of dashes: on a week the statements do
         not reach, every money cell is empty and the reader is owed the reason
         once, above the table, instead of eleven rows of "—". */
      { label: 'Money in', key: 'money', num: true, absent: NO_MONEY,
        render: (r) => (r.money == null ? '—'
          : `${money(r.money)}<span class="dim" title="payout where the channel pays one, fare where it prices the trip"> ${
            r.payouts && r.fares ? 'both' : r.payouts ? 'payout' : 'fare'}</span>`) },
      { label: 'Days', key: 'days_worked', num: true },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Per booking', key: 'aed_per_booking', num: true, absent: NO_MONEY,
        render: (r) => money(r.aed_per_booking) },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Completed', key: 'completion_pct', num: true,
        render: (r) => (r.completion_pct == null ? '—' : `${fmt(r.completion_pct)}%`) },
      { label: 'Standing', key: 'state',
        absent: 'no channel published a standing for these people — the roster snapshot carries '
          + 'one only for accounts a provider has judged',
        render: (r) => (r.state ? pill(r.state, r.can_earn === false ? 'warn' : null) : '—') },
    ], {
      /* The week travels with the click. Without it a reader who picked March,
         read the ranking and opened somebody in it landed on that person's
         CURRENT week — often "No booking in this week" for a man they were
         looking at a moment earlier. */
      onRow: (r) => { location.hash = href('performer', r.driver_ext_id, wk || null); },
    }));
    /* A table that ends on exactly forty rows is a table somebody cut, and
       nothing on the page said so — the reader had no way to tell "these are
       the ranked drivers" from "these are the first forty of them". */
    listP.body.append(el('p', 'cap', esc(ranked.length > 40
      ? `Showing the top 40 of ${fmt(ranked.length)} ranked drivers.`
      : `All ${fmt(ranked.length)} ranked drivers.`)));
  }

  shapeP.body.innerHTML = '';
  if (ranked.length > 3) {
    const n = Math.min(5, Math.floor(ranked.length / 2));
    /* Sorted here rather than sliced off the ends of `ranked`, because
       `ranked` runs highest-first on #performer and LOWEST-first on
       #low-performers. Taking slice(0, n) as "best" was right on one page and
       exactly backwards on the other: the low page headed its worst five
       "Top 5", its best five "Bottom 5", and printed a ratio of 0.1x. */
    const byRate = [...ranked].sort((a, b) => (rate(b) || 0) - (rate(a) || 0));
    const best = byRate.slice(0, n);
    const worst = byRate.slice(-n);
    const avg = (list, f) => list.reduce((a, x) => a + (f(x) || 0), 0) / list.length;
    /* On a week with no money the first two rows would be the same measure
       twice and the third a column of dashes, so the money rows are dropped
       rather than printed empty — the note above the ranking has already said
       why they are not there. */
    const cmp = [
      ...(basis.money ? [['Per day worked', avg(best, rate), avg(worst, rate), money]] : []),
      ['Bookings a day', avg(best, (x) => x.bookings_per_day), avg(worst, (x) => x.bookings_per_day), (v) => fmt(v, 1)],
      ...(basis.money ? [['Per booking', avg(best, (x) => x.aed_per_booking), avg(worst, (x) => x.aed_per_booking), money]] : []),
      ['Km a day', avg(best, (x) => (x.km || 0) / (x.days_worked || 1)), avg(worst, (x) => (x.km || 0) / (x.days_worked || 1)), (v) => `${fmt(v)} km`],
      ['Days worked', avg(best, (x) => x.days_worked), avg(worst, (x) => x.days_worked), (v) => fmt(v, 1)],
      ['Completed', avg(best, (x) => x.completion_pct), avg(worst, (x) => x.completion_pct), (v) => `${fmt(v)}%`],
    ];
    shapeP.body.append(tableFrom(cmp.map(([m, a, b, f]) => ({
      measure: m, best: f(a), worst: f(b),
      gap: b ? `${Math.round((a / b) * 10) / 10}×` : '—',
    })), [
      { label: 'Measure', key: 'measure' },
      { label: `Top ${n}`, key: 'best', num: true },
      { label: `Bottom ${n}`, key: 'worst', num: true },
      { label: 'Ratio', key: 'gap', num: true },
    ]));
    shapeP.body.append(el('p', 'cap',
      'Read down the ratio column: where it is near 1 the two ends do the same thing, and '
      + 'wherever it is not is where the difference actually lives.'));
  } else empty(shapeP.body, 'Too few ranked people to compare the two ends.');

  outP.body.innerHTML = '';
  if (!rest.length) empty(outP.body, 'Everyone who drove cleared the threshold.');
  else {
    outP.body.append(tableFrom(rest.slice(0, 40).map((r) => ({ ...r, why: whyNotRanked(r) })), [
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      { label: 'Days', key: 'days_worked', num: true },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Money in', key: 'money', num: true, absent: NO_MONEY,
        render: (r) => money(r.money) },
      { label: 'Why not ranked', key: 'why' },
    ]));
    if (rest.length > 40) {
      outP.body.append(el('p', 'cap', esc(
        `Showing 40 of ${fmt(rest.length)} people who drove but did not clear the threshold.`)));
    }
  }

  if (!top) {
    root.append(note(
      `This page ranks ${basis.unit} against days worked. It cannot tell a person who worked and `
      + 'did little from one who was on leave, whose vehicle was off the road, or whose '
      + 'licence had lapsed — the standing and days columns are there for exactly that, and '
      + 'they should be read before anyone is spoken to.', 'warn'));
  }
  const cov = d.coverage;
  if (cov && cov.note) root.append(el('p', 'cap', esc(cov.note)));
  if (t.hours_note) root.append(el('p', 'cap', esc(t.hours_note)));
}

/* Anchored at NOON, not midnight. Adding six days to a midnight and reading
   the UTC date back is one boundary away from returning the wrong day; from
   noon, no offset any calendar uses can cross either midnight. test/timezone
   .test.mjs enforces exactly this and caught the midnight version. */
const weekEnd = (mon) => {
  if (!mon) return null;
  const d = new Date(`${mon}T12:00:00Z`);
  return new Date(d.getTime() + 6 * 864e5).toISOString().slice(0, 10);
};

export { weekEnd, isWeek, MIN_DAYS, MIN_BOOKINGS };

/* One person's week. This is the page the two lists exist to reach: a rank is
   a claim, and this is the evidence for it.

   The three clocks are kept apart on purpose. ON TRIP is measured, from
   request to dropoff, over the bookings that carry an end time. ELAPSED is
   first request to last dropoff and contains every gap — it is not a shift and
   is never called one. ONLINE is what Uber does not report, and where a
   platform status happens to exist it is shown as observations, not hours. */
export async function renderPerformer(root, id, week) {
  /* Addressed with no id — a typed URL, a stale bookmark, a link whose id
     never got filled in. It went to the endpoint and printed the API's own
     complaint. #day has always answered this properly; these four did not. */
  if (!id) return noneChosen(root, 'person', 'drivers', 'Every driver');
  const kh = el('div', 'kpis'); root.append(kh);
  /* Full width. Ten columns of a day — including the two waiting columns —
     do not fit in 2fr of a 2:1 split, and the ones pushed off the edge were
     the vehicle and the longest gap: exactly the columns that explain a day
     that went badly. */
  const dayP = panel('The week, day by day',
    'Bookings, distance, time carrying someone and time waiting — one row per Dubai day');
  root.append(dayP.panel);
  const g = el('div', 'grid g2'); root.append(g);
  const platP = panel('Where the work came from', 'Per channel, with what each one reports');
  g.append(platP.panel);
  const areaP = panel('Where they picked up',
    'Areas parsed from the address text each channel returns — a grouping, not a coordinate');
  g.append(areaP.panel);
  const statusP = panel('What the platform said',
    'Uber driver status, polled every five minutes — present only where the fleet has it');
  root.append(statusP.panel);
  [kh, dayP.body, platP.body, areaP.body, statusP.body].forEach(loading);

  const p = await q('/api/performer', isWeek(week) ? { id, week } : { id });
  const days = p.days || [];
  const onTrip = p.on_trip_min || 0;
  const elapsed = days.reduce((a, d) => a + (d.elapsed_min || 0), 0);

  kh.replaceWith(kpiRow([
    /* The week the SERVER answered for, not the one this page asked for: the
       two differ the moment a hand-typed address names a week the endpoint
       declines, and the tile must name the days actually counted below it.
       The raw ISO string was the sub-line here — "week of 2026-08-24" — in a
       product that writes "Aug 24, 2026" in every date column it owns. */
    { label: 'Days worked', value: fmt(days.length),
      sub: (p.week || [])[0]
        ? `week of ${esc(dateStr(p.week[0]))} to ${esc(dateStr(p.week[1] || weekEnd(p.week[0])))}`
        : 'week unknown' },
    { label: 'Bookings', value: fmt(p.bookings), sub: `${fmt(days.reduce((a, d) => a + (d.completed || 0), 0))} completed` },
    { label: 'Carrying someone', value: onTrip ? `${fmt(onTrip / 60, 1)} h` : '—',
      sub: p.duration_coverage_pct != null
        ? `measured over ${p.duration_coverage_pct}% of bookings that report an end`
        : 'no booking reports an end time' },
    { label: 'Of time on the road', value: elapsed ? `${Math.round((onTrip / elapsed) * 100)}%` : '—',
      sub: 'on-trip against first request to last dropoff — the rest is waiting or repositioning' },
    { label: 'Waiting between jobs', value: p.wait_min ? `${fmt(p.wait_min / 60, 1)} h` : '—',
      sub: elapsed && p.wait_min
        ? `${Math.round((p.wait_min / elapsed) * 100)}% of the road time, summed gap by gap`
        : 'measured from each dropoff to the next request' },
  ]));

  dayP.body.innerHTML = '';
  if (!days.length) {
    /* Which week, in words. "No booking in this week" over a page whose only
       other mention of the week is a KPI sub-line reads as "this person does
       not drive" — and the reader who arrived from a ranking of March has no
       way to tell that from a week they did not mean to ask for. */
    empty(dayP.body, (p.week || [])[0]
      ? `No booking in the week of ${dateStr(p.week[0])} to ${dateStr(p.week[1] || weekEnd(p.week[0]))}.`
      : 'No booking in this week.');
  } else {
    dayP.body.append(tableFrom(days, [
      { label: 'Day', key: 'day', render: (r) => String(r.day).slice(0, 10) },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Cancelled', key: 'cancelled', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'First', key: 'first_trip', render: (r) => hhmm(r.first_trip) },
      { label: 'Last', key: 'last_trip', render: (r) => hhmm(r.last_trip) },
      { label: 'On trip', key: 'on_trip_min', num: true,
        render: (r) => (r.on_trip_min ? `${fmt(r.on_trip_min / 60, 1)} h` : '—') },
      { label: 'Elapsed', key: 'elapsed_min', num: true,
        render: (r) => (r.elapsed_min ? `${fmt(r.elapsed_min / 60, 1)} h` : '—') },
      /* Waiting is the sum of the gaps BETWEEN bookings, not elapsed minus on
         trip: the two differ whenever a day's bookings overlap, and on this
         fleet they overlap often enough that the subtraction goes negative. */
      { label: 'Waiting', key: 'wait_min', num: true,
        render: (r) => (r.wait_min
          ? `${fmt(r.wait_min / 60, 1)} h<span class="dim"> · ${r.elapsed_min
            ? `${Math.round((r.wait_min / r.elapsed_min) * 100)}%` : '—'}</span>`
          : '—') },
      { label: 'Longest gap', key: 'longest_wait_min', num: true,
        render: (r) => (r.longest_wait_min
          ? `${fmt(r.longest_wait_min / 60, 1)} h<span class="dim"> · med ${
            r.median_wait_min != null ? `${fmt(r.median_wait_min)}m` : '—'}</span>`
          : '—') },
      { label: 'Vehicle', key: 'plates',
        render: (r) => (r.plates || []).map((x) => entity('vehicle', x, x)).join(', ') || '—' },
    ]));
    /* An overlap is a real dispatch, not dirty data — the next request came in
       before the current dropoff — so it is stated rather than smoothed away.
       It is also why waiting is summed from the positive gaps only. */
    if (p.overlaps) {
      dayP.body.append(el('p', 'cap', esc(`${p.overlaps} booking${p.overlaps === 1 ? '' : 's'} `
        + 'started before the previous one ended, so waiting is summed over the positive gaps only.')));
    }
    if (p.note) dayP.body.append(el('p', 'cap', esc(p.note)));
  }

  platP.body.innerHTML = '';
  const plats = p.platforms || [];
  const pays = p.payouts || [];
  if (!plats.length) empty(platP.body, 'No booking in this week.');
  else {
    platP.body.append(tableFrom(plats.map((x) => {
      const pay = pays.find((y) => y.platform === x.platform);
      return { ...x, payout: pay ? pay.payout : null, period: pay ? `${String(pay.period_start).slice(0, 10)} → ${String(pay.period_end).slice(0, 10)}` : null };
    }), [
      { label: 'Channel', key: 'platform', render: (r) => pill(sourceLabel(r.platform)) },
      { label: 'Bookings', key: 'bookings', num: true },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      { label: 'Fares', key: 'fares', num: true,
        render: (r) => (r.fares ? `${money(r.fares)}<span class="dim"> · ${fmt(r.priced)}</span>`
          : '<span class="ent-off" title="this channel publishes no fare per trip">—</span>') },
      { label: 'Paid', key: 'payout', num: true,
        render: (r) => (r.payout != null ? money(r.payout)
          : '<span class="ent-off" title="no payout statement covers this week for this channel">—</span>') },
      { label: 'Statement covers', key: 'period', render: (r) => (r.period ? esc(r.period) : '—') },
    ]));
    platP.body.append(el('p', 'cap',
      'A fare is what the rider or property was charged; a payout is what reached the fleet after '
      + 'the channel took its commission and after any cash the driver already holds. They are not '
      + 'added together, and a statement period is quoted whole because no channel reports a day.'));
  }

  areaP.body.innerHTML = '';
  const areas = (p.areas || []).filter((a) => a.picked_up > 0);
  if (!areas.length) empty(areaP.body, 'No pickup address on any booking this week.');
  else {
    hbars(areaP.body, areas.slice(0, 12).map((a) => ({ label: a.area, n: a.picked_up })),
      { valueFmt: (v) => `${fmt(v)} pickups` });
    areaP.body.append(el('p', 'cap',
      'Parsed from free text by taking the second dash-separated segment, which is why some rows '
      + 'are roads or a country. The raw address on each trip is the record; this is a grouping.'));
  }

  statusP.body.innerHTML = '';
  const st = p.platform_status || [];
  if (!st.length) {
    empty(statusP.body, 'No Uber driver-status row covers this person this week. '
      + 'Uber writes status against the vehicle for one org only, and reports no online hours at '
      + 'all — so time logged in is not available, and first trip is not a login.');
  } else {
    statusP.body.append(tableFrom(st, [
      { label: 'Day', key: 'day', render: (r) => String(r.day).slice(0, 10) },
      { label: 'Status', key: 'status', render: (r) => pill(r.status) },
      { label: 'Observations', key: 'n', num: true },
      { label: 'First seen', key: 'first_seen', render: (r) => hhmm(r.first_seen) },
      { label: 'Last seen', key: 'last_seen', render: (r) => hhmm(r.last_seen) },
    ]));
    statusP.body.append(el('p', 'cap',
      'A five-minute poll, not an event log: a session shorter than the interval leaves no trace, '
      + 'and the earliest observation is the first time we looked and saw them, not the moment '
      + 'they logged in.'));
  }
  /* The shell titles a detail page from what its view RETURNS — see render()
     in app.js. Returning the name is what stops this page being titled after
     whatever happens to be first in the nav. */
  return { name: p.name || id };
}

const hhmm = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
};
