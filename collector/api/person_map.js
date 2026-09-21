/* WHO A DRIVER IS, ASKED ONCE.
   ═════════════════════════════════════════════════════════════════════════
   Every surface in this product used to answer "who is this account's person"
   for itself, out of its own combination of the register, the link table and a
   name fold. Measured on production 2026-09-21, that gave four different
   answers to "how many drivers" over the same 800 accounts — 347, 437, 508 and
   0 — and the operator was right that none of them is a count of human beings.

   src/persons.js materialises the answer into driver + driver_platform_id, the
   table the money ledger already keys on. This file is the read side of it:
   one query, cached briefly, that every surface consults instead of folding
   for itself.

   ── WHY A MATERIALISED TABLE AND NOT A RUNTIME FOLD ─────────────────────
   Three reasons, and the third is the one that matters.

   1. A runtime fold cannot be audited. There is no row to look at, no
      provenance per account, and no way to ask "why is this man on this
      person" six months later.
   2. It cannot be corrected. A wrong fold is a bug in a function; a wrong row
      is a row somebody can detach, with a reason recorded.
   3. IT CANNOT HOLD MONEY. driver_ledger keys on person_id. A person who
      exists only as the transient output of a fold cannot be the thing a debt
      is owed by — and the moment the fold changes, the debt silently belongs
      to somebody else.

   ── THE CACHE, AND WHY IT IS SHORT ──────────────────────────────────────
   The same thirty seconds api/identity_links.js holds, for the same reason: a
   page built from two requests must not see the roster change between them,
   and a confirmation made on #same-person should be visible within a minute
   rather than after a deploy. A failed read is NEVER cached — see the flag. */

let cache = null;
let at = 0;
const TTL_MS = 30_000;

export function clearPersonMapCache() { cache = null; at = 0; }

/** { ok, byAccount: Map(ext_id -> person_id), person: Map(id -> {…}), counts }
 *
 *  `ok` is false only when the query threw. A caller that must not guess —
 *  anything that writes money — refuses on it rather than treating an empty
 *  map as "nobody is anybody", which is how api/ledger_person.js once let a
 *  duplicate person through. */
export async function personMap(q, { now = Date.now() } = {}) {
  if (cache && now - at < TTL_MS) return cache;

  let rows = [];
  let ok = true;
  try {
    rows = await q(
      `SELECT d.id, d.full_name, d.cash_rule,
              a.platform, a.external_id, a.basis, a.display_name
         FROM driver d
         LEFT JOIN driver_platform_id a
           ON a.driver_id = d.id AND a.detached_at IS NULL
        ORDER BY d.id, a.platform, a.external_id`);
  } catch { ok = false; rows = []; }

  const byAccount = new Map();
  const person = new Map();
  for (const r of rows) {
    const id = Number(r.id);
    if (!person.has(id)) {
      person.set(id, { person_id: id, name: r.full_name, cash_rule: r.cash_rule,
        accounts: [], platforms: [] });
    }
    const p = person.get(id);
    if (r.external_id) {
      byAccount.set(r.external_id, id);
      p.accounts.push({ platform: r.platform, ext_id: r.external_id,
        basis: r.basis, display_name: r.display_name });
      if (r.platform && !p.platforms.includes(r.platform)) p.platforms.push(r.platform);
    }
  }
  /* One account per person, deterministically, for a page that has to open
     somebody by a provider id — the same rule /api/ledger/exposure uses:
     lowest platform then lowest id, so the same person opens the same page
     every time. A person with no account at all keeps null, and entity()
     degrades to plain text rather than to a broken link. */
  for (const p of person.values()) {
    const first = p.accounts.slice().sort(
      (a, b) => String(a.platform).localeCompare(String(b.platform))
        || String(a.ext_id).localeCompare(String(b.ext_id)))[0];
    p.ext_id = first?.ext_id || null;
    p.platform = first?.platform || null;
  }

  const built = {
    ok,
    byAccount,
    person,
    counts: { people: person.size, accounts: byAccount.size },
  };
  /* A FAILURE IS NEVER CACHED. Thirty seconds of "nobody is anybody" across
     every money surface after one statement timeout is the failure mode
     api/identity_links.js records having shipped. */
  if (ok) { cache = built; at = now; }
  return built;
}

/** The person id an account belongs to, or null when the spine has not placed
 *  it yet — which is every account until src/persons.js has run once. */
export const personOfAccount = (map, extId) => (map?.byAccount?.get(extId) ?? null);
