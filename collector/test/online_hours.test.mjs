/* Uber, online by the hour — stored, and read back.
   ───────────────────────────────────────────────────────────────────────
   The operator, 2026-10-14: "we need to show driver online by hour on uber and
   store it to fetch previous data". Held here:

     · the hours are cut from the SAME spans driver_day.online_min sums, so a
       driver's 24 hours add up to their day (sql/schema_v106.sql);
     · they are stored, and a narrow rollup pass rewrites only its own days and
       sweeps the hours a span no longer covers;
     · /api/online/hours answers a past day from the store, and today's hours
       past the timeline's last run from the live status feed — never a minute
       from both, and never past the live feed's own last poll;
     · /api/online/hours/range gives day × hour with a reason for every empty day.

   Synthetic accounts only. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshDriverDays, refreshOnlineHours } from '../src/rollup.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine'),('egari','Egari') ON CONFLICT DO NOTHING`);

const D = '2026-10-01';
const T = (hhmm, day = D) => `${day}T${hhmm}:00+04:00`;
const ev = (id, fleet, at, status) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber', $1, $2, $3::timestamptz, 'status', $4, '')`, [fleet, id, at, status]);
// A (Ecosine): online 08:10, heartbeats, offline 10:30 → 50 / 60 / 30 minutes in hours 8, 9, 10.
for (const t of ['08:10', '08:40', '09:20', '10:05']) await ev('acc-a', 'ecosine', T(t), 'ONLINE');
await ev('acc-a', 'ecosine', T('10:30'), 'OFFLINE');
// B (Egari): online 09:50, offline 11:05 → 10 / 60 / 5 in hours 9, 10, 11.
await ev('acc-b', 'egari', T('09:50'), 'ONLINE');
await ev('acc-b', 'egari', T('10:40'), 'ONLINE');
await ev('acc-b', 'egari', T('11:05'), 'OFFLINE');
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, can_earn, observed_at)
         VALUES ('uber','acc-a','ecosine','Test Driver Alpha','active',true,now()),
                ('uber','acc-b','egari','Test Driver Bravo','active',true,now())`);
// The timeline last ran two hours ago, for both fleets.
const runAt = new Date(Date.now() - 2 * 3600e3).toISOString();
await q(`INSERT INTO collection_run (source, fleet_id, mode, status, started_at, finished_at)
         VALUES ('uber_timeline','ecosine','incremental','ok',$1::timestamptz - interval '5 minutes',$1),
                ('uber_timeline','egari','incremental','ok',$1::timestamptz - interval '5 minutes',$1)`, [runAt]);

await refreshDriverDays(db);
await refreshOnlineHours(db);

console.log('\nthe store: the day’s spans, cut at each Dubai hour');
const rows = await q(`SELECT driver_ext_id, hour, online_min::float8 m, fleet_id FROM driver_online_hour
                       WHERE day = $1 ORDER BY 1, 2`, [D]);
const of = (id) => Object.fromEntries(rows.filter((r) => r.driver_ext_id === id).map((r) => [r.hour, r.m]));
check('A: 50, 60 and 30 minutes in hours 8, 9 and 10', JSON.stringify(of('acc-a')) === JSON.stringify({ 8: 50, 9: 60, 10: 30 }), JSON.stringify(of('acc-a')));
check('B: 10, 60 and 5 in hours 9, 10 and 11', JSON.stringify(of('acc-b')) === JSON.stringify({ 9: 10, 10: 60, 11: 5 }), JSON.stringify(of('acc-b')));
check('each hour carries the account’s fleet', rows.every((r) => r.fleet_id === (r.driver_ext_id === 'acc-a' ? 'ecosine' : 'egari')));
{
  const dd = await q(`SELECT driver_ext_id, online_min FROM driver_day WHERE day = $1 ORDER BY 1`, [D]);
  const sums = await q(`SELECT driver_ext_id, sum(online_min)::float8 s FROM driver_online_hour WHERE day = $1 GROUP BY 1 ORDER BY 1`, [D]);
  check('a driver’s hours add up to their driver_day.online_min',
    dd.length === 2 && dd.every((d) => Math.abs(d.online_min - sums.find((s) => s.driver_ext_id === d.driver_ext_id).s) <= 1),
    JSON.stringify([dd, sums]));
}

console.log('\na narrow pass rewrites its own days, and sweeps what a span no longer covers');
await q(`INSERT INTO driver_online_hour (platform, driver_ext_id, fleet_id, hour_start, day, hour, online_min, computed_at)
         VALUES ('uber','ghost','ecosine',$1::timestamptz,$2::date,15,30, now() - interval '1 day'),
                ('uber','old','ecosine',$3::timestamptz,$4::date,15,30, now() - interval '1 day')`,
[T('15:00'), D, T('15:00', '2026-09-20'), '2026-09-20']);
await refreshOnlineHours(db, { since: D });
const ghosts = await q(`SELECT driver_ext_id FROM driver_online_hour WHERE driver_ext_id IN ('ghost','old') ORDER BY 1`);
check('an hour inside the pass that no span produces is removed', !ghosts.some((g) => g.driver_ext_id === 'ghost'), JSON.stringify(ghosts));
check('an hour before the pass’s first day is kept — the store outlives the timeline', ghosts.some((g) => g.driver_ext_id === 'old'), JSON.stringify(ghosts));
check('the day’s real hours survive the narrow pass', (await q(`SELECT count(*)::int n FROM driver_online_hour WHERE day = $1`, [D]))[0].n === 6);

const { get } = await mountAll(db);

console.log('\n/api/online/hours — a past day, from the store');
{
  const r = (await get(`/api/online/hours?day=${D}`)).body;
  const h = (n) => r.hours[n];
  check('hour 9: two drivers, 1.2 driver-hours, 1.2 online at once on average',
    h(9).drivers === 2 && h(9).online_h === 1.2 && h(9).avg_online === 1.2 && h(9).state === 'recorded', JSON.stringify(h(9)));
  check('hour 11: one driver, five minutes', h(11).drivers === 1 && h(11).online_h === 0.1, JSON.stringify(h(11)));
  check('hour 3: nobody, and still a recorded hour (zero, not absent)', h(3).drivers === 0 && h(3).state === 'recorded', JSON.stringify(h(3)));
  const a = r.drivers.find((d) => d.driver_ext_id === 'acc-a');
  check('each driver’s 24 hours, named, first and last hour online',
    a && a.name === 'Test Driver Alpha' && a.minutes[8] === 50 && a.total_min === 140 && a.first_hour === 8 && a.last_hour === 10, JSON.stringify(a));
  check('the totals: 2 drivers, 3.6 driver-hours, the peak at 9 with 2', r.totals.drivers === 2 && r.totals.online_h === 3.6
    && r.totals.peak_hour === 9 && r.totals.peak_drivers === 2, JSON.stringify(r.totals));
  check('no live minutes on a past day', r.live_from === null && r.drivers.every((d) => d.live.every((x) => !x)));
  const eg = (await get(`/api/online/hours?day=${D}&fleet=egari`)).body;
  check('the fleet chip narrows to that fleet’s accounts', eg.drivers.length === 1 && eg.drivers[0].driver_ext_id === 'acc-b'
    && eg.hours[9].drivers === 1, JSON.stringify(eg.drivers.map((d) => d.driver_ext_id)));
  const early = (await get('/api/online/hours?day=2026-07-01')).body;
  check('a day before the timeline existed is absent, with that reason', /28 July 2026/.test(early.absent_why || ''), early.absent_why);
  check('a malformed day is a 400', (await get('/api/online/hours?day=01-10-2026')).status === 400);
}

console.log('\n/api/online/hours — today: the timeline to its last run, the live feed after it');
{
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const today = new Date(now + 4 * 3600e3).toISOString().slice(0, 10);
  const se = (id, at, status) => q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status, fleet_id)
                                    VALUES ('uber', $1, $2::timestamptz, $3, 'ecosine')`, [id, at, status]);
  // C online 90 to 30 minutes ago; the live feed polled a moment ago.
  await se('acc-c', iso(now - 90 * 60e3), 'online');
  await se('acc-c', iso(now - 30 * 60e3), 'offline');
  await q(`INSERT INTO driver_status_now (platform, driver_ext_id, fleet_id, status, status_at, observed_at)
           VALUES ('uber','acc-c','ecosine','offline',$1::timestamptz, now())`, [iso(now - 30 * 60e3)]);
  const r = (await get(`/api/online/hours?day=${today}`)).body;
  const c = r.drivers.find((d) => d.driver_ext_id === 'acc-c');
  const total = c ? c.minutes.reduce((x, y) => x + y, 0) : 0;
  check('the live feed fills the hours past the timeline’s last run: C’s hour online',
    c && Math.abs(total - 60) < 1 && c.live.some(Boolean), JSON.stringify(c?.minutes));
  check('…and the response says from when the live feed was read — the timeline’s last run',
    r.live_from && Math.abs(Date.parse(r.live_from) - Date.parse(runAt)) < 1000, JSON.stringify([r.live_from, runAt]));
  const lh = r.hours.filter((h) => h.live_h > 0);
  check('the hours it fills say they rest on the live feed', lh.length > 0 && lh.every((h) => /live/.test(h.state) && h.drivers_live_only >= 1),
    JSON.stringify(lh.map((h) => [h.hour, h.state])));
  check('hours that have not happened yet are future, with no figure',
    r.hours.filter((h) => h.state === 'future').every((h) => h.drivers === null), JSON.stringify(r.hours.filter((h) => h.state === 'future').slice(0, 1)));

  // D comes online 50 minutes ago and never goes off — but the live feed last polled 40 minutes ago.
  await se('acc-d', iso(now - 50 * 60e3), 'online');
  await q(`UPDATE driver_status_now SET observed_at = $1::timestamptz`, [iso(now - 40 * 60e3)]);
  const s = (await get(`/api/online/hours?day=${today}`)).body;
  const d = s.drivers.find((x) => x.driver_ext_id === 'acc-d');
  const dt = d ? d.minutes.reduce((x, y) => x + y, 0) : 0;
  check('a live feed that stopped is not read as everyone still online: D counts to the last poll (10 min), not to now (50)',
    d && Math.abs(dt - 10) < 1, JSON.stringify(d?.minutes));
  /* The timeline's run moves past the live minutes. Until the store is
     rebuilt from that run it holds nothing for them, so they are still the
     live feed's — calling them "recorded" read them from an empty store as
     nobody online (production, 2026-10-14). The rollup that follows every
     collection rebuilds; after it they are the timeline's, and the live feed
     is not read for them. */
  await q(`UPDATE collection_run SET finished_at = now() WHERE source = 'uber_timeline'`);
  const t1 = (await get(`/api/online/hours?day=${today}`)).body;
  const c1 = t1.drivers.find((x) => x.driver_ext_id === 'acc-c');
  const cBefore = s.drivers.find((x) => x.driver_ext_id === 'acc-c');
  const sum = (x) => (x ? x.minutes.reduce((a, b) => a + b, 0) : -1);
  check('a newer timeline run the store has not been built from yet does not empty the hours: C’s minutes still count, from the live feed',
    c1 && sum(cBefore) > 0 && Math.abs(sum(c1) - sum(cBefore)) < 1 && c1.live.some(Boolean)
      && !t1.hours.some((h) => h.state === 'recorded' && h.live_h > 0), JSON.stringify(c1?.minutes));
  await refreshOnlineHours(db);
  const t2 = (await get(`/api/online/hours?day=${today}`)).body;
  check('once the store is built from that run, the live feed is not read for its hours — no minute counted from both',
    t2.drivers.every((x) => x.live.every((f) => !f)), JSON.stringify(t2.drivers.map((x) => [x.driver_ext_id, x.live.filter(Boolean).length])));
}

