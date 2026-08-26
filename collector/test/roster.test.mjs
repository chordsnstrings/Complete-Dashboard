/* The roster, and the three ways a state can describe somebody wrongly.
   ──────────────────────────────────────────────────────────────────────────
   Four providers each report a driver's standing in their own vocabulary and
   none of them knows what the others said. Folding them is useful and it is
   also the point at which this page could start telling an operator something
   untrue about a person's employment. Every assertion below is one of those:

     - a word we do not recognise quietly bucketed as "active";
     - "has not started yet" flattened together with "has been stopped";
     - somebody called idle who is not permitted to work at all;
     - a provider's HTML reaching the page as markup rather than as a sentence.

   Plus the finding the table exists for: a car attached to somebody who is not
   allowed to drive it. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import express from 'express';
import { readFileSync } from 'node:fs';
import { normaliseState, canEarn, cleanReason, stateRow, STATES } from '../src/roster.js';
import { rosterRoutes } from '../api/roster_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

/* ── the vocabulary ───────────────────────────────────────────────────── */
{
  check('Uber’s prefixed enum is unwrapped',
    normaliseState('ONBOARDING_STATUS_WAITLIST') === 'waitlist'
    && normaliseState('ONBOARDING_STATUS_ACTIVE') === 'active');
  check('Bolt’s bare words map', normaliseState('suspended') === 'suspended'
    && normaliseState('deactivated') === 'deactivated');
  check('a driver who is merely offline is still active — they may take work',
    normaliseState('offline') === 'active');
  // The whole finding lives in this distinction.
  check('waiting to start and having been stopped are different states',
    normaliseState('waitlist') !== normaliseState('suspended'));
  check('an unrecognised word becomes unknown rather than being guessed',
    normaliseState('on_order') === 'unknown' && normaliseState('vacation') === 'unknown');
  check('an empty state is unknown, not active', normaliseState('') === 'unknown'
    && normaliseState(null) === 'unknown' && normaliseState(undefined) === 'unknown');
  check('unknown carries no claim about whether they can earn',
    canEarn('unknown') === null, String(canEarn('unknown')));
  check('every state that can earn is exactly the ones that should',
    Object.entries(STATES).filter(([, v]) => v.can_earn === true).map(([k]) => k).join() === 'active');
}

/* ── a reason is a sentence, not markup ───────────────────────────────── */
{
  // This is the real shape: Uber's suspension text arrives as a styled block.
  const html = '<p style="color: #ffffff; text-align:center">You can no longer take trips '
    + 'because your <b>document</b> expired.</p>';
  const out = cleanReason(html);
  check('provider HTML is reduced to its sentence', out === 'You can no longer take trips because your document expired.', out);
  check('no tag survives', !/[<>]/.test(out || ''));
  check('entities are decoded', cleanReason('A &amp; B') === 'A & B');
  check('an empty reason stays null', cleanReason('') === null && cleanReason(null) === null
    && cleanReason('<p></p>') === null);
  check('a very long reason is bounded', (cleanReason('x'.repeat(900)) || '').length <= 400);
}

/* ── the row ──────────────────────────────────────────────────────────── */
{
  const r = stateRow({ platform: 'bolt', driverExtId: 'b1', fleetId: 'ecosine',
    name: '  Aliyan Khalil ', rawState: 'suspended', reason: '<p>Document expired</p>',
    plate: 'L100', score: '78', raw: { a: 1 } });
  check('the provider’s own word is kept beside the normalised one',
    r.state === 'suspended' && r.state_raw === 'suspended');
  check('the name is trimmed', r.full_name === 'Aliyan Khalil');
  check('a numeric score arriving as a string becomes a number', r.score === 78);
  check('can_earn is derived from the state, not asserted by the caller', r.can_earn === false);
  check('a non-numeric score is null rather than NaN',
    stateRow({ platform: 'x', driverExtId: '1', score: 'n/a' }).score === null);
  check('a raw payload is bounded so one provider cannot fill the table',
    (stateRow({ platform: 'x', driverExtId: '1', raw: { big: 'y'.repeat(50000) } }).raw || '').length <= 20000);
}

/* ── end to end ───────────────────────────────────────────────────────── */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

const put = (o) => q(
  `INSERT INTO driver_platform_state (platform,driver_ext_id,fleet_id,full_name,state,state_raw,
     state_reason,plate,score,can_earn,observed_at)
   VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,now())`,
  [o.platform, o.id, o.name, o.state, o.raw ?? o.state, o.reason ?? null, o.plate ?? null,
   o.score ?? null, o.canEarn]);

