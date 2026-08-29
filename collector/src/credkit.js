/* What did the operator just paste?
   ─────────────────────────────────────────────────────────────────────────
   Every provider here hands its credential over in a different shape, and the
   operator gets it the same way every time: open the provider's dashboard,
   open devtools, copy. What comes back is a cookie jar, or a bare JWT, or a
   curl command with both inside it. Today that has to be read by a person,
   matched to one of twenty-four keys, and pasted into the right box — and the
   fleet has two businesses on the same providers, so half those keys come in
   pairs that differ by a suffix and are indistinguishable by eye.

   Getting it wrong is not a typo. Pasting the Egari cookie into
   UBER_WEB_COOKIE points the Ecosine collector at the wrong organisation, and
   Uber answers happily — with another org's trips.

   So the credential says which one it is, and this reads it:

     Bolt      a JWT whose payload carries `fleet_owner_id`. The number is the
               fleet: config.bolt.companies maps 173999 to ecosine and 174036
               to egari, and that mapping already exists because the collector
               needs it.
     Uber      a cookie jar containing `sp-jwt-session`, whose payload carries
               `supplierOrgUUID`. That uuid IS the org, and comparing it with
               UBER_ORG_UUID / UBER_ORG_UUID_EGARI names the fleet with no
               guessing at all.
     Yango     a Yandex jar: `Session_id` plus `yandex_login`.
     FMS/CABMAN/Hotel — user:pass or a bearer token, which carry no identity
               of their own and are the one case a human still has to label.

   Nothing here is a heuristic over the whole blob. Each recogniser looks for
   a specific field, decodes it, and either identifies the credential exactly
   or declines. Declining is the important half: a credential this cannot name
   must reach a person, not a best guess. */
import { config } from './config.js';
import { get, SETTING_DEFS } from './settings.js';

/* ── the pieces a paste is made of ─────────────────────────────────────── */

/** A JWT's payload, or null. No signature check: the provider does that, and
    this only needs to read the claim that says whose token it is. */
export function jwtPayload(token) {
  const m = String(token || '').trim().match(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/);
  if (!m) return null;
  try {
    const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64 + '='.repeat((4 - b64.length % 4) % 4), 'base64').toString('utf8'));
  } catch { return null; }
}

/** Cookie jar → map. Splits on `; ` only where a NAME= follows, because
    values contain semicolons of their own (Yandex's `yp` and `ymex` do). */
export function cookieMap(text) {
  const out = {};
  for (const part of String(text || '').split(/;\s*(?=[A-Za-z_][A-Za-z0-9_.\-]*=)/)) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** The cookie header out of a pasted curl command, or the text itself. */
/* Windows cmd, unescaped.
   ─────────────────────────────────────────────────────────────────────────
   Chrome's "Copy as cURL (cmd)" is what a Windows operator actually has on
   the clipboard, and it is not the POSIX form. Every quote arrives as `^"`,
   every `%` as `^%^`, every `$` as `^$`, and each line ends in a bare `^`
   continuation:

       -b ^"sid=QA...; utag_main__ss=0^%^3Bexp-session^" ^

   In cmd a caret escapes exactly one following character, so collapsing every
   `^X` to `X` — after joining the continued lines — restores the original
   string, `^%^3B` included: the first caret releases the `%`, the second the
   `3`. A caret that survived as data was written `^^` by the same rule and
   collapses to one.

   Applied only when the text actually carries `^"`, so a POSIX curl with
   single quotes, or a bare cookie jar pasted on its own, is left untouched. */
export function deCmd(text) {
  const s = String(text || '');
  if (!s.includes('^"')) return s;
  return s.replace(/\^\r?\n\s*/g, ' ').replace(/\^([\s\S])/g, '$1');
}

/* The cookie jar out of whatever it arrived inside: a POSIX curl, a Windows
   curl, a raw `cookie:` header, or the jar on its own. `--cookie`/`-b` is
   preferred over a `cookie:` header because a curl carrying both puts the
   real jar in the flag. */
export function cookieText(text) {
  const s = deCmd(text);
  const m = s.match(/(?:^|\s)(?:-b|--cookie)\s+'([^']+)'/)
    || s.match(/(?:^|\s)(?:-b|--cookie)\s+"((?:[^"\\]|\\.)+)"/)
    || s.match(/(?:^|\s)(?:-b|--cookie)\s+([^\s'"][^\s]*)/)
    || s.match(/["\s]cookie:\s*([^"\n]+)/i)
    || s.match(/cookie:\s*([^\n]+)/i);
  return (m ? m[1] : s).trim();
}

/* What a pasted curl was calling, which is how a credential that carries no
   org of its own can still be attributed to a provider. */
export function curlUrl(text) {
  const s = deCmd(text);
  const m = s.match(/(?:--url|curl)\s+"(https?:\/\/[^"\s]+)"/)
    || s.match(/(?:--url|curl)\s+'(https?:\/\/[^'\s]+)'/)
    || s.match(/(?:--url|curl)\s+(https?:\/\/\S+)/);
  return m ? m[1] : null;
}

/* ── the recognisers ───────────────────────────────────────────────────── */

const fleetOfBoltOwner = (id) =>
  (config.bolt.companies || []).find((c) => String(c.userId) === String(id))?.fleet || null;

/* The org uuid is compared with what is already configured, so a fleet is
   named by the settings the collector uses rather than by a list written down
   twice. An org that matches neither is reported as unknown — which is the
   right answer for a third business nobody has configured yet. */
