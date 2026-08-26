/* The roster — who is on the books, and who is actually earning.
   ──────────────────────────────────────────────────────────────────────────
   No single provider can answer the questions on this page. Uber knows a driver
   is on its waitlist; Bolt knows one is suspended and which car they still
   hold; Yango and the corporate channel each know a third thing. Held together
   and joined against the trips each person actually drove, the four become:

     #roster              everyone, by what they are doing
     #roster/pipeline     recruited, not yet able to earn
     #roster/idle         able to earn, earning nothing
     #roster/blocked      stopped — and whether they still hold a car
     #roster/states       what each provider says, including words we could
                          not classify

   The last tab exists because a state we do not recognise must be visible
   rather than quietly bucketed: guessing wrong here describes somebody's
   employment incorrectly. */

import { donut, hbars, empty, fmt } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, tabBar, note, pill, entity,
  dayStr, dateStr, dtStr, money, pct, sourceLabel, countOf, plural } from './ui.js';
import { q, href, state } from './data.js';

export const ROSTER_TABS = [
  { id: 'all', label: 'Everyone', ic: '◧' },
  { id: 'pipeline', label: 'In the pipeline', ic: '⋯' },
  { id: 'idle', label: 'Earning nothing', ic: '◌' },
  { id: 'blocked', label: 'Stopped', ic: '⊘' },
  { id: 'states', label: 'What each provider says', ic: '❑' },
];

const CAT = {
  working: { label: 'Working', tone: 'ok' },
  idle_this_window: { label: 'No trip this window', tone: 'warn' },
  never_started: { label: 'Never driven', tone: 'critical' },
  in_pipeline: { label: 'Not yet able to earn', tone: 'serious' },
  blocked: { label: 'Stopped everywhere', tone: 'critical' },
  // No provider described this person in a word we recognise, so nothing is
  // claimed about whether they can work.
  unclassified: { label: 'Standing not reported', tone: null },
  // We hold no trips for any platform this person is on, so their output is
  // unobserved rather than zero.
  activity_unknown: { label: 'Output not observed', tone: 'warn' },
};

