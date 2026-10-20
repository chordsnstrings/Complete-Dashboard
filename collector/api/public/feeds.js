/* #feeds — every car Uber lists as active, and whether its seat sensor and its
   FMS tracker are sending data.
   ═══════════════════════════════════════════════════════════════════════════
   Asked for in so many words: "the vehicles numbers active on uber but not
   receiving any seat sensor or FMS data and which one's receiving. the one
   that's receiving will be green, the ones not receiving will be red, along
   with driver names and phone number".

   So: a count at the top, one table, and one line per rule the table is
   built on. Nothing else. Every rule is decided in api/feed_routes.js, which
   carries the measurements behind each; this file only draws what it returns.

   The colours are the product's own verdict chips (.pill.ok / .pill.bad in
   app.css, on --good and --critical), and each carries its word — "receiving"
   or "not receiving" — because a verdict must never be colour alone. A red
   cell also says WHY in the route's own sentence, and that sentence is true:
   a car whose fleet has no CABMAN account says exactly that, and nothing
   that reads as a fault in the car. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, entity, pill, countOf,
  dtStr, dayStr, dialable, sourceLabel, andList, contract, glance, glanceBand, bandTiles, absenceBand, pageFoot,
  kpiTiles, kpiCols } from './ui.js';
import { fmt } from './charts.js';
import { api } from './data.js';
import { closedBlock } from './access.js';

/* Two seat-sensor providers and one telematics feed. FMS and CABMAN are
   separate providers and each is meant to send seat data (the operator,
   2026-09-23), so the seat sensor is shown per provider, and every cell names
   the provider its reading came from. */
const FEEDS = {
  seat: { label: 'Seat sensor — CABMAN', noun: 'CABMAN seat-sensor', from: 'CABMAN DT' },
  fms_seat: { label: 'Seat sensor — FMS', noun: 'FMS seat-count', from: 'FMS (InfoTrack), seat count' },
  fms: { label: 'FMS data', noun: 'FMS', from: 'FMS (InfoTrack), live' },
};

/* One feed on one car: the chip, then when it was last heard from, then why
   it is red where the time alone does not say. A car whose newest reading is
   simply older than the window needs no more than its time; the other three
   reds — no account, never reported, the whole feed quiet — each need their
   sentence, because the time is missing or misleading. */
function feedCell(r, feed) {
  const ok = r[`${feed}_receiving`];
  const at = r[`${feed}_at`];
  const state = r[`${feed}_state`];
  const reason = r[`${feed}_reason`];
  /* Under the page contract the state is an outline chip, and "not
     receiving" says so in the negative token as text — never a fill, never
     colour alone. */
  const chip = contract()
    ? (ok ? pill('receiving') : `<span class="pill" style="color:var(--sem-neg)"${reason ? ` title="${esc(reason)}"` : ''}>not receiving</span>`)
    : ok ? pill('receiving', 'ok') : pill('not receiving', 'bad', reason);
  const from = `<div class="dim">from ${esc(FEEDS[feed].from)}</div>`;
  const when = at ? `<div class="dim">last reading ${esc(dtStr(at))}</div>` : '';
  const why = !ok && reason && state !== 'silent' ? `<div class="dim">${esc(reason)}</div>` : '';
  return `${chip}${from}${when}${why}`;
}

/* `link` is handed in by the column rather than defined here, so the column
   that names a driver visibly links to one — test/interlinking.test.mjs reads
   each column's own text for the entity() call, and a renderer passed by name
   reads as a dead "Driver" column. */
function driverCell(r, link) {
  const refs = r.driver_refs || [];
  if (!refs.length) return `<span class="ent-off">${esc(r.driver_absent || 'no driver known')}</span>`;
  const basis = r.driver_basis === 'uber_assignment'
    ? (refs.length > 1 ? 'both assigned to this car in Uber' : 'assigned to this car in Uber')
    : `drove it most on ${r.driver_as_of ? esc(dayStr(`${String(r.driver_as_of).slice(0, 10)}T12:00:00`)) : 'an unrecorded day'}`;
  return `${refs.map(link).join('<br>')}<div class="dim">${basis}</div>`;
}

