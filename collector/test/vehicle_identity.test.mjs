/* ── one car, one row, and a VIN somebody can count ────────────────────────
   ──────────────────────────────────────────────────────────────────────────
   The operator's question was "we do not have 273 cars", and the answer — 138
   VINs — was established by fetching 273 pages of /api/vehicle/profile by hand
   and writing the number down in a chat. It could not be checked, it did not
   survive, and the claim built on it ("138 plates, 138 distinct VINs, not one
   VIN on two plates") could not have failed: vehicle_profile's primary key is
   (platform, vehicle_ext_id) and each row carries one plate and one VIN, so
   one-to-one was guaranteed by the key rather than measured in the fleet.

   Three things are held down here, and the first is the one that makes the
   other two safe.

     1. vehicle_profile can hold one physical car once PER CHANNEL, and until
        2026-09-07 exactly one collector wrote it, so four LEFT JOINs in the
        read API were written as though one-row-per-plate were a property of
        the table. It was a property of who was filling it. Yango's cars/list
        writes 104 more. sql/schema_v66.sql resolves the table to one row per
        plate and this proves it does — including that nothing a channel knows
        is lost, which is why it coalesces rather than picking a winner.

     2. The multiply was not hypothetical and not in the future. Uber files
        MORE THAN ONE vehicle_ext_id per plate — 222 across 138 plates on
        production — and api/analytics_routes.js joined vehicle_profile inside
        an aggregate, so those plates had their trips and kilometres doubled
        before Yango wrote a row. Proven by construction below.

     3. A VIN nobody can see is a VIN nobody can check. It now reaches
        /api/vehicles/directory as a column, so "how many cars" is a query.

   Everything below runs against the real schema. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
await q(`INSERT INTO fleet (id,name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

/* ══ 1. the table can hold one car twice, and the view resolves it ═══════ */
console.log('\none physical car, described by two channels');

await q(`INSERT INTO vehicle_profile
   (platform, vehicle_ext_id, plate, fleet_id, make, model, year, colour, vin, image_url, compliance_status)
 VALUES
   -- the same car, both channels: uber richer, yango carrying nothing new
   ('uber', 'u-shared','L36397','ecosine','BYD','Han EV',2025,'black','LC0CE6CD6R7237814','http://img','ACTIVE'),
   ('yango','y-shared','L36397', NULL,  'BYD','Han',    2025, NULL,   'LC0CE6CD6R7237814', NULL,       NULL),
   -- the same car again, and this time only YANGO knows its VIN
   ('uber', 'u-novin', 'L44284','ecosine','Tesla','Model 3',2024,'white', NULL,            'http://i2','ACTIVE'),
   ('yango','y-hasvin','L44284', NULL,   NULL,   NULL,     NULL, NULL,   'VINONLYFROMYANGO',NULL,      NULL),
   -- a car only yango has ever seen
   ('yango','y-only',  'L99999', NULL,   'Lexus','ES 300h',2023,'grey',  'VINYANGOONLY',   NULL,       NULL),
   -- and one plate with TWO uber records, which is what production already has
   ('uber', 'u-a',     'L11111','ecosine','Lexus','ES 300h',2023,'grey', 'VINUBERONLY',    NULL,       'ACTIVE'),
   ('uber', 'u-b',     'L11111','ecosine','Lexus','ES 300h',2023,'grey', 'VINUBERONLY',    NULL,       'ACTIVE')`);

const [{ profiles }] = await q(`SELECT count(*)::int profiles FROM vehicle_profile`);
const view = await q(`SELECT * FROM vehicle_plate ORDER BY plate`);
check('seven profile rows describe four cars', profiles === 7 && view.length === 4,
  `${profiles} rows -> ${view.length} plates`);

const at = (plate) => view.find((r) => r.plate === plate);
check('a car both channels describe is one row', at('L36397')?.profile_rows === 2);
check('…naming every channel that holds a record',
  at('L36397')?.platforms.sort().join() === 'uber,yango', JSON.stringify(at('L36397')?.platforms));
/* The whole reason it coalesces instead of choosing: a winner-takes-all rule
   would have thrown away whichever channel happened to lose. */
check('the richer channel\'s values are what a reader sees',
  at('L36397')?.make === 'BYD' && at('L36397')?.model === 'Han EV'
  && at('L36397')?.colour === 'black' && at('L36397')?.image_url === 'http://img',
  JSON.stringify(at('L36397')));
