/* ── the other half of the market ─────────────────────────────────────────
   Every page in this product measures demand. Nothing measured supply, because
   until the availability collector landed there was nothing to measure it
   with — and the number turns out to be the largest in the business: across
   the six busiest drivers on production, 78–83% of their online time is spent
   available and not dispatched.

   Those are the best people. The fleet is paying for supply it is not selling,
   four hours in five, and until now that fact lived only on individual driver
   pages, one person at a time.

   Two questions, because the finding is only useful as a decision:
     WHEN  online driver-hours against jobs, so an over-supplied slot is
           visible as one rather than as a quiet hour
     WHERE how long the wait is after a dropoff in each area — the
           repositioning question, in the only geography this data has */
import { el, esc, panel, loading, note, tableFrom, fmt, empty, verdict, foldRows,
  plural, countOf, dayStr, sourceLabel } from './ui.js';
import { q, href } from './data.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hh = (h) => `${String(h).padStart(2, '0')}:00`;

/* The grid. Not the existing heatmap with a second colour bolted on: this
   draws the RATIO — jobs per online hour — because that is the thing a rota
   can act on, and because the two raw counts are on scales that cannot share a
   legend (driver-hours run to hundreds, jobs to tens).

   A cell with no supply data is not a cell with no supply. Uber serves 31 days
   of availability; before the collector started there is demand and nothing to
   compare it against, and those cells are left blank rather than drawn as an
   infinitely under-supplied hour. */
function balanceGrid(host, cells) {
  const by = new Map(cells.map((c) => [`${c.dow}|${c.h}`, c]));
  const rates = cells.filter((c) => c.jobs_per_online_h != null && c.online_h >= 1)
    .map((c) => c.jobs_per_online_h).sort((a, b) => a - b);
  if (!rates.length) return empty(host, 'No hour in this window has both supply and demand.');
  const med = rates[Math.floor(rates.length / 2)];
  /* QUINTILES of the observed distribution, not fixed multiples of the median.
     ─────────────────────────────────────────────────────────────────────────
     Banding at 0.5×, 1× and the 90th percentile put almost every cell in two
     bands and drew a grid of one colour — because sell-through barely varies:
     across 168 hours the median is 0.51 jobs per online hour and the maximum
     0.73, a spread of 1.4×. That flatness is itself the finding (supply tracks
     demand's SHAPE well and is uniformly too large), and a grid that cannot
     show the difference between its own best and worst hour hides the hours
     that are genuinely bad — Sat 08:00 sells 0.22 against Fri 23:00 at 0.73,
     which is 3.3× and was invisible.

     Cutting at the quintiles guarantees each band holds about a fifth of the
     hours, so the grid always has contrast and the contrast always means
     "relative to this fleet's own week". */
  const qAt = (f) => rates[Math.min(rates.length - 1, Math.floor(rates.length * f))];
  const cuts = [qAt(0.2), qAt(0.4), qAt(0.6), qAt(0.8)];
  const bandOf = (r) => (r === 0 ? 0 : r < cuts[0] ? 1 : r < cuts[1] ? 2 : r < cuts[2] ? 3
    : r < cuts[3] ? 4 : 5);

  const wrap = el('div', 'sup-grid');
  const head = el('div', 'sup-row sup-head');
  head.innerHTML = '<i></i>' + Array.from({ length: 24 }, (_, h) =>
    `<b>${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</b>`).join('');
  wrap.append(head);
  for (let d = 0; d < 7; d++) {
    const row = el('div', 'sup-row');
    row.innerHTML = `<i>${DOW[d]}</i>` + Array.from({ length: 24 }, (_, h) => {
      const c = by.get(`${d}|${h}`);
      if (!c || c.online_h < 1) {
        return `<span class="sup-c none" title="${DOW[d]} ${hh(h)} — no availability collected"></span>`;
      }
      const r = c.jobs_per_online_h ?? 0;
      return `<span class="sup-c b${bandOf(r)}" title="${DOW[d]} ${hh(h)} — on a typical one: `
        + `${fmt(c.online_h, 1)} online h, ${fmt(c.jobs, 1)} jobs, ${fmt(c.idle_h, 1)} h idle `
        + `· ${fmt(r, 2)} jobs per online hour · measured over ${c.occurrences} `
        + `${plural(c.occurrences, 'occurrence')}"></span>`;
    }).join('');
    wrap.append(row);
  }
  host.append(wrap);
  const lg = el('div', 'lgnd sup-lgnd');
  /* The legend names the CUTS, not adjectives. "under" means nothing without
     the number it is under, and this fleet's whole week fits between 0.21 and
     0.73 jobs an online hour. */
  lg.innerHTML = '<span><i class="sw b0"></i>sold nothing</span>'
    + `<span><i class="sw b1"></i>&lt; ${fmt(cuts[0], 2)}</span>`
    + `<span><i class="sw b2"></i>&lt; ${fmt(cuts[1], 2)}</span>`
    + `<span><i class="sw b3"></i>&lt; ${fmt(cuts[2], 2)}</span>`
    + `<span><i class="sw b4"></i>&lt; ${fmt(cuts[3], 2)}</span>`
    + `<span><i class="sw b5"></i>${fmt(cuts[3], 2)}+ jobs per online hour</span>`
    + '<span><i class="sw none"></i>no availability collected</span>';
  host.append(lg);
}

