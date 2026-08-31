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
  'schema_v41.sql', 'schema_v42.sql',
];
