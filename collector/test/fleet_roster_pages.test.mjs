/* The pages say what the tracker roster set aside (FIXLIST C18, 2026-11-12).
   ═════════════════════════════════════════════════════════════════════════
   The API now leaves the CABMAN plates the collector's roster set aside out
   of /api/live and the /api/kpis tracker counts, and flags them in the
   vehicle register (test/fleet_roster_wiring.test.mjs holds that). A smaller
   number with no reason beside it is the failure the house rule names, so
   each page that lost plates must say so:
     #live      a note above the table, the server's sentence
     #map       a line in the legend, beside the no-satellite-lock line
     #vehicles  the Vehicles tile and the search count drop the flagged rows
                and say why; the verdict names them apart from the no-VIN
                plates; the row's tracker cell reads "set aside"
     #safety    the verdict says what the tracked count it divides by left out
   And nothing at all when nothing was set aside — the mock's own answer —
   which is also what keeps the old skin byte for byte
   (test/arkiv_classic_frozen.test.mjs) while it gets the same sentence the
   day there is one.

   REVERSION, proved 2026-11-12 by copying each file, removing the lines and
   restoring it byte for byte: the #live note (app.js), the #map legend line
   (app.js), the #safety verdict clause (app.js), and the register's tiles and
   tracker cell (vehicle.js) — each makes its section here fail.

   Synthetic data only: every page renders against mockapi.mjs, with
   /api/fleet/roster, /api/kpis and /api/vehicles/directory overridden where a
   case needs plates set aside. */
import { harness } from './arkiv_pages.mjs';

const { check, start, open, done } = harness('Tracker roster — the pages say what was set aside');
await start();

const SENT = '132 plates set aside: the tracker has stopped listing them, or has listed them too few times to be '
  + 'believed. They are still in the register — this figure is about the vehicles the tracker currently reports.';
const ROSTER = { fleet: null, n: 132, held: 132, known: true, state: 'read', reason: SENT,
  why: 'the tracker has stopped listing them, or has listed them too few times to be believed',
  plates: ['L1', 'L2'], truncated: false, departed: 132, pending: 0, listed: 45, fleets: [] };
const UNKNOWN = { ...ROSTER, n: 0, held: 0, known: false, state: 'none', plates: [],
  reason: 'The tracker roster has not been written yet, so nothing has been set aside — this count includes '
    + 'every plate the tracker feed has ever reported, including any it has stopped listing.',
  why: 'the tracker roster has not been written yet, so nothing has been set aside' };
const text = (page, sel = '#view') => page.evaluate((s) => (document.querySelector(s)?.innerText || '')
  .replace(/\s+/g, ' '), sel);
/* A note carrying `needle` that a reader can SEE: in the DOM, laid out (not
   inside a fold the focus pass collapsed), its first words on the face. */
const seenNote = (page, needle) => page.evaluate((n) => [...document.querySelectorAll('#view .note')]
  .some((x) => x.textContent.includes(n) && x.offsetParent !== null && x.getClientRects().length > 0), needle);

console.log('\n#live');
{
  const { ctx, page } = await open('arkiv', 'live', { fixtures: { '/api/fleet/roster': ROSTER } });
  check('the server’s sentence is on the page, where a reader can see it',
    await seenNote(page, '132 plates set aside: the tracker has stopped listing them'));
  check('above the table it is about', await page.evaluate(() => {
    const n = [...document.querySelectorAll('#view .note')].find((x) => /132 plates set aside/.test(x.textContent));
    const tbl = document.querySelector('#view table');
    return !!(n && tbl && (n.compareDocumentPosition(tbl) & Node.DOCUMENT_POSITION_FOLLOWING));
  }));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'live');
  const t = await text(page);
  check('nothing is said when the roster set nothing aside (the mock’s answer)', !/set aside|tracker roster/.test(t));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'live', { fixtures: { '/api/fleet/roster': UNKNOWN } });
  check('a roster that cannot yet say is said as that, never as "none set aside"',
    (await text(page)).includes('The tracker roster has not been written yet'));
  await ctx.close();
}
{
  const { ctx, page } = await open('classic', 'live', { fixtures: { '/api/fleet/roster': ROSTER } });
  check('the old skin says it too, the day there is something to say',
    (await text(page)).includes('132 plates set aside'));
  await ctx.close();
}

console.log('\n#map');
{
  const { ctx, page } = await open('arkiv', 'map', { fixtures: { '/api/fleet/roster': ROSTER } });
  const t = await page.evaluate(() => [...document.querySelectorAll('#view .legend, #view [class*="legend"]')]
    .map((x) => x.textContent).join(' '));
  check('the legend says which plates are not drawn, and why', t.includes('132 plates set aside'), t.slice(0, 300));
  await ctx.close();
}

console.log('\n#vehicles');
{
  let total = 0;
  const { ctx, page } = await open('arkiv', 'vehicles', { fixtures: {
    '/api/fleet/roster': ROSTER,
    /* Two of the mock's rows set aside the way the server sets them aside:
       no VIN, nothing else on record. */
    '/api/vehicles/directory': (_, real) => {
      total = real.length;
      return real.map((r, i) => (i >= real.length - 2 ? { ...r, vin: null, vin_channels: null, distinct_vins: 0,
        trips: 0, telematics_journeys: 0, cab_days_moved: 0, set_aside: 'departed' } : r));
    },
  } });
  const veh = await page.evaluate(() => [...document.querySelectorAll('#view .kpi')]
    .map((k) => k.textContent.replace(/\s+/g, ' ').trim()).find((s) => /^Vehicles\b/i.test(s)) || '');
  check('the Vehicles tile counts the plates still on record, not the set-aside ones',
    veh.includes(String(total - 2)) && !veh.includes(String(total)) && /2 more set aside/.test(veh), `${veh} (of ${total})`);
  check('a note under the verdict names them, with the roster’s reason, where a reader can see it',
    await seenNote(page, '2 plates are set aside: the tracker has stopped listing them'));
  check('the search count says it too', /\d+ vehicles · 2 set aside/.test(await text(page, '#vdn')), await text(page, '#vdn'));
  check('the row’s tracker cell reads "set aside", not "quiet"', await page.evaluate(() =>
    [...document.querySelectorAll('#view table td')].some((td) => td.textContent.trim() === 'set aside')));
  await ctx.close();
}

console.log('\n#safety');
{
  const { ctx, page } = await open('arkiv', 'safety', { fixtures: {
    '/api/kpis': (_, real) => ({ ...real, tracked_vehicles: 136, tracked_set_aside: 132,
      fleet_roster: { ...ROSTER, n: 132 } }),
  } });
  check('a note says what the tracked count the rate divides by left out',
    await seenNote(page, 'Tracked vehicles: 132 plates set aside'));
  await ctx.close();
}
{
  const { ctx, page } = await open('arkiv', 'safety');
  check('and nothing when the mock’s roster set nothing aside', !(await text(page)).includes('set aside'));
  await ctx.close();
}

await done();
