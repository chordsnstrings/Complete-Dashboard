/* /api/history — the series behind a page's hero tile, from the roll-ups.
   ──────────────────────────────────────────────────────────────────────────
   api/history_routes.js makes three promises and each has a section here.

   1. THE SAME FIGURE AS THE TILE. Every point of #online-time's Late line is
      compared with what /api/online-time answers for that day and that start
      — including a person with two Uber accounts (one person, judged on the
      earlier), a driver Uber dropped from the roster who still drove (on the
      page, so on the line), and an account that came online but is neither on
      the roster nor drove (on neither). Every point of the cancellations line
      is compared with /api/cancellations over that one day. The cash ceiling
      at the last point is compared with the sum #deposits makes of
      /api/ledger/exposure over the people /api/ledger/people lists.

   2. A POINT THAT WAS NOT MEASURED IS NULL WITH ITS TRUE REASON: today, a day
      no booking channel reported, a channel that reported nothing while the
      fleet did, a day the timeline had not been read past, a week still
      running, a week with bookings and no money yet, a missing start time
      (worded exactly as /api/online-time words it), a roll-up never built.

   3. THE FLEET CHIP IS HONOURED, on every series.

   Plus the roll-ups themselves: an incremental pass deletes inside its bound
   what its source no longer supports, and records how far back it is built. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { refreshRollups } from '../src/rollup.js';
import { refreshFirstOnline, refreshCashFareDay } from '../src/history_rollup.js';
import { dubaiIso } from '../src/util.js';
import { historyWindow, PAGES, METRICS, DAY_CAP, WEEK_CAP, addDays, mondayOf } from '../api/history_routes.js';
/* §6: the shipped access entry, role templates, page subjects and shaping. */
import { lookupEntry } from '../api/access/manifest.js';
import { shapeBody } from '../api/access/shape.js';
import { ROLE, ROLES } from '../api/public/access_model.js';
import { VIEW_SUBJECT } from '../api/public/access.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
const { get, server } = await mountAll(db);
const TODAY = dubaiIso();

/* ── the week of 5–9 October 2026, after the timeline record began ───────── */
const D = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
const QUIET = '2026-10-10';            // nothing from any channel
const at = (day, hm) => `${day}T${hm}:00+04:00`;

const state = (o) => q(
  `INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, state_raw, can_earn)
   VALUES ($1,$2,$3,$4,'active','ACTIVE',true)`, [o.platform || 'uber', o.id, o.fleet || 'ecosine', o.name]);
const ev = (id, when, fleet = 'ecosine', status = 'ONLINE') => q(
  `INSERT INTO driver_timeline_event (platform, driver_ext_id, fleet_id, at, kind, status, state)
   VALUES ('uber',$1,$2,$3::timestamptz,'status',$4,'')`, [id, fleet, when, status]);
