/* ── a verdict that cannot be wrong because it never says anything ─────────
   The first one written read `r.value` for a channel's share, where /api/mix
   returns `n`. Every load computed a 0% leader, every load fell through to the
   branch that restates the totals, and the page looked perfectly fine: a
   sentence appeared, it was true, and it was the wrong one.

   Nothing in a rendered page distinguishes "the page concluded this" from "the
   page failed to conclude anything and printed the fallback". So the decision
   is a pure function and the branch is asserted here — against the SHAPES the
   endpoints really return, which is the half the bug lived in. */
import { fleetVerdict, driversVerdict, shareOf, revenueVerdict, platformMoney } from '../api/public/verdicts.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* The real production shape, taken from /api/mix?by=platform on 2026-08-27.
   `n`, not `value` — which is the whole point of this file. */
const MIX = [
  { label: 'uber', n: 11125, revenue: null },
  { label: 'hotel', n: 870, revenue: 66790 },
  { label: 'yango', n: 19, revenue: 649 },
];
const DAILY = (n, { uncollected = 0, partial = 0 } = {}) => Array.from({ length: n }, (_, i) => ({
  d: `2026-08-${String(i + 1).padStart(2, '0')}`, trips: 400,
  uncollected: i < uncollected,
  sources_silent: (i >= uncollected && i < uncollected + partial) ? 1 : 0,
}));

/* ── the bug, as a test ──────────────────────────────────────────────────── */
{
  const v = fleetVerdict({ kpis: { trips: 12014, cancel_pct: 10.9 }, daily: DAILY(30), byPlatform: MIX });
  check('a 92% channel is read off the field the endpoint actually sends',
    v.leadPct === 93 && v.lead.label === 'uber', `${v.leadPct}% ${v.lead?.label}`);
  check('and the page concludes it is single-channel, not the fallback',
    v.branch === 'single-channel', v.branch);
}
check('the share reader accepts every spelling the endpoints use',
  shareOf({ n: 5 }) === 5 && shareOf({ value: 5 }) === 5 && shareOf({ trips: 5 }) === 5
  && shareOf({}) === 0 && shareOf(null) === 0);

/* ── the ranking, which is the whole design ──────────────────────────────── */
/* A hole in the record makes every rate computed across it wrong, so it has to
   outrank the figures those rates produce — including a bad one. */
{
  const v = fleetVerdict({
    kpis: { trips: 12014, cancel_pct: 40 },      // would be 'cancellations' on its own
    daily: DAILY(30, { uncollected: 6 }), byPlatform: MIX,
  });
  check('a collection hole outranks even a terrible completion rate',
    v.branch === 'gap' && v.uncollected === 6, `${v.branch} ${v.uncollected}`);
  check('and is toned as the worst thing on the page', v.tone === 'bad', String(v.tone));
}
{
  const v = fleetVerdict({ kpis: { trips: 100, cancel_pct: 22 }, daily: DAILY(7), byPlatform: MIX });
  check('with a clean record, a cancellation spike is the headline',
    v.branch === 'cancellations' && v.tone === 'warn', v.branch);
}
{
  const even = [{ label: 'uber', n: 500 }, { label: 'bolt', n: 400 }, { label: 'yango', n: 100 }];
  const v = fleetVerdict({ kpis: { trips: 1000, cancel_pct: 5 }, daily: DAILY(7), byPlatform: even });
  /* uber 50%, bolt 40%, yango 10% — bolt and yango both clear the tenth, so
     `others` is 2 and the page says "3 channels that matter". */
  check('a genuinely mixed fleet is not called single-channel',
    v.branch === 'multi-channel' && v.others === 2, `${v.branch} others=${v.others}`);
  /* Yango is 10% exactly — at the boundary, and it counts. Below it a channel
     is rounding, not a channel. */
  const v2 = fleetVerdict({ kpis: { trips: 1000 }, daily: DAILY(7),
    byPlatform: [{ label: 'uber', n: 500 }, { label: 'bolt', n: 400 }, { label: 'yango', n: 99 }] });
  /* Same three with yango at 99 of 999 — a hair under the tenth, so it drops
     out and only bolt is left beside the leader. */
  check('and a channel below a tenth of the work is rounding, not a channel',
    v2.others === 1, `others=${v2.others}`);
}
{
  const v = fleetVerdict({ kpis: { trips: 900, cancel_pct: 4 }, daily: DAILY(30, { partial: 3 }), byPlatform: MIX });
  check('a partially-silent day is counted but is not a missing day',
    v.partial === 3 && v.uncollected === 0 && v.branch !== 'gap', `${v.partial}/${v.uncollected}`);
  check('and the per-day figure divides by the days the window actually holds',
    v.perDay === 30, String(v.perDay));
}
/* An empty window must not divide by zero and must not claim a leader. */
{
  const v = fleetVerdict({ kpis: {}, daily: [], byPlatform: [] });
  check('an empty window concludes nothing rather than dividing by zero',
    v.perDay === 0 && v.leadPct === 0 && v.branch === 'plain', JSON.stringify(v));
}

