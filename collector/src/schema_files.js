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
];
