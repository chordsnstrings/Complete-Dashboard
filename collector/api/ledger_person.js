/* RESOLVING A HUMAN BEING, ONCE, AT WRITE TIME — and recording who decided.
   ─────────────────────────────────────────────────────────────────────────
   sql/schema_v77.sql argues at length why a debt cannot be keyed on a
   provider's idea of who somebody is, and why the fold cannot be recomputed on
   every read. This file is the other half of that argument: the function that
   turns "the account the operator clicked" into a person id, exactly once, and
   stamps the row with the evidence that produced it.

   ── THE PRECEDENCE, AND WHY IT IS THIS ORDER ─────────────────────────────
   1. ALREADY MAPPED. (platform, ext_id) is in driver_platform_id and not
      detached. Nothing else is consulted: a mapping that exists is a decision
      already taken, and re-deriving it every time is the volatility this whole
      design exists to escape.

   2. A SIBLING IS MAPPED. The account is not known, but the merge register
      (api/identity_map.js) or a live driver_identity_link row says it belongs
      to the same human as an account that IS mapped. Attach it to that person
      and record which of the two said so.

   3. NOBODY KNOWS THEM. Mint a person. A new hire, or somebody paid only a
      salary, exists in no provider's records at all — api/driver_routes.js:176
      answers null for them — and sql/schema_v77.sql made driver.id a BIGSERIAL
      owing nothing to a provider precisely so that a salary advance in their
      first week has a row to key on.

   ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────
   No name matching of any kind. api/identity_map.js is a hand-reviewed LIST
   and argues, correctly, that it must never learn to generalise; the five
   pairs it holds back carry simultaneous trips in two cars. A resolver that
   folded on a name would merge two brothers' debts, silently, at the moment
   money was recorded against one of them. Step 2 consults only decisions a
   human has already reviewed.

   ── AND A DEGRADED IDENTITY MAP IS A REFUSAL, NOT A GUESS ────────────────
   api/identity_links.js:74-83 catches its own query failure and returns an
   EMPTY map — honest for a directory, a silent un-merge for money, and cached
   for thirty seconds. If the links cannot be read, this file does not quietly
   fall through to step 3 and mint a second person for somebody who already has
   one: it says so, and the caller refuses the write. A duplicate person is not
   a cosmetic problem — it splits a balance in two and neither half is right. */
import { mergedIds, canonicalName } from './identity_map.js';
import { identityLinks, linkedIds, linkedKey } from './identity_links.js';

/* The account ids that some human-reviewed decision says are the same person
   as this one, the id itself excluded. Both sources are unioned because they
   answer different questions and neither is a superset: the register is the
   hand-checked list, the link table is the phone- and email-discovered queue
   that a person confirmed. */
export function siblingIds(id, links) {
  const out = new Set();
  for (const s of mergedIds(id) || []) if (s && s !== id) out.add(s);
  for (const s of linkedIds(links, id) || []) if (s && s !== id) out.add(s);
  /* linkedIds answers "who else folds onto this key", which does not include
     the canonical id itself when the id asked about is an alias. */
  const canon = linkedKey(links, id);
  if (canon && canon !== id) out.add(canon);
  return [...out];
}

/** Resolve (platform, ext_id) to a person id, creating one if nobody knows them.
 *
 *  Returns { person_id, resolved_from, created, attached } — or
 *  { refused, why } when the identity layer could not be read.
 *
 *  `q` is the query function. Every write here is small and ordered so that a
 *  caller running inside a transaction gets all of it or none.
 */
