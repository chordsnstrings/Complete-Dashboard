# Unauthorized trips — detection model

> A vehicle carried a passenger (seat sensor occupied, vehicle moved) but **no booking exists on any
> revenue channel** — Uber, Yango, Bolt, or the hotel platform. That gap is revenue leakage, private
> use of a company car, or an off-book cash job. This document defines how we detect it without
> drowning in false positives from hardware quirks.

## The signals we actually have (verified)

Two seat-sensor providers, three sources of occupancy segments (the operator's rulings of
2026-09-23: "FMS and CABMAN is two separate providers … add FMS as well"; FMS's Seat Count
counts **passengers**, and 1 or more means passengers were aboard). Each segment carries its
source in `occupancy_segment.source` and is shown with that provider's name and timestamps.

| Source | Provider | What it is | Reaches back |
|---|---|---|---|
| `cabman` — "CABMAN DT" | CABMAN DT `GetIVDData` | seat pad occupied/empty on 5-minute fixes | live poll only, from 2026-08-21; **Ecosine only** |
| `fms_live` — "FMS live seat count" | FMS `GetVehicleCurrentDetails` `Seatcount` (schema_v84) | live passenger count, asked every 2 min; stored fixes advance about every 6 min | from 2026-09-23; both fleets |
| `fms_trip` — "FMS trip seat count" | FMS `GetTripPassenger` `Seat Count` → `trip.seat_count` | one journey, start/end/distance, with a passenger count | about two years (from 2024-09-30); both fleets |

Egari has no CABMAN DT account; it is covered by FMS.

CABMAN `GetIVDData` gives, per vehicle, every 5 minutes:

