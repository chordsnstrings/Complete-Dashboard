/* One area, one name (PLC12, 2026-11-16).
   ──────────────────────────────────────────────────────────────────────────
   src/area_alias.js folds exact equivalents — official name, common name,
   abbreviation, a translation in the rider's app language — to the common
   English name, at read time. Held here:

     1. the list: every alias lands on a canonical name that is itself in the
        list (no chains), a canonical name maps to itself, sub-areas are NOT
        folded into their parents, an unknown name passes through untouched;
     2. the SQL twin answers exactly as the JS does, on PGlite, for every
        alias, a sub-area, an unknown name, NULL, and stray whitespace/case;
     3. GET /api/driver/territory groups "Marsa Dubai", "Dubai Marina" and
        "دبي مارينا" into ONE row, its by_basis summed.

   REVERSIONS (each run, each failing as named):
     · placedArea back without canonAreaSql → §3 "one row" fails
     · the prefix rule removed → §1 "JLT Cluster" fails (the twin agrees either way:
       both sides lose the rule together)
     · 'jumeirah 1' folded into 'Jumeirah' → §1 "sub-areas" fails */
import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import { applySchema } from './schema.mjs';
import { AREA_ALIAS, canonArea, canonAreaSql } from '../src/area_alias.js';
import { driverRoutes } from '../api/driver_routes.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

console.log('\n1. the list');
{
  const canon = new Set(Object.values(AREA_ALIAS));
  const chains = [...canon].filter((c) => canonArea(c) !== c);
  check('every canonical name maps to itself — no chains', chains.length === 0, chains.join(', '));
  check('the measured splits fold: Marsa Dubai, دبي مارينا → Dubai Marina',
    canonArea('Marsa Dubai') === 'Dubai Marina' && canonArea('دبي مارينا') === 'Dubai Marina');
  check('Nakhlat Jumeira, The Palm Jumeirah, نخلة جميرا → Palm Jumeirah',
    ['Nakhlat Jumeira', 'The Palm Jumeirah', 'نخلة جميرا'].every((n) => canonArea(n) === 'Palm Jumeirah'));
  check('Business Bay in Arabic, Russian and Turkish → Business Bay',
    ['الخليج التجاري', 'Бизнес-Бэй', 'İş Körfezi'].every((n) => canonArea(n) === 'Business Bay'));
  check('JLT, Jumeirah Lake Towers, and every "JLT Cluster X" → Jumeirah Lakes Towers',
    ['JLT', 'Jumeirah Lake Towers', 'JLT Cluster J', 'jlt cluster  a'].every((n) => canonArea(n) === 'Jumeirah Lakes Towers'));
  check('sub-areas are NOT folded into their parents',
    canonArea('Jumeirah 1') === 'Jumeirah 1' && canonArea('Al Barsha South') === 'Al Barsha South'
      && canonArea('Umm Suqeim 3') === 'Umm Suqeim 3' && canonArea('AL Maktoum International Airport (DWC)') !== 'Dubai International Airport');
  check('an unknown name passes through untouched (trimmed), NULL stays NULL',
    canonArea('  Al Quoz Industrial Area 4 ') === 'Al Quoz Industrial Area 4' && canonArea(null) === null);
  check('case and spacing do not matter', canonArea('  marsa   DUBAI ') === 'Dubai Marina');
}

console.log('\n2. the SQL twin answers as the JS does');
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
{
  const probes = [...Object.keys(AREA_ALIAS), 'JLT Cluster J', 'Jumeirah 1', 'Al Barsha South', 'Somewhere Unlisted',
    '  marsa   DUBAI ', 'Бизнес-Бэй'];
  const bad = [];
  for (const n of probes) {
    const [r] = await q(`SELECT ${canonAreaSql('$1::text')} AS c`, [n]);
    if (r.c !== canonArea(n)) bad.push(`${n} → sql ${r.c} / js ${canonArea(n)}`);
  }
  check(`all ${probes.length} probes agree`, bad.length === 0, bad.slice(0, 5).join(' | '));
  const [nul] = await q(`SELECT ${canonAreaSql('NULL::text')} AS c`);
  check('NULL stays NULL in SQL', nul.c === null);
}

console.log('\n3. the Territory groups one area as one row');
{
  const DRV = 'u-alias';
  let n = 0;
  const trip = (pickup) => q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name, requested_at, ended_at,
                       distance_km, status, price, pickup_addr, dropoff_addr)
     VALUES ('uber', $1, 'ecosine', 'L47002', $2, 'Alias Test', $3, $4, 8, 'completed', 30, $5, '')`,
    [`a${n}`, DRV, `2026-11-12T${String(8 + n).padStart(2, '0')}:00:00+04:00`,
      `2026-11-12T${String(8 + n++).padStart(2, '0')}:20:00+04:00`, pickup]);
  await trip('Marina Walk - Marsa Dubai - Dubai - United Arab Emirates');
  await trip('Marina Walk - Marsa Dubai - Dubai - United Arab Emirates');
  await trip('Pier 7 - Dubai Marina - Dubai - United Arab Emirates');
  await trip('ممشى المارينا - دبي مارينا - دبي - الإمارات العربية المتحدة');
  /* No resolver pass: these read through placedArea's place_area() fallback,
     which is folded the same way as a resolved row. */
  const app = express();
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => res.status(500).json({ error: String(e) }));
  driverRoutes(app, { q, wrap, endOfDay: (d) => `${d} 23:59:59.999` });
  const server = app.listen(0);
  const t = await (await fetch(`http://127.0.0.1:${server.address().port}/api/driver/territory?id=${DRV}&from=2026-11-01&to=2026-11-30`)).json();
  server.close();
  const marina = (t.areas || []).filter((a) => /Marina|Marsa|مارينا/.test(a.area || ''));
  check('"Marsa Dubai" ×2, "Dubai Marina" and "دبي مارينا" are ONE row of 4, named Dubai Marina',
    marina.length === 1 && marina[0].area === 'Dubai Marina' && marina[0].n === 4, JSON.stringify(t.areas));
  check('…its by_basis summed (4 from the address)', marina[0]?.by_basis?.address === 4, JSON.stringify(marina[0]?.by_basis));
}

await db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
