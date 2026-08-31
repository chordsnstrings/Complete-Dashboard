// FMS / InfoTrack telematics collector — BOTH fleets, deepest history (>=12 months).
// Verified endpoints (ItlService.svc, JSON over webHttp):
//   GetTripPassenger?username&Password&vehicleno=ALL&fromdate=YYYY.MM.DD&todate=YYYY.MM.DD   (max ~31 days)
//   GetAlertData     (same params)
//   Login            -> userid; GetVehicleStatus?UserId= ; GetVehicleCurrentDetails (live)
import { config, normPlate } from '../config.js';
import { http, qs } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { dateChunks, dotDate, iso, parseFmsTime } from '../util.js';
import { log } from '../log.js';

const SRC = 'fms';

/* `ok` is part of the answer, not decoration.
   ─────────────────────────────────────────────────────────────────────────
   This used to destructure only { status, data } and return only those. The
   status check added to pullTrips then read `r.ok` off an object that never
   carried it — undefined, so `!r.ok` was true for every window, including the
   ones FMS answered perfectly. The trip collector skipped all of them and
   filed each as a refusal, which is how a live run came to record
   `error: 'HTTP 200'`: a 200 recorded as a failure.

   The fix that hid a hole opened a bigger one — trips stopped being collected
   at all, and only the alert path, which does not check status, kept writing.
   Pass the flag through. */
async function call(op, params) {
  const url = `${config.fms.base}/${op}?${qs(params)}`;
  const { status, ok, data } = await http(url, { timeoutMs: 120000 });
  return { status, ok, data };
}

// ---- historical trips ----
/* One journey row, from FMS's own shape. Extracted so the window loop below
   can call it from two places — a window that answered, and a half of a window
   that answered after the whole was refused. */
function fmsTripRows(data, fleet) {
  return (data?.Data || []).map((t) => {
    const plate = normPlate(t['Plate No']);
    const start = parseFmsTime(t['Start Time']);
    return {
      /* `plate ?? ''` and not `plate`: normPlate returns null now, and this
         key identifies rows already in the table. Interpolating null would
         rewrite it as "null|…" where it used to be "|…" and re-insert every
         such journey as a new row on the next collection. */
      platform: SRC, external_id: `${plate ?? ''}|${start}`, fleet_id: fleet.fleet, plate,
      requested_at: start, ended_at: parseFmsTime(t['End Time']),
      pickup_addr: t['Start Location'], pickup_lat: t.StartLat, pickup_lng: t.StartLon,
      dropoff_addr: t['End Location'], dropoff_lat: t.EndLat, dropoff_lng: t.EndLon,
      distance_km: t['Total Travel Distance'], seat_count: t['Seat Count'],
      status: 'completed', raw: t,
    };
  }).filter((r) => r.requested_at);
}

/* Below this, a refusal is the provider's answer rather than the window's size.
   Two days of one fleet's telematics is a few hundred rows; if that is refused,
   splitting it again only spends requests to be told the same thing. */
const FMS_MIN_SPLIT_DAYS = 2;

/* Ask for a window, and if it is refused for being too big, ask for its halves.
   ─────────────────────────────────────────────────────────────────────────
   The record said Ecosine simply could not reach its own history: monthly
   windows came back 400, "deterministically, on every retry", and the
   conclusion written here was that the two fleets have different reach.

   That conclusion was wrong, and the measurement that disproves it is cheap.
   Asked on 2026-08-31 for October 2025 — inside a 63-day hole this source has
   carried since — FMS answers:

     31 days   ecosine 400          egari 400
     25 days   ecosine 400          egari 200, 4,631 rows
     21 days   ecosine 400          egari 200, 3,836 rows
     14 days   ecosine 200, 3,476   egari 200, 2,412 rows
      7 days   ecosine 200, 1,724   egari 200, 1,158 rows

   Egari succeeds at 25 days with 4,631 rows where Ecosine fails at 21 with an
   estimated 5,200. That is not two fleets with different reach; it is one
   response-size ceiling around five thousand records, and Ecosine hits it
   sooner only because Ecosine is the busier fleet. The history is there for
   both, and it has been reported as missing for ninety-three days.

   So a refusal is retried in halves rather than recorded as a hole. A quiet
   month still costs one request; only a month that is actually too large pays
   for more, which is why this is a split and not simply a smaller window —
   a fixed fortnight would triple the request count on every quiet month and
   still break on a busy one. */
