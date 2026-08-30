/* Where a page says its numbers came from.
   ─────────────────────────────────────────────────────────────────────────
   An audit of all 34 production pages found most of them showing money and
   counts with nothing naming which feeds were in them. On a fleet that is 93%
   one channel that cuts both ways: a reader takes a figure to cover the
   business when it covers Uber alone, and takes a thin number for a bad week
   when it is a channel that stopped answering.

   The line is only worth having if it is right, and the first three versions
   were not. Each check below is one of the ways it lied. */
/* Run in Chromium against the real module, the way every other DOM test here
   does: sourceLine builds elements, and a hand-rolled document stub would be
   testing the stub. */
import express from 'express';
import { launchChromium } from './browser.mjs';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

const app = express();
app.use(express.static('api/public'));
const server = app.listen(0);
const browser = await launchChromium();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/index.html`, { waitUntil: 'domcontentloaded' });

/* Returns the rendered TEXT, which is what a reader gets, or null where the
   helper declines to render anything at all. */
const line = (rows, opts) => page.evaluate(async ({ r, o }) => {
  const ui = await import('/ui.js');
  const el = ui.sourceLine(r, o || {});
  return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;
}, { r: rows, o: opts });

/* Production's own shape: two Uber fleets, a hotel channel, a Yango that has
   errored, a telematics feed that reports journeys and no bookings, and a Bolt
   that reports nothing at all. */
const PROD = [
  { platform: 'uber', fleet_id: 'ecosine', window_bookings: 7990, bookings: 168000, rows_seen: 168000, collection_status: 'ok' },
  { platform: 'uber', fleet_id: 'egari', window_bookings: 3644, bookings: 70000, rows_seen: 70000, collection_status: 'ok' },
  { platform: 'hotel', fleet_id: 'ecosine', window_bookings: 873, bookings: 1530, rows_seen: 1530, collection_status: 'ok' },
  { platform: 'yango', fleet_id: 'ecosine', window_bookings: 19, bookings: 19, rows_seen: 19, collection_status: 'error' },
  { platform: 'fms', fleet_id: 'ecosine', window_bookings: 0, bookings: 0, rows_seen: 30176, collection_status: 'partial' },
  { platform: 'fms', fleet_id: 'egari', window_bookings: 0, bookings: 0, rows_seen: 23976, collection_status: 'partial' },
  { platform: 'bolt', fleet_id: null, window_bookings: 0, bookings: 0, rows_seen: 0, collection_status: 'partial' },
];

const all = await line(PROD);
check('the channels that contributed are named, with counts', /Uber 11,634/.test(all), all);
check('…folded across their fleets, because two Uber rows are one channel',
  !/Uber [\d,]+ · Uber/.test(all), all);
check('…and ordered with the largest first', all.indexOf('Uber') < all.indexOf('Hotel'), all);

/* The first version called the telematics feed silent. It contributes 54,152
   rows and zero BOOKINGS, because it watches cars move and does not sell
   rides — reported as silent it read as a dead collector, the opposite of
   what it is. */
check('a feed with journeys and no bookings is not called silent',
  /FMS telematics 54,152 in journeys rather than bookings/.test(all), all);
check('…while a channel with neither still is', /Bolt contributed nothing/.test(all), all);
check('…and the two are not confused for one another',
  !/FMS telematics contributed nothing/.test(all), all);

/* A channel that is configured and quiet is the important half: it is the
   difference between "Yango is tiny" and "Yango has not answered since the
   26th". */
check('a collection error is named against the fleet it belongs to',
  /Yango \(Ecosine: error\)/.test(all), all);
check('…and a provider with no fleet of its own says only what is wrong',
  /Bolt \(partial\)/.test(all) && !/Bolt \(fleet:/.test(all), all);

/* /api/platforms answers the whole catalogue whatever the request carries, so
   a filtered page has to filter it here. Left unfiltered, #overview?platform=
   hotel rendered "Built from Uber 11,634 · Hotel 873" over a page showing 873
   hotel bookings and nothing else — the exact claim this line exists to stop
   anyone making. */
const hotel = await line(PROD, { only: ['hotel'] });
check('a page filtered to one channel names only that channel',
  /^Built from Hotel 873\.$/.test(hotel), hotel);
check('…and does not report the others as silent either',
  !/contributed nothing/.test(hotel), hotel);

const egari = await line(PROD, { fleet: 'egari' });
check('a page filtered to one fleet counts only that fleet',
  /Uber 3,644/.test(egari) && !/Uber 11,634/.test(egari), egari);
check('…and keeps a provider that has no fleet of its own',
  /Bolt/.test(egari), egari);

/* A page with no range selector is not answering about a window. #causes is a
   monthly trend over the whole record and #map is one day's replay; quoting
   "this window" under either attributes their figures to a span they do not
   use. */
const whole = await line(PROD, { whole: true });
check('a range-less page is stamped over the whole record',
  /the whole record/.test(whole) && /Uber 238,000/.test(whole), whole);
check('…and says "on record" rather than "to this window"',
  /nothing on record/.test(whole), whole);

check('an empty catalogue produces no line at all', (await line([])) === null);
check('…as does a filter that matches nothing', (await line(PROD, { only: ['careem'] })) === null);

const noted = await line(PROD, { only: ['hotel'], note: 'measured on the corporate channel' });
check('a page can add what its own feeds are used for',
  /measured on the corporate channel\.$/.test(noted), noted);

console.log(`\n${pass} passed, ${fail} failed`);
await browser.close(); server.close();
process.exit(fail ? 1 : 0);