function phoneCell(r) {
  const refs = r.driver_refs || [];
  if (!refs.length) return '<span class="ent-off">no driver known</span>';
  return refs.map((d) => {
    /* With two drivers each number carries its owner's name — a list of two
       numbers beside two names is a guess about which is whose. The whole
       name, not the first: in this fleet two shift partners can easily both
       be a Muhammad. */
    const who = refs.length > 1 ? `<span class="dim">${esc(d.name || 'name not on file')}: </span>` : '';
    const n = dialable(d.phone);
    return who + (n
      ? `<a class="lnk" href="tel:${esc(n)}">${esc(n)}</a>`
      : '<span class="ent-off">no phone on file</span>');
  }).join('<br>');
}

/* ── CABMAN: the seat sensor against the car's own movement and bookings ──
   The operator, 2026-10-20: "a separate seat sensor table for cabman … where
   we can see seat sensor data and cabman movement data". The table above says
   whether a reading ARRIVED; this one says whether it can be believed, by the
   two things the pad cannot influence — where CABMAN says the car went, and
   whether a booking says somebody was aboard. Every rule and threshold is
   decided in api/feed_routes.js (cabmanSeat) and printed under the table. */
const CAB_CHIP = {
  silent: { word: 'unit silent', bad: true },
  elsewhere: { word: 'not moving with the car', bad: true },
  no_seat: { word: 'sends no seat reading', bad: true },
  unreported: { word: 'not reporting during bookings', bad: true },
  pad_dead: { word: 'pad reads nobody', bad: true },
  pad_misses: { word: 'pad misses passengers', bad: true },
  few: { word: 'too few to judge', bad: false },
  no_bookings: { word: 'nothing to check against', bad: false },
  ok: { word: 'pad working', bad: false, good: true },
};
const pct1 = (x) => (x == null ? '' : ` (${fmt(x, 1)}%)`);
const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function cabChip(r) {
  const c = CAB_CHIP[r.verdict] || { word: r.verdict };
  if (contract()) {
    return c.bad ? `<span class="pill" style="color:var(--sem-neg)">${esc(c.word)}</span>` : pill(c.word);
  }
  return pill(c.word, c.bad ? 'bad' : c.good ? 'ok' : null);
}

function cabUnitCell(r, hours) {
  const chip = contract()
    ? (r.receiving ? pill('receiving') : '<span class="pill" style="color:var(--sem-neg)">not receiving</span>')
    : r.receiving ? pill('receiving', 'ok') : pill('not receiving', 'bad');
  if (!r.last_at) return `${chip}<div class="dim">never sent a reading</div>`;
  /* What the unit said at its newest reading: CABMAN's own flag, and whether
     the car was moving. "Engaged" is the seat pad's own state (see the rules
     below), so it is named as CABMAN's flag and nothing more. */
  const flag = r.last_status ? `CABMAN flag ${r.last_status}` : null;
  const moving = r.last_speed == null ? null : Number(r.last_speed) > 0 ? `moving, ${fmt(r.last_speed)} km/h` : 'standing';
  return `${chip}<div class="dim">last reading ${esc(dtStr(r.last_at))}</div>`
    + `${[flag, moving].filter(Boolean).length ? `<div class="dim">${esc([flag, moving].filter(Boolean).join(' · '))}</div>` : ''}`
    + `${!r.receiving ? `<div class="dim">no reading in the last ${esc(String(hours))} hours</div>` : ''}`;
}

