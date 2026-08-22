/* ── the Settings page was describing one process's environment ────────────
   The API and the collector are separate components with separate
   environments. UBER_WEB_COOKIE and YANGO_COOKIE are set on the collector
   worker and nowhere else, which is correct: only the collector calls those
   providers, and a web-facing service has no business holding a session cookie
   it never uses.

   But Settings is served BY the API, and it showed both as "unset". An
   operator reading that page would conclude the Uber session had expired and
   go capture a new one, while the collector had a working one all along — and
   a diagnostic I wrote reported exactly that before I checked the deployment
   spec and found the credential was there.

   So each process records what it can see, and the page shows the union. The
   rule these tests exist to enforce is the one that makes it safe: names and
   presence only. This table is read by a web service. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

const { readFileSync } = await import('node:fs');
const src = readFileSync('src/settings.js', 'utf8');

console.log('\ncredential visibility: presence, never a value');

/* The whole safety argument in one assertion. If a value can reach this table
   it has been copied into something a web service reads, which is precisely
   where these credentials were deliberately not put. */
const fn = src.slice(src.indexOf('export async function recordCredentialVisibility'),
  src.indexOf('// Safe view for the Settings UI'));
check('the recorded row carries only component, key, configured and source',
  /\[r\.component, r\.key, r\.configured, r\.source\]/.test(fn), fn.slice(0, 200));
check('and no secret value is read into it at all',
  !/cache\[d\.key\]\s*\}/.test(fn) && !/enc\(|value:/.test(fn));
/* `cache[d.key] != null` is a presence test and is fine; assigning it is not. */
check('presence is tested, not captured',
  /const fromDb = cache\[d\.key\] != null;/.test(fn));

const cols = await q(
  `SELECT column_name FROM information_schema.columns WHERE table_name = 'credential_visibility'`);
const names = cols.map((c) => c.column_name).sort();
check('the table has no column a secret could be written to',
  JSON.stringify(names) === JSON.stringify(['component', 'configured', 'key', 'observed_at', 'source']),
  JSON.stringify(names));

console.log('\ncredential visibility: the page shows the union, not one environment');

const api = readFileSync('api/public/app.js', 'utf8');
check('a credential held only by another component reads as held, not as unset',
  /on \$\{esc\(where\)\}/.test(api) && /others\.length/.test(api), '');
check('and one held nowhere still reads as unset',
  /return '<span class="tag warn">unset<\/span>';/.test(api));
check('describeSettings merges the other components in',
  /FROM credential_visibility/.test(src) && /seen_by:/.test(src));
/* A missing table must not take the Settings page down — it is new, and the
   API may boot against a database the migration has not reached. */
check('a database without the table degrades to the old behaviour rather than failing',
  /catch \{ elsewhere = \{\}; \}/.test(src));

console.log('\ncredential visibility: both components record');

const idx = readFileSync('src/index.js', 'utf8');
const server = readFileSync('api/server.js', 'utf8');
check('the collector records its view at boot', /recordCredentialVisibility\('collector'\)/.test(idx));
check('and hourly, since a settings change can arrive at any time',
  /cron\.schedule\('5 \* \* \* \*', \(\) => recordCredentialVisibility/.test(idx));
check('the api records its own, so the page can name the difference',
  /recordCredentialVisibility\('api'\)/.test(server));

console.log('\ncredential visibility: it round-trips');

const { recordCredentialVisibility } = await import('../src/settings.js');
/* Against this database, not the module's own pool. The first version of this
   test called it bare, the pool could not resolve its host, and the assertion
   fell through to a branch that passed while testing nothing — which is worse
   than no test, because the suite then reports coverage it does not have. */
await recordCredentialVisibility('collector', db);
const stored = await q('SELECT component, key, configured, source FROM credential_visibility');
check('a row is written for every credential in the catalogue',
  stored.length > 10, String(stored.length));
check('all attributed to the component that recorded them',
  stored.every((r) => r.component === 'collector'), JSON.stringify(stored.slice(0, 2)));
check('and every row names a source of environment, settings or unset',
  stored.every((r) => ['environment', 'settings', 'unset'].includes(r.source)),
  JSON.stringify([...new Set(stored.map((r) => r.source))]));

/* Re-recording must update in place. Appending would grow a row per hour per
   credential for ever, and the page would then show a credential as held by
   'collector' long after it stopped being. */
const before = stored.length;
await recordCredentialVisibility('collector', db);
const after = await q('SELECT count(*)::int n FROM credential_visibility');
check('recording again updates rather than appends',
  after[0].n === before, `${before} -> ${after[0].n}`);

// A second component is its own set of rows, not a replacement for the first.
await recordCredentialVisibility('api', db);
const both = await q('SELECT DISTINCT component FROM credential_visibility ORDER BY 1');
check('a second component records alongside the first, not over it',
  JSON.stringify(both.map((r) => r.component)) === '["api","collector"]',
  JSON.stringify(both));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
