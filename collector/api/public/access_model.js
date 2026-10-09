/* WHO MAY SEE WHAT — the one definition, shared by the server and the page.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §6 is the design this encodes: nineteen classes
   of data, four levels, fourteen built-in roles and the actions each may take.
   It lives in api/public/ so the browser imports the SAME object the server
   enforces with. Two copies — one deciding and one drawing — is how a page ends
   up offering a door the server then slams, or hiding one it would have
   opened; the server is the authority, and this file is only ever read by the
   page to draw what the server has already decided.

   No Node imports here: it is loaded by the browser as an ES module. */

/* The classes. `group` orders them in the Access screens; `plain` is the name
   a person reads in "not shown to your role: <plain>". */
export const CLASSES = Object.freeze([
  { code: 'ID', name: 'Driver identity', plain: 'driver names and ids', group: 'People',
    desc: 'Names, photos and platform ids of drivers' },
  { code: 'CT', name: 'Contact', plain: 'contact details', group: 'People',
    desc: 'Phone numbers and email addresses' },
  { code: 'DOC', name: 'ID documents', plain: 'ID document numbers', group: 'People',
    desc: 'Emirates ID, licence, passport and permit numbers and their expiry dates' },
  { code: 'EARN', name: 'Driver earnings', plain: 'what each driver earned', group: 'People',
    desc: 'Money earned per named driver' },
  { code: 'CASH', name: 'Driver cash', plain: 'driver cash', group: 'People',
    desc: 'Deposits, advances, salary lines, balances, the lending line and receipts' },
  { code: 'COND', name: 'Conduct', plain: 'driver conduct', group: 'People',
    desc: 'Safety events, ratings, quality and cancellations by driver' },
  { code: 'ACCUSE', name: 'Accusations', plain: 'who is named as a likely culprit', group: 'People',
    desc: 'Pages that name a person as the likely culprit, such as unbooked-trip attribution' },
  { code: 'REV', name: 'Revenue', plain: 'company revenue', group: 'Company',
    desc: 'Fleet-level trip value and money in' },
  { code: 'PAY', name: 'Payouts', plain: 'platform payouts', group: 'Company',
    desc: 'Platform payouts, bank transfers and reconciliation' },
  { code: 'BK', name: 'Bookings', plain: 'individual bookings', group: 'Company',
    desc: 'Trip rows' },
  { code: 'LOC', name: 'Location', plain: 'locations', group: 'Company',
    desc: 'Live positions, routes, pickup and drop-off places' },
  { code: 'VEH', name: 'Vehicles', plain: 'vehicles', group: 'Company',
    desc: 'Cars, utilisation and vehicle compliance' },
  { code: 'PAX', name: 'Passengers', plain: 'passenger details', group: 'Company',
    desc: 'Hotel guest ids, room numbers and trip purposes' },
  { code: 'HR', name: 'HR export', plain: 'HR records', group: 'Records',
    desc: 'Rows of the HR active-drivers export' },
  { code: 'MRG', name: 'Same-person decisions', plain: 'same-person decisions', group: 'Records',
    desc: 'Which records are one person, and merges' },
  { code: 'AUDIT', name: 'Audit log', plain: 'the audit log', group: 'Records',
    desc: 'Who saw and did what' },
  { code: 'CRED', name: 'Platform logins', plain: 'platform logins and collection controls', group: 'System',
    desc: 'Provider credentials, collector runs and probes' },
  { code: 'SYS', name: 'System health', plain: 'system health', group: 'System',
    desc: 'Sources, coverage and freshness' },
  { code: 'RAW', name: 'Raw records', plain: 'raw provider records', group: 'System',
    desc: 'Providers’ raw payloads and query diagnostics' },
]);
export const CLASS_CODES = Object.freeze(CLASSES.map((c) => c.code));
export const CLASS = Object.freeze(Object.fromEntries(CLASSES.map((c) => [c.code, c])));

/* Levels, weakest first. There is no pseudonymised level: the operator ruled
   "no fake ids, everything real" (2026-09-26). A role either sees the real
   value, the real value's last characters (M), totals only (A), or nothing —
   and nothing is always shown as absent with its reason. */
export const LEVELS = Object.freeze(['', 'A', 'M', 'F']);
export const LEVEL_NAME = Object.freeze({ F: 'Full', M: 'Masked', A: 'Totals only', '': 'Hidden' });
export const rank = (l) => Math.max(0, LEVELS.indexOf(l || ''));
export const maxLevel = (a, b) => (rank(a) >= rank(b) ? (a || '') : (b || ''));
export const minLevel = (a, b) => (rank(a) <= rank(b) ? (a || '') : (b || ''));

/* Actions. Reading is never implied by an action and an action is never
   implied by reading (§8). */
