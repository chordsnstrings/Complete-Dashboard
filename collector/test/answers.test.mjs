/* ANS — each page's answer line and Act-on strip (api/public/answers.js, the
   rules; api/public/answerline.js, the box).
   ═════════════════════════════════════════════════════════════════════════
   The second half of FOCUS (HANDOFF 0.9; docs/AUDIT.md "Verbosity"): every
   main page opens with ONE line answering its own question, computed from the
   data the page already fetched, with its basis, and up to three concrete
   actions, each a link to where the action happens. What this file holds:

   1. THE RULES, one fixture per page, the sentence pinned where the wording
      is the operator's to review (FIX-STATUS ANS) — and every ABSENT case,
      each with its TRUE reason: the server's own `why` where it sent one, the
      page's own failure sentence where the call failed, never a zero for an
      unknown (an unread figure is absent, not "AED 0.00 behind").
   2. THE GUARD: a sentence carrying NaN / undefined / null is refused and the
      answer drawn absent; a rule that throws is drawn absent with the error;
      never more than three actions.
   3. THE WIRING, read from the source: each page calls its hook where its data
      is in hand; render() empties the box on every navigation; the two modules
      on the phone's static import graph load answers.js only when used; and
      neither module can issue a request (no fetch, api, q…, import() in them).
   4. IN CHROMIUM, on mockapi's synthetic data (serviceWorkers blocked,
      Asia/Dubai): on every page with a rule (the fourteen main pages and four
      more) at 1280 under Arkiv the box sits
      between the title block and #view — never inside #view, whose first
      child the page contract pins — with a line, a basis, and at most three
      actions whose addresses are real routes; light AND dark keep every text
      in it at AA contrast against what it sits on; at 390 the box never
      widens the page and every action is at least 44px tall; an in-page action
      scrolls to its panel; a navigation clears the box; the Classic skin never
      builds it.

   Revert proofs (FIX-STATUS ANS): clearAnswer() out of render() → §4
   "navigating away clears it" fails; the payouts hook out → §4 payouts fails
   and §3 fails; the BAD guard out of answerFor → §2 fails; the 44px floor out
   of arkiv.css → §4 "at 390" fails. Each file restored byte for byte. */
import { readFileSync } from 'node:fs';
import { answerFor, RULES, winPhrase, scopeWords, num } from '../api/public/answers.js';
import { ACTS_MAX } from '../api/public/answerline.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const H = (...a) => `#${a.filter(Boolean).join('/')}`;
const ctx = { win: 'This month', href: H, now: new Date('2026-11-12T08:00:00Z') };
const run = (page, data, c = ctx) => answerFor(page, data, c);
const J = (x) => JSON.stringify(x);

console.log('1 · the rules, page by page — the answer, and every absent case with its true reason');

/* ── #target ── */
{
  const t = { month_name: 'November', summary: { ahead: -187059.48, under: 20, unsettled: 0, today_needs: 83481.88 },
    days: [...Array(21).fill({ state: 'past' }), { state: 'today' }],
    yesterday: { verdict: 'under', diff: -4000, day: '2026-11-11', label: 'Wed 11', drove: 93, reached: 24, trips_min: 12 } };
  const h = { clock: '09:21', revenue: { ahead: -3283.99, estimate: true, this_hour: { label: '09:00–10:00', catch_up: 4948.2 } },
    trips: { ahead: -68, this_hour: { catch_up: 91 } } };
  const r = run('target', { t, h });
  check('#target: the month so far, the days under, what today asks',
    r.text === 'November so far: both fleets AED 187,059.48 behind plan in gross fares, 20 of 21 days under; today asks AED 83,481.88.', r.text);
  check('…acts: right now, this hour, yesterday — capped at three, each to where it is done',
    r.acts.length === 3 && r.acts[0].to === 'tp-today' && /≈ AED 3,283.99 and 68 trips behind the usual day at 09:21/.test(r.acts[0].text)
      && r.acts[1].to === 'tp-rev' && /AED 4,948.20 and 91 trips/.test(r.acts[1].text) && r.acts[2].href === '#day/2026-11-11', J(r.acts));
  check('…states its basis', /^Basis: /.test(r.basis) && /gross fares before platform commission/.test(r.basis), r.basis);
  check('#target: the call failed → absent, with the page’s own sentence',
    run('target', { t: { _err: new Error('HTTP 502') } }).absent === 'The month could not be read: HTTP 502.');
  check('#target: no target set → absent with the server’s own why',
    run('target', { t: { month_name: 'December', why: 'No target was set for December 2026.', days: [] } }).absent === 'No target was set for December 2026.');
  check('#target: the plan to date unread → absent, never "AED 0.00 behind"',
    /could not be read/.test(run('target', { t: { month_name: 'November', summary: { ahead: null }, days: [{ state: 'past' }] } }).absent || ''));
  const met = run('target', { t: { month_name: 'November', summary: { met: true, earned: 1800000, month_target: 1750000 }, days: [{ state: 'past' }] } });
  check('#target: a month already met says so, and asks for nothing', /target is met: AED 1,800,000.00 earned against AED 1,750,000.00/.test(met.text) && !met.acts.length, J(met));
}

