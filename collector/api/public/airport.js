/* #airport — flights landing at Dubai, the fleet's airport trips, and how
   the two move together.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-11-16: "add flight details and flights actually
   landing, and how that impacts the airport trips. use api - any free api."

   One Dubai day at a time (the day in the address: #airport/2026-11-15, and
   the airport after it: #airport/2026-11-15/both), read from /api/airport
   (api/airport_routes.js):
     00 at a glance — landings, airport pickups and drop-offs, the
        relationship at its best lag;
     01 hour by hour — landings over airport pickups on the same 24 hours,
        two charts one above the other (two measures, two scales: one axis
        each, never a second axis on one chart);
     02 each hour — the figures and what each landing count rests on;
     03 the impact over a window of days — the correlation at lags 0–3 h,
        pickups per 10 landings, the daily totals, and the caveat;
     04 where the landings came from — OpenSky's estimated origins;
     05 the airport trips by platform;
     † what the page does not know.

   Two sources, never blended without saying so. Landings are OpenSky's
   nightly confirmed list where that UTC day is in; today (until the list
   arrives) they are LIVE ESTIMATES inferred from final approaches, drawn
   hatched and named "live" in every row they touch. An hour neither covers
   has no bar and says why. Airport trips are found by address text, and
   "Airport Rd – Al Garhoud" is a road, not the airport.

   Three things the review of 2026-11-16 corrected (FIX-STATUS FLT-R3):
     · WHOSE BOOKINGS. The head said "the airport trips are the fleet’s,
       both fleets" whatever the answer held. The page sends no fleet (it is
       in NO_FILTER), but the access gate writes a one-fleet reader's fleet
       into ?fleet= (api/access/middleware.js), and the route then counts
       that fleet's bookings only — so for that reader the sentence was
       false. It now says whose bookings the answer counts, from `d.fleet`.
     · THE LEAD. "Pickups follow landings … — r 0.12" claimed a relationship
       r 0.12 does not show: the best lag is the highest r, however small.
       The verb now carries the strength (closely / — / weakly / do not).
     · empty() ESCAPES ITS MESSAGE (charts.js), so a reason passed through
       esc() first was escaped twice: an error carrying "<!DOCTYPE" read
       "&lt;!DOCTYPE". The reasons go to empty() as plain text. */
import { el, esc, panel, tableFrom, kpiRow, pill, dayStr, timeStr, contract, glance, glanceBand, bandTiles,
  absenceBand, pageFoot, countOf, sourceLabel } from './ui.js';
import { dubaiDay } from './tz.js';
import { barChart, empty, fmt } from './charts.js';
import { api, href } from './data.js';
import { fleetLabel, allFleetsLabel } from './access.js';

const HH = (h) => `${String(h).padStart(2, '0')}:00`;
const AIRPORTS = [['dxb', 'OMDB', 'DXB — Dubai International'], ['dwc', 'OMDW', 'DWC — Al Maktoum'], ['both', 'both', 'DXB and DWC']];
const WINDOWS = [14, 28, 60];
const BASIS_WORD = { confirmed: 'OpenSky list', live: 'live estimate', absent: 'not measured', future: '—' };
const pct = (v) => (v == null ? '—' : `${fmt(v, 1)}%`);
/* A day as YYYY-MM-DD, moved by whole days — noon-anchored, so the UTC date
   read back cannot cross a midnight (test/timezone.test.mjs). */
const shiftDay = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

