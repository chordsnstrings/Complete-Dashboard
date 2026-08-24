/* A small but complete fleet, for tests that need every table populated at once.
   ─────────────────────────────────────────────────────────────────────────
   Deterministic: the same seed produces the same fleet on every run, so a
   failure is reproducible and a diff in the output is a real change.

   Deliberately includes the awkward shapes, because those are what the tests
   using this are for:
     - a driver the provider names but never gives an id (the hotel channel)
     - a driver with two ids on two platforms, one human
     - an Uber-style trip with no fare at all (the export has no fare column)
     - FMS telematics rows: journeys with a plate, no driver, odometer distance
     - a vehicle with telemetry but no trips, and one with trips but no telemetry
     - a driver who left mid-window, and one who started mid-window */
import { refreshPayouts } from '../src/rollup.js';

export const PLATES = ['L45240', 'L46174', 'L40965', 'L36395', 'L94178'];
export const DAY0 = '2026-08-01';
export const DAY1 = '2026-08-31';

/* A fleet deliberately WIDER than every LIMIT in the API, for the tests that
   ask what a page says when its list is truncated. Every cap in api/ is 600 or
   below, so 240 plates and 240 people overflow the widest per-entity list while
   staying small enough to seed in a few seconds. */
export const WIDE_PLATES = 240;
export const WIDE_PEOPLE = 240;

const PEOPLE = [
  { name: 'Muhammad Khalid', ids: { uber: 'u-khalid', yango: 'y-khalid' } },
  { name: 'Nauman Hassan', ids: { uber: 'u-nauman' } },
  { name: 'Kashif Ali', ids: { uber: 'u-kashif', bolt: 'b-kashif' } },
  { name: 'Tariq Afzal', ids: { yango: 'y-tariq' } },
  { name: 'Dana Noor', ids: {} },                    // named, never numbered
];

/* The corporate channel's properties. A booking made by a hotel belongs to a
   property as much as to a driver, and the property is its own page. */
const PARTNERS = [
  { id: 'p-marina', name: 'Marina Grand Hotel' },
  { id: 'p-creek', name: 'Creekside Residences' },
  { id: 'p-dxb', name: 'Airport Executive Suites' },
];

let seed = 20260801;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const pick = (a) => a[Math.floor(rnd() * a.length)];

