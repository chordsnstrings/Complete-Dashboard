/* Every pickup and drop-off placed — the ladder, rung by rung, on real strings.
   ──────────────────────────────────────────────────────────────────────────
   src/place_resolve.js turns an address the dash-form parser could not read
   into an area, or into the true reason it cannot. The strings below were read
   off production (GET /api/trips/list, 9–15 Nov 2026; test/fixtures/
   place_addresses.json — places only), and the vocabulary is the one the
   fleet's own history produced over the same sample, plus the place_cell
   names the production gazetteer printed on driver-day fixes.

   What each block pins, and the case that made it necessary:
     · the JS twin of place_area() agrees with the SQL function, on PGlite,
       for every fixture string — the ladder's first rung must be today's rule;
     · the name matcher never returns "Dubai" (the first rough matcher did),
       never matches an Arabic-script name on a digit left behind (it did, on
       a stray "1"), prefers the name nearest the end, and falls back to the
       weak "Jumeirah" only when nothing better is in the text;
     · the plus-code decoder recovers Google's short codes against the
       emirate the address names, and lands each real code in its own area;
     · the ladder's order and the basis each rung reports;
     · the tracker window: a fix outside it is not used, FMS beats a nearer
       CABMAN fix inside it;
     · the reason an endpoint is absent says both halves of the failure. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import {
  placeArea, matchName, buildVocabulary, vocabularyName, tokens, textFailure, zoneArea,
  findPlusCode, decodePlusCode, decodeFull, plusCodeRef, DUBAI,
  resolveEndpoint, chooseFix, reasonText, TRACKER_WINDOW_MIN, BASIS_TEXT,
} from '../src/place_resolve.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const F = JSON.parse(readFileSync(new URL('./fixtures/place_addresses.json', import.meta.url), 'utf8'));
const vocab = buildVocabulary(F.vocabulary);
const addrs = F.addresses.map((a) => a.addr);

console.log('\nthe first rung is today\'s rule: the JS twin equals place_area() on PGlite');
{
  const db = new PGlite();
  await applySchema(db);
  /* Every fixture string, plus the dash-form cases places.test.mjs pins,
     plus the edge shapes: blank segments, a trailing FMS comma, a code in the
     area position, two segments, nothing. */
  const extra = [
    '45HMWX6 - Madinat Jumeirah -  1 -  - United Arab Emirates,',
    '60 Al Falak St - Al Sufouh - Dubai Media City - Dubai - United Arab Emirates,',
    'Boulevard Street - برج خليفة - Burj Residence Phase I & II - دبي - 阿拉伯联合酋长国',
    'X - E 11 - Dubai - United Arab Emirates', 'X - 9 - Dubai - UAE', 'Dubai - UAE', '', null,
  ];
  let same = 0, n = 0;
  const diffs = [];
  for (const a of [...addrs, ...extra]) {
    const sql = (await db.query('SELECT place_area($1) AS a', [a])).rows[0].a;
    n++;
    if (sql === placeArea(a)) same++; else diffs.push(`${a} sql=${sql} js=${placeArea(a)}`);
  }
  check(`placeArea() === place_area() on all ${n} strings`, same === n, diffs.slice(0, 3).join(' | '));
  await db.close();
}

