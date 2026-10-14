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
  tierLabel, verdict, contract, glance, glanceBand, bandTiles, absenceBand, pageFoot } from './ui.js';
import { hbars } from './charts.js';
import { api, href } from './data.js';
import { dubaiDay } from './tz.js';
import { channelKey } from './tokens.js';
import { withheldSentence } from './access_model.js';
import { unlessWithheld } from './access.js';
import { ridesOf, rideWords, coverageWords, readable, truncationWords } from './unbooked.js';

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
    /* Named with sourceLabel, never with the database key. ui.js's SOURCE_LABEL
       exists because "fms" and "cabman" were rendered raw as panel headings,
       and a reason sentence is no more the place for a key than a heading is. */
    const noFeed = [...new Set(uncovered.map((u) => u.platform).filter(Boolean))]
      .filter((pf) => !feeds.has(pf)).sort().map((pf) => sourceLabel(pf));
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

/* What went wrong, in the words an operator uses. The badge used to print the
   raw token — 'not_completed' — which is both machine-speak and the least
   informative thing on the row: it says a job did not happen without saying
   who stopped it, and "rider cancelled" and "driver cancelled" are different
   conversations. `status` carries the provider's more specific word, so it is
   preferred over `outcome` and tidied rather than mapped through a lookup that
   would answer 'unknown' the first time a provider adds a value. */
/* Did this job actually happen? See the long note at the call site: this was
   `/completed/i.test(outcome)`, and "not_completed" contains "completed". */
export function jobCompleted(t) {
  return String(t?.outcome || '').trim().toLowerCase() === 'completed';
}

export function outcomeWord(t) {
  const raw = String(t.status || t.outcome || '').trim();
  if (!raw) return 'outcome not reported';
  return raw.replace(/_/g, ' ').toLowerCase();
}

