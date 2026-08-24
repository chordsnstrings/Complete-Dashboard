/* Does the platform's money add up, month by month?
   ─────────────────────────────────────────────────────────────────────────
   The product holds three views of the same money and never adds them
   together: fares (what riders were charged), the ON-TRIP statement view
   (gross minus commission — what the fleet EARNED), and the BANK payout (what
   actually reached the account). Reconciling July 2026 against the operator's
   ledger settled how they relate:

       bank payout  ≈  on-trip net + tips + salik − cash collected

   and proved it to 0.7% once the cash was accounted for. That identity is the
   whole check an operator has against a platform's numbers, and until now the
   product could state it only in captions. This endpoint computes it, month by
   month — or day by day inside one month — so the two sides sit in the same
   row and the gap between them is a number rather than an impression.

   The sides come from the tables each view already lives in, filtered the way
   every other money page filters them:

     trips        rollup_month / rollup_day, falling back to the SAME grain
                  SQL the rollup is built from (src/rollup.js) — never a third
                  copy of the aggregate that could drift from the other two.
     on-trip      driver_statement_day, source <> 'ledger' ALWAYS: the
                  operator's imported workbook is reference data that taught
                  the reconciliation, and it must never be displayed as if the
                  platform reported it — that would be checking the ledger
                  against itself.
     bank         driver_payout_day, the resolved day grain, so overlapping
                  report windows cannot count a week twice.

   A side that is missing is null, never 0. A month with work and no statement
   is a month the statement surface no longer reaches — Uber's earner-payments
   surface answers for the CURRENT payment period and returns an empty list for
   every older window, however it is asked — and printing 0 there would report
   the platform as having paid for trips it never reported on. expected_payout
   is therefore null whenever the on-trip net is null, and delta is null
   whenever either side is.

   ── the scope is the whole record, and it says so ────────────────────────
   This endpoint does not take a window and never did. That was fine until the
   page carrying it kept the dashboard's range selector on screen, so the
   operator read "Last 30 days" above a TRIPS tile counting every trip the
   fleet has ever taken and a table running from Aug 2025 to Aug 2026. The
   answer was right and the label was a lie, which is worse than being wrong.

   Honouring the window instead would have been the other kind of wrong: the
   rows are MONTHS, and the months a thirty-day window touches are two partial
   ones. A reconciliation of six days of July against July's bank payout is
   exactly the mismatch of scopes this endpoint exists to prevent. So the scope
   is stated in the response — every month on record, with the span it covers —
   the page prints it where the range control used to sit, and the tiles and
   the table describe the same thing because they are computed from the same
   rows. */
import { personKey } from './custody_sql.js';

