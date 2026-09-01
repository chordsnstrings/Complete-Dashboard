# Ecosine & Egari — Fleet Tracking API Reference

> Reconnaissance of every data source available for tracking the **Ecosine** and **Egari**
> fleets, as of **2026-08-21**. Each source below was tested live. Secrets, tokens, driver
> emails/phones and other PII are **redacted** here — see the credential source column and your
> own vault. Counts are point-in-time snapshots from the test run.

## 0. TL;DR — which system owns which fleet

| System | Ecosine | Egari | Auth style | Status | Best for |
|---|---|---|---|---|---|
| **CABMAN DT** (IVD) | ✅ 48 cars live | ❌ (no creds given) | Custom header creds | **Live** | Real-time raw GPS + seat occupancy |
| **FMS / InfoTrack** (`ItlService.svc`) | ✅ uid 1158, 49 cars | ✅ uid 1383, 38 cars | username/password | **Live** | Live telemetry, trips, activity, driver-behaviour alerts, dashcam |
| **Bolt — Fleet Integration API** | ❌ `COMPANIES_NOT_ALLOWED` | ✅ 67 drivers / 52 cars | OAuth client_credentials | **Live** | Driver + vehicle roster/compliance |
| **Bolt — Fleet Owner Portal** | ⛔ token expired | ⛔ token expired | Rotating refresh token | **Blocked** | Trips, earnings, payouts, invoices, engagement |
| **Uber — Vehicle Suppliers API** | ✅ 113 drivers / 98 cars | ❌ (this client = Ecosine) | OAuth client_credentials | **Live** | Roster, live online/on-trip status, payments, transactions, analytics |
| **Uber — Supplier web GraphQL** | ✅ live session | — | Browser cookies (`sid`/`csid`) | **Live** | Driver scorecards, earnings ledger, driver events |
| **Yango — Fleet web API** (`fleet.yango.com`) | ✅ 104 cars / 100+ drivers | ❌ (this park = Ecosine) | Park-id + Yandex cookie | **Live** | Roster, live driver status, trips w/ fare breakdown, finance |

**Key structural facts**
- **Raw GPS coordinates** (lat/lng, speed, heading, odometer) come **only** from the telematics
  layer — **CABMAN** and **FMS**. Uber and Yango expose *driver state* (online/on-trip/offline)
  but **not** live coordinates through the tested endpoints.
- The ride-hailing accounts are split: **Uber + Yango = Ecosine**, **Bolt official API = Egari**.
  The Bolt Fleet Owner Portal (currently blocked) covers **both** companies (142868 Ecosine, 142897 Egari).
- Two things are blocked and need a human refresh: **Bolt Fleet Owner Portal** (refresh token
  expired 2026-08-20) and, eventually, the cookie-based sessions (Uber web, Yango).

---

## 1. CABMAN DT — In-Vehicle Device (IVD) tracking

**Endpoint** `GET https://app.cabman.ae/dtcabmanrestservice/api/trackingServices/GetIVDData`
**Auth** headers `InterfaceUniqueId`, `InterfaceUserName` (`admin_ecosine`), `InterfacePassword` *(redacted)*
**Method** GET only (POST → 405). No body/params. Returns the **current** snapshot for all devices.
**Scope tested** Ecosine only (48 vehicles). No Egari credentials were provided; credential guessing
was intentionally not attempted.

Per-vehicle fields (`IVDDataResult[]`):

