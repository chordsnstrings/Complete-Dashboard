/* Export watermarks — every file a signed-in person takes away says who took
   it and when.
   ─────────────────────────────────────────────────────────────────────────
   docs/ULM-DESIGN.md §9.3 ("Exports are gated by act:export.<class>, stamped
   with user and time, and audited"), §8 (act:export.<class>: "watermarked
   with user and time; audited"), §13 phase 4. The gate already checks the
   class and audits each download (manifest `auditRead` on every export
   route: an access_audit row `read:/api/export/…` with the person, the time
   and the query keys). What did not exist was the STAMP: a file saved to a
   laptop keeps none of its response headers, and six months later nothing in
   it said whose download it was.

   WHAT IS STAMPED (every route that hands back a file, found by searching
   the API for Content-Disposition, 2026-11-12):
     GET /api/export/trips.csv            api/export_routes.js
     GET /api/export/money.xlsx           api/money_export_routes.js (the money workbook)
     GET /api/export/today.xlsx           api/target_routes.js
     GET /api/export/target-month.xlsx    api/target_routes.js
     GET /api/export/lowperf.xlsx         api/lowperf_routes.js
     GET /api/export/lowperf-watch.xlsx   api/lowperf_routes.js
     GET /api/agent/file/:c/:f            api/agent_routes.js (the workbook the
                                          assistant attaches to an answer)
   No emailed report carries an attachment: the daily, monthly, low-trips and
   cash emails are HTML and text bodies only (src/daily_report.js
   resendSend), so there is no report attachment to stamp. The browser's own
   downloads (app.js, target.js) save these routes' bytes unchanged.

   HOW:
     CSV   one line before the header row, quoted as a single cell and
           starting with '#':  "# Exported by … on … Dubai time (…Z). FleetMirror"
           Excel shows it in A1; pandas reads past it with comment='#'.
     XLSX  three places, so it survives whichever way the file is opened:
           the file's own properties (Author / Last modified by / Comments),
           every sheet's PRINT FOOTER, and a last sheet, "Exported by",
           spelling it out — added last, so no existing sheet moves.

   WHO IS STAMPED: a signed-in person (their name and email) or a wall screen
   (its name). A visitor while sign-in is optional gets exactly the file they
   always got: there is no one to name, and §16 promises that open mode is
   the product as it was. */

/* Who and when, or null when there is nobody to name. */
export function exportStamp(req, now = new Date()) {
  const fm = req?.fm;
  if (!fm) return null;
  let by = null; let email = null;
  if (fm.kind === 'user' && fm.user) { by = fm.user.name || fm.user.email; email = fm.user.email || null; }
  else if (fm.kind === 'device' && fm.device) by = `the screen “${fm.device.name}”`;
  if (!by) return null;
  const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  by = clean(by);
  email = email ? clean(email) : null;
  const at = new Date(now);
  const utc = at.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const dubai = at.toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const who = email && email !== by ? `${by} (${email})` : by;
  const preview = fm.access?.preview || null;
  return {
    by, email, who, at: utc, dubai, preview,
    line: `Exported by ${who} on ${dubai} Dubai time (${utc})${preview ? `, previewing the ${preview} role` : ''}. FleetMirror`,
  };
}

/* The CSV's first line: one quoted cell, so no comma in a name splits it. */
export function csvStampLine(stamp) {
  if (!stamp) return '';
  return `"# ${stamp.line.replace(/"/g, '""')}"\n`;
}

/* Stamps a src/xlsx_write.js Workbook before toBuffer(). `what` names the
   file in words; `asked` is the request's query, so the stamp also says
   which dates and filters were asked for. A no-op without a stamp. */
export function stampWorkbook(wb, stamp, { what = null, asked = null } = {}) {
  if (!stamp || !wb) return wb;
  wb.creator = `${stamp.who} via FleetMirror`;
  wb.lastModifiedBy = stamp.who;
  wb.description = stamp.line;
  wb.created = new Date(stamp.at);
  wb.footer = `Exported by ${stamp.by} on ${stamp.dubai} Dubai time`;
  const taken = new Set(wb.sheets.map((s) => s.name.toLowerCase()));
  let name = 'Exported by';
  for (let i = 2; taken.has(name.toLowerCase()); i += 1) name = `Exported by (${i})`;
  const sh = wb.sheet(name, { widths: [20, 80] });
  sh.text('Who exported this file, and when', 'title');
  sh.blank();
  sh.pair('Exported by', stamp.by);
  if (stamp.email) sh.pair('Email', stamp.email);
  sh.pair('When, Dubai time', stamp.dubai);
  sh.pair('When, UTC', stamp.at);
  if (stamp.preview) sh.pair('Previewing', `the ${stamp.preview} role (read-only)`);
  if (what) sh.pair('What', what);
  const q = asked && typeof asked === 'object'
    ? Object.entries(asked).filter(([k, v]) => v != null && v !== '' && !k.startsWith('_')).map(([k, v]) => `${k}=${v}`).join('&') : '';
  if (q) sh.pair('Asked for', q);
  sh.blank();
  sh.text('Every file a signed-in person downloads carries this stamp, and the download is also recorded in the '
    + 'access audit log (Set up → Access → Audit). It names who took the data out, so a copy found later can be traced.', 'dim');
  return wb;
}
