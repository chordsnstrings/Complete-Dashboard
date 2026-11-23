/* Shaping an answer to what its reader may see.
   ─────────────────────────────────────────────────────────────────────────
   The route computes its full answer; this removes or masks what the caller
   does not hold, on the way out, and says what it withheld. Doing it after the
   route rather than inside 189 handlers is what lets the server's response
   cache keep ONE copy per URL: the cache holds the unshaped answer and every
   reader gets it shaped for them (ULM-DESIGN §9.2).

   Two kinds of rule:
     · the route's own field map (api/access/manifest.js), for classes that
       only that route knows how to find — a driver's name inside a revenue
       table, a cash balance on a person page;
     · a dictionary of key names that are unmistakable wherever they appear —
       a `phone`, an `emirates_id`, a `room_no`, a `raw` payload — applied to
       every answer at every depth, so a route whose map forgot one does not
       leak it.

   Withheld values become null (the page then says why, from `_withheld` and
   the x-fm-withheld header); masked values keep their real last characters.
   Nothing is ever replaced with an invented value. */
import { maskValue, rank, minLevel } from '../public/access_model.js';

/* Key names that mean one class wherever they occur. Lower-case; matched
   case-insensitively. */
export const DICT = Object.freeze({
  CT: ['phone', 'phone_number', 'mobile', 'mobile_number', 'email', 'email_address', 'whatsapp',
    'contact_phone', 'driver_phone', 'hr_phone', 'hr_email', 'phones', 'emails', 'phone_tail',
    /* The assistant's further numbers for one person (AG-15/AG-17): kept in
       the stored chat and re-shaped on every reload, so the key itself must
       be one the gate knows (the review of AG-17, 2026-11-23). */
    'other_phones'],
  DOC: ['emirates_id', 'eid', 'emirates_id_no', 'licence_no', 'license_no', 'licence_number',
    'license_number', 'driving_licence_no', 'passport_no', 'passport_number', 'visa_no', 'visa_number',
    'rta_permit_no', 'permit_no', 'placeholder_licence_no'],
  PAX: ['guest_id', 'guest_name', 'guest_ids', 'room_no', 'room_number', 'trip_purpose', 'passenger_name'],
  RAW: ['raw', 'raw_json', 'raw_payload', 'plan_text', 'body_starts'],
  CRED: ['password', 'client_secret', 'refresh_token', 'access_token', 'api_key', 'cookie', 'cookies',
    'secret', 'token_value', 'api_key_not_sent_to_this_host'],
});
const DICT_KEY = new Map();
for (const [cls, keys] of Object.entries(DICT)) for (const k of keys) DICT_KEY.set(k, cls);
export const dictClassOf = (key) => DICT_KEY.get(String(key).toLowerCase()) || null;

/* 'rows[].driver.name' → ['rows', '[]', 'driver', 'name']; '[].phone' → ['[]', 'phone'];
   '**.phone' → ['**', 'phone']; 'a.*.b' → ['a', '*', 'b']. */
export function parsePath(p) {
  const out = [];
  for (const part of String(p).split('.')) {
    if (!part) continue;
    let s = part;
    const arr = [];
    while (s.endsWith('[]')) { arr.push('[]'); s = s.slice(0, -2); }
    if (s) out.push(s);
    out.push(...arr);
  }
  return out;
}

/* Apply `fn` to every value the path reaches; returns the (mutated) node.
   Forgiving about arrays: a key step that meets an array applies to each
   element, so a map written as `rows.phone` still reaches `rows[].phone`. */
