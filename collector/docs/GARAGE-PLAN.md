# Vehicles off the road, and garage management — audit and plan

2026-10-14. **Nothing here is built.** The operator asked: *"the vehicle
section needs work. let's audit and understand what granular level data we can
get from the vehicle data that is available in the system and what views we can
create for the team. A lot of vehicles can stay in garage, which is out of
sanction for the day. Garage management can be a key to operations - and what
work is being done, and when it is back to work. Audit, research and report.
don't code yet."* Then, while the audit ran:

- "none of the platforms has it. it will be here. And we have specific garages
  that we send the vehicles to. these might require human inputs."
- "this garage changes but going forward there should be an option for garage
  management where they can input these data"
- "the cost in details for what work has been done so that we can see which
  cars are going for the same work mulitple times"

How it was measured: four independent strands (what each provider offers,
production's own data for the 30 Dubai days 2026-09-14..10-13, the vehicle pages
as deployed, and garage-management practice), the first two each re-derived by
a separate skeptic. Only what survived the skeptics is stated below; where a
skeptic corrected a figure, the corrected figure is the one given. Everything
was read through production's anonymous read API — no provider was called.
Measurements that belong to a provider are in `COVERAGE.md` ("Vehicles off the
road — what the data says, measured 2026-10-14"); defects in the current pages
are in `FIXLIST-2026-09-05.md` ("The vehicle pages and the idle-car rules —
found 2026-10-14").

## The answer in one paragraph

No provider records a garage visit, a repair, a reason, a cost or an expected
return, and none ever will for this fleet — so, as the operator said, it has to
be entered here. What the data CAN do is two things a form cannot: say every
day which cars did not work and where their trackers last put them, and catch
the visits nobody entered. The plan is a team-managed garage register, a visit
(job card) per car per trip to a garage with itemised work lines from a fixed
list, a daily "off the road" board that merges what was entered with what the
trackers saw, and a repeat-work view that the fixed list makes possible.

## What the data says today

**The fleet.** 139 cars carry a VIN (138 on 2026-09-07; one added since): 128
on Uber's active list, 11 inactive. On an average day of the window 92.2 of the
128 active cars took a booking (81–97); the idle share ran 24.2%–36.7%, mean
28.0%, Sundays the idlest. Bookings carry a plate 99.9% of the time (25,805 of
25,836), so "no booking on this car today" is real, not a plate gap.

**Two kinds of idle.** 21 Uber-active cars took no booking on any of the 30
days — 630 of the 1,075 idle active car-days. The rest is a rotation of about
15 cars a day, mostly one-day gaps. The 11 Uber-inactive cars took none either.
Idleness is concentrated in one make: 29 of the 31 cars with neither a booking
nor an FMS journey all window, and all 11 inactive cars, are Teslas (79 of the
139). (CABMAN writes no journeys, so a CABMAN car driven without a booking is
in those 31 too.)

**Where idle cars sit** (tracker positions; names are the gazetteer's street
names, never a business):

| place | what the data shows | what it might be |
|---|---|---|
| 26-28 Al Doha St (25.283, 55.351) | at least 15 Ecosine cars over the month, every one parked in every snapshot; CABMAN units there went dark Jul–Aug | a lay-up / storage yard |
| Production City, Plot C23 (25.035, 55.184) | 12–13 cars at 14:00 on three days, half or more of them working that day; cars were moved here before going back to work | a hub — and "Dubai Production City" is one of the operator's configured **charging sites** |
| 93 Manama St and 208 Ras Al Khor St | inside what the gazetteer calls Ras Al Khor Industrial Area; one car came back to work from here after ~11 months | a workshop street |
| Al Quoz Industrial Area 2 (25.135, 55.234) | one car spends every night here and every day at Plot C23 without a booking; another sat here a full day on its way between yards | a garage or staff base |
| Green Community Village (inside Dubai Investments Park) | one car two full days | unknown (BYD's and Lexus's service centres are in DIP) |

None of these is proven to be a garage. Cars also **move between yards with
no booking** (Al Doha St → Plot C23; Manama St → Al Quoz Ind. 2 → Plot C23) —
a measurable transfer the board should show.

**What the providers carry about a car's state** — and why none of it answers
the question:

| provider | field | state |
|---|---|---|
| Yango | car `status` — documents `repairing`, `not_working`, `no_driver` | collected every 30 min; **all 104 cars read `working`** — the team does not set it |
| Bolt | `getVehicles` state active / deactivated / suspended + reason | **never collected**; only each driver's active car is seen |
| Uber | vehicle compliance ACTIVE 128 / INACTIVE 11 | driven by ONE document, the Vehicle Registration Form; the 11 inactive are 11 EXPIRED registrations |
| FMS / InfoTrack | `GetVehicleStats` fleet counts incl. `outofservice` | **never collected**; what sets it is undocumented |
| FMS / InfoTrack | `GetGeofenceInfo` (a workshop geofence would be a direct signal) | answered "Authentication failed"; needs the vendor |
| FMS / InfoTrack | Odometer, DeviceOdometer, engine status (`GetVehicleCurrentDetails`, already polled every 2 min) | **only the seat count is kept**; raw `previousDistance` holds odometer-sized values on some cars, meaning undocumented |
| CABMAN | odometer, ignition, Active/Engaged on every fix | stored on every fix |
| Tesla | ServiceMode, service data | unreachable (the known Tesla access problem) |

Every vehicle status table (`vehicle_profile`, `vehicle_document`) is
overwritten in place, so even these flags have no history: the day a car went
inactive is lost on the next 30-minute poll. Drivers already have the pattern a
car needs — `driver_rating_history` keeps one row per day.

**Trackers say less than they seem to.** Many FMS units sleep when parked and
wake every few days for a handful of fixes (others report all day — it depends
on the unit); a point-in-time view saw 1–4 of the 13–15 cars standing at the
Al Doha St yard. Some trackers died while their car kept working (7 of the 15
cars dark all window). "Main Power Lost" alerts — 7,193 in 30 days on 12 cars,
mostly cars that work every day — are wiring faults, not a garage signal. A
parked FMS car can read "Moving" for 20 hours, and FMS rewrites a stored fix's
status later, so "inactive since" must be captured when it is seen.

**Dates that predict a day off the road.** Uber holds the registration expiry:
8 cars fall due within 7 days and 28 within 45. That is the only dated
document held — no insurance, no inspection, no service record.

**What a day off the road costs is not yet measured.** The product prices an
idle day at a configured AED 120 (`VEHICLE_DAY_COST_AED`), a setting, not a
measurement. Per-car-day fares exist on only 981 of the 2,765 working car-days
in the window, so they cannot stand in for a car's day; the honest figure is
the car's attributed payout per working day, which needs building.

## What has to be entered here

Why a car is off the road, which garage, what work, what it cost, when it is
expected back, and when it actually came back. No feed carries any of it.
Two things already in the product must meet the new record rather than repeat
it: the driver ledger's `damage` entry ("Repair cost or insurance excess charged
to the driver", `sql/schema_v78.sql:147`) and `traffic_fine` / `salik` — all
per driver with no plate, so a garage visit should LINK to a damage charge, never
re-enter its amount.

## The proposal

### 1. Garages — a list the team keeps

The garages change, so the list is the team's, not a setting:

- name, what it does (body/paint, mechanical, tyres, EV/battery, a make's
  authorised centre, general), contact person and number, notes;
- a **location**: a pin and a radius (default 150 m), so a tracker can be
  matched to it; several pins where one business has several sites;
- **retired, never deleted** — a garage no longer used keeps its past visits.

The four places above are offered as "confirm or dismiss" suggestions when the
list is first made, never filled in by themselves.

### 2. Work types — the fixed list that makes repeats findable

A list the team maintains, grouped (brakes, tyres and wheels, suspension and
steering, battery and charging, air conditioning, body and paint, glass,
electrical, scheduled service, inspection and registration, recall, other).
Each line on a visit picks one; free text sits beside it, never instead of it —
"changed pads" and "brake work" cannot be matched, "Brakes · front pads" can.

### 3. The garage visit — one per car per trip to a garage

| field | how it is filled |
|---|---|
| car | picked; the plate's make, fleet, current driver and the operations member responsible for it shown |
| driver | who was driving the car — suggested from the car's last booking before the visit, editable (operator, 2026-10-14) |
| garage | from the list |
| in | date and time; suggested from the tracker when the car entered the garage's area |
| maintenance or accident | one of the two, required — the operator's top level (2026-10-14); the work types sit beneath it, and an accident visit also needs the driver, the fault and the paperwork below |
| state | waiting for approval/paperwork → in repair → waiting for parts → ready for collection → back on the road (or written off); every change kept with who and when |
| accident paperwork | police report number, insurer, surveyor date, approval date — UAE Federal Traffic Law Art. 41 bars repairing accident damage without the authority's permission, so "waiting for paperwork" is its own state |
| fault (accidents) | at fault (red paper) · not at fault (green paper) · not yet decided — required on an accident visit (operator, 2026-10-14) |
| expected back | a date; changing it keeps the old one (slippage is a finding) |
| back | date and time; suggested when the car left the area / took its first booking |
| odometer in / out | from CABMAN where it reports one; typed otherwise |
| who brought it in, replacement car | optional |
| work lines | below |
| who pays | company · insurer · driver (links the driver's ledger `damage` entry) · warranty |
| attachments | invoice, job card, photos |

### 4. Work lines — the cost in detail

Each line: work type (from the list), description, parts AED, labour AED,
quantity, VAT, invoice number, warranty months/km. The visit's cost is the sum
of its lines, never typed separately. Lines above a threshold the Owner sets
need a second person to approve (the product's existing four-eyes pattern).

### 5. What the trackers add — suggestions, never records

The same rule the product already keeps for charging sites (COVERAGE: "the idle
hours at charging sites are not a charging record") applies here:

- **"At a garage, no visit open"** — a car whose positions sit inside a
  garage's area for over an hour with no open visit is listed for someone to
  confirm or dismiss. Charging sites are excluded.
- **"Visit open, car working"** — an open visit whose car has taken a booking or
  left the area for a day: "close it?"
- **"Off the road, no reason"** — every car with no booking for a day or more
  and no open visit, with its last position, the age of that position and the
  tracker's state (asleep, dead, none). This is the daily list that keeps the
  record honest.
- A **daily car-state row** per car (worked / moved without a booking / parked
  / dark / in garage), written once a day, so "since when" never depends on a
  provider flag that is overwritten.

## The views

1. **Off the road today** — the board. Every car not working today: in a
   garage (which, why, since, expected back, overdue in red), waiting on
   paperwork, idle with no reason, tracker dark. Days off road, and the
   suggestions above to clear. Desktop and phone.
2. **A visit** — the job card: entry form for the technician (phone-first), the
   state line, the work lines, the attachments, the history of changes.
3. **The car's repair history** — on the vehicle page beside its trips and
   earnings: every visit, every line, cost to date, days off road this month.
4. **Repeat work** — the same car, the same work type, again within a window
   the team sets (90 days, or a km gap where an odometer exists): each
   occurrence with garage, dates, odometer and cost. Also "comebacks": a car
   back at a garage within 30 days of leaving one.
5. **Cost** — per car (per month, per km, against what it earned), per work
   type, per garage, per make; who paid (company / insurer / driver).
6. **Garages** — each garage's cars now, visits, average turnaround, cost per
   visit, and how often its work comes back.
7. **Due soon** — registration expiries (8 within 7 days today), and per make
   the service that is actually due by distance or time: Tesla services "as
   needed", so only tyre rotation every 10,000 km; BYD 20,000 km or 12 months;
   Polestar 4 30,000 km or 24 months; Toyota/Lexus 10,000 km.

The figures these views carry: availability (cars working / cars on the
register), days off road per car, turnaround (in → back), repeat rate, planned
vs unplanned share, garage cost per car per month — all from the visit's
timestamps and lines, so none of them is a guess.

## Who does what (the existing roles)

- **Fleet technician** — opens and updates visits, adds work lines, confirms or
  dismisses tracker suggestions.
- **Operations manager** — the board, garages and work types lists, approves
  expected-back changes; sees cost.
- **Finance manager** — cost views; approves lines above the threshold; links
  driver damage charges.
- **Owner / Management** — everything; sets the approval threshold.
- Cost is a new access class (garage costs), so a role can see a car is in a
  garage without seeing what it cost.

## Fix first — the current pages say things that are not true

Before any of this is built, the vehicle pages' false statements should go
(details and line references in FIXLIST, "found 2026-10-14"): the #vehicles
headline counts 132 phantom plates (says 62% idle; the real figure so far this
month is 35 of 139); "Moved, no booking" reads 0 because CABMAN movement is invisible;
"Last trip: never" on cars with thousands of bookings; "Where it parks"
understates parked time about 13-fold; a car parked 47 days wears a green
ACTIVE pill; the compliance page says "expired 0" while Uber marks 11 cars
EXPIRED; the idle-car finding misses 15 of the 21 never-worked cars and flags a
car driven 26 of 30 days; the dormant finding flags working cars; the phone's
Fleet tab hides every idle car; the area names the API already computes are
never shown.

## Fitting it into the product (plan, 2026-10-14 — nothing built)

The operator: *"let's figure out how we will incorporate this into our fleet
ecosystem. audit, plan including UI and views. wait for execution command."*
The views, drawn on the consolidated history, are on the Garage Desk page
(claude.ai artifact, private); this section is the build's reference.

**Where it lives.**

| place | what changes |
|---|---|
| side menu | a new **Garage** section beside Fleet: Off the road · Visits · Repeat work · Garage costs · Garages · Cars & owners |
| `#vehicle/<plate>` | an eighth tab, **Garage** (`VEHICLE_TABS`, `api/public/vehicle.js:28`): every visit, line, cost, days off road; the Overview's first line carries the state |
| driver page | accidents the person was driving in, the fault, any damage charge; a day off explained by the car's visit |
| phone, Fleet tab | the board, "send to a garage", state changes (`TABS`, `api/public/m/screens.js:44`; the Fleet tab owns `fleet`, `vehicles`, `vehicle`) |
| To-do and Action list | the absence lines that say a workshop visit is recorded nowhere (`api/public/playbook.js:563`, `api/public/app.js:2875`, `api/public/driver.js:1629`) answer from the record; new items: overdue return, visit open while the car works, car with no responsible person, repeat within the window |
| morning email | an "Off the road" section; the `cars_idle` finding (`src/report_findings.js:260`) names the garage |
| Target pages | a car in a garage or out of service leaves that day's plan (ruling 13) |
| driver ledger | an at-fault accident may PROPOSE a `damage` entry (`sql/schema_v78.sql:146`); Finance commits it; the visit links to it |
| assistant | tools beside `find_car`/`whereabouts` in `api/agent_tools.js`: off the road, a car's garage history, repeat work, garage costs |
| Excel | a Garage workbook through `src/xlsx_write.js` |

**Access.** The roles exist (`api/public/access_model.js`); garage work adds a
class and capabilities, not roles. A new class **GAR — garage costs**, so a
dispatcher sees that a car is in a garage without seeing what it cost.
Capabilities: `garage.record` (open/update visits and states), `garage.cost`
(enter invoices and lines), `garage.assign` (set a car's responsible person),
`garage.list` (garages and work types), `garage.import` / `garage.import.commit`
(the history, four-eyes like `cash.import.commit`), `garage.charge` (propose a
damage charge; the commit is Finance's existing `cash.record`). Owner all;
Management sees all and assigns; Operations manager records, costs, assigns,
keeps the lists, proposes charges; Fleet technician records and costs; Finance
sees GAR and commits charges and the import; Safety sees visits and accidents;
Dispatcher sees state only.

**Stored** (new migrations only): `garage` (name, kind, contact, pins,
retired), `car_owner` (responsible `access_user`, effective-dated, never
overwritten), `garage_visit` (car, maintenance|accident, garage, reason,
driver, fault, police report, insurer, in / expected / back, state, who pays),
`garage_visit_event` (every state and expected-back change, who, when),
`garage_invoice` (unique per garage + number) and `garage_line` (work type,
description, parts, labour, quantity, VAT), `garage_attachment` (bytea keyed by
sha256, the `driver_ledger_receipt` pattern at `sql/schema_v78.sql:305`, which
allows images only and expires in 12 months — garage attachments take PDFs and
are kept five years, ruling 16), and `car_day_state` (one row per car per day).

**The history goes in through the existing import path**: parsed in the
browser, previewed, committed by a second person (`api/public/importsheet.js`,
`api/import_routes.js`, `api/public/approvals.js`). Imports are CSV today; the
consolidated workbook's Visits, Invoices and Invoice lines sheets export as CSV.

**Measured for the board, 2026-10-14** (fleet register read that morning):
48 of the 139 cars had no booking for two days or more (31 for 30+). For 12 of
them the history already holds a tow or a garage visit after the last booking
— the board can show those without anyone typing. The long-idle cars are real:
no bookings and parked trackers for months, and the log's tow rows ("Abu Hail
To Ras Al Khor") are idle cars being moved.

## Order of work, when the operator says go

1. The vehicle pages' false statements (FIXLIST, "found 2026-10-14").
2. The record: garages, cars & owners, visits with lines and states, the
   vehicle Garage tab, the phone screens, the access class and capabilities;
   then the history import, committed by a second person.
3. The board and the catch-up: `car_day_state`, Off the road, the suggestions,
   the To-do and Action list items, the morning email section.
4. Analysis and links: repeat work, costs, accidents on the driver page, the
   damage-charge proposal, the assistant's tools, the Excel workbook.
5. Due-soon and odometer — after the InfoTrack questions (below).

Each step: tests proved by revert, notes in the same commit, the full suite,
deploy, screenshots of production.

## The operator's rulings (2026-10-14)

1. **Staff enter; the system catches up.** The visit is typed by the team; the
   trackers and bookings only suggest (section 5).
2. **Work types are the operator's fifteen:** A/C & cooling; Suspension &
   steering; Tyres; Wheel/rim work; Alignment & balancing; Brakes; Battery &
   electrical; Programming & diagnostics; Body & paint; Glass/windows/mirrors;
   Engine/mechanical/drivetrain; Routine servicing; Recovery/towing; SRS/safety
   systems; Exterior/underbody components. **Lamps file under Exterior** — no
   sixteenth "Lights" type. This replaces the grouped list in section 2.
3. **Operations owns the view, car by car.** Every car in operation — the whole
   fleet — has one named operations member responsible for it. The car's record
   carries that name; the visit shows it.
4. **The driver driving the car belongs on the visit**, and on an accident visit
   **the fault** (see the visit table).
5. **"Out of service" is set by people**, never inferred from a provider flag.
6. **Bolt's vehicle state is not collected** ("Bolt has no updated database") —
   input 6 below is closed.
7. **Approvals wait.** Who approves a repeat within 30 days, and the amount
   above which a second person must approve, are not decided; nothing is built
   for them yet.
8. **No signed price lists** exist for the current garages.
9. **Every visit is maintenance or accident** — the top level, above the work
   types.
10. **Insurance excess is its own work type**, and always an accident.
11. **Al Muhandes R0392 and R0393 are separate purchases** (AED 12,495 each),
    not copies of CCF_000081 — all three count.
12. **The Sajdaf invoices the payment advice R0378 pays but the archive lacks**
    are unknown to the operator; R0378 stays out of spend and on the review list.
13. **Cars out of commission are not in the target.** A car in a garage or out
    of service on a day is not one of that day's cars. In `api/revenue_target.js`
    a day's plan is the rate × the cars that earned in the 7 days before it
    (`carsAsOf`, line 202); an off-road car leaves that set for the day, so the
    fleet's plan falls by its share and each working car's rate is unchanged.
14. **The repeat window is 90 days.**
15. **For now, anyone with a dashboard account can be a car's responsible
    person.**
16. **Garage invoices are kept five years.** In the database to begin with,
    the `driver_ledger_receipt` pattern widened to PDFs; the operator will
    choose a cheaper store later, so the visit refers to an attachment by its
    sha256 and never by where the bytes live.

## The existing records, consolidated (2026-10-14)

Two files the operator supplied — the audit workbook built from the invoices
(Garage_Spend_Stage4_Comprehensive_Audit.xlsx) and the team's maintenance log
(Garage_Maintenance_Log.xlsx) — were joined into one history, **invoices first**
(the operator: "the first one is invoices so that takes precedence"), the log
second, bookings as evidence only. What that showed, for whoever imports it:

- **367 documents are 239 invoices**, AED 423,841.96: 126 copies (identical,
  undated, revised) and 2 payment documents (a cheque cover page equal to the
  nine invoices behind it; a payment advice repeating two invoices' lines).
  Counting documents overstates spend by AED 256,992.70.
- **The audit's lines are not always the invoice's.** A line set copied onto
  other invoices fits only the one it came from; 23 invoices have no lines of
  their own that add up (7 the audit itself marks "Bundled invoice total").
  Typing such an invoice's cost from borrowed lines is a guess.
- **The audit's job text for every M M Sajdaf invoice is "Accident/repair
  work"** — A/C compressors and wiring included. It is a label, not evidence of
  an accident.
- **The log's dates turn day-first at row 250**, and Excel read every ambiguous
  one month-first; its "Police Report Link" column holds only "N/A" or nothing;
  fault is written once ("Accident Red Paper"). The visit record's fault and
  police fields are therefore new information, not a copy of anything held.
- 481 visits result: 106 invoice and log, 128 invoice only, 247 log only (AED
  387,002.50 approved in the log with no invoice found). Only 5 are accidents by
  what the records say (one with its fault written); 68 Body & paint visits
  carry no accident word and sit under maintenance until someone says otherwise.
- **A car's "current driver" in the register is the driver of its last booking
  the register sees**, dated `driver_as_of` — today's driver only for a working
  car. 35 of the 139 had none since 1 Oct 2026; L26153 none since 15 Oct 2025,
  yet it went to a garage seven times after that, the last on 29 Sep 2026.

## The work done most often, and the price sheet (2026-10-20)

The operator re-supplied both files on 2026-10-20 (session uploads, not in the
repository). **The team's log is also a live Google Sheet,
`Garage_Maintenance_Log`, shared with the operator's Google account and edited
by the team** (last edit 2026-10-20 07:21Z). The upload and the Drive copy were
identical: 373 rows. Of those, 357 are jobs. The rest are 11 blank rows, one
"MMS AUGUST TOTAL" subtotal row (255), and three rows that repeat a job: 53 and
109 record jobs 52 and 108 twice, and 126 is Zeefek's parts for the job on 125.

**The distinct invoices reproduce exactly**: 239 invoices, AED 423,841.96, out
of 367 documents. The rules that reproduce it:
- an identical repeat (same vendor, invoice number, car, date and total) is a copy: 120;
- an undated document with the same vendor, car and total as a dated one is a copy: 5;
- R0368 (the cheque cover page) and R0378 (the payment advice) are payments, not invoices;
- R0396 (CCF_000082) is the revised copy of R0395 (CCF_000081).

The 126 copies match the earlier count. The earlier split, 110 identical and
15 undated, used a stricter "identical".

**Itemisation is a judgement, and the rule is now written down.** 1,443 of the
audit's 1,715 lines are scaled pro rata to their invoice's total. So "the lines
add up" proves nothing. The test that does is the invoice total divided by the
lines' pre-VAT sum: within 1% of 1.00 or 1.05. On that test 202 invoices (450
lines) are itemised and 37 (AED 156,107.21) are left whole: 31 whose lines do
not fit, and 6 bundled totals. The 2026-10-14 consolidation itemised 216
(AED 111,777.21 left whole) by a rule it did not record.

**What the log says is done most** (357 jobs; a job naming several pieces of
work counts under each; 124 jobs name more than one):

| work type | jobs | cars |
|---|---|---|
| Tyres | 108 | 74 |
| A/C & cooling | 80 | 66 |
| Suspension & steering | 53 | 42 |
| Exterior/underbody components | 50 | 42 |
| Body & paint | 47 | 39 |
| Recovery/towing | 39 | 27 |
| Alignment & balancing | 32 | 28 |
| Battery & electrical | 27 | 22 |
| Engine/mechanical/drivetrain | 27 | 21 |
| Routine servicing | 25 | 11 |
| Programming & diagnostics | 24 | 20 |
| Glass/windows/mirrors | 23 | 22 |
| Brakes | 16 | 15 |
| Wheel/rim work | 14 | 14 |
| SRS/safety systems | 3 | 2 |

Specific jobs, most often first: tyre change 108, A/C service 76, dent and
paint 43, tow 39, lower and control arms 35, A/C filter 33, wheel alignment
32, wheel bearing 26, programming 24, oil and filter 19, 12/16 V battery 19.

The money is spread differently. On the 450 itemised lines, battery and
electrical is AED 78,771, mostly two high-voltage battery jobs. Suspension
and steering is AED 32,313, and Tyres is AED 13,796 on lines, while the
AED 52,670 tyre-stock invoice is a bundled total.

**The garage price sheet** (artifact
https://claude.ai/artifact/MGqiK9J7SyM3cSBpVupSPa, private, and a PDF) is a
quotation form. It lists 113 jobs under the fifteen types plus a "General"
group (labour rate, diagnostics, washing). Each job has its unit and its
count in the log, and there are six blank price columns, eight write-in
rows, and a details box for each garage. One sheet is printed per car
model. It is the starting list for the signed price lists of ruling 8. The
scripts that made it lived in a session scratchpad: the job list and its
patterns are reproducible from the log by the rules above, and are not kept.

## Inputs needed from the operator

The four questions asked 2026-10-14 are answered (rulings 13–16).

Earlier list:

1. **The garages in use now** — name, location (address or pin), what work each
   takes. Whether any of the four places above is one of them, a company yard,
   or a staff base.
2. ~~The starting work-type list~~ — given (rulings, 2).
3. **The repeat window** — 90 days by default.
4. **Who is responsible for each car** (rulings, 3), by name. Approvers and the
   threshold come later (rulings, 7).
5. **Whether to ask InfoTrack** three questions: what sets `outofservice`;
   whether workshop geofences can be held and read (`GetGeofenceInfo`); what
   `previousDistance` is (an odometer would make service-due possible for the
   FMS cars).
6. ~~Whether to collect Bolt's vehicle state~~ — no (rulings, 6).
