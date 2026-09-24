/* Every active driver, for one period, on both bases — and who actually moved.
   ──────────────────────────────────────────────────────────────────────────
   The companion to the Record tab on a driver's own page. That page answers
   "did THIS person get better or worse"; this one answers the two questions
   an operator asks before they know whose page to open:

     who is doing the most work, and who is earning the most from it —
     asked separately, because they are different questions and a single
     blended score answers neither;

     and which people are doing something DIFFERENT from what they usually do,
     which is not the same list as the top and the bottom of either column.

   That last distinction is the point of the page. #top-performers and
   #low-performers rank the week; a driver can sit steadily in the top ten for
   a year and never appear here, and a driver in the middle who has quietly
   halved is the row somebody needs to see. The operator asked for both, and
   these are both.

   ── THE BAR IS HIGHER HERE THAN ON A DRIVER'S OWN PAGE, ON PURPOSE ──────
   A driver's own Record tab tests one person, so it uses the ordinary
   one-in-twenty bar. This page tests everybody at once, and at that bar a
   hundred and twenty drivers produce six false alarms every period — sorted to
   the top, because the list is sorted by how surprising each row is. The
   server raises the threshold to match the number of people tested and returns
   it with the sentence explaining it; the page prints that sentence rather
   than inventing its own. */
import { gapBars, dec, scatter } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, verdict, tabBar,
  money, fmt, dateStr, plural, countOf, contract, glance, glanceBand, bandTiles, absenceBand, pageFoot, delta } from './ui.js';
import { api, state, href } from './data.js';

const ordinal = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '';
  const t = v % 100;
  if (t >= 11 && t <= 13) return `${v}th`;
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
};
const periodLabel = (iso, grain) => (grain === 'month'
  ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  : `week of ${dateStr(iso)}`);
/* SHORT, because these are axis labels on a thirteen-bar chart and the chart
   truncates what it cannot fit — "Jun 22, 20…" under every bar says nothing
   the reader can use. Day and month for a week, month and year for a month. */
const periodShort = (iso, grain) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB',
  grain === 'month' ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', timeZone: 'UTC' });

/* A driver cell that is always openable, and it opens the RECORD tab.
   ─────────────────────────────────────────────────────────────────────────
   test/completeness.test.mjs requires a link of any list that names a person,
   and test/interlinking.test.mjs requires it to be visible in the column
   literal rather than hidden behind a helper — which is why this is spelled
   out at both call sites below rather than only here.

   Not entity(), which would land on the driver's Overview. A reader arriving
   from this page has just read a row about somebody's period and the next
   thing they want is that person's own record of the same periods, so the link
   goes straight to it. The id guard is the other half: a row with no id
   degrades to plain text rather than to a broken link. */

