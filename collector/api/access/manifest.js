/* Every route, declared: what it is about, what it carries, who may call it.
   ─────────────────────────────────────────────────────────────────────────
   ULM-DESIGN §9.1. The entries themselves are in manifest.json — one per
   method + path. They were first written on 2026-09-28 by reading every
   handler and the helpers behind it (each entry's `notes` holds that reading:
   file and line, the response's shape, why the class) and then applying the
   design's policy decisions: the health checks public, raw records and query
   plans the Owner's, probes an action because they spend provider quota, the
   trigger's action following the job it queues. From here the file is
   maintained BY HAND: a new route needs an entry, and
   test/access_manifest.test.mjs fails the build until it has one.
   This module loads them and answers "which entry is this request?".

   DENY BY DEFAULT. A signed-in caller asking for an /api path with no entry
   is refused (api/access/middleware.js); test/access_manifest.test.mjs fails
   the build when a route is declared in code and not here.

   Entry fields:
     subject   class the caller must hold for the route to answer at all
     carries   every class in the answer
     grain     record | list | aggregate | none
     fields    [{ class, paths }] — removed or masked for a caller below F
     whole     classes that cannot be separated: lacking one refuses the route
     fleet     param | rows | global | mixed  (+ fleetRows, fleetKey)
     cap       the action a write (or a GET with side effects) needs
     public    answers without signing in
     self      the handler makes its own access decision (/api/auth, /api/access)
     auditRead reading it is recorded in the audit log
     fleetFrom 'body': a 'param' route whose handler takes the fleet from
               req.body.fleet, not ?fleet= — the gate judges that one
     search    { param, classes }: a search box whose matches may only reach
               the columns of classes the caller holds in full (the gate
               writes them to ?_fmsearch=, which the handler honours) */
import { readFileSync } from 'node:fs';

const ENTRIES = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

/* FOUR-EYES (ULM-DESIGN §8): a signed-in person's commit of a cash sheet or a
   merge is STORED as a proposal; someone else commits exactly what was stored,
   by its id. `commitNeeds`: classes the committer must hold at Full — whoever
   commits a merge that moves a cash balance must be able to see the money.
   `view`: how the Approvals page lays the stored payload out (a table of rows,
   or the two people of a merge) — the page reads it from the listing rather
   than recognising route addresses of its own. */
export const FOUR_EYES = Object.freeze({
  'POST /api/ledger/import/commit': {
    propose: 'cash.import', commit: 'cash.import.commit', commitNeeds: ['CASH'], view: 'rows',
    summary: (b) => `Import ${Array.isArray(b.rows) ? b.rows.length : 0} cash row(s), batch ${String(b.batch || '?').slice(0, 40)}`,
  },
  'POST /api/person/merge': {
    propose: 'identity.merge', commit: 'identity.merge', commitNeeds: ['CASH', 'MRG'], dryRunField: 'dry_run', view: 'merge',
    summary: (b) => `Fold person ${b.drop} into person ${b.keep}${b.why ? ` — ${String(b.why).slice(0, 120)}` : ''}`,
  },
});
for (const e of ENTRIES) {
  const f = FOUR_EYES[`${e.method} ${e.path}`];
  if (f) e.fourEyes = f;
}

const exact = new Map();
const patterns = [];
for (const e of ENTRIES) {
  const key = `${e.method} ${e.path}`;
  if (e.path.includes(':')) {
    const re = new RegExp(`^${e.path.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}$`);
    patterns.push({ method: e.method, re, entry: e });
  } else {
    exact.set(key, e);
  }
}

const SELF = { self: true, subject: 'SYS', carries: [], grain: 'none', fields: [], whole: [], fleet: 'global' };

export function lookupEntry(method, path) {
  const m = method === 'HEAD' ? 'GET' : method;
  /* A real segment after the prefix: '/api/auth/' alone is NOT a sign-in
     route. Express does not route strictly, so it answers '/api/auth/' with
     the credential banner at '/api/auth' — which this rule used to hand to
     the handler as self-deciding, past every check: an anonymous caller read
     every fleet's credential state with sign-in required (security review,
     2026-09-28). */
  if (/^\/api\/(auth|access)\/[^/]/.test(path)) return SELF;
  const e = exact.get(`${m} ${path}`);
  if (e) return e;
  for (const p of patterns) if (p.method === m && p.re.test(path)) return p.entry;
  return null;
}

export const allEntries = () => ENTRIES;
