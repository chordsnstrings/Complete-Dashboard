// Fleet Dashboard — a multipage app behind a hash router.
// Views live in this file; the per-driver detail pages live in driver.js, and
// everything shared between them (panels, tables, modals, routing, fetching)
// lives in ui.js and data.js so the two cannot drift apart.
import { barChart, gapBars, areaChart, donut, hbars, heatmap, scatter, stackedBar, fmt, empty, showTip, hideTip } from './charts.js';
import { $, el, esc, panel, loading, tableFrom, kpiRow, tabBar, pill, note, entity,
  dayStr, dateStr, dtStr, timeStr, hourStr, money, pct, custody, custodyAsOf,
  sourceLabel, tierLabel, plural, countOf, UBER_FARE, sentence, exportRow,
  verdict, dominantBar, foldRows} from './ui.js';
import { dubaiDay, TZ, TZ_LABEL } from './tz.js';
import { state, api, params, q, qAll, href, parseHash, navigate, store, setFilter,
  windowDates, newRender, currentGen, alive, hidesRange, hidesChannel, hrefFilter } from './data.js';
import { volatilePath } from './swr.js';
import { fleetVerdict, shareOf } from './verdicts.js';
import { renderDriver, renderDriverDirectory, DRIVER_TABS } from './driver.js';
import { renderVehicle, renderVehicleDirectory, VEHICLE_TABS } from './vehicle.js';
import { renderCauses } from './causes.js';
import { renderCorporate, renderProperty, CORP_TABS, PROPERTY_TABS } from './corporate.js';
import { renderTrip } from './trip.js';
import { renderSettlement, SETTLE_TABS } from './settlement.js';
import { renderCoverage } from './coverage.js';
import { renderCorridors } from './corridors.js';
import { renderAnalyst, ANALYST_TABS } from './analyst.js';
import { renderProviders, renderProviderField } from './providers.js';
import { renderRoster, ROSTER_TABS } from './roster.js';
import { renderDay } from './day.js';
import { renderSegments, renderSegment, segmentTable } from './segments.js';
import { renderSlot } from './slot.js';
import { renderPlaybook } from './playbook.js';
import { renderForecast } from './forecast.js';
import { renderRetention } from './retention.js';
import { renderCapacity } from './capacity.js';
import { renderRevenue } from './revenue.js';
import { renderReconcile } from './reconcile.js';
import { renderEconomics, UNIT_TABS } from './economics.js';
import { renderPerformers, renderPerformer } from './performers.js';
import { renderCompare } from './compare.js';

/* Postgres sends a DATE over JSON as a full ISO timestamp, so `d.d` is
   "2026-08-21T00:00:00.000Z" and not "2026-08-21". Passing that straight back
   as a filter produced a zero-width range — every "click a day" drill opened an
   empty modal titled with a raw timestamp. */
const dayKey = (v) => String(v ?? '').slice(0, 10);

/* Uber publishes these as fractions (0.79 against a 0.85 target), and the table
   rendered the raw number beside a column headed "Target". */
const pctOf = (v) => (v == null || !Number.isFinite(Number(v)) ? '—'
  : Number(v) <= 1 ? `${(Number(v) * 100).toFixed(1)}%` : fmt(v, 1));

/* Whether a published target is being missed. `flagged` is a JSON array of the
   drivers Uber named, so testing it for truthiness marked every row — empty
   array included — as below target. Cancellation is the one metric where LOWER
   is better, so the direction is read from the rule name. */
function missingTarget(r) {
  const org = Number(r.org_value), target = Number(r.target_value);
  if (!Number.isFinite(org) || !Number.isFinite(target)) return null;
  const lowerIsBetter = /cancel/i.test(String(r.rec_type || ''));
  return lowerIsBetter ? org > target : org < target;
}

/* A breakdown that quietly drops the rows a provider never labelled reads as a
   complete picture of a subset. Telematics trips carry no payment type at all,
   so the old donut was 80% "unknown" — and once that bucket was removed the
   chart became honest about the categories but silent about the coverage. This
   draws the labelled rows and states what is missing underneath. */
function paymentDonut(host, detail) {
  host.innerHTML = '';
  const groups = (detail && detail.groups) || [];
  if (!groups.length) { empty(host, 'No trip in this range records how it was paid'); return; }
  /* Grouped by SETTLEMENT ROUTE, not by the processor's name. Charted raw this
     was a nineteen-slice donut whose largest slice was `braintree` — the name
     of a payment integration, sitting beside `zaakpay` and `kcp_pg` as if the
     three were different kinds of business, while `room-charge` and
     `posted-for-salary` (money somebody owes us) were folded away past the
     eighth slice. The classes are the same ones the Settlement page uses, so
     the two pages cannot disagree. */
  const CLASS = {
    cash: 'Cash', 'cash-driver': 'Cash', 'cash-supervisor': 'Cash',
    'pos-driver': 'Card', 'pos-supervisor': 'Card', braintree: 'Card', zaakpay: 'Card',
    kcp_pg: 'Card', card: 'Card', credit_card: 'Card',
    apple_pay: 'Wallet', google_pay: 'Wallet', paypal: 'Wallet', alipay2: 'Wallet',
    digital: 'Wallet', wallet: 'Wallet', cashless: 'Wallet',
    'room-charge': 'On account', 'hotel-charge': 'On account', company: 'On account',
    corporate: 'On account', invoice: 'On account',
    'posted-for-salary': 'Salary deduction', salary: 'Salary deduction',
    'foc-complimentary': 'Complimentary', foc: 'Complimentary', complimentary: 'Complimentary',
    offline: 'Settled off-platform', derivative: 'Adjustment',
  };
  const folded = new Map();
  groups.forEach((g) => {
    const k = CLASS[String(g.label || '').toLowerCase()] || 'Other';
    const cur = folded.get(k) || { label: k, n: 0, revenue: 0, priced: 0, labels: [] };
    cur.n += g.n; cur.revenue += Number(g.revenue) || 0; cur.priced += g.priced_n || 0;
    cur.labels.push(g.label);
    folded.set(k, cur);
  });
  const rows = [...folded.values()].sort((a, b) => b.n - a.n);
  /* Each class opens the tab that answers it. Every slice used to open the
     bare #settlement mix page, which is the one page the reader was already
     looking at a version of — the useful destinations are "where that cash
     currently sits" and "what is outstanding, and from whom". */
  const CLASS_TAB = {
    Cash: ['settlement', 'cash'], 'On account': ['settlement', 'receivables'],
    'Salary deduction': ['settlement', 'receivables'], Card: ['settlement'],
    Wallet: ['settlement'], Complimentary: ['corporate', 'leakage'],
  };
  donut(host, rows, {
    clickable: (d) => !!CLASS_TAB[d.label],
    onClick: (d) => { const t = CLASS_TAB[d.label]; if (t) location.hash = href(...t); },
  });
  const owed = rows.filter((r) => ['On account', 'Salary deduction'].includes(r.label));
  const cap = el('p', 'cap');
  cap.innerHTML = [
    detail.unlabelled_trips
      ? `${fmt(detail.unlabelled_trips)} of ${fmt(detail.total_trips)} trips record no payment type`
        + `${detail.unlabelled_platforms?.length ? ` (${esc(detail.unlabelled_platforms.map(sourceLabel).join(', '))})` : ''}`
        + ' and are left out rather than counted as cash.'
      : '',
    owed.length
      ? `${fmt(owed.reduce((a, r) => a + r.n, 0))} settled after the ride — `
        + `<a class="lnk" href="${href('settlement', 'receivables')}">what is outstanding, and from whom</a>.`
      : '',
    'Cash, on account and salary deduction each open their own page; card and wallet carry no exposure.',
  ].filter(Boolean).join(' ');
  host.append(cap);
}

/* ── the payout tree, drawn as a tree ─────────────────────────────────────
   A payout breakdown is nested: `net fare` is INSIDE `earnings`, `cash
   collected` is inside `payouts`, `toll` and `airport fee` are inside
   `refunds`. Charted as siblings, every amount appeared twice — "net fare
   34,199" beside "earnings 33,905", "cash collected −10,248" beside "payouts
   −10,248" — and the bars summed to roughly double the payout while looking
   like a decomposition of it. `parent` was carried into a title attribute and
   nowhere else.

   Roots are bars and total to the payout. Children are listed under the root
   they belong to, with their own share of it. Deductions keep their sign,
   because a clawback drawn as a magnitude is a credit. */
function componentTree(components) {
  const host = el('div');
  const agg = new Map();
  for (const c of components) {
    const key = `${c.parent || ''}|${c.category}`;
    const cur = agg.get(key)
      || { label: String(c.category).replace(/_/g, ' '), parent: c.parent || null,
        amount: 0, currency: c.currency, drivers: null };
    cur.amount += +c.amount || 0;
    /* How many people a component covers. The endpoint aggregates to the fleet
       now, so this is the one thing the fold would otherwise destroy — and it
       is the difference between a deduction everybody carries and one that
       applies to three drivers. The max, not a sum, because the endpoint
       returns one row per component already. */
    if (c.drivers != null) cur.drivers = Math.max(cur.drivers ?? 0, +c.drivers || 0);
    agg.set(key, cur);
  }
  const all = [...agg.values()];
  const roots = all.filter((c) => !c.parent).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const kids = all.filter((c) => c.parent);
  if (!roots.length) {
    /* Every row names a parent we were not given: chart them flat rather than
       drawing nothing, and say that the nesting is missing. */
    hbars(host, kids.map((c) => ({ label: `${c.parent} · ${c.label}`, n: c.amount })),
      { valueFmt: (v) => money(v),
        legend: [['--b400', 'added to the payout'], ['--s2', 'deducted (cash already taken, fees)']] });
    host.append(el('p', 'cap', 'No top-level component was returned for this window, so these are drawn '
      + 'flat. They are parts of a payout, not the payout.'));
    return host;
  }
  hbars(host, roots.map((c) => ({ label: c.label, n: c.amount })), {
    valueFmt: (v) => money(v),
    legend: [['--b400', 'added to the payout'], ['--s2', 'deducted (cash already taken, fees)']],
  });
  const net = roots.reduce((a, c) => a + c.amount, 0);
  host.append(el('p', 'cap',
    `The ${countOf(roots.length, 'top-level component')} above net to ${money(net)}. `
    + 'Everything below is inside one of them and is not added again.'));
  if (kids.length) {
    const byParent = new Map();
    kids.forEach((c) => {
      if (!byParent.has(c.parent)) byParent.set(c.parent, []);
      byParent.get(c.parent).push(c);
    });
    /* The parent may be a child itself.
       ───────────────────────────────────────────────────────────────────────
       This looked the parent up in `roots` alone, so a GRANDCHILD never found
       one and its share came out null. Uber's supplier tree is three deep —
       `little_fare` inside `fare` inside `your_earnings` — and `fare` is not a
       root, so on production 17 of the 31 rows on this table were blank,
       including the largest component the fleet has. Looked up across every
       component instead, at whatever depth it sits. */
    const byLabel = new Map();
    for (const c of [...roots, ...kids]) {
      /* Summed: one category can hang under two parents — Uber reports
         `taxes_earnings` inside both `earnings` and `your_earnings` — and
         last-write-wins would measure a share against half its denominator. */
      byLabel.set(c.label, (byLabel.get(c.label) || 0) + (c.amount || 0));
    }
    const rows = [];
    for (const [p, list] of byParent) {
      const parentAmt = byLabel.get(String(p).replace(/_/g, ' ')) ?? byLabel.get(p);
      list.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).forEach((c) => {
        rows.push({ within: String(p).replace(/_/g, ' '), label: c.label, amount: c.amount,
          drivers: c.drivers,
          share: parentAmt ? (c.amount / parentAmt) * 100 : null });
      });
    }
    host.append(tableFrom(rows, [
      { label: 'Within', key: 'within' },
      { label: 'Component', key: 'label' },
      // money() writes the sign now; this used to do it by hand.
      { label: 'Amount', key: 'amount', num: true,
        render: (r) => money(r.amount, 'AED', 2) },
      { label: 'Share of its parent', key: 'share', num: true,
        render: (r) => (r.share == null
          ? '<span class="ent-off" title="the parent component was not returned for this window">—</span>'
          : pct(r.share, 1)) },
      /* A component everybody carries and one that applies to three drivers
         are different findings, and the amount alone cannot tell them apart. */
      { label: 'Drivers', key: 'drivers', num: true,
        absent: 'this window predates the per-component driver count',
        render: (r) => (r.drivers == null ? '—' : fmt(r.drivers)) },
    ], { compact: true, sortable: true, sortId: 'comp' }));

    /* The same explanation #revenue carries, because this is the same table.
       ─────────────────────────────────────────────────────────────────────
       Two pages render the payout breakdown and both print "net fare — 100.9%
       of its parent". Explaining it on one of them and not the other is how a
       reader concludes the OTHER page is the broken one. Measured here:
       earnings is AED 33,905.19 against children summing to 34,126.23, so a
       positive child exceeds a net parent and AED 221.04 is not itemised at
       all. */
    const gaps = [...byParent.entries()].map(([p, list]) => {
      const root = roots.find((r) => r.label === String(p).replace(/_/g, ' '));
      if (!root || !root.amount) return null;
      const diff = root.amount - list.reduce((a, c) => a + (Number(c.amount) || 0), 0);
      return Math.abs(diff) < 1 ? null : { name: String(p).replace(/_/g, ' '), diff };
    }).filter(Boolean);
    const anyOver = rows.some((r) => r.share != null && Math.abs(r.share) > 100);
    if (anyOver || gaps.length) {
      host.append(el('p', 'cap',
        (anyOver
          ? 'A share above 100% is not an error: a parent here is a NET of its children, so a '
            + 'positive component can exceed it once a negative sibling — a tax, a clawback — is '
            + 'taken off. '
          : '')
        + (gaps.length
          ? `${gaps.map((g) => `<b>${esc(g.name)}</b> is ${money(Math.abs(g.diff))} `
            + `${g.diff > 0 ? 'more' : 'less'} than the components listed under it`).join('; ')}. `
            + 'The platform reports the parent and the parts separately and does not itemise the '
            + 'difference, so the column will not add up to the row above it.'
          : '')));
    }
  }
  return host;
}

const VIEWS = [
  { id: 'unit', label: 'Unit economics', ic: '◆', grp: 'Money', sub: 'What every vehicle and every driver earned per day worked, per km and per booking — and which of them earned nothing' },
  { id: 'revenue', label: 'Revenue by channel', ic: '◇', grp: 'Money', sub: 'What each platform actually tells us about money — and which ones tell us nothing' },
  { id: 'reconcile', label: 'Reconciliation', ic: '⇌', grp: 'Money', sub: 'Every month on record: what the platforms wired against what their own statements say they owed' },
  { id: 'finance', label: 'Finance', ic: '◈', grp: 'Money', sub: 'Revenue, payment mix and the transaction ledger' },
  { id: 'settlement', label: 'Settlement', ic: '◫', grp: 'Money', sub: 'Who settles the fare and when — cash in hand, and what is outstanding' },
  { id: 'corporate', label: 'Corporate & hotels', ic: '❖', grp: 'Money', sub: 'The channel that reports a cost, a property, a guest and the driver’s starting point' },
  { id: 'overview', label: 'Fleet activity', ic: '◱', grp: 'Work', sub: 'Volume, mix and quality across every platform — the work behind the money' },
  { id: 'demand', label: 'Demand', ic: '◷', grp: 'Work', sub: 'When trips happen — by day, hour and weekday' },
  { id: 'compare', label: 'Today vs yesterday', ic: '⧉', grp: 'Work', sub: 'Two days beside each other, cut at the same Dubai minute so a partial today is not read as a collapse' },
  { id: 'platforms', label: 'Platforms', ic: '◨', grp: 'Work', sub: 'Uber vs Yango vs Bolt — share, product tier and the acceptance funnel' },
  { id: 'corridors', label: 'Corridors', ic: '⇄', grp: 'Work', sub: 'Where jobs start and end, rolled up from the addresses every channel returns' },
  { id: 'top-performers', label: 'Top performers', ic: '▲', grp: 'People', sub: 'Who last complete week went well for, and what they did differently' },
  { id: 'low-performers', label: 'Low performers', ic: '▼', grp: 'People', sub: 'Who it did not — with what the data cannot tell you about why' },
  { id: 'drivers', label: 'Drivers', ic: '◧', grp: 'People', sub: 'Per-driver output, quality and cross-platform activity' },
  { id: 'roster', label: 'Roster & supply', ic: '☰', grp: 'People', sub: 'Who is on the books across all four platforms, and who is earning nothing' },
  { id: 'retention', label: 'Joiners & leavers', ic: '⇅', grp: 'People', sub: 'Whether a falling driver count is people leaving or nobody arriving — a headcount cannot tell them apart' },
  { id: 'compliance', label: 'Compliance', ic: '❑', grp: 'People', sub: 'Documents and licences with an expiry date attached' },
  { id: 'vehicles', label: 'Vehicles', ic: '▤', grp: 'Assets', sub: 'Utilisation and revenue per vehicle' },
  { id: 'unauthorized', label: 'Unauthorized trips', ic: '⚠', grp: 'Assets', sub: 'Seat occupied, vehicle moved — but no booking on any channel' },
  { id: 'safety', label: 'Safety', ic: '△', grp: 'Assets', sub: 'Harsh-driving events from the telematics layer' },
  { id: 'live', label: 'Live fleet', ic: '◉', grp: 'Assets', sub: 'Realtime positions — CABMAN refreshes every 5 minutes' },
  { id: 'map', label: 'Map & replay', ic: '◍', grp: 'Assets', sub: 'Where every vehicle is now, and where it went on any given day' },
  { id: 'causes', label: 'Why it moved', ic: '◔', grp: 'Decide', sub: 'Structural breaks split into supply and demand, against what was happening in the world' },
  { id: 'forecast', label: 'Forecast', ic: '◠', grp: 'Decide', sub: 'What next month looks like, day by day, and how much of that is a guess' },
  { id: 'playbook', label: 'To-do list', ic: '☑', grp: 'Decide', sub: 'What to do this month to earn more — each item with the arithmetic that sized it' },
  { id: 'capacity', label: 'Rota gaps', ic: '◫', grp: 'Decide', sub: 'Where next month’s forecast work lands, against who currently covers that hour' },
  { id: 'insights', label: 'Action list', ic: '✦', grp: 'Decide', sub: 'What needs doing, ranked by what it costs to ignore' },
  { id: 'analyst', label: 'Analyst', ic: '◑', grp: 'Decide', sub: 'Claims a model proposed and the database judged — with the numbers that decided each one' },
  { id: 'sources', label: 'Data sources', ic: '⛁', grp: 'Trust', sub: 'Collector health, coverage and history depth' },
  { id: 'coverage', label: 'Collection gaps', ic: '▦', grp: 'Trust', sub: 'Which days each source actually collected — a hole here makes every rate across it wrong' },
  { id: 'providers', label: 'What each API offers', ic: '⌗', grp: 'Trust', sub: 'Every field each provider sends, and the ones we currently have nowhere to put' },
  { id: 'settings', label: 'Settings', ic: '⚙', grp: 'Set up', sub: 'Credentials and collection schedule' },
];

/* ─────────── shell ─────────── */
// A detail page keeps its parent lit in the sidebar — `#driver/…` is a page
// *within* Drivers, not a thirteenth top-level destination.
/* Slot, segments and segment are the destinations of the demand heatmap, the
   capacity rota and every unauthorized drill — three of the eleven modals this
   product replaced with addresses. They had no VIEWS entry and no PARENT, so
   every one of them fell through to VIEWS[0] and titled itself "Unit
   economics", with the breadcrumb hidden and nothing lit in the sidebar. */
const PARENT = { driver: 'drivers', vehicle: 'vehicles', property: 'corporate', day: 'demand',
  performer: 'top-performers',
  action: 'insights', slot: 'demand', segments: 'unauthorized', segment: 'unauthorized' };
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* Which groups are open. Measured, not guessed: twenty-nine destinations laid
   out flat need about 1,250px of nav, and #nav gets 712px on a 900px laptop,
   570px on a 768px one and 522px on a 13-inch browser with a toolbar. So a
   third of the product was below the fold at every realistic window height,
   and the fold landed in the middle of a group.

   Collapsing solves it, but only if the state survives navigation — a sidebar
   that snaps shut every time you click is worse than a long one. It is kept
   per browser, and the group holding the current page is ALWAYS open whatever
   was stored, so no route can be reached and then hidden. */
const NAV_KEY = 'fleet.nav.open';
const navOpen = () => {
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (raw) return new Set(JSON.parse(raw));
  } catch { /* private window, cleared storage, quota — open everything */ }
  return null;
};
const navToggle = (grp, open) => {
  const cur = navOpen() || new Set(VIEWS.map((v) => v.grp));
  open ? cur.add(grp) : cur.delete(grp);
  try { localStorage.setItem(NAV_KEY, JSON.stringify([...cur])); } catch { /* ignore */ }
};

function renderNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  const lit = PARENT[state.view] || state.view;
  const here = (VIEWS.find((v) => v.id === lit) || {}).grp;
  const stored = navOpen();
  const groups = [...new Set(VIEWS.map((v) => v.grp))];
  groups.forEach((grp) => {
    const items = VIEWS.filter((v) => v.grp === grp);
    const open = grp === here || (stored ? stored.has(grp) : true);
    const head = el('button', `grp${open ? ' open' : ''}`,
      `<span class="caret">${open ? '▾' : '▸'}</span>${grp}`
      + (open ? '' : `<span class="n">${items.length}</span>`));
    head.type = 'button';
    head.setAttribute('aria-expanded', String(open));
    /* The group of the page you are on cannot be collapsed out from under you:
       clicking it would hide the thing that is lit. */
    if (grp === here) head.disabled = true;
    head.onclick = () => { navToggle(grp, !open); renderNav(); };
    nav.append(head);
    if (!open) return;
    items.forEach((v) => {
      const a = el('a', v.id === lit ? 'on' : '', `<span class="ic">${v.ic}</span>${v.label}`);
      a.href = href(v.id);
      a.title = v.sub || v.label;
      nav.append(a);
    });
  });
}
function setHeader(detail) {
  const crumb = $('#crumb');
  if (state.view === 'driver') {
    /* `day` is a destination, not a tab, so it is not in DRIVER_TABS and the
       lookup fell back to Overview — the page read "Overview — every platform
       this person works on" while showing one date. A subtitle that names the
       wrong thing is worse on this page than most, because the whole point of
       it is that you are looking at ONE day. */
    const on = state.sub === 'day'
      ? new URLSearchParams(location.hash.split('?')[1] || '').get('on') : null;
    const tab = DRIVER_TABS.find((t) => t.id === (state.sub || 'overview')) || DRIVER_TABS[0];
    $('#viewTitle').textContent = detail?.name || 'Driver';
    $('#viewSub').textContent = on
      ? `${dayStr(`${on}T12:00:00`)} — every job, and the waiting between them`
      : `${tab.label} — every platform this person works on, combined`;
    crumb.innerHTML = `<a href="${href('drivers')}">Drivers</a><span>/</span>`
      + (on
        ? `<a href="${href('driver', state.param, 'activity')}">${esc(detail?.name || state.param || '')}</a>`
          + `<span>/</span><b>${esc(dayStr(`${on}T12:00:00`))}</b>`
        : `<b>${esc(detail?.name || state.param || '')}</b>`);
    crumb.style.display = 'flex';
  } else if (state.view === 'vehicle') {
    const tab = VEHICLE_TABS.find((t) => t.id === (state.sub || 'overview')) || VEHICLE_TABS[0];
    const spec = detail?.spec || {};
    $('#viewTitle').textContent = detail?.name || state.param || 'Vehicle';
    $('#viewSub').textContent = `${tab.label} — ${[spec.year, spec.make, spec.model].filter(Boolean).join(' ') || 'every source that describes this asset'}`;
    crumb.innerHTML = `<a href="${href('vehicles')}">Vehicles</a><span>/</span><b>${esc(detail?.name || state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'action') {
    $('#viewTitle').textContent = detail?.title || 'Finding';
    $('#viewSub').textContent = 'One finding, its evidence, and what to do about it';
    crumb.innerHTML = `<a href="${href('insights')}">Action list</a><span>/</span><b>${esc(state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'day') {
    const label = /^\d{4}-\d{2}-\d{2}$/.test(state.param || '')
      ? new Date(`${state.param}T12:00:00Z`).toLocaleDateString(undefined,
        { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: TZ })
      : 'Day';
    $('#viewTitle').textContent = label;
    $('#viewSub').textContent = 'Every source that saw this day — including whether each one was collecting';
    crumb.innerHTML = `<a href="${href('demand')}">Demand</a><span>/</span><b>${esc(state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'trip') {
    /* Named, because the fall-through at the bottom of this chain takes the
       first entry of VIEWS — which is how one person's week came to be titled
       "Unit economics" and would have retitled every booking the same way. */
    const t = detail?.trip;
    $('#viewTitle').textContent = t
      ? `${sourceLabel(t.platform)} booking, ${dayStr(t.local_day)}` : 'One booking';
    /* Both ends, or a named one — a lone address joined by nothing reads as
       the pickup when it is usually the drop-off, and this channel reports one
       end far more often than the other. */
    $('#viewSub').textContent = t
      ? (t.pickup_addr && t.dropoff_addr ? `${t.pickup_addr} → ${t.dropoff_addr}`
        : t.dropoff_addr ? `Dropped at ${t.dropoff_addr}`
          : t.pickup_addr ? `Picked up at ${t.pickup_addr}`
            : 'Everything the record holds about this booking')
      : 'Everything the record holds about one booking';
    crumb.innerHTML = t?.driver_ext_id
      ? `<a href="${href('driver', t.driver_ext_id, 'trips')}">${esc(t.driver_name || 'Driver')}</a>`
        + `<span>/</span><b>booking</b>`
      : `<a href="${href('drivers')}">Drivers</a><span>/</span><b>booking</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'performer') {
    /* Without this the drill-down fell through to the final else, VIEWS has no
       'performer' entry, and `|| VIEWS[0]` retitled one person's week as "Unit
       economics" — the wrong page name in the largest type on the screen, on
       every visit. */
    $('#viewTitle').textContent = detail?.name || 'One person’s week';
    $('#viewSub').textContent = 'Day by day: what they drove, where they picked up, how long they '
      + 'carried someone and how long they waited between jobs';
    crumb.innerHTML = `<a href="${href('top-performers')}">Top performers</a><span>/</span>`
      + `<b>${esc(detail?.name || state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'compare') {
    /* The default is today against yesterday, but the page takes any two days,
       and a header that still said "Today vs yesterday" over a comparison of
       the 3rd and the 10th would be a lie in the largest type on the screen. */
    const named = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '')
      ? new Date(`${v}T12:00:00Z`).toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', timeZone: TZ })
      : null);
    const A = named(state.param), B = named(state.sub);
    $('#viewTitle').textContent = A && B ? `${A} vs ${B}`
      : A ? `${A} vs the day before` : 'Today vs yesterday';
    $('#viewSub').textContent = 'Both days counted up to the same Dubai minute, so a day that '
      + 'has not finished is not read as a fall';
    crumb.style.display = 'none';
  } else if (state.view === 'slot') {
    const dow = Number(state.param), hour = Number(state.sub);
    const named = Number.isInteger(dow) && dow >= 0 && dow <= 6
      && Number.isInteger(hour) && hour >= 0 && hour <= 23;
    $('#viewTitle').textContent = named ? `${DOW_LONG[dow]} ${hourStr(hour)}` : 'One hour of the week';
    $('#viewSub').textContent = 'Who covers this hour, how reliably the work turns up, and where it starts';
    crumb.innerHTML = `<a href="${href('demand')}">Demand</a><span>/</span><b>${
      esc(named ? `${DOW_LONG[dow]} ${hourStr(hour)}` : state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'segments' || state.view === 'segment') {
    const one = state.view === 'segment';
    $('#viewTitle').textContent = one ? (state.param || 'Occupancy segment') : 'Occupancy segments';
    $('#viewSub').textContent = one
      ? 'One interval the seat sensor called occupied, and everything around it'
      : 'Every interval the seat sensor called occupied, and how each one resolved';
    crumb.innerHTML = `<a href="${href('unauthorized')}">Unauthorized trips</a><span>/</span>`
      + `<b>${esc(one ? state.param || '' : [state.param, state.sub].filter(Boolean).join(' ') || 'all segments')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'property') {
    const tab = PROPERTY_TABS.find((t) => t.id === (state.sub || 'overview')) || PROPERTY_TABS[0];
    $('#viewTitle').textContent = detail?.name || 'Property';
    $('#viewSub').textContent = `${tab.label} — every booking this property placed, with its cost as well as its price`;
    crumb.innerHTML = `<a href="${href('corporate', 'properties')}">Corporate &amp; hotels</a><span>/</span><b>${esc(detail?.name || state.param || '')}</b>`;
    crumb.style.display = 'flex';
  } else if (state.view === 'unit') {
    /* Three tabs of one page, so the subtitle names which of the three is on
       screen. The title does not change: a reader who followed a link to the
       full vehicle ledger is still on Unit economics, and retitling the page
       per tab would make the two read as separate destinations. */
    const tab = UNIT_TABS.find((t) => t.id === (state.param || 'overview')) || UNIT_TABS[0];
    const v = VIEWS.find((x) => x.id === 'unit');
    $('#viewTitle').textContent = v.label;
    $('#viewSub').textContent = state.param
      ? `${tab.label} — every row carries a rate, and every column ranks by it`
      : v.sub;
    crumb.style.display = 'none';
  } else {
    const v = VIEWS.find((x) => x.id === state.view) || VIEWS[0];
    $('#viewTitle').textContent = v.label; $('#viewSub').textContent = v.sub;
    crumb.style.display = 'none';
  }
  /* Which controls this view actually offers.
     ───────────────────────────────────────────────────────────────────────
     Three separate decisions, and they used to be one. The forecast fits whole
     months since the last regime change, so the window selector does not
     control it; the playbook DOES respect the window, because "idle this month"
     is a different list from "idle this year"; reconciliation needs the fleet
     filter and not the range, because its rows are months and a thirty-day
     window touches two partial ones. And a detail page answers "everything
     about this person" through qAll(), so a platform chip reading "egari" above
     a card reading ECOSINE described nothing at all.

     The lists live in data.js because href() has to agree with them: an
     address must not carry a filter its destination hides. See hidesRange /
     hidesChannel there.

     Each control is hidden individually rather than the whole #filters row —
     the refresh button and the "Dubai time" chip live inside it, and hiding
     the row took them off exactly the three pages that consist almost entirely
     of timestamps and whose subject is how current the data is. */
  const setDisp = (sel, hidden) => { const n = $(sel); if (n) n.style.display = hidden ? 'none' : ''; };
  setDisp('#fRange', hidesRange(state.view));
  setDisp('#fPlatform', hidesChannel(state.view));
  setDisp('#fFleet', hidesChannel(state.view));
  $('#filters').style.display = 'flex';
}
/* ─────────── views ─────────── */
const V = {};

V.overview = async (root) => {
  /* The verdict goes in FIRST, before anything it summarises, and is filled
     once the figures land. This page opened with six unlabelled tiles and
     three charts and never said what it found — a reader did the interpreting
     themselves on the product's front door. */
  const vHost = el('div'); root.append(vHost);
  const kpiHost = el('div', 'kpis'); root.append(kpiHost);
  const g1 = el('div', 'grid g23'); root.append(g1);
  const trend = panel('Trips per day',
    'Bookings only. Telematics journeys are drawn behind them in grey — the same physical trips, seen '
    + 'by the trackers. A day nobody collected is hatched, not zero. Click a bar to open that day.');
  g1.append(trend.panel);
  const mix = panel('Platform share',
    'Bookings by channel. Telematics rows are excluded: they are the same journeys, and adding them '
    + 'made this ring total four times the Trips figure above.');
  g1.append(mix.panel);
  const g2 = el('div', 'grid g3'); root.append(g2);
  const prod = panel('Product mix', 'Which service tiers the fleet runs'); g2.append(prod.panel);
  const pay = panel('How fares settle',
    'Grouped by settlement route rather than by the processor\'s name — click for the detail.');
  g2.append(pay.panel);
  const out = panel('Trip outcome',
    'Every platform’s own status word folded to the outcome it means — Bolt’s '
    + '"finished" and Uber’s "completed" are one thing, and three spellings of cancelled are another.');
  g2.append(out.panel);
  const lead = panel('Top drivers', 'Click for detail'); root.append(lead.panel);
  [kpiHost, trend.body, mix.body, prod.body, pay.body, out.body, lead.body].forEach(loading);

  const [k, daily, byPlat, byProd, payDetail, byStatus, drivers] = await Promise.all([
    q('/api/kpis'), q('/api/trips/daily'), q('/api/mix', { by: 'platform' }), q('/api/mix'),
    q('/api/mix/detail', { by: 'payment' }), q('/api/mix', { by: 'status' }), q('/api/drivers/leaderboard'),
  ]);

  /* The tiles are addresses. "Money in" is the most misread number in this
     product and #revenue exists to explain it, and until now the two were
     joined by nothing at all — a reader who doubted the figure had to find the
     page in the sidebar and hope it was the right one. */
  const GO = {
    Trips: href('demand'), Distance: href('vehicles'), 'Money in': href('revenue'),
    Completion: href('platforms'), Vehicles: href('vehicles'), 'Safety alerts': href('safety'),
  };
  kpiHost.innerHTML = [
    ['Trips', fmt(k.trips), `${fmt(k.drivers)} drivers · ${fmt(k.telematics_journeys || 0)} telematics journeys`],
    /* avg_km divides by the trips that REPORT a distance, not by every trip,
       and that count was nowhere on the tile: 146,249 over 11,758 is 12.44,
       and the tile said 14.02. Over the 10,434 that carry a distance it is
       14.02 exactly. */
    ['Distance', fmt(k.km) + ' km', k.trips_with_distance
      ? `avg ${k.avg_km ?? '—'} km over the ${fmt(k.trips_with_distance)} trips reporting one`
      : `avg ${k.avg_km ?? '—'} km/trip`],
    /* Both channels, because one of them alone is not this fleet's money.
       This card showed sum(price) over the trip table, and the Uber export
       carries no fare column — so on a normal month it was 651 of 7,356 trips,
       the hotel channel by itself, and a fleet that took in AED 257,000 in July
       read as AED 58,185 here. The Revenue page has added the two together
       since it was built; this card is what most people actually look at.

       The parts stay named underneath. A fare is what a rider paid for a trip
       and a payout is a weekly statement net of the platform's commission —
       they are both money in, and a reader comparing this month to last needs
       to know which half moved. */
    ['Money in', k.accounted ? 'AED ' + fmt(k.accounted) : '—',
      k.accounted
        ? `AED ${fmt(k.accounted_fares || 0)} in fares · AED ${fmt(k.accounted_payouts || 0)} in `
          + `platform payouts · ${(k.accounted_platforms || []).map(sourceLabel).join(', ') || 'no platform'}`
          + (k.statement_net ? ` · on-trip net AED ${fmt(k.statement_net)}` : '')
        : 'no fare and no payout statement in this range'],
    ['Completion', k.completion_pct != null ? k.completion_pct + '%' : '—', `${k.cancel_pct ?? 0}% cancelled`],
    ['Vehicles', fmt(k.vehicles), 'with a trip in this range'],
    /* Harsh-driving events come from the telematics box on the car, not from a
       booking channel, so the platform chip at the top of the page cannot
       narrow them. The tile used to print the same figure under every platform
       filter with nothing to say why. */
    ['Safety alerts', fmt(k.alerts),
      state.platform
        ? `harsh-driving events · not filtered by ${esc(state.platform)} — these come from the tracker, not a channel`
        : `harsh-driving events${k.tracked_vehicles ? ` across ${fmt(k.tracked_vehicles)} tracked vehicles` : ''}`],
  ].map(([l, n, d]) => (GO[l]
    ? `<a class="kpi clickable" href="${GO[l]}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></a>`
    : `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`)).join('');

  /* ── the verdict ────────────────────────────────────────────────────────
     Written from the figures already fetched, so it cannot disagree with the
     tiles beneath it. It states the ONE thing this window is about, chosen by
     what is furthest out of line rather than by a fixed sentence: a fleet with
     a collection hole has a different headline from one with a cancellation
     spike, and a page that always says the same thing is a caption. */
  {
    const v = fleetVerdict({ kpis: k, daily, byPlatform: byPlat });
    const money = k.accounted || 0;
    let claim, figure, unit, recommend = null, meta = null;
    if (v.branch === 'gap') {
      claim = `${v.uncollected} of these ${v.days} days were never collected`;
      figure = fmt(v.uncollected); unit = plural(v.uncollected, 'day missing', 'days missing');
      recommend = 'Read every rate on this page as an average over the days that WERE collected — '
        + 'the missing ones are drawn hatched rather than as zero, and Collection gaps names which source failed.';
    } else if (v.branch === 'cancellations') {
      claim = `${k.cancel_pct}% of bookings did not complete`;
      figure = `${k.completion_pct}%`; unit = 'completed';
      recommend = 'Open Platforms for the acceptance funnel — an offer refused and a rider cancelling '
        + 'are different failures and only one of them is the fleet’s.';
    } else {
      claim = v.branch === 'single-channel'
        ? `This is a single-channel fleet — ${sourceLabel(v.lead.label)} is ${v.leadPct}% of the work`
        : v.branch === 'multi-channel'
          ? `${fmt(k.trips)} bookings across ${v.others + 1} channels that matter`
          : `${fmt(k.trips)} bookings across ${fmt(k.vehicles)} vehicles`;
      figure = fmt(v.perDay); unit = 'bookings a day';
      meta = `${fmt(k.drivers)} drivers · ${fmt(k.vehicles)} vehicles`;
      if (v.branch === 'single-channel') {
        recommend = `Every rate on this page is ${sourceLabel(v.lead.label)}'s rate wearing the fleet's `
          + 'name. Revenue by channel shows what each one actually reports.';
      }
    }
    const sub = [
      `${fmt(k.trips)} bookings over ${v.days} ${plural(v.days, 'day')}, `
      + `${money ? `AED ${fmt(money)} accounted for` : 'no money accounted for in this window'}.`,
      v.partial ? `${v.partial} more ${plural(v.partial, 'day')} had at least one source silent, so those bars are understated.` : '',
      k.telematics_journeys
        ? `The trackers saw ${fmt(k.telematics_journeys)} journeys behind these bookings — the same cars, counted by a different feed.`
        : '',
    ].filter(Boolean).join(' ');
    verdict(vHost, { claim, figure, unit, sub, tone: v.tone, recommend, meta });
  }

  gapBars(trend.body, daily, { x: 'd', y: 'trips', label: 'bookings', secondary: 'telematics_journeys',
    // A day is an address now, not a modal containing a driver list.
    onClick: (d) => { location.hash = href('day', dayKey(d.d)); } });
  /* The slice carries which platform it is, and the click threw it away —
     every slice opened the same unfiltered #platforms. */
  /* Both of these charted the endpoint's raw label — a donut legend reading
     "uber · hotel · yango" and bars reading "uber: Electric", "uber: UberX" —
     which are the only places on this page a channel is not written the way
     the product writes it everywhere else. The raw value is kept on the row so
     the click still filters by it. */
  donut(mix.body, byPlat.map((r) => ({ ...r, key: r.label, label: sourceLabel(r.label) })),
    { onClick: (d) => setFilter({ platform: d.key ?? d.label, view: 'platforms', param: null, sub: null }) });
  mix.body.append(el('p', 'cap', 'Click a slice to filter the dashboard to that channel and open it.'));
  hbars(prod.body, byProd.slice(0, 6).map((r) => {
    const [plat, tier] = String(r.label || '').split(/:\s*/);
    return { ...r, label: tier ? `${sourceLabel(plat)} · ${tierLabel(tier)}` : sourceLabel(r.label) };
  }), { signed: false });
  paymentDonut(pay.body, payDetail);
  /* Folded to OUTCOMES before charting. Charted raw, `completed` and
     `complete` were two slices of the same thing and three spellings of
     cancelled were three more — then `.slice(0, 5)` dropped whatever fell off
     the end and stackedBar renormalised the rest to 100%, so the shares were
     over a subset while reading as the whole. */
  const OUTCOME = [
    [/^(completed?|finished|complete|delivered|dropped_?off)$/i, 'Completed'],
    [/cancel|no_?show|did_?not_show|reject|no_?response|expired|declin/i, 'Did not complete'],
  ];
  const outcomeOf = (s) => (OUTCOME.find(([re]) => re.test(String(s || '')))?.[1]) || 'Other / not reported';
  const folded = new Map();
  byStatus.forEach((r) => {
    const k = outcomeOf(r.label);
    const cur = folded.get(k) || { label: k, n: 0, raw: [] };
    cur.n += r.n; cur.raw.push(`${r.label} ${fmt(r.n)}`); folded.set(k, cur);
  });
  const outRows = [...folded.values()].sort((a, b) => b.n - a.n);
  stackedBar(out.body, outRows);
  out.body.append(el('p', 'cap', outRows.map((r) => `${esc(r.label)}: ${esc(r.raw.join(', '))}`).join(' · ')
    || 'No platform in this window reports how a trip ended.'));
  lead.body.innerHTML = '';
  /* One row per person now, not per platform account — a person working two
     apps used to appear twice with half their work on each row, and therefore
     rank below somebody who did less. Tolerant of the old bare-array shape so
     a stale cached bundle does not blank the panel. */
  const lbRows = Array.isArray(drivers) ? drivers : (drivers.rows || []);
  /* Rank stamped on the row, not counted from its position: tableFrom sorts
     the array in place, so a number derived from indexOf() renumbers itself
     the moment a reader sorts by Km and stops meaning anything. */
  const top = lbRows.slice(0, 12).map((r, i) => ({ ...r, _rank: i + 1 }));
  /* The ranking the panel is actually showing, named honestly. The endpoint
     ranks by total bookings; when it starts returning `completed_trips` and
     ordering by it (the fix is on the server list) this says so instead of
     going on claiming something that had not been true. */
  const ranksByCompleted = top.some((r) => r.completed_trips != null);
  lead.body.append(tableFrom(top, [
    /* Name first, rank inside it. The first column is the one that stays put
       when a wide table scrolls sideways, and a frozen column of 1, 2, 3 names
       nobody — the reader ends up with every number on screen and no idea
       whose they are. The rank is a property of the row's position, not a fact
       about the driver, so it does not earn a column of its own. */
    { label: 'Driver', key: 'driver_name',
      render: (r) => `<span class="rk">${r._rank}</span>`
        + entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Channels', key: 'platforms',
      render: (r) => esc((r.platforms || (r.platform ? [r.platform] : [])).map(sourceLabel).join(', ')) },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Trips', key: 'trips', num: true },
    ...(ranksByCompleted
      ? [{ label: 'Completed', key: 'completed_trips', num: true, render: (r) => fmt(r.completed_trips) }]
      : []),
    { label: 'Km', key: 'km', num: true },
    { label: 'Completion', key: 'completion_pct', num: true, render: (r) => r.completion_pct != null ? r.completion_pct + '%' : '—' },
  ], { sortable: true, sortId: 'lead' }));
  lead.body.append(el('p', 'cap',
    (ranksByCompleted
      ? 'Ranked by completed trips. '
      : 'Ranked by bookings taken, not by bookings completed — the two orders differ where a '
        + 'busy driver cancels more. Sort by Completion to see which. ')
    + (drivers.truncated
      ? `The 12 busiest of ${fmt(drivers.people)} people who drove in this window.`
      : '')));
};

V.demand = async (root) => {
  const g = el('div', 'grid g2'); root.append(g);
  const hourly = panel('Hourly demand curve', 'Trip requests by hour of day'); g.append(hourly.panel);
  const daily = panel('Daily volume',
    'Bookings per Dubai-local day, with telematics journeys behind them. A day nobody collected is '
    + 'hatched rather than drawn as zero. Click a bar to open that day.');
  g.append(daily.panel);
  const ctxP = panel('Volume against the weather and the calendar',
    'Dubai demand is weather- and calendar-driven: heat empties the streets, rain floods them, and Ramadan moves the whole day. This puts the two side by side so a dip has a candidate explanation rather than a shrug.');
  root.append(ctxP.panel);
  const hm = panel('Weekday × hour heatmap', 'Darker = busier. Click a cell for that slot'); root.append(hm.panel);
  [hourly.body, daily.body, ctxP.body, hm.body].forEach(loading);

  const gen = currentGen();
  /* Each request carries its own failure. Three of these four were in a bare
     Promise.all, so one slow endpoint replaced the entire page — chart,
     heatmap and all — with a single error box. A panel that cannot be
     computed says so where it is, and the rest of the page still answers. */
  const fail = (body, e) => {
    body.innerHTML = '';
    body.append(note(/migrat/i.test(String(e.message || ''))
      ? 'The database is migrating, so this panel could not be computed.'
      : `Could not load this panel: ${e.message}`, 'err'));
    return null;
  };
  const [h, d, grid, ctx] = await Promise.all([
    q('/api/trips/hourly').catch((e) => fail(hourly.body, e)),
    q('/api/trips/daily').catch((e) => fail(daily.body, e)),
    q('/api/trips/heatmap').catch((e) => fail(hm.body, e)),
    q('/api/context').catch(() => []),
  ]);
  if (!alive(gen)) return;
  if (!d) return;                          // the series every panel below reads
  /* A filter that removes every booking is not an empty date range.
     `#demand?platform=fms` drew four blank panels reading "No data for this
     range yet" about a telematics feed that HAS no demand of its own, and
     `?platform=bolt` said the same about a channel whose collector is refused
     at the door. Both are answers; neither is a missing month. */
  const bookings = d.reduce((a, r) => a + (+r.trips || 0), 0);
  if (state.platform && !bookings) {
    const why = state.platform === 'fms'
      ? 'FMS is a telematics feed: it reports where the cars went, not what anybody booked. '
        + 'It has no demand curve of its own — its journeys are the same physical trips the '
        + 'revenue channels already count, seen by the tracker.'
      : `No booking on ${esc(state.platform)} landed in this window, so there is no demand to draw. `
        + 'That is a collection question, not a quiet month.';
    const box = el('div', 'panel');
    box.innerHTML = `<div class="note warn">${why}</div>`;
    const links = el('p', 'cap');
    links.innerHTML = state.platform === 'fms'
      ? `<a class="lnk" href="${href('overview')}">Fleet activity</a> counts the journeys behind the `
        + `bookings · <a class="lnk" href="${href('map')}">Map &amp; replay</a> shows where they went.`
      : `<a class="lnk" href="${href('sources')}">Data sources</a> names which collector is failing and why `
        + `· <a class="lnk" href="${href('revenue')}">Revenue by channel</a> shows what this channel does report.`;
    box.append(links);
    root.insertBefore(box, root.firstChild);
  }
  if (h) areaChart(hourly.body, h.map((r) => ({ label: String(r.h).padStart(2, '0') + ':00', trips: r.trips })), { x: 'label', y: 'trips' });
  gapBars(daily.body, d, { x: 'd', y: 'trips', label: 'bookings', secondary: 'telematics_journeys',
    onClick: (r) => { location.hash = href('day', dayKey(r.d)); } });
  /* A chart handler is not a link: no middle-click, no new tab, no hover URL,
     no keyboard route — on the product's main entrance to its two deepest
     pages. The addresses are listed beneath the marks that carry them. */
  const busiest = [...d].sort((a, b) => (+b.trips || 0) - (+a.trips || 0)).slice(0, 8);
  if (busiest.length) {
    const jump = el('p', 'cap');
    jump.innerHTML = 'Busiest days in this window: '
      + busiest.map((r) => `<a class="lnk" href="${href('day', dayKey(r.d))}">${esc(dayStr(r.d))}</a>`
        + `<span class="dim"> ${fmt(r.trips)}</span>`).join(' · ');
    daily.body.append(jump);
  }
  /* The way out of the page. Placed on the daily series because that IS the
     export's day grain — the same window, the same chips, the same Dubai
     days — so what downloads is the chart above it, in a spreadsheet. */
  daily.body.append(exportRow(bookings));

  /* Join the day's trips to that day's weather and calendar. Both sides are
     keyed on the calendar date, so a missing weather row leaves the trip row
     intact rather than dropping the day. */
  ctxP.body.innerHTML = '';
  const day = (v) => String(v).slice(0, 10);
  const byDay = new Map(ctx.map((c) => [day(c.day), c]));
  const rows = d.map((r) => ({ ...r, ...(byDay.get(day(r.d)) || {}) }));
  /* Only days that are BOTH weather-covered and fully collected.
     weather_daily holds about the last month, so over a 12-month selection this
     panel described one month while labelling nothing — "Days with rain: 1"
     read as a statement about the year. And a day nobody collected has zero
     trips, which dragged every hot-versus-cool average toward whichever side
     the collection gap happened to fall on. */
  const usable = rows.filter((r) => !r.uncollected && !r.sources_silent);
  const withWeather = usable.filter((r) => r.temp_max != null);
  const weatherDays = rows.filter((r) => r.temp_max != null).length;
  if (!withWeather.length) {
    ctxP.body.append(note('No weather rows for this range yet. The collector pulls Dubai daily observations and forecasts each cycle.'));
  } else {
    ctxP.body.append(note(`${fmt(withWeather.length)} of the ${fmt(rows.length)} days in this window have `
      + `both weather and a complete collection, and everything below is over those days only`
      + (weatherDays < rows.length
        ? ` — weather is stored for about the last month, so a longer selection describes a shorter period than its title.`
        : '.')));
    // Correlation between temperature and volume, stated plainly with its own
    // caveat — a month of days is not enough to call this causal.
    const n = withWeather.length;
    const mx = withWeather.reduce((a, r) => a + r.temp_max, 0) / n;
    const my = withWeather.reduce((a, r) => a + r.trips, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (const r of withWeather) {
      const dx = r.temp_max - mx, dy = r.trips - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    const rho = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    const hot = withWeather.filter((r) => r.temp_max >= 42);
    const mild = withWeather.filter((r) => r.temp_max < 42);
    const avg = (a) => (a.length ? a.reduce((s, r) => s + r.trips, 0) / a.length : null);
    const wet = rows.filter((r) => r.precipitation > 0);
    const hol = rows.filter((r) => r.is_holiday);
    const ram = rows.filter((r) => r.is_ramadan);

    ctxP.body.append(kpiRow([
      { label: 'Hottest day', value: `${Math.max(...withWeather.map((r) => r.temp_max)).toFixed(1)}°C`,
        sub: `${fmt(withWeather.filter((r) => r.temp_max >= 42).length)} days at or above 42°C` },
      /* An AVERAGE, said so. `avg(hot)` is trips per hot day, and the label
         "Trips on 42°C+ days" reads as the total: 363 against eighteen such
         days, where the total is 6,534. The comparison beside it only works if
         both halves are known to be per-day. */
      { label: 'Trips per 42°C+ day', value: hot.length ? fmt(Math.round(avg(hot))) : '—',
        sub: mild.length
          ? `on average, over ${countOf(hot.length, 'hot day')} — against `
            + `${fmt(Math.round(avg(mild)))} a day on the ${fmt(mild.length)} cooler ones`
          : 'no cooler days to compare' },
      /* toFixed emits an ASCII hyphen; every other number on this page uses a
         true minus. A correlation is the one figure here whose sign is read
         first. */
      { label: 'Temp vs volume', value: rho.toFixed(2).replace(/^-/, '\u2212'),
        sub: Math.abs(rho) < 0.3 ? 'no meaningful relationship in this window'
          : rho < 0 ? 'hotter days run quieter' : 'hotter days run busier',
        tone: Math.abs(rho) < 0.3 ? null : 'warn' },
      { label: 'Days with rain', value: fmt(wet.length),
        sub: wet.length ? `averaging ${fmt(Math.round(avg(wet)))} trips` : 'none in this range' },
      hol.length ? { label: 'Holidays', value: fmt(hol.length),
        sub: `averaging ${fmt(Math.round(avg(hol)))} trips` } : null,
      ram.length ? { label: 'Ramadan days', value: fmt(ram.length),
        sub: `averaging ${fmt(Math.round(avg(ram)))} trips` } : null,
    ]));

    /* Stamped onto the row rather than computed in the column's render:
       tableFrom prunes a column no row carries a key for, so a value derived
       purely inside render() vanishes from the table it was added to. */
    const ctxRows = [...rows].reverse().slice(0, 45).map((r) => ({
      ...r,
      open_yet: (r.completed == null && r.cancelled == null) ? null
        : Math.max(0, (+r.trips || 0) - (+r.completed || 0) - (+r.cancelled || 0)),
    }));
    ctxP.body.append(tableFrom(ctxRows, [
      /* A day is an address, and this column was the one place on the page it
         was plain text. */
      { label: 'Day', key: 'd', render: (r) => `<a class="ent" href="${href('day', dayKey(r.d))}">${esc(dayStr(r.d))}</a>` },
      { label: 'Trips', key: 'trips', num: true, render: (r) => fmt(r.trips) },
      /* Completed and cancelled were both in this payload and neither was
         drawn — cancellations are the only unserved-demand signal the fleet
         has, on the page about demand. */
      { label: 'Completed', key: 'completed', num: true,
        render: (r) => (r.completed == null
          ? '<span class="ent-off" title="no platform on this day reports an outcome">—</span>'
          : fmt(r.completed)) },
      { label: 'Did not complete', key: 'cancelled', num: true,
        render: (r) => (r.cancelled == null
          ? '<span class="ent-off" title="no platform on this day reports an outcome">—</span>'
          : r.cancelled
            ? `<span class="pill ${r.trips && r.cancelled / r.trips > 0.15 ? 'warn' : ''}">${fmt(r.cancelled)}</span>`
            : '0') },
      /* The residual. Completed and Did-not-complete sat beside Trips and did
         not add up to it — 85 and 5 against 93 on the day this was found,
         which is today, so three of them had not finished yet. A column that
         does not reconcile with the one beside it reads as an error in the
         data rather than a trip still running. */
      { label: 'Neither yet', key: 'open_yet', num: true,
        render: (r) => (r.open_yet == null ? '—'
          : (r.open_yet > 0
            ? `<span title="still running, or a status no channel maps to either outcome">${fmt(r.open_yet)}</span>`
            : '0')) },
      { label: 'Drivers', key: 'drivers', num: true,
        render: (r) => (r.drivers == null
          ? '<span class="ent-off" title="this day’s rows carry no driver id — a telematics-only day">—</span>'
          : fmt(r.drivers)) },
      { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
      /* The fare column with the denominator it was computed over: on a
         mostly-Uber day this is a handful of bookings, not the day. */
      { label: 'Fares', key: 'revenue', num: true, absent: UBER_FARE,
        render: (r) => (r.revenue
        ? `${money(r.revenue)}${r.priced_trips != null
          ? `<span class="dim"> · ${fmt(r.priced_trips)} of ${fmt(r.trips)} priced</span>` : ''}`
        : '<span class="ent-off" title="no booking on this day reports a fare — Uber’s export has no fare column">—</span>') },
      { label: 'Max temp', key: 'temp_max', num: true, render: (r) => (r.temp_max != null
        ? `<span class="pill ${r.temp_max >= 44 ? 'bad' : r.temp_max >= 41 ? 'warn' : 'ok'}">${r.temp_max.toFixed(1)}°C</span>` : '—') },
      /* Zero millimetres IS the measurement, and on this fleet it is 28 of 30
         days. Rendered as an em-dash it read as "not recorded", which on a
         column beside a temperature and a wind speed is the opposite of what a
         dry day means. The `absent` stays for the case the weather feed itself
         is missing, where every value would be null rather than zero. */
      { label: 'Rain', key: 'precipitation', num: true,
        absent: 'no weather was recorded for these days — the daily feed is loaded per year from '
          + 'a public source, so a whole column of blanks means it has not run for this range',
        render: (r) => (r.precipitation ? `${r.precipitation} mm`
          : (r.precipitation === 0 ? '<span class="dim">0 mm</span>' : '—')) },
      { label: 'Wind', key: 'wind_max', num: true, render: (r) => (r.wind_max != null ? `${Math.round(r.wind_max)} km/h` : '—') },
      /* Holidays and Ramadan come from calendar_day, which is loaded per year
         from a public source. A window with no marked day in it is the normal
         case, not a gap — said in one line rather than in thirty dashes. */
      { label: 'Calendar', key: '_c',
        absent: 'no public holiday, Ramadan day or forecast day falls in this window',
        render: (r) => [
        r.is_holiday ? pill(r.holiday_name || 'holiday', 'warn') : null,
        r.is_ramadan ? pill('Ramadan', 'warn') : null,
        r.is_forecast ? pill('forecast', null) : null,
      ].filter(Boolean).join(' ') || '—' },
    ]));
    ctxP.body.append(el('p', 'cap',
      'A correlation over a few weeks of days is a hint, not a finding — Dubai\'s temperature barely varies within a month, ' +
      'so the seasonal effect only becomes visible across a longer window. Rows marked forecast have not happened yet.'));
  }

  /* A cell used to open a modal that showed the driver ranking for the WHOLE
     range — identically whichever cell you clicked, under a title naming the
     slot. It is now a page about that slot: who covers it, on how many of the
     weekdays it could have covered, from where, and what happens if that person
     is off. */
  if (grid) {
    heatmap(hm.body, grid, { unit: 'bookings',
      onClick: (c) => { location.hash = href('slot', String(c.dow), String(c.h)); } });
    hm.body.append(el('p', 'cap',
      'A cell opens that hour as a rostering question — who holds it, how reliably it fires, '
      + 'and where the work starts. The shading is against this window’s own busiest hour, so the '
      + 'same cell darkens when you narrow the range; the legend gives the scale it is on.'));
    /* The heatmap is a chart handler, so its cells cannot be middle-clicked,
       opened in a tab or reached from a keyboard. The busiest slots are listed
       as real addresses beneath it. */
    const hot = [...grid].sort((a, b) => (+b.trips || 0) - (+a.trips || 0)).slice(0, 8);
    if (hot.length) {
      const jump = el('p', 'cap');
      jump.innerHTML = 'Busiest slots: ' + hot.map((c) =>
        `<a class="lnk" href="${href('slot', String(c.dow), String(c.h))}">`
        + `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][c.dow]} ${hourStr(c.h)}</a>`
        + `<span class="dim"> ${fmt(c.trips)}</span>`).join(' · ');
      hm.body.append(jump);
    }
  }
};

V.drivers = async (root) => {
  const gen = currentGen();
  /* The directory's rows are REUSED rather than re-fetched.
     /api/drivers/directory is the slowest request on this page — 7.5s cold at
     365 days — and it was issued twice per load, once by the directory and
     again in the Promise.all below, under the same URL. The request log showed
     it as DUPLICATE x2 and the page took 18s cold where half of that was
     asking the same question twice. */
  const dir = await renderDriverDirectory(root);
  if (!alive(gen)) return;
  const g = el('div', 'grid g2'); root.append(g);
  const sc = panel('Trips vs distance', 'Each dot is a driver — spot high-trip/low-km and vice versa'); g.append(sc.panel);
  const xp = panel('Cross-platform activity', 'The same person working more than one app'); g.append(xp.panel);
  /* Named for what the endpoint returns. It carries no acceptance field at all
     — the column below reads it from the row and finds nothing — and
     hours_online is non-null on five rows in three hundred. A caption that
     promises three things and delivers one teaches the reader to distrust the
     page rather than the caption. */
  const perf = panel('Platform performance records',
    'The reporting periods each platform published for a driver: trips, the statement total, and — where '
    + 'the platform publishes it, which is rarely — hours online.');
  root.append(perf.panel);
  [sc.body, xp.body, perf.body].forEach(loading);
  const [cross, pf] = await Promise.all([
    q('/api/drivers/cross-platform'), q('/api/drivers/performance')]);
  if (!alive(gen)) return;

  /* Plotted from the DIRECTORY, not the leaderboard.
     The caption says "each dot is a driver" and the leaderboard is one row per
     ACCOUNT — grouped by (name, id, platform) — so a person working two apps
     was two dots, each showing a fraction of their work, and the dot you
     clicked opened a page whose totals did not match it. The leaderboard is
     also capped at 100 accounts, which on a fleet this size is a sample of the
     roster presented as the roster. The directory is one row per person and
     covers everyone. */
  const dots = (Array.isArray(dir) ? dir : [])
    .filter((r) => (r.trips || 0) > 0)
    .map((r) => ({ ...r, driver_ext_id: r.ids?.[0] || r.driver_ext_id,
      trips: +r.trips, km: +(r.km || 0) }))
    .sort((a, b) => b.trips - a.trips);
  scatter(sc.body, dots.slice(0, 80),
    { x: 'trips', y: 'km', label: 'driver_name', xLabel: 'trips', yLabel: 'km',
      onClick: (r) => { location.hash = href('driver', r.driver_ext_id); } });
  sc.body.append(el('p', 'cap', dots.length > 80
    ? `The 80 busiest of ${fmt(dots.length)} people who drove in this window. One dot per person: `
      + 'platform accounts are folded, so somebody working two apps is one dot carrying both.'
    : 'One dot per person: platform accounts are folded, so somebody working two apps is one '
      + 'dot carrying both.'));
  xp.body.innerHTML = '';
  /* This read `cross.filter(...)`. The endpoint returns
     `{platforms, drivers, multi_platform, note}` and has since it was rewritten
     to fold accounts by person — so `.filter` was being called on an object and
     threw, which the view's catch-all turned into "Could not load this view"
     across the WHOLE Drivers page, directory included. It went unnoticed
     because the mock API had no fixture for this route and the catch-all
     returned `[]`, on which `.filter` works.

     The columns come from `cross.platforms` rather than a hardcoded list, which
     is the same fix the endpoint itself already carries: the hardcoded list had
     no `hotel`, one of only three platforms with trip data, so a driver working
     Uber and the hotel channel scored one platform and this panel printed the
     flat denial below — on a page whose own directory had just listed them. */
  const people = cross.drivers || (Array.isArray(cross) ? cross : []);
  const plats = cross.platforms || [];
  const col = (pl) => `${pl}_trips`;
  const multi = people.filter((r) => plats.filter((pl) => (r[col(pl)] || 0) > 0).length > 1);
  /* The headline counts come from the endpoint, which computes them over every
     person in the window. `people` is capped at 150 rows, so counting them here
     printed "N of 150" for a fleet of 240 — a sentence that is simply false,
     and false in the direction that makes the fleet look smaller than it is. */
  const popN = cross.people ?? people.length;
  const multiN = cross.multi_platform ?? multi.length;
  if (!multiN) {
    xp.body.append(el('div', 'note', plats.length
      ? `No driver in this window has trips on more than one of: ${plats.map(sourceLabel).join(', ')}.`
      : 'No platform has trips in this window, so there is nothing to compare.'));
  } else {
    xp.body.append(tableFrom(multi.slice(0, 15), [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
      /* The only place in the product where a raw platform token was a column
         HEADING: hotel | uber | yango, beside headings reading Bookings and
         Accounts. */
      ...plats.map((pl) => ({ label: sourceLabel(pl), key: col(pl), num: true })),
      /* Zero is a number, and here it is the whole finding: this person's work
         is all bookings and no unexplained journeys. Rendered as an em-dash it
         read as "not measured", which on a column beside three trip counts is
         the opposite of what a zero means. */
      { label: 'Telematics', key: 'telematics_journeys', num: true,
        render: (r) => (r.telematics_journeys ? fmt(r.telematics_journeys)
          : (r.telematics_journeys === 0 ? '<span class="dim">0</span>' : '—')) },
      { label: 'Bookings', key: 'booking_trips', num: true },
      { label: 'Accounts', key: 'accounts', num: true },
      /* The car. The endpoint's own comment says why it computes this — "a
         person working three platforms is usually working them from ONE car,
         and that was the fact this table could not show" — and then the table
         still did not show it. main_plate is the one they drove most in the
         window; plate_n is how many they touched. */
      { label: 'Mainly drives', key: 'main_plate',
        absent: 'no trip on these people carries a plate',
        render: (r) => (r.main_plate
          ? entity('vehicle', r.main_plate, r.main_plate)
            + (r.plate_n > 1 ? `<span class="dim" title="${esc((r.plates || []).join(', '))}${
              r.plate_n > (r.plates || []).length ? ' and others' : ''}"> +${fmt(r.plate_n - 1)} more</span>` : '')
          : '<span class="ent-off" title="no trip of theirs in this window records a plate">—</span>') },
      { label: 'Km', key: 'km', num: true,
        absent: 'no trip on these people carries a usable distance',
        render: (r) => (r.km == null ? '<span class="ent-off">—</span>' : fmt(r.km)) },
    ], { sortable: true, sortId: 'cross', defaultSort: { key: 'booking_trips', dir: 'desc' } }));
    xp.body.append(el('p', 'cap',
      `${fmt(multiN)} of ${fmt(popN)} people in this window work more than one channel`
      /* Two different cuts, and the sentence named neither of the numbers on
         screen. The endpoint sends the 150 busiest people, and this TABLE then
         shows the 15 busiest of the multi-channel ones — so a reader counting
         fifteen rows was reading a sentence about a hundred and fifty. */
      + (multi.length > 15 ? `, and the ${fmt(Math.min(15, multi.length))} busiest of them are `
        + 'listed below' : '')
      + (cross.truncated ? `, drawn from the ${fmt(people.length)} busiest people in the window. ` : '. ')
      + 'Columns cover every platform with data, so the booking total is the sum of what is shown; '
      + 'telematics journeys are counted apart because they are the same physical trips seen by the tracker.'));
  }
  perf.body.innerHTML = '';
  /* {rows, periods, totals, shown, truncated} — a bare array before. The cap
     started to bite the moment the Uber collector was fixed: a weekly period
     used to hold ten drivers because that was all the collector could see, and
     now holds a hundred and fifty, so the first 300 rows are two periods rather
     than a year of them. Tolerant of the old shape so a stale bundle still
     draws something. */
  const pfRows = Array.isArray(pf) ? pf : (pf.rows || []);
  const pfTot = (Array.isArray(pf) ? null : pf.totals) || {};
  perf.body.append(tableFrom(pfRows.slice(0, 25), [
    { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Period', key: 'period_start', render: (r) => dayStr(r.period_start) },
    { label: 'Trips', key: 'trips', num: true },
    /* Measured: null on all 300 records. The caption above already warns that
       hours are published "rarely"; on this fleet the honest word is never, so
       the column steps aside for the ones that carry figures. */
    { label: 'Hrs online', key: 'hours_online', num: true,
      absent: 'no channel published hours for any of these periods — Uber reports hours_online '
        + 'for 9 of 241 people and none of them appear here, and the other channels report none '
        + 'at all',
      render: (x) => (x.hours_online ? (+x.hours_online).toFixed(1) : '—') },
    /* Statement and Counted, for the same reason as the driver page: these are
       report windows and they overlap, so the platform's own figure and the
       part of it that has not already been counted elsewhere are two different
       numbers. Only the second one adds up. */
    { label: 'Statement', key: 'earnings', num: true, render: (x) => money(x.earnings) },
    { label: 'Counted', key: 'counted', num: true, render: (x) => money(x.counted ?? x.earnings) },
  ], { sortable: true, sortId: 'perf', defaultSort: { key: 'period_start', dir: 'desc' },
    capped: pfTot.total > pfRows.length ? `all ${fmt(pfTot.total)} records` : null }));
  if (pfTot.total) {
    perf.body.append(el('p', 'cap',
      `Showing 25 of ${fmt(pfTot.total)} records — ${fmt(pfTot.people)} people across `
      + `${fmt(pfTot.periods)} reporting periods on ${(pfTot.platforms || []).map(sourceLabel).join(', ') || 'no platform'}, `
      + `${money(pfTot.earnings)} over ${countOf(pfTot.payout_days, 'paid day')}. `
      + 'The total counts each day once: report windows overlap where a backfill '
      + 'and a catch-up describe the same week, and adding the statements would '
      + 'count those days twice.'
      + (pf.truncated ? ' The list is the most recent periods, not all of them.' : '')));
  }
};

// The per-driver pages themselves. `state.param` is the platform driver id and
// `state.sub` is the tab — both come straight from the URL.
V.driver = async (root) => renderDriver(root, state.param, state.sub || 'overview');

// Why the numbers moved: breaks decomposed into supply vs demand, coverage
// gaps drawn as gaps, and the outside events that overlap them.
V.causes = async (root) => renderCauses(root);

/* The commercial pages. Each is a tabbed multipage view whose tab is part of
   the address, so "the eleven bookings we gave away last month" is a link. */
V.corporate = async (root) => renderCorporate(root, CORP_TABS.some((t) => t.id === state.param) ? state.param : 'overview');
V.property = async (root) => {
  let detail = null;
  await renderProperty(root, state.param, PROPERTY_TABS.some((t) => t.id === state.sub) ? state.sub : 'overview',
    (d) => { detail = d; });
  return detail;
};
V.settlement = async (root) => renderSettlement(root, SETTLE_TABS.some((t) => t.id === state.param) ? state.param : 'mix');
V.coverage = async (root) => renderCoverage(root);
V.corridors = async (root) => renderCorridors(root);

/* One finding, as an address. It was a modal, so the evidence trail for a
   specific problem could not be sent to the person who has to fix it — and the
   entity it named was plain text, so a finding about a vehicle dead-ended at
   the vehicle's name. */
V.action = async (root) => {
  const code = state.param, entityId = state.sub === '-' ? null : state.sub;
  root.innerHTML = '';
  loading(root);
  /* Ask for THIS rule, not for the whole list.
     /api/insights is capped at 200 over 204 findings, and this page fetched
     all of them on every load and then filtered client-side — so four genuinely
     open findings fell off the end and their pages announced "that finding is
     no longer open", which is the opposite of true. The narrowed request is
     also two hundred rows lighter on every action-page load. Falls back to the
     unfiltered list where the endpoint does not accept `code` yet. */
  let page = await api(`/api/insights?code=${encodeURIComponent(code || '')}`).catch(() => null);
  let narrowed = !!page && (page.insights || []).every((r) => r.code === code);
  if (!narrowed) { page = await api('/api/insights').catch(() => ({ insights: [] })); }
  const ofCode = (page.insights || []).filter((r) => r.code === code);
  const rows = ofCode.filter((r) => entityId == null || String(r.entity_id) === String(entityId));
  root.innerHTML = '';
  if (!rows.length) {
    /* Absent from a TRUNCATED list is not the same as closed. */
    const cut = page.truncated && !narrowed;
    root.append(note(cut
      ? `This finding is not in the first ${fmt(page.limit)} findings the list returns, and the list is `
        + 'capped — so it may well still be open. It could not be looked up directly because the '
        + 'endpoint does not yet accept a rule name.'
      : 'That finding is no longer open. Either it was resolved and the engine has stopped '
        + 'raising it, or the collection window it was computed over has moved on.', cut ? 'warn' : null));
    root.append(el('p', 'cap', `Looking for ${esc(code || '?')}${entityId ? ` on ${esc(entityId)}` : ''}.`));
    const back = el('p', 'cap');
    back.innerHTML = `<a class="lnk" href="${href('insights')}">Back to the action list</a>`;
    root.append(back);
    return { title: 'Finding' };
  }
  const r = rows[0];
  const ENTITY_VIEW = { vehicle: 'vehicle', driver: 'driver', partner: 'property' };
  const view = ENTITY_VIEW[r.entity_type];
  root.append(kpiRow([
    /* These arrive as the rule engine's own enum values — critical, compliance,
       vehicle — and were printed as tile VALUES, the largest text on the page,
       in lowercase. */
    { label: 'Severity', value: sentence(r.severity),
      tone: { critical: 'critical', warning: 'warn', good: 'good' }[r.severity] },
    { label: 'Category', value: sentence(r.category) },
    { label: 'About', html: view && r.entity_id
      ? entity(view, r.entity_id, `${sentence(r.entity_type)} ${r.entity_id}`)
      : esc(`${sentence(r.entity_type || 'fleet')} ${r.entity_id || ''}`) },
    { label: 'Computed', value: r.computed_at ? dtStr(r.computed_at) : '—',
      sub: r.window_start ? `over ${dayStr(r.window_start)} → ${dayStr(r.window_end)}` : 'current state' },
    r.impact_aed
      ? { label: 'Sized at', value: money(r.impact_aed),
          sub: (r.impact_kind === 'modelled' || r.code === 'idle_vehicle')
            ? 'a modelled holding cost, not a measurement'
            : 'as measured',
          tone: (r.impact_kind === 'modelled' || r.code === 'idle_vehicle') ? 'warn' : null }
      : null,
    r.metric != null ? { label: 'Measured at', value: fmt(r.metric, 2),
      sub: 'the figure the rule fired on' } : null,
    r.fleet_id ? { label: 'Fleet', value: sourceLabel(r.fleet_id) } : null,
  ]));
  const why = panel('What we found', 'The evidence behind this flag.');
  why.body.innerHTML = `<p style="margin:0">${esc(r.detail || '')}</p>`;
  root.append(why.panel);
  const act = panel('What to do', 'The smallest useful next step.');
  act.body.innerHTML = `<p style="margin:0">${esc(r.action || '')}</p>`;
  root.append(act.panel);
  if (view && r.entity_id) {
    root.append(note(`Open the ${r.entity_type} to see everything else known about it — this finding `
      + 'is one reading, and the page beside it is the rest of them.'));
  }
  /* Siblings come from the CODE, not from code-and-entity.
     This was gated on `rows.length > 1` after filtering by both, so on a page
     addressed to a specific vehicle `rows` was always exactly one and the
     panel could never render — the one place that answers "is this a fleet
     pattern or one bad car" never appeared. */
  const siblings = ofCode.filter((x) => x !== r
    && !(entityId != null && String(x.entity_id) === String(entityId)));
  if (siblings.length) {
    const more = panel('The same rule elsewhere',
      `${countOf(siblings.length, 'other open finding')} from this rule — one bad asset and a fleet-wide `
      + 'pattern need different responses, and the count is how you tell them apart.');
    more.body.append(tableFrom(siblings, [
      { label: 'About', key: 'entity_id',
        render: (x) => (ENTITY_VIEW[x.entity_type]
          ? entity(ENTITY_VIEW[x.entity_type], x.entity_id, x.entity_id) : esc(x.entity_id || '—')) },
      { label: 'Finding', key: 'title',
        render: (x) => `<a class="ent" href="${href('action', x.code, x.entity_id || '-')}">${esc(x.title)}</a>` },
      { label: 'Severity', key: 'severity', render: (x) => pill(x.severity, { critical: 'bad', warning: 'warn' }[x.severity]) },
      { label: 'Sized at', key: 'impact_aed', num: true,
        render: (x) => (x.impact_aed
          ? `${money(x.impact_aed)}${x.impact_kind === 'modelled' || x.code === 'idle_vehicle'
            ? '<span class="dim" title="a modelled figure, not a measurement"> modelled</span>' : ''}`
          : '<span class="ent-off" title="this rule does not size its findings in money">—</span>') },
      { label: 'Computed', key: 'computed_at', render: (x) => dtStr(x.computed_at) },
    ], { sortable: true, sortId: 'sibling' }));
    root.append(more.panel);
  }
  return { title: r.title };
};
/* A day is a page. It was a modal titled "Trips on 14 August" that contained a
   driver leaderboard, and could not be linked to. */
/* Occupancy segments. `#segments/<kind>/<value>` where kind is one of
   verdict|plate|day|driver, and `#segment/<plate>/<started_at>` for one
   interval. These replaced four separate modals that opened the same body. */
V.segments = async (root) => {
  const KINDS = ['verdict', 'plate', 'day', 'driver'];
  const kind = KINDS.includes(state.param) ? state.param : null;
  await renderSegments(root, kind, kind ? state.sub : null);
};
V.segment = async (root) => renderSegment(root, state.param, state.sub);
/* A booking as an address: #trip/<channel>/<the provider's own id>. Every
   trip table in the product opens into this, and the id is the provider's
   so a link survives a re-collection. */
V.trip = async (root) => renderTrip(root, state.param, state.sub);

/* The two pages an operations lead opens on the first of the month: what is
   coming, and what to do about it. */
V.playbook = async (root) => renderPlaybook(root);
V.forecast = async (root) => renderForecast(root);
V.retention = async (root) => renderRetention(root);
V.capacity = async (root) => renderCapacity(root);
/* The first screen: the fleet as a ledger rather than as a trip count. */
V.unit = async (root) => renderEconomics(root);
V['top-performers'] = async (root) => renderPerformers(root, 'top');
V['low-performers'] = async (root) => renderPerformers(root, 'low');
V.performer = async (root) => renderPerformer(root, state.param);
V.revenue = async (root) => renderRevenue(root);
// `#reconcile` is every month; `#reconcile/<YYYY-MM>` is that month's days.
V.reconcile = async (root) => renderReconcile(root, state.param);

/* One weekday-hour cell of the demand heatmap: `#slot/<dow>/<hour>`. */
V.slot = async (root) => {
  const dow = Number(state.param), hour = Number(state.sub);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6 || !Number.isInteger(hour) || hour < 0 || hour > 23) {
    return empty(root, 'A slot address is #slot/<weekday 0-6>/<hour 0-23>.');
  }
  await renderSlot(root, dow, hour);
};

/* Two days beside each other. `#compare/<a>/<b>`, both optional: with neither
   it is today against yesterday, which is the question this page exists for. */
V.compare = async (root) => {
  await renderCompare(root, state.param, state.sub);
};

V.day = async (root) => {
  let detail = null;
  await renderDay(root, state.param, (d) => { detail = d; });
  return detail;
};
/* `#providers` is the inventory; `#providers/<provider>/<surface>/<key>` is one
   raw field's actual values. The router carries three segments, so the field
   name — which can contain a slash in "Trip distance (miles)" style keys — is
   taken from the tail of the address rather than from `state.sub`. */
V.providers = async (root) => {
  const provider = state.param;
  const rest = state.sub;
  if (provider && rest) {
    const path = location.hash.slice(1).split('?')[0].split('/').slice(1).map(decodeURIComponent);
    const [, surface, ...keyParts] = path;
    const key = keyParts.join('/');
    if (surface && key) return renderProviderField(root, provider, surface, key);
  }
  return renderProviders(root);
};
V.roster = async (root) => renderRoster(root);
V.analyst = async (root) => renderAnalyst(root);

V.vehicles = async (root) => {
  const gen = currentGen();
  /* /api/vehicles is not fetched at all any more.
     ───────────────────────────────────────────────────────────────────────
     It cost 12.2s cold at a 365-day window — of a 43.7s page — and everything
     this view took from it (plate, trips, and a total) is already on
     /api/vehicles/directory, which the directory above has just fetched for
     all 140 vehicles. The two were also awaited in sequence, so the second
     request did not start until the first finished. The directory's rows are
     reused and the tier request now runs alongside it. */
  const dirP = renderVehicleDirectory(root);
  const tierP2 = q('/api/product/by-vehicle').catch(() => []);
  const rows = (await dirP) || [];
  if (!alive(gen)) return;
  const spread = panel('Fleet spread', 'How trips distribute across the fleet — a long tail here means assets carrying no load');
  root.append(spread.panel); loading(spread.body);
  const tierP = panel('Which assets serve which tier',
    'Uber Black and Comfort earn several times what UberX does per trip, so tier is an allocation decision. This is which cars are actually taking that work.');
  root.append(tierP.panel); loading(tierP.body);

  const byTier = await tierP2;
  if (!alive(gen)) return;
  const earning = rows.filter((r) => (+r.trips || 0) > 0)
    .sort((a, b) => (+b.trips || 0) - (+a.trips || 0));
  hbars(spread.body, earning.slice(0, 14).map((r) => ({ label: r.plate, n: +r.trips || 0 })), { seq: true, signed: false,
    onClick: (d) => { location.hash = href('vehicle', d.label); } });
  spread.body.append(el('p', 'cap', earning.length > 14
    ? `The 14 busiest of ${fmt(earning.length)} vehicles with a booking in this range, out of `
      + `${fmt(rows.length)} on the books. Every one of them is in the directory above.`
    : `Every one of the ${fmt(earning.length)} vehicles with a booking in this range, out of `
      + `${fmt(rows.length)} on the books.`));

  tierP.body.innerHTML = '';
  if (!byTier.length) {
    tierP.body.append(note('No product tier recorded against vehicles in this range. Uber names the tier on each trip, so this fills in with the Uber feed.'));
  } else {
    // Pivot to one row per plate, one column per tier — the shape that answers
    // "is the premium work concentrated, and on which cars".
    const tiers = [...new Set(byTier.map((r) => r.product))]
      .sort((a, b) => byTier.filter((x) => x.product === b).reduce((s, x) => s + x.trips, 0)
                    - byTier.filter((x) => x.product === a).reduce((s, x) => s + x.trips, 0))
      .slice(0, 6);
    const byPlate = new Map();
    for (const r of byTier) {
      const cur = byPlate.get(r.plate) || { plate: r.plate, total: 0 };
      cur[r.product] = r.trips; cur.total += r.trips;
      // Custody comes back on every row for the plate; keep the first.
      if (!cur.driver_refs) { cur.driver_refs = r.driver_refs; cur.driver_n = r.driver_n; }
      byPlate.set(r.plate, cur);
    }
    /* The concentration sentence is computed over ALL vehicles; the slice is
       for the table only. Computing it over the visible 30 made both the count
       and the share wrong, and wrong in the direction that makes the fleet look
       more concentrated than it is — which is that sentence's whole point. */
    const allPlates = [...byPlate.values()].sort((a, b) => b.total - a.total);
    const pivot = allPlates.slice(0, 30);
    tierP.body.append(tableFrom(pivot, [
      { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Driven by', key: 'driver_refs', render: (r) => custody(r)
        + (r.driver_n > (r.driver_refs || []).length
          ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)}</span>` : '') },
      /* tierLabel, not the raw key: the hotel channel's product names are
         database enums (drop_off, pick_and_drop) and they were sitting in the
         header row beside Uber's Comfort and Black. */
      ...tiers.map((t) => ({ label: tierLabel(t), key: t, num: true,
        absent: `no vehicle in this table took a ${tierLabel(t)} booking in this window — the `
          + 'column is here because some vehicle on the fleet did',
        render: (r) => (r[t] ? `${fmt(r[t])}<span class="dim"> · ${Math.round((r[t] / r.total) * 100)}%</span>` : '—') })),
      { label: 'Total', key: 'total', num: true, render: (r) => fmt(r.total) },
    ], { sortable: true, sortId: 'vtier', defaultSort: { key: 'total', dir: 'desc' } }));
    if (allPlates.length > pivot.length) {
      tierP.body.append(el('p', 'cap',
        `Showing the ${fmt(pivot.length)} busiest of ${fmt(allPlates.length)} vehicles.`));
    }
    // Concentration is the actionable part: a premium tier served by two cars
    // is a single point of failure for the fleet's best-earning work.
    const premium = tiers.find((t) => /black|lux|premier|comfort/i.test(t));
    if (premium) {
      const serving = allPlates.filter((r) => r[premium]).sort((a, b) => (b[premium] || 0) - (a[premium] || 0));
      const total = serving.reduce((a, r) => a + r[premium], 0);
      const topTwo = serving.slice(0, 2).reduce((a, r) => a + r[premium], 0);
      tierP.body.append(el('p', 'cap',
        `${countOf(serving.length, 'vehicle')} took ${esc(premium)} work. ` +
        (serving.length && total
          ? `The top two carried ${Math.round((topTwo / total) * 100)}% of it` +
            (serving.length <= 3 ? ' — losing one of those cars takes most of the tier with it.' : '.')
          : '')));
    }
  }
};

// The per-vehicle pages. `state.param` is the plate, `state.sub` is the tab.
V.vehicle = async (root) => renderVehicle(root, state.param, state.sub || 'overview');

/* Platforms — three pages, because "which channel" and "which product on that
   channel" and "how much demand we turned away" are three different questions
   and only the first was being asked. */
const PLATFORM_TABS = [
  { id: 'share', label: 'Share', ic: '◨' },
  { id: 'tiers', label: 'Product tiers', ic: '◆' },
  { id: 'funnel', label: 'Acceptance funnel', ic: '⌁' },
];
V.platforms = async (root) => {
  const tab = PLATFORM_TABS.some((t) => t.id === state.param) ? state.param : 'share';
  root.append(tabBar(PLATFORM_TABS, tab, (id) => href('platforms', id === 'share' ? null : id)));
  const host = el('div'); root.append(host);
  if (tab === 'tiers') return platformTiers(host);
  if (tab === 'funnel') return platformFunnel(host);
  return platformShare(host);
};

async function platformShare(root) {
  const vHost = el('div'); root.append(vHost);
  const g = el('div', 'grid g2'); root.append(g);
  const share = panel('Trips by platform', 'Share of total volume'); g.append(share.panel);
  const fleetMix = panel('Trips by fleet', 'Ecosine vs Egari'); g.append(fleetMix.panel);
  const cov = panel('Coverage & history depth', 'What each source has actually delivered'); root.append(cov.panel);
  [share.body, fleetMix.body, cov.body].forEach(loading);
  /* qAll, not api and not q.
     ─────────────────────────────────────────────────────────────────────────
     Bare api() sent no range, and /api/platforms is explicit about what that
     means: `windowed` comes back false and window_bookings is the OPEN window,
     identical to the all-time figure — "a page that drew it as this month would
     be wrong". So the range selector above this table governed nothing a reader
     could see, and the per-window count the endpoint has always returned could
     not be drawn.

     q() would send the window AND the platform/fleet chips, which would cut
     this table down to the one channel selected — on the page whose subject is
     which channels exist and what each carries. qAll sends the window and not
     the chips, which is exactly the shape this table needs. */
  const [byPlat, byFleet, plats] = await Promise.all([q('/api/mix', { by: 'platform' }), q('/api/mix', { by: 'fleet' }), qAll('/api/platforms')]);
  /* Clicking a slice used to open a modal listing that platform's drivers. It
     now sets the platform filter and goes to the driver directory — the same
     answer, on a page with the search box, the compliance columns and an
     address that carries the filter with it. */
  /* ── one bar, not a ring ────────────────────────────────────────────────
     The shape of this fact is "one of these is almost all of it", and a
     six-colour donut makes a reader measure angles to discover that. The bar
     names the leader inside itself and lists what every other channel is
     worth underneath, with the ones that report NOTHING kept in the list —
     a channel absent from a chart reads as a channel that does not exist,
     and Bolt existing and delivering nothing is a fact about this fleet. */
  {
    const v = fleetVerdict({ kpis: { trips: byPlat.reduce((a, r) => a + shareOf(r), 0) }, daily: [], byPlatform: byPlat });
    const total = v.charted;
    const dead = plats.filter((r) => !byPlat.some((b) => b.label === r.platform)
      && !(+r.window_bookings));
    verdict(vHost, {
      claim: v.branch === 'single-channel'
        ? `This is a single-channel fleet — ${sourceLabel(v.lead.label)} is ${v.leadPct}% of the work`
        : `${fmt(total)} bookings across ${byPlat.length} ${plural(byPlat.length, 'channel')}`,
      figure: v.branch === 'single-channel' ? `${v.leadPct}%` : fmt(total),
      unit: v.branch === 'single-channel' ? `on ${sourceLabel(v.lead.label)}` : 'bookings',
      meta: `${fmt(total)} bookings this window`,
      sub: dead.length
        ? `${dead.map((r) => sourceLabel(r.platform)).join(', ')} `
          + `${dead.length === 1 ? 'is configured and has' : 'are configured and have'} delivered nothing `
          + 'in this window — every rate computed "per platform" for those is arithmetic over no rows.'
        : 'Every configured channel delivered bookings in this window.',
      recommend: v.branch === 'single-channel'
        ? `Any figure this product reports "per platform" is ${sourceLabel(v.lead.label)}'s figure for `
          + `${v.leadPct}% of its weight. Read the others as samples, not as rates.`
        : null,
    });
    dominantBar(vHost, byPlat.map((r, i) => ({
      label: sourceLabel(r.label), value: shareOf(r), cls: `c${i + 1}`,
      note: r.revenue ? `${money(r.revenue)} reported` : 'reports no money on the trip',
    })).concat(dead.map((r) => ({
      label: sourceLabel(r.platform), value: 0, cls: 'dead', note: 'no booking in this window',
    }))), { total, unitLabel: `${fmt(total)} bookings this window · click a slice below to filter the dashboard` });
  }

  /* Same raw-label donut as the one on the fleet's front page. */
  donut(share.body, byPlat.map((r) => ({ ...r, key: r.label, label: sourceLabel(r.label) })),
    { onClick: (d) => setFilter({ platform: d.key ?? d.label, view: 'drivers', param: null, sub: null }) });
  share.body.append(el('p', 'cap', 'Click a slice to filter the whole dashboard to that platform and open its drivers.'));
  donut(fleetMix.body, byFleet);
  cov.body.innerHTML = '';
  /* Two different counts, kept apart. This table's number is over the WHOLE
     record and over raw rows — telematics twins of bookings already counted
     under Uber included — while the donut beside it is bookings in the window.
     They were both headed "Trips": 166,579 against 11,092 on one screen, with
     41,809 of the difference being the same journeys counted twice. */
  const hasSplit = plats.some((r) => r.bookings != null || r.rows_seen != null);
  cov.body.append(tableFrom(plats, [
    { label: 'Platform', key: 'platform',
      render: (r) => `<a class="ent" href="${hrefFilter('revenue', { platform: r.platform })}">${esc(sourceLabel(r.platform))}</a>` },
    { label: 'Fleet', key: 'fleet_id', render: (r) => esc(sourceLabel(r.fleet_id)) },
    ...(hasSplit
      ? [{ label: 'Bookings, all time', key: 'bookings', num: true,
        render: (r) => (r.bookings == null
          ? '<span class="ent-off" title="this source reports no bookings — it is a telematics feed">—</span>'
          : fmt(r.bookings)) },
      { label: 'Rows stored', key: 'rows_seen', num: true, render: (r) => fmt(r.rows_seen ?? r.trips) }]
      : [{ label: 'Rows stored, all time', key: 'trips', num: true, render: (r) => fmt(r.trips) }]),
    /* …and what the channel did in the window the reader chose.
       ─────────────────────────────────────────────────────────────────────
       Every column here is all-time and says so, which is honest — and it left
       the range selector above governing nothing a reader could see. Narrow to
       seven days and Uber/Ecosine still read 166,814. /api/platforms has
       returned window_bookings all along (7,571 against those 166,814 over
       thirty days); this is the column that makes the control mean something,
       and the one that lets the table be compared with the donut beside it,
       which has always been the window. */
    /* Only when a range was actually supplied. `windowed` false means the
       endpoint answered over the open window and this column would be the
       all-time figure under a heading claiming otherwise — the server says so
       in its own comment, and it was right. */
    ...(plats.some((r) => r.windowed && r.window_bookings != null)
      ? [{ label: 'Bookings in this window', key: 'window_bookings', num: true,
        absent: 'this endpoint reports no per-window count',
        render: (r) => (r.window_bookings == null
          ? '<span class="ent-off" title="this source reports no bookings in any window — it is a telematics feed">—</span>'
          : `${fmt(r.window_bookings)}${r.bookings
            ? `<span class="dim"> · ${pct((r.window_bookings / r.bookings) * 100, 1)} of all time</span>` : ''}`) }]
      : []),
    /* Raw ISO strings in a product that writes dates as "Aug 21, 2025"
       everywhere else, including the columns immediately beside these. */
    { label: 'Earliest', key: 'earliest', render: (r) => dateStr(r.earliest) },
    { label: 'Latest', key: 'latest', render: (r) => dateStr(r.latest) },
  ], { sortable: true, sortId: 'cov', defaultSort: { key: hasSplit ? 'bookings' : 'trips', dir: 'desc' } }));
  cov.body.append(note((hasSplit
    ? 'The all-time columns are over the whole record and do not match the donut above, which is this '
      + 'window; the window column beside them does. '
    : 'Counts are over the whole record, not this window, and they count stored ROWS — an FMS row is '
      + 'the telematics twin of a booking another channel already reported, so adding this column up '
      + 'double-counts every tracked journey. That is why it does not match the donut above. ')
    + 'A source that stopped mid-window still shows its full count here; Collection gaps shows which '
    + 'days it actually collected.'));
  const configured = ['uber', 'yango', 'bolt', 'hotel', 'fms'];
  const seen = new Set(plats.map((r) => r.platform));
  const dark = configured.filter((p) => !seen.has(p));
  if (dark.length) {
    /* A channel with no row is invisible in a table built from the rows. It is
       also the most important row on the page: it is the one that says a
       collector is refused rather than that a channel is quiet. */
    cov.body.append(note(`${dark.map(sourceLabel).join(', ')} ${plural(dark.length, 'has', 'have')} `
      + 'no stored row at all — not a quiet channel, a collector that is not getting in. '
      + 'Data sources names the refusal.', 'warn'));
  }
}

/* Uber's consumer tier is this fleet's limousine product mix. The export
   carries no fare, so this page deliberately holds no money: a tier table with
   invented revenue would be worse than no tier table. */
async function platformTiers(root) {
  loading(root);
  const [t, mix] = await Promise.all([q('/api/tiers/by-vehicle'), q('/api/tiers/mix', { by: 'daypart' })]);
  root.innerHTML = '';
  if (!t.vehicles.length) return empty(root, 'No Uber trip with a vehicle in this range');
  const under = t.vehicles.filter((v) => v.premium_gap_pct != null)
    .sort((a, b) => b.premium_gap_pct - a.premium_gap_pct);
  root.append(kpiRow([
    { label: 'Premium share', value: pct(t.fleet_premium_pct, 1), sub: 'Black and Comfort, fleet-wide' },
    { label: 'Vehicles carrying Uber work', value: fmt(t.vehicles.length) },
    /* Benchmarked against the BEST car of the model, so by construction almost
       everybody is behind it — one car per model defines the bar and every
       other one falls short of it. That is a distance, not a shortfall, and
       painting it amber turned an arithmetic identity into 58 findings. */
    { label: 'Behind the best car of their own model', value: fmt(under.length),
      sub: `of ${fmt(t.vehicles.length)} carrying Uber work — the benchmark is one car per model, `
        + 'so most are behind it by construction' },
    { label: 'Largest shortfall', value: under.length ? pct(under[0].premium_gap_pct, 1) : '—',
      sub: under.length ? `${under[0].plate} · ${under[0].model_key}` : null },
  ]));
  const g = el('div', 'grid g2'); root.append(g);
  /* The daypart was fetched and then rolled away.
     The panel is titled "Tier by time of day" and drew a plain tier donut with
     the daypart summed out of it — the one dimension the request exists to
     ask for. It is a matrix now: one row per daypart, the tier split inside
     it, and the average trip length that decides whether a tier is worth
     chasing in that hour. */
  const tp = panel('Tier by time of day',
    'Which tiers run in which part of the day. Reading across a row says what a shift is made of; '
    + 'reading down a column says when a tier actually happens.');
  const dayparts = [...new Set(mix.map((r) => r.label))];
  const tiers2 = [...new Set(mix.map((r) => r.tier))]
    .sort((a, b) => mix.filter((x) => x.tier === b).reduce((s, x) => s + x.n, 0)
                  - mix.filter((x) => x.tier === a).reduce((s, x) => s + x.n, 0));
  if (!mix.length) empty(tp.body, 'No Uber trip in this range carries both a tier and an hour');
  else {
    const rows2 = dayparts.map((dp) => {
      const cells = mix.filter((r) => r.label === dp);
      const total = cells.reduce((a, r) => a + r.n, 0);
      const km = cells.reduce((a, r) => a + (+r.avg_km || 0) * r.n, 0);
      const row = { label: dp, total, avg_km: total ? km / total : null };
      tiers2.forEach((t2) => { row[t2] = cells.find((r) => r.tier === t2)?.n || 0; });
      return row;
    }).sort((a, b) => b.total - a.total);
    tp.body.append(tableFrom(rows2, [
      /* The endpoint returns 'evening', 'morning' — lowercase keys, printed raw
         in a column whose every neighbour is a sentence-cased heading. */
      { label: 'Time of day', key: 'label',
        render: (r) => esc(String(r.label || '').replace(/^./, (c) => c.toUpperCase())) },
      ...tiers2.map((t2) => ({ label: t2, key: t2, num: true,
        render: (r) => (r[t2]
          ? `${fmt(r[t2])}<span class="dim"> · ${Math.round((r[t2] / r.total) * 100)}%</span>`
          : '<span class="ent-off" title="no trip of this tier in this part of the day">—</span>') })),
      { label: 'Trips', key: 'total', num: true, render: (r) => fmt(r.total) },
      { label: 'Avg trip', key: 'avg_km', num: true,
        render: (r) => (r.avg_km ? `${fmt(r.avg_km, 1)} km`
          : '<span class="ent-off" title="no trip here carries a usable distance">—</span>') },
    ], { compact: true, sortable: true, sortId: 'tiermix', defaultSort: { key: 'total', dir: 'desc' } }));
    const best = {};
    mix.filter((r) => /black|comfort|lux|premier/i.test(r.tier))
      .forEach((r) => { best[r.label] = (best[r.label] || 0) + r.n; });
    const top = Object.entries(best).sort((a, b) => b[1] - a[1])[0];
    tp.body.append(el('p', 'cap', top
      ? `Premium work concentrates in ${esc(top[0])} (${fmt(top[1])} trips). Tier is an allocation `
        + 'decision, and this is the hour to make it in.'
      : 'No premium tier ran in this window, in any part of the day.'));
  }
  g.append(tp.panel);
  const gp = panel('Distance from the best car of the same model',
    'Not a shortfall against a standard — the benchmark IS one of these cars, so the leader is at zero '
    + 'and everybody else is behind by definition. Useful as a spread, not as a list of failures.');
  if (under.length) {
    hbars(gp.body, under.slice(0, 12).map((v) => ({ label: `${v.plate} · ${v.model_key}`, n: v.premium_gap_pct })),
      { valueFmt: (v) => `${fmt(v, 1)} pts`, signed: false,
        onClick: (d) => { location.hash = href('vehicle', String(d.label).split(' · ')[0]); } });
  } else empty(gp.body, 'Every car is carrying as much premium work as its model does elsewhere');
  g.append(gp.panel);

  const tvp = panel(`Every vehicle carrying Uber work — ${countOf(t.vehicles.length, 'vehicle')}`,
    'Premium is Black plus Comfort as a share of that car\u2019s own Uber trips. The benchmark is the '
    + 'best-performing car of the same model, so most cars are behind it by construction — the size of '
    + 'the shortfall is the number worth reading, not its sign.');
  root.append(tvp.panel);
  tvp.body.append(tableFrom(t.vehicles, [
    { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    /* Who ran the car over this window. A shortfall against the same model
       elsewhere is a finding about how the car is being dispatched and driven,
       and until this column existed the row named only the asset — so acting
       on it meant opening the vehicle page to work out who to talk to. */
    { label: 'Driven by', key: 'driver_refs', render: (r) => custody(r)
      + (r.driver_n > (r.driver_refs || []).length
        ? ` <span class="dim">+${fmt(r.driver_n - (r.driver_refs || []).length)} more</span>` : '') },
    { label: 'Model', key: 'model_key', render: (r) => esc([r.year, r.make, r.model].filter(Boolean).join(' ') || '—') },
    { label: 'Trips', key: 'trips', num: true },
    { label: 'Black', key: 'black', num: true },
    { label: 'Comfort', key: 'comfort', num: true },
    { label: 'Electric', key: 'electric', num: true },
    { label: 'UberX', key: 'uberx', num: true },
    { label: 'Premium', key: 'premium_pct', num: true, render: (r) => pct(r.premium_pct, 1) },
    { label: 'Best of this model', key: 'model_best_pct', num: true, render: (r) => pct(r.model_best_pct, 1) },
    // Not painted as a warning: the leader defines the benchmark, so a gap is
    // a distance from the front of the field and not a failure to meet a bar.
    { label: 'Behind by', key: 'premium_gap_pct', num: true,
      render: (r) => (r.premium_gap_pct == null
        ? '<span class="ent-off" title="fewer than 20 trips, or no other car of this model">—</span>'
        : `${pct(r.premium_gap_pct, 1)} pts`) },
    { label: 'Km', key: 'km', num: true, render: (r) => fmt(r.km) },
    { label: 'Avg km', key: 'avg_km', num: true, render: (r) => fmt(r.avg_km, 1) },
  ], { sortable: true, sortId: 'tiers', defaultSort: { key: 'trips', dir: 'desc' } }));
  root.append(note('No revenue column here is deliberate. The Uber trip export has no fare field at '
    + 'all, so a per-tier revenue figure would have to be invented — and the mix itself is the lever: '
    + 'the same car, the same hour, a different tier.'));
}

/* Yango and Bolt report what a trip table cannot: how many jobs were offered
   and who turned them down. It is the only place lost demand is visible. */
async function platformFunnel(root) {
  loading(root);
  const res = await q('/api/funnel/drivers');
  // {rows,total,shown,truncated} when the endpoint says so; a bare array before.
  const rows = Array.isArray(res) ? res : (res.rows || []);
  const total = Array.isArray(res) ? null : res.total;
  root.innerHTML = '';
  const live = rows.filter((r) => r.offered != null);
  if (!live.length) {
    root.append(note('No channel in this window reported an offer count. Only Yango and Bolt publish '
      + 'one, and they publish it per period rather than per trip — widen the range, or check that '
      + 'those collectors are running.'));
    return;
  }
  const sum = (k) => live.reduce((a, r) => a + (+r[k] || 0), 0);
  const offered = sum('offered'), accepted = sum('accepted'), completed = sum('completed');
  root.append(kpiRow([
    { label: 'Jobs offered', value: fmt(offered) },
    { label: 'Accepted', value: fmt(accepted), sub: offered ? pct((accepted / offered) * 100, 1) : null,
      tone: offered && accepted / offered < 0.7 ? 'warn' : null },
    { label: 'Completed', value: fmt(completed), sub: accepted ? pct((completed / accepted) * 100, 1) + ' of accepted' : null },
    { label: 'Lost before it started', value: fmt(offered - accepted),
      sub: 'offered and not accepted', tone: offered - accepted > 0 ? 'warn' : null },
    { label: 'Platform commission', value: money(sum('commission_cost')),
      sub: 'what the channel kept' },
  ]));
  const fnp = panel(`Offer and completion, per driver-period — ${countOf(live.length, 'record')}`,
    'One row per driver per reporting period, as the channel published it. Rates within a row are '
    + 'sound; the periods overlap, so a column does not add up across rows.');
  root.append(fnp.panel);
  fnp.body.append(tableFrom(live, [
    { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name) },
    { label: 'Channel', key: 'platform', render: (r) => sourceLabel(r.platform) },
    { label: 'Period', key: 'period_start', render: (r) => `${dayStr(r.period_start)} → ${dayStr(r.period_end)}` },
    { label: 'Offered', key: 'offered', num: true, render: (r) => fmt(r.offered) },
    { label: 'Accepted', key: 'accepted', num: true, render: (r) => fmt(r.accepted) },
    { label: 'Accept %', key: 'accept_pct', num: true, render: (r) => pct(r.accept_pct, 1) },
    { label: 'Completed', key: 'completed', num: true, render: (r) => fmt(r.completed) },
    { label: 'Complete %', key: 'complete_pct', num: true, render: (r) => pct(r.complete_pct, 1) },
    { label: 'They cancelled', key: 'cancelled_driver', num: true, render: (r) => fmt(r.cancelled_driver) },
    { label: 'Rider cancelled', key: 'cancelled_client', num: true, render: (r) => fmt(r.cancelled_client) },
    { label: 'Hours', key: 'hours', num: true, render: (r) => fmt(r.hours, 1) },
    { label: 'Gross', key: 'gross', num: true, render: (r) => money(r.gross) },
    { label: 'Cash share', key: 'cash_pct', num: true, render: (r) => pct(r.cash_pct, 0) },
    { label: 'Commission', key: 'commission_cost', num: true, render: (r) => money(r.commission_cost) },
    /* Null on every row with metrics, because the endpoint returns state rows
       and metric rows as disjoint sets and this view filters to the metric
       ones. Said out loud rather than printing a column of dashes that reads
       as "we asked and nobody is suspended". */
    { label: 'State', key: 'state', render: (r) => (r.state
      ? pill(r.state, r.state === 'active' ? 'ok' : 'warn')
      : '<span class="ent-off" title="this report carries counts, not standing — the roster page holds the state">not in this report</span>') },
  ], { sortable: true, sortId: 'funnel', defaultSort: { key: 'offered', dir: 'desc' },
    capped: total && total > rows.length ? `all ${fmt(total)} rows` : null }));
  if (total && total > rows.length) {
    root.append(el('p', 'cap',
      `Showing ${fmt(rows.length)} of ${fmt(total)} driver-period records, the ones the server ranked highest.`));
  } else if (rows.length >= 200) {
    root.append(el('p', 'cap',
      `Showing ${fmt(rows.length)} records — the endpoint caps at 200 and returned exactly that, so there `
      + 'are almost certainly more. The tiles above are over what came back, not over the window.'));
  }
  root.append(note('These counts come from each channel’s own driver report, not from our trip table, '
    + 'and they are per reporting period rather than per day — so they answer "is this driver turning '
    + 'work away", not "what happened on Tuesday". Reporting periods OVERLAP where a backfill and a '
    + 'catch-up describe the same week, so a driver with several rows here has not been offered the sum '
    + 'of them; the rates in each row are sound, the totals across rows are not.'));
  if (state.platform && !['yango', 'bolt'].includes(state.platform)) {
    root.append(note(`Only Yango and Bolt publish an offer count. The ${sourceLabel(state.platform)} `
      + 'filter cannot narrow this page because that channel reports no funnel at all.', 'warn'));
  }
}

V.finance = async (root) => {
  const kh = el('div'); root.append(kh); loading(kh);
  const g = el('div', 'grid g2'); root.append(g);
  /* Fares per day, and titled as such. Platform statements are weekly, so this
     series can only be the metered half — the tiles above carry the combined
     figure, and a panel titled Revenue beside them implied this was the same
     money at a finer grain. */
  const rev = panel('Fares per day', 'Metered fares only — platform payouts are weekly and appear in the tiles above'); g.append(rev.panel);
  const pay = panel('Payment mix', 'Cash vs card vs wallet — cash is money the fleet has to collect'); g.append(pay.panel);
  const g2 = el('div', 'grid g2'); root.append(g2);
  /* The old caption named Uber Black and Comfort over a table that can never
     contain them: the Uber trip export has no fare column, so the only rows
     that can ever appear here are the hotel and Yango ones. The honest
     sentence already existed twenty lines down and only fired when the table
     was completely empty. */
  const tier = panel('What each priced tier earns',
    'Only channels that price per trip can appear here — on this fleet that is the hotel and Yango '
    + 'bookings. Uber names a tier on every trip and carries no fare at all, so no Uber tier can '
    + 'reach this table however much it earned.');
  g2.append(tier.panel);
  const comp = panel('Earnings components', 'How the platform breaks a payout down: fares, tips, promotions, and what it deducts'); g2.append(comp.panel);
  const tips = panel('Tips by driver', 'Service quality expressed in money. Riders tip the experience, not the route.'); root.append(tips.panel);
  const led = panel('Ledger by category', 'Platform fees, bonuses and adjustments'); root.append(led.panel);
  [rev.body, pay.body, tier.body, comp.body, tips.body, led.body].forEach(loading);

  const [k, daily, payDetail, byProd, ledger, components, tipRows, bySvc] = await Promise.all([
    q('/api/kpis'), q('/api/trips/daily'), q('/api/mix/detail', { by: 'payment' }), q('/api/mix'),
    q('/api/finance/ledger'),
    q('/api/earnings/components').catch(() => []),
    q('/api/earnings/tips').catch(() => []),
    q('/api/mix', { by: 'service' }).catch(() => []),
  ]);

  /* Cash is three labels on this fleet — `cash` (Uber), `cash-driver` and
     `cash-supervisor` (hotel) — and /api/mix/detail returns them ordered by
     count, so `.find` always landed on the Uber one, whose revenue is null
     because that export has no fare column. The tile rendered "—" while the
     fleet was holding real money. Read from the settlement endpoint instead, so
     this and the Settlement page cannot disagree about what cash is. */
  const settle = await q('/api/settlement/mix').catch(() => ({ classes: [] }));
  const cash = (settle.classes || []).find((c) => c.settlement_class === 'cash');
  /* Tolerant of both shapes. The backend audit gave /api/earnings/tips the
     {rows, total, shown, truncated} envelope every other list route carries —
     the same change it made to /api/driver/custody and /api/funnel/drivers.
     Two of those three were covered here and this one was not, so #finance
     died on `tipRows.reduce is not a function` the moment the two halves of
     the audit were merged. Neither half was wrong on its own; nobody ran the
     smoke on the merge. */
  const tipList = Array.isArray(tipRows) ? tipRows : (tipRows?.rows || []);
  const tipTotal = tipList.reduce((a, r) => a + (+r.tips || 0), 0);
  const fareTotal = tipList.reduce((a, r) => a + (+r.fare || 0), 0);

  /* Every money figure here covers only the trips that carry a fare. The Uber
     trip export has no fare column at all and telematics trips have none
     either, so on this fleet that is roughly a fifth of the rows. Dividing by
     everything showed an average fare of AED 6.98 against a real figure near
     AED 125. Each tile now names the base it was computed over. */
  const coverage = k.priced_pct != null
    ? `${fmt(k.priced_trips)} of ${fmt(k.trips)} trips carry a fare (${pct(k.priced_pct, 1)})`
    : 'no priced trips in this range';

  const kpis = kpiRow([
    /* The fleet's whole income leads, with the two channels it is made of
       beside it. Revenue alone led here, and revenue is sum(price) over the
       trip table — which for this fleet is the hotel and Yango channels and
       nothing else, because the Uber export has no fare column. A page titled
       Finance opened on a number covering 9% of the work. */
    { label: 'Money in', value: money(k.accounted),
      sub: k.payout_coverage_pct != null && k.payout_coverage_pct < 90
        ? `fares plus platform payouts — payouts cover ${pct(k.payout_coverage_pct, 0)} of the window`
        : 'fares plus platform payouts',
      tone: k.payout_coverage_pct != null && k.payout_coverage_pct < 60 ? 'warn' : null },
    /* The halves of Money in, not the raw reported sums. A channel that reports
       both fares and payouts contributes only the one it is counted on — the
       payout is what is left of those same fares after commission — so these
       two tiles add to the one above them and the raw sums do not. */
    { label: 'Fares', value: money(k.accounted_fares), sub: coverage,
      tone: k.priced_pct != null && k.priced_pct < 40 ? 'warn' : null },
    { label: 'Platform payouts', value: money(k.accounted_payouts),
      sub: k.payout_days
        ? `${(k.payout_platforms || []).map(sourceLabel).join(', ')} · ${countOf(k.payout_days, 'day')} of statements, `
          + `${countOf(k.payout_drivers, 'driver')}`
        : 'no payout statement covers this range' },
    /* The statement view beside the bank view. What the fleet EARNED on trip
       (gross minus commission, from the platform's statement reports) vs what
       REACHED the bank (the payout — net of the cash drivers already hold,
       plus tips and tolls). Reconciled to 0.7% on July 2026; a payout below
       the on-trip figure is drivers holding cash, not missing money. */
    { label: 'On-trip revenue', value: money(k.statement_net),
      sub: k.statement_net != null
        ? `gross − commission, from platform statements · ${(k.statement_platforms || []).map(sourceLabel).join(', ')}`
        : 'not collected for this range yet' },
    { label: 'Average fare', value: money(k.avg_fare, 'AED', 2),
      sub: k.priced_trips ? `over ${fmt(k.priced_trips)} priced trips` : 'no fares in this range' },
    /* The server divides priced_measured_revenue by priced_km — the fares of
       trips reporting BOTH a fare and a distance — and reports that numerator
       so the ratio can be checked. This tile printed only the denominator, so
       the reader divided the Fares tile above (AED 65,708) by 14,895 km, got
       4.41, and had no way to reach 3.91 from anything on screen. */
    { label: 'Revenue per km', value: money(k.revenue_per_km, 'AED', 2),
      sub: k.priced_km
        ? `${money(k.priced_measured_revenue)} over ${fmt(k.priced_km)} km — the `
          + `${fmt(k.priced_measured_trips)} trips reporting both a fare and a distance`
        : 'no priced distance' },
    /* Named for the part of it that was measured. This tile printed
       "AED 23,964" against "45,734 cash bookings; 509 of them report a fare"
       and was read as the cash the fleet is holding — it is the value of 1.1%
       of those bookings. The coverage moved into the label, where it cannot be
       skipped, and the tile links to the page that lists who holds it. */
    { label: 'Cash collected — measured portion',
      value: cash ? (cash.revenue == null ? 'not reported' : money(cash.revenue)) : money(0),
      sub: cash
        ? `the ${fmt(cash.priced_trips)} of ${fmt(cash.trips)} cash bookings that report a fare `
          + `(${pct(cash.trips ? (cash.priced_trips / cash.trips) * 100 : 0, 1)}) — the rest are `
          + 'real money with no figure attached'
        : 'no cash booking in this range',
      tone: cash && cash.priced_trips < cash.trips ? 'warn' : null },
    { label: 'Tips', value: tipTotal ? money(tipTotal) : '—',
      sub: fareTotal ? `${((tipTotal / fareTotal) * 100).toFixed(2)}% of net fare` : 'no tip data collected yet',
      tone: fareTotal ? (tipTotal / fareTotal >= 0.03 ? 'good' : 'warn') : null },
  ]);
  kh.replaceWith(kpis);

  // Say the coverage out loud once, under the tiles, so nobody reads the
  // revenue line as the fleet's whole income.
  if (k.priced_pct != null && k.priced_pct < 90) {
    kpis.after(note(
      `Fares cover ${pct(k.priced_pct, 1)} of trips — the other ${fmt(k.trips - k.priced_trips)} ` +
      `carry no fare at all, because Uber's trip export omits them and telematics trips have none. ` +
      `That work is paid for, and the money arrives as weekly platform statements rather than per-trip ` +
      `fares, which is what Platform payouts counts. The two are different measurements — a fare is what ` +
      `a rider paid, a payout is a statement net of the platform's commission — so Money in is their sum ` +
      `and every tile below it is over fares only.`));
  }

  areaChart(rev.body, daily, { x: 'd', y: 'revenue', color: '--s3', valueFmt: (v) => money(v) });
  paymentDonut(pay.body, payDetail);

  /* Tier economics: the count alone hides the point, which is that a tier can
     be a small share of trips and a large share of revenue, or the reverse. */
  tier.body.innerHTML = '';
  /* Per-trip revenue must divide by the PRICED trips, not by all of them. The
     API already returns `priced_n` and `revenue_per_trip` for exactly this, and
     the page was recomputing `revenue / n` instead — so a tier where 40 of
     4,000 trips carried a fare reported AED 0.30 per trip against a real
     AED 30, and the derived sentence claimed one tier earned 666x another. */
  const perTrip = (r) => (r.revenue_per_trip != null ? +r.revenue_per_trip
    : r.priced_n ? +r.revenue / r.priced_n : null);
  const withRev = byProd.filter((r) => perTrip(r) != null);
  if (!withRev.length) {
    tier.body.append(note('No fares attached to any product tier in this range. Uber\'s trip export names the tier but carries no fare column at all, so no Uber tier can appear here — this table fills from the hotel, Yango and Bolt channels.'));
    if (byProd.length) tier.body.append(tableFrom(byProd.slice(0, 10), [
      { label: 'Tier', key: 'label' }, { label: 'Trips', key: 'n', num: true, render: (r) => fmt(r.n) },
    ], { compact: true, sortable: true, sortId: 'tiersnorev', defaultSort: { key: 'n', dir: 'desc' } }));
  } else {
    const totalTrips = withRev.reduce((a, r) => a + r.n, 0);
    const totalRev = withRev.reduce((a, r) => a + (+r.revenue || 0), 0);
    tier.body.append(tableFrom(withRev.slice(0, 10), [
      { label: 'Tier', key: 'label' },
      { label: 'Trips', key: 'n', num: true, render: (r) => fmt(r.n) },
      { label: 'Priced', key: 'priced_n', num: true, render: (r) => `${fmt(r.priced_n)} of ${fmt(r.n)}` },
      { label: 'Fares', key: 'revenue', num: true, absent: UBER_FARE,
        render: (r) => money(r.revenue) },
      { label: 'Share of revenue', key: '_sr', num: true, render: (r) => pct(((+r.revenue || 0) / totalRev) * 100, 1) },
      { label: 'Per priced trip', key: '_pt', num: true,
        sortValue: (r) => perTrip(r),
        render: (r) => money(perTrip(r), 'AED', 2) },
    ], { compact: true, sortable: true, sortId: 'tierrev', defaultSort: { key: 'revenue', dir: 'desc' } }));
    /* Compare only within one platform. An Uber tier and a hotel booking type
       are not alternatives an operator can choose between, so a ratio across
       them is not a finding — it is a category error with a number attached. */
    const byPlatform = new Map();
    for (const r of withRev) {
      const list = byPlatform.get(r.platform) || [];
      list.push(r); byPlatform.set(r.platform, list);
    }
    const comparable = [...byPlatform.entries()].filter(([, list]) => list.length > 1)
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (comparable) {
      const [platform, list] = comparable;
      const sorted = [...list].sort((a, b) => perTrip(b) - perTrip(a));
      const best = sorted[0], worst = sorted[sorted.length - 1];
      const ratio = perTrip(worst) > 0 ? perTrip(best) / perTrip(worst) : null;
      const strip = (l) => String(l).replace(/^[^:]+:\s*/, '');
      tier.body.append(el('p', 'cap',
        `On ${esc(platform)}, ${esc(strip(best.label))} earns ` +
        (ratio ? `${ratio.toFixed(1)}x per priced trip what ${esc(strip(worst.label))} does ` : 'more per priced trip ') +
        `(${money(perTrip(best), 'AED', 2)} vs ${money(perTrip(worst), 'AED', 2)}). ` +
        `Trip length differs between tiers, so compare per-kilometre before reallocating vehicles. ` +
        `Tiers are only compared within one platform — an Uber tier and a hotel booking type are not alternatives.`));
    } else {
      tier.body.append(el('p', 'cap',
        'Only one priced tier per platform in this range, so there is nothing to compare against.'));
    }
  }

  /* Uber's own personal-vs-business split. Worth stating even when it is
     one-sided: "no business work at all" is a finding, and an empty panel
     reads as a missing feature rather than an absent revenue line. */
  const named = bySvc.filter((r) => r.label && r.label !== 'unknown');
  if (named.length) {
    const biz = named.filter((r) => /business|corporate|u4b/i.test(r.label));
    const total = named.reduce((a, r) => a + r.n, 0);
    tier.body.append(el('p', 'cap', biz.length
      ? `Uber splits these into ${named.map((r) => `${esc(r.label.replace(/_/g, ' '))} ${fmt(r.n)}`).join(', ')} — ` +
        `business work is ${pct((biz.reduce((a, r) => a + r.n, 0) / total) * 100, 1)} of trips.`
      : `Uber labels every one of these ${fmt(total)} trips “${esc(named[0].label.replace(/_/g, ' '))}”. ` +
        `There is no Uber for Business work in the record — that channel is either not enabled for this org or unused.`));
  }

  /* Components arrive signed: fares and tips add, cash already collected and
     fees subtract. Drawing them all one way would show a deduction as income. */
  comp.body.innerHTML = '';
  if (!components.length) {
    comp.body.append(note('No payout breakdown collected yet. Uber publishes components per payout period; they appear once a period covering this range has been pulled.'));
  } else {
    comp.body.append(componentTree(components));
  }

  /* Tips are the one quality signal riders pay for directly. */
  tips.body.innerHTML = '';
  if (!tipList.length) {
    tips.body.append(note('No tip data yet. Tips never appear in the trip feed — they come from the Uber payout breakdown, which fills in per payout period.'));
  } else {
    /* A rate over a tiny base is not a ranking.
       The top row was AED 10 of tips on AED 63 of fare — 15.75%, a green pill,
       first place — above a driver who took AED 30 on AED 506. A ratio needs
       a base before it means anything, so the tone is withheld below a floor
       and the row says why rather than disappearing. */
    /* The floor is the SERVER'S, and it excludes rather than merely untoning.
       ─────────────────────────────────────────────────────────────────────
       /api/earnings/tips has `HAVING sum(net_fare) >= 300`, so a driver below
       the floor never reaches this page at all. It returns fare_floor,
       excluded_n and total so the page can say so — its own comment asks for
       exactly the sentence below — and the page instead hardcoded 300 again
       and counted the received rows that fall under it. That count is always
       ZERO, because the server already removed them, so the branch explaining
       a short list could never fire and the seven drivers it dropped were
       invisible. One filter, applied twice, disclosed at neither end. */
    const FARE_FLOOR = tipRows?.fare_floor ?? 300;
    const excluded = tipRows?.excluded_n ?? 0;
    const rankedTotal = tipRows?.total ?? tipList.length;
    const ranked = [...tipList].sort((a, b) => {
      const af = +a.fare >= FARE_FLOOR, bf = +b.fare >= FARE_FLOOR;
      if (af !== bf) return af ? -1 : 1;
      return (+b.tip_pct || 0) - (+a.tip_pct || 0);
    });
    tips.body.append(tableFrom(ranked.slice(0, 30), [
      { label: 'Driver', key: 'driver_name', render: (r) => entity('driver', r.driver_ext_id, r.driver_name || r.driver_ext_id) },
      { label: 'Tips', key: 'tips', num: true, render: (r) => money(r.tips, 'AED', 2) },
      { label: 'Net fare', key: 'fare', num: true, render: (r) => money(r.fare) },
      { label: 'Tip rate', key: 'tip_pct', num: true, render: (r) => {
        if (r.tip_pct == null) return '<span class="ent-off" title="no net fare recorded for this driver">—</span>';
        const enough = +r.fare >= FARE_FLOOR;
        return enough
          ? `<span class="pill ${+r.tip_pct >= 3 ? 'ok' : +r.tip_pct >= 1 ? 'warn' : 'bad'}">${(+r.tip_pct).toFixed(2)}%</span>`
          : `<span class="dim" title="only ${esc(money(r.fare))} of net fare — too small a base to rank on">`
            + `${(+r.tip_pct).toFixed(2)}%</span>`;
      } },
    ], { sortable: true, sortId: 'tips' }));
    const SHOWN = Math.min(30, ranked.length);
    tips.body.append(el('p', 'cap',
      `Tip rate is tips as a share of net fare. It is only toned above ${money(FARE_FLOOR)} of net fare, `
      + 'because a 15% rate on AED 63 outranks a 6% rate on AED 506 while meaning less. '
      + 'It reflects the ride experience more than the route, which is what makes it coachable.'
      + (rankedTotal > SHOWN
        ? ` Showing the ${fmt(SHOWN)} highest of ${countOf(rankedTotal, 'ranked driver')}.` : '')
      + (excluded
        ? ` ${countOf(excluded, 'driver')} took less than ${money(FARE_FLOOR)} of net fare in this `
          + `window and ${plural(excluded, 'is', 'are')} not ranked at all — the rate would be a `
          + 'ratio over a base too small to compare.'
        : '')));
  }

  led.body.innerHTML = '';
  if (ledger.length) {
    /* Signed. Math.abs() made platform fees and VAT — money going out — read
       as credits in the same colour as the bonuses beside them, and dropped
       the net total that says whether the ledger is a cost or an income. */
    const ledRows = ledger.slice(0, 12);
    hbars(led.body, ledRows.map((r) => ({ label: String(r.category).replace(/_/g, ' '), n: +r.amount || 0, n_rows: r.n })), {
      valueFmt: (v) => money(v),
      legend: [['--b400', 'paid to the fleet'], ['--s2', 'taken from the fleet']] });
    const net = ledger.reduce((a, r) => a + (+r.amount || 0), 0);
    const plats = [...new Set(ledger.map((r) => r.platform).filter(Boolean))];
    led.body.append(el('p', 'cap',
      `Net across ${countOf(ledger.length, 'category', 'categories')}: `
      + `${net < 0 ? '−' : ''}${money(Math.abs(net))}`
      + (plats.length ? ` · reported by ${plats.map(sourceLabel).join(', ')}` : '')
      + '. Negative rows are deductions — commission, VAT, adjustments — and are drawn as deductions '
      + 'rather than as magnitudes.'));
  } else empty(led.body, 'Ledger fills once Yango/Bolt credentials are set');
};

/* Safety — three pages, because "which car" and "which person" and "what kind
   of event" are three different questions and the page answered only the first.

   Four things were wrong here and they compounded: the endpoint fetched a
   driver and the view rendered only the plate, so the safety page named nobody;
   the driver it fetched was whoever holds the car TODAY, so a year-old event
   was attributed to the current holder; the four category columns did not add
   up to the Total beside them, with no residual column to explain the gap; and
   a device power fault was charted as harsh driving. */
const SAFETY_TABS = [
  { id: 'people', label: 'By driver', ic: '◧' },
  { id: 'vehicles', label: 'By vehicle', ic: '▤' },
  { id: 'events', label: 'By event type', ic: '△' },
];
V.safety = async (root) => {
  const tab = SAFETY_TABS.some((t) => t.id === state.param) ? state.param : 'people';
  root.append(tabBar(SAFETY_TABS, tab, (id) => href('safety', id === 'people' ? null : id)));
  const host = el('div'); root.append(host);
  loading(host);
  const gen = currentGen();
  const [byType, vehPage, drvPage, fleetK] = await Promise.all([
    q('/api/alerts/summary'), q('/api/alerts/by-vehicle'), q('/api/alerts/by-driver'),
    q('/api/kpis').catch(() => ({}))]);
  if (!alive(gen)) return;
  // Both now return {rows, totals}; the arrays are capped at 100 and the tiles
  // that used to be their lengths read as fleet facts.
  const byVeh = vehPage.rows || vehPage;
  const byDrv = drvPage.rows || drvPage;
  const vTot = vehPage.totals || {};
  const dTot = drvPage.totals || {};
  host.innerHTML = '';

  const total = byType.reduce((a, r) => a + r.n, 0);
  if (!total) {
    host.append(note('No harsh-driving event landed in this window. These come from the FMS '
      + 'telematics layer — check Collection gaps before reading that as good news.'));
    return;
  }

  /* Verified against /api/alerts/summary: it returns [{alert_type, n}] and
     nothing else, so every rate on this page has to come from the vehicle and
     driver totals beside it rather than from this array. */
  {
    const top = [...byType].sort((a, b) => b.n - a.n)[0];
    const tracked = +fleetK?.tracked_vehicles || vTot.vehicles || 0;
    const per = tracked ? Math.round(total / tracked) : null;
    const worst = (byDrv || [])[0];
    verdict(host, {
      claim: top
        ? `${top.alert_type} is ${Math.round((top.n / total) * 100)}% of every event the trackers raised`
        : `${fmt(total)} harsh-driving events`,
      figure: per != null ? fmt(per) : fmt(total),
      unit: per != null ? 'events per tracked vehicle' : 'events',
      tone: null,
      meta: tracked ? `${fmt(tracked)} tracked vehicles` : null,
      sub: `${fmt(total)} events across ${fmt(byType.length)} ${plural(byType.length, 'type')}.`
        + (worst?.driver_name
          ? ` The highest rate belongs to ${worst.driver_name}; a rate is only comparable per 100 km, `
            + 'which is what the table below ranks on.'
          : '')
        + ' These come from the telematics box, so no channel filter narrows them.',
    });
  }
  /* A tracker losing power is a hardware fault, not a driving style. Charted
     together they were one number under a heading about harsh driving. */
  const DEVICE = /power|battery|tamper|disconnect|gps/i;
  const device = byType.filter((r) => DEVICE.test(r.alert_type));
  const driving = byType.filter((r) => !DEVICE.test(r.alert_type));
  const drivingN = driving.reduce((a, r) => a + r.n, 0);
  // Over the whole window, not over the returned rows.
  const unattributed = dTot.unattributed ?? byVeh.reduce((a, r) => a + (r.unattributed || 0), 0);

  /* Harsh driving comes from the box bolted to the car. There is no channel on
     it at all, so the platform chip at the top of the page narrows nothing —
     and /api/alerts/summary returned a byte-identical body under every value
     of it, which reads as "Uber drivers brake exactly as hard as everyone
     else" rather than as "this control does not apply here". */
  if (state.platform) {
    host.append(note(`The platform filter does not apply on this page. A harsh-braking event comes from `
      + `the telematics box on the vehicle, not from a booking channel, so there is no ${
        esc(sourceLabel(state.platform))} subset of it — every figure below is the whole fleet.`, 'warn'));
  }
  const fleetVehicles = fleetK.tracked_vehicles ?? fleetK.vehicles;
  host.append(kpiRow([
    { label: 'Driving events', value: fmt(drivingN), sub: 'harsh braking, acceleration, turns, speed' },
    { label: 'Device faults', value: fmt(total - drivingN),
      sub: 'power loss and similar — a tracker problem, not a driver one',
      tone: total - drivingN ? 'warn' : null },
    /* With a denominator. "Vehicles involved 63" is half the fleet or most of
       it depending on a number this page did not print. */
    { label: 'Vehicles involved', value: fleetVehicles
      ? `${fmt(vTot.vehicles ?? byVeh.length)} of ${fmt(fleetVehicles)}`
      : fmt(vTot.vehicles ?? byVeh.length),
      sub: fleetVehicles
        ? `${pct(((vTot.vehicles ?? byVeh.length) / fleetVehicles) * 100, 0)} of the tracked fleet`
        : (vehPage.truncated ? `${fmt(byVeh.length)} shown` : 'every one of them listed below') },
    { label: 'Drivers named', value: fmt(dTot.drivers
      ?? byDrv.filter((r) => r.driver_name !== '(unattributed)').length),
      sub: 'people custody could attribute an event to' },
    { label: 'Events nobody held the car for', value: fmt(unattributed),
      sub: unattributed ? 'no custody record for that plate on that day' : 'every event has a driver',
      tone: unattributed ? 'warn' : null },
  ]));

  if (tab === 'events') {
    const g = el('div', 'grid g2'); host.append(g);
    const dp = panel('Driving events', 'Behaviour the fleet can coach.');
    donut(dp.body, driving.map((r) => ({ label: r.alert_type, n: r.n })));
    g.append(dp.panel);
    const fp = panel('Device faults', 'A tracker losing power is a hardware ticket, not a coaching conversation.');
    if (device.length) donut(fp.body, device.map((r) => ({ label: r.alert_type, n: r.n })));
    else empty(fp.body, 'No device fault in this window');
    g.append(fp.panel);
    host.append(note('These were one donut, totalled as a single figure under a heading about harsh '
      + 'driving. They are two different problems with two different owners.'));
    return;
  }

  if (tab === 'vehicles') {
    const vp = panel('Worst vehicles', 'Click a bar to open that vehicle.');
    hbars(vp.body, byVeh.slice(0, 12).map((r) => ({ label: r.plate, n: r.alerts })), {
      color: '--s8', onClick: (d) => { location.hash = href('vehicle', d.label, 'safety'); } });
    host.append(vp.panel);
    /* Sixty-three rows starting straight under a chart of the worst twelve,
       with nothing saying what they were or how many. */
    const vtab = panel(`Every vehicle with an event — ${countOf(byVeh.length, 'vehicle')}`,
      'The four named categories and Other add up to Total. Drivers that window counts everyone who '
      + 'held the car on a day one of these happened.');
    host.append(vtab.panel);
    vtab.body.append(tableFrom(byVeh, [
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
      { label: 'Total', key: 'alerts', num: true },
      { label: 'Harsh brake', key: 'harsh_brake', num: true },
      { label: 'Harsh accel', key: 'harsh_accel', num: true },
      { label: 'Sharp turn', key: 'sharp_turn', num: true },
      { label: 'Overspeed', key: 'overspeed', num: true },
      // The residual, so the columns and the total reconcile instead of
      // silently disagreeing by however many event types are not in the four.
      { label: 'Other', key: 'other', num: true },
      { label: 'Drivers that window', key: 'drivers', num: true },
      { label: 'Most often', key: 'top_driver',
        render: (r) => (r.top_driver ? entity('driver', r.top_driver_id, r.top_driver)
          : '<span class="ent-off" title="no custody record on the days these events happened">unattributed</span>') },
    ], { sortable: true, sortId: 'safetyveh', defaultSort: { key: 'alerts', dir: 'desc' } }));
    if (vehPage.truncated) {
      vtab.body.append(el('p', 'cap',
        `Showing ${fmt(byVeh.length)} of ${fmt(vTot.vehicles ?? byVeh.length)} vehicles with an event, `
        + 'the worst first. Sorting re-orders those rows and does not reach the rest.'));
    }
    vtab.body.append(note('Each event is attributed to whoever held the car ON THE DAY it happened, not to '
      + 'whoever holds it now — and vehicle_driver_day carries one row per platform, so custody is '
      + 'collapsed to one driver per plate-day before counting. Joining it directly once showed 584 '
      + 'events twice under two spellings of one name.'));
    return;
  }

  // people
  const named = byDrv.filter((r) => r.driver_name !== '(unattributed)');
  const dp = panel('Who drives hardest', 'Events per 100 km of booked distance, where that distance is known.');
  /* SORTED by the rate the bars are drawn from, and only then cut to twelve.
     The rows arrive ordered by raw event count, so the bars — whose length is
     the per-100km rate — descended and then jumped, and a sequential ramp was
     painted down them reinforcing an order the lengths contradicted. A driver
     with 40 events over 3,000 km sat above one with 12 over 90.
     A rate also needs a small-sample floor: three events over 40 km is 7.5 per
     100 km and means nothing. */
  const KM_FLOOR = 200;
  const rated = named.filter((r) => r.per_100km != null && +r.booked_km >= KM_FLOOR)
    .sort((a, b) => Number(b.per_100km) - Number(a.per_100km)).slice(0, 12);
  const thinKm = named.filter((r) => r.per_100km != null && +r.booked_km < KM_FLOOR).length;
  if (rated.length) {
    hbars(dp.body, rated.map((r) => ({
      label: `${r.driver_name} · ${fmt(r.booked_km)} km`, n: Number(r.per_100km), id: r.driver_ext_id })), {
      color: '--s8', valueFmt: (v) => `${fmt(v, 2)} / 100km`, signed: false,
      onClick: (d) => { if (d.id) location.hash = href('driver', d.id, 'quality'); } });
    dp.body.append(el('p', 'cap', 'Ordered by the rate the bars measure, with the distance it was '
      + `computed over beside each name. Drivers under ${fmt(KM_FLOOR)} booked km are left out`
      + (thinKm ? ` (${countOf(thinKm, 'driver')})` : '')
      + ' — a handful of events over a few kilometres produces a large rate and no finding. '
      + 'The distance is BOOKED kilometres: dividing by every trip in the table would count each '
      + 'journey twice, once as a booking and once as its telematics twin.'));
  } else {
    empty(dp.body, named.some((r) => r.per_100km != null)
      ? `No driver in this window has both events and at least ${fmt(KM_FLOOR)} km of booked distance to `
        + 'rate them over.'
      : 'No driver in this window has both events and a known distance');
  }
  host.append(dp.panel);
  /* The longest table on the page carried no heading — sixty-two rows of names
     and event counts that began immediately under a chart about something
     else, with nothing saying what the rows were or how many there were. */
  const dtab = panel(`Every driver with an event — ${countOf(byDrv.length, 'row')}`,
    'One row per person, plus a row for the events no custody record could attribute. '
    + 'The four named categories and Other add up to Events.');
  host.append(dtab.panel);
  dtab.body.append(tableFrom(byDrv, [
    { label: 'Driver', key: 'driver_name',
      render: (r) => (r.driver_ext_id ? entity('driver', r.driver_ext_id, r.driver_name)
        : `<span class="ent-off">${esc(r.driver_name)}</span>`) },
    { label: 'Events', key: 'alerts', num: true },
    { label: 'Harsh brake', key: 'harsh_brake', num: true },
    { label: 'Harsh accel', key: 'harsh_accel', num: true },
    { label: 'Sharp turn', key: 'sharp_turn', num: true },
    { label: 'Overspeed', key: 'overspeed', num: true },
    /* Which cars, not just how many. "18 events across 4 vehicles" is not
       something anybody can look into until they know which 4, and a count is
       not a thing you can click. */
    { label: 'Vehicles', key: 'plate_list', render: (r) => {
      const list = r.plate_list || [];
      if (!list.length) return `<span class="dim">${fmt(r.plates)}</span>`;
      return list.map((pl) => entity('vehicle', pl, pl)).join(' ')
        + (r.plates > list.length ? ` <span class="dim">+${fmt(r.plates - list.length)}</span>` : '');
    } },
    { label: 'Booked km', key: 'booked_km', num: true, render: (r) => fmt(r.booked_km) },
    /* The residual. by-vehicle carries an `other` column so its four categories
       reconcile with the Total beside them; by-driver did not, so six rows in
       sixty printed four numbers that did not add up to the fifth with nothing
       to explain the difference — 1,201 events shown as 703. Rendered from the
       endpoint's own column when it grows one, and computed here in the
       meantime so the arithmetic is visible either way. */
    { label: 'Other', key: 'other', num: true, render: (r) => {
      const four = (+r.harsh_brake || 0) + (+r.harsh_accel || 0) + (+r.sharp_turn || 0) + (+r.overspeed || 0);
      const rest = r.other != null ? +r.other : (+r.alerts || 0) - four;
      return rest > 0
        ? `<span title="event types outside the four columns — device faults and anything the tracker names differently">${fmt(rest)}</span>`
        : '0';
    } },
    { label: 'Per 100 km', key: 'per_100km', num: true,
      render: (r) => (r.per_100km == null
        ? '<span class="ent-off" title="no booked distance on the days these events happened">distance unknown</span>'
        : `${fmt(r.per_100km, 2)}${+r.booked_km < 200
          ? '<span class="dim" title="under 200 booked km — too small a base to compare on"> ·  thin</span>' : ''}`) },
  ], { sortable: true, sortId: 'safetydrv', defaultSort: { key: 'alerts', dir: 'desc' } }));
  if (byDrv.some((r) => r.driver_name === '(unattributed)')) {
    dtab.body.append(note('"(unattributed)" is not a person. It is every event on a plate-day with no '
      + 'custody record — shown rather than folded into somebody else\'s total.'));
  }
};

V.unauthorized = async (root) => {
  const vuHost = el('div'); root.append(vuHost);
  const kh = el('div', 'kpis'); root.append(kh);
  const g = el('div', 'grid g23'); root.append(g);
  const trend = panel('Occupancy per day', 'Unexplained intervals against every occupancy interval seen'); g.append(trend.panel);
  const verdicts = panel('How segments resolve', 'Every seat-occupancy interval, classified'); g.append(verdicts.panel);
  const veh = panel('Vehicles with unexplained trips', 'Ranked by count — click to inspect'); root.append(veh.panel);
  const list = panel('Flagged segments', 'Click a row for the full evidence trail'); root.append(list.panel);
  const health = panel('Seat-sensor health', 'A dead or stuck pad makes the numbers above unreliable'); root.append(health.panel);
  [kh, trend.body, verdicts.body, veh.body, list.body, health.body].forEach(loading);

  const gen = currentGen();
  const [sum, daily, byVeh, rows, sensors] = await Promise.all([
    q('/api/unauthorized/summary'), q('/api/unauthorized/daily'), q('/api/unauthorized/by-vehicle'),
    q('/api/unauthorized/list', { verdict: 'unauthorized' }), q('/api/sensor-health'),
  ]);
  /* The reader has navigated. Everything below writes into panels that are no
     longer on the page — including root.insertBefore, which throws "not a
     child of this node" and whose catch replaces the whole view with an error
     box that only a reload clears. */
  if (!alive(gen)) return;
  // {rows, total, shown, truncated} — tolerant of the old bare array.
  const vehRows = byVeh.rows || (Array.isArray(byVeh) ? byVeh : []);
  const t = sum.totals || {};

  /* Verified against /api/unauthorized/summary on production before writing
     the sentence: totals carries unauthorized, authorized, unverifiable,
     pending, partial, stationary, segments, unauth_km, needs_a_human. */
  {
    const unauth = +t.unauthorized || 0;
    const human = +t.needs_a_human || 0;
    const segs = +t.segments || 0;
    const km = +t.unauth_km || 0;
    verdict(vuHost, {
      claim: unauth
        ? `${countOf(unauth, 'journey')} moved a car with no booking behind it`
        : segs ? 'Every journey in this window has a booking behind it'
          : 'No telematics journey in this window',
      figure: unauth ? fmt(unauth) : fmt(+t.authorized || 0),
      unit: unauth ? 'unauthorized' : 'accounted for',
      tone: unauth ? 'bad' : null,
      meta: segs ? `${fmt(segs)} journeys examined` : null,
      sub: `${fmt(km)} km ran under those journeys.`
        + (human ? ` ${fmt(human)} more ${plural(human, 'journey')} cannot be decided by the `
          + 'data alone and are waiting on a person.' : '')
        + (+t.partial ? ` ${fmt(t.partial)} are partial matches — a booking covers some of the `
          + 'movement and not all of it.' : ''),
      recommend: unauth
        ? 'Each one opens its own segment page with the trace and the bookings it was compared against.'
        : null,
    });
  }
  const segTotal = (sum.byVerdict || []).reduce((a, r) => a + (+r.n || 0), 0);
  /* Five tiles accounted for 299 of 382 segments. `stationary` and
     `unverifiable` were in the donut beside them and had no tile, so the
     numbers on the page did not add up to the page — and `needs_a_human`, a
     field NAMED for an operator action, was displayed nowhere at all. */
  kh.innerHTML = [
    ['Unexplained trips', fmt(t.unauthorized || 0),
      segTotal ? `of ${fmt(segTotal)} occupancy intervals — no booking on any channel` : 'no booking on any channel'],
    /* A null distance is not zero km. The tile printed a confident "0 km" for
       segments whose distance was never measured. */
    ['Unexplained km', t.unauth_km == null ? '—' : fmt(t.unauth_km) + ' km',
      t.unauth_km == null ? 'no distance was measured on these segments' : 'distance carried off-book'],
    ['Matched to a booking', fmt(t.authorized || 0), 'legitimate, reconciled'],
    ['Occupied but stationary', fmt(t.stationary || 0), 'seat occupied, the vehicle never really moved'],
    ['Sensor suspect', fmt(t.sensor_suspect || 0), 'excluded — likely hardware'],
    ['Inconclusive', fmt(t.partial || 0), 'telemetry gaps — cannot judge'],
    ['Could not be verified', fmt(t.unverifiable || 0), 'a revenue channel was unreadable at the time'],
    ['Needs a human', fmt(t.needs_a_human ?? ((t.unverifiable || 0) + (t.partial || 0))),
      'segments no rule can settle — somebody has to look'],
  ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');

  /* What the figures above actually cover.
     Seat occupancy comes from a five-minute realtime poll with no history
     behind it, so on this fleet the evidence spans about three days. The page
     was reporting "0 unexplained trips" over a thirty-day window on that basis
     — right about three days, presented as an answer about thirty. */
  const cov = sum.coverage;
  if (cov && !cov.complete) {
    const w = el('div', 'panel');
    w.innerHTML = `<div class="note warn">Seat-occupancy evidence covers `
      + `<b>${fmt(cov.days_with_data)} of the ${fmt(cov.days_in_window)} days</b> in this window. `
      + `The other ${fmt(cov.days_in_window - cov.days_with_data)} have no sensor data at all, so nothing `
      + `on them could be judged either way — the figures below describe the days that do, not the range you picked.</div>`;
    root.insertBefore(w, g);
  }

  if (t.low_confidence) {
    const w = el('div', 'panel');
    w.innerHTML = `<div class="note err">⚠ ${countOf(t.low_confidence, 'flagged segment')} `
      + `${plural(t.low_confidence, 'was', 'were')} assessed while a revenue channel was unavailable `
      + '— a booking may exist that we could not read. Fix the source in Settings before acting on '
      + 'these.</div>';
    root.insertBefore(w, g);
  }

  /* Every click here used to open a modal. A flag against a named driver is
     the most serious claim this product makes, and it needs an address you can
     paste into a message — so each of these now navigates to a page. */
  /* The unexplained count against every occupancy interval seen that day.
     This plotted `unauthorized` alone under a title promising "unauthorized vs
     booked", and unauthorized is zero on every day — so a page holding 136
     segments drew an empty chart on an axis of 0 to 1, and read as "we looked
     and there is nothing". The truth is that 68 of those 136 could not be
     judged at all, which is a different statement entirely.

     gapBars rather than barChart, because a day with no seat-occupancy data and
     a day where the sensor saw nobody are different facts and only one of them
     is a zero. */
  gapBars(trend.body, daily, { x: 'd', y: 'unauthorized', secondary: 'segments',
    color: '--s8', label: 'unexplained', secondaryLabel: 'occupancy intervals seen',
    gapLabel: 'no seat-occupancy data',
    onClick: (d) => { location.hash = href('segments', 'day', dayKey(d.d)); } });
  trend.body.append(el('p', 'cap', 'The pale bar is every occupancy interval seen that day; the solid one is the '
    + 'unexplained share. Click for that day’s segments — the day’s full picture, every source and platform, is on its own page.'));
  donut(verdicts.body, (sum.byVerdict || []).map((r) => ({ label: r.verdict, n: r.n })),
    { onClick: (d) => { location.hash = href('segments', 'verdict', d.label); } });

  veh.body.innerHTML = '';
  // Show who was driving, not just which plate — a flag against a car nobody can
  // name is not something anyone can act on.
  if (vehRows.length) {
    hbars(veh.body, vehRows.slice(0, 12).map((r) => ({
      label: r.drivers ? `${r.plate} · ${r.drivers}` : `${r.plate} · driver unknown`,
      plate: r.plate, n: r.unauthorized })), { color: '--s8',
      onClick: (d) => { location.hash = href('segments', 'plate', d.plate || d.label); } });
    veh.body.append(el('p', 'cap', byVeh.total > 12
      ? `The 12 worst of ${fmt(byVeh.total)} vehicles with an unexplained trip in this range.`
      : 'Every vehicle with an unexplained trip in this range.'));
  } else empty(veh.body, 'No unexplained trips detected in this range');

  /* The evidence table lives in segments.js now. This page and that one were
     two implementations of the same table and had drifted: this one printed a
     hardcoded English sentence keyed on the verdict, with no entry for
     `unverifiable` or `pending`, so eight of fifty-two segments opened a blank
     "Why this verdict". Every row is a link to that segment's own page. */
  list.body.innerHTML = ''; list.body.append(segmentTable(rows));

  health.body.innerHTML = '';
  /* "NEVER TRIGGERS" needs enough fixes to be a claim. A plate with 0 occupied
     of 2 fixes was tagged red beside one with 0 of 213 — the second is a
     finding and the first is two samples. */
  const FIX_FLOOR = 20;
  const flagged = sensors.map((s2) => ({ ...s2,
    ratio: s2.total_fixes ? +(s2.occupied_fixes / s2.total_fixes * 100).toFixed(1) : null,
    verdict: s2.sensor_suspect_segments > 0 ? 'suspect'
      : s2.occupied_fixes > 0 ? 'ok'
        : s2.total_fixes >= FIX_FLOOR ? 'never triggers' : 'too few fixes to judge' }));
  const TONE = { ok: 'ok', suspect: 'warn', 'never triggers': 'bad', 'too few fixes to judge': 'dim' };
  health.body.append(tableFrom(flagged, [
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    { label: 'Occupied fixes', key: 'occupied_fixes', num: true },
    { label: 'Total fixes', key: 'total_fixes', num: true },
    { label: 'Occupied %', key: 'ratio', num: true,
      render: (r) => (r.ratio == null
        ? '<span class="ent-off" title="no fix at all from this tracker in this window">—</span>'
        : `${r.ratio}%`) },
    { label: 'Sensor', key: 'verdict',
      render: (r) => `<span class="tag ${TONE[r.verdict]}" title="${
        r.verdict === 'too few fixes to judge'
          ? `only ${fmt(r.total_fixes)} fix(es) — under ${FIX_FLOOR} nothing can be concluded`
          : 'over this window'}">${esc(r.verdict)}</span>` },
  ], { sortable: true, sortId: 'sensors', defaultSort: { key: 'total_fixes', dir: 'desc' } }));
  const unjudged = flagged.filter((r) => r.verdict === 'too few fixes to judge').length;
  health.body.append(el('p', 'cap',
    `${countOf(flagged.length, 'tracker')} reported at all in this window`
    + (unjudged
      ? `, ${fmt(unjudged)} of them with fewer than ${FIX_FLOOR} fixes — those are shown as unjudged `
        + 'rather than as sensors that never fire.'
      : '.')
    + ' A dead pad and a pad on a car that did not move look identical in a ratio; only the fix count '
    + 'separates them.'));
};

/* A tracker reporting 0,0 has no satellite lock; it is not in the Gulf of
   Guinea. map.js already excludes those from the framing — the same test
   belongs to anything that COUNTS a fix. */
const hasFix = (r) => r.lat != null && r.lng != null
  && Number.isFinite(+r.lat) && Number.isFinite(+r.lng)
  && !(Math.abs(+r.lat) < 0.5 && Math.abs(+r.lng) < 0.5);

/* /api/live flags a fix stale at FIX_FRESH — thirty minutes. Kept here so the
   tiles that count that flag can name the rule that produced it. */
const FIX_FRESH_MIN = 30;

V.live = async (root) => {
  const vHost = el('div'); root.append(vHost);
  const kh = el('div', 'kpis'); root.append(kh);
  /* Three feeds, not one. 80 of these rows are FMS, 48 are CABMAN and 2 are
     Uber — and only CABMAN polls every five minutes. The caption named the
     cadence of a minority as the cadence of the page. */
  const p = panel('Live vehicles',
    'Positions from every feed that reports one. Click a row for that vehicle’s movement page.');
  root.append(p.panel);
  [kh, p.body].forEach(loading);
  const gen = currentGen();
  let rows;
  try { rows = await api('/api/live'); } catch (e) {
    if (!alive(gen)) return;
    kh.innerHTML = ''; p.body.innerHTML = '';
    p.body.append(note(`The live feed could not be read: ${e.message}`, 'err'));
    return;
  }
  if (!alive(gen)) return;
  const fresh = rows.filter((r) => !r.stale).length;
  const moving = rows.filter((r) => +r.speed > 3).length;
  /* The threshold behind `stale`, written once so the label cannot drift from
     the number again. /api/live sets the flag at FIX_FRESH — thirty minutes —
     while this tile was headed "Fresh (<11 min)" and the map's read "no fix in
     11 min", both counting the same flag. Eleven is the rule the vehicle and
     economics endpoints use for their own telemetry columns, and it had been
     copied onto a figure it does not describe: 82 of 130 fresh at thirty
     minutes is 65 at eleven. Verified against production — `stale` and
     `fix_age_min >= 30` agreed on all 130 rows, none excepted. */
  /* Denominators, and the right population.
     "Engaged 4 · passenger on board" mixed a CABMAN status STRING with a seat
     SENSOR reading and printed the result against nothing — 82 of these
     vehicles carry no seat sensor at all, so 4 is out of 48 and not out of 130.
     "Vehicles tracked 130 · with a GPS fix" counted two rows with no
     coordinates and three parked on the null island. */
  const sensed = rows.filter((r) => r.seat_occupied != null);
  const engaged = rows.filter((r) => r.seat_occupied === true || /engag/i.test(r.status || '')).length;
  const located = rows.filter(hasFix);
  const noLock = rows.length - located.length;
  const feeds = [...new Set(rows.map((r) => r.source).filter(Boolean))];
  /* "Fresh 80 of 130" invites the reading that the other fifty are a few
     minutes behind. Measured live, 23 of them last reported more than a DAY
     ago and the worst has been dark for weeks — which is a different problem
     with a different owner. The API has returned a silent count since the
     freshness query was written ("so a page can say which vehicles have gone
     quiet instead of quietly dropping them") and no page ever used it; this is
     the same measurement taken from the rows on screen, so the tile and the
     table cannot disagree. */
  const DAY_MIN = 1440;
  const silent = rows.filter((r) => r.fix_age_min != null && r.fix_age_min >= DAY_MIN);
  const worstDays = silent.length
    ? Math.floor(Math.max(...silent.map((r) => r.fix_age_min)) / DAY_MIN) : 0;
  kh.innerHTML = [
    ['Vehicles tracked', fmt(located.length),
      `with a usable fix${noLock ? ` · ${fmt(noLock)} reporting no satellite lock` : ''}`],
    [`Fresh (<${FIX_FRESH_MIN} min)`, fmt(fresh), `of ${fmt(rows.length)} reporting at all`],
    /* Not the same fact as "not fresh". A car in a basement is minutes behind;
       these have stopped reporting altogether. */
    ['Silent over a day', fmt(silent.length),
      silent.length
        ? `last fix more than 24h ago · the quietest ${worstDays >= 1 ? `${fmt(worstDays)} day${worstDays === 1 ? '' : 's'} ago` : 'today'}`
        : 'every tracker has reported in the last 24 hours'],
    ['Moving', fmt(moving), 'speed > 3 km/h'],
    ['Engaged', sensed.length ? `${fmt(engaged)} of ${fmt(sensed.length)}` : fmt(engaged),
      sensed.length
        ? `of the ${fmt(sensed.length)} vehicles whose feed reports a seat sensor`
        : 'no feed here reports a seat sensor'],
  ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');
  p.body.innerHTML = '';
  if (!rows.length) { empty(p.body, 'Positions appear once CABMAN credentials are saved in Settings'); return; }
  if (feeds.length) {
    p.body.append(el('p', 'cap',
      `${feeds.map((f) => `${sourceLabel(f)} ${fmt(rows.filter((r) => r.source === f).length)}`).join(' · ')}. `
      + 'CABMAN polls every five minutes and is the only feed carrying a seat sensor; the others report '
      + 'position and speed only.'));
  }
  const t = tableFrom(rows, [
    // A plate that is only text is a dead end on the one page an operator has
    // open all day. Every vehicle here has a page.
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    /* Who is in it. The endpoint returns this and only the MAP tooltip used it
       — on the page an operator has open all day to decide who to ring. */
    { label: 'Driver', key: 'current_driver',
      render: (r) => (r.current_driver
        ? custodyAsOf({ name: r.current_driver, id: r.current_driver_id, day: r.driver_as_of })
        : '<span class="ent-off" title="no custody record for this plate">nobody on record</span>') },
    { label: 'Fleet', key: 'fleet_id', render: (r) => esc(sourceLabel(r.fleet_id)) },
    { label: 'Feed', key: 'source', render: (r) => esc(sourceLabel(r.source)) },
    { label: 'Status', key: 'status', render: (r) => `<span class="tag ${/engag/i.test(r.status || '') ? 'ok' : 'dim'}">${esc(r.status || '—')}</span>` },
    { label: 'Speed', key: 'speed', num: true, render: (r) => r.speed != null ? fmt(r.speed) + ' km/h' : '—' },
    /* The only place in the product an odometer appears at all. */
    { label: 'Odometer', key: 'odometer', num: true,
      render: (r) => (r.odometer ? `${fmt(r.odometer)} km`
        : '<span class="ent-off" title="this feed does not report an odometer">—</span>') },
    /* 0 is what the FMS feed sends when it has nothing to say, and it was
       rendered as a flat battery on cars doing 68 km/h. */
    /* The API nulls an FMS zero now — it is an absent reading, not an empty
       tank — so a column that is empty for every vehicle drops out with one
       sentence instead of showing 130 explained dashes. */
    { label: 'Charge', key: 'fuel_level', num: true,
      absent: 'no tracker on this fleet reports a fuel or charge level: the FMS feed sends a '
        + 'zero for every vehicle, which is an absent reading rather than an empty tank, and '
        + 'CABMAN and Uber send no level at all',
      render: (r) => (r.fuel_level == null
        ? '<span class="ent-off" title="this feed reports no fuel or charge level">—</span>'
        : `${fmt(r.fuel_level)}%`) },
    { label: 'A/C', key: 'ac_on',
      render: (r) => (r.ac_on == null
        ? '<span class="ent-off" title="not reported by this feed">—</span>'
        : r.ac_on ? '<span class="tag">on</span>' : '<span class="tag dim">off</span>') },
    { label: 'Seat', key: 'seat_occupied', /* Three states, not two. Only the CABMAN feed carries a seat sensor; FMS and
   Uber carry none, so collapsing NULL into "empty" asserted a measurement that
   does not exist for 83 of 130 vehicles. */
      render: (r) => (r.seat_occupied === null || r.seat_occupied === undefined
        ? '<span class="tag dim">not reported</span>'
        : r.seat_occupied ? '<span class="tag ok">occupied</span>' : '<span class="tag">empty</span>') },
    { label: 'Fix age', key: 'fix_age_min', num: true,
      render: (r) => `<span class="tag ${r.stale ? 'warn' : 'ok'}">${
        r.fix_age_min != null ? `${fmt(r.fix_age_min)} min` : (r.stale ? 'stale' : 'live')}</span>` },
    { label: 'Last fix', key: 'captured_at', render: (r) => timeStr(r.captured_at) },
    /* When WE last asked, beside when the tracker last SAW it.
       ─────────────────────────────────────────────────────────────────────
       These two answer different questions and only one of them was on screen.
       A fix two weeks old with a poll one minute old means the provider is
       still listing the vehicle and still handing back the same ancient
       reading — the failure the freshness query in api/server.js was rewritten
       to expose, because polled_at satisfies a dormant vehicle forever. A fix
       and a poll that are BOTH old means our collector stopped asking. One is
       the fleet's problem and one is ours, and the page could not tell them
       apart. */
    { label: 'Last polled', key: 'poll_age_min', num: true,
      absent: 'no feed here records when it was last polled',
      render: (r) => {
        if (r.poll_age_min == null) return '<span class="ent-off">—</span>';
        const stalePoll = r.poll_age_min >= 60;
        const gap = r.fix_age_min != null && r.fix_age_min - r.poll_age_min >= 1440;
        return `<span class="tag ${stalePoll ? 'warn' : 'dim'}" title="${stalePoll
          ? 'nothing has asked this feed for over an hour — that is our collector, not the vehicle'
          : gap ? 'we asked a moment ago and got back a fix that is over a day old — the provider is still listing this vehicle and reporting nothing new about it'
            : 'when this feed was last polled'}">${fmt(r.poll_age_min)} min</span>`;
      } },
    /* 129 markers with no clustering means the ones underneath cannot be
       clicked at all — a click on the fourth marker timed out because a
       different vehicle's path was on top of it. A row here is the reliable
       way in, so it carries the address the map cannot offer. */
    { label: 'On the map', key: '_m', render: (r) => (hasFix(r)
      ? `<a class="lnk" href="${href('vehicle', r.plate, 'movement')}" title="Where this vehicle went">route ↗</a>`
      : '<span class="ent-off" title="no usable fix, so nothing to show on a map">—</span>') },
  ], { sortable: true, sortId: 'live', defaultSort: { key: 'fix_age_min', dir: 'asc' },
    /* The breadcrumb used to be a modal titled after the plate. It is now the
       vehicle's own Movement tab, which has the map, the parked clusters and
       the replayable days the modal never had — and an address you can send.
       Bound through onRow so re-sorting cannot open the wrong vehicle. */
    onRow: (r) => { location.hash = href('vehicle', r.plate, 'movement'); } });
  /* The page an operator has open all day, and it opened on 130 rows. The
     question it is open FOR is which vehicles have stopped reporting. */
  {
    const stale = rows.filter((r) => r.stale).length;
    const noFix = rows.filter((r) => !hasFix(r)).length;
    const moving = rows.filter((r) => (+r.speed || 0) > 5).length;
    let claim, figure, unit, tone = null, recommend = null;
    if (stale) {
      tone = stale > rows.length / 4 ? 'bad' : 'warn';
      claim = `${countOf(stale, 'vehicle')} ${stale === 1 ? 'has' : 'have'} a stale fix`;
      figure = fmt(stale); unit = 'not reporting';
      recommend = 'Sort by Fix age to bring them together. A fix that is old while the poll is '
        + 'recent means the provider is still listing the vehicle and telling us nothing new '
        + 'about it — a different fault from our collector having stopped asking.';
    } else {
      claim = `${fmt(moving)} of ${fmt(rows.length)} vehicles are moving right now`;
      figure = fmt(moving); unit = 'moving';
    }
    verdict(vHost, {
      claim, figure, unit, tone, recommend,
      meta: `${fmt(rows.length)} reporting`,
      sub: `${feeds.map((f) => `${sourceLabel(f)} ${fmt(rows.filter((r) => r.source === f).length)}`).join(' · ')}`
        + `${noFix ? ` · ${fmt(noFix)} with no usable fix at all` : ''}. `
        + 'Only CABMAN polls every five minutes and only CABMAN carries a seat sensor.',
    });
  }
  foldRows(p.body, t, { shown: 12, total: rows.length, noun: 'vehicle', key: 'live' });
  p.body.append(el('p', 'cap',
    'Click a row for that vehicle’s movement page — the map, the replayable days and every stationary cluster.'));
};


V.map = async (root) => {
  const { makeMap, renderLive, renderJourney } = await import('/map.js');

  // ── controls ──
  const ctl = el('div', 'panel');
  ctl.innerHTML = `
    <div class="btnrow" style="justify-content:space-between">
      <div class="btnrow">
        <button class="btn primary" id="mLive">Live fleet</button>
        <button class="btn" id="mReplay">Day replay</button>
      </div>
      <div class="btnrow" id="mReplayCtl" style="display:none">
        <select id="mPlate" class="btn"></select>
        <input id="mDay" type="date" class="btn" />
        <button class="btn" id="mGo">Show route</button>
      </div>
    </div>`;
  root.append(ctl);

  const stat = el('div', 'kpis'); root.append(stat);
  const wrap = el('div', 'panel mapwrap');   // mapwrap opts out of the chart svg rule
  wrap.style.padding = '0'; wrap.style.overflow = 'hidden';
  const node = el('div'); node.style.height = '560px'; node.style.width = '100%';
  wrap.append(node); root.append(wrap);
  const legend = el('div', 'legend'); root.append(legend);

  const map = await makeMap(node);
  let layer = null;
  // Assigned once the day list exists, below; the live-map click handler is
  // defined before that and calls it through this binding.
  let refillDays = null;
  const clear = () => { if (layer) { map.removeLayer(layer); layer = null; } };

  /* The mode toggle is state, and it has to move with the map.
     Clicking a live marker drew one vehicle's replay while the toggle still
     read "Live fleet", #mReplayCtl stayed hidden and nothing on screen named
     the car or the day — the reader saw one route on a page claiming to show
     the fleet. Extracted so the marker callback and the button set the same
     thing. */
  const setMode = (mode) => {
    $('#mLive').classList.toggle('primary', mode === 'live');
    $('#mReplay').classList.toggle('primary', mode === 'replay');
    $('#mReplayCtl').style.display = mode === 'replay' ? 'flex' : 'none';
  };

  /* The address follows the map. Written with replaceState, so restoring the
     state does not re-render the view that just produced it. */
  const perma = el('p', 'cap'); root.append(perma);
  const showPerma = (mode, plate, day) => {
    const addr = mode === 'replay' && plate
      ? `#map/replay/${encodeURIComponent(plate)}${day ? `?day=${encodeURIComponent(day)}` : ''}`
      : '#map';
    const deeper = plate ? `<a class="lnk" href="${href('vehicle', plate, 'movement', day ? { day } : null)}">`
      + 'the same day with its parked clusters and segment table</a>' : '';
    perma.innerHTML = mode === 'replay' && plate
      ? `Showing <b>${esc(plate)}</b>${day ? ` on ${esc(dayStr(`${day}T12:00:00`))}` : ''}. `
        + `<a class="lnk" href="${esc(addr)}">A link to this replay</a> · ${deeper}.`
      : 'Showing every vehicle reporting a position now. Click a marker to replay that car’s day — '
        + 'the address follows, so the replay can be sent to somebody.';
    try { history.replaceState(null, '', addr); } catch { /* sandboxed frame */ }
  };

  const showLive = async () => {
    clear();
    let rows;
    /* One slow endpoint must not take the page. A 504 here replaced the whole
       of #map — map, controls, legend — with an error box, because this fetch
       had no catch and the throw reached render(). */
    try { rows = await api('/api/live'); } catch (e) {
      stat.innerHTML = '';
      stat.append(note(`The live feed could not be read: ${e.message}`, 'err'));
      const b = el('button', 'btn sec', 'Try again');
      b.onclick = () => showLive(); stat.append(b);
      return;
    }
    const withGps = rows.filter(hasFix);
    const noLock = rows.length - withGps.length;
    const sensed = withGps.filter((r) => r.seat_occupied != null);
    stat.innerHTML = [
      // Same test as #live, so the two pages stop disagreeing by three markers.
      ['On the map', fmt(withGps.length),
        `of ${fmt(rows.length)} reporting${noLock ? ` · ${fmt(noLock)} with no satellite lock` : ''}`],
      ['Engaged', sensed.length
        ? `${fmt(withGps.filter((r) => r.seat_occupied === true || /engag/i.test(r.status || '')).length)} of ${fmt(sensed.length)}`
        : fmt(withGps.filter((r) => /engag/i.test(r.status || '')).length),
        sensed.length ? 'of those whose feed reports a seat sensor' : 'no feed here reports a seat sensor'],
      ['Moving', fmt(withGps.filter((r) => +r.speed > 3).length), 'above 3 km/h'],
      ['Stale', fmt(withGps.filter((r) => r.stale).length), `no fix in ${FIX_FRESH_MIN} min`],
    ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');
    /* A fourth colour, because "Moving, empty" was asserted for the 82
       vehicles whose feed carries no seat sensor at all. renderJourney has been
       tri-state for a while; renderLive and this legend had not caught up. */
    legend.innerHTML = [['--s3', 'Passenger aboard'], ['--s1', 'Moving — seat sensor says empty'],
      ['--s5', 'Stopped'], ['--b300', 'Moving — no seat sensor on this feed'], ['--ink-3', 'Stale fix']]
      .map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${t}</span>`).join('');
    if (noLock) {
      legend.innerHTML += `<span class="dim">${countOf(noLock, 'tracker')} `
        + `${plural(noLock, 'is', 'are')} reporting 0,0 — no satellite lock — and ${
          plural(noLock, 'is', 'are')} not drawn.</span>`;
    }
    /* Set the plate BEFORE asking for the replay. `.click()` synchronously ran
       the replay handler, whose first statement reads the select — so it
       fetched whichever vehicle was previously chosen and drew that one's day
       under the plate you clicked. */
    layer = renderLive(map, withGps, (r) => {
      const sel = $('#mPlate');
      if (sel) {
        if (![...sel.options].some((o) => o.value === r.plate)) sel.append(new Option(r.plate, r.plate));
        sel.value = r.plate;
      }
      /* Refill the day list for the newly-chosen plate BEFORE replaying, or the
         replay reads a date that belongs to the previous vehicle — the same
         race the comment above already describes for the plate itself. */
      refillDays?.();
      // The page is now showing one vehicle's day. Say so.
      setMode('replay');
      showReplay(r.plate);
    });
    if (!withGps.length) {
      empty(stat, rows.length
        ? `${countOf(rows.length, 'vehicle')} reported in, and none of them with a usable position — `
          + 'every fix is missing coordinates or reporting 0,0.'
        : 'No GPS fixes stored yet — CABMAN populates this every 5 minutes');
    }
  };

  /* `plate` is passed explicitly rather than re-read from the DOM, so a caller
     that has just set it cannot race the read. */
  const showReplay = async (plateArg) => {
    const plate = plateArg || $('#mPlate').value, day = $('#mDayList')?.value;
    showPerma('replay', plate, day);
    if (!day) { clear(); return empty(stat, `No stored trail for ${plate || 'this vehicle'} — the replay list is built from days that have fixes.`); }
    if (!plate || !day) return;
    clear();
    let j;
    try { j = await api(`/api/map/journey?plate=${encodeURIComponent(plate)}&day=${day}`); }
    catch (e) {
      stat.innerHTML = '';
      stat.append(note(`That day's trail could not be read: ${e.message}`, 'err'));
      const b = el('button', 'btn sec', 'Try again');
      b.onclick = () => showReplay(plate); stat.append(b);
      return;
    }
    stat.innerHTML = [
      ['Fixes', fmt(j.fixes), `on ${day}`],
      ['Distance', fmt(j.distance_km) + ' km', 'between fixes'],
      /* Null, not zero, when this vehicle's feed never reports occupancy. FMS
         carries no seat sensor, so every FMS-tracked plate showed a hard
         "0 km · 0% of distance" — a positive claim that it drove empty all day,
         on days it ran fifteen bookings. */
      j.occupancy_reported
        ? ['With passenger', fmt(j.occupied_km) + ' km',
          j.occupancy_measured_km ? Math.round(j.occupied_km / j.occupancy_measured_km * 100) + '% of measured distance' : '—']
        : ['With passenger', 'not measured', 'this vehicle\'s feed carries no seat sensor'],
      /* The name is a link. This tile named the person who drove the route on
         screen and led nowhere, on the page most likely to raise a question
         about them. */
      ['Driver', j.driver ? entity('driver', j.driver_id, j.driver) : '—',
        j.driver_trips != null ? j.driver_trips + ' trips that day' : 'from the trip record'],
    ].map(([l, n, d]) => `<div class="kpi"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');
    legend.innerHTML = (j.occupancy_reported
      ? [['--s3', 'Passenger aboard'], ['--s1', 'Running empty (dashed)']]
      : [['--ink-3', 'Occupancy not reported by this feed']])
      .map(([c, t]) => `<span><i class="sw" style="background:var(${c})"></i>${t}</span>`).join('')
      + '<span class="dim">Lines join consecutive 5-minute fixes; a gap over 20 minutes breaks the line '
      + 'rather than guessing the route.</span>';
    if (!j.fixes) { empty(stat, `No GPS fixes stored for ${plate} on ${day}`); return; }
    layer = renderJourney(map, j);
  };

  /* Populate the replay pickers from days that actually have a trail.
     A free date input let you pick any day at all, most of which have no fixes,
     so the commonest outcome of using this control was an empty map and no
     explanation. The day list is now per-plate and names who held the car that
     day — which is only correct because /api/map/days stopped joining
     vehicle_current_driver, a view whose whole definition is "whoever has it
     NOW", and started joining custody on the day itself. */
  const days = await api('/api/map/days').catch(() => []);
  const byPlate = new Map();
  days.forEach((d) => {
    const k = d.plate; if (!byPlate.has(k)) byPlate.set(k, []);
    byPlate.get(k).push({ ...d, day: String(d.day).slice(0, 10) });
  });
  const plates = [...byPlate.keys()].sort();
  $('#mPlate').innerHTML = plates.map((p) => `<option>${esc(p)}</option>`).join('')
    || '<option value="">no trails yet</option>';

  const dayList = el('select', 'btn'); dayList.id = 'mDayList';
  const dayNote = el('span', 'cap'); dayNote.id = 'mDayNote';
  $('#mDay').replaceWith(dayList);
  dayList.after(dayNote);
  const fillDays = () => {
    const rows = byPlate.get($('#mPlate').value) || [];
    dayList.innerHTML = rows.map((r) => {
      const who = r.driver_name ? ` · ${r.driver_name}` : '';
      return `<option value="${esc(r.day)}">${esc(dayStr(r.day))} · ${r.fixes} fixes${esc(who)}</option>`;
    }).join('') || '<option value="">no stored days for this vehicle</option>';
    const cur = rows[0]?.current_driver_name;
    /* The API says whether its own list was cut — total/shown/truncated ride on
       every row — and this note ignored it. The picker reached exactly 400 rows
       in production, and the rows are grouped by plate here, so a vehicle whose
       days fell past the cap shows a SHORT menu or an empty one with nothing to
       distinguish that from a car that was never tracked. The day a reader is
       looking for is simply absent. */
    const cut = rows[0]?.truncated ? rows[0] : null;
    dayNote.textContent = rows.length
      ? `${countOf(rows.length, 'replayable day')}` + (cur ? ` · held today by ${cur}` : '')
        + (cut ? ` · the picker holds the ${fmt(cut.shown)} newest days across the fleet of `
          + `${fmt(cut.total)} — narrow the range to reach older ones` : '')
      : (cut
        ? `No day for this vehicle is in the picker. It holds the ${fmt(cut.shown)} newest days `
          + `across the whole fleet, of ${fmt(cut.total)} — narrow the range to reach this one.`
        : 'This vehicle has no stored trail.');
  };
  refillDays = fillDays;
  fillDays();
  $('#mPlate').addEventListener('change', fillDays);

  $('#mLive').onclick = () => { setMode('live'); showPerma('live'); showLive(); };
  $('#mReplay').onclick = () => { setMode('replay'); showReplay(); };
  $('#mGo').onclick = () => showReplay();
  $('#mPlate').addEventListener('change', () => showReplay());
  dayList.onchange = () => showReplay();

  /* Open on what the address asked for. `#map/replay/<plate>?day=…` is a real
     destination now — this view's state lived only in the DOM, so the one
     screen an operator would most want to send to a colleague could not be
     sent, on a product whose whole design is that every destination is a URL. */
  const askedPlate = state.param === 'replay' ? state.sub : null;
  if (askedPlate && byPlate.has(askedPlate)) {
    $('#mPlate').value = askedPlate;
    fillDays();
    const askedDay = parseHash().day;
    if (askedDay && (byPlate.get(askedPlate) || []).some((d) => d.day === askedDay)) dayList.value = askedDay;
    setMode('replay');
    await showReplay(askedPlate);
    return;
  }
  setMode('live');
  showPerma('live');
  await showLive();
};


/* The action list. Everything here is something a person could do today, ordered by
   what it costs to leave alone. Severity is a claim, so each row shows the evidence
   that produced it — a dashboard that asserts without showing its working gets
   ignored the first time it is wrong. */
V.insights = async (root) => {
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);

  const [sum, page] = await Promise.all([
    api('/api/insights/summary').catch(() => null),
    api('/api/insights').catch(() => ({ insights: [] })),
  ]);
  const all = page.insights || [];

  const bySev = Object.fromEntries((sum?.by_severity || []).map((r) => [r.severity, r.n]));
  /* A modelled figure and a measured one do not belong in one total. The old
     "Quantified cost" tile summed impact_aed across the whole table, and the
     only rule that sets it sets a constant — fourteen days at an assumed AED
     120 — so the headline was (number of runs) x (idle vehicles) x 1,680. It
     read AED 1,424,592. */
  const measured = Number(sum?.total?.measured_impact || 0);
  const modelled = sum?.modelled || {};
  /* The two severity tiles are the shortest route to "show me the critical
     ones", and the endpoint has always accepted `severity`. They were plain
     divs, so the only way to that list was to know the query string. */
  kh.innerHTML = [
    ['Open actions', fmt(sum?.total?.n ?? all.length),
      sum?.duplicates_suppressed ? `${fmt(sum.duplicates_suppressed)} duplicate rows suppressed` : 'across every source'],
    ['Critical', fmt(bySev.critical || 0), 'act today', bySev.critical ? 'err' : 'ok', '#insights/severity/critical'],
    ['Warnings', fmt(bySev.warning || 0), 'act this week', bySev.warning ? 'warn' : 'ok', '#insights/severity/warning'],
    ['Measured cost', measured ? 'AED ' + fmt(Math.round(measured)) : '—',
      'only findings that carry a real figure'],
    ['Idle capital, modelled', modelled.aed ? 'AED ' + fmt(Math.round(modelled.aed)) : '—',
      modelled.assumption || 'an assumption, not a measurement', 'warn'],
  ].map(([l, n, d, cls, link]) => (link
    ? `<a class="kpi clickable ${cls || ''}" href="${link}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></a>`
    : `<div class="kpi ${cls || ''}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`)).join('');

  if (!all.length) {
    const p0 = panel('Nothing to action', 'The engine runs after each collection'); root.append(p0.panel);
    empty(p0.body, 'No findings yet — either the fleet is clean, or the collectors have not completed a cycle.');
    return;
  }

  /* Category chips from the SUMMARY, not from the page. Built from the visible
     rows they offered exactly two buttons — "All (200)" and one category —
     because 200 duplicates of a single rule had consumed every slot, and the
     operator had no way to know the other categories existed. */
  const catCounts = Object.fromEntries((sum?.by_category || []).map((r) => [r.category, r.n]));
  const cats = Object.keys(catCounts).length
    ? Object.keys(catCounts).sort()
    : [...new Set(all.map((r) => r.category))].sort();
  /* The chips are ADDRESSES. They were buttons that mutated the panel and left
     the hash alone, so a filtered list — a 29-row safety list, say — could not
     be sent to the safety lead. `#insights/<category>` and
     `#insights/severity/<level>` are real destinations. */
  const kind = state.param === 'severity' ? 'severity' : (state.param ? 'category' : null);
  const value = kind === 'severity' ? state.sub : state.param;
  const bar = el('div', 'panel');
  bar.innerHTML = '<div class="btnrow">'
    + `<a class="btn${value ? '' : ' primary'}" href="${href('insights')}">All (${fmt(sum?.total?.n ?? all.length)})</a>`
    + cats.map((c) => `<a class="btn${kind === 'category' && value === c ? ' primary' : ''}" `
      + `href="${href('insights', c)}">${esc(c)} `
      + `(${fmt(catCounts[c] ?? all.filter((r) => r.category === c).length)})</a>`).join('')
    + ['critical', 'warning'].filter((s2) => bySev[s2]).map((s2) =>
      `<a class="btn${kind === 'severity' && value === s2 ? ' primary' : ''}" `
      + `href="${href('insights', 'severity', s2)}">${esc(s2)} (${fmt(bySev[s2])})</a>`).join('')
    + '</div>';
  root.append(bar);
  if (value) {
    const clr = el('p', 'cap');
    clr.innerHTML = `Filtered to <b>${esc(kind)} = ${esc(value)}</b> — this address carries the filter, `
      + `so it can be sent. <a class="lnk" href="${href('insights')}">Show everything</a>`;
    root.append(clr);
  }
  if (page.truncated) {
    root.append(note(`Showing the first ${fmt(page.limit)} of ${fmt(sum?.total?.n ?? '?')} findings, `
      + 'most severe first. Use a category above to narrow it rather than scrolling.'));
  }

  const listPanel = panel('Ranked actions', 'Most consequential first — click any row for the evidence behind it');
  root.append(listPanel.panel);

  const SEV = { critical: 'err', warning: 'warn', info: 'info', good: 'ok' };
  // A finding names an entity; the entity has a page. Every row leads there.
  const ENTITY_VIEW = { vehicle: 'vehicle', driver: 'driver', partner: 'property' };

  const draw = async () => {
    loading(listPanel.body);
    /* Refetched per facet rather than filtered client-side: the page holds
       at most 200 rows, so filtering them locally showed a category's first few
       findings and called it the category. */
    let rows = all;
    if (value) {
      const qs = kind === 'severity'
        ? `severity=${encodeURIComponent(value)}` : `category=${encodeURIComponent(value)}`;
      try { rows = (await api(`/api/insights?${qs}`)).insights || []; }
      catch { rows = all.filter((r) => (kind === 'severity' ? r.severity : r.category) === value); }
    }
    listPanel.body.innerHTML = '';
    if (!rows.length) {
      return empty(listPanel.body, value
        ? `No open finding with ${kind} “${value}”. That is a real answer — nothing is being hidden by `
          + 'a date range, because this list is over the current state of the fleet rather than a window.'
        : 'Nothing to action');
    }
    const list = el('div', 'hbars');
    rows.forEach((r) => {
      const view = ENTITY_VIEW[r.entity_type];
      const item = el('a', 'insight-row');
      // An address, so the evidence for one finding can be sent to somebody.
      item.href = href('action', r.code, r.entity_id || '-');
      const modelled = r.impact_kind === 'modelled' || r.code === 'idle_vehicle';
      item.innerHTML = `
        <div class="insight-sev"><span class="tag ${SEV[r.severity] || ''}">${esc(r.severity)}</span></div>
        <div class="insight-main">
          <div class="insight-title">${esc(r.title)}</div>
          <div class="insight-action">${esc(r.action || '')}</div>
        </div>
        <div class="insight-meta">
          ${view && r.entity_id ? `<span class="tag">${esc(r.entity_type)} ${esc(r.entity_id).slice(0, 14)}</span>` : `<span class="tag">${esc(r.category)}</span>`}
          ${r.fleet_id ? `<span class="tag dim">${esc(sourceLabel(r.fleet_id))}</span>` : ''}
          ${r.metric != null ? `<span class="dim num" title="the figure this rule fired on">${fmt(r.metric, 2)}</span>` : ''}
          ${r.impact_aed
    ? `<span class="num" style="color:var(${modelled ? '--warn' : '--critical'});font-weight:600" `
              + `title="${modelled ? 'a modelled figure, not a measurement' : 'measured'}">`
              + `AED ${fmt(Math.round(r.impact_aed))}${modelled ? ' *' : ''}</span>`
    : ''}
        </div>`;
      list.append(item);
    });
    listPanel.body.append(list);
    if (rows.some((r) => r.impact_kind === 'modelled' || r.code === 'idle_vehicle')) {
      listPanel.body.append(el('p', 'cap',
        '* a modelled figure — what it would cost if an assumption holds — never a measurement, and '
        + 'never added to the measured ones.'));
    }
  };
  draw();

  /* What the platform itself is asking for. These are Uber's own targets for
     the org — acceptance, cancellation, ratings — and they carry weight the
     fleet's internal rules do not: falling short of them affects allocation. */
  const rec = panel('What Uber is asking the fleet to fix',
    'Targets the platform sets for the org. Falling short affects trip allocation, so these are not advisory.');
  root.append(rec.panel); loading(rec.body);
  /* The endpoint returns {rows, shown, history} now — it used to return a bare
     array of the most recent thirty rows across all platforms, and the sentence
     below counted over that cap. Tolerant of both shapes so a stale cached
     bundle does not blank the panel. */
  const recRes = await api('/api/recommendations').catch(() => ({ rows: [] }));
  const recs = Array.isArray(recRes) ? recRes : (recRes.rows || []);
  rec.body.innerHTML = '';
  if (!recs.length) {
    rec.body.append(note('No platform recommendations collected. Uber publishes these per org; they appear once the fleet-portal collector has run against an account that can see them.'));
  } else {
    rec.body.append(tableFrom(recs, [
      { label: 'Platform', key: 'platform', render: (r) => sourceLabel(r.platform) },
      /* Two columns were both headed "Target": the name of the measure and the
         number to beat. And the name arrived as Uber's own enum, so the cell
         read RECOMMENDATION TYPE ORG ACCEPTANCE RATE — the protobuf constant
         with its underscores swapped for spaces, which is not English. */
      { label: 'Measure', key: 'rec_type', render: (r) => {
        const raw = String(r.rec_type || '');
        if (!raw) return '—';
        const t = raw.replace(/^RECOMMENDATION_TYPE_/, '').replace(/^ORG_/, '')
          .toLowerCase().replace(/_/g, ' ');
        return esc(t.charAt(0).toUpperCase() + t.slice(1));
      } },
      { label: 'Period', key: '_p', render: (r) => (r.period_start
        ? `${dayStr(r.period_start)} → ${dayStr(r.period_end)}` : 'current') },
      { label: 'Fleet is at', key: 'org_value', num: true, render: (r) => pctOf(r.org_value) },
      { label: 'Uber wants', key: 'target_value', num: true, render: (r) => pctOf(r.target_value) },
      /* `flagged` is a JSON ARRAY of the drivers Uber named. `r.flagged ? …`
         is therefore true for every row, including an empty array — so every
         target was marked "below target", including the ones being met. The
         comparison has to be between the two numbers. */
      { label: 'Meeting it', key: 'm', render: (r) => {
        const behind = missingTarget(r);
        return behind == null ? pill('no target published', '')
          : behind ? pill('below target', 'bad') : pill('on target', 'ok');
      } },
      { label: 'Drivers named', key: 'flagged_count', num: true,
        render: (r) => (r.flagged_count != null ? fmt(r.flagged_count) : '—') },
    ], { sortable: true, sortId: 'recs' }));
    const behind = recs.filter((r) => missingTarget(r) === true);
    // One row per platform and target type — the live one — so this count is
    // over the whole population rather than over a page of it.
    rec.body.append(el('p', 'cap', behind.length
      ? `${behind.length} of ${recs.length} current targets are not being met. Each names the drivers behind it — `
        + `open a driver's Quality page to see their own acceptance and cancellation figures.`
      : `All ${recs.length} current targets are being met.`));
  }
};

/* Compliance is the one place where the data is unambiguous: a date, and a vehicle
   that is either legal or not. Sorted by urgency, not by plate. */
V.compliance = async (root) => {
  const vHost = el('div'); root.append(vHost);
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);
  const [vehPage, drvPage] = await Promise.all([
    api('/api/compliance/vehicles').catch(() => ({ rows: [], totals: {} })),
    api('/api/compliance/drivers').catch(() => ({ drivers: [], totals: {} })),
  ]);
  const veh = vehPage.rows || [];
  const drv = drvPage.drivers || [];
  const dl = (r) => Number(r.days_left);
  /* Counted in the database, not by filtering the list on screen. Both lists
     are capped — 300 documents, 300 licences — and every tile on this page was
     a .filter().length over whichever rows arrived, under captions like
     "cannot legally work" and "stand down until renewed". They agree today
     because expired rows sort first; they stop agreeing the day the fleet
     crosses the cap, silently. */
  const vt = vehPage.totals || {};
  const vExpired = vt.expired ?? veh.filter((r) => dl(r) < 0).length;
  const vWeek = vt.within_7 ?? veh.filter((r) => dl(r) >= 0 && dl(r) <= 7).length;
  const vMonth = vt.within_45 ?? veh.filter((r) => dl(r) > 7 && dl(r) <= 45).length;
  /* A licence date shared by most of the roster is what this source writes when
     the field was never filled in. Counted as expiries it read "77 drivers must
     stand down" — while the insight engine, which runs the same check, was
     already refusing to accuse any of them. The two halves of the product
     disagreed about whether 77 people could legally drive. */
  const placeholder = drvPage.placeholder_date;
  const dt = drvPage.totals || {};
  const dExpired = dt.expired ?? drv.filter((r) => r.licence_expires
    && String(r.licence_expires).slice(0, 10) !== placeholder && dl(r) < 0).length;
  const dPlaceholder = drvPage.placeholder_rows || 0;
  const dNoDate = dt.no_date_at_all || 0;

  /* Compliance is the one page where the data is unambiguous — a date, and a
     vehicle either legal or not — and it opened on eight tiles with no ranking
     between them, above 235 rows. Expired outranks expiring outranks unknown:
     the first stops a car today, the second stops it this week, the third
     means nobody can say. */
  {
    const soon = vWeek + (dt.within_7 || 0);
    let claim, figure, unit, tone = null, recommend = null;
    if (vExpired || dExpired) {
      tone = 'bad';
      const bits = [vExpired ? `${countOf(vExpired, 'vehicle document')}` : '',
        dExpired ? `${countOf(dExpired, 'driver licence')}` : ''].filter(Boolean).join(' and ');
      claim = `${bits} ${vExpired + dExpired === 1 ? 'has' : 'have'} already expired`;
      figure = fmt(vExpired + dExpired); unit = 'expired';
      recommend = 'Those cars and those people cannot legally work today. Both tables below are '
        + 'sorted soonest-first, so they are the rows at the top.';
    } else if (soon) {
      tone = 'warn';
      claim = `${fmt(soon)} ${plural(soon, 'document')} ${soon === 1 ? 'expires' : 'expire'} within a week`;
      figure = fmt(soon); unit = 'due this week';
      recommend = 'Nothing has lapsed yet — this is the week to renew rather than the week after.';
    } else {
      claim = 'Nothing has expired and nothing expires this week';
      figure = fmt(vMonth + (dt.within_45 || 0)); unit = 'due in 45 days';
    }
    const blind = dPlaceholder + dNoDate;
    verdict(vHost, {
      claim, figure, unit, tone, recommend,
      sub: blind
        ? `${fmt(blind)} ${plural(blind, 'licence')} cannot be checked at all — `
          + `${fmt(dPlaceholder)} carry the source's default date and ${fmt(dNoDate)} carry no date. `
          + 'They are not counted as expired, because an absent date is not an expiry.'
        : 'Every licence and document on the books carries a real date.',
    });
  }

  kh.innerHTML = [
    ['Vehicle docs expired', fmt(vExpired), 'cannot legally work', vExpired ? 'err' : 'ok'],
    ['Expiring in 7 days', fmt(vWeek), 'renew now', vWeek ? 'err' : 'ok'],
    ['Expiring in 45 days', fmt(vMonth), 'start the paperwork', vMonth ? 'warn' : 'ok'],
    ['Driver licences expired', fmt(dExpired),
      placeholder ? 'excluding the placeholder date' : 'stand down until renewed', dExpired ? 'err' : 'ok'],
    /* Vehicles get three horizon tiles and drivers got one. A licence expiring
       in six weeks is a car that stops earning in six weeks, and the number
       was in `totals` and shown nowhere. */
    ...(dt.within_45 != null ? [['Licences expiring in 45 days', fmt(dt.within_45),
      'start the paperwork', dt.within_45 ? 'warn' : 'ok']] : []),
    ...(dPlaceholder ? [['Licence dates that are a default', fmt(dPlaceholder),
      'a data problem, not an expiry', 'warn']] : []),
    /* The people we hold no expiry date for at all. They were invisible: not
       expired, not expiring, not a placeholder — simply absent from every tile
       on a page whose subject is whether the roster can legally drive. */
    ...(dNoDate ? [['No licence date on file', fmt(dNoDate),
      'we cannot say whether these are valid', 'warn']] : []),
  ].map(([l, n, d, cls]) => `<div class="kpi ${cls}"><div class="l">${l}</div><div class="n num">${n}</div><div class="d">${esc(d)}</div></div>`).join('');

  if (drvPage.caveat) root.append(note(drvPage.caveat));

  // The data holds registration only; naming three document types implied a
  // completeness this page does not have.
  // From the whole table, not from the rows on screen — the same reason the
  // tiles above stopped counting the array they had just been handed.
  const docTypes = (vehPage.doc_types || []).map((d) => d.doc_type).filter(Boolean);
  const vp = panel('Vehicle documents', docTypes.length
    ? `${docTypes.join(', ')} — the document types this source actually publishes`
    : 'documents with an expiry date');
  root.append(vp.panel);
  if (!veh.length) empty(vp.body, 'No vehicle documents collected yet');
  else foldRows(vp.body, tableFrom(veh.slice(0, 120), [
    { label: 'Due', key: 'days_left', num: true, render: (r) => {
      const d = dl(r);
      const cls = d < 0 ? 'err' : d <= 7 ? 'err' : d <= 45 ? 'warn' : 'ok';
      return `<span class="tag ${cls}">${d < 0 ? Math.abs(d) + 'd ago' : d + 'd'}</span>`; } },
    { label: 'Plate', key: 'plate', render: (r) => entity('vehicle', r.plate, r.plate) },
    // A description, not an identity — the plate beside it is the link.
    { label: 'Make & model', key: 'make', render: (r) => esc([r.make, r.model, r.year].filter(Boolean).join(' ') || '—') },
    { label: 'Document', key: 'doc_type' },
    { label: 'Status', key: 'status',
      render: (r) => (r.status
        ? pill(r.status, /active|valid/i.test(r.status) ? 'ok' : 'warn')
        : '<span class="ent-off" title="this source publishes no status for the document">—</span>') },
    { label: 'Expires', key: 'expires_at', render: (r) => dateStr(r.expires_at) },
    { label: 'VIN', key: 'vin',
      render: (r) => (r.vin ? `<span class="plate">${esc(r.vin)}</span>`
        : '<span class="ent-off" title="no VIN on this vehicle’s record">—</span>') },
    /* "Held by", in the present tense, over a custody record that can be nine
       months old — 33 of 97 rows named somebody who last held the car before
       June. `custodyAsOf` was written for exactly this, with a comment saying
       that hiding the date invites somebody to ring the wrong person. */
    { label: 'Last held by', key: 'driver_name', render: (r) => {
      const html = custodyAsOf({ name: r.driver_name, id: r.driver_ext_id, day: r.driver_as_of });
      const ageD = r.driver_as_of ? Math.floor((Date.now() - Date.parse(r.driver_as_of)) / 864e5) : null;
      return html + (ageD != null && ageD > 14
        ? ` <span class="tag warn" title="the custody record is ${fmt(ageD)} days old — confirm before ringing">stale</span>`
        : '');
    } },
  ], { sortable: true, sortId: 'vdocs', defaultSort: { key: 'days_left', dir: 'asc' } }),
    { shown: 12, total: Math.min(120, veh.length), noun: 'document', key: 'compl-veh' });
  if (veh.length) vp.body.append(el('p', 'cap',
    `Showing ${fmt(Math.min(120, veh.length))} of ${fmt(vt.total ?? veh.length)} documents with an expiry date`
    + `${vt.vehicles ? ` across ${fmt(vt.vehicles)} vehicles` : ''}, soonest first. `
    + 'The counts above are over all of them, not over this list. "Last held by" is the most recent '
    + 'custody record we hold, which is not necessarily today — the date beside the name says which.'));

  const dp = panel('Driver licences', placeholder
    ? `From the platforms that publish an expiry date. Rows carrying ${placeholder} are the source's `
      + 'default and are marked as such rather than counted as expired.'
    : 'from the platforms that publish an expiry date');
  root.append(dp.panel);
  if (!drv.length) empty(dp.body, 'No driver licence dates collected yet — Hotel publishes these, Uber does not expose them to this role');
  else foldRows(dp.body, tableFrom(drv.slice(0, 120), [
    { label: 'Due', key: 'days_left', num: true,
      /* Placeholder dates sort to the BOTTOM whichever way you order. They are
         not an expiry, so ranking them among real ones puts 77 rows that mean
         "this field was never filled in" above every licence that genuinely
         runs out next week. */
      sortValue: (r) => {
        if (!r.licence_expires) return null;
        if (placeholder && String(r.licence_expires).slice(0, 10) === placeholder) return null;
        return dl(r);
      },
      render: (r) => {
        if (!r.licence_expires) return '<span class="ent-off" title="no expiry date published for this licence">—</span>';
        if (placeholder && String(r.licence_expires).slice(0, 10) === placeholder) {
          return '<span class="tag dim" title="the source’s own default date, written when the field was never filled in — not an expiry">not filled in</span>';
        }
        return `<span class="tag ${dl(r) < 0 ? 'err' : dl(r) <= 45 ? 'warn' : 'ok'}">${dl(r) < 0 ? Math.abs(dl(r)) + 'd ago' : dl(r) + 'd'}</span>`;
      } },
    { label: 'Driver', key: 'full_name',
      render: (r) => entity('driver', r.driver_ext_id, r.full_name) },
    /* The vehicle. api/server.js selects it with a comment saying a licence
       expiring in six days is a CAR that stops earning in six days, and this
       table never drew the column it was selected for. */
    { label: 'Vehicle', key: 'vehicle',
      // {plate, day} — the plate they held and the day we last saw them hold it.
      sortValue: (r) => r.vehicle?.plate || null,
      render: (r) => (r.vehicle?.plate
        ? entity('vehicle', r.vehicle.plate, r.vehicle.plate)
          + (r.vehicle.day ? `<span class="dim" title="last custody record"> ${esc(dayStr(`${String(r.vehicle.day).slice(0, 10)}T12:00:00`))}</span>` : '')
        : '<span class="ent-off" title="no custody record attaches a vehicle to this driver">none attached</span>') },
    { label: 'Phone', key: 'phone',
      render: (r) => (r.phone ? `<span class="plate">${esc(r.phone)}</span>`
        : '<span class="ent-off" title="this platform publishes no phone number">—</span>') },
    { label: 'Platform', key: 'platform', render: (r) => esc(sourceLabel(r.platform)) },
    { label: 'Licence', key: 'licence_no', render: (r) => `<span class="plate">${esc(r.licence_no || '—')}</span>` },
    { label: 'Expires', key: 'licence_expires', render: (r) => {
      const d = String(r.licence_expires || '').slice(0, 10);
      if (!d) return '<span class="ent-off" title="this platform publishes no expiry date for the licence">—</span>';
      return d === placeholder ? `${esc(d)} ${pill('a default, not a date', 'warn')}` : esc(dateStr(r.licence_expires));
    } },
    { label: 'State', key: 'state', render: (r) => `<span class="tag ${/suspend|deact/i.test(r.state || '') ? 'warn' : 'ok'}">${esc(r.state || '—')}</span>`
      + (r.suspension_reason ? `<div class="dim">${esc(String(r.suspension_reason).slice(0, 90))}</div>` : '') },
  ], { sortable: true, sortId: 'licences', defaultSort: { key: 'days_left', dir: 'asc' } }),
    { shown: 12, total: Math.min(120, drv.length), noun: 'licence', key: 'compl-drv' });
  if (drv.length) dp.body.append(el('p', 'cap',
    `Showing ${fmt(Math.min(120, drv.length))} of ${fmt(dt.total ?? drv.length)} driver records, `
    + `${fmt(dt.with_date ?? 0)} of which carry an expiry date at all`
    + (dPlaceholder ? `, and ${fmt(dPlaceholder)} of THOSE carry the source's default date rather than a real one` : '')
    + '. The counts above are over all of them, not over this list. Every column here can be sorted.'));
};

V.sources = async (root) => {
  /* Guarded like every other long view. This one was not, and it is the
     longest: five panels, six fetches and a nested draw. An abandoned render
     goes on writing into panels the reader has already left — which is how the
     browser smoke, navigating a hundred routes in one context, caught #sources
     showing "Loading…" twenty seconds after it had been asked for, while the
     same page opened on its own resolves in under a second every time.
     See the comment on currentGen() in data.js for the whole hazard. */
  const gen = currentGen();
  const st = panel('Collector health',
    'Last run per source. "partial" means the run wrote rows AND left windows unfetched — which is how '
    + 'a 299-day hole in the Uber trip history survived for months behind a run that said ok.');
  root.append(st.panel);
  const cv = panel('Data coverage',
    'What has actually landed — and, for each dated source, how many days of the window it covered. '
    + 'A row count between two dates says nothing about the days in between.');
  root.append(cv.panel);
  /* The background work, made visible. Four pages read precomputed aggregates
     instead of grouping the whole trip history on every request — which is only
     an acceptable trade while the rollups are actually running. A stale number
     served instantly is worse than a slow one, because nothing about it looks
     wrong, so the age of each is on the page. */
  const ru = panel('Precomputed aggregates',
    'Trend, Forecast and Retention read these rather than aggregating every trip on each load. '
    + 'Rebuilt after every collection and every fifteen minutes.');
  root.append(ru.panel);
  /* The coverage panel says how long it expects to be a skeleton.
     /api/coverage groups the entire trip history with no window at all — its
     own warmer comment calls it a twenty-second query and names it as the
     cause of a 504 on this page — and eleven seconds of an anonymous grey bar
     is indistinguishable from a panel that will never fill. */
  [st.body, ru.body].forEach((h) => loading(h));
  loading(cv.body, 'Reading the whole record — every trip, every alert, every fix, with no date '
    + 'window at all. This is the slowest question the product asks and takes about ten seconds.');
  // This page hides the global range filter, so the coverage question is asked
  // over the full observed history rather than over an invisible window.
  // The Dubai day, not the UTC one — see api/public/tz.js.
  const [from, to] = ['2000-01-01', dubaiDay()];
  const [status, coverage, rollups, cacheStats] = await Promise.all([
    api('/api/status'), api('/api/coverage'), api('/api/rollups').catch(() => []),
    api('/api/cache-stats').catch(() => null)]);
  if (!alive(gen)) return;

  ru.body.innerHTML = '';
  if (!rollups.length) {
    ru.body.append(note('No rollup has run yet. The pages that read them fall back to computing '
      + 'the same aggregate live — correct, but slow, until the next rebuild.'));
  } else {
    ru.body.append(tableFrom(rollups, [
      { label: 'Rollup', key: 'name' },
      { label: 'Status', key: 'status',
        render: (r) => `<span class="tag ${r.status === 'ok' ? 'ok' : 'bad'}">${esc(r.status || '—')}</span>` },
      /* Age, not a timestamp. "18 minutes ago" answers the question a reader
         actually has; a timestamp makes them do the subtraction. */
      { label: 'Age', key: 'age_min', num: true,
        render: (r) => (r.age_min == null ? '—'
          : r.age_min < 60 ? `${fmt(r.age_min)} min ago`
            : `${fmt(Math.round(r.age_min / 60))} h ago`) },
      { label: 'Rows', key: 'rows_written', num: true },
      { label: 'Took', key: 'duration_ms', num: true,
        render: (r) => (r.duration_ms == null ? '—' : `${fmt(Math.round(r.duration_ms / 100) / 10, 1)}s`) },
      /* With the year. The rollup that covers 369 days printed
         "Aug 21 → Aug 25", two dates a year apart rendered identically, on the
         row whose whole job is to say how far back it reaches. */
      { label: 'Covers', key: 'covers_from',
        render: (r) => (r.covers_from
          ? `${dateStr(r.covers_from)} → ${dateStr(r.covers_to)}`
            + (r.covers_days != null ? `<span class="dim"> · ${fmt(r.covers_days)}d</span>` : '')
          : '—') },
    ], { compact: true, sortable: true, sortId: 'rollups' }));
    /* Read responses are also cached against the same data version, so a page
       opened twice runs its aggregates once. Shown here because a cache nobody
       can see the hit rate of is one nobody can tell has stopped working — the
       symptom being pages that are merely slow again, which reads as the
       database having a bad day. */
    if (cacheStats) {
      const served = cacheStats.hit + (cacheStats.stale || 0);
      const total = served + cacheStats.miss;
      /* `skip` is outside the denominator, so "346 of 1,412 (25%)" was a share
         of the requests that were ELIGIBLE, printed as a share of the requests.
         245 more were never eligible at all — a realtime feed is never cached —
         and leaving them out of both halves made the cache look worse than it
         is while hiding a fifth of the traffic. */
      const skip = cacheStats.skip || 0;
      ru.body.append(el('p', 'cap',
        `Response cache: ${fmt(served)} of ${fmt(total)} cacheable requests answered without re-running `
        + `the query${total ? ` (${Math.round((served / total) * 100)}%)` : ''}`
        + (skip ? `; ${fmt(skip)} more were never eligible — a realtime feed must not be served from a cache` : '')
        + '. '
        + (cacheStats.version
          ? `Keyed to ${esc(String(cacheStats.version))}, so a new collection invalidates everything at `
            + 'once rather than on a timer. ' : '')
        + `${fmt(cacheStats.entries)} entries`
        + `${cacheStats.bytes != null ? ` (${fmt(Math.round(cacheStats.bytes / 1048576))} of `
          + `${fmt(Math.round(cacheStats.bytes_cap / 1048576))} MB)` : ''} held. `
        + `${fmt(cacheStats.stale || 0)} were served from the previous collection while the `
        + 'new one was computed behind the reader — so a page never waits for a refresh, and is '
        + 'at most one collection cycle behind. Nothing is cached on a timer.'));
    }
    const stale = rollups.filter((r) => r.age_min != null && r.age_min > 45);
    const broken = rollups.filter((r) => r.status !== 'ok');
    if (broken.length) {
      ru.body.append(note(`${broken.map((r) => r.name).join(', ')} failed: `
        + `${esc(broken[0].error || 'no reason recorded')}. Those pages are computing live instead.`, 'err'));
    } else if (stale.length) {
      ru.body.append(note(`${stale.map((r) => r.name).join(', ')} has not rebuilt in over 45 minutes, `
        + 'which is longer than the fifteen-minute schedule allows. The collector may not be running.', 'warn'));
    }
  }
  st.body.innerHTML = '';
  const TAG = { ok: 'ok', partial: 'warn', error: 'bad' };
  st.body.append(tableFrom(status, [
    { label: 'Source', key: 'source', render: (r) => esc(sourceLabel(r.source)) },
    /* The two fleets are separate businesses with separate credentials on the
       same providers, and each writes its own run. Without this column two
       rows read as a duplicate of one source rather than as one fleet
       collecting and the other not. */
    { label: 'Fleet', key: 'fleet_id',
      absent: 'these runs predate per-fleet collection and cover the whole account',
      render: (r) => (r.fleet_id ? sourceLabel(r.fleet_id) : '—') },
    { label: 'Mode', key: 'mode' },
    { label: 'Status', key: 'status', render: (r) => `<span class="tag ${TAG[r.status] || 'bad'}">${esc(r.status || '—')}</span>` },
    // With separators, on a screen where the table below it has them.
    { label: 'Rows', key: 'rows_written', num: true, render: (r) => fmt(r.rows_written) },
    { label: 'Windows', key: 'chunks_total', num: true, render: (r) => (r.chunks_total == null ? '—'
      : `${fmt(r.chunks_total - (r.chunks_failed || 0))} of ${fmt(r.chunks_total)}`) },
    { label: 'Last run', key: 'finished_at', render: (r) => (r.finished_at ? dtStr(r.finished_at) : '—') },
    /* The whole error, on hover. Truncated at 90 characters, a two-part
       failure — "COMPANIES_NOT_ALLOWED: the company is not…" — lost the half
       that says what to do about it, on the one page whose subject is why a
       collector is failing. */
    { label: 'Detail', key: 'error', render: (r) => (r.error
      ? `<span class="note err" title="${esc(String(r.error))}">${esc(String(r.error).slice(0, 90))}${
        String(r.error).length > 90 ? '…' : ''}</span>`
      : r.chunks_failed
        ? `<span class="note warn">${countOf(r.chunks_failed, 'window')} did not land — see below</span>`
        : '<span class="note ok">healthy</span>') },
  ], { sortable: true, sortId: 'status' }));
  /* The dates of the windows that failed. Without them a gap is visible but not
     fixable — you can see the hole and not know what to re-fetch. */
  const holes = status.flatMap((r) => (r.failed_windows || [])
    .map((w) => ({ source: r.source, mode: r.mode, ...w })));
  if (holes.length) {
    const hp = panel('Windows that did not land',
      'Each of these is a range with no data behind it. Every rate computed across one is wrong.');
    hp.body.append(tableFrom(holes, [
      { label: 'Source', key: 'source', render: (r) => sourceLabel(r.source) },
      { label: 'Mode', key: 'mode' },
      { label: 'From', key: 'from', render: (r) => dateStr(r.from) },
      { label: 'To', key: 'to', render: (r) => dateStr(r.to) },
      { label: 'What came back', key: 'error',
        render: (h) => `<span class="wrap" title="${esc(String(h.error))}">${esc(String(h.error).slice(0, 140))}${
          String(h.error).length > 140 ? '…' : ''}</span>` },
    ], { sortable: true, sortId: 'holes' }));
    const fix = el('div', 'note');
    fix.innerHTML = 'Re-run a backfill from <a class="lnk" href="' + href('settings') + '">Settings</a> to '
      + 'attempt these again. If the same window keeps failing, the reason in this table is the thing to '
      + 'fix — usually a credential, or a range past the provider’s retention.';
    hp.body.append(fix);
    root.append(hp.panel);
  }
  cv.body.innerHTML = '';
  /* "Rows / From / Latest" reads as an unbroken span. Every hole between those
     two dates — the exact failure mode the rest of this codebase is written
     around — was invisible: a source that collected 56 days of a year was
     presented as having covered it. The calendar endpoint that answers this
     correctly already existed and was not called from here. */
  const cal = await api(`/api/coverage/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    .catch(() => ({ sources: [] }));
  if (!alive(gen)) return;
  const byCal = Object.fromEntries((cal.sources || []).map((s2) => [s2.source, s2]));
  const cov = [
    ...(coverage.trips || []).map((r) => ({ what: `trips · ${sourceLabel(r.platform)}`, src: r.platform,
      n: r.n, from: r.from_ts, to: r.to_ts })),
    /* The EARNINGS dataset, on a product where money exists only in the payout
       tables. /api/coverage returns it — uber 42,841 rows worth AED 2,096,301,
       yango 568 worth AED 11,750 — and this table, which inventories what has
       landed, left it out entirely. */
    /* from_day/to_day are what this query actually returns — it reads
       driver_payout_day, whose column is `day`. Reading from_ts/first_period
       left both of these rows with no dates at all, on the two rows about the
       money. */
    ...(coverage.earnings || []).map((r) => ({ what: `earnings · ${sourceLabel(r.platform || r.source)}`,
      key: `earnings:${r.platform || r.source}`, src: null, n: r.n,
      from: r.from_day || r.from_ts || r.first_period,
      to: r.to_day || r.to_ts || r.last_period,
      value: r.earnings ?? r.amount ?? r.total ?? null })),
    /* from_ts on all three now. The endpoint selected only a LAST timestamp
       for these, so seven of the eleven rows on a table headed "what has
       actually landed" had no start date at all — including the telemetry
       feed, which is the longest record the product holds. */
    /* `key` is the machine name the calendar is keyed on; `what` is what the
       reader sees. They were the same string once and it matched two rows of
       nine — sourceLabel() renders 'cabman' as 'CABMAN', so every telemetry
       row failed to join and kept reporting itself as undated. */
    /* `collected_from` — min(polled_at), when WE started asking — not the
       oldest fix we hold. A dormant tracker's last fix is from April 2024 on
       this fleet, so `from_ts` printed 2024 in the From column beside "6 of 6
       days collected" in the next one: two clocks under one heading, saying
       different things about the same feed. */
    ...(coverage.telemetry || []).map((r) => ({ what: `telemetry · ${sourceLabel(r.source)}`,
      key: `telemetry:${r.source}`, src: null, n: r.n,
      from: r.collected_from || r.from_ts, to: r.last_poll })),
    ...(coverage.alerts || []).map((r) => ({ what: 'safety alerts', key: 'alerts',
      src: null, n: r.n, from: r.from_ts, to: r.latest })),
    ...(coverage.ledger || []).map((r) => ({ what: 'ledger entries', key: 'ledger',
      src: null, n: r.n, from: r.from_ts, to: r.latest })),
    /* Trips are keyed by platform in source_day_coverage; everything else has
       its continuity computed by /api/coverage under the label this table
       already prints, so the join is on what the reader sees. Nine of the
       eleven rows here used to say "not a dated source" about feeds that are
       dated — including telemetry, the longest record the product holds. */
  ].map((r) => ({ ...r, cal: (r.src ? byCal[r.src] : null)
    || (coverage.dataset_calendar || {})[r.key] || null }));
  const anyValue = cov.some((r) => r.value != null);
  cv.body.append(tableFrom(cov, [
    { label: 'Dataset', key: 'what' },
    { label: 'Rows', key: 'n', num: true, render: (r) => fmt(r.n) },
    ...(anyValue ? [{ label: 'Value', key: 'value', num: true,
      render: (r) => (r.value == null
        ? '<span class="ent-off" title="this dataset carries no money">—</span>'
        : money(r.value)) }] : []),
    { label: 'From', key: 'from', render: (r) => dateStr(r.from) },
    { label: 'Latest', key: 'to', render: (r) => (r.to ? dtStr(r.to) : '—') },
    { label: 'Days collected', key: '_d', render: (r) => (r.cal
      ? `${fmt(r.cal.days_with_data)} of ${fmt(r.cal.days_with_data + r.cal.missing_days)}`
      : '<span class="ent-off" title="this dataset has no per-day calendar behind it">not a dated source</span>') },
    /* The link carries the range and the anchor. It was a bare `#coverage`,
       which opens on the default thirty days — a page that then reports
       "MISSING DAYS 1" and denies the 152-day gap the link was named after. */
    /* An event-driven dataset has no missing days. Safety alerts happen when
       something happens and the ledger arrives when somebody imports one —
       neither promises a row every day, so counting the quiet ones as gaps
       describes a calm fortnight as a collection failure. */
    { label: 'Missing', key: '_m', render: (r) => (!r.cal ? '—'
      : r.cal.event_driven
        ? '<span class="ent-off" title="this dataset records events, not a daily feed — a day with nothing on it is a quiet day, not a gap">not a daily feed</span>'
        : r.cal.missing_days
        /* The anchor rides in the QUERY, not as a second '#'.
           ─────────────────────────────────────────────────────────────────
           This built `#coverage?days=365#src-fms`, and parseHash splits the
           hash on its first '?' and hands the rest to URLSearchParams — so
           `days` came out as the string "365#src-fms", failed the
           [7,30,90,180,365] check, and fell back to the default. The link
           promised the whole record and delivered thirty days, silently, on
           the page whose subject is what is missing from the record. One hash,
           one query, and `days` parses. */
        ? `<a class="lnk" href="${href('coverage', null, null, { days: 365, at: `src-${r.src}` })}">`
          + `${countOf(r.cal.missing_days, 'day')}</a>`
        : pill('none', 'ok')) },
    { label: 'Largest gap', key: '_g', render: (r) => {
      if (r.cal?.event_driven) {
        return '<span class="ent-off" title="this dataset records events, not a daily feed">—</span>';
      }
      const g = r.cal && r.cal.gaps && r.cal.gaps[0];
      return g ? `${dateStr(g.from)} → ${dateStr(g.to)} <small class="dim">${g.days}d</small>`
        : (r.cal ? '<span class="ent-off">none</span>' : '—');
    } },
  ], { sortable: true, sortId: 'covrows' }));
  const holed = cov.filter((r) => r.cal && r.cal.missing_days);
  if (holed.length) {
    const h = el('div', 'note');
    h.innerHTML = holed.map((r) => `${esc(sourceLabel(r.src))} is missing `
      + `${countOf(r.cal.missing_days, 'day')}`).join(', ')
      + '. A row count between two dates says nothing about what is in between — '
      + `<a class="lnk" href="${href('coverage', null, null, { days: 365 })}">Collection gaps</a> draws it `
      + 'over the whole record.';
    cv.body.append(h);
  }

  /* What each provider actually sends, versus what we keep. Every collector
     stores the original record in `raw`; this reads it back, so "does Uber
     segregate business trips?" is answerable from the dashboard instead of by
     hand-querying the database. It is the difference between knowing what a
     source gives us and guessing from the columns we happened to map. */
  const rawP = panel('What each source actually sends',
    'Fields present in the provider\'s original record, how often they are filled, and whether we already keep them as a column. A field with few distinct values is a dimension worth charting; a wide one is an identifier or free text.');
  root.append(rawP.panel);
  /* This panel OWNS its window.
     ───────────────────────────────────────────────────────────────────────
     It used q(), which injects the global range — and this page hides the
     range control, so the caption "over the selected date range" pointed at a
     select nobody could see. Arriving here from a 365-day page asked for a
     year of raw records and arriving from the default asked for thirty days:
     a 21x change of scope with no control and no statement of which one you
     got. The dates it actually used are printed underneath. */
  const rawBar = el('div', 'toolbar');
  rawBar.innerHTML = `<select id="rawSrc" class="btn">
      <option value="uber">Uber trips</option><option value="fms">FMS trips</option>
      <option value="hotel">Hotel trips</option><option value="yango">Yango trips</option>
      <option value="bolt">Bolt trips</option><option value="">All platforms</option>
    </select>
    <label class="cap" for="rawWin">over</label>
    <select id="rawWin" class="btn">
      <option value="30">the last 30 days</option>
      <option value="90">the last 90 days</option>
      <option value="365" selected>the last 12 months</option>
      <option value="0">the whole record</option>
    </select>`;
  rawP.body.append(rawBar);
  const rawHost = el('div'); rawP.body.append(rawHost);
  const drawRaw = async (platform, days) => {
    loading(rawHost);
    /* The field inventory over twelve months is the heaviest read on this
       page. Said out loud after a second, so a slow answer looks like a slow
       answer rather than a broken panel. Cleared by every path below. */
    /* This is where the pattern started — a hand-rolled deferred message that
       swapped the skeleton's innerHTML after 1.2s. It set `.skel` without
       `.says`, so the sentence went into a 13px shimmer bar and no reader has
       ever seen it. loading(host, message) does the same thing with the
       styling, and every slow panel now behaves identically. */
    loading(rawHost, 'Reading the field inventory — this one is a scan over every stored record '
      + 'in the window, so it is the slowest panel here.');
    const to = dubaiDay();
    const from = +days ? dubaiDay(new Date(Date.now() - (+days - 1) * 864e5)) : '2000-01-01';
    try {
      const qs = new URLSearchParams({ from, to, ...(platform ? { platform } : {}) });
      const d = await api(`/api/schema/raw-fields?${qs}`);
      if (!alive(gen)) return;
      rawHost.innerHTML = '';
      if (!d.fields?.length) {
        rawHost.append(note(`No stored record from ${sourceLabel(platform) || 'any platform'} between `
          + `${dateStr(from)} and ${dateStr(to)}. That is a statement about this window, not about the `
          + 'source — widen it, or check Collector health above.'));
        return;
      }
      rawHost.append(tableFrom(d.fields, [
        { label: 'Field', key: 'key' },
        { label: 'Filled', key: 'fill_pct', num: true, render: (r) => pct(r.fill_pct) },
        { label: 'Distinct values', key: 'distinct_values', num: true, render: (r) => fmt(r.distinct_values) },
        { label: 'Kept as a column', key: 'already_a_column', render: (r) => (r.already_a_column
          ? pill('yes', 'ok') : pill('raw only', 'warn')) },
        { label: 'Examples', key: '_e', render: (r) => esc((r.examples || []).slice(0, 3).join(' · ')) },
      ], { sortable: true, sortId: 'rawf' }));
      const unkept = d.fields.filter((f) => !f.already_a_column).length;
      rawHost.append(el('p', 'cap',
        `${fmt(d.rows_with_raw)} stored records between ${dateStr(from)} and ${dateStr(to)}, `
        + `${fmt(d.sampled)} sampled. ${fmt(unkept)} of ${fmt(d.fields.length)} fields are marked "raw `
        + 'only": they arrive from the provider and are not promoted to a column. Matching is by '
        + 'normalised name, so a field the collector stores under a different name — "Trip request '
        + 'time" against `requested_at` — can be listed here and already be kept.'));
    } catch (e) {
      if (!alive(gen)) return;
      rawHost.innerHTML = '';
      rawHost.append(note(`Could not read the field inventory: ${e.message}`));
    }
  };
  const rawWin = () => rawBar.querySelector('#rawWin').value;
  await drawRaw('uber', rawWin());
  rawBar.querySelector('#rawSrc').onchange = (e) => drawRaw(e.target.value, rawWin());
  rawBar.querySelector('#rawWin').onchange = () => drawRaw(rawBar.querySelector('#rawSrc').value, rawWin());
};

V.settings = async (root) => {
  const auth = panel('Admin access', 'Changes require the admin token configured on the server'); root.append(auth.panel);
  const tokRow = el('div', 'btnrow');
  tokRow.innerHTML = `<input id="admTok" type="password" placeholder="admin token" style="flex:1;min-width:220px;background:var(--paper);border:1px solid var(--rule-strong);border-radius:3px;padding:8px 10px;font-family:'IBM Plex Mono';font-size:.8rem" value="${esc(state.admin)}">
    <button class="btn sec" id="saveTok">Remember</button><span class="note" id="tokNote"></span>`;
  auth.body.append(tokRow);
  tokRow.querySelector('#saveTok').onclick = () => {
    state.admin = tokRow.querySelector('#admTok').value.trim();
    store.set('adminToken', state.admin);
    tokRow.querySelector('#tokNote').className = 'note ok';
    tokRow.querySelector('#tokNote').textContent = 'saved in this browser';
  };

  const credP = panel('Credentials', 'Stored encrypted in the database. Leave blank to keep the current value; the collector picks changes up within 30 seconds.');
  root.append(credP.panel); loading(credP.body);
  /* Credentials that expire on a schedule nobody watches fail silently — the
     source writes zero rows while the page still shows a healthy "settings"
     tag. Where the stored value is a JWT it says when it dies, so show that
     rather than making the supervisor infer it from a flat chart. */
  /* Where a credential actually lives.
     The API and the collector are separate components with separate
     environments: UBER_WEB_COOKIE and YANGO_COOKIE are set on the collector
     worker and nowhere else, which is right, because only the collector calls
     those providers. This page is served by the API, and it showed both as
     "unset" — so an operator would go and capture a new Uber session while the
     collector had a working one. A credential held by the process that uses it
     is not missing. */
  const sourceTag = (d) => {
    /* `configured` now means "some component holds this", which is the honest
       thing for an API field to mean — the row used to say configured:false
       directly above a seen_by naming the collector that held it. But the
       useful sentence on THIS page is which component, so 'elsewhere' falls
       through to the branch below that names it rather than rendering the word
       "elsewhere" in a dim tag, which says less than what was here before. */
    if (d.configured && d.source !== 'elsewhere') {
      return `<span class="tag ${d.source === 'settings' ? 'ok' : 'dim'}">${esc(d.source)}</span>`;
    }
    const others = d.seen_by || [];
    if (others.length) {
      const where = others.map((o) => o.component).join(', ');
      return `<span class="tag ok" title="Not in this service's environment, but held by ${esc(where)} — `
        + `which is the process that uses it.">on ${esc(where)}</span>`;
    }
    return '<span class="tag warn">unset</span>';
  };
  /* Three tiers, not two.
     `days_left <= 2 ? 'warn' : 'dim'` put a credential with 2.2 days left —
     fifty-three hours — in the DIMMEST tone on the page, quieter than the
     healthy ones, because 2.2 is not <= 2. A credential dying this week is the
     thing this page exists to catch. */
  const expiryTag = (d) => {
    const e = d.expiry;
    if (!e) return '';
    if (e.expired) return ` <span class="tag bad" title="${esc(e.expires_at)}">expired</span>`;
    const cls = e.days_left <= 2 ? 'bad' : e.days_left <= 7 ? 'warn' : 'dim';
    const left = e.days_left < 1
      ? `${Math.max(0, Math.round(e.days_left * 24))}h left`
      : `${Math.round(e.days_left)}d left`;
    return ` <span class="tag ${cls}" title="expires ${esc(e.expires_at)}">${left}</span>`;
  };
  const defs = await api('/api/settings');
  credP.body.innerHTML = '';
  /* A headline row, because this page had none: forty rows of tags, and
     whether anything on it needs doing today was a scanning exercise. */
  const expired = defs.filter((d) => d.expiry?.expired).length;
  const soon = defs.filter((d) => d.expiry && !d.expiry.expired && d.expiry.days_left <= 7).length;
  const unset = defs.filter((d) => !d.configured && !(d.seen_by || []).length).length;
  credP.body.append(kpiRow([
    { label: 'Credentials', value: fmt(defs.length), sub: 'across every provider' },
    { label: 'Expired', value: fmt(expired), sub: 'the collector is being refused',
      tone: expired ? 'critical' : 'good' },
    { label: 'Expiring within 7 days', value: fmt(soon), sub: 're-capture before it fails silently',
      tone: soon ? 'warn' : 'good' },
    { label: 'Not set anywhere', value: fmt(unset),
      sub: 'neither here nor on the collector', tone: unset ? 'warn' : 'good' },
  ]));
  const wrap = el('div', 'setgrid'); credP.body.append(wrap);
  let grp = null;
  defs.forEach((d) => {
    if (d.group !== grp) { grp = d.group; wrap.append(el('div', 'setgroup', grp)); }
    const row = el('div', 'setrow');
    /* `data-orig` is what the box was PRE-FILLED with, so the collector below
       can tell an edit from a value it wrote there itself. Eleven non-secret
       inputs arrive pre-filled from the environment, and the collector took
       "anything non-empty" — so clicking Save with no edits at all posted all
       eleven, promoting environment-sourced config into database rows that
       shadow the environment permanently. The proof was that Save on an
       untouched page answered "enter the admin token first" rather than
       "nothing changed": the payload was non-empty after zero edits. */
    row.innerHTML = `<div class="lab">${esc(d.label)}<small>${esc(d.key)}${d.hint ? ' · ' + esc(d.hint) : ''}</small></div>
      <div><input data-k="${esc(d.key)}" data-orig="${d.secret ? '' : esc(d.value)}" type="${d.secret ? 'password' : 'text'}" placeholder="${d.configured ? esc(d.value) : 'not set'}" ${d.secret ? '' : `value="${esc(d.value)}"`}></div>
      <div>${sourceTag(d)}${expiryTag(d)}</div>`;
    wrap.append(row);
  });
  /* What a backfill would actually be for. The Data sources page lists the
     windows that failed and tells the reader to "Re-run a backfill from
     Settings"; Settings then offered a button with nothing to say which
     windows were outstanding, so the two halves of one action lived on two
     pages and neither named the other. */
  const holesHost = el('div'); credP.body.append(holesHost);
  api('/api/status').then((st2) => {
    const holes = (st2 || []).flatMap((r) => (r.failed_windows || [])
      .map((w) => ({ source: r.source, mode: r.mode, ...w })));
    if (!holes.length) {
      holesHost.append(el('p', 'cap', 'Every collection window on record landed. A backfill now would '
        + 're-fetch what is already held.'));
      return;
    }
    const box = el('div', 'note warn');
    box.innerHTML = `${countOf(holes.length, 'window')} did not land and ${plural(holes.length, 'is', 'are')} `
      /* The window bounds arrive as ISO days and were written into the
         sentence unchanged: "FMS telematics 2026-01-27→2026-02-26". */
      + `still outstanding: ${holes.slice(0, 6).map((h) => `${esc(sourceLabel(h.source))} `
        + `${esc(dateStr(h.from))} → ${esc(dateStr(h.to))}`).join(', ')}`
      + `${holes.length > 6 ? `, and ${fmt(holes.length - 6)} more` : ''}. `
      + `<a class="lnk" href="${href('sources')}">What each one came back with</a>.`;
    holesHost.append(box);
  }).catch(() => { /* the panel is an aid, not the page */ });

  const actions = el('div', 'btnrow'); actions.style.marginTop = '16px';
  actions.innerHTML = `<button class="btn" id="saveAll">Save credentials</button>
    <button class="btn sec" id="runInc">Run incremental now</button>
    <button class="btn sec" id="runBack">Run 12-month backfill</button>
    <button class="btn sec" id="runProbe">Describe every provider API</button>
    <button class="btn sec" id="runAnalyst">Run the analyst</button>
    <span class="note" id="setNote"></span>`;
  credP.body.append(actions);
  const note = actions.querySelector('#setNote');
  const post = async (path, body) => {
    if (!state.admin) { note.className = 'note err'; note.textContent = 'enter the admin token first'; return null; }
    try {
      const r = await fetch(path, { method: path.endsWith('trigger') ? 'POST' : 'PUT',
        headers: { 'content-type': 'application/json', 'x-admin-token': state.admin }, body: JSON.stringify(body) });
      const j = await r.json();
      // A refused duplicate is not an error to hide — it is the answer.
      if (r.status === 409) { note.className = 'note warn'; note.textContent = j.detail || 'already queued'; return null; }
      if (!r.ok) throw new Error(j.error || j.detail || r.status);
      note.className = 'note ok'; return j;
    } catch (e) { note.className = 'note err'; note.textContent = String(e.message); return null; }
  };
  actions.querySelector('#saveAll').onclick = async () => {
    const payload = {};
    // Only what somebody actually typed. See data-orig above.
    wrap.querySelectorAll('input[data-k]').forEach((i) => {
      const v = i.value.trim();
      if (v && v !== (i.dataset.orig || '')) payload[i.dataset.k] = v;
    });
    if (!Object.keys(payload).length) { note.className = 'note'; note.textContent = 'nothing changed'; return; }
    const j = await post('/api/settings', payload);
    if (j) { note.textContent = `saved ${countOf(j.updated.length, 'setting')}`; render(); }
  };
  const RUN = {
    runInc: ['incremental', 'incremental queued — the collector claims it within ~20s'],
    runBack: ['backfill', 'backfill queued — this pulls up to 12 months and takes a while'],
    runProbe: ['probe', 'probe queued — it describes every provider surface and stores the shape'],
    runAnalyst: ['analyst', 'analyst queued — it costs one model call and judges its own claims'],
  };
  Object.entries(RUN).forEach(([id, [mode, msg]]) => {
    actions.querySelector('#' + id).onclick = async () => {
      const j = await post('/api/settings/trigger', { mode });
      if (j) { note.textContent = `${msg} (job ${j.job_id})`; jobs(); }
    };
  });

  /* What has actually been asked for, and what happened to it.
     On-demand runs used to be a single row that the next request overwrote —
     silently, while the API answered "queued" to a job it was about to discard.
     A queue nobody can see is a queue nobody can trust. */
  const jp = panel('Requested runs', 'Every on-demand run, and what became of it.');
  root.append(jp.panel);
  const jobs = async () => {
    loading(jp.body);
    try {
      const d = await api('/api/settings/jobs');
      jp.body.innerHTML = '';
      if (!d.jobs.length) { empty(jp.body, 'Nothing has been requested by hand'); return; }
      const TONE = { queued: 'info', running: 'warn', done: 'ok', failed: 'err' };
      jp.body.append(tableFrom(d.jobs, [
        /* What the run WAS, with its serial number inside the cell. This table
           is nine columns wide and scrolls on a phone, and the first column is
           the one that stays pinned — so leading with the id froze 11, 10, 9 on
           screen while the two facts a reader opens this panel for, what ran
           and whether it worked, scrolled out of sight. A job id identifies the
           row to the database; it does not identify it to a person. */
        { label: 'What', key: 'mode',
          render: (r) => `<span class="rk" title="job ${esc(String(r.id))}">${esc(String(r.id))}</span>`
            + esc(r.mode ?? '—') },
        { label: 'State', key: 'status', render: (r) => pill(r.status, TONE[r.status]) },
        /* Who asked. Every row on this fleet reads "unauthenticated", which is
           a finding about the admin gate rather than about the run — and it was
           returned and never shown, so nobody could see it. */
        { label: 'Asked by', key: 'requested_by',
          render: (r) => (r.requested_by
            ? `<span class="tag ${r.requested_by === 'unauthenticated' ? 'warn' : 'dim'}" `
              + `title="${r.requested_by === 'unauthenticated'
                ? 'this run was triggered without an admin token' : 'from the admin token used'}">`
              + `${esc(r.requested_by)}</span>`
            : '<span class="ent-off">not recorded</span>') },
        { label: 'Requested', key: 'requested_at', render: (r) => dtStr(r.requested_at) },
        { label: 'Started', key: 'started_at', render: (r) => (r.started_at ? dtStr(r.started_at) : '—') },
        /* How long it sat in the queue before anything picked it up. One job
           here waited four hours and another seven; the row said "done" and
           gave no hint that the answer was that old. */
        { label: 'Waited', key: '_w', num: true, sortValue: (r) => (r.started_at && r.requested_at
          ? (Date.parse(r.started_at) - Date.parse(r.requested_at)) / 60000 : null),
        render: (r) => {
          if (!r.requested_at) return '—';
          if (!r.started_at) {
            return r.status === 'queued'
              ? `<span class="dim" title="still waiting for the collector to claim it">${
                fmt(Math.round((Date.now() - Date.parse(r.requested_at)) / 60000))} min so far</span>`
              : '<span class="ent-off" title="this job never started">never started</span>';
          }
          const m = Math.round((Date.parse(r.started_at) - Date.parse(r.requested_at)) / 60000);
          return m >= 60
            ? `<span class="pill warn">${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m</span>`
            : `${fmt(m)} min`;
        } },
        { label: 'Took', key: 'seconds', num: true,
          render: (r) => (r.seconds != null
            ? (r.seconds > 90 ? `${Math.round(r.seconds / 60)} min` : `${r.seconds}s`)
            : r.running_seconds != null
              ? `<span class="dim">${Math.round(r.running_seconds / 60)} min so far</span>` : '—') },
        /* Which of the eight sources the run is actually on. A backfill's FMS
           step takes four and a half hours; without this the row said 'running'
           all afternoon and a working job looked exactly like a wedged one. */
        { label: 'On', key: 'progress', render: (r) => {
          const p2 = r.progress;
          if (!p2?.current) return p2?.total ? `<span class="dim">all ${p2.total} done</span>` : '';
          // The window within the source, where the source reports one. Uber
          // and FMS each take hours, and "uber (1 of 8)" held still for all of
          // it while eleven monthly reports landed behind it.
          const st = p2.step;
          return `${esc(p2.current)} <span class="dim">(${p2.done + 1} of ${p2.total})</span>`
            + (st?.window
              ? `<br><span class="dim">${esc(st.window)} — window ${st.index + 1} of ${st.of}`
                + `${st.rows_so_far ? `, ${fmt(st.rows_so_far)} rows so far` : ''}</span>`
              : '');
        } },
        { label: 'Restarts', key: 'attempts', num: true,
          render: (r) => (r.attempts > 1
            ? `<span class="pill ${r.attempts >= 3 ? 'bad' : 'warn'}">${r.attempts}</span>` : '') },
        /* Empty for every run that worked, which is most of them — and a
           column of nine blanks under the heading "Detail" reads as a page
           that failed to load something rather than as nine runs with nothing
           to report. */
        { label: 'Detail', key: 'error',
          absent: 'these runs finished without an error, so there is nothing to detail — this '
            + 'column fills in when one fails',
          render: (r) => (r.error
          ? `<span class="note err" title="${esc(String(r.error))}">${esc(String(r.error).slice(0, 110))}${
            String(r.error).length > 110 ? '…' : ''}</span>` : '') },
      ], { sortable: true, sortId: 'jobs', defaultSort: { key: 'id', dir: 'desc' } }));
      // `note` is a DOM element in this scope — the settings status line — so
      // the shared helper of the same name is unreachable here. Build the
      // element directly rather than shadowing something on purpose.
      const live = d.jobs.find((j) => j.status === 'running');
      if (live) {
        const rem = live.progress?.remaining || [];
        jp.body.append(el('div', 'note', esc(
          (live.progress?.current
            ? `Currently collecting ${live.progress.current}`
              + (live.progress.step?.of
                ? ` (window ${live.progress.step.index + 1} of ${live.progress.step.of})` : '')
              + (rem.length ? `, then ${rem.join(', ')}.` : ', the last of the sequence.')
            : 'A run is in progress.')
          + ' Only one runs at a time, so anything queued behind it starts when this finishes.'
          + (live.attempts > 1
            ? ` This job has been restarted ${countOf(live.attempts - 1, 'time')} by a container restart — each restart`
              + ' begins the sequence again, so a long run may never reach its later sources.'
            : ''))));
      }
    } catch (e) {
      jp.body.innerHTML = '';
      jp.body.append(el('div', 'note err', esc(`Could not load: ${e.message}`)));
    }
  };
  jobs();
};


/* ─────────── motion: settle, don't slam ───────────
   Numbers count up, sections stagger in, charts draw themselves. All of it is
   decoration on top of content that is already correct and readable — and all of
   it collapses to nothing under prefers-reduced-motion (handled in CSS). */
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Honours prefers-reduced-motion on its own rather than relying on the single
   guard in animateView.
   ─────────────────────────────────────────────────────────────────────────
   For 620ms after a page paints, every KPI on screen shows a number that is
   not its value. Three separate audit passes read the DOM inside that window
   and filed "the tile disagrees with the table beneath it" as a finding; all
   three were wrong and each cost a person an afternoon. A media query makes
   every KPI screenshot trustworthy, and the people most likely to be reading
   this product on a screen recording are the ones who set that preference. */
function countUp(node) {
  if (REDUCED) return;
  const raw = node.textContent.trim();
  const m = raw.match(/^([^\d-]*)(-?[\d,]*\.?\d+)(.*)$/);   // prefix, number, suffix
  if (!m) return;
  const [, pre, numStr, post] = m;
  const target = parseFloat(numStr.replace(/,/g, ''));
  if (!isFinite(target) || Math.abs(target) > 1e12) return;
  const decimals = (numStr.split('.')[1] || '').length;
  const hasComma = numStr.includes(',');
  const fmtN = (v) => {
    const f = v.toFixed(decimals);
    return hasComma ? Number(f).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : f;
  };
  const dur = 620, t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);                 // ease-out cubic
    node.textContent = pre + fmtN(target * eased) + post;
    if (p < 1) requestAnimationFrame(tick);
    else node.textContent = raw;                          // land exactly on the real value
  };
  requestAnimationFrame(tick);
}

/* Entrance motion.
   ──────────────────────────────────────────────────────────────────────────
   None of this was firing. The selectors had drifted from the markup: it looked
   for `.hb .bar-cell > i` while charts.js emits `.hb .track > .fill`, and for
   `[data-draw]` / `[data-rise]` / `[data-fade]` attributes that were never set
   on anything. The keyframes existed, the CSS was correct, and no element ever
   matched — so the dashboard had no motion at all and the failure was silent.

   The rule the motion follows: it should carry meaning, not decorate. A bar
   growing from its baseline shows magnitude. A number counting up shows scale.
   A line drawing itself shows direction over time. Anything that does not say
   something is left still. */
function animateView(root) {
  if (REDUCED) return;

  // Stagger the top-level groups so the page assembles rather than appearing.
  root.classList.add('stagger');
  root.querySelectorAll('.kpis, .grid, .hbars, .pbars, .shifts, .dircards, .tscroll tbody')
    .forEach((g) => g.classList.add('stagger'));

  // Headline numbers count up to their value.
  root.querySelectorAll('.kpi .n').forEach(countUp);

  // Horizontal bars grow from their origin, in reading order.
  root.querySelectorAll('.hb .fill').forEach((b, i) => { b.style.animationDelay = `${i * 45}ms`; });
  root.querySelectorAll('.pbar .pb-track > i').forEach((b, i) => { b.style.animationDelay = `${i * 45}ms`; });
  root.querySelectorAll('.shift .sh-track > i').forEach((b, i) => { b.style.animationDelay = `${Math.min(i * 22, 700)}ms`; });

  // Lines draw themselves along their own length.
  root.querySelectorAll('svg path[data-draw]').forEach((path) => {
    try {
      const len = path.getTotalLength();
      if (!len) return;
      path.style.setProperty('--len', Math.ceil(len));
      path.classList.add('draw');
    } catch { /* non-path geometry */ }
  });

  // Bars rise from the axis; areas and slices fade in behind them.
  root.querySelectorAll('svg [data-rise]').forEach((r, i) => {
    r.classList.add('rise');
    r.style.animationDelay = `${Math.min(i * 22, 600)}ms`;
  });
  root.querySelectorAll('svg [data-fade]').forEach((r, i) => {
    r.classList.add('fade');
    r.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
  });

  // Cards that carry a claim settle in rather than snapping.
  root.querySelectorAll('.breakcard, .idcard').forEach((c, i) => {
    c.classList.add('settle');
    c.style.animationDelay = `${Math.min(i * 60, 500)}ms`;
  });
}

/* ─────────── render loop ─────────── */
/* The generation token lives in data.js so a page module can guard its own
   awaits without importing the shell. See the comment there for what it is
   for: a superseded render does nothing at all, including reporting its own
   failure — its errors belong to a page the reader has already left. */
async function render() {
  const gen = newRender();
  renderNav(); setHeader();
  const root = $('#view'); root.innerHTML = '';
  root.scrollIntoView?.({ block: 'start' });
  try {
    const detail = await (V[state.view] || V.unit)(root);
    if (!alive(gen)) return;
    setHeader(detail);                      // detail pages only know their title after fetching
    animateView(root);
  } catch (e) {
    if (!alive(gen)) return;                // superseded: not this reader's error
    root.innerHTML = '';
    root.append(failureBox(e, () => render()));
  }
  if (alive(gen)) { freshness(); authBanner(); }
}

/* A dead end with a way out. The generic catch printed the message and left
   the reader with a page they could only escape by editing the address —
   including for a 504, which is usually a race the retry wins because the
   server finishes the query and caches it. */
function failureBox(e, retry) {
  const box = el('div', 'empty');
  const migrating = /migrat/i.test(String(e.message || ''));
  box.innerHTML = `<b>Could not load this view</b>${esc(e.message)}`;
  if (migrating) {
    box.append(el('p', 'cap', 'The database is migrating. Nothing is lost — the pages come back when it finishes.'));
  }
  const b = el('button', 'btn sec', 'Try again');
  b.style.marginTop = '12px';
  b.onclick = () => retry();
  box.append(b);
  return box;
}

/* One panel failing must not take the page with it.
   ─────────────────────────────────────────────────────────────────────────
   A 504 on /api/live replaced the whole of #map — map, controls and legend —
   with an error box, because showLive()'s fetch had no catch of its own and the
   throw reached render(). Wrap a panel's fill in this and the failure stays
   inside the panel that owns it, with a button to ask again. The day page has
   done this since it was built (day.js add()); everything else inherited the
   all-or-nothing behaviour. */
function fill(body, gen, run) {
  const go = () => {
    loading(body);
    Promise.resolve()
      .then(run)
      .catch((e) => {
        if (!alive(gen)) return;
        body.innerHTML = '';
        const migrating = /migrat/i.test(String(e.message || ''));
        body.append(note(migrating
          ? 'The database is migrating, so this panel could not be computed. It comes back when it finishes.'
          : `Could not load this panel: ${e.message}`, 'err'));
        const b = el('button', 'btn sec', 'Try again');
        b.onclick = go; body.append(b);
      });
  };
  go();
  return body;
}
/* A held answer turned out to be stale — redraw, without stealing the reader's
   place.
   ─────────────────────────────────────────────────────────────────────────
   api() paints from what we last knew and revalidates behind it, firing this
   only when the fresh answer actually differs. Three things make the redraw
   unobtrusive:

     - it is debounced. A page issues up to fifteen requests and several may
       come back changed within the same moment; redrawing once is enough.
     - it is dropped if the reader has navigated since. The event belongs to the
       page that asked, not to whatever is on screen when it arrives.
     - the scroll position is restored. Redrawing a long table and returning the
       reader to the top would be a worse cost than the wait being saved, which
       is the whole reason nothing redraws when the data has not moved. */
let refreshTimer = null;
let refreshPaths = [];
window.addEventListener('data:refreshed', (ev) => {
  const at = `${state.view}/${state.param}/${state.sub}/${state.days}/${state.platform}/${state.fleet}`;
  refreshPaths.push(ev.detail?.path || '');
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const paths = refreshPaths; refreshPaths = [];
    const now = `${state.view}/${state.param}/${state.sub}/${state.days}/${state.platform}/${state.fleet}`;
    if (now !== at) return;                 // they have moved on; this is not their page any more
    /* Nothing moved that a reader would notice. /api/map/days carries a fix
       count that ticks with the five-minute tracker poll, so it differs on
       almost every load — and a redraw re-issues every request the view makes,
       including the realtime ones nothing caches. That is why #map fetched
       /api/live, /api/status and /api/map/days three times per visit. */
    if (paths.length && paths.every(volatilePath)) return;
    const y = window.scrollY;
    render().then(() => window.scrollTo({ top: y }));
  }, 250);
});

/* The credential banner, on every page.
   ─────────────────────────────────────────────────────────────────────────
   The failure this exists for was invisible. An expired Uber web session
   redirects to auth.uber.com and answers 404, which the collector parsed as
   neither JSON nor an error and recorded as a week in which nobody drove —
   run status 'ok', sidebar green, every earnings figure quietly frozen. The
   detection is in src/auth_state.js and the classification in
   api/auth_routes.js; this is the part a person sees.

   Above the title rather than inside the view, because a stopped credential
   makes every number below it stale and a view render would replace it.
   Rendered on every route change, so there is no page on which this is
   missing — which was the whole request.

   Silent unless something is true. No banner is the normal state, an amber
   banner is a surface that has stalled while its credential still works, and
   a red one is a credential that was refused and has to be replaced. Nothing
   here is driven by a predicted expiry: the one dated token in the Uber cookie
   jar was measured NOT to be the session (api/auth_routes.js records the
   experiment), and a banner that goes amber on a working fleet is one nobody
   reads twice. */
async function authBanner() {
  const host = $('#authBanner');
  if (!host) return;
  let d;
  try { d = await api('/api/auth'); } catch { host.innerHTML = ''; return; }
  const stopped = (d?.rows || []).filter((r) => r.severity === 'stopped');
  const risk = (d?.rows || []).filter((r) => r.severity === 'at-risk');
  const show = stopped.length ? stopped : risk;
  if (!show.length) { host.innerHTML = ''; return; }

  const tone = stopped.length ? 'stopped' : 'at-risk';
  const fleetOf = (r) => (r.fleet_id && r.fleet_id !== '*'
    ? ` · ${sourceLabel(r.fleet_id)}` : '');
  /* "last worked 2h ago" is the half that makes the other half actionable:
     it separates "this broke this morning" from "this has been dead a week". */
  const since = (r) => {
    const h = r.last_ok_age_h;
    if (h == null) return 'never authenticated';
    return h < 1 ? `last worked ${Math.round(h * 60)} min ago`
      : h < 48 ? `last worked ${Math.round(h)}h ago`
        : `last worked ${Math.round(h / 24)} days ago`;
  };
  const head = stopped.length
    ? `${countOf(stopped.length, 'credential')} stopped working — `
      + 'the surfaces behind ' + (stopped.length === 1 ? 'it are' : 'them are')
      + ' collecting nothing until ' + (stopped.length === 1 ? 'it is' : 'they are') + ' replaced'
    : `${countOf(risk.length, 'source')} ${risk.length === 1 ? 'has' : 'have'} not collected recently`;

  host.className = `authbanner ${tone}`;
  host.innerHTML = `<span class="ab-dot"></span><div class="ab-body">`
    + `<div class="ab-head">${esc(head)}</div>`
    + `<ul class="ab-list ab-detail">`
    + show.map((r) => `<li><strong>${esc(sourceLabel(r.provider))}${esc(fleetOf(r))}</strong> `
      + `<code>${esc(r.credential)}</code> — `
      + esc(r.severity === 'stopped'
        ? (r.detail || 'the credential was refused')
        : `no completed run in ${r.run_age_h}h, against a ${r.stall_limit_h}h expectation`)
      + ` <span class="ab-when">· ${esc(since(r))}</span></li>`).join('')
    + `</ul></div>`;
}

/* The sidebar freshness block.
   ─────────────────────────────────────────────────────────────────────────
   Two things were wrong and they pointed the same way — everything always
   looked fresher and healthier than it was.

   "4 source(s) need attention" counted ROWS of /api/status, which carries one
   row per source per mode: four bad rows across two distinct sources read as
   four broken collectors. And "updated 11:25" was the newest finished_at across
   every row — which is always CABMAN's five-minute poll, so the timestamp said
   "a moment ago" on a morning when the Uber trip collector had not run since
   the previous night. The realtime feed is excluded from the headline and the
   oldest batch source is named beside it, because that is the number that
   decides whether the page in front of you is worth reading. */
const REALTIME_SOURCE = /cabman|live|track/i;
async function freshness() {
  const host = $('#freshness');
  try {
    const s = await api('/api/status');
    const bad = [...new Set(s.filter((r) => r.status !== 'ok').map((r) => r.source))];
    const batch = s.filter((r) => r.finished_at && !REALTIME_SOURCE.test(r.source || ''));
    const newest = batch.map((r) => r.finished_at).sort().pop()
      || s.map((r) => r.finished_at).filter(Boolean).sort().pop();
    // The oldest source is the ceiling on how current any page can be.
    const perSource = new Map();
    batch.forEach((r) => {
      const cur = perSource.get(r.source);
      if (!cur || r.finished_at > cur) perSource.set(r.source, r.finished_at);
    });
    const oldest = [...perSource.entries()].sort((a, b) => (a[1] < b[1] ? -1 : 1))[0];
    const ageH = oldest ? (Date.now() - Date.parse(oldest[1])) / 3600e3 : null;
    host.innerHTML = newest
      ? `updated ${timeStr(newest)}<br>`
        + (bad.length
          ? `<span style="color:var(--warn)">${countOf(bad.length, 'source')} need`
            + `${bad.length === 1 ? 's' : ''} attention</span><br>`
          : 'all sources healthy<br>')
        + (oldest
          ? `<span class="dim">oldest: ${esc(sourceLabel(oldest[0]))}, ${
            ageH < 1 ? `${Math.round(ageH * 60)} min` : `${Math.round(ageH)}h`} ago</span>`
          : '')
      : 'awaiting first collection';
    host.title = bad.length ? `Not ok: ${bad.map(sourceLabel).join(', ')}` : 'Every collector reported ok';
  } catch { host.textContent = 'status unavailable'; }
}

/* A filter change rewrites the address rather than re-rendering in place, so
   the URL always describes what is on screen and the back button undoes it.
   `hashchange` does the render. */
$('#fRange').onchange = (e) => setFilter({ days: +e.target.value });
$('#fPlatform').onchange = (e) => setFilter({ platform: e.target.value });
$('#fFleet').onchange = (e) => setFilter({ fleet: e.target.value });
$('#refreshBtn').onclick = (e) => {
  const b = e.currentTarget; b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  render();
};

/* Which clock, and which days. Every calendar key the API computes is Dubai's
   and every formatter here now renders in Dubai — but a reader in another zone
   has no way to know that from a bare "17:00", and the difference is the whole
   meaning of a peak-hour chart. Shown only when it could be misread, so it is
   silent for the people it does not concern. */
function tzNote() {
  const host = $('#tzNote');
  if (!host) return;
  const [from, to] = windowDates();
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  host.title = `${from} → ${to}, Dubai days`;
  host.textContent = local === TZ ? '' : 'Dubai time';
}
tzNote();
/* Three states, and the control says which one it is in.
   ─────────────────────────────────────────────────────────────────────────
   It read "◐ theme" whatever it was about to do, and it was one-way: once a
   choice was stored there was no path back to following the operating system,
   which is the setting most people actually want. It cycles system → light →
   dark → system, and the label names the state it is in now. */
const THEME_LABEL = { light: '☀ light', dark: '☾ dark', system: '◐ system' };
const THEME_NEXT = { system: 'light', light: 'dark', dark: 'system' };
function applyTheme(mode) {
  const r = document.documentElement;
  if (mode === 'system') { r.removeAttribute('data-theme'); store.set('theme', ''); }
  else { r.setAttribute('data-theme', mode); store.set('theme', mode); }
  const b = $('#themeBtn');
  if (b) {
    b.textContent = THEME_LABEL[mode];
    b.title = `Theme: ${mode === 'system' ? 'following your device' : mode}. `
      + `Click for ${THEME_NEXT[mode]}.`;
  }
}
applyTheme(['light', 'dark'].includes(store.get('theme')) ? store.get('theme') : 'system');
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') || 'system';
  applyTheme(THEME_NEXT[cur] || 'system');
};
/* Routes are `#<view>[/<param>[/<sub>]][?days=&platform=&fleet=]`.
   An unknown view falls back to the overview rather than rendering nothing. */
function applyRoute() {
  const r = parseHash();
  const known = VIEWS.some((v) => v.id === r.view) || !!V[r.view];
  /* An empty or unknown address lands on the ledger, not on the activity
     page. This is the whole point of the reshuffle: somebody opening the
     product with no address in mind should be looking at what earns. */
  state.view = known ? r.view : 'unit';
  state.param = r.param; state.sub = r.sub;
  // The address is the authority. A link with no filter in it means the
  // defaults, not "whatever the last page happened to be showing" — otherwise
  // clicking a plain link would silently carry a 365-day window into a page
  // whose caption claims 30.
  state.days = r.days ?? 30;
  state.platform = r.platform ?? '';
  state.fleet = r.fleet ?? '';
  const rng = $('#fRange'), plt = $('#fPlatform'), flt = $('#fFleet');
  /* A value the control does not offer must be VISIBLE, not blank. `?days=180`
     is accepted by the router and linked from the repo's own smoke list, and
     the select had no 180 option — so `rng.value = '180'` left selectedIndex at
     -1 and the control rendered empty above a page genuinely using six months.
     180 now has an option; anything else that ever slips through gets one made
     for it rather than silently showing nothing. */
  if (rng) {
    rng.value = String(state.days);
    if (rng.selectedIndex < 0) {
      rng.append(new Option(`Last ${state.days} days`, String(state.days)));
      rng.value = String(state.days);
    }
  }
  if (plt) plt.value = state.platform;
  if (flt) flt.value = state.fleet;
}
applyRoute();
window.addEventListener('hashchange', () => { applyRoute(); render(); });
render();
setInterval(() => { if (state.view === 'live') render(); }, 60000);
