/* Did the provider authenticate us, or just fail to say no?
   ─────────────────────────────────────────────────────────────────────────
   Every credential in this deployment can stop working, and only one of them
   announces it. The OAuth grant returns an error; the FMS and CABMAN logins
   return a status. The Uber WEB SESSION — the cookie that the supplier GraphQL
   surface authenticates with, and the one that carries every earnings figure
   for both fleets — announces nothing at all.

   Measured live on 2026-08-26. With the `sid` cookie removed, the request to
   supplier.uber.com/graphql follows a redirect to auth.uber.com and answers
   404 "Not Found". The collector parses that as JSON, fails, reads
   `data.errors` (undefined) and `data.data.getEarnerBreakdownsV2` (undefined)
   and returns no error and no rows — which is precisely the shape of a week in
   which nobody drove. The run records 'ok'. So the most perishable credential
   here could expire on a Friday and every page would go on reporting healthy
   sources through the weekend while the money stopped arriving.

   Which cookie matters was measured too, because guessing would have produced
   a warning nobody could trust. Dropping `sid` or `csid` from either fleet's
   jar redirects to the login page; dropping `sp-jwt-session` or `jwt-session`
   changes nothing — both fleets keep answering 200 with data. That last point
   is worth stating plainly: `sp-jwt-session` is the only dated thing in the
   jar and it is NOT the session. Egari's `jwt-session` expired three hours
   before this was written and Egari collected normally throughout. A warning
   driven off those dates would have cried wolf on a working fleet, so nothing
   here reads them.

   What is left is honest and observable: a response that redirected off the
   host it was sent to, a 401 or 403, or a body that is not the JSON the caller
   asked for, is an authentication failure and not an empty window. */

import { http } from './http.js';
import { get, SETTING_DEFAULTS } from './settings.js';

/** Hosts a provider redirects to when it wants a human to log in again. */
const LOGIN_HOST = /(^|\.)(auth|login|accounts|signin|sso)\./i;

/**
 * Classify one HTTP response as an authentication failure, or not.
 * Takes what src/http.js returns plus the URL the request was SENT to.
 * Returns null when nothing about the response says "you are not logged in".
 */
export function authFailure(url, res, { expectJson = true } = {}) {
  if (!res) return null;
  const host = (u) => { try { return new URL(u).host; } catch { return null; } };
  const sent = host(url);
  const landed = host(res.finalUrl || url);

  /* Redirected somewhere else entirely. fetch follows redirects by default, so
     by the time a caller sees this the 302 is long gone and only the final URL
     records that it happened — which is why http() has to hand it back. */
  if (landed && sent && landed !== sent) {
    return { reason: LOGIN_HOST.test(landed) || /uber\.com$/.test(landed)
      ? `redirected to ${landed} — the session is no longer signed in`
      : `redirected to ${landed}`, kind: 'expired' };
  }
  /* The provider's own words, where it gave any. "403 from api.uber.com" sends
     somebody to read a log; "403 — bad key" tells them which credential. */
  if (res.status === 401 || res.status === 403) {
    const said = providerWords(res.data);
    return {
      reason: `${res.status} from ${sent} — ${said || 'the credential was refused'}`,
      kind: 'expired',
      /* WHICH credential, as far as a status code can say. 401 is "we do not
         know who you are" — the token or the secret behind it. 403 is "we know
         you and you may not have this" — and on these surfaces the thing being
         asked for is selected by the org key in the query string. Uber calls
         that key a key, and answers a wrong one with exactly "bad key". */
      blames: res.status === 401 ? 'token' : 'resource',
    };
  }
  /* A JSON caller that got something else. A provider that means "no data"
     says so in the shape it promised; HTML is a login page or an error page,
     and either way nobody authenticated us. */
  if (expectJson && typeof res.data === 'string' && res.data.trim()) {
    const head = res.data.trim().slice(0, 60).replace(/\s+/g, ' ');
    return { reason: `answered ${res.status} with ${/^</.test(head) ? 'a web page' : 'text'}, not JSON: ${head}`,
      kind: 'expired' };
  }
  return null;
}

