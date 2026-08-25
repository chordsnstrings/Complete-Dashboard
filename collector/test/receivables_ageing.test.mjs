/* ── two figures that could not be what they claimed ───────────────────────
   "Oldest debt" was min(requested_at) computed INSIDE the selected window, so
   at days=7 the oldest receivable could not exceed seven days and at days=30 it
   could not exceed thirty. The over-60-day warning tone on the Outstanding page
   was unreachable at every range the page offers, on the one screen whose whole
   subject is money that has been owed too long.

   And "bookings with a room" tested `room_no IS NOT NULL`. The hotel channel
   writes an EMPTY STRING into roomNumber more often than it writes a room, and
   an empty string is not null: production reported 875 of 875 bookings with a
   room — a flat 100% — while 226 of 300 guest rows carried room_no "". Those
   blanks then grouped into ONE pseudo-room that passed HAVING count(*) > 1, so
   the repeat tiles read 13 rooms / 791 bookings above a list of 11 rooms
   totalling 24.

   Both need rows outside one tidy month, which is why they live here rather
   than in analytics_routes.test.mjs, whose fixture counts are pinned exactly. */
import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
await applySchema(db);

let n = 0;
const hotel = (o) => q(
  `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
     requested_at, distance_km, status, payment_type, price, partner_id, partner_name, raw)
   VALUES ('hotel',$1,'ecosine',$2,$3,$4,$5,12,'completed',$6,$7,$8,$9,$10)`,
  [`h${n++}`, o.plate || 'L100', o.drv, `Driver ${o.drv}`, o.at, o.pay, o.price,
    o.partner, o.partnerName, JSON.stringify(o.raw || {})]);

/* One property, three drivers, ten room charges inside the window. The group
   key used to include driver_ext_id, so this became three rows for one hotel. */
for (let i = 0; i < 9; i++) {
  await hotel({ drv: `hd${i % 3}`, at: `2026-08-${String(10 + i).padStart(2, '0')}T10:00:00+04:00`,
    pay: 'room-charge', price: 100, partner: 'h1', partnerName: 'Le Meridien',
    raw: { client: `g${i}`, roomNumber: String(2000 + (i % 3)) } });
}
/* Blank room numbers, which are not rooms. Six of them, on six bookings, so a
   naive HAVING count(*) > 1 makes one pseudo-room of six. */
for (let i = 0; i < 6; i++) {
  await hotel({ drv: 'hd0', at: `2026-08-${String(20 + i).padStart(2, '0')}T10:00:00+04:00`,
    pay: 'room-charge', price: 70, partner: 'h1', partnerName: 'Le Meridien',
    raw: { client: `b${i}`, roomNumber: '' } });
}
// A salary deduction inside the window: a second counterparty, and one whose
// identity really is a person rather than a property.
await hotel({ drv: 'hd2', at: '2026-08-14T10:00:00+04:00', pay: 'posted-for-salary', price: 45,
  partner: 'h1', partnerName: 'Le Meridien', raw: { client: 'sal2' } });
// A debt from May: older than any window the page offers.
await hotel({ drv: 'hd0', at: '2026-05-02T10:00:00+04:00', pay: 'room-charge', price: 250,
  partner: 'h1', partnerName: 'Le Meridien', raw: { client: 'old', roomNumber: '2000' } });
// And one from three weeks before the window, for the 31-60 bucket.
await hotel({ drv: 'hd1', at: '2026-07-08T10:00:00+04:00', pay: 'posted-for-salary', price: 60,
  partner: null, partnerName: null, raw: { client: 'sal' } });

const { server, get } = await mountAll(db, { serverRoutes: false });

console.log('\nreceivables: one counterparty, one row');

const mo = await (await get('/api/settlement/receivables?from=2026-08-01&to=2026-08-31')).body;
const lm = mo.rows.filter((r) => r.counterparty === 'Le Meridien');
check('a property owing money is one row, not one per driver who drove for it',
  lm.length === 1, JSON.stringify(mo.rows.map((r) => [r.counterparty, r.trips])));
check('and its amount is the whole debt, not one driver\'s slice',
  Number(lm[0].amount) === 9 * 100 + 6 * 70, String(lm[0].amount));
check('the drivers behind it are kept, so the row is still a drill-down',
  lm[0].drivers === 3 && lm[0].driver_ids.length === 3, JSON.stringify(lm[0].driver_ids));
check('the counterparty tile equals the number of counterparties listed',
  mo.counterparties === mo.rows.length && mo.counterparties === 2,
  `${mo.counterparties} vs ${mo.rows.length}`);

console.log('\nreceivables: how old the debt is, not how wide the window is');

const wk = await (await get('/api/settlement/receivables?from=2026-08-25&to=2026-08-31')).body;
check('the oldest debt is the same at a seven-day window and a month-long one',
  wk.oldest_days === mo.oldest_days, `${wk.oldest_days} vs ${mo.oldest_days}`);
check('and it can exceed the window, which is the whole point',
  mo.oldest_days > 31, String(mo.oldest_days));
check('the debt is aged into four buckets, each with a count and an amount',
  mo.ageing.buckets.length === 4
  && mo.ageing.buckets.every((b) => typeof b.trips === 'number' && typeof b.amount === 'number'),
  JSON.stringify(mo.ageing.buckets));
check('the May debt lands past ninety days, where no window could have found it',
  mo.ageing.buckets[3].trips === 1 && mo.ageing.buckets[3].amount === 250,
  JSON.stringify(mo.ageing.buckets[3]));
check('the July salary posting lands in 31-60 days',
  mo.ageing.buckets[1].trips === 1 && mo.ageing.buckets[1].amount === 60,
  JSON.stringify(mo.ageing.buckets[1]));
check('the buckets account for every receivable up to the end of the window',
  mo.ageing.buckets.reduce((a, b) => a + b.trips, 0) === mo.ageing.total_trips,
  JSON.stringify([mo.ageing.buckets.map((b) => b.trips), mo.ageing.total_trips]));
check('and the ageing says what it treats as unsettled, since nothing records settlement',
  /counted as outstanding/.test(mo.ageing.note), mo.ageing.note);
check('the ageing states the date it is as at',
  mo.ageing.as_at === '2026-08-31', mo.ageing.as_at);

console.log('\nguests: an empty string is not a room number');

const g = await (await get('/api/corporate/guests?from=2026-08-01&to=2026-08-31')).body;
check('the fixture really does carry blank room numbers',
  g.guests.some((x) => x.room_no === ''), JSON.stringify(g.guests.map((x) => x.room_no)));
check('bookings with a room count the ones with a ROOM, not the ones with a field',
  g.bookings_with_room === 9 && g.total_bookings === 16,
  `${g.bookings_with_room} of ${g.total_bookings}`);
check('the distinct-room count excludes the blank',
  g.distinct_rooms === 3, String(g.distinct_rooms));
/* The pseudo-room: six blanks grouped together passed HAVING count(*) > 1 and
   became the largest "repeat room" on the page. */
check('the repeat-room tiles agree with the list beneath them',
  g.repeat_rooms === g.rooms.length
  && g.repeat_bookings === g.rooms.reduce((a, x) => a + x.bookings, 0),
  JSON.stringify({ tiles: [g.repeat_rooms, g.repeat_bookings], list: g.rooms.length }));
check('and the blank is not one of them',
  g.repeat_rooms === 3 && g.rooms.every((x) => /^[0-9]{2,5}$/.test(x.room_no)),
  JSON.stringify(g.rooms.map((x) => [x.room_no, x.bookings])));
check('the truncation flag agrees with the counted total',
  g.rooms_truncated === false, String(g.rooms_truncated));

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
