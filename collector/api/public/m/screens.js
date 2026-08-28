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
import { state, q, api, href } from '../data.js';
import { el, money, fmt, dayStr, card, lede, stats, rows, row,
  seg, search, skeleton, empty, failed, spark, bars } from './ui.js';

export const TABS = [
  { id: 'today', route: 'today', label: 'Today', ic: '◱', owns: ['today', 'overview', 'demand'] },
  { id: 'money', route: 'money', label: 'Money', ic: '◈', owns: ['money', 'finance', 'platforms'] },
  { id: 'people', route: 'people', label: 'People', ic: '◧', owns: ['people', 'drivers', 'driver'] },
  { id: 'fleet', route: 'fleet', label: 'Fleet', ic: '▤', owns: ['fleet', 'vehicles', 'vehicle'] },
  { id: 'more', route: 'more', label: 'More', ic: '⋯',
    owns: ['more', 'live', 'map', 'safety', 'unauthorized', 'insights', 'compliance', 'sources', 'settings'] },
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
  const [k, daily, mix, plats] = await Promise.all([
    q('/api/kpis').catch(() => null),
    q('/api/trips/daily').catch(() => []),
    q('/api/mix', { by: 'payment' }).catch(() => []),
    q('/api/platforms').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  if (!k) { failed(deck, new Error('The money view could not be fetched.')); return; }

  const rev = (daily || []).map((d) => n(d.revenue) || 0);
  const total = n(k.revenue) || 0;
  const priced = rev.filter(Boolean).length;

  lede(deck, {
    claim: `${money(total)} on record`,
    sub: `Over ${fmt(k.trips)} bookings — ${total && k.trips
      ? money(Math.round(total / k.trips)) : '—'} a booking. Only the channels that report a `
      + 'fare are in this figure; the rest arrive as platform statements.',
  });

  const c = card('Fares a day', `${priced} of ${rev.length} days carry a fare`);
  c.body.append(spark(rev, { h: 46, tone: 'var(--s3)' }));
  deck.append(c.card);

  stats(deck, [
    { label: 'Total fares', value: money(total) },
    { label: 'Per booking', value: total && k.trips ? money(Math.round(total / k.trips)) : '—' },
    { label: 'Per km', value: total && n(k.km) ? money(Math.round(total / n(k.km))) : '—' },
    { label: 'Bookings', value: fmt(k.trips), sub: `${fmt(k.drivers)} drivers` },
  ]);

  if (mix?.length) {
    /* /api/mix?by=payment groups on payment_type — the card said "what was
       booked" over a list reading cash, apple_pay, braintree. */
    const m = card('How fares were settled', 'Payment type, by booking count');
    bars(m.body, mix.map((r) => ({ label: r.label, n: n(r.n) })));
    deck.append(m.card);
  }

  if (plats?.length) {
    deck.append(el('p', 'm-sec', 'By channel'));
    const byPlat = {};
    plats.forEach((p) => { byPlat[p.platform] = (byPlat[p.platform] || 0) + (n(p.trips) || 0); });
    rows(deck, Object.entries(byPlat).sort((a, b) => b[1] - a[1]).map(([p, t]) => row({
      title: p === 'fms' ? 'FMS telematics' : p[0].toUpperCase() + p.slice(1),
      sub: `${Math.round((t / k.trips) * 100)}% of bookings`,
      value: fmt(t), note: 'bookings',
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

  const board = await q('/api/drivers/leaderboard').catch(() => []);
  if (!ctx.alive()) return;
  list.innerHTML = '';
  if (!board?.length) { empty(list, 'Nobody drove in this window', 'Widen the window from the ⋮ menu.'); return; }

  /* One person, not one platform account.
     ─────────────────────────────────────────────────────────────────────
     driver_ext_id is the CHANNEL's id for someone, so a man who drives for
     Uber and Yango is two rows in this payload. Keyed on that, the list read
     "Kashif Ali" three times with different numbers against each — accurate,
     and unusable as a list of people. Folded on the name instead, with the
     channels as the subtitle and the drill-down pointed at the id that holds
     the most of their work. */
  const byName = new Map();
  for (const r of board) {
    const name = r.driver_name || r.driver_ext_id || '—';
    const cur = byName.get(name)
      || { id: r.driver_ext_id, name, trips: 0, km: 0, revenue: 0, plats: new Set(), top: 0 };
    const t = n(r.trips) || 0;
    cur.trips += t;
    cur.km += n(r.km) || 0;
    cur.revenue += n(r.revenue) || 0;
    if (r.platform) cur.plats.add(r.platform);
    if (t >= cur.top) { cur.top = t; cur.id = r.driver_ext_id || cur.id; }
    byName.set(name, cur);
  }
  const all = [...byName.values()];
  let sort = 'trips', term = '';

  const draw = () => {
    list.innerHTML = '';
    const shown = all
      .filter((d) => !term || d.name.toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => b[sort] - a[sort]);
    if (!shown.length) { empty(list, 'Nobody matches that', 'Try part of a name.'); return; }
    rows(list, shown.map((d) => row({
      title: d.name,
      sub: `${[...d.plats].join(', ') || 'no channel'} · ${fmt(Math.round(d.km))} km`,
      value: sort === 'revenue' ? money(d.revenue) : fmt(d[sort]),
      note: sort === 'revenue' ? 'fares' : sort,
      to: href('driver', d.id),
    })));
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

  const [cars, live] = await Promise.all([
    q('/api/vehicles').catch(() => []),
    api('/api/live').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  list.innerHTML = '';
  if (!cars?.length) { empty(list, 'No vehicle worked in this window', 'Widen the window from the ⋮ menu.'); return; }

  const pos = new Map((live || []).map((l) => [l.plate, l]));
  let sort = 'trips', term = '';
  const draw = () => {
    list.innerHTML = '';
    const shown = cars
      .filter((c) => !term || c.plate.toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => (n(b[sort]) || 0) - (n(a[sort]) || 0));
    if (!shown.length) { empty(list, 'No plate matches that', 'Try part of a plate.'); return; }
    rows(list, shown.map((c) => {
      const p = pos.get(c.plate);
      const where = p ? (p.stale ? 'stale fix' : p.speed > 3 ? `moving ${Math.round(p.speed)} km/h` : 'stopped') : 'not reporting';
      return row({
        title: c.plate,
        sub: `${where} · ${fmt(c.drivers)} drivers`,
        value: sort === 'revenue' ? money(n(c.revenue)) : fmt(n(c[sort])),
        note: sort === 'revenue' ? 'fares' : sort === 'km' ? 'km' : 'bookings',
        to: href('vehicle', c.plate),
      });
    }));
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
  const [sum, byVeh] = await Promise.all([
    q('/api/alerts/summary').catch(() => []),
    q('/api/alerts/by-vehicle').catch(() => []),
  ]);
  if (!ctx.alive()) return;
  deck.innerHTML = '';
  const total = (sum || []).reduce((a, r) => a + (n(r.n) || 0), 0);
  if (!total) { empty(deck, 'No harsh-driving event in this window', 'Nothing to review.'); return; }
  lede(deck, { claim: `${fmt(total)} harsh-driving events`,
    sub: 'Recorded by the telematics layer. A count on its own says more about how far a car drove than how it was driven.' });
  const c = card('By kind', null);
  bars(c.body, (sum || []).map((r) => ({ label: r.alert_type, n: n(r.n) })), { max: 8 });
  deck.append(c.card);
  if (byVeh?.length) {
    deck.append(el('p', 'm-sec', 'By vehicle'));
    rows(deck, byVeh.slice(0, 25).map((r) => row({
      title: r.plate, sub: r.driver_name || 'no driver on the row',
      value: fmt(n(r.n ?? r.alerts)), note: 'events', to: href('vehicle', r.plate),
    })));
  }
}

async function unauthorized(deck, ctx) {
  skeleton(deck, 3);
  const [sum, list] = await Promise.all([
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
  const items = Array.isArray(list) ? list : (list.rows || []);
  if (items.length) {
    deck.append(el('p', 'm-sec', 'Every one of them'));
    rows(deck, items.slice(0, 40).map((r) => row({
      title: r.plate || '—',
      sub: `${r.driver_name || 'no driver'}${r.started_at ? ` · ${dayStr(r.started_at)}` : ''}`,
      value: r.km != null ? `${n(r.km)}` : '', note: r.km != null ? 'km' : '',
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
  deck.append(el('p', 'm-sec', 'Operate'));
  rows(deck, [
    row({ title: 'Live fleet', sub: 'positions now', value: '›', to: href('live') }),
    row({ title: 'Safety', sub: 'harsh-driving events', value: '›', to: href('safety') }),
    row({ title: 'Unauthorized trips', sub: 'moved with no booking', value: '›', to: href('unauthorized') }),
    row({ title: 'Data sources', sub: 'collector health', value: '›', to: href('sources') }),
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

/* ── the fallback ───────────────────────────────────────────────────────
   A route this app has no screen for still has to resolve: an address someone
   sent to a phone must not dead-end. Driver and vehicle detail render the real
   desktop module, which exports its renderer and is styled by app.css; the
   rest are pages built around a wide table, and the honest answer for those is
   the desktop build, one tap away and returning to this exact address. */
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
  today, money: moneyScreen, people, fleet, live, safety, unauthorized, sources, more, fallback,
  /* The desktop's own addresses, so a link that predates this app still lands
     somewhere sensible rather than on the fallback. */
  overview: today, drivers: people, vehicles: fleet, finance: moneyScreen,
};
