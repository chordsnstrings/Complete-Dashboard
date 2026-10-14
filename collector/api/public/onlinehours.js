/* #online-hours — Uber drivers online, hour by hour, for any day kept.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-10-14: "we need to show driver online by hour on uber and
   store it to fetch previous data".

   One day at a time (a day picker, and the day in the address:
   #online-hours/2026-10-01), read from /api/online/hours: how many drivers
   were online in each hour, the driver-hours, how many were online at once on
   average, and every driver's minutes hour by hour. Below it, the last 14 or
   30 days as a day × hour grid from /api/online/hours/range — the history Uber
   itself stops answering for after 31 days — where a click opens that day.

   Two sources, never blended without saying so. The hours Uber's timeline has
   recorded are the record (stored in driver_online_hour). Today's hours after
   the timeline's last run come from the live status feed and are drawn hatched
   and named "live" in every row they touch; the timeline replaces them within
   three hours. An hour that has not happened is empty, and a day nothing was
   recorded on says why. */
import { el, esc, panel, tableFrom, kpiRow, entity, pill, timeStr, dayStr,
  contract, glance, glanceBand, bandTiles, absenceBand, pageFoot, countOf } from './ui.js';
import { dubaiDay } from './tz.js';
import { barChart, empty, fmt, SEQ } from './charts.js';
import { api, href } from './data.js';

const HH = (h) => `${String(h).padStart(2, '0')}:00`;
const STATE_WORD = {
  recorded: 'timeline', 'recorded+live': 'timeline + live', live: 'live feed',
  partial: 'part measured', not_collected: 'not collected yet', future: '—',
};
/* Minutes in an hour, 0–60, as one of the sequential steps; 0 is the surface. */
const shade = (m) => (m > 0 ? `var(${SEQ[Math.min(SEQ.length - 1, Math.floor((m / 60) * (SEQ.length - 0.01)))]})` : 'var(--surface-2)');

