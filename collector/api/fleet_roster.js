/* Which plates the tracker provider still lists, read from the collector's own
   roster — and the exclusion said out loud rather than applied silently.
   ═══════════════════════════════════════════════════════════════════════════
   CABMAN's poll returns 48 plates. telemetry_snapshot holds 175, because
   `upsertMany` refreshes `polled_at` on every row it writes and nothing ever
   removed the 132 that stopped being returned. Measured on production, those
   132 fall into three cohorts whose newest poll is 41 hours, 6 days and 7 days
   old — plates that entered on three historical polls, produced one fix each,
   and have been counted as live fleet ever since.

   That is not a display bug. It is the fleet-size DENOMINATOR, and it is wrong
   on three surfaces at once: the vehicle register's headline verdict reads
   "63% of the fleet took no booking in this window" where the truth is 28%;
   the Live page shows Moving 47 with 24 of them frozen at speeds recorded days
   ago; and the safety page divides events by 264 tracked vehicles, so its rate
   is about half what it should be.

   ── the roster is the collector's, not this file's ──────────────────────
   src/sources/cabman.js keeps the roster in `source_state`: a plate is admitted
   after three consecutive polls and departs after 288 missed ones, a full day
   at five-minute polling. This module READS that, from SQL, and does not import
   the collector — the API process has no CABMAN credential and no business
   constructing an HTTP client at import time. The contract between them is one
   JSON document in one row, which is also what makes it inspectable with psql
   when a number is being argued about.

   ── and it says what it did ─────────────────────────────────────────────
   Every caller gets `note`, a sentence naming the count and the reason, and is
   expected to print it. Silently dropping 132 plates would fix the arithmetic
   and break the thing this product is for: a reader has to be able to tell
   "132 vehicles are not in this figure because the tracker stopped listing
   them" from "this fleet has 141 vehicles".

   ── three states, never two ─────────────────────────────────────────────
   `known` is false when no roster has been written yet — a database that has
   not run the new collector, or a fresh deploy. A caller must be able to tell
   "no plate has been excluded" from "we cannot yet say whether any has", and
   printing the second as the first is exactly the wrong-reason failure this
   codebase keeps having. When `known` is false NOTHING is excluded and the
   note says why — and `state` says which why (no roster yet, a roster that
   does not parse, or a query that failed), each in its own sentence below.

   ── who reads it (WIRE, 2026-11-12) ─────────────────────────────────────
   This module was written for FIXLIST C18 and imported by nothing for two
   months: the collector kept the roster and every count went on including
   the departed plates. Measured on production 2026-11-12: /api/live 268 rows,
   177 of them CABMAN, 132 of those with a last poll more than a day old;
   /api/kpis tracked_vehicles 268 and silent_vehicles 162. Its readers now:
     /api/live              a set-aside plate's CABMAN fixes are not its
                            newest fix (api/server.js, ROSTER_KEEP)
     /api/kpis              tracked/live/silent counts the same way, plus
                            `tracked_set_aside` and `fleet_roster` (the note)
     /api/vehicles/directory  a row the roster set aside and nothing else
                            knows carries `set_aside` (api/vehicle_routes.js)
     /api/fleet/roster      the note itself, for #live, #map and #vehicles
                            (api/fleet_roster_routes.js) */

const ROSTER_SQL = `SELECT fleet_id, value, updated_at
                      FROM source_state
                     WHERE source = 'cabman' AND key = 'roster'`;

/* A minute of cache. The roster changes once per five-minute poll at most, and
   /api/live is polled by an open dashboard — re-reading and re-parsing a
   175-plate JSON document per request to learn something that cannot have
   changed is work nobody asked for. Deliberately not the response cache: this
   is a small shared fact that several routes fold into different answers, so
   caching it here means they cannot disagree about it within a request. */
const TTL_MS = 60_000;
let cached = null, cachedAt = 0;

export function clearRosterCache() { cached = null; cachedAt = 0; }