// One person, two platform accounts, both active — and a doubled surname on one
// of them, which is how this fleet's data actually arrives.
await put({ platform: 'uber', id: 'u1', name: 'Asad Khan', state: 'active', canEarn: true, plate: 'L100' });
await put({ platform: 'bolt', id: 'b1', name: 'Asad Khan Khan', state: 'active', canEarn: true, plate: 'L100' });
// Active everywhere, took nothing this window.
await put({ platform: 'uber', id: 'u2', name: 'Idle Person', state: 'active', canEarn: true, plate: 'L101' });
// Waitlisted: has never driven, and must NOT be called idle.
await put({ platform: 'uber', id: 'u3', name: 'Waiting Person', state: 'waitlist',
  raw: 'ONBOARDING_STATUS_WAITLIST', canEarn: false });
// Suspended, still holding a car.
await put({ platform: 'bolt', id: 'b2', name: 'Stopped Person', state: 'suspended',
  reason: 'Document expired', plate: 'L102', score: 41, canEarn: false });
// A word we do not recognise.
await put({ platform: 'yango', id: 'y1', name: 'Mystery Person', state: 'unknown',
  raw: 'on_order', canEarn: null });

const trip = (name, day, price) => q(
  `INSERT INTO trip (platform,external_id,fleet_id,plate,driver_name,requested_at,status,price,distance_km)
   VALUES ('uber',$1,'ecosine','L100',$2,$3,'completed',$4,12)`,
  [`t-${name}-${day}-${Math.random()}`, name, `2026-08-${String(day).padStart(2, '0')}T10:00:00+04:00`, price]);
for (let i = 1; i <= 20; i++) await trip('Asad Khan', i, null);
// Idle Person drove months ago and not in the window.
await trip('Idle Person', 1, null);
await q(`UPDATE trip SET requested_at = '2026-05-01T10:00:00+04:00' WHERE driver_name = 'Idle Person'`);
// Stopped Person drove before being stopped.
for (let i = 1; i <= 4; i++) await trip('Stopped Person', i, null);
await q(`UPDATE trip SET requested_at = '2026-06-01T10:00:00+04:00' WHERE driver_name = 'Stopped Person'`);

const app = express();
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
const range = (req) => [req.query.from || '2000-01-01', req.query.to || '2100-01-01',
  req.query.platform || null, req.query.fleet || null];
rosterRoutes(app, { q, wrap, range });
const server = app.listen(0);
const port = server.address().port;
const get = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

const d = await get('/api/roster?from=2026-08-01&to=2026-08-31');
const by = Object.fromEntries(d.people.map((p) => [p.name, p]));
const person = (frag) => d.people.find((p) => (p.name || '').includes(frag));

check('two platform accounts for one person fold into one row',
  d.people.filter((p) => (p.name || '').startsWith('Asad')).length === 1,
  JSON.stringify(d.people.map((p) => p.name)));
check('the fold says how many accounts it combined',
  person('Asad').accounts === 2, String(person('Asad')?.accounts));
check('a doubled surname does not create a second person',
  person('Asad').platforms.sort().join() === 'bolt,uber');
check('someone who drove in the window is working',
  person('Asad').category === 'working' && person('Asad').trips === 20,
  `${person('Asad')?.category} ${person('Asad')?.trips}`);

check('someone able to earn who took nothing this window is idle',
  by['Idle Person'].category === 'idle_this_window', by['Idle Person']?.category);
check('and their last trip is dated so a reader can judge how long',
  by['Idle Person'].days_since_last_trip > 0, String(by['Idle Person']?.days_since_last_trip));

// The distinction the whole table exists for.
check('somebody not permitted to work is NOT called idle',
  by['Waiting Person'].category === 'in_pipeline', by['Waiting Person']?.category);
check('a waitlisted driver with no trips is not called "never driven" either',
  by['Waiting Person'].category !== 'never_started');
check('the totals count the pipeline separately from the idle',
  d.totals.in_pipeline === 1 && d.totals.idle_this_window === 1,
  JSON.stringify(d.totals));
// A state nobody could classify asserts nothing about employment. Filing that
// person under "not yet able to earn" would be inventing a fact.
check('an unclassifiable standing is its own category, not the pipeline',
  by['Mystery Person'].category === 'unclassified' && d.totals.unclassified === 1,
  `${by['Mystery Person']?.category} / ${d.totals.unclassified}`);

check('a stopped driver is categorised as stopped',
  by['Stopped Person'].category === 'blocked', by['Stopped Person']?.category);

/* ── but a trip that HAPPENED outranks a claim about an account ───────────
   The rung above is right that our trip table may not cover somebody's
   platform. The reverse also happens, and did: two people carrying a rejected
   Yango application and a waitlisted Bolt one had 50 and 23 completed trips in
   the window, and were filed under "not yet able to earn" — which also made
   the page's "Drove in this window" tile read 89 where 91 people had trips. */
await put({ platform: 'yango', id: 'y9', name: 'Rejected But Driving', state: 'rejected',
  plate: 'L109', canEarn: false });