export async function renderDriverDay(root, id, day) {
  root.innerHTML = '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))) {
    root.append(note('A driver’s day is addressed as #driver/<id>/day?on=YYYY-MM-DD.'));
    return;
  }
  loading(root);
  let d;
  /* TODAY IS READ FRESH. A day that has ended is the same answer every time
     and the client's stale-while-revalidate store may hand it back at once;
     today carries Uber's live status and the car's position to the minute,
     and a held copy froze "online … now" (review, 2026-10-13). Passing
     options skips that store (data.js api); the server skips its cache for
     today's day too (api/cache.js). */
  try {
    d = await api(`/api/driver/day?id=${encodeURIComponent(id)}&day=${encodeURIComponent(day)}`,
      day === dubaiToday() ? {} : undefined);
  }
  catch (e) { root.innerHTML = ''; root.append(note(`Could not load this day: ${e.message}`)); return; }
  root.innerHTML = '';
  /* The journeys no channel booked on this day, asked for now and placed when
     the page is built (unbookedOnDay below) — the attribution is computed per
     request and must not hold the rest of the day. */
  const unbookedP = unlessWithheld(
    api(`/api/driver/unauthorized?id=${encodeURIComponent(id)}&from=${encodeURIComponent(day)}&to=${encodeURIComponent(day)}`),
    (e) => ({ withheld: e.message })).catch(() => null);

  const trips = (d.trips || []).filter((t) => t.s != null).sort((a, b) => a.s - b.s);
  const online = d.online || [];
  const fixes = d.fixes || [];
  const status = d.status_spans || [];
  const mv = d.movement || {};
  /* WITHHELD IS NOT ABSENT. The gate answers a role without a class with
     the field nulled and the class named in `_withheld`; the review of
     2026-10-13 found this page telling a Cash desk officer "No booking from
     today has reached us yet" and "no car is on record as his" about a day
     with twelve bookings and a car — fields their role is not shown. Every
     sentence below asks this first. */
  const W = d._withheld || {};
  const wh = {
    trips: d.trips === null || (W.BK != null && !(d.trips || []).length),
    bkLevel: W.BK ?? null,
    fixes: d.fixes === null,
    veh: mv.totals === null || mv.runs === null,
    /* An answer from before the movement record existed (a cached copy, or
       a server not yet deployed) is not "no car on record". */
    predates: d.movement === undefined,
  };
  dayNav(root, id, day);
  /* A DAY WITH NO BOOKING IS NOT AN EMPTY DAY (2026-10-13). This returned
     "No booking on … for this driver" and drew nothing else — for a driver
     Uber's live feed had online from 07:04 and on a trip at 11:38, because
     Uber files a trip about half an hour after it and none had arrived. The
     page now stops only when there is nothing at all: no booking, no log-in
     record, no live status and no car. */
  if (!wh.trips && !trips.length && !online.length && !status.length && !(mv.windows || []).length) {
    root.append(note(`Nothing is on record for this driver on ${dayStr(`${day}T12:00:00`)} — no booking, `
      + 'no log-in record, no live status from Uber and no car.'));
    return;
  }
  if (!trips.length) {
    quietDay(root, { d, day, status, online, mv, wh });
    drawBand(root, { d, trips, online, status, mv, wh });
    await renderMovement(root, { d, status, trips, wh });
    if (contract()) { dayAreas(root, fixes, wh); dayAbsence(root, { trips, fixes, day, mv, wh }); }
    unbookedP.then((res) => unbookedOnDay(root, { res, day, list: null }));
    return;
  }

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

  /* Under the page contract (plan §4 #driver/day): the headline is the 00
     statement — its figure, the share of online time carrying someone, is
     not repeated as a tile (ruling 7) — and the tiles set the day against
     the driver's own calendar month, one extra request; the timeline and
     every job and gap kept, restyled only (the review's correction); where
     the tracker saw the car, by area; a † band. */
  const ak = contract();
  const AKB = ak ? glanceBand(root, dayStr(`${day}T12:00:00`)) : null;
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
    verdict(ak ? AKB.vHost : root, {
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

  if (ak) dayGlance(AKB, { id, day, trips, onJob, share, medianGap, km });
  /* ── the day as one band, then where the car went ─────────────────────── */
  drawBand(root, { d, trips, online, status, mv, wh });
  await renderMovement(root, { d, status, trips, wh });

  /* ── the day as a list ─────────────────────────────────────────────────── */
  const listP = panel('Every job, and the gaps between them',
    'Each waiting block carries where the tracker saw the car and how much of that time it '
    + 'was stationary. A block with no position is one the tracker did not cover.');
  root.append(listP.panel);
  const list = el('div', 'dday-list');
  const gapBefore = new Map(gaps.map((g) => [g.before, g]));

  /* THE HOLE A GAP CANNOT BE DRAWN ACROSS.
     ─────────────────────────────────────────────────────────────────────────
     `gaps` above only advances its cursor on a job that ENDED, which is right:
     a cancelled job has no end time, so the moment the driver became free is
     unknown and any waiting figure measured from it would be invented.

     But the consequence was silence. On 2026-09-14 one driver's day ran eight
     cancellations to 01:18 and the next job at 16:00, and the fourteen and a
     half hours between them appeared as nothing at all — no block, no note —
     under a heading that promises "every job, and the gaps between them". A
     reader sees the hole; the page has to account for it.

     So it is named and NOT measured. It is deliberately not pushed into
     `gaps`, because `waited` sums that array and a hole we cannot measure must
     not become minutes in a total — which would be the same lie one level up.
     Ninety minutes is the threshold the page already treats as notable, so the
     seven minutes between two consecutive cancellations stay quiet. */
  const UNMEASURED_MIN = 90;
  let prevJob = null;

  for (const t of trips) {
    const g = gapBefore.get(t);
    if (!g && prevJob && prevJob.e == null && t.s - prevJob.s >= UNMEASURED_MIN) {
      const row = el('div', 'dday-gap');
      row.dataset.from = String(prevJob.s); row.dataset.to = String(t.s);
      row.innerHTML = `<div class="dday-gaphead"><b>${esc(dur(t.s - prevJob.s))} unaccounted for</b>`
        + `<span class="dim">until ${esc(hhmm(t.s))}</span></div>`;
      row.append(el('div', 'dday-where dim',
        `The job before this one was ${esc(outcomeWord(prevJob))} and has no end time, so there `
        + 'is no moment to measure a wait from. This time is not counted as waiting anywhere on '
        + 'this page.'));
      list.append(row);
    }
    prevJob = t;
    if (g) {
      const mins = g.to - g.from;
      const mo = gapMotion(fixes, g.from, g.to);
      const row = el('div', `dday-gap${mins >= 90 ? ' long' : ''}`);
      row.dataset.from = String(g.from); row.dataset.to = String(g.to);
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

    /* EQUALITY, NOT A SUBSTRING MATCH — this read `/completed/i.test(t.outcome)`
       and "not_completed" CONTAINS "completed", so every cancelled job on this
       page was badged COMPLETED and styled as a normal one.
       ─────────────────────────────────────────────────────────────────────
       Found on production 2026-09-14 on one driver's day: eight consecutive
       rider cancellations between 00:12 and 01:18 — no distance, no drop-off
       time, outcome 'not_completed' — every one of them rendered with a
       COMPLETED pill. The page that says "every job, and the gaps between
       them" was reporting thirteen completed jobs where five had happened.

       Two lines above in this same file get it right
       (`/not_completed|cancel/i`, which tests the negative first), which is
       what made this survive: the row's colour class came from the correct
       test and the badge from the broken one, so the two disagreed silently.

       outcome is exactly 'completed' or 'not_completed' everywhere else in
       this product — src/analyst.js, api/driver_routes.js and
       api/cancellation_sql.js all compare it with =, never with a regex — so
       this compares it the same way.

       Exported rather than inlined so test/driver_day_outcome.test.mjs can put
       the real production row through it. The first version of this guard was
       a regex nobody could test without rendering a page, which is most of why
       it survived. */
    const done = jobCompleted(t);
    const item = el('div', `dday-job${done ? '' : ' bad'}`);
    item.dataset.s = String(t.s);
    const when = el('div', 'dday-when');
    when.innerHTML = `<b>${esc(hhmm(t.s))}</b><span>${t.e != null ? esc(hhmm(t.e)) : '—'}</span>`;
    const body = el('div', 'dday-body');
    body.innerHTML = `
      <div class="dday-leg">
        <div class="dday-pt"><i class="o"></i><span class="dday-lab">pick-up</span>
          <b>${esc(t.pickup_addr || 'no address reported')}</b></div>
        ${done || (t.dropoff_addr && t.dropoff_addr !== t.pickup_addr)
    ? `<div class="dday-pt"><i class="x"></i><span class="dday-lab">drop-off</span>
          <b>${esc(t.dropoff_addr || 'no address reported')}</b></div>`
    /* A JOB THAT DID NOT HAPPEN HAS NO DROP-OFF, and Uber echoes the pick-up
       into the drop-off column when there was none — so the page was printing
       the address the car was waiting at under a DROP-OFF heading, which reads
       as a statement about where somebody was taken. There is no drop-off time
       and no distance on these rows either; the echo is the only thing that
       made it look like a journey. */
    : `<div class="dday-pt"><i class="x"></i><span class="dday-lab">drop-off</span>
          <b class="dim">none — this job did not take place</b></div>`}
      </div>
      <div class="dday-facts">
        ${t.distance_km != null ? `<span><b>${esc(fmt(t.distance_km, 2))}</b> km</span>` : ''}
        ${t.e != null ? `<span><b>${esc(dur(t.e - t.s))}</b> on trip</span>` : ''}
        ${t.product ? `<span>tier <b>${esc(tierLabel(t.product))}</b></span>` : ''}
        ${t.payment_type ? `<span>paid <b>${esc(t.payment_type)}</b></span>` : ''}
        ${t.price != null ? `<span><b>${esc(money(t.price))}</b></span>` : ''}
        <span class="dday-out">${pill(done ? 'completed' : outcomeWord(t),
    done ? 'ok' : 'bad')}</span>
      </div>`;
    const open = el('a', 'dday-open', 'open ↗');
    open.href = href('trip', t.platform, t.external_id);
    item.append(when, body, open);
    list.append(item);
  }
  listP.body.append(list);
  if (ak) { dayAreas(root, fixes, wh); dayAbsence(root, { trips, fixes, day, mv, wh }); }
  unbookedP.then((res) => unbookedOnDay(root, { res, day, list }));
}

/* ── journeys no channel booked, on this day ─────────────────────────────
   The operator, 2026-10-14: "unauthorized trips should show on activity tab
   and daily pages". /api/driver/unauthorized for this one day, folded into
   rides by api/public/unbooked.js (the server's own rule: a ride once), and
   put where the day already says what happened:

     · a row on the band, on the same clock as the jobs, Uber's two rows and
       the car — solid where this person is NAMED beside the ride, hollow
       where they are one of several who held the car;
     · each ride in the list of jobs and gaps, at its time, with the rung in
       words and the working the attribution rests on, and the way to the
       journey itself. Never styled or worded as their job.

   A failed answer says so and claims nothing. A role without ACCUSE is told
   its role does not see it. A day the seat sensor did not watch is said. */
function unbookedOnDay(root, { res, day, list }) {
  if (!root.isConnected) return;
  const band = root.querySelector('.dday-rows');
  const bandBody = band?.parentElement;
  const say = (text, tone) => { if (bandBody) bandBody.append(el('div', `dday-onbasis${tone ? '' : ' dim'}`, esc(text))); };
  if (res && res.withheld) { say(`Journeys no channel booked: not shown to your role — ${res.withheld}`); return; }
  if (!readable(res)) {
    say('The journeys no channel booked could not be loaded for this day, so none is shown. This says '
      + 'nothing about whether there were any — the request for them failed.', 'warn');
    return;
  }
  const clock = (ms) => { const x = new Date(ms + 4 * 3600e3); return `${String(x.getUTCHours()).padStart(2, '0')}:${String(x.getUTCMinutes()).padStart(2, '0')}`; };
  const rides = (ridesOf(res) || []).filter((r) => r.pieces.some((p) => p.day === day));
  const pct = (m) => (m / 1440) * 100;
  const cov = res.coverage || {};
  if (truncationWords(res)) say(truncationWords(res), 'warn');
  if (!rides.length) {
    say(cov.days_with_data === 0
      ? `No journey no channel booked can be shown for this day: ${coverageWords(cov)}`
      : 'No journey that no channel booked names this person, or lists them among those who held the car, on this day.');
    return;
  }
  const named = rides.filter((r) => r.named).length;
  /* The row on the band, before the ruler. */
  if (band) {
    const row = el('div', 'dday-onrow dday-unrow');
    row.innerHTML = '<span class="dday-onlab">unbooked journeys</span>';
    const track = el('div', 'dday-online dday-unbooked');
    track.innerHTML = rides.map((r) => {
      const piece = r.pieces.find((p) => p.day === day);
      return `<i class="${r.named ? 'x' : 'xc'}" style="left:${pct(piece.s)}%;width:${pct(Math.max(4, piece.e - piece.s))}%" title="${esc(rideWords(r, { clock }).line)}"></i>`;
    }).join('');
    row.append(track, el('span', 'dday-ontot', `${rides.length} · ${named} named`));
    const ruler = band.querySelector('.dday-ruler')?.parentElement;
    band.insertBefore(row, ruler || null);
    const lg = bandBody.querySelector('.lgnd');
    if (lg) {
      if (named) lg.insertAdjacentHTML('beforeend', '<span><i class="sw x"></i>unbooked journey, this person named beside it</span>');
      if (rides.length > named) lg.insertAdjacentHTML('beforeend', '<span><i class="sw xc"></i>unbooked journey, one of several who held the car</span>');
    }
  }
  /* Each ride in the list, at its time. A day with no job has no list, so
     the rides get one of their own, under the band. */
  let host = list;
  if (!host) {
    const p = panel('Journeys no channel booked on this day',
      'What the seat sensor saw with a passenger aboard that no channel booked, on a car this person held');
    root.append(p.panel);
    host = el('div', 'dday-list');
    p.body.append(host);
  }
  for (const r of rides) {
    const w = rideWords(r, { clock });
    const piece = r.pieces.find((p) => p.day === day);
    const item = el('div', `dday-job dday-unb ${r.named ? 'named' : 'cand'}`);
    item.dataset.s = String(piece.s);
    const when = el('div', 'dday-when');
    when.innerHTML = `<b>${esc(clock(r.start))}</b><span>${esc(clock(r.end))}</span>`;
    const body = el('div', 'dday-body');
    body.innerHTML = `
      <div class="dday-leg">
        <div class="dday-pt"><i class="o"></i><span class="dday-lab">unbooked journey · from</span>
          <b>${esc(r.from || 'ground no trip has named')}</b></div>
        <div class="dday-pt"><i class="x"></i><span class="dday-lab">to</span>
          <b>${esc(r.to || 'ground no trip has named')}</b></div>
      </div>
      <div class="dday-facts">
        ${r.km != null ? `<span><b>${esc(fmt(r.km, 2))}</b> km</span>` : ''}
        <span><b>${esc(dur(Math.max(1, Math.round((r.end - r.start) / 60000))))}</b> with a passenger aboard</span>
        <span>car <b>${esc(r.plate)}</b></span>
        <span>seen by <b>${esc(r.sources.join(' and '))}</b></span>
        <span class="dday-out">${pill(r.named ? 'named beside it' : 'one of several', r.named ? 'bad' : null)}</span>
      </div>
      <div class="dday-why">${esc(w.rung.charAt(0).toUpperCase() + w.rung.slice(1))}. No channel booked this journey; this is an inference from the booking record, not a record of who drove.${
  r.evidence ? `<br><span class="dim">${esc(r.evidence)}</span>` : ''}</div>`;
    const open = el('a', 'dday-open', 'open ↗');
    open.href = href('segment', r.plate, r.anchor.started_at, r.source ? { source: r.source } : null);
    item.append(when, body, open);
    const next = [...host.children].find((c) => c.classList.contains('dday-job') && Number(c.dataset.s) > piece.s);
    host.insertBefore(item, next || null);
    /* A ride inside a wait is said IN the wait. Ordered by start the ride
       already sits after the wait that holds it, but the wait above it still
       reads "waiting 2h 44m" while the car carried a passenger for half an
       hour of it (seen on the mock, 2026-10-14). The wait's minutes stay as
       the booking record measured them — the ride's attribution is an
       inference, and subtracting it would turn the inference into a figure —
       so the wait names the ride instead. */
    for (const gap of host.querySelectorAll('.dday-gap[data-from]')) {
      if (Number(gap.dataset.from) < piece.e && Number(gap.dataset.to) > piece.s) {
        gap.append(el('div', 'dday-where dday-ungap', esc(`Inside this wait the car made a journey no channel booked, `
          + `${w.when} on ${r.plate} — ${r.named ? 'this person named beside it' : 'this person one of several who held the car'}; `
          + `${Number(gap.dataset.from) <= piece.s ? 'below' : 'above'}.`)));
      }
    }
  }
  root.dataset.unbooked = String(rides.length);
}

/* ── #driver/day under the page contract ─────────────────────────────────── */
/* Four tiles. The day's own figures come from the arithmetic above; the
   month they are set against is /api/driver/kpis over the calendar month
   holding the day — trips a working day is its trips over its days worked.
   A month that will not load leaves the tiles without a comparison rather
   than holding the page. */
async function dayGlance(AKB, { id, day, trips, onJob, share, medianGap, km }) {
  const priced = trips.filter((t) => t.price != null);
  const value = priced.reduce((a, t) => a + Number(t.price), 0);
  const draw = (perDay) => {
    const tripTile = { label: 'Trips', value: fmt(trips.length), sub: `${fmt(km, 1)} km over them` };
    if (perDay != null) {
      tripTile.delta = { value: trips.length - perDay, kind: 'gap', d: 1,
        of: `against ${fmt(perDay, 1)} a working day this month` };
    }
    AKB.tilesHost.innerHTML = '';
    glance(AKB.tilesHost, bandTiles([
      { label: 'Carrying someone', value: dur(onJob), hero: true, sub: `request to dropoff, ${trips.length} ${trips.length === 1 ? 'job' : 'jobs'}` },
      share.basis === 'online'
        ? { label: 'Online and waiting', value: dur(share.idleMin), sub: medianGap != null ? `median gap between jobs ${dur(medianGap)}` : 'one job, no gap' }
        : { label: 'Online and waiting', na: share.basis === 'refused' ? share.why
          : 'Uber availability has not been collected for this day, so the waiting cannot be split into online and offline' },
      tripTile,
      { label: 'Distance', value: `${fmt(km, 1)} km`,
        sub: priced.length ? `trip value ${money(value)} over ${fmt(priced.length)} priced · ${fmt(km / trips.length, 2)} km a job`
          : `${fmt(km / trips.length, 2)} km a job · no job here carries a fare` },
    ]).tiles);
  };
  draw(null);
  const m0 = `${day.slice(0, 7)}-01`;
  /* The month's last day, from the day's own digits: the count of days in the
     month (day 0 of the next one, read back in UTC) — no clock, no zone, and
     not the `toISOString().slice(0, 10)` shape test/timezone.test.mjs bans. */
  const dim = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7), 0)).getUTCDate();
  const end = `${day.slice(0, 7)}-${String(dim).padStart(2, '0')}`;
  try {
    const k = await api(`/api/driver/kpis?id=${encodeURIComponent(id)}&from=${m0}&to=${end}`);
    const perDay = k && Number(k.days_worked) > 0 ? Number(k.trips) / Number(k.days_worked) : null;
    if (perDay != null && AKB.tilesHost.isConnected) draw(perDay);
  } catch { /* the day stands on its own figures */ }
}
/* Where the tracker saw the car: fixes by area, ranked. A fix with no area
   is counted apart, never drawn as a place. */