export function transform(node, toks, fn) {
  if (!toks.length) return fn(node);
  if (node == null || typeof node !== 'object') return node;
  const [t, ...rest] = toks;
  if (t === '[]') {
    if (Array.isArray(node)) for (let i = 0; i < node.length; i += 1) node[i] = transform(node[i], rest, fn);
    return node;
  }
  if (t === '*') {
    if (Array.isArray(node)) for (let i = 0; i < node.length; i += 1) node[i] = transform(node[i], rest, fn);
    else for (const k of Object.keys(node)) node[k] = transform(node[k], rest, fn);
    return node;
  }
  if (t === '**') return deep(node, rest, fn);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = transform(node[i], toks, fn);
    return node;
  }
  if (Object.prototype.hasOwnProperty.call(node, t)) node[t] = transform(node[t], rest, fn);
  return node;
}
function deep(node, rest, fn, depth = 0) {
  if (node == null || typeof node !== 'object' || depth > 40) return node;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = deep(node[i], rest, fn, depth + 1);
    return node;
  }
  for (const k of Object.keys(node)) {
    if (k === rest[0]) node[k] = transform(node[k], rest.slice(1), fn);
    else node[k] = deep(node[k], rest, fn, depth + 1);
  }
  return node;
}

/* What a withheld or masked value becomes. */
const hide = () => null;
const maskFor = (cls) => (v) => {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' || typeof x === 'number' ? maskValue(x, cls) : null));
  if (typeof v === 'object') return null;
  return maskValue(v, cls);
};

/* The dictionary, in one walk. `levels` are the caller's effective levels for
   this request. Records what it touched in `seen`. */
/* Nothing to withhold: null, '', and an empty list. An empty list marked
   "withheld" told the assistant a role could not see numbers that did not
   exist (the review of AG-17, 2026-11-23); an empty string never was. */
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
function applyDictionary(body, levels, seen, depth = 0, skip = null) {
  if (body == null || typeof body !== 'object' || depth > 40) return body;
  if (skip?.has(body)) return body;
  if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i += 1) body[i] = applyDictionary(body[i], levels, seen, depth + 1, skip);
    return body;
  }
  for (const k of Object.keys(body)) {
    const cls = DICT_KEY.get(k.toLowerCase());
    if (cls) {
      const l = levels[cls] || '';
      if (l === 'F') { body[k] = applyDictionary(body[k], levels, seen, depth + 1, skip); continue; }
      if (isEmpty(body[k])) continue;
      if (l === 'M') { body[k] = maskFor(cls)(body[k]); seen[cls] = 'M'; } else { body[k] = null; seen[cls] = l || ''; }
      continue;
    }
    body[k] = applyDictionary(body[k], levels, seen, depth + 1, skip);
  }
  return body;
}

/* STORED CHAT TABLES (AG-17, the review of 2026-11-23). The assistant keeps a
   conversation for a day and serves it again on every reload through
   GET /api/agent/state, whose own entry lifts nothing — so a wallet table the
   Cash desk had just been shown with each driver's number came back with the
   Phone column blank and "not shown to your role", beside a sentence quoting
   the number: a reason that was not the true one. A stored table names the
   route it came from (`source`, set by the tool, never by the model), and an
   entry marked `sourcedTables` shapes each such table at the levels THAT
   route would give this reader now — its lift included, so a reader who has
   since lost driver cash loses the numbers too. Everything else in the body
   is shaped at the reader's own levels as before. */
function shapeSourcedTables(body, levels, seen, lookup, skip, depth = 0) {
  if (body == null || typeof body !== 'object' || depth > 12) return;
  if (Array.isArray(body)) { for (const x of body) shapeSourcedTables(x, levels, seen, lookup, skip, depth + 1); return; }
  if (typeof body.source === 'string' && body.source.startsWith('/api/') && Array.isArray(body.rows) && Array.isArray(body.columns)) {
    const src = lookup('GET', body.source.split('?')[0]);
    const L2 = src && !src.self && src.lift ? liftLevels({ ...levels }, src) : levels;
    body.rows = applyDictionary(body.rows, L2, seen, 0, skip);
    skip.add(body.rows);
    return;
  }
  for (const k of Object.keys(body)) shapeSourcedTables(body[k], levels, seen, lookup, skip, depth + 1);
}

/* The whole shaping of one answer.
     body     the parsed JSON (mutated and returned)
     entry    the route's manifest entry
     levels   the caller's effective levels for this request
     fleets   the fleets the caller may see rows of (null = no row filter)
   Returns { body, withheld: { CLASS: level } }. */
