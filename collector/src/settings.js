// Credential store: DB-backed settings, encrypted at rest, editable from the Settings page.
// Precedence: DB value (set via Settings UI) > environment variable > default.
// Secrets are encrypted with AES-256-GCM using SETTINGS_KEY (falls back to a key derived from
// DATABASE_URL so the app still works before a key is provisioned).
import crypto from 'node:crypto';
import { pool } from './db.js';
import { log } from './log.js';

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
  { key: 'UBER_ORG_ENCRYPTED', group: 'Uber', label: 'Org id (encrypted, REST)', secret: false },
  { key: 'UBER_ORG_UUID', group: 'Uber', label: 'Org uuid (GraphQL/reports)', secret: false },
  { key: 'UBER_WEB_COOKIE', group: 'Uber', label: 'Supplier web session cookie', secret: true, hint: 'Expires — re-paste from a logged-in supplier.uber.com session' },

  { key: 'YANGO_PARK_ID', group: 'Yango', label: 'Park id', secret: false },
  { key: 'YANGO_API_KEY', group: 'Yango', label: 'API key', secret: true },
  { key: 'YANGO_COOKIE', group: 'Yango', label: 'Yandex session cookie', secret: true, hint: 'Expires — re-paste from a logged-in fleet.yango.com session' },

  { key: 'BOLT_CLIENT_ID', group: 'Bolt', label: 'OAuth client id', secret: false },
  { key: 'BOLT_CLIENT_SECRET', group: 'Bolt', label: 'OAuth client secret', secret: true },
  { key: 'BOLT_REFRESH_TOKEN', group: 'Bolt', label: 'Fleet-portal refresh token', secret: true, hint: '~7 day lifetime — refresh to unlock Bolt trips & earnings' },

  { key: 'HOTEL_TOKEN', group: 'Hotel (ecosine.ae)', label: 'Operations manager bearer token', secret: true },
  { key: 'HOTEL_DOMAIN', group: 'Hotel (ecosine.ae)', label: 'x-domain header', secret: false },
  { key: 'HOTEL_BASE', group: 'Hotel (ecosine.ae)', label: 'API base url', secret: false },

  { key: 'BACKFILL_MONTHS', group: 'Collector', label: 'Backfill months', secret: false },
  { key: 'INCREMENTAL_DAYS', group: 'Collector', label: 'Incremental window (days)', secret: false },
  { key: 'CABMAN_CRON', group: 'Collector', label: 'CABMAN schedule (cron)', secret: false },
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

// Safe view for the Settings UI: secrets are masked, never returned in clear.
export async function describeSettings() {
  await loadSettings(true);
  const { rows } = await pool.query('SELECT key, updated_at FROM app_setting');
  const updated = Object.fromEntries(rows.map((r) => [r.key, r.updated_at]));
  return SETTING_DEFS.map((d) => {
    const fromDb = cache[d.key] != null && updated[d.key] != null;
    const val = cache[d.key] ?? process.env[d.key] ?? '';
    return {
      key: d.key, group: d.group, label: d.label, hint: d.hint || null, secret: !!d.secret,
      source: fromDb ? 'settings' : (process.env[d.key] ? 'environment' : 'unset'),
      configured: !!val,
      value: d.secret ? (val ? `••••••••${String(val).slice(-4)}` : '') : val,
      updated_at: updated[d.key] || null,
    };
  });
}
