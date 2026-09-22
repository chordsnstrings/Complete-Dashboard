/* Several credential files, handed over at once — and what the NAMES say.
   ═══════════════════════════════════════════════════════════════════════════
   The operator's workflow is to capture credentials one provider at a time
   into one .txt file each, and then hand the whole set over together. Five at
   once on 2026-09-22: two raw Bolt JWTs, two Bolt curls, one Yango cookie jar.
   src/credkit.js already reads a paste holding several credentials, so the
   obvious implementation is to join the files with blank lines and call
   recognise() on the result.

   THAT IMPLEMENTATION LOSES THE ONE PIECE OF EVIDENCE THAT MATTERED.

   Measured 2026-09-22, recorded in docs/COVERAGE.md ("Ecosine: proved end to
   end"): the first pair of files supplied were `ECOSINE_BOLT.txt` and
   `EGARI_BOLT.txt`, and they held THE SAME TOKEN — identical sha256, identical
   `jti`, `fleet_owner_id: 174036`, which is Egari's owner. Concatenated, that
   is one credential; recognise() would name it egari, store it correctly, and
   report a clean result — while Ecosine's slot went on holding a token that
   cannot work and the operator went on believing they had just supplied one.
   The mistake was visible in exactly one place: the file called ECOSINE
   contained EGARI's token. It cost hours.

   So the file is carried end to end, and this module answers the three
   questions a set of files raises that a single paste does not:

     1. did the same credential arrive twice, under two names?
     2. does a file's NAME claim a fleet the credential inside it cannot
        serve — and if so, which owner would a real one have to carry?
     3. did a file yield nothing at all, and does its name suggest what it
        was supposed to yield?

   None of these is a new queue. Everything here decorates the candidates
   src/credkit.js produced, in the vocabulary src/credkit.js already uses, and
   hands them to the same live check in src/credcheck.js and the same apply
   gate in api/server.js. A finding here can refuse a candidate; it can never
   store one. */
import { config } from './config.js';

/* Bounds. These are not security — requireAdmin is — they are the difference
   between a refusal that names the file and a request body that dies in the
   body parser with a 413 the paste page renders as "the server took too
   long". Generous enough for a dozen curl dumps. */
export const MAX_FILES = 12;
/* Per file, and then over the whole upload. Both are needed and the second is
   the one that matters: api/server.js parses a 256kb body, so twelve files at
   the per-file ceiling would be refused by body-parser as `entity.too.large`
   — which arrives at the page as a 413 that api/public/data.js renders as
   "the server took too long", with an invitation to retry that can only fail
   the same way. A bound this side of that is a refusal that can name the
   file. A curl dump with a full cookie jar is a few kilobytes; 64k is
   generous for one and 180k leaves the JSON envelope its room. */
export const MAX_CHARS = 64_000;
export const MAX_TOTAL_CHARS = 180_000;
/* The same floor the single-textarea path has always used, so an operator who
   drops a file holding half a token gets the same answer as one who pastes
   it. */
export const MIN_CHARS = 20;

/** A display name for one uploaded file: no path, no control characters, and
    never long enough to push a real message off the page. `null` for the
    textarea, which has no name and must not be given a fake one. */
export function safeName(name) {
  if (name == null) return null;
  const base = String(name).split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim();
  return base ? base.slice(0, 120) : null;
}

/** The files this route will actually read, and the ones it will not — each
    with the true reason, because a file that silently did not participate is
    the failure mode this whole feature exists to remove. */
export function normaliseFiles(raw) {
  const sources = [];
  const refused = [];
  let total = 0;
  const list = Array.isArray(raw) ? raw : [];
  /* Two files can be called the same thing — a browser will happily hand over
     two `token.txt` from different folders. The name is evidence, so it is
     kept, and the second one is marked rather than silently merged with the
     first in every message below. */
  const used = new Map();
  const label = (n) => {
    if (n == null) return null;
    const seen = (used.get(n) || 0) + 1;
    used.set(n, seen);
    return seen > 1 ? `${n} (${seen})` : n;
  };
  for (const entry of list) {
    const name = label(safeName(entry?.name));
    const shown = name || 'the paste box';
    if (sources.length + refused.length >= MAX_FILES) {
      refused.push({ name: shown, reason: `more than ${MAX_FILES} files were sent and this one was not read` });
      continue;
    }
    const text = typeof entry?.text === 'string' ? entry.text : null;
    if (text === null) {
      refused.push({ name: shown, reason: 'this file did not arrive as text' });
      continue;
    }
    if (text.trim().length < MIN_CHARS) {
      refused.push({ name: shown, reason: `under ${MIN_CHARS} characters — there is nothing in it to read` });
      continue;
    }
    if (text.length > MAX_CHARS) {
      refused.push({ name: shown, reason: `${text.length} characters, and this route reads at most ${MAX_CHARS} in one file` });
      continue;
    }
    if (total + text.length > MAX_TOTAL_CHARS) {
      refused.push({ name: shown,
        reason: `the files before it already came to ${total} characters and this route reads `
          + `at most ${MAX_TOTAL_CHARS} in one upload — send this one in a second batch` });
      continue;
    }
    total += text.length;
    sources.push({ name, text, chars: text.length });
  }
  return { sources, refused };
}

