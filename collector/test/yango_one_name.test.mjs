/* ── one Yango driver, three names, two people ─────────────────────────────
   Yango hands the same driver_id back under a different name composition from
   each of three endpoints: orders/list gives `driver_full_name` with the
   father's name first ("Khalil Aliyan"), summary/drivers gives first_name and
   last_name decomposed and in natural order ("Aliyan Khalil"), and
   transactions/list gives a third string of its own. person_key is a GENERATED
   column folding whatever name column its own table carries, so one driver's
   trips folded to one person and their roster row to another.

   That is not a hypothesis. It is directly observable inside a single Yango
   account, where two people is impossible: 69f7e655… displays "Tariq Afzal
   Said Afzal" and stores the person_key "said afzal tariq afzal".

   api/identity_map.js can only join such a pair after a human has verified it,
   one at a time. These assertions are about the split not being written in the
   first place, and about the history already written being aligned to the id.

   Nothing here is a name rule. Every join below is on driver_ext_id. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\nyango: one name per driver id');

/* ── the source ──────────────────────────────────────────────────────────── */
const SRC = readFileSync('src/sources/yango.js', 'utf8');
/* The prose above every one of these findings quotes the composition it is
   about — the doc block in yango.js literally tabulates "first_name +
   last_name" as one of the three spellings — so a regex over the raw file
   matches its own explanation and reports a defect that is a sentence. Block
   comments are removed whole, not line by line, because the offending line
   does not begin with a comment marker. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const COMPOSE = /first_name[^\n]*last_name/g;
const compositions = CODE.match(COMPOSE) || [];
check('the two-part name is composed in exactly one place', compositions.length === 1,
  `found ${compositions.length}: ${JSON.stringify(compositions)}`);
check('and that place is decomposed()', /function decomposed\([^)]*\)\s*\{[\s\S]{0,200}?first_name/.test(CODE));

/* The key host nests what the console kept flat: an order's driver arrives as
   driver_profile.{id,name} rather than driver_id / driver_full_name. The
   PROPERTY is unchanged and is what is asserted — a trip's name goes through
   nameFor, which prefers the decomposed spelling and falls back to whatever
   the endpoint said. Pinning the console's exact spelling would have passed on
   a collector that no longer calls that host. */
check('trips file the driver under the register, not the raw endpoint string',
  /driver_name:\s*nameFor\(\s*o\.driver_profile\?\.id,\s*o\.driver_profile\?\.name\s*\)/.test(CODE)
  || /driver_name:\s*nameFor\(o\.driver_id,\s*o\.driver_full_name\)/.test(CODE),
  'the order mapper must file driver_name through nameFor, not through the raw string');
/* And no mapper anywhere may reach past nameFor to the endpoint's own string.
   This is the assertion the one above is a specific case of: it is what would
   catch a fourth endpoint being added with the split written back in. */
check('…and no trip, ledger or performance row is filed under a raw endpoint name',
  !/(driver_name|full_name|name):\s*(o|t|it)\.[a-z_]*(full_name|driver_name)\b/.test(CODE),
  (CODE.match(/(driver_name|full_name|name):\s*(o|t|it)\.[a-z_]*(full_name|driver_name)\b/g) || []).join('; '));
check('the ledger does too',
  /driver_name:\s*nameFor\(t\.driver_id,\s*t\.driver_name\)/.test(CODE));
check('the weekly performance row uses the one composition',
  /driver_name:\s*decomposed\(it\.driver\)/.test(CODE));
check('and so does the roster snapshot',
  /name:\s*decomposed\(it\.driver\)/.test(CODE));

/* Each pull is wrapped in surface() now, so that one refused endpoint cannot
   cost the other two — but the ORDER is still load-bearing and still checked:
   trips and ledger rows are filed under the DECOMPOSED name, so the endpoint
   that decomposes has to be asked first.

   WHICH endpoint that is has moved. It was the console's summary/drivers,
   asked as surface('drivers'); it is now the key host's driver-profiles/list,
   asked as surface('roster'), because the console has answered 403 from a CDN
   edge since 2026-09-06 and the key host needs no cookie. So the assertion is
   written against the ROLE rather than the label: whichever surface is the one
   that composes first_name and last_name goes before the ones that file trips
   and ledger rows. A test pinned to the label would have gone green on a
   collector that pulls trips before it knows anybody's name.

   Searched inside collect() only. indexOf over the whole file finds each
   function's DECLARATION, which sits in source order rather than call order —
   pullRoster is declared after pullTrips and the assertion would invert. */
