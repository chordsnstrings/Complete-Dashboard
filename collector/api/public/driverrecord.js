/* This driver against their own record.
   ──────────────────────────────────────────────────────────────────────────
   The operator asked for performance "week by week, and month by month, a
   comparison of what they used to do, out of the active drivers what was their
   position, and whether it got better or worse" — and then said what the
   subject of it is, which is what this page is built around:

     "it's a performance difference of the solo driver
      not comparison between the fleet drivers."

   So the person is the subject and the fleet is the context. Every panel here
   reads left to right as: what they did, what they usually do, where that puts
   them, and whether the difference is real.

   ── FOUR THINGS THIS PAGE WILL NOT DO ───────────────────────────────────
   1. It will not blend jobs and money into one score. Two positions, side by
      side, on the operator's instruction — and where they disagree that IS the
      finding: 12th on jobs and 40th on value is a driver working short hops,
      which is a thing to say to them.
   2. It will not draw an arrow on a period that has not finished. The bar for
      the week in progress is drawn hollow, by the same chart helper that
      hollows today's bar on the landing page, and it is given no verdict.
   3. It will not charge the weather to the driver. Every verdict is against
      their own baseline AFTER the fleet's own movement over the same periods
      is taken out, and the page prints the fleet's movement beside it so the
      reader can see the adjustment rather than trust it.
   4. It will not print a percentage it cannot support. A completion rate over
      eleven bookings is not a completion rate; those cells say what they were
      measured over, or say why they are blank.

   api/performance_sql.js carries the measurements behind all four. */
/* `dec` comes from charts.js, which owns the number formatters; ui.js
   re-exports `fmt` and `empty` from the same place, so there is one set of
   them in the product rather than a per-page copy. */
import { gapBars, dec } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, verdict, empty,
  money, fmt, dateStr, plural, countOf, tabBar, sourceLabel } from './ui.js';
import { api, state, href, currentGen, alive } from './data.js';

/* Ordinals, because "12th of 118" is the sentence an operator reads and "the
   90th percentile" is the one they check it against. Both are printed: the
   ordinal moves when the roster does and the percentile does not, and a page
   that prints only the first is comparing two different denominators across
   periods and calling the difference a change. */
const ordinal = (n) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '';
  const t = v % 100;
  if (t >= 11 && t <= 13) return `${v}th`;
  return `${v}${['th', 'st', 'nd', 'rd'][v % 10] || 'th'}`;
};

/* A period start as the label a reader recognises. A week is named by the
   Monday it starts on, because that is the day the period starts and naming it
   by its end would put last week's work under this week's date. */
const periodLabel = (iso, grain) => (grain === 'month'
  ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
  : `w/c ${dateStr(iso)}`);
/* SHORT, because these are axis labels on a thirteen-bar chart and the chart
   truncates what it cannot fit — "Jun 22, 20…" under every bar says nothing a
   reader can use. */
const periodShort = (iso, grain) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB',
  grain === 'month' ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
    : { day: 'numeric', month: 'short', timeZone: 'UTC' });

/* A signed count in words rather than in glyphs: "12 more" and "12 fewer" are
   read correctly at a glance and "+12" and "−12" are read correctly only by
   somebody who already knows which direction is good. */
const moreFewer = (n, one = 'job', many = 'jobs') => {
  const v = Math.round(Number(n) || 0);
  if (!v) return `no change in ${many}`;
  /* "29 more jobs", not "29 jobs more". Both are grammatical; the second one
     read badly three times in one sentence on production — "Of the 29 jobs
     more, 2 jobs more from working 0.2 days more and 27 jobs more from the
     pace" — because the qualifier keeps landing at the end of the clause. */
  return `${fmt(Math.abs(v))} ${v > 0 ? 'more' : 'fewer'} ${plural(Math.abs(v), one, many)}`;
};

/* How the fleet moved, as a clause that can be dropped into a sentence. */
const fleetClause = (f) => {
  if (!f || !f.measured) return 'the fleet’s own movement could not be measured over these periods';
  const d = (f.factor - 1) * 100;
  if (Math.abs(d) < 5) return `the fleet as a whole barely moved (${d >= 0 ? 'up' : 'down'} ${dec(Math.abs(d), 0)}%)`;
  return `the fleet as a whole was ${d > 0 ? 'up' : 'down'} ${dec(Math.abs(d), 0)}% over the same periods`;
};

