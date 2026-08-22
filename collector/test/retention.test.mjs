/* Cohorts, and the two kinds of censoring that make them lie.
   ──────────────────────────────────────────────────────────────────────────
   This fleet's earning driver count ran 110, 50, 88. That is compatible with
   two opposite businesses — one that keeps its people and stopped recruiting,
   one that recruits hard and keeps nobody — and the remedy for each makes the
   other worse. Everything here protects the distinction.

   LEFT censoring: everybody active in the first month of the record looks like
   a joiner, including people who had driven for years. That row is the
   existing roster, not an intake group, and reading its curve as recruitment
   flatters or damns hiring for no reason.

   RIGHT censoring: somebody still working has not finished, so their tenure is
   a lower bound. Averaging them in with people who have stopped counts an
   unfinished span as a finished one and understates both figures. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { retentionRoutes } from '../api/retention_routes.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

let n = 0;
const book = (name, day, platform = 'uber') => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, distance_km, status, price)
   VALUES ($1, $2, 'ecosine', 'L1', $3, $4, $5, 10, 'completed', 40)`,
  [platform, `r${n++}`, `id-${name.toLowerCase().replace(/ /g, '')}`, name, `${day}T10:00:00+04:00`]);

/* Three months, complete, plus a partial fourth.
     Ann    works Jan, Feb, Mar        — an original who stayed
     Bob    works Jan, Feb             — an original who stopped
     Cara   works Feb, Mar             — joined in Feb and stayed
     Dan    works Feb                  — joined in Feb and stopped
     Eve    works Mar                  — joined in Mar
     Fay    works Jan, then Mar        — returned after a gap
   The partial April holds one Ann booking, which must change nothing. */
for (const d of ['2026-01-05', '2026-02-05', '2026-03-05']) await book('Ann Ahmed', d);
for (const d of ['2026-01-06', '2026-02-06']) await book('Bob Bakr', d);
for (const d of ['2026-02-07', '2026-03-07']) await book('Cara Chen', d);
await book('Dan Diaz', '2026-02-08');
await book('Eve Eid', '2026-03-09');
await book('Fay Farid', '2026-01-10');
await book('Fay Farid', '2026-03-10');
await book('Ann Ahmed', '2026-04-02');           // the month in progress

