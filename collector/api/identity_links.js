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
/* The same fold personFold emits in SQL and identity_map computes in JS. One
   spelling of the rule, so a key built here cannot differ from the stored one
   by a space or a repeated word. */
import { foldName as fold } from './identity_map.js';

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
          /* CONCLUSIVE, OR CONFIRMED BY A PERSON. Nothing else folds.
             ───────────────────────────────────────────────────────────────
             A phone and an email are IDENTIFIERS: two records carrying one are
             one person and the rule may apply itself. A similar NAME is not —
             "MUHAMMAD SHAFIQ" sits inside "MUHAMMAD SHAFIQ UMAR RAZIQ" and
             equally inside "MUHAMMAD SHAFIQ AHMED", and merging on that pools
             two people's work and money. CLAUDE.md forbids it in as many
             words: who is one person is "a hand-reviewed LIST of verified
             pairs — never a name rule".

             So src/identity_link.js writes those as PROPOSALS and they sit in
             this table doing nothing until somebody answers them on
             #same-person. This predicate is the whole enforcement of that, and
             it is one line: without it a proposal would fold the moment it was
             discovered, which is the failure the queue exists to prevent. */
          AND (basis IN ('shared_phone', 'shared_email') OR confirmed_at IS NOT NULL)
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
  /* ── A PERSON IS A COMPONENT, NOT A PAIR ──────────────────────────────────
     This was one hop. `partners` added each end of a link to the other's set,
     and `byAlias` mapped an alias id straight to its own link's canonical key
     — so a person reached through TWO links landed on two different keys and
     rendered as two rows, which is the exact defect the whole feature exists
     to remove.

     Measured on production 2026-09-16, over the 177 applied links: TEN ids are
     both an alias and a canonical, and those are chains.

       AAMIR KHAN (yango) -> Aamir Khan Amin (uber) -> AAMIR KHAN ROOHUL AMIN AMIN (hotel)
       HAMZA KHAN (yango) -> Hamza Khan Khan (uber) -> HAMZA KHAN NAEEM KHAN (hotel)
       Sajid Gul Gul Muhammad (bolt) -> Gul Muhammad Sajid Gul (yango) -> ... (hotel)

     One hop sends the yango record to the uber record's key while the uber
     record goes on to the hotel record's key. One human, two keys, two rows.
     Of the 111 pairs a human had already decided 'same', 82 were folded and 24
     were still two rows on the live directory — and the chain middles are why.

     So the links are walked to a TERMINAL: the record in the component that is
     nobody's alias, which by survivorOf() is the fullest name — the one an
     operator ringing this person wants and the one their documents match. A
     component with no terminal (a cycle, which no rule here can currently
     produce but which a future basis might) picks the longest name and then
     the lowest id, so the answer is stable rather than dependent on row order.

     `seen` is not optional. A cycle without it is an infinite loop inside a
     read that every page makes. */
  const nextOf = new Map(rows.map((r) => [r.alias_ext_id, r.canonical_ext_id]));
  const infoOf = new Map();
  for (const r of rows) {
    infoOf.set(r.alias_ext_id, { key: null, name: r.alias_name });
    infoOf.set(r.canonical_ext_id, { key: r.canonical_key, name: r.canonical_name });
  }
  const terminalOf = (id) => {
    const seen = new Set([id]);
    let cur = id;
    while (nextOf.has(cur)) {
      const nxt = nextOf.get(cur);
      if (seen.has(nxt)) {
        /* A CYCLE. Pick deterministically from everything in it rather than
           stopping wherever the walk happened to enter. */
        return [...seen].sort((x, y) => {
          const nx = (infoOf.get(x)?.name || ''), ny = (infoOf.get(y)?.name || '');
          return ny.length - nx.length || (x < y ? -1 : x > y ? 1 : 0);
        })[0];
      }
      seen.add(nxt);
      cur = nxt;
    }
    return cur;
  };
  /* One representative per id, computed once. */
  const repOf = new Map();
  for (const id of new Set([...rows.map((r) => r.alias_ext_id), ...rows.map((r) => r.canonical_ext_id)])) {
    repOf.set(id, terminalOf(id));
  }
  /* …and the component that representative stands for, so linkedIds returns
     every record on the person rather than the two ends of one link. */
  const members = new Map();
  for (const [id, rep] of repOf) {
    if (!members.has(rep)) members.set(rep, new Set());
    members.get(rep).add(id);
    members.get(rep).add(rep);
  }
  const partners = new Map();
  for (const [id, rep] of repOf) partners.set(id, members.get(rep));
  const keyOfRep = (id) => infoOf.get(id)?.key || null;
  const nameOfRep = (id) => infoOf.get(id)?.name || null;

  cache = {
    rows,
    /* EVERY id on the person, not only an alias, maps to the one key — a
       chain middle is an alias of the terminal and a canonical of somebody
       else, and leaving it out of this map is what split it off. */
    byAlias: new Map([...repOf]
      .filter(([id, rep]) => id !== rep && keyOfRep(rep))
      .map(([id, rep]) => [id, keyOfRep(rep)])),
    /* The name the PAGE should show for an id: the surviving record's, which
       is the fuller one — the name an operator ringing this person wants, and
       the one their documents match. */
    nameOf: new Map([...repOf]
      .filter(([id, rep]) => id !== rep && nameOfRep(rep))
      .map(([id, rep]) => [id, nameOfRep(rep)])),
    /* THE THIRD RECORD.
       ─────────────────────────────────────────────────────────────────────
       A link joins two roster records, and a person can have three. Muhammad
       Khalifa has a Bolt record too, and it is not on driver_compliance at all
       — Bolt files no phone — so no link names it. It reaches him because Bolt
       and the hotel channel file the same full name and the name fold already
       joins those two, which works only while the hotel record is the survivor.

       On today's roster it always is: Uber files the shorter name in every one
       of the 61 pairs. But that is a fact about this roster and not about the
       rule, and the day it is not, the Bolt record would keep its own folded
       name and split off from the person it belongs to — a regression that
       would look exactly like the bug this whole change is about.

       So the alias's own folded name maps to the canonical key as well. Any
       record the name fold already grouped with the alias moves with it,
       whichever side turned out to be the survivor. */
    byName: new Map(rows
      .map((r) => [fold(r.alias_name), keyOfRep(repOf.get(r.alias_ext_id))])
      .filter(([k, v]) => k && v && k !== v)),
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

/* For a record no link names, but whose folded NAME is the one an alias
   carries — the third record on a person, reached through the name fold rather
   than through the roster. Null when nothing matches, which is every record
   until a link exists. */
export const linkedByName = (links, key) => (key ? (links?.byName?.get(key) ?? null) : null);
