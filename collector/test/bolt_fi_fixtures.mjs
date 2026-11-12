/* Synthetic Bolt orders for test/bolt_fi_orders*.test.mjs — one ride as the
   fleet-integration gateway sends it (getFleetOrders) and the same ride as the
   fleet-owner portal files it (orderHistory/getTable).

   Field names, types and fill follow production's probe of
   egari:getFleetOrders (2026-11-11, /api/probe/results — shape only) and
   Bolt's own spec (apidocs.bolt.eu fleetIntegration open-api.json, read
   2026-11-12). No value from a real order is copied: names, plates, uuids,
   addresses and the phone are made up. */
export const C = { fleet: 'egari', companyId: 142897, userId: 174036 };
export const T0 = Date.parse('2026-11-10T08:00:00Z') / 1000;

export const fiOrder = (n, over = {}) => ({
  order_reference: `ref-${n}`, driver_name: `Driver ${n % 3}`,
  driver_uuid: `uuid-d${n % 3}`, partner_uuid: `uuid-p${n % 3}`,
  driver_phone: '+000 synthetic', payment_method: 'in_app',
  payment_confirmed_timestamp: T0 + n * 600 + 1510, order_created_timestamp: T0 + n * 600,
  order_status: 'finished', driver_cancelled_reason: null, vehicle_model: 'Model',
  vehicle_license_plate: `L ${10000 + (n % 3)}`, price_review_reason: null,
  pickup_address: `Pickup ${n}`, destination_address: `Drop ${n}`,
  order_stops: [
    { type: 'pickup', address: `Pickup ${n}`, lat: 25.1, lng: 55.2, real_lat: 25.1001, real_lng: 55.2001 },
    { type: 'dropoff', address: `Drop ${n}`, lat: 25.2, lng: 55.3, real_lat: 25.2002, real_lng: 55.3002 },
  ],
  ride_distance: 12000 + n, predicted_ride_distance: 11800, road_distance_at_matching: 900,
  order_accepted_timestamp: T0 + n * 600 + 20, order_cancelled_timestamp: null, order_no_show_timestamp: null,
  order_pickup_timestamp: T0 + n * 600 + 300, order_drop_off_timestamp: T0 + n * 600 + 1500,
  order_finished_timestamp: T0 + n * 600 + 1510,
  order_price: { ride_price: 50 + n, booking_fee: 5, toll_fee: 0, cancellation_fee: null, tip: 0,
    net_earnings: 40 + n, cash_discount: 0, in_app_discount: 0, commission: 10 },
  is_scheduled: false, is_optional: false,
  category_info: { name: 'Comfort', seats: 4, vehicle_type: 'car' },
  ...over,
});

/* The same ride on the portal: its own numeric driver id, the creation second,
   the plate WITHOUT its letter code, no coordinates, no addresses (an empty
   route), the driver's partner uuid. */
export const portalOrder = (n, over = {}) => ({
  created: T0 + n * 600, fare_finalised: T0 + n * 600 + 1510,
  driver: { id: 900000 + (n % 3), name: `Driver ${n % 3}` }, car_reg_number: String(10000 + (n % 3)),
  route: [], arrived_to_destinations: [T0 + n * 600 + 1500], distance: 12 + n / 1000, price: 50 + n,
  status: 'finished', category: 'Comfort', payment_method: 'in_app', partner_identifier: `uuid-p${n % 3}`,
  ...over,
});

export const okPage = (orders, total = orders.length, companyId = C.companyId) => ({ status: 200,
  data: { code: 0, message: 'OK', data: { company_id: companyId, company_name: null, total_orders: total, orders } } });
