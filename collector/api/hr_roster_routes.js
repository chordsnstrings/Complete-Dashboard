/* THE HR ROSTER — upload it, see what it would do, then write it.
   ─────────────────────────────────────────────────────────────────────────
   Three routes, and the split between the two write routes is the ledger
   import's (api/import_routes.js), for the same reason:

     POST /api/hr-roster/preview   the file, raw          ADMIN   writes nothing
     POST /api/hr-roster/commit    the same file again    ADMIN   writes the snapshot
     GET  /api/hr-roster           the roster + history   anyone  no document numbers

   THE COMMIT RE-SENDS THE BYTES. It does not accept "the rows the preview
   showed": a commit that took rows from the browser would write whatever the
   browser sent, and the whole point of a preview is that what is written is
   what was shown. The commit runs the same previewOf() inside its
   transaction, and refuses when the sha256 differs from the one the screen
   previewed — so the file on the operator's disk changing between the two
   clicks is a refusal, not a silent write of something nobody looked at.

   RAW, NOT JSON. api/server.js caps every JSON body at 256kb, the first
   export is 255kb before base64 inflates it by a third, and raising the shared
   limit raises the DoS budget of every route in the process. A per-route raw
   parser raises it for exactly this one — built here, not injected, for the
   reason api/ledger_routes.js records: a mount that forgot to supply it threw
   at registration and the API never bound a port.

   ADMIN, LIKE EVERY OTHER WRITE. requireAdmin is taken from the caller when
   api/server.js supplies it and built from api/admin_gate.js otherwise, so the
   test harness — which mounts route modules with a fixed dependency set that
   has no gate in it — runs the real gate rather than none. The GET is not
   gated: the operator's decision is that everybody sees expiry dates. */
import express from 'express';
import { adminGate } from './admin_gate.js';
import { previewOf, commitRoster, rosterView } from './hr_roster.js';

const XLSX_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream',
];
/* Four megabytes: the first export is 255kb for 143 people, so this is
   roomy for a fleet several times this size and still a bound. */
const xlsxBody = express.raw({ type: XLSX_TYPES, limit: '4mb' });

const bytesOf = (req) => (Buffer.isBuffer(req.body) && req.body.length ? req.body : null);
const NO_FILE = 'no workbook arrived. Send the .xlsx as the raw request body with content-type '
  + `${XLSX_TYPES[0]} (or application/octet-stream).`;

export function hrRosterRoutes(app, { q, wrap, tx, requireAdmin = null }) {
  const gate = requireAdmin || adminGate({ warn: () => {} });

  app.get('/api/hr-roster', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await rosterView(q));
  }));

  app.post('/api/hr-roster/preview', gate, xlsxBody, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const bytes = bytesOf(req);
    if (!bytes) return res.status(400).json({ ok: false, refusals: [NO_FILE], written: false });
    const p = await previewOf(q, bytes, {
      filename: req.query.filename || null, exportDate: req.query.export_date || null });
    return res.status(p.ok ? 200 : p.duplicate_of ? 409 : 400).json(p);
  }));

  app.post('/api/hr-roster/commit', gate, xlsxBody, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const bytes = bytesOf(req);
    if (!bytes) return res.status(400).json({ ok: false, refusals: [NO_FILE], written: false });
    /* WHO. Recorded on the upload and shown in the history — the product has
       no sign-in, so the page asks and the route refuses a blank. */
    const by = String(req.query.by || '').trim();
    if (by.length < 2 || by.length > 60) {
      return res.status(400).json({ ok: false, written: false,
        refusals: ['say who is uploading this (2 to 60 characters) — it is recorded against the upload'] });
    }
    const out = await tx(async (tq) => commitRoster(tq, bytes, {
      filename: req.query.filename || null, exportDate: req.query.export_date || null,
      by, ip: req.ip || null, expectSha: req.query.expect_sha || null }));
    if (!out.ok) {
      return res.status(out.status).json({ ...out.preview, ok: false, written: false,
        note: 'Nothing was written.' });
    }
    return res.json({ ...out.preview, ok: true, written: true, upload_id: out.upload_id,
      wrote: out.wrote,
      note: `Written: upload ${out.upload_id}, ${out.wrote.rows} rows, the HR export of `
        + `${out.preview.export_date}. ${out.wrote.proposals_new} new proposal`
        + `${out.wrote.proposals_new === 1 ? '' : 's'} on the same-person queue; nothing was merged.` });
  }));
}