/* ── the movers ─────────────────────────────────────────────────────────── */
function moversPanel(host, d) {
  const up = d.movers.filter((m) => m.direction === 'up');
  const down = d.movers.filter((m) => m.direction === 'down');
  host.innerHTML = '';

  if (!d.movement.tested) {
    host.append(note('Nobody in this period has enough of their own record to be compared with '
      + 'yet. A comparison needs at least two earlier periods the driver worked in.'));
    return;
  }
  if (!d.movers.length) {
    /* NOT "no movers found". The number tested and the bar they were tested
       against are the finding — a reader who is not told those cannot tell a
       quiet period from a page that failed to look. */
    host.append(note(`All ${countOf(d.movement.tested, 'driver')} with enough history did what `
      + `they usually do, allowing for how the fleet as a whole moved. ${d.movement.why}`));
    return;
  }

  const table = (rows, title, none) => {
    /* `pcol`, and it is load-bearing at phone width.
       ─────────────────────────────────────────────────────────────────────
       A grid item's default min-width is auto, which is the MIN-CONTENT width
       of what it holds — and what these hold is a table. So at 400px the two
       halves of this panel refused to narrow below 508px and pushed the whole
       document 147px sideways, while the identical table on #top-performers
       sat happily inside its scroller. The scroller cannot do its job until
       the grid item is allowed to be narrower than its contents. */
    const p = el('div', 'pcol');
    p.append(el('h4', null, title));
    /* An EMPTY half is not "no data for this range".
       ─────────────────────────────────────────────────────────────────────
       tableFrom renders a zero-row table as the product's standard empty box,
       whose words are "No data for this range yet" — which is true of a page
       that failed to load and false here, where the page looked at every
       driver and found that none of them had gone that way. A reader cannot
       tell those apart from the box, and this is the half of the panel where
       the difference matters most: nobody dropping off is the good news. */
    if (!rows.length) { p.append(note(none)); return p; }
    p.append(tableFrom(rows, [
      { label: 'Driver',
        key: 'driver_name',
        render: (r) => (r.driver_ext_id
          ? `<a class="ent" href="${href('driver', r.driver_ext_id, 'record')}">`
            + `${esc(r.driver_name || r.driver_ext_id)}</a>`
          : `<span class="ent-off">${esc(r.driver_name || '—')}</span>`) },
      { label: 'Jobs', key: 'completed', num: true },
      { label: 'Expected', key: 'expected', num: true,
        render: (r) => `${fmt(r.expected)}` },
      { label: 'Difference', key: 'diff', num: true,
        render: (r) => {
          const v = Math.round(r.split?.total ?? 0);
          /* Under the contract a difference carries its glyph AND its sign,
             in the colour of its meaning (L3); the old skin's amber had no
             minus at all. */
          if (contract()) return delta(v, { d: 0 });
          const cls = v > 0 ? 'good' : 'warn';
          return `<span class="${cls}">${v > 0 ? '▲' : '▼'} ${fmt(Math.abs(v))}</span>`;
        } },
      /* WHY, in the same row. "Down 18" sends somebody to look; "down 18, and
         14 of it is two fewer days" tells them what to ask about. */
      { label: 'Because', key: 'because',
        render: (r) => {
          if (!r.split) return '—';
          const dpart = Math.round(r.split.days_part);
          const rpart = Math.round(r.split.rate_part);
          const bits = [];
          if (Math.abs(dpart) >= 1) {
            bits.push(`${fmt(Math.abs(dpart))} from working `
              + `${dec(Math.abs(r.split.days_now - r.split.days_then), 1)} `
              + `${r.split.days_now >= r.split.days_then ? 'more' : 'fewer'} days`);
          }
          if (Math.abs(rpart) >= 1) {
            bits.push(`${fmt(Math.abs(rpart))} from the pace on the days worked `
              + `(${dec(r.split.rate_now, 1)} against ${dec(r.split.rate_then, 1)} a day)`);
          }
          return esc(bits.join(', ') || 'too small to split');
        } },
      { label: 'How unusual', key: 'z', num: true,
        render: (r) => `${dec(Math.abs(r.z), 1)}σ` },
    ], { compact: true }));
    return p;
  };

  const g = el('div', 'grid g2');
  g.append(table(up, `Doing more than they usually do — ${countOf(up.length, 'driver')}`,
    `Nobody is doing measurably more than their own record this ${d.grain === 'month' ? 'month' : 'week'}.`));
  g.append(table(down, `Doing less than they usually do — ${countOf(down.length, 'driver')}`,
    `Nobody is doing measurably less than their own record this ${d.grain === 'month' ? 'month' : 'week'}, `
    + `which is the half of this panel worth having empty.`));
  host.append(g);
  host.append(el('p', 'cap', d.movement.why));
}