function cabMoveCell(r, days) {
  /* Absent with the route's reason: no measured step is not a car that did
     not move. */
  if (r.km == null) return `<span class="ent-off">${esc(r.km_reason || `no CABMAN reading in ${days} days`)}</span>`;
  if (!r.km) return `did not move<div class="dim">under 0.1 km over ${esc(countOf(r.steps, 'measured step'))}</div>`;
  return `${fmt(r.km, 1)} km`
    + `<div class="dim">moved on ${fmt(r.days_moved)} of the last ${fmt(days)} days</div>`
    + `${r.last_moved_at ? `<div class="dim">last moved ${esc(dtStr(r.last_moved_at))}</div>` : ''}`;
}

function cabSeatCell(r, days) {
  if (!r.seat_readings) return `<span class="ent-off">no seat reading in ${esc(String(days))} days</span>`;
  const head = r.occupied_readings
    ? `occupied on ${fmt(r.occupied_readings)} of ${fmt(r.seat_readings)} readings${pct1(r.occupied_pct)}`
    : `never occupied — ${countOf(r.seat_readings, 'reading')}, all empty`;
  const km = r.occupied_km == null ? ''
    : `<div class="dim">${fmt(r.occupied_km, 1)} km with the seat occupied${r.occupied_km_pct == null ? '' : ` (${fmt(r.occupied_km_pct, 1)}% of km)`}</div>`;
  const last = r.last_occupied_at ? `<div class="dim">last occupied ${esc(dtStr(r.last_occupied_at))}</div>` : '';
  return `${head}${km}${last}`;
}

function cabBookCell(r, days) {
  const b = r.bookings || {};
  if (!b.total) return `<span class="ent-off">no completed booking in ${esc(String(days))} days</span>`;
  const ch = Object.entries(b.platforms || {}).sort((x, y) => y[1] - x[1])
    .map(([p, n]) => `${sourceLabel(p)} ${fmt(n)}`).join(' · ');
  const head = b.read
    ? `occupied during ${fmt(b.seat_seen)} of ${fmt(b.read)} bookings${pct1(b.seat_pct)}`
    : `${countOf(b.total, 'booking')}, none with a seat reading inside`;
  return `${head}<div class="dim">${esc(ch)}</div>`
    + `${b.read && b.no_reading ? `<div class="dim">${esc(countOf(b.no_reading, 'booking'))} with no seat reading inside</div>` : ''}`
    + `${b.standing_still ? `<div class="dim">standing still through ${esc(countOf(b.standing_still, 'booking'))}</div>` : ''}`;
}