/* ── the headline ───────────────────────────────────────────────────────── */
function headline(host, p, grain, name) {
  const L = grain === 'month' ? 'month' : 'week';
  if (!p) {
    return verdict(host, {
      claim: `No finished ${L} to report on yet`,
      sub: `The only ${L} in range is the one now in progress, and a ${L} that has not `
        + 'finished cannot be compared with ones that have.',
    });
  }
  const j = p.judgement || {};
  const v = j.verdict;
  if (!v) {
    return verdict(host, {
      claim: `No verdict for ${periodLabel(p.period, grain)}`,
      figure: fmt(p.completed), unit: 'jobs done',
      sub: j.absent ? `${j.absent.charAt(0).toUpperCase()}${j.absent.slice(1)}.`
        : 'There is not enough of their own record to compare this period against.',
      meta: p.active_days ? countOf(p.active_days, 'active day') : 'no active day',
    });
  }

  const d = v.split.total;
  const dir = v.direction === 'up' ? 'Up' : v.direction === 'down' ? 'Down' : 'Level';
  const claim = v.changed
    ? `${dir} on their own record`
    : Math.abs(d) < 0.5 ? 'The same as they usually do' : 'Within their usual range';
  /* Tone is on the VERDICT, not on the raw direction. A driver down eighteen
     jobs in a fortnight the whole fleet was down is not having a bad
     fortnight, and colouring that red is the single most common way a
     dashboard loses its readers' trust. */
  const tone = !v.changed ? null : v.direction === 'up' ? 'good' : 'warn';

  const parts = [];
  parts.push(`${fmt(p.completed)} ${plural(p.completed, 'job', 'jobs')} over `
    + `${countOf(p.active_days, 'active day')}.`);
  parts.push(`Their usual over the previous ${countOf(v.baseline.periods, L)} is `
    + `${fmt(v.own_usual)}; ${fleetClause(v.fleet)}, so ${fmt(v.expected)} was the number to `
    + 'expect.');
  /* The split, and it is the useful half of the sentence: an operator can act
     on "worked two fewer days" and cannot act on "down 18". */
  /* Only the halves that actually moved. An earlier draft always printed both
     and produced "Of the 25 jobs more, no change in jobs comes from working 0.0
     day more and 25 jobs more from the pace" — a sentence that takes longer to
     discount than to read. A driver who worked the same days and went faster
     gets one clause, which is the whole finding. */
  const dayBit = Math.abs(v.split.days_part) >= 0.5
    ? `${moreFewer(v.split.days_part)} from working `
      + `${dec(Math.abs(v.split.days_now - v.split.days_then), 1)} `
      + `${plural(Math.abs(v.split.days_now - v.split.days_then), 'day', 'days')} `
      + `${v.split.days_now >= v.split.days_then ? 'more' : 'fewer'}`
    : null;
  const paceBit = Math.abs(v.split.rate_part) >= 0.5
    ? `${moreFewer(v.split.rate_part)} from the pace on the days they worked `
      + `(${dec(v.split.rate_now, 1)} a day against their usual ${dec(v.split.rate_then, 1)})`
    : null;
  if (dayBit || paceBit) {
    parts.push(dayBit && paceBit
      ? `Of the ${moreFewer(d)}, ${dayBit} and ${paceBit}.`
      : `That is ${dayBit || paceBit} — the other half of it did not move.`);
  }
  if (!v.changed) {
    parts.push(`That gap is inside ${esc(name || 'this driver')}’s own ordinary `
      + `${L}-to-${L} variation, so it is not called a change.`);
  }

  return verdict(host, {
    claim,
    figure: fmt(p.completed), unit: 'jobs done',
    sub: parts.join(' '),
    tone,
    meta: periodLabel(p.period, grain),
  });
}