console.log('\nthe vocabulary: names an area, not the city, not a code, Latin only');
{
  check('"Dubai" is not an area', !vocabularyName('Dubai'));
  check('"United Arab Emirates" is not an area', !vocabularyName('United Arab Emirates'));
  check('"Abu Dhabi" (an emirate) is not an area', !vocabularyName('Abu Dhabi'));
  check('an Arabic-script name is not in the vocabulary', !vocabularyName('برج خليفة'));
  check('a code is not an area ("W44", "E 11", "57VWG8")',
    !vocabularyName('W44') && !vocabularyName('E 11') && !vocabularyName('57VWG8'));
  check('filler alone is not an area ("Street 6", "Tower 2", "Unnamed Road")',
    !vocabularyName('Street 6') && !vocabularyName('Tower 2') && !vocabularyName('Unnamed Road'));
  check('"Dubai Marina" IS an area — a generic word inside a real name does not disqualify it',
    vocabularyName('Dubai Marina'));
  check('"Al Barsha 1" is an area — digits are fine beside a name', vocabularyName('Al Barsha 1'));
  /* The vocabulary as built from the fixture never holds a generic name, so
     no match can ever return one. */
  const all = [...vocab.byFirst.values()].flat().map((v) => v.name);
  check('the built vocabulary holds no "Dubai" and no non-Latin name',
    !all.includes('Dubai') && all.every((n) => /^[\x00-\x7f]*$/.test(n.normalize('NFKD').replace(/[̀-ͯ]/g, ''))),
    all.filter((n) => n === 'Dubai').join());
  const one = buildVocabulary([{ name: 'Loop Restaurant', n: 1 }, { name: 'Al Barsha', n: 2 }]);
  check('a name one trip produced is left out (minN 2)', one.size === 1);
  const spell = buildVocabulary([{ name: 'Sheikh Zayed Road', n: 3 }, { name: 'Sheikh Zayed Rd', n: 40 }]);
  check('two spellings that fold together keep the more used one',
    spell.size === 1 && matchName('Duja Tower Sheikh Zayed Road AE', spell) === 'Sheikh Zayed Rd');
}

