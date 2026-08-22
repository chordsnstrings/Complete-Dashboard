/* Serves the real dashboard against an in-process Postgres, for design review.
   ─────────────────────────────────────────────────────────────────────────
   This replaces test/preview-server.mjs, which re-implemented forty of the
   API's queries by hand under a comment admitting it ("simplest reliable
   approach here is a thin re-implementation of the same queries"). It was
   three generations behind by the time it was deleted: /api/vehicles there
   still summed telematics journeys into the trip count, which is the exact bug
   the shipped endpoint carries a paragraph of comment about not doing.

   A preview of a different application is worse than no preview: it is a
   screenshot of a product nobody can ship. This mounts the REAL handlers —
   server.js's routes and every route module — against the same fixture the
   tests use, so what you look at is what deploys.

     node test/preview.mjs           a small fleet with the awkward shapes in it
     node test/preview.mjs --wide    240 vehicles and 240 people, for the
                                     truncation and density questions
     PORT=8100 node test/preview.mjs */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { applySchema } from './schema.mjs';
import { seedFleet } from './fixture.mjs';
import { rebuildCustody } from '../src/custody.js';
import { mountAll } from './mount.mjs';

const wide = process.argv.includes('--wide');
const port = Number(process.env.PORT) || 8099;
const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'api', 'public');

const db = new PGlite();
await applySchema(db);
const trips = await seedFleet(db, { wide });
await rebuildCustody({ from: '2026-08-01', to: '2026-08-31', db });

const { app, server } = await mountAll(db);
server.close();                                   // mountAll listens on :0; re-serve on the chosen port
const express = (await import('express')).default;
app.use(express.static(pub));
app.get('*', (_, r) => r.sendFile(join(pub, 'index.html')));
app.listen(port, () => {
  console.log(`preview on http://localhost:${port}`);
  console.log(`  ${trips} trips seeded${wide ? ' (wide fleet)' : ''}`);
  console.log('  the window the fixture covers is 2026-08-01 → 2026-08-31');
});
