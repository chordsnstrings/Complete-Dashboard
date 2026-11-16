/* ── WHERE EACH CAR SPENT THE NIGHT, on three pages (OVN, 2026-11-16) ─────
   The operator: "also add the overnight parking table on the fleet page also
   in drivers activity list and drivers day page". /api/overnight answers;
   api/overnight.js on the server owns the definition — the night of D is
   00:00–05:00 Dubai on D+1, the place is the tracker's stay with the most
   minutes in that window — and every word of a reason. This module only
   draws it, in three places:

     1. #vehicles (the fleet page): "Where cars spent the night" — a night
        picker, the fleet by area, the counts, and a sortable table, each
        plate linked to that car's "Where it was" for the morning;
     2. #driver/<id>/activity: under each day's bar, where the car the person
        drove LAST that day spent the night after it;
     3. #driver/<id>/day: the night before (the car first driven, where it
        was when the day began) and the night after (the car last driven,
        where it was left).

   Loaded only when one of those asks (import() at each call site), so no
   page waits for it and none carries it unasked (test/lazy_pages.test.mjs).

   Every figure that cannot be measured is absent with its TRUE reason,
   styled as the product styles absent values (`ent-off`): a car whose night
   was not a stay says why in the server's words; unnamed ground is "unnamed
   ground" with why; a night not begun says so; a role without locations is
   told the server's own refusal, never handed an error or a blank. "Inferred"
   is always said as inferred.

   The request is built here, never through qAll: the shell's window
   (from/to) would ride along on every call (COVERAGE trap "params() puts the
   shell's window on EVERY call"), and the route reads from/to as a range of
   nights. */
import { el, esc, note, tableFrom, foldRows, sourceLabel } from './ui.js';
import { api, href } from './data.js';
import { dubaiDay } from './tz.js';

const MAX_PLATES = 10;
const MAX_NIGHTS = 31;
/* Day arithmetic from midday UTC, so a shift never crosses a calendar edge
   (test/timezone.test.mjs). */
export const shiftDay = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
export const lastNight = () => shiftDay(dubaiDay(), -1);
/* A night is READ to 12:00 Dubai on D+1 (its window closes at 05:00, but
   when the car left and whether a quiet tracker has reported since move
   until then — api/overnight.js overnightOpen, OVN9); until then its answer
   moves with every tracker tick, so it is never painted from this browser's
   copy. */
const readOpen = (night) => Date.now() < Date.parse(`${shiftDay(night, 1)}T12:00:00+04:00`);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dm = (d) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const wdm = (d) => `${WD[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${dm(d)}`;
const keep = (node) => { node.dataset.fx = 'keep'; return node; };
const trackerWord = (s) => (s === 'fms' ? 'FMS' : s === 'cabman' ? 'CABMAN' : s ? sourceLabel(s) : '—');
export const UNNAMED = 'unnamed ground';
export const BASIS_WORD = { fixes: 'seen', inferred: 'inferred', 'fixes and inferred': 'seen and inferred' };
export const STATUS_WORD = { parked: 'parked', moving: 'on the move', unknown: 'not known', silent: 'no reading',
  no_tracker: 'no tracker' };

/* One read. A refusal (a role without locations) and a failure are answers
   with their own words, never thrown at the page. */
async function read(params, open) {
  const qs = new URLSearchParams(params).toString();
  try { return { body: await api(`/api/overnight?${qs}`, open ? {} : undefined) }; } catch (e) {
    if (e?.name === 'WithheldError') return { refused: e.message || 'Not shown to your role.' };
    return { failed: e?.message || String(e) };
  }
}

/* "21:10–07:00", with a day where it is not the obvious one (the evening of
   the night, the morning after), and the bounds said as bounds. */