function dayAreas(root, fixes, wh = {}) {
  const p = panel('Where the tracker saw the car', 'Tracker fixes of the day, by the area each one falls in.', 'dday-areas');
  root.append(p.panel);
  if (wh.fixes) { empty(p.body, withheldSentence('LOC')); return; }
  if (!fixes.length) { empty(p.body, 'No tracker fix reached this day while a car was his.'); return; }
  const by = new Map();
  let none = 0;
  fixes.forEach((f) => { if (f.area) by.set(f.area, (by.get(f.area) || 0) + 1); else none += 1; });
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, n]) => ({ label, n }));
  if (rows.length) hbars(p.body, rows, { signed: false, color: '--mk-fill' });
  p.body.append(el('p', 'cap', `${fmt(fixes.length)} fixes`
    + (none ? `; ${fmt(none)} carry no area and are not drawn as a place` : '')
    + (by.size > 12 ? `; the 12 busiest of ${fmt(by.size)} areas shown` : '') + '.'));
}
function dayAbsence(root, { trips, fixes, day, mv = {}, wh = {} }) {
  const noSpeed = fixes.filter((f) => f.speed == null).length;
  const t = mv.totals || {};
  const absHost = el('div'); root.append(absHost);
  absenceBand(absHost, [
    { label: 'A speed on a fix', hl: noSpeed > 0, fig: fixes.length ? `${fmt(noSpeed)} of ${fmt(fixes.length)}` : null,
      none: wh.fixes ? 'Withheld' : 'No fix',
      why: wh.fixes ? withheldSentence('LOC')
        : fixes.length ? 'The tracker reports a speed only while the car moves, so a stationary fix carries none.'
          : 'No tracker fix reached this day while a car was his.' },
    /* MEASURED NOW WHERE THE TRACKER READS THE SEAT (2026-10-13). This read
       "Not measured" because no BOOKING channel splits a job's distance; the
       car's own tracker does — FMS sends a passenger count, CABMAN a seat
       flag — so over the hours the car was his the distance with someone in
       it is the tracker's reading, not an inference from the jobs. */
    wh.veh ? { label: 'Distance with a passenger in', fig: null, none: 'Withheld', why: withheldSentence('VEH') }
    : t.seat_reported
      ? { label: 'Distance with a passenger in', fig: `${fmt(t.km_with_passenger, 1)} km`,
        why: `Of ${fmt(t.km, 1)} km the tracker saw while the car was his, by its own seat reading`
          + `${t.km_seat_not_reported ? ` (${fmt(t.km_seat_not_reported, 1)} km with no reading)` : ''}. A job’s distance still holds the drive to the rider.` }
      : { label: 'Distance with a rider in', fig: null, none: 'Not measured',
        why: fixes.length ? 'The tracker in this car sends no seat reading, and no booking channel splits a job’s distance.'
          : 'A job’s distance runs request to dropoff and holds the drive to the rider; no channel splits it.' },
    { label: 'Money for this day', fig: null, none: 'Not per day',
      why: 'Payouts are weekly statements; a day’s money here would be a share of a week, not a measurement of the day.' },
    { label: 'When the rider got in', fig: null, none: 'Not sent',
      why: 'No channel here reports a pickup time.' },
  ]);
  pageFoot({ colophon: [dayStr(`${day}T12:00:00`), `${trips.length} ${trips.length === 1 ? 'job' : 'jobs'}`] }, root);
}

