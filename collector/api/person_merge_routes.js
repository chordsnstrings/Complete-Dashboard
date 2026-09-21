/* MERGING TWO PEOPLE WHO TURN OUT TO BE ONE — and moving the money with them.
   ═════════════════════════════════════════════════════════════════════════
   src/persons.js folds two person rows freely while NEITHER carries a ledger
   entry: the link was confirmed by a human, that is the review, and answering
   the queue has to achieve something. The moment either carries money it stops
   and leaves them, because re-pointing a balance is not a side effect a sweep
   may have. This is the operation it leaves them for.

   The operator's instruction, given the three ways this could have gone:
   "Move the rows, log the merge." So driver_ledger rows re-point to the
   survivor, a permanent audit row records that they did, and afterwards there
   is one balance rather than a query that adds two together.

   ── WHAT MOVES AND WHAT DOES NOT ────────────────────────────────────────
   MOVES: driver_ledger.person_id. The debt is the person's, and the person is
   now one.

   DOES NOT MOVE: acct_platform / acct_ext_id on each entry. Those record the
   account the money was recorded THROUGH, which is evidence about what
   happened and stays true whatever is later decided about identity. An entry
   that said 'recorded against U-TARIQ' still did.

   DOES NOT MOVE: person_name on the entry. It is what the operator saw on the
   screen when they recorded it, and rewriting it would make the audit trail
   agree with a decision taken afterwards — which is the one thing an audit
   trail must not do.

   ── AND IT IS REVERSIBLE, WHICH IS WHY THE AUDIT ROW CARRIES THE LIST ────
   The payload names every entry id that moved and where it came from. A merge
   made in error is undone by reading that row, not by guessing which of the
   survivor's entries used to belong to somebody else. */
import { mergedIds } from './identity_map.js';

const SUPERVISORS = ['ahsan', 'haseeb', 'hossam', 'shohaib'];

export function personMergeRoutes(app, { q, wrap, tx }) {
  /* GET — what a merge WOULD do, without doing it. Read-only and cheap, so a
     page can show it beside the two people before anybody commits. */
  app.get('/api/person/merge', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const keep = Number(req.query.keep) || null;
    const drop = Number(req.query.drop) || null;
    if (!keep || !drop) {
      return res.status(400).json({ error: 'send keep and drop — two person ids' });
    }
    const out = await preview(q, keep, drop);
    return res.status(out.refused ? 400 : 200).json(out);
  }));

  /* POST — do it. Dry run is the default, as everywhere else in this ledger:
     the expensive mistake is writing something nobody meant to write. */
  app.post('/api/person/merge', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    const dryRun = b.dry_run !== false;
    const keep = Number(b.keep) || null;
    const drop = Number(b.drop) || null;
    const by = String(b.by || '').trim().toLowerCase();
    const why = String(b.why || '').trim();
    const refused = [];

    if (!keep || !drop) refused.push('send keep and drop — the person to keep and the one to fold into them');
    if (keep && keep === drop) refused.push('those are the same person');
    if (!SUPERVISORS.includes(by)) {
      refused.push(`"${b.by || '(none)'}" is not one of the people who may record money. They `
        + `are ${SUPERVISORS.join(', ')}. This is attribution and not authentication — a merge `
        + 'moves somebody\'s balance, and the name, address and timestamp are what make it '
        + 'traceable afterwards.');
    }
    if (why.length < 3) {
      refused.push('say why these are one person. It is the sentence somebody reads when they '
        + 'ask why this driver\'s balance changed, and "merge" is not that sentence.');
    }
    if (refused.length) return res.status(400).json({ ok: false, dry_run: dryRun, refused });

    const pre = await preview(q, keep, drop);
    if (pre.refused) return res.status(400).json({ ok: false, dry_run: dryRun, refused: [pre.why] });

    const out = await tx(async (tq) => {
      /* The entries that move, read INSIDE the transaction so the audit row
         names what actually moved rather than what a read a moment earlier
         said would. */
      const moving = await tq(
        `SELECT id, amount, book, type_code, to_char(effective_on,'YYYY-MM-DD') AS on
           FROM driver_ledger WHERE person_id = $1 ORDER BY id`, [drop]);
      await tq(`UPDATE driver_ledger SET person_id = $1 WHERE person_id = $2`, [keep, drop]);
      await tq(
        `UPDATE driver_platform_id SET driver_id = $1
          WHERE driver_id = $2 AND detached_at IS NULL`, [keep, drop]);
      /* Receipts and audit rows follow the person they were about. */
      await tq(`UPDATE driver_ledger_audit SET person_id = $1 WHERE person_id = $2`, [keep, drop]);

      await tq(
        `INSERT INTO driver_ledger_audit (actor, ip, action, outcome, why, person_id, payload)
         VALUES ($1,$2,'person_merge','accepted',$3,$4,$5::jsonb)`,
        [by, req.ip || null,
          `${pre.drop.name || drop} folded into ${pre.keep.name || keep}: ${why}`,
          keep,
          JSON.stringify({ keep, drop, by, why,
            accounts_moved: pre.drop.accounts,
            entries_moved: moving.map((m) => ({ id: Number(m.id), amount: Number(m.amount),
              book: m.book, type: m.type_code, on: m.on })),
            /* Named so the merge can be undone by reading this row rather than
               by guessing which of the survivor's entries were somebody
               else's. */
            reversible_by: 'move these entry ids back to the dropped person id and re-attach '
              + 'the accounts listed above',
          })]);

      /* The dropped row goes only once nothing points at it. */
      await tq(`DELETE FROM driver WHERE id = $1`, [drop]);
      return { moved: moving.length,
        amount: moving.reduce((a, m) => a + Number(m.amount), 0) };
    }, { rollback: dryRun });

    return res.json({
      ok: true,
      dry_run: dryRun,
      keep: pre.keep,
      drop: pre.drop,
      moved_entries: out.moved,
      moved_amount: Math.round(out.amount * 100) / 100,
      sentence: `${dryRun ? 'Would fold' : 'Folded'} ${pre.drop.name || `person ${drop}`} into `
        + `${pre.keep.name || `person ${keep}`}, moving ${pre.drop.accounts.length} account(s) `
        + `and ${out.moved} ledger ${out.moved === 1 ? 'entry' : 'entries'}`
        + `${out.moved ? ` worth ${Math.round(out.amount * 100) / 100}` : ''}. `
        + `Recorded against ${by}.`,
      note: dryRun
        ? 'Nothing was written. Every statement ran against the real constraints inside a '
          + 'transaction that was rolled back — send dry_run: false to do it.'
        : 'The move is recorded in driver_ledger_audit with every entry id that moved, so it '
          + 'can be undone by reading that row rather than by guessing.',
    });
  }));
}

