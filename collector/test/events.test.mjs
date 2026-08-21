// Validates the world-event + break-attribution layer against the REAL Uber year
// (160k trips pulled from the report pipeline), using an in-process Postgres.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

for (const f of ['schema.sql', 'schema_v2.sql', 'schema_v3.sql']) await db.exec(readFileSync(`sql/${f}`, 'utf8'));

// ── load the real year of Uber trips ─────────────────────────────────────
const dir = '/tmp/yearpull';
if (!existsSync(dir)) { console.log('no year data on disk — skipping'); process.exit(0); }
let loaded = 0;
for (const f of readdirSync(dir).filter((x) => x.endsWith('.csv')).sort()) {
  const recs = parse(readFileSync(`${dir}/${f}`, 'utf8'),
    { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
  const vals = [], params = [];
  let i = 0;
  for (const r of recs) {
    const id = r['Trip UUID']; const ts = r['Trip request time'];
    if (!id || !ts) continue;
    vals.push(`($${++i},$${++i},$${++i},$${++i},$${++i},$${++i},$${++i})`);
    params.push('uber', id, 'ecosine', r['Number plate'] || null, r['Driver UUID'] || null,
      ts.replace(' ', 'T') + '+04:00', r['Trip status'] || null);
    if (vals.length >= 500) {
      await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,requested_at,status)
               VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
      loaded += vals.length; vals.length = 0; params.length = 0; i = 0;
    }
  }
  if (vals.length) {
    await q(`INSERT INTO trip (platform,external_id,fleet_id,plate,driver_ext_id,requested_at,status)
             VALUES ${vals.join(',')} ON CONFLICT DO NOTHING`, params);
    loaded += vals.length;
  }
}
console.log(`loaded ${loaded} real Uber trips`);
check('real year data loaded', loaded > 100000, String(loaded));

// ── seed the seasonal + Ramadan events the collector would write ─────────
const seasonal = [];
for (const y of [2025, 2026]) {
  seasonal.push(['seasonal', 'summer', `Dubai summer ${y}`, 'seasonal', 'dubai', `${y}-06-15`, `${y}-09-15`, 'demand_down', 0.75]);
  seasonal.push(['seasonal', 'high_season', `Dubai high season ${y}`, 'seasonal', 'dubai', `${y}-11-01`, `${y + 1}-03-31`, 'demand_up', 0.8]);
  seasonal.push(['seasonal', 'school_summer_break', `UAE school summer break ${y}`, 'seasonal', 'uae', `${y}-07-01`, `${y}-08-31`, 'demand_down', 0.6]);
}
// Ramadan 1447 ≈ 19 Feb – 20 Mar 2026 (the window containing the observed break)
seasonal.push(['calendar', 'ramadan', 'Ramadan 1447', 'holiday', 'uae', '2026-02-19', '2026-03-20', 'demand_down', 0.85]);
seasonal.push(['calendar', 'eid_fitr', 'Eid al-Fitr 1447', 'holiday', 'uae', '2026-03-20', '2026-03-23', 'demand_up', 0.7]);
for (const s of seasonal) {
  await q(`INSERT INTO world_event (source,code,title,category,scope,starts_on,ends_on,expected_effect,confidence)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, s);
}
check('world events seeded', (await q('SELECT count(*)::int n FROM world_event'))[0].n === seasonal.length);

// ── break detection over the real series ─────────────────────────────────
const series = await q(
  `SELECT date_trunc('month', requested_at)::date m, count(*)::int trips,
          count(distinct driver_ext_id)::int drivers
   FROM trip WHERE platform='uber' GROUP BY 1 ORDER BY 1`);
console.log('\nmonthly series from real data:');
const ym = (d) => new Date(d).toISOString().slice(0, 7);
for (const r of series) console.log(`  ${ym(r.m)}  trips=${String(r.trips).padStart(6)}  drivers=${r.drivers}`);

const breaks = [];
for (let i = 1; i < series.length; i++) {
  const a = series[i - 1], b = series[i];
  const change = (b.trips - a.trips) / a.trips;
  if (Math.abs(change) < 0.30) continue;
  const dChange = (b.drivers - a.drivers) / (a.drivers || 1);
  const prodA = a.trips / (a.drivers || 1), prodB = b.trips / (b.drivers || 1);
  const pChange = (prodB - prodA) / prodA;
  let attribution = 'mixed';
  if (Math.abs(pChange) > Math.abs(dChange) * 2) attribution = 'demand';
  else if (Math.abs(dChange) > Math.abs(pChange) * 2) attribution = 'supply';
  const ev = await q(
    `SELECT title, expected_effect, confidence FROM world_event
     WHERE starts_on <= $2 AND coalesce(ends_on,starts_on) >= $1 ORDER BY confidence DESC`, [a.m, b.m]);
  breaks.push({ from: ym(a.m), to: ym(b.m),
    change: Math.round(change * 100), dChange: Math.round(dChange * 100),
    pChange: Math.round(pChange * 100), attribution, events: ev.map((e) => e.title) });
}

console.log('\nstructural breaks detected:');
for (const b of breaks) {
  console.log(`  ${b.from} → ${b.to}: trips ${b.change > 0 ? '+' : ''}${b.change}%  drivers ${b.dChange > 0 ? '+' : ''}${b.dChange}%  productivity ${b.pChange > 0 ? '+' : ''}${b.pChange}%  → ${b.attribution.toUpperCase()}`);
  console.log(`      overlapping events: ${b.events.join('; ') || '(none)'}`);
}

check('detects at least one structural break', breaks.length >= 1, `${breaks.length}`);
const febMar = breaks.find((b) => b.from === '2026-02' && b.to === '2026-03');
check('finds the Feb→Mar 2026 collapse', !!febMar, JSON.stringify(breaks.map((b) => `${b.from}->${b.to}`)));
if (febMar) {
  check('collapse is ~-76%', febMar.change < -70 && febMar.change > -82, `${febMar.change}%`);
  check('attributed to demand, not driver headcount', febMar.attribution === 'demand', febMar.attribution);
  check('Ramadan surfaced as a candidate cause', febMar.events.some((t) => /ramadan/i.test(t)), JSON.stringify(febMar.events));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