export function spanWords(r, { days = false } = {}) {
  if (r.status !== 'parked' || !r.from) return null;
  const on = shiftDay(r.night, 1);
  const fromDay = days || r.from_day !== r.night ? ` ${dm(r.from_day)}` : '';
  const toDay = days || r.to_day !== on ? ` ${dm(r.to_day)}` : '';
  const from = `${r.since_at_least ? 'by ' : ''}${r.from}${fromDay}`;
  const to = r.to_at_least ? `still there at ${r.to}${toDay}` : `${r.to}${toDay}`;
  return `${from}–${to}`;
}
const basisNote = (r) => (r.basis === 'inferred' ? 'the tracker was quiet, a fix at this spot either side'
  : r.basis === 'fixes and inferred' ? 'the tracker went quiet for part of the window' : '');
/* One line for a car-night, as the driver pages say it.
   "INFERRED" COMES FIRST (independent review, 2026-11-16, FIX-STATUS OVN12).
   The Activity row prints this on ONE line, cut with an ellipsis, and the
   first draft put the basis last: "Parked overnight at Dubai Marina
   (22:10–07:55) — inferred: …". At 390 px in the Classic skin the line ends
   at the span, so an inferred night read exactly like a watched one — the
   word the house rule says is always said was the word that was cut. The
   basis now rides on "Parked overnight" itself; the why follows. */
export function nightLine(r, { car = false, running = false } = {}) {
  const carWord = car ? ` (car ${r.plate})` : '';
  if (r.status === 'parked') {
    const span = spanWords(r);
    const b = basisNote(r);
    const tag = r.basis === 'inferred' ? ' (inferred)' : r.basis === 'fixes and inferred' ? ' (partly inferred)' : '';
    return { off: false,
      text: `Parked overnight${tag} ${r.area ? `at ${r.area}` : `on ${UNNAMED}`}${span ? ` (${span})` : ''}${carWord}`
        + (b ? ` — ${b}` : '') + (r.area ? '' : ` — ${r.reason}`) + (running ? ' — so far: the night is still running' : '') };
  }
  return { off: true, text: `Overnight${carWord}: ${STATUS_WORD[r.status] || r.status} — ${r.reason}`
    + (running ? ' (so far: the night is still running)' : '') };
}

/* ── 1. the fleet page ───────────────────────────────────────────────────── */
export async function fleetOvernight(host) {
  const max = lastNight();
  let night = max;
  const nav = el('div', 'toolbar ovn-nav');
  const out = el('div', 'stack ovn-out');
  host.innerHTML = '';
  host.append(nav, out);
  const draw = async () => {
    const prev = shiftDay(night, -1); const next = shiftDay(night, 1);
    nav.innerHTML = `<button type="button" class="btn" data-go="${esc(prev)}">← ${esc(wdm(prev))}</button>
      <label class="cap" for="ovnNight">Night of</label>
      <input type="date" id="ovnNight" class="btn" value="${esc(night)}" max="${esc(max)}">
      ${next <= max ? `<button type="button" class="btn" data-go="${esc(next)}">${esc(wdm(next))} →</button>` : ''}
      <span class="cap ovn-when">${esc(`${wdm(night)} into ${wdm(next)}: where each car stood 00:00–05:00`)}</span>`;
    nav.querySelectorAll('[data-go]').forEach((b) => { b.onclick = () => { night = b.dataset.go; draw(); }; });
    nav.querySelector('#ovnNight').onchange = (e) => {
      const v = String(e.target.value || '');
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= max) { night = v; draw(); }
    };
    out.innerHTML = '<p class="cap dim">Reading where each car stood overnight…</p>';
    const asked = night;
    const res = await read({ night }, readOpen(night));
    if (asked !== night || !out.isConnected) return;
    out.innerHTML = '';
    if (res.refused) { out.append(note(`Where cars spent the night is not shown to your role. ${res.refused}`)); return; }
    if (res.failed) { out.append(note(`Where cars spent the night could not be read: ${res.failed}`, 'warn')); return; }
    drawNight(out, res.body);
  };
  await draw();
}

