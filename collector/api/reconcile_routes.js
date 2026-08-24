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
   is a month the statement surface no longer reaches — Uber serves roughly the
   last six — and printing 0 there would report the platform as having paid for
   trips it never reported on. expected_payout is therefore null whenever the
   on-trip net is null, and delta is null whenever either side is. */
export function reconcileRoutes(app, { q, wrap, rollupGrainSql }) {
  const num = (v) => (v == null ? null : Number(v));
  const r2 = (v) => Math.round(v * 100) / 100;

  const NOTE = 'Bank payout ≈ on-trip net + tips + salik − cash collected: what the '
    + 'platform wires is what the fleet earned on-trip, plus tips and toll reimbursements, '
    + 'minus the cash its drivers already hold — proven to 0.7% on July 2026.';

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

    let tripRows; let stmtRows; let payRows; let keyName; let calendar;
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
                count(DISTINCT s.day)::int AS ontrip_days
         FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')}
         GROUP BY 1`, [platform, fleet]);
      payRows = await q(
        `SELECT to_char(date_trunc('month', p.day), 'YYYY-MM') AS m,
                round(sum(p.earnings)::numeric, 2) AS bank_payout,
                count(DISTINCT p.day)::int AS payout_days,
                /* The half of the bank money the identity can actually be
                   tested against: payouts on DAYS THE STATEMENT SIDE COVERS.
                   The statement surface reaches back a few weeks; the payout
                   record reaches back months. Compared whole-month against
                   whole-month, a month where the statement holds one week
                   read as the platform overpaying by 1,449% — the money was
                   fine, the two sides were answering about different days. */
                round(sum(p.earnings) FILTER (WHERE EXISTS (
                  SELECT 1 FROM driver_statement_day s2
                  WHERE s2.source <> 'ledger' AND s2.day = p.day
                    AND s2.platform = p.platform
                    AND ($1::text IS NULL OR s2.platform = $1)
                    AND ($2::text IS NULL OR s2.fleet_id = $2)
                ))::numeric, 2) AS bank_covered
         FROM driver_payout_day p
         WHERE ${sideWhere('p')}
         GROUP BY 1`, [platform, fleet]);

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
                1::int AS ontrip_days
         FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')} AND ${dayBound('s')}
         GROUP BY 1`, P);
      payRows = await q(
        `SELECT to_char(p.day, 'YYYY-MM-DD') AS d,
                round(sum(p.earnings)::numeric, 2) AS bank_payout,
                1::int AS payout_days,
                /* At day grain the two sides cover the same day by
                   construction, so covered IS the full figure. */
                round(sum(p.earnings)::numeric, 2) AS bank_covered
         FROM driver_payout_day p
         WHERE ${sideWhere('p')} AND ${dayBound('p')}
         GROUP BY 1`, P);
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

    const rows = calendar.map((k) => {
      const t = tripsBy.get(k); const s = stmtBy.get(k); const p = payBy.get(k);
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
      const bankCovered = num(p?.bank_covered);
      /* Delta compares LIKE WITH LIKE: the expected payout is built from the
         statement days, so it is tested against the bank money of those same
         days. The full bank figure stays in the row — it is the real month —
         but a coverage mismatch must read as "partially covered", never as a
         thousand-percent discrepancy. */
      const delta = expected == null || bankCovered == null ? null : r2(bankCovered - expected);
      const deltaPct = delta == null || !expected ? null
        : Math.round((delta / Math.abs(expected)) * 1000) / 10;
      return {
        [keyName]: k,
        platform: platform || '*',
        trips: t ? t.trips : null,
        ontrip_net: ontrip,
        tips,
        salik,
        cash_collected: cash,
        ontrip_days: s ? s.ontrip_days : 0,
        expected_payout: expected,
        bank_payout: bank,
        bank_covered: bankCovered,
        payout_days: p ? p.payout_days : 0,
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
      /* Beside the full bank total, the part of it the identity was actually
         tested against — so a reader can see at a glance how much of the
         money the reconciliation covers. */
      bank_covered: sumOf('bank_covered'),
    };
    /* The headline gap is measured only where BOTH sides exist. Summing every
       bank payout against only the months that have a statement would report
       the statement surface's retention horizon as money the platform overpaid
       — a gap that is entirely ours. */
    const reconcilable = rows.filter((r) => r.delta != null);
    totals.reconciled_rows = reconcilable.length;
    totals.delta = reconcilable.length
      ? r2(reconcilable.reduce((a, r) => a + r.delta, 0)) : null;
    const recExpected = reconcilable.reduce((a, r) => a + r.expected_payout, 0);
    totals.delta_pct = totals.delta != null && recExpected
      ? Math.round((totals.delta / Math.abs(recExpected)) * 1000) / 10 : null;

    res.json({
      grain: month ? 'day' : 'month',
      month: month || null,
      trips_source: tripsSource,
      rows,
      totals,
      note: NOTE,
    });
  }));
}
