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
  dtStr, dayStr, dialable, sourceLabel, andList } from './ui.js';
import { fmt } from './charts.js';
import { api } from './data.js';

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
  const chip = ok ? pill('receiving', 'ok') : pill('not receiving', 'bad', reason);
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

export async function renderFeeds(root) {
  root.innerHTML = '';
  loading(root);
  let d;
  try { d = await api('/api/vehicles/feeds'); } catch (e) {
    root.innerHTML = '';
    root.append(note(`The feed list could not be read: ${e.message}`, 'err'));
    return;
  }
  root.innerHTML = '';
  const rows = d.rows || [];
  const t = d.totals || {};
  const hours = d.window_hours;
  const noAccount = rows.filter((r) => r.seat_state === 'no_account');
  const noAccountFleets = [...new Set(noAccount.map((r) => sourceLabel(r.fleet_id)))];

  /* The count at the top: receiving and not, for each feed. */
  root.append(kpiRow([
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
  ]));

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
      { label: 'Vehicle', key: 'plate', render: (r) => entity('vehicle', r.vehicle_page ? r.plate : null, r.plate) },
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

  /* One short line per rule. The fleets holding each account come from the
     collector's own configuration, so these lines cannot drift from it.

     They are also THIS PAGE'S SOURCE LINE, and carry .srcline for that
     reason. The shell stamps every page that has none with "Built from the
     whole record — Uber N · Hotel N …", a count of bookings — and not one
     booking is read here: the page is built from Uber's vehicle list and two
     tracker feeds, which is exactly what these lines name. A second, generic
     provenance under them would attribute this table to the wrong things. */
  const names = (list) => andList((list || []).map((f) => sourceLabel(f)));
  const rules = [
    ['Active on Uber', 'Uber’s own vehicle list marks the car ACTIVE. It is read every 30 minutes, for both fleets.'],
    ['Seat sensor — CABMAN', `CABMAN DT's seat sensor, sampled every 5 minutes. It holds an account for ${names(d.accounts?.seat) || 'no fleet'} only.`],
    ['Seat sensor — FMS', `the seat count FMS reports live (every 2 minutes) or on each trip (every 30 minutes), whichever is newer, for ${names(d.accounts?.fms_seat) || 'no fleet'}.`],
    ['FMS data', `InfoTrack's live telematics, with an account for ${names(d.accounts?.fms) || 'no fleet'}.`],
    ['Receiving', `a reading in the last ${hours} hours. Trackers report every few minutes while driving but go quiet for hours when parked, so a shorter window would turn parked cars red.`],
    ['Matched by', 'the plate, as every feed stores it: upper case, no spaces or dashes.'],
    ['Driver', 'whoever Uber assigns to the car in that list, or where it assigns nobody, whoever drove it most on the latest day with a trip. The phone is from their roster record.'],
  ];
  root.append(el('div', 'cap srcline',
    rules.map(([k, v]) => `<div><b>${esc(k)}:</b> ${esc(v)}</div>`).join('')));
}