/* What "nothing set aside" is, said truthfully for each reason it can be so.
   ─────────────────────────────────────────────────────────────────────────
   The first draft of this module had two states and one of them lied: the
   SELECT below sat in a try/catch whose catch produced an empty roster, and an
   empty roster printed "the tracker roster has not been written yet". So a
   database that refused the query — a timeout, a dropped connection — was
   reported as a collector that had never run, which is the wrong-reason
   failure this file's own header says it exists to avoid. A roster row that
   was written but did not parse was the same silent "not written yet".
   Four states now, each with its own sentence:
     read        the roster was read; plates may or may not be set aside
     none        no roster row exists (a fresh deploy, a collector not yet run)
     unreadable  a row exists and its JSON is not a roster
     failed      the query itself failed — not cached, so the next request asks
                 again rather than repeating a failure for a minute */
const plural = (n, one, many) => (n === 1 ? one : many);
const WHY = {
  none: 'the tracker roster has not been written yet, so nothing has been set aside',
  unreadable: 'the tracker roster is stored but could not be read, so nothing has been set aside',
  failed: 'the tracker roster could not be read just now, so nothing has been set aside',
};
const INCLUDES_ALL = ' — this count includes every plate the tracker feed has ever reported, '
  + 'including any it has stopped listing.';
const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* One roster, from its plate sets. The merged view and a one-fleet view are
   built here alike, so they cannot word the same fact two ways. `listedAll` is
   the listing across EVERY fleet, for the rule below. */
function build({ state, departed, pending, listed, listedAll = listed, fleets }) {
  /* A plate can be departed for one fleet and listed for another only if two
     fleets share a plate, which they must not; if it happens, LISTED WINS.
     Excluding a vehicle some credential still reports is the damaging
     direction — the figure it corrupts is the one an operator acts on — and
     the safe failure here is to count one plate too many, not one too few.
     Against every fleet's listing even in a one-fleet view, so the view a
     one-fleet reader is given sets aside exactly what the SQL does. */
  for (const p of listedAll) { departed.delete(p); pending.delete(p); }
  const known = state === 'read';
  const excluded = new Set([...departed, ...pending]);
  const roster = { known, state, departed, pending, listed, excluded, fleets };
  roster.note = sentence(roster, excluded.size);
  return roster;
}

/* The plain-English sentence for a figure that has had `n` plates taken out of
   it. `n` is the figure's own count where the route measured one — the plates
   it actually dropped — and the roster's whole set-aside count otherwise. The
   two differ honestly: a departed CABMAN plate that FMS still reports stays in
   a tracker count through its FMS fixes, and a pending plate was never written
   to the table at all, so neither was "taken out" of anything. */
function sentence(roster, n) {
  if (!roster.known) return `${cap1(WHY[roster.state] || WHY.none)}${INCLUDES_ALL}`;
  const held = roster.excluded.size;
  if (!held) return 'Every plate the tracker feed holds is one the tracker still lists.';
  if (!n) {
    return `No plate was taken out of this figure: the ${held} the tracker has set aside `
      + 'are either still reported by another feed or were never counted here.';
  }
  return `${n} ${plural(n, 'plate', 'plates')} set aside: the tracker has stopped listing `
    + `${plural(n, 'it', 'them')}, or has listed ${plural(n, 'it', 'them')} too few times to be `
    + `believed. ${plural(n, 'It is', 'They are')} still in the register — this figure is about `
    + 'the vehicles the tracker currently reports.';
}

