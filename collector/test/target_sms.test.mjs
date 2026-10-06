/* The 13:00 / 18:00 goal texts (src/target_sms.js), on synthetic drivers.

   The operator's rules, 2026-10-06: one fixed daily goal for everyone
   (low_trips_min, trips counted across every app), nothing to a driver on
   pace, the text points at AREAS, English only, a dry run first. What this
   pins:
     1. the text: one GSM-7 segment, the goal, what is done and left, the
        busy areas; a name that is not plain letters is dropped, not mangled;
     2. the rule: not started / at the goal / on pace (85% of what a usual day
        has reported by now) are left alone; a stale channel holds;
     3. a run in DRY mode writes every decision, held 'dry_run', sends nothing;
        the skipped are counted on the run row; a second run does nothing;
     4. ON sends exactly the behind drivers with a usable number; OFF records
        that it was off;
     5. stale data waits, and at :30 gives up for the slot;
     6. the areas come from booked pickups at the slot's hours, named by
        place_cell and cleaned, busiest first. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { nudgeText, judge, busyAreas, targetNudgeRun, ON_PACE } from '../src/target_sms.js';
import { encodingFor } from '../src/smsala.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('1. the text');
{
  const t = nudgeText({ name: 'Mohammed Fazlul Karim', goal: 12, done: 3, areas: ['Al Barsha', 'Dubai Marina', 'Deira'], window: '1-5 PM' });
  check('goal, done, left and two areas', t === 'Hi Mohammed, your goal today is 12 trips. You have 3, 9 to go. Busy 1-5 PM: Al Barsha, Dubai Marina. Stay online there to reach it.', t);
  check('one GSM-7 segment', t.length <= 160 && encodingFor(t) === '0');
  const odd = nudgeText({ name: 'Ñandu Ö', goal: 12, done: 0, areas: [], window: '6-10 PM' });
  check('a name that is not plain letters is dropped; no areas reads as hours',
    odd === 'Hi, your goal today is 12 trips. You have 0, 12 to go. The busy hours are 6-10 PM. Stay online then to reach it.', odd);
  const long = nudgeText({ name: 'Bartholomew', goal: 12, done: 1,
    areas: ['Jumeirah Village Circle District', 'International Media Production Zone'], window: '6-10 PM' });
  check('too long: cut down until it fits one segment', long.length <= 160 && encodingFor(long) === '0' && /11 to go/.test(long), `${long.length} ${long}`);
}

console.log('2. the rule');
{
  const base = { goal: 12, frac: 0.35, started: true, channelsFresh: true };
  check('not started is left alone', judge({ ...base, done: 0, started: false }).skip === 'not_started');
  check('at the goal is left alone', judge({ ...base, done: 12 }).skip === 'goal_met');
  const need = 12 * 0.35;
  check(`on pace at ${ON_PACE * 100}% of need-by-now`, judge({ ...base, done: Math.ceil(need * ON_PACE) }).skip === 'on_pace');
  check('below it is behind (3 of 4.2 due)', judge({ ...base, done: 3 }).behind === true);
  check('behind on a stale channel holds rather than texts', judge({ ...base, done: 0, channelsFresh: false }).hold === 'channel_not_fresh');
  check('online with no trips yet counts as started and behind', judge({ ...base, done: 0 }).behind === true);
}

/* ── a database: six drivers at 13:05 Dubai on 2026-10-06 ─────────────── */
const db = new PGlite();
await applySchema(db);
const q = async (sql, p) => (await db.query(sql, p)).rows;
const NOW = new Date('2026-10-06T09:05:00Z');            // 13:05 Dubai
const D = '2026-10-06';
const P = [ // person, name, platform, ext, fleet, done today, phone, online today
  ['1', 'Ahmed Khan', 'uber', 'u1', 'ecosine', 1, '0501111111', false],    // behind → texted
  ['2', 'Bilal Haq', 'uber', 'u2', 'ecosine', 6, '0502222222', false],     // on pace
  ['3', 'Chen Li', 'bolt', 'b3', 'ecosine', 0, '0503333333', false],       // not started
  ['4', 'Dev Rai', 'uber', 'u4', 'egari', 12, '0504444444', false],        // at the goal
  ['5', 'Eli Sami', 'yango', 'y5', 'ecosine', 1, '0505555555', false],     // stale channel
  ['6', 'Fadi Noor', 'uber', 'u6', 'egari', 0, null, true],                // online, no trips, no number
];
let n = 0;
for (const [id, name, plat, ext, fleet, today, phone, online] of P) {
  await q(`INSERT INTO driver (id, full_name) VALUES ($1, $2)`, [Number(id), name]);
  await q(`INSERT INTO driver_platform_id (driver_id, platform, external_id) VALUES ($1, $2, $3)`, [Number(id), plat, ext]);
  if (phone) await q(`INSERT INTO driver_compliance (platform, driver_ext_id, phone, fleet_id) VALUES ($1, $2, $3, $4)`, [plat, ext, phone, fleet]);
  // active: a completed trip three days ago
  await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, requested_at, status) VALUES ($1, $2, $3, $4, $5, 'completed')`,
    [plat, `h${n += 1}`, fleet, ext, '2026-10-03T08:00:00Z']);
  for (let i = 0; i < today; i += 1) {
    await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, requested_at, status) VALUES ($1, $2, $3, $4, $5, 'completed')`,
      [plat, `t${n += 1}`, fleet, ext, new Date(Date.parse('2026-10-06T02:00:00Z') + i * 60000).toISOString()]);
  }
  if (online) await q(`INSERT INTO driver_status_event (platform, driver_ext_id, at, status) VALUES ('uber', $1, $2, 'online')`, [ext, '2026-10-06T06:00:00Z']);
}
for (const [src, fleet] of [['uber', 'ecosine'], ['uber', 'egari'], ['bolt', 'ecosine']]) {
  await q(`INSERT INTO collection_run (source, fleet_id, mode, status, window_start, window_end, started_at, finished_at)
           VALUES ($1, $2, 'incremental', 'ok', '2026-10-03', '2026-10-06', $3, $3)`, [src, fleet, '2026-10-06T08:40:00Z']);
}
// Areas: booked pickups at 13-16 Dubai on earlier days, in two named cells; one cell's name is a code.
await q(`INSERT INTO place_cell (cell_lat, cell_lng, area, n, distinct_names, observations) VALUES
         (5020, 11040, 'Al Barsha, Dubai', 40, 1, 40), (5016, 11028, 'Dubai Marina', 30, 1, 30), (5030, 11050, 'X9', 50, 1, 50)`);
