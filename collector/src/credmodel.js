/* The model's job here is to guess, and nothing else.
   ─────────────────────────────────────────────────────────────────────────
   src/credkit.js recognises a credential by decoding a field inside it, which
   is exact and needs no model at all. This is for what is left over: a block
   nothing recognised, because it came from a provider with no marker, or the
   operator pasted half a curl command, or a new integration exists that the
   recognisers predate.

   The architecture is the analyst's, for the same reason. The model proposes,
   code composes the measurement, the provider adjudicates:

     it may     name which of the catalogue's keys a block probably is, and
                say why in one sentence.
     it may not decide anything. Its answer is a CANDIDATE, and a candidate
                still has to pass the same live check in src/credcheck.js that
                a recognised credential passes before it can be stored.

   That ordering is what makes it safe to be wrong. A hallucinated key names a
   setting the check then fails against the real provider, and nothing is
   written. The worst case is a wasted request, not a credential in the wrong
   slot — which is the failure this whole feature exists to prevent.

   Two things are never sent. The catalogue's key names and labels go up; the
   pasted VALUE does not, beyond a short redacted silhouette — the length, the
   character classes, and the names of any cookies in it. A model does not need
   the secret to say what kind of secret it is, and a credential mailed to a
   third party to be identified is a credential that has been disclosed. */
import { config } from './config.js';
import { http } from './http.js';
import { SETTING_DEFS } from './settings.js';
import { cookieMap, cookieText } from './credkit.js';
import { log } from './log.js';

const SRC = 'credmodel';

/* What a block looks like, without being what it is. Enough for a model to
   tell a JWT from a cookie jar from a user:pass, and not enough to use. */
export function silhouette(block) {
  const text = String(block || '');
  const jar = cookieMap(cookieText(text));
  const names = Object.keys(jar);
  return {
    length: text.length,
    lines: text.split('\n').length,
    looks_like: /^ey[A-Za-z0-9_-]+\./.test(text.trim()) ? 'a JWT'
      : names.length > 2 ? 'a cookie jar'
        : /^[A-Za-z0-9._-]+:[^\s]+$/.test(text.trim()) ? 'a user:password pair'
          : /^[A-Za-z0-9._-]{20,}$/.test(text.trim()) ? 'an opaque token'
            : 'free text',
    /* Cookie NAMES, never values: a name is a schema, a value is the secret. */
    cookie_names: names.slice(0, 40),
    /* The first line only, and only where it is plainly not a secret — a curl
       command's URL is the strongest hint a block carries about its provider. */
    url: (text.match(/https?:\/\/[a-z0-9.-]+/i) || [null])[0],
  };
}

const CATALOGUE = () => SETTING_DEFS
  .filter((d) => d.secret)
  .map((d) => ({ key: d.key, group: d.group, label: d.label }));

const PROMPT = `You identify which stored credential a pasted block of text is, for a
vehicle-fleet dashboard. You are given a SILHOUETTE of the block — its length, its
shape, the names of any cookies in it, and any URL it mentions — never the secret
itself, and never enough to use it.

Answer with a JSON array and nothing else. One object per block, in the order given:

  [{"index": 0, "key": "UBER_WEB_COOKIE", "confidence": "high"|"low", "why": "one sentence"}]

Rules:
- "key" MUST be one of the keys in the catalogue, or null.
- null is the right answer whenever you are not reasonably sure. Something else
  tests every guess against the real provider and discards what fails, so a
  wrong guess costs a request; but a confident wrong guess wastes an operator's
  attention, which is the scarcer thing.
- The cookie names are the strongest signal. A jar carrying Yandex names is not
  the same provider as one carrying Uber names.
- Do not explain your reasoning outside the JSON.`;

/** Ask the model to name the leftovers. Returns [] on any failure — an absent
    model is a feature with one less step, not an error the operator must fix. */
export async function proposeKeys(blocks) {
  if (!blocks.length) return [];
  const { baseUrl, apiKey, model } = config.analystModel;
  if (!apiKey) return [];
  const body = {
    model,
    messages: [
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify({
        catalogue: CATALOGUE(),
        blocks: blocks.map((b, index) => ({ index, ...silhouette(b) })),
      }) },
    ],
    max_tokens: 900, temperature: 0.1,
    ...(/minimax/i.test(baseUrl || '') ? { thinking: { type: 'disabled' } } : {}),
  };
  let data;
  try {
    ({ data } = await http(`${baseUrl}/chat/completions`, {
      method: 'POST', timeoutMs: 60000, retries: 0,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  } catch (e) {
    log.warn(SRC, 'model call failed', { err: String(e?.message || e).slice(0, 160) });
    return [];
  }
  const text = data?.choices?.[0]?.message?.content;
  if (!text) return [];
  /* The same bracket-matching the analyst needs: an M-series model narrates
     around its JSON and sometimes corrects itself with a second array. */
  const arrays = [...String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').matchAll(/\[[\s\S]*?\]/g)]
    .map((m) => { try { return JSON.parse(m[0]); } catch { return null; } })
    .filter(Array.isArray);
  const parsed = arrays.length ? arrays[arrays.length - 1] : [];
  const known = new Set(SETTING_DEFS.map((d) => d.key));
  return parsed
    .filter((p) => p && typeof p.index === 'number' && blocks[p.index] != null)
    .map((p) => ({
      index: p.index,
      /* A key the catalogue does not have is a hallucination, and is dropped
         here rather than being carried to a check that would fail anyway. */
      key: known.has(p.key) ? p.key : null,
      confidence: p.confidence === 'high' ? 'high' : 'low',
      why: String(p.why || '').slice(0, 200),
    }))
    .filter((p) => p.key);
}
