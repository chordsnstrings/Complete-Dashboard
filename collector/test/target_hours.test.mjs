/* TODAY'S TARGET, HOUR BY HOUR — api/target_hours.js and the month's detail.
   ═════════════════════════════════════════════════════════════════════════
   The operator, 2026-10-02: "what target they should achieve within the
   specific hour of the day today to make sure we achieve the target in real
   time, and how much left for today … every hour if they are on target or not
   based on hourly income of the day and possibilities. Including number of
   trips. These are separate panels each. Based on hourly historical trips for
   that hour, and what needs to be achieved based on that."
   What is pinned:
     1. an hour's target is today's target × that hour's share of the usual
        day (28 days of history), and the usual hour is printed beside it;
     2. an hour that has ended is over or under its own target; the running
        total counts the current hour by the minutes gone; what is left is
        shared over the rest of the day in the usual proportions;
     3. today's revenue is the live strip's own estimate spread over the
        hours, so the hours add up to the strip's figure, and it says so;
     4. no target, or too little history: absent, with the reason;
     5. the access layer withholds every figure by class; the route is never
        cached;
     6. the month's detail: what each day left must bring, the average day,
        where the month lands at this pace, and each fleet's part.
   Synthetic plates (C…) and drivers (Test Driver …) only.

   REVERSIONS, run 2026-10-02 against the 38 checks below — each rule
   undone, the file run, the rule restored:
     the target laid flat over 24 hours ............ 26 passed, 12 FAILED
     the hour now counted whole in "by now" ......... 37 passed,  1 FAILED
     what is left shared evenly, not in proportion .. 34 passed,  4 FAILED
     a usual day from under 7 days of history ....... 37 passed,  1 FAILED
     judged at the wall clock, not the collection ... 37 passed,  1 FAILED
     no "idle" hour (two zeros read as on target) ... 36 passed,  2 FAILED
     no month-end projection (the earned to date) ... 36 passed,  2 FAILED
     revenue.hours[].done left out of the manifest .. 37 passed,  1 FAILED
     an idle hour drawn as "▲ On target" ............ 37 passed,  1 FAILED
     the strip's estimate not spread over the hours . 30 passed,  8 FAILED */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const j = JSON.stringify;

const { targetHours, usualDay, hoursOf, HISTORY_MIN_DAYS } = await import('../api/target_hours.js');
const { saveTarget, monthTarget, addDays } = await import('../api/revenue_target.js');

const db = new PGlite();
await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);
let n = 0;
const T = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, plate, requested_at, ended_at, status, payment_type, price, currency, raw)
   VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz + interval '20 minutes', 'completed', 'card', $8, 'AED', '{}'::jsonb)`,
  [o.platform || 'uber', `t${++n}`, o.fleet, `u-${o.driver}`, o.driver, o.plate, o.at, o.price === undefined ? 50 : o.price]);
const span = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
/* Every day of September and 1 October: ten drivers, each in their own car
   (C1–C7 Ecosine, C8–C10 Egari), ten trips at AED 50 — three in the 08:00
   hour, five in the 18:00 hour, two in the 22:00 hour. The usual day: 100
   trips and AED 5,000, 30% / 50% / 20%. */
const HOURS = [8, 8, 8, 18, 18, 18, 18, 18, 22, 22];
for (const d of span('2026-09-01', '2026-10-01')) {
  for (let c = 1; c <= 10; c += 1) {
    for (const [i, h] of HOURS.entries()) {
      await T({ fleet: c <= 7 ? 'ecosine' : 'egari', driver: `Test Driver ${c}`, plate: `C${c}`,
        at: `${d}T${String(h).padStart(2, '0')}:${String(5 * i).padStart(2, '0')}:00+04:00` });
    }
  }
}
/* Today, Fri 2 Oct, by 19:30: the 08:00 hour as usual (30 trips), the 18:00
   hour ten short (40), one trip at 19:30 — all of it Uber, none priced yet. */
for (let c = 1; c <= 10; c += 1) {
  for (let i = 0; i < 3; i += 1) await T({ fleet: c <= 7 ? 'ecosine' : 'egari', driver: `Test Driver ${c}`, plate: `C${c}`, at: `2026-10-02T08:${String(10 + i).padStart(2, '0')}:00+04:00`, price: null });
  for (let i = 0; i < 4; i += 1) await T({ fleet: c <= 7 ? 'ecosine' : 'egari', driver: `Test Driver ${c}`, plate: `C${c}`, at: `2026-10-02T18:${String(10 + i).padStart(2, '0')}:00+04:00`, price: null });
}
await T({ fleet: 'ecosine', driver: 'Test Driver 1', plate: 'C1', at: '2026-10-02T19:30:00+04:00', price: null });
await q(`INSERT INTO access_config (key, value) VALUES ('low_trips_min', '10') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
/* AED 155,000 for October over the 10 cars that earned in the week before
   the 1st: AED 500 a car a day, 5,000 a day — exactly the usual day — and the
   1st earned 5,000, so today needs 5,000 too. */