console.log('\nthe one-line and comma forms: the noisy cases first');
{
  const m = (a) => matchName(a, vocab);
  /* No string in the fixture may come back as a generic name. */
  const generic = addrs.map((a) => [a, m(a)]).filter(([, r]) => r && !vocabularyName(r));
  check('no fixture string is named "Dubai" or any other generic name', generic.length === 0,
    generic.slice(0, 3).map(([a, r]) => `${r} <- ${a}`).join(' | '));
  check('"Dubai - United Arab Emirates" names nothing', m('Dubai - United Arab Emirates') === null);
  /* The digit trap: the Arabic is a barrier, so its "6" cannot join anything,
     and the Latin road after it is what is named. */
  check('"Duja Tower شارع 6 Sheikh Zayed Road AE" is not matched on the 6',
    m('Duja Tower شارع 6 Sheikh Zayed Road AE') !== null
      && !/^\d/.test(m('Duja Tower شارع 6 Sheikh Zayed Road AE') || ''),
    m('Duja Tower شارع 6 Sheikh Zayed Road AE'));
  check('a name never spans the Arabic: "Sheikh شارع Zayed" is not "Sheikh Zayed …"',
    tokens('Sheikh شارع Zayed').join(' ') === 'sheikh | zayed');
  check('"Avenue Hotel 26c شارع AE" — nothing Latin names an area: null', m('Avenue Hotel 26c شارع AE') === null);
  /* Nearest the end: Uber's one-line form is the dash form with the dashes,
     the city and the country removed, so the last name is the one
     place_area() takes from the dash form of the same place. */
  check('"Al bafta grand building Al Moraqabat Deira AE" → Deira (nearest the end)',
    m('Al bafta grand building Al Moraqabat Deira AE') === 'Deira', m('Al bafta grand building Al Moraqabat Deira AE'));
  check('"Ahad Residences Marasi Drive Business Bay AE" → Business Bay',
    m('Ahad Residences Marasi Drive Business Bay AE') === 'Business Bay');
  check('"Ciel Dubai Marina King Salman … Dubai Marina AE" → Dubai Marina',
    m('Ciel Dubai Marina King Salman Bin Abdulaziz Al Saud Street Dubai Marina AE') === 'Dubai Marina');
  check('"Chaimaa Premiere 12 Street Jumeirah Village Circle (JVC) AE" → the community, not a fragment',
    ['Jumeirah Village Circle', 'JVC'].includes(m('Chaimaa Premiere 12 Street Jumeirah Village Circle (JVC) AE')),
    m('Chaimaa Premiere 12 Street Jumeirah Village Circle (JVC) AE'));
  check('the longer name wins at the same end: "… Dubai Production City AE" is not "Production City"',
    m('Serviced Accomodation Unnamed Road Dubai Production City AE') === 'Dubai Production City');
  /* Yandex puts "Jumeirah" ABOVE Dubai Marina; Google's dash form of the
     same place says Dubai Marina. "Jumeirah" is a weak name: fallback only. */
  check('Yango "Shemara Tower, Jumeirah Beach Residence, Dubai Marina, Jumeirah, Dubai" → Dubai Marina',
    m('Shemara Tower, Jumeirah Beach Residence, Dubai Marina, Jumeirah, Dubai') === 'Dubai Marina');
  check('Yango "…, Al Muraqqabat, Deira, Dubai" → Deira',
    m('Nojoum Hotel Apartments, Al Muraqqabat, Deira, Dubai') === 'Deira');
  check('Yango "Mall of the Emirates, Al Barsha 1, Al Barsha, Hadaeq Mohammed Bin Rashid, Dubai" names an Al Barsha',
    /^Al Barsha/.test(m('Mall of the Emirates, Al Barsha 1, Al Barsha, Hadaeq Mohammed Bin Rashid, Dubai') || ''),
    m('Mall of the Emirates, Al Barsha 1, Al Barsha, Hadaeq Mohammed Bin Rashid, Dubai'));
  check('"Jumeirah 1 99 Street Pearl Jumeirah Island AE" names a Jumeirah, not "Dubai"',
    /Jumeirah/.test(m('Jumeirah 1 99 Street Pearl Jumeirah Island AE') || ''));
  check('the weak name alone still answers: "… Jumeirah Beach Road Jumeirah AE"-shape',
    matchName('Some Villa, Jumeirah, Dubai', buildVocabulary([{ name: 'Jumeirah', n: 9 }])) === 'Jumeirah');
  check('…but loses to any real name in the text',
    matchName('Shemara Tower, Dubai Marina, Jumeirah, Dubai',
      buildVocabulary([{ name: 'Jumeirah', n: 99 }, { name: 'Dubai Marina', n: 2 }])) === 'Dubai Marina');
  /* Bolt's comma form. */
  check('Bolt "DAMAC Hills, Dubai" → DAMAC Hills', m('DAMAC Hills, Dubai') === 'DAMAC Hills');
  check('Bolt "Jumeirah Golf Estates, Dubai" → Jumeirah Golf Estates', m('Jumeirah Golf Estates, Dubai') === 'Jumeirah Golf Estates');
  check('Bolt "52B Street 46, Dubai" names nothing — a street number is not an area', m('52B Street 46, Dubai') === null);
  check('Bolt "86 Street 12, Sharjah" names nothing — the emirate is not an area', m('86 Street 12, Sharjah') === null);
  /* Accents do not hide a name ("Dubaï - Émirats arabes unis"). */
  check('accents are folded: "Anantara Downtown Dubai Hotel, Dubaï - Émirats arabes unis" → Downtown Dubai',
    m('Anantara Downtown Dubai Hotel, Dubaï - Émirats arabes unis') === 'Downtown Dubai');
  /* Coverage over the fixture's one-line and comma strings, so a change that
     quietly breaks the matcher shows as a number, not a feeling. */
  const textForms = F.addresses.filter((a) => !placeArea(a.addr) && !findPlusCode(a.addr));
  const named = textForms.filter((a) => m(a.addr) || zoneArea(a.addr));
  console.log(`    (${named.length} of ${textForms.length} fixture strings the dash rule cannot read are named)`);
  /* A floor at the figure measured when this was written (48 of 78; the
     rest are street numbers, Chinese-script city names, "Dubai - United
     Arab Emirates" and malls the vocabulary does not hold — the tracker's
     job). A change that quietly breaks the matcher drops below it. */
  check('at least 48 of the fixture strings the dash rule cannot read get a name',
    named.length >= 48, `${named.length}/${textForms.length}`);
  check('Yango "Dubai International Airport, Terminal 3 (Emirates)" → the vocabulary\'s "Dubai Int\'l Airport"',
    m('Dubai International Airport, Terminal 3 (Emirates)') === "Dubai Int'l Airport",
    m('Dubai International Airport, Terminal 3 (Emirates)'));
}

