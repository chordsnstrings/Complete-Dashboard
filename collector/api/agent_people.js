/* WHO "KHALID" IS — the assistant's name and plate lookup, done here, never by
   the model.
   ──────────────────────────────────────────────────────────────────────────
   The matching is api/name_match.js — trigram and edit distance over a few
   hundred names, exact, reproducible, and argued there at length. This file
   adds the two things a chat needs that a spreadsheet import did not:

   1. EVERY SPELLING A PERSON IS FILED UNDER. The Drivers page shows one name
      per person (the spine's), but a reader may type the Bolt spelling, or the
      hotel's. Each person carries every name the identity register holds for
      any of their accounts (api/identity_map.js), and scores as the best of
      them.

   2. THE SPELLINGS OF ONE NAME. Muhammad / Mohammad / Mohammed / Mohamed /
      Muhammed / Mohd / Md are one word on this roster, and Ahmad / Ahmed,
      Abdul Rahman / Abdulrahman likewise. name_match forgives one letter on a
      long token; these differ by two or three, so they are folded to one form
      on BOTH sides before scoring.

   It returns candidates and a verdict; it never chooses between two people.
   "ambiguous" is the case the assistant must turn into a question —
   "Muhammad Khalid" and "Muhammad Khalid Younas Gul" are two men the register
   refuses to merge (77 trips at the same moment in two cars), and a lookup
   that picked the higher score would put one man's work under the other's
   name. */
import { score, tokenScore, STRONG, FLOOR } from './name_match.js';
import { MERGES } from './identity_map.js';

const VARIANTS = [
  [/\b(?:mohammad|mohammed|mohamed|mohamad|muhammed|muhamad|mohd|md|mohmmad|mohammmad|muhamed)\b/g, 'muhammad'],
  [/\bahmed\b/g, 'ahmad'],
  [/\b(?:abdul|abdel|abd al|abd el|abdal)\s+/g, 'abdul'],
  [/\b(?:ullah|ulla)\b/g, 'ullah'],
  [/\b(\w+)\s+(ullah|uddin|ud din)\b/g, '$1$2'],
  [/\b(?:hussain|hussein|husain|husein)\b/g, 'hussain'],
  [/\b(?:khaled)\b/g, 'khalid'],
];
export const normName = (s) => {
  let t = String(s ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, to] of VARIANTS) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
};

/* id → every name the register files that account's person under. */
const NAMES_BY_ID = (() => {
  const m = new Map();
  for (const e of MERGES) {
    const ids = [e.keep.id, ...(e.merge.ids || [e.merge.id])].filter(Boolean);
    const names = [e.keep.name, e.merge.name].filter(Boolean);
    for (const id of ids) {
      const set = m.get(id) || new Set();
      names.forEach((n) => set.add(n));
      m.set(id, set);
    }
  }
  return m;
})();

/**
 * People, as the Drivers page lists them, matched against what the reader
 * typed. `rows` are /api/drivers/directory rows.
 * @returns {{verdict, candidates:[{driver_id,name,also_known_as,platforms,plate,fleet,last_trip,lifetime_trips,score}], why}}
 */
