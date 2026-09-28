/* A FLEET'S NAME, DERIVED FROM WHAT THE PLATFORMS CALL IT — never typed.
   ─────────────────────────────────────────────────────────────────────────
   collector/docs/ULM-DESIGN.md §3.2 is the rule; this is it, as pure
   functions. No database, no request, no provider: the store is
   api/fleet_names_routes.js and the collector side is src/sources/discovery.js.

   THE DEFECT THIS REPLACES. The fleet's name was written into the product by
   hand in about forty places — SOURCE_LABEL, two pickers, "Ecosine & Egari" in
   two mastheads, `=== 'egari' ? 'Egari' : 'Ecosine'` two-way labels that would
   mislabel a third fleet — while `fleet.name` (sql/schema.sql:10-11) held a
   third spelling nobody read. The operator's rulings, 2026-09-26: the name is
   taken from the platforms; the name shown is the BRAND, "usually the common
   part of what the platforms call it"; nothing is hard-coded; everything real.

   WHAT THE PLATFORMS CALL THE TWO FLEETS, MEASURED 2026-09-26
   (docs/COVERAGE.md, "What each platform calls the fleets"):
     Uber    "ECOSINE TRANSPORTS"        "Egari Luxury Cars Transport LLC"
     Yango   "ECOSINE TRANSPORTS LLC"    —
     CABMAN  "Ecosine Transports LLC"    —      (and "Sahalat", another company)
     Bolt    company 142868, no name     company 142897, no name

   So a name has three spellings of one business and one of them is a legal
   form. Names are therefore NEVER compared for equality (§3.3.2): each is
   normalised — case and punctuation folded, the legal form dropped — and what
   they share is the longest run of words every one of them STARTS with:

     "ECOSINE TRANSPORTS" / "ECOSINE TRANSPORTS LLC" / "Ecosine Transports LLC"
        → common "Ecosine Transports" → brand "Ecosine"
     "Egari Luxury Cars Transport LLC"
        → common "Egari Luxury Cars Transport" → brand "Egari"

   The common part is usually brand + trade, so the brand is the common part
   cut at its first TRADE WORD. The trade words are vocabulary about
   businesses — what a transport company calls itself after its name — not a
   list of fleet names, so a fleet added next year gets its brand from its own
   platforms with no code change. That is the whole point of the ruling.

   THE TWO CASES WITH NO SINGLE ANSWER are answered with the truth, never with
   a pick (the house rule, applied to a name):
     no name at all   → "Unnamed fleet — Bolt company 142868", with the real
                        reason beside it (§3.2 rule 8);
     no common word   → every reported name, and "the platforms name this
                        fleet differently — choose one" (§3.2 rule 7).

   THE ADMIN CHOOSES, BUT DOES NOT TYPE (§3.2 rule 6). candidates() is every
   leading run of words of every reported name; a choice is valid only while
   it is still one of them (rule 9), so a platform renaming the business
   withdraws a choice that no longer describes it instead of pinning a stale
   word over the new name. */

/* Legal forms, as the one token each becomes once its punctuation is folded:
   "L.L.C." → "llc", "FZ-LLC" → "fzllc". Dropped only from the END of a name —
   a legal form is a suffix, and "Co" or "Est" in the middle of a name may be
   part of the name. Repeated, so "… L.L.C. FZE" loses both. */
export const LEGAL_FORMS = Object.freeze(['llc', 'fze', 'fzco', 'fzllc', 'ltd', 'est', 'co']);

/* Trade words: where a brand ends. The design's list (ULM-DESIGN §3.2 rule 4)
   — transport(s), cars, luxury, taxi, limousine, passenger, rent a car,
   services, trading, group — plus the other number of each noun, because a
   business registered as "… Transportation" or "… Limousines" is making the
   same statement. A phrase is matched as a phrase: "rent a car" cuts at
   "rent", and "car" alone is also a trade word. Longest phrases first. */
export const TRADE_WORDS = Object.freeze([
  ['rent', 'a', 'car'],
  ['transport'], ['transports'], ['transportation'],
  ['car'], ['cars'], ['luxury'],
  ['taxi'], ['taxis'], ['limousine'], ['limousines'], ['limo'],
  ['passenger'], ['passengers'],
  ['service'], ['services'], ['trading'], ['group'],
]);

/* A word as a key: lower case, accents folded, punctuation gone. Letters of
   any script and digits survive — a fleet named in Arabic keeps its name. */
