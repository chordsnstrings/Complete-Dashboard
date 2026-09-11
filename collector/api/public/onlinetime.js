/* Who came online when, and who has to be phoned about it.
   ──────────────────────────────────────────────────────────────────────────
   The reader sets the time the fleet is meant to start; everyone who came
   online after it is red and everyone who beat it is green. That is the whole
   product, and the difficulty is not the colour — it is refusing to colour a
   row the data cannot support.

   A red row is a phone call. api/online_routes.js distinguishes four reasons a
   driver has no online time and only one of them is about the driver: the
   timeline may not have caught up yet (it runs every three hours against a
   half-hourly trip pull), the driver may have been online since before
   midnight, or Uber may never have been asked about them at all — measured on
   production 2026-09-08, 25 of 109 people with an active Uber standing were
   never asked, because the collector only requests drivers who took a trip in
   the previous two days. None of those three may render as lateness, so this
   page has THREE states and not two: green, red, and a grey that says why.

   The first trip is on the row as evidence and never as a verdict. A trip is
   necessarily after going online — a median 68 to 73 minutes after it,
   measured over two days on production — so a lateness mark built on it would
   be systematically too kind, and a page that quietly did that would send
   nobody the calls it is for. */
import { el, esc, panel, loading, tableFrom, kpiRow, entity, pill, sourceLabel, timeStr,
  dialable } from './ui.js';
import { dubaiDay } from './tz.js';
import { empty, fmt } from './charts.js';
import { api, href } from './data.js';

/* Remembered per reader, because the expected start is a property of how this
   fleet runs and not of the page load. localStorage rather than the URL: it is
   the reader's own standard, and putting it in a link would send somebody
   else's start time to whoever the link is pasted to. */
const KEY = 'online-time:start';
const readStart = () => {
  try { return localStorage.getItem(KEY) || '06:00'; } catch { return '06:00'; }
};
const saveStart = (v) => { try { localStorage.setItem(KEY, v); } catch { /* private window */ } };


/* The grey states, in the words the endpoint returns. Each carries its own
   sentence into the title so a reader who wants to know why gets the whole
   reason rather than a category.

   Exported because the phone screen shows the same three states and must show
   them in the same words. Two copies of this map is how the two shells end up
   calling the same absence "not asked" on one screen and "no data" on the
   other, over the same driver, on the same morning. */
export const GREY = {
  already_online: 'already on',
  awaiting_feed: 'not in yet',
  not_asked: 'not asked',
  cannot_earn: 'cannot earn',
  absent: 'no event',
  /* A sixth, and it is the only one of these that is not an absence: the
     person was demonstrably working, on a channel that reports finished trips
     and never reports when somebody came online. It sits in this map because
     the Online column has no time to print for them — but the row is not grey,
     and where the first trip lands before the start time the chip goes green
     and says "driving by 06:19" instead of any of these words. */
  worked_elsewhere: 'drove, no timeline',
};

