/* ACTUAL EARNINGS — what the tile after Platform earnings is allowed to say.
   ══════════════════════════════════════════════════════════════════════════
   The operator, 2026-11-16, over a screenshot of a driver's Earnings row:
   "also add another modal for actual earning just after platform share as
   well." api/public/actualearnings.js carries the definition and the reasons
   for it; this file holds the five claims that definition makes, each of
   which is easy to break without noticing:

     1. IT IS NOT A RE-LABELLED PLATFORM EARNINGS. Platform earnings is
        driver_payout_day — for Uber the bank transfer, after the cash already
        taken. The tile reads day_money (driver_day.money), the figure the
        Overview prints as Money in, and must print THAT even when a payout
        figure sits in the same response.
     2. IT IS THE PAGE'S EXISTING FIGURE, NOT A NEW ONE: the same value Money
        in prints, from the same field.
     3. ITS PARTS ARE SAID: statement net after commission, priced bookings
        before it, cash in hand included, the statements' tips not.
     4. A FLOOR ONLY WHERE MONEY IS MISSING BY CONSTRUCTION. moneyInTile's
        trips > priced_trips rule would print "at least" and "a floor rather
        than the total" on a driver whose every unpriced booking sits inside an
        Uber statement or was never completed — production driver 1 of October
        2026, measured: 30 unpriced of 502, 43 not completed, the statement on
        31 of 31 days, dark_bookings 0. The gate is unpriced_unstated (since
        the Money in fix of 2026-11-16), with dark_bookings as the fallback.
     5. ABSENT WITH THE TRUE REASON, NEVER NOUGHT — and a nought the platforms
        published stays a number.

   The payloads are /api/driver/kpis as production answered it on 2026-11-16
   for from=2026-10-01&to=2026-10-31 (driver 1 of the three measured in the
   module's header), with fields varied one at a time for the other branches.
   Synthetic otherwise: no name, no id. */
import { readFileSync } from 'node:fs';
import { actualEarningsTile } from '../api/public/actualearnings.js';
import { moneyInTile } from '../api/public/ui.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const OCT = {
  trips: 502, bookings: 502, priced_trips: 472, completed: 459, not_completed: 43, days_worked: 31,
  revenue: '28184.56', reported_earnings: '18177.30', reported_payouts: 18177.3,
  reported_payout_platforms: ['uber'], accounted: 21699.82, dark_bookings: 0,
  day_money: 21699.83, day_money_days: 31, day_money_period_days: 7, day_money_source: 'mixed',
  day_stmt_net: 20951.83, day_cash: 3945.01, day_stmt_tips: 178.8, day_stmt_days: 31,
  window_days: 31,
};
const W = { worked: true, bookingsN: 502 };

console.log('\n1 · not a re-labelled Platform earnings');
{
  /* REVERSION: read `money(k.reported_earnings)` for the value and this reads
     AED 18,177.30 — the bank transfer under the word "actual". */
  const t = actualEarningsTile(OCT, W);
  check('the value is day_money, not the payout beside it', t.value === 'AED 21,699.83', t.value);
  check('…and the label is the one the operator asked for, with a handle for tests',
    t.label === 'Actual earnings' && t.key === 'actual-earnings', JSON.stringify([t.label, t.key]));
  check('the sub-line names Platform earnings as the payout report and refuses the sum',
    /Platform earnings is the payout report, for Uber the bank transfer after the cash already taken, so the two are not added/.test(t.sub), t.sub);
  /* A payout report from a channel that is not Uber is not claimed to be a
     bank transfer: nothing here has measured what Yango's payout is net of. */
  const y = actualEarningsTile({ ...OCT, reported_payout_platforms: ['yango'] }, W);
  check('a payout from another channel is only "a different record"',
    /Platform earnings is the payout report, a different record/.test(y.sub) && !/bank transfer/.test(y.sub), y.sub);
}

console.log('\n2 · the page\'s existing figure');
{
  /* With every booking priced, moneyInTile has no floor to add, so the two
     tiles must print one value. REVERSION: read k.accounted instead (21,699.82)
     and the two disagree by a fil — a competing definition. */
  const k = { ...OCT, priced_trips: OCT.trips };
  check('the same value Money in prints on the Overview',
    actualEarningsTile(k, W).value === moneyInTile(k).value,
    `${actualEarningsTile(k, W).value} vs ${moneyInTile(k).value}`);
  check('…and the sub-line says so', /It is Money in on the Overview, the same figure/.test(actualEarningsTile(k, W).sub));
}

console.log('\n3 · its parts are said');
{
  const s = actualEarningsTile(OCT, W).sub;
  check('statement half after commission, with its amount',
    /AED 20,951\.83 from the platform statements, after their commission/.test(s), s);
  check('priced half before commission, with its amount (21,699.83 − 20,951.83)',
    /AED 748\.00 priced on bookings no statement covers, before any/.test(s), s);
  check('cash in hand is included, not netted off', /the driver\u2019s cash in hand included, not netted off/.test(s), s);
  check('the statements\' tips are not in it', /the statements’ tips not/.test(s), s);
  check('the weekly grain is named, in Money in\'s words', /filed every 7 days and shared evenly across them/.test(s), s);
  /* No statement at all: every dirham is a booking's price, and no tip claim
     is made, because nothing measured whether a priced fare carries one. */
  const p = actualEarningsTile({ ...OCT, day_stmt_net: null, day_money: 420, day_money_period_days: 1,
    window_days: 7, day_stmt_days: 0 }, W);
  check('priced only: before any commission, no statement covers these dates, no tip claim',
    p.value === 'AED 420.00' && /all of it priced on the bookings themselves, before any commission — no platform statement covers these dates/.test(p.sub)
      && !/tips/.test(p.sub), JSON.stringify(p));
  const n = actualEarningsTile({ ...OCT, day_money: OCT.day_stmt_net }, W);
  check('statement only: all of it after commission, no priced half invented',
    /all of it from the platform statements, after their commission/.test(n.sub) && !/priced on bookings/.test(n.sub), n.sub);
}

