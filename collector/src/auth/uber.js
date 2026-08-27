// Uber auth: OAuth client_credentials token (30-day, auto-refreshed) for api.uber.com,
// plus the supplier web-session cookie (supplier.uber.com) supplied via env.
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
