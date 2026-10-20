/* ntfy — a push to the operator's phone.
   ─────────────────────────────────────────────────────────────────────────
   ntfy (https://ntfy.sh, or a self-hosted server) delivers a message posted to
   a TOPIC to every phone subscribed to that topic in the ntfy app. There is no
   account: on the public server the topic name IS the access control, so it
   is a secret — NTFY_TOPIC is stored like a credential (Settings page or the
   environment, never the repository) and should be long and unguessable.
   NTFY_TOKEN is for a protected topic or a private server and is optional.

   Posted as JSON to the server root, which is the one form that carries a
   title, priority and tags with any characters in them (the header form
   cannot carry an em dash). Never throws: a failed push is reported to the
   caller, which decides what to retry — api/alerts.js records nothing as sent
   unless the server accepted it. */
import { get } from './settings.js';

export const NTFY_DEFAULT_URL = 'https://ntfy.sh';
/* ntfy turns a body past 4096 bytes into an attachment, which the phone shows
   as a file rather than as text. Kept under it with room to spare. */
const MAX_BYTES = 3900;

export function clip(s, max = MAX_BYTES) {
  let t = String(s ?? '');
  if (Buffer.byteLength(t) <= max) return t;
  while (Buffer.byteLength(t) > max - 4) t = t.slice(0, -Math.max(1, Math.floor(t.length / 20)));
  return `${t} …`;
}

/**
 * @param m  { title, message, priority 1–5, tags: [emoji short codes], click: url|null }
 * @param o  { topic, url, token } — default to the settings; fetchImpl for tests
 * @returns  { ok, status?, id?, error? }
 */
export async function publish(m, {
  topic = get('NTFY_TOPIC', ''), url = get('NTFY_URL', NTFY_DEFAULT_URL), token = get('NTFY_TOKEN', ''),
  fetchImpl = fetch, timeoutMs = 10_000,
} = {}) {
  const t = String(topic || '').trim();
  if (!t) return { ok: false, error: 'NTFY_TOPIC is not set' };
  const body = {
    topic: t,
    title: String(m.title || '').slice(0, 250),
    message: clip(m.message),
    priority: m.priority ?? 3,
    tags: m.tags || [],
    ...(m.click ? { click: m.click } : {}),
  };
  try {
    const r = await fetchImpl(`${String(url || NTFY_DEFAULT_URL).trim().replace(/\/+$/, '')}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json',
        ...(String(token || '').trim() ? { authorization: `Bearer ${String(token).trim()}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      return { ok: false, status: r.status, error: `ntfy answered ${r.status}: ${
        (await r.text().catch(() => '')).slice(0, 160)}` };
    }
    const j = await r.json().catch(() => ({}));
    return { ok: true, status: r.status, id: j.id || null };
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 200) };
  }
}
