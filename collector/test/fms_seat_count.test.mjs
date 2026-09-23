/* ── FMS's live seat count (GetVehicleCurrentDetails `Seatcount`) ───────────
   The operator, 2026-09-23: "FMS and CABMAN is two separate providers each
   should provide seat sensor data … we should collect seat count too."

   FMS reports a live `Seatcount` on GetVehicleCurrentDetails. Nothing called
   that operation: the live poller reads GetVehicleStatus, which has no seat
   field, and the nightly probe called GetVehicleCurrentDetails without
   vehicleno=ALL and was told "Authentication failed" every night on both
   fleets. These tests hold down the reading of FMS's answer, the one rule that
   keeps a refusal of THIS operation off the credential banner, and the probe's
   parameters. The payloads are synthetic; nothing here came from FMS. */
import { readFileSync } from 'node:fs';
import { detailsSeatCounts } from '../src/sources/fms.js';

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { ok ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
const ok = (data) => ({ status: 200, ok: true, data });

console.log('\nreading FMS’s answer');
{
  const { refused, counts } = detailsSeatCounts(ok({ Data: [
    { 'Plate No': 'L 10001', TrackTime: '23-09-2026 12:00:00', Seatcount: '2' },
    { 'Plate No': 'L-10002', TrackTime: '23-09-2026 12:00:00', Seatcount: 0 },
    { 'Plate No': 'L10003', TrackTime: '23-09-2026 12:00:00', Seatcount: '' },
    { 'Plate No': 'L10004', TrackTime: '23-09-2026 12:00:00', Seatcount: null },
    { 'Plate No': 'L10005', Seatcount: 'n/a' },
    { 'Plate No': 'L10006', Seatcount: '-1' },
    { 'Plate No': 'L10007', Seatcount: '1.5' },
    { Seatcount: '1' },
  ] }));
  check('an answer is not a refusal', refused === null);
  check('a count is read and the plate normalised as every feed stores it', counts.get('L10001') === 2,
    JSON.stringify([...counts]));
  check('0 is a reading — an empty seat — not an absence', counts.get('L10002') === 0);
  check('a blank, a null or a word is no reading', !counts.has('L10003') && !counts.has('L10004') && !counts.has('L10005'));
  check('a negative or a fraction is not a seat count', !counts.has('L10006') && !counts.has('L10007'));
  check('a row with no plate is dropped rather than filed under nothing', counts.size === 2, String(counts.size));
}
{
  const a = detailsSeatCounts(ok([{ 'Plate No': 'L20001', Seatcount: '1' }]));
  const b = detailsSeatCounts(ok({ data: [{ vehicleno: 'L20002', SeatCount: '3' }] }));
  check('a bare array is read', a.counts.get('L20001') === 1);
  check('…and a lower-case envelope, with the other spellings of both fields', b.counts.get('L20002') === 3,
    JSON.stringify([...b.counts]));
  check('an empty answer gives no counts and no refusal',
    detailsSeatCounts(ok({ Data: [] })).counts.size === 0 && detailsSeatCounts(ok({ Data: [] })).refused === null);
}

console.log('\na refusal of this one operation');
{
  const r = detailsSeatCounts({ status: 200, ok: true, data: { error: 'Authentication failed' } });
  check('FMS’s 200-with-an-error refusal is recognised', /Authentication failed/.test(r.refused || ''), String(r.refused));
  check('…and yields no counts', r.counts.size === 0);
  /* The rule that matters. Login has already succeeded and GetVehicleStatus
     answered by the time this call is made, so a refusal here is not the
     password. noteFmsRefusal would paint FMS_<FLEET>_PASS red on every page's
     banner — a working credential, for a reason that is not the true one. */
  const src = readFileSync(new URL('../src/sources/fms.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function liveSeatCounts('), src.indexOf('const field = ('));
  check('the seat-count call never writes the credential’s state',
    body.length > 100 && !/noteFmsRefusal|noteCredential/.test(body), body.slice(0, 120));
  check('…and it sends the login and vehicleno=ALL, as GetTripPassenger does',
    /GetVehicleCurrentDetails'[\s\S]{0,120}username: fleet\.username, Password: fleet\.password, vehicleno: 'ALL'/.test(body));
  check('every live row carries seat_count, null where FMS gave none',
    /seat_count: seats\.get\(plate\) \?\? null/.test(src));
}

console.log('\nthe nightly probe asks the question the collector asks');
{
  const probe = readFileSync(new URL('../src/probe.js', import.meta.url), 'utf8');
  const at = probe.indexOf(':GetVehicleCurrentDetails`');
  const seg = probe.slice(at, at + 600);
  check('the probe sends vehicleno=ALL', /call\('GetVehicleCurrentDetails', \{ vehicleno: 'ALL' \}\)/.test(seg), seg.slice(0, 200));
  check('…and names the seat count among the columns it maps', /'seat_count'/.test(seg) && /Seatcount: 'seat_count'/.test(seg));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
