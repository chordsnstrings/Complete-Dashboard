import { PGlite } from '@electric-sql/pglite';
import { applySchema } from '../schema.mjs';
import { onlineSpansSql } from '../../api/online_span_sql.js';
const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);
const ev = (id, at, status, fleet = 'ecosine') => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber',$4,$1,$2::timestamptz,'status',$3,'')`, [id, at, status, fleet]);
/* a dangling ONLINE on a day that is NOT today */
await ev('old', '2026-09-05T14:00:00+04:00', 'ONLINE');
/* the fleet-chip case: ONLINE on egari, closed by an OFFLINE stamped ecosine */
await ev('chip', '2026-09-06T10:00:00+04:00', 'ONLINE', 'egari');
await ev('chip', '2026-09-06T12:00:00+04:00', 'OFFLINE', 'ecosine');
await ev('chip', '2026-09-07T10:00:00+04:00', 'ONLINE', 'egari');
await ev('chip', '2026-09-07T11:00:00+04:00', 'OFFLINE', 'egari');
const run = async (keep, p = []) => q(`WITH ${onlineSpansSql({ keep })}
  SELECT driver_ext_id,
    to_char(span_start AT TIME ZONE 'Asia/Dubai','MM-DD HH24:MI') s,
    to_char(span_end AT TIME ZONE 'Asia/Dubai','MM-DD HH24:MI') e, open_ended,
    round(extract(epoch from (span_end - span_start))/60)::int mins
   FROM spans ORDER BY 1,2`, p);
console.log('unfiltered', JSON.stringify(await run('TRUE')));
console.log('fleet=egari', JSON.stringify(await run(`($1::text IS NULL OR fleet_id = $1)`, ['egari'])));