function fleetOfUberOrg(uuid) {
  const u = String(uuid || '').toLowerCase();
  if (!u) return null;
  if (u === String(get('UBER_ORG_UUID') || '').toLowerCase()) return 'ecosine';
  if (u === String(get('UBER_ORG_UUID_EGARI') || '').toLowerCase()) return 'egari';
  return null;
}

/* The per-fleet suffix is NOT one convention.
   ─────────────────────────────────────────────────────────────────────────
   Uber's second fleet is UBER_WEB_COOKIE_EGARI and its first is the bare
   UBER_WEB_COOKIE; Bolt has BOLT_REFRESH_TOKEN_ECOSINE *and*
   BOLT_REFRESH_TOKEN_EGARI, with the bare BOLT_REFRESH_TOKEN kept only as the
   legacy shared fallback. A rule invented here got Bolt wrong immediately, so
   the key is resolved against the product's own catalogue instead: the
   suffixed name if the catalogue declares one, the bare name otherwise, and
   nothing at all if neither exists. */
const KNOWN = new Set(SETTING_DEFS.map((d) => d.key));
const keyFor = (base, fleet) => {
  const suffixed = `${base}_${String(fleet || '').toUpperCase()}`;
  if (fleet && KNOWN.has(suffixed)) return suffixed;
  return KNOWN.has(base) ? base : null;
};

const RECOGNISERS = [
  /* Bolt: a fleet-owner portal token. */
  (raw) => {
    const p = jwtPayload(raw);
    const owner = p?.data?.fleet_owner_id;
    if (owner == null) return null;
    const fleet = fleetOfBoltOwner(owner);
    return {
      provider: 'Bolt',
      key: fleet ? keyFor('BOLT_REFRESH_TOKEN', fleet) : null,
      fleet,
      value: String(raw).trim().match(/\beyJ[A-Za-z0-9_.-]+/)[0],
      expires_at: p.exp ? new Date(p.exp * 1000).toISOString() : null,
      why: fleet
        ? `a Bolt portal token for fleet owner ${owner}, which config.bolt.companies maps to ${fleet}`
        : `a Bolt portal token for fleet owner ${owner}, which is not one of this fleet's two Bolt companies`,
    };
  },

  /* Uber: a supplier.uber.com session, identified by the org inside it. */
  (raw) => {
    const jar = cookieMap(cookieText(raw));
    if (!jar['sp-jwt-session'] || !jar.sid) return null;
    const p = jwtPayload(jar['sp-jwt-session']);
    const org = p?.data?.supplierOrgUUID;
    const fleet = fleetOfUberOrg(org);
    return {
      provider: 'Uber',
      key: fleet ? keyFor('UBER_WEB_COOKIE', fleet) : null,
      fleet,
      value: cookieText(raw),
      org_uuid: org || null,
      expires_at: p?.exp ? new Date(p.exp * 1000).toISOString() : null,
      why: fleet
        ? `an Uber supplier session for org ${org}, which is this fleet's ${fleet} org`
        : `an Uber supplier session for org ${org || 'unknown'}, which matches neither configured org`,
    };
  },

  /* Yango: a Yandex session. */
  (raw) => {
    const jar = cookieMap(cookieText(raw));
    if (!jar.Session_id || !jar.yandex_login) return null;
    return {
      provider: 'Yango',
      key: keyFor('YANGO_COOKIE', config.yango.fleet),
      fleet: config.yango.fleet || 'ecosine',
      value: cookieText(raw),
      account: jar.yandex_login,
      why: `a Yandex fleet session for ${jar.yandex_login}`,
    };
  },
];

/* A paste may hold several credentials, one per block. Blocks are separated by
   a blank line, which is how they arrive when somebody copies four of them in
   one go — and each block is offered to every recogniser, so their order in
   the paste does not matter and neither does any label around them. */
export function splitBlocks(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter((b) => b.length > 20);
}

/** Every credential a paste contains, named where it can be named. */
export function recognise(text) {
  const found = [];
  for (const block of splitBlocks(text)) {
    for (const fn of RECOGNISERS) {
      let hit = null;
      try { hit = fn(block); } catch { hit = null; }
      if (!hit) continue;
      found.push({ ...hit, ok: Boolean(hit.key) });
      break;                       // one credential per block
    }
  }
  /* The same key twice in one paste is a mistake worth refusing rather than
     resolving: two Uber cookies for the same org means one of them is stale
     and this cannot tell which. */
  const seen = new Map();
  for (const f of found) {
    if (!f.key) continue;
    if (seen.has(f.key)) {
      f.ok = false;
      f.why += ' — and another block in this paste claims the same key, so neither is applied';
      seen.get(f.key).ok = false;
      seen.get(f.key).why += ' — and another block in this paste claims the same key, so neither is applied';
    } else seen.set(f.key, f);
  }
  return found;
}

/** What a paste did NOT explain: blocks nothing recognised. These are what a
    model is asked about, and what a person is shown when it cannot help. */
export function unrecognised(text) {
  const named = new Set(recognise(text).map((f) => f.value));
  /* Compared against the DE-ESCAPED block. A Windows curl's jar is read
     through deCmd, so its value never appears literally in the raw text, and
     an already-recognised paste would otherwise be handed to the model a
     second time as if nothing had understood it. */
  return splitBlocks(text).filter((b) => {
    const plain = deCmd(b);
    return ![...named].some((v) => b.includes(v.slice(0, 40)) || plain.includes(v.slice(0, 40)));
  });
}