| Field | Meaning / example |
|---|---|
| `VehicleID` | Plate, e.g. `L45235` |
| `VehicleType` | `TESLA MODEL Y`, `BYD HAN`, `LEXUS ES 300H`, `POLESTAR POLESTAR 4`, `TESLA MODEL 3`, `TOYOTA HIGHLANDER` |
| `FuelTypeName` | `Petrol`, `Electric`, `Electric Power` |
| `CompanyName` | `Ecosine Transports LLC` |
| `LastReportedTime` / `gmt` | Last fix timestamp |
| `LastReportedLocation` | `"25.1859 , 55.3969"` (string) |
| `lat`, `lng` | Precise coordinates (double) |
| `speed` | km/h |
| `state` | boolean — ignition/reporting on |
| `odometer` | km (double) |
| `device_id` | Hardware IMEI, e.g. `354394490123410` |
| `Status` | `Active` (idle/available) or `Engaged` (on a trip) |
| `SeatSensorStatus` / `SeatSensorValue` | Passenger seat occupancy — `Active`/`Not Active`, `1`/`0` |

**Unique value:** the **seat-occupancy sensor** and a clean `Engaged` flag — you can tell whether a
car physically has a passenger, independent of any ride-hailing app. Snapshot only (no history via this method).

---

## 2. FMS / InfoTrack Telematics — `ItlService.svc`

**Base** `http://103.185.74.197/currentinfotest/ItlService.svc/<Operation>` (REST/webHttp, JSON out)
**Auth** `username` + `password` query params (Ecosine `ecosinetranspor`, Egari `egariluxury`; passwords redacted).
Some operations use a numeric **UserId** obtained from `Login` (Ecosine **1158**, Egari **1383**).
**Discovery** all operations enumerated from the WSDL (`?wsdl` / `?xsd=xsd0`). **Both fleets** work identically.

### Operation catalogue (17 operations)

| Operation | Params | Returns | Status |
|---|---|---|---|
| `Login` | username, password | `userid`, `mdvrenabled`, `mdvripaddress` | ✅ |
| `GetVehicleList` | username, password | Fleet roster | ✅ |
| `GetVehicleCurrentDetails` | username, password, vehicleno=`ALL` | Live position + telemetry | ✅ |
| `GetVehicleStatus` | UserId | Live status (rich: AC, fuel, temp, driver) | ✅ |
| `GetVehicleStatusV2` | UserId | Live status (DataTables format) | ✅ |
| `GetVehicleStats` | userid | Fleet KPI counts | ✅ |
| `GetTripPassenger` | username, password, vehicleno, fromdate, todate | Historical trips + seat count | ✅ |
| `GetVehicleActivity` | username, password, vehicleno (single), fromdate, todate | Activity segments (idle/stop/travel) | ✅ |
| `GetAlertData` | username, password, vehicleno=`ALL`, fromdate, todate | Driver-behaviour events (flat) | ✅ |
| `GetAlertStatus` | UserId | Recent alerts + dashcam links | ✅ |
| `GetAlertStatusV2` | UserId | (returned empty — likely needs date args) | ⚠️ |
| `GetGeofenceInfo` | UserId | `Authentication failed` — different auth/param needed | ⚠️ |
| `GetVehicleStatusList` | UserId, listtype | `listtype` enum value unknown (400) | ⚠️ |
| `GetVehicleCurrentDetailsv1` | username, password, deviceid, trip, road, dates | `Authentication failed` — needs specific device id format | ⚠️ |
| `GetCanbusData` | username, password, vehicleno | 400 — CANbus not enabled for these EVs | ❌ |
| `GetAlertData`… | — | (see above) | — |
| `InsertGpsInfo` | gpsrecord | **write** endpoint — not exercised | ⛔ |

### Key field schemas

**`GetVehicleList`** — `Vehicleno`, `UnitNo` (device serial), `MobileNo` (SIM), `ClientName`,
`StartOdometer`, `FuelTankCapacity`, `Mileage`, `VehicleModel`, `VehicleMake`.

**`GetVehicleCurrentDetails`** (live) — `Plate No`, `TrackTime`, `Lat`, `Lon`, `Vehicle location`
(reverse-geocoded), `Driver Name`, `RFID`, `Odometer`, `DeviceOdometer`, `direction` (heading °),
`Ignition` (On/Off), `Engine status` (Idle/Stop), `Status Duration`, `speed`, `Seatcount`.

