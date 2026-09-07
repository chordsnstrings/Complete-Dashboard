/* Turning a coordinate into a place a person can picture.
   ──────────────────────────────────────────────────────────────────────────
   The driver day printed "25.112, 55.139" against every waiting block and had
   nothing at all to say about where somebody went online. Both are questions
   about an area, and neither survives being answered with a decimal pair.

   Two things had to be true for the answer to exist, and this file pins both:

   1. The rule for reading an area out of an address. The read API took the
      SECOND dash-separated segment, which on real production addresses is a
      street, a sub-community, or the second floor of a hotel — rendered under
      the heading "area" on the Territory tab. The area is the third segment
      from the END, before city and country, and counting from the end is the
      only version that survives an address written in Arabic.

   2. The gazetteer. No provider gives both a name and a position: Uber has
      315,505 addresses and zero coordinates, FMS has 222,543 coordinates each
      with an address beside it. The names therefore come from the fleet's own
      history, folded to half-kilometre cells, with the modal name winning. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync } from 'node:fs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

const area = async (s) => (await q('SELECT place_area($1) AS a', [s]))[0].a;

console.log('\nthe area in an address, against real production strings');
{
  /* Every one of these was read off production on 2026-09-07. The second
     column is what the rule must return; the third is what the OLD rule
     (second segment from the front) returned, and it is here so that a
     regression to it cannot pass. */
  const CASES = [
    ['Cluster T - Al Thanyah Fifth - Jumeirah Lakes Towers - Dubai - United Arab Emirates',
      'Jumeirah Lakes Towers', 'Al Thanyah Fifth'],
    ['4538+544 - Al Falak St - Al Safouh Second - Dubai Internet City - Dubai - United Arab Emirates',
      'Dubai Internet City', 'Al Falak St'],
    ['AL JAZ 3 - Al Thanyah Third - The Greens - Dubai - United Arab Emirates',
      'The Greens', 'Al Thanyah Third'],
    ['King’s College Hospital London - Hadaeq Sheikh Mohammed Bin Rashid - Dubai Hills - Dubai - United Arab Emirates',
      'Dubai Hills', 'Hadaeq Sheikh Mohammed Bin Rashid'],
    ['Sheraton Hotel, Mall of The Emirates - Level 2 - Sheikh Zayed Rd - Al Barsha First - Al Barsha - Dubai - United Arab Emirates',
      'Al Barsha', 'Level 2'],
    ['ParkLane Tower - Al A\'amal St - Business Bay - Dubai - United Arab Emirates',
      'Business Bay', 'Al A\'amal St'],
    ['Boulevard Plaza Tower 1 - Burj Khalifa - Downtown Dubai - Dubai - United Arab Emirates',
      'Downtown Dubai', 'Burj Khalifa'],
    ['Unnamed Road - Hadaeq Sheikh Mohammed Bin Rashid - Dubai - United Arab Emirates',
      'Hadaeq Sheikh Mohammed Bin Rashid', 'Hadaeq Sheikh Mohammed Bin Rashid'],
    ['Al Thanyah Second - Dubai - United Arab Emirates', 'Al Thanyah Second', 'Dubai'],
  ];
  for (const [addr, want, old] of CASES) {
    const got = await area(addr);
    check(`${want} ← ${addr.slice(0, 46)}…`, got === want, `got ${JSON.stringify(got)}`);
    if (want !== old) {
      check(`  …and not "${old}", which is what the second segment gives`, got !== old);
    }
  }
}

console.log('\nthe cases the old rule silently got wrong');
{
  /* A meaningful share of these addresses are not in English. A rule that
     recognises "Dubai" and "United Arab Emirates" by name drops them; a rule
     that counts from the end does not care what alphabet the city is in. */
  check('an address whose city and country are not in Latin script still resolves',
    await area('Boulevard Street - برج خليفة - Burj Residence Phase I & II - دبي - 阿拉伯联合酋长国')
      === 'Burj Residence Phase I & II');
  check('…and one with a Chinese country but an English city',
    await area('Sheikh Mohammed bin Rashid Boulevard - Burj Khalifa - Downtown Dubai - Dubai - 阿拉伯联合酋长国')
      === 'Downtown Dubai');
  /* FMS suffixes every address with a comma, and sometimes a trailing space. */
  check('FMS\'s trailing comma does not become part of the name',
    await area('60 Al Falak St - Al Sufouh - Dubai Media City - Dubai - United Arab Emirates,')
      === 'Dubai Media City');
  check('…nor its trailing space',
    await area('Rostamani Tower - Dubai - United Arab Emirates, ') === 'Rostamani Tower');

  console.log('\n  and what has no area in it is absent, not guessed');
  check('an address with no separators at all is NULL',
    await area('Mall of Emirates Al Barsha 1 AE') === null,
    'the house rule is absent with a reason, never a plausible-looking guess');
  check('two segments — a city and a country and nothing else — is NULL',
    await area('Dubai - United Arab Emirates') === null);
  check('empty is NULL', await area('') === null);
  check('NULL is NULL', await area(null) === null);
}

