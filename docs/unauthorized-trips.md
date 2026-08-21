# Unauthorized trips — detection model

> A vehicle carried a passenger (seat sensor occupied, vehicle moved) but **no booking exists on any
> revenue channel** — Uber, Yango, Bolt, or the hotel platform. That gap is revenue leakage, private
> use of a company car, or an off-book cash job. This document defines how we detect it without
> drowning in false positives from hardware quirks.

## The signals we actually have (verified)

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

We therefore build an **occupancy segment** from consecutive 5-minute samples where the seat is
occupied, and only treat it as a *trip* when it clears movement thresholds:

- duration **≥ 5 minutes** (at least two consecutive polls)
- distance travelled **≥ 1.0 km** (straight-line displacement or odometer delta)
- at least one fix with **speed ≥ 5 km/h**

Anything failing these is "occupied but stationary" — a driver sitting in the car, a bag on the seat,
someone waiting — and is **not** reported as a trip.

## How hardware misbehaves, and how we absorb it

Seat sensors are pressure/weight pads. Real-world failure modes and our handling:

| Failure mode | What it looks like | Handling |
|---|---|---|
| **Flicker / chatter** | seat toggles occupied→empty→occupied between polls | **Gap-bridging**: two occupancy runs separated by ≤ 10 min (2 polls) merge into one segment |
| **Brief false trigger** | a single poll occupied, vehicle stationary | Discarded by the ≥5 min + ≥1 km + speed thresholds |
| **Stuck-on sensor** | seat reads occupied continuously for hours including while parked, ignition off | Segments longer than **8 hours**, or with ignition off for most fixes, are flagged `sensor_suspect` and excluded from leakage totals |
| **Bag / object on seat** | occupied while parked, no movement | Fails movement thresholds |
| **Stuck-off / dead sensor** | vehicle is `Engaged` with bookings but seat never registers | Vehicle-level health: a vehicle with booked trips but **zero** seat-occupied minutes over a week is flagged `sensor_dead` — its unauthorized-trip numbers are marked unreliable rather than "clean" |
| **Telemetry gaps** | no CABMAN fixes for a period (outage, device offline) | Segments touching a gap > 15 min are marked `partial` and reported separately — we cannot claim a trip was unauthorized if we couldn't see it |

**Timelapses in between** are handled explicitly: because polling is every 5 minutes, we only trust a
segment when its fixes are contiguous at ≤ 10-minute spacing. Longer holes split the segment and mark
it `partial`.

## Matching a segment to a booking

A segment is **authorized** if any booking overlaps it on the same vehicle:

- same normalized **plate** (`L 18379` / `L-46185` → `L18379`, `L46185`)
- booking time window overlaps the segment window with a **±15 minute tolerance** on each side
  (app timestamps and device clocks drift; drivers start jobs late)

Sources checked, in order: **hotel → uber → yango → bolt → fms**. FMS `GetTripPassenger` is included
because it is hardware-truth from the same telematics vendor and carries its own `Seat Count`.

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

## Caveats worth stating plainly

- Detection quality depends on CABMAN coverage; today CABMAN credentials exist for **Ecosine only**,
  so Egari has no seat-sensor layer until DT credentials are supplied.
- Because CABMAN has **no historical endpoint**, unauthorized-trip analysis only covers the period
  since the collector started capturing 5-minute snapshots. It gets better every day it runs.
- A booking that exists only in a channel we cannot read (e.g. Bolt while its portal token is expired)
  will look unauthorized. The engine therefore records which sources were *healthy* for the window and
  labels results `low_confidence` when a revenue channel was unavailable.