/* ── one ranking table, used twice, on two different bases ──────────────── */
function rankTable(host, rows, basis, d) {
  host.innerHTML = '';
  const onValue = basis === 'value';
  const usable = onValue ? rows.filter((r) => r.value_rankable) : rows;
  if (!usable.length) {
    host.append(note(onValue
      ? 'No driver in this period has a fare on enough of their completed trips for a value '
        + 'ranking. That is a gap in what the channels have reported, not a fleet that earned '
        + 'nothing — the jobs ranking beside it is unaffected, because a count is complete.'
      : 'No driver accepted work in this period.'));
    return;
  }
  const sorted = [...usable].sort((a, b) => (onValue
    ? (b.value || 0) - (a.value || 0)
    : b.completed - a.completed));
  const cols = [
    /* THE RANK RIDES INSIDE THE NAME, and it is not a column of its own.
       ─────────────────────────────────────────────────────────────────────
       A bare hash-mark column led this table in the first draft, and
       test/pinned_identity.test.mjs fails that on sight — matching the column
       DECLARATION, so this note deliberately does not spell the label out —
       for a reason it paid for once already: these
       tables are eight columns wide and scroll inside .tscroll on anything
       narrower than a laptop, app.css pins the FIRST column, and pinning the
       rank freezes 1, 2, 3 on screen while the person each row is about
       scrolls out of sight. Every figure visible, and nobody to attach it to.

       The rank comes off the ROW — position().rank, computed over the whole
       column server-side — never from the array index. tableFrom re-orders its
       array in place on every sort, so an index-derived rank renumbers itself
       1..n the moment a reader sorts by anything else. */
    { label: 'Driver',
      key: 'driver_name',
      render: (r) => `<span class="rk">${fmt((onValue ? r.value_position : r.jobs_position)?.rank)}</span>`
        + (r.driver_ext_id
          ? `<a class="ent" href="${href('driver', r.driver_ext_id, 'record')}">`
            + `${esc(r.driver_name || r.driver_ext_id)}</a>`
          : `<span class="ent-off">${esc(r.driver_name || '—')}</span>`) },
    onValue
      ? { label: 'Trip value', key: 'value', num: true, render: (r) => money(r.value) }
      /* "Jobs", not "Jobs done" — the panel heading above already says which
         work is counted, and the two words cost this table the column that
         matters most. See the header of the last column below. */
      : { label: 'Jobs', key: 'completed', num: true },
    /* No percentile column here, deliberately — it is on the driver's own
       Record tab, where it earns its width. Across periods the ordinal and the
       percentile say different things, because the active roster moves and
       "40th" means something different every week. Within ONE period they say
       the same thing, and the ordinal already rides inside the name. The width
       goes to "Against their usual", which was being pushed into a sideways
       scroll on a 1500px screen by real driver names. */
    /* No "Days" column. Measured on production it was the 60px that kept
       "vs usual" off the screen, and it is the least informative of the six: on
       a finished week nearly every active driver on this fleet shows 7, and the
       thing a reader actually wants from it — were these jobs done in a full
       week or in two days — is what "Jobs a day" beside it says. The days
       themselves are on the driver's own Record tab, one click away, where
       they sit against the same driver's other weeks and mean something. */
    onValue
      ? { label: 'Average fare', key: 'value_per_job', num: true,
        render: (r) => (r.value_per_job == null ? '—' : money(r.value_per_job)) }
      : { label: 'Jobs a day', key: 'intensity', num: true,
        render: (r) => (r.intensity == null ? '—' : dec(r.intensity, 1)) },
    /* The OTHER position, on every row of both tables. The disagreement is the
       finding — a driver first on jobs and fortieth on value is working short
       hops — and it can only be seen if both numbers are on one line. */
    onValue
      ? { label: 'On jobs', key: 'jobs_position',
        render: (r) => (r.jobs_position ? `${ordinal(r.jobs_position.rank)} of ${fmt(r.jobs_position.of)}` : '—') }
      : { label: 'On value', key: 'value_position',
        render: (r) => (r.value_position
          ? `${ordinal(r.value_position.rank)} of ${fmt(r.value_position.of)}`
          : `<span class="dim" title="${esc(r.value_absent || '')}">not ranked</span>`),
        absent: 'no driver in this period has a fare on enough of their completed trips to be '
          + 'ranked on value' },
    /* "vs usual", short, and the shortness is the point.
       ─────────────────────────────────────────────────────────────────────
       Written out as "Against their usual" this column set its own minimum
       width at about 140px and was the one pushed off the right edge on a
       1500px screen — measured against production names, which wrap to three
       lines and make the identity column wide. It is the column that separates
       this page from #top-performers, so it is the last one that may be cut;
       the heading above the table and the sentence below it both say what it
       measures, which is where a long phrase belongs. */
    { label: 'vs usual', key: 'z', num: true,
      render: (r) => {
        if (r.z == null) return `<span class="dim">${esc(r.no_verdict || 'no baseline yet')}</span>`;
        const v = Math.round(r.split?.total ?? 0);
        if (contract()) {
          return r.changed ? delta(v, { d: 0 })
            : `<span class="dim">${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))} within range</span>`;
        }
        const cls = !r.changed ? 'dim' : v > 0 ? 'good' : 'warn';
        const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '─';
        return `<span class="${cls}">${arrow} ${fmt(Math.abs(v))}</span>`
          + (r.changed ? '' : ' <span class="dim">within range</span>');
      } },
  ];
  host.append(tableFrom(sorted, cols, { compact: true, sortable: true,
    sortId: onValue ? 'pv' : 'pj' }));
  host.append(el('p', 'cap', onValue
    ? `Gross fares — what riders were charged, before any commission and before the cash the `
      + `driver already took. ${fmt(usable.length)} of ${fmt(rows.length)} active drivers have a `
      + `fare on at least ${Math.round(d.value_coverage_min * 100)}% of their completed trips and `
      + 'can be ranked; the rest are named on the jobs table with the shortfall.'
    : `Every driver who accepted work in this period — ${countOf(rows.length, 'driver')}. `
      + 'A driver who accepted nothing is not in the column at all, rather than at the bottom '
      + 'of it with a zero.'));
}

