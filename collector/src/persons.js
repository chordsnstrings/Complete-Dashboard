/* THE PERSON SPINE — one row per human, materialised, and the only place any
   surface should ask "who is this".
   ═════════════════════════════════════════════════════════════════════════
   THE DEFECT, measured on production 2026-09-21. "How many drivers" had four
   different answers, because five different things decided who a person is and
   no two surfaces consulted the same combination:

       /api/drivers/directory      347   register + links + a NAME match
       /api/compliance/drivers     437   accounts, not people
       /api/ledger/people          508   accounts, not people
       /api/ledger/exposure          0   only persons the money ledger minted

   Over the same 800 accounts. None of those is the number of human beings, and
   the operator was right to say so.

   ── WHY THIS MATTERS MORE THAN A WRONG HEADLINE ─────────────────────────
   The money ledger keys on person_id, correctly. The picker offered ACCOUNTS.
   So a supervisor records a charging advance against 'Tariq Afzal Afzal' today
   and 'Tariq Afzal Said Afzal' tomorrow — one man, two balances, each looking
   perfectly reasonable, and nothing on screen showing the error. The same
   defect in the other direction pools two men's debts into one balance.

   ── WHAT THIS TABLE IS BUILT FROM, AND WHAT IT REFUSES ──────────────────
   REVIEWED DECISIONS ONLY: the hand-reviewed register in api/identity_map.js,
   and links in driver_identity_link that are either conclusive (a shared phone
   or email — those are IDENTIFIERS) or confirmed by a person. That is exactly
   the set api/ledger_person.js already resolves against, and it is deliberately
   NOT what the directory used to fold on.

   The directory additionally folded on `byName` — an account whose folded name
   equals some linked alias's name inherited that person, with nobody having
   reviewed it. Measured: that rule alone made 92 of the 347 rows. Of the 90
   directory rows doing it, 44 were supported by a matching phone, 37 had no
   evidence either way, and NINE WERE CONTRADICTED — different phone numbers on
   records folded into one row. The worst carried seven accounts and three
   phone numbers, filed variously as 'ZAHID KHAN ISMAIL ISMAIL' and 'Zahid Khan
   Mohabbat Khan'. Different fathers' names, one row, one balance.

   CLAUDE.md forbids exactly this: who is one person is "a hand-reviewed LIST
   of verified pairs — never a name rule". So this table is built without it,
   the count goes UP to what the evidence supports, and every pair the name
   rule used to make becomes a PROPOSAL a human answers on #same-person.

   ── IDEMPOTENT, AND IT NEVER DETACHES ───────────────────────────────────
   Runs on every collector pass. It attaches accounts and mints people; it
   never moves an account off a person and never deletes one, because a
   driver_ledger row already keys on person_id and re-pointing money is an
   operation somebody has to authorise, not a side effect of a sweep. Undoing a
   wrong merge is driver_platform_id.detached_at plus a recorded move of the
   money — see api/person_merge_routes.js. */
import { pool } from './db.js';
import { log } from './log.js';
import { mergedIds, canonicalName } from '../api/identity_map.js';
import { identityLinks, linkedIds, clearIdentityLinkCache } from '../api/identity_links.js';

/* Every account this fleet knows of, from the three tables that file one.
   trip is included because 302 accounts appear ONLY there — a driver who took
   bookings and was never filed on a roster still has to be somebody. */
/* A PHONE NUMBER HELD BY EXACTLY TWO ACCOUNTS.
   ─────────────────────────────────────────────────────────────────────────
   The link sweep already treats a shared phone as CONCLUSIVE — it is an
   IDENTIFIER, not a resemblance, and api/identity_map.js took 82 of its 130
   entries on that basis. But it only links accounts it can see in
   driver_compliance, so measured on production 2026-09-21 nineteen numbers
   were still held by two DIFFERENT persons on the spine: the same evidence,
   the same conclusion, not applied.

   Applied here too, on the operator's instruction, with the threshold the
   existing rule already uses. A number on THREE OR MORE records identifies a
   shared handset or an office line rather than a person — src/identity_link.js
   refuses those at `group.length > 2` and this refuses them at the same place,
   so the two rules cannot disagree about what a phone proves. */