function drawNight(out, body) {
  const n = body.nights?.[0];
  if (!n) { out.append(note('The answer held no night.')); return; }
  const cars = n.cars || [];
  /* data-fx="keep" on the lines below: they are figures and the state of
     the answer, not explanation, so the Arkiv fold layer (focus.js) must not
     cut them — "No reading" in the counts reads to it as an absence line and
     was clamped to one line at 390 px. */
  if (n.running) {
    out.append(keep(el('p', 'cap ovn-running', esc(`This night is still running: its window closes at 05:00 on ${wdm(n.window.on)}, `
      + 'so each car is placed by the window so far.'))));
  }
  /* Where the fleet slept, the commonest first. */
  const parked = (n.by_area || []);
  const named = parked.filter((a) => a.area);
  const unnamed = parked.find((a) => !a.area);
  const shown = named.slice(0, 8);
  const rest = named.slice(8).reduce((t, a) => t + a.n, 0);
  const areas = keep(el('p', 'ovn-areas'));
  areas.innerHTML = parked.length
    ? `<b>Where the fleet slept:</b> ${shown.map((a) => `<span class="num">${a.n}</span> ${esc(a.area)}`).join(', ')}`
      + (rest ? `, <span class="num">${rest}</span> in ${named.length - 8} more ${named.length - 8 === 1 ? 'area' : 'areas'}` : '')
      + (unnamed ? `${shown.length ? ', and ' : ''}<span class="num">${unnamed.n}</span> on ${UNNAMED} <span class="ent-off">(${esc('ground the fleet has never driven near has no name')})</span>` : '')
    : '<b>Where the fleet slept:</b> <span class="ent-off">no car stood in one place for most of this night’s window</span>';
  out.append(areas);
  const c = n.counts || {};
  const chips = [
    ['parked', 'Parked, seen', c.parked, 'the tracker watched it stand there for most of its window minutes'],
    ['inferred', 'Parked, inferred', c.inferred, body.rules?.inferred || 'parked with the tracker quiet'],
    ['unknown', 'Not known', c.unknown, body.rules?.unknown || ''],
    ['noread', 'No reading', (c.silent || 0) + (c.no_tracker || 0), body.rules?.silent || ''],
    ['moving', 'On the move', c.moving, body.rules?.moving || ''],
  ];
  const counts = keep(el('p', 'ovn-counts'));
  counts.innerHTML = chips.map(([k, label, v, why]) => `<span class="ovn-chip" data-k="${k}" title="${esc(why)}">${esc(label)} `
    + `<b class="num">${v ?? 0}</b></span>`).join(' ')
    + (body.roster?.silent_week ? ` <span class="ovn-chip ent-off" title="${esc((body.roster.silent_plates || []).join(', '))}">`
      + `${body.roster.silent_week} more ${body.roster.silent_week === 1 ? 'car' : 'cars'} on CABMAN’s list sent nothing all week — not in the table</span>` : '');
  out.append(counts);

  const rows = cars.map((r) => {
    const parkedRow = r.status === 'parked';
    return { ...r,
      /* The cars the night does NOT account for first — they are what an
         operator acts on — then the parked by area, the unnamed last. */
      where_sort: parkedRow ? (r.area ? `1 ${r.area}` : `2 ${UNNAMED}`) : `0 ${STATUS_WORD[r.status] || r.status}`,
      when_sort: parkedRow ? `${r.from_day} ${r.since_at_least ? '00:00' : r.from}` : '~',
      basis_word: parkedRow ? BASIS_WORD[r.basis] || r.basis : null,
      tracker_word: trackerWord(r.source) };
  });
  const tbl = tableFrom(rows, [
    { label: 'Car', key: 'plate', render: (r) => `<a class="lnk" href="${esc(href('vehicle', r.plate, 'whereabouts', { day: shiftDay(r.night, 1) }))}" `
      + `title="${esc(`${r.plate}: where it was on ${wdm(shiftDay(r.night, 1))}, minute by minute`)}">${esc(r.plate)}</a>` },
    { label: 'Where it spent the night', key: 'where_sort', render: (r) => {
      if (r.status === 'parked' && r.area) return esc(r.area);
      if (r.status === 'parked') return `<span class="ent-off ovn-why">${UNNAMED} — ${esc(r.reason || '')}</span>`;
      return `<span class="ent-off ovn-why"><b>${esc(STATUS_WORD[r.status] || r.status)}</b> — ${esc(r.reason || '')}</span>`;
    } },
    { label: 'From – to', key: 'when_sort', render: (r) => (r.status === 'parked'
      ? `<span class="num">${esc(spanWords(r, { days: true }))}</span>` : '<span class="ent-off">—</span>') },
    { label: 'Basis', key: 'basis_word', render: (r) => (r.basis_word
      ? `<span title="${esc(r.how || '')}">${esc(r.basis_word)}</span>` : '<span class="ent-off">—</span>') },
    { label: 'Tracker', key: 'tracker_word' },
  ], { sortable: true, sortId: 'ovn', defaultSort: { key: 'where_sort', dir: 'asc' }, cards: true, cardLead: 'plate' });
  foldRows(out, tbl, { shown: 12, total: rows.length, noun: 'car', key: 'vehicles-ovn' });
  out.append(el('p', 'cap ovn-pop', esc(`${body.population} The night of ${wdm(n.night)} is 00:00–05:00 on ${wdm(n.window.on)}; `
    + 'the place is the stay that held the car longest in that window, from its tracker alone — no booking is read. '
    + `${body.area_why || ''}`)));
}

