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
   note says why. */

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

export async function fleetRoster(q, { now = Date.now() } = {}) {
  if (cached && now - cachedAt < TTL_MS) return cached;
  let rows = [];
  try { rows = await q(ROSTER_SQL); } catch { rows = []; }
  const fleets = [];
  const departed = new Set(), pending = new Set(), listed = new Set();
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
    fleets.push({ fleet: r.fleet_id, polls: st.polls || 0,
      updated_at: st.updated_at || st.seeded_at || r.updated_at || null,
      departed: d.length, pending: p.length, listed: l.length });
  }
  const known = fleets.length > 0;
  /* A plate can be departed for one fleet and listed for another only if two
     fleets share a plate, which they must not; if it happens, LISTED WINS.
     Excluding a vehicle some credential still reports is the damaging
     direction — the figure it corrupts is the one an operator acts on — and
     the safe failure here is to count one plate too many, not one too few. */
  for (const p of listed) { departed.delete(p); pending.delete(p); }
  cached = {
    known,
    departed, pending, listed,
    excluded: new Set([...departed, ...pending]),
    fleets,
    note: !known
      ? 'The tracker roster has not been written yet, so no plate has been set aside — this '
        + 'count includes every plate the tracker feed has ever reported, including any it has '
        + 'stopped listing.'
      : departed.size || pending.size
        ? `${departed.size + pending.size} plate${departed.size + pending.size === 1 ? '' : 's'} `
          + 'set aside: the tracker has stopped listing them, or has listed them too few times '
          + 'to be believed. They are still in the register — this figure is about the vehicles '
          + 'the tracker currently reports.'
        : 'Every plate the tracker feed holds is one the tracker still lists.',
  };
  cachedAt = now;
  return cached;
}

/* The exclusion as a value a query can take. `null` means exclude nothing,
   which is what an unknown roster and an empty exclusion both mean to SQL —
   and the distinction between those two lives in `note`, where a reader can
   see it, rather than in a silent difference between two identical queries. */
export const excludedPlates = (roster) => (roster?.excluded?.size
  ? [...roster.excluded] : null);

/* What a page prints beside a count that has had plates taken out of it.
   Returns null when nothing was excluded, so a caller can spread it into a
   payload and have the field simply not appear. */
export function exclusionNote(roster) {
  if (!roster) return null;
  return {
    n: roster.excluded.size,
    known: roster.known,
    reason: roster.note,
    /* The plates themselves, because "132 were excluded" is a claim somebody
       has to be able to check. Capped: a list this long is evidence, not a
       payload, and the count above is the figure. */
    plates: [...roster.excluded].sort().slice(0, 200),
    truncated: roster.excluded.size > 200,
  };
}
