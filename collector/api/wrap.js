/* The error boundary every route sits behind.
   ─────────────────────────────────────────────────────────────────────────
   It lived inline in server.js, which meant the one part of it worth testing
   could not be reached by a test: a failure AFTER a route has begun writing.
   Every route here answered JSON in one shot until /api/export/trips.csv
   started streaming a CSV a day at a time, and a streaming route can fail
   with its status line already gone.

   Calling res.status(500).json() at that point throws ERR_HTTP_HEADERS_SENT
   on top of whatever actually failed — so the log names the wrong error, the
   original is lost, and the process takes an unhandled rejection. Ending the
   response cleanly instead would be worse: the client gets 200 and a file
   that is short and looks complete, which for an export is the exact lie the
   endpoint exists to avoid.

   Destroying the socket is the honest answer. The client sees an aborted
   transfer — curl reports a partial read, a browser reports a failed
   download — and the truth is in the log with a reference to quote. */
export function makeWrap({ log, now = () => Date.now() }) {
  let seq = 0;
  return (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    const ref = `e${now().toString(36)}-${(++seq).toString(36)}`;
    log.error('api', req.path, { ref, query: req.query, err: String(e) });
    if (res.headersSent) return res.destroy();
    res.status(500).json({ error: 'internal', ref });
  });
}
