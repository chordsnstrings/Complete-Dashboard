// Date helpers for chunked historical pulls.

// Yield [start,end] Date pairs of at most `maxDays` covering [from,to], oldest→newest.
export function* dateChunks(from, to, maxDays = 31) {
  let s = new Date(from);
  const end = new Date(to);
  while (s <= end) {
    const e = new Date(s);
    e.setUTCDate(e.getUTCDate() + maxDays - 1);
    if (e > end) e.setTime(end.getTime());
    yield [new Date(s), new Date(e)];
    s = new Date(e);
    s.setUTCDate(s.getUTCDate() + 1);
  }
}

export const monthsAgo = (n) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d; };
export const daysAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };

export const iso = (d) => d.toISOString().slice(0, 10);          // YYYY-MM-DD
export const dotDate = (d) => iso(d).replace(/-/g, '.');          // YYYY.MM.DD (FMS)
export const unixMs = (d) => String(new Date(d).getTime());
export const unixS = (d) => String(Math.floor(new Date(d).getTime() / 1000));

// Parse FMS "DD/MM/YYYY HH:MM:SS" → ISO string (Dubai local, +04:00).
export function parseFmsTime(s) {
  if (!s) return null;
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, HH, MM, SS] = m;
  return `${yyyy}-${mm}-${dd}T${HH}:${MM}:${SS}+04:00`;
}

// "H:MM:SS" or "HH:MM:SS" → seconds
export function hmsToSeconds(s) {
  if (!s) return null;
  const p = String(s).split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
}

/* ── how long is this credential good for? ────────────────────────────────
   Several of the credentials the collector holds are JWTs that expire on a
   schedule nobody is watching: the Bolt portal refresh token lasts about a
   week, and when it dies the only symptom is a source quietly writing zero
   rows. A JWT states its own expiry in the clear, so there is no reason for
   that to be a surprise.

   Deliberately total: an opaque cookie is not a JWT and must come back null
   rather than throwing, because this runs over every stored secret. */
export function jwtPayload(tok) {
  try {
    const part = String(tok).split('.')[1];
    if (!part) return null;
    const p = JSON.parse(Buffer.from(part, 'base64url').toString());
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

export function jwtExpiry(tok, now = Date.now()) {
  const p = jwtPayload(tok);
  const exp = Number(p?.exp) || null;
  if (!exp) return null;
  const ms = exp * 1000;
  return {
    expires_at: new Date(ms).toISOString(),
    days_left: Math.round(((ms - now) / 86400000) * 10) / 10,
    expired: ms <= now,
  };
}
