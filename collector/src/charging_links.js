/* WHEN PERSON ROWS FOLD, A CHARGING DECISION FOLLOWS THE PERSON.
   ─────────────────────────────────────────────────────────────────────────
   charging_link (sql/schema_v113.sql) ties a PowerDrive customer to one of
   our people by person id — a `driver` row. Three paths fold person rows into
   one and DELETE the others: the spine's own fold (src/persons.js, every
   collector pass and on a #same-person confirm) and an authorised merge
   (api/person_merge_routes.js). Nothing moved the links, and the independent
   review of 2026-11-03 reproduced both ways that goes wrong:
     · a customer REFUSED for person 2, then 2 folded into 1 — the refusal
       pointed at a row that no longer existed, the next run saw no decision
       about person 1, and linked the customer to person 1 automatically;
     · a customer CONFIRMED for person 4, then 4 folded into 3 — the link kept
       pointing at the deleted id, so person 3 read "no charging wallet
       linked" and the wallet list named "person 4", a page that is not there.
   So every fold calls this, inside its own transaction where it has one:
     · the folded rows' machine links (auto, candidate) are dropped — the next
       run recomputes them for the survivor;
     · a person's decision MOVES to the survivor — one UPDATE of its person
       id, so it is never deleted first and lost if a write fails (the second
       review: the paths in src/persons.js commit statement by statement), and
       its decided_at and decided_by stay as they were;
     · where the survivor and a folded row decided the SAME way about one
       customer, one row stays;
     · where they decided DIFFERENTLY (one confirmed, one refused — two records
       of one human, judged apart), the pair becomes 'held' (sql/schema_v114.sql):
       a tier the collector never recomputes, offered for review every run and
       never linked automatically. It was 'candidate' in the first fix, and the
       second review showed the next run deleting and recomputing it — into an
       automatic link, or into nothing;
     · the customers touched have their charges taken off cars until the next
       run puts them on again (plate and basis both, so no charge is counted
       on a car with no basis meanwhile).
   No import: src/persons.js and the merge route both reach it without
   pulling in the collector. */

const DECIDED = new Set(['confirmed', 'refused']);

/** Move `gone` person ids' charging links onto `survivor`. Returns how many
    customers were touched. `q` is (sql, params) => rows. */
export async function followPersonFold(q, survivor, gone) {
  const keep = Number(survivor);
  const drop = [...new Set((gone || []).map(Number))].filter((n) => Number.isInteger(n) && n !== keep);
  if (!drop.length) return 0;
  const rows = await q(`SELECT yc_user_id, person_id::text AS person, tier, reason, decided_by
                          FROM charging_link WHERE person_id = ANY($1::bigint[])`, [[keep, ...drop]]);
  if (!rows.length) return 0;
  const byCustomer = new Map();
  for (const r of rows) {
    if (!byCustomer.has(r.yc_user_id)) byCustomer.set(r.yc_user_id, []);
    byCustomer.get(r.yc_user_id).push(r);
  }
  const touched = [];
  for (const [yc, list] of byCustomer) {
    const folded = list.filter((r) => Number(r.person) !== keep);
    if (!folded.length) continue;                                  // only the survivor's own row
    touched.push(yc);
    const mine = list.find((r) => Number(r.person) === keep) || null;
    const decisions = list.filter((r) => DECIDED.has(r.tier) || r.tier === 'held');
    const tiers = new Set(decisions.map((r) => r.tier));
    const removeFolded = (except = null) => q(`DELETE FROM charging_link WHERE yc_user_id = $1 AND person_id = ANY($2::bigint[])
                                                 ${except != null ? 'AND person_id <> $3' : ''}`,
    except != null ? [yc, drop, except] : [yc, drop]);
    if (!decisions.length) { await removeFolded(); continue; }     // machine rows only: recomputed next run
    const contradictory = tiers.has('held') || tiers.size > 1;
    const why = contradictory
      ? `held: decided differently for records now folded into one person (${decisions
        .map((d) => `${d.tier}${d.decided_by ? ` by ${d.decided_by}` : ''}`).join('; ')}) — decide again`
      : null;
    if (mine && (DECIDED.has(mine.tier) || mine.tier === 'held')) {
      /* The survivor's own decision stays; a contradiction holds it. */
      if (contradictory) {
        await q(`UPDATE charging_link SET tier = 'held', reason = $3 WHERE yc_user_id = $1 AND person_id = $2`, [yc, keep, why]);
      }
      await removeFolded();
      continue;
    }
    /* The survivor has no decision: a machine row of its gives way, and one
       folded decision is moved onto it in a single UPDATE. */
    if (mine) await q(`DELETE FROM charging_link WHERE yc_user_id = $1 AND person_id = $2`, [yc, keep]);
    const carry = decisions[0];
    if (contradictory) {
      /* Off 'confirmed' before anything moves: one confirmation per customer
         (sql/schema_v114.sql). */
      await q(`UPDATE charging_link SET tier = 'held', reason = $3 WHERE yc_user_id = $1 AND person_id = $2`, [yc, Number(carry.person), why]);
    }
    await removeFolded(Number(carry.person));
    await q(`UPDATE charging_link SET person_id = $3 WHERE yc_user_id = $1 AND person_id = $2`, [yc, Number(carry.person), keep]);
  }
  if (touched.length) {
    await q(`UPDATE charging_session SET plate = NULL, plate_basis = NULL WHERE yc_user_id = ANY($1::text[])`, [touched]);
  }
  return touched.length;
}