console.log('\nAbu Dhabi\'s zone code in the area position');
{
  check('"Nation Towers - Corniche St - Al Bateen - W44 - Abu Dhabi - …" → Al Bateen',
    zoneArea('Nation Towers - Corniche St - Al Bateen - W44 - Abu Dhabi - United Arab Emirates') === 'Al Bateen');
  check('"… - Al Maryah Island - MI1 - Abu Dhabi - …" → Al Maryah Island',
    zoneArea('B3 under the Rosewood Hotel, The Galleria - Al Maryah Island - MI1 - Abu Dhabi - United Arab Emirates') === 'Al Maryah Island');
  check('a Dubai dash form is not touched by it', zoneArea('Cluster T - Al Thanyah Fifth - Jumeirah Lakes Towers - Dubai - UAE') === null);
  const z = resolveEndpoint({ addr: 'Al Rawdah - W54 - Abu Dhabi - United Arab Emirates' }, { vocab });
  check('…and the ladder uses it: basis address_name, rule zone_code', z.area === 'Al Rawdah'
    && z.basis === 'address_name' && z.detail?.rule === 'zone_code', JSON.stringify(z));
}

console.log('\nwhy an address could not be read');
{
  check('empty → no_address', textFailure('') === 'no_address' && textFailure(null) === 'no_address');
  check('"Dubai - United Arab Emirates" → city_only', textFailure('Dubai - United Arab Emirates') === 'city_only');
  check('"阿拉伯联合酋长国迪拜酋长国" → other_script, not "names no area"', textFailure('阿拉伯联合酋长国迪拜酋长国') === 'other_script');
  check('"52B Street 46, Dubai" → unknown_name', textFailure('52B Street 46, Dubai') === 'unknown_name');
}

console.log('\nplus codes: the real ones, decoded');
{
  check('found in "35J6+VH - Dubai - United Arab Emirates"', findPlusCode('35J6+VH - Dubai - United Arab Emirates') === '35J6+VH');
  check('found when the code runs straight on from Chinese script',
    findPlusCode('阿拉伯联合酋长国迪拜酋长国347Q+947') === '347Q+947');
  check('not found in a plain address', findPlusCode('Ahad Residences Marasi Drive Business Bay AE') === null);
  /* Worked by hand from the published alphabet (23456789CFGHJMPQRVWX) and
     pair resolutions (20°, 1°, 0.05°, 0.0025°, 0.000125°): 7HQQ is the
     reference's own prefix for Dubai, and 7HQQ35J6+VH has its south-west
     corner at 25.082125, 55.161375; the centre is half a cell on. */
  const p = decodePlusCode('35J6+VH', DUBAI);
  check('35J6+VH → 25.08219, 55.16144 (7HQQ35J6+VH, by hand)',
    Math.abs(p.lat - 25.0821875) < 1e-9 && Math.abs(p.lng - 55.1614375) < 1e-9, JSON.stringify(p));
  const full = decodeFull('7HQQ35J6+VH');
  check('the full code decodes to the same point', Math.abs(full.lat - p.lat) < 1e-12 && Math.abs(full.lng - p.lng) < 1e-12);
  const h = decodePlusCode('67JH+FQH', DUBAI);
  /* Eleven characters: the last is a grid step (5 rows by 4 columns of the
     0.000125° cell). H is 11 → row 2, column 3: +0.00005° N, +0.00009375° E
     on the 10-digit corner 25.231125, 55.279375, then half a grid cell. */
  check('the hotel\'s 67JH+FQH (11 digits, grid step) → 25.2311875, 55.279484375 (by hand)',
    Math.abs(h.lat - 25.2311875) < 1e-9 && Math.abs(h.lng - 55.279484375) < 1e-9, JSON.stringify(h));
  /* The reference matters: a four-character code is a one-degree square, and
     recovering an Abu Dhabi code against Dubai would move it a whole degree. */
  const ad = decodePlusCode('F8J9+XX', plusCodeRef('F8J9+XX - Abu Dhabi - United Arab Emirates'));
  check('an Abu Dhabi code is recovered against Abu Dhabi (24.x N, 54.x E), not Dubai',
    ad.lat > 24 && ad.lat < 25 && ad.lng > 54 && ad.lng < 55, JSON.stringify(ad));
  check('an invalid code decodes to null', decodePlusCode('35J+VH') === null && decodeFull('ZZZZ') === null);
  /* At scale, against the production sample (docs/COVERAGE.md): of 981
     dash-form addresses that START with a plus code, the decoded position's
     booking_cell named the address's own area on 84.5%, and 0 when the
     position was moved 5 km. Here, the same property on the fixture's own
     such addresses: each decodes inside the UAE box near Dubai. */
  const lead = F.addresses.filter((a) => /^[23456789CFGHJMPQRVWX]{4}\+/.test(a.addr) && placeArea(a.addr));
  const near = lead.filter((a) => {
    const q = decodePlusCode(findPlusCode(a.addr), plusCodeRef(a.addr));
    return q && Math.abs(q.lat - DUBAI.lat) < 0.5 && Math.abs(q.lng - DUBAI.lng) < 0.5;
  });
  check(`every leading code in the fixture (${lead.length}) decodes within half a degree of Dubai`,
    lead.length > 5 && near.length === lead.length);
}

