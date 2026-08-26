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
import { barChart } from './charts.js';
import { el, esc, panel, loading, tableFrom, kpiRow, note, pill, entity, money,
  fmt, empty, dayStr, plural, countOf, sourceLabel } from './ui.js';
import { q, href, parseHash, state } from './data.js';
import { dubaiDay } from './tz.js';

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
    timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
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

export async function renderCompare(root, aParam, bParam) {
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
  const movedP = panel('Who moved',
    'Every person who drove on either day, ordered by how much their booking count changed');
  root.append(movedP.panel);

  const g = el('div', 'grid g2'); root.append(g);
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

  /* `q()` already carries the fleet and platform chips, and drops empty values
     — passing `state.fleet || undefined` here sent `fleet=undefined` over the
     wire, which a route reading `req.query.fleet || null` accepts as a fleet
     name. Three panels then reported "No booking on either day" over a
     database holding 293 of them. */
  const p = await q('/api/compare', { a, b, cut });

  const A = p.totals.a, B = p.totals.b;
  const partial = p.cut_minutes < 1440;

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
    movedP.body.append(tableFrom(ds, [
      { label: 'Driver', key: 'driver_name',
        render: (r) => entity('performer', r.driver_ext_id, r.driver_name || r.pk)
          + (r.worked_a && r.worked_b ? '' : ` ${pill(r.worked_a ? 'new today' : 'not out', r.worked_a ? 'ok' : 'warn')}`) },
      { label: 'Bookings', key: 'd_bookings', num: true,
        render: (r) => `${fmt(r.a.bookings)} <span class="dim">vs ${fmt(r.b.bookings)}</span> ${delta(r.a.bookings, r.b.bookings)}` },
      { label: 'Km', key: 'd_km', num: true,
        render: (r) => `${fmt(r.a.km)} <span class="dim">vs ${fmt(r.b.km)}</span>` },
      { label: 'On trip', key: 'd_on_trip_min', num: true,
        render: (r) => `${hrs(r.a.on_trip_min)} <span class="dim">vs ${hrs(r.b.on_trip_min)}</span>` },
      /* Waiting is summed gap by gap, not elapsed minus on-trip: the two differ
         wherever bookings overlap, and here they overlap often. */
      { label: 'Waiting', key: 'd_wait_min', num: true,
        render: (r) => `${hrs(r.a.wait_min)} <span class="dim">vs ${hrs(r.b.wait_min)}</span> `
          + delta(r.a.wait_min, r.b.wait_min, { fmt: (v) => hrs(v), worse: true }) },
      { label: 'First', key: 'first', num: true,
        render: (r) => `${hhmm(r.a.first_trip)} <span class="dim">vs ${hhmm(r.b.first_trip)}</span>` },
      { label: 'Cancelled', key: 'cancelled', num: true,
        render: (r) => `${fmt(r.a.cancelled)} <span class="dim">vs ${fmt(r.b.cancelled)}</span>` },
      { label: 'Channels', key: 'platforms',
        render: (r) => (r.platforms || []).map((x) => pill(x)).join(' ') || '—' },
      /* A driver who changed car between the two days is one of the few
         explanations this data can offer for a drop, so the plate is in the
         row rather than one click away. */
      { label: 'Vehicle', key: 'plates',
        render: (r) => (r.plates || []).map((x) => entity('vehicle', x, x)).join(', ') || '—' },
    ], { sortable: true, sortId: 'cmp', compact: true,
      onRow: (r) => (r.driver_ext_id ? href('performer', r.driver_ext_id) : null) }));
    movedP.body.append(el('p', 'cap', esc(
      'Ordered by the size of the change, not by the total — the top of this table is what moved.')));
  }

  platP.body.innerHTML = '';
  const pls = p.platforms || [];
  if (!pls.length) empty(platP.body, 'No booking on either day.');
  else {
    platP.body.append(tableFrom(pls, [
      { label: 'Channel', key: 'platform', render: (r) => pill(r.platform) },
      { label: 'Trips', key: 'd', num: true,
        render: (r) => `${fmt(r.a.n)} <span class="dim">vs ${fmt(r.b.n)}</span> ${delta(r.a.n, r.b.n)}` },
      { label: 'Cancelled', key: 'cancelled', num: true,
        render: (r) => `${fmt(r.a.cancelled)} <span class="dim">vs ${fmt(r.b.cancelled)}</span>` },
      /* No kilometres column here. This panel is half a page wide, and distance
         per channel is what #platforms is for — carrying it as a fifth column
         pushed FARES, the one column this panel exists to show, off the edge. */
      { label: 'Fares', key: 'fares', num: true,
        render: (r) => (r.a.fares || r.b.fares
          ? `${money(r.a.fares)} <span class="dim">vs ${money(r.b.fares)}</span>`
          : '<span class="dim">no fare reported</span>') },
    ]));
  }

  rosterP.body.innerHTML = '';
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
    rosterP.body.append(h);
  };
  rosterP.body.innerHTML = '';
  list(`Out on ${dayStr(b)}, not yet on ${dayStr(a)} — ${fmt(p.stopped.length)}`,
    p.stopped, 'warn', 'Everybody who drove on the earlier day has driven on the later one.');
  list(`New on ${dayStr(a)} — ${fmt(p.started.length)}`,
    p.started, 'ok', 'Nobody drove on the later day who had not driven on the earlier one.');
  if (partial && p.is_today.a) {
    rosterP.body.append(el('p', 'cap', esc(
      `It is ${p.cut_label} in Dubai. Somebody listed as not yet out may simply start later — `
      + `${dayStr(b)} is cut at the same minute, so the comparison is fair, but a night driver `
      + 'has not begun on either day.')));
  }

  freshP.body.innerHTML = '';
  const cols = p.collectors || [];
  if (!cols.length) empty(freshP.body, 'No collector run on record.');
  else {
    const stale = (r) => {
      if (!r.last_ok) return 'never succeeded';
      const h = (Date.now() - new Date(r.last_ok).getTime()) / 3600e3;
      return h > 24 ? `${fmt(h, 0)} h ago` : null;
    };
    freshP.body.append(tableFrom(cols, [
      { label: 'Source', key: 'source', render: (r) => esc(sourceLabel(r.source)) },
      { label: 'Last run', key: 'last_run', render: (r) => (r.last_run ? hhmm(r.last_run) : '—') },
      { label: 'Last success', key: 'last_ok',
        render: (r) => (stale(r) ? pill(stale(r), 'warn') : hhmm(r.last_ok)) },
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
    freshP.body.append(el('p', 'cap',
      'Rows written counts every write by every collection run that finished in the last 24 hours. '
      + 'A collector runs many times a day and re-writes rows it already holds, so this is far '
      + 'larger than the number of new records and is only useful as "did anything move at all". '
      + 'Whether the day is complete is the Last success column.'));
    const bad = cols.filter((r) => stale(r));
    if (bad.length) {
      freshP.body.append(note(`${countOf(bad.length, 'source')} last succeeded over a day ago — `
        + `a thin ${dayStr(a)} above may be a collection gap rather than a quiet day.`, 'warn'));
    }
  }
}