export async function renderOnlineTime(root) {
  root.innerHTML = '';
  let day = dubaiDay();
  let start = readStart();

  /* NOT 'Online time' again. The shell already prints the view's label and its
     one-line description above this panel, from the VIEWS register in app.js —
     a panel repeating them put the same heading and the same sentence on the
     screen twice, 300px apart, which is the defect the platforms page was
     fixed for. This heading names what the panel actually holds: the two
     settings every figure below is measured against. */
  const head = panel('The day, and the time you expect them to start',
    'Both apply to every number and every colour below');
  root.append(head.panel);

  const controls = el('div', 'btnrow');
  controls.style.cssText = 'margin:10px 0;gap:14px;align-items:center;flex-wrap:wrap';
  const dayIn = el('input'); dayIn.type = 'date'; dayIn.value = day; dayIn.className = 'inp';
  const startIn = el('input'); startIn.type = 'time'; startIn.value = start; startIn.className = 'inp';
  const lab = (t, node) => {
    const w = el('label'); w.style.cssText = 'display:flex;gap:6px;align-items:center';
    w.append(el('span', 'note', t), node); return w;
  };
  controls.append(lab('Day', dayIn), lab('Expected start', startIn));
  head.body.append(controls);

  const tiles = el('div'); head.body.append(tiles);
  /* "Late last" was wrong about its own table. The default sort is the online
     minute descending, so the LATEST starter is the first row — which is the
     right order for a call list and the opposite of what the caption said. A
     caption that contradicts the sort teaches the reader to distrust the sort. */
  const list = panel('Every driver',
    'Latest first, so the call list is the top of this table');
  root.append(list.panel);

  let gen = 0;
  const draw = async () => {
    const mine = ++gen;
    loading(tiles); loading(list.body);
    let d;
    try {
      d = await api(`/api/online-time?day=${encodeURIComponent(day)}&start=${encodeURIComponent(start)}`);
    } catch (e) {
      if (mine !== gen) return;
      tiles.innerHTML = ''; list.body.innerHTML = '';
      return empty(list.body, 'That day could not be loaded.');
    }
    if (mine !== gen) return;
    tiles.innerHTML = ''; list.body.innerHTML = '';
    const t = d.totals;

    /* NO VERDICT IS ABSENT WITH A REASON, never two zeroes.
       ─────────────────────────────────────────────────────────────────────
       With no readable start time the endpoint returns no late/on-time counts
       at all, and `fmt(t.late ?? 0)` rendered that as a bold 0 under "Late" —
       a page stating, in the largest type on it, that nobody was late, on the
       morning it was told a start time it could not read. The counts are held
       back and `start_why` says which of the two absences this is. */
    const judged = d.expected_start != null;
    if (!judged) tiles.append(el('p', 'note warn', d.start_why || 'No start time is set.'));
    tiles.append(kpiRow([
      { label: 'Late', value: judged ? fmt(t.late ?? 0) : '—',
        tone: judged && t.late ? 'bad' : null,
        sub: judged ? `came online after ${esc(d.expected_start)}` : 'no start time to judge against' },
      /* Two strengths of claim under one number, and the sub-line says so.
         Most of these came off Uber's own ONLINE transition. The rest are
         people with no timeline at all who were already driving a job by the
         start time — which proves they were online, because a job cannot be
         given to a driver who is not, but does not say when. Merging the two
         silently would let a reader take a bound for a measurement. */
      { label: 'On time', value: judged ? fmt(t.on_time ?? 0) : '—',
        tone: judged && t.on_time ? 'good' : null,
        sub: judged
          ? `online by ${esc(d.expected_start)}`
            + (t.on_time_by_trip
              ? ` · ${fmt(t.on_time_by_trip)} of them proved by a trip, not a timeline`
              : '')
          : 'no start time to judge against' },
      /* The grey number is a first-class figure and not a remainder. It is the
         count of people this page REFUSES to judge, and an operator who cannot
         see it will read the two numbers beside it as the whole fleet. */
      /* The breakdown is the breakdown of the GREY STATES, and it adds up to
         the figure above it only while there is a start time to judge against.
         With none, every person is unjudged — including the five whose online
         time we know perfectly well — and the sub-line went on naming three
         states under a figure of eight. A caption that does not add up to its
         own figure is the same defect the trip-value tile shipped with once
         and was pinned for. */
      { label: 'Cannot be judged', value: judged ? fmt(t.unjudged ?? 0) : fmt(t.people),
        /* Built from `unjudged_by_basis`, which counts only the rows that are
           actually grey. The flat per-basis totals count judged rows too, and
           the moment a basis became clearable — a driver with no online stamp
           who was demonstrably driving before the start — this caption named 4
           states under a figure of 5. */
        sub: judged
          ? Object.entries(t.unjudged_by_basis || {})
            .filter(([, n]) => n > 0)
            .map(([b, n]) => `${fmt(n)} ${GREY[b] || b}`)
            .join(' · ')
            /* The slice of the grey an operator can still act on: they drove,
               so the question is not whether they worked but when they
               started, and their first trip landed too late to answer it. */
            + (t.unjudged_but_worked
              ? ` — ${fmt(t.unjudged_but_worked)} of these did drive, just not before `
                + `${esc(d.expected_start)}`
              : '')
          : `everyone, for want of a start time · ${fmt(t.already_online + t.awaiting_feed
            + t.not_asked + t.cannot_earn + t.absent + (t.worked_elsewhere || 0))} would be `
            + 'grey anyway' },
      /* The denominator is people who COULD have driven. Counting the 30
         suspended and deactivated standings into "of 157 with an Uber account"
         made the fleet look a third idler than it is. */
      /* `worked`, not `drove`: the latter counts Uber bookings alone, which on
         a page that now reads every channel would print a smaller number than
         the table beside it shows first trips for. */
      { label: 'Drove', value: fmt(t.worked ?? t.drove),
        sub: `of ${fmt(t.people - (t.cannot_earn || 0))} allowed to take work on Uber`
          + ((t.worked ?? t.drove) > t.drove
            ? ` · ${fmt((t.worked ?? t.drove) - t.drove)} of them on another channel only` : '') },
    ]));

    if (t.not_asked) {
      /* This said the state "does not fix itself: the roster sweep has no
         schedule", which was true when it was written. The sweep has one now —
         the three-hourly tick covers the whole roster, and a thirty-day pass
         runs weekly — so the warning has to stop telling a reader to give up
         on a number that is about to arrive. It is still a warning: a day
         nothing has reached is a day nobody can be judged on. */
      tiles.append(el('p', 'note warn',
        `${fmt(t.not_asked)} of these ${fmt(t.people - (t.cannot_earn || 0))} people who could `
        + 'have worked have not been asked about for this day, so they are unmeasured rather '
        + 'than late. The timeline tick covers the whole roster every three hours over a '
        + 'two-day window, so a recent day fills in by itself'
        /* If a pass HAS covered this day and somebody is still unasked, the two
           facts sit next to each other and look like a contradiction. They are
           not: a sweep runs per fleet, and these people are on one it did not
           reach. Said outright, because a reader who spots the tension and is
           not given the reason concludes the page is confused. */
        + (d.feed?.roster_swept_at
          ? `. A whole-roster pass last covered this day at ${timeStr(d.feed.roster_swept_at)}`
            + ' — those run per fleet, and these people are on one it did not reach.'
          : ' — none has reached this day yet.')));
    }

    if (!d.rows.length) { empty(list.body, 'Nobody is on the books for that day'); return; }

    list.body.append(tableFrom(d.rows, [
      { label: 'Driver', key: 'name',
        render: (r) => (r.driver_ext_id
          ? entity('driver', r.driver_ext_id, r.name || r.driver_ext_id)
          : esc(r.name || '—')) },
      /* The figure, and the colour that makes the page scannable. A grey chip
         carries the endpoint's own sentence in its title — the reason is the
         product here, and burying it would leave a reader guessing which of the
         four it is. */
      { label: 'Online', key: 'online_minute', num: true,
        render: (r) => (r.online_local
          ? `<span class="tag ${r.late ? 'bad' : 'ok'}" title="${esc(r.online_why)}">`
            + `${esc(r.online_local)}</span>`
            + (r.late ? `<span class="dim" title="after the ${esc(d.expected_start)} you set">`
              + ` +${fmt(r.minutes_late)}m</span>` : '')
          : `<span class="tag ${r.judged_by === 'first_trip' ? 'ok' : 'dim'}" `
            + `title="${esc(r.online_why)}">${esc(r.judged_by === 'first_trip'
              ? `driving by ${r.worked_first_local}` : (GREY[r.online_basis] || '—'))}</span>`) },
      /* Evidence, never a verdict — see the endpoint's header. Shown for every
         row that has one, including the green ones, because "online 06:12,
         first job 07:30" is the gap an operator actually acts on.

         EVERY EARNING CHANNEL, not just Uber. This column read
         `first_trip_local`, which is Uber's own first trip, so it was empty for
         precisely the people it could have helped: a driver with no Uber trip
         is a driver with no Uber timeline, which is what put them in the grey
         bucket in the first place. Measured on production 2026-09-10, 0 of the
         72 unjudged rows carried a value here and 4 of them were driving hotel
         jobs. The channel is named beside the time, because "07:25" means
         something different when Uber never saw it. */
      { label: 'First trip', key: 'worked_first_local', num: true,
        absent: 'A blank here is a driver who took no booking on any channel that day.',
        render: (r) => (r.worked_first_local
          ? `${esc(r.worked_first_local)}`
            + `<span class="dim" title="${esc(`first booking of ${r.worked_trips} on `
              + `${(r.worked_platforms || []).map(sourceLabel).join(' and ')}`)}"> `
            + `${esc(sourceLabel(r.worked_first_platform))} · ${fmt(r.worked_trips)}</span>`
          : '<span class="ent-off" title="no booking on any channel on this day — not '
            + 'Uber, not the hotel channel, not Bolt or Yango">—</span>') },
      { label: 'Phone', key: 'phone',
        render: (r) => (r.phone
          ? `<a href="tel:${esc(dialable(r.phone))}">${esc(dialable(r.phone))}</a>`
          : '<span class="ent-off" title="no phone on this driver’s compliance record">—</span>') },
      { label: 'Car', key: 'plate',
        render: (r) => (r.plate
          ? `${entity('vehicle', r.plate, r.plate)}`
            + (/not a car/.test(r.plate_basis || '')
              ? `<span class="dim" title="${esc(r.plate_basis)}"> ?</span>` : '')
          : '<span class="ent-off">—</span>') },
      { label: 'Where', key: 'where',
        render: (r) => (r.where?.area
          ? `<span title="${esc(`${r.where.area} — ${r.where_why}`)}">${esc(r.where.area)}</span>`
          : `<span class="ent-off" title="${esc(r.where_why || 'no online moment to place')}">—</span>`) },
      { label: 'Portals', key: 'portals',
        render: (r) => (r.portals || []).map((x) => pill(sourceLabel(x), 'plat')).join(' ') },
    ], { sortable: true, sortId: 'online-time',
      defaultSort: { key: 'online_minute', dir: 'desc' } }));

    /* Dubai, like every other clock on this page. The reader's expected start
       is a Dubai wall time and the online moments are compared against it, so
       printing the feed's last run on any other clock invites the reader to
       subtract four hours from the one number on the page that is already
       right. timeStr is ui.js's shared formatter; this page owns no clock. */
    list.body.append(el('p', 'cap', d.feed.note
      + (d.feed.last_run_at
        ? ` The timeline last ran at ${timeStr(d.feed.last_run_at)}.`
        : '')));
  };

  dayIn.onchange = () => { day = dayIn.value || dubaiDay(); draw(); };
  /* Re-fetched rather than recoloured in the browser, so the counts in the
     tiles and the colours in the table can never come from two different
     start times. */
  startIn.onchange = () => { start = startIn.value || '06:00'; saveStart(start); draw(); };
  await draw();
}