/** Whatever the provider said, from the shapes these APIs actually use. */
function providerWords(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.trim().slice(0, 120) || null;
  const m = data.message || data.error_description || data.error?.message
    || data.error || data.detail || data.errors?.[0]?.message;
  const text = typeof m === 'string' ? m : null;
  const code = typeof data.code === 'string' ? data.code : null;
  if (text && code && !text.includes(code)) return `${text} (${code})`;
  return text || code || null;
}

/* Messages a provider sends INSIDE a well-formed response when the credential
   is the problem. Kept narrow on purpose: a pattern that also matches ordinary
   refusals would turn every rate limit into a red banner, and a banner that is
   sometimes wrong is one nobody reads. */
const AUTH_WORDS = /unauthenticated|unauthorized|not.?authorized|invalid.token|token.(has )?expired|session.expired|expired.(token|session)|permission.denied|forbidden|login.required|credentials/i;

/** Does a provider's own error message say the credential is at fault? */
export function saysAuth(message) {
  return !!message && AUTH_WORDS.test(String(message));
}

/** Record what was observed. Never throws — a banner is not worth a run. */
export async function noteCredential(db, { provider, fleet = '*', credential,
  state, detail = null, surface = null }) {
  try {
    await db.query(
      `INSERT INTO credential_state
         (provider, fleet_id, credential, state, detail, surface, last_ok_at, checked_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4 = 'ok' THEN now() ELSE NULL END, now())
       ON CONFLICT (provider, fleet_id, credential) DO UPDATE SET
         state = EXCLUDED.state, detail = EXCLUDED.detail, surface = EXCLUDED.surface,
         /* last_ok_at is never cleared by a failure: it is the half of the
            message that makes the other half actionable. */
         last_ok_at = CASE WHEN EXCLUDED.state = 'ok' THEN now()
                           ELSE credential_state.last_ok_at END,
         checked_at = now()`,
      [provider, fleet, credential, state, detail && String(detail).slice(0, 240), surface]);
  } catch { /* the table may not exist yet on a database mid-migration */ }
}

/* The Uber OAuth REST surfaces, which fail in a way the token grant cannot see.
   ─────────────────────────────────────────────────────────────────────────
   uberOAuthToken() succeeds — the client credentials are fine — and then every
   data call for one of the two orgs answers 403 with {"code":
   "rtapi.internal_server_error","message":"bad key"}. Measured on production
   2026-08-26: the collector logs one successful roster of 113 drivers followed
   by one 403, twice a minute, and the same 403 on earners/payments. collect()
   walks the orgs in order, Ecosine first, so the refusal belongs to the second
   — and it is why that fleet's REST earnings surface has never returned a row.

   The credential at fault is the ORG KEY, not the secret. These endpoints
   select what you are asking for with org_id in the query string, so a 403
   means "you may not have this one", and Uber names the field a key in its own
   refusal. A 401 would mean the token itself, which is a different credential
   and a different fix, so the two are recorded separately rather than both
   being reported as "Uber is broken".

   Called after every REST call rather than only on failure: a well-formed
   answer IS the proof the key works, and a banner that can only ever go red
   never goes green again. */
export function uberOrgCredential(fleet) {
  return fleet === 'egari' ? 'UBER_ORG_ENCRYPTED_EGARI' : 'UBER_ORG_ENCRYPTED';
}

