/* Two days, side by side — and the cut that makes them comparable.
   ──────────────────────────────────────────────────────────────────────────
     #compare                     today against yesterday
     #compare/<a>                 that day against the one before it
     #compare/<a>/<b>             any two days
     …?cut=full                   both days in full, partial today included

   The one thing this page must not do is compare a seven-hour today against a
   twenty-four-hour yesterday and call the difference a fall. So the default is
   the LIKE-FOR-LIKE cut: both days counted up to the same Dubai wall-clock
   minute, which when one of them is today is right now. That basis is printed
   at the top in words, not buried in a tooltip, and the whole-day figure for
   the earlier day is shown beside it so nothing is hidden by the cut.

   FOUR THINGS THIS PAGE STATES RATHER THAN SMOOTHS.

   1. WHERE IT CUT. Every headline carries the cut in its caption. A reader who
      cannot see the basis cannot check the claim.

   2. WHO STOPPED. A driver who worked yesterday and has not appeared today is
      the single most actionable row on this page, and a plain join would have
      dropped them entirely. They come back as a row with a zero, named, at the
      top of their own panel.

   3. WHETHER THE COLLECTOR RAN. A quiet morning and a dead collector produce
      exactly the same thin day. The freshness of each source is shown, because
      those two need opposite responses.

   4. THAT UBER PUBLISHES NO FARE. Money here is the fare where a channel
      reports one — hotel, Yango, Bolt — and Uber reports none at all, so a
      day that is 89% Uber shows a fares column that describes a tenth of the
      work. Said once, on the page, rather than implied by a small number. */
import { barChart, gapBars, drawnAs } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity, money,
  fmt, empty, dayStr, plural, countOf, sourceLabel, verdict, signed, andList, sentence,
  UBER_FARE_WHY, swatch, contract, glance, secHead, absenceBand, pageFoot,
  delta as uiDelta } from './ui.js';
import { q, href, parseHash, state, qChan, currentGen, alive } from './data.js';
import { dubaiDay, TZ } from './tz.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/* Today in DUBAI, from the shared helper — not from the viewer's clock and not
   from UTC. Somebody opening this page at 02:00 Dubai is looking at a day that
   UTC still calls yesterday, and "today vs yesterday" would silently become
   "yesterday vs the day before". */
const dubaiToday = () => dubaiDay();
/* Day arithmetic anchored at NOON. Subtracting 24h from midnight lands on the
   wrong side of the boundary the moment an offset is involved; from noon it
   cannot. */
const before = (d) => dubaiDay(new Date(new Date(`${d}T12:00:00Z`).getTime() - 864e5));

const hhmm = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
};

const hrs = (m) => (m == null || !Number.isFinite(Number(m)) ? '—' : `${fmt(Number(m) / 60, 1)} h`);

/* A delta with its direction built in. Zero is shown as "—" rather than as
   "+0", because a page full of green +0s reads as movement when there is
   none. `worse` inverts the colour for the measures where up is bad —
   cancellations and waiting. */
function delta(now, then, { fmt: f = (v) => fmt(v), worse = false, pctToo = true } = {}) {
  const a = Number(now || 0), b = Number(then || 0);
  const d = a - b;
  if (!d) return '<span class="dim">—</span>';
  const up = d > 0;
  const good = worse ? !up : up;
  /* The magnitude and the percentage have to agree with each other.
     ─────────────────────────────────────────────────────────────────────────
     This printed "▼ 11 (-19%)": an arrow saying down, an ABSOLUTE magnitude,
     and a SIGNED percentage — three statements of direction where one is
     enough, and the minus an ASCII hyphen where every other number on the page
     uses U+2212. The arrow already carries the sign, so the percentage is the
     magnitude too. */
  const p = pctToo && b ? ` (${Math.abs(Math.round((d / b) * 100))}%)` : '';
  return `<span class="dl ${good ? 'up' : 'dn'}">${up ? '▲' : '▼'} ${f(Math.abs(d))}${esc(p)}</span>`;
}

/* ── shared by both orders of the page ─────────────────────────────────────
   The day pickers, Swap and Today-vs-yesterday: every comparison on this
   page is an address, so any of them can be sent as a link. */
function toolbarPicks(bar, a, b, cut) {
  const pick = (label, value, to) => {
    const w = el('label', 'pick', `<span>${esc(label)}</span>`);
    const i = el('input');
    i.type = 'date'; i.value = value; i.max = dubaiToday();
    i.onchange = () => { if (DAY.test(i.value)) location.hash = to(i.value); };
    w.append(i);
    return w;
  };
  bar.append(pick('Day', a, (v) => href('compare', v, b, cut === 'full' ? { cut: 'full' } : null)));
  bar.append(pick('against', b, (v) => href('compare', a, v, cut === 'full' ? { cut: 'full' } : null)));
  const swap = el('a', 'btn', 'Swap');
  swap.href = href('compare', b, a, cut === 'full' ? { cut: 'full' } : null);
  bar.append(swap);
  const yday = el('a', 'btn', 'Today vs yesterday');
  yday.href = href('compare', dubaiToday(), before(dubaiToday()));
  bar.append(yday);
}
/* The per-driver table's nine columns — the phone-call list. `dl` draws a
   change: the old skin's arrow-and-magnitude, or the contract's signed delta. */
