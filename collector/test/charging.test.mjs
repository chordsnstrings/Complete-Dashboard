/* Idle is not automatically waste.
   ─────────────────────────────────────────────────────────────────────────
   This fleet is 44% electric — 5,438 of 12,282 bookings in the production
   window are Uber Electric — and it has charging stations in two areas that
   the idle ranking puts near the top. A car parked fifty minutes at one of
   them may be plugged in, not waiting for a fare.

   That distinction decides whether the optimiser gives good advice or costly
   advice. Left unsaid, the page ranks a charging session as downtime and
   recommends repositioning cars away from the only place they can refuel —
   and the measurement would agree with itself, because the dwell time is
   real.

   What the data can support is narrow, and this file pins exactly how narrow:
   the trip record carries an address string, so all this can ever say is "the
   area this car was left in contains a charger". Never "this car charged".
   Every surface therefore FLAGS the row and reports the hours BESIDE the idle
   total rather than netting them off, because subtracting them silently would
   turn a caveat into a claim. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
import { isCharging } from '../api/supply_routes.js';
import { config } from '../src/config.js';
import { SETTING_DEFS, SETTING_DEFAULTS } from '../src/settings.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

/* ── the setting itself ─────────────────────────────────────────────────── */
check('charging sites are a setting an operator can change, not a constant',
  SETTING_DEFS.some((d) => d.key === 'CHARGING_SITES'));
check('…and they are not filed as a credential',
  SETTING_DEFS.find((d) => d.key === 'CHARGING_SITES')?.secret === false);
check('…defaulting to the two sites this fleet actually has',
  /Al Garhoud/.test(SETTING_DEFAULTS.CHARGING_SITES)
  && /Dubai Production City/.test(SETTING_DEFAULTS.CHARGING_SITES),
  SETTING_DEFAULTS.CHARGING_SITES);
check('…and reaching config as a trimmed list',
  config.chargingSites.length === 2 && config.chargingSites[1] === 'Dubai Production City',
  JSON.stringify(config.chargingSites));

/* ── the match ──────────────────────────────────────────────────────────── */
const SITES = ['al garhoud', 'dubai production city'];
check('an exact area name matches', isCharging('Al Garhoud', SITES));
check('…case-insensitively', isCharging('AL GARHOUD', SITES));
check('…and a provider that suffixes the country still matches',
  isCharging('Al Garhoud DU, AE', SITES));
/* The reason the match is anchored rather than a substring: an area that
   merely CONTAINS the words is a different place, and flagging it would
   excuse idle time that has no charger behind it. */
check('a different area that merely contains the words does not match',
  !isCharging('Near Al Garhoud Bridge', SITES));
check('an unrelated area does not match', !isCharging('Dubai Marina', SITES));
check('a missing area does not match', !isCharging(null, SITES));
check('nothing matches when no site is configured', !isCharging('Al Garhoud', []));

/* ── the route ──────────────────────────────────────────────────────────── */
/* One plate, four Thursdays. It drops in Al Garhoud (a charging site) at
   08:00 and picks up again at 09:00 — an hour of idle that could be either
   thing. It also drops in Dubai Marina, which has no charger, so the two are
   distinguishable in the response. */
let n = 0;
const trip = (day, hour, from, to, mins = 20) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, ended_at, pickup_addr, dropoff_addr, distance_km, status, price, raw)
   VALUES ('uber', $1, 'ecosine', 'L1', 'd1', 'D', $2::timestamptz,
           $2::timestamptz + ($3 || ' minutes')::interval, $4, $5, 8, 'completed', 40, '{}'::jsonb)`,
  [`c${++n}`, `2026-08-${String(day).padStart(2, '0')}T${String(hour - 4).padStart(2, '0')}:00:00Z`,
    String(mins), `Shop - ${from} - Dubai - UAE`, `Villa - ${to} - Dubai - UAE`]);

for (const day of [6, 13, 20, 27]) {
  await trip(day, 8, 'Downtown Dubai', 'Al Garhoud');    // lands at a charger 08:20
  await trip(day, 9, 'Al Garhoud', 'Dubai Marina');      // leaves 09:00 — 40 min idle
  await trip(day, 12, 'Dubai Marina', 'Deira');          // Marina idle, no charger
}
/* The 09:00 job ends in Marina at 09:20 and the next starts at 12:00 —
   2h40, inside the four-hour shift-end cap, so Marina carries idle too. */

const { get } = await mountAll(db, { serverRoutes: true });
const d = (await get('/api/optimise?from=2026-08-01&to=2026-08-31')).body;

check('the route names the sites it was configured with',
  Array.isArray(d.charging_sites) && d.charging_sites.length === 2,
  JSON.stringify(d.charging_sites));
const garhoud = d.waits.find((w) => w.area === 'Al Garhoud');
const marina = d.waits.find((w) => w.area === 'Dubai Marina');
check('a wait in a charging area is flagged', garhoud?.charging_site === true,
  JSON.stringify(garhoud));
check('…and a wait anywhere else is not', marina?.charging_site === false,
  JSON.stringify(marina));

/* The central decision. Netting the hours off would make the fleet look more
   efficient than the data can show; leaving them unmarked would make the
   optimiser recommend moving cars off the chargers. So: counted in, flagged,
   and reported separately. */
check('charging-area hours are still counted in the idle total',
  d.idle_h_between_jobs >= garhoud.idle_h, `${d.idle_h_between_jobs} vs ${garhoud.idle_h}`);
check('…and reported again on their own, beside it',
  Math.abs(d.idle_h_at_charging_sites - garhoud.idle_h) < 0.2,
  `${d.idle_h_at_charging_sites} vs ${garhoud.idle_h}`);
check('…as a share of all the waiting',
  d.idle_h_charging_pct > 0 && d.idle_h_charging_pct < 100, String(d.idle_h_charging_pct));
check('…which is less than all of it, because Marina has no charger',
  d.idle_h_at_charging_sites < d.idle_h_between_jobs);

/* A reader who acts on the ranking has to be told this, in the response
   itself — a caveat that lives only in the page can be lost the moment
   somebody reads the API. */
check('the note says the flag is an address match, not a plug event',
  /not a plug event|never that the car was on it/.test(d.note || '')
  || /address, not a\s+geofence/.test(d.note || ''), d.note);
check('…and that the two are mixed together in those rows',
  /mixes waiting with refuelling/.test(d.note || ''), d.note);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