/* ── shared by the two driver pages: one read over the cars and nights ─────
   At most 10 plates and 31 nights a call (the route's own bounds), so a
   person who drove more cars, or whose drawn days span more than a month,
   is asked in pieces; the answers are merged by plate and night. */
/* Plates as every collector writes them (uppercase, no spaces or dashes):
   the route answers in that form, so a booking's "A 12345" is looked up as
   "A12345". */
export const normPlate = (s) => String(s || '').toUpperCase().replace(/[\s-]+/g, '');
async function readCarNights(plates, nights) {
  const ps = [...new Set(plates.filter(Boolean).map(normPlate))];
  const ns = [...new Set(nights)].sort();
  const map = new Map();
  if (!ps.length || !ns.length) return { map };
  const spans = [];
  for (let i = 0; i < ns.length;) {
    const from = ns[i]; let to = from;
    while (i < ns.length && ns[i] <= shiftDay(from, MAX_NIGHTS - 1)) { to = ns[i]; i += 1; }
    spans.push([from, to]);
  }
  const calls = [];
  for (let i = 0; i < ps.length; i += MAX_PLATES) {
    for (const [from, to] of spans) calls.push({ plates: ps.slice(i, i + MAX_PLATES).join(','), from, to });
  }
  const res = await Promise.all(calls.map((c) => read(c, readOpen(c.to))));
  const refused = res.find((x) => x.refused)?.refused || null;
  const failed = res.find((x) => x.failed)?.failed || null;
  for (const x of res) {
    for (const n of x.body?.nights || []) for (const r of n.cars || []) map.set(`${r.plate}|${n.night}`, { r, running: n.running });
  }
  return { map, refused, failed };
}

/* ── 2. the Activity list ────────────────────────────────────────────────
   `days`: [{ day, plate, plates }] for the rows drawn — `plate` the car the
   person drove LAST that day, `plates` how many cars they drove. Each row
   already holds its `.sh-n` line (driver.js draws it, so every row is the
   same height from the first paint); this fills it in. */