export async function fleetRoster(q, { now = Date.now() } = {}) {
  if (cached && now - cachedAt < TTL_MS) return cached;
  let rows = [];
  let state = 'read';
  try { rows = await q(ROSTER_SQL); } catch { rows = []; state = 'failed'; }
  const fleets = [];
  const departed = new Set(), pending = new Set(), listed = new Set();
  const byFleet = new Map();
  for (const r of rows) {
    let st = null;
    try { st = JSON.parse(r.value); } catch { st = null; }
    if (!st || typeof st !== 'object' || !st.plates) continue;
    /* The stored lists are preferred over walking `plates` — the collector
       writes both and the lists are what its own tests pin — but a roster
       written before the lists existed still answers, from the map. */
    const of = (k, pred) => (Array.isArray(st[k]) ? st[k]
      : Object.entries(st.plates).filter(([, e]) => pred(e)).map(([p]) => p));
    const d = of('departed', (e) => e.departed);
    const p = of('pending', (e) => !e.admitted);
    const l = of('listed', (e) => e.admitted && !e.departed);
    d.forEach((x) => departed.add(x));
    p.forEach((x) => pending.add(x));
    l.forEach((x) => listed.add(x));
    byFleet.set(r.fleet_id, { departed: d, pending: p, listed: l });
    fleets.push({ fleet: r.fleet_id, polls: st.polls || 0,
      updated_at: st.updated_at || st.seeded_at || r.updated_at || null,
      departed: d.length, pending: p.length, listed: l.length });
  }
  if (state === 'read' && !fleets.length) state = rows.length ? 'unreadable' : 'none';
  const roster = build({ state, departed, pending, listed, fleets });
  roster.byFleet = byFleet;
  /* A failure is not remembered: a minute of "could not be read" after the
     database has recovered would be a stale reason, and the read is cheap. */
  if (state !== 'failed') { cached = roster; cachedAt = now; }
  return roster;
}

/* The roster as one fleet sees it, for a route that takes ?fleet= (the access
   manifest's 'param' rule rewrites a one-fleet reader's request to their own
   fleet, so this is what keeps the other fleet's plates out of their answer).
   No fleet: the whole roster. A fleet with no roster row of its own: not
   known, with the reason the whole roster would give — never "every plate is
   listed", which nobody has measured for that fleet. */
export function rosterFor(roster, fleet) {
  if (!roster || !fleet) return roster;
  const own = roster.byFleet?.get(fleet);
  if (!own) {
    return build({ state: roster.state === 'read' ? 'none' : roster.state,
      departed: new Set(), pending: new Set(), listed: new Set(), fleets: [] });
  }
  return build({ state: 'read', departed: new Set(own.departed), pending: new Set(own.pending),
    listed: new Set(own.listed), listedAll: roster.listed,
    fleets: roster.fleets.filter((f) => f.fleet === fleet) });
}

/* The exclusion as a value a query can take. `null` means exclude nothing,
   which is what an unknown roster and an empty exclusion both mean to SQL —
   and the distinction between those two lives in the note, where a reader can
   see it, rather than in a silent difference between two identical queries.
   The SQL that takes it must be null-safe: `plate = ANY(NULL)` is NULL, not
   false, and `NOT (source = 'cabman' AND NULL)` drops every CABMAN row — see
   ROSTER_KEEP in api/telemetry_sql.js, which is written for exactly that. */
export const excludedPlates = (roster) => (roster?.excluded?.size
  ? [...roster.excluded] : null);

/* What a page prints beside a count that has had plates taken out of it.
   Returns an object whenever it is handed a roster — including one that is
   not known, or that set nothing aside — because "nothing was set aside" and
   "we cannot yet say" are both things a page has to print, and they read
   differently. (An earlier comment here promised null when nothing was
   excluded; the code never did that, and a page that took the comment at its
   word would have dropped the not-known sentence on the floor.) Only a
   missing roster gives null.

   `removed`: how many plates THIS figure actually dropped, where the route
   measured it. Without it the roster's whole set-aside count is used. */
export function exclusionNote(roster, { removed = null } = {}) {
  if (!roster) return null;
  const held = roster.excluded.size;
  const n = removed == null ? held : Number(removed) || 0;
  return {
    /* Plates taken out of the figure this note is printed beside. */
    n,
    /* Plates the roster sets aside in all — departed plus pending. */
    held,
    known: roster.known,
    state: roster.state,
    reason: sentence(roster, n),
    /* The reason without a count, for a page that counts its own rows (the
       vehicle register flags each row it sets aside and counts those). */
    why: !roster.known ? (WHY[roster.state] || WHY.none)
      : held ? 'the tracker has stopped listing them, or has listed them too few times to be believed'
        : 'the tracker still lists every plate it holds',
    /* The plates themselves, because "132 were excluded" is a claim somebody
       has to be able to check. Capped: a list this long is evidence, not a
       payload, and the count above is the figure. */
    plates: [...roster.excluded].sort().slice(0, 200),
    truncated: held > 200,
  };
}