/* ── the page ───────────────────────────────────────────────────────────── */
export async function renderPerformance(root, periodParam) {
  const grain = state.grain === 'month' ? 'month' : 'week';
  const L = grain === 'month' ? 'month' : 'week';

  const head = el('div'); root.append(head);
  head.append(tabBar(
    [{ id: 'week', label: 'By week', ic: '▤' }, { id: 'month', label: 'By month', ic: '▦' }],
    grain, (g) => href('performance', null, null, { grain: g }),
  ));

  /* Under the page contract (plan §4 performance and performance/month):
     the grain tabs stay first; the verdict is the 00 statement with the
     tiles — its figure IS the active-driver count, so that tile folds into
     it (ruling 7) and Changed, the page's own question, leads; a missing
     summary is ABSENT with its reason, never the `?? 0` nought; a complete
     period carries its change on the last complete one, the running one
     none — then the period chips; every driver, jobs across and trip value
     up; the movers and both rankings unchanged, their differences signed
     with a glyph and a minus; the trend with a period nobody measured drawn
     as a gap, and active drivers as their own chart; How to read this kept;
     a † band. */
  const ak = contract();
  const AKB = ak ? glanceBand(root, null) : null;
  const vHost = ak ? AKB.vHost : el('div');
  if (!ak) root.append(vHost);
  loading(vHost);
  const kHost = el('div'); (ak ? AKB.tilesHost : root).append(kHost);
  /* The period chips are chrome under the contract: above the band whose
     verdict they choose, beside the grain tabs. */
  const pick = el('div'); if (ak) root.insertBefore(pick, AKB.band); else root.append(pick);
  const scP = ak ? panel('Every driver, jobs against trip value', 'One dot per driver whose fares can be placed; a name opens their record', 'perf-scatter') : null;
  if (scP) root.append(scP.panel);
  const mv = panel('Who is doing something different',
    `Measured against each driver’s own previous periods, not against each other`);
  root.append(mv.panel);
  /* Full width and stacked, NOT side by side. Half-width they fitted six of
     their nine columns and pushed "On value", "Jobs a day" and "Against their
     usual" into a sideways scroll — and those three are the columns that make
     the pair worth having: the disagreement between the two rankings is only
     visible when both positions are on one line without scrolling for it. */
  const jb = panel('Ranked on jobs done', 'The work that reached a rider');
  const vl = panel('Ranked on trip value',
    'Gross fares over the same period — the same people, in a different order');
  root.append(jb.panel); root.append(vl.panel);
  const trend = panel(`The fleet, ${L} by ${L}`,
    'The middle driver, not the total — a total moves when the roster does');
  root.append(trend.panel);
  [mv.body, jb.body, vl.body, trend.body].forEach(loading);

  let d;
  try {
    /* THE DEFAULT REQUEST IS WRITTEN OUT, once per grain, rather than
       assembled from a URLSearchParams.
       ─────────────────────────────────────────────────────────────────────
       api/warm.js warms exactly these two keys, the response cache keys on the
       full URL, and test/warm.test.mjs reads BOTH files to check that what is
       warmed is what is asked for — by looking for the literal inside the
       api() call, which is the only thing it can check from source. That guard
       exists because a warmed key differing from the requested one by a single
       character warms nothing and looks like it worked: seventeen paths times
       four windows were warmed that way for weeks, the warmer logging a
       successful pass the whole time.

       A chosen period is a different key and is not warmed — a reader who
       clicks back through the chips pays for that query, which is the right
       trade for thirteen keys per grain nobody may open. */
    d = periodParam
      ? await api(`/api/performance/fleet?grain=${grain}&period=${encodeURIComponent(periodParam)}`)
      : grain === 'month'
        ? await api('/api/performance/fleet?grain=month')
        : await api('/api/performance/fleet?grain=week');
  } catch (e) {
    vHost.innerHTML = '';
    vHost.append(note(`This page could not be read: ${String(e && e.message ? e.message : e)}`, 'warn'));
    return;
  }

  /* ── the period picker, as links rather than a control ───────────────── */
  pick.innerHTML = '';
  const picker = el('div', 'chips');
  [...d.periods].reverse().forEach((p) => {
    const a = el('a', `chip${p.period === d.period ? ' on' : ''}`);
    a.href = href('performance', p.period, null, { grain });
    a.textContent = periodShort(p.period, grain) + (p.complete ? '' : ' · running');
    picker.append(a);
  });
  pick.append(picker);

  /* ── the headline ────────────────────────────────────────────────────── */
  vHost.innerHTML = '';
  const s = d.summary;
  if (!s || !s.drivers) {
    verdict(vHost, { claim: `Nobody accepted work in ${periodLabel(d.period, grain)}`,
      sub: 'No booking on any channel was accepted by anybody in this period.' });
  } else {
    const moved = d.movers.length;
    const up = d.movers.filter((m) => m.direction === 'up').length;
    /* The claim and the figure have to be about the same quantity. An earlier
       draft claimed "1 driver did something different" beside a figure reading
       56, and a reader has to stop and work out that the two sentences are
       counting different things. */
    const down = moved - up;
    const movedPhrase = moved
      ? `${countOf(moved, 'driver')} of ${fmt(s.drivers)} did something different this ${L}`
      : `All ${countOf(s.drivers, 'active driver')} did what they usually do`;
    verdict(vHost, {
      claim: movedPhrase,
      figure: fmt(s.drivers), unit: 'active drivers',
      sub: `${fmt(s.completed)} jobs over ${countOf(s.active_days, 'active driver-day')}. `
        + `The middle driver did ${fmt(s.jobs_median)} `
        + `${plural(s.jobs_median, 'job', 'jobs')} at ${dec(s.intensity_median, 1)} a day`
        + `${s.value_median != null ? ` and ${money(s.value_median)} in fares` : ''}. `
        + (moved
          ? `${up ? `${countOf(up, 'driver')} did more than their own record` : 'None did more'} `
            + `and ${down ? `${fmt(down)} did less` : 'none did less'}; `
            + 'everybody else is inside their own ordinary variation.'
          : 'Nobody is outside their own ordinary variation for this period.'),
      meta: periodLabel(d.period, grain),
      tone: null,
    });
  }
  if (!d.period_complete && d.period_partial_note) {
    vHost.append(note(d.period_partial_note, 'warn'));
  }

  const PERF_TILES = [
    { key: 'perf-drivers', label: 'Active drivers', value: fmt(s?.drivers ?? 0),
      sub: `accepted at least one booking this ${L}` },
    { key: 'perf-jobs', label: 'Jobs done', value: fmt(s?.completed ?? 0),
      sub: `median ${fmt(s?.jobs_median ?? 0)} a driver` },
    { key: 'perf-value', label: 'Trip value', value: s?.value == null ? 'not measured' : money(s.value),
      sub: s?.value == null
        ? 'no completed trip in this period carries a fare'
        : `gross fares over ${countOf(s.value_drivers, 'driver')} whose trips are priced` },
    { key: 'perf-pace', label: 'Jobs a day', value: dec(s?.intensity_median ?? 0, 1),
      sub: 'the middle driver, on the days they worked' },
    { key: 'perf-moved', label: 'Changed', value: fmt(d.movers.length),
      sub: `of ${fmt(d.movement.tested)} with enough history to compare` },
    { key: 'perf-bar', label: 'The bar', value: `${dec(d.movement.threshold, 1)}σ`,
      sub: `one-in-twenty, spread across ${fmt(d.movement.tested)} drivers` },
  ];
  if (ak) {
    kHost.remove();
    const none = `nobody accepted work in ${periodLabel(d.period, grain)}`;
    const at = d.periods.findIndex((x) => x.period === d.period);
    const prev = d.period_complete && at > 0 ? [...d.periods.slice(0, at)].reverse().find((x) => x.complete) : null;
    const dl = (now, then, dd) => (prev && now != null && then != null
      ? { value: Number(now) - Number(then), kind: 'change', d: dd,
        of: `on ${grain === 'month' ? '' : 'the '}${periodLabel(prev.period, grain)}` } : null);
    const DELTA = { 'perf-jobs': dl(s?.completed, prev?.completed, 0), 'perf-value': dl(s?.value, prev?.value, 2),
      'perf-pace': dl(s?.intensity_median, prev?.intensity_median, 1) };
    const list = PERF_TILES.filter((x) => !(s && s.drivers && x.key === 'perf-drivers'))
      .map((x) => ((!s || !s.drivers) && ['perf-drivers', 'perf-jobs', 'perf-pace'].includes(x.key)
        ? { label: x.label, key: x.key, na: none }
        : x.value === 'not measured' ? { label: x.label, key: x.key, na: x.sub }
          /* "Changed 0" over nobody tested is not a count of nobody changing:
             with no one's record long enough to compare, it was not measured. */
          : x.key === 'perf-moved' && !d.movement.tested ? { label: x.label, key: x.key, hero: true,
            na: 'nobody active in this period has enough of their own record to be compared with yet' }
          : x.key === 'perf-moved' ? { ...x, hero: true }
            : DELTA[x.key] ? { ...x, delta: DELTA[x.key] } : x));
    glance(AKB.tilesHost, bandTiles(list).tiles);
    perfScatter(scP.body, d);
  } else kHost.replaceWith(kpiRow(PERF_TILES));

  moversPanel(mv.body, d);
  rankTable(jb.body, d.rows, 'jobs', d);
  rankTable(vl.body, d.rows, 'value', d);

  /* ── the fleet over time ─────────────────────────────────────────────── */
  trend.body.innerHTML = '';
  const pmeta = (iso) => d.periods.find((x) => x.period === iso);
  const series = d.periods.map((p) => ({
    period: periodShort(p.period, grain),
    iso: p.period,
    median: ak && p.jobs_median == null ? null : (p.jobs_median || 0),
    none: ak && p.jobs_median == null,
    drivers: p.drivers || 0,
    /* The period in progress is drawn as unfinished (hollow in the old skin,
       a hatch in its own colour under Arkiv), the same way it is on a
       driver's own Record tab and on the landing page. Drawn solid it is a
       short bar at the right-hand end of every chart on this product, which
       reads as the fleet collapsing and is only the calendar. */
    partial: !p.complete,
    days: p.elapsed_days,
    of_days: p.total_days,
  }));
  gapBars(trend.body, series, {
    x: 'period', y: 'median', label: 'jobs for the middle driver',
    ...(ak ? { gapKey: 'none', gapLabel: 'nobody worked this period' } : {}),
    inProgress: false,
    onClick: (row) => { location.hash = href('performance', row.iso, null, { grain }).slice(1); },
    aria: `Jobs done by the middle driver each ${L}`,
  });
  /* COMPLETE periods on both ends of that range. Ending it on the period in
     progress compares a full roster against however many people have worked so
     far this week — on production that read "moved from 77 to 80" on a week
     whose finished predecessor had 112, which is the opposite of the point the
     sentence is making. */
  const done = d.periods.filter((p) => p.complete);
  trend.body.append(el('p', 'cap',
    'The MEDIAN driver, deliberately, not the fleet total. The number of active drivers moved '
    + `from ${fmt(done[0]?.drivers ?? 0)} to ${fmt(done[done.length - 1]?.drivers ?? 0)} `
    + `over the ${countOf(done.length, 'finished ' + L)} here, and a total would move with it — `
    + 'which would be read as every driver improving. Click a bar to rank that period.'));
  if (ak) {
    /* Active drivers per period as its own small chart, never a second axis
       on the median's. */
    const box = el('div');
    trend.body.append(el('h4', 'sub', `Active drivers, ${L} by ${L}`), box);
    gapBars(box, series.map((x) => ({ ...x, n: x.drivers })), { x: 'period', y: 'n', label: 'active drivers',
      inProgress: false, aria: `Drivers who accepted work each ${L}` });
  }

  const how = panel('How to read this', 'Every rule here is measured on this fleet, not assumed');
  root.append(how.panel);
  const ul = el('ul', 'bul');
  const li = (h) => { const x = el('li'); x.innerHTML = h; ul.append(x); };
  li('<b>The two rankings are never blended.</b> Jobs done and trip value answer different '
    + 'questions, and where a driver sits high on one and low on the other, that disagreement is '
    + 'the finding. Both positions are on every row of both tables for exactly that reason.');
  li(`<b>Position is out of the drivers who were ACTIVE in the ${L}</b> — a driver who `
    + 'accepted no work is not in the column. Ranking somebody’s week off fills the bottom '
    + 'of a list with people who were not there.');
  li('<b>"Changed" is measured against the driver’s own record, not against the fleet.</b> '
    + 'It is a different list from the top and the bottom of either ranking: a driver who is '
    + 'steadily excellent never appears, and a driver in the middle who has quietly halved does.');
  li(`<b>The fleet’s own movement is taken out first.</b> A ${L} the whole fleet was quiet `
    + 'is not charged to the individual — each driver’s expected figure is scaled by how '
    + 'the median driver moved over the same periods.');
  li(`<b>${d.movement.why}</b>`);
  li('<b>Trip value is gross.</b> It is what riders were charged, before any platform commission '
    + 'and before the cash a driver has already taken. What the fleet actually receives is on the '
    + 'Revenue page and on each driver’s Earnings tab.');
  how.body.innerHTML = '';
  how.body.append(ul);
  if (ak) perfAbsence(root, d, grain);
}