console.log('\n/api/online/hours/range — day × hour, from the store');
{
  const r = (await get('/api/online/hours/range?from=2026-09-30&to=2026-10-01')).body;
  const d1 = r.days.find((d) => d.day === D);
  const d0 = r.days.find((d) => d.day === '2026-09-30');
  check('a recorded day: drivers by hour, its total and its peak', d1 && d1.drivers[9] === 2 && d1.drivers[11] === 1
    && d1.total_h === 3.6 && d1.peak === 2 && d1.complete === true, JSON.stringify(d1));
  check('a day with nobody online is a row with its reason, not a missing row',
    d0 && d0.drivers === null && /no Uber account was recorded online/.test(d0.absent_why || ''), JSON.stringify(d0));
  check('the per-hour average is over the recorded days only', r.days_averaged === 1 && r.avg_drivers_by_hour[9] === 2, JSON.stringify([r.days_averaged, r.avg_drivers_by_hour[9]]));
}

console.log('\nan hour the store has not been built for is never a zero');
{
  /* No pass has recorded what it built — the state of production straight
     after the deploy that added the table. */
  await q('DELETE FROM driver_online_hour_build');
  const r = (await get(`/api/online/hours?day=${D}`)).body;
  check('no hour is "recorded" when no pass has said what it built', !r.hours.some((h) => /recorded/.test(h.state)),
    JSON.stringify(r.hours.map((h) => h.state).slice(8, 12)));
  check('…and the day says the record has not been built, not that nobody was online',
    /has not been built/.test(r.absent_why || '') && !/^no Uber account/.test(r.absent_why || ''), r.absent_why);
  const pre = (await get('/api/online/hours?day=2026-09-01')).body;
  check('a day before the live feed began, unbuilt: every hour not_built, no figure — never "live, nobody online"',
    pre.hours.every((h) => h.state === 'not_built' && h.drivers === null && h.online_h === null) && pre.live_from === null,
    JSON.stringify([pre.hours[9], pre.live_from]));
  check('…and its totals are absent, not zero', pre.totals.drivers === null && pre.totals.online_h === null, JSON.stringify(pre.totals));

  // A narrow pass from D: built back to D, and no further.
  await refreshOnlineHours(db, { since: D });
  const rg = (await get('/api/online/hours/range?from=2026-09-30&to=2026-10-01')).body;
  const a = rg.days.find((d) => d.day === '2026-09-30');
  const b = rg.days.find((d) => d.day === D);
  check('a narrow pass builds back to its own first day: the day before says it has not been built back to yet',
    a && a.drivers === null && /not been built back to this day/.test(a.absent_why || '') && b && b.complete === true,
    JSON.stringify([a, b && b.complete]));
  check('…and that day is not averaged as a day with nobody online', rg.days_averaged === 1, String(rg.days_averaged));
  const r2 = (await get(`/api/online/hours?day=${D}`)).body;
  check('the built day reads recorded again', r2.hours[9].state === 'recorded' && r2.hours[9].drivers === 2, JSON.stringify(r2.hours[9]));

  // The full pass builds all of history: the earlier day is now recorded as empty.
  await refreshOnlineHours(db);
  const rg2 = (await get('/api/online/hours/range?from=2026-09-30&to=2026-10-01')).body;
  check('after a full pass the earlier day is recorded — and empty, said as such',
    /no Uber account was recorded online/.test(rg2.days.find((d) => d.day === '2026-09-30')?.absent_why || ''),
    JSON.stringify(rg2.days.find((d) => d.day === '2026-09-30')));
  const st = (await q('SELECT built_from::text f FROM driver_online_hour_build'))[0];
  check('a narrow pass after the full one does not shrink what is built', await (async () => {
    await refreshOnlineHours(db, { since: D });
    const s2 = (await q('SELECT built_from::text f FROM driver_online_hour_build'))[0];
    return st.f === '1900-01-01' && s2.f === '1900-01-01';
  })(), JSON.stringify(st));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