// The same human under a second platform id, spelled with different spacing.
await book('cara  chen', '2026-03-11', 'bolt');
// Telematics rows carry no driver name and must not create a person.
await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, distance_km, status)
         VALUES ('fms','tele-1','ecosine','L1','2026-03-12T10:00:00+04:00',9,'completed')`);

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
retentionRoutes(app, { q, wrap });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

const d = await get('/api/retention');
check('the endpoint answers', d.ok === true, JSON.stringify(d.reason));

/* ── the month in progress ───────────────────────────────────────────────── */
check('the month the record stops inside is excluded entirely',
  d.current_month_excluded === '2026-04' && !d.months.includes('2026-04'),
  JSON.stringify([d.current_month_excluded, d.months]));
check('so the last complete month is the one before it',
  d.last_complete_month === '2026-03', d.last_complete_month);
/* Ann worked in April. If April counted, everybody absent from a two-day month
   would read as having stopped — which on the first of the month is everybody. */
check('nobody is called a leaver for not having worked yet in an unfinished month',
  !d.stopped_last_month.some((s) => /Ann/.test(s.name)),
  JSON.stringify(d.stopped_last_month.map((s) => s.name)));

/* ── identity ────────────────────────────────────────────────────────────── */
check('one human with two platform ids is one person, not two',
  d.people_total === 6, `${d.people_total} people`);
check('and spacing in a name does not split them',
  d.cohorts.reduce((a, c) => a + c.size, 0) === 6,
  JSON.stringify(d.cohorts.map((c) => [c.cohort, c.size])));
check('a telematics row names nobody and creates no driver',
  !JSON.stringify(d).includes('tele-1'));

/* ── cohorts ─────────────────────────────────────────────────────────────── */
const jan = d.cohorts.find((c) => c.cohort === '2026-01');
const feb = d.cohorts.find((c) => c.cohort === '2026-02');
const mar = d.cohorts.find((c) => c.cohort === '2026-03');
check('people are grouped by the month of their FIRST booking',
  jan.size === 3 && feb.size === 2 && mar.size === 1,
  JSON.stringify([jan.size, feb.size, mar.size]));
check('a cohort is 100% retained in its own month',
  d.cohorts.every((c) => c.retained[0].pct === 100));
check('and its later months count only the people who actually booked',
  jan.retained[1].n === 2 && jan.retained[2].n === 2,
  JSON.stringify(jan.retained));
/* Fay was absent in February and back in March. A cohort curve that counted
   her as gone for good would understate retention permanently. */
check('somebody who returns after a gap is counted in the month they return',
  jan.retained[2].n === 2 && jan.retained[1].n === 2, JSON.stringify(jan.retained));
check('a cohort reports how many are still working in the last complete month',
  jan.still_active === 2 && feb.still_active === 1,
  `${jan.still_active} / ${feb.still_active}`);

/* LEFT CENSORING — the trap that makes the first row a lie. */
check('the first month of the record is flagged as not an intake group',
  jan.is_left_censored === true && feb.is_left_censored === false,
  JSON.stringify([jan.is_left_censored, feb.is_left_censored]));

/* ── the flow, which is the point of the page ───────────────────────────── */
const byMonth = Object.fromEntries(d.flow.map((f) => [f.m, f]));
check('the headcount matches who actually booked each month',
  byMonth['2026-01'].active === 3 && byMonth['2026-02'].active === 4
  && byMonth['2026-03'].active === 4,
  JSON.stringify(d.flow.map((f) => [f.m, f.active])));
check('arrivals are split into genuinely new and returning after a gap',
  byMonth['2026-03'].joined === 1 && byMonth['2026-03'].returning === 1,
  JSON.stringify(byMonth['2026-03']));
check('departures are counted in the month somebody stops',
  byMonth['2026-03'].left === 2, JSON.stringify(byMonth['2026-03']));
check('the net change reconciles with the headcount',
  d.flow.slice(1).every((f, i) => f.net === f.active - d.flow[i].active),
  JSON.stringify(d.flow.map((f) => [f.m, f.active, f.net])));

/* ── who stopped ─────────────────────────────────────────────────────────── */
const names = d.stopped_last_month.map((s) => s.name.toLowerCase());
check('somebody who worked last month and not this one is a leaver',
  names.some((x) => /dan/.test(x)), JSON.stringify(names));
check('somebody who worked both months is not',
  !names.some((x) => /ann|cara/.test(x)), JSON.stringify(names));
check('and neither is somebody who had already stopped a month earlier',
  !names.some((x) => /fay/.test(x)), JSON.stringify(names));
check('leavers carry the lifetime that makes one worth a phone call',
  d.stopped_last_month.every((s) => s.lifetime_bookings > 0 && s.months_active > 0),
  JSON.stringify(d.stopped_last_month));
check('and they are ordered by it, most productive first',
  d.stopped_last_month.every((s, i, a) => !i || a[i - 1].lifetime_bookings >= s.lifetime_bookings));
check('joiners are the people whose first booking was that month',
  d.started_last_month.length === 1 && /Eve/.test(d.started_last_month[0].name),
  JSON.stringify(d.started_last_month));

/* RIGHT CENSORING — a span that has not finished is not a tenure. */
check('tenure for people who stopped is reported apart from people still working',
  d.tenure.median_months_leavers != null && d.tenure.median_months_so_far_stayers != null
  && d.tenure.leavers > 0 && d.tenure.stayers > 0,
  JSON.stringify(d.tenure));
check('the two groups together are everybody, with nobody counted twice',
  d.tenure.leavers + d.tenure.stayers === d.people_total,
  `${d.tenure.leavers} + ${d.tenure.stayers} vs ${d.people_total}`);
check('and the page says why they are not averaged together',
  /lower bound|unfinished/.test(d.tenure.note || ''), d.tenure.note);

/* ── refusing ────────────────────────────────────────────────────────────── */
{
  const bare = new PGlite();
  await applySchema(bare);
  const bq = (t, p = []) => bare.query(t, p).then((r) => r.rows);
  const a2 = express();
  retentionRoutes(a2, { q: bq, wrap });
  const s2 = a2.listen(0);
  const r2 = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/retention`)).json();
  check('an empty record refuses rather than reporting a cohort of nobody',
    r2.ok === false && /names a driver/.test(r2.reason), JSON.stringify(r2));
  s2.close(); await bare.close();
}

server.close(); await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
