#!/usr/bin/env node
/* bin/restore-drill.mjs — verify a RESTORED database before the app is
   pointed at it (docs/BACKUP-RESTORE.md §4 is the procedure around it).

     DATABASE_URL=… SETTINGS_KEY=… node bin/restore-drill.mjs \
       --expect trip>=705000,alert>=905000,app_setting=31

     node bin/restore-drill.mjs --counts            # print counts to record
     node bin/restore-drill.mjs --expect-file counts.json --allow-pending
     node bin/restore-drill.mjs --json              # the report as JSON

   Reads DATABASE_URL and SETTINGS_KEY from the environment and prints
   NEITHER, nor any part of them, nor any stored secret: the report names the
   database, the server version and when the server started (a restore
   started minutes ago; production has been up for days — the way to tell
   which one you are pointed at without printing an address). The session is
   READ ONLY: the drill cannot change what it checks.

   Exit: 0 every check passed (warnings allowed), 1 a check failed, 2 nothing
   failed but something could not be measured, 3 it could not connect. */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { runDrill, parseExpect, countsNow } from '../src/restore_drill.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

/* What a connection error may print: its code and a generic sentence. pg's
   messages can echo a user or host, and the brief is "never printed". */
const scrub = (e) => `${e?.code || 'error'}: ${String(e?.message || e)
  .replace(/postgres(ql)?:\/\/\S+/gi, '<DATABASE_URL>')
  .replace(/(user|password|host)\s+"[^"]*"/gi, '$1 "<redacted>"')
  .slice(0, 200)}`;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set — the drill reads it from the environment only.'); return 3; }
  /* The same TLS rule src/db.js poolConfig applies, so the drill connects the
     way the app will. (That rule does not verify the server certificate —
     an audit finding of 2026-11-12 that applies to both.) */
  const needSsl = process.env.DATABASE_SSL === 'true' || /sslmode=/i.test(url);
  let cs = url;
  if (needSsl) { try { const u = new URL(cs); u.searchParams.delete('sslmode'); cs = u.toString(); } catch { /* keep */ } }
  const client = new pg.Client({ connectionString: cs, ssl: needSsl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 300000, connectionTimeoutMillis: 15000 });
  try { await client.connect(); }
  catch (e) { console.error(`could not connect — ${scrub(e)}`); return 3; }
  try {
    await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const [who] = (await client.query(
      `SELECT current_database() AS db, current_setting('server_version') AS version,
              pg_postmaster_start_time() AS started`)).rows;
    const ident = `database ${who.db}, PostgreSQL ${who.version}, server up since ${new Date(who.started).toISOString()}`;

    if (flag('--counts')) {
      const counts = await countsNow(client);
      console.log(JSON.stringify({ taken_at: new Date().toISOString(), ...counts }, null, 1));
      console.error(`(${ident}) — keep this file with the backup; hand it back with --expect-file after a restore.`);
      return 0;
    }

    let spec = value('--expect');
    if (value('--expect-file')) spec = JSON.parse(readFileSync(value('--expect-file'), 'utf8'));
    if (spec && typeof spec === 'object') delete spec.taken_at;
    const { expects, bad } = parseExpect(spec);
    if (bad.length) { console.error(`unreadable expectation(s): ${bad.join(', ')}`); return 1; }

    const report = await runDrill(client, { env: process.env, expects, allowPending: flag('--allow-pending') });
    if (flag('--json')) {
      console.log(JSON.stringify({ target: ident, ...report }, null, 1));
    } else {
      const MARK = { pass: '✓', warn: '!', fail: '✗', not_measured: '?' };
      console.log(`restore drill — ${ident}`);
      for (const c of report.checks) console.log(`  ${MARK[c.status] || '?'} ${c.name}: ${c.detail}`);
      console.log(report.code === 0 ? 'the restored database passes'
        : report.code === 2 ? 'nothing failed, but not everything was measured — see the ? lines'
          : 'the restored database FAILS the drill — see the ✗ lines');
    }
    return report.code;
  } catch (e) {
    console.error(`drill failed — ${scrub(e)}`);
    return 1;
  } finally {
    await client.end().catch(() => {});
  }
}

main().then((code) => process.exit(code));
