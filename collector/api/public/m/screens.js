/* The phone's screens.
   ─────────────────────────────────────────────────────────────────────────
   Five destinations and the drill-downs behind them. The set is not the
   desktop's fourteen views shrunk: it is what someone actually opens a phone
   for — is the fleet working, is the money arriving, who is out, where are the
   cars, and what needs doing — with everything else one tap away in More.

   Every screen is `async (deck, ctx)`. `ctx.alive()` is false once the reader
   has navigated away, and every await is followed by a check: on a slow
   connection a reader taps twice, and the second screen must not be painted
   over by the first one's response arriving late.
*/
import { state, q, qAll, api, href } from '../data.js';
import { el, esc, money, fmt, dayStr, card, lede, stats, rows, row, seg, search,
  skeleton, empty, failed, spark, bars, unwrap, cut } from './ui.js';

export const TABS = [
  { id: 'today', route: 'today', label: 'Today', ic: '◱', owns: ['today', 'overview', 'demand'] },
  { id: 'money', route: 'money', label: 'Money', ic: '◈', owns: ['money', 'finance', 'platforms'] },
  { id: 'people', route: 'people', label: 'People', ic: '◧', owns: ['people', 'drivers', 'driver'] },
  { id: 'fleet', route: 'fleet', label: 'Fleet', ic: '▤', owns: ['fleet', 'vehicles', 'vehicle'] },
  { id: 'more', route: 'more', label: 'More', ic: '⋯',
    owns: ['more', 'live', 'map', 'safety', 'unauthorized', 'insights', 'compliance',
      'sources', 'settings', 'corporate', 'analyst', 'property', 'credentials',
      'optimise'] },
];

const WINDOW_NOTE = () => `Last ${state.days} days`
  + (state.platform ? ` · ${state.platform}` : '') + (state.fleet ? ` · ${state.fleet}` : '');

export function titleFor(view, param) {
  const t = {
    today: ['Today', WINDOW_NOTE()],
    money: ['Money', WINDOW_NOTE()],
    people: ['People', WINDOW_NOTE()],
    fleet: ['Fleet', WINDOW_NOTE()],
    more: ['More', 'Everything else'],
    live: ['Live fleet', 'Positions now'],
    safety: ['Safety', 'Harsh-driving events'],
    unauthorized: ['Unauthorized', 'Moved with no booking'],
    sources: ['Data sources', 'Collector health'],
    driver: [param || 'Driver', 'Everything on this person'],
    vehicle: [param || 'Vehicle', 'Everything on this car'],
    /* Named, even where the screen is the fallback: a header reading
       "insights" is the router's word for the page, not the product's. */
    corporate: ['Corporate', 'The hotel channel'],
    credentials: ['Credentials', 'Tested before they are stored'],
    analyst: ['Analyst', 'Claims the data was asked to settle'],
    optimise: ['Optimise', 'Where the next trip is'],
    insights: ['Action list', 'Built for a bigger screen'],
    compliance: ['Compliance', 'Built for a bigger screen'],
    demand: ['Demand', 'Built for a bigger screen'],
    map: ['Map & replay', 'Built for a bigger screen'],
    settings: ['Settings', 'Built for a bigger screen'],
  }[view];
  return { title: t ? t[0] : (view || 'Fleet'), sub: t ? t[1] : 'Built for a bigger screen' };
}

/* A number the API sends as a string stays a string all the way to the screen
   unless something converts it — `round(sum(...)::numeric)` comes back as
   "100733", and "100733" + 0 is a bug waiting for a total. */
const n = (v) => (v == null || v === '' ? null : Number(v));
const D3M = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ── Today ──────────────────────────────────────────────────────────────── */
async function today(deck, ctx) {
  skeleton(deck, 4);
  const [k, daily, status, unauth] = await Promise.all([
    q('/api/kpis').catch(() => null),
    q('/api/trips/daily').catch(() => []),
    api('/api/status').catch(() => []),
    q('/api/unauthorized/summary').catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!k) { failed(deck, new Error('The overview could not be fetched.')); return; }

  const series = (daily || []).map((d) => n(d.trips) || 0);
  const days = (daily || []).length;
  const perDay = days ? Math.round(series.reduce((a, b) => a + b, 0) / days) : 0;
  const last = series[series.length - 1] ?? 0;
  const prev = series[series.length - 2] ?? 0;
  const drift = prev ? Math.round(((last - prev) / prev) * 100) : 0;

  lede(deck, {
    claim: `${fmt(perDay)} bookings a day`,
    sub: `${fmt(k.trips)} over ${days || state.days} days, across ${fmt(k.drivers)} drivers and `
      + `${fmt(k.vehicles)} vehicles. The last full day ran ${drift >= 0 ? 'up' : 'down'} `
      + `${Math.abs(drift)}% on the one before it.`,
    tone: drift < -25 ? 'warn' : null,
  });

  const trend = card('Bookings a day', `${days} days in this window`);
  trend.body.append(spark(series, { h: 46 }));
  const foot = el('p', 'm-cap');
  foot.style.cssText = 'margin:8px 0 0;display:flex;justify-content:space-between';
  foot.append(el('span', null, dayStr((daily?.[0] || {}).d) || ''),
    el('span', null, dayStr((daily?.[days - 1] || {}).d) || ''));
  trend.body.append(foot);
  deck.append(trend.card);

  stats(deck, [
    { label: 'Bookings', value: fmt(k.trips), sub: `${fmt(perDay)} a day` },
    { label: 'Revenue', value: money(n(k.revenue)), sub: k.revenue ? 'fares on record' : 'none priced' },
    { label: 'Completed', value: `${n(k.completion_pct) ?? '—'}%`,
      sub: `${n(k.cancel_pct) ?? 0}% cancelled`,
      tone: n(k.completion_pct) >= 90 ? 'good' : n(k.completion_pct) >= 80 ? null : 'warn' },
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: `${n(k.avg_km) ?? '—'} km a trip` },
  ]);

  /* What needs a person, not a chart. A source that stopped and a car that
     moved with nobody's name on it are the two things worth a phone buzzing. */
  const bad = (status || []).filter((r) => r.status && r.status !== 'ok');
  const unauthN = (unauth?.byVerdict || []).find((v) => v.verdict === 'unauthorized')?.n;
  const attention = [];
  if (bad.length) {
    attention.push(row({
      title: `${bad.length} source${bad.length > 1 ? 's need' : ' needs'} attention`,
      sub: [...new Set(bad.map((b) => b.source))].join(', '),
      value: '›', to: href('sources'),
    }));
  }
  if (n(unauthN)) {
    attention.push(row({
      title: `${fmt(unauthN)} unauthorized trips`,
      sub: 'seat occupied, vehicle moved, no booking',
      value: '›', to: href('unauthorized'), tone: 'critical',
    }));
  }
  if (n(k.alerts)) {
    attention.push(row({
      title: `${fmt(k.alerts)} harsh-driving events`,
      sub: 'from the telematics layer', value: '›', to: href('safety'),
    }));
  }
  if (attention.length) {
    deck.append(el('p', 'm-sec', 'Needs attention'));
    rows(deck, attention);
  }

  deck.append(el('p', 'm-sec', 'Go to'));
  rows(deck, [
    row({ title: 'Live fleet', sub: 'where every car is now', value: '›', to: href('live') }),
    row({ title: 'People', sub: 'who drove, and how much', value: '›', to: href('people') }),
    row({ title: 'Money', sub: 'revenue and payment mix', value: '›', to: href('money') }),
  ]);
}