export async function renderRoster(root) {
  const tab = ROSTER_TABS.some((t) => t.id === state.param) ? state.param : 'all';
  root.innerHTML = '';
  root.append(tabBar(ROSTER_TABS, tab, (id) => href('roster', id === 'all' ? null : id)));
  const host = el('div'); root.append(host);
  if (tab === 'states') return rosterStates(host);

  loading(host);
  const d = await q('/api/roster');
  host.innerHTML = '';
  const t = d.totals;

  host.append(kpiRow([
    { label: 'People on the books', value: fmt(t.people),
      sub: t.multi_platform ? `${fmt(t.multi_platform)} work on more than one platform` : null },
    /* A count with no denominator is half a number. This tile sits beside
       "able to earn, earning nothing" and "recruited, never driven", and the
       three of them only mean anything against the size of the roster. */
    { label: 'Drove in this window', value: fmt(t.working),
      sub: t.people ? `of ${fmt(t.people)} people on the roster` : null, tone: 'good' },
    { label: 'Able to earn, earning nothing', value: fmt(t.idle_this_window),
      tone: t.idle_this_window ? 'warn' : null, sub: 'a licence and a slot standing still' },
    { label: 'Recruited, never driven', value: fmt(t.never_started),
      sub: t.people ? `of ${fmt(t.people)} — no booking on any channel, ever` : 'no booking on any channel, ever',
      tone: t.never_started ? 'critical' : null },
    { label: 'Still waiting to start', value: fmt(t.in_pipeline), sub: 'onboarding or waitlisted' },
    t.unclassified
      ? { label: 'Standing not reported', value: fmt(t.unclassified),
          sub: 'no provider used a word we recognise', tone: 'warn' }
      : null,
    t.activity_unknown
      ? { label: 'Output not observed', value: fmt(t.activity_unknown),
          sub: 'we hold no trips for their platform', tone: 'warn' }
      : null,
    /* The denominator for the tile beside it. "Holding a car while stopped 31"
       is a numerator with no base — 31 of how many stopped people? — and
       `blocked` was in the same totals object and shown nowhere. */
    { label: 'Stopped everywhere', value: fmt(t.blocked),
      tone: t.blocked ? 'critical' : 'good',
      sub: 'not permitted to work on any platform they hold' },
    { label: 'Holding a car while stopped',
      value: t.blocked ? `${fmt(t.holding_vehicle_while_blocked)} of ${fmt(t.blocked)}` : fmt(t.holding_vehicle_while_blocked),
      tone: t.holding_vehicle_while_blocked ? 'critical' : null,
      sub: 'earns nothing, still depreciates, insures and parks' },
  ]));

  if (!d.people.length) {
    host.append(note('No provider has reported a roster yet. The standing comes from the live pollers '
      + '— Uber on its status endpoint, Bolt on its driver roster — so it appears after the next '
      + 'collection.'));
    return;
  }

  const FILTER = {
    pipeline: (x) => ['in_pipeline', 'never_started', 'unclassified', 'activity_unknown'].includes(x.category),
    idle: (x) => x.category === 'idle_this_window',
    blocked: (x) => x.category === 'blocked',
  };
  const shown = FILTER[tab] ? d.people.filter(FILTER[tab]) : d.people;

  if (tab === 'all') {
    const g = el('div', 'grid g2'); host.append(g);
    const { panel: p1, body: b1 } = panel('Everyone, by what they are doing', null);
    const counts = Object.keys(CAT).map((k) => ({ label: CAT[k].label, n: d.people.filter((x) => x.category === k).length }))
      .filter((x) => x.n);
    /* Every slice has a destination now. Three of six navigated and three —
       Working, Output not observed and Standing not reported, 51% of the ring —
       took the pointer cursor and did nothing. `unclassified` and
       `activity_unknown` are already in the pipeline tab's filter; `working`
       goes to the directory filtered to the people who drove. */
    const SLICE_TO = { in_pipeline: ['roster', 'pipeline'], never_started: ['roster', 'pipeline'],
      unclassified: ['roster', 'pipeline'], activity_unknown: ['roster', 'pipeline'],
      idle_this_window: ['roster', 'idle'], blocked: ['roster', 'blocked'],
      working: ['drivers'] };
    const keyOf = (label) => Object.keys(CAT).find((c) => CAT[c].label === label);
    donut(b1, counts, {
      clickable: (x) => !!SLICE_TO[keyOf(x.label)],
      onClick: (x) => { const to = SLICE_TO[keyOf(x.label)]; if (to) location.hash = href(...to); },
    });
    b1.append(el('p', 'cap', 'Every slice opens the people behind it.'));
    g.append(p1);
    const { panel: p2, body: b2 } = panel('How many platforms each person works',
      'One person with three platform accounts is one person. The fold is by name, which is the only key that spans providers.');
    const byAcc = {};
    d.people.forEach((x) => { const n = (x.platforms || []).length || 1; byAcc[n] = (byAcc[n] || 0) + 1; });
    hbars(b2, Object.entries(byAcc).map(([k, n]) => ({ label: `${k} platform${k === '1' ? '' : 's'}`, n })));
    g.append(p2);
  }

  if (!shown.length) {
    host.append(note(tab === 'idle'
      ? 'Everyone who can earn drove at least once in this window.'
      : tab === 'blocked' ? 'Nobody is stopped on every platform they hold.'
        : 'Nobody is waiting to start.'));
    return;
  }

  const anyKm = shown.some((r) => r.km != null);
  const anyScore = shown.some((r) => r.score != null);
  const anyObs = shown.some((r) => r.observed_at);

  /* The largest table on the page had no heading at all.
     ─────────────────────────────────────────────────────────────────────────
     280 rows and fifteen columns appended straight to the host, while every
     other table in the product — including the two small ones further down
     this same file — sits in a panel that names it. A reader landing on
     #roster/blocked saw a table and had to work out from its contents which
     of the four lists they were looking at, and the tab bar above is a filter,
     not a title.

     Named for the tab, with the count, so the heading also answers "is this
     everyone or a subset". */
  const TITLE = {
    all: ['Everyone on the books', 'Every person any provider has a roster row for, whether or not '
      + 'they have ever driven.'],
    /* This tab is a union of four categories — not yet able to earn, never
       driven, standing not reported, and output not observed — and it was
       titled for the smallest of them: "Waiting to start — 113 people" sat
       above a page whose own tile read "Still waiting to start 18". */
    pipeline: ['Not yet earning', 'Everyone the roster holds who has produced nothing we can see: '
      + 'onboarding or waitlisted, recruited but never driven, described in a word no provider '
      + 'shares, or on a platform whose trips we do not collect. The Standing column says which.'],
    idle: ['Able to earn, earning nothing', 'A licence and a slot on at least one platform, and no '
      + 'booking in this window.'],
    blocked: ['Stopped everywhere', 'Not permitted to work on any platform they hold. A car in '
      + 'their custody is depreciating, insured and parked.'],
  };
  const [rTitle, rSub] = TITLE[tab] || TITLE.all;
  const rp = panel(`${rTitle} — ${countOf(shown.length, 'person', 'people')}`, rSub);
  host.append(rp.panel);
  rp.body.append(tableFrom(shown, [
    /* The roster exists to find the people who are not earning. A row you
       cannot open is a person you cannot look into. */
    { label: 'Driver', key: 'name',
      render: (r) => (r.driver_ext_id ? entity('driver', r.driver_ext_id, r.name || '(unnamed)') : esc(r.name || '—')) },
    { label: 'Standing', key: 'category',
      render: (r) => pill(CAT[r.category]?.label || r.category, CAT[r.category]?.tone) },
    { label: 'Platforms', key: 'platforms',
      render: (r) => `${(r.platforms || []).map(sourceLabel).join(', ')}${r.accounts > (r.platforms || []).length
        ? ` <small class="dim">${r.accounts} accounts</small>` : ''}` },
    { label: 'Reported as', key: 'states', render: (r) => esc((r.states || []).join(', ')) },
    { label: 'Vehicle', key: 'plates',
      render: (r) => ((r.plates || []).length
        ? (r.plates || []).slice(0, 2).map((p2) => entity('vehicle', p2, p2)).join(' ')
        : '<span class="ent-off" title="no custody record attaches a vehicle to this person">none attached</span>') },
    { label: 'Trips this window', key: 'trips', num: true },
    { label: 'Completed', key: 'completed', num: true,
      render: (r) => (r.completed == null
        ? '<span class="ent-off" title="no platform of theirs reports an outcome">—</span>'
        : fmt(r.completed)) },
    ...(anyKm ? [{ label: 'Km', key: 'km', num: true,
      absent: 'nobody in this group has driven in this window, so there is no distance to report '
        + '— that is what puts them on this list',
      render: (r) => fmt(r.km) }] : []),
    { label: 'Fares', key: 'revenue', num: true,
      absent: 'nobody in this group has a booking that reports a fare — Uber\'s trip export '
        + 'carries no fare column, and on the pipeline and idle lists Uber is all of the work',
      render: (r) => (r.revenue ? money(r.revenue)
        : '<span class="ent-off" title="no booking of theirs reports a fare — Uber’s export has no fare column">—</span>') },
    /* "not observed" is reserved for a genuinely absent value. This printed it
       whenever `activity_known` was false — and sixteen people here have a
       lifetime count in the same payload, so the cell read "TRIPS EVER: not
       observed" beside "LAST DROVE: Mar 17" with 2,098 in the row. The Last
       drove column already did this correctly. */
    { label: 'Trips ever', key: 'lifetime_trips', num: true,
      render: (r) => (r.lifetime_trips != null ? fmt(r.lifetime_trips)
        : '<span class="ent-off" title="we hold no trip history for any platform this person is on">not observed</span>') },
    { label: 'First drove', key: 'first_trip',
      render: (r) => (r.first_trip ? dateStr(r.first_trip)
        : (r.lifetime_trips ? '<span class="ent-off">not recorded</span>' : '<span class="ent-off">never</span>')) },
    { label: 'Last drove', key: 'last_ever',
      sortValue: (r) => (r.last_ever ? Date.parse(r.last_ever) : null),
      render: (r) => (r.last_ever
        ? `${dateStr(r.last_ever)} <small class="dim">${fmt(r.days_since_last_trip)}d</small>`
        : r.lifetime_trips ? '<span class="ent-off">not recorded</span>'
          : '<span class="ent-off">never</span>') },
    /* Named for what it is. A bare "Score" column that is Bolt's rating and
       null for 211 of 278 people reads as a fleet score nobody has. */
    ...(anyScore ? [{ label: 'Bolt score', key: 'score', num: true,
      render: (r) => (r.score == null
        ? '<span class="ent-off" title="only Bolt publishes a driver score, and only for its own roster">—</span>'
        : fmt(r.score)) }] : []),
    ...(anyObs ? [{ label: 'Roster seen', key: 'observed_at',
      sortValue: (r) => (r.observed_at ? Date.parse(r.observed_at) : null),
      render: (r) => (r.observed_at
        ? `${dateStr(r.observed_at)}<span class="dim" title="a roster nobody has refreshed describes the past"> ${
          fmt(Math.floor((Date.now() - Date.parse(r.observed_at)) / 864e5))}d ago</span>`
        : '<span class="ent-off">not recorded</span>') }] : []),
    /* A reason is a fact about a SUSPENSION. Filtered to the pipeline or the
       idle list — people who are on the books and simply not driving — nobody
       has one, and 113 dashes under "Reason given" reads as a missing feed. */
    { label: 'Reason given', key: 'reason',
      absent: 'no channel gave a reason for anybody in this group — a reason is attached to a '
        + 'suspension, and nobody here is suspended',
      render: (r) => (r.reason
        ? `<span class="wrap" title="${esc(r.reason)}">${esc(String(r.reason).slice(0, 90))}${
          String(r.reason).length > 90 ? '…' : ''}</span>`
        : '—') },
  ], { sortable: true, sortId: 'roster', defaultSort: { key: 'trips', dir: 'desc' } }));

  if (tab === 'blocked') {
    const holding = shown.filter((x) => x.holding_vehicle_while_blocked);
    if (holding.length) {
      /* One row per CAR, with how many stopped people hold it. The note listed
         plates as plain text and printed duplicates — L59841 appeared twice,
         which is two deactivated drivers on one vehicle and reads as a typo —
         then truncated at eight of thirty-one with no count. And every plate
         above this note is a link while these were not. */
      const perPlate = new Map();
      holding.forEach((x) => (x.plates || []).forEach((p2) => {
        perPlate.set(p2, (perPlate.get(p2) || 0) + 1);
      }));
      const plates = [...perPlate.entries()].sort((a, b) => b[1] - a[1]);
      const n = el('div', 'note');
      n.innerHTML = `${countOf(holding.length, 'stopped driver')} still `
        + `${plural(holding.length, 'has', 'have')} a vehicle attached, across `
        + `${countOf(plates.length, 'car')}: `
        + plates.slice(0, 12).map(([p2, k]) => entity('vehicle', p2, p2)
          + (k > 1 ? `<span class="dim" title="${k} stopped drivers hold this car"> ×${k}</span>` : '')).join(', ')
        + (plates.length > 12 ? ` <span class="dim">and ${fmt(plates.length - 12)} more</span>` : '')
        + '. A car assigned to somebody who is not allowed to drive it earns nothing and still '
        + 'depreciates, insures and parks. A ×2 is two stopped drivers on one vehicle, not a duplicate.';
      host.append(n);
    }
  }
  if (tab === 'idle') {
    host.append(note('These people are permitted to work on at least one platform and took no booking '
      + 'in this window. Widen the range above before acting on it — a driver on leave and a driver '
      + 'who has quietly stopped look identical inside seven days.'));
  }
  host.append(note(d.caveat));
}

