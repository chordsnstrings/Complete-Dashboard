/* Every schema file, in the order they must be applied.
   ─────────────────────────────────────────────────────────────────────────
   Its own module so that src/db.js and test/schema.mjs can both IMPORT it.
   test/schema.mjs used to recover this list by regex out of db.js —
   `for (const f of [...])` — which worked until the loop changed shape, at
   which point every database-backed test in the suite failed at once with
   "could not find the schema file list". A list that has to be parsed out of
   another file's control flow is a list waiting to break; a list that is
   exported is not.

   Named rather than globbed, because ORDER is the contract: v18 drops and
   rebuilds views v17 defined, and a directory listing sorts schema_v10 before
   schema_v2. */
export const SCHEMA_FILES = [
  'schema.sql',
  'schema_v2.sql', 'schema_v3.sql', 'schema_v4.sql', 'schema_v5.sql',
  'schema_v6.sql', 'schema_v7.sql', 'schema_v8.sql', 'schema_v9.sql',
  'schema_v10.sql', 'schema_v11.sql', 'schema_v12.sql', 'schema_v13.sql',
  'schema_v14.sql', 'schema_v15.sql', 'schema_v16.sql', 'schema_v17.sql',
  'schema_v18.sql', 'schema_v19.sql', 'schema_v20.sql', 'schema_v21.sql',
  'schema_v22.sql', 'schema_v23.sql', 'schema_v24.sql', 'schema_v25.sql',
  'schema_v26.sql', 'schema_v27.sql', 'schema_v28.sql', 'schema_v29.sql',
  'schema_v30.sql', 'schema_v31.sql', 'schema_v32.sql', 'schema_v33.sql',
  'schema_v34.sql', 'schema_v35.sql', 'schema_v36.sql', 'schema_v37.sql',
  'schema_v38.sql', 'schema_v39.sql', 'schema_v40.sql',
  'schema_v41.sql', 'schema_v42.sql', 'schema_v43.sql', 'schema_v44.sql', 'schema_v45.sql', 'schema_v46.sql', 'schema_v47.sql', 'schema_v48.sql', 'schema_v49.sql', 'schema_v50.sql', 'schema_v51.sql', 'schema_v52.sql',
  /* v53 is GENERATED from api/identity_map.js by bin/gen-schema-v53.mjs — it
     rebuilds person_key so every verified duplicate record folds onto the
     record it duplicates. After v20/v42/v51, so it replaces the expression
     they installed rather than racing them. It is re-runnable and is meant to
     be regenerated whenever the register grows: the guard inside it probes the
     LAST alias id and the number of WHEN clauses, so a column built from an
     older register rebuilds instead of being skipped. */
  'schema_v53.sql',
  'schema_v54.sql',
  'schema_v55.sql',
  'schema_v56.sql',
  'schema_v57.sql',
  'schema_v58.sql',
  /* One-time scrub of credentials already stored: bcrypt hashes and Expo push
     tokens written into trip.raw by the hotel feed before api/redact.js
     existed, and sampled secrets in provider_probe. Guarded by schema_once, so
     it runs once and is a no-op on every boot after. */
  'schema_v59.sql',
  /* One-time retraction of the occupancy segments a later reconcile pass
     superseded — left-truncated fragments of journeys already recorded whole,
     59.9 percent of the table as measured on 2026-09-05. Guarded by
     schema_once, so it runs once per database and is a no-op afterwards. */
  'schema_v61.sql',
  /* trip_ext rebuilt: has_authorization redefined from "an authorization object
     exists" to "an authorisation was granted", with the state it was really
     reporting split into authorization_pending and the provider's own word kept
     in authorization_status. */
  'schema_v62.sql',
  /* driver_photo: the image bytes, because driver_compliance.picture_url holds
     a twelve-hour pre-signed CloudFront URL and the collector that refreshes it
     runs weekly. Measured: 156 of them expired 4 Sep and every one answers 403.
     A separate table so a bytea never rides along on a contact read. */
  'schema_v63.sql',
  'schema_v64.sql',
  /* driver_identity_link: the roster carries one phone number on both of a
     person's records and nothing joined on it, so 58 people rendered as two
     rows with 13,056 trips on the smaller one. Discovered per roster pull,
     applied at the boundary, never silently. */
  'schema_v65.sql',
  /* vehicle_plate: one row per plate over vehicle_profile, which is keyed
     (platform, vehicle_ext_id) and so holds one car once per channel. Until
     Yango's cars/list only Uber wrote that table, and four LEFT JOINs in the
     read API were written as though one-row-per-plate were a property of the
     table. It was a property of who was filling it. */
  'schema_v66.sql',
  /* place_area() + place_cell: no source gives both a name and a coordinate —
     Uber has 315,505 addresses and no fixes, FMS has 222,543 fixes and an
     address beside each one. The gazetteer is built from FMS's pairs so that a
     telematics position can be reported as somewhere a person can picture
     rather than as "25.112, 55.139". */
  'schema_v67.sql',
  /* place_area(), corrected against the gazetteer v67 actually built: blank
     segments were shifting the count past the community ("45HMWX6 - Madinat
     Jumeirah -  1 -  - UAE" resolved to "1"), and a plus code or road number
     in a three-segment address was being returned as a place name. Empties the
     gazetteer so the next collector pass rebuilds it under the new rule. */
  'schema_v68.sql',
  /* Repairs Yango's requested_at, which was mapped from booked_at — that
     provider's closing stamp — and so filed every Yango trip as ending before
     it started. Possible only because trip.raw holds the whole order. */
  'schema_v69.sql',
  /* The driver's own online status, which /v1/vehicle-suppliers/drivers/actions
     has been delivering every two minutes since the live map was built and
     which was being discarded — kept only as a plate-keyed telemetry row, and
     only for the drivers who happened to have a vehicle attached. Two tables:
     what is true now, and every change the provider has timestamped. */
  'schema_v70.sql',
  /* What each platform actually transferred to the company's bank, and on
     which date. The figure #reconcile has been calling "bank payout" is the
     per-driver earnings of a week, not a wire.

     THE "7.1% APART" THIS ENTRY USED TO CITE IS RETRACTED. It compared the
     week 7–13 Sep against the wire paid on Monday 7 Sep, and by the settlement
     cadence that wire settles 31 Aug – 6 Sep — the week before. Re-measured
     2026-09-17 against the right wire, the one paid Monday 14 Sep: ours
     110,962.09, Uber's 111,179.66, a difference of 217.57, or 0.20%. The two
     still describe different events and the small difference is the
     interesting part; 7.1% was a wrong-week comparison, not a measurement of
     it. See src/sources/uber_payout.js for the full arithmetic.

     Two tables: the transfers themselves (Uber and Bolt publish them; Yango
     publishes no such category at all), and the provider's own daily
     statement, which is what makes a transfer checkable rather than merely
     stated. */
  'schema_v71.sql',
  /* One index. The operator's last-trip rule asks who ENDED the most recent
     Uber trip on a car, and every index this table carries is keyed on
     requested_at — so the rule, and the three per-plate history reads that
     came with it, were scanning a 175,000-row table 360 times per request on a
     basic-xxs box. See the file for why the alternative (bounding those reads
     to a hard-coded date) was rejected as trading a performance fix for an
     honesty one. */
  'schema_v72.sql',
  /* One more index, and it is the one the last deployment's own verification
     found. An unfiltered min(at) over driver_status_event — the only query
     behind /api/unauthorized/attributed that does not look at the window —
     was a sequential scan of a heap the live tick rewrites every two minutes,
     and it cost 67 to 109 seconds on a window holding ZERO segments. See the
     file for the five timings that name the cause, and src/db.js for the
     other half of the fix. */
  'schema_v73.sql',
  /* platform_account_day.checked_at — when a HUMAN last asked Uber live about
     this day, which collected_at cannot answer. collected_at is DEFAULT now()
     on the insert and the nightly walk asks each day exactly once, so it is
     frozen at "when the backfill got here" for ever. Measured 2026-09-17: all
     23 statement rows on production (4 ecosine, 19 egari) were written by that
     walk and not one has been put to Uber by a person, yet under the old
     schema they are indistinguishable from a row somebody checked five minutes
     ago. NULLABLE and no default: NULL means nobody has asked, which is the
     absent-with-a-reason the page must print rather than a date. */
  'schema_v74.sql',
  /* What we asked Uber for and what came back, so a day the provider has
     nothing for is asked once instead of every run for ever. Invisible while
     the walk only works inside the month Uber does hold; fatal the moment the
     window widens to backfill 390 unasked days per fleet, which is what the
     payout work needs. Three outcomes, not a done flag: stored, empty and
     refused are different facts and only refused is retried. */
  'schema_v75.sql',
  /* The transaction ledger's verdict on the wire register. The register is
     built from a report that carries one aggregate row and no date, so it is
     asked a day at a time and the walk asks Mondays first — and every one of
     the twenty payout dates found across seventeen months IS a Monday, which
     makes the cadence very likely and not checked. REPORT_TYPE_PAYMENTS_ORDER
     is per transaction and dated, so one report over a window names every wire
     in it whatever weekday it fell on. See the file for the probe that
     established that and for why the audit never overwrites a stored amount. */
  'schema_v76.sql',
  /* The person a debt belongs to, as a row with an id of its own. Adopts the
     `driver` / `driver_platform_id` pair declared at sql/schema.sql:28-43 and
     never wired up — a grep finds zero readers and zero writers — because the
     advance ledger cannot key money on a provider's idea of who somebody is.
     For the hotel channel there IS no account id: api/driver_routes.js:286
     synthesises 'name:' || CANON(driver_name), and a re-spelling upstream would
     orphan a balance. The read-time fold is worse still: src/identity_link.js
     withdraws unconfirmed links on every collector run and
     /api/same-person/decide is UNAUTHENTICATED, so a debt could be moved
     between two humans by an anonymous POST. The person is therefore resolved
     once, at write time, and the row records which resolver decided it. Adds
     the per-person cash rule (the operator states it varies) and the pay basis,
     which is documentation and explicitly not a formula. Changes nothing about
     how any existing page resolves a driver. */
  'schema_v77.sql',
];
