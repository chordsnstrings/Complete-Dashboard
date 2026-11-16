/* ── #vehicle/<plate>/whereabouts — WHERE IT WAS, every minute of a day ────
   The operator, 2026-11-16: "whether pick up or drop off, we should ideally
   know where the car was at all times. currently we just focus on trips, but
   if we can figure out where the car is at all time that would be great too."

   The Movement tab draws the fixes on a map and lists movement periods; it
   never said which minutes of a day were watched and which were not. This
   tab is /api/vehicle/whereabouts drawn as a day: a 24-hour strip (stays by
   area, drives, quiet stretches hatched or outlined by what kind of quiet
   they are), the stays as a table, every stretch in order with its sentence,
   and three coverage figures — positioned, inferred, unknown — never one.

   Loaded only when the tab opens (vehicle.js imports it on demand), so the
   vehicle page's other six tabs do not carry it (test/lazy_pages.test.mjs).
   Nothing here runs at load.

   Under the Arkiv page contract: 00 at a glance (the verdict states all three
   figures; the hero is the positioned share), numbered panels, the † band of
   what the page does not know, and the footer's basis and colophon. Under the
   old skin the same content draws as a tile row and plain panels: this tab is
   new, so it has no classic drawing to keep.

   Every figure that cannot be measured is absent with its reason: a day with
   no fix says which kind of silence it is; an area the fleet has never named
   is "unnamed ground", with why; a role that may not see bookings is told the
   quiet stretches are left as the tracker left them, never handed fewer
   minutes as if that were the whole answer. */
import { el, esc, panel, loading, tableFrom, kpiRow, note, contract, glanceBand, glance, verdict,
  absenceBand, pageFoot, sourceLabel, dayStr } from './ui.js';
import { qAll, href, parseHash, currentGen, alive } from './data.js';
import { dubaiDay } from './tz.js';
import { withheldSentence } from './access_model.js';