/* ── #overview ── */
{
  const k = { trips: 17965, cancel_pct: 4 };
  const daily = Array.from({ length: 22 }, () => ({ trips: 817 }));
  const byPlat = [{ label: 'uber', n: 16528 }, { label: 'bolt', n: 1000 }, { label: 'yango', n: 437 }];
  const cmp = { change_pct: { trips: -1.8 }, previous: { from: '2026-09-09', to: '2026-09-30' } };
  const r = run('overview', { k, daily, byPlat, cmp });
  check('#overview: bookings, a day, against the span before, the leading channel',
    r.text === '17,965 bookings this month, 817 a day: 1.8% fewer than 9 Sep 2026 – 30 Sep 2026. Uber is 92% of the work.', r.text);
  check('…every channel, both fleets, in the basis', /every channel, both fleets/.test(r.basis), r.basis);
  const f = run('overview', { k, daily, byPlat, cmp: null }, { ...ctx, platform: 'uber' });
  check('…under a channel chip: no "Uber is 100% of the work", and the basis names the chip',
    !/of the work/.test(f.text) && /Uber only/.test(f.basis), `${f.text} | ${f.basis}`);
  const gap = run('overview', { k, daily: [...daily.slice(2), { trips: null, uncollected: true }, { trips: null, uncollected: true }], byPlat });
  check('…uncollected days are an act, linked to the page that names the failing source',
    gap.acts.some((a) => /2 of 22 days were never collected/.test(a.text) && a.href === '#coverage'), J(gap.acts));
  check('#overview: no counts → absent', run('overview', {}).absent === 'The booking counts did not load.');
  check('#overview: a booking count that is not a number → absent, not "0 bookings"',
    /could not be read/.test(run('overview', { k: { trips: null } }).absent || ''));
}

/* ── #month-target ── */
{
  const v = { month_name: 'October', summary: { month_target: 1749239.6, days_left: 10, per_day_left: 75186.01 },
    days: [{ state: 'past' }, { state: 'today' }],
    trajectory: { avg: { month_end: 1472980.67, pct: 84.2 }, recent: { days: 7, per_day: 46668.83 } },
    drivers: { rows: [{ money_on: false, trips_on: false }, { money_on: true, trips_on: false }, { money_on: false, trips_on: true }] } };
  const r = run('month-target', v);
  check('#month-target: where the month lands at this pace',
    r.text === 'At the pace so far, October ends at AED 1,472,980.67 in gross fares: 84.2% of the AED 1,749,239.60 target.', r.text);
  check('…acts: behind on money, behind on trips, what each day left must bring — each to its panel',
    r.acts.length === 3 && r.acts.every((a) => a.href === '#month-target') && r.acts[0].to === 'mt-drivers' && r.acts[2].to === 'mt-path'
      && /2 of 3 active drivers are behind their money target/.test(r.acts[0].text), J(r.acts));
  check('#month-target: failed → absent', run('month-target', { _err: new Error('timeout') }).absent === 'The month could not be read: timeout.');
  check('#month-target: no summary → the server’s why', run('month-target', { month_name: 'May', why: 'No target for May.' }).absent === 'No target for May.');
  check('#month-target: target withheld → said as withheld, not as missing',
    run('month-target', { month_name: 'May', summary: { month_target: null }, _withheld: { REV: 'A' } }).absent === 'The month’s target is not shown to your role.');
  check('#month-target: nothing finished → no pace to carry (absent)',
    /no pace to carry/.test(run('month-target', { month_name: 'May', summary: { month_target: 5 }, days: [{ state: 'today' }], trajectory: {} }).absent || ''));
}

/* ── #drivers ── */
{
  const r = run('drivers', { total: 330, active: 115, idle: 139, never: 76, expired: 144, notFilled: 151, pendingPairs: 47 });
  check('#drivers: on the books, drove, did not, never have, expired',
    r.text === '330 drivers on the books: 115 drove this month, 139 did not and 76 never have; 144 hold an expired licence.', r.text);
  check('…acts: Compliance, the HR roster, the pairs awaiting review',
    J(r.acts.map((a) => a.href)) === J(['#compliance', '#hr-roster', '#same-person']), J(r.acts));
  check('#drivers: no directory → absent', run('drivers', {}).absent === 'The driver directory did not load.');
  check('#drivers: an empty directory → absent with why, not "0 drivers"', /holds nobody/.test(run('drivers', { total: 0 }).absent || ''));
  const clean = run('drivers', { total: 3, active: 3, idle: 0, never: 0 });
  check('…nothing fired → "none" says what was checked', !clean.acts.length && /^Nothing to act on: /.test(clean.none), J(clean));
}

