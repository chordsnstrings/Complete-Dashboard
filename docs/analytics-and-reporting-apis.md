# Analytics, Reporting & Payments — deep API layer

> Second-pass reconnaissance focused on **driver performance, historical reporting, and payments**
> across Uber, Yango and Bolt — the data that feeds an analysis dashboard. Everything below was
> tested live on **2026-08-21**. Complements `fleet-tracking-api-reference.md`.

## 1. Uber — historical report pipeline (this is the "full year of data" path)

Async generate → poll download → signed CSV. Auth = Uber supplier **web session** (cookies + `x-csrf-token: x`).
Base `https://supplier.uber.com`. Org (plaintext) `58ca3b81-4953-4793-9f56-d93e16f771bb`.

**Step 1 — generate** `POST /api/vs-sp-reports-management/GenerateReport?localeCode=en-GB`
```json
{"orgId":{"uuid":{"value":"<ORG>"}},"reportType":"REPORT_TYPE_TRIP_ACTIVITY",
 "startDate":{"value":"2026-08-10"},"endDate":{"value":"2026-08-16"},
 "unixTimeRangeOverride":{"startTimeUnixMillis":{"value":"…"},"endTimeUnixMillis":{"value":"…"}},
 "childOrgUuids":[{"uuid":{"value":"<ORG>"}}]}
```
→ `{status:"success", data:{reportId:{uuid:{value:"…"}}}}`

**Step 2 — download** `POST /api/vs-sp-reports-management/DownloadReport?localeCode=en-GB`
`{"orgId":{…},"reportId":{"uuid":{"value":"<reportId>"}}}` → `{data:{signedUrl:{value:"https://tbs-static.uber.com/…csv"}}}`

| Report type | Grain | Columns |
|---|---|---|
| `REPORT_TYPE_TRIP_ACTIVITY` | **one row per trip** | Trip UUID · Driver UUID · Driver first/surname · Vehicle UUID · Number plate · Service type · Trip request time · Trip drop-off time · Pick-up address · Drop-off address · Trip distance · Trip status · Product type · Payment type |
| `REPORT_TYPE_DRIVER_ACTIVITY` | one row per driver | Driver UUID · first/surname · Trips completed · Time online · Time on trip |

**Range cap:** ~**31 days per request** (`max number days range exceeded` beyond that). A **full year =
12 monthly calls**, concatenated. Invalid type names return `REPORT_TYPE_INVALID`; only the two above are valid.
A single week (Aug 10–16) returned **1,922 trip rows** across 56 drivers / 52 plates.

There is also a GraphQL variant: mutation `GenerateVsPaymentReport` (`REPORT_TYPE_DRIVER_ACTIVITY`) → `reportID`,
then query `downloadVsPaymentReport` → `signedURL`.

## 2. Uber — GraphQL analytics access matrix (web session role)

| Operation | Access | Data |
|---|---|---|
| `getPerformanceMetrics` | ✅ | **Org KPIs:** supplyHours, totalVehiclesOnline, totalEarnings (AED), totalTrips, acceptanceRate, cancellationRate |
| `getBalance` | ✅ | Org balance (AED), amount owed by drivers |
| `getPerformanceReport` (`vs:driver`/`vs:vehicle`) | ✅ | **Driver scorecard:** totalEarnings, cashEarnings, earningsPerHour, tripsPerOnlineHour, hoursOnline/onJob/onTrip, totalTrips, **acceptanceRate**, **cancellationRate**, first/last online & trip |
| `getEarnerBreakdownsV2` | ✅ | Per-driver: name, trip count, distance (km), netOutstanding (AED) + earnings category tree |
| `getLivemapSupply` | ✅ | Driver↔vehicle pairing (no GPS) |
| `getLedger` | ⛔ PERMISSION_DENIED | (detailed transaction ledger) |
| `getSupplierBreakdown`, `GetEarnerBreakdowns` (v1) | ⛔ PERMISSION_DENIED | — |
| `GetDriver`, `getFleetDrivers`, `GetOrganizationTasks` | ⛔ UNAUTHENTICATED | — |

**OAuth REST layer** (30-day token) also gives: `analytics-data/query` (per-driver `vs:HoursOnline`,
`vs:HoursOnTrip`, `vs:TotalTrips`, ≤8-day window), `earners/payments` (per-driver earnings breakdown),
`transactions` (live 15-min trip-transaction feed), `drivers/actions` (live online/on-trip/offline).

