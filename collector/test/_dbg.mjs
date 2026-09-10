import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
const db = new PGlite();
await applySchema(db);
const { get } = await mountAll(db, { serverRoutes: true });
const r = await get('/api/finance/daily?from=2026-08-14&to=2026-08-16');
console.log('status', r.status);
console.log(JSON.stringify(r.body).slice(0, 1200));