console.log('\nthe two things the first version got wrong (sql/schema_v68.sql)');
{
  /* Every string here was read off production on 2026-09-07, out of the
     gazetteer schema_v67 actually built: 4,855 cells over 709 names, and some
     of those "names" were "9", "1", "4762VVF" and "D71". */
  console.log('\n  blank segments are punctuation, not places');
  check('a run of empty segments does not shift the count past the community',
    await area('45HMWX6 - Madinat Jumeirah -  1 -  - United Arab Emirates,') === 'Madinat Jumeirah',
    'counting three from the end over the RAW split landed on "1" — 69 of one driver\'s 222 fixes');
  check('…even when what is left is only just long enough',
    await area('Barsha Road Saleh Bin Lahej Building Shop #5 -  -  1 -  - United Arab Emirates,')
      === 'Barsha Road Saleh Bin Lahej Building Shop #5');

  console.log('\n  a code is not a place name');
  for (const [addr, what] of [
    ['57VWG8 - Dubai - United Arab Emirates,', 'a plus code'],
    ['3583+3W3 - Dubai - United Arab Emirates,', 'a plus code with its separator'],
    ['4762VVF - Dubai - United Arab Emirates,', 'a plus code'],
    ['D71 - Dubai - United Arab Emirates, ', 'a road designation'],
    ['E 11 - Dubai - United Arab Emirates', 'a road designation with a space'],
    ['9 - Dubai - United Arab Emirates', 'a bare number'],
  ]) {
    check(`${what} returns NULL rather than being printed as an area`,
      await area(addr) === null, `got ${JSON.stringify(await area(addr))}`);
  }

  console.log('\n  …but a coarse TRUE answer is still an answer');
  check('a street is kept — a person can picture it',
    await area('X - Y - Sheikh Zayed Rd - Dubai - UAE') === 'Sheikh Zayed Rd',
    'the house rule refuses codes, not coarseness');
  check('an all-caps name with no digit is kept',
    await area('Tower - JLT - Dubai - UAE') === 'JLT');
  check('a community whose name ENDS in a number is kept',
    await area('Villa 4 - Al Barsha 1 - Dubai - UAE') === 'Al Barsha 1',
    '"Al Barsha 1" is a real community; "1" is not');
}