const seg = async (k, lat, lng, at) => q(`INSERT INTO occupancy_segment (plate, started_at, ended_at, source, verdict, start_lat, start_lng)
  VALUES ($1, $2, $2::timestamptz + interval '20 minutes', 'fms_trip', 'authorized', $3, $4)`, [`P${k}`, at, lat, lng]);
let k = 0;
for (let d = 1; d <= 5; d += 1) {
  const day = `2026-10-0${d}`;
  for (let i = 0; i < 3; i += 1) await seg(k += 1, 25.1, 55.2, `${day}T10:${10 + i}:00Z`);   // Al Barsha 14:xx Dubai
  await seg(k += 1, 25.08, 55.14, `${day}T11:00:00Z`);                                     // Marina 15:00 Dubai
  await seg(k += 1, 25.15, 55.25, `${day}T10:30:00Z`);                                     // the code: dropped
  await seg(k += 1, 25.08, 55.14, `${day}T19:00:00Z`);                                     // 23:00 Dubai: out of the slot
}
const HOURS = { today: D, lag_min: 10, clock: '12:55', cut_at: '2026-10-06T08:55:00Z', trips: { target: 1200, need_by_now: 420 } };

console.log('3. the areas');
{
  const a = await busyAreas(q, 13, { now: NOW });
  check('busiest first, named and cleaned, the code dropped', JSON.stringify(a.map((x) => x.name)) === '["Al Barsha","Dubai Marina"]', JSON.stringify(a));
}