async function rosterStates(host) {
  loading(host);
  const d = await q('/api/roster/states');
  host.innerHTML = '';
  host.append(kpiRow([
    /* Rows, not people: a person with an account on two channels is two rows,
       and the roster page above this one counts people. The two numbers differ
       and nothing said which was which. */
    { label: 'Roster rows', value: fmt(d.rows),
      sub: 'one per platform account — a person on two channels is two rows' },
    { label: 'Oldest observation', value: d.oldest_observation ? dtStr(d.oldest_observation) : '—',
      sub: 'a roster nobody has refreshed describes the past' },
    { label: 'Newest observation', value: d.newest_observation ? dtStr(d.newest_observation) : '—' ,
      sub: 'how current the standings on this page are'},
    { label: 'Words we could not classify', value: fmt((d.unrecognised_words || []).length),
      tone: (d.unrecognised_words || []).length ? 'warn' : 'good',
      sub: 'a mapping we could add' },
    { label: 'Providers reporting no state', value: fmt((d.no_state_reported || []).length),
      sub: (d.no_state_reported || []).map((r) => r.platform).join(', ') || 'none' },
  ]));
  if ((d.unrecognised_words || []).length) {
    const { panel: p, body } = panel('States we did not recognise',
      'The provider sent a word and we have no mapping for it. These are kept as written rather than '
      + 'guessed into a bucket — guessing wrong here describes somebody’s employment incorrectly — and '
      + 'each one is a mapping that could be added.');
    body.append(tableFrom(d.unrecognised_words, [
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      { label: 'The provider’s word', key: 'word', render: (r) => `<code>${esc(r.word)}</code>` },
      { label: 'People', key: 'n', num: true },
    ]));
    host.append(p);
  }
  if ((d.no_state_reported || []).length) {
    host.append(note(`${d.no_state_reported.map((r) => `${r.platform} (${fmt(r.n)} people)`).join(', ')} `
      + 'send no state at all on the endpoint we read. That is not a classification failure and there is '
      + 'nothing to map — the roster row still carries the useful fact that these people are on the books, '
      + 'and nothing is claimed about whether they can work.'));
  }
  if (!d.by_state.length) return empty(host, 'No provider has reported a roster yet');
  host.append(tableFrom(d.by_state, [
    { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'Normalised', key: 'state' },
    { label: 'As the provider says it', key: 'state_raw', render: (r) => `<code>${esc(r.state_raw || '—')}</code>` },
    { label: 'People', key: 'n', num: true },
    { label: 'With a vehicle attached', key: 'with_vehicle', num: true,
      render: (r) => `${fmt(r.with_vehicle)} <small class="dim">${pct((r.with_vehicle / r.n) * 100, 0)}</small>` },
  ]));
}