for (let i = 1; i <= 5; i++) await trip('Rejected But Driving', i, null);
{
  const d3 = await get('/api/roster?from=2026-08-01&to=2026-08-31');
  const b3 = Object.fromEntries(d3.people.map((p) => [p.name, p]));
  check('somebody a provider rejected who nonetheless drove is working, not pipeline',
    b3['Rejected But Driving'].category === 'working',
    `${b3['Rejected But Driving']?.category} with ${b3['Rejected But Driving']?.trips} trips`);
  check('and the working total equals the number of people with trips in the window',
    d3.totals.working === d3.people.filter((x) => (x.trips || 0) > 0).length,
    `${d3.totals.working} working vs ${d3.people.filter((x) => (x.trips || 0) > 0).length} with trips`);
  check('a waitlisted driver with no trips is still in the pipeline',
    b3['Waiting Person'].category === 'in_pipeline', b3['Waiting Person']?.category);
}

/* ── a provider's assertion outranks an inference from our own tables ─────
   Live, this reported `blocked: 0` on the same screen as "31 holding a vehicle
   while blocked": 31 suspended and deactivated Bolt drivers had a lifetime
   trip count of zero — not because they had never driven, but because the
   trip table holds no Bolt rows at all — and a zero lifetime was being read
   first, filing them as "still waiting to start". */
await put({ platform: 'bolt', id: 'b3', name: 'Suspended NoTrips', state: 'suspended',
  reason: 'Licence expired', plate: 'L103', canEarn: false });
await put({ platform: 'bolt', id: 'b4', name: 'Bolt Only Active', state: 'active',
  plate: 'L104', canEarn: true });
{
  const d2 = await get('/api/roster?from=2026-08-01&to=2026-08-31');
  const b = Object.fromEntries(d2.people.map((p) => [p.name, p]));
  check('a suspended driver we hold no trips for is stopped, not "waiting to start"',
    b['Suspended NoTrips'].category === 'blocked', b['Suspended NoTrips']?.category);
  check('and the blocked total agrees with the vehicles-held-while-blocked total',
    d2.totals.blocked >= d2.totals.holding_vehicle_while_blocked,
    `${d2.totals.blocked} blocked vs ${d2.totals.holding_vehicle_while_blocked} holding`);
  check('an active driver on a platform with no trip history is not called "never driven"',
    b['Bolt Only Active'].category === 'activity_unknown', b['Bolt Only Active']?.category);
  check('their lifetime output is marked unobserved rather than zero',
    b['Bolt Only Active'].activity_known === false);
  check('the response names which platforms have trip history at all',
    Array.isArray(d2.platforms_with_trips) && d2.platforms_with_trips.includes('uber')
    && !d2.platforms_with_trips.includes('bolt'), JSON.stringify(d2.platforms_with_trips));
  check('the caveat says output on the other platforms is unobserved, not zero',
    /unobserved rather than as zero/.test(d2.caveat), d2.caveat);
  check('a driver on a platform we DO collect is still judged normally',
    b['Idle Person'].category === 'idle_this_window');
}
check('a car attached to somebody who cannot drive it is flagged',
  by['Stopped Person'].holding_vehicle_while_blocked === true
  && d.totals.holding_vehicle_while_blocked === 1);
check('an active driver holding a car is not flagged',
  by['Idle Person'].holding_vehicle_while_blocked === false);
check('the reason the provider gave is carried through',
  /Document expired/.test(by['Stopped Person'].reason || ''));

check('a state nobody could classify makes no claim about earning',
  by['Mystery Person'].can_earn_anywhere === null || by['Mystery Person'].can_earn_anywhere === false,
  String(by['Mystery Person']?.can_earn_anywhere));
check('the response says the fold is by name so it can be checked',
  /folded into one person by name/.test(d.caveat));

const st = await get('/api/roster/states');
check('the provider’s own word is reported alongside the normalised one',
  st.by_state.some((r) => r.state_raw === 'ONBOARDING_STATUS_WAITLIST' && r.state === 'waitlist'),
  JSON.stringify(st.by_state));
// A provider that sends a word we cannot map is a mapping we could add; a
// provider that sends no state at all is nothing to map. Reported together,
// fourteen live Yango drivers looked like a classification failure when the
// endpoint simply does not return a status.
check('a word we could not map is listed as one',
  st.unrecognised_words.length === 1 && st.unrecognised_words[0].word === 'on_order',
  JSON.stringify(st.unrecognised_words));
check('a provider that sends no state at all is reported separately',
  Array.isArray(st.no_state_reported), JSON.stringify(st.no_state_reported));
check('how stale the roster is, is reported',
  st.oldest_observation != null && st.newest_observation != null);
check('a state row counts how many of its people hold a vehicle',
  st.by_state.every((r) => r.with_vehicle <= r.n));

/* Filtering by platform must narrow the roster, not silently ignore the filter. */
const uberOnly = await get('/api/roster?from=2026-08-01&to=2026-08-31&platform=uber');
check('a platform filter narrows the roster',
  uberOnly.people.length < d.people.length
  && uberOnly.people.every((p) => p.platforms.every((x) => x === 'uber')),
  `${uberOnly.people.length} vs ${d.people.length}`);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