const ROW_FILTERED = new Set(['rows', 'narrow']);
export function shapeBody(body, entry, levels, { fleets = null, lookup = null } = {}) {
  const withheld = {};
  if (body == null || typeof body !== 'object') return { body, withheld };
  for (const f of entry.fields || []) {
    const l = levels[f.class] || '';
    if (l === 'F') continue;
    const fn = l === 'M' ? maskFor(f.class) : hide;
    let touched = false;
    for (const p of f.paths || []) {
      body = transform(body, parsePath(p), (v) => {
        if (isEmpty(v)) return v;
        touched = true;
        return fn(v);
      });
    }
    if (touched) withheld[f.class] = l;
  }
  const skip = new WeakSet();
  if (entry.sourcedTables && lookup) shapeSourcedTables(body, levels, withheld, lookup, skip);
  body = applyDictionary(body, levels, withheld, 0, skip);
  /* 'narrow' too (api/access/one_fleet.js): its handler already answers for
     the one fleet, and where its rows carry the fleet this drops any row of
     another fleet all the same — a second line, not the first. */
  if (fleets && ROW_FILTERED.has(entry.fleet) && (entry.fleetRows || []).length) {
    const key = entry.fleetKey || 'fleet';
    const allowed = new Set(fleets);
    let dropped = 0;
    const keep = (arr) => {
      if (!Array.isArray(arr)) return arr;
      const out = arr.filter((x) => x && typeof x === 'object' && allowed.has(String(x[key] ?? x.fleet_id ?? x.fleet ?? '')));
      dropped += arr.length - out.length;
      return out;
    };
    for (const p of entry.fleetRows) {
      const toks = parsePath(p);
      if (toks[toks.length - 1] === '[]') toks.pop();
      if (!toks.length) { body = keep(body); continue; }
      body = transform(body, toks, keep);
    }
    if (dropped) withheld.FLEET = String(dropped);
  }
  if (!Array.isArray(body) && Object.keys(withheld).length) {
    body._withheld = withheld;
  }
  return { body, withheld };
}

/* Does this caller need any shaping at all on this route? The Owner never
   does, and skipping the parse keeps a cached answer a straight copy. */
export function needsShaping(entry, levels, { fleets = null } = {}) {
  for (const f of entry.fields || []) if ((levels[f.class] || '') !== 'F') return true;
  for (const cls of Object.keys(DICT)) if ((levels[cls] || '') !== 'F') return true;
  if (fleets && ROW_FILTERED.has(entry.fleet)) return true;
  return false;
}

export const atLeast = (l, min) => rank(l) >= rank(min);

/* A LIFT (AG-17, 2026-11-23). A manifest entry may say `lift: { CT: 'CASH' }`:
   on that route the reader sees the first class at the level they hold the
   second, where that is higher. Written for the PowerDrive wallets — the
   operator: "give everyone asking about powerdrive wallet access to phone
   number" — where the Cash desk holds driver cash but no contact details and
   was handed a list of debts with every number withheld.

   Four rules keep it from being a hole:
     · it only RAISES — a level is never lowered by a lift;
     · it may only lift TO the route's subject — the class the gate has just
       judged this reader on before answering at all (a list grain is refused
       below Masked) — held here and in test/access_manifest.test.mjs;
     · it never goes above the reader's level of ID. A phone number names
       its driver: a custom role holding driver cash without driver identity
       ({CASH:F, SYS:F} is a role an Access admin can make) would read every
       name withheld and every number whole, which ties each balance back to
       its driver (the review of AG-17, 2026-11-23). So the lift is to the
       lower of the subject and ID — with the identity masked, so are the
       numbers;
     · it is the route's: the same reader on any other route keeps their own
       level of the lifted class (the Cash desk still gets no number from the
       Compliance page).
   Mutates and returns `levels`. */
export function liftLevels(levels, entry) {
  for (const [cls, by] of Object.entries(entry?.lift || {})) {
    if (by !== entry.subject) continue;
    const to = minLevel(levels[by] || '', levels.ID || '');
    if (rank(to) > rank(levels[cls] || '')) levels[cls] = to;
  }
  return levels;
}
