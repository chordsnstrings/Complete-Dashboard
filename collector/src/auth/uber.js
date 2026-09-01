// Uber auth: OAuth client_credentials token (30-day, auto-refreshed) for api.uber.com,
// plus the supplier web-session cookie (the fleet portal) supplied via env.
import { config } from '../config.js';
import { http } from '../http.js';
import { log } from '../log.js';

let cached = { token: null, exp: 0 };

/* The one place that names the fleet portal.
   ─────────────────────────────────────────────────────────────────────────
   Uber moved the supplier portal to fleethub.uber.com and left a 301 behind on
   every path — /graphql, /chronicle/graphql, the report API, the org pages.
   A redirect sounds harmless and is not: a 301 turns a POST into a GET, the
   GET is not signed in, it lands on the login page, and what comes back is
   HTML with a 200 on it. Nothing throws. The GraphQL body is read off a
   string, every field is undefined, and a run that collected nothing reports
   success. Naming the live host here means the request arrives where it is
   meant to and a genuine refusal looks like a refusal.

   It is also the address a human has to visit to re-paste a cookie, so the
   settings hints below read from the same constant rather than repeating a
   hostname that has already changed once. */
export const PORTAL = 'https://fleethub.uber.com';


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
  if (!data.access_token) throw new Error('uber oauth failed: ' + JSON.stringify(data));
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
    throw new Error(`Uber web cookie${which} not set (session expired?)`);
  }
  return { 'content-type': 'application/json', 'x-csrf-token': 'x', cookie };
}