export async function resolvePerson(q, { platform, extId, name, by = null, links = null }) {
  const plat = String(platform || '').trim().toLowerCase();
  const id = String(extId || '').trim();
  if (!plat || !id) {
    return { refused: true, why: 'a platform and an account id are both required to resolve a person' };
  }

  /* 1. Already mapped. */
  const [mapped] = await q(
    `SELECT driver_id, basis FROM driver_platform_id
      WHERE platform = $1 AND external_id = $2 AND detached_at IS NULL`, [plat, id]);
  if (mapped) {
    return { person_id: Number(mapped.driver_id), resolved_from: mapped.basis || 'account',
      created: false, attached: false };
  }

  /* The identity layer, read once. A caller resolving several accounts passes
     its own map so one degraded read cannot be half-applied across them. */
  let map = links;
  if (!map) {
    try { map = await identityLinks(q); } catch { map = null; }
  }
  /* THE FLAG, not the shape. identityLinks answers an empty but perfectly
     valid map when its own SELECT fails, so a structural check ("does it have
     a byAlias?") passes on a read that never happened — which is how the first
     version of this guard let a duplicate person through, and how the test
     that asserts it caught that. `ok` is false only when the query threw. */
  if (!map || map.ok === false || !map.byAlias) {
    return { refused: true,
      why: 'the identity layer could not be read, and resolving a person without it risks '
        + 'minting a second record for somebody who already has one — which splits a balance '
        + 'in two, with neither half right. Nothing was written.' };
  }

  /* 2. A sibling is already mapped. */
  const sibs = siblingIds(id, map);
  if (sibs.length) {
    const [sib] = await q(
      `SELECT driver_id, platform, external_id FROM driver_platform_id
        WHERE external_id = ANY($1::text[]) AND detached_at IS NULL
        ORDER BY driver_id LIMIT 1`, [sibs]);
    if (sib) {
      /* WHICH source said so, named rather than implied, because the two carry
         different weight: the register is hand-reviewed and permanent, a link
         is a discovery a person confirmed and can withdraw. */
      const fromRegister = (mergedIds(id) || []).includes(sib.external_id);
      const basis = fromRegister
        ? `register:${canonicalName(id) || id}`
        : `link:${sib.external_id}`;
      await q(
        `INSERT INTO driver_platform_id
           (platform, external_id, driver_id, display_name, basis, linked_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (platform, external_id) DO NOTHING`,
        [plat, id, sib.driver_id, name || null, basis, by]);
      return { person_id: Number(sib.driver_id), resolved_from: basis,
        created: false, attached: true };
    }
  }

  /* 3. Nobody knows them. Mint one.
     canonicalName first: where the register names this person, the person row
     should carry the name a human chose, not whichever spelling the provider
     happened to file on the account being recorded against. */
  const personName = canonicalName(id) || name || null;
  const [made] = await q(
    `INSERT INTO driver (full_name, created_by, created_note)
     VALUES ($1, $2, $3) RETURNING id`,
    [personName, by,
      `minted while recording against ${plat}:${id}${sibs.length
        ? ` — ${sibs.length} sibling account(s) named by the identity layer, none of them mapped yet`
        : ' — no other account is known to be the same person'}`]);
  const personId = Number(made.id);
  await q(
    `INSERT INTO driver_platform_id
       (platform, external_id, driver_id, display_name, basis, linked_by)
     VALUES ($1,$2,$3,$4,'account',$5)
     ON CONFLICT (platform, external_id) DO NOTHING`,
    [plat, id, personId, name || null, by]);
  /* The siblings the identity layer already names are attached in the same
     breath. Doing it later would leave a window in which a second entry against
     the sibling mints a SECOND person for the same human. */
  for (const s of sibs) {
    await q(
      `INSERT INTO driver_platform_id
         (platform, external_id, driver_id, display_name, basis, linked_by)
       SELECT platform, driver_ext_id, $2, driver_name, $3, $4
         FROM (SELECT DISTINCT platform, driver_ext_id, driver_name
                 FROM driver_platform_state WHERE driver_ext_id = $1
               UNION
               SELECT DISTINCT platform, driver_ext_id, full_name
                 FROM driver_compliance WHERE driver_ext_id = $1) x
       ON CONFLICT (platform, external_id) DO NOTHING`,
      [s, personId, `sibling-of:${id}`, by]);
  }
  return { person_id: personId, resolved_from: 'account', created: true,
    attached: sibs.length > 0 };
}