const saved = await saveTarget(q, { month: '2026-10', gross: 155000, now: new Date('2026-10-01T09:00:00+04:00'), byLabel: 'owner@example.test' });
const NOW = new Date('2026-10-02T19:30:00+04:00');
const h = await targetHours(q, { now: NOW });
const R = h.revenue;
const P = h.trips;
const at = (x, hr) => x.hours?.[hr] || {};

/* ── 1. the usual day, and an hour's target ─────────────────────────────── */
console.log('\n1. each hour against its own history');
check('saved at AED 500 a car a day over 10 cars; today needs 5,000 and 10 active × 10 trips', saved.row?.rate === 500
  && R.target === 5000 && P.target === 100 && P.active === 10 && P.min === 10, j([saved.row?.rate, R.target, P.target]));
check('the usual day: 30% of it in the 08:00 hour, 50% at 18:00, 20% at 22:00, nothing else',
  at(P, 8).share === 0.3 && at(P, 18).share === 0.5 && at(P, 22).share === 0.2 && at(P, 12).share === 0
  && at(R, 8).share === 0.3 && at(R, 18).share === 0.5, j([at(P, 8).share, at(P, 18).share, at(R, 22).share]));
check('an hour\'s target is today\'s × its share: 1,500 / 2,500 / 1,000 AED and 30 / 50 / 20 trips',
  at(R, 8).need === 1500 && at(R, 18).need === 2500 && at(R, 22).need === 1000
  && at(P, 8).need === 30 && at(P, 18).need === 50 && at(P, 22).need === 20, j([at(R, 18), at(P, 18)]));
check('…with what the hour usually does beside it', at(P, 18).usual === 50 && at(R, 18).usual === 2500 && P.usual_day === 100,
  j([at(P, 18).usual, at(R, 18).usual, P.usual_day]));

/* ── 2. on target or not ────────────────────────────────────────────────── */
console.log('\n2. on target, hour by hour and so far');
check('an hour that met its target exactly is on target; one short is under, by how much',
  at(P, 8).state === 'over' && at(P, 18).state === 'under' && at(P, 18).diff === -10
  && at(R, 8).state === 'over' && at(R, 18).state === 'under' && at(R, 18).diff === -500, j([at(P, 8), at(P, 18)]));
check('an hour gone that asked nothing and did nothing is neither on target nor under', at(P, 12).state === 'idle' && at(R, 3).state === 'idle',
  j([at(P, 12).state, at(R, 3).state]));
check('the hour now is in progress; the hours after it are to come, with no "done"',
  at(P, 19).state === 'now' && at(P, 20).state === 'future' && at(P, 22).done === null && h.hour === 19 && h.clock === '19:30',
  j([at(P, 19).state, at(P, 22).done]));
check('by 19:30 the usual day has 80 trips done; 71 are — 9 behind', P.need_by_now === 80 && P.done === 71 && P.ahead === -9, j([P.need_by_now, P.done, P.ahead]));
check('…and AED 4,000 against ≈ 3,550 — 450 behind', R.need_by_now === 4000 && R.done === 3550 && R.ahead === -450, j([R.need_by_now, R.done, R.ahead]));
check('left for today: 29 trips, ≈ AED 1,450', P.left === 29 && R.left === 1450, j([P.left, R.left]));
check('what is left goes on the hours left in the usual day\'s proportions: all of it on the 22:00 hour, none on the empty ones',
  at(P, 22).catch_up === 29 && at(P, 21).catch_up === 0 && at(R, 22).catch_up === 1450 && at(P, 18).catch_up === null,
  j([at(P, 21).catch_up, at(P, 22).catch_up, at(R, 22).catch_up]));