/* ── #vehicles (counted with the cohorts the page's tiles use) ── */
{
  const rows = [
    { vin: 'A', trips: 5, last_fix: 1 }, { vin: 'B', trips: 0, telematics_journeys: 2, last_fix: 1 },
    { vin: 'C', trips: 0, telematics_journeys: 0, cab_days_moved: 0, last_fix: 1, stale: true }, { vin: 'D', trips: 3, doc_days_left: 5, last_fix: 1 },
    { vin: null, trips: 9 },
  ];
  const r = run('vehicles', { rows });
  check('#vehicles: earning of cars, moved without a booking, did not move',
    r.text === '2 of 4 cars took a booking this month; 1 moved without one and 1 did not move at all.', r.text);
  check('…acts go to the cohort lists, the same predicates as the tiles',
    J(r.acts.map((a) => a.href)) === J(['#cohort/vehicles-moved-no-booking', '#cohort/vehicles-still', '#cohort/vehicles-stale']), J(r.acts));
  check('#vehicles: not loaded → absent', run('vehicles', {}).absent === 'The vehicle directory did not load.');
  check('#vehicles: plates but no VIN → absent with the count of plates', /None of the 1 plate/.test(run('vehicles', { rows: [{ vin: null }] }).absent || ''));
}

/* ── #unauthorized ── */
{
  const sum = { totals: { segments: 16881, unauthorized: 699, unauth_km: 10591, needs_a_human: 221, unverifiable: 106 }, value: { forgone_aed: 48612.69 } };
  const r = run('unauthorized', { sum, vehicles: 83, stuck: 12, dead: 9 });
  check('#unauthorized: journeys with no booking, km, revenue forgone',
    r.text === '699 of 16,881 journeys examined this month had no booking behind them: 10,591 km, AED 48,612.69 revenue forgone.', r.text);
  check('…acts: the unverifiable journeys (the list of exactly those), the ranked cars, the seat sensors',
    r.acts.length === 3 && /^106 journeys could not be verified/.test(r.acts[0].text) && r.acts[0].href === '#segments/verdict/unverifiable'
      && r.acts[2].to === 'Seat-sensor health', J(r.acts));
  const nov = run('unauthorized', { sum: { totals: { segments: 10, unauthorized: 3, unauth_km: 20 }, value: { forgone_aed: null, basis: 'No fare rate is set.' } } });
  check('…no rate → revenue forgone named as not valued, with the server’s reason — never AED 0.00',
    /revenue forgone is not valued: No fare rate is set\.$/.test(nov.text) && !/AED 0\.00/.test(nov.text), nov.text);
  check('#unauthorized: no journey examined → absent', /No telematics journey was examined this month/.test(run('unauthorized', { sum: { totals: { segments: 0 } } }).absent || ''));
  check('#unauthorized: no summary → absent', run('unauthorized', {}).absent === 'The unauthorized-trip summary did not load.');
}

/* ── #payouts ── */
{
  const d = { scope: 'record', payouts: [{ amount: 100000 }, { amount: 11473840.01 }],
    coverage: [{ platform: 'uber', publishes_payouts: true }, { platform: 'yango', publishes_payouts: false }] };
  const rec = { totals: { rows: 2, comparable_rows: 1 },
    rows: [{ paid_on: '2026-10-19', delta: -110.75, delta_pct: -0.19 }, { paid_on: '2026-02-16', delta: 50000, delta_pct: 49.67 }] };
  const r = run('payouts', { d, rec });
  check('#payouts: what reached the bank, and the latest checked wire against our figure',
    r.text === `AED 11,573,840.01 has reached the bank in 2 transfers on record; the latest checked wire, ${new Date('2026-10-19T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' })}, was AED 110.75 under our figure (0.19%).`, r.text);
  check('…acts: the wire far off ours, the unchecked transfers, the platform that publishes none',
    r.acts.length === 3 && /49.7% above our figure/.test(r.acts[0].text) && r.acts[0].to === 'payout-diff' && /Yango publishes no transfer/.test(r.acts[2].text), J(r.acts));
  check('…a failed comparison is said, never a checked wire invented',
    /comparison with our own figures did not load/.test(run('payouts', { d, rec: { __error: 'HTTP 500' } }).text));
  check('#payouts: no register → absent', run('payouts', {}).absent === 'The payout register did not answer.');
  check('…an empty register over the server’s own span names that span, not the window chosen elsewhere',
    run('payouts', { d: { scope: 'window', window: ['2026-08-01', '2026-08-31'], payouts: [], coverage: [] }, rec: null }).text
      === 'No transfer reached the bank between 1 Aug 2026 and 31 Aug 2026.');
  check('…the server’s sentinel span for an empty register is the whole record, not "1 Jan 2000 – 1 Jan 2100"',
    run('payouts', { d: { scope: 'window', window: ['2000-01-01', '2100-01-01'], payouts: [], coverage: [] } }).text
      === 'No transfer has been collected from any platform yet.');
  check('…and under a chip, nothing on record for THAT chip — never "none from any platform"',
    run('payouts', { d: { scope: 'record', payouts: [], coverage: [] } }, { ...ctx, platform: 'yango' }).text
      === 'No transfer is on record for Yango only, both fleets.');
}