function driverCols(dl) {
  return [
    { label: 'Driver', key: 'driver_name',
      render: (r) => entity('performer', r.driver_ext_id, r.driver_name || r.pk)
        + (r.worked_a && r.worked_b ? '' : ` ${pill(r.worked_a ? 'new today' : 'not out', r.worked_a ? 'ok' : 'warn')}`) },
    { label: 'Bookings', key: 'd_bookings', num: true,
      render: (r) => `${fmt(r.a.bookings)} <span class="dim">vs ${fmt(r.b.bookings)}</span> ${dl(r.a.bookings, r.b.bookings)}` },
    { label: 'Km', key: 'd_km', num: true,
      render: (r) => `${fmt(r.a.km)} <span class="dim">vs ${fmt(r.b.km)}</span>` },
    { label: 'On trip', key: 'd_on_trip_min', num: true,
      render: (r) => `${hrs(r.a.on_trip_min)} <span class="dim">vs ${hrs(r.b.on_trip_min)}</span>` },
    /* Waiting is summed gap by gap, not elapsed minus on-trip: the two differ
       wherever bookings overlap, and here they overlap often. */
    { label: 'Waiting', key: 'd_wait_min', num: true,
      render: (r) => `${hrs(r.a.wait_min)} <span class="dim">vs ${hrs(r.b.wait_min)}</span> `
        + dl(r.a.wait_min, r.b.wait_min, { fmt: (v) => hrs(v), worse: true }) },
    { label: 'First', key: 'first', num: true,
      render: (r) => `${hhmm(r.a.first_trip)} <span class="dim">vs ${hhmm(r.b.first_trip)}</span>` },
    { label: 'Cancelled', key: 'cancelled', num: true,
      render: (r) => `${fmt(r.a.cancelled)} <span class="dim">vs ${fmt(r.b.cancelled)}</span>` },
    { label: 'Channels', key: 'platforms',
      render: (r) => (r.platforms || []).map((x) => pill(sourceLabel(x))).join(' ') || '—' },
    /* A driver who changed car between the two days is one of the few
       explanations this data can offer for a drop, so the plate is in the
       row rather than one click away. */
    { label: 'Vehicle', key: 'plates',
      render: (r) => (r.plates || []).map((x) => entity('vehicle', x, x)).join(', ') || '—' },
  ];
}

/* The By channel table: one money column, three bases, each cell saying
   which it used. `chan` draws the channel's cell; `cover`, when given, adds
   how much of the channel the fare covers under the figure. */
function channelCols({ chan = (r) => pill(sourceLabel(r.platform)), cover = null, dl = delta } = {}) {
  return [
    { label: 'Channel', key: 'platform', render: chan },
    { label: 'Trips', key: 'd', num: true,
      render: (r) => `${fmt(r.a.n)} <span class="dim">vs ${fmt(r.b.n)}</span> ${dl(r.a.n, r.b.n)}` },
    { label: 'Cancelled', key: 'cancelled', num: true,
      render: (r) => `${fmt(r.a.cancelled)} <span class="dim">vs ${fmt(r.b.cancelled)}</span>` },
    /* No kilometres column here. This panel is half a page wide, and distance
       per channel is what #platforms is for — carrying it as a fifth column
       pushed FARES, the one column this panel exists to show, off the edge. */
    /* ONE money column, three bases, each cell saying which it used.
       ─────────────────────────────────────────────────────────────────
       This was Fares alone — sum(trip.price) — and Uber's export carries no
       price column, so on a day that is 89% Uber the only money column on
       the panel whose job is to say which channel moved read "no fare
       reported" against every row that mattered.

       Not a fifth column: the note above about kilometres applies with equal
       force here, and a Paid column beside Fares put the table into
       horizontal scroll on a half-width panel — which is the same failure
       the kilometres column was removed to avoid. A channel has ONE money
       basis on a given day, so the two belong in one column with the basis
       marked, exactly as #roster marks its statement figures. */
    { label: 'Money', key: 'money_shown', num: true,
      render: (r) => {
        /* The basis, and the value it applies to. A channel almost always
           has the same basis on both days, so the marker is printed ONCE
           after the pair — the panel is half a page wide and repeating it
           was enough on its own to push the column into sideways scroll. */
        const BASIS = {
          fares: [null, null],
          paid: ['stmt', 'the day’s share of the weekly platform statement — an estimate'],
          statement_net: ['ldg', 'the operator’s own ledger import for this day'],
        };
        const of = (x) => (x.fares != null ? 'fares'
          : x.paid != null ? 'paid' : x.statement_net != null ? 'statement_net' : null);
        const kA = of(r.a), kB = of(r.b);
        if (!kA && !kB) return '<span class="dim">no money reported</span>';
        const mark = (k) => (k && BASIS[k][0]
          ? `<span class="dim" title="${esc(BASIS[k][1])}"> ${BASIS[k][0]}</span>` : '');
        const same = kA && kB && kA === kB;
        /* The currency once per cell, on the left figure. The Trips column
           beside this one already writes "426 vs 519" rather than repeating
           its unit, and repeating AED here is what took the cell over the
           width of its half of the grid. */
        const val = (x, k) => (k ? money(x[k]) : '—');
        const bare = (x, k) => (k ? money(x[k]).replace(/^AED\s*/, '') : '—');
        const out = same
          ? `${val(r.a, kA)} <span class="dim">vs ${bare(r.b, kB)}</span>${mark(kA)}`
          : `${val(r.a, kA)}${mark(kA)} <span class="dim">vs ${bare(r.b, kB)}</span>${mark(kB)}`;
        return cover ? out + cover(r, kA, kB) : out;
      } },
  ];
}
/* Started and stopped — the rows worth a phone call. */
function rosterLists(host, p, a, b, partial) {
  host.innerHTML = '';
  const list = (title, rows, tone, tail) => {
    const h = el('div', 'half');
    h.append(el('h4', null, esc(title)));
    if (!rows.length) h.append(el('p', 'cap', esc(tail)));
    else {
      h.append(el('p', null, rows.map((r) => (r.driver_ext_id
        ? `<a class="ent" href="${href('performer', r.driver_ext_id)}">${esc(r.driver_name || r.driver_ext_id)}</a>`
        : esc(r.driver_name || '—'))
        + ` <span class="dim">${fmt(r.bookings)} ${plural(r.bookings, 'booking')}`
        + `${(r.plates || []).length ? ` · ${esc((r.plates || []).join(', '))}` : ''}</span>`).join(' · ')));
    }
    host.append(h);
  };
  host.innerHTML = '';
  list(`Out on ${dayStr(b)}, not yet on ${dayStr(a)} — ${fmt(p.stopped.length)}`,
    p.stopped, 'warn', 'Everybody who drove on the earlier day has driven on the later one.');
  list(`New on ${dayStr(a)} — ${fmt(p.started.length)}`,
    p.started, 'ok', 'Nobody drove on the later day who had not driven on the earlier one.');
  if (partial && p.is_today.a) {
    host.append(el('p', 'cap', esc(
      `It is ${p.cut_label} in Dubai. Somebody listed as not yet out may simply start later — `
      + `${dayStr(b)} is cut at the same minute, so the comparison is fair, but a night driver `
      + 'has not begun on either day.')));
  }
}
/* Was everything collected? A quiet day and an uncollected day look the same
   on every chart above. `staleCell` draws a source that has not succeeded
   in a day. */