check('the running totals', at(P, 18).cum_need === 80 && at(P, 18).cum_done === 70 && at(P, 23).cum_need === 100,
  j([at(P, 18).cum_need, at(P, 18).cum_done, at(P, 23).cum_need]));
/* The current hour counted by the minutes gone, on a curve with weight in
   it: 08:30 on the usual day is half of the 08:00 hour's 30% — 15 of 100. */
const half = hoursOf({ target: 100, share: [0, 0, 0, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.2, 0],
  usual: Array(24).fill(0), done: Array(24).fill(0).map((_, i) => (i === 8 ? 10 : 0)), cur: 8, gone: 0.5 });
check('the hour now counts by the minutes gone: at 08:30, 15 of 100 are due; 10 are done; the rest of the 08:00 hour must carry 90 × 0.15/0.85',
  half.need_by_now === 15 && half.ahead === -5 && Math.abs(half.hours[8].catch_up - 90 * 0.15 / 0.85) < 0.06
  && Math.abs(half.this_hour.catch_up - 15.9) < 0.06, j([half.need_by_now, half.hours[8].catch_up]));

/* ── 3. today's revenue is the live strip's estimate, and says so ───────── */
console.log('\n3. revenue today: the strip\'s own estimate, spread by the hour');
const { buildDay } = await import('../api/day_routes.js');
const strip = await buildDay(q, '2026-10-02');
check('none of today is priced yet, so it is an estimate, and the hours add up to the strip\'s figure exactly',
  R.estimate === true && R.measured === 0 && R.projected === 3550 && Number(strip.headline.expected_revenue) === R.done,
  j([R.estimate, R.measured, R.projected, strip.headline.expected_revenue, R.done]));
check('…the 08:00 hour ≈ 1,500 and the 18:00 hour ≈ 2,000: its own bookings at the channel\'s rate', at(R, 8).done === 1500 && at(R, 18).done === 2000,
  j([at(R, 8).done, at(R, 18).done]));
check('with no collection run on record, the last booking counted is the cut: 19:30', h.cut_by === 'last_booking'
  && h.clock === '19:30' && h.latest_at === new Date('2026-10-02T19:30:00+04:00').toISOString(), j([h.cut_by, h.clock, h.latest_at]));
/* Two intraday runs today, Uber to 19:10 and Bolt to 18:40, and the nightly
   catch-up at 19:20 (a re-read of the days gone). The day is counted to the
   freshest intraday run — 19:10: the 18:00 hour has ended (and is under),
   the 19:00 hour is in progress, whatever the clock says. */
await q(`INSERT INTO collection_run (source, fleet_id, mode, window_start, window_end, status, rows_written, finished_at) VALUES
  ('uber', 'ecosine', 'incremental', '2026-09-30', '2026-10-02', 'ok', 5, '2026-10-02T19:10:00+04:00'),
  ('bolt', 'ecosine', 'incremental', '2026-09-30', '2026-10-02', 'ok', 5, '2026-10-02T18:40:00+04:00'),
  ('uber', 'egari', 'catchup', '2026-09-20', '2026-10-01', 'ok', 5, '2026-10-02T19:20:00+04:00')`);
const cut = await targetHours(q, { now: NOW });
check('the cut is the last intraday collection (a nightly catch-up cannot move it): 19:10, twenty minutes behind the clock',
  cut.cut_by === 'collection' && cut.clock === '19:10' && cut.now_clock === '19:30' && cut.lag_min === 20
  && cut.trips.hours[18].state === 'under' && cut.trips.hours[19].state === 'now', j([cut.cut_by, cut.clock, cut.lag_min, cut.trips.hours[19].state]));
await q(`DELETE FROM collection_run`);

