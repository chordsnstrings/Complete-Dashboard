/* Every route, declared: what it is about, what it carries, who may call it.
   ─────────────────────────────────────────────────────────────────────────
   ULM-DESIGN §9.1. The entries themselves are in manifest.json — one per
   method + path, classified by reading each handler and the helpers behind
   it (see the header of that file's generator, bin/access-manifest.mjs).
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
     auditRead reading it is recorded in the audit log */
import { readFileSync } from 'node:fs';

const ENTRIES = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));

/* FOUR-EYES (ULM-DESIGN §8): a signed-in person's commit of a cash sheet or a
   merge is STORED as a proposal; someone else commits exactly what was stored,
   by its id. `commitNeeds`: classes the committer must hold at Full — whoever
   commits a merge that moves a cash balance must be able to see the money. */
export const FOUR_EYES = Object.freeze({
  'POST /api/ledger/import/commit': {
    propose: 'cash.import', commit: 'cash.import.commit', commitNeeds: ['CASH'],
    summary: (b) => `Import ${Array.isArray(b.rows) ? b.rows.length : 0} cash row(s), batch ${String(b.batch || '?').slice(0, 40)}`,
  },
  'POST /api/person/merge': {
    propose: 'identity.merge', commit: 'identity.merge', commitNeeds: ['CASH', 'MRG'], dryRunField: 'dry_run',
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
  if (path.startsWith('/api/auth/') || path.startsWith('/api/access/')) return SELF;
  const e = exact.get(`${m} ${path}`);
  if (e) return e;
  for (const p of patterns) if (p.method === m && p.re.test(path)) return p.entry;
  return null;
}

export const allEntries = () => ENTRIES;
