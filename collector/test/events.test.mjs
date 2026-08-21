// Validates the world-event + break-attribution layer against the REAL Uber year
// (160k trips pulled from the report pipeline), using an in-process Postgres.
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);

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

/* ── the real decision function, called rather than reimplemented ─────────
   Everything above walks the same arithmetic by hand, which is why a genuine
   bug — comparing adjacent ROWS instead of adjacent MONTHS — survived a green
   suite and shipped a "-91% collapse" across three months of missing data.
   These call src/sources/events.js directly. */
const { breakBetween, prevMonth } = await import('../src/sources/events.js');

check('prevMonth steps back within a year', prevMonth('2026-03') === '2026-02', prevMonth('2026-03'));
check('prevMonth wraps across the year boundary', prevMonth('2026-01') === '2025-12', prevMonth('2026-01'));

const M = (m, trips, drivers, attributed = trips) => ({ m, trips, drivers, attributed });

// The production shape: October observed, then nothing until August.
check('no break is reported across missing months',
  breakBetween(M('2025-10', 11800, 102), M('2026-08', 1052, 53)) === null);
check('a break needs its true calendar neighbour',
  breakBetween(M('2026-01', 500, 20), M('2026-03', 100, 20)) === null);
check('adjacent months do produce a break',
  breakBetween(M('2026-02', 1000, 50), M('2026-03', 300, 42))?.change_pct < -0.6);

// A move under the threshold is noise, not a structural break.
check('a small month-over-month move is not a break',
  breakBetween(M('2026-02', 1000, 50), M('2026-03', 900, 50)) === null);
// Two thin months either side of a threshold crossing say nothing useful.
check('two thin months are ignored',
  breakBetween(M('2026-02', 5, 2), M('2026-03', 15, 3)) === null);
check('a thin month against a busy one is still reported',
  breakBetween(M('2026-02', 900, 40), M('2026-03', 5, 1)) !== null);

/* ── supply versus demand ─────────────────────────────────────────────────
   The whole point of the decomposition: same headline drop, different cause,
   different fix. */
const supply = breakBetween(M('2026-02', 1000, 100), M('2026-03', 500, 50));
check('half the drivers doing the same each reads as supply', supply.attribution === 'supply', supply.attribution);
const demand = breakBetween(M('2026-02', 1000, 100), M('2026-03', 400, 96));
check('the same drivers doing far less reads as demand', demand.attribution === 'demand', demand.attribution);

/* ── unattributable months ────────────────────────────────────────────────
   Telematics trips carry no driver id. Counting that as "every driver left"
   was how a data-shape change became a staffing crisis on the dashboard. */
const noIds = breakBetween(M('2026-02', 1000, 50, 1000), M('2026-03', 200, 0, 0));
check('a month with no driver ids is not read as zero drivers', noIds.drivers_to === null, String(noIds.drivers_to));
check('an unattributable break says so rather than guessing a cause',
  noIds.attribution === 'unattributable', noIds.attribution);
check('an unattributable break still reports the size of the move',
  noIds.change_pct < -0.7, String(noIds.change_pct));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
