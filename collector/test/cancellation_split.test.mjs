/* "By the driver" was two different acts added together.
   ──────────────────────────────────────────────────────────────────────────
   A driver who accepts a job and then ends it has left a rider standing in the
   street. A driver who lets a broadcast offer go past has not — the offer went
   to several drivers at once and somebody else took it. The page counted both
   into one number, used that number as its sort key, and put it in a headline
   tile.

   That number is not comparable between two people, because BOLT FILES AN
   OFFER AS A ROW AND UBER DOES NOT. Uber's export contains dispatched trips;
   the offers that preceded them are not in it. Measured on production over
   2026 to date, from the endpoint's own output:

     "by the driver", fleet-wide            7,032
       offers declined or left unanswered   5,307   (every one of them Bolt)
       jobs accepted and then abandoned       566
       Uber driver_cancelled                1,159

   So three quarters of it was offers. The list was headed by a Bolt-only
   driver on 440 — 433 offers he did not take, 7 jobs he dropped — ranked above
   every Uber driver who abandoned a real dispatch. The rate said the same
   thing: median cancellation rate 64% across the 53 people who only work Bolt
   against 15% across the 68 who only work Uber, which is two companies writing
   their logs differently and not a four-fold difference in behaviour.

   The fixture below is built so the two orderings DISAGREE. If the split ever
   collapses back into one number, the assertions do not merely drift — the
   wrong person is at the top of the page. */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };

await applySchema(db);
await q(`INSERT INTO fleet (id, name) VALUES ('ecosine','Ecosine') ON CONFLICT DO NOTHING`);

let seq = 0;
const trip = (platform, drv, status, n = 1) => Promise.all(
  Array.from({ length: n }, () => q(
    `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
                       requested_at, ended_at, status, distance_km)
     VALUES ($1, $2, 'ecosine', $3, $4, $5, $6, $6, $7, 9)`,
    [platform, `t${++seq}`, `L-${drv}`, drv, `Driver ${drv}`,
     '2026-08-05T12:00:00+04:00', status])));

/* BOLTY works Bolt and refuses a great many offers. He drops 2 real jobs.
   Under the old single column he is the worst driver in the fleet at 42. */
await trip('bolt', 'boltyMcBolt', 'optional_ride_driver_did_not_respond', 25);
await trip('bolt', 'boltyMcBolt', 'driver_rejected', 12);
await trip('bolt', 'boltyMcBolt', 'offer_rejected', 3);
await trip('bolt', 'boltyMcBolt', 'driver_cancelled_after_accept', 2);
await trip('bolt', 'boltyMcBolt', 'finished', 40);

/* UBERT works Uber and drops 9 jobs riders were waiting for. Under the old
   column he is well below BOLTY; he is the one an operator should ring. */
await trip('uber', 'ubertUber', 'driver_cancelled', 9);
await trip('uber', 'ubertUber', 'rider_cancelled', 4);
await trip('uber', 'ubertUber', 'completed', 60);

/* YANNIS works Yango, which files the bare word `cancelled` and never says who
   did it, and the hotel channel, which files no cancellation of its own. He is
   here so the third bucket is exercised beside the split: "nobody said who"
   must stay exactly the channel that does not say, and must not quietly absorb
   a status that does. */
await trip('yango', 'yannisYango', 'cancelled', 5);
await trip('yango', 'yannisYango', 'complete', 20);
await trip('hotel', 'yannisYango', 'completed', 8);

const { server, get } = await mountAll(db);
const body = (await get('/api/cancellations?from=2026-08-01&to=2026-08-31')).body;
const row = (id) => body.rows.find((r) => r.driver_ext_id === id);
const bolty = row('boltyMcBolt'); const ubert = row('ubertUber');

/* ── the two acts are counted apart ─────────────────────────────────────── */
check('an offer declined and a job abandoned are separate numbers',
  bolty?.declined === 40 && bolty?.dropped === 2,
  JSON.stringify([bolty?.declined, bolty?.dropped]));
check('and their union is still what "by the driver" means, so the buckets add up',
  bolty.by_driver === bolty.declined + bolty.dropped
    && bolty.cancelled === bolty.by_driver + bolty.by_rider + bolty.unattributed,
  JSON.stringify([bolty.by_driver, bolty.cancelled]));

/* offer_rejected was not on the driver list at all and fell through to
   "nobody said who" — a status that names the actor in the word itself. */
check('offer_rejected is the driver declining, not an unattributable cancellation',
  bolty.unattributed === 0 && bolty.declined === 40, JSON.stringify(bolty.unattributed));

