/* A TRANSACTION, WHICH THIS API LAYER HAS NEVER HAD — and the dry run built
   out of one.
   ─────────────────────────────────────────────────────────────────────────
   Every read route here runs a statement at a time against the pool, which is
   right for reads. The driver ledger's write is not one statement: it resolves
   a person (which may INSERT a driver row and one or more account mappings),
   inserts the entry, and inserts the audit row. Three connections and no
   transaction means a crash between them leaves a person with no entry, or an
   entry with no audit trail — on an append-only table where nothing can be
   tidied up afterwards, only reversed.

   ── AND THE DRY RUN IS THE SAME CODE PATH, ROLLED BACK ───────────────────
   CLAUDE.md requires a deployment to be verified on production with "every
   modal filled". For a debt book that ritual would write permanent rows against
   real named people every time somebody checked the form worked.

   The obvious alternative — a preview that SIMULATES the write — proves
   nothing, because the thing most likely to reject a row is the database
   itself: sql/schema_v78.sql enforces the sign against the type through a
   composite foreign key, and a simulation would have to reimplement that rule
   and could then disagree with it. So the dry run executes the real inserts,
   against the real constraints, and rolls back. What it reports is what would
   have happened, because it is what did happen. */

/** Wrap a pg Pool in a transaction runner. */
export function pgTx(pool) {
  return async function tx(fn, { rollback = false } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const q = (t, p) => client.query(t, p).then((r) => r.rows);
      const out = await fn(q);
      /* ROLLBACK on the success path is the dry run, and it is deliberately
         the LAST thing that happens: every constraint has already been
         evaluated by the statements above, so a row that would be refused has
         already thrown and been reported as a refusal. */
      await client.query(rollback ? 'ROLLBACK' : 'COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
}

/* The sentinel a rolled-back PGlite transaction throws to unwind. It is an
   object rather than an Error so it can never be mistaken for a real failure
   by a catch that inspects .message. */
export const ROLLBACK = Object.freeze({ rollback: true });

/** The same contract over a PGlite instance, for the test harness. */
export function pgliteTx(db) {
  return async function tx(fn, { rollback = false } = {}) {
    let out;
    try {
      await db.transaction(async (t) => {
        out = await fn((sql, p) => t.query(sql, p).then((r) => r.rows));
        if (rollback) throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return out;
  };
}
