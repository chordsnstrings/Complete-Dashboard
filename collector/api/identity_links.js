/* The links the roster proved, read at the boundary.
   ═══════════════════════════════════════════════════════════════════════════
   src/identity_link.js discovers them — two records, two channels, one phone
   number — and writes them with the evidence that decided each one.
   sql/schema_v65.sql says why they live in a table rather than in the register.
   This is the read side.

   ── why here and not in person_key ──────────────────────────────────────
   person_key is a stored generated column built from api/identity_map.js, so
   moving it means a migration that recomputes 364,015 rows and changes who the
   product says drove what. A link discovered by a collector run cannot wait for
   that, and should not force it: the pages that answer "who is this person"
   already consult an alias layer for the register's own merges, and a link
   applied there takes effect on the next request.

   What that means, stated rather than left to be discovered: a discovered link
   folds the DIRECTORY and the driver pages. It does not move the stored key, so
   a rollup that groups by person_key still counts the two records apart until
   somebody promotes the link into the register. api/public/identity.js prints
   that distinction; it is not a detail a finance figure can be allowed to
   depend on silently.

   ── precedence ─────────────────────────────────────────────────────────
   A human's decision beats the rule, in both directions. ALIAS_KEY — the
   register, checked pair by pair — is consulted before this map by every
   caller. `rejected` rows are dropped here and never returned, so an operator
   who says "those are two brothers" is not overruled by the next collector
   run. And REFUSED pairs never reach the table at all: the discovery side
   excludes them before writing. */
import { pool } from '../src/db.js';

/* Thirty seconds. The table changes once per collector run at most, and the
   directory reads it once per request — re-querying for a map of sixty rows
   that cannot have changed is work nobody asked for. Short enough that an
   operator who rejects a link sees the page change while they are still
   looking at it. */
const TTL_MS = 30_000;
let cache = null, at = 0;

export function clearIdentityLinkCache() { cache = null; at = 0; }

export async function identityLinks(q = null, { now = Date.now() } = {}) {
  if (cache && now - at < TTL_MS) return cache;
  const run = q || ((t) => pool.query(t).then((r) => r.rows));
  let rows = [];
  try {
    rows = await run(
      `SELECT alias_ext_id, alias_platform, alias_name,
              canonical_ext_id, canonical_platform, canonical_name, canonical_key,
              basis, evidence, phone_tail, first_seen_at, last_seen_at,
              confirmed_at, confirmed_by
         FROM driver_identity_link
        WHERE NOT rejected
        ORDER BY canonical_name NULLS LAST, alias_name NULLS LAST`);
  } catch {
    /* A database that has not run the migration yet answers with an error, and
       the honest response to that is an empty map rather than a failed page:
       every caller's fallback is the behaviour that shipped before this
       existed. */
    rows = [];
  }
  /* Three indexes over the same rows, because the three questions a caller
     asks are different ones and deriving each from the others at the call site
     is how two of them drift apart. `partners` is symmetric — a link is about
     two records and either may be the one in the URL. */
  const partners = new Map();
  const add = (a, b) => {
    if (!partners.has(a)) partners.set(a, new Set([a]));
    partners.get(a).add(b);
  };
  for (const r of rows) {
    add(r.alias_ext_id, r.canonical_ext_id);
    add(r.canonical_ext_id, r.alias_ext_id);
  }
  cache = {
    rows,
    byAlias: new Map(rows.map((r) => [r.alias_ext_id, r.canonical_key])),
    /* The name the PAGE should show for an id: the surviving record's, which
       is the fuller one — the name an operator ringing this person wants, and
       the one their documents match. */
    nameOf: new Map(rows.map((r) => [r.alias_ext_id, r.canonical_name])),
    partners,
  };
  at = now;
  return cache;
}

/* The one thing the fold needs. Returns null for an id nobody linked, which is
   every id until a roster proves otherwise. */
export const linkedKey = (links, id) => (links?.byAlias?.get(id) ?? null);

/* The name the surviving record carries, for an id that is somebody's alias.
   Null for a canonical id and for an id nobody linked — in both cases the
   caller already has the right name. */
export const linkedName = (links, id) => (links?.nameOf?.get(id) ?? null);

/* Every id belonging to the same person as this one, INCLUDING the one asked
   for, so a caller can flatMap over it the way it already does through the
   register's mergedIds. An unlinked id returns itself and nothing else. */
export const linkedIds = (links, id) =>
  [...(links?.partners?.get(id) ?? [id])];
