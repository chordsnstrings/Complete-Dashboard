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
      { label: 'On time', value: judged ? fmt(t.on_time ?? 0) : '—',
        tone: judged && t.on_time ? 'good' : null,
        sub: judged ? `online by ${esc(d.expected_start)}` : 'no start time to judge against' },
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
        sub: judged
          ? `${fmt(t.already_online)} already on · ${fmt(t.awaiting_feed)} not in yet · `
            + `${fmt(t.not_asked)} never asked · ${fmt(t.cannot_earn)} cannot earn · `
            + `${fmt(t.absent)} no event`
          : `everyone, for want of a start time · ${fmt(t.already_online + t.awaiting_feed
            + t.not_asked + t.cannot_earn + t.absent)} would be grey anyway` },
      /* The denominator is people who COULD have driven. Counting the 30
         suspended and deactivated standings into "of 157 with an Uber account"
         made the fleet look a third idler than it is. */
      { label: 'Drove', value: fmt(t.drove),
        sub: `of ${fmt(t.people - (t.cannot_earn || 0))} allowed to take work`
          + (t.cannot_earn ? ` · ${fmt(t.cannot_earn)} more cannot` : '') },
    ]));

    if (t.not_asked) {
      /* Named on the page rather than left in a tooltip, because it is the one
         state that does not fix itself: the roster sweep has no schedule. */
      tiles.append(el('p', 'note warn',
        `${fmt(t.not_asked)} of these ${fmt(t.people - (t.cannot_earn || 0))} people who could `
        + 'have worked were never asked about. Uber\'s '
        + 'timeline is only requested for drivers who took a trip in the previous two days, so '
        + 'somebody who worked nowhere near a car is not "late" here — they are unmeasured, and '
        + 'will stay that way until a whole-roster sweep runs.'));
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
          : `<span class="tag dim" title="${esc(r.online_why)}">${esc(GREY[r.online_basis] || '—')}</span>`) },
      /* Evidence, never a verdict — see the header. Shown for every row that
         has one, including the green ones, because "online 06:12, first job
         07:30" is the gap an operator actually acts on. */
      { label: 'First trip', key: 'first_trip_local', num: true,
        render: (r) => (r.first_trip_local
          ? `${esc(r.first_trip_local)}<span class="dim"> · ${fmt(r.trips)}</span>`
          : '<span class="ent-off" title="no Uber booking on this day">—</span>') },
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
