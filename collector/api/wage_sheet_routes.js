/* THE WAGE-SHEET CLASSIFIER, as a preview that keeps nothing.
   ─────────────────────────────────────────────────────────────────────────
   POST /api/wage-sheet/preview   the .xlsx, raw    cash.import   writes nothing

   src/salary/sheet.js decides which of five wage-sheet families a workbook
   tab is, finds its header row, period and company line, and refuses where
   the evidence disagrees — ten "Egari" sheets carry an Ecosine company row,
   and the two fleets reuse one id space, so a wrong guess merges unrelated
   drivers. It was written on 2026-09-22 and nothing imported it. The payslip
   import it exists for waits on the operator (docs/HANDOFF.md §6.4), so this
   wires it in the one way that cannot do harm in the meantime: upload a
   workbook, see what the classifier makes of every tab, and keep nothing.

   ── AN UPLOAD ROUTE THAT IS NOT A WRITE PATH ─────────────────────────────
   Not by policy but by construction. api/server.js hands this module `wrap`
   and nothing else, and it takes nothing else wherever it is mounted — no
   query function, no transaction runner — and the worker it starts
   (src/salary/preview_worker.js) imports the xlsx reader and the classifier
   and no database module at all. There is nothing here that could store the
   file, its rows or the verdict, and test/wage_sheet_preview.test.mjs mounts
   it beside a query function that records every call and requires none.
   The bytes live in this request's memory and the worker's, and are gone
   when the response is sent.

   ── WHO MAY CALL IT ──────────────────────────────────────────────────────
   The access manifest declares it subject CASH (a wage sheet is driver pay —
   ULM's CASH class names "salary lines") with the action cash.import, the one
   "Preview an imported cash sheet" already means: the Owner, Finance and the
   cash desk. It answers with no person in it — family, rows, period, company
   line, fleet signals and refusals, never a name, an id or an amount — so it
   discloses nothing the uploader did not already hold. No admin token, for
   the reason POST /api/ledger/import/preview carries none: it is not a write,
   and the token guards writes.

   ── WHAT ONE HOSTILE FILE MAY COST ───────────────────────────────────────
   While sign-in is optional on production, "who may call it" is anyone, so
   the cost of one request is bounded on every axis it has:
     size       4 MB of body (express.raw), the HR import's limit; a 413 past it
     unpacking  24 MB in total, enforced by zlib while inflating
                (src/salary/xlsx.js maxBytes) — a zip bomb is refused mid-way
     CPU        a worker thread, terminated after TIMEOUT_MS: the reader's
                regular expressions are lazy and correct, but a document built
                with thousands of unclosed tags makes them quadratic, and that
                must cost a 504, not the event loop every page shares
     memory     the worker's heap is capped (resourceLimits), and Buffers it
                allocates are bounded by the unpacking cap above
     company    one preview at a time; a second, while one runs, is a 429
   The page that calls it sends one file per click, so none of these is felt
   by a person using it as intended. */
import express from 'express';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { MAX_UNPACKED, MAX_SHEETS } from '../src/salary/preview.js';

const XLSX_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];
const BODY_LIMIT = '4mb';
const sheetBody = express.raw({ type: XLSX_TYPES, limit: BODY_LIMIT });
/* Fifteen seconds. A real wage workbook is read in well under one on a busy
   basic-xxs; this is a ceiling for a file that is not one. */
export const TIMEOUT_MS = 15_000;
const WORKER = new URL('../src/salary/preview_worker.js', import.meta.url);
/* The worker's own heap, kept well inside a 512 MB machine that is also
   running the API. Buffers are outside it and bounded by MAX_UNPACKED. */
const LIMITS = { maxOldGenerationSizeMb: 160, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 16, stackSizeMb: 4 };

const NO_FILE = 'no workbook arrived. Send the .xlsx as the raw request body with content-type '
  + `${XLSX_TYPES[0]} (or application/octet-stream).`;
const NOTHING_KEPT = 'Nothing was stored: this is the classifier alone. The workbook was read in '
  + 'memory and discarded, and no wage, person or verdict was written anywhere. The payslip '
  + 'import itself waits on the operator’s answers about which gross a payslip uses.';

/* One workbook, read off the API's thread. Resolves — never rejects — with
   { result } or { timedOut } or { error }, and the worker is always stopped. */
export function readInWorker(bytes, { filename = '', timeoutMs = TIMEOUT_MS, maxBytes = MAX_UNPACKED,
  maxSheets = MAX_SHEETS, worker = WORKER, resourceLimits = LIMITS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let w;
    try {
      w = new Worker(worker, { workerData: { bytes: new Uint8Array(bytes), filename, maxBytes, maxSheets },
        resourceLimits });
    } catch (e) { resolve({ error: e }); return; }
    const finish = (out) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.terminate().catch(() => {});
      resolve(out);
    };
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);
    w.once('message', (m) => finish({ result: m }));
    w.once('error', (e) => finish({ error: e }));
    /* After any message the worker posted: 'exit' can be queued behind it,
       and a reply that arrived must win over "stopped without answering". */
    w.once('exit', (code) => setImmediate(() => finish({
      error: new Error(`the reader stopped (exit code ${code}) without answering`) })));
  });
}

let running = false;

export function wageSheetRoutes(app, { wrap, read = readInWorker, timeoutMs = TIMEOUT_MS } = {}) {
  app.post('/api/wage-sheet/preview', sheetBody, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const base = { written: false, stored: false };
    const bytes = Buffer.isBuffer(req.body) && req.body.length ? req.body : null;
    if (!bytes) return res.status(400).json({ ...base, ok: false, refusals: [NO_FILE] });
    if (running) {
      return res.status(429).json({ ...base, ok: false,
        refusals: ['another workbook is being read right now — one at a time, so a large file '
          + 'cannot crowd out every page. Try again in a few seconds.'] });
    }
    /* The name the uploader's computer gave the file. It is evidence to the
       classifier (a filename is one of its three fleet signals) and nothing
       else; only its last segment is used and it is never a path here. */
    const filename = String(req.query.filename || '').split(/[\\/]/).pop().slice(0, 200);
    running = true;
    let out;
    try { out = await read(bytes, { filename, timeoutMs }); } finally { running = false; }
    const about = { filename: filename || null, byte_len: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), note: NOTHING_KEPT };
    if (out.timedOut) {
      return res.status(504).json({ ...base, ...about, ok: false,
        refusals: [`reading this workbook took longer than ${Math.round(timeoutMs / 1000)} seconds, so it `
          + 'was stopped. A wage workbook reads in well under one; this file is either far larger than '
          + 'one or built to be slow.'] });
    }
    if (out.error) {
      const oom = out.error?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      return res.status(422).json({ ...base, ...about, ok: false,
        refusals: [oom
          ? 'this workbook needed more memory than a preview is allowed, so it was stopped — no '
            + 'wage workbook comes near that'
          : `the reader could not finish this workbook: ${String(out.error.message || out.error).slice(0, 300)}`] });
    }
    const r = out.result || {};
    return res.status(r.readable ? 200 : 400).json({ ...base, ...about, ...r });
  }));
}