/* ── around the day: yesterday, today, tomorrow ────────────────────────────
   The page was reachable only from a bar on the Activity tab, which draws
   the days the stored record holds — and today's online time with no
   booking yet was on none of them. Dubai's calendar, from the day's own
   digits; no browser clock is read except for "today". */
const dubaiToday = () => dubaiDay();
const shiftDay = (day, n) => {
  const t = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
};
function dayNav(root, id, day) {
  const today = dubaiToday();
  /* Through href's own query, never "+?on=": href already carries the
     shell's period (`?period=month`), and a second "?" made every one of
     these links land on the "addressed as" note (review, 2026-10-13). */
  const to = (k) => href('driver', id, 'day', { on: k });
  const nav = el('nav', 'dday-nav');
  const prev = shiftDay(day, -1); const next = shiftDay(day, 1);
  nav.innerHTML = `<a href="${esc(to(prev))}">← ${esc(dayStr(`${prev}T12:00:00`))}</a>`
    + (day !== today ? `<a class="dday-today" href="${esc(to(today))}">today</a>` : '<span class="dday-today on">today</span>')
    + (next <= today ? `<a href="${esc(to(next))}">${esc(dayStr(`${next}T12:00:00`))} →</a>` : '<span class="dim">—</span>');
  root.append(nav);
}

