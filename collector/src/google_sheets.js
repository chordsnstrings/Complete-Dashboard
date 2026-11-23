/* Reading a Google Sheet as a service account (FIX-STATUS CARD-1, 2026-11-23).
   ─────────────────────────────────────────────────────────────────────────
   The operator chose to have the dashboard read the Network International
   card-payments sheet itself, every hour, rather than upload it by hand. The
   sheet is private, so the reader signs in as a Google Cloud SERVICE ACCOUNT
   the sheet is shared with (Viewer): its JSON key is a secret setting
   (GOOGLE_SERVICE_ACCOUNT_JSON, src/settings.js), stored encrypted in the
   database from the Settings page, never in the repository.

   The OAuth 2.0 "JWT bearer" grant, done with node:crypto alone: a JWT with
   the account as issuer and the read-only Sheets scope, signed RS256 with the
   account's private key, exchanged at its token_uri for an access token, then
   one GET of the values. No Google library: one signature and two requests do
   not justify a dependency the image has to carry.

   Errors say what a person must do, in plain words: a sheet not shared with
   the account answers 403 and the error names the account's address. */
import crypto from 'node:crypto';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SHEETS_HOST = 'https://sheets.googleapis.com';

const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/* The key as the Settings page stores it: the JSON file pasted as it is
   (a single-line input drops the line breaks between fields, which JSON does
   not need; the private key's own breaks are escaped "\n" inside its string
   and survive), or the same JSON in base64. */
export function parseServiceAccount(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw fail('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  let obj = null;
  for (const candidate of [text, (() => { try { return Buffer.from(text, 'base64').toString('utf8'); } catch { return ''; } })()]) {
    try { obj = JSON.parse(candidate); break; } catch { /* try the next reading */ }
  }
  if (!obj || typeof obj !== 'object') throw fail('the Google service account key is not JSON (paste the whole key file)');
  const { client_email: email, private_key: key, token_uri: tokenUri = 'https://oauth2.googleapis.com/token' } = obj;
  if (obj.type && obj.type !== 'service_account') throw fail(`the key is a "${obj.type}" key, not a service account's`);
  if (!email || !key) throw fail('the Google service account key has no client_email or private_key');
  try { crypto.createPrivateKey(String(key).replace(/\\n/g, '\n')); } catch {
    throw fail('the Google service account key\'s private_key cannot be read');
  }
  return { email, key: String(key).replace(/\\n/g, '\n'), tokenUri };
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

/* The signed assertion. One hour is the longest Google accepts. */
export function signedAssertion(sa, { now = Date.now(), scope = SHEETS_SCOPE } = {}) {
  const iat = Math.floor(now / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: sa.email, scope, aud: sa.tokenUri, iat, exp: iat + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 200) }; }
}

export async function accessToken(sa, { fetchImpl = fetch, now = Date.now(), scope = SHEETS_SCOPE } = {}) {
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: signedAssertion(sa, { now, scope }) });
  const res = await fetchImpl(sa.tokenUri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await readJson(res);
  if (!res.ok || !j.access_token) {
    throw fail(`Google refused the service account key (${res.status}${j.error ? `: ${j.error}${j.error_description ? ` — ${j.error_description}` : ''}` : ''})`,
      { status: res.status === 400 ? 401 : res.status, credential: true });
  }
  return j.access_token;
}

/* The sheet's cells as rows of values. Numbers stay numbers, and a date
   cell arrives as its SERIAL NUMBER (the review of 2026-11-23): as formatted
   text a sheet in a US locale writes 11/5/2026, and a day-first reading would
   swap every day 1–12 silently. A date typed as text arrives as that text. */
export async function readValues({ sa, sheetId, range, fetchImpl = fetch, now = Date.now() }) {
  if (!sheetId) throw fail('NETWORK_SHEET_ID is not set');
  const token = await accessToken(sa, { fetchImpl, now });
  const url = `${SHEETS_HOST}/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range || 'A:J')}`
    + '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER&majorDimension=ROWS';
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
  const j = await readJson(res);
  if (res.status === 403) {
    /* Two different 403s (the review of 2026-11-23). The usual first-setup
       one is the Sheets API not enabled in the account's project — the key is
       fine and sharing would not help, so it is said as itself, with
       Google's own words. */
    const gmsg = String(j?.error?.message || '');
    const disabled = /has not been used|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(gmsg)
      || (j?.error?.details || []).some((d) => d?.reason === 'SERVICE_DISABLED');
    if (disabled) {
      throw fail(`the Google Sheets API is not enabled in the service account's project — enable it in Google Cloud (Google: ${gmsg.slice(0, 160)})`, { status: 403 });
    }
    throw fail(`the sheet is not shared with ${sa.email} — share it with that address as Viewer${gmsg ? ` (Google: ${gmsg.slice(0, 120)})` : ''}`, { status: 403, credential: true });
  }
  if (res.status === 404) throw fail('Google has no sheet with that id (check NETWORK_SHEET_ID)', { status: 404 });
  if (!res.ok) throw fail(`Google Sheets answered ${res.status}${j?.error?.message ? `: ${String(j.error.message).slice(0, 160)}` : ''}`, { status: res.status });
  return Array.isArray(j.values) ? j.values : [];
}