/* ── the two positions, as their own tiles ──────────────────────────────── */
function positionTiles(p) {
  const jp = p?.jobs_position;
  const vp = p?.value_position;
  return [
    { key: 'rec-jobs', label: 'Jobs done', value: fmt(p?.completed ?? 0),
      sub: p?.active_days ? `over ${countOf(p.active_days, 'active day')}` : 'no active day in this period' },
    { key: 'rec-jobs-pos', label: 'Position on jobs',
      value: jp ? `${ordinal(jp.rank)} of ${fmt(jp.of)}` : '—',
      sub: jp
        ? `${ordinal(jp.percentile)} percentile · fleet median ${fmt(jp.median)}`
          + (jp.tied > 1 ? ` · level with ${fmt(jp.tied - 1)} others` : '')
        : 'not active in this period, so not placed against people who were' },
    { key: 'rec-value', label: 'Trip value',
      value: p?.value == null ? 'not measured' : money(p.value),
      sub: p?.value == null
        ? 'no fare is on record for any completed trip in this period'
        : `gross, what riders were charged · ${fmt(p.priced_completed ?? 0)} of `
          + `${fmt(p.completed ?? 0)} completed trips priced` },
    { key: 'rec-value-pos', label: 'Position on value',
      value: vp ? `${ordinal(vp.rank)} of ${fmt(vp.of)}` : '—',
      sub: vp
        ? `${ordinal(vp.percentile)} percentile · fleet median ${money(vp.median)}`
        : (p?.value_absent || 'no completed trip in this period, so there is no value to place') },
    { key: 'rec-days', label: 'Active days', value: fmt(p?.active_days ?? 0),
      sub: p?.offered_only_days
        ? `${countOf(p.offered_only_days, 'further day')} they were offered work and took none`
        : 'a day they accepted at least one booking' },
    { key: 'rec-pace', label: 'Jobs a day', value: p?.intensity == null ? '—' : dec(p.intensity, 1),
      sub: p?.judgement?.verdict
        ? `their usual is ${dec(p.judgement.verdict.split.rate_then, 1)}`
        : 'on the days they worked' },
  ];
}

/* ── the whole record, as a table ───────────────────────────────────────── */
function recordTable(host, rec) {
  const grain = rec.grain;
  const rows = [...rec.periods].reverse().map((p) => {
    const v = p.judgement?.verdict;
    return {
      period: p.period,
      label: periodLabel(p.period, grain),
      complete: p.complete,
      jobs: p.completed,
      jobs_pos: p.jobs_position ? `${ordinal(p.jobs_position.rank)} of ${fmt(p.jobs_position.of)}` : null,
      jobs_pctl: p.jobs_position ? p.jobs_position.percentile : null,
      value: p.value,
      value_pos: p.value_position ? `${ordinal(p.value_position.rank)} of ${fmt(p.value_position.of)}` : null,
      days: p.active_days,
      pace: p.intensity,
      completion: p.rates?.completion ? p.rates.completion.pct : null,
      completion_lo: p.rates?.completion ? p.rates.completion.lo : null,
      completion_hi: p.rates?.completion ? p.rates.completion.hi : null,
      accepted: p.accepted,
      change: v ? v.split.total : null,
      changed: v ? v.changed : null,
      direction: v ? v.direction : null,
      why: v ? null : (p.judgement?.absent || null),
    };
  });

  const cols = [
    { label: grain === 'month' ? 'Month' : 'Week', key: 'label',
      render: (r) => `${esc(r.label)}${r.complete ? '' : ' <span class="pill">still running</span>'}` },
    { label: 'Jobs', key: 'jobs', num: true },
    { label: 'Position', key: 'jobs_pos',
      /* The ordinal AND the percentile: see ordinal() above — the ordinal
         alone is not comparable between two periods with different rosters. */
      render: (r) => (r.jobs_pos
        ? `${esc(r.jobs_pos)} <span class="dim">${esc(ordinal(r.jobs_pctl))}</span>`
        : '—'),
      absent: 'a position is only given for a period the driver accepted work in — '
        + 'ranking somebody against people who were there on a day they were not is not a ranking' },
    { label: 'Against their usual', key: 'change', num: true,
      render: (r) => {
        /* Terse in the cell, the whole reason on hover. The sentence itself is
           the right one — "this week is 1 of 7 days old, so there is nothing
           yet to compare with a finished one" — but printed in a table cell it
           set the column's width for all thirteen rows. */
        if (r.change == null) {
          const short = /days old/.test(r.why || '') ? 'still running'
            : /first/.test(r.why || '') ? 'first period on record'
              : 'no baseline yet';
          return `<span class="dim" title="${esc(r.why || '')}">${esc(short)}</span>`;
        }
        const arrow = r.direction === 'up' ? '▲' : r.direction === 'down' ? '▼' : '─';
        const cls = !r.changed ? 'dim' : r.direction === 'up' ? 'good' : 'warn';
        return `<span class="${cls}">${arrow} ${esc(fmt(Math.abs(r.change)))}</span>`
          + `${r.changed ? '' : ' <span class="dim">within range</span>'}`;
      } },
    { label: 'Trip value', key: 'value', num: true, render: (r) => (r.value == null ? '' : money(r.value)),
      absent: 'no fare is on record for any completed trip in these periods — a value is not '
        + 'zero, it is a fare that has not arrived' },
    { label: 'Value position', key: 'value_pos',
      absent: 'a value position needs a fare on most of the completed trips, or it ranks who has '
        + 'been invoiced rather than who earned' },
    { label: 'Days', key: 'days', num: true },
    { label: 'Jobs a day', key: 'pace', num: true, render: (r) => (r.pace == null ? '—' : dec(r.pace, 1)) },
    { label: 'Completed', key: 'completion', num: true,
      render: (r) => (r.completion == null
        ? ''
        : `${dec(r.completion, 1)}% <span class="dim">${dec(r.completion_lo, 0)}–${dec(r.completion_hi, 0)}</span>`),
      /* A rate is context here and never a rank — the measured week-to-week
         rank correlation of completion percentage on this fleet is 0.29, which
         is mostly noise. The interval beside it is what makes that visible. */
      absent: `a completion rate is only shown over ${fmt(rec.rate_gates.show)} accepted bookings `
        + 'or more; below that the percentage describes the sample, not the driver' },
  ];
  host.innerHTML = '';
  host.append(tableFrom(rows, cols, { compact: true }));
}

