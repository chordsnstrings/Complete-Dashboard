/* ── one driver, one day, minute by minute ─────────────────────────────────
   "How the day was spent" answers the shape of a month: 28 bars, each a day.
   This answers ONE of them, and answers the part that page could only total.

   It could say a driver waited 7h 36m. It could not say whether they were
   online for it, where they sat, or whether the car moved while they waited —
   and those are the three things that decide whether the waiting is the
   fleet's problem, the driver's, or nobody's.

   Three feeds on one clock: the jobs from `trip`, the ONLINE spans from
   `driver_timeline_event`, and the tracker's fixes from `telemetry_snapshot`.
   The gaps are computed here, once, from the jobs — the server deliberately
   returns fixes rather than per-gap rollups so the same arithmetic is not done
   in two places that can drift apart. */
import { el, esc, note, panel, loading, fmt, empty, pill, money, dayStr, entity, sourceLabel,
  tierLabel, verdict } from './ui.js';
import { api, href } from './data.js';

const hhmm = (m) => {
  if (m == null || !Number.isFinite(m)) return '—';
  const c = Math.max(0, Math.min(1440, Math.round(m)));
  return `${String(Math.floor(c / 60) % 24).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
};
const dur = (m) => {
  if (m == null || m < 0) return '—';
  const h = Math.floor(m / 60), r = Math.round(m % 60);
  return h ? `${h}h ${String(r).padStart(2, '0')}m` : `${r}m`;
};
/* Metres between two fixes. Equirectangular rather than haversine: over the
   distances a parked car covers this is accurate to well under a metre, and
   the question here is "did it move", not "how far exactly". */
const metres = (a, b) => {
  const R = 6371000, rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * R;
};

/* What the tracker saw between two minutes of the day. Returns null when it
   saw nothing at all, which is a different answer from "it was parked" and has
   to be renderable as such. */
function gapMotion(fixes, from, to) {
  const inGap = fixes.filter((f) => f.m >= from && f.m <= to);
  if (inGap.length < 2) return inGap.length ? { fixes: inGap.length, still: null, km: null } : null;
  let moved = 0, still = 0;
  for (let i = 1; i < inGap.length; i++) {
    moved += metres(inGap[i - 1], inGap[i]);
    /* Stationary by SPEED where the feed reports one, by displacement where it
       does not — CABMAN sends speed and FMS often does not, and treating a
       missing speed as zero would report every FMS gap as a parked car. */
    const sp = inGap[i].speed;
    if (sp != null ? sp <= 3 : metres(inGap[i - 1], inGap[i]) < 60) still++;
  }
  return {
    fixes: inGap.length,
    still: Math.round((still / (inGap.length - 1)) * 100),
    km: moved / 1000,
    at: inGap[Math.floor(inGap.length / 2)],
  };
}

export async function renderDriverDay(root, id, day) {
  root.innerHTML = '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    root.append(note('A driver’s day is addressed as #driver/<id>/day?on=YYYY-MM-DD.'));
    return;
  }
  loading(root);
  let d;
  try { d = await api(`/api/driver/day?id=${encodeURIComponent(id)}&day=${encodeURIComponent(day)}`); }
  catch (e) { root.innerHTML = ''; root.append(note(`Could not load this day: ${e.message}`)); return; }
  root.innerHTML = '';

  const trips = (d.trips || []).filter((t) => t.s != null).sort((a, b) => a.s - b.s);
  if (!trips.length) {
    root.append(note(`No booking on ${dayStr(`${day}T12:00:00`)} for this driver.`));
    return;
  }
  const online = d.online || [];
  const fixes = d.fixes || [];

  /* The gaps, built once from the jobs. A job with no dropoff cannot close a
     gap — its end is unknown, not "now" — so the cursor only advances on jobs
     that ended, and the gap before the next job is measured from the last
     KNOWN end. */
  const gaps = [];
  let cursor = null;
  for (const t of trips) {
    if (cursor != null && t.s > cursor) gaps.push({ from: cursor, to: t.s, before: t });
    if (t.e != null) cursor = Math.max(cursor ?? t.e, t.e);
  }
  const onJob = trips.reduce((a, t) => a + (t.e != null ? Math.max(0, t.e - t.s) : 0), 0);
  const waited = gaps.reduce((a, g) => a + (g.to - g.from), 0);
  const onlineMin = online.reduce((a, o) => a + Math.max(0, o.e - o.s), 0);
  const km = trips.reduce((a, t) => a + (+t.distance_km || 0), 0);
  const first = trips[0].s;
  const last = trips.reduce((m, t) => Math.max(m, t.e ?? t.s), first);
  const span = Math.max(1, last - first);
  const medianGap = gaps.length
    ? [...gaps].map((g) => g.to - g.from).sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;

  /* ── the verdict ───────────────────────────────────────────────────────── */
  {
    const idle = onlineMin ? Math.max(0, onlineMin - onJob) : null;
    verdict(root, {
      claim: onlineMin
        ? `${dur(onJob)} carrying someone, ${dur(idle)} online and waiting`
        : `${dur(onJob)} carrying someone across ${trips.length} ${trips.length === 1 ? 'job' : 'jobs'}`,
      figure: onlineMin ? `${Math.round((onJob / onlineMin) * 100)}%` : `${Math.round((onJob / span) * 100)}%`,
      unit: onlineMin ? 'of online time' : 'of the trip span',
      tone: onlineMin && onJob / onlineMin < 0.25 ? 'warn' : null,
      meta: `${fmt(trips.length)} trips · ${fmt(km, 1)} km`,
      sub: `${hhmm(first)} to ${hhmm(last)}`
        + (onlineMin ? `, online ${dur(onlineMin)} of it` : '')
        + `${medianGap != null ? `. The median gap between jobs was ${dur(medianGap)}` : ''}.`
        + (onlineMin ? '' : ' Uber availability has not been collected for this day, so the waiting '
          + 'below cannot be split into online and offline.'),
    });
  }

  /* ── the day as one band ───────────────────────────────────────────────── */
  const bandP = panel('The day, midnight to midnight', d.basis);
  root.append(bandP.panel);
  const band = el('div', 'dday-band');
  const pct = (m) => (m / 1440) * 100;
  band.innerHTML = trips.map((t) => {
    const known = t.e != null;
    const w = known ? Math.max(t.e - t.s, 3) : 10;
    const cls = /not_completed|cancel/i.test(t.outcome || t.status || '') ? 'cx' : known ? 'j' : 'u';
    return `<i class="${cls}" style="left:${pct(t.s)}%;width:${pct(w)}%" title="${esc(hhmm(t.s))}–${
      known ? esc(hhmm(t.e)) : 'no dropoff reported'}"></i>`;
  }).join('');
  const ruler = el('div', 'dday-ruler');
  ruler.innerHTML = [0, 6, 12, 18, 24].map((h) =>
    `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');
  const bandWrap = el('div', 'dday-bandwrap');
  bandWrap.append(band, ruler);
  bandP.body.append(bandWrap);
  if (online.length) {
    const ob = el('div', 'dday-online');
    ob.innerHTML = online.map((o) =>
      `<i style="left:${pct(o.s)}%;width:${pct(Math.max(2, o.e - o.s))}%" title="online ${esc(hhmm(o.s))}–${esc(hhmm(o.e))}"></i>`).join('');
    const row = el('div', 'dday-onrow');
    row.innerHTML = '<span class="dday-onlab">online per Uber</span>';
    row.append(ob);
    row.append(el('span', 'dday-ontot', dur(onlineMin)));
    bandP.body.append(row);
  }
  const lg = el('div', 'lgnd');
  lg.innerHTML = '<span><i class="sw j"></i>on a job</span>'
    + '<span><i class="sw waitsw"></i>waiting for the next one</span>'
    + (trips.some((t) => /not_completed|cancel/i.test(t.outcome || t.status || ''))
      ? '<span><i class="sw cx"></i>did not complete</span>' : '')
    + (online.length ? '<span><i class="sw onsw"></i>online</span>' : '');
  bandP.body.append(lg);

  /* ── the day as a list ─────────────────────────────────────────────────── */
  const listP = panel('Every job, and what happened between them',
    'Each waiting block carries where the tracker saw the car and how much of that time it '
    + 'was stationary. A block with no position is one the tracker did not cover.');
  root.append(listP.panel);
  const list = el('div', 'dday-list');
  const gapBefore = new Map(gaps.map((g) => [g.before, g]));

  for (const t of trips) {
    const g = gapBefore.get(t);
    if (g) {
      const mins = g.to - g.from;
      const mo = gapMotion(fixes, g.from, g.to);
      const row = el('div', `dday-gap${mins >= 90 ? ' long' : ''}`);
      const head = el('div', 'dday-gaphead');
      head.innerHTML = `<b>waiting ${esc(dur(mins))}</b>`
        + (mins >= 90 ? ' <span class="tag warn">long wait</span>' : '')
        + `<span class="dim">until ${esc(hhmm(g.to))}</span>`;
      row.append(head);
      if (mo && mo.still != null) {
        const where = el('div', 'dday-where');
        where.innerHTML = `<b>${mo.still}%</b> of fixes stationary`
          + ` · moved <b>${esc(fmt(mo.km, 1))}</b> km`
          + `<span class="dim mono"> ${esc((mo.at.lat).toFixed(3))}, ${esc((mo.at.lng).toFixed(3))}</span>`
          /* Only when there IS a plate. The fix came from the tracker on a car,
             and a job with no plate on it has no car page to open — a link to
             `#vehicle//movement` is a dead address, which is what
             test/interlinking.test.mjs exists to catch. */
          + (t.plate ? ` <a class="lnk" href="${href('vehicle', t.plate, 'movement')}">where ↗</a>` : '');
        row.append(where);
      } else {
        row.append(el('div', 'dday-where dim', mo
          ? 'one tracker fix in this gap — not enough to say whether the car moved'
          : 'the tracker reported nothing during this gap'));
      }
      list.append(row);
    }

    const done = /completed/i.test(t.outcome || '');
    const item = el('div', `dday-job${done ? '' : ' bad'}`);
    const when = el('div', 'dday-when');
    when.innerHTML = `<b>${esc(hhmm(t.s))}</b><span>${t.e != null ? esc(hhmm(t.e)) : '—'}</span>`;
    const body = el('div', 'dday-body');
    body.innerHTML = `
      <div class="dday-leg">
        <div class="dday-pt"><i class="o"></i><span class="dday-lab">pick-up</span>
          <b>${esc(t.pickup_addr || 'no address reported')}</b></div>
        <div class="dday-pt"><i class="x"></i><span class="dday-lab">drop-off</span>
          <b>${esc(t.dropoff_addr || 'no address reported')}</b></div>
      </div>
      <div class="dday-facts">
        ${t.distance_km != null ? `<span><b>${esc(fmt(t.distance_km, 2))}</b> km</span>` : ''}
        ${t.e != null ? `<span><b>${esc(dur(t.e - t.s))}</b> on trip</span>` : ''}
        ${t.product ? `<span>tier <b>${esc(tierLabel(t.product))}</b></span>` : ''}
        ${t.payment_type ? `<span>paid <b>${esc(t.payment_type)}</b></span>` : ''}
        ${t.price != null ? `<span><b>${esc(money(t.price))}</b></span>` : ''}
        <span class="dday-out">${pill(done ? 'completed' : (t.outcome || t.status || 'unknown'),
    done ? 'ok' : 'bad')}</span>
      </div>`;
    const open = el('a', 'dday-open', 'open ↗');
    open.href = href('trip', t.platform, t.external_id);
    item.append(when, body, open);
    list.append(item);
  }
  listP.body.append(list);
}