/* Minutes of a list of spans. */
const minsOf = (spans) => spanMin(merge(spans.map((o) => ({ s: +o.s, e: +o.e }))));
const STATUS_WORD = { online: 'online', ontrip: 'on a trip', offline: 'offline' };

/* ── a day with no booking on record: the verdict from what IS known ────── */
function quietDay(root, { d, day, status, online, mv, wh = {} }) {
  const live = status.filter((x) => x.status !== 'offline');
  const liveMin = minsOf(live);
  const logMin = minsOf(online);
  const onTrip = minsOf(status.filter((x) => x.status === 'ontrip'));
  /* The day's first REAL start: a spell carried in from before midnight is
     not a start at 00:00 (review, 2026-10-13). */
  const carried = live.find((x) => x.carried_in);
  const starts = [...live.filter((x) => !x.carried_in).map((x) => x.s), ...online.filter((o) => o.s > 0).map((o) => o.s)].sort((a, b) => a - b);
  const lastSt = status[status.length - 1];
  const t = mv.totals || {};
  const windows = mv.windows || [];
  /* A distance needs positions: a car on record whose tracker sent nothing
     has no distance, not a distance of nought (review, 2026-10-13). */
  const measured = !mv.absent && (t.fixes || 0) >= 2;
  const ak = contract();
  const AKB = ak ? glanceBand(root, dayStr(`${day}T12:00:00`)) : null;
  const onlineMin = liveMin || logMin;
  const claim = wh.trips
    ? 'Bookings are not shown to your role'
    : d.today ? 'No booking from today has reached us yet' : 'No booking on this day';
  verdict(ak ? AKB.vHost : root, {
    claim: onlineMin ? `${claim} — ${dur(onlineMin)} online` : claim,
    figure: onlineMin ? dur(onlineMin) : '—',
    unit: liveMin ? 'online per Uber’s live feed' : logMin ? 'online per Uber’s log-in record' : 'no online record',
    meta: measured && windows.length ? `${fmt(t.km, 1)} km in the car` : '',
    sub: [
      carried ? 'Already online when the day began' : null,
      starts.length ? `${carried ? 'Next online' : 'First online'} ${hhmm(starts[0])}` : null,
      onTrip ? `${dur(onTrip)} on a trip by Uber’s live feed` : null,
      d.today && lastSt && lastSt.open_ended ? `${STATUS_WORD[lastSt.status] || lastSt.status} since ${hhmm(lastSt.s)}` : null,
      d.status_stale || null,
      /* WHY there is no booking, said rather than left as a puzzle beside a
         driver who was plainly working — and only when that is the reason. */
      wh.trips ? withheldSentence('BK', { level: wh.bkLevel === 'A' ? 'A' : '' })
        : d.today ? 'Uber files a trip about half an hour after it and the trip feed runs every half hour, so today’s trips arrive behind the live status' : null,
      /* Two records, said as two: the log-in record is collected every few
         hours and can hold less (today, not yet fetched) or more (a heartbeat
         the live feed did not repeat) than the live feed. */
      liveMin && logMin && liveMin !== logMin
        ? (d.today && logMin < liveMin
          ? `Uber’s log-in record, collected every few hours, holds ${dur(logMin)} of it so far`
          : `Uber’s log-in record holds ${dur(logMin)} for the day`) : null,
    ].filter(Boolean).join('. ') + '.',
  });
  if (ak) {
    const carNa = wh.veh ? withheldSentence('VEH')
      : wh.predates ? 'this answer predates the car’s movement record — reload'
        : mv.absent || 'no car is on record as his';
    glance(AKB.tilesHost, bandTiles([
      { label: 'Online', value: onlineMin ? dur(onlineMin) : null, hero: true,
        na: onlineMin ? null : 'Uber has no online record for this day',
        sub: liveMin ? 'Uber’s live feed' : 'Uber’s log-in record' },
      { label: 'On a trip', value: onTrip ? dur(onTrip) : null,
        na: onTrip ? null : (status.length ? 'no trip on Uber’s live feed' : 'Uber’s live feed has nothing for this day'),
        sub: 'Uber’s live feed — ahead of the bookings' },
      windows.length && measured && !wh.veh
        ? { label: 'The car moved', value: `${fmt(t.km, 1)} km`, sub: `${windows.map((w) => w.plate).filter(Boolean).join(', ')} · tracker` }
        : { label: 'The car moved', na: carNa },
      !wh.veh && measured && t.seat_reported
        ? { label: 'With a passenger', value: `${fmt(t.km_with_passenger, 1)} km`, sub: `${dur(t.with_passenger_min)} by the tracker’s seat reading` }
        : { label: 'With a passenger', na: wh.veh || !measured ? carNa : 'this car’s tracker sends no seat reading' },
    ]).tiles);
  }
}

/* A channel's colour at one state of its ramp, with the old skin's identity
   colour behind it (the ramps are Arkiv tokens; app.css aliases --c-<ch>). */
const chColor = (source, state = null) => {
  const k = channelKey(String(source || ''));
  if (!k) return 'var(--grey)';
  /* The old skin defines only the identity colour; the three states were one
     colour there, and the legend three identical swatches (review,
     2026-10-13). Its fallback is the identity at falling strength over the
     page — distinct steps on a light or a dark ground. */
  const mix = { engaged: 100, available: 62, idle: 34 }[state];
  if (!state || mix == null) return `var(--c-${k})`;
  return `var(--c-${k}-${state}, color-mix(in srgb, var(--c-${k}) ${mix}%, transparent))`;
};

/* ── the day as one band ─────────────────────────────────────────────────
   Every row on one 24-hour ruler: the jobs in their platform's colour, Uber's
   log-in record, Uber's live status, and the car as its tracker saw it —
   a passenger aboard, moving, stopped, and nothing where it was silent.
   Coloured by the channel ramps (api/public/tokens.js RAMP: engaged,
   available, idle), the operator's palette, so Uber's rows read as Uber and
   the car's as its tracker's. */