console.log('\nthe ladder: order and basis');
{
  /* A toy gazetteer: one named cell at the point 35J6+VH decodes to, one at
     a tracker fix, one at the booking's own coordinates. */
  const named = new Map([
    ['5016,11032', { area: 'Al Sufouh', votes: 12, seen: 14, named_by: 'booking_cell' }],
    ['5040,11054', { area: 'Business Bay', votes: 40, seen: 44, named_by: 'booking_cell' }],
    ['5024,11048', { area: 'Al Quoz', votes: 3, seen: 9, named_by: 'place_cell' }],
  ]);
  const cellArea = (lat, lng) => named.get(`${Math.round(lat / 0.005)},${Math.round(lng / 0.005)}`) || null;
  const ctx = { vocab, cellArea };
  const fix = { lat: 25.2, lng: 55.27, at: '2026-11-12T10:02:00Z', minutes: 2, source: 'fms' };
  const r1 = resolveEndpoint({ addr: '57RR+GCJ The Bay - 65 Marasi Dr - Business Bay - Dubai - United Arab Emirates', plate: 'L1', at: 'x', fix }, ctx);
  check('1. a dash-form address → basis "address", even with a fix to hand', r1.basis === 'address' && r1.area === 'Business Bay');
  const r2 = resolveEndpoint({ addr: 'Al bafta grand building Al Moraqabat Deira AE', lat: 25.12, lng: 55.24, plate: 'L1', at: 'x', fix }, ctx);
  check('2. one-line text → "address_name", before the booking\'s own coordinates', r2.basis === 'address_name' && r2.area === 'Deira');
  const r3 = resolveEndpoint({ addr: '35J6+VH - Dubai - United Arab Emirates', lat: 25.12, lng: 55.24, plate: 'L1', at: 'x', fix }, ctx);
  check('3. a plus code → "plus_code", before coordinates and tracker', r3.basis === 'plus_code' && r3.area === 'Al Sufouh'
    && r3.named_by === 'booking_cell' && r3.detail.code === '35J6+VH', JSON.stringify(r3));
  const r4 = resolveEndpoint({ addr: '', lat: 25.12, lng: 55.24, plate: 'L1', at: 'x', fix }, ctx);
  check('4. the booking\'s coordinates → "coordinates", before the tracker', r4.basis === 'coordinates' && r4.area === 'Al Quoz'
    && r4.named_by === 'place_cell');
  const r5 = resolveEndpoint({ addr: '', plate: 'L1', at: '2026-11-12T10:00:00Z', fix }, ctx);
  check('5. nothing else → "tracker", with the fix\'s evidence', r5.basis === 'tracker' && r5.area === 'Business Bay'
    && r5.detail.minutes === 2 && r5.detail.source === 'fms', JSON.stringify(r5));
  const r5a = resolveEndpoint({ addr: '', plate: 'L1', at: '2026-11-12T10:00:00Z' }, ctx);
  check('…and before the database is asked, the rung says it needs a fix', r5a.needsFix === true && r5a.area === null);
  const r6 = resolveEndpoint({ addr: '', plate: 'L1', at: '2026-11-12T10:00:00Z', fix: null }, ctx);
  check('6. no fix → absent "no_address+no_fix"', r6.area === null && r6.reason === 'no_address+no_fix');
  check('…in words: "no address, and no tracker fix within 5 minutes"',
    reasonText(r6.reason) === `no address, and no tracker fix within ${TRACKER_WINDOW_MIN} minutes`, reasonText(r6.reason));
  const r7 = resolveEndpoint({ addr: '52B Street 46, Dubai', plate: 'L1', at: 'x', fix: { lat: 25.3, lng: 55.5, minutes: 1, source: 'fms' } }, ctx);
  check('a fix in a cell nobody named → "unknown_name+unnamed_cell"', r7.reason === 'unknown_name+unnamed_cell', r7.reason);
  const r8 = resolveEndpoint({ addr: 'Dubai - United Arab Emirates', plate: null, at: 'x' }, ctx);
  check('no plate → "city_only+no_plate"', r8.reason === 'city_only+no_plate');
  const r9 = resolveEndpoint({ addr: '', plate: 'L1', at: null, cancelled: true }, ctx);
  check('a cancelled booking\'s drop-off with no time → "…+cancelled", the true reason',
    r9.reason === 'no_address+cancelled' && /cancelled before any drop-off/.test(reasonText(r9.reason)));
  const r10 = resolveEndpoint({ addr: '', plate: 'L1', at: null }, ctx);
  check('…and a drop-off with no time otherwise → "no_time"', r10.reason === 'no_address+no_time');
  check('the tracker basis says it is the car, not the platform',
    BASIS_TEXT.tracker === "placed by the car's tracker at the request time");
  /* The bad fix: 0,0 on boot is not a position. */
  const r11 = resolveEndpoint({ addr: '', plate: 'L1', at: 'x', fix: { lat: 0, lng: 0, minutes: 1 } }, ctx);
  check('a 0,0 fix is not used', r11.area === null && r11.reason === 'no_address+no_fix');
}

console.log('\nthe tracker window');
{
  const at = '2026-11-12T10:00:00Z';
  const f = (min, source = 'fms', lat = 25.2) => ({ at: new Date(Date.parse(at) + min * 60000).toISOString(), lat, lng: 55.27, source });
  check(`the window is ${TRACKER_WINDOW_MIN} minutes (measured: FMS reports every 6.2 min at the median)`, TRACKER_WINDOW_MIN === 5);
  check('a fix 6 minutes away is NOT used', chooseFix([f(6)], at) === null);
  check('a fix 5 minutes away is used', chooseFix([f(-5)], at)?.minutes === 5);
  check('the nearest of two inside the window', chooseFix([f(4), f(-1)], at)?.minutes === 1);
  check('FMS beats a nearer CABMAN fix inside the window (the two-tracker trap)',
    chooseFix([f(0.5, 'cabman', 25.3), f(3, 'fms')], at)?.source === 'fms');
  check('CABMAN is used where it is the only tracker', chooseFix([f(2, 'cabman')], at)?.source === 'cabman');
  check('a 0,0 fix inside the window is skipped', chooseFix([{ at, lat: 0, lng: 0, source: 'fms' }], at) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
