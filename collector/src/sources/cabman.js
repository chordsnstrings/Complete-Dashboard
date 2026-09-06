// CABMAN DT collector — REALTIME ONLY (no history param). Poll GetIVDData and append
// snapshots; running it on a schedule is how we build CABMAN history ourselves.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun, pool, getState, setState } from '../db.js';
import { log } from '../log.js';
import { noteCredential, saysAuth } from '../auth_state.js';

const SRC = 'cabman';

/* CABMAN's timestamp field is named `gmt`, and it is GMT.
   It used to be stamped `+04:00`, which moved every fix FOUR HOURS into the
   past. That is not a cosmetic error: the unauthorised-trip reconciler matches
   a movement segment against bookings within a 15-minute tolerance, so a
   240-minute systematic shift meant no CABMAN segment could ever match its own
   booking. Nine drivers were named on the live dashboard for trips they had
   genuinely run on Uber.

   The skew was measurable from the data alone — CABMAN fixes arrived a minimum
   of 240.4 minutes "old" while FMS arrived 3.3 minutes old and Uber 0.9 through
   the same code path. The guard at the end of pullLive watches for it
   returning. */
function parseGmt(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const iso = s.replace(' ', 'T');
  // Accept an explicit offset if the provider ever starts sending one.
  const stamped = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(stamped);
  return isNaN(d) ? null : d.toISOString();
}

// "0" is a string, and every non-empty string is truthy. Coerce properly.
const truthy = (v) => {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '' ) return null;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return Number.isFinite(Number(s)) ? Number(s) !== 0 : Boolean(v);
};


/* WHO IS ACTUALLY IN THE FLEET — the roster, and why the collector has to keep it.
   ──────────────────────────────────────────────────────────────────────────
   The poll writes 48 rows. telemetry_snapshot holds 175 plates for this one
   fleet, and 132 of them did not carry the stamp of the poll that just ran —
   they are plates the provider listed on a handful of historical polls and has
   never listed again. Measured on production 2026-09-05: /api/live returns 175
   CABMAN rows, one per plate, and the polled_at column takes exactly four
   values — 2026-09-05T22:45 for 43 plates, 2026-09-04T05:20 for 45,
   2026-08-31T08:35 for 65 and 2026-08-30T12:45 for 22 — all of them fleet_id
   'ecosine', all on one credential that /api/auth shows as ok. So this is not a
   fleet whose login died; it is one fleet whose roster at the provider changed
   three times and a table that has no way to notice.

   The mechanism is upsertMany's `DO UPDATE SET` over every non-conflict column
   (src/db.js:183-184): polled_at is refreshed only for a plate the poll
   actually returned, so a plate that stops being returned simply freezes with
   its last poll and its last fix and stays in the table for ever. Everything
   that counts vehicles counts it. The vehicle register unions plate lists out
   of telemetry_snapshot, so its headline read 273 rows, 102 earning, 171 idle
   — "63% of the fleet took no booking in this window". CABMAN itself lists 48
   plates on the poll measured 2026-09-06 (rows_written 48, 42 carrying the
   current polled_at), so the register is counting roughly 132 cars the provider
   has stopped mentioning; against the plates any channel can still place, the
   same headline is near 28% idle with no warning tone at all. The exact
   denominator depends on which surfaces a page is willing to count, which is
   why this collector publishes the departure and does not compute the rate. The
   Live page shows Moving 47, of which 25 are frozen at a speed recorded between
   one and six days ago, and the Alerts page divides events by tracked_vehicles
   264, which halves every rate printed on it.

   Staleness cannot fix this and it is worth being explicit about why, because
   it is the obvious thing to reach for: all 132 of those plates are ALREADY
   stale:true on /api/live — measured, 132 of 132 — and every one of them is
   still counted. Stale
   answers "has this tracker gone quiet", which is a question about a vehicle we
   own. The question here is "is this vehicle still ours", and only the poll can
   answer it.

   So the collector keeps the answer. Each poll's plate set is folded into a
   roster held in source_state, and the roster is what decides whether a plate
   is written at all:

   A plate the provider has not listed before is PENDING and is not written
   until it has appeared in ADMIT_POLLS consecutive polls. Two would be enough
   to exclude the plate that appears exactly once and never again, which is the
   whole 132; three costs a genuinely new car a quarter of an hour on a
   five-minute poll before it reaches the dashboard and buys one poll of margin
   against a provider hiccup that lists a phantom twice. That is the trade and
   fifteen minutes is cheap.

   A plate already in the table that the provider stops listing is DEPARTED once
   it has been missing from DEPART_POLLS consecutive polls — 288 of them, a
   full day at the five-minute cadence. The number has to sit between the two
   populations the data shows and there is an enormous gap to aim at: a tracker
   in a basement misses one poll, five minutes, and the nearest phantom cohort
   had last been listed 41 hours — 493 polls — before the current one. Anything
   from two to four hundred separates them, and a day is chosen because it also
   rides out a provider-side outage of several hours without calling a single
   car sold.

   Counted in POLLS, not in elapsed time, and that is the load-bearing part. If
   the collector is down for two days the poll counter does not advance, so
   nobody departs; a clock-based rule would empty the whole fleet and print a
   confident reason for it. The seed below is the one place elapsed time is
   used, because a roster built for the first time cannot count polls it never
   observed — and it compares each plate's last poll against the NEWEST poll in
   the same table rather than against now(), so a collector outage moves both
   ends together and still departs nobody.

   Nothing here deletes a row or hides one. Departed and pending plates are
   named in the roster, with counts and with the basis for each, so that a page
   can say "132 plates CABMAN has stopped listing" rather than quietly showing a
   smaller number than it did yesterday. The API layer is what has to print it;
   this file's job is to make the fact available and to stop the pile growing. */