export async function renderSupply(root) {
  root.innerHTML = '';
  const vHost = el('div'); root.append(vHost);
  const gridP = panel('Every hour of the week, by how well the supply sold',
    'Jobs per online hour. Two slots with ten jobs are the same colour on a demand heatmap and '
    + 'opposite problems here — one had four drivers online and one had forty.');
  root.append(gridP.panel);
  const areaP = panel('Where the waiting happens',
    'How long a driver waits after finishing a job in each area, before their next request.');
  root.append(areaP.panel);
  [gridP.body, areaP.body].forEach(loading);

  const [bal, areas] = await Promise.all([
    q('/api/supply/balance'),
    q('/api/supply/areas').catch(() => ({ areas: [] })),
  ]);

  /* ── two different nothings, and they need two different sentences ──────
     This note used to say one thing whatever the reason: that Uber serves the
     last 31 days and nothing older, so the page fills in going forward and
     cannot be backfilled past that. That is true of a window that predates the
     collector and it is false of #supply?platform=bolt, which is the case the
     chip fix on /api/supply/balance made reachable. Bolt is not waiting for a
     backfill: driver_timeline_event carries platform 'uber' and nothing else
     (src/sources/uber_timeline.js writes SRC = 'uber' at :29 and stamps it on
     every row at :143), so there is no Bolt availability feed to be inside or
     outside a window of, and there will not be one until somebody writes a
     Bolt collector. An operator reading the old sentence under a Bolt chip
     would have waited for data that is never coming.

     The route now says which of the two it is — `uncovered.reason`, either
     'outside-window' or 'no-feed' — and names the platforms the feed does
     carry, read from the table rather than asserted here, so this page cannot
     drift from what was actually collected. A false reason is worse than a
     bare dash, because a reader acts on it. */
  const why = bal.uncovered || null;
  /* Through sourceLabel, because these are database keys — the platform column
     stores 'uber', and a sentence printed at an operator says Uber. */
  const feeds = (why?.platforms || []).map(sourceLabel);
  const feedList = feeds.length === 0 ? 'no platform at all'
    : feeds.length === 1 ? feeds[0]
      : `${feeds.slice(0, -1).join(', ')} and ${feeds[feeds.length - 1]}`;
  /* Four reasons, because there are four ways to have no denominator and each
     one sends an operator somewhere different. Two of them were a single
     sentence about Uber's 31-day retention: a window in the FUTURE was told its
     days "cannot be backfilled past that", and so was a window holding events
     that simply never closed a span. Neither is a retention fact.

     The empty-feed case gets its own wording too. `feedList` renders an empty
     list as "no platform at all", which inside "the availability feed carries
     no platform at all and nothing else" reads as a rendering fault rather
     than as the true and quite different statement that no channel has ever
     filed availability to this instance. */
  const uncoveredWhy = why?.reason === 'no-feed'
    ? (why.feed_empty
      ? 'Driver availability has never been collected on this instance. No channel files it, so '
        + 'there is no supply here to be busy or idle — an unmeasured window rather than a quiet '
        + 'one. The jobs on the other pages are real; the online hours they would be divided by '
        + 'were never recorded.'
      : 'Driver availability is not collected for this selection at all. The availability feed '
        + `carries ${feedList} and nothing else, so there is no supply here to be busy or idle — `
        + 'this is an unmeasured window rather than a quiet one, and no backfill will fill it in. '
        + 'The jobs on the other pages are real; the online hours they would be divided by were '
        + 'never recorded.')
    : why?.reason === 'not-yet'
      ? 'This window is in the future, so there is nothing collected for it yet — not a gap in '
        + 'the record, just days that have not happened.'
      : why?.reason === 'no-span'
        ? 'Availability events were recorded in this window but none of them close a shift — a '
          + 'driver who went online and has not gone offline, or a single event with nothing to '
          + 'pair it with. There is no online-hours figure to divide the jobs by, and widening '
          + 'the range is what usually resolves it.'
        : 'Driver availability has not been collected for this window. Uber serves the last 31 '
          + 'days and nothing older, so this page fills in going forward and cannot be '
          + 'backfilled past that.';
  if (!bal.covered) vHost.append(note(uncoveredWhy, 'warn'));

  const t = bal.totals;
  /* The worst slot that is actually a slot: enough supply for the ratio to
     mean something. One driver online for an hour with no job is not an
     over-supplied hour, it is one person. */
  /* The worst hour is the one that SELLS worst with real supply behind it, not
     the one with the most idle hours — the most idle hours is Thursday
     evening, which is also the busiest hour of the week, and telling an
     operator to cut their peak is the wrong instruction.

     Ranked on the ratio, floored at three online hours per occurrence: one
     driver online with no job is not an over-supplied hour, it is one person. */
  const real = bal.cells.filter((c) => c.online_h >= 3 && c.jobs_per_online_h != null);
  const worst = [...real].sort((a, b) => a.jobs_per_online_h - b.jobs_per_online_h)[0];
  const best = [...real].sort((a, b) => b.jobs_per_online_h - a.jobs_per_online_h)[0];
  const medRate = bal.totals.jobs_per_online_h;
  /* The gap stated in JOBS, which is a decision, rather than in ratio points,
     which is not. "0.08 more jobs per online hour" is arithmetically true and
     operationally meaningless; "those hours would sell 36 more jobs at the
     fleet's own average rate" is the same fact somebody can act on. */
  const shortfall = worst && medRate
    ? Math.round((medRate - worst.jobs_per_online_h) * worst.online_h * worst.occurrences)
    : null;

  /* ── the headline when nothing was measured ─────────────────────────────
     The fallback under the idle rate was `${fmt(t.jobs)} jobs in this window`
     over `fmt(t.jobs)` as the big figure, written when the only way to reach
     it was a window with supply but no idle arithmetic. The chip fix made it
     reachable with no supply at all, and totals.jobs is reduced over the
     supply cells — so a Bolt chip landed here with jobs 0 and the page
     headlined "0 jobs in this window" at 48px, under a warning note saying
     availability had not been collected. Two statements about the same
     selection, one of them false: Bolt sold 614 rides in the window that
     printed it, and none of them were zero.

     The route now sends every total as null rather than 0 in that case, which
     fmt() renders as an em dash on its own — correct and mute. So the claim
     and the figure say what is absent instead: the dash stays the figure, the
     unit names the absence, and the note directly above carries the reason.
     No new markup, no new panel — the same verdict block, told to say the true
     thing. */
  verdict(vHost, {
    claim: !bal.covered
      ? (noFeed ? 'This selection has no availability feed, so there is no supply to measure'
        : 'No driver availability was collected inside this window')
      : t.idle_pct != null
        ? `${t.idle_pct}% of the hours drivers are online, nobody is in the car`
        : `${fmt(t.jobs)} jobs in this window`,
    figure: !bal.covered ? '—'
      : t.jobs_per_online_h != null ? fmt(t.jobs_per_online_h, 2) : fmt(t.jobs),
    unit: !bal.covered ? (noFeed ? 'never collected here' : 'not collected for these days')
      : t.jobs_per_online_h != null ? 'jobs per online hour' : 'jobs',
    tone: t.idle_pct != null && t.idle_pct >= 70 ? 'warn' : null,
    /* The span the rate is actually over. Uber serves about 31 days of
       availability and nothing older, so on a 12-month range this figure
       describes a month of it — and said without that, widening the range
       looked like the fleet getting busier. */
    /* Nothing to caption when there are no hours: "— online h · — on job" is
       three dashes pretending to be a measurement. */
    meta: !bal.covered ? null
      : `${fmt(t.online_h)} online h · ${fmt(t.on_job_h)} on job`
      + (bal.measured && bal.measured.narrower_than_window
        ? ` · over the ${countOf(bal.measured.days, 'day')} availability covers, not the whole range`
        : ''),
    /* The note directly above already carries the reason in full, so this says
       the consequence instead of repeating it: every figure on this page is a
       division by online hours, and there are none. */
    sub: !bal.covered
      ? 'Every figure on this page divides by online hours, so none of them exist for this '
        + 'selection — they are absent rather than zero, for the reason above. The grid below is '
        + 'empty for the same reason, not because those hours sold nothing.'
      : `${fmt(t.idle_h)} driver-hours were available and not dispatched.`
      + (bal.measured && bal.measured.narrower_than_window
        ? ` Availability is only reported from ${dayStr(bal.measured.from)}, so every hour figure `
          + 'here is over that span rather than the range above — the two halves of the rate have '
          + 'to describe the same days or widening the range would simply lower it.'
        : '')
      + (worst ? ` The worst-selling hour with real supply behind it is ${DOW[worst.dow]} `
        + `${hh(worst.h)} — ${fmt(worst.online_h, 1)} online hours on a typical one, selling `
        + `${fmt(worst.jobs, 1)} jobs.` : '')
      + (best ? ` The best is ${DOW[best.dow]} ${hh(best.h)}, at `
        + `${fmt(best.jobs_per_online_h, 2)} against ${fmt(worst.jobs_per_online_h, 2)}.` : ''),
    recommend: shortfall && shortfall > 0
      ? `${DOW[worst.dow]} ${hh(worst.h)} sells ${fmt(worst.jobs_per_online_h, 2)} jobs an online `
        + `hour against the fleet's own ${fmt(medRate, 2)}. Bringing just that hour up to average `
        + `is about ${fmt(shortfall)} more ${plural(shortfall, 'job')} over this window — or the `
        + 'same supply moved somewhere it sells.'
      : null,
  });

  gridP.body.innerHTML = '';
  balanceGrid(gridP.body, bal.cells);
  gridP.body.append(el('p', 'cap', esc(bal.basis)));

  areaP.body.innerHTML = '';
  if (!areas.areas?.length) {
    areaP.body.append(note('Not enough completed jobs with a dropoff address to measure waiting by area.'));
  } else {
    const tbl = tableFrom(areas.areas, [
      { label: 'Area', key: 'area' },
      { label: 'Waits', key: 'waits', num: true },
      { label: 'Median wait', key: 'median_wait_min', num: true,
        render: (r) => `${fmt(r.median_wait_min)} min` },
      { label: 'Mean wait', key: 'mean_wait_min', num: true,
        render: (r) => `${fmt(r.mean_wait_min)} min` },
      { label: 'Hours waited', key: 'waiting_h', num: true,
        render: (r) => `${fmt(r.waiting_h, 1)} h` },
    ], { sortable: true, sortId: 'suparea', defaultSort: { key: 'waiting_h', dir: 'desc' } });
    foldRows(areaP.body, tbl, { shown: 12, total: areas.areas.length, noun: 'area', key: 'supply-areas' });
    areaP.body.append(el('p', 'cap', esc(areas.basis)));
  }

  const links = el('p', 'cap');
  links.innerHTML = `<a class="lnk" href="${href('demand')}">Demand</a> shows when the work arrives; `
    + `<a class="lnk" href="${href('capacity')}">Rota gaps</a> sizes the hours that need more people. `
    + 'This page is the two of them against each other.';
  root.append(links);
}