const PHONE_PAIRS_SQL = `
  WITH nums AS (
    SELECT driver_ext_id AS ext_id,
           right(regexp_replace(phone, '[^0-9]', '', 'g'), 9) AS tail
      FROM driver_compliance
     WHERE coalesce(btrim(phone), '') <> ''
       AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7
     GROUP BY 1, 2
  )
  SELECT tail, array_agg(ext_id ORDER BY ext_id) AS ids
    FROM nums GROUP BY tail HAVING count(*) = 2`;

const ACCOUNTS_SQL = `
  SELECT platform, driver_ext_id AS ext_id, max(name) AS name, max(seen) AS seen
    FROM (
      SELECT platform, driver_ext_id, full_name AS name, observed_at AS seen
        FROM driver_platform_state WHERE driver_ext_id IS NOT NULL
      UNION ALL
      SELECT platform, driver_ext_id, full_name, updated_at
        FROM driver_compliance WHERE driver_ext_id IS NOT NULL
      UNION ALL
      SELECT platform, driver_ext_id, driver_name, max(requested_at)
        FROM trip
       WHERE driver_ext_id IS NOT NULL AND coalesce(btrim(driver_ext_id), '') <> ''
       GROUP BY platform, driver_ext_id, driver_name
    ) x
   GROUP BY platform, driver_ext_id`;

/* FOLDING ONE COMPONENT, NOW.
   ═════════════════════════════════════════════════════════════════════════
   THE DEFECT THE OPERATOR FOUND, 2026-09-21. They answered 93 pairs on
   #same-person, went back to the drivers page, and still saw one man as two
   rows. Nothing was broken: the confirmations were all in, the link layer put
   all four of his accounts in one component, and the spine rebuilds on the
   collector's THIRTY-MINUTE cycle. Measured at that moment: 407 people on the
   spine, 349 once it next ran — fifty-eight folds already earned and invisible.

   So the merge worked and the page said it had not. That is worse than a
   broken merge, because the operator's next move is to do it again.

   This is the same fold refreshPersons does, scoped to one account's component
   and called from the decide route, so the answer is on screen before the
   reviewer looks away. The half-hour pass still runs and still catches
   everything: this makes the common case immediate, it does not replace it. */
export async function foldComponent(db, extId, { dryRun = false } = {}) {
  const q = (t, p = []) => (db.query ? db.query(t, p).then((r) => r.rows) : db(t, p));
  const links = await identityLinks(q);
  if (!links || links.ok === false) {
    return { refused: true,
      why: 'the identity link table could not be read, so the fold this confirmation implies '
        + 'was not applied. The collector\'s next pass will apply it.' };
  }

  /* The component, over the same two layers refreshPersons uses. */
  const comp = new Set([extId]);
  const stack = [extId];
  while (stack.length) {
    const cur = stack.pop();
    for (const p of linkedIds(links, cur) || []) if (p && !comp.has(p)) { comp.add(p); stack.push(p); }
    for (const p of mergedIds(cur) || []) if (p && !comp.has(p)) { comp.add(p); stack.push(p); }
  }

  const mapped = await q(
    `SELECT driver_id, external_id FROM driver_platform_id
      WHERE external_id = ANY($1::text[]) AND detached_at IS NULL
      ORDER BY driver_id`, [[...comp]]);
  const persons = [...new Set(mapped.map((m) => Number(m.driver_id)))].sort((a, b) => a - b);
  if (persons.length < 2) {
    return { folded: 0, persons: persons.length,
      why: persons.length === 1
        ? 'every account in this component was already on one person'
        : 'the spine has not placed these accounts yet; the collector\'s next pass will' };
  }

  /* MONEY IS THE TEST, exactly as in refreshPersons: an empty person is safe
     to fold, one carrying an entry is not, and that one waits for an
     authorised merge that moves the rows and records it. */
  const [{ n: withMoney }] = await q(
    `SELECT count(*)::int AS n FROM (
       SELECT person_id FROM driver_ledger WHERE person_id = ANY($1::bigint[])
       UNION
       SELECT person_id FROM driver_ledger_audit WHERE person_id = ANY($1::bigint[])
     ) x`, [persons]);
  if (withMoney > 0) {
    return { folded: 0, persons: persons.length, needs_merge: true,
      why: `these records are now one person, but ${withMoney} of them already carries money. `
        + 'Folding them moves a balance, which is an operation somebody authorises and which '
        + 'is recorded — see /api/person/merge. Nothing was changed here.' };
  }
  if (dryRun) return { folded: persons.length - 1, persons: persons.length, dry_run: true };

  const survivor = persons[0];
  const gone = persons.slice(1);
  await q(
    `UPDATE driver_platform_id SET driver_id = $1
      WHERE driver_id = ANY($2::bigint[]) AND detached_at IS NULL`, [survivor, gone]);
  await q(`DELETE FROM driver WHERE id = ANY($1::bigint[])`, [gone]);
  return { folded: gone.length, persons: persons.length, survivor,
    accounts: mapped.length };
}

