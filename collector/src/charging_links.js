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
     · a person's decision moves to the survivor; where the survivor and a
       folded row decided the SAME way about one customer, one row stays;
       where they decided DIFFERENTLY (one confirmed, one refused — two records
       of one human, judged apart), the pair goes back to a person as a
       candidate saying so, never resolved here;
     · the customers touched have their charges re-attributed next run.
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
    const decisions = list.filter((r) => DECIDED.has(r.tier));
    const tiers = new Set(decisions.map((r) => r.tier));
    await q(`DELETE FROM charging_link WHERE yc_user_id = $1 AND person_id = ANY($2::bigint[])`, [yc, [keep, ...drop]]);
    if (!decisions.length) continue;                               // machine rows only: the next run recomputes them
    if (tiers.size === 1) {
      const d = decisions.find((r) => Number(r.person) === keep) || decisions[0];
      await q(`INSERT INTO charging_link (yc_user_id, person_id, tier, reason, decided_by, decided_at)
               VALUES ($1, $2, $3, $4, $5, now())`, [yc, keep, d.tier, d.reason || null, d.decided_by || null]);
    } else {
      await q(`INSERT INTO charging_link (yc_user_id, person_id, tier, reason, decided_at)
               VALUES ($1, $2, 'candidate', $3, now())`, [yc, keep,
        'a person confirmed this customer for one record and refused it for another, and the two records are now one person — decide again']);
    }
  }
  if (touched.length) {
    await q(`UPDATE charging_session SET plate_basis = NULL WHERE yc_user_id = ANY($1::text[])`, [touched]);
  }
  return touched.length;
}
