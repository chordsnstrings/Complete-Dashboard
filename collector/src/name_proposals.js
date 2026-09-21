/* THE PAIRS THE DIRECTORY USED TO FOLD SILENTLY, WRITTEN DOWN SO SOMEBODY CAN
   ANSWER THEM.
   ═════════════════════════════════════════════════════════════════════════
   api/driver_routes.js folded on `byName`: an account in NO link inherited a
   person because its folded name matched some linked alias's. Measured on
   production 2026-09-21, that rule alone made 92 of the directory's 347 rows.
   Of the 90 rows doing it: 44 were supported by a matching phone, 37 had no
   evidence either way, and NINE WERE CONTRADICTED — different phone numbers on
   the records it joined. The worst carried seven accounts and three numbers,
   filed variously as 'ZAHID KHAN ISMAIL ISMAIL' and 'Zahid Khan Mohabbat
   Khan'. Different fathers' names, one row, and — once money starts — one
   balance.

   CLAUDE.md forbids the rule in as many words, so the fold is gone. But
   REMOVING IT IS ONLY HALF THE JOB. Measured at the same time: of the 121
   accounts that rule placed, ONE appeared anywhere in driver_identity_link.
   The other 120 had no proposal at all. Dropping the fold without writing them
   down would split 120 people apart and leave nobody anything to review — the
   count would be defensible and the roster would be quietly wrong in a way
   nobody was being asked about.

   So this writes them as PROPOSALS. They are never applied:
   api/identity_links.js folds a link only where the basis is conclusive — a
   shared phone or email, which are IDENTIFIERS — or a person has confirmed it,
   and `same_name` is neither.

   ── THE RULE IS EXACT EQUALITY, AND ONLY THAT ───────────────────────────
   Not a trigram, not a subset — src/identity_link.js already proposes those.
   This is the narrow case that rule was missing: two accounts filed under the
   SAME name once case and punctuation are folded away. It is the weakest
   possible name evidence and the most common shape on this roster, which is
   exactly why it must be asked rather than applied.

   ── THE PHONE VERDICT GOES IN THE EVIDENCE ──────────────────────────────
   Because it is what the person answering actually needs, and because it is
   already the register's own conclusive basis for 82 of its entries. Three
   states, each said plainly: the numbers agree, the numbers DISAGREE (which is
   a reason to say no, and nine of these carry it), or neither record has one. */
import { pool } from './db.js';
import { log } from './log.js';
import { foldName } from '../api/identity_map.js';

const EVERYONE = `
  SELECT platform, driver_ext_id AS ext_id, max(name) AS name, max(phone) AS phone,
         max(trips)::int AS trips
    FROM (
      SELECT platform, driver_ext_id, full_name AS name, phone, 0 AS trips
        FROM driver_compliance WHERE driver_ext_id IS NOT NULL
      UNION ALL
      SELECT platform, driver_ext_id, full_name, NULL, 0 FROM driver_platform_state
       WHERE driver_ext_id IS NOT NULL
      UNION ALL
      SELECT platform, driver_ext_id, driver_name, NULL, count(*)::int
        FROM trip WHERE driver_ext_id IS NOT NULL
       GROUP BY platform, driver_ext_id, driver_name
    ) x
   WHERE coalesce(btrim(name), '') <> ''
   GROUP BY platform, driver_ext_id`;

const tail = (p) => {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 7 ? d.slice(-9) : null;
};

/** Propose every pair of accounts filed under the same folded name that no
 *  reviewed decision already joins. Never applies one. Idempotent. */
export async function refreshNameProposals(db = pool) {
  const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
  const accounts = await q(EVERYONE);

  /* Who is already on one person, from the spine — the table that holds the
     reviewed answer. A pair the spine already joins is not a question. */
  const placed = new Map();
  for (const r of await q(
    `SELECT external_id, driver_id FROM driver_platform_id WHERE detached_at IS NULL`)) {
    placed.set(r.external_id, Number(r.driver_id));
  }
  /* An account can be an alias of at most one person — driver_identity_link's
     primary key says so — and a second basis for the same alias is not new
     information. */
  const claimed = new Set((await q(
    `SELECT alias_ext_id FROM driver_identity_link`)).map((r) => r.alias_ext_id));

  const byName = new Map();
  for (const a of accounts) {
    const k = foldName(a.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(a);
  }

  let wrote = 0; let skipped = 0; const verdicts = { agree: 0, disagree: 0, unknown: 0 };
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    /* The survivor is the record with the most trips — the one an operator
       recognises — and ties break on the id so the pair is written the same
       way on every pass. */
    const sorted = group.slice().sort(
      (a, b) => (b.trips || 0) - (a.trips || 0) || String(a.ext_id).localeCompare(String(b.ext_id)));
    const keep = sorted[0];
    for (const alias of sorted.slice(1)) {
      if (claimed.has(alias.ext_id)) { skipped += 1; continue; }
      /* Already one person by a reviewed decision — nothing to ask. */
      if (placed.has(alias.ext_id) && placed.get(alias.ext_id) === placed.get(keep.ext_id)) {
        skipped += 1; continue;
      }
      const ta = tail(alias.phone); const tk = tail(keep.phone);
      const verdict = (ta && tk) ? (ta === tk ? 'agree' : 'disagree') : 'unknown';
      verdicts[verdict] += 1;
      const phoneSays = {
        agree: 'Both records carry the same phone number, which is the basis this register '
          + 'already treats as conclusive for 82 of its entries — strong support for a yes.',
        disagree: 'The two records carry DIFFERENT phone numbers. That is a reason to say no: '
          + 'this roster holds pairs that are two different men with one name, and a shared '
          + 'name with separate numbers is what those look like.',
        unknown: 'Neither record carries a phone number, so there is no identifier either way. '
          + 'A car in common or a look at their documents is what would settle it.',
      }[verdict];
      await q(
        `INSERT INTO driver_identity_link
           (alias_ext_id, alias_platform, alias_name, canonical_ext_id, canonical_platform,
            canonical_name, canonical_key, basis, evidence, phone_tail, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'same_name',$8,$9, now())
         ON CONFLICT (alias_ext_id) DO UPDATE SET
           evidence = EXCLUDED.evidence, last_seen_at = now()`,
        [alias.ext_id, alias.platform, alias.name, keep.ext_id, keep.platform, keep.name,
          foldName(keep.name),
          `${keep.platform} and ${alias.platform} both file this driver as `
          + `“${keep.name}”. The same name on two channels is the commonest shape on this `
          + `roster and is also what two relatives look like — nothing about the name settles `
          + `it either way, which is why it is being asked rather than applied. ${phoneSays}`,
          ta ? ta.slice(-4) : null]);
      wrote += 1;
    }
  }
  const out = { accounts: accounts.length, wrote, skipped, ...verdicts };
  log.info('name-proposals', 'same-name pairs proposed', out);
  return out;
}
