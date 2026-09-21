/* MATCHING A SPREADSHEET NAME TO A PERSON — locally, and without a model.
   ─────────────────────────────────────────────────────────────────────────
   The operator asked for a spreadsheet import with fuzzy matching. The obvious
   implementation posts the sheet's name column and the roster's name column to
   a language model and asks it to pair them up. This product has an explicit,
   argued rule against exactly that, in the two places it already calls one:

     src/analyst.js:406-410  "What the model is allowed to see. Aggregates only
                              — no rows, no names of guests, no addresses, no
                              phone numbers."
     src/credmodel.js:23-27  "a credential mailed to a third party to be
                              identified is a credential that has been
                              disclosed" — and it sends a SILHOUETTE instead.

   A fuzzy matcher's entire input is the thing both rules forbid: several
   hundred real people's names, and beside each candidate the amount the
   company says that person owes. The default analyst endpoint is not even in
   the region this fleet operates in.

   The candidate set is a few hundred rows. Trigram and edit distance over that
   is exact, free, reproducible and auditable, which a model at temperature 0.1
   is none of. So the matching is here, and nothing leaves this building.

   ── AND IT PROPOSES. IT NEVER DECIDES. ───────────────────────────────────
   api/identity_map.js is a hand-reviewed LIST and argues at length that it must
   never learn to generalise; the five pairs it holds back carry simultaneous
   trips in two cars. A matcher that auto-applied its best guess would pool two
   people's debts at the moment money was imported against one of them. Every
   row comes back with a confidence and the runners-up, and a human confirms
   each one. */

/* Fold to what two spellings of one name have in common: case, punctuation and
   repeated whitespace. NOT the repeated-surname fold that api/identity_map.js
   uses for grouping — that one is deliberately looser and is wrong for a key,
   as api/driver_routes.js:102-108 spells out. */
export const foldName = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const tokens = (s) => foldName(s).split(' ').filter(Boolean);

/* Character trigrams over the folded string, padded so short names still
   produce some. Set-based Jaccard rather than a count, because "mohammed
   mohammed" and "mohammed" should be near-identical and a count would say
   otherwise. */