**`GetVehicleStatus`** (live, richest) — `vehiclestatus` (e.g. `Moving - NE`, 8-point compass),
`gpsstatus`, `vehicleno`, `username` (driver label), `tracktime`, `location`, `speed`, **`fuellevel`**,
`ignition`, `lat`/`lon`, `idletime`, `stoptime`, `mdvrunitno`, `MobileNo`, `DriverName`,
`DriverMobileNo`, `temperature`, `vehiclename`, `previousDistance`, `currentDistance`, `duration`,
**`acstatus`** (AC on/off).

**`GetVehicleStats`** (fleet KPI) — `total`, `idle`, `stopped`, `moving`, `inactive`, `outofservice`.
_Snapshot: Ecosine 49 (idle 10 / stopped 16 / moving 9 / inactive 14); Egari 38 (idle 9 / stopped 17 / moving 6 / inactive 5 / outofservice 1)._

**`GetTripPassenger`** (history) — `Slno`, `Plate No`, `Start Time`, `End Time`, `Start Location`,
`End Location`, `StartLat/StartLon`, `EndLat/EndLon`, `Trip Duration`, `Total Travel Distance` (km),
`Seat Count` (1–4). _Aug 1–20: **Ecosine 3,108 trips / 33 cars**, **Egari 2,195 trips / 29 cars**._

**`GetVehicleActivity`** — per segment: `Vehicle No`, `Driver Name`, `StartTime`/`EndTime`, `Duration`,
`StartLocation`/`EndLocation` + lat/lon, **`acttype`** (`IDLE`/`STOP`/`TRAVEL`), `distancetravelled`.

**`GetAlertData` / `GetAlertStatus`** — driver-behaviour events. Types seen: **Sharp Turn, Harsh Brake,
Harsh Acceleration, OverSpeed, Main Power Lost**. `GetAlertStatus` also returns `DriverName`,
`DriverMobileNo`, `AlerTypeId`, `fuellevel`, and **MDVR dashcam** fields (`VideoPresent`, `videoFiles`,
`VideoBaseUrl` → `http://mdvr.infosmart.co.in/gstoragevideos/`). _~5,732 alert events for Ecosine in a single day._

**Unique value:** the deepest telematics layer — live fuel/AC/temperature/ignition, harsh-driving
scoring, geofencing (auth pending), and dashcam video references — for **both** fleets.

---

## 3. Bolt

Bolt has **two separate APIs**. Only one is currently usable.

### 3a. Fleet Integration API (official, OAuth) — **WORKS (Egari only)**

**Token** `POST https://oidc.bolt.eu/token` — `grant_type=client_credentials`,
`scope=fleet-integration:api`, client id/secret *(redacted)*. Token TTL **600 s**.
**Gateway** `POST https://node.bolt.eu/fleet-integration-gateway/fleetIntegration/v1/<op>`
**Authorised company** `142897` (**Egari**). `142868` (Ecosine) → `COMPANIES_NOT_ALLOWED`.
Common body: `{ company_id, offset, limit, start_ts, end_ts }` (epoch **seconds**; `limit` max ≈ 200).

| Route | Result |
|---|---|
| `getDrivers` | ✅ 67 drivers (35 active / 25 deactivated / 7 suspended) |
| `getVehicles` | ✅ 52 vehicles (34 active / 6 deactivated / 10 suspended) |
| `test` | ✅ health echo (`{code:0}`) |
| `getOrders`, `getStateLogs`, `getCompletedOrders`, `getOrderHistory`, `getCompanies`, `getFleetState` | ❌ 404 — not exposed on this gateway |

**`getDrivers`** fields — `driver_uuid`, `partner_uuid`, `first_name`, `last_name`, `email`, `phone`,
`state`, `has_cash_payment`, `suspension_reason` (HTML), `driver_score`, `driver_rating`,
`active_categories` (`Bolt`, `Bolt Streethailing`, `Comfort`, `Premium`), `inactive_categories`,
`active_vehicle` {`id`, `model`, `year`, `reg_number`, `vin`, `uuid`, `state`}, `eligible_for_scheduled_ride`.

