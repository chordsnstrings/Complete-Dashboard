#!/usr/bin/env node
/* The Tesla token keeper: run this from a network Tesla answers.
   ──────────────────────────────────────────────────────────────────────────
   WHY THIS EXISTS, measured rather than assumed. Tesla's edge refuses the
   production server's whole provider range on BOTH documented auth hosts. Not
   the request shape — four header sets, including a full browser one, all 403.
   Not the hostname — auth.tesla.com and fleet-auth.prd.vn.cloud.tesla.com,
   both 403 from there and both fine from elsewhere. Not one address — three
   different DigitalOcean egress IPs across three deploys, all 403. It is the
   range, which is ordinary Akamai policy for datacentres.

   But the DATA host answers production normally (401, no block page). So the
   split is precise and small:

     minting and refreshing   must happen somewhere Tesla answers  ← this file
     using the token          happens on production, unchanged

   Run it from an office machine, a laptop, anything that is not in a blocked
   cloud range. It talks to Tesla, then writes the result back to the dashboard
   over its own settings API.

     node bin/tesla-token.mjs status      what the dashboard holds right now
     node bin/tesla-token.mjs claim       spend the held sign-in code, once
     node bin/tesla-token.mjs refresh     renew, and store the rotation
     node bin/tesla-token.mjs check       ask Tesla for the vehicle list

   REFRESH TOKENS ARE SINGLE USE. Tesla's documentation: "single use only and
   expires after 3 months", with up to 24 hours of grace on the most recently
   used one. Every renewal invalidates the token it was given, so `refresh`
   MUST store what comes back or the fleet is signed out a day later. That is
   why this writes before it reports, and reports what it wrote. Schedule it
   well inside the access token's life — every six hours is comfortable. */
const BASE = process.env.DASH_BASE || 'https://fleet-dashboard-wpeqb.ondigitalocean.app';
const AUTH_DEFAULT = 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3';
const REDIRECT = `${BASE}/teslaredirect`;

const die = (m) => { console.error(`\n  ${m}\n`); process.exit(1); };
const j = async (path, opts) => {
  const r = await fetch(`${BASE}${path}`, opts);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; }
  catch { return { status: r.status, body: t }; }
};

/* The dashboard is the source of truth for every credential here, so nothing
   is pasted into a shell and nothing lands in a shell history file. */
const settings = async () => {
  const { status, body } = await j('/api/settings');
  if (status !== 200) die(`the dashboard answered ${status} for /api/settings`);
  const rows = Array.isArray(body) ? body : (body.settings || body.rows || []);
  return Object.fromEntries(rows.map((r) => [r.key, r]));
};
/* PUT with an object of key -> value, which is the contract api/server.js
   actually implements: it iterates Object.entries(req.body) and treats '' or
   null as "clear this". A POST of {key, value} — the shape this was first
   written against — hits no route at all and 404s, which would have looked
   like the dashboard refusing the token rather than like a wrong verb. */
const putSetting = async (key, value) => {
  const { status, body } = await j('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: value }) });
  if (status >= 300) die(`could not store ${key}: ${status} ${JSON.stringify(body).slice(0, 200)}`);
  if (!body || body.ok !== true) die(`the dashboard did not confirm storing ${key}: `
    + JSON.stringify(body).slice(0, 200));
};

/* Reads the values the dashboard will not echo back. /api/settings redacts
   secrets to ••••••<last 4> by design — correct, and it means this tool needs
   the id and secret given to it rather than read out. */
const need = (name) => process.env[name] || die(
  `${name} is not set. This tool needs the Tesla client id and secret in its own environment:\n`
  + '    export TESLA_CLIENT_ID=…\n    export TESLA_CLIENT_SECRET=…\n'
  + '  They are deliberately not readable back out of the dashboard.');

const tokenHost = async () => {
  const s = await settings();
  return (s.TESLA_TOKEN_HOST?.value || '').trim().replace(/\/+$/, '') || AUTH_DEFAULT;
};

const post = async (host, form) => {
  const r = await fetch(`${host}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded',
      'user-agent': 'ecosine-fleet-dashboard/1.0' },
    body: new URLSearchParams(form).toString() });
  const text = await r.text();
  if (/<html|access denied/i.test(text)) {
    die(`Tesla's edge refused THIS machine too (HTTP ${r.status}).\n`
      + '  Run this from a different network — an office connection or a laptop on mobile data.\n'
      + '  Cloud and datacentre ranges are what Tesla is refusing.');
  }
  let data; try { data = JSON.parse(text); } catch { die(`Tesla answered unparseable: ${text.slice(0, 200)}`); }
  if (!r.ok) die(`Tesla refused (${r.status}): ${data.error || ''} ${data.error_description || ''}`);
  return data;
};

