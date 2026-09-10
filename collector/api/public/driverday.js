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
  /* Where the waiting HAPPENED, in words. The modal area over the gap's own
     fixes rather than the area of the middle one: a car that leaves an area
     halfway through a gap should be reported as having waited in the one it
     spent most of the gap in, and a single stray fix on the far side of a
     boundary should not rename the whole block. `share` comes back with it so
     a block split evenly between two areas can say so instead of picking. */
  const tally = new Map();
  for (const f of inGap) if (f.area) tally.set(f.area, (tally.get(f.area) || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    fixes: inGap.length,
    still: Math.round((still / (inGap.length - 1)) * 100),
    km: moved / 1000,
    at: inGap[Math.floor(inGap.length / 2)],
    area: top ? top[0] : null,
    area_share: top ? Math.round((top[1] / inGap.length) * 100) : null,
    areas: tally.size,
  };
}

/* ── the online share, and when it must refuse to exist ────────────────────
   This panel printed "99% of online time" about a driver who was online for
   most of the day. Measured on production 2026-09-10, driver
   369dd9c1-ae0a-4526-8d46-d91a8c217121: /api/driver/day dropped his last
   ONLINE — the one with no successor yet — so the online record stopped at
   09:59 while the jobs it was divided into were taken from the whole day, two
   of the three after that. 83 minutes of job time over an 84-minute window is
   99%, and every part of that sentence is arithmetic performed on two
   different days.

   api/online_span_sql.js fixes the window. This is the guard that has to exist
   anyway, because the ratio has three OTHER ways of being uncomputable and all
   three are ordinary here:

     · A JOB ON A CHANNEL WITH NO AVAILABILITY FEED. Only Uber files a driver
       timeline (src/sources/uber_timeline.js is the sole writer of the table).
       A driver who takes a hotel booking has job minutes and no online window
       they can belong to, so the two cannot be divided at all.
     · THE DAY IS STILL BEING COLLECTED. The timeline runs a few times a day,
       the trips every half hour, so the last hours of today routinely hold
       jobs whose availability has not been fetched.
     · OVERLAPPING DISPATCHES. The next rider is assigned before the current
       one is dropped, which is real on this fleet — api/driver_routes.js
       counts the overlaps rather than clamping them — so job minutes SUMMED
       can exceed any wall clock, online or not.

   In every one of those the honest answer is the absence and its reason, not a
   ratio at or above 100%. A pure function, so the branch can be asserted:
   nothing in a rendered page distinguishes "this page concluded 99%" from
   "this page divided two unrelated numbers". */

/* Union of [start, end) minute ranges, sorted and de-overlapped. */
function merge(ranges) {
  const out = [];
  for (const r of [...ranges].filter((x) => x.e > x.s).sort((a, b) => a.s - b.s)) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out;
}
const spanMin = (rs) => rs.reduce((a, r) => a + (r.e - r.s), 0);
/* The parts of `rs` that no range in `by` covers, carrying whatever else each
   range holds — the platform, here, because which channel a stretch of
   uncovered job time belongs to IS the reason the ratio cannot be computed. */
function without(rs, by) {
  const out = [];
  for (const r of rs) {
    let at = r.s;
    for (const b of by) {
      if (b.e <= at || b.s >= r.e) continue;
      if (b.s > at) out.push({ ...r, s: at, e: b.s });
      at = Math.max(at, b.e);
    }
    if (at < r.e) out.push({ ...r, s: at, e: r.e });
  }
  return out.filter((x) => x.e > x.s);
}

