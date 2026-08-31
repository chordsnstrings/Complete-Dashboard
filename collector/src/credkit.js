/* What did the operator just paste?
   ─────────────────────────────────────────────────────────────────────────
   Every provider here hands its credential over in a different shape, and the
   operator gets it the same way every time: open the provider's dashboard,
   open devtools, copy. What comes back is a cookie jar, or a bare JWT, or a
   curl command with both inside it. Today that has to be read by a person,
   matched to one of thirty-four keys, and pasted into the right box — and the
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
export const keyFor = (base, fleet) => {
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

  /* Uber: an OAuth application — a client id and a client secret, together.
     ─────────────────────────────────────────────────────────────────────────
     This is the one credential here that is not a session and not a token: it
     is a registered application, and an application is registered UNDER one
     organisation. That is why the Egari half of this fleet spent months
     answering 403 to every REST call — one client pair was shared by both
     businesses, and `/v1/vehicle-suppliers/orgs` on it returned exactly one
     org. Not a credential that expired; a client that was never scoped to the
     second business. The fix is a second application, and this is what the
     operator has in their hand when they get one.

     Two properties make this different from every recogniser above, and both
     shape what it returns:

     IT IS A PAIR, IN ONE BLOCK. The other credentials are one opaque string
     each, so a block holds one of them. An application is two strings that
     mean nothing apart, and they arrive on adjacent lines with no blank line
     between — one block, two values, three settings keys once the org is
     known.

     IT CANNOT BE READ. A Bolt token carries its fleet owner id and an Uber
     cookie carries its org uuid, so those recognisers DECODE the credential
     and name it exactly. An OAuth pair carries nothing: two opaque
     base64-ish strings, and the id and the secret are not reliably told apart
     by length — this fleet's own two clients have 32/115 and 32/40. So this
     recogniser deliberately does NOT decide which is which, and does not
     decide the fleet. It hands both strings to the live check, which performs
     the grant, asks Uber which organisation the client can reach, and comes
     back with the answer. Guessing and being wrong would write an Ecosine
     client into Egari's slot, which is the exact failure this module exists
     to prevent.

     The labels are read where they exist, as a HINT for which order to try
     first — not as the answer. */
  (raw) => {
    const s = deCmd(raw);
    /* Not inside a cookie jar, a JWT or a URL: those are other recognisers'
       credentials, and a `sid=` value is 32 opaque characters too. */
    if (/\beyJ[A-Za-z0-9_-]+\./.test(s)) return null;
    if (/(?:^|[\s;])(?:sid|Session_id|sp-jwt-session)=/.test(s)) return null;

    /* Uber writes both halves in the URL-safe base64 alphabet. 28 is the
       floor because this fleet's shortest real half is 32 and a shorter
       opaque string is far more likely to be something else. */
    const OPAQUE = /[A-Za-z0-9_-]{28,200}/g;
    const lines = s.split(/\r?\n/);
    const seen = new Map();          // value → the label on its own line
    for (const line of lines) {
      /* Everything before the first colon or equals is the label, when there
         is one. "uber egari client secret : <the secret>" is how it arrives. */
      const at = line.search(/[:=]/);
      const label = (at > 0 ? line.slice(0, at) : '').toLowerCase();
      const rest = at > 0 ? line.slice(at + 1) : line;
      for (const m of rest.match(OPAQUE) || []) {
        if (!seen.has(m)) seen.set(m, label);
      }
    }
    const tokens = [...seen.keys()];
    if (tokens.length !== 2) return null;

    const labelOf = (t) => seen.get(t) || '';
    const isSecret = (t) => /secret|client[_ -]?secret/.test(labelOf(t));
    const isId = (t) => /\b(?:client|application|app)[_ -]?id\b|\bclient[_ -]?id\b/.test(labelOf(t));

    /* The order to try first. A label decides it where there is one;
       otherwise Uber's client id is 32 characters and its secret is longer,
       which is true of both of this fleet's clients and is only ever a
       preference — the check tries the other way round if this fails. */
    let [id, secret] = tokens;
    if (isSecret(id) || isId(secret)) [id, secret] = [secret, id];
    else if (!isSecret(secret) && !isId(id) && id.length > secret.length) [id, secret] = [secret, id];

    /* A fleet NAMED in the paste is a hint for the message, never the answer:
       the grant is what decides, and it can contradict this. */
    const said = /\begari\b/i.test(s) ? 'egari' : /\becosine\b/i.test(s) ? 'ecosine' : null;

    return {
      provider: 'Uber',
      kind: 'oauth',
      /* No key yet, and that is deliberate — the key depends on which fleet
         the grant turns out to be for. checkUberOAuth fills `keys` in. */
      key: null,
      fleet: said,
      value: id,
      secret,
      said_fleet: said,
      /* `ok` is what stops a candidate before the check. A pair reaches the
         check precisely BECAUSE it cannot be named without one. */
      ok: true,
      why: said
        ? `an Uber OAuth application, labelled ${said} — the grant will confirm which org it reaches`
        : 'an Uber OAuth application — the grant will say which org it reaches, and that names the fleet',
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
      /* A recogniser that already knows whether its find is usable says so.
         Every credential above is named or it is nothing, so `ok` follows
         from having a key — but an OAuth pair reaches the live check
         PRECISELY because it cannot be named without one, and deriving `ok`
         from a key it does not have yet would drop it before it was tried. */
      found.push({ ...hit, ok: hit.ok !== undefined ? hit.ok : Boolean(hit.key) });
      break;                       // one credential per block
    }
  }
  /* A pair split across blocks.
     ─────────────────────────────────────────────────────────────────────────
     Every other credential here is one string, so a blank line between two of
     them separates two credentials. An OAuth application is two strings that
     mean nothing apart, and an operator who pastes them with a blank line
     between — or who copies them out of two fields — has still pasted one
     credential. So if no block yielded a pair, the whole text is offered to
     that one recogniser as a single block. It still needs to find exactly two
     opaque strings in it, so a paste holding a pair AND something else does
     not become a pair by accident. */
  if (!found.some((f) => f.kind === 'oauth')) {
    const whole = String(text || '').trim();
    for (const fn of RECOGNISERS) {
      let hit = null;
      try { hit = fn(whole); } catch { hit = null; }
      if (hit?.kind !== 'oauth') continue;
      /* …and only if neither half is already spoken for by a credential a
         block-level recogniser named outright. */
      const claimed = found.some((f) => String(f.value || '').includes(hit.value)
        || String(f.value || '').includes(hit.secret));
      if (!claimed) found.push({ ...hit, ok: true });
      break;
    }
  }
  /* The same key twice in one paste is a mistake worth refusing rather than
     resolving: two Uber cookies for the same org means one of them is stale
     and this cannot tell which. */
  const seen = new Map();
  for (const f of found) {
    /* A pair has no key yet — the check answers which one — so it is deduped
       on what it IS instead. Two Uber applications in one paste are two claims
       on the same three settings, and letting both through means two grants,
       two writes, and the second one winning for no reason anybody chose.

       On its own field, not on `key`: `key` is what the page prints in the
       "goes to" column, and a synthetic one would be rendered to an operator
       as the name of a setting that does not exist. */
    const id = f.key || (f.kind ? `${f.provider}:${f.kind}:${f.fleet || '?'}` : null);
    if (!id) continue;
    if (seen.has(id)) {
      f.ok = false;
      f.why += ' — and another block in this paste claims the same key, so neither is applied';
      seen.get(id).ok = false;
      seen.get(id).why += ' — and another block in this paste claims the same key, so neither is applied';
    } else seen.set(id, f);
  }
  return found;
}

/** What a paste did NOT explain: blocks nothing recognised. These are what a
    model is asked about, and what a person is shown when it cannot help. */
export function unrecognised(text) {
  /* BOTH halves of a pair, not just the one in `value`.
     ─────────────────────────────────────────────────────────────────────────
     Every other credential is one string, so `value` is the whole of it. An
     OAuth application is two, and filtering on `value` alone left the secret's
     block looking like something nothing understood — which sent a live client
     secret to the model to be identified, and drew a second, red row on the
     page for a credential that had just been accepted. */
  const named = new Set(recognise(text).flatMap((f) => [f.value, f.secret]).filter(Boolean));
  /* Compared against the DE-ESCAPED block. A Windows curl's jar is read
     through deCmd, so its value never appears literally in the raw text, and
     an already-recognised paste would otherwise be handed to the model a
     second time as if nothing had understood it. */
  return splitBlocks(text).filter((b) => {
    const plain = deCmd(b);
    return ![...named].some((v) => b.includes(v.slice(0, 40)) || plain.includes(v.slice(0, 40)));
  });
}