const cmd = process.argv[2] || 'status';

if (cmd === 'status') {
  const s = await settings();
  console.log(`\n  dashboard   ${BASE}`);
  console.log(`  token host  ${await tokenHost()}`);
  const t = await j('/api/tesla/status');
  /* Read off /api/tesla/status, NOT off the settings values. /api/settings
     redacts secrets to an empty string for a non-admin reader — correctly —
     so `TESLA_CLIENT_ID.value` is blank whether it is set or not, and printing
     "NOT SET" from it tells an operator their credentials are missing when
     they are fine. `configured` is the field that answers the question that
     was actually asked. */
  console.log(`  client id   ${t.body?.client_configured ? 'set' : 'NOT SET'}`);
  console.log(`  refresh     ${t.body?.granted ? 'stored' : 'none — run `claim`'}`);
  console.log(`  held code   ${s.TESLA_PENDING_CODE?.configured
    ? 'yes — run `claim` promptly, codes are short-lived' : 'none'}`);
  console.log(`  granted     ${t.body?.granted}`);
  console.log(`  teslas      ${t.body?.total_teslas}\n`);

} else if (cmd === 'claim') {
  /* Spends the code the dashboard held when its own exchange was refused. */
  const id = need('TESLA_CLIENT_ID'); const secret = need('TESLA_CLIENT_SECRET');
  const s = await settings();
  /* TAKEN AS AN ARGUMENT, because it cannot be read back out of the
     dashboard: api/admin_gate.js's redactSettings blanks `value` on every row
     for a non-admin reader, whatever the secret flag says. The callback page
     prints the code for exactly this reason — the person who signed in is the
     one who has it. */
  const code = process.argv[3];
  if (!code) {
    if (s.TESLA_PENDING_CODE?.configured) {
      die('A sign-in code IS held, but it cannot be read back out — the dashboard redacts every\n'
        + '  stored value for a non-admin reader. It is printed on the page the operator saw\n'
        + '  after signing in. Pass it here:\n\n    node bin/tesla-token.mjs claim <code>\n');
    }
    die('No sign-in has been completed. Open the Tesla page in the dashboard, use the sign-in\n'
      + '  link as the person who owns the cars, then run this with the code that page prints:\n'
      + '\n    node bin/tesla-token.mjs claim <code>\n');
  }
  const host = await tokenHost();
  const data = await post(host, { grant_type: 'authorization_code', client_id: id,
    client_secret: secret, code, redirect_uri: REDIRECT,
    audience: `https://fleet-api.prd.${(s.TESLA_REGION?.value || 'eu')}.vn.cloud.tesla.com` });
  if (!data.refresh_token) die('Tesla returned no refresh token. The grant is missing '
    + 'offline_access — check the scopes on the app in Tesla’s console.');
  await putSetting('TESLA_REFRESH_TOKEN', data.refresh_token);
  /* Cleared, because a spent code is rubbish and a stored one invites a
     second attempt that can only fail. */
  await putSetting('TESLA_PENDING_CODE', '');
  console.log('  stored the refresh token, cleared the held code.');
  console.log('  the dashboard can read Tesla now — schedule `refresh` every 6 hours.\n');

} else if (cmd === 'refresh') {
  const id = need('TESLA_CLIENT_ID');
  const s = await settings();
  if (!s.TESLA_REFRESH_TOKEN?.value) die('No refresh token stored. Run `claim` first.');
  /* The dashboard redacts secrets, so the stored refresh token cannot be read
     back out — it has to be given here, or this has to run where it was last
     written. Kept explicit rather than silently failing. */
  const rt = process.env.TESLA_REFRESH_TOKEN
    || die('TESLA_REFRESH_TOKEN is not set in this environment. The dashboard redacts stored '
      + 'secrets, so the current one has to be supplied:\n    export TESLA_REFRESH_TOKEN=…\n'
      + '  `claim` prints nothing secret; keep the value it stored from that run.');
  const data = await post(await tokenHost(),
    { grant_type: 'refresh_token', client_id: id, refresh_token: rt });
  if (data.refresh_token) {
    await putSetting('TESLA_REFRESH_TOKEN', data.refresh_token);
    console.log('\n  renewed, and stored the ROTATED refresh token.');
    console.log('  Tesla rotates on every renewal and the old one is now dead — if you keep this');
    console.log('  value anywhere, replace it with the one just stored.\n');
  } else {
    console.log('\n  renewed; Tesla returned no new refresh token this time.\n');
  }

} else if (cmd === 'check') {
  const t = await j('/api/tesla/vehicles');
  console.log(`\n  ${t.status} ${JSON.stringify(t.body).slice(0, 400)}\n`);

} else {
  die('usage: node bin/tesla-token.mjs [status|claim|refresh|check]');
}