/* ── drivers ─────────────────────────────────────────────────────────────── */
const person = (o = {}) => ({ driver_ext_id: 'x', platform_state: '', ...o });
{
  const rows = Array.from({ length: 100 }, () => person());
  const v = driversVerdict({ rows, expired: rows.slice(0, 3), idle: rows.slice(0, 10), never: [] });
  check('an expired licence outranks an idle roster — one is illegal, one is slack',
    v.branch === 'expired' && v.tone === 'bad', v.branch);
}
{
  const rows = Array.from({ length: 100 }, (_, i) =>
    person({ platform_state: i < 24 ? 'SUSPENDED' : 'ACTIVE' }));
  const v = driversVerdict({ rows, expired: [], idle: rows.slice(0, 40), never: rows.slice(40, 60) });
  check('a majority not earning is the headline',
    v.branch === 'idle' && v.idlePct === 60, `${v.branch} ${v.idlePct}%`);
  check('and the ones the platform has blocked are counted separately',
    v.blocked === 24, String(v.blocked));
  check('active is the total less those not earning, not a fourth count',
    v.active === 40, String(v.active));
}
{
  const rows = Array.from({ length: 10 }, () => person());
  const v = driversVerdict({ rows, expired: [], idle: rows.slice(0, 2), never: [] });
  check('a working roster gets no tone — nothing needs doing',
    v.branch === 'working' && v.tone === null, v.branch);
}
check('an empty roster does not divide by zero',
  driversVerdict({}).idlePct === 0 && driversVerdict({}).total === 0);

/* ── revenue: the third field-name bug of this shape ─────────────────────
   There is no `accounted` field on a platform row. The first draft tested it,
   found it falsy on every channel, and shipped "Uber and Hotel and Yango
   report work and no money" over a window in which all three reported money.
   The real production shape, /api/revenue on 2026-08-27 — money is `fares`
   (on the trip) or `payouts`/`statement_net` (weekly, net of commission). */
const REV = [
  { platform: 'uber', bookings: 11178, fares: null, payouts: 382815.97 },
  { platform: 'hotel', bookings: 871, fares: 66619.98, payouts: null },
  { platform: 'yango', bookings: 19, fares: 1296, payouts: 5472.43 },
  { platform: 'bolt', bookings: 0, fares: null, payouts: null },
];
{
  const v = revenueVerdict({ platforms: REV, totals: { bookings: 12068 } });
  check('a channel paid weekly is not a channel with no money',
    v.dark.length === 0, JSON.stringify(v.dark.map((r) => r.platform)));
  check('but a channel with no fare ON THE TRIP is called out — that is the '
    + 'fact that makes every per-booking rate read low',
    v.branch === 'payout-only' && v.payoutOnly.map((r) => r.platform).join() === 'uber',
    `${v.branch} ${v.payoutOnly.map((r) => r.platform).join()}`);
  check('a channel with no bookings at all is not in the population',
    !v.live.some((r) => r.platform === 'bolt'), v.live.map((r) => r.platform).join());
  check('and the leader is read off bookings, not off money',
    v.lead.platform === 'uber' && v.leadPct === 93, `${v.lead?.platform} ${v.leadPct}%`);
}
{
  const v = revenueVerdict({ platforms: [{ platform: 'bolt', bookings: 500 }], totals: { bookings: 500 } });
  check('a channel with bookings and nothing anywhere IS dark',
    v.branch === 'dark' && v.darkBookings === 500 && v.tone === 'bad', v.branch);
}
{
  const v = revenueVerdict({ platforms: [{ platform: 'hotel', bookings: 10, fares: 900 }], totals: {} });
  check('and a fully priced channel needs no warning at all',
    v.branch === 'priced' && v.tone === null, v.branch);
}
check('statement_net counts as money even with no fare and no payout',
  platformMoney({ statement_net: 5 }) === 5 && platformMoney({}) === 0 && platformMoney(null) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