check('…and a field only the OTHER channel has is filled from it',
  at('L44284')?.vin === 'VINONLYFROMYANGO' && at('L44284')?.make === 'Tesla',
  JSON.stringify(at('L44284')));
check('a car only one channel has ever seen is still on the list',
  at('L99999')?.vin === 'VINYANGOONLY' && at('L99999')?.platforms.join() === 'yango');
check('two records of the SAME channel collapse too — production has 222 uber ids over 138 plates',
  at('L11111')?.profile_rows === 2 && at('L11111')?.platforms.join() === 'uber');
/* The fleet stamp is the case api/economics_routes.js already hit in JS: a
   plate stamped on one channel's record and unstamped on the other resolved to
   null and dropped out of its own fleet. */
check('a fleet recorded on one channel is a fact about the car, not about the channel',
  at('L36397')?.fleet_id === 'ecosine' && at('L44284')?.fleet_id === 'ecosine');
/* Determinism: the same rows, asked twice, in a table with no ORDER BY of its
   own. A view that answered differently per call would be worse than the join
   it replaces, because it would be wrong intermittently. */
{
  const again = await q(`SELECT plate, platform, make, vin FROM vehicle_plate ORDER BY plate`);
  const once = view.map((r) => `${r.plate}|${r.platform}|${r.make}|${r.vin}`).join(';');
  check('the same question asked twice gets the same answer',
    again.map((r) => `${r.plate}|${r.platform}|${r.make}|${r.vin}`).join(';') === once);
}

/* ══ 2. the multiply, which was already happening ═══════════════════════ */
console.log('\nthe join that doubled a plate\'s trips before Yango wrote a row');

await q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                     requested_at, status, distance_km, price)
   SELECT 'uber','t'||g,'ecosine','L11111','d1','D', now(), 'completed', 10, 50
     FROM generate_series(1,5) g`);
const naive = await q(
  `SELECT count(*)::int trips, sum(t.distance_km)::int km FROM trip t
     LEFT JOIN vehicle_profile vp ON upper(replace(vp.plate,' ','')) = upper(replace(t.plate,' ',''))
    WHERE t.plate = 'L11111' GROUP BY t.plate`);
const fixed = await q(
  `SELECT count(*)::int trips, sum(t.distance_km)::int km FROM trip t
     LEFT JOIN (SELECT DISTINCT ON (upper(replace(plate,' ','')))
                       upper(replace(plate,' ','')) AS norm_plate, make
                  FROM vehicle_plate ORDER BY upper(replace(plate,' ','')), plate) vp
            ON vp.norm_plate = upper(replace(t.plate,' ',''))
    WHERE t.plate = 'L11111' GROUP BY t.plate`);
check('five trips joined the old way report ten, and 100 km instead of 50',
  naive[0].trips === 10 && naive[0].km === 100, JSON.stringify(naive[0]));
check('…and through the view they report five, and 50',
  fixed[0].trips === 5 && fixed[0].km === 50, JSON.stringify(fixed[0]));

/* And no read route may join the raw table on plate again. Found rather than
   listed: a fifth file added tomorrow is covered without editing this one. */
console.log('\nand no read route joins the raw table on plate any more');
{
  const { readdirSync } = await import('node:fs');
  const offenders = readdirSync('api').filter((f) => f.endsWith('.js')).flatMap((f) => {
    const src = readFileSync(`api/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return (src.match(/JOIN\s+vehicle_profile\s+\w+\s+ON[^\n]*plate/gi) || []).map((m) => `${f}: ${m.trim()}`);
  });
  check('every plate-keyed join reads vehicle_plate, not vehicle_profile',
    offenders.length === 0, offenders.join(' | '));
  /* The control: the view is genuinely being used, so the assertion above is
     not passing because nobody joins anything. */
  const users = readdirSync('api').filter((f) => f.endsWith('.js'))
    .filter((f) => /JOIN\s+vehicle_plate/i.test(readFileSync(`api/${f}`, 'utf8')));
  check('…and at least three read routes do use it', users.length >= 3, users.join(', '));
}