**`getVehicles`** fields — `id`, `model`, `year`, `seats`, `color`, `car_transport_licence_number`,
`reg_number`, `vin`, `uuid`, `eligible_category_groups`, `state`, `suspension_reason`.

> ⚠️ No trips / earnings / live-location on this API surface — those live only in the Portal (below).

### 3b. Fleet Owner Portal API — **BLOCKED (token expired 2026-08-20)**

**Base** `https://fleetownerportal.live.boltsvc.net/fleetOwnerPortal/…?…&brand=bolt`
**Auth** `POST /getAccessToken` with a **rotating refresh token** → short-lived `access_token` (Bearer).
The provided refresh token (`fleet_owner_id 173999`) **expired 2026-08-20 05:07 UTC** →
`REFRESH_TOKEN_INVALID`. Needs a fresh login to re-issue. Covers **both** companies
(142868 Ecosine, 142897 Egari; user_ids 173999 / 174036).

Endpoints available once a valid token exists (from the Postman collection):

| Endpoint | Data |
|---|---|
| `getProfile` / `getCompanyDetails` | Owner + company profile, company list |
| `getVehicles/dateRange`, `v2/getCarApplications`, `getCar?id=` | Vehicle roster + per-car detail |
| `getDriversByDateRange`, `getDriver?id=` | Driver roster + per-driver detail |
| `getDriverEngagementData/dateRange` | Per-driver **performance/engagement** (offset/limit) |
| `orderHistory/getTable`, `orderHistory/getCsv` | **Trip history** by state (finished, client_cancelled, driver_rejected, …) |
| `getCompanyEarnings/recent?period=` | Company earnings (`ongoing_day`, `previous_7_days`) |
| `getDriverEarnings/recent`, `driverEarnings/getCsv`, `getFleetBalanceDetails` | Per-driver earnings + fleet balance |
| `getPayouts`, `getRiderInvoices?date=YYYYMM`, `getTaxifyInvoices`, `getTaxifyInvoicePdf?invoice_id=` | Payouts + invoices (PDF) |

**Action needed:** re-login to Bolt to mint a fresh refresh token (they last ~7 days), then this
entire portal surface (trips + money) opens for both fleets.

---

## 4. Uber — ECOSINE org

Org discovered via API: **ECOSINE TRANSPORTS** (`types: DRIVER_BUSINESS, MULTI_DRIVER_BUSINESS`).
Two usable layers.

### 4a. Vehicle Suppliers API (official, OAuth) — **WORKS**

**Token** `POST https://login.uber.com/oauth/v2/token` — `grant_type=client_credentials`, client
id/secret *(redacted)*. **TTL 30 days.** Scopes: metrics.read, drivers.status.read, payments,
organizations.read, vehicles.read/write/assignment, reports.
**Base** `https://api.uber.com` — most calls take `?org_id=<encrypted org id>`.

| Endpoint | Data |
|---|---|
| `GET /v1/vehicle-suppliers/orgs` | Org list (id, name, types) |
| `GET /v1/vehicle-suppliers/drivers?org_id=…&include_assigned_vehicles=true` | **113 drivers** — `driverId`, `firstName`, `lastName`, `email`, `phoneNumber`, assigned vehicles; paginated (`nextPageToken`) |
| `GET /v1/vehicle-suppliers/drivers/actions?org_id=…` | **Live driver status** — `DRIVER_STATUS_ONLINE / ONTRIP / OFFLINE` + timestamp, `onboardingStatus`, plate |
| `GET /v2/vehicle-suppliers/vehicles?org_id=…` | **98 vehicles** — `vehicleId`, `make`, `model`, `year`, `vin`, `licensePlate`, `color` (10/page) |
| `GET /v1/vehicle-suppliers/earners/payments?org_id=…&start_time=&end_time=` | Per-driver earnings breakdown — `earnings`→`net_fare`/`tip`/`taxes`, reimbursements (AED, `amountE5` = ×10⁵) |
| `POST /v1/vehicle-suppliers/transactions?org_id=…` | **Live transaction feed** (window ≤ **15 min**) — per-trip `transactionUuid`, `tripUuid`, `processedAt`, earnings breakdown |
| `POST /v1/vehicle-suppliers/analytics-data/query` | Per-driver report — dims `vs:driver`, metrics `vs:HoursOnline`, `vs:HoursOnTrip`, `vs:TotalTrips` (range ≤ **8 days**) |