const ROSTER_KEY = 'roster';
const ADMIT_POLLS = 3;
const DEPART_POLLS = 288;
const SEED_DEPART_H = 24;
/* A fifth of the roster vanishing between two five-minute polls is not fleet
   churn. The provider's own model — restated in the lag guard at the end of
   pullLive — is that it returns every vehicle it knows of on every cycle, so
   the payload should be flat from poll to poll and any real shortfall means
   either a truncated answer or plates leaving the account. 175 held against 48
   returned is 0.27 of the roster and raised nothing at all, which is the defect
   this exists to close; 0.8 fires on that by a wide margin and still lets a
   handful of cars genuinely leave on the same day without crying wolf. The
   floor keeps a three-car test fleet from tripping it on one car. */
const COLLAPSE_RATIO = 0.8;
const COLLAPSE_FLOOR = 10;

const isMember = (e) => !!(e && e.admitted && !e.departed);
const plateList = (plates, pick) => Object.keys(plates).filter((p) => pick(plates[p])).sort();

async function loadRoster(fleet) {
  const stored = await getState(SRC, fleet, ROSTER_KEY);
  if (!stored) return null;
  try {
    const r = JSON.parse(stored);
    return r && typeof r === 'object' && r.plates ? r : null;
  } catch { return null; }
}

/* The first roster, read out of the rows the old behaviour left behind.
   Every plate already held is treated as admitted — it is in the table, pages
   are already counting it, and quarantining the live fleet for fifteen minutes
   to re-earn a place it already has would blank the Live page for no gain. What
   the seed does decide is departure, and it decides it by the only evidence
   stored: how far each plate's last poll is behind the newest poll in the same
   table. On production that reads 43 plates at a gap of zero and 132 at gaps of
   41 hours, 6 days and 7 days. Against the newest poll rather than against
   now(), so that a collector that has been down for a week seeds a roster in
   which nobody has departed. */
async function seedRoster(fleet) {
  const { rows } = await pool.query(
    `SELECT plate, max(polled_at) AS last_poll FROM telemetry_snapshot
      WHERE source=$1 AND fleet_id=$2 AND polled_at IS NOT NULL AND plate IS NOT NULL
      GROUP BY plate`, [SRC, fleet]);
  const stamp = (v) => (v ? new Date(v).toISOString() : null);
  const newest = rows.reduce((m, r) => Math.max(m, Date.parse(r.last_poll) || 0), 0);
  const plates = {};
  for (const r of rows) {
    const gapH = newest ? (newest - (Date.parse(r.last_poll) || 0)) / 3600000 : 0;
    const gone = gapH > SEED_DEPART_H;
    plates[r.plate] = {
      runs: ADMIT_POLLS, miss: gone ? DEPART_POLLS : 0, polls: ADMIT_POLLS,
      admitted: true, departed: gone, last_seen: stamp(r.last_poll),
      basis: gone ? 'stale_at_seed' : 'seeded', seed_gap_h: Math.round(gapH),
    };
  }
  return { polls: 0, seeded_at: new Date().toISOString(), plates, collapse: null };
}

