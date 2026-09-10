import { PGlite } from '@electric-sql/pglite';
import { applySchema } from '../schema.mjs';
import { onlineSpansSql } from '../../api/online_span_sql.js';

const db = new PGlite();
const q = (t, p = []) => db.query(t, p).then((r) => r.rows);
await applySchema(db);

const ev = (id, at, status) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state)
   VALUES ('uber','ecosine',$1,$2::timestamptz,'status',$3,'')`, [id, at, status]);
const job = (id, at, state, jid) => q(
  `INSERT INTO driver_timeline_event (platform, fleet_id, driver_ext_id, at, kind, status, state, job_ext_id)
   VALUES ('uber','ecosine',$1,$2::timestamptz,'job','',$3,$4)`, [id, at, state, jid]);

const D = '2026-09-10';
await ev('d1', `${D}T08:34:46+04:00`, 'ONLINE');
await ev('d1', `${D}T08:35:05+04:00`, 'ONLINE');
await job('d1', `${D}T08:35:11+04:00`, 'DJ_ASSIGNED', 'j1');
await job('d1', `${D}T09:11:55+04:00`, 'DJ_COMPLETED', 'j1');
await ev('d1', `${D}T09:59:15+04:00`, 'ONLINE');
await job('d1', `${D}T09:59:21+04:00`, 'DJ_ASSIGNED', 'j2');
await job('d1', `${D}T10:05:46+04:00`, 'DJ_PICKUP', 'j2');

/* a driver who went offline */
await ev('d2', `${D}T06:00:00+04:00`, 'ONLINE');
await ev('d2', `${D}T07:00:00+04:00`, 'OFFLINE');
/* a job with no heartbeat at all */
await job('d3', `${D}T12:00:00+04:00`, 'DJ_ASSIGNED', 'j3');
await job('d3', `${D}T12:40:00+04:00`, 'DJ_COMPLETED', 'j3');

const sql = `WITH ${onlineSpansSql({ where: `at >= (($1::date - 1)::timestamp AT TIME ZONE 'Asia/Dubai')
      AND at < (($1::date + 2)::timestamp AT TIME ZONE 'Asia/Dubai')` })}
  SELECT driver_ext_id,
         to_char(span_start AT TIME ZONE 'Asia/Dubai', 'HH24:MI:SS') AS s,
         to_char(span_end AT TIME ZONE 'Asia/Dubai', 'YYYY-MM-DD HH24:MI:SS') AS e,
         open_ended
    FROM spans ORDER BY driver_ext_id, span_start`;
console.log(JSON.stringify(await q(sql, [D]), null, 1));