export async function seedFleet(db, { wide = false } = {}) {
  const q = (t, p = []) => db.query(t, p);
  let n = 0;
  /* driver_payout_day is a TABLE (sql/schema_v23.sql) the collector fills
     through src/rollup.js after every run. A fixture plays the collector, so
     it fills the table the same way — in BOTH branches: the first version of
     this refresh sat at the bottom of seedWide's tail, and the default fleet
     returned three lines up from here without ever running it, so the preview
     served a fleet that was never paid while every wide-fixture test passed. */
  if (wide) {
    const nWide = await seedWide(db);
    await refreshPayouts(db);
    return nWide;
  }
  for (let d = 0; d < 31; d++) {
    const day = `2026-08-${String(d + 1).padStart(2, '0')}`;
    for (let i = 0; i < 12; i++) {
      const person = PEOPLE[Math.floor(rnd() * PEOPLE.length)];
      const platforms = Object.keys(person.ids);
      // Dana has no ids at all; she works the hotel channel.
      const platform = platforms.length ? pick([...platforms, 'hotel']) : 'hotel';
      const id = person.ids[platform] || null;
      const hour = [7, 8, 9, 12, 14, 17, 18, 19, 19, 20, 22, 1][Math.floor(rnd() * 12)];
      const km = +(2 + rnd() * 22).toFixed(2);
      const status = rnd() < 0.88 ? 'completed'
        : platform === 'bolt' ? pick(['client_did_not_show', 'driver_rejected'])
          : pick(['rider_cancelled', 'driver_cancelled']);
      // Uber's trip export carries no fare column at all.
      const price = platform === 'uber' ? null : +(9 + km * 2.4 + rnd() * 12).toFixed(2);
      const at = `${day}T${String(hour).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00+04:00`;
      // The corporate channel books against a PROPERTY, which is its own page.
      const partner = platform === 'hotel' ? PARTNERS[Math.floor(rnd() * PARTNERS.length)].id : null;
      await q(
        `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, ended_at, distance_km, status, product, payment_type, price,
           pickup_addr, dropoff_addr, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, partner_id)
         VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT DO NOTHING`,
        [platform, `${platform}-${d}-${i}`, PLATES[Math.floor(rnd() * 4)], id, person.name, at,
          new Date(Date.parse(at) + km * 3 * 60000).toISOString(), km, status,
          pick(['Electric', 'UberX', 'Comfort']), platform === 'hotel' ? 'offline' : pick(['cash', 'apple_pay', 'cashless']),
          price, 'Deira - Dubai - UAE', 'Marina - Dubai - UAE',
          25.05 + rnd() * 0.25, 55.1 + rnd() * 0.35, 25.05 + rnd() * 0.25, 55.1 + rnd() * 0.35,
          partner]);
      n++;
    }
    // FMS telematics twin journeys: a plate, no driver, an odometer distance.
    await q(
      `INSERT INTO trip (platform, external_id, fleet_id, plate, requested_at, ended_at, distance_km, status)
       VALUES ('fms',$1,'ecosine',$2,$3,$4,$5,'completed') ON CONFLICT DO NOTHING`,
      [`fms-${d}`, PLATES[0], `${day}T06:00:00+04:00`, `${day}T23:00:00+04:00`, 190000 + d * 40]);
  }

  // A vehicle with telemetry and no trips at all — the asset nobody is using.
  for (let i = 0; i < 40; i++) {
    await q(
      `INSERT INTO telemetry_snapshot (source, fleet_id, plate, captured_at, lat, lng, speed, status,
         seat_occupied, ignition, polled_at, odometer)
       VALUES ('cabman','ecosine',$1,$2,$3,$4,$5,$6,$7,$8,$2,$9) ON CONFLICT DO NOTHING`,
      [i % 5 === 0 ? PLATES[4] : PLATES[Math.floor(rnd() * 4)],
        `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${String(6 + (i % 16)).padStart(2, '0')}:00:00+04:00`,
        25.05 + rnd() * 0.25, 55.1 + rnd() * 0.35, Math.floor(rnd() * 90),
        rnd() < 0.3 ? 'Engaged' : 'Active', rnd() < 0.35, rnd() < 0.8, 190000 + i * 30]);
  }

  const ATYPE = ['Harsh Brake', 'Sharp Turn', 'Harsh Acceleration', 'OverSpeed'];
  for (let i = 0; i < 60; i++)
    await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
             VALUES ('fms',$1,'ecosine',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [`al-${i}`, PLATES[Math.floor(rnd() * 4)], pick(ATYPE),
        `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${String(7 + (i % 14)).padStart(2, '0')}:30:00+04:00`]);

  for (const [v, count] of [['authorized', 30], ['unauthorized', 6], ['sensor_suspect', 3], ['partial', 4], ['stationary', 12]])
    for (let i = 0; i < count; i++) {
      const day = `2026-08-${String(((i * 3) % 28) + 1).padStart(2, '0')}`;
      const dur = v === 'sensor_suspect' ? 340 : v === 'stationary' ? 3 : 12 + Math.floor(rnd() * 40);
      const start = `${day}T${String(8 + (i % 12)).padStart(2, '0')}:10:00+04:00`;
      await q(
        `INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, duration_min, distance_km,
           top_speed, fixes, max_gap_min, ignition_ratio, verdict, matched_platform, low_confidence,
           start_lat, start_lng, end_lat, end_lng)
         VALUES ($1,$2,$3,'ecosine',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING`,
        [PLATES[Math.floor(rnd() * 4)], start, new Date(Date.parse(start) + dur * 60000).toISOString(),
          dur, v === 'stationary' || v === 'sensor_suspect' ? 0.3 : +(2 + rnd() * 20).toFixed(2),
          v === 'stationary' ? 0 : 40 + Math.floor(rnd() * 50), Math.max(2, Math.floor(dur / 5)),
          v === 'partial' ? 25 : 5, v === 'sensor_suspect' ? 0.05 : 0.9, v,
          v === 'authorized' ? pick(['uber', 'yango', 'hotel']) : null,
          v === 'unauthorized' && rnd() < 0.3,
          25.05 + rnd() * 0.25, 55.1 + rnd() * 0.35, 25.05 + rnd() * 0.25, 55.1 + rnd() * 0.35]);
    }

  for (const p of PEOPLE) {
    for (const [platform, id] of Object.entries(p.ids)) {
      await q(`INSERT INTO driver_compliance (platform, fleet_id, driver_ext_id, full_name, phone,
                 licence_no, licence_expires, state, rating)
               VALUES ($1,'ecosine',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
        [platform, id, p.name, '+9715000000', `L${id}`, '2026-11-15', 'working', 4.7]);
      await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, plate,
                 period_start, period_end, trips, hours_online, hours_on_trip, acceptance_rate,
                 cancellation_rate, distance_km, earnings, cash_earnings)
               VALUES ($1,'ecosine',$2,$3,$4,'2026-08-01','2026-08-31',60,180.5,90.2,0.91,0.04,900,4200,900)
               ON CONFLICT DO NOTHING`, [platform, id, p.name, PLATES[0]]);
    }
  }

  for (const p of PARTNERS)
    await q(`INSERT INTO partner (platform, partner_id, name, active, address, phone,
               approval_required, purpose_required, editable_amount)
             VALUES ('hotel',$1,$2,true,'Dubai, UAE','+97140000000',$3,$4,false)
             ON CONFLICT DO NOTHING`,
      [p.id, p.name, p.id === 'p-dxb', p.id !== 'p-marina']);

  for (const plate of PLATES)
    for (const [doc, when, state] of [['registration', '2026-10-01', 'valid'],
                                      ['insurance', '2026-09-05', 'expiring']])
      await q(`INSERT INTO vehicle_document (platform, vehicle_ext_id, fleet_id, plate, doc_type,
                 expires_at, status)
               VALUES ('fms',$1,'ecosine',$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [`veh-${plate}`, plate, doc, `${when}T00:00:00Z`, state]);

  for (const s of ['cabman', 'uber', 'yango', 'hotel', 'fms', 'bolt'])
    await q(`INSERT INTO collection_run (source, fleet_id, mode, status, rows_written, finished_at,
               window_start, window_end)
             VALUES ($1,'ecosine','incremental','ok',100,'2026-08-31T20:00:00Z','2026-08-01','2026-08-31')`, [s]);

  await refreshPayouts(db);
  return n;
}


/* One month, many plates and many people, one trip each per day for a slice of
   them. Shaped only for the truncation questions: does a capped list say it is
   capped, and is every total on the page computed over the population rather
   than over the rows that happened to come back. */
async function seedWide(db) {
  const q = (t, p = []) => db.query(t, p);
  let n = 0;
  const plate = (i) => `W${String(i).padStart(5, '0')}`;
  const person = (i) => ({ id: `w-${i}`, name: `Wide Driver ${String(i).padStart(3, '0')}` });
  for (let d = 0; d < 28; d++) {
    const day = `2026-08-${String(d + 1).padStart(2, '0')}`;
    for (let i = 0; i < WIDE_PLATES; i++) {
      const p = person((i + d) % WIDE_PEOPLE);
      const km = 4 + ((i * 7 + d) % 20);
      await q(
        `INSERT INTO trip (platform, external_id, fleet_id, plate, driver_ext_id, driver_name,
           requested_at, ended_at, distance_km, status, product, payment_type, price,
           pickup_addr, dropoff_addr)
         VALUES ($1,$2,'ecosine',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 'Deira - Dubai - UAE','Marina - Dubai - UAE') ON CONFLICT DO NOTHING`,
        [['uber', 'yango', 'bolt', 'hotel'][i % 4], `w-${d}-${i}`, plate(i), p.id, p.name,
          `${day}T${String(7 + (i % 14)).padStart(2, '0')}:00:00+04:00`,
          `${day}T${String(8 + (i % 14)).padStart(2, '0')}:00:00+04:00`,
          km, i % 9 === 0 ? 'rider_cancelled' : 'completed',
          'Comfort', i % 3 === 0 ? 'cash' : 'cashless', i % 4 === 0 ? null : 20 + (i % 40)]);
      n++;
    }
  }
  for (let i = 0; i < WIDE_PLATES; i++) {
    await q(`INSERT INTO vehicle_document (platform, vehicle_ext_id, fleet_id, plate, doc_type,
               expires_at, status)
             VALUES ('fms',$1,'ecosine',$2,'registration',$3,'valid') ON CONFLICT DO NOTHING`,
      [`veh-${i}`, plate(i), `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`]);
    await q(`INSERT INTO alert (platform, external_id, fleet_id, plate, alert_type, occurred_at)
             VALUES ('fms',$1,'ecosine',$2,$3,$4) ON CONFLICT DO NOTHING`,
      [`wal-${i}`, plate(i), ['Harsh Brake', 'OverSpeed', 'Sharp Turn'][i % 3],
        `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00+04:00`]);
    await q(`INSERT INTO occupancy_segment (plate, started_at, ended_at, fleet_id, duration_min,
               distance_km, top_speed, fixes, max_gap_min, ignition_ratio, verdict)
             VALUES ($1,$2,$3,'ecosine',25,9,60,5,5,0.9,'unauthorized') ON CONFLICT DO NOTHING`,
      [plate(i), `2026-08-${String((i % 28) + 1).padStart(2, '0')}T13:00:00+04:00`,
        `2026-08-${String((i % 28) + 1).padStart(2, '0')}T13:25:00+04:00`]);
  }
  for (let i = 0; i < WIDE_PEOPLE; i++) {
    const p = person(i);
    await q(`INSERT INTO driver_compliance (platform, fleet_id, driver_ext_id, full_name, phone,
               licence_no, licence_expires, state, rating)
             VALUES ('uber','ecosine',$1,$2,'+9715000000',$3,$4,'working',4.6)
             ON CONFLICT DO NOTHING`,
      [p.id, p.name, `L${p.id}`, `2026-${String(9 + (i % 3)).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`]);
    /* Platform-reported earnings, weekly, for everybody. Four weeks of 240
       people is 960 rows against a 300-row cap — which is the state the real
       fleet entered the moment the Uber collector stopped seeing ten drivers
       and started seeing a hundred and fifty. Before this, no fixture ever had
       more than a handful, so the cap on /api/drivers/performance could not
       bite and the truncation test could not see it. */
    for (const [ws, we] of [['2026-08-01', '2026-08-07'], ['2026-08-08', '2026-08-14'],
      ['2026-08-15', '2026-08-21'], ['2026-08-22', '2026-08-28']]) {
      await q(`INSERT INTO driver_performance (platform, fleet_id, driver_ext_id, driver_name, plate,
                 period_start, period_end, trips, hours_online, hours_on_trip, acceptance_rate,
                 cancellation_rate, distance_km, earnings, cash_earnings)
               VALUES ('uber','ecosine',$1,$2,$3,$4,$5,$6,$7,$8,0.91,0.04,$9,$10,$11)
               ON CONFLICT DO NOTHING`,
        [p.id, p.name, plate(i % WIDE_PLATES), ws, we,
          20 + (i % 30), 40 + (i % 20), 22 + (i % 12),
          300 + (i % 200), 900 + (i % 700), 120 + (i % 90)]);
    }
  }
  return n;
}