/* One poll folded into the roster. Seen resets the miss streak and lengthens
   the run; missed does the opposite. Admission is one-way — a plate that has
   earned its place keeps it through a missed poll, which is the basement case
   and is exactly what must not be dropped — and departure is reversible, so a
   car that comes back is a member again on the poll it returns. */
function stepRoster(prev, seen, nowIso) {
  const plates = {};
  for (const [p, e] of Object.entries(prev.plates || {})) plates[p] = { ...e };
  for (const p of seen) {
    const e = plates[p] || { runs: 0, miss: 0, polls: 0, admitted: false, departed: false, first_seen: nowIso };
    e.runs = (e.runs || 0) + 1;
    e.miss = 0;
    e.polls = (e.polls || 0) + 1;
    e.last_seen = nowIso;
    delete e.seed_gap_h;
    if (!e.admitted && e.runs >= ADMIT_POLLS) { e.admitted = true; e.admitted_at = nowIso; }
    if (e.departed) { e.departed = false; e.returned_at = nowIso; e.basis = 'returned'; }
    plates[p] = e;
  }
  for (const [p, e] of Object.entries(plates)) {
    if (seen.has(p)) continue;
    e.runs = 0;
    e.miss = (e.miss || 0) + 1;
    if (e.admitted && !e.departed && e.miss >= DEPART_POLLS) {
      e.departed = true; e.departed_at = nowIso; e.basis = 'missed_polls';
    }
  }
  /* The two lists are stored alongside the per-plate detail so that a reader —
     a route, a query, a person with psql — gets the answer without walking the
     map, and so that the departure can be stated in SQL with one predicate
     rather than a join against every plate's history. */
  return {
    polls: (prev.polls || 0) + 1, updated_at: nowIso, plates,
    collapse: prev.collapse ?? null,
    departed: plateList(plates, (e) => e.departed),
    pending: plateList(plates, (e) => !e.admitted),
    listed: plateList(plates, isMember),
    admit_polls: ADMIT_POLLS, depart_polls: DEPART_POLLS,
    /* One sentence that has to be true of every plate it can be printed over.
       A departed plate got there either by missing 288 consecutive polls or by
       being more than a day behind the newest poll when the roster was seeded;
       "absent from the feed for more than a day of polling" is true of both,
       where "missed 288 polls" would be false of the seeded ones and
       "not seen for a day" would be false of a fleet whose collector was down.
       The per-plate `basis` carries which of the two it was. */
    /* States what the COLLECTOR knows, and stops short of what the API does
       with it. This sentence used to end "so they are no longer counted as
       fleet", which is not true yet: /api/kpis still reports tracked_vehicles
       265 and /api/vehicles/directory still returns 273 rows, because the
       routes that build those counts do not read this field — they are in
       files this change does not touch. A collector that announces an effect
       the product has not implemented is the same defect as a page with a
       false reason, one layer down, and the next reader would have believed
       the denominator was already fixed. */
    departed_reason: 'CABMAN has stopped listing these plates — each was absent from the feed '
      + 'for more than a day of polling. They are published as departed here; whether a given '
      + 'page still counts them depends on whether it reads this field yet',
    pending_reason: `listed by CABMAN in fewer than ${ADMIT_POLLS} consecutive polls, so not yet `
      + 'written as fleet — a plate that appears once and never again never gets past this',
  };
}

/* What the API layer needs to print the exclusion, in one call.
   Returns the plates CABMAN still lists, the ones it has stopped listing and
   the ones it has not listed often enough to be believed, per fleet and rolled
   up — plus `known`, which is false when no poll has run since this roster
   existed. That flag matters: a caller must be able to tell "no plate has been
   excluded" from "we cannot yet say whether any has", and printing the second
   as the first is the wrong-reason failure this codebase keeps having. */