function freshTable(host, p, a, { staleCell = (t) => pill(t, 'warn') } = {}) {
  host.innerHTML = '';
  const cols = p.collectors || [];
  if (!cols.length) empty(host, 'No collector run on record.');
  else {
    const stale = (r) => {
      if (!r.last_ok) return 'never succeeded';
      const h = (Date.now() - new Date(r.last_ok).getTime()) / 3600e3;
      return h > 24 ? `${fmt(h, 0)} h ago` : null;
    };
    host.append(tableFrom(cols, [
      { label: 'Source', key: 'source', render: (r) => esc(sourceLabel(r.source)) },
      { label: 'Last run', key: 'last_run', render: (r) => (r.last_run ? hhmm(r.last_run) : '—') },
      { label: 'Last success', key: 'last_ok',
        render: (r) => (stale(r) ? staleCell(stale(r)) : hhmm(r.last_ok)) },
      /* Named for what it counts, which is not what the old heading implied.
         ─────────────────────────────────────────────────────────────────────
         It is `sum(rows_written)` across every collection RUN that finished in
         the last 24 hours, and a collector runs many times a day and re-upserts
         the rows it already holds. Measured live: Uber reads 1,381,368 under a
         heading of "Rows, 24h", on a fleet that takes about five hundred
         bookings a day. The figure is not wrong — that many row-writes did
         happen — but on a panel headed "Was everything collected?" it reads as
         "1.4 million rows arrived today", which is off by three orders of
         magnitude in the direction of reassurance.

         The useful signal on this panel is the last two columns; this one only
         answers "did anything move at all", so it says that instead. */
      { label: 'Rows written', key: 'rows_24h', num: true, render: (r) => fmt(r.rows_24h) },
    ], { compact: true }));
    host.append(el('p', 'cap',
      'Rows written counts every write by every collection run that finished in the last 24 hours. '
      + 'A collector runs many times a day and re-writes rows it already holds, so this is far '
      + 'larger than the number of new records and is only useful as "did anything move at all". '
      + 'Whether the day is complete is the Last success column.'));
    const bad = cols.filter((r) => stale(r));
    if (bad.length) {
      host.append(note(`${countOf(bad.length, 'source')} last succeeded over a day ago — `
        + `a thin ${dayStr(a)} above may be a collection gap rather than a quiet day.`, 'warn'));
    }
  }
}

/* Two orders of one page until the operator flips the default skin: the old
   skin's (compareClassic) and the page contract (compareContract, below).
   The toolbar, the driver columns, By channel's money column, the roster
   lists and the freshness table are the helpers above, shared by both. */
export async function renderCompare(root, aParam, bParam) {
  return contract() ? compareContract(root, aParam, bParam) : compareClassic(root, aParam, bParam);
}