/** Rebuild the person spine from reviewed decisions. Idempotent.
 *  Returns a tally; writes nothing when `dryRun`. */
export async function refreshPersons(db = pool, { dryRun = false } = {}) {
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);

  clearIdentityLinkCache();
  const links = await identityLinks(q);
  if (!links || links.ok === false) {
    /* THE SAME REFUSAL api/ledger_person.js MAKES, and for the same reason: a
       degraded identity read looks exactly like "nobody is linked to anybody",
       and building the spine from that would mint a separate person for every
       account of every human on the roster. Refused, loudly, rather than
       applied to a map that was never read. */
    return { refused: true,
      why: 'the identity link table could not be read. Building the person spine from a '
        + 'degraded map would mint a separate person for every account of every human on '
        + 'this roster, so nothing was written.' };
  }

  const accounts = await q(ACCOUNTS_SQL);
  const byId = new Map(accounts.map((a) => [a.ext_id, a]));

  /* ── components, over reviewed decisions only ─────────────────────────── */
  const adj = new Map();
  const edge = (a, b) => {
    if (!a || !b || a === b || !byId.has(a) || !byId.has(b)) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const a of accounts) {
    for (const s of mergedIds(a.ext_id) || []) edge(a.ext_id, s);
    for (const s of linkedIds(links, a.ext_id) || []) edge(a.ext_id, s);
  }
  /* …and the identifier both rules agree on. */
  const phonePairs = await q(PHONE_PAIRS_SQL);
  for (const p2 of phonePairs) edge(p2.ids[0], p2.ids[1]);

  const seen = new Set();
  const components = [];
  for (const a of accounts) {
    if (seen.has(a.ext_id)) continue;
    const comp = []; const stack = [a.ext_id];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x); comp.push(x);
      for (const y of adj.get(x) || []) if (!seen.has(y)) stack.push(y);
    }
    components.push(comp);
  }

  const tally = { accounts: accounts.length, components: components.length,
    phone_pairs_seen: phonePairs.length,
    minted: 0, attached: 0, already: 0, folded: 0, needs_merge: 0,
    phone_pairs: 0, failed: 0, dry_run: dryRun };
  if (dryRun) return tally;

  /* ── apply, one component at a time ─────────────────────────────────────
     EACH ONE IN ITS OWN TRY. A component that cannot be applied — a person
     still referenced by a table this sweep does not know about, a constraint
     added later — used to throw out of the loop and abort the whole rebuild,
     leaving every component after it unprocessed and the count stale until
     somebody noticed. run.js catches it, logs it and carries on, so the
     failure was invisible and the symptom was "the spine stopped updating".
     One component is now one component's problem. */
  for (const comp of components) {
    try {
    /* Already mapped? Use that person. A component whose accounts sit on two
       DIFFERENT persons is the shape a merge would fix, and this sweep does
       not do merges — it takes the lowest id, attaches the unmapped accounts
       to it, and says so, leaving the two persons for a human to merge with
       the money moved deliberately. */
    const mapped = await q(
      `SELECT driver_id, external_id FROM driver_platform_id
        WHERE external_id = ANY($1::text[]) AND detached_at IS NULL
        ORDER BY driver_id`, [comp]);
    const persons = [...new Set(mapped.map((m) => Number(m.driver_id)))].sort((a, b) => a - b);

    /* ── ONE COMPONENT ON TWO PERSONS ─────────────────────────────────
       This is the normal case, not an error: the spine mints a person per
       component, and a link confirmed on #same-person AFTERWARDS joins two
       components that already have one each. If that were always left for a
       manual merge, answering the review queue would achieve nothing — every
       yes would create a merge chore instead of folding the person.

       MONEY IS THE WHOLE REASON TO BE CAREFUL, so money is the test. Where
       NEITHER person carries a ledger entry there is nothing to move and
       nothing to get wrong: the link was confirmed by a human, which is the
       review, and the spine folds them. Where EITHER carries one, it stops
       and leaves it — re-pointing a balance is an operation somebody
       authorises and records, which is api/person_merge_routes.js, not a side
       effect of a sweep that runs every half hour. */
    let personId = persons[0] || null;
    if (persons.length > 1) {
      /* EVERY TABLE THAT POINTS AT A PERSON, not only the ledger.
         driver_ledger_audit.person_id is a foreign key too, and a person
         referenced by one cannot be deleted — the DELETE raises and, before
         the per-component guard below, took the whole rebuild with it.
         Proved by removing this check and watching the fold fail with
         "update or delete on table driver violates foreign key constraint". */
      const [{ n: withMoney }] = await q(
        `SELECT count(*)::int AS n FROM (
           SELECT person_id FROM driver_ledger WHERE person_id = ANY($1::bigint[])
           UNION
           SELECT person_id FROM driver_ledger_audit WHERE person_id = ANY($1::bigint[])
         ) x`, [persons]);
      if (withMoney === 0) {
        const survivor = persons[0];
        const gone = persons.slice(1);
        await q(
          `UPDATE driver_platform_id SET driver_id = $1
            WHERE driver_id = ANY($2::bigint[]) AND detached_at IS NULL`, [survivor, gone]);
        /* Safe to remove: it now holds no account and has never held an
           entry, both just checked. A person row nothing references is a
           duplicate of the survivor, and leaving it would put the count this
           whole file exists to get right back out by one. */
        await q(`DELETE FROM driver WHERE id = ANY($1::bigint[])`, [gone]);
        tally.folded += gone.length;
        personId = survivor;
      } else {
        tally.needs_merge += 1;
        log.warn('persons', 'one component, two persons, and money on one of them', {
          accounts: comp.length, persons, note: 'left for an authorised merge' });
      }
    }
    /* The name a human chose where the register names them, else the longest
       filed name — the one an operator ringing this person wants, and the one
       their documents match. */
    const named = comp.map((id) => canonicalName(id)).find(Boolean)
      || comp.map((id) => byId.get(id)?.name).filter(Boolean)
        .sort((a, b) => String(b).length - String(a).length)[0]
      || null;

    if (!personId) {
      const [made] = await q(
        `INSERT INTO driver (full_name, created_by, created_note)
         VALUES ($1, 'spine', $2) RETURNING id`,
        [named, `built from ${comp.length} account(s) joined by a reviewed decision`]);
      personId = Number(made.id);
      tally.minted += 1;
    }

    for (const id of comp) {
      const acct = byId.get(id);
      if (!acct) continue;
      const already = mapped.find((m) => m.external_id === id);
      if (already) { tally.already += 1; continue; }
      /* mergedIds INCLUDES the id asked about — api/ledger_person.js filters
         it out for exactly this reason — so a bare length check calls every
         account 'register'. */
      const inRegister = (mergedIds(id) || []).some((x) => x && x !== id);
      await q(
        `INSERT INTO driver_platform_id
           (platform, external_id, driver_id, display_name, basis, linked_by)
         VALUES ($1,$2,$3,$4,$5,'spine')
         ON CONFLICT (platform, external_id) DO NOTHING`,
        [acct.platform, id, personId, acct.name || null,
          comp.length === 1 ? 'account' : (inRegister ? 'register' : 'link')]);
      tally.attached += 1;
    }
    } catch (e) {
      tally.failed += 1;
      log.warn('persons', 'component could not be applied', {
        accounts: comp.length, err: String(e).slice(0, 160),
        note: 'the rest of the rebuild continued' });
    }
  }

  log.info('persons', 'spine rebuilt', tally);
  return tally;
}