export function findDriver(name, rows) {
  const needle = normName(name);
  if (!needle) return { verdict: 'none', candidates: [], why: 'no name was given' };
  const scored = [];
  const oneWord = !needle.includes(' ');
  for (const r of rows || []) {
    const names = new Set([r.driver_name]);
    for (const id of r.ids || []) for (const n of NAMES_BY_ID.get(String(id)) || []) names.add(n);
    let best = 0;
    let carries = false;
    for (const n of names) {
      const nn = normName(n);
      let sc = score(needle, nn);
      /* Glued or split: "Abdulrahman" against "Abdul Rahman". */
      if (sc < 1 && needle.replace(/ /g, '') === nn.replace(/ /g, '')) sc = 1;
      if (sc > best) best = sc;
      if (oneWord && tokenScore(needle, nn) >= 1) carries = true;
    }
    if (best >= FLOOR) {
      scored.push({ score: best, row: r, carries, names: [...names].filter((n) => n && n !== r.driver_name) });
    }
  }
  scored.sort((a, b) => b.score - a.score || (b.row.lifetime_trips || 0) - (a.row.lifetime_trips || 0));
  const pick = scored.slice(0, 6).map(({ score: sc, row: r, names }) => ({
    driver_id: String(r.driver_ext_id || (r.ids || [])[0] || ''),
    name: r.driver_name,
    also_known_as: names.slice(0, 4),
    platforms: r.platforms || [],
    plate: r.plate || r.state_plate || null,
    fleet: r.fleet_id || null,
    last_trip: r.last_ever || r.last_trip || null,
    lifetime_trips: r.lifetime_trips ?? null,
    score: Math.round(sc * 1000) / 1000,
  }));
  if (!pick.length) {
    return { verdict: 'none', candidates: [],
      why: `nobody on the Drivers page is filed under a name close to "${name}"` };
  }
  const top = pick[0]; const next = pick[1];
  /* ONE WORD IS A FIRST NAME, and a first name two drivers carry names
     nobody. "Shehzad" scored one man at 0.885 and "Muhammad Asim Shahzad" at
     0.748 — a clear margin by the numbers, and a coin toss by the meaning,
     since Shehzad and Shahzad are one name spelled two ways. Whenever two or
     more people carry the typed word (or a one-letter variant of it) in
     full, it is a question. */
  const carriers = oneWord ? scored.filter((x) => x.carries).length : 0;
  const exactCount = pick.filter((p) => p.score >= 0.999).length;
  /* Ambiguous whenever a second candidate is close — including two exact
     hits, which is what a first name alone ("Khalid") produces. */
  const clear = !next || (top.score - next.score) >= 0.08;
  const verdict = exactCount > 1 || !clear || carriers > 1 ? 'ambiguous' : top.score >= 0.999 ? 'exact'
    : top.score >= STRONG ? 'likely' : 'weak';
  return {
    verdict,
    candidates: verdict === 'exact' || verdict === 'likely' ? pick.slice(0, 3) : pick,
    why: {
      exact: `one person is filed under exactly this name${top.also_known_as.length ? ' (or one of their other spellings)' : ''}`,
      likely: `one person scores ${top.score} and the next ${next ? next.score : 'nobody'} — clear, but say which name you matched`,
      ambiguous: `${carriers > 1 ? `${carriers} people carry "${name}" in their name` : `${pick.length} people could be meant`}`
        + `${exactCount > 1 ? `, ${exactCount} of them filed under exactly this name` : ''}`
        + `${scored.length > pick.length ? ` (the closest ${pick.length} are listed)` : ''} — ask which one, giving their plate and platforms`,
      weak: `the closest is ${top.name} at ${top.score}, below ${STRONG} — ask before using it`,
    }[verdict],
  };
}

/* Plates as people type them: "L90721", "l 90721", "90721". */
export const normPlate = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Cars on the Vehicles directory matching a plate as typed. */
export function findCar(plate, rows) {
  const p = normPlate(plate);
  if (!p) return { verdict: 'none', candidates: [], why: 'no plate was given' };
  const all = (rows || []).filter((r) => r.plate);
  const exact = all.filter((r) => normPlate(r.plate) === p);
  const digits = p.replace(/^[A-Z]+/, '');
  const tail = exact.length ? [] : all.filter((r) => digits.length >= 3 && normPlate(r.plate).endsWith(digits));
  const hits = (exact.length ? exact : tail).slice(0, 6).map((r) => ({
    plate: r.plate, fleet: r.fleet_id || null, make: r.make || null, model: r.model || null,
    current_driver: r.current_driver || null, last_trip: r.last_trip || null,
  }));
  if (!hits.length) return { verdict: 'none', candidates: [], why: `no car on the Vehicles page has the plate "${plate}"` };
  return { verdict: hits.length === 1 ? (exact.length ? 'exact' : 'likely') : 'ambiguous', candidates: hits,
    why: hits.length === 1 ? (exact.length ? 'one car has exactly this plate' : `one plate ends in ${digits}`)
      : `${hits.length} plates end in ${digits} — ask which one` };
}