| Field | Meaning |
|---|---|
| `SeatSensorValue` / `SeatSensorStatus` | `1`/`Active` = weight on the passenger seat |
| `Status` | `Engaged` (dispatch thinks it's on a job) vs `Active` (available) |
| `speed`, `lat`/`lng`, `odometer`, `state` (ignition) | movement evidence |

**Crucially, `Status` and `SeatSensorValue` are independent signals.** A live snapshot of 48 vehicles showed:

- 42 `Active` + seat empty (idle, as expected)
- 6 seat-occupied, of which **3 were `Active`, not `Engaged`** — carrying someone while dispatch shows free
- **2 `Engaged` with an empty seat** — dispatch job with no weight detected

So neither field alone is truth. The seat sensor tells us *a person is aboard*; the booking systems
tell us *whether that person was sold a ride*.

## What a real passenger trip looks like

A genuine occupied trip has a recognisable shape in the 5-minute telemetry:

1. Seat goes occupied while the vehicle is **stationary** (pickup).
2. Ignition on, vehicle **moves** — a run of fixes with `speed > 0` and rising `odometer`.
3. Meaningful **displacement** between first and last fix (not circling a car park).
4. Seat goes empty while stationary (drop-off).

We therefore build an **occupancy segment** from consecutive samples where the seat is occupied
(CABMAN DT's pad; FMS's live count read as occupied when it is 1 or more — in memory only, never
written to `seat_occupied`), and only treat it as a *trip* when it clears movement thresholds:

- duration **≥ 5 minutes** (at least two consecutive polls)
- distance travelled **≥ 1.0 km** (straight-line displacement or odometer delta)
- at least one fix with **speed ≥ 5 km/h**

Anything failing these is "occupied but stationary" — a driver sitting in the car, a bag on the seat,
someone waiting — and is **not** reported as a trip.

An **FMS journey** with a Seat Count of 1 or more *is* a segment: FMS's own start, end, distance and
passenger count, not built from samples. It is classified with what a journey carries:

- **stationary** when shorter than 5 minutes, under 1 km, or averaging under 5 km/h — a journey
  carries no top speed, and its average speed is a floor on it;
- **sensor_suspect** when longer than **8 hours** (the same rule);
- **never `partial`** — a journey is a complete record; its ends are FMS's, not the edge of a poll;
- **unverifiable** only when FMS filed it with no end time or no usable distance (none in 3,000
  sampled on 2026-09-23).

FMS files a *provisional* record of a journey within minutes and re-files the same ride hours later
with its true start and a decimal distance, and both rows stay in `trip` (keyed plate + start). Journeys
on one car that overlap in time are therefore one ride, and its segment is built from the record FMS
filed last. See docs/COVERAGE.md, "FMS files each journey twice".

## How hardware misbehaves, and how we absorb it

Seat sensors are pressure/weight pads. Real-world failure modes and our handling:

| Failure mode | What it looks like | Handling |
|---|---|---|
| **Flicker / chatter** | seat toggles occupied→empty→occupied between polls | **Gap-bridging**: two occupancy runs separated by ≤ 10 min (2 polls) merge into one segment |
| **Brief false trigger** | a single poll occupied, vehicle stationary | Discarded by the ≥5 min + ≥1 km + speed thresholds |
| **Stuck-on sensor** | seat reads occupied continuously for hours including while parked, ignition off | Segments longer than **8 hours**, or with ignition off for most fixes, are flagged `sensor_suspect` and excluded from leakage totals |
| **Bag / object on seat** | occupied while parked, no movement | Fails movement thresholds |
| **Stuck-off / dead sensor** | the car carries bookings but the seat reading never registers | Sensor health per provider (`/api/sensor-health`): **CABMAN DT** — at least 20 fixes and none occupied; **FMS live** — FMS reported a live seat count and the car carried bookings, but the count never reached 1; **FMS trip** — FMS tracked the car (live fixes) and it carried bookings, but FMS filed no journey with a seat count (FMS never reports 0 on a journey, so "never occupied" cannot be the FMS test). Each row states its reason. |
| **Telemetry gaps** | no fixes from a sampled source for a period (outage, device offline) | Segments touching a gap > 15 min are marked `partial` and reported separately — we cannot claim a trip was unauthorized if we couldn't see it. Does not apply to FMS journeys. |

**Timelapses in between** are handled explicitly: because CABMAN DT polls every 5 minutes (and FMS's
stored live fixes advance about every 6), we only trust a sampled segment when its fixes are
contiguous at ≤ 10-minute spacing. Longer holes split the segment and mark it `partial`. The same
thresholds apply to both sampled sources; none was adjusted for FMS (see src/reconcile.js
`fmsLiveFixes`, which states the measurement).

## Matching a segment to a booking

A segment is **authorized** if any booking overlaps it on the same vehicle:

- same normalized **plate** (`L 18379` / `L-46185` → `L18379`, `L46185`)
- booking time window overlaps the segment window with a **±15 minute tolerance** on each side
  (app timestamps and device clocks drift; drivers start jobs late)

Booking sources checked: **hotel, uber, yango, bolt** — every channel that has ever produced a
booking on this fleet (`trip_norm.is_booking`). **FMS is never a booking source.** Its journeys are
built from the same telematics as the segments, so matching a segment against one is circular — every
real journey has an FMS row and the detector would report nothing — and an FMS journey judged against
an FMS "booking" would authorize itself. `is_booking` is false for FMS (sql/schema_v18.sql), and
`blockingChannels()`/`channels_checked` exclude it. FMS is only ever what is judged, never what
authorizes. Every source's segments are matched by the same code (`judgeSegment()`).

Classification per segment:

| Verdict | Meaning |
|---|---|
| `authorized` | overlapping booking found (records which platform) |
| `unauthorized` | movement thresholds met, no booking on any channel, sensor healthy, coverage complete |
| `sensor_suspect` | implausibly long or ignition-off occupancy — likely a stuck sensor |
| `partial` | telemetry gap inside the window — cannot conclude |
| `stationary` | occupied but never really moved (not a trip) |

Only `unauthorized` counts as leakage. The others are surfaced separately so the fleet manager can
see *why* something was excluded, and so a failing sensor gets fixed rather than silently hiding trips.

## One ride, several segments — counted once

Every segment is kept, each with its source and its own timestamps: from 2026-09-23 one ride on an FMS
car is normally two segments (FMS's live count and FMS's journey), and on the two cars that carry both
trackers (L44251, L45243) it can be three. Lists show every one. **Totals count a ride once**:

> Where segments from different providers on the same car overlap in time and reached the same
> verdict, they are one ride: it is counted once, by the first of them in the order FMS trip seat
> count, CABMAN DT, FMS live seat count, and its distance is that segment's distance. Each provider's
> own figures count every segment it produced, so the providers' figures can add up to more than the
> combined one.

The rule lives in `api/occupancy_sql.js` (`occCountsOnce`), and every page that shows a combined total
shows the per-provider figures and this sentence beside it.

## Caveats worth stating plainly

- Coverage differs per provider. CABMAN DT credentials exist for **Ecosine only**; Egari is covered
  by FMS (live seat count and journeys), and so is most of Ecosine.
- CABMAN DT and FMS's live seat count have **no historical endpoint**: they cover only the period since
  the collector began capturing them (2026-08-21 and 2026-09-23). FMS journeys reach back about two
  years, but a window is judged only when the reconciler runs over it — the half-hourly incremental
  covers three days, the nightly catch-up thirty, the weekly backfill its configured months.
- On the two cars with both trackers the CABMAN and FMS devices report positions a median 12.7 and
  25.6 km apart at the same minute (docs/COVERAGE.md), so a CABMAN device may be filed under the wrong
  plate. Both providers' segments are kept as the operator ruled; the combined count treats their
  overlapping segments as one ride.
- A booking that exists only in a channel we cannot read (e.g. Bolt while its portal token is expired)
  will look unauthorized. The engine therefore records which sources were *healthy* for the window and
  labels results `low_confidence` when a revenue channel was unavailable.