console.log('4. a dry run');
{
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true, messageId: 'x' }; };
  const r = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'dry', low_trips_min: 12 }, send, hours: HOURS });
  check('nothing sent', sent.length === 0 && r.sent === 0);
  check('skipped counted: on pace 1, at the goal 1, not started 1',
    r.skipped.on_pace === 1 && r.skipped.goal_met === 1 && r.skipped.not_started === 1, JSON.stringify(r.skipped));
  const rows = await q(`SELECT person_id::text AS p, status, hold_reason, message_text FROM sms_outbox WHERE kind = 'target_nudge' ORDER BY person_id`);
  const by = Object.fromEntries(rows.map((x) => [x.p, x]));
  check('the behind driver is written, held as a dry run, with the text',
    by['1']?.hold_reason === 'dry_run' && by['1'].status === 'held'
    && by['1'].message_text === 'Hi Ahmed, your goal today is 12 trips. You have 1, 11 to go. Busy 1-5 PM: Al Barsha, Dubai Marina. Stay online there to reach it.',
    JSON.stringify(by['1']));
  check('a driver on a channel not collected lately is held for that', by['5']?.hold_reason === 'channel_not_fresh', JSON.stringify(by['5']));
  check('online, no trips, no number: held for the number', by['6']?.hold_reason === 'no_number', JSON.stringify(by['6']));
  check('nobody on pace, at the goal or not started is written', !by['2'] && !by['3'] && !by['4']);
  const [run] = await q(`SELECT status, detail FROM sms_outbox WHERE kind = 'target_run' AND dedupe_key = 'target-run:2026-10-06:13'`);
  check('the run row is finished and carries the counts', run?.detail?.finished === true && run.detail.behind === 3 && run.detail.mode === 'dry', JSON.stringify(run));
  const again = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'dry', low_trips_min: 12 }, send, hours: HOURS });
  check('a second run in the slot does nothing', again.already === true);
}

console.log('5. on, off, stale');
{
  await q(`DELETE FROM sms_outbox`);
  const sent = [];
  const send = async (m) => { sent.push(m); return { ok: true, messageId: `m${sent.length}` }; };
  const r = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'on', low_trips_min: 12 }, send, hours: HOURS });
  check('on: exactly the behind driver with a usable number is texted', sent.length === 1 && sent[0].to.endsWith('1111111') && r.sent === 1,
    JSON.stringify(sent.map((s) => s.to)));
  const [row] = await q(`SELECT status FROM sms_outbox WHERE kind = 'target_nudge' AND person_id = 1`);
  check('…and recorded as sent', row?.status === 'sent');
  await q(`DELETE FROM sms_outbox`);
  const off = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'off', low_trips_min: 12 }, send, hours: HOURS });
  const [offRow] = await q(`SELECT hold_reason FROM sms_outbox WHERE kind = 'target_run'`);
  check('off: nothing decided, the run says it was off', off.off === true && offRow?.hold_reason === 'switched_off');
  await q(`DELETE FROM sms_outbox`);
  const stale = { ...HOURS, lag_min: 60 };
  const w = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'on', low_trips_min: 12 }, send, hours: stale });
  const g = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'on', low_trips_min: 12 }, send, hours: stale, final: true });
  const [gRow] = await q(`SELECT hold_reason, detail FROM sms_outbox WHERE kind = 'target_run'`);
  check('stale: waits, then gives up at :30 for the slot', w.waiting === true && g.gaveUp === true
    && gRow?.hold_reason === 'data_stale' && gRow.detail.finished === true);
  await q(`DELETE FROM sms_outbox`);
  const none = await targetNudgeRun({ q, now: NOW, cfg: { sms_target: 'on', low_trips_min: 12 }, send: async () => ({ ok: true }),
    hours: { ...HOURS, trips: { absent: 'No target.' } } });
  check('no trips target: nobody judged', none.held === 'no_target_curve', JSON.stringify(none));
}

console.log(`\n${pass} passed, ${fail} failed`);
await db.close();
process.exit(fail ? 1 : 0);