/* ── what a file NAME claims ──────────────────────────────────────────── */

/* The fleet ids, read off config rather than written down again, so a third
   business added to the fleet is understood here the day it is configured. */
const FLEETS = () => [...new Set((config.bolt.companies || []).map((c) => c.fleet))]
  .filter(Boolean);

/** Which fleet a file name declares, or null. Two fleets in one name declares
    nothing — `ECOSINE_EGARI_bolt.txt` is a set, not a claim — and neither does
    a name that mentions none. */
export function fleetFromName(name) {
  if (!name) return null;
  const n = String(name).toLowerCase();
  const hits = FLEETS().filter((f) => n.includes(f));
  return hits.length === 1 ? hits[0] : null;
}

/* Which provider a file name mentions. Only ever used to say what a file was
   EXPECTED to hold when it turned out to hold nothing — never to route a
   credential, which is decided by decoding the credential itself. */
const PROVIDER_WORDS = [
  ['Bolt', /\bbolt\b/i], ['Uber', /\buber\b/i], ['Yango', /\b(?:yango|yandex)\b/i],
  ['FMS', /\b(?:fms|infotrack)\b/i], ['CABMAN', /\bcabman\b/i], ['Hotel', /\bhotel\b/i],
];
export function providerFromName(name) {
  if (!name) return null;
  /* Separators first. `\b` treats an underscore as a word character, so
     /\byango\b/ does not match ECOSINE_YANGO.txt — which is the exact shape
     the operator's own files arrive in, and the shape this function exists to
     read. Every non-alphanumeric becomes a space before the test. */
  const words = String(name).replace(/[^A-Za-z0-9]+/g, ' ');
  const hit = PROVIDER_WORDS.find(([, re]) => re.test(words));
  return hit ? hit[0] : null;
}

/** The Bolt fleet owner id a given fleet's refresh token must carry, from the
    same table the collector mints against. */
export const boltOwnerOf = (fleet) =>
  (config.bolt.companies || []).find((c) => c.fleet === fleet)?.userId ?? null;

/* ── the standing Bolt warning ────────────────────────────────────────────
   docs/COVERAGE.md, "What kills them: the likeliest cause, and the open
   question". A portal capture IS a sign-in, and a sign-in is the only
   available explanation for tokens dying unchanged, days from their exp, with
   nothing here touching them. Whether that invalidation is per fleet OWNER or
   per Bolt ACCOUNT is NOT established — and if it is per account, capturing
   one fleet's token kills the other's and the two fleets can never both be
   live. So the page must not say "capture a fresh one" after a Bolt paste,
   and must say what to do instead, in the order that settles the open
   question at no cost. */
export const BOLT_AFTER_PASTE = 'A Bolt capture is a sign-in, and a sign-in is the likeliest '
  + 'thing that invalidates the refresh token the OTHER fleet is holding — measured 2026-09-22: '
  + 'three tokens died unchanged, days from their own expiry, with nothing here touching them. '
  + 'Whether that is per fleet owner or per Bolt account is still open, and if it is per account '
  + 'the two fleets can never both be live. So do not capture again now. Check the other fleet’s '
  + 'Bolt credential straight away instead — if it has just died, the invalidation is account-wide '
  + 'and that answers it.';

/* ── the findings a SET of files raises ───────────────────────────────── */

/* One credential, however many files carried it.
   ─────────────────────────────────────────────────────────────────────────
   Folded on the exact value rather than reported twice, for a reason beyond
   tidiness: src/credcheck.js's Bolt check is the one check in this product
   that performs a live exchange against the portal, and two identical
   candidates would mean two exchanges of one token seconds apart. Folding
   also means the apply gate writes once, which is what makes `applied` a
   truthful list rather than the same key repeated. */