console.log('\nthe gazetteer: what the fleet\'s own history calls each patch of ground');
{
  const { refreshPlaceCells, cellOf, CELL, IN_UAE } = await import('../src/places.js');
  let n = 0;
  const trip = (plat, plat_lat, plat_lng, addr, dlat, dlng, daddr) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, requested_at,
       pickup_lat, pickup_lng, pickup_addr, dropoff_lat, dropoff_lng, dropoff_addr)
     VALUES ($1, $2, 'ecosine', now(), $3, $4, $5, $6, $7, $8)`,
    [plat, `p${n++}`, plat_lat, plat_lng, addr, dlat, dlng, daddr]);

  /* One cell, named "Business Bay" by four trips and "Rostamani Tower" by one.
     FMS names a building whenever the reverse geocode came back with only
     three segments, and a person asking where a driver waited wants the
     community, not the tower — so the mode has to let four outvote one. */
  for (let i = 0; i < 4; i++) {
    await trip('fms', 25.1861, 55.2796, 'X - Al Asayel St - Business Bay - Dubai - UAE,',
      25.1862, 55.2797, 'Y - Al Asayel St - Business Bay - Dubai - UAE,');
  }
  await trip('fms', 25.1860, 55.2795, 'Rostamani Tower - Dubai - UAE,', null, null, null);
  /* A tracker reporting 0,0 on boot. Letting it in would put a Dubai community
     name on the Gulf of Guinea. */
  await trip('fms', 0, 0, 'Z - Somewhere - Nowhere - Dubai - UAE,', null, null, null);
  /* An Uber trip: an address and no coordinates at all. It must contribute
     nothing rather than land in a cell keyed on NULL. */
  await trip('uber', null, null, 'A - B - Jumeirah Lakes Towers - Dubai - UAE', null, null, null);

  const built = await refreshPlaceCells(db, { force: true });

  const cells = await q('SELECT * FROM place_cell ORDER BY cell_lat, cell_lng');
  const bay = cells.find((c) => c.area === 'Business Bay');
  check('the community outvotes the single building in the same cell', !!bay,
    `cells: ${JSON.stringify(cells.map((c) => c.area))}`);
  check('…and the losing name is not a row of its own',
    !cells.some((c) => c.area === 'Rostamani Tower'));
  check('…with the vote count kept, so a name one trip supplied can be told from one four agree on',
    bay && bay.n >= 4 && bay.observations >= bay.n);
  check('…and how many different names the cell ever saw',
    bay && bay.distinct_names >= 2);

  check('a 0,0 fix is refused rather than named',
    !cells.some((c) => c.cell_lat === 0 && c.cell_lng === 0));
  check('an address with no coordinates contributes nothing',
    !cells.some((c) => c.area === 'Jumeirah Lakes Towers'),
    'Uber has 315,505 addresses and no fixes; they cannot key a cell');
  check('the build reports what it wrote', built.cells === cells.length && built.areas >= 1);

  console.log('\n  the cell arithmetic');
  check('CELL is half a kilometre, near enough', CELL === 0.005);
  check('cellOf rounds rather than truncates',
    cellOf(25.1861) === Math.round(25.1861 / 0.005) && cellOf(-0.0024) === 0);
  check('IN_UAE rejects the null island', IN_UAE(0, 0) === false);
  check('…and accepts Dubai', IN_UAE(25.1861, 55.2796) === true);
  check('…and rejects a NaN rather than passing it to round()', IN_UAE(NaN, 55) === false);

  console.log('\n  rebuilt whole, so a name can lose');
  /* A merge cannot express a name losing a vote: an address corrected upstream
     would leave the old name outvoting its own replacement for ever. */
  await q('DELETE FROM trip');
  for (let i = 0; i < 3; i++) {
    await trip('fms', 25.1861, 55.2796, 'X - St - Downtown Dubai - Dubai - UAE,', null, null, null);
  }
  await refreshPlaceCells(db, { force: true });
  const after = await q('SELECT area FROM place_cell');
  check('the cell now says what the current history says',
    after.length === 1 && after[0].area === 'Downtown Dubai',
    `got ${JSON.stringify(after.map((r) => r.area))}`);
}

console.log('\n  and it is not rebuilt on every collector pass');
{
  const { refreshPlaceCells } = await import('../src/places.js');
  const fresh = await refreshPlaceCells(db);
  check('a gazetteer built minutes ago is left alone', fresh.skipped === true,
    'the collector runs every 30 minutes and this scans both endpoints of every positioned trip');
  check('…and reports the cells it kept rather than pretending it built them',
    fresh.cells > 0);
  await q("UPDATE place_cell SET built_at = now() - interval '9 hours'");
  const stale = await refreshPlaceCells(db);
  check('…but one older than the window is rebuilt', !stale.skipped);
  await q('DELETE FROM place_cell');
  const empty = await refreshPlaceCells(db);
  check('…and an empty table is always built, so a fresh database is named on the first pass',
    !empty.skipped);
}

console.log('\n  a change to the RULE forces a rebuild');
{
  const v68 = readFileSync('sql/schema_v68.sql', 'utf8');
  check('schema_v68 empties place_cell',
    /DELETE FROM place_cell;/.test(v68),
    'the six-hour freshness guard would otherwise serve names built by the old rule until it expired');
  check('…and it REPLACEs the function rather than editing schema_v67',
    /CREATE OR REPLACE FUNCTION place_area/.test(v68)
      && !/CREATE OR REPLACE FUNCTION place_area/.test(readFileSync('sql/schema_v67.sql', 'utf8').replace(/^--.*$/gm, '').split('COMMENT ON FUNCTION')[1] || ''),
    'migrations replay from the start and the ledger skips shas it has seen — editing v67 would do nothing on production');
}

console.log('\nthe driver day: where somebody went online, in words');
{
  const express = (await import('express')).default;
  const { driverRoutes } = await import('../api/driver_routes.js');
  const { refreshPlaceCells } = await import('../src/places.js');

  const DAY = '2026-08-14';
  const DRV = 'u-online';
  await q('DELETE FROM trip');
  /* Two cells the history names, half a kilometre apart in longitude terms so
     they cannot collapse into one. */
  const seed = async (lat, lng, name, times = 4) => {
    for (let i = 0; i < times; i++) {
      await q(`INSERT INTO trip (platform, external_id, fleet_id, requested_at,
                 pickup_lat, pickup_lng, pickup_addr)
               VALUES ('fms', $1, 'ecosine', now(), $2, $3, $4)`,
      [`seed-${name}-${i}`, lat, lng, `X - St - ${name} - Dubai - UAE,`]);
    }
  };
  await seed(25.1000, 55.1800, 'Al Barsha');
  await seed(25.2000, 55.2800, 'Business Bay');
  await refreshPlaceCells(db, { force: true });

  /* The person's own day: one Uber trip so the plate is discoverable, and the
     tracker reporting that plate through the morning. */
  await q(`INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
             requested_at, ended_at, status, distance_km, price, pickup_addr, dropoff_addr)
           VALUES ('uber', 't-online', 'ecosine', 'L900', $1, 'Online Person',
             '${DAY}T09:00:00+04:00', '${DAY}T09:30:00+04:00', 'completed', 10, 40,
             'A - B - Al Barsha - Dubai - UAE', 'C - D - Business Bay - Dubai - UAE')`, [DRV]);
  const fix = (hh, mm, lat, lng) => q(
    `INSERT INTO telemetry_snapshot (source, plate, captured_at, lat, lng, speed)
     VALUES ('fms', 'L900', $1, $2, $3, 0)`,
    [`${DAY}T${hh}:${mm}:00+04:00`, lat, lng]);
  await fix('08', '00', 25.1000, 55.1800);      // Al Barsha, before the first span
  await fix('08', '30', 25.1000, 55.1800);
  await fix('12', '00', 25.2000, 55.2800);      // Business Bay, before the second
  await fix('12', '30', 25.2000, 55.2800);

  /* Uber's own timeline: two ONLINE spans, and lat/lon NULL exactly as
     production has them on all 197,687 rows. */
  const ev = (hh, mm, status) => q(
    `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, lat, lon)
     VALUES ('uber', 'ecosine', $1, $2, 'status', $3, NULL, NULL)`,
    [DRV, `${DAY}T${hh}:${mm}:00+04:00`, status]);
  await ev('08', '05', 'ONLINE'); await ev('10', '00', 'OFFLINE');
  await ev('12', '10', 'ONLINE'); await ev('14', '00', 'OFFLINE');
  /* A third span in the middle of the night, hours from any fix — the one that
     must come back unplaced rather than borrowing a distant position. */
  await ev('03', '00', 'ONLINE'); await ev('04', '00', 'OFFLINE');

  const app = express();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
  driverRoutes(app, { q, wrap, endOfDay: (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d} 23:59:59.999` : d) });
  const server = app.listen(0);
  const port = server.address().port;
  const day = await (await fetch(`http://127.0.0.1:${port}/api/driver/day?id=${DRV}&day=${DAY}`)).json();

  check('the day still answers', !day.error, JSON.stringify(day).slice(0, 160));
  check('every tracker fix carries the name of the ground it sits on',
    (day.fixes || []).length === 4 && day.fixes.every((f) => f.area),
    JSON.stringify((day.fixes || []).map((f) => f.area)));
  check('…and the votes behind that name, so a page can say how sure it is',
    (day.fixes || []).every((f) => f.area_votes >= 1 && f.area_seen >= f.area_votes));

  const placed = (day.online || []).filter((o) => o.went_online?.where);
  check('the morning span is placed where the tracker had the car',
    placed.some((o) => o.went_online.where === 'Al Barsha'),
    JSON.stringify((day.online || []).map((o) => [o.s, o.went_online])).slice(0, 260));
  check('…and the midday one somewhere else entirely',
    placed.some((o) => o.went_online.where === 'Business Bay'));
  check('…each saying how far off in time the position it used was',
    placed.every((o) => Number.isInteger(o.went_online.within_min) && o.went_online.within_min <= 30));

  const night = (day.online || []).find((o) => o.s < 300);
  check('a span hours from any fix is NOT placed', !!night && !night.went_online?.where,
    'borrowing a five-hour-old position would be a fabricated answer');
  check('…and says why, in words', /too far to call it the same place/.test(night?.went_online?.why || ''));
  check('the unplaceable spans are counted, never quietly dropped',
    (day.online_spans_unplaced || 0) >= 1);

  check('the day summarises which areas this person starts from',
    (day.goes_online_in || []).length === 2
      && day.goes_online_in.every((a) => a.spans >= 1),
    JSON.stringify(day.goes_online_in));
  check('…most used first', (day.goes_online_in || []).every((a, i, all) =>
    i === 0 || all[i - 1].spans >= a.spans));
  check('the response carries the basis, so the page need not invent one',
    /Uber returns no coordinates/.test(day.place_basis || ''));
  server.close();
}

console.log('\nthe source says where the names come from, and where they do not');
{
  const src = readFileSync('src/places.js', 'utf8');
  check('the module records that Uber returns no coordinates',
    /315,505 addresses,\s+0 coordinates/.test(src),
    'the reason this is built from history rather than from a geocoder is the measurement');
  check('…and that it is not a geocoder',
    /What it is NOT: a geocoder[\s\S]{0,120}?never\s+driven near/.test(src));
  const day = readFileSync('api/driver_routes.js', 'utf8');
  check('the day route records that the timeline lat column is empty on production',
    /197,687 timeline events and lat is\s+null on every single one/.test(day),
    'the online position comes from the tracker BECAUSE Uber\'s own field is empty');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