export function foldWord(w) {
  return String(w ?? '')
    .normalize('NFKD').replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/* One name → its words, each with the key it is compared by and the
   spelling it is shown in. Split on whitespace (not on punctuation), so
   "L.L.C." is one word and "FZ-LLC" is one word — each then folds to the
   single legal-form token above. Words that fold to nothing ("&", "-") are
   not words. */
export function wordsOf(name) {
  const out = [];
  for (const raw of String(name ?? '').trim().split(/\s+/)) {
    const key = foldWord(raw);
    if (!key) continue;
    /* Shown without leading or trailing punctuation ("TRANSPORTS," →
       "TRANSPORTS"); inner punctuation is the platform's spelling and stays. */
    const shown = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    out.push({ key, shown });
  }
  while (out.length > 1 && LEGAL_FORMS.includes(out[out.length - 1].key)) out.pop();
  /* A name that is nothing BUT a legal form ("LLC") keeps it: dropping it
     would leave no name, and an empty name is a name the platform did not
     give, which is not what happened. */
  return out;
}

/* The normalised form of a name: its keys, space-joined. "ECOSINE
   TRANSPORTS LLC" and "Ecosine Transports L.L.C." both → "ecosine transports". */
export const normaliseName = (name) => wordsOf(name).map((w) => w.key).join(' ');

/* Does the platform shout? A name with letters and no lower-case letter at
   all. Only a shouting name is re-cased (§3.2 rule 5); "Egari Luxury Cars
   Transport LLC" is the platform's own spelling and is shown as written. */
export function shouts(name) {
  const s = String(name ?? '');
  return /\p{L}/u.test(s) && !/\p{Ll}/u.test(s);
}
const titleWord = (w) => {
  const lower = w.toLocaleLowerCase('en');
  return lower.charAt(0).toLocaleUpperCase('en') + lower.slice(1);
};

/* Words that are all names' leading words, in order: the longest run every
   name starts with. `names` are the platforms' strings as reported; blanks
   are not names and are ignored. Returns the KEYS of the run. */
export function commonLeadingKeys(names) {
  const lists = (names || []).map(wordsOf).filter((w) => w.length);
  if (!lists.length) return [];
  const out = [];
  for (let i = 0; ; i += 1) {
    const k = lists[0][i]?.key;
    if (!k || lists.some((l) => l[i]?.key !== k)) break;
    out.push(k);
  }
  return out;
}

/* How a run of words (keys) is SHOWN: in the spelling of the first reported
   name that starts with the run and does not shout; failing that, the
   shouted spelling title-cased. `names` in a stable order, so the same names
   always give the same spelling. */
export function displayRun(keys, names) {
  if (!keys.length) return '';
  const lists = (names || []).map((n) => ({ n, w: wordsOf(n) }))
    .filter((x) => keys.every((k, i) => x.w[i]?.key === k));
  const calm = lists.find((x) => !shouts(x.n));
  if (calm) return calm.w.slice(0, keys.length).map((w) => w.shown).join(' ');
  const loud = lists[0];
  if (loud) return loud.w.slice(0, keys.length).map((w) => titleWord(w.shown)).join(' ');
  /* The run came from nowhere in `names` (a stale choice): show its keys. */
  return keys.map(titleWord).join(' ');
}

/* Where the first trade word starts in a run of keys, or -1. */
export function tradeIndex(keys) {
  for (let i = 0; i < keys.length; i += 1) {
    for (const phrase of TRADE_WORDS) {
      if (phrase.every((p, j) => keys[i + j] === p)) return i;
    }
  }
  return -1;
}

/* The brand: the common run cut at its first trade word. A common run that
   OPENS with a trade word ("Luxury Cars LLC") has no brand before it, and is
   its own brand rather than nothing — an empty brand is not a name. */
export function brandKeys(commonKeys) {
  const i = tradeIndex(commonKeys);
  if (i > 0) return commonKeys.slice(0, i);
  return commonKeys.slice();
}

export function commonLeading(names) {
  const keys = commonLeadingKeys(names);
  return { keys, words: keys.join(' '), display: displayRun(keys, names) };
}
export function brandOf(names) {
  const keys = brandKeys(commonLeadingKeys(names));
  return { keys, words: keys.join(' '), display: displayRun(keys, names) };
}

/* Everything the admin may choose from: every leading run of every name,
   shortest first, each once. "Egari Luxury Cars Transport LLC" offers
   "Egari", "Egari Luxury", "Egari Luxury Cars", "Egari Luxury Cars Transport"
   — the design's own example — and never the legal form (it is dropped
   before the runs are taken) and never a word the platforms did not send. */
export function candidates(names) {
  const seen = new Map();
  for (const n of names || []) {
    const w = wordsOf(n);
    for (let len = 1; len <= w.length; len += 1) {
      const keys = w.slice(0, len).map((x) => x.key);
      const words = keys.join(' ');
      if (!seen.has(words)) seen.set(words, { words, display: displayRun(keys, names), length: len });
    }
  }
  return [...seen.values()].sort((a, b) => a.length - b.length || a.words.localeCompare(b.words))
    .map(({ words, display }) => ({ words, display }));
}

/* A chosen run, as the admin sent it (display text or keys), folded to the
   keys it is compared by — and whether it is still one of the candidates. */
export const foldRun = (words) => wordsOf(words).map((w) => w.key).join(' ');
export const isCandidate = (words, names) => {
  const k = foldRun(words);
  return Boolean(k) && candidates(names).some((c) => c.words === k);
};

/* ── how each platform names an account it gave us, when it gave no name ── */
export const PLATFORM_LABEL = Object.freeze({
  uber: 'Uber', yango: 'Yango', bolt: 'Bolt', fms: 'FMS', cabman: 'CABMAN', hotel: 'Hotel channel',
});
/* What the platform calls the thing an account id identifies. */
export const ACCOUNT_NOUN = Object.freeze({
  uber: 'organisation', yango: 'park', bolt: 'company', fms: 'login', cabman: 'company', hotel: 'domain',
});
export const platformLabel = (p) => PLATFORM_LABEL[p] || String(p || 'platform');

/* "Bolt company 142868". CABMAN's account id is "<interface>/<CompanyName>",
   and a CABMAN company with no CompanyName is named by its interface. */
export function accountLabel(a) {
  const p = platformLabel(a.platform);
  const noun = ACCOUNT_NOUN[a.platform] || 'account';
  if (a.platform === 'cabman') {
    const [iface, ...rest] = String(a.account_id || '').split('/');
    const company = rest.join('/');
    return company ? `${p} company “${company}” (interface ${iface})` : `${p} interface ${iface}, no company name`;
  }
  return `${p} ${noun} ${a.account_id}`;
}

/* Why an account gave no name, when the store did not record a better one.
   These are FACTS about each platform's API, measured (docs/COVERAGE.md); a
   reason recorded by the last discovery run always wins over these. */
export const NO_NAME_REASON = Object.freeze({
  bolt: 'Bolt’s fleet-integration API returns no company name; connect the fleet-owner portal to name it.',
  hotel: 'The hotel channel identifies itself only by its x-domain header; it sends no company name.',
  yango: 'Yango names the park only through its web console, which has refused this host since 2026-09-06.',
  uber: 'Uber names an organisation only through /v1/vehicle-suppliers/orgs, which has not answered for this one yet.',
  fms: 'FMS names its client only in GetVehicleList, which has not answered for this login yet.',
  cabman: 'CABMAN sent no CompanyName on this company’s vehicles.',
});

/* ── the rule, whole ──────────────────────────────────────────────────────
   deriveFleetName({ id, accounts, choice }) → what the fleet is called and
   why. `accounts`: every platform account, any status — only LINKED ones
   name the fleet (§3.1: "a name has to come from linked accounts only", or
   CABMAN's "Sahalat" would join Ecosine's name through the shared
   interface). `choice`: the admin's chosen run (fleet.brand_choice), or null.

   basis:
     chosen    the admin's choice, still one of the candidates
     brand     the common run cut at its first trade word
     disagree  names were reported and share no first word: every name shown
     unnamed   no linked account reported a name */
export function deriveFleetName({ id, accounts = [], choice = null } = {}) {
  const linked = accounts
    .filter((a) => a.status === 'linked')
    .sort((a, b) => String(a.platform).localeCompare(String(b.platform))
      || String(a.account_id).localeCompare(String(b.account_id)));
  const named = linked.filter((a) => String(a.reported_name ?? '').trim() && wordsOf(a.reported_name).length);
  const names = named.map((a) => String(a.reported_name).trim());
  const reported = named.map((a) => ({ platform: a.platform, account_id: a.account_id, name: String(a.reported_name).trim(),
    reported_at: a.reported_at ?? null, source_call: a.source_call ?? null }));
  const common = commonLeading(names);
  const brand = brandOf(names);
  const cands = candidates(names);
  const out = {
    id, name: null, basis: null, common: common.display || null, brand: brand.display || null,
    choice: choice || null, choiceStale: false, candidates: cands, reported,
    accounts: linked.length, unnamedReason: null, disagreeReason: null,
  };

  if (!named.length) {
    out.basis = 'unnamed';
    if (!linked.length) {
      /* No account at all: the only real thing the fleet has is its own id,
         the key every stored row carries. */
      out.name = `Unnamed fleet — ${id}`;
      out.unnamedReason = 'No platform account is linked to this fleet yet, so no platform has named it. '
        + 'Link one of its accounts under Set up → Fleet names.';
    } else {
      const first = linked[0];
      out.name = `Unnamed fleet — ${accountLabel(first)}`;
      const why = linked.map((a) => a.name_reason || NO_NAME_REASON[a.platform]).filter(Boolean);
      out.unnamedReason = [...new Set(why)].join(' ')
        || 'None of this fleet’s linked accounts reported a name.';
    }
    return out;
  }

  if (choice) {
    const k = foldRun(choice);
    if (cands.some((c) => c.words === k)) {
      out.basis = 'chosen';
      out.name = displayRun(k.split(' '), names);
      return out;
    }
    /* Rule 9: a choice stands only while its words still appear. Said, not
       silently dropped — the page tells the admin their choice lapsed. */
    out.choiceStale = true;
  }

  if (!common.keys.length) {
    out.basis = 'disagree';
    /* Every name, never one of them: picking would be choosing for the
       admin, and the names are the evidence they choose from. */
    const shown = [...new Set(names.map((n) => (shouts(n) ? wordsOf(n).map((w) => titleWord(w.shown)).join(' ')
      : wordsOf(n).map((w) => w.shown).join(' '))))];
    out.name = shown.join(' / ');
    out.disagreeReason = 'The platforms name this fleet differently — choose one.';
    return out;
  }
  out.basis = 'brand';
  out.name = brand.display;
  return out;
}