const valueId = (c) => `${c.value || ''}\u0000${c.secret || ''}`;

/**
 * Decorate candidates recognised across several files with what the SET says.
 * Returns the same candidates — never new ones — plus findings for the page.
 *
 * @param {Array} cands candidates from recognise(), each carrying `file`.
 * @returns {{candidates: Array, findings: Array}}
 */
export function crossFile(cands) {
  const findings = [];

  /* 1 ─ the same credential under two names. Today's actual failure. */
  const byValue = new Map();
  for (const c of cands) {
    const id = valueId(c);
    if (!byValue.has(id)) byValue.set(id, []);
    byValue.get(id).push(c);
  }
  const folded = [];
  for (const group of byValue.values()) {
    const [first] = group;
    const files = [...new Set(group.map((c) => c.file).filter(Boolean))];
    first.files = files;
    folded.push(first);
    if (files.length > 1) {
      findings.push({
        kind: 'duplicate_value', tone: 'err', files,
        /* Named as what it IS, not as a tidy-up. The two files were captured
           in two sittings and were believed to hold two credentials; that
           they hold one means one of the two captures did not happen, and
           the fleet it was for still has nothing. */
        text: `${files.join(' and ')} hold the SAME credential — byte for byte, not merely `
          + 'similar. That is one capture, not two: whichever of them was supposed to hold a '
          + 'different credential does not, and the provider or fleet it was for is still '
          + 'holding whatever it held before.',
      });
    }
  }

  /* 2 ─ the name claims a fleet the credential cannot serve.
     ─────────────────────────────────────────────────────────────────────
     The credential is still filed under the fleet it ITSELF declares — that
     is the whole principle of src/credkit.js and it is not weakened here: a
     token names its owner and a file name is a human's memory of what they
     captured. What changes is that the disagreement is said out loud, with
     the owner a real credential for the claimed fleet would have to carry,
     so the operator knows the fleet they were trying to fix is still
     unfixed. Refusing the credential instead would throw away a working
     token to punish a wrong filename. */
  for (const c of folded) {
    for (const file of c.files?.length ? c.files : [c.file].filter(Boolean)) {
      const said = fleetFromName(file);
      if (!said || !c.fleet || said === c.fleet) continue;
      /* Both owners named, and which is which. "This is the wrong fleet" is
         not actionable on its own; "a ecosine token carries owner 173999 and
         this one carries 174036" is, because the owner is what the operator
         can see in the portal session they are about to capture from. */
      const needed = c.provider === 'Bolt' ? boltOwnerOf(said) : null;
      const carries = c.provider === 'Bolt' ? boltOwnerOf(c.fleet) : null;
      const owners = needed != null
        ? ` Its fleet_owner_id is ${carries ?? 'not one this product knows'}; a ${said} Bolt token `
          + `must carry ${needed}, and src/sources/bolt.js refuses the mismatch before the portal `
          + 'is even asked — so a token captured from the other session can never work here.'
        : '';
      findings.push({
        kind: 'fleet_claim', tone: 'err', files: [file], fleet: said, key: c.key || null,
        text: `${file} is named for ${said}, and the credential inside it belongs to ${c.fleet}.`
          + `${owners} It is stored as ${c.fleet}’s, because a credential names itself and a `
          + `file name does not — but ${said} has been given nothing by this upload and is still `
          + 'holding whatever it held before.',
      });
    }
  }

  /* 3 ─ two different values, one key. The existing in-paste rule, extended
     across files, in the same words — "neither is applied", because this
     cannot tell which of the two is the stale one. */
  const byKey = new Map();
  for (const c of folded) {
    const id = c.key || (c.kind ? `${c.provider}:${c.kind}:${c.fleet || '?'}` : null);
    if (!id) continue;
    if (!byKey.has(id)) byKey.set(id, []);
    byKey.get(id).push(c);
  }
  for (const [id, group] of byKey) {
    if (group.length < 2) continue;
    const where = group.flatMap((c) => c.files || []).filter(Boolean);
    for (const c of group) {
      c.ok = false;
      c.why = `${c.why || ''} — and another file in this upload claims the same key with a `
        + 'different value, so neither is applied';
    }
    findings.push({
      kind: 'same_key', tone: 'err', files: [...new Set(where)], key: group[0].key || id,
      text: `${where.length ? `${[...new Set(where)].join(' and ')} both claim` : 'Two credentials claim'} `
        + `${group[0].key || id}, with different values. One of them is stale and nothing here can `
        + 'tell which, so neither is applied — send the one you mean on its own.',
    });
  }

  return { candidates: folded, findings };
}