export function reconcileRoutes(app, { q, wrap, rollupGrainSql }) {
  const num = (v) => (v == null ? null : Number(v));
  const r2 = (v) => Math.round(v * 100) / 100;

  const NOTE = 'Bank payout ≈ on-trip net + tips + salik − cash collected: what the '
    + 'platform wires is what the fleet earned on-trip, plus tips and toll reimbursements, '
    + 'minus the cash its drivers already hold — proven to 0.7% on July 2026. The gap is '
    + 'measured over the driver-days BOTH sides describe, never over a whole month against '
    + 'a fraction of one.';

  app.get('/api/reconcile', wrap(async (req, res) => {
    const platform = req.query.platform || null;
    const fleet = req.query.fleet || null;
    const month = req.query.month ? String(req.query.month) : null;
    if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    /* Which slice of the rollup to read. The stored grains carry a '*'
       sentinel row per bucket meaning "every platform" / "every fleet",
       computed at that grain rather than summed from the others — so an
       unfiltered request reads the sentinel and a filtered one reads its
       platform's own row. */
    const grainWhere = `g.platform = coalesce($1, '*') AND g.fleet_id = coalesce($2, '*')`;
    const sideWhere = (a) => `($1::text IS NULL OR ${a}.platform = $1)`
      + ` AND ($2::text IS NULL OR ${a}.fleet_id = $2)`;

    /* The comparison, over (DRIVER, DAY) pairs present on both sides.
       ─────────────────────────────────────────────────────────────────────
       This was a whole-month statement against a whole-month bank payout, and
       a month whose statement held one week read as the platform overpaying by
       1,449%. Restricting the bank side to the DAYS the statement covers fixed
       the arithmetic and left the same fault one level down: on a covered day
       the statement names SOME of the fleet's drivers and the bank figure for
       that day names all of them. In August 2026 that compared AED 18,116 of
       on-trip net — fifty-three drivers — against AED 35,858 of bank money
       covering a hundred and eighty-nine, and reported a 153% gap. The money
       was fine. The two sides were answering about different people.

       So both halves are restricted to the pairs they share. The join key is
       personKey — the same fold /api/driver/* and the vehicle pages resolve
       people by — and not driver_ext_id, deliberately: src/rollup.js folds a
       person's several Uber accounts into ONE statement row and keeps one of
       their ids, so an id join would silently drop the other account's payouts
       and re-open the same gap wearing a different name.

       The bank side is narrowed to the statement's own (platform, day) pairs
       before the fold is computed, which is also what keeps this cheap: the
       statement surface reaches back about a week and driver_payout_day holds
       a year. */
    const coveredSql = (keyExpr, dayBound) => `
      WITH stmt AS (
        SELECT s.platform, ${personKey('s.driver_ext_id', 's.driver_name')} AS person, s.day,
               sum(s.net) + coalesce(sum(s.tips), 0) + coalesce(sum(s.salik), 0)
                 - coalesce(sum(s.cash), 0) AS expected
          FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')}${dayBound ? ` AND ${dayBound('s')}` : ''}
         GROUP BY 1, 2, 3
      ), bank AS (
        SELECT p.platform, ${personKey('p.driver_ext_id', 'p.driver_name')} AS person, p.day,
               sum(p.earnings) AS earnings
          FROM driver_payout_day p
         WHERE ${sideWhere('p')}${dayBound ? ` AND ${dayBound('p')}` : ''}
           AND EXISTS (SELECT 1 FROM stmt x WHERE x.platform = p.platform AND x.day = p.day)
         GROUP BY 1, 2, 3
      )
      SELECT ${keyExpr} AS k,
             round(sum(s.expected)::numeric, 2) AS expected_covered,
             round(sum(b.earnings) FILTER (WHERE s.person IS NOT NULL)::numeric, 2) AS bank_covered,
             count(*) FILTER (WHERE s.person IS NOT NULL)::int AS matched_pairs,
             count(DISTINCT s.person)::int AS matched_drivers,
             count(DISTINCT b.day) FILTER (WHERE s.person IS NOT NULL)::int AS matched_days,
             /* The denominator the reader needs to size the answer: how many
                people the BANK side carried on those same days. "Compared over
                53 of 189 drivers" is the whole explanation of a gap that would
                otherwise look like missing money. */
             count(DISTINCT b.person)::int AS bank_drivers
        FROM bank b LEFT JOIN stmt s USING (platform, person, day)
       GROUP BY 1`;

    let tripRows; let stmtRows; let payRows; let covRows; let keyName; let calendar;
    let tripsSource = 'rollup';

    if (!month) {
      keyName = 'm';
      /* From the precomputed rollup when it exists, and from the same grain
         SQL it is built from when it does not — a fresh database, a deploy
         ahead of the first collection. Same two-step, same reason, as
         /api/trend/monthly. */
      const tripSql = (from) => `
        SELECT to_char(g.month, 'YYYY-MM') AS m, g.bookings::int AS trips
        FROM ${from} g WHERE ${grainWhere}`;
      tripRows = await q(tripSql('rollup_month'), [platform, fleet]);
      if (!tripRows.length) {
        tripsSource = 'live';
        tripRows = await q(tripSql(`(${rollupGrainSql('month')})`), [platform, fleet]);
      }
      stmtRows = await q(
        `SELECT to_char(date_trunc('month', s.day), 'YYYY-MM') AS m,
                round(sum(s.net)::numeric, 2) AS ontrip_net,
                round(sum(s.tips)::numeric, 2) AS tips,
                round(sum(s.salik)::numeric, 2) AS salik,
                round(sum(s.cash)::numeric, 2) AS cash_collected,
                count(DISTINCT s.day)::int AS ontrip_days,
                count(DISTINCT ${personKey('s.driver_ext_id', 's.driver_name')})::int AS ontrip_drivers
         FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')}
         GROUP BY 1`, [platform, fleet]);
      payRows = await q(
        `SELECT to_char(date_trunc('month', p.day), 'YYYY-MM') AS m,
                round(sum(p.earnings)::numeric, 2) AS bank_payout,
                count(DISTINCT p.day)::int AS payout_days
         FROM driver_payout_day p
         WHERE ${sideWhere('p')}
         GROUP BY 1`, [platform, fleet]);
      covRows = await q(coveredSql(`to_char(date_trunc('month', b.day), 'YYYY-MM')`, null),
        [platform, fleet]);

      /* Every month from the first any side knows about to the last, so a
         month none of them covers is a visible row of dashes rather than a
         silent absence between two neighbours. */
      const keys = [...new Set([...tripRows, ...stmtRows, ...payRows].map((r) => r.m))].sort();
      calendar = [];
      if (keys.length) {
        let [y, mo] = keys[0].split('-').map(Number);
        const last = keys[keys.length - 1];
        for (;;) {
          const k = `${y}-${String(mo).padStart(2, '0')}`;
          calendar.push(k);
          if (k === last) break;
          mo += 1;
          if (mo > 12) { mo = 1; y += 1; }
        }
      }
    } else {
      keyName = 'd';
      const [y, mo] = month.split('-').map(Number);
      const daysIn = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const first = `${month}-01`;
      const lastDay = `${month}-${String(daysIn).padStart(2, '0')}`;
      const P = [platform, fleet, first, lastDay];
      const dayBound = (a) => `${a}.day BETWEEN $3::date AND $4::date`;
      const tripSql = (from) => `
        SELECT to_char(g.day, 'YYYY-MM-DD') AS d, g.bookings::int AS trips
        FROM ${from} g WHERE ${grainWhere} AND ${dayBound('g')}`;
      tripRows = await q(tripSql('rollup_day'), P);
      if (!tripRows.length) {
        tripsSource = 'live';
        tripRows = await q(tripSql(`(${rollupGrainSql('day')})`), P);
      }
      stmtRows = await q(
        `SELECT to_char(s.day, 'YYYY-MM-DD') AS d,
                round(sum(s.net)::numeric, 2) AS ontrip_net,
                round(sum(s.tips)::numeric, 2) AS tips,
                round(sum(s.salik)::numeric, 2) AS salik,
                round(sum(s.cash)::numeric, 2) AS cash_collected,
                1::int AS ontrip_days,
                count(DISTINCT ${personKey('s.driver_ext_id', 's.driver_name')})::int AS ontrip_drivers
         FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')} AND ${dayBound('s')}
         GROUP BY 1`, P);
      payRows = await q(
        `SELECT to_char(p.day, 'YYYY-MM-DD') AS d,
                round(sum(p.earnings)::numeric, 2) AS bank_payout,
                1::int AS payout_days
         FROM driver_payout_day p
         WHERE ${sideWhere('p')} AND ${dayBound('p')}
         GROUP BY 1`, P);
      /* The same pair join at day grain. The old code assumed a day needs no
         restriction — "the two sides cover the same day by construction" —
         which is true of the DAY and says nothing about the drivers on it, and
         that assumption is the whole of the 153% August. */
      covRows = await q(coveredSql(`to_char(b.day, 'YYYY-MM-DD')`, dayBound), P);
      /* The whole calendar month, so a day nothing covers is a row of dashes
         — but only when the month holds anything at all; a month no source
         has touched answers empty rather than thirty-one rows of nothing. */
      calendar = (tripRows.length || stmtRows.length || payRows.length)
        ? Array.from({ length: daysIn },
          (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
        : [];
    }

    const byKey = (rows) => new Map(rows.map((r) => [r[keyName], r]));
    const tripsBy = byKey(tripRows); const stmtBy = byKey(stmtRows); const payBy = byKey(payRows);
    const covBy = new Map(covRows.map((r) => [r.k, r]));

    const rows = calendar.map((k) => {
      const t = tripsBy.get(k); const s = stmtBy.get(k); const p = payBy.get(k);
      const c = covBy.get(k);
      const ontrip = num(s?.ontrip_net);
      const tips = num(s?.tips);
      const salik = num(s?.salik);
      const cash = num(s?.cash_collected);
      /* The identity. tips, salik and cash default to zero only once a
         statement exists at all — with no statement the whole expectation is
         unknowable, and unknowable must not print as zero. */
      const expected = ontrip == null ? null
        : r2(ontrip + (tips ?? 0) + (salik ?? 0) - (cash ?? 0));
      const bank = num(p?.bank_payout);
      const expectedCovered = num(c?.expected_covered);
      const bankCovered = num(c?.bank_covered);
      /* Delta compares LIKE WITH LIKE: the same people, on the same days, on
         both sides. The full month stays in the row — it is the real money —
         but a partial statement must read as a partial comparison, never as a
         discrepancy the fleet does not have. */
      const delta = expectedCovered == null || bankCovered == null
        ? null : r2(bankCovered - expectedCovered);
      const deltaPct = delta == null || !expectedCovered ? null
        : Math.round((delta / Math.abs(expectedCovered)) * 1000) / 10;
      return {
        [keyName]: k,
        platform: platform || '*',
        trips: t ? t.trips : null,
        ontrip_net: ontrip,
        tips,
        salik,
        cash_collected: cash,
        ontrip_days: s ? s.ontrip_days : 0,
        ontrip_drivers: s ? s.ontrip_drivers : 0,
        expected_payout: expected,
        bank_payout: bank,
        payout_days: p ? p.payout_days : 0,
        /* Both sides of what was actually compared, so the delta beside them
           can be checked by subtraction rather than believed. */
        expected_covered: expectedCovered,
        bank_covered: bankCovered,
        matched_pairs: c ? c.matched_pairs : 0,
        matched_drivers: c ? c.matched_drivers : 0,
        matched_days: c ? c.matched_days : 0,
        bank_drivers: c ? c.bank_drivers : 0,
        delta,
        delta_pct: deltaPct,
      };
    });

    const sumOf = (key) => {
      const xs = rows.map((r) => r[key]).filter((v) => v != null);
      return xs.length ? r2(xs.reduce((a, b) => a + b, 0)) : null;
    };
    const totals = {
      trips: sumOf('trips'),
      ontrip_net: sumOf('ontrip_net'),
      tips: sumOf('tips'),
      salik: sumOf('salik'),
      cash_collected: sumOf('cash_collected'),
      expected_payout: sumOf('expected_payout'),
      bank_payout: sumOf('bank_payout'),
      /* Beside the full sums, the two figures the identity was actually tested
         on — so a reader can see at a glance how much of the money the
         reconciliation covers, and the Gap tile beside them is the difference
         of exactly these two numbers rather than of the two above. */
      expected_covered: sumOf('expected_covered'),
      bank_covered: sumOf('bank_covered'),
      matched_pairs: rows.reduce((a, r) => a + (r.matched_pairs || 0), 0),
    };
    /* The headline gap is measured only where BOTH sides exist. Summing every
       bank payout against only the months that have a statement would report
       the statement surface's retention horizon as money the platform overpaid
       — a gap that is entirely ours. */
    const reconcilable = rows.filter((r) => r.delta != null);
    totals.reconciled_rows = reconcilable.length;
    totals.delta = reconcilable.length
      ? r2(reconcilable.reduce((a, r) => a + r.delta, 0)) : null;
    const recExpected = reconcilable.reduce((a, r) => a + r.expected_covered, 0);
    totals.delta_pct = totals.delta != null && recExpected
      ? Math.round((totals.delta / Math.abs(recExpected)) * 1000) / 10 : null;

    /* What every figure above is a figure ABOUT. Stated rather than implied,
       because the page used to imply a thirty-day window over these same
       all-time numbers. */
    const lastDayOf = (ym) => {
      const [y2, m2] = ym.split('-').map(Number);
      return `${ym}-${String(new Date(Date.UTC(y2, m2, 0)).getUTCDate()).padStart(2, '0')}`;
    };
    const scope = calendar.length
      ? {
        kind: month ? 'month' : 'all-time',
        label: month ? month : 'every month on record',
        from: month ? calendar[0] : `${calendar[0]}-01`,
        to: month ? calendar[calendar.length - 1] : lastDayOf(calendar[calendar.length - 1]),
        rows: calendar.length,
      }
      : { kind: month ? 'month' : 'all-time', label: month || 'every month on record',
        from: null, to: null, rows: 0 };

    res.json({
      grain: month ? 'day' : 'month',
      month: month || null,
      scope,
      trips_source: tripsSource,
      rows,
      totals,
      note: NOTE,
    });
  }));
}
