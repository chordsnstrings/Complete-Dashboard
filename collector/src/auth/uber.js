// Uber auth: OAuth client_credentials token (30-day, auto-refreshed) for api.uber.com,
// plus the supplier web-session cookie (supplier.uber.com) supplied via env.
import { config } from '../config.js';
import { http } from '../http.js';
import { log } from '../log.js';
import { pool } from '../db.js';
import { noteCredential } from '../auth_state.js';

let cached = { token: null, exp: 0 };

export async function uberOAuthToken() {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const o = config.uber.oauth;
  const body = new URLSearchParams({
    client_id: o.clientId, client_secret: o.clientSecret,
    grant_type: 'client_credentials', scope: o.scope,
  }).toString();
  const { data } = await http(o.tokenUrl, {
    method: 'POST', body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  if (!data.access_token) {
    const detail = String(data?.error_description || data?.error || JSON.stringify(data)).slice(0, 200);
    await noteCredential(pool, { provider: 'uber', fleet: '*', credential: 'UBER_CLIENT_SECRET',
      state: 'expired', detail, surface: 'oauth token grant' });
    throw new Error('uber oauth failed: ' + JSON.stringify(data));
  }
  await noteCredential(pool, { provider: 'uber', fleet: '*', credential: 'UBER_CLIENT_SECRET',
    state: 'ok', detail: null, surface: 'oauth token grant' });
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 2592000) * 1000 };
  log.info('uber', 'oauth token refreshed', { expires_in: data.expires_in });
  return cached.token;
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