let tn = 0;
const trip = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at,
                     distance_km, status, price, payment_type)
   VALUES ($1,$2,$3,'L1',$4,$5,$6::timestamptz,10,$7,$8,$9)`,
  [o.platform || 'uber', `h${tn++}`, o.fleet || 'ecosine', o.id ?? null, o.name ?? null, o.at,
    o.status || 'completed', o.price ?? null, o.pay ?? 'card']);

/* The roster. */
await state({ id: 'u-early', name: 'Ali Early' });
await state({ id: 'u-late', name: 'Badr Late' });
await state({ id: 'u-two-a', name: 'Cyrus Two', fleet: 'egari' });
await state({ id: 'u-two-b', name: 'Cyrus Two', fleet: 'egari' });
await state({ id: 'u-none', name: 'Dina None' });
await state({ platform: 'hotel', id: 'h-dina', name: 'Dina None' });

/* When each came online. */
await ev('u-early', at(D[0], '05:40')); await ev('u-early', at(D[1], '05:40')); await ev('u-early', at(D[2], '06:20'));
await ev('u-late', at(D[0], '07:15')); await ev('u-late', at(D[1], '06:00')); await ev('u-late', at(D[2], '06:01'));
await ev('u-late', at(D[3], '09:10')); await ev('u-late', at(D[4], '05:00'));
/* One person, two accounts: 06:30 on one and 05:50 on the other is on time. */
await ev('u-two-a', at(D[0], '06:30'), 'egari'); await ev('u-two-b', at(D[0], '05:50'), 'egari');
await ev('u-two-a', at(D[1], '06:45'), 'egari');
/* An OFFLINE first does not start anything; the ONLINE after it does. */
await ev('u-early', at(D[3], '04:00'), 'ecosine', 'OFFLINE'); await ev('u-early', at(D[3], '08:30'));
/* Dropped from the roster, still drove Uber on D[1]: on the page that day. */
await ev('u-gone', at(D[1], '07:30'), 'egari');
await trip({ id: 'u-gone', name: 'Emad Gone', fleet: 'egari', at: at(D[1], '08:00') });
/* Came online on D[0] but neither on the roster nor driving: on no page. */
await ev('u-gone', at(D[0], '07:00'), 'egari');
/* Today: the tile counts it, the line does not draw today. */
await ev('u-late', `${TODAY}T07:00:00+04:00`);

/* The bookings behind the cancellations line, on two channels and two fleets. */
for (const [i, d] of D.entries()) {
  await trip({ id: 'u-early', name: 'Ali Early', at: at(d, '09:00') });
  await trip({ id: 'u-early', name: 'Ali Early', at: at(d, '10:00'), status: i % 2 ? 'rider_cancelled' : 'completed' });
  await trip({ id: 'u-late', name: 'Badr Late', at: at(d, '11:00'), status: 'driver_cancelled' });
  if (i !== 2) await trip({ platform: 'bolt', id: 'b-1', name: 'Faris Bolt', fleet: 'egari', at: at(d, '12:00'),
    status: i === 0 ? 'driver_cancelled_after_accept' : 'completed', price: 30 });
}
/* A cancelled booking nobody is attached to still counts, on both sides. */
await trip({ name: null, id: null, at: at(D[3], '13:00'), status: 'rider_cancelled' });

/* Every fleet's timeline read past the week. */
for (const f of ['ecosine', 'egari']) {
  await q(`INSERT INTO collection_run (source, fleet_id, mode, status, started_at, finished_at, window_start, window_end)
           VALUES ('uber_timeline',$1,'incremental','ok',$2::timestamptz,$2::timestamptz,$3::date,$4::date)`,
    [f, at('2026-10-11', '03:00'), '2026-10-09', '2026-10-11']);
}

await refreshRollups({ db });

const H = async (qs) => (await get(`/api/history?${qs}`));
const pointsOf = (body, m) => Object.fromEntries((body?.series?.[m]?.points || []).map((p) => [p.d, p]));

/* ══ 0. what it refuses, and the window ══════════════════════════════════ */
console.log('\nthe request');
{
  const r = await H('');
  check('no page: 400, naming the pages that carry a history', r.status === 400 && r.body.pages?.includes('online-time'),
    JSON.stringify(r.body));
  const m = await H('page=deposits&metrics=late');
  check('a series the page does not carry: 400, naming the ones it does',
    m.status === 400 && JSON.stringify(m.body.metrics) === JSON.stringify(PAGES.deposits.metrics), JSON.stringify(m.body));
  const p = await H('page=performer');
  check('#performer without an account: 400 — it is one person\'s page', p.status === 400, JSON.stringify(p.body));
  const def = await H('page=online-time&start=06:00');
  check('no window: the page\'s own span, ending today', def.body.to === TODAY && def.body.from === addDays(TODAY, -13),
    `${def.body.from} → ${def.body.to}`);
  const wk = await H('page=deposits');
  check('…in whole weeks for a weekly page', wk.body.from === addDays(mondayOf(TODAY), -77), wk.body.from);
  const fut = historyWindow({ query: { from: addDays(TODAY, 3), to: addDays(TODAY, 9) } }, PAGES.cancellations, TODAY);
  check('a window that starts after today is "no history yet", not an empty calendar', fut.future === true);
  const open = historyWindow({ query: { from: '2000-01-01', to: '2100-01-01' } }, PAGES.cancellations, TODAY);
  check(`an open window is cut to the last ${DAY_CAP} days, ending today, and says so`,
    open.to === TODAY && open.from === addDays(TODAY, -(DAY_CAP - 1)) && /400/.test(open.cut || ''), JSON.stringify(open));
  const openW = historyWindow({ query: { from: '2000-01-01' } }, PAGES.performer, TODAY);
  check(`…and a weekly one to the last ${WEEK_CAP} weeks`, openW.from === addDays(mondayOf(TODAY), -7 * (WEEK_CAP - 1)) && !!openW.cut,
    JSON.stringify(openW));
  const f = await H(`page=cancellations&from=${addDays(TODAY, 2)}&to=${addDays(TODAY, 5)}`);
  check('…and answered with every series absent, with that reason',
    /begins after today/.test(f.body.series?.cancelled?.absent || ''), JSON.stringify(f.body.series));
}

/* ══ 1. Late, against /api/online-time ═══════════════════════════════════ */
console.log('\n#online-time: Late is the tile\'s count, day by day');
for (const start of ['06:00', '07:00', '05:45']) {
  const h = await H(`page=online-time&from=${D[0]}&to=${QUIET}&start=${start}`);
  const pts = pointsOf(h.body, 'late');
  const diffs = [];
  for (const d of D) {
    const ot = await get(`/api/online-time?day=${d}&start=${start}`);
    const want = ot.body?.totals?.late;
    if (pts[d]?.v !== want) diffs.push(`${d}: line ${pts[d]?.v} (${pts[d]?.why}) vs tile ${want}`);
  }
  check(`start ${start}: every day of the week equals /api/online-time's Late`, diffs.length === 0, diffs.join(' | '));
}
{
  const h = await H(`page=online-time&from=${D[0]}&to=${QUIET}&start=06:00`);
  const pts = pointsOf(h.body, 'late');
  /* The arithmetic the equality rests on, spelled out once. */
  check('5 Oct: Badr 07:15 late; Cyrus on time on his other account (05:50); the stranger at 07:00 not counted → 1',
    pts[D[0]].v === 1, JSON.stringify(pts[D[0]]));
  check('6 Oct: Badr at 06:00 exactly is on time; Cyrus 06:45 and the roster-dropped driver 07:30 are late → 2',
    pts[D[1]].v === 2, JSON.stringify(pts[D[1]]));
  check('8 Oct: an OFFLINE at 04:00 starts nothing, so Ali\'s 08:30 is his first online → Ali and Badr late → 2',
    pts[D[3]].v === 2, JSON.stringify(pts[D[3]]));
  check('a day no account came online is a gap with that reason, not a morning nobody was late',
    pts[QUIET].v === null && /no Uber account has an online event/.test(pts[QUIET].why), JSON.stringify(pts[QUIET]));
  check('it names the expected start it judged against', h.body.series.late.expected_start === '06:00');

  const t = await H(`page=online-time&from=${addDays(TODAY, -2)}&to=${TODAY}&start=06:00`);
  const tp = pointsOf(t.body, 'late')[TODAY];
  const tile = (await get(`/api/online-time?day=${TODAY}&start=06:00`)).body?.totals?.late;
  check('today: the tile counts today (Badr, 07:00)…', tile === 1, String(tile));
  check('…and the line leaves today out, saying why', tp?.v === null && /still being collected/.test(tp?.why || ''),
    JSON.stringify(tp));

  const old = await H('page=online-time&from=2026-07-20&to=2026-07-30&start=06:00');
  const op = pointsOf(old.body, 'late');
  check('a day before Uber\'s timeline record began says so',
    op['2026-07-20']?.v === null && /begins on 28 Jul 2026/.test(op['2026-07-20']?.why || ''), JSON.stringify(op['2026-07-20']));

  for (const raw of ['', 'half seven']) {
    const a = await H(`page=online-time&from=${D[0]}&to=${D[4]}&start=${encodeURIComponent(raw)}`);
    const ot = await get(`/api/online-time?day=${D[0]}&start=${encodeURIComponent(raw)}`);
    check(`start "${raw}": absent, in exactly the words the page's own tile uses`,
      a.body.series.late.absent && a.body.series.late.absent === ot.body.start_why && !a.body.series.late.points.length,
      `${a.body.series.late.absent} | ${ot.body.start_why}`);
  }
  const bolt = await H(`page=online-time&from=${D[0]}&to=${D[4]}&start=06:00&platform=bolt`);
  check('a channel filter other than Uber: absent, because only Uber reports coming online',
    /only feed here that reports anybody coming online/.test(bolt.body.series.late.absent || ''), bolt.body.series.late.absent);

  /* THE FLEET CHIP. Egari holds Cyrus (late on the 6th) and the dropped driver
     (late on the 6th); Ecosine holds Ali and Badr. */
  const eg = pointsOf((await H(`page=online-time&from=${D[0]}&to=${D[4]}&start=06:00&fleet=egari`)).body, 'late');
  const ec = pointsOf((await H(`page=online-time&from=${D[0]}&to=${D[4]}&start=06:00&fleet=ecosine`)).body, 'late');
  check('fleet=egari: 0 on the 5th (Cyrus on time), 2 on the 6th', eg[D[0]].v === 0 && eg[D[1]].v === 2,
    JSON.stringify([eg[D[0]], eg[D[1]]]));
  check('fleet=ecosine: 1 on the 5th (Badr), 0 on the 6th, and the two fleets add up to the whole',
    ec[D[0]].v === 1 && ec[D[1]].v === 0
      && D.every((d) => (eg[d].v ?? 0) + (ec[d].v ?? 0) === pts[d].v), JSON.stringify(D.map((d) => [eg[d].v, ec[d].v, pts[d].v])));

  /* A fleet whose timeline has not been read past a day holds that day back
     for everyone — the earliest fleet decides. */
  await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, state_raw, can_earn)
           VALUES ('uber','u-third','third','Gul Third','active','ACTIVE',true)`);
  await q(`INSERT INTO collection_run (source, fleet_id, mode, status, started_at, finished_at)
           VALUES ('uber_timeline','third','incremental','ok',$1::timestamptz,$1::timestamptz)`, [at(D[2], '02:00')]);
  await refreshFirstOnline(db, { since: D[0] });
  const behind = pointsOf((await H(`page=online-time&from=${D[0]}&to=${D[4]}&start=06:00`)).body, 'late');
  check('a fleet read only to 7 Oct: the 7th onwards are gaps saying the timeline had not been read past them',
    behind[D[1]].v === 2 && behind[D[2]].v === null && /had been read only to 7 Oct 2026/.test(behind[D[2]].why || ''),
    JSON.stringify([behind[D[1]], behind[D[2]]]));
  const mine = pointsOf((await H(`page=online-time&from=${D[0]}&to=${D[4]}&start=06:00&fleet=ecosine`)).body, 'late');
  check('…while a fleet chip on a fleet that WAS read draws every day', mine[D[2]].v === ec[D[2]].v && mine[D[2]].v != null,
    JSON.stringify(mine[D[2]]));
  await q(`DELETE FROM collection_run WHERE fleet_id = 'third'`);
  await q(`DELETE FROM driver_platform_state WHERE fleet_id = 'third'`);
}

/* ══ 2. the roll-ups themselves ══════════════════════════════════════════ */
console.log('\nthe first-online and cash roll-ups');
{
  const [b] = await q(`SELECT built_from::text AS f FROM history_rollup_build WHERE name = 'driver_first_online'`);
  check('a full pass records that it is built back to the start of time', String(b?.f).startsWith('1900-01-01'), JSON.stringify(b));
  await ev('u-none', at(D[4], '06:10'));
  await refreshFirstOnline(db, { since: D[4] });
  const [r1] = await q(`SELECT count(*)::int n FROM driver_first_online WHERE driver_ext_id = 'u-none'`);
  await q(`DELETE FROM driver_timeline_event WHERE driver_ext_id = 'u-none'`);
  await refreshFirstOnline(db, { since: D[4] });
  const [r2] = await q(`SELECT count(*)::int n FROM driver_first_online WHERE driver_ext_id = 'u-none'`);
  check('a narrow pass writes what its bound reaches, and deletes inside its bound what the source withdrew',
    r1.n === 1 && r2.n === 0, `${r1.n} → ${r2.n}`);
  const [b2] = await q(`SELECT built_from::text AS f FROM history_rollup_build WHERE name = 'driver_first_online'`);
  check('…and a narrow pass never moves the built-from day forward', String(b2?.f).startsWith('1900-01-01'), JSON.stringify(b2));
  const [kept] = await q(`SELECT count(*)::int n FROM driver_first_online WHERE day < $1::date`, [D[4]]);
  check('…nor touches a day outside its bound', kept.n > 0, String(kept.n));
}

/* ══ 3. cancellations, against /api/cancellations ════════════════════════ */
console.log('\n#cancellations: the line is the tile\'s count, day by day');
{
  const h = await H(`page=cancellations&from=${D[0]}&to=${QUIET}`);
  const pts = pointsOf(h.body, 'cancelled');
  const diffs = [];
  for (const d of D) {
    const c = await get(`/api/cancellations?from=${d}&to=${d}`);
    if (pts[d]?.v !== c.body?.totals?.cancelled) diffs.push(`${d}: ${pts[d]?.v} vs ${c.body?.totals?.cancelled}`);
  }
  check('every day equals /api/cancellations over that day (the unattached cancellation included)', diffs.length === 0,
    diffs.join(' | '));
  check('8 Oct counts the cancelled booking nobody is attached to', pts[D[3]].v === 3, JSON.stringify(pts[D[3]]));
  check('a day no booking channel reported is a gap, not "no cancellations"',
    pts[QUIET].v === null && /no booking channel reported anything/.test(pts[QUIET].why), JSON.stringify(pts[QUIET]));
  const b = pointsOf((await H(`page=cancellations&from=${D[0]}&to=${D[4]}&platform=bolt`)).body, 'cancelled');
  check('platform=bolt: the Bolt cancellation on the 5th, a real zero on the 6th',
    b[D[0]].v === 1 && b[D[1]].v === 0, JSON.stringify([b[D[0]], b[D[1]]]));
  check('…and the 7th, when Bolt reported nothing while Uber did, is a gap that says it cannot tell quiet from uncollected',
    b[D[2]].v === null && /quiet day and a day this channel was not collected/.test(b[D[2]].why), JSON.stringify(b[D[2]]));
  const eg = pointsOf((await H(`page=cancellations&from=${D[0]}&to=${D[4]}&fleet=egari`)).body, 'cancelled');
  const ec = pointsOf((await H(`page=cancellations&from=${D[0]}&to=${D[4]}&fleet=ecosine`)).body, 'cancelled');
  check('fleet=egari is Bolt\'s egari bookings only; ecosine is the Uber ones', eg[D[0]].v === 1 && ec[D[0]].v === 1,
    JSON.stringify([eg[D[0]], ec[D[0]]]));
  const t = pointsOf((await H(`page=cancellations&from=${addDays(TODAY, -1)}&to=${TODAY}`)).body, 'cancelled');
  check('today is left out, with the reason', t[TODAY]?.v === null && /still being collected/.test(t[TODAY]?.why || ''),
    JSON.stringify(t[TODAY]));
  const o = await H(`page=overview&from=${D[0]}&to=${D[4]}`);
  const daily = (await get(`/api/trips/daily?from=${D[0]}&to=${D[4]}`)).body || [];
  const bk = pointsOf(o.body, 'bookings');
  check('#overview\'s bookings line answers what /api/trips/daily serves, day for day',
    daily.length === 5 && daily.every((r) => bk[r.d]?.v === r.trips), JSON.stringify(daily.map((r) => [r.d, r.trips, bk[r.d]?.v])));
  /* A pass that failed stamps finished_at too, so its time is no guide to
     what the table holds: the line is withheld, saying so. */
  await q(`UPDATE rollup_state SET status = 'error', error = 'deadlock detected' WHERE name = 'rollup_day'`);
  const failed = await H(`page=cancellations&from=${D[0]}&to=${D[4]}`);
  await q(`UPDATE rollup_state SET status = 'ok', error = NULL WHERE name = 'rollup_day'`);
  check('the day roll-up\'s last pass failed: absent, saying the line returns once a pass succeeds',
    /last pass failed/.test(failed.body.series.cancelled.absent || ''), failed.body.series.cancelled.absent);
  const fms = await H(`page=cancellations&from=${D[0]}&to=${D[4]}&platform=fms`);
  check('platform=fms: absent — the trackers record journeys, never bookings — rather than a row of zeros',
    /not a booking channel/.test(fms.body.series.cancelled.absent || '') && fms.body.series.cancelled.grain === 'day',
    JSON.stringify(fms.body.series.cancelled));
}

/* ══ 4. the cash ceiling, against #deposits' own sum ═════════════════════ */
console.log('\n#deposits: the ceiling and who carries one, week by week');
{
  const person = async (name) => (await q(`INSERT INTO driver (full_name) VALUES ($1) RETURNING id`, [name]))[0].id;
  const attach = (pid, platform, ext, detached = false) => q(
    `INSERT INTO driver_platform_id (platform, external_id, driver_id, detached_at) VALUES ($1,$2,$3,$4)`,
    [platform, ext, pid, detached ? new Date().toISOString() : null]);
  const ali = await person('Ali Early');
  const badr = await person('Badr Late');
  const nameless = await person('');
  await attach(ali, 'uber', 'u-early'); await attach(badr, 'uber', 'u-late'); await attach(nameless, 'bolt', 'b-1');
  await attach(badr, 'hotel', 'h-old', true);           // detached: reaches nobody's ceiling
  const cash = (o) => trip({ ...o, pay: 'cash', status: o.status || 'completed' });
  await cash({ id: 'u-early', name: 'Ali Early', at: at('2026-09-14', '09:00'), price: 40 });
  await cash({ id: 'u-early', name: 'Ali Early', at: at('2026-09-23', '09:00'), price: 60 });
  await cash({ id: 'u-late', name: 'Badr Late', at: at('2026-09-23', '19:00'), price: 25.5 });
  await cash({ id: 'u-late', name: 'Badr Late', at: at('2026-09-24', '19:00'), price: 30, status: 'rider_cancelled' });
  await cash({ id: 'u-late', name: 'Badr Late', at: at('2026-09-30', '19:00'), price: null });   // unvalued
  await cash({ platform: 'bolt', id: 'b-1', name: 'Faris Bolt', fleet: 'egari', at: at('2026-09-23', '12:00'), price: 99 });
  await cash({ platform: 'hotel', id: 'h-old', name: 'Badr Late', at: at('2026-09-23', '12:00'), price: 77 });
  await refreshCashFareDay(db);

  const h = await H('page=deposits&from=2026-09-07&to=' + TODAY);
  const ceil = h.body.series.cash_ceiling.points, carr = h.body.series.cash_carriers.points;
  const wk = (d) => ceil.find((p) => p.d === d);
  check('the week before any cash fare: a gap saying nothing is on record yet, not AED 0',
    wk('2026-09-07')?.v === null && /no valued cash fare is on record/.test(wk('2026-09-07')?.why || ''), JSON.stringify(wk('2026-09-07')));
  check('the week of the 14th: Ali\'s 40', wk('2026-09-14')?.v === 40, JSON.stringify(wk('2026-09-14')));
  check('the week of the 21st: 40 + 60 + 25.50 — the cancelled cash trip, the nameless person and the detached account left out',
    wk('2026-09-21')?.v === 125.5, JSON.stringify(wk('2026-09-21')));
  check('a running total never falls', ceil.filter((p) => p.v != null).every((p, i, a) => !i || p.v >= a[i - 1].v));
  const cw = (d) => carr.find((p) => p.d === d)?.v;
  check('carriers: 1 by the 14th, 2 by the 21st; an unvalued cash trip adds nobody', cw('2026-09-14') === 1 && cw('2026-09-21') === 2
    && cw('2026-09-28') === 2, JSON.stringify(carr.map((p) => [p.d, p.v])));

  /* What #deposits states in its hero: ceiling() in ledger_ak.js over
     loadPeople() — the directory's people carrying exposure's figures. */
  const ex = (await get('/api/ledger/exposure')).body;
  const dir = (await get('/api/ledger/people')).body;
  const listed = new Set((dir.people || []).map((p) => Number(p.person_id)));
  const carriers = (ex.people || []).filter((p) => listed.has(Number(p.person_id)) && p.owes?.cash_taken != null);
  const hero = Math.round(carriers.reduce((a, p) => a + Number(p.owes.cash_taken), 0) * 100) / 100;
  const last = ceil[ceil.length - 1];
  check(`the last point is the hero's figure (AED ${hero}) and its carrier count (${carriers.length})`,
    last.v === hero && carr[carr.length - 1].v === carriers.length, JSON.stringify([last, carr[carr.length - 1], hero]));
  check('…as of today, the stock as the roll-up last read it', last.as_of === TODAY && !!h.body.series.cash_ceiling.as_of);
  const eg = await H('page=deposits&from=2026-09-07&to=2026-09-27&fleet=egari');
  check('fleet=egari: the only egari cash fare belongs to the nameless person, so nothing is on record',
    eg.body.series.cash_ceiling.points.every((p) => p.v === null), JSON.stringify(eg.body.series.cash_ceiling.points));
  /* A part-built table is not drawn: a running total built from part of the
     record is wrong at every point. */
  await q(`UPDATE history_rollup_build SET built_from = '2026-09-20' WHERE name = 'cash_fare_day'`);
  const part = await H('page=deposits&from=2026-09-07&to=2026-09-27');
  check('a cash roll-up built back only part of the way: both series absent, saying why',
    /built back to 20 Sept? 2026 only/.test(part.body.series.cash_ceiling.absent || '')
      && !!part.body.series.cash_carriers.absent, part.body.series.cash_ceiling.absent);
  await refreshCashFareDay(db);
}

