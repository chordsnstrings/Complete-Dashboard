// Yango collector (Ecosine park). Cursor pagination; >=12 months retention.
//  Trips   : /api/reports-api/v1/orders/list        (40/page, cursor)
//  Drivers : /api/reports-api/v2/summary/drivers/list
//  Ledger  : /api/v1/reports/transactions/park/list (cursor)
import { config, normPlate } from '../config.js';
import { http } from '../http.js';
import { upsertMany, logRun } from '../db.js';
import { iso } from '../util.js';
import { log } from '../log.js';

const SRC = 'yango';
const headers = () => ({
  'X-Park-Id': config.yango.parkId, 'X-API-Key': config.yango.apiKey,
  'content-type': 'application/json', 'Accept-Language': 'en', cookie: config.yango.cookie,
});
const post = (path, body) => http(`${config.yango.base}${path}`, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
const dubai = (d, end) => `${iso(d)}T${end ? '23:59:59' : '00:00:00'}+04:00`;

async function pullTrips(from, to) {
  let cursor, total = 0, guard = 0;
  do {
    const { data } = await post('/api/reports-api/v1/orders/list',
      { date_type: 'booked_at', date_from: dubai(from), date_to: dubai(to, true), ...(cursor ? { cursor } : {}) });
    const orders = data?.orders || [];
    const rows = orders.map((o) => ({
      platform: SRC, external_id: o.id, fleet_id: config.yango.fleet, plate: normPlate(o.car_license_number),
      driver_ext_id: o.driver_id, driver_name: o.driver_full_name,
      requested_at: o.booked_at, ended_at: o.ended_at,
      pickup_addr: o.address_from, dropoff_addr: o.address_to,
      distance_km: o.mileage != null ? Number(o.mileage) / 1000 : null,
      status: o.status, product: o.category, payment_type: o.payment_method,
      price: o.price, currency: o.currency_code || 'AED', raw: o,
    })).filter((r) => r.external_id);
    if (rows.length) total += await upsertMany('trip', rows, ['platform', 'external_id']);
    cursor = data?.cursor;
    if (orders.length === 0) break;
  } while (cursor && ++guard < 2000);
  return total;
}

async function pullDrivers(from, to) {
  const { data } = await post('/api/reports-api/v2/summary/drivers/list',
    { date_from: iso(from), date_to: iso(to), sort: { field: 'driver_id', direction: 'asc' } });
  const rows = (data?.items || []).map((it) => ({
    platform: SRC, fleet_id: config.yango.fleet, driver_ext_id: it.driver?.id,
    driver_name: `${it.driver?.first_name || ''} ${it.driver?.last_name || ''}`.trim(),
    plate: normPlate(it.car?.callsign), period_start: iso(from), period_end: iso(to),
    trips: it.count_orders_completed, distance_km: it.sum_distance != null ? Number(it.sum_distance) / 1000 : null,
    hours_online: it.work_time_seconds != null ? it.work_time_seconds / 3600 : null,
    earnings: (Number(it.price_cash) || 0) + (Number(it.price_cashless) || 0),
    cash_earnings: it.price_cash, raw: it,
  })).filter((r) => r.driver_ext_id);
  return rows.length ? upsertMany('driver_performance', rows, ['platform', 'driver_ext_id', 'period_start', 'period_end']) : 0;
}

async function pullLedger(from, to) {
  let cursor, total = 0, guard = 0;
  do {
    const { data } = await post('/api/v1/reports/transactions/park/list',
      { query: { park: { transaction: { event_at: { from: dubai(from), to: dubai(to, true) } } } }, limit: 100, ...(cursor ? { cursor } : {}) });
    const txns = data?.transactions || [];
    const rows = txns.map((t) => ({
      platform: SRC, external_id: t.id, fleet_id: config.yango.fleet, driver_ext_id: t.driver_id,
      driver_name: t.driver_name, order_ref: t.order_id, event_at: t.event_at,
      category: t.category_id, amount: t.amount, currency: t.currency_code || 'AED', description: t.description, raw: t,
    })).filter((r) => r.external_id);
    if (rows.length) total += await upsertMany('ledger_entry', rows, ['platform', 'external_id']);
    cursor = data?.cursor;
    if (txns.length === 0) break;
  } while (cursor && ++guard < 2000);
  return total;
}

export async function collect({ from, to, mode }) {
  try {
    const trips = await pullTrips(from, to);
    const drivers = await pullDrivers(from, to);
    const ledger = await pullLedger(from, to);
    await logRun({ source: SRC, fleet_id: config.yango.fleet, mode, window_start: from, window_end: to, status: 'ok', rows_written: trips + drivers + ledger });
    log.info(SRC, 'done', { trips, drivers, ledger });
  } catch (e) {
    await logRun({ source: SRC, fleet_id: config.yango.fleet, mode, window_start: from, window_end: to, status: 'error', error: String(e) });
    log.error(SRC, 'failed', { err: String(e) });
  }
}
