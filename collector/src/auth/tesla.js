/* Tesla Fleet API auth. Two tokens, and they are not interchangeable.
   ──────────────────────────────────────────────────────────────────────────
   PARTNER token — `client_credentials`, from the app's own id and secret. It
   authenticates the APPLICATION. Measured live on 2026-09-10 it answers
   `GET /api/1/vehicles` with HTTP 200 and a count of ZERO, because an
   application does not own cars. Its uses are the partner endpoints:
   registering this domain, and reading back the public key Tesla fetched.

   THIRD-PARTY token — `authorization_code`, and only the person who owns the
   vehicles in their Tesla account can create one, by signing in and approving
   this application. That exchange returns a refresh token, and the refresh
   token is the only one of the three secrets that cannot be recovered without
   sending a human back to Tesla to sign in again. It is what the collector
   mints access tokens from, and it is stored encrypted in `app_setting`.

   REGION decides the API host AND the token `audience`, and the two must be
   the same string or every call comes back 401 in a way that reads like a bad
   secret. Tesla serves three: `na`, `eu`, `cn`. A UAE fleet is EMEA, which
   Tesla routes through `eu` — confirmed by registering this domain against
   both hosts and getting the same account id back either way. */
import { http } from '../http.js';
import { get } from '../settings.js';

export const TESLA_AUTH = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3';

/* The scopes a READ-ONLY fleet view needs, and deliberately not one more.
   `vehicle_cmds` and `vehicle_charging_cmds` would let this application open
   doors and start charging sessions on eighty-two cars; nothing here wants that,
   and a grant is far easier to widen later than to explain afterwards. */
export const READ_SCOPES = 'openid offline_access vehicle_device_data vehicle_location';

export const teslaRegion = () => String(get('TESLA_REGION', 'eu') || 'eu').trim().toLowerCase();
export const teslaBase = (region = teslaRegion()) =>
  `https://fleet-api.prd.${region}.vn.cloud.tesla.com`;

const creds = () => ({
  id: get('TESLA_CLIENT_ID', ''),
  secret: get('TESLA_CLIENT_SECRET', ''),
});

const form = (o) => new URLSearchParams(o).toString();

/* Never throws for a missing credential — returns the reason instead. A
   collector that throws here records "the provider refused us", which is a
   different and wrong claim from "nobody has given us a token yet". */
export async function partnerToken() {
  const { id, secret } = creds();
  if (!id || !secret) return { err: 'TESLA_CLIENT_ID and TESLA_CLIENT_SECRET are not set' };
  const { data, status } = await http(`${TESLA_AUTH}/token`, {
    method: 'POST', timeoutMs: 30000, retries: 1,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'client_credentials', client_id: id, client_secret: secret,
      scope: READ_SCOPES, audience: teslaBase() }),
  });
  if (data?.access_token) return { token: data.access_token, expires_in: data.expires_in };
  return { err: `partner token refused (${status}): ${data?.error || ''} ${data?.error_description || ''}`.trim() };
}

/* The token the collector actually reads vehicles with. */
export async function accessToken() {
  const { id, secret } = creds();
  const refresh = get('TESLA_REFRESH_TOKEN', '');
  if (!id || !secret) return { err: 'TESLA_CLIENT_ID and TESLA_CLIENT_SECRET are not set' };
  if (!refresh) {
    return { err: 'no Tesla refresh token: nobody has approved this application against the '
      + 'Tesla account that owns the cars yet. The partner credentials authenticate the app, '
      + 'not the vehicles — until somebody signs in, Tesla returns an empty vehicle list, and '
      + 'that is a fact about the grant rather than about the fleet.' };
  }
  const { data, status } = await http(`${TESLA_AUTH}/token`, {
    method: 'POST', timeoutMs: 30000, retries: 1,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'refresh_token', client_id: id, refresh_token: refresh }),
  });
  if (data?.access_token) {
    return { token: data.access_token,
      expires_in: data.expires_in,
      /* Tesla rotates the refresh token on some exchanges. A caller that does
         not store the new one is one exchange away from being signed out. */
      refresh: data.refresh_token || null };
  }
  return { err: `access token refused (${status}): ${data?.error || ''} ${data?.error_description || ''}`.trim() };
}

/* The URL a human opens once. `state` is echoed back by Tesla and checked on
   the way in, so a stray GET to the callback cannot plant a token. */
export function authorizeUrl({ redirectUri, state, scopes = READ_SCOPES }) {
  const { id } = creds();
  if (!id) return null;
  return `${TESLA_AUTH}/authorize?${form({
    response_type: 'code', client_id: id, redirect_uri: redirectUri, scope: scopes, state })}`;
}

export async function exchangeCode({ code, redirectUri }) {
  const { id, secret } = creds();
  if (!id || !secret) return { err: 'TESLA_CLIENT_ID and TESLA_CLIENT_SECRET are not set' };
  const { data, status } = await http(`${TESLA_AUTH}/token`, {
    method: 'POST', timeoutMs: 30000, retries: 1,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'authorization_code', client_id: id, client_secret: secret,
      code, redirect_uri: redirectUri, audience: teslaBase() }),
  });
  if (data?.refresh_token) {
    return { refresh: data.refresh_token, token: data.access_token, expires_in: data.expires_in };
  }
  return { err: `code exchange refused (${status}): ${data?.error || ''} ${data?.error_description || ''}`.trim() };
}