/* ── the page ───────────────────────────────────────────────────────────── */
export async function renderDriverRecord(root, id, prof) {
  const gen = currentGen();
  /* The app's own grain, so the toolbar and this switch are one control rather
     than two that can disagree. 'day' and 'auto' are not periods a record can
     be read at — a day has no usual — so they resolve to weeks, and an
     explicit 'day' says so rather than silently showing something else. */
  const asked = state.grain;
  const grain = asked === 'month' ? 'month' : 'week';
  const L = grain === 'month' ? 'month' : 'week';

  const head = el('div'); root.append(head);
  head.append(tabBar(
    [{ id: 'week', label: 'Week by week', ic: '▤' },
      { id: 'month', label: 'Month by month', ic: '▦' }],
    grain, (g) => href('driver', id, 'record', { grain: g }),
  ));
  if (asked === 'day') {
    head.append(note(`A record is read over periods long enough to have a usual, so the day grain `
      + `set on the toolbar does not apply here — this is ${L}s.`));
  }

  const vHost = el('div'); root.append(vHost); loading(vHost);
  const kHost = el('div'); root.append(kHost);
  const jobs = panel(`Jobs done, ${L} by ${L}`,
    `Their own bars against the fleet median of the same ${L}, drawn as an outline behind each`);
  root.append(jobs.panel);
  const val = panel(`Trip value, ${L} by ${L}`,
    'Gross — what riders were charged, before any platform commission and before the cash the driver already took');
  root.append(val.panel);
  /* WHERE THEY SAT AMONG THE PEOPLE WHO WERE THERE, period by period.
     ─────────────────────────────────────────────────────────────────────
     The third comparison this page makes, and the one the two charts above it
     cannot: those show what the driver DID, and a driver can do more every
     week while the fleet does more still. This shows where that put them.

     It is a percentile rather than an ordinal, deliberately: the active set on
     this fleet moved from 77 to 112 people inside thirteen weeks, so "40th"
     means a different thing every week and a chart of it would draw a change
     that is only the roster. */
  const pos = panel(`Where they stood, ${L} by ${L}`,
    'Their percentile among the drivers who were active in the same period — 50 is the middle driver');
  root.append(pos.panel);
  const tbl = panel('Every period on record', `Position is out of the drivers who were active in that ${L}`);
  root.append(tbl.panel);
  [jobs.body, val.body, pos.body, tbl.body].forEach(loading);

  let rec;
  try {
    rec = await api(`/api/performance/driver?id=${encodeURIComponent(id)}&grain=${grain}`);
  } catch (e) {
    vHost.innerHTML = '';
    vHost.append(note(`The record could not be read: ${String(e && e.message ? e.message : e)}`, 'warn'));
    [jobs.body, val.body, pos.body, tbl.body].forEach((b) => { b.innerHTML = ''; });
    return;
  }
  if (!alive(gen)) return;

  vHost.innerHTML = '';
  if (rec.absent) {
    vHost.append(note(`This driver has ${rec.absent}.`));
    [jobs.body, val.body, pos.body, tbl.body].forEach((b) => { b.innerHTML = ''; empty(b, 'Nothing in this range'); });
    return;
  }

  const latest = rec.periods.find((p) => p.period === rec.latest_complete) || null;
  headline(vHost, latest, grain, rec.driver?.name);
  kHost.replaceWith(kpiRow(positionTiles(latest)));

  /* ── the jobs chart ──────────────────────────────────────────────────── */
  jobs.body.innerHTML = '';
  const bars = rec.periods.map((p) => ({
    period: periodShort(p.period, grain),
    jobs: p.completed,
    fleet: p.fleet_jobs_median,
    /* The chart hollows a bucket that covers fewer days than the ones beside
       it — the same treatment the landing page gives today's bar, and for the
       same reason: three days of a week drawn at full weight beside whole
       weeks reads as a collapse that has not happened. */
    partial: !p.complete,
    days: p.elapsed_days,
    of_days: p.total_days,
  }));
  gapBars(jobs.body, bars, {
    x: 'period', y: 'jobs', label: 'jobs done',
    secondary: 'fleet', secondaryLabel: `the fleet median that ${L}`,
    inProgress: false,
    aria: `Jobs done each ${L}, with the fleet median behind`,
  });
  jobs.body.append(el('p', 'cap',
    `The outline behind each bar is what the middle driver of the fleet did in the same ${L}. `
    + `It is a median over people, not a total: the number of active drivers moves `
    + `${L} to ${L}, and a total would move with it.`));

  /* ── the value chart, or the reason there isn't one ──────────────────── */
  val.body.innerHTML = '';
  const priced = rec.periods.filter((p) => p.value != null);
  if (!priced.length) {
    val.body.append(note('No completed trip of this driver’s carries a fare in any period on '
      + 'this page, so there is no trip value to draw. That is a gap in what the channel reports, '
      + 'not a driver who earned nothing.'));
  } else {
    gapBars(val.body, rec.periods.map((p) => ({
      period: periodShort(p.period, grain),
      value: p.value || 0,
      fleet: p.fleet_value_median,
      partial: !p.complete, days: p.elapsed_days, of_days: p.total_days,
    })), {
      x: 'period', y: 'value', label: 'in fares',
      valueFmt: (v) => money(v), axisFmt: (v) => fmt(v),
      secondary: 'fleet', secondaryLabel: `the fleet median that ${L}`,
      inProgress: false,
      aria: `Gross trip value each ${L}, with the fleet median behind`,
    });
    const short = rec.periods.filter((p) => p.completed > 0 && !p.value_rankable);
    val.body.append(el('p', 'cap',
      'Gross fares, not earnings: Uber takes a commission out of this and the driver has already '
      + 'taken any cash. The Earnings tab is where the money the fleet actually receives lives.'
      + (short.length
        ? ` ${short.length} of these ${L}s ${short.length === 1 ? 'is' : 'are'} drawn but not `
          + 'ranked — not every completed trip in them carries a fare yet.'
        : '')));
  }

  /* ── where they stood ────────────────────────────────────────────────── */
  pos.body.innerHTML = '';
  const placed = rec.periods.filter((p) => p.jobs_position);
  if (!placed.length) {
    pos.body.append(note(`This driver accepted no work in any ${L} on this page, so there is no `
      + 'period in which they can be placed against the people who were working.'));
  } else {
    gapBars(pos.body, rec.periods.map((p) => ({
      period: periodShort(p.period, grain),
      pctl: p.jobs_position ? p.jobs_position.percentile : 0,
      vpctl: p.value_position ? p.value_position.percentile : 0,
      /* A period they did not work is an ABSENCE, not a percentile of nought.
         gapBars hatches the whole height of the plot for one of these, which
         is the distinction: nought means they were placed last, and hatched
         means they were not placed at all. Drawing the first where the second
         is true would be the plainest lie this page could tell. */
      unplaced: !p.jobs_position,
      partial: !p.complete,
      days: p.elapsed_days,
      of_days: p.total_days,
    })), {
      x: 'period', y: 'pctl', label: 'percentile on jobs done',
      gapKey: 'unplaced',
      gapLabel: 'they accepted no work, so they are not placed against the people who did',
      secondary: 'vpctl', secondaryLabel: 'their percentile on trip value',
      max: 100, inProgress: false,
      /* Plain numbers up the side, the word in the tooltip. "0th" is not an
         axis label anybody reads, and "32nd percentile" is exactly what the
         hovered bar is. */
      axisFmt: (v) => fmt(v),
      valueFmt: (v) => `${ordinal(v)} percentile`,
      aria: `Percentile among active drivers each ${L}`,
    });
    /* The last FINISHED period, not the last one with a position on it. The
       week in progress has a real percentile — it is placed against the people
       who have worked so far this week — and summarising somebody's standing
       from three days of it is the same mistake as giving that week a verdict.
       The chart still draws it, hollow; the sentence does not speak for it. */
    const last = placed.filter((p) => p.complete).slice(-1)[0] || null;
    pos.body.append(el('p', 'cap',
      `The bar is their position on JOBS DONE and the outline behind it their position on TRIP `
      + `VALUE, both out of the drivers who were active in the same ${L}. A driver whose outline `
      + 'sits well above their bar is earning more per job than the people around them; one whose '
      + 'outline sits below is doing more jobs for less. '
      + (last
        ? `In ${periodLabel(last.period, grain)} they sat in the `
          + `${ordinal(last.jobs_position.percentile)} percentile on jobs, `
          + `${ordinal(last.jobs_position.rank)} of ${fmt(last.jobs_position.of)} active drivers`
          + (last.value_position
            ? `, and the ${ordinal(last.value_position.percentile)} percentile on value.`
            : ', and were not placed on value — no fare is on record for enough of their '
              + 'completed trips.')
        : `No ${L} on this page has finished with them placed in it yet.`)));
  }

  /* ── the table ───────────────────────────────────────────────────────── */
  recordTable(tbl.body, rec);

  /* ── what the page means, said once, at the bottom ───────────────────── */
  const how = panel('How to read this',
    'Every rule here is measured on this fleet, not assumed');
  root.append(how.panel);
  const ul = el('ul', 'bul');
  const li = (h) => { const x = el('li'); x.innerHTML = h; ul.append(x); };
  li(`<b>Position is out of the drivers who were active in that ${L}</b> — a driver who `
    + 'accepted no work is not in the column at all. Ranking somebody’s day off is how a list '
    + 'of the worst performers fills up with people who were not there.');
  li('<b>Jobs and trip value are ranked separately and never blended.</b> Where the two disagree, '
    + 'that is the finding: high on jobs and low on value is a driver working short hops.');
  li(`<b>"Against their usual" compares them with their own previous `
    + `${countOf(rec.baseline_periods, L)}</b>, after the fleet’s own movement over the same `
    + 'periods is taken out. A fortnight the whole fleet was quiet is not charged to the person.');
  li('<b>A difference is only called a change when it is bigger than this driver’s own '
    + 'ordinary variation.</b> Everything smaller is marked <i>within range</i> rather than '
    + 'given an arrow — an arrow every period is an arrow nobody reads.');
  li(`<b>The ${L} now in progress is drawn hollow and given no verdict.</b> Comparing a `
    + `part-${L} with whole ones reports a collapse every ${L === 'week' ? 'Tuesday' : 'first'} `
    + 'morning.');
  li('<b>Rates are context, never a rank.</b> Measured on this fleet, a driver’s completion '
    + 'percentage one week predicts almost nothing about the next — the rank correlation is '
    + '0.29 — so completion is shown with the range it could really be, and never given a '
    + 'position or an arrow.');
  how.body.innerHTML = '';
  how.body.append(ul);
  const chans = (latest?.platforms || []).map(sourceLabel).join(', ');
  if (chans) how.body.append(el('p', 'cap', `This driver worked ${chans} in `
    + `${periodLabel(latest.period, grain)}.`
    + (latest.on_offer_channel
      ? ' Bolt is the only channel here that files an offer nobody took, which is why their '
        + 'offered-but-not-accepted days can be counted at all.'
      : ' None of these channels files an offer that was never accepted, so a day they were '
        + 'shown work and took none cannot be counted for them — it is not a clean record, '
        + 'it is an unreported one.')));
}