/* ── #low-performers ── */
{
  const v = { from: '2026-10-01', to: '2026-10-21', counted_days: 21, hotel: 'hide',
    totals: { population: 106, below_target: 100000, below_gross: 70200, no_cause: 9 },
    rows: [{ band: 'lt50', trend: { verdict: 'slipping' } }, { band: 'lt80', trend: { verdict: 'steady' } }] };
  const r = run('low-performers', { v, hotelWord: 'Hotel-only drivers left out' });
  check('#low-performers: how many are below, over how many days, earning what share',
    r.text === '2 of 106 drivers are below target over the 21 days counted, earning 70.2% of what they were asked.', r.text);
  check('…the basis names the span, the fleets and the hotel setting the page is on',
    r.basis === 'Basis: each active driver’s gross against their own daily target, 1 Oct 2026 – 21 Oct 2026, both fleets; hotel-only drivers left out.', r.basis);
  check('…acts: under half, slipped, no measured cause — each to its panel',
    J(r.acts.map((a) => a.to)) === J(['lp-list', 'lp-weeks', 'lp-why']), J(r.acts));
  check('#low-performers: failed → absent', run('low-performers', { v: { _err: new Error('HTTP 504') } }).absent === 'The list could not be read: HTTP 504.');
  check('#low-performers: the server’s why', run('low-performers', { v: { why: 'No target is set for this period.' } }).absent === 'No target is set for this period.');
}

/* ── #compare ── */
{
  const p = { cut_minutes: 480, cut_label: '08:00', totals: { a: { bookings: 69 }, b: { bookings: 82 } },
    stopped: [1, 2, 3], collectors: [{ last_ok: '2026-11-10T00:00:00Z' }, { last_ok: '2026-11-12T07:00:00Z' }] };
  const r = run('compare', { p, a: '2026-11-12', b: '2026-11-11' });
  check('#compare: cut at the same minute, the two counts, the change',
    /^To 08:00 Dubai, .+ has 69 bookings against 82 on .+: 13 fewer, −15\.9%\.$/.test(r.text), r.text);
  check('…acts: who has not driven yet, the stale source — both to their panels',
    r.acts.length === 2 && r.acts[0].to === 'cmp-roster' && /3 people drove/.test(r.acts[0].text) && r.acts[1].to === 'cmp-fresh', J(r.acts));
  const zero = run('compare', { p: { cut_minutes: 1440, totals: { a: { bookings: 5 }, b: { bookings: 0 } } }, a: '2026-11-12', b: '2026-11-11' });
  check('…against a day of none: no percentage invented', /a change against none is not a percentage/.test(zero.text), zero.text);
  check('#compare: not loaded → absent', run('compare', {}).absent === 'The comparison did not load.');
}

/* ── #supply ── */
{
  const bal = { covered: true, totals: { online_h: 22061, idle_h: 14595, idle_pct: 66, jobs_per_online_h: 0.81 },
    cells: [{ dow: 2, h: 3, online_h: 10, jobs_per_online_h: 0.14, occurrences: 2 }] };
  const r = run('supply', { bal, areas: { areas: [{ area: 'Marina' }] } });
  check('#supply: idle driver-hours, the share, what an online hour sells',
    r.text === 'This month, 14,595 of 22,061 online driver-hours carried nobody (66%); an online hour sold 0.81 jobs.', r.text);
  check('…the worst-selling hour is an act, sized in jobs', /^Tue 03:00 sells 0\.14 jobs an online hour against 0\.81 — at the average, about 13 more jobs/.test(r.acts[0]?.text || ''), J(r.acts));
  for (const [why, want] of [['no-feed', /no availability feed/], ['not-yet', /in the future/], ['no-span', /no shift closes/], [undefined, /last 31 days/]]) {
    check(`#supply: not covered (${why || 'outside the window'}) → absent with that reason`, want.test(run('supply', { bal: { covered: false, uncovered: { reason: why } } }).absent || ''));
  }
  check('#supply: no idle split → absent, not "0%"', /no idle split/.test(run('supply', { bal: { covered: true, totals: { online_h: 5, idle_h: null } } }).absent || ''));
}

/* ── #live ── */
{
  const rows = [{ stale: false, speed: 40 }, { stale: false, speed: 0 }, { stale: true, fix_age_min: 2000 }, { stale: true, fix_age_min: 45 }];
  const r = run('live', { rows, fixed: 3 });
  check('#live: reported (and of those, moving), stale, silent',
    r.text === '2 of 4 cars reported within 30 minutes, 1 of them moving; 2 are stale, 1 of them silent over a day.', r.text);
  const quiet = run('live', { rows: [{ stale: true, fix_age_min: 9000, speed: 40 }], fixed: 1 });
  check('…a silent car’s last speed is not "moving" now', quiet.text === '0 of 1 car reported within 30 minutes; 1 is stale and silent over a day.', quiet.text);
  check('…acts: the silent, the stale, the cars with no usable fix', r.acts.length === 3 && /1 car report no usable fix|1 car reports no usable fix|1 car report/.test(r.acts[2].text), J(r.acts));
  check('#live: failed → absent with the page’s sentence', run('live', { err: new Error('HTTP 503') }).absent === 'The live feed could not be read: HTTP 503.');
  check('#live: no car reports → absent', /No feed reports a position/.test(run('live', { rows: [] }).absent || ''));
}