_Live-status sample (50 drivers): 15 online, 1 on-trip, 10 offline. Onboarding: 38 active, 9 waitlisted, 2 rejected, 1 accepted._

### 4b. Supplier web GraphQL — **WORKS (browser session)**

**Endpoint** `POST https://fleethub.uber.com/graphql`
_(Was `supplier.uber.com`. Uber renamed the portal; every path 301s to the new host, verified
2026-09-01. The redirect is not a safe fallback — a 301 turns the POST into a GET, the GET is not
signed in, and the login page comes back as HTML under a **200**, which reads as an empty result
rather than a refusal. Call the new host directly.)_
**Auth** browser cookies (`sid` / `csid`; `sp-jwt-session` was already stale yet the session held via
`sid`/`csid`) + header `x-csrf-token: x`. **Will expire** — needs a periodic fresh login, and the
cookie must be copied from a `fleethub.uber.com` page: values still sitting under the old
`supplier.uber.com` origin are the expired ones.
`orgUUID` (plaintext) = `58ca3b81-…` (the account/supplier uuid).

Confirmed net-new data vs the OAuth layer:

- **`getPerformanceReport`** — full per-driver scorecard (50 drivers returned): `totalEarnings` (AED),
  `cashEarnings`, `earningsPerHour`, `tripsPerOnlineHour`, `hoursOnline`, `hoursOnJob`, `hoursOnTrip`,
  `hoursAvailableForTrip`, `totalTrips`, **`driverAcceptanceRate`**, **`driverCancellationRate`**,
  `firstOnlineTime`/`lastOnlineTime`, `firstTripTime`/`lastTripTime`.
- **`getLivemapSupply`** — resolves a driver↔vehicle pairing (name, plate). **No GPS coordinates**
  (the type has no location/lat-lng field; introspection disabled).
- Also in the collection (accessible via this session): `getLedger`, `getEarnerBreakdownsV2`,
  `getDriverEvents`, `getDriverInvites`, `getBalance`, `getSupplierBreakdown`, `payments/settlement`,
  `getRecommendations`, report download (`GenerateReport`/`DownloadReport`).

**Unique value:** live online/on-trip **status**, live per-trip transaction feed, and rich driver
performance + earnings scorecards. **Uber does not give raw GPS** through these endpoints.

---

## 5. Yango — ECOSINE park

**Park** `a23aade0e2ac4f93a2f5d4b51ef1478b` = **ECOSINE TRANSPORTS LLC** (Dubai; operator "SALMAN OMAR").
**Base** `https://fleet.yango.com`
**Auth** header `X-Park-Id` + **Yandex session cookie** (`Session_id`/`sessionid2`); some routes also
send `X-API-Key`. Cookie session **will expire** — needs periodic refresh.

| Endpoint (POST unless noted) | Data |
|---|---|
| `GET /api/fleet/ui/v1/parks/users/profile` | Park identity + menu/permissions |
| `/api/fleet/vehicles-manager/v1/vehicles/list` | **104 vehicles** (cursor paginated) |
| `/api/fleet/contractor-profiles-manager/v2/contractors/list` | Drivers + **live status** |
| `/api/reports-api/v1/orders/list` | **Trips** with full fare breakdown |
| `/api/fleet/fleet-reports/v1/dashboard/widget/cars/statuses` | Active-cars time series |
| `/api/fleet/fleet-reports/v1/summary/cars/finance/list` | Per-car rent income / expenses / profit |
| (collection also has) payouts, park transactions, quality/rating list, work-rules | Finance + quality |