## 3. Yango — analytics, quality & payments

Base `https://fleet.yango.com`, `X-Park-Id` + Yandex cookie. All confirmed live.

| Endpoint | Data |
|---|---|
| `POST /api/reports-api/v2/summary/drivers/list` | **Driver performance table** + fleet totals |
| `POST /api/reports-api/v1/quality/list` | **Driver quality/safety** report |
| `POST /api/fleet/fleet-reports/v1/dashboard/widget/cars/{metric}` | Time-series widgets |
| `POST /api/fleet/fleet-reports/v1/summary/cars/finance/list` | Per-car rent income / expenses / profit |
| `POST /api/v1/reports/transactions/park/list` | **Payment/transaction ledger** |
| `POST /api/fleet/transactions/v1/parks/categories/list` | 87 transaction categories |
| `POST /api/fleet/fleet-payouts-web/v2/payouts/list` + `contracts/general`,`contracts/summary`,`payouts/statuses` | **Payouts** (bank payments, agreements) |

**`summary/drivers/list`** per driver — `driver{id,first_name,last_name,work_rule_id}`, `car.callsign` (plate),
`count_orders_completed / all / platform / accepted / cancelled_by_driver / cancelled_by_client`,
`work_time_seconds`, `price_cash`, `price_cashless`, `price_platform_commission`, `price_park_commission`,
`sum_distance`, `trips_per_hour`; fleet totals add `acceptance_rate`, `completion_rate`, `count_active_drivers`.

**`quality/list`** per driver — `rating_start`, `rating_end`, `rating_trend`, `trips`, `perfect_trips(%)`,
`bad_rated_trips(%)`, `cancel_orders(%)`, `main_complaints[]`, `our_observation[]` (e.g. "Reckless driving").

Dashboard-widget metrics available: `hours-online`, `acceptance-rate`, `expenses`, `profit`, `mileage`,
`trips`, `rent-income`, `summary` (online/offline/total).

**`transactions/park/list`** per row — `id`, `event_at`, `category_id` (e.g. `platform_reposition_fee`),
`amount`, `currency_code`, `description`, `order_id`, `short_order_id`, `driver_id`, `driver_name`, `created_by`.

## 4. Bolt — payments / performance

- **Official FI API (Egari):** roster + compliance only — no earnings/trips endpoint.
- **Fleet Owner Portal (both companies, ⛔ token expired 2026-08-20):** this is Bolt's analytics home —
  `getDriverEngagementData/dateRange` (per-driver performance), `orderHistory/getTable` + `getCsv` (trips),
  `getCompanyEarnings/recent`, `getDriverEarnings/recent` + `driverEarnings/getCsv`, `getFleetBalanceDetails`,
  `getPayouts`, `getRiderInvoices`, `getTaxifyInvoices`. **Refresh the token to unlock.**

## 5. Cross-platform driver-performance model (the analysis dashboard core)

Join key = **license plate** (normalise `L 18379`→`L18379`) and/or driver name. Per driver, per platform:

| Metric | Uber | Yango | Bolt |
|---|---|---|---|
| Trips | trip-activity report / analytics | `count_orders_completed` | portal (blocked) |
| Online / on-trip hours | driver-activity report / `getPerformanceReport` | `work_time_seconds` | `getDriverEngagementData` |
| Acceptance / cancellation rate | `getPerformanceReport` | `acceptance_rate` / cancels | portal |
| Earnings (AED) | `getEarnerBreakdownsV2` / payments | `price_cash`+`price_cashless` | portal |
| Rating / quality | — | `quality/list` | `driver_rating` (FI) |
| Distance | trip report / breakdowns | `sum_distance` | — |
| Payment mix | trip report `Payment type` | transaction ledger | portal |

**Sample real aggregates** (Uber, one week Aug 14–20): ~1,900 trips, 23,120 km, avg 12.0 km/trip,
demand peaks 17:00, product mix Electric 47% / UberX 38% / Comfort 8% / Black 7%, cash still ~19% of trips,
rider-cancellation ~11%. Org KPIs: 403 trips/day-equiv, 43 vehicles online, 99.1% acceptance, AED 17.5k earnings.