function drawBand(root, { d, trips, online, status, mv, wh = {} }) {
  const bandP = panel('The day, midnight to midnight', d.basis);
  root.append(bandP.panel);
  const pct = (m) => (m / 1440) * 100;
  /* ONE CLOCK FOR EVERY ROW. Each row is label · track · total with the
     same widths, so a minute sits at the same x in the jobs, both of Uber's
     rows and the car — the first version drew the jobs across the full width
     and the rest after a label column, and 12:00 was in two places. The
     notes go under the rows, so the rows stay side by side. */
  const rows = el('div', 'dday-rows');
  bandP.body.append(rows);
  const notes = [];
  const row = (label, cls, inner, total) => {
    const r = el('div', 'dday-onrow');
    r.innerHTML = `<span class="dday-onlab">${esc(label)}</span>`;
    const b = el('div', cls); b.innerHTML = inner; r.append(b);
    r.append(el('span', 'dday-ontot', total));
    rows.append(r);
  };
  if (trips.length) {
    row('jobs', 'dday-band', trips.map((t) => {
      const known = t.e != null;
      const w = known ? Math.max(t.e - t.s, 3) : 10;
      const cx = /not_completed|cancel/i.test(t.outcome || t.status || '');
      const cls = cx ? 'cx' : known ? 'j' : 'u';
      /* The platform's own colour for a job that ran; a job that did not
         complete keeps the critical colour, and one with no drop-off the
         hatch — those two say something about the job, not the channel. */
      const paint = !cx && known ? ` background:${chColor(t.platform, 'engaged')};` : '';
      return `<i class="${cls}" style="left:${pct(t.s)}%;width:${pct(w)}%;${paint}" title="${esc(sourceLabel(t.platform))} ${esc(hhmm(t.s))}–${
        known ? esc(hhmm(t.e)) : 'no dropoff reported'}"></i>`;
    }).join(''), `${trips.length} ${trips.length === 1 ? 'job' : 'jobs'}`);
  }
  const onlineMin = minsOf(online);
  if (online.length) {
    /* An OPEN-ENDED span is one whose closing event has not arrived: the last
       ONLINE Uber sent, with nothing after it yet. "Online until 14:00" and
       "online at 14:00, and that is the last we were told" are different
       claims and the bar looks identical, so the hover says WHICH BOUND ended
       it — the three are not interchangeable and only one of them is about the
       driver. 'collection' in particular is a fact about us: it is where we
       stopped asking Uber, not where they stopped working. */
    const endWhy = (o) => ({
      collection: `online from ${hhmm(o.s)}; ${hhmm(o.e)} is the last moment we asked Uber `
        + 'about this driver, not a moment they stopped',
      now: `online from ${hhmm(o.s)}; no later event has arrived, so this is drawn to now`,
      day: `online from ${hhmm(o.s)}; no later event has ever arrived, so this is drawn to the `
        + 'end of the day',
    }[o.closed_by] || `online from ${hhmm(o.s)}; no later event has arrived, so this is drawn `
      + `to ${hhmm(o.e)}`);
    row('online, Uber log-in record', 'dday-online', online.map((o) =>
      `<i class="${o.open_ended ? 'open' : ''}" style="left:${pct(o.s)}%;width:${pct(Math.max(2, o.e - o.s))}%" title="${
        o.open_ended ? esc(endWhy(o)) : `online ${esc(hhmm(o.s))}–${esc(hhmm(o.e))}`}"></i>`).join(''), dur(onlineMin));
    /* Under the band, where the band stops. The collector runs a few times a
       day and the trip feed every half hour, so the right-hand end of this bar
       is routinely the collector's reach rather than the driver's evening. */
    if (d.collection && d.collection.complete === false && d.collection.why) notes.push(el('div', 'dday-onbasis dim', d.collection.why));
  }
  /* Uber's LIVE status — ahead of the log-in record, current to the minute. */
  const live = status.filter((x) => x.status !== 'offline');
  if (status.length) {
    row('status, Uber live feed', 'dday-online dday-status', live.map((x) =>
      `<i class="${x.status === 'ontrip' ? 'st-trip' : 'st-on'}${x.open_ended ? ' open' : ''}" style="left:${pct(x.s)}%;width:${pct(Math.max(2, x.e - x.s))}%" title="${
        esc(STATUS_WORD[x.status] || x.status)} ${esc(hhmm(x.s))}–${x.open_ended ? 'now' : esc(hhmm(x.e))}"></i>`).join(''), dur(minsOf(live)));
  }
  /* The car, as its tracker saw it while it was his. */
  const runs = mv.runs || [];
  const plates = (mv.windows || []).map((w) => w.plate).filter(Boolean);
  if (runs.length) {
    row(`the car${plates.length ? ` · ${plates.join(', ')}` : ''}`, 'dday-online dday-car', runs.map((r) =>
      `<i class="${r.seat == null && r.state !== 'idle' ? 'noseat' : ''}" style="left:${pct(r.s)}%;width:${pct(Math.max(1, r.e - r.s))}%;background-color:${
        chColor(r.source, r.state)}" title="${esc(hhmm(r.s))}–${esc(hhmm(r.e))} ${esc(r.state === 'engaged' ? 'a passenger aboard'
        : r.state === 'available' ? (r.seat == null ? 'moving — no seat reading' : 'moving, no passenger') : 'stopped')} · ${esc(sourceLabel(r.source))}"></i>`).join(''),
      mv.totals?.km != null ? `${fmt(mv.totals.km, 1)} km` : '');
  } else if (wh.veh) {
    notes.push(el('div', 'dday-onbasis dim', `What the car was doing: ${withheldSentence('VEH')}`));
  }
  /* A live feed that stopped answering is said under the rows it ends. */
  if (d.status_stale) notes.push(el('div', 'dday-onbasis dim', `${d.status_stale}.`));
  const rulerRow = el('div', 'dday-onrow');
  rulerRow.innerHTML = '<span class="dday-onlab"></span>';
  const ruler = el('div', 'dday-ruler');
  ruler.innerHTML = [0, 6, 12, 18, 24].map((h) =>
    `<span style="left:${(h / 24) * 100}%">${String(h).padStart(2, '0')}:00</span>`).join('');
  rulerRow.append(ruler, el('span', 'dday-ontot', ''));
  rows.append(rulerRow);
  notes.forEach((n) => bandP.body.append(n));
  /* WHERE they went online, which is the supply question the bars above
     cannot answer. Uber returns no coordinates on the timeline, so this is
     the tracker's position at the moment of each transition — the API says
     so in place_basis and this repeats it, because a number whose basis is
     not on the same screen as the number is a number nobody can check.

     Every span is accounted for: the ones that could be placed, by area,
     and the ones that could not, counted. A list that silently dropped the
     unplaceable spans would read as though the fleet knew more than it does.
     The live feed's spells are placed too: on a day the log-in record has
     not reached yet, they are the only "went online" there is. */
  const starts = [...(d.goes_online_in || [])];
  const liveStarts = status.filter((x) => x.went_online?.where);
  const said = [...starts.map((a) => `<b>${esc(a.area)}</b><span class="dim"> ${a.spans}×</span>`),
    ...liveStarts.filter((x) => !starts.some((a) => a.area === x.went_online.where))
      .map((x) => `<b>${esc(x.went_online.where)}</b><span class="dim"> at ${esc(hhmm(x.s))}</span>`)];
  const unplaced = d.online_spans_unplaced || 0;
  if (said.length || unplaced) {
    const wl = el('div', 'dday-onwhere');
    wl.innerHTML = (said.length
      ? `went online in ${said.join('<span class="dim"> · </span>')}`
      : '<span class="dim">where they went online could not be established</span>')
      + (unplaced ? `<span class="dim"> · ${unplaced} ${unplaced === 1 ? 'span' : 'spans'} could not be placed</span>` : '');
    bandP.body.append(wl);
    if (d.place_basis) bandP.body.append(el('div', 'dday-onbasis dim', d.place_basis));
  }

  const sources = [...new Set(runs.map((r) => r.source))];
  const platforms = [...new Set(trips.filter((t) => t.e != null && !/not_completed|cancel/i.test(t.outcome || t.status || '')).map((t) => t.platform))];
  const sw = (bg, text, cls = '') => `<span><i class="sw ${cls}" style="background:${bg}"></i>${esc(text)}</span>`;
  const lg = el('div', 'lgnd');
  lg.innerHTML = platforms.map((p) => sw(chColor(p, 'engaged'), `on a ${sourceLabel(p)} job`)).join('')
    + (trips.length ? '<span><i class="sw waitsw"></i>waiting for the next one</span>' : '')
    + (trips.some((t) => /not_completed|cancel/i.test(t.outcome || t.status || ''))
      ? '<span><i class="sw cx"></i>did not complete</span>' : '')
    + (online.length || live.length ? sw(chColor('uber', 'available'), 'online (Uber)') : '')
    + (live.some((x) => x.status === 'ontrip') ? sw(chColor('uber', 'engaged'), 'on a trip (Uber, live)') : '')
    + sources.map((s) => sw(chColor(s, 'engaged'), `passenger aboard (${sourceLabel(s)})`)
      + sw(chColor(s, 'available'), 'moving, no passenger') + sw(chColor(s, 'idle'), 'stopped')
      + (runs.some((r) => r.source === s && r.seat == null && r.state !== 'idle')
        ? `<span><i class="sw noseat" style="background-color:${chColor(s, 'available')}"></i>moving, no seat reading</span>` : '')).join('')
    + (runs.length ? '<span><i class="sw nopos"></i>no position</span>' : '');
  bandP.body.append(lg);
}