async function compareClassic(root, aParam, bParam) {
  const a = DAY.test(aParam || '') ? aParam : dubaiToday();
  const b = DAY.test(bParam || '') ? bParam : before(a);
  const cut = parseHash().cut === 'full' ? 'full' : 'auto';

  const bar = el('div', 'toolbar'); root.append(bar);
  const kh = el('div', 'kpis'); root.append(kh); loading(kh);
  const basis = el('div'); root.append(basis);

  const hourP = panel('Hour by hour',
    'Bookings in each Dubai hour on both days — the shape of the day, not just its total');
  root.append(hourP.panel);

  /* Full width, not a grid half. Nine columns of two-sided figures need the
     whole page: at 2fr of a 2:1 split the last three columns were cut off at
     the panel edge, so "first trip", "cancelled" and the vehicle — the columns
     that explain a fall — were the ones nobody could see. */
  const movedP = panel('Who drove more, who drove less',
    'Every person who drove on either day, ordered by how much their booking count changed');
  root.append(movedP.panel);

  /* g23, not g2. By channel is a four-column table carrying two figures and a
     basis marker in its money cell; measured on production at a 1600px
     viewport it needs 660px and an even split gave it 593, so the column the
     panel exists to show was 67px off the edge and the reader was told to
     scroll for it. Started and stopped beside it is two short lists of names
     and loses nothing to the narrower half. */
  const g = el('div', 'grid g23'); root.append(g);
  const platP = panel('By channel', 'Where the change came from');
  g.append(platP.panel);
  const rosterP = panel('Started and stopped',
    'People who drove on one of these days and not the other — the rows worth a phone call');
  g.append(rosterP.panel);
  const freshP = panel('Was everything collected?',
    'A quiet day and an uncollected day look identical on every chart above');
  root.append(freshP.panel);
  [movedP.body, platP.body, rosterP.body, freshP.body].forEach(loading);
  loading(hourP.body);

  /* Both day pickers and the cut toggle are real addresses, so any comparison
     on this page can be sent to somebody else as a link. */
  toolbarPicks(bar, a, b, cut);

  /* `q()` already carries the fleet and platform chips, and drops empty values
     — passing `state.fleet || undefined` here sent `fleet=undefined` over the
     wire, which a route reading `req.query.fleet || null` accepts as a fleet
     name. Three panels then reported "No booking on either day" over a
     database holding 293 of them. */
  /* qChan, not q. /api/compare reads a, b, cut, fleet and platform and no
     window at all (api/compare_routes.js:63-80) — the two days ARE the window
     — and #compare is on NO_RANGE, so the control is hidden. Sending a range
     it does not read made a request that claimed a span the page has no
     control for, and gave the response cache one entry per window for an
     answer identical across all of them. Verified: the same a/b answers
     byte-for-byte over a 7-day and a 365-day window. */
  const p = await qChan('/api/compare', { a, b, cut });

  const A = p.totals.a, B = p.totals.b;
  const partial = p.cut_minutes < 1440;

  /* Fields read off /api/compare on production: totals.a/.b carry bookings,
     completed, cancelled, telematics, km, fares, priced, drivers, vehicles,
     on_trip_min; cut_minutes/cut_label say where the day was cut.

     The whole reason this page exists is that a partial today looks like a
     collapse, so the verdict states the cut BEFORE the number it changes. */
  {
    const d0 = (+A.bookings || 0) - (+B.bookings || 0);
    const pctMove = B.bookings ? Math.round((d0 / B.bookings) * 100) : null;
    const bigger = Math.abs(pctMove ?? 0) >= 15;
    verdict(root, {
      claim: d0 === 0
        ? 'Both days took the same number of bookings'
        : `${Math.abs(d0)} ${plural(Math.abs(d0), 'booking')} ${d0 > 0 ? 'more' : 'fewer'} than the day before`,
      figure: pctMove == null ? fmt(A.bookings) : signed(pctMove, { unit: '%' }),
      unit: pctMove == null ? 'bookings' : 'on the day before',
      tone: bigger && d0 < 0 ? 'warn' : null,
      meta: `${fmt(A.bookings)} against ${fmt(B.bookings)}`,
      /* The cut is the first thing said, not a footnote. */
      sub: partial
        ? `Both days are cut at ${p.cut_label} so the comparison is like for like — today is `
          + 'still being collected, and a whole day against a part-day always reads as a collapse.'
        : 'Both days are shown in full.',
    });
  }

  /* The toggle is built after the fetch so its label can name the actual cut
     the server chose, rather than guessing at the reader's clock. */
  const toggle = el('a', 'btn', partial ? 'Show both days in full' : `Cut at the same hour`);
  toggle.href = partial ? href('compare', a, b, { cut: 'full' }) : href('compare', a, b);
  bar.append(toggle);

  kh.replaceWith(kpiRow([
    { label: 'Bookings', html: `${fmt(A.bookings)} <span class="dim">vs ${fmt(B.bookings)}</span>`,
      sub: `${dayStr(a)} against ${dayStr(b)}` },
    { label: 'Change', html: delta(A.bookings, B.bookings),
      sub: partial ? `both days to ${p.cut_label} Dubai` : 'both days in full' },
    /* "started" is a VERB here, and countOf pluralises its noun — the tile read
       "6 starteds · 6 stopped". Both halves are counts of people who did a
       thing, so both are written the same way. */
    { label: 'Drivers out', html: `${fmt(A.drivers)} <span class="dim">vs ${fmt(B.drivers)}</span>`,
      sub: `${fmt(p.started.length)} started · ${fmt(p.stopped.length)} stopped` },
    /* The completion split, which was in the per-driver and per-channel tables
       and on no tile — and on this page it is usually the biggest relative move
       there is. Measured on the two days this was written: bookings moved by
       1% and cancellations by 23%, and only the 1% was above the fold.
       `worse: true` because a rise here is a fall. */
    { label: 'Completed', html: `${fmt(A.completed)} <span class="dim">vs ${fmt(B.completed)}</span>`,
      sub: A.bookings ? `${Math.round((A.completed / A.bookings) * 100)}% of bookings, `
        + `against ${B.bookings ? Math.round((B.completed / B.bookings) * 100) : 0}%` : null },
    { label: 'Cancelled', html: `${fmt(A.cancelled)} <span class="dim">vs ${fmt(B.cancelled)}</span>`
      + ` ${delta(A.cancelled, B.cancelled, { worse: true })}`,
      sub: A.bookings ? `${Math.round((A.cancelled / A.bookings) * 100)}% of bookings on `
        + `${dayStr(a)}` : null,
      tone: A.bookings && B.bookings
        && (A.cancelled / A.bookings) > (B.cancelled / B.bookings) * 1.2 ? 'warn' : null },
    { label: 'Distance', html: `${fmt(A.km)} <span class="dim">vs ${fmt(B.km)}</span> km`,
      sub: 'booked kilometres, where a channel reports one' },
    { label: 'Carrying someone', html: `${hrs(A.on_trip_min)} <span class="dim">vs ${hrs(B.on_trip_min)}</span>`,
      sub: `measured over ${fmt(A.timed)} bookings that report an end` },
  ]));

  basis.innerHTML = '';
  basis.append(note(p.cut_note, partial ? 'warn' : null));
  if (partial && p.full_day.b) {
    basis.append(el('p', 'cap',
      esc(`${dayStr(b)} finished on ${fmt(p.full_day.b.bookings)} bookings `
        + `and ${fmt(p.full_day.b.km)} km — the comparison above stops at ${p.cut_label}.`)));
  }
  /* Uber publishes no fare per trip, so a money column on a fleet that is
     mostly Uber describes a small minority of the work. Said in words. */
  if (A.priced < A.bookings || B.priced < B.bookings) {
    basis.append(el('p', 'cap', esc(
      `Fares cover ${fmt(A.priced)} of ${fmt(A.bookings)} bookings on ${dayStr(a)} and `
      + `${fmt(B.priced)} of ${fmt(B.bookings)} on ${dayStr(b)}: Uber's trip export carries no `
      + 'fare column at all, so money here describes the hotel, Yango and Bolt rows only.')));
  }

  hourP.body.innerHTML = '';
  const hs = (p.hours || []).filter((h) => h.a || h.b);
  if (!hs.length) empty(hourP.body, 'No booking on either day.');
  else {
    /* Two rows of bars rather than one stacked chart: stacking two days hides
       which of them is which at every hour where one is small. */
    /* The x value is what the axis prints, so the hour is formatted into the
       row once rather than left as a bare integer under a chart of a day. */
    p.hours.forEach((h) => { h.at = `${String(h.hour).padStart(2, '0')}:00`; });
    /* One scale for both charts. Drawn one above the other they are read as a
       comparison, and two independently scaled axes make a peak of 5 and a
       peak of 7 the same height — which is the opposite of what the page is
       for. */
    const peak = Math.max(...p.hours.map((h) => Math.max(h.a || 0, h.b || 0)), 1);
    const rowFor = (key, day, tone) => {
      const host = el('div');
      const cap = el('p', 'cap', esc(`${dayStr(day)}${partial && p.is_today[key] ? ' — still running' : ''}`));
      hourP.body.append(cap, host);
      /* `label` is a suffix string, not a formatter: charts.js appends it after
         the value it has already rendered. Passing a function here printed
         "[object Object]" into every tooltip on the chart. */
      barChart(host, p.hours, { x: 'at', y: key, color: tone, label: 'bookings', max: peak,
        onClick: () => { location.hash = href('day', day); } });
      return host;
    };
    rowFor('a', a, '--b400');
    rowFor('b', b, '--b200');
    const peakA = hs.reduce((m, h) => (h.a > (m ? m.a : -1) ? h : m), null);
    const peakB = hs.reduce((m, h) => (h.b > (m ? m.b : -1) ? h : m), null);
    hourP.body.append(el('p', 'cap', esc(
      `Busiest hour: ${String(peakA.hour).padStart(2, '0')}:00 on ${dayStr(a)} `
      + `(${fmt(peakA.a)}), ${String(peakB.hour).padStart(2, '0')}:00 on ${dayStr(b)} (${fmt(peakB.b)}).`
      + (partial ? ` Hours from ${p.cut_label} are shown for ${dayStr(b)} only.` : ''))));
  }

  movedP.body.innerHTML = '';
  const ds = p.drivers || [];
  if (!ds.length) empty(movedP.body, 'Nobody drove on either day.');
  else {
    movedP.body.append(tableFrom(ds, driverCols(delta), { sortable: true, sortId: 'cmp', compact: true,
      onRow: (r) => (r.driver_ext_id ? href('performer', r.driver_ext_id) : null) }));
    movedP.body.append(el('p', 'cap', esc(
      'Ordered by the size of the change, not by the total — the top of this table is what moved.')));
  }

  platP.body.innerHTML = '';
  /* Stamped flat, and that is not cosmetic: tableFrom PRUNES a column that
     declares `absent` and whose KEY is empty on every row (ui.js:187), and it
     reads the key rather than running the renderer for that decision. The Paid
     column's money lives under r.a / r.b, so keyed on 'paid' it was dropped
     from every render — the column shipped and never appeared. Stamping also
     gives it something to sort on. */
  const pls = (p.platforms || []).map((r) => ({
    ...r,
    money_shown: r.a?.fares ?? r.a?.paid ?? r.a?.statement_net
      ?? r.b?.fares ?? r.b?.paid ?? r.b?.statement_net ?? null,
  }));
  if (!pls.length) empty(platP.body, 'No booking on either day.');
  else {
    platP.body.append(tableFrom(pls, channelCols()));
    platP.body.append(el('p', 'cap',
      'Where a channel prices its trips, this is the fare the rider was charged. Where it does '
      + 'not — Uber publishes none — it is the day’s share of the weekly platform statement, '
      + 'marked “stmt” and an estimate, because nobody earns a seventh of their week each day; '
      + 'or, marked “ldg”, the operator’s own ledger import for days the platform feeds no '
      + 'longer reach. One basis per channel per day, never two added together.'));
  }

  rosterLists(rosterP.body, p, a, b, partial);

  freshTable(freshP.body, p, a);
}