const hhmm = (m) => (m >= 1440 ? '24:00'
  : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const dur = (m) => (m == null ? '—' : m < 60 ? `${m} min`
  : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`);
const pct = (x) => (x == null ? null : `${Number(x).toFixed(1)}%`);
const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const UNNAMED = 'unnamed ground';
const UNNAMED_WHY = 'no trip in the fleet’s history has named this half-kilometre cell';
const trackerWord = (s) => (s === 'fms' ? 'FMS' : s === 'cabman' ? 'CABMAN' : sourceLabel(s));
/* What each kind of stretch is called, in the strip's legend and the log. */
const WHAT = {
  stay: 'Stood', drive: 'Drove', parked: 'Parked, tracker quiet', moved: 'Moved unseen',
  booking: 'On a booking', before_first: 'Before the first fix', after_last: 'After the last fix',
  silent: 'No reading', no_tracker: 'No tracker',
};
const kindOf = (s) => (s.kind === 'quiet' ? s.quiet : s.kind);
const where = (s) => {
  if (s.kind === 'stay' || s.quiet === 'parked') return s.area || UNNAMED;
  if (s.kind === 'drive' || s.quiet === 'moved' || s.quiet === 'booking') {
    return `${s.from_area || UNNAMED} → ${s.to_area || UNNAMED}`;
  }
  return '—';
};
const BASIS_WORD = { fixes: 'tracker fixes', inferred: 'inferred', unknown: 'not known' };
const sinceTime = (iso) => new Date(Date.parse(iso) + 4 * 3600e3).toISOString().slice(11, 16);

export async function tabWhereabouts(root, plate) {
  const gen = currentGen();
  const ak = contract();
  const today = dubaiDay();
  const asked = parseHash().day;
  const day = asked && asked <= today ? asked : today;

  /* The day picker: yesterday · a date · tomorrow (never past today). The
     address carries the day (?day=), so a day can be linked and reloaded. */
  const to = (d) => href('vehicle', plate, 'whereabouts', d === today ? null : { day: d });
  const bar = el('div', 'toolbar whr-nav');
  const prev = shiftDay(day, -1); const next = shiftDay(day, 1);
  bar.innerHTML = `<a class="btn" href="${esc(to(prev))}">← ${esc(dayStr(`${prev}T12:00:00`))}</a>
    <label class="cap" for="whrDay">Day</label>
    <input type="date" id="whrDay" class="btn" value="${esc(day)}" max="${esc(today)}">
    ${next <= today ? `<a class="btn" href="${esc(to(next))}">${esc(dayStr(`${next}T12:00:00`))} →</a>` : ''}
    ${day !== today ? `<a class="btn" href="${esc(to(today))}">today</a>` : '<span class="cap">today</span>'}`;
  root.append(bar);
  bar.querySelector('#whrDay').onchange = (e) => {
    const v = String(e.target.value || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(v) && v <= today) location.hash = to(v);
  };
  const body = el('div', 'stack'); root.append(body);
  loading(body);

  let r;
  try { r = await qAll('/api/vehicle/whereabouts', { plate, day }); } catch (e) {
    if (!alive(gen)) return;
    body.innerHTML = '';
    body.append(note(`Where this car was could not be read: ${e.message || e}`));
    return;
  }
  if (!alive(gen) || !root.isConnected) return;
  body.innerHTML = '';
  const d = r.days?.[0];
  if (!d) { body.append(note('The answer held no day.')); return; }
  /* with_bookings is the same day with the car's bookings laid into its quiet
     stretches. Withheld (null) from a role that sees bookings as totals only:
     then the tracker's own account is drawn, and that is said. */
  const wb = d.with_bookings || null;
  const v = wb || d;
  const c = v.coverage;
  const tr = d.tracker || {};
  const dayWord = day === today ? 'today' : dayStr(`${day}T12:00:00`);
  const segs = v.segments || [];
  const silent = segs.find((s) => s.quiet === 'silent' || s.quiet === 'no_tracker');

  /* ── 00 · at a glance ──────────────────────────────────────────────────── */
  const tiles = [
    { label: 'Positioned by fixes', value: pct(c.positioned_pct), hero: true,
      sub: `${dur(c.positioned_min)} of ${dur(c.minutes)} — the tracker watched it stand or drive` },
    { label: 'Inferred', value: pct(c.inferred_pct),
      sub: `${dur(c.inferred_min)} — parked with the tracker quiet` },
    /* A booking in a silence is counted here, with its two ends pinned
       above the strip: the job places the car at its pickup and drop-off,
       not on the road between (independent review, 2026-11-16). */
    { label: 'Unknown', value: pct(c.unknown_pct),
      sub: `${dur(c.unknown_min)} — moved unseen${wb ? ' (on a booking or not)' : ''}, before the first fix or after the last, or silent` },
    /* A tracker that sent nothing this day is named with its silence, never
       as "0 fixes" beside its name — which reads as a tracker that worked and
       found nothing (the render pass caught it on a unit dead for days). */
    tr.source && !tr.fixes
      ? { label: 'Tracker', na: `${trackerWord(tr.source)} — ${silent?.say || `no fix ${day === today ? 'yet today' : 'on this day'}`}` }
      : tr.source
      ? { label: 'Tracker', value: trackerWord(tr.source),
        sub: `${tr.fixes} fixes ${day === today ? 'so far' : 'that day'}${tr.every_min ? `, about every ${tr.every_min} min while watched` : ''}` }
      : { label: 'Tracker', na: silent?.say || 'no tracker position is on record for this car' },
  ];
  const claim = `${plate} ${day === today ? 'so far today' : `on ${dayWord}`}: ${pct(c.positioned_pct)} positioned by its tracker, `
    + `${pct(c.inferred_pct)} inferred, ${pct(c.unknown_pct)} unknown.`;
  const sub = d.running ? `The day is still running: ${dur(d.minutes)} of it so far, to ${d.to}.`
    : 'Every minute of the Dubai day, 00:00 to 24:00.';
  if (ak) {
    const g = glanceBand(body);
    verdict(g.vHost, { claim, sub });
    glance(g.tilesHost, tiles);
  } else {
    body.append(el('p', 'cap', esc(`${claim} ${sub}`)));
    body.append(kpiRow(tiles));
  }

  /* ── 01 · the strip ────────────────────────────────────────────────────── */
  const stripP = panel('The day, midnight to midnight',
    'Solid: watched by the tracker. Hatched: inferred. Outlined: not known. Hover a stretch for what it was.', 'whr-strip');
  body.append(stripP.panel);
  const w = (m) => `${(m / 1440) * 100}%`;
  const strip = el('div', 'whr-strip');
  strip.setAttribute('role', 'img');
  strip.setAttribute('aria-label', `${plate}, ${dayWord}: ${segs.map((s) => `${s.from}–${s.to} ${WHAT[kindOf(s)]}`).join('; ')}`);
  strip.innerHTML = segs.map((s) => `<i class="whr-seg whr-${esc(kindOf(s))}" data-kind="${esc(kindOf(s))}" style="left:${w(s.start_min)};width:${w(s.minutes)}" title="${
    esc(`${s.from}–${s.to} · ${s.say || WHAT[kindOf(s)]}`)}"></i>`).join('')
    + (d.running ? `<i class="whr-future" style="left:${w(d.minutes)};width:${w(1440 - d.minutes)}" title="${esc(`after ${d.to}: still to come`)}"></i>` : '')
    ;
  /* A booking's pickup and drop-off, where they fall in a quiet stretch: a pin
     above the strip, never a mark inside it — the strip is what the tracker
     and the inference say, and a pin is a different kind of evidence. */
  const anchors = wb?.anchors || [];
  if (anchors.length) {
    const pins = el('div', 'whr-pins');
    pins.innerHTML = anchors.map((a) => `<b class="whr-anchor" style="left:${w(a.minute)}" title="${
      esc(`${a.time} · ${a.end === 'pickup' ? 'picked up' : 'dropped off'} in ${a.area || UNNAMED} — from a booking, not a tracker fix`)}"></b>`).join('');
    stripP.body.append(pins);
  }
  stripP.body.append(strip);
  /* The ground of each stay, under it, where the stay is wide enough to say —
     one label a stay, its watched and parked-quiet stretches together. */
  const labels = el('div', 'whr-labels');
  labels.innerHTML = (v.stays || []).filter((s) => s.minutes >= 75)
    .map((s) => `<span style="left:${w(s.start_min)};width:${w(s.minutes)}" title="${esc(s.area || UNNAMED_WHY)}">${esc(s.area || UNNAMED)}</span>`).join('');
  stripP.body.append(labels);
  const ruler = el('div', 'whr-ruler');
  ruler.innerHTML = [0, 6, 12, 18, 24].map((h) => `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');
  stripP.body.append(ruler);
  const present = [...new Set(segs.map(kindOf))];
  const legend = el('div', 'whr-legend');
  legend.innerHTML = present.map((k) => `<span><i class="whr-seg whr-${esc(k)}"></i>${esc(WHAT[k])}</span>`).join('')
    + (anchors.length ? '<span><b class="whr-anchor"></b>a booking’s pickup or drop-off, from the booking</span>' : '');
  stripP.body.append(legend);
  if (!wb) stripP.body.append(note(`Bookings: ${withheldSentence('BK', { level: 'A' })} So the quiet stretches are left as the tracker left them; a job that ran in one is not shown.`));
  else if (wb.bookings) {
    /* Stretches, not bookings: one job that runs quiet–watched–quiet is two
       stretches, and counting them as bookings said "2" of one. */
    const inQuiet = segs.filter((s) => s.quiet === 'booking').length;
    stripP.body.append(el('p', 'cap', esc(`${wb.bookings} completed ${wb.bookings === 1 ? 'booking' : 'bookings'} in this car that day; `
      + `${inQuiet ? `${inQuiet} quiet ${inQuiet === 1 ? 'stretch was' : 'stretches were'} on a booking — its pickup and drop-off pin the car there, labelled “from a booking”, the route between is not known` : 'none fell in a quiet stretch'}.`)));
  }
  if (tr.second) {
    stripP.body.append(el('p', 'cap', esc(`This car also carries a ${trackerWord(tr.second.source)} unit (${tr.second.fixes} fixes that day). `
      + `The tracker with more fixes is read, and the two are never mixed: each walks the same road, and alternating them would draw zig-zags.`)));
  }

  /* ── 02 · where it stood ───────────────────────────────────────────────── */
  const stays = v.stays || [];
  const stayP = panel('Where it stood', `Each stay, by the fleet’s own name for the ground. A stay is fixes within ${r.rules?.stay_radius_m ?? 150} m of where it began for ${r.rules?.stay_min ?? 10} minutes or more.`, 'whr-stays');
  body.append(stayP.panel);
  if (!stays.length) {
    stayP.body.append(note(silent ? silent.say : 'The tracker saw no stay of ten minutes or more on this day.'));
  } else {
    stayP.body.append(tableFrom(stays, [
      { label: 'Area', key: 'area', render: (s) => (s.area ? esc(s.area)
        : `<span class="dim" title="${esc(UNNAMED_WHY)}">${esc(UNNAMED)}</span>`) },
      /* The time it was there since, and "at least" when that is the earliest
         fix the day was read with — the stay may reach further back. */
      { label: 'From', key: 'start_min', render: (s) => esc(s.from) + (s.carried_in
        ? ` <span class="dim">(since ${s.since_at_least ? 'at least ' : ''}${esc(sinceTime(s.since))} the day before)</span>` : '') },
      { label: 'To', key: 'end_min', render: (s) => esc(s.to) + (s.carried_on ? ' <span class="dim">(and on)</span>' : '') },
      { label: 'For', key: 'minutes', num: true, render: (s) => esc(dur(s.minutes)) },
      { label: 'How it is known', key: 'basis', render: (s) => esc(s.how) },
    ], { compact: true, sortable: true, sortId: 'whr-stays' }));
  }

  /* ── 03 · every stretch ────────────────────────────────────────────────── */
  const logP = panel('Every stretch of the day', 'In order, each with what it rests on. Nothing is drawn between two fixes the tracker did not send.', 'whr-log');
  body.append(logP.panel);
  logP.body.append(tableFrom(segs, [
    { label: 'Time', key: 'start_min', render: (s) => `${esc(s.from)}–${esc(s.to)}` },
    { label: 'What', key: 'kind', render: (s) => esc(WHAT[kindOf(s)] || s.kind) },
    { label: 'Where', key: 'area', render: (s) => esc(where(s)) },
    { label: 'For', key: 'minutes', num: true, render: (s) => esc(dur(s.minutes)) },
    { label: 'km', key: 'km', num: true, render: (s) => (s.kind === 'drive'
      ? `${esc(String(s.km))}${s.km_basis === 'fms_journey' ? ' <span class="dim">FMS journey</span>' : ''}`
      : s.quiet === 'moved' && s.apart_km != null ? `<span class="dim">${esc(String(s.apart_km))} apart</span>` : '') },
    { label: 'Basis', key: 'basis', render: (s) => esc(BASIS_WORD[s.basis] || s.basis) },
    { label: 'What it means', key: 'say', render: (s) => esc(s.say || '') },
  ], { compact: true }));

  /* ── † what this page does not know ────────────────────────────────────── */
  const minsOf = (k) => segs.filter((s) => kindOf(s) === k).reduce((a, s) => a + s.minutes, 0);
  const unnamed = stays.filter((s) => !s.area).length;
  const cells = [
    /* A booking in a silence is movement nobody tracked as well: its two ends
       are pinned, the minutes between are not placed. "None", never "None
       today": the tab draws any day. */
    { label: 'Position between fixes', fig: minsOf('moved') + minsOf('booking') ? dur(minsOf('moved') + minsOf('booking')) : null, none: 'None',
      why: 'Trackers send points, not routes. A drive is “from → to” with the distance its fixes walked; a stretch the car moved through '
        + 'while the tracker was silent has no route at all — its two ends and how far apart they are, and nothing drawn between. '
        + 'A booking in such a stretch pins where the job began and ended, not the road between.' },
    { label: 'Parked with the tracker quiet', fig: minsOf('parked') ? dur(minsOf('parked')) : null, none: 'None',
      why: `Inferred, never watched: a fix at one spot either side and no report between. Trackers file on movement, but past their rhythm `
        + `(CABMAN ${r.rules?.parked_cadence_min?.cabman ?? 70} min, FMS ${r.rules?.parked_cadence_min?.fms ?? 30}) whether the unit was alive in between is not known.` },
    { label: 'Silent over a day', fig: segs.some((s) => s.quiet === 'silent') ? 'Yes' : null, none: 'No',
      why: 'Past a day a parked car and a dead tracker look the same until the car moves, so a day’s silence is never called parked: '
        + '“no reading since” is all that can be said.' },
    { label: 'Areas', fig: unnamed ? `${unnamed} unnamed` : null, none: 'All named',
      why: 'An area is the fleet’s own name for a half-kilometre cell, learnt from its FMS trips — not a street address. '
        + 'Ground the fleet never drove near has no name and is left unnamed rather than guessed.' },
  ];
  if (ak) absenceBand(body, cells);
  else {
    const p = panel('What this page does not know', 'The true reason for each');
    body.append(p.panel);
    cells.forEach((x) => p.body.append(el('p', 'cap', `<b>${esc(x.label)}: ${esc(x.fig || x.none)}.</b> ${esc(x.why)}`)));
  }
  /* What it was built from, in the page itself: the footer's basis slot is
     the shell's source line on this page, as on the other vehicle tabs. */
  body.append(el('p', 'cap whr-basis', esc(`Built from this car's own tracker fixes (CABMAN or FMS — never both mixed), `
    + `${wb ? 'its completed bookings and ' : ''}FMS's own journeys. Watched: ${r.rules?.watched || ''}. Inferred: ${r.rules?.inferred || ''}. `
    + `Unknown: ${r.rules?.unknown || ''}.`)));
  pageFoot({ colophon: [plate, day, tr.source ? `${trackerWord(tr.source)} · ${tr.fixes} fixes` : 'no fixes', 'Dubai time'] }, root);
}
