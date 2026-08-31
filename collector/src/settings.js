// Credential store: DB-backed settings, encrypted at rest, editable from the Settings page.
// Precedence: DB value (set via Settings UI) > environment variable > default.
// Secrets are encrypted with AES-256-GCM using SETTINGS_KEY (falls back to a key derived from
// DATABASE_URL so the app still works before a key is provisioned).
import crypto from 'node:crypto';
import { pool } from './db.js';
import { log } from './log.js';
import { jwtExpiry } from './util.js';

const KEY = crypto.createHash('sha256')
  .update(process.env.SETTINGS_KEY || process.env.DATABASE_URL || 'fleet-dev-key')
  .digest();

function enc(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${out.toString('base64')}`;
}
function dec(blob) {
  try {
    const [v, iv, tag, data] = String(blob).split(':');
    if (v !== 'v1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

/* The values the code falls back to when neither the settings table nor the
   environment has one.
   ─────────────────────────────────────────────────────────────────────────
   src/config.js calls get('FMS_ECOSINE_USER', 'ecosinetranspor') — a working
   username, supplied by the code — and describeSettings reported the key as
   source "unset", configured false, which the Settings page paints amber. Two
   of the three warnings on that page were credentials that are present and in
   daily use: FMS has collected 41,809 trip rows with them. An operator reading
   amber goes looking for a credential that is not missing.

   Declared here rather than in config.js, and config.js reads THIS, so there
   is one place a default lives. Two copies of "what the fallback is" is how
   the page and the collector come to disagree about whether a thing is set. */
export const SETTING_DEFAULTS = {
  FMS_BASE: 'http://103.185.74.197/currentinfotest/ItlService.svc',
  FMS_ECOSINE_USER: 'ecosinetranspor',
  FMS_EGARI_USER: 'egariluxury',
  CABMAN_URL: 'https://app.cabman.ae/dtcabmanrestservice/api/trackingServices/GetIVDData',
  CABMAN_ECOSINE_ID: '81',
  CABMAN_ECOSINE_USER: 'admin_ecosine',
  CABMAN_CRON: '*/5 * * * *',
  /* Three-hourly, offset off the hour so it does not start alongside the
     thirty-minute incremental and compete with it for the same session. */
  UBER_TIMELINE_CRON: '17 */3 * * *',
  /* Uber runs two OAuth environments and an application belongs to ONE of
     them. A Test-environment client answers `unauthorized_client — the current
     application environment is mismatched with the OAuth server runtime` on
     the production endpoint while being perfectly valid on the sandbox one,
     which is a sentence nobody decodes on the first read. Overridable so a
     Test application can be pointed at the environment it was registered in
     rather than looking broken. */
  UBER_TOKEN_URL: 'https://login.uber.com/oauth/v2/token',
  /* The one REST surface that takes no org_id, and therefore the only one that
     can say what a valid org_id IS. Two callers need it — the diagnosis that
     turns a 403 into a sentence (src/auth_state.js) and the check that reads a
     pasted OAuth application (src/credcheck.js) — so it is named once here
     rather than spelled twice, and overridable for the same reason
     UBER_TOKEN_URL is: a Test-environment application lives on another host. */
  UBER_ORGS_URL: 'https://api.uber.com/v1/vehicle-suppliers/orgs',
  YANGO_BASE: 'https://fleet.yango.com',
  HOTEL_BASE: 'https://whale-app-iofbt.ondigitalocean.app',
  HOTEL_DOMAIN: 'hotel.ecosine.ae',
  /* MiniMax's OpenAI-compatible surface. The previous default was ByteDance
     ModelArk, which every analyst pass on production timed out against — the
     stored runs show `outcome: failed, error: This operation was aborted`
     after 242s, and the page reported the analyst as simply quiet. */
  ANALYST_BASE_URL: 'https://api.minimax.io/v1',
  ANALYST_MODEL: 'MiniMax-M3',
  BACKFILL_MONTHS: '12',
  INCREMENTAL_DAYS: '3',
  /* The two sites the operator named. Written as they appear in the address
     text, because that is the only handle the trip data gives — there is no
     geofence to match against. */
  /* Comma-separated sites; a `|` inside one lists the ways that ONE site is
     written in trip addresses. Terminal 3's parking stands in Al Garhoud and
     the two providers address it both ways — a fact this codebase already
     measures and states on /api/optimise — so a car recorded at "Dubai Int'l
     Airport" may be sitting on the Al Garhoud charger, and the address text
     cannot say which. Listing the alias is not a claim that the terminal has
     its own charger; it is a refusal to pretend the two names are two
     places. */
  CHARGING_SITES: "Al Garhoud|Dubai Int'l Airport, Dubai Production City",
};

// The full catalogue the Settings page renders. `secret:true` values are never returned in clear.
export const SETTING_DEFS = [
  { key: 'FMS_ECOSINE_USER', group: 'FMS / InfoTrack', label: 'Ecosine username', secret: false },
  { key: 'FMS_ECOSINE_PASS', group: 'FMS / InfoTrack', label: 'Ecosine password', secret: true },
  { key: 'FMS_EGARI_USER', group: 'FMS / InfoTrack', label: 'Egari username', secret: false },
  { key: 'FMS_EGARI_PASS', group: 'FMS / InfoTrack', label: 'Egari password', secret: true },

  { key: 'CABMAN_ECOSINE_ID', group: 'CABMAN DT', label: 'Interface unique id', secret: false },
  { key: 'CABMAN_ECOSINE_USER', group: 'CABMAN DT', label: 'Interface username', secret: false },
  { key: 'CABMAN_ECOSINE_PASS', group: 'CABMAN DT', label: 'Interface password', secret: true },

  { key: 'UBER_CLIENT_ID', group: 'Uber', label: 'OAuth client id', secret: false },
  { key: 'UBER_CLIENT_SECRET', group: 'Uber', label: 'OAuth client secret', secret: true },
  /* An Uber OAuth application is registered UNDER one org, so a second business
     needs a second application — not a second copy of the first one's keys.
     Left unset, both fleets share the pair above, which is what they did before
     these existed. */
  { key: 'UBER_TOKEN_URL', group: 'Uber', label: 'OAuth token endpoint', secret: false,
    hint: 'Leave as-is for production apps; sandbox-login.uber.com for a Test-environment app' },
  { key: 'UBER_ORGS_URL', group: 'Uber', label: 'Organisation list endpoint', secret: false,
    hint: 'The one REST surface that takes no org id, so it is what a pasted OAuth application '
      + 'is asked to name its own fleet. Moves with UBER_TOKEN_URL for a Test-environment app' },
  { key: 'UBER_CLIENT_ID_EGARI', group: 'Uber', label: 'OAuth client id — Egari', secret: false,
    hint: 'Only if Egari has its own Uber application; otherwise the shared client is used' },
  { key: 'UBER_CLIENT_SECRET_EGARI', group: 'Uber', label: 'OAuth client secret — Egari', secret: true,
    hint: 'Must be a PRODUCTION application registered under the Egari org, not a Test one' },
  { key: 'UBER_ORG_ENCRYPTED', group: 'Uber', label: 'Org id (encrypted, REST)', secret: false },
  { key: 'UBER_ORG_UUID', group: 'Uber', label: 'Org uuid (GraphQL/reports)', secret: false },
  { key: 'UBER_WEB_COOKIE', group: 'Uber', label: 'Supplier web session cookie', secret: true, hint: 'Expires — re-paste from a logged-in supplier.uber.com session' },
  { key: 'UBER_ORG_UUID_EGARI', group: 'Uber', label: 'Org uuid — Egari', secret: false },
  { key: 'UBER_ORG_ENCRYPTED_EGARI', group: 'Uber', label: 'Org id (encrypted, REST) — Egari', secret: false },
  { key: 'UBER_WEB_COOKIE_EGARI', group: 'Uber', label: 'Supplier web session cookie — Egari', secret: true, hint: 'Expires — re-paste from a logged-in supplier.uber.com session for the Egari org' },

  { key: 'YANGO_PARK_ID', group: 'Yango', label: 'Park id', secret: false },
  { key: 'YANGO_API_KEY', group: 'Yango', label: 'API key', secret: true },
  { key: 'YANGO_COOKIE', group: 'Yango', label: 'Yandex session cookie', secret: true, hint: 'Expires — re-paste from a logged-in fleet.yango.com session' },

  { key: 'BOLT_CLIENT_ID', group: 'Bolt', label: 'OAuth client id', secret: false },
  { key: 'BOLT_CLIENT_SECRET', group: 'Bolt', label: 'OAuth client secret', secret: true },
  { key: 'BOLT_REFRESH_TOKEN', group: 'Bolt', label: 'Fleet-portal refresh token', secret: true, hint: '~7 day lifetime — refresh to unlock Bolt trips & earnings' },
  // Single-use: the portal rotates it on every exchange and invalidates the one
  // presented, so the collector writes the successor back here. Per fleet,
  // because a token is issued to one fleet owner and the two fleets have two.
  { key: 'BOLT_REFRESH_TOKEN_ECOSINE', group: 'Bolt', label: 'Portal refresh token — Ecosine', secret: true, hint: 'Rotates on use; the collector keeps it current. Paste a fresh one only when it has expired.' },
  { key: 'BOLT_REFRESH_TOKEN_EGARI', group: 'Bolt', label: 'Portal refresh token — Egari', secret: true, hint: 'Rotates on use; the collector keeps it current. Paste a fresh one only when it has expired.' },

  { key: 'HOTEL_TOKEN', group: 'Hotel (ecosine.ae)', label: 'Operations manager bearer token', secret: true },
  { key: 'HOTEL_DOMAIN', group: 'Hotel (ecosine.ae)', label: 'x-domain header', secret: false },
  { key: 'HOTEL_BASE', group: 'Hotel (ecosine.ae)', label: 'API base url', secret: false },

  { key: 'BACKFILL_MONTHS', group: 'Collector', label: 'Backfill months', secret: false },
  { key: 'INCREMENTAL_DAYS', group: 'Collector', label: 'Incremental window (days)', secret: false },
  { key: 'CABMAN_CRON', group: 'Collector', label: 'CABMAN schedule (cron)', secret: false },
  { key: 'UBER_TIMELINE_CRON', group: 'Collector', label: 'Uber driver-timeline schedule (cron)', secret: false,
    hint: 'One request per working driver per run — three-hourly by default' },

  /* Not a credential — a fact about the fleet that changes what a number
     MEANS. A car parked for fifty minutes at a place with a charger is not
     necessarily waiting for work; it may be plugged in, which for a fleet
     that is 44% electric is a large share of its measured downtime. Without
     this list the optimiser reads charging as waste and recommends moving
     the cars away from the only place they can refuel. */
  { key: 'CHARGING_SITES', group: 'Fleet', label: 'Areas with a charging station', secret: false,
    hint: "Comma-separated area names as they appear in trip addresses. Use | to list the ways one site is written: Al Garhoud|Dubai Int'l Airport" },
];
const DEF_BY_KEY = Object.fromEntries(SETTING_DEFS.map((d) => [d.key, d]));

let cache = {}; let loadedAt = 0;
const TTL_MS = 30000;   // collector picks up Settings changes within 30s — no redeploy needed

export async function loadSettings(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS) return cache;
  try {
    const { rows } = await pool.query('SELECT key, value, is_secret FROM app_setting');
    const next = {};
    for (const r of rows) next[r.key] = r.is_secret ? dec(r.value) : r.value;
    cache = next; loadedAt = Date.now();
  } catch (e) { log.warn('settings', 'load failed, using env only', { err: String(e).slice(0, 120) }); }
  return cache;
}

// Synchronous read of the last loaded snapshot, falling back to env.
export const get = (key, dflt) => (cache[key] ?? process.env[key] ?? dflt);
export const getInt = (key, dflt) => { const v = parseInt(get(key, ''), 10); return Number.isFinite(v) ? v : dflt; };

export async function setSetting(key, value) {
  const def = DEF_BY_KEY[key];
  if (!def) throw new Error(`unknown setting: ${key}`);
  const stored = def.secret ? enc(value) : String(value);
  await pool.query(
    `INSERT INTO app_setting (key, value, is_secret, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, is_secret=EXCLUDED.is_secret, updated_at=now()`,
    [key, stored, !!def.secret]);
  await loadSettings(true);
}

export async function deleteSetting(key) {
  await pool.query('DELETE FROM app_setting WHERE key=$1', [key]);
  await loadSettings(true);
}

/* What THIS process can see, recorded for the other one to read.
   ─────────────────────────────────────────────────────────────────────────
   The API and the collector are separate components with separate
   environments. On this deployment UBER_WEB_COOKIE and YANGO_COOKIE are set on
   the collector worker and nowhere else, which is right — only the collector
   calls those providers, and a web-facing service has no business holding a
   session cookie it never uses.

   The Settings page is served by the API, and it reported both as unset. An
   operator reading that would conclude the Uber session had expired and go
   capture a new one, while the collector had a working one all along. The page
   was describing the API's environment and calling it the fleet's credentials.

   Names and presence only. Never a value, not even a masked one: this row is
   read by a web service, and a secret that reaches it has been copied somewhere
   it was deliberately kept out of. */
export async function recordCredentialVisibility(component, db = pool) {
  await loadSettings(true);
  const rows = SETTING_DEFS.map((d) => {
    const fromDb = cache[d.key] != null;
    const fromEnv = !!process.env[d.key];
    // A code default counts as configured here too, for the same reason it
    // does on the page: get() will resolve it and the collector will use it.
    const hasDefault = SETTING_DEFAULTS[d.key] != null;
    return {
      component, key: d.key,
      configured: fromDb || fromEnv || hasDefault,
      source: fromDb ? 'settings' : fromEnv ? 'environment' : hasDefault ? 'default' : 'unset',
    };
  });
  for (const r of rows) {
    await db.query(
      `INSERT INTO credential_visibility (component, key, configured, source, observed_at)
       VALUES ($1,$2,$3,$4, now())
       ON CONFLICT (component, key) DO UPDATE
         SET configured = EXCLUDED.configured, source = EXCLUDED.source, observed_at = now()`,
      [r.component, r.key, r.configured, r.source]);
  }
  log.info('settings', `recorded credential visibility for ${component}`,
    { configured: rows.filter((r) => r.configured).length, of: rows.length });
  return rows;
}

// Safe view for the Settings UI: secrets are masked, never returned in clear.
export async function describeSettings() {
  await loadSettings(true);
  const { rows } = await pool.query('SELECT key, updated_at FROM app_setting');
  const updated = Object.fromEntries(rows.map((r) => [r.key, r.updated_at]));
  /* What the OTHER components can see, so this page describes the fleet's
     credentials rather than this process's environment. */
  let elsewhere = {};
  try {
    const { rows: vis } = await pool.query(
      `SELECT component, key, configured, source, observed_at FROM credential_visibility`);
    for (const v of vis) (elsewhere[v.key] ||= []).push(v);
  } catch { elsewhere = {}; }
  return SETTING_DEFS.map((d) => {
    const fromDb = cache[d.key] != null && updated[d.key] != null;
    /* A code default is a THIRD source, and it was being reported as no source
       at all. get() resolves settings > environment > default, so a key with a
       default is configured whether or not anyone has typed it in; saying
       "unset" about a username FMS is authenticating with right now sends an
       operator to fix something that works. */
    const dflt = SETTING_DEFAULTS[d.key];
    const val = cache[d.key] ?? process.env[d.key] ?? dflt ?? '';
    /* Held by SOME component, not necessarily this one.
       ─────────────────────────────────────────────────────────────────────
       seen_by below was added because a key scoped to the collector is not a
       missing key — and then `configured` was left meaning "this process can
       see it", so the row said configured:false directly above a seen_by
       naming the collector that holds it. Half the fix.

       UBER_WEB_COOKIE is the live case: it is deliberately only on the
       collector, which is the component that calls Uber, and the Settings page
       reported it unset while the collector was pulling both fleets' trips
       with it every thirty minutes. That is the same wrong errand the comment
       above describes, arriving by a different route — and it cost real time
       during the Egari session investigation, where the page's "not set" was
       read as evidence the Ecosine session had lapsed. */
    const held = (elsewhere[d.key] || []).some((v) => v.configured);
    return {
      key: d.key, group: d.group, label: d.label, hint: d.hint || null, secret: !!d.secret,
      source: fromDb ? 'settings' : process.env[d.key] ? 'environment'
        : dflt != null ? 'default' : held ? 'elsewhere' : 'unset',
      /* What the code would fall back to, so a reader can tell an operator's
         value from the one that shipped with the deploy. Never for a secret:
         no secret has a default, and if one ever did, publishing it here would
         be the leak this whole file exists to avoid. */
      default_value: !d.secret && dflt != null ? dflt : null,
      configured: !!val || held,
      value: d.secret ? (val ? `••••••••${String(val).slice(-4)}` : '') : val,
      updated_at: updated[d.key] || null,
      /* A credential that expires on a schedule nobody is watching fails
         silently: the source writes zero rows and the page shows a healthy
         "settings" tag, because "configured" only ever meant "a string is
         present". A JWT states its own expiry, so the page can say "4 days
         left" instead of waiting for the supervisor to notice a flat chart. */
      expiry: val ? jwtExpiry(val) : null,
      /* Where else this credential is held. A key unset here but present on the
         collector is not missing — it is scoped to the process that uses it,
         which is the safer arrangement and was being reported as a fault. */
      seen_by: (elsewhere[d.key] || [])
        .filter((v) => v.configured)
        .map((v) => ({ component: v.component, source: v.source, observed_at: v.observed_at })),
    };
  });
}