/* ══ 5. one person's money, week by week ═════════════════════════════════ */
console.log('\n#performer: the person\'s weekly money from the day record');
let perfAnswer = null;   // kept for §6, which shapes it for a role without earnings
{
  const db2 = new PGlite();
  await applySchema(db2);
  const m2 = await mountAll(db2);
  const q2 = (t, p = []) => db2.query(t, p).then((r) => r.rows);
  const day = (o) => q2(
    `INSERT INTO driver_day (driver_ext_id, day, fleet_id, platforms, trips, money, money_source, person_key)
     VALUES ($1,$2::date,$3,$4,$5,$6,$7,$8)`,
    [o.id, o.day, o.fleet || 'ecosine', o.platforms ?? ['uber'], o.trips ?? 0, o.money ?? null,
      o.money == null ? 'none' : (o.src || 'statement'), o.pk ?? 'hana']);
  const H2 = async (qs) => (await m2.get(`/api/history?page=performer&${qs}`));
  const before = await H2('id=u-hana&from=2026-09-07&to=2026-10-04');
  check('no driver-day pass yet: absent, saying the roll-up has not been built', /has not been built yet/.test(before.body.series.money.absent || ''),
    before.body.series.money.absent);
  await q2(`INSERT INTO rollup_state (name, started_at, finished_at, status) VALUES ('driver_day', now(), now(), 'ok')`);
  /* Week of 7 Sep: two accounts, one person — 100 on Uber's statement, 50 of hotel fares. */
  await day({ id: 'u-hana', day: '2026-09-08', trips: 5, money: 100 });
  await day({ id: 'h-hana', day: '2026-09-09', trips: 2, money: 50, src: 'fares', platforms: ['hotel'], fleet: 'egari' });
  /* Week of 14 Sep: bookings, nothing reported yet. Week of 21 Sep: nothing at all. */
  await day({ id: 'u-hana', day: '2026-09-15', trips: 7 });
  /* Week of 28 Sep: a statement-only day (no bookings that day). */
  await day({ id: 'u-hana', day: '2026-09-29', trips: 0, money: 80, platforms: null });
  /* Somebody else, who must not leak in. */
  await day({ id: 'u-other', day: '2026-09-08', trips: 3, money: 999, pk: 'other' });
  const h = await H2('id=u-hana&from=2026-09-07&to=2026-10-04');
  const p = pointsOf(h.body, 'money');
  check('7 Sep: both accounts of the person, folded — 150', p['2026-09-07']?.v === 150, JSON.stringify(p['2026-09-07']));
  check('…carrying which kind of money it is', JSON.stringify((p['2026-09-07']?.sources || []).sort()) === '["fares","statement"]',
    JSON.stringify(p['2026-09-07']?.sources));
  /* The count beside the sentence, never in it (review of SPK): a sentence
     reaches every reader of the route, and this is one person's bookings. */
  check('14 Sep: seven bookings and no money yet is a gap that says exactly that — the count its own field',
    p['2026-09-14']?.v === null && p['2026-09-14']?.bookings === 7
      && /^bookings this week, and no statement or priced fare covers them yet$/.test(p['2026-09-14']?.why || ''),
    JSON.stringify(p['2026-09-14']));
  perfAnswer = h.body;
  check('21 Sep: no booking and no money is a gap, never AED 0',
    p['2026-09-21']?.v === null && /no booking and no money on record/.test(p['2026-09-21']?.why || ''), JSON.stringify(p['2026-09-21']));
  check('28 Sep: a statement on a day with no booking still counts — 80', p['2026-09-28']?.v === 80, JSON.stringify(p['2026-09-28']));
  const viaOther = pointsOf((await H2('id=h-hana&from=2026-09-07&to=2026-09-13')).body, 'money');
  check('addressed by the person\'s other account: the same weeks', viaOther['2026-09-07']?.v === 150, JSON.stringify(viaOther));
  const eg = pointsOf((await H2('id=u-hana&from=2026-09-07&to=2026-09-13&fleet=egari')).body, 'money');
  const ub = pointsOf((await H2('id=u-hana&from=2026-09-07&to=2026-10-04&platform=uber')).body, 'money');
  check('fleet=egari: the hotel fares only — 50', eg['2026-09-07']?.v === 50, JSON.stringify(eg));
  check('platform=uber: the Uber account\'s weeks, its statement-only day included — 100 and 80',
    ub['2026-09-07']?.v === 100 && ub['2026-09-28']?.v === 80, JSON.stringify(ub));
  const cur = await H2(`id=u-hana&from=${addDays(mondayOf(TODAY), -7)}&to=${TODAY}`);
  const cp = pointsOf(cur.body, 'money')[mondayOf(TODAY)];
  check('the week still running is a gap that says how many of its days have happened',
    cp?.v === null && /this week is still running — \d of its 7 days so far/.test(cp?.why || ''), JSON.stringify(cp));
  await q2(`UPDATE rollup_state SET status = 'error' WHERE name = 'driver_day'`);
  const bad = await H2('id=u-hana&from=2026-09-07&to=2026-10-04');
  await q2(`UPDATE rollup_state SET status = 'ok' WHERE name = 'driver_day'`);
  check('the driver-day roll-up\'s last pass failed: absent, saying so', /last pass failed/.test(bad.body.series.money.absent || ''),
    bad.body.series.money.absent);
  const nobody = await H2('id=nobody-at-all');
  check('an account no day record holds: absent, saying so', /never seen it/.test(nobody.body.series.money.absent || ''),
    nobody.body.series.money.absent);
  m2.server.close();
}