async function collectTripWindow(fleet, s, e, chunks, depth = 0) {
  const chunk = { from: iso(s), to: iso(e), rows: 0, error: null };
  chunks.push(chunk);
  if (depth) chunk.split_from_refusal = true;
  let data;
  try {
    /* A refusal is not an empty month.
       ─────────────────────────────────────────────────────────────────
       http() resolves for any status — it returns { status, ok, data } and
       only throws on a transport failure — so a 400 arrived here with no
       Data key, fell through `data?.Data || []`, and was recorded as a
       window that was asked and answered with nothing. Six consecutive
       months of 2025 read that way, and the Collection gaps page dutifully
       reported five months of telematics as the provider having none.

       Status is checked before the body is read now, and a refusal is a
       chunk error: the page can then say "asked and refused" rather than
       "asked and answered empty", which are opposite instructions to whoever
       reads it. */
    const r = await call('GetTripPassenger', {
      username: fleet.username, Password: fleet.password, vehicleno: 'ALL',
      fromdate: dotDate(s), todate: dotDate(e),
    });
    if (!r.ok) {
      const days = Math.round((e - s) / 864e5) + 1;
      if (days > FMS_MIN_SPLIT_DAYS) {
        /* The window was too big, not the history missing. Halve it, and
           record the halves as the windows actually asked for — a coverage
           page that says a month was refused when its two halves answered
           would be describing a request nobody made. */
        chunks.pop();
        /* Halved in whole DAYS, not milliseconds. (e - s) / 2 on a window with
           an odd number of days lands mid on a half-day, and every date this
           source sends is a bare date — so the two halves would then be
           computed from timestamps that do not name the boundary they are
           supposed to fall on. Counted in days, day `half` ends the first
           window and day `half + 1` opens the second, exactly once each. */
        const half = Math.floor(days / 2);
        const mid = new Date(s.getTime() + (half - 1) * 864e5);
        const next = new Date(s.getTime() + half * 864e5);
        log.info(SRC, `trip window ${dotDate(s)}..${dotDate(e)} refused — splitting`,
          { fleet: fleet.fleet, status: r.status, days });
        return (await collectTripWindow(fleet, s, mid, chunks, depth + 1))
          + (await collectTripWindow(fleet, next, e, chunks, depth + 1));
      }
      chunk.error = `HTTP ${r.status}${r.data?.Message ? `: ${String(r.data.Message).slice(0, 120)}` : ''}`;
      log.warn(SRC, `trip window ${dotDate(s)}..${dotDate(e)} refused`,
        { fleet: fleet.fleet, status: r.status, days });
      return 0;
    }
    data = r.data;
  } catch (err) {
    chunk.error = String(err).slice(0, 300);
    log.error(SRC, `trip window ${dotDate(s)}..${dotDate(e)} FAILED`,
      { fleet: fleet.fleet, err: chunk.error });
    return 0;
  }
  const rows = fmsTripRows(data, fleet);
  const written = rows.length ? await upsertMany('trip', rows, ['platform', 'external_id']) : 0;
  chunk.rows = rows.length;
  log.info(SRC, `trips ${fleet.fleet} ${dotDate(s)}..${dotDate(e)}`, { rows: rows.length });
  return written;
}

/* This loop had no per-window error handling at all: a throw on window 3
   abandoned windows 4 through 12 and surfaced as ONE error against the whole
   fleet, with no record of which months were never attempted. That is the
   exact shape that hid a 299-day hole in the Uber history for months, and FMS
   carried a 93-day one of its own — over a period Uber, now fully collected,
   shows as busy. So the fleet was working and this source was quietly failing,
   and nothing recorded where.

   Those 93 days are recoverable, and were the whole time: the windows were
   refused for being too large, not because the history is gone. See
   collectTripWindow above for the measurement.

   Newest first, for the same reason Uber is: a backfill that dies partway
   should have landed the months anybody is actually looking at. */
async function pullTrips(fleet, from, to, onStep) {
  let total = 0;
  /* The longest step in the whole collection sequence: 130 vehicles across
     twelve monthly windows of five-minute telematics, four and a half hours
     end to end. Reporting only on completion makes that indistinguishable from
     a hung process for the entire afternoon. */
  const windows = [...dateChunks(from, to, 31)].reverse();
  const chunks = [];
  let wi = 0;
  for (const [s, e] of windows) {
    await onStep?.({ window: `${dotDate(s)}..${dotDate(e)}`, index: wi++, of: windows.length,
      rows_so_far: total, fleet: fleet.fleet });
    total += await collectTripWindow(fleet, s, e, chunks);
  }
  const failed = chunks.filter((c) => c.error).length;
  if (failed) {
    log.error(SRC, 'trip backfill left holes', { fleet: fleet.fleet, failed, of: chunks.length,
      windows: chunks.filter((c) => c.error).map((c) => `${c.from}..${c.to}`).join(', ') });
  }
  /* A window that succeeded and returned nothing is recorded too. FMS has
     months that come back empty while Uber shows the same days busy, and the
     difference between "asked and got nothing" and "never asked" is the whole
     question — one is the provider's answer, the other is our bug. */
  return { total, chunks };
}