const listWords = (xs) => (xs.length < 2 ? (xs[0] || '')
  : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function onlineShare({ online = [], trips = [], collection = null } = {}) {
  const onlineSpans = merge(online.map((o) => ({ s: +o.s, e: +o.e })));
  const onlineMin = spanMin(onlineSpans);
  const jobs = trips.filter((t) => t.s != null && t.e != null && t.e > t.s)
    .map((t) => ({ s: t.s, e: t.e, platform: t.platform || null }));
  /* SUMMED, not merged — this is the figure the panel prints as time carrying
     someone, and two riders in the car at once is two jobs' worth of work. The
     merged version below is only used to ask whether the online record reaches
     them, which is a question about the clock rather than about the work. */
  const onJobMin = jobs.reduce((a, j) => a + (j.e - j.s), 0);
  const jobSpans = merge(jobs);
  const uncovered = without(jobSpans, onlineSpans);
  const uncoveredMin = spanMin(uncovered);
  const idleMin = Math.max(0, onlineMin - onJobMin);

  if (!onlineMin) {
    return { basis: 'span', onlineMin: 0, onJobMin, uncoveredMin, idleMin: null,
      pct: null, why: null, reason: null };
  }

  const base = { onlineMin, onJobMin, uncoveredMin, idleMin };
  if (uncoveredMin > 0) {
    /* WHICH channels those uncovered minutes belong to, and whether any of
       them files an availability record at all. The set comes from the API —
       the platforms the timeline actually holds for this day — rather than
       from a hard-coded 'uber', so a second channel filing one tomorrow does
       not leave this sentence lying. */
    const feeds = new Set(collection?.platforms || []);
    const noFeed = [...new Set(uncovered.map((u) => u.platform).filter(Boolean))]
      .filter((pf) => !feeds.has(pf)).sort();
    if (noFeed.length) {
      return { ...base, basis: 'refused', pct: null,
        why: `${listWords(noFeed)} file no availability`,
        reason: `${dur(uncoveredMin)} of this day's jobs ran on `
          + `${listWords(noFeed)}, which file no availability record at all, so those minutes `
          + 'belong to no online window and the share cannot be computed. The jobs and the '
          + 'waiting below are unaffected — only the division is.' };
    }
    if (collection && collection.complete === false) {
      return { ...base, basis: 'refused', pct: null,
        why: 'the day is still being collected',
        reason: `${dur(uncoveredMin)} of this day's jobs sit outside the availability record `
          + `because the record does not reach them yet. ${collection.why || ''}`.trim() };
    }
    return { ...base, basis: 'refused', pct: null,
      why: 'the availability record does not cover the jobs',
      reason: `${dur(uncoveredMin)} of this day's job time falls outside every ONLINE span we `
        + 'hold for this driver. Uber does not dispatch an offline driver, so the two records '
        + 'contradict each other and neither can be divided into the other until that is '
        + 'explained.' };
  }
  if (onJobMin > onlineMin) {
    /* Fully inside the online window and still longer than it: the only thing
       that can do that is two jobs running at once. */
    return { ...base, basis: 'refused', pct: null,
      why: 'jobs overlap, so they outrun the clock',
      reason: `The jobs sum to ${dur(onJobMin)} inside an online window of ${dur(onlineMin)} `
        + 'because dispatches overlap — the next rider is assigned before the last is dropped. '
        + 'A share of online time would be over 100% and mean nothing.' };
  }
  return { ...base, basis: 'online', pct: Math.round((onJobMin / onlineMin) * 100),
    why: null, reason: null };
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
  /* One decision, made once. The share, the idle figure and the caption all
     read off this — three sentences derived separately are three chances to
     print a ratio the other two have already refused. */
  const share = onlineShare({ online, trips, collection: d.collection });
  const onlineMin = share.onlineMin;
  const km = trips.reduce((a, t) => a + (+t.distance_km || 0), 0);
  const first = trips[0].s;
  const last = trips.reduce((m, t) => Math.max(m, t.e ?? t.s), first);
  const span = Math.max(1, last - first);
  const medianGap = gaps.length
    ? [...gaps].map((g) => g.to - g.from).sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null;

  /* ── the verdict ───────────────────────────────────────────────────────── */
  {
    /* A figure that cannot be measured renders ABSENT WITH ITS REASON — never
       as zero, never as a ratio at or above 100%, and never with a reason that
       is not the true one. onlineShare() decides which of the four cases this
       day is; this only draws it. */
    const refused = share.basis === 'refused';
    const claim = share.basis === 'online'
      ? `${dur(onJob)} carrying someone, ${dur(share.idleMin)} online and waiting`
      : `${dur(onJob)} carrying someone across ${trips.length} ${trips.length === 1 ? 'job' : 'jobs'}`;
    verdict(root, {
      claim,
      figure: refused ? '—'
        : share.basis === 'online' ? `${share.pct}%` : `${Math.round((onJob / span) * 100)}%`,
      unit: refused ? share.why : share.basis === 'online' ? 'of online time' : 'of the trip span',
      tone: share.basis === 'online' && share.pct < 25 ? 'warn' : null,
      meta: `${fmt(trips.length)} trips · ${fmt(km, 1)} km`,
      sub: `${hhmm(first)} to ${hhmm(last)}`
        + (onlineMin ? `, online ${dur(onlineMin)} of it` : '')
        + `${medianGap != null ? `. The median gap between jobs was ${dur(medianGap)}` : ''}.`
        + (onlineMin ? '' : ' Uber availability has not been collected for this day, so the waiting '
          + 'below cannot be split into online and offline.')
        + (refused ? ` ${share.reason}` : '')
        /* The day still filling is worth saying even when the share HAS been
           computed: the band below stops where the collector stopped, and a
           reader who is not told that reads it as the driver stopping. */
        + (!refused && d.collection && d.collection.complete === false && d.collection.why
          ? ` ${d.collection.why}` : ''),
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
    /* An OPEN-ENDED span is one whose closing event has not arrived: the last
       ONLINE Uber sent, with nothing after it yet. It is drawn to the earlier
       of now and the end of the day and says so on hover, because "online
       until 14:00" and "online at 14:00, and that is the last we were told"
       are different claims and the bar looks identical. */
    ob.innerHTML = online.map((o) =>
      `<i style="left:${pct(o.s)}%;width:${pct(Math.max(2, o.e - o.s))}%" title="${
        o.open_ended
          ? `online from ${esc(hhmm(o.s))}; no later event has arrived, so this is drawn to ${esc(hhmm(o.e))}`
          : `online ${esc(hhmm(o.s))}–${esc(hhmm(o.e))}`}"></i>`).join('');
    const row = el('div', 'dday-onrow');
    row.innerHTML = '<span class="dday-onlab">online per Uber</span>';
    row.append(ob);
    row.append(el('span', 'dday-ontot', dur(onlineMin)));
    bandP.body.append(row);
    /* Under the band, where the band stops. The collector runs a few times a
       day and the trip feed every half hour, so the right-hand end of this bar
       is routinely the collector's reach rather than the driver's evening. */
    if (d.collection && d.collection.complete === false && d.collection.why) {
      bandP.body.append(el('div', 'dday-onbasis dim', d.collection.why));
    }

    /* WHERE they went online, which is the supply question the bar above
       cannot answer. Uber returns no coordinates on the timeline, so this is
       the tracker's position at the moment of each transition — the API says
       so in place_basis and this repeats it, because a number whose basis is
       not on the same screen as the number is a number nobody can check.

       Every span is accounted for: the ones that could be placed, by area,
       and the ones that could not, counted. A list that silently dropped the
       unplaceable spans would read as though the fleet knew more than it does. */
    const starts = d.goes_online_in || [];
    const unplaced = d.online_spans_unplaced || 0;
    if (starts.length || unplaced) {
      const wl = el('div', 'dday-onwhere');
      const said = starts.map((a) =>
        `<b>${esc(a.area)}</b><span class="dim"> ${a.spans}×</span>`).join('<span class="dim"> · </span>');
      wl.innerHTML = (starts.length
        ? `went online in ${said}`
        : '<span class="dim">where they went online could not be established</span>')
        + (unplaced
          ? `<span class="dim"> · ${unplaced} ${unplaced === 1 ? 'span' : 'spans'} could not be placed</span>`
          : '');
      bandP.body.append(wl);
      if (d.place_basis) bandP.body.append(el('div', 'dday-onbasis dim', d.place_basis));
    }
  }
  const lg = el('div', 'lgnd');
  lg.innerHTML = '<span><i class="sw j"></i>on a job</span>'
    + '<span><i class="sw waitsw"></i>waiting for the next one</span>'
    + (trips.some((t) => /not_completed|cancel/i.test(t.outcome || t.status || ''))
      ? '<span><i class="sw cx"></i>did not complete</span>' : '')
    + (online.length ? '<span><i class="sw onsw"></i>online</span>' : '');
  bandP.body.append(lg);

  /* ── the day as a list ─────────────────────────────────────────────────── */
  const listP = panel('Every job, and the gaps between them',
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
        /* The place first, because it is the thing a person can act on. The
           coordinates stay, dimmed, because they are what the tracker actually
           said and somebody checking the name against a map needs them.

           An area the fixes disagree about is reported as the majority AND the
           disagreement — "mostly Al Barsha" — rather than as a clean answer,
           and an area nothing has ever named says so instead of vanishing. */
        const place = mo.area
          ? `<b>${esc(mo.area)}</b>${mo.areas > 1 && mo.area_share < 70
            ? ` <span class="dim">mostly — ${mo.area_share}% of the fixes here</span>` : ''} · `
          : '<span class="dim">no trip has ever named this ground</span> · ';
        where.innerHTML = place
          + `<b>${mo.still}%</b> of fixes stationary`
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