/* ── 4. what cannot be measured ─────────────────────────────────────────── */
console.log('\n4. absent, with the reason');
const early = await usualDay(q, '2026-09-04');
check(`fewer than ${HISTORY_MIN_DAYS} days of history is not a usual day`, early.trips.ok === false && early.trips.days === 3, j(early.trips.days));
await q(`DELETE FROM revenue_target`);
const bare = await targetHours(q, { now: NOW });
check('no target: the revenue panel says so; the trips panel stands — the minimum always exists',
  /^No target is set for October 2026/.test(bare.revenue.absent || '') && !bare.revenue.hours && bare.trips.target === 100, j(bare.revenue));

/* ── 5. the access layer, and the cache ───────────────────────────────── */
console.log('\n5. withheld by class; never cached');
const { shapeBody } = await import('../api/access/shape.js');
const { lookupEntry } = await import('../api/access/manifest.js');
const entry = lookupEntry('GET', '/api/target/hours');
const nums = (o) => JSON.stringify(o).match(/"(target|done|left|need_by_now|ahead|usual_day|projected|measured|usual|need|diff|cum_need|cum_done|catch_up)":-?\d/g) || [];
const noRev = shapeBody(JSON.parse(j(h)), entry, { BK: 'F' }).body;
check('without REV: not one revenue figure left, and _withheld says so', nums(noRev.revenue).length === 0 && noRev._withheld?.REV === '', nums(noRev.revenue).slice(0, 4).join(' '));
const noBk = shapeBody(JSON.parse(j(h)), entry, { REV: 'F' }).body;
check('without BK: not one trip figure left', nums(noBk.trips).length === 0 && noBk._withheld?.BK === '', nums(noBk.trips).slice(0, 4).join(' '));
check('/api/target/hours is on the cache\'s never list', /'\/api\/target', '\/api\/target\/hours',/.test(readFileSync('api/cache.js', 'utf8')));

/* ── 6. the month in more detail ────────────────────────────────────────── */
console.log('\n6. what the month is moving towards');
await saveTarget(q, { month: '2026-10', gross: 155000, now: new Date('2026-10-01T09:00:00+04:00'), byLabel: 'owner@example.test' });
const m = await monthTarget(q, { today: '2026-10-02', now: NOW, min: 10 });
const s = m.summary;
check('one day gone at AED 5,000: AED 5,000 a day so far, and the month lands at 31 × 5,000 = 155,000 — 100%',
  s.days_gone === 1 && s.avg_day === 5000 && s.month_end_pace === 155000 && s.pace_pct === 100, j([s.days_gone, s.avg_day, s.month_end_pace, s.pace_pct]));
check('what each of the 30 days left must bring: 150,000 ÷ 30 = 5,000', s.per_day_left === 5000 && s.days_left === 30, j([s.per_day_left, s.days_left]));
check('the best and the worst day so far', s.best?.day === '2026-10-01' && s.best.earned === 5000 && s.worst?.day === '2026-10-01', j([s.best, s.worst]));
check('the trips: 100 a day so far by 10 active drivers', m.trips_summary.avg_trips_day === 100 && m.trips_summary.avg_active === 10,
  j([m.trips_summary.avg_trips_day, m.trips_summary.avg_active]));
check('each fleet\'s part: Ecosine 7 cars, AED 3,500 and 70 trips on the 1st; Egari 3, 1,500, 30',
  j(m.fleets) === j([{ fleet: 'ecosine', earned: 3500, earned_yday: 3500, trips: 70, trips_yday: 70, cars_week: 7 },
    { fleet: 'egari', earned: 1500, earned_yday: 1500, trips: 30, trips_yday: 30, cars_week: 3 }]), j(m.fleets));

/* ── 7. the route ─────────────────────────────────────────────────────── */
console.log('\n7. GET /api/target/hours');
const { mountAll } = await import('./mount.mjs');
const api = await mountAll(db);
const got = await api.get('/api/target/hours');
check('answers both panels', got.status === 200 && ('revenue' in got.body) && ('trips' in got.body) && typeof got.body.clock === 'string',
  j(Object.keys(got.body || {})));

