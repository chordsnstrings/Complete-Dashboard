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

import { api } from './data.js';

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

/* SIX AT A TIME.
   A hundred and twenty parallel requests against a one-vCPU database is a
   self-inflicted outage; one at a time is four minutes of somebody watching a
   spinner. Shared by every grid on these screens rather than copied into each,
   because the number is a fact about the database and not about the page. */
export const LANES = 6;
export async function pooled(items, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, async () => {
    for (;;) {
      const k = i; i += 1;
      if (k >= items.length) return;
      // eslint-disable-next-line no-await-in-loop
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

/* A CSV a person exported from a spreadsheet, parsed where it was chosen.
   ─────────────────────────────────────────────────────────────────────────
   In the browser, deliberately: the file never leaves the machine it was
   picked on until a human has looked at what it matched, and the import
   preview then receives ROWS rather than a file it has to guess the shape of.

   Quoted fields, embedded commas, doubled quotes and CRLF are all things a
   real export contains — a split(',') parser turns "Khan, Muhammad" into two
   columns and every row after it is off by one, silently. */
export function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let quoted = false; let i = 0;
  const s = String(text ?? '').replace(/^\uFEFF/, '');
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { quoted = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
}

/** Header row plus data rows, as objects keyed by a folded header name. */
export function csvObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { headers: rows[0] || [], objects: [] };
  const headers = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  return {
    headers,
    objects: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, k) => [h, r[k] ?? '']))),
  };
}

/* WHO A PICKER MAY OFFER — and why it is not the list of people who owe money.
   ─────────────────────────────────────────────────────────────────────────
   THE CLOSED LOOP THIS EXISTS TO BREAK. People on this ledger are minted
   lazily, by the first entry recorded against them (api/ledger_person.js), and
   every one of these screens originally listed drivers from
   /api/ledger/exposure — which reads `driver`. On a ledger nobody has written
   to, `driver` is empty, so the picker offered nobody, so no entry could be
   made, so nobody was ever minted. The first live read of production returned
   five zeroes and a policy that could not be judged, and none of the test
   files caught it because every one of them seeds a person before it asks.

   So the OFFER comes from /api/ledger/people, which unions the minted people
   with the roster accounts nobody has claimed yet, and the FIGURES come from
   /api/ledger/exposure, folded on afterwards. The two are different questions
   and were being answered by one endpoint that could only ever answer the
   second.

   A roster row carries person_id: null, and that is load-bearing. The write
   path takes the ACCOUNT for those and resolves it inside the same transaction
   as the entry, so the identity decision is taken once, by the resolver, with
   the merge register in hand — rather than by a page that fabricated an id.

   EXPOSURE FAILING IS NOT PEOPLE FAILING. If the figures cannot be read the
   list is still returned, with `exposure_absent_reason` set and every row's
   figures null — an operator can still record a handover, which is the whole
   point of the screen, and every number renders absent with the true reason
   rather than as a zero. */
export async function loadPeople({ from = null, to = null } = {}) {
  const qs = [from && `from=${from}`, to && `to=${to}`].filter(Boolean).join('&');
  const [dir, ex] = await Promise.all([
    api('/api/ledger/people').catch(() => null),
    api(`/api/ledger/exposure${qs ? `?${qs}` : ''}`).catch(() => null),
  ]);
  if (!dir) {
    return { ok: false, people: [], known: 0, unmapped: 0,
      error: 'the list of drivers could not be read, so there is nobody to record against' };
  }

  const fig = new Map();
  for (const p of ex?.people || []) if (p.person_id != null) fig.set(Number(p.person_id), p);

  const exposureAbsentReason = ex ? null
    : 'the exposure figures could not be read. Recording is unaffected — what is missing is '
      + 'the balance beside each name, not the ability to enter one.';

  /* THE EXPOSURE ROW SUPPLIES THE FIGURES; THE OFFER ROW SUPPLIES THE IDENTITY.
     Spread in that order, deliberately. Exposure computes a dozen fields — the
     earned denominator and why it is missing, the cash basis, the verdict in
     words — and naming them one at a time here is a list that silently goes
     stale the next time one is added, which is how #salary came to render a
     blank Generated column. So exposure goes in wholesale and the offer row
     overwrites the four fields that decide WHO this is; those must come from
     the list that also holds people exposure has never heard of. */
  const people = (dir.people || []).map((p) => {
    const f = (p.person_id != null ? fig.get(Number(p.person_id)) : null) || {};
    return {
      ...f,
      ...p,
      /* ext_id: exposure picks the account it could link; the offer row's is
         the account it was listed under. Either opens the right driver, and
         exposure's is the one already proven against test/interlinking. */
      ext_id: f.ext_id || p.ext_id || null,
      exposure_pct: f.exposure_pct ?? null,
      exposure_absent_reason: f.exposure_absent_reason || exposureAbsentReason
        || (p.person_id == null
          ? 'nothing has ever been recorded against this driver, so there is no balance to '
            + 'show. They are listed because they are on the roster and can be recorded against.'
          : null),
      /* A roster row genuinely has no figures. Null rather than absent, so a
         render that reaches for one gets the dash and its reason rather than
         undefined. */
      owes: f.owes || null,
      earned: f.earned ?? null,
      earned_absent_reason: f.earned_absent_reason
        || (p.person_id == null
          ? 'this driver has no ledger record yet, so nothing has been attributed to them'
          : null),
      /* From the offer list, always: exposure cannot know the cash rule of
         somebody it has never seen, and a stale one here decides what the
         deposit screen asks of a driver. */
      cash_rule: p.cash_rule ?? null,
      accounts: p.accounts,
      on_the_ledger: p.on_the_ledger,
      person_id: p.person_id,
      name: p.name,
      platform: p.platform,
    };
  });

  return {
    ok: true, people,
    known: dir.known, unmapped: dir.unmapped, note: dir.note,
    policy: ex?.policy || null,
    policy_absent_reason: ex?.policy_absent_reason || null,
    exposure_ok: ex != null,
    exposure_absent_reason: exposureAbsentReason,
  };
}

/** The fields a write must send to address this person. A minted person is
 *  addressed by id; an unclaimed roster row by the ACCOUNT, which the server
 *  resolves. Never both, and never a name — api/import_routes.js refuses a
 *  name at the boundary for the same reason.
 *
 *  THE SAME RULE AS `personRef` IN api/ledger_person.js, and deliberately a
 *  copy: this file ships to a browser and that one imports the merge register,
 *  which must not. test/ledger_ui.test.mjs asserts the two agree, because a
 *  rule that exists twice is a rule that drifts. */
export function personRef(p) {
  if (!p) return null;
  return p.person_id != null
    ? { person_id: p.person_id }
    : { platform: p.platform, ext_id: p.ext_id };
}

/** How a picker labels somebody, including whether they are new to the ledger.
 *  Said rather than implied: an operator choosing a name that has never been
 *  recorded against should know that before the money moves, not after. */
export function personLabel(p) {
  if (!p) return '';
  return p.on_the_ledger ? p.name : `${p.name} — new to the ledger`;
}
