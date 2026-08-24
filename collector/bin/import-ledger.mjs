#!/usr/bin/env node
/* Imports the operator's daily ledger into driver_statement_day, via the API.
   ─────────────────────────────────────────────────────────────────────────
   Usage:
     node bin/import-ledger.mjs <ledger.csv> [--base https://host] [--source ledger]
                                [--pseudo]            # rows are pseudo-drivers
                                [--admin-token TOKEN] # when ADMIN_TOKEN is set

   The CSV comes from the operator's workbook (columns: date, driver, company,
   platform, gross, fees, net, tips, salik, cash, bank, network_cash,
   unremitted, trips). Batches of 400 keep each POST inside the API's 256kb
   body cap. Re-running is safe: the endpoint upserts on
   (platform, fleet, name, day, source). The last batch carries done:true,
   which records the import as a collection run and moves the data version so
   every cached money figure refreshes. */
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
if (!file) { console.error('usage: node bin/import-ledger.mjs <ledger.csv> [--base URL]'); process.exit(2); }

const base = opt('base', process.env.BASE || 'http://localhost:8080');
const source = opt('source', 'ledger');
const pseudo = args.includes('--pseudo');
const adminToken = opt('admin-token', process.env.ADMIN_TOKEN || null);

const rows = parse(readFileSync(file), { columns: true, skip_empty_lines: true, bom: true });
if (pseudo) for (const r of rows) r.pseudo = true;
console.log(`${rows.length} rows from ${file} -> ${base} (source=${source}${pseudo ? ', pseudo' : ''})`);

const BATCH = 400;
let written = 0, rejected = 0;
for (let i = 0; i < rows.length; i += BATCH) {
  const batch = rows.slice(i, i + BATCH);
  const done = i + BATCH >= rows.length;
  const res = await fetch(`${base}/api/import/statement-days`, {
    method: 'POST',
    headers: { 'content-type': 'application/json',
      ...(adminToken ? { 'x-admin-token': adminToken } : {}) },
    body: JSON.stringify({ rows: batch, source, done }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.ok) {
    console.error(`batch ${i / BATCH + 1} FAILED (${res.status}):`, JSON.stringify(body).slice(0, 300));
    process.exit(1);
  }
  written += body.written; rejected += body.rejected;
  if (body.rejected) console.error(`  batch ${i / BATCH + 1}: ${body.rejected} rejected at`, body.rejected_indexes);
  process.stdout.write(`\r${Math.min(i + BATCH, rows.length)}/${rows.length} sent, ${written} written`);
}
console.log(`\ndone: ${written} written, ${rejected} rejected`);