/* ── #compare under the page contract (plan §4 #compare) ───────────────────
   The toolbar, the per-driver table, By channel's one money column and the
   freshness table are working parts (rule 3) and keep their structure. In
   the plan's order:

     00  AT A GLANCE — the cut first (the head's note), the verdict, then six
         tiles: Bookings the hero with the change as its delta (the old
         "Change" tile was the same figure), Drivers out, Completed with the
         change in completion in POINTS, Cancelled with the change inverted
         (a fall is better), Distance with the telematics journeys of both
         days (in the payload, shown nowhere), Carrying someone.
     —   the basis: the cut note, the earlier day's full-day line, and the
         fares line — FIXED (rule 4): "Uber's trip export carries no fare
         column at all, so money here describes the hotel, Yango and Bolt
         rows only" is false (on 2026-09-23 331 of 365 were priced, Uber's
         among them); it says how many rows are priced and UBER_FARE_WHY.
     01  Hour by hour, 02 cancellations by hour — both days on ONE scale,
         the earlier day in grey, the later in ink (these series span every
         channel, and blue is Uber's), and an hour the live day has not
         reached drawn as the absence OUTLINE, never as a zero-height bar.
     03  Who drove more, who drove less — the nine columns, the change a
         signed delta.
     04  By channel — the channel with its swatch, FMS labelled "journeys,
         not bookings", and under a fare the share of the channel it covers
         (/api/compare .platforms[].a/.b .priced, added for this page).
     05  Started and stopped, 06 was everything collected — the stale mark
         in ink words, not an amber pill.
     †   four cells.

   NOT ADOPTED: the "four hours at a time" paired bars and the merged
   one-series day (both coarser than the two rows on one scale); the two
   name dot plots (7 names, no links — a subset of the table the operator
   phones from); the freshness bars (a bar carries one of the table's three
   columns); the mockup's stale absence cells (journeys 0, 1 of 4 channels,
   every row Uber — all false today). */