**`vehicles/list`** `cars[]` — `id`, `number`/`normalized_number` (plate), `brand`, `model`, `year`,
`color`/`color_name`, `vin`, `callsign`, `category` (e.g. `comfort`), `amenities`, `status`
(`working`/Active), `permit_num`, `rental`, `created_date`/`modified_date`, `vehicle_owner_confirmation_status`.

**`contractors/list`** (drivers) — `id`, `full_name`, `name`{first,last}, `phone`, **`status`**
(`online`/`busy`/`offline`), `balance`, `orders_count`, `last_order_date`, `hiring_segment`,
`lifecycle_step`, `license_with_metadata`, `avatar_url`. _Snapshot (100 drivers): 3 online, 2 busy, 95 offline._

**`orders/list`** (trips) fields — `id`, `short_id`, `status` (`complete`/`cancelled`),
`booked_at`/`ended_at`, `address_from`, `address_to`, `driver_id`, `driver_full_name`, `car_id`,
`car_brand_model`, `car_license_number`, `category`, `mileage`, `payment_method` (`cash`/`cashless`),
`currency_code`, `cancellation_description`, and a full fare split: `price`, `price_cash`, `price_card`,
`price_bonus`, `price_tip`, `price_promotion`, `price_corporate`, `price_commission_park`,
`price_commission_service`, `price_mandatory_taxes_fee`, `price_partner_cashless`, `price_partner_rides`,
`price_platform_cash_collection`, `price_contractor_balance_topup`, `price_other`.
_Low volume for this fleet: 14 completed orders in Aug 14–21._

**Unique value:** trips with **pickup/dropoff addresses + granular fare economics** and live
driver status. No raw GPS-coordinate endpoint in the provided collection.

---

## 6. What's blocked / needs you

| Item | Why | To unblock |
|---|---|---|
| **Bolt Fleet Owner Portal** (trips, earnings, payouts, invoices, engagement — both fleets) | Refresh token expired 2026-08-20 | Log into Bolt fleet owner portal, capture a fresh refresh token |
| **Bolt official API for Ecosine** | Client `142897` not authorised for `142868` | Register/authorise Ecosine's company on that Bolt integration client |
| **CABMAN for Egari** | Only Ecosine creds provided | Provide Egari's CABMAN `InterfaceUserName`/`Password` |
| **Uber web GraphQL / Yango** longevity | Cookie sessions | Will need periodic re-login for a persistent dashboard |
| **FMS geofence / canbus / status-list variants** | auth/param specifics | Confirm `GetGeofenceInfo` auth + `GetVehicleStatusList.listtype` enum with the vendor |

## 7. Recommended data model for the dashboard

- **Live map & vehicle health** → CABMAN + FMS (`GetVehicleCurrentDetails`/`GetVehicleStatus`) — the
  only sources of lat/lng, speed, ignition, fuel/AC, seat occupancy. Poll on an interval.
- **Fleet KPI tiles** → FMS `GetVehicleStats` (moving/idle/stopped/inactive) per fleet.
- **Trip history / utilisation** → FMS `GetTripPassenger` (both fleets, hardware-truth) + platform
  trips (Yango `orders/list`; Bolt portal `orderHistory`; Uber transactions/analytics).
- **Driver behaviour / safety** → FMS `GetAlertData` (+ dashcam links).
- **Driver roster & live status** → Uber `drivers/actions`, Yango `contractors/list`, Bolt `getDrivers`.
- **Earnings / finance** → Uber payments + performance report; Yango finance + order fare split;
  Bolt portal earnings (once unblocked).

_All raw JSON captures from this run are in the session scratchpad (not committed)._
