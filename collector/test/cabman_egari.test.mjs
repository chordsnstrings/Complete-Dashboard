/* Egari's own CABMAN login, and the rows it is allowed to file.
   ──────────────────────────────────────────────────────────────────────────
   The operator, 2026-10-06: five Egari Teslas (L16308, L10595, L12377, L64998,
   L27976) show connected on the CABMAN portal and read "no data at all" on
   #feeds. Measured the same day: our CABMAN feed held 175 plates and none of
   Egari's 36, and not one of the five had a CABMAN or FMS reading ever. The
   cause was not the devices — src/config.js listed one CABMAN login, Ecosine's
   (interface 81, user admin_ecosine), with a comment that Egari's "can be added
   here once provided". Egari's login uses the SAME interface id, 81, under its
   own user, and returns exactly those five cars; admin_ecosine returns none of
   them. So the user is what selects the fleet, and this pins that:

     - each configured login is asked with its own user and its own password;
     - what a login returns is filed under that login's fleet, never the other;
     - a login with no password is not asked, and is named as missing;
     - Settings holds the Egari keys, the password as a secret.

   Synthetic plates and passwords throughout. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { pool } from '../src/db.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);
pool.query = (t, p) => db.query(t, p);
pool.connect = async () => ({
  query: (t, p) => (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(t).trim())
    ? Promise.resolve({ rows: [] }) : db.query(t, p)),
  release: () => {},
});
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine', 'Ecosine'), ('egari', 'Egari') ON CONFLICT DO NOTHING`);

process.env.CABMAN_ECOSINE_PASS = 'synthetic-eco';
process.env.CABMAN_EGARI_PASS = 'synthetic-egari';

/* The provider answers by the user that asks, the way the real one does: the
   two logins share interface 81 and see different cars. A wrong password for
   a user is refused, so a login sent with the other fleet's password fails. */
let tick = 0;
const gmt = () => new Date(Date.now() - (++tick) * 1000).toISOString().replace('T', ' ').slice(0, 19);
const car = (p) => ({ VehicleID: p, gmt: gmt(), lat: 25.27, lng: 55.35, speed: 0, state: '1',
  Status: 'Engaged', SeatSensorValue: 1, odometer: 1000 });
const ACCOUNTS = {
  admin_ecosine: { pass: 'synthetic-eco', plates: ['L90001', 'L90002'] },
  Egari_Luxury_Cars_Integration: { pass: 'synthetic-egari', plates: ['L91001', 'L91002', 'L91003'] },
};
const asked = [];
globalThis.fetch = async (_url, opts = {}) => {
  const h = opts.headers || {};
  asked.push({ id: h.InterfaceUniqueId, user: h.InterfaceUserName, pass: h.InterfacePassword });
  const a = ACCOUNTS[h.InterfaceUserName];
  if (!a || a.pass !== h.InterfacePassword) {
    return new Response(JSON.stringify({ Message: 'Authorization has been denied for this request.' }),
      { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ IVDDataResult: a.plates.map(car) }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
console.error = () => {}; console.warn = () => {};

const { config } = await import('../src/config.js');
const { SETTING_DEFS, SETTING_DEFAULTS } = await import('../src/settings.js');
const { pullLive, passKey } = await import('../src/sources/cabman.js');

console.log('\nthe configuration');
const eg = config.cabman.fleets.find((f) => f.fleet === 'egari');
check('CABMAN lists an Egari login', !!eg, JSON.stringify(config.cabman.fleets.map((f) => f.fleet)));
check('…on interface 81 under its own user, not Ecosine’s',
  eg?.interfaceId === '81' && eg?.user === 'Egari_Luxury_Cars_Integration'
  && eg.user !== config.cabman.fleets.find((f) => f.fleet === 'ecosine')?.user, JSON.stringify(eg && { ...eg, pass: '…' }));
const def = (k) => SETTING_DEFS.find((d) => d.key === k);
check('Settings carries the Egari password as a secret, and the id and user as plain values',
  def('CABMAN_EGARI_PASS')?.secret === true && def('CABMAN_EGARI_ID')?.secret === false
  && def('CABMAN_EGARI_USER')?.secret === false && passKey('egari') === 'CABMAN_EGARI_PASS');
check('…with no password default anywhere in the code', !('CABMAN_EGARI_PASS' in SETTING_DEFAULTS));

console.log('\nthree polls — a plate is written on its third consecutive listing');
for (let i = 0; i < 3; i++) await pullLive();
const users = [...new Set(asked.map((a) => a.user))].sort();
check('both logins were asked', JSON.stringify(users) === '["Egari_Luxury_Cars_Integration","admin_ecosine"]', JSON.stringify(users));
check('…each with its own password, never refused',
  asked.every((a) => ACCOUNTS[a.user]?.pass === a.pass), JSON.stringify(asked.map((a) => a.user)));
const rows = await q(`SELECT plate, fleet_id, count(*)::int n FROM telemetry_snapshot WHERE source = 'cabman' GROUP BY 1, 2 ORDER BY 1`);
const fleetOf = Object.fromEntries(rows.map((r) => [r.plate, r.fleet_id]));
check('Egari’s cars are filed under Egari',
  ['L91001', 'L91002', 'L91003'].every((p) => fleetOf[p] === 'egari'), JSON.stringify(rows));
check('…and Ecosine’s under Ecosine, with nothing crossing over',
  ['L90001', 'L90002'].every((p) => fleetOf[p] === 'ecosine') && rows.length === 5, JSON.stringify(rows));
const rosters = await q(`SELECT fleet_id, value FROM source_state WHERE source = 'cabman' AND key = 'roster' ORDER BY 1`);
check('each fleet keeps its own roster', rosters.length === 2
  && JSON.parse(rosters.find((r) => r.fleet_id === 'egari')?.value || '{}').listed?.length === 3,
  JSON.stringify(rosters.map((r) => r.fleet_id)));

console.log('\na login with no password');
asked.length = 0;
delete process.env.CABMAN_EGARI_PASS;
await pullLive();
check('is not asked at all', !asked.some((a) => a.user === 'Egari_Luxury_Cars_Integration')
  && asked.some((a) => a.user === 'admin_ecosine'), JSON.stringify(asked.map((a) => a.user)));
const noted = await q(`SELECT credential, state FROM credential_state WHERE provider = 'cabman' AND fleet_id = 'egari'`);
check('…and is named as missing under its own Settings key',
  noted.some((r) => r.credential === 'CABMAN_EGARI_PASS' && r.state === 'missing'), JSON.stringify(noted));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
