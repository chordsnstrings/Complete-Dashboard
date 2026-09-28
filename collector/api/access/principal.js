/* What one caller may see and do — computed from their grants, per fleet.
   ─────────────────────────────────────────────────────────────────────────
   A pure function: no database, no request. api/access/service.js loads the
   grants; this decides. Pure because it is the rule the whole product rests
   on, and a rule that can only be exercised through a database is one that is
   tested less than it is trusted.

   PER FLEET, NOT PER PERSON. A person may hold Operations over Egari and
   Finance over every fleet. "What may they see" then depends on which fleet a
   request is about, so levels are kept per fleet and a request is judged by
   the fleets it touches: a view over every fleet shows a class only at the
   level held on ALL of them (the minimum), because showing the maximum would
   show Ecosine's rows to someone trusted with Egari's. */
import { ROLE, CLASS_CODES, CAP_CODES, rank, maxLevel, minLevel } from '../public/access_model.js';

/* grants: [{ role_code, fleets: string[]|null }], already filtered to the
   active, started, unexpired ones. roles: custom roles by code (built-ins come
   from the model). allFleets: every fleet id the company has. */
export function computeAccess({ grants = [], roles = {}, allFleets = [], viewAs = null } = {}) {
  const roleOf = (code) => roles[code] || ROLE[code] || null;
  const effective = viewAs
    /* An Owner previewing a role sees exactly what that role sees over every
       fleet, and can DO nothing: the preview is for looking. */
    ? [{ role_code: viewAs, fleets: null, preview: true }]
    : grants;
  const byFleet = Object.fromEntries(allFleets.map((f) => [f, {}]));
  const capFleets = {};
  for (const g of effective) {
    const role = roleOf(g.role_code);
    if (!role) continue;
    const over = (g.fleets && g.fleets.length ? g.fleets : allFleets).filter((f) => f in byFleet);
    for (const f of over) {
      for (const c of CLASS_CODES) {
        const l = role.levels?.[c];
        if (l) byFleet[f][c] = maxLevel(byFleet[f][c], l);
      }
      if (!g.preview) {
        for (const cap of role.caps || []) {
          if (!CAP_CODES.includes(cap)) continue;
          (capFleets[cap] ||= new Set()).add(f);
        }
      }
    }
  }
  const scope = allFleets.filter((f) => CLASS_CODES.some((c) => byFleet[f][c]));
  const levelsOver = (fleets, combine = minLevel) => {
    const out = {};
    for (const c of CLASS_CODES) {
      let l = null;
      for (const f of fleets) l = l === null ? (byFleet[f]?.[c] || '') : combine(l, byFleet[f]?.[c] || '');
      if (l) out[c] = l;
    }
    return out;
  };
  const capsOver = (fleets) => Object.keys(capFleets)
    .filter((cap) => fleets.length && fleets.every((f) => capFleets[cap].has(f)));
  return {
    allFleets,
    scope,
    allScope: scope.length === allFleets.length && allFleets.length > 0,
    byFleet,
    /* Over every fleet (what a company-wide page may show). */
    levels: levelsOver(allFleets, minLevel),
    /* On at least one fleet (whether a page can open at all, for a fleet the
       person may then choose). */
    levelsAny: levelsOver(scope, maxLevel),
    caps: capsOver(allFleets),
    capsAny: Object.keys(capFleets),
    capFleets: Object.fromEntries(Object.entries(capFleets).map(([k, v]) => [k, [...v]])),
    preview: viewAs || null,
    levelsOver,
    capsOver,
  };
}

/* The owner of everything: the internal warmer and anonymous callers while
   sign-in is not yet required both see what the product has always shown. */
export function fullAccess(allFleets = []) {
  return computeAccess({ grants: [{ role_code: 'OWN', fleets: null }], allFleets });
}

/* Is `a` (a principal's levels over every fleet + caps) at least `b`? Used by
   the ceiling rule on grants and invitations. */
export function covers(a, b) {
  for (const c of CLASS_CODES) if (rank(b.levels?.[c]) > rank(a.levels?.[c])) return false;
  for (const cap of b.caps || []) if (!a.caps?.includes(cap)) return false;
  return true;
}

/* A stable short fingerprint of what a caller may see — for logs and for the
   service worker's cache partition. Two people with the same access share it. */
export function fingerprintOf(access) {
  const parts = [
    access.allFleets.join(','),
    ...access.allFleets.map((f) => `${f}:${CLASS_CODES.map((c) => access.byFleet[f]?.[c] || '-').join('')}`),
    access.preview || '',
  ];
  let h = 2166136261 >>> 0;
  for (const ch of parts.join('|')) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(36);
}