/* ── #sources ── */
{
  const rows = [{ source: 'uber' }, { source: 'bolt' }, { source: 'fms' }];
  const r = run('sources', { rows, bad: [rows[0]], partial: [rows[1]], quietOk: [], blank: [rows[1]],
    oldest: { source: 'fms' }, ageH: 30, debt: { days: 1310, entries: 153 } });
  check('#sources: failed, unfetched, days owed, the stalest source',
    r.text === '1 collector failed on its last run, 1 run left windows unfetched; 1,310 days still owed from 153 refused windows; the stalest scheduled source, FMS telematics, last finished 30 h ago.', r.text);
  check('…acts: the failed, the dead source, the days owed → Collection gaps',
    r.acts.length === 3 && r.acts[0].to === 'Collector health' && r.acts[1].to === 'src-why' && r.acts[2].href === '#coverage', J(r.acts));
  check('#sources: no run on record → absent', run('sources', { rows: [] }).absent === 'No collector run is on record.');
  const old = run('sources', { rows, oldest: { source: 'bolt' }, ageH: 1738 });
  check('…all clean, but a scheduled feed silent over a day is still an act',
    /^All 3 collector runs last ran clean; .*1,738 h ago\.$/.test(old.text) && old.acts.length === 1 && old.acts[0].to === 'src-age', J(old));
}

/* ── #providers ── */
{
  const s = (provider, surface, n = 0) => ({ provider, surface, unmapped_n: n });
  const live = [s('hotel', 'trip-report', 52), s('uber', 'trips', 3)];
  const r = run('providers', { probed: [...live, s('bolt', 'roster')], live, refused: [s('bolt', 'roster')], unmapped: 55, worst: live[0], unconfigured: [{ provider: 'tesla' }] });
  check('#providers: answered, refused, fields with no column',
    r.text === '2 of 3 surfaces answered on the last probe; 1 refused, and 55 fields that providers send have no column on our side.', r.text);
  check('…acts: the refusals, the fields not kept, the provider with no credentials → Settings',
    r.acts.length === 3 && r.acts[0].to === 'Feeds that did not answer' && /Hotel’s trip-report alone has 52/.test(r.acts[1].text) && r.acts[2].href === '#settings', J(r.acts));
  check('#providers: never probed → absent with why', /No provider has been probed yet/.test(run('providers', { probed: [] }).absent || ''));
}

/* ── #analyst ── */
{
  const r = run('analyst', { confirmed: 83, refuted: 45, immaterial: 80, unsupported: 3, runs: 18, model: 'glm' });
  check('#analyst: survived, contradicted, too small',
    r.text === '83 judgements survived the check over 18 passes; 45 were contradicted by the data and 80 were true but too small to act on.', r.text);
  const failed = run('analyst', { confirmed: 0, refuted: 0, immaterial: 0, unsupported: 0, runs: 0,
    last_pass: { outcome: 'failed', finished_at: '2026-11-12T03:10:00Z', error: 'Token Plan usage limit reached' } });
  check('#analyst: the last pass failed → absent with the model’s own error, not "has not run yet"',
    /could not reach the model .*Token Plan usage limit reached\. Nothing has been judged since\./.test(failed.absent || '') && !/has not run/.test(failed.absent), failed.absent);
  check('#analyst: no model configured → that reason', /No model is configured/.test(run('analyst', { configured: false }).absent || ''));
  check('#analyst: never run → that reason', /No analyst pass has run yet/.test(run('analyst', {}).absent || ''));
}

