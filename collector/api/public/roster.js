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
  dayStr, dateStr, dtStr, money, pct, sourceLabel, countOf, plural, verdict, foldRows } from './ui.js';
import { q, href, state } from './data.js';

export const ROSTER_TABS = [
  { id: 'all', label: 'Everyone', ic: '◧' },
  { id: 'pipeline', label: 'In the pipeline', ic: '⋯' },
  { id: 'idle', label: 'Earning nothing', ic: '◌' },
  { id: 'blocked', label: 'Stopped', ic: '⊘' },
  { id: 'states', label: 'What each provider says', ic: '❑' },
];

/* The pill a row wears. Only in_pipeline is conditional: the category means
   "no platform this person holds permits work today", and that is a different
   sentence for somebody who has never driven than for somebody who has. */
export const categoryLabel = (r) => (r.category === 'in_pipeline' && r.lifetime_trips > 0
  ? 'Cannot earn now'
  : CAT[r.category]?.label || r.category);

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

/* Two records, one human — stated as a suspicion, never acted on as a merge.
   ─────────────────────────────────────────────────────────────────────────
   bin/numbers-audit.mjs put three payouts against rows on #roster/pipeline
   that did not carry them, and the reason turned out to be the finding rather
   than the fault: "Anoj Gautam" has 646 lifetime trips and "Anoj Gautam Mohan
   Bahadur" has never driven, and they are one man filed twice — once under the
   name a provider issues him by and once under his full legal name.

   personFold cannot see it. It collapses case, whitespace and a repeated word,
   which is the noise it was written for; a name with three extra words in the
   middle is not noise and folding on a shared prefix would merge real people —
   the product's own comments record "Muhammad Khalid" and "Muhammad Khalid Gul"
   as two different drivers, both with payouts.

   Measured on production, 64 of the 133 people this tab lists share every word
   of their name with somebody on the same roster who HAS driven, 31 of them in
   the "never driven" bucket alone. That is half a list an operator reads as
   people to chase. So the suspicion is printed beside the row, with the record
   to check it against, and nothing is merged: showing one person twice is
   recoverable and merging two people is not. */
