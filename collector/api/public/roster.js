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
  dayStr, dtStr, money, pct } from './ui.js';
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
    { label: 'Drove in this window', value: fmt(t.working), tone: 'good' },
    { label: 'Able to earn, earning nothing', value: fmt(t.idle_this_window),
      tone: t.idle_this_window ? 'warn' : null, sub: 'a licence and a slot standing still' },
    { label: 'Recruited, never driven', value: fmt(t.never_started),
      tone: t.never_started ? 'critical' : null },
    { label: 'Still waiting to start', value: fmt(t.in_pipeline), sub: 'onboarding or waitlisted' },
    t.unclassified
      ? { label: 'Standing not reported', value: fmt(t.unclassified),
          sub: 'no provider used a word we recognise', tone: 'warn' }
      : null,
    { label: 'Holding a car while stopped', value: fmt(t.holding_vehicle_while_blocked),
      tone: t.holding_vehicle_while_blocked ? 'critical' : null,
      sub: 'earns nothing, still costs' },
  ]));

  if (!d.people.length) {
    host.append(note('No provider has reported a roster yet. The standing comes from the live pollers '
      + '— Uber on its status endpoint, Bolt on its driver roster — so it appears after the next '
      + 'collection.'));
    return;
  }

  const FILTER = {
    pipeline: (x) => ['in_pipeline', 'never_started', 'unclassified'].includes(x.category),
    idle: (x) => x.category === 'idle_this_window',
    blocked: (x) => x.category === 'blocked',
  };
  const shown = FILTER[tab] ? d.people.filter(FILTER[tab]) : d.people;

  if (tab === 'all') {
    const g = el('div', 'grid g2'); host.append(g);
    const { panel: p1, body: b1 } = panel('Everyone, by what they are doing', null);
    const counts = Object.keys(CAT).map((k) => ({ label: CAT[k].label, n: d.people.filter((x) => x.category === k).length }))
      .filter((x) => x.n);
    donut(b1, counts, { onClick: (x) => {
      const k = Object.keys(CAT).find((c) => CAT[c].label === x.label);
      const to = { in_pipeline: 'pipeline', never_started: 'pipeline', idle_this_window: 'idle', blocked: 'blocked' }[k];
      if (to) location.hash = href('roster', to);
    } });
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

  host.append(tableFrom(shown, [
    { label: 'Driver', key: 'name', render: (r) => esc(r.name || '—') },
    { label: 'Standing', key: 'category',
      render: (r) => pill(CAT[r.category]?.label || r.category, CAT[r.category]?.tone) },
    { label: 'Platforms', key: 'platforms',
      render: (r) => `${(r.platforms || []).join(', ')}${r.accounts > (r.platforms || []).length
        ? ` <small class="dim">${r.accounts} accounts</small>` : ''}` },
    { label: 'Reported as', key: 'states', render: (r) => esc((r.states || []).join(', ')) },
    { label: 'Vehicle', key: 'plates',
      render: (r) => ((r.plates || []).length
        ? (r.plates || []).slice(0, 2).map((p2) => entity('vehicle', p2, p2)).join(' ')
        : '<span class="ent-off">none attached</span>') },
    { label: 'Trips this window', key: 'trips', num: true },
    { label: 'Revenue', key: 'revenue', num: true, render: (r) => money(r.revenue) },
    { label: 'Trips ever', key: 'lifetime_trips', num: true, render: (r) => fmt(r.lifetime_trips || 0) },
    { label: 'Last drove', key: 'last_ever',
      render: (r) => (r.last_ever
        ? `${dayStr(r.last_ever)} <small class="dim">${fmt(r.days_since_last_trip)}d</small>`
        : '<span class="ent-off">never</span>') },
    { label: 'Score', key: 'score', num: true, render: (r) => (r.score == null ? '—' : fmt(r.score)) },
    { label: 'Reason given', key: 'reason',
      render: (r) => (r.reason ? esc(String(r.reason).slice(0, 90)) : '—') },
  ]));

  if (tab === 'blocked') {
    const holding = shown.filter((x) => x.holding_vehicle_while_blocked);
    if (holding.length) {
      host.append(note(`${fmt(holding.length)} of these still have a vehicle attached: `
        + `${holding.flatMap((x) => x.plates || []).slice(0, 8).join(', ')}. A car assigned to somebody `
        + 'who is not allowed to drive it earns nothing and still depreciates, insures and parks.'));
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
    { label: 'Roster rows', value: fmt(d.rows) },
    { label: 'Oldest observation', value: d.oldest_observation ? dtStr(d.oldest_observation) : '—',
      sub: 'a roster nobody has refreshed describes the past' },
    { label: 'Newest observation', value: d.newest_observation ? dtStr(d.newest_observation) : '—' },
    { label: 'Words we could not classify', value: fmt(d.unknown_states.length),
      tone: d.unknown_states.length ? 'warn' : 'good' },
  ]));
  if (d.unknown_states.length) {
    const { panel: p, body } = panel('States we did not recognise',
      'These are kept as the provider wrote them rather than guessed into a bucket. Guessing wrong '
      + 'here describes somebody’s employment incorrectly.');
    body.append(tableFrom(d.unknown_states, [
      { label: 'Platform', key: 'platform' },
      { label: 'The provider’s word', key: 'word', render: (r) => `<code>${esc(r.word || '(empty)')}</code>` },
      { label: 'People', key: 'n', num: true },
    ]));
    host.append(p);
  }
  if (!d.by_state.length) return empty(host, 'No provider has reported a roster yet');
  host.append(tableFrom(d.by_state, [
    { label: 'Platform', key: 'platform' },
    { label: 'Normalised', key: 'state' },
    { label: 'As the provider says it', key: 'state_raw', render: (r) => `<code>${esc(r.state_raw || '—')}</code>` },
    { label: 'People', key: 'n', num: true },
    { label: 'With a vehicle attached', key: 'with_vehicle', num: true,
      render: (r) => `${fmt(r.with_vehicle)} <small class="dim">${pct((r.with_vehicle / r.n) * 100, 0)}</small>` },
  ]));
}