const HOUR_NOW = () => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit',
    hour12: false }).format(new Date()).split(':').map(Number);
  return h * 60 + m;
};
/* A change, signed, in the contract's form: the colour follows the meaning
   (`worse` inverts it), the glyph and sign the arithmetic, and no change is
   said as such rather than as a dash. */
/* In a table row a missing side prints no change at all: a driver's waiting
   is null below two bookings, and "— vs — – 0.0 h" called two unmeasured
   figures equal. A change of nothing is left to the pair beside it. */
const sdelta = (now, then, { fmt: f = null, worse = false, unit = '', d = 0 } = {}) => {
  if (now == null || then == null || now === '' || then === '') return '';
  const a = Number(now), b = Number(then);
  const v = f ? Number(f(a - b)) : a - b;
  if (!Number.isFinite(v) || Number(v.toFixed(d)) === 0) return '';
  return uiDelta(v, { invert: worse, unit, d });
};
async function compareContract(root, aParam, bParam) {
  const gen = currentGen();
  const a = DAY.test(aParam || '') ? aParam : dubaiToday();
  const b = DAY.test(bParam || '') ? bParam : before(a);
  const cut = parseHash().cut === 'full' ? 'full' : 'auto';

  const bar = el('div', 'toolbar'); root.append(bar);
  const band = el('section', 'cband');
  const head = secHead('00', 'At a glance', `${dayStr(a)} against ${dayStr(b)}`);
  const vHost = el('div');
  const tiles = el('div');
  const basis = el('div', 'cmp-basis');
  band.append(head, vHost, tiles, basis);
  root.append(band);
  const hourP = panel('Hour by hour', 'Bookings in each Dubai hour on both days, on one scale — the shape of the day, not just its total', 'cmp-hours');
  const cancP = panel('Cancellations hour by hour', 'Cancelled bookings in each Dubai hour, both days on one scale', 'cmp-cancel');
  const movedP = panel('Who drove more, who drove less',
    'Every person who drove on either day, ordered by how much their booking count changed', 'cmp-drivers');
  root.append(hourP.panel, cancP.panel, movedP.panel);
  const g = el('div', 'grid g23'); root.append(g);
  const platP = panel('By channel', 'Where the change came from', 'cmp-channel');
  const rosterP = panel('Started and stopped',
    'People who drove on one of these days and not the other — the rows worth a phone call', 'cmp-roster');
  g.append(platP.panel, rosterP.panel);
  const freshP = panel('Was everything collected?',
    'A quiet day and an uncollected day look identical on every chart above', 'cmp-fresh');
  root.append(freshP.panel);
  const absHost = el('div'); root.append(absHost);
  [tiles, hourP.body, cancP.body, movedP.body, platP.body, rosterP.body, freshP.body].forEach((x) => loading(x));
  toolbarPicks(bar, a, b, cut);

  const p = await qChan('/api/compare', { a, b, cut });
  if (!alive(gen)) return;
  const A = p.totals.a, B = p.totals.b;
  const partial = p.cut_minutes < 1440;
  head.querySelector('.sechd-note').textContent = partial
    ? `${dayStr(a)} against ${dayStr(b)} · both cut at ${p.cut_label} Dubai`
    : `${dayStr(a)} against ${dayStr(b)} · both days in full`;

  const toggle = el('a', 'btn', partial ? 'Show both days in full' : 'Cut at the same hour');
  toggle.href = partial ? href('compare', a, b, { cut: 'full' }) : href('compare', a, b);
  bar.append(toggle);

  /* ── 00 · the statement ─────────────────────────────────────────────── */
  const d0 = (+A.bookings || 0) - (+B.bookings || 0);
  const pctMove = B.bookings ? Math.round((d0 / B.bookings) * 100) : null;
  verdict(vHost, {
    claim: d0 === 0
      ? 'Both days took the same number of bookings'
      : `${Math.abs(d0)} ${plural(Math.abs(d0), 'booking')} ${d0 > 0 ? 'more' : 'fewer'} than the day before`,
    figure: pctMove == null ? fmt(A.bookings) : signed(pctMove, { unit: '%' }),
    unit: pctMove == null ? 'bookings' : 'on the day before',
    tone: Math.abs(pctMove ?? 0) >= 15 && d0 < 0 ? 'warn' : null,
    meta: `${fmt(A.bookings)} against ${fmt(B.bookings)}`,
    sub: partial
      ? `Both days are cut at ${p.cut_label} so the comparison is like for like — today is `
        + 'still being collected, and a whole day against a part-day always reads as a collapse.'
      : 'Both days are shown in full.',
  });

  /* ── 00 · the tiles ─────────────────────────────────────────────────── */
  const of = `against ${dayStr(b)}`;
  const pctChange = (x, y, { invert = false } = {}) => (Number(y)
    ? { value: ((Number(x) - Number(y)) / Number(y)) * 100, unit: '%', of, invert, d: 1 }
    : { value: null, na: `not compared: ${dayStr(b)} holds none` });
  const rate = (x, n) => (Number(n) ? (Number(x) / Number(n)) * 100 : null);
  const pair = (x, y, unit = '') => `${fmt(x)} <span class="dim">vs ${fmt(y)}</span>${unit ? ` ${unit}` : ''}`;
  glance(tiles, [
    { label: 'Bookings', html: pair(A.bookings, B.bookings), hero: true,
      delta: pctChange(A.bookings, B.bookings), sub: `${dayStr(a)} against ${dayStr(b)}` },
    { label: 'Drivers out', html: pair(A.drivers, B.drivers),
      sub: `${fmt(p.started.length)} started · ${fmt(p.stopped.length)} stopped` },
    { label: 'Completed', html: pair(A.completed, B.completed),
      delta: rate(A.completed, A.bookings) == null || rate(B.completed, B.bookings) == null
        ? { value: null, na: 'not compared: a day with no booking has no completion rate' }
        : { value: rate(A.completed, A.bookings) - rate(B.completed, B.bookings), unit: 'points', of, d: 1 },
      sub: A.bookings ? `${Math.round((A.completed / A.bookings) * 100)}% of bookings, `
        + `against ${B.bookings ? Math.round((B.completed / B.bookings) * 100) : 0}%` : null },
    { label: 'Cancelled', html: pair(A.cancelled, B.cancelled),
      delta: pctChange(A.cancelled, B.cancelled, { invert: true }),
      sub: A.bookings ? `${Math.round((A.cancelled / A.bookings) * 100)}% of bookings on ${dayStr(a)}` : null },
    { label: 'Distance', html: pair(A.km, B.km, 'km'),
      sub: `booked kilometres, where a channel reports one · the trackers filed ${fmt(A.telematics)} `
        + `against ${fmt(B.telematics)} telematics journeys (FMS)` },
    { label: 'Carrying someone', html: `${hrs(A.on_trip_min)} <span class="dim">vs ${hrs(B.on_trip_min)}</span>`,
      sub: `measured over ${fmt(A.timed)} bookings that report an end` },
  ]);

  /* ── the basis: the cut, the full day, and what the fares cover ────── */
  basis.append(note(p.cut_note, partial ? 'warn' : null));
  if (partial && p.full_day.b) {
    basis.append(el('p', 'cap',
      esc(`${dayStr(b)} finished on ${fmt(p.full_day.b.bookings)} bookings `
        + `and ${fmt(p.full_day.b.km)} km — the comparison above stops at ${p.cut_label}.`)));
  }
  if (A.priced < A.bookings || B.priced < B.bookings) {
    basis.append(el('p', 'cap', esc(
      `Fares cover ${fmt(A.priced)} of ${fmt(A.bookings)} bookings on ${dayStr(a)} and `
      + `${fmt(B.priced)} of ${fmt(B.bookings)} on ${dayStr(b)}. ${UBER_FARE_WHY}, so an Uber booking is priced `
      + 'once that walk reaches it, and money here covers the priced rows only.')));
  }

  /* ── 01 / 02 · both days, one scale, the unreached hours outlined ──── */
  const nowMin = HOUR_NOW();
  const reached = (key, h) => !(p.is_today[key] && (h.past_cut || h.hour * 60 > nowMin));
  const twoRows = (host, ka, kb, noun) => {
    host.innerHTML = '';
    const hs = (p.hours || []).filter((h) => h[ka] || h[kb]);
    if (!hs.length) { empty(host, `No ${noun} on either day.`); return null; }
    const peak = Math.max(...p.hours.map((h) => Math.max(h[ka] || 0, h[kb] || 0)), 1);
    const row = (key, day, color) => {
      const data = p.hours.map((h) => ({ at: `${String(h.hour).padStart(2, '0')}:00`, v: h[key], gap: !reached(key[0], h) }));
      const gaps = data.filter((x) => x.gap).length;
      host.append(el('p', 'cap', esc(`${dayStr(day)}${gaps ? ` — ${countOf(gaps, 'hour')} not yet reached` : ''}`)));
      const c = el('div'); host.append(c);
      gapBars(c, data, { x: 'at', y: 'v', color, label: noun, max: peak, gapKey: 'gap', inProgress: false, bucketNoun: 'hours',
        gapLabel: 'not yet reached — this hour has not happened', aria: `${sentence(noun)} each hour on ${dayStr(day)}`,
        onClick: () => { location.hash = href('day', day); } });
    };
    row(ka, a, '--ink');
    row(kb, b, '--grey');
    return hs;
  };
  const hs = twoRows(hourP.body, 'a', 'b', 'bookings');
  if (hs) {
    const peakA = hs.reduce((m, h) => (h.a > (m ? m.a : -1) ? h : m), null);
    const peakB = hs.reduce((m, h) => (h.b > (m ? m.b : -1) ? h : m), null);
    hourP.body.append(el('p', 'cap', esc(
      `${dayStr(a)} in ink, ${dayStr(b)} in grey, on one scale. `
      + `Busiest hour: ${String(peakA.hour).padStart(2, '0')}:00 on ${dayStr(a)} `
      + `(${fmt(peakA.a)}), ${String(peakB.hour).padStart(2, '0')}:00 on ${dayStr(b)} (${fmt(peakB.b)}). `
      + `An hour that has not happened yet is ${drawnAs('absent')}, not zero. Click a bar to open that day.`)));
  }
  const cs = twoRows(cancP.body, 'a_cancelled', 'b_cancelled', 'cancellations');
  if (cs) {
    const sum = (k) => (p.hours || []).reduce((x, h) => x + (Number(h[k]) || 0), 0);
    cancP.body.append(el('p', 'cap', esc(`${fmt(sum('a_cancelled'))} cancelled on ${dayStr(a)} and `
      + `${fmt(sum('b_cancelled'))} on ${dayStr(b)} across the whole day — the hour charts are not cut, `
      + `so ${dayStr(b)}'s later hours are there to compare against when ${dayStr(a)} reaches them.`)));
  }

  /* ── 03 · the phone-call list ───────────────────────────────────────── */
  movedP.body.innerHTML = '';
  const ds = p.drivers || [];
  if (!ds.length) empty(movedP.body, 'Nobody drove on either day.');
  else {
    movedP.body.append(tableFrom(ds, driverCols((x, y, o = {}) => sdelta(x, y, o.fmt
      ? { fmt: (v) => v / 60, worse: o.worse, unit: 'h', d: 1 } : { worse: o.worse })),
    { sortable: true, sortId: 'cmp', compact: true,
      onRow: (r) => (r.driver_ext_id ? href('performer', r.driver_ext_id) : null) }));
    movedP.body.append(el('p', 'cap', esc(
      'Ordered by the size of the change, not by the total — the top of this table is what moved.')));
  }

  /* ── 04 · by channel ────────────────────────────────────────────────── */
  platP.body.innerHTML = '';
  const pls = (p.platforms || []).map((r) => ({
    ...r,
    money_shown: r.a?.fares ?? r.a?.paid ?? r.a?.statement_net
      ?? r.b?.fares ?? r.b?.paid ?? r.b?.statement_net ?? null,
  }));
  if (!pls.length) empty(platP.body, 'No booking on either day.');
  else {
    const cover = (r, kA, kB) => {
      const part = (x, k) => (k === 'fares' && x.priced != null && x.priced < x.n ? `${fmt(x.priced)} of ${fmt(x.n)}` : null);
      const pa = part(r.a, kA), pb = part(r.b, kB);
      return pa || pb ? `<span class="cmp-cov">fares on ${pa || 'all'} <span class="dim">vs ${pb || 'all'}</span></span>` : '';
    };
    platP.body.append(tableFrom(pls, channelCols({
      dl: (x, y) => sdelta(x, y),
      chan: (r) => `<span class="chn">${swatch(r.platform)}${esc(sourceLabel(r.platform))}</span>`
        + (String(r.platform).toLowerCase() === 'fms' ? ' <span class="dim">journeys, not bookings</span>' : ''),
      cover })));
    platP.body.append(el('p', 'cap',
      'Where a channel prices its trips, this is the fare the rider was charged, with how many of its rows the '
      + 'fare covers where that is not all of them. Where it does not — Uber publishes none on the trip — it is '
      + 'the day’s share of the weekly platform statement, marked “stmt” and an estimate; or, marked “ldg”, the '
      + 'operator’s own ledger import. One basis per channel per day, never two added together. FMS counts '
      + 'telematics journeys — the same trips seen by the trackers — not bookings.'));
  }

  /* ── 05 / 06 ─────────────────────────────────────────────────────────── */
  rosterLists(rosterP.body, p, a, b, partial);
  freshTable(freshP.body, p, a, { staleCell: (t) => `<span class="cmp-stale">stale · ${esc(t)}</span>` });

  /* ── † ───────────────────────────────────────────────────────────────── */
  const cols = p.collectors || [];
  const silent = cols.filter((r) => !r.last_ok || (Date.now() - new Date(r.last_ok).getTime()) / 3600e3 > 24);
  const unreached = ['a', 'b'].reduce((n, k) => n + (p.hours || []).filter((h) => !reached(k, h)).length, 0);
  absenceBand(absHost, [
    { label: 'Fares on these days', hl: true, fig: `${fmt(A.priced)} of ${fmt(A.bookings)}`,
      why: `Bookings priced on ${dayStr(a)}; ${fmt(B.priced)} of ${fmt(B.bookings)} on ${dayStr(b)}. `
        + `${UBER_FARE_WHY}, so a recent Uber booking carries no fare until that walk reaches it — the money `
        + 'columns describe the priced rows only.' },
    unreached
      ? { label: 'Hours not yet reached', fig: countOf(unreached, 'hour'),
        why: `It is ${String(Math.floor(nowMin / 60)).padStart(2, '0')}:${String(nowMin % 60).padStart(2, '0')} in Dubai. The hours after it have not happened, so `
          + `the hour charts draw them as outlines, never as zero, and the tiles stop at the same minute on both days.` }
      : null,
    { label: 'Whether a stopped driver has left', fig: null, none: 'Not known',
      why: `${countOf(p.stopped.length, 'person', 'people')} drove on ${dayStr(b)} and not${partial ? ' yet' : ''} on `
        + `${dayStr(a)}. The record holds bookings, not intentions: a day off, a late start and leaving the fleet look the same here.` },
    { label: 'Sources silent over a day', fig: `${fmt(silent.length)} of ${fmt(cols.length)}`,
      why: silent.length
        ? `${andList(silent.map((r) => sourceLabel(r.source)))} last succeeded over a day ago, so a thin ${dayStr(a)} may be `
          + 'a collection gap rather than a quiet day.'
        : 'Every source succeeded within a day, so a thin day here is the fleet, not the collector.' },
  ]);
  pageFoot({ colophon: [
    `${dayStr(a)} against ${dayStr(b)}`,
    partial ? `both cut at ${p.cut_label} Dubai` : 'both days in full',
    `${fmt(A.bookings)} against ${fmt(B.bookings)} bookings`,
  ] }, root);
}
