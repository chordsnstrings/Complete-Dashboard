/* Fifteen exact string matches against a header Uber renders by locale.
   ─────────────────────────────────────────────────────────────────────────
   csvToTrips keys on 'Pick-up address', 'Number plate', 'Trip drop-off time'.
   Uber's published reference names the same fifteen fields 'Trip Pickup
   Address', 'Vehicle License Number', 'Trip DropOff Time' — a different
   rendering of every multi-word name. Ours are the live ones: plates,
   addresses and payment types all land, and the 'offline' cohort measured
   across 4,000 August trips could not exist unless 'Payment type' matched
   exactly.

   That is the danger. One locale flip and every lookup returns undefined,
   every column writes NULL, and the run still reports the same row count —
   an outage that looks exactly like a quiet month. This asserts the failure
   is LOUD instead. */
import { csvToTrips } from '../src/sources/uber.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

const LIVE = ['Trip UUID', 'Driver UUID', 'Driver first name', 'Driver surname',
  'Vehicle UUID', 'Number plate', 'Service type', 'Trip request time',
  'Trip drop-off time', 'Pick-up address', 'Drop-off address', 'Trip distance',
  'Trip status', 'Product type', 'Payment type'];

const row = (o = {}) => LIVE.map((c) => `"${o[c] ?? ''}"`).join(',');
const csv = (head, ...rows) => [head.join(','), ...rows].join('\n');

console.log('\nthe header we actually get');
const ok = csvToTrips(csv(LIVE, row({
  'Trip UUID': 'T1', 'Driver UUID': 'D1', 'Number plate': 'L82923',
  'Trip request time': '2026-09-02 18:02:00', 'Trip status': 'completed',
  'Payment type': 'offline', 'Trip distance': '15.3', 'Drop-off address': 'Downtown',
})));
check('parses', ok.length === 1, String(ok.length));
check('the plate is normalised off the live column name', ok[0].plate === 'L82923', ok[0].plate);
check('payment type is lower-cased', ok[0].payment_type === 'offline', ok[0].payment_type);
check('the request time carries the Dubai offset',
  String(ok[0].requested_at).endsWith('+04:00'), String(ok[0].requested_at));
/* The blank pickup on an offline trip is REAL — Uber sends it on 23.0% of
   them against 2.4% of everything else. It must survive as an empty value and
   not be invented into something. */
check('an empty pickup address stays empty rather than becoming a placeholder',
  !ok[0].pickup_addr, JSON.stringify(ok[0].pickup_addr));

console.log('\nthe header we would get if Uber renamed anything');
const DOCS = ['Trip UUID', 'Driver UUID', 'Driver FirstName', 'Driver Surname',
  'Vehicle UUID', 'Vehicle License Number', 'Service Type', 'Trip Request Time',
  'Trip DropOff Time', 'Trip Pickup Address', 'Trip Drop Off Address', 'Trip Distance',
  'Trip Status', 'Product Type', 'Payment Type'];
let threw = null;
try { csvToTrips(csv(DOCS, DOCS.map(() => '""').join(','))); }
catch (e) { threw = String(e.message || e); }
check('the documented spellings are REFUSED, not silently written as nulls', !!threw, 'no throw');
check('and the error names what is missing',
  /Number plate/.test(threw || '') && /Trip request time/.test(threw || ''), String(threw).slice(0, 160));
check('and echoes the header Uber actually sent, so the fix is one read away',
  /Vehicle License Number/.test(threw || ''), String(threw).slice(0, 200));

console.log('\nan empty report is not a renamed one');
check('no rows means no assertion — an empty window is a real answer',
  csvToTrips(csv(LIVE)).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
