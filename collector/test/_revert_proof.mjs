/* Reversion harness: put one expression back to what it was, run the test file,
   record which assertions fail, restore the file byte for byte. Nothing is left
   modified — the original bytes are held in memory and written back in a
   finally, and the tally at the end re-runs the suite clean. */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const R = [
  ['1 unauthorized/by-vehicle: unfold the accused names', 'api/server.js',
   `     who_person AS (
       SELECT DISTINCT ON (o.plate, \${personKeyStored('v')})
              o.plate, v.driver_name AS nm, v.driver_ext_id AS id`,
   `     who_person AS (
       SELECT DISTINCT ON (o.plate, v.driver_ext_id)
              o.plate, v.driver_name AS nm, v.driver_ext_id AS id`],

  ['2 product/by-vehicle: group held on the account again', 'api/server.js',
   `      GROUP BY v.plate, \${personKeyStored('v')}),
   ranked AS (`,
   `      GROUP BY v.plate, v.driver_ext_id),
   ranked AS (`],

  ['2b tiers/by-vehicle: group held on the account again', 'api/analytics_routes.js',
   `          GROUP BY v.plate, \${personKeyStored('v')}),
       ranked AS (`,
   `          GROUP BY v.plate, v.driver_ext_id),
       ranked AS (`],

  ['3 alerts/by-driver: group people on the raw name again', 'api/server.js',
   `       SELECT coalesce(nullif(c.person_key, ''), c.driver_ext_id, '(unattributed)') AS person_group,`,
   `       SELECT coalesce(c.driver_name, '(unattributed)') AS person_group,`],

  ['4 alerts/by-vehicle: count spellings again', 'api/server.js',
   `            count(DISTINCT j.person)::int drivers,`,
   `            count(DISTINCT j.driver_name)::int drivers,`],

  ['5 day headline: count driver_name again', 'api/day_routes.js',
   `                \${peopleCount()} FILTER (WHERE driver_name IS NOT NULL)::int drivers,`,
   `                count(DISTINCT driver_name) FILTER (WHERE driver_name IS NOT NULL)::int drivers,`],

  ['5b day "who drove": group on the raw name again', 'api/day_routes.js',
   `         GROUP BY \${personKey()}
         ORDER BY trips DESC LIMIT 120\`, p),`,
   `         GROUP BY driver_name
         ORDER BY trips DESC LIMIT 120\`, p),`],

  ['5c day per-vehicle: count beside the folded list unfolds', 'api/day_routes.js',
   `                \${peopleCount('t.driver_ext_id', 't.driver_name')}::int drivers,`,
   `                count(DISTINCT t.driver_name)::int drivers,`],

  ['6 slot: two totals for one hour again', 'api/segment_routes.js',
   `      \`SELECT \${peopleCount()}::int n,
              count(DISTINCT driver_ext_id)::int accounts`,
   `      \`SELECT count(DISTINCT driver_ext_id)::int n,
              count(DISTINCT driver_ext_id)::int accounts`],

  ['7 kpis: sum the per-platform payout counts again', 'api/server.js',
   `    payout_drivers: payPeople?.people ?? null,`,
   `    payout_drivers: payRows.reduce((acc, r) => acc + Number(r.drivers || 0), 0) || null,`],

  ['7b platformPayouts: count accounts again', 'api/income_sql.js',
   `         \${peopleCountStored('person_key', 'driver_ext_id')}::int drivers,
         count(DISTINCT driver_ext_id)::int driver_accounts,`,
   `         count(DISTINCT driver_ext_id)::int drivers,
         count(DISTINCT driver_ext_id)::int driver_accounts,`],

  ['8 cash exposure: count rows again', 'api/analytics_routes.js',
   `              (SELECT n FROM people_tot) AS _people,`,
   `              count(*) OVER ()::int AS _people,`],

  ['9 playbook cash card: count accounts again', 'api/playbook_routes.js',
   `                \${peopleCount('coalesce(driver_ext_id, driver_name)', 'driver_name')}::int drivers,`,
   `                count(DISTINCT coalesce(driver_ext_id, driver_name))::int drivers,`],

  ['10 export CSV: drop the accounts column from the header', 'api/export_routes.js',
   `  day: ['day', 'fleet', 'channel', 'bookings', 'completed', 'drivers', 'driver_accounts',
    'vehicles', 'km', 'priced_bookings', 'fares', 'currency'],`,
   `  day: ['day', 'fleet', 'channel', 'bookings', 'completed', 'drivers',
    'vehicles', 'km', 'priced_bookings', 'fares', 'currency'],`],

  ['11 THE NULL TRAP: drop the coalesce fallback on the day headline', 'api/custody_sql.js',
   `export const peopleCount = (idCol = 'driver_ext_id', nameCol = 'driver_name') =>
  \`count(DISTINCT \${personKey(idCol, nameCol)})\`;`,
   `export const peopleCount = (idCol = 'driver_ext_id', nameCol = 'driver_name') =>
  \`count(DISTINCT nullif(\${personFold(nameCol)}, ''))\`;`],

  ['12 THE OTHER DIRECTION: fold a count that genuinely means accounts', 'api/server.js',
   `            count(DISTINCT t.driver_ext_id)::int accounts,
            count(DISTINCT t.plate)::int plate_n,`,
   `            count(DISTINCT t.person_key)::int accounts,
            count(DISTINCT t.plate)::int plate_n,`],
];

const originals = new Map();
const save = (f) => { if (!originals.has(f)) originals.set(f, readFileSync(f, 'utf8')); };
const restoreAll = () => { for (const [f, t] of originals) writeFileSync(f, t); };

const run = () => {
  try {
    return execFileSync('node', ['test/person_vs_account_counts.test.mjs'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};

let proved = 0, unproved = 0;
try {
  for (const [name, file, from, to] of R) {
    save(file);
    const src = originals.get(file);
    if (!src.includes(from)) { console.log(`?? ${name} — anchor not found, CANNOT REVERT`); unproved++; continue; }
    writeFileSync(file, src.replace(from, to));
    const out = run();
    const failed = out.split('\n').filter((l) => l.includes('✗'));
    const m = out.match(/(\d+) passed, (\d+) failed/);
    const broke = failed.length > 0 || !m || Number(m[2]) > 0 || /Error/.test(out);
    console.log(`${broke ? '✓ PROVED ' : '✗ NOT PROVED '} ${name}`);
    if (broke) { proved++; failed.slice(0, 4).forEach((l) => console.log(`        ${l.trim()}`)); if (!failed.length) console.log('        (crashed / no tally)'); }
    else unproved++;
    writeFileSync(file, src);
  }
} finally { restoreAll(); }

const clean = run();
console.log(`\nrestored: ${clean.match(/(\d+) passed, (\d+) failed/)?.[0]}`);
console.log(`${proved} reversions broke an assertion, ${unproved} did not`);
