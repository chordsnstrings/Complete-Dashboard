import { PGlite } from '@electric-sql/pglite';
import { applySchema } from './schema.mjs';
import { mountAll } from './mount.mjs';
const db = new PGlite(); await applySchema(db);
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
const { get } = await mountAll(db);
await q(`INSERT INTO driver (id, full_name) VALUES (1,'A'), (2,'B')`);
console.log(JSON.stringify((await get('/api/person/merge?keep=1&drop=2')).body, null, 1).slice(0, 500));