console.log('\n4 · a floor only where money is missing by construction');
{
  /* REVERSION: gate on `k.trips > k.priced_trips`, as moneyInTile does, and
     production driver 1 reads "at least" with a false reason. */
  const t = actualEarningsTile(OCT, W);
  check('30 unpriced bookings inside a full statement are not a floor',
    !/at least/.test(t.value) && !/floor/.test(t.sub) && t.tone == null, JSON.stringify([t.value, t.tone]));
  /* The gate is now /api/driver/kpis `unpriced_unstated` — completed bookings
     with no fare that no statement covers — the same count Money in uses, so
     the two tiles (one figure) cannot disagree about whether it is a floor
     (test/money_in_floor.test.mjs). dark_bookings is the fallback for a
     response from before that field, and both are tested here. */
  const d = actualEarningsTile({ ...OCT, unpriced_unstated: 3 }, W);
  check('3 completed bookings no statement or fare reports: "at least", and the reason leads',
    d.value === 'at least AED 21,699.83' && /^3 completed bookings with no fare that any statement or booking reports are not in it, so this is a floor\. What the work earned/.test(d.sub),
    JSON.stringify([d.value, d.sub.slice(0, 140)]));
  check('…one booking reads in the singular', /^1 completed booking with no fare that any statement or booking reports is not in it/.test(
    actualEarningsTile({ ...OCT, unpriced_unstated: 1 }, W).sub));
  check('…an older response without the field falls back to dark_bookings',
    /^at least/.test(actualEarningsTile({ ...OCT, dark_bookings: 2 }, W).value));
  check('…and the field, where present, wins over dark_bookings',
    !/at least/.test(actualEarningsTile({ ...OCT, dark_bookings: 2, unpriced_unstated: 0 }, W).value));
  /* The statements reaching fewer days than the window: a week not filed yet,
     or an account begun mid-window. True by the definition of driver_day.money
     whatever the cause, so the sentence names no cause. */
  const r = actualEarningsTile({ ...OCT, day_stmt_days: 27 }, W);
  check('statements on 27 of 31 days: the other days count only a booking\'s own fare',
    /The statements reach 27 of the window's 31 days; on the others only a booking’s own fare counts\./.test(r.sub), r.sub);
  check('…and silent where they reach every day', !/The statements reach/.test(t.sub), t.sub);
}

console.log('\n5 · absent with the true reason, never nought');
{
  /* REVERSION: `value: money(p.gross || 0)` in the absent branch and this
     driver reads AED 0.00 for work nobody valued. */
  const a = actualEarningsTile({ ...OCT, day_money: null, day_stmt_net: null, day_cash: null }, { worked: true, bookingsN: 9 });
  check('worked, nothing valued: a dash, never AED 0', a.value === '—' && !/AED 0/.test(a.value), a.value);
  check('…with the reason, and the payout beside it named as not the earnings',
    /^no platform statement and no priced booking covers this window, so what their 9 bookings earned is not measured — the AED 18,177\.30 under Platform earnings is the payout report, for Uber the bank transfer after the cash already taken, and not what the work earned$/.test(a.sub), a.sub);
  const b = actualEarningsTile({ window_days: 16 }, { worked: false });
  check('did not work, nothing reported: the wider fact, no payout clause',
    b.value === '—' && b.sub === 'no booking of any kind in this window and no platform statement covering it, so there are no earnings to measure', JSON.stringify(b));
  /* Production's e3cd308b… shape (test/driver_empty_window_page.test.mjs):
     Uber filed 0.00 statements for 13 of 16 days. A figure, not an absence. */
  const z = actualEarningsTile({ window_days: 16, day_money: 0, day_money_days: 13, day_money_period_days: 7,
    day_stmt_net: 0, day_stmt_days: 13 }, { worked: false });
  check('a nought the platforms published stays a number, and says it was published',
    z.value === 'AED 0.00' && /published/.test(z.sub) && /13 days/.test(z.sub) && z.key === 'actual-earnings', JSON.stringify(z));
}

console.log('\n6 · on the Earnings tab, directly after Platform earnings');
{
  /* The browser half is test/arkiv_people.test.mjs (both skins). This holds
     the source order, so a reshuffle of EARN_TILES fails here first.
     REVERSION: delete the actualEarningsTile(...) line from driver.js. */
  const src = readFileSync(new URL('../api/public/driver.js', import.meta.url), 'utf8');
  const a = src.indexOf("{ label: 'Platform earnings'");
  const b = src.indexOf('actualEarningsTile(k, { worked, bookingsN })');
  const c = src.indexOf("{ label: 'Tips'");
  check('EARN_TILES: Platform earnings, then Actual earnings, then Tips', a > 0 && b > a && c > b, JSON.stringify([a, b, c]));
  check('the tab\'s "no money figure" banner counts day_money too', /moneyMeasured = [^;]*k\.day_money != null/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