export async function cabmanRoster() {
  const out = {
    source: SRC, fleets: [], departed: [], pending: [], listed: [],
    admit_polls: ADMIT_POLLS, depart_polls: DEPART_POLLS, known: false,
  };
  for (const f of config.cabman.fleets) {
    const st = await loadRoster(f.fleet);
    if (!st) { out.fleets.push({ fleet: f.fleet, known: false }); continue; }
    out.known = true;
    const one = {
      fleet: f.fleet, known: true, polls: st.polls || 0, updated_at: st.updated_at || st.seeded_at || null,
      departed: st.departed || plateList(st.plates, (e) => e.departed),
      pending: st.pending || plateList(st.plates, (e) => !e.admitted),
      listed: st.listed || plateList(st.plates, isMember),
      departed_reason: st.departed_reason || null, pending_reason: st.pending_reason || null,
    };
    out.fleets.push(one);
    out.departed.push(...one.departed);
    out.pending.push(...one.pending);
    out.listed.push(...one.listed);
    out.departed_reason = one.departed_reason;
    out.pending_reason = one.pending_reason;
  }
  return out;
}

export async function pullLive() {
  let total = 0;
  for (const f of config.cabman.fleets) {
    if (!f.pass) {
      log.warn(SRC, `no password for ${f.fleet}, skipping`);
      await noteCredential(pool, { provider: SRC, fleet: f.fleet, credential: 'CABMAN_PASSWORD',
        state: 'missing', surface: 'IVDData',
        detail: 'no password configured, so this fleet has no live tracker feed' });
      continue;
    }
    const { data, status } = await http(config.cabman.url, {
      headers: { InterfaceUniqueId: f.interfaceId, InterfaceUserName: f.user, InterfacePassword: f.pass },
    });
    /* A refused feed is not an empty feed.
       ─────────────────────────────────────────────────────────────────────
       http() resolves whatever the status, and this read `data?.IVDDataResult
       || []` — so a 401 produced zero vehicles, the same as a quiet minute,
       and the run said nothing. Downstream that is not quiet at all: the
       insight rules read the absence as vehicles, and production carried 85
       stale_tracker findings, of which 85 were CABMAN, each telling an
       operator to "Check the device" on a device that was answering fine. One
       credential, printed eighty-five times as eighty-five broken cars. */
    if (status && status >= 400) {
      log.error(SRC, `live feed refused for ${f.fleet}`, { status });
      /* Only an authorization answer is an authorization verdict.
         ─────────────────────────────────────────────────────────────────────
         This was `status >= 400` and src/http.js retries 429/500/502/503/504
         four times before returning, so a bad gateway minute painted
         CABMAN_PASSWORD red — and this is the every-five-minute realtime poll,
         the source most exposed to a transient status of anything in the
         collector. There is no CABMAN_PASSWORD entry in src/credcheck.js
         either, so nothing could turn it green again. */
      if (status === 401 || status === 403 || saysAuth(data?.Message || data?.message || '')) {
        await noteCredential(pool, { provider: SRC, fleet: f.fleet, credential: 'CABMAN_PASSWORD',
          state: 'invalid', surface: 'IVDData', detail: `HTTP ${status}` });
      }
      continue;
    }
    /* The feed answered on this password, so say so — the row could only ever
       go red before, and 'invalid' scores as "stopped" on the credential
       panel for ever. */
    await noteCredential(pool, { provider: SRC, fleet: f.fleet, credential: 'CABMAN_PASSWORD',
      state: 'ok', surface: 'IVDData', detail: null });
    const now = new Date().toISOString();
    const rows = (data?.IVDDataResult || []).map((v) => ({
      source: SRC, fleet_id: f.fleet, plate: normPlate(v.VehicleID),
      captured_at: parseGmt(v.gmt),
      lat: v.lat, lng: v.lng, speed: v.speed,
      // These arrive as numbers or as the STRINGS "0"/"1". `!!"0"` is true, which
      // pinned ignition and seat-occupancy permanently on and made the
      // stuck-sensor guard in the reconciler unreachable.
      ignition: truthy(v.state),
      status: v.Status, seat_occupied: truthy(v.SeatSensorValue), odometer: v.odometer,
      polled_at: now, raw: v,
    })).filter((r) => r.captured_at && r.plate);

    /* The roster decides what is written, and the poll before it decides
       whether the payload is believable at all.

       Order matters here. `held` is counted off the roster as it stood BEFORE
       this poll was folded in, because the alarm is asking whether the answer
       that just arrived is smaller than the fleet we already know about — fold
       first and the shortfall has already been absorbed into the miss counters
       and there is nothing left to compare against. */
    const seen = new Set(rows.map((r) => r.plate));
    const prev = (await loadRoster(f.fleet)) || await seedRoster(f.fleet);
    const held = Object.values(prev.plates || {}).filter(isMember).length;
    const next = stepRoster(prev, seen, now);

    /* THE ALARM THE CODE DID NOT HAVE.
       ─────────────────────────────────────────────────────────────────────
       This file's stated model of CABMAN — written into the lag guard below —
       is that the provider returns every vehicle it knows of on every cycle.
       That model broke and nothing said so: 175 plates held, 48 returned, and
       the run recorded status ok with rows_written 48 as though a poll that
       answered for 27% of the fleet were an ordinary poll. Whether the cause is
       a truncated answer or plates genuinely leaving the account, a shortfall
       that size is the one thing an operator has to be told about, because the
       vehicle register, the Live page and every per-vehicle rate on the Alerts
       page are all sitting on this number.

       It fires once on the way in rather than every five minutes for as long as
       the condition lasts. The lag guard at the end of this function logged an
       ERROR 288 times a day for a fault that was not there, and a channel that cries
       every cycle is a channel nobody reads — so a deepening collapse re-raises
       and a steady one is carried at info until it recovers. */
    const collapsed = held >= COLLAPSE_FLOOR && seen.size < held * COLLAPSE_RATIO;
    if (collapsed) {
      const worse = prev.collapse && seen.size < prev.collapse.returned;
      log[!prev.collapse || worse ? 'error' : 'info'](SRC,
        'the poll lists far fewer plates than the roster holds', {
          returned: seen.size, in_payload: (data?.IVDDataResult || []).length, held,
          share: Number((seen.size / held).toFixed(2)), fleet: f.fleet,
          since: prev.collapse?.since || now,
          /* "Nothing is removed on the strength of one poll" is true of the
             departure rule and false as a description of what a reader is
             looking at: a roster that collapses because the answer was
             truncated will, if it stays collapsed, have every missing plate
             called departed on schedule. The alarm exists precisely because
             this cannot be told apart from the outside, so it says that
             rather than offering a reassurance it cannot keep. */
          hint: 'either the answer was truncated or the provider has dropped vehicles from this '
            + 'account, and the collector cannot tell those apart from here. No plate departs on '
            + `one poll — it takes ${DEPART_POLLS} consecutive polls without it — so a truncation `
            + 'that is fixed within that window costs nothing, and one that is not will be read '
            + 'as a departure',
        });
      next.collapse = { since: prev.collapse?.since || now, held, returned: seen.size };
    } else if (prev.collapse) {
      log.info(SRC, 'the poll lists the roster again', {
        returned: seen.size, held, since: prev.collapse.since, fleet: f.fleet });
      next.collapse = null;
    }
    await setState(SRC, f.fleet, ROSTER_KEY, JSON.stringify(next));

    /* Only admitted plates are written. A plate the provider has listed fewer
       than ADMIT_POLLS consecutive times is held back rather than dropped
       silently — it is named in the roster with the count that kept it out, and
       said here, because a vehicle that is missing from a page with no
       explanation is the same defect as one that is counted wrongly. */
    const writable = rows.filter((r) => next.plates[r.plate]?.admitted);
    const pending = rows.length - writable.length;
    if (pending) {
      log.warn(SRC, 'plates listed too briefly to be written as fleet', {
        pending, of: rows.length, fleet: f.fleet,
        plates: rows.filter((r) => !next.plates[r.plate]?.admitted).map((r) => r.plate).slice(0, 20),
        needs_polls: ADMIT_POLLS,
        hint: 'a new tracker reaches the dashboard on its third consecutive poll; a plate that is '
          + 'listed once and never again never does, which is what this is for',
      });
    }
    const gone = (next.departed || []).length - (prev.departed || []).length;
    if (gone > 0) {
      log.info(SRC, 'plates CABMAN has stopped listing', {
        departed_now: gone, departed_total: (next.departed || []).length,
        still_listed: (next.listed || []).length, fleet: f.fleet,
        hint: 'their rows stay in telemetry_snapshot; the roster in source_state is what says '
          + 'they are no longer fleet, and it names every one of them',
      });
    }
    if (writable.length) total += await upsertMany('telemetry_snapshot', writable, ['source', 'plate', 'captured_at']);

    /* A fix that arrives claiming to be hours old is either a clock problem or
       a vehicle that has stopped reporting, and telling them apart is the whole
       job of this check — because it was not doing it.

       The provider returns every vehicle it knows of on every cycle, including
       trackers that went silent long ago: four of this fleet's have not
       produced a fix since April 2024, and sixteen have been quiet over a
       month. Their ancient timestamps sat in the median, dragged it past the
       threshold, and this logged an ERROR every five minutes — pointing at a
       timezone change that had not happened, on a channel meant for things
       somebody must act on. The tell was in the number: the lag hovered around
       forty-five minutes, and no timezone is forty-five minutes from Dubai.

       So the dormant trackers are excluded — anything outside a day — and
       counted separately, because "sixteen vehicles have stopped reporting" is
       worth knowing and is not an error in the collector.

       That much was right and it was still firing. Measured on production:
       median 24 minutes over 34 reporting vehicles, an ERROR every five
       minutes, 288 a day. And the distribution says there is nothing wrong:
       the FRESHEST fix is 1.2 minutes old.

       Which is the whole discriminator, and the median is the wrong statistic
       for it. These trackers report on movement, not on a timer, so a car
       parked twenty minutes ago is twenty minutes stale and perfectly healthy
       — half the fleet is parked at any moment, and that is what the median
       measures. A clock or timezone error does something the median cannot
       distinguish from that: it moves EVERY vehicle at once, including the
       ones that just reported. An hour added to the provider's gmt field puts
       the freshest fix at sixty-one minutes, not at one.

       So the floor is the test. If the newest fix in the whole fleet is
       stale, the feed is behind; if any vehicle reported a minute ago, no
       clock is wrong however many cars are parked. The tenth percentile
       rather than the bare minimum, so one freak-fresh row cannot silence a
       real skew, and the median still travels in the message as context. */
    const DORMANT_MIN = 24 * 60;
    const lags = rows.map((r) => (Date.parse(now) - Date.parse(r.captured_at)) / 60000)
      .filter(Number.isFinite).sort((a, b) => a - b);
    const talking = lags.filter((m) => m < DORMANT_MIN);
    const dormant = lags.length - talking.length;
    const at = (p) => (talking.length ? talking[Math.min(talking.length - 1,
      Math.floor(talking.length * p))] : 0);
    const median = at(0.5);
    const floor = at(0.1);
    if (floor > 20) {
      log.error(SRC, 'telemetry clock skew — even the freshest fix is behind the poll', {
        freshest_decile_min: Math.round(floor), median_lag_min: Math.round(median),
        reporting: talking.length, fleet: f.fleet,
        hint: 'a whole-hour offset means the provider changed the timezone of its gmt field; '
          + 'minutes mean the feed itself is lagging. A high median with a low floor is not '
          + 'skew — it is a fleet with cars parked, which is what a fleet looks like',
      });
    }
    if (dormant) {
      log.info(SRC, 'vehicles listed but not reporting', {
        dormant, of: lags.length, fleet: f.fleet,
        oldest_days: Math.round(lags[lags.length - 1] / 1440),
      });
    }
  }
  return total;
}

// CABMAN has no historical endpoint — "collect" just captures the current snapshot.
export async function collect({ mode = 'realtime' } = {}) {
  try {
    const n = await pullLive();
    await logRun({ source: SRC, fleet_id: null, mode, status: 'ok', rows_written: n });
    log.info(SRC, 'snapshot captured', { rows: n });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