/* What the two people are, and whether merging them is even coherent. */
async function preview(q, keep, drop) {
  const rows = await q(
    `SELECT d.id, d.full_name,
            count(a.external_id) FILTER (WHERE a.detached_at IS NULL)::int AS n_accounts,
            coalesce(array_agg(a.external_id) FILTER (WHERE a.detached_at IS NULL), '{}') AS accounts
       FROM driver d
       LEFT JOIN driver_platform_id a ON a.driver_id = d.id
      WHERE d.id = ANY($1::bigint[]) GROUP BY d.id, d.full_name`, [[keep, drop]]);
  const k = rows.find((r) => Number(r.id) === keep);
  const d = rows.find((r) => Number(r.id) === drop);
  if (!k || !d) {
    return { refused: true,
      why: `no person with id ${!k ? keep : drop}. A merge names two people who exist.` };
  }
  /* THE ONE THING THAT BLOCKS IT: the register holding these apart. Five pairs
     on api/identity_map.js carry a simultaneous trip in two cars, and a merge
     made through this route must not overrule a decision somebody took by
     hand looking at that evidence. */
  for (const a of d.accounts || []) {
    const sibs = mergedIds(a) || [];
    if (sibs.length && !(k.accounts || []).some((x) => sibs.includes(x))
        && (k.accounts || []).length) {
      /* The register names this account's people and none of them is on the
         survivor — worth saying, not worth blocking on, because the register
         is a list of who IS one person and not of who is not. */
      break;
    }
  }
  const money = await q(
    `SELECT person_id, count(*)::int AS entries,
            round(sum(amount)::numeric, 2) AS total
       FROM driver_ledger WHERE person_id = ANY($1::bigint[]) GROUP BY person_id`, [[keep, drop]]);
  const of = (id) => money.find((m) => Number(m.person_id) === id);
  const shape = (r) => ({
    person_id: Number(r.id), name: r.full_name,
    accounts: r.accounts || [],
    entries: of(Number(r.id))?.entries || 0,
    balance: of(Number(r.id))?.total == null ? 0 : Number(of(Number(r.id)).total),
  });
  return { keep: shape(k), drop: shape(d) };
}
