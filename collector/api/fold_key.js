/* ONE KEY PER PERSON — reconciling the two layers that both decide who
   somebody is, and which were each deciding it in their own words.
   ═════════════════════════════════════════════════════════════════════════
   THE DEFECT, measured on production 2026-09-21 against the live link table
   and the shipped register: 38 people are rendered as two rows each in the
   drivers directory. The operator found one of them and it is the clearest
   case there is — the same man, the same fleet, the same three cars, filed as

     WISAL MUHAMMAD IRSHAD MUHAMMAD   uber + hotel   249 trips in window
     Wisal Muhammad Irshah Muhammad   bolt             0 trips in window

   one letter apart, both on plate L44251.

   ── WHY, AND IT IS NOT AN IDENTITY QUESTION ──────────────────────────────
   Both layers already agree these are one person. api/identity_map.js holds
   the pair in MERGES with `contradictions: []`, and the live sweep proposed it
   twice and both proposals are confirmed. Nothing disputes the merge.

   What they disagree about is the KEY — the string the directory groups rows
   by. The register keys this person on the UBER record's short filed name,
   'wisal muhammad'. The link chain runs uber → bolt → hotel and terminates on
   the HOTEL record, whose key is the long 'wisal muhammad irshad muhammad'.

   api/driver_routes.js resolved that per-id, first-wins:

       ALIAS_KEY.get(id) || linkedKey(links, id) || linkedByName(…) || own

   The register names exactly one of this person's four ids — the Bolt one. So
   the Bolt id hits the register and stops at 'wisal muhammad'; the other three
   miss it, fall through to the link chain, and land on
   'wisal muhammad irshad muhammad'. Two keys, two rows, one man.

   Every one of the 38 is this same shape: a short filed name against a long
   one. 'asad khan' vs 'asad khan hakim khan'. 'fahad ali' vs 'fahad ali amjad
   ali'. The register covers part of the person and the link layer covers the
   rest, and whichever id the register happens to name is the one that splits
   off from the others.

   ── THE RULE, AND WHY IT DOES NOT OVERRULE THE PERSON WHO LOOKED ─────────
   api/driver_routes.js:801-808 argues, correctly, that the link layer must sit
   SECOND: "ALIAS_KEY is a list a person checked pair by pair against
   production; driver_identity_link is a rule that ran, and a rule must never
   overrule the person who looked."

   That argument is about WHO, and it still holds here in full. This file
   changes only the scope over which it is applied: from one id at a time, to
   the whole component. Where a component touches the register, the REGISTER'S
   key is what the entire component folds on — so the person who looked decides
   the label for all of it, rather than for the single id they happened to
   name. Where it does not, the link chain's key stands.

   ── WHAT THIS CANNOT DO, WHICH IS THE POINT ──────────────────────────────
   IT MERGES NOBODY NEW. The component is built only from edges the two layers
   already assert — a register entry, or a confirmed link. No name is compared,
   no distance is computed, nothing is inferred. The set of components is
   identical before and after; the only thing that changes is which single key
   each one folds on. So this can lower the directory's row count and can never
   raise it, and it can never put two people in one row that were not already
   asserted to be one person by a human-reviewed decision.

   test/fold_key.test.mjs asserts exactly that, because it is the property that
   makes this safe rather than merely correct. */
import { ALIAS_KEY, mergedIds } from './identity_map.js';

/* The component an id belongs to, over BOTH layers. Returns a Set that always
   contains the id itself, so a caller never has to special-case somebody
   nobody has ever linked. */
export function componentOf(links, id, registerIds = mergedIds) {
  const out = new Set([id]);
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    /* The link layer already computes the transitive component per id —
       `partners` in api/identity_links.js — so one hop through it is the whole
       chain, not one edge of it. */
    for (const p of links?.partners?.get(cur) || []) {
      if (!out.has(p)) { out.add(p); stack.push(p); }
    }
    /* The register is a flat list of ids that are one person, so mergedIds is
       likewise the whole entry rather than one pair. */
    for (const s of registerIds(cur) || []) {
      if (s && !out.has(s)) { out.add(s); stack.push(s); }
    }
  }
  return out;
}

/* EVERY KEY A COMPONENT IS KNOWN BY, MAPPED TO THE ONE IT FOLDS ON.
   ─────────────────────────────────────────────────────────────────────────
   Resolving at the KEY level rather than at the id level, which is what makes
   this a three-line change at the call site instead of a rewrite of it. The
   original precedence is untouched:

       ALIAS_KEY.get(id) || linkedKey(links, id) || linkedByName(links, own) || own

   — the person who looked still outranks the rule that ran, per id, exactly as
   api/driver_routes.js argues. All this does is take whichever key that
   produced and map it onto the one key its component folds on.

   It has to be the key level because of the THIRD record. A record no link
   names — Bolt files no phone, so nothing on the roster joins it — reaches its
   person through `byName`, the fold of its own name. That map points at the
   link chain's terminal key, not the register's. So resolving only the ids the
   two layers name would still have split off the record that arrived by name,
   which on this roster is the Yango account of the very person the operator
   reported. Measured: without this, his four records are 'wisal muhammad'
   ×3 and 'wisal muhammad irshad muhammad' ×1 — two rows again, one of them
   with nothing in it.

   Build it once per request and reuse it across the rows; it is O(component). */
/* The register is reached through two small accessors rather than imported
   straight into the loop, so this file can be exercised against a fixture
   register in test/fold_key.test.mjs. Production omits them and gets the real
   one — the injection exists to make the rule testable, never to let a caller
   supply a different idea of who is one person. */
export function keyResolver(links, linked, {
  registerKey = (id) => ALIAS_KEY.get(id),
  registerIds = mergedIds,
  registerAll = () => ALIAS_KEY.keys(),
} = {}) {
  /* Every id either layer knows anything about. */
  const ids = new Set([
    ...(links?.partners?.keys() || []),
    ...registerAll(),
  ]);
  for (const id of registerAll()) for (const s of registerIds(id) || []) if (s) ids.add(s);

  const map = new Map();
  const done = new Set();
  for (const id of ids) {
    if (done.has(id)) continue;
    const comp = componentOf(links, id, registerIds);
    for (const m of comp) done.add(m);

    /* Every key any member of this component can produce. */
    const fromRegister = [];
    const fromLinks = [];
    for (const m of comp) {
      const a = registerKey(m); if (a) fromRegister.push(a);
      const l = linked(links, m); if (l) fromLinks.push(l);
    }
    const all = [...new Set([...fromRegister, ...fromLinks])];
    if (all.length < 2) continue;   // nothing to reconcile

    /* THE REGISTER WINS, over the whole component — see the head of this file
       for why that is the same rule api/driver_routes.js already states and
       not a new one. Sorted before picking so a component carrying two
       different register keys resolves identically on every request: an
       unstable fold key would move a person between rows between two reads of
       the same page, which is worse than either answer. */
    const chosen = fromRegister.length ? [...fromRegister].sort()[0] : [...fromLinks].sort()[0];
    for (const k of all) if (k !== chosen) map.set(k, chosen);
  }

  /* Identity for everything else, so a caller can apply it unconditionally. */
  return (k) => (k == null ? k : (map.get(k) ?? k));
}
