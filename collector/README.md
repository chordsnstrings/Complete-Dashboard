# Fleet Collector Agents

Automated collectors that **backfill a full operational year** and then **keep the data fresh** for the
Ecosine / Egari analytics dashboard. Node + Postgres, containerized. One agent per source, all
normalized on **license plate** so a driver/vehicle rolls up across every platform.

## What each source gives (tested 2026-08-21)

| Source | Fleets | History | Pull mechanism | Limits |
|---|---|---|---|---|
| **FMS/InfoTrack** | Ecosine + Egari | ≥12 months | `GetTripPassenger` + `GetAlertData`, monthly chunks | 31-day max range |
| **Uber** | Ecosine | ~12 months | report pipeline → CSV (`GenerateReport`→poll→`DownloadReport`) | 31-day range · **3 concurrent** · async |
| **Yango** | Ecosine | ≥12 months | `orders/list` cursor pages + driver summary + ledger | 40 rows/page |
| **CABMAN/DT** | Ecosine | realtime only | poll `GetIVDData`, append snapshots | no history param |
| **Bolt** | Egari (roster) | portal blocked | FI API roster; portal trips/earnings need a fresh refresh token | ~7-day token |

## Run

```bash
cp .env.example .env      # fill in credentials
docker compose up -d db
docker compose run --rm collector node src/index.js backfill   # one-off: pull the last 12 months
docker compose up -d collector api                             # scheduler + read API on :8080
```

Local (no Docker): `npm install && npm run migrate && npm run backfill && npm start` (needs a Postgres in `.env`).

## How it stays up to date

- **backfill** (once): walks back `BACKFILL_MONTHS` months per source.
- **scheduler** (container default):
  - **CABMAN every 5 minutes** (`CABMAN_CRON=*/5 * * * *`) — pulls `GetIVDData` and saves each snapshot
    to `telemetry_snapshot`. `polled_at` advances every poll (so "last seen" is never >5 min stale),
    while position rows dedupe on the device fix time so idle vehicles don't create fake movement.
  - Uber/FMS live status every `LIVE_STATUS_SECONDS` (default 120s).
  - a cron **incremental** every 30 min re-pulls the trailing `INCREMENTAL_DAYS` of trips/earnings.
- All writes are **idempotent upserts** keyed on the source's natural id (Uber Trip UUID, Yango order
  id, FMS `plate|start`, CABMAN `plate|fix-time`), so re-runs never duplicate.

## The supervisory ("AI agent") layer — where an LLM earns its place

Bulk ETL is deterministic (the code above). An LLM agent is worth adding for the judgment calls:
- **Re-auth**: Uber-web and Yango ride on browser cookies that expire; Bolt's refresh token lasts ~7
  days. A supervisor watches for 401/redirect/`REFRESH_TOKEN_INVALID` in `collection_run.error` and
  drives re-login / re-capture.
- **Schema drift**: alert when a source adds/renames fields (the `raw` JSONB preserves everything).
- **Anomaly digests**: summarize sudden drops in trips/earnings or spikes in cancellations/alerts.

## Store

See `sql/schema.sql`. Facts: `trip`, `driver_performance`, `ledger_entry`, `alert`,
`telemetry_snapshot`. Dimensions: `vehicle`, `driver` (+ `driver_platform_id`). Bookkeeping:
`collection_run`, `source_state`. The read API (`api/server.js`) serves the dashboard:
`/api/kpis`, `/api/trips/daily`, `/api/trips/hourly`, `/api/mix`, `/api/drivers/leaderboard`,
`/api/platforms`, `/api/live`.

## Security

No secrets in the repo. All credentials come from `.env` / container secrets. Rotate anything shared
in plaintext. `.env` is gitignored.