function renderCabman(host, d) {
  const rows = d.rows || [];
  const t = d.totals || {};
  const v = t.verdicts || {};
  const days = d.days;
  const counts = [
    v.silent ? `${fmt(v.silent)} silent` : null,
    v.elsewhere ? `${fmt(v.elsewhere)} not moving with the car` : null,
    v.no_seat ? `${fmt(v.no_seat)} sending no seat reading` : null,
    v.unreported ? `${fmt(v.unreported)} not reporting during bookings` : null,
    v.pad_dead ? `${fmt(v.pad_dead)} reading nobody` : null,
    v.pad_misses ? `${fmt(v.pad_misses)} missing passengers` : null,
    v.ok ? `${fmt(v.ok)} working` : null,
  ].filter(Boolean);
  const p = panel(`CABMAN — seat sensor and movement, last ${days} days`,
    `${countOf(rows.length, 'car')} on CABMAN’s list${counts.length ? ` · ${counts.join(' · ')}` : ''}. `
    + (t.bookings_read
      ? `Across them, of ${fmt(t.bookings)} completed bookings, ${fmt(t.bookings_read)} had a seat reading inside, and the seat read occupied during ${fmt(t.bookings_seat_seen)} of those${pct1(Math.round((1000 * t.bookings_seat_seen) / t.bookings_read) / 10)}. `
      : '')
    + `Readings to ${dtStr(d.as_of)}. The cars to look at come first.`, 'feeds-cabman');
  host.append(p.panel);
  if (d.roster && !d.roster.known && d.roster.basis_reason) p.body.append(note(cap1(d.roster.basis_reason), 'warn'));
  if (!rows.length) {
    p.body.append(note(d.roster?.known ? 'CABMAN’s list holds no car of either fleet.'
      : `CABMAN’s list has not been read, and no CABMAN reading arrived in the last ${days} days.`, 'warn'));
  } else {
    p.body.append(tableFrom(rows, [
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.vehicle_page ? r.plate : null, r.plate)
        + `<div class="dim">${esc(sourceLabel(r.fleet_id))}</div>` },
      { label: 'CABMAN unit', key: 'receiving', sortValue: (r) => (r.receiving ? 1 : 0), render: (r) => cabUnitCell(r, d.window_hours) },
      { label: `Movement, ${days} days`, key: 'km', sortValue: (r) => r.km, render: (r) => cabMoveCell(r, days) },
      { label: 'Seat sensor', key: 'occupied_readings', sortValue: (r) => r.occupied_pct, render: (r) => cabSeatCell(r, days) },
      { label: 'Seat against bookings', key: 'bookings', sortValue: (r) => r.bookings?.seat_pct ?? null, render: (r) => cabBookCell(r, days) },
      { label: 'What it shows', key: 'verdict', sortValue: (r) => r.rank, render: (r) => `${cabChip(r)}<div>${esc(cap1(r.verdict_text))}</div>`
        + (r.notes || []).map((n) => `<div class="dim">${esc(cap1(n))}</div>`).join('') },
    ], { sortable: true, sortId: 'feeds-cabman', cards: true, cardLead: 'plate' }));
  }
  /* The plates CABMAN stopped listing — counted, with the check that says
     whether any of them was ever ours, never silently dropped. */
  const dep = d.departed || {};
  const when = (dep.groups || []).slice(0, 3).map((g) => `${fmt(g.plates)} last listed ${g.day ? dayStr(`${g.day}T12:00:00`) : 'on an unrecorded day'}`);
  const r = d.rules || {};
  const lines = [
    dep.plates ? ['Not in the table', `${countOf(dep.plates, 'plate')} CABMAN has stopped listing (${andList(when)}${(dep.groups || []).length > 3 ? ', and others' : ''}). `
      + (dep.with_bookings ? `${fmt(dep.with_bookings)} of them did have bookings with us — those are worth a look on Vehicles.`
        : 'Not one of them ever had a booking with either fleet: they are other companies’ cars CABMAN used to send.')] : null,
    ['Movement', `CABMAN’s own readings that carry a position, never another tracker’s: a step counts when the readings are at most ${r.gap_min} minutes apart and under ${r.hop_km} km apart. With no such step nothing is measured, and the cell says why. A day is 24 hours counted back from now, and counts as moved at 1 km.`],
    ['Seat sensor', 'CABMAN’s seat pad, a passenger count stored as occupied (1 or more) or empty. CABMAN’s own trip flag, Engaged, is the same pad’s state, so it is no second witness — the bookings and the movement are.'],
    ['Against bookings', `every completed booking on the car (Uber, Bolt, Yango, hotel — an FMS journey is not a booking), checked on the CABMAN readings from ${r.pad_min} minutes before the booking was requested — never before the previous booking’s drop-off — to ${r.pad_min} minutes after drop-off. A booking with no seat reading inside says nothing about the pad and is counted apart.`],
    ['What it shows', `the pad is judged on the bookings with a seat reading inside, only from ${fmt(r.min_bookings)} of them, and is working at ${fmt(Math.round((r.ok_share || 0) * 100))}% or more. A booking of ${r.trip_km} km and ${r.still_min} minutes or more counts as standing still when the unit’s readings inside it — at least ${r.still_readings} — moved under ${r.still_km} km; through ${fmt(r.min_bookings)} or more such bookings and ${fmt(Math.round((r.elsewhere_share || 0) * 100))}% of them, it is the unit, not the car. Silent is no reading in ${d.window_hours} hours.`],
  ].filter(Boolean);
  p.body.append(el('div', 'cap', lines.map(([k, x]) => `<div><b>${esc(k)}:</b> ${esc(x)}</div>`).join('')));
}