/* ══ 3. the Yango mapper, against the field names actually measured ═════ */
console.log('\nthe key API\'s shapes, which are not the console\'s');
{
  const Y = readFileSync('src/sources/yango.js', 'utf8');
  const CODE = Y.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* Measured from production 2026-09-07 by /api/probe/yango/keyapi. Each of
     these is a field the console did NOT have under this name, so a mapper
     carried over from the console would have filed null or "[object Object]". */
  for (const [what, re] of [
    ['the driver id is nested', /o\.driver_profile\?\.id/],
    ['the driver name is nested', /o\.driver_profile\?\.name/],
    ['the pickup is an object with an address inside it', /o\.address_from\?\.address/],
    ['the destination is the LAST route point, not the first', /route_points[\s\S]{0,120}slice\(-1\)/],
    ['mileage and price arrive as strings and go through a parser', /num\(o\.mileage\)/],
    ['…including the fare', /price:\s*num\(o\.price\)/],
  ]) check(what, re.test(CODE), 'the console shape would have filed nothing here');
  check('the plate is read from the license object with the callsign as fallback',
    /car\?\.license\?\.normalized_number/.test(CODE) && /car\?\.callsign/.test(CODE));
  /* A parser that turns '' into 0 files a fare of nothing as a fare of zero,
     which is the house rule's exact opposite. */
  check('the parser refuses an empty string rather than calling it zero',
    /const num = \(v\) => \{[\s\S]{0,200}v === ''\) return null/.test(CODE));

  /* The two surfaces the key host does not serve must not be faked from the
     orders: an order carries no commission, and Yango's is about 24%. */
  check('nothing computes driver_performance earnings from the orders',
    !/driver_performance[\s\S]{0,400}earnings:[\s\S]{0,80}o\.price/.test(CODE),
    'that would restate a net figure as gross, which this collector was fixed for');
  check('and the collector still ASKS the console for them, so a recovery is noticed',
    /YANGO_SURFACES\.console\.summary/.test(CODE) && /YANGO_SURFACES\.console\.ledger/.test(CODE));

  /* The cars pull is what makes a second VIN source exist at all. */
  check('the cars pull writes vehicle_profile keyed per channel, not over Uber\'s rows',
    /upsertMany\('vehicle_profile', rows, \['platform', 'vehicle_ext_id'\]\)/.test(CODE));
  check('…and normalises the VIN, or the cross-check compares one spelling with another',
    /vin:\s*c\.vin \? String\(c\.vin\)\.trim\(\)\.toUpperCase\(\)/.test(CODE));
  check('the roster writes the phone, which is what src/identity_link.js joins people on',
    /driver_compliance/.test(CODE) && /phone: firstString\(d\.phones\)/.test(CODE));
}

/* ══ 4. the VIN reaches the page that counts cars ═══════════════════════ */
console.log('\nand the VIN is on the list, not one page at a time');
{
  const routes = readFileSync('api/vehicle_routes.js', 'utf8');
  check('the directory selects the VIN and the channels that FILED one',
    /coalesce\(v\.vin, vp\.vin\) vin,/.test(routes)
    && /vp\.vin_platforms vin_channels/.test(routes)
    && !/vp\.platforms vin_channels/.test(routes),
    'platforms is every channel with a record; only vin_platforms filed a VIN');
  check('…and the count of distinct VINs, so a disagreement is visible rather than resolved',
    /vp\.distinct_vins/.test(routes));
  const ui0 = readFileSync('api/public/vehicle.js', 'utf8');
  check('the "two channels agree" tile requires both to have filed, and to agree',
    /vin_channels \|\| \[\]\)\.length > 1 && r\.distinct_vins === 1/.test(ui0),
    'counting rows with two channels counts plates where neither filed a VIN');
  check('…and a disagreement gets a tile of its own rather than one VIN chosen silently',
    /Two channels disagree/.test(ui0) && /distinct_vins \|\| 0\) > 1/.test(ui0));
  const ui = readFileSync('api/public/vehicle.js', 'utf8');
  check('the page counts distinct VINs beside the plate count',
    /new Set\(rows\.map\(\(r\) => r\.vin\)\.filter\(Boolean\)\)/.test(ui));
  check('…and says how many plates carry none rather than implying the rest are duplicates',
    /plates carry'\)\} no VIN/.test(ui) || /no VIN, so/.test(ui));
  check('the VIN is a column and is searchable',
    /label: 'VIN', key: 'vin'/.test(ui) && /r\.vin \|\| ''/.test(ui));
  /* The row cap that sat under "this is the whole fleet". */
  check('the directory\'s row cap is above anything this register can reach',
    /const DIR_LIMIT = (\d+);/.test(routes) && Number(/const DIR_LIMIT = (\d+);/.exec(routes)[1]) >= 2000,
    /const DIR_LIMIT = (\d+);/.exec(routes)?.[1]);
  check('…and hitting it raises rather than quietly serving part of a fleet the page calls whole',
    /rows\.length > DIR_LIMIT[\s\S]{0,600}throw new Error/.test(routes));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