export const CAPS = Object.freeze([
  { code: 'cash.record', name: 'Record cash, advances and receipts', note: 'Re-confirm identity above the cash threshold' },
  { code: 'cash.import', name: 'Preview an imported cash sheet', note: 'Assigns rows to existing people only; never merges' },
  { code: 'cash.import.commit', name: 'Commit an imported cash sheet', note: 'Four-eyes: someone other than the preparer commits the stored preview' },
  { code: 'cash.policy', name: 'Move the lending line', note: 'A reason is required' },
  { code: 'finance.import', name: 'Import statement days', note: '' },
  { code: 'finance.verify', name: 'Ask Uber to confirm payouts', note: 'Uses Uber quota' },
  { code: 'hr.import', name: 'Import the HR export', note: 'Re-confirm identity on commit' },
  { code: 'identity.decide', name: 'Decide same-person pairs', note: '' },
  { code: 'identity.merge', name: 'Merge two people', note: 'Four-eyes; the approver must see cash if a balance moves' },
  { code: 'credentials.test', name: 'Test platform logins', note: '' },
  { code: 'credentials.write', name: 'Apply platform logins', note: 'Re-confirm identity; values are never shown back' },
  { code: 'fleets.link', name: 'Link platform accounts to fleets and choose fleet names', note: 'Changes who can see which rows; the Owner confirms' },
  { code: 'collector.run', name: 'Run collection now', note: '' },
  { code: 'collector.backfill', name: 'Run the 12-month backfill', note: 'Uses platform quota; one at a time' },
  { code: 'collector.probe', name: 'Probe a platform', note: 'Uses platform quota' },
  { code: 'analyst.run', name: 'Run the analyst', note: 'Sends a brief with real names to an outside AI model' },
  { code: 'calendar.edit', name: 'Add a calendar event', note: '' },
  { code: 'finding.own', name: 'Take and close a finding', note: 'Records who acted' },
  { code: 'access.manage', name: 'Invite people, grant and revoke access', note: 'Never above your own access; sensitive grants need a second Owner' },
  { code: 'export', name: 'Download CSV exports', note: 'Only of data you hold in full; stamped with your name and the time' },
  /* The chat assistant (api/agent_routes.js). Every person role holds it —
     "for now anyone" (the operator, 2026-10-09) — and it reads nothing a role
     cannot already read: each of its tools is that role's own GET. */
  { code: 'agent.ask', name: 'Ask the assistant', note: 'Reads only what this role can already see; remembers for 24 hours' },
]);
export const CAP_CODES = Object.freeze(CAPS.map((c) => c.code));
export const CAP = Object.freeze(Object.fromEntries(CAPS.map((c) => [c.code, c])));

const lv = (spec) => Object.freeze(Object.fromEntries(
  spec.trim().split(/\s+/).map((t) => { const [c, l = 'F'] = t.split(':'); return [c, l]; })));

/* The fourteen roles (§6.3). `levels` lists what the role holds; a class it
   does not list is hidden. `caps` lists the actions. The Owner holds every
   class at F and every action. `device` roles are held by a screen, never by
   a person. */