export async function renderFeeds(root) {
  root.innerHTML = '';
  loading(root);
  /* Asked at the same time as the table above, and settled on its own: a
     failure here costs this table, never the one above it. */
  const cabP = api('/api/vehicles/feeds/cabman').then((x) => ({ x }), (e) => ({ e }));
  let d;
  try { d = await api('/api/vehicles/feeds'); } catch (e) {
    root.innerHTML = '';
    /* Not shown to this reader — for a one-fleet reader, the totals count
       every fleet — is an answer with a reason, not a failure. */
    if (e?.name === 'WithheldError') {
      root.append(closedBlock({ view: 'feeds', title: 'This is not shown to your role', detail: e.message }));
      return;
    }
    root.append(note(`The feed list could not be read: ${e.message}`, 'err'));
    return;
  }
  root.innerHTML = '';
  const rows = d.rows || [];
  const t = d.totals || {};
  const hours = d.window_hours;
  const noAccount = rows.filter((r) => r.seat_state === 'no_account');
  const noAccountFleets = [...new Set(noAccount.map((r) => sourceLabel(r.fleet_id)))];

  /* Under the page contract (a post-plan page, on the contract's own rules):
     the six counts as the 00 band, untoned, the feed missing the most cars
     the hero; the table, its sort, its cards at a phone width and its tel:
     links unchanged, the feed states outline chips; the rules line kept as
     the page's source; a † band for the fleets a provider holds no account
     for. */
  const ak = contract();
  const AKB = ak ? glanceBand(root, `readings as of ${dtStr(d.as_of)} · receiving means a reading in the last ${hours} hours`) : null;
  /* The count at the top: receiving and not, for each feed. */
  /* From the endpoint, or from the rows when an older answer has no total
     (a cached response straight after a deploy): the same rule either way. */
  const nd = t.no_data || (() => {
    const dark = rows.filter((r) => !r.seat_receiving && !r.fms_seat_receiving && !r.fms_receiving);
    const fleets = {};
    for (const r of dark) fleets[r.fleet_id || 'unknown'] = (fleets[r.fleet_id || 'unknown'] || 0) + 1;
    const gone = (x) => x === 'never' || x === 'no_account';
    return { vehicles: dark.length, fleets,
      never: dark.filter((r) => gone(r.seat_state) && gone(r.fms_seat_state) && gone(r.fms_state)).length };
  })();
  const ndFleets = Object.entries(nd.fleets || {}).filter(([, n]) => n).map(([f, n]) => `${fmt(n)} ${sourceLabel(f)}`);
  const FEED_TILES = [
    /* The car no tracker sees at all (the operator, 2026-10-06). First, and
       the hero: a car missing ONE feed still has another; this one has none.
       In both skins, by the operator's word ("put it in both"), so the old
       skin's frozen rendering of #feeds was re-recorded with it. */
    { label: 'Receiving no data at all', value: fmt(nd.vehicles ?? 0), tone: 'critical', key: 'none-no', hero: true,
      sub: `neither CABMAN nor FMS in the last ${hours} hours`
        + (nd.vehicles ? ` · ${ndFleets.join(' · ')} · ${fmt(nd.never)} never sent anything` : '') },
    { label: 'Seat sensor (CABMAN) receiving', value: fmt(t.seat?.receiving ?? 0), tone: 'good', key: 'seat-yes',
      sub: `of ${countOf(t.vehicles ?? 0, 'car')} active on Uber` },
    { label: 'Seat sensor (CABMAN) not receiving', value: fmt(t.seat?.not_receiving ?? 0), tone: 'critical', key: 'seat-no',
      sub: noAccount.length
        ? `${fmt(noAccount.length)} of them on ${andList(noAccountFleets)}, which has no CABMAN account`
        : `no reading in the last ${hours} hours` },
    { label: 'Seat sensor (FMS) receiving', value: fmt(t.fms_seat?.receiving ?? 0), tone: 'good', key: 'fms-seat-yes',
      sub: `of ${countOf(t.vehicles ?? 0, 'car')} active on Uber` },
    { label: 'Seat sensor (FMS) not receiving', value: fmt(t.fms_seat?.not_receiving ?? 0), tone: 'critical', key: 'fms-seat-no',
      sub: `no FMS seat count in the last ${hours} hours` },
    { label: 'FMS receiving', value: fmt(t.fms?.receiving ?? 0), tone: 'good', key: 'fms-yes',
      sub: `of ${countOf(t.vehicles ?? 0, 'car')} active on Uber` },
    { label: 'FMS not receiving', value: fmt(t.fms?.not_receiving ?? 0), tone: 'critical', key: 'fms-no',
      sub: `no reading in the last ${hours} hours` },
  ];
  if (ak) {
    /* Two rows, what is missing first: the cars receiving nothing at all
       (the hero, two of the six columns), then the three "not receiving"
       counts — five columns, one line at 1440 — and below them the three
       receiving, in a hero-less row. */
    const tiles = bandTiles(FEED_TILES.filter(Boolean)).tiles;
    glance(AKB.tilesHost, tiles.filter((x) => /-no$/.test(x.key || '')));
    const row2 = el('div', 'kpis glance');
    row2.innerHTML = kpiTiles(tiles.filter((x) => !/-no$/.test(x.key || '')).map((x) => ({ ...x, glance: true, hero: false })));
    row2.style.setProperty('--kpi-n', String(kpiCols(row2.children.length)));
    AKB.tilesHost.after(row2);
  } else root.append(kpiRow(FEED_TILES.filter(Boolean)));

  const fleets = Object.entries(t.fleets || {}).map(([f, n]) => `${fmt(n)} ${sourceLabel(f)}`);
  const p = panel(`${countOf(rows.length, 'car')} active on Uber`,
    `${fleets.join(' · ')}. Readings as of ${dtStr(d.as_of)}. The cars missing a feed come first.`,
    'feeds');
  root.append(p.panel);

  if (!rows.length) {
    p.body.append(note('Uber’s vehicle list marks no car ACTIVE — either the list has not been read '
      + 'for either fleet yet, or Uber has no active car on it. Data sources says when uber_fleet last ran.', 'warn'));
  } else {
    const on = (feed) => (r) => (r[`${feed}_receiving`] ? 1 : 0);
    p.body.append(tableFrom(rows, [
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.vehicle_page ? r.plate : null, r.plate)
        + (!r.seat_receiving && !r.fms_seat_receiving && !r.fms_receiving
          ? `<div class="dim">${['seat_state', 'fms_seat_state', 'fms_state'].every((k) => r[k] === 'never' || r[k] === 'no_account')
            ? 'no data ever' : 'no data at all'}</div>` : '') },
      { label: 'Fleet', key: 'fleet_id', render: (r) => esc(sourceLabel(r.fleet_id)) },
      { label: FEEDS.seat.label, key: 'seat_receiving', sortValue: on('seat'), render: (r) => feedCell(r, 'seat') },
      { label: FEEDS.fms_seat.label, key: 'fms_seat_receiving', sortValue: on('fms_seat'), render: (r) => feedCell(r, 'fms_seat') },
      { label: FEEDS.fms.label, key: 'fms_receiving', sortValue: on('fms'), render: (r) => feedCell(r, 'fms') },
      /* A driver page is addressed by the PERSON where the spine has placed
         the account, and by the account otherwise — see "A DRIVER PAGE IS
         ADDRESSED BY THE PERSON" in docs/COVERAGE.md. Neither: plain text,
         not a dead link, which entity() does on a null id. */
      { label: 'Driver', key: 'driver_refs', sortValue: (r) => String(r.driver_refs?.[0]?.name || '').toLowerCase() || null,
        render: (r) => driverCell(r, (d) => entity('driver', d.person_id != null ? `p${d.person_id}` : d.id,
          d.name || 'name not on file')) },
      { label: 'Phone', key: 'phone', sortValue: (r) => r.driver_refs?.[0]?.phone || null, render: phoneCell },
    ], { sortable: true, sortId: 'feeds', cards: true, cardLead: 'plate' }));
  }

  const cab = await cabP;
  if (cab.x) renderCabman(root, cab.x);
  else if (cab.e?.name === 'WithheldError') {
    root.append(closedBlock({ view: 'feeds', title: 'The CABMAN table is not shown to your role', detail: cab.e.message }));
  } else root.append(note(`The CABMAN table could not be read: ${cab.e?.message || 'no answer'}`, 'err'));

  /* One short line per rule. The fleets holding each account come from the
     collector's own configuration, so these lines cannot drift from it.

     They are also THIS PAGE'S SOURCE LINE, and carry .srcline for that
     reason. The shell stamps every page that has none with "Built from the
     whole record — Uber N · Hotel N …", a count of bookings — and the page
     is built from Uber's vehicle list and two tracker feeds, which is exactly
     what these lines name. Only the CABMAN table reads bookings, a week of
     them for the cars on its list, and its line says so. A second, generic
     provenance under them would attribute these tables to the wrong things. */
  const names = (list) => andList((list || []).map((f) => sourceLabel(f)));
  const rules = [
    ['Active on Uber', 'Uber’s own vehicle list marks the car ACTIVE. It is read every 30 minutes, for both fleets.'],
    ['Seat sensor — CABMAN', `CABMAN DT's seat sensor, sampled every 5 minutes. It holds an account for ${names(d.accounts?.seat) || 'no fleet'} only.`],
    ['Seat sensor — FMS', `the seat count FMS reports live (every 2 minutes) or on each trip (every 30 minutes), whichever is newer, for ${names(d.accounts?.fms_seat) || 'no fleet'}.`],
    ['FMS data', `InfoTrack's live telematics, with an account for ${names(d.accounts?.fms) || 'no fleet'}.`],
    ['Receiving', `a reading in the last ${hours} hours. Trackers report every few minutes while driving but go quiet for hours when parked, so a shorter window would turn parked cars red.`],
    ['Matched by', 'the plate, as every feed stores it: upper case, no spaces or dashes.'],
    ['CABMAN table', 'CABMAN\u2019s own readings for the cars on its list, held against the completed bookings on each car — the one place on this page a booking is read.'],
    ['Driver', 'whoever Uber assigns to the car in that list, or where it assigns nobody, whoever drove it most on the latest day with a trip. The phone is from their roster record.'],
  ];
  root.append(el('div', 'cap srcline',
    rules.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')));
  if (ak) {
    const absHost = el('div'); root.append(absHost);
    absenceBand(absHost, [
      { label: 'A CABMAN seat sensor on these fleets', hl: noAccount.length > 0, fig: noAccount.length ? countOf(noAccount.length, 'car') : null, none: 'Every fleet covered',
        why: noAccount.length ? `${andList(noAccountFleets)} has no CABMAN account, so its cars can never send a CABMAN seat reading — a fact about the account, not a fault in the car.`
          : 'Every fleet with an active car holds a CABMAN account.' },
      { label: 'Cars not on Uber\u2019s list', fig: null, none: 'Not shown',
        why: 'The page starts from the cars Uber marks ACTIVE; a car on another channel only, or on none, is not on it.' },
    ]);
    pageFoot({ colophon: ['Uber\u2019s vehicle list and the tracker feeds', countOf(rows.length, 'car')] }, root);
  }
}
