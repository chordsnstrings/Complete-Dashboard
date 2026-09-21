/* IMPORTING HISTORY FROM A SPREADSHEET — propose, then commit what a human
   chose.
   ─────────────────────────────────────────────────────────────────────────
   Two endpoints, and the split between them is the whole design:

     POST /api/ledger/import/preview   takes NAMES, writes nothing
     POST /api/ledger/import/commit    takes IDENTIFIERS, writes

   THE COMMIT ENDPOINT DOES NOT ACCEPT A NAME. That is not an oversight and it
   is not a convenience — it is what makes auto-applying a match impossible at
   the boundary rather than merely discouraged by a comment. A row can only be
   written against a person somebody chose from the proposals, because there is
   no other way to address one.

   An identifier is a person id, OR a (platform, account id) pair. The second
   was added because `driver` is empty until somebody records an entry, so a
   commit that accepted person ids alone could not import into the very ledger
   an import exists to open — every row would name a person nobody had minted.
   It does not weaken the rule by a hair: a provider's account id is a stable
   key a human picked off a dropdown, not a string the matcher produced, and
   api/ledger_person.js resolves it through the merge register inside this
   transaction. What the boundary refuses is a NAME, and it still does.

   api/identity_map.js is a hand-reviewed LIST and argues at length that it must
   never learn to generalise; the five pairs it holds back carry simultaneous
   trips in two cars, and two of the names on it are one letter apart. A matcher
   that wrote its own best guess would pool two people's debts at the moment
   money was imported against one of them — and an import is exactly when
   nobody is watching each row.

   ── AND THE MATCHING IS LOCAL ────────────────────────────────────────────
   api/name_match.js says why at length: posting several hundred real names,
   with the amounts they owe beside them, to a model in another jurisdiction
   contradicts a rule this repo wrote down twice.

   ── OPENING BALANCES ARE THE POINT OF THIS ──────────────────────────────
   The two types with no photograph — `opening_balance` and `cash_opening` —
   exist because history has no receipts, and an import is the only way they
   arrive in bulk. Every other type still requires its proof, which is why the
   preview refuses them here rather than letting somebody discover it on row
   ninety. */
import { matchName } from './name_match.js';
import { resolvePerson, personKey } from './ledger_person.js';
import { identityLinks } from './identity_links.js';

const TYPES_ALLOWED = ['opening_balance', 'cash_opening', 'cash_advance', 'salary_advance',
  'charging_advance', 'repayment', 'salik', 'traffic_fine', 'damage', 'salary'];