export async function renderOnlineHours(root, param) {
  root.innerHTML = '';
  let day = /^\d{4}-\d{2}-\d{2}$/.test(String(param || '')) ? param : dubaiDay();
  let span = 14;
  let fleet = '';
  const ak = contract();
  const AKB = ak ? glanceBand(root, null) : null;

  const head = panel('The day, and the fleet', 'Every figure below is this Dubai day, on Uber');
  root.append(head.panel);
  const controls = el('div', 'btnrow');
  controls.style.cssText = 'margin:10px 0;gap:14px;align-items:center;flex-wrap:wrap';
  const prev = el('button', 'btn', '‹ Day before'); prev.type = 'button';
  const next = el('button', 'btn', 'Day after ›'); next.type = 'button';
  const dayIn = el('input'); dayIn.type = 'date'; dayIn.className = 'inp'; dayIn.value = day; dayIn.max = dubaiDay();
  const fleetIn = el('select', 'inp');
  fleetIn.innerHTML = '<option value="">Both fleets</option><option value="ecosine">Ecosine</option><option value="egari">Egari</option>';
  controls.append(prev, dayIn, next, fleetIn);
  head.body.append(controls);
  const tiles = el('div'); head.body.append(tiles);

  const chartP = panel('Drivers online, hour by hour', 'How many Uber drivers were online at any point in each hour', 'oh-chart');
  const tableP = panel('Each hour', 'Drivers online, how many at once on average, the driver-hours, and what the hour rests on', 'oh-hours');
  const peopleP = panel('Every driver, hour by hour', 'Minutes online in each hour — darker is more of the hour', 'oh-people');
  const rangeP = panel('The days before', 'Drivers online in each hour of each day kept — open a day to see it', 'oh-range');
  root.append(chartP.panel, tableP.panel, peopleP.panel, rangeP.panel);
  const absHost = el('div'); root.append(absHost);

  const go = (d) => { location.hash = href('online-hours', d); };
  prev.onclick = () => go(new Date(Date.parse(`${day}T12:00:00Z`) - 864e5).toISOString().slice(0, 10));
  next.onclick = () => { const n = new Date(Date.parse(`${day}T12:00:00Z`) + 864e5).toISOString().slice(0, 10); if (n <= dubaiDay()) go(n); };
  next.disabled = day >= dubaiDay();
  dayIn.onchange = () => { if (dayIn.value) go(dayIn.value); };
  fleetIn.onchange = () => { fleet = fleetIn.value; draw(); drawRange(); };

  const draw = async () => {
    [chartP, tableP, peopleP].forEach((p) => { p.body.innerHTML = '<div class="loading">Loading…</div>'; });
    let d;
    try {
      d = await api(`/api/online/hours?day=${encodeURIComponent(day)}${fleet ? `&fleet=${fleet}` : ''}`);
    } catch (e) {
      [chartP, tableP, peopleP].forEach((p) => { p.body.innerHTML = ''; empty(p.body, `Could not load this day: ${esc(String(e.message || e))}`); });
      return;
    }
    const t = d.totals || {};
    const past = d.hours.filter((h) => h.state !== 'future');
    const measured = past.filter((h) => h.avg_online != null);
    const avgAll = measured.length
      ? measured.reduce((a, h) => a + h.avg_online * h.measured_min, 0) / Math.max(1, measured.reduce((a, h) => a + h.measured_min, 0))
      : null;
    const anyLive = d.hours.some((h) => h.live_h > 0);
    const TILES = [
      { label: 'Drivers online', value: fmt(t.drivers ?? 0), sub: 'Uber accounts online at any point in the day' },
      { label: 'Busiest hour', value: t.peak_drivers ? HH(t.peak_hour) : '—',
        sub: t.peak_drivers ? `${countOf(t.peak_drivers, 'driver')} online in it` : 'nobody online' },
      { label: 'Driver-hours', value: fmt(t.online_h ?? 0, 1), sub: 'online time, summed over everyone' },
      { label: 'Online at once', value: avgAll == null ? '—' : fmt(avgAll, 1),
        sub: avgAll == null ? 'no hour of this day is measured yet' : 'on average, over the measured hours' },
      { label: 'Timeline reached', value: d.timeline_to ? timeStr(d.timeline_to) : '—',
        sub: d.timeline_to ? `${dayStr(d.timeline_to)}${anyLive ? ' · live feed after it' : ''}` : 'the timeline has not run' },
    ];
    if (ak) {
      AKB.tilesHost.innerHTML = '';
      glance(AKB.tilesHost, bandTiles(TILES.map((x, i) => (i === 0 ? { ...x, hero: true } : x))).tiles);
    } else { tiles.innerHTML = ''; tiles.append(kpiRow(TILES)); }

    chartP.body.innerHTML = '';
    if (d.absent_why && !past.some((h) => h.drivers)) {
      empty(chartP.body, `Nobody to show: ${esc(d.absent_why)}.`);
    } else {
      const rows = d.hours.map((h) => ({ h: HH(h.hour).slice(0, 2), drivers: h.drivers ?? 0, live: h.live_h > 0 && h.state !== 'recorded' }));
      const box = el('div'); chartP.body.append(box);
      barChart(box, rows, { x: 'h', y: 'drivers', label: 'drivers online', color: '--mk-fill',
        colorFor: (r) => (r.live ? '--b300' : null), projected: (r) => r.live,
        aria: `Uber drivers online in each hour of ${day}` });
      chartP.body.append(el('p', 'cap', (anyLive
        ? 'The lighter, hatched bars are hours the timeline has not reached yet, counted from Uber’s live status feed; the timeline replaces them within three hours. '
        : '') + 'A driver online for a minute of an hour is online in that hour; "online at once" in the table below is the measure that weighs the minutes.'));
    }

    tableP.body.innerHTML = '';
    tableP.body.append(tableFrom(d.hours.filter((h) => h.state !== 'future'), [
      { label: 'Hour', key: 'hour', sortValue: (h) => h.hour, render: (h) => `${HH(h.hour)}–${HH((h.hour + 1) % 24)}` },
      { label: 'Drivers online', key: 'drivers', num: true, render: (h) => fmt(h.drivers) },
      { label: 'Online at once', key: 'avg_online', num: true,
        render: (h) => (h.avg_online == null ? '<span class="ent-off" title="no minute of this hour is measured">—</span>' : fmt(h.avg_online, 1)) },
      { label: 'Driver-hours', key: 'online_h', num: true, render: (h) => fmt(h.online_h, 1) },
      { label: 'From', key: 'state', render: (h) => (/live/.test(h.state) ? pill(STATE_WORD[h.state], 'warn')
        : h.state === 'recorded' ? esc(STATE_WORD[h.state])
          : `<span class="ent-off" title="${esc(h.state === 'partial' ? `${h.measured_min} of the hour’s minutes are measured` : 'the timeline has not reached this hour')}">${esc(STATE_WORD[h.state])}</span>`) },
    ], { compact: true, sortable: true, sortId: 'oh-hours', defaultSort: { key: 'hour', dir: 'asc' } }));
    tableP.body.append(el('p', 'cap', esc(d.basis)));

    peopleP.body.innerHTML = '';
    const people = (d.drivers || []).filter((p) => p.total_min > 0);
    if (!people.length) {
      empty(peopleP.body, d.absent_why ? `Nobody: ${esc(d.absent_why)}.` : 'No Uber account was online on this day.');
    } else {
      const wrap = el('div', 'oh-grid-wrap');
      wrap.style.cssText = 'overflow-x:auto';
      const tbl = el('table', 'tbl compact oh-grid');
      const hdr = `<tr><th>Driver</th>${Array.from({ length: 24 }, (_, h) => `<th class="num" style="padding:2px 1px;font-size:10px">${String(h).padStart(2, '0')}</th>`).join('')}<th class="num">Hours</th><th>First–last</th></tr>`;
      tbl.innerHTML = `<thead>${hdr}</thead><tbody>${people.map((p) => `<tr>
        <td>${p.name ? entity('driver', p.driver_ext_id, p.name) : '<span class="ent-off" title="no name on file for this Uber account">unnamed account</span>'}</td>
        ${p.minutes.map((m, h) => `<td title="${esc(`${HH(h)} · ${fmt(m, 0)} min${p.live[h] ? ' · live feed' : ''}`)}" style="padding:0;min-width:16px;background:${shade(m)};${p.live[h] ? 'background-image:repeating-linear-gradient(45deg,transparent 0 3px,var(--surface) 3px 4px);' : ''}"></td>`).join('')}
        <td class="num">${fmt(p.total_min / 60, 1)}</td>
        <td>${p.first_hour >= 0 ? `${HH(p.first_hour)}–${HH((p.last_hour + 1) % 24)}` : '—'}</td></tr>`).join('')}</tbody>`;
      wrap.append(tbl);
      peopleP.body.append(wrap);
      peopleP.body.append(el('p', 'cap', `${countOf(people.length, 'driver')}, most hours first. Each cell is one hour; the darkest is the whole hour online. `
        + (anyLive ? 'Hatched cells come from the live feed. ' : '') + 'Names come from the Uber roster.'));
    }

    absHost.innerHTML = '';
    absenceBand(absHost, [
      { label: 'Days before 28 July 2026', fig: null, none: 'Never collected',
        why: 'Uber’s timeline was first collected then, and Uber answers for no more than the last 31 days, so the hours before it cannot be filled.' },
      { label: 'Hours after the timeline’s last run', fig: d.timeline_to ? timeStr(d.timeline_to) : null, none: 'Not yet run',
        why: anyLive ? 'Counted from the live status feed until the timeline arrives; the live feed began on 14 Sep 2026.'
          : 'The timeline runs every three hours; the hours after its last run are not in these figures yet.' },
      { label: 'One person, two Uber accounts', fig: null, none: 'Counted twice',
        why: 'The timeline is kept per Uber account and carries no person key, so a person with two Uber accounts is two drivers here.' },
      { label: 'Online on the other channels', fig: null, none: 'Not sent',
        why: 'Bolt, Yango and the hotel channel report finished trips and never when somebody was online; only Uber sends it.' },
    ]);
    pageFoot({ colophon: [dayStr(`${day}T12:00:00`), fleet || 'both fleets', 'Uber'] }, root);
  };

  const spanCtl = el('div', 'btnrow');
  spanCtl.style.cssText = 'margin:6px 0 10px;gap:8px';
  const spanBtns = [14, 30].map((n) => {
    const b = el('button', `btn${n === span ? ' on' : ''}`, `${n} days`); b.type = 'button';
    b.onclick = () => { span = n; spanBtns.forEach((x) => x.classList.toggle('on', x === b)); drawRange(); };
    return b;
  });
  spanCtl.append(...spanBtns);
  const rangeHost = el('div');
  rangeP.body.append(spanCtl, rangeHost);
  const drawRange = async () => {
    rangeHost.innerHTML = '<div class="loading">Loading…</div>';
    const to = day;
    const from = new Date(Date.parse(`${to}T12:00:00Z`) - (span - 1) * 864e5).toISOString().slice(0, 10);
    let r;
    try {
      r = await api(`/api/online/hours/range?from=${from}&to=${to}${fleet ? `&fleet=${fleet}` : ''}`);
    } catch (e) { rangeHost.innerHTML = ''; empty(rangeHost, `Could not load the days before: ${esc(String(e.message || e))}`); return; }
    rangeHost.innerHTML = '';
    const max = Math.max(1, ...r.days.flatMap((x) => x.drivers || [0]));
    const cell = (n) => (n > 0 ? `var(${SEQ[Math.min(SEQ.length - 1, Math.floor((n / max) * (SEQ.length - 0.01)))]})` : 'var(--surface-2)');
    const wrap = el('div'); wrap.style.cssText = 'overflow-x:auto';
    const tbl = el('table', 'tbl compact oh-range');
    tbl.innerHTML = `<thead><tr><th>Day</th>${Array.from({ length: 24 }, (_, h) => `<th class="num" style="padding:2px 1px;font-size:10px">${String(h).padStart(2, '0')}</th>`).join('')}<th class="num">Peak</th><th class="num">Driver-hours</th></tr></thead>
      <tbody>${[...r.days].reverse().map((x) => `<tr class="${x.day === day ? 'sel' : ''}">
        <td><a class="lnk" href="${href('online-hours', x.day)}">${esc(dayStr(`${x.day}T12:00:00`))}</a></td>
        ${x.drivers ? x.drivers.map((n, h) => `<td title="${esc(`${x.day} ${HH(h)} · ${n} online`)}" style="padding:0;min-width:16px;background:${cell(n)}"></td>`).join('')
          : `<td colspan="24" class="ent-off" style="text-align:center">${esc(x.absent_why || 'nothing recorded')}</td>`}
        <td class="num">${x.peak == null ? '—' : fmt(x.peak)}</td>
        <td class="num">${x.total_h == null ? '—' : fmt(x.total_h, 1)}${x.drivers && !x.complete ? ' <span class="dim" title="the timeline has not reached the end of this day">so far</span>' : ''}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><th>Average</th>${r.avg_drivers_by_hour.map((v) => `<td class="num" style="padding:2px 1px;font-size:10px">${v == null ? '—' : fmt(v, 0)}</td>`).join('')}<td></td><td></td></tr></tfoot>`;
    wrap.append(tbl);
    rangeHost.append(wrap);
    rangeHost.append(el('p', 'cap', r.days_averaged
      ? `The average row is drivers online in each hour over the ${countOf(r.days_averaged, 'whole day')} the timeline has recorded in these ${span}; a day it has not finished is left out of it.`
      : 'No whole day in this range has been recorded, so there is no average.'));
  };

  draw();
  drawRange();
}