export const ROLES = Object.freeze([
  { code: 'OWN', name: 'Owner',
    desc: 'Runs the company. Sees and does everything, and is the only role that can hand out the sensitive grants.',
    levels: lv(CLASS_CODES.join(' ')), caps: CAP_CODES },
  { code: 'MGT', name: 'Management',
    desc: 'Senior managers. Everything except platform logins and raw records; ID documents and HR rows masked.',
    levels: lv('ID CT DOC:M EARN CASH COND ACCUSE REV PAY BK LOC VEH HR:M MRG SYS PAX'),
    caps: ['identity.decide', 'analyst.run', 'calendar.edit', 'finding.own', 'export', 'agent.ask'] },
  { code: 'FIN', name: 'Finance manager',
    desc: 'Money in and money out: revenue, platform payouts, driver earnings and driver cash.',
    levels: lv('ID CT EARN CASH REV PAY BK VEH SYS PAX'),
    caps: ['cash.record', 'cash.import', 'cash.import.commit', 'cash.policy', 'finance.import', 'finance.verify', 'export', 'agent.ask'] },
  { code: 'CLK', name: 'Cash desk',
    desc: 'Records cash handed in, advances and receipts. Sees drivers and their cash, nothing else.',
    levels: lv('ID CASH SYS'),
    caps: ['cash.record', 'cash.import', 'agent.ask'] },
  { code: 'OPS', name: 'Operations manager',
    desc: 'Runs the fleets day to day: drivers, trips, conduct, earnings and the live map.',
    levels: lv('ID CT EARN COND ACCUSE REV BK LOC VEH SYS PAX:A'),
    caps: ['collector.run', 'calendar.edit', 'finding.own', 'export', 'agent.ask'] },
  { code: 'DSP', name: 'Dispatcher',
    desc: 'Live map, bookings and driver contact. Conduct as totals only; no money.',
    levels: lv('ID CT COND:A BK LOC VEH SYS PAX:A'),
    caps: ['export', 'agent.ask'] },
  { code: 'HRO', name: 'HR officer',
    desc: 'ID documents, the HR export, conduct, and deciding who is the same person.',
    levels: lv('ID CT DOC HR MRG COND ACCUSE VEH SYS'),
    caps: ['hr.import', 'identity.decide', 'identity.merge', 'export', 'agent.ask'] },
  { code: 'SAF', name: 'Safety & compliance',
    desc: 'Conduct, safety events, bookings and positions. ID documents masked.',
    levels: lv('ID CT DOC:M COND ACCUSE BK LOC VEH SYS'),
    caps: ['finding.own', 'export', 'agent.ask'] },
  { code: 'TEC', name: 'Fleet technician',
    desc: 'Cars, positions and system health. Bookings as totals only.',
    levels: lv('ID VEH LOC SYS BK:A'),
    caps: ['export', 'agent.ask'] },
  { code: 'ANL', name: 'Analyst',
    desc: 'Performance and revenue analysis under real names. No contact, cash or documents.',
    levels: lv('ID EARN COND REV PAY BK LOC VEH SYS PAX:A'),
    caps: ['analyst.run', 'export', 'agent.ask'] },
  { code: 'AUD', name: 'Auditor',
    desc: 'A time-boxed, read-only review of nearly everything. Contact, documents and HR masked.',
    levels: lv('ID CT:M DOC:M EARN CASH COND ACCUSE REV PAY BK LOC VEH HR:M MRG SYS PAX:M AUDIT'),
    caps: ['agent.ask'], timeboxed: true },
  { code: 'ACC', name: 'Access admin',
    desc: 'Manages who has access and reads the audit log. Sees no business data.',
    levels: lv('SYS AUDIT'),
    caps: ['access.manage', 'agent.ask'] },
  { code: 'CON', name: 'Connections admin',
    desc: 'Manages platform logins and links accounts to fleets. Sees no driver.',
    levels: lv('CRED SYS'),
    caps: ['credentials.test', 'credentials.write', 'fleets.link', 'collector.run', 'collector.backfill', 'collector.probe', 'agent.ask'] },
  { code: 'WALL', name: 'Wall display',
    desc: 'A screen on the wall: company totals, live counts and freshness. A device, not a person.',
    levels: lv('REV SYS BK:A LOC:A VEH:A'),
    caps: [], device: true },
]);
export const ROLE = Object.freeze(Object.fromEntries(ROLES.map((r) => [r.code, r])));

/* What only two Owners together may hand out (§6.4). A grant of any role that
   confers one of these waits for a second Owner — or, where the company has a
   single Owner, for 24 hours with every Access admin told. */
export const SENSITIVE_CLASSES = Object.freeze({ DOC: 'F', CASH: 'A', CRED: 'A', ACCUSE: 'A', AUDIT: 'A', RAW: 'A' });
export const SENSITIVE_CAPS = Object.freeze(['access.manage', 'credentials.write', 'credentials.test', 'fleets.link']);
export function roleIsSensitive(role) {
  if (!role) return false;
  if (role.code === 'OWN') return true;
  if ((role.caps || []).some((c) => SENSITIVE_CAPS.includes(c))) return true;
  return Object.entries(SENSITIVE_CLASSES).some(([c, min]) => rank(role.levels?.[c]) >= rank(min));
}

/* Does `grantor` hold at least everything `role` would confer? The ceiling:
   nobody confers more than they hold (§6.4). `grantor` is a principal's
   effective levels + caps (all fleets). */
export function withinCeiling(grantor, role) {
  if (!role) return false;
  for (const c of CLASS_CODES) {
    if (rank(role.levels?.[c]) > rank(grantor.levels?.[c])) return false;
  }
  for (const cap of role.caps || []) if (!grantor.caps?.includes(cap)) return false;
  return true;
}

/* Masking a real value: its last characters stay, everything else becomes a
   bullet. Never a placeholder, never a made-up value (§2.2). */
export function maskValue(v, cls) {
  if (v == null || v === '') return v;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v);
  const keep = cls === 'CT' ? 2 : 4;
  if (s.length <= keep) return '•'.repeat(s.length);
  return `${'•'.repeat(Math.min(8, s.length - keep))}${s.slice(-keep)}`;
}

/* The sentence a page prints where something is withheld. `holders` is the
   list of role names that can see it, so the reader knows whom to ask. */
export function holdersOf(cls, min = 'A') {
  return ROLES.filter((r) => !r.device && rank(r.levels[cls]) >= rank(min)).map((r) => r.name);
}
export function withheldSentence(cls, { level = '', min = 'A' } = {}) {
  const c = CLASS[cls];
  const what = c ? c.plain : 'this';
  const who = holdersOf(cls, min).filter((n) => n !== 'Owner').slice(0, 3);
  if (level === 'A') return `Only totals of ${what} are shown to your role.`;
  if (level === 'M') return `${what[0].toUpperCase()}${what.slice(1)} are masked for your role.`;
  return `Not shown to your role: ${what}.${who.length ? ` ${who.join(', ')} and the Owner can see ${what}.` : ' The Owner can see them.'}`;
}