const parseAmount = (v) => {
  const t = String(v ?? '').trim().replace(/,/g, '').replace(/^AED\s*/i, '');
  if (!t || !/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
/* A SHAPE CHECK IS NOT A DATE CHECK. /^\d{4}-\d{2}-\d{2}$/ accepts
   "2026-13-99" — thirteen is two digits and so is ninety-nine — and a
   spreadsheet exported from the wrong locale is exactly where a month of 13
   comes from. Round-tripping through Date is what actually rejects it. */
const isDay = (v) => {
  const t = String(v || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  const d = new Date(`${t}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === t;
};

export function importRoutes(app, { q, wrap, tx }) {
  /* EVERYBODY A ROW COULD BE ABOUT, which is not the same as everybody this
     ledger already knows.
     ───────────────────────────────────────────────────────────────────────
     This matched against `driver` alone, and `driver` is empty until somebody
     records an entry — people are minted lazily (api/ledger_person.js). So on
     the ledger an import is meant to OPEN, every row of a four-hundred-row
     historical sheet matched against nobody and the preview answered "not on
     the roster" four hundred times. The one screen built to load history could
     not load any.

     So the candidates are the union: the people who exist, plus the platform
     roster accounts nobody has claimed yet. A candidate carries a `key`, and
     the key is what a screen sends back — `p:<id>` for somebody who exists,
     `a:<platform>:<ext_id>` for an account. Still never a name: see the commit
     route below for why that distinction is the whole design.

     A person with no account at all is included — a salary advance to a new
     hire is exactly the kind of row a historical sheet carries. */
  const roster = async (tq) => {
    const known = (await tq(
      `SELECT dr.id AS person_id, dr.full_name AS name,
              count(a.external_id)::int AS accounts,
              min(a.external_id) AS ext_id, min(a.platform) AS platform
         FROM driver dr
         LEFT JOIN driver_platform_id a
           ON a.driver_id = dr.id AND a.detached_at IS NULL
        WHERE dr.full_name IS NOT NULL
        GROUP BY dr.id, dr.full_name
        ORDER BY dr.full_name`)).map((r) => ({
      ...r, person_id: Number(r.person_id), key: personKey({ person_id: Number(r.person_id) }),
      on_the_ledger: true }));

    const unclaimed = (await tq(
      `SELECT r.platform, r.driver_ext_id AS ext_id, max(r.name) AS name
         FROM (SELECT platform, driver_ext_id, full_name AS name FROM driver_platform_state
               UNION ALL
               SELECT platform, driver_ext_id, full_name FROM driver_compliance) r
        WHERE NOT EXISTS (
          SELECT 1 FROM driver_platform_id m
           WHERE m.platform = r.platform AND m.external_id = r.driver_ext_id
             AND m.detached_at IS NULL)
        GROUP BY r.platform, r.driver_ext_id
        HAVING max(r.name) IS NOT NULL
        ORDER BY 3`)).map((r) => ({
      person_id: null, name: r.name, accounts: 0, ext_id: r.ext_id, platform: r.platform,
      key: personKey({ person_id: null, platform: r.platform, ext_id: r.ext_id }),
      on_the_ledger: false }));

    return [...known, ...unclaimed];
  };

  /* A candidate, as a screen sees it. `key` is the handle; person_id may be
     null and the account is then what addresses them. */
  const cand = (p) => (p ? { key: p.key, person_id: p.person_id, name: p.name,
    accounts: p.accounts, platform: p.platform || null, ext_id: p.ext_id || null,
    on_the_ledger: p.on_the_ledger } : null);

  app.post('/api/ledger/import/preview', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ error: 'send { rows: [ { name, type_code, amount, '
        + 'effective_on, note } ] } — the sheet, parsed. Nothing is written by this route.' });
    }
    /* FIVE HUNDRED, AND IT IS A CAP THIS ROUTE CAN ACTUALLY ENFORCE.
       It was 2000, which was dead code: api/server.js:106 caps every JSON body
       in this process at 256kb, and 2000 rows of a real sheet is several times
       that — so the request was refused with a 413 by body-parser and this
       check never ran. A limit that cannot fire is worse than none, because it
       reads as a considered bound.

       Refused entirely rather than truncated: answering about the first five
       hundred under a request that named more reads as "we checked
       everything", which is the refusal /api/finance/payouts/verify makes and
       for the same reason. */
    if (rows.length > 500) {
      return res.status(400).json({ error: `this named ${rows.length} rows and the cap is 500. `
        + 'Refused rather than truncated — a partial answer to a whole-sheet question reads as '
        + 'a whole answer. Split the sheet: 500 rows at a time fits inside the 256kb body limit '
        + 'every route in this process shares.' });
    }

    const people = await roster(q);
    const types = Object.fromEntries((await q(
      `SELECT code, label, needs_proof, active FROM ledger_type`)).map((t) => [t.code, t]));

    const out = rows.map((r, i) => {
      const problems = [];
      const name = String(r.name ?? '').trim();
      const code = String(r.type_code ?? '').trim();
      const amount = parseAmount(r.amount);
      const day = String(r.effective_on ?? '').trim();

      if (!name) problems.push('no name in this row');
      if (!types[code]) problems.push(`"${code || '(none)'}" is not a type this ledger holds`);
      else if (!types[code].active) problems.push(`"${code}" is no longer in use`);
      else if (!TYPES_ALLOWED.includes(code)) {
        problems.push(`"${code}" cannot be imported — it is not one of the types a historical `
          + 'sheet carries');
      } else if (types[code].needs_proof) {
        /* Named here rather than at commit, because discovering it on row
           ninety of a sheet is the wrong moment. */
        problems.push(`${types[code].label} requires a photograph of the proof, which a `
          + 'spreadsheet has none of. Only the types that record a decision or a period figure '
          + 'can be imported — an opening balance, an opening cash position, a period of tolls.');
      }
      if (amount == null) problems.push(`"${r.amount}" is not an amount`);
      else if (amount <= 0) problems.push('amounts are magnitudes here; the type decides the sign');
      if (!isDay(day)) problems.push(`"${r.effective_on}" is not a YYYY-MM-DD date`);
      if (String(r.note ?? '').trim().length < 3) problems.push('every row needs a note');

      const m = name ? matchName(name, people) : { verdict: 'none', best: null, confidence: 0,
        alternatives: [], why: 'no name to match' };

      return {
        row: i + 1,
        sheet: { name, type_code: code, amount: r.amount, effective_on: day, note: r.note },
        parsed: { amount, effective_on: isDay(day) ? day : null },
        match: {
          verdict: m.verdict,
          why: m.why,
          confidence: m.confidence,
          person: cand(m.best),
          alternatives: (m.alternatives || []).map((a) => ({ ...cand(a.person), score: a.score })),
        },
        problems,
        /* What a screen may offer as pre-selected. An ambiguous match is NOT
           offered — that is the case where picking the higher score is a coin
           toss, and a pre-ticked checkbox is how a coin toss becomes a
           decision nobody remembers making. */
        ready: problems.length === 0 && ['exact', 'likely'].includes(m.verdict),
      };
    });

    const by = (v) => out.filter((r) => r.match.verdict === v).length;
    res.json({
      rows: out.length,
      summary: {
        ready: out.filter((r) => r.ready).length,
        exact: by('exact'), likely: by('likely'), ambiguous: by('ambiguous'),
        weak: by('weak'), unmatched: by('none'),
        with_problems: out.filter((r) => r.problems.length).length,
      },
      /* Said rather than implied by the numbers above. */
      note: 'Nothing was written. Every row still needs a person chosen for it — the commit '
        + 'route does not accept a name at all, which is what makes auto-applying a match '
        + 'impossible rather than merely discouraged.',
      matched_against: people.length,
      /* Said, because "matched against 412" means something different when 400
         of them are roster accounts with no ledger record: importing against
         one OPENS that record rather than adding to it. */
      matched_against_on_the_ledger: people.filter((p) => p.on_the_ledger).length,
      matched_against_roster_only: people.filter((p) => !p.on_the_ledger).length,
      entries: out,
    });
  }));

  app.post('/api/ledger/import/commit', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const b = req.body || {};
    const rows = Array.isArray(b.rows) ? b.rows : null;
    const by = String(b.entered_by || '').trim().toLowerCase();
    if (!rows || !rows.length) return res.status(400).json({ error: 'no rows' });
    if (!b.batch || String(b.batch).length < 4) {
      return res.status(400).json({ error: 'a batch id is required, so every row of one import '
        + 'can be found together afterwards — including to reverse it' });
    }

    /* ALL OR NOTHING. A half-applied import leaves a register nobody can
       reason about: some people's balances moved and some did not, and the
       only way to tell which is to read the sheet against the ledger row by
       row. One transaction, and a single bad row refuses the lot with its
       number. */
    try {
      const wrote = await tx(async (tq) => {
        const ids = new Set((await tq(`SELECT id FROM driver`)).map((r) => Number(r.id)));
        const made = [];
        /* One identity map for the whole import, so a degraded read cannot be
           half-applied across a sheet — some rows resolved against the merge
           register and some minted fresh duplicates for the same people. */
        const links = await identityLinks(tq);
        for (const [i, r] of rows.entries()) {
          let pid = Number(r.person_id) || null;
          if (pid && !ids.has(pid)) {
            throw new Error(`row ${i + 1}: person_id ${r.person_id} is not a person this ledger `
              + 'holds.');
          }
          if (!pid) {
            /* NOT A NAME — an account. The screen sent what a human picked off
               a dropdown, and the resolver decides who it belongs to, with the
               merge register in hand, inside this transaction. If it refuses,
               the whole import refuses: minting a duplicate person mid-sheet
               splits a balance in two with neither half right. */
            if (!r.platform || !r.ext_id) {
              throw new Error(`row ${i + 1}: no person and no account. A row is addressed by a `
                + 'person id or by a (platform, account id) pair — never by a name, which is what '
                + 'makes auto-applying a fuzzy match impossible here rather than merely '
                + 'discouraged. Choose somebody for this row.');
            }
            const got = await resolvePerson(tq, {
              platform: r.platform, extId: r.ext_id, name: r.person_name || null, by, links });
            if (got.refused) throw new Error(`row ${i + 1}: ${got.why}`);
            pid = got.person_id;
            ids.add(pid);
          }
          const amount = parseAmount(r.amount);
          if (amount == null || amount <= 0) throw new Error(`row ${i + 1}: "${r.amount}" is not an amount`);
          if (!isDay(r.effective_on)) throw new Error(`row ${i + 1}: bad date`);
          if (!TYPES_ALLOWED.includes(String(r.type_code))) {
            throw new Error(`row ${i + 1}: "${r.type_code}" cannot be imported`);
          }
          const [t] = await tq(
            `SELECT code, direction, book, needs_proof FROM ledger_type WHERE code = $1 AND active`,
            [r.type_code]);
          if (!t) throw new Error(`row ${i + 1}: unknown type`);
          if (t.needs_proof) throw new Error(`row ${i + 1}: ${r.type_code} requires a photograph`);
          const [name] = await tq(`SELECT full_name FROM driver WHERE id = $1`, [pid]);
          const [made1] = await tq(
            `INSERT INTO driver_ledger
               (person_id, person_name, resolved_from, type_code, direction, book, amount,
                effective_on, entered_by, entered_ip, note, entry_source, import_batch)
             VALUES ($1,$2,'human:import',$3,$4,$5,$6,$7::date,$8,$9,$10,'import',$11)
             RETURNING id`,
            [pid, name?.full_name || `person ${pid}`, t.code, t.direction, t.book,
              amount * t.direction, r.effective_on, by, req.ip || null,
              String(r.note || '').trim() || `imported in batch ${b.batch}`, String(b.batch)]);
          made.push(Number(made1.id));
        }
        await tq(
          `INSERT INTO driver_ledger_audit (actor, ip, action, outcome, why, payload)
           VALUES ($1,$2,'import','accepted',$3,$4::jsonb)`,
          [by, req.ip || null, `${made.length} rows in batch ${b.batch}`,
            JSON.stringify({ batch: b.batch, rows: made.length })]);
        return made;
      });
      return res.json({ ok: true, batch: String(b.batch), wrote: wrote.length, entry_ids: wrote });
    } catch (e) {
      return res.status(400).json({ ok: false, wrote: 0,
        refused: [String(e?.message || e)],
        note: 'Nothing was written. An import is all or nothing — a half-applied one leaves a '
          + 'register nobody can reason about, where telling which balances moved means reading '
          + 'the sheet against the ledger row by row.' });
    }
  }));
}