export function trigrams(s) {
  const t = `  ${foldName(s)} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i += 1) out.add(t.slice(i, i + 3));
  return out;
}

export function trigramScore(a, b) {
  const A = trigrams(a); const B = trigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/* Damerau-Levenshtein, bounded. A TRANSPOSITION COSTS ONE, not two, and that
   is not a refinement — it is the commonest difference between two spellings
   of a transliterated name. Plain Levenshtein scores "Afzal" against "Afzla"
   as two edits, the same as a name with two unrelated letters wrong, and the
   token rule below would then refuse a match a person would make instantly.

   Bounded because anything past `max` is "far enough" and the answer does not
   matter, which keeps a few-hundred-by-few-hundred comparison cheap. */
export function editDistance(a, b, max = 6) {
  const s = foldName(a); const t = foldName(b);
  if (Math.abs(s.length - t.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= t.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      /* The transposition step. */
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      }
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev2 = prev; prev = cur;
  }
  return prev[t.length];
}

/* THE TOKEN RULE, which is what actually matches these names.
   ─────────────────────────────────────────────────────────────────────────
   The roster's own shape, measured in sql/schema_v65.sql: Bolt and the hotel
   channel file the full legal name and Uber drops the middle one — "Zubair
   Khan Shaukat Ali" against "Zubair Khan Ali". Trigrams alone rank those below
   an unrelated name that happens to share a common first token, because
   "Muhammad" is most of the trigrams in half this roster.

   So the score is the share of the SHORTER name's tokens that appear in the
   longer one, which is 1.0 for a dropped middle name and low for two different
   people who merely share "Muhammad". Tokens under four characters are ignored
   for the exact-match half — "bin", "al", "md" carry no information and match
   everybody. */
export function tokenScore(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const [shortT, longT] = A.length <= B.length ? [A, B] : [B, A];
  const longSet = new Set(longT);
  let hit = 0;
  for (const tk of shortT) {
    if (longSet.has(tk)) { hit += 1; continue; }
    /* A near-miss on a substantial token still counts — one transposed letter
       in a transliterated name is the commonest difference between two
       spellings of it. Short tokens are excluded because an edit of one on a
       three-letter token is a different word. */
    if (tk.length >= 4 && longT.some((o) => o.length >= 4 && editDistance(tk, o, 1) <= 1)) hit += 1;
    /* AN INITIAL IS A TOKEN. "Muhammad Khalid G" is how a spreadsheet abbreviates
       "Muhammad Khalid Gul", and without this the initial counts as a miss —
       which scores the sheet name HIGHER against the unrelated "Muhammad
       Khalid" than against the man it actually names. Short tokens are
       otherwise ignored because "bin" and "al" match everybody; an initial is
       the one short token that carries information, and only against a token
       it actually begins. */
    else if (tk.length <= 2 && longT.some((o) => o.length > 2 && o.startsWith(tk))) hit += 1;
  }
  return hit / shortT.length;
}

/** Score one pair, 0..1. */
export function score(a, b) {
  if (!foldName(a) || !foldName(b)) return 0;
  if (foldName(a) === foldName(b)) return 1;
  /* Weighted toward tokens for the reason above, with trigrams keeping a name
     that shares every token but in a different form from scoring as an exact
     match. */
  return Math.round((0.7 * tokenScore(a, b) + 0.3 * trigramScore(a, b)) * 1000) / 1000;
}

/* Above this a row is offered as the likely match; a human still confirms it.
   Below the floor nothing is offered at all, because an unranked guess on a
   money import is worse than an empty field a person has to fill. */
export const STRONG = 0.86;
export const FLOOR = 0.45;

/**
 * Match one spreadsheet name against the roster.
 * Returns { best, confidence, alternatives, verdict }.
 *
 * verdict is the thing a screen acts on:
 *   'exact'      the folded names are identical
 *   'likely'     one candidate above STRONG and clear of the next
 *   'ambiguous'  two or more candidates close together — the dangerous case,
 *                and the one a matcher must never resolve on its own
 *   'weak'       a best guess below STRONG
 *   'none'       nothing above FLOOR
 */
export function matchName(needle, people, { strong = STRONG, floor = FLOOR } = {}) {
  const ranked = people
    .map((p) => ({ person: p, score: score(needle, p.name) }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return { best: null, confidence: 0, alternatives: [], verdict: 'none',
      why: `nothing on the roster scores above ${floor} against "${needle}". Either this person `
        + 'is not on it, or the sheet spells them in a way no rule here reaches — which is a '
        + 'row for a human to place, not for a matcher to guess at.' };
  }

  const top = ranked[0];
  const next = ranked[1] || null;
  const clear = !next || (top.score - next.score) >= 0.08;
  const exact = foldName(needle) === foldName(top.person.name);

  /* AMBIGUOUS IS ITS OWN VERDICT, not a low confidence. Two candidates within
     a hair of each other is precisely the case where picking the higher one is
     a coin toss — "Muhammad Khalid" against "Muhammad Khalid Gul", who
     api/identity_map.js holds apart because they carry 77 simultaneous trips on
     two plates. A screen must present both and refuse to default. */
  const verdict = exact ? 'exact'
    : (!clear ? 'ambiguous'
      : (top.score >= strong ? 'likely' : 'weak'));

  return {
    best: top.person,
    confidence: top.score,
    alternatives: ranked.slice(1, 4).map((r) => ({ person: r.person, score: r.score })),
    verdict,
    why: {
      exact: 'the names are identical once case and punctuation are folded away',
      likely: `scores ${top.score} and the next candidate is ${next ? next.score : 'none'} — `
        + 'clear enough to offer, and still to be confirmed',
      ambiguous: `two candidates are within ${next ? Math.round((top.score - next.score) * 1000) / 1000 : 0}`
        + ' of each other. Picking the higher one would be a coin toss, and this roster holds '
        + 'pairs that are deliberately kept apart because they are two people.',
      weak: `the best score is ${top.score}, below ${strong}. Offered so a person can see it, `
        + 'not because it is probably right.',
    }[verdict],
  };
}