/* ── beyond the main pages: #roster, #retention, #revenue, #compliance ── */
{
  const roster = { totals: { people: 280, working: 115, idle_this_window: 60, never_started: 76, blocked: 24 },
    people: [{ category: 'blocked', holding_vehicle_while_blocked: true }, { category: 'idle_this_window' }] };
  const r = run('roster', roster);
  check('#roster: on the books, drove, could earn and did not, never have, stopped everywhere',
    r.text === '280 people on the books: 115 drove this month, 60 could earn and did not, 76 never have; 24 cannot work on any platform they hold.', r.text);
  check('…acts open the cohort lists the tiles open, the car held while stopped first',
    J(r.acts.map((a) => a.href)) === J(['#cohort/roster-blocked-holding', '#cohort/roster-blocked', '#cohort/roster-idle']), J(r.acts));
  check('#roster: not loaded → absent', run('roster', {}).absent === 'The roster did not load.');
  check('#roster: nobody → absent, not "0 people"', /Nobody is on any platform/.test(run('roster', { totals: { people: 0 } }).absent || ''));

  const ret = { ok: true, last_complete_month: '2026-10', flow: [{ active: 120, joined: 9, returning: 2, left: 14, net: -3 }],
    stopped_last_month: [1, 2, 3], started_last_month: [1] };
  const t = run('retention', ret);
  check('#retention: the last complete month — arrived, stopped, earning, the net move',
    t.text === 'In October 2026, 11 drivers arrived and 14 stopped: 120 earning, −3 on the month before.', t.text);
  check('…acts: who stopped, who started → their cohorts', J(t.acts.map((a) => a.href)) === J(['#cohort/retention-stopped', '#cohort/retention-started']));
  check('#retention: not enough history → the server’s reason', run('retention', { ok: false, reason: 'Two months of history are needed.' }).absent === 'Two months of history are needed.');

  const rev = { totals: { accounted: 774811.08, bookings: 17965, accounted_bookings: 17000, priced_bookings: 16195 },
    platforms: [{ platform: 'uber', bookings: 16000, fares: 1 }, { platform: 'yango', bookings: 965 }, { platform: 'bolt', bookings: 1000, payouts: 5 }] };
  const v = run('revenue', rev);
  check('#revenue: what is accounted for, over how many bookings, how many carry a fare',
    v.text === 'AED 774,811.08 is accounted for this month: 17,000 of 17,965 bookings are on a channel whose money we hold, 16,195 with a fare on the trip itself.', v.text);
  check('…acts: the channel with work and no money, the one paid only by statement', /^Yango reports 965 bookings and no money anywhere/.test(v.acts[0]?.text || '') && v.acts[1]?.href === '#reconcile', J(v.acts));
  check('#revenue: no money held → absent with why, never "AED 0.00 accounted for"',
    /No fare and no payout statement covers this month/.test(run('revenue', { totals: { accounted: null, bookings: 5 }, platforms: [] }).absent || ''));

  const c = run('compliance', { vExpired: 3, vWeek: 1, dExpired: 144, dWeek: 2, byPerson: true, dNoDate: 0, pConflict: 2 });
  check('#compliance: people with an expired licence, vehicle papers expired, what lapses this week',
    c.text === '144 drivers hold an expired licence and 3 vehicle documents have expired; 3 more documents expire within a week.', c.text);
  check('…acts to the tables, sorted soonest first', c.acts[0].to === 'Driver licences' && c.acts[1].to === 'Vehicle documents' && /2 drivers have records that disagree/.test(c.acts[2].text), J(c.acts));
  check('…when the spine could not place the accounts, the words say RECORDS, not drivers',
    /^5 licence records have expired/.test(run('compliance', { vExpired: 0, dExpired: 5, byPerson: false }).text || ''));
  check('#compliance: not loaded → absent', run('compliance', {}).absent === 'The compliance record did not load.');
}

console.log('\n2 · the guard: no NaN on screen, a throwing rule is said, three actions at most');
{
  const saved = RULES.target;
  RULES.target = () => ({ text: `${NaN} bookings`, acts: [] });
  check('a sentence carrying NaN is refused and drawn absent', /figure it needs is missing/.test(run('target', {}).absent || ''), J(run('target', {})));
  RULES.target = () => ({ text: 'fine', acts: [{ text: 'undefined trips', href: '#x' }] });
  check('…and so is an action carrying undefined', /figure it needs is missing/.test(run('target', {}).absent || ''));
  RULES.target = () => { throw new Error('boom'); };
  check('a rule that throws is drawn absent with the error', run('target', {}).absent === 'The answer could not be worked out from this page’s data: boom.');
  RULES.target = () => ({ text: 'x', acts: [1, 2, 3, 4, 5].map((i) => ({ text: `a${i}`, href: '#x' })) });
  check(`never more than ${ACTS_MAX} actions`, run('target', {}).acts.length === 3 && ACTS_MAX === 3);
  RULES.target = saved;
  const unread = run('month-target', { month_name: 'May', summary: { month_target: 5, days_left: 0, earned: null, over: 1, days_gone: 3 }, days: [{ state: 'past' }] });
  check('a figure the sentence needs and the data lacks is refused — never a dash in a sentence ("— earned")',
    unread.absent === 'The answer could not be worded: a figure it needs is missing from this page’s data.', J(unread));
  const noPct = run('payouts', { d: { scope: 'record', payouts: [{ amount: 10 }], coverage: [] }, rec: { totals: {}, rows: [{ paid_on: '2026-10-19', delta: 5, delta_pct: null }] } });
  check('…and a share the server did not send is left out, not printed as 0.00%', !/0\.00%|\(\)/.test(noPct.text) && /above our figure\.$/.test(noPct.text), noPct.text);
  check('a page with no rule draws nothing (null)', answerFor('settings', {}) === null);
  check('winPhrase: headings become phrases', J(['This month', 'Last 30 days', 'August 2026', 'Yesterday', 'Last week'].map(winPhrase))
    === J(['this month', 'in the last 30 days', 'in August 2026', 'yesterday', 'last week']));
  check('scopeWords names the chips', scopeWords({}) === 'every channel, both fleets' && /^Bolt only/.test(scopeWords({ platform: 'bolt' })));
  check('num: "" and null are not zero', num('') === null && num(null) === null && num('0') === 0);
}

