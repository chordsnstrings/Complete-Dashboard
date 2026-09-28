/* SMSALA — the SMS gateway, and the only file that talks to it.
   ═════════════════════════════════════════════════════════════════════════
   Used by the API (a staff member's reset code, confirming their mobile) and
   by the collector worker (the two driver messages in src/driver_sms.js).
   What the gateway does that its PDF does not say was measured on 2026-09-28
   and is written up in docs/COVERAGE.md "SMSala (SMS)":

     · the account has an IP allowlist, and a refused caller gets HTTP 200
       with {IsSuccess:false, ErrorCode:43} — so success is read from the
       body, never from the status;
     · POST /SendSmsV2 takes a JSON ARRAY even for one message; a bare object
       is a 400 from its .NET deserialiser;
     · MessageId is a 19-digit integer, above 2^53: JSON.parse rounds it, so
       it is read out of the raw text;
     · the delivery report echoes the full message text — for a code, the
       code — so nothing here returns or logs it.

   NOTHING IN THIS FILE LOGS A NUMBER OR A MESSAGE. A mobile number is class
   CT in the access layer and src/log.js prints whatever it is handed; the
   callers log a person or user id and maskPhone() at most. */
import { get } from './settings.js';

export const SMSALA_BASE_DEFAULT = 'https://api2.smsala.com';
/* The gateway's own numbering. A code is type 3 (OTP); the driver messages
   are transactional (type 2): they are about the driver's own work and money,
   not marketing. */
export const MESSAGE_TYPE = Object.freeze({ promotional: '1', transactional: '2', otp: '3' });

/* A UAE mobile, as SMSala wants it: 9715XXXXXXXX — country code, no plus.
   ─────────────────────────────────────────────────────────────────────────
   Accepted from the four ways the fleet's own records write one (05XXXXXXXX,
   +9715…, 009715…, 9715…) with spaces, dashes, dots and brackets ignored.
   Nothing is padded and nothing is truncated: five stored numbers are 8, 13
   and 14 digits, a Bahraini and a British number (measured 2026-09-28), and a
   normaliser that "fixed" them would text a stranger. The second digit after
   5 is the operator prefix: 50, 52, 54, 55, 56, 58 are the UAE's mobile
   ranges; anything else is refused rather than sent to. */
export function uaeMobile(raw) {
  if (raw == null) return null;
  let d = String(raw).trim().replace(/[\s\-.()]/g, '');
  if (!d) return null;
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (/^05\d{8}$/.test(d)) d = `971${d.slice(1)}`;
  return /^9715[024568]\d{7}$/.test(d) ? d : null;
}

/* The last two digits and nothing else — what a log line or a page for a
   role without contact details may carry. */
export const maskPhone = (p) => (p ? `•••••••••${String(p).slice(-2)}` : null);

/* GSM 7-bit or UCS-2. The gateway bills a Unicode part at 70 characters, not
   160; place names from trip addresses are English, but an Arabic area name
   must not arrive as question marks. */
const GSM_ONLY = /^[A-Za-z0-9 \n\r@£$¥!"#%&'()*+,\-./:;<=>?_¡§¿ÄÅÆÇÉÑÖØÜßàäåæèéìñòöøùü]*$/;
export const encodingFor = (text) => (GSM_ONLY.test(String(text)) ? '0' : '8');

/* The MessageId out of the raw body, as text. */
const idFrom = (raw) => {
  const m = String(raw).match(/"MessageId"\s*:\s*"?(\d+)"?/);
  return m ? m[1] : null;
};

/** Send one SMS. Resolves to {ok:true, messageId, sender} or
 *  {ok:false, error, detail} — never throws, never logs. `fetchImpl` and the
 *  three settings are parameters so a test can run it against a fake. */
export async function sendSms({ to, text, type = 'transactional', ref = null,
  fetchImpl = globalThis.fetch,
  token = get('SMSALA_API_TOKEN'),
  sender = get('SMSALA_SENDER', 'ECOSINE'),
  base = get('SMSALA_BASE', SMSALA_BASE_DEFAULT) } = {}) {
  if (!token) return { ok: false, error: 'not_configured', detail: 'No SMSala token is set (Settings → SMSala).' };
  const dest = uaeMobile(to);
  if (!dest) return { ok: false, error: 'bad_number', detail: 'Not a UAE mobile number.' };
  if (!MESSAGE_TYPE[type]) return { ok: false, error: 'bad_type', detail: `Unknown message type ${type}.` };
  const body = [{
    apiToken: token, messageType: MESSAGE_TYPE[type], messageEncoding: encodingFor(text),
    destinationAddress: dest, sourceAddress: sender, messageText: String(text),
    ...(ref ? { userReferenceId: String(ref).slice(0, 60) } : {}),
  }];
  let res; let raw;
  try {
    res = await fetchImpl(`${String(base).replace(/\/+$/, '')}/SendSmsV2`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    raw = await res.text();
  } catch (e) {
    return { ok: false, error: 'unreachable', detail: String(e?.message || e).slice(0, 160) };
  }
  let j = null;
  try { j = JSON.parse(raw); } catch { /* handled below */ }
  if (!j) return { ok: false, error: 'bad_answer', detail: `HTTP ${res.status}, not JSON.` };
  if (!Array.isArray(j)) {
    /* The envelope a refusal comes in, on HTTP 200 as often as not. */
    const code = j.ErrorCode ?? j.status ?? res.status;
    return { ok: false, error: `refused_${code}`, detail: String(j.ErrorDescription || j.title || `HTTP ${res.status}`).slice(0, 200) };
  }
  const first = j[0] || {};
  const messageId = idFrom(raw);
  if (first.Status !== 'Success' || Number(first.OperationCode) !== 0) {
    return { ok: false, error: 'not_submitted', detail: String(first.Remarks || first.Status || 'no status').slice(0, 200), messageId };
  }
  return { ok: true, messageId, sender };
}

/** The delivery report for one message: status word, when it was sent, what
 *  it cost. The message text the gateway echoes is dropped here, on purpose. */
export async function deliveryReport(messageId, { fetchImpl = globalThis.fetch,
  token = get('SMSALA_API_TOKEN'), base = get('SMSALA_BASE', SMSALA_BASE_DEFAULT) } = {}) {
  if (!token || !messageId) return { ok: false, error: 'not_configured' };
  let raw;
  try {
    const u = `${String(base).replace(/\/+$/, '')}/Dlr/GetDetails?apiToken=${encodeURIComponent(token)}&messageId=${encodeURIComponent(messageId)}`;
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(20_000) });
    raw = await res.text();
  } catch (e) { return { ok: false, error: 'unreachable', detail: String(e?.message || e).slice(0, 160) }; }
  /* Two of eight polls ten seconds apart came back empty (measured): an empty
     body is "ask again", not "failed". */
  if (!raw || !raw.trim()) return { ok: false, error: 'empty' };
  let j; try { j = JSON.parse(raw); } catch { return { ok: false, error: 'bad_answer' }; }
  const d = Array.isArray(j?.ReturnData) ? j.ReturnData[0] : j?.ReturnData;
  if (!j?.IsSuccess || !d) return { ok: false, error: `refused_${j?.ErrorCode ?? 'unknown'}`, detail: j?.ErrorDescription || null };
  return { ok: true, status: d.DlrStatus ?? null, sentAt: d.SentDateTime ?? null,
    cost: d.CustomerCost == null ? null : Number(d.CustomerCost), parts: d.MessageParts ?? null };
}