// ---- historical driver-behaviour alerts ----
async function pullAlerts(fleet, from, to) {
  let total = 0;
  const chunks = [];
  for (const [s, e] of [...dateChunks(from, to, 31)].reverse()) {
    const chunk = { from: iso(s), to: iso(e), rows: 0, error: null, kind: 'alerts' };
    chunks.push(chunk);
    let data;
    try {
      const r = await call('GetAlertData', {
        username: fleet.username, Password: fleet.password, vehicleno: 'ALL',
        fromdate: dotDate(s), todate: dotDate(e),
      });
      /* Same check the trip loop makes, for the same reason: a refusal read
         through `data?.Data || []` is indistinguishable from a quiet month. */
      if (!r.ok) {
        chunk.error = `HTTP ${r.status}${r.data?.Message ? `: ${String(r.data.Message).slice(0, 120)}` : ''}`;
        log.warn(SRC, `alert window ${dotDate(s)}..${dotDate(e)} refused`,
          { fleet: fleet.fleet, status: r.status });
        continue;
      }
      data = r.data;
    } catch (err) {
      chunk.error = String(err).slice(0, 300);
      log.error(SRC, `alert window ${dotDate(s)}..${dotDate(e)} FAILED`,
        { fleet: fleet.fleet, err: chunk.error });
      continue;
    }
    const rows = (data?.Data || []).map((a) => {
      const plate = normPlate(a['Plate No']);
      const at = parseFmsTime(a['Alert Date Time']);
      return {
        // Same reason as the journey key above: these bytes are already in the table.
        platform: SRC, external_id: `${plate ?? ''}|${a['Alert Name']}|${at}`, fleet_id: fleet.fleet,
        plate, alert_type: a['Alert Name'], occurred_at: at, location: a['Start Location'], raw: a,
      };
    }).filter((r) => r.occurred_at);
    if (rows.length) total += await upsertMany('alert', rows, ['platform', 'external_id']);
    chunk.rows = rows.length;
  }
  return { total, chunks };
}

// ---- live snapshot (also usable as a realtime poller) ----
export async function pullLive(fleet) {
  const { data: login } = await call('Login', { username: fleet.username, password: fleet.password });
  const userid = login?.userid;
  if (!userid) return 0;
  const { data } = await call('GetVehicleStatus', { UserId: userid });
  const rows = (data?.data || []).map((v) => ({
    source: SRC, fleet_id: fleet.fleet, plate: normPlate(v.vehicleno),
    captured_at: parseFmsTime(v.tracktime) || new Date().toISOString(),
    lat: v.lat, lng: v.lon, speed: parseFloat(v.speed) || null,
    ignition: /on/i.test(v.ignition || ''), status: (v.vehiclestatus || '').split(' - ')[0],
    fuel_level: v.fuellevel, ac_on: /on/i.test(v.acstatus || ''), raw: v,
  }));
  return rows.length ? upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']) : 0;
}

// backfill/incremental entry point
export async function collect({ from, to, mode, onStep }) {
  for (const fleet of config.fms.fleets) {
    if (!fleet.password) { log.warn(SRC, `no password for ${fleet.fleet}, skipping`); continue; }
    try {
      const trips = await pullTrips(fleet, from, to, onStep);
      const alerts = await pullAlerts(fleet, from, to);
      // logRun downgrades a run to 'partial' when any chunk failed, so a run
      // that wrote rows AND left windows unfetched cannot report 'ok'.
      await logRun({ source: SRC, fleet_id: fleet.fleet, mode, window_start: from, window_end: to,
        rows_written: trips.total + alerts.total, chunks: [...trips.chunks, ...alerts.chunks] });
      log.info(SRC, `done ${fleet.fleet}`, { trips: trips.total, alerts: alerts.total,
        windows_failed: [...trips.chunks, ...alerts.chunks].filter((c) => c.error).length });
    } catch (e) {
      await logRun({ source: SRC, fleet_id: fleet.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
      log.error(SRC, `failed ${fleet.fleet}`, { err: String(e) });
    }
  }
}
