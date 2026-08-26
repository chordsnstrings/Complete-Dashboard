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
  if (res.status === 401 || res.status === 403) {
    return { reason: `${res.status} from ${sent} — the credential was refused`, kind: 'expired' };
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