const nameWords = (n) => String(n || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
export const hasDriven = (p) => (p.trips || 0) > 0 || (p.lifetime_trips || 0) > 0;
/* Same first word, and one name's words a subset of the other's. The first
   word is the guard that keeps "Ali Nawaz Muhammad Nawaz" away from every
   other Muhammad on the roster: a given name leads in every form this fleet's
   providers file, and without it the rule matches on surnames alone. */
export const twinFor = (r, drove) => {
  const a = nameWords(r.name);
  if (a.length < 2) return null;
  const as = new Set(a);
  return drove.find((o) => {
    const b = nameWords(o.name);
    if (b.length < 2 || b[0] !== a[0] || o.name === r.name) return false;
    const bs = new Set(b);
    return [...as].every((w) => bs.has(w)) || [...bs].every((w) => as.has(w));
  }) || null;
};

export async function renderRoster(root) {
  const tab = ROSTER_TABS.some((t) => t.id === state.param) ? state.param : 'all';
  root.innerHTML = '';
  root.append(tabBar(ROSTER_TABS, tab, (id) => href('roster', id === 'all' ? null : id)));
  const host = el('div', 'stack'); root.append(host);
  if (tab === 'states') return rosterStates(host);

  loading(host);
  const d = await q('/api/roster');
  host.innerHTML = '';
  const t = d.totals;

  /* The roster exists to find the people who are NOT earning, and it opened on
     four tiles and a 280-row table 33,019 pixels tall. */
  {
    const notEarning = (t.idle_this_window || 0) + (t.never_started || 0);
    const pct = t.people ? Math.round((notEarning / t.people) * 100) : 0;
    const blocked = t.blocked ?? 0;
    let claim, figure, unit, tone = null, recommend = null;
    if (blocked) {
      tone = 'bad';
      claim = `${countOf(blocked, 'person', 'people')} cannot work on any platform they hold`;
      figure = fmt(blocked); unit = 'stopped everywhere';
      recommend = 'A car in their custody is depreciating, insured and parked. The Stopped '
        + 'everywhere tab lists them with the platforms that refused them.';
    } else if (pct >= 40) {
      tone = 'warn';
      claim = `${pct}% of the roster earned nothing this window`;
      figure = fmt(notEarning); unit = 'not earning';
      recommend = `${fmt(t.never_started || 0)} of them have never taken a booking at all — that is a `
        + 'recruitment pipeline that stalled, not an attendance problem.';
    } else {
      claim = `${fmt(t.working)} of ${fmt(t.people)} people drove this window`;
      figure = fmt(t.working); unit = 'working';
    }
    verdict(host, {
      claim, figure, unit, tone, recommend,
      /* Whichever set the claim counted, that is the set the link opens. */
      cohort: blocked ? 'roster-blocked' : pct >= 40 ? 'roster-idle' : null,
      meta: `${fmt(t.people)} on the books`,
      sub: `${fmt(t.idle_this_window || 0)} could earn and did not, ${fmt(t.never_started || 0)} never have`
        + `${t.multi_platform ? `, and ${fmt(t.multi_platform)} work on more than one platform` : ''}.`,
    });
  }

  host.append(kpiRow([
    { label: 'People on the books', value: fmt(t.people),
      sub: t.multi_platform ? `${fmt(t.multi_platform)} work on more than one platform` : null },
    /* A count with no denominator is half a number. This tile sits beside
       "able to earn, earning nothing" and "recruited, never driven", and the
       three of them only mean anything against the size of the roster. */
    { label: 'Drove in this window', value: fmt(t.working),
      sub: t.people ? `of ${fmt(t.people)} people on the roster` : null, tone: 'good' },
    { label: 'Able to earn, earning nothing', value: fmt(t.idle_this_window),
      tone: t.idle_this_window ? 'warn' : null, sub: 'a licence and a slot standing still',
      cohort: t.idle_this_window ? 'roster-idle' : null },
    { label: 'Recruited, never driven', value: fmt(t.never_started),
      sub: t.people ? `of ${fmt(t.people)} — no booking on any channel, ever` : 'no booking on any channel, ever',
      tone: t.never_started ? 'critical' : null,
      cohort: t.never_started ? 'roster-never-started' : null },
    (() => {
      /* Same correction on the tile. The count is the category's, unchanged —
         it is what the chips and the donut below use — but the sentence under
         it no longer describes everybody in it as new. */
      const back = d.people.filter((x) => x.category === 'in_pipeline' && x.lifetime_trips > 0).length;
      return { label: 'Still waiting to start', value: fmt(t.in_pipeline),
        sub: back
          ? `onboarding or waitlisted — though ${countOf(back, 'of them has', 'of them have')} `
            + 'driven before, so they are not new'
          : 'onboarding or waitlisted',
        cohort: t.in_pipeline ? 'roster-pipeline' : null };
    })(),
    t.unclassified
      ? { label: 'Standing not reported', value: fmt(t.unclassified),
          sub: 'no provider used a word we recognise', tone: 'warn',
          cohort: 'roster-unclassified' }
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
      sub: 'not permitted to work on any platform they hold',
      cohort: t.blocked ? 'roster-blocked' : null },
    { label: 'Holding a car while stopped',
      value: t.blocked ? `${fmt(t.holding_vehicle_while_blocked)} of ${fmt(t.blocked)}` : fmt(t.holding_vehicle_while_blocked),
      tone: t.holding_vehicle_while_blocked ? 'critical' : null,
      sub: 'earns nothing, still depreciates, insures and parks',
      cohort: t.holding_vehicle_while_blocked ? 'roster-blocked-holding' : null },
  ]));

  if (!d.people.length) {
    host.append(note('No provider has reported a roster yet. The standing comes from the live pollers '
      + '— Uber on its status endpoint, Bolt on its driver roster — so it appears after the next '
      + 'collection.'));
    return;
  }

  /* What an absent date means, in the person's own terms.
     null lifetime  we collect no trips for any platform they are on, so we
                    cannot say whether they have ever driven
     0              we looked and there is nothing: they have not
     >0 with no date  they have driven and the record carries no timestamp */
const neverOrUnknown = (r) => (r.lifetime_trips == null
  ? '<span class="ent-off" title="we hold no trip history for any platform this person is on">not observed</span>'
  : r.lifetime_trips
    ? '<span class="ent-off">not recorded</span>'
    : '<span class="ent-off">never</span>');

const FILTER = {
    pipeline: (x) => ['in_pipeline', 'never_started', 'unclassified', 'activity_unknown'].includes(x.category),
    idle: (x) => x.category === 'idle_this_window',
    blocked: (x) => x.category === 'blocked',
  };
  /* Only people who have produced nothing are given a twin. Two records that
     have BOTH driven are two working drivers until something other than a name
     says otherwise; the signal here is a record with no output beside a record
     with a great deal of it. */
  const drove = (d.people || []).filter(hasDriven);
  const people = (d.people || []).map((r) => ({
    /* One column, two sources, one sortable number. The Fares column shows the
       trips' own fares where the channel prices them and the statement's fare
       line where it does not, and a renderer alone would leave the column
       sorting on `revenue` — so every statement-sourced row would sort as
       blank, which is the state the column exists to have stopped reporting. */
    ...r, fares_shown: r.revenue ?? r.statement_fares ?? null,
    twin: hasDriven(r) ? null : twinFor(r, drove),
  }));
  const shown = FILTER[tab] ? people.filter(FILTER[tab]) : people;

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
  const rosterTable = tableFrom(shown, [
    /* The roster exists to find the people who are not earning. A row you
       cannot open is a person you cannot look into. */
    { label: 'Driver', key: 'name',
      render: (r) => (r.driver_ext_id ? entity('driver', r.driver_ext_id, r.name || '(unnamed)') : esc(r.name || '—')) },
    { label: 'Standing', key: 'category',
      /* "Not yet able to earn" is a claim about somebody's FIRST day, and 14 of
         the 20 people in that category on production have driven before — one
         of them 2,779 times, last on May 30. The category is right (no
         platform they hold permits work today, and nobody called them
         stopped); the word "yet" is what is false. A person who has driven and
         cannot today is not new, and telling an operator they are waiting to
         start sends them to the wrong conversation. */
      render: (r) => pill(categoryLabel(r), CAT[r.category]?.tone) },
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
    /* Two sources for one column, and the cell says which it used.
       ─────────────────────────────────────────────────────────────────────
       `revenue` is sum(trip.price), which Uber's export does not carry — so
       this column was empty for 298 of the 335 people on production, on a
       fleet whose weekly statements report the fare week by week. Where the
       trips price the work, the trips win and the cell reads as it always
       has. Where they do not, the statement's own fare line is shown, marked
       so nobody reads it as a per-trip total: it is the gross the rider was
       charged, and the Paid column beside it came out of exactly that money
       rather than sitting alongside it. */
    { label: 'Fares', key: 'fares_shown', num: true,
      absent: 'nobody in this group has a booking that reports a fare, and no statement of '
        + 'theirs reports one either — Uber\'s trip export carries no fare column',
      render: (r) => (r.revenue ? money(r.revenue)
        : r.statement_fares
          ? `${money(r.statement_fares)}<span class="dim" title="no booking of theirs reports a fare; this is the fare line of ${
            r.statement_fare_periods} weekly statement${r.statement_fare_periods === 1 ? '' : 's'}, which the Paid column came out of"> stmt</span>`
          : '<span class="ent-off" title="no booking of theirs reports a fare and no statement reports one — Uber’s export has no fare column">—</span>') },
    /* The money this page was missing. Fares alone left 251 of 280 people
       blank on production — on the page an operator reads to decide who to
       keep supplying with cars. driver_payout_day is what their accounts were
       actually paid, summed across the accounts one person holds.

       Its own column beside the fares, never merged: a fare is what a rider
       was charged and a payout is what reached the fleet after commission. */
    { label: 'Paid', key: 'payout', num: true,
      absent: 'no payout period in this window reaches anybody in this group — which is what '
        + 'being on this list means',
      render: (r) => (r.payout == null
        ? '<span class="ent-off" title="no platform payout in this window covers any of their accounts">—</span>'
        : `${money(r.payout)}${r.payout_days
          ? `<span class="dim" title="days of this window with a payout behind them"> · ${fmt(r.payout_days)}d</span>` : ''}`) },
    /* "not observed" is reserved for a genuinely absent value. This printed it
       whenever `activity_known` was false — and sixteen people here have a
       lifetime count in the same payload, so the cell read "TRIPS EVER: not
       observed" beside "LAST DROVE: Mar 17" with 2,098 in the row. The Last
       drove column already did this correctly. */
    { label: 'Trips ever', key: 'lifetime_trips', num: true,
      render: (r) => (r.lifetime_trips != null ? fmt(r.lifetime_trips)
        : '<span class="ent-off" title="we hold no trip history for any platform this person is on">not observed</span>') },
    /* THREE STATES, not two. These two columns tested `r.lifetime_trips` for
       truthiness, so a null — nobody on this person's platforms is a feed we
       collect — fell into the same branch as a zero and the cell read "never".
       "Never drove" is a claim about a person; the truth for those 31 people
       is a claim about a FEED, and the Trips ever column beside these two has
       always said so in its own words. */
    { label: 'First drove', key: 'first_trip',
      render: (r) => (r.first_trip ? dateStr(r.first_trip) : neverOrUnknown(r)) },
    { label: 'Last drove', key: 'last_ever',
      sortValue: (r) => (r.last_ever ? Date.parse(r.last_ever) : null),
      render: (r) => (r.last_ever
        ? `${dateStr(r.last_ever)} <small class="dim">${fmt(r.days_since_last_trip)}d</small>`
        : neverOrUnknown(r)) },
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
    /* The record this one may already be. Only where at least one row has a
       candidate, so a roster with no duplicates carries no column about them. */
    ...(shown.some((r) => r.twin) ? [{ label: 'Possibly already driving', key: '_twin',
      sortValue: (r) => (r.twin ? -(r.twin.lifetime_trips || 0) : 1),
      render: (r) => (r.twin
        ? `${entity('driver', r.twin.driver_ext_id, r.twin.name)}<span class="dim" title="every word of one of these names appears in the other, and this record has driven"> · ${
          fmt(r.twin.lifetime_trips || 0)} trips</span>`
        : '<span class="ent-off" title="no driving record on this roster shares every word of this name">no match</span>') }] : []),
    { label: 'Reason given', key: 'reason',
      absent: 'no channel gave a reason for anybody in this group — a reason is attached to a '
        + 'suspension, and nobody here is suspended',
      render: (r) => (r.reason
        ? `<span class="wrap" title="${esc(r.reason)}">${esc(String(r.reason).slice(0, 90))}${
          String(r.reason).length > 90 ? '…' : ''}</span>`
        : '—') },
  ], { sortable: true, sortId: 'roster', defaultSort: { key: 'trips', dir: 'desc' } });
  foldRows(rp.body, rosterTable, { shown: 12, total: shown.length, noun: 'person', key: `roster-${tab}` });
  const twins = shown.filter((r) => r.twin);
  if (twins.length) {
    /* The busiest of the candidates, not whichever the current sort put first
       — the sentence calls it the busiest and a table anybody can re-sort must
       not be what decides which name goes in it. */
    const top = twins.reduce((a, r) =>
      ((r.twin.lifetime_trips || 0) > (a.twin.lifetime_trips || 0) ? r : a)).twin;
    rp.body.append(el('p', 'cap',
      `${fmt(twins.length)} of these ${countOf(shown.length, 'person', 'people')} share every word `
      + 'of their name with somebody on this same roster who HAS driven — the busiest of them '
      + `${entity('driver', top.driver_ext_id, top.name)}, with `
      + `${countOf(top.lifetime_trips || 0, 'trip')} behind them. This list is very `
      + 'likely counting those people twice: once under the name a provider issues them by and '
      + 'once under a fuller legal name. They are shown separately rather than folded together, '
      + 'because showing one person twice can be undone and merging two people cannot — the '
      + 'column names the record to check each against.'));
  }

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
      sub: (d.no_state_reported || []).map((r) => sourceLabel(r.platform)).join(', ') || 'none' },
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
    host.append(note(`${d.no_state_reported.map((r) => `${sourceLabel(r.platform)} `
      + `(${countOf(r.n, 'person', 'people')})`).join(', ')} `
      + `${plural(d.no_state_reported.length, 'sends', 'send')} no state at all on the endpoint we read. `
      + 'That is not a classification failure and there is '
      + 'nothing to map — the roster row still carries the useful fact that these people are on the books, '
      + 'and nothing is claimed about whether they can work.'));
  }
  if (!d.by_state.length) return empty(host, 'No provider has reported a roster yet');
  const sp = panel(`What each provider says — ${countOf(d.by_state.length, 'distinct standing')}`,
    'One row per platform and standing, with the provider\u2019s own word beside the bucket we map it '
    + 'to. The vehicle count is what makes a standing expensive: a car attached to somebody who cannot '
    + 'work is depreciating, insured and parked.');
  host.append(sp.panel);
  sp.body.append(tableFrom(d.by_state, [
    { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'Normalised', key: 'state' },
    { label: 'As the provider says it', key: 'state_raw', render: (r) => `<code>${esc(r.state_raw || '—')}</code>` },
    { label: 'People', key: 'n', num: true },
    { label: 'With a vehicle attached', key: 'with_vehicle', num: true,
      render: (r) => `${fmt(r.with_vehicle)} <small class="dim">${pct((r.with_vehicle / r.n) * 100, 0)}</small>` },
  ]));
}