/* ── Money ──────────────────────────────────────────────────────────────── */
async function moneyScreen(deck, ctx) {
  skeleton(deck, 4);
  const [k, daily, settle, plats] = await Promise.all([
    q('/api/kpis').catch(() => null),
    q('/api/trips/daily').catch(() => []),
    q('/api/settlement/mix').catch(() => null),
    q('/api/platforms').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!k) { failed(deck, new Error('The money view could not be fetched.')); return; }

  const rev = (daily || []).map((d) => n(d.revenue) || 0);
  const total = n(k.revenue) || 0;
  const priced = (daily || []).reduce((a, d) => a + (n(d.priced_trips) || 0), 0);

  /* Cash in a driver's hand and a fare charged to a room are money the fleet
     has EARNED and does not HOLD. That distinction is the reason this screen
     exists on a phone, so it is the headline rather than a tile. */
  const cls = settle?.classes || [];
  const owed = cls.filter((c) => ['cash', 'on_account', 'salary'].includes(c.settlement_class))
    .reduce((a, c) => a + (n(c.trips) || 0), 0);
  const routed = cls.reduce((a, c) => a + (n(c.trips) || 0), 0);

  lede(deck, {
    claim: owed && routed
      ? `${Math.round((owed / routed) * 100)}% of bookings are still to be collected`
      : `${money(total)} on record`,
    sub: owed && routed
      ? `${fmt(owed)} of ${fmt(routed)} bookings settled into a driver's hand, onto a room, or `
        + `against salary. ${money(total)} is what the priced bookings came to.`
      : `Over ${fmt(k.trips)} bookings — ${total && priced ? money(Math.round(total / priced))
        : '\u2014'} a priced booking. Only the channels that report a fare are in this figure.`,
    tone: routed && owed / routed >= 0.3 ? 'warn' : null,
  });

  const c = card('Fares a day', priced
    ? `${fmt(priced)} of ${fmt(k.trips)} bookings carry a fare` : 'no booking carries a fare');
  c.body.append(spark(rev, { h: 46, tone: 'var(--s3)' }));
  deck.append(c.card);

  stats(deck, [
    { label: 'Fares on record', value: money(total) },
    { label: 'Per priced booking',
      value: total && priced ? money(Math.round(total / priced)) : '\u2014',
      sub: priced ? `${fmt(priced)} priced` : 'none priced' },
    { label: 'Per km', value: total && n(k.km) ? money(Math.round(total / n(k.km))) : '\u2014' },
    { label: 'Bookings', value: fmt(k.trips), sub: `${fmt(k.drivers)} drivers` },
  ]);

  if (cls.length) {
    const m = card('How fares settle', 'Every booking that records a settlement route');
    bars(m.body, cls.map((r) => ({ label: r.label || r.settlement_class, n: n(r.trips) })), { max: 6 });
    if (settle.unlabelled_trips) {
      const note = el('p', 'm-cap');
      note.style.cssText = 'margin:9px 0 0';
      note.textContent = `${fmt(settle.unlabelled_trips)} more record no route at all`
        + `${settle.unlabelled_platforms?.length ? ` (${settle.unlabelled_platforms.join(', ')})` : ''}`
        + ' — this card can say nothing about those.';
      m.body.append(note);
    }
    deck.append(m.card);
  }

  const pl = unwrap(plats).rows;
  if (pl.length) {
    deck.append(el('p', 'm-sec', 'By channel'));
    const byPlat = new Map();
    pl.forEach((p2) => {
      const cur = byPlat.get(p2.platform) || { trips: 0, fares: 0 };
      cur.trips += n(p2.window_bookings ?? p2.bookings ?? p2.trips) || 0;
      cur.fares += n(p2.fares) || 0;
      byPlat.set(p2.platform, cur);
    });
    const totalTrips = [...byPlat.values()].reduce((a, v) => a + v.trips, 0) || 1;
    rows(deck, [...byPlat.entries()].sort((a, b) => b[1].trips - a[1].trips).map(([name, v]) => row({
      title: name === 'fms' ? 'FMS telematics' : name[0].toUpperCase() + name.slice(1),
      sub: `${Math.round((v.trips / totalTrips) * 100)}% of bookings`,
      value: v.fares ? money(v.fares) : fmt(v.trips),
      note: v.fares ? 'fares' : 'bookings',
    })));
  }
}

/* ── People ─────────────────────────────────────────────────────────────── */
async function people(deck, ctx) {
  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  deck.append(bar);
  const list = el('div');
  deck.append(list);
  skeleton(list, 5);

  const board = unwrap(await q('/api/drivers/leaderboard').catch(() => []));
  if (!ctx.alive()) return;
  list.innerHTML = '';
  if (!board.rows.length) {
    empty(list, 'Nobody drove in this window', 'Widen the window from the \u22ee menu.');
    return;
  }

  /* No folding here. /api/drivers/leaderboard already answers per PERSON —
     `platforms` and `accounts` are how many channel identities that person
     holds — so folding again on this side would only be a second, worse copy
     of a rule the server already applies. */
  let sort = 'trips', term = '';
  const draw = () => {
    list.innerHTML = '';
    const shown = board.rows
      .filter((d) => !term || String(d.driver_name || d.person || '')
        .toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => (n(b[sort]) || 0) - (n(a[sort]) || 0));
    if (!shown.length) { empty(list, 'Nobody matches that', 'Try part of a name.'); return; }
    rows(list, shown.map((d) => row({
      title: d.driver_name || d.person || d.driver_ext_id,
      sub: `${(d.platforms || []).join(', ') || 'no channel'} \u00b7 ${fmt(d.km)} km`
        + (d.accounts > 1 ? ` \u00b7 ${d.accounts} accounts` : ''),
      value: sort === 'revenue' ? money(n(d.revenue)) : fmt(n(d[sort])),
      note: { trips: 'bookings', km: 'km', revenue: 'fares' }[sort],
      to: href('driver', d.driver_ext_id),
    })));
    if (!term) cut(list, board, 'people who drove');
  };
  search(bar, 'Search people', (v) => { term = v; draw(); });
  seg(bar, [{ id: 'trips', label: 'Bookings' }, { id: 'km', label: 'Distance' },
    { id: 'revenue', label: 'Fares' }], sort, (id) => { sort = id; draw(); });
  draw();
}

/* ── Fleet ──────────────────────────────────────────────────────────────── */
async function fleet(deck, ctx) {
  const bar = el('div');
  bar.style.cssText = 'display:flex;flex-direction:column;gap:10px';
  deck.append(bar);
  const list = el('div');
  deck.append(list);
  skeleton(list, 5);

  const [carsRaw, live] = await Promise.all([
    q('/api/vehicles').catch(() => []),
    api('/api/live').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  const cars = unwrap(carsRaw);
  list.innerHTML = '';
  if (!cars.rows.length) {
    empty(list, 'No vehicle worked in this window', 'Widen the window from the \u22ee menu.');
    return;
  }

  const pos = new Map((live || []).map((l) => [l.plate, l]));
  let sort = 'trips', term = '';
  const draw = () => {
    list.innerHTML = '';
    const key = (c) => (sort === 'trips' ? (c.trips ?? c.bookings) : c[sort]);
    const shown = cars.rows
      .filter((c) => !term || String(c.plate).toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => (n(key(b)) || 0) - (n(key(a)) || 0));
    if (!shown.length) { empty(list, 'No plate matches that', 'Try part of a plate.'); return; }
    rows(list, shown.map((c) => {
      const p = pos.get(c.plate);
      const where = p ? (p.stale ? 'stale fix'
        : (p.speed || 0) > 3 ? `moving ${Math.round(p.speed)} km/h` : 'stopped')
        : 'not reporting';
      return row({
        title: c.plate,
        sub: `${where}${c.current_driver ? ` \u00b7 ${c.current_driver}` : ''}`,
        value: sort === 'revenue' ? money(n(c.revenue)) : fmt(n(key(c))),
        note: { trips: 'bookings', km: 'km', revenue: 'fares' }[sort],
        to: href('vehicle', c.plate),
      });
    }));
    if (!term) cut(list, cars, 'vehicles');
  };
  search(bar, 'Search plates', (v) => { term = v; draw(); });
  seg(bar, [{ id: 'trips', label: 'Bookings' }, { id: 'km', label: 'Distance' },
    { id: 'revenue', label: 'Fares' }], sort, (id) => { sort = id; draw(); });
  draw();
}

/* ── Live ───────────────────────────────────────────────────────────────── */
async function live(deck, ctx) {
  skeleton(deck, 4);
  const feed = await api('/api/live').catch(() => null);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!feed) { failed(deck, new Error('The live feed could not be fetched.')); return; }
  if (!feed.length) { empty(deck, 'No vehicle is reporting', 'The telematics collector may be behind.'); return; }

  const moving = feed.filter((v) => (v.speed || 0) > 3).length;
  const busy = feed.filter((v) => v.seat_occupied).length;
  const stale = feed.filter((v) => v.stale).length;
  stats(deck, [
    { label: 'Reporting', value: fmt(feed.length) },
    { label: 'Moving', value: fmt(moving), sub: 'above 3 km/h' },
    { label: 'Occupied', value: fmt(busy), sub: 'seat sensor' },
    { label: 'Stale fix', value: fmt(stale), sub: 'no recent position', tone: stale ? 'warn' : 'good' },
  ]);

  deck.append(el('p', 'm-sec', 'Every vehicle'));
  rows(deck, [...feed]
    .sort((a, b) => (b.speed || 0) - (a.speed || 0))
    .map((v) => row({
      title: v.plate,
      sub: `${v.source || 'feed'} · ${v.seat_occupied ? 'occupied' : 'empty'}`
        + (v.polled_at ? ` · ${new Date(v.polled_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''),
      value: v.stale ? 'stale' : (v.speed || 0) > 3 ? `${Math.round(v.speed)}` : 'stopped',
      note: v.stale ? '' : (v.speed || 0) > 3 ? 'km/h' : '',
      tone: v.stale ? 'warn' : null,
      to: href('vehicle', v.plate),
    })));
}

/* ── Safety and unauthorized ────────────────────────────────────────────── */
async function safety(deck, ctx) {
  skeleton(deck, 3);
  const [sum, byVehRaw] = await Promise.all([
    q('/api/alerts/summary').catch(() => []),
    q('/api/alerts/by-vehicle').catch(() => []),
  ]);
  const byVeh = unwrap(byVehRaw);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  const total = (sum || []).reduce((a, r) => a + (n(r.n) || 0), 0);
  if (!total) { empty(deck, 'No harsh-driving event in this window', 'Nothing to review.'); return; }
  lede(deck, { claim: `${fmt(total)} harsh-driving events`,
    sub: 'Recorded by the telematics layer. A count on its own says more about how far a car drove than how it was driven.' });
  const c = card('By kind', null);
  bars(c.body, (sum || []).map((r) => ({ label: r.alert_type, n: n(r.n) })), { max: 8 });
  deck.append(c.card);
  if (byVeh.rows.length) {
    deck.append(el('p', 'm-sec', 'By vehicle'));
    rows(deck, byVeh.rows.map((r) => row({
      title: r.plate,
      sub: [r.harsh_brake && `${r.harsh_brake} brake`, r.harsh_accel && `${r.harsh_accel} accel`,
        r.sharp_turn && `${r.sharp_turn} turn`].filter(Boolean).join(' \u00b7 ') || 'events recorded',
      value: fmt(n(r.alerts ?? r.n)), note: 'events', to: href('vehicle', r.plate),
    })));
    cut(deck, byVeh, 'vehicles with an event');
  }
}

async function unauthorized(deck, ctx) {
  skeleton(deck, 3);
  const [sum, listRaw] = await Promise.all([
    q('/api/unauthorized/summary').catch(() => null),
    q('/api/unauthorized/list').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!sum) { failed(deck, new Error('Unauthorized movement could not be fetched.')); return; }
  const v = Object.fromEntries((sum.byVerdict || []).map((r) => [r.verdict, r]));
  lede(deck, {
    claim: `${fmt(v.unauthorized?.n || 0)} trips with nobody's name on them`,
    sub: 'The seat was occupied and the vehicle moved, but no channel recorded a booking.',
    tone: (v.unauthorized?.n || 0) > 0 ? 'bad' : 'good',
  });
  stats(deck, ['unauthorized', 'partial', 'authorized', 'sensor_suspect'].map((key) => v[key] && ({
    label: key.replace('_', ' '),
    value: fmt(v[key].n),
    sub: `${fmt(v[key].km)} km`,
    tone: key === 'unauthorized' ? 'bad' : key === 'authorized' ? 'good' : null,
  })).filter(Boolean));
  /* The window asked for is not the window answered: this measurement needs a
     seat sensor AND a telematics journey, and only the days carrying both can
     be judged. Saying "21 trips in 30 days" over three days of evidence would
     be the most misleading sentence on the phone. */
  const cov = sum.coverage;
  if (cov && cov.complete === false) {
    const c2 = el('div', 'm-stale');
    c2.textContent = `Only ${cov.days_with_data} of the ${cov.days_in_window} days in this `
      + 'window carry both a seat sensor and a journey, so this is over those days.';
    deck.append(c2);
  }
  const items = unwrap(listRaw).rows;
  if (items.length) {
    deck.append(el('p', 'm-sec', 'Every one of them'));
    rows(deck, items.slice(0, 40).map((r) => row({
      title: r.plate || '—',
      sub: `${r.driver_name || 'no driver'}${r.started_at ? ` · ${dayStr(r.started_at)}` : ''}`,
      value: r.distance_km != null ? `${n(r.distance_km)}` : '',
      note: r.distance_km != null ? 'km' : '',
      to: href('vehicle', r.plate),
    })));
  }
}

/* ── Sources ────────────────────────────────────────────────────────────── */
async function sources(deck, ctx) {
  skeleton(deck, 3);
  const st = await api('/api/status').catch(() => null);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!st) { failed(deck, new Error('Collector status could not be fetched.')); return; }
  const latest = new Map();
  for (const r of st) {
    const k = `${r.source}|${r.fleet_id || ''}`;
    if (!latest.has(k) || (r.finished_at || '') > (latest.get(k).finished_at || '')) latest.set(k, r);
  }
  const all = [...latest.values()].sort((a, b) => String(a.source).localeCompare(String(b.source)));
  const bad = all.filter((r) => r.status !== 'ok');
  lede(deck, {
    claim: bad.length ? `${bad.length} of ${all.length} collectors need attention`
      : `All ${all.length} collectors are healthy`,
    sub: bad.length ? 'A source that stops does not empty the dashboard — it freezes it, which looks the same as a quiet week.'
      : 'Every source finished its last run without an error.',
    tone: bad.length ? 'warn' : 'good',
  });
  rows(deck, all.map((r) => row({
    title: r.source + (r.fleet_id ? ` · ${r.fleet_id}` : ''),
    sub: r.error ? String(r.error).slice(0, 70)
      : `${r.mode || 'run'} · ${r.finished_at ? new Date(r.finished_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'never'}`,
    value: r.status === 'ok' ? 'ok' : r.status,
    note: `${fmt(r.rows_written)} rows`,
    tone: r.status === 'ok' ? 'good' : r.status === 'partial' ? 'warn' : 'critical',
  })));
}

/* ── More ───────────────────────────────────────────────────────────────── */
async function more(deck) {
  deck.append(el('p', 'm-sec', 'Analyse'));
  rows(deck, [
    row({ title: 'Optimise', sub: 'where the next trip is', value: '›', to: href('optimise') }),
    row({ title: 'Corporate', sub: 'the hotel channel', value: '›', to: href('corporate') }),
    row({ title: 'Analyst', sub: 'claims the data was asked to settle', value: '›', to: href('analyst') }),
  ]);
  deck.append(el('p', 'm-sec', 'Operate'));
  rows(deck, [
    row({ title: 'Live fleet', sub: 'positions now', value: '›', to: href('live') }),
    row({ title: 'Safety', sub: 'harsh-driving events', value: '›', to: href('safety') }),
    row({ title: 'Unauthorized trips', sub: 'moved with no booking', value: '›', to: href('unauthorized') }),
    row({ title: 'Data sources', sub: 'collector health', value: '›', to: href('sources') }),
    row({ title: 'Paste a credential', sub: 'read, tested, then stored', value: '›', to: href('credentials') }),
  ]);
  deck.append(el('p', 'm-sec', 'On the desktop'));
  rows(deck, ['insights', 'compliance', 'demand', 'map', 'settings'].map((v) => row({
    title: { insights: 'Action list', compliance: 'Compliance', demand: 'Demand',
      map: 'Map & replay', settings: 'Settings' }[v],
    sub: 'built for a bigger screen', value: '›', to: href(v),
  })));

  const c = card('This app', null);
  const p = el('p', 'm-cap');
  p.style.margin = '0';
  p.innerHTML = 'Installed from the browser menu — <b>Add to Home Screen</b>. It keeps the last '
    + 'numbers it saw, so it opens with something to read even with no signal.';
  c.body.append(p);
  const b = el('button', 'm-chip');
  b.type = 'button'; b.textContent = 'Open the desktop version';
  b.style.marginTop = '10px';
  b.onclick = () => { location.href = `/?ui=desktop${location.hash}`; };
  c.body.append(b);
  deck.append(c.card);
}

/* ── driver ─────────────────────────────────────────────────────────────
   One person, everything about them, in the order a phone is read in: who
   they are, how they are doing against the fleet, then the detail. The
   standing block is the part a desktop table buries — a percentile answers
   "is 268 trips good?", which the number alone never does. */
async function driver(deck, ctx) {
  const id = ctx.param;
  skeleton(deck, 4);
  const [profile, kpis, daily, standing, alerts] = await Promise.all([
    qAll('/api/driver/profile', { id }).catch(() => null),
    qAll('/api/driver/kpis', { id }).catch(() => null),
    qAll('/api/driver/daily', { id }).catch(() => []),
    qAll('/api/driver/standing', { id }).catch(() => null),
    qAll('/api/alerts/by-driver', { id }).catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!profile) { failed(deck, new Error('Nothing in the record matches this id.')); return; }

  const k = kpis || {};
  ctx.setTitle(profile.name || id, `${fmt(k.trips)} bookings in this window`);
  lede(deck, {
    claim: profile.name || id,
    sub: `${(profile.platforms || []).join(', ') || 'no channel'}`
      + `${profile.span?.days_worked ? ` \u00b7 ${profile.span.days_worked} days worked` : ''}`
      + `${(profile.ids || []).length > 1 ? ` \u00b7 ${profile.ids.length} platform accounts` : ''}`,
  });

  stats(deck, [
    { label: 'Bookings', value: fmt(k.trips), sub: k.days_worked ? `${k.days_worked} days worked` : null },
    { label: 'Fares', value: money(n(k.revenue)), sub: k.avg_fare ? `${money(n(k.avg_fare))} a booking` : null },
    { label: 'Completed', value: k.completion_pct != null ? `${n(k.completion_pct)}%` : '\u2014',
      sub: k.not_completed != null ? `${fmt(k.not_completed)} did not` : null,
      tone: n(k.completion_pct) >= 90 ? 'good' : n(k.completion_pct) >= 80 ? null : 'warn' },
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: k.avg_km ? `${n(k.avg_km)} km a booking` : null },
  ]);

  const series = (daily || []).map((d) => n(d.trips) || 0);
  if (series.length > 1) {
    const c = card('Bookings a day', `${series.length} days in this window`);
    c.body.append(spark(series, { h: 44 }));
    deck.append(c.card);
  }

  /* Against the fleet, not against nothing. */
  if (standing?.metrics?.length) {
    deck.append(el('p', 'm-sec', `Against the other ${fmt(standing.n_peers)} who drove`));
    rows(deck, standing.metrics.slice(0, 6).map((m) => row({
      title: m.label,
      sub: m.median != null ? `fleet median ${fmt(m.median)}` : null,
      value: fmt(m.value),
      /* "top 76%" is not a compliment and not an insult; it is a number
         facing the wrong way, so below the median it is said as a bottom. And
         the best in the fleet came out as "top 0%", which is not a share of
         anything — at the very top the honest phrasing names the rank. */
      note: m.percentile == null ? null
        : m.percentile >= 100 ? 'highest in the fleet'
          : m.percentile <= 0 ? 'lowest in the fleet'
            : m.percentile >= 50 ? `top ${100 - m.percentile}%` : `bottom ${m.percentile}%`,
      tone: m.percentile >= 75 ? 'good' : m.percentile <= 25 ? 'warn' : null,
    })));
  }

  const alertRows = unwrap(alerts).rows;
  if (alertRows.length) {
    deck.append(el('p', 'm-sec', 'Harsh-driving events'));
    rows(deck, alertRows.slice(0, 6).map((r) => row({
      title: r.alert_type || r.plate || 'event',
      sub: r.plate && r.alert_type ? r.plate : null,
      value: fmt(n(r.n ?? r.alerts)), note: 'events',
    })));
  }

  deck.append(el('p', 'm-sec', 'More'));
  rows(deck, [
    row({ title: 'Their bookings', sub: 'every trip, on the desktop', value: '\u203a',
      to: `#driver/${encodeURIComponent(id)}/trips` }),
    row({ title: 'Their vehicles', sub: 'custody, on the desktop', value: '\u203a',
      to: `#driver/${encodeURIComponent(id)}/activity` }),
  ]);
}

/* ── vehicle ────────────────────────────────────────────────────────────── */
async function vehicle(deck, ctx) {
  const plate = ctx.param;
  skeleton(deck, 4);
  const [profile, kpis, daily, drivers, safe] = await Promise.all([
    qAll('/api/vehicle/profile', { plate }).catch(() => null),
    qAll('/api/vehicle/kpis', { plate }).catch(() => null),
    qAll('/api/vehicle/daily', { plate }).catch(() => []),
    qAll('/api/vehicle/drivers', { plate }).catch(() => []),
    qAll('/api/vehicle/safety', { plate }).catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!profile) { failed(deck, new Error('No vehicle in the record carries this plate.')); return; }

  const k = kpis || {}, spec = profile.spec || {};
  ctx.setTitle(plate, [spec.make, spec.model].filter(Boolean).join(' ') || 'vehicle');
  lede(deck, {
    claim: plate,
    sub: [spec.year, spec.make, spec.model].filter(Boolean).join(' ')
      + (spec.colour ? ` \u00b7 ${spec.colour}` : '')
      + (spec.compliance_status ? ` \u00b7 ${spec.compliance_status.toLowerCase()}` : ''),
    tone: spec.compliance_status && spec.compliance_status !== 'ACTIVE' ? 'warn' : null,
  });

  stats(deck, [
    { label: 'Bookings', value: fmt(k.trips), sub: k.days_worked ? `${k.days_worked} days worked` : null },
    { label: 'Fares', value: money(n(k.revenue)), sub: k.avg_fare ? `${money(n(k.avg_fare))} a booking` : null },
    { label: 'Distance', value: `${fmt(k.km)} km`, sub: k.avg_km ? `${n(k.avg_km)} km a booking` : null },
    { label: 'Drivers', value: fmt(k.attributed_drivers ?? unwrap(drivers).total),
      sub: 'held this car' },
  ]);

  const series = (daily || []).map((d) => n(d.trips) || 0);
  if (series.length > 1) {
    const c = card('Bookings a day', `${series.length} days in this window`);
    c.body.append(spark(series, { h: 44 }));
    deck.append(c.card);
  }

  if (safe?.by_type?.length) {
    const c = card('Harsh-driving events', 'A count says more about how far this car drove than how it was driven.');
    bars(c.body, safe.by_type.map((r) => ({ label: r.alert_type, n: n(r.n) })), { max: 6 });
    deck.append(c.card);
  }

  const dr = unwrap(drivers).rows;
  if (dr.length) {
    deck.append(el('p', 'm-sec', 'Who drove it'));
    rows(deck, dr.slice(0, 10).map((r) => row({
      title: r.driver_name || r.driver_ext_id || '\u2014',
      sub: r.days ? `${fmt(r.days)} days` : null,
      value: fmt(n(r.trips)), note: 'bookings',
      to: r.driver_ext_id ? href('driver', r.driver_ext_id) : null,
    })));
  }

  deck.append(el('p', 'm-sec', 'More'));
  rows(deck, [
    row({ title: 'Where it went', sub: 'movement and replay, on the desktop', value: '\u203a',
      to: `#vehicle/${encodeURIComponent(plate)}/movement` }),
    row({ title: 'Its documents', sub: 'compliance, on the desktop', value: '\u203a',
      to: `#vehicle/${encodeURIComponent(plate)}/compliance` }),
  ]);
}

/* ── corporate ──────────────────────────────────────────────────────────── */
async function corporate(deck, ctx) {
  skeleton(deck, 4);
  const [sum, props] = await Promise.all([
    q('/api/corporate/summary').catch(() => null),
    q('/api/corporate/properties').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!sum || !sum.bookings) {
    empty(deck, 'No hotel booking in this window', 'Widen the window from the \u22ee menu.');
    return;
  }
  const margin = sum.has_cost && sum.revenue ? Math.round(((sum.revenue - sum.cost) / sum.revenue) * 100) : null;
  lede(deck, {
    claim: `${money(n(sum.revenue))} from ${fmt(sum.bookings)} hotel bookings`,
    sub: margin != null
      ? `${money(n(sum.cost))} of that is what the driver was paid, leaving ${margin}%.`
      : 'The channel reports a fare but no cost, so no margin can be taken from it.',
  });
  stats(deck, [
    { label: 'Average fare', value: money(n(sum.avg_fare)) },
    { label: 'Per km', value: sum.revenue_per_km ? money(n(sum.revenue_per_km)) : '\u2014' },
    { label: 'Unpaid approach', value: sum.deadhead_km != null ? `${fmt(sum.deadhead_km)} km` : '\u2014',
      sub: sum.deadhead_ratio_pct != null ? `${n(sum.deadhead_ratio_pct)}% of the driving` : null,
      tone: n(sum.deadhead_ratio_pct) > 20 ? 'warn' : null },
    { label: 'Free of charge', value: fmt(sum.foc_trips ?? sum.foc ?? 0), sub: 'billed to nobody' },
  ]);
  const rowsIn = unwrap(props);
  if (rowsIn.rows.length) {
    deck.append(el('p', 'm-sec', 'By property'));
    rows(deck, rowsIn.rows.map((r) => row({
      title: r.name || r.partner_id,
      sub: `${fmt(r.bookings)} bookings \u00b7 ${money(n(r.avg_fare))} average`,
      value: money(n(r.revenue)), note: 'fares',
      to: r.partner_id ? href('property', r.partner_id) : null,
    })));
    cut(deck, rowsIn, 'properties');
  }
}

/* ── analyst ────────────────────────────────────────────────────────────── */
async function analyst(deck, ctx) {
  skeleton(deck, 3);
  const d = await q('/api/analyst/findings').catch(() => null);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!d) { failed(deck, new Error('The analyst could not be reached.')); return; }
  if (!d.runs) {
    empty(deck, 'The analyst has not run yet', 'Nothing has been proposed or tested on this fleet.');
    return;
  }
  lede(deck, {
    claim: `${fmt(d.confirmed)} of ${fmt(d.confirmed + d.refuted + d.immaterial + d.unsupported)} claims held up`,
    sub: `Across ${fmt(d.runs)} passes. A claim the data refuses is as much of an answer as one it `
      + 'supports, so the refuted and the immaterial are kept rather than discarded.',
    tone: d.confirmed ? null : 'warn',
  });
  stats(deck, [
    { label: 'Confirmed', value: fmt(d.confirmed), tone: 'good' },
    { label: 'Refuted', value: fmt(d.refuted) },
    { label: 'Immaterial', value: fmt(d.immaterial) },
    { label: 'Unsupported', value: fmt(d.unsupported), tone: d.unsupported ? 'warn' : null },
  ]);
  const found = d.findings || [];
  if (found.length) {
    deck.append(el('p', 'm-sec', 'What it found'));
    found.slice(0, 12).forEach((f) => {
      const c = card(null, null);
      c.card.classList.add('m-finding');
      const b = el('b', null, esc(f.claim || ''));
      b.style.cssText = 'display:block;font-size:.92rem;line-height:1.35;margin-bottom:5px';
      const tag = el('span', 'm-chip');
      tag.textContent = f.verdict || '';
      tag.style.cssText = 'font-size:.66rem;padding:3px 9px;'
        + `color:var(--${f.verdict === 'confirmed' ? 'good' : f.verdict === 'refuted' ? 'critical' : 'ink-3'})`;
      c.body.append(b, tag);
      deck.append(c.card);
    });
  }
  if (d.last_run) {
    const p = el('p', 'm-cap');
    p.style.cssText = 'margin:4px 2px 0;text-align:center';
    p.textContent = `Last pass ${new Date(d.last_run).toLocaleString()}`
      + (d.model ? ` \u00b7 ${d.model}` : '');
    deck.append(p);
  }
}

/* ── paste a credential ─────────────────────────────────────────────────
   On a phone this is not a devtools workflow — it is the one where somebody
   sends you a token and you want it in before the collector's next tick,
   standing somewhere that is not a desk. Same endpoint as the desktop panel,
   same rule: nothing is stored until the provider has accepted it. */
async function credentials(deck, ctx) {
  const c = card('Paste a credential',
    'A cookie jar, a token, or a whole curl command. It is tried against the provider before anything is stored.');
  deck.append(c.card);

  const ta = el('textarea');
  ta.rows = 6;
  ta.placeholder = 'Paste here — several at once is fine, separated by a blank line.';
  ta.style.cssText = 'width:100%;background:var(--surface-2);border:1px solid var(--rule);'
    + "border-radius:11px;padding:11px 12px;font-family:'IBM Plex Mono',monospace;font-size:.76rem;"
    + 'line-height:1.5;resize:vertical;color:var(--ink);-webkit-appearance:none';
  c.body.append(ta);

  const btn = el('button', 'm-chip');
  btn.type = 'button';
  btn.textContent = 'Read and test';
  btn.style.cssText = 'margin-top:10px;min-height:40px;padding:9px 16px';
  c.body.append(btn);

  const out = el('div');
  deck.append(out);

  const post = async (apply) => {
    const text = ta.value.trim();
    if (text.length < 20) return;
    btn.disabled = true;
    btn.textContent = apply ? 'Applying…' : 'Asking each provider…';
    out.innerHTML = '';
    let d;
    try {
      d = await api('/api/settings/paste', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, apply }),
      });
    } catch (e) {
      btn.disabled = false; btn.textContent = 'Read and test';
      failed(out, e);
      return;
    }
    if (!ctx.alive()) return;
    btn.disabled = false; btn.textContent = 'Read and test';
    out.innerHTML = '';
    if (!d.proposals.length) {
      empty(out, 'Nothing recognised', 'No part of that looked like a credential this dashboard stores.');
      return;
    }
    rows(out, d.proposals.map((r) => row({
      title: r.key || 'could not be named',
      sub: `${r.provider}${r.fleet ? ` \u00b7 ${r.fleet}` : ''} \u00b7 ${r.detail || r.why || ''}`,
      value: r.verdict === 'pass' ? 'accepted' : r.verdict === 'unknown' ? 'no answer' : 'refused',
      tone: r.verdict === 'pass' ? 'good' : r.verdict === 'unknown' ? 'warn' : 'critical',
    })));
    const good = d.proposals.filter((r) => r.verdict === 'pass');
    if (d.applied?.length) {
      out.append(el('div', 'm-stale', `Stored ${d.applied.join(', ')} — live on the collector's next tick.`));
    } else if (good.length) {
      const go = el('button', 'm-chip');
      go.type = 'button';
      go.textContent = `Apply the ${good.length} that were accepted`;
      go.style.cssText = 'margin-top:12px;min-height:40px;padding:9px 16px';
      go.onclick = () => post(true);
      const wrap = el('div');
      wrap.style.cssText = 'display:flex;justify-content:center';
      wrap.append(go);
      out.append(wrap);
    }
  };
  btn.onclick = () => post(false);
}

/* ── the fallback ───────────────────────────────────────────────────────
   A route this app has no screen for still has to resolve: an address someone
   sent to a phone must not dead-end. A driver or vehicle SUB-page renders the
   real desktop module, which exports its renderer and is styled by app.css;
   the rest are pages built around a wide table, and the honest answer for
   those is the desktop build, one tap away and returning to this address. */
/* ── Optimise ───────────────────────────────────────────────── */
/* The desktop leads with a 168-cell heatmap. A phone cannot read one, and the
   person holding the phone is usually deciding one thing: where to be in the
   next hour. So the same two measurements arrive as two ranked lists — the
   hours worth being out for, and the place-hours where cars sit — with the
   week's own numbers, not a shrunken grid. */
async function optimise(deck, ctx) {
  skeleton(deck, 4);
  const [opt, bal] = await Promise.all([
    q('/api/optimise').catch((e) => ({ error: e.message })),
    q('/api/supply/balance').catch(() => null),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (opt?.error) { failed(deck, new Error(opt.error)); return; }

  /* A balance cell is PER OCCURRENCE of its weekday, not the window's total —
     see the desktop page for why. Rates and rankings use the cell; every
     absolute hour count comes from the route's totals. */
  const cells = (bal?.cells || []).filter((c) => n(c.online_h) > 5);
  const occ = (c) => n(c.occurrences) || 1;
  const T = bal?.totals || null;
  const onlineH = T ? n(T.online_h) : cells.reduce((a, c) => a + (n(c.online_h) || 0) * occ(c), 0);
  const jobH = T ? n(T.on_job_h) : cells.reduce((a, c) => a + (n(c.on_job_h) || 0) * occ(c), 0);
  const idlePct = T && T.idle_pct != null ? Math.round(n(T.idle_pct))
    : (onlineH ? Math.round(((onlineH - jobH) / onlineH) * 100) : null);
  const rated = [...cells].sort((a, b) => n(b.jobs_per_online_h) - n(a.jobs_per_online_h));
  const sorted = rated.map((c) => n(c.jobs_per_online_h)).sort((a, b) => a - b);
  const med = sorted.length
    ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2)
    : null;
  const upside = med == null ? 0
    : cells.filter((c) => n(c.jobs_per_online_h) < med)
      .reduce((a, c) => a + (med - n(c.jobs_per_online_h)) * n(c.online_h) * occ(c), 0);

  lede(deck, {
    claim: idlePct != null ? `${idlePct}% of paid hours are idle`
      : 'Availability is not being collected yet',
    sub: idlePct != null
      ? `${fmt(Math.round(jobH))} of ${fmt(Math.round(onlineH))} online hours went on a job. `
        + `Median ${opt.median_wait_overall ?? '\u2014'} min between one job and the next.`
      : 'Idle time cannot be separated from time off until the availability collector writes.',
    tone: idlePct >= 70 ? 'warn' : null,
  });

  stats(deck, [
    { label: 'Idle hours', value: `${fmt(opt.idle_h_between_jobs)} h`,
      sub: `over ${fmt(opt.handovers)} handovers`, tone: 'warn' },
    { label: 'Median wait',
      value: opt.median_wait_overall != null ? `${opt.median_wait_overall} min` : '\u2014',
      sub: 'drop-off to next pick-up' },
    { label: 'Extra trips', value: upside ? `+${fmt(Math.round(upside))}` : '\u2014',
      sub: 'a month, at the fleet median', tone: upside ? 'good' : null },
  ], true);

  const body = el('div');
  const bar = el('div');
  deck.append(bar, body);

  const hours = () => {
    body.innerHTML = '';
    if (!rated.length) {
      empty(body, 'No hour carries enough online time to rank',
        'Availability has to be collected before an hour can be judged.');
      return;
    }
    const c = card('Worth being out for',
      'Jobs won per hour online — a rate, so a thin Tuesday with two drivers can out-rank '
      + 'a busy Friday with twenty.');
    body.append(c.card);
    rows(c.body, rated.slice(0, 12).map((r) => ({
      title: `${D3M[r.dow]} ${String(r.h).padStart(2, '0')}:00`,
      sub: `${fmt(Math.round(n(r.online_h)))} online h · ${fmt(n(r.jobs))} `
        + `${n(r.jobs) === 1 ? 'job' : 'jobs'}`,
      value: n(r.jobs_per_online_h).toFixed(2),
      note: 'per online h',
      tone: med != null && n(r.jobs_per_online_h) >= med ? 'good' : null,
    })));
    if (med != null) {
      c.body.append(el('p', 'm-cap',
        `Fleet median ${med.toFixed(2)}. Every hour above it is the fleet proving to itself `
        + 'what the hours below it could do.'));
    }
    const worst = [...rated].reverse().slice(0, 6);
    const w = card('Hours that do not pay for themselves',
      'Same rate, the other end. These are the hours to move drivers OFF, not to staff harder.');
    body.append(w.card);
    rows(w.body, worst.map((r) => ({
      title: `${D3M[r.dow]} ${String(r.h).padStart(2, '0')}:00`,
      sub: `${fmt(Math.round(n(r.online_h)))} online h · ${fmt(n(r.jobs))} `
        + `${n(r.jobs) === 1 ? 'job' : 'jobs'}`,
      value: n(r.jobs_per_online_h).toFixed(2),
      note: 'per online h',
      tone: 'bad',
    })));
  };

  const places = () => {
    body.innerHTML = '';
    const waits = opt.waits || [];
    if (!waits.length) {
      empty(body, 'No vehicle completed two bookings here',
        'A wait needs a drop-off and the same plate picking up again.');
      return;
    }
    const top = waits.slice(0, 15);
    const c = card('Where the cars are standing',
      'Each vehicle followed from one drop-off to its next pick-up. This counts a CAR, not an '
      + 'address, so two providers writing one place two ways cannot distort it.');
    body.append(c.card);
    rows(c.body, top.map((r) => ({
      title: (r.area || 'Unnamed area')
        + (r.charging_site
          ? (r.charging_site === r.area ? ' \u00b7 charger' : ` \u00b7 charger at ${r.charging_site}`)
          : ''),
      sub: `${D3M[r.dow]} ${String(r.h).padStart(2, '0')}:00 · ${fmt(n(r.handovers))} `
        + `${n(r.handovers) === 1 ? 'handover' : 'handovers'}`,
      value: `${fmt(Math.round(n(r.idle_h)))} h`,
      note: `${fmt(n(r.median_wait_min))} min median`,
      tone: 'warn',
    })));
    const idle = top.reduce((a, r) => a + (n(r.idle_h) || 0), 0);
    c.body.append(el('p', 'm-cap',
      `These ${top.length} place-hours hold ${fmt(Math.round(idle))} of the fleet's `
      + `${fmt(opt.idle_h_between_jobs)} idle hours — `
      + `${Math.round((idle / Math.max(1, n(opt.idle_h_between_jobs))) * 100)}% of all the waiting, `
      + `in ${top.length} cells of a 168-cell week`
      + (opt.totals?.waits > top.length
        ? `, out of ${fmt(opt.totals.waits)} that had a measurable wait.` : '.')));
    if ((opt.charging_sites || []).length) {
      c.body.append(el('p', 'm-cap',
        `${opt.charging_sites.join(' and ')} hold charging stations. `
        + `${opt.idle_h_at_charging_sites != null ? `${fmt(opt.idle_h_at_charging_sites)} idle hours ` : 'Some idle time '}`
        + `${opt.idle_h_charging_pct != null ? `(${opt.idle_h_charging_pct}%) ` : ''}`
        + 'sit in an area with one, so that time mixes waiting with refuelling. '
        + 'It matches the address, not a plug — treat it as an upper bound.'
        + ((opt.charging_aliases || []).length
          ? ` ${opt.charging_aliases.map((a) => `${a.site} is written `
            + `${a.written.map((x) => `\u201c${x}\u201d`).join(' and ')}`).join('; ')}.`
          : '')));
    }
    if (opt.empty_arrival_pct != null) {
      c.body.append(el('p', 'm-cap',
        `Separately, ${opt.empty_arrival_pct}% of placeable bookings began in an area where no car `
        + 'had finished a trip in the hour before.'));
    }
  };

  let tab = 'hours';
  seg(bar, [{ id: 'hours', label: 'When' }, { id: 'places', label: 'Where' }], tab, (id) => {
    tab = id;
    (id === 'hours' ? hours : places)();
  });
  hours();
}

async function fallback(deck, ctx) {
  const { view, param, sub } = ctx;
  const box = el('div', 'm-fallback');
  deck.append(box);
  if ((view === 'driver' || view === 'vehicle') && param) {
    skeleton(box, 3);
    try {
      const mod = view === 'driver' ? await import('../driver.js') : await import('../vehicle.js');
      if (!ctx.alive()) return;
      box.innerHTML = '';
      await (view === 'driver'
        ? mod.renderDriver(box, param, sub || 'overview')
        : mod.renderVehicle(box, param, sub || 'overview'));
    } catch (e) {
      if (!ctx.alive()) return;
      box.innerHTML = '';
      failed(box, e);
    }
    return;
  }
  empty(box, 'Built for a bigger screen',
    'This view is a wide table, and squeezing it onto a phone would lose the row you are reading.');
  const b = el('button', 'm-chip');
  b.type = 'button';
  b.textContent = 'Open it on the desktop version';
  b.onclick = () => { location.href = `/?ui=desktop#${[view, param, sub].filter(Boolean).join('/')}`; };
  const wrap = el('div');
  wrap.style.cssText = 'display:flex;justify-content:center';
  wrap.append(b);
  deck.append(wrap);
}

export const SCREENS = {
  today, money: moneyScreen, people, fleet, live, safety, unauthorized, sources, more,
  corporate, analyst, credentials, optimise, fallback,
  /* A driver or vehicle with no sub-page gets the phone screen; a sub-page
     (`#driver/x/earnings`) is a desktop tab and goes to the fallback, which
     renders the real module. Decided in render() rather than here, because a
     route table cannot see whether `sub` is set. */
  driver, vehicle,
  /* The desktop's own addresses, so a link that predates this app still lands
     somewhere sensible rather than on the fallback. */
  overview: today, drivers: people, vehicles: fleet, finance: moneyScreen,
  unit: moneyScreen, settlement: moneyScreen, revenue: moneyScreen,
};