/* Which organisations this OAuth client can reach at all.
   ─────────────────────────────────────────────────────────────────────────
   /v1/vehicle-suppliers/orgs is the one REST surface that takes no org_id, so
   it is the only one that can say what a valid org_id is — and it answers with
   exactly the string UBER_ORG_ENCRYPTED wants. (`orgs`, not `organizations`:
   five other spellings answer 404. Measured 2026-08-26.)

   Asked once and cached, and only when something has already been refused:
   the point is to turn "bad key" into a sentence somebody can act on. On this
   deployment it answers with one organisation, ECOSINE TRANSPORTS, which means
   no value of UBER_ORG_ENCRYPTED_EGARI can ever work — the fleet is not on
   this API client, and the fix is an Uber account change rather than a string
   somebody has not found yet. That is a different errand, and a banner that
   sends an operator on the wrong one costs more than saying nothing. */
/* Cached per CLIENT, not once.
   ─────────────────────────────────────────────────────────────────────────
   A single slot was right while one client served both fleets. With a client
   per fleet it would answer the second fleet's question with the first
   client's org list — and this cache exists precisely to tell an operator
   which orgs their client can see, so a wrong answer here sends them on the
   errand the whole comment above is about avoiding. */
const orgLists = new Map();
async function knownOrgs(token, key = 'shared') {
  if (orgLists.has(key)) return orgLists.get(key);
  try {
    const { data } = await http(get('UBER_ORGS_URL', SETTING_DEFAULTS.UBER_ORGS_URL),
      { headers: { authorization: `Bearer ${token}` }, timeoutMs: 20000, retries: 0 });
    const rows = data?.organizations || data?.orgs || [];
    if (Array.isArray(rows) && rows.length) {
      orgLists.set(key, rows.map((r) => r.name || r.id).filter(Boolean));
    }
  } catch { /* a diagnosis is not worth failing a run for */ }
  return orgLists.get(key) || null;
}

export async function noteUberRest(db, url, res, o, surface, token = null) {
  const bad = authFailure(url, res);
  const fleet = o?.fleet || '*';
  /* Whichever secret actually signed this call. Blaming UBER_CLIENT_SECRET for
     a grant made with UBER_CLIENT_SECRET_EGARI would point an operator at a
     working credential. */
  const secretKey = o?.oauth?.secretKey || 'UBER_CLIENT_SECRET';
  const cred = bad?.blames === 'token' ? secretKey : uberOrgCredential(fleet);
  let detail = bad ? bad.reason : null;
  /* A 403 means the org_id was refused. Naming what this client CAN see turns
     "find the right string" into "this fleet is not on this credential" — and
     now into one of two different errands, because the remedy depends on
     whether this fleet has a client of its own. Sharing one means the fix is at
     Uber's end (register or grant); having its own and still being refused
     means the application exists but is pointed at the wrong org. */
  if (bad && bad.blames === 'resource' && token) {
    const orgs = await knownOrgs(token, o?.oauth?.clientId || 'shared');
    if (orgs?.length) {
      detail += ` — this API client covers only ${orgs.join(', ')}, so no org id `
        + 'will work for this fleet until ';
      detail += o?.oauth?.own
        ? `the ${o.oauth.idKey} application is granted access to this org`
        : `this fleet gets its own Uber application (set ${uberClientKeys(fleet).id}`
          + ` and ${uberClientKeys(fleet).secret}) or Uber grants the shared client access to it`;
    }
  }
  await noteCredential(db, {
    provider: 'uber', fleet: bad?.blames === 'token' ? (o?.oauth?.own ? fleet : '*') : fleet,
    credential: cred,
    state: bad ? 'expired' : 'ok',
    detail,
    surface: `oauth rest ${surface}`,
  });
  return bad;
}

/* The setting names a fleet's own OAuth application would live under. Written
   once so the banner cannot invent a key that does not exist. */
export const uberClientKeys = (fleet) => (fleet === 'ecosine' || !fleet
  ? { id: 'UBER_CLIENT_ID', secret: 'UBER_CLIENT_SECRET' }
  : { id: `UBER_CLIENT_ID_${fleet.toUpperCase()}`, secret: `UBER_CLIENT_SECRET_${fleet.toUpperCase()}` });