/* ── #performance under the page contract ────────────────────────────────── */
function perfScatter(host, d) {
  const rows = (d.rows || []).filter((r) => r.value_rankable && r.value != null && r.completed != null);
  if (!rows.length) { host.append(note('No driver in this period has enough priced trips to place on value.')); return; }
  const box = el('div'); host.append(box);
  scatter(box, rows.map((r) => ({ ...r, value: Number(r.value), completed: Number(r.completed) })), {
    x: 'completed', y: 'value', label: 'driver_name', xLabel: 'jobs done', yLabel: 'trip value',
    yFmt: (v) => money(v), xFmt: (v) => fmt(v),
    onClick: (r) => { if (r.driver_ext_id) location.hash = href('driver', r.driver_ext_id, 'record'); } });
  const out = (d.rows || []).length - rows.length;
  host.append(el('p', 'cap', `${countOf(rows.length, 'driver')} whose trips are priced enough to place`
    + (out ? `; ${fmt(out)} are on the jobs table with the reason they are not on value` : '') + '.'));
}
function perfAbsence(root, d, grain) {
  const R = d.rows || [];
  const noUsual = R.filter((r) => r.z == null);
  const why = new Map();
  noUsual.forEach((r) => why.set(r.no_verdict || 'no verdict given', (why.get(r.no_verdict || 'no verdict given') || 0) + 1));
  const s = d.summary || {};
  const dropped = R.reduce((a, r) => a + (Number(r.dropped) || 0), 0);
  const limbo = s.accepted != null && s.completed != null ? Number(s.accepted) - Number(s.completed) - dropped : null;
  const gate = d.rate_gates?.show ?? 30;
  const under = R.filter((r) => r.rates?.absent).length;
  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    { label: 'A usual to compare against', hl: noUsual.length > 0, fig: noUsual.length ? `${fmt(noUsual.length)} of ${fmt(R.length)}` : null, none: 'Everyone has one',
      why: noUsual.length ? [...why.entries()].map(([w, n]) => `${fmt(n)} — ${w}`).join('; ') : 'Every active driver has enough history to compare.' },
    { label: 'Accepted, then neither done nor dropped', fig: limbo != null && limbo > 0 ? fmt(limbo) : null, none: limbo == null ? 'Not measured' : 'None',
      why: limbo == null ? 'This period carries no accepted or completed count.'
        : `${fmt(s.accepted)} accepted, ${fmt(s.completed)} done and ${fmt(dropped)} dropped by the driver; the rest ended some other way — the rider, or a channel that did not say.` },
    { label: `A completion rate under ${gate} accepted`, fig: under ? `${fmt(under)} of ${fmt(R.length)}` : null, none: 'Every one shown',
      why: `A percentage over fewer than ${gate} accepted bookings says more about the sample than the driver, so none is printed for them.` },
  ]);
  pageFoot({ colophon: [periodLabel(d.period, grain), `${fmt(R.length)} active`] }, root);
}