console.log('\n3 · the wiring, read from the source');
const PUB = new URL('../api/public/', import.meta.url);
const src = (f) => readFileSync(new URL(f, PUB), 'utf8');
const HOOKS = { 'app.js': ['overview', 'vehicles', 'unauthorized', 'live', 'sources'], 'driver.js': ['drivers'],
  'targetmonth.js': ['month-target'], 'payouts.js': ['payouts'], 'compare.js': ['compare'], 'supply.js': ['supply'],
  'providers.js': ['providers'], 'analyst.js': ['analyst'], 'targetpage.js': ['target'], 'lowperf.js': ['low-performers'],
  'roster.js': ['roster'], 'retention.js': ['retention'], 'revenue.js': ['revenue'] };
HOOKS['app.js'].push('compliance');
for (const [file, keys] of Object.entries(HOOKS)) {
  const s = src(file);
  for (const k of keys) check(`${file} calls the hook for '${k}'`, s.includes(`answer(root, '${k}'`) || s.includes(`answer(outer, '${k}'`));
}
check('every rule is hooked by some page, and every hook names a rule',
  J(Object.values(HOOKS).flat().sort()) === J(Object.keys(RULES).sort()), J(Object.keys(RULES)));
const appjs = src('app.js');
const renderBody = appjs.slice(appjs.indexOf('async function render() {'), appjs.indexOf('/* ── every page says what it was built from'));
check('render() empties the box on every navigation, beside clearPageFoot', /clearPageFoot\(\);[\s\S]{0,400}clearAnswer\(\);/.test(renderBody));
for (const f of ['targetpage.js', 'lowperf.js']) {
  const s = src(f);
  check(`${f} (on the phone's static graph) loads answers.js only when used`,
    /import\('\.\/answers\.js'\)/.test(s) && !/^\s*import\s[^;]*from\s+'\.\/answers\.js'/m.test(s));
}
for (const f of ['answers.js', 'answerline.js']) {
  const s = src(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  check(`${f} cannot issue a request (no fetch, api, q, qAll, qChan, import())`,
    !/\b(fetch|api|qAll|qChan)\(|\bq\(|\bimport\(/.test(s), (s.match(/\b(fetch|api|qAll|qChan)\(|\bq\(|\bimport\(/) || [])[0]);
  check(`${f} reads the skin as a token, never the attribute`, !/dataset\.skin|data-skin/.test(s));
}
const ark = src('arkiv.css');
check('arkiv.css styles the box under the skin only', /:root\[data-skin="arkiv"\] #pageAnswer\{/.test(ark) && !/^#pageAnswer|^\.ans-/m.test(ark));

console.log('\n4 · in Chromium, on mockapi');
const { app: mock } = await import('../mockapi.mjs');
const { launchChromium } = await import('./browser.mjs');
const srv = mock.listen(0);
await new Promise((r) => srv.once('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const browser = await launchChromium();
const open = async (route, { width = 1280, theme = 'light', skin = 'arkiv' } = {}) => {
  const c = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', timezoneId: 'Asia/Dubai', colorScheme: theme });
  const page = await c.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${base}/?ui=desktop&skin=${skin}#${route}`, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle', { timeout: 25000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('pageAnswer') || document.querySelector('#view .empty'), null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(400);
  return { c, page, errs };
};
/* In the page: the box, where it sits, and the contrast of every text in it
   against the colour it actually sits on (WCAG relative luminance). */
const READ = async () => {
  const { findTarget } = await import('/answerline.js');
  const a = document.getElementById('pageAnswer');
  const v = document.getElementById('view');
  const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ground = (e) => { for (let n = e; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if (c.length === 3 || (c.length === 4 && c[3] > 0.5)) return c.slice(0, 3); } return [255, 255, 255]; };
  const ratio = (e) => { const L1 = lum(rgb(getComputedStyle(e).color).slice(0, 3)), L2 = lum(ground(e)); return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05); };
  const texts = a ? [...a.querySelectorAll('.ans-line, .ans-na-l, .ans-basis, .ans-act-t, .ans-act-x, .ans-act-go, .ans-act-n')] : [];
  return {
    present: !!a, between: !!a && a.nextElementSibling === v && !!a.previousElementSibling?.matches('.topbar'),
    insideView: !!v.querySelector('#pageAnswer, .ans'),
    line: a?.querySelector('.ans-line')?.textContent || '', absent: !!a?.querySelector('[data-absent]'),
    basis: a?.querySelector('.ans-basis')?.textContent || '',
    acts: [...(a?.querySelectorAll('.ans-act-i') || [])].map((x) => ({ href: x.getAttribute('href'), to: x.dataset.to || null,
      found: x.dataset.to ? !!findTarget(v, x.dataset.to) : null, h: x.getBoundingClientRect().height })),
    minRatio: texts.length ? Math.min(...texts.map(ratio)) : null,
    wash: a?.querySelector('.ans-act') ? getComputedStyle(a.querySelector('.ans-act')).backgroundColor : null,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    boxOverflow: a ? a.scrollWidth - a.clientWidth : 0,
  };
};
const ROUTES = Object.keys(RULES);
const VIEWS = /^#(target|overview|month-target|drivers|vehicles|unauthorized|payouts|low-performers|compare|supply|live|sources|providers|analyst|day|cohort|segments|coverage|compliance|hr-roster|same-person|platforms|settings|reconcile|roster|retention|revenue)\b/;
for (const r of ROUTES) {
  const o = await open(r);
  const x = await o.page.evaluate(READ);
  check(`${r}: the box sits between the title block and #view, never inside it`, x.present && x.between && !x.insideView, J(x));
  check(`${r}: a line (${x.absent ? 'absent, with its reason' : 'answered'}) and its basis; ${x.acts.length} action(s), each a real route`,
    x.line.length > 20 && (x.absent || /^Basis: /.test(x.basis)) && x.acts.length <= 3 && x.acts.every((a) => VIEWS.test(a.href || '')),
    J({ line: x.line, basis: x.basis, acts: x.acts }));
  check(`${r}: every in-page action finds its panel on the page`, x.acts.every((a) => a.found !== false), J(x.acts));
  check(`${r}: AA contrast for every text in it, light (${x.minRatio?.toFixed(2)})`, x.minRatio == null || x.minRatio >= 4.5, String(x.minRatio));
  check(`${r}: nothing thrown`, !o.errs.length, o.errs.join(' | '));
  await o.c.close();
}
{
  const o = await open('payouts', { theme: 'dark' });
  const x = await o.page.evaluate(READ);
  const l = await open('payouts');
  const y = await l.page.evaluate(READ);
  check(`dark: AA contrast for every text in the box (${x.minRatio?.toFixed(2)}), on its own wash`, x.minRatio >= 4.5 && x.wash && x.wash !== y.wash, `${x.minRatio} ${x.wash} vs ${y.wash}`);
  await o.c.close(); await l.c.close();
}
for (const r of ['drivers', 'payouts', 'low-performers']) {
  const o = await open(r, { width: 390 });
  const x = await o.page.evaluate(READ);
  check(`${r} at 390: the box never widens the page, and every action is at least 44px tall`,
    x.present && x.overflow <= 0 && x.boxOverflow <= 0 && x.acts.length > 0 && x.acts.every((a) => a.h >= 44), J({ overflow: x.overflow, box: x.boxOverflow, acts: x.acts }));
  if (r === 'drivers') {
    /* A ONE-LINE action, which the real pages' long sentences never are at
       this width (they wrap to two lines, 50px, whatever the floor): drawn
       through the component itself, so it is the 44px rule being measured
       and not the length of a sentence. */
    const h = await o.page.evaluate(async () => {
      const { mountAnswer } = await import('/answerline.js');
      const box = mountAnswer(document.getElementById('view'), { page: 'probe', text: 'A short answer.', basis: 'Basis: a probe.',
        acts: [{ text: 'Short', href: '#settings' }] });
      return box ? box.querySelector('.ans-act-i').getBoundingClientRect().height : null;
    });
    check(`…and a one-line action at 390 is still a 44px target (${h}px)`, h >= 44, String(h));
  }
  await o.c.close();
}
{
  const o = await open('low-performers');
  const link = await o.page.$('#pageAnswer .ans-act-i[data-to="lp-list"]');
  if (link) await link.click();
  await o.page.waitForTimeout(1200);           // a smooth scroll, then the ring is still on (1.8 s)
  const hit = await o.page.evaluate(() => ({ marked: !!document.querySelector('[data-panel="lp-list"].ans-target'), hash: location.hash,
    top: Math.round(document.querySelector('[data-panel="lp-list"]')?.getBoundingClientRect().top ?? 9999),
    end: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2,
    focused: document.activeElement?.dataset?.panel || null }));
  check('an in-page action scrolls to its panel, marks it and moves focus to it, without leaving the page',
    !!link && hit.marked && hit.hash === '#low-performers' && (hit.top < 120 || hit.end) && hit.focused === 'lp-list', J(hit));
  await o.page.evaluate(() => { location.hash = '#settings'; });
  await o.page.waitForTimeout(1500);
  check('navigating away clears it: #settings, which has no rule, shows no answer', await o.page.evaluate(() => !document.getElementById('pageAnswer')));
  await o.c.close();
}
{
  const o = await open('payouts', { skin: 'classic' });
  check('the Classic skin never builds it (held byte-frozen)', await o.page.evaluate(() => !document.getElementById('pageAnswer') && !document.querySelector('.ans')));
  await o.c.close();
}

await browser.close();
srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