const COLLECT = CODE.slice(CODE.indexOf('export async function collect('));
const callAt = (label) => COLLECT.indexOf(`surface('${label}`);
/* The function that holds the one composition, found rather than named.
   Each declaration's body is taken as far as the NEXT declaration: a lazy
   [\s\S]*? from the first `async function` happily runs past three of them to
   reach a decomposed() in the fourth, which named seedNames and made the two
   order assertions below compare a position with itself. */
const DECLS = [...CODE.matchAll(/async function (\w+)\s*\(/g)];
const DECOMPOSER = DECLS.find((m, i) => CODE
  .slice(m.index, i + 1 < DECLS.length ? DECLS[i + 1].index : CODE.length)
  .includes('decomposed('))?.[1];
check('one pull composes the name, and it is found rather than assumed',
  !!DECOMPOSER, String(DECOMPOSER));
/* collect() calls it as surface('<label>', fn) or surface('<label>', () => fn(...)) —
   either spelling, so the lookup is on the FUNCTION and not on the label. */
const decomposerAt = DECOMPOSER
  ? COLLECT.search(new RegExp(`surface\\('[^']*',\\s*(\\(\\)\\s*=>\\s*)?${DECOMPOSER}\\b`)) : -1;
const seedAt = callAt('names');
const tripsAt = callAt('trips');
const ledgerAt = callAt('ledger');
check('collect() seeds the names before anything is pulled',
  seedAt > 0 && seedAt < decomposerAt, `seed@${seedAt} decomposer@${decomposerAt}`);
check('and asks the endpoint that decomposes the name before it pulls trips',
  decomposerAt > 0 && decomposerAt < tripsAt,
  `${DECOMPOSER}@${decomposerAt} trips@${tripsAt}`);
check('and before the ledger', decomposerAt > 0 && decomposerAt < ledgerAt,
  `${DECOMPOSER}@${decomposerAt} ledger@${ledgerAt}`);

/* An id nobody has ever seen decomposed keeps the endpoint's own string. A
   driver with no name at all is worse than a driver with a badly ordered one. */
check('nameFor falls back to the endpoint string', /nameFor\s*=\s*\(id, given\)\s*=>[^\n]*\|\|\s*given/.test(CODE));
check('seedNames reads the roster, scoped to this source',
  /FROM driver_platform_state[\s\S]{0,120}?WHERE platform = \$1/.test(CODE));

/* ── the history already written ─────────────────────────────────────────── */
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

const YID = '7fc8da91fc4a44c185e8d6d918db3e6b';   // the account the operator asked about
const TID = '69f7e655aaaa4444bbbb5555cccc6666';   // the one still live, untouched by the register
const OTHER = '9d396a20-454b-4a7e-91ae-9de8f9aa8942';

/* The roster knows the decomposed name — that is what maybeRoster writes. */
await q(`INSERT INTO driver_platform_state (platform, driver_ext_id, fleet_id, full_name, state, can_earn, observed_at)
         VALUES ('yango',$1,'ecosine','Aliyan Khalil','active',true,now()),
                ('yango',$2,'ecosine','Tariq Afzal Said Afzal','active',true,now())`, [YID, TID]);

/* The trips carry orders/list's composition, and one row belongs to a driver
   with no roster row at all — the control for "left exactly as they are". */
const trip = (ext, id, name, day) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status)
   VALUES ('yango',$1,'ecosine',$2,$3,$4,'completed')`, [ext, id, name, day]);
await trip('y1', YID, 'Khalil Aliyan', '2026-08-20T10:00:00Z');
await trip('y2', YID, 'Khalil Aliyan', '2026-08-21T10:00:00Z');
await trip('y3', TID, 'Said Afzal Tariq Afzal', '2026-08-22T10:00:00Z');
await trip('y4', 'no-roster-row-at-all', 'Somebody Unknown', '2026-08-23T10:00:00Z');
/* A different platform with the same shape of problem is NOT this file's
   business — the migration says platform = 'yango' and this proves it. */
await q(`INSERT INTO trip (platform, external_id, fleet_id, driver_ext_id, driver_name, requested_at, status)
         VALUES ('uber','u1','ecosine',$1,'Moses Arthur','2026-08-20T10:00:00Z','completed')`, [OTHER]);

/* The split is shown on TID, not YID. YID is in api/identity_map.js, so
   sql/schema_v53.sql already pins its person_key to the survivor whatever name
   the row carries — which is the register working, and is exactly why it
   cannot demonstrate the defect. TID is the account nobody has verified: it is
   what every future Yango driver looks like before a human gets to them, and
   it is the case this fix exists for. */
const before = await q(`SELECT DISTINCT person_key FROM trip WHERE platform='yango' AND driver_ext_id=$1`, [TID]);
const rosterKey = await q(`SELECT person_key FROM driver_platform_state WHERE driver_ext_id=$1`, [TID]);
check('before: the trips and the roster row disagree about who this is',
  before[0].person_key !== rosterKey[0].person_key,
  `${before[0].person_key} vs ${rosterKey[0].person_key}`);
check('and the register alone would never have joined them',
  !readFileSync('sql/schema_v53.sql', 'utf8').includes(TID));

/* YID meanwhile shows the other half: a pair a human DID verify is already one
   person before this migration runs, by id, whatever the name says. */
const registered = await q(`SELECT DISTINCT person_key FROM trip WHERE driver_ext_id=$1`, [YID]);
check('the verified pair was already folded by the register',
  registered.length === 1 && registered[0].person_key === 'aliyan khalil',
  JSON.stringify(registered));

await db.exec(readFileSync('sql/schema_v54.sql', 'utf8'));

const after = await q(`SELECT DISTINCT person_key FROM trip WHERE platform='yango' AND driver_ext_id=$1`, [TID]);
check('after: one person, and it is the roster row’s',
  after.length === 1 && after[0].person_key === rosterKey[0].person_key,
  JSON.stringify(after));
const yidAfter = await q(`SELECT DISTINCT person_key FROM trip WHERE driver_ext_id=$1`, [YID]);
check('and the verified pair is still filed under the survivor, not renamed away',
  yidAfter.length === 1 && yidAfter[0].person_key === 'aliyan khalil', JSON.stringify(yidAfter));

const tariq = await q(`SELECT driver_name, person_key FROM trip WHERE driver_ext_id=$1`, [TID]);
check('the account the register never touched is repaired too',
  tariq[0].person_key === 'tariq afzal said afzal', JSON.stringify(tariq[0]));

const orphan = await q(`SELECT driver_name FROM trip WHERE driver_ext_id='no-roster-row-at-all'`);
check('a driver with no roster row keeps the name they had',
  orphan[0].driver_name === 'Somebody Unknown', JSON.stringify(orphan[0]));

const uber = await q(`SELECT driver_name FROM trip WHERE platform='uber'`);
check('and no other platform is touched', uber[0].driver_name === 'Moses Arthur');

/* Idempotence, because this runs on every boot until its hash is recorded and
   a migration that is not safe to replay is a migration that breaks a retry. */
await db.exec(readFileSync('sql/schema_v54.sql', 'utf8'));
const again = await q(`SELECT DISTINCT person_key FROM trip WHERE platform='yango' AND driver_ext_id=$1`, [TID]);
check('replaying it changes nothing', again.length === 1 && again[0].person_key === after[0].person_key);

/* ── and the register still owns the cross-id joins ──────────────────────── */
const V53 = readFileSync('sql/schema_v53.sql', 'utf8');
check('v54 joins on the id and never on a name',
  !/driver_name\s*=\s*[a-z]*\.?driver_name\b/i.test(
    readFileSync('sql/schema_v54.sql', 'utf8').split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
      .replace(/SET driver_name = s\.full_name/g, '')));
check('the register is still where different ids are joined', /WHEN '7fc8da91/.test(V53));

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