/* ══ 6. who may see the line ═════════════════════════════════════════════ */
/* The review of SPK (2026-11-12) found the manifest entry's subject was BK.
   The gate refuses a route outright to a role that lacks its subject, so the
   Cash desk (ID CASH SYS) was refused the history on #deposits — the page
   built for it, whose ceiling it is shown — and the HR officer (no BK) on
   #online-time and #cancellations; each page then printed "the history did
   not load", a reason that was not the true one. One route, four pages,
   four page subjects: the only subject every page's reader holds is SYS, and
   each series' values are masked by their own class instead. These checks
   use the shipped manifest entry, the shipped role templates, the shipped
   page subjects and the gate's own shaping code on real answers. */
console.log('\nwho may see the line');
{
  const entry = lookupEntry('GET', '/api/history');
  const LINE_PAGES = ['online-time', 'performer', 'deposits', 'cancellations'];
  const refusedTo = [];
  for (const pg of LINE_PAGES) {
    for (const r of ROLES) if (r.levels[VIEW_SUBJECT[pg]] && !r.levels[entry.subject]) refusedTo.push(`${r.name} on #${pg}`);
  }
  check('every role that can open a page with a line can ask for the line', refusedTo.length === 0, refusedTo.join(', '));
  const unmasked = Object.entries(METRICS).filter(([m, x]) => !x.cls
    || !(entry.fields || []).some((f) => f.class === x.cls && f.paths.includes(`series.${m}.points[].v`)));
  check('every series names its class, and the manifest masks its values by that class', unmasked.length === 0,
    unmasked.map(([m]) => m).join(', '));
  check('…and one person\'s weekly booking count is masked as bookings',
    (entry.fields || []).some((f) => f.class === 'BK' && f.paths.includes('series.money.points[].bookings')));

  /* The gate's shaping, for real roles, on real answers. */
  const as = (body, code) => shapeBody(JSON.parse(JSON.stringify(body)), entry, ROLE[code].levels).body;
  const measured = (s) => (s?.points || []).filter((p) => p.v != null).length;
  const dep = (await H(`page=deposits&from=2026-09-07&to=${TODAY}`)).body;
  const depClk = as(dep, 'CLK');
  check('the Cash desk on #deposits: both cash lines whole, nothing withheld',
    measured(dep.series.cash_ceiling) > 1 && measured(depClk.series.cash_ceiling) === measured(dep.series.cash_ceiling)
      && measured(depClk.series.cash_carriers) === measured(dep.series.cash_carriers) && !depClk._withheld,
    JSON.stringify(depClk._withheld));
  check('…and each series says which class it is', depClk.series.cash_ceiling.class === 'CASH' && depClk.series.cash_carriers.class === 'CASH');
  const canc = (await H(`page=cancellations&from=${D[0]}&to=${QUIET}`)).body;
  const cancHro = as(canc, 'HRO');
  check('the HR officer on #cancellations: the line whole — a COND line, as its tile\'s route is',
    measured(canc.series.cancelled) > 1 && measured(cancHro.series.cancelled) === measured(canc.series.cancelled) && !cancHro._withheld,
    JSON.stringify(cancHro._withheld));
  const late = (await H(`page=online-time&from=${D[0]}&to=${QUIET}&start=06:00`)).body;
  const lateHro = as(late, 'HRO');
  const lateClk = as(late, 'CLK');
  check('the HR officer on #online-time: Late whole', measured(lateHro.series.late) === measured(late.series.late) && measured(late.series.late) > 1);
  check('the Cash desk, who holds no conduct: every Late value withheld, and the class named for the page to say so',
    measured(lateClk.series.late) === 0 && lateClk._withheld?.COND === '' && lateClk.series.late.class === 'COND',
    JSON.stringify(lateClk._withheld));
  const perfClk = as(perfAnswer, 'CLK');
  const gap = (perfClk.series.money.points || []).find((p) => p.d === '2026-09-14');
  check('one person\'s money for the Cash desk: withheld as earnings, the booking count withheld as bookings, no figure left in a sentence',
    measured(perfClk.series.money) === 0 && perfClk._withheld?.EARN === '' && perfClk._withheld?.BK === ''
      && gap?.bookings == null && !/\d/.test(gap?.why || ''), JSON.stringify([perfClk._withheld, gap]));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
