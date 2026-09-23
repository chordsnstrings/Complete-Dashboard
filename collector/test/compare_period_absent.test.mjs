/* /api/compare/period: a side with no figure is "not compared", never −100%.
   ═══════════════════════════════════════════════════════════════════════════
   The reskin review (2026-09-23), finding 6. delta() in api/server.js read
   both sides through Number() before asking whether they were there, and
   Number(null) is 0. So a window whose sum(fares) — or km, or money — was
   NULL, because no driver-day in it carried the measure, came back as
   change_pct −100: a collapse nobody measured, printed as a tile delta on the
   Arkiv #overview. The house rule is that a figure that cannot be measured
   renders absent with its reason, never as a number.

   And the page's reason named the wrong side: app.js dl() said "‹the span
   before› holds nothing to compare against" whenever the answer was null,
   including when it was THIS window that held nothing.

   Synthetic driver-days only: two in the window with trips and no fares or
   distance, two in the span before with both. */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const db = new PGlite();
await applySchema(db);
const day = async (id, d, trips, fares, km) => db.query(
  `INSERT INTO driver_day (driver_ext_id, day, fleet_id, trips, completed, fares, km)
   VALUES ($1, $2::date, 'ecosine', $3, $3, $4, $5)`, [id, d, trips, fares, km]);
/* The window 2026-09-10..11 and the two days before it. */
await day('D-SYN-1', '2026-09-08', 4, 120.5, 40);
await day('D-SYN-2', '2026-09-09', 6, 180.25, 60);
await day('D-SYN-1', '2026-09-10', 5, null, null);
await day('D-SYN-2', '2026-09-11', 5, null, null);

const { get, server } = await mountAll(db);

console.log('\n1 · the endpoint');
{
  const r = await get('/api/compare/period?from=2026-09-10&to=2026-09-11');
  const c = r.body.change_pct || {};
  check('the span before is the two days immediately before the window',
    r.body.previous?.from === '2026-09-08' && r.body.previous?.to === '2026-09-09', JSON.stringify(r.body.previous));
  check('the window really carries no fares and no distance, and the span before does',
    r.body.now?.fares == null && r.body.now?.km == null && Number(r.body.before?.fares) > 0,
    JSON.stringify({ now: r.body.now, before: r.body.before }));
  check('fares: not compared (null), not −100%', c.fares === null, String(c.fares));
  check('distance: not compared (null), not −100%', c.km === null, String(c.km));
  check('a measure both sides carry is still compared: trips 10 against 10 is 0%', c.trips === 0, String(c.trips));
}
{
  /* The mirror: the span before is the empty side. */
  const r = await get('/api/compare/period?from=2026-09-08&to=2026-09-09');
  check('a window against a span before that carries nothing: not compared, not +Infinity',
    r.body.change_pct?.fares === null, String(r.body.change_pct?.fares));
}

console.log('\n2 · the page names the side that is empty');
{
  const app = readFileSync(new URL('../api/public/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('const emptySide = '), app.indexOf('const completionDelta'));
  check('an empty window is named as the window',
    /a == null\s*\?\s*`not compared: this window holds no \$\{noun\} to compare`/.test(body), body.slice(0, 200));
  check('…an empty span before as the span before',
    /b == null \? `not compared: \$\{prevLabel\} holds no \$\{noun\} to compare against`/.test(body));
  check('dl() hands both sides to it rather than blaming the span before',
    /na: emptySide\(num\(cmp\.now\?\.\[key\]\), num\(cmp\.before\?\.\[key\]\), 'figure'\)/.test(body));
}

server?.close?.();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