export async function renderAirport(root, param, sub) {
  root.innerHTML = '';
  const today = dubaiDay();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(param || '')) && param <= today ? param : today;
  const pick = AIRPORTS.find((a) => a[0] === String(sub || '').toLowerCase()) || AIRPORTS[0];
  let days = 28;
  const ak = contract();
  const AKB = ak ? glanceBand(root, null) : null;

  const head = panel('The day, the airport and the window', 'Landings are Dubai’s, the same for every reader; the airport trips are the fleet’s bookings', 'ap-head');
  const headCap = head.panel.querySelector('p.cap');
  root.append(head.panel);
  const controls = el('div', 'btnrow');
  controls.style.cssText = 'margin:10px 0;gap:10px;align-items:center;flex-wrap:wrap';
  const prev = el('button', 'btn', '‹ Day before'); prev.type = 'button';
  const next = el('button', 'btn', 'Day after ›'); next.type = 'button';
  const dayIn = el('input'); dayIn.type = 'date'; dayIn.className = 'inp'; dayIn.value = day; dayIn.max = today;
  dayIn.setAttribute('aria-label', 'Day');
  const apIn = el('select', 'inp'); apIn.setAttribute('aria-label', 'Airport');
  apIn.innerHTML = AIRPORTS.map(([k, , label]) => `<option value="${k}"${k === pick[0] ? ' selected' : ''}>${esc(label)}</option>`).join('');
  const winIn = el('select', 'inp'); winIn.setAttribute('aria-label', 'Window for the relationship');
  winIn.innerHTML = WINDOWS.map((n) => `<option value="${n}"${n === days ? ' selected' : ''}>${n} days for the relationship</option>`).join('');
  controls.append(prev, dayIn, next, apIn, winIn);
  head.body.append(controls);
  const tiles = el('div'); head.body.append(tiles);

  const chartP = panel('Landings and airport pickups, hour by hour', 'Dubai hours of this day: landings above, the fleet’s airport pickups below', 'ap-chart');
  const hoursP = panel('Each hour', 'Landings, what they rest on, and the fleet’s airport pickups, drop-offs and bookings', 'ap-hours');
  const impactP = panel('How landings move airport pickups', 'Over the window: landings in an hour against airport pickups then and in the next three hours', 'ap-impact');
  const originP = panel('Where the landings came from', 'OpenSky’s estimate of each flight’s departure airport', 'ap-origins');
  const platP = panel('Airport trips by platform', 'This day’s bookings whose address names the airport', 'ap-platforms');
  root.append(chartP.panel, hoursP.panel, impactP.panel, originP.panel, platP.panel);
  const absHost = el('div'); root.append(absHost);

  const go = (d, a = pick[0]) => { location.hash = href('airport', d, a === 'dxb' ? null : a); };
  prev.onclick = () => go(shiftDay(day, -1));
  next.onclick = () => { const n = shiftDay(day, 1); if (n <= today) go(n); };
  next.disabled = day >= today;
  dayIn.onchange = () => { if (dayIn.value) go(dayIn.value); };
  apIn.onchange = () => go(day, apIn.value);
  winIn.onchange = () => { days = Number(winIn.value) || 28; draw(); };

  const draw = async () => {
    [chartP, hoursP, impactP, originP, platP].forEach((p) => { p.body.innerHTML = '<div class="loading">Loading…</div>'; });
    let d;
    try {
      d = await api(`/api/airport?day=${encodeURIComponent(day)}&airport=${pick[1]}&days=${days}`);
    } catch (e) {
      [chartP, hoursP, impactP, originP, platP].forEach((p) => { p.body.innerHTML = ''; empty(p.body, `Could not load the airport: ${String(e.message || e)}`); });
      return;
    }
    const Lg = d.landings || {};
    const Bk = d.bookings || {};
    const Im = d.impact || {};
    const where = d.label || pick[2];
    if (headCap) {
      headCap.textContent = `Landings are Dubai’s, the same for every reader; the airport trips are ${d.fleet
        ? `${fleetLabel(d.fleet)}’s bookings only — the fleet your access covers` : `the bookings of ${allFleetsLabel().toLowerCase()}`}`;
    }

    /* ── 00 ── */
    const liveNote = Lg.live_hours ? ` · ${countOf(Lg.live_hours, 'hour')} live estimate` : '';
    const TILES = [
      { label: `Landings at ${where}`, hero: true,
        value: Lg.total != null ? fmt(Lg.total) : (Lg.hours_measured ? `${fmt(Lg.total_so_far)} so far` : '—'),
        sub: Lg.total != null ? `that OpenSky’s receivers saw${liveNote}`
          : (Lg.hours_measured ? `${Lg.hours_measured} of ${Lg.hours_past} hours measured${liveNote}` : (Lg.total_why || 'not measured')) },
      { label: 'Airport pickups', value: fmt(Bk.totals?.pickups),
        sub: Bk.totals?.bookings ? `${pct(Bk.totals.share_pickups_pct)} of ${countOf(Bk.totals.bookings, 'booking')}` : 'no booking on this day' },
      { label: 'Airport drop-offs', value: fmt(Bk.totals?.dropoffs), sub: 'passengers taken to fly' },
      { label: 'Landings → pickups', value: Im.r == null ? '—' : `r ${fmt(Im.r, 2)}`,
        sub: Im.r == null ? (Im.absent_why || 'not measured') : `strongest ${Im.best_lag ? `${Im.best_lag} h later` : 'in the same hour'}, over ${Im.days_complete} days` },
      { label: 'Pickups per 10 landings', value: Im.pickups_per_10_landings == null ? '—' : fmt(Im.pickups_per_10_landings, 1),
        sub: Im.pickups_per_10_landings == null ? (Im.absent_why || 'not measured') : `at that lag, over ${Im.days_complete} complete days` },
    ];
    if (ak) {
      AKB.tilesHost.innerHTML = '';
      glance(AKB.tilesHost, bandTiles(TILES).tiles);
    } else { tiles.innerHTML = ''; tiles.append(kpiRow(TILES)); }

    /* ── 01 ── */
    chartP.body.innerHTML = '';
    const rows = (Lg.hours || []).map((h, i) => ({ h: HH(h.hour).slice(0, 2), landings: h.n, live: h.basis === 'live',
      pickups: Bk.hours?.[i]?.pickups ?? null }));
    const lBox = el('div'); const pBox = el('div');
    const lCap = el('p', 'cap'); const pCap = el('p', 'cap');
    chartP.body.append(el('h4', 'ap-sub', `Landings at ${esc(where)}`), lBox, lCap, el('h4', 'ap-sub', 'Airport pickups (the fleet’s bookings)'), pBox, pCap);
    if (!rows.some((r) => r.landings != null)) {
      /* total_why already opens with "no hour of this day has a landing
         figure: …" (api/airport_routes.js), so it is printed as it stands —
         prefixed, the sentence said its first half twice. */
      const tw = Lg.total_why || 'no hour of this day has a landing figure';
      empty(lBox, `${tw.charAt(0).toUpperCase()}${tw.slice(1)}.`);
    } else {
      barChart(lBox, rows, { x: 'h', y: 'landings', label: 'landings', color: '--mk-fill',
        colorFor: (r) => (r.live ? '--b300' : null), projected: (r) => r.live, aria: `Landings at ${where} in each Dubai hour of ${day}` });
      const gaps = (Lg.hours || []).filter((h) => h.basis === 'absent');
      lCap.textContent = (Lg.live_hours ? 'Lighter, hatched bars are live estimates — landings inferred from aircraft on final approach, until OpenSky’s nightly list replaces them. ' : '')
        + (gaps.length ? `${countOf(gaps.length, 'hour')} ${gaps.length === 1 ? 'has' : 'have'} no bar because nothing measured ${gaps.length === 1 ? 'it' : 'them'}: ${gaps[0].why}.` : '');
    }
    if (!rows.some((r) => r.pickups)) {
      empty(pBox, Bk.totals?.bookings ? 'No booking on this day was picked up at the airport.' : 'No booking on this day yet.');
    } else {
      barChart(pBox, rows, { x: 'h', y: 'pickups', label: 'airport pickups', color: '--b400',
        aria: `The fleet’s airport pickups in each Dubai hour of ${day}` });
      pCap.textContent = 'Bookings whose pickup address names the airport, by the Dubai hour the booking was made, any outcome.';
    }

    /* ── 02 ── */
    hoursP.body.innerHTML = '';
    const tableRows = (Lg.hours || []).filter((h) => h.basis !== 'future').map((h) => ({ ...h, ...(Bk.hours?.[h.hour] || {}) }));
    if (!tableRows.length) empty(hoursP.body, 'This day has not started.');
    else {
      hoursP.body.append(tableFrom(tableRows, [
        { label: 'Hour', key: 'hour', sortValue: (h) => h.hour, render: (h) => `${HH(h.hour)}–${HH((h.hour + 1) % 24)}` },
        { label: 'Landings', key: 'n', num: true, render: (h) => (h.n == null ? `<span class="ent-off" title="${esc(h.why || 'not measured')}">—</span>`
          : `${fmt(h.n)}${h.so_far ? ' <span class="dim">so far</span>' : ''}`) },
        { label: 'From', key: 'basis', render: (h) => (h.basis === 'live' ? pill(BASIS_WORD.live, 'warn')
          : h.basis === 'absent' ? `<span class="ent-off" title="${esc(h.why || '')}">${esc(BASIS_WORD.absent)}</span>` : esc(BASIS_WORD[h.basis] || h.basis)) },
        { label: 'Airport pickups', key: 'pickups', num: true, render: (h) => fmt(h.pickups) },
        { label: 'Drop-offs', key: 'dropoffs', num: true, render: (h) => fmt(h.dropoffs) },
        { label: 'All bookings', key: 'bookings', num: true, render: (h) => fmt(h.bookings) },
      ], { compact: true, sortable: true, sortId: 'ap-hours', defaultSort: { key: 'hour', dir: 'asc' } }));
      const firstGap = tableRows.find((h) => h.basis === 'absent');
      if (firstGap) hoursP.body.append(el('p', 'cap', `An hour marked “not measured” has no landing figure: ${esc(firstGap.why)}. Hover it for that hour’s reason.`));
    }

    /* ── 03 ── */
    impactP.body.innerHTML = '';
    /* The finding and the caveat are each kept to one short line, so the
       focus layer (focus.js: a block of 15 words or fewer stays on the face
       of the page) never folds either under ⓘ; the long sentence and the
       caveat's reasoning fold, one click away. An absent finding is a
       statement of absence, which focus.js keeps visible whatever its
       length. */
    const lead = el('p', 'ap-lead');
    const detail = el('p', 'cap');
    const later = Im.best_lag ? `${Im.best_lag} ${Im.best_lag === 1 ? 'hour' : 'hours'} later` : 'in the same hour';
    if (Im.r == null) {
      lead.textContent = `Not measured over ${Im.from} – ${Im.to}: ${Im.absent_why}.`;
    } else {
      const strength = Math.abs(Im.r) >= 0.7 ? 'strongly' : Math.abs(Im.r) >= 0.4 ? 'moderately' : 'weakly';
      const verb = Im.r >= 0.7 ? 'closely follow' : Im.r >= 0.4 ? 'follow' : Im.r > 0 ? 'weakly follow' : 'do not follow';
      lead.textContent = `Pickups ${verb} landings ${later} — r ${fmt(Im.r, 2)}, ${fmt(Im.pickups_per_10_landings, 1)} per 10 landings.`;
      detail.textContent = `Over ${countOf(Im.days_complete, 'complete day')}, the fleet’s airport pickups rose and fell ${Im.r >= 0 ? strength : 'inversely'} `
        + `with the landings ${later}: for every 10 landings OpenSky saw, the fleet took ${fmt(Im.pickups_per_10_landings, 1)} airport pickups`
        + `${Im.slope_per_10_landings != null ? `, and an hour with 10 more landings came with ${fmt(Im.slope_per_10_landings, 1)} more` : ''}.`;
    }
    const caveat = el('p', 'cap ap-caveat', 'Correlation is not causation: both follow the time of day.');
    caveat.title = Im.caveat || '';
    impactP.body.append(lead, caveat);
    if (detail.textContent) impactP.body.append(detail, el('p', 'cap', esc(Im.caveat || '')));
    impactP.body.append(tableFrom(Im.lags || [], [
      { label: 'Pickups measured', key: 'lag', render: (x) => (x.lag ? `${x.lag} ${x.lag === 1 ? 'hour' : 'hours'} after the landings` : 'in the same hour')
        + (Im.best_lag === x.lag && Im.r != null ? ' <span class="dim">(strongest)</span>' : '') },
      { label: 'Correlation (r)', key: 'r', num: true, render: (x) => (x.r == null ? '<span class="ent-off" title="the hours do not vary">—</span>' : fmt(x.r, 2)) },
      { label: 'Pickups per 10 landings', key: 'pickups_per_10_landings', num: true, render: (x) => fmt(x.pickups_per_10_landings, 1) },
      { label: '+ per 10 more landings', key: 'slope_per_10_landings', num: true, render: (x) => fmt(x.slope_per_10_landings, 1) },
      { label: 'Hours compared', key: 'hours', num: true, render: (x) => fmt(x.hours) },
    ], { compact: true }));
    const dly = (Im.daily || []).slice().reverse();
    impactP.body.append(el('h4', 'ap-sub', 'Day by day'));
    impactP.body.append(tableFrom(dly, [
      { label: 'Day', key: 'day', render: (x) => `<a class="lnk" href="${href('airport', x.day, pick[0] === 'dxb' ? null : pick[0])}">${esc(dayStr(`${x.day}T12:00:00`))}</a>` },
      { label: 'Landings', key: 'landings', num: true, render: (x) => (x.landings == null ? `<span class="ent-off" title="${esc(x.landings_why || 'not measured')}">—</span>` : fmt(x.landings)) },
      { label: 'Airport pickups', key: 'pickups', num: true, render: (x) => fmt(x.pickups) },
      { label: 'Drop-offs', key: 'dropoffs', num: true, render: (x) => fmt(x.dropoffs) },
      { label: 'Share of bookings', key: 'share_pct', num: true, render: (x) => pct(x.share_pct) },
    ], { compact: true }));
    impactP.body.append(el('p', 'cap', `Across the window, ${pct(Im.share_pickups_pct)} of the fleet’s ${fmt(Im.bookings)} bookings were airport pickups. `
      + `Only days whose every hour of landings is on OpenSky’s confirmed list enter the correlation — ${Im.days_complete} of ${Im.days} here; `
      + 'a day without a figure says why when you hover it.'));

    /* ── 04 ── */
    originP.body.innerHTML = '';
    const og = d.origins?.day || d.origins?.window;
    const ogWhat = d.origins?.day ? 'this day' : `the ${Im.days} days to ${dayStr(`${day}T12:00:00`)}`;
    if (!og || !og.top?.length) {
      empty(originP.body, d.origins?.day_why ? `No origin to show: ${d.origins.day_why}.` : 'No confirmed landing with an origin in this window.');
    } else {
      if (!d.origins?.day && d.origins?.day_why) originP.body.append(el('p', 'cap', `Shown over ${esc(ogWhat)}: ${esc(d.origins.day_why)}.`));
      originP.body.append(tableFrom(og.top, [
        { label: 'From', key: 'origin', render: (x) => `${esc(x.name || x.origin)}${x.name ? ` <span class="dim">${esc(x.origin)}</span>` : ''}`
          + (x.note ? ` <span class="ent-off" title="${esc(x.note)}">ⓘ</span>` : '') },
        { label: 'Landings', key: 'n', num: true, render: (x) => fmt(x.n) },
        { label: 'Share', key: 'share_pct', num: true, render: (x) => pct(x.share_pct) },
      ], { compact: true }));
      originP.body.append(el('p', 'cap', `${fmt(og.unknown)} of the ${fmt(og.total)} landings in ${esc(ogWhat)} have no origin: OpenSky could not tell where those flights started, and none is guessed.`));
    }

    /* ── 05 ── */
    platP.body.innerHTML = '';
    const plats = Bk.platforms || [];
    if (!plats.length) empty(platP.body, 'No booking on this day.');
    else {
      platP.body.append(tableFrom(plats, [
        { label: 'Platform', key: 'platform', render: (x) => esc(sourceLabel(x.platform) || x.platform) },
        { label: 'Airport pickups', key: 'pickups', num: true, render: (x) => fmt(x.pickups) },
        { label: 'Airport drop-offs', key: 'dropoffs', num: true, render: (x) => fmt(x.dropoffs) },
        { label: 'All bookings', key: 'bookings', num: true, render: (x) => fmt(x.bookings) },
        { label: 'No pickup address', key: 'no_address', num: true, render: (x) => fmt(x.no_address) },
      ], { compact: true }));
      platP.body.append(el('p', 'cap', esc(Bk.rule || '')));
    }

    /* ── † ── */
    const noAddr = plats.reduce((s, x) => s + (x.no_address || 0), 0);
    absHost.innerHTML = '';
    absenceBand(absHost, [
      { label: 'Landings OpenSky did not see', fig: null, none: 'Estimated',
        why: Lg.note || 'OpenSky’s coverage of Dubai is partial; the share it sees is an estimate.' },
      { label: 'Passengers on each flight', fig: null, none: 'Not sent',
        why: 'OpenSky’s arrivals carry no aircraft type and no seat count, so landings cannot be turned into passengers.' },
      { label: 'Today’s landings', fig: d.is_today && Lg.live_hours ? `${countOf(Lg.live_hours, 'hour')} live` : null, none: 'Live estimates',
        why: 'Until OpenSky’s nightly list arrives (after the UTC day ends), today’s landings are inferred from aircraft on final approach — its receivers do not see Dubai’s ground traffic.' },
      { label: 'Airport trips', fig: noAddr ? `${fmt(noAddr)} unplaced` : null, none: 'By address text',
        why: `${noAddr ? `${countOf(noAddr, 'booking')} on this day ${noAddr === 1 ? 'carries' : 'carry'} no pickup address and cannot be placed. ` : ''}`
          + 'No booking carries a coordinate, so a trip is an airport trip only when its address names the airport. “Airport Rd – Al Garhoud” is a road, not the airport, and is not counted.' },
    ]);
    pageFoot({ colophon: [dayStr(`${day}T12:00:00`), where, `window ${Im.days} days`,
      d.live?.last_poll_at ? `live ${timeStr(d.live.last_poll_at)}` : 'OpenSky Network'] }, root);
  };

  draw();
}
