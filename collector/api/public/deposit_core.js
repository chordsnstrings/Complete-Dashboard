/* RECORDING A CASH HANDOVER — the part the phone and the desktop must not
   disagree about.
   ─────────────────────────────────────────────────────────────────────────
   A supervisor takes cash from a driver at the car and records it; finance
   records the same thing at a desk from a bundle of receipts. Two screens, one
   event, and every rule about it lives here rather than twice.

   That is not tidiness. api/ledger_routes.js already assembles the confirming
   SENTENCE server-side for exactly this reason — so the two shells cannot
   describe one entry differently — and a validation rule copied into two
   bundles is the same defect one layer up: the phone would refuse what the
   desktop accepts, and the supervisor standing next to the car would be the
   one who found out.

   ── COMPRESSION HAPPENS HERE, IN THE BROWSER, DELIBERATELY ───────────────
   api/server.js runs on a basic-xxs instance — 512MB, and it serves every page
   in this product. Decoding a twelve-megapixel photograph there to resize it
   is how that container dies. The device that took the picture does it
   instead, which also means the bytes crossing a car-park connection are the
   compressed ones.

   The loop below re-encodes at falling quality until the result fits, rather
   than picking a quality and hoping: a JPEG's size depends on what is IN it,
   and a receipt photographed against a busy background can be three times the
   size of the same receipt on a car seat. Guessing once would refuse the
   second one with a 413 at the end of the flow, after the cash had already
   changed hands. */

/* The route's limit is 1MB (api/ledger_routes.js). Aim under it with room for
   the multipart-free raw body to be exactly what we measured. */
export const MAX_BYTES = 900 * 1024;
export const MAX_EDGE = 1600;

/** Re-encode an image File to a Blob that fits MAX_BYTES, or explain why not. */
export async function compress(file, { maxBytes = MAX_BYTES, maxEdge = MAX_EDGE } = {}) {
  if (!file) return { error: 'no photograph was chosen' };
  if (!/^image\//.test(file.type || '')) {
    return { error: `that file is ${file.type || 'of no stated type'}, and this takes a `
      + 'photograph — jpeg, webp or png' };
  }
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return { error: 'that file could not be read as an image' };

  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();

  /* Falling quality, and the steps are coarse on purpose: each one is a full
     re-encode and a phone doing eight of them on a big image is a visible
     freeze in the middle of a handover. */
  for (const quality of [0.82, 0.7, 0.58, 0.45, 0.33]) {
    // eslint-disable-next-line no-await-in-loop
    const blob = await new Promise((done) => canvas.toBlob(done, 'image/jpeg', quality));
    if (blob && blob.size <= maxBytes) {
      return { blob, bytes: blob.size, width: w, height: h, quality,
        from: file.size, type: 'image/jpeg' };
    }
  }
  return { error: 'this photograph is still too large after compressing it as far as this '
    + 'screen will go. Take it again from closer in, or with less of the room in frame.' };
}

/** Upload the compressed bytes. Returns { sha256, … } or { error }. */
export async function putReceipt(blob, by) {
  const r = await fetch(`/api/ledger/receipt?by=${encodeURIComponent(by)}`, {
    method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { error: j.error || `the receipt was refused (${r.status})`, detail: j.detail };
  return j;
}

/** Preview or record an entry. `commit` false is the dry run, which is the
 *  server's default and is stated explicitly here so a reader of this file does
 *  not have to know that. */
export async function submitEntry(body, { commit = false } = {}) {
  const r = await fetch('/api/ledger/entry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, dry_run: !commit }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    return { error: (j.refused || []).join(' ') || j.error || `refused (${r.status})` };
  }
  return j;
}

/* The four people who may record money until ULM exists. Fetched from nothing:
   the server holds the same list and refuses anything else, so this copy is a
   convenience for the picker and NOT the enforcement. If they ever disagree
   the server wins and says so in words. */
export const SUPERVISORS = ['ahsan', 'haseeb', 'hossam', 'shohaib'];

/** AED with two decimals, always — a handover is counted in fils at the car. */
export const aed = (v) => (v == null || !Number.isFinite(Number(v)) ? null
  : `AED ${Number(v).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** What the operator typed, as a number, or null. Accepts a comma grouping
 *  because a person entering 1,250.00 has not made a mistake. */
export const parseAmount = (s) => {
  const t = String(s ?? '').trim().replace(/,/g, '');
  if (!t || !/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
};
