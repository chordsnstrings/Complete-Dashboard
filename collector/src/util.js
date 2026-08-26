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

/* Whole Monday-anchored weeks covering [from,to], oldest→newest.
   ─────────────────────────────────────────────────────────────────────────
   dateChunks anchors its grid to whatever `from` happens to be, which is fine
   for a trip pull — the same trip upserts to the same row whichever window it
   arrives in. It is wrong for a REPORT, where the window IS the key: the same
   payout week fetched by a backfill starting on a Saturday and a catch-up
   starting on a Thursday lands as two rows six days apart, and a sum over them
   counts nearly everything twice. Live, one driver's twenty-eight weeks were
   stored as sixty-seven overlapping rows and summed to 128,357 AED against a
   true 57,110.

   So the grid is fixed to the calendar instead of to the run. Every run
   produces the same boundaries, and the upsert replaces rather than adds.

   `until` is the EXCLUSIVE upper bound — the instant the week ends, which is
   midnight on the following Monday. A provider handed the last day covered as
   its end bound returns six days of a seven-day week, and Uber does: measured
   across three grids and twenty-eight weeks, every window reported 85.5% of
   the trips the trip feed holds for the same span. 6/7 is 0.857.

   Both edges are widened to whole weeks rather than clipped. A clipped week is
   a different key, which is the bug this exists to prevent, and asking for a
   few extra days costs one request. */
export function* weekChunks(from, to) {
  const monday = (d) => {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    // getUTCDay: 0=Sunday. Sunday belongs to the week that began six days ago.
    x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
    return x;
  };
  const last = monday(new Date(to));
  let s = monday(new Date(from));
  while (s <= last) {
    const end = new Date(s); end.setUTCDate(end.getUTCDate() + 6);
    const until = new Date(s); until.setUTCDate(until.getUTCDate() + 7);
    yield { start: new Date(s), end, until };
    s = until;
  }
}

/* Dubai days, half-open, for a source that buckets by instant.
   ─────────────────────────────────────────────────────────────────────────
   weekChunks above is UTC-aligned, which is right for a report grid keyed on
   the provider's own week. A DAY is different: the fleet works Asia/Dubai and
   every other day figure in this product is `AT TIME ZONE 'Asia/Dubai'`, so a
   UTC-aligned day would start at 04:00 local and file four hours of each
   morning under the day before — visible immediately on a page that puts a
   payout day beside its trip day.

   `start`/`until` are the instants to ASK for; `day` is the date to STAMP,
   which is the Dubai calendar date the window covers. */
export function* dubaiDayChunks(from, to) {
  const TZ = 4 * 3600e3;
  const dayOf = (d) => {
    const x = new Date(new Date(d).getTime() + TZ);
    return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) - TZ;
  };
  const last = dayOf(to);
  for (let t = dayOf(from); t <= last; t += 864e5) {
    yield { start: new Date(t), until: new Date(t + 864e5), day: iso(new Date(t + TZ)) };
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
