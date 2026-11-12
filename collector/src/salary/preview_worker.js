/* The wage-sheet preview, run off the API's own thread.
   ─────────────────────────────────────────────────────────────────────────
   api/wage_sheet_routes.js starts one of these per upload, with a heap limit
   and a clock, and terminates it if the clock runs out. Everything that can
   be slow or large about a hostile workbook — unpacking it, the regular
   expressions over its XML, the row arrays — happens here, where the worst it
   can do is be stopped. It imports the reader and the classifier and nothing
   else: no database module, no settings, no network. */
import { parentPort, workerData } from 'node:worker_threads';
import { previewWorkbook } from './preview.js';

const { bytes, filename, maxBytes, maxSheets } = workerData || {};
let out;
try {
  out = previewWorkbook(Buffer.from(bytes), { filename, maxBytes, maxSheets });
} catch (e) {
  out = { ok: false, readable: false, sheets: [], refusals: [`the workbook could not be read: ${e.message}`] };
}
parentPort.postMessage(out);