/** The warning a Bolt paste must carry, naming the fleet to go and look at.
    Returns null when nothing Bolt was in the upload — a caveat printed beside
    an Uber cookie is a caveat an operator learns to scroll past. */
export function boltFollowUp(fleetsPasted) {
  const seen = (fleetsPasted || []).filter(Boolean);
  const others = FLEETS().filter((f) => !seen.includes(f));
  return {
    kind: 'bolt_capture', tone: 'warn', files: [], fleet: others[0] || null,
    text: `${BOLT_AFTER_PASTE}${others.length
      ? ` The one to look at right now is ${others.join(' and ')}.`
      : ' Both fleets were in this upload, so the one to check is whichever you captured first.'}`,
  };
}

/** What happened to each file, in the queue's own vocabulary.
    ─────────────────────────────────────────────────────────────────────────
    "3 stored, 2 refused" over a five-file upload is a summary the operator
    cannot check against what they actually dropped in. This is the per-file
    answer: what was read out of it, what was stored from it, what was refused
    and why, and which OTHER file turned out to hold the same bytes. */
export function fileReport(sources, tested, applied) {
  const from = (t) => ((t.files && t.files.length) ? t.files : [t.file]);
  return sources.map((s) => {
    const mine = tested.filter((t) => from(t).includes(s.name));
    const keysOf = (t) => (t.keys ? Object.keys(t.keys) : (t.key ? [t.key] : []));
    return {
      name: s.name,
      chars: s.chars,
      declares_fleet: fleetFromName(s.name),
      declares_provider: providerFromName(s.name),
      read: mine.length,
      /* Every key this file's contents landed in, and only the ones that
         actually landed — `applied` is the route's own record of what was
         written, not a restatement of the verdict. */
      stored: [...new Set(mine.flatMap(keysOf).filter((k) => applied.includes(k)))],
      refused: mine.filter((t) => t.verdict === 'fail')
        .map((t) => ({ key: t.key || null, reason: t.detail || t.why || null })),
      untested: mine.filter((t) => t.verdict === 'unknown')
        .map((t) => ({ key: t.key || null, reason: t.detail || t.why || null })),
      /* The finding that cost hours, stated per file as well as once at the
         top, so it is visible from whichever end the operator reads. */
      also_in: [...new Set(mine.flatMap((t) => t.files || [])
        .filter((n) => n && n !== s.name))],
    };
  });
}

/** A file that yielded nothing, with its name read for what it was meant to
    hold. Kept separate from crossFile because it needs the SOURCES, not the
    candidates: a file nobody recognised leaves no candidate behind. */
export function silentFiles(sources, cands, leftovers) {
  /* A file with a model PROPOSAL is not silent — its proposal is a candidate
     carrying its name, and it is in the table with its own verdict. Silent
     means no recogniser named anything in it and no key was proposed for it
     either, which is the state an operator has to be told about explicitly:
     a file that contributed nothing looks exactly like a file that was never
     opened. */
  const spoken = new Set(cands.flatMap((c) => (c.files?.length ? c.files : [c.file]))
    .filter(Boolean));
  const hadBlocks = new Set(leftovers.map((l) => l.file).filter(Boolean));
  return sources.filter((s) => s.name && !spoken.has(s.name)).map((s) => {
    const provider = providerFromName(s.name);
    const fleet = fleetFromName(s.name);
    return {
      kind: 'nothing_read', tone: 'warn', files: [s.name],
      /* The name is read here for the only thing a name is good for: saying
         what this file was SUPPOSED to hold, so "nothing was read" can be
         weighed against what was expected. It never routes a credential. */
      text: `Nothing in ${s.name} was recognised as a credential this dashboard stores, and `
        + `no key was proposed for ${hadBlocks.has(s.name) ? 'what it holds' : 'it'}. Nothing `
        + `from this file was stored${provider
          ? `, and its name says ${provider}${fleet ? ` / ${fleet}` : ''} — so ${provider}`
            + `${fleet ? ` for ${fleet}` : ''} is still holding whatever it held before`
          : ''}.`,
    };
  });
}
