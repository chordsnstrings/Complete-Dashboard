// Uber auth: OAuth client_credentials token (30-day, auto-refreshed) for api.uber.com,
// plus the supplier web-session cookie (fleethub.uber.com) supplied via env.

/* WHERE the supplier surface lives, in one place.
   ─────────────────────────────────────────────────────────────────────────
   Uber moved it. supplier.uber.com now answers 301 to fleethub.uber.com on
   every path this collector uses — /graphql, /chronicle/graphql and the
   reports API — and a POST does not survive a 301: it degrades to a GET,
   lands on the login page and comes back 404. authFailure() read that as
   "redirected to auth.uber.com — the session is no longer signed in", so the
   product spent days reporting an expired credential for a renamed host,
   while the cookie in the settings was perfectly good.

   Measured 2026-09-02 with a freshly captured Ecosine session: against
   fleethub the same request answers 200 with 98 vehicles and 98 compliance
   documents. Four call sites had the old host written into them separately,
   which is why this is now one export: the next move is one line. */
export const UBER_WEB_HOST = 'https://fleethub.uber.com';

/* HOW FAR BACK the earner-payments surface answers, in one place — and the
   margin the collector adds to it, expressed as a margin rather than as a
   second number.
   ─────────────────────────────────────────────────────────────────────────
   Two constants described this one edge and had already drifted eight days
   apart: EARNER_DAY_HORIZON = 200 in src/sources/uber.js decided how far back
   to ASK, and HORIZON_DAYS = 192 in api/reconcile_routes.js decided where the
   page tells a reader Uber stops answering. Nothing tied them together, so the
   banner and the collector could disagree about the same day — and the reader
   would have no way to tell which of the two was wrong.

   They are not the same number by intent, and that is the point of naming both
   halves. 192 is MEASURED: probing one week at a time on 2026-09-02, the week
   ending 2026-02-22 returned 10 earner rows with money and the week ending
   2026-02-15 returned nothing, and a second probe put the daily edge at the
   same place. 8 is a deliberate overshoot on the ASK side only, for the reason
   src/sources/uber.js gives where it uses it: the window rolls forward every
   day, so overshooting costs a few empty calls while undershooting loses days
   that can never be re-fetched.

   So a page states MEASURED, a collector asks MEASURED + MARGIN, and moving
   the edge is one edit rather than two that can be made separately. */
export const UBER_EARNER_HORIZON_DAYS = 192;
export const UBER_EARNER_ASK_MARGIN_DAYS = 8;
import { config } from '../config.js';
import { http } from '../http.js';
import { log } from '../log.js';
import { pool } from '../db.js';
import { noteCredential } from '../auth_state.js';

/* Keyed by client id, not one slot.
   ─────────────────────────────────────────────────────────────────────────
   A single `cached` was correct while there was a single client. With a
   per-fleet client it is a bug that hides itself: the first fleet's token is
   handed to the second fleet's calls, which then 403 against an org that
   client cannot see — the exact symptom we already spent a session chasing,
   reproduced by the fix for it. */
const cache = new Map();

/**
 * @param o an entry from config.uber.orgs, or null for the shared client.
 *   The probes pass nothing and keep the behaviour they have always had.
 */
export async function uberOAuthToken(o = null) {
  const cfg = config.uber.oauth;
  const clientId = o?.oauth?.clientId || cfg.clientId;
  const clientSecret = o?.oauth?.clientSecret || cfg.clientSecret;
  const credential = o?.oauth?.secretKey || 'UBER_CLIENT_SECRET';
  /* Recorded against the fleet whose client it is. '*' was right when one
     client served everybody; it is misleading the moment two do, because a
     grant that failed for one fleet would show as every fleet's problem. */
  const fleet = o?.oauth?.own ? o.fleet : '*';

  const hit = cache.get(clientId);
  if (hit && Date.now() < hit.exp - 60000) return hit.token;

  if (!clientId || !clientSecret) {
    await noteCredential(pool, { provider: 'uber', fleet, credential,
      state: 'missing', detail: 'no OAuth client is configured for this fleet',
      surface: 'oauth token grant' });
    throw new Error(`uber oauth: no client configured${o?.fleet ? ` for ${o.fleet}` : ''}`);
  }

  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    grant_type: 'client_credentials', scope: cfg.scope,
  }).toString();
  const { data } = await http(cfg.tokenUrl, {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!data.access_token) {
    const detail = String(data?.error_description || data?.error || JSON.stringify(data)).slice(0, 200);
    await noteCredential(pool, { provider: 'uber', fleet, credential,
      state: 'expired', detail, surface: 'oauth token grant' });
    throw new Error('uber oauth failed: ' + JSON.stringify(data));
  }
  await noteCredential(pool, { provider: 'uber', fleet, credential,
    state: 'ok', detail: null, surface: 'oauth token grant' });
  const token = data.access_token;
  cache.set(clientId, { token, exp: Date.now() + (data.expires_in || 2592000) * 1000 });
  log.info('uber', 'oauth token refreshed', { expires_in: data.expires_in, credential, fleet });
  return token;
}

// Headers for the supplier web session (reports + graphql). Each org carries
// its own session; called without one it falls back to the legacy single-org
// cookie so the probes keep working unchanged.
export function uberWebHeaders(org = null) {
  const cookie = org?.webCookie || config.uber.webCookie;
  if (!cookie) {
    const which = org?.fleet ? ` for ${org.fleet}` : '';
    /* Recorded as MISSING rather than expired: nobody has to go and look at
       why a credential that was never set stopped working. */
    noteCredential(pool, { provider: 'uber', fleet: org?.fleet || '*',
      credential: org?.fleet === 'egari' ? 'UBER_WEB_COOKIE_EGARI' : 'UBER_WEB_COOKIE',
      state: 'missing', detail: 'no web session is configured for this fleet',
      surface: 'supplier web session' });
    throw new Error(`Uber web cookie${which} not set (session expired?)`);
  }
  return { 'content-type': 'application/json', 'x-csrf-token': 'x', cookie };
}