/* ── 8. the first page's words (api/public/targetpage.js) ─────────────────
   Green and red only on an hour that has ended, and on the day so far; the
   hour in progress and the hours to come in ink; every coloured figure with
   ▲ or ▼ and a word; an hour that asked nothing says so; an absent panel
   says why. */
console.log('\n8. the first page');
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.location ??= { hash: '', search: '', pathname: '/' };
globalThis.window ??= globalThis;
globalThis.document ??= { documentElement: { dataset: {}, getAttribute: () => null } };
const { hoursHtml, todayHtml, monthFiguresHtml } = await import('../api/public/targetpage.js');
const rowsOf = (html) => [...html.matchAll(/<tr( class="[^"]*")?><th scope="row">(\d\d:00)<\/th>(.*?)<\/tr>/g)].map((m) => ({ h: m[2], html: m[3], cls: m[1] || '' }));
const ph = hoursHtml(P, h, { isMoney: false });
const pr = Object.fromEntries(rowsOf(ph).map((r) => [r.h, r]));
check('24 hours, one row each', rowsOf(ph).length === 24, String(rowsOf(ph).length));
check('an hour gone on target is green with ▲ and the words; one under is red with ▼ and by how much',
  /<span class="tg-over">▲ On target<\/span>/.test(pr['08:00'].html) && /<span class="tg-under">▼ Under by 10 trips<\/span>/.test(pr['18:00'].html), pr['18:00'].html);
check('an hour that asked nothing says so, in ink', /— nothing asked/.test(pr['12:00'].html) && !/tg-over|tg-under/.test(pr['12:00'].html), pr['12:00'].html);
check('the hour now is in ink and marked, with what the rest of it must bring; the hours to come are in ink',
  /In progress/.test(pr['19:00'].html) && /hp-cur/.test(pr['19:00'].cls) && /To come/.test(pr['22:00'].html) && /29 trips/.test(pr['22:00'].html)
  && !/tg-over|tg-under/.test(pr['22:00'].html), pr['22:00'].html);
check('the summary leads with the day so far: ▼ 9 trips behind, and what is left', /<b class="tg-under">▼ 9 trips behind<\/b>/.test(ph)
  && /Left for today: 29 trips\./.test(ph), ph.slice(0, 300));
const rh = hoursHtml(R, h, { isMoney: true });
check('today\'s revenue is marked ≈, and the basis says it is the live strip\'s estimate', /≈ AED 3,550\.00 done/.test(rh)
  && /the live strip’s estimate/.test(rh), rh.slice(0, 260));
const th = todayHtml(h);
check('today: the target, done, left, right now and this hour — "more by 20:00", what the rest of the hour must bring',
  (th.match(/class="tg-cell[ "]/g) || []).length === 5 && /AED 5,000\.00/.test(th) && /AED 1,450\.00 more by 20:00|AED 0\.00 more by 20:00/.test(th)
  && /class="tg-cell tg-under"><span class="tg-l">Right now, 19:30<\/span><b class="tg-v">▼ ≈ AED 450\.00 behind<\/b>/.test(th), th.slice(0, 400));
check('no target: the revenue panel says why, never a zero', /^<p class="tg-absent">No target is set for October 2026/.test(hoursHtml(bare.revenue, bare, { isMoney: true })));
const mf = monthFiguresHtml(m);
check('the month in figures: what every day left must bring, the average day, where the month lands, and each fleet',
  /Every day left must bring<\/th><td><b>AED 5,000\.00<\/b>/.test(mf) && /At this pace the month ends at<\/th><td><b class="tg-over">AED 155,000\.00<\/b>/.test(mf)
  && /<th scope="row">Ecosine<\/th><td><b>AED 3,500\.00<\/b>/.test(mf) && /<th scope="row">Egari<\/th>/.test(mf), mf.slice(0, 300));
check('nothing undefined, NaN or null anywhere on the page', ![ph, rh, th, mf].some((x) => /undefined|NaN|\bnull\b|\[object Object\]/.test(x)));

console.log(`\n${pass} passed, ${fail} failed`);
api.server.close();
process.exit(fail ? 1 : 0);
