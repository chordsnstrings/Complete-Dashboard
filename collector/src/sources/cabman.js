// CABMAN DT collector — REALTIME ONLY (no history param). Poll GetIVDData and append
// snapshots; running it on a schedule is how we build CABMAN history ourselves.
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { log } from '../log.js';

const SRC = 'cabman';

/* CABMAN's timestamp field is named `gmt`, and it is GMT.
   It used to be stamped `+04:00`, which moved every fix FOUR HOURS into the
   past. That is not a cosmetic error: the unauthorised-trip reconciler matches
   a movement segment against bookings within a 15-minute tolerance, so a
   240-minute systematic shift meant no CABMAN segment could ever match its own
   booking. Nine drivers were named on the live dashboard for trips they had
   genuinely run on Uber.

   The skew was measurable from the data alone — CABMAN fixes arrived a minimum
   of 240.4 minutes "old" while FMS arrived 3.3 minutes old and Uber 0.9 through
   the same code path. The guard at the end of pullLive watches for it
   returning. */
function parseGmt(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  const iso = s.replace(' ', 'T');
  // Accept an explicit offset if the provider ever starts sending one.
  const stamped = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const d = new Date(stamped);
  return isNaN(d) ? null : d.toISOString();
}

// "0" is a string, and every non-empty string is truthy. Coerce properly.
const truthy = (v) => {
  if (v == null) return null;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '' ) return null;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  return Number.isFinite(Number(s)) ? Number(s) !== 0 : Boolean(v);
};

export async function pullLive() {
  let total = 0;
  for (const f of config.cabman.fleets) {
    if (!f.pass) { log.warn(SRC, `no password for ${f.fleet}, skipping`); continue; }
    const { data } = await http(config.cabman.url, {
      headers: { InterfaceUniqueId: f.interfaceId, InterfaceUserName: f.user, InterfacePassword: f.pass },
    });
    const now = new Date().toISOString();
    const rows = (data?.IVDDataResult || []).map((v) => ({
      source: SRC, fleet_id: f.fleet, plate: normPlate(v.VehicleID),
      captured_at: parseGmt(v.gmt),
      lat: v.lat, lng: v.lng, speed: v.speed,
      // These arrive as numbers or as the STRINGS "0"/"1". `!!"0"` is true, which
      // pinned ignition and seat-occupancy permanently on and made the
      // stuck-sensor guard in the reconciler unreachable.
      ignition: truthy(v.state),
      status: v.Status, seat_occupied: truthy(v.SeatSensorValue), odometer: v.odometer,
      polled_at: now, raw: v,
    })).filter((r) => r.captured_at && r.plate);
    if (rows.length) total += await upsertMany('telemetry_snapshot', rows, ['source', 'plate', 'captured_at']);

    /* A fix that arrives claiming to be hours old is either a clock problem or
       a vehicle that has stopped reporting, and telling them apart is the whole
       job of this check — because it was not doing it.

       The provider returns every vehicle it knows of on every cycle, including
       trackers that went silent long ago: four of this fleet's have not
       produced a fix since April 2024, and sixteen have been quiet over a
       month. Their ancient timestamps sat in the median, dragged it past the
       threshold, and this logged an ERROR every five minutes — pointing at a
       timezone change that had not happened, on a channel meant for things
       somebody must act on. The tell was in the number: the lag hovered around
       forty-five minutes, and no timezone is forty-five minutes from Dubai.

       So the dormant trackers are excluded — anything outside a day — and
       counted separately, because "sixteen vehicles have stopped reporting" is
       worth knowing and is not an error in the collector.

       That much was right and it was still firing. Measured on production:
       median 24 minutes over 34 reporting vehicles, an ERROR every five
       minutes, 288 a day. And the distribution says there is nothing wrong:
       the FRESHEST fix is 1.2 minutes old.

       Which is the whole discriminator, and the median is the wrong statistic
       for it. These trackers report on movement, not on a timer, so a car
       parked twenty minutes ago is twenty minutes stale and perfectly healthy
       — half the fleet is parked at any moment, and that is what the median
       measures. A clock or timezone error does something the median cannot
       distinguish from that: it moves EVERY vehicle at once, including the
       ones that just reported. An hour added to the provider's gmt field puts
       the freshest fix at sixty-one minutes, not at one.

       So the floor is the test. If the newest fix in the whole fleet is
       stale, the feed is behind; if any vehicle reported a minute ago, no
       clock is wrong however many cars are parked. The tenth percentile
       rather than the bare minimum, so one freak-fresh row cannot silence a
       real skew, and the median still travels in the message as context. */
    const DORMANT_MIN = 24 * 60;
    const lags = rows.map((r) => (Date.parse(now) - Date.parse(r.captured_at)) / 60000)
      .filter(Number.isFinite).sort((a, b) => a - b);
    const talking = lags.filter((m) => m < DORMANT_MIN);
    const dormant = lags.length - talking.length;
    const at = (p) => (talking.length ? talking[Math.min(talking.length - 1,
      Math.floor(talking.length * p))] : 0);
    const median = at(0.5);
    const floor = at(0.1);
    if (floor > 20) {
      log.error(SRC, 'telemetry clock skew — even the freshest fix is behind the poll', {
        freshest_decile_min: Math.round(floor), median_lag_min: Math.round(median),
        reporting: talking.length, fleet: f.fleet,
        hint: 'a whole-hour offset means the provider changed the timezone of its gmt field; '
          + 'minutes mean the feed itself is lagging. A high median with a low floor is not '
          + 'skew — it is a fleet with cars parked, which is what a fleet looks like',
      });
    }
    if (dormant) {
      log.info(SRC, 'vehicles listed but not reporting', {
        dormant, of: lags.length, fleet: f.fleet,
        oldest_days: Math.round(lags[lags.length - 1] / 1440),
      });
    }
  }
  return total;
}

// CABMAN has no historical endpoint — "collect" just captures the current snapshot.
export async function collect({ mode = 'realtime' } = {}) {
  try {
    const n = await pullLive();
    await logRun({ source: SRC, fleet_id: null, mode, status: 'ok', rows_written: n });
    log.info(SRC, 'snapshot captured', { rows: n });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: null, mode, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