export async function activityNights(barsHost, days) {
  const last = lastNight();
  const lineOf = (day) => barsHost.querySelector(`.shift[data-day="${day}"] .sh-n`);
  const set = (day, text, off = true) => {
    const ln = lineOf(day);
    if (!ln) return;
    ln.textContent = text;
    ln.title = text;
    ln.classList.toggle('ent-off', off);
    ln.classList.remove('dim');
    ln.dataset.state = 'done';
  };
  const ask = days.filter((d) => d.plate && d.day <= last);
  const { map, refused, failed } = await readCarNights(ask.map((d) => d.plate), ask.map((d) => d.day));
  for (const d of days) {
    if (!d.plate) { set(d.day, 'Overnight: no booking that day names a car, so there is no car to follow overnight.'); continue; }
    if (d.day > last) { set(d.day, 'Overnight: the night after this day has not begun yet.'); continue; }
    const hit = map.get(`${normPlate(d.plate)}|${d.day}`);
    if (!hit) {
      set(d.day, refused ? `Overnight: ${refused}` : `Overnight: could not be read${failed ? ` — ${failed}` : ''}.`);
      continue;
    }
    const w = nightLine(hit.r, { car: d.plates > 1, running: hit.running });
    set(d.day, w.text, w.off);
  }
}

/* ── 3. the driver's day ─────────────────────────────────────────────────
   The night BEFORE the day (night D−1: the car first driven, where it stood
   when the day began) and the night AFTER (night D: the car last driven,
   where it was left). */
export async function dayOvernight(host, { day, first, last: lastCar, noCarWhy = null }) {
  host.innerHTML = '<p class="cap dim">Reading where the cars stood overnight…</p>';
  const latest = lastNight();
  const before = shiftDay(day, -1);
  const want = [];
  if (first) want.push([first, before]);
  if (lastCar && day <= latest) want.push([lastCar, day]);
  const { map, refused, failed } = await readCarNights(want.map((w) => w[0]), want.map((w) => w[1]));
  if (!host.isConnected) return;
  host.innerHTML = '';
  const row = (label, sub, car, night, which) => {
    const div = el('div', 'ovn-day-row');
    div.dataset.which = which;
    const head = `<div class="ovn-day-h"><b>${esc(label)}</b> <span class="cap">${esc(sub)}</span></div>`;
    let body;
    if (!car) {
      body = `<div data-fx="keep" class="ent-off">${esc(noCarWhy || `No booking this day names a car, so there is no car to follow ${which === 'before' ? 'into the morning' : 'into the night'}.`)}</div>`;
    } else if (which === 'after' && day > latest) {
      body = `<div data-fx="keep" class="ent-off">${esc(`${car} — the night after this day has not begun yet: it is read 00:00–05:00 on ${wdm(shiftDay(day, 1))}.`)}</div>`;
    } else {
      const hit = map.get(`${normPlate(car)}|${night}`);
      if (!hit) {
        body = `<div data-fx="keep" class="ent-off">${esc(refused ? refused : `Could not be read${failed ? ` — ${failed}` : ''}.`)}</div>`;
      } else {
        const r = hit.r;
        const w = nightLine(r, { running: hit.running });
        const to = href('vehicle', car, 'whereabouts', { day: shiftDay(night, 1) });
        body = `<div data-fx="keep" class="${w.off ? 'ent-off' : ''}"><b>${esc(car)}</b>, the car ${which === 'before' ? 'first' : 'last'} driven this day — `
          + `${esc(w.text.replace(/^Overnight: /, ''))}`
          + `<span class="cap"> · ${r.basis === 'fixes' ? 'seen by the tracker · ' : ''}${esc(trackerWord(r.source))}</span>`
          + ` <a class="lnk" href="${esc(to)}">where it was ↗</a></div>`;
      }
    }
    div.innerHTML = head + body;
    return div;
  };
  host.append(row('The night before', `${wdm(before)} into ${wdm(day)}, 00:00–05:00`, first, before, 'before'));
  host.append(row('The night after', `${wdm(day)} into ${wdm(shiftDay(day, 1))}, 00:00–05:00`, lastCar, day, 'after'));
  host.append(el('p', 'cap', esc('The place is the stay that held the car longest between 00:00 and 05:00, from its tracker alone. '
    + '“Inferred” is a car the tracker last and next saw at one spot with nothing reported between.')));
}