/* ── the ranking ────────────────────────────────────────────────────────── */
check('the driver who abandoned accepted jobs is listed above the one who refused offers',
  body.rows[0].driver_ext_id === 'ubertUber',
  body.rows.map((r) => `${r.driver_ext_id}:${r.dropped}/${r.declined}`).join(' '));
check('…even though the old single column would have put him second',
  ubert.by_driver < bolty.by_driver && ubert.dropped > bolty.dropped,
  `by_driver ${ubert.by_driver} vs ${bolty.by_driver}, dropped ${ubert.dropped} vs ${bolty.dropped}`);

/* ── a rate that can be compared between the two ────────────────────────── */
check('the comparable denominator excludes offers that never became a dispatch',
  bolty.accepted === bolty.bookings - bolty.declined && bolty.accepted === 42,
  `${bolty.accepted} of ${bolty.bookings}`);
check('and an Uber driver, who has no offer rows, keeps every booking in it',
  ubert.accepted === ubert.bookings && ubert.declined === 0, String(ubert.accepted));

/* ── a blank must say why it is blank ───────────────────────────────────── */
check('a driver on a channel that files offers is marked as such',
  bolty.on_offer_channel === true, String(bolty.on_offer_channel));
check('and one whose channels never file them is NOT, so a blank is not read as a clean record',
  ubert.on_offer_channel === false, String(ubert.on_offer_channel));

/* ── the totals a reader sees ───────────────────────────────────────────── */
check('the response totals both halves as well as the union',
  body.totals.dropped === 11 && body.totals.declined === 40
    && body.totals.by_driver === 51,
  JSON.stringify(body.totals));
check('and names which channels file an offer at all, rather than the page guessing',
  Array.isArray(body.offer_channels) && body.offer_channels.includes('bolt')
    && body.offer_channel_drivers === 1,
  JSON.stringify([body.offer_channels, body.offer_channel_drivers]));

/* ── the page must not put them back together ───────────────────────────── */
{
  const page = readFileSync('api/public/cancellations.js', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('the table has a column for each act, not one for their sum',
    /key: 'dropped'/.test(page) && /key: 'declined'/.test(page)
      && !/key: 'by_driver'/.test(page));
  check('the headline tiles are split the same way',
    /Dropped a job/.test(page) && /Turned down an offer/.test(page)
      && !/label: 'By the driver'/.test(page));
  /* The cell text is deliberately terse — it is in every row of a ten-column
     table — so the assertion is that the cell BRANCHES on whether the driver is
     even on an offer-filing channel and carries a reason, not that it contains
     one particular sentence. An em-dash here would let a reader conclude that a
     named Uber driver refused nothing, which is a claim the data cannot make. */
  check('an absent offer count renders a reason rather than an em-dash',
    /on_offer_channel/.test(page) && /not reported</.test(page)
      && /title="Only Bolt files the offers/.test(page));
  /* A client-side defaultSort RE-SORTS the rows the server ordered, so the two
     have to name the same column or the SQL ORDER BY does nothing to what a
     reader sees. This shipped mismatched for one render: the endpoint ordered
     by dropped and the table re-sorted by cancelled, header marker and all. */
  const sql = readFileSync('api/cancellation_sql.js', 'utf8');
  const orderBy = (sql.match(/ORDER BY b\.(\w+) DESC/) || [])[1];
  const sortKey = (page.match(/defaultSort: \{ key: '(\w+)'/) || [])[1];
  check('the table opens on the same column the endpoint ordered by',
    orderBy === 'dropped' && sortKey === orderBy, `SQL ${orderBy} vs page ${sortKey}`);
}

/* ── the third bucket stays the channel that really cannot say ──────────── */
{
  const y = row('yannisYango');
  check('Yango\'s bare "cancelled" is still unattributable, not folded into either half',
    y.unattributed === 5 && y.dropped === 0 && y.declined === 0 && y.by_driver === 0,
    JSON.stringify([y.unattributed, y.dropped, y.declined]));
  check('and the reason names Yango, not every channel the driver works',
    (y.unattributed_platforms || []).join() === 'yango',
    JSON.stringify(y.unattributed_platforms));
  check('a driver on no offer-filing channel is marked so even when other channels are mixed in',
    y.on_offer_channel === false && (y.platforms || []).length === 2,
    JSON.stringify([y.on_offer_channel, y.platforms]));
  check('their accepted count is every booking, there being no offer rows to remove',
    y.accepted === y.bookings && y.bookings === 33, `${y.accepted} of ${y.bookings}`);
  /* The whole page must still balance once a third channel is in it. */
  const t = body.totals;
  check('fleet-wide, the two halves and the two other buckets account for every cancellation',
    t.dropped + t.declined + t.by_rider + t.unattributed === t.cancelled
      && t.dropped + t.declined === t.by_driver,
    JSON.stringify(t));
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