/* ── where the car went ──────────────────────────────────────────────────
   The tracker's day while the car was his: a map of the track coloured by
   the seat, and the same day as a log — each stop with its place and length,
   each drive with where from and to, how far, and whether a passenger was
   in — with Uber's status changes in their place among them. */
async function renderMovement(root, { d, status, trips, wh = {} }) {
  const mv = d.movement || {};
  const p = panel('Where the car went', mv.basis || '');
  /* `mapwrap` opts the panel out of the charts' `svg{width:100%}` rule
     (app.css), which collapses Leaflet's overlay pane — the track drew
     nowhere and the attribution flag filled the corner on the first render. */
  p.panel.classList.add('mapwrap');
  root.append(p.panel);
  if (wh.predates) {
    /* An answer from before the movement record existed — a copy cached
       before the deploy — is not "no car is on record" (review, 2026-10-13). */
    p.body.append(note('This answer predates the car’s movement record. Reload the page for the hours the car was his and where it went.'));
    return;
  }
  if (mv.segments === null || wh.fixes) {
    p.body.append(note(`Where the car went: ${withheldSentence('LOC')}`));
    return;
  }
  const windows = mv.windows || [];
  if (!windows.length || mv.absent) {
    empty(p.body, mv.absent ? `${mv.absent.charAt(0).toUpperCase()}${mv.absent.slice(1)}.` : 'No car is on record as his on this day.');
    if (!windows.length) return;
  }
  /* Whose car, when — said, with how it is known. The hours come from his
     bookings as well as Uber's record, so a role not shown bookings gets the
     car and not the hours; `shared` and `others` name other drivers' records
     and are withheld the same way — null, said, never read (the Fleet
     technician's page threw on `w.shared.length`, review 2026-10-13). */
  const BASIS = { booking: 'his bookings', uber_vehicle: 'Uber’s record of the vehicle he was working in' };
  const who = el('div', 'dday-held');
  who.innerHTML = windows.map((w) => {
    const shared = Array.isArray(w.shared) ? w.shared : [];
    const head = w.from == null || w.to == null
      ? `<b>${esc(w.plate || 'A car')}</b> was his on this day<span class="dim"> · ${esc(withheldSentence('BK', { level: wh.bkLevel === 'A' ? 'A' : '' }))}</span>`
      : `<b>${esc(w.plate || 'A car')}</b> was his ${esc(hhmm(w.from))}–${
        d.today && w.to >= (d.now_min ?? 1441) ? 'now' : esc(hhmm(w.to))}<span class="dim"> · by ${esc(listWords((w.basis || []).map((b) => BASIS[b] || b)))}${
        w.stretched ? ', to the edges of the online spell it sits in' : ''}</span>`;
    const tracker = w.second_tracker
      ? `<div class="dim">${esc(w.plate || 'This car')} carries two trackers, which put it kilometres apart at the same minute; ${esc(sourceLabel(w.second_tracker.kept))} is shown and ${
        esc(listWords(w.second_tracker.dropped.map((x) => `${sourceLabel(x.source)}’s ${fmt(x.fixes)} positions`)))} are left out.</div>` : '';
    return `<div>${head}${shared.length ? `<div class="dday-warn">${esc(listWords(shared.map((x) => `${x.who || 'another driver'} ${hhmm(x.s)}${x.e > x.s ? `–${hhmm(x.e)}` : ''}`)))} is on record in this car inside these hours too — the record cannot say whose those minutes were.</div>` : ''}${
      w.overlap ? '<div class="dday-warn">He is on record in two cars at once here; both are shown, neither is chosen.</div>' : ''}${tracker}</div>`;
  }).join('')
    + (Array.isArray(mv.others) && mv.others.length
      ? `<div>${esc(listWords(mv.others.map((o) => `${o.who || 'another driver'} ${hhmm(o.s)}${o.e > o.s ? `–${hhmm(o.e)}` : ''} (${o.plate})`)))} ${mv.others.length === 1 ? 'is' : 'are'} on record in his car between his hours in it — not shown as his.</div>` : '')
    + (mv.outside_fixes ? `<div class="dim">The tracker reported ${fmt(mv.outside_fixes)} more ${mv.outside_fixes === 1 ? 'position' : 'positions'} for ${
      windows.length === 1 ? 'this car' : 'these cars'} outside those hours — another driver’s, or the car with nobody on record. They are not shown as his.</div>` : '');
  p.body.append(who);
  if (mv.absent) return;

  const t = mv.totals || {};
  const sum = el('div', 'dday-msum');
  if (wh.veh) sum.innerHTML = `<span class="dim">${esc(withheldSentence('VEH'))}</span>`;
  else sum.innerHTML = [
    `<span><b>${esc(fmt(t.km, 1))}</b> km driven</span>`,
    t.seat_reported ? `<span><b>${esc(fmt(t.km_with_passenger, 1))}</b> km with a passenger</span>` : null,
    t.seat_reported ? `<span><b>${esc(fmt(t.km_empty, 1))}</b> km empty</span>` : null,
    t.km_seat_not_reported ? `<span><b>${esc(fmt(t.km_seat_not_reported, 1))}</b> km with no seat reading</span>` : null,
    `<span><b>${esc(dur(t.stopped_min))}</b> stopped</span>`,
    t.unseen_min ? `<span><b>${esc(dur(t.unseen_min))}</b> with no position</span>` : null,
    `<span class="dim">${esc(fmt(t.fixes))} positions · ${esc(listWords((t.sources || []).map((s) => sourceLabel(s))))}</span>`,
  ].filter(Boolean).join('');
  p.body.append(sum);

  /* The map: the track split where the tracker went silent, so a straight
     line is never drawn across a stretch nobody saw. */
  const fixes = d.fixes || [];
  if (fixes.length >= 2) {
    const node = el('div', 'dday-map');
    p.body.append(node);
    try {
      const { makeMap, renderJourney } = await import('./map.js');
      const segs = [];
      fixes.forEach((f, i) => {
        const prev = fixes[i - 1];
        if (!prev || prev.plate !== f.plate || (new Date(f.at) - new Date(prev.at)) / 60000 > 20) segs.push({ points: [] });
        segs[segs.length - 1].points.push({ lat: f.lat, lng: f.lng, t: f.at, occupied: f.passenger, source: f.source });
      });
      const map = await makeMap(node, { zoom: 11 });
      if (map) renderJourney(map, { segments: segs });
    } catch (e) {
      node.replaceWith(note(`The map could not be drawn: ${e.message}`));
    }
  }

  /* The log, with Uber's status changes in their place. */
  const seg = mv.segments || [];
  const items = [
    ...seg.map((x) => ({ at: x.s, x })),
    /* The day's opening state is not a change at 00:00: an offline carried
       in is not listed, an online one is said as already online. */
    ...status.map((x, i) => ((i === 0 || status[i - 1].status !== x.status) && !(x.carried_in && x.status === 'offline')
      ? { at: x.s, st: x } : null)).filter(Boolean),
  ].sort((a, b) => a.at - b.at || (a.st ? -1 : 1));
  const log = el('div', 'dday-mlog');
  for (const it of items) {
    const r = el('div', 'dday-mrow');
    if (it.st) {
      const x = it.st;
      r.classList.add('st');
      r.style.setProperty('--mk', x.status === 'offline' ? 'var(--rule-strong)' : chColor('uber', x.status === 'ontrip' ? 'engaged' : 'available'));
      r.innerHTML = `<span class="dday-mt">${esc(hhmm(x.s))}</span><span>${esc(x.carried_in ? `already ${x.status === 'ontrip' ? 'on a trip' : 'online'} when the day began`
        : x.status === 'offline' ? 'went offline' : x.status === 'ontrip' ? 'on a trip' : 'online')} <span class="dim">· Uber’s live feed${
        x.went_online?.where ? ` · at <b>${esc(x.went_online.where)}</b>` : ''}</span></span>`;
    } else if (it.x.kind === 'stop') {
      const x = it.x;
      r.style.setProperty('--mk', chColor(x.source, 'idle'));
      r.innerHTML = `<span class="dday-mt">${esc(x.from)}–${esc(x.to)}</span><span>stopped <b>${esc(dur(x.minutes))}</b> at ${
        x.area ? `<b>${esc(x.area)}</b>` : '<span class="dim">a spot no trip has ever named</span>'}${
        x.passenger === 'with a passenger' ? ' <span class="dim">· a passenger aboard</span>' : ''}${
        x.longest_silence_min > 20 ? ` <span class="dim">· the tracker was quiet up to ${esc(dur(x.longest_silence_min))} of it</span>` : ''}</span>`;
    } else if (it.x.kind === 'drive') {
      const x = it.x;
      const seatState = x.passenger === 'with a passenger' ? 'engaged' : 'available';
      r.style.setProperty('--mk', chColor(x.source, seatState));
      const seatTxt = x.passenger === 'part of it with a passenger'
        ? `with a passenger for ${dur(x.passenger_min)} of ${dur(x.minutes)}` : x.passenger;
      r.innerHTML = `<span class="dday-mt">${esc(x.from)}–${esc(x.to)}</span><span>drove <b>${esc(fmt(x.km, 1))} km</b> ${
        x.from_area ? `from <b>${esc(x.from_area)}</b> ` : ''}${x.to_area ? `to <b>${esc(x.to_area)}</b>` : ''}${
        x.via.length ? ` <span class="dim">via ${esc(x.via.join(', '))}</span>` : ''} <span class="dday-seat${x.passenger === 'seat not reported' ? ' dim' : ''}"${
          x.passenger_min ? ` style="border-left:3px solid ${chColor(x.source, 'engaged')}"` : ''}>${esc(seatTxt)}</span></span>`;
    } else {
      const x = it.x;
      r.classList.add('gap');
      r.innerHTML = `<span class="dday-mt">${esc(hhmm(x.s))}–${esc(hhmm(x.e))}</span><span class="dim">no position for ${esc(dur(x.minutes))}${
        x.moved_km >= 0.3 ? ` — when it spoke again the car was ${esc(fmt(x.moved_km, 1))} km away${x.to_area ? `, at ${esc(x.to_area)}` : ''}` : ''}${
        x.edge === 'start' ? ' — from when it became his to its first position'
          : x.edge === 'end' ? (d.today && x.e >= (d.now_min ?? 1441) ? ' — to now' : ' — to the end of his hours in it') : ''}</span>`;
    }
    log.append(r);
  }
  if (items.length) p.body.append(log);
  if (seg.length) p.body.append(el('p', 'cap', 'Movements under 200 m are left out of the log; they are counted in the distance.'));
}
