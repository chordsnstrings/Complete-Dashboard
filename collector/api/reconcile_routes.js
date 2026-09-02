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
import { personKeyStored } from './custody_sql.js';

import { dubaiDay } from './window.js';

export function reconcileRoutes(app, { q, wrap, rollupGrainSql }) {
  const num = (v) => (v == null ? null : Number(v));
  const r2 = (v) => Math.round(v * 100) / 100;

  /* Why the gap on Uber sits near 12-14% and is not a fault.
     ───────────────────────────────────────────────────────────────────────
     The two sides come from two different Uber answers, on purpose. The bank
     side is netOutstanding — what Uber says it owes. The expected side is
     rebuilt from the ITEMISED statement, so that it can disagree; an expected
     figure derived from netOutstanding would be netOutstanding, and the check
     would prove nothing.

     Measured live on 2026-08-26, Ecosine, the week of 6 July: netOutstanding
     52,793.48 against an itemised tree of 49,185.37. The residual, 3,608.11,
     is real money and it is not broken out — the supplier GraphQL breakdown
     returns exactly two trees, `your_earnings` and `payouts`, each of which
     equals its own children to the fils, and no third field exists (fifteen
     plausible names were probed; the server rejected every one, and
     introspection is disabled).

     What the residual IS was settled on the other surface. For the week of
     17 August the residual was 4,553.91, while the OAuth REST feed — which
     does itemise, and covered 29% of the same drivers that week — reported
     1,295.96 of reimbursements and expenses, which scales to about 4,434.
     So the residual is the reimbursement bucket: Salik, Sharjah surcharge,
     airport fees, less expenses.

     The consequence is a floor under the gap, not a bug: on months served
     only by GraphQL, `salik` is null and the reimbursements are invisible to
     the itemised side while the bank side already contains them. That is
     stated here rather than corrected, because correcting it would mean
     deriving the expected figure from the number it is meant to test. */
  const NOTE = 'Bank payout ≈ on-trip net + tips + salik − cash collected: what the '
    + 'platform wires is what the fleet earned on-trip, plus tips and toll reimbursements, '
    + 'minus the cash its drivers already hold — proven to 0.7% on July 2026. The gap is '
    + 'measured over the driver-days BOTH sides describe, never over a whole month against '
    + 'a fraction of one. On Uber it also has a floor: the expected side is rebuilt from the '
    + 'itemised statement so that it can disagree with the payout, and Uber’s supplier '
    + 'breakdown does not itemise the reimbursements — Salik, surcharges, airport fees — that '
    + 'the payout already contains. Measured against the surface that does itemise them, that '
    + 'accounts for most of the 12–14% Uber gap; a month whose salik column is empty is a month '
    + 'where none of it could be seen.';

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
       a year.

       personKeyStored, not personKey: the fold is two nested regexes, one with
       a backreference, and computing it per row is what sql/schema_v20.sql
       stored the trip column to stop doing. Both money tables carry the same
       generated column since sql/schema_v51.sql — added because the slow-query
       log measured this query at 5.0-5.7s and the monthly statement fold below
       at 2.6-3.2s, on two tables of a few tens of thousands of rows. The answer
       is identical by construction; test/person_key.test.mjs holds all four
       copies of the expression to the JS one. */
    const coveredSql = (keyExpr, dayBound) => `
      WITH stmt AS (
        SELECT s.platform, ${personKeyStored('s')} AS person, s.day,
               sum(s.net) + coalesce(sum(s.tips), 0) + coalesce(sum(s.salik), 0)
                 - coalesce(sum(s.cash), 0) AS expected
          FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')}${dayBound ? ` AND ${dayBound('s')}` : ''}
         GROUP BY 1, 2, 3
      /* The days a statement covers, folded ONCE.
         ─────────────────────────────────────────────────────────────────
         The bank side below used to say
             AND EXISTS (SELECT 1 FROM stmt x
                          WHERE x.platform = p.platform AND x.day = p.day)
         — a correlated EXISTS against a CTE, which carries no index, so
         Postgres re-scanned the whole statement fold once per payout row.
         Measured on production: /api/reconcile answered in 10.0s cold on
         every window, because the endpoint is all-time whatever the range is,
         and bin/render-audit.mjs escalated it from "slow-panel" to
         "blank-page — no kpi, table, chart or panel" when the page's own
         settle window expired first.

         The same rows, as a semi-join over the distinct pairs. DISTINCT is
         what makes it a semi-join rather than a fan-out: without it a day
         carrying forty statement rows would multiply every payout row on it
         by forty and the covered totals would be forty times too large. */
      ), stmt_days AS (
        SELECT DISTINCT platform, day FROM stmt
      ), bank AS (
        SELECT p.platform, ${personKeyStored('p')} AS person, p.day,
               sum(p.earnings) AS earnings
          FROM driver_payout_day p
          JOIN stmt_days d ON d.platform = p.platform AND d.day = p.day
         WHERE ${sideWhere('p')}${dayBound ? ` AND ${dayBound('p')}` : ''}
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
                count(DISTINCT ${personKeyStored('s')})::int AS ontrip_drivers
         FROM driver_statement_day s
         WHERE s.source <> 'ledger' AND ${sideWhere('s')}
         GROUP BY 1`, [platform, fleet]);
      payRows = await q(
        /* How much of the month has not happened yet.
           ─────────────────────────────────────────────────────────────────
           Uber's payout periods are weekly and driver_payout_day spreads a
           period evenly across ITS days, so an open week writes rows for days
           still in the future. The DAY grain already excludes them — see
           `accrual` below — and the MONTH grain never did, because the guard
           tested keyName. Measured on production: September's month row showed
           a bank payout of AED 54,227 while the day view of the same month
           totalled 27,830, because AED 26,398 of it sits on 3–6 September.
           Clicking the row halved every figure and nothing said why.

           A month is not simply an accrual — September holds real money too —
           so the accrued part is carried separately rather than the whole row
           being dropped. */
        `SELECT to_char(date_trunc('month', p.day), 'YYYY-MM') AS m,
                round(sum(p.earnings)::numeric, 2) AS bank_payout,
                round(sum(p.earnings) FILTER (WHERE p.day > $3::date)::numeric, 2) AS bank_accrued,
                count(*) FILTER (WHERE p.day > $3::date)::int AS accrual_days,
                count(DISTINCT p.day)::int AS payout_days
         FROM driver_payout_day p
         WHERE ${sideWhere('p')}
         GROUP BY 1`, [platform, fleet, dubaiDay(new Date())]);
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
                count(DISTINCT ${personKeyStored('s')})::int AS ontrip_drivers
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

    /* Dubai's calendar day, not the server's. Everything on this page is a
       Dubai date, and a UTC "today" would let the last four hours of a Dubai
       day be classed as the future. */
    const TODAY = dubaiDay(new Date());
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
      /* A percentage needs a base worth dividing by, and this one had neither
         sign nor size guard. On 2026-08-17 and 08-18 production returned
         {expected_covered: -9.91, bank_covered: 5820.67, delta: 5830.58,
         delta_pct: 58835.3} — a ratio against a base that is negative and a
         thousandth the size of the number above it. 58,835% is not a
         reconciliation result, it is a division by nearly nothing, and it sat
         in a column of honest single-digit percentages.

         Two guards: the base must be positive (a negative expectation means
         the statement's deductions exceeded its earnings for the drivers we
         could match, and a ratio to that has no reading), and it must be at
         least 1% of the figure it is being compared with, below which the
         percentage describes the base's noise rather than the gap. */
      const usableBase = expectedCovered != null && expectedCovered > 0
        && (bankCovered == null || Math.abs(expectedCovered) >= Math.abs(bankCovered) * 0.01);
      const deltaPct = delta == null || !usableBase ? null
        : Math.round((delta / expectedCovered) * 1000) / 10;
      return {
        [keyName]: k,
        platform: platform || '*',
        /* True where the row is a day that has not happened yet. Uber's payout
           periods are weekly and driver_payout_day spreads a period evenly
           across ITS days, so a period running to the 30th writes rows for the
           26th through the 30th on the 25th. Production published five of them
           as reconciled fact, byte-identical to the 25th except trips:null —
           ontrip_net 1745.11, bank_payout 2463.55, delta_pct 11.2,
           matched_pairs 50 — and they inflated every month tile. They are an
           accrual, they are real, and they are not a measurement. */
        accrual: keyName === 'd' && k > TODAY,
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
        /* At month grain, the slice of bank_payout that is a forward
           projection of an open payout period rather than money already
           wired. Null at day grain, where `accrual` above answers it. */
        bank_accrued: keyName === 'm' ? num(p?.bank_accrued) : null,
        accrual_days: keyName === 'm' ? (p?.accrual_days || 0) : null,
        /* Both sides of what was actually compared, so the delta beside them
           can be checked by subtraction rather than believed. */
        expected_covered: expectedCovered,
        bank_covered: bankCovered,
        matched_pairs: c ? c.matched_pairs : 0,
        matched_drivers: c ? c.matched_drivers : 0,
        matched_days: c ? c.matched_days : 0,
        bank_drivers: c ? c.bank_drivers : 0,
        /* A day that has not happened cannot have a discrepancy: both sides of
           it are the same forward projection of one payout period. */
        delta: keyName === 'd' && k > TODAY ? null : delta,
        delta_pct: keyName === 'd' && k > TODAY ? null : deltaPct,
      };
    });

    /* Tiles are over what has happened. An accrued row's money is genuine and
       stays in its row; adding it to a month total would report five days of
       Uber's forward projection as five days the fleet worked. */
    const settled = rows.filter((r) => !r.accrual);
    const sumOf = (key) => {
      const xs = settled.map((r) => r[key]).filter((v) => v != null);
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
    const reconcilable = settled.filter((r) => r.delta != null);
    totals.reconciled_rows = reconcilable.length;
    /* Named so the page can say "five days of accrued payout are shown but not
       counted" rather than leaving a reader to notice that the rows and the
       tiles disagree. */
    totals.accrual_rows = rows.length - settled.length;
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
